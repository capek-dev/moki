import type { Provider } from '@shared/protocol';

// Initial curated catalog from Jean2's provider configuration. Availability is
// decided by the provider, not inferred from a successful OAuth login.
// contextWindow and maxOutputTokens come from the verified Jean2
// packages/server/src/config/models.json entries for these model IDs.
export const MODELS: { id: string; name: string; provider: Provider; imageInput: boolean; contextWindow: number; maxOutputTokens: number }[] = [
  { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', provider: 'deepseek', imageInput: true, contextWindow: 1000000, maxOutputTokens: 384000 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'codex', imageInput: true, contextWindow: 372000, maxOutputTokens: 128000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'codex', imageInput: true, contextWindow: 372000, maxOutputTokens: 128000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'codex', imageInput: true, contextWindow: 372000, maxOutputTokens: 128000 },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', provider: 'codex', imageInput: true, contextWindow: 372000, maxOutputTokens: 128000 },
];
export function requireModel(provider: unknown, model: unknown) {
  const found = MODELS.find((item) => item.provider === provider && item.id === model);
  if (!found) throw new Error('Select a supported model for this provider.');
  return found;
}
export function defaultModel(provider: Provider): string { return MODELS.find((item) => item.provider === provider)!.id; }
export function supportsImageInput(provider: Provider, model: string): boolean { return requireModel(provider, model).imageInput; }

export type Thinking = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export function thinkingLevels(provider: Provider, model: string): Thinking[] {
  requireModel(provider, model);
  if (provider === 'deepseek') return ['high', 'max'];
  return ['low', 'medium', 'high', 'xhigh', 'max'];
}
export function requireThinking(provider: Provider, model: string, value: unknown): Thinking | null {
  const supported = thinkingLevels(provider, model);
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !supported.includes(value as Thinking)) throw new Error('Select a supported thinking level for this model.');
  return value as Thinking;
}
