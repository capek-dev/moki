export interface ToolLoadingState { enabled: boolean; maxDirect: number; configured: boolean }
export type ToolLoadingCommand = { action: 'status' } | { action: 'save'; enabled: boolean; maxDirect: number; key?: string } | { action: 'disconnect' };
/** Private Electron-to-runtime payload. Never returned in a state snapshot. */
export interface ToolLoadingConfig { enabled: boolean; maxDirect: number; key?: string }
export function requireToolLoading(value: unknown): ToolLoadingConfig {
  const data = value as ToolLoadingConfig;
  if (!data || typeof data.enabled !== 'boolean' || !Number.isInteger(data.maxDirect) || data.maxDirect < 0 || data.maxDirect > 64
    || (data.key !== undefined && (typeof data.key !== 'string' || !data.key.trim() || data.key.length > 1000 || /[\r\n]/.test(data.key)))) throw new Error('Invalid smart-loading settings.');
  return { enabled: data.enabled, maxDirect: data.maxDirect, ...(data.key ? { key: data.key.trim() } : {}) };
}
