import { expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { resolveConfig, type Plugin } from 'vite';
import config from '@scripts/vite.config';
import { DEV_ORIGIN, isDevelopment } from '@shared/development';

test('development requires an explicit flag and cannot activate in a packaged app', () => {
  expect(isDevelopment(false, '1')).toBe(true);
  for (const value of [undefined, '', 'true', '0']) expect(isDevelopment(false, value)).toBe(false);
  expect(isDevelopment(true, '1')).toBe(false);
  expect(DEV_ORIGIN).toBe('http://127.0.0.1:5173');
});

test('Vite configuration is loopback-only and refuses port fallback', async () => {
  // Resolve configuration only: no server, socket or Electron process is created.
  const resolved = await resolveConfig({ ...config, configFile: false }, 'serve');
  expect(resolved.server).toMatchObject({ host: '127.0.0.1', port: 5173, strictPort: true, cors: false });
  expect(resolved.isProduction).toBe(false);
  expect(resolved.plugins.some((plugin) => plugin.name.includes('react'))).toBe(true);
  expect(resolved.plugins.some((plugin) => plugin.name.includes('tailwind'))).toBe(true);
});

test('only Vite HTML gains source entry points and refresh CSP allowances', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8');
  const plugin = config.plugins!.flat().find((item) => (item as Plugin)?.name === 'moki-development-html') as Plugin;
  const transform = plugin.transformIndexHtml as { handler: (html: string) => string };
  const dev = transform.handler(html);
  expect(dev).toContain('./entry.tsx');
  expect(dev).toContain('./styles/tailwind.css');
  expect(dev).toContain("connect-src 'self' ws://127.0.0.1:5173");
  expect(dev).toContain("script-src 'self' 'unsafe-inline'");
  const production = readFileSync('dist/renderer/index.html', 'utf8');
  expect(production).toBe(html);
  expect(production).toContain("connect-src 'none'");
  expect(production).not.toContain("script-src 'self' 'unsafe-inline'");
});

test('dev build has an isolated entry point, runtime and Electron source maps', () => {
  const pkg = JSON.parse(readFileSync('dist/dev/package.json', 'utf8'));
  expect(pkg).toMatchObject({ name: 'moki-dev', main: 'dist/electron/main.cjs' });
  for (const file of ['dist/electron/main.cjs', 'dist/electron/main.cjs.map', 'dist/electron/preload.cjs', 'dist/backend/moki-runtime']) {
    expect(existsSync('dist/dev/' + file)).toBe(true);
  }
  expect(existsSync('dist/backend/moki-runtime')).toBe(true);
});
