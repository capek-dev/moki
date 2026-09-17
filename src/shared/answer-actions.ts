// Only plain text may cross the clipboard boundary. No clipboard reads or HTML writes.
export function requireCopyText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1_000_000) throw new Error('Invalid clipboard text.');
  return value;
}

export function webLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192 || !/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return;
    return url.href;
  } catch { return; }
}

export function requireWebLink(value: unknown): string {
  const url = webLink(value);
  if (!url) throw new Error('Only HTTP(S) links without credentials can be opened.');
  return url;
}
