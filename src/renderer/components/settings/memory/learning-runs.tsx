import { useEffect, useRef, useState } from 'react';
import type { Result } from '@shared/protocol';
import type { LearningRunDetail, LearningRunPage, LearningRunSummary, LearningSettingsState } from '@shared/protocol';
import { Button } from '@renderer/components/ui/button';
import { Badge } from '@renderer/components/ui/badge';
import { dateLabel, errorMessage } from './format';

const RUNS_PAGE_SIZE = 25;
const RUN_DETAIL_LIMIT = 50;

function runStatus(run: LearningRunSummary): { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' } {
  if (run.outcome === 'no_changes') return { label: 'No changes', tone: 'neutral' };
  switch (run.status) {
    case 'failed': return { label: 'Failed', tone: 'danger' };
    case 'running': return { label: 'Running', tone: 'accent' };
    case 'pending': return { label: 'Pending', tone: 'warn' };
    case 'cancelled': return { label: 'Cancelled', tone: 'neutral' };
    default: return { label: 'Completed', tone: 'ok' };
  }
}

/**
 * Bounded list of learning runs. One compact row per run; the inspector expands
 * inline under its row, so inspecting a run never moves the rest of the page.
 */
export function LearningRuns() {
  const [runs, setRuns] = useState<LearningRunPage>({ runs: [], offset: 0, nextOffset: null });
  const [runsLoading, setRunsLoading] = useState(true);
  const [detail, setDetail] = useState<LearningRunDetail>();
  const [detailRunId, setDetailRunId] = useState<string>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionRunId, setActionRunId] = useState<string>();
  const [error, setError] = useState('');
  const learningRevision = useRef(0);
  const runsSequence = useRef(0);
  const detailSequence = useRef(0);

  function acceptLearning(next: LearningSettingsState): boolean {
    if (next.revision < learningRevision.current) return false;
    const changed = next.revision > learningRevision.current;
    learningRevision.current = next.revision;
    return changed;
  }

  async function loadRuns(offset = 0, append = false) {
    const sequence = ++runsSequence.current;
    if (!append) setRunsLoading(true);
    try {
      const result = await window.moki.request({ method: 'learningRuns', limit: RUNS_PAGE_SIZE, offset });
      if (sequence !== runsSequence.current || !result.learningRuns) return;
      if (result.learning) acceptLearning(result.learning);
      setRuns((current) => append ? { ...result.learningRuns!, runs: [...current.runs, ...result.learningRuns!.runs] } : result.learningRuns!);
    } catch (failure) {
      if (sequence === runsSequence.current) setError(errorMessage(failure));
    } finally {
      if (sequence === runsSequence.current) setRunsLoading(false);
    }
  }

  function toggleDetail(runId: string) {
    if (detailRunId === runId) {
      ++detailSequence.current;
      setDetailRunId(undefined);
      setDetail(undefined);
      setDetailLoading(false);
      return;
    }
    const sequence = ++detailSequence.current;
    setDetailRunId(runId);
    setDetail(undefined);
    setDetailLoading(true);
    void window.moki.request({ method: 'learningRunDetail', runId, limit: RUN_DETAIL_LIMIT }).then(
      (result) => {
        if (sequence !== detailSequence.current) return;
        setDetail(result.learningRunDetail);
        setDetailLoading(false);
      },
      (failure) => {
        if (sequence !== detailSequence.current) return;
        setError(errorMessage(failure));
        setDetailLoading(false);
      },
    );
  }

  async function runAction(runId: string, method: 'learningRetry' | 'learningCancel') {
    if (actionRunId) return;
    setActionRunId(runId);
    try {
      await window.moki.request({ method, runId });
      await loadRuns();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setActionRunId(undefined);
    }
  }

  function openReview(runId: string) {
    window.moki.openLearningReview(runId).catch((failure) => setError(errorMessage(failure)));
  }

  useEffect(() => {
    let active = true;
    const unsubscribe = window.moki.onState((result: Result) => {
      if (!active || !result.learning) return;
      // Reload only when the learning settings revision moved forward; equal
      // revisions carry no new run information and must not trigger fetches.
      if (acceptLearning(result.learning)) void loadRuns();
    });
    void loadRuns();
    return () => { active = false; ++runsSequence.current; ++detailSequence.current; unsubscribe(); };
  }, []);

  return <div className="grid gap-2">
    <div>
      <h3 className="text-[13px] font-semibold">Learning runs</h3>
      <p className="text-[12px] text-ink-3">Every review attempt, including failures and runs that saved nothing.</p>
    </div>
    {runs.runs.length === 0 && <p className="text-[12px] text-ink-3">{runsLoading ? 'Loading learning runs…' : 'No learning runs yet.'}</p>}
    {runs.runs.length > 0 && <ol className="grid max-h-72 gap-2 overflow-y-auto pr-1">
      {runs.runs.map((run) => {
        const status = runStatus(run);
        const inspecting = detailRunId === run.id;
        return <li key={run.id} className="grid gap-1.5">
          <div className="grid gap-1.5 rounded-xl border border-line bg-surface-2 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge tone={status.tone}>{status.label}{run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}</Badge>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => toggleDetail(run.id)}>{inspecting ? 'Hide run details' : 'Inspect run'}</Button>
                <Button size="sm" onClick={() => openReview(run.id)}>Open review</Button>
                {(run.status === 'failed' || run.status === 'cancelled') && <Button size="sm" disabled={actionRunId !== undefined} onClick={() => void runAction(run.id, 'learningRetry')}>{run.sourceManifest === 'unavailable' ? 'Review current sources' : 'Retry'}</Button>}
                {(run.status === 'pending' || run.status === 'running') && <Button size="sm" disabled={actionRunId !== undefined} onClick={() => void runAction(run.id, 'learningCancel')}>Cancel</Button>}
              </div>
            </div>
            <p className="text-[11px] text-ink-3">{run.provider} · {run.model} · {dateLabel(run.createdAt)} · {run.appliedCount} applied, {run.rejectedCount} rejected</p>
            {run.error && <p className="truncate text-[11px] text-danger" title={run.error}>Last error: {run.error}</p>}
          </div>
          {inspecting && (detailLoading
            ? <p role="status" className="px-1 text-[11.5px] text-ink-3">Loading run details…</p>
            : detail && <RunDetail detail={detail} onClose={() => toggleDetail(run.id)} />)}
        </li>;
      })}
    </ol>}
    {runs.nextOffset !== null && <Button size="sm" disabled={runsLoading} onClick={() => void loadRuns(runs.nextOffset!, true)}>{runsLoading ? 'Loading…' : 'More runs'}</Button>}
    {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
  </div>;
}

