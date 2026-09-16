import { useEffect, useRef, useState } from 'react';
import type { Assistant, Result, Snapshot } from '../shared/protocol';
import { ProviderSettings } from './provider-settings';
import { AppearancePreview } from './appearance-preview';
import { Companion, INITIAL_APPEARANCE } from './companion';

export function Settings() {
  const [section, setSection] = useState('Assistants');
  const [data, setData] = useState<Snapshot>();
  const [editing, setEditing] = useState<Assistant>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const saving = useRef(false);
  function accept(result: Result) {
    if ((result.revision ?? 0) < revision.current) return;
    revision.current = result.revision ?? 0;
    setData(result.snapshot);
  }
  async function load() {
    try { accept(await window.povondra.request({ method: 'snapshot' })); setError(''); }
    catch (e) { setError(String(e)); }
  }
  useEffect(() => {
    const unsubscribe = window.povondra.onState(accept);
    void load();
    return unsubscribe;
  }, []);
  return <main>
    <header><span className="avatar" aria-hidden="true">✿</span><h1>Settings</h1></header>
    <nav className="settings-navigation" aria-label="Settings sections">{['Assistants', 'Providers', 'Integrations'].map((name) =>
      <button key={name} aria-pressed={section === name} onClick={() => setSection(name)}>{name}</button>)}</nav>
    <section className="settings">
      {section === 'Assistants' && <>
        {editing ? <form onSubmit={async (event) => {
          event.preventDefault();
          if (saving.current) return;
          saving.current = true; setBusy(true); setError('');
          try {
            accept(await window.povondra.request({ method: 'saveAssistant', assistant: editing }));
            setEditing(undefined);
          } catch (e) { setError(String(e)); }
          finally { saving.current = false; setBusy(false); }
        }}>
          <h2>Your assistant</h2>
          <fieldset disabled={busy}>
            <label>Name<input required maxLength={80} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label>Provider<select value={editing.provider} onChange={(e) => setEditing({ ...editing, provider: e.target.value as Assistant['provider'] })}><option value="deepseek">DeepSeek</option><option value="codex">Codex subscription</option></select></label>
            <label>How should they help?<textarea rows={6} maxLength={16000} value={editing.instructions} onChange={(e) => setEditing({ ...editing, instructions: e.target.value })} /></label>
            <p className="muted">Connect your provider in the Providers section. Select the model in each conversation.</p>
            <AppearancePreview appearance={editing.appearance ?? INITIAL_APPEARANCE} onChange={(appearance) => setEditing({ ...editing, appearance })} />
            <div className="actions"><button type="button" onClick={() => setEditing(undefined)}>Cancel</button><button className="primary" disabled={!editing.name.trim()}>{busy ? 'Saving…' : 'Save assistant'}</button></div>
          </fieldset>
        </form> : <>
          <h2>Your companions</h2><p className="muted">Give each assistant a name and instructions. Choose who to chat with in the chat window.</p>
          {data?.assistants.map((assistant) => <div className="actions" key={assistant.id}><span className="saved-companion"><Companion appearance={assistant.appearance ?? INITIAL_APPEARANCE} paused /></span><p><strong>{assistant.name}</strong><br /><small>{assistant.provider === 'codex' ? 'Codex subscription' : 'DeepSeek'}</small></p><button onClick={() => setEditing({ ...assistant })}>Edit {assistant.name}</button></div>)}
          <button className="primary" disabled={!data} onClick={() => setEditing({ id: crypto.randomUUID(), name: '', provider: 'deepseek', instructions: '', appearance: { ...INITIAL_APPEARANCE } })}>Add assistant</button>
        </>}
      </>}
      <div hidden={section !== 'Providers'}><ProviderSettings /></div>
      {section === 'Integrations' && <><h2>Integrations</h2><p>MCP connections will be managed here, with access enabled separately for each assistant.</p><h3>cua.ai computer use</h3><p className="muted">Required for the MVP, not connected yet. Computer control will require explicit setup and consent.</p></>}
    </section>
    {error && <div className="error" role="alert">{error}{!data && <button onClick={() => void load()}>Retry connection</button>}</div>}
  </main>;
}
