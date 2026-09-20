import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CuaState, McpState, McpServerState } from '@shared/protocol';
import { formatWeight, TOOL_SCHEMA_BUDGET } from '@shared/mcp';
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

interface ToolEntry { name: string; description: string }

// One connection card: name, status, master switch, optional actions, and the
// per-tool switch list. The built-in Cua Driver entry and every user-added
// connection render through it, so the whole view speaks one language.
function ConnectionCard({ name, subtitle, status, on, dotOn, switchDisabled, onToggle, headerActions, note, connected, tools, disabledTools, toolsDisabled, onToggleTool, toolWord, weight }: {
  name: string; subtitle?: string; status: string; on: boolean; dotOn: boolean; switchDisabled: boolean; onToggle: () => void;
  headerActions?: ReactNode; note?: ReactNode; connected: boolean; tools: ToolEntry[]; disabledTools: string[];
  toolsDisabled: boolean; onToggleTool: (tool: string, nextEnabled: boolean) => void; toolWord: string; weight?: number;
}) {
  const enabledCount = tools.length - disabledTools.length;
  return <div className="grid gap-2 rounded-xl border border-ink-3/25 px-3 py-2.5">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium">{name}</p>
        <p className="mt-0.5 inline-flex items-center gap-1.5 text-[12px] text-ink-2">
          <span className={`h-2 w-2 rounded-full ${dotOn ? 'bg-ok' : 'bg-ink-3/60'}`} aria-hidden="true" />
          {status}
        </p>
        {subtitle && <p className="mt-0.5 text-[11.5px] text-ink-3">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {headerActions}
        <Switch on={on} disabled={switchDisabled} onToggle={onToggle} label={`Use ${name}`} />
      </div>
    </div>
    {note}
    {connected && <>
      <p className="text-[12px] text-ink-3">{enabledCount} of {tools.length} {toolWord} available to Moki{weight ? ` · about ${formatWeight(weight)}` : ''}.</p>
      <ul className="grid max-h-56 gap-0.5 overflow-y-auto pr-1" aria-label={`${name} tools`}>
        {tools.map((tool) => {
          const enabled = !disabledTools.includes(tool.name);
          return <li key={tool.name} className={`flex items-center gap-3 rounded-lg px-2 py-1.5 transition-opacity ${enabled ? '' : 'opacity-55'}`}>
            <Switch on={enabled} disabled={toolsDisabled} onToggle={() => onToggleTool(tool.name, enabled)} label={`${enabled ? 'Disable' : 'Enable'} ${tool.name}`} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[12px] text-ink">{tool.name}</p>
              <p className="truncate text-[11.5px] text-ink-3">{tool.description.split('\n')[0] || 'No description'}</p>
            </div>
          </li>;
        })}
      </ul>
    </>}
  </div>;
}

// The Integrations view: the built-in Cua Driver connection plus every
// user-added app connection in one list. Both data sources load
// independently, so a slow Cua Driver never blocks the app list or vice
// versa; the agent already receives both as one merged toolset.
export function ConnectionsSettings() {
  const [cua, setCua] = useState<CuaState>();
  const [cuaBusy, setCuaBusy] = useState(false);
  const [cuaError, setCuaError] = useState('');
  const cuaLock = useRef(false);
  const [mcp, setMcp] = useState<McpState>();
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState('');
  const [signingIn, setSigningIn] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState('');
  const mcpLock = useRef(false);
  async function loadCua() {
    if (cuaLock.current) return;
    cuaLock.current = true; setCuaBusy(true); setCuaError('');
    try {
      const result = await window.moki.request({ method: 'cuaTools' });
      if (!result.cua) throw new Error('Cua Driver did not report a catalog.');
      setCua(result.cua);
    } catch (e) { setCuaError(e instanceof Error ? e.message : 'Connection failed.'); }
    finally { cuaLock.current = false; setCuaBusy(false); }
  }
  async function loadMcp() {
    if (mcpLock.current) return;
    mcpLock.current = true; setMcpBusy(true); setMcpError('');
    try {
      const result = await window.moki.request({ method: 'mcpTools' });
      if (!result.mcp) throw new Error('Connections did not report a catalog.');
      setMcp(result.mcp);
    } catch (e) { setMcpError(e instanceof Error ? e.message : 'Connection failed.'); }
    finally { mcpLock.current = false; setMcpBusy(false); }
  }
  useEffect(() => { void loadCua(); void loadMcp(); }, []);
  async function toggleCuaTool(tool: string, disabled: boolean) {
    if (pending) return;
    setPending(tool); setCuaError('');
    setCua((current) => current
      ? { ...current, disabled: disabled ? [...new Set([...current.disabled, tool])].sort() : current.disabled.filter((entry) => entry !== tool) }
      : current);
    try {
      const result = await window.moki.request({ method: 'cuaSetTool', tool, disabled });
      if (result.cua) setCua(result.cua);
    } catch (e) {
      setCuaError(e instanceof Error ? e.message : 'Could not save the change.');
      void loadCua();
    } finally { setPending(''); }
  }
  async function setCuaEnabled(enabled: boolean) {
    if (pending) return;
    setPending('cua'); setCuaError('');
    try {
      const result = await window.moki.request({ method: 'cuaSetEnabled', enabled });
      if (!result.cua) throw new Error('Cua Driver state was not returned.');
      setCua(result.cua);
      if (enabled) void loadCua(); // fetch the catalog when reconnecting
    } catch (e) {
      setCuaError(e instanceof Error ? e.message : 'Could not save the change.');
      void loadCua();
    } finally { setPending(''); }
  }
  async function setServer(server: string, enabled: boolean) {
    if (pending) return;
    setPending(server); setMcpError('');
    try {
      const result = await window.moki.request({ method: 'mcpSetServer', server, enabled });
      if (result.mcp) setMcp(result.mcp);
      if (enabled) void loadMcp(); // fetch the catalog when reconnecting
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : 'Could not save the change.');
      void loadMcp();
    } finally { setPending(''); }
  }
  async function toggleServerTool(server: string, tool: string, disabled: boolean) {
    if (pending) return;
    setPending(tool); setMcpError('');
    setMcp((current) => current ? {
      ...current,
      servers: current.servers.map((entry) => entry.name === server
        ? { ...entry, disabledTools: disabled ? [...new Set([...entry.disabledTools, tool])].sort() : entry.disabledTools.filter((name) => name !== tool) }
        : entry),
    } : current);
    try {
      const result = await window.moki.request({ method: 'mcpSetTool', server, tool, disabled });
      if (result.mcp) setMcp(result.mcp);
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : 'Could not save the change.');
      void loadMcp();
    } finally { setPending(''); }
  }
  async function addConnection() {
    if (pending) return;
    setPending('add'); setMcpError('');
    try {
      const result = await window.moki.request(kind === 'stdio'
        ? { method: 'mcpAddServer', name, kind, command }
        : { method: 'mcpAddServer', name, kind, url });
      if (result.mcp) setMcp(result.mcp);
      setAdding(false); setName(''); setCommand(''); setUrl('');
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : 'Could not add the connection.');
    } finally { setPending(''); }
  }
  async function remove(serverName: string) {
    if (pending) return;
    setPending(`remove:${serverName}`); setMcpError('');
    try {
      const result = await window.moki.request({ method: 'mcpRemoveServer', server: serverName });
      if (result.mcp) setMcp(result.mcp);
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : 'Could not remove the connection.');
      void loadMcp();
    } finally { setPending(''); }
  }
  // Browser sign-in runs in the app shell: Chrome opens, you approve, and the
  // token lands in the macOS keychain-backed store. Nothing is typed here.
  async function signIn(serverName: string) {
    if (pending) return;
    setPending(`signin:${serverName}`); setSigningIn(serverName); setMcpError('');
    try {
      await window.moki.mcpAuth({ action: 'signIn', server: serverName });
      await loadMcp();
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : 'Sign-in could not be completed.');
    } finally { setSigningIn(''); setPending(''); }
  }
  async function signOut(serverName: string) {
    if (pending) return;
    setPending(`signout:${serverName}`); setMcpError('');
    try {
      await window.moki.mcpAuth({ action: 'signOut', server: serverName });
      await loadMcp();
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : 'Could not sign out.');
    } finally { setPending(''); }
  }
  const servers = mcp?.servers ?? [];
  // Plan 18: the same budget the reply turn enforces, surfaced as plain
  // guidance before a send ever fails.
  const totalWeight = (cua?.connected ? cua.weight : 0) + servers.reduce((sum, server) => sum + (server.connected ? server.weight : 0), 0);
  const overBudget = totalWeight > TOOL_SCHEMA_BUDGET;
  const cuaStatus = !cua ? (cuaBusy ? 'Checking…' : 'Not connected')
    : !cua.enabled ? 'Off'
    : cua.connected ? `Connected · ${cua.version || 'unknown version'}`
    : 'Not connected';
  return <div className="grid gap-3">
    <Panel className="grid gap-3">
      {overBudget && <p className="text-[12.5px] text-ink-2" role="note">Many tools are connected. Moki loads the largest connections on demand, which adds a small step when it uses them. Turning off connections you rarely use keeps replies quickest.</p>}
      {mcp && servers.length === 0 && !cua && <p className="text-[12.5px] text-ink-2" role="status">Checking connections…</p>}
      <div className="grid gap-3">
        <ConnectionCard
          name="Cua Driver"
          subtitle="Computer-use tools on this Mac"
          status={cuaStatus}
          on={cua?.enabled ?? true}
          dotOn={!!cua?.enabled && !!cua.connected}
          switchDisabled={!cua || !!pending}
          onToggle={() => void setCuaEnabled(!(cua?.enabled ?? true))}
          connected={!!cua?.enabled && !!cua.connected}
          tools={cua?.tools ?? []}
          disabledTools={cua?.disabled ?? []}
          toolsDisabled={!!pending}
          onToggleTool={(tool, enabled) => void toggleCuaTool(tool, enabled)}
          toolWord="tools"
          weight={cua?.weight ?? 0}
          note={cua && !cua.enabled
            ? <p className="text-[12.5px] text-ink-2">Moki is disconnected from Cua Driver. The driver is never contacted and its tools stay hidden from the agent. Your per-tool filters are kept for when you reconnect.</p>
            : cua?.enabled && !cua.connected
              ? <p className="text-[12.5px] text-ink-2">{cua.error || 'Cua Driver is not reachable. Install it from cua.ai, make sure CuaDriver is running, and retry.'}</p>
              : null}
        />
        {servers.map((server) => <ServerCard key={server.name} server={server} pending={pending} signingIn={signingIn} mcpBusy={mcpBusy} onSetServer={setServer} onToggleTool={toggleServerTool} onRemove={remove} onSignIn={signIn} onSignOut={signOut} onRetry={loadMcp} />)}
      </div>
      {mcp && servers.length === 0 && <p className="text-[12.5px] text-ink-2">No app connections yet. Moki ships with none by design; add one below and control everything it can do.</p>}
      {mcp?.diagnostics.map((diagnostic) => <p key={diagnostic} className="text-[12px] text-ink-2" role="note">{diagnostic}</p>)}
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
              <Input id="mcp-add-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.pipedream.net" />
            </Field>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={!!pending} onClick={() => { setAdding(false); setMcpError(''); }}>Cancel</Button>
          <Button size="sm" disabled={!!pending} onClick={() => void addConnection()}>{pending === 'add' ? 'Adding…' : 'Add connection'}</Button>
        </div>
      </div> : <div>
        <Button variant="secondary" size="sm" disabled={!!pending} onClick={() => setAdding(true)}>+ Add connection</Button>
      </div>}
    </Panel>
    {cuaError && <Banner action={<Button variant="secondary" size="sm" disabled={cuaBusy} onClick={() => void loadCua()}>Retry</Button>}>{cuaError}</Banner>}
    {mcpError && <Banner action={<Button variant="secondary" size="sm" disabled={mcpBusy} onClick={() => void loadMcp()}>Retry</Button>}>{mcpError}</Banner>}
  </div>;
}

