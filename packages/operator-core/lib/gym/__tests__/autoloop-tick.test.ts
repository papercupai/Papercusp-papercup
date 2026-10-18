/**
 * Unit tests for the gym autoloop tick core (autoloop-tick.ts) — the pure
 * injected-deps decision + orchestration behind `system:gym-cycle`
 * (learning-system-audit-improvements-2026-06-09 P-031/P-032). Zero PG, zero
 * LLM, no docker: every effect is a recorded fake.
 */
import { describe, it, expect } from 'vitest';
import {
  GYM_AUTOLOOP_BUDGET_FLOOR_USD,
  GYM_AUTOLOOP_STALE_RUNNING_MS,
  formatCandidateDirections,
  isEligibleAutoloop,
  isStaleRunning,
  orderByLeastRecentlyRun,
  remainingBudgetUsd,
  runGymAutoloopTick,
  selectRoutedGymIdeas,
  type GymCycleRequest,
  type GymCycleResult,
  type GymTickDeps,
  type GymAdmissionDecision,
} from '../autoloop-tick';
import type { GymAutoloopConfig, SetAutoloopInput } from '../control-plane';

const okResult: GymCycleResult = { spentUsd: 1.25, breakerTripped: false, cycles: 1, accepts: 1, skipped: 0 };

describe('actual admission branch observations', () => {
  it.each(['budget', 'pot', 'authority', 'blueprint', 'backoff', 'pass'])(
    'records the actual %s boundary and never probes later gates after refusal', async fault => {
      const rows: GymAdmissionDecision[] = [];
      const { deps, rec } = makeDeps([autoloop({ budgetUsd: fault === 'budget' ? null : 20 })], {
        observeAdmission: row => rows.push(row), disabledPots: async () => new Set(fault === 'pot' ? ['alpha'] : []),
        isHiveRunner: async () => fault !== 'authority',
        isBlueprintRetired: async () => fault === 'blueprint' ? { retired: true, at: '2026-10-17', reason: 'retired' } : null,
        checkFireGate: async () => ({ allow: fault !== 'backoff', reason: 'backoff' }),
      });
      await runGymAutoloopTick(deps);
      expect(rec.cycleReqs).toHaveLength(fault === 'pass' ? 1 : 0);
      const refusal = { budget: 'native-budget', pot: 'pot-scope', authority: 'authority', blueprint: 'blueprint', backoff: 'fire-backoff' }[fault];
      if (refusal) expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ gate: refusal, status: 'refused' })]));
      if (fault !== 'pass') expect(rows.some(row => row.gate === 'selection')).toBe(false);
      if (['budget', 'pot', 'authority'].includes(fault)) expect(rows.some(row => row.gate === 'blueprint')).toBe(false);
      if (['budget', 'pot', 'authority', 'blueprint'].includes(fault)) expect(rows.some(row => row.gate === 'fire-backoff')).toBe(false);
    });
  it('keeps fail-open resolution failures unknown and observer errors do not alter the tick', async () => {
    const rows: GymAdmissionDecision[] = [];
    const { deps, rec } = makeDeps([autoloop()], { observeAdmission: row => { rows.push(row); throw new Error('observer'); },
      disabledPots: async () => { throw new Error('pot-store'); },
      isHiveRunner: async () => { throw new Error('authority'); },
      isBlueprintRetired: async () => { throw new Error('blueprint'); },
      checkFireGate: async () => { throw new Error('fire-state'); },
    });
    await runGymAutoloopTick(deps);
    expect(rec.cycleReqs).toHaveLength(1);
    expect(rows.filter(row => row.status === 'unknown').map(row => row.gate)).toEqual(['pot-scope', 'authority', 'blueprint', 'fire-backoff']);
  });
});

function autoloop(over: Partial<GymAutoloopConfig> = {}): GymAutoloopConfig {
  return {
    workspaceId: 'ws-1',
    harnessSlug: 'alpha',
    enabled: true,
    budgetUsd: 20,
    spentUsd: 0,
    status: 'idle',
    lastCycle: null,
    lastCycleAt: null,
    updatedAt: 0,
    ...over,
  };
}

