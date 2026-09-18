import { useEffect, useRef, useState } from 'react';
import type { Assistant, Result, Snapshot } from '@shared/protocol';
import { ProviderSettings } from '@renderer/components/settings/provider-settings';
import { CuaSettings } from '@renderer/components/settings/cua-settings';
import { McpSettings } from '@renderer/components/settings/mcp-settings';
import { AppearancePreview } from '@renderer/components/settings/appearance-preview';
import { INITIAL_APPEARANCE } from '@renderer/components/companion/companion';
import { mokiAssistant } from '@renderer/lib/moki';
import { TonePicker } from '@renderer/components/settings/tone-picker';
import { useTone } from '@renderer/lib/tone';
import { platformClass } from '@renderer/lib/platform';
import { Button } from '@renderer/components/ui/button';
import { Segmented } from '@renderer/components/ui/segmented';
import { Panel } from '@renderer/components/ui/panel';
import { Field, Textarea } from '@renderer/components/ui/field';
import { SimpleSelect } from '@renderer/components/ui/select';

const SECTIONS = ['Moki', 'Appearance', 'Providers', 'Integrations'] as const;
const PROVIDER_LABELS = { deepseek: 'DeepSeek', codex: 'Codex subscription' } as const;

export function Settings() {
  const [section, setSection] = useState<string>('Moki');
  const [data, setData] = useState<Snapshot>();
  const [editing, setEditing] = useState<Assistant>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const saving = useRef(false);
  const assistant = mokiAssistant(data?.assistants);
  const draft = editing ?? assistant;
  const { choice, choose } = useTone(assistant?.appearance?.palette);
  function accept(result: Result) {
    if ((result.revision ?? 0) < revision.current) return;
    revision.current = result.revision ?? 0;
    setData(result.snapshot);
  }
  async function load() {
    try { accept(await window.moki.request({ method: 'snapshot' })); setError(''); }
    catch (e) { setError(String(e)); }
  }
  useEffect(() => {
    const unsubscribe = window.moki.onState(accept);
    void load();
    return unsubscribe;
  }, []);
  return <main className={`flex h-full flex-col ${platformClass ?? ''}`}>
    <header className="titlebar flex min-h-12 items-end pb-2">
      <h1 className="pl-1 text-[13px] font-semibold tracking-[.02em] text-ink">Settings</h1>
    </header>
    <nav className="px-4 pb-4" aria-label="Settings sections">
      <Segmented value={section} onChange={setSection} aria-label="Settings sections" options={SECTIONS.map((name) => ({ value: name, label: name }))} />
    </nav>
    <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
      {section === 'Moki' && (draft ? <Panel>
        <form className="grid gap-4" onSubmit={async (event) => {
          event.preventDefault();
          if (saving.current || !editing || editing.id !== assistant?.id) return;
          saving.current = true; setBusy(true); setError('');
          try {
            accept(await window.moki.request({ method: 'saveAssistant', assistant: editing }));
            setEditing(undefined);
          } catch (e) { setError(String(e)); }
          finally { saving.current = false; setBusy(false); }
        }}>
          <h2 className="text-[15px] font-semibold">Moki</h2>
          <fieldset className="grid gap-4" disabled={busy}>
            <Field label="Provider" htmlFor="assistant-provider">
              <SimpleSelect
                id="assistant-provider"
                value={draft.provider}
                onValueChange={(provider) => setEditing({ ...draft, provider: provider as Assistant['provider'] })}
                options={Object.entries(PROVIDER_LABELS).map(([value, label]) => ({ value, label }))} />
            </Field>
            <Field label="How should Moki help?" htmlFor="assistant-instructions">
              <Textarea id="assistant-instructions" rows={6} maxLength={16000} value={draft.instructions} onChange={(e) => setEditing({ ...draft, instructions: e.target.value })} />
            </Field>
            <AppearancePreview appearance={draft.appearance ?? INITIAL_APPEARANCE} onChange={(appearance) => setEditing({ ...draft, appearance })} />
            <p className="text-[12px] text-ink-3">Connect your provider in the Providers section. Select the model in each conversation.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={!editing} onClick={() => setEditing(undefined)}>Discard changes</Button>
              <Button variant="primary" type="submit" disabled={!editing}>{busy ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </fieldset>
        </form>
      </Panel> : <p className="text-[13px] text-ink-3">{data ? 'Moki settings are unavailable.' : 'Loading…'}</p>)}
      {section === 'Appearance' && <Panel className="grid max-w-md gap-4">
        <div>
          <h2 className="text-[15px] font-semibold">Appearance</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">Pick the tone of the app. Match avatar follows Moki's colors, and windows update live.</p>
        </div>
        <TonePicker choice={choice} onChoose={choose} />
      </Panel>}
      <div hidden={section !== 'Providers'}><ProviderSettings /></div>
      {section === 'Integrations' && <div className="grid gap-3">
        <Panel className="grid gap-1.5">
          <h2 className="text-[15px] font-semibold">Integrations</h2>
          <p className="text-[13px] text-ink-2">Moki's MCP connections and access permissions will be managed here.</p>
        </Panel>
        <CuaSettings />
        <McpSettings />
      </div>}
    </section>
    {error && <div className="px-4 pb-4">
      <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-[color-mix(in_oklab,var(--danger)_28%,transparent)] bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">
        <span>{error}</span>
        {!data && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void load()}>Retry connection</Button>}
      </div>
    </div>}
  </main>;
}
