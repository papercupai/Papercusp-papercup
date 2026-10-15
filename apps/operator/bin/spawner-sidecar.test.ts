import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ calls: [] as string[], gone: false, cli: false }));
vi.mock('./boot-malloc-arena', () => { state.calls.push('allocator'); return {}; });
vi.mock('./boot-integrity-first', () => { state.calls.push('integrity'); return {}; });
vi.mock('./boot-flag-store', () => { state.calls.push('flags'); return {}; });
vi.mock('@papercusp/operator-core/lib/util/cli-entry', () => ({ isCliEntry: () => state.cli }));
vi.mock('@papercusp/operator-core/lib/timestamped-console', () => ({ installTimestampedConsole: () => state.calls.push('timestamps') }));
vi.mock('@papercusp/operator-core/lib/process-supervision/stdio-peer-guard', () => ({
  installStdioPeerGuard: () => { state.calls.push('stdio'); return { peerGone: () => state.gone }; },
}));
vi.mock('@papercusp/operator-core/lib/process-supervision/fatal-diagnostics', () => ({ installFatalDiagnostics: () => state.calls.push('fatal-diagnostics') }));
vi.mock('@papercusp/operator-core/lib/process-supervision/parent-death-watch', () => ({ startSidecarParentDeathWatch: () => state.calls.push('parent-watch') }));
vi.mock('@papercusp/operator-core/lib/host-benign-errors', () => ({ isBenignHostError: () => false }));
vi.mock('@papercusp/operator-core/lib/fleet/spawner-sidecar-server', () => {
  state.calls.push('server-import');
  return { runSpawnerSidecarServer: () => state.calls.push('server-start') };
});

const originalRejections = new Set(process.listeners('unhandledRejection'));
const originalExceptions = new Set(process.listeners('uncaughtException'));
afterEach(() => {
  for (const listener of process.listeners('unhandledRejection')) if (!originalRejections.has(listener)) process.off('unhandledRejection', listener);
  for (const listener of process.listeners('uncaughtException')) if (!originalExceptions.has(listener)) process.off('uncaughtException', listener);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); state.calls = []; state.gone = false;
});

it('installs boot and lifecycle safeguards before loading the server; preserves each host fault policy', async () => {
  vi.stubEnv('PAPERCUSP_SPAWNER_SIDECAR_MODE', '1');
  vi.stubEnv('PAPERCUSP_DESKTOP', '0');
  await import('./spawner-sidecar');
  await vi.waitFor(() => expect(state.calls).toContain('server-start'));
  expect(state.calls).toEqual(['allocator', 'integrity', 'flags', 'timestamps', 'stdio', 'fatal-diagnostics', 'parent-watch', 'server-import', 'server-start']);
  const onFault = process.listeners('unhandledRejection').find(listener => !originalRejections.has(listener))!;
  const exit = vi.spyOn(process, 'exit').mockImplementation(vi.fn<typeof process.exit>());
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  onFault(new Error('real fault'), Promise.resolve());
  expect(exit).toHaveBeenCalledWith(1);
  vi.stubEnv('PAPERCUSP_DESKTOP', '1');
  exit.mockClear();
  onFault(new Error('desktop detached fault'), Promise.resolve());
  expect(exit).not.toHaveBeenCalled();
  state.gone = true; diagnostic.mockClear();
  onFault(new Error('closed stdio'), Promise.resolve());
  expect(diagnostic).not.toHaveBeenCalled();
});

it('does not start the server or install runtime handlers when imported as a library', async () => {
  vi.stubEnv('PAPERCUSP_SPAWNER_SIDECAR_MODE', '0');
  await import('./spawner-sidecar');
  expect(state.calls).not.toContain('server-start');
  expect(state.calls).not.toContain('parent-watch');
  expect(process.listeners('unhandledRejection').filter(listener => !originalRejections.has(listener))).toEqual([]);
});
