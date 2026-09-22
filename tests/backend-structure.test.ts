import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';

const backendRoot = 'src/backend';
const concernDirectories = [
  'core',
  'integrations',
  'learning',
  'memory',
  'providers',
  'session-search',
  'storage',
  'tools',
];

test('backend implementation files stay grouped by concern', () => {
  const entries = readdirSync(backendRoot, { withFileTypes: true });
  const rootFiles = entries.filter(entry => entry.isFile()).map(entry => entry.name).sort();
  const directories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

  expect(rootFiles).toEqual(['index.ts']);
  expect(directories).toEqual(concernDirectories);
});
