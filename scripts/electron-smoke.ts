import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

const SMOKE_TIMEOUT_MS = 45_000;
const TERMINATION_GRACE_MS = 5_000;
const KILL_SETTLE_MS = 2_000;
const PIPE_DRAIN_TIMEOUT_MS = 1_000;
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;
const SAFE_ENVIRONMENT_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'USER', 'LOGNAME', 'SHELL', 'TERM', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', '__CF_USER_TEXT_ENCODING',
];

type SmokeReport = {
  mode: 'preflight' | 'run';
  requiredFiles: string[];
  dataIsolation: 'temporary';
  providerCredentials: false;
  launched?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  forceKilled?: boolean;
  terminationDeadlineExceeded?: boolean;
  stdout?: string;
  stderr?: string;
  diagnosticsTruncated?: boolean;
  cleanup?: 'complete' | 'failed';
};

const root = resolve(import.meta.dirname, '..');
const requiredFiles = [
  'dist/electron/main.cjs',
  'dist/electron/preload.cjs',
  'dist/renderer/index.html',
  'dist/backend/moki-runtime',
].map((path) => resolve(root, path));

function preflight(): SmokeReport {
  const missing = requiredFiles.filter((path) => !existsSync(path));
  if (missing.length) throw new Error(`Electron smoke requires a completed build (${missing.map((path) => path.replace(`${root}/`, '')).join(', ')}).`);
  return { mode: 'preflight', requiredFiles: requiredFiles.map((path) => path.replace(`${root}/`, '')), dataIsolation: 'temporary', providerCredentials: false };
}

function captureOutput(stream: Readable): { read: () => { text: string; truncated: boolean } } {
  let text = '';
  let bytes = 0;
  let truncated = false;
  stream.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes >= MAX_DIAGNOSTIC_BYTES) { truncated = true; return; }
    const available = MAX_DIAGNOSTIC_BYTES - bytes;
    text += buffer.subarray(0, available).toString('utf8');
    bytes += Math.min(buffer.byteLength, available);
    if (buffer.byteLength > available) truncated = true;
  });
  // Keep consuming even after the diagnostic cap so a verbose child cannot
  // block on a full pipe.
  stream.resume();
  return { read: () => ({ text, truncated }) };
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // The process group can disappear between the timeout and this call.
    }
  }
  try { return child.kill(signal); } catch { return false; }
}

type ChildResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  forceKilled: boolean;
  terminationDeadlineExceeded: boolean;
  error?: string;
};

function waitForChild(child: ChildProcess): Promise<ChildResult> {
  return new Promise((resolveExit) => {
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let terminateTimer: ReturnType<typeof setTimeout> | undefined;
    let killSettleTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let forceKilled = false;
    let terminationDeadlineExceeded = false;

    const finish = (result: Omit<ChildResult, 'timedOut' | 'forceKilled' | 'terminationDeadlineExceeded'>) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (terminateTimer) clearTimeout(terminateTimer);
      if (killSettleTimer) clearTimeout(killSettleTimer);
      resolveExit({ ...result, timedOut, forceKilled, terminationDeadlineExceeded });
    };

    child.once('error', (error) => finish({ exitCode: 1, signal: null, error: error.message }));
    child.once('exit', (exitCode, signal) => finish({ exitCode, signal }));

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, 'SIGTERM');
      terminateTimer = setTimeout(() => {
        forceKilled = true;
        signalProcessTree(child, 'SIGKILL');
        // Do not wait forever for an exit event after SIGKILL. The smoke
        // process is owned by this runner and has already had both signals.
        killSettleTimer = setTimeout(() => {
          terminationDeadlineExceeded = true;
          finish({ exitCode: child.exitCode, signal: child.signalCode });
        }, KILL_SETTLE_MS);
      }, TERMINATION_GRACE_MS);
    }, SMOKE_TIMEOUT_MS);
  });
}

async function waitForPipeClose(child: ChildProcess): Promise<void> {
  const streams = [child.stdout, child.stderr].filter((stream): stream is Readable => Boolean(stream));
  await new Promise<void>((resolvePipes) => {
    if (!streams.length || streams.every((stream) => stream.destroyed)) { resolvePipes(); return; }
    let remaining = streams.filter((stream) => !stream.destroyed).length;
    const timer = setTimeout(resolvePipes, PIPE_DRAIN_TIMEOUT_MS);
    const closed = () => {
      remaining -= 1;
      if (remaining <= 0) { clearTimeout(timer); resolvePipes(); }
    };
    for (const stream of streams) if (!stream.destroyed) stream.once('close', closed);
  });
}

function cleanupDataDir(dataDir: string): 'complete' | 'failed' {
  try {
    rmSync(dataDir, { recursive: true, force: true });
    return 'complete';
  } catch (error) {
    console.error(`Electron smoke temporary data cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}

function smokeEnvironment(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return {
    ...env,
    MOKI_SMOKE: '1',
    MOKI_SMOKE_DATA_DIR: dataDir,
    MOKI_MEMORY_ENABLED: '',
    MOKI_DEV: '',
    ELECTRON_RUN_AS_NODE: '',
  };
}

async function launch(): Promise<SmokeReport> {
  const ready = preflight();
  const require = createRequire(import.meta.url);
  const electron = require('electron') as string;
  const dataDir = mkdtempSync(join(tmpdir(), 'moki-electron-smoke-'));
  let child: ChildProcess | undefined;
  let stdout = { text: '', truncated: false };
  let stderr = { text: '', truncated: false };
  let result: ChildResult;
  let cleanup: 'complete' | 'failed' = 'complete';
  try {
    child = spawn(electron, [root], {
      cwd: root,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: smokeEnvironment(dataDir),
    });
    const stdoutCapture = captureOutput(child.stdout!);
    const stderrCapture = captureOutput(child.stderr!);
    result = await waitForChild(child);
    stdout = stdoutCapture.read();
    stderr = stderrCapture.read();
    await waitForPipeClose(child);
  } catch (error) {
    result = { exitCode: 1, signal: null, timedOut: false, forceKilled: false, terminationDeadlineExceeded: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    cleanup = cleanupDataDir(dataDir);
  }

  const diagnosticsTruncated = stdout.truncated || stderr.truncated;
  return {
    ...ready,
    mode: 'run',
    launched: true,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    forceKilled: result.forceKilled,
    terminationDeadlineExceeded: result.terminationDeadlineExceeded,
    stdout: stdout.text,
    stderr: result.error ? `${stderr.text}${stderr.text ? '\n' : ''}${result.error}` : stderr.text,
    diagnosticsTruncated,
    cleanup,
  };
}

if (Bun.argv[2] === '--run') {
  try {
    const report = await launch();
    console.log(JSON.stringify(report, null, 2));
    if (report.exitCode !== 0 || report.signal || report.timedOut || report.forceKilled || report.terminationDeadlineExceeded || report.cleanup !== 'complete') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Electron smoke preflight failed.');
    process.exitCode = 1;
  }
} else {
  try {
    console.log(JSON.stringify(preflight(), null, 2));
    console.error('Preflight only. Add --run only with explicit permission to launch the isolated Electron smoke app.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Electron smoke preflight failed.');
    process.exitCode = 1;
  }
}