interface Recorded {
  setCalls: SetAutoloopInput[];
  fires: Array<{ slug: string; status: string; outcome: string }>;
  cycleReqs: GymCycleRequest[];
}

function makeDeps(
  autoloops: GymAutoloopConfig[],
  over: Partial<GymTickDeps> = {},
): { deps: GymTickDeps; rec: Recorded } {
  const rec: Recorded = { setCalls: [], fires: [], cycleReqs: [] };
  const deps: GymTickDeps = {
    listAutoloops: async () => autoloops,
    checkFireGate: async () => ({ allow: true }),
    recordFire: async (slug, status, outcome) => {
      rec.fires.push({ slug, status, outcome });
    },
    setAutoloop: async (input) => {
      rec.setCalls.push(input);
    },
    readRoutedIdeas: async () => [],
    runCycle: async (req) => {
      rec.cycleReqs.push(req);
      return okResult;
    },
    now: () => 1_000_000,
    ...over,
  };
  return { deps, rec };
}

// ---------------------------------------------------------------------------
// P-032 helpers: routed-ideas selection + direction formatting
// ---------------------------------------------------------------------------

describe('selectRoutedGymIdeas (P-032)', () => {
  it('keeps only items triaged to the gym', () => {
    const ideas = selectRoutedGymIdeas([
      { id: 'EI-1', title: 'tighten worker re-reads', body: 'workers skip acceptance criteria', ideaLifecycle: { triageDecision: 'gym' } },
      { id: 'EI-2', title: 'a place-routed item', ideaLifecycle: { triageDecision: 'place' } },
      { id: 'EI-3', title: 'a gate-routed item', ideaLifecycle: { triageDecision: 'gate' } },
      { id: 'EI-4', title: 'untriaged (no lifecycle)' },
      { id: 'EI-5', title: 'second gym idea', ideaLifecycle: { triageDecision: 'gym' } },
    ]);
    expect(ideas.map((i) => i.id)).toEqual(['EI-1', 'EI-5']);
    expect(ideas[0].body).toBe('workers skip acceptance criteria');
    expect(ideas[1].body).toBeUndefined();
  });

  it('zero routed ideas → empty (the additive no-op)', () => {
    expect(selectRoutedGymIdeas([])).toEqual([]);
    expect(selectRoutedGymIdeas([{ id: 'x', title: 't', ideaLifecycle: { triageDecision: 'reject' } }])).toEqual([]);
  });
});

