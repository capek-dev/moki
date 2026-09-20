export function dateLabel(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Date unknown' : new Date(value).toLocaleString();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Memory request failed.';
}
