import { mkdir, copyFile, writeFile } from 'node:fs/promises';

if (Bun.version !== '1.4.0') throw new Error(`Build requires Bun 1.4.0, got ${Bun.version}`);
const development = process.argv.includes('--dev');
const out = development ? 'dist/dev/dist' : 'dist';
async function bundle(options: Parameters<typeof Bun.build>[0]) {
  const result = await Bun.build(options);
  if (!result.success) throw new AggregateError(result.logs, 'Build failed');
}
await mkdir(`${out}/electron`, { recursive: true });
await mkdir(`${out}/backend`, { recursive: true });
await bundle({ entrypoints: ['src/electron/main.ts', 'src/electron/preload.ts'], outdir: `${out}/electron`, target: 'node', format: 'cjs', external: ['electron'], naming: '[name].cjs', sourcemap: development ? 'external' : 'none' });
if (development) {
  await writeFile('dist/dev/package.json', JSON.stringify({ name: 'moki-dev', productName: 'Moki Dev', version: '0.0.0', main: 'dist/electron/main.cjs' }));
} else {
  await mkdir(`${out}/renderer`, { recursive: true });
  const tailwind = Bun.spawn([process.execPath, 'node_modules/@tailwindcss/cli/dist/index.mjs', '--input', 'src/renderer/styles/tailwind.css', '--output', `${out}/renderer/app.css`, '--minify'], { stdout: 'inherit', stderr: 'inherit' });
  if (await tailwind.exited !== 0) throw new Error('Tailwind build failed.');
  await bundle({ entrypoints: ['src/renderer/entry.tsx'], outdir: `${out}/renderer`, naming: 'app.js', target: 'browser', minify: true, define: { 'process.env.NODE_ENV': JSON.stringify('production') } });
  await copyFile('src/renderer/index.html', `${out}/renderer/index.html`);
}
await bundle({ entrypoints: ['src/backend/index.ts'], compile: { outfile: `${out}/backend/moki-runtime` }, target: 'bun', sourcemap: development ? 'inline' : 'none' });
// Distribution still requires Developer ID signing and notarization.
if (process.platform === 'darwin') {
  const signing = Bun.spawn(['codesign', '--force', '--sign', '-', `${out}/backend/moki-runtime`], { stdout: 'inherit', stderr: 'inherit' });
  if (await signing.exited !== 0) throw new Error('Local runtime signing failed.');
}
console.log(development ? 'Built isolated Moki Dev shell and backend.' : 'Built Electron shell, renderer, and standalone Bun 1.4.0 runtime.');
