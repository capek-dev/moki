import { expect, test } from 'bun:test';

test('offline Jev acceptance dataset passes synthetic routing and retrieval boundaries', async () => {
  const child = Bun.spawn([globalThis.process.execPath, 'run', 'scripts/memory-jev-eval.ts', '--mock'], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exitCode, stderr).toBe(0);
  const report = JSON.parse(stdout) as { verification: string; cases: Array<{ requests: number; passed: boolean }>; passed: boolean };
  expect(report.verification).toBe('offline-mock');
  expect(report.cases).toHaveLength(6);
  expect(report.passed).toBe(true);
  expect(report.cases.every((item) => item.requests === 1)).toBe(true);
  expect(report.cases.every((item) => item.passed)).toBe(true);
});
