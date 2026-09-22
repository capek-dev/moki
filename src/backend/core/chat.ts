import { Store } from '@backend/storage/store';
import { ChatTurnRunner } from '@backend/core/chat/turn-runner';
import { validateStartChat } from '@backend/core/chat/input';
import {
  DEFAULT_MEMORY_HOST_CONFIG,
  type MemoryHostConfig,
} from '@backend/memory/recall';
import { systemClock, type Clock } from '@shared/clock';
import type { Result } from '@shared/protocol';
import type {
  BuiltInToolSource,
  ExternalToolSource,
  Generate,
  StartChatInput,
} from '@backend/core/chat/contracts';

export { describeError } from '@backend/core/error-description';
export {
  enrichUserText,
  history,
  renderSelectedToolContext,
  renderTurnContext,
} from '@backend/core/chat/history';
export type {
  BuiltInForegroundSource,
  BuiltInToolSource,
  Credentials,
  Generate,
  StartChatInput,
  Turn,
  TurnTool,
  TurnToolOutput,
} from '@backend/core/chat/contracts';

/** Public chat facade. One runner owns each active conversation turn. */
export class Chat {
  private readonly active = new Map<string, ChatTurnRunner>();

  constructor(
    private readonly store: Store,
    private readonly generate: Generate,
    private readonly publish: (result: Result) => void,
    private readonly toolSource?: ExternalToolSource,
    private readonly builtInToolSource?: BuiltInToolSource,
    private readonly memoryConfig: MemoryHostConfig | (() => MemoryHostConfig) = DEFAULT_MEMORY_HOST_CONFIG,
    private readonly clock: Clock = systemClock,
  ) {}

  start(input: StartChatInput): Result {
    const { request, assistant } = validateStartChat(
      input,
      (conversationId) => this.store.assistantFor(conversationId),
    );
    if (this.active.has(request.conversationId)) {
      throw new Error('This conversation is already replying.');
    }

    const { messageId, userMessageId } = this.store.begin(
      request.conversationId,
      request.text,
      request.model,
      request.thinking,
      request.attachmentIds,
      request.editOf,
    );
    const runner = new ChatTurnRunner({
      store: this.store,
      generate: this.generate,
      publish: this.publish,
      request,
      assistant,
      messageId,
      userMessageId,
      foregroundSource: this.store.foregroundUserSource(messageId),
      toolSource: this.toolSource,
      builtInToolSource: this.builtInToolSource,
      memoryConfig: this.memoryConfig,
      clock: this.clock,
      onFinished: () => this.active.delete(request.conversationId),
    });

    this.active.set(request.conversationId, runner);
    runner.start();
    return runner.initialResult();
  }

  cancel(conversationId: string): Result {
    const id = this.store.conversation(conversationId).id;
    this.active.get(id)?.cancel();
    return { snapshot: this.store.snapshot(id), conversationId: id };
  }

  close(): void {
    for (const runner of [...this.active.values()]) runner.cancel();
  }
}
