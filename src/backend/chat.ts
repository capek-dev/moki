import type { ModelMessage } from 'ai';
import { Store, text } from '@backend/store';
import { requireThinking, type Thinking } from '@shared/models';
import type { Attachment, Provider, Result, Message, ToolCallRecord } from '@shared/protocol';
import { requireAttachmentId } from '@shared/attachments';
import type { Toolbag } from '@backend/cua';
import { cuaToolLabel, describeCuaCall } from '@shared/cua';
import { describeMcpCall, mcpToolLabel } from '@shared/mcp';

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
export interface TurnTool { name: string; description: string; inputSchema: unknown; execute(args: unknown): Promise<string> }
export interface Turn { conversationId: string; thinking?: Thinking | null; model: string; provider: Provider; instructions: string; messages: ModelMessage[]; credentials: Credentials; tools?: TurnTool[] }
export type Generate = (turn: Turn, signal: AbortSignal) => AsyncIterable<string>;
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
  constructor(private store: Store, private generate: Generate, private publish: (result: Result) => void, private toolSource?: (signal: AbortSignal) => Promise<Toolbag>) {}
  start(input: { conversationId: string; text: string; model: string; thinking?: Thinking | null; attachmentIds?: unknown[]; editOf?: string; credentials: Credentials }): Result {
    const id = text(input.conversationId, 100);
    if (input.editOf !== undefined && typeof input.editOf !== 'string') throw new Error('Invalid edit target.');
    const body = text(input.text, 16000);
    const attachmentIds = input.attachmentIds === undefined ? [] : input.attachmentIds;
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 1) throw new Error('Invalid attachments.');
    for (const attachmentId of attachmentIds) requireAttachmentId(attachmentId);
    const assistant = this.store.assistantFor(id);
    const thinking = requireThinking(assistant.provider, input.model, input.thinking);
    if (!input.credentials || input.credentials.provider !== assistant.provider) throw new Error('Provider changed. Send again with the selected provider.');
    if (input.credentials.provider === 'deepseek') text(input.credentials.key, 32000);
    else { text(input.credentials.access, 32000); text(input.credentials.accountId, 32000); }
    if (this.active.has(id)) throw new Error('This conversation is already replying.');
    const { messageId } = this.store.begin(id, body, input.model, thinking, attachmentIds, input.editOf);
    const abort = new AbortController();
    let bag: Toolbag | undefined;
    const toolCalls: ToolCallRecord[] = [];
    let output = '';
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer); timer = undefined;
      this.store.updateReply(messageId, output, 'streaming', null, toolCalls);
      this.publish({ snapshot: this.store.snapshot(id), conversationId: id });
    };
    const finish = (status: Message['status'], error: string | null = null) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(deadline);
      bag?.close();
      this.store.updateReply(messageId, output, status, error, toolCalls);
      this.active.delete(id);
      this.publish({ snapshot: this.store.snapshot(id), conversationId: id });
    };
    // Plain replies keep the three-minute bound. Turns that end up with tools
    // re-arm to ten minutes: desktop actions plus model roundtrips add up, and
    // the deadline (not the step budget) is what stops runaway loops.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = (ms: number) => { clearTimeout(deadline); deadline = setTimeout(() => { abort.abort(); finish('failed', 'Reply timed out. You can send a new message.'); }, ms); };
    armDeadline(180000);
    this.active.set(id, { abort, finish: () => finish('interrupted') });
    // Start after the request has been acknowledged. Enabled tools (Cua Driver
    // plus connected apps) run inline through lazily spawned sessions that
    // finish() always closes.
    queueMicrotask(() => { void (async () => {
      try {
        if (this.toolSource) { try { bag = await this.toolSource(abort.signal); } catch (error) { console.error(`[moki] tool source unavailable, continuing without tools: ${describeError(error)}`); bag = undefined; } }
        if (bag?.tools.length) armDeadline(600000);
        const tools = bag?.tools.map((definition) => ({
          ...definition,
          execute: async (args: unknown): Promise<string> => {
            abort.signal.throwIfAborted();
            // App-connection tools carry a `__` prefix separator; Cua names do not.
            const appTool = definition.name.includes('__');
            const entry: ToolCallRecord = { name: definition.name, label: appTool ? mcpToolLabel(definition.name) : cuaToolLabel(definition.name), detail: appTool ? describeMcpCall(definition.name, args) : describeCuaCall(definition.name, args), summary: null, status: 'running', at: Date.now() };
            toolCalls.push(entry);
            if (!timer) timer = setTimeout(flush, 60);
            try {
              const result = await bag!.execute(definition.name, args);
              entry.status = result.isError ? 'failed' : 'ok';
              entry.summary = summarizeToolText(result.text);
              return result.isError ? `Tool error: ${result.text.slice(0, 2000)}` : result.text;
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
        const turn: Turn = { conversationId: id, thinking, model: input.model, provider: assistant.provider, instructions: assistant.instructions, credentials: input.credentials, tools, messages: history(messages, this.store.attachmentsFor(messages), (attachmentId) => this.store.attachmentBytes(attachmentId)) };
        for await (const delta of this.generate(turn, abort.signal)) {
          if (finished || abort.signal.aborted) return;
          if (output.length + delta.length > 64000) { abort.abort(); finish('failed', 'Reply reached the size limit. Ask for a shorter answer.'); return; }
          output += delta;
          if (!timer) timer = setTimeout(flush, 60);
        }
        if (!finished) finish(abort.signal.aborted ? 'interrupted' : output ? 'complete' : 'failed', !output && !abort.signal.aborted ? 'The model returned no text. Try another model.' : null);
      } catch (error) {
        if (!abort.signal.aborted) console.error(`[moki] turn failed conversation=${id} provider=${assistant.provider} model=${input.model}: ${describeError(error)}`);
        const status = (error as { statusCode?: number })?.statusCode;
        const message = status === 401 || status === 403 ? 'Provider rejected access. Reconnect it in Settings.' : status === 429 ? 'Provider limit reached. Wait before sending another message.' : status === 400 || status === 404 ? 'This model or request is unavailable. Select another model.' : 'Reply failed. Check your connection and provider settings. No automatic retry was made.';
        finish(abort.signal.aborted ? 'interrupted' : 'failed', abort.signal.aborted ? null : message);
      }
    })(); });
    return { snapshot: this.store.snapshot(id), conversationId: id };
  }
  cancel(id: string): Result {
    this.store.conversation(id);
    const active = this.active.get(id);
    active?.abort.abort(); active?.finish();
    return { snapshot: this.store.snapshot(id), conversationId: id };
  }
  close() { for (const id of [...this.active.keys()]) this.cancel(id); }
}
