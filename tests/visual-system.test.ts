import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('compiled stylesheet ships tone tokens, glass surfaces and the creature animations', () => {
  const css = readFileSync('dist/renderer/app.css', 'utf8');
  expect(css).toContain('--tone-light');
  expect(css).toContain('--accent');
  expect(css).toContain('backdrop-filter');
  expect(css).toContain('creature-breathe');
  expect(css).toContain('creature-stage');
  expect(css).toContain('tone-swatch');
  expect(css).toContain('titlebar');
  expect(css).toContain('prefers-reduced-motion');
});

test('renderer bundle carries the tone system, companions and the history window, with scripts still locked down', () => {
  const js = readFileSync('dist/renderer/app.js', 'utf8');
  expect(js).toContain('Match avatar');
  expect(js).toContain('creature');
  expect(js).toContain('Settings');
  expect(js).toContain('History');
  expect(js).toContain('moki:open-conversation');
  const css = readFileSync('dist/renderer/app.css', 'utf8');
  // Page and surfaces derive from the accent so the tone tints the whole app.
  expect(css).toContain('color-mix(in oklab, var(--accent)');
  const html = readFileSync('dist/renderer/index.html', 'utf8');
  expect(html).toContain("style-src 'self' 'unsafe-inline'");
  expect(html).toContain("script-src 'self'");
});
