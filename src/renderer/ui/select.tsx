import * as SelectPrimitive from '@radix-ui/react-select';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';
import { Check, ChevronDown } from './icons';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

const triggerBase = 'flex min-w-0 cursor-pointer items-center justify-between gap-1.5 rounded-lg text-ink transition-colors disabled:cursor-default disabled:opacity-45';

/** Default field-style trigger. No width class: callers decide (a w-full here
    silently expands quiet triggers, e.g. the titlebar switcher, and eats the
    window-drag region). */
const triggerField = 'h-8 border border-line bg-surface-2 px-2.5 text-[13px] hover:border-line-strong focus:border-accent-line focus:ring-2 focus:ring-accent-soft focus:outline-none data-placeholder:text-ink-3';

/** Quiet chip for session controls living inside the composer. */
const triggerChip = 'h-6 w-auto shrink-0 gap-1 border border-transparent bg-transparent px-1.5 text-[11px] font-medium text-ink-3 hover:border-transparent hover:bg-hover hover:text-ink focus:ring-0 focus:outline-none';

export function SelectTrigger({ className, children, compact, ...props }: ComponentProps<typeof SelectPrimitive.Trigger> & { compact?: boolean }) {
  return <SelectPrimitive.Trigger
    className={cn(triggerBase, compact ? triggerChip : triggerField, className)}
    {...props}>
    <span className="flex min-w-0 items-center gap-1.5 truncate">{children}</span>
    <SelectPrimitive.Icon className="shrink-0 text-ink-3 transition-transform duration-200 data-[state=open]:rotate-180"><ChevronDown /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>;
}

export function SelectContent({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      position="popper"
      sideOffset={6}
      className={cn('z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-line bg-surface-solid p-1 shadow-[var(--shadow-glass)] backdrop-blur-2xl', className)}
      {...props}>
      <SelectPrimitive.Viewport className="grid gap-0.5">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>;
}

export function SelectItem({ className, children, hint, ...props }: ComponentProps<typeof SelectPrimitive.Item> & { hint?: ReactNode }) {
  return <SelectPrimitive.Item
    className={cn('flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] text-ink outline-none data-highlighted:bg-hover data-disabled:pointer-events-none data-disabled:opacity-40 data-state=checked:font-semibold data-state=checked:text-accent', className)}
    {...props}>
    <span className="grid w-3.5 shrink-0 place-items-center"><SelectPrimitive.ItemIndicator><Check /></SelectPrimitive.ItemIndicator></span>
    <SelectPrimitive.ItemText asChild><span className="min-w-0 flex-1 truncate">{children}</span></SelectPrimitive.ItemText>
    {hint && <span className="shrink-0 text-[11px] text-ink-3">{hint}</span>}
  </SelectPrimitive.Item>;
}

export interface SimpleSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: ReactNode; hint?: ReactNode; disabled?: boolean }[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  compact?: boolean;
  'aria-label'?: string;
  className?: string;
}

/** Labeled-value dropdown for the common case. Items cannot use empty values (Radix).
    Field selects fill their container; compact chips size to content. */
export function SimpleSelect({ value, onValueChange, options, placeholder, disabled, id, compact, className, ...props }: SimpleSelectProps) {
  return <Select value={value} onValueChange={onValueChange} disabled={disabled} {...props}>
    <SelectTrigger id={id} compact={compact} className={cn(compact ? undefined : 'w-full', className)}><SelectValue placeholder={placeholder} /></SelectTrigger>
    <SelectContent>
      {options.map((option) => <SelectItem key={option.value} value={option.value} hint={option.hint} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}
