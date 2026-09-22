import type { Toolbag, AgentToolDef } from '@backend/integrations/cua';
import type { MemoryHostConfig } from '@backend/memory/recall';
import type {
  MemoryRepository,
  ForegroundMemoryWriteResult,
  ForegroundSource,
  MemoryKind,
  MemoryRecord,
  MemoryForgetResult,
  MemoryRead,
} from '@backend/memory/repository';

export const MEMORY_TOOL_NAME = 'memory';
export const MEMORY_TOOL_GUIDANCE = 'Memory changes happen only when the user explicitly asks in the foreground. Do not learn from ordinary conversation or treat automatic tool calls as proof of a request. Use forget only for an explicit current-user request. Forgetting removes the live memory-store record, evidence, topic links, and relationships; it does not erase conversation history or backups.';
export const MEMORY_TOOL_DESCRIPTION = `Inspect or explicitly update Moki memory. Use list or search for bounded snippets, read with a memory ID for full metadata and Unicode-safe text pages, add only when the user explicitly asks to remember something, replace to correct a record by ID and expected revision, and forget to remove a record by ID and expected revision after an explicit current-user request. Continue read pages with the returned expectedRevision. Source evidence is bound by the host to the current foreground user message; source IDs cannot be supplied in arguments. Forgetting is memory-store forgetting, not full erasure from conversations or backups.`;

export const MEMORY_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['list', 'search', 'read', 'add', 'replace', 'forget'] },
    query: { type: 'string', description: 'Literal case-insensitive memory text search.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum records to return. Default 10.' },
    offset: { type: 'integer', minimum: 0, maximum: 10000, description: 'Record offset for list or search pagination.' },
    text: { type: 'string', description: 'Memory text for add or replacement.' },
    kind: { type: 'string', enum: ['fact', 'preference', 'note'], description: 'Memory kind for add, or optional kind correction for replace.' },
    memoryId: { type: 'string', description: 'Stable memory ID returned by list or search. Required for replace and forget.' },
    expectedRevision: { type: 'integer', minimum: 1, description: 'Memory revision returned by read/list/search. Required for replace, forget, and read continuations.' },
    textLimit: { type: 'integer', minimum: 1, maximum: 8000, description: 'Maximum Unicode code points for a read page. Default 4000.' },
  },
};

export const MAX_MEMORY_TOOL_OUTPUT_BYTES = 24_000;
const MAX_MEMORY_TOOL_LIMIT = 50;
const DEFAULT_MEMORY_TOOL_LIMIT = 10;
const MAX_MEMORY_TOOL_OFFSET = 10_000;
const MAX_MEMORY_TEXT_OFFSET = 16_000;
const MAX_QUERY_LENGTH = 500;
const MAX_ID_LENGTH = 100;
const MAX_TEXT_LENGTH = 16_000;
const MAX_RENDERED_TEXT = 4_000;
const MAX_READ_TEXT_LIMIT = 8_000;
const MAX_READ_EVIDENCE = 50;
const MAX_WRITE_TEXT_PREVIEW = 256;
const MEMORY_RESULT_TOO_LARGE = 'Memory result exceeds its output bound. Narrow the request.';
const MEMORY_PAGINATION_LIMIT = 'Memory pagination limit reached. Narrow the request.';
const ACTIONS = ['list', 'search', 'read', 'add', 'replace', 'forget'] as const;
type MemoryAction = (typeof ACTIONS)[number];
const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'note'];
const ALLOWED_FIELDS = new Set(['action', 'query', 'limit', 'offset', 'text', 'kind', 'memoryId', 'expectedRevision', 'textLimit']);

class MemoryToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryToolValidationError';
  }
}

function invalid(message: string): never {
  throw new MemoryToolValidationError(message);
}

function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Arguments must be an object.');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!ALLOWED_FIELDS.has(key)) invalid('Unknown memory field.');
  return input;
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`Invalid ${name}.`);
  return value.trim();
}

function integer(value: unknown, name: string, minimum: number, maximum: number, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`Invalid ${name}.`);
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid('Invalid expectedRevision.');
  return value;
}

function kind(value: unknown, required: boolean): MemoryKind | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !KINDS.includes(value as MemoryKind)) invalid('Invalid memory kind.');
  return value as MemoryKind;
}

function action(input: Record<string, unknown>): MemoryAction {
  if (typeof input.action !== 'string' || !ACTIONS.includes(input.action as MemoryAction)) invalid('Invalid memory action.');
  return input.action as MemoryAction;
}

