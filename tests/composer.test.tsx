import { expect, test } from 'bun:test';

test('composer sends on Enter, keeps Shift+Enter newline and IME composition safe', async () => {
  const app = await Bun.file('src/renderer/windows/chat-window.tsx').text();
  // Enter must submit through the form so every send guard in onSubmit still applies.
  expect(app).toContain("if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;");
  expect(app).toContain('e.currentTarget.form?.requestSubmit()');
});
