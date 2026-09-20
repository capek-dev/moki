// Shared validation and presentation helpers for Cua Driver tools crossing
// IPC boundaries. Tool names observed from cua-driver tools/list are lowercase
// snake_case (click, browser_click, get_desktop_state); anything else is
// rejected. Labels and call descriptions turn raw tool traffic into the short
// friendly lines the chat UI shows.
export function requireCuaToolName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new Error('Invalid tool name.');
  return value;
}

// Present-progressive phrases for the "doing now" line. Unlisted tools fall
// back to a prettified name; the map covers the action-heavy catalog.
const LABELS: Record<string, string> = {
  click: 'Clicking',
  double_click: 'Double-clicking',
  right_click: 'Right-clicking',
  drag: 'Dragging',
  type_text: 'Typing',
  press_key: 'Pressing a key',
  hotkey: 'Pressing keys',
  scroll: 'Scrolling',
  set_value: 'Setting a value',
  get_desktop_state: 'Looking at the screen',
  get_window_state: 'Reading a window',
  list_apps: 'Listing apps',
  list_windows: 'Listing windows',
  get_accessibility_tree: 'Reading the screen layout',
  launch_app: 'Opening an app',
  kill_app: 'Closing an app',
  bring_to_front: 'Bringing an app to front',
  set_window_frame: 'Moving a window',
  invoke_menu: 'Opening a menu',
  clipboard_read: 'Reading the clipboard',
  clipboard_write: 'Writing to the clipboard',
  verify_state: 'Checking the result',
  zoom: 'Zooming in',
  get_browser_state: 'Reading the browser',
  browser_prepare: 'Preparing the browser',
  browser_read_active_tab: 'Reading a browser tab',
  browser_discover_elements: 'Finding page controls',
  browser_dom_action: 'Using a web page',
  browser_navigate: 'Opening a web page',
  browser_tab_manage: 'Managing browser tabs',
  browser_screenshot: 'Capturing a browser tab',
  browser_click: 'Clicking on a page',
  browser_type: 'Typing on a page',
  browser_dialog: 'Handling a dialog',
  browser_set_input_files: 'Choosing files',
  browser_download: 'Downloading a file',
  browser_pointer: 'Using the pointer',
  get_screen_size: 'Checking the screen size',
  get_cursor_position: 'Finding the cursor',
  move_cursor: 'Moving the cursor',
};

export function cuaToolLabel(name: string): string {
  return LABELS[name] ?? name.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// Short argument digest shown next to a label, e.g. the typed text or URL.
// Picks the most descriptive field per tool; never dumps the whole object.
export function describeCuaCall(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const input = args as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 48);
      if (typeof value === 'number') return String(value);
      if (Array.isArray(value) && value.length && value.every((entry) => typeof entry === 'string')) return value.join('+').slice(0, 48);
    }
    return '';
  };
  const preferred = name === 'hotkey' || name === 'press_key' ? pick('keys', 'key')
    : name === 'type_text' || name === 'browser_type' ? pick('text')
    : name === 'browser_navigate' ? pick('url')
    : name === 'browser_dom_action' || name === 'browser_tab_manage' ? pick('action', 'selector', 'text')
    : name === 'launch_app' ? pick('name', 'bundle_id')
    : name === 'invoke_menu' ? pick('path')
    : pick('text', 'url', 'query', 'name', 'path', 'action', 'direction');
  return preferred ? `"${preferred}"` : '';
}
