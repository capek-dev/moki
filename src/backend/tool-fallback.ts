import type { Toolbag } from './cua';
import { selectedToolbag } from './tool-selection';

export const FALLBACK_NAMES_BYTES = 60000;
/** Only the names index is shipped upfront, never the underlying tool schemas.
 * Names beyond the byte cap stay in the complete local search/execution pool.
 */
export function namesOnlyToolbag(bags: readonly Toolbag[]): Toolbag {
  const bag = selectedToolbag(bags, [], { maxDirect: 0 });
  if (!bag.tools.length) return bag;
  const names = [...new Set(bags.flatMap(source => source.tools.map(tool => tool.name)))].sort();
  const entries: string[] = [];
  let bytes = 2; // JSON array brackets
  for (const name of names) {
    const encoded = JSON.stringify(name);
    const cost = Buffer.byteLength(encoded) + (entries.length ? 1 : 0);
    if (bytes + cost > FALLBACK_NAMES_BYTES) continue;
    entries.push(encoded); bytes += cost;
  }
  const index = `[${entries.join(',')}]`;
  // selectedToolbag emits search first, using collision-safe names.
  bag.tools[0] = { ...bag.tools[0], description: `${bag.tools[0].description} Available tool names (JSON): ${index}\n${names.length - entries.length} additional names omitted from this index; all remain searchable. Search for an exact name to fetch its arguments before calling it.` };
  return bag;
}
