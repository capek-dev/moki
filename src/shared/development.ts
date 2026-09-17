// The development origin is fixed so renderer IPC never trusts arbitrary URLs.
export const DEV_ORIGIN = 'http://127.0.0.1:5173';
export function isDevelopment(isPackaged: boolean, flag: string | undefined): boolean {
  return !isPackaged && flag === '1';
}
