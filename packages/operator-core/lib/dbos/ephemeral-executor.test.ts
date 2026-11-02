/**
 * ephemeral-executor — P-012 unit tests. Drives the executor over the
 * @papercusp/scheduled-registry configure-seam (a captured fake setInterval) so ticks fire
 * deterministically, with stub list/fire/recordFire deps. Proves: one managed timer per active
 * ephemeral routine (category 'ephemeral-harness'), the floor clamp, fire→liveness recording
 * (incl. the error path), event-driven sync/unarm, and disarm.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
const productionPolicy = vi.hoisted(() => ({
  allowed: vi.fn(async () => true),
  observed: vi.fn(async (_scope: unknown, invoke: () => Promise<unknown>) => invoke()),
}));
vi.mock('../device-operator-actions', async original => ({
  ...await original<typeof import('../device-operator-actions')>(),
  routineBackgroundActivityAllowed: productionPolicy.allowed,
}));
vi.mock('../startup-activity', async original => ({
  ...await original<typeof import('../startup-activity')>(),
  runObservedBackgroundActivity: productionPolicy.observed,
}));
import {
  configureScheduledRegistry,
  resetScheduledRegistry,
  listManaged,
  getManaged,
} from '@papercusp/scheduled-registry';
import {
  armEphemeralExecutor,
  disarmEphemeralExecutor,
  ephemeralExecutorArmed,
  armedEphemeralIds,
  refreshEphemeralExecutor,
  syncEphemeralRoutine,
  unarmEphemeralRoutine,
  productionEphemeralExecutorDeps,
  type EphemeralExecutorDeps,
  type EphemeralRoutineSpec,
} from './ephemeral-executor';
import { registerSystemAction } from '../harness/routines/system-actions';
import { startupActivityFeatureId } from '../schedule-inventory';

const spec = (over: Partial<EphemeralRoutineSpec> = {}): EphemeralRoutineSpec => ({
  id: 'r1',
  workspaceId: 'ws',
  installSlug: 'papercup',
  name: 'sweep',
  targetRole: 'system:foo',
  intervalSec: 5,
  payloadTemplate: null,
  triggerConfig: { interval_sec: 5 },
  ...over,
});

// Captured registry ticks (the registry's makeTick wrapper + the intervalMs it was armed with).
let ticks: Array<{ cb: () => void; ms: number }>;
function installFakeRegistry(): void {
  ticks = [];
  configureScheduledRegistry({
    setIntervalImpl: (cb, ms) => {
      ticks.push({ cb, ms });
      return { unref() {} };
    },
    clearIntervalImpl: () => {},
    // fireOnArm uses setTimeout(0); the executor doesn't set fireOnArm, but stub it anyway.
    setTimeoutImpl: () => ({ unref() {} }),
  });
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('execution policy at an armed ephemeral timer', () => {
  it('rechecks after production action resolution, observes only an invoked action and preserves its result', async () => {
    productionPolicy.allowed.mockReset().mockResolvedValue(true);
    productionPolicy.observed.mockClear();
    const action = vi.fn(async () => ({ diagnostics: { invoked: true } }));
    registerSystemAction('ephemeral-history-test', action, { scheduling: 'on-demand' });
    const routine = spec({ targetRole: 'system:ephemeral-history-test' });
    const deps = productionEphemeralExecutorDeps();
    productionPolicy.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(deps.fire(routine)).resolves.toEqual({ diagnostics: { backgroundActivityWithheld: true } });
    expect(action).not.toHaveBeenCalled();
    expect(productionPolicy.observed).not.toHaveBeenCalled();
    await expect(deps.fire(routine)).resolves.toEqual({ diagnostics: { invoked: true } });
    expect(action).toHaveBeenCalledOnce();
    expect(productionPolicy.observed).toHaveBeenCalledWith({ workspaceId: routine.workspaceId,
      featureId: startupActivityFeatureId({ source: 'routines', installSlug: routine.installSlug, name: routine.name, detail: {} }, { workspaceId: routine.workspaceId }),
      source: 'routine', trigger: 'timer',
    }, expect.any(Function));
  });

  it('binds the managed timer to the routine inventory identity in its own workspace', async () => {
    installFakeRegistry();
    const item = spec();
    await armEphemeralExecutor(mkDeps().deps);
    expect(getManaged('ephemeral:r1')?.activity).toEqual({
      kind: 'workspace', workspaceId: item.workspaceId,
      featureId: startupActivityFeatureId({ source: 'routines', installSlug: item.installSlug, name: item.name, detail: {} }, { workspaceId: item.workspaceId }),
    });
  });

  it('uses the registered control purpose rather than the timer category or routine name', async () => {
    installFakeRegistry();
    registerSystemAction('ephemeral-admission-recovery-test', async () => {}, { requiredForControl: 'Restores the control channel.' });
    await armEphemeralExecutor(mkDeps({ list: async () => [spec({ targetRole: 'system:ephemeral-admission-recovery-test' })] }).deps);
    expect(getManaged('ephemeral:r1')?.activity).toEqual({ kind: 'required-control', reason: 'Restores the control channel.' });
  });

  it('withholds without recording a fire, then permits the next tick after resume', async () => {
    installFakeRegistry();
    let allowed = false;
    const { deps, fired, recorded } = mkDeps({ admit: async () => allowed });
    await armEphemeralExecutor(deps);
    ticks[0]!.cb();
    await flush();
    expect(fired).toEqual([]);
    expect(recorded).toEqual([]);
    allowed = true;
    ticks[0]!.cb();
    await flush();
    expect(fired).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });

  it('does not dispatch after stop while permission is still pending', async () => {
    installFakeRegistry();
    let admit!: (allowed: boolean) => void;
    const { deps, fired, recorded } = mkDeps({ admit: () => new Promise(resolve => { admit = resolve; }) });
    await armEphemeralExecutor(deps);
    ticks[0]!.cb();
    await flush();
    disarmEphemeralExecutor();
    admit(true);
    await flush();
    expect(fired).toEqual([]);
    expect(recorded).toEqual([]);
  });
});

const mkDeps = (over: Partial<EphemeralExecutorDeps> = {}): { deps: EphemeralExecutorDeps; fired: EphemeralRoutineSpec[]; recorded: Array<{ id: string; error: string | null }> } => {
  const fired: EphemeralRoutineSpec[] = [];
  const recorded: Array<{ id: string; error: string | null }> = [];
  const deps: EphemeralExecutorDeps = {
    list: async () => [spec()],
    fire: async (r) => {
      fired.push(r);
    },
    recordFire: async (r, error) => {
      recorded.push({ id: r.id, error });
    },
    log: () => {},
    ...over,
  };
  return { deps, fired, recorded };
};

afterEach(() => {
  disarmEphemeralExecutor();
  resetScheduledRegistry();
});

describe('armEphemeralExecutor', () => {
  it('recovers catalog initialization after database failures without restarting the host', async () => {
    installFakeRegistry();
    let reads = 0;
    const { deps, fired, recorded } = mkDeps({
      list: async () => {
        if (++reads < 3) throw new Error('CONNECT_TIMEOUT');
        return [spec()];
      },
    });
    await armEphemeralExecutor(deps);
    expect(armedEphemeralIds()).toEqual([]);
    const recovery = ticks.find((tick) => tick.ms === 30_000)!;
    expect(recovery).toBeTruthy();
    recovery.cb();
    await flush();
    expect(armedEphemeralIds()).toEqual([]);
    recovery.cb();
    await flush();
    expect(armedEphemeralIds()).toEqual(['r1']);
    ticks.find((tick) => tick.ms === 5_000)!.cb();
    await flush();
    expect(fired.map((row) => row.id)).toEqual(['r1']);
    expect(recorded).toEqual([{ id: 'r1', error: null }]);
    expect(getManaged('ephemeral-executor-heartbeat')).toBeUndefined();
  });

  it('arms ONE managed timer per active ephemeral routine (category ephemeral-harness)', async () => {
    installFakeRegistry();
    const { deps } = mkDeps({ list: async () => [spec({ id: 'a' }), spec({ id: 'b' })] });
    await armEphemeralExecutor(deps);
    expect(ephemeralExecutorArmed()).toBe(true);
    expect(armedEphemeralIds().sort()).toEqual(['a', 'b']);
    // Scope to the category this test owns. `listManaged()` is a PROCESS-GLOBAL registry, so
    // asserting it equals exactly this test's two entries also asserts that nothing else in
    // the process ever armed a managed timer — which is not this test's claim (the case name
    // says "category ephemeral-harness") and is not true under fork reuse. Under `isolate:
    // true` a fresh process per file made it accidentally hold; under the P-003 pure lane's
    // `isolate: false` sibling files' module-scope timers (config-refresh:*,
    // hyperbee-merge-poll) are already registered and the assertion read 6 entries
    // (plan gate-suite-speedup-2026-08-12, D-034). Filtering keeps the real claim — ONE timer
    // per active ephemeral routine — and stops it depending on process-global emptiness.
    const names = listManaged()
      .filter((e) => e.category === 'ephemeral-harness')
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(['ephemeral:a', 'ephemeral:b']);
    expect(getManaged('ephemeral:a')?.category).toBe('ephemeral-harness');
    expect(getManaged('ephemeral:a')?.shed).toBe(true);
  });

  it('is idempotent — a second arm is a no-op', async () => {
    installFakeRegistry();
    const { deps } = mkDeps();
    await armEphemeralExecutor(deps);
    const firstCount = ticks.length;
    await armEphemeralExecutor(deps);
    expect(ticks.length).toBe(firstCount); // no new timers
  });

  it('clamps a sub-floor interval up to the 1s floor; passes a normal cadence through', async () => {
    installFakeRegistry();
    const { deps } = mkDeps({ list: async () => [spec({ id: 'tiny', intervalSec: 0.4 }), spec({ id: 'norm', intervalSec: 5 })] });
    await armEphemeralExecutor(deps);
    expect(ticks.find((t) => t.ms === 1000)).toBeTruthy(); // tiny (0.4s) clamped up to the 1000ms floor
    expect(ticks.find((t) => t.ms === 5000)).toBeTruthy(); // norm (5s) passes through
  });
});

describe('tick → fire + durable liveness', () => {
  it('a tick fires the action then records liveness (no error on success)', async () => {
    installFakeRegistry();
    const { deps, fired, recorded } = mkDeps();
    await armEphemeralExecutor(deps);
    ticks[0].cb(); // simulate the interval firing
    await flush();
    expect(fired.map((f) => f.id)).toEqual(['r1']);
    expect(recorded).toEqual([{ id: 'r1', error: null }]);
  });

  it('records the error when the action throws (liveness still updates — never crashes the tick)', async () => {
    installFakeRegistry();
    const { deps, recorded } = mkDeps({
      fire: async () => {
        throw new Error('boom');
      },
    });
    await armEphemeralExecutor(deps);
    ticks[0].cb();
    await flush();
    expect(recorded).toEqual([{ id: 'r1', error: 'boom' }]);
  });

  // WI-10005164: a fail-soft sub-pass failure must reach last_error. task-reconcile is an
  // ephemeral routine, and its swallowed lifecycle-sweep error left last_error empty for a day.
  it('records a returned softError as the fire error (the action did not throw)', async () => {
    installFakeRegistry();
    const { deps, recorded } = mkDeps({
      fire: async () => ({ softError: 'task-lifecycle sub-pass failing (1x since 2026-10-01T00:00:00.000Z): 42703' }),
    });
    await armEphemeralExecutor(deps);
    ticks[0].cb();
    await flush();
    expect(recorded).toEqual([
      { id: 'r1', error: 'task-lifecycle sub-pass failing (1x since 2026-10-01T00:00:00.000Z): 42703' },
    ]);
  });

  it('control: a returned result without softError records a clean fire', async () => {
    installFakeRegistry();
    const { deps, recorded } = mkDeps({ fire: async () => ({ diagnostics: { ok: true } }) });
    await armEphemeralExecutor(deps);
    ticks[0].cb();
    await flush();
    expect(recorded).toEqual([{ id: 'r1', error: null }]);
  });
});

describe('event-driven sync / unarm / disarm', () => {
  it('diff-refresh re-arms only changed/added rows and disarms removed rows', async () => {
    installFakeRegistry();
    let rows = [spec({ id: 'a', intervalSec: 5, triggerConfig: { interval_sec: 5 } })];
    const { deps } = mkDeps({ list: async () => rows });
    await armEphemeralExecutor(deps);
    expect(ticks).toHaveLength(1);

    expect(await refreshEphemeralExecutor()).toEqual({ synced: 0, unarmed: 0 });
    expect(ticks).toHaveLength(1); // unchanged timer kept its original deadline

    rows = [
      spec({ id: 'a', intervalSec: 60, triggerConfig: { interval_sec: 60 } }),
      spec({ id: 'b', intervalSec: 7, triggerConfig: { interval_sec: 7 } }),
    ];
    expect(await refreshEphemeralExecutor()).toEqual({ synced: 2, unarmed: 0 });
    expect(armedEphemeralIds().sort()).toEqual(['a', 'b']);
    expect(ticks.slice(-2).map((tick) => tick.ms).sort((a, b) => a - b)).toEqual([7_000, 60_000]);

    rows = [spec({ id: 'b', intervalSec: 7, triggerConfig: { interval_sec: 7 } })];
    expect(await refreshEphemeralExecutor()).toEqual({ synced: 0, unarmed: 1 });
    expect(armedEphemeralIds()).toEqual(['b']);
  });

  it('syncEphemeralRoutine re-arms one routine in place; unarmEphemeralRoutine drops it', async () => {
    installFakeRegistry();
    const { deps } = mkDeps({ list: async () => [spec({ id: 'a' })] });
    await armEphemeralExecutor(deps);
    expect(armedEphemeralIds()).toEqual(['a']);

    syncEphemeralRoutine(spec({ id: 'b' }));
    expect(armedEphemeralIds().sort()).toEqual(['a', 'b']);

    unarmEphemeralRoutine('a');
    expect(armedEphemeralIds()).toEqual(['b']);
    expect(listManaged().some((e) => e.name === 'ephemeral:a')).toBe(false);
  });

  it('disarm stops every timer + deregisters from the inventory', async () => {
    installFakeRegistry();
    const { deps } = mkDeps({ list: async () => [spec({ id: 'a' }), spec({ id: 'b' })] });
    await armEphemeralExecutor(deps);
    disarmEphemeralExecutor();
    expect(ephemeralExecutorArmed()).toBe(false);
    expect(armedEphemeralIds()).toEqual([]);
    expect(listManaged().some((e) => e.name.startsWith('ephemeral:'))).toBe(false);
  });

  it('syncEphemeralRoutine is a no-op when the executor is not armed on this host', () => {
    installFakeRegistry();
    expect(ephemeralExecutorArmed()).toBe(false);
    syncEphemeralRoutine(spec({ id: 'x' }));
    expect(ephemeralExecutorArmed()).toBe(false);
    expect(armedEphemeralIds()).toEqual([]);
  });
});
