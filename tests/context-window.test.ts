import { expect, test } from 'bun:test';
import { estimateContextUsage, estimateImageTokens, formatTokens } from '@shared/context';
import type { Attachment, Message } from '@shared/protocol';

function message(id: string, text: string, role: 'user' | 'assistant' = 'user', status: Message['status'] = 'complete'): Message {
  return { id, conversationId: 'c', text, role, status, model: null, assistantName: null, error: null, thinking: null };
}
function attachment(messageId: string, byteSize = 100_000): Attachment {
  return { id: `a-${messageId}-${byteSize}`, messageId, mime: 'image/png', byteSize, width: 2000, height: 1200 };
}

test('image token estimate follows area heuristic with clamps', () => {
  expect(estimateImageTokens(2000, 1200)).toBe(3200); // 2.4M px / 750
  expect(estimateImageTokens(400, 300)).toBe(300); // small clamps up
  expect(estimateImageTokens(8000, 6000)).toBe(4000); // huge clamps down
});

test('estimation mirrors the history bounds: newest first, 60k text cap', () => {
  const big = 'x'.repeat(40000);
  const messages = [message('1', big), message('2', big)]; // 80k total -> only newest fits
  const estimate = estimateContextUsage(messages, [], '');
  expect(estimate.includedMessages).toBe(1);
  expect(estimate.truncated).toBe(true);
  expect(estimate.textTokens).toBe(40000 / 4 + 4);
});

test('streaming and incomplete assistant messages are excluded, older text is counted', () => {
  const messages = [
    message('1', 'old', 'user'),
    message('2', 'partial', 'assistant', 'interrupted'),
    message('3', 'live', 'assistant', 'streaming'),
    message('4', 'new'),
  ];
  const estimate = estimateContextUsage(messages, [], '');
  expect(estimate.includedMessages).toBe(2); // 'old' user + 'new' user
  expect(estimate.totalMessages).toBe(4);
  expect(estimate.truncated).toBe(false);
});

test('images are counted per user message with the 4-image cap', () => {
  const messages = [message('u1', 'a'), message('u2', 'b')];
  const attachments = [attachment('u1'), attachment('u1', 200_000), attachment('u2'), attachment('u2', 300_000), attachment('u2', 400_000)];
  const estimate = estimateContextUsage(messages, attachments, '');
  expect(estimate.imageTokens).toBe(4 * 3200); // fifth image dropped by the cap
  expect(estimate.truncated).toBe(true);
});

test('instructions add system tokens', () => {
  const withSystem = estimateContextUsage([message('u1', 'hi')], [], 'Be helpful, clear, and kind.');
  expect(withSystem.systemTokens).toBe(Math.ceil(28 / 4) + 4);
});

test('aggregate estimate accounts for history, clock, tool guidance, and memory separately', () => {
  const estimate = estimateContextUsage([message('u1', 'abcd')], [], 'base', 'clock', {
    toolInstructions: 'tool guidance',
    memoryContext: 'memory record',
  });
  expect(estimate.systemTokens).toBe(Math.ceil(('base'.length + 2 + 'clock'.length) / 4) + 4);
  expect(estimate.toolTokens).toBe(Math.ceil('tool guidance'.length / 4) + 4);
  expect(estimate.memoryTokens).toBe(Math.ceil('memory record'.length / 4) + 4);
  expect(estimate.totalTokens).toBe(estimate.systemTokens + estimate.toolTokens + estimate.memoryTokens + estimate.textTokens + estimate.imageTokens);
});

test('compact token formatting', () => {
  expect(formatTokens(950)).toBe('950');
  expect(formatTokens(1500)).toBe('1.5k');
  expect(formatTokens(10000)).toBe('10k');
  expect(formatTokens(1000000)).toBe('1M');
});

test('the chat header wires the ring to the conversation context estimate', async () => {
  const app = await Bun.file('src/renderer/windows/chat-window.tsx').text();
  expect(app).toContain('estimateContextUsage(messages, data?.attachments ?? [], assistant?.instructions ?? \'\')');
  expect(app).toContain('<ContextRing estimate={contextEstimate} lastRequest={lastContextUsage} contextWindow={contextModel.contextWindow} outputReserveTokens={contextModel.maxOutputTokens} modelName={contextModel.name} />');
});

test('the ring keeps Prokop thresholds and shows no percentage text', async () => {
  const ring = await Bun.file('src/renderer/components/chat/context-ring.tsx').text();
  expect(ring).toContain("if (percentage >= 60) return 'critical'");
  expect(ring).toContain("if (percentage >= 40) return 'warning'");
  expect(ring).toContain('aria-label={`Context window usage: ${percentage}%`}');
  expect(ring).toContain("['Provider cache read', providerUsage?.cacheReadInputTokens?.toLocaleString() ?? 'Not reported']");
  expect(ring).toContain("['Provider cache write', providerUsage?.cacheWriteInputTokens?.toLocaleString() ?? 'Not reported']");
  expect(ring).not.toContain('>{percentage}%<');
});
