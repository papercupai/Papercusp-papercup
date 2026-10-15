/**
 * scout-cycle-action.test.ts — Scout P-008 system:scout-cycle action.
 * Pins: payload-config parsing, the self-gated handler (fires+persists vs no-op),
 * and registration into the routines system-action registry. The deps-builder is
 * faked so the handler runs with no PG (the runScoutTick core is covered in
 * scheduler.test.ts).
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  parseScoutCycleConfig,
  makeScoutCycleAction,
  registerScoutCycleAction,
  SCOUT_CYCLE_ACTION,
  type ScoutTickDepsBuilder,
} from './scout-cycle-action';
import { listSystemActions, getSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import type { ScoutCadenceState } from './cadence';

// P-015 (domain-generic-hive-architecture-2026-06-18): the handler reads the hive's
// settings-resident scout delta (hive_settings.localBlueprint.scout) to layer onto the
// tick payload. Mock it so the merge is testable + the other tests stay PG-free (a
// bare vi.fn() returns undefined ⇒ no delta ⇒ payload unchanged ⇒ behavior-neutral).
vi.mock('../hive-settings-store', () => ({ getHiveLocalBlueprintConfig: vi.fn() }));
import { getHiveLocalBlueprintConfig } from '../hive-settings-store';
const mockGetHiveScoutCfg = getHiveLocalBlueprintConfig as unknown as ReturnType<typeof vi.fn>;

const { isWorkspaceCoordinationOn } = vi.hoisted(() => ({
  isWorkspaceCoordinationOn: vi.fn(async () => false),
}));
vi.mock('../workspace-brain-scope', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isWorkspaceCoordinationOn };
});

const NOW = Date.parse('2026-06-08T12:00:00Z');
const ctx: SystemActionCtx = { installSlug: 'papercup', workspaceId: 'w', triggerConfig: {}, payloadTemplate: null };

beforeEach(() => {
  isWorkspaceCoordinationOn.mockReset().mockResolvedValue(false);
});

describe('parseScoutCycleConfig', () => {
  it('extracts cadence + budget objects', () => {
    expect(parseScoutCycleConfig({ cadence: { minIntervalSec: 100 }, budget: { maxCostUsd: 2 } })).toEqual({
      cadence: { minIntervalSec: 100 },
      budget: { maxCostUsd: 2 },
    });
  });
  it('null / non-object / wrong-typed fields → {}', () => {
    expect(parseScoutCycleConfig(null)).toEqual({});
    expect(parseScoutCycleConfig({ cadence: 'nope', budget: 5 })).toEqual({});
    expect(parseScoutCycleConfig({ cadence: [1, 2] })).toEqual({});
  });
});

describe('makeScoutCycleAction', () => {
  function fakeBuilder(
    state: Partial<ScoutCadenceState>,
    calls: { ran: number; persisted: number },
  ): ScoutTickDepsBuilder {
    return (depsCtx, runCycle) => ({
      readCadenceState: async () => ({ idleRatio: 0, frictionSignals: 0, lastRunAtMs: null, nowMs: NOW, ...state }),
      runCycle: async ({ budget, cycleId }) => {
        calls.ran += 1;
        return runCycle({ harnessSlug: depsCtx.installSlug, workspaceId: depsCtx.workspaceId, budget, cycleId });
      },
      persistRouted: async () => {
        calls.persisted += 1;
      },
      recordFire: async () => {},
      refreshOutcomes: async () => {},
      newCycleId: () => 'cyc',
    });
  }

  it('fires + persists when the gate says fire (idle)', async () => {
    const calls = { ran: 0, persisted: 0 };
    const runCycle = async () => ({
      provenance: [{ ideaId: 'i', lens: 'analogical' as const, rail: 'gym' as const, routedRef: 'gym:1' }],
      costUsd: 0.1,
    });
    const handler = makeScoutCycleAction(runCycle, fakeBuilder({ idleRatio: 1 }, calls));
    await handler(ctx);
    expect(calls.ran).toBe(1);
    expect(calls.persisted).toBe(1);
  });

  it('no-ops (no cycle, no persist) when the cadence gate withholds', async () => {
    const calls = { ran: 0, persisted: 0 };
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [] }),
      fakeBuilder({ idleRatio: 0, lastRunAtMs: NOW - 60_000 }, calls),
    );
    await handler({ ...ctx, payloadTemplate: { cadence: { minIntervalSec: 3600 } } });
    expect(calls.ran).toBe(0);
    expect(calls.persisted).toBe(0);
  });

  // FB-01 (self-learning-frontier P-003): the learning-governor hook.
  it('reports a fired cycle (cost + cycleId) and the resolved per-cycle cap to the governor', async () => {
    const calls = { ran: 0, persisted: 0 };
    const gov: unknown[] = [];
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [], costUsd: 0.25 }),
      fakeBuilder({ idleRatio: 1 }, calls),
      async (input) => (gov.push(input), { applied: true as const }),
    );
    await handler({ ...ctx, payloadTemplate: { budget: { maxCostUsd: 2 } } });
    expect(gov).toEqual([
      { workspaceId: 'w', harnessSlug: 'papercup', perCycleBudgetUsd: 2, fired: { costUsd: 0.25, cycleId: 'cyc' } },
    ]);
  });

  it('reports fired:null to the governor on a withheld tick (mirror only)', async () => {
    const calls = { ran: 0, persisted: 0 };
    const gov: Array<{ fired?: unknown }> = [];
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [] }),
      fakeBuilder({ idleRatio: 0, lastRunAtMs: NOW - 60_000 }, calls),
      async (input) => (gov.push(input), { applied: true as const }),
    );
    await handler({ ...ctx, payloadTemplate: { cadence: { minIntervalSec: 3600 } } });
    expect(gov).toHaveLength(1);
    expect(gov[0].fired).toBeNull();
  });

  // Per-hive-learning-loops-2026-06-14 P-031: a per-hive scout routine fires under
  // the HIVE'S OWN install_slug (provisionHiveLearningLoop seeds it that way), so the
  // cycle is hive-scoped end-to-end: the install_slug flows to the cycle runner AS the
  // harnessSlug (→ per-hive lens weights P-011 + per-hive routing), and the per-cycle
  // budget comes from THAT routine's payload_template, mirrored to scout:<hive>.
  it('is hive-scoped end-to-end: install_slug → cycle runner harnessSlug + per-hive budget → scout:<hive> governor mirror', async () => {
    const calls = { ran: 0, persisted: 0 };
    const cycleScopes: Array<{ harnessSlug: string; workspaceId: string; maxCostUsd?: number }> = [];
    const gov: Array<{ harnessSlug: string; perCycleBudgetUsd: number }> = [];
    const runCycle: import('./scout-cycle-action').ScoutCycleRunner = async ({ harnessSlug, workspaceId, budget }) => {
      cycleScopes.push({ harnessSlug, workspaceId, maxCostUsd: budget.maxCostUsd });
      return { provenance: [], costUsd: 0.3 };
    };
    const handler = makeScoutCycleAction(
      runCycle,
      fakeBuilder({ idleRatio: 1 }, calls),
      async (input) => (
        gov.push({ harnessSlug: input.harnessSlug, perCycleBudgetUsd: input.perCycleBudgetUsd }),
        { applied: true as const }
      ),
    );
    // The per-hive routine ctx: install_slug is the HIVE slug, payload carries the per-hive cap.
    await handler({
      installSlug: 'hive-acme',
      workspaceId: 'w',
      triggerConfig: {},
      payloadTemplate: { budget: { maxCostUsd: 0.75 } },
    });
    expect(calls.ran).toBe(1);
    // The cycle runner was invoked scoped to the HIVE (its slug is the harnessSlug — drives per-hive lenses + routing).
    expect(cycleScopes).toEqual([{ harnessSlug: 'hive-acme', workspaceId: 'w', maxCostUsd: 0.75 }]);
    // The governor sub-budget is keyed per-hive (scout:hive-acme) at the per-hive cap.
    expect(gov).toEqual([{ harnessSlug: 'hive-acme', perCycleBudgetUsd: 0.75 }]);
  });

  it('two hives run independently scoped — each cycle + governor mirror carries its OWN slug and budget (P-031)', async () => {
    const govByHive: Record<string, number> = {};
    const cycleByHive: Record<string, number | undefined> = {};
    const handlerFor = (calls: { ran: number; persisted: number }) =>
      makeScoutCycleAction(
        async ({ harnessSlug, budget }) => (
          (cycleByHive[harnessSlug] = budget.maxCostUsd),
          { provenance: [], costUsd: 0.1 }
        ),
        fakeBuilder({ idleRatio: 1 }, calls),
        async (input) => ((govByHive[input.harnessSlug] = input.perCycleBudgetUsd), { applied: true as const }),
      );
    await handlerFor({ ran: 0, persisted: 0 })({
      installSlug: 'hive-acme',
      workspaceId: 'w',
      triggerConfig: {},
      payloadTemplate: { budget: { maxCostUsd: 0.5 } },
    });
    await handlerFor({ ran: 0, persisted: 0 })({
      installSlug: 'hive-beta',
      workspaceId: 'w',
      triggerConfig: {},
      payloadTemplate: { budget: { maxCostUsd: 2 } },
    });
    // Each hive's cycle + governor mirror carried its OWN slug + payload budget — no cross-hive bleed.
    expect(cycleByHive).toEqual({ 'hive-acme': 0.5, 'hive-beta': 2 });
    expect(govByHive).toEqual({ 'hive-acme': 0.5, 'hive-beta': 2 });
  });

  it('stays hermetic (no governor IO) when no recorder is wired — the unit-test contract', async () => {
    const calls = { ran: 0, persisted: 0 };
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [], costUsd: 0.1 }),
      fakeBuilder({ idleRatio: 1 }, calls),
    );
    await handler(ctx); // would attempt the live admin pool if a default glue existed
    expect(calls.ran).toBe(1);
  });

  // P-051 (D-005): the WORKSPACE-WIDE scout spend ceiling preflight — consulted
  // BEFORE the tick; when it refuses, the cycle is short-circuited as a no-op.
  it('REFUSES the cycle when the workspace ceiling gate denies — no cycle runs (P-051)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = { ran: 0, persisted: 0 };
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [], costUsd: 0.1 }),
      fakeBuilder({ idleRatio: 1 }, calls), // cadence WOULD fire — but the ceiling overrides
      undefined,
      async () => ({
        allow: false,
        reason: 'workspace-ceiling-exceeded' as const,
        totalScoutSpentUsd: 12,
        ceilingUsd: 10,
        remainingUsd: -2,
        scoutLoopCount: 3,
      }),
    );
    await handler(ctx);
    expect(calls.ran).toBe(0); // the cycle never fanned out
    expect(calls.persisted).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workspace-wide scout spend ceiling'));
    warn.mockRestore();
  });

  it('PROCEEDS normally when the workspace ceiling gate allows (P-051)', async () => {
    const calls = { ran: 0, persisted: 0 };
    const runCycle = async () => ({
      provenance: [{ ideaId: 'i', lens: 'analogical' as const, rail: 'gym' as const, routedRef: 'gym:1' }],
      costUsd: 0.1,
    });
    const handler = makeScoutCycleAction(runCycle, fakeBuilder({ idleRatio: 1 }, calls), undefined, async () => ({
      allow: true,
      totalScoutSpentUsd: 3,
      ceilingUsd: 10,
      remainingUsd: 7,
      scoutLoopCount: 2,
    }));
    await handler(ctx);
    expect(calls.ran).toBe(1); // under the ceiling ⇒ the cycle fires
    expect(calls.persisted).toBe(1);
  });

  it('caps the live cycle ideator fan-out from P-005 queue pressure and restores it when drained (P-010)', async () => {
    const observed: number[] = [];
    const calls = { ran: 0, persisted: 0 };
    const handler = makeScoutCycleAction(
      async ({ budget }) => {
        observed.push(budget.maxIdeators);
        return { provenance: [], costUsd: 0.1 };
      },
      fakeBuilder({ idleRatio: 1 }, calls),
      undefined,
      undefined,
      // ELEVATED curbs the fan-out; DEEP skips paid generation entirely
      // (WI-10007380 / P-003, covered in run.test.ts).
      async () => ({
        source: 'p005-queue-health',
        level: 'elevated',
        pending: 21,
        latencySampleSize: 0,
        p95Ms: null,
        maxIdeators: 1,
        reasons: ['elevated queue'],
      }),
    );
    await handler({ ...ctx, payloadTemplate: { budget: { maxIdeators: 6 } } });

    const drained = makeScoutCycleAction(
      async ({ budget }) => {
        observed.push(budget.maxIdeators);
        return { provenance: [], costUsd: 0.1 };
      },
      fakeBuilder({ idleRatio: 1 }, { ran: 0, persisted: 0 }),
      undefined,
      undefined,
      async () => ({
        source: 'p005-queue-health',
        level: 'normal',
        pending: 0,
        latencySampleSize: 0,
        p95Ms: null,
        maxIdeators: null,
        reasons: ['drained'],
      }),
    );
    await drained({ ...ctx, payloadTemplate: { budget: { maxIdeators: 6 } } });

    expect(observed).toEqual([1, 6]);
  });

  it('reads workspace-wide queue pressure when the routine uses workspace coordination (D-019)', async () => {
    isWorkspaceCoordinationOn.mockResolvedValueOnce(true);
    const admissionScopes: Array<{ workspaceId: string; harnessSlug?: string }> = [];
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [], costUsd: 0.1 }),
      fakeBuilder({ idleRatio: 1 }, { ran: 0, persisted: 0 }),
      undefined,
      undefined,
      async (input) => {
        admissionScopes.push(input);
        return {
          source: 'p005-queue-health',
          level: 'normal',
          pending: 17,
          latencySampleSize: 0,
          p95Ms: null,
          maxIdeators: null,
          reasons: ['normal workspace queue'],
        };
      },
    );
    await handler({ ...ctx, installSlug: 'w' });
    expect(admissionScopes).toEqual([{ workspaceId: 'w' }]);
  });

  it('a refused cycle still MIRRORS the per-cycle cap (fired:null) to the governor (P-051)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = { ran: 0, persisted: 0 };
    const gov: Array<{ harnessSlug: string; perCycleBudgetUsd: number; fired: unknown }> = [];
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [], costUsd: 0.1 }),
      fakeBuilder({ idleRatio: 1 }, calls),
      async (input) => (
        gov.push({ harnessSlug: input.harnessSlug, perCycleBudgetUsd: input.perCycleBudgetUsd, fired: input.fired }),
        { applied: true as const }
      ),
      async () => ({
        allow: false,
        reason: 'workspace-ceiling-exceeded' as const,
        totalScoutSpentUsd: 99,
        ceilingUsd: 10,
        remainingUsd: -89,
        scoutLoopCount: 5,
      }),
    );
    await handler({ ...ctx, payloadTemplate: { budget: { maxCostUsd: 0.5 } } });
    expect(calls.ran).toBe(0);
    // The held cycle still keeps the governor sub-budget current (fired:null).
    expect(gov).toEqual([{ harnessSlug: 'papercup', perCycleBudgetUsd: 0.5, fired: null }]);
    warn.mockRestore();
  });

  // P-015 (D-005): the per-hive STRUCTURED scout delta (hive_settings.localBlueprint.scout)
  // is layered onto the tick payload's `scout` block so the editor in
  // /settings/pot-customization actually reaches the scout cycle (run.ts reads
  // payload.scout). install_slug is the hive home slug here (per provision-learning-loop).
  it('layers the pot config delta onto the tick payload (P-015 / WI-1664060)', async () => {
    const resolveConfigDelta = vi.fn(async () => ({
      scout: { buckets: { maxMoonshots: 2 }, lenses: ['inversion'] },
    }));
    let captured: unknown;
    const capturingBuilder: ScoutTickDepsBuilder = (depsCtx, runCycle) => {
      captured = depsCtx.payloadTemplate;
      return fakeBuilder({ idleRatio: 1 }, { ran: 0, persisted: 0 })(depsCtx, runCycle);
    };
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [], costUsd: 0.1 }),
      capturingBuilder,
      undefined,
      undefined,
      undefined,
      undefined,
      resolveConfigDelta,
    );
    await handler({
      installSlug: 'hive-acme',
      workspaceId: 'w',
      triggerConfig: {},
      payloadTemplate: { budget: { maxCostUsd: 0.5 } },
    });
    // The action FORWARDS the seam; runScoutCycleTick performs the merge. Asserting
    // the scope it forwards is what pins the workspace/install pair the production
    // resolver reads hive_settings under.
    expect(resolveConfigDelta).toHaveBeenCalledWith({ workspaceId: 'w', installSlug: 'hive-acme' });
    // The delta is merged UNDER `scout`, preserving the routine's existing `budget` block.
    expect(captured).toEqual({
      budget: { maxCostUsd: 0.5 },
      scout: { buckets: { maxMoonshots: 2 }, lenses: ['inversion'] },
    });
  });

  it('leaves the tick payload unchanged when no pot config delta is set (P-015 behavior-neutral)', async () => {
    const resolveConfigDelta = vi.fn(async () => null);
    let captured: unknown;
    const capturingBuilder: ScoutTickDepsBuilder = (depsCtx, runCycle) => {
      captured = depsCtx.payloadTemplate;
      return fakeBuilder({ idleRatio: 1 }, { ran: 0, persisted: 0 })(depsCtx, runCycle);
    };
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [], costUsd: 0.1 }),
      capturingBuilder,
      undefined,
      undefined,
      undefined,
      undefined,
      resolveConfigDelta,
    );
    await handler({
      installSlug: 'hive-acme',
      workspaceId: 'w',
      triggerConfig: {},
      payloadTemplate: { budget: { maxCostUsd: 0.5 } },
    });
    expect(captured).toEqual({ budget: { maxCostUsd: 0.5 } });
  });

  /*
   * WI-1664060 REGRESSION CONTROL. The bug was not that the merge was wrong — it
   * was that the merge lived in THIS action's body, so Scout's other entrypoint
   * (the `blender:cycle` op, the path that actually runs in production) never did
   * it. An assertion that the action layers correctly therefore cannot detect the
   * defect; only "the action does not resolve config on its own" can.
   *
   * If someone re-adds a hive_settings read here, the seam stops being the single
   * merge site and the two entrypoints can silently diverge again — so this fails.
   */
  it('does NOT read pot config itself — the shared tick owns the one merge site', async () => {
    mockGetHiveScoutCfg.mockClear();
    const calls = { ran: 0, persisted: 0 };
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [], costUsd: 0.1 }),
      fakeBuilder({ idleRatio: 1 }, calls),
    );
    await handler({
      installSlug: 'hive-acme',
      workspaceId: 'w',
      triggerConfig: {},
      payloadTemplate: { budget: { maxCostUsd: 0.5 } },
    });
    // POSITIVE CONTROL, without which the assertion below is vacuous: a handler
    // that threw or returned early would also never call the store, and would pass
    // a bare not-to-have-been-called check while proving nothing. This pins that
    // the action ran all the way THROUGH the point where the read used to sit.
    expect(calls.ran).toBe(1);
    expect(mockGetHiveScoutCfg).not.toHaveBeenCalled();
  });

  /**
   * WI-1728261 — P-019's cross-node single-runner gate is the FOURTH seam this action
   * and the `blender:cycle` blueprint op disagreed about, and the first in the OTHER
   * direction: the blueprint op has wired it since 2026-06-19 while this factory never
   * had the parameter at all, so `if (deps.hiveRunnerGate)` in run.ts silently skipped
   * the gate and every node of a shared Hive ran its own scout loop.
   *
   * `runScoutCycleTick`'s own consumption of the gate is covered separately below;
   * THESE pin that the action actually THREADS the seam through — the half that was
   * missing. The structural guarantee the two entry points cannot drift again is
   * `lint:deps-wiring-parity`, not a test.
   */
  it('stands down without running a cycle when the node is NOT the elected Hive runner (WI-1728261)', async () => {
    const calls = { ran: 0, persisted: 0 };
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [], costUsd: 0.1 }),
      fakeBuilder({ idleRatio: 1 }, calls), // cadence WOULD fire — the gate overrides
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => ({ run: false, reason: 'not-hive-runner' }),
    );
    await handler(ctx);
    expect(calls.ran).toBe(0);
    expect(calls.persisted).toBe(0);
  });

  // THE POSITIVE CONTROL for the assertion above. Without it `calls.ran === 0` also
  // passes when the handler bails early for any unrelated reason — a vacuous test that
  // would keep passing if the seam were never threaded at all (which is the very bug).
  it('runs the cycle when the SAME fixture reports this node IS the elected runner (WI-1728261)', async () => {
    const calls = { ran: 0, persisted: 0 };
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [], costUsd: 0.1 }),
      fakeBuilder({ idleRatio: 1 }, calls),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => ({ run: true, reason: 'authority' }),
    );
    await handler(ctx);
    expect(calls.ran).toBe(1);
  });

  it('unwired ⇒ no gate — the PG-free factory contract the other seams also keep (WI-1728261)', async () => {
    const calls = { ran: 0, persisted: 0 };
    const handler = makeScoutCycleAction(
      async () => ({ provenance: [], costUsd: 0.1 }),
      fakeBuilder({ idleRatio: 1 }, calls),
    );
    await handler(ctx);
    expect(calls.ran).toBe(1);
  });
});

