import { Database } from 'bun:sqlite';
import { storedAppearance, validateAppearance } from '../shared/appearance';
type AssistantRow = Omit<Assistant, 'appearance'> & { appearance: string | null };
function decodeAssistant(row: AssistantRow): Assistant { return { ...row, appearance: storedAppearance(row.appearance) }; }
import type { Assistant, Conversation, Message, Result, Snapshot } from '../shared/protocol';
import { defaultModel, requireModel, requireThinking, type Thinking } from '../shared/models';

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
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, assistantId TEXT NOT NULL REFERENCES assistants(id), title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), text TEXT NOT NULL);`);
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
    this.db.query('INSERT OR IGNORE INTO assistants (id, name, provider, instructions) VALUES (?, ?, ?, ?)').run('povondra', 'Povondra', 'deepseek', 'Be helpful, clear, and kind.');
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
  snapshot(conversationId?: string): Snapshot {
    // History reads are bounded. Older messages remain on disk.
    return {
      assistants: this.db.query<AssistantRow, []>('SELECT * FROM assistants ORDER BY rowid').all().map(decodeAssistant),
      conversations: this.db.query<Conversation, []>('SELECT * FROM conversations ORDER BY rowid DESC LIMIT 100').all(),
      messages: conversationId ? this.messages(conversationId) : this.db.query<Message, []>('SELECT * FROM (SELECT rowid AS sequence, * FROM messages ORDER BY rowid DESC LIMIT 100) ORDER BY sequence').all(),
    };
  }
  begin(id: string, body: string, model: string, thinking: Thinking | null = null) {
    const assistant = this.assistantFor(id);
    requireThinking(assistant.provider, model, thinking);
    text(body, 16000);
    if (this.messages(id).some((m) => m.status === 'streaming')) throw new Error('This conversation is already replying.');
    const messageId = crypto.randomUUID();
    this.db.transaction(() => {
      this.addUser(id, body);
      this.db.query('UPDATE conversations SET model = ?, thinking = ? WHERE id = ?').run(model, thinking, id);
      this.db.query("INSERT INTO messages (id, conversationId, text, role, status, model, assistantName, thinking) VALUES (?, ?, '', 'assistant', 'streaming', ?, ?, ?)").run(messageId, id, model, assistant.name, thinking);
    })();
    return { messageId, assistant };
  }
  updateReply(id: string, body: string, status: Message['status'], error: string | null = null) {
    this.db.query('UPDATE messages SET text = ?, status = ?, error = ? WHERE id = ?').run(body, status, error, id);
  }
  private addUser(id: string, body: string) {
    const count = this.db.query<{ count: number }, [string]>('SELECT count(*) AS count FROM messages WHERE conversationId = ?').get(id)!.count;
    this.db.query('INSERT INTO messages (id, conversationId, text) VALUES (?, ?, ?)').run(crypto.randomUUID(), id, text(body, 16000));
    if (count === 0) this.db.query('UPDATE conversations SET title = ? WHERE id = ?').run(body.trim().slice(0, 60), id);
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
      default: throw new Error('Unsupported request.');
    }
    return { snapshot: this.snapshot(conversationId), conversationId };
  }
  close() { this.db.close(); }
}
