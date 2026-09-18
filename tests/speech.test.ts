import { expect, test } from 'bun:test';
import { speechSegments } from '@shared/speech';

test('complete sentences stream out; trailing fragment is held back', () => {
  const partial = speechSegments('First sentence. Second sentence. And a partial without end');
  expect(partial).toEqual(['First sentence.', 'Second sentence.']);
  expect(speechSegments(partial.join(' ') + ' And a partial without end', { flush: true })).toEqual(['First sentence.', 'Second sentence.', 'And a partial without end']);
});

test('fenced code blocks are never spoken, including an open fence tail', () => {
  const text = 'Here is the plan. \n```js\nconsole.log("never read this");\n```\nDone with code.';
  expect(speechSegments(text, { flush: true })).toEqual(['Here is the plan.', 'Done with code.']);
  const openFence = 'Before code. \n```python\nprint("still streaming")';
  expect(speechSegments(openFence, { flush: true })).toEqual(['Before code.']);
});

test('urls, emphasis, headings and bullets are stripped; inline code content survives', () => {
  const text = '# Summary \n- Visit https://example.com/docs for **details**. \n- Run `bun test` now.';
  expect(speechSegments(text, { flush: true })).toEqual(['Summary Visit for details.', 'Run bun test now.']);
});

test('empty and whitespace-only text produce nothing', () => {
  expect(speechSegments('')).toEqual([]);
  expect(speechSegments('   \n``` \n   ')).toEqual([]);
});

test('segments are append-only so streamed tracking never skips text', () => {
  const early = speechSegments('Hi. Ok. Sure.');
  expect(early).toEqual(['Hi.', 'Ok.', 'Sure.']);
  // The same sentences stay byte-identical when more text arrives later.
  const later = speechSegments('Hi. Ok. Sure. Fine.');
  expect(later.slice(0, early.length)).toEqual(early);
});

test('long single sentences are capped per segment', () => {
  const long = 'x'.repeat(3000) + '.';
  const capped = speechSegments(long, { flush: true })[0];
  expect(capped.length).toBeLessThanOrEqual(1201); // 1200 + ellipsis
  expect(capped.endsWith('…')).toBe(true);
});
