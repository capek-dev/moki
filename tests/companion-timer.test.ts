import { expect, test } from 'bun:test';
import { scheduleDoneReset } from '@renderer/components/companion/chat-companion';

test('completion resets after three seconds; cleanup cancels stale resets', async () => {
  let cancelledCalls = 0;
  const cancel = scheduleDoneReset(() => { cancelledCalls++; });
  cancel();
  let reset = false;
  const started = performance.now();
  let cleanup = () => {};
  try {
    const finished = new Promise<void>((resolve) => {
      cleanup = scheduleDoneReset(() => { reset = true; resolve(); });
    });
    await Bun.sleep(100);
    expect(reset).toBe(false);
    await finished;
    expect(reset).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(2900);
    expect(cancelledCalls).toBe(0);
  } finally {
    cleanup();
    cancel();
  }
});
