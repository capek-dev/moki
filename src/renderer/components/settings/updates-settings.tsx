import { useEffect, useState } from 'react';
import type { UpdaterState } from '@shared/updater';
import { Button } from '@renderer/components/ui/button';
import { Panel } from '@renderer/components/ui/panel';

function statusText(state: UpdaterState): string {
  switch (state.status) {
    case 'disabled': return state.message ?? 'Updates are available in signed release builds.';
    case 'checking': return 'Checking GitHub Releases for a newer version…';
    case 'available': return `Moki ${state.availableVersion} is available.`;
    case 'downloading': return `Downloading Moki ${state.availableVersion ?? ''}${state.percent === null ? '…' : ` · ${state.percent}%`}`;
    case 'downloaded': return `Moki ${state.availableVersion} is downloaded and ready.`;
    case 'up-to-date': return 'Moki is up to date.';
    case 'error': return state.message ?? 'The update check failed.';
    default: return 'Updates are checked automatically when Moki starts.';
  }
}

export function UpdatesSettings() {
  const [state, setState] = useState<UpdaterState>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const stop = window.moki.onUpdater(setState);
    void window.moki.updater('status').then((value) => { if (active) setState(value); });
    return () => { active = false; stop(); };
  }, []);
  const run = async (command: 'check' | 'download' | 'install') => {
    if (busy) return;
    setBusy(true);
    try { setState(await window.moki.updater(command)); }
    finally { setBusy(false); }
  };
  return <Panel className="grid gap-3">
    <div>
      <p className="text-[13px] font-medium">Moki {state?.currentVersion ?? '…'}</p>
      <p className="mt-1 text-[12.5px] text-ink-2" role="status">{state ? statusText(state) : 'Loading update status…'}</p>
    </div>
    <div className="flex flex-wrap gap-2">
      {state?.status === 'available' && <Button size="sm" disabled={busy} onClick={() => void run('download')}>{busy ? 'Starting…' : 'Download update'}</Button>}
      {state?.status === 'downloaded' && <Button size="sm" disabled={busy} onClick={() => void run('install')}>Restart to update</Button>}
      <Button variant="secondary" size="sm" disabled={busy || state?.status === 'checking' || state?.status === 'downloading' || state?.status === 'disabled'} onClick={() => void run('check')}>Check for updates</Button>
    </div>
    <p className="text-[12px] text-ink-3">Moki checks GitHub automatically. It will not download or restart until you choose to.</p>
  </Panel>;
}
