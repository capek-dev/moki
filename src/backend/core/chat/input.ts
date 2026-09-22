import { requireAttachmentId } from '@shared/attachments';
import type { Assistant } from '@shared/protocol';
import { requireThinking } from '@shared/models';
import { requireToolLoading } from '@shared/tool-loading';
import type {
  StartChatInput,
  ValidatedStartChat,
} from '@backend/core/chat/contracts';

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error('Invalid text value.');
  }
  return value.trim();
}

export function validateStartChat(
  input: StartChatInput,
  resolveAssistant: (conversationId: string) => Assistant,
): { request: ValidatedStartChat; assistant: Assistant } {
  const conversationId = boundedText(input.conversationId, 100);
  if (input.editOf !== undefined && typeof input.editOf !== 'string') {
    throw new Error('Invalid edit target.');
  }
  const text = boundedText(input.text, 16_000);
  const toolLoading = input.toolLoading === undefined
    ? undefined
    : requireToolLoading(input.toolLoading);
  const attachmentValues = input.attachmentIds ?? [];
  if (!Array.isArray(attachmentValues) || attachmentValues.length > 1) {
    throw new Error('Invalid attachments.');
  }
  const attachmentIds = attachmentValues.map(requireAttachmentId);
  const assistant = resolveAssistant(conversationId);
  const thinking = requireThinking(assistant.provider, input.model, input.thinking);
  if (!input.credentials || input.credentials.provider !== assistant.provider) {
    throw new Error('Provider changed. Send again with the selected provider.');
  }
  if (input.credentials.provider === 'deepseek') {
    boundedText(input.credentials.key, 32_000);
  } else {
    boundedText(input.credentials.access, 32_000);
    boundedText(input.credentials.accountId, 32_000);
  }
  const memoryJevKey = input.memoryJevKey === undefined
    ? undefined
    : boundedText(input.memoryJevKey, 1_000);

  return {
    assistant,
    request: {
      conversationId,
      text,
      model: input.model,
      thinking,
      attachmentIds,
      editOf: input.editOf,
      credentials: input.credentials,
      toolLoading,
      memoryJevKey,
    },
  };
}
