import { useEffect, useRef, useState } from 'react';
import type { ProviderCommand, ProviderState } from '../shared/protocol';

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
    try { accept(await window.povondra.providers(command)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Connection failed.'); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => {
    const unsubscribe = window.povondra.onProviders(accept);
    void run({ action: 'status' });
    return unsubscribe;
  }, []);
  return <>
    <h2>Provider connections</h2>
    <p className="muted">Credentials are encrypted on this Mac. Choose this provider in your assistant’s settings, then select a model in chat.</p>
    <h3>DeepSeek</h3>
    <p role="status">{state?.deepseek.connected ? 'Key verified and saved' : 'No key saved'}</p>
    <form onSubmit={(e) => { e.preventDefault(); const value = key.trim(); setKey(''); void run({ action: 'saveDeepseek', key: value }); }}>
      <label>API key<input type="password" autoComplete="off" spellCheck={false} maxLength={1000} value={key} disabled={busy} onChange={(e) => setKey(e.target.value)} /></label>
      <div className="actions"><button className="primary" disabled={busy || !key.trim() || !state}>Verify and save key</button>
      {state?.deepseek.connected && <button type="button" disabled={busy} onClick={() => void run({ action: 'disconnect', provider: 'deepseek' })}>Remove key</button>}</div>
    </form>
    <h3>Codex subscription</h3>
    <p role="status">{state?.codex.connected ? 'Subscription credentials saved' : 'Not signed in'}</p>
    <div className="actions"><button disabled={busy || !state || state.signingIn} onClick={() => void run({ action: 'startCodex' })}>{state?.codex.connected ? 'Replace sign-in' : 'Sign in with ChatGPT'}</button>
    {state?.codex.connected && <button disabled={busy} onClick={() => void run({ action: 'disconnect', provider: 'codex' })}>Disconnect</button>}</div>
    {state?.signingIn && <div>
      <p role="status">Finish signing in in your browser. Povondra will connect automatically. This request expires after five minutes.</p>
      <button type="button" onClick={() => void window.povondra.providers({ action: 'cancelCodex' }).then(accept).catch(() => setError('Could not cancel sign-in.'))}>Cancel sign-in</button>
    </div>}
    {state?.error && <p className="error" role="alert">{state.error}</p>}
    {busy && <p role="status">Connecting…</p>}
    {error && <p className="error" role="alert">{error} {!state && <button disabled={busy} onClick={() => void run({ action: 'status' })}>Retry</button>}</p>}
  </>;
}
