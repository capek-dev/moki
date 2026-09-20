import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';

const ENVIRONMENT_TIMEOUT_MS = 3000;
const ENVIRONMENT_LIMIT = 1024 * 1024;

type EnvironmentRunner = (shell: string, args: string[], base: NodeJS.ProcessEnv) => Promise<Buffer>;

function readLoginEnvironment(shell: string, args: string[], base: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(shell, args, {
      encoding: 'buffer',
      env: base,
      maxBuffer: ENVIRONMENT_LIMIT,
      timeout: ENVIRONMENT_TIMEOUT_MS,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

/** Parse `/usr/bin/env -0` without interpreting shell output or values. */
export function parseNullEnvironment(output: Buffer | string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};
  for (const rawEntry of output.toString().split('\0')) {
    // Interactive profiles sometimes print a banner before `env`. It can only
    // prefix the first NUL record, so discard complete lines before its key.
    const entry = rawEntry.slice(rawEntry.lastIndexOf('\n') + 1);
    const equals = entry.indexOf('=');
    if (equals <= 0) continue;
    const key = entry.slice(0, equals);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    parsed[key] = entry.slice(equals + 1);
  }
  return parsed;
}

/**
 * Finder-launched apps do not receive the PATH assembled by the user's login
 * shell. Import only PATH, which is enough for npx, pnpm, bunx, Homebrew and
 * version-manager shims without letting shell configuration replace app-owned
 * variables.
 */
export async function localCommandEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  shell: string | undefined = undefined,
  run: EnvironmentRunner = readLoginEnvironment,
): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== 'darwin') return { ...base };
  let executable = shell;
  if (!executable) {
    try { executable = userInfo().shell || base.SHELL; }
    catch { executable = base.SHELL; }
  }
  if (!executable?.startsWith('/')) return { ...base };
  try {
    const loaded = parseNullEnvironment(await run(executable, ['-ilc', '/usr/bin/env -0'], base));
    return loaded.PATH ? { ...base, PATH: loaded.PATH } : { ...base };
  } catch {
    return { ...base };
  }
}
