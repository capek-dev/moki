import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cua, MODEL_RESULT_LIMIT, TRUNCATION_MARKER, parseToolCallResult, type CuaTransport } from '@backend/integrations/cua';
import { Store } from '@backend/storage/store';
import { cuaToolLabel, describeCuaCall, requireCuaToolName } from '@shared/cua';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'moki-cua-'));
  const store = new Store(join(dir, 'moki.sqlite'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function fakeTransport(catalog: { version: string; tools: { name: string; description?: string }[] }, failure?: Error): CuaTransport {
  return {
    async listTools() {
      if (failure) throw failure;
      return { version: catalog.version, tools: catalog.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })) };
    },
  };
}

test('tool names are validated at the shared boundary', () => {
  expect(requireCuaToolName('click')).toBe('click');
  expect(requireCuaToolName('browser_click')).toBe('browser_click');
  expect(requireCuaToolName('get_desktop_state')).toBe('get_desktop_state');
  expect(() => requireCuaToolName('Bad-Name')).toThrow('Invalid tool name.');
  expect(() => requireCuaToolName('')).toThrow('Invalid tool name.');
  expect(() => requireCuaToolName(42)).toThrow('Invalid tool name.');
  expect(() => requireCuaToolName('../escape')).toThrow('Invalid tool name.');
});

test('disabled tool set persists and prunes', () => {
  const { store, cleanup } = freshStore();
  try {
    store.setCuaToolDisabled('clipboard_read', true);
    store.setCuaToolDisabled('kill_app', true);
    expect(store.cuaDisabledTools()).toEqual(['clipboard_read', 'kill_app']);
    store.setCuaToolDisabled('clipboard_read', false);
    expect(store.cuaDisabledTools()).toEqual(['kill_app']);
    store.setCuaToolDisabled('kill_app', false);
    expect(store.cuaDisabledTools()).toEqual([]);
    store.setCuaToolDisabled('zoom', true);
    store.pruneCuaDisabledTools(['click', 'zoom']);
    expect(store.cuaDisabledTools()).toEqual(['zoom']);
  } finally { cleanup(); }
});

test('catalog fetch merges disabled flags and prunes stale entries', async () => {
  const { store, cleanup } = freshStore();
  try {
    store.setCuaToolDisabled('kill_app', true);
    store.setCuaToolDisabled('removed_by_update', true);
    const cua = new Cua(store, fakeTransport({ version: '0.28.2', tools: [{ name: 'click', description: 'Click.' }, { name: 'kill_app', description: 'Kill.' }] }));
    const state = await cua.tools();
    expect(state.connected).toBe(true);
    expect(state.version).toBe('0.28.2');
    expect(state.error).toBeNull();
    expect(state.tools.map((tool) => tool.name)).toEqual(['click', 'kill_app']);
    expect(state.disabled).toEqual(['kill_app']);
    expect(store.cuaDisabledTools()).toEqual(['kill_app']);
  } finally { cleanup(); }
});

test('toggles persist and respond from the cached catalog', async () => {
  const { store, cleanup } = freshStore();
  try {
    let calls = 0;
    const transport: CuaTransport = {
      async listTools() { calls++; return { version: '0.28.2', tools: [{ name: 'click', description: 'Click.' }] }; },
    };
    const cua = new Cua(store, transport);
    await cua.tools();
    const state = cua.setTool({ tool: 'click', disabled: true });
    expect(calls).toBe(1);
    expect(state.connected).toBe(true);
    expect(state.disabled).toEqual(['click']);
    expect(state.tools.map((tool) => tool.name)).toEqual(['click']);
    expect(cua.setTool({ tool: 'click', disabled: false }).disabled).toEqual([]);
    expect(store.cuaDisabledTools()).toEqual([]);
    expect(() => cua.setTool({ tool: 'DROP TABLE', disabled: true })).toThrow('Invalid tool name.');
    expect(() => cua.setTool({ tool: 'click', disabled: 'yes' })).toThrow('Invalid toggle value.');
  } finally { cleanup(); }
});

