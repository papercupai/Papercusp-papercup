/**
 * scorecard-backstop.test.ts — the Overwatch scorecard-emission backstop
 * (hive-loop-supervision 2026-06-21). Hermetic: the pure synthesizer is tested
 * directly; the end-check injects ALL externals (flag/started/control-state/
 * freshness/computeHealth/capture/recordFire) so it runs without PG, flags, or vi.mock.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  synthesizeCoordinationScorecard,
  overwatchScorecardEndCheck,
  backstopWatchdogKey,
  readFloorRepeatCount,
  COORDINATION_CRITERIA,
  COORDINATION_RUBRIC_REF,
  type OverwatchScorecardEndCheckDeps,
  type OpenBackstopFloor,
  defaultToolUtilizationGrade,
} from './scorecard-backstop';
import type { SystemHealth, ToolEfficiencyHealth } from '../system-health/types';
import type { DerivedSnapshotResult } from '../derived-reads/registry';
import { resolveLocalRubric } from '../cupboard/rubric-store';

// ── builders ──────────────────────────────────────────────────────────────────

describe('shared adoption grade (EI-25299577060523251)', () => {
  const snapshot = (meta: Partial<DerivedSnapshotResult<ToolEfficiencyHealth>['meta']> = {}) => ({
    payload: {
      codeRunAdoption: { rating: 'healthy', evidence: 'measured seven-day adoption', adoptionRatePct: 80 },
    } as ToolEfficiencyHealth,
    meta: { computedAt: 1, computeMs: 20, missing: false, stale: false, error: null, precomputed: true, ...meta },
  });

  it('grounds the grade from the existing shared result without a raw corpus scan', async () => {
    const read = vi.fn(async () => snapshot());
    expect(await defaultToolUtilizationGrade(read)).toEqual({
      rating: 'healthy', evidence: 'measured seven-day adoption',
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps cold, stale and failed refreshes unknown instead of starting a scan', async () => {
    for (const data of [
      { ...snapshot(), payload: null },
      snapshot({ missing: true }),
      snapshot({ stale: true }),
      snapshot({ error: 'producer failed' }),
    ]) {
      expect(await defaultToolUtilizationGrade(async () => data)).toBeUndefined();
    }
  });

  it('does not propagate a shared-reader failure into the scorecard backstop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await defaultToolUtilizationGrade(async () => { throw new Error('snapshot unavailable'); })).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

const BASE = {
  workFeed: { frontier: 0, frontierBlocked: 0, startedPlans: 1, autoEligibleStuck: 0, deadRoutines: 0, deadRoutineNames: [] },
  bees: { running: 2, alive: 2, stale: 0, orphanedClaims: 0, totalLoad: 2, invalidModelFailures: 0, placements: { recovering: 0, cursed: 0, stranded: 0, workingTracked: 1 } },
  queen: { workingTracked: 1, stalled: false },
  watchdog: { fires24h: 0, livenessArmed: true, staleForMs: 0, recentErrors: 0 },
  scout: { lastTickAt: 1, lastRanAt: 1, ideasLastRun: 3, ideasInWindow: 6, ranInWindow: 2, transportDeath: false },
  plans: { active: 3, started: 2, shipped: 0, draft: 1, itemsDone: 0, itemsTotal: 0, stalledPlans: 0, startedDraft: 0 },
  // EI-19950525038045198: end-to-end-flow reads executor capacity from the su FLEET, not from
  // `bees` — the nursery tier is retired, so bees.running is structurally 0 forever.
  suFleet: { total: 3, live: 2, stale: 0, byRole: {} },
};

/** Build a SystemHealth with per-panel data; pass `null` to simulate a failed (unread) panel. */
function mkHealth(over: Partial<Record<keyof typeof BASE, unknown>> = {}): SystemHealth {
  const pick = (k: keyof typeof BASE) => (k in over ? over[k] : BASE[k]);
  const panel = (data: unknown) => ({ data });
  return {
    panels: {
      workFeed: panel(pick('workFeed')),
      bees: panel(pick('bees')),
      queen: panel(pick('queen')),
      watchdog: panel(pick('watchdog')),
      scout: panel(pick('scout')),
      plans: panel(pick('plans')),
      suFleet: panel(pick('suFleet')),
    },
  } as unknown as SystemHealth;
}

