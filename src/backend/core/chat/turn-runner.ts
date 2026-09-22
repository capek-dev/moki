import type { Assistant, Message, Result, ToolCallRecord } from '@shared/protocol';
import type { ContextTurn, ContextUsage } from '@shared/context';
import type { Clock } from '@shared/clock';
import { formatClockContext } from '@shared/clock';
import type { Toolbag } from '@backend/integrations/cua';
import type {
  BuiltInForegroundSource,
  BuiltInToolSource,
  ExternalToolSource,
  Generate,
  Turn,
  ValidatedStartChat,
} from '@backend/core/chat/contracts';
import { userFacingTurnError } from '@backend/core/chat/errors';
import { recallTurnMemory } from '@backend/core/chat/memory';
import { loadChatTools } from '@backend/core/chat/tools';
import { prepareTurn } from '@backend/core/chat/turn';
import { describeError } from '@backend/core/error-description';
import { Store } from '@backend/storage/store';
import { ToolBudgetError } from '@shared/mcp';
import type { MemoryHostConfig } from '@backend/memory/recall';
import type { MemoryRecallInspection } from '@shared/memory';

const PLAIN_REPLY_DEADLINE_MS = 180_000;
const TOOL_REPLY_DEADLINE_MS = 600_000;
const MAX_REPLY_CHARS = 64_000;
const FLUSH_DELAY_MS = 60;

interface ChatTurnRunnerOptions {
  store: Store;
  generate: Generate;
  publish: (result: Result) => void;
  request: ValidatedStartChat;
  assistant: Assistant;
  messageId: string;
  userMessageId: string;
  foregroundSource: BuiltInForegroundSource;
  toolSource?: ExternalToolSource;
  builtInToolSource?: BuiltInToolSource;
  memoryConfig: MemoryHostConfig | (() => MemoryHostConfig);
  clock: Clock;
  onFinished(): void;
}

/** Owns one active reply from acknowledgement through terminal persistence. */
export class ChatTurnRunner {
  readonly conversationId: string;
  readonly contextTurn: ContextTurn;

  private readonly abort = new AbortController();
  private readonly memoryRecallAbort = new AbortController();
  private readonly clockContext: string;
  private readonly toolCalls: ToolCallRecord[] = [];
  private output = '';
  private contextUsage?: ContextUsage;
  private memoryRecall?: MemoryRecallInspection;
  private externalTools?: Toolbag;
  private builtInTools?: Toolbag;
  private stopMemoryPolicyWatch?: () => void;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private finished = false;

  constructor(private readonly options: ChatTurnRunnerOptions) {
    this.conversationId = options.request.conversationId;
    this.contextTurn = {
      conversationId: this.conversationId,
      messageId: options.messageId,
      turnId: crypto.randomUUID(),
    };
    this.clockContext = formatClockContext(options.clock);
    this.abort.signal.addEventListener(
      'abort',
      () => this.memoryRecallAbort.abort(),
      { once: true },
    );
  }

  start(): void {
    this.watchMemoryPolicy();
    this.armDeadline(PLAIN_REPLY_DEADLINE_MS);
    queueMicrotask(() => void this.run());
  }

  initialResult(): Result {
    return {
      snapshot: this.options.store.snapshot(this.conversationId),
      conversationId: this.conversationId,
      contextTurn: this.contextTurn,
    };
  }

  cancel(): void {
    this.abort.abort();
    this.finish('interrupted');
  }

  private async run(): Promise<void> {
    try {
      const loadedTools = await loadChatTools({
        conversationId: this.conversationId,
        signal: this.abort.signal,
        evidence: this.selectionEvidence(),
        toolLoading: this.options.request.toolLoading,
        foregroundSource: this.options.foregroundSource,
        toolCalls: this.toolCalls,
        externalSource: this.options.toolSource,
        builtInSource: this.options.builtInToolSource,
        scheduleFlush: () => this.scheduleFlush(),
      });
      this.externalTools = loadedTools.external;
      this.builtInTools = loadedTools.builtIn;
      if (loadedTools.external?.tools.length || loadedTools.builtIn?.tools.length) {
        this.armDeadline(TOOL_REPLY_DEADLINE_MS);
      }

      const memory = await recallTurnMemory({
        memories: this.options.store.memoryRepository,
        graph: this.options.store.memoryGraphRepository,
        evidence: this.selectionEvidence(),
        signal: this.memoryRecallAbort.signal,
        turnSignal: this.abort.signal,
        jevKey: this.options.request.memoryJevKey,
        config: () => this.currentMemoryConfig(),
      });
      const prepared = prepareTurn({
        store: this.options.store,
        request: this.options.request,
        assistant: this.options.assistant,
        messageId: this.options.messageId,
        userMessageId: this.options.userMessageId,
        contextTurn: this.contextTurn,
        clockContext: this.clockContext,
        memory,
        tools: loadedTools.tools,
        externalTools: loadedTools.external,
        builtInTools: loadedTools.builtIn,
        onContextUpdate: (update) => this.handleContextUpdate(update),
      });
      this.memoryRecall = prepared.memoryRecall;
      await this.streamTurn(prepared.turn);
    } catch (error) {
      if (error instanceof ToolBudgetError) {
        console.error(
          `[moki] tool budget exceeded conversation=${this.conversationId}: ${error.detail} (total ${error.total} > ${error.budget})`,
        );
        this.finish('failed', error.message);
        return;
      }
      if (!this.abort.signal.aborted) {
        console.error(
          `[moki] turn failed conversation=${this.conversationId} provider=${this.options.assistant.provider} model=${this.options.request.model}: ${describeError(error)}`,
        );
      }
      this.finish(
        this.abort.signal.aborted ? 'interrupted' : 'failed',
        this.abort.signal.aborted ? null : userFacingTurnError(error),
      );
    }
  }

