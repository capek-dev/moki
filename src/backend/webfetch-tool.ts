import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import TurndownService from 'turndown';
import type { Toolbag } from '@backend/cua';

export const WEBFETCH_TOOL_NAME = 'webfetch';
export const WEBFETCH_TOOL_DESCRIPTION = `Fetch a public HTTP or HTTPS URL and return readable content.
Use markdown for web pages, text for plain text, or html for the original markup. No approval prompt is shown.
Local, private, link-local, metadata, and otherwise non-public network destinations are blocked, including redirects.`;

export const WEBFETCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', description: 'Public URL to fetch. Must start with http:// or https://.' },
    format: { type: 'string', enum: ['markdown', 'text', 'html'], description: 'Output format. Defaults to markdown.' },
    timeout: { type: 'number', minimum: 1, maximum: 120, description: 'Timeout in seconds. Defaults to 30 and cannot exceed 120.' },
  },
  required: ['url'],
};

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const USER_AGENT = 'capek-dev/moki';
const BLOCKED_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata.googleusercontent.com',
]);
const ALLOWED_FIELDS = new Set(['url', 'format', 'timeout']);
const FORMATS = new Set(['markdown', 'text', 'html']);

type WebfetchFormat = 'markdown' | 'text' | 'html';
type ResolveHost = (hostname: string) => Promise<readonly string[]>;
type RequestAddress = (url: URL, address: string, signal: AbortSignal) => Promise<Response>;

export interface WebfetchDependencies {
  fetcher?: typeof fetch;
  resolveHost?: ResolveHost;
  requestAddress?: RequestAddress;
}

class WebfetchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebfetchValidationError';
  }
}

function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WebfetchValidationError('Arguments must be an object.');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!ALLOWED_FIELDS.has(key)) throw new WebfetchValidationError(`Unknown webfetch field: ${key}.`);
  return input;
}

function parseInput(value: unknown): { url: URL; format: WebfetchFormat; timeoutMs: number } {
  const input = inputObject(value);
  if (typeof input.url !== 'string' || !input.url.trim() || input.url.length > 8_192) throw new WebfetchValidationError('Invalid url.');
  let url: URL;
  try { url = new URL(input.url); }
  catch { throw new WebfetchValidationError('Invalid url.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebfetchValidationError('Only HTTP and HTTPS URLs are allowed.');
  if (url.username || url.password) throw new WebfetchValidationError('URLs containing credentials are not allowed.');
  const format = input.format === undefined ? 'markdown' : input.format;
  if (typeof format !== 'string' || !FORMATS.has(format)) throw new WebfetchValidationError('Invalid format.');
  const timeout = input.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : input.timeout;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) throw new WebfetchValidationError('Invalid timeout.');
  return { url, format: format as WebfetchFormat, timeoutMs: timeout * 1_000 };
}

function blockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function blockedIp(address: string): boolean {
  if (isIP(address) === 4) return blockedIpv4(address);
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return blockedIpv4(mapped);
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:');
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname)) return [hostname];
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function publicAddresses(url: URL, resolveHost: ResolveHost, signal: AbortSignal): Promise<readonly string[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || BLOCKED_HOSTS.has(hostname)) {
    throw new WebfetchValidationError(`Blocked non-public host: ${hostname || '(empty)'}.`);
  }
  if (isIP(hostname) && blockedIp(hostname)) throw new WebfetchValidationError(`Blocked non-public host: ${hostname}.`);
  let addresses: readonly string[];
  try {
    addresses = await new Promise<readonly string[]>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      resolveHost(hostname).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new WebfetchValidationError(`Could not resolve host: ${hostname}.`);
  }
  if (!addresses.length || addresses.some(blockedIp)) throw new WebfetchValidationError(`Blocked non-public host: ${hostname}.`);
  return [...new Set(addresses)].sort((left, right) => Number(isIP(right) === 4) - Number(isIP(left) === 4));
}