function assertWellFormed(ratings: Record<string, { rating: string; evidence: string }>) {
  // exactly the rubric criteria (COORDINATION_CRITERIA — the founding 13 + scheduler-usage +
  // context-burn), each with a non-empty rating + non-empty evidence
  expect(Object.keys(ratings).sort()).toEqual([...COORDINATION_CRITERIA].sort());
  for (const k of COORDINATION_CRITERIA) {
    expect(ratings[k].rating.trim().length).toBeGreaterThan(0);
    expect(ratings[k].evidence.trim().length).toBeGreaterThan(0);
    expect(['healthy', 'degraded', 'broken', 'unknown']).toContain(ratings[k].rating);
  }
}

// ── the pure synthesizer ────────────────────────────────────────────────────────

describe('synthesizeCoordinationScorecard', () => {
  it('returns all 15 keys, each with non-empty evidence', () => {
    assertWellFormed(synthesizeCoordinationScorecard(mkHealth()));
  });

  // EI-13292 recurrence guard: COORDINATION_CRITERIA drifted to 14 keys (missing
  // `context-burn`) after the first-party bundle (rubrics/pot-coordination-health/
  // rubric.json) was extended to 15 — the auto-synth floor then filed a 14/15
  // scorecard the capture completeness gate rejected as INCOMPLETE every time it
  // fired. Pin this local copy to the bundle's own criteria list so it can't
  // silently diverge again.
  it('keeps COORDINATION_CRITERIA in lockstep with the first-party rubric bundle (EI-13292)', () => {
    const bundled = resolveLocalRubric('pot-coordination-health');
    expect(bundled).not.toBeNull();
    const bundledKeys = bundled!.criteria.map((c) => c.key);
    expect([...COORDINATION_CRITERIA].sort()).toEqual([...bundledKeys].sort());
  });

  it('a stuck / no-placement / no-bee brief → end-to-end-flow is NOT healthy', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({
        workFeed: { ...BASE.workFeed, autoEligibleStuck: 126, frontier: 0 },
        bees: { ...BASE.bees, running: 0, placements: { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0 } },
        queen: { workingTracked: 0, stalled: true },
      }),
    );
    assertWellFormed(r);
    expect(r['end-to-end-flow'].rating).toBe('broken'); // >=50 stuck
    expect(r['end-to-end-flow'].rating).not.toBe('healthy');
    expect(r['queen-workitem-selection'].rating).toBe('degraded'); // stuck>0 + workingTracked 0
    expect(r['end-to-end-flow'].evidence).toContain('126');
  });

  it('a clean brief → end-to-end-flow healthy; mid backlog → degraded', () => {
    expect(synthesizeCoordinationScorecard(mkHealth())['end-to-end-flow'].rating).toBe('healthy');
    const mid = synthesizeCoordinationScorecard(mkHealth({ workFeed: { ...BASE.workFeed, autoEligibleStuck: 5 } }));
    expect(mid['end-to-end-flow'].rating).toBe('degraded');
  });

  // ── EI-19950525038045198: attempts:0 is no longer ONE opaque bucket ──────────────
  //
  // This is the falsifier the item itself specifies: replay the SAME stuck count under
  // capacity-starvation and under dispatcher-breakage. If both produce the same verdict, the
  // split provides no diagnostic value over the single bucket and the mechanism is wrong.
  it('same stuck count scores DIFFERENTLY under capacity starvation vs dispatcher breakage (EI-19950525038045198)', () => {
    const stuckFeed = { ...BASE.workFeed, autoEligibleStuck: 126 };

    const starved = synthesizeCoordinationScorecard(
      mkHealth({ workFeed: stuckFeed, suFleet: { total: 3, live: 0, stale: 3, byRole: {} } }),
    );
    const dispatcherBroken = synthesizeCoordinationScorecard(
      mkHealth({ workFeed: stuckFeed, suFleet: { total: 3, live: 3, stale: 0, byRole: {} } }),
    );
    assertWellFormed(starved);
    assertWellFormed(dispatcherBroken);

    // THE POINT: identical input backlog, different verdicts.
    expect(starved['end-to-end-flow'].rating).not.toBe(dispatcherBroken['end-to-end-flow'].rating);

    // No live executor to dispatch to ⇒ expected under load, never escalated to 'broken'.
    expect(starved['end-to-end-flow'].rating).toBe('degraded');
    expect(starved['end-to-end-flow'].evidence).toContain('quiescent-awaiting-capacity');

    // Executors available and work still undispatched ⇒ always a bug.
    expect(dispatcherBroken['end-to-end-flow'].rating).toBe('broken');
    expect(dispatcherBroken['end-to-end-flow'].evidence).toContain('signal1-only-no-dispatch');
  });

  // Capacity must come from the su fleet, NOT from the retired nursery tier. If this ever
  // regresses to `bees.running`, bees:0 would read as starvation and the criterion would
  // report 'degraded' forever instead of catching a real dispatcher stall.
  it('reads capacity from the su fleet, not from retired bees (EI-19950525038045198)', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({
        workFeed: { ...BASE.workFeed, autoEligibleStuck: 126 },
        bees: { ...BASE.bees, running: 0 }, // retired tier: structurally 0, must not gate the verdict
        suFleet: { total: 3, live: 3, stale: 0, byRole: {} },
      }),
    );
    expect(r['end-to-end-flow'].rating).toBe('broken');
    expect(r['end-to-end-flow'].evidence).toContain('signal1-only-no-dispatch');
    expect(r['end-to-end-flow'].evidence).not.toContain('bees running');
  });

  // unreadable ≠ observed-zero. An unobserved fleet panel must not be read as starvation.
  it('an unobserved fleet panel is NOT read as starvation (EI-19950525038045198)', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({ workFeed: { ...BASE.workFeed, autoEligibleStuck: 126 }, suFleet: null }),
    );
    expect(r['end-to-end-flow'].rating).toBe('broken');
    expect(r['end-to-end-flow'].evidence).toContain('NOT OBSERVED');
    expect(r['end-to-end-flow'].evidence).not.toContain('quiescent-awaiting-capacity');
  });

  // The survey's own docblock warns that a failed read fabricates autoEligibleStuck:0. Reporting
  // that as 'healthy' would let a broken instrument buy silence from the alarm.
  it('an unreadable work-feed survey reports unknown, never healthy (EI-19950525038045198)', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({ workFeed: { ...BASE.workFeed, autoEligibleStuck: 0, frontierUnreadable: true } }),
    );
    assertWellFormed(r);
    expect(r['end-to-end-flow'].rating).toBe('unknown');
    expect(r['end-to-end-flow'].rating).not.toBe('healthy');
    expect(r['end-to-end-flow'].evidence).toContain('NOT OBSERVED');
  });

  // ── EI-19961781283827318: bee-execution no longer collapses on the retired tier ────
  //
  // THE REGRESSION GUARD. `bees.running` is structurally 0 forever (nursery tier retired), so
  // the old zero-branch fired on every wake and returned a permanent 'unknown'. If this ever
  // regresses to gating on `bees`, this test fails: a fully healthy live fleet would once again
  // be reported as "not assessable".
  it('a retired-tier zero does NOT collapse the criterion when the fleet is live (EI-19961781283827318)', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({
        bees: { ...BASE.bees, running: 0 }, // retired tier: structurally 0, must not gate the verdict
        suFleet: { total: 4, live: 4, stale: 0, byRole: {} },
      }),
    );
    assertWellFormed(r);
    expect(r['bee-execution'].rating).toBe('healthy');
    expect(r['bee-execution'].rating).not.toBe('unknown');
    expect(r['bee-execution'].evidence).toContain('su-fleet');
    // the transient wording is the reported harm — a permanent condition must not read as
    // one that might differ next tick
    expect(r['bee-execution'].evidence).not.toContain('this wake — not assessable');
  });

  it('stale su-fleet executors → bee-execution degraded (EI-19961781283827318)', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({
        bees: { ...BASE.bees, running: 0 },
        suFleet: { total: 4, live: 3, stale: 2, byRole: {} },
      }),
    );
    expect(r['bee-execution'].rating).toBe('degraded');
  });

  // Zero live executors is genuinely not assessable (nothing ran) — but the evidence must name
  // the PERMANENT structural reason and report the observed numbers, not imply a transient wake
  // condition. Deliberately NOT rated a failure: whether an idle fleet is a problem depends on
  // whether work is waiting, and end-to-end-flow already owns that judgment.
  it('zero live executors is unknown, but names the permanent reason (EI-19961781283827318)', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({
        bees: { ...BASE.bees, running: 0 },
        suFleet: { total: 3, live: 0, stale: 3, byRole: {} },
      }),
    );
    expect(r['bee-execution'].rating).toBe('unknown');
    expect(r['bee-execution'].evidence).toContain('nursery tier retired');
    expect(r['bee-execution'].evidence).toContain('0 of 3');
    expect(r['bee-execution'].evidence).not.toContain('this wake — not assessable');
  });

  // unreadable ≠ observed-zero, the same rule end-to-end-flow follows: with neither panel
  // observed the floor must not fabricate executor counts it never read.
  it('neither panel observed → unknown without fabricated counts (EI-19961781283827318)', () => {
    const r = synthesizeCoordinationScorecard(mkHealth({ bees: null, suFleet: null }));
    assertWellFormed(r);
    expect(r['bee-execution'].rating).toBe('unknown');
    expect(r['bee-execution'].evidence).not.toContain('su-fleet executors');
  });

  // The legacy path stays intact: if a live nursery ever reports again, it is rated from `bees`
  // — including orphanedClaims, which has no su-fleet equivalent.
  it('a live nursery is still rated from bees, orphaned claims included (EI-19961781283827318)', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({ bees: { ...BASE.bees, running: 2, stale: 0, orphanedClaims: 1 } }),
    );
    expect(r['bee-execution'].rating).toBe('degraded');
    expect(r['bee-execution'].evidence).toContain('orphaned claims');
  });

  it('Scout transport-death → ideation-quality broken; draft-force-start → queen-plan-selection degraded', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({
        scout: { ...BASE.scout, transportDeath: true, ideasInWindow: 0 },
        plans: { ...BASE.plans, startedDraft: 2 },
      }),
    );
    expect(r['ideation-quality'].rating).toBe('broken');
    expect(r['queen-plan-selection'].rating).toBe('degraded');
  });

  it('excessive watchdog fires → watchdog-determinism degraded', () => {
    const r = synthesizeCoordinationScorecard(mkHealth({ watchdog: { ...BASE.watchdog, fires24h: 82 } }));
    expect(r['watchdog-determinism'].rating).toBe('degraded');
  });

  it('judgment-only criteria are honestly unknown', () => {
    const r = synthesizeCoordinationScorecard(mkHealth());
    for (const k of ['parallel-distribution', 'tool-utilization', 'coordination-comms', 'bee-observation-quality']) {
      expect(r[k].rating).toBe('unknown');
    }
    expect(r['overwatch-observation-quality'].rating).toBe('unknown');
  });

  it('tool-utilization is GROUNDED when an adoption grade is supplied', () => {
    const grade = { rating: 'broken', evidence: 'code:run adoption 2% — 1/50 batchable spawns folded' };
    const r = synthesizeCoordinationScorecard(mkHealth(), grade);
    assertWellFormed(r);
    expect(r['tool-utilization']).toEqual(grade); // real data overrides the floor's 'unknown'
    // the other judgment-only criteria stay unknown — only tool-utilization is grounded
    expect(r['coordination-comms'].rating).toBe('unknown');
  });

  it('null (unread) panels degrade to unknown, never throw', () => {
    const r = synthesizeCoordinationScorecard(
      mkHealth({ workFeed: null, bees: null, queen: null, watchdog: null, scout: null, plans: null }),
    );
    assertWellFormed(r);
    expect(r['end-to-end-flow'].rating).toBe('unknown');
    expect(r['watchdog-determinism'].rating).toBe('unknown');
  });
});

