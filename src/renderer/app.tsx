import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Request, Result } from '../shared/protocol';
import { MODELS, defaultModel, thinkingLevels, type Thinking } from '../shared/models';
import { applyResult, type ChatState } from './chat-state';
import { Settings } from './settings';
import { History } from './history';
import { Companion, INITIAL_APPEARANCE } from './companion';
import { ChatCompanion } from './chat-companion';
import { useTone, rememberPalette } from './tone';
import { platformClass } from './platform';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SimpleSelect } from './ui/select';
import { Banner } from './ui/panel';
import { ArrowUp, Clock, Gear, Plus, Stop, Zap } from './ui/icons';

const PROVIDER_LABELS = { deepseek: 'DeepSeek', codex: 'Codex subscription' } as const;
const AUTO_THINKING = 'auto';

function App() {
  const [state, setState] = useState<ChatState>({ revision: 0, histories: {} });
  const data = state.data;
  const [assistantId, setAssistantId] = useState('povondra');
  const [conversationId, setConversationId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const assistant = data?.assistants.find((item) => item.id === assistantId);
  const conversations = data?.conversations.filter((item) => item.assistantId === assistantId) ?? [];
  const conversation = conversations.find((item) => item.id === conversationId);
  const messages = data?.messages.filter((item) => item.conversationId === conversationId) ?? [];
  const running = messages.some((m) => m.status === 'streaming');
  const loaded = !!conversationId && state.histories[conversationId] !== undefined;
  const draftKey = conversationId ?? `new:${assistantId}`;
  const draft = drafts[draftKey] ?? '';
  const models = MODELS.filter((item) => item.provider === assistant?.provider);
  const model = conversation?.model ?? (assistant ? defaultModel(assistant.provider) : '');
  const validModel = models.some((item) => item.id === model);
  const levels = validModel && assistant ? thinkingLevels(assistant.provider, model) : [];
  const thinking = conversation?.thinking ?? null;
  const appearance = assistant?.appearance ?? INITIAL_APPEARANCE;
  const live = { messages, starting, failed: runtimeFailed || !!error };
  const dataRef = useRef(data); dataRef.current = data;
  useTone(appearance.palette);
  useEffect(() => { rememberPalette(appearance.palette); }, [appearance.palette]);
  function accept(result: Result) { setState((previous) => applyResult(previous, result)); }
  async function perform(request: Request): Promise<Result | undefined> {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { const result = await window.povondra.request(request); accept(result); return result; }
    catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => {
    const unsubscribe = window.povondra.onState(accept);
    const unsubscribeError = window.povondra.onRuntimeError((message) => {
      setError(message); setRuntimeFailed(true); setStarting(false);
      setState((previous) => ({ ...previous, data: previous.data && { ...previous.data, messages: previous.data.messages.map((m) => m.status === 'streaming' ? { ...m, status: 'interrupted' } : m) } }));
    });
    void perform({ method: 'snapshot' }).then((result) => {
      setConversationId(result?.snapshot.conversations.find((item) => item.assistantId === 'povondra')?.id);
    });
    return () => { unsubscribe(); unsubscribeError(); };
  }, []);
  useEffect(() => {
    nearBottom.current = true;
    if (conversationId) void window.povondra.request({ method: 'snapshot', conversationId }).then(accept).catch((e) => setError(String(e)));
  }, [conversationId]);
  useEffect(() => { if (nearBottom.current) bottom.current?.scrollIntoView(); }, [conversationId, messages.at(-1)?.text, messages.length]);
  useEffect(() => { // Composer grows with the draft, up to a cap.
    const el = composer.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);
  useEffect(() => {
    // Picking a session in the History window switches this conversation.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'povondra:open-conversation') return;
      try {
        const { id } = JSON.parse(event.newValue ?? '{}') as { id?: string };
        const picked = dataRef.current?.conversations.find((item) => item.id === id);
        if (!picked) return;
        setAssistantId(picked.assistantId);
        setConversationId(picked.id);
        setError('');
      } catch { /* Corrupt pick payloads are ignored. */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (runtimeFailed || !draft.trim() || lock.current || running || !conversationId || !validModel || !loaded) return;
    lock.current = true; setBusy(true); setStarting(true); setError('');
    try {
      accept(await window.povondra.chat({ conversationId, text: draft, model, thinking }));
      setDrafts((current) => ({ ...current, [draftKey]: '' }));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not send. Your draft is still here.'); }
    finally { lock.current = false; setBusy(false); setStarting(false); }
  }
  async function stop() {
    if (!conversationId) return;
    try { accept(await window.povondra.request({ method: 'cancelChat', conversationId })); }
    catch (e) { setError(String(e)); }
  }
  async function newChat() {
    const result = await perform({ method: 'createConversation', assistantId });
    if (result) setConversationId(result.conversationId);
  }
  return <main className={`flex h-dvh flex-col ${platformClass ?? ''}`}>
    {/* Titlebar: one quiet cluster on the traffic-light line. New conversation
        is the filled accent circle (like Messages' compose); switcher, history,
        and settings stay quiet beside it. */}
    <header className="titlebar flex min-h-12 items-center justify-end gap-1 pr-2.5 pb-2">
      <Select value={assistantId} disabled={busy || !data} onValueChange={(id) => {
        setAssistantId(id); setError('');
        setConversationId(data?.conversations.find((item) => item.assistantId === id)?.id);
      }}>
        <SelectTrigger aria-label="Companion" className="h-7 w-auto shrink-0 border-transparent bg-transparent px-2 text-[12.5px] font-medium text-ink-2 hover:border-transparent hover:bg-hover hover:text-ink focus:ring-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {data?.assistants.map((item) => <SelectItem key={item.id} value={item.id} hint={PROVIDER_LABELS[item.provider]}>{item.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button variant="primary" size="round-sm" aria-label="New conversation" title="New conversation" disabled={busy || !data} onClick={() => void newChat()}><Plus className="h-3 w-3" strokeWidth={1.5} /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="History" title="History" disabled={busy} onClick={() => void window.povondra.openHistory().catch((e) => setError(String(e)))}><Clock /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="Settings" title="Settings" disabled={busy} onClick={() => void window.povondra.openSettings().catch((e) => setError(String(e)))}><Gear /></Button>
    </header>
    {/* Presence zone: the avatar exists on its own, clear of the window-drag
        region and any nested controls, so it can later take click, hold, and
        drag interaction directly. */}
    <section className="flex justify-center px-4 pb-3" aria-label="Companion">
      <span className="avatar-stage grid place-items-center rounded-[2rem] p-3">
        <span className="block w-20"><ChatCompanion appearance={appearance} {...live} /></span>
      </span>
    </section>
    <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" aria-label="Conversation" onScroll={(e) => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
      {!messages.length && <div className="mx-auto grid max-w-64 justify-items-center gap-3 pt-4 text-center">
        <p className="text-[15px] leading-snug font-semibold">What can {assistant?.name ?? 'your companion'} help with?</p>
        {!conversationId && <>
          <Button variant="primary" size="sm" disabled={busy || !data} onClick={() => void newChat()}>Start a conversation</Button>
          <p className="text-[12px] text-ink-3">Connect a provider in Settings, pick a model below, and chat.</p>
        </>}
      </div>}
      {messages.length >= 100 && <p className="pb-2 text-center text-[11px] text-ink-3">Showing the latest 100 messages. Older messages are still saved.</p>}
      <div className="grid gap-5">
        {messages.map((message) => message.role === 'assistant'
          ? <article key={message.id} className="flex gap-2.5">
            <span className="mt-0.5 w-5 shrink-0">{message.status === 'streaming' ? <ChatCompanion appearance={appearance} messages={[message]} starting={false} failed={false} /> : <Companion appearance={appearance} paused />}</span>
            <div className="grid min-w-0 flex-1 gap-1.5 self-start">
              {message.text
                ? <p className="message-text text-[13.5px] leading-relaxed text-ink">{message.text}{message.status === 'interrupted' && <span className="ml-1.5 text-[11px] text-ink-3">stopped</span>}</p>
                : message.status === 'streaming' && <p className="text-[13.5px] text-ink-3">Thinking…</p>}
              {message.error && <Banner>{message.error}</Banner>}
            </div>
          </article>
          : <div key={message.id} className="flex justify-end">
            <p className="message-text max-w-[85%] rounded-2xl rounded-br-md border border-accent-line bg-accent-soft px-3.5 py-2 text-[13.5px] leading-relaxed text-ink">{message.text}</p>
          </div>)}
      </div>
      <div ref={bottom} />
    </section>
    {error && <div className="px-3 pb-2">
      <Banner action={!data
        ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void perform({ method: 'snapshot' })}>Retry connection</Button>
        : undefined}>{error}</Banner>
    </div>}
    {/* Composer owns the session config: model and thinking are quiet chips
        next to send, set once and out of the way. */}
    <form className="mx-3 mb-3" onSubmit={send}>
      <div className="glass rounded-[1.4rem] p-1.5 shadow-[var(--shadow-glass)]" style={{ animation: 'rise-in .25s ease-out' }}>
        <label className="sr-only" htmlFor="message">Message</label>
        <textarea
          id="message"
          ref={composer}
          placeholder={conversationId ? 'Message' : 'Start a conversation first'}
          rows={1}
          maxLength={16000}
          disabled={busy || !conversationId}
          value={draft}
          onChange={(e) => setDrafts({ ...drafts, [draftKey]: e.target.value })}
          className="block max-h-40 w-full resize-none bg-transparent px-3 pt-2 pb-1 text-[13.5px] leading-relaxed text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-50" />
        <div className="flex items-center justify-between gap-2 px-1 pb-0.5">
          <div className="flex min-w-0 items-center">
            {conversationId && <>
              <SimpleSelect
                compact
                aria-label="Model"
                value={validModel ? model : ''}
                placeholder="Select model"
                disabled={busy || running}
                onValueChange={(id) => void perform({ method: 'selectModel', conversationId: conversationId!, model: id })}
                options={models.map((item) => ({ value: item.id, label: item.name }))} />
              {validModel && levels.length > 0 && <SimpleSelect
                compact
                aria-label="Thinking level"
                value={thinking ?? AUTO_THINKING}
                disabled={busy || running}
                onValueChange={(value) => void perform({ method: 'selectModel', conversationId: conversationId!, model, thinking: (value === AUTO_THINKING ? null : value) as Thinking | null })}
                options={[{ value: AUTO_THINKING, label: <span className="flex items-center gap-1"><Zap />Auto</span> }, ...levels.map((level) => ({ value: level, label: level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1) }))]} />}
            </>}
          </div>
          {running || starting
            ? <Button variant="secondary" size="round" aria-label="Stop" title="Stop" onClick={() => void stop()}><Stop /></Button>
            : <Button variant="primary" size="round" aria-label="Send message" title="Send" disabled={runtimeFailed || busy || !draft.trim() || !loaded || !validModel} type="submit"><ArrowUp /></Button>}
        </div>
      </div>
    </form>
  </main>;
}
createRoot(document.getElementById('root')!).render(location.hash === '#settings' ? <Settings /> : location.hash === '#history' ? <History /> : <App />);
