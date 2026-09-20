export const MEMORY_DISABLED_COPY = 'Turning memory off gates recall, memory tools, and memory writes for the next request. It cannot remove memory text already sent in an active prompt or erase conversation history.';
export const MEMORY_FORGET_SCOPE_COPY = 'Forget removes this record from the memory store, including its evidence, topic links, and relationships. Conversation history and migration backups are retained. This is not full conversation or backup erasure.';

export function memoryRecallLabel(mode: string, outcome: string): string {
  const labels: Record<string, string> = {
    no_descriptors: 'Basic fallback: no topics/entities available for Jev routing',
    jev_consent_required: 'Basic fallback: Jev consent required',
    jev_key_unavailable: 'Basic fallback: Jev key unavailable',
    failed_fallback: 'Basic fallback: Jev routing failed or timed out',
    request_size_fallback: 'Basic fallback: Jev request exceeded its size limit',
    basic_mode: 'Basic recall',
    disabled: 'Memory recall disabled',
    jev_selected: 'Jev contextual routing',
  };
  return labels[outcome] ?? `${mode === 'jev' ? 'Jev' : 'Basic'} recall: ${outcome.replaceAll('_', ' ')}`;
}

export function acceptMemoryRevision(currentRevision: number, incomingRevision: number): { accepted: boolean; refresh: boolean; revision: number } {
  if (!Number.isSafeInteger(incomingRevision) || incomingRevision < 1 || incomingRevision < currentRevision) {
    return { accepted: false, refresh: false, revision: currentRevision };
  }
  return { accepted: true, refresh: incomingRevision > currentRevision, revision: incomingRevision };
}
