import type { SVGProps } from 'react';

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function ChevronDown(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...stroke} {...props}><path d="m4 6.5 4 4 4-4" /></svg>;
}

export function Check(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...stroke} {...props}><path d="m3.5 8.5 3 3 6-7" /></svg>;
}

export function Plus(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" {...stroke} {...props}><path d="M8 3.5v9M3.5 8h9" /></svg>;
}

export function Gear(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" {...stroke} {...props}>
    <path d="M6.8 1.9a1.3 1.3 0 0 1 2.4 0l.17.5a1 1 0 0 0 1.36.55l.48-.22a1.3 1.3 0 0 1 1.7 1.7l-.22.48a1 1 0 0 0 .55 1.36l.5.17a1.3 1.3 0 0 1 0 2.4l-.5.17a1 1 0 0 0-.55 1.36l.22.48a1.3 1.3 0 0 1-1.7 1.7l-.48-.22a1 1 0 0 0-1.36.55l-.17.5a1.3 1.3 0 0 1-2.4 0l-.17-.5a1 1 0 0 0-1.36-.55l-.48.22a1.3 1.3 0 0 1-1.7-1.7l.22-.48a1 1 0 0 0-.55-1.36l-.5-.17a1.3 1.3 0 0 1 0-2.4l.5-.17a1 1 0 0 0 .55-1.36l-.22-.48a1.3 1.3 0 0 1 1.7-1.7l.48.22a1 1 0 0 0 1.36-.55Z" />
    <circle cx="8" cy="8" r="2.4" />
  </svg>;
}

export function Clock(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" {...stroke} {...props}><circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 1.5" /></svg>;
}

export function Zap(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" {...stroke} {...props}><path d="M8.8 1.8 3.9 8.6h3.2l-.9 5.6 4.9-6.8H7.9Z" /></svg>;
}

export function ArrowUp(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" {...stroke} {...props}><path d="M8 12.5v-9M4 7l4-3.5L12 7" /></svg>;
}

export function Stop(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...props} fill="currentColor"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" /></svg>;
}

export function Copy(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...stroke} {...props}><rect x="5.5" y="5.5" width="7" height="7" rx="1.5" /><path d="M10.5 5.5v-1A1.5 1.5 0 0 0 9 3H4.5A1.5 1.5 0 0 0 3 4.5V9A1.5 1.5 0 0 0 4.5 10.5h1" /></svg>;
}
