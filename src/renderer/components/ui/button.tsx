import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@renderer/components/ui/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'icon' | 'icon-sm' | 'round' | 'round-sm';

// Rounding lives in sizes, not base: the round size must not compete with a
// base rounded-lg (equal-specificity classes resolve by stylesheet order, not
// class order, so a conflict renders unpredictably).
const base = 'inline-flex cursor-pointer select-none items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-all duration-150 active:scale-[.98] disabled:pointer-events-none disabled:opacity-45';

const variants: Record<Variant, string> = {
  // Flat fills: drop shadows add visual height a small circle cannot afford.
  primary: 'bg-accent text-accent-ink hover:bg-accent-deep',
  secondary: 'glass text-ink hover:border-line-strong',
  ghost: 'text-ink-2 hover:bg-hover hover:text-ink',
  danger: 'bg-danger text-white hover:brightness-110',
};

const sizes: Record<Size, string> = {
  sm: 'h-7 rounded-lg px-2.5 text-[12.5px]',
  md: 'h-8 rounded-lg px-3.5 text-[13px]',
  icon: 'h-8 w-8 rounded-lg',
  'icon-sm': 'h-7 w-7 rounded-lg',
  round: 'h-7 w-7 rounded-full',
  'round-sm': 'h-6 w-6 rounded-full',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({ variant = 'secondary', size = 'md', className, type, ...props }: ButtonProps) {
  return <button type={type ?? 'button'} className={cn(base, variants[variant], sizes[size], className)} {...props} />;
}
