export type UpdaterStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error';

export interface UpdaterState {
  status: UpdaterStatus;
  currentVersion: string;
  availableVersion: string | null;
  percent: number | null;
  message: string | null;
}

export type UpdaterCommand = 'status' | 'check' | 'download' | 'install';
