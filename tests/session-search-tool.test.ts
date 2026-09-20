import { expect, test } from 'bun:test';
import { Store } from '@backend/store';
import { Chat, type Generate, type Turn } from '@backend/chat';
import { smartToolbag } from '@backend/tool-scoring';
import { sessionSearchToolbag, SESSION_SEARCH_INPUT_SCHEMA, SESSION_SEARCH_TOOL_NAME, SESSION_SEARCH_GUIDANCE } from '@backend/session-search-tool';
import { MAX_SESSION_SEARCH_OUTPUT_BYTES } from '@backend/session-search-repository';
import type { Toolbag } from '@backend/cua';

const credentials = { provider: 'deepseek' as const, key: 'test-secret' };


function conversation(store: Store): string {
  return store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
}

function save(store: Store, conversationId: string, value: string): string {
  store.handle({ method: 'saveMessage', conversationId, text: value });
  return store.messages(conversationId).at(-1)!.id;
}

function decode(text: string): Record<string, any> {
  return JSON.parse(text) as Record<string, any>;
}

test('built-in session_search exposes the documented actions and uses the host-bound current conversation', async () => {
  const store = new Store(':memory:');
  const current = conversation(store);
  const other = conversation(store);
  const currentId = save(store, current, 'current archive needle');
  save(store, other, 'other archive needle');
  const abort = new AbortController();
  const bag = sessionSearchToolbag(store.sessionSearchRepository, current, abort.signal);
  try {
    expect(bag.tools).toHaveLength(1);
    expect(bag.tools[0].name).toBe(SESSION_SEARCH_TOOL_NAME);
    expect(bag.tools[0].inputSchema).toEqual(SESSION_SEARCH_INPUT_SCHEMA);
    expect((bag.tools[0].inputSchema as any).additionalProperties).toBe(false);
    expect((bag.tools[0].inputSchema as any).properties.cursor.type).toEqual(['integer', 'null']);

    const listed = decode((await bag.execute(SESSION_SEARCH_TOOL_NAME, { action: 'list', scope: 'current_conversation' })).text);
    expect(listed.sessions.map((session: { id: string }) => session.id)).toEqual([current]);
    const searched = decode((await bag.execute(SESSION_SEARCH_TOOL_NAME, { action: 'search', query: 'needle', scope: 'current_conversation' })).text);
    expect(searched.results.map((result: { id: string }) => result.id)).toEqual([currentId]);
    const archive = decode((await bag.execute(SESSION_SEARCH_TOOL_NAME, { action: 'search', query: 'needle', scope: 'archive' })).text);
    expect(archive.results).toHaveLength(2);
  } finally {
    bag.close();
    store.close();
  }
});

test('read supports latest context, archive session IDs, and Unicode-safe long-message continuation', async () => {
  const store = new Store(':memory:');
  const current = conversation(store);
  const other = conversation(store);
  const firstCurrentId = save(store, current, 'first current context');
  const secondCurrentId = save(store, current, 'second current context');
  const currentId = save(store, current, 'current context');
  const otherId = save(store, other, `head ${'😀'.repeat(10)} tail`);
  const bag = sessionSearchToolbag(store.sessionSearchRepository, current, new AbortController().signal);
  const latest = decode((await bag.execute(SESSION_SEARCH_TOOL_NAME, { action: 'read', scope: 'current_conversation', window: 3 })).text);
  expect(latest.messages.map((message: { id: string }) => message.id)).toEqual([firstCurrentId, secondCurrentId, currentId]);
  expect(latest.messages[0].id).toBe(firstCurrentId);
  const first = decode((await bag.execute(SESSION_SEARCH_TOOL_NAME, { action: 'read', sessionId: other, messageId: otherId, textLimit: 4 })).text);
  expect(first.text).toBe('head');
  expect(first.role).toBe('user');
  expect(first.createdAt).toEqual(expect.any(Number));
  expect(first.nextOffset).toBe(4);
  const second = decode((await bag.execute(SESSION_SEARCH_TOOL_NAME, { action: 'read', sessionId: other, messageId: otherId, offset: first.nextOffset, textLimit: 20 })).text);
  expect(second.text).toContain('😀');
  expect(second.nextOffset).toBeNull();
  const escaped = decode((await bag.execute(SESSION_SEARCH_TOOL_NAME, { action: 'read', scope: 'current_conversation', sessionId: other })).text);
  expect(escaped.success).toBe(false);
  expect(escaped.error).toContain('bound');
  bag.close();
  store.close();
});

