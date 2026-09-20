import type { LearningLiveOutput } from '@shared/protocol';

/** Ephemeral, bounded output only. Never persisted or returned to chat windows. */
export class LearningReviewCache {
  private outputs = new Map<string, LearningLiveOutput>();
  private blocked = new Set<string>();
  receive(value: LearningLiveOutput): LearningLiveOutput | undefined {
    if (typeof value.runId !== 'string' || value.runId.length > 100 || typeof value.text !== 'string') return;
    if (this.blocked.has(value.runId)) return;
    const output = { runId: value.runId, text: value.text.slice(0, 64000) };
    this.outputs.delete(value.runId);
    this.outputs.set(value.runId, output);
    while (this.outputs.size > 8) this.outputs.delete(this.outputs.keys().next().value!);
    return output;
  }
  get(id: string) { return this.outputs.get(id); }
  forget(active: Iterable<string>) {
    for (const id of active) this.blocked.add(id);
    this.outputs.clear();
  }
  finish(id: string) { this.blocked.delete(id); }
}
