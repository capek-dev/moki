import { WebSocket, WebSocketServer } from 'ws';
import {
  BROWSER_EXTENSION_CAPABILITIES,
  BROWSER_EXTENSION_PORT,
  BROWSER_EXTENSION_URL,
  isBrowserExtensionCall,
  type BrowserExtensionCall,
  type BrowserExtensionState,
} from '@shared/browser-extension';

const MESSAGE_LIMIT = 8 * 1024 * 1024;
const REGISTRATION_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 45_000;
const HEARTBEAT_MS = 30_000;
const allowedCapabilities = new Set<string>(BROWSER_EXTENSION_CAPABILITIES);

interface Descriptor {
  clientId: string;
  clientType: 'extension';
  displayName: string;
  interactionMode: 'headless';
  capabilities: string[];
}

interface PendingCall {
  requestId: string;
  capability: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function isBrowserExtensionOrigin(value: unknown): boolean {
  return typeof value === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(value);
}

function descriptor(value: unknown): Descriptor | undefined {
  const input = object(value);
  if (!input || typeof input.clientId !== 'string' || !input.clientId || input.clientId.length > 128) return;
  if (input.clientType !== 'extension' || input.interactionMode !== 'headless') return;
  if (typeof input.displayName !== 'string' || !input.displayName || input.displayName.length > 128) return;
  if (!Array.isArray(input.capabilities) || input.capabilities.length > BROWSER_EXTENSION_CAPABILITIES.length) return;
  if (!input.capabilities.every((item) => typeof item === 'string' && allowedCapabilities.has(item))) return;
  return { clientId: input.clientId, clientType: 'extension', displayName: input.displayName, interactionMode: 'headless', capabilities: [...new Set(input.capabilities)] };
}

export class BrowserExtensionHost {
  private server?: WebSocketServer;
  private socket?: WebSocket;
  private registered?: Descriptor;
  private pending = new Map<string, PendingCall>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private startError: string | null = null;

  constructor(
    private changed: (state: BrowserExtensionState) => void = () => {},
    private port = BROWSER_EXTENSION_PORT,
    private callTimeoutMs = CALL_TIMEOUT_MS,
  ) {}

  state(): BrowserExtensionState {
    return {
      connected: !!this.socket && this.socket.readyState === WebSocket.OPEN && !!this.registered,
      url: this.port === BROWSER_EXTENSION_PORT ? BROWSER_EXTENSION_URL : `http://127.0.0.1:${this.port}`,
      clientId: this.registered?.clientId ?? null,
      capabilities: this.registered ? [...this.registered.capabilities] : [],
      error: this.startError,
    };
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = new WebSocketServer({ host: '127.0.0.1', port: this.port, path: '/ws', maxPayload: MESSAGE_LIMIT });
    this.server = server;
    server.on('connection', (socket, request) => {
      if (!isBrowserExtensionOrigin(request.headers.origin)) { socket.close(1008, 'Chrome extension origin required'); return; }
      this.accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      const onListening = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); this.server = undefined; this.startError = `Browser extension bridge could not start: ${error.message}`; this.changed(this.state()); reject(error); };
      const cleanup = () => { server.off('listening', onListening); server.off('error', onError); };
      server.once('listening', onListening);
      server.once('error', onError);
    });
    this.startError = null;
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
    this.changed(this.state());
  }

  private accept(socket: WebSocket) {
    let registered = false;
    const registrationTimer = setTimeout(() => socket.close(1008, 'Registration required'), REGISTRATION_TIMEOUT_MS);
    registrationTimer.unref?.();
    socket.on('message', (data, binary) => {
      if (binary) { socket.close(1003, 'Text messages required'); return; }
      const size = Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.byteLength, 0) : data.byteLength;
      if (size > MESSAGE_LIMIT) { socket.close(1009, 'Message too large'); return; }
      let message: Record<string, unknown> | undefined;
      try { message = object(JSON.parse(data.toString())); } catch { socket.close(1007, 'Invalid JSON'); return; }
      if (!message) { socket.close(1007, 'Invalid message'); return; }
      if (!registered) {
        if (message.type !== 'client.register') { socket.close(1008, 'Registration required'); return; }
        const client = descriptor(message.client);
        if (!client) {
          socket.send(JSON.stringify({ type: 'client.rejected', code: 'invalid_client', message: 'Invalid extension descriptor.' }));
          socket.close(1008, 'Invalid client');
          return;
        }
        clearTimeout(registrationTimer);
        registered = true;
        if (this.socket && this.socket !== socket) this.socket.close(4000, 'Connection replaced');
        this.socket = socket;
        this.registered = client;
        socket.send(JSON.stringify({ type: 'client.registered', client, connectionId: crypto.randomUUID(), serverTime: Date.now() }));
        this.changed(this.state());
        return;
      }
      if (message.type === 'pong') return;
      if (message.type === 'ask.response') this.receiveResponse(message);
    });
    socket.on('close', () => {
      clearTimeout(registrationTimer);
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.registered = undefined;
      this.failPending(new Error('Browser extension disconnected.'));
      this.changed(this.state());
    });
    socket.on('error', () => { /* close reports the user-visible state */ });
  }

  private receiveResponse(message: Record<string, unknown>) {
    if (typeof message.toolCallId !== 'string') return;
    const pending = this.pending.get(message.toolCallId);
    if (!pending || message.requestId !== pending.requestId) return;
    const response = object(message.response);
    if (!response || response.type !== 'client_capability' || response.capability !== pending.capability || !('result' in response)) {
      this.settle(message.toolCallId, new Error('Browser extension returned an invalid response.'));
      return;
    }
    this.settle(message.toolCallId, undefined, response.result);
  }

  async call(call: BrowserExtensionCall): Promise<unknown> {
    if (!isBrowserExtensionCall(call)) throw new Error('Invalid browser extension call.');
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.registered?.capabilities.includes(call.capability)) {
      throw new Error('Prokop Browser extension is not connected.');
    }
    if (this.pending.has(call.callId)) throw new Error('Duplicate browser extension call.');
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(call.callId, new Error('Browser extension did not respond in time.')), this.callTimeoutMs);
      timer.unref?.();
      this.pending.set(call.callId, { requestId, capability: call.capability, resolve, reject, timer });
      try {
        this.socket!.send(JSON.stringify({
          type: 'ask.request',
          sessionId: 'moki',
          toolCallId: call.callId,
          toolName: call.toolName,
          requestId,
          ask: { type: 'client_capability', capability: call.capability, metadata: { task: call.task, params: call.params } },
        }));
      } catch (error) {
        this.settle(call.callId, error instanceof Error ? error : new Error('Browser extension request failed.'));
      }
    });
  }

  cancel(callId: string) {
    this.settle(callId, new Error('Browser extension call cancelled.'));
  }

  private settle(callId: string, error?: Error, result?: unknown) {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(result);
  }

  private failPending(error: Error) {
    for (const callId of [...this.pending.keys()]) this.settle(callId, error);
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.failPending(new Error('Browser extension bridge closed.'));
    const socket = this.socket;
    this.socket = undefined;
    this.registered = undefined;
    socket?.terminate();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.changed(this.state());
  }
}