describe('registerScoutCycleAction', () => {
  it('registers system:scout-cycle in the routines registry', () => {
    registerScoutCycleAction(async () => ({ provenance: [] }));
    expect(listSystemActions()).toContain(SCOUT_CYCLE_ACTION);
    expect(getSystemAction(SCOUT_CYCLE_ACTION)).toBeTypeOf('function');
  });
});

// P-019 (domain-generic-hive-architecture): the cross-node single-runner gate is a
// PREFLIGHT in runScoutCycleTick — consulted before cadence/budget/ceiling so a
// SHARED-Hive node that is not the elected per-Hive runner does nothing at all.
describe('runScoutCycleTick — P-019 hiveRunnerGate preflight', () => {
  const input = {
    workspaceId: 'w',
    installSlug: 'hive-acme',
    admissionQueueScope: { kind: 'harness' as const, harnessSlug: 'hive-acme' },
    payloadTemplate: null,
  };
  // A buildDeps whose cadence ALWAYS fires — so the only thing that can hold the
  // cycle in these cases is the runner gate.
  const alwaysFireBuilder =
    (calls: { ran: number }): ScoutTickDepsBuilder =>
    (depsCtx, runCycle) => ({
      readCadenceState: async () => ({ idleRatio: 1, frictionSignals: 0, lastRunAtMs: null, nowMs: NOW }),
      runCycle: async ({ budget, cycleId }) => {
        calls.ran += 1;
        return runCycle({ harnessSlug: depsCtx.installSlug, workspaceId: depsCtx.workspaceId, budget, cycleId });
      },
      persistRouted: async () => {},
      newCycleId: () => 'cyc',
    });

  it('stands down (fired:false, reason:not-hive-runner) when this node is NOT the runner — no cycle', async () => {
    const { runScoutCycleTick } = await import('./run');
    const calls = { ran: 0 };
    const res = await runScoutCycleTick(input, {
      runCycle: async () => ({ provenance: [], costUsd: 0.1 }),
      buildDeps: alwaysFireBuilder(calls),
      hiveRunnerGate: async () => ({ run: false, reason: 'remote-runner' }),
    });
    expect(res).toEqual({ fired: false, reason: 'not-hive-runner' });
    expect(calls.ran).toBe(0); // the cycle never fanned out on the non-runner node
  });

  it('proceeds normally when this node IS the runner', async () => {
    const { runScoutCycleTick } = await import('./run');
    const calls = { ran: 0 };
    const res = await runScoutCycleTick(input, {
      runCycle: async () => ({ provenance: [], costUsd: 0.1 }),
      buildDeps: alwaysFireBuilder(calls),
      hiveRunnerGate: async () => ({ run: true, reason: 'authority' }),
    });
    expect(res.fired).toBe(true);
    expect(calls.ran).toBe(1);
  });

  it('unwired gate ⇒ no preflight — standalone behaviour unchanged (the cycle fires)', async () => {
    const { runScoutCycleTick } = await import('./run');
    const calls = { ran: 0 };
    const res = await runScoutCycleTick(input, {
      runCycle: async () => ({ provenance: [], costUsd: 0.1 }),
      buildDeps: alwaysFireBuilder(calls),
    });
    expect(res.fired).toBe(true);
    expect(calls.ran).toBe(1);
  });
});

