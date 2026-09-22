import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { BrowserExtension } from '@backend/integrations/browser-extension';
import { selectedToolbag } from '@backend/tools/selection';
import type { Toolbag } from '@backend/integrations/cua';
import { BrowserExtensionHost, isBrowserExtensionOrigin } from '@electron/browser-extension-host';
import {
  ACTIVE_TAB_CAPABILITY,
  BROWSER_DISCOVER_ELEMENTS,
  BROWSER_DOM_ACTION,
  BROWSER_EXTENSION_CAPABILITIES,
  BROWSER_EXTENSION_URL,
  BROWSER_NAVIGATE,
  BROWSER_READ_ACTIVE_TAB,
  BROWSER_SCREENSHOT,
  BROWSER_TAB_MANAGE,
  BROWSER_TOOL_ROUTES,
  isBrowserExtensionCall,
  type BrowserExtensionCall,
  type BrowserToolName,
} from '@shared/browser-extension';

const toolCapabilities = BROWSER_EXTENSION_CAPABILITIES.filter((capability) => capability !== 'browser_automation');
const connected = { connected: true, url: BROWSER_EXTENSION_URL, clientId: 'browser-1', capabilities: [...toolCapabilities], error: null };

function harness(state = connected) {
  const published: Array<BrowserExtensionCall | { cancelCallId: string }> = [];
  const bridge = new BrowserExtension((call) => published.push(call), state);
  const controller = new AbortController();
  const bag = bridge.toolbag(controller.signal);
  const execute = async (name: BrowserToolName, args: unknown, result: unknown) => {
    const pending = bag.execute(name, args);
    const call = published.at(-1) as BrowserExtensionCall;
    bridge.receive({ callId: call.callId, result });
    return { call, result: await pending };
  };
  return { bridge, bag, controller, published, execute };
}

test('backend exposes exactly the capabilities declared by the connected extension', () => {
  const disconnected = harness({ ...connected, connected: false, capabilities: [] });
  expect(disconnected.bag.tools).toEqual([]);
  disconnected.bag.close();

  const partial = harness({ ...connected, capabilities: [ACTIVE_TAB_CAPABILITY, 'browser_navigate'] });
  expect(partial.bag.tools.map((tool) => tool.name)).toEqual([BROWSER_READ_ACTIVE_TAB, BROWSER_NAVIGATE]);
  partial.bag.close();

  const all = harness();
  expect(all.bag.tools.map((tool) => tool.name)).toEqual([
    BROWSER_READ_ACTIVE_TAB,
    BROWSER_DISCOVER_ELEMENTS,
    BROWSER_DOM_ACTION,
    BROWSER_NAVIGATE,
    BROWSER_TAB_MANAGE,
    BROWSER_SCREENSHOT,
  ]);
  expect(all.bag.weights?.[0].weight).toBeGreaterThan(0);
  all.bag.close();
});

test('read, discovery, DOM action, navigation, and tab tools validate and bound results', async () => {
  const h = harness();
  const read = await h.execute(BROWSER_READ_ACTIVE_TAB, { tabId: 7 }, { title: 'Moki', url: 'https://example.com', text: 'visible text' });
  expect(read.call).toMatchObject({ capability: 'active_tab_read', task: 'browser.read_active_tab', params: { tabId: 7 } });
  expect(JSON.parse(read.result.text)).toEqual({ title: 'Moki', url: 'https://example.com', text: 'visible text' });

  const elements = Array.from({ length: 100 }, (_, index) => ({ tag: 'button', selector: `#button-${index}`, text: 'x'.repeat(500), isVisible: true, boundingRect: { x: index, y: 2, width: 10, height: 10 } }));
  const discovered = await h.execute(BROWSER_DISCOVER_ELEMENTS, {}, { elements });
  const discovery = JSON.parse(discovered.result.text);
  expect(discovered.call).toMatchObject({ capability: 'browser_discover_elements', task: 'browser.discover_elements', params: {} });
  expect(discovery.elementCount).toBe(100);
  expect(discovery.returnedCount).toBeLessThan(100);
  expect(discovery.truncated).toBe(true);
  expect(discovered.result.text.length).toBeLessThanOrEqual(12_000);

  const action = await h.execute(BROWSER_DOM_ACTION, { action: 'type', selector: '#query', value: 'Moki', delay: 150 }, { success: true, elementFound: true, currentValue: 'Moki', pageChanged: false, scrollX: 0, scrollY: 12, viewportWidth: 1200, viewportHeight: 800 });
  expect(action.call).toMatchObject({ capability: 'browser_dom_action', task: 'browser.dom_action', params: { action: 'type', selector: '#query', value: 'Moki', delay: 150 } });
  expect(JSON.parse(action.result.text)).toMatchObject({ success: true, elementFound: true, currentValue: 'Moki', viewportWidth: 1200 });

  const navigation = await h.execute(BROWSER_NAVIGATE, { url: 'https://example.com/path', waitForLoad: false }, { success: true, url: 'https://example.com/path', title: 'Example' });
  expect(navigation.call).toMatchObject({ capability: 'browser_navigate', task: 'browser.navigate', params: { url: 'https://example.com/path', waitForLoad: false, timeout: 10000 } });
  expect(JSON.parse(navigation.result.text)).toEqual({ success: true, url: 'https://example.com/path', title: 'Example' });

  const tab = { id: 4, index: 0, title: 'Example', url: 'https://example.com', active: true, windowId: 2 };
  const tabs = await h.execute(BROWSER_TAB_MANAGE, { action: 'list' }, { success: true, tabs: [tab] });
  expect(tabs.call).toMatchObject({ capability: 'browser_tab_manage', task: 'browser.tab_manage', params: { action: 'list' } });
  expect(JSON.parse(tabs.result.text)).toMatchObject({ success: true, tabCount: 1, returnedCount: 1, tabs: [tab] });
  h.bag.close();
});

