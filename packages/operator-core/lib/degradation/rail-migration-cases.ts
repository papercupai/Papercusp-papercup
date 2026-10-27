/**
 * P-017's manifest-to-test binding. Cases execute the migrated caller at its real dependency
 * seams; static assertions about source text do not count as a passing migration case.
 * An item enters COMPLETE_ITEMS only after every original row is covered and on the rail.
 */
export type RailMigrationOutcome =
  | { route: 'condition'; openedKeys: string[]; resolvedKeys: string[] }
  | { route: 'observation'; mechanism: string; observations: Array<{ eligible: number; applied: number; reason: string }> };

export interface RailMigrationCase {
  id: string;
  item: string;
  rowIds: string[];
  route: 'condition' | 'observation';
  mechanism?: string;
  run: () => RailMigrationOutcome | Promise<RailMigrationOutcome>;
}

import { HOST_STARTUP_MIGRATION_CASES } from './host-startup-migration-cases';
import { original, execute, source } from './host-startup-migration-cases';
import { ROUTINE_FALLBACK_MIGRATION_CASES } from './routine-fallback-migration-cases';
import { AGENT_ROUTING_MIGRATION_CASES } from './agent-routing-migration-cases';

export const RAIL_MIGRATION_COMPLETE_ITEMS: string[] = ['P-005', 'P-007', 'P-008', 'P-009', 'P-010', 'P-011', 'P-012', 'P-013'];

const sidecarOrphanCases: RailMigrationCase[] = [{
  id: 'sidecar-orphan-original-healthy-shutdown-and-unknown-owner',
  item: 'P-015', route: 'observation', mechanism: 'spawner-sidecar-orphan-watchdog',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/fleet/spawner-sidecar-orphan-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const { armSpawnerSidecarOrphanWatchdog } = await import('../fleet/spawner-sidecar-orphan-watchdog');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'bounded-operation') return true;
      expect(mechanism).toBe('spawner-sidecar-orphan-watchdog');
      expect(row.scope).toBe('owner'); observations.push(row); return true;
    });
    let tick: (() => void) | undefined, alive = true, failRead = false, failShutdown = false, failFlush = false;
    let flushed = false;
    const shutdown = vi.fn(() => {
      expect(flushed).toBe(true);
      if (failShutdown) throw new Error('shutdown unavailable');
    });
    const deps = {
      schedule: (_name: string, _interval: number, callback: () => void) => { tick = callback; },
      isPidAlive: (pid: number) => {
        expect(pid).toBe(49217);
        if (failRead) throw new Error('liveness unavailable');
        return alive;
      },
      logger: { log: vi.fn(), warn: vi.fn() },
      flushObservations: async () => { flushed = true; if (failFlush) throw new Error('flush unavailable'); },
    };
    try {
      armSpawnerSidecarOrphanWatchdog('/tmp/spawner.sock', shutdown, deps);
      expect(tick).toBeUndefined(); expect(observations).toEqual([]);
      armSpawnerSidecarOrphanWatchdog('/tmp/papercusp-spawner-49217.sock', shutdown, deps);
      tick!(); expect(shutdown).not.toHaveBeenCalled();
      alive = false; await tick!(); expect(shutdown).toHaveBeenCalledWith('owner-gone');
      failShutdown = true; await expect(tick!()).rejects.toThrow('shutdown unavailable');
      failShutdown = false; failFlush = true;
      await tick!(); // failed telemetry cannot block the orphan shutdown
      expect(shutdown).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sidecar-orphan-flush failed: flush unavailable'));
      failRead = true; expect(tick!).toThrow('liveness unavailable');
      failRead = false; alive = true; tick!();
      expect(observations.map(row => [row.eligible, row.applied, row.reason])).toEqual([
        [1, 1, 'healthy'], [1, 0, 'owner-gone'], [1, 0, 'owner-gone'], [1, 0, 'owner-gone'],
        [1, 0, 'liveness-read-failed'], [1, 1, 'healthy'],
      ]);
    } finally { sink.mockRestore(); warn.mockRestore(); }
    return { route: 'observation', mechanism: 'spawner-sidecar-orphan-watchdog', observations };
  },
}];

const scoutReadPath = 'packages/operator-core/lib/';
const memoryWatchdogCases: RailMigrationCase[] = [{
  id: 'memory-watchdog-original-healthy-gc-trim-recycle-blind-and-failed-ticks',
  item: 'P-015', route: 'observation', mechanism: 'memory-watchdog',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/memory-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const { startMemoryWatchdog } = await import('../memory-watchdog');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      expect(mechanism).toBe('memory-watchdog'); observations.push(row); return true;
    });
    let mb = 10, swap = 0, failSample = false, failGc = false, failTrim = false;
    const usage = vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      if (failSample) throw new Error('memory sample unavailable');
      return { rss: mb * 1024 * 1024, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
    });
    const handles: Array<{ stop(): void }> = [];
    vi.useFakeTimers();
    const trip = vi.fn();
    const start = (extra: Partial<import('../memory-watchdog').MemoryWatchdogOpts> = {}) => {
      const handle = startMemoryWatchdog({ intervalMs: 1000, limitMb: 100, warnMb: 80,
        proactiveGcMb: 40, gcCooldownMs: 0, tripsToRecycle: 1, readSwapMb: () => swap,
        forceGc: () => { if (failGc) throw new Error('GC unavailable'); },
        onTrip: trip, log: () => {}, ...extra });
      handles.push(handle); return handle;
    };
    try {
      let handle = start();
      vi.advanceTimersByTime(1000); // establishes headroom
      mb = 50; vi.advanceTimersByTime(1000); // GC
      failGc = true; vi.advanceTimersByTime(1000); failGc = false;
      mb = 110; vi.advanceTimersByTime(1000); expect(trip).toHaveBeenCalledOnce();
      const afterRecycle = observations.length;
      vi.advanceTimersByTime(1000); expect(observations).toHaveLength(afterRecycle); handle.stop();
      handle = start(); vi.advanceTimersByTime(1000); vi.advanceTimersByTime(1000);
      expect(trip).toHaveBeenCalledOnce(); handle.stop(); // born over budget stays visible each tick
      mb = 10; swap = -1; handle = start(); vi.advanceTimersByTime(1000); handle.stop(); swap = 0;
      failSample = true;
      // The managed registry contains a throwing callback; extract the original
      // producer callback below to assert the failure itself without logging it.
      let tick!: () => void;
      const isolatedStart = execute(original('packages/operator-core/lib/memory-watchdog.ts',
        'export function startMemoryWatchdog(', 'function'), {
        managedSetInterval: (_name: string, _interval: number, callback: () => void) => {
          tick = callback; return { stop() {} };
        },
        bytesToMb: (bytes: number) => bytes / (1024 * 1024),
        observeFallback: recorder.observeFallback, process,
        backgroundWorkersEnabled: () => false,
      }, 'startMemoryWatchdog') as typeof startMemoryWatchdog;
      isolatedStart({ forceGc: null, readSwapMb: () => 0 });
      expect(tick).toThrow('memory sample unavailable'); failSample = false;
      mb = 50;
      handle = start({ trimNativeHeap: () => { if (failTrim) throw new Error('trim unavailable'); } });
      vi.advanceTimersByTime(1000); failTrim = true; vi.advanceTimersByTime(1000); handle.stop();
      expect(observations.map(row => [row.eligible, row.applied, row.reason])).toEqual([
        [1, 1, 'healthy'], [1, 0, 'proactive-gc'], [1, 0, 'gc-failed'], [1, 0, 'recycle'],
        [1, 0, 'born-over-budget'], [1, 0, 'born-over-budget'], [1, 0, 'swap-unavailable'],
        [1, 0, 'tick-failed'], [1, 0, 'native-heap-trim'], [1, 0, 'trim-failed'],
      ]);
    } finally {
      for (const handle of handles) handle.stop();
      vi.useRealTimers(); usage.mockRestore(); sink.mockRestore();
    }
    return { route: 'observation', mechanism: 'memory-watchdog', observations };
  },
}];
type ScoutReadObservation = { eligible: number; applied: number; reason: string; scope?: string | null };
function scoutReadSink(scope: string, observations: ScoutReadObservation[]) {
  return (mechanism: string, row: ScoutReadObservation, options: { workspaceId?: string }) => {
    if (mechanism !== 'scout-state-read' || row.scope !== scope || options.workspaceId !== 'fixture') {
      throw new Error('Scout producer selected an unexpected observation partition');
    }
    observations.push(row); return true;
  };
}

const scoutReadCases: RailMigrationCase[] = [{
  id: 'scout-pot-gate-original-failure-primary-disabled-and-context-exclusion',
  item: 'P-013', route: 'observation', mechanism: 'scout-state-read',
  rowIds: [`log-only-fallback|${scoutReadPath}learning/pot-gate/gates.ts|scoutPotGate|1`],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: ScoutReadObservation[] = [];
    let fail = true, pot: string | null = 'fixture-pot';
    const gate = execute(original(`${scoutReadPath}learning/pot-gate/gates.ts`, 'export async function scoutPotGate', 'function'), {
      observeFallback: scoutReadSink('pot-gate', observations),
      require: () => ({ resolveLearningPotSlug: async () => { if (fail) throw new Error('scope unavailable'); return pot; },
        getOrgPg: () => ({ sql: {} }) }),
      potLearningEnabled: async () => false,
    }, 'scoutPotGate') as typeof import('../learning/pot-gate/gates').scoutPotGate;
    expect(await gate({ workspaceId: 'fixture', installSlug: 'install' })).toEqual({ enabled: true });
    fail = false;
    expect(await gate({ workspaceId: 'fixture', installSlug: 'install' })).toEqual({ enabled: false });
    pot = null;
    expect(await gate({ workspaceId: 'fixture', installSlug: 'install' })).toEqual({ enabled: true });
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'gate-read-failed'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'scout-state-read', observations };
  },
}, {
  id: 'scout-config-original-read-home-failure-empty-and-configured-primary',
  item: 'P-013', route: 'observation', mechanism: 'scout-state-read',
  rowIds: [`log-only-fallback|${scoutReadPath}learning/pot-gate/gates.ts|scoutConfigDelta|1`],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: ScoutReadObservation[] = [];
    const path = `${scoutReadPath}learning/pot-gate/gates.ts`;
    const sections = source(path).statements.find(node => node.getText().startsWith('const SCOUT_CONFIG_SECTIONS'))!.getText();
    let failure: 'read' | 'home' | null = 'read', configured = false;
    const config = execute(`${sections}\n${original(path, 'export async function scoutConfigDelta', 'function')}`, {
      observeFallback: scoutReadSink('config', observations),
      require: () => ({
        getHiveLocalBlueprintConfig: async (_ws: string, slug: string, section: string) => {
          if (failure === 'read') throw new Error('settings unavailable');
          return configured && slug === 'home' && section === 'scout' ? { model: 'owner-selected' } : null;
        },
        resolvePotHomeSlug: () => { if (failure === 'home') throw new Error('home unavailable'); return 'home'; },
        operatorHomeHarnessSlug: () => 'home',
      }),
    }, 'scoutConfigDelta') as typeof import('../learning/pot-gate/gates').scoutConfigDelta;
    const input = { workspaceId: 'fixture', installSlug: 'install' };
    expect(await config(input)).toBeNull();
    failure = 'home'; expect(await config(input)).toBeNull();
    failure = null; expect(await config(input)).toBeNull();
    configured = true; expect(await config(input)).toEqual({ scout: { model: 'owner-selected' } });
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'config-read-failed'], [0, 'config-home-unavailable'], [1, 'applied'], [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'scout-state-read', observations };
  },
}, {
  id: 'scout-rail-liveness-original-partial-read-failure-and-measured-paused-primary',
  item: 'P-013', route: 'observation', mechanism: 'scout-state-read',
  rowIds: [`log-only-fallback|${scoutReadPath}scout/paused-rails.ts|readPausedRails|1`],
  run: async () => {
    const { expect } = await import('vitest');
    const { pausedRailsFrom, GYM_CYCLE_ROUTINE_NAME } = await import('../scout/paused-rails');
    const observations: ScoutReadObservation[] = [];
    let fail = true;
    const sql = async (parts: TemplateStringsArray) => {
      if (parts.join('').includes('gym_autoloop_config')) return [{ harness_slug: 'pot', enabled: true }];
      if (fail) throw new Error('routine state unavailable');
      return [{ install_slug: 'pot', active: false }];
    };
    const read = execute(original(`${scoutReadPath}scout/paused-rails.ts`, 'export async function readPausedRails', 'function'), {
      observeFallback: scoutReadSink('rail-liveness', observations), pausedRailsFrom, GYM_CYCLE_ROUTINE_NAME,
    }, 'readPausedRails') as typeof import('../scout/paused-rails').readPausedRails;
    expect([...(await read(sql as Parameters<typeof read>[0], 'fixture'))]).toEqual([]);
    fail = false;
    expect([...(await read(sql as Parameters<typeof read>[0], 'fixture'))]).toEqual(['gym']);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'rail-liveness-read-failed'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'scout-state-read', observations };
  },
}, {
  id: 'scout-dedup-ledger-original-unavailable-and-empty-measured-primary',
  item: 'P-013', route: 'observation', mechanism: 'scout-state-read',
  rowIds: [`log-only-fallback|${scoutReadPath}scout/dedup-burn-guard.ts|readDedupBurnVerdict|1`],
  run: async () => {
    const { expect } = await import('vitest');
    const { assessDedupBurn } = await import('../scout/dedup-burn-guard');
    const observations: ScoutReadObservation[] = [];
    let fail = true;
    const read = execute(original(`${scoutReadPath}scout/dedup-burn-guard.ts`, 'export async function readDedupBurnVerdict', 'function'), {
      observeFallback: scoutReadSink('dedup-burn', observations), assessDedupBurn,
      UNSATURATED: assessDedupBurn([]), LEDGER_SCAN_LIMIT: 40,
      require: () => ({ readScoutTicks: async () => { if (fail) throw new Error('ledger unavailable'); return []; } }),
    }, 'readDedupBurnVerdict') as typeof import('../scout/dedup-burn-guard').readDedupBurnVerdict;
    expect((await read({ workspaceId: 'fixture' })).saturated).toBe(false);
    fail = false; expect((await read({ workspaceId: 'fixture' })).saturated).toBe(false);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'ledger-read-failed'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'scout-state-read', observations };
  },
}, {
  id: 'scout-lens-weights-original-unavailable-and-empty-measured-primary',
  item: 'P-013', route: 'observation', mechanism: 'scout-state-read',
  rowIds: [`log-only-fallback|${scoutReadPath}scout/routed-ledger.ts|getScoutLensWeights|1`],
  run: async () => {
    const { expect } = await import('vitest');
    const { samplingWeightsWithFloor } = await import('../scout/outcome-feedback');
    const { CREATIVE_LENSES } = await import('../scout/types');
    // Lens weights are keyed by lens identity id (identity-system-everything-migration P-011 / R-8).
    const { LENS_IDENTITY_ID_LIST } = await import('../scout/lenses');
    const observations: ScoutReadObservation[] = [];
    let fail = true;
    const read = execute(original(`${scoutReadPath}scout/routed-ledger.ts`, 'export async function getScoutLensWeights', 'function'), {
      observeFallback: scoutReadSink('lens-weights', observations), samplingWeightsWithFloor, CREATIVE_LENSES, LENS_IDENTITY_ID_LIST,
      activeWorkspaceId: () => 'fixture', isWorkspaceCoordinationOn: async () => false,
      workspaceBrainReadKeys: () => ['pot'],
      readScoutLensWeights: async () => { if (fail) throw new Error('weights unavailable'); return {}; },
    }, 'getScoutLensWeights') as typeof import('../scout/routed-ledger').getScoutLensWeights;
    const failed = await read({ workspaceId: 'fixture', potSlug: 'pot' });
    fail = false;
    expect(await read({ workspaceId: 'fixture', potSlug: 'pot' })).toEqual(failed);
    expect(Object.keys(failed.lensWeights)).toEqual(LENS_IDENTITY_ID_LIST);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'lens-weights-read-failed'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'scout-state-read', observations };
  },
}];

const remainingSyncCases: RailMigrationCase[] = [{
  id: 'browser-transport-original-hook-production-provider-and-sanitized-ingress', item: 'P-011', route: 'observation',
  mechanism: 'browser-sync-transport',
  rowIds: ['log-only-fallback|libs/generic/sync/src/fallback/useTransportFallback.ts|useTransportFallback|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const packets: Array<{ payload: unknown }> = [];
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const report = execute(original('apps/operator/providers/HarnessSyncProvider.tsx', 'export function reportSyncTransportFallback', 'function'), {
      resolveBrowserApiTransport: () => ({ mode: 'local' }),
      fetch: async (_url: string, init: { body: string }) => { packets.push(JSON.parse(init.body)); },
    }, 'reportSyncTransportFallback');
    const element = (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: { ...props, children } });
    const provider = execute(original('apps/operator/providers/HarnessSyncProvider.tsx', 'export function HarnessSyncProvider', 'function'), {
      React: { createElement: element }, QueryClientProvider: 'query', SyncProvider: 'sync', queryClient: {},
      useState: (initial: () => unknown) => [initial()], useEffect() {}, useFlag: () => false,
      useIpcCarriesFetch: () => false, resolveMaxInFlightFetches: () => 2,
      resolveHarnessSyncTransport: () => ({ restEndpoint: '/api/zero-harness' }),
      FLAGS: { SYNC_RESOURCE_DELTA: 'delta' }, DEFAULT_SSE_DRIFT_REPAIR_MS: 180000,
      PERSIST_EXCLUDE_QUERY_NAMES: [], reportSyncTransportFallback: report,
    }, 'HarnessSyncProvider') as (props: object) => { props: { children: Array<{ props: object }> } };
    const syncProps = provider({ children: null }).props.children[0].props;
    let hookOptions: Record<string, unknown> = {};
    const sync = execute(original('libs/generic/sync/src/SyncProvider.tsx', 'export function SyncProvider', 'function'), {
      React: { createElement: element }, PendingSyncAdapter: 'pending', normalizeSyncType: (value: string) => value,
      useState: () => [false], useEffect() {},
      useTransportFallback: (opts: Record<string, unknown>) => { hookOptions = opts; return {}; },
    }, 'SyncProvider') as (props: object) => unknown;
    sync(syncProps);
    expect(hookOptions.observeFallback).toBe(report);

    // Execute the original hook with deterministic lifecycle/timer dependencies.
    // Its jsdom suite separately runs these branches through React itself.
    let clock = 0, nextTimer = 0, refIndex = 0, effectIndex = 0, state = 'SSE';
    const refs: Array<{ current: unknown }> = [];
    const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
    const timers = new Map<number, { at: number; fn: () => void }>();
    const hookPath = 'libs/generic/sync/src/fallback/useTransportFallback.ts';
    const order = source(hookPath).statements.find((node) => node.getText().startsWith('const FALLBACK_ORDER'))!.getText();
    const hook = execute(`${order}\n${original(hookPath, 'export function useTransportFallback', 'function')}`, {
      useState: () => [state, (next: string) => { state = next; }],
      useRef: (initial: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
      useCallback: (fn: unknown) => fn,
      useEffect: (fn: () => (() => void) | void, deps: unknown[]) => {
        const index = effectIndex++, old = effects[index];
        if (old && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return;
        old?.cleanup?.(); effects[index] = { deps, cleanup: fn() || undefined };
      },
      setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { at: clock + ms, fn }); return id; },
      clearTimeout: (id: number) => timers.delete(id),
    }, 'useTransportFallback') as (opts: object) => { onTransportError(error: Error): void; onTransportHealthChange(healthy: boolean): void };
    const render = () => { refIndex = effectIndex = 0; return hook(hookOptions); };
    const advance = (ms: number) => {
      const end = clock + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        clock = due[1].at; timers.delete(due[0]); due[1].fn();
      }
      clock = end;
    };
    let result = render();
    result.onTransportError(new Error('private-token'));
    advance(10000); result = render();
    expect(state).toBe('POLLING');
    advance(30000); result = render();
    expect(state).toBe('SSE'); expect(packets).toHaveLength(1);
    result.onTransportHealthChange(true); advance(30000);
    expect(packets).toHaveLength(2);
    const ingress = await import('../endpoint-route/routes/desktop/telemetry-report');
    for (const packet of packets) {
      const row = ingress.normalizeSyncTransportPayload(packet.payload);
      expect(row).not.toBeNull(); observations.push(row!);
    }
    expect(observations.map((row) => [row.eligible, row.applied, row.reason])).toEqual([
      [1, 0, 'preferred-unavailable'], [1, 1, 'applied'],
    ]);
    expect(JSON.stringify(packets)).not.toContain('private-token');
    for (const effect of effects) effect.cleanup?.();
    return { route: 'observation', mechanism: 'browser-sync-transport', observations };
  },
}, {
  id: 'merge-cursor-original-primary-alternate-failed-and-positioned-exclusion', item: 'P-011', route: 'observation',
  mechanism: 'merge-cursor-seed',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/boot.ts|mergeOnePass|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const { createPgMergeCursorSeedCache, createMergeCursor } = await import('../sync/hyperbee/read-merge');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const text = original('packages/operator-core/lib/sync/hyperbee/boot.ts', 'const eligibleSeeds =', 'if');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
    for (const scenario of ['primary', 'alternate', 'failed', 'positioned', 'disabled', 'invalidated']) {
      const cache = createPgMergeCursorSeedCache({ holdMaxMs: 1000 });
      if (scenario === 'invalidated') cache.invalidate();
      const cursor = createMergeCursor();
      for (const key of scenario === 'positioned' ? ['a', 'b', 'c'] : ['a']) cursor.positions.set(key, 1);
      const store = { load: async (binding: string) => {
        if (scenario === 'failed') throw new Error('cursor unavailable');
        return new Map(scenario === 'alternate'
          ? (binding === 'alternate' ? [['b', 2]] : [['c', 3]])
          : [['b', 2], ['c', 3]]);
      } };
      await execute(text, {
        pgMergeCursorStore: scenario === 'disabled' ? null : store,
        pgCursorSeedCache: cache,
        markMergeStage() {}, logKeys: new Set(['a', 'b', 'c']), mergeCursor: cursor,
        currentApplyBinding: () => 'primary', memoryToggledApplyBinding: () => 'alternate',
        memoryFederationEnabledForPass: true, memoryReplayCursor: null, createMergeCursor: () => ({}),
        pinUnknownDurableState() {}, recordBootEvent() {},
        opts: { workspaceId: 'fixture', harnessSlug: 'fixture-harness' },
        observeFallback: (name: string, row: typeof observations[number]) => {
          expect(name).toBe('merge-cursor-seed'); observations.push(row); return true;
        },
      });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('durable cursor load failed (cursor unavailable); holding 2 log(s)'));
    } finally { warn.mockRestore(); }
    expect(observations.map((row) => [row.eligible, row.applied, row.reason])).toEqual([
      [2, 2, 'applied'], [2, 1, 'alternate-binding'], [2, 0, 'cursor-read-failed'],
    ]);
    return { route: 'observation', mechanism: 'merge-cursor-seed', observations };
  },
}, {
  id: 'swarm-identity-original-persisted-and-ephemeral', item: 'P-011', route: 'observation',
  mechanism: 'swarm-transport-identity',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/swarm.ts|buildSharedSwarm|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    for (const fail of [true, false]) await execute(original('packages/operator-core/lib/sync/hyperbee/swarm.ts', 'swarmSeed = await loadOrGenerateSwarmSeed', 'try'), {
      swarmSeed: undefined, loadOrGenerateSwarmSeed: async () => { if (fail) throw new Error('keychain unavailable'); return Buffer.alloc(32, 7); },
      observeFallback: (name: string, row: typeof observations[number]) => {
        expect(name).toBe('swarm-transport-identity'); observations.push(row); return true;
      },
    });
    expect(observations.map((row) => [row.eligible, row.applied, row.reason])).toEqual([
      [1, 0, 'ephemeral-identity'], [1, 1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'swarm-transport-identity', observations };
  },
}, {
  id: 'swarm-relay-original-wired-failed-and-direct-only-exclusion', item: 'P-011', route: 'observation',
  mechanism: 'swarm-relay-wiring',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/swarm.ts|buildSharedSwarm|2'],
  run: async () => {
    const { expect } = await import('vitest');
    const { syncRelayThroughOption } = await import('../sync/hyperbee/sync-relay');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const text = original('packages/operator-core/lib/sync/hyperbee/swarm.ts', '_sharedSwarm = new Swarm', 'try');
    for (const scenario of ['failed', 'wired', 'direct']) {
      const relayKeys = scenario === 'direct' ? [] : [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
      const attempt = execute(text, {
        _sharedSwarm: null, relayKeys, syncRelayThroughOption,
        opts: { maxPeers: 10, maxClientConnections: 8 }, dht: null, swarmSeed: undefined,
        guard: { firewall: () => true },
        Swarm: class {
          constructor(opts: { relayThrough?: Buffer[] }) {
            expect(opts.relayThrough).toEqual(relayKeys.length ? relayKeys : undefined);
            if (scenario === 'failed') throw new Error('construction unavailable');
          }
        },
        observeFallback: (name: string, row: typeof observations[number]) => {
          expect(name).toBe('swarm-relay-wiring'); observations.push(row); return true;
        },
      });
      if (scenario === 'failed') await expect(attempt).rejects.toThrow('construction unavailable');
      else await attempt;
    }
    expect(observations.map((row) => [row.eligible, row.applied, row.reason])).toEqual([
      [2, 0, 'swarm-construction-failed'], [2, 2, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'swarm-relay-wiring', observations };
  },
}, {
  id: 'sidecar-respawn-original-budget-failure-success-and-exclusions', item: 'P-011', route: 'observation',
  mechanism: 'substrate-sidecar-respawn',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts|scheduleRespawn|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    for (const scenario of ['stopped', 'pending', 'budget', 'failed', 'ready']) {
      let timer: (() => void) | undefined;
      let notified = false;
      const producer = execute(original('packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts', 'function scheduleRespawn(', 'function'), {
        deliberateStop: scenario === 'stopped', respawnTimer: scenario === 'pending' ? 1 : null,
        respawnAttempts: [], RESPAWN_WINDOW_MS: 1000, MAX_RESPAWN_ATTEMPTS: 3,
        pruneRespawnWindow: () => [], respawnBudgetExhausted: () => scenario === 'budget', gaveUp: false,
        respawnBackoffMs: () => 1, setTimeout: (fn: () => void) => { timer = fn; return 1; },
        spawnSubstrateSidecar: async () => { if (scenario === 'failed') throw new Error('spawn unavailable'); },
        notifySidecarRespawned: () => { notified = true; },
        observeFallback: (mechanism: string, row: typeof observations[number]) => {
          expect(mechanism).toBe('substrate-sidecar-respawn'); observations.push(row); return true;
        },
      }, 'scheduleRespawn') as (socketPath: string) => void;
      producer('/fixture/socket');
      if (timer) { timer(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
      expect(notified).toBe(scenario === 'ready');
    }
    expect(observations.map((row) => [row.eligible, row.applied, row.reason])).toEqual([
      [1, 0, 'budget-exhausted'], [1, 0, 'respawn-failed'], [1, 1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'substrate-sidecar-respawn', observations };
  },
}, {
  id: 'coord-receipt-original-send-failure-primary-and-exclusions', item: 'P-011', route: 'observation',
  mechanism: 'coord-delivery-receipt',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/projections/coord-message.ts|writeToPg|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const text = original('packages/operator-core/lib/sync/hyperbee/projections/coord-message.ts', '[coord-message] delivery receipt failed', 'if');
    for (const scenario of ['not-requested', 'empty', 'unwoken', 'failed', 'sent', 'rate-limited']) {
      await execute(text, {
        b: { receipt: scenario !== 'not-requested' },
        to: scenario === 'empty' ? [] : ['recipient'],
        fanWoken: ['unwoken', 'rate-limited'].includes(scenario) ? 0 : 1,
        fanSuppressedByRate: scenario === 'rate-limited',
        opts: { workspaceId: 'fixture', harnessSlug: 'fixture-harness' },
        row: { msg_id: 'fixture-message', harness_slug: 'fixture-harness' },
        require: (path: string) => {
          if (path.endsWith('coordination/messages')) return { sendMessage: async () => { if (scenario === 'failed') throw new Error('send unavailable'); } };
          if (path.endsWith('device-keychain-id')) return { machineFingerprint: () => 'fixture-device' };
          throw new Error(`unexpected dependency ${path}`);
        },
        observeFallback: (mechanism: string, row: typeof observations[number] & { scope?: string }) => {
          expect(mechanism).toBe('coord-delivery-receipt'); expect(row.scope).toBe('fixture-harness'); observations.push(row); return true;
        },
      });
    }
    expect(observations.map((row) => [row.eligible, row.applied, row.reason])).toEqual([
      [1, 0, 'receipt-send-failed'], [1, 1, 'applied'], [1, 1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'coord-delivery-receipt', observations };
  },
}];

const learningStoreCases: RailMigrationCase[] = [{
  id: 'learning-store-original-missing-relation-savepoint-primary-and-other-error',
  item: 'P-013', route: 'observation', mechanism: 'scout-state-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/learning/pot-gate/store.ts|failOpenOnMissingRelation|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const path = 'packages/operator-core/lib/learning/pot-gate/store.ts';
    const observations: ScoutReadObservation[] = [];
    let errorCode: string | null = '42P01', rolledBack = false, savepoints = 0;
    const sql = Object.assign(async () => {
      if (errorCode) throw Object.assign(new Error('scope read failed'), { code: errorCode });
      return [];
    }, { savepoint: async (run: (tx: unknown) => Promise<unknown>) => {
      savepoints++;
      try { return await run(sql); } catch (error) { rolledBack = true; throw error; }
    } });
    const helper = execute(original(path, 'async function failOpenOnMissingRelation', 'function'), {
      warnedMissingRelation: false,
      isMissingRelation: execute(original(path, 'function isMissingRelation', 'function'), { UNDEFINED_TABLE: '42P01' }, 'isMissingRelation'),
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('scout-state-read'); expect(options.workspaceId).toBe('fixture');
        if (!row.applied) expect(rolledBack).toBe(true);
        observations.push(row); return true;
      },
    }, 'failOpenOnMissingRelation');
    const readers = ['getPotLearningScope', 'listPotLearningScope', 'disabledPotSlugs'].map(name =>
      execute(original(path, `export async function ${name}`, 'function'), {
        failOpenOnMissingRelation: helper, mapRow: (row: unknown) => row,
      }, name) as (sql: unknown, q: { workspaceId: string; potSlug: string }) => Promise<unknown>);
    for (const [index, read] of readers.entries()) {
      expect(await read(sql, { workspaceId: 'fixture', potSlug: 'pot' })).toEqual(index === 0 ? null : []);
      expect(observations.at(-1)?.scope).toBe(`store:${['getPotLearningScope', 'listPotLearningScope', 'disabledPotSlugs'][index]}`);
    }
    expect(observations).toHaveLength(3); // The warn-once branch must not throttle observations.
    errorCode = null; rolledBack = false;
    for (const [index, read] of readers.entries()) {
      expect(await read(sql, { workspaceId: 'fixture', potSlug: 'pot' })).toEqual(index === 0 ? null : []);
    }
    errorCode = '42501';
    await expect(readers[0](sql, { workspaceId: 'fixture', potSlug: 'pot' })).rejects.toMatchObject({ code: '42501' });
    expect(savepoints).toBe(7);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      ...Array.from({ length: 3 }, () => [0, 'scope-relation-missing']),
      ...Array.from({ length: 3 }, () => [1, 'applied']), [0, 'scope-read-failed'],
    ]);
    return { route: 'observation', mechanism: 'scout-state-read', observations };
  },
}, {
  id: 'work-item-lock-reclaim-original-read-partial-release-primary-and-exclusions',
  item: 'P-013', route: 'observation', mechanism: 'work-item-lock-reclaim',
  rowIds: [1, 2].map(ordinal => `log-only-fallback|packages/operator-core/lib/work-item-lock-release.ts|releaseReclaimedWorkItemLocks|${ordinal}`),
  run: async () => {
    const { expect } = await import('vitest');
    const path = 'packages/operator-core/lib/work-item-lock-release.ts';
    const observations: ScoutReadObservation[] = [];
    let failRead = true, failRelease = false, empty = false;
    const releaseAttempts: string[] = [];
    const reclaim = execute(original(path, 'export async function releaseReclaimedWorkItemLocks', 'function'), {
      normalizeReclaimPaths: execute(original(path, 'export function normalizeReclaimPaths', 'function'), {}, 'normalizeReclaimPaths'),
      ensureBootstrap: async () => {}, getTxPool: () => ({}),
      readQueue: async () => {
        if (failRead) throw new Error('lock store unavailable');
        return { active_locks: empty ? [] : [
          { coordination_domain: '/fixture', lock_id: 'first', owner: 'holder', path: 'one.ts', goal_ref: 'WI-item' },
          { coordination_domain: '/fixture', lock_id: 'second', owner: 'holder', path: 'two.ts', goal_ref: 'WI-item' },
          { coordination_domain: '/fixture', lock_id: 'unrelated', owner: 'holder', path: 'other.ts', goal_ref: 'WI-other' },
        ] };
      },
      inWorkspaceTxn: async (_domain: string, _owner: string, run: (tx: object) => Promise<unknown>) => run({}),
      tryRelease: async (_tx: object, args: { lockId: string; paths: string[] }) => {
        releaseAttempts.push(args.lockId);
        if (failRelease && args.lockId === 'first') throw new Error('release unavailable');
        return { released: args.paths };
      },
      observeFallback: (mechanism: string, row: ScoutReadObservation) => {
        expect(mechanism).toBe('work-item-lock-reclaim'); observations.push(row); return true;
      },
    }, 'releaseReclaimedWorkItemLocks') as typeof import('../work-item-lock-release').releaseReclaimedWorkItemLocks;
    const params = { ownerId: 'holder', paths: [], goalRef: 'WI-item' };
    expect(await reclaim(params)).toEqual({ releases: [], failures: 1, skipped: null });
    expect(releaseAttempts).toEqual([]);
    failRead = false; failRelease = true;
    const partial = await reclaim(params);
    expect(partial.failures).toBe(1); expect(partial.releases.map(row => row.lockId)).toEqual(['second']);
    failRelease = false;
    expect((await reclaim(params)).releases.map(row => row.lockId)).toEqual(['first', 'second']);
    expect(releaseAttempts).toEqual(['first', 'second', 'first', 'second']);
    empty = true; expect(await reclaim(params)).toEqual({ releases: [], failures: 0, skipped: null });
    expect((await reclaim({ ownerId: '', paths: ['one.ts'] })).skipped).toBe('missing-owner');
    expect((await reclaim({ ownerId: 'holder', paths: [] })).skipped).toBe('no-paths');
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'lock-read-failed'], [0, 'lock-release-failed'], [1, 'applied'], [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'work-item-lock-reclaim', observations };
  },
}];

const coordinationReadCases: RailMigrationCase[] = ['inbox', 'outbox'].map((scope): RailMigrationCase => ({
  id: `coordination-${scope}-original-page-error-primary-and-nonpg-exclusion`,
  item: 'P-013', route: 'observation', mechanism: 'coordination-window-read',
  rowIds: [`log-only-fallback|packages/operator-core/lib/agent-tools/coordination/messages.ts|${scope === 'inbox' ? 'readInboxWindow' : 'readOutboxWindow'}|1`],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: ScoutReadObservation[] = [];
    let fail = true, pg = true, fallbackCalls = 0;
    const functionName = scope === 'inbox' ? 'readInboxWindow' : 'readOutboxWindow';
    const primary = [{ msg_id: 'primary' }], fallback = [{ msg_id: 'fallback' }];
    const fullRead = async () => { fallbackCalls++; return fallback; };
    const read = execute(original('packages/operator-core/lib/agent-tools/coordination/messages.ts', `export async function ${functionName}`, 'function'), {
      coordHasPgFastPath: () => pg, coordWorkspaceId: () => 'fixture',
      pageCoordEventLogDesc: async () => { if (fail) throw new Error('page unavailable'); return { raw: primary, pages: 2, exhausted: false }; },
      filterInbox: (rows: unknown) => rows, filterOutbox: (rows: unknown) => rows,
      // readInboxWindow ages out stale broadcasts; a pass-through keeps this case on the rail.
      inboxBroadcastCutoff: () => '1970-01-01T00:00:00.000Z', dropAgedBroadcasts: (rows: unknown) => rows,
      suppressRetracted: (rows: unknown) => rows, collectRetractedIds: () => new Set(),
      warnOnPageBudgetExhausted() {}, INBOX_SINCE_TS_SKEW_PAD_MS: 1000,
      INBOX_FAST_PATH_ROW_CAP: 25000, OUTBOX_FAST_PATH_ROW_CAP: 25000,
      readInbox: fullRead, readOutbox: fullRead,
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('coordination-window-read'); expect(row.scope).toBe(scope);
        expect(options.workspaceId).toBe('fixture'); observations.push(row); return true;
      },
    }, functionName) as (owner: string) => Promise<{ entries: unknown[]; exhausted: boolean }>;
    expect((await read('owner')).entries).toEqual(fallback);
    fail = false;
    expect(await read('owner')).toMatchObject({ entries: primary, exhausted: false });
    pg = false; expect((await read('owner')).entries).toEqual(fallback);
    expect(fallbackCalls).toBe(2);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'paging-failed'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'coordination-window-read', observations };
  },
}));

