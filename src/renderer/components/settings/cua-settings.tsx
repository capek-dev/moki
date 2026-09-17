import { useEffect, useRef, useState } from 'react';
import type { CuaState } from '@shared/protocol';
import { Button } from '@renderer/components/ui/button';
import { Banner, Panel } from '@renderer/components/ui/panel';

function Switch({ on, disabled, onToggle, label }: { on: boolean; disabled?: boolean; onToggle: () => void; label: string }) {
  return <button
    type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onToggle}
    className={`relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full transition-colors duration-150 disabled:pointer-events-none disabled:opacity-45 ${on ? 'bg-accent' : 'bg-ink-3/40'}`}>
    <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-all duration-150 ${on ? 'left-[16px]' : 'left-[2px]'}`} aria-hidden="true" />
  </button>;
}

// Lists the local Cua Driver MCP catalog. The master switch disconnects the
// integration entirely: while off, Moki never contacts the driver and the agent
// gets none of its tools. Per-tool switches filter individual tools; both the
// master state and the filters persist across restarts.
export function CuaSettings() {
  const [state, setState] = useState<CuaState>();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  async function load() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await window.moki.request({ method: 'cuaTools' });
      if (!result.cua) throw new Error('Cua Driver did not report a catalog.');
      setState(result.cua);
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection failed.'); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function toggle(name: string, disabled: boolean) {
    if (pending) return;
    setPending(name); setError('');
    setState((current) => current
      ? { ...current, disabled: disabled ? [...new Set([...current.disabled, name])].sort() : current.disabled.filter((entry) => entry !== name) }
      : current);
    try {
      const result = await window.moki.request({ method: 'cuaSetTool', tool: name, disabled });
      if (result.cua) setState(result.cua);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the change.');
      void load();
    } finally { setPending(''); }
  }
  async function setIntegration(enabled: boolean) {
    if (pending) return;
    setPending('integration'); setError('');
    try {
      const result = await window.moki.request({ method: 'cuaSetEnabled', enabled });
      if (!result.cua) throw new Error('Cua Driver state was not returned.');
      setState(result.cua);
      if (enabled) void load(); // fetch the catalog when reconnecting
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the change.');
      void load();
    } finally { setPending(''); }
  }
  const integrationOn = state?.enabled ?? true;
  const connected = state?.connected ?? false;
  const enabledCount = state ? state.tools.length - state.disabled.length : 0;
  const status = !state ? (busy ? 'Checking…' : 'Not connected')
    : !state.enabled ? 'Off'
    : connected ? `Connected · ${state.version || 'unknown version'}`
    : 'Not connected';
  return <div className="grid gap-3">
    <Panel className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[13.5px] font-semibold">Cua Driver</h3>
          <p className="mt-0.5 text-[12.5px] text-ink-3">Computer-use tools over a local MCP connection.</p>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] text-ink-2">
            <span className={`h-2 w-2 rounded-full ${integrationOn && connected ? 'bg-ok' : 'bg-ink-3/60'}`} aria-hidden="true" />
            {status}
          </span>
          <Switch on={integrationOn} disabled={!state || !!pending} onToggle={() => void setIntegration(!integrationOn)} label="Use Cua Driver" />
        </div>
      </div>
      {!state && !error && busy && <p className="text-[12px] text-ink-3" role="status">Checking Cua Driver…</p>}
      {state && !state.enabled && <p className="text-[12.5px] text-ink-2">Moki is disconnected from Cua Driver. The driver is never contacted and its tools stay hidden from the agent. Your per-tool filters are kept for when you reconnect.</p>}
      {state?.enabled && !state.connected && <p className="text-[12.5px] text-ink-2">{state.error || 'Cua Driver is not reachable. Install it from cua.ai, make sure CuaDriver is running, and retry.'}</p>}
      {state?.enabled && state.connected && <>
        <p className="text-[12.5px] text-ink-3">{enabledCount} of {state.tools.length} tools available to the agent. Disabled tools are hidden from Moki.</p>
        <ul className="grid max-h-72 gap-0.5 overflow-y-auto pr-1" aria-label="Cua Driver tools">
          {state.tools.map((tool) => {
            const enabled = !state.disabled.includes(tool.name);
            return <li key={tool.name} className={`flex items-center gap-3 rounded-lg px-2 py-1.5 transition-opacity ${enabled ? '' : 'opacity-55'}`}>
              <Switch on={enabled} disabled={!!pending} onToggle={() => void toggle(tool.name, enabled)} label={`${enabled ? 'Disable' : 'Enable'} ${tool.name}`} />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[12px] text-ink">{tool.name}</p>
                <p className="truncate text-[11.5px] text-ink-3">{tool.description.split('\n')[0] || 'No description'}</p>
              </div>
            </li>;
          })}
        </ul>
      </>}
    </Panel>
    {error && <Banner action={<Button variant="secondary" size="sm" disabled={busy} onClick={() => void load()}>Retry</Button>}>{error}</Banner>}
  </div>;
}
