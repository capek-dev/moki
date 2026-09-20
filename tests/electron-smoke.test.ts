import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const launcher = readFileSync('scripts/electron-smoke.ts', 'utf8');
const main = readFileSync('src/electron/main.ts', 'utf8');

test('Electron smoke is opt-in, isolated, and starts with no provider credentials', () => {
  expect(launcher).toContain("Bun.argv[2] === '--run'");
  expect(launcher).toContain("mkdtempSync(join(tmpdir(), 'moki-electron-smoke-'))");
  expect(launcher).toContain("MOKI_SMOKE_DATA_DIR: dataDir");
  expect(launcher).toContain("MOKI_MEMORY_ENABLED: ''");
  expect(launcher).toContain('smokeEnvironment(dataDir)');
  expect(launcher).not.toContain('...process.env');
  expect(launcher).toContain('providerCredentials: false');
  expect(main).toContain("process.env.MOKI_SMOKE === '1'");
  expect(main).toContain("window.webContents.once('did-finish-load', () => app.quit())");
  expect(main).toContain("MOKI_SMOKE_DATA_DIR must be an absolute path.");
  expect(launcher).toContain('stream.resume();');
  expect(launcher).toContain("signalProcessTree(child, 'SIGTERM')");
  expect(launcher).toContain("signalProcessTree(child, 'SIGKILL')");
  expect(launcher).toContain('await waitForPipeClose(child);');
  expect(launcher).toContain('cleanup = cleanupDataDir(dataDir);');
});
