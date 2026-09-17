import { mkdir, copyFile } from 'node:fs/promises';

if (Bun.version !== '1.4.0') throw new Error(`Build requires Bun 1.4.0, got ${Bun.version}`);
async function bundle(options: Parameters<typeof Bun.build>[0]) {
  const result = await Bun.build(options);
  if (!result.success) throw new AggregateError(result.logs, 'Build failed');
}
await mkdir('dist/electron', { recursive: true });
await mkdir('dist/renderer', { recursive: true });
await mkdir('dist/backend', { recursive: true });
// Tailwind compiles the token layer, chrome styles, and companion animations
// into the stylesheet index.html links. The renderer imports no CSS, so
// Bun.build only emits JS.
const tailwind = Bun.spawn([process.execPath, 'node_modules/@tailwindcss/cli/dist/index.mjs', '--input', 'src/renderer/tailwind.css', '--output', 'dist/renderer/app.css', '--minify'], { stdout: 'inherit', stderr: 'inherit' });
if (await tailwind.exited !== 0) throw new Error('Tailwind build failed.');
await bundle({ entrypoints: ['src/electron/main.ts', 'src/electron/preload.ts'], outdir: 'dist/electron', target: 'node', format: 'cjs', external: ['electron'], naming: '[name].cjs' });
await bundle({ entrypoints: ['src/renderer/app.tsx'], outdir: 'dist/renderer', target: 'browser', minify: true, define: { 'process.env.NODE_ENV': JSON.stringify('production') } });
await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
await bundle({ entrypoints: ['src/backend/index.ts'], compile: { outfile: 'dist/backend/povondra-runtime' }, target: 'bun' });
// Compilation changes the Mach-O contents. Refresh its signature for local execution.
// Distribution builds still require Developer ID signing and notarization.
if (process.platform === 'darwin') {
  const signing = Bun.spawn(['codesign', '--force', '--sign', '-', 'dist/backend/povondra-runtime'], { stdout: 'inherit', stderr: 'inherit' });
  if (await signing.exited !== 0) throw new Error('Local runtime signing failed.');
}
console.log('Built Electron shell, renderer, and standalone Bun 1.4.0 runtime.');
