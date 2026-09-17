import { useEffect, useReducer, useState } from 'react';
import type { Appearance } from '@shared/appearance';

// The app tone is the user's accent color for the whole UI. "auto" follows the
// palette of the companion they chat with, so the chrome matches the avatar.

export const TONES = {
  graphite: { name: 'Graphite', light: '#4a4b52', dark: '#a7a8b3' },
  lavender: { name: 'Lavender', light: '#6f5a9e', dark: '#a98fd6' },
  peach:    { name: 'Peach',    light: '#b3705e', dark: '#e3a58f' },
  mint:     { name: 'Mint',     light: '#3f7c74', dark: '#82c0b4' },
  sky:      { name: 'Sky',      light: '#4f74b3', dark: '#93b4e0' },
  ocean:    { name: 'Ocean',    light: '#2e6fbd', dark: '#7ab1e8' },
  rose:     { name: 'Rose',     light: '#bc5876', dark: '#e899ad' },
  moss:     { name: 'Moss',     light: '#5d8a4a', dark: '#a3c585' },
} as const;

export type FixedTone = keyof typeof TONES;
export type ToneChoice = 'auto' | FixedTone;
export const DEFAULT_TONE: ToneChoice = 'auto';
export const TONE_KEY = 'moki:tone';
export const PALETTE_KEY = 'moki:palette';

/** Each avatar palette maps to the tone that matches it. */
const PALETTE_TONE: Record<Appearance['palette'], FixedTone> = {
  lavender: 'lavender', peach: 'peach', mint: 'mint', sky: 'sky',
};

const store = {
  get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Private mode or test host: tone stays for this session only. */ } },
};

export function readToneChoice(): ToneChoice {
  const value = store.get(TONE_KEY) ?? store.get('povondra:tone');
  return value === 'auto' || (value !== null && value in TONES) ? value as ToneChoice : DEFAULT_TONE;
}

/** The chat window records which companion palette is active so Settings can follow it. */
export function rememberPalette(palette: Appearance['palette']) { store.set(PALETTE_KEY, palette); }
export function activePalette(): Appearance['palette'] | undefined {
  const value = store.get(PALETTE_KEY) ?? store.get('povondra:palette');
  return value !== null && value in PALETTE_TONE ? value as Appearance['palette'] : undefined;
}

export function resolveTone(choice: ToneChoice, palette?: Appearance['palette']): FixedTone {
  if (choice !== 'auto') return choice;
  return PALETTE_TONE[palette ?? activePalette() ?? 'lavender'];
}

type StyleTarget = { style: { setProperty(name: string, value: string): void } };
export function applyTone(tone: FixedTone, target: StyleTarget = document.documentElement) {
  target.style.setProperty('--tone-light', TONES[tone].light);
  target.style.setProperty('--tone-dark', TONES[tone].dark);
}

/** Applies the tone and keeps following choice and palette changes, including edits made in the other window. */
export function useTone(palette?: Appearance['palette']) {
  const [choice, setChoice] = useState<ToneChoice>(readToneChoice);
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    // The storage event fires in the other window, so Settings edits retune the chat window live.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== TONE_KEY && event.key !== PALETTE_KEY) return;
      setChoice(readToneChoice());
      refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => { applyTone(resolveTone(choice, palette)); }, [choice, palette]);
  return {
    choice,
    choose(next: ToneChoice) { store.set(TONE_KEY, next); setChoice(next); },
  };
}
