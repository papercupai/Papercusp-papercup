import { useSyncExternalStore } from 'react';

// Stand-in for @papercusp/sync in desktop-grid-local.spec.ts. The real provider needs a
// live operator SSE stream; this store plays that stream's role: the spec pushes a new
// roster through window.__desktopGridSync.set(rows) exactly as an SSE delta would land.
type Listener = () => void;
interface DesktopGridSyncStore {
  rows: unknown[];
  listeners: Set<Listener>;
  set: (rows: unknown[]) => void;
}

declare global {
  interface Window { __desktopGridSync?: DesktopGridSyncStore }
}

function store(): DesktopGridSyncStore {
  if (!window.__desktopGridSync) {
    const created: DesktopGridSyncStore = {
      rows: [],
      listeners: new Set(),
      set(rows) {
        created.rows = rows;
        for (const listener of created.listeners) listener();
      },
    };
    window.__desktopGridSync = created;
  }
  return window.__desktopGridSync;
}

/** Deliver a roster as the stream would (the fixture seeds; the spec pushes deltas). */
export function setDesktopGridRows(rows: unknown[]): void {
  store().set(rows);
}

export function useSyncQuery<Row>(_options: { queryName: string }) {
  const sync = store();
  const data = useSyncExternalStore(
    (listener) => {
      sync.listeners.add(listener);
      return () => sync.listeners.delete(listener);
    },
    () => sync.rows,
  ) as Row[];
  return { data, loading: false, fetching: false, error: null, invalidate: () => {} };
}
