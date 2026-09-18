import { spawn, type ChildProcess } from 'node:child_process';

// Spoken replies (plan 17 phase A): macOS `say` wrapped in a small queue.
// Zero dependencies, fully offline, no audio files in the renderer — main
// synthesizes and pushes speaking-state events the UI reacts to. stop()
// kills the current utterance and empties the queue (the companion click
// and the Stop button both route here; a barge-in gesture later reuses it).

export class SpeechSynth {
  private queue: string[] = [];
  private current?: ChildProcess;
  private speaking = false;
  private closed = false;
  private lastText = '';
  private listeners = new Set<(speaking: boolean) => void>();

  onChange(listener: (speaking: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit() { for (const listener of [...this.listeners]) listener(this.speaking); }

  // One utterance per call; segments queue in order. Duplicate consecutive
  // text is dropped (React effect double-runs must not repeat audio).
  speakText(text: string) {
    if (this.closed || !text.trim()) return;
    if (text === this.lastText && (this.speaking || this.queue.length)) return;
    this.lastText = text;
    this.queue.push(text);
    this.pump();
  }

  private pump() {
    if (this.current) return;
    if (!this.queue.length) {
      if (this.speaking) { this.speaking = false; this.emit(); }
      return;
    }
    const text = this.queue.shift()!;
    this.speaking = true;
    this.emit();
    try {
      // Text rides stdin, not argv, so reply content never shows in `ps`.
      this.current = spawn('say', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (error) {
      console.error('[moki] speech failed to start:', error instanceof Error ? error.message : String(error));
      this.current = undefined;
      this.speaking = false;
      this.emit();
      this.pump();
      return;
    }
    const child = this.current;
    const finish = () => {
      if (this.current !== child) return;
      this.current = undefined;
      this.pump();
    };
    child.on('error', (error) => {
      console.error('[moki] speech failed:', error instanceof Error ? error.message : String(error));
      finish();
    });
    child.on('exit', finish);
    child.stdin!.on('error', () => { /* EPIPE when killed mid-write; exit still fires. */ });
    child.stdin!.write(text);
    child.stdin!.end();
  }

  stop() {
    this.queue = [];
    this.lastText = '';
    this.current?.kill('SIGKILL'); // exit handler runs pump(), which settles the state
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stop();
  }
}
