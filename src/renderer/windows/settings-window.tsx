import { useEffect, useRef, useState } from 'react';
import type { Assistant, Result, Snapshot } from '@shared/protocol';
import { ProvidersSection } from '@renderer/components/settings/providers/providers-section';
import { MemorySettings } from '@renderer/components/settings/memory-settings';
import { ConnectionsSettings } from '@renderer/components/settings/connections-settings';
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

const SECTIONS = ['Moki', 'Appearance', 'Providers', 'Memory', 'Integrations'] as const;
const PROVIDER_LABELS = { deepseek: 'DeepSeek', codex: 'Codex subscription' } as const;

/** Every tab opens the same way: one title, one line of context, then panels. */
function TabHeader({ title, description }: { title: string; description: string }) {
  return <div>
    <h2 className="text-[15px] font-semibold">{title}</h2>
    <p className="mt-0.5 text-[12.5px] text-ink-3">{description}</p>
  </div>;
}

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
    {/* One shared column: every tab renders inside the same width and rhythm. */}
    <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
      <div className="mx-auto grid w-full max-w-2xl gap-3">
        {section === 'Moki' && <div className="grid gap-3">
          <TabHeader title="Moki" description="Identity, instructions, and look for chat. Saved changes apply to new replies." />
          {draft ? <Panel>
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
          </Panel> : <p className="text-[13px] text-ink-3">{data ? 'Moki settings are unavailable.' : 'Loading…'}</p>}
        </div>}
        {section === 'Appearance' && <div className="grid gap-3">
          <TabHeader title="Appearance" description="Pick the tone of the app. Match avatar follows Moki's colors, and windows update live." />
          <Panel className="grid gap-4">
            <TonePicker choice={choice} onChoose={choose} />
          </Panel>
        </div>}
        {/* Providers stays mounted while hidden so switching tabs never refetches credentials. */}
        <div hidden={section !== 'Providers'} className="grid gap-3">
          <TabHeader title="Providers" description="DeepSeek or your Codex subscription for chat, TypeSafe Jev for smart routing. All credentials are encrypted on this Mac." />
          <ProvidersSection />
        </div>
        {section === 'Memory' && <div className="grid gap-3">
          <TabHeader title="Memory" description="What Moki remembers, what it learns from your chats, and how recall is routed." />
          <MemorySettings />
        </div>}
        {section === 'Integrations' && <div className="grid gap-3">
          <TabHeader title="Integrations" description="Cua Driver plus the app connections that extend what Moki can do. You control every connection and action." />
          <ConnectionsSettings />
        </div>}
      </div>
    </section>
    {error && <div className="px-4 pb-4">
      <div role="alert" className="mx-auto flex max-w-2xl items-start justify-between gap-3 rounded-xl border border-[color-mix(in_oklab,var(--danger)_28%,transparent)] bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">
        <span>{error}</span>
        {!data && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void load()}>Retry connection</Button>}
      </div>
    </div>}
  </main>;
}