// A user-added connection: everything ConnectionCard shows plus the Sign in /
// Sign out and Remove actions only user connections get.
function ServerCard({ server, pending, signingIn, mcpBusy, onSetServer, onToggleTool, onRemove, onSignIn, onSignOut, onRetry }: {
  server: McpServerState; pending: string; signingIn: string; mcpBusy: boolean;
  onSetServer: (server: string, enabled: boolean) => Promise<void>;
  onToggleTool: (server: string, tool: string, disabled: boolean) => Promise<void>;
  onRemove: (server: string) => Promise<void>;
  onSignIn: (server: string) => Promise<void>;
  onSignOut: (server: string) => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const status = !server.enabled ? 'Off'
    : signingIn === server.name ? 'Waiting for you to finish signing in…'
    : server.connected ? `Connected · ${server.tools.length} tools${server.stale ? ' · last known' : ''}`
    : server.needsAuth ? 'Sign in required'
    : server.error ? 'Not connected'
    : 'Connecting…';
  const needsAuthNote = server.enabled && !server.connected && server.needsAuth && <div className="flex items-start justify-between gap-2">
    <p className="text-[12.5px] text-ink-2">{server.error || 'Sign in to use this connection.'} Sign-in opens your browser and is stored in your Mac's keychain.</p>
    <Button size="sm" disabled={!!pending} onClick={() => void onSignIn(server.name)}>{signingIn === server.name ? 'Waiting…' : 'Sign in'}</Button>
  </div>;
  const errorNote = server.enabled && !server.connected && !server.needsAuth && server.error && <div className="flex items-start justify-between gap-2">
    <p className="text-[12.5px] text-ink-2">{server.error}</p>
    <div className="flex shrink-0 items-center gap-1.5">
      {server.transport === 'http' && !server.signedIn && <button type="button" onClick={() => void onSignIn(server.name)} disabled={mcpBusy || !!pending} className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-3 transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-45">{signingIn === server.name ? 'Waiting…' : 'Sign in'}</button>}
      <button type="button" onClick={() => void onRetry()} disabled={mcpBusy || !!pending} className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-3 transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-45">Retry</button>
    </div>
  </div>;
  const staleNote = server.enabled && server.connected && server.stale && <p className="text-[12px] text-ink-3">This connection could not be reached just now. Moki is using its last known actions.</p>;
  return <ConnectionCard
    name={server.name}
    status={status}
    on={server.enabled}
    dotOn={server.enabled && server.connected}
    switchDisabled={!!pending}
    onToggle={() => void onSetServer(server.name, !server.enabled)}
    connected={server.enabled && server.connected}
    tools={server.tools}
    disabledTools={server.disabledTools}
    toolsDisabled={!!pending}
    onToggleTool={(tool, enabled) => void onToggleTool(server.name, tool, enabled)}
    toolWord="actions"
    weight={server.weight}
    headerActions={<>
      {server.transport === 'http' && server.signedIn && server.enabled && <button type="button" onClick={() => void onSignOut(server.name)} disabled={!!pending} className="cursor-pointer rounded-md px-1.5 py-1 text-[11.5px] text-ink-3 transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-45">Sign out</button>}
      <button type="button" onClick={() => void onRemove(server.name)} disabled={!!pending} aria-label={`Remove ${server.name}`} className="cursor-pointer rounded-md px-1.5 py-1 text-[11.5px] text-ink-3 transition-colors hover:text-danger disabled:pointer-events-none disabled:opacity-45">Remove</button>
    </>}
    note={<>{needsAuthNote}{errorNote}{staleNote}</>}
  />;
}
