import { useEffect, useState } from 'react';
import type { Appearance, Mood } from './companion';
import { Companion, PALETTES } from './companion';
import { Button } from './ui/button';
import { Field } from './ui/field';
import { SimpleSelect } from './ui/select';

const STATES: { id: Mood; label: string; caption: string }[] = [
  { id: 'idle', label: 'Idle', caption: 'Here when you need me.' },
  { id: 'thinking', label: 'Thinking', caption: 'Let me think about that.' },
  { id: 'working', label: 'Working', caption: 'Taking care of it.' },
  { id: 'attention', label: 'Needs you', caption: 'A little help, please?' },
  { id: 'done', label: 'Done', caption: 'All done!' },
];

export function AppearancePreview({ appearance, onChange }: { appearance: Appearance; onChange: (value: Appearance) => void }) {
  const [mood, setMood] = useState<Mood>('idle');
  const [paused, setPaused] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const state = STATES.find((s) => s.id === mood)!;
  const select = <K extends keyof Appearance>(key: K) => ({
    value: appearance[key] as string,
    onValueChange: (value: string) => onChange({ ...appearance, [key]: value as Appearance[K] }),
  });
  return <div className="grid gap-4">
    <div>
      <h3 className="text-[13.5px] font-semibold">Appearance</h3>
      <p className="mt-0.5 text-[12.5px] text-ink-3">Customize this companion's avatar. Choose Save companion below to keep your changes.</p>
    </div>
    <div className="avatar-stage grid justify-items-center gap-2 px-4 py-6">
      <div className="w-44"><Companion appearance={appearance} mood={mood} paused={paused} /></div>
      <p aria-live="polite" className="text-[13px] font-medium">{state.caption}</p>
      <small className="text-[11px] text-ink-3">Animation preview, not live activity</small>
    </div>
    <div className="flex flex-wrap justify-center gap-1" role="group" aria-label="Preview activity">
      {STATES.map((s) => <Button key={s.id} size="sm" variant={mood === s.id ? 'primary' : 'secondary'} aria-pressed={mood === s.id} onClick={() => setMood(s.id)}>{s.label}</Button>)}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Shape">
        <SimpleSelect aria-label="Shape" {...select('shape')} options={[
          { value: 'pebble', label: 'Pebble · round' }, { value: 'mochi', label: 'Mochi · soft and wide' }, { value: 'puff', label: 'Puff · fluffy' }]} />
      </Field>
      <Field label="Color">
        <SimpleSelect aria-label="Color" {...select('palette')} options={Object.keys(PALETTES).map((color) => ({ value: color, label: color.charAt(0).toUpperCase() + color.slice(1) }))} />
      </Field>
      <Field label="Outfit">
        <SimpleSelect aria-label="Outfit" {...select('outfit')} options={[
          { value: 'none', label: 'No outfit' }, { value: 'suit', label: 'Work · suit and tie' }, { value: 'fitness', label: 'Fitness · jersey and headband' }, { value: 'sweater', label: 'Home · cozy sweater' }]} />
      </Field>
      <Field label="Accessory">
        <SimpleSelect aria-label="Accessory" {...select('accessory')} options={[
          { value: 'none', label: 'None' }, { value: 'glasses', label: 'Glasses' }, { value: 'scarf', label: 'Scarf' }, { value: 'sprout', label: 'Little sprout' }]} />
      </Field>
      <Field label="Eyes">
        <SimpleSelect aria-label="Eyes" {...select('face')} options={[{ value: 'bright', label: 'Bright' }, { value: 'sleepy', label: 'Sleepy' }]} />
      </Field>
      <Field label="Movement">
        <SimpleSelect aria-label="Movement" {...select('motion')} options={[{ value: 'still', label: 'Still' }, { value: 'subtle', label: 'Subtle' }, { value: 'expressive', label: 'Expressive' }]} />
      </Field>
    </div>
    <div className="flex items-center gap-3 border-t border-line pt-3">
      <div className="w-11 shrink-0"><Companion appearance={{ ...appearance, motion: 'still' }} mood={mood} paused /></div>
      <p className="text-[12px] text-ink-3">Small-size preview. All appearance choices are saved with this companion. Your Mac's reduced-motion preference takes priority.</p>
    </div>
  </div>;
}
