import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_SERVER_SOURCE, Mcp, mergeToolbags } from '@backend/mcp';
import type { Toolbag } from '@backend/cua';
import { describeMcpCall, mcpToolLabel } from '@shared/mcp';
import { parseMcpConfig, requireExposedToolName, sanitizeToolName, serverPrefix } from '@shared/mcp';

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'moki-mcp-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A real spawn end to end: the config points at this process running the
// inline JSON-RPC server from @backend/mcp.
function fakeServerConfig(extra: Record<string, unknown> = {}) {
  return { transport: 'stdio', command: process.execPath, args: ['-e', FAKE_SERVER_SOURCE], ...extra };
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