function validateActionFields(input: Record<string, unknown>, selected: MemoryAction) {
  const accepted: Record<MemoryAction, readonly string[]> = {
    list: ['action', 'limit', 'offset'],
    search: ['action', 'query', 'limit', 'offset'],
    read: ['action', 'memoryId', 'expectedRevision', 'offset', 'textLimit'],
    add: ['action', 'text', 'kind'],
    replace: ['action', 'memoryId', 'expectedRevision', 'text', 'kind'],
    forget: ['action', 'memoryId', 'expectedRevision'],
  };
  for (const field of Object.keys(input)) if (!accepted[selected].includes(field)) invalid(`${selected} does not accept this field.`);
  if (selected === 'list') return;
  if (selected === 'search') {
    requiredString(input.query, 'query', MAX_QUERY_LENGTH);
    return;
  }
  if (selected === 'read') {
    requiredString(input.memoryId, 'memoryId', MAX_ID_LENGTH);
    if (input.expectedRevision !== undefined) revision(input.expectedRevision);
    integer(input.offset, 'offset', 0, MAX_MEMORY_TEXT_OFFSET, 0);
    integer(input.textLimit, 'textLimit', 1, MAX_READ_TEXT_LIMIT, DEFAULT_MEMORY_TOOL_LIMIT * 400);
    return;
  }
  if (selected === 'add') {
    requiredString(input.text, 'text', MAX_TEXT_LENGTH);
    kind(input.kind, true);
    return;
  }
  if (selected === 'forget') {
    requiredString(input.memoryId, 'memoryId', MAX_ID_LENGTH);
    revision(input.expectedRevision);
    return;
  }
  requiredString(input.memoryId, 'memoryId', MAX_ID_LENGTH);
  revision(input.expectedRevision);
  requiredString(input.text, 'text', MAX_TEXT_LENGTH);
  kind(input.kind, false);
}

function memoryMetadata(memory: MemoryRecord) {
  return {
    id: memory.id,
    revision: memory.revision,
    kind: memory.kind,
    state: memory.state,
    pinned: memory.pinned,
    core: memory.core,
    recordedAt: memory.recordedAt,
    validFrom: memory.validFrom,
    validUntil: memory.validUntil,
    textLength: Array.from(memory.text).length,
  };
}

/** List/search intentionally return snippets, never an implicit full record. */
function memoryView(memory: MemoryRecord) {
  const text = Array.from(memory.text).slice(0, MAX_RENDERED_TEXT).join('');
  return {
    ...memoryMetadata(memory),
    text,
    textComplete: false,
    textTruncated: Array.from(memory.text).length > MAX_RENDERED_TEXT,
  };
}

function writeMemoryView(memory: MemoryRecord) {
  const text = Array.from(memory.text).slice(0, MAX_WRITE_TEXT_PREVIEW).join('');
  return {
    ...memoryMetadata(memory),
    textPreview: text,
    textPreviewTruncated: Array.from(memory.text).length > MAX_WRITE_TEXT_PREVIEW,
  };
}

function forgetView(result: MemoryForgetResult) {
  return {
    success: true,
    mode: 'forget',
    memoryId: result.memoryId,
    expectedRevision: result.expectedRevision,
    alreadyForgotten: result.alreadyForgotten,
    scope: 'memory-store',
    conversationsRetained: true,
    backupsRetained: true,
    message: result.alreadyForgotten
      ? 'This memory-store record was already forgotten. Conversation history and backups were not erased.'
      : 'Forgotten from the memory store. Conversation history and backups were not erased.',
  };
}

function json(value: unknown, isError = false): { text: string; isError: boolean } {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') <= MAX_MEMORY_TOOL_OUTPUT_BYTES) return { text, isError };
  return {
    text: JSON.stringify({ success: false, error: 'Memory result exceeded its output bound. Narrow the request.' }),
    isError: true,
  };
}

const SAFE_ERROR_MESSAGES = new Set([
  'Memory tools are disabled by host configuration.',
  'Memory result exceeds its output bound. Narrow the request.',
  'Memory pagination limit reached. Narrow the request.',
  'Memory not found.',
  'Memory revision conflict.',
  'Memory has been forgotten.',
  'Memory source evidence was forgotten.',
  'Read continuation requires expectedRevision.',
  'Duplicate source evidence.',
  'Source message not found.',
  'Foreground evidence must cite the current user message.',
  'Streaming source cannot support evidence.',
  'Source revision conflict.',
  'Invalid memory id.',
  'Invalid memory search query.',
  'Invalid memory list limit.',
  'Invalid memory list offset.',
  'Invalid memory revision.',
  'Invalid expectedRevision.',
  'Invalid source revision.',
  'Invalid offset.',
  'Invalid textLimit.',
  'Invalid memory text.',
  'Invalid memory kind.',
  'Invalid validity interval.',
]);
const GENERIC_MEMORY_ERROR = 'Memory operation failed. Narrow the request and try again.';

