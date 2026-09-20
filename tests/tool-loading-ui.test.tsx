import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { JevCard } from '../src/renderer/components/settings/providers/jev-card';
import type { ToolLoadingCommand, ToolLoadingState } from '../src/shared/tool-loading';

test('settings loads state, saves key and cap, clears password and receives pushed updates', async () => {
  const window = new Window();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const commands: ToolLoadingCommand[] = [];
  let listener: (state: ToolLoadingState) => void = () => {};
  let unsubscribed = false;
  Object.assign(window, { moki: {
    onToolLoading: (callback: typeof listener) => { listener = callback; return () => { unsubscribed = true; }; },
    toolLoading: async (command: ToolLoadingCommand) => {
      commands.push(command);
      return command.action === 'save' ? { enabled: command.enabled, maxDirect: command.maxDirect, configured: true }
        : { enabled: false, maxDirect: 12, configured: false };
    },
  } });
  const host = window.document.createElement('div'); window.document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await act(async () => { root.render(<JevCard />); });
    expect(commands[0]).toEqual({ action: 'status' });
    const password = host.querySelector('#typesafe-key')! as any;
    expect(password.type).toBe('password');
    // React tracks input values; invoke the native setter before dispatch.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(password, 'private-ui-key'); password.dispatchEvent(new window.Event('input', { bubbles: true }));
      const maximum = host.querySelector('#tool-maximum')!;
      setter.call(maximum, '6'); maximum.dispatchEvent(new window.Event('input', { bubbles: true }));
      (host.querySelector('input[type=checkbox]') as any).click();
    });
    await act(async () => { host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    expect(commands.at(-1)).toEqual({ action: 'save', enabled: true, maxDirect: 6, key: 'private-ui-key' });
    expect(password.value).toBe('');
    expect(host.textContent).toContain('Applies to your next message');
    await act(async () => { listener({ enabled: false, maxDirect: 3, configured: false }); });
    expect((host.querySelector('#tool-maximum') as any).value).toBe('3');
  } finally {
    await act(async () => root.unmount());
    expect(unsubscribed).toBe(true);
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    await window.happyDOM.close();
  }
});
