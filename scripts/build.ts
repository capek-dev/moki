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
// The native dictation helper (plan 17 B) compiles with the system Swift
// toolchain; its usage-description plist is embedded into the binary so TCC
// prompts carry the right text even when it runs standalone. The explicit
// deployment target (macOS 13) keeps the helper runnable on older systems and
// stops the SDK's own macOS-27 deprecations from firing (one pairs the tap
// API with a throwing twin Swift can never select).
if (process.platform === 'darwin') {
  await mkdir(`${out}/native`, { recursive: true });
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const helper = Bun.spawn(['swiftc', '-O', '-target', `${arch}-apple-macos13.0`, 'src/native/moki-dictate.swift',
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', 'src/native/moki-dictate.plist',
    '-o', `${out}/native/moki-dictate`], { stdout: 'inherit', stderr: 'inherit' });
  if (await helper.exited !== 0) throw new Error('Dictation helper build failed.');
}
// Distribution still requires Developer ID signing and notarization.
if (process.platform === 'darwin') {
  const signing = Bun.spawn(['codesign', '--force', '--sign', '-', `${out}/backend/moki-runtime`], { stdout: 'inherit', stderr: 'inherit' });
  if (await signing.exited !== 0) throw new Error('Local runtime signing failed.');
  const helperSigning = Bun.spawn(['codesign', '--force', '--sign', '-', `${out}/native/moki-dictate`], { stdout: 'inherit', stderr: 'inherit' });
  if (await helperSigning.exited !== 0) throw new Error('Local helper signing failed.');
}
console.log(development ? 'Built isolated Moki Dev shell and backend.' : 'Built Electron shell, renderer, and standalone Bun 1.4.0 runtime.');
