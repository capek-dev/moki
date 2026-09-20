import { useEffect, useState } from 'react';
import type { Appearance, Mood } from '@renderer/components/companion/companion';
import { Companion, PALETTES } from '@renderer/components/companion/companion';
import { Button } from '@renderer/components/ui/button';
import { Field } from '@renderer/components/ui/field';
import { SimpleSelect } from '@renderer/components/ui/select';

const STATES: { id: Mood; label: string; caption: string }[] = [
  { id: 'idle', label: 'Idle', caption: 'Here when you need me.' },
  { id: 'thinking', label: 'Thinking', caption: 'Let me think about that.' },
  { id: 'working', label: 'Working', caption: 'Taking care of it.' },
  { id: 'attention', label: 'Needs you', caption: 'A little help, please?' },
  { id: 'done', label: 'Done', caption: 'All done!' },
];

const title = (value: string) => value.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
const options = (values: readonly string[], none = 'None') => values.map((value) => ({ value, label: value === 'none' ? none : title(value) }));

export function AppearancePreview({ appearance, onChange }: { appearance: Appearance; onChange: (value: Appearance) => void }) {
  const [mood, setMood] = useState<Mood>('idle');
  const [paused, setPaused] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const state = STATES.find((item) => item.id === mood)!;
  const select = <K extends keyof Appearance>(key: K) => ({
    value: appearance[key] as string,
    onValueChange: (value: string) => onChange({ ...appearance, [key]: value as Appearance[K] }),
  });
  return <div className="grid gap-4">
    <div>
      <h3 className="text-[13.5px] font-semibold">Appearance</h3>
      <p className="mt-0.5 text-[12.5px] text-ink-3">Choose Moki's body, face, and one complete outfit. Outfits include their matching clothing and accessories.</p>
    </div>
    <div className="avatar-stage grid justify-items-center gap-2 px-4 py-6">
      <div className="w-44"><Companion appearance={appearance} mood={mood} paused={paused} /></div>
      <p aria-live="polite" className="text-[13px] font-medium">{state.caption}</p>
      <small className="text-[11px] text-ink-3">Animation preview, not live activity</small>
    </div>
    <div className="flex flex-wrap justify-center gap-1" role="group" aria-label="Preview activity">
      {STATES.map((item) => <Button key={item.id} size="sm" variant={mood === item.id ? 'primary' : 'secondary'} aria-pressed={mood === item.id} onClick={() => setMood(item.id)}>{item.label}</Button>)}
    </div>

    <section className="grid gap-3" aria-labelledby="appearance-body">
      <h4 id="appearance-body" className="border-b border-line pb-1 text-[12px] font-semibold text-ink-2">Body</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Shape"><SimpleSelect aria-label="Shape" {...select('shape')} options={[{ value: 'pebble', label: 'Pebble · round' }, { value: 'mochi', label: 'Mochi · soft and wide' }, { value: 'puff', label: 'Puff · fluffy' }]} /></Field>
        <Field label="Color"><SimpleSelect aria-label="Color" {...select('palette')} options={options(Object.keys(PALETTES))} /></Field>
      </div>
    </section>

    <section className="grid gap-3" aria-labelledby="appearance-head">
      <h4 id="appearance-head" className="border-b border-line pb-1 text-[12px] font-semibold text-ink-2">Head and eyes</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Head detail"><SimpleSelect aria-label="Head detail" {...select('head')} options={options(['none', 'sprout', 'cat-ears', 'bunny-ears', 'horns'])} /></Field>
        <Field label="Eyewear"><SimpleSelect aria-label="Eyewear" {...select('eyewear')} options={options(['none', 'glasses', 'round-glasses', 'sunglasses', 'monocle'])} /></Field>
        <Field label="Eyes"><SimpleSelect aria-label="Eyes" {...select('eyes')} options={options(['bright', 'sleepy', 'round', 'sparkle', 'happy'])} /></Field>
        <Field label="Eye color"><SimpleSelect aria-label="Eye color" {...select('eyeColor')} options={options(['dark', 'accent', 'blue', 'green', 'warm'])} /></Field>
      </div>
    </section>

    <section className="grid gap-3" aria-labelledby="appearance-face">
      <h4 id="appearance-face" className="border-b border-line pb-1 text-[12px] font-semibold text-ink-2">Face</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Face detail"><SimpleSelect aria-label="Face detail" {...select('face')} options={options(['blush', 'none', 'freckles', 'stars', 'hearts'], 'No face detail')} /></Field>
        <Field label="Mouth"><SimpleSelect aria-label="Mouth" {...select('mouth')} options={options(['smile', 'tiny', 'cat', 'grin'])} /></Field>
      </div>
    </section>

    <section className="grid gap-3" aria-labelledby="appearance-outfit">
      <h4 id="appearance-outfit" className="border-b border-line pb-1 text-[12px] font-semibold text-ink-2">Outfit</h4>
      <p className="text-[11.5px] text-ink-3">Choose one complete look. Each outfit includes its matching clothing and accessories.</p>
      <Field label="Complete outfit"><SimpleSelect aria-label="Outfit" {...select('outfit')} options={[
        { value: 'none', label: 'No outfit' },
        { value: 'work', label: 'Work · suit, tie, and badge' },
        { value: 'cozy', label: 'Cozy · knitted sweater' },
        { value: 'fitness', label: 'Fitness · jersey and headband' },
        { value: 'rainy-day', label: 'Rainy day · coat and rain hat' },
        { value: 'explorer', label: 'Explorer · overalls and field hat' },
        { value: 'wizard', label: 'Wizard · robe, cape, hat, and wand' },
        { value: 'artist', label: 'Artist · apron and paintbrush' },
        { value: 'formal', label: 'Formal · tuxedo and bow tie' },
      ]} /></Field>
    </section>

    <section className="grid gap-3" aria-labelledby="appearance-movement">
      <h4 id="appearance-movement" className="border-b border-line pb-1 text-[12px] font-semibold text-ink-2">Movement</h4>
      <Field label="Animation"><SimpleSelect aria-label="Movement" {...select('motion')} options={options(['still', 'subtle', 'expressive'])} /></Field>
    </section>

    <div className="flex items-center gap-3 border-t border-line pt-3">
      <div className="w-11 shrink-0"><Companion appearance={{ ...appearance, motion: 'still' }} mood={mood} paused /></div>
      <p className="text-[12px] text-ink-3">Small-size preview. Your Mac's reduced-motion preference takes priority.</p>
    </div>
  </div>;
}
