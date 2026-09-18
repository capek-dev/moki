import { expect, test } from 'bun:test';
import { evaluate, metrics, mockTransport, validateDataset, type EvalDataset } from '../scripts/tool-selection-eval';
import fixture from './fixtures/tool-selection-eval.json';

const dataset: EvalDataset = fixture;

test('three prompts over 91 tools use exactly six bulk requests across both modes', async () => {
  const bulk = { ...dataset, cases: dataset.cases.slice(0, 3), tools: [...dataset.tools,
    ...Array.from({ length: 81 }, (_, i) => ({ name: `extra__${i}`, description: 'Unrelated capability '.repeat(12), inputSchema: { type: 'object' } }))] };
  const report = await evaluate(bulk, { verification: 'mocked', key: 'fixture', transport: task => async (url, init) => {
    const body = JSON.parse(init.body as string);
    expect(body.state.candidates).toHaveLength(91);
    expect(Object.keys(body.questions)).toHaveLength(91);
    return mockTransport(task)(url, init);
  } });
  expect(report.rows).toHaveLength(6);
  expect(report.rows.every(row => row.requests === 1 && row.outcome === 'selected')).toBe(true);
});

test('both modes use identical catalog and tasks, names-only omits descriptions and schemas', async () => {
  const report = await evaluate(dataset, { verification: 'mocked', key: 'test-only-key', transport: (task, mode) => async (url, init) => {
    const body = JSON.parse(init.body as string);
    expect(body.state.task.request).toBe(task.prompt);
    expect(body.state.candidates.map((item: { name: string }) => item.name)).toEqual(dataset.tools.map(tool => tool.name));
    for (const candidate of body.state.candidates) expect(Object.keys(candidate)).toEqual(mode === 'name-only' ? ['name'] : ['name', 'description']);
    expect(JSON.stringify(body)).not.toContain('inputSchema');
    return mockTransport(task)(url, init);
  } });
  expect(report.verification).toBe('mocked');
  expect(report.note).toContain('NOT model accuracy');
  expect(report.rows).toHaveLength(dataset.cases.length * 2);
  for (const task of dataset.cases) {
    const names = report.rows.find(row => row.task === task.id && row.mode === 'name-only')!;
    const descriptions = report.rows.find(row => row.task === task.id && row.mode === 'name-description')!;
    expect(names.picked.slice().sort()).toEqual(task.relevant.slice().sort());
    expect(names.requestChars).toBeLessThan(descriptions.requestChars);
    expect(names.outcome).toBe('selected');
  }
  const names = report.rows.filter(row => row.mode === 'name-only').reduce((sum, row) => sum + row.requestChars, 0);
  const descriptions = report.rows.filter(row => row.mode === 'name-description').reduce((sum, row) => sum + row.requestChars, 0);
  console.log(JSON.stringify({ verification: 'mocked', tasks: dataset.cases.length, nameOnlyRequestChars: names, nameDescriptionRequestChars: descriptions, note: 'Serialized SDK payload sizes, not accuracy measurements' }));
});

test('metrics penalize irrelevant picks and missed required capabilities; no-tool is explicit', () => {
  const task = { id: 'x', prompt: 'x', relevant: ['a', 'b', 'alternative'], required: [['a', 'alternative'], ['b']] };
  expect(metrics(task, ['a', 'wrong'])).toMatchObject({ precision: 0.5, recall: 1 / 3, requiredRecall: 0.5, missedCapabilities: [['b']], irrelevant: ['wrong'] });
  expect(metrics(task, []).recall).toBe(0);
  expect(metrics({ ...task, relevant: [], required: [] }, [])).toMatchObject({ precision: null, recall: null, requiredRecall: null, exactNoTool: true });
});

test('fallback never counts as Jev accuracy and absent labels are rejected', async () => {
  expect(() => validateDataset({ ...dataset, cases: [{ id: 'bad', prompt: 'x', relevant: ['not-in-catalog'], required: [] }] })).toThrow();
  const report = await evaluate({ ...dataset, cases: dataset.cases.slice(0, 1) }, { verification: 'mocked', key: 'fixture', transport: () => async () => Response.json({}, { status: 401 }) });
  expect(report.rows.every(row => row.outcome === 'failed_fallback' && row.quality === null)).toBe(true);
});
