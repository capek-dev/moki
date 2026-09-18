import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_SERVER_SOURCE, Mcp, mergeToolbags } from '@backend/mcp';
import type { Toolbag } from '@backend/cua';
import { Store } from '@backend/store';
import { describeMcpCall, mcpToolLabel } from '@shared/mcp';
import { parseMcpConfig, requireExposedToolName, sanitizeToolName, serverPrefix, toolMatchesPattern, compactSchema, TOOL_SCHEMA_BUDGET } from '@shared/mcp';

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'moki-mcp-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A real spawn end to end: the config points at this process running the
// inline JSON-RPC server from @backend/mcp.
function fakeServerConfig(extra: Record<string, unknown> = {}) {
  return { transport: 'stdio', command: process.execPath, args: ['-e', FAKE_SERVER_SOURCE], ...extra };
}

// In-process Streamable HTTP MCP server: initialize grants a session id,
// tools/list answers plain JSON, and tools/call replies over SSE so both
// response shapes are exercised. Records the headers it saw per request.
function httpFake() {
  const seen: { session: string | null; auth: string | null }[] = [];
  let inits = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.method !== 'POST') return new Response('noop', { status: 202 });
      const message = await request.json() as { id?: unknown; method?: string; params?: { name?: string } };
      seen.push({ session: request.headers.get('mcp-session-id'), auth: request.headers.get('authorization') });
      if (message.method === 'initialize') { inits++; return Response.json({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'web', version: '1' } } }, { headers: { 'mcp-session-id': 'sess-7' } }); }
      if (message.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search_web', description: 'Search the web.' }] } });
      if (message.method === 'tools/call') {
        const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `web-called:${message.params?.name}` }] } })}\n\n`;
        return new Response(frame, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({ jsonrpc: '2.0', id: message.id, error: { message: 'unsupported' } });
    },
  });
  return { url: `http://localhost:${server.port}`, seen, inits: () => inits, stop: () => server.stop(true) };
}

test('server keys become safe prefixes', () => {
  expect(serverPrefix('filesystem')).toBe('filesystem');
  expect(serverPrefix('café')).toBe('caf-');
  expect(serverPrefix('12306')).toBe('s12306');
  expect(serverPrefix('')).toBe('mcp');
  expect(serverPrefix('a'.repeat(50))).toHaveLength(30);
  expect(serverPrefix('my app!')).toBe('my-app-');
});

test('tool names are sanitized and exposed names validated', () => {
  expect(sanitizeToolName('read note!')).toBe('read_note_');
  expect(sanitizeToolName('readFile')).toBe('readFile');
  expect(sanitizeToolName('a'.repeat(80))).toHaveLength(64);
  expect(requireExposedToolName('fs__read_note')).toBe('fs__read_note');
  expect(() => requireExposedToolName('BAD NAME')).toThrow('Invalid tool name.');
  expect(() => requireExposedToolName('')).toThrow('Invalid tool name.');
  expect(() => requireExposedToolName(42)).toThrow('Invalid tool name.');
});

test('config parse: defaults, invalid entries skipped with diagnostics, unknown fields tolerated', () => {
  const parsed = parseMcpConfig({ servers: {
    fs: { command: 'npx', args: ['-y', 'server-filesystem'], note: 'keep me' },
    remote: { transport: 'http', url: 'https://mcp.pipedream.com/github' },
    broken: { transport: 'carrier-pigeon' },
    nocommand: { transport: 'stdio' },
    badurl: { transport: 'http', url: 'ftp://nope' },
  } });
  expect(parsed.servers.map((server) => server.key)).toEqual(['fs', 'remote']);
  const fs = parsed.servers[0].config;
  expect(fs.transport).toBe('stdio');
  expect(fs.enabled).toBe(true);
  expect(fs.disabledTools).toEqual([]);
  expect(parsed.servers[1].config.transport).toBe('http');
  expect(parsed.diagnostics).toHaveLength(3);
  expect(parsed.diagnostics[0]).toContain('broken');
});

