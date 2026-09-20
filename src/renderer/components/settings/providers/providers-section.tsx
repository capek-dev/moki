import { useEffect, useRef, useState } from 'react';
import type { ProviderCommand, ProviderState } from '@shared/protocol';
import { Button } from '@renderer/components/ui/button';
import { Field, Input } from '@renderer/components/ui/field';
import { Panel } from '@renderer/components/ui/panel';
import { ProviderCard } from './provider-card';
import { JevCard } from './jev-card';

/** Every external connection in one list: two chat providers plus the TypeSafe Jev service. */
export function ProvidersSection() {
  const [state, setState] = useState<ProviderState>();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recoveryArmed, setRecoveryArmed] = useState(false);
  const revision = useRef(-1);
  const lock = useRef(false);
  function accept(next: ProviderState) {
    if (next.revision < revision.current) return;
    revision.current = next.revision; setState(next);
  }
  async function run(command: ProviderCommand) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      accept(await window.moki.providers(command));
      if (command.action === 'resetUnreadable') setNotice('Saved provider credentials were backed up and reset. Enter your key or sign in again.');
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Connection failed.'); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => {
    const unsubscribe = window.moki.onProviders(accept);
    void run({ action: 'status' });
    return unsubscribe;
  }, []);
  return <div className="grid gap-3">
    <ProviderCard
      name="DeepSeek"
      description="API-key chat provider."
      connected={!!state?.deepseek.connected}
      statusLabel={state?.deepseek.connected ? 'Key verified and saved' : 'No key saved'}
    >
      <form className="grid gap-2.5" onSubmit={(e) => { e.preventDefault(); const value = key.trim(); setKey(''); void run({ action: 'saveDeepseek', key: value }); }}>
        <Field label="API key" htmlFor="deepseek-key">
          <Input id="deepseek-key" type="password" autoComplete="off" spellCheck={false} maxLength={1000} value={key} disabled={busy} placeholder="sk-…" onChange={(e) => setKey(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          {state?.deepseek.connected && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run({ action: 'disconnect', provider: 'deepseek' })}>Remove key</Button>}
          <Button variant="primary" size="sm" type="submit" disabled={busy || !key.trim() || !state}>Verify and save key</Button>
        </div>
      </form>
    </ProviderCard>
    <ProviderCard
      name="Codex subscription"
      description="Sign in with your ChatGPT account."
      connected={!!state?.codex.connected}
      statusLabel={state?.codex.connected ? 'Credentials saved' : 'Not signed in'}
    >
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
    </ProviderCard>
    <JevCard />
    {state?.error && <Panel className="text-[12.5px] text-danger" role="alert">{state.error}</Panel>}
    {busy && <p className="text-[12px] text-ink-3" role="status">Connecting…</p>}
    {notice && <p className="text-[12.5px] text-ink-2" role="status">{notice}</p>}
    {error && <div role="alert" className="grid gap-2 rounded-xl border border-[color-mix(in_oklab,var(--danger)_28%,transparent)] bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">
      <span>{error}</span>
      {!state && recoveryArmed && <span>This keeps the unreadable encrypted file as a backup, then creates an empty credential store. You will need to enter provider credentials again.</span>}
      {!state && <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run({ action: 'status' })}>Retry</Button>
        {!recoveryArmed
          ? <Button variant="danger" size="sm" disabled={busy} onClick={() => setRecoveryArmed(true)}>Reset saved credentials</Button>
          : <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRecoveryArmed(false)}>Cancel</Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => { setRecoveryArmed(false); void run({ action: 'resetUnreadable' }); }}>Back up and reset</Button>
          </>}
      </div>}
    </div>}
  </div>;
}
