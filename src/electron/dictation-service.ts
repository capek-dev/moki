import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseHelperLine } from '@shared/dictation';

// The dictation engine (plan 17 B): a native macOS helper process. Main
// spawns it on mic-hold, forwards its stdout events to the window that
// started the session, and stops it by closing stdin (the button release).
// One session at a time, matching the single mic button.

export interface DictationPushEvent { transcript?: string; final?: boolean; error?: string }

export class DictationService {
  private child?: ChildProcessWithoutNullStreams;
  private push?: (event: DictationPushEvent) => void;

  start(helperPath: string, push: (event: DictationPushEvent) => void) {
    if (this.child) return; // one session at a time; the renderer guards too
    let spawned: ChildProcessWithoutNullStreams;
    try {
      spawned = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      push({ error: 'unavailable' });
      return;
    }
    const child = spawned;
    child.stderr.resume(); // Drain diagnostics; never surfaced to the renderer.
    this.child = child;
    this.push = push;
    child.on('error', () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.push?.({ error: 'unavailable' });
    });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = undefined;
      // A clean end without a final result still settles the renderer's
      // indicator (60s cap, silent stop).
      this.push?.({ final: true, transcript: '' });
    });
    createInterface({ input: child.stdout }).on('line', (line: string) => {
      if (this.child !== child) return;
      const parsed = parseHelperLine(line);
      if (!parsed) return;
      if (parsed.type === 'error') this.push?.({ error: parsed.message });
      else this.push?.({ transcript: parsed.text, final: parsed.type === 'final' });
    });
  }

  // Release: stdin EOF is the helper's graceful stop signal.
  stop() {
    const child = this.child;
    if (!child) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    timer.unref();
  }

  close() {
    try { this.child?.kill('SIGKILL'); } catch { /* gone */ }
    this.child = undefined;
    this.push = undefined;
  }
}