test('missing file is an empty config, malformed JSON is a diagnostic', async () => {
  const { dir, cleanup } = freshDir();
  try {
    const mcp = new Mcp(dir);
    expect((await mcp.tools()).servers).toEqual([]);
    writeFileSync(join(dir, 'mcp.json'), '{not json');
    const state = await mcp.tools();
    expect(state.servers).toEqual([]);
    expect(state.diagnostics[0]).toContain('not valid JSON');
  } finally { cleanup(); }
});

test('catalog fetch spawns, prefixes tool names, and sanitizes messy ones', async () => {
  const { dir, cleanup } = freshDir();
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { notes: fakeServerConfig() } }));
    const state = await new Mcp(dir).tools();
    expect(state.diagnostics).toEqual([]);
    expect(state.servers).toHaveLength(1);
    const server = state.servers[0];
    expect(server.connected).toBe(true);
    expect(server.error).toBeNull();
    expect(server.tools.map((tool) => tool.name)).toEqual(['notes__read_note', 'notes__read_note_']);
  } finally { cleanup(); }
});

test('spawn failures surface a friendly error without failing the whole state', async () => {
  const { dir, cleanup } = freshDir();
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { ghost: { transport: 'stdio', command: '/nonexistent/mcp-binary' } } }));
    const state = await new Mcp(dir).tools();
    expect(state.servers[0].connected).toBe(false);
    expect(state.servers[0].tools).toEqual([]);
    expect(state.servers[0].error).toContain('could not be started');
  } finally { cleanup(); }
});

test('tool toggle writes the config file and preserves unknown fields', async () => {
  const { dir, cleanup } = freshDir();
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { notes: { ...fakeServerConfig(), note: 'keep me' } } }));
    const mcp = new Mcp(dir);
    await mcp.tools();
    const state = mcp.setTool('notes', 'notes__read_note', true);
    expect(state.servers[0].disabledTools).toEqual(['notes__read_note']);
    const saved = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'));
    expect(saved.servers.notes.disabledTools).toEqual(['notes__read_note']);
    expect(saved.servers.notes.note).toBe('keep me');
    expect(mcp.setTool('notes', 'notes__read_note', false).servers[0].disabledTools).toEqual([]);
  } finally { cleanup(); }
});

test('server switch persists, hides tools while off, and reconnects', async () => {
  const { dir, cleanup } = freshDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { notes: fakeServerConfig() } }));
    const mcp = new Mcp(dir);
    await mcp.tools();
    const off = mcp.setServer('notes', false);
    expect(off.servers[0].enabled).toBe(false);
    expect(off.servers[0].tools).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).servers.notes.enabled).toBe(false);
    const back = await mcp.tools();
    expect(back.servers[0].enabled).toBe(false); // still off until re-enabled
    const on = mcp.setServer('notes', true);
    expect(on.servers[0].enabled).toBe(true);
    const reconnected = await mcp.tools();
    expect(reconnected.servers[0].connected).toBe(true);
    expect(reconnected.servers[0].tools.length).toBe(2);
  } finally { cleanup(); }
});

test('unknown server and invalid inputs are rejected', () => {
  const { dir, cleanup } = freshDir();
  try {
    const mcp = new Mcp(dir);
    expect(() => mcp.setServer('ghost', true)).toThrow('Connection not found.');
    expect(() => mcp.setServer('', true)).toThrow('Invalid connection name.');
    expect(() => mcp.setServer('x', 'yes' as unknown as boolean)).toThrow('Invalid toggle value.');
    expect(() => mcp.setTool('x', 'BAD NAME', true)).toThrow('Invalid tool name.');
  } finally { cleanup(); }
});

