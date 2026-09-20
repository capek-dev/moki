import type { UpdaterState } from '@shared/updater';

interface UpdateInfo { version: string }
interface ProgressInfo { percent: number }
export interface AutoUpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfo) => void): unknown;
  on(event: 'download-progress', listener: (info: ProgressInfo) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

const message = (error: unknown) => error instanceof Error && error.message.trim()
  ? error.message.trim().slice(0, 240)
  : 'Update request failed.';

export class MokiUpdater {
  private adapter?: AutoUpdaterAdapter;
  private starting?: Promise<void>;
  private checking?: Promise<void>;
  private downloading?: Promise<void>;
  private stateValue: UpdaterState;

  constructor(
    private enabled: boolean,
    currentVersion: string,
    private load: () => Promise<AutoUpdaterAdapter>,
    private changed: (state: UpdaterState) => void = () => {},
  ) {
    this.stateValue = { status: enabled ? 'idle' : 'disabled', currentVersion, availableVersion: null, percent: null, message: enabled ? null : 'Updates are available in signed release builds.' };
  }

  state(): UpdaterState { return { ...this.stateValue }; }

  private publish(change: Partial<UpdaterState>) {
    this.stateValue = { ...this.stateValue, ...change };
    this.changed(this.state());
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    await this.check();
  }

  async check(): Promise<UpdaterState> {
    if (!this.enabled) return this.state();
    try { await this.ensureStarted(); }
    catch (error) {
      this.publish({ status: 'error', percent: null, message: message(error) });
      return this.state();
    }
    if (!this.adapter) return this.state();
    if (!this.checking) {
      this.checking = (async () => {
        this.publish({ status: 'checking', percent: null, message: null });
        try { await this.adapter!.checkForUpdates(); }
        catch (error) { this.publish({ status: 'error', percent: null, message: message(error) }); }
      })().finally(() => { this.checking = undefined; });
    }
    await this.checking;
    return this.state();
  }

  async download(): Promise<UpdaterState> {
    if (!this.enabled) return this.state();
    try { await this.ensureStarted(); }
    catch (error) {
      this.publish({ status: 'error', percent: null, message: message(error) });
      return this.state();
    }
    if (!this.adapter) return this.state();
    if (this.downloading) {
      await this.downloading;
      return this.state();
    }
    if (this.stateValue.status !== 'available') throw new Error('No update is ready to download.');
    this.downloading = (async () => {
      this.publish({ status: 'downloading', percent: 0, message: null });
      try { await this.adapter!.downloadUpdate(); }
      catch (error) { this.publish({ status: 'error', percent: null, message: message(error) }); }
    })().finally(() => { this.downloading = undefined; });
    await this.downloading;
    return this.state();
  }

  install() {
    if (!this.enabled || !this.adapter || this.stateValue.status !== 'downloaded') throw new Error('No downloaded update is ready to install.');
    this.adapter.quitAndInstall(false, true);
  }

  private async ensureStarted() {
    if (!this.adapter) await this.startWithoutCheck();
  }

  private async startWithoutCheck() {
    if (!this.enabled || this.adapter) return;
    if (!this.starting) {
      this.starting = (async () => {
        const adapter = await this.load();
        adapter.autoDownload = false;
        adapter.autoInstallOnAppQuit = false;
        adapter.on('checking-for-update', () => this.publish({ status: 'checking', percent: null, message: null }));
        adapter.on('update-available', (info) => this.publish({ status: 'available', availableVersion: info.version, percent: null, message: null }));
        adapter.on('update-not-available', () => this.publish({ status: 'up-to-date', availableVersion: null, percent: null, message: null }));
        adapter.on('download-progress', (progress) => this.publish({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress.percent * 10) / 10)), message: null }));
        adapter.on('update-downloaded', (info) => this.publish({ status: 'downloaded', availableVersion: info.version, percent: 100, message: null }));
        adapter.on('error', (error) => this.publish({ status: 'error', percent: null, message: message(error) }));
        this.adapter = adapter;
      })().finally(() => { this.starting = undefined; });
    }
    await this.starting;
  }
}