test('screenshot becomes bounded image model output instead of base64 text', async () => {
  const h = harness();
  const png = Buffer.from('small png fixture').toString('base64');
  const screenshot = await h.execute(BROWSER_SCREENSHOT, {}, { success: true, dataUrl: `data:image/png;base64,${png}` });
  expect(screenshot.call).toMatchObject({ capability: 'browser_screenshot', task: 'browser.screenshot', params: {} });
  expect(screenshot.result.text).not.toContain(png);
  expect(screenshot.result.modelOutput).toEqual({
    type: 'content',
    value: [{ type: 'text', text: 'Captured the visible browser tab.' }, { type: 'image-data', data: png, mediaType: 'image/png' }],
  });
  h.bag.close();
});

test('backend rejects malformed inputs and extension failures without dispatching unsafe values', async () => {
  const h = harness();
  const before = h.published.length;
  await expect(h.bag.execute(BROWSER_NAVIGATE, { url: 'file:///etc/passwd' })).rejects.toThrow('HTTP or HTTPS');
  await expect(h.bag.execute(BROWSER_DOM_ACTION, { action: 'script' })).rejects.toThrow('Invalid browser DOM action');
  await expect(h.bag.execute(BROWSER_TAB_MANAGE, { action: 'switch', tabId: -1 })).rejects.toThrow('Invalid tab ID');
  await expect(h.bag.execute(BROWSER_NAVIGATE, { url: 'https://example.com', timeout: 50_000 })).rejects.toThrow('must not exceed');
  expect(h.published).toHaveLength(before);

  const failed = await h.execute(BROWSER_DOM_ACTION, { action: 'click', selector: '#missing' }, { success: false, error: 'No element found' });
  expect(failed.result).toEqual({ text: 'No element found', isError: true });
  const badScreenshot = h.bag.execute(BROWSER_SCREENSHOT, {});
  const call = h.published.at(-1) as BrowserExtensionCall;
  h.bridge.receive({ callId: call.callId, result: { success: true, dataUrl: 'data:text/plain;base64,eA==' } });
  await expect(badScreenshot).rejects.toThrow('invalid PNG');
  h.bag.close();
});

test('backend rejects malformed results and cancels pending calls on Stop', async () => {
  const h = harness();
  const malformed = h.bag.execute(BROWSER_READ_ACTIVE_TAB, {});
  const first = h.published[0] as BrowserExtensionCall;
  h.bridge.receive({ callId: first.callId, result: { title: 42 } });
  await expect(malformed).rejects.toThrow('invalid tab title');

  const pending = h.bag.execute(BROWSER_READ_ACTIVE_TAB, {});
  const second = h.published.at(-1) as BrowserExtensionCall;
  h.controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  expect(h.published).toContainEqual({ cancelCallId: second.callId });
});

