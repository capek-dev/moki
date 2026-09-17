import { TONES, type FixedTone, type ToneChoice } from './tone';

/** Swatches for the app tone. "Match avatar" follows the companion palette. */
export function TonePicker({ choice, onChoose }: { choice: ToneChoice; onChoose: (choice: ToneChoice) => void }) {
  return <div className="grid gap-3" role="radiogroup" aria-label="App tone">
    <button
      type="button"
      role="radio"
      aria-checked={choice === 'auto'}
      onClick={() => onChoose('auto')}
      className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-left transition-colors hover:border-line-strong aria-checked:border-accent-line aria-checked:bg-accent-soft">
      <span>
        <span className="block text-[13px] font-medium text-ink">Match avatar</span>
        <span className="block text-[12px] text-ink-3">Follows Moki's avatar colors</span>
      </span>
      <span className="tone-auto-swatch" aria-hidden="true" />
    </button>
    <div className="flex flex-wrap gap-2.5">
      {(Object.keys(TONES) as FixedTone[]).map((id) => <button
        key={id}
        type="button"
        role="radio"
        aria-checked={choice === id}
        aria-label={TONES[id].name}
        title={TONES[id].name}
        onClick={() => onChoose(id)}
        className="tone-swatch cursor-pointer rounded-full transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-accent"
        style={{ background: `linear-gradient(140deg, ${TONES[id].light}, ${TONES[id].dark})` }} />)}
    </div>
  </div>;
}