function errorResult(error: unknown): { text: string; isError: true } {
  const message = error instanceof MemoryToolValidationError && SAFE_ERROR_MESSAGES.has(error.message)
    ? error.message
    : error instanceof Error && SAFE_ERROR_MESSAGES.has(error.message)
      ? error.message
      : GENERIC_MEMORY_ERROR;
  return json({ success: false, error: message }, true) as { text: string; isError: true };
}

function pagedResult(mode: 'list' | 'search', records: readonly MemoryRecord[], offset: number, limit: number, query?: string) {
  const views = [] as ReturnType<typeof memoryView>[];
  for (const record of records.slice(0, limit)) {
    const candidate = [...views, memoryView(record)];
    const candidateHasMore = candidate.length < records.length;
    const candidateNextOffset = candidateHasMore ? offset + candidate.length : null;
    if (candidateNextOffset !== null && candidateNextOffset > MAX_MEMORY_TOOL_OFFSET) throw new MemoryToolValidationError(MEMORY_PAGINATION_LIMIT);
    if (Buffer.byteLength(JSON.stringify({ success: true, mode, memories: candidate, nextOffset: candidateNextOffset, ...(query === undefined ? {} : { query }) }), 'utf8') > MAX_MEMORY_TOOL_OUTPUT_BYTES) {
      if (!views.length) throw new MemoryToolValidationError(MEMORY_RESULT_TOO_LARGE);
      break;
    }
    views.push(memoryView(record));
  }
  const hasMore = views.length < records.length;
  const nextOffset = hasMore ? offset + views.length : null;
  if (nextOffset !== null && nextOffset > MAX_MEMORY_TOOL_OFFSET) throw new MemoryToolValidationError(MEMORY_PAGINATION_LIMIT);
  return {
    success: true,
    mode,
    ...(query === undefined ? {} : { query }),
    memories: views,
    nextOffset,
  };
}

function sourceView(source: ForegroundSource) {
  return {
    messageId: source.sourceMessageId,
    revision: source.sourceRevision,
    role: 'user',
    attribution: 'host-bound current foreground user message',
  };
}

function writeView(mode: 'add' | 'replace', result: ForegroundMemoryWriteResult, source: ForegroundSource) {
  return {
    success: true,
    mode,
    created: result.created,
    memory: writeMemoryView(result.memory),
    evidence: {
      memoryRevision: result.evidence.memoryRevision,
      source: sourceView(source),
      stance: result.evidence.stance,
      valid: result.evidence.valid,
    },
  };
}

function readMemoryPage(read: MemoryRead, offset: number, requestedLimit: number) {
  const codePoints = Array.from(read.memory.text);
  const maxEnd = Math.min(codePoints.length, offset + requestedLimit);
  const evidence = read.evidence.slice(0, MAX_READ_EVIDENCE);
  const base = {
    success: true,
    mode: 'read',
    memory: memoryMetadata(read.memory),
    evidence,
    evidenceTruncated: evidence.length < read.evidence.length,
    offset,
  };
  let end = maxEnd;
  while (end >= offset) {
    const text = codePoints.slice(offset, end).join('');
    const nextOffset = end < codePoints.length ? end : null;
    const result = { ...base, text, textLimit: requestedLimit, nextOffset, textTruncated: nextOffset !== null };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_MEMORY_TOOL_OUTPUT_BYTES) return result;
    if (end === offset) break;
    end = offset + Math.floor((end - offset) / 2);
  }
  throw new MemoryToolValidationError(MEMORY_RESULT_TOO_LARGE);
}

