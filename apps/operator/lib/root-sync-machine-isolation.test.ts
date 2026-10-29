// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  _resetOriginSchedulersForTests,
  getOriginScheduler,
} from '@papercusp/sync';
import { _resetOriginSchedulerFetchDedupeForTests } from '@papercusp/operator-core/lib/transport-adapters/origin-scheduler-fetch';

// Load the production bootstrap, retaining both real fetch wrappers. The
// component tree and native-only setup do not participate in these requests.
vi.mock('../providers/HarnessSyncProvider', () => ({ HarnessSyncProvider: () => null }));
vi.mock('@papercusp/operator-core/lib/transport-adapters/desktop-bootstrap', () => ({
  installDesktopIpcPolyfills: vi.fn(), setConsentedTelemetryOrigin: vi.fn(),
}));
vi.mock('@papercusp/operator-ui/seam', () => ({ configureOperatorUi: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/call-tool-resolver', () => ({ installCallToolResolver: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/dev/ipc-inspector-client', () => ({ installIpcInspector: vi.fn() }));
vi.mock('../app/_components/HostedWorkspaceSelectionGate', () => ({ default: () => null }));
vi.mock('../app/_components/UpdateMismatchNotifier', () => ({ default: () => null }));
vi.mock('../app/_components/voice/VoicePrefsSyncBridge', () => ({ VoicePrefsSyncBridge: () => null }));
vi.mock('@papercusp/sync', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/sync')>(),
  enablePersistedSyncCache: vi.fn(),
}));

const origin = 'http://localhost:3055';

beforeEach(() => {
  vi.resetModules();
  _resetOriginSchedulersForTests();
  _resetOriginSchedulerFetchDedupeForTests();
});
afterEach(() => {
  _resetOriginSchedulersForTests();
  _resetOriginSchedulerFetchDedupeForTests();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function boot(fetch: typeof window.fetch) {
  vi.stubGlobal('window', {
    location: { href: `${origin}/desktops?desktopHost=host-a`, origin },
    __PAPERCUSP_WS__: 'local-ws',
    fetch,
  });
  await import('../app/_components/RootSyncProvider');
}

it('keeps simultaneous same-URL reads separate across selected machines', async () => {
  const held = deferred<void>();
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const machine = new Headers(init?.headers).get('x-papercusp-machine');
    await held.promise;
    return new Response(machine);
  });
  await boot(fetch);
  const first = window.fetch('/api/workspaces');
  window.location.href = `${origin}/desktops?desktopHost=host-b`;
  const second = window.fetch('/api/workspaces');
  held.resolve();
  const responses = await Promise.all([first, second]);
  expect(await Promise.all(responses.map(response => response.text())))
    .toEqual(['host-a', 'host-b']);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('pins a queued write to its original machine before another machine is selected', async () => {
  const held = deferred<Response>();
  const seen: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/blocker') return held.promise;
    seen.push(new Headers(init?.headers).get('x-papercusp-machine')!);
    return new Response('ok');
  });
  getOriginScheduler(origin, { limit: 1, reservedInteractive: 0, requestTimeoutMs: 0 });
  await boot(fetch);
  const blocker = window.fetch('/api/blocker');
  const write = window.fetch('/api/files', { method: 'POST', body: 'file-for-host-a' });
  window.location.href = `${origin}/desktops?desktopHost=host-b`;
  held.resolve(new Response('ready'));
  await Promise.all([blocker, write]);
  expect(seen).toEqual(['host-a']);
});
