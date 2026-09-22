import { expect, test } from 'bun:test';
import { descriptorBatches, selectedToolbag, type ToolScore } from '@backend/tools/selection';
import type { AgentToolDef, Toolbag } from '@backend/integrations/cua';

const tool = (name: string, description = name): AgentToolDef => ({ name, description, inputSchema: { type: 'object' } });
const score = (name: string): ToolScore => ({ name, score: 1.7, probabilities: [0, 0.3, 0.7, 0] });
function source(tools: AgentToolDef[]) {
  const calls: unknown[] = [];
  let closes = 0;
  const bag: Toolbag = { tools, execute: async (name, args) => { calls.push({ name, args }); return { text: name, isError: false }; }, close: () => { closes++; } };
  return { bag, calls, closes: () => closes };
}

test('320 descriptors contain short prose only, at most 16 per batch', () => {
  const tools = Array.from({ length: 320 }, (_, i) => ({ ...tool(`app__${i}`, 'description '.repeat(1000)), inputSchema: { secretSchemaMarker: 'x'.repeat(50000) } }));
  const batches = descriptorBatches(tools);
  expect(batches).toHaveLength(20);
  expect(batches.flat()).toHaveLength(320);
  for (const batch of batches) {
    expect(batch.length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(batch).length).toBeLessThan(6000);
    for (const descriptor of batch) {
      expect(Object.keys(descriptor)).toEqual(['name', 'description']);
      expect(descriptor.description.length).toBeLessThanOrEqual(240);
    }
  }
  expect(JSON.stringify(batches)).not.toContain('secretSchemaMarker');
});

test('probability qualifies mean 1.7, stable ties and no filling rejected slots', () => {
  const { bag } = source([tool('b'), tool('a'), tool('c')]);
  const selected = selectedToolbag([bag], [score('b'), score('a'), { name: 'c', score: 1, probabilities: [0, 1, 0, 0] }]);
  expect(selected.tools.map(t => t.name)).toEqual(['search_tools', 'call_tool']);
  expect(selected.selectedTools?.map(t => t.name)).toEqual(['a', 'b']);
  expect(selectedToolbag([bag], [score('a'), score('b')], { maxDirect: 1 }).selectedTools?.map(t => t.name)).toEqual(['a']);
});

test('unscored tools stay searchable and X=0 preserves indirect execution', async () => {
  const { bag, calls } = source([tool('email'), tool('drive')]);
  const selected = selectedToolbag([bag], [score('email')], { maxDirect: 0 });
  expect(selected.tools).toHaveLength(2);
  expect(selected.selectedTools).toEqual([]);
  expect(JSON.parse((await selected.execute('search_tools', { query: 'drive' })).text).tools[0].name).toBe('drive');
  await selected.execute('call_tool', { name: 'drive', arguments: { path: 'x' } });
  expect(calls).toEqual([{ name: 'drive', args: { path: 'x' } }]);
  expect((await selected.execute('call_tool', { name: 'disabled' })).isError).toBe(true);
});

test('reserved routers stay fixed while colliding catalog tools remain indirectly callable', async () => {
  const { bag, calls, closes } = source([tool('email'), tool('search_tools'), tool('call_tool')]);
  const selected = selectedToolbag([bag], [score('email')]);
  expect(selected.tools.map(t => t.name)).toEqual(['search_tools', 'call_tool']);
  expect(selected.selectedTools?.map(t => t.name)).toEqual(['email']);
  await expect(selected.execute('email', { id: 1 })).rejects.toThrow('Unknown routing tool');
  await selected.execute('call_tool', { name: 'email', arguments: { id: 2 } });
  await selected.execute('call_tool', { name: 'search_tools', arguments: { external: true } });
  await selected.execute('call_tool', { name: 'call_tool', arguments: { external: true } });
  expect(calls).toEqual([
    { name: 'email', args: { id: 2 } },
    { name: 'search_tools', args: { external: true } },
    { name: 'call_tool', args: { external: true } },
  ]);
  selected.close(); selected.close();
  expect(closes()).toBe(1);
  await expect(selected.execute('call_tool', {})).rejects.toThrow('closed');
});

test('exact serialized budget includes helpers and skips oversized ranked tools', () => {
  const { bag } = source([tool('large', 'x'.repeat(30000)), tool('small')]);
  const selected = selectedToolbag([bag], [score('large'), score('small')]);
  expect(selected.tools.map(t => t.name)).toEqual(['search_tools', 'call_tool']);
  expect(selected.selectedTools?.map(t => t.name)).toEqual(['small']);
  const exact = JSON.stringify([...(selected.selectedTools ?? []), ...selected.tools]).length;
  expect(selectedToolbag([bag], [score('small')], { schemaChars: exact }).selectedTools).toHaveLength(1);
  expect(selectedToolbag([bag], [score('small')], { schemaChars: exact - 1 }).selectedTools).toHaveLength(0);
});

test('invalid policies, probabilities and score identities fail closed', () => {
  const { bag } = source([tool('a')]);
  for (const maxDirect of [-1, 1.1, 65, NaN]) expect(() => selectedToolbag([bag], [], { maxDirect })).toThrow();
  for (const probabilities of [[0, 0, 0, 0], [0, 0, 2, -1], [0, NaN, 1, 0], [0, 1]]) {
    expect(() => selectedToolbag([bag], [{ ...score('a'), probabilities }])).toThrow();
  }
  expect(() => selectedToolbag([bag], [score('missing')])).toThrow();
  expect(() => selectedToolbag([bag], [score('a'), score('a')])).toThrow();
  expect(() => selectedToolbag([bag], [], { schemaChars: 1 })).toThrow();
});

test('search returns complete JSON, reports oversized schemas, never drops small matches', async () => {
  const { bag } = source([tool('match_large', 'x'.repeat(14000)), tool('match_small')]);
  const selected = selectedToolbag([bag], [], { maxDirect: 0 });
  const result = JSON.parse((await selected.execute('search_tools', { query: 'match' })).text);
  expect(result.tools).toEqual([tool('match_small')]);
  expect(result.oversized).toEqual(['match_large']);
  expect((await selected.execute('search_tools', {})).isError).toBe(true);
});
