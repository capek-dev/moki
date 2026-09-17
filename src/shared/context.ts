import type { Attachment, Message } from '@shared/protocol';

// Local context window estimation. The provider reports exact usage only mid-
// turn, so the header indicator estimates what the next turn will send using
// the same bounds the backend's history() applies: newest messages first, at
// most 60k characters of text, at most 4 images and 32MB of image data.
const TEXT_CHAR_LIMIT = 60000;
const IMAGE_COUNT_LIMIT = 4;
const IMAGE_BYTES_LIMIT = 32 * 1024 * 1024;
// Rough cross-vendor average for mixed prose; providers count differently.
const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;
const MIN_IMAGE_TOKENS = 300;
const MAX_IMAGE_TOKENS = 4000;

export interface ContextEstimate {
  systemTokens: number;
  textTokens: number;
  imageTokens: number;
  includedMessages: number;
  totalMessages: number;
  /** True when the 60k text cap or an image cap excluded part of the history. */
  truncated: boolean;
}

export function estimateImageTokens(width: number, height: number): number {
  // Vision encoders bill roughly by tile area; ~750 px per token is the
  // common OpenAI-style heuristic, clamped to a sane screenshot range.
  return Math.max(MIN_IMAGE_TOKENS, Math.min(MAX_IMAGE_TOKENS, Math.ceil((width * height) / 750)));
}

export function estimateContextUsage(messages: readonly Message[], attachments: readonly Attachment[], instructions = ''): ContextEstimate {
  const byMessage = new Map<string, Attachment[]>();
  for (const attachment of attachments) byMessage.set(attachment.messageId, [...(byMessage.get(attachment.messageId) ?? []), attachment]);
  let textSize = 0;
  let imageSize = 0;
  let imageCount = 0;
  let textTokens = 0;
  let imageTokens = 0;
  let included = 0;
  let truncated = false;
  for (const message of [...messages].reverse()) {
    if (!message.text || message.status === 'streaming' || (message.role === 'assistant' && message.status !== 'complete')) continue;
    if (textSize + message.text.length > TEXT_CHAR_LIMIT) { truncated = true; break; }
    textSize += message.text.length;
    textTokens += Math.ceil(message.text.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;
    included++;
    if (message.role === 'user') {
      for (const image of byMessage.get(message.id) ?? []) {
        if (imageCount >= IMAGE_COUNT_LIMIT || imageSize + image.byteSize > IMAGE_BYTES_LIMIT) { truncated = true; continue; }
        imageCount++; imageSize += image.byteSize;
        imageTokens += estimateImageTokens(image.width, image.height);
      }
    }
  }
  const systemTokens = instructions ? Math.ceil(instructions.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS : 0;
  return { systemTokens, textTokens, imageTokens, includedMessages: included, totalMessages: messages.length, truncated };
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(value);
}