const workspaceRoutingCases: RailMigrationCase[] = [{
  id: 'remote-seat-original-scope-offer-failures-primary-empty-and-context-exclusion',
  item: 'P-013', route: 'observation', mechanism: 'workspace-routing-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/agent-tools/plans/remote-seat-inventory.ts|resolveRemoteSeatInventory|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: ScoutReadObservation[] = [];
    const empty = { potShared: false, donorCount: 0, totalSeats: 0 };
    let mode: 'scope-failure' | 'offer-failure' | 'none' | 'many' | 'primary' = 'scope-failure';
    let rows: Array<{ potSlug: string | null; publisherGithubUserId: number; record: { kind: string; seat: { count: number; hostLabel?: string } } }> = [];
    const resolveScope = async (workspaceId: string) => {
      expect(workspaceId).toBe('fixture');
      if (mode === 'scope-failure') throw new Error('scope unavailable');
      return { kind: mode === 'none' || mode === 'many' ? mode : 'one', homeSlug: 'home' };
    };
    const listOffers = async (workspaceId: string, home: string, filter: unknown) => {
      expect([workspaceId, home, filter]).toEqual(['fixture', 'home', { kind: 'seat', status: 'open' }]);
      if (mode === 'offer-failure') throw new Error('offer store unavailable');
      return rows;
    };
    const resolve = execute(original('packages/operator-core/lib/agent-tools/plans/remote-seat-inventory.ts', 'export async function resolveRemoteSeatInventory', 'function'), {
      EMPTY_SUMMARY: empty, resolveWorkspaceHiveScope: resolveScope, listOffersDefault: listOffers,
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('workspace-routing-read'); expect(row.scope).toBe('remote-seat-inventory');
        expect(options.workspaceId).toBe('fixture'); observations.push(row); return true;
      },
    }, 'resolveRemoteSeatInventory') as (workspaceId: string | null, deps?: object) => Promise<object>;
    expect(await resolve('fixture')).toEqual(empty);
    mode = 'offer-failure'; expect(await resolve('fixture', { resolveScope, listOffers })).toEqual(empty);
    for (const unshared of ['none', 'many'] as const) {
      mode = unshared; expect(await resolve('fixture')).toEqual(empty);
    }
    mode = 'primary';
    expect(await resolve('fixture')).toEqual({ potShared: true, donorCount: 0, totalSeats: 0, donorLabels: undefined });
    rows = [
      { potSlug: 'pot', publisherGithubUserId: 1, record: { kind: 'seat', seat: { count: 2, hostLabel: ' donor ' } } },
      { potSlug: null, publisherGithubUserId: 2, record: { kind: 'seat', seat: { count: 20 } } },
    ];
    expect(await resolve('fixture')).toEqual({ potShared: true, donorCount: 1, totalSeats: 2, donorLabels: ['donor'] });
    expect(await resolve(null)).toEqual(empty);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'remote-seat-read-failed'], [0, 'remote-seat-read-failed'],
      [1, 'applied'], [1, 'applied'], [1, 'applied'], [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'workspace-routing-read', observations };
  },
}, {
  id: 'issue-partition-original-throttled-failures-primary-off-and-workspace-capture',
  item: 'P-013', route: 'observation', mechanism: 'workspace-routing-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/issues-engineer.ts|refreshIssuesPerWorkspace|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<ScoutReadObservation & { workspaceId: string }> = [];
    const cache = new Map<string, { on: boolean; readAtMs: number }>();
    let workspaceId = 'first', fail = true, enabled = true;
    const refresh = execute(original('packages/operator-core/lib/issues-engineer.ts', 'async function refreshIssuesPerWorkspace', 'function'), {
      activeWorkspaceId: () => workspaceId, FLAGS: { ISSUES_PER_WORKSPACE: 'partition' }, systemDistinctId: () => 'host',
      getFlag: async (flag: string, identity: string) => {
        expect([flag, identity]).toEqual(['partition', 'host']);
        workspaceId = 'second';
        if (fail) throw new Error('flag store unavailable');
        return enabled;
      },
      issuesPerWorkspaceCache: cache, _lastIssuesPerWorkspaceErrorLoggedAtMs: Date.now(),
      ISSUES_PER_WORKSPACE_FLAG_ERROR_LOG_THROTTLE_MS: 300_000,
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('workspace-routing-read'); expect(row.scope).toBe('issue-partition-flag');
        observations.push({ ...row, workspaceId: options.workspaceId }); return true;
      },
    }, 'refreshIssuesPerWorkspace') as () => Promise<void>;
    await refresh(); await refresh();
    expect(cache.get('first')?.on).toBe(false); expect(cache.get('second')?.on).toBe(false);
    workspaceId = 'first'; fail = false; await refresh();
    expect(cache.get('first')?.on).toBe(true);
    enabled = false; await refresh(); expect(cache.get('second')?.on).toBe(false);
    expect(observations.map(row => [row.workspaceId, row.applied, row.reason])).toEqual([
      ['first', 0, 'issue-partition-read-failed'], ['second', 0, 'issue-partition-read-failed'],
      ['first', 1, 'applied'], ['second', 1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'workspace-routing-read', observations };
  },
}];

workspaceRoutingCases.push({
  id: 'placement-presence-original-failed-empty-and-filtered-primary-files',
  item: 'P-013', route: 'observation', mechanism: 'workspace-routing-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/agent-tools/fleet/place_batch.ts|gatherLivePresenceCurrentFiles|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: ScoutReadObservation[] = [];
    const path = 'packages/operator-core/lib/agent-tools/fleet/place_batch.ts';
    let fail = true;
    let records: Array<{ stale?: boolean; currentFiles?: string[] }> = [];
    const gather = execute(`${original(path, 'export function currentFilesFromLivePresence', 'function')}\n${original(path, 'async function gatherLivePresenceCurrentFiles', 'function')}`, {
      listPresence: async (input: { workspaceId: string }) => {
        expect(input).toEqual({ workspaceId: 'fixture' });
        if (fail) throw new Error('presence unreadable'); return records;
      },
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('workspace-routing-read'); expect(row.scope).toBe('placement-current-files');
        expect(options.workspaceId).toBe('fixture'); observations.push(row); return true;
      },
    }, 'gatherLivePresenceCurrentFiles') as (workspaceId: string) => Promise<string[]>;
    expect(await gather('fixture')).toEqual([]);
    fail = false; expect(await gather('fixture')).toEqual([]);
    records = [{ currentFiles: [' one.ts ', '', 'two.ts'] }, { currentFiles: ['one.ts'] }, { stale: true, currentFiles: ['stale.ts'] }];
    expect(await gather('fixture')).toEqual(['one.ts', 'two.ts']);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'placement-presence-unavailable'], [1, 'applied'], [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'workspace-routing-read', observations };
  },
}, {
  id: 'conversation-summary-original-read-import-failures-primary-empty-and-exclusions',
  item: 'P-013', route: 'observation', mechanism: 'conversation-context-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/agent-tools/operator/converse-prompt.ts|buildOperatorPrompt|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: ScoutReadObservation[] = [];
    const text = original('packages/operator-core/lib/agent-tools/operator/converse-prompt.ts', "if (contextMode === 'compaction' && input.conversationId && conversationsModule)", 'if');
    let fail = true, summary: string | null = null, workspaceId = 'fixture';
    const run = async (mode = 'compaction', conversationId: string | null = 'conversation', importFails = false) => {
      workspaceId = 'fixture';
      const conversationsModule = importFails ? Promise.reject(new Error('summary module unavailable')) : Promise.resolve({
        readConversationSummary: async (id: string) => {
          expect(id).toBe('conversation'); workspaceId = 'drifted-after-await';
          if (fail) throw new Error('summary store unavailable');
          return summary === null ? null : { summaryText: summary };
        },
      });
      return await execute(`${text}\nreturn compactedSummary;`, {
        contextMode: mode, input: { conversationId }, conversationsModule, compactedSummary: null,
        activeWorkspaceId: () => workspaceId,
        observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
          expect(mechanism).toBe('conversation-context-read'); expect(row.scope).toBe('rolling-summary');
          expect(options.workspaceId).toBe('fixture'); observations.push(row); return true;
        },
      });
    };
    expect(await run()).toBeNull(); expect(await run('compaction', 'conversation', true)).toBeNull();
    fail = false; expect(await run()).toBeNull();
    summary = '   '; expect(await run()).toBeNull();
    summary = ' earlier decision '; expect(await run()).toBe('earlier decision');
    expect(await run('window')).toBeNull(); expect(await run('compaction', null)).toBeNull();
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'summary-read-failed'], [0, 'summary-read-failed'], [1, 'applied'], [1, 'applied'], [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'conversation-context-read', observations };
  },
});

const delegationCases: RailMigrationCase[] = [{
  id: 'sentinel-nudge-original-unresolved-throw-and-readable-recipient-results',
  item: 'P-013', route: 'observation', mechanism: 'workspace-routing-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/operator-sentinel-handoff-deps.ts|nudgeRecipient|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: ScoutReadObservation[] = [];
    const sent: Array<{ to: string[] }> = [];
    const escalated: unknown[] = [];
    let mode: 'throw' | 'unresolved' | 'su' | 'mug' | 'escalate' = 'unresolved';
    const deps = execute(original('packages/operator-core/lib/operator-sentinel-handoff-deps.ts', 'export function defaultSentinelHandoffDeps', 'function'), {
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('workspace-routing-read'); expect(row.scope).toBe('sentinel-nudge-recipient');
        expect(options.workspaceId).toBe('fixture'); observations.push(row); return true;
      },
      require: (path: string) => {
        if (path.endsWith('/messages')) return { sendMessage: async (_identity: unknown, input: { to: string[] }) => { sent.push(input); } };
        if (path.endsWith('/escalations')) return { openEscalation: async (_identity: unknown, input: unknown) => { escalated.push(input); } };
        if (path.endsWith('/delegated-tasks')) return { OPERATOR_COORD_OWNER: 'operator' };
        if (path.endsWith('/nudge-recipient')) return { resolveNudgeRecipient: async (input: { workspaceId: string; mugOwner: null }) => {
          expect(input).toEqual({ workspaceId: 'fixture', mugOwner: null });
          if (mode === 'throw') throw new Error('presence unavailable');
          return { kind: mode, ownerId: 'live-recipient', why: 'controlled recipient result' };
        } };
        throw new Error(`unexpected sentinel dependency: ${path}`);
      },
    }, 'defaultSentinelHandoffDeps') as () => import('../operator-sentinel-handoff').SentinelHandoffDeps;
    const input = { workItemId: 'WI-fixture', summary: 'controlled brief', urgent: false, harness: 'home', workspaceId: 'fixture' };
    const nudge = deps().nudgeRecipient;
    await nudge(input);
    mode = 'throw'; await nudge(input);
    expect(sent.map(row => row.to)).toEqual([['@role:mug'], ['@role:mug']]);
    expect(escalated).toHaveLength(0);
    mode = 'su'; await nudge(input);
    expect(sent.at(-1)?.to).toEqual(['live-recipient']);
    mode = 'escalate'; await nudge(input);
    expect(escalated).toHaveLength(1);
    mode = 'mug'; await nudge(input);
    expect(sent.at(-1)?.to).toEqual(['@role:mug']);
    mode = 'unresolved'; await nudge({ ...input, urgent: true });
    expect(escalated).toHaveLength(2);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'nudge-recipient-unavailable'], [0, 'nudge-recipient-unavailable'],
      [1, 'applied'], [1, 'applied'], [1, 'applied'], [0, 'nudge-recipient-unavailable'],
    ]);
    return { route: 'observation', mechanism: 'workspace-routing-read', observations };
  },
}, {
  id: 'deep-delegation-original-message-wake-failures-staged-missed-and-primary',
  item: 'P-013', route: 'observation', mechanism: 'coordination-delivery',
  rowIds: ['log-only-fallback|packages/operator-core/lib/papercup/papercup-deep-delegate-deps.ts|deliverToDeep|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: ScoutReadObservation[] = [];
    const calls: string[] = [];
    let mode: 'message-failed' | 'wake-failed' | 'staged' | 'missed' | 'primary' = 'message-failed';
    const factory = execute(original('packages/operator-core/lib/papercup/papercup-deep-delegate-deps.ts', 'export function defaultDeepDelegateDeps', 'function'), {
      DEEP_DELEGATE_IDENTITY: { ownerId: 'system:fixture' },
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('coordination-delivery'); expect(row.scope).toBe('deep-delegation');
        expect(options.workspaceId).toBe('fixture'); observations.push(row); return true;
      },
      require: (path: string) => {
        if (path.endsWith('/messages')) return { sendMessage: async (_identity: unknown, input: { to: string[]; body: string; harnessSlug: string }) => {
          expect(input).toMatchObject({ to: ['deep-owner'], body: 'controlled brief', harnessSlug: 'home' });
          calls.push('message'); if (mode === 'message-failed') throw new Error('inbox unavailable');
        } };
        if (path.endsWith('/inbox-wake')) return { wakeRecipients: async (owners: string[]) => {
          expect(owners).toEqual(['deep-owner']); calls.push('wake');
          if (mode === 'wake-failed') throw new Error('wake transport unavailable');
          return { woken: mode === 'primary' ? 1 : 0, staged: mode === 'staged' ? 1 : 0 };
        } };
        throw new Error(`unexpected deep dependency: ${path}`);
      },
    }, 'defaultDeepDelegateDeps') as () => import('../papercup/papercup-deep-delegate').DeepDelegateDeps;
    const deliver = factory().deliverToDeep!;
    const input = { workspaceId: 'fixture', ownerId: 'deep-owner', workItemId: 'WI-fixture', harness: 'home', question: 'controlled question', brief: 'controlled brief' };
    expect(await deliver(input)).toBe(false);
    expect(calls).toEqual(['message']);
    for (const next of ['wake-failed', 'staged', 'missed', 'primary'] as const) {
      mode = next; calls.length = 0;
      expect(await deliver(input)).toBe(next === 'primary');
      expect(calls).toEqual(['message', 'wake']);
    }
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'delivery-failed'], [0, 'delivery-failed'], [0, 'wake-staged'], [0, 'wake-missed'], [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'coordination-delivery', observations };
  },
}];

const workItemCallerCases: RailMigrationCase[] = [{
  id: 'grading-standdown-original-failed-read-empty-primary-and-owner-suppression',
  item: 'P-013', route: 'observation', mechanism: 'grading-standdown-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/grading-integrity.ts|readActiveLoopStanddownOwners|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const path = 'packages/operator-core/lib/grading-integrity.ts';
    const observations: ScoutReadObservation[] = [];
    let fail = true, owners = new Set<string>();
    const reader = async (workspaceId: string, nowMs: number) => {
      expect(workspaceId).toBe('fixture'); expect(nowMs).toBe(42);
      if (fail) throw new Error('stand-down store unavailable');
      return owners;
    };
    const read = execute(original(path, 'async function readActiveLoopStanddownOwners', 'function'), {
      getOrgPg: () => ({ sql: 'isolated' }),
      listLoopStanddownOwners: async (sql: unknown, args: { workspaceId: string; nowMs: number; workspaceWideOnly: boolean }) => {
        expect(sql).toBe('isolated'); expect(args.workspaceWideOnly).toBe(true);
        return reader(args.workspaceId, args.nowMs);
      },
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('grading-standdown-read'); expect(options.workspaceId).toBe('fixture');
        observations.push(row); return true;
      },
    }, 'readActiveLoopStanddownOwners') as (ws: string, injectedReader: typeof reader | undefined, nowMs: number) => Promise<Set<string>>;
    const suppress = execute(original(path, 'export async function readGradingAuditDispatchSuppression', 'function'), {
      readActiveLoopStanddownOwners: read,
      gradingAuditSuppressionForOwnerSet: execute(original(path, 'function gradingAuditSuppressionForOwnerSet', 'function'), {}, 'gradingAuditSuppressionForOwnerSet'),
    }, 'readGradingAuditDispatchSuppression') as typeof import('../grading-integrity').readGradingAuditDispatchSuppression;
    expect(await suppress('fixture', { nowMs: 42, listWorkspaceWideLoopStanddownOwners: reader })).toBeNull();
    fail = false;
    expect(await suppress('fixture', { nowMs: 42 })).toBeNull();
    owners = new Set(['paused']);
    expect(await suppress('fixture', { nowMs: 42, targetOwnerId: 'paused', listWorkspaceWideLoopStanddownOwners: reader }))
      .toEqual({ reason: 'workspace-wide-loop-standdown', pausedOwnerCount: 1, targetOwnerId: 'paused' });
    expect(await suppress('fixture', { nowMs: 42, targetOwnerId: 'other', listWorkspaceWideLoopStanddownOwners: reader })).toBeNull();
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'standdown-read-failed'], [1, 'applied'], [1, 'applied'], [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'grading-standdown-read', observations };
  },
}, {
  id: 'work-item-transfer-original-import-failure-partial-cleanup-primary-and-no-transfer',
  item: 'P-013', route: 'observation', mechanism: 'work-item-lock-reclaim',
  rowIds: [1, 2].map(ordinal => `log-only-fallback|packages/operator-core/lib/work-items.ts|claimWorkItem|${ordinal}`),
  run: async () => {
    const { expect } = await import('vitest');
    const text = original('packages/operator-core/lib/work-items.ts', 'if (explicitTransferHolder)', 'if');
    const observations: ScoutReadObservation[] = [], attempts: string[] = [];
    let importFails = true, failures = 1;
    const run = (holder: string | null) => execute(text, {
      explicitTransferHolder: holder, prior: { payload: ['one.ts'] }, won: { id: 'WI-transferred' }, claimWorkspaceId: 'fixture',
      require: (module: string) => {
        if (importFails) throw new Error('cleanup module unavailable');
        if (module === './work-items-release-request') return { readWorkItemPaths: (payload: unknown) => payload };
        return { releaseReclaimedWorkItemLocks: async (args: { ownerId: string; paths: string[]; goalRef: string }) => {
          expect(args).toEqual({ ownerId: 'prior-owner', paths: ['one.ts'], goalRef: 'WI-transferred' });
          attempts.push(args.goalRef); return { failures };
        } };
      },
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('work-item-lock-reclaim'); expect(row.scope).toBe('claim-transfer');
        expect(options.workspaceId).toBe('fixture'); observations.push(row); return true;
      },
    });
    await run('prior-owner');
    expect(attempts).toEqual([]);
    importFails = false; await run('prior-owner');
    failures = 0; await run('prior-owner');
    await run(null);
    expect(attempts).toEqual(['WI-transferred', 'WI-transferred']);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'cleanup-unavailable'], [0, 'targeted-release-failed'], [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'work-item-lock-reclaim', observations };
  },
}, {
  id: 'work-item-reap-original-import-partial-unexpected-failure-primary-and-empty-sweep',
  item: 'P-013', route: 'observation', mechanism: 'work-item-lock-reclaim',
  rowIds: [1, 2].map(ordinal => `log-only-fallback|packages/operator-core/lib/work-items-stale-claims.ts|reclaimStaleWorkItemClaims|${ordinal}`),
  run: async () => {
    const { expect } = await import('vitest');
    const text = original('packages/operator-core/lib/work-items-stale-claims.ts', 'targeted lock cleanup unavailable', 'if');
    const observations: Array<ScoutReadObservation & { workspaceId: string }> = [];
    const rows = ['one', 'two', 'three'].map((id, index) => ({
      feature_id: `WI-${id}`, workspace_id: index === 0 ? 'first-workspace' : 'second-workspace',
      former_taken_by: 'prior-owner', payload: [id + '.ts'],
    }));
    let mode: 'import' | 'partial' | 'throw' | 'primary' = 'import';
    const attempted: string[] = [];
    const run = (input: typeof rows) => execute(text, {
      rows: input,
      require: (module: string) => {
        if (mode === 'import') throw new Error('cleanup module unavailable');
        if (module === './work-items-release-request') return { readWorkItemPaths: (payload: unknown) => payload };
        return { releaseReclaimedWorkItemLocks: async (args: { ownerId: string; paths: string[]; goalRef: string }) => {
          const target = rows.find(row => row.feature_id === args.goalRef)!;
          expect(args).toEqual({ ownerId: 'prior-owner', paths: target.payload, goalRef: target.feature_id });
          attempted.push(args.goalRef);
          if (mode === 'throw' && args.goalRef === 'WI-two') throw new Error('unexpected release failure');
          return { failures: mode === 'partial' && args.goalRef === 'WI-two' ? 1 : 0 };
        } };
      },
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('work-item-lock-reclaim'); expect(row.scope).toBe('stale-sweep');
        observations.push({ ...row, workspaceId: options.workspaceId }); return true;
      },
    });
    await run(rows); expect(attempted).toEqual([]);
    mode = 'partial'; await run(rows);
    mode = 'throw'; attempted.length = 0; await run(rows);
    expect(attempted).toEqual(['WI-one', 'WI-two']);
    mode = 'primary'; await run(rows); await run([]);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'cleanup-unavailable'], [0, 'cleanup-unavailable'], [0, 'cleanup-unavailable'],
      [1, 'applied'], [0, 'targeted-release-failed'], [1, 'applied'],
      [1, 'applied'], [0, 'cleanup-unavailable'], [0, 'cleanup-unavailable'],
      [1, 'applied'], [1, 'applied'], [1, 'applied'],
    ]);
    expect(observations.map(row => row.workspaceId)).toEqual(Array.from({ length: 4 }, () =>
      ['first-workspace', 'second-workspace', 'second-workspace']).flat());
    return { route: 'observation', mechanism: 'work-item-lock-reclaim', observations };
  },
}];

const improvementReadCases: RailMigrationCase[] = [{
  id: 'improvement-tick-lock-original-reserve-query-contention-primary-and-body-error',
  item: 'P-013', route: 'observation', mechanism: 'improvement-watchdog-read',
  rowIds: [1, 2].map(ordinal => `log-only-fallback|packages/operator-core/lib/harness/improvements/watchdog.ts|withWatchdogTickLock|${ordinal}`),
  run: async () => {
    const { expect } = await import('vitest');
    const observations: ScoutReadObservation[] = [];
    let failure: 'reserve' | 'query' | null = 'reserve', acquired = true, runs = 0, releases = 0, unlocks = 0;
    const reserved = Object.assign(async (parts: TemplateStringsArray) => {
      if (parts.join('').includes('pg_advisory_unlock')) { unlocks++; return []; }
      if (failure === 'query') throw new Error('lock query unavailable');
      return [{ ok: acquired }];
    }, { release() { releases++; } });
    const lock = execute(original('packages/operator-core/lib/harness/improvements/watchdog.ts', 'export async function withWatchdogTickLock', 'function'), {
      tickLockSql: () => ({ reserve: async () => { if (failure === 'reserve') throw new Error('reserve unavailable'); return reserved; } }),
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('improvement-watchdog-read'); expect(row.scope).toBe('tick-lock');
        expect(options.workspaceId).toBe('fixture'); observations.push(row); return true;
      },
    }, 'withWatchdogTickLock') as <T>(workspaceId: string, fn: () => Promise<T>) => Promise<{ ran: boolean; value?: T }>;
    const work = async () => { runs++; return 42; };
    expect(await lock('fixture', work)).toEqual({ ran: true, value: 42 });
    failure = 'query'; expect(await lock('fixture', work)).toEqual({ ran: true, value: 42 });
    failure = null; acquired = false; expect(await lock('fixture', work)).toEqual({ ran: false });
    acquired = true; expect(await lock('fixture', work)).toEqual({ ran: true, value: 42 });
    await expect(lock('fixture', async () => { runs++; throw new Error('body failed'); })).rejects.toThrow('body failed');
    expect(runs).toBe(4); expect(releases).toBe(4); expect(unlocks).toBe(2);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'lock-reserve-failed'], [0, 'lock-query-failed'], [1, 'applied'], [1, 'applied'], [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'improvement-watchdog-read', observations };
  },
}, {
  id: 'improvement-key-dedup-original-failure-history-fallback-empty-primary-and-exclusions',
  item: 'P-013', route: 'observation', mechanism: 'improvement-watchdog-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/harness/improvements/watchdog.ts|runWatchdogTickBody|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const { partitionSignalsByKnownKeys, watchdogKeyOf } = await import('../harness/improvements/watchdog');
    const path = 'packages/operator-core/lib/harness/improvements/watchdog.ts';
    const observations: ScoutReadObservation[] = [];
    let fail = true, signals = [{ source: 'red-test', key: 'one', title: 'One', body: 'detail', severity: 'major' }];
    let priorSeenKeys: string[] = ['red-test:one'];
    const run = () => execute(`let partition = { fresh: signals, knownOpen: [], staleResolved: [], standing: [] };\n${original(path, 'key-dup pre-filter failed', 'if')}\nreturn partition;`, {
      workspaceId: 'fixture', signals, priorSeenKeys, refileEligible: new Set(), partitionSignalsByKnownKeys, watchdogKeyOf,
      readKeyDups: async () => { if (fail) throw new Error('dup read unavailable'); return []; },
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('improvement-watchdog-read'); expect(row.scope).toBe('key-dedup');
        expect(options.workspaceId).toBe('fixture'); observations.push(row); return true;
      },
    });
    expect(await run()).toMatchObject({ fresh: [], standing: signals });
    priorSeenKeys = []; expect(await run()).toMatchObject({ fresh: signals, standing: [] });
    fail = false; expect(await run()).toMatchObject({ fresh: signals, standing: [] });
    signals = []; await run(); expect(observations).toHaveLength(3);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'key-dedup-read-failed'], [0, 'key-dedup-read-failed'], [1, 'applied'],
    ]);
    // The adjacent no-history path shares the same read-failure class and registry.
    const history: ScoutReadObservation[] = [];
    signals = [{ source: 'red-test', key: 'one', title: 'One', body: 'detail', severity: 'major' }]; fail = true;
    const read = () => execute(`let recentTicks = [];\n${original(path, 'recentTicks = await readRecentTicks', 'if')}\nreturn recentTicks;`, {
      workspaceId: 'fixture', signals, WATCHDOG_REFILE_HISTORY_LIMIT: 40,
      readRecentTicks: async () => { if (fail) throw new Error('history unavailable'); return []; },
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('improvement-watchdog-read'); expect(row.scope).toBe('tick-history');
        expect(options.workspaceId).toBe('fixture'); history.push(row); return true;
      },
    });
    expect(await read()).toEqual([]); fail = false; expect(await read()).toEqual([]);
    signals = []; await read(); expect(history.map(row => row.applied)).toEqual([0, 1]);
    return { route: 'observation', mechanism: 'improvement-watchdog-read', observations: [...observations, ...history] };
  },
}];

const scoutCycleReadCases: RailMigrationCase[] = [{
  id: 'scout-lens-recency-original-failure-empty-primary-workspace-capture-and-budget-exclusion',
  item: 'P-013', route: 'observation', mechanism: 'scout-state-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/scout/cycle-deps.ts|ideate|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const ts = await import('typescript');
    const file = source('packages/operator-core/lib/scout/cycle-deps.ts');
    let statements: import('typescript').NodeArray<import('typescript').Statement> | undefined;
    const visit = (node: import('typescript').Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'ideate' && ts.isArrowFunction(node.initializer)
        && ts.isBlock(node.initializer.body)) statements = node.initializer.body.statements;
      ts.forEachChild(node, visit);
    };
    visit(file);
    const declarations = statements!.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(
      entry => ['observationWorkspace', 'lensRecency'].includes(entry.name.getText(file)))).map(node => node.getText(file)).join('\n');
    const observations: ScoutReadObservation[] = [];
    let fail = true, capped = true, workspace = 'fixture';
    const read = () => { workspace = 'fixture'; return execute(`${declarations}\nreturn lensRecency;`, {
      capped, activeWorkspaceId: () => workspace,
      readLensRecency: async () => { workspace = 'changed-during-read'; if (fail) throw new Error('ledger unavailable'); return {}; },
      observeFallback: scoutReadSink('lens-recency', observations),
    }); };
    expect(await read()).toBeUndefined(); fail = false; expect(await read()).toEqual({});
    capped = false; expect(await read()).toBeUndefined(); expect(observations).toHaveLength(2);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'lens-recency-read-failed'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'scout-state-read', observations };
  },
}, {
  id: 'scout-goal-flag-original-failure-disabled-primary-workspace-capture-and-deferred-exclusion',
  item: 'P-013', route: 'observation', mechanism: 'scout-state-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/scout/cycle-deps.ts|route|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const ts = await import('typescript');
    const file = source('packages/operator-core/lib/scout/cycle-deps.ts');
    let statements: import('typescript').NodeArray<import('typescript').Statement> | undefined;
    const visit = (node: import('typescript').Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'route' && ts.isArrowFunction(node.initializer)
        && ts.isBlock(node.initializer.body)) statements = node.initializer.body.statements;
      ts.forEachChild(node, visit);
    };
    visit(file);
    const text = statements!.filter(node => (ts.isIfStatement(node) && node.getText(file).startsWith('if (opts.deferDispatch)'))
      || (ts.isVariableStatement(node) && node.declarationList.declarations.some(entry => ['goalEnabled', 'observationWorkspace'].includes(entry.name.getText(file))))
      || (ts.isTryStatement(node) && node.getText(file).includes('goal-rail flag read failed'))).map(node => node.getText(file)).join('\n');
    const observations: ScoutReadObservation[] = [];
    let fail = true, enabled = false, deferDispatch = false, workspace = 'fixture';
    const read = () => { workspace = 'fixture'; return execute(`${text}\nreturn goalEnabled;`, {
      opts: { deferDispatch }, activeWorkspaceId: () => workspace,
      require: (module: string) => module.endsWith('/server') ? { getFlag: async () => {
        workspace = 'changed-during-read'; if (fail) throw new Error('flag unavailable'); return enabled;
      } } : { FLAGS: { BLENDER_GOAL_RAIL: 'goal' } },
      observeFallback: scoutReadSink('goal-rail', observations),
    }); };
    expect(await read()).toBe(true); fail = false; expect(await read()).toBe(false);
    enabled = true; expect(await read()).toBe(true); deferDispatch = true; expect(await read()).toEqual([]);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'goal-rail-read-failed'], [1, 'applied'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'scout-state-read', observations };
  },
}];

