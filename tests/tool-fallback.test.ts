import { expect, test } from 'bun:test';
import { namesOnlyToolbag } from '@backend/tools/fallback';
import { smartToolbag } from '@backend/tools/scoring';
import type { Toolbag } from '@backend/integrations/cua';

function source(names: string[]): Toolbag {
  return { tools: names.map(name => ({ name, description: 'private-description-marker', inputSchema: { type: 'object', schemaMarker: true } })), close() {}, execute: async name => ({ text: name, isError: false }) };
}
test('fallback ships only stable discovery helpers with complete local routing', async () => {
  const bag = namesOnlyToolbag([source(['files__read', 'search_tools', 'call_tool'])]);
  expect(bag.tools.map(t => t.name)).toEqual(['search_tools', 'call_tool']);
  expect(bag.selectedTools).toEqual([]);
  expect(JSON.stringify(bag.tools)).not.toContain('private-description-marker');
  expect(JSON.stringify(bag.tools)).not.toContain('schemaMarker');
  expect(JSON.stringify(bag.tools)).not.toContain('files__read');
  const result = JSON.parse((await bag.execute('search_tools', { query: 'files__read' })).text);
  expect(result.tools[0].inputSchema.schemaMarker).toBe(true);
  expect((await bag.execute('call_tool', { name: 'files__read' })).text).toBe('files__read');
  expect((await bag.execute('call_tool', { name: 'search_tools' })).text).toBe('search_tools');
  expect((await bag.execute('call_tool', { name: 'call_tool' })).text).toBe('call_tool');
});
test('large catalogs do not change provider declarations and remain searchable', async () => {
  const names = Array.from({ length: 2500 }, (_, i) => `tool_${String(i).padStart(4, '0')}_${'界'.repeat(12)}`);
  const bag = namesOnlyToolbag([source(names)]);
  const last = names.at(-1)!;
  expect(JSON.stringify(bag.tools)).not.toContain(names[0]);
  expect(JSON.parse((await bag.execute(bag.tools[0].name, { query: last })).text).tools[0].name).toBe(last);
  expect((await bag.execute(bag.tools[1].name, { name: last })).text).toBe(last);
});
test('disabled and missing-key paths never call Jev or ship dynamic schemas', async () => {
  for (const config of [{ enabled: false, maxDirect: 12, key: 'saved' }, { enabled: true, maxDirect: 12 }]) {
    let called = false;
    const bag = await smartToolbag([source(['list_apps'])], { request: 'List apps', recent: '' }, config, new AbortController().signal, {
      fetch: async () => { called = true; throw new Error(); }, diagnostic() {},
    });
    expect(called).toBe(false);
    expect(bag.tools.map(t => t.name)).toEqual(['search_tools', 'call_tool']);
    expect(bag.selectedTools).toEqual([]);
    expect(JSON.stringify(bag.tools)).not.toContain('list_apps');
    expect(JSON.stringify(bag.tools)).not.toContain('schemaMarker');
  }
});
test('empty catalog keeps stable routers with unavailable results', async () => {
  const bag = namesOnlyToolbag([]);
  expect(bag.tools.map(tool => tool.name)).toEqual(['search_tools', 'call_tool']);
  expect(bag.selectedTools).toEqual([]);
  const search = JSON.parse((await bag.execute('search_tools', { query: 'anything' })).text);
  expect(search).toMatchObject({ tools: [], oversized: [], note: 'No matching tools. Try different words.' });
  expect(await bag.execute('call_tool', { name: 'anything' })).toMatchObject({ isError: true });
});
