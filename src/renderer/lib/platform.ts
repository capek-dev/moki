/** macOS gets inset traffic lights and window vibrancy; others get plain windows. */
export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
export const platformClass = isMac ? 'platform-mac' : undefined;
