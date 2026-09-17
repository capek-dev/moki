import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@renderer/components/ui/button';
import { Check } from '@renderer/components/ui/icons';

type CopyState = 'idle' | 'copying' | 'copied' | 'failed';

export function CopyButton({ text, label, icon, write = (value) => window.moki.copyText(value) }: {
  text: string;
  label: string;
  icon?: ReactNode;
  write?: (text: string) => Promise<void>;
}) {
  const [state, setState] = useState<CopyState>('idle');
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    setState('idle'); pending.current = false;
    return () => { generation.current++; };
  }, [text]);
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  async function copy() {
    if (pending.current) return;
    pending.current = true;
    const current = generation.current;
    setState('copying');
    try {
      await write(text);
      if (generation.current === current) setState('copied');
    } catch {
      if (generation.current === current) setState('failed');
    } finally {
      if (generation.current === current) pending.current = false;
    }
  }
  const status = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Try again.' : state === 'copying' ? 'Copying…' : '';
  return <span className="inline-flex items-center gap-1">
    <Button variant="ghost" size={icon ? 'icon-sm' : 'sm'} disabled={state === 'copying'} aria-label={label} title={status || label} onClick={() => void copy()}>{icon ? state === 'copied' ? <Check /> : icon : label}</Button>
    <span role="status" className={icon ? 'sr-only' : 'text-[11px] text-ink-3'}>{status}</span>
  </span>;
}
