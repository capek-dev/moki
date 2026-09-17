// E2E check for the Cua settings slice against the compiled runtime.
// Pipes cua requests and closes stdin immediately, which exercises the
// quit-during-catalog-fetch teardown race. Run: bun scripts/cua-runtime-check.ts
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const requests = [
  { id: '1', request: { method: 'cuaTools' } },
  { id: '2', request: { method: 'cuaSetTool', tool: 'zoom', disabled: true } },
  { id: '3', request: { method: 'cuaSetTool', tool: 'BAD NAME', disabled: true } },
  { id: '4', request: { method: 'cuaSetEnabled', enabled: false } },
  { id: '5', request: { method: 'cuaTools' } },
  { id: '6', request: { method: 'cuaSetEnabled', enabled: true } },
  { id: '7', request: { method: 'cuaTools' } },
];
const dir = mkdtempSync(join(tmpdir(), 'moki-cua-e2e-'));
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
const catalog = responses.get('1')?.result?.cua as { connected?: boolean; version?: string; tools?: unknown[] } | undefined;
const toggle = responses.get('2')?.result?.cua as { disabled?: string[] } | undefined;
const invalid = responses.get('3');
const off = responses.get('5')?.result?.cua as { enabled?: boolean; connected?: boolean; tools?: unknown[]; disabled?: string[]; error?: string | null } | undefined;
const reconnect = responses.get('7')?.result?.cua as { enabled?: boolean; connected?: boolean; tools?: unknown[] } | undefined;
const summary = {
  exitCode,
  seconds: ((Date.now() - started) / 1000).toFixed(1),
  ready: JSON.parse(lines[0]).event === 'ready',
  catalogConnected: catalog?.connected,
  catalogVersion: catalog?.version,
  toolCount: catalog?.tools?.length,
  disabledAfterToggle: toggle?.disabled,
  invalidNameRejected: invalid?.error === 'Invalid tool name.',
  disconnectedWhileOff: off?.enabled === false && off?.connected === false && off?.tools?.length === 0 && off?.error === null,
  filtersPreservedWhileOff: off?.disabled?.includes('zoom') === true,
  reconnectedAfterEnable: reconnect?.enabled === true && reconnect?.connected === true && !!reconnect?.tools?.length,
  stderr: err.slice(0, 200),
};
console.log(JSON.stringify(summary, null, 2));
rmSync(dir, { recursive: true, force: true });
if (summary.exitCode !== 0 || !summary.catalogConnected || !summary.toolCount || !summary.disconnectedWhileOff || !summary.reconnectedAfterEnable) process.exit(1);
