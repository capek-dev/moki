import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import type { ReactNode } from 'react';

export function Segmented({ value, onChange, options, 'aria-label': ariaLabel }: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: ReactNode }[];
  'aria-label': string;
}) {
  return <ToggleGroupPrimitive.Root
    type="single"
    value={value}
    onValueChange={(next) => { if (next) onChange(next); }}
    aria-label={ariaLabel}
    className="glass inline-flex h-8 items-center gap-0.5 rounded-lg p-0.5">
    {options.map((option) => <ToggleGroupPrimitive.Item
      key={option.value}
      value={option.value}
      className="flex h-7 cursor-pointer items-center rounded-[7px] px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:text-ink data-state=on:bg-surface-solid data-state=on:text-ink data-state=on:shadow-[0_1px_3px_rgb(15_15_20/.14),inset_0_1px_0_rgb(255_255_255/.5)]">
      {option.label}
    </ToggleGroupPrimitive.Item>)}
  </ToggleGroupPrimitive.Root>;
}
