import { useEffect, useRef, useState } from 'react';
import type { Result } from '@shared/protocol';
import type { MemoryConnectionsPage, MemoryDetail, MemoryPage, MemorySettingsState, MemorySummary } from '@shared/memory';
import { Button } from '@renderer/components/ui/button';
import { Field, Input, Textarea } from '@renderer/components/ui/field';
import { Panel } from '@renderer/components/ui/panel';
import { acceptMemoryRevision, MEMORY_FORGET_SCOPE_COPY } from '@renderer/lib/memory-settings-state';
import { onMemoriesChanged } from './memory-refresh';
import { dateLabel, errorMessage } from './format';

const PAGE_SIZE = 20;
const TEXT_PAGE_SIZE = 4000;

function memoryStateLabel(memory: MemorySummary): string {
  const flags = [memory.pinned ? 'Pinned' : '', memory.core ? 'Core' : '', memory.state !== 'active' ? memory.state : ''].filter(Boolean);
  return flags.join(' · ') || memory.kind;
}

/** Master-detail browser for saved memories. The list scrolls inside a bounded area so the page height stays stable. */
export function MemoriesBrowser() {
  const [page, setPage] = useState<MemoryPage>({ query: null, memories: [], offset: 0, nextOffset: null });
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<MemoryDetail>();
  const [connections, setConnections] = useState<MemoryConnectionsPage>();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [draftStale, setDraftStale] = useState(false);
  const [error, setError] = useState('');
  const memoryRevision = useRef(0);
  const loadedRevision = useRef(0);
  const requestSequence = useRef(0);
  const selectedSequence = useRef(0);
  const queryRef = useRef(query);
  const selectedIdRef = useRef(selectedId);
  const dirtyDraft = useRef(false);
  queryRef.current = query;
  selectedIdRef.current = selectedId;

  function acceptSettings(next: MemorySettingsState): boolean {
    const decision = acceptMemoryRevision(memoryRevision.current, next.revision);
    if (!decision.accepted) return false;
    memoryRevision.current = decision.revision;
    return decision.refresh;
  }

  async function loadPage(nextQuery = query, offset = 0, append = false) {
    const sequence = ++requestSequence.current;
    setListBusy(true);
    try {
      const result = await window.moki.request({
        method: 'memoryList',
        ...(nextQuery.trim() ? { query: nextQuery.trim() } : {}),
        limit: PAGE_SIZE,
        offset,
      });
      if (sequence !== requestSequence.current || !result.memoryPage) return;
      if (result.memory) acceptSettings(result.memory);
      loadedRevision.current = Math.max(loadedRevision.current, result.memory?.revision ?? 0);
      setPage((current) => append ? { ...result.memoryPage!, memories: [...current.memories, ...result.memoryPage!.memories] } : result.memoryPage!);
      setError('');
    } catch (failure) {
      if (sequence === requestSequence.current) setError(errorMessage(failure));
    } finally {
      if (sequence === requestSequence.current) setListBusy(false);
    }
  }

  async function loadSelected(id: string, expectedRevision?: number) {
    const sequence = ++selectedSequence.current;
    setDetailBusy(true);
    setDetail(undefined);
    setConnections(undefined);
    try {
      const [detailResult, connectionResult] = await Promise.all([
        window.moki.request({ method: 'memoryRead', memoryId: id, ...(expectedRevision === undefined ? {} : { expectedRevision }), textLimit: TEXT_PAGE_SIZE }),
        window.moki.request({ method: 'memoryConnections', memoryId: id, limit: 25, offset: 0 }),
      ]);
      const nextDetail = detailResult.memoryDetail;
      const nextConnections = connectionResult.memoryConnections;
      if (sequence !== selectedSequence.current || !nextDetail || !nextConnections) return;
      if (detailResult.memory) acceptSettings(detailResult.memory);
      setDetail(nextDetail);
      setDraft(nextDetail.textPage);
      dirtyDraft.current = false;
      setDraftStale(false);
      setConnections(nextConnections);
      setError('');
    } catch (failure) {
      if (sequence === selectedSequence.current) setError(errorMessage(failure));
    } finally {
      if (sequence === selectedSequence.current) setDetailBusy(false);
    }
  }

  function refreshAfterExternalChange() {
    void loadPage(queryRef.current, 0, false);
    if (!selectedIdRef.current) return;
    if (dirtyDraft.current) setDraftStale(true);
    else void loadSelected(selectedIdRef.current);
  }

  async function updateMemory(patch: { text?: string; pinned?: boolean }) {
    if (!detail || busy || detailBusy || (patch.text !== undefined && (detail.textNextOffset !== null || draftStale))) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.moki.request({ method: 'memoryUpdate', memoryId: detail.id, expectedRevision: detail.revision, ...patch });
      if (result.memory) acceptSettings(result.memory);
      await loadSelected(detail.id);
      loadedRevision.current = 0;
      await loadPage(query, page.offset, false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function forgetMemory() {
    if (!detail || busy) return;
    const confirmed = window.confirm(`Forget this memory? ${MEMORY_FORGET_SCOPE_COPY}`);
    if (!confirmed) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.moki.request({ method: 'memoryForget', memoryId: detail.id, expectedRevision: detail.revision });
      if (result.memory) acceptSettings(result.memory);
      setSelectedId(undefined);
      setDetail(undefined);
      setConnections(undefined);
      loadedRevision.current = 0;
      await loadPage(query, 0, false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreText() {
    if (!detail?.textNextOffset || busy) return;
    setBusy(true);
    try {
      const result = await window.moki.request({ method: 'memoryRead', memoryId: detail.id, expectedRevision: detail.revision, offset: detail.textNextOffset, textLimit: TEXT_PAGE_SIZE });
      const nextDetail = result.memoryDetail;
      if (!nextDetail) return;
      setDetail((current) => current ? { ...current, textPage: current.textPage + nextDetail.textPage, textNextOffset: nextDetail.textNextOffset } : current);
      setDraft((current) => current + nextDetail.textPage);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    const unsubscribe = window.moki.onState((result: Result) => {
      if (!active || !result.memory || !acceptSettings(result.memory)) return;
      if (result.memory.revision > loadedRevision.current) {
        loadedRevision.current = result.memory.revision;
        refreshAfterExternalChange();
      }
    });
    const unsubscribeMemories = onMemoriesChanged(() => {
      if (!active) return;
      loadedRevision.current = 0;
      refreshAfterExternalChange();
    });
    void window.moki.request({ method: 'memorySettings' }).then((result) => {
      if (!active) return;
      if (result.memory) acceptSettings(result.memory);
      void loadPage('', 0, false);
    }, (failure) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; ++requestSequence.current; ++selectedSequence.current; unsubscribe(); unsubscribeMemories(); };
  }, []);

  return <Panel className="grid gap-3">
    <div className="flex items-center justify-between gap-2">
      <div><h3 className="text-[13.5px] font-semibold">Saved memories</h3><p className="text-[12px] text-ink-3">Inspect and manage records whether recall is enabled or disabled.</p></div>
      {detail && <Button size="sm" onClick={() => { setSelectedId(undefined); setDetail(undefined); setConnections(undefined); }}>Back to list</Button>}
    </div>
    {!detail && <>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setQuery(queryInput.trim()); void loadPage(queryInput.trim(), 0, false); }}>
        <Input aria-label="Search memories" placeholder="Search saved text" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} />
        <Button type="submit" variant="primary" disabled={listBusy}>Search</Button>
      </form>
      <div className="grid max-h-96 gap-2 overflow-y-auto pr-1">
        {page.memories.length === 0 && !listBusy && <p className="rounded-lg bg-surface-2 px-3 py-4 text-[13px] text-ink-3">No saved memories.</p>}
        {page.memories.map((memory) => <button key={memory.id} type="button" className="grid gap-1 rounded-xl border border-line bg-surface-2 p-3 text-left transition-colors hover:border-line-strong" onClick={() => { setSelectedId(memory.id); void loadSelected(memory.id, memory.revision); }}>
          <span className="flex items-center justify-between gap-2 text-[12px] text-ink-3"><span>{memoryStateLabel(memory)}</span><span>Revision {memory.revision}</span></span>
          <span className="text-[13px] text-ink">{memory.text}{memory.textTruncated ? '…' : ''}</span>
          <span className="text-[11px] text-ink-3">Recorded {dateLabel(memory.recordedAt)}</span>
        </button>)}
      </div>
      {listBusy && page.memories.length > 0 && <p role="status" className="text-[12px] text-ink-3">Loading…</p>}
      {page.nextOffset !== null && <Button disabled={listBusy} onClick={() => void loadPage(query, page.nextOffset!, true)}>{listBusy ? 'Loading…' : 'Load more'}</Button>}
    </>}

    {detail && <div className="grid gap-4">
      <div className="flex items-start justify-between gap-2">
        <div><h3 className="text-[14px] font-semibold">Memory detail</h3><p className="text-[11px] text-ink-3">Revision {detail.revision}, {memoryStateLabel(detail)}</p></div>
        <Button variant="danger" size="sm" disabled={busy} onClick={() => void forgetMemory()}>Forget</Button>
      </div>
      <p aria-label="Memory forgetting scope" className="text-[11px] text-ink-3">{MEMORY_FORGET_SCOPE_COPY}</p>
      {draftStale && <p role="status">Memory changed while you were editing. Your draft is preserved. <Button size="sm" onClick={() => { if (window.confirm('Discard your draft and reload?')) void loadSelected(detail.id); }}>Reload saved version</Button></p>}
      {detail.textNextOffset !== null && <p role="status">Load the remaining text before editing or saving this memory.</p>}
      <Field label="Text" htmlFor="memory-text" hint="Settings edits are attributed to this user action and do not create conversation evidence.">
        <Textarea id="memory-text" rows={7} value={draft} disabled={busy || detailBusy || detail.textNextOffset !== null} onChange={(event) => { dirtyDraft.current = true; setDraft(event.target.value); }} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || detailBusy || draftStale || detail.textNextOffset !== null || !draft.trim() || draft.trim() === detail.textPage} onClick={() => void updateMemory({ text: draft })}>Save text</Button>
        <Button disabled={busy || draftStale || draft !== detail.textPage} onClick={() => void updateMemory({ pinned: !detail.pinned })}>{detail.pinned ? 'Unpin' : 'Pin'}</Button>
        {detail.textNextOffset !== null && <Button disabled={busy} onClick={() => void loadMoreText()}>Load more text</Button>}
      </div>
      <dl className="grid gap-1 rounded-lg bg-surface-2 p-3 text-[12px]">
        <div><dt className="inline font-medium text-ink-2">Kind: </dt><dd className="inline">{detail.kind}</dd></div>
        <div><dt className="inline font-medium text-ink-2">Recorded: </dt><dd className="inline">{dateLabel(detail.recordedAt)}</dd></div>
        <div><dt className="inline font-medium text-ink-2">Valid from: </dt><dd className="inline">{dateLabel(detail.validFrom)}</dd></div>
        <div><dt className="inline font-medium text-ink-2">Valid until: </dt><dd className="inline">{dateLabel(detail.validUntil)}</dd></div>
      </dl>
      <div className="grid gap-2">
        <h3 className="text-[13px] font-semibold">Evidence</h3>
        {detail.evidence.length === 0 && <p className="text-[12px] text-ink-3">No evidence attached.</p>}
        {detail.evidence.length > 0 && <div className="grid max-h-44 gap-2 overflow-y-auto pr-1">
          {detail.evidence.map((item) => <div key={item.id} className="rounded-lg border border-line p-2 text-[11px]">
            <div className="flex justify-between gap-2"><span>{item.valid ? item.stance : `Invalid: ${item.invalidReason ?? 'stale evidence'}`}</span><span>{dateLabel(item.recordedAt)}</span></div>
            <p className="mt-1 text-ink-3">{item.sourceRole} source {item.sourceMessageId}, revision {item.sourceRevision}, source date {dateLabel(item.sourceCreatedAt)}. {item.provenance}</p>
          </div>)}
        </div>}
        {detail.evidenceTruncated && <p className="text-[12px] text-ink-3">Evidence list is capped at 50 records.</p>}
      </div>
      <div className="grid gap-2">
        <h3 className="text-[13px] font-semibold">Connections</h3>
        {connections?.connections.length === 0 && <p className="text-[12px] text-ink-3">No stored connections.</p>}
        {connections && connections.connections.length > 0 && <div className="grid max-h-44 gap-2 overflow-y-auto pr-1">
          {connections.connections.map((item) => <div key={item.id} className="rounded-lg border border-line p-2 text-[11px]">
            <div className="flex justify-between gap-2"><span>{item.kind}{item.explicit ? ' · explicit' : ' · inferred'}</span><span>{item.valid ? 'Current source' : `Invalid: ${item.invalidReason ?? 'stale'}`}</span></div>
            <p className="mt-1 text-ink-3">{item.subjectId} to {item.objectId}. {item.provenance}</p>
          </div>)}
        </div>}
      </div>
    </div>}
    {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
  </Panel>;
}
