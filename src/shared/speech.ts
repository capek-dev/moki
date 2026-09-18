// Pure helpers deciding what part of a streaming reply is speakable (plan 17
// phase A). The renderer diffs these segments against what it already sent to
// the main-process speech synthesizer, so spoken audio tracks the streaming
// text without replaying anything.

// Markdown flourishes that should never be read aloud.
const URL = /https?:\/\/\S+/g;
const INLINE_CODE = /`([^`]*)`/g;
const MARKUP = /[*_~>#]+/g;
const LIST_BULLET = /^\s*[-*+]\s+/gm;

export interface SpeechSegments { segments: string[] }

// Returns the complete, speakable sentences contained in `text`.
// - Fenced code blocks are skipped entirely (an unterminated fence swallows
//   the rest; the reply's completion flush will not read it either).
// - Inline code spans, URLs and emphasis markers are stripped.
// - A trailing fragment without terminal punctuation is held back unless
//   `flush` is set (the reply finished, so it is the last of the text).
// - Segments are capped so one call cannot hand the synthesizer a wall.
export function speechSegments(text: string, { flush = false }: { flush?: boolean } = {}): string[] {
  if (!text) return [];
  const speakableLines: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    let cleaned = line
      .replace(INLINE_CODE, (_match, code: string) => ` ${code} `) // code itself is often a name worth saying
      .replace(URL, ' ')
      .replace(MARKUP, '')
      .replace(LIST_BULLET, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) speakableLines.push(cleaned);
  }
  const joined = speakableLines.join(' ').trim();
  if (!joined) return [];
  // Sentence boundaries: ., !, ? (also …) followed by whitespace or end.
  const parts = joined.split(/(?<=[.!?…])\s+/).filter((part) => part.trim());
  const complete = parts.slice(0, -1);
  const tail = parts.at(-1) ?? '';
  const tailDone = /[.!?…]\s*$/.test(tail);
  if (tailDone) complete.push(tail);
  else if (flush) complete.push(tail.trim());
  // Segments are append-only: each complete sentence is its own stable entry
  // and never changes as more text streams. (An earlier design merged short
  // fragments for prosody — that mutated already-spoken segments and made the
  // renderer's spoken-offset tracking skip everything merged into them.)
  return complete
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((part) => (part.length > 1200 ? `${part.slice(0, 1200)}…` : part));
}