  private selectionEvidence(): { request: string; recent: string } {
    const visible = this.options.store.messages(this.conversationId).filter(
      (message) => message.id !== this.options.messageId &&
        (message.role === 'user' || message.status === 'complete'),
    );
    return {
      request: this.options.request.text.slice(0, 8_000),
      recent: visible
        .slice(0, -1)
        .slice(-4)
        .map((message) => `${message.role}: ${message.text.slice(-1_000)}`)
        .join('\n')
        .slice(-2_000),
    };
  }

  private currentMemoryConfig(): MemoryHostConfig {
    return typeof this.options.memoryConfig === 'function'
      ? this.options.memoryConfig()
      : this.options.memoryConfig;
  }

  private watchMemoryPolicy(): void {
    const initial = this.currentMemoryConfig();
    const policy = {
      enabled: initial.enabled,
      recall: initial.recall,
      jevConsent: initial.jevConsent,
      jevModel: initial.jevModel,
    };
    this.stopMemoryPolicyWatch = this.options.store.onMessageEvent((event) => {
      if (event.type !== 'settings') return;
      const current = this.options.store.memorySettings();
      if (
        current.enabled !== policy.enabled ||
        current.recall !== policy.recall ||
        current.jevConsent !== policy.jevConsent ||
        current.jevModel !== policy.jevModel
      ) {
        this.memoryRecallAbort.abort();
      }
    });
  }

  private handleContextUpdate(
    update: Parameters<NonNullable<Turn['context']>['onUpdate']>[0],
  ): void {
    if (this.finished || this.abort.signal.aborted) return;
    if (update.type === 'estimate') {
      this.contextUsage = {
        turn: this.contextTurn,
        model: this.options.request.model,
        contextWindowTokens: update.contextWindowTokens,
        outputReserveTokens: update.outputReserveTokens,
        requestNumber: update.requestNumber,
        estimate: update.estimate,
        estimateSource: 'heuristic',
      };
    } else if (this.contextUsage?.requestNumber === update.requestNumber) {
      this.contextUsage = {
        ...this.contextUsage,
        providerReported: {
          inputTokens: update.inputTokens,
          noCacheInputTokens: update.noCacheInputTokens,
          cacheReadInputTokens: update.cacheReadInputTokens,
          cacheWriteInputTokens: update.cacheWriteInputTokens,
          outputTokens: update.outputTokens,
          totalTokens: update.totalTokens,
          source: 'ai-sdk-provider-usage',
          billingExact: false,
        },
      };
    }
    this.publishState();
  }

  private async streamTurn(turn: Turn): Promise<void> {
    for await (const delta of this.options.generate(turn, this.abort.signal)) {
      if (this.finished || this.abort.signal.aborted) return;
      const textDelta = typeof delta === 'string' ? delta : delta.text;
      if (this.output.length + textDelta.length > MAX_REPLY_CHARS) {
        this.abort.abort();
        this.finish(
          'failed',
          'Reply reached the size limit. Ask for a shorter answer.',
        );
        return;
      }
      this.output += textDelta;
      this.scheduleFlush();
    }

    if (this.finished) return;
    this.finish(
      this.abort.signal.aborted
        ? 'interrupted'
        : this.output
          ? 'complete'
          : 'failed',
      !this.output && !this.abort.signal.aborted
        ? 'The model returned no text. Try another model.'
        : null,
    );
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.options.store.updateReply(
      this.options.messageId,
      this.output,
      'streaming',
      null,
      this.toolCalls,
    );
    this.publishState();
  }

  private publishState(): void {
    this.options.publish({
      snapshot: this.options.store.snapshot(this.conversationId),
      conversationId: this.conversationId,
      contextUsage: this.contextUsage,
      memory: this.options.store.memorySettings(),
      memoryRecall: this.memoryRecall,
    });
  }

  private armDeadline(milliseconds: number): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      this.abort.abort();
      this.finish('failed', 'Reply timed out. You can send a new message.');
    }, milliseconds);
  }

  private finish(status: Message['status'], error: string | null = null): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.deadline);
    this.externalTools?.close();
    this.builtInTools?.close();
    this.memoryRecallAbort.abort();
    this.stopMemoryPolicyWatch?.();
    this.options.store.updateReply(
      this.options.messageId,
      this.output,
      status,
      error,
      this.toolCalls,
    );
    this.options.onFinished();
    this.publishState();
  }
}
