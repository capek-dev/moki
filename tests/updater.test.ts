import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { MokiUpdater, type AutoUpdaterAdapter } from '@electron/updater';
import type { UpdaterState } from '@shared/updater';

class FakeAutoUpdater extends EventEmitter implements AutoUpdaterAdapter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checks = 0;
  downloads = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  checkAction: () => Promise<unknown> = async () => {};
  downloadAction: () => Promise<unknown> = async () => {};

  async checkForUpdates() {
    this.checks++;
    return this.checkAction();
  }

  async downloadUpdate() {
    this.downloads++;
    return this.downloadAction();
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function updater(adapter: FakeAutoUpdater, changed: UpdaterState[] = []) {
  return new MokiUpdater(true, '0.1.0', async () => adapter, (state) => changed.push(state));
}

test('disabled updater never loads or checks for updates', async () => {
  let loads = 0;
  const value = new MokiUpdater(false, '0.1.0', async () => { loads++; return new FakeAutoUpdater(); });

  await value.start();
  expect((await value.check()).status).toBe('disabled');
  expect((await value.download()).status).toBe('disabled');
  expect(loads).toBe(0);
  expect(() => value.install()).toThrow('No downloaded update is ready to install.');
});

test('startup configures electron-updater and automatically checks once', async () => {
  const adapter = new FakeAutoUpdater();
  adapter.checkAction = async () => { adapter.emit('update-not-available', { version: '0.1.0' }); };
  const value = updater(adapter);

  await value.start();

  expect(adapter.autoDownload).toBe(false);
  expect(adapter.autoInstallOnAppQuit).toBe(false);
  expect(adapter.checks).toBe(1);
  expect(value.state()).toEqual({ status: 'up-to-date', currentVersion: '0.1.0', availableVersion: null, percent: null, message: null });
});

test('available update downloads, reports bounded progress, and installs explicitly', async () => {
  const adapter = new FakeAutoUpdater();
  const changed: UpdaterState[] = [];
  const value = updater(adapter, changed);
  adapter.checkAction = async () => { adapter.emit('update-available', { version: '0.2.0' }); };
  adapter.downloadAction = async () => {
    adapter.emit('download-progress', { percent: -3 });
    adapter.emit('download-progress', { percent: 45.678 });
    adapter.emit('download-progress', { percent: 103 });
    adapter.emit('update-downloaded', { version: '0.2.0' });
  };

  await value.check();
  expect(value.state().status).toBe('available');
  await value.download();

  expect(changed.filter((state) => state.status === 'downloading').map((state) => state.percent)).toEqual([0, 0, 45.7, 100]);
  expect(value.state()).toMatchObject({ status: 'downloaded', availableVersion: '0.2.0', percent: 100 });
  expect(() => value.install()).not.toThrow();
  expect(adapter.installs).toEqual([[false, true]]);
});

test('concurrent checks and downloads share their in-flight operation', async () => {
  const adapter = new FakeAutoUpdater();
  const check = deferred();
  adapter.checkAction = () => check.promise;
  const value = updater(adapter);

  const firstCheck = value.check();
  const secondCheck = value.check();
  await Promise.resolve();
  check.resolve();
  await Promise.all([firstCheck, secondCheck]);
  expect(adapter.checks).toBe(1);

  adapter.emit('update-available', { version: '0.2.0' });
  const download = deferred();
  adapter.downloadAction = () => download.promise;
  const firstDownload = value.download();
  await Promise.resolve();
  const secondDownload = value.download();
  adapter.emit('update-downloaded', { version: '0.2.0' });
  download.resolve();
  await Promise.all([firstDownload, secondDownload]);
  expect(adapter.downloads).toBe(1);
});

test('check, download, loader, and emitted errors become bounded error states', async () => {
  const adapter = new FakeAutoUpdater();
  const value = updater(adapter);
  adapter.checkAction = async () => { throw new Error('check failed'); };
  expect(await value.check()).toMatchObject({ status: 'error', message: 'check failed' });

  adapter.emit('update-available', { version: '0.2.0' });
  adapter.downloadAction = async () => { throw new Error('download failed'); };
  expect(await value.download()).toMatchObject({ status: 'error', message: 'download failed' });

  adapter.emit('error', new Error('event failed'));
  expect(value.state()).toMatchObject({ status: 'error', message: 'event failed' });

  const longMessage = 'x'.repeat(300);
  const failedLoad = new MokiUpdater(true, '0.1.0', async () => { throw new Error(longMessage); });
  const failedState = await failedLoad.check();
  expect(failedState.status).toBe('error');
  expect(failedState.message).toHaveLength(240);
});

test('download and install reject before an update is ready', async () => {
  const adapter = new FakeAutoUpdater();
  const value = updater(adapter);

  await expect(value.download()).rejects.toThrow('No update is ready to download.');
  expect(() => value.install()).toThrow('No downloaded update is ready to install.');
});
