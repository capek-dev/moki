import type { ModelMessage } from 'ai';
import type { Attachment, Message } from '@shared/protocol';

// Local context window estimation. The provider reports exact usage only mid-
// turn, so the header indicator estimates what the next turn will send using
// the same bounds the backend's history() applies: newest messages first, at
// most 60k characters of text, at most 4 images and 32MB of image data.
const TEXT_CHAR_LIMIT = 60000;
const IMAGE_COUNT_LIMIT = 4;
const IMAGE_BYTES_LIMIT = 32 * 1024 * 1024;
// JavaScript string lengths are UTF-16 code units. Dividing by four is a
// rough cross-vendor heuristic, not an upper bound or a provider guarantee.
const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;
const MIN_IMAGE_TOKENS = 300;
const MAX_IMAGE_TOKENS = 4000;

export interface ContextEstimate {
  /** Base assistant instructions plus the request-time clock context. */
  systemTokens: number;
  /** Tool guidance or serialized tool-schema tokens, depending on the helper used. */
  toolTokens: number;
  /** Rendered memory records when measured separately by the legacy helper. */
  memoryTokens: number;
  /** Text, tool calls, and tool results in model-facing messages. */
  textTokens: number;
  /** Tool-call and tool-result growth within model-facing messages. */
  toolLoopTokens: number;
  imageTokens: number;
  /** Sum of heuristic estimates, not a provider token count or guarantee. */
  totalTokens: number;
  includedMessages: number;
  totalMessages: number;
  /** True when the 60k text cap or an image cap excluded part of the history. */
  truncated: boolean;
}

export interface ContextAdditions {
  toolInstructions?: string;
  memoryContext?: string;
}

export interface ContextTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ImageAccounting {
  /** Images known to be present in the initial model-facing history. */
  knownImageCount: number;
  /** Heuristic estimate for those known images. */
  knownImageTokens: number;
  /** Conservative fallback for later or otherwise unmeasured images. */
  fallbackImageTokens: number;
}

export interface ModelContextEstimate extends ContextEstimate {
  /** The number of model-facing messages sent at this request boundary. */
  includedMessages: number;
  /** False because this helper does not truncate the AI SDK message set. */
  truncated: false;
}

export interface ContextTurn {
  conversationId: string;
  messageId: string;
  turnId: string;
}

export type ContextUpdate =
  | { type: 'estimate'; requestNumber: number; estimate: ModelContextEstimate; contextWindowTokens: number; outputReserveTokens: number }
  | { type: 'provider'; requestNumber: number; inputTokens?: number; outputTokens?: number; totalTokens?: number };

export interface ContextUsage {
  turn: ContextTurn;
  model: string;
  contextWindowTokens: number;
  outputReserveTokens: number;
  requestNumber: number;
  estimate: ModelContextEstimate;
  estimateSource: 'heuristic';
  providerReported?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    source: 'ai-sdk-provider-usage';
    billingExact: false;
  };
}

export class ContextBudgetError extends Error {
  constructor(
    public readonly estimatedTokens: number,
    public readonly inputLimitTokens: number,
    public readonly contextWindowTokens: number,
    public readonly outputReserveTokens: number,
    public readonly requestNumber?: number,
  ) {
    super(`This request is estimated at about ${estimatedTokens.toLocaleString()} input tokens, above the local guardrail of ${inputLimitTokens.toLocaleString()} after reserving ${outputReserveTokens.toLocaleString()} output tokens. Shorten the request, remove screenshots or tools, or start a new conversation.`);
    this.name = 'ContextBudgetError';
  }
}

function finiteNonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}.`);
  return value;
}

export function createImageAccounting(knownImageCount: number, knownImageTokens: number, fallbackImageTokens = MAX_IMAGE_TOKENS): ImageAccounting {
  if (!Number.isSafeInteger(knownImageCount) || knownImageCount < 0) throw new Error('Invalid known image count.');
  return {
    knownImageCount,
    knownImageTokens: finiteNonnegative(knownImageTokens, 'known image estimate'),
    fallbackImageTokens: finiteNonnegative(fallbackImageTokens, 'fallback image estimate'),
  };
}

export function estimateImageTokens(width: number, height: number): number {
  // Vision encoders bill roughly by tile area; ~750 px per token is the
  // common OpenAI-style heuristic, clamped to a sane screenshot range.
  finiteNonnegative(width, 'image width');
  finiteNonnegative(height, 'image height');
  return Math.max(MIN_IMAGE_TOKENS, Math.min(MAX_IMAGE_TOKENS, Math.ceil((width * height) / 750)));
}

export function estimateContextUsage(messages: readonly Message[], attachments: readonly Attachment[], instructions = '', clockContext = '', additions: ContextAdditions = {}): ContextEstimate {
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
  const systemText = [instructions, clockContext].filter(Boolean).join('\n\n');
  const toolText = additions.toolInstructions ?? '';
  const memoryText = additions.memoryContext ?? '';
  const estimateText = (value: string) => value ? Math.ceil(value.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS : 0;
  const systemTokens = estimateText(systemText);
  const toolTokens = estimateText(toolText);
  const memoryTokens = estimateText(memoryText);
  const totalTokens = systemTokens + toolTokens + memoryTokens + textTokens + imageTokens;
  return { systemTokens, toolTokens, memoryTokens, textTokens, toolLoopTokens: 0, imageTokens, totalTokens, includedMessages: included, totalMessages: messages.length, truncated };
}

export function countModelImages(messages: readonly ModelMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray((message as { content?: unknown }).content)) continue;
    for (const part of (message as { content: Array<{ type?: unknown }> }).content) if (part.type === 'image') count++;
  }
  return count;
}

function serializedLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Context contains a value that cannot be serialized safely.');
  return serialized.length;
}

function modelMessageCharacters(message: ModelMessage): { chars: number; toolChars: number; imageCount: number } {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return { chars: content.length, toolChars: 0, imageCount: 0 };
  if (!Array.isArray(content)) return { chars: serializedLength(content), toolChars: 0, imageCount: 0 };
  let chars = 0;
  let toolChars = 0;
  let imageCount = 0;
  for (const part of content as Array<Record<string, unknown>>) {
    const type = part.type;
    if (type === 'image') { imageCount++; continue; }
    if (type === 'file') throw new Error('Unsupported file content cannot be measured for context budgeting.');
    if (type === 'text' && typeof part.text === 'string') { chars += part.text.length; continue; }
    if (type === 'tool-call') {
      const length = serializedLength({ type, toolName: part.toolName, input: part.input });
      chars += length; toolChars += length; continue;
    }
    if (type === 'tool-result') {
      const length = serializedLength({ type, toolName: part.toolName, output: part.output });
      chars += length; toolChars += length; continue;
    }
    const length = serializedLength(part);
    chars += length;
    if (typeof type === 'string' && type.startsWith('tool-')) toolChars += length;
  }
  return { chars, toolChars, imageCount };
}

/**
 * Measures the model-facing message set AI SDK passes to a step. The
 * resulting token values are UTF-16/4 heuristics, not billing data or a
 * guarantee that a provider will accept the request. Tool schemas and
 * tool-loop messages are counted separately so callers can explain growth.
 */
export function estimateModelContext(
  messages: readonly ModelMessage[],
  instructions: string,
  tools: readonly ContextTool[] = [],
  images: ImageAccounting = createImageAccounting(0, 0),
): ModelContextEstimate {
  const imageAccounting = createImageAccounting(images.knownImageCount, images.knownImageTokens, images.fallbackImageTokens);
  const estimateText = (value: string) => value ? Math.ceil(value.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS : 0;
  const systemTokens = estimateText(instructions);
  let textTokens = 0;
  let toolLoopTokens = 0;
  let detectedImages = 0;
  for (const message of messages) {
    const measured = modelMessageCharacters(message);
    textTokens += measured.chars ? Math.ceil(measured.chars / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS : MESSAGE_OVERHEAD_TOKENS;
    toolLoopTokens += measured.toolChars ? Math.ceil(measured.toolChars / CHARS_PER_TOKEN) : 0;
    detectedImages += measured.imageCount;
  }
  let toolChars = 0;
  for (const tool of tools) toolChars += serializedLength({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
  const toolTokens = toolChars ? Math.ceil(toolChars / CHARS_PER_TOKEN) + tools.length * MESSAGE_OVERHEAD_TOKENS : 0;
  if (detectedImages < imageAccounting.knownImageCount) throw new Error('Known image accounting does not match the model-facing messages.');
  const additionalUnknownImages = detectedImages - imageAccounting.knownImageCount;
  const countedImageTokens = imageAccounting.knownImageTokens + additionalUnknownImages * imageAccounting.fallbackImageTokens;
  const totalTokens = systemTokens + toolTokens + textTokens + countedImageTokens;
  return {
    systemTokens,
    toolTokens,
    memoryTokens: 0,
    textTokens,
    toolLoopTokens,
    imageTokens: countedImageTokens,
    totalTokens,
    includedMessages: messages.length,
    totalMessages: messages.length,
    truncated: false,
  };
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(value);
}
