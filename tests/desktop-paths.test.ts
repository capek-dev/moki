import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Inspect the actual emitted main process: source-only tests missed Bun's
// replacement of __dirname with the original source directory.
test('built desktop resolves assets from Electron instead of source paths', () => {
  const main = readFileSync(resolve('dist/electron/main.cjs'), 'utf8');
  expect(main).toContain('app.getAppPath()');
  expect(main).not.toMatch(/\b(?:var|let|const) __dirname\s*=/);
  expect(main).not.toContain(resolve('src/electron'));
  for (const asset of ['dist/renderer/index.html', 'dist/electron/preload.cjs', 'dist/backend/moki-runtime']) {
    expect(main).toContain(JSON.stringify(asset));
    expect(existsSync(resolve(asset))).toBe(true);
  }
  expect(main).toContain('process.resourcesPath');
  expect(main).toContain('"backend/moki-runtime"');
});
