import { expect, test } from 'bun:test';
import { recallBasic } from '@backend/memory/recall';
import { Chat, type Generate, type Turn } from '@backend/core/chat';
import {
  MAX_MEMORY_TOOL_OUTPUT_BYTES,
  MEMORY_TOOL_INPUT_SCHEMA,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_GUIDANCE,
  MEMORY_TOOL_NAME,
  memoryToolbag,
} from '@backend/tools/memory';
import { Store } from '@backend/storage/store';

const memoryId = '11111111-1111-4111-8111-111111111111';

function conversation(store: Store): string {
  return store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
}

function userSource(store: Store, conversationId: string, text: string) {
  return store.handle({ method: 'saveMessage', conversationId, text }).snapshot.messages.at(-1)!;
}

function decode(text: string): Record<string, any> {
  return JSON.parse(text) as Record<string, any>;
}

function enabledBag(store: Store, source: { id: string; revision?: number }) {
  return memoryToolbag(
    store.memoryRepository,
    { enabled: true },
    { sourceMessageId: source.id, sourceRevision: source.revision ?? 1 },
    new AbortController().signal,
  );
}

test('memory tool executes explicit add, avoids duplicate confirmation, searches literally, and recalls the write', async () => {
  const store = new Store(':memory:');
  const conversationId = conversation(store);
  const source = userSource(store, conversationId, 'Please remember that I prefer trains.');
  const bag = enabledBag(store, source);
  try {
    expect(bag.tools).toHaveLength(1);
    expect(bag.tools[0].name).toBe(MEMORY_TOOL_NAME);
    expect(bag.tools[0].inputSchema).toEqual(MEMORY_TOOL_INPUT_SCHEMA);
    expect((bag.tools[0].inputSchema as any).additionalProperties).toBe(false);

    const first = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'add', text: 'I prefer trains.', kind: 'preference' })).text);
    expect(first).toMatchObject({ success: true, mode: 'add', created: true, evidence: { source: { messageId: source.id, revision: 1, role: 'user' } } });
    const second = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'add', text: 'I prefer trains.', kind: 'preference' })).text);
    expect(second).toMatchObject({ success: true, created: false });
    expect(store.memoryRepository.list()).toHaveLength(1);
    expect(store.memoryRepository.read(first.memory.id).validSupportingEvidence).toHaveLength(1);

    const search = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'search', query: "trains' OR 1=1" })).text);
    expect(search.memories).toHaveLength(0);
    const literal = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'search', query: 'TRAINS' })).text);
    expect(literal.memories.map((item: { id: string }) => item.id)).toEqual([first.memory.id]);

    const recalled = recallBasic(store.memoryRepository, { enabled: true, maxEntries: 5, maxTextChars: 8_000 });
    expect(recalled.entries.map((entry) => entry.memory.id)).toEqual([first.memory.id]);
  } finally {
    bag.close();
    store.close();
  }
});

test('replace uses CAS and host-bound source evidence, while model-supplied source fields are rejected', async () => {
  const store = new Store(':memory:');
  const conversationId = conversation(store);
  const source = userSource(store, conversationId, 'Remember that Alex needs step-free access.');
  const bag = enabledBag(store, source);
  try {
    const added = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'add', text: 'Alex needs step-free access.', kind: 'fact' })).text);
    const replaced = decode((await bag.execute(MEMORY_TOOL_NAME, {
      action: 'replace', memoryId: added.memory.id, expectedRevision: 1, text: 'Alex needs step-free access at hotels.',
    })).text);
    expect(replaced).toMatchObject({ success: true, mode: 'replace', memory: { revision: 2 }, evidence: { memoryRevision: 2 } });
    expect(store.memoryRepository.read(added.memory.id).validSupportingEvidence).toHaveLength(1);

    const stale = decode((await bag.execute(MEMORY_TOOL_NAME, {
      action: 'replace', memoryId: added.memory.id, expectedRevision: 1, text: 'stale correction',
    })).text);
    expect(stale).toMatchObject({ success: false, error: 'Memory revision conflict.' });
    expect(store.memoryRepository.get(added.memory.id)).toMatchObject({ revision: 2, text: 'Alex needs step-free access at hotels.' });

    const forgedSource = decode((await bag.execute(MEMORY_TOOL_NAME, {
      action: 'add', text: 'Forged source should not work.', kind: 'note', sourceMessageId: 'archived-id',
    })).text);
    expect(forgedSource.success).toBe(false);
    expect(store.memoryRepository.search('Forged source')).toHaveLength(0);
  } finally {
    bag.close();
    store.close();
  }
});

