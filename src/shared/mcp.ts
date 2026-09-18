// Shared config types, validation, and tool-naming rules for user-added MCP
// servers. Pure: no fs, no spawn. The config file is storage; Settings is the
// primary surface and hand edits stay first-class (audience is everyday users,
// not developers). Invalid individual entries are skipped with a diagnostic
// instead of failing the whole file; unknown fields are tolerated so hand
// editors and future versions do not fight each other.

export type McpTransportKind = 'stdio' | 'http';

export interface McpServerConfig {
  transport: McpTransportKind;
  // stdio: the command to spawn, e.g. ["npx", "-y", "@modelcontextprotocol/server-filesystem"].
  command: string | null;
  args: string[];
  // http: the server URL. Kept parsed-but-inactive until the HTTP transport ships.
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  disabledTools: string[];
}

export interface ParsedMcpServer { key: string; config: McpServerConfig }
export interface ParsedMcpConfig { servers: ParsedMcpServer[]; diagnostics: string[] }

// Tool naming discipline (plan 18): the model-facing name is `prefix__tool`.
// Prefixes cap at 30 chars, full names at 64; colliding sanitized names get
// numeric suffixes at merge time (backend), not here.
export const PREFIX_MAX = 30;
export const TOOL_NAME_MAX = 64;
const SERVER_KEY_MAX = 64;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// A config key becomes a tool prefix: characters outside [A-Za-z0-9_-] turn
// into '-', keys that would start with a non-letter get an 's' prefix (numeric
// keys like "12306" stay provider-safe), everything caps at 30 chars.
export function serverPrefix(key: string): string {
  let cleaned = key.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, PREFIX_MAX);
  if (cleaned && !/^[A-Za-z_]/.test(cleaned)) cleaned = `s${cleaned}`.slice(0, PREFIX_MAX);
  return cleaned || 'mcp';
}

// Remote tool names arrive in any shape (camelCase, dotted, unicode). The
// exposed name keeps [A-Za-z0-9_-] only; the backend remembers the original
// for dispatch.
export function sanitizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, TOOL_NAME_MAX);
}

// Exposed (prefixed) names cross IPC from the renderer; re-validate on the way in.
export function requireExposedToolName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid tool name.');
  return value;
}

// Friendly labels for connected-app tools in chat records. `files__read_note`
// reads as "Files · Read note": the user-chosen connection name plus the tool,
// prettified without guessing verbs. Falls back to a plain prettified name.
export function mcpToolLabel(name: string): string {
  const sep = name.indexOf('__');
  const pretty = (value: string): string => {
    const split = value.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
    return split ? split.charAt(0).toUpperCase() + split.slice(1) : 'App';
  };
  return sep < 0 ? pretty(name) : `${pretty(name.slice(0, sep))} · ${pretty(name.slice(sep + 2))}`;
}

// Short argument digest for the chat trail: picks the most descriptive common
// field, mirroring describeCuaCall's shape for app-connection tools.
export function describeMcpCall(_name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const input = args as Record<string, unknown>;
  for (const key of ['text', 'url', 'query', 'search', 'name', 'path', 'pattern', 'command', 'title', 'id', 'directory', 'file', 'content']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return `"${value.trim().slice(0, 48)}"`;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

export function diagnosticConfig(message: string): ParsedMcpConfig {
  return { servers: [], diagnostics: [message] };
}

function parseServer(key: string, value: unknown): { config?: McpServerConfig; diagnostic?: string } {
  const skip = (reason: string): { diagnostic: string } => ({ diagnostic: `"${key}" was skipped: ${reason}` });
  if (!isObject(value)) return skip('its settings must be an object.');
  const transport = value.transport === undefined ? 'stdio' : value.transport;
  if (transport !== 'stdio' && transport !== 'http') return skip('unknown transport.');
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== 'boolean') return skip('"enabled" must be true or false.');
  const disabledTools = value.disabledTools === undefined ? [] : value.disabledTools;
  if (!Array.isArray(disabledTools) || disabledTools.some((tool) => typeof tool !== 'string' || !tool)) return skip('"disabledTools" must be a list of tool names.');
  if (transport === 'stdio') {
    if (typeof value.command !== 'string' || !value.command.trim()) return skip('it needs a command to run.');
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string'))) return skip('"args" must be a list of strings.');
    return { config: { transport, command: value.command.trim(), args: Array.isArray(value.args) ? (value.args as string[]) : [], url: null, headers: {}, enabled, disabledTools } };
  }
  if (typeof value.url !== 'string' || !/^https?:\/\//i.test(value.url)) return skip('it needs a web address starting with http(s).');
  const headers = value.headers === undefined ? {} : value.headers;
  if (!isObject(headers) || Object.values(headers).some((header) => typeof header !== 'string')) return skip('"headers" must match names to values.');
  return { config: { transport, command: null, args: [], url: value.url, headers: headers as Record<string, string>, enabled, disabledTools } };
}

// Tolerant parse: a missing file is an empty config (zero servers, no error),
// malformed JSON is reported by the caller via diagnosticConfig, and invalid
// entries are skipped one by one. Unknown fields inside a valid entry are
// preserved for write-back by the backend.
export function parseMcpConfig(input: unknown): ParsedMcpConfig {
  const diagnostics: string[] = [];
  const servers: ParsedMcpServer[] = [];
  if (input === null || input === undefined) return { servers, diagnostics };
  if (!isObject(input)) return diagnosticConfig('The connections file must contain an object.');
  const raw = input.servers;
  if (raw === undefined) return { servers, diagnostics };
  if (!isObject(raw)) return diagnosticConfig('"servers" must list connections by name.');
  for (const [key, value] of Object.entries(raw)) {
    if (!key || key.length > SERVER_KEY_MAX) { diagnostics.push(`A connection name was skipped: names must be 1-${SERVER_KEY_MAX} characters.`); continue; }
    const parsed = parseServer(key, value);
    if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
    else servers.push({ key, config: parsed.config! });
  }
  return { servers, diagnostics };
}