const routeReadCases: RailMigrationCase[] = [{
  id: 'role-launch-cwd-original-missing-fallback-missing-and-primary-directory',
  item: 'P-013', route: 'observation', mechanism: 'agent-launch-readiness',
  rowIds: ['log-only-fallback|packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-role.ts|handler|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: ScoutReadObservation[] = [];
    let present = false, fallbackPresent = true;
    const run = async () => {
      const spec = { cwd: '/fixture/role' };
      await execute(original('packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-role.ts', 'launch cwd', 'if'), {
        spec, workspace: 'fixture', existsSync: (path: string) => path === '/fixture/role' ? present : fallbackPresent,
        papercuspPathForWorkspace: (workspace: string) => { expect(workspace).toBe('fixture'); return '/fixture/workspace'; },
        observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
          expect(mechanism).toBe('agent-launch-readiness'); expect(row.scope).toBe('role-cwd');
          expect(options.workspaceId).toBe('fixture'); observations.push(row); return true;
        },
      });
      return spec.cwd;
    };
    expect(await run()).toBe('/fixture/workspace');
    fallbackPresent = false; expect(await run()).toBe('/fixture/role'); // Preserve the old eventual-error behavior.
    present = true; expect(await run()).toBe('/fixture/role');
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'launch-cwd-missing'], [0, 'launch-cwd-missing'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'agent-launch-readiness', observations };
  },
}, {
  id: 'voice-spend-original-api-failure-zero-primary-cache-and-unconfigured-exclusion',
  item: 'P-013', route: 'observation', mechanism: 'voice-spend-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/endpoint-route/routes/agent-mcp/operator-el-spend.ts|handler|2'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: ScoutReadObservation[] = [];
    let fail = true, configured = true, cached: { secsUsed: number; source: string } | null = null, calls = 0;
    const run = () => execute(`let secsUsed; let source;\n${original('packages/operator-core/lib/endpoint-route/routes/agent-mcp/operator-el-spend.ts', 'if (cached)', 'if')}\nreturn { secsUsed, source };`, {
      workspace: 'fixture', ym: '2026-10', now: 42, agentId: 'agent', cached,
      readElevenLabsKey: async () => configured ? 'fixture-key' : null,
      localMonthStartUnixSecs: () => 1,
      fetchElSpendSecs: async () => { calls++; if (fail) throw new Error('API unavailable'); return 0; },
      fetchPgFallbackSecs: async () => { if (configured && !cached) expect(observations.at(-1)?.applied).toBe(0); return 120; },
      spendCache: { set() {} },
      observeFallback: (mechanism: string, row: ScoutReadObservation, options: { workspaceId: string }) => {
        expect(mechanism).toBe('voice-spend-read'); expect(options.workspaceId).toBe('fixture');
        observations.push(row); return true;
      },
    });
    expect(await run()).toEqual({ secsUsed: 120, source: 'pg-fallback' });
    fail = false; expect(await run()).toEqual({ secsUsed: 0, source: 'elevenlabs' });
    configured = false; expect(await run()).toEqual({ secsUsed: 120, source: 'pg-fallback' });
    configured = true; cached = { secsUsed: 120, source: 'pg-fallback' };
    expect(await run()).toEqual(cached); expect(calls).toBe(2);
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'api-read-failed'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'voice-spend-read', observations };
  },
}];

const hookLockCases: RailMigrationCase[] = [{
  id: 'omp-hook-original-lock-failures-primary-busy-and-authenticated-ingress',
  item: 'P-013', route: 'observation', mechanism: 'hook-lock-enforcement',
  rowIds: [1, 2, 3].map(n => `log-only-fallback|apps/operator/scripts/hooks/omp/coord-hook.ts|onToolCall|${n}`),
  run: async () => {
    const { expect, vi } = await import('vitest');
    const ts = await import('typescript');
    const recorder = await import('./fallback-observations');
    const { recordHookFallbacks } = await import('../agent-tools/activity/report');
    const file = source('apps/operator/scripts/hooks/omp/coord-hook.ts');
    const caller = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'onToolCall') as import('typescript').FunctionDeclaration;
    const statements = caller.body!.statements;
    const start = statements.findIndex(node => node.getText(file).startsWith('const paths = lockKeysFromTargets'));
    expect(start).toBeGreaterThan(-1);
    // Execute the original lock region. Earlier command guards are independent
    // exclusions; importing the hook into the operator would cross its boundary.
    const originalLockRegion = statements.slice(start).map(node => node.getText(file)).join('\n');
    const observations: ScoutReadObservation[] = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row, options) => {
      expect(mechanism).toBe('hook-lock-enforcement'); expect(row.scope).toBe('fixture-owner');
      expect(options?.workspaceId).toBe('fixture'); expect(options?.processTag).toBe('omp-hook');
      expect(options?.observedAt?.toISOString()).toBe('2026-10-12T11:00:00.000Z');
      observations.push(row); return true;
    });
    let keys: string[] = [], result: unknown = null, calls = 0;
    const owner = 'fixture-owner';
    const ingress = (row: { eligible: 1; applied: 0 | 1; reason: 'lock-keys-empty' | 'lock-request-refused' | 'lock-transport-unavailable' | 'applied' }) => {
      expect(recordHookFallbacks([{ ...row, observed_at: '2026-10-12T11:00:00.000Z' }], owner, 'omp',
        { isSuperuser: true, uiClientId: owner, workspaceId: 'fixture' }, 'fixture')).toBe(1);
    };
    const run = () => execute(originalLockRegion, {
      event: { toolName: 'write', toolCallId: 'fixture' }, targets: [{ root: '/fixture' }],
      lockKeysFromTargets: () => keys, realpathSync: (root: string) => root,
      callMcpTool: async () => { calls++; return result; },
      asStructuredCallError: (r: unknown) => r && (r as { error?: string }).error === 'mcp_tool_error' ? r : null,
      recordRequestDefect: async () => {}, recordHookError: async () => {}, recordHookSuccess: async () => {},
      acquiredLocks: new Map(), formatBusyRefusal: () => 'busy',
      observeFallback: (mechanism: string, row: Parameters<typeof ingress>[0]) => {
        expect(mechanism).toBe('hook-lock-enforcement'); ingress(row);
      },
    }) as Promise<{ block?: boolean; reason?: string }>;
    try {
      expect(await run()).toEqual({}); expect(calls).toBe(0);
      keys = ['a.ts']; result = { ok: false, error: 'mcp_tool_error', message: 'refused' };
      expect(await run()).toEqual({});
      result = null; expect(await run()).toEqual({});
      result = { ok: true, lock_id: 'lock' }; expect(await run()).toEqual({});
      result = { ok: false, busy: [{}] }; expect(await run()).toEqual({ block: true, reason: 'busy' });
      expect(observations.map(row => [row.applied, row.reason])).toEqual([
        [0, 'lock-keys-empty'], [0, 'lock-request-refused'], [0, 'lock-transport-unavailable'], [1, 'applied'], [1, 'applied'],
      ]);
      const sample = { eligible: 1, applied: 1, reason: 'applied', observed_at: '2026-10-12T11:00:00.000Z' } as const;
      expect(recordHookFallbacks([sample], 'another-owner', 'omp', { isSuperuser: true, uiClientId: owner }, 'fixture')).toBe(0);
      expect(recordHookFallbacks([sample], owner, 'omp', {}, 'fixture')).toBe(0);
      expect(recordHookFallbacks([sample], owner, 'codex', { isSuperuser: true, uiClientId: owner }, 'fixture')).toBe(0);
      expect(observations).toHaveLength(5);
    } finally { sink.mockRestore(); }
    return { route: 'observation', mechanism: 'hook-lock-enforcement', observations };
  },
}];

const mdxRenderCases: RailMigrationCase[] = [{
  id: 'mdx-render-original-failure-primary-and-production-host-observer',
  item: 'P-013', route: 'observation', mechanism: 'mdx-render',
  rowIds: ['log-only-fallback|packages/docs-engine/src/render-mdx.ts|renderMdxToMarkdownUnqueued|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    let observer: ((mechanism: string, row: typeof observations[number]) => void) | undefined;
    await execute(original('apps/operator/bin/host-bootstrap.ts', 'setMdxRenderObserver(', 'expression'), {
      setMdxRenderObserver: (sink: typeof observer) => { observer = sink; },
      observeFallback: (mechanism: string, row: typeof observations[number]) => {
        expect(mechanism).toBe('mdx-render'); observations.push(row); return true;
      },
    });
    let fail = true;
    const render = execute(original('packages/docs-engine/src/render-mdx.ts', 'export async function renderMdxToMarkdownUnqueued', 'function'), {
      processor: { process: async () => { if (fail) throw new Error('malformed MDX'); return '# Primary'; } },
      observeFallback: observer,
      fallbackStripMdx: execute(original('packages/docs-engine/src/render-mdx.ts', 'function fallbackStripMdx', 'function'), {}, 'fallbackStripMdx'),
    }, 'renderMdxToMarkdownUnqueued') as (raw: string, path: string) => Promise<string>;
    expect(await render('---\ntitle: Broken\n---\nimport Thing from "thing";\nSearchable prose', '/docs/broken.mdx')).toBe('Searchable prose');
    fail = false; expect(await render('# Primary', '/docs/primary.mdx')).toBe('# Primary');
    expect(observations.map(row => [row.applied, row.reason])).toEqual([[0, 'parse-failed'], [1, 'applied']]);
    return { route: 'observation', mechanism: 'mdx-render', observations };
  },
}];

const dispatchEnvelopeCases: RailMigrationCase[] = [{
  id: 'capability-envelope-original-evaluator-failure-primary-host-wiring-and-exemptions',
  item: 'P-013', route: 'observation', mechanism: 'capability-envelope',
  rowIds: ['log-only-fallback|libs/generic/tooldef/src/dispatch-stack.ts|run|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const ts = await import('typescript');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const hostFile = source('packages/operator-core/lib/projected-tool-deps.ts');
    const hostDeclaration = hostFile.statements.filter(ts.isVariableStatement)
      .flatMap(node => [...node.declarationList.declarations])
      .find(node => node.name.getText(hostFile) === 'PROJECTED_DEPS')!;
    const hostInitializer = hostDeclaration.initializer!;
    if (!ts.isObjectLiteralExpression(hostInitializer)) throw new Error('missing host deps object');
    const hostProperty = hostInitializer.properties.find(node => node.name?.getText(hostFile) === 'observeFallback')!;
    const host = execute(`const host = { ${hostProperty.getText(hostFile)} };`, {
      observeFallback: (mechanism: string, row: typeof observations[number], options: { workspaceId: string }) => {
        expect(mechanism).toBe('capability-envelope'); expect(options.workspaceId).toBe('fixture');
        observations.push(row); return true;
      },
    }, 'host') as { observeFallback: NonNullable<import('@papercusp/tooldef').DispatchProjectedDeps['observeFallback']> };
    const stepDeclaration = source('libs/generic/tooldef/src/dispatch-stack.ts').statements
      .find(node => node.getText().startsWith('const capabilityEnvelopeStep:'))!.getText();
    const step = execute(stepDeclaration, {}, 'capabilityEnvelopeStep') as {
      run: (input: Record<string, unknown>) => Promise<{ ok: boolean; error?: { code: string } } | null>;
    };
    const deps: import('@papercusp/tooldef').DispatchProjectedDeps = { observeFallback: host.observeFallback };
    const input = { tool: { capabilities: [] }, toolName: 'fixture:tool', input: {}, ctx: { workspaceId: 'fixture' }, deps };
    expect(await step.run(input)).toBeNull();
    deps.checkCapabilityEnvelope = () => null;
    expect(await step.run(input)).toBeNull();
    deps.checkCapabilityEnvelope = () => ({ decision: 'allow', posture: 'auto', applied: false });
    expect(await step.run(input)).toBeNull();
    expect(observations).toEqual([]);
    deps.checkCapabilityEnvelope = () => { throw new Error('evaluator unavailable'); };
    expect(await step.run(input)).toBeNull();
    deps.checkCapabilityEnvelope = () => ({ decision: 'deny', posture: 'rejected', applied: true });
    expect((await step.run(input))?.error?.code).toBe('capability_denied');
    deps.checkCapabilityEnvelope = () => ({ decision: 'allow', posture: 'auto', applied: true });
    expect(await step.run(input)).toBeNull();
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [0, 'evaluator-threw'], [1, 'applied'], [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'capability-envelope', observations };
  },
}];