test('chat labels prettify app-connection tool names and arguments', () => {
  expect(mcpToolLabel('files__read_note')).toBe('Files · Read note');
  expect(mcpToolLabel('github__createIssue')).toBe('Github · Create Issue');
  expect(mcpToolLabel('read_note')).toBe('Read note');
  expect(describeMcpCall('files__read_file', { path: '/tmp/notes.md', other: 1 })).toBe('"/tmp/notes.md"');
  expect(describeMcpCall('x', {})).toBe('');
});

test('deny globs match exposed or bare names; parse validates the list', () => {
  expect(toolMatchesPattern('*', 'files__read', 'read')).toBe(true);
  expect(toolMatchesPattern('read_*', 'files__read_note', 'read_note')).toBe(true);
  expect(toolMatchesPattern('files__*', 'files__read', 'read')).toBe(true);
  expect(toolMatchesPattern('read_*', 'files__write_note', 'write_note')).toBe(false);
  const parsed = parseMcpConfig({ servers: { a: { command: 'x', denyTools: ['move_*', 'exact_name'] } } });
  expect(parsed.servers[0].config.denyTools).toEqual(['move_*', 'exact_name']);
  expect(parseMcpConfig({ servers: { a: { command: 'x', denyTools: 'nope' } } }).diagnostics[0]).toContain('denyTools');
  expect(parseMcpConfig({ servers: { a: { command: 'x', denyTools: [''] } } }).diagnostics[0]).toContain('denyTools');
});

test('compactSchema keeps shape and drops prose recursively', () => {
  const compacted = compactSchema({ type: 'object', description: 'whole-schema prose', properties: { a: { type: 'string', description: 'property prose', enum: ['x', 'y'], title: 'A' }, b: { type: 'object', properties: { c: { type: 'number', description: 'nested prose' } } } }, required: ['a'] });
  expect(compacted).toEqual({ type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'] }, b: { type: 'object', properties: { c: { type: 'number' } } } }, required: ['a'] });
  expect(compactSchema(undefined)).toBeUndefined();
});

test('deny patterns filter tools from state and toolbag alike, and weights are exposed', async () => {
  const { dir, cleanup } = freshDir();
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { notes: fakeServerConfig({ denyTools: ['read_note*'] }) } }));
    const mcp = new Mcp(dir);
    const state = await mcp.tools();
    expect(state.servers[0].tools.map((tool) => tool.name)).toEqual(['notes__read_note_']); // bare 'read_note' denied; the messy one survives
    expect(state.servers[0].weight).toBeGreaterThan(0);
    const bag = await mcp.toolbag();
    expect(bag.tools.map((tool) => tool.name)).toEqual(['notes__read_note_']); // parity: the model sees exactly what Settings shows
    expect(bag.weights).toEqual([{ label: 'notes', weight: state.servers[0].weight }]);
    bag.close();
  } finally { cleanup(); }
});

test('toolbag lists enabled tools with schemas and filters disabled ones', async () => {
  const { dir, cleanup } = freshDir();
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: {
      notes: fakeServerConfig({ disabledTools: ['notes__read_note'] }),
      ghost: { transport: 'stdio', command: '/nonexistent/mcp-binary' },
    } }));
    const bag = await new Mcp(dir).toolbag();
    expect(bag.tools.map((tool) => tool.name)).toEqual(['notes__read_note_']);
    expect(bag.tools[0].inputSchema).toEqual({ type: 'object' }); // schemaless server tool gets a safe default
    bag.close();
  } finally { cleanup(); }
});

test('toolbag execute routes exposed names to server-original names', async () => {
  const { dir, cleanup } = freshDir();
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { notes: fakeServerConfig() } }));
    const bag = await new Mcp(dir).toolbag();
    expect((await bag.execute('notes__read_note', { x: 1 }))).toMatchObject({ text: 'called:read_note:{"x":1}', isError: false });
    expect((await bag.execute('notes__read_note_', {})).text).toBe('called:read note!:{}'); // messy original survives
    expect((await bag.execute('notes__read_note', { fail: true }))).toMatchObject({ text: 'It broke.', isError: true });
    await expect(bag.execute('notes__missing', {})).rejects.toThrow('Unknown tool.');
    bag.close();
    await expect(bag.execute('notes__read_note', {})).rejects.toThrow('connection closed');
  } finally { cleanup(); }
});

