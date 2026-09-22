import type { AgentToolDef, Toolbag, ToolExecutionResult } from '@backend/integrations/cua';
import { schemaWeight } from '@shared/mcp';
import {
  BROWSER_DISCOVER_ELEMENTS,
  BROWSER_DOM_ACTION,
  BROWSER_NAVIGATE,
  BROWSER_READ_ACTIVE_TAB,
  BROWSER_SCREENSHOT,
  BROWSER_TAB_MANAGE,
  BROWSER_TOOL_ROUTES,
  type BrowserExtensionCall,
  type BrowserExtensionResult,
  type BrowserExtensionState,
  type BrowserToolName,
} from '@shared/browser-extension';

const RESULT_TEXT_LIMIT = 12_000;
const SCREENSHOT_BYTE_LIMIT = 5 * 1024 * 1024;
const CALL_TIMEOUT_MS = 50_000;
const DOM_ACTIONS = ['click', 'type', 'select', 'clear', 'scroll', 'hover', 'press_enter', 'check', 'uncheck'] as const;
const TAB_ACTIONS = ['list', 'create', 'close', 'switch'] as const;

const tabIdProperty = { type: 'number', description: 'Optional tab ID from browser_tab_manage. Defaults to the most recently active non-PWA browser tab.' };
const tools: AgentToolDef[] = [
  {
    name: BROWSER_READ_ACTIVE_TAB,
    description: 'Read a browser tab by tabId. Without tabId, reads the most recently active non-PWA browser tab. Returns the page title, URL, and visible text content. Requires a connected Prokop Browser extension.',
    inputSchema: { type: 'object', properties: { tabId: tabIdProperty }, additionalProperties: false },
  },
  {
    name: BROWSER_DISCOVER_ELEMENTS,
    description: 'Discover interactive elements on a tab selected by tabId, or the most recently active non-PWA browser tab. Returns bounded element details, selectors, visibility, and geometry. Use this before browser_dom_action.',
    inputSchema: { type: 'object', properties: { tabId: tabIdProperty }, additionalProperties: false },
  },
  {
    name: BROWSER_DOM_ACTION,
    description: 'Perform a DOM interaction on a tab. Supports click, type, select, clear, scroll, hover, press Enter, and checkbox actions. Use browser_read_active_tab and browser_discover_elements first.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProperty,
        action: { type: 'string', enum: DOM_ACTIONS },
        selector: { type: 'string', description: 'CSS selector for the target element.' },
        text: { type: 'string', description: 'Visible text fallback for click.' },
        value: { type: 'string', description: 'Value for type or select.' },
        x: { type: 'number', description: 'Horizontal scroll amount.' },
        y: { type: 'number', description: 'Vertical scroll amount.' },
        delay: { type: 'number', description: 'Delay in milliseconds after the action.' },
      },
      required: ['action'], additionalProperties: false,
    },
  },
  {
    name: BROWSER_NAVIGATE,
    description: 'Navigate a tab to an HTTP or HTTPS URL. Optionally wait for page load and set a bounded load timeout.',
    inputSchema: {
      type: 'object',
      properties: { tabId: tabIdProperty, url: { type: 'string' }, waitForLoad: { type: 'boolean' }, timeout: { type: 'number' } },
      required: ['url'], additionalProperties: false,
    },
  },
  {
    name: BROWSER_TAB_MANAGE,
    description: 'List, create, close, or switch tabs across non-PWA Chrome windows. Use list first to obtain tab and window IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: TAB_ACTIONS }, url: { type: 'string' }, tabId: { type: 'number' },
        tabIndex: { type: 'number' }, windowId: { type: 'number' }, active: { type: 'boolean' },
      },
      required: ['action'], additionalProperties: false,
    },
  },
  {
    name: BROWSER_SCREENSHOT,
    description: 'Capture the visible area of a tab as a PNG image for visual verification. The image is returned directly to the model.',
    inputSchema: { type: 'object', properties: { tabId: tabIdProperty }, additionalProperties: false },
  },
];
const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbort: () => void;
}

