import { expect, test } from 'bun:test';

test('mounted Memory settings settles and preserves inspector requests across refresh', async () => {
  const child = Bun.spawn(['bun', 'tests/fixtures/memory-settings-interaction.tsx'], { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill(), 8000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('mounted interactions passed');
  } finally { clearTimeout(timeout); }
}, 10000);