test('exposed-name assignment matches between Settings state and the toolbag', async () => {
  const { dir, cleanup } = freshDir();
  try {
    // "café" and "caf-" sanitize to the same prefix, forcing suffix dedupe.
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { 'café': fakeServerConfig(), 'caf-': fakeServerConfig() } }));
    const mcp = new Mcp(dir);
    const state = await mcp.tools();
    const bag = await mcp.toolbag();
    const stateNames = state.servers.flatMap((server) => server.tools.map((tool) => tool.name));
    expect(bag.tools.map((tool) => tool.name)).toEqual(stateNames);
    expect(stateNames.slice(0, 2)).toEqual(['caf-__read_note', 'caf-__read_note_']);
    expect(new Set(stateNames).size).toBe(4); // no silent collisions between the two servers
    bag.close();
  } finally { cleanup(); }
});

test('mergeToolbags routes by name, drops duplicates, and closes every bag', async () => {
  const closed: number[] = [];
  const bag1: Toolbag = {
    tools: [{ name: 'files__read', description: '', inputSchema: { type: 'object' } }, { name: 'shared', description: '', inputSchema: { type: 'object' } }],
    execute: async () => ({ text: 'one', isError: false }),
    close: () => { closed.push(1); },
  };
  const bag2: Toolbag = {
    tools: [{ name: 'shared', description: '', inputSchema: { type: 'object' } }],
    execute: async () => ({ text: 'two', isError: false }),
    close: () => { closed.push(2); },
  };
  const merged = mergeToolbags([bag1, bag2]);
  expect(merged.tools.map((tool) => tool.name)).toEqual(['files__read', 'shared']); // duplicate dropped
  expect((await merged.execute('files__read', {})).text).toBe('one');
  expect((await merged.execute('shared', {})).text).toBe('one'); // first bag wins
  await expect(merged.execute('nope', {})).rejects.toThrow('Unknown tool.');
  merged.close();
  expect(closed.sort()).toEqual([1, 2]); // close reaches every source, filtered or not
});

test('over-budget merges demote heavy sources behind search/call meta-tools', async () => {
  const light: Toolbag = { tools: [{ name: 'light__ping', description: 'Ping.', inputSchema: { type: 'object' } }], weights: [{ label: 'light', weight: 120 }], execute: async () => ({ text: 'pong', isError: false }), close: () => {} };
  expect(mergeToolbags([light]).tools.map((tool) => tool.name)).toEqual(['light__ping']); // under budget: unchanged, no meta-tools
  const heavy: Toolbag = {
    tools: Array.from({ length: 40 }, (_, i) => ({ name: `files__tool_${i}`, description: 'file action', inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'y'.repeat(2000) } } } })),
    weights: [{ label: 'files', weight: TOOL_SCHEMA_BUDGET }],
    execute: async (name) => ({ text: `ran:${name}`, isError: false }),
    close: () => {},
  };
  const merged = mergeToolbags([light, heavy]);
  const names = merged.tools.map((tool) => tool.name);
  expect(names).toContain('light__ping');       // light source stays fully loaded
  expect(names).not.toContain('files__tool_0'); // heavy source no longer ships upfront
  expect(names).toContain('search_tools');      // ...it moved behind the meta-tools
  expect(names).toContain('call_tool');
  // Search finds a demoted tool and returns its schema for the model to use.
  const found = await merged.execute('search_tools', { query: 'tool_7' });
  expect(found.isError).toBe(false);
  expect(found.text).toContain('files__tool_7');
  expect(found.text).toContain('"type":"object"');
  // call_tool routes to the owning bag, which still executes normally.
  expect((await merged.execute('call_tool', { name: 'files__tool_7', arguments: { q: 'x' } })).text).toBe('ran:files__tool_7');
  // Unknown names and missing queries give the model actionable errors.
  expect((await merged.execute('call_tool', { name: 'nope' })).isError).toBe(true);
  expect((await merged.execute('search_tools', {})).isError).toBe(true);
  const none = await merged.execute('search_tools', { query: 'zzzznothing' });
  expect(none.isError).toBe(false); // a normal "nothing found", not a failure
  expect(none.text).toContain('No matching');
  merged.close();
  // A real tool named like a meta-tool wins; the meta name moves aside.
  const collide: Toolbag = { tools: [{ name: 'search_tools', description: 'real tool', inputSchema: { type: 'object' } }], weights: [{ label: 'c', weight: 50 }], execute: async () => ({ text: '', isError: false }), close: () => {} };
  expect(mergeToolbags([collide, heavy]).tools.map((tool) => tool.name)).toContain('search_tools_moki');
});

