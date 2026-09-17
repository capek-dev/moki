import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { prepareDevApp } from '@scripts/dev-app';

process.chdir(resolve(import.meta.dirname, '..'));
let child: ChildProcess | undefined;
let server: ViteDevServer | undefined;
let stopping = false;
let exited: Promise<void> = Promise.resolve();
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.send('moki:dev-quit', () => {});
    else child.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  await server?.close();
  process.exitCode = code;
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
try {
  const build = spawn(process.execPath, ['scripts/build.ts', '--dev'], { stdio: 'inherit' });
  child = build;
  exited = new Promise((resolve, reject) => { build.once('exit', (code) => code === 0 || stopping ? resolve() : reject(new Error('Development build failed.'))); build.once('error', reject); });
  await exited;
  if (!stopping) {
    server = await createServer({ configFile: resolve('scripts/vite.config.ts') });
    if (stopping) await server.close();
    else {
      await server.listen();
      if (stopping) await server.close();
      else {
        const require = createRequire(import.meta.url);
        const electron = require('electron') as string;
        const electronVersion = (require('electron/package.json') as { version: string }).version;
        const devElectron = await prepareDevApp(electron, electronVersion);
        const env = { ...process.env, MOKI_DEV: '1' };
        delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
        child = spawn(devElectron, [resolve('dist/dev')], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env });
        exited = new Promise((resolve) => { child!.once('exit', (code) => { resolve(); void stop(code ?? 0); }); child!.once('error', (error) => { console.error(error); resolve(); void stop(1); }); });
        console.log('Moki Dev: renderer hot reload enabled. Restart this command after main/backend edits. Ctrl+C stops the app and server.');
      }
    }
  }
} catch (error) {
  console.error(error);
  await stop(1);
}
