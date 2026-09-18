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

export function Capture(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" {...stroke} {...props}><path d="M5.5 2.5h-2a1 1 0 0 0-1 1v2m8-3h2a1 1 0 0 1 1 1v2m0 5v2a1 1 0 0 1-1 1h-2m-5 0h-2a1 1 0 0 1-1-1v-2" /><rect x="5" y="5" width="6" height="6" rx="1" /></svg>;
}

export function Close(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...stroke} {...props}><path d="m4 4 8 8m0-8-8 8" /></svg>;
}

export function Undo(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...stroke} {...props}><path d="M3.5 6.5h6a3 3 0 1 1 0 6H6" /><path d="M5.5 4 3 6.5 5.5 9" /></svg>;
}

export function Speaker(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" {...stroke} {...props}><path d="M8 2.5 5 5H3.5A1.5 1.5 0 0 0 2 6.5v3A1.5 1.5 0 0 0 3.5 11H5l3 2.5Z" /><path d="M10.8 5.7a3.2 3.2 0 0 1 0 4.6M12.7 3.9a5.8 5.8 0 0 1 0 8.2" /></svg>;
}

export function Mic(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" {...stroke} {...props}><rect x="6" y="2" width="4" height="7" rx="2" /><path d="M4.5 7.5a3.5 3.5 0 0 0 7 0M8 11v2.5" /></svg>;
}

export function Pencil(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...stroke} {...props}><path d="M11.2 2.7a1.7 1.7 0 0 1 2.4 2.4L6 12.7l-3.2.8.8-3.2Z" /></svg>;
}