test('http connections fetch catalogs, carry auth headers, and reuse session ids', async () => {
  const { dir, cleanup } = freshDir();
  const web = httpFake();
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { web: { transport: 'http', url: web.url, headers: { authorization: 'Bearer tok' } } } }));
    const state = await new Mcp(dir).tools();
    const server = state.servers[0];
    expect(server.connected).toBe(true);
    expect(server.tools.map((tool) => tool.name)).toEqual(['web__search_web']);
    expect(web.seen.at(-1)?.session).toBe('sess-7'); // granted id echoed on later requests
    expect(web.seen.every((entry) => entry.auth === 'Bearer tok')).toBe(true);
  } finally { web.stop(); cleanup(); }
});

test('unreachable http connections report a friendly error', async () => {
  const { dir, cleanup } = freshDir();
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { ghostweb: { transport: 'http', url: 'http://127.0.0.1:59999' } } }));
    const state = await new Mcp(dir).tools();
    expect(state.servers[0].connected).toBe(false);
    expect(state.servers[0].error).toContain('could not be reached');
  } finally { cleanup(); }
});

// Pipedream's shape: failures explained in a JSON-RPC error body must reach
// the connection card verbatim instead of a bare status code.
test('jsonrpc error bodies surface as readable connection errors', async () => {
  const { dir, cleanup } = freshDir();
  const grumpy = Bun.serve({
    port: 0,
    fetch: async () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'external user id is required. Please see docs for more info.' } }, { status: 400 }),
  });
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { grumpy: { transport: 'http', url: `http://localhost:${grumpy.port}` } } }));
    const state = await new Mcp(dir).tools();
    expect(state.servers[0].connected).toBe(false);
    expect(state.servers[0].error).toContain('says: external user id is required');
    expect(state.servers[0].needsAuth).toBe(false);
  } finally { grumpy.stop(true); cleanup(); }
});

test('http toolbag executes tools through SSE responses', async () => {
  const { dir, cleanup } = freshDir();
  const web = httpFake();
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { web: { transport: 'http', url: web.url } } }));
    const bag = await new Mcp(dir).toolbag();
    const result = await bag.execute('web__search_web', { q: 'moki' });
    expect(result.text).toBe('web-called:search_web');
    expect(result.isError).toBe(false);
    bag.close();
  } finally { web.stop(); cleanup(); }
});