export const RAIL_MIGRATION_CASES: RailMigrationCase[] = [...HOST_STARTUP_MIGRATION_CASES, ...ROUTINE_FALLBACK_MIGRATION_CASES, ...sidecarOrphanCases, ...memoryWatchdogCases, ...scoutReadCases, ...scoutCycleReadCases, ...improvementReadCases, ...routeReadCases, ...hookLockCases, ...mdxRenderCases, ...dispatchEnvelopeCases, ...learningStoreCases, ...workItemCallerCases, ...workspaceRoutingCases, ...delegationCases, ...coordinationReadCases, ...remainingSyncCases, {
  id: 'bulk-run-original-core-and-routine-ticks-heal-race-failure-and-healthy',
  item: 'P-015', route: 'observation', mechanism: 'bulk-run-watchdog',
  rowIds: [
    'bespoke-watchdog|packages/operator-core/lib/attention/bulk-run-watchdog.ts|<module>|1',
    'bespoke-watchdog|packages/operator-core/lib/harness/routines/bulk-run-watchdog-action.ts|<module>|1',
  ],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const { runBulkRunWatchdog } = await import('../attention/bulk-run-watchdog');
    const recorder = await import('./fallback-observations');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row, options) => {
      expect(mechanism).toBe('bulk-run-watchdog');
      expect(row.scope).toBe('sweep');
      if (options) expect(options.workspaceId).toBe('fixture');
      observations.push(row); return true;
    });
    const zero = { autoResolved: 0, recommended: 0, skipped: 0, failed: 0 };
    let failRead = false, failWrite = false, marked = 2;
    let rows: import('../attention/bulk-run-watchdog').WatchdogRunFacts[] = [];
    const listRuns = async () => { if (failRead) throw new Error('census unavailable'); return rows; };
    const strandRun = async () => { if (failWrite) throw new Error('write unavailable'); return { marked }; };
    const reconcileCounters = async () => {};
    const core = () => runBulkRunWatchdog({ listRuns, strandRun, reconcileCounters });
    await core();
    rows = [{ runId: 'fixture-run', phase: 'running', undecided: 2,
      liveness: { state: 'stale', ageMs: 900_000, measuredFrom: 'heartbeat' }, stored: zero, derived: zero }];
    await core(); marked = 0; await core();
    failWrite = true; await core(); failWrite = false;
    failRead = true; await expect(core()).rejects.toThrow('census unavailable'); failRead = false;

    // Execute the actual registered action and its dependency wiring, without
    // importing the shared routine registry or opening a database.
    let action: ((ctx: { workspaceId: string }) => Promise<unknown>) | undefined;
    let importFailed = false;
    await execute(original('packages/operator-core/lib/harness/routines/bulk-run-watchdog-action.ts',
      "registerSystemAction('bulk-run-watchdog'", 'expression'), {
      registerSystemAction: (_name: string, fn: typeof action) => { action = fn; },
      observeFallback: recorder.observeFallback,
      require: (name: string) => {
        if (importFailed) throw new Error('adapter import unavailable');
        if (name.endsWith('/bulk-run-store')) return {
          readWatchdogRunRows: listRuns,
          classifyRunLiveness: () => ({ state: 'stale', ageMs: 900_000, measuredFrom: 'heartbeat' }),
          strandStaleRun: strandRun, reconcileRunCounters: reconcileCounters,
        };
        if (name.endsWith('/bulk-run-watchdog')) return { runBulkRunWatchdog };
        if (name.endsWith('/presence-wakeability')) return { fetchWakeability: async () => new Map() };
        throw new Error(`Unexpected bulk-run action dependency: ${name}`);
      },
    });
    rows = []; await action!({ workspaceId: 'fixture' });
    rows = [{ runId: 'fixture-run', phase: 'running', undecided: 2,
      liveness: { state: 'stale', ageMs: 900_000, measuredFrom: 'heartbeat' }, stored: zero, derived: zero }];
    marked = 2; await action!({ workspaceId: 'fixture' });
    failRead = true; await expect(action!({ workspaceId: 'fixture' })).rejects.toThrow('census unavailable');
    failRead = false; importFailed = true;
    await expect(action!({ workspaceId: 'fixture' })).rejects.toThrow('adapter import unavailable');
    expect(observations.map(row => [row.applied, row.reason])).toEqual([
      [1, 'healthy'], [0, 'heal-strand'], [1, 'healthy'], [0, 'effect-failed'], [0, 'census-failed'],
      [1, 'healthy'], [0, 'heal-strand'], [0, 'census-failed'], [0, 'routine-failed'],
    ]);
    sink.mockRestore();
    return { route: 'observation', mechanism: 'bulk-run-watchdog', observations };
  },
}, {
  id: 'goal-liveness-original-independent-reasons-unknown-preservation-and-measured-recovery',
  item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/goal-liveness-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const producer = await import('../system-health/goal-liveness-watchdog');
    const path = 'packages/operator-core/lib/system-health/goal-liveness-watchdog.ts';
    type Goal = import('../system-health/goal-liveness-watchdog').GoalRowLike;
    type Holder = import('../system-health/goal-liveness-watchdog').GoalHolderLike;
    type Verdict = import('../agent-tools/coordination/liveness-oracle').LivenessVerdict;
    const now = 100_000, old = 1;
    const goal = (workspaceId: string, goalId: string): Goal => ({ workspaceId, goalId,
      title: 'Fixture goal', updatedAtMs: old, status: 'active' });
    const a = goal('fixture:a', 'same/goal'), b = goal('fixture', 'a:same/goal');
    let goals = [a, b], holders: Holder[] = [], available = true;
    let verdicts = new Map<string, Verdict>();
    const v = (ownerId: string, sessionState: 'live' | 'ended' | null): Verdict => ({
      ownerId, sessionState, wakeable: sessionState === 'live', liveTurn: sessionState === 'live',
      confirmLiveness: null, heartbeatFresh: sessionState === 'live',
      ...(sessionState == null ? { signalMissing: true as const } : {}),
    });
    const h = (ownerId: string, epoch: number): Holder => ({ workspaceId: a.workspaceId,
      goalId: a.goalId, ownerId, setAtMs: old, goalLeaseEpoch: epoch });
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const legacy: Array<{ meta: { dedupKind: string; subjectSignature: string } }> = [];
    let legacyFails = false;
    const escalate = execute(original(path, 'async function defaultEscalate(', 'function'), {
      WATCHDOG_IDENTITY: { ownerId: 'goal-liveness-watchdog' },
      formatDark: execute(original(path, 'function formatDark(', 'function'), {}, 'formatDark'),
      openEscalation: async (_identity: unknown, input: typeof legacy[number]) => {
        legacy.push(input); if (legacyFails) throw new Error('legacy delivery unavailable');
      },
    }, 'defaultEscalate') as (alert: import('../system-health/goal-liveness-watchdog').GoalLivenessAlert) => Promise<void>;
    const run = () => producer.runGoalLivenessSweepOnce({} as never, {
      readGoals: async () => { if (!available) throw new Error('goal census unavailable'); return { goals, holders }; },
      resolveLiveness: async () => verdicts, escalate, now: () => now, graceMs: 1_000,
      flagEnabled: async () => true, readReadiness: async () => new Map(),
      readHolderProductivity: async () => new Map(), readPortfolioThroughput: async () => new Map(),
      readUnplannedClusters: async () => new Map(),
      rail: { broadcast: async (event) => {
        expect(event.oneShot).toBe(true);
        if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
        open.add(event.conditionKey!); return true;
      }, resolve: async (event) => {
        if (!open.delete(event.conditionKey)) return false;
        resolvedKeys.push(event.conditionKey); return true;
      } },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await run(); await run();
      expect(open.size).toBe(2); expect(openedKeys).toHaveLength(2);
      expect(legacy[0].meta).toMatchObject({ dedupKind: 'goal-liveness',
        subjectSignature: a.workspaceId + ':' + a.goalId + ':unheld' });
      expect(producer.goalLivenessConditionKey(a, 'unheld')).not.toBe(producer.goalLivenessConditionKey(b, 'unheld'));
      available = false; await expect(run()).rejects.toThrow('goal census unavailable');
      available = true; goals = []; await run(); expect(open.size).toBe(2);
      goals = [{ ...a, updatedAtMs: now }]; await run(); expect(open.size).toBe(2);
      goals = [a]; holders = [h('elected', 2)]; await run(); expect(open.size).toBe(2);
      verdicts = new Map([['elected', v('elected', null)]]); await run(); expect(open.size).toBe(2);
      legacyFails = true; verdicts = new Map([['elected', v('elected', 'ended')]]);
      await run(); expect(open.size).toBe(3);
      expect(open.has(producer.goalLivenessConditionKey(a, 'abandoned'))).toBe(true);
      holders.push(h('historical', 1));
      verdicts = new Map([['elected', v('elected', 'live')]]);
      await run(); expect(open.size).toBe(3); // Missing historical verdict cannot clear.
      verdicts.set('historical', v('historical', 'live'));
      await run(); expect(open.has(producer.goalLivenessConditionKey(a, 'overlap'))).toBe(true);
      verdicts.set('historical', v('historical', 'ended'));
      await run(); expect([...open]).toEqual([producer.goalLivenessConditionKey(b, 'unheld')]);
      goals = [b]; holders = [{ ...h('other', 1), workspaceId: b.workspaceId, goalId: b.goalId }];
      verdicts = new Map([['other', v('other', 'live')]]);
      await run(); expect(open.size).toBe(0);
      expect(legacy.some((row) => row.meta.subjectSignature.endsWith(':overlap'))).toBe(true);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { warn.mockRestore(); }
  },
}, {
  id: 'compaction-original-independent-episodes-force-fallback-and-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const ts = (await import('typescript')).default;
    const path = 'packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts';
    const originalModule = source(path).statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText()).join('\n');
    const open = new Map<string, number>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    let estimate: number | null = 150_000, omitted = false, dead = false, healthyTranscript = false;
    const row = { workspace_id: 'fixture', owner_id: 'fixture-owner', owner_label: 'fixture',
      compaction_limit: 100_000, compaction_limit_explicit: true, last_active_at: new Date().toISOString() };
    const sql = (async (parts: TemplateStringsArray) => {
      const query = parts.join('');
      // The roster read (coord_presence ... compaction_limit IS NOT NULL) now LATERAL-joins
      // adv_sessions for turn evidence, so it must be matched BEFORE the adv_sessions probe.
      if (query.includes('compaction_limit IS NOT NULL')) return omitted ? [] : [row];
      if (query.includes('FROM harness_shared.adv_sessions')) return [{ owner_id: row.owner_id }];
      return [];
    }) as unknown as import('postgres').Sql;
    const warnings: string[] = [];
    const flags = { CONTEXT_GAUGE: 'gauge', GATEWAY_MAINTENANCE_CARRY: 'carry', COMPACTION_WATCHDOG_FORCE_COMPACT: 'force' };
    const producer = execute('console.warn = collectWarning;\n' + originalModule, {
      collectWarning: (message: string) => warnings.push(message),
      ...await import('../agent-config-constants'), DEFAULT_COORD_WORKSPACE: 'fixture', hostname: () => 'fixture-host', process,
      // The watchdog's turn-evidence constants (turn-proof imports only ./types, so it is safe here).
      ...await import('../events/await/turn-proof'),
      estimateContextTokensForOwner: async () => estimate, estimateContextWindowForOwner: async () => 200_000,
      observedPromptFloorForOwner: () => null, resolveSessionRefReconciled: async () => ({ agent: 'claude', sessionId: 'current' }),
      detectContextDeathForOwner: async () => dead, detectToolReferenceDeathForOwner: async () => null,
      codexReadingProvenanceForOwner: async () => null, recordContextUsage: () => {},
      clearContextUsage: async () => {},
      observeFallback: () => true,
      listActiveClaimFreshnessForOwner: async () => [], classifyStaleClaims: () => [],
      setContextGaugeEnabled: () => {}, setContextEstimate: async () => true, setCompactionLimit: async () => {},
      resolveAlarm: (await import('../alarm-attention')).resolveAlarm,
      require: (name: string) => {
        if (name === '@papercusp/flags') return { FLAGS: flags };
        if (name === '@papercusp/flags/server') return { getFlag: async (flag: string) => flag !== 'carry' };
        if (name === '../events/await/psu-pty-discovery') return { findLiveHostAsync: async () => null };
        if (name === '../agent-tools/coordination/escalations') return { openEscalation: async () => ({ msg_id: 'legacy' }) };
        throw new Error(`Unexpected original compaction dependency: ${name}`);
      },
    }, '({ checkCompactionCompliance, compactionConditionKey })') as Pick<typeof import('../system-health/compaction-compliance-watchdog'),
      'checkCompactionCompliance' | 'compactionConditionKey'>;
    const conditions = { observeHealthyTranscript: async () => healthyTranscript ? { sessionId: 'current', measuredAtMs: Date.now() } : null,
      readOpenConditions: async () => [...open].map(([conditionKey, openedAtMs]) => ({ conditionKey, openedAtMs })),
      rail: { broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
        expect(event.oneShot).toBe(true); if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
        open.set(event.conditionKey!, open.get(event.conditionKey!) ?? Date.now()); return true;
      }, resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false; resolvedKeys.push(event.conditionKey); return true;
      } } };
    const run = () => producer.checkCompactionCompliance(sql, conditions);
    await run(); expect(open.size, warnings.join('\n')).toBe(2);
    expect(open.has(producer.compactionConditionKey('fixture', 'fixture-owner', 'force-unavailable'))).toBe(true);
    await run(); expect(openedKeys).toHaveLength(2);
    omitted = true; await run(); expect(open.size).toBe(2);
    omitted = false; estimate = null; await run(); expect(open.size).toBe(2);
    estimate = 50_000; await run(); expect(open.size).toBe(0);
    dead = true; await run(); expect(open.size).toBe(1);
    dead = false; await run(); expect(open.size).toBe(1); // best-effort false is not recovery
    healthyTranscript = true; await run(); expect(open.size).toBe(0);
    expect(resolvedKeys.sort()).toEqual([...openedKeys].sort());
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'compaction-original-force-observation-failures-primary-and-deliberate-exclusions',
  item: 'P-014', route: 'observation', mechanism: 'compaction-force-respawn',
  rowIds: ['log-only-fallback|packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts|maybeForceRespawn|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string; scope?: string | null }> = [];
    let enabled = true, noHost = true, supported = true, transcript = true, spec = true, accepted = true;
    let agent = 'claude', lookupFails = false, injects = 0;
    const producer = execute(original('packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts',
      'async function maybeForceRespawn(', 'function'), {
      observeFallback: (mechanism: string, row: typeof observations[number], options: { workspaceId?: string }) => {
        expect(mechanism).toBe('compaction-force-respawn'); expect(options.workspaceId).toBe('fixture');
        expect(row.scope).toBe('fixture-owner'); observations.push(row); return true;
      },
      noHostWarned: new Set(), FORCE_COMPACT_FRACTION: 1.3,
      compactionConditionKey: () => 'alarm:fixture-compaction', broadcastSevereEvent: async () => true,
      resolveSessionRefReconciled: async () => ({ agent, sessionId: 'fixture-session' }),
      mechanicalPreflushForWatchdog: async () => {}, forceCompactContinueNote: () => 'continue',
      tagWatchdogContinuation: async () => 'continue',
      require: (name: string) => {
        if (name === '@papercusp/flags/server') return { getFlag: async () => enabled };
        if (name === '@papercusp/flags') return { FLAGS: { COMPACTION_WATCHDOG_FORCE_COMPACT: 'force' } };
        if (name === '../events/await/psu-pty-discovery') return {
          findLiveHostAsync: async () => { if (lookupFails) throw new Error('host lookup unavailable'); return noHost ? null : { sock: 'fixture' }; },
          hostSupports: () => supported, injectIntoHost: async () => { injects++; return accepted; },
        };
        if (name === '../claude-sessions') return { findSessionTranscript: async () => transcript ? 'fixture.jsonl' : null,
          newestTranscriptUnderOwner: () => null };
        if (name === '../carry-respawn') return { buildOwnerRespawnLaunchSpec: async () => spec ? { firstPrompt: 'continue' } : null };
        throw new Error(`Unexpected force observation dependency: ${name}`);
      },
    }, 'maybeForceRespawn') as (...args: unknown[]) => Promise<boolean>;
    const run = () => producer('fixture-owner', 'fixture', 'fixture', 200_000, 150_000, 100_000);
    expect(await run()).toBe(false); expect(await run()).toBe(false); // log dedupe cannot suppress observations
    noHost = false; supported = false; expect(await run()).toBe(false);
    supported = true; transcript = false; expect(await run()).toBe(false);
    transcript = true; spec = false; expect(await run()).toBe(false);
    spec = true; accepted = false; expect(await run()).toBe(false);
    accepted = true; expect(await run()).toBe(true); expect(injects).toBe(2);
    lookupFails = true; expect(await run()).toBe(false); lookupFails = false;
    expect(observations.map(row => row.applied)).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
    enabled = false; expect(await run()).toBe(false);
    enabled = true; agent = 'omp'; expect(await run()).toBe(false);
    expect(observations).toHaveLength(8); expect(injects).toBe(2);
    return { route: 'observation', mechanism: 'compaction-force-respawn', observations };
  },
}, {
  id: 'goal-drain-original-independent-obligations-and-exact-subject-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/goal-drain-fleet-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const { runGoalDrainFleetSweepOnce, fleetKey, goalDrainConditionKey } =
      await import('../system-health/goal-drain-fleet-watchdog');
    type Goal = import('../system-health/goal-drain-fleet-watchdog').GoalDrainRowLike;
    type Cohort = import('../system-health/goal-drain-fleet-watchdog').GoalPlanFleetCohort;
    type FleetState = import('../system-health/goal-drain-fleet-watchdog').DrainFleetLiveness;
    const at = 1_900_000_000_000;
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const rail = { broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
      expect(event.oneShot).toBe(true);
      if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
      open.add(event.conditionKey!); return true;
    }, resolve: async (event: { conditionKey: string }) => {
      if (!open.delete(event.conditionKey)) return false;
      resolvedKeys.push(event.conditionKey); return true;
    } };
    const originals: Goal[] = [null, 'dead', 'missing', 'unscoped', 'capped'].map((drainFleet, index) => ({
      workspaceId: 'fixture', goalId: `goal-${index}`, title: `Goal ${index}`,
      createdAtMs: at - 10_000_000, drainFleet,
      ...(drainFleet === 'capped' ? { standing: true, drainRespawn: { deadSinceMs: at - 1000, needsHuman: true } } : {}),
    }));
    let goals = originals.map(goal => ({ ...goal })), unknown = false;
    let fleets = new Map<string, FleetState>([
      [fleetKey('fixture', 'dead'), 'dead'], [fleetKey('fixture', 'missing'), 'not-found'],
      [fleetKey('fixture', 'unscoped'), 'alive'], [fleetKey('fixture', 'capped'), 'dead'],
    ]);
    let scoped = false;
    const plan = (planSlug: string, claimed: boolean, alive: boolean) => ({ workspaceId: 'fixture', goalId: 'goal-0',
      harnessSlug: 'pot', planSlug, itemIds: ['P-001'], targetingFleets: alive ? [
        { fleetSlug: 'plan-fleet', liveness: 'alive' as const, liveClaimItemIds: claimed ? ['P-001'] : [] },
      ] : [] });
    let cohort: Cohort = { status: 'known', plans: [plan('plan-A', false, false), plan('plan-B', false, true)] };
    const escalate = vi.fn(async () => { expect(open.size).toBeGreaterThan(0); });
    const notify = vi.fn(async () => {});
    const run = () => runGoalDrainFleetSweepOnce(null as unknown as import('postgres').Sql, {
      readGoals: async () => ({ goals, holders: goals.map(goal => ({ ...goal, ownerId: 'holder', setAtMs: at - 1000 })) }),
      resolveLiveness: async () => unknown ? new Map() : new Map([['holder', { ownerId: 'holder', sessionState: 'live',
        wakeable: true, liveTurn: true, confirmLiveness: null, heartbeatFresh: true }]]),
      resolveFleetLiveness: async () => unknown ? new Map() : fleets,
      resolveFleetSpecScopes: async () => new Map(goals.map(goal => [goal.goalId, scoped ? 'goal-scoped' : 'not-goal-scoped'])),
      flagEnabled: async () => true, now: () => at, graceMs: 1000, rail,
      relaunchFlagEnabled: async () => false, readPullStallAlerts: async () => [], clearDrainLedger: async () => {},
      escalate, emitDrainDead: async () => {},
      readPlanFleetCohort: async () => cohort, escalatePlanFleet: async () => ({ opened: false }),
      emitPlanFleet: async () => {}, notifyPlanFleetHolders: notify,
    });
    await run(); expect(open.size).toBe(8);
    await run(); expect(openedKeys).toHaveLength(8); expect(notify).not.toHaveBeenCalled();
    unknown = true; await run(); expect(open.size).toBe(8);
    unknown = false; goals = []; await run(); expect(open.size).toBe(8);
    goals = originals.map(goal => ({ ...goal }));
    cohort = { status: 'unknown', plans: [] }; await run(); expect(open.size).toBe(8);
    cohort = { status: 'known', plans: [] }; await run(); expect(open.size).toBe(8);
    fleets = new Map(goals.filter(goal => goal.drainFleet).map(goal => [fleetKey('fixture', goal.drainFleet!), 'alive']));
    scoped = true;
    goals[0].drainFleet = 'new-drain'; fleets.set(fleetKey('fixture', 'new-drain'), 'alive');
    goals[1].drainFleet = 'replacement'; fleets.set(fleetKey('fixture', 'replacement'), 'alive');
    await run();
    const oldFleetKey = goalDrainConditionKey(originals[1], 'drain-fleet-dead', 'dead');
    expect(open.has(oldFleetKey)).toBe(true); // replacement is not recovery of the exact fleet
    expect(open.size).toBe(3); // old fleet plus both unmeasured plans
    goals[1].drainFleet = 'dead';
    cohort = { status: 'known', plans: [plan('plan-A', true, true), plan('plan-B', true, true)] };
    await run(); expect(open.size).toBe(0);
    expect(new Set(resolvedKeys)).toEqual(new Set(openedKeys));
    expect(escalate).toHaveBeenCalled();
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'goal-drain-original-pull-stall-and-post-open-current-member-recovery', item: 'P-014', route: 'condition',
  // Supplemental scenario for the module row bound by the obligation case above.
  rowIds: [],
  run: async () => {
    const { expect } = await import('vitest');
    const { runGoalDrainFleetSweepOnce, readActiveFleetPullStallAlerts, resolveGoalDrainPullRecovery,
      goalDrainPullConditionKey } = await import('../system-health/goal-drain-fleet-watchdog');
    const at = 1_900_000_000_000;
    const openedKeys: string[] = [], resolvedKeys: string[] = [], open = new Set<string>();
    const fleet = { workspaceId: 'fixture', fleetSlug: 'drain' };
    const key = goalDrainPullConditionKey(fleet.workspaceId, fleet.fleetSlug);
    const rail = { broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
      expect(event.oneShot).toBe(true); open.add(event.conditionKey!); openedKeys.push(event.conditionKey!); return true;
    }, resolve: async (event: { conditionKey: string }) => {
      if (!open.delete(event.conditionKey)) return false; resolvedKeys.push(event.conditionKey); return true;
    } };
    await runGoalDrainFleetSweepOnce(null as unknown as import('postgres').Sql, {
      flagEnabled: async () => true, readGoals: async () => ({ goals: [], holders: [] }), rail,
      readPullStallAlerts: async () => [{ ...fleet, liveMemberIds: ['worker'], stalledForMs: 900_000 }],
      escalatePullStall: async () => { expect(open.has(key)).toBe(true); },
    });
    expect(open.size).toBe(1);
    let latest: Record<string, unknown> | null = { condition_key: key, one_shot: true, ts: new Date(at).toISOString() };
    const exact = async (readKey: string) => { expect(readKey).toBe(key); return latest; };
    await resolveGoalDrainPullRecovery(fleet, at - 1, rail, exact); expect(open.size).toBe(1);
    latest = { condition_key: 'other-fleet', one_shot: true, ts: new Date(at).toISOString() };
    await resolveGoalDrainPullRecovery(fleet, at + 1, rail, exact); expect(open.size).toBe(1);
    latest = null; await resolveGoalDrainPullRecovery(fleet, at + 1, rail, exact); expect(open.size).toBe(1);
    latest = { condition_key: key, one_shot: true, ts: new Date(at).toISOString() };
    let successes = [{ owner_id: 'departed-worker', last_success_ms: String(at + 1) }];
    let degraded = false;
    const sql = (async (parts: TemplateStringsArray) => parts.join('').includes('FROM harness_shared.agent_fleets')
      ? [{ workspace_id: 'fixture', fleet_slug: 'drain' }] : successes) as unknown as import('postgres').Sql;
    const readers = {
      // fleetRole 'member': the watchdog counts only live su MEMBERS (a leader never pulls).
      listRoster: (async () => ({ entries: [{ agentId: 'worker', agentRole: 'su', fleetRole: 'member', sessionState: 'live',
        startedAt: new Date(at - 900_000).toISOString() }], degradedLegs: degraded ? ['wakeability'] : [] })) as never,
      listEverMembers: (async () => ['worker', 'departed-worker']) as never,
      onSuccessfulPull: (subject: typeof fleet, atMs: number) => resolveGoalDrainPullRecovery(subject, atMs, rail, exact),
    };
    await readActiveFleetPullStallAlerts(sql, [], at + 2, readers); expect(open.size).toBe(1);
    successes = [{ owner_id: 'worker', last_success_ms: String(at + 1) }];
    degraded = true; await readActiveFleetPullStallAlerts(sql, [], at + 2, readers); expect(open.size).toBe(1);
    degraded = false; await readActiveFleetPullStallAlerts(sql, [], at + 2, readers); expect(open.size).toBe(0);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'goal-plan-fleet-original-brief-read-publishes-independent-keys-and-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['health-flag-no-condition|packages/operator-core/lib/system-health/goal-drain-fleet-watchdog.ts|readGoalPlanFleetObservation|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const { readGoalPlanFleetObservation } = await import('../system-health/goal-drain-fleet-watchdog');
    type Cohort = import('../system-health/goal-drain-fleet-watchdog').GoalPlanFleetCohort;
    const openedKeys: string[] = [], resolvedKeys: string[] = [], open = new Set<string>();
    let unknown = false, omit = false, held = true, broken = true;
    let cohort: Cohort = { status: 'known', plans: ['A', 'B'].map(planSlug => ({
      workspaceId: 'fixture', goalId: 'goal', harnessSlug: 'pot', planSlug, itemIds: ['P-001'], targetingFleets: [],
    })) };
    const read = () => readGoalPlanFleetObservation(null as unknown as import('postgres').Sql,
      { workspaceId: 'fixture', goalId: 'goal' }, {
        readGoals: async () => { if (broken) throw new Error('read unavailable'); return {
          goals: omit ? [] : [{ workspaceId: 'fixture', goalId: 'goal', title: 'Goal', createdAtMs: 1000, drainFleet: null }],
          holders: [{ workspaceId: 'fixture', goalId: 'goal', ownerId: 'holder', setAtMs: 1000 }],
        }; },
        resolveLiveness: async () => held ? new Map([['holder', { ownerId: 'holder', sessionState: 'live',
          wakeable: true, liveTurn: true, heartbeatFresh: true, confirmLiveness: null }]]) : new Map(),
        readCohort: async () => unknown ? { status: 'unknown', plans: [] } : cohort,
        rail: { broadcast: async event => {
          expect(event.oneShot).toBe(true);
          if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
          open.add(event.conditionKey!); return true;
        }, resolve: async event => {
          if (!open.delete(event.conditionKey)) return false;
          resolvedKeys.push(event.conditionKey); return true;
        } },
      });
    expect((await read()).status).toBe('unknown'); expect(open.size).toBe(0);
    broken = false; expect((await read()).alert?.planSlug).toBe('A'); expect(open.size).toBe(2);
    await read(); expect(openedKeys).toHaveLength(2);
    unknown = true; await read(); expect(open.size).toBe(2);
    unknown = false; held = false; await read(); expect(open.size).toBe(2);
    held = true; omit = true; await read(); expect(open.size).toBe(2);
    omit = false;
    cohort = { status: 'known', plans: cohort.plans.map(plan => ({ ...plan, targetingFleets: [
      { fleetSlug: 'repaired', liveness: 'alive', liveClaimItemIds: ['P-001'] },
    ] })) };
    expect((await read()).alert).toBeNull(); expect(open.size).toBe(0);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'placement-original-independent-episodes-and-exact-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/pot/placement-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const { reconcileOnePot, placementConfig } = await import('../pot/placement-watchdog');
    const at = 1_900_000_000_000;
    const open = new Map<string, number>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    let healthy = false, unknown = false, omitted = false;
    const placements = [
      { work_item_id: 'WI-cursed', status: 'cursed', fail_count: 3, disposition: 'breaker' },
      { work_item_id: 'WI-infra', status: 'cursed', fail_count: 0, disposition: 'breaker' },
      { work_item_id: 'WI-stale', status: 'stranded', fail_count: 1, disposition: 'recovery-timeout' },
      { work_item_id: 'WI-blocker', status: 'stranded', fail_count: 0, disposition: 'stranded' },
    ].map(row => ({ ...row, infra_loss_count: row.work_item_id === 'WI-infra' ? 12 : 0,
      escalation_msg_id: 'existing-legacy', last_seen_ms: at, last_loss_spawn_id: null,
      last_recovery_ms: null, recovery_started_ms: null }));
    const sql = (async (parts: TemplateStringsArray) => {
      const query = parts.join('');
      if (query.includes('SELECT f.status, f.payload')) {
        if (unknown) throw new Error('exact subject unreadable');
        return omitted ? [] : [{ status: healthy ? 'done' : 'failing', holder_live: false, downstream: 1, payload: {} }];
      }
      if (query.includes('FROM harness_shared.adv_sessions')) return healthy || omitted ? [] : [{ coord_owner_id: 'fixture-mug' }];
      if (query.includes('AS last_recovery_ms')) return placements;
      if (query.includes('SELECT feature_id, harness_slug, status, taken_by, payload')) return placements.map(row =>
        ({ feature_id: row.work_item_id, harness_slug: 'harness', status: 'open', taken_by: null, payload: {} }));
      if (query.includes('SELECT b.feature_id AS blocker_id')) return [{ blocker_id: 'WI-blocker', blocker_harness: 'harness',
        blocker_status: 'failing', downstream: 1 }];
      if (query.includes('INSERT INTO harness_shared.pot_placements')) expect(open.size).toBeGreaterThan(0);
      return [];
    }) as unknown as import('postgres').Sql;
    const conditions = { readOpenConditions: async () => [...open].map(([conditionKey, openedAtMs]) => ({ conditionKey, openedAtMs })),
      rail: { broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
        expect(event.oneShot).toBe(true);
        if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
        open.set(event.conditionKey!, open.get(event.conditionKey!) ?? at); return true;
      }, resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false; resolvedKeys.push(event.conditionKey); return true;
      } } };
    const run = () => reconcileOnePot(sql, 'fixture', 'pot', placementConfig(), at, () => false, conditions);
    await run(); expect(open.size).toBe(4);
    await run(); expect(open.size).toBe(4); expect(openedKeys).toHaveLength(4);
    omitted = true; await run(); expect(open.size).toBe(4);
    omitted = false; unknown = true;
    const warning = (await import('vitest')).vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { await run(); expect(open.size).toBe(4); expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('exact subject unreadable')); } finally { warning.mockRestore(); }
    unknown = false; healthy = true; await run(); expect(open.size).toBe(0);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'agent-productivity-original-wedge-degenerate-ideate-and-exact-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/agent-productivity-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const { runAgentProductivitySweepOnce, IDEATE_PASS_GRACE_MS } = await import('../system-health/agent-productivity-watchdog');
    const { AGENT_PRODUCTIVITY_GRACE_MS } = await import('../agent-wedge');
    const now = Date.now(), open = new Map<string, number>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const initial = ['wedge', 'degenerate', 'ideate'].map(ownerId => ({ ownerId, ownerLabel: ownerId,
      workspaceId: 'fixture', agentRole: 'su', fleetSlug: null, source: 'omp-hook-session', host: null, pid: null,
      startedAtMs: now - AGENT_PRODUCTIVITY_GRACE_MS - 1000, heartbeatAt: new Date(now).toISOString() }));
    let candidates = initial, healthy = false, unknown = false;
    const deps = { now: () => now, flagEnabled: async () => true, readCandidates: async () => candidates,
      resolveLiveness: async () => new Map(candidates.map(c => [c.ownerId, { ownerId: c.ownerId, sessionState: 'parked',
        wakeable: true, liveTurn: false, selfWake: 'loop' } as unknown as import('../agent-tools/coordination/liveness-oracle').LivenessVerdict])),
      readProductivity: async () => new Map(unknown ? [] : candidates.map(c => [c.ownerId, {
        agentOriginCalls: c.ownerId === 'wedge' && !healthy ? 0 : 100, anyOriginCalls: 120,
        recentCalls: 100, recentTelemetryCalls: c.ownerId === 'degenerate' && !healthy ? 90 : 10,
        recentWorkCalls: c.ownerId === 'degenerate' && !healthy ? 1 : 20,
        recentProgressCalls: c.ownerId === 'degenerate' && !healthy ? 1 : 20,
      }])), readHeldClaims: async () => new Map(), resolveGraders: async () => new Map(),
      readIdeateRegistrations: async () => new Map([['ideate', { setAtMs: now - IDEATE_PASS_GRACE_MS - 1000,
        setBy: 'fixture', ownerDirected: true }]]),
      readIdeatePasses: async () => new Map(healthy ? [['ideate', now]] : []),
      escalateWave: async () => { expect(open.size).toBe(3); }, escalateIdeateWave: async () => { expect(open.size).toBe(3); },
      notifyIdeateWave: async () => {}, escalateDegenerateWakeWave: async () => { expect(open.size).toBe(3); },
      readOpenConditions: async () => [...open].map(([conditionKey, openedAtMs]) => ({ conditionKey, openedAtMs })),
      rail: { broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
        expect(event.oneShot).toBe(true); if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
        open.set(event.conditionKey!, now); return true;
      }, resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false; resolvedKeys.push(event.conditionKey); return true;
      } },
    };
    const sql = {} as import('postgres').Sql;
    await runAgentProductivitySweepOnce(sql, deps); expect(open.size).toBe(3);
    candidates = []; await runAgentProductivitySweepOnce(sql, { ...deps }); expect(open.size).toBe(3);
    candidates = initial; unknown = true; await runAgentProductivitySweepOnce(sql, { ...deps }); expect(open.size).toBe(3);
    unknown = false; healthy = true; await runAgentProductivitySweepOnce(sql, { ...deps }); expect(open.size).toBe(0);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'resource-health-original-objectives-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: [1, 2, 3, 4].map(ordinal => `health-flag-no-condition|packages/operator-core/lib/resource-governor/health-analysis.ts|#assessObjective|${ordinal}`),
  run: async () => {
    const { expect } = await import('vitest');
    const { RollingHealthAnalyzer } = await import('../resource-governor/health-analysis');
    const { measuredLiveHealthReading, liveHealthWindow } = await import('../resource-governor/live-health');
    const openedKeys: string[] = [], resolvedKeys: string[] = [], open = new Map<string, number>();
    const at = 1_700_000_000_000;
    const context = { workspaceId: 'fixture', readOpenConditions: async () =>
      [...open].map(([conditionKey, openedAtMs]) => ({ conditionKey, openedAtMs })),
      rail: { broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
        expect(event.oneShot).toBe(true);
        if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
        open.set(event.conditionKey!, open.get(event.conditionKey!) ?? at + 4_000); return true;
      }, resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false; resolvedKeys.push(event.conditionKey); return true;
      } } };
    const sample = (time: number, latency = 5, failed = false) => ({ scopeId: 'original-producer', atMs: time,
      signals: { 'latency.eventLoopP95Ms': measuredLiveHealthReading({ key: 'latency.eventLoopP95Ms', value: latency,
        writerId: 'operator:fixture', observedAtMs: time, window: liveHealthWindow('rolling', time - 1_000, time), confidence: 1 }),
      'provider.rateLimited': measuredLiveHealthReading({ key: 'provider.rateLimited', value: failed,
        writerId: 'provider-account:fixture', observedAtMs: time, window: liveHealthWindow('instant', time, time), confidence: 1 }) } });
    const analyzer = new RollingHealthAnalyzer();
    for (let i = 0; i < 4; i++) analyzer.primeHealthy(sample(at + i * 1_000));
    await analyzer.evaluate(sample(at + 4_000, 300, true), context);
    expect(open.size).toBe(2);
    await analyzer.evaluate({ scopeId: 'original-producer', atMs: at + 5_000, signals: {} }, context);
    expect(open.size).toBe(2);
    await new RollingHealthAnalyzer().evaluate(sample(at + 5_000, 300, true), context);
    expect(open.size).toBe(2);
    await analyzer.evaluate(sample(at + 6_000), context);
    expect(open.size).toBe(0);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'perf-budget-original-verdict-caller-and-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: [1, 2].map(ordinal => `health-flag-no-condition|packages/operator-core/lib/system-health/perf-budgets.ts|evaluatePerfSignals|${ordinal}`),
  run: async () => {
    const { expect } = await import('vitest');
    const { evaluatePerfSignals, perfBudgetConditionKey } = await import('../system-health/perf-budgets');
    const now = Date.now(), openedKeys: string[] = [], resolvedKeys: string[] = [], open = new Map<string, number>();
    const context = { workspaceId: 'fixture', hostId: 'host',
      readOpenConditions: async () => [...open].map(([conditionKey, openedAtMs]) => ({ conditionKey, openedAtMs })),
      rail: { broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
        expect(event.oneShot).toBe(true); if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
        open.set(event.conditionKey!, now); return true;
      }, resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false; resolvedKeys.push(event.conditionKey); return true;
      } } };
    let sig = { schemaVersion: 'perf-signals-v1', capturedAt: new Date(now).toISOString(), hostState: 'stable', signals: {
      operator_3070_reachable: false, eventLoopLag: { lag_p95_ms: 0, window_mature: true }, closeWait_3070: 0,
      psi: { cpu: { some: { avg60: 99 } }, memory: { full: { avg60: 0 } } },
      inotify: { totalWatches: 100, limits: { maxUserWatches: 1_000_000 } },
    } };
    // Run the actual Infra assignment with only dependency seams replaced.
    const caller = () => execute(original('packages/operator-core/lib/system-health/compute.ts',
      'perf = await evaluatePerfSignals', 'expression'), { sig, ctx: { ws: 'fixture', now }, deployInProgress: false,
      perf: null, hostname: () => 'host', evaluatePerfSignals: (sample: typeof sig, clock: number,
        budgets: undefined, deploy: boolean, scope: { workspaceId: string; hostId: string }) => {
          expect(scope).toEqual({ workspaceId: 'fixture', hostId: 'host' });
          return evaluatePerfSignals(sample, clock, budgets, deploy, context);
        } });
    await caller(); expect([...open.keys()]).toEqual([
      perfBudgetConditionKey('operator', 'fixture', 'host'), perfBudgetConditionKey('ambient', 'fixture', 'host')]);
    await evaluatePerfSignals(null, now, undefined, false, { ...context }); expect(open.size).toBe(2);
    sig = { ...sig, signals: { ...sig.signals, operator_3070_reachable: true,
      psi: { cpu: { some: { avg60: 0 } }, memory: { full: { avg60: 0 } } } } };
    await caller(); expect(open.size).toBe(0);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'identity-activation-original-wedge-census-and-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/wedged-identity-activation-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const { compileAgentSpecification } = await import('@papercusp/orchestrator/blueprint');
    const { runWedgedIdentitySweepOnce, runUnappliedActivationCensusOnce, identityActivationConditionKey } =
      await import('../system-health/wedged-identity-activation-watchdog');
    const artifact = compileAgentSpecification({ source: { id: 'rail-identity', workItem: { kind: 'feature' },
      spine: { edges: { DONE: { to: 'done' } } } }, prompt: { role: 'worker', text: 'Identity rail fixture.' }, inputClosure: [] });
    const pair = { specificationRevision: artifact.specificationRevision, stateRevision: 'fixture-state' };
    const activation = { schemaVersion: 1, attribution: { actorId: 'original-owner', principalId: 'system:superuser',
      sessionId: 'original-owner' }, desired: pair, prepared: null, applied: pair, status: 'applied' };
    const ownerId = 'original-owner', workspaceId = 'fixture';
    const candidate = { ownerId, activation, advSessionId: null as string | null, launchSpec: {
      workspaceId, harnessSlug: 'papercusp', ...pair, specificationArtifact: artifact } };
    let candidates = [candidate];
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const key = (kind: 'wedged' | 'unapplied') => identityActivationConditionKey(kind, workspaceId, ownerId);
    const rail = { broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
      expect(event.oneShot).toBe(true);
      if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
      open.add(event.conditionKey!); return true;
    }, resolve: async (event: { conditionKey: string }) => {
      if (!open.delete(event.conditionKey)) return false;
      resolvedKeys.push(event.conditionKey); return true;
    } };
    const seam = { workspaceId, rail, readOpenConditions: async () => [...open],
      resolveLiveness: async (ids: string[]) => new Map(ids.map(id => [id, 'live' as const])) };
    const wedge = { ...seam, loadCandidates: async () => candidates,
      verdictCache: { verdicts: new Map(), lastReused: 0, lastScanned: 0, lastRetired: 0 },
      yieldAfterClassified: async (count: number) => count + 1,
      escalateWedged: async () => { expect(open.has(key('wedged'))).toBe(true); },
      escalateNotMeasured: async () => {}, loadDenialAttestations: async () => [] };
    await runWedgedIdentitySweepOnce(wedge);
    candidates = [{ ...candidate, ownerId: 'foreign-owner', advSessionId: '1' }];
    await runWedgedIdentitySweepOnce(wedge); expect(open.has(key('wedged'))).toBe(true);
    candidates = [{ ...candidate, advSessionId: '1' }]; await runWedgedIdentitySweepOnce(wedge);
    expect(open.has(key('wedged'))).toBe(false);
    let censusRows = [{ ownerId, activation: { ...activation, prepared: pair as typeof pair | null, applied: null as typeof pair | null,
      status: 'prepared' }, unappliedSince: new Date().toISOString(), turnsSince: 2 }];
    const census = { ...seam, loadUnapplied: async (owners: readonly string[]) => {
      if (open.has(key('unapplied'))) expect(owners).toContain(ownerId);
      return censusRows;
    }, loadPositiveControl: async () => ({ recentBriefs: 1, recentJournalTurns: 2 }),
    escalateUnapplied: async () => { expect(open.has(key('unapplied'))).toBe(true); }, escalateNotMeasured: async () => {} };
    await runUnappliedActivationCensusOnce(census);
    censusRows = []; await runUnappliedActivationCensusOnce(census); expect(open.has(key('unapplied'))).toBe(true);
    censusRows = [{ ownerId, activation, unappliedSince: new Date().toISOString(), turnsSince: 0 }];
    await runUnappliedActivationCensusOnce(census); expect(open.size).toBe(0);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'codex-rollout-original-persistence-provider-and-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/codex-rollout-persistence-watchdog.ts|<module>|1',
    ...[1, 2].map(ordinal => `owner-only-alarm|packages/operator-core/lib/system-health/codex-rollout-persistence-watchdog.ts|checkCodexRolloutPersistence|${ordinal}`)],
  run: async () => {
    const { expect } = await import('vitest');
    const { mkdir, mkdtemp, rm, utimes, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { checkCodexRolloutPersistence, codexRolloutConditionKey } = await import('../system-health/codex-rollout-persistence-watchdog');
    const root = await mkdtemp(join(tmpdir(), 'codex-rail-matrix-'));
    const savedHome = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
    let now = Date.now() + 1000, tailUnknown = false;
    const row = { id: 42, owner_id: 'original-codex-owner', workspace_id: 'fixture', pid: 123 };
    let rows = [row], broadcastCount = 0;
    const open = new Map<string, number>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const key = (kind: 'persistence' | 'provider') => codexRolloutConditionKey(kind, row.workspace_id, '42', row.owner_id);
    const day = join(root, 'session-42', 'sessions', '2026', '10', '12');
    const history = join(root, 'session-42', 'history.jsonl'), rollout = join(day, 'rollout-original.jsonl');
    const sql = (async (parts: TemplateStringsArray) => {
      const query = parts.join('');
      if (query.includes('SELECT id, coord_owner_id AS owner_id')) return rows;
      if (query.includes('INSERT INTO harness_shared.harness_escalations')) expect(open.size).toBeGreaterThan(0);
      return []; // Existing legacy escalation coalesces; it must not suppress the keyed alarm.
    }) as unknown as import('postgres').Sql;
    const opts = { now: () => now, pidAlive: () => true,
      readOpenConditions: async () => [...open].map(([conditionKey, openedAtMs]) => ({ conditionKey, openedAtMs })),
      readRolloutTail: async () => tailUnknown ? null : (await import('node:fs/promises')).readFile(rollout, 'utf8'),
      rail: { broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
        expect(event.oneShot).toBe(true); broadcastCount++;
        if (!open.has(event.conditionKey!)) { open.set(event.conditionKey!, now); openedKeys.push(event.conditionKey!); }
        return true;
      }, resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false;
        resolvedKeys.push(event.conditionKey); return true;
      } },
    };
    try {
      await mkdir(day, { recursive: true }); await writeFile(history, '{}\n');
      await writeFile(rollout, [1, 2, 3].map(turn => JSON.stringify({ type: 'event_msg',
        payload: { type: 'task_complete', status: 'error', turn_id: String(turn),
          error: { codex_error_info: 'usageLimitExceeded', message: 'provider failed' } } })).join('\n') + '\n');
      await utimes(history, new Date(now - 60_000), new Date(now - 60_000));
      await utimes(rollout, new Date(now - 17 * 60_000), new Date(now - 17 * 60_000));
      await checkCodexRolloutPersistence(sql, opts);
      expect(openedKeys.sort()).toEqual([key('persistence'), key('provider')].sort());
      // Persistence refreshes each pass; the still-open provider episode dedupes.
      await checkCodexRolloutPersistence(sql, opts); expect(broadcastCount).toBe(3);
      rows = []; await checkCodexRolloutPersistence(sql, opts); expect(resolvedKeys).toEqual([]);
      now += 1000;
      await writeFile(rollout, JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg',
        payload: { type: 'task_complete', status: 'completed' } }) + '\n');
      await utimes(history, new Date(now), new Date(now)); await utimes(rollout, new Date(now), new Date(now));
      rows = [{ ...row, owner_id: 'foreign-owner', workspace_id: 'foreign-workspace' }];
      await checkCodexRolloutPersistence(sql, opts); expect(resolvedKeys).toEqual([]);
      rows = [row]; tailUnknown = true;
      await checkCodexRolloutPersistence(sql, opts); expect(resolvedKeys).toEqual([key('persistence')]);
      expect(open.has(key('provider'))).toBe(true);
      tailUnknown = false; await checkCodexRolloutPersistence(sql, opts);
      expect(open.size).toBe(0);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally {
      if (savedHome === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
      else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = savedHome;
      await rm(root, { recursive: true, force: true });
    }
  },
}, {
  id: 'goal-owner-report-original-silence-and-exact-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/goal-owner-report-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const { runGoalOwnerReportSweepOnce, goalOwnerReportConditionKey } = await import('../system-health/goal-owner-report-watchdog');
    const now = Date.now(), hour = 3600_000;
    const row = { workspaceId: 'fixture', goalId: 'original-goal', agentId: 'original-owner',
      baselineTsMs: now - 24 * hour, lastReportTsMs: null as number | null, standing: true };
    const key = goalOwnerReportConditionKey(row), openedKeys: string[] = [], resolvedKeys: string[] = [];
    let candidates = [row], open: string[] = [], report = [row];
    const nudge = vi.fn(async () => {});
    const deps = { now: () => now, flagEnabled: async () => true,
      readGoalModeOwners: async () => candidates, readOpenConditionKeys: async () => open,
      readReport: async (identity: { workspaceId: string; goalId: string; ownerId: string }) => {
        expect(identity).toEqual({ workspaceId: row.workspaceId, goalId: row.goalId, ownerId: row.agentId }); return report;
      },
      resolveLiveness: async () => new Map([[row.agentId, { ownerId: row.agentId, sessionState: 'live' as const,
        wakeable: true, liveTurn: true, confirmLiveness: null, heartbeatFresh: true }]]),
      escalate: async () => { expect(openedKeys).toContain(key); return { coalesced: true }; }, nudge,
      rail: { broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
        expect(event.oneShot).toBe(true); openedKeys.push(event.conditionKey!); return true;
      }, resolve: async (event: { conditionKey: string }) => { resolvedKeys.push(event.conditionKey); return true; } },
    };
    const sql = (() => { throw new Error('injected original producer must not query live PG'); }) as unknown as import('postgres').Sql;
    await runGoalOwnerReportSweepOnce(sql, deps);
    expect(openedKeys).toEqual([key]); expect(nudge).not.toHaveBeenCalled();
    candidates = []; open = [key]; report = [];
    await runGoalOwnerReportSweepOnce(sql, deps); expect(resolvedKeys).toEqual([]);
    report = [{ ...row, workspaceId: 'foreign', lastReportTsMs: now }];
    await runGoalOwnerReportSweepOnce(sql, deps); expect(resolvedKeys).toEqual([]);
    report = [{ ...row, lastReportTsMs: now - 2 * hour }];
    await runGoalOwnerReportSweepOnce(sql, deps); expect(resolvedKeys).toEqual([]);
    report = [{ ...row, lastReportTsMs: now - 10 * 60_000 }];
    await runGoalOwnerReportSweepOnce(sql, deps);
    expect(resolvedKeys).toEqual([key]);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'session-ingest-original-backlog-parts-and-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/search/session-ingest-lag-watchdog.ts|<module>|1',
    ...[1, 2, 3, 4].map(ordinal => `health-flag-no-condition|packages/operator-core/lib/search/session-ingest-lag-watchdog.ts|evaluatePartsWriter|${ordinal}`)],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const producer = await import('../search/session-ingest-lag-watchdog');
    const { evaluateInteractiveUsageFreshness } = await import('../interactive-usage/freshness');
    const now = Date.parse('2026-10-12T12:00:00Z'), hour = 3600_000;
    const opts = { workspaceId: 'fixture', installSlug: 'fixture' };
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    let recovery: boolean | null = null, healthyUsage = false;
    const deps = { now, readOpenConditionKeys: async () => [...open],
      readBacklogRecovery: async () => recovery,
      observeInteractiveUsageFreshness: async () => evaluateInteractiveUsageFreshness(
        healthyUsage ? now : now - hour, now, undefined, 0),
      recentWatchdogFires: async () => 1, recordFire: async () => undefined as never,
      openEscalation: async () => { throw new Error('legacy must remain debounced'); }, rail: {
        broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
          expect(event.oneShot).toBe(true);
          if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
          open.add(event.conditionKey!); return true;
        }, resolve: async (event: { conditionKey: string }) => {
          if (!open.delete(event.conditionKey)) return false;
          resolvedKeys.push(event.conditionKey); return true;
        } } };
    const savedLag = process.env.PAPERCUSP_INGEST_LAG_THRESHOLD_SEC;
    const savedParts = process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC;
    process.env.PAPERCUSP_INGEST_LAG_THRESHOLD_SEC = '3600';
    process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC = '3600';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await producer.sessionIngestLagSweep(opts, { ...deps, observe: async () => [{ sourceKind: 'codex',
        behindFiles: 1, backlogBytes: 2e6, oldestBacklogAgeMs: 6 * hour, worstPath: '/rollout' }] });
      const parts = { sourceKind: 'claude', expectsParts: true, turnsInWindow: 10, partsInWindow: 0 };
      await producer.sessionPartsWriterSweep(opts, { ...deps, observe: async () => [parts] });
      expect(open.size).toBe(3);
      await producer.sessionIngestLagSweep(opts, { ...deps, observe: async () => [] });
      await producer.sessionPartsWriterSweep(opts, { ...deps, observe: async () => [{ ...parts, turnsInWindow: 0 }] });
      await producer.sessionPartsWriterSweep(opts, { ...deps, observe: async () => [{ ...parts, expectsParts: false }] });
      expect(open.size).toBe(3);
      recovery = true; healthyUsage = true;
      await producer.sessionIngestLagSweep(opts, { ...deps, observe: async () => [] });
      await producer.sessionPartsWriterSweep(opts, { ...deps, observe: async () => [{ ...parts, partsInWindow: 1 }] });
      expect(open.size).toBe(0);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally {
      warn.mockRestore();
      if (savedLag === undefined) delete process.env.PAPERCUSP_INGEST_LAG_THRESHOLD_SEC;
      else process.env.PAPERCUSP_INGEST_LAG_THRESHOLD_SEC = savedLag;
      if (savedParts === undefined) delete process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC;
      else process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC = savedParts;
    }
  },
}, {
  id: 'draft-review-original-stale-and-exact-durable-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/scout/draft-review-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const producer = await import('../scout/draft-review-watchdog');
    const org = await import('@papercusp/db-org');
    const scopes = await import('../pot/started');
    const legacy = await import('../pot/watchdog');
    const membership = await import('../pot-membership');
    const now = Date.parse('2026-10-12T12:00:00Z');
    const current = { workspace_id: 'fixture', harness_slug: 'fixture-pot', plan_slug: 'fixture-idea',
      status: 'draft', archived: false, title: null, updated_at_ms: now - 48 * 3600_000,
      items: [], decisions: [] as object[], content: '\norigin: scout\n' };
    let candidates = [current], exists = true, readable = true;
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join(' ');
      if (query.includes('SELECT DISTINCT workspace_id')) return [];
      if (query.includes('AND plan_slug =')) {
        if (!readable) throw new Error('exact plan read unavailable');
        return exists ? [current] : [];
      }
      return candidates;
    }) as unknown as import('postgres').Sql;
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const deps = { now, readOpenConditionKeys: async () => [...open], rail: {
      broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
        expect(event.oneShot).toBe(true);
        if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
        open.add(event.conditionKey!); return true;
      }, resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false;
        resolvedKeys.push(event.conditionKey); return true;
      } } };
    const originalThreshold = process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC;
    process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC = '43200';
    const spies = [vi.spyOn(org, 'getOrgPg').mockReturnValue({ sql } as never),
      vi.spyOn(scopes, 'listBlenderMaintenanceScopes').mockResolvedValue([{ workspaceId: 'fixture', installSlug: 'fixture-pot' }]),
      vi.spyOn(membership, 'routineStorageSlug').mockResolvedValue('fixture-pot'),
      vi.spyOn(legacy, 'claimWatchdogFire').mockResolvedValue(false),
      vi.spyOn(console, 'warn').mockImplementation(() => {})];
    try {
      await producer.scoutDraftReviewSweep(deps); expect(open.size).toBe(1);
      candidates = []; await producer.scoutDraftReviewSweep({ ...deps }); expect(open.size).toBe(1);
      readable = false; await producer.scoutDraftReviewSweep({ ...deps }); expect(open.size).toBe(1);
      readable = true; exists = false;
      current.decisions = [{ id: 'D-001', body: 'Reviewed; needs revision' }];
      await producer.scoutDraftReviewSweep({ ...deps }); expect(open.size).toBe(1);
      exists = true; await producer.scoutDraftReviewSweep({ ...deps }); expect(open.size).toBe(0);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally {
      spies.forEach(spy => spy.mockRestore());
      if (originalThreshold === undefined) delete process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC;
      else process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC = originalThreshold;
    }
  },
}, {
  id: 'goal-grading-original-backlog-and-exact-durable-recovery', item: 'P-014', route: 'condition',
  rowIds: ['health-flag-no-condition|packages/operator-core/lib/system-health/goal-grading-backlog-sweep.ts|runGoalGradingBacklogSweepOnce|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const { runGoalGradingBacklogSweepOnce } = await import('../system-health/goal-grading-backlog-sweep');
    const now = Date.parse('2026-10-12T12:00:00Z'), hour = 3600_000;
    const goal = { workspaceId: 'fixture', goalId: 'fixture:goal' };
    let candidates = [goal], exists = true, healthy = false, readable = true;
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const deps = { flagEnabled: async () => true, now: () => now,
      readGoals: async () => candidates, readGoal: async () => exists ? goal : null,
      readOpenConditionKeys: async () => [...open],
      readInput: async () => {
        if (!readable) throw new Error('backlog ledger unavailable');
        return { goalId: goal.goalId, nowMs: now, activityMs: Array.from({ length: 10 }, (_, i) => now - (i + 1) * hour),
          cards: healthy ? [{ windowStartMs: now - 11 * hour, windowEndMs: now, createdMs: now, final: true }] : [] };
      },
      resolveLiveness: async () => new Map(),
      escalate: async () => { throw new Error('legacy unavailable'); },
      wakeGrader: async () => {}, resolveCleared: async () => 0, rail: {
        broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
          expect(event.oneShot).toBe(true);
          if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
          open.add(event.conditionKey!); return true;
        }, resolve: async (event: { conditionKey: string }) => {
          if (!open.delete(event.conditionKey)) return false;
          resolvedKeys.push(event.conditionKey); return true;
        } } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runGoalGradingBacklogSweepOnce({} as never, deps); expect(open.size).toBe(1);
      candidates = []; readable = false;
      await runGoalGradingBacklogSweepOnce({} as never, { ...deps }); expect(open.size).toBe(1);
      readable = true; exists = false; healthy = true;
      await runGoalGradingBacklogSweepOnce({} as never, { ...deps }); expect(open.size).toBe(1);
      exists = true;
      await runGoalGradingBacklogSweepOnce({} as never, { ...deps }); expect(open.size).toBe(0);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { warn.mockRestore(); }
  },
}, {
  id: 'ungraded-filings-original-stale-coverage-and-exact-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/scout/ungraded-filings-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const producer = await import('../scout/ungraded-filings-watchdog');
    const org = await import('@papercusp/db-org');
    const scopes = await import('../pot/started');
    const legacy = await import('../pot/watchdog');
    const now = Date.parse('2026-10-12T12:00:00Z');
    let candidates = [{ idea_id: 'fixture-idea', origin: 'fixture-origin', title: null,
      routed_ref: 'wi:fixture', routed_at: now - 14 * 86_400_000 }];
    let remaining: number | null = 1, uncovered = 1;
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join(' ');
      if (query.includes('SELECT count(*)')) {
        if (remaining == null) throw new Error('count unavailable');
        return [{ c: query.includes('NOT EXISTS') ? uncovered : remaining }];
      }
      if (query.includes('row_number()')) return candidates;
      return [];
    }) as unknown as import('postgres').Sql;
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const deps = { now, readOpenConditionKeys: async () => [...open], rail: {
      broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
        expect(event.oneShot).toBe(true);
        if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
        open.add(event.conditionKey!); return true;
      }, resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false;
        resolvedKeys.push(event.conditionKey); return true;
      } } };
    const originalThreshold = process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC;
    process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC = '604800';
    const spies = [vi.spyOn(org, 'getOrgPg').mockReturnValue({ sql } as never),
      vi.spyOn(scopes, 'listBlenderMaintenanceScopes').mockResolvedValue([{ workspaceId: 'fixture', installSlug: 'papercusp' }]),
      vi.spyOn(scopes, 'listBlenderMaintenanceWorkspaceIds').mockReturnValue(['fixture']),
      vi.spyOn(legacy, 'recentWatchdogFires').mockRejectedValue(new Error('legacy ledger unavailable')),
      vi.spyOn(console, 'warn').mockImplementation(() => {})];
    try {
      await producer.ungradedFilingsSweep(deps); expect(open.size).toBe(2);
      candidates = []; await producer.ungradedFilingsSweep({ ...deps }); expect(open.size).toBe(2);
      remaining = null; await producer.ungradedFilingsSweep({ ...deps }); expect(open.size).toBe(2);
      remaining = 0; uncovered = 0;
      await producer.ungradedFilingsSweep({ ...deps }); expect(open.size).toBe(0);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally {
      spies.forEach(spy => spy.mockRestore());
      if (originalThreshold === undefined) delete process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC;
      else process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC = originalThreshold;
    }
  },
}, {
  id: 'goal-edit-claim-original-monotonic-violation-and-terminal-goal-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/goal-edit-claim-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const { runGoalEditClaimSweepOnce } = await import('../system-health/goal-edit-claim-watchdog');
    const row: import('../system-health/goal-edit-claim-watchdog').EditClaimRowLike = {
      ledgerId: 1, workspaceId: 'fixture', goalId: 'fixture-goal', agentId: 'fixture-owner',
      file: 'fixture.ts', repo: 'fixture', tsMs: 1_800_000_000_000 };
    let rows = [row], status = 'active';
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const deps = { flagEnabled: async () => true,
      readNewEditClaims: async () => ({ rows, ledgerMaxId: 1 }),
      resolveGraders: async () => new Map<string, string[]>(),
      escalate: async () => { throw new Error('legacy unavailable'); }, notify: async () => {}, emitEditClaim: async () => {},
      readOpenConditionKeys: async () => [...open],
      readGoalState: async () => ({ workspaceId: row.workspaceId, goalId: row.goalId, status }), rail: {
        broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
          expect(event.oneShot).toBe(true); open.add(event.conditionKey!); openedKeys.push(event.conditionKey!); return true;
        }, resolve: async (event: { conditionKey: string }) => {
          if (!open.delete(event.conditionKey)) return false;
          resolvedKeys.push(event.conditionKey); return true;
        } } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runGoalEditClaimSweepOnce({} as never, null, deps); expect(open.size).toBe(1);
      rows = []; await runGoalEditClaimSweepOnce({} as never, 1, { ...deps }); expect(open.size).toBe(1);
      status = 'paused'; await runGoalEditClaimSweepOnce({} as never, 1, { ...deps }); expect(open.size).toBe(1);
      status = 'achieved'; await runGoalEditClaimSweepOnce({} as never, null, { ...deps }); expect(open.size).toBe(0);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { warn.mockRestore(); }
  },
}, {
  id: 'carry-delivery-original-independent-episodes-and-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/carry-drill-drop-watchdog.ts|<module>|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const producer = await import('../system-health/carry-drill-drop-watchdog');
    const now = Date.parse('2026-10-12T12:00:00Z');
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const deps = { host: () => 'fixture-carry', now: () => now, flagEnabled: async () => true,
      readOpenConditionKeys: async () => [...open], rail: {
        broadcast: async (event: { conditionKey?: string; oneShot?: boolean }) => {
          expect(event.oneShot).toBe(true); open.add(event.conditionKey!); openedKeys.push(event.conditionKey!); return true;
        }, resolve: async (event: { conditionKey: string }) => {
          if (!open.delete(event.conditionKey)) return false;
          resolvedKeys.push(event.conditionKey); return true;
        } } };
    const dropped: import('../cold-boot-drill-live').ColdBootDrillLedgerEvent = {
      drillId: 'fixture-drill', ownerId: 'fixture-owner', sessionClass: 'fixture',
      kind: 'carry-drill-carry-dropped', ts: new Date(now - 1_000).toISOString(),
    };
    await producer.runCarryDrillDropSweepOnce(now - 2_000, { ...deps,
      readLedger: async () => [dropped], escalate: async () => {} });
    await producer.runProductionCarryDeliverySweepOnce({ ...deps, minTerminalOutcomes: 1,
      readEvents: async () => [{ kind: 'respawn-failed', mode: 'carry-respawn', ts: dropped.ts }], escalate: async () => {} });
    const prior = { outcome: 'pending' as const, ts: new Date(now - 600_000).toISOString(), ageMs: 600_000, capMs: 360_000 };
    await producer.runOrphanedRespawnSweepOnce({ ...deps, listCandidates: async () => ['fixture-owner'],
      readPrior: async () => prior, hostLive: () => false, escalate: async () => {} });
    expect(open.size).toBe(3);
    await producer.runCarryDrillDropSweepOnce(now, { ...deps, readLedger: async () => [], escalate: async () => {} });
    await producer.runProductionCarryDeliverySweepOnce({ ...deps, readEvents: async () => [], escalate: async () => {} });
    await producer.runOrphanedRespawnSweepOnce({ ...deps, listCandidates: async () => [],
      readPrior: async () => ({ outcome: 'none' }), hostLive: () => true, escalate: async () => {} });
    expect(open.size).toBe(3);
    await producer.runCarryDrillDropSweepOnce(now, { ...deps,
      readLedger: async () => [{ ...dropped, kind: 'carry-drill-carry-delivered', ts: new Date(now).toISOString() }], escalate: async () => {} });
    await producer.runProductionCarryDeliverySweepOnce({ ...deps, minTerminalOutcomes: 1,
      readEvents: async () => [{ kind: 'respawn-carry-delivered', mode: 'carry-respawn', ts: new Date(now).toISOString() }], escalate: async () => {} });
    await producer.runOrphanedRespawnSweepOnce({ ...deps, listCandidates: async () => [],
      readPrior: async () => ({ outcome: 'delivered', ts: new Date(now).toISOString() }), hostLive: () => false, escalate: async () => {} });
    expect(open.size).toBe(0);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'dedup-probe-original-independent-legs-and-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['health-flag-no-condition|packages/operator-core/lib/agent-tools/work_items/semantic-dedup-probe-alarm.ts|reportSemanticDedupProbeUnavailable|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const { reportSemanticDedupProbeUnavailable } = await import('../agent-tools/work_items/semantic-dedup-probe-alarm');
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const deps = { escalate: async () => {}, rail: {
      broadcast: async (event: { conditionKey?: string }) => {
        open.add(event.conditionKey!); openedKeys.push(event.conditionKey!); return true;
      }, resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false;
        resolvedKeys.push(event.conditionKey); return true;
      } } };
    await reportSemanticDedupProbeUnavailable({ harnessSlug: 'fixture-dedup' }, deps);
    expect(open.size).toBe(1);
    await reportSemanticDedupProbeUnavailable({ harnessSlug: 'fixture-dedup',
      coverage: { semantic: 'skipped', degraded: false } }, deps);
    expect(open.size).toBe(1);
    await reportSemanticDedupProbeUnavailable({ harnessSlug: 'fixture-dedup',
      coverage: { semantic: 'ok', degraded: false } }, deps);
    expect(open.size).toBe(0);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'installed-hook-original-drift-blindness-and-complete-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/installed-hook-drift-watchdog.ts|<module>|1'],
  run: async () => {
    const { runInstalledHookDriftSweepOnce } = await import('../system-health/installed-hook-drift-watchdog');
    const { expect } = await import('vitest');
    const clean: import('../desktop-install/installed-hook-drift').HookDriftReport = {
      canonicalDir: '/fixture/canonical', installedDir: '/fixture/installed',
      checked: ['guard.mjs'], drifted: [], clean: true };
    let report = { ...clean, clean: false, drifted: [{ name: 'guard.mjs', status: 'divergent' as const,
      canonicalSha256: 'new', installedSha256: 'old' }] } as typeof clean;
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const deps = { host: () => 'fixture-hook', resolveCanonical: () => ({ ok: true as const,
      dir: clean.canonicalDir, source: 'integration-root' as const }), resolveInstalled: () => clean.installedDir,
      detect: () => report, escalateDrift: async () => {}, escalateNotMeasured: async () => {}, rail: {
        broadcast: async (event: { conditionKey?: string }) => {
          open.add(event.conditionKey!); openedKeys.push(event.conditionKey!); return true;
        }, resolve: async (event: { conditionKey: string }) => {
          if (!open.delete(event.conditionKey)) return false;
          resolvedKeys.push(event.conditionKey); return true;
        } } };
    await runInstalledHookDriftSweepOnce(deps); expect(open.size).toBe(1);
    report = { ...clean, clean: false, checked: [], refused: 'installed-dir-unreadable' };
    await runInstalledHookDriftSweepOnce({ ...deps }); expect(open.size).toBe(2);
    report = clean; await runInstalledHookDriftSweepOnce({ ...deps }); expect(open.size).toBe(0);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'unservable-critical-original-exact-item-and-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/unservable-critical-watchdog.ts|<module>|1'],
  run: async () => {
    const { runUnservableCriticalSweepOnce } = await import('../system-health/unservable-critical-watchdog');
    const { expect, vi } = await import('vitest');
    const now = 1_800_000_000_000;
    const item: import('../system-health/unservable-critical-watchdog').UnservableItemRow = {
      itemId: 'WI-fixture', workspaceId: 'fixture', harnessSlug: 'fixture', title: 'Stranded critical',
      severity: 'critical', floor: 'claim-hold', createdAtMs: now - 30 * 86_400_000,
      lastWriteAtMs: now - 30 * 86_400_000 };
    let candidates = [item], measured = [item];
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const rail = { broadcast: async (event: { conditionKey?: string }) => {
      open.add(event.conditionKey!); openedKeys.push(event.conditionKey!); return true;
    }, resolve: async (event: { conditionKey: string }) => {
      if (!open.delete(event.conditionKey)) return false;
      resolvedKeys.push(event.conditionKey); return true;
    } };
    const deps = { rail, readOpenConditionKeys: async () => [...open],
      readRows: async (opts?: { recoveryFor?: unknown[] }) => opts?.recoveryFor ? measured : candidates,
      flagEnabled: async () => true, now: () => now,
      escalate: async () => { throw new Error('legacy unavailable'); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runUnservableCriticalSweepOnce({} as never, deps); expect(open.size).toBe(1);
      candidates = []; measured = [];
      await runUnservableCriticalSweepOnce({} as never, { ...deps }); expect(open.size).toBe(1);
      measured = [{ ...item, lastWriteAtMs: now - 86_400_000 }];
      await runUnservableCriticalSweepOnce({} as never, { ...deps }); expect(open.size).toBe(0);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { warn.mockRestore(); }
  },
}, {
  id: 'wall-lapse-original-debounced-condition-and-exact-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/wall-lapse-watchdog.ts|<module>|1'],
  run: async () => {
    const { wallLapseSweep } = await import('../wall-lapse-watchdog');
    const { expect } = await import('vitest');
    const fact: import('../agent-facts/store').LapsedWallFact = {
      workspaceId: 'fixture', scope: 'owner', scopeRef: 'fixture-owner', key: 'wall:fixture',
      body: 'Pending owner action', createdBy: 'fixture', expiresAt: '2020-01-01T00:00:00Z' };
    let lapsed = true, recovered = false;
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const rail = { broadcast: async (event: { conditionKey?: string }) => {
      open.add(event.conditionKey!); openedKeys.push(event.conditionKey!); return true;
    }, resolve: async (event: { conditionKey: string }) => {
      if (!open.delete(event.conditionKey)) return false;
      resolvedKeys.push(event.conditionKey); return true;
    } };
    const deps = { rail, readOpenConditionKeys: async () => [...open],
      listLapsedWallFacts: async (opts?: { recoveryFor?: unknown[] }) => opts?.recoveryFor
        ? (recovered ? [{ ...fact, recovered: true }] : []) : (lapsed ? [fact] : []),
      recentWatchdogFires: async () => 1,
      openEscalation: async () => { throw new Error('debounced legacy must not run'); } };
    expect((await wallLapseSweep(deps))[0].outcome).toBe('debounced'); expect(open.size).toBe(1);
    lapsed = false; await wallLapseSweep(deps); expect(open.size).toBe(1);
    recovered = true; await wallLapseSweep({ ...deps }); expect(open.size).toBe(0);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'kernel-leak-original-independent-signals-and-measured-trend-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/kernel-leak-watchdog.ts|<module>|1'],
  run: async () => {
    const { runKernelLeakCheckOnce } = await import('../system-health/kernel-leak-watchdog');
    const { expect, vi } = await import('vitest');
    const hour = 3_600_000, gib = 1024 ** 3;
    const sample = (n: number, high: boolean): import('../system-health/kernel-leak-watchdog').KernelMemorySample => ({
      bootId: 'fixture-boot', host: 'fixture-kernel', sampledAtMs: (7 + n) * hour, bootedAtMs: 0,
      memTotalBytes: 100 * gib, sUnreclaimBytes: high ? (20 + n / 4) * gib : gib, slabBytes: 25 * gib,
      dyingDescendants: high ? 1500 + n * 50 : 100 });
    let rows = Array.from({ length: 14 }, (_, n) => sample(n, true));
    let current: import('../system-health/kernel-leak-watchdog').KernelMemorySample | null = rows[13];
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const rail = { broadcast: async (event: { conditionKey?: string }) => {
      open.add(event.conditionKey!); openedKeys.push(event.conditionKey!); return true;
    }, resolve: async (event: { conditionKey: string }) => {
      if (!open.delete(event.conditionKey)) return false;
      resolvedKeys.push(event.conditionKey); return true;
    } };
    const deps = { rail, readSample: async () => current, store: async () => {}, prune: async () => {},
      loadSeries: async () => rows, escalate: async () => { throw new Error('legacy unavailable'); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runKernelLeakCheckOnce(deps); expect(open.size).toBe(3);
      current = null; await runKernelLeakCheckOnce(deps); expect(resolvedKeys).toEqual([]);
      current = { ...sample(13, false), dyingDescendants: null }; rows = [current];
      await runKernelLeakCheckOnce(deps); expect(open.size).toBe(2);
      rows = Array.from({ length: 14 }, (_, n) => sample(n, false)); current = rows[13];
      await runKernelLeakCheckOnce(deps); expect(open.size).toBe(0);
      expect(warn).toHaveBeenCalled();
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { warn.mockRestore(); }
  },
}, {
  id: 'cluster-lag-original-silent-worker-and-confirmed-replacement-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/cluster-lag-watchdog.ts|<module>|1'],
  run: async () => {
    const { startClusterLagWatchdog, CLUSTER_HEARTBEAT_TYPE } = await import('../system-health/cluster-lag-watchdog');
    const { expect, vi } = await import('vitest');
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const handlers: { message?: (worker: { id: number }, message: unknown) => void;
      exit?: (worker: { id: number }) => void } = {};
    const cluster = { on: (event: 'message' | 'exit', cb: never) => { handlers[event] = cb; } };
    const beat = (id: number) => handlers.message?.({ id }, { type: CLUSTER_HEARTBEAT_TYPE });
    const rail = {
      broadcast: async (event: { conditionKey?: string }) => {
        if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
        open.add(event.conditionKey!); return true;
      },
      resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false;
        resolvedKeys.push(event.conditionKey); return true;
      },
    };
    vi.useFakeTimers();
    const wd = startClusterLagWatchdog({ cluster, rail, host: 'fixture-cluster', scanMs: 1_000, silenceMs: 2_000,
      workerById: (id) => ({ id, kill: () => { throw new Error('kill still pending'); } }), log: () => {} });
    try {
      beat(1); vi.setSystemTime(Date.now() + 3_000);
      await vi.advanceTimersByTimeAsync(1_000); await wd.settled();
      expect([...open]).toEqual(['alarm:cluster-lag:fixture-cluster']);
      beat(2); await vi.advanceTimersByTimeAsync(1_000); await wd.settled();
      expect(resolvedKeys).toEqual([]);
      handlers.exit?.({ id: 1 }); beat(2);
      await vi.advanceTimersByTimeAsync(1_000); await wd.settled();
      expect(resolvedKeys).toEqual([]);
      beat(3); beat(2); await vi.advanceTimersByTimeAsync(1_000); await wd.settled();
      expect(open.size).toBe(0);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { wd.stop(); vi.useRealTimers(); }
  },
}, {
  id: 'service-restart-original-per-unit-breach-and-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/service-restart-rate-watchdog.ts|<module>|1'],
  run: async () => {
    const { runRestartRateSweepOnce } = await import('../system-health/service-restart-rate-watchdog');
    const { expect } = await import('vitest');
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const rail = {
      broadcast: async (event: { conditionKey?: string }) => { open.add(event.conditionKey!); openedKeys.push(event.conditionKey!); return true; },
      resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false;
        resolvedKeys.push(event.conditionKey); return true;
      },
    };
    let reading: import('../system-health/service-restart-rate-watchdog').RestartRateReading = {
      unit: 'fixture.service', starts: 20, atLeast: false, unreadable: null };
    const deps = { units: ['fixture.service'], rail, flagEnabled: async () => true,
      readStarts: async () => reading, escalate: async () => { throw new Error('legacy failed'); } };
    await runRestartRateSweepOnce(deps);
    reading = { ...reading, starts: null, unreadable: 'journal failed' }; await runRestartRateSweepOnce(deps);
    reading = { ...reading, starts: 1, atLeast: true, unreadable: null }; await runRestartRateSweepOnce(deps);
    expect(resolvedKeys).toEqual([]);
    expect(open.size).toBe(1);
    reading = { ...reading, atLeast: false }; await runRestartRateSweepOnce(deps);
    expect(open.size).toBe(0);
    expect(openedKeys[0]).toContain(':fixture.service');
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'sync-read-budget-original-blind-breach-and-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/harness/routines/sync-read-budget-watchdog.ts|<module>|1'],
  run: async () => {
    const { syncReadBudgetSweep } = await import('../harness/routines/sync-read-budget-watchdog');
    const org = await import('@papercusp/db-org');
    const legacy = await import('../pot/watchdog');
    const { expect, vi } = await import('vitest');
    const now = Date.parse('2026-10-12T00:00:00.000Z');
    let mode: 'blind' | 'breach' | 'pending' | 'read-error' | 'producer-error' | 'healthy' = 'blind';
    const sql = async (parts: TemplateStringsArray) => {
      if (mode === 'read-error') throw new Error('snapshot unavailable');
      if (parts.join('').includes('harness_shared.routines')) {
        return mode === 'pending' ? [{ next_fire_at: new Date(now + 60_000), last_fired_at: null }] : [];
      }
      if (mode === 'blind' || mode === 'pending') return [];
      return [{ computed_at: now, error: mode === 'producer-error' ? 'audit refresh failed' : null,
        payload: { violations: mode === 'breach' ? [{ name: 'fixture.read', bytes: 200,
          byteCeil: 100, overBytes: true, allowlisted: false }] : [], ratchetRegressions: [] } }];
    };
    const spies = [vi.spyOn(org, 'getOrgPg').mockReturnValue({ sql } as never),
      vi.spyOn(legacy, 'claimWatchdogFire').mockResolvedValue(false)];
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const alarm = {
      broadcast: async (event: { conditionKey?: string }) => {
        open.add(event.conditionKey!); openedKeys.push(event.conditionKey!); return true;
      },
      resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false;
        resolvedKeys.push(event.conditionKey); return true;
      },
    };
    const opts = { workspaceId: 'fixture-ws', installSlug: 'fixture-pot', now };
    try {
      expect(await syncReadBudgetSweep(opts, alarm)).toMatchObject({ outcome: 'alerted', paged: false });
      for (const unknown of ['read-error', 'pending', 'producer-error'] as const) {
        mode = unknown; await syncReadBudgetSweep(opts, alarm);
        expect(resolvedKeys).toEqual([]);
      }
      mode = 'breach'; spies[1].mockRejectedValue(new Error('legacy ledger unavailable'));
      expect(await syncReadBudgetSweep(opts, alarm)).toMatchObject({ outcome: 'error' });
      expect(openedKeys).toEqual(['alarm:sync-read-budget:fixture-ws:fixture-pot:blind',
        'alarm:sync-read-budget:fixture-ws:fixture-pot:breach']);
      expect([...open]).toEqual(['alarm:sync-read-budget:fixture-ws:fixture-pot:breach']);
      mode = 'healthy';
      expect(await syncReadBudgetSweep(opts, alarm)).toMatchObject({ outcome: 'healthy' });
      expect(open.size).toBe(0);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { spies.forEach((spy) => spy.mockRestore()); }
  },
}, {
  id: 'embed-latency-original-per-caller-breach-and-measured-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/system-health/embed-latency-watchdog.ts|<module>|1'],
  run: async () => {
    const { runEmbedLatencySweepOnce } = await import('../system-health/embed-latency-watchdog');
    const { expect } = await import('vitest');
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const alarm = {
      broadcast: async (event: { conditionKey?: string }) => { open.add(event.conditionKey!); openedKeys.push(event.conditionKey!); return true; },
      resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false;
        resolvedKeys.push(event.conditionKey); return true;
      },
    };
    const caller = { caller: 'fixture:embed', n: 20, ok: 20, timeout: 0, error: 0,
      budgetMs: 1200, p50Ms: 20, p99Ms: 1900, maxMs: 2000 };
    let callers = [caller];
    const deps = { rail: alarm, flagEnabled: async () => true,
      escalate: async () => { throw new Error('legacy failed'); },
      readWindow: () => ({ windowMs: 3_600_000, embeds: callers.reduce((sum, row) => sum + row.n, 0),
        callers, oldestSampleMs: 1, newestSampleMs: 2, truncatedByCapacity: false }) };
    await expect(runEmbedLatencySweepOnce(deps)).rejects.toThrow('legacy failed');
    callers = []; await runEmbedLatencySweepOnce(deps);
    callers = [{ ...caller, n: 1, p99Ms: 200 }]; await runEmbedLatencySweepOnce(deps);
    expect(resolvedKeys).toEqual([]);
    expect(open.size).toBe(1);
    callers = [{ ...caller, p99Ms: 200 }]; await runEmbedLatencySweepOnce(deps);
    expect(open.size).toBe(0);
    expect(openedKeys[0]).toContain(':fixture%3Aembed');
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'rubric-watchdog-original-staleness-and-proposal-dwell-recovery', item: 'P-014', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/rubric-staleness-watchdog.ts|<module>|1'],
  run: async () => {
    const { rubricStalenessSweep, rubricProposalDwellSweep } = await import('../rubric-staleness-watchdog');
    const { expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [], open = new Set<string>();
    const alarm = {
      broadcast: async (event: { conditionKey?: string }) => { open.add(event.conditionKey!); openedKeys.push(event.conditionKey!); return true; },
      resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false;
        resolvedKeys.push(event.conditionKey); return true;
      },
    };
    const rubric = { rubricId: 'fixture-rubric', status: 'active', releaseGating: true,
      updatedAt: '2026-07-13T00:00:00.000Z', proposedBy: 'su-proposer' } as unknown as import('../rubrics').Rubric;
    let row = rubric;
    let fresh = false, unavailable = false, unknown = false;
    const deps = { alarm, listRubrics: async () => [row], now: Date.parse('2026-07-15T00:00:00.000Z'),
      recentWatchdogFires: async () => 1,
      checkScorecardFreshness: async () => {
        if (unavailable) throw new Error('freshness unavailable');
        return { status: unknown ? 'unknown-rubric' : fresh ? 'fresh' : 'stale', complete: fresh, count: fresh ? 1 : 0,
          lastCompleteAt: null, lastEmittedAt: null } as import('../scorecard-freshness').ScorecardFreshness;
      },
      recordFire: async () => { throw new Error('legacy debounce failed'); },
      openEscalation: async () => { throw new Error('legacy debounce failed'); },
    };
    const opts = { workspaceId: 'fixture-ws', installSlug: 'fixture-pot' };
    await rubricStalenessSweep(opts, deps);
    unknown = true; await rubricStalenessSweep(opts, deps);
    unknown = false; unavailable = true; await rubricStalenessSweep(opts, deps);
    expect(resolvedKeys).toEqual([]);
    unavailable = false; fresh = true; await rubricStalenessSweep(opts, deps);
    row = { ...rubric, status: 'proposed' }; await rubricProposalDwellSweep(opts, deps);
    row = rubric; await rubricProposalDwellSweep(opts, deps);
    expect(openedKeys).toEqual([
      'alarm:rubric-staleness:fixture-ws:fixture-pot:fixture-rubric',
      'alarm:rubric-proposal-dwell:fixture-ws:fixture-pot:fixture-rubric',
    ]);
    expect(open.size).toBe(0);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'retrieval-authoritative-samples-and-one-shot-sweep',
  item: 'P-005',
  route: 'condition',
  rowIds: [
    'bespoke-watchdog|packages/operator-core/lib/system-health/retrieval-degradation-watchdog.ts|<module>|1',
    'health-flag-no-condition|packages/operator-core/lib/system-health/retrieval-degradation-watchdog.ts|defaultEscalate|1',
  ],
  run: async () => {
    const search = await import('@papercusp/search');
    const producer = await import('../system-health/retrieval-degradation-watchdog');
    const watchdog = await import('../system-health/degradation-watchdog');
    const { summarizeFallbackWindow } = await import('./fallback-observations');
    const { expect } = await import('vitest');
    const observations: Array<{ reason: string; samples: number; eligible: number; applied: number }> = [];
    const open = new Set<string>();
    const openedKeys: string[] = [];
    const resolvedKeys: string[] = [];
    const observe = (_mechanism: string, row: { reason: string; eligible: number; applied: number }) => {
      observations.push({ ...row, samples: 1 });
      return true;
    };
    const sweep = () => watchdog.runDegradationSweepOnce({
      mechanisms: () => [watchdog.getDegradationMechanism('retrieval')!],
      readWindows: async () => [{ scope: null, window: summarizeFallbackWindow('retrieval', 60_000, observations) }],
      readOpenConditionKeys: async () => [...open],
      broadcast: async ({ conditionKey }) => { open.add(conditionKey!); openedKeys.push(conditionKey!); return true; },
      resolve: async ({ conditionKey }) => { open.delete(conditionKey); resolvedKeys.push(conditionKey); return true; },
      prune: async () => 0,
    });
    const leg = {
      status: 'ran', candidates: 5, floored: 0, stage2Added: 0, callsRun: 0, callsFailed: 0,
      blocked: null, failures: [],
    };
    const legs = {
      lexical: leg, semantic: { ...leg, status: 'errored', candidates: 0, blocked: 'timeout' },
      degraded: true, warning: 'semantic leg blocked',
    } as import('@papercusp/search').SearchLegs;
    const partialSourceFailureLegs = {
      lexical: leg,
      semantic: { ...leg, failures: [{ source: 'semantic-source', ranker: 'semantic', error: 'vector query timed out' }], callsFailed: 1 },
      degraded: true,
      warning: '1 semantic source call(s) failed',
    } as import('@papercusp/search').SearchLegs;
    try {
      // Executes the actual startup wiring and existing search recorder, not source assertions.
      producer.startRetrievalDegradationWatchdog({ observe });
      search.observeLegs(partialSourceFailureLegs);
      expect(observations).toContainEqual({ reason: 'semantic-source-failed', samples: 1, eligible: 1, applied: 0 });
      for (let i = 0; i < 20; i++) search.observeLegs(legs);
      await sweep();
      // Executes the seed's old owner-only escalation site through its actual sweep.
      await producer.runRetrievalDegradationSweepOnce({ flagEnabled: async () => true, observe,
        readHealth: () => ({ windowMs: 60_000, searches: 100, degraded: 90, degradedRate: 0.9,
          semanticBlocked: 90, lexicalBlocked: 0, semanticSourceFailed: 0, lexicalSourceFailed: 0,
          semanticEmpty: 0, lexicalEmpty: 0,
          oldestSampleMs: 1, newestSampleMs: 2, truncatedByCapacity: false }) });
      await sweep();
      for (let i = 0; i < 400; i++) search.observeLegs({ ...legs, semantic: leg, degraded: false } as import('@papercusp/search').SearchLegs);
      await sweep();
      return { route: 'condition' as const, openedKeys, resolvedKeys };
    } finally {
      search.setLegHealthObserver(null);
    }
  },
}];

