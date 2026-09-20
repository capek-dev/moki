import { MemoryStatusSummary } from '@renderer/components/settings/memory/status-summary';
import { LearningPanel } from '@renderer/components/settings/memory/learning-panel';
import { RecallPanel } from '@renderer/components/settings/memory/recall-panel';
import { MemoriesBrowser } from '@renderer/components/settings/memory/memories-browser';

/**
 * Memory tab. Each panel owns its data loading, revision guards, and error
 * surface; lists are bounded (disclosures + internal scroll) so the page height
 * stays stable as records accumulate.
 */
export function MemorySettings() {
  return <div className="grid gap-3">
    <MemoryStatusSummary />
    <LearningPanel />
    <RecallPanel />
    <MemoriesBrowser />
  </div>;
}
