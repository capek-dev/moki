// One-shot native credential bridge for the explicitly approved Jev evaluator.
// The key crosses only a private stdin pipe and is never printed or placed in argv.
const { app, safeStorage } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { spawn } = require('node:child_process');

app.setName('Moki Dev');
app.setPath('userData', join(homedir(), 'Library', 'Application Support', 'Moki Dev'));
app.whenReady().then(() => {
  if (process.argv.at(-1) !== '--approved-live' || !safeStorage.isEncryptionAvailable()) throw new Error();
  const saved = JSON.parse(safeStorage.decryptString(readFileSync(join(app.getPath('userData'), 'tool-loading.encrypted'))));
  if (typeof saved.key !== 'string' || !saved.key.trim()) throw new Error();
  const child = spawn('bun', ['run', 'scripts/memory-jev-eval.ts', '--approved-live'], { cwd: process.cwd(), stdio: ['pipe', 'inherit', 'inherit'] });
  const timer = setTimeout(() => { child.kill(); app.exit(1); }, 150000);
  child.stdin.on('error', () => {});
  child.on('error', () => { clearTimeout(timer); console.error('Could not start the live Jev evaluator.'); app.exit(1); });
  child.on('exit', (code) => { clearTimeout(timer); app.exit(code ?? 1); });
  child.stdin.end(saved.key);
}).catch(() => {
  console.error('Saved TypeSafe key could not be opened; no API requests were made.');
  app.exit(1);
});
