/**
 * reconcileLearningSingletons — EI-10625.
 *
 * THE BUG: adding a loop to LEARNING_SINGLETONS did not schedule it. The materializer had
 * one caller (a one-shot platform-mode enablement), so a loop registered afterwards got no
 * routine row and never ran — silently, with no error. The memory recall canary (EI-10047)
 * lived its entire life that way: 0 routine rows, 0 runs, on a 10,491-memory store it was
 * built to watch. `memory-precision` escaped only because someone happened to re-run a CLI.
 *
 * These tests PROVE THE DETECTOR CAN FIRE: they construct a declared-but-unmaterialized
 * loop and assert it is reported and healed. A test that merely checked "the reconciler
 * ran" is the exact blindness that let this sit dark.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

const h = vi.hoisted(() => ({
  platformOn: true,
  /** blueprintIds treated as Class-C platform-improvement loops (gated by platform mode). */
  platformLoops: new Set<string>(),
  materialized: [] as string[],
}));

vi.mock('@papercusp/orchestrator/blueprint', () => ({
  loadBuiltinBlueprint: (id: string) => ({ blueprint: { __id: id, triggers: { schedule: [{ singleton: true }] } } }),
}));
vi.mock('./materialize-triggers', () => ({
  // Mirror the real naming so the diff is exercised on realistic row names.
  triggerRoutineSpecs: (bp: { __id: string }) => [{ name: `bp-singleton-${bp.__id}-0`, singleton: true }],
  materializeBlueprintTriggers: async (id: string) => {
    h.materialized.push(id);
    return [{ hostSlug: '@singleton', name: `bp-singleton-${id}-0`, singleton: true }];
  },
  isPlatformImprovementLoop: (id: string) => h.platformLoops.has(id),
  platformImprovementLoopsEnabled: async () => h.platformOn,
  singletonRoutinePayloadDefaults: () => ({}),
  SINGLETON_TRIGGER_HOST_SLUG: '@singleton',
}));
vi.mock('@papercusp/flags', () => ({ FLAGS: { PLATFORM_IMPROVEMENT_LOOPS: 'platform_improvement_loops' } }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: undefined }) }));
vi.mock('../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercup' }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));

const { reconcileLearningSingletons, reconcileLearningSingletonsExitCode, seedExecuteTargetRefusal } = await import(
  './seed-learning-singletons'
);

describe('seedExecuteTargetRefusal — a write run must name its database (EI-25457697211948138)', () => {
  it('refuses --execute when DATABASE_URL is unset or blank', () => {
    expect(seedExecuteTargetRefusal(true, undefined)).toMatch(/explicit DATABASE_URL/);
    expect(seedExecuteTargetRefusal(true, '   ')).toMatch(/explicit DATABASE_URL/);
  });
  it('allows --execute with an explicit DATABASE_URL, and every dry run', () => {
    expect(seedExecuteTargetRefusal(true, 'postgres://u@localhost:5432/papercusp')).toBeNull();
    expect(seedExecuteTargetRefusal(false, undefined)).toBeNull();
  });
});

/** A fake `sql` returning the given @singleton routine rows for the one SELECT it makes. */
const sqlWithRows = (names: string[]): Sql =>
  (() => Promise.resolve(names.map((name) => ({ name })))) as unknown as Sql;

const PRECISION = { blueprintId: 'memory-precision', legacyRoutine: 'memory-precision-bench' };
const CANARY = { blueprintId: 'memory-live-recall-canary', legacyRoutine: 'memory-live-recall-canary' };

beforeEach(() => {
  h.platformOn = true;
  h.platformLoops = new Set();
  h.materialized = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('reconcileLearningSingletons — a declared loop with no routine row (EI-10625)', () => {
  it('returns a failing CLI status when check mode finds a missing declaration', () => {
    expect(reconcileLearningSingletonsExitCode(false, 1)).toBe(1);
    expect(reconcileLearningSingletonsExitCode(false, 0)).toBe(0);
    expect(reconcileLearningSingletonsExitCode(true, 1)).toBe(0);
  });

  it('FIRES: detects the loop that was declared but never materialized', async () => {
    // The live state exactly: memory-precision has a row (someone re-ran the CLI);
    // the canary, added afterwards, has none.
    const r = await reconcileLearningSingletons(sqlWithRows(['bp-singleton-memory-precision-0']), 'ws', {
      execute: false,
      loops: [PRECISION, CANARY],
    });

    expect(r.missing).toEqual(['memory-live-recall-canary']);
    expect(r.entries.find((e) => e.blueprintId === 'memory-precision')).toMatchObject({
      present: true,
      missing: false,
    });
    expect(r.entries.find((e) => e.blueprintId === 'memory-live-recall-canary')).toMatchObject({
      routineName: 'bp-singleton-memory-live-recall-canary-0',
      expected: true,
      present: false,
      missing: true,
    });
  });

  it('is LOUD about it even in read-only mode — silence is how this bug survived', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reconcileLearningSingletons(sqlWithRows([]), 'ws', { execute: false, loops: [CANARY] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NEVER MATERIALIZED'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('memory-live-recall-canary'));
  });

  it('writes NOTHING in read-only mode', async () => {
    await reconcileLearningSingletons(sqlWithRows([]), 'ws', { execute: false, loops: [CANARY] });
    expect(h.materialized).toEqual([]);
  });

  it('HEALS the missing loop when executing — and touches nothing that is already correct', async () => {
    const r = await reconcileLearningSingletons(sqlWithRows(['bp-singleton-memory-precision-0']), 'ws', {
      execute: true,
      loops: [PRECISION, CANARY],
    });
    expect(r.healed).toEqual(['memory-live-recall-canary']);
    expect(h.materialized).toEqual(['memory-live-recall-canary']); // NOT memory-precision
  });

  it('reports nothing to do when every declared loop already has its row', async () => {
    const r = await reconcileLearningSingletons(
      sqlWithRows(['bp-singleton-memory-precision-0', 'bp-singleton-memory-live-recall-canary-0']),
      'ws',
      { execute: true, loops: [PRECISION, CANARY] },
    );
    expect(r.missing).toEqual([]);
    expect(r.healed).toEqual([]);
    expect(h.materialized).toEqual([]);
  });

  it('does NOT flag a Class-C loop that is absent BY DESIGN (platform mode OFF)', async () => {
    // P-070: a public release with PLATFORM_IMPROVEMENT_LOOPS off never materializes these.
    // Alarming on them every release would be its own cry-wolf failure.
    h.platformOn = false;
    h.platformLoops = new Set(['memory-live-recall-canary']);

    const r = await reconcileLearningSingletons(sqlWithRows([]), 'ws', {
      execute: true,
      loops: [CANARY],
    });
    expect(r.entries[0]).toMatchObject({ expected: false, present: false, missing: false });
    expect(r.missing).toEqual([]);
    expect(h.materialized).toEqual([]); // and it must not be armed behind the owner's back
  });

  it('still flags a NON-platform (Class-B) loop when platform mode is off', async () => {
    // scout is the per-hive exception — the gate does not excuse its absence.
    h.platformOn = false;
    h.platformLoops = new Set(['memory-live-recall-canary']); // scout deliberately not in the set

    const r = await reconcileLearningSingletons(sqlWithRows([]), 'ws', {
      execute: false,
      loops: [{ blueprintId: 'scout', legacyRoutine: 'scout-cycle' }],
    });
    expect(r.missing).toEqual(['scout']);
  });
});
