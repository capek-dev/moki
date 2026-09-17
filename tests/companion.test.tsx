import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { Companion, INITIAL_APPEARANCE, PALETTES, type Mood } from '@renderer/components/companion/companion';

test('all creature shapes, palettes, accessories and activity states render self-contained SVG', () => {
  for (const shape of ['pebble', 'mochi', 'puff'] as const)
    for (const palette of Object.keys(PALETTES) as (keyof typeof PALETTES)[])
      for (const accessory of ['none', 'glasses', 'scarf', 'sprout'] as const)
        for (const mood of ['idle', 'thinking', 'working', 'attention', 'done'] as Mood[]) {
          for (const outfit of ['none', 'suit', 'fitness', 'sweater'] as const) {
          const html = renderToStaticMarkup(<Companion appearance={{ ...INITIAL_APPEARANCE, shape, palette, accessory, outfit }} mood={mood} />);
          expect(html).toContain(`data-outfit="${outfit}"`);
          expect(html).toContain('clip-path="url(#');
          expect(html).toContain(`${palette} ${shape} companion, ${mood}`);
          expect(html).toContain(`data-mood="${mood}"`);
          expect(html).not.toMatch(/<script|<image|https?:|style=/);
          }
        }
});
test('multiple previews have distinct gradient and accessible title references', () => {
  const html = renderToStaticMarkup(<><Companion appearance={INITIAL_APPEARANCE} /><Companion appearance={{ ...INITIAL_APPEARANCE, face: 'sleepy', motion: 'still' }} paused /></>);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const match of html.matchAll(/url\(#([^)]*)\)/g)) expect(ids).toContain(match[1]);
  expect(html).toContain('data-motion="still"');
  expect(html).toContain('data-paused="true"');
});
test('built renderer includes companion styles and reduced-motion fallback', () => {
  const css = readFileSync('dist/renderer/app.css', 'utf8');
  expect(css).toContain('creature-stage');
  expect(css).toContain('prefers-reduced-motion');
  expect(css).toContain('creature-breathe');
  const js = readFileSync('dist/renderer/app.js', 'utf8');
  expect(js).toContain('Appearance');
  expect(js).toContain('visibilitychange');
});
