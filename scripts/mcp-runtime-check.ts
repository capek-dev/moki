// E2E check for the MCP client against the compiled runtime, including the
// sign-in overlay: the guarded web server 401s every request until a pushed
// Bearer header arrives over the runtime pipe (the same push Electron main
// makes after a browser sign-in). Run: bun scripts/build.ts && bun scripts/mcp-runtime-check.ts
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'moki-mcp-e2e-'));

// Newline-delimited JSON-RPC MCP server: answers initialize and tools/list.
const MINIMAL_SERVER = `
const { createInterface } = require('node:readline');
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') reply(message.id, { serverInfo: { name: 'notes', version: '1.0.0' } });
  else if (message.method === 'tools/list') reply(message.id, { tools: [{ name: 'read_note', description: 'Read a note.' }, { name: 'write_note', description: 'Write a note.' }] });
});
`;

// Guarded Streamable HTTP server: 401 for everything until the pushed sign-in
// header appears, then a normal catalog.
const guarded = Bun.serve({
  port: 0,
  fetch: async (request) => {
    if (request.method !== 'POST' || request.headers.get('authorization') !== 'Bearer tok') return new Response('denied', { status: 401 });
    const message = await request.json() as { id?: unknown; method?: string };
    if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'guarded', version: '1.0.0' } } });
    if (message.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search_web', description: 'Search the web.' }] } });
    return Response.json({ jsonrpc: '2.0', id: message.id, error: { message: 'unsupported' } });
  },
});

writeFileSync(join(dir, 'server.js'), MINIMAL_SERVER);
writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: {
  notes: { transport: 'stdio', command: process.execPath, args: ['-e', MINIMAL_SERVER] },
  ghost: { transport: 'stdio', command: '/nonexistent/mcp-binary' },
  remote: { transport: 'http', url: `http://localhost:${guarded.port}` },
} }));

const requests = [
  { id: '1', request: { method: 'mcpTools' } },
  { id: '2', request: { method: 'mcpSetTool', server: 'notes', tool: 'notes__read_note', disabled: true } },
  { id: '3', request: { method: 'mcpSetTool', server: 'notes', tool: 'BAD NAME', disabled: true } },
  { id: '4', request: { method: 'mcpSetServer', server: 'notes', enabled: false } },
  { id: '5', request: { method: 'mcpTools' } },
  { id: '6', request: { method: 'mcpSetServer', server: 'notes', enabled: true } },
  { id: '7', request: { method: 'mcpTools' } },
  { id: '8', request: { method: 'mcpAddServer', name: 'extra', kind: 'stdio', command: `${process.execPath} ${join(dir, 'server.js')}` } },
  { id: '9', request: { method: 'mcpRemoveServer', server: 'extra' } },
];
// Sent after the push event below, so the last catalog fetch runs signed in.
const afterAuth = { id: '10', request: { method: 'mcpTools' } };
// The event Electron main pushes after a browser sign-in lands in the vault.
const push = { event: 'mcp-auth', server: 'remote', headers: { authorization: 'Bearer tok' } };

const child = spawn('./dist/backend/moki-runtime', [], {
  env: { ...process.env, MOKI_DATA_DIR: dir },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let out = '';
let err = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { err += chunk; });
const started = Date.now();
child.stdin.write(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
child.stdin.write(JSON.stringify(push) + '\n');
child.stdin.write(JSON.stringify(afterAuth) + '\n');
child.stdin.end();
const exitCode = await new Promise<number>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('runtime did not exit within 20s')), 20000);
  child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? -1); });
});
guarded.stop(true);
const lines = out.trim().split('\n').filter(Boolean);
const responses = new Map(lines.map((line) => { const message = JSON.parse(line); return [message.id, message]; }));
const catalog = responses.get('1')?.result?.mcp as { servers?: { name: string; connected?: boolean; needsAuth?: boolean; tools?: { name: string }[]; error?: string | null }[] } | undefined;
const notes = catalog?.servers?.find((server) => server.name === 'notes');
const ghost = catalog?.servers?.find((server) => server.name === 'ghost');
const remote = catalog?.servers?.find((server) => server.name === 'remote');
const after = responses.get('10')?.result?.mcp as { servers?: { name: string; connected?: boolean; needsAuth?: boolean; signedIn?: boolean; tools?: { name: string }[] }[] } | undefined;
const added = responses.get('8')?.result?.mcp as { servers?: { name: string; connected?: boolean; tools?: unknown[] }[] } | undefined;
const removed = responses.get('9')?.result?.mcp as { servers?: { name: string }[] } | undefined;
const toggle = responses.get('2')?.result?.mcp as { servers?: { name: string; disabledTools?: string[] }[] } | undefined;
const invalid = responses.get('3');
const off = responses.get('5')?.result?.mcp as { servers?: { name: string; enabled?: boolean; tools?: unknown[] }[] } | undefined;
const reconnected = responses.get('7')?.result?.mcp as { servers?: { name: string; connected?: boolean; tools?: unknown[] }[] } | undefined;
const summary = {
  exitCode,
  seconds: ((Date.now() - started) / 1000).toFixed(1),
  ready: JSON.parse(lines[0]).event === 'ready',
  notesConnected: notes?.connected,
  notesTools: notes?.tools?.map((tool) => tool.name),
  ghostFriendlyError: typeof ghost?.error === 'string' && ghost.error.includes('could not be started'),
  remoteNeedsAuth: remote?.connected === false && remote?.needsAuth === true && typeof remote?.error === 'string' && remote.error.includes('Sign in'),
  remoteConnectedAfterAuth: after?.servers?.find((server) => server.name === 'remote')?.connected === true,
  remoteSignedInAfterAuth: after?.servers?.find((server) => server.name === 'remote')?.signedIn === true,
  remoteToolsAfterAuth: after?.servers?.find((server) => server.name === 'remote')?.tools?.map((tool) => tool.name),
  addServerConnected: added?.servers?.find((server) => server.name === 'extra')?.connected === true,
  removeServerGone: !removed?.servers?.some((server) => server.name === 'extra'),
  disabledAfterToggle: toggle?.servers?.find((server) => server.name === 'notes')?.disabledTools,
  invalidNameRejected: invalid?.error === 'Invalid tool name.',
  hiddenWhileOff: off?.servers?.find((server) => server.name === 'notes')?.tools?.length === 0,
  reconnectedAfterEnable: reconnected?.servers?.find((server) => server.name === 'notes')?.connected === true,
  stderr: err.slice(0, 200),
};
console.log(JSON.stringify(summary, null, 2));
rmSync(dir, { recursive: true, force: true });
if (summary.exitCode !== 0 || !summary.notesConnected || !summary.notesTools?.length || !summary.ghostFriendlyError || !summary.remoteNeedsAuth || !summary.remoteConnectedAfterAuth || !summary.remoteSignedInAfterAuth || !summary.remoteToolsAfterAuth?.length || !summary.hiddenWhileOff || !summary.reconnectedAfterEnable || !summary.addServerConnected || !summary.removeServerGone) process.exit(1);
