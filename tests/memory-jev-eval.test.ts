import { expect, test } from 'bun:test';

test('offline Jev acceptance dataset passes synthetic routing and retrieval boundaries', async () => {
  const child = Bun.spawn([globalThis.process.execPath, 'run', 'scripts/memory-jev-eval.ts', '--mock'], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exitCode, stderr).toBe(0);
  const report = JSON.parse(stdout) as { verification: string; cases: Array<{ id: string; requests: number; passed: boolean; descriptorPrecision: number; descriptorRecall: number; memoryPrecision: number; memoryRecall: number }>; thresholdCalibration: Array<{ threshold: number; accepted: number }>; passed: boolean };
  expect(report.verification).toBe('offline-mock');
  expect(report.cases).toHaveLength(14);
  expect(report.thresholdCalibration.map((item) => item.threshold)).toEqual([0.55, 0.60, 0.65, 0.70, 0.75, 0.80]);
  expect(report.thresholdCalibration.map((item) => item.accepted)).toEqual([5, 5, 4, 3, 2, 1]);
  expect(report.cases.every((item) => [item.descriptorPrecision, item.descriptorRecall, item.memoryPrecision, item.memoryRecall].every(Number.isFinite))).toBe(true);
  expect(report.passed).toBe(true);
  expect(report.cases.find((item) => item.id === 'contradiction')?.requests).toBe(0);
  expect(report.cases.filter((item) => item.id !== 'contradiction').every((item) => item.requests === 1)).toBe(true);
  expect(report.cases.every((item) => item.passed)).toBe(true);
});
