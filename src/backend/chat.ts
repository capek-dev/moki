import type { ModelMessage } from 'ai';
import { requireToolLoading, type ToolLoadingConfig } from '@shared/tool-loading';
import type { SelectionEvidence } from './tool-scoring';
import { Store, text } from '@backend/store';
import { requireThinking, type Thinking } from '@shared/models';
import type { Attachment, Provider, Result, Message, ToolCallRecord } from '@shared/protocol';
import { requireAttachmentId } from '@shared/attachments';
import type { ModelToolOutput, Toolbag } from '@backend/cua';
import { SESSION_SEARCH_GUIDANCE } from '@backend/session-search-tool';
import { MEMORY_TOOL_GUIDANCE } from '@backend/memory-tool';
import { assembleTurnInstructions, DEFAULT_MEMORY_HOST_CONFIG, recallBasic, type BasicRecallResult, type MemoryHostConfig } from '@backend/memory-recall';
import { recallJev, type JevRecallResult } from '@backend/memory-jev';
import type { MemoryRecallInspection } from '@shared/memory';
import { cuaToolLabel, describeCuaCall } from '@shared/cua';
import { describeMcpCall, mcpToolLabel, ToolBudgetError } from '@shared/mcp';
import type { ContextTurn, ContextUpdate, ContextUsage } from '@shared/context';
import { countModelImages, createImageAccounting, estimateContextUsage } from '@shared/context';

// Terminal diagnostics: the full error chain for the host process stderr.
// Never surfaced to the renderer; credentials do not travel in error objects.
export function describeError(error: unknown, depth = 0): string {
  if (depth > 3 || !(error instanceof Error)) return String(error);
  const status = (error as { statusCode?: number }).statusCode;
  const parts = [error.name, error.message];
  if (status !== undefined) parts.push(`status ${status}`);
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) parts.push(`cause: ${describeError(cause, depth + 1)}`);
  return parts.join(' · ');
}

