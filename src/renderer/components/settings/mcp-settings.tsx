import { useEffect, useRef, useState } from 'react';
import type { McpState } from '@shared/protocol';
import { Button } from '@renderer/components/ui/button';
import { Field, Input } from '@renderer/components/ui/field';
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
  const [signingIn, setSigningIn] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
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
  async function addConnection() {
    if (pending) return;
    setPending('add'); setError('');
    try {
      const result = await window.moki.request(kind === 'stdio'
        ? { method: 'mcpAddServer', name, kind, command }
        : { method: 'mcpAddServer', name, kind, url });
      if (result.mcp) setState(result.mcp);
      setAdding(false); setName(''); setCommand(''); setUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the connection.');
    } finally { setPending(''); }
  }
  async function remove(serverName: string) {
    if (pending) return;
    setPending(`remove:${serverName}`); setError('');
    try {
      const result = await window.moki.request({ method: 'mcpRemoveServer', server: serverName });
      if (result.mcp) setState(result.mcp);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the connection.');
      void load();
    } finally { setPending(''); }
  }
  // Browser sign-in runs in the app shell: Chrome opens, you approve, and the
  // token lands in the macOS keychain-backed store. Nothing is typed here.
  async function signIn(serverName: string) {
    if (pending) return;
    setPending(`signin:${serverName}`); setSigningIn(serverName); setError('');
    try {
      await window.moki.mcpAuth({ action: 'signIn', server: serverName });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in could not be completed.');
    } finally { setSigningIn(''); setPending(''); }
  }
  async function signOut(serverName: string) {
    if (pending) return;
    setPending(`signout:${serverName}`); setError('');
    try {
      await window.moki.mcpAuth({ action: 'signOut', server: serverName });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign out.');
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
      {state && servers.length === 0 && <p className="text-[12.5px] text-ink-2">No app connections yet. Moki ships with none by design; add one below and control everything it can do.</p>}
      {state?.diagnostics.map((diagnostic) => <p key={diagnostic} className="text-[12px] text-ink-2" role="note">{diagnostic}</p>)}
      <div className="grid gap-3">
        {servers.map((server) => {
          const enabledCount = server.tools.length - server.disabledTools.length;
          const status = !server.enabled ? 'Off'
            : signingIn === server.name ? 'Waiting for you to finish signing in…'
            : server.connected ? `Connected · ${server.tools.length} tools`
            : server.needsAuth ? 'Sign in required'
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
              <div className="flex shrink-0 items-center gap-2.5">
                {server.transport === 'http' && server.signedIn && server.enabled && <button type="button" onClick={() => void signOut(server.name)} disabled={!!pending} className="cursor-pointer rounded-md px-1.5 py-1 text-[11.5px] text-ink-3 transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-45">Sign out</button>}
                <Switch on={server.enabled} disabled={!!pending} onToggle={() => void setServer(server.name, !server.enabled)} label={`Use ${server.name}`} />
                <button type="button" onClick={() => void remove(server.name)} disabled={!!pending} aria-label={`Remove ${server.name}`} className="cursor-pointer rounded-md px-1.5 py-1 text-[11.5px] text-ink-3 transition-colors hover:text-danger disabled:pointer-events-none disabled:opacity-45">Remove</button>
              </div>
            </div>
            {server.enabled && !server.connected && server.needsAuth && <div className="flex items-start justify-between gap-2">
              <p className="text-[12.5px] text-ink-2">{server.error || 'Sign in to use this connection.'} Sign-in opens your browser and is stored in your Mac's keychain.</p>
              <Button size="sm" disabled={!!pending} onClick={() => void signIn(server.name)}>{signingIn === server.name ? 'Waiting…' : 'Sign in'}</Button>
            </div>}
            {server.enabled && !server.connected && !server.needsAuth && server.error && <div className="flex items-start justify-between gap-2">
              <p className="text-[12.5px] text-ink-2">{server.error}</p>
              <div className="flex shrink-0 items-center gap-1.5">
                {server.transport === 'http' && !server.signedIn && <button type="button" onClick={() => void signIn(server.name)} disabled={busy || !!pending} className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-3 transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-45">{signingIn === server.name ? 'Waiting…' : 'Sign in'}</button>}
                <button type="button" onClick={() => void load()} disabled={busy || !!pending} className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-3 transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-45">Retry</button>
              </div>
            </div>}
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
      {adding ? <div className="grid gap-2.5 rounded-xl border border-line px-3 py-2.5">
        <Field label="Name" htmlFor="mcp-add-name">
          <Input id="mcp-add-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Files" maxLength={64} />
        </Field>
        <Field label="Type">
          <div className="flex gap-1.5">
            <button type="button" onClick={() => setKind('stdio')} aria-pressed={kind === 'stdio'} className={`h-8 cursor-pointer rounded-lg border px-2.5 text-[12.5px] transition-colors ${kind === 'stdio' ? 'border-accent-line bg-accent-soft text-ink' : 'border-line bg-surface-2 text-ink-2 hover:border-line-strong'}`}>Runs on this Mac</button>
            <button type="button" onClick={() => setKind('http')} aria-pressed={kind === 'http'} className={`h-8 cursor-pointer rounded-lg border px-2.5 text-[12.5px] transition-colors ${kind === 'http' ? 'border-accent-line bg-accent-soft text-ink' : 'border-line bg-surface-2 text-ink-2 hover:border-line-strong'}`}>On the web</button>
          </div>
        </Field>
        {kind === 'stdio'
          ? <Field label="Command" htmlFor="mcp-add-command" hint="The program Moki starts, with its settings. Separate with spaces.">
              <Input id="mcp-add-command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Documents" />
            </Field>
          : <Field label="Web address" htmlFor="mcp-add-url" hint="The address the app gives you for connecting its tools.">
              <Input id="mcp-add-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.pipedream.com" />
            </Field>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={!!pending} onClick={() => { setAdding(false); setError(''); }}>Cancel</Button>
          <Button size="sm" disabled={!!pending} onClick={() => void addConnection()}>{pending === 'add' ? 'Adding…' : 'Add connection'}</Button>
        </div>
      </div> : <div>
        <Button variant="secondary" size="sm" disabled={!!pending} onClick={() => setAdding(true)}>+ Add connection</Button>
      </div>}
    </Panel>
    {error && <Banner action={<Button variant="secondary" size="sm" disabled={busy} onClick={() => void load()}>Retry</Button>}>{error}</Banner>}
  </div>;
}
