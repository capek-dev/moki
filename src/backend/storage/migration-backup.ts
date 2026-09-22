import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const PLAN28_SCHEMA_VERSION = 28;

export function isOnDiskDatabase(path: string): boolean {
  return path !== ':memory:' && path !== '';
}

export function preMigrationBackupPath(databasePath: string): string {
  if (!isOnDiskDatabase(databasePath)) throw new Error('In-memory databases do not have migration backups.');
  return `${resolve(databasePath)}.plan28-pre-migration.sqlite`;
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasColumn(db: Database, table: string, name: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((column) => column.name === name);
}

// The FTS session-search tables are deliberately excluded from this gate.
// They are rebuildable derived data added after the authoritative plan-28
// migration, so requiring them here would compare an already-migrated database
// against its older pre-plan-28 recovery image and reject a safe additive upgrade.
export function plan28SchemaComplete(db: Database): boolean {
  try {
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
    return version >= PLAN28_SCHEMA_VERSION
      && hasColumn(db, 'messages', 'createdAt')
      && hasColumn(db, 'messages', 'revision')
      && ['memories', 'memory_evidence', 'topics', 'entities', 'memory_topics', 'memory_relationships'].every((name) => tableExists(db, name));
  } catch {
    // An unreadable or malformed schema still needs a recovery attempt before
    // the migration path reports its original failure.
    return false;
  }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeSnapshot(bytes: Buffer, directory: string): Buffer {
  const temporaryPath = `${directory}/.moki-snapshot-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
    const snapshot = new Database(temporaryPath, { readwrite: true, create: false });
    try {
      // A serialized WAL database carries the WAL journal mode in its header.
      // The recovery artifact is standalone, so normalize the serialized image
      // to DELETE mode before writing it. This preserves WAL-visible contents
      // without requiring a sidecar -wal file for the backup itself.
      snapshot.exec('PRAGMA journal_mode = DELETE;');
    } finally {
      snapshot.close();
    }
    return readFileSync(temporaryPath);
  } finally {
    try { unlinkSync(temporaryPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function databaseFile(db: Database): string {
  const row = db.query<{ file: string }, []>('PRAGMA database_list').all().find((entry) => entry.file);
  if (!row?.file) throw new Error('SQLite database path could not be verified.');
  return realpathSync(row.file);
}

function validateSnapshot(snapshotPath: string, sourcePath: string, expectedHash: string) {
  const stat = lstatSync(snapshotPath);
  if (!stat.isFile()) throw new Error('Migration backup is not a regular file.');
  if ((stat.mode & 0o077) !== 0) throw new Error('Migration backup permissions are too broad.');
  const backup = new Database(snapshotPath, { readonly: true, create: false });
  try {
    if (databaseFile(backup) !== realpathSync(snapshotPath) || databaseFile(backup) === sourcePath) throw new Error('Migration backup path identity check failed.');
    const checks = backup.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all();
    if (!checks.length || checks.some((row) => row.integrity_check !== 'ok')) throw new Error('Migration backup integrity check failed.');
    if (hash(backup.serialize()) !== expectedHash) throw new Error('Migration backup contents do not match the source snapshot.');
  } finally {
    backup.close();
  }
}

export type MigrationBackupIo = {
  // Narrow seam for testing final-name races without replacing process-global fs APIs.
  link: typeof linkSync;
};

const defaultBackupIo: MigrationBackupIo = { link: linkSync };

function syncFile(path: string) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function syncDirectory(path: string) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

type SnapshotOwnership = {
  finalCreated: boolean;
  finalIdentity?: { dev: number; ino: number };
};

function writeSnapshot(snapshotPath: string, bytes: Buffer, io: MigrationBackupIo, ownership: SnapshotOwnership) {
  const temporaryPath = `${snapshotPath}.tmp-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    // Flush the complete SQLite image before publishing its final name.
    syncFile(temporaryPath);
    // linkSync gives the final name without allowing a late writer to replace
    // an already-established recovery point. The ownership flag changes only
    // after this invocation successfully creates the final directory entry.
    io.link(temporaryPath, snapshotPath);
    const finalStat = lstatSync(snapshotPath);
    ownership.finalCreated = true;
    ownership.finalIdentity = { dev: finalStat.dev, ino: finalStat.ino };
    syncFile(snapshotPath);
    syncDirectory(dirname(snapshotPath));
  } finally {
    try { unlinkSync(temporaryPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function ensurePreMigrationBackup(db: Database, databasePath: string, io: MigrationBackupIo = defaultBackupIo): string {
  const sourcePath = realpathSync(resolve(databasePath));
  const actualSourcePath = databaseFile(db);
  if (actualSourcePath !== sourcePath) throw new Error('SQLite source database path identity check failed.');
  const snapshotPath = preMigrationBackupPath(databasePath);
  const sourceBytes = normalizeSnapshot(db.serialize(), dirname(snapshotPath));
  const sourceHash = hash(sourceBytes);

  if (existsSync(snapshotPath)) {
    validateSnapshot(snapshotPath, sourcePath, sourceHash);
    return snapshotPath;
  }

  mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  const ownership: SnapshotOwnership = { finalCreated: false };
  try {
    writeSnapshot(snapshotPath, sourceBytes, io, ownership);
    validateSnapshot(snapshotPath, sourcePath, sourceHash);
  } catch (error) {
    // A competing writer can win the existsSync/linkSync race. Validate its
    // exact final file, but never remove it because this invocation did not
    // establish ownership of that directory entry.
    if (isAlreadyExists(error)) {
      validateSnapshot(snapshotPath, sourcePath, sourceHash);
      return snapshotPath;
    }
    // Never leave an unverified file that this invocation published. A file
    // owned by another writer is deliberately left untouched.
    if (ownership.finalCreated && ownership.finalIdentity) {
      try {
        const current = lstatSync(snapshotPath);
        if (current.dev === ownership.finalIdentity.dev && current.ino === ownership.finalIdentity.ino) unlinkSync(snapshotPath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
      }
    }
    throw new Error(`Pre-migration backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return snapshotPath;
}

export function assertNoMissingDatabaseWithBackup(databasePath: string) {
  if (!isOnDiskDatabase(databasePath)) return;
  const sourcePath = resolve(databasePath);
  const backupPath = preMigrationBackupPath(databasePath);
  const companionExists = existsSync(`${sourcePath}-wal`) || existsSync(`${sourcePath}-shm`);
  if (!existsSync(sourcePath) && (existsSync(backupPath) || companionExists)) {
    throw new Error(`Database is missing while recovery files exist. Preserve them and restore explicitly from ${backupPath}; Moki will not create a fresh database.`);
  }
}