function requestAddress(url: URL, address: string, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = requester({
      protocol: url.protocol,
      hostname: address,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      signal,
      headers: {
        Host: url.host,
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
      },
      ...(url.protocol === 'https:' ? { servername: isIP(hostname) ? undefined : hostname } : {}),
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
        else if (value !== undefined) headers.set(name, value);
      }
      const status = incoming.statusCode ?? 500;
      const body = status === 204 || status === 205 || status === 304
        ? null
        : Readable.toWeb(incoming) as unknown as BodyInit;
      resolve(new Response(body, { status, statusText: incoming.statusMessage, headers }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function pinnedFetch(
  url: URL,
  addresses: readonly string[],
  signal: AbortSignal,
  request: RequestAddress = requestAddress,
): Promise<Response> {
  let lastError: unknown;
  for (const address of addresses) {
    signal.throwIfAborted();
    try {
      return await request(url, address, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw new Error(`Could not connect to ${url.hostname}.`, { cause: lastError });
}

async function readBounded(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > MAX_RESPONSE_BYTES) throw new WebfetchValidationError('Response exceeds the 5 MB limit.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new WebfetchValidationError('Response exceeds the 5 MB limit.');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function titleFrom(content: string, fallback: string): string {
  const match = content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]).slice(0, 500) || fallback : fallback;
}

function render(content: string, contentType: string, format: WebfetchFormat): string {
  if (format === 'html') return content;
  if (format === 'text') return contentType.includes('html') ? stripHtml(content) : content;
  if (!contentType.includes('html')) return content;
  return new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(content);
}

function resultText(url: URL, title: string, contentType: string, content: string): string {
  const truncated = content.length > MAX_OUTPUT_CHARS;
  const body = truncated ? `${content.slice(0, MAX_OUTPUT_CHARS)}\n\n…[truncated]` : content;
  return [`Title: ${title}`, `URL: ${url.toString()}`, `Content-Type: ${contentType || 'unknown'}`, '', body].join('\n');
}

function errorDetail(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  const own = [code, error.message].filter(Boolean).join(': ');
  const cause = (error as { cause?: unknown }).cause;
  return depth < 2 && cause !== undefined ? `${own}; ${errorDetail(cause, depth + 1)}` : own;
}

function safeErrorDetail(error: unknown): string {
  return errorDetail(error).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown network error';
}

export async function executeWebfetch(
  rawInput: unknown,
  signal: AbortSignal,
  dependencies: WebfetchDependencies = {},
): Promise<{ text: string; isError: boolean }> {
  let timeoutSignal: AbortSignal | undefined;
  try {
    const input = parseInput(rawInput);
    const fetcher = dependencies.fetcher;
    const resolveHost = dependencies.resolveHost ?? defaultResolveHost;
    timeoutSignal = AbortSignal.timeout(input.timeoutMs);
    const requestSignal = AbortSignal.any([signal, timeoutSignal]);
    let current = input.url;

    for (let redirects = 0; ; redirects++) {
      requestSignal.throwIfAborted();
      const addresses = await publicAddresses(current, resolveHost, requestSignal);
      requestSignal.throwIfAborted();
      const response = fetcher
        ? await fetcher(current, { method: 'GET', redirect: 'manual', signal: requestSignal })
        : await pinnedFetch(current, addresses, requestSignal, dependencies.requestAddress);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')?.trim();
        if (!location) throw new WebfetchValidationError(`Redirect ${response.status} did not include a location.`);
        if (redirects >= MAX_REDIRECTS) throw new WebfetchValidationError(`Too many redirects (maximum ${MAX_REDIRECTS}).`);
        current = new URL(location, current);
        if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new WebfetchValidationError('Redirected to a non-HTTP URL.');
        if (current.username || current.password) throw new WebfetchValidationError('Redirected to a URL containing credentials.');
        continue;
      }
      if (!response.ok) throw new WebfetchValidationError(`Request failed with status ${response.status}.`);
      const raw = await readBounded(response);
      requestSignal.throwIfAborted();
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      const output = render(raw, contentType, input.format);
      return { text: resultText(current, titleFrom(raw, current.toString()), contentType, output), isError: false };
    }
  } catch (error) {
    if (signal.aborted) throw error;
    const message = timeoutSignal?.aborted || (error instanceof Error && error.name === 'TimeoutError')
      ? 'Request timed out.'
      : error instanceof WebfetchValidationError
        ? error.message
        : `Network request failed: ${safeErrorDetail(error)}`;
    console.error(`[moki] webfetch failed: ${safeErrorDetail(error)}`);
    return { text: message, isError: true };
  }
}

export function webfetchToolbag(signal: AbortSignal, dependencies: WebfetchDependencies = {}): Toolbag {
  let closed = false;
  return {
    tools: [{ name: WEBFETCH_TOOL_NAME, description: WEBFETCH_TOOL_DESCRIPTION, inputSchema: WEBFETCH_INPUT_SCHEMA }],
    execute: async (name, args) => {
      if (closed) throw new Error('Web fetch is closed.');
      if (name !== WEBFETCH_TOOL_NAME) throw new Error('Unknown built-in tool.');
      signal.throwIfAborted();
      return executeWebfetch(args, signal, dependencies);
    },
    close: () => { closed = true; },
  };
}
