import { useEffect, useRef, useState } from 'react';
import type { Result } from '@shared/protocol';
import type { MemoryRecallHistoryPage, MemorySettingsState } from '@shared/memory';
import { Panel } from '@renderer/components/ui/panel';
import { Badge } from '@renderer/components/ui/badge';
import { Disclosure } from '@renderer/components/ui/disclosure';
import { acceptMemoryRevision, memoryRecallLabel, MEMORY_DISABLED_COPY } from '@renderer/lib/memory-settings-state';
import { errorMessage } from './format';

const RECALL_HISTORY_LIMIT = 25;
const JEV_MODELS = ['jev-latest'];

export function RecallPanel() {
  const [settings, setSettings] = useState<MemorySettingsState>();
  const [recallHistory, setRecallHistory] = useState<MemoryRecallHistoryPage>({ records: [], offset: 0, nextOffset: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);

  function accept(next: MemorySettingsState): boolean {
    const decision = acceptMemoryRevision(revision.current, next.revision);
    if (!decision.accepted) return false;
    revision.current = decision.revision;
    setSettings(next);
    return decision.refresh;
  }

  async function loadRecallHistory() {
    try {
      const result = await window.moki.request({ method: 'memoryRecallHistory', limit: RECALL_HISTORY_LIMIT, offset: 0 });
      if (result.memoryRecallHistory) setRecallHistory(result.memoryRecallHistory);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  async function setEnabled(enabled: boolean) {
    if (!settings || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.moki.request({ method: 'memorySetEnabled', enabled, expectedRevision: settings.revision });
      if (result.memory) accept(result.memory);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function setPolicy(recall: 'basic' | 'jev', jevConsent: boolean, jevModel: string) {
    if (!settings || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.moki.request({ method: 'memorySetPolicy', recall, jevConsent, jevModel, expectedRevision: settings.revision });
      if (result.memory) accept(result.memory);
      await loadRecallHistory();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    const unsubscribe = window.moki.onState((result: Result) => {
      if (!active) return;
      if (result.memory) accept(result.memory);
      if (result.memoryRecall) void loadRecallHistory();
    });
    void window.moki.request({ method: 'memorySettings' }).then(
      (result) => { if (active && result.memory) accept(result.memory); },
      (failure) => { if (active) setError(errorMessage(failure)); },
    );
    void loadRecallHistory();
    return () => { active = false; unsubscribe(); };
  }, []);

  const enabled = settings?.enabled === true;
  return <Panel className="grid gap-3">
    <div>
      <h3 className="text-[13.5px] font-semibold">Memory recall</h3>
      <p className="mt-1 text-[12.5px] text-ink-2">Off until you opt in. Basic recall stays local. Jev routes recall through your topics and entities once its privacy consent is enabled here and TypeSafe is connected (Providers section).</p>
    </div>
    <label className="flex items-start gap-2 text-[13px]">
      <input aria-label="Enable basic memory recall" type="checkbox" checked={enabled} disabled={!settings || busy} onChange={(event) => void setEnabled(event.target.checked)} />
      <span><strong>Enable memory</strong><br /><span className="text-[12px] text-ink-3">Also enables the explicit memory tool for the current request.</span></span>
    </label>
    <label className="grid gap-1 text-[12px]">Recall mode
      <select aria-label="Memory recall mode" className="rounded-lg border border-line bg-surface-2 px-2 py-1.5" value={settings?.recall ?? 'basic'} disabled={!settings || busy} onChange={(event) => void setPolicy(event.target.value as 'basic' | 'jev', settings?.jevConsent ?? false, settings?.jevModel ?? 'jev-latest')}>
        <option value="basic">Basic, local only</option>
        <option value="jev">Jev contextual routing</option>
      </select>
    </label>
    {settings?.recall === 'jev' && <>
      <label className="flex items-start gap-2 text-[13px]">
        <input aria-label="Allow Jev memory routing" type="checkbox" checked={settings.jevConsent} disabled={busy} onChange={(event) => void setPolicy('jev', event.target.checked, settings.jevModel)} />
        <span><strong>Allow Jev memory routing</strong><br /><span className="text-[12px] text-ink-3">Sends the current request, bounded recent evidence, and bounded topic/entity descriptors to TypeSafe. Tool-selection consent does not enable this. Connect TypeSafe Jev in the Providers section.</span></span>
      </label>
      <label className="grid gap-1 text-[12px]">Jev model
        <select aria-label="Jev model" className="rounded-lg border border-line bg-surface-2 px-2 py-1.5" value={settings.jevModel} disabled={busy} onChange={(event) => { if (event.target.value !== settings.jevModel) void setPolicy('jev', settings.jevConsent, event.target.value); }}>
          {JEV_MODELS.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      </label>
    </>}
    <p className="text-[12px] text-ink-3">{MEMORY_DISABLED_COPY}</p>
    <Disclosure title="Recent recall inspection" badge={recallHistory.records.length > 0 ? <Badge>{recallHistory.records.length}</Badge> : undefined} description="Shows the route actually used for each reply. A basic fallback does not change your configured recall mode.">
      {recallHistory.records.length === 0 && <p className="text-[12px] text-ink-3">No replies have used recall yet.</p>}
      {recallHistory.records.length > 0 && <div className="grid max-h-64 gap-2 overflow-y-auto pr-1">
        {recallHistory.records.map((item) => <div key={item.id} className="rounded-lg border border-line bg-surface-2 p-2 text-[11px]">
          <div className="flex justify-between gap-2"><span>{memoryRecallLabel(item.mode, item.outcome)}</span><span>{item.selected.length} selected</span></div>
          <p className="mt-1 text-ink-3">Reply {item.messageId}, memory IDs and revisions only. {item.candidateCount} candidates, {item.descriptorCount} descriptors, {item.relationshipCount} one-hop connections.</p>
        </div>)}
      </div>}
    </Disclosure>
    {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
  </Panel>;
}
