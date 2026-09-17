import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '@shared/protocol';
import { ChatCompanion, chatMood } from '@renderer/components/companion/chat-companion';
import { INITIAL_APPEARANCE } from '@renderer/components/companion/companion';

function reply(overrides: Partial<Message> = {}): Message {
  return { id: 'reply', conversationId: 'chat', role: 'assistant', text: '', status: 'streaming', model: null, assistantName: null, error: null, thinking: null, ...overrides };
}
const mood = (messages: Message[], starting = false, failed = false) => chatMood({ messages, starting, failed });

test('follows waiting, first text, completion, next turn and Stop', () => {
  expect(mood([])).toBe('idle');
  expect(mood([], true)).toBe('thinking');
  expect(mood([reply()])).toBe('thinking');
  expect(mood([reply({ text: 'Hello' })])).toBe('working');
  // An early state event can arrive before the start IPC resolves.
  expect(mood([reply({ text: 'Hello' })], true)).toBe('working');
  const complete = reply({ text: 'Hello', status: 'complete' });
  expect(mood([complete])).toBe('done');
  expect(mood([complete], true)).toBe('thinking');
  expect(mood([complete, reply({ id: 'next', role: 'user', status: 'complete' })])).toBe('idle');
  expect(mood([reply({ text: 'Partial', status: 'interrupted' })])).toBe('idle');
});

test('errors need attention, and a new turn supersedes an old failed reply', () => {
  const failed = reply({ status: 'failed', error: 'Provider unavailable' });
  expect(mood([failed])).toBe('attention');
  expect(mood([], false, true)).toBe('attention');
  expect(mood([reply()], false, true)).toBe('attention');
  expect(mood([failed], true)).toBe('thinking');
  expect(mood([failed, reply({ id: 'retry' })])).toBe('thinking');
});

test('switching selected histories does not retain another conversation mood', () => {
  expect(mood([reply({ text: 'Streaming' })])).toBe('working');
  expect(mood([])).toBe('idle');
  expect(mood([reply({ conversationId: 'other', status: 'complete' })])).toBe('done');
});

test('chat avatar renders live moods without forced pause and preserves saved motion', () => {
  for (const motion of ['still', 'subtle', 'expressive'] as const) {
    const html = renderToStaticMarkup(<ChatCompanion appearance={{ ...INITIAL_APPEARANCE, motion }} messages={[reply()]} starting={false} failed={false} />);
    expect(html).toContain('data-mood="thinking"');
    expect(html).toContain('data-paused="false"');
    expect(html).toContain(`data-motion="${motion}"`);
    expect(html).toContain('creature-thought');
  }
});
