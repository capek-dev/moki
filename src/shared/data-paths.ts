import { statSync } from 'node:fs';
import { join } from 'node:path';

function exists(path: string): boolean {
  try { statSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// Reuse legacy data in place, including WAL files, credentials and Chromium storage.
// Refuse ambiguous profiles instead of silently opening the wrong history.
export function userDataPath(appData: string): string {
  const current = join(appData, 'Moki');
  const candidates = [current, join(appData, 'Povondra'), join(appData, 'povondra')];
  const found = candidates.filter(exists);
  // Case-insensitive filesystems can expose the same profile under both spellings.
  const unique = found.filter((path, index) => !found.slice(0, index).some((other) => {
    const a = statSync(path), b = statSync(other);
    return a.dev === b.dev && a.ino === b.ino;
  }));
  if (unique.length > 1) throw new Error('Multiple app data profiles found. Resolve the duplicate profiles before starting Moki.');
  return unique[0] ?? current;
}

export function databasePath(dataDir: string): string {
  const current = join(dataDir, 'moki.sqlite');
  const legacy = join(dataDir, 'povondra.sqlite');
  if (exists(current) && exists(legacy)) throw new Error('Multiple chat databases found. Resolve the duplicate databases before starting Moki.');
  return exists(legacy) ? legacy : current;
}
