import { useEffect, useRef, useState } from 'react';
import type { McpState } from '@shared/protocol';
import { Button } from '@renderer/components/ui/button';
import { Banner, Panel } from '@renderer/components/ui/panel';

function Switch({ on, disabled, onToggle, label }: { on: boolean; disabled?: boolean; onToggle: () => void; label: string }) {
  return <button
    type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onToggle}
    className={`relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full transition-colors duration-150 disabled:pointer-events-none disabled:opacity-45 ${on ? 'bg-accent' : 'bg-ink-3/40'}`}>
    <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-all duration-150 ${on ? 'left-[16px]' : 'left-[2px]'}`} aria-hidden="true" />
  </button>;
}

// Lists user-added app connections (MCP servers). Slice 1: connections come
// from the local config file; this view shows each connection's status and
// lets the user turn connections and individual tools on or off. Toggles write
// back to the file, so everything stays user-owned.
export function McpSettings() {
  const [state, setState] = useState<McpState>();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  async function load() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await window.moki.request({ method: 'mcpTools' });
      if (!result.mcp) throw new Error('Connections did not report a catalog.');
      setState(result.mcp);
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection failed.'); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function setServer(server: string, enabled: boolean) {
    if (pending) return;
    setPending(server); setError('');
    try {
      const result = await window.moki.request({ method: 'mcpSetServer', server, enabled });
      if (result.mcp) setState(result.mcp);
      if (enabled) void load(); // fetch the catalog when reconnecting
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the change.');
      void load();
    } finally { setPending(''); }
  }
  async function toggleTool(server: string, tool: string, disabled: boolean) {
    if (pending) return;
    setPending(tool); setError('');
    setState((current) => current ? {
      ...current,
      servers: current.servers.map((entry) => entry.name === server
        ? { ...entry, disabledTools: disabled ? [...new Set([...entry.disabledTools, tool])].sort() : entry.disabledTools.filter((name) => name !== tool) }
        : entry),
    } : current);
    try {
      const result = await window.moki.request({ method: 'mcpSetTool', server, tool, disabled });
      if (result.mcp) setState(result.mcp);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the change.');
      void load();
    } finally { setPending(''); }
  }
  const servers = state?.servers ?? [];
  return <div className="grid gap-3">
    <Panel className="grid gap-3">
      <div>
        <h3 className="text-[13.5px] font-semibold">App connections</h3>
        <p className="mt-0.5 text-[12.5px] text-ink-3">Apps you connect give Moki new abilities. You control every connection and every action.</p>
      </div>
      {!state && !error && busy && <p className="text-[12px] text-ink-3" role="status">Checking connections…</p>}
      {state && servers.length === 0 && <p className="text-[12.5px] text-ink-2">No app connections yet. Moki ships with none by design; add one from the app catalog when it arrives, or drop a connection file in your Moki folder if you know how.</p>}
      {state?.diagnostics.map((diagnostic) => <p key={diagnostic} className="text-[12px] text-ink-2" role="note">{diagnostic}</p>)}
      <div className="grid gap-3">
        {servers.map((server) => {
          const enabledCount = server.tools.length - server.disabledTools.length;
          const status = !server.enabled ? 'Off'
            : server.connected ? `Connected · ${server.tools.length} tools`
            : server.error ? 'Not connected'
            : 'Connecting…';
          return <div key={server.name} className="grid gap-2 rounded-xl border border-ink-3/25 px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium">{server.name}</p>
                <p className="mt-0.5 inline-flex items-center gap-1.5 text-[12px] text-ink-2">
                  <span className={`h-2 w-2 rounded-full ${server.enabled && server.connected ? 'bg-ok' : 'bg-ink-3/60'}`} aria-hidden="true" />
                  {status}
                </p>
              </div>
              <Switch on={server.enabled} disabled={!!pending} onToggle={() => void setServer(server.name, !server.enabled)} label={`Use ${server.name}`} />
            </div>
            {server.enabled && !server.connected && server.error && <p className="text-[12.5px] text-ink-2">{server.error}</p>}
            {server.enabled && server.connected && <>
              <p className="text-[12px] text-ink-3">{enabledCount} of {server.tools.length} actions available to Moki.</p>
              <ul className="grid max-h-56 gap-0.5 overflow-y-auto pr-1" aria-label={`${server.name} tools`}>
                {server.tools.map((tool) => {
                  const enabled = !server.disabledTools.includes(tool.name);
                  return <li key={tool.name} className={`flex items-center gap-3 rounded-lg px-2 py-1.5 transition-opacity ${enabled ? '' : 'opacity-55'}`}>
                    <Switch on={enabled} disabled={!!pending} onToggle={() => void toggleTool(server.name, tool.name, enabled)} label={`${enabled ? 'Disable' : 'Enable'} ${tool.name}`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[12px] text-ink">{tool.name}</p>
                      <p className="truncate text-[11.5px] text-ink-3">{tool.description.split('\n')[0] || 'No description'}</p>
                    </div>
                  </li>;
                })}
              </ul>
            </>}
          </div>;
        })}
      </div>
    </Panel>
    {error && <Banner action={<Button variant="secondary" size="sm" disabled={busy} onClick={() => void load()}>Retry</Button>}>{error}</Banner>}
  </div>;
}