for (const kind of ['plan-item-claim', 'work-item-claim', 'work-item-replica'] as const) {
  const path = kind === 'plan-item-claim' ? 'plan-items/claim-authority-swarm.ts'
    : kind === 'work-item-claim' ? 'work-item-claim-authority-swarm.ts' : 'work-item-replica-authority-swarm.ts';
  RAIL_MIGRATION_CASES.push({
    id: `${kind}-real-authority-routing-fallback-and-recovery`, item: 'P-011', route: 'observation',
    mechanism: 'swarm-authority-route',
    rowIds: [`log-only-fallback|packages/operator-core/lib/${path}|route|1`],
    run: async () => {
      const { expect, vi } = await import('vitest');
      const recorder = await import('./fallback-observations');
      const rpc = await import('../authority/peer-rpc-transport');
      const watchdog = await import('../system-health/degradation-watchdog');
      const observations: Array<{ eligible: number; applied: number; reason: string; scope?: string | null }> = [];
      const scope = `${kind}:rail-fixture`;
      const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
        if (mechanism === 'swarm-authority-route' && row.scope === scope) observations.push(row);
        return true;
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const previousTransport = rpc.getPeerRpcTransport();
      let remote = true;
      const presence = async () => remote ? [{ device_pubkey: 'aaa-authority', github_user_id: 1,
        machine_label: 'remote', last_seen_ms: 1_000 }] : [];
      const deps = { fetchPresenceRows: presence, fetchHivePresenceRows: presence,
        resolveSelf: async () => ({ devicePubkey: 'zzz-self', githubUserId: 2 }),
        now: () => 1_000, useHrwRendezvous: false, evictionMonitor: null };
      try {
        const producer = kind === 'plan-item-claim'
          ? new (await import('../plan-items/claim-authority-swarm')).SwarmClaimAuthority(deps)
          : kind === 'work-item-claim'
            ? new (await import('../work-item-claim-authority-swarm')).SwarmWorkItemClaimAuthority(deps)
            : new (await import('../work-item-replica-authority-swarm')).SwarmWorkItemReplicaAuthority(deps);
        // A no-op identity probe is not an eligible claim/replica decision.
        expect(await producer.isSelf('rail-fixture')).toBe(false);
        expect(observations).toHaveLength(0);
        rpc.setPeerRpcTransport(null);
        const op = { local: async () => 'local-value', remote: { kind: 'rail-case', payload: {}, decode: String } };
        for (let i = 0; i < 20; i++) expect(await producer.route('rail-fixture', op)).toBe('local-value');
        expect(observations).toHaveLength(20);
        expect(observations.every((row) => row.applied === 0 && row.reason === 'authority-unreachable')).toBe(true);
        const verdict = () => watchdog.judgeDegradation(recorder.summarizeFallbackWindow('swarm-authority-route', 60_000,
          observations.map((row) => ({ ...row, samples: 1 }))), { mechanism: 'swarm-authority-route', scope },
          watchdog.getDegradationMechanism('swarm-authority-route')!.thresholds);
        expect(verdict().kind).toBe('collapsed');
        rpc.setPeerRpcTransport({ rpc: async () => 'remote-value' });
        for (let i = 0; i < 25; i++) expect(await producer.route('rail-fixture', op)).toBe('remote-value');
        expect(verdict().kind).toBe('recovered');
        remote = false;
        expect(await producer.route('rail-fixture', op)).toBe('local-value');
        expect(observations.at(-1)).toMatchObject({ eligible: 1, applied: 1, reason: 'applied' });
        expect(warn).toHaveBeenCalledTimes(20);
        return { route: 'observation', mechanism: 'swarm-authority-route', observations };
      } finally { rpc.setPeerRpcTransport(previousTransport); sink.mockRestore(); warn.mockRestore(); }
    },
  });
}

