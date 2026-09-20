import type { Result, Snapshot } from '@shared/protocol';
import type { ContextUsage } from '@shared/context';

export interface ChatState {
  data?: Snapshot;
  revision: number;
  histories: Record<string, number>;
  contextUsage?: Record<string, ContextUsage>;
  contextTurns?: Record<string, string>;
}
export function applyResult(state: ChatState, result: Result): ChatState {
  const revision = result.revision ?? 0;
  const newer = revision >= state.revision;
  const data = newer || !state.data ? result.snapshot : state.data;
  const id = result.conversationId;
  let messages = state.data?.messages ?? [];
  const histories = { ...state.histories };
  const contextUsage = { ...(state.contextUsage ?? {}) };
  const contextTurns = { ...(state.contextTurns ?? {}) };
  if (id && revision >= (histories[id] ?? -1)) {
    messages = [...messages.filter((m) => m.conversationId !== id), ...result.snapshot.messages];
    histories[id] = revision;
    if (result.contextTurn?.conversationId === id && result.contextTurn.messageId && result.contextTurn.turnId) {
      contextTurns[id] = result.contextTurn.turnId;
      delete contextUsage[id];
    }
    if (result.contextUsage?.turn.conversationId === id && contextTurns[id] === result.contextUsage.turn.turnId) contextUsage[id] = result.contextUsage;
  } else if (!id) {
    // Metadata snapshots may include recent messages from several conversations.
    // Do not erase a loaded transcript or let an older snapshot overwrite it.
    const existing = new Map(messages.map((m) => [m.id, m]));
    for (const message of result.snapshot.messages) {
      if (revision >= (histories[message.conversationId] ?? -1)) existing.set(message.id, message);
    }
    messages = [...existing.values()];
  }
  return { data: { ...data, messages }, revision: Math.max(state.revision, revision), histories, contextUsage, contextTurns };
}