// ── the end-check (turn-end seam) ───────────────────────────────────────────────

function deps(over: Partial<OverwatchScorecardEndCheckDeps> = {}): {
  d: OverwatchScorecardEndCheckDeps;
  captured: { capture: unknown[]; fires: unknown[]; bumps: unknown[] };
} {
  const captured = { capture: [] as unknown[], fires: [] as unknown[], bumps: [] as unknown[] };
  const d: OverwatchScorecardEndCheckDeps = {
    enabled: async () => true,
    started: async () => true,
    controlState: async () => ({ lastWakeAt: '2026-06-21T17:00:00.000Z', potSlug: 'papercusp' }),
    freshness: (async () => ({ status: 'stale' })) as unknown as OverwatchScorecardEndCheckDeps['freshness'],
    computeHealth: async () => mkHealth(),
    capture: (async (input: unknown) => {
      captured.capture.push(input);
      return { ok: true, created: true, possibleDuplicates: [] };
    }) as unknown as OverwatchScorecardEndCheckDeps['capture'],
    recordFire: async (...a: unknown[]) => {
      captured.fires.push(a);
    },
    // hermetic: default to no adoption grade (floor → 'unknown') so the end-check never touches PG.
    toolUtilizationGrade: async () => undefined,
    // WI-3064: hermetic default — no standing open floor, so tests exercise the
    // fresh-file path unless a test explicitly overrides this to simulate coalescing.
    findOpenBackstopFloor: async () => null,
    bumpFloorRepeat: async (id: string, priorCount: number, firstFiredAt: string | null) => {
      captured.bumps.push({ id, priorCount, firstFiredAt });
    },
    ...over,
  };
  return { d, captured };
}

