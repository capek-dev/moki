import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { storedAppearance, validateAppearance } from '../shared/appearance';
import { attachmentDirectories, requireAttachmentId, validatePng } from '../shared/attachments';
import type { Assistant, Attachment, Conversation, Message, Result, Snapshot } from '../shared/protocol';
import { defaultModel, requireModel, requireThinking, supportsImageInput, type Thinking } from '../shared/models';

type AssistantRow = Omit<Assistant, 'appearance'> & { appearance: string | null };
type AttachmentRow = Attachment & { storageName: string };
function decodeAssistant(row: AssistantRow): Assistant { return { ...row, appearance: storedAppearance(row.appearance) }; }

export function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid text value.');
  return value.trim();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value as Record<string, unknown>;
}
export class Store {
  private db: Database;
  private attachmentDirs?: ReturnType<typeof attachmentDirectories>;
  constructor(path: string, dataDir?: string) {
    this.db = new Database(path, { create: true });
    if (dataDir) {
      this.attachmentDirs = attachmentDirectories(dataDir);
      mkdirSync(this.attachmentDirs.drafts, { recursive: true, mode: 0o700 });
      mkdirSync(this.attachmentDirs.content, { recursive: true, mode: 0o700 });
    }
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, assistantId TEXT NOT NULL REFERENCES assistants(id), title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, mime TEXT NOT NULL, byteSize INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, storageName TEXT NOT NULL);`);
    this.db.transaction(() => {
      const add = (table: string, name: string, definition: string) => {
        const columns = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
        if (!columns.some((c) => c.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      };
      add('assistants', 'appearance', 'TEXT');
      add('conversations', 'model', 'TEXT');
      add('conversations', 'thinking', 'TEXT');
      add('messages', 'thinking', 'TEXT');
      add('messages', 'role', "TEXT NOT NULL DEFAULT 'user'");
      add('messages', 'status', "TEXT NOT NULL DEFAULT 'complete'");
      add('messages', 'model', 'TEXT');
      add('messages', 'assistantName', 'TEXT');
      add('messages', 'error', 'TEXT');
      this.db.exec("UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'");
    })();
    // Preserve legacy IDs and user edits, including conversation references.
    this.db.transaction(() => {
      this.db.query("UPDATE assistants SET name = 'Moki' WHERE id = 'povondra' AND name = 'Povondra'").run();
      const legacy = this.db.query("SELECT id FROM assistants WHERE id = 'povondra'").get();
      if (!legacy) this.db.query('INSERT OR IGNORE INTO assistants (id, name, provider, instructions) VALUES (?, ?, ?, ?)').run('moki', 'Moki', 'deepseek', 'Be helpful, clear, and kind.');
    })();
    if (this.attachmentDirs) {
      const referenced = new Set(this.db.query<{ storageName: string }, []>('SELECT storageName FROM attachments').all().map((row) => row.storageName));
      for (const name of readdirSync(this.attachmentDirs.content)) if (name.endsWith('.png') && !referenced.has(name)) rmSync(join(this.attachmentDirs.content, name), { force: true });
    }
  }
  conversation(id: string): Conversation {
    const value = this.db.query<Conversation, [string]>('SELECT * FROM conversations WHERE id = ?').get(text(id, 100));
    if (!value) throw new Error('Conversation not found.');
    return value;
  }
  assistantFor(id: string): Assistant {
    return decodeAssistant(this.db.query<AssistantRow, [string]>('SELECT * FROM assistants WHERE id = ?').get(this.conversation(id).assistantId)!);
  }
  messages(id: string): Message[] {
    return this.db.query<Message, [string]>('SELECT * FROM (SELECT rowid AS sequence, * FROM messages WHERE conversationId = ? ORDER BY rowid DESC LIMIT 100) ORDER BY sequence').all(id);
  }
  attachmentsFor(messages: readonly Message[]): Attachment[] {
    if (!messages.length) return [];
    const placeholders = messages.map(() => '?').join(',');
    return this.db.query<Attachment, string[]>(`SELECT id, messageId, mime, byteSize, width, height FROM attachments WHERE messageId IN (${placeholders}) ORDER BY rowid`).all(...messages.map((message) => message.id));
  }
  snapshot(conversationId?: string): Snapshot {
    // History reads are bounded. Older messages and their attachments remain on disk.
    const messages = conversationId ? this.messages(conversationId) : this.db.query<Message, []>('SELECT * FROM (SELECT rowid AS sequence, * FROM messages ORDER BY rowid DESC LIMIT 100) ORDER BY sequence').all();
    return {
      assistants: this.db.query<AssistantRow, []>('SELECT * FROM assistants ORDER BY rowid').all().map(decodeAssistant),
      conversations: this.db.query<Conversation, []>('SELECT * FROM conversations ORDER BY rowid DESC LIMIT 100').all(),
      messages,
      attachments: this.attachmentsFor(messages),
    };
  }
  private validateDraft(id: unknown) {
    const attachmentId = requireAttachmentId(id);
    if (!this.attachmentDirs) throw new Error('Attachment storage is unavailable.');
    const draft = join(this.attachmentDirs.drafts, `${attachmentId}.png`);
    if (!existsSync(draft)) throw new Error('Screenshot draft was not found. Capture it again.');
    const bytes = readFileSync(draft);
    const stat = statSync(draft);
    if (!stat.isFile()) throw new Error('Invalid screenshot.');
    const { byteSize, width, height } = validatePng(bytes);
    return { id: attachmentId, draft, content: join(this.attachmentDirs.content, `${attachmentId}.png`), mime: 'image/png' as const, byteSize, width, height };
  }
  // Deletes a message and everything after it. Must run inside a transaction;
  // returns the attachment content files that lost their rows.
  private deleteFrom(conversationId: string, rowid: number): string[] {
    const ids = this.db.query<{ id: string }, [string, number]>('SELECT id FROM messages WHERE conversationId = ? AND rowid >= ?').all(conversationId, rowid).map((row) => row.id);
    const files: string[] = [];
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      for (const row of this.db.query<{ storageName: string }, string[]>(`SELECT storageName FROM attachments WHERE messageId IN (${placeholders})`).all(...ids)) files.push(row.storageName);
      this.db.query('DELETE FROM messages WHERE conversationId = ? AND rowid >= ?').run(conversationId, rowid);
    }
    return files;
  }
  private removeAttachmentFiles(names: string[]) {
    if (!this.attachmentDirs) return;
    for (const name of names) rmSync(join(this.attachmentDirs.content, name), { force: true });
  }
  revertMessages(conversationId: string, messageId: string) {
    this.conversation(conversationId);
    const target = this.db.query<{ rowid: number; role: string }, [string, string]>('SELECT rowid, role FROM messages WHERE id = ? AND conversationId = ?').get(text(messageId, 100), conversationId);
    if (!target) throw new Error('Message not found.');
    if (target.role !== 'user') throw new Error('Only your messages can be unsent.');
    if (this.db.query('SELECT 1 FROM messages WHERE conversationId = ? AND status = \'streaming\' LIMIT 1').get(conversationId)) throw new Error('Stop the reply before unsending messages.');
    let files: string[] = [];
    this.db.transaction(() => {
      files = this.deleteFrom(conversationId, target.rowid);
      if (!this.db.query<{ count: number }, [string]>('SELECT count(*) AS count FROM messages WHERE conversationId = ?').get(conversationId)!.count) this.db.query('UPDATE conversations SET title = ? WHERE id = ?').run('New conversation', conversationId);
    })();
    this.removeAttachmentFiles(files);
  }
  begin(id: string, body: string, model: string, thinking: Thinking | null = null, attachmentIds: unknown[] = [], editOf?: string) {
    const assistant = this.assistantFor(id);
    requireThinking(assistant.provider, model, thinking);
    text(body, 16000);
    if (attachmentIds.length > 1) throw new Error('Only one screenshot can be sent at a time.');
    if (attachmentIds.length && !supportsImageInput(assistant.provider, model)) throw new Error('The selected model cannot process screenshots. Select an image-capable model.');
    if (this.messages(id).some((m) => m.status === 'streaming')) throw new Error('This conversation is already replying.');
    let editRow: { rowid: number; role: string } | undefined;
    if (editOf !== undefined) {
      editRow = this.db.query<{ rowid: number; role: string }, [string, string]>('SELECT rowid, role FROM messages WHERE id = ? AND conversationId = ?').get(text(editOf, 100), id) ?? undefined;
      if (!editRow) throw new Error('Message not found.');
      if (editRow.role !== 'user') throw new Error('Only your messages can be edited.');
    }
    const drafts = attachmentIds.map((attachmentId) => this.validateDraft(attachmentId));
    const userMessageId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const moved: typeof drafts = [];
    let files: string[] = [];
    try {
      this.db.transaction(() => {
        // Delete the edited tail first so title logic and counts see the post-edit state.
        if (editRow) files = this.deleteFrom(id, editRow.rowid);
        for (const draft of drafts) { renameSync(draft.draft, draft.content); moved.push(draft); }
        this.addUser(id, body, userMessageId);
        for (const attachment of drafts) this.db.query('INSERT INTO attachments (id, messageId, mime, byteSize, width, height, storageName) VALUES (?, ?, ?, ?, ?, ?, ?)').run(attachment.id, userMessageId, attachment.mime, attachment.byteSize, attachment.width, attachment.height, `${attachment.id}.png`);
        this.db.query('UPDATE conversations SET model = ?, thinking = ? WHERE id = ?').run(model, thinking, id);
        this.db.query("INSERT INTO messages (id, conversationId, text, role, status, model, assistantName, thinking) VALUES (?, ?, '', 'assistant', 'streaming', ?, ?, ?)").run(messageId, id, model, assistant.name, thinking);
      })();
    } catch (error) {
      for (const draft of moved) {
        if (!existsSync(draft.content)) continue;
        try { renameSync(draft.content, draft.draft); }
        catch { rmSync(draft.content, { force: true }); }
      }
      throw error;
    }
    this.removeAttachmentFiles(files);
    return { messageId, assistant };
  }
  updateReply(id: string, body: string, status: Message['status'], error: string | null = null) {
    this.db.query('UPDATE messages SET text = ?, status = ?, error = ? WHERE id = ?').run(body, status, error, id);
  }
  attachmentBytes(id: string): Uint8Array {
    if (!this.attachmentDirs) throw new Error('Attachment storage is unavailable.');
    const row = this.db.query<AttachmentRow, [string]>('SELECT * FROM attachments WHERE id = ?').get(requireAttachmentId(id));
    if (!row) throw new Error('Attachment not found.');
    return readFileSync(join(this.attachmentDirs.content, row.storageName));
  }
  private addUser(id: string, body: string, messageId = crypto.randomUUID()) {
    const count = this.db.query<{ count: number }, [string]>('SELECT count(*) AS count FROM messages WHERE conversationId = ?').get(id)!.count;
    this.db.query('INSERT INTO messages (id, conversationId, text) VALUES (?, ?, ?)').run(messageId, id, text(body, 16000));
    if (count === 0) this.db.query('UPDATE conversations SET title = ? WHERE id = ?').run(body.trim().slice(0, 60), id);
    return messageId;
  }
  handle(input: unknown): Result {
    const request = record(input);
    let conversationId: string | undefined;
    switch (request.method) {
      case 'snapshot':
        if (request.conversationId !== undefined) conversationId = this.conversation(text(request.conversationId, 100)).id;
        break;
      case 'selectModel': {
        conversationId = text(request.conversationId, 100);
        const assistant = this.assistantFor(conversationId);
        const model = requireModel(assistant.provider, request.model);
        const thinking = requireThinking(assistant.provider, model.id, request.thinking);
        this.db.query('UPDATE conversations SET model = ?, thinking = ? WHERE id = ?').run(model.id, thinking, conversationId);
        break;
      }
      case 'saveAssistant': {
        const a = record(request.assistant);
        if (a.provider !== 'deepseek' && a.provider !== 'codex') throw new Error('Unsupported provider.');
        if (typeof a.instructions !== 'string' || a.instructions.length > 16000) throw new Error('Invalid instructions.');
        const appearance = a.appearance === undefined ? null : JSON.stringify(validateAppearance(a.appearance));
        this.db.query('INSERT INTO assistants (id, name, provider, instructions, appearance) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider, instructions=excluded.instructions, appearance=COALESCE(excluded.appearance, assistants.appearance)')
          .run(text(a.id, 100), text(a.name, 80), a.provider, a.instructions, appearance);
        break;
      }
      case 'createConversation': {
        const assistantId = text(request.assistantId, 100);
        const assistant = this.db.query<Assistant, [string]>('SELECT * FROM assistants WHERE id = ?').get(assistantId);
        if (!assistant) throw new Error('Assistant not found.');
        conversationId = crypto.randomUUID();
        this.db.query('INSERT INTO conversations (id, assistantId, title, model) VALUES (?, ?, ?, ?)').run(conversationId, assistantId, 'New conversation', defaultModel(assistant.provider));
        break;
      }
      case 'saveMessage': {
        conversationId = text(request.conversationId, 100);
        this.conversation(conversationId);
        this.db.transaction(() => this.addUser(conversationId!, text(request.text, 16000)))();
        break;
      }
      case 'revertMessage': {
        conversationId = text(request.conversationId, 100);
        this.revertMessages(conversationId, text(request.messageId, 100));
        break;
      }
      default: throw new Error('Unsupported request.');
    }
    return { snapshot: this.snapshot(conversationId), conversationId };
  }
  close() { this.db.close(); }
}
