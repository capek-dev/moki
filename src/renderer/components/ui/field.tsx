import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@renderer/components/ui/cn';

export function Field({ label, htmlFor, hint, children, className }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-1.5', className)}>
    <label htmlFor={htmlFor} className="text-[11px] font-medium text-ink-2">{label}</label>
    {children}
    {hint && <p className="text-[12px] text-ink-3">{hint}</p>}
  </div>;
}

const control = 'w-full rounded-lg border border-line bg-surface-2 px-2.5 text-[13px] text-ink transition-colors placeholder:text-ink-3 hover:border-line-strong focus:border-accent-line focus:ring-2 focus:ring-accent-soft focus:outline-none disabled:opacity-50';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(control, 'h-8', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(control, 'min-h-24 resize-y p-2.5 leading-relaxed', className)} {...props} />;
}
