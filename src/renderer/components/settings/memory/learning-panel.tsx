import { useEffect, useRef, useState } from 'react';
import type { Result } from '@shared/protocol';
import type { LearningHistoryRecord, LearningSettingsState } from '@shared/protocol';
import { MODELS } from '@shared/models';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/field';
import { Panel } from '@renderer/components/ui/panel';
import { Badge } from '@renderer/components/ui/badge';
import { Disclosure } from '@renderer/components/ui/disclosure';
import { LearningRuns } from './learning-runs';
import { notifyMemoriesChanged } from './memory-refresh';
import { dateLabel, errorMessage } from './format';

const HISTORY_LIMIT = 50;
const CONVERSATION_LIMIT = 100;

export function LearningPanel() {
  const [learning, setLearning] = useState<LearningSettingsState>();
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [history, setHistory] = useState<LearningHistoryRecord[]>([]);
  const [conversations, setConversations] = useState<{ id: string; title: string }[]>();
  const [conversationFilter, setConversationFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const conversationsRequested = useRef(false);

  function accept(next: LearningSettingsState, nextExclusions?: string[]): boolean {
    if (next.revision < revision.current) return false;
    const changed = next.revision > revision.current;
    revision.current = next.revision;
    setLearning(next);
    if (nextExclusions) setExclusions(nextExclusions);
    return changed;
  }

  async function loadHistory() {
    try {
      const result = await window.moki.request({ method: 'learningHistory', limit: HISTORY_LIMIT, offset: 0 });
      if (result.learning) accept(result.learning, result.learningExclusions);
      setHistory(result.learningHistory ?? []);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  async function loadConversations() {
    if (conversationsRequested.current) return;
    conversationsRequested.current = true;
    try {
      const result = await window.moki.request({ method: 'snapshot' });
      setConversations(result.snapshot.conversations.slice(0, CONVERSATION_LIMIT).map((item) => ({ id: item.id, title: item.title })));
    } catch (failure) {
      conversationsRequested.current = false;
      setError(errorMessage(failure));
    }
  }

  async function persist(request: () => Promise<Result>) {
    setBusy(true);
    setError('');
    try {
      const result = await request();
      if (result.learning) accept(result.learning, result.learningExclusions);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function setLearningEnabled(enabled: boolean) {
    if (!learning || busy) return;
    await persist(() => window.moki.request({ method: 'learningSetEnabled', enabled, expectedRevision: learning.revision }));
    await loadHistory();
  }

  async function setPaused(paused: boolean) {
    if (!learning || busy) return;
    await persist(() => window.moki.request({ method: 'learningSetPaused', paused, expectedRevision: learning.revision }));
  }

  async function setProviderModel(provider: 'deepseek' | 'codex', model: string) {
    if (!learning || busy) return;
    await persist(() => window.moki.request({ method: 'learningSetProviderModel', provider, model, expectedRevision: learning.revision }));
  }

  async function setConversationExcluded(conversationId: string, excluded: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.moki.request({ method: 'learningExcludeConversation', conversationId, excluded });
      if (result.learning) accept(result.learning, result.learningExclusions);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function undoLearning(item: LearningHistoryRecord) {
    if (busy || item.undoneAt !== null) return;
    setBusy(true);
    try {
      const result = await window.moki.request({ method: 'learningUndo', historyId: item.id, expectedRevision: item.afterRevision });
      if (result.learning) accept(result.learning, result.learningExclusions);
      await loadHistory();
      // Undo rewrites memory records; tell the memories browser to refresh even
      // if no memory revision broadcast follows.
      notifyMemoriesChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    const unsubscribe = window.moki.onState((result: Result) => {
      if (!active || !result.learning) return;
      if (accept(result.learning, result.learningExclusions)) void loadHistory();
    });
    void window.moki.request({ method: 'learningSettings' }).then(
      (result) => { if (active && result.learning) accept(result.learning, result.learningExclusions); },
      (failure) => { if (active) setError(errorMessage(failure)); },
    );
    void loadHistory();
    return () => { active = false; unsubscribe(); };
  }, []);

  const filter = conversationFilter.trim().toLowerCase();
  const filteredConversations = (conversations ?? []).filter((conversation) => !filter || conversation.title.toLowerCase().includes(filter));
  return <Panel className="grid gap-3">
    <div>
      <h3 className="text-[13.5px] font-semibold">Automatic learning</h3>
      <p className="mt-1 text-[12.5px] text-ink-2">Off until you opt in. When enabled, Moki reviews new completed messages during idle time and sends bounded excerpts to the configured provider.</p>
    </div>
    <label className="flex items-start gap-2 text-[13px]">
      <input aria-label="Enable automatic learning" type="checkbox" checked={learning?.enabled === true} disabled={!learning || busy} onChange={(event) => void setLearningEnabled(event.target.checked)} />
      <span><strong>Enable automatic learning</strong><br /><span className="text-[12px] text-ink-3">New activity only. Enabling does not backfill old conversations.</span></span>
    </label>
    {learning?.enabled && <>
      <label className="flex items-start gap-2 text-[13px]">
        <input aria-label="Pause automatic learning" type="checkbox" checked={learning.paused} disabled={busy} onChange={(event) => void setPaused(event.target.checked)} />
        <span><strong>Pause learning</strong><br /><span className="text-[12px] text-ink-3">Pending reviews are cancelled before commit.</span></span>
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-[12px]">Provider
          <select aria-label="Learning provider" className="rounded-lg border border-line bg-surface-2 px-2 py-1.5" value={learning.provider} disabled={busy} onChange={(event) => {
            const provider = event.target.value as 'deepseek' | 'codex';
            const first = MODELS.find((model) => model.provider === provider);
            if (first) void setProviderModel(provider, first.id);
          }}>
            <option value="deepseek">DeepSeek</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label className="grid gap-1 text-[12px]">Model
          <select aria-label="Learning model" className="rounded-lg border border-line bg-surface-2 px-2 py-1.5" value={learning.model} disabled={busy} onChange={(event) => void setProviderModel(learning.provider, event.target.value)}>
            {MODELS.filter((model) => model.provider === learning.provider).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select>
        </label>
      </div>
      <Disclosure title="Excluded conversations" badge={exclusions.length > 0 ? <Badge>{exclusions.length} excluded</Badge> : undefined} description="Excluded conversations are never used as learning sources." onOpenChange={(open) => { if (open) void loadConversations(); }}>
        {conversations === undefined && <p className="text-[12px] text-ink-3">Loading conversations…</p>}
        {conversations !== undefined && conversations.length === 0 && <p className="text-[12px] text-ink-3">No conversations yet.</p>}
        {conversations !== undefined && conversations.length > 0 && <>
          <Input aria-label="Filter conversations" placeholder="Filter conversations" value={conversationFilter} onChange={(event) => setConversationFilter(event.target.value)} />
          <div className="grid max-h-56 gap-1 overflow-y-auto pr-1">
            {filteredConversations.map((conversation) => <label key={conversation.id} className="flex min-h-6 items-center gap-2 text-[12px]">
              <input type="checkbox" aria-label={`Exclude ${conversation.title}`} checked={exclusions.includes(conversation.id)} disabled={busy} onChange={(event) => void setConversationExcluded(conversation.id, event.target.checked)} />
              <span className="truncate" title={conversation.title}>{conversation.title}</span>
            </label>)}
            {filteredConversations.length === 0 && <p className="text-[12px] text-ink-3">No matching conversations.</p>}
          </div>
        </>}
      </Disclosure>
      <Disclosure title="Learning history" badge={history.length > 0 ? <Badge>{history.length}</Badge> : undefined}>
        {history.length === 0 && <p className="text-[12px] text-ink-3">Nothing learned yet.</p>}
        {history.length > 0 && <>
          <div className="grid max-h-64 gap-1.5 overflow-y-auto pr-1">
            {history.map((item) => <div key={item.id} title={`${item.resourceType} ${item.resourceId}`} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-[11.5px]">
              <span className="min-w-0"><span className="font-medium">{item.action === 'add' ? 'Added' : 'Corrected'} {item.resourceType}</span><span className="text-ink-3"> · rev {item.afterRevision} · {dateLabel(item.createdAt)}{item.undoneAt !== null ? ' · undone' : ''}</span></span>
              <Button size="sm" disabled={busy || item.undoneAt !== null} onClick={() => void undoLearning(item)}>Undo</Button>
            </div>)}
          </div>
          <p className="text-[11px] text-ink-3">Newest {HISTORY_LIMIT} entries. Undo re-checks sources before reverting.</p>
        </>}
      </Disclosure>
    </>}
    <Disclosure title="How learning works">
      <p className="text-[12px] text-ink-3">Learning never receives desktop, network, or app-action tools. The provider receives user and assistant excerpts; only user statements may support learned facts, assistant text is context. Source IDs, revisions, exclusions, forgotten evidence, and later edits are re-checked before anything is saved. When a TypeSafe key is saved (Providers section), Jev additionally checks each proposed fact against the user message it cites before it is saved; rejected proposals are visible in the run details. Credentials stay in Electron secure storage and are never persisted in this database or exposed to the renderer.</p>
    </Disclosure>
    <LearningRuns />
    {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
  </Panel>;
}
