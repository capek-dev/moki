import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { AttachmentDraft, Message, Request, Result } from '@shared/protocol';
import { MODELS, defaultModel, supportsImageInput, thinkingLevels, type Thinking } from '@shared/models';
import { estimateContextUsage } from '@shared/context';
import { speechSegments } from '@shared/speech';
import { AttachmentImage } from '@renderer/components/chat/attachment-image';
import { applyResult, type ChatState } from '@renderer/lib/chat-state';
import { Companion, INITIAL_APPEARANCE } from '@renderer/components/companion/companion';
import { ChatCompanion } from '@renderer/components/companion/chat-companion';
import { Answer } from '@renderer/components/chat/answer';
import { ContextRing } from '@renderer/components/chat/context-ring';
import { useTone, rememberPalette } from '@renderer/lib/tone';
import { platformClass } from '@renderer/lib/platform';
import { Button } from '@renderer/components/ui/button';
import { SimpleSelect } from '@renderer/components/ui/select';
import { canChatWithMoki, mokiAssistant } from '@renderer/lib/moki';
import { Banner } from '@renderer/components/ui/panel';
import { ArrowUp, Capture, Clock, Gear, Mic, Pencil, Plus, Speaker, Stop, Undo, Zap } from '@renderer/components/ui/icons';
import { mapDictationError } from '@shared/dictation';

const AUTO_THINKING = 'auto';

