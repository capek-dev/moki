import { expect, test } from 'bun:test';

const helper = await Bun.file(new URL('../scripts/dev-app.ts', import.meta.url)).text();
const launcher = await Bun.file(new URL('../scripts/dev.ts', import.meta.url)).text();

test('development launches through a stable screen-recording app identity', () => {
  expect(helper).toContain("'Moki Dev.app'");
  expect(helper).toContain("'app.moki.desktop.dev'");
  expect(helper).toContain("'NSScreenCaptureUsageDescription'");
  expect(helper).toContain("codesign', ['--force', '--deep', '--sign', '-'");
  expect(helper).toContain("resolve('dist/dev-shell')");
  expect(helper).toContain('verbatimSymlinks: true');
  expect(launcher).toContain('await prepareDevApp(electron, electronVersion)');
  expect(launcher).toContain('spawn(devElectron');
  expect(launcher).not.toContain('spawn(electron, [resolve(\'dist/dev\')]');
});
