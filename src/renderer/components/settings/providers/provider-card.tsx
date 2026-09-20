import type { ReactNode } from 'react';
import { Panel } from '@renderer/components/ui/panel';
import { cn } from '@renderer/components/ui/cn';

export function StatusDot({ on, label }: { on: boolean; label: string }) {
  return <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-ink-2">
    <span className={cn('h-2 w-2 rounded-full', on ? 'bg-ok' : 'bg-ink-3/60')} aria-hidden="true" />
    {label}
  </span>;
}

/** Shared shell for every provider connection card so the Providers section reads as one list. */
export function ProviderCard({ name, description, connected, statusLabel, children, className }: {
  name: ReactNode;
  description?: ReactNode;
  connected: boolean;
  statusLabel: string;
  children: ReactNode;
  className?: string;
}) {
  return <Panel className={cn('grid gap-3', className)}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[13.5px] font-semibold">{name}</h3>
        {description && <p className="mt-0.5 text-[12px] text-ink-3">{description}</p>}
      </div>
      <StatusDot on={connected} label={statusLabel} />
    </div>
    {children}
  </Panel>;
}
