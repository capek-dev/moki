import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { Companion, INITIAL_APPEARANCE, type Appearance, type Mood } from '@renderer/components/companion/companion';

const variants: { [K in keyof Appearance]: readonly Appearance[K][] } = {
  shape: ['pebble', 'mochi', 'puff'], palette: ['lavender', 'peach', 'mint', 'sky'],
  head: ['none', 'sprout', 'cat-ears', 'bunny-ears', 'horns'], eyewear: ['none', 'glasses', 'round-glasses', 'sunglasses', 'monocle'],
  eyes: ['bright', 'sleepy', 'round', 'sparkle', 'happy'], eyeColor: ['dark', 'accent', 'blue', 'green', 'warm'],
  face: ['blush', 'none', 'freckles', 'stars', 'hearts'], mouth: ['smile', 'tiny', 'cat', 'grin'],
  outfit: ['none', 'work', 'cozy', 'fitness', 'rainy-day', 'explorer', 'wizard', 'artist', 'formal'],
  motion: ['still', 'subtle', 'expressive'],
};

test('every appearance and complete outfit choice renders self-contained SVG', () => {
  for (const key of Object.keys(variants) as (keyof Appearance)[]) {
    for (const value of variants[key]) {
      const appearance = { ...INITIAL_APPEARANCE, [key]: value } as Appearance;
      const html = renderToStaticMarkup(<Companion appearance={appearance} mood="idle" />);
      expect(html).toContain(`data-outfit="${appearance.outfit}"`);
      expect(html).toContain(`data-outfit-clip="${appearance.outfit}" clip-path="url(#`);
      expect(html).toContain(`data-outfit-accessories="${appearance.outfit}"`);
      expect(html).toContain(`${appearance.palette} ${appearance.shape} companion, idle`);
      expect(html).not.toMatch(/<script|<image|https?:|style=/);
    }
  }
});

test('full outfits remain compatible with independent face choices and moods', () => {
  const appearance: Appearance = {
    ...INITIAL_APPEARANCE, head: 'cat-ears', eyewear: 'monocle', eyes: 'sparkle', eyeColor: 'green', face: 'freckles', mouth: 'cat', outfit: 'wizard',
  };
  for (const mood of ['idle', 'thinking', 'working', 'attention', 'done', 'speaking'] as Mood[]) {
    const html = renderToStaticMarkup(<Companion appearance={appearance} mood={mood} />);
    for (const attribute of ['data-head="cat-ears"', 'data-eyewear="monocle"', 'data-eyes="sparkle"', 'data-face="freckles"', 'data-outfit="wizard"']) {
      expect(html).toContain(attribute);
    }
  }
});

test('multiple previews have distinct gradient and accessible title references', () => {
  const html = renderToStaticMarkup(<><Companion appearance={INITIAL_APPEARANCE} /><Companion appearance={{ ...INITIAL_APPEARANCE, eyes: 'sleepy', outfit: 'cozy', motion: 'still' }} paused /></>);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const match of html.matchAll(/url\(#([^)]*)\)/g)) expect(ids).toContain(match[1]);
  expect(html).toContain('data-outfit="cozy"');
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
