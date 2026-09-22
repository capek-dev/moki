import type { Assistant } from '@shared/protocol';
import type { ContextTurn } from '@shared/context';
import {
  countModelImages,
  createImageAccounting,
  estimateContextUsage,
} from '@shared/context';
import type { Toolbag } from '@backend/integrations/cua';
import type {
  Turn,
  TurnTool,
  ValidatedStartChat,
} from '@backend/core/chat/contracts';
import { history, renderTurnContext } from '@backend/core/chat/history';
import type { TurnMemory } from '@backend/core/chat/memory';
import { assembleTurnInstructions } from '@backend/memory/recall';
import { Store } from '@backend/storage/store';
import { SESSION_SEARCH_GUIDANCE } from '@backend/session-search/tool';
import { MEMORY_TOOL_GUIDANCE } from '@backend/tools/memory';
import type { MemoryRecallInspection } from '@shared/memory';

interface PrepareTurnOptions {
  store: Store;
  request: ValidatedStartChat;
  assistant: Assistant;
  messageId: string;
  userMessageId: string;
  contextTurn: ContextTurn;
  clockContext: string;
  memory: TurnMemory;
  tools: TurnTool[];
  externalTools?: Toolbag;
  builtInTools?: Toolbag;
  onContextUpdate: NonNullable<Turn['context']>['onUpdate'];
}

export interface PreparedTurn {
  turn: Turn;
  memoryRecall: MemoryRecallInspection;
}

/** Persist frozen per-turn context, then build the complete provider request. */
export function prepareTurn(options: PrepareTurnOptions): PreparedTurn {
  const { recalled, config } = options.memory;
  const selectedMemories = recalled.entries.slice(0, 16).map((entry) => ({
    memoryId: entry.memory.id,
    revision: entry.memory.revision,
  }));
  const inspection = 'inspection' in recalled
    ? recalled.inspection
    : {
        mode: 'basic' as const,
        outcome: config.enabled ? 'basic' : 'disabled',
        selected: selectedMemories,
        candidateCount: recalled.candidateCount,
        descriptorCount: 0,
        relationshipCount: 0,
        elapsedMs: 0,
      };
  const memoryRecall = { ...inspection, messageId: options.messageId };
  options.store.recordMemoryRecall(
    options.request.conversationId,
    options.messageId,
    memoryRecall,
  );
  options.store.setMessageModelContext(
    options.userMessageId,
    renderTurnContext(
      options.clockContext,
      recalled.context,
      options.externalTools?.selectedTools ?? [],
    ),
    selectedMemories,
  );

  const messages = options.store.modelMessages(options.request.conversationId);
  const attachments = options.store.attachmentsFor(messages);
  const modelContexts = options.store.modelContextsFor(messages);
  const modelMessages = history(
    messages,
    attachments,
    (attachmentId) => options.store.attachmentBytes(attachmentId),
    (messageId) => modelContexts.get(messageId),
  );
  const draftImageTokens = estimateContextUsage(messages, attachments, '').imageTokens;
  const imageAccounting = createImageAccounting(
    countModelImages(modelMessages),
    draftImageTokens,
  );

  return {
    memoryRecall,
    turn: {
      conversationId: options.request.conversationId,
      thinking: options.request.thinking,
      model: options.request.model,
      provider: options.assistant.provider,
      instructions: assembleTurnInstructions(options.assistant.instructions, [
        options.builtInTools ? SESSION_SEARCH_GUIDANCE : '',
        config.enabled ? MEMORY_TOOL_GUIDANCE : '',
      ]),
      credentials: options.request.credentials,
      tools: options.tools.length ? options.tools : undefined,
      messages: modelMessages,
      context: {
        turn: options.contextTurn,
        imageAccounting,
        onUpdate: options.onContextUpdate,
      },
    },
  };
}
