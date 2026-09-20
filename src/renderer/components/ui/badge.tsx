import type { ComponentProps } from 'react';
import { cn } from '@renderer/components/ui/cn';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

const tones: Record<Tone, string> = {
  neutral: 'bg-hover text-ink-2',
  ok: 'bg-[color-mix(in_oklab,var(--ok)_16%,transparent)] text-ok',
  warn: 'bg-[color-mix(in_oklab,var(--warn)_18%,transparent)] text-warn',
  danger: 'bg-danger-soft text-danger',
  accent: 'bg-accent-soft text-ink',
};

export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: Tone }) {
  return <span className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-px text-[11px] font-medium leading-4', tones[tone], className)} {...props} />;
}
