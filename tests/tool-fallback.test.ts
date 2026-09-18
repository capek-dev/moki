import { expect, test } from 'bun:test';
import { namesOnlyToolbag, FALLBACK_NAMES_BYTES } from '../src/backend/tool-fallback';
import { smartToolbag } from '../src/backend/tool-scoring';
import type { Toolbag } from '../src/backend/cua';

function source(names: string[]): Toolbag {
  return { tools: names.map(name => ({ name, description: 'private-description-marker', inputSchema: { type: 'object', schemaMarker: true } })), close() {}, execute: async name => ({ text: name, isError: false }) };
}
test('fallback ships only names and discovery helpers, with complete local routing', async () => {
  const bag = namesOnlyToolbag([source(['files__read', 'search_tools', 'call_tool'])]);
  expect(bag.tools.map(t => t.name)).toEqual(['search_tools_moki_1', 'call_tool_moki_1']);
  expect(JSON.stringify(bag.tools)).not.toContain('private-description-marker');
  expect(JSON.stringify(bag.tools)).not.toContain('schemaMarker');
  const result = JSON.parse((await bag.execute('search_tools_moki_1', { query: 'files__read' })).text);
  expect(result.tools[0].inputSchema.schemaMarker).toBe(true);
  expect((await bag.execute('call_tool_moki_1', { name: 'files__read' })).text).toBe('files__read');
});
test('UTF-8 serialized names index is capped at 60,000 bytes; omitted names remain searchable', async () => {
  const names = Array.from({ length: 2500 }, (_, i) => `tool_${String(i).padStart(4, '0')}_${'界'.repeat(12)}`);
  const bag = namesOnlyToolbag([source(names)]);
  const index = bag.tools[0].description.split('Available tool names (JSON): ')[1].split('\n')[0];
  const listed = JSON.parse(index) as string[];
  expect(Buffer.byteLength(index)).toBeLessThanOrEqual(FALLBACK_NAMES_BYTES);
  expect(listed.length).toBeLessThan(names.length);
  const omitted = names.find(name => !listed.includes(name))!;
  expect(JSON.parse((await bag.execute(bag.tools[0].name, { query: omitted })).text).tools[0].name).toBe(omitted);
  expect((await bag.execute(bag.tools[1].name, { name: omitted })).text).toBe(omitted);
});
test('disabled and missing-key paths never call Jev or ship direct schemas', async () => {
  for (const config of [{ enabled: false, maxDirect: 12, key: 'saved' }, { enabled: true, maxDirect: 12 }]) {
    let called = false;
    const bag = await smartToolbag([source(['list_apps'])], { request: 'List apps', recent: '' }, config, new AbortController().signal, {
      fetch: async () => { called = true; throw new Error(); }, diagnostic() {},
    });
    expect(called).toBe(false);
    expect(bag.tools.map(t => t.name)).toEqual(['search_tools', 'call_tool']);
    expect(bag.tools[0].description).toContain('list_apps');
    expect(JSON.stringify(bag.tools)).not.toContain('schemaMarker');
  }
});
test('empty catalog stays empty', () => {
  expect(namesOnlyToolbag([]).tools).toEqual([]);
});