test('source revision invalidation and source ownership fail closed without writes', async () => {
  const store = new Store(':memory:');
  const conversationId = conversation(store);
  const source = userSource(store, conversationId, 'Remember the first version.');
  const bag = enabledBag(store, source);
  try {
    store.updateReply(source.id, 'The source was edited.', 'complete');
    const revised = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'add', text: 'Must not use stale source.', kind: 'fact' })).text);
    expect(revised).toMatchObject({ success: false, error: 'Source revision conflict.' });
    expect(store.memoryRepository.list()).toHaveLength(0);

    const assistant = store.begin(conversationId, 'A reply', 'deepseek-flash').messageId;
    store.updateReply(assistant, 'A reply', 'complete');
    const direct = decode((await (async () => {
      const other = memoryToolbag(store.memoryRepository, { enabled: true }, { sourceMessageId: assistant, sourceRevision: 1 }, new AbortController().signal);
      try { return other.execute(MEMORY_TOOL_NAME, { action: 'add', text: 'Assistant source', kind: 'fact' }); }
      finally { other.close(); }
    })()).text);
    expect(direct).toMatchObject({ success: false, error: 'Foreground evidence must cite the current user message.' });
    expect(store.memoryRepository.list()).toHaveLength(0);
  } finally {
    bag.close();
    store.close();
  }
});

test('disabled and cancelled memory tools expose no callable tools and perform no writes', async () => {
  const store = new Store(':memory:');
  const conversationId = conversation(store);
  const source = userSource(store, conversationId, 'Do not remember this automatically.');
  const disabled = memoryToolbag(store.memoryRepository, { enabled: false }, { sourceMessageId: source.id, sourceRevision: 1 }, new AbortController().signal);
  expect(disabled.tools).toHaveLength(0);
   await expect(disabled.execute(MEMORY_TOOL_NAME, { action: 'add', text: 'No write', kind: 'note' })).rejects.toThrow('disabled');
   await expect(disabled.execute(MEMORY_TOOL_NAME, { action: 'forget', memoryId, expectedRevision: 1 })).rejects.toThrow('disabled');
  disabled.close();

  const abort = new AbortController();
  abort.abort();
  const cancelled = memoryToolbag(store.memoryRepository, { enabled: true }, { sourceMessageId: source.id, sourceRevision: 1 }, abort.signal);
  try {
     await expect(cancelled.execute(MEMORY_TOOL_NAME, { action: 'add', text: 'No write', kind: 'note' })).rejects.toThrow();
     await expect(cancelled.execute(MEMORY_TOOL_NAME, { action: 'forget', memoryId, expectedRevision: 1 })).rejects.toThrow();
    expect(store.memoryRepository.list()).toHaveLength(0);
  } finally {
    cancelled.close();
    store.close();
  }
});