test('read rejects incompatible fields and returns actionable validation errors', async () => {
  const store = new Store(':memory:');
  const current = conversation(store);
  const messageId = save(store, current, 'needle');
  const bag = sessionSearchToolbag(store.sessionSearchRepository, current, new AbortController().signal);
  try {
    const cases = [
      [{ action: 'read', sessionId: current, limit: 1 }, 'Read does not accept search fields.'],
      [{ action: 'read', sessionId: current, messageId, window: 1 }, 'Long-message reads accept messageId, offset, and textLimit only.'],
      [{ action: 'read', sessionId: current, messageId, limit: 1, textLimit: 2 }, 'Read does not accept search fields.'],
      [{ action: 'read', sessionId: current, textLimit: 2 }, 'offset and textLimit require messageId.'],
      [{ action: 'read', sessionId: current, limit: null }, 'Read does not accept search fields.'],
    ] as const;
    for (const [input, message] of cases) {
      const result = await bag.execute(SESSION_SEARCH_TOOL_NAME, input);
      expect(result.isError).toBe(true);
      expect(decode(result.text)).toMatchObject({ success: false, error: message });
    }
    const firstPage = await bag.execute(SESSION_SEARCH_TOOL_NAME, { action: 'list', cursor: null });
    expect(firstPage.isError).toBe(false);
  } finally {
    bag.close();
    store.close();
  }
});

test('malformed inputs are denied and successful or error wrappers stay bounded', async () => {
  const store = new Store(':memory:');
  const current = conversation(store);
  save(store, current, 'needle');
  const bag = sessionSearchToolbag(store.sessionSearchRepository, current, new AbortController().signal);
  try {
    for (const input of [
      { action: 'wat' },
      { action: 'search', query: 'needle', extra: true },
      { action: 'search', query: 4 },
      { action: 'list', query: 'unexpected' },
      { action: 'read', scope: 'current_conversation', aroundMessageId: 'x', messageId: 'y' },
      [],
    ]) {
      const result = await bag.execute(SESSION_SEARCH_TOOL_NAME, input);
      expect(result.isError).toBe(true);
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(MAX_SESSION_SEARCH_OUTPUT_BYTES);
      expect(decode(result.text).success).toBe(false);
    }

    for (let index = 0; index < 50; index++) save(store, current, `needle ${'界'.repeat(500)}`);
    const bounded = await bag.execute(SESSION_SEARCH_TOOL_NAME, { action: 'search', query: 'needle', limit: 50 });
    expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(MAX_SESSION_SEARCH_OUTPUT_BYTES);
  } finally {
    bag.close();
    store.close();
  }
});

test('unexpected repository failures return a bounded generic error', async () => {
  const store = new Store(':memory:');
  const current = conversation(store);
  save(store, current, 'needle');
  const bag = sessionSearchToolbag(store.sessionSearchRepository, current, new AbortController().signal);
  store.close();
  const result = await bag.execute(SESSION_SEARCH_TOOL_NAME, { action: 'search', query: 'needle' });
  expect(result.isError).toBe(true);
  expect(decode(result.text)).toEqual({ success: false, error: 'Session search failed. Narrow the request and try again.' });
  bag.close();
});

