import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databasePath, userDataPath } from '@shared/data-paths';
import { Store } from '@backend/store';
import { INITIAL_APPEARANCE } from '@shared/appearance';

function fixture(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'moki-rename-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('Moki packaging and emitted renderer agree on the new identity', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(pkg.name).toBe('moki');
  expect(pkg.build).toMatchObject({ appId: 'app.moki.desktop', productName: 'Moki' });
  expect(pkg.build.extraResources).toEqual([{ from: 'dist/backend/moki-runtime', to: 'backend/moki-runtime' }]);
  expect(readFileSync('dist/renderer/index.html', 'utf8')).toContain('<title>Moki</title>');
});

test('new profiles use Moki; legacy profiles are reused without touching encrypted bytes', () => fixture((dir) => {
  expect(userDataPath(dir)).toBe(join(dir, 'Moki'));
  const legacy = join(dir, 'povondra');
  mkdirSync(legacy);
  const encrypted = join(legacy, 'providers.encrypted');
  writeFileSync(encrypted, Buffer.from([0, 255, 12, 34]));
  expect(userDataPath(dir).toLowerCase()).toBe(legacy.toLowerCase());
  expect(readFileSync(encrypted)).toEqual(Buffer.from([0, 255, 12, 34]));
  expect(existsSync(join(dir, 'Moki'))).toBe(false);
  mkdirSync(join(dir, 'Moki'));
  expect(() => userDataPath(dir)).toThrow('Multiple app data profiles');
}));

test('existing SQLite WAL history is opened in place, not replaced by an empty Moki database', () => fixture((dir) => {
  expect(databasePath(dir)).toBe(join(dir, 'moki.sqlite'));
  const legacy = join(dir, 'povondra.sqlite');
  const db = new Database(legacy);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL, appearance TEXT);
    INSERT INTO assistants VALUES ('povondra', 'Povondra', 'deepseek', 'Keep my instructions', NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, assistantId TEXT NOT NULL REFERENCES assistants(id), title TEXT NOT NULL);
    INSERT INTO conversations VALUES ('old-chat', 'povondra', 'Keep my history');
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), text TEXT NOT NULL, assistantName TEXT);
    INSERT INTO messages VALUES ('old-message', 'old-chat', 'Saved text', 'Povondra');`);
  try {
    expect(existsSync(legacy + '-wal')).toBe(true);
    expect(databasePath(dir)).toBe(legacy);
    for (let i = 0; i < 2; i++) {
      const store = new Store(databasePath(dir));
      try {
        expect(store.snapshot().assistants).toHaveLength(1);
        expect(store.assistantFor('old-chat')).toMatchObject({ id: 'povondra', name: 'Moki', instructions: 'Keep my instructions' });
        expect(store.messages('old-chat')[0]).toMatchObject({ text: 'Saved text', assistantName: 'Povondra' });
      } finally { store.close(); }
    }
    expect(existsSync(join(dir, 'moki.sqlite'))).toBe(false);
    writeFileSync(join(dir, 'moki.sqlite'), '');
    expect(() => databasePath(dir)).toThrow('Multiple chat databases');
  } finally { db.close(); }
}));

test('custom legacy companion fields and avatars survive without an extra default companion', () => fixture((dir) => {
  const path = join(dir, 'legacy.sqlite');
  const appearance = { ...INITIAL_APPEARANCE, palette: 'mint', outfit: 'suit' } as const;
  const db = new Database(path);
  db.exec('CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL, appearance TEXT)');
  db.query('INSERT INTO assistants VALUES (?, ?, ?, ?, ?)').run('povondra', 'My friend', 'codex', 'Custom instructions', JSON.stringify(appearance));
  db.close();
  const store = new Store(path);
  try {
    expect(store.snapshot().assistants).toEqual([{ id: 'povondra', name: 'My friend', provider: 'codex', instructions: 'Custom instructions', appearance }]);
  } finally { store.close(); }
}));
