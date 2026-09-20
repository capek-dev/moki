export const BROWSER_EXTENSION_PORT = 8751;
export const BROWSER_EXTENSION_URL = `http://127.0.0.1:${BROWSER_EXTENSION_PORT}`;

export const BROWSER_READ_ACTIVE_TAB = 'browser_read_active_tab';
export const BROWSER_DISCOVER_ELEMENTS = 'browser_discover_elements';
export const BROWSER_DOM_ACTION = 'browser_dom_action';
export const BROWSER_NAVIGATE = 'browser_navigate';
export const BROWSER_TAB_MANAGE = 'browser_tab_manage';
export const BROWSER_SCREENSHOT = 'browser_screenshot';

export const ACTIVE_TAB_CAPABILITY = 'active_tab_read';
export const DISCOVER_ELEMENTS_CAPABILITY = 'browser_discover_elements';
export const DOM_ACTION_CAPABILITY = 'browser_dom_action';
export const NAVIGATE_CAPABILITY = 'browser_navigate';
export const TAB_MANAGE_CAPABILITY = 'browser_tab_manage';
export const SCREENSHOT_CAPABILITY = 'browser_screenshot';

export const BROWSER_TOOL_ROUTES = {
  [BROWSER_READ_ACTIVE_TAB]: { capability: ACTIVE_TAB_CAPABILITY, task: 'browser.read_active_tab' },
  [BROWSER_DISCOVER_ELEMENTS]: { capability: DISCOVER_ELEMENTS_CAPABILITY, task: 'browser.discover_elements' },
  [BROWSER_DOM_ACTION]: { capability: DOM_ACTION_CAPABILITY, task: 'browser.dom_action' },
  [BROWSER_NAVIGATE]: { capability: NAVIGATE_CAPABILITY, task: 'browser.navigate' },
  [BROWSER_TAB_MANAGE]: { capability: TAB_MANAGE_CAPABILITY, task: 'browser.tab_manage' },
  [BROWSER_SCREENSHOT]: { capability: SCREENSHOT_CAPABILITY, task: 'browser.screenshot' },
} as const;

export type BrowserToolName = keyof typeof BROWSER_TOOL_ROUTES;
export type BrowserCapability = typeof BROWSER_TOOL_ROUTES[BrowserToolName]['capability'];
export type BrowserTask = typeof BROWSER_TOOL_ROUTES[BrowserToolName]['task'];

export const BROWSER_EXTENSION_CAPABILITIES = [
  'browser_automation',
  ACTIVE_TAB_CAPABILITY,
  DISCOVER_ELEMENTS_CAPABILITY,
  DOM_ACTION_CAPABILITY,
  NAVIGATE_CAPABILITY,
  SCREENSHOT_CAPABILITY,
  TAB_MANAGE_CAPABILITY,
] as const;

export interface BrowserExtensionState {
  connected: boolean;
  url: string;
  clientId: string | null;
  capabilities: string[];
  error: string | null;
}

export interface BrowserExtensionCall {
  callId: string;
  toolName: BrowserToolName;
  capability: BrowserCapability;
  task: BrowserTask;
  params: Record<string, unknown>;
}

export interface BrowserExtensionResult {
  callId: string;
  result?: unknown;
  error?: string;
}

export function isBrowserExtensionCall(value: unknown): value is BrowserExtensionCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (typeof input.callId !== 'string' || !input.callId || input.callId.length > 128) return false;
  if (typeof input.toolName !== 'string' || !(input.toolName in BROWSER_TOOL_ROUTES)) return false;
  const route = BROWSER_TOOL_ROUTES[input.toolName as BrowserToolName];
  if (input.capability !== route.capability || input.task !== route.task) return false;
  return !!input.params && typeof input.params === 'object' && !Array.isArray(input.params);
}