// Private pipe contract, never exposed through the renderer's request union.
export type Credentials = { provider: 'deepseek'; key: string } | { provider: 'codex'; access: string; accountId: string };
export interface TurnToolOutput { text: string; modelOutput: ModelToolOutput }
export interface TurnTool { name: string; description: string; inputSchema: unknown; execute(args: unknown): Promise<string | TurnToolOutput> }
export interface Turn {
  conversationId: string;
  thinking?: Thinking | null;
  model: string;
  provider: Provider;
  instructions: string;
  messages: ModelMessage[];
  credentials: Credentials;
  tools?: TurnTool[];
  context?: {
    turn: ContextTurn;
    imageAccounting: import('@shared/context').ImageAccounting;
    onUpdate(update: ContextUpdate): void;
  };
}
export type Generate = (turn: Turn, signal: AbortSignal) => AsyncIterable<string | TurnToolOutput>;
export type BuiltInForegroundSource = { sourceMessageId: string; sourceRevision: number };
export type BuiltInToolSource = (conversationId: string, signal: AbortSignal, foregroundSource?: BuiltInForegroundSource) => Toolbag | Promise<Toolbag>;
export function history(messages: Message[], attachments: Attachment[] = [], readImage?: (id: string) => Uint8Array) {
  let textSize = 0;
  let imageSize = 0;
  let imageCount = 0;
  const result: ModelMessage[] = [];
  const byMessage = new Map<string, Attachment[]>();
  for (const attachment of attachments) byMessage.set(attachment.messageId, [...(byMessage.get(attachment.messageId) ?? []), attachment]);
  for (const message of [...messages].reverse()) {
    if (!message.text || message.status === 'streaming' || (message.role === 'assistant' && message.status !== 'complete')) continue;
    if (textSize + message.text.length > 60000) break;
    const images: Attachment[] = [];
    if (message.role === 'user') {
      for (const image of byMessage.get(message.id) ?? []) {
        if (imageCount >= 4 || imageSize + image.byteSize > 32 * 1024 * 1024) continue;
        images.push(image); imageCount++; imageSize += image.byteSize;
      }
    }
    textSize += message.text.length;
    result.unshift(images.length
      ? { role: 'user', content: [{ type: 'text', text: message.text }, ...images.map((image) => ({ type: 'image' as const, image: readImage!(image.id), mediaType: image.mime }))] }
      : { role: message.role, content: message.text });
  }
  return result;
}
function summarizeToolText(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 160) : '';
}
export class Chat {
  private active = new Map<string, { abort: AbortController; finish: () => void }>();
  constructor(
    private store: Store,
    private generate: Generate,
    private publish: (result: Result) => void,
    private toolSource?: (signal: AbortSignal, evidence: SelectionEvidence, config?: ToolLoadingConfig) => Promise<Toolbag>,
    private builtInToolSource?: BuiltInToolSource,
    private memoryConfig: MemoryHostConfig | (() => MemoryHostConfig) = DEFAULT_MEMORY_HOST_CONFIG,
  ) {}
  start(input: { conversationId: string; text: string; model: string; thinking?: Thinking | null; attachmentIds?: unknown[]; editOf?: string; credentials: Credentials; toolLoading?: ToolLoadingConfig; memoryJevKey?: string }): Result {
    const id = text(input.conversationId, 100);
    if (input.editOf !== undefined && typeof input.editOf !== 'string') throw new Error('Invalid edit target.');
    const body = text(input.text, 16000);
    const toolLoading = input.toolLoading === undefined ? undefined : requireToolLoading(input.toolLoading);
    const attachmentIds = input.attachmentIds === undefined ? [] : input.attachmentIds;
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 1) throw new Error('Invalid attachments.');
    for (const attachmentId of attachmentIds) requireAttachmentId(attachmentId);
    const assistant = this.store.assistantFor(id);
    const thinking = requireThinking(assistant.provider, input.model, input.thinking);
    if (!input.credentials || input.credentials.provider !== assistant.provider) throw new Error('Provider changed. Send again with the selected provider.');
    if (input.credentials.provider === 'deepseek') text(input.credentials.key, 32000);
    else { text(input.credentials.access, 32000); text(input.credentials.accountId, 32000); }
    if (input.memoryJevKey !== undefined) text(input.memoryJevKey, 1000);
    if (this.active.has(id)) throw new Error('This conversation is already replying.');
    const { messageId } = this.store.begin(id, body, input.model, thinking, attachmentIds, input.editOf);
    // The source is resolved by the host from the just-created turn. Built-in
    // memory mutations receive this closed-over identity, never a model field.
    const foregroundSource = this.store.foregroundUserSource(messageId);
    const turnId = crypto.randomUUID();
    const contextTurn: ContextTurn = { conversationId: id, messageId, turnId };
    const visible = this.store.messages(id).filter(message => message.id !== messageId && (message.role === 'user' || message.status === 'complete'));
    const evidence = { request: body.slice(0, 8000), recent: visible.slice(0, -1).slice(-4).map(message => `${message.role}: ${message.text.slice(-1000)}`).join('\n').slice(-2000) };
    const abort = new AbortController();
    const memoryRecallAbort = new AbortController();
    const abortMemoryRecall = () => memoryRecallAbort.abort();
    abort.signal.addEventListener('abort', abortMemoryRecall, { once: true });
    const initialMemoryConfig = typeof this.memoryConfig === 'function' ? this.memoryConfig() : this.memoryConfig;
    const initialMemoryPolicy = { enabled: initialMemoryConfig.enabled, recall: initialMemoryConfig.recall, jevConsent: initialMemoryConfig.jevConsent, jevModel: initialMemoryConfig.jevModel };
    let stopMemoryPolicyWatch: (() => void) | undefined;
    let bag: Toolbag | undefined;
    let builtInBag: Toolbag | undefined;
    const toolCalls: ToolCallRecord[] = [];
    let output = '';
    let contextUsage: ContextUsage | undefined;
    let memoryRecall: MemoryRecallInspection | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer); timer = undefined;
      this.store.updateReply(messageId, output, 'streaming', null, toolCalls);
      this.publish({ snapshot: this.store.snapshot(id), conversationId: id, contextUsage, memory: this.store.memorySettings(), memoryRecall });
    };
    const finish = (status: Message['status'], error: string | null = null) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(deadline);
      bag?.close();
      builtInBag?.close();
      memoryRecallAbort.abort();
      abort.signal.removeEventListener('abort', abortMemoryRecall);
      stopMemoryPolicyWatch?.();
      stopMemoryPolicyWatch = undefined;
      this.store.updateReply(messageId, output, status, error, toolCalls);
      this.active.delete(id);
      this.publish({ snapshot: this.store.snapshot(id), conversationId: id, contextUsage, memory: this.store.memorySettings(), memoryRecall });
    };
    // Plain replies keep the three-minute bound. Turns that end up with tools
    // re-arm to ten minutes: desktop actions plus model roundtrips add up, and
    // the deadline (not the step budget) is what stops runaway loops.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = (ms: number) => { clearTimeout(deadline); deadline = setTimeout(() => { abort.abort(); finish('failed', 'Reply timed out. You can send a new message.'); }, ms); };
    armDeadline(180000);
    this.active.set(id, { abort, finish: () => finish('interrupted') });
    stopMemoryPolicyWatch = this.store.onMessageEvent((event) => {
      if (event.type !== 'settings') return;
      const current = this.store.memorySettings();
      if (current.enabled !== initialMemoryPolicy.enabled || current.recall !== initialMemoryPolicy.recall || current.jevConsent !== initialMemoryPolicy.jevConsent || current.jevModel !== initialMemoryPolicy.jevModel) {
        memoryRecallAbort.abort();
      }
    });
    // Start after the request has been acknowledged. Enabled tools (Cua Driver
    // plus connected apps) run inline through lazily spawned sessions that
    // finish() always closes.
    queueMicrotask(() => { void (async () => {
      try {
        if (this.toolSource) { try { bag = await this.toolSource(abort.signal, evidence, toolLoading); } catch (error) {
          // Plan 18: an over-budget toolset fails the turn with guidance — it
          // must never degrade to a silent toolless reply.
          if (error instanceof ToolBudgetError) {
            console.error(`[moki] tool budget exceeded conversation=${id}: ${error.detail} (total ${error.total} > ${error.budget})`);
            finish('failed', error.message);
            return;
          }
          console.error(`[moki] tool source unavailable, continuing without tools: ${describeError(error)}`); bag = undefined; } }
        if (finished || abort.signal.aborted) { bag?.close(); bag = undefined; return; }
        if (this.builtInToolSource) builtInBag = await this.builtInToolSource(id, abort.signal, foregroundSource);
        if (finished || abort.signal.aborted) { bag?.close(); builtInBag?.close(); bag = undefined; builtInBag = undefined; return; }
        if (bag?.tools.length || builtInBag?.tools.length) armDeadline(600000);
        const owners = new Map<string, Toolbag>();
        const definitions: Array<{ name: string; description: string; inputSchema: unknown }> = [];
        for (const source of [builtInBag, bag]) {
          if (!source) continue;
          for (const definition of source.tools) {
            if (owners.has(definition.name)) {
              console.error(`[moki] built-in tool kept duplicate name ${definition.name}`);
              continue;
            }
            owners.set(definition.name, source);
            definitions.push(definition);
          }
        }
        const tools = definitions.map((definition) => ({
          ...definition,
          execute: async (args: unknown): Promise<string | TurnToolOutput> => {
            abort.signal.throwIfAborted();
            // App-connection tools carry a `__` prefix separator; Cua names do not.
            const appTool = definition.name.includes('__');
            const entry: ToolCallRecord = { name: definition.name, label: appTool ? mcpToolLabel(definition.name) : cuaToolLabel(definition.name), detail: appTool ? describeMcpCall(definition.name, args) : describeCuaCall(definition.name, args), summary: null, status: 'running', at: Date.now() };
            toolCalls.push(entry);
            if (!timer) timer = setTimeout(flush, 60);
            try {
              const result = await owners.get(definition.name)!.execute(definition.name, args);
              entry.status = result.isError ? 'failed' : 'ok';
              entry.summary = summarizeToolText(result.text);
              if (result.isError) return `Tool error: ${result.text.slice(0, 2000)}`;
              return result.modelOutput ? { text: result.text, modelOutput: result.modelOutput } : result.text;
            } catch (error) {
              if (abort.signal.aborted) throw error;
              entry.status = 'failed';
              entry.summary = (error instanceof Error ? error.message : 'Tool failed.').slice(0, 160);
              return `Tool failed: ${entry.summary}`;
            } finally {
              if (!timer) timer = setTimeout(flush, 60);
            }
          },
        }));
        const messages = this.store.messages(id);
        const attachments = this.store.attachmentsFor(messages);
        let activeMemoryConfig = typeof this.memoryConfig === 'function' ? this.memoryConfig() : this.memoryConfig;
        let recalled: BasicRecallResult | JevRecallResult;
        try {
          recalled = await recallJev(
            this.store.memoryRepository,
            this.store.memoryGraphRepository,
            evidence,
            activeMemoryConfig,
            memoryRecallAbort.signal,
            input.memoryJevKey === undefined ? undefined : { key: input.memoryJevKey },
          );
        } catch (error) {
          if (abort.signal.aborted || !memoryRecallAbort.signal.aborted) throw error;
          // A privacy-policy change cancels Jev without cancelling the chat.
          // Re-read the gate and continue with local recall only.
          activeMemoryConfig = typeof this.memoryConfig === 'function' ? this.memoryConfig() : this.memoryConfig;
          const basic = recallBasic(this.store.memoryRepository, activeMemoryConfig);
          recalled = {
            ...basic,
            inspection: {
              mode: 'basic',
              outcome: 'memory_policy_changed',
              selected: basic.entries.slice(0, 16).map((entry) => ({ memoryId: entry.memory.id, revision: entry.memory.revision })),
              candidateCount: basic.candidateCount,
              descriptorCount: 0,
              relationshipCount: 0,
              elapsedMs: 0,
            },
          };
        }
        if (memoryRecallAbort.signal.aborted) {
          activeMemoryConfig = typeof this.memoryConfig === 'function' ? this.memoryConfig() : this.memoryConfig;
          const basic = recallBasic(this.store.memoryRepository, activeMemoryConfig);
          recalled = {
            ...basic,
            inspection: {
              mode: 'basic',
              outcome: 'memory_policy_changed',
              selected: basic.entries.slice(0, 16).map((entry) => ({ memoryId: entry.memory.id, revision: entry.memory.revision })),
              candidateCount: basic.candidateCount,
              descriptorCount: 0,
              relationshipCount: 0,
              elapsedMs: 0,
            },
          };
        }
        const selected = recalled.entries.slice(0, 16).map((entry) => ({ memoryId: entry.memory.id, revision: entry.memory.revision }));
        const baseInspection = 'inspection' in recalled ? recalled.inspection : {
          mode: 'basic' as const,
          outcome: activeMemoryConfig.enabled ? 'basic' : 'disabled',
          selected,
          candidateCount: recalled.candidateCount,
          descriptorCount: 0,
          relationshipCount: 0,
          elapsedMs: 0,
        };
        memoryRecall = { ...baseInspection, messageId };
        this.store.recordMemoryRecall(id, messageId, memoryRecall);
        const instructions = assembleTurnInstructions(assistant.instructions, [
          builtInBag ? SESSION_SEARCH_GUIDANCE : '',
          activeMemoryConfig.enabled ? MEMORY_TOOL_GUIDANCE : '',
          recalled.context,
        ]);
        const modelMessages = history(messages, attachments, (attachmentId) => this.store.attachmentBytes(attachmentId));
        const draftImageTokens = estimateContextUsage(messages, attachments, '').imageTokens;
        const imageAccounting = createImageAccounting(countModelImages(modelMessages), draftImageTokens);
        const turn: Turn = {
          conversationId: id,
          thinking,
          model: input.model,
          provider: assistant.provider,
          instructions,
          credentials: input.credentials,
          tools: tools.length ? tools : undefined,
          messages: modelMessages,
          context: {
            turn: contextTurn,
            imageAccounting,
            onUpdate: (update) => {
              if (finished || abort.signal.aborted) return;
              if (update.type === 'estimate') {
                contextUsage = {
                  turn: contextTurn,
                  model: input.model,
                  contextWindowTokens: update.contextWindowTokens,
                  outputReserveTokens: update.outputReserveTokens,
                  requestNumber: update.requestNumber,
                  estimate: update.estimate,
                  estimateSource: 'heuristic',
                };
              } else if (contextUsage?.requestNumber === update.requestNumber) {
                contextUsage = {
                  ...contextUsage,
                  providerReported: {
                    inputTokens: update.inputTokens,
                    outputTokens: update.outputTokens,
                    totalTokens: update.totalTokens,
                    source: 'ai-sdk-provider-usage',
                    billingExact: false,
                  },
                };
              }
              this.publish({ snapshot: this.store.snapshot(id), conversationId: id, contextUsage, memory: this.store.memorySettings(), memoryRecall });
            },
          },
        };
        for await (const delta of this.generate(turn, abort.signal)) {
          if (finished || abort.signal.aborted) return;
          const textDelta = typeof delta === 'string' ? delta : delta.text;
          if (output.length + textDelta.length > 64000) { abort.abort(); finish('failed', 'Reply reached the size limit. Ask for a shorter answer.'); return; }
          output += textDelta;
          if (!timer) timer = setTimeout(flush, 60);
        }
        if (!finished) finish(abort.signal.aborted ? 'interrupted' : output ? 'complete' : 'failed', !output && !abort.signal.aborted ? 'The model returned no text. Try another model.' : null);
      } catch (error) {
        if (!abort.signal.aborted) console.error(`[moki] turn failed conversation=${id} provider=${assistant.provider} model=${input.model}: ${describeError(error)}`);
        const status = (error as { statusCode?: number })?.statusCode;
        const message = error instanceof Error && error.name === 'ContextBudgetError'
          ? error.message
          : status === 401 || status === 403 ? 'Provider rejected access. Reconnect it in Settings.' : status === 429 ? 'Provider limit reached. Wait before sending another message.' : status === 400 || status === 404 ? 'This model or request is unavailable. Select another model.' : 'Reply failed. Check your connection and provider settings. No automatic retry was made.';
        finish(abort.signal.aborted ? 'interrupted' : 'failed', abort.signal.aborted ? null : message);
      }
    })(); });
    return { snapshot: this.store.snapshot(id), conversationId: id, contextTurn };
  }
  cancel(id: string): Result {
    this.store.conversation(id);
    const active = this.active.get(id);
    active?.abort.abort(); active?.finish();
    return { snapshot: this.store.snapshot(id), conversationId: id };
  }
  close() { for (const id of [...this.active.keys()]) this.cancel(id); }
}
