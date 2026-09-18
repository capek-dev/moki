import { expect, test } from 'bun:test';
import { createDictationMachine } from '@shared/dictation';

function fakeResultEvent(entries: { transcript: string; isFinal: boolean }[]) {
  return {
    resultIndex: 0,
    results: entries.map((entry) => {
      const alternatives = [{ transcript: entry.transcript }] as ArrayLike<{ transcript: string }>;
      return Object.assign(alternatives, { isFinal: entry.isFinal });
    }),
  };
}

test('dictation machine forwards interim and final results in order', () => {
  const machine = createDictationMachine();
  const events: { transcript: string; final: boolean }[] = [];
  machine.handleResult(fakeResultEvent([
    { transcript: 'hello there', isFinal: false },
    { transcript: 'hello there', isFinal: true },
  ]), (event) => events.push(event));
  expect(events).toEqual([
    { transcript: 'hello there', final: false },
    { transcript: 'hello there', final: true },
  ]);
});

test('empty transcripts are dropped, not emitted as phantom events', () => {
  const machine = createDictationMachine();
  const events: { transcript: string; final: boolean }[] = [];
  machine.handleResult(fakeResultEvent([{ transcript: '   ', isFinal: false }]), (event) => events.push(event));
  expect(events).toEqual([]);
});

test('error mapping: permission, no-speech, aborted, network, unknown', () => {
  const machine = createDictationMachine();
  expect(machine.mapError('not-allowed')).toContain('Microphone access was denied');
  expect(machine.mapError('no-speech')).toContain('No speech was heard');
  expect(machine.mapError('aborted')).toBe('');
  expect(machine.mapError('network')).toContain('unavailable right now');
  expect(machine.mapError('audio-capture')).toContain('stopped unexpectedly');
});

test('stop is idempotent and falls back to abort when stop() throws', () => {
  const machine = createDictationMachine();
  let stops = 0;
  let aborts = 0;
  const recognition = {
    stop() { stops++; if (stops === 1) throw new Error('already stopped'); },
    abort() { aborts++; },
  };
  machine.stop(recognition as never);
  machine.stop(recognition as never);
  expect(stops).toBe(1);
  expect(aborts).toBe(1);
});

test('finalize fires exactly once', () => {
  const machine = createDictationMachine();
  expect(machine.finalize()).toBe(true);
  expect(machine.finalize()).toBe(false);
});
