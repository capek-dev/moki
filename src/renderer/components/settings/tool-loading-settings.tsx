import { useEffect, useRef, useState } from 'react';
import type { ToolLoadingCommand, ToolLoadingState } from '@shared/tool-loading';
import { Panel } from '@renderer/components/ui/panel';
import { Button } from '@renderer/components/ui/button';
import { Field, Input } from '@renderer/components/ui/field';

export function ToolLoadingSettings() {
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
    void window.moki.toolLoading({ action: 'status' }).then(next => { if (active) accept(next); }, () => { if (active) setError('Cannot read smart-loading settings.'); });
    return () => { active = false; unsubscribe(); };
  }, []);
  async function save(command: ToolLoadingCommand) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { accept(await window.moki.toolLoading(command)); setKey(''); setNotice(command.action === 'disconnect' ? 'Key removed. Smart loading is off.' : 'Saved. Applies to your next message. The key is checked on the next selection request.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save settings.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <Panel className="mt-3 grid gap-3">
    <h2 className="text-[15px] font-semibold">Smart tool loading (experimental)</h2>
    <p className="text-[13px] text-ink-2">Use TypeSafe Jev to load likely tools first. Other enabled tools remain searchable. Sends up to 8,000 characters of your message, 2,000 of recent conversation, and tool names to TypeSafe. Tool descriptions, parameter schemas and attachments are not sent to TypeSafe. Without Jev, a names-only index (up to 60 KB) is loaded and tools are discovered through search.</p>
    <form onSubmit={event => { event.preventDefault(); void save({ action: 'save', enabled, maxDirect: Number(maximum), ...(key.trim() ? { key: key.trim() } : {}) }); }}>
      <fieldset disabled={busy || !state} className="grid gap-3">
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Enable smart loading</label>
        <Field label={state?.configured ? 'TypeSafe API key (saved, enter to replace)' : 'TypeSafe API key'} htmlFor="typesafe-key">
          <Input id="typesafe-key" type="password" autoComplete="off" maxLength={1000} value={key} onChange={event => setKey(event.target.value)} />
        </Field>
        <Field label="Maximum directly loaded tools (0 means search only)" htmlFor="tool-maximum">
          <Input id="tool-maximum" type="number" min={0} max={64} step={1} required value={maximum} onChange={event => setMaximum(event.target.value)} />
        </Field>
        <p className="text-[12px] text-ink-3">Selection names and fallback status appear in the terminal running Moki under “tool-selection”. Keys and message text are not logged.</p>
        <div className="flex gap-2"><Button type="submit" variant="primary">{busy ? 'Saving…' : 'Save smart loading'}</Button>
          {state?.configured && <Button onClick={() => void save({ action: 'disconnect' })}>Remove key</Button>}</div>
      </fieldset>
    </form>
    {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    {notice && <p role="status" className="text-[13px] text-ink-2">{notice}</p>}
  </Panel>;
}
