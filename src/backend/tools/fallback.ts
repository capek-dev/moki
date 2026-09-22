import type { Toolbag } from '@backend/integrations/cua';
import { selectedToolbag } from '@backend/tools/selection';

/** Keep fallback provider declarations byte-stable. The complete live catalog
 * remains available through search_tools and call_tool.
 */
export function namesOnlyToolbag(bags: readonly Toolbag[]): Toolbag {
  return selectedToolbag(bags, [], { maxDirect: 0 });
}