RAIL_MIGRATION_CASES.push(...AGENT_ROUTING_MIGRATION_CASES);
RAIL_MIGRATION_CASES.push({
  id: 'storage-slug-original-resolver-error-and-verified-unpotted-recovery', item: 'P-011', route: 'observation',
  mechanism: 'work-item-storage-resolution',
  rowIds: ['log-only-fallback|packages/operator-core/lib/pot-membership.ts|workItemStorageSlug|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    let result: string | null = null;
    let fail = true;
    const producer = execute(original('packages/operator-core/lib/pot-membership.ts', 'function workItemStorageSlug(', 'function'), {
      resolveWorkItemPot: async () => { if (fail) throw new Error('resolver unavailable'); return result; },
      observeFallback: (mechanism: string, row: typeof observations[number]) => {
        expect(mechanism).toBe('work-item-storage-resolution'); observations.push(row); return true;
      },
    }, 'workItemStorageSlug') as (slug: string, workspace: string) => Promise<string>;
    expect(await producer('member', 'fixture')).toBe('member');
    fail = false;
    expect(await producer('member', 'fixture')).toBe('member'); // verified unpotted tenant
    result = 'pot-home';
    expect(await producer('member', 'fixture')).toBe('pot-home');
    expect(observations.map((row) => [row.applied, row.reason])).toEqual([
      [0, 'pot-resolution-failed'], [1, 'applied'], [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'work-item-storage-resolution', observations };
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'substrate-binding-original-required-hive-failure-and-configured-local-recovery', item: 'P-011', route: 'observation',
  mechanism: 'substrate-binding-resolution',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/boot-all.ts|defaultResolveSwarmBinding|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    let fail = false;
    let hive: object | null = null;
    let home: string | null = 'pot-home';
    let projectDir = '/fixture';
    let config: { topic?: string; github_repository_id: number } | null = { github_repository_id: 1 };
    const producer = execute(original('packages/operator-core/lib/sync/hyperbee/boot-all.ts', 'function defaultResolveSwarmBinding(', 'function'), {
      require: (path: string) => path.endsWith('hive-federation') ? {
        resolveHiveSwarmBinding: async () => { if (fail) throw new Error('identity unavailable'); return hive; },
        potHomeSlugForHarness: async () => home,
      } : { resolveHarnessPaths: async () => ({ projectDir }) },
      loadSharedConfigFromProjectDir: () => config,
      observeFallback: (mechanism: string, row: typeof observations[number]) => {
        expect(mechanism).toBe('substrate-binding-resolution'); observations.push(row); return true;
      },
    }, 'defaultResolveSwarmBinding') as (workspace: string, slug: string) => Promise<unknown>;
    expect(await producer('fixture', 'member')).toBeNull();
    fail = true; expect(await producer('fixture', 'member')).toBeNull();
    fail = false; projectDir = '/tmp/papercusp-unresolved/member';
    expect(await producer('fixture', 'member')).toBeNull();
    projectDir = '/fixture'; config = null;
    expect(await producer('fixture', 'member')).toBeNull(); // verified local-only
    config = { topic: 'a'.repeat(64), github_repository_id: 1 };
    expect(await producer('fixture', 'member')).toEqual({ kind: 'topic', topic_hex: 'a'.repeat(64) });
    config = { github_repository_id: 1 }; home = null;
    expect(await producer('fixture', 'member')).toEqual({ kind: 'gh', github_repository_id: 1 });
    hive = { kind: 'topic', topic_hex: 'b'.repeat(64) };
    expect(await producer('fixture', 'member')).toEqual(hive);
    expect(observations.map((row) => row.reason)).toEqual([
      'hive-binding-unresolved', 'binding-read-failed', 'harness-path-unresolved', 'applied', 'applied', 'applied', 'applied',
    ]);
    return { route: 'observation', mechanism: 'substrate-binding-resolution', observations };
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'substrate-boot-original-latch-timeout-decided-route-and-cached-exclusion', item: 'P-011', route: 'observation',
  mechanism: 'substrate-boot-routing',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/boot-all.ts|bootSingleHarness|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const text = original('packages/operator-core/lib/sync/hyperbee/boot-all.ts', 'function bootSingleHarness(', 'function');
    for (const timedOut of [true, false]) {
      const handles = new Map();
      const inflight = new Map();
      let boots = 0;
      const producer = execute(text, {
        key: (workspace: string, slug: string) => `${workspace}:${slug}`, handles, inflight,
        routingDecisionFailure: null, routingDecisionPending: timedOut ? new Promise(() => {}) : null,
        SUBSTRATE_ROUTING_WAIT_MS: 1, setTimeout: (callback: () => void, ms: number) => { if (ms === 1) callback(); return { unref() {} }; },
        defaultBootHarness: null, defaultInProcessBootAllowed: () => true, defaultSkipSendSideWiring: true,
        bootHarnessSubstrate: async () => { boots++; return {}; }, defaultMergeCursorStoreFactory: null,
        createPgMergeCursorStore: () => ({}), process: { env: {} }, workspaceRootForId: () => '/fixture',
        evictionTrackingEnabled: false, disarmSubstrateWakeKeepalive: async () => {},
        // The fixture hive is never the dogfood hive, so the boot proceeds to the routing latch.
        isDisabledDogfoodHive: async () => false,
        observeFallback: (mechanism: string, row: typeof observations[number]) => {
          expect(mechanism).toBe('substrate-boot-routing'); observations.push(row); return true;
        },
      }, 'bootSingleHarness') as (workspace: string, slug: string, opts: object) => Promise<{ state: string }>;
      const opts = { resolveSwarmBinding: async () => null };
      const first = await producer('fixture', 'member', opts);
      if (timedOut) {
        expect(first.state).toBe('failed');
        expect(boots).toBe(0);
        continue;
      }
      expect(first.state).toBe('booted');
      expect((await producer('fixture', 'member', opts)).state).toBe('already-booted');
      expect(boots).toBe(1);
    }
    expect(observations.map((row) => [row.applied, row.reason])).toEqual([
      [0, 'routing-decision-timeout'],
      [1, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'substrate-boot-routing', observations };
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'substrate-activation-original-failed-plan-partial-registry-and-recovery', item: 'P-011', route: 'observation',
  mechanism: 'substrate-activation-plan',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/boot-all.ts|resolveActivationDeferrals|1'],
  run: async () => {
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    let fail = true;
    let enabled = true;
    let projects = [{ slug: 'one' }, { slug: 'two' }];
    const policy = await import('../sync/hyperbee/substrate-active-set-policy');
    const facts = await import('../sync/hyperbee/substrate-active-set-facts');
    const producer = execute(original('packages/operator-core/lib/sync/hyperbee/boot-all.ts', 'function resolveActivationDeferrals(', 'function'), {
      require: (path: string) => {
        if (path === '@papercusp/flags/server') return { getFlag: async () => enabled };
        if (path === '@papercusp/flags') return { FLAGS: { LAZY_SUBSTRATE_BOOT: 'lazy' } };
        if (path.endsWith('harness-registry')) return { loadHarnessRegistry: async () => { if (fail) throw new Error('registry unavailable'); return { projects }; } };
        if (path.endsWith('substrate-active-set-policy')) return policy;
        if (path.endsWith('substrate-active-set-facts')) return facts;
        throw new Error(`unexpected dependency ${path}`);
      },
      observeFallback: (mechanism: string, row: typeof observations[number]) => {
        expect(mechanism).toBe('substrate-activation-plan'); observations.push(row); return true;
      },
    }, 'resolveActivationDeferrals') as (pairs: object[], opts: object) => Promise<Set<string>>;
    const pairs = [{ wsId: 'fixture', slug: 'one' }, { wsId: 'fixture', slug: 'two' }];
    const opts = { activationFactDeps: { pendingOutboxCounts: async () => new Map(), lastPresenceMs: async () => new Map() } };
    expect((await producer(pairs, opts)).size).toBe(0);
    fail = false; projects = [{ slug: 'one' }];
    expect([...await producer(pairs, opts)]).toEqual(['fixture::one']);
    projects.push({ slug: 'two' });
    expect((await producer(pairs, opts)).size).toBe(2);
    await producer([], opts); enabled = false; await producer(pairs, opts);
    expect(observations.map((row) => [row.eligible, row.applied, row.reason])).toEqual([
      [2, 0, 'activation-plan-failed'], [2, 1, 'registry-entry-missing'], [2, 2, 'applied'],
    ]);
    return { route: 'observation', mechanism: 'substrate-activation-plan', observations };
  },
});

for (const cleanup of [false, true]) {
  const mechanism = cleanup ? 'substrate-sidecar-cleanup' : 'substrate-sidecar-boot';
  RAIL_MIGRATION_CASES.push({
    id: `${mechanism}-original-wrapper-failed-and-primary`, item: 'P-011', route: 'observation', mechanism,
    rowIds: [`log-only-fallback|packages/operator-core/lib/sync/hyperbee/substrate-boot-wrapper.ts|bootSubstrateWithFallback|${cleanup ? 2 : 1}`],
    run: async () => {
      const { expect } = await import('vitest');
      const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
      let enabled = true;
      let failBoot = true;
      let failStop = true;
      let stops = 0;
      const producer = execute(original('packages/operator-core/lib/sync/hyperbee/substrate-boot-wrapper.ts', 'function bootSubstrateWithFallback(', 'function'), {
        getFlag: async (flag: string) => flag === 'sidecar' ? enabled : false,
        FLAGS: { SUBSTRATE_SIDECAR: 'sidecar', SUBSTRATE_MERGE_CURSOR_PG: 'cursor' },
        createPgMergeCursorStore: () => ({}), maybeStartSubstrateEvictionReaper: async () => false, keepalive: null,
        setSubstrateBootDefaults() {}, bootAllHarnessesForActiveWorkspace: async () => ({ booted: 1 }),
        spawnSubstrateSidecar: async () => { if (failBoot) throw new Error('spawn failed'); },
        stopSubstrateSidecar: async () => { stops++; if (failStop) throw new Error('stop failed'); },
        registerSidecarShutdownHooks() {}, ensureSidecarRespawnReconcileRegistered() {},
        getSubstrateIpcClient: () => ({ call: async () => ({}) }), closeInProcessBootedHarnesses: async () => [],
        // Model a Node host: the producer reads process.versions.bun to decide whether a Bun
        // operator must route every boot through the Node sidecar.
        process: { versions: {} },
        observeFallback: (name: string, row: typeof observations[number]) => {
          if (name === mechanism) observations.push(row); return true;
        },
      }, 'bootSubstrateWithFallback') as () => Promise<{ usedSidecar: boolean }>;
      expect((await producer()).usedSidecar).toBe(false);
      failStop = false; expect((await producer()).usedSidecar).toBe(false);
      failBoot = false; expect((await producer()).usedSidecar).toBe(true);
      const before = observations.length;
      enabled = false; expect((await producer()).usedSidecar).toBe(false);
      expect(observations).toHaveLength(before); expect(stops).toBe(2);
      expect(observations.map((row) => row.applied)).toEqual(cleanup ? [0, 1] : [0, 0, 1]);
      return { route: 'observation', mechanism, observations };
    },
  });
}

RAIL_MIGRATION_CASES.push({
  id: 'substrate-activation-facts-real-probe-failure-empty-and-recovery', item: 'P-011', route: 'observation',
  mechanism: 'substrate-activation-probe',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/substrate-active-set-facts.ts|gatherActivationFacts|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../sync/hyperbee/substrate-active-set-facts');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'substrate-activation-probe') observations.push(row);
      return true;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entries = [{ workspaceId: 'rail-workspace', harnessSlug: 'one' }, { workspaceId: 'rail-workspace', harnessSlug: 'two' }];
    const good = { pendingOutboxCounts: async () => new Map([['rail-workspace::one', 3]]),
      lastPresenceMs: async () => new Map([['rail-workspace::two', 1000]]) };
    try {
      for (const failedDependency of ['pendingOutboxCounts', 'lastPresenceMs'] as const) {
        const result = await producer.gatherActivationFacts(entries,
          { ...good, [failedDependency]: async () => { throw new Error('probe unavailable'); } });
        expect(result.every((row) => row.pinned && row.pendingOutboxRows === 1)).toBe(true);
      }
      expect(await producer.gatherActivationFacts([], good)).toEqual([]);
      expect(observations).toHaveLength(2);
      const recovered = await producer.gatherActivationFacts(entries, good);
      expect(recovered[0]).toMatchObject({ pendingOutboxRows: 3, pinned: false });
      expect(recovered[1]).toMatchObject({ lastPresenceMs: 1000, pendingOutboxRows: 0 });
      expect(observations).toEqual([
        { eligible: 2, applied: 0, reason: 'activation-probe-failed' },
        { eligible: 2, applied: 0, reason: 'activation-probe-failed' },
        { eligible: 2, applied: 2, reason: 'applied' },
      ]);
      return { route: 'observation', mechanism: 'substrate-activation-probe', observations };
    } finally { sink.mockRestore(); warn.mockRestore(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'sync-relay-real-reader-failure-empty-config-and-primary', item: 'P-011', route: 'observation',
  mechanism: 'sync-relay-config',
  rowIds: ['log-only-fallback|packages/operator-core/lib/sync/hyperbee/sync-relay.ts|resolveSyncRelayKeys|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../sync/hyperbee/sync-relay');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'sync-relay-config') observations.push(row);
      return true;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await producer.resolveSyncRelayKeys(async () => { throw new Error('relay store unavailable'); })).toEqual([]);
      expect(await producer.resolveSyncRelayKeys(async () => [])).toEqual([]);
      const keys = [Buffer.alloc(32, 1)];
      expect(await producer.resolveSyncRelayKeys(async () => keys)).toEqual(keys);
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
        [0, 'relay-key-read-failed'], [1, 'applied'], [1, 'applied'],
      ]);
      return { route: 'observation', mechanism: 'sync-relay-config', observations };
    } finally { sink.mockRestore(); warn.mockRestore(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'authority-env-real-parser-invalid-cache-and-verified-config', item: 'P-011', route: 'observation',
  mechanism: 'authority-peer-addresses',
  rowIds: ['log-only-fallback|packages/operator-core/lib/authority/transport-wiring.ts|envAddressMap|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../authority/transport-wiring');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'authority-peer-addresses') observations.push(row);
      return true;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = process.env[producer.PEER_ADDRESSES_ENV];
    const peer = { devicePubkey: 'fixture-key', githubUserId: 1, machineLabel: 'fixture-peer' };
    try {
      producer._testing.reset(); delete process.env[producer.PEER_ADDRESSES_ENV];
      expect(await producer.resolvePeerAddress(peer)).toBeNull();
      expect(observations).toHaveLength(0); // no configuration was requested
      producer._testing.reset(); process.env[producer.PEER_ADDRESSES_ENV] = '{invalid';
      expect(await producer.resolvePeerAddress(peer)).toBeNull();
      expect(await producer.resolvePeerAddress(peer)).toBeNull();
      expect(observations).toEqual([{ eligible: 1, applied: 0, reason: 'invalid-json' }]);
      expect(warn).toHaveBeenCalledTimes(1);
      producer._testing.reset(); process.env[producer.PEER_ADDRESSES_ENV] = JSON.stringify({ 'fixture-key': 'http://fixture-peer' });
      expect(await producer.resolvePeerAddress(peer)).toBe('http://fixture-peer');
      expect(await producer.resolvePeerAddress(peer)).toBe('http://fixture-peer');
      expect(observations.at(-1)).toEqual({ eligible: 1, applied: 1, reason: 'applied' });
      expect(observations).toHaveLength(2); // memoization cannot invent healthy samples
      producer._testing.reset(); producer.configurePeerAddressResolver(async () => 'http://configured-peer');
      expect(await producer.resolvePeerAddress(peer)).toBe('http://configured-peer');
      expect(observations).toHaveLength(2); // env path was bypassed
      return { route: 'observation', mechanism: 'authority-peer-addresses', observations };
    } finally {
      producer._testing.reset();
      if (saved === undefined) delete process.env[producer.PEER_ADDRESSES_ENV]; else process.env[producer.PEER_ADDRESSES_ENV] = saved;
      sink.mockRestore(); warn.mockRestore();
    }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'spawner-sidecar-fallback-primary-denominator-and-recovery', item: 'P-012', route: 'observation',
  mechanism: 'spawner-sidecar-exec',
  rowIds: ['log-only-fallback|packages/operator-core/lib/fleet/git-via-sidecar.ts|recordSidecarFallback|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../fleet/git-via-sidecar');
    const spawner = await import('../fleet/spawner-sidecar-spawn');
    const ipc = await import('../fleet/spawner-ipc-client');
    const watchdog = await import('../system-health/degradation-watchdog');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const mocks = [
      vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
        if (mechanism === 'spawner-sidecar-exec') observations.push(row);
        return true;
      }),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(spawner, 'spawnSpawnerSidecar').mockResolvedValue(undefined),
      vi.spyOn(ipc, 'getSpawnerIpcClient').mockReturnValue({
        call: async () => ({ code: 3, stdout: 'child ran', stderr: 'child exit' }),
      } as unknown as ReturnType<typeof ipc.getSpawnerIpcClient>),
    ];
    const verdict = () => watchdog.judgeDegradation(recorder.summarizeFallbackWindow('spawner-sidecar-exec', 60_000,
      observations.map((row) => ({ ...row, samples: 1 }))),
      { mechanism: 'spawner-sidecar-exec' }, watchdog.getDegradationMechanism('spawner-sidecar-exec')!.thresholds);
    producer.resetSidecarFallbackStatsForTest();
    try {
      // Original producer, including warnings suppressed by the per-subsystem throttle.
      const failedAt = Date.now() - producer.SIDECAR_BREAKER_COOLDOWN_MS - 1;
      for (let i = 0; i < 20; i++) producer.noteSidecarFallback('coverage', new Error(`failure ${i}`), failedAt);
      expect(observations).toHaveLength(20);
      expect(verdict().kind).toBe('collapsed');
      // Disabled routing makes no sidecar decision and cannot manufacture recovery.
      await producer.execFileViaSidecar('git', ['status'], { timeoutMs: 1000, subsystem: 'coverage' }, {
        sidecarEnabled: () => false, local: async () => ({ stdout: '' }),
      });
      expect(observations).toHaveLength(20);
      // Execute the actual primary RPC path. Child exit status is not transport health.
      for (let i = 0; i < 25; i++) await producer.runCommandViaSpawnerSidecar('git', ['status'], { timeoutMs: 1000 });
      expect(observations.filter((row) => row.applied === 1)).toHaveLength(25);
      expect(verdict().kind).toBe('recovered');
      return { route: 'observation', mechanism: 'spawner-sidecar-exec', observations };
    } finally {
      producer.resetSidecarFallbackStatsForTest();
      for (const mock of mocks) mock.mockRestore();
    }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'bounded-operation-deadline-error-primary-and-cancellation-exclusion', item: 'P-012', route: 'observation',
  mechanism: 'bounded-operation',
  rowIds: [
    'log-only-fallback|packages/operator-core/lib/bounded-timeout.ts|withBoundedTimeout|1',
    'log-only-fallback|packages/operator-core/lib/bounded-timeout.ts|withBoundedTimeout|2',
  ],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../bounded-timeout');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'bounded-operation') observations.push(row);
      return true;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deadline = producer.withBoundedTimeout(new Promise<string>(() => {}), { fallback: 'fallback', timeoutMs: 1, label: 'coverage' });
      expect((await deadline).reason).toBe('timeout');
      expect((await producer.withBoundedTimeout(Promise.reject(new Error('query error')), {
        fallback: 'fallback', timeoutMs: 1000, label: 'coverage',
      })).reason).toBe('error');
      expect((await producer.withBoundedTimeout(Promise.resolve('primary'), {
        fallback: 'fallback', timeoutMs: 1000, label: 'coverage',
      })).degraded).toBe(false);
      const controller = new AbortController();
      controller.abort();
      await producer.withBoundedTimeout(async () => { throw new Error('must not run'); }, {
        fallback: 'fallback', timeoutMs: 1000, signal: controller.signal,
      });
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
        [0, 'timeout'], [0, 'error'], [1, 'applied'],
      ]);
      return { route: 'observation', mechanism: 'bounded-operation', observations };
    } finally { sink.mockRestore(); warn.mockRestore(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'primary-count-missing-capability-before-log-throttle-and-verified-recovery', item: 'P-012', route: 'observation',
  mechanism: 'primary-count-capability',
  rowIds: ['log-only-fallback|packages/operator-core/lib/system-health/single-primary-check.ts|countBackgroundPrimaries|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../system-health/single-primary-check');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'primary-count-capability') observations.push(row);
      return true;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let answer: Array<{ n: number; can_read_all_stats?: boolean }> = [{ n: 0 }];
    const sql = (async () => answer) as unknown as Parameters<typeof producer.countBackgroundPrimaries>[0];
    try {
      expect(await producer.countBackgroundPrimaries(sql)).toBe(0);
      expect(await producer.countBackgroundPrimaries(sql)).toBe(0);
      answer = [{ n: 0, can_read_all_stats: false }];
      expect(await producer.countBackgroundPrimaries(sql)).toBeNull();
      answer = [{ n: 1, can_read_all_stats: true }];
      expect(await producer.countBackgroundPrimaries(sql)).toBe(1);
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
        [0, 'probe-column-absent'], [0, 'probe-column-absent'], [0, 'stats-permission-denied'], [1, 'applied'],
      ]);
      return { route: 'observation', mechanism: 'primary-count-capability', observations };
    } finally { sink.mockRestore(); warn.mockRestore(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'cache-l2-backend-failures-before-throttle-healthy-miss-and-disabled-exclusion', item: 'P-012', route: 'observation',
  mechanism: 'cache-l2-operation',
  rowIds: ['log-only-fallback|packages/operator-core/lib/cache/l2-tier.ts|noteL2Error|1'],
  run: async () => {
    const { expect, vi } = await import('vitest');
    const recorder = await import('./fallback-observations');
    const producer = await import('../cache/l2-tier');
    const instance = await import('../cache/instance');
    const flags = await import('@papercusp/flags');
    const flagTest = await import('@papercusp/flags/test');
    const observations: Array<{ eligible: number; applied: number; reason: string; scope?: string | null }> = [];
    const sink = vi.spyOn(recorder, 'observeFallback').mockImplementation((mechanism, row) => {
      if (mechanism === 'cache-l2-operation') observations.push(row);
      return true;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fails = true;
    const store = {
      get: async () => { if (fails) throw new Error('get unavailable'); return undefined; },
      set: async () => { if (fails) throw new Error('set unavailable'); },
      invalidateByTags: async () => { if (fails) throw new Error('invalidation unavailable'); return 1; },
    } as unknown as Parameters<typeof producer.installL2StoreForTests>[0];
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      flagTest.setFlagOverridesForTest({ [flags.FLAGS.CACHE_LAYER]: true, [flags.FLAGS.CACHE_L2]: true });
      await instance._refreshCacheLayerForTests();
      producer.setL2EnabledForTests(true);
      producer.installL2StoreForTests(store);
      producer.resetL2ErrorLogForTests();
      const read = producer.withL2('coverage', 'key', async () => 'fresh build', { tags: [], softTtlMs: 1000 });
      for (let i = 0; i < 20; i++) { expect(await read()).toBe('fresh build'); await settle(); }
      expect(observations.filter((row) => row.scope === 'get' && row.applied === 0)).toHaveLength(20);
      expect(observations.filter((row) => row.scope === 'set' && row.applied === 0)).toHaveLength(20);
      expect(log).toHaveBeenCalledTimes(2);
      producer.invalidateL2ByTags('coverage', ['tag']);
      await settle();
      expect(observations).toContainEqual({ eligible: 1, applied: 0, reason: 'backend-error', scope: 'invalidateByTags' });
      fails = false;
      expect(await read()).toBe('fresh build'); // A successful backend MISS is a healthy consultation.
      await settle();
      await producer.invalidateL2ByTagsWithRetry('coverage', ['tag']);
      for (const scope of ['get', 'set', 'invalidateByTags']) {
        expect(observations).toContainEqual({ eligible: 1, applied: 1, reason: 'applied', scope });
      }
      const measured = observations.length;
      producer.setL2EnabledForTests(false);
      await producer.withL2('coverage', 'off', async () => 'local', { tags: [], softTtlMs: 1000 })();
      expect(observations).toHaveLength(measured);
      return { route: 'observation', mechanism: 'cache-l2-operation', observations };
    } finally {
      producer.installL2StoreForTests(null);
      producer.setL2EnabledForTests(true);
      flagTest.setFlagOverridesForTest({});
      await instance._refreshCacheLayerForTests();
      sink.mockRestore(); log.mockRestore();
    }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'gate-stall-fixer-succession-and-readable-end', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/harness/routines/release-actions.ts|trackGateStall|1'],
  run: async () => {
    const { vi, expect } = await import('vitest');
    const producer = await import('../harness/routines/release-actions');
    const org = await import('@papercusp/db-org');
    const attention = await import('../attention-notify');
    const now = Date.now();
    let queue: unknown = { schemaVersion: 3, phase: 'awaiting-fixer', candidate: 'a'.repeat(40),
      base: 'b'.repeat(40), repairHead: 'c'.repeat(40), worktreePath: '/coverage',
      qualificationAttemptId: null, affectedTestProofGroup: null, attempts: 0,
      openedAtMs: now - producer.FIXER_SUCCESSION_STALL_MS * 2,
      updatedAtMs: now - producer.FIXER_SUCCESSION_STALL_MS - 1000,
      fixerSpawnId: null, failingTests: ['coverage.test.ts'] };
    const gh = { lastGreenAt: now, consecutiveReds: 1 };
    const openedKeys: string[] = [], resolvedKeys: string[] = [], open = new Set<string>();
    const sql = Object.assign(async () => [], { unsafe: async (query: string) =>
      query.includes('SELECT') && query.includes("metadata->'gate_health'")
        ? [{ gh, lf: null, rq: queue }] : Object.assign([], { count: 1 }) });
    const notify = vi.spyOn(attention, 'notifyAttentionOnce').mockResolvedValue({ recordId: 1, deduped: false } as never);
    const db = vi.spyOn(org, 'getOrgPg').mockReturnValue({ sql } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const opts = { alarm: {
        broadcast: async ({ conditionKey }: { conditionKey?: string }) => {
          open.add(conditionKey!); openedKeys.push(conditionKey!); return true;
        },
        resolve: async ({ conditionKey }: { conditionKey: string }) => {
          if (!open.delete(conditionKey)) return false;
          resolvedKeys.push(conditionKey); return true;
        },
      } };
      const ctx = { installSlug: 'coverage', workspaceId: 'coverage' };
      await producer.trackGateStall(ctx, 'repair-in-progress', undefined, undefined, undefined, undefined, undefined, undefined, opts);
      expect(notify).toHaveBeenCalledOnce();
      expect(openedKeys).toEqual(['alarm:release-fixer-succession:coverage']);
      queue = { schemaVersion: 3, phase: 'awaiting-fixer' };
      await producer.trackGateStall(ctx, 'repair-in-progress', undefined, undefined, undefined, undefined, undefined, undefined, opts);
      expect(resolvedKeys).toEqual([]);
      queue = null;
      await producer.trackGateStall(ctx, 'repair-in-progress', undefined, undefined, undefined, undefined, undefined, undefined, opts);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { log.mockRestore(); db.mockRestore(); notify.mockRestore(); }
  },
}, {
  id: 'gate-stall-main-ladder-and-green-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/harness/routines/release-actions.ts|trackGateStall|2'],
  run: async () => {
    const { vi, expect } = await import('vitest');
    const producer = await import('../harness/routines/release-actions');
    const org = await import('@papercusp/db-org');
    const attention = await import('../attention-notify');
    const severe = await import('../severe-event-broadcast');
    const { releaseCheckpointConfig } = await import('../release-checkpoint-config');
    let gh: Record<string, unknown> = { consecutiveReds: releaseCheckpointConfig().stallReds - 1,
      stallAlerted: false, lastGreenAt: Date.now() };
    const openedKeys: string[] = [], resolvedKeys: string[] = [], open = new Set<string>();
    const sql = Object.assign(async () => [], { unsafe: async (query: string, params: unknown[] = []) => {
      if (query.includes('SELECT') && query.includes('AS gh')) return [{ gh, lf: null, rq: null }];
      if (query.includes('AS headline_health')) return [{ headline_health: gh }];
      if (query.includes('UPDATE harness_shared.routines') && typeof params[1] === 'string') {
        const body = JSON.parse(params[1]) as { gate_health?: Record<string, unknown> };
        if (body.gate_health) gh = body.gate_health;
      }
      return Object.assign([], { count: 1 });
    } });
    const mocks = [
      vi.spyOn(org, 'getOrgPg').mockReturnValue({ sql } as never),
      vi.spyOn(attention, 'notifyAttentionOnce').mockResolvedValue({ recordId: 1, deduped: false } as never),
      vi.spyOn(severe, 'broadcastSevereEvent').mockImplementation(async ({ conditionKey }) => {
        open.add(conditionKey!); openedKeys.push(conditionKey!); return true;
      }),
      vi.spyOn(severe, 'broadcastSevereEventResolved').mockImplementation(async ({ conditionKey }) => {
        if (!open.delete(conditionKey)) return false;
        resolvedKeys.push(conditionKey); return true;
      }),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ];
    try {
      const opts = { alarm: { resolve: async () => false } };
      const ctx = { installSlug: 'coverage', workspaceId: 'coverage' };
      await producer.trackGateStall(ctx, 'not-green', undefined, ['coverage.test.ts'], undefined, undefined, undefined, undefined, opts);
      expect(attention.notifyAttentionOnce).toHaveBeenCalledOnce();
      expect(openedKeys).toEqual(['gate-red-streak:coverage']);
      expect(gh.stallAlerted).toBe(true);
      await producer.trackGateStall(ctx, 'advanced', undefined, [], undefined, undefined, undefined, undefined, opts);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { mocks.reverse().forEach((mock) => mock.mockRestore()); }
  },
}, {
  id: 'green-stall-verdict-rate-owner-and-measured-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/release/green-stall-watchdog.ts|checkGreenStall|1'],
  run: async () => {
    const { vi, expect } = await import('vitest');
    const producer = await import('../release/green-stall-watchdog');
    const org = await import('@papercusp/db-org');
    const attention = await import('../attention-notify');
    const severe = await import('../severe-event-broadcast');
    const routing = await import('../harness/routines/hive-release-env');
    const launch = await import('../release-checkpoint-launch');
    const engine = await import('../release/routine-engine-liveness');
    const now = Date.now();
    const row = { install_slug: 'coverage', workspace_id: 'coverage', last_fired_ms: now,
      last_verdict_ms: now - 60_000, gh: { lastGreenAt: now, watchdogAlerted: false,
        consecutiveReds: 1, verdictRateAlarmed: false } };
    let verdictWindow: Array<{ fires: number; verdicts: number; last_verdict_ms: number }> =
      [{ fires: 6, verdicts: 1, last_verdict_ms: now }];
    const openedKeys: string[] = [], resolvedKeys: string[] = [], open = new Set<string>();
    const query = async (text: string) => {
      if (text.includes('SELECT r.install_slug')) return [row];
      if (text.includes('AS fires')) return verdictWindow;
      if (text.includes('UPDATE harness_shared.routines') && text.includes('"verdictRateAlarmed":true')) row.gh.verdictRateAlarmed = true;
      if (text.includes('UPDATE harness_shared.routines') && text.includes('"verdictRateAlarmed":false')) row.gh.verdictRateAlarmed = false;
      if (text.includes('UPDATE harness_shared.routines') && text.includes('"watchdogAlerted":true')) row.gh.watchdogAlerted = true;
      if (text.includes('UPDATE harness_shared.routines') && text.includes('"watchdogAlerted":false')) row.gh.watchdogAlerted = false;
      return Object.assign([], { count: text.includes('UPDATE harness_shared.routines') ||
        (text.includes('UPDATE harness_shared.harness_escalations') && open.has('green-stall:coverage')) ? 1 : 0 });
    };
    const sql = Object.assign((strings: TemplateStringsArray) => query(strings.join('?')), { unsafe: query });
    const mocks = [
      vi.spyOn(org, 'getOrgPg').mockReturnValue({ sql } as never),
      vi.spyOn(attention, 'notifyAttentionOnce').mockResolvedValue({ recordId: 1, deduped: false } as never),
      vi.spyOn(routing, 'resolveCheckpointRouting').mockResolvedValue({ root: '/coverage', extraEnv: {}, clearEnv: [] } as never),
      vi.spyOn(launch, 'isCheckpointRunLockHeldCheap').mockReturnValue({ held: false } as never),
      vi.spyOn(launch, 'readCheckpointRunPhaseCheap').mockReturnValue(null),
      vi.spyOn(engine, 'readRoutineEngineLiveness').mockResolvedValue({ stale: false } as never),
      vi.spyOn(severe, 'broadcastSevereEvent').mockImplementation(async ({ conditionKey }) => {
        open.add(conditionKey!); openedKeys.push(conditionKey!); return true;
      }),
      vi.spyOn(severe, 'broadcastSevereEventResolved').mockImplementation(async ({ conditionKey }) => {
        if (!open.delete(conditionKey)) return false;
        resolvedKeys.push(conditionKey); return true;
      }),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
    ];
    try {
      expect((await producer.checkGreenStall(sql as never)).alarmed).toEqual(['coverage']);
      expect(attention.notifyAttentionOnce).toHaveBeenCalledOnce();
      expect(openedKeys).toEqual(['alarm:release-verdict-rate:coverage']);
      verdictWindow = [];
      await producer.checkGreenStall(sql as never);
      expect(row.gh.verdictRateAlarmed).toBe(true);
      expect(resolvedKeys).toEqual([]);
      verdictWindow = [{ fires: 6, verdicts: 6, last_verdict_ms: now }];
      expect((await producer.checkGreenStall(sql as never)).recovered).toEqual(['coverage']);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { mocks.reverse().forEach((mock) => mock.mockRestore()); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'release-fixer-dispatch-promoted-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/harness/routines/release-actions.ts|dispatchReleaseFixer|1'],
  run: async () => {
    const { vi, expect } = await import('vitest');
    const producer = await import('../harness/routines/release-actions');
    const org = await import('@papercusp/db-org');
    const scope = await import('../work-scope-policy');
    const blueprint = await import('../blueprint/launch-blueprint');
    const dev = await import('../dev-data');
    const { buildCandidateSnapshot } = await import('../release/candidate-snapshot');
    const candidate = 'a'.repeat(40), failures = ['coverage::red.test.ts'];
    const snapshot = buildCandidateSnapshot({ candidate, failingTests: failures }, Date.now());
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const alarm = {
      broadcast: async (e: { conditionKey?: string }) => { open.add(e.conditionKey!); openedKeys.push(e.conditionKey!); return true; },
      resolve: async (e: { conditionKey: string }) => { if (!open.delete(e.conditionKey)) return false; resolvedKeys.push(e.conditionKey); return true; },
      notify: async () => {},
    };
    const sql = Object.assign(async () => Object.assign([], { count: 1 }), { unsafe: async (text: string) =>
      text.includes('SELECT') ? [{ lf: null, ftm: 'true', cs: snapshot }]
        : Object.assign([{ written: true }], { count: 1 }) });
    // The stale-candidate check (the only path that RESOLVES this alarm) runs only with a
    // resolved fixer root. Pin a fixture root and routing so the case does not depend on
    // which tree runs it: the gate's checkpoint checkout makes integrationRoot() refuse, and
    // the real routing reads live install config.
    const routing = await import('../harness/routines/hive-release-env');
    const priorRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/coverage';
    const mocks = [
      vi.spyOn(routing, 'resolveCheckpointRouting').mockResolvedValue({ skip: false, extraEnv: {}, clearEnv: [] } as never),
      vi.spyOn(org, 'getOrgPg').mockReturnValue({ sql } as never),
      vi.spyOn(scope, 'gateWorkScope').mockResolvedValue({ allowed: true } as never),
      vi.spyOn(blueprint, 'fireLaunchBlueprintForEvent').mockResolvedValue({
        spawn: { spawnId: 'fixture-fixer', runId: 'fixture-run' },
      } as never),
      vi.spyOn(dev, 'testFlakeRollup').mockResolvedValue({ entries: [] } as never),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
    ];
    try {
      const ctx = { installSlug: 'coverage', workspaceId: 'coverage' };
      await producer.dispatchReleaseFixer(ctx, candidate, failures, undefined, undefined,
        { alarm, checkCandidate: async () => ({ candidateExists: true, candidatePromoted: false }) });
      expect(openedKeys).toEqual(['alarm:release-fixer-dispatch:coverage']);
      await producer.dispatchReleaseFixer(ctx, candidate, failures, undefined, undefined,
        { alarm, checkCandidate: async () => ({ candidateExists: false, candidatePromoted: false }) });
      expect(resolvedKeys).toEqual([]);
      await producer.dispatchReleaseFixer(ctx, candidate, failures, undefined, undefined,
        { alarm, checkCandidate: async () => ({ candidateExists: true, candidatePromoted: true }) });
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally {
      mocks.reverse().forEach((mock) => mock.mockRestore());
      if (priorRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = priorRoot;
    }
  },
}, {
  id: 'idle-repair-owner-escalation-readable-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/release/idle-repair-queue-actuator.ts|escalateOwner|1'],
  run: async () => {
    const { vi, expect } = await import('vitest');
    const producer = await import('../release/idle-repair-queue-actuator');
    const actions = await import('../harness/routines/release-actions');
    const ownership = await import('../coord/gate-ownership');
    const checkpoint = await import('../release-checkpoint-launch');
    const deploy = await import('../release-deploy-launch');
    const queue = { schemaVersion: 1, phase: 'awaiting-fixer', candidate: 'a'.repeat(40),
      base: 'b'.repeat(40), repairHead: 'c'.repeat(40), affectedTestProofGroup: 'coverage', attempts: 0,
      openedAtMs: 1, updatedAtMs: 1, fixerSpawnId: null, failingTests: ['red.test.ts'], signature: [] } as const;
    let episode: import('../release/idle-repair-queue-actuator').IdleQueueEpisode | null = null;
    const open = new Set<string>(), openedKeys: string[] = [], resolvedKeys: string[] = [];
    const alarm = {
      broadcast: async (e: { conditionKey?: string }) => { open.add(e.conditionKey!); openedKeys.push(e.conditionKey!); return true; },
      resolve: async (e: { conditionKey: string }) => { if (!open.delete(e.conditionKey)) return false; resolvedKeys.push(e.conditionKey); return true; },
      notify: async () => {},
    };
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('SELECT workspace_id')) return [{ workspace_id: 'coverage' }];
      if (text.includes('RETURNING escalation')) return [{ escalation: episode }];
      if (text.includes('INSERT INTO harness_shared.harness_escalations')) {
        const encoded = values.find((value) => typeof value === 'string' && value.includes('"rungs"'));
        if (encoded) episode = JSON.parse(String(encoded));
      }
      return Object.assign([], { count: 1 });
    }) as unknown as import('postgres').Sql;
    const read = vi.spyOn(actions, 'readFrozenCandidateRepairQueueState').mockResolvedValue({ status: 'value', queue } as never);
    const mocks = [read, vi.spyOn(actions, 'dispatchReleaseFixer').mockResolvedValue(null),
      // The fixer rung reserves the queue on the org pool; an unavailable reservation is the
      // same ladder outcome (move on to the owner rungs) without a live-PostgreSQL escape.
      vi.spyOn(actions, 'reserveFrozenCandidateRepairFixer').mockResolvedValue(null as never),
      vi.spyOn(ownership, 'readGateOwnership').mockResolvedValue(null as never),
      vi.spyOn(deploy, 'integrationRoot').mockReturnValue('/coverage-isolated'),
      vi.spyOn(checkpoint, 'isCheckpointRunLockHeldCheap').mockReturnValue({ held: false, elapsedSec: null }),
      vi.spyOn(console, 'warn').mockImplementation(() => {})];
    try {
      const opts = { installSlug: 'coverage', workspaceId: 'coverage', nowMs: () => 10 * 60 * 60_000, alarm };
      await producer.checkIdleRepairQueue(sql, opts);
      expect(checkpoint.isCheckpointRunLockHeldCheap).toHaveBeenCalledWith('/coverage-isolated');
      expect(openedKeys).toEqual(['alarm:idle-repair-queue:coverage']);
      const before = structuredClone(episode);
      read.mockResolvedValue({ status: 'unknown', queue: null } as never);
      await producer.checkIdleRepairQueue(sql, opts);
      expect(resolvedKeys).toEqual([]); expect(episode).toEqual(before);
      read.mockResolvedValue({ status: 'absent', queue: null } as never);
      await producer.checkIdleRepairQueue(sql, opts);
      return { route: 'condition', openedKeys, resolvedKeys };
    } finally { mocks.reverse().forEach((mock) => mock.mockRestore()); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'checkpoint-prebuild-read-failure-and-primary-read', item: 'P-008', route: 'observation', mechanism: 'release-state-read',
  rowIds: ['log-only-fallback|apps/operator/lib/release/green-checkpoint.ts|beginCheckpointPreflight|1'],
  run: async () => {
    const { beginCheckpointPreflight } = await import('../../../../apps/operator/lib/release/green-checkpoint');
    const { releaseConfig } = await import('../../../../apps/operator/lib/release/release-config');
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { vi, expect } = await import('vitest');
    const root = mkdtempSync(join(tmpdir(), 'condition-rail-preflight-'));
    const cfg = { ...releaseConfig(), checkpointLogDir: root };
    const candidate = execFileSync('git', ['-C', cfg.integrationRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const input = 'a'.repeat(64);
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback = (_mechanism: string, row: typeof observations[number]) => { observations.push(row); return true; };
    const exec: Parameters<typeof beginCheckpointPreflight>[2] = async (_cmd, args) => ({ code: 0, stderr: '',
      stdout: args.includes('--fingerprint-ref') ? `DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=${candidate} input=${input}`
        : `DEPENDENCY_GENERATION_RESULT schema=1 identity=coverage token=coverage input=${input} reused=false` });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const base = { target: { workspaceId: 'coverage', installSlug: 'coverage' }, observeFallback, env: {},
        generationPresent: () => true, liveToken: () => 'coverage', log: () => {} };
      const failed = await beginCheckpointPreflight(cfg, candidate, exec, { ...base, awaitState: async () => { throw new Error('state unavailable'); } });
      expect(failed.kind).toBe('ready');
      if (failed.kind === 'ready') { expect(failed.prewarmedDependencyGeneration.reused).toBe(false); failed.lock.release(); }
      const recovered = await beginCheckpointPreflight(cfg, candidate, exec, { ...base, awaitState: async () => ({
        schema: 1, status: 'ready', key: `${candidate}:${input}`, candidate, inputFingerprint: input,
        attemptId: 'coverage', queuedAtMs: 1, startedAtMs: 2, updatedAtMs: 3, completedAtMs: 3,
        producerPid: 4, childPid: 5, identity: 'coverage', token: 'coverage', reused: true,
      }) });
      if (recovered.kind === 'ready') { expect(recovered.prewarmedDependencyGeneration.reused).toBe(true); recovered.lock.release(); }
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([[0, 'prebuild-state-unavailable'], [1, 'applied']]);
      return { route: 'observation', mechanism: 'release-state-read', observations };
    } finally { error.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  },
}, {
  id: 'inconclusive-verdict-partial-delivery-and-complete-pair', item: 'P-008', route: 'observation', mechanism: 'release-verdict-event',
  rowIds: ['log-only-fallback|apps/operator/lib/release/green-checkpoint.ts|emitInconclusiveVerdict|1'],
  run: async () => {
    const { emitInconclusiveVerdict } = await import('../../../../apps/operator/lib/release/green-checkpoint');
    const { vi, expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback = (_mechanism: string, row: typeof observations[number]) => { observations.push(row); return true; };
    const result = { advanced: false, candidate: 'deadbeef', from: null, green: null, reason: 'error' } as const;
    const emitted: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await emitInconclusiveVerdict(result, 'coverage', { observeFallback, emit: async ({ key }) => {
        emitted.push(key); if (key.endsWith(':coverage')) throw new Error('second event failed');
      } });
      expect(observations.map(({ applied }) => applied)).toEqual([0]);
      await emitInconclusiveVerdict(result, 'coverage', { observeFallback, emit: async ({ key }) => { emitted.push(key); } });
      expect(emitted).toEqual(['green-checkpoint:inconclusive', 'green-checkpoint:inconclusive:coverage',
        'green-checkpoint:inconclusive', 'green-checkpoint:inconclusive:coverage']);
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([[0, 'inconclusive-emit-failed'], [1, 'applied']]);
      return { route: 'observation', mechanism: 'release-verdict-event', observations };
    } finally { error.mockRestore(); }
  },
});

for (const updater of ['manifest', 'rollback'] as const) {
  RAIL_MIGRATION_CASES.push({
    id: `update-${updater}-metadata-failure-and-primary-read`, item: 'P-008', route: 'observation', mechanism: 'release-state-read',
    rowIds: [`log-only-fallback|packages/operator-core/lib/endpoint-route/routes/misc/updates-${updater}.ts|handler|1`],
    run: async () => {
      const { vi, expect } = await import('vitest');
      const github = await import('../endpoint-route/routes/misc/updates-github');
      const recorder = await import('./fallback-observations');
      const operatorState = await import('../operator-state-pg');
      const route = updater === 'manifest'
        ? (await import('../endpoint-route/routes/misc/updates-manifest')).default
        : (await import('../endpoint-route/routes/misc/updates-rollback')).default;
      const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
      const release = { tag_name: 'desktop-v0.0.4-alpha', prerelease: true, draft: false,
        published_at: '2026-07-09T00:00:00Z', body: '', assets: [{ id: 1,
          name: 'papercusp-latest-desktop-v0.0.4-alpha.json', browser_download_url: 'https://coverage.invalid/latest.json' }] };
      const mocks: Array<{ mockRestore: () => void }> = [
        vi.spyOn(operatorState, 'readOperatorState').mockResolvedValue({ update_channel: 'alpha' }),
        vi.spyOn(github, 'resolveGithubToken').mockResolvedValue('coverage-token'),
        vi.spyOn(github, 'releaseHostBase').mockReturnValue('https://coverage.invalid'),
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).startsWith('https://coverage.invalid')
          ? new Response(null, { status: 404 }) : Response.json([release])),
        vi.spyOn(recorder, 'observeFallback').mockImplementation((_mechanism, row) => { observations.push(row); return true; }),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
      ];
      const asset = vi.spyOn(github, 'fetchAssetText').mockResolvedValue('{');
      mocks.push(asset);
      const request = new Request(`http://coverage.invalid/api/updates/${updater}?target=linux&arch=x86_64&channel=alpha&current_version=0.0.1-alpha&tag=desktop-v0.0.4-alpha`);
      const handler = (route as unknown as { handler: (req: Request) => Promise<Response> }).handler;
      try {
        await handler(request);
        expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([[0, 'metadata-read-failed']]);
        asset.mockResolvedValue(JSON.stringify({ version: '0.0.4-alpha', platforms: {
          'linux-x86_64': { signature: 'coverage-signature', url: '__RELEASE_HOST__/Papercusp_GUI_0.0.4_amd64.AppImage' },
        } }));
        expect((await handler(request)).status).toBe(200);
        expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
          [0, 'metadata-read-failed'], [1, 'applied']]);
        return { route: 'observation', mechanism: 'release-state-read', observations };
      } finally { for (const mock of mocks) mock.mockRestore(); }
    },
  });
}

RAIL_MIGRATION_CASES.push({
  id: 'checkpoint-owner-red-dedup-and-green-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|apps/operator/lib/release/green-checkpoint.ts|escalate|1'],
  run: async () => {
    const { realCheckpointDeps } = await import('../../../../apps/operator/lib/release/green-checkpoint');
    const { releaseConfig } = await import('../../../../apps/operator/lib/release/release-config');
    const escalation = await import('../agent-tools/coordination/escalations');
    const attention = await import('../attention-notify');
    const severe = await import('../severe-event-broadcast');
    const alarm = await import('../alarm-attention');
    const { vi, expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    const rows: Awaited<ReturnType<typeof escalation.listEscalations>> = [];
    const mocks = [
      vi.spyOn(escalation, 'listEscalations').mockImplementation(async () => rows),
      vi.spyOn(escalation, 'openEscalation').mockImplementation(async (_identity, input) => {
        rows.push({ ...input, msg_id: 'coverage', source: 'green-checkpoint' } as unknown as typeof rows[number]);
        return undefined as never;
      }),
      vi.spyOn(escalation, 'resolveEscalation').mockImplementation(async () => undefined as never),
      vi.spyOn(attention, 'notifyAttention').mockImplementation(async () => undefined as never),
      vi.spyOn(severe, 'broadcastSevereEvent').mockImplementation(async (e) => { openedKeys.push(e.conditionKey!); return true; }),
      vi.spyOn(alarm, 'resolveAlarm').mockImplementation(async (key) => { resolvedKeys.push(key); return true; }),
    ];
    try {
      const deps = realCheckpointDeps(releaseConfig());
      await deps.escalate?.('red fixture', 'red fixture body');
      await deps.escalate?.('still red fixture', 'red fixture body');
      expect(openedKeys).toHaveLength(2);
      expect(attention.notifyAttention).toHaveBeenCalledTimes(1);
      await deps.clearEscalation?.();
      return { route: 'condition', openedKeys: [...new Set(openedKeys)], resolvedKeys };
    } finally { for (const mock of mocks) mock.mockRestore(); }
  },
}, {
  id: 'checkpoint-self-watchdog-owner-failure-and-measured-verdict-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|apps/operator/lib/release/green-checkpoint.ts|onFire|1'],
  run: async () => {
    const { onFire, resolveCheckpointSelfWatchdog } = await import('../../../../apps/operator/lib/release/green-checkpoint');
    const { expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    const deps = { broadcast: async (e: { conditionKey?: string }) => { openedKeys.push(e.conditionKey!); return true; },
      resolve: async (e: { conditionKey: string }) => { resolvedKeys.push(e.conditionKey); return true; },
      notify: async () => { throw new Error('owner delivery unavailable'); } };
    const result = { advanced: false, candidate: 'deadbeef', from: null, green: null, reason: 'error' } as const;
    await onFire(result, 'coverage', deps);
    await resolveCheckpointSelfWatchdog(result, 'coverage', deps);
    await resolveCheckpointSelfWatchdog({ ...result, green: true, reason: 'up-to-date' }, 'coverage', deps);
    expect(resolvedKeys).toEqual([]);
    await resolveCheckpointSelfWatchdog({ ...result, green: false, reason: 'not-green' }, 'coverage', deps);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'chronic-release-flake-cooldown-unknown-read-and-quiet-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/harness/routines/release-actions.ts|trackFlakeHistory|1'],
  run: async () => {
    const { trackFlakeHistory } = await import('../harness/routines/release-actions');
    const { releaseCheckpointConfig } = await import('../release-checkpoint-config');
    const { expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [], notifications: string[] = [];
    let now = 1_000, unavailable = false;
    let history: Record<string, { flakes?: number; lastFlakeAt?: number; notifiedAt?: number }> = {};
    const sql = Object.assign(async () => [], { unsafe: async (text: string, values: unknown[]) => {
      if (unavailable) throw new Error('history unavailable');
      if (text.includes('SELECT')) return [{ fh: structuredClone(history) }];
      history = JSON.parse(String(values[1])).flake_history; return [];
    } }) as unknown as import('postgres').Sql;
    const open = new Set<string>();
    const deps = { sql, nowMs: () => now, alarm: {
      broadcast: async (e: { conditionKey?: string }) => { open.add(e.conditionKey!); openedKeys.push(e.conditionKey!); return true; },
      resolve: async (e: { conditionKey: string }) => {
        if (!open.delete(e.conditionKey)) return false; resolvedKeys.push(e.conditionKey); return true;
      }, notify: async (e: { title: string }) => { notifications.push(e.title); },
    } };
    const ctx = { installSlug: 'coverage', workspaceId: 'coverage' };
    for (let i = 0; i < releaseCheckpointConfig().chronicFlakeCount + 1; i++) {
      await trackFlakeHistory(ctx, undefined, ['workspace::test.ts'], deps);
    }
    expect(notifications).toHaveLength(1);
    expect(openedKeys).toHaveLength(2); // condition refresh survives owner cooldown
    await trackFlakeHistory(ctx, undefined, [], deps);
    expect(resolvedKeys).toEqual([]); // one clean tick does not establish recovery
    now += releaseCheckpointConfig().flakeNotifyCooldownMs;
    unavailable = true;
    await expect(trackFlakeHistory(ctx, undefined, [], deps)).rejects.toThrow('history unavailable');
    expect(resolvedKeys).toEqual([]);
    unavailable = false; await trackFlakeHistory(ctx, undefined, [], deps);
    expect(history['workspace::test.ts'].flakes).toBe(releaseCheckpointConfig().chronicFlakeCount + 1);
    return { route: 'condition', openedKeys: [...new Set(openedKeys)], resolvedKeys };
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'loop-standdown-read-failure-and-complete-read', item: 'P-008', route: 'observation', mechanism: 'release-state-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/harness/routines/release-pause-ttl.ts|listLoopStanddownOwners|1'],
  run: async () => {
    const { listLoopStanddownOwners } = await import('../harness/routines/release-pause-ttl');
    const { vi, expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback = (_mechanism: string, row: typeof observations[number]) => { observations.push(row); return true; };
    const failure = (async () => { throw new Error('scan unavailable'); }) as unknown as import('postgres').Sql;
    const success = (async () => []) as unknown as import('postgres').Sql;
    const full = (async () => [{ target_owner_id: 'held', pause: {} }]) as unknown as import('postgres').Sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await listLoopStanddownOwners(failure, { observeFallback })).toEqual(new Set());
      await listLoopStanddownOwners(full, { observeFallback, limit: 1 });
      await listLoopStanddownOwners(success, { observeFallback });
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
        [0, 'hold-scan-failed'], [0, 'scan-truncated'], [1, 'applied']]);
      return { route: 'observation', mechanism: 'release-state-read', observations };
    } finally { warn.mockRestore(); }
  },
}, {
  id: 'checkpoint-state-routing-failure-skip-and-primary-read', item: 'P-008', route: 'observation', mechanism: 'release-state-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/release/green-stall-watchdog.ts|readCheckpointRunState|1'],
  run: async () => {
    const { readCheckpointRunState } = await import('../release/green-stall-watchdog');
    const { vi, expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback = (_mechanism: string, row: typeof observations[number]) => { observations.push(row); return true; };
    const route: NonNullable<NonNullable<Parameters<typeof readCheckpointRunState>[2]>['route']> = async () => ({
      root: '/coverage', extraEnv: {}, clearEnv: [],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await readCheckpointRunState('coverage', 'coverage', { observeFallback,
        route: async () => { throw new Error('routing unavailable'); } })).toEqual({});
      await readCheckpointRunState('coverage', 'coverage', { observeFallback,
        route: async () => ({ ...(await route({ installSlug: 'coverage', workspaceId: 'coverage' }, '/coverage')), skip: { reason: 'coverage skip' } }) });
      await readCheckpointRunState('misconfigured', 'coverage', { observeFallback,
        route: async () => ({ root: '/coverage', extraEnv: {}, clearEnv: [],
          skip: { reason: 'integration-equals-release', misconfigured: true } }) });
      const deps = { observeFallback, route, readLock: () => ({ held: true, elapsedSec: 1 }), readPhase: () => null };
      await readCheckpointRunState('coverage', 'coverage', deps);
      await readCheckpointRunState('coverage', 'coverage', { ...deps, readLock: () => ({ held: false, elapsedSec: null }) });
      expect(observations.map(({ applied, reason }) => [applied, reason])).toEqual([
        [0, 'run-state-unavailable'], [0, 'routing-misconfigured'], [0, 'phase-unavailable'], [1, 'applied']]);
      return { route: 'observation', mechanism: 'release-state-read', observations };
    } finally { warn.mockRestore(); }
  },
}, {
  id: 'lost-gate-run-owner-fallback-and-measured-recovery', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/release/lost-gate-run-alarm.ts|defaultNotifyOwner|1'],
  run: async () => {
    const { sweepLostGateRuns } = await import('../release/lost-gate-run-alarm');
    const { expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    const nowMs = Date.now();
    let marker: unknown = { candidate: 'deadbeef', candidateSource: 'tip', base: 'base',
      selectedAtMs: nowMs - 60_000, quietCutApplied: false, tipAtSelection: null, refireDepth: 0,
      pid: 42, observedAtMs: nowMs - 60_000, verdictWrittenAtMs: null };
    let alarmed_key: string | null = null;
    const sql = (async (strings: TemplateStringsArray) => strings.join('').includes('SELECT')
      ? [{ install_slug: 'coverage', workspace_id: 'coverage', marker, alarmed_key }]
      : Object.assign([], { count: 1 })) as unknown as import('postgres').Sql;
    const attention = { broadcast: async (e: { conditionKey?: string }) => { openedKeys.push(e.conditionKey!); return true; },
      resolve: async (e: { conditionKey: string }) => { resolvedKeys.push(e.conditionKey); return true; }, notify: async () => {} };
    const deps = { nowMs, selfPid: 1, pidAlive: () => false, hostFleetSlug: null,
      readHolder: async () => null, claim: async (_sql: unknown, _target: unknown, key: string) => { alarmed_key = key; return true; },
      broadcast: attention.broadcast, attention };
    await sweepLostGateRuns(sql, deps);
    expect(openedKeys).toHaveLength(2); // both the existing broadcast and actual owner fallback execute
    await sweepLostGateRuns(sql, { ...deps, pidAlive: () => null });
    expect(resolvedKeys).toEqual([]);
    marker = null; await sweepLostGateRuns(sql, deps);
    return { route: 'condition', openedKeys: [...new Set(openedKeys)], resolvedKeys };
  },
}, {
  id: 'release-watchdog-failed-passes-and-measured-recovery', item: 'P-008', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/release/watchdog-health.ts|<module>|1'],
  run: async () => {
    const { recordWatchdogPassOutcome } = await import('../release/watchdog-health');
    const watchdog = await import('../system-health/degradation-watchdog');
    const { summarizeFallbackWindow } = await import('./fallback-observations');
    const observations: Array<{ eligible: number; applied: number; reason: string; samples: number }> = [];
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    const open = new Set<string>();
    const sql = (async () => Object.assign([], { count: 1 })) as unknown as import('postgres').Sql;
    const scope = { routineName: 'green-checkpoint' as const, installSlug: 'coverage' };
    const deps = { observeFallback: (_mechanism: string, row: { eligible: number; applied: number; reason: string }) => {
      if (_mechanism !== 'release-watchdog-pass') throw new Error('unexpected pass mechanism');
      observations.push({ ...row, samples: 1 }); return true;
    } };
    const sweep = () => watchdog.runDegradationSweepOnce({
      mechanisms: () => [watchdog.getDegradationMechanism('release-watchdog-pass')!],
      readWindows: async () => [{ scope: 'coverage:green-checkpoint:green-stall',
        window: summarizeFallbackWindow('release-watchdog-pass', 60_000, observations) }],
      readOpenConditionKeys: async () => [...open],
      broadcast: async ({ conditionKey }) => { open.add(conditionKey!); openedKeys.push(conditionKey!); return true; },
      resolve: async ({ conditionKey }) => { open.delete(conditionKey); resolvedKeys.push(conditionKey); return true; },
      prune: async () => 0,
    });
    const { expect } = await import('vitest');
    await recordWatchdogPassOutcome(sql, 'green-stall', scope, new Error('failed pass'), deps);
    await sweep();
    expect(openedKeys).toHaveLength(1); // the production sparse floor is actually used
    for (let i = 0; i < 3; i++) await recordWatchdogPassOutcome(sql, 'green-stall', scope, new Error('failed pass'), deps);
    await sweep();
    for (let i = 0; i < 4; i++) await recordWatchdogPassOutcome(sql, 'green-stall', scope, undefined, deps);
    await sweep();
    return { route: 'condition', openedKeys, resolvedKeys };
  },
}, {
  id: 'gate-canary-store-failure-unknown-and-healthy', item: 'P-008', route: 'condition',
  rowIds: ['owner-only-alarm|packages/operator-core/lib/gates/gate-canary-sweep-action.ts|recordCanaryVerdict|1'],
  run: async () => {
    const { recordCanaryVerdict } = await import('../gates/gate-canary-sweep-action');
    const { classifyGateCanary } = await import('../gates/canary');
    const { vi, expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    let storeFails = true;
    const deps = {
      attention: { broadcast: async (e: { conditionKey?: string }) => { openedKeys.push(e.conditionKey!); return true; },
        resolve: async (e: { conditionKey: string }) => { resolvedKeys.push(e.conditionKey); return true; }, notify: async () => {} },
      assertFact: (async () => ({})) as unknown as typeof import('../agent-facts/store').assertFact,
      sql: { unsafe: async () => { if (storeFails) throw new Error('escalation store unavailable'); return []; } } as unknown as Pick<import('postgres').Sql, 'unsafe'>,
    };
    const run = (canaryOk: boolean | null, systemGreen: boolean | null) => recordCanaryVerdict({
      ctx: { installSlug: 'coverage', workspaceId: 'coverage', triggerConfig: {}, payloadTemplate: null },
      report: { id: 'coverage', describe: 'known-good sample', ranAtMs: 0, canaryOk, canaryDetail: 'fixture', systemGreen,
        classification: classifyGateCanary({ canaryOk, systemGreen }) },
      factKey: 'coverage', escalationPhase: 'coverage', title: 'Canary apparatus failed',
    }, deps);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run(false, false);
      expect(openedKeys).toHaveLength(1); // independent of failed legacy store
      storeFails = false;
      await run(null, null);
      expect(resolvedKeys).toEqual([]);
      await run(true, null); // a successful known-good sample proves apparatus recovery
      return { route: 'condition', openedKeys: [...new Set(openedKeys)], resolvedKeys };
    } finally { warn.mockRestore(); log.mockRestore(); }
  },
}, {
  id: 'worktree-coverage-partial-scans-never-recover', item: 'P-008', route: 'condition',
  rowIds: ['bespoke-watchdog|packages/operator-core/lib/release/worktree-coverage-watchdog.ts|<module>|1'],
  run: async () => {
    const { checkWorktreeCoverage, checkGitSyncCoverage } = await import('../release/worktree-coverage-watchdog');
    const { expect } = await import('vitest');
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    const attention = { broadcast: async (e: { conditionKey?: string }) => { openedKeys.push(e.conditionKey!); return true; },
      resolve: async (e: { conditionKey: string }) => { resolvedKeys.push(e.conditionKey); return true; } };
    let state: 'dirty' | 'unreadable' | 'clean' = 'dirty';
    const canonical = '/rail/canonical', stray = '/rail/work-in-flight';
    const runGit = async (args: string[], cwd: string) => {
      if (args[0] === 'worktree') return `worktree ${canonical}\n\nworktree ${stray}\n\n`;
      if (args[0] === 'rev-parse') return cwd;
      if (args[0] === 'log') return '1';
      if (cwd === stray && state === 'unreadable') throw new Error('status unavailable');
      return cwd === stray && state === 'dirty' ? ' M work.ts\n' : '';
    };
    const deps = { runGit, attention, log: () => {} };
    await checkWorktreeCoverage(canonical, deps);
    state = 'unreadable'; await checkWorktreeCoverage(canonical, deps);
    expect(resolvedKeys).toEqual([]);
    state = 'clean'; await checkWorktreeCoverage(canonical, deps);
    state = 'dirty';
    // The sibling pass has no linked stray; it must independently find clones.
    const siblingDeps = { ...deps,
      runGit: async (args: string[], cwd: string) => args[0] === 'worktree' ? `worktree ${canonical}\n` : runGit(args, cwd),
      listChildDirs: async () => [stray], realpath: async (p: string) => p, pathExists: async () => true,
      loadActiveGitSyncSlugs: async () => [], loadRegistryProjects: async () => [],
    };
    await checkGitSyncCoverage(canonical, siblingDeps);
    state = 'unreadable'; await checkGitSyncCoverage(canonical, siblingDeps);
    expect(resolvedKeys).toHaveLength(1);
    state = 'clean'; await checkGitSyncCoverage(canonical, siblingDeps);
    return { route: 'condition', openedKeys, resolvedKeys };
  },
});

// Each entry executes a real producer twice: a breached sample with the owner cooldown
// active, then a healthy sample. No source-text assertion stands in for caller behavior.
type AlarmCapture = import('../alarm-attention').AlarmAttentionDeps;
const alarmCases: Array<{ id: string; rowId: string; run: (deps: AlarmCapture) => Promise<void> }> = [
  { id: 'shared-attention', rowId: 'owner-only-alarm|packages/operator-core/lib/alarm-attention.ts|defaultNotify|1',
    run: async (deps) => {
      const { escalateAlarm, resolveAlarm } = await import('../alarm-attention');
      await escalateAlarm({ title: 'Condition coverage', body: 'Measured breach', cooldownMs: 1,
        source: 'coverage', conditionKey: 'alarm:coverage' }, deps);
      await resolveAlarm('alarm:coverage', 'coverage', deps);
    } },
  { id: 'rate-governor', rowId: 'owner-only-alarm|packages/operator-core/lib/agent-governor-observer.ts|surfacePause|1',
    run: async (attention) => {
      const { initAgentGovernorObserver, _resetAgentGovernorObserver, flushAgentGovernorAlarms } = await import('../agent-governor-observer');
      const { getGovernor, resetGovernorRegistry } = await import('@papercusp/papercusp-shared/agent');
      _resetAgentGovernorObserver(); resetGovernorRegistry();
      let clock = Date.now();
      try {
        initAgentGovernorObserver({ ...attention, status: async () => {}, recentlyEscalated: async () => true });
        const governor = getGovernor('anthropic', 'condition-rail', { now: () => clock });
        governor.penalize({ retryAfterMs: 100_000 });
        await flushAgentGovernorAlarms();
        clock = governor.snapshot().pausedUntil;
        (await governor.acquire())?.();
        await flushAgentGovernorAlarms();
      } finally { _resetAgentGovernorObserver(); resetGovernorRegistry(); }
    } },
  { id: 'replication-slot', rowId: 'owner-only-alarm|packages/operator-core/lib/storage/replication-slot-alarm.ts|runReplicationSlotAlarmOnce|1',
    run: async (attention) => {
      const { runReplicationSlotAlarmOnce } = await import('../storage/replication-slot-alarm');
      const deps = { ...attention, emitToast: async () => {}, recentlyEscalated: async () => true };
      await runReplicationSlotAlarmOnce({ ...deps, fetchSlots: async () => [{ slotName: 'stuck',
        slotType: 'logical', active: false, retainedWalBytes: 1024 ** 4, walStatus: 'reserved' }] });
      await runReplicationSlotAlarmOnce({ ...deps, fetchSlots: async () => [] });
    } },
  { id: 'disk-space', rowId: 'owner-only-alarm|packages/operator-core/lib/storage/disk-space-alarm.ts|runDiskSpaceAlarmOnce|1',
    run: async (attention) => {
      const { runDiskSpaceAlarmOnce, DEFAULT_DISK_POLICY } = await import('../storage/disk-space-alarm');
      // Declared bind mounts: missing on the first pass, back on the second, so that
      // condition opens and recovers too, and the case never reads the real host's fstab.
      let mountReads = 0;
      const deps = { ...attention, emitToast: async () => {}, recentlyEscalated: async () => true,
        readContext: async () => ({ devices: [], receipt: null }),
        attributeUsage: async () => ({ entries: [], truncated: false }),
        readMissingMounts: async () => (mountReads++ === 0
          ? [{ source: '/fixture-src', target: '/coverage', options: ['bind', 'nofail'] }] : []) };
      const snapshot = { path: '/coverage', totalBytes: 100 * 1024 ** 3, freeBytes: 1,
        freePct: 0, totalInodes: 100, freeInodes: 100, freeInodesPct: 1 };
      await runDiskSpaceAlarmOnce({ ...deps, sample: async () => [snapshot] }, DEFAULT_DISK_POLICY);
      await runDiskSpaceAlarmOnce({ ...deps, sample: async () => [{ ...snapshot,
        freeBytes: snapshot.totalBytes, freePct: 1 }] }, DEFAULT_DISK_POLICY);
    } },
  { id: 'storage-growth', rowId: 'owner-only-alarm|packages/operator-core/lib/storage/storage-growth-alarm.ts|runStorageGrowthAlarmOnce|1',
    run: async (attention) => {
      const { runStorageGrowthAlarmOnce } = await import('../storage/storage-growth-alarm');
      const deps = { ...attention, emitToast: async () => {}, recentlyEscalated: async () => true,
        listTableSizes: async () => [], listDiskRootChildren: async () => ({ entries: [], truncated: false }),
        countExemptSubsets: async () => [], readRetentionAges: async () => [],
        // The headroom sub-alarm's default census reads PostgreSQL; an empty census keeps it hermetic.
        readDiskCensus: async () => [] };
      const row: import('../storage/usage').StorageUsageRow = { id: 'coverage', label: 'Coverage',
        kind: 'pg', federation: 'local-diagnostic', trimmable: true, bloats: false,
        totalBytes: 1024 ** 4, totalRows: 1, ageBuckets: [], description: 'Coverage' };
      await runStorageGrowthAlarmOnce({ ...deps, computeUsage: async () => [row] });
      await runStorageGrowthAlarmOnce({ ...deps, computeUsage: async () => [{ ...row, totalBytes: null }] });
      await runStorageGrowthAlarmOnce({ ...deps, computeUsage: async () => [{ ...row, totalBytes: 0 }] });
    } },
  { id: 'poll-suspect', rowId: 'owner-only-alarm|packages/operator-core/lib/poll-suspect-alarm.ts|runPollSuspectScanOnce|1',
    run: async (attention) => {
      const { runPollSuspectScanOnce } = await import('../poll-suspect-alarm');
      const suspect = { tool_name: 'coverage:poll', call_count: 1000, calls_per_hour: 200,
        callers: 5, calls_per_caller_per_hour: 40, total_bytes: 0, reason: 'polling-shaped' };
      // This row was already toasted. Deduplication must not suppress its condition.
      const deps = { ...attention, emitToast: async () => {}, recentlyEscalated: async () => true,
        now: () => 1000, lastAlertedAt: new Map([[suspect.tool_name, 1000]]) };
      await runPollSuspectScanOnce({ ...deps, loadSuspects: async () => [suspect] });
      await runPollSuspectScanOnce({ ...deps, loadSuspects: async () => [] });
    } },
  { id: 'localstorage-wal', rowId: 'owner-only-alarm|packages/operator-core/lib/storage/localstorage-wal-guard.ts|runWalCheckpointGuard|1',
    run: async (deps) => {
      const { DatabaseSync } = await import('node:sqlite');
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { runWalCheckpointGuard } = await import('../storage/localstorage-wal-guard');
      const root = mkdtempSync(join(tmpdir(), 'condition-rail-wal-'));
      let writer: InstanceType<typeof DatabaseSync> | undefined;
      let reader: InstanceType<typeof DatabaseSync> | undefined;
      try {
        const path = join(root, 'coverage.localstorage');
        writer = new DatabaseSync(path);
        writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (v TEXT);');
        writer.prepare('INSERT INTO t VALUES (?)').run('before');
        reader = new DatabaseSync(path);
        reader.exec('BEGIN;');
        reader.prepare('SELECT * FROM t').all();
        writer.prepare('INSERT INTO t VALUES (?)').run('x'.repeat(16_384));
        await runWalCheckpointGuard({ roots: [root], thresholdBytes: 1 }, deps);
        reader.exec('COMMIT;'); reader.close(); reader = undefined;
        await runWalCheckpointGuard({ roots: [root], thresholdBytes: 1 }, deps);
      } finally {
        reader?.close(); writer?.close(); rmSync(root, { recursive: true, force: true });
      }
    } },
  { id: 'gui-surface', rowId: 'owner-only-alarm|packages/operator-core/lib/system-health/gui-e2e-surface-scheduled-run.ts|escalate|1',
    run: async (attention) => {
      const { EventEmitter } = await import('node:events');
      const { defaultIO, runGuiE2eSurfaceScheduledRun } = await import('../system-health/gui-e2e-surface-scheduled-run');
      const run = async (code: number) => {
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(),
          stderr: new EventEmitter(), kill: () => true });
        const pending = runGuiE2eSurfaceScheduledRun({ ...defaultIO, readEnabled: async () => true,
          spawnFn: () => child as unknown as import('node:child_process').ChildProcess,
          escalate: (input) => defaultIO.escalate(input, attention),
          resolve: () => defaultIO.resolve!(attention) });
        await Promise.resolve();
        child.stdout.emit('data', `P001_TAURI_SURFACE_VERIFY_${code ? 'FAIL' : 'OK'} leg=coverage\n`);
        child.emit('close', code);
        await pending;
      };
      const { vi, expect } = await import('vitest');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try { await run(1); expect(warn).toHaveBeenCalled(); }
      finally { warn.mockRestore(); }
      await run(0);
    } },
];