function record(value: unknown, message = 'Browser extension returned an invalid result.'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
function string(value: unknown, limit: number, field: string): string {
  if (typeof value !== 'string') throw new Error(`Browser extension returned an invalid ${field}.`);
  return value.slice(0, limit);
}
function optionalString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}
function finite(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function integer(value: unknown, field: string): number | undefined {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Invalid ${field}.`);
  return value as number;
}
function boolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return;
  if (typeof value !== 'boolean') throw new Error(`Invalid ${field}.`);
  return value;
}
function inputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function browserUrl(value: unknown, optional = false): string | undefined {
  if (value === undefined && optional) return;
  if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('Invalid browser URL.');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Invalid browser URL.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Browser URL must use HTTP or HTTPS.');
  return parsed.href;
}
function failed(input: Record<string, unknown>, fallback: string): ToolExecutionResult | undefined {
  if (input.success !== false) return;
  return { text: optionalString(input.error, 1000) || fallback, isError: true };
}
function boundedCollection(key: string, values: unknown[], sanitize: (value: unknown) => unknown): Record<string, unknown> {
  const kept: unknown[] = [];
  for (const value of values.slice(0, 500)) {
    const next = sanitize(value);
    if (JSON.stringify({ [key]: [...kept, next] }).length > RESULT_TEXT_LIMIT - 200) break;
    kept.push(next);
  }
  return { [`${key.slice(0, -1)}Count`]: values.length, returnedCount: kept.length, truncated: kept.length < values.length, [key]: kept };
}
function sanitizeRect(value: unknown) {
  const input = record(value, 'Browser extension returned invalid element geometry.');
  return Object.fromEntries(['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'].flatMap((key) => {
    const number = finite(input[key]); return number === undefined ? [] : [[key, number]];
  }));
}
function sanitizeElement(value: unknown) {
  const input = record(value, 'Browser extension returned an invalid element.');
  const tag = string(input.tag, 80, 'element tag');
  const selector = string(input.selector, 500, 'element selector');
  return {
    tag, selector,
    ...Object.fromEntries(['id', 'className', 'type', 'placeholder', 'text', 'value', 'role', 'ariaLabel'].flatMap((key) => {
      const item = optionalString(input[key], 500); return item === undefined ? [] : [[key, item]];
    })),
    ...(typeof input.href === 'string' ? { href: input.href.slice(0, 2000) } : {}),
    ...(input.boundingRect === undefined ? {} : { boundingRect: sanitizeRect(input.boundingRect) }),
    ...(typeof input.isVisible === 'boolean' ? { isVisible: input.isVisible } : {}),
    ...(typeof input.isInViewport === 'boolean' ? { isInViewport: input.isInViewport } : {}),
  };
}
function sanitizeTab(value: unknown) {
  const input = record(value, 'Browser extension returned an invalid tab.');
  if (!Number.isInteger(input.id) || !Number.isInteger(input.index) || !Number.isInteger(input.windowId) || typeof input.active !== 'boolean') throw new Error('Browser extension returned an invalid tab.');
  return { id: input.id, index: input.index, title: string(input.title, 1000, 'tab title'), url: string(input.url, 4096, 'tab URL'), active: input.active, windowId: input.windowId };
}

function prepare(name: BrowserToolName, args: unknown): Record<string, unknown> {
  const input = inputRecord(args);
  const tabId = integer(input.tabId, 'tab ID');
  if (name === BROWSER_READ_ACTIVE_TAB || name === BROWSER_DISCOVER_ELEMENTS || name === BROWSER_SCREENSHOT) return tabId === undefined ? {} : { tabId };
  if (name === BROWSER_DOM_ACTION) {
    if (typeof input.action !== 'string' || !(DOM_ACTIONS as readonly string[]).includes(input.action)) throw new Error('Invalid browser DOM action.');
    const params: Record<string, unknown> = { action: input.action };
    if (tabId !== undefined) params.tabId = tabId;
    for (const key of ['selector', 'text', 'value'] as const) {
      if (input[key] !== undefined) params[key] = string(input[key], key === 'selector' ? 1000 : 4000, key);
    }
    for (const key of ['x', 'y'] as const) {
      if (input[key] !== undefined && finite(input[key]) === undefined) throw new Error(`Invalid ${key} value.`);
      if (input[key] !== undefined) params[key] = input[key];
    }
    if (input.delay !== undefined) {
      if (!Number.isInteger(input.delay) || (input.delay as number) < 0 || (input.delay as number) > 10_000) throw new Error('Invalid browser action delay.');
      params.delay = input.delay;
    }
    return params;
  }
  if (name === BROWSER_NAVIGATE) {
    const timeout = input.timeout === undefined ? 10_000 : integer(input.timeout, 'navigation timeout');
    if (timeout! > 40_000) throw new Error('Navigation timeout must not exceed 40000 ms.');
    return { ...(tabId === undefined ? {} : { tabId }), url: browserUrl(input.url), waitForLoad: boolean(input.waitForLoad, 'waitForLoad') ?? true, timeout };
  }
  if (typeof input.action !== 'string' || !(TAB_ACTIONS as readonly string[]).includes(input.action)) throw new Error('Invalid browser tab action.');
  const params: Record<string, unknown> = { action: input.action };
  if (input.url !== undefined) params.url = browserUrl(input.url);
  if (tabId !== undefined) params.tabId = tabId;
  for (const key of ['tabIndex', 'windowId'] as const) {
    const value = integer(input[key], key); if (value !== undefined) params[key] = value;
  }
  const active = boolean(input.active, 'active'); if (active !== undefined) params.active = active;
  return params;
}

function parseResult(name: BrowserToolName, value: unknown): ToolExecutionResult {
  const input = record(value);
  if (name === BROWSER_READ_ACTIVE_TAB) {
    const result = { title: string(input.title, 1000, 'tab title'), url: string(input.url, 4096, 'tab URL'), text: string(input.text, RESULT_TEXT_LIMIT, 'tab text') };
    if (!result.title && !result.url && !result.text) throw new Error('Browser extension returned an empty tab.');
    return { text: JSON.stringify(result), isError: false };
  }
  if (name === BROWSER_DISCOVER_ELEMENTS) {
    if (!Array.isArray(input.elements)) throw new Error('Browser extension returned an invalid element list.');
    return { text: JSON.stringify(boundedCollection('elements', input.elements, sanitizeElement)), isError: false };
  }
  if (name === BROWSER_DOM_ACTION) {
    const failure = failed(input, 'Browser DOM action failed.'); if (failure) return failure;
    if (input.success !== true) throw new Error('Browser extension returned an invalid DOM action result.');
    const result = { success: true } as Record<string, unknown>;
    for (const key of ['elementFound', 'pageChanged'] as const) if (typeof input[key] === 'boolean') result[key] = input[key];
    if (typeof input.currentValue === 'string') result.currentValue = input.currentValue.slice(0, 4000);
    for (const key of ['scrollX', 'scrollY', 'viewportWidth', 'viewportHeight'] as const) { const value = finite(input[key]); if (value !== undefined) result[key] = value; }
    return { text: JSON.stringify(result), isError: false };
  }
  if (name === BROWSER_NAVIGATE) {
    const failure = failed(input, 'Browser navigation failed.'); if (failure) return failure;
    if (input.success !== true) throw new Error('Browser extension returned an invalid navigation result.');
    return { text: JSON.stringify({ success: true, url: string(input.url, 4096, 'navigation URL'), title: string(input.title, 1000, 'navigation title') }), isError: false };
  }
  if (name === BROWSER_TAB_MANAGE) {
    const failure = failed(input, 'Browser tab action failed.'); if (failure) return failure;
    if (input.success !== true) throw new Error('Browser extension returned an invalid tab action result.');
    const result: Record<string, unknown> = { success: true };
    if (Array.isArray(input.tabs)) Object.assign(result, boundedCollection('tabs', input.tabs, sanitizeTab));
    if (input.createdTab !== undefined) result.createdTab = sanitizeTab(input.createdTab);
    if (input.switchedToTab !== undefined) result.switchedToTab = sanitizeTab(input.switchedToTab);
    if (input.closedTabId !== undefined) result.closedTabId = integer(input.closedTabId, 'closed tab ID');
    return { text: JSON.stringify(result), isError: false };
  }
  const failure = failed(input, 'Browser screenshot failed.'); if (failure) return failure;
  if (input.success !== true || typeof input.dataUrl !== 'string' || !input.dataUrl.startsWith('data:image/png;base64,')) throw new Error('Browser extension returned invalid PNG screenshot data.');
  const data = input.dataUrl.slice('data:image/png;base64,'.length);
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Browser extension returned invalid PNG screenshot data.');
  const byteSize = Buffer.byteLength(data, 'base64');
  if (!byteSize || byteSize > SCREENSHOT_BYTE_LIMIT) throw new Error('Browser screenshot is too large.');
  return {
    text: JSON.stringify({ captured: true, mediaType: 'image/png', byteSize }), isError: false,
    modelOutput: { type: 'content', value: [{ type: 'text', text: 'Captured the visible browser tab.' }, { type: 'image-data', data, mediaType: 'image/png' }] },
  };
}

export class BrowserExtension {
  private state: BrowserExtensionState;
  private pending = new Map<string, Pending>();

  constructor(private publish: (call: BrowserExtensionCall | { cancelCallId: string }) => void, initialState: BrowserExtensionState) { this.state = initialState; }

  setState(state: BrowserExtensionState) {
    this.state = state;
    if (!state.connected) this.failPending(new Error('Prokop Browser extension disconnected.'));
  }

  receive(message: BrowserExtensionResult) {
    if (typeof message.callId !== 'string') return;
    const pending = this.pending.get(message.callId);
    if (!pending) return;
    this.pending.delete(message.callId); clearTimeout(pending.timer); pending.removeAbort();
    if (typeof message.error === 'string') pending.reject(new Error(message.error));
    else if ('result' in message) pending.resolve(message.result);
    else pending.reject(new Error('Browser extension returned no result.'));
  }

  private request(call: BrowserExtensionCall, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Browser extension call cancelled.')); return; }
      const abort = () => { this.publish({ cancelCallId: call.callId }); this.reject(call.callId, new Error('Browser extension call cancelled.')); };
      const timer = setTimeout(() => { this.publish({ cancelCallId: call.callId }); this.reject(call.callId, new Error('Browser extension did not respond in time.')); }, CALL_TIMEOUT_MS);
      timer.unref?.();
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(call.callId, { resolve, reject, timer, removeAbort: () => signal.removeEventListener('abort', abort) });
      this.publish(call);
    });
  }

  private reject(callId: string, error: Error) {
    const pending = this.pending.get(callId); if (!pending) return;
    this.pending.delete(callId); clearTimeout(pending.timer); pending.removeAbort(); pending.reject(error);
  }
  private failPending(error: Error) { for (const callId of [...this.pending.keys()]) this.reject(callId, error); }

  toolbag(signal: AbortSignal): Toolbag {
    const active = tools.filter((tool) => this.state.connected && this.state.capabilities.includes(BROWSER_TOOL_ROUTES[tool.name as BrowserToolName].capability));
    const calls = new Set<string>();
    return {
      tools: active,
      weights: active.length ? [{ label: 'Prokop Browser', weight: schemaWeight(active) }] : [],
      execute: async (name, args) => {
        if (!toolByName.has(name)) throw new Error('Unknown browser extension tool.');
        const toolName = name as BrowserToolName;
        const route = BROWSER_TOOL_ROUTES[toolName];
        const callId = crypto.randomUUID(); calls.add(callId);
        try { return parseResult(toolName, await this.request({ callId, toolName, capability: route.capability, task: route.task, params: prepare(toolName, args) }, signal)); }
        finally { calls.delete(callId); }
      },
      close: () => {
        for (const callId of calls) { this.publish({ cancelCallId: callId }); this.reject(callId, new Error('Browser extension call cancelled.')); }
        calls.clear();
      },
    };
  }
}
