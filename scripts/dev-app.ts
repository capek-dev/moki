import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEV_APP_REVISION = '3';
const SCREEN_CAPTURE_REASON = 'Moki captures a screen region only when you choose Capture region.';

async function run(command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], { stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Failed to prepare Moki Dev.app: ${command}`);
}

export async function prepareDevApp(electronExecutable: string, electronVersion: string): Promise<string> {
  if (process.platform !== 'darwin') return electronExecutable;

  const sourceApp = dirname(dirname(dirname(electronExecutable)));
  const shellDir = resolve('dist/dev-shell');
  const targetApp = resolve(shellDir, 'Moki Dev.app');
  const targetExecutable = resolve(targetApp, 'Contents/MacOS/Electron');
  const marker = resolve(shellDir, 'version');
  const expected = `${electronVersion}:${DEV_APP_REVISION}\n`;

  let current = '';
  try { current = await readFile(marker, 'utf8'); } catch { /* First preparation. */ }
  if (current === expected) return targetExecutable;

  await rm(targetApp, { recursive: true, force: true });
  await mkdir(shellDir, { recursive: true });
  await cp(sourceApp, targetApp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });

  const plist = resolve(targetApp, 'Contents/Info.plist');
  await run('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Moki Dev', plist]);
  await run('plutil', ['-replace', 'CFBundleName', '-string', 'Moki Dev', plist]);
  await run('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'app.moki.desktop.dev', plist]);
  await run('plutil', ['-replace', 'NSScreenCaptureUsageDescription', '-string', SCREEN_CAPTURE_REASON, plist]);
  await run('codesign', ['--force', '--deep', '--sign', '-', targetApp]);
  await writeFile(marker, expected);
  return targetExecutable;
}