test('browser extension wins duplicate tool names before Cua', async () => {
  const calls: string[] = [];
  const makeBag = (owner: string): Toolbag => ({
    tools: [{ name: BROWSER_NAVIGATE, description: owner, inputSchema: { type: 'object' } }],
    execute: async () => { calls.push(owner); return { text: owner, isError: false }; },
    close() {},
  });
  const selected = selectedToolbag([makeBag('extension'), makeBag('cua')], [{ name: BROWSER_NAVIGATE, score: 3, probabilities: [0, 0, 0, 1] }]);
  expect(selected.selectedTools?.map(tool => tool.name)).toEqual([BROWSER_NAVIGATE]);
  expect(await selected.execute('call_tool', { name: BROWSER_NAVIGATE, arguments: {} })).toEqual({ text: 'extension', isError: false });
  expect(calls).toEqual(['extension']);
  const source = await Bun.file('src/backend/index.ts').text();
  expect(source).toContain('[() => browserExtension.toolbag(signal), () => cua.toolbag(signal), () => mcp.toolbag(signal)]');
  selected.close();
});

test('shared route validation denies mismatched tool, capability, and task combinations', () => {
  const valid: BrowserExtensionCall = { callId: 'call-1', toolName: BROWSER_NAVIGATE, capability: 'browser_navigate', task: 'browser.navigate', params: { url: 'https://example.com' } };
  expect(isBrowserExtensionCall(valid)).toBe(true);
  expect(isBrowserExtensionCall({ ...valid, capability: 'active_tab_read' })).toBe(false);
  expect(isBrowserExtensionCall({ ...valid, task: 'browser.read_active_tab' })).toBe(false);
  expect(isBrowserExtensionCall({ ...valid, toolName: 'unknown' })).toBe(false);
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closed?: { code: number; reason: string };
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close(code: number, reason: string) { this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
}

function register(host: BrowserExtensionHost, socket: FakeSocket, capabilities: string[] = [...toolCapabilities]) {
  (host as unknown as { accept(value: FakeSocket): void }).accept(socket);
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'client.register',
    client: { clientId: 'browser-1', clientType: 'extension', displayName: 'Prokop Browser', interactionMode: 'headless', capabilities },
  })), false);
}

test('host accepts Chrome extension origins but rejects ordinary web pages', () => {
  expect(isBrowserExtensionOrigin('chrome-extension://jpahdfmmfmmnacapmkchljmcijoedcpj')).toBe(true);
  expect(isBrowserExtensionOrigin('https://example.com')).toBe(false);
  expect(isBrowserExtensionOrigin(undefined)).toBe(false);
});

test('host sends each declared tool route and correlates ask responses', async () => {
  const states: boolean[] = [];
  const host = new BrowserExtensionHost((state) => states.push(state.connected));
  const socket = new FakeSocket();
  register(host, socket);
  expect(host.state()).toMatchObject({ connected: true, clientId: 'browser-1' });
  expect(socket.sent[0]).toMatchObject({ type: 'client.registered', client: { clientId: 'browser-1' } });

  let index = 1;
  for (const [toolName, route] of Object.entries(BROWSER_TOOL_ROUTES)) {
    const call: BrowserExtensionCall = { callId: `call-${index}`, toolName: toolName as BrowserToolName, capability: route.capability, task: route.task, params: { sample: index } };
    const pending = host.call(call);
    const ask = socket.sent[index++];
    expect(ask).toMatchObject({ type: 'ask.request', sessionId: 'moki', toolCallId: call.callId, toolName, ask: { type: 'client_capability', capability: route.capability, metadata: { task: route.task, params: call.params } } });
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'ask.response', toolCallId: call.callId, requestId: ask.requestId, response: { type: 'client_capability', capability: route.capability, result: { ok: toolName } } })), false);
    expect(await pending).toEqual({ ok: toolName });
  }
  expect(states).toEqual([true]);
});

test('host rejects invalid clients and pending calls fail on disconnect', async () => {
  const invalidHost = new BrowserExtensionHost();
  const invalid = new FakeSocket();
  register(invalidHost, invalid, ['unknown']);
  expect(invalid.sent[0]).toMatchObject({ type: 'client.rejected', code: 'invalid_client' });
  expect(invalid.closed?.code).toBe(1008);

  const host = new BrowserExtensionHost();
  const socket = new FakeSocket();
  register(host, socket, [ACTIVE_TAB_CAPABILITY]);
  const route = BROWSER_TOOL_ROUTES[BROWSER_READ_ACTIVE_TAB];
  const pending = host.call({ callId: 'call-disconnect', toolName: BROWSER_READ_ACTIVE_TAB, capability: route.capability, task: route.task, params: {} });
  socket.close(1000, 'gone');
  await expect(pending).rejects.toThrow('disconnected');
});
