import { expect, test } from 'bun:test';
import { smartToolbag, fitsScoringRequest } from '../src/backend/tool-scoring';

test('direct-name questions carry their own identity and preserve mapping across bulk splits', async () => {
  for (const descriptorMode of ['name-only', 'name-description'] as const) {
    const tools = Array.from({ length: 320 }, (_, i) => ({ name: i === 219 ? 'list_apps' : `other_${i}`, description: `Description ${i} ` + 'x'.repeat(240), inputSchema: { privateSchema: true } }));
    const seen: string[] = [];
    let outcome = '';
    const bag = await smartToolbag([{ tools, close() {}, execute: async name => ({ text: name, isError: false }) }],
      { request: 'List all running apps.', recent: '' }, { enabled: true, maxDirect: 12, key: 'fixture' }, new AbortController().signal, {
        formulation: 'direct-name', descriptorMode, diagnostic: value => { outcome = (value as { outcome: string }).outcome; },
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init.body));
          expect(fitsScoringRequest(String(init.body))).toBe(true);
          expect(Object.keys(body.state)).toEqual(['task']);
          expect(String(init.body)).not.toContain('privateSchema');
          const entries = Object.entries(body.questions).map(([id, q]) => {
            const instructions = (q as { instructions: string }).instructions;
            expect(instructions).not.toContain('candidates[');
            const metadata = JSON.parse(instructions.split('Tool: ')[1].split('. Judge this tool')[0]);
            expect(Object.keys(metadata)).toEqual(descriptorMode === 'name-only' ? ['name'] : ['name', 'description']);
            seen.push(metadata.name);
            const useful = metadata.name === 'list_apps';
            return [id, { type: 'score', score: useful ? 3 : 0, probabilities: useful ? { 0: 0, 1: 0, 2: 0, 3: 1 } : { 0: 1, 1: 0, 2: 0, 3: 0 } }];
          });
          return Response.json({ answers: Object.fromEntries(entries.reverse()) });
        },
      });
    expect(seen).toHaveLength(320);
    expect(new Set(seen)).toEqual(new Set(tools.map(tool => tool.name)));
    expect(outcome).toBe('selected');
    expect(bag.tools.map(tool => tool.name)).toEqual(['list_apps', 'search_tools', 'call_tool']);
    bag.close();
  }
});
