import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolTrail } from '@renderer/windows/chat-window';
import type { Message } from '@shared/protocol';

function message(status: 'ok' | 'failed', summary: string): Message {
  return {
    id: 'reply-1',
    conversationId: 'conversation-1',
    text: '',
    role: 'assistant',
    status: 'complete',
    model: 'deepseek-flash',
    assistantName: 'Moki',
    error: null,
    thinking: null,
    toolCalls: [{ name: 'webfetch', label: 'Using webfetch', detail: 'example.com', summary, status, at: 1 }],
  };
}

test('failed tool calls show their saved error summary in the expanded trail', () => {
  const html = renderToStaticMarkup(<ToolTrail message={message('failed', 'Network request failed: ECONNREFUSED')} />);
  expect(html).toContain('Used 1 tool');
  expect(html).toContain('Network request failed: ECONNREFUSED');
});

test('successful tool calls keep result summaries out of the compact trail', () => {
  const html = renderToStaticMarkup(<ToolTrail message={message('ok', 'page contents')} />);
  expect(html).not.toContain('page contents');
});
