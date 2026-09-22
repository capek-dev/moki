import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preMigrationBackupPath } from '@backend/storage/migration-backup';
import { Store } from '@backend/storage/store';

function withStore(run: (store: Store) => void) {
  const store = new Store(':memory:');
  try { run(store); } finally { store.close(); }
}

function newConversation(store: Store): string {
  return store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
}

function save(store: Store, conversationId: string, text: string): string {
  store.handle({ method: 'saveMessage', conversationId, text });
  return store.messages(conversationId).at(-1)!.id;
}

test('searches persisted history beyond the UI window with scopes, role filters, snippets, and pagination', () => withStore((store) => {
  const first = newConversation(store);
  const second = newConversation(store);
  const ids: string[] = [];
  for (let index = 0; index < 120; index++) ids.push(save(store, first, `needle archive row ${index}`));
  save(store, second, 'needle in the other conversation');

  const old = store.sessionSearchRepository.search({ query: 'needle archive row 0', limit: 5 });
  expect(old.results).toHaveLength(1);
  expect(old.results[0]).toMatchObject({ id: ids[0], conversationId: first, role: 'user', revision: 1 });
  expect(old.results[0].createdAt).toEqual(expect.any(Number));
  expect(old.results[0].snippet.length).toBeLessThanOrEqual(320);

  const scoped = store.sessionSearchRepository.search({
    query: 'needle',
    scope: { kind: 'conversation', conversationId: second },
  });
  expect(scoped.results.map((row) => row.conversationId)).toEqual([second]);
  expect(() => store.sessionSearchRepository.search({ query: 'needle', scope: { kind: 'conversation', conversationId: 'missing' } })).toThrow('Conversation not found');
  expect(() => store.sessionSearchRepository.search({ query: 'needle', roles: ['tool' as never] })).toThrow('Invalid roles');

  const pages: string[] = [];
  let cursor: number | null = null;
  do {
    const page = store.sessionSearchRepository.search({ query: 'needle archive', limit: 7, cursor });
    pages.push(...page.results.map((row) => row.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  expect(pages).toHaveLength(120);
  expect(new Set(pages).size).toBe(120);
  expect(pages).toEqual(ids.slice().reverse());

  const assistant = store.begin(first, 'assistant source', 'deepseek-flash');
  store.updateReply(assistant.messageId, 'needle assistant source', 'complete');
  expect(store.sessionSearchRepository.search({ query: 'needle assistant', roles: ['assistant'] }).results[0]).toMatchObject({
    id: assistant.messageId,
    role: 'assistant',
  });
  expect(store.sessionSearchRepository.search({ query: 'needle assistant', roles: ['user'] }).results).toHaveLength(0);
}));

test('quotes, punctuation, malformed FTS input, and output bounds are handled as literals', () => withStore((store) => {
  const conversationId = newConversation(store);
  const messageId = save(store, conversationId, `C++ quote "needle" ${'long '.repeat(400)}`);
  expect(store.sessionSearchRepository.search({ query: 'C++' }).results[0].id).toBe(messageId);
  expect(store.sessionSearchRepository.search({ query: '"needle"' }).results[0].id).toBe(messageId);
  expect(() => store.sessionSearchRepository.search({ query: '"needle' })).not.toThrow();
  expect(() => store.sessionSearchRepository.search({ query: 'needle OR *' })).not.toThrow();
  expect(() => store.sessionSearchRepository.search({ query: String.fromCharCode(0) })).not.toThrow();
  const bounded = store.sessionSearchRepository.search({ query: 'needle' });
  expect(bounded.results[0].snippet.length).toBeLessThanOrEqual(320);
  expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(24_000);
  expect(() => store.sessionSearchRepository.search({ query: '!!!' })).not.toThrow();
}));

test('list pagination and read-around are deterministic and include unknown timestamps', () => withStore((store) => {
  const conversationId = newConversation(store);
  const ids: string[] = [];
  for (let index = 0; index < 8; index++) ids.push(save(store, conversationId, `context ${index}`));
  const anchor = ids[4];
  const around = store.sessionSearchRepository.readAround({ anchorMessageId: anchor, before: 2, after: 2 });
  expect(around.anchor).toMatchObject({ id: anchor, role: 'user', revision: 1 });
  expect(around.results.map((row) => row.id)).toEqual(ids.slice(2, 7));
  const zeroSides = store.sessionSearchRepository.readAround({ anchorMessageId: anchor, conversationId, before: 0, after: 0 });
  expect(zeroSides.results.map((row) => row.id)).toEqual([anchor]);
  expect(() => store.sessionSearchRepository.readAround({ anchorMessageId: anchor, conversationId: 'wrong' })).toThrow('Anchor message not found');
  expect(() => store.sessionSearchRepository.readAround({ anchorMessageId: anchor, roles: [] })).toThrow('Invalid roles');

  const longId = save(store, conversationId, `head ${'😀'.repeat(7_000)} tail`);
  const textPages: string[] = [];
  let textOffset = 0;
  let textPage = store.sessionSearchRepository.readMessageText(longId, { conversationId, offset: textOffset, limit: 8_000 });
  do {
    expect(Buffer.byteLength(JSON.stringify(textPage), 'utf8')).toBeLessThanOrEqual(24_000);
    expect(textPage.revision).toBe(1);
    expect(textPage.truncated).toBe(textPage.nextOffset !== null);
    textPages.push(textPage.text);
    if (textPage.nextOffset === null) break;
    textOffset = textPage.nextOffset;
    textPage = store.sessionSearchRepository.readMessageText(longId, { conversationId, offset: textOffset, limit: 8_000 });
  } while (true);
  expect(textPages.join('')).toBe(`head ${'😀'.repeat(7_000)} tail`);
  expect(textPages.at(-1)).toContain('tail');
  expect(() => store.sessionSearchRepository.readMessageText(longId, { conversationId: 'wrong' })).toThrow('Message not found');

  for (let index = 0; index < 105; index++) newConversation(store);
  const listed: string[] = [];
  let cursor: number | null = null;
  do {
    const page = store.sessionSearchRepository.listConversations({ limit: 11, cursor });
    listed.push(...page.results.map((row) => row.id));
    expect(page.results.length).toBeLessThanOrEqual(11);
    cursor = page.nextCursor;
  } while (cursor !== null);
  expect(listed).toHaveLength(106);
  expect(new Set(listed).size).toBe(106);
  expect(store.sessionSearchRepository.listConversations({ limit: 1 }).results[0].latestMessageAt).toBeNull();
}));

test('streaming, tool-call metadata, edits, unsend, and reopen keep the derived index correct', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-session-search-'));
  const path = join(dir, 'archive.sqlite');
  const store = new Store(path);
  try {
    const conversationId = newConversation(store);
    const reply = store.begin(conversationId, 'index source', 'deepseek-flash');
    store.updateReply(reply.messageId, 'provisional hidden needle', 'streaming', null, [{ name: 'tool', label: 'tool', detail: 'secret', summary: 'secret output', status: 'running', at: 1 }]);
    expect(store.sessionSearchRepository.search({ query: 'provisional' }).results).toHaveLength(0);
    expect(store.sessionSearchRepository.search({ query: 'secret' }).results).toHaveLength(0);
    store.updateReply(reply.messageId, 'published needle', 'complete', null, [{ name: 'tool', label: 'tool', detail: 'secret', summary: 'secret output', status: 'ok', at: 1 }]);
    const published = store.sessionSearchRepository.search({ query: 'published' }).results[0];
    expect(published).toMatchObject({ id: reply.messageId, revision: 1 });
    store.updateReply(reply.messageId, 'corrected needle', 'complete');
    expect(store.sessionSearchRepository.search({ query: 'published' }).results).toHaveLength(0);
    expect(store.sessionSearchRepository.search({ query: 'corrected' }).results[0]).toMatchObject({ id: reply.messageId, revision: 2 });

    const userId = store.messages(conversationId)[0].id;
    store.revertMessages(conversationId, userId);
    expect(store.sessionSearchRepository.search({ query: 'corrected' }).results).toHaveLength(0);
  } finally { store.close(); }
  try {
    const reopened = new Store(path);
    try { expect(reopened.sessionSearchRepository.search({ query: 'corrected' }).results).toHaveLength(0); }
    finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('upgrade backfills an existing archive and preserves null legacy dates after reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-session-search-legacy-'));
  const path = join(dir, 'archive.sqlite');
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, assistantId TEXT NOT NULL REFERENCES assistants(id), title TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), text TEXT NOT NULL);
    INSERT INTO assistants VALUES ('moki', 'Moki', 'deepseek', 'Be helpful.');
    INSERT INTO conversations VALUES ('legacy-conversation', 'moki', 'Legacy');
    INSERT INTO messages VALUES ('legacy-message', 'legacy-conversation', 'backfill needle');
  `);
  legacy.close();
  try {
    const store = new Store(path);
    try {
      expect(store.sessionSearchRepository.search({ query: 'backfill' }).results[0]).toMatchObject({ id: 'legacy-message', createdAt: null, revision: 1 });
    } finally { store.close(); }
    const reopened = new Store(path);
    try {
      expect(reopened.sessionSearchRepository.search({ query: 'backfill' }).results[0].createdAt).toBeNull();
      expect(reopened.sessionSearchRepository.readMessageText('legacy-message')).toMatchObject({ role: 'user', createdAt: null });
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a prior plan 28 database upgrades its derived search index without replacing the original backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-session-search-plan28-'));
  const path = join(dir, 'archive.sqlite');
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, assistantId TEXT NOT NULL REFERENCES assistants(id), title TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), text TEXT NOT NULL);
    INSERT INTO assistants VALUES ('moki', 'Moki', 'deepseek', 'Be helpful.');
    INSERT INTO conversations VALUES ('legacy-conversation', 'moki', 'Legacy');
    INSERT INTO messages VALUES ('legacy-message', 'legacy-conversation', 'search upgrade needle');
  `);
  legacy.close();
  try {
    const first = new Store(path);
    first.close();
    const backupPath = preMigrationBackupPath(path);
    const originalBackup = readFileSync(backupPath);
    const originalMtime = statSync(backupPath).mtimeMs;

    const priorPlan28 = new Database(path);
    priorPlan28.exec('DROP TABLE session_message_fts; DROP TABLE session_search_meta;');
    priorPlan28.close();

    const upgraded = new Store(path);
    try {
      expect(upgraded.sessionSearchRepository.search({ query: 'upgrade' }).results[0]).toMatchObject({ id: 'legacy-message' });
    } finally { upgraded.close(); }
    expect(readFileSync(backupPath)).toEqual(originalBackup);
    expect(statSync(backupPath).mtimeMs).toBe(originalMtime);

    const reopened = new Store(path);
    try { expect(reopened.sessionSearchRepository.search({ query: 'needle' }).results[0].id).toBe('legacy-message'); }
    finally { reopened.close(); }
    expect(readFileSync(backupPath)).toEqual(originalBackup);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('database failures are surfaced instead of becoming empty successful searches', () => {
  const store = new Store(':memory:');
  const repository = store.sessionSearchRepository;
  store.close();
  expect(() => repository.search({ query: 'anything' })).toThrow();
});
