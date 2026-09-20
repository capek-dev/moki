import type { AgentToolDef, Toolbag } from './cua';

export interface ToolScore { name: string; score: number; probabilities: readonly number[] }
export interface ToolDescriptor { name: string; description: string }

/** Selector payloads deliberately cannot carry schemas or executor references. */
export function toolDescriptors(tools: readonly AgentToolDef[]): ToolDescriptor[] {
  return tools.map(tool => ({ name: tool.name, description: tool.description.replace(/\s+/g, ' ').trim().slice(0, 240) }));
}

/** Bounded batches for cloud scoring. Full catalogs remain local and searchable. */
export function descriptorBatches(tools: readonly AgentToolDef[]): ToolDescriptor[][] {
  const descriptors = toolDescriptors(tools);
  const batches: ToolDescriptor[][] = [];
  for (let start = 0; start < descriptors.length; start += 16) batches.push(descriptors.slice(start, start + 16));
  return batches;
}

export function validScore(value: ToolScore): boolean {
  return Number.isFinite(value.score) && value.score >= 0 && value.score <= 3
    && Array.isArray(value.probabilities) && value.probabilities.length === 4
    && value.probabilities.every(p => Number.isFinite(p) && p >= 0 && p <= 1)
    && Math.abs(value.probabilities.reduce((sum, p) => sum + p, 0) - 1) <= 0.02;
}

/** Minimum-level acceptance uses summed probabilities, never the mean score. */
export function scoreAtOrAbove(value: ToolScore, minimumLevel: number): boolean {
  if (!Number.isSafeInteger(minimumLevel) || minimumLevel < 0 || minimumLevel > 3 || !validScore(value)) return false;
  return value.probabilities.slice(minimumLevel).reduce((sum, probability) => sum + probability, 0) >= 0.7;
}

/** Character guard, not a tokenizer or a guarantee about provider context size. */
function serializedSize(tools: readonly AgentToolDef[]): number { return JSON.stringify(tools).length; }

/** Keep provider tools stable while exposing selected schemas as hidden turn context. */
export function selectedToolbag(
  bags: readonly Toolbag[], scores: readonly ToolScore[],
  options: { maxDirect?: number; schemaChars?: number } = {},
): Toolbag {
  const maxDirect = options.maxDirect ?? 12;
  const schemaChars = options.schemaChars ?? 24000;
  if (!Number.isInteger(maxDirect) || maxDirect < 0 || maxDirect > 64
    || !Number.isSafeInteger(schemaChars) || schemaChars < 0 || schemaChars > 60000) throw new Error('Invalid tool selection policy');
  const routing = new Map<string, Toolbag>();
  const catalog: AgentToolDef[] = [];
  for (const bag of bags) for (const tool of bag.tools) {
    if (routing.has(tool.name)) continue;
    routing.set(tool.name, bag);
    catalog.push(tool);
  }
  const byName = new Map(catalog.map(tool => [tool.name, tool]));
  const seen = new Set<string>();
  for (const score of scores) {
    if (!score || !byName.has(score.name) || seen.has(score.name) || !validScore(score)) throw new Error('Invalid tool scores');
    seen.add(score.name);
  }
  // These names are reserved provider-facing routers. External catalog tools
  // with the same names remain reachable through call_tool by exact name.
  const searchName = 'search_tools';
  const callName = 'call_tool';
  const meta: AgentToolDef[] = [
    { name: searchName, description: `Search available tools by keyword. Returns complete input schemas. Run matches with ${callName}.`, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: callName, description: 'Run an available tool using its exact name and arguments.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] } },
  ];
  if (serializedSize(meta) > schemaChars) throw new Error('Tool budget cannot fit discovery tools');
  const direct: AgentToolDef[] = [];
  const ranked = [...scores].filter(score => scoreAtOrAbove(score, 2))
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const score of ranked) {
    if (direct.length >= maxDirect) break;
    const tool = byName.get(score.name)!;
    if (serializedSize([...direct, tool, ...meta]) <= schemaChars) direct.push(tool);
  }
  const selectedNames = new Set(direct.map(tool => tool.name));
  const pool = catalog.filter(tool => !selectedNames.has(tool.name));
  let closed = false;
  return {
    tools: meta,
    selectedTools: direct,
    weights: bags.flatMap(bag => bag.weights ?? []),
    execute: async (name, args) => {
      if (closed) throw new Error('Tool selection is closed');
      if (name === searchName) {
        const query = (args as { query?: unknown } | null)?.query;
        if (typeof query !== 'string' || !query.trim() || query.length > 1000) return { text: 'Provide search words (up to 1000 characters).', isError: true };
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = pool.map(tool => ({ tool, rank: terms.reduce((rank, term) => rank
          + (tool.name.toLowerCase().includes(term) ? 3 : 0) + (tool.description.toLowerCase().includes(term) ? 1 : 0), 0) }))
          .filter(item => item.rank > 0).sort((a, b) => b.rank - a.rank);
        const results: AgentToolDef[] = [];
        const oversized: string[] = [];
        for (const { tool } of matches) {
          if (results.length >= 5) break;
          if (serializedSize([tool]) > 12000) { oversized.push(tool.name); continue; }
          if (serializedSize([...results, tool]) <= 12000) results.push(tool);
        }
        return { text: JSON.stringify({ tools: results, oversized: oversized.slice(0, 5),
          note: oversized.length ? 'Some schemas exceed the search result limit; they were not truncated.' : results.length ? undefined : 'No matching tools. Try different words.' }), isError: false };
      }
      if (name === callName) {
        const input = args as { name?: unknown; arguments?: unknown } | null;
        const owner = typeof input?.name === 'string' ? routing.get(input.name) : undefined;
        if (!owner) return { text: 'Unknown tool. Search for an available tool first.', isError: true };
        return owner.execute(input!.name as string, input?.arguments ?? {});
      }
      throw new Error('Unknown routing tool');
    },
    close: () => { if (closed) return; closed = true; for (const bag of new Set(bags)) bag.close(); },
  };
}
