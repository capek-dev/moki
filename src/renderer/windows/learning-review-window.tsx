import { useEffect, useRef, useState } from 'react';
import type { LearningRunDetail } from '@shared/protocol';
import { platformClass } from '@renderer/lib/platform';

export function LearningReviewWindow() {
  const [detail, setDetail] = useState<LearningRunDetail>();
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const scroller = useRef<HTMLElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    let streamRevision = 0;
    const load = async () => {
      const request = ++sequence;
      const revision = streamRevision;
      try {
        const result = await window.moki.readLearningReview();
        if (!active || request !== sequence) return;
        setDetail(result.detail);
        if (revision === streamRevision) setOutput(result.output?.text ?? '');
        setError('');
      } catch (failure) {
        if (active && request === sequence) setError(failure instanceof Error ? failure.message : 'Review unavailable.');
      }
    };
    const stop = window.moki.onLearningReview(event => {
      if (event.output) { streamRevision++; setOutput(event.output.text); }
      if (event.refresh) void load();
    });
    const stopErrors = window.moki.onRuntimeError(message => { if (active) setError(message); });
    void load();
    return () => { active = false; stop(); stopErrors(); };
  }, []);
  useEffect(() => {
    if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [output]);
  return <main className={`flex h-full flex-col ${platformClass ?? ''}`}>
    <header className="titlebar flex min-h-12 items-end pb-2"><h1 className="text-[13px] font-semibold">Learning review · Read only</h1></header>
    <div className="border-b border-line px-4 py-3 text-[13px]">
      <strong>{detail ? `${detail.run.status} · Attempt ${detail.run.attempt}` : 'Loading review…'}</strong>
      {detail && <p className="text-ink-3">{detail.run.provider} · {detail.run.model}</p>}
      {detail?.run.error && <p role="alert" className="text-danger">{detail.run.error}</p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>
    <section ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-4" onScroll={() => { const el = scroller.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <p className="mb-4 text-[12px] text-ink-3">Source excerpts are current text, not a saved copy of the original prompt. Live output is temporary, limited to 64,000 characters, and cleared when Moki restarts or a memory is forgotten.</p>
      {detail?.sources.map(source => <article key={source.messageId} className={`mb-3 max-w-[92%] rounded-xl border border-line bg-surface-2 p-3 ${source.role === 'user' ? 'ml-auto' : ''}`}>
        <h2 className="text-[12px] font-semibold">{source.role} source · {source.state}</h2>
        <p className="whitespace-pre-wrap break-words text-[13px]">{source.currentText ?? 'Source no longer available.'}</p>
      </article>)}
      <article className="mr-auto max-w-[96%] rounded-xl border border-line bg-surface-1 p-3">
        <h2 className="mb-2 text-[13px] font-semibold">Reviewer output</h2>
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">{output || (detail?.run.status === 'running' ? 'Waiting for reviewer output…' : 'Live output is not available for this run. Saved proposals are shown below.')}</pre>
      </article>
      {!!detail?.proposals.length && <details className="mt-4"><summary className="text-[13px] font-semibold">Saved proposals ({detail.proposals.length})</summary>{detail.proposals.map(item => <pre key={item.proposalId} className="my-2 whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 text-[12px]">{JSON.stringify(item, null, 2)}</pre>)}</details>}
      {detail?.truncated && <p className="mt-3 text-[12px] text-ink-3">Inspection is bounded; some records are omitted.</p>}
    </section>
    <footer className="border-t border-line p-3 text-center text-[12px] text-ink-3">Observation only. Closing this window does not stop learning.</footer>
  </main>;
}
