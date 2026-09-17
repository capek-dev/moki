import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ChatRequest, Request, Result } from '../shared/protocol';
import type { Credentials } from '../backend/chat';

export class Runtime {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (result: Result) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private stopped = false;
  private closing?: Promise<void>;
  readonly ready: Promise<void>;
  constructor(executable: string, dataDir: string, private changed: (result: Result) => void = () => {}, private failed: (message: string) => void = () => {}) {
    this.child = spawn(executable, [], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MOKI_DATA_DIR: dataDir },
    });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Runtime startup timed out.')); this.child.kill(); }, 15000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        const wasStopped = this.stopped;
        this.stopped = true;
        if (!wasStopped) this.failed('The chat runtime stopped. Quit and reopen Moki to reconnect.');
        reject(error);
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
        this.pending.clear();
      };
      this.child.on('error', fail);
      this.child.stdin.on('error', (error) => { fail(error); this.child.kill(); });
      this.child.on('exit', () => fail(new Error('Runtime stopped. Reopen Moki to reconnect.')));
      const lines = createInterface({ input: this.child.stdout });
      lines.on('line', (line) => {
        if (this.stopped) return;
        try {
          const response = JSON.parse(line);
          if (response.event === 'ready') {
            if (response.bun !== '1.4.0' || !response.capekExports) throw new Error('Runtime compatibility check failed.');
            clearTimeout(timer); resolve(); return;
          }
          if (response.event === 'state') { this.changed(response.result); return; }
          const item = this.pending.get(response.id);
          if (!item) return;
          this.pending.delete(response.id); clearTimeout(item.timer);
          if (response.error) item.reject(new Error(response.error));
          else item.resolve(response.result);
        } catch { fail(new Error('Invalid runtime response.')); this.child.kill(); }
      });
    });
    // Drain stderr without exposing internal output or future credentials to the renderer.
    this.child.stderr.resume();
  }
  startChat(request: ChatRequest, credentials: Credentials): Promise<Result> {
    return this.send({ method: 'startChat', conversationId: request.conversationId, text: request.text, model: request.model, thinking: request.thinking, credentials });
  }
  request(request: Request): Promise<Result> { return this.send(request); }
  private async send(request: unknown): Promise<Result> {
    await this.ready;
    if (this.stopped) throw new Error('Runtime is unavailable.');
    const payload = JSON.stringify({ id: crypto.randomUUID(), request });
    if (Buffer.byteLength(payload) > 128 * 1024) throw new Error('Request too large.');
    const { id } = JSON.parse(payload) as { id: string };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Request timed out. No automatic retry was made.')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(payload + '\n', (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    this.closing = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); }, 2000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
    });
    return this.closing;
  }
}
