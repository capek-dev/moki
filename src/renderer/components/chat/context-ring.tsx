import { formatTokens, type ContextEstimate, type ContextUsage } from '@shared/context';

function statusFor(percentage: number): 'normal' | 'warning' | 'critical' {
  if (percentage >= 60) return 'critical';
  if (percentage >= 40) return 'warning';
  return 'normal';
}

// Quiet context window indicator (the Prokop circle): a ring whose fill is the
// estimated share of the enforceable input budget, colored accent/warn/danger at
// 40/60 percent. Hover shows the breakdown tooltip.
export function ContextRing({ estimate, lastRequest, contextWindow, outputReserveTokens, modelName }: { estimate: ContextEstimate; lastRequest?: ContextUsage; contextWindow: number; outputReserveTokens: number; modelName: string }) {
  const totalTokens = estimate.totalTokens;
  const inputBudget = Math.max(0, contextWindow - outputReserveTokens);
  const percentage = inputBudget > 0 ? Math.min(100, Math.round((totalTokens / inputBudget) * 100)) : 0;
  const status = statusFor(percentage);
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const dashoffset = circumference * (1 - percentage / 100);
  const ringClass = percentage === 0
    ? 'text-ink-3/30'
    : status === 'critical' ? 'text-danger' : status === 'warning' ? 'text-warn' : 'text-accent';
  const rows = [
    ['Model', modelName],
    ['Context window', formatTokens(contextWindow)],
    ['Input budget', formatTokens(inputBudget)],
    ['Output reserve', formatTokens(outputReserveTokens)],
    ['Draft estimate (heuristic)', `${totalTokens.toLocaleString()} · ${percentage}%`],
    ['Draft instructions', estimate.systemTokens.toLocaleString()],
    ['Draft history text', estimate.textTokens.toLocaleString()],
    ['Draft screenshots', estimate.imageTokens.toLocaleString()],
    ['Last request (heuristic)', lastRequest ? `${lastRequest.estimate.totalTokens.toLocaleString()} · request ${lastRequest.requestNumber}` : 'Not sent'],
    ['Provider input (last request)', lastRequest?.providerReported?.inputTokens?.toLocaleString() ?? 'Not reported'],
    ['Messages included', `${estimate.includedMessages} of ${estimate.totalMessages}${estimate.truncated ? ' · capped' : ''}`],
  ] as const;
  return <div className="group relative">
    <button
      type="button"
      aria-label={`Context window usage: ${percentage}%`}
      className="flex cursor-pointer items-center">
      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r={radius} stroke="currentColor" className="text-ink-3/25" strokeWidth="3" />
        <circle cx="10" cy="10" r={radius} stroke="currentColor" className={ringClass} strokeWidth="3" strokeDasharray={circumference} strokeDashoffset={dashoffset} strokeLinecap="round" transform="rotate(-90 10 10)" style={{ transition: 'stroke-dashoffset .3s ease' }} />
      </svg>
    </button>
    <div
      role="tooltip"
      className="pointer-events-none invisible absolute right-0 top-full z-20 mt-1.5 w-60 rounded-xl border border-line p-2.5 opacity-0 shadow-[var(--shadow-glass)] transition-opacity duration-150 group-hover:visible group-hover:opacity-100"
      style={{ backgroundColor: 'var(--surface-solid)' }}>
      <p className="mb-1.5 text-[11px] font-medium text-ink-2">Context window</p>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[10.5px] tabular-nums text-ink-3">
        {rows.map(([label, value]) => <div key={label} className="contents">
          <span>{label}</span>
          <span className="text-right text-ink-2">{value}</span>
        </div>)}
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-ink-3/80">Draft and request estimates are heuristics. Provider input is reported usage, not exact billing.</p>
    </div>
  </div>;
}
