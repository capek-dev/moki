// Push-to-talk dictation (plan 17 phase B): a thin, typed wrapper over the
// Web Speech API living in the renderer. macOS ships local dictation models,
// so recognition works offline with no accounts and nothing leaves the
// machine. This module stays pure-testable: no DOM globals at module scope
// (only inside functions), so the settings-window VM harness never trips on
// it and the renderer lint rules stay satisfied.

export interface DictationEvent { transcript: string; final: boolean }
export interface DictationSession { stop(): void }

export interface DictationControl {
  start(onEvent: (event: DictationEvent) => void, onError: (message: string) => void): DictationSession | null;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

// Looked up lazily: the settings-window VM runs the built bundle without DOM
// globals, and tests inject a fake through `env`.
function recognitionConstructor(env: Record<string, unknown>): SpeechRecognitionConstructor | null {
  const holder = env as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const found = holder.SpeechRecognition ?? holder.webkitSpeechRecognition;
  return typeof found === 'function' ? found as SpeechRecognitionConstructor : null;
}

// The state machine, extracted so tests can drive it without a recognizer:
// finalize-once semantics, stop-idempotence, and error mapping. The renderer
// owns hold/click gestures; this owns correctness.
export function createDictationMachine() {
  let stopped = false;
  let finished = false;
  return {
    // Interim and final results both flow through; the machine keeps the
    // surface semantics (first finalize wins, later events ignored).
    handleResult(event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }, emit: (event: DictationEvent) => void) {
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        const transcript = String(result[0]?.transcript ?? '').trim();
        if (!transcript) continue;
        emit({ transcript, final: result.isFinal === true });
      }
    },
    mapError(error: string | undefined): string {
      switch (error) {
        case 'not-allowed':
        case 'service-not-allowed':
          return 'Microphone access was denied. Allow it in System Settings and try again.';
        case 'no-speech':
          return 'No speech was heard. Hold the button and speak after the beep-feel.';
        case 'aborted':
          return ''; // user-initiated stop; not an error worth showing
        default:
          return error === 'network' ? 'Dictation is unavailable right now. Try again.' : 'Dictation stopped unexpectedly. Try again.';
      }
    },
    // Stop is idempotent; the wrapper calls both end-of-life paths.
    stop(recognition: SpeechRecognitionLike) {
      if (stopped) return;
      stopped = true;
      try { recognition.stop(); }
      catch { try { recognition.abort(); } catch { /* already gone */ } }
    },
    finalize(): boolean {
      if (finished) return false;
      finished = true;
      return true;
    },
  };
}

// The production control bound to the real Web Speech API.
export const dictation: DictationControl = {
  start(onEvent, onError) {
    const Recognition = recognitionConstructor(globalThis as unknown as Record<string, unknown>);
    if (!Recognition) { onError('Dictation is not supported in this window.'); return null; }
    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    const machine = createDictationMachine();
    let settled = false;
    recognition.onresult = (event) => machine.handleResult(event, onEvent);
    recognition.onerror = (event) => {
      if (settled) return;
      const message = machine.mapError(event?.error);
      if (message) { settled = true; onError(message); }
    };
    recognition.onend = () => {
      if (settled) return;
      settled = true;
      if (machine.finalize()) onEvent({ transcript: '', final: true });
    };
    // A stuck session (recognizer never fires end) must not hold the mic:
    // the watchdog ends it after 20s of no events.
    let lastActivity = Date.now();
    const touch = () => { lastActivity = Date.now(); };
    const originalOnResult = recognition.onresult;
    recognition.onresult = (event) => { touch(); originalOnResult?.(event); };
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > 20000) {
        clearInterval(watchdog);
        machine.stop(recognition);
      }
    }, 1000);
    const teardown = () => { clearInterval(watchdog); };
    const session: DictationSession = {
      stop() {
        teardown();
        machine.stop(recognition);
      },
    };
    try { recognition.start(); }
    catch {
      teardown();
      return null;
    }
    return session;
  },
};
