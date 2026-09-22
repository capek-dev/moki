import type { Database } from 'bun:sqlite';

export function installLearningSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_settings (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
      provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'codex')),
      model TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      idleUntil INTEGER,
      cooldownUntil INTEGER,
      pendingSince INTEGER
    );
    INSERT OR IGNORE INTO learning_settings (id, enabled, paused, provider, model, revision) VALUES (0, 0, 0, 'deepseek', 'deepseek-flash', 1);
    CREATE TABLE IF NOT EXISTS learning_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      nextRowid INTEGER NOT NULL CHECK (nextRowid >= 0),
      activatedAt INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO learning_cursor (id, nextRowid, activatedAt) VALUES (0, (SELECT COALESCE(MAX(rowid), 0) FROM messages), 0);
    CREATE TABLE IF NOT EXISTS learning_runs (
      id TEXT PRIMARY KEY,
      operationKey TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed', 'cancelled')),
      cursorStart INTEGER NOT NULL,
      cursorEnd INTEGER NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      provider TEXT NOT NULL DEFAULT 'deepseek',
      model TEXT NOT NULL DEFAULT 'deepseek-flash',
      cancelRequested INTEGER NOT NULL DEFAULT 0 CHECK (cancelRequested IN (0, 1)),
      manifestOrigin TEXT NOT NULL DEFAULT 'unavailable' CHECK (manifestOrigin IN ('unavailable', 'captured', 'recaptured')),
       error TEXT,
       createdAt INTEGER NOT NULL,
       startedAt INTEGER,
       completedAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS learning_runs_status_idx ON learning_runs (status, createdAt);
    CREATE TABLE IF NOT EXISTS learning_run_sources (
      runId TEXT NOT NULL REFERENCES learning_runs(id) ON DELETE CASCADE,
      messageId TEXT NOT NULL,
      capturedRevision INTEGER NOT NULL CHECK (capturedRevision >= 1),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      capturedAt INTEGER NOT NULL,
      excerptOffset INTEGER NOT NULL DEFAULT 0,
      excerptLength INTEGER NOT NULL CHECK (excerptLength >= 0),
      PRIMARY KEY (runId, messageId)
    );
    CREATE INDEX IF NOT EXISTS learning_run_sources_run_idx ON learning_run_sources (runId, messageId);
    CREATE TABLE IF NOT EXISTS learning_proposals (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL REFERENCES learning_runs(id) ON DELETE CASCADE,
      operationId TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('memory', 'topic', 'entity', 'relationship')),
      payload TEXT NOT NULL,
      sourceMessageId TEXT NOT NULL,
      sourceRevision INTEGER NOT NULL CHECK (sourceRevision >= 1),
      sourceRole TEXT NOT NULL CHECK (sourceRole = 'user'),
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'suppressed', 'stale')),
      rejection TEXT
    );
    CREATE INDEX IF NOT EXISTS learning_proposals_run_idx ON learning_proposals (runId, status, id);
    CREATE TABLE IF NOT EXISTS learning_history (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL REFERENCES learning_runs(id) ON DELETE RESTRICT,
      operationId TEXT NOT NULL UNIQUE,
      action TEXT NOT NULL CHECK (action IN ('add', 'correct')),
      memoryId TEXT NOT NULL,
      resourceType TEXT NOT NULL DEFAULT 'memory',
      resourceId TEXT,
      beforeJson TEXT,
      afterJson TEXT NOT NULL,
      afterRevision INTEGER NOT NULL CHECK (afterRevision >= 1),
      createdAt INTEGER NOT NULL,
      undoneAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS learning_history_memory_idx ON learning_history (memoryId, createdAt DESC);
    CREATE TABLE IF NOT EXISTS learning_exclusions (
      conversationId TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      excludedAt INTEGER NOT NULL
    );
  `);
  const runColumns = db.query<{ name: string }, []>('PRAGMA table_info(learning_runs)').all();
  if (!runColumns.some((column) => column.name === 'startedAt')) db.exec("ALTER TABLE learning_runs ADD COLUMN startedAt INTEGER");
  if (!runColumns.some((column) => column.name === 'manifestOrigin')) db.exec("ALTER TABLE learning_runs ADD COLUMN manifestOrigin TEXT NOT NULL DEFAULT 'unavailable'");
  // Content-free source manifests started with a 600-character excerpt cap.
  // Widen the bound while preserving every recorded manifest row.
  const sourceDefinition = db.query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'learning_run_sources'").get()?.sql ?? '';
  if (sourceDefinition && !sourceDefinition.includes('CHECK (excerptLength >= 0)')) db.exec(`
    CREATE TABLE learning_run_sources_upgrade (
      runId TEXT NOT NULL REFERENCES learning_runs(id) ON DELETE CASCADE,
      messageId TEXT NOT NULL,
      capturedRevision INTEGER NOT NULL CHECK (capturedRevision >= 1),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      capturedAt INTEGER NOT NULL,
      excerptOffset INTEGER NOT NULL DEFAULT 0,
      excerptLength INTEGER NOT NULL CHECK (excerptLength >= 0),
      PRIMARY KEY (runId, messageId)
    );
    INSERT INTO learning_run_sources_upgrade (runId, messageId, capturedRevision, role, capturedAt, excerptOffset, excerptLength)
      SELECT runId, messageId, capturedRevision, role, capturedAt, excerptOffset, excerptLength FROM learning_run_sources;
    DROP TABLE learning_run_sources;
    ALTER TABLE learning_run_sources_upgrade RENAME TO learning_run_sources;
    CREATE INDEX IF NOT EXISTS learning_run_sources_run_idx ON learning_run_sources (runId, messageId);
  `);
  if (!runColumns.some((column) => column.name === 'provider')) db.exec("ALTER TABLE learning_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'deepseek'");
  if (!runColumns.some((column) => column.name === 'model')) db.exec("ALTER TABLE learning_runs ADD COLUMN model TEXT NOT NULL DEFAULT 'deepseek-flash'");
  const historyColumns = db.query<{ name: string }, []>('PRAGMA table_info(learning_history)').all();
  if (!historyColumns.some((column) => column.name === 'resourceType')) db.exec("ALTER TABLE learning_history ADD COLUMN resourceType TEXT NOT NULL DEFAULT 'memory'");
  if (!historyColumns.some((column) => column.name === 'resourceId')) db.exec('ALTER TABLE learning_history ADD COLUMN resourceId TEXT');
  db.exec('UPDATE learning_history SET resourceId = memoryId WHERE resourceId IS NULL');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS learning_history_memory_erasure
    AFTER DELETE ON memories
    BEGIN
       DELETE FROM learning_history WHERE (resourceType = 'memory' AND resourceId = OLD.id) OR (resourceType IS NULL AND memoryId = OLD.id);
     END;
     DROP TRIGGER IF EXISTS learning_proposal_memory_erasure;
     CREATE TRIGGER learning_proposal_memory_erasure
     AFTER DELETE ON memories
     BEGIN
       DELETE FROM learning_proposals WHERE id = OLD.id OR instr(payload, OLD.id) > 0;
     END;
    DROP TRIGGER IF EXISTS learning_history_relationship_erasure;
    CREATE TRIGGER learning_history_relationship_erasure
    AFTER DELETE ON memory_relationships
    WHEN EXISTS (SELECT 1 FROM memory_forget_suppressions WHERE memoryId = OLD.subjectId OR memoryId = OLD.objectId)
    BEGIN
      DELETE FROM learning_history WHERE resourceType = 'relationship' AND resourceId = OLD.id;
    END;
  `);
}
