import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TonePicker } from '../src/renderer/tone-picker';
import { TONES, applyTone, readToneChoice, resolveTone, type FixedTone } from '../src/renderer/tone';
import type { Appearance } from '../src/shared/appearance';

test('tone catalog has distinct names and light/dark variants for every tone', () => {
  const ids = Object.keys(TONES) as FixedTone[];
  expect(ids.length).toBeGreaterThanOrEqual(5);
  expect(new Set(ids.map((id) => TONES[id].name)).size).toBe(ids.length);
  for (const id of ids) {
    expect(TONES[id].light).toMatch(/^#[0-9a-f]{6}$/i);
    expect(TONES[id].dark).toMatch(/^#[0-9a-f]{6}$/i);
    expect(TONES[id].light).not.toBe(TONES[id].dark);
  }
});

test('auto tone follows the avatar palette; every palette maps to its matching tone', () => {
  const palettes: Appearance['palette'][] = ['lavender', 'peach', 'mint', 'sky'];
  for (const palette of palettes) expect(resolveTone('auto', palette)).toBe(palette);
  expect(resolveTone('auto', 'mint')).toBe('mint');
  expect(resolveTone('graphite', 'sky')).toBe('graphite');
  // No localStorage in the test host: auto falls back to the default palette, never throws.
  expect(resolveTone('auto')).toBe('lavender');
  expect(readToneChoice()).toBe('auto');
});

test('applyTone writes the runtime tone variables', () => {
  const written: Record<string, string> = {};
  applyTone('ocean', { style: { setProperty: (name, value) => { written[name] = value; } } });
  expect(written).toEqual({ '--tone-light': TONES.ocean.light, '--tone-dark': TONES.ocean.dark });
});

test('tone picker renders an accessible radiogroup without remote content', () => {
  const html = renderToStaticMarkup(<TonePicker choice="auto" onChoose={() => {}} />);
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain('aria-label="App tone"');
  expect(html).toContain('Match avatar');
  expect(html).toContain('aria-checked="true"');
  // One radio per tone plus the auto option.
  expect(html.match(/role="radio"/g)?.length).toBe(Object.keys(TONES).length + 1);
  expect(html).not.toMatch(/<script|<image|https?:/);
});