// Quiet tool trail: one friendly "doing now" line while a tool runs, a
// collapsed summary afterwards. No sprawling per-call cards.
function ToolTrail({ message }: { message: Message }) {
  const calls = message.toolCalls ?? [];
  if (!calls.length) return null;
  const latest = calls.at(-1)!;
  if (message.status === 'streaming' && latest.status === 'running') {
    return <p className="flex items-center gap-1.5 text-[12.5px] text-ink-3" role="status">
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden="true" />
      <span className="truncate">{latest.label}{latest.detail ? ` · ${latest.detail}` : ''}…</span>
    </p>;
  }
  return <details className="group/details">
    <summary className="flex w-fit cursor-pointer select-none list-none items-center gap-1 text-[11.5px] text-ink-3 transition-colors hover:text-ink-2">
      <span className="transition-transform group-open/details:rotate-90" aria-hidden="true">▸</span>
      Used {calls.length} tool{calls.length === 1 ? '' : 's'}
    </summary>
    <ul className="mt-1 grid gap-0.5 border-l border-line pl-2.5">
      {calls.map((call, index) => <li key={index} className="flex min-w-0 items-baseline gap-1.5 text-[11px] leading-snug text-ink-3">
        <span className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] self-center rounded-full ${call.status === 'failed' ? 'bg-danger' : call.status === 'running' ? 'bg-ink-3/60' : 'bg-ok'}`} aria-hidden="true" />
        <span className="min-w-0 truncate">{call.label}{call.detail ? <span className="text-ink-3/70"> · {call.detail}</span> : null}</span>
      </li>)}
    </ul>
  </details>;
}

export function App() {
  const [state, setState] = useState<ChatState>({ revision: 0, histories: {} });
  const data = state.data;
  const [conversationId, setConversationId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  const [attachment, setAttachment] = useState<AttachmentDraft>();
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState('');
  // Spoken replies (plan 17 A): default on for the companion moment, one
  // click to mute forever; the choice persists locally.
  const [speakReplies, setSpeakReplies] = useState(() => { try { return localStorage.getItem('moki:speak-replies') !== 'off'; } catch { return true; } });
  const [speaking, setSpeaking] = useState(false);
  // Push-to-talk (plan 17 B): hold the mic button to dictate; the transcript
  // lands in the draft. Click-toggle works too for anyone who never finds the
  // hold gesture.
  const [dictating, setDictating] = useState(false);
  // Session bookkeeping for the native helper: the draft/edit text captured
  // when the hold began, and when the last session stopped (late finals from
  // the helper are accepted for a short grace window, older strays ignored).
  const dictationBase = useRef({ editingId: '', text: '' });
  const dictationStoppedAt = useRef(0);
  const draftKeyRef = useRef('');
  const lock = useRef(false);
  const scroller = useRef<HTMLElement>(null);
  // Which streaming reply has had how much speakable text spoken already
  // (character offset into the append-only segment stream).
  const spokenRef = useRef({ id: '', chars: 0 });
  const nearBottom = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const assistant = mokiAssistant(data?.assistants);
  const conversation = data?.conversations.find((item) => item.id === conversationId);
  const writable = canChatWithMoki(assistant, conversation);
  const earlier = !!conversation && !writable;
  const messages = data?.messages.filter((item) => item.conversationId === conversationId) ?? [];
  const messageAttachments = (messageId: string) => data?.attachments.filter((item) => item.messageId === messageId) ?? [];
  const running = messages.some((m) => m.status === 'streaming');
  const loaded = !!conversationId && state.histories[conversationId] !== undefined;
  const draftKey = conversationId ?? `new:${assistant?.id ?? 'moki'}`;
  draftKeyRef.current = draftKey;
  const draft = drafts[draftKey] ?? '';
  const body = editing ? editing.text : draft;
  const models = MODELS.filter((item) => item.provider === assistant?.provider);
  const model = conversation?.model ?? (assistant ? defaultModel(assistant.provider) : '');
  const validModel = models.some((item) => item.id === model);
  const contextModel = validModel ? MODELS.find((item) => item.id === model && item.provider === assistant?.provider) : undefined;
  // Same bounds the backend history() applies, so the ring reflects what the
  // next turn will actually send rather than raw transcript size.
  const contextEstimate = useMemo(
    () => estimateContextUsage(messages, data?.attachments ?? [], assistant?.instructions ?? ''),
    [messages, data?.attachments, assistant?.instructions],
  );
  const imageCapable = validModel && assistant ? supportsImageInput(assistant.provider, model) : false;
  const levels = validModel && assistant ? thinkingLevels(assistant.provider, model) : [];
  const thinking = conversation?.thinking ?? null;
  const appearance = assistant?.appearance ?? INITIAL_APPEARANCE;
  const author = data?.assistants.find((item) => item.id === conversation?.assistantId);
  const replyAppearance = earlier ? author?.appearance ?? INITIAL_APPEARANCE : appearance;
  const live = { messages, starting, failed: runtimeFailed || !!error };
  const dataRef = useRef(data); dataRef.current = data;
  const conversationRef = useRef(conversationId); conversationRef.current = conversationId;
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const attachmentRef = useRef(attachment); attachmentRef.current = attachment;
  const editingRef = useRef(editing); editingRef.current = editing;
  useTone(appearance.palette);
  useEffect(() => { rememberPalette(appearance.palette); }, [appearance.palette]);
  useEffect(() => window.moki.onSpeech((state) => setSpeaking(state.speaking)), []);
  // Complete sentences stream to the synthesizer as the reply grows; the
  // finished reply flushes its remainder. Tracking is a character offset
  // into the speakable prefix (segments are append-only), so every new
  // sentence ships exactly once. Interrupted and failed replies stay silent
  // after the cut, matching the Stop semantics. A new reply cuts off any
  // leftover audio from the previous one.
  useEffect(() => {
    if (!speakReplies) return;
    const active = messages.find((m) => m.role === 'assistant' && m.status === 'streaming')
      ?? (spokenRef.current.id ? messages.find((m) => m.id === spokenRef.current.id && m.status === 'complete') : undefined);
    if (!active) return;
    const flush = active.status === 'complete';
    const segments = speechSegments(active.text, { flush });
    const tracker = spokenRef.current;
    if (tracker.id !== active.id) {
      if (!flush) {
        if (tracker.id) void window.moki.stopSpeaking().catch(() => {});
        tracker.id = active.id; tracker.chars = 0;
      } else return;
    }
    const spoken = segments.join(' ');
    const fresh = spoken.slice(tracker.chars);
    if (!fresh.trim()) return;
    tracker.chars = spoken.length;
    // The speak IPC caps one call at 4000 characters; long flushes are
    // chunked so no sentence is ever dropped for being part of a big reply.
    for (let offset = 0; offset < fresh.length; offset += 4000) {
      void window.moki.speak(fresh.slice(offset, offset + 4000)).catch(() => {});
    }
  }, [speakReplies, messages.at(-1)?.text, messages.length, messages.at(-1)?.status]);
  function accept(result: Result) { setState((previous) => applyResult(previous, result)); }
  async function perform(request: Request): Promise<Result | undefined> {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { const result = await window.moki.request(request); accept(result); return result; }
    catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => {
    const unsubscribe = window.moki.onState(accept);
    const unsubscribeCapture = window.moki.onCapture((event) => {
      if (event.type === 'capture-started') { setCapturing(true); setError(''); return; }
      if (event.type === 'capture-cancelled') { setCapturing(false); return; }
      if (event.type === 'capture-failed') { setCapturing(false); setError(event.message); return; }
      if (event.type !== 'capture-ready') return;
      void (async () => {
        try {
          let snapshot = dataRef.current;
          if (!snapshot) { const result = await window.moki.request({ method: 'snapshot' }); accept(result); snapshot = result.snapshot; }
          const selected = mokiAssistant(snapshot.assistants);
          if (!selected) throw new Error('Moki is not ready yet. Try the capture again.');
          let target = snapshot.conversations.find((item) => item.id === conversationRef.current);
          if (!canChatWithMoki(selected, target)) {
            const oldKey = conversationRef.current ?? `new:${selected.id}`;
            const result = await window.moki.request({ method: 'createConversation', assistantId: selected.id });
            accept(result); target = result.snapshot.conversations.find((item) => item.id === result.conversationId);
            if (target && draftsRef.current[oldKey]) setDrafts((current) => ({ ...current, [target!.id]: current[oldKey] ?? '' }));
            setConversationId(result.conversationId);
          }
          if (attachmentRef.current) await window.moki.removeCapture(attachmentRef.current.id).catch(() => {});
          setAttachment(event.attachment); setCapturing(false); setError('');
          setTimeout(() => composer.current?.focus(), 0);
        } catch (cause) { setCapturing(false); setError(cause instanceof Error ? cause.message : 'Could not prepare the screenshot.'); }
      })();
    });
    const unsubscribeError = window.moki.onRuntimeError((message) => {
      setError(message); setRuntimeFailed(true); setStarting(false);
      setState((previous) => ({ ...previous, data: previous.data && { ...previous.data, messages: previous.data.messages.map((m) => m.status === 'streaming' ? { ...m, status: 'interrupted' } : m) } }));
    });
    const unsubscribeDictation = window.moki.onDictation((event) => {
      if (event.error) {
        setDictating(false);
        dictationStoppedAt.current = Date.now();
        const message = mapDictationError(event.error);
        if (message) setError(message);
        return;
      }
      if (event.final) setDictating(false);
      const text = event.transcript ?? '';
      if (text) applyDictation(text);
    });
    void perform({ method: 'snapshot' }).then((result) => {
      const initial = mokiAssistant(result?.snapshot.assistants);
      setConversationId(result?.snapshot.conversations.find((item) => item.assistantId === initial?.id)?.id);
    });
    return () => { unsubscribe(); unsubscribeCapture(); unsubscribeError(); unsubscribeDictation(); };
  }, []);
  useEffect(() => {
    nearBottom.current = true;
    setEditing(undefined);
    if (conversationId) void window.moki.request({ method: 'snapshot', conversationId }).then(accept).catch((e) => setError(String(e)));
  }, [conversationId]);
  // Scroll the conversation section directly: scrollIntoView() would also
  // programmatically scroll every overflow:hidden ancestor (root, document).
  useEffect(() => { const el = scroller.current; if (el && nearBottom.current) el.scrollTop = el.scrollHeight; }, [conversationId, messages.at(-1)?.text, messages.length]);
  useEffect(() => { // Composer grows with the draft, up to a cap.
    const el = composer.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft, editing?.text]);
  useEffect(() => {
    // Picking a session in the History window switches this conversation.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'moki:open-conversation') return;
      try {
        const { id } = JSON.parse(event.newValue ?? '{}') as { id?: string };
        const picked = dataRef.current?.conversations.find((item) => item.id === id);
        if (!picked) return;
        if (picked.id !== conversationRef.current) discardAttachment();
        setConversationId(picked.id);
        setError('');
      } catch { /* Corrupt pick payloads are ignored. */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  function discardAttachment() {
    const current = attachmentRef.current;
    if (!current) return;
    setAttachment(undefined);
    void window.moki.removeCapture(current.id).catch(() => {});
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (runtimeFailed || !writable || !body.trim() || lock.current || running || !conversationId || !validModel || !loaded || (!!attachment && !imageCapable)) return;
    lock.current = true; setBusy(true); setStarting(true); setError('');
    try {
      accept(await window.moki.chat({ conversationId, text: body, model, thinking, attachmentIds: attachment ? [attachment.id] : undefined, editOf: editingRef.current?.id }));
      // Editing keeps the untouched draft; a normal send clears it.
      if (!editingRef.current) setDrafts((current) => ({ ...current, [draftKey]: '' }));
      setAttachment(undefined);
      setEditing(undefined);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not send. Your draft is still here.'); }
    finally { lock.current = false; setBusy(false); setStarting(false); }
  }
  async function unsend(message: Message) {
    if (!conversationId) return;
    try {
      accept(await window.moki.request({ method: 'revertMessage', conversationId, messageId: message.id }));
      setEditing(undefined);
      setDrafts((current) => ({ ...current, [conversationId]: message.text }));
      setTimeout(() => composer.current?.focus(), 0);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not unsend the message.'); }
  }
  function startEditing(message: Message) {
    setEditing({ id: message.id, text: message.text });
    setTimeout(() => { const el = composer.current; if (!el) return; el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 0);
  }
  async function removeAttachment() {
    const current = attachmentRef.current;
    if (!current) return;
    try { await window.moki.removeCapture(current.id); setAttachment(undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove the screenshot.'); }
  }
  useEffect(() => {
    if (capturing) stopDictation(); // the screenshot capture owns the moment
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);
  function stopDictation() {
    dictationStoppedAt.current = Date.now();
    void window.moki.stopDictation().catch(() => {});
    setDictating(false);
  }
  function startDictation() {
    if (!writable || runtimeFailed || dictating) return;
    dictationBase.current = editing ? { editingId: editing.id, text: editing.text } : { editingId: '', text: draft };
    dictationStoppedAt.current = 0;
    void window.moki.startDictation().then(() => setDictating(true)).catch((e) => setError(e instanceof Error ? e.message : 'Dictation is unavailable.'));
  }
  // Partial and final transcripts both rewrite base + spoken, so the final
  // result replaces interim guesses instead of appending to them.
  function applyDictation(text: string) {
    const base = dictationBase.current;
    if (base.editingId) {
      const editing = editingRef.current;
      if (!editing || editing.id !== base.editingId) return; // target changed mid-dictation
      setEditing({ ...editing, text: (base.text ? base.text + ' ' : '') + text });
    } else {
      setDrafts((current) => ({ ...current, [draftKeyRef.current]: (base.text ? base.text + ' ' : '') + text }));
    }
  }
  async function stop() {
    stopDictation();
    if (!conversationId) return;
    void window.moki.stopSpeaking().catch(() => {});
    try { accept(await window.moki.request({ method: 'cancelChat', conversationId })); }
    catch (e) { setError(String(e)); }
  }
  async function newChat() {
    if (!assistant) return;
    const result = await perform({ method: 'createConversation', assistantId: assistant.id });
    if (result) { discardAttachment(); setConversationId(result.conversationId); }
  }
  return <main className={`flex h-full flex-col ${platformClass ?? ''}`}>
    {/* The Moki label remains draggable; only the action buttons opt out. */}
    <header className="titlebar flex min-h-12 items-center justify-end gap-1 pr-2.5 pb-2">
      <span className="px-2 text-[12.5px] font-medium text-ink-2">Moki</span>
      {contextModel && <ContextRing estimate={contextEstimate} contextWindow={contextModel.contextWindow} modelName={contextModel.name} />}
      <Button variant="ghost" size="icon-sm" aria-label={speakReplies ? 'Mute spoken replies' : 'Speak replies aloud'} title={speakReplies ? 'Mute spoken replies' : 'Speak replies aloud'} aria-pressed={speakReplies} disabled={runtimeFailed} onClick={() => {
        const next = !speakReplies;
        setSpeakReplies(next);
        try { localStorage.setItem('moki:speak-replies', next ? 'on' : 'off'); } catch { /* storage unavailable */ }
        if (!next) void window.moki.stopSpeaking().catch(() => {});
      }}>
        <span className={`relative inline-flex transition-opacity ${speakReplies ? '' : 'opacity-40'}`}>
          <Speaker />
          {speaking && <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />}
        </span>
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="New conversation" title="New conversation" disabled={busy || capturing || !assistant} onClick={() => void newChat()}><Plus /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="History" title="History" disabled={busy || capturing} onClick={() => void window.moki.openHistory().catch((e) => setError(String(e)))}><Clock /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="Settings" title="Settings" disabled={busy || capturing} onClick={() => void window.moki.openSettings().catch((e) => setError(String(e)))}><Gear /></Button>
    </header>
    {/* Presence zone: the avatar exists on its own, clear of the window-drag
        region and any nested controls, so it can later take click, hold, and
        drag interaction directly. */}
    <section className="flex shrink-0 justify-center px-4 pb-1" aria-label="Companion">
      {/* The SVG already reserves space for accessories and animated moods. */}
      <span className="avatar-stage block w-24">
        <ChatCompanion appearance={appearance} {...live} />
      </span>
    </section>
    <section ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" aria-label="Conversation" onScroll={(e) => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
      {earlier && <p className="mb-4 rounded-xl border border-line px-3 py-2 text-[12px] text-ink-2">Earlier conversation with {author?.name ?? 'a previous companion'}. Read-only. Start a new conversation to chat with Moki.</p>}
      {!messages.length && !earlier && <div className="mx-auto grid max-w-64 justify-items-center gap-3 pt-4 text-center">
        <p className="text-[15px] leading-snug font-semibold">What can Moki help with?</p>
        {!conversationId && <>
          <Button variant="primary" size="sm" disabled={busy || capturing || !assistant} onClick={() => void newChat()}>Start a conversation</Button>
          <p className="text-[12px] text-ink-3">Connect a provider in Settings, pick a model below, and chat.</p>
        </>}
      </div>}
      {messages.length >= 100 && <p className="pb-2 text-center text-[11px] text-ink-3">Showing the latest 100 messages. Older messages are still saved.</p>}
      <div className="grid gap-5">
        {messages.map((message) => message.role === 'assistant'
          ? <article key={message.id} className="flex gap-2.5">
            <span className="mt-0.5 w-5 shrink-0">{message.status === 'streaming' ? <ChatCompanion appearance={replyAppearance} messages={[message]} starting={false} failed={false} /> : <Companion appearance={replyAppearance} paused />}</span>
            <div className="grid min-w-0 flex-1 gap-1.5 self-start">
              {earlier && message.assistantName && <p className="text-[11px] text-ink-3">{message.assistantName}</p>}
              <ToolTrail message={message} />
              {message.text
                ? <Answer text={message.text} />
                : message.status === 'streaming' && <p className="text-[13.5px] text-ink-3">Thinking…</p>}
              {message.status === 'interrupted' && <p className="text-[11px] text-ink-3">stopped</p>}
              {message.error && <Banner>{message.error}</Banner>}
            </div>
          </article>
          : <div key={message.id} className="user-row flex items-center justify-end gap-1.5">
            {writable && <div className="user-actions flex shrink-0 gap-0.5">
              <Button variant="ghost" size="icon-sm" aria-label="Unsend message" title="Unsend: removes this message and later ones; its text returns to the composer" disabled={busy || capturing || running} onClick={() => void unsend(message)}><Undo /></Button>
              <Button variant="ghost" size="icon-sm" aria-label="Edit and resend" title="Edit this message; sending replaces it and later ones" disabled={busy || capturing || running} onClick={() => startEditing(message)}><Pencil /></Button>
            </div>}
            <div className="grid max-w-[85%] gap-2 rounded-2xl rounded-br-md border border-accent-line bg-accent-soft p-2">
              {messageAttachments(message.id).map((item) => <AttachmentImage key={item.id} attachment={item} />)}
              <p className="message-text px-1.5 text-[13.5px] leading-relaxed text-ink">{message.text}</p>
            </div>
          </div>)}
      </div>
    </section>
    {error && <div className="px-3 pb-2">
      <Banner action={error.includes('Screen Recording')
        ? <Button variant="secondary" size="sm" onClick={() => void window.moki.openScreenRecordingSettings()}>Open Settings</Button>
        : error.includes('Microphone access was denied')
        ? <Button variant="secondary" size="sm" onClick={() => void window.moki.openMicrophoneSettings()}>Open Settings</Button>
        : error.includes('Speech recognition was not allowed')
        ? <Button variant="secondary" size="sm" onClick={() => void window.moki.openSpeechRecognitionSettings()}>Open Settings</Button>
        : !data ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void perform({ method: 'snapshot' })}>Retry connection</Button> : undefined}>{error}</Banner>
    </div>}
    {/* Composer owns the session config: model and thinking are quiet chips
        next to send, set once and out of the way. */}
    <form className="mx-3 mb-3" onSubmit={send}>
      <div className="glass rounded-[1.4rem] p-1.5 shadow-[var(--shadow-glass)]" style={{ animation: 'rise-in .25s ease-out' }}>
        {attachment && <div className="px-2 pt-1.5 pb-1">
          <AttachmentImage attachment={attachment} removable onRemove={() => void removeAttachment()} />
          <p className="mt-1 text-[11px] text-ink-3">{attachment.width} × {attachment.height} · Screenshot</p>
          {!imageCapable && <p className="mt-1 text-[11.5px] text-danger">Select an image-capable model to send this screenshot.</p>}
        </div>}
        {editing && <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-0.5">
          <p className="min-w-0 truncate text-[11.5px] text-ink-2">Editing an earlier message. Sending replaces it and everything after it.</p>
          <Button variant="ghost" size="sm" onClick={() => setEditing(undefined)}>Cancel</Button>
        </div>}
        <label className="sr-only" htmlFor="message">Message</label>
        <textarea
          id="message"
          ref={composer}
          placeholder={editing ? 'Edit your message' : earlier ? 'Earlier conversation (read-only)' : conversationId ? 'Message Moki' : 'Start a conversation first'}
          rows={1}
          maxLength={16000}
          disabled={busy || !writable}
          value={body}
          onChange={(e) => editing ? setEditing((current) => current && { ...current, text: e.target.value }) : setDrafts({ ...drafts, [draftKey]: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && editing) { e.preventDefault(); setEditing(undefined); return; }
            // Enter sends; Shift+Enter inserts a newline; IME composition Enter is ignored.
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }}
          className="block max-h-40 w-full resize-none bg-transparent px-3 pt-2 pb-1 text-[13.5px] leading-relaxed text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-50" />
        <div className="flex items-center justify-between gap-2 px-1 pb-0.5">
          <div className="flex min-w-0 items-center gap-0.5">
            <Button variant="ghost" size="icon-sm" aria-label="Capture screen region" title="Capture screen region (⌘⇧8)" disabled={runtimeFailed || busy || capturing || dictating} onClick={() => void window.moki.startCapture().catch((cause) => setError(String(cause)))}><Capture /></Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={dictating ? 'Stop dictation' : 'Dictate a message'}
              title={dictating ? 'Stop dictation' : 'Hold to dictate; click to toggle'}
              aria-pressed={dictating}
              disabled={runtimeFailed || busy || capturing || !writable}
              onPointerDown={(event) => { event.preventDefault(); startDictation(); }}
              onPointerUp={() => { if (dictating) stopDictation(); }}
              onPointerLeave={() => { if (dictating) stopDictation(); }}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (dictating) stopDictation(); else startDictation(); } }}
            >
              <span className={`relative inline-flex transition-opacity ${dictating ? '' : 'opacity-70'}`}>
                <Mic />
                {dictating && <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />}
              </span>
            </Button>
            {conversationId && writable && <>
              <SimpleSelect
                compact
                aria-label="Model"
                value={validModel ? model : ''}
                placeholder="Select model"
                disabled={busy || capturing || running}
                onValueChange={(id) => void perform({ method: 'selectModel', conversationId: conversationId!, model: id })}
                options={models.map((item) => ({ value: item.id, label: item.name }))} />
              {validModel && levels.length > 0 && <SimpleSelect
                compact
                aria-label="Thinking level"
                value={thinking ?? AUTO_THINKING}
                disabled={busy || capturing || running}
                onValueChange={(value) => void perform({ method: 'selectModel', conversationId: conversationId!, model, thinking: (value === AUTO_THINKING ? null : value) as Thinking | null })}
                options={[{ value: AUTO_THINKING, label: <span className="flex items-center gap-1"><Zap />Auto</span> }, ...levels.map((level) => ({ value: level, label: level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1) }))]} />}
            </>}
          </div>
          {running || starting
            ? <Button variant="secondary" size="round" aria-label="Stop" title="Stop" onClick={() => void stop()}><Stop /></Button>
            : <Button variant="primary" size="round" aria-label="Send message" title="Send" disabled={runtimeFailed || busy || capturing || !writable || !body.trim() || !loaded || !validModel || (!!attachment && !imageCapable)} type="submit"><ArrowUp /></Button>}
        </div>
      </div>
    </form>
  </main>;
}
