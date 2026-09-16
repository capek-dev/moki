import { Store, text } from './store';
import { requireThinking, type Thinking } from '../shared/models';
import type { Provider, Result, Message } from '../shared/protocol';

// Private pipe contract, never exposed through the renderer's request union.
export type Credentials = { provider: 'deepseek'; key: string } | { provider: 'codex'; access: string; accountId: string };
export interface Turn { conversationId: string; thinking?: Thinking | null; model: string; provider: Provider; instructions: string; messages: { role: 'user' | 'assistant'; content: string }[]; credentials: Credentials }
export type Generate = (turn: Turn, signal: AbortSignal) => AsyncIterable<string>;
export function history(messages: Message[]) {
  let size = 0;
  const result: Turn['messages'] = [];
  for (const message of [...messages].reverse()) {
    if (!message.text || message.status === 'streaming' || (message.role === 'assistant' && message.status !== 'complete')) continue;
    if (size + message.text.length > 60000) break;
    size += message.text.length;
    result.unshift({ role: message.role, content: message.text });
  }
  return result;
}
export class Chat {
  private active = new Map<string, { abort: AbortController; finish: () => void }>();
  constructor(private store: Store, private generate: Generate, private publish: (result: Result) => void) {}
  start(input: { conversationId: string; text: string; model: string; thinking?: Thinking | null; credentials: Credentials }): Result {
    const id = text(input.conversationId, 100);
    const body = text(input.text, 16000);
    const assistant = this.store.assistantFor(id);
    const thinking = requireThinking(assistant.provider, input.model, input.thinking);
    if (!input.credentials || input.credentials.provider !== assistant.provider) throw new Error('Provider changed. Send again with the selected provider.');
    if (input.credentials.provider === 'deepseek') text(input.credentials.key, 32000);
    else { text(input.credentials.access, 32000); text(input.credentials.accountId, 32000); }
    if (this.active.has(id)) throw new Error('This conversation is already replying.');
    const { messageId } = this.store.begin(id, body, input.model, thinking);
    const abort = new AbortController();
    let output = '';
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer); timer = undefined;
      this.store.updateReply(messageId, output, 'streaming');
      this.publish({ snapshot: this.store.snapshot(id), conversationId: id });
    };
    const finish = (status: Message['status'], error: string | null = null) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(deadline);
      this.store.updateReply(messageId, output, status, error);
      this.active.delete(id);
      this.publish({ snapshot: this.store.snapshot(id), conversationId: id });
    };
    const deadline = setTimeout(() => { abort.abort(); finish('failed', 'Reply timed out. You can send a new message.'); }, 180000);
    this.active.set(id, { abort, finish: () => finish('interrupted') });
    const turn: Turn = { conversationId: id, thinking, model: input.model, provider: assistant.provider, instructions: assistant.instructions, credentials: input.credentials, messages: history(this.store.messages(id)) };
    // Start after the request has been acknowledged. Tool execution is not enabled.
    queueMicrotask(() => { void (async () => {
      try {
        for await (const delta of this.generate(turn, abort.signal)) {
          if (finished || abort.signal.aborted) return;
          if (output.length + delta.length > 64000) { abort.abort(); finish('failed', 'Reply reached the size limit. Ask for a shorter answer.'); return; }
          output += delta;
          if (!timer) timer = setTimeout(flush, 60);
        }
        if (!finished) finish(abort.signal.aborted ? 'interrupted' : output ? 'complete' : 'failed', !output && !abort.signal.aborted ? 'The model returned no text. Try another model.' : null);
      } catch (error) {
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
