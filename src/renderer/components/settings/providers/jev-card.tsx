import { useEffect, useRef, useState } from 'react';
import type { ToolLoadingCommand, ToolLoadingState } from '@shared/tool-loading';
import { Button } from '@renderer/components/ui/button';
import { Field, Input } from '@renderer/components/ui/field';
import { Disclosure } from '@renderer/components/ui/disclosure';
import { ProviderCard } from './provider-card';

/**
 * The TypeSafe Jev connection. One key powers the smart layer of the app:
 * tool loading, memory routing, and the learned descriptors routing depends on.
 * Falls back to local search and basic recall when absent, never blocks chat.
 */
export function JevCard() {
  const [state, setState] = useState<ToolLoadingState>();
  const [enabled, setEnabled] = useState(false);
  const [maximum, setMaximum] = useState('12');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  function accept(next: ToolLoadingState) { setState(next); setEnabled(next.enabled); setMaximum(String(next.maxDirect)); }
  useEffect(() => {
    let active = true;
    const unsubscribe = window.moki.onToolLoading(next => { if (active) accept(next); });
    void window.moki.toolLoading({ action: 'status' }).then(next => { if (active) accept(next); }, () => { if (active) setError('Cannot read the Jev connection.'); });
    return () => { active = false; unsubscribe(); };
  }, []);
  async function save(command: ToolLoadingCommand) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { accept(await window.moki.toolLoading(command)); setKey(''); setNotice(command.action === 'disconnect' ? 'Key removed. Smart loading is off.' : 'Saved. Applies to your next message. The key is checked on the next selection request.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save settings.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <ProviderCard
    name="TypeSafe Jev"
    description="One connection for Moki's smart routing."
    connected={!!state?.configured}
    statusLabel={state?.configured ? 'Key verified and saved' : 'No key saved'}
  >
    <ul className="grid gap-1.5">
      <li className="flex items-start gap-2 text-[12px]">
        <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
        <span><strong>Smart tool loading.</strong> <span className="text-ink-3">Likely tools load first; every enabled tool stays searchable.</span></span>
      </li>
      <li className="flex items-start gap-2 text-[12px]">
        <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
        <span><strong>Memory routing.</strong> <span className="text-ink-3">Recall follows your topics and entities instead of plain text search.</span></span>
      </li>
      <li className="flex items-start gap-2 text-[12px]">
        <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
        <span><strong>Learning.</strong> <span className="text-ink-3">Before a learned fact is saved, Jev checks the claim against the user message it cites.</span></span>
      </li>
    </ul>
    <form onSubmit={event => { event.preventDefault(); void save({ action: 'save', enabled, maxDirect: Number(maximum), ...(key.trim() ? { key: key.trim() } : {}) }); }}>
      <fieldset disabled={busy || !state} className="grid gap-3">
        <Field label={state?.configured ? 'TypeSafe API key (saved, enter to replace)' : 'TypeSafe API key'} htmlFor="typesafe-key">
          <Input id="typesafe-key" type="password" autoComplete="off" spellCheck={false} maxLength={1000} value={key} onChange={event => setKey(event.target.value)} />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Enable smart tool loading</label>
          <Field label="Max tools loaded directly" htmlFor="tool-maximum">
            <Input id="tool-maximum" type="number" min={0} max={64} step={1} required value={maximum} onChange={event => setMaximum(event.target.value)} />
          </Field>
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary">{busy ? 'Saving…' : 'Save Jev settings'}</Button>
          {state?.configured && <Button onClick={() => void save({ action: 'disconnect' })}>Remove key</Button>}
        </div>
      </fieldset>
    </form>
    <Disclosure title="What is shared with TypeSafe">
      <p className="text-[12px] text-ink-3">Tool loading sends up to 8,000 characters of your message, 2,000 of recent conversation, and tool names. Tool descriptions, parameter schemas, and attachments are not sent. Memory routing sends the current request, bounded recent evidence, and bounded topic/entity descriptors. Learning verification sends the same bounded source excerpts and each proposed fact, so Jev can check the claim is supported; unsupported proposals are rejected before saving. If TypeSafe is unreachable, learning proceeds without the check. Without Jev, a names-only tool index (up to 60 KB) is loaded and tools are discovered through search; memory falls back to local basic recall.</p>
      <p className="text-[12px] text-ink-3">Selection names and fallback status appear in the terminal running Moki under “tool-selection”. Keys and message text are not logged.</p>
    </Disclosure>
    {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
    {notice && <p role="status" className="text-[12.5px] text-ink-2">{notice}</p>}
  </ProviderCard>;
}