export async function executeMemoryTool(
  repository: MemoryRepository,
  config: MemoryHostConfig,
  foregroundSource: ForegroundSource,
  signal: AbortSignal,
  rawInput: unknown,
): Promise<{ text: string; isError: boolean }> {
  signal.throwIfAborted();
  try {
    if (!config.enabled) return errorResult(new Error('Memory tools are disabled by host configuration.'));
    const input = inputObject(rawInput);
    const selected = action(input);
    validateActionFields(input, selected);
    if (selected === 'list' || selected === 'search') {
      const limit = integer(input.limit, 'limit', 1, MAX_MEMORY_TOOL_LIMIT, DEFAULT_MEMORY_TOOL_LIMIT);
      const offset = integer(input.offset, 'offset', 0, MAX_MEMORY_TOOL_OFFSET, 0);
      const records = selected === 'list'
        ? repository.list({ limit: Math.min(limit + 1, 100), offset })
        : repository.search(requiredString(input.query, 'query', MAX_QUERY_LENGTH), { limit: Math.min(limit + 1, 100), offset });
      signal.throwIfAborted();
      return json(pagedResult(selected, records, offset, limit, selected === 'search' ? requiredString(input.query, 'query', MAX_QUERY_LENGTH) : undefined));
    }
    if (selected === 'read') {
      const memoryId = requiredString(input.memoryId, 'memoryId', MAX_ID_LENGTH);
      const offset = integer(input.offset, 'offset', 0, MAX_MEMORY_TEXT_OFFSET, 0);
      const requestedLimit = integer(input.textLimit, 'textLimit', 1, MAX_READ_TEXT_LIMIT, DEFAULT_MEMORY_TOOL_LIMIT * 400);
      const expectedRevision = input.expectedRevision === undefined ? undefined : revision(input.expectedRevision);
      if (offset > 0 && expectedRevision === undefined) invalid('Read continuation requires expectedRevision.');
      const read = repository.read(memoryId);
      if (expectedRevision !== undefined && read.memory.revision !== expectedRevision) throw new Error('Memory revision conflict.');
      signal.throwIfAborted();
      return json(readMemoryPage(read, offset, requestedLimit));
    }
    if (selected === 'forget') {
      signal.throwIfAborted();
      const result = repository.forget(
        requiredString(input.memoryId, 'memoryId', MAX_ID_LENGTH),
        revision(input.expectedRevision),
        foregroundSource,
      );
      signal.throwIfAborted();
      return json(forgetView(result));
    }
    if (selected === 'add') {
      const text = requiredString(input.text, 'text', MAX_TEXT_LENGTH);
      const memoryKind = kind(input.kind, true)!;
      const result = repository.createWithForegroundEvidence({ text, kind: memoryKind }, foregroundSource);
      return json(writeView('add', result, foregroundSource));
    }
    const replacementKind = kind(input.kind, false);
    const result = repository.replaceWithForegroundEvidence(
      requiredString(input.memoryId, 'memoryId', MAX_ID_LENGTH),
      revision(input.expectedRevision),
      { text: requiredString(input.text, 'text', MAX_TEXT_LENGTH), ...(replacementKind === undefined ? {} : { kind: replacementKind }) },
      foregroundSource,
    );
    return json(writeView('replace', result, foregroundSource));
  } catch (error) {
    if (signal.aborted) throw error;
    return errorResult(error);
  }
}

export function memoryToolbag(
  repository: MemoryRepository,
  config: MemoryHostConfig | (() => MemoryHostConfig),
  foregroundSource: ForegroundSource | undefined,
  signal: AbortSignal,
): Toolbag {
  let closed = false;
  const currentConfig = () => typeof config === 'function' ? config() : config;
  const tools: AgentToolDef[] = foregroundSource && currentConfig().enabled
    ? [{ name: MEMORY_TOOL_NAME, description: MEMORY_TOOL_DESCRIPTION, inputSchema: MEMORY_TOOL_INPUT_SCHEMA }]
    : [];
  return {
    tools,
    execute: async (name, args) => {
      if (closed) throw new Error('Memory tools are closed.');
      const activeConfig = currentConfig();
      if (name !== MEMORY_TOOL_NAME || !foregroundSource || !activeConfig.enabled) throw new Error('Memory tool is disabled.');
      signal.throwIfAborted();
      return executeMemoryTool(repository, activeConfig, foregroundSource, signal, args);
    },
    close: () => { closed = true; },
  };
}

/** Compose independent built-ins while keeping the first exact name owner. */
export function composeBuiltInToolbags(bags: readonly Toolbag[]): Toolbag {
  let closed = false;
  const owners = new Map<string, Toolbag>();
  const tools: AgentToolDef[] = [];
  for (const bag of bags) {
    for (const tool of bag.tools) {
      if (owners.has(tool.name)) continue;
      owners.set(tool.name, bag);
      tools.push(tool);
    }
  }
  return {
    tools,
    execute: async (name, args) => {
      if (closed) throw new Error('Built-in tools are closed.');
      const owner = owners.get(name);
      if (!owner) throw new Error('Unknown built-in tool.');
      return owner.execute(name, args);
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const bag of bags) bag.close();
    },
  };
}
