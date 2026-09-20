import { useEffect, useRef, useState } from 'react';
import type { Result } from '@shared/protocol';
import type { MemoryConnectionsPage, MemoryDetail, MemoryPage, MemoryRecallHistoryPage, MemorySettingsState, MemorySummary } from '@shared/memory';
import type { LearningHistoryRecord, LearningRunDetail, LearningRunPage, LearningSettingsState } from '@shared/protocol';
import { MODELS } from '@shared/models';
import { Button } from '@renderer/components/ui/button';
import { Field, Input, Textarea } from '@renderer/components/ui/field';
import { Panel } from '@renderer/components/ui/panel';
import { acceptMemoryRevision, memoryRecallLabel, MEMORY_DISABLED_COPY, MEMORY_FORGET_SCOPE_COPY } from '@renderer/lib/memory-settings-state';

const PAGE_SIZE = 20;
const TEXT_PAGE_SIZE = 4000;

function dateLabel(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Date unknown' : new Date(value).toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Memory request failed.';
}

function memoryStateLabel(memory: MemorySummary): string {
  const flags = [memory.pinned ? 'Pinned' : '', memory.core ? 'Core' : '', memory.state !== 'active' ? memory.state : ''].filter(Boolean);
  return flags.join(' · ') || memory.kind;
}