const opts = { workspaceId: 'papercusp-workspace', installSlug: 'papercusp' };

describe('overwatchScorecardEndCheck', () => {
  it('flag off → skipped, nothing filed', async () => {
    const { d, captured } = deps({ enabled: async () => false });
    const res = await overwatchScorecardEndCheck(opts, d);
    expect(res.outcome).toBe('skipped');
    expect(captured.capture).toHaveLength(0);
    expect(captured.fires).toHaveLength(0);
  });

  it('not started → skipped', async () => {
    const { d, captured } = deps({ started: async () => false });
    expect((await overwatchScorecardEndCheck(opts, d)).outcome).toBe('skipped');
    expect(captured.capture).toHaveLength(0);
  });

  it('agent emitted a complete scorecard (fresh) → skipped, no floor', async () => {
    const { d, captured } = deps({
      freshness: (async () => ({ status: 'fresh' })) as unknown as OverwatchScorecardEndCheckDeps['freshness'],
    });
    const res = await overwatchScorecardEndCheck(opts, d);
    expect(res.outcome).toBe('skipped');
    expect(captured.capture).toHaveLength(0);
    expect(captured.fires).toHaveLength(0);
  });

  it('unknown rubric → skipped, no synthesized floor or fire', async () => {
    const { d, captured } = deps({
      freshness: (async () => ({ status: 'unknown-rubric' })) as unknown as OverwatchScorecardEndCheckDeps['freshness'],
    });
    const res = await overwatchScorecardEndCheck(opts, d);
    expect(res.outcome).toBe('skipped');
    expect(res.reason).toContain('unknown');
    expect(captured.capture).toHaveLength(0);
    expect(captured.fires).toHaveLength(0);
  });

  it('agent skipped (stale) → synthesizes a complete, synthesized-marked floor + records a fire', async () => {
    const { d, captured } = deps();
    const res = await overwatchScorecardEndCheck(opts, d);
    expect(res.outcome).toBe('synthesized');
    expect(captured.capture).toHaveLength(1);
    expect(captured.fires).toHaveLength(1);
    const input = captured.capture[0] as {
      lane: string;
      payloadExtra: { observation: { rubricRef: string; synthesized: boolean; ratings: Record<string, unknown> } };
    };
    expect(input.lane).toBe('observation');
    const obs = input.payloadExtra.observation;
    expect(obs.rubricRef).toBe(COORDINATION_RUBRIC_REF);
    expect(obs.synthesized).toBe(true);
    expect(Object.keys(obs.ratings).sort()).toEqual([...COORDINATION_CRITERIA].sort());
  });

  it('flows the data-derived adoption grade into the filed floor’s tool-utilization', async () => {
    const grade = { rating: 'broken', evidence: 'code:run adoption 2% — 1/50 batchable spawns folded' };
    const { d, captured } = deps({ toolUtilizationGrade: async () => grade });
    await overwatchScorecardEndCheck(opts, d);
    const obs = (captured.capture[0] as {
      payloadExtra: { observation: { ratings: Record<string, { rating: string; evidence: string }> } };
    }).payloadExtra.observation;
    expect(obs.ratings['tool-utilization']).toEqual(grade);
  });

  it('asks freshness for AGENT scorecards only (includeSynthesized:false)', async () => {
    let seen: { includeSynthesized?: boolean } | null = null;
    const { d } = deps({
      freshness: (async (f: { includeSynthesized?: boolean }) => {
        seen = f;
        return { status: 'stale' };
      }) as unknown as OverwatchScorecardEndCheckDeps['freshness'],
    });
    await overwatchScorecardEndCheck(opts, d);
    expect(seen!.includeSynthesized).toBe(false);
  });

  it('partial-only agent emission → still synthesizes the floor', async () => {
    const { d, captured } = deps({
      freshness: (async () => ({ status: 'partial-only' })) as unknown as OverwatchScorecardEndCheckDeps['freshness'],
    });
    expect((await overwatchScorecardEndCheck(opts, d)).outcome).toBe('synthesized');
    expect(captured.capture).toHaveLength(1);
  });

  it('fail-soft: computeHealth throwing yields outcome:error, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { d } = deps({
      computeHealth: async () => {
        throw new Error('brief read failed');
      },
    });
    const res = await overwatchScorecardEndCheck(opts, d);
    expect(res.outcome).toBe('error');
    expect(res.reason).toContain('brief read failed');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fail-soft: capture throwing yields outcome:error, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { d } = deps({
      capture: (async () => {
        throw new Error('capture exploded');
      }) as unknown as OverwatchScorecardEndCheckDeps['capture'],
    });
    expect((await overwatchScorecardEndCheck(opts, d)).outcome).toBe('error');
    warn.mockRestore();
  });

  // ── WI-3064: turn-end floor coalescing (mirrors WI-2977's pulse-floor dedup) ──────

  it('a fresh file stamps a stable watchdogKey (scorecard-backstop:<hive>) on the item', async () => {
    const { d, captured } = deps();
    await overwatchScorecardEndCheck(opts, d);
    expect(captured.capture).toHaveLength(1);
    const input = captured.capture[0] as { payloadExtra: { watchdogKey: string } };
    expect(input.payloadExtra.watchdogKey).toBe(backstopWatchdogKey('papercusp'));
  });

  it('a standing OPEN floor for this hive → coalesces (bumps repeat), files NO new item', async () => {
    const existing: OpenBackstopFloor = { id: 'EI-9001', payload: { floorRepeat: { count: 2, firstFiredAt: '2026-07-05T10:00:00.000Z', lastFiredAt: '2026-07-05T11:00:00.000Z' } } };
    const { d, captured } = deps({ findOpenBackstopFloor: async () => existing });
    const res = await overwatchScorecardEndCheck(opts, d);
    expect(res.outcome).toBe('synthesized'); // still "handled the gap", just without a new item
    expect(captured.capture).toHaveLength(0); // NO duplicate filed
    expect(captured.bumps).toHaveLength(1);
    expect(captured.bumps[0]).toEqual({ id: 'EI-9001', priorCount: 2, firstFiredAt: '2026-07-05T10:00:00.000Z' });
    expect(captured.fires).toHaveLength(1); // still recorded as a fire (countable signal)
  });

  it('no standing floor (first fire for this outage) → files fresh + records a fire, no bump', async () => {
    const { d, captured } = deps();
    await overwatchScorecardEndCheck(opts, d);
    expect(captured.capture).toHaveLength(1);
    expect(captured.bumps).toHaveLength(0);
    expect(captured.fires).toHaveLength(1);
  });

  it('findOpenBackstopFloor throwing degrades to filing fresh (fail-soft lookup), never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { d, captured } = deps({
      findOpenBackstopFloor: async () => {
        throw new Error('lookup failed');
      },
    });
    const res = await overwatchScorecardEndCheck(opts, d);
    expect(res.outcome).toBe('synthesized');
    expect(captured.capture).toHaveLength(1); // fell through to filing fresh, not an error
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('readFloorRepeatCount: absent/malformed payload → 0; well-formed → the count', () => {
    expect(readFloorRepeatCount(null)).toBe(0);
    expect(readFloorRepeatCount({})).toBe(0);
    expect(readFloorRepeatCount({ floorRepeat: 'nope' })).toBe(0);
    expect(readFloorRepeatCount({ floorRepeat: { count: 3 } })).toBe(3);
  });
});
