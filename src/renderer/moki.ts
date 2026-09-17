import type { Assistant, Conversation } from '../shared/protocol';

/** A presentation policy, not a migration. Legacy profiles keep their original record. */
export function mokiAssistant(assistants: readonly Assistant[] = []): Assistant | undefined {
  return assistants.find((item) => item.id === 'povondra')
    ?? assistants.find((item) => item.id === 'moki')
    ?? assistants[0];
}

/** Earlier conversations stay readable without silently switching Moki's identity. */
export function canChatWithMoki(assistant: Assistant | undefined, conversation: Conversation | undefined): boolean {
  return !!assistant && !!conversation && conversation.assistantId === assistant.id;
}
