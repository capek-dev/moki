import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@backend/store';

// The messages schema exactly as older Moki versions created it, before the
// plan 28 provenance columns existed.
function legacyDatabase(path: string) {
  const db = new Database(path);
  db.exec(`CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, assistantId TEXT NOT NULL REFERENCES assistants(id), title TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), text TEXT NOT NULL);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, mime TEXT NOT NULL, byteSize INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, storageName TEXT NOT NULL);
    INSERT INTO assistants VALUES ('moki', 'Moki', 'deepseek', 'Be helpful.');
    INSERT INTO conversations VALUES ('c1', 'moki', 'Legacy talk');
    INSERT INTO messages VALUES ('m1', 'c1', 'first'), ('m2', 'c1', 'second');
    INSERT INTO attachments VALUES ('a1', 'm1', 'image/png', 24, 320, 180, 'a1.png');`);
  db.close();
}

test('upgrading a legacy database preserves rows, order, conversations, attachments, and unknown dates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-provenance-'));
  const path = join(dir, 'legacy.sqlite');
  legacyDatabase(path);
  try {
    const store = new Store(path);
    try {
      expect(store.conversation('c1')).toMatchObject({ assistantId: 'moki', title: 'Legacy talk' });
      const messages = store.messages('c1');
      expect(messages.map((m) => [m.text, m.role, m.status])).toEqual([['first', 'user', 'complete'], ['second', 'user', 'complete']]);
      // Legacy creation dates stay explicitly unknown; existing content counts
      // as the first tracked revision.
      expect(messages.map((m) => m.createdAt)).toEqual([null, null]);
      expect(messages.map((m) => m.revision)).toEqual([1, 1]);
      expect(store.attachmentsFor(messages)).toEqual([{ id: 'a1', messageId: 'm1', mime: 'image/png', byteSize: 24, width: 320, height: 180 }]);
      // New traffic on the upgraded store coexists with unstamped legacy rows.
      const before = Date.now();
      store.begin('c1', 'New', 'deepseek-flash');
      const mixed = store.messages('c1');
      expect(mixed).toHaveLength(4);
      expect(mixed[0].createdAt).toBeNull();
      expect(mixed[2].createdAt).toBeGreaterThanOrEqual(before);
      expect(mixed[2].revision).toBe(1);
      // Overwriting a legacy row bumps its revision but never invents a date.
      store.updateReply('m2', 'second, corrected', 'complete');
      const corrected = store.messages('c1').find((m) => m.id === 'm2')!;
      expect(corrected.revision).toBe(2);
      expect(corrected.createdAt).toBeNull();
    } finally { store.close(); }
    // Reopening re-runs the migration as a no-op without resetting values.
    const reopened = new Store(path);
    try { expect(reopened.messages('c1').find((m) => m.id === 'm2')).toMatchObject({ revision: 2, createdAt: null }); } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real write paths stamp creation time and keep revision 1 through a reply', () => {
  const store = new Store(':memory:');
  try {
    const before = Date.now();
    const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
    const { messageId } = store.begin(id, 'Hello', 'deepseek-flash');
    store.updateReply(messageId, 'partial', 'streaming');
    store.updateReply(messageId, 'full reply', 'complete');
    const after = Date.now();
    const [user, assistant] = store.messages(id);
    for (const message of [user, assistant]) {
      expect(message.createdAt).toBeGreaterThanOrEqual(before);
      expect(message.createdAt).toBeLessThanOrEqual(after);
      expect(message.revision).toBe(1);
    }
    // The saveMessage route (no reply) is stamped the same way.
    store.handle({ method: 'saveMessage', conversationId: id, text: 'Saved note' });
    const saved = store.messages(id).at(-1)!;
    expect(saved.role).toBe('user');
    expect(saved.revision).toBe(1);
    expect(saved.createdAt).toBeGreaterThanOrEqual(after);
    // Edit-resend removes the old tail; the replacement rows start fresh.
    const edited = store.begin(id, 'Hello edited', 'deepseek-flash', null, [], user.id);
    store.updateReply(edited.messageId, 'fresh reply', 'complete');
    const rows = store.messages(id);
    expect(rows.map((m) => [m.text, m.revision])).toEqual([['Hello edited', 1], ['fresh reply', 1]]);
    expect(rows.map((m) => m.createdAt)).not.toContain(null);
  } finally { store.close(); }
});

test('overwriting published content bumps the revision; streaming and unknown ids do not', () => {
  const store = new Store(':memory:');
  try {
    const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
    const { messageId } = store.begin(id, 'Hi', 'deepseek-flash');
    const reply = () => store.messages(id)[1];
    for (let chunk = 0; chunk < 3; chunk++) store.updateReply(messageId, `chunk ${chunk}`, 'streaming');
    expect(reply()).toMatchObject({ status: 'streaming', revision: 1 });
    // The first terminal write publishes revision 1; streaming never counted.
    store.updateReply(messageId, 'published', 'complete');
    expect(reply().revision).toBe(1);
    // Any later rewrite of a non-streaming row is a new content version.
    store.updateReply(messageId, 'published, corrected', 'complete');
    expect(reply().revision).toBe(2);
    store.updateReply(messageId, 'published, corrected again', 'interrupted');
    expect(reply().revision).toBe(3);
    // Unknown ids stay silent no-ops, as before this slice.
    expect(() => store.updateReply('missing', 'x', 'complete')).not.toThrow();
  } finally { store.close(); }
});