test('cancellation stops the built-in tool before repository work', async () => {
  const store = new Store(':memory:');
  const current = conversation(store);
  save(store, current, 'needle');
  const abort = new AbortController();
  abort.abort();
  const bag = sessionSearchToolbag(store.sessionSearchRepository, current, abort.signal);
  try {
    await expect(bag.execute(SESSION_SEARCH_TOOL_NAME, { action: 'search', query: 'needle' })).rejects.toThrow();
  } finally {
    bag.close();
    store.close();
  }
});

function chatWithBuiltIn(
  store: Store,
  current: string,
  generate: Generate,
  external?: (signal: AbortSignal) => Promise<Toolbag>,
) {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const chat = new Chat(
    store,
    generate,
    (result) => { if (result.snapshot.messages.at(-1)?.status !== 'streaming') finish(); },
    external ? async (signal) => external(signal) : undefined,
    (conversationId, signal) => sessionSearchToolbag(store.sessionSearchRepository, conversationId, signal),
  );
  chat.start({ conversationId: current, text: 'Recall this', model: 'deepseek-flash', credentials });
  return { chat, done };
}

test('chat keeps session_search available when external tools fail or are disabled, and applies minimal guidance', async () => {
  const store = new Store(':memory:');
  const current = conversation(store);
  save(store, current, 'historical needle');
  const seen: string[][] = [];
  const instructions: string[] = [];
  const generate: Generate = async function* (turn: Turn) {
    seen.push(turn.tools?.map((tool) => tool.name) ?? []);
    instructions.push(turn.instructions);
    const search = turn.tools?.find((tool) => tool.name === SESSION_SEARCH_TOOL_NAME);
    expect(search).toBeDefined();
    yield await search!.execute({ action: 'search', query: 'needle', scope: 'current_conversation' });
  };
  try {
    const failed = chatWithBuiltIn(store, current, generate, async () => { throw new Error('external unavailable'); });
    await failed.done;
    const disabled = chatWithBuiltIn(store, current, generate, async (signal) => smartToolbag([{
      tools: [{ name: 'external_action', description: 'External action', inputSchema: { type: 'object' } }],
      execute: async () => ({ text: 'external', isError: false }),
      close: () => {},
    }], { request: 'Recall this', recent: '' }, { enabled: false, maxDirect: 12 }, signal));
    await disabled.done;
    expect(seen[0]).toEqual([SESSION_SEARCH_TOOL_NAME]);
    expect(seen[1]).toContain(SESSION_SEARCH_TOOL_NAME);
    expect(seen[1]).toContain('search_tools');
    expect(instructions.every((text) => text.includes(SESSION_SEARCH_GUIDANCE))).toBe(true);
    failed.chat.close();
    disabled.chat.close();
  } finally {
    store.close();
  }
});

test('built-in session_search wins an external name collision without changing external routing', async () => {
  const store = new Store(':memory:');
  const current = conversation(store);
  save(store, current, 'local needle');
  let externalCalls = 0;
  const external: Toolbag = {
    tools: [{ name: SESSION_SEARCH_TOOL_NAME, description: 'foreign session search', inputSchema: { type: 'object' } }],
    execute: async () => { externalCalls++; return { text: 'foreign', isError: false }; },
    close: () => {},
  };
  let seen!: string[];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const chat = new Chat(store, async function* (turn) {
    seen = turn.tools?.map((tool) => tool.name) ?? [];
    const tool = turn.tools!.find((entry) => entry.name === SESSION_SEARCH_TOOL_NAME)!;
    yield await tool.execute({ action: 'search', query: 'needle', scope: 'current_conversation' });
  }, (result) => { if (result.snapshot.messages.at(-1)?.status !== 'streaming') finish(); }, async () => external,
  (conversationId, signal) => sessionSearchToolbag(store.sessionSearchRepository, conversationId, signal));
  try {
    await (chat.start({ conversationId: current, text: 'Recall', model: 'deepseek-flash', credentials }), done);
    expect(seen).toEqual([SESSION_SEARCH_TOOL_NAME]);
    expect(externalCalls).toBe(0);
  } finally {
    chat.close();
    store.close();
  }
});
