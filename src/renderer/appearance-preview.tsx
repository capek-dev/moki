import { useEffect, useState } from 'react';
import { Companion, PALETTES, type Appearance, type Mood } from './companion';
import './companion.css';

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
  return <div className="appearance-preview">
    <h2>Appearance</h2>
    <p className="muted">Customize this assistant’s avatar. Choose Save assistant below to keep your changes.</p>
    <div className="creature-stage">
      <div className="creature-large"><Companion appearance={appearance} mood={mood} paused={paused} /></div>
      <p aria-live="polite">{state.caption}</p><small>Animation preview, not live activity</small>
    </div>
    <div className="creature-states" role="group" aria-label="Preview activity">{STATES.map((s) => <button type="button" key={s.id} aria-pressed={mood === s.id} onClick={() => setMood(s.id)}>{s.label}</button>)}</div>
    <div className="creature-controls">
      <label>Shape<select value={appearance.shape} onChange={(e) => onChange({ ...appearance, shape: e.target.value as Appearance['shape'] })}><option value="pebble">Pebble · round</option><option value="mochi">Mochi · soft and wide</option><option value="puff">Puff · fluffy</option></select></label>
      <label>Color<select value={appearance.palette} onChange={(e) => onChange({ ...appearance, palette: e.target.value as Appearance['palette'] })}>{Object.keys(PALETTES).map((color) => <option key={color} value={color}>{color.charAt(0).toUpperCase() + color.slice(1)}</option>)}</select></label>
      <label>Outfit<select value={appearance.outfit} onChange={(e) => onChange({ ...appearance, outfit: e.target.value as Appearance['outfit'] })}><option value="none">No outfit</option><option value="suit">Work · suit and tie</option><option value="fitness">Fitness · jersey and headband</option><option value="sweater">Home · cozy sweater</option></select></label>
      <label>Accessory<select value={appearance.accessory} onChange={(e) => onChange({ ...appearance, accessory: e.target.value as Appearance['accessory'] })}><option value="none">None</option><option value="glasses">Glasses</option><option value="scarf">Scarf</option><option value="sprout">Little sprout</option></select></label>
      <label>Eyes<select value={appearance.face} onChange={(e) => onChange({ ...appearance, face: e.target.value as Appearance['face'] })}><option value="bright">Bright</option><option value="sleepy">Sleepy</option></select></label>
      <label>Movement<select value={appearance.motion} onChange={(e) => onChange({ ...appearance, motion: e.target.value as Appearance['motion'] })}><option value="still">Still</option><option value="subtle">Subtle</option><option value="expressive">Expressive</option></select></label>
    </div>
    <div className="creature-small-preview"><div><Companion appearance={{ ...appearance, motion: 'still' }} mood={mood} /></div><p>Your companion <br /><small>Small-size preview</small></p></div>
    <p className="muted">All appearance choices are saved with this assistant. Cancel discards your edits. Your Mac’s reduced-motion preference takes priority.</p>
  </div>;
}
