type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Learning actions (undo) rewrite memory records outside the memory settings flow.
 * The memories browser listens and refreshes its list and open detail, preserving
 * any in-progress draft, exactly as it does for memory revision broadcasts.
 */
export function notifyMemoriesChanged(): void {
  for (const listener of [...listeners]) listener();
}

export function onMemoriesChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
