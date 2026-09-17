import { useEffect, useRef, useState } from 'react';
import type { ProviderCommand, ProviderState } from '../shared/protocol';
import { Button } from './ui/button';
import { Panel } from './ui/panel';
import { Field, Input } from './ui/field';

function StatusChip({ on, label }: { on: boolean; label: string }) {
  return <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
    <span className={`h-2 w-2 rounded-full ${on ? 'bg-ok' : 'bg-ink-3/60'}`} aria-hidden="true" />
    {label}
  </span>;
}

export function ProviderSettings() {
  const [state, setState] = useState<ProviderState>();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(-1);
  const lock = useRef(false);
  function accept(next: ProviderState) {
    if (next.revision < revision.current) return;
    revision.current = next.revision; setState(next);
  }
  async function run(command: ProviderCommand) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { accept(await window.moki.providers(command)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Connection failed.'); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => {
    const unsubscribe = window.moki.onProviders(accept);
    void run({ action: 'status' });
    return unsubscribe;
  }, []);
  return <div className="grid max-w-md gap-3">
    <p className="text-[12.5px] text-ink-3">Credentials are encrypted on this Mac. Choose this provider in your companion's settings, then select a model in chat.</p>
    <Panel className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13.5px] font-semibold">DeepSeek</h3>
        <StatusChip on={!!state?.deepseek.connected} label={state?.deepseek.connected ? 'Key verified and saved' : 'No key saved'} />
      </div>
      <form className="grid gap-2.5" onSubmit={(e) => { e.preventDefault(); const value = key.trim(); setKey(''); void run({ action: 'saveDeepseek', key: value }); }}>
        <Field label="API key" htmlFor="deepseek-key">
          <Input id="deepseek-key" type="password" autoComplete="off" spellCheck={false} maxLength={1000} value={key} disabled={busy} placeholder="sk-…" onChange={(e) => setKey(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          {state?.deepseek.connected && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run({ action: 'disconnect', provider: 'deepseek' })}>Remove key</Button>}
          <Button variant="primary" size="sm" type="submit" disabled={busy || !key.trim() || !state}>Verify and save key</Button>
        </div>
      </form>
    </Panel>
    <Panel className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13.5px] font-semibold">Codex subscription</h3>
        <StatusChip on={!!state?.codex.connected} label={state?.codex.connected ? 'Credentials saved' : 'Not signed in'} />
      </div>
      <div className="flex justify-end gap-2">
        {state?.codex.connected && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run({ action: 'disconnect', provider: 'codex' })}>Disconnect</Button>}
        <Button variant="secondary" size="sm" disabled={busy || !state || state.signingIn} onClick={() => void run({ action: 'startCodex' })}>{state?.codex.connected ? 'Replace sign-in' : 'Sign in with ChatGPT'}</Button>
      </div>
      {state?.signingIn && <div className="grid gap-2 rounded-xl border border-accent-line bg-accent-soft p-3">
        <p role="status" className="text-[12.5px] text-ink-2">Finish signing in in your browser. Moki will connect automatically. This request expires after five minutes.</p>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => void window.moki.providers({ action: 'cancelCodex' }).then(accept).catch(() => setError('Could not cancel sign-in.'))}>Cancel sign-in</Button>
        </div>
      </div>}
    </Panel>
    {state?.error && <p className="rounded-xl border border-[color-mix(in_oklab,var(--danger)_28%,transparent)] bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger" role="alert">{state.error}</p>}
    {busy && <p className="text-[12px] text-ink-3" role="status">Connecting…</p>}
    {error && <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-[color-mix(in_oklab,var(--danger)_28%,transparent)] bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">
      <span>{error}</span>
      {!state && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run({ action: 'status' })}>Retry</Button>}
    </div>}
  </div>;
}
