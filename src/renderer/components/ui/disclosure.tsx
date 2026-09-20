import { useId, useState, type ReactNode } from 'react';
import { cn } from '@renderer/components/ui/cn';

/** Collapsible section header with a rotating chevron. Body only mounts while open, so heavy lists stay lazy. */
export function Disclosure({ title, badge, description, defaultOpen = false, onOpenChange, children, className }: {
  title: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  function toggle() {
    const next = !open;
    setOpen(next);
    onOpenChange?.(next);
  }
  return <div className={cn('grid gap-1.5', className)}>
    <button
      type="button"
      aria-expanded={open}
      aria-controls={bodyId}
      onClick={toggle}
      className="flex min-h-7 items-center gap-1.5 rounded-lg px-1 text-left text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" className={cn('h-3 w-3 shrink-0 text-ink-3 transition-transform duration-150', open && 'rotate-90')} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 4 4 4-4 4" /></svg>
      <span className="min-w-0">{title}</span>
      {badge}
    </button>
    {open && <div id={bodyId} className="grid gap-2 pl-[18px]">
      {description && <p className="text-[12px] text-ink-3">{description}</p>}
      {children}
    </div>}
  </div>;
}
