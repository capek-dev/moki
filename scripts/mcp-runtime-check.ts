// E2E check for the MCP client slice against the compiled runtime. Writes a
// config pointing at a real spawned stdio server, pipes mcp requests, and
// closes stdin immediately to exercise the quit-during-catalog-fetch teardown
// race. Run: bun scripts/build.ts && bun scripts/mcp-runtime-check.ts
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

writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: {
  notes: { transport: 'stdio', command: process.execPath, args: ['-e', MINIMAL_SERVER] },
  ghost: { transport: 'stdio', command: '/nonexistent/mcp-binary' },
  remote: { transport: 'http', url: 'https://mcp.pipedream.com/github' },
} }));

const requests = [
  { id: '1', request: { method: 'mcpTools' } },
  { id: '2', request: { method: 'mcpSetTool', server: 'notes', tool: 'notes__read_note', disabled: true } },
  { id: '3', request: { method: 'mcpSetTool', server: 'notes', tool: 'BAD NAME', disabled: true } },
  { id: '4', request: { method: 'mcpSetServer', server: 'notes', enabled: false } },
  { id: '5', request: { method: 'mcpTools' } },
  { id: '6', request: { method: 'mcpSetServer', server: 'notes', enabled: true } },
  { id: '7', request: { method: 'mcpTools' } },
];

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
child.stdin.end();
const exitCode = await new Promise<number>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('runtime did not exit within 20s')), 20000);
  child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? -1); });
});
const lines = out.trim().split('\n').filter(Boolean);
const responses = new Map(lines.map((line) => { const message = JSON.parse(line); return [message.id, message]; }));
const catalog = responses.get('1')?.result?.mcp as { servers?: { name: string; connected?: boolean; tools?: { name: string }[]; error?: string | null }[] } | undefined;
const notes = catalog?.servers?.find((server) => server.name === 'notes');
const ghost = catalog?.servers?.find((server) => server.name === 'ghost');
const remote = catalog?.servers?.find((server) => server.name === 'remote');
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
  remoteMarkedUnsupported: remote?.connected === false && typeof remote?.error === 'string',
  disabledAfterToggle: toggle?.servers?.find((server) => server.name === 'notes')?.disabledTools,
  invalidNameRejected: invalid?.error === 'Invalid tool name.',
  hiddenWhileOff: off?.servers?.find((server) => server.name === 'notes')?.tools?.length === 0,
  reconnectedAfterEnable: reconnected?.servers?.find((server) => server.name === 'notes')?.connected === true,
  stderr: err.slice(0, 200),
};
console.log(JSON.stringify(summary, null, 2));
rmSync(dir, { recursive: true, force: true });
if (summary.exitCode !== 0 || !summary.notesConnected || !summary.notesTools?.length || !summary.ghostFriendlyError || !summary.remoteMarkedUnsupported || !summary.hiddenWhileOff || !summary.reconnectedAfterEnable) process.exit(1);
