import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolLoadingSettings } from '../src/electron/tool-loading';
import { Chat } from '@backend/core/chat';
import { Store } from '@backend/storage/store';
import { smartToolbag } from '@backend/tools/scoring';
import type { Toolbag } from '@backend/integrations/cua';

// Native safeStorage and HTTP are boundary fakes. Settings persistence, Chat,
// SDK request serialization, allocation, execution and diagnostic output are real.
test('saved key survives reopen and drives per-turn selection with actual terminal diagnostics', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moki-selection-integration-'));
  const path = join(directory, 'tool-loading.encrypted');
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
    decryptString: (value: Buffer) => value.toString().split('').reverse().join(''),
  };
  const key = 'integration-fixture-key';
  const store = new Store(':memory:');
  const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  const lines: string[] = [];
  const originalError = console.error;
  const logging = spyOn(console, 'error').mockImplementation((...args) => {
    lines.push(args.join(' '));
    originalError(...args);
  });
  let requests = 0;
  let closed = 0;
  const executed: string[] = [];
  const nativeToolNames: string[][] = [];
  const nativeToolPayloads: string[] = [];
  const modelMessages: string[][] = [];
  let finished!: () => void;
  const bag: Toolbag = {
    tools: ['email__find', 'drive__upload', 'calendar__list'].map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
    execute: async name => { executed.push(name); return { text: 'ok', isError: false }; },
    close: () => { closed++; },
  };
  const chat = new Chat(store, async function* (turn) {
    const expected = requests === 1 ? 'email__find' : 'drive__upload';
    nativeToolNames.push(turn.tools!.map(tool => tool.name));
    nativeToolPayloads.push(JSON.stringify(turn.tools));
    modelMessages.push(turn.messages.filter(message => message.role === 'user').map(message => String(message.content)));
    const call = turn.tools!.find((tool) => tool.name === 'call_tool')!;
    yield await call.execute({ name: expected, arguments: {} });
  }, result => { if (result.snapshot.messages.at(-1)?.status !== 'streaming') finished(); },
  (signal, evidence, policy) => smartToolbag([bag], evidence, policy!, signal, {
    fetch: async (_url, init) => {
      requests++;
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${key}`);
      const body = JSON.parse(init.body as string);
      expect(body.state.task.request).toBe(requests === 1 ? 'Find the email' : 'Upload to Drive');
      expect(JSON.stringify(body.state.candidates)).not.toContain('inputSchema');
      const selected = requests === 1 ? 'email__find' : 'drive__upload';
      return Response.json({ answers: Object.fromEntries(body.state.candidates.map((candidate: { name: string }, index: number) => [
        `item_${index}`, { type: 'score', score: candidate.name === selected ? 3 : 0,
          probabilities: candidate.name === selected ? { 0: 0, 1: 0, 2: 0, 3: 1 } : { 0: 1, 1: 0, 2: 0, 3: 0 } },
      ])) });
    },
  }));
  try {
    const settings = new ToolLoadingSettings(path, encryption);
    expect(settings.handle({ action: 'save', enabled: true, maxDirect: 1, key })).toEqual({ enabled: true, maxDirect: 1, configured: true });
    expect(readFileSync(path, 'utf8')).not.toContain(key);
    const reopened = new ToolLoadingSettings(path, encryption);
    for (const text of ['Find the email', 'Upload to Drive']) {
      const done = new Promise<void>(resolve => { finished = resolve; });
      chat.start({ conversationId: id, text, model: 'deepseek-flash', credentials: { provider: 'deepseek', key: 'fake-model-key' }, toolLoading: reopened.config() });
      await done;
    }
    expect(requests).toBe(2);
    expect(nativeToolNames).toEqual([['call_tool', 'search_tools'], ['call_tool', 'search_tools']]);
    expect(nativeToolPayloads[1]).toBe(nativeToolPayloads[0]);
    expect(nativeToolPayloads[0]).not.toContain('email__find');
    expect(nativeToolPayloads[1]).not.toContain('drive__upload');
    expect(modelMessages[0][0]).toContain('email__find');
    expect(modelMessages[0][0]).not.toContain('drive__upload');
    expect(modelMessages[1][0]).toBe(modelMessages[0][0]);
    expect(modelMessages[1][1]).toContain('drive__upload');
    expect(JSON.stringify(store.snapshot(id))).not.toContain('selected_tool_context');
    expect(store.messages(id).filter(message => message.role === 'user').map(message => message.text)).toEqual(['Find the email', 'Upload to Drive']);
    expect(executed).toEqual(['email__find', 'drive__upload']);
    expect(closed).toBe(2);
    const diagnostics = lines.filter(line => line.startsWith('[moki] tool-selection ')).map(line => JSON.parse(line.slice('[moki] tool-selection '.length)));
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map(data => data.picked)).toEqual([['email__find'], ['drive__upload']]);
    expect(diagnostics.every(data => data.outcome === 'selected' && data.searchable === 2)).toBe(true);
    expect(lines.join('\n')).not.toContain(key);
    expect(lines.join('\n')).not.toContain('Find the email');
    expect(store.messages(id).at(-1)?.status).toBe('complete');
  } finally {
    logging.mockRestore(); chat.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
