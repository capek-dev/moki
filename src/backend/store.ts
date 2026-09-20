import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoMissingDatabaseWithBackup, ensurePreMigrationBackup, plan28SchemaComplete, PLAN28_SCHEMA_VERSION, isOnDiskDatabase } from '@backend/migration-backup';
import { storedAppearance, validateAppearance } from '@shared/appearance';
import { attachmentDirectories, requireAttachmentId, validatePng } from '@shared/attachments';
import { installMemoryGraphSchema, MemoryGraphRepository } from '@backend/memory-graph-repository';
import { installMemorySchema, MemoryRepository } from '@backend/memory-repository';
import { installLearningSchema, MemoryLearningRepository } from '@backend/memory-learning';
import { installSessionSearchSchema, rebuildSessionSearchIndex, sessionSearchIndexNeedsRebuild, SessionSearchRepository } from '@backend/session-search-repository';
import { memoryConfigFromSettings, type MemoryHostConfig } from '@backend/memory-recall';
import type { MemoryRead, MemoryRecord } from '@backend/memory-repository';
import type { MemoryConnectionsPage, MemoryDetail, MemoryEvidence, MemoryMutationAttribution, MemoryPage, MemoryRecallHistoryPage, MemoryRecallHistoryRecord, MemoryRecallInspection, MemorySettingsState, MemorySummary } from '@shared/memory';
import type { Assistant, Attachment, Conversation, Message, Result, Snapshot, ToolCallRecord } from '@shared/protocol';
import { defaultModel, requireModel, requireThinking, supportsImageInput, type Thinking } from '@shared/models';

type AssistantRow = Omit<Assistant, 'appearance'> & { appearance: string | null };
type AttachmentRow = Attachment & { storageName: string };
// toolCalls is stored as a JSON string; rows decode into the wire shape.
type MessageRow = Omit<Message, 'toolCalls'> & { toolCalls: string | null };
function decodeAssistant(row: AssistantRow): Assistant { return { ...row, appearance: storedAppearance(row.appearance) }; }
function decodeMessage(row: MessageRow): Message {
  if (row.toolCalls === null || row.toolCalls === undefined) return { ...row, toolCalls: undefined };
  try { const parsed = JSON.parse(row.toolCalls); return { ...row, toolCalls: Array.isArray(parsed) ? parsed : undefined }; }
  catch { return { ...row, toolCalls: undefined }; }
}

