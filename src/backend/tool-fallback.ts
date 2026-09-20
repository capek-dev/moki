import type { Toolbag } from './cua';
import { selectedToolbag } from './tool-selection';

/** Keep fallback provider declarations byte-stable. The complete live catalog
 * remains available through search_tools and call_tool.
 */
export function namesOnlyToolbag(bags: readonly Toolbag[]): Toolbag {
  return selectedToolbag(bags, [], { maxDirect: 0 });
}