// Auth-gated server: 401 without a token, full catalog with the overlay.
test('sign-in headers overlay config headers and 401s surface needsAuth', async () => {
  const { dir, cleanup } = freshDir();
  const auths: (string | null)[] = [];
  const guarded = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const auth = request.headers.get('authorization');
      auths.push(auth);
      if (request.method !== 'POST' || auth !== 'Bearer tok') return new Response('denied', { status: 401 });
      const message = await request.json() as { id?: unknown; method?: string };
      if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'guarded' } } });
      if (message.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search_web', description: 'Search.' }] } });
      return Response.json({ jsonrpc: '2.0', id: message.id, error: { message: 'unsupported' } });
    },
  });
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { guarded: { transport: 'http', url: `http://localhost:${guarded.port}` } } }));
    const mcp = new Mcp(dir);
    const denied = await mcp.tools();
    expect(denied.servers[0]).toMatchObject({ connected: false, needsAuth: true, signedIn: false });
    expect(denied.servers[0].error).toContain('Sign in');
    const bag = await mcp.toolbag();
    expect(bag.tools).toEqual([]); // auth-gated servers contribute no tools
    bag.close();
    mcp.setAuthHeaders('guarded', { authorization: 'Bearer tok' });
    const allowed = await mcp.tools();
    expect(allowed.servers[0]).toMatchObject({ connected: true, needsAuth: false, signedIn: true });
    expect(allowed.servers[0].tools.map((tool) => tool.name)).toEqual(['guarded__search_web']);
    mcp.setAuthHeaders('guarded', null);
    const revoked = await mcp.tools();
    expect(revoked.servers[0]).toMatchObject({ signedIn: false, needsAuth: true });
  } finally { guarded.stop(true); cleanup(); }
});

test('addServer writes the config, rejects bad input, and removeServer deletes', () => {
  const { dir, cleanup } = freshDir();
  try {
    const mcp = new Mcp(dir);
    const state = mcp.addServer({ name: 'notes', kind: 'stdio', command: 'bun run server.js --fast' });
    expect(state.servers.map((server) => server.name)).toEqual(['notes']);
    expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).servers.notes).toEqual({ transport: 'stdio', command: 'bun', args: ['run', 'server.js', '--fast'], enabled: true });
    expect(() => mcp.addServer({ name: 'notes', kind: 'stdio', command: 'bun x' })).toThrow('already exists');
    expect(() => mcp.addServer({ name: 'bad/name', kind: 'stdio', command: 'bun x' })).toThrow('no slashes');
    expect(() => mcp.addServer({ name: 'webby', kind: 'http', url: 'ftp://nope' })).toThrow('http(s)');
    expect(() => mcp.addServer({ name: 'webby', kind: 'pigeon' })).toThrow('connection type');
    expect(mcp.removeServer('notes').servers).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).servers).toEqual({});
    expect(() => mcp.removeServer('notes')).toThrow('Connection not found.');
  } finally { cleanup(); }
});

test('store catalog rows roundtrip on fetch and prune with the config', async () => {
  const { dir, cleanup } = freshDir();
  const store = new Store(join(dir, 'moki.sqlite'));
  const web = httpFake();
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { web: { transport: 'http', url: web.url } } }));
    await new Mcp(dir, store).tools();
    expect(JSON.parse(store.mcpCatalog('web')!).tools).toHaveLength(1); // success persisted
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: {} }));
    await new Mcp(dir, store).tools(); // empty config prunes the orphaned row
    expect(store.mcpCatalog('web')).toBeNull();
  } finally { web.stop(); store.close(); cleanup(); }
});

test('warm turns skip the round trip; explicit tools() refreshes; cache survives restarts', async () => {
  const { dir, cleanup } = freshDir();
  const store = new Store(join(dir, 'moki.sqlite'));
  const web = httpFake();
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { web: { transport: 'http', url: web.url } } }));
    await new Mcp(dir, store).tools();          // fetch 1, persisted
    expect(web.inits()).toBe(1);
    const bag = await new Mcp(dir, store).toolbag(); // fresh instance, shared store: restart-shaped
    expect(bag.tools.map((tool) => tool.name)).toEqual(['web__search_web']); // served warm
    expect(web.inits()).toBe(1);                // no round trip for the turn
    bag.close();
    await new Mcp(dir, store).tools();          // Settings-style refresh
    expect(web.inits()).toBe(2);
  } finally { web.stop(); store.close(); cleanup(); }
});

