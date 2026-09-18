// Dictation protocol shared by the native helper, the Electron service, and
// the renderer (plan 17 phase B). The engine is a small Swift binary
// (src/native/moki-dictate.swift) using SFSpeechRecognizer, spawned by the
// main process; the Web Speech API was abandoned because Electron's Chromium
// ships without Google's speech backend, so recognition uploads always fail.
// This module stays pure (JSON parsing and string mapping only) so the
// settings-window VM harness and renderer lint rules stay clean.

// One stdout line from the helper. Error lines carry a short code the
// renderer maps to a friendly message.
export type HelperLine =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string };

export function parseHelperLine(line: string): HelperLine | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as { type?: unknown; text?: unknown; message?: unknown };
  if (candidate.type === 'partial' || candidate.type === 'final') {
    return typeof candidate.text === 'string' && candidate.text.trim() && candidate.text.length <= 2000
      ? { type: candidate.type, text: candidate.text.trim() }
      : null;
  }
  if (candidate.type === 'error') {
    return typeof candidate.message === 'string' && candidate.message.trim() && candidate.message.length <= 100
      ? { type: 'error', message: candidate.message.trim() }
      : null;
  }
  return null;
}

// Helper error codes mapped to messages the chat window shows. The
// "System Settings" wording is load-bearing: the error banner matches on it
// to offer the matching Open Settings shortcut.
export function mapDictationError(code: string): string {
  switch (code) {
    case 'mic-denied':
      return 'Microphone access was denied. Allow it in System Settings and try again.';
    case 'speech-denied':
      return 'Speech recognition was not allowed. Allow Moki in System Settings and try again.';
    case 'no-mic':
      return 'No microphone was found. Connect one and try again.';
    case 'no-speech':
      return 'No speech was heard. Hold the button and speak.';
    case 'unavailable':
      return 'Dictation is not available on this Mac.';
    default:
      return 'Dictation stopped. Try again.';
  }
}