export function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid text value.');
  return value.trim();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value as Record<string, unknown>;
}
function exactFields(value: Record<string, unknown>, allowed: readonly string[]) {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) throw new Error('Invalid request.');
}
function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid ${name}.`);
  return value;
}
export class Store {
  private db: Database;
  private attachmentDirs?: ReturnType<typeof attachmentDirectories>;
  readonly memoryRepository: MemoryRepository;
  readonly memoryGraphRepository: MemoryGraphRepository;
  readonly learningRepository: MemoryLearningRepository;
  readonly sessionSearchRepository: SessionSearchRepository;
  private readonly messageListeners = new Set<(event: { type: 'published' | 'settings' | 'deleted'; conversationId?: string }) => void>();
  constructor(path: string, dataDir?: string) {
    assertNoMissingDatabaseWithBackup(path);
    const existingOnDiskDatabase = isOnDiskDatabase(path) && existsSync(path);
    this.db = new Database(path, { create: true });
    try {
      // This is the only pre-plan-28 write gate. It runs before WAL mode,
      // CREATE TABLE, ALTER TABLE, or any other migration statement. Bun's
      // serialize() calls SQLite's sqlite3_serialize API on this live
      // connection, so uncheckpointed WAL pages are represented in the
      // consistent snapshot instead of being copied from the main file.
      if (existingOnDiskDatabase && !plan28SchemaComplete(this.db)) ensurePreMigrationBackup(this.db, path);

      if (dataDir) {
        this.attachmentDirs = attachmentDirectories(dataDir);
        mkdirSync(this.attachmentDirs.drafts, { recursive: true, mode: 0o700 });
        mkdirSync(this.attachmentDirs.content, { recursive: true, mode: 0o700 });
      }
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, assistantId TEXT NOT NULL REFERENCES assistants(id), title TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), text TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS message_model_context (messageId TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, context TEXT NOT NULL, memoryIdsJson TEXT NOT NULL DEFAULT '[]');
          CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, mime TEXT NOT NULL, byteSize INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, storageName TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS cua_disabled_tools (name TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS cua_integration (id INTEGER PRIMARY KEY CHECK (id = 0), enabled INTEGER NOT NULL);
          INSERT OR IGNORE INTO cua_integration (id, enabled) VALUES (0, 1);
          CREATE TABLE IF NOT EXISTS mcp_catalogs (server TEXT PRIMARY KEY, catalog TEXT NOT NULL, fetchedAt INTEGER NOT NULL);
           CREATE TABLE IF NOT EXISTS memory_settings (id INTEGER PRIMARY KEY CHECK (id = 0), enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), recall TEXT NOT NULL CHECK (recall IN ('basic', 'jev')), jevConsent INTEGER NOT NULL DEFAULT 0 CHECK (jevConsent IN (0, 1)), jevModel TEXT NOT NULL DEFAULT 'jev-latest', revision INTEGER NOT NULL CHECK (revision >= 1));`);
        const memorySettingsSql = this.db.query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_settings'").get()?.sql ?? '';
        if (memorySettingsSql && !memorySettingsSql.includes("recall IN ('basic', 'jev')")) {
          this.db.exec(`ALTER TABLE memory_settings RENAME TO memory_settings_phase3;
            CREATE TABLE memory_settings (id INTEGER PRIMARY KEY CHECK (id = 0), enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), recall TEXT NOT NULL CHECK (recall IN ('basic', 'jev')), jevConsent INTEGER NOT NULL DEFAULT 0 CHECK (jevConsent IN (0, 1)), jevModel TEXT NOT NULL DEFAULT 'jev-latest', revision INTEGER NOT NULL CHECK (revision >= 1));
            INSERT INTO memory_settings (id, enabled, recall, revision) SELECT id, enabled, 'basic', revision FROM memory_settings_phase3;
            DROP TABLE memory_settings_phase3;`);
        }
        const memorySettingsColumns = this.db.query<{ name: string }, []>('PRAGMA table_info(memory_settings)').all();
        if (!memorySettingsColumns.some((column) => column.name === 'jevConsent')) this.db.exec("ALTER TABLE memory_settings ADD COLUMN jevConsent INTEGER NOT NULL DEFAULT 0 CHECK (jevConsent IN (0, 1))");
        if (!memorySettingsColumns.some((column) => column.name === 'jevModel')) this.db.exec("ALTER TABLE memory_settings ADD COLUMN jevModel TEXT NOT NULL DEFAULT 'jev-latest'");
        this.db.query("INSERT OR IGNORE INTO memory_settings (id, enabled, recall, jevConsent, jevModel, revision) VALUES (0, ?, 'basic', 0, 'jev-latest', 1)").run(process.env.MOKI_MEMORY_ENABLED === '1' ? 1 : 0);
        this.db.exec(`CREATE TABLE IF NOT EXISTS memory_recall_history (
          id TEXT PRIMARY KEY,
          conversationId TEXT NOT NULL,
          messageId TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('basic', 'jev')),
          outcome TEXT NOT NULL,
          selectedJson TEXT NOT NULL,
          candidateCount INTEGER NOT NULL CHECK (candidateCount >= 0),
          descriptorCount INTEGER NOT NULL CHECK (descriptorCount >= 0),
          relationshipCount INTEGER NOT NULL CHECK (relationshipCount >= 0),
          elapsedMs INTEGER NOT NULL CHECK (elapsedMs >= 0),
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_recall_history_created_idx ON memory_recall_history (createdAt DESC, id);`);
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
        add('messages', 'toolCalls', 'TEXT');
        // Plan 28 slice 1: legacy rows keep createdAt NULL and revision 1.
        add('messages', 'createdAt', 'INTEGER');
        add('messages', 'revision', 'INTEGER NOT NULL DEFAULT 1');
        add('message_model_context', 'memoryIdsJson', "TEXT NOT NULL DEFAULT '[]'");
        installMemorySchema(this.db);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS message_model_context_memory (
            messageId TEXT NOT NULL REFERENCES message_model_context(messageId) ON DELETE CASCADE,
            memoryId TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            memoryRevision INTEGER NOT NULL CHECK (memoryRevision >= 1),
            PRIMARY KEY (messageId, memoryId)
          );
        `);
        add('message_model_context_memory', 'memoryRevision', 'INTEGER NOT NULL DEFAULT 1 CHECK (memoryRevision >= 1)');
        this.db.exec(`
          DROP TRIGGER IF EXISTS message_model_context_memory_revised;
          CREATE TRIGGER IF NOT EXISTS message_model_context_memory_forgotten
          AFTER DELETE ON message_model_context_memory
          BEGIN
            DELETE FROM message_model_context WHERE messageId = OLD.messageId;
          END;
        `);
        installMemoryGraphSchema(this.db);
        installLearningSchema(this.db);
        this.db.exec("UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'");
        // Search is a rebuildable derived index, not part of the authoritative
        // plan-28 backup identity. Add it transactionally after the old gate.
        installSessionSearchSchema(this.db);
        if (sessionSearchIndexNeedsRebuild(this.db)) rebuildSessionSearchIndex(this.db);
        this.db.query("UPDATE assistants SET name = 'Moki' WHERE id = 'povondra' AND name = 'Povondra'").run();
        const legacy = this.db.query("SELECT id FROM assistants WHERE id = 'povondra'").get();
        if (!legacy) this.db.query('INSERT OR IGNORE INTO assistants (id, name, provider, instructions) VALUES (?, ?, ?, ?)').run('moki', 'Moki', 'deepseek', 'Be helpful, clear, and kind.');
        this.db.exec(`PRAGMA user_version = ${PLAN28_SCHEMA_VERSION}`);
      })();
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.memoryRepository = new MemoryRepository(this.db, false, () => this.touchMemoryRevision(), (memoryId) => this.scrubMemoryRecallHistory(memoryId), (memoryId) => this.invalidateModelContexts(memoryId));
    this.memoryGraphRepository = new MemoryGraphRepository(this.db, false);
    this.learningRepository = new MemoryLearningRepository(this.db, () => this.touchMemoryRevision());
    this.sessionSearchRepository = new SessionSearchRepository(this.db);
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
    return this.db.query<MessageRow, [string]>('SELECT * FROM (SELECT rowid AS sequence, * FROM messages WHERE conversationId = ? ORDER BY rowid DESC LIMIT 100) ORDER BY sequence').all(id).map(decodeMessage);
  }
  /** Complete ordered history for model requests. UI snapshots remain bounded. */
  modelMessages(id: string): Message[] {
    return this.db.query<MessageRow, [string]>('SELECT rowid AS sequence, * FROM messages WHERE conversationId = ? ORDER BY rowid').all(text(id, 100)).map(decodeMessage);
  }
  modelContextsFor(messages: readonly Message[]): Map<string, string> {
    const result = new Map<string, string>();
    for (let start = 0; start < messages.length; start += 500) {
      const ids = messages.slice(start, start + 500).map((message) => message.id);
      const placeholders = ids.map(() => '?').join(',');
      const rows = this.db.query<{ messageId: string; context: string }, string[]>(`SELECT messageId, context FROM message_model_context WHERE messageId IN (${placeholders})`).all(...ids);
      for (const row of rows) result.set(row.messageId, row.context);
    }
    return result;
  }
  setMessageModelContext(messageId: string, context: string, memories: readonly { memoryId: string; revision: number }[] = []): void {
    const id = text(messageId, 100);
    if (typeof context !== 'string' || !context.trim() || context.length > 64_000) throw new Error('Invalid model context.');
    if (!Array.isArray(memories) || memories.length > 16) throw new Error('Invalid model context memory references.');
    const normalizedMemories = memories.map((memory) => ({ memoryId: text(memory.memoryId, 100), revision: integer(memory.revision, 'memory revision') }));
    if (new Set(normalizedMemories.map((memory) => memory.memoryId)).size !== normalizedMemories.length) throw new Error('Invalid model context memory references.');
    const memoryIdsJson = JSON.stringify(normalizedMemories);
    const row = this.db.query<{ role: string }, [string]>('SELECT role FROM messages WHERE id = ?').get(id);
    if (!row || row.role !== 'user') throw new Error('Model context requires a user message.');
    this.db.transaction(() => {
      this.db.query('INSERT OR IGNORE INTO message_model_context (messageId, context, memoryIdsJson) VALUES (?, ?, ?)').run(id, context, memoryIdsJson);
      const stored = this.db.query<{ context: string; memoryIdsJson: string }, [string]>('SELECT context, memoryIdsJson FROM message_model_context WHERE messageId = ?').get(id);
      if (!stored || stored.context !== context || stored.memoryIdsJson !== memoryIdsJson) throw new Error('Model context is already fixed for this user turn.');
      const linked = this.db.query<{ memoryId: string; memoryRevision: number }, [string]>('SELECT memoryId, memoryRevision FROM message_model_context_memory WHERE messageId = ? ORDER BY memoryId').all(id);
      const expectedLinks = [...normalizedMemories].sort((left, right) => left.memoryId.localeCompare(right.memoryId));
      if (linked.length && JSON.stringify(linked) !== JSON.stringify(expectedLinks)) throw new Error('Model context memory links are already fixed for this user turn.');
      for (const memory of normalizedMemories) this.db.query('INSERT OR IGNORE INTO message_model_context_memory (messageId, memoryId, memoryRevision) VALUES (?, ?, ?)').run(id, memory.memoryId, memory.revision);
    })();
  }
  /** Return the user message immediately preceding the host-created assistant reply. */
  foregroundUserSource(assistantMessageId: string): { sourceMessageId: string; sourceRevision: number } {
    const row = this.db.query<{ sourceMessageId: string; sourceRevision: number }, [string]>(`
      SELECT userMessage.id AS sourceMessageId, userMessage.revision AS sourceRevision
      FROM messages assistantMessage
      JOIN messages userMessage
        ON userMessage.conversationId = assistantMessage.conversationId
       AND userMessage.role = 'user'
       AND userMessage.rowid < assistantMessage.rowid
      WHERE assistantMessage.id = ? AND assistantMessage.role = 'assistant'
      ORDER BY userMessage.rowid DESC
      LIMIT 1
    `).get(text(assistantMessageId, 100));
    if (!row) throw new Error('Foreground user source not found.');
    return row;
  }
  attachmentsFor(messages: readonly Message[]): Attachment[] {
    const result: Attachment[] = [];
    for (let start = 0; start < messages.length; start += 500) {
      const ids = messages.slice(start, start + 500).map((message) => message.id);
      const placeholders = ids.map(() => '?').join(',');
      result.push(...this.db.query<Attachment, string[]>(`SELECT id, messageId, mime, byteSize, width, height FROM attachments WHERE messageId IN (${placeholders}) ORDER BY rowid`).all(...ids));
    }
    return result;
  }
  memorySettings(): MemorySettingsState {
    const row = this.db.query<{ enabled: number; recall: 'basic' | 'jev'; jevConsent: number; jevModel: string; revision: number }, []>('SELECT enabled, recall, jevConsent, jevModel, revision FROM memory_settings WHERE id = 0').get();
    if (!row) throw new Error('Memory settings are unavailable.');
    return { enabled: row.enabled === 1, recall: row.recall, jevConsent: row.jevConsent === 1, jevModel: row.jevModel, revision: row.revision };
  }
  memoryConfig(): MemoryHostConfig {
    return memoryConfigFromSettings(this.memorySettings());
  }
  recordMemoryRecall(conversationId: string, messageId: string, inspection: MemoryRecallInspection): MemoryRecallHistoryRecord {
    const selected = inspection.selected.slice(0, 16).map((item) => ({ memoryId: text(item.memoryId, 100), revision: integer(item.revision, 'memory revision') }));
    const record: MemoryRecallHistoryRecord = { ...inspection, id: crypto.randomUUID(), conversationId: text(conversationId, 100), messageId: text(messageId, 100), selected, createdAt: Date.now() };
    this.db.query('INSERT INTO memory_recall_history (id, conversationId, messageId, mode, outcome, selectedJson, candidateCount, descriptorCount, relationshipCount, elapsedMs, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.conversationId, record.messageId, record.mode, record.outcome.slice(0, 80), JSON.stringify(record.selected), record.candidateCount, record.descriptorCount, record.relationshipCount, record.elapsedMs, record.createdAt);
    this.db.exec('DELETE FROM memory_recall_history WHERE id NOT IN (SELECT id FROM memory_recall_history ORDER BY createdAt DESC, id DESC LIMIT 200)');
    return record;
  }
  onReviewInvalidated?: () => void;
  private invalidateModelContexts(memoryId: string) {
    this.db.query('DELETE FROM message_model_context WHERE messageId IN (SELECT messageId FROM message_model_context_memory WHERE memoryId = ?)').run(memoryId);
  }
  private scrubMemoryRecallHistory(memoryId: string) {
    this.onReviewInvalidated?.();
    const contexts = this.db.query<{ messageId: string; memoryIdsJson: string }, []>('SELECT messageId, memoryIdsJson FROM message_model_context').all();
    for (const context of contexts) {
      try {
        const memoryRefs = JSON.parse(context.memoryIdsJson) as unknown;
        if (Array.isArray(memoryRefs) && memoryRefs.some((entry) => entry === memoryId || (entry !== null && typeof entry === 'object' && (entry as { memoryId?: unknown }).memoryId === memoryId))) this.db.query('DELETE FROM message_model_context WHERE messageId = ?').run(context.messageId);
      } catch { this.db.query('DELETE FROM message_model_context WHERE messageId = ?').run(context.messageId); }
    }
    const rows = this.db.query<{ id: string; selectedJson: string }, []>('SELECT id, selectedJson FROM memory_recall_history').all();
    for (const row of rows) {
      try {
        const selected = JSON.parse(row.selectedJson) as unknown;
        if (!Array.isArray(selected)) continue;
        const filtered = selected.filter((item) => item && typeof item === 'object' && (item as { memoryId?: unknown }).memoryId !== memoryId);
        if (filtered.length !== selected.length) this.db.query('UPDATE memory_recall_history SET selectedJson = ? WHERE id = ?').run(JSON.stringify(filtered.slice(0, 16)), row.id);
      } catch { this.db.query('UPDATE memory_recall_history SET selectedJson = ? WHERE id = ?').run('[]', row.id); }
    }
  }
  memoryRecallHistory(limit: unknown = 25, offset: unknown = 0): MemoryRecallHistoryPage {
    const pageLimit = typeof limit === 'number' ? limit : Number.NaN;
    const pageOffset = typeof offset === 'number' ? offset : Number.NaN;
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 50 || !Number.isSafeInteger(pageOffset) || pageOffset < 0 || pageOffset > 10000) throw new Error('Invalid memory recall history page.');
    const rows = this.db.query<{ id: string; conversationId: string; messageId: string; mode: 'basic' | 'jev'; outcome: string; selectedJson: string; candidateCount: number; descriptorCount: number; relationshipCount: number; elapsedMs: number; createdAt: number }, [number, number]>('SELECT * FROM memory_recall_history ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?').all(pageLimit + 1, pageOffset);
    const records = rows.slice(0, pageLimit).map((row): MemoryRecallHistoryRecord => {
      let selected: MemoryRecallHistoryRecord['selected'] = [];
      try {
        const parsed = JSON.parse(row.selectedJson) as unknown;
        if (Array.isArray(parsed)) selected = parsed.filter((item): item is { memoryId: string; revision: number } => item !== null && typeof item === 'object' && typeof (item as { memoryId?: unknown }).memoryId === 'string' && Number.isSafeInteger((item as { revision?: unknown }).revision)).slice(0, 16);
      } catch { selected = []; }
      return { id: row.id, conversationId: row.conversationId, messageId: row.messageId, mode: row.mode, outcome: row.outcome, selected, candidateCount: row.candidateCount, descriptorCount: row.descriptorCount, relationshipCount: row.relationshipCount, elapsedMs: row.elapsedMs, createdAt: row.createdAt };
    });
    return { records, offset: pageOffset, nextOffset: rows.length > pageLimit ? pageOffset + pageLimit : null };
  }
  onMessageEvent(listener: (event: { type: 'published' | 'settings' | 'deleted'; conversationId?: string }) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  private emitMessageEvent(event: { type: 'published' | 'settings' | 'deleted'; conversationId?: string }) {
    for (const listener of this.messageListeners) listener(event);
  }
  setLearningEnabled(enabled: boolean, expectedRevision: number) {
    const result = this.learningRepository.setEnabled(enabled, expectedRevision);
    this.emitMessageEvent({ type: 'settings' });
    return result;
  }
  setLearningPaused(paused: boolean, expectedRevision: number) {
    const result = this.learningRepository.setPaused(paused, expectedRevision);
    this.emitMessageEvent({ type: 'settings' });
    return result;
  }
  setLearningProviderModel(provider: 'deepseek' | 'codex', model: string, expectedRevision: number) {
    const result = this.learningRepository.setProviderModel(provider, model, expectedRevision);
    this.emitMessageEvent({ type: 'settings' });
    return result;
  }
  setLearningExcluded(conversationId: string, excluded: boolean) {
    const result = this.learningRepository.setExcluded(conversationId, excluded);
    this.emitMessageEvent({ type: 'settings', conversationId });
    return result;
  }
  setMemoryEnabled(enabled: boolean, expectedRevision: number): MemorySettingsState {
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Invalid memory settings.');
    const result = this.db.query('UPDATE memory_settings SET enabled = ?, revision = revision + 1 WHERE id = 0 AND revision = ?').run(enabled ? 1 : 0, expectedRevision);
    if (result.changes !== 1) throw new Error('Memory settings revision conflict.');
    if (!enabled) this.learningRepository.cancelAll();
    this.emitMessageEvent({ type: 'settings' });
    return this.memorySettings();
  }
  setMemoryPolicy(recall: 'basic' | 'jev', jevConsent: boolean, jevModel: string, expectedRevision: number): MemorySettingsState {
    if ((recall !== 'basic' && recall !== 'jev') || typeof jevConsent !== 'boolean' || typeof jevModel !== 'string' || !jevModel.trim() || jevModel.length > 120 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Invalid memory Jev settings.');
    const result = this.db.query('UPDATE memory_settings SET recall = ?, jevConsent = ?, jevModel = ?, revision = revision + 1 WHERE id = 0 AND revision = ?').run(recall, jevConsent ? 1 : 0, jevModel.trim(), expectedRevision);
    if (result.changes !== 1) throw new Error('Memory settings revision conflict.');
    this.emitMessageEvent({ type: 'settings' });
    return this.memorySettings();
  }
  private touchMemoryRevision() {
    this.db.query('UPDATE memory_settings SET revision = revision + 1 WHERE id = 0').run();
  }
  private memorySummary(memory: MemoryRecord): MemorySummary {
    const codePoints = Array.from(memory.text);
    const textLimit = 4000;
    return { ...memory, text: codePoints.slice(0, textLimit).join(''), textTruncated: codePoints.length > textLimit, textLength: codePoints.length };
  }
  private memoryPage(query: string | null, records: readonly MemoryRecord[], offset: number, limit: number): MemoryPage {
    const memories = records.slice(0, limit).map((memory) => this.memorySummary(memory));
    return { query, memories, offset, nextOffset: records.length > memories.length ? offset + memories.length : null };
  }
  memoryList(query: unknown, limit: unknown, offset: unknown): MemoryPage {
    const pageLimit = limit === undefined ? 25 : typeof limit === 'number' ? limit : Number.NaN;
    const pageOffset = offset === undefined ? 0 : typeof offset === 'number' ? offset : Number.NaN;
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 50) throw new Error('Invalid memory page limit.');
    if (!Number.isSafeInteger(pageOffset) || pageOffset < 0 || pageOffset > 10000) throw new Error('Invalid memory page offset.');
    if (query !== undefined && (typeof query !== 'string' || !query.trim() || query.length > 500)) throw new Error('Invalid memory search query.');
    const normalized = query === undefined ? null : query.trim();
    const records = normalized === null
      ? this.memoryRepository.list({ limit: Math.min(pageLimit + 1, 100), offset: pageOffset })
      : this.memoryRepository.search(normalized, { limit: Math.min(pageLimit + 1, 100), offset: pageOffset });
    return this.memoryPage(normalized, records, pageOffset, pageLimit);
  }
  memoryRead(memoryId: string, expectedRevision: unknown, offset: unknown, textLimit: unknown): MemoryDetail {
    const read: MemoryRead = this.memoryRepository.read(text(memoryId, 100));
    if (expectedRevision !== undefined && (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || read.memory.revision !== expectedRevision)) throw new Error('Memory revision conflict.');
    const pageOffset = offset === undefined ? 0 : typeof offset === 'number' ? offset : Number.NaN;
    const pageLimit = textLimit === undefined ? 4000 : typeof textLimit === 'number' ? textLimit : Number.NaN;
    if (!Number.isSafeInteger(pageOffset) || pageOffset < 0 || pageOffset > 16000) throw new Error('Invalid memory text offset.');
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 8000) throw new Error('Invalid memory text limit.');
    const codePoints = Array.from(read.memory.text);
    const end = Math.min(codePoints.length, pageOffset + pageLimit);
    const evidence = read.evidence.slice(0, 50).map((item): MemoryEvidence => ({ ...item }));
    return { ...this.memorySummary(read.memory), textPage: codePoints.slice(pageOffset, end).join(''), textOffset: pageOffset, textNextOffset: end < codePoints.length ? end : null, evidence, evidenceTruncated: read.evidence.length > evidence.length };
  }
  memoryConnections(memoryId: string, limit: unknown, offset: unknown): MemoryConnectionsPage {
    const id = text(memoryId, 100);
    if (!this.memoryRepository.get(id)) throw new Error('Memory not found.');
    const pageLimit = limit === undefined ? 25 : typeof limit === 'number' ? limit : Number.NaN;
    const pageOffset = offset === undefined ? 0 : typeof offset === 'number' ? offset : Number.NaN;
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 50) throw new Error('Invalid memory connection limit.');
    if (!Number.isSafeInteger(pageOffset) || pageOffset < 0 || pageOffset > 10000) throw new Error('Invalid memory connection offset.');
    const records = this.memoryGraphRepository.listRelationships({ endpointId: id, limit: Math.min(pageLimit + 1, 100), offset: pageOffset });
    return { memoryId: id, connections: records.slice(0, pageLimit).map((item) => ({ ...item })), offset: pageOffset, nextOffset: records.length > pageLimit ? pageOffset + pageLimit : null };
  }

  // Single-row master switch: while off, Moki never contacts the driver and
  // the agent receives none of its tools. Per-tool filters are kept for reuse.
  cuaIntegrationEnabled(): boolean {
    return this.db.query<{ enabled: number }, []>('SELECT enabled FROM cua_integration WHERE id = 0').get()?.enabled === 1;
  }
  setCuaIntegrationEnabled(enabled: boolean) {
    this.db.query('INSERT INTO cua_integration (id, enabled) VALUES (0, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled').run(enabled ? 1 : 0);
  }
  cuaDisabledTools(): string[] {
    return this.db.query<{ name: string }, []>('SELECT name FROM cua_disabled_tools ORDER BY name').all().map((row) => row.name);
  }
  setCuaToolDisabled(name: string, disabled: boolean) {
    if (disabled) this.db.query('INSERT OR IGNORE INTO cua_disabled_tools (name) VALUES (?)').run(name);
    else this.db.query('DELETE FROM cua_disabled_tools WHERE name = ?').run(name);
  }
  pruneCuaDisabledTools(known: readonly string[]) {
    const keep = new Set(known);
    const stale = this.db.query<{ name: string }, []>('SELECT name FROM cua_disabled_tools').all().filter((row) => !keep.has(row.name)).map((row) => row.name);
    if (stale.length) this.db.query(`DELETE FROM cua_disabled_tools WHERE name IN (${stale.map(() => '?').join(',')})`).run(...stale);
  }
  // Durable catalog cache for user-added MCP connections (plan 18): opaque
  // JSON blobs owned by the Mcp class; the store stays schema-dumb on purpose
  // so cache-shape changes never need a migration.
  mcpCatalog(server: string): string | null {
    const row = this.db.query<{ catalog: string }, [string]>('SELECT catalog FROM mcp_catalogs WHERE server = ?').get(text(server, 64));
    return row?.catalog ?? null;
  }
  setMcpCatalog(server: string, catalog: string) {
    this.db.query('INSERT INTO mcp_catalogs (server, catalog, fetchedAt) VALUES (?, ?, ?) ON CONFLICT(server) DO UPDATE SET catalog = excluded.catalog, fetchedAt = excluded.fetchedAt').run(text(server, 64), catalog, Date.now());
  }
  deleteMcpCatalog(server: string) {
    this.db.query('DELETE FROM mcp_catalogs WHERE server = ?').run(text(server, 64));
  }
  pruneMcpCatalogs(known: readonly string[]) {
    const keep = new Set(known);
    const stale = this.db.query<{ server: string }, []>('SELECT server FROM mcp_catalogs').all().filter((row) => !keep.has(row.server)).map((row) => row.server);
    if (stale.length) this.db.query(`DELETE FROM mcp_catalogs WHERE server IN (${stale.map(() => '?').join(',')})`).run(...stale);
  }
  snapshot(conversationId?: string): Snapshot {
    // History reads are bounded. Older messages and their attachments remain on disk.
    const messages = conversationId ? this.messages(conversationId) : this.db.query<MessageRow, []>('SELECT * FROM (SELECT rowid AS sequence, * FROM messages ORDER BY rowid DESC LIMIT 100) ORDER BY sequence').all().map(decodeMessage);
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
      for (const id of ids) this.sessionSearchRepository.removeMessage(id);
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
    this.emitMessageEvent({ type: 'deleted', conversationId });
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
        this.db.query("INSERT INTO messages (id, conversationId, text, role, status, model, assistantName, thinking, createdAt) VALUES (?, ?, '', 'assistant', 'streaming', ?, ?, ?, ?)").run(messageId, id, model, assistant.name, thinking, Date.now());
        this.sessionSearchRepository.syncMessage(messageId);
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
    return { messageId, userMessageId, assistant };
  }
  // Source revisions (plan 28): a row's revision counts its published content
  // versions, starting at 1. Streaming writes are provisional, never evidence,
  // and do not bump. Overwriting a row that is no longer streaming bumps by
  // exactly one, so evidence citing an older revision detects the change.
  // Unsend and edit-resend remove rows entirely; absent sources, not stale
  // revisions, signal removal to later evidence handling.
  updateReply(id: string, body: string, status: Message['status'], error: string | null = null, toolCalls?: readonly ToolCallRecord[]) {
    this.db.transaction(() => {
      const row = this.db.query<{ status: string }, [string]>('SELECT status FROM messages WHERE id = ?').get(id);
      if (!row) return;
      const bump = row.status === 'streaming' ? 0 : 1;
      if (toolCalls) this.db.query('UPDATE messages SET text = ?, status = ?, error = ?, toolCalls = ?, revision = revision + ? WHERE id = ?').run(body, status, error, JSON.stringify(toolCalls), bump, id);
      else this.db.query('UPDATE messages SET text = ?, status = ?, error = ?, revision = revision + ? WHERE id = ?').run(body, status, error, bump, id);
      this.sessionSearchRepository.syncMessage(id);
    })();
    if (status !== 'streaming') {
      const conversation = this.db.query<{ conversationId: string }, [string]>('SELECT conversationId FROM messages WHERE id = ?').get(id);
      if (conversation) this.emitMessageEvent({ type: 'published', conversationId: conversation.conversationId });
    }
  }
  attachmentBytes(id: string): Uint8Array {
    if (!this.attachmentDirs) throw new Error('Attachment storage is unavailable.');
    const row = this.db.query<AttachmentRow, [string]>('SELECT * FROM attachments WHERE id = ?').get(requireAttachmentId(id));
    if (!row) throw new Error('Attachment not found.');
    return readFileSync(join(this.attachmentDirs.content, row.storageName));
  }
  private addUser(id: string, body: string, messageId = crypto.randomUUID()) {
    const count = this.db.query<{ count: number }, [string]>('SELECT count(*) AS count FROM messages WHERE conversationId = ?').get(id)!.count;
    this.db.query('INSERT INTO messages (id, conversationId, text, createdAt) VALUES (?, ?, ?, ?)').run(messageId, id, text(body, 16000), Date.now());
    this.sessionSearchRepository.syncMessage(messageId);
    if (count === 0) this.db.query('UPDATE conversations SET title = ? WHERE id = ?').run(body.trim().slice(0, 60), id);
    return messageId;
  }
  handle(input: unknown): Result {
    const request = record(input);
    let conversationId: string | undefined;
    let memory: MemorySettingsState | undefined;
    let learning: import('@backend/memory-learning').LearningSettingsState | undefined;
    let learningExclusions: string[] | undefined;
    let learningHistory: import('@backend/memory-learning').LearningHistoryRecord[] | undefined;
    let learningRuns: import('@backend/memory-learning').LearningRunPage | undefined;
    let learningRunDetail: import('@backend/memory-learning').LearningRunDetail | undefined;
    let memoryAttribution: MemoryMutationAttribution | undefined;
    let memoryPage: MemoryPage | undefined;
    let memoryDetail: MemoryDetail | undefined;
    let memoryConnections: MemoryConnectionsPage | undefined;
    let memoryRecallHistory: MemoryRecallHistoryPage | undefined;
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
        this.emitMessageEvent({ type: 'published', conversationId });
        break;
      }
      case 'revertMessage': {
        conversationId = text(request.conversationId, 100);
        this.revertMessages(conversationId, text(request.messageId, 100));
        break;
      }
      case 'memorySettings':
        exactFields(request, ['method']);
        memory = this.memorySettings();
        break;
      case 'learningSettings':
        exactFields(request, ['method']);
        learning = this.learningRepository.settings();
        learningExclusions = this.learningRepository.exclusions();
        break;
      case 'learningSetEnabled':
        exactFields(request, ['method', 'enabled', 'expectedRevision']);
        if (typeof request.enabled !== 'boolean') throw new Error('Invalid learning enabled setting.');
        learning = this.setLearningEnabled(request.enabled, integer(request.expectedRevision, 'learning settings revision'));
        break;
      case 'learningSetPaused':
        exactFields(request, ['method', 'paused', 'expectedRevision']);
        if (typeof request.paused !== 'boolean') throw new Error('Invalid learning pause setting.');
        learning = this.setLearningPaused(request.paused, integer(request.expectedRevision, 'learning settings revision'));
        break;
      case 'learningSetProviderModel':
        exactFields(request, ['method', 'provider', 'model', 'expectedRevision']);
        if (request.provider !== 'deepseek' && request.provider !== 'codex') throw new Error('Invalid learning provider.');
        learning = this.setLearningProviderModel(request.provider, text(request.model, 120), integer(request.expectedRevision, 'learning settings revision'));
        break;
      case 'learningExcludeConversation':
        exactFields(request, ['method', 'conversationId', 'excluded']);
        if (typeof request.excluded !== 'boolean') throw new Error('Invalid learning exclusion.');
        this.setLearningExcluded(text(request.conversationId, 100), request.excluded);
        learning = this.learningRepository.settings();
        learningExclusions = this.learningRepository.exclusions();
        break;
      case 'learningHistory':
        exactFields(request, ['method', 'limit', 'offset']);
        learning = this.learningRepository.settings();
        learningExclusions = this.learningRepository.exclusions();
        learningHistory = this.learningRepository.history(request.limit === undefined ? 50 : integer(request.limit, 'learning history limit'), request.offset === undefined ? 0 : integer(request.offset, 'learning history offset'));
        break;
      case 'learningRuns':
        exactFields(request, ['method', 'limit', 'offset']);
        learning = this.learningRepository.settings();
        learningRuns = this.learningRepository.listRuns(request.limit === undefined ? 25 : integer(request.limit, 'learning run limit'), request.offset === undefined ? 0 : integer(request.offset, 'learning run offset'));
        break;
      case 'learningRunDetail':
        exactFields(request, ['method', 'runId', 'limit']);
        learning = this.learningRepository.settings();
        learningRunDetail = this.learningRepository.runDetail(text(request.runId, 100), request.limit === undefined ? 50 : integer(request.limit, 'learning run detail limit'));
        break;
      case 'learningUndo':
        exactFields(request, ['method', 'historyId', 'expectedRevision']);
        this.learningRepository.undoHistory(text(request.historyId, 100), integer(request.expectedRevision, 'memory revision'));
        memory = this.memorySettings();
        learning = this.learningRepository.settings();
        break;
      case 'memorySetEnabled':
        exactFields(request, ['method', 'enabled', 'expectedRevision']);
        if (typeof request.enabled !== 'boolean') throw new Error('Invalid memory enabled setting.');
        memory = this.setMemoryEnabled(request.enabled, integer(request.expectedRevision, 'memory settings revision'));
        break;
      case 'memorySetPolicy':
        exactFields(request, ['method', 'recall', 'jevConsent', 'jevModel', 'expectedRevision']);
        if (request.recall !== 'basic' && request.recall !== 'jev') throw new Error('Invalid memory recall mode.');
        if (typeof request.jevConsent !== 'boolean') throw new Error('Invalid Jev consent.');
        memory = this.setMemoryPolicy(request.recall, request.jevConsent, text(request.jevModel, 120), integer(request.expectedRevision, 'memory settings revision'));
        break;
      case 'memoryRecallHistory':
        exactFields(request, ['method', 'limit', 'offset']);
        memoryRecallHistory = this.memoryRecallHistory(request.limit === undefined ? 25 : request.limit, request.offset === undefined ? 0 : request.offset);
        memory = this.memorySettings();
        break;
      case 'memoryList':
        exactFields(request, ['method', 'query', 'limit', 'offset']);
        memoryPage = this.memoryList(request.query, request.limit, request.offset);
        memory = this.memorySettings();
        break;
      case 'memoryRead':
        exactFields(request, ['method', 'memoryId', 'expectedRevision', 'offset', 'textLimit']);
        memoryDetail = this.memoryRead(text(request.memoryId, 100), request.expectedRevision, request.offset, request.textLimit);
        memory = this.memorySettings();
        break;
      case 'memoryConnections':
        exactFields(request, ['method', 'memoryId', 'limit', 'offset']);
        memoryConnections = this.memoryConnections(text(request.memoryId, 100), request.limit, request.offset);
        memory = this.memorySettings();
        break;
      case 'memoryUpdate': {
        exactFields(request, ['method', 'memoryId', 'expectedRevision', 'text', 'pinned']);
        if (request.text === undefined && request.pinned === undefined) throw new Error('Memory update is empty.');
        if (request.text !== undefined && typeof request.text !== 'string') throw new Error('Invalid memory text.');
        if (request.pinned !== undefined && typeof request.pinned !== 'boolean') throw new Error('Invalid memory pinned flag.');
        this.memoryRepository.update(text(request.memoryId, 100), integer(request.expectedRevision, 'memory revision'), { ...(request.text === undefined ? {} : { text: request.text }), ...(request.pinned === undefined ? {} : { pinned: request.pinned }) });
        memoryAttribution = { surface: 'settings', createsConversationEvidence: false };
        memory = this.memorySettings();
        break;
      }
      case 'memoryForget':
        exactFields(request, ['method', 'memoryId', 'expectedRevision']);
        this.memoryRepository.forgetFromSettings(text(request.memoryId, 100), integer(request.expectedRevision, 'memory revision'));
        memoryAttribution = { surface: 'settings', createsConversationEvidence: false };
        memory = this.memorySettings();
        break;
      default: throw new Error('Unsupported request.');
    }
    return { snapshot: this.snapshot(conversationId), conversationId, ...(memory === undefined ? {} : { memory }), ...(memoryRecallHistory === undefined ? {} : { memoryRecallHistory }), ...(learning === undefined ? {} : { learning }), ...(learningExclusions === undefined ? {} : { learningExclusions }), ...(learningHistory === undefined ? {} : { learningHistory }), ...(learningRuns === undefined ? {} : { learningRuns }), ...(learningRunDetail === undefined ? {} : { learningRunDetail }), ...(memoryAttribution === undefined ? {} : { memoryAttribution }), ...(memoryPage === undefined ? {} : { memoryPage }), ...(memoryDetail === undefined ? {} : { memoryDetail }), ...(memoryConnections === undefined ? {} : { memoryConnections }) };
  }
  close() { this.db.close(); }
}
