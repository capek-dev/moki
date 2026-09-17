import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';

export function Panel({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('glass rounded-2xl p-4 shadow-[var(--shadow-glass)]', className)} {...props} />;
}

export function Banner({ children, action, className, ...props }: ComponentProps<'div'> & { action?: ReactNode }) {
  return <div role="alert" className={cn('flex items-start justify-between gap-3 rounded-xl border border-[color-mix(in_oklab,var(--danger)_28%,transparent)] bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger', className)} {...props}>
    <span className="min-w-0 overflow-wrap-anywhere">{children}</span>
    {action}
  </div>;
}
