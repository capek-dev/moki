function statusPart(error: Record<string, unknown>): string | undefined {
  const status = error.statusCode ?? error.status;
  return typeof status === 'number' || typeof status === 'string' ? `status ${status}` : undefined;
}

export function describeError(error: unknown, depth = 0): string {
  if (depth > 3) return String(error);
  if (error instanceof Error) {
    const parts = [error.name, error.message];
    const status = statusPart(error as unknown as Record<string, unknown>);
    if (status) parts.push(status);
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) parts.push(`cause: ${describeError(cause, depth + 1)}`);
    return parts.filter(Boolean).join(' · ');
  }
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof value.name === 'string') parts.push(value.name);
    if (typeof value.message === 'string') parts.push(value.message);
    const status = statusPart(value);
    if (status) parts.push(status);
    if (value.error !== undefined && value.error !== error) parts.push(`error: ${describeError(value.error, depth + 1)}`);
    if (value.cause !== undefined && value.cause !== error) parts.push(`cause: ${describeError(value.cause, depth + 1)}`);
    if (parts.length) return parts.join(' · ');
  }
  return String(error);
}

export function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(describeError(error));
}