function RunDetail({ detail, onClose }: { detail: LearningRunDetail; onClose: () => void }) {
  const run = detail.run;
  return <div className="grid gap-2 rounded-xl border border-line bg-surface-solid p-2.5 text-[11.5px]">
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-[12.5px] font-semibold">Run details</h4>
      <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
    </div>
    <p>{run.status} · {run.provider} · {run.model} · attempts {run.attempt}</p>
    {run.error && <p className="text-danger">{run.error}</p>}
    <p className="text-ink-3">{run.sourceManifest === 'recaptured'
      ? 'Sources were re-captured when this run was retried. They are current text, not the original historical input.'
      : run.sourceManifest === 'unavailable'
        ? 'No source manifest was recorded for this older run. Retry captures the current completed sources anew.'
        : 'Sources are current text, not a historical snapshot.'}</p>
    {detail.truncated && <p className="text-ink-3">Details are bounded to the most relevant records.</p>}
    <div className="grid gap-1">
      <strong>Sources</strong>
      <div className="grid max-h-36 gap-1 overflow-y-auto pr-1">
        {detail.sources.length === 0 && <p className="text-ink-3">No sources recorded.</p>}
        {detail.sources.map((source) => <p key={source.messageId} className="truncate text-ink-3" title={source.currentText ?? undefined}>{source.state} · {source.role} · {source.messageId} · captured revision {source.capturedRevision}{source.currentText ? ` · current text: ${source.currentText}` : ''}</p>)}
      </div>
    </div>
    <div className="grid gap-1">
      <strong>Proposals</strong>
      <div className="grid max-h-36 gap-1 overflow-y-auto pr-1">
        {detail.proposals.length === 0 && <p className="text-ink-3">No proposals.</p>}
        {detail.proposals.map((proposal) => <p key={proposal.proposalId} className="text-ink-3">{proposal.kind} · {proposal.status}{proposal.rejection ? ` · ${proposal.rejection}` : ''}</p>)}
      </div>
    </div>
    <div className="grid gap-1">
      <strong>Changes</strong>
      <div className="grid max-h-36 gap-1 overflow-y-auto pr-1">
        {detail.changes.length === 0 && <p className="text-ink-3">No changes saved.</p>}
        {detail.changes.map((change) => <p key={change.id} className="text-ink-3">{change.action} {change.resourceType} {change.resourceId} · revision {change.afterRevision}</p>)}
      </div>
    </div>
  </div>;
}
