import { expect, test } from 'bun:test';
import { localCommandEnvironment, parseNullEnvironment } from '@electron/local-command-environment';

test('NUL environment parsing preserves values and rejects malformed names', () => {
  expect(parseNullEnvironment(Buffer.from('profile output\nPATH=/shell/bin:/usr/bin\0HOME=/Users/test\0BAD-NAME=x\0EMPTY=\0'))).toEqual({
    PATH: '/shell/bin:/usr/bin',
    HOME: '/Users/test',
    EMPTY: '',
  });
});

test('macOS local command environment imports only login-shell PATH', async () => {
  const base = { PATH: '/usr/bin', HOME: '/Users/test', MOKI_DATA_DIR: '/private/data' };
  const environment = await localCommandEnvironment(base, '/bin/zsh', async (shell, args, received) => {
    expect(shell).toBe('/bin/zsh');
    expect(args).toEqual(['-ilc', '/usr/bin/env -0']);
    expect(received).toBe(base);
    return Buffer.from('PATH=/nvm/bin:/opt/homebrew/bin:/usr/bin\0HOME=/wrong\0MOKI_DATA_DIR=/wrong\0');
  });
  if (process.platform === 'darwin') expect(environment).toEqual({ ...base, PATH: '/nvm/bin:/opt/homebrew/bin:/usr/bin' });
  else expect(environment).toEqual(base);
});

test('login environment failure keeps the app environment', async () => {
  const base = { PATH: '/usr/bin', HOME: '/Users/test' };
  const environment = await localCommandEnvironment(base, '/bin/zsh', async () => { throw new Error('profile failed'); });
  expect(environment).toEqual(base);
  expect(environment).not.toBe(base);
});
