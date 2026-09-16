import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Request, Result } from '../shared/protocol';
import { MODELS, defaultModel, thinkingLevels, type Thinking } from '../shared/models';
import { applyResult, type ChatState } from './chat-state';
import { Settings } from './settings';
import { INITIAL_APPEARANCE } from './companion';
import { ChatCompanion } from './chat-companion';
import './companion.css';
import './app.css';

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
  return <main>
    <header>
      <span className="saved-companion"><ChatCompanion appearance={assistant?.appearance ?? INITIAL_APPEARANCE} messages={messages} starting={starting} failed={runtimeFailed || !!error} /></span>
      <div className="identity"><label htmlFor="assistant">Your companion</label>
        <select id="assistant" value={assistantId} disabled={busy || !data} onChange={(event) => {
          const id = event.target.value; setAssistantId(id); setError('');
          setConversationId(data?.conversations.find((item) => item.assistantId === id)?.id);
        }}>{data?.assistants.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      </div>
      <button onClick={() => void window.povondra.openSettings().catch((e) => setError(String(e)))}>Settings</button>
    </header>
    <nav aria-label="Conversations">
      <select aria-label="Conversation history" disabled={busy || !conversations.length} value={conversationId ?? ''} onChange={(e) => { setConversationId(e.target.value); setError(''); }}>
        {!conversationId && <option value="">Your conversations</option>}
        {conversations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <button disabled={busy || !data} onClick={() => void newChat()}>New chat</button>
    </nav>
    <div className="model-picker"><label htmlFor="model">Model</label><select id="model" disabled={busy || running || !conversationId} value={model} onChange={(e) => void perform({ method: 'selectModel', conversationId: conversationId!, model: e.target.value })}>
      {!validModel && <option value={model}>Select a model for {assistant?.provider}</option>}
      {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></div>
    <div className="model-picker"><label htmlFor="thinking">Thinking</label><select id="thinking" disabled={busy || running || !conversationId || !validModel} value={thinking ?? ''} onChange={(e) => void perform({ method: 'selectModel', conversationId: conversationId!, model, thinking: (e.target.value || null) as Thinking | null })}>
      <option value="">Default</option>
      {levels.map((level) => <option key={level} value={level}>{level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1)}</option>)}
    </select></div>
    <section className="transcript" aria-label="Conversation" onScroll={(e) => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
      {!messages.length && <div className="welcome"><div className="flower" aria-hidden="true">✿</div><h1>A little space to think.</h1><p>What can {assistant?.name ?? 'your companion'} help with?</p><p className="muted">Connect a provider in Settings, choose a model, and chat.</p>{!conversationId && <button className="primary" disabled={busy || !data} onClick={() => void newChat()}>Start a conversation</button>}</div>}
      {messages.length >= 100 && <p className="muted">Showing the latest 100 messages. Older messages are still saved.</p>}
      {messages.map((message) => <article className={`message ${message.role === 'assistant' ? 'assistant-message' : ''}`} key={message.id}>
        <span className="message-label">{message.role === 'assistant' ? `${message.assistantName ?? 'Assistant'} · ${message.model ?? ''}` : 'You'}</span>
        <p>{message.text || (message.status === 'streaming' ? 'Thinking…' : '')}</p>
        {message.status === 'interrupted' && <small>Stopped</small>}
        {message.error && <p className="error" role="alert">{message.error}</p>}
      </article>)}
      <div ref={bottom} />
    </section>
    <form className="composer" onSubmit={send}>
      <label className="sr-only" htmlFor="message">Message</label>
      <textarea id="message" placeholder={conversationId ? 'What’s on your mind?' : 'Start a conversation first'} rows={3} maxLength={16000} disabled={busy || !conversationId} value={draft} onChange={(e) => setDrafts({ ...drafts, [draftKey]: e.target.value })} />
      <div className="composer-footer"><small>{running || starting ? 'Replying…' : 'Text chat · No tools yet'}</small>
        {running || starting ? <button type="button" onClick={() => void stop()}>Stop</button> : <button className="primary" disabled={runtimeFailed || busy || !draft.trim() || !loaded || !validModel}>Send</button>}
      </div>
    </form>
    {error && <div className="error" role="alert">{error}{!data && <button disabled={busy} onClick={() => void perform({ method: 'snapshot' })}>Retry connection</button>}</div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(location.hash === '#settings' ? <Settings /> : <App />);
