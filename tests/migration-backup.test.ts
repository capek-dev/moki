import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePreMigrationBackup, preMigrationBackupPath, type MigrationBackupIo } from '@backend/storage/migration-backup';
import { Store } from '@backend/storage/store';

function temporaryDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'moki-migration-backup-'));
  return { dir, path: join(dir, 'archive.sqlite') };
}

function createLegacyDatabase(path: string, withWal = false) {
  const db = new Database(path);
  db.exec(withWal ? 'PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;' : 'PRAGMA journal_mode = DELETE;');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, assistantId TEXT NOT NULL REFERENCES assistants(id), title TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), text TEXT NOT NULL);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, mime TEXT NOT NULL, byteSize INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, storageName TEXT NOT NULL);
    INSERT INTO assistants VALUES ('moki', 'Moki', 'deepseek', 'Be helpful.');
    INSERT INTO conversations VALUES ('conversation-1', 'moki', 'Legacy');
    INSERT INTO messages VALUES ('message-1', 'conversation-1', 'WAL data must survive.');
  `);
  db.close();
}

function tableColumns(path: string, table: string) {
  const db = new Database(path, { readonly: true, create: false });
  try { return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((column) => column.name); }
  finally { db.close(); }
}

test('creates a validated restrictive backup from a legacy database with WAL contents', () => {
  const { dir, path } = temporaryDatabase();
  try {
    createLegacyDatabase(path, true);
    expect(existsSync(`${path}-wal`)).toBe(true);
    const backupPath = preMigrationBackupPath(path);
    const store = new Store(path);
    try {
      expect(existsSync(backupPath)).toBe(true);
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
      const backup = new Database(backupPath, { readonly: true, create: false });
      try {
        expect(backup.query<{ text: string }, []>('SELECT text FROM messages WHERE id = \'message-1\'').get()?.text).toBe('WAL data must survive.');
        expect(backup.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      } finally { backup.close(); }
      expect(store.messages('conversation-1')[0].text).toBe('WAL data must survive.');
    } finally { store.close(); }

    const backupMtime = statSync(backupPath).mtimeMs;
    const reopened = new Store(path);
    reopened.close();
    expect(statSync(backupPath).mtimeMs).toBe(backupMtime);
    expect(tableColumns(path, 'messages')).toContain('createdAt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects a valid but mismatched backup before schema changes', () => {
  const { dir, path } = temporaryDatabase();
  try {
    createLegacyDatabase(path);
    const unrelatedPath = join(dir, 'unrelated.sqlite');
    createLegacyDatabase(unrelatedPath);
    const unrelated = new Database(unrelatedPath);
    unrelated.query('UPDATE messages SET text = ?').run('Different database contents.');
    unrelated.close();
    const backupPath = preMigrationBackupPath(path);
    copyFileSync(unrelatedPath, backupPath);
    chmodSync(backupPath, 0o600);
    expect(() => new Store(path)).toThrow('contents do not match');
    expect(tableColumns(path, 'messages')).not.toContain('createdAt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('does not delete a competing final file when link loses the final-name race', () => {
  const { dir, path } = temporaryDatabase();
  try {
    createLegacyDatabase(path);
    const unrelatedPath = join(dir, 'unrelated.sqlite');
    createLegacyDatabase(unrelatedPath);
    const unrelated = new Database(unrelatedPath, { readwrite: true, create: false });
    unrelated.query('UPDATE messages SET text = ?').run('Competing database contents.');
    unrelated.close();
    const source = new Database(path, { readwrite: true, create: false });
    const backupPath = preMigrationBackupPath(path);
    const competingIo: MigrationBackupIo = {
      link: (_temporaryPath, finalPath) => {
        copyFileSync(unrelatedPath, finalPath);
        chmodSync(finalPath, 0o600);
        const error = Object.assign(new Error('competing writer won'), { code: 'EEXIST' });
        throw error;
      },
    };
    try {
      expect(() => ensurePreMigrationBackup(source, path, competingIo)).toThrow('contents do not match');
      expect(existsSync(backupPath)).toBe(true);
      expect(readFileSync(backupPath)).toEqual(readFileSync(unrelatedPath));
    } finally { source.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fails closed before schema changes when the backup cannot be established', () => {
  const { dir, path } = temporaryDatabase();
  try {
    createLegacyDatabase(path);
    const backupPath = preMigrationBackupPath(path);
    mkdirSync(backupPath);
    expect(() => new Store(path)).toThrow();
    expect(tableColumns(path, 'messages')).not.toContain('createdAt');
    const source = new Database(path, { readonly: true, create: false });
    try { expect(source.query<{ text: string }, []>('SELECT text FROM messages').get()?.text).toBe('WAL data must survive.'); }
    finally { source.close(); }
    rmSync(backupPath, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration failure rolls back and retry reuses the same backup', () => {
  const { dir, path } = temporaryDatabase();
  try {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, assistantId TEXT NOT NULL REFERENCES assistants(id), title TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), text TEXT NOT NULL);
      CREATE TABLE memories (id TEXT PRIMARY KEY);
      INSERT INTO assistants VALUES ('moki', 'Moki', 'deepseek', 'Be helpful.');
      INSERT INTO conversations VALUES ('conversation-1', 'moki', 'Legacy');
      INSERT INTO messages VALUES ('message-1', 'conversation-1', 'Must roll back.');
    `);
    db.close();
    const backupPath = preMigrationBackupPath(path);
    expect(() => new Store(path)).toThrow();
    const firstBackupMtime = statSync(backupPath).mtimeMs;
    expect(tableColumns(path, 'messages')).not.toContain('createdAt');
    expect(existsSync(backupPath)).toBe(true);
    expect(() => new Store(path)).toThrow();
    expect(statSync(backupPath).mtimeMs).toBe(firstBackupMtime);
    expect(tableColumns(path, 'messages')).not.toContain('createdAt');
    const unchanged = new Database(path, { readonly: true, create: false });
    try { expect(unchanged.query<{ text: string }, []>('SELECT text FROM messages').get()?.text).toBe('Must roll back.'); }
    finally { unchanged.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('new and in-memory databases do not create migration backups, and missing data never falls back to fresh storage', () => {
  const { dir, path } = temporaryDatabase();
  try {
    const fresh = new Store(path);
    fresh.close();
    expect(existsSync(preMigrationBackupPath(path))).toBe(false);
    const memory = new Store(':memory:');
    memory.close();
    expect(() => preMigrationBackupPath(':memory:')).toThrow();

    const recoveryPath = join(dir, 'recovery.sqlite');
    createLegacyDatabase(recoveryPath);
    const migrated = new Store(recoveryPath);
    migrated.close();
    const backupPath = preMigrationBackupPath(recoveryPath);
    unlinkSync(recoveryPath);
    expect(() => new Store(recoveryPath)).toThrow('will not create a fresh database');
    expect(existsSync(backupPath)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