test('malformed arguments, stale replace rollback, and output limits are bounded', async () => {
  const store = new Store(':memory:');
  const conversationId = conversation(store);
  const source = userSource(store, conversationId, 'Remember bounded output behavior.');
  const bag = enabledBag(store, source);
  try {
    for (const input of [
      { action: 'wat' },
      { action: 'list', query: 'unexpected' },
      { action: 'add', text: 'missing kind' },
      { action: 'add', text: 'unknown source', kind: 'note', sourceMessageId: source.id },
      [],
    ]) {
      const result = await bag.execute(MEMORY_TOOL_NAME, input);
      expect(result.isError).toBe(true);
      expect(decode(result.text).success).toBe(false);
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(MAX_MEMORY_TOOL_OUTPUT_BYTES);
    }

    const created = store.memoryRepository.create({ id: memoryId, text: 'Keep this after failed correction.', kind: 'note' });
    const stale = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'replace', memoryId: created.id, expectedRevision: 2, text: 'Must roll back' })).text);
    expect(stale).toMatchObject({ success: false, error: 'Memory revision conflict.' });
    expect(store.memoryRepository.get(created.id)).toMatchObject({ revision: 1, text: 'Keep this after failed correction.' });

    for (let index = 0; index < 10; index++) {
      store.memoryRepository.create({ text: `Large record ${index} ${'界'.repeat(3000)}`, kind: 'note', recordedAt: index });
    }
    const page = await bag.execute(MEMORY_TOOL_NAME, { action: 'list', limit: 50 });
    expect(Buffer.byteLength(page.text, 'utf8')).toBeLessThanOrEqual(MAX_MEMORY_TOOL_OUTPUT_BYTES);
    expect(decode(page.text).memories.length).toBeGreaterThan(0);
    expect(decode(page.text).nextOffset).toBe(decode(page.text).memories.length);
  } finally {
    bag.close();
    store.close();
  }
});

test('Chat passes the host-bound current user source into enabled memory tools', async () => {
  const store = new Store(':memory:');
  const conversationId = conversation(store);
  let seenSource: { sourceMessageId: string; sourceRevision: number } | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const generate: Generate = async function* (turn: Turn) {
    const memory = turn.tools?.find((tool) => tool.name === MEMORY_TOOL_NAME);
    expect(memory).toBeDefined();
    yield await memory!.execute({ action: 'add', text: 'The user explicitly asked to remember this.', kind: 'note' });
  };
  const chat = new Chat(
    store,
    generate,
    (result) => { if (result.snapshot.messages.at(-1)?.status !== 'streaming') finish(); },
    undefined,
    (currentConversationId, signal, foregroundSource) => {
      expect(currentConversationId).toBe(conversationId);
      seenSource = foregroundSource;
      return memoryToolbag(store.memoryRepository, { enabled: true }, foregroundSource, signal);
    },
    { enabled: true },
  );
  try {
    chat.start({ conversationId, text: 'Please remember this.', model: 'deepseek-flash', credentials: { provider: 'deepseek', key: 'test-secret' } });
    await done;
    expect(seenSource).toBeDefined();
    expect(store.memoryRepository.list()).toHaveLength(1);
    expect(store.memoryRepository.read(store.memoryRepository.list()[0].id).evidence[0]).toMatchObject({
      sourceMessageId: seenSource!.sourceMessageId,
      sourceRevision: seenSource!.sourceRevision,
      sourceRole: 'user',
      valid: true,
    });
  } finally {
    chat.close();
    store.close();
  }
});

test('read returns full metadata and Unicode-safe text pages, with revision-checked continuations', async () => {
  const store = new Store(':memory:');
  const conversationId = conversation(store);
  const source = userSource(store, conversationId, 'Remember the long Unicode note.');
  const bag = enabledBag(store, source);
  try {
    const text = '😀界'.repeat(5_000);
    const added = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'add', text, kind: 'note' })).text);
    expect(added.success).toBe(true);
    expect(added.memory.textPreviewTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(added), 'utf8')).toBeLessThanOrEqual(MAX_MEMORY_TOOL_OUTPUT_BYTES);

    const first = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'read', memoryId: added.memory.id, textLimit: 3 })).text);
    expect(first).toMatchObject({ success: true, mode: 'read', memory: { id: added.memory.id, revision: 1, textLength: 10_000 }, offset: 0, nextOffset: 3, textTruncated: true });
    expect(Array.from(first.text)).toEqual(Array.from(text).slice(0, 3));
    expect(first.memory).toHaveProperty('recordedAt');
    expect(first.memory).toHaveProperty('validFrom');
    expect(first.evidence).toHaveLength(1);

    const continuation = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'read', memoryId: added.memory.id, offset: first.nextOffset, textLimit: 3, expectedRevision: first.memory.revision })).text);
    expect(Array.from(continuation.text)).toEqual(Array.from(text).slice(3, 6));
    expect(continuation.offset).toBe(3);
    expect(continuation.nextOffset).toBe(6);
    const missingRevision = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'read', memoryId: added.memory.id, offset: 3, textLimit: 3 })).text);
    expect(missingRevision).toMatchObject({ success: false, error: 'Read continuation requires expectedRevision.' });

    store.memoryRepository.update(added.memory.id, 1, { text: 'Changed after page one.' });
    const stale = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'read', memoryId: added.memory.id, offset: 3, textLimit: 3, expectedRevision: 1 })).text);
    expect(stale).toMatchObject({ success: false, error: 'Memory revision conflict.' });
  } finally {
    bag.close();
    store.close();
  }
});