test('integration switch disconnects without touching the driver', async () => {
  const { store, cleanup } = freshStore();
  try {
    let calls = 0;
    const transport: CuaTransport = {
      async listTools() { calls++; return { version: '0.28.2', tools: [{ name: 'click', description: 'Click.' }] }; },
    };
    const cua = new Cua(store, transport);
    expect(store.cuaIntegrationEnabled()).toBe(true);
    const on = await cua.tools();
    expect(on.enabled).toBe(true);
    expect(on.connected).toBe(true);
    const off = cua.setEnabled({ enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.connected).toBe(false);
    expect(off.tools).toEqual([]);
    expect(off.error).toBeNull();
    store.setCuaToolDisabled('click', true);
    const idle = await cua.tools();
    expect(idle.enabled).toBe(false);
    expect(idle.connected).toBe(false);
    expect(idle.disabled).toEqual(['click']); // per-tool filters survive a disconnect
    expect(calls).toBe(1); // no transport spawn while disconnected
    cua.setEnabled({ enabled: true });
    const again = await cua.tools();
    expect(again.enabled).toBe(true);
    expect(again.connected).toBe(true);
    expect(calls).toBe(2);
    expect(() => cua.setEnabled({ enabled: 'yes' })).toThrow('Invalid toggle value.');
  } finally { cleanup(); }
});

test('labels and call digests stay short and friendly', () => {
  expect(cuaToolLabel('click')).toBe('Clicking');
  expect(cuaToolLabel('type_text')).toBe('Typing');
  expect(cuaToolLabel('browser_navigate')).toBe('Opening a web page');
  expect(cuaToolLabel('some_future_tool')).toBe('Some Future Tool');
  expect(describeCuaCall('type_text', { text: 'hello world' })).toBe('"hello world"');
  expect(describeCuaCall('browser_navigate', { url: 'https://example.com' })).toBe('"https://example.com"');
  expect(describeCuaCall('hotkey', { keys: ['cmd', 'c'] })).toBe('"cmd+c"');
  expect(describeCuaCall('click', {})).toBe('');
  expect(describeCuaCall('click', null)).toBe('');
});

test('tool call results join text, flag errors, and truncate', () => {
  expect(parseToolCallResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] })).toEqual({ text: 'a\nb', isError: false });
  expect(parseToolCallResult({ content: [{ type: 'text', text: 'denied' }], isError: true })).toEqual({ text: 'denied', isError: true });
  expect(parseToolCallResult(null)).toEqual({ text: '', isError: false });
  const long = parseToolCallResult({ content: [{ type: 'text', text: 'x'.repeat(MODEL_RESULT_LIMIT + 500) }] });
  expect(long.text.endsWith(TRUNCATION_MARKER)).toBe(true);
  expect(long.text.length).toBe(MODEL_RESULT_LIMIT + TRUNCATION_MARKER.length);
});

test('agent toolbag filters by switch and per-tool set, keeping schemas', async () => {
  const { store, cleanup } = freshStore();
  try {
    const transport: CuaTransport = {
      async listTools() {
        return { version: '0.28.2', tools: [
          { name: 'click', description: 'Click.', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } },
          { name: 'kill_app', description: 'Kill.' },
        ] };
      },
    };
    const cua = new Cua(store, transport);
    const cold = await cua.toolbag(); // cold cache triggers exactly one fetch
    expect(cold.tools.map((tool) => tool.name)).toEqual(['click', 'kill_app']);
    expect(cold.tools[0].inputSchema).toMatchObject({ type: 'object' });
    expect(cold.tools[1].inputSchema).toEqual({ type: 'object' }); // schema-less fallback
    cold.close();
    store.setCuaToolDisabled('kill_app', true);
    const filtered = await cua.toolbag();
    expect(filtered.tools.map((tool) => tool.name)).toEqual(['click']);
    filtered.close();
    cua.setEnabled({ enabled: false });
    const off = await cua.toolbag();
    expect(off.tools).toEqual([]);
    off.close();
  } finally { cleanup(); }
});

test('transport failure reports disconnected without throwing', async () => {
  const { store, cleanup } = freshStore();
  try {
    const cua = new Cua(store, fakeTransport({ version: '', tools: [] }, new Error('daemon down')));
    const state = await cua.tools();
    expect(state.connected).toBe(false);
    expect(state.version).toBeNull();
    expect(state.tools).toEqual([]);
    expect(state.error).toBe('daemon down');
  } finally { cleanup(); }
});
