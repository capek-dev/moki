import { expect, test } from 'bun:test';
import { mapDictationError, parseHelperLine } from '@shared/dictation';

test('helper lines parse into typed events', () => {
  expect(parseHelperLine('{"type":"partial","text":"hello there"}')).toEqual({ type: 'partial', text: 'hello there' });
  expect(parseHelperLine('{"type":"final","text":"hello there"}')).toEqual({ type: 'final', text: 'hello there' });
  expect(parseHelperLine('{"type":"error","message":"mic-denied"}')).toEqual({ type: 'error', message: 'mic-denied' });
});

test('malformed lines are dropped, never thrown', () => {
  expect(parseHelperLine('not json')).toBeNull();
  expect(parseHelperLine('{}')).toBeNull();
  expect(parseHelperLine('{"type":"partial"}')).toBeNull(); // missing text
  expect(parseHelperLine('{"type":"partial","text":"   "}')).toBeNull(); // blank text
  expect(parseHelperLine('{"type":"final","text":"x"}extra')).toBeNull();
  expect(parseHelperLine('{"type":"partial","text":"x","extra":1}')).toEqual({ type: 'partial', text: 'x' }); // unknown fields tolerated
  expect(parseHelperLine('{"type":"surprise","text":"x"}')).toBeNull();
  expect(parseHelperLine('')).toBeNull();
});

test('oversized payloads are rejected', () => {
  expect(parseHelperLine(`{"type":"partial","text":"${'x'.repeat(2001)}"}`)).toBeNull();
  expect(parseHelperLine(`{"type":"error","message":"${'x'.repeat(101)}"}`)).toBeNull();
});

test('error codes map to friendly, actionable messages', () => {
  expect(mapDictationError('mic-denied')).toContain('Microphone access was denied');
  expect(mapDictationError('mic-denied')).toContain('System Settings');
  expect(mapDictationError('speech-denied')).toContain('Speech recognition was not allowed');
  expect(mapDictationError('speech-denied')).toContain('System Settings');
  expect(mapDictationError('no-mic')).toContain('No microphone was found');
  expect(mapDictationError('no-speech')).toContain('No speech was heard');
  expect(mapDictationError('unavailable')).toContain('not available on this Mac');
  expect(mapDictationError('anything-else')).toContain('Dictation stopped');
});