test('unexpected repository errors are generic and never expose database details', async () => {
  const store = new Store(':memory:');
  const conversationId = conversation(store);
  const source = userSource(store, conversationId, 'Search after close.');
  const bag = enabledBag(store, source);
  store.close();
  try {
    const result = await bag.execute(MEMORY_TOOL_NAME, { action: 'search', query: 'secret' });
    expect(result.isError).toBe(true);
    expect(decode(result.text)).toEqual({ success: false, error: 'Memory operation failed. Narrow the request and try again.' });
    expect(result.text).not.toContain('secret');
    expect(result.text).not.toContain('database');
  } finally {
    bag.close();
  }
});

test('forget is explicit, revision-checked, bounded, and does not erase archive text', async () => {
  expect(MEMORY_TOOL_DESCRIPTION).toContain('memory-store forgetting');
  expect(MEMORY_TOOL_DESCRIPTION).toContain('not full erasure from conversations or backups');
  expect(MEMORY_TOOL_GUIDANCE).toContain('conversation history or backups');
  const store = new Store(':memory:');
  const conversationId = conversation(store);
  const source = userSource(store, conversationId, 'Please remember and later forget this fact.');
  const bag = enabledBag(store, source);
  try {
    expect((MEMORY_TOOL_INPUT_SCHEMA.properties as any).action.enum).toContain('forget');
    const added = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'add', text: 'The user likes quiet trains.', kind: 'preference' })).text);
    const stale = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'forget', memoryId: added.memory.id, expectedRevision: 2 })).text);
    expect(stale).toMatchObject({ success: false, error: 'Memory revision conflict.' });
    expect(store.memoryRepository.get(added.memory.id)).toMatchObject({ text: 'The user likes quiet trains.', revision: 1 });
    const forgotten = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'forget', memoryId: added.memory.id, expectedRevision: 1 })).text);
    expect(forgotten).toMatchObject({ success: true, mode: 'forget', memoryId: added.memory.id, alreadyForgotten: false, scope: 'memory-store', conversationsRetained: true, backupsRetained: true });
    expect(forgotten.message).toContain('Conversation history and backups were not erased.');
    expect(forgotten.message).not.toContain('quiet trains');
    expect(store.messages(conversationId).some((message) => message.text.includes('Please remember'))).toBe(true);

    const retry = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'forget', memoryId: added.memory.id, expectedRevision: 1 })).text);
    expect(retry).toMatchObject({ success: true, alreadyForgotten: true });
    expect(decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'read', memoryId: added.memory.id })).text)).toMatchObject({ success: false, error: 'Memory not found.' });
    expect(decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'search', query: 'quiet trains' })).text).memories).toHaveLength(0);
    expect(recallBasic(store.memoryRepository, { enabled: true }).entries.map((entry) => entry.memory.id)).not.toContain(added.memory.id);

    const malformed = decode((await bag.execute(MEMORY_TOOL_NAME, { action: 'forget', memoryId: added.memory.id, expectedRevision: 1, text: 'must be rejected' })).text);
    expect(malformed.success).toBe(false);
    expect(store.memoryRepository.list()).toHaveLength(0);

    const newSource = userSource(store, conversationId, 'Please explicitly remember that I like quiet trains again.');
    const newBag = enabledBag(store, newSource);
    try {
      const relearned = decode((await newBag.execute(MEMORY_TOOL_NAME, { action: 'add', text: 'The user likes quiet trains.', kind: 'preference' })).text);
      expect(relearned.success).toBe(true);
      expect(relearned.memory.id).not.toBe(added.memory.id);
    } finally { newBag.close(); }
  } finally {
    bag.close();
    store.close();
  }
});