test('failing servers degrade to their last known catalog, marked stale', async () => {
  const { dir, cleanup } = freshDir();
  const store = new Store(join(dir, 'moki.sqlite'));
  let broken = false;
  const flaky = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (broken) return new Response('down', { status: 500 });
      const message = await request.json() as { id?: unknown; method?: string };
      if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'flaky' } } });
      if (message.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search_web', description: 'Search.' }] } });
      return Response.json({ jsonrpc: '2.0', id: message.id, error: { message: 'unsupported' } });
    },
  });
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { flaky: { transport: 'http', url: `http://localhost:${flaky.port}` } } }));
    const mcp = new Mcp(dir, store);
    const healthy = await mcp.tools();
    expect(healthy.servers[0]).toMatchObject({ connected: true, stale: false });
    broken = true;
    const degraded = await mcp.tools();      // live fetch fails; last known serves
    expect(degraded.servers[0]).toMatchObject({ connected: true, stale: true });
    expect(degraded.servers[0].tools.map((tool) => tool.name)).toEqual(['flaky__search_web']);
    expect(degraded.servers[0].error).toBeNull();
    const bag = await mcp.toolbag();          // degraded entries stay warm for the TTL window
    expect(bag.tools.map((tool) => tool.name)).toEqual(['flaky__search_web']);
    bag.close();
    // The good durable entry was never overwritten by the failure: a fresh
    // instance (restart-shaped) still degrades to real tools, not emptiness.
    const state2 = await new Mcp(dir, store).tools();
    expect(state2.servers[0]).toMatchObject({ connected: true, stale: true });
    expect(state2.servers[0].tools.map((tool) => tool.name)).toEqual(['flaky__search_web']);
  } finally { flaky.stop(true); store.close(); cleanup(); }
});

test('auth-header changes invalidate the cache; identical pushes do not', async () => {
  const { dir, cleanup } = freshDir();
  const store = new Store(join(dir, 'moki.sqlite'));
  let inits = 0;
  const guarded = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.method !== 'POST') return new Response('denied', { status: 401 });
      const message = await request.json() as { id?: unknown; method?: string };
      const authed = request.headers.get('authorization') === 'Bearer tok';
      if (message.method === 'initialize') {
        inits++; // every attempt counts, authenticated or not
        if (!authed) return new Response('denied', { status: 401 });
        return Response.json({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'guarded' } } });
      }
      if (!authed) return new Response('denied', { status: 401 });
      if (message.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search_web', description: 'Search.' }] } });
      return Response.json({ jsonrpc: '2.0', id: message.id, error: { message: 'unsupported' } });
    },
  });
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { guarded: { transport: 'http', url: `http://localhost:${guarded.port}` } } }));
    const mcp = new Mcp(dir, store);
    await mcp.tools();                         // needsAuth; never persisted
    expect(inits).toBe(1);
    expect(store.mcpCatalog('guarded')).toBeNull();
    mcp.setAuthHeaders('guarded', { authorization: 'Bearer tok' }); // sign-in: change → invalidate
    let bag = await mcp.toolbag();             // refetch succeeds and persists
    expect(bag.tools.map((tool) => tool.name)).toEqual(['guarded__search_web']);
    expect(inits).toBe(2);
    bag.close();
    mcp.setAuthHeaders('guarded', { authorization: 'Bearer tok' }); // identical push: no wipe
    bag = await mcp.toolbag();
    expect(bag.tools.length).toBe(1);
    expect(inits).toBe(2);                     // served warm
    bag.close();
    mcp.setAuthHeaders('guarded', null);       // sign-out: invalidate and refetch
    bag = await mcp.toolbag();
    expect(bag.tools).toEqual([]);
    expect(inits).toBe(3);
    bag.close();
  } finally { guarded.stop(true); store.close(); cleanup(); }
});