describe('formatCandidateDirections (P-032)', () => {
  it('formats title — single-line body, and zero ideas → []', () => {
    expect(formatCandidateDirections([])).toEqual([]);
    const lines = formatCandidateDirections([
      { id: 'a', title: 'Idea A', body: 'line one\n  line two' },
      { id: 'b', title: 'Idea B' },
    ]);
    expect(lines).toEqual(['Idea A — line one line two', 'Idea B']);
  });

  it('caps idea count and truncates long lines', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, title: `Idea ${i}` }));
    expect(formatCandidateDirections(many, { maxIdeas: 3 })).toHaveLength(3);
    const [line] = formatCandidateDirections([{ id: 'l', title: 'T', body: 'x'.repeat(1000) }], { maxCharsPerIdea: 50 });
    expect(line.length).toBe(50);
    expect(line.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Eligibility + ordering
// ---------------------------------------------------------------------------

describe('isEligibleAutoloop — the hard cost guard', () => {
  const floor = GYM_AUTOLOOP_BUDGET_FLOOR_USD;
  it('accepts enabled + idle + budgeted with remaining above the floor', () => {
    expect(isEligibleAutoloop(autoloop(), floor)).toBe(true);
  });
  it('rejects disabled autoloops', () => {
    expect(isEligibleAutoloop(autoloop({ enabled: false }), floor)).toBe(false);
  });
  it('rejects every non-idle status (running/paused/exhausted)', () => {
    for (const status of ['running', 'paused', 'exhausted']) {
      expect(isEligibleAutoloop(autoloop({ status }), floor)).toBe(false);
    }
  });
  it('rejects a NULL budget — unattended spend requires an explicit cap', () => {
    expect(isEligibleAutoloop(autoloop({ budgetUsd: null }), floor)).toBe(false);
  });
  it('respects the budget floor: remaining must be ABOVE it', () => {
    expect(isEligibleAutoloop(autoloop({ budgetUsd: 10, spentUsd: 9.6 }), floor)).toBe(false); // 0.40 left
    expect(isEligibleAutoloop(autoloop({ budgetUsd: 10, spentUsd: 9.5 }), floor)).toBe(false); // exactly the floor
    expect(isEligibleAutoloop(autoloop({ budgetUsd: 10, spentUsd: 9.4 }), floor)).toBe(true); // 0.60 left
  });

  it('rejects a perfectly healthy autoloop whose POT is switched off (D-001)', () => {
    // Gym's governor rows are enforcement:'native', so THIS predicate is gym's
    // only gate — if the switch does not bite here it does not bite at all.
    expect(isEligibleAutoloop(autoloop(), floor, false)).toBe(false);
  });

  it('defaults to enabled when no pot verdict is passed — the pre-gate behaviour (R-5)', () => {
    expect(isEligibleAutoloop(autoloop(), floor)).toBe(true);
    expect(isEligibleAutoloop(autoloop(), floor, true)).toBe(true);
  });
});

describe('remainingBudgetUsd', () => {
  it('null cap → null; otherwise budget − spent', () => {
    expect(remainingBudgetUsd(autoloop({ budgetUsd: null }))).toBeNull();
    expect(remainingBudgetUsd(autoloop({ budgetUsd: 10, spentUsd: 3.5 }))).toBeCloseTo(6.5);
  });
});

describe('orderByLeastRecentlyRun', () => {
  it('never-run rows lead, then ascending lastCycleAt, slug as tiebreak', () => {
    const ordered = orderByLeastRecentlyRun([
      autoloop({ harnessSlug: 'c', lastCycleAt: 300 }),
      autoloop({ harnessSlug: 'b', lastCycleAt: null }),
      autoloop({ harnessSlug: 'a', lastCycleAt: 100 }),
      autoloop({ harnessSlug: 'd', lastCycleAt: null }),
    ]);
    expect(ordered.map((c) => c.harnessSlug)).toEqual(['b', 'd', 'a', 'c']);
  });
});

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

describe('runGymAutoloopTick — selection + bounds', () => {
  it('does nothing when no autoloop is eligible (disabled / busy / uncapped / drained)', async () => {
    const { deps, rec } = makeDeps([
      autoloop({ harnessSlug: 'off', enabled: false }),
      autoloop({ harnessSlug: 'busy', status: 'running' }),
      autoloop({ harnessSlug: 'uncapped', budgetUsd: null }),
      autoloop({ harnessSlug: 'drained', budgetUsd: 5, spentUsd: 4.8 }),
    ]);
    const out = await runGymAutoloopTick(deps);
    expect(out).toMatchObject({ action: 'idle', reason: 'no-eligible-autoloop', eligibleCount: 0 });
    expect(rec.cycleReqs).toHaveLength(0);
    expect(rec.setCalls).toHaveLength(0);
    expect(rec.fires).toHaveLength(0);
  });

  it('runs exactly ONE harness per tick — the least recently run', async () => {
    const { deps, rec } = makeDeps([
      autoloop({ harnessSlug: 'fresh', lastCycleAt: 900 }),
      autoloop({ harnessSlug: 'stale', lastCycleAt: 100 }),
      autoloop({ harnessSlug: 'never', lastCycleAt: null }),
    ]);
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(out.harnessSlug).toBe('never');
    expect(out.eligibleCount).toBe(3);
    expect(rec.cycleReqs).toHaveLength(1);
    expect(rec.cycleReqs[0].harnessSlug).toBe('never');
  });

  it('passes the row REMAINING budget as the cycle hard cap', async () => {
    const { deps, rec } = makeDeps([autoloop({ budgetUsd: 20, spentUsd: 12.5 })]);
    await runGymAutoloopTick(deps);
    expect(rec.cycleReqs[0].budgetUsd).toBeCloseTo(7.5);
    expect(rec.cycleReqs[0].workspaceId).toBe('ws-1');
  });

  it('skips candidates whose pot is switched off, and reports pot-disabled (D-001)', async () => {
    const { deps, rec } = makeDeps([autoloop({ harnessSlug: 'gated-pot' })], {
      disabledPots: async () => new Set(['gated-pot']),
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('idle');
    // Distinct from 'no-eligible-autoloop': the candidate WAS eligible.
    expect(out.reason).toBe('pot-disabled');
    expect(rec.cycleReqs).toHaveLength(0); // and it must not have spent
  });

  it('still runs the pots that are NOT switched off', async () => {
    const { deps, rec } = makeDeps(
      [autoloop({ harnessSlug: 'gated-pot', lastCycleAt: 100 }), autoloop({ harnessSlug: 'live-pot', lastCycleAt: 900 })],
      { disabledPots: async () => new Set(['gated-pot']) },
    );
    const out = await runGymAutoloopTick(deps);
    // 'gated-pot' is least-recently-run, so without the gate it would have won.
    expect(out.action).toBe('ran');
    expect(out.harnessSlug).toBe('live-pot');
    expect(rec.cycleReqs.map((r) => r.harnessSlug)).toEqual(['live-pot']);
  });

  it('fails OPEN when the pot gate cannot be read — never a fleet-wide learning outage', async () => {
    // R-5's posture at the tick layer: an unreadable gate must not stop gym.
    const { deps, rec } = makeDeps([autoloop({ harnessSlug: 'some-pot' })], {
      disabledPots: async () => {
        throw new Error('pot gate unreachable');
      },
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(rec.cycleReqs).toHaveLength(1);
  });

  it('is unchanged when the pot gate dep is unwired', async () => {
    // The hermetic contract the other optional gates keep: no dep ⇒ no filter.
    const { deps } = makeDeps([autoloop({ harnessSlug: 'some-pot' })]);
    expect((await runGymAutoloopTick(deps)).action).toBe('ran');
  });

  it('respects a custom budget floor', async () => {
    const { deps, rec } = makeDeps([autoloop({ budgetUsd: 10, spentUsd: 8 })]); // 2 left
    const out = await runGymAutoloopTick(deps, { budgetFloorUsd: 3 });
    expect(out.action).toBe('idle');
    expect(rec.cycleReqs).toHaveLength(0);
  });
});

describe('runGymAutoloopTick — fire-gate round-robin', () => {
  it('skips a gate-blocked harness and runs the next in LRU order', async () => {
    const { deps, rec } = makeDeps(
      [autoloop({ harnessSlug: 'blocked', lastCycleAt: 100 }), autoloop({ harnessSlug: 'open', lastCycleAt: 200 })],
      { checkFireGate: async (slug) => (slug === 'blocked' ? { allow: false, reason: 'backoff', retryAfterSec: 30 } : { allow: true }) },
    );
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(out.harnessSlug).toBe('open');
    expect(out.gateBlocked).toEqual(['blocked']);
    expect(rec.cycleReqs.map((r) => r.harnessSlug)).toEqual(['open']);
  });

  it('idles (without spending) when EVERY eligible autoloop is gate-blocked', async () => {
    const { deps, rec } = makeDeps([autoloop({ harnessSlug: 'a' }), autoloop({ harnessSlug: 'b' })], {
      checkFireGate: async () => ({ allow: false, reason: 'circuit-open' }),
    });
    const out = await runGymAutoloopTick(deps);
    expect(out).toMatchObject({ action: 'idle', reason: 'fire-gate-backoff', gateBlocked: ['a', 'b'] });
    expect(rec.cycleReqs).toHaveLength(0);
    expect(rec.setCalls).toHaveLength(0);
  });

  it('fails OPEN when the gate check itself throws (protection, not dependency)', async () => {
    const { deps, rec } = makeDeps([autoloop()], {
      checkFireGate: async () => {
        throw new Error('pg hiccup');
      },
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(rec.cycleReqs).toHaveLength(1);
  });
});

describe('runGymAutoloopTick — status transitions + spend', () => {
  it('sets running BEFORE the cycle and settles idle + ACCUMULATED spend after', async () => {
    const order: string[] = [];
    const { deps, rec } = makeDeps([autoloop({ spentUsd: 2 })], {
      runCycle: async (req) => {
        order.push('cycle');
        void req;
        return okResult; // spends 1.25
      },
    });
    const baseSet = deps.setAutoloop;
    deps.setAutoloop = async (input) => {
      order.push(`set:${input.status}`);
      return baseSet(input);
    };
    const out = await runGymAutoloopTick(deps);
    expect(order).toEqual(['set:running', 'cycle', 'set:idle']);
    expect(out.settledStatus).toBe('idle');
    const settle = rec.setCalls.at(-1)!;
    expect(settle.spentUsd).toBeCloseTo(3.25); // 2 prior + 1.25 this cycle — accumulated, not overwritten
    expect(settle.lastCycleAt).toBe(1_000_000);
    // fire-state: attempt (preserved) then ok (resets the error counter).
    expect(rec.fires.map((f) => f.outcome)).toEqual(['attempt', 'ok']);
  });

  it('settles back to idle EVEN when the cycle errors, and records the fire error', async () => {
    const { deps, rec } = makeDeps([autoloop()], {
      runCycle: async () => {
        throw new Error('operator did not come up');
      },
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('error');
    expect(out.error).toContain('operator did not come up');
    expect(out.settledStatus).toBe('idle');
    expect(rec.setCalls.map((c) => c.status)).toEqual(['running', 'idle']);
    expect(rec.fires.map((f) => f.outcome)).toEqual(['attempt', 'error']);
  });

  it('settles paused when the cycle trips the circuit breaker', async () => {
    const { deps, rec } = makeDeps([autoloop()], {
      runCycle: async () => ({ ...okResult, breakerTripped: true }),
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.settledStatus).toBe('paused');
    expect(rec.setCalls.at(-1)!.status).toBe('paused');
    // a breaker trip is a SUCCESSFUL fire (the brake worked) — counter resets.
    expect(rec.fires.at(-1)!.outcome).toBe('ok');
  });

  it('settles exhausted when the spend leaves ≤ the floor remaining', async () => {
    const { deps, rec } = makeDeps([autoloop({ budgetUsd: 4, spentUsd: 2 })], {
      runCycle: async () => ({ ...okResult, spentUsd: 1.8 }), // leaves 0.20 < floor
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.settledStatus).toBe('exhausted');
    expect(rec.setCalls.at(-1)!).toMatchObject({ status: 'exhausted' });
    expect(rec.setCalls.at(-1)!.spentUsd).toBeCloseTo(3.8);
  });
});

describe('runGymAutoloopTick — routed-ideas context (P-032)', () => {
  it('zero routed ideas → the cycle gets an EMPTY directions list (current behavior)', async () => {
    const { deps, rec } = makeDeps([autoloop()]);
    await runGymAutoloopTick(deps);
    expect(rec.cycleReqs[0].candidateDirections).toEqual([]);
  });

  it('routed ideas are formatted into the cycle request', async () => {
    const { deps, rec } = makeDeps([autoloop()], {
      readRoutedIdeas: async () => [
        { id: 'EI-9', title: 'Validator rubber-stamps', body: 'tighten the validator prompt' },
        { id: 'EI-10', title: 'Workers skip re-reads' },
      ],
    });
    const out = await runGymAutoloopTick(deps);
    expect(rec.cycleReqs[0].candidateDirections).toEqual([
      'Validator rubber-stamps — tighten the validator prompt',
      'Workers skip re-reads',
    ]);
    expect(out.candidateDirections).toHaveLength(2);
  });

  it('a routed-ideas read failure never blocks the cycle (additive, best-effort)', async () => {
    const { deps, rec } = makeDeps([autoloop()], {
      readRoutedIdeas: async () => {
        throw new Error('issues table unavailable');
      },
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(rec.cycleReqs[0].candidateDirections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-HIVE execution (per-hive-learning-loops-2026-06-14 P-030). The gym tick is
// keyed purely on harnessSlug, so a per-hive gym_autoloop_config row (laid down
// dark at pot:create by provisionHiveLearningLoop, then armed by the owner) is
// just another row in the workspace sweep. These pin the two per-hive invariants:
//   - the workspace sweep picks up EVERY armed per-hive row (LRU across hives), and
//   - the fire-gate / circuit state is PER-HARNESS, so one failing hive's backoff
//     never brakes its siblings (the round-robin walks past it to a peer).
// ---------------------------------------------------------------------------

describe('runGymAutoloopTick — per-hive execution (P-030)', () => {
  it('sweeps armed per-hive rows across hives, running the least-recently-run hive', async () => {
    // Three hives' armed gym autoloops, all eligible; the never-run hive leads LRU.
    const { deps, rec } = makeDeps([
      autoloop({ harnessSlug: 'hive-acme', lastCycleAt: 5_000 }),
      autoloop({ harnessSlug: 'hive-beta', lastCycleAt: 1_000 }),
      autoloop({ harnessSlug: 'hive-gamma', lastCycleAt: null }),
    ]);
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(out.harnessSlug).toBe('hive-gamma'); // never-run hive leads
    expect(out.eligibleCount).toBe(3); // ALL per-hive rows are in the sweep
    expect(rec.cycleReqs.map((r) => r.harnessSlug)).toEqual(['hive-gamma']);
  });

  it('fire-gate is PER-HARNESS: one hive in circuit-backoff does NOT brake its siblings', async () => {
    // hive-acme's gym is in error-backoff (its OWN (slug,role) autoloop_state row);
    // the tick must walk past it and run a sibling hive in the SAME tick.
    const { deps, rec } = makeDeps(
      [
        autoloop({ harnessSlug: 'hive-acme', lastCycleAt: 100 }),
        autoloop({ harnessSlug: 'hive-beta', lastCycleAt: 200 }),
      ],
      {
        checkFireGate: async (slug) =>
          slug === 'hive-acme'
            ? { allow: false, reason: 'circuit-open', retryAfterSec: 3600 }
            : { allow: true },
      },
    );
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(out.harnessSlug).toBe('hive-beta'); // sibling runs despite acme's open circuit
    expect(out.gateBlocked).toEqual(['hive-acme']); // acme's own gate held it
    expect(rec.cycleReqs.map((r) => r.harnessSlug)).toEqual(['hive-beta']);
    // The fire-path bookkeeping is recorded under the SIBLING's slug only — acme's
    // error counter is untouched by beta's cycle (per-harness fire-state).
    expect(rec.fires.every((f) => f.slug === 'hive-beta')).toBe(true);
  });

  it('a per-hive row stays independently budgeted — the cycle cap is THAT hive\'s remaining', async () => {
    // Two hives with different budgets; only the LRU one runs, capped at its own remaining.
    const { deps, rec } = makeDeps([
      autoloop({ harnessSlug: 'hive-acme', budgetUsd: 8, spentUsd: 5, lastCycleAt: null }),
      autoloop({ harnessSlug: 'hive-beta', budgetUsd: 20, spentUsd: 1, lastCycleAt: 50 }),
    ]);
    const out = await runGymAutoloopTick(deps);
    expect(out.harnessSlug).toBe('hive-acme');
    expect(rec.cycleReqs[0].budgetUsd).toBeCloseTo(3); // acme's own 8 − 5, not beta's
  });
});

// ---------------------------------------------------------------------------
// Stale-running reclaim (crash recovery) — a host death between set:running
// and the settle write must not dead-lock the autoloop forever.
// ---------------------------------------------------------------------------

describe('isStaleRunning — crash-artifact detection', () => {
  it('true only for running rows at/past the stale age', () => {
    const stale = GYM_AUTOLOOP_STALE_RUNNING_MS;
    expect(isStaleRunning({ status: 'running', updatedAt: 0 }, stale, stale)).toBe(true); // boundary inclusive
    expect(isStaleRunning({ status: 'running', updatedAt: 1 }, stale, stale)).toBe(false);
    expect(isStaleRunning({ status: 'idle', updatedAt: 0 }, stale * 2, stale)).toBe(false);
    expect(isStaleRunning({ status: 'paused', updatedAt: 0 }, stale * 2, stale)).toBe(false);
  });

  // EI-18680423618217546: a real bounded ($50/maxCycles=1) cycle observed 2026-07-26 ran
  // ~52 minutes wall-clock. The old 45-min threshold could reclaim (falsely) a LIVE cycle's
  // 'running' row before it settled. Guard the margin so a future edit can't silently
  // shrink it back below a real observed cycle duration.
  it('does not classify a live row still within an observed-real-cycle duration as stale', () => {
    const dispatchedAt = 0;
    const observedRealCycleMs = 52 * 60_000; // 2026-07-26 observed: 6 runs, $0.42/$50 spent
    const stillRunningNow = dispatchedAt + observedRealCycleMs;
    expect(
      isStaleRunning({ status: 'running', updatedAt: dispatchedAt }, stillRunningNow, GYM_AUTOLOOP_STALE_RUNNING_MS),
    ).toBe(false);
  });
});

describe('runGymAutoloopTick — stale-running reclaim (crash recovery)', () => {
  const STALE_NOW = GYM_AUTOLOOP_STALE_RUNNING_MS + 1_000_000;

  it('reclaims a stale running row to idle and runs it in the SAME tick', async () => {
    const { deps, rec } = makeDeps([autoloop({ status: 'running', updatedAt: 0 })], {
      now: () => STALE_NOW,
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(out.reclaimed).toEqual(['alpha']);
    // reclaim settle → running (cycle start) → idle (cycle settle)
    expect(rec.setCalls.map((c) => c.status)).toEqual(['idle', 'running', 'idle']);
    expect(rec.cycleReqs).toHaveLength(1);
  });

  it('a FRESH running row is NOT reclaimed — the durable-step replay still skips it', async () => {
    // makeDeps default now=1,000,000 < the 45-min stale age for updatedAt 0.
    const { deps, rec } = makeDeps([autoloop({ status: 'running', updatedAt: 0 })]);
    const out = await runGymAutoloopTick(deps);
    expect(out).toEqual({ action: 'idle', reason: 'no-eligible-autoloop', eligibleCount: 0, gateBlocked: [] });
    expect(rec.setCalls).toEqual([]);
    expect(rec.cycleReqs).toEqual([]);
  });

  it('a reclaim write failure leaves the row busy and the tick idle (fail-safe)', async () => {
    const { deps, rec } = makeDeps([autoloop({ status: 'running', updatedAt: 0 })], {
      now: () => STALE_NOW,
      setAutoloop: async () => {
        throw new Error('pg down');
      },
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('idle');
    expect(out.reason).toBe('no-eligible-autoloop');
    expect(out.reclaimed).toBeUndefined();
    expect(rec.cycleReqs).toEqual([]);
  });

  it('respects a custom staleRunningMs', async () => {
    // age 1,000 ms at the default now=1,000,000
    const { deps } = makeDeps([autoloop({ status: 'running', updatedAt: 999_000 })]);
    const out = await runGymAutoloopTick(deps, { staleRunningMs: 1_000 });
    expect(out.action).toBe('ran');
    expect(out.reclaimed).toEqual(['alpha']);
  });
});

// ---------------------------------------------------------------------------
// P-020: cross-node single-runner filter (domain-generic-hive-architecture).
// In a shared Hive each node sweeps its own node-local autoloop rows; the gate
// keeps only the autoloops whose Hive THIS node is the elected authority for.
// ---------------------------------------------------------------------------
describe('runGymAutoloopTick — P-020 isHiveRunner single-runner filter', () => {
  it('runs an eligible autoloop when this node IS the hive runner', async () => {
    const { deps, rec } = makeDeps([autoloop({ harnessSlug: 'alpha' })], {
      isHiveRunner: async () => true,
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(out.harnessSlug).toBe('alpha');
    expect(rec.cycleReqs).toHaveLength(1);
  });

  it('stands down (not-hive-runner) when this node is NOT the runner for the only candidate', async () => {
    const { deps, rec } = makeDeps([autoloop({ harnessSlug: 'alpha' })], {
      isHiveRunner: async () => false,
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('idle');
    expect(out.reason).toBe('not-hive-runner');
    expect(rec.cycleReqs).toEqual([]); // no cycle fired on the non-runner node
  });

  it('keeps only the candidates this node runs (one of two Hives)', async () => {
    const { deps, rec } = makeDeps(
      [autoloop({ harnessSlug: 'mine' }), autoloop({ harnessSlug: 'theirs' })],
      { isHiveRunner: async (slug) => slug === 'mine' },
    );
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(out.harnessSlug).toBe('mine');
    expect(rec.cycleReqs.map((r) => r.harnessSlug)).toEqual(['mine']);
  });

  it('FAILS OPEN per candidate: a gate error keeps the candidate (never stalls the loop)', async () => {
    const { deps } = makeDeps([autoloop({ harnessSlug: 'alpha' })], {
      isHiveRunner: async () => {
        throw new Error('presence outage');
      },
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran'); // fail-open → candidate retained → cycle runs
    expect(out.harnessSlug).toBe('alpha');
  });

  it('unwired (no isHiveRunner) ⇒ no filter — standalone behaviour unchanged', async () => {
    const { deps } = makeDeps([autoloop({ harnessSlug: 'alpha' })]); // no override
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(out.harnessSlug).toBe('alpha');
  });
});

// ---------------------------------------------------------------------------
// WI-5645 (no-retirement-launch-guard): refuse to fire a cycle against a
// harness whose effective blueprint (or an ancestor) is retired — the hard
// cost guard for the exact scenario EI-18177667809538623 hit ($14.51+ spent
// via `external-bench`, which `extends: coding-factory`, retired).
// ---------------------------------------------------------------------------
describe('runGymAutoloopTick — WI-5645 isBlueprintRetired guard', () => {
  it('runs an eligible autoloop when its blueprint is NOT retired', async () => {
    const { deps, rec } = makeDeps([autoloop({ harnessSlug: 'alpha' })], {
      isBlueprintRetired: async () => null,
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(out.harnessSlug).toBe('alpha');
    expect(rec.cycleReqs).toHaveLength(1);
  });

  it('stands down (blueprint-retired) when the only candidate resolves to a retired blueprint', async () => {
    const { deps, rec } = makeDeps([autoloop({ harnessSlug: 'gymloopharness' })], {
      isBlueprintRetired: async () => ({ retired: true, at: '2026-06-24', reason: 'dormant' }),
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('idle');
    expect(out.reason).toBe('blueprint-retired');
    expect(out.retiredBlocked).toEqual([{ harnessSlug: 'gymloopharness', retired: true, at: '2026-06-24', reason: 'dormant' }]);
    expect(rec.cycleReqs).toEqual([]); // no cycle fired — no spend
  });

  it('keeps only the non-retired candidates (one retired, one eligible)', async () => {
    const { deps, rec } = makeDeps(
      [autoloop({ harnessSlug: 'external-bench-run' }), autoloop({ harnessSlug: 'healthy' })],
      { isBlueprintRetired: async (slug) => (slug === 'external-bench-run' ? { retired: true } : null) },
    );
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(out.harnessSlug).toBe('healthy');
    expect(rec.cycleReqs.map((r) => r.harnessSlug)).toEqual(['healthy']);
  });

  it('FAILS OPEN per candidate: a check error keeps the candidate (never stalls the loop)', async () => {
    const { deps } = makeDeps([autoloop({ harnessSlug: 'alpha' })], {
      isBlueprintRetired: async () => {
        throw new Error('blueprint resolution outage');
      },
    });
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran'); // fail-open → candidate retained → cycle runs
    expect(out.harnessSlug).toBe('alpha');
  });

  it('unwired (no isBlueprintRetired) ⇒ no filter — standalone behaviour unchanged', async () => {
    const { deps } = makeDeps([autoloop({ harnessSlug: 'alpha' })]); // no override
    const out = await runGymAutoloopTick(deps);
    expect(out.action).toBe('ran');
    expect(out.harnessSlug).toBe('alpha');
  });
});