RAIL_MIGRATION_CASES.push(...alarmCases.map((caller): RailMigrationCase => ({
  id: `alarm-${caller.id}-open-recover`, item: 'P-007', route: 'condition', rowIds: [caller.rowId],
  run: async () => {
    const openedKeys: string[] = [];
    const resolvedKeys: string[] = [];
    await caller.run({
      broadcast: async (event) => { openedKeys.push(event.conditionKey!); return true; },
      resolve: async (event) => { resolvedKeys.push(event.conditionKey); return true; },
      notify: async () => {}, recentlyEscalated: async () => true,
    });
    return { route: 'condition', openedKeys, resolvedKeys };
  },
})));

RAIL_MIGRATION_CASES.push({
  id: 'coverage-snapshot-read-failure-cache-and-recovery', item: 'P-010', route: 'observation',
  mechanism: 'coverage-snapshot-read',
  rowIds: ['log-only-fallback|packages/operator-core/lib/search/coverage-gate.ts|loadCoverageSnapshotCached|1'],
  run: async () => {
    const producer = await import('../search/coverage-gate');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observe: typeof import('./fallback-observations').observeFallback = (mechanism, decision) => {
      if (mechanism !== 'coverage-snapshot-read') throw new Error('unexpected coverage mechanism');
      observations.push(decision); return true;
    };
    let reads = 0;
    const sql = { unsafe: async () => { reads++; if (reads === 1) throw new Error('coverage fixture read failed'); return []; } };
    const now = new Date();
    producer.resetCoverageSnapshotCache();
    const { vi, expect } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await producer.loadCoverageSnapshotCached(sql, 'coverage', now, observe);
      await producer.loadCoverageSnapshotCached(sql, 'coverage', new Date(now.getTime() + 1_000), observe);
      await producer.loadCoverageSnapshotCached(sql, 'coverage', new Date(now.getTime() + 120_000), observe);
      if (reads !== 2 || observations.map((entry) => entry.applied).join() !== '0,0,1') {
        throw new Error('failed cached reads must stay degraded until a real successful read');
      }
      expect(warn).toHaveBeenCalledTimes(1);
      return { route: 'observation', mechanism: 'coverage-snapshot-read', observations };
    } finally { producer.resetCoverageSnapshotCache(); warn.mockRestore(); }
  },
}, {
  id: 'bm25-scan-score-disagreement-and-verified-recovery', item: 'P-010', route: 'observation',
  mechanism: 'bm25-scan-score',
  rowIds: ['log-only-fallback|packages/operator-core/lib/search/lexical/rank.ts|runBm25TopK|1'],
  run: async () => {
    const producer = await import('../search/lexical/rank');
    const { default: postgres } = await import('postgres');
    // postgres supplies actual fragment construction; only the check-query execution is
    // replaced at its existing Sql seam. No connection is opened by lazy fragments.
    const sql = postgres();
    const exec = new Proxy(sql, { apply: () => Promise.resolve([{ bm25_d: -5 }]) });
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observe: typeof import('./fallback-observations').observeFallback = (mechanism, decision) => {
      if (mechanism !== 'bm25-scan-score') throw new Error('unexpected lexical mechanism');
      observations.push(decision); return true;
    };
    const req = { distance: sql`-5`, columns: sql`1 AS id`, from: sql`(VALUES (1)) source(id)`,
      where: sql`true`, limit: 1, scanScore: sql`0` };
    let runs = 0;
    producer.resetBm25ScanScoreFallbacks();
    const { vi, expect } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await producer.runBm25TopK(sql, exec, req, async () => [{ bm25_d: ++runs === 1 ? 0 : -5 }],
        (row) => row.bm25_d, observe);
      if (runs !== 2) throw new Error('untrusted scan score did not trigger standalone rerun');
      await producer.runBm25TopK(sql, exec, req, async () => [{ bm25_d: -5 }], (row) => row.bm25_d, observe);
      if (observations.map((entry) => entry.applied).join() !== '0,1') throw new Error('scan score decisions not observed');
      expect(warn).toHaveBeenCalledTimes(1);
      return { route: 'observation', mechanism: 'bm25-scan-score', observations };
    } finally { await sql.end(); producer.resetBm25ScanScoreFallbacks(); warn.mockRestore(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'query-embedder-acquisition-failure-and-measured-recovery', item: 'P-010', route: 'observation',
  mechanism: 'query-embedder-acquisition',
  rowIds: ['log-only-fallback|packages/operator-core/lib/agent-tools/search/embedder.ts|buildQueryEmbedderResolved|1'],
  run: async () => {
    const producer = await import('../agent-tools/search/embedder');
    const { EMBEDDER_DIM_SPECS } = await import('@papercusp/memory');
    const { vi, expect } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback: typeof import('./fallback-observations').observeFallback = (mechanism, decision) => {
      expect(mechanism).toBe('query-embedder-acquisition'); observations.push(decision); return true;
    };
    try {
      expect(await producer.buildQueryEmbedderResolved(undefined, {
        acquire: async () => { throw new Error('pipeline unavailable'); }, observeFallback,
      })).toBeNull();
      expect(await producer.buildQueryEmbedderResolved(undefined, {
        acquire: async () => ({ mode: 'disabled' }), observeFallback,
      })).toBeNull();
      // A preference-disabled call contributes no eligible unit and no false recovery.
      expect(observations).toHaveLength(1);
      expect(await producer.buildQueryEmbedderResolved(undefined, {
        acquire: async () => ({ mode: 'local', dims: EMBEDDER_DIM_SPECS.local.targetDims,
          profile: EMBEDDER_DIM_SPECS.local, embed: async () => [1, 2, 3] }), observeFallback,
      })).not.toBeNull();
      expect(observations.map((row) => row.applied)).toEqual([0, 1]);
      expect(warn).toHaveBeenCalledTimes(1);
      return { route: 'observation', mechanism: 'query-embedder-acquisition', observations };
    } finally { warn.mockRestore(); producer._clearQueryEmbedCacheForTests(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'jev-worker-transport-per-request-fallback-and-new-worker-recovery', item: 'P-010', route: 'observation',
  mechanism: 'jev-worker-transport',
  rowIds: ['log-only-fallback|packages/operator-core/lib/memory/jev-transport.ts|reportTransportEvent|1'],
  run: async () => {
    const { createServer } = await import('node:http');
    const { createWorkerTransport, WORKER_TRANSPORT_MAX_FAILURES } = await import('@papercusp/decision-model');
    const { reportTransportEvent } = await import('../memory/jev-transport');
    const { vi, expect } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observe: typeof import('./fallback-observations').observeFallback = (mechanism, decision) => {
      expect(mechanism).toBe('jev-worker-transport'); observations.push(decision); return true;
    };
    const server = createServer((_req, response) => response.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`;
    const transports: import('@papercusp/decision-model').WorkerTransport[] = [];
    const make = () => {
      const transport = createWorkerTransport({ keepAliveIdleMs: 1000,
        fallback: async () => ({ status: 200, headers: { get: () => null }, text: async () => 'fallback' }),
        onEvent: (event) => reportTransportEvent(event, observe) });
      transports.push(transport); return transport;
    };
    const call = (transport: import('@papercusp/decision-model').WorkerTransport) => transport.fetch(url, {
      method: 'POST', body: '', headers: {}, signal: AbortSignal.timeout(5000) });
    try {
      const broken = make();
      for (let i = 0; i < WORKER_TRANSPORT_MAX_FAILURES; i++) {
        await call(broken); await broken.__killWorkerForTest();
      }
      expect(broken.mode()).toBe('fallback');
      expect(await (await call(broken)).text()).toBe('fallback');
      expect(await (await call(broken)).text()).toBe('fallback');
      expect(observations.slice(-2).map((row) => row.applied)).toEqual([0, 0]);
      await call(make());
      expect(observations.at(-1)?.applied).toBe(1);
      expect(warn).toHaveBeenCalledTimes(WORKER_TRANSPORT_MAX_FAILURES + 1);
      return { route: 'observation', mechanism: 'jev-worker-transport', observations };
    } finally {
      await Promise.all(transports.map((transport) => transport.close()));
      await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
      warn.mockRestore();
    }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'backfill-batch-host-wired-failure-and-success', item: 'P-010', route: 'observation',
  mechanism: 'backfill-batch',
  rowIds: ['log-only-fallback|libs/generic/search/src/backfill/backfill-table.ts|backfillTable|1'],
  run: async () => {
    const host = await import('../search/embed-backfill');
    const primitive = await import('./fallback-observations');
    const { PROSE_VECTOR_DIMS } = await import('../search/prose-vector-dims');
    const { vi, expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const sink = vi.spyOn(primitive, 'observeFallback').mockImplementation((mechanism, decision) => {
      expect(mechanism).toBe('backfill-batch'); observations.push(decision); return true;
    });
    const vector = new Array<number>(PROSE_VECTOR_DIMS).fill(0);
    const target = { table: 'coverage.notes', embedCol: 'embedding', keyCols: ['id'], bodySql: 'body' };
    // The caller only awaits unsafe; this fixture replaces SQL execution, not
    // postgres.js's lazy PendingQuery construction API.
    const sql = {
      unsafe: async (query: string) => query.startsWith('SELECT')
        ? [{ k0: 'a', body: 'a' }, { k0: 'b', body: 'b' }] : [],
    } as unknown as Parameters<typeof host.backfillTable>[0];
    const warn = vi.fn();
    try {
      const options = { mode: 'local' as const, embed: async () => vector, maxRows: 2,
        spaceAware: false, logger: { log: vi.fn(), warn, error: vi.fn() } };
      expect((await host.backfillTable(sql, target, { ...options,
        embedMany: async () => { throw new Error('batch down'); } })).embedded).toBe(2);
      expect((await host.backfillTable(sql, target, { ...options,
        embedMany: async (texts) => texts.map(() => vector) })).embedded).toBe(2);
      expect(observations.map((row) => row.applied)).toEqual([0, 2]);
      expect(observations.map((row) => row.eligible)).toEqual([2, 2]);
      expect(warn).toHaveBeenCalledTimes(1);
      const config = host.proseBackfillSweeperConfig({ running: false, lastResult: null, sweepCounter: 0, startedAt: null });
      expect(config.observeFallback).toBeTypeOf('function');
      config.observeFallback!({ eligible: 2, applied: 2, reason: 'batch-applied', scope: target.table });
      expect(observations).toHaveLength(3);
      return { route: 'observation', mechanism: 'backfill-batch', observations };
    } finally { sink.mockRestore(); }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'embed-device-host-observation-and-verified-construction-recovery', item: 'P-010', route: 'observation',
  mechanism: 'embed-device',
  rowIds: ['log-only-fallback|libs/generic/memory/src/embed-device.ts|recordEmbedDeviceDemotion|1'],
  run: async () => {
    await import('../memory/configure');
    const memory = await import('@papercusp/memory');
    const config = await import('../../../../libs/generic/memory/src/config');
    const { vi, expect } = await import('vitest');
    const savedHost = config.memoryHost();
    const saved = process.env[memory.EMBED_DEVICE_ENV];
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    config.configureMemory({ ...savedHost, observeFallback: (mechanism, decision) => {
      expect(mechanism).toBe('embed-device'); observations.push(decision);
    } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      memory._resetEmbedDeviceState();
      process.env[memory.EMBED_DEVICE_ENV] = 'gpu';
      const failed = { pipeline: async (_task: string, _model: string, opts?: Record<string, unknown>) => {
        if (opts?.device === 'cuda') throw new Error('GPU provider failed');
        return { device: opts?.device };
      } };
      expect(await memory.constructEmbedPipeline(failed, 'first', {})).toEqual({ device: 'cpu' });
      expect(await memory.constructEmbedPipeline(failed, 'second', {})).toEqual({ device: 'cpu' });
      expect(observations.map((row) => row.applied)).toEqual([0, 0]);
      memory._resetEmbedDeviceState();
      expect(await memory.constructEmbedPipeline({ pipeline: async (_task, _model, opts) => ({ device: opts?.device }) }, 'recovered', {}))
        .toEqual({ device: 'cuda' });
      process.env[memory.EMBED_DEVICE_ENV] = 'cpu';
      await memory.constructEmbedPipeline(failed, 'deliberate-cpu', {});
      expect(observations.map((row) => row.applied)).toEqual([0, 0, 1]);
      expect(warn).toHaveBeenCalledTimes(1);
      return { route: 'observation', mechanism: 'embed-device', observations };
    } finally {
      config.__setMemoryHostForTests(savedHost); memory._resetEmbedDeviceState(); warn.mockRestore();
      if (saved === undefined) delete process.env[memory.EMBED_DEVICE_ENV]; else process.env[memory.EMBED_DEVICE_ENV] = saved;
    }
  },
}, {
  id: 'embed-worker-host-observation-before-log-cooldown-and-real-protocol-success', item: 'P-010', route: 'observation',
  mechanism: 'embed-worker',
  rowIds: ['log-only-fallback|libs/generic/memory/src/local-embedder-worker.ts|warnEmbedFallback|1'],
  run: async () => {
    await import('../memory/configure');
    const config = await import('../../../../libs/generic/memory/src/config');
    const worker = await import('../../../../libs/generic/memory/src/local-embedder-worker');
    const { Worker } = await import('node:worker_threads');
    const { vi, expect } = await import('vitest');
    const savedHost = config.memoryHost();
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    config.configureMemory({ ...savedHost, observeFallback: (mechanism, decision) => {
      if (mechanism === 'embed-worker') observations.push(decision);
    } });
    const originalPost = Worker.prototype.postMessage;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: InstanceType<typeof Worker>, message, ...args) {
      if (message?.kind === 'embed') {
        queueMicrotask(() => this.emit('message', { kind: 'embed_ok', id: message.id, vector: [1, 2, 3] }));
      } else { originalPost.call(this, message, ...args); }
    });
    try {
      await worker._resetWorker(); worker._resetFallbackWarnForTest();
      worker.warnEmbedFallback('local', new Error('worker unavailable'));
      worker.warnEmbedFallback('local', new Error('still unavailable'));
      expect(observations.map((row) => row.applied)).toEqual([0, 0]);
      // The real request/response protocol runs; only native inference is replaced.
      expect(await worker.embedViaWorker('recovered')).toEqual([1, 2, 3]);
      expect(observations.map((row) => row.applied)).toEqual([0, 0, 1]);
      return { route: 'observation', mechanism: 'embed-worker', observations };
    } finally {
      post.mockRestore(); await worker._resetWorker(); worker._resetFallbackWarnForTest();
      config.__setMemoryHostForTests(savedHost);
    }
  },
});

RAIL_MIGRATION_CASES.push({
  id: 'search-sampler-authoritative-verdict-through-host-sink-once', item: 'P-010', route: 'observation', mechanism: 'retrieval',
  rowIds: ['health-flag-no-condition|libs/generic/search/src/leg-health.ts|sampleOfLegs|1'],
  run: async () => {
    const search = await import('@papercusp/search');
    const host = await import('../system-health/retrieval-degradation-watchdog');
    const { expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const leg = {
      status: 'ran', candidates: 5, floored: 0, stage2Added: 0, callsRun: 0, callsFailed: 0,
      blocked: null, failures: [],
    };
    try {
      host.startRetrievalDegradationWatchdog({ observe: (_mechanism, decision) => { observations.push(decision); return true; } });
      search.observeLegs({ lexical: leg, semantic: { ...leg, candidates: 0, blocked: 'timeout' }, degraded: true, warning: 'semantic leg blocked' } as import('@papercusp/search').SearchLegs);
      search.observeLegs({ lexical: leg, semantic: leg, degraded: false, warning: null } as import('@papercusp/search').SearchLegs);
      expect(observations.map((row) => row.applied)).toEqual([0, 1]);
      return { route: 'observation', mechanism: 'retrieval', observations };
    } finally { search.setLegHealthObserver(null); }
  },
}, {
  id: 'rerank-device-failed-sticky-and-verified-gpu-construction', item: 'P-010', route: 'observation', mechanism: 'rerank-device',
  rowIds: ['log-only-fallback|libs/generic/rerank/src/local-engine.ts|reportDemotion|1'],
  run: async () => {
    const engine = await import('../../../../libs/generic/rerank/src/local-engine');
    const { vi, expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback: import('../../../../libs/generic/rerank/src/local-engine').LocalRerankOptions['observeFallback'] = (mechanism, decision) => {
      if (mechanism === 'rerank-device') observations.push(decision);
    };
    const loaded = { tokenizer: () => ({}), model: async () => ({ logits: { dims: [1, 1], data: [0] } }) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      engine._setLoaderForTest(async (_model, _dtype, device) => { if (device === 'cuda') throw new Error('GPU unavailable'); return loaded; });
      await engine.loadCrossEncoder({ model: 'first', device: 'cuda', dtype: 'fp16', observeFallback });
      await engine.loadCrossEncoder({ model: 'second', device: 'cuda', dtype: 'fp16', observeFallback });
      expect(observations.map((row) => row.applied)).toEqual([0, 0]);
      engine._setLoaderForTest(async () => loaded);
      await engine.loadCrossEncoder({ device: 'cuda', dtype: 'fp16', observeFallback });
      await engine.loadCrossEncoder({ device: 'cpu', dtype: 'q8', observeFallback });
      expect(observations.map((row) => row.applied)).toEqual([0, 0, 1]);
      expect(warn).toHaveBeenCalledTimes(1);
      return { route: 'observation', mechanism: 'rerank-device', observations };
    } finally { engine._setLoaderForTest(null); warn.mockRestore(); }
  },
}, {
  id: 'rerank-worker-repeated-fallback-before-cooldown-and-real-protocol-recovery', item: 'P-010', route: 'observation', mechanism: 'rerank-worker',
  rowIds: ['log-only-fallback|libs/generic/rerank/src/local-reranker-worker.ts|warnRerankFallback|1'],
  run: async () => {
    const engine = await import('../../../../libs/generic/rerank/src/local-engine');
    const worker = await import('../../../../libs/generic/rerank/src/local-reranker-worker');
    const { Worker } = await import('node:worker_threads');
    const { vi, expect } = await import('vitest');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const observeFallback: import('../../../../libs/generic/rerank/src/local-engine').LocalRerankOptions['observeFallback'] = (mechanism, decision) => {
      if (mechanism === 'rerank-worker') observations.push(decision);
      if (mechanism === 'rerank-device') deviceObservations.push(decision);
    };
    const deviceObservations: Array<{ eligible: number; applied: number; reason: string }> = [];
    let attempts = 0;
    const originalPost = Worker.prototype.postMessage;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: InstanceType<typeof Worker>, message, ...args) {
      if (message?.kind === 'score') {
        attempts++;
        expect(message.observeFallback).toBeUndefined(); // functions never cross the clone boundary
        queueMicrotask(() => {
          this.emit('message', { kind: 'device_decision', id: message.id,
            decision: { eligible: 1, applied: attempts < 3 ? 0 : 1, reason: attempts < 3 ? 'gpu-construction-failed' : 'applied' } });
          this.emit('message', attempts < 3
            ? { kind: 'score_err', id: message.id, error: 'unavailable' }
            : { kind: 'score_ok', id: message.id, scores: [0.75] });
        });
      } else { originalPost.call(this, message, ...args); }
    });
    try {
      await worker._resetRerankWorkerForTest(); worker._resetFallbackWarnForTest();
      engine._setLoaderForTest(async () => ({ tokenizer: () => ({}), model: async () => ({ logits: { dims: [1, 1], data: [0] } }) }));
      engine._setWorkerWithLoaderForTest(true);
      await engine.scoreCrossEncoder('query', ['document'], { device: 'cpu', dtype: 'q8', observeFallback });
      await engine.scoreCrossEncoder('query', ['document'], { device: 'cpu', dtype: 'q8', observeFallback });
      expect(observations.map((row) => row.applied)).toEqual([0, 0]);
      expect(await engine.scoreCrossEncoder('query', ['document'], { device: 'cpu', dtype: 'q8', observeFallback })).toEqual([0.75]);
      expect(observations.map((row) => row.applied)).toEqual([0, 0, 1]);
      expect(deviceObservations.map((row) => row.applied)).toEqual([0, 0, 1]);
      return { route: 'observation', mechanism: 'rerank-worker', observations };
    } finally {
      post.mockRestore(); await worker._resetRerankWorkerForTest(); worker._resetBeforeExitHookForTest();
      worker._resetFallbackWarnForTest(); engine._setLoaderForTest(null);
    }
  },
}, {
  id: 'embed-sidecar-crash-ready-handshake-and-idle-exclusion', item: 'P-010', route: 'observation', mechanism: 'embed-sidecar-respawn',
  rowIds: ['log-only-fallback|packages/operator-core/lib/memory/embed-sidecar-spawn.ts|scheduleRespawn|1'],
  run: async () => {
    const { vi, expect } = await import('vitest');
    const { EventEmitter } = await import('node:events');
    const watchdog = await import('../system-health/degradation-watchdog');
    const { summarizeFallbackWindow } = await import('./fallback-observations');
    const observations: Array<{ eligible: number; applied: number; reason: string }> = [];
    const children: Array<InstanceType<typeof EventEmitter> & { stdout: InstanceType<typeof EventEmitter> }> = [];
    vi.resetModules();
    vi.doMock('../degradation/fallback-observations', async (importOriginal) => ({
      ...await importOriginal<typeof import('./fallback-observations')>(),
      observeFallback: (mechanism: string, decision: { eligible: number; applied: number; reason: string }) => {
        if (mechanism === 'embed-sidecar-respawn') observations.push(decision);
        return true;
      },
    }));
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...await importOriginal<typeof import('node:child_process')>(),
      spawn: () => {
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill() { return true; } });
        children.push(child); return child;
      },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const savedPort = process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
    delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
    let producer: typeof import('../memory/embed-sidecar-spawn') | undefined;
    try {
      producer = await import('../memory/embed-sidecar-spawn');
      const protocol = await import('../memory/embed-sidecar-server');
      const ready = (port: number) => children.at(-1)!.stdout.emit('data', Buffer.from(`${protocol.EMBED_SIDECAR_READY_LINE} port=${port}\n`));
      const first = producer.spawnEmbedSidecar(); ready(41001); await first;
      observations.length = 0;
      children.at(-1)!.emit('exit', 1, null);
      expect(observations.map((row) => row.applied)).toEqual([0]);
      const verdict = () => watchdog.judgeDegradation(summarizeFallbackWindow('embed-sidecar-respawn', 60_000,
        observations.map((row) => ({ ...row, samples: 1 }))), { mechanism: 'embed-sidecar-respawn' },
        watchdog.getDegradationMechanism('embed-sidecar-respawn')!.thresholds);
      expect(verdict().kind).toBe('collapsed'); // sparse circuit must be actionable
      expect(warn).toHaveBeenCalledTimes(2); // actual death and respawn decision
      const second = producer.spawnEmbedSidecar(); ready(41002); await second;
      expect(observations.map((row) => row.applied)).toEqual([0, 1]);
      expect(verdict().kind).toBe('recovered');
      children.at(-1)!.stdout.emit('data', Buffer.from(`${protocol.EMBED_SIDECAR_IDLE_EXIT_LINE}\n`));
      children.at(-1)!.emit('exit', 0, null);
      expect(observations.map((row) => row.applied)).toEqual([0, 1]);
      return { route: 'observation', mechanism: 'embed-sidecar-respawn', observations };
    } finally {
      producer?._resetEmbedSidecarSpawnStateForTests();
      warn.mockRestore(); log.mockRestore();
      vi.doUnmock('node:child_process'); vi.doUnmock('../degradation/fallback-observations'); vi.resetModules();
      if (savedPort === undefined) delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT; else process.env.PAPERCUSP_EMBED_SIDECAR_PORT = savedPort;
    }
  },
});