export function MemorySettings() {
  const [settings, setSettings] = useState<MemorySettingsState>();
  const [learning, setLearning] = useState<LearningSettingsState>();
  const [learningHistory, setLearningHistory] = useState<LearningHistoryRecord[]>([]);
  const [learningRuns, setLearningRuns] = useState<LearningRunPage>({ runs: [], offset: 0, nextOffset: null });
  const [learningRunDetail, setLearningRunDetail] = useState<LearningRunDetail>();
  const [learningExclusions, setLearningExclusions] = useState<string[]>([]);
  const [conversations, setConversations] = useState<{ id: string; title: string }[]>([]);
  const [page, setPage] = useState<MemoryPage>({ query: null, memories: [], offset: 0, nextOffset: null });
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<MemoryDetail>();
  const [connections, setConnections] = useState<MemoryConnectionsPage>();
  const [recallHistory, setRecallHistory] = useState<MemoryRecallHistoryPage>({ records: [], offset: 0, nextOffset: null });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [error, setError] = useState('');
  const memoryRevision = useRef(0);
  const learningRevision = useRef(0);
  const loadedRevision = useRef(0);
  const requestSequence = useRef(0);
  const selectedSequence = useRef(0);
  const queryRef = useRef(query);
  const selectedIdRef = useRef(selectedId);
  const learningRunsSequence = useRef(0);
  const learningDetailSequence = useRef(0);
  const dirtyDraft = useRef(false);
  const [draftStale, setDraftStale] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  queryRef.current = query;
  selectedIdRef.current = selectedId;

  function acceptSettings(next: MemorySettingsState) {
    const decision = acceptMemoryRevision(memoryRevision.current, next.revision);
    if (!decision.accepted) return false;
    memoryRevision.current = decision.revision;
    setSettings(next);
    return true;
  }

  function acceptLearning(next: LearningSettingsState, exclusions?: string[]) {
    if (next.revision < learningRevision.current) return false;
    learningRevision.current = next.revision;
    setLearning(next);
    if (exclusions) setLearningExclusions(exclusions);
    return true;
  }

  async function loadLearningHistory() {
    try {
      const result = await window.moki.request({ method: 'learningHistory', limit: 50, offset: 0 });
      if (result.learning) acceptLearning(result.learning, result.learningExclusions);
      setLearningHistory(result.learningHistory ?? []);
    } catch (error) { setError(errorMessage(error)); }
  }

  async function loadLearningRuns(offset = 0, append = false) {
    const sequence = ++learningRunsSequence.current;
    setRunsLoading(true);
    try {
      const result = await window.moki.request({ method: 'learningRuns', limit: 25, offset });
      if (sequence !== learningRunsSequence.current || !result.learningRuns) return;
      if (result.learning) acceptLearning(result.learning);
      setLearningRuns((current) => append ? { ...result.learningRuns!, runs: [...current.runs, ...result.learningRuns!.runs] } : result.learningRuns!);
    } catch (error) { if (sequence === learningRunsSequence.current) setError(errorMessage(error)); }
    finally { if (sequence === learningRunsSequence.current) setRunsLoading(false); }
  }

  async function loadLearningRunDetail(runId: string) {
    const sequence = ++learningDetailSequence.current;
    setRunDetailLoading(true);
    setLearningRunDetail(undefined);
    try {
      const result = await window.moki.request({ method: 'learningRunDetail', runId, limit: 50 });
      if (sequence === learningDetailSequence.current) setLearningRunDetail(result.learningRunDetail);
    } catch (error) { if (sequence === learningDetailSequence.current) setError(errorMessage(error)); }
    finally { if (sequence === learningDetailSequence.current) setRunDetailLoading(false); }
  }

  async function retryLearningRun(runId: string) {
    if (busy) return;
    setBusy(true);
    try { await window.moki.request({ method: 'learningRetry', runId }); await loadLearningRuns(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function cancelLearningRun(runId: string) {
    if (busy) return;
    setBusy(true);
    try { await window.moki.request({ method: 'learningCancel', runId }); await loadLearningRuns(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
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
    } catch (error) {
      if (sequence === requestSequence.current) setError(errorMessage(error));
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
    } catch (error) {
      if (sequence === selectedSequence.current) setError(errorMessage(error));
    } finally {
      if (sequence === selectedSequence.current) setDetailBusy(false);
    }
  }

  async function setLearningEnabled(enabled: boolean) {
    if (!learning || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.moki.request({ method: 'learningSetEnabled', enabled, expectedRevision: learning.revision });
      if (result.learning) acceptLearning(result.learning, result.learningExclusions);
      await loadLearningHistory();
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function setLearningProviderModel(provider: 'deepseek' | 'codex', model: string) {
    if (!learning || busy) return;
    setBusy(true);
    try {
      const result = await window.moki.request({ method: 'learningSetProviderModel', provider, model, expectedRevision: learning.revision });
      if (result.learning) acceptLearning(result.learning, result.learningExclusions);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function setLearningPaused(paused: boolean) {
    if (!learning || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.moki.request({ method: 'learningSetPaused', paused, expectedRevision: learning.revision });
      if (result.learning) acceptLearning(result.learning, result.learningExclusions);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function setConversationExcluded(conversationId: string, excluded: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.moki.request({ method: 'learningExcludeConversation', conversationId, excluded });
      if (result.learning) acceptLearning(result.learning, result.learningExclusions);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function undoLearning(item: LearningHistoryRecord) {
    if (busy || item.undoneAt !== null) return;
    setBusy(true);
    try {
      const result = await window.moki.request({ method: 'learningUndo', historyId: item.id, expectedRevision: item.afterRevision });
      if (result.learning) acceptLearning(result.learning, result.learningExclusions);
      await loadLearningHistory();
      await loadPage(query, 0, false);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function setPolicy(recall: 'basic' | 'jev', jevConsent: boolean, jevModel: string) {
    if (!settings || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.moki.request({ method: 'memorySetPolicy', recall, jevConsent, jevModel, expectedRevision: settings.revision });
      if (result.memory) acceptSettings(result.memory);
      const history = await window.moki.request({ method: 'memoryRecallHistory', limit: 25, offset: 0 });
      if (history.memoryRecallHistory) setRecallHistory(history.memoryRecallHistory);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function setEnabled(enabled: boolean) {
    if (!settings || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.moki.request({ method: 'memorySetEnabled', enabled, expectedRevision: settings.revision });
      if (result.memory) acceptSettings(result.memory);
      loadedRevision.current = 0;
      await loadPage(query, 0, false);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
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
    } catch (error) {
      setError(errorMessage(error));
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
    } catch (error) {
      setError(errorMessage(error));
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
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    const unsubscribe = window.moki.onState((result: Result) => {
      if (!active) return;
       if (result.learning) {
         const changed = acceptLearning(result.learning, result.learningExclusions);
          if (changed) { void loadLearningHistory(); void loadLearningRuns(); }
       }
       if (result.memoryRecall) void window.moki.request({ method: 'memoryRecallHistory', limit: 25, offset: 0 }).then((next) => { if (active && next.memoryRecallHistory) setRecallHistory(next.memoryRecallHistory); });
       if (!result.memory || !acceptSettings(result.memory)) return;
      if (result.memory.revision > loadedRevision.current) {
        loadedRevision.current = result.memory.revision;
        void loadPage(queryRef.current, 0, false);
        if (selectedIdRef.current) {
          if (dirtyDraft.current) setDraftStale(true);
          else void loadSelected(selectedIdRef.current);
        }
      }
    });
    void window.moki.request({ method: 'memorySettings' }).then((result) => {
      if (!active) return;
      if (result.memory) acceptSettings(result.memory);
      void loadPage('', 0, false);
    }, (error) => { if (active) setError(errorMessage(error)); });
    void window.moki.request({ method: 'learningSettings' }).then((result) => { if (active && result.learning) acceptLearning(result.learning, result.learningExclusions); }, (error) => { if (active) setError(errorMessage(error)); });
     void loadLearningHistory();
     void loadLearningRuns();
    void window.moki.request({ method: 'memoryRecallHistory', limit: 25, offset: 0 }).then((result) => { if (active && result.memoryRecallHistory) setRecallHistory(result.memoryRecallHistory); }, (error) => { if (active) setError(errorMessage(error)); });
    void window.moki.request({ method: 'snapshot' }).then((result) => { if (active) setConversations(result.snapshot.conversations.map((item) => ({ id: item.id, title: item.title }))); }, (error) => { if (active) setError(errorMessage(error)); });
    return () => { active = false; ++requestSequence.current; ++selectedSequence.current; ++learningRunsSequence.current; ++learningDetailSequence.current; unsubscribe(); };
  }, []);

  const enabled = settings?.enabled === true;
  return <div className="grid gap-3">
    <Panel className="grid gap-2" aria-label="Memory status">
      <strong>Memory: {!settings ? 'Loading…' : enabled ? 'On' : 'Off'}</strong>
      <strong>Learning: {!learning || !settings ? 'Loading…' : !learning.enabled ? 'Off' : !enabled ? 'Blocked: enable memory' : learning.paused ? 'Paused' : 'Enabled'}</strong>
      <p className="text-[12px] text-ink-3">{busy ? 'Saving change…' : 'Status reflects saved settings. Provider availability is checked when a review starts.'}</p>
      {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
    </Panel>
    <Panel className="flex flex-col gap-3">
      <div>
        <h2 className="text-[15px] font-semibold">Automatic learning</h2>
        <p className="mt-1 text-[12.5px] text-ink-2">Learning is off until you opt in. When enabled, Moki reviews only new completed messages after activation, waits for idle time, and sends bounded excerpts to the configured provider. It never receives desktop, network, or app-action tools.</p>
        <p className="mt-1 text-[12px] text-ink-3">The provider receives user and assistant excerpts. Only user statements may support learned facts; assistant text is context, not evidence. Source IDs, revisions, exclusions, forgotten evidence, and later edits are checked again before anything is saved. Credentials stay in Electron secure storage and are not persisted in this database or exposed to the renderer.</p>
      </div>
      <label className="flex items-start gap-2 text-[13px]"><input aria-label="Enable automatic learning" type="checkbox" checked={learning?.enabled === true} disabled={!learning || busy} onChange={(event) => void setLearningEnabled(event.target.checked)} /><span><strong>Enable automatic learning</strong><br /><span className="text-[12px] text-ink-3">New activity only. Enabling does not backfill old conversations.</span></span></label>
      {learning?.enabled && <>
        <label className="flex items-start gap-2 text-[13px]"><input aria-label="Pause automatic learning" type="checkbox" checked={learning.paused} disabled={busy} onChange={(event) => void setLearningPaused(event.target.checked)} /><span><strong>Pause learning</strong><br /><span className="text-[12px] text-ink-3">Pending reviews are cancelled before commit.</span></span></label>
        <div className="grid gap-2 sm:grid-cols-2"><label className="grid gap-1 text-[12px]">Provider<select aria-label="Learning provider" className="rounded-lg border border-line bg-surface-1 px-2 py-1.5" value={learning.provider} disabled={busy} onChange={(event) => { const provider = event.target.value as 'deepseek' | 'codex'; const first = MODELS.find((model) => model.provider === provider); if (first) void setLearningProviderModel(provider, first.id); }}><option value="deepseek">DeepSeek</option><option value="codex">Codex</option></select></label><label className="grid gap-1 text-[12px]">Model<select aria-label="Learning model" className="rounded-lg border border-line bg-surface-1 px-2 py-1.5" value={learning.model} disabled={busy} onChange={(event) => void setLearningProviderModel(learning.provider, event.target.value)}>{MODELS.filter((model) => model.provider === learning.provider).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label></div>
      </>}
      {conversations.length > 0 && <div className="grid gap-1"><h3 className="text-[13px] font-semibold">Exclude conversations</h3>{conversations.slice(0, 50).map((conversation) => <label key={conversation.id} className="flex items-center gap-2 text-[12px]"><input type="checkbox" aria-label={`Exclude ${conversation.title}`} checked={learningExclusions.includes(conversation.id)} disabled={busy} onChange={(event) => void setConversationExcluded(conversation.id, event.target.checked)} /><span>{conversation.title}</span></label>)}</div>}
       {learningHistory.length > 0 && <div className="grid gap-2"><h3 className="text-[13px] font-semibold">Learning history</h3>{learningHistory.map((item) => <div key={item.id} className="flex items-center justify-between gap-2 rounded-lg border border-line p-2 text-[11px]"><span>{item.action} · {item.resourceType} {item.resourceId} · revision {item.afterRevision}{item.undoneAt !== null ? ' · undone' : ''}</span><Button size="sm" disabled={busy || item.undoneAt !== null} onClick={() => void undoLearning(item)}>Undo</Button></div>)}</div>}
       {<div className="order-first grid gap-2"><h3 className="text-[15px] font-semibold">Learning runs</h3><p className="text-[12px] text-ink-3">Inspect reviews here, including failures and reviews that saved nothing.</p>{learningRuns.runs.length === 0 && <p className="text-[12px]">{runsLoading ? 'Loading learning runs…' : 'No learning runs yet.'}</p>}{runDetailLoading && <p role="status">Loading run details…</p>}{learningRuns.runs.map((run) => <div key={run.id} className="grid gap-2 rounded-lg border border-line p-2 text-[11px]"><button type="button" className="text-left" onClick={() => void loadLearningRunDetail(run.id)}><span className="font-semibold text-accent">Inspect run</span><div className="flex justify-between gap-2"><strong>{run.outcome === 'no_changes' ? 'No changes' : run.status}</strong><span>Attempt {run.attempt}</span></div><div className="text-ink-3">{run.provider} · {run.model} · {dateLabel(run.createdAt)} · {run.appliedCount} applied, {run.rejectedCount} rejected</div>{run.error && <div className="text-danger">Last error: {run.error}</div>}</button><div className="flex gap-2"><Button size="sm" onClick={() => void window.moki.openLearningReview(run.id).catch(failure => setError(errorMessage(failure)))}>Open review</Button>{(run.status === 'failed' || run.status === 'cancelled') && <Button size="sm" disabled={busy} onClick={() => void retryLearningRun(run.id)}>{run.sourceManifest === 'unavailable' ? 'Review current sources' : 'Retry'}</Button>}{(run.status === 'pending' || run.status === 'running') && <Button size="sm" disabled={busy} onClick={() => void cancelLearningRun(run.id)}>Cancel</Button>}</div></div>)}{learningRuns.nextOffset !== null && <Button size="sm" disabled={busy} onClick={() => void loadLearningRuns(learningRuns.nextOffset!, true)}>More runs</Button>}</div>}
       {learningRunDetail && <div className="order-first grid gap-2 rounded-lg border border-line bg-surface-2 p-2 text-[11px]"><div className="flex items-center justify-between gap-2"><h3 className="text-[13px] font-semibold">Run details</h3><Button size="sm" onClick={() => { ++learningDetailSequence.current; setRunDetailLoading(false); setLearningRunDetail(undefined); }}>Close</Button></div><p>{learningRunDetail.run.status} · {learningRunDetail.run.provider} · {learningRunDetail.run.model} · attempts {learningRunDetail.run.attempt}</p>{learningRunDetail.run.error && <p className="text-danger">{learningRunDetail.run.error}</p>}<p className="text-ink-3">{learningRunDetail.run.sourceManifest === 'recaptured' ? 'Sources were re-captured when this run was retried. They are current text, not the original historical input.' : learningRunDetail.run.sourceManifest === 'unavailable' ? 'No source manifest was recorded for this older run. Retry captures the current completed sources anew.' : 'Sources are current text, not a historical snapshot.'}</p>{learningRunDetail.truncated && <p className="text-ink-3">Details are bounded to the most relevant records.</p>}<div><strong>Sources</strong>{learningRunDetail.sources.map((source) => <p key={source.messageId} className="text-ink-3">{source.state} · {source.role} · {source.messageId} · captured revision {source.capturedRevision}{source.currentText ? ` · current text: ${source.currentText}` : ''}</p>)}</div><div><strong>Proposals</strong>{learningRunDetail.proposals.map((proposal) => <p key={proposal.proposalId} className="text-ink-3">{proposal.kind} · {proposal.status}{proposal.rejection ? ` · ${proposal.rejection}` : ''}</p>)}</div><div><strong>Changes</strong>{learningRunDetail.changes.map((change) => <p key={change.id} className="text-ink-3">{change.action} {change.resourceType} {change.resourceId} · revision {change.afterRevision}</p>)}</div></div>}

    </Panel>
     <Panel className="grid gap-3">
       <div>
         <h2 className="text-[15px] font-semibold">Memory</h2>
         <p className="mt-1 text-[12.5px] text-ink-2">Memory is off until you opt in. Basic recall stays local. Jev can route against bounded topic and entity descriptors only after its separate privacy consent is enabled.</p>
       </div>
       <label className="flex items-start gap-2 text-[13px]"><input aria-label="Enable basic memory recall" type="checkbox" checked={enabled} disabled={!settings || busy} onChange={(event) => void setEnabled(event.target.checked)} /><span><strong>Enable memory</strong><br /><span className="text-[12px] text-ink-3">Also enables the explicit memory tool for the current request.</span></span></label>
       <label className="grid gap-1 text-[12px]">Recall mode<select aria-label="Memory recall mode" className="rounded-lg border border-line bg-surface-1 px-2 py-1.5" value={settings?.recall ?? 'basic'} disabled={!settings || busy} onChange={(event) => void setPolicy(event.target.value as 'basic' | 'jev', settings?.jevConsent ?? false, settings?.jevModel ?? 'jev-latest')}><option value="basic">Basic, local only</option><option value="jev">Jev contextual routing</option></select></label>
       {settings?.recall === 'jev' && <>
         <label className="flex items-start gap-2 text-[13px]"><input aria-label="Allow Jev memory routing" type="checkbox" checked={settings.jevConsent} disabled={busy} onChange={(event) => void setPolicy('jev', event.target.checked, settings.jevModel)} /><span><strong>Allow Jev memory routing</strong><br /><span className="text-[12px] text-ink-3">Sends the current request, bounded recent evidence, and bounded topic/entity descriptors to TypeSafe. Tool-selection consent does not enable this.</span></span></label>
         <label className="grid gap-1 text-[12px]">Jev model<input aria-label="Jev model" className="rounded-lg border border-line bg-surface-1 px-2 py-1.5" defaultValue={settings.jevModel} key={settings.jevModel} disabled={busy} onBlur={(event) => { if (event.currentTarget.value.trim() !== settings.jevModel) void setPolicy('jev', settings.jevConsent, event.currentTarget.value); }} /></label>
       </>}
       <p className="text-[12px] text-ink-3">{MEMORY_DISABLED_COPY}</p>
       <p aria-label="Memory forgetting scope" className="text-[12px] text-ink-3">{MEMORY_FORGET_SCOPE_COPY}</p>
       {recallHistory.records.length > 0 && <div className="grid gap-2"><h3 className="text-[13px] font-semibold">Recent recall inspection</h3><p className="text-[12px] text-ink-3">Shows the route actually used for each reply. A basic fallback does not change your configured recall mode.</p>{recallHistory.records.slice(0, 10).map((item) => <div key={item.id} className="rounded-lg border border-line p-2 text-[11px]"><div className="flex justify-between gap-2"><span>{memoryRecallLabel(item.mode, item.outcome)}</span><span>{item.selected.length} selected</span></div><p className="mt-1 text-ink-3">Reply {item.messageId}, memory IDs and revisions only. {item.candidateCount} candidates, {item.descriptorCount} descriptors, {item.relationshipCount} one-hop connections.</p></div>)}</div>}
     </Panel>
    <Panel className="grid min-h-0 gap-3">
      <div className="flex items-center justify-between gap-2">
        <div><h2 className="text-[15px] font-semibold">Saved memories</h2><p className="text-[12px] text-ink-3">Inspect and manage records whether recall is enabled or disabled.</p></div>
        {detail && <Button size="sm" onClick={() => { setSelectedId(undefined); setDetail(undefined); setConnections(undefined); }}>Back to list</Button>}
      </div>
      {!detail && <>
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setQuery(queryInput.trim()); void loadPage(queryInput.trim(), 0, false); }}>
          <Input aria-label="Search memories" placeholder="Search saved text" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} />
          <Button type="submit" variant="primary" disabled={listBusy}>Search</Button>
        </form>
        <div className="grid gap-2">
          {page.memories.length === 0 && <p className="rounded-lg bg-surface-2 px-3 py-4 text-[13px] text-ink-3">No saved memories.</p>}
          {page.memories.map((memory) => <button key={memory.id} type="button" className="grid gap-1 rounded-xl border border-line bg-surface-2 p-3 text-left hover:border-line-strong" onClick={() => { setSelectedId(memory.id); void loadSelected(memory.id, memory.revision); }}>
            <span className="flex items-center justify-between gap-2 text-[12px] text-ink-3"><span>{memoryStateLabel(memory)}</span><span>Revision {memory.revision}</span></span>
            <span className="text-[13px] text-ink">{memory.text}{memory.textTruncated ? '…' : ''}</span>
            <span className="text-[11px] text-ink-3">Recorded {dateLabel(memory.recordedAt)}</span>
          </button>)}
        </div>
        {page.nextOffset !== null && <Button disabled={listBusy} onClick={() => void loadPage(query, page.nextOffset!, true)}>{listBusy ? 'Loading…' : 'Load more'}</Button>}
      </>}

      {detail && <div className="grid gap-4">
        <div className="flex items-start justify-between gap-2"><div><h3 className="text-[14px] font-semibold">Memory detail</h3><p className="text-[11px] text-ink-3">Revision {detail.revision}, {memoryStateLabel(detail)}</p></div><Button variant="danger" size="sm" disabled={busy} onClick={() => void forgetMemory()}>Forget</Button></div>
        {draftStale && <p role="status">Memory changed while you were editing. Your draft is preserved. <Button size="sm" onClick={() => { if (window.confirm('Discard your draft and reload?')) void loadSelected(detail.id); }}>Reload saved version</Button></p>}
        {detail.textNextOffset !== null && <p role="status">Load the remaining text before editing or saving this memory.</p>}
        <Field label="Text" htmlFor="memory-text" hint="Settings edits are attributed to this user action and do not create conversation evidence.">
          <Textarea id="memory-text" rows={7} value={draft} disabled={busy || detailBusy || detail.textNextOffset !== null} onChange={(event) => { dirtyDraft.current = true; setDraft(event.target.value); }} />
        </Field>
        <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy || detailBusy || draftStale || detail.textNextOffset !== null || !draft.trim() || draft.trim() === detail.textPage} onClick={() => void updateMemory({ text: draft })}>Save text</Button><Button disabled={busy || draftStale || draft !== detail.textPage} onClick={() => void updateMemory({ pinned: !detail.pinned })}>{detail.pinned ? 'Unpin' : 'Pin'}</Button>{detail.textNextOffset !== null && <Button disabled={busy} onClick={() => void loadMoreText()}>Load more text</Button>}</div>
        <dl className="grid gap-1 rounded-lg bg-surface-2 p-3 text-[12px]"><div><dt className="inline font-medium text-ink-2">Kind: </dt><dd className="inline">{detail.kind}</dd></div><div><dt className="inline font-medium text-ink-2">Recorded: </dt><dd className="inline">{dateLabel(detail.recordedAt)}</dd></div><div><dt className="inline font-medium text-ink-2">Valid from: </dt><dd className="inline">{dateLabel(detail.validFrom)}</dd></div><div><dt className="inline font-medium text-ink-2">Valid until: </dt><dd className="inline">{dateLabel(detail.validUntil)}</dd></div></dl>
        <div className="grid gap-2"><h3 className="text-[13px] font-semibold">Evidence</h3>{detail.evidence.length === 0 && <p className="text-[12px] text-ink-3">No evidence attached.</p>}{detail.evidence.map((item) => <div key={item.id} className="rounded-lg border border-line p-2 text-[11px]"><div className="flex justify-between gap-2"><span>{item.valid ? item.stance : `Invalid: ${item.invalidReason ?? 'stale evidence'}`}</span><span>{dateLabel(item.recordedAt)}</span></div><p className="mt-1 text-ink-3">{item.sourceRole} source {item.sourceMessageId}, revision {item.sourceRevision}, source date {dateLabel(item.sourceCreatedAt)}. {item.provenance}</p></div>)}{detail.evidenceTruncated && <p className="text-[12px] text-ink-3">Evidence list is capped at 50 records.</p>}</div>
        <div className="grid gap-2"><h3 className="text-[13px] font-semibold">Connections</h3>{connections?.connections.length === 0 && <p className="text-[12px] text-ink-3">No stored connections.</p>}{connections?.connections.map((item) => <div key={item.id} className="rounded-lg border border-line p-2 text-[11px]"><div className="flex justify-between gap-2"><span>{item.kind}{item.explicit ? ' · explicit' : ' · inferred'}</span><span>{item.valid ? 'Current source' : `Invalid: ${item.invalidReason ?? 'stale'}`}</span></div><p className="mt-1 text-ink-3">{item.subjectId} to {item.objectId}. {item.provenance}</p></div>)}</div>
      </div>}
    </Panel>
    {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
  </div>;
}
