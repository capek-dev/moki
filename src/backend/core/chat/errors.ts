export function userFacingTurnError(error: unknown): string {
  if (error instanceof Error && error.name === 'ContextBudgetError') {
    return error.message;
  }

  const status = (error as { statusCode?: number })?.statusCode;
  if (status === 401 || status === 403) {
    return 'Provider rejected access. Reconnect it in Settings.';
  }
  if (status === 429) {
    return 'Provider limit reached. Wait before sending another message.';
  }
  if (status === 400 || status === 404) {
    return 'This model or request is unavailable. Select another model.';
  }
  return 'Reply failed. Check your connection and provider settings. No automatic retry was made.';
}
