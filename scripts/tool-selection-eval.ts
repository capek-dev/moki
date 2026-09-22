import type { AgentToolDef } from '@backend/integrations/cua';
import { smartToolbag, type ScoringOptions } from '@backend/tools/scoring';

export interface EvalCase {
  id: string;
  prompt: string;
  recent?: string;
  /** All tools that are useful, including optional prerequisites. */
  relevant: string[];
  /** Each group is a required capability; any tool within it satisfies it. */
  required: string[][];
}
export interface EvalDataset { provenance: string; tools: AgentToolDef[]; cases: EvalCase[] }
export type Mode = 'name-only' | 'name-description';

export function validateDataset(data: EvalDataset): void {
  if (!data || !data.provenance?.trim() || !Array.isArray(data.tools) || !data.tools.length || !Array.isArray(data.cases) || !data.cases.length) throw new Error('Dataset needs provenance, tools and cases');
  const names = new Set<string>();
  for (const tool of data.tools) {
    if (!tool || typeof tool.name !== 'string' || !tool.name || names.has(tool.name) || typeof tool.description !== 'string' || !tool.inputSchema || typeof tool.inputSchema !== 'object') throw new Error('Invalid or duplicate catalog tool');
    names.add(tool.name);
  }
  const ids = new Set<string>();
  for (const task of data.cases) {
    if (!task || typeof task.id !== 'string' || ids.has(task.id) || !task.id || typeof task.prompt !== 'string' || !task.prompt.trim()
      || (task.recent !== undefined && typeof task.recent !== 'string') || !Array.isArray(task.relevant) || !Array.isArray(task.required)
      || new Set(task.relevant).size !== task.relevant.length || task.relevant.some(name => !names.has(name))
      || task.required.some(group => !Array.isArray(group) || !group.length || group.some(name => !task.relevant.includes(name)))) throw new Error('Invalid task labels or labels absent from catalog');
    ids.add(task.id);
  }
}

export function metrics(task: EvalCase, picked: string[]) {
  const selected = new Set(picked);
  const useful = task.relevant.filter(name => selected.has(name));
  const missing = task.required.filter(group => !group.some(name => selected.has(name)));
  return {
    precision: selected.size ? useful.length / selected.size : null,
    recall: task.relevant.length ? useful.length / task.relevant.length : null,
    requiredRecall: task.required.length ? (task.required.length - missing.length) / task.required.length : null,
    missedCapabilities: missing,
    irrelevant: [...selected].filter(name => !task.relevant.includes(name)),
    exactNoTool: !task.relevant.length ? selected.size === 0 : null,
  };
}

/** No tool is ever executed. HTTP is injected so offline runs cannot call the network. */
export async function evaluate(data: EvalDataset, options: {
  key: string; verification: 'mocked' | 'live'; maxDirect?: number;
  transport: (task: EvalCase, mode: Mode) => NonNullable<ScoringOptions['fetch']>;
}) {
  validateDataset(data);
  const rows = [];
  for (const [index, task] of data.cases.entries()) {
    // Alternate order to reduce consistent warm-service bias in later live runs.
    const modes: Mode[] = index % 2 ? ['name-description', 'name-only'] : ['name-only', 'name-description'];
    for (const mode of modes) {
      let requests = 0; let requestChars = 0; let requestBytes = 0; let peakRequestChars = 0;
      let diagnostic: { outcome?: string; picked?: string[]; elapsedMs?: number } = {};
      const transport = options.transport(task, mode);
      const bag = await smartToolbag([{ tools: data.tools, close() {}, execute: async () => { throw new Error('Evaluation cannot execute tools'); } }],
        { request: task.prompt, recent: task.recent ?? '' }, { enabled: true, maxDirect: options.maxDirect ?? 12, key: options.key }, new AbortController().signal, {
          descriptorMode: mode,
          diagnostic: value => { diagnostic = value; },
          fetch: async (url, init) => {
            const body = String(init.body);
            requests++; requestChars += body.length; requestBytes += Buffer.byteLength(body); peakRequestChars = Math.max(peakRequestChars, body.length);
            return transport(url, init);
          },
        });
      bag.close();
      const picked = diagnostic.picked ?? [];
      rows.push({ task: task.id, mode, outcome: diagnostic.outcome, picked, elapsedMs: diagnostic.elapsedMs,
        requests, requestChars, requestBytes, peakRequestChars,
        // Never report keyword fallback as Jev accuracy.
        quality: diagnostic.outcome === 'selected' ? metrics(task, picked) : null });
    }
  }
  return { verification: options.verification, provenance: data.provenance, model: 'jev-latest', maxDirect: options.maxDirect ?? 12,
    note: options.verification === 'mocked' ? 'Plumbing test only. Labels generate mock answers; these are NOT model accuracy results.' : 'Live results depend on this labeled catalog and model version.', rows };
}

export const mockTransport = (task: EvalCase): NonNullable<ScoringOptions['fetch']> => async (_url, init) => {
  const body = JSON.parse(init.body as string);
  return Response.json({ answers: Object.fromEntries(body.state.candidates.map((tool: { name: string }, index: number) => {
    const useful = task.relevant.includes(tool.name);
    return [`item_${index}`, { type: 'score', score: useful ? 3 : 0, probabilities: useful ? { 0: 0, 1: 0, 2: 0, 3: 1 } : { 0: 1, 1: 0, 2: 0, 3: 0 } }];
  })) });
};

if (import.meta.main) {
  const [mode, path] = Bun.argv.slice(2);
  if (mode !== '--mock' || !path) throw new Error('Usage: bun scripts/tool-selection-eval.ts --mock <dataset.json>. Live runs require separate approval.');
  const data = await Bun.file(path).json() as EvalDataset;
  console.log(JSON.stringify(await evaluate(data, { key: 'offline-fixture', verification: 'mocked', transport: task => mockTransport(task) }), null, 2));
}