/*
 * WI-1664060: the pot-config layering is a SEAM on the shared tick, so BOTH Scout
 * entrypoints get it. It used to live in the routine action's body, and the
 * `blender:cycle` op — the path that actually runs Scout in production — never
 * applied it, so the owner's per-pot tuning was written to hive_settings and never
 * read. Same one-lane-two-entrypoints shape as the P-051 ceiling regression.
 *
 * These test the merge where it now happens, and pin the two properties the old
 * placement could not guarantee: it fires for ANY caller, and it can never fail a
 * tick.
 */
describe('runScoutCycleTick — WI-1664060 pot-config layering', () => {
  const input = {
    workspaceId: 'w',
    installSlug: 'hive-acme',
    admissionQueueScope: { kind: 'harness' as const, harnessSlug: 'hive-acme' },
    payloadTemplate: { budget: { maxCostUsd: 0.5 }, scout: { lenses: ['base'] } } as Record<
      string,
      unknown
    >,
  };
  const capturing = (
    sink: { seen?: unknown },
  ): ScoutTickDepsBuilder => (depsCtx, runCycle) => {
    sink.seen = depsCtx.payloadTemplate;
    return {
      readCadenceState: async () => ({ idleRatio: 1, frictionSignals: 0, lastRunAtMs: null, nowMs: NOW }),
      runCycle: async ({ budget, cycleId }) =>
        runCycle({ harnessSlug: depsCtx.installSlug, workspaceId: depsCtx.workspaceId, budget, cycleId }),
      persistRouted: async () => {},
      newCycleId: () => 'cyc',
    };
  };

  it('merges per SECTION — a delta section overrides key-wise, other sections survive', async () => {
    const { runScoutCycleTick } = await import('./run');
    const sink: { seen?: unknown } = {};
    await runScoutCycleTick(input, {
      runCycle: async () => ({ provenance: [], costUsd: 0.1 }),
      buildDeps: capturing(sink),
      resolveConfigDelta: async () => ({ scout: { lenses: ['inversion'], buckets: { maxMoonshots: 2 } } }),
    });
    expect(sink.seen).toEqual({
      budget: { maxCostUsd: 0.5 },
      scout: { lenses: ['inversion'], buckets: { maxMoonshots: 2 } },
    });
  });

  it('feeds the MERGED payload to the deps builder, not just the cadence/budget parser', async () => {
    // Both consumers read payloadTemplate — parseScoutCycleConfig for cadence/budget
    // and the deps builder for the `scout` block. Layering that reached only one of
    // them would leave Scout's judgment tuning on engine defaults while its budget
    // honoured the owner, which is the half-applied failure this pins against.
    const { runScoutCycleTick } = await import('./run');
    const sink: { seen?: unknown } = {};
    await runScoutCycleTick(
      { ...input, payloadTemplate: null },
      {
        runCycle: async () => ({ provenance: [], costUsd: 0.1 }),
        buildDeps: capturing(sink),
        resolveConfigDelta: async () => ({ budget: { maxCostUsd: 9 } }),
      },
    );
    expect(sink.seen).toEqual({ budget: { maxCostUsd: 9 } });
  });

  it('fails OPEN on a throwing resolver — the payload is used unchanged, the tick still fires', async () => {
    const { runScoutCycleTick } = await import('./run');
    const sink: { seen?: unknown } = {};
    const res = await runScoutCycleTick(input, {
      runCycle: async () => ({ provenance: [], costUsd: 0.1 }),
      buildDeps: capturing(sink),
      resolveConfigDelta: async () => {
        throw new Error('hive_settings down');
      },
    });
    expect(res.fired).toBe(true); // an unreadable settings row must never stop a tick
    expect(sink.seen).toEqual(input.payloadTemplate);
  });

  it('unwired ⇒ no layering (the hermetic unit-test contract, unchanged behaviour)', async () => {
    const { runScoutCycleTick } = await import('./run');
    const sink: { seen?: unknown } = {};
    const res = await runScoutCycleTick(input, {
      runCycle: async () => ({ provenance: [], costUsd: 0.1 }),
      buildDeps: capturing(sink),
    });
    expect(res.fired).toBe(true);
    expect(sink.seen).toEqual(input.payloadTemplate);
  });
});

