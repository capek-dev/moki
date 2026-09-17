import { useEffect, useRef, useState } from 'react';
import type { Result, Snapshot } from '@shared/protocol';
import { Companion, INITIAL_APPEARANCE } from '@renderer/components/companion/companion';
import { useTone } from '@renderer/lib/tone';
import { platformClass } from '@renderer/lib/platform';
import { canChatWithMoki, mokiAssistant } from '@renderer/lib/moki';

// Sessions live in their own window: picking one tells the chat window through
// the storage event (same cross-window channel the tone uses), then closes.

const OPEN_KEY = 'moki:open-conversation';

export function History() {
  const [data, setData] = useState<Snapshot>();
  const revision = useRef(0);
  useTone();
  function accept(result: Result) {
    if ((result.revision ?? 0) < revision.current) return;
    revision.current = result.revision ?? 0;
    setData(result.snapshot);
  }
  useEffect(() => {
    const unsubscribe = window.moki.onState(accept);
    void window.moki.request({ method: 'snapshot' }).then(accept).catch(() => {});
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') window.close(); };
    window.addEventListener('keydown', onKey);
    return () => { unsubscribe(); window.removeEventListener('keydown', onKey); };
  }, []);
  function pick(id: string) {
    // The nonce keeps repeat picks of the same session firing the storage event.
    try { localStorage.setItem(OPEN_KEY, JSON.stringify({ id, at: Date.now() })); } catch { /* Session-only mode: the chat window keeps its current selection. */ }
    window.close();
  }
  const conversations = data?.conversations ?? [];
  const moki = mokiAssistant(data?.assistants);
  return <main className={`flex h-full flex-col ${platformClass ?? ''}`}>
    <header className="titlebar flex min-h-12 items-end pb-2">
      <h1 className="pl-1 text-[13px] font-semibold tracking-[.02em] text-ink">History</h1>
    </header>
    <section className="min-h-0 flex-1 overflow-y-auto px-3 pb-4" aria-label="Conversations">
      {conversations.map((conversation) => {
        const assistant = data?.assistants.find((item) => item.id === conversation.assistantId);
        return <button
          key={conversation.id}
          type="button"
          onClick={() => pick(conversation.id)}
          className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-hover">
          <span className="w-8 shrink-0"><Companion appearance={assistant?.appearance ?? INITIAL_APPEARANCE} paused /></span>
          <span className="grid min-w-0 flex-1">
            <span className="truncate text-[13px] font-medium text-ink">{conversation.title}</span>
            <span className="text-[11.5px] text-ink-3">{canChatWithMoki(moki, conversation) ? 'Moki' : `Earlier conversation · ${assistant?.name ?? 'Previous companion'} · Read-only`}</span>
          </span>
        </button>;
      })}
      {data && !conversations.length && <p className="px-2 pt-6 text-center text-[13px] text-ink-3">No conversations yet. Start one from the chat window.</p>}
      {!data && <p className="px-2 pt-6 text-center text-[13px] text-ink-3">Loading…</p>}
    </section>
  </main>;
}
