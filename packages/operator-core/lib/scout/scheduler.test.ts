/**
 * scheduler.test.ts — Scout P-008 runScoutTick composition.
 * Pins: cadence-gating, fire-gate short-circuit, budgeted-cycle run, provenance
 * persistence, outcome refresh, fire-state recording, tick observability
 * (P-034 — one scout_ticks record per tick, gated/ran/error, best-effort), and
 * the prompt-free autonomy (the cycle is driven purely by injected deps — no
 * human in the loop).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runScoutTick,
  buildScoutTickDeps,
  persistRoutedRecordsIsolated,
  type ScoutTickDeps,
  type ScoutCycleLike,
  type ScoutRoutedRecord,
  type ScoutRevisionRequest,
} from './scheduler';
import type { ScoutTickRecord } from './tick-ledger';
import type { ScoutCadenceState } from './cadence';

const NOW = Date.parse('2026-06-08T12:00:00Z');

function fakeCycle(provenance: ScoutCycleLike['provenance'] = []): ScoutCycleLike {
  return { provenance, costUsd: 0.1 };
}

function makeDeps(over: Partial<ScoutTickDeps> & { state?: Partial<ScoutCadenceState> } = {}): {
  deps: ScoutTickDeps;
  calls: { fire: string[]; persisted: number; refreshed: number; ranBudget?: number; ticks: ScoutTickRecord[] };
} {
  const calls = {
    fire: [] as string[],
    persisted: 0,
    refreshed: 0,
    ranBudget: undefined as number | undefined,
    ticks: [] as ScoutTickRecord[],
  };
  const deps: ScoutTickDeps = {
    readCadenceState: async () => ({ idleRatio: 1, frictionSignals: 0, lastRunAtMs: null, nowMs: NOW, ...over.state }),
    runCycle:
      over.runCycle ??
      (async ({ budget }) => {
        calls.ranBudget = budget.maxCostUsd;
        return fakeCycle([{ ideaId: 'i1', lens: 'analogical', rail: 'gym', routedRef: 'gym:1' }]);
      }),
    persistRouted:
      over.persistRouted ??
      (async () => {
        calls.persisted += 1;
      }),
    recordFire:
      over.recordFire ??
      (async (o) => {
        calls.fire.push(o);
      }),
    refreshOutcomes:
      over.refreshOutcomes ??
      (async () => {
        calls.refreshed += 1;
      }),
    recordTick:
      over.recordTick ??
      (async (rec) => {
        calls.ticks.push(rec);
      }),
    ...(over.fireGate ? { fireGate: over.fireGate } : {}),
    ...(over.persistStageArtifacts ? { persistStageArtifacts: over.persistStageArtifacts } : {}),
    newCycleId: over.newCycleId ?? (() => 'cyc-1'),
  };
  return { deps, calls };
}

describe('runScoutTick (P-008)', () => {
  it('retains supplied and resolved caps on zero-route and pre-attempt policy-gated ticks', async () => {
    const budget = { maxIdeators: 1, maxCostUsd: 0.37 };
    const ran = makeDeps({ runCycle: async () => ({ provenance: [], costUsd: 0.12, ideators: [{ lens: 'analogical', ok: true, raw: 0, produced: 0 }] }) });
    await runScoutTick(ran.deps, { budget });
    expect(ran.calls.ticks[0]).toMatchObject({ status: 'ran', ideasRouted: 0, detail: {
      budgetProvenance: { schemaVersion: 1, supplied: budget, resolved: { maxIdeators: 1, maxCostUsd: 0.37 } },
      ideators: [{ lens: 'analogical' }],
    } });
    const gated = makeDeps({ fireGate: async () => ({ allow: false, reason: 'circuit-open' }) });
    await runScoutTick(gated.deps, { budget });
    expect(gated.calls.ticks[0]).toMatchObject({ status: 'gated', detail: { budgetProvenance: { supplied: budget } } });
    expect(gated.calls.ranBudget).toBeUndefined();
  });
  it('withholds when the cadence gate says no-fire (no cycle, no fire-record)', async () => {
    const { deps, calls } = makeDeps({ state: { idleRatio: 0, frictionSignals: 0, lastRunAtMs: NOW - 60_000 } });
    const r = await runScoutTick(deps, { cadence: { minIntervalSec: 3600 } });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('min-interval');
    expect(calls.fire).toEqual([]); // didn't even attempt
    expect(calls.persisted).toBe(0);
  });

  it('fires on idle capacity: runs the budgeted cycle, persists routed, refreshes outcomes, records attempt+ok', async () => {
    const { deps, calls } = makeDeps();
    const r = await runScoutTick(deps, { budget: { maxCostUsd: 2.5 } });
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('idle-capacity');
    expect(r.cycleId).toBe('cyc-1');
    expect(r.routedCount).toBe(1);
    expect(calls.ranBudget).toBe(2.5); // resolved budget threaded into the cycle
    expect(calls.persisted).toBe(1);
    expect(calls.refreshed).toBe(1);
    expect(calls.fire).toEqual(['attempt', 'ok']);
  });

  it('short-circuits when the autoloop fire-gate denies (circuit open)', async () => {
    const { deps, calls } = makeDeps({
      fireGate: async () => ({ allow: false, reason: 'circuit-open', retryAfterSec: 3600 }),
    });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('circuit');
    expect(r.retryAfterSec).toBe(3600);
    expect(calls.fire).toEqual([]); // gated before attempt
    expect(calls.persisted).toBe(0);
  });

  it('records attempt+error and reports cycle-error when the cycle throws', async () => {
    const { deps, calls } = makeDeps({
      runCycle: async () => {
        throw new Error('llm exploded');
      },
    });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('cycle-error');
    expect(r.error).toContain('llm exploded');
    expect(calls.fire).toEqual(['attempt', 'error']);
    expect(calls.persisted).toBe(0);
  });

  it('does not persist when the cycle routes nothing', async () => {
    const { deps, calls } = makeDeps({ runCycle: async () => fakeCycle([]) });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
    expect(r.routedCount).toBe(0);
    expect(calls.persisted).toBe(0); // nothing to persist
    expect(calls.refreshed).toBe(1); // still refreshes outcomes
  });

  it('persists stage artifacts on a fired cycle (P-009) — best-effort, a persist failure never fails the tick', async () => {
    const cycle: ScoutCycleLike = {
      provenance: [],
      ideas: [{ id: 'i1' }],
      scored: [{ verdict: 'keep' }],
      proposals: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
      routed: [
        { proposalId: 'p1', rail: 'goal', routedRef: 'goal:G-1' },
        { proposalId: 'p2', rail: 'goal', error: 'goal dispatch unavailable' },
        { proposalId: 'p3', rail: 'plan' },
      ],
      ideators: [{ lens: 'analogical', ok: true, raw: 3, produced: 1 }],
    };
    const persisted: Array<{ cycle: ScoutCycleLike; cycleId: string }> = [];
    const ok = makeDeps({
      runCycle: async () => cycle,
      persistStageArtifacts: async (c, id) => {
        persisted.push({ cycle: c, cycleId: id });
      },
    });
    const r = await runScoutTick(ok.deps);
    expect(r.fired).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].cycleId).toBe(r.cycleId);
    expect(persisted[0].cycle.proposals).toHaveLength(3);
    const decisions = persisted[0].cycle.routed as Array<{ routedRef?: string; error?: string }>;
    const dispatched = decisions.filter((d) => d.routedRef).length;
    const failed = decisions.filter((d) => d.error).length;
    const skipped = decisions.filter((d) => !d.routedRef && !d.error).length;
    expect(persisted[0].cycle.proposals?.length).toBe(dispatched + failed + skipped);

    const failing = makeDeps({
      runCycle: async () => cycle,
      persistStageArtifacts: async () => {
        throw new Error('artifacts table down');
      },
    });
    const r2 = await runScoutTick(failing.deps);
    expect(r2.fired).toBe(true); // artifact persist outage never disturbs the cycle
    expect(failing.calls.fire).toEqual(['attempt', 'ok']);
  });

  it('fires friction-triggered even under load (idle below threshold)', async () => {
    const { deps } = makeDeps({ state: { idleRatio: 0, frictionSignals: 5, lastRunAtMs: null } });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('friction-triggered');
  });

  it('is prompt-free: the whole tick runs from injected deps with no human/ask seam', () => {
    // Structural guarantee: ScoutTickDeps exposes no askUser/human gate — the only
    // inputs are readers + the injected cycle. (Compile-time + this assertion.)
    const { deps } = makeDeps();
    expect(Object.keys(deps)).not.toContain('askUser');
    expect(Object.keys(deps)).not.toContain('promptHuman');
  });
});

describe('runScoutTick — tick observability (P-034)', () => {
  it('records a gated tick naming the cadence gate that withheld it', async () => {
    const { deps, calls } = makeDeps({ state: { idleRatio: 0, frictionSignals: 0, lastRunAtMs: NOW - 60_000 } });
    await runScoutTick(deps, { cadence: { minIntervalSec: 3600 } });
    expect(calls.ticks).toHaveLength(1);
    expect(calls.ticks[0].status).toBe('gated');
    expect(calls.ticks[0].gate).toBe('min-interval');
    expect(calls.ticks[0].detail?.retryAfterSec).toBeGreaterThan(0);
  });

  it('records a gated tick with gate=no-trigger when nothing fires', async () => {
    const { deps, calls } = makeDeps({ state: { idleRatio: 0, frictionSignals: 0, lastRunAtMs: NOW - 7200_000 } });
    await runScoutTick(deps, { cadence: { minIntervalSec: 3600, maxIntervalSec: 86400 } });
    expect(calls.ticks).toEqual([{ status: 'gated', gate: 'no-trigger', detail: {
      budgetProvenance: { schemaVersion: 1, supplied: null, resolved: { maxCostUsd: 1, maxIdeators: 6, maxCriticsPerIdea: 2 } },
    } }]);
  });

  it('records a gated tick with gate=circuit when the autoloop fire-gate denies', async () => {
    const { deps, calls } = makeDeps({
      fireGate: async () => ({ allow: false, reason: 'circuit-open', retryAfterSec: 3600 }),
    });
    await runScoutTick(deps);
    expect(calls.ticks).toHaveLength(1);
    expect(calls.ticks[0]).toMatchObject({
      status: 'gated',
      gate: 'circuit',
      detail: { reason: 'circuit-open', retryAfterSec: 3600 },
    });
  });

  it('records a ran tick with generated/routed/deduped counts + spend on a full cycle', async () => {
    const { deps, calls } = makeDeps({
      runCycle: async () => ({
        provenance: [
          { ideaId: 'i1', lens: 'analogical', rail: 'gym', routedRef: 'gym:1' },
          { ideaId: 'i2', lens: 'reframing', rail: 'plan', routedRef: 'plan:x' },
        ],
        costUsd: 0.42,
        ideas: ['a', 'b', 'c', 'd', 'e'],
        scored: ['a', 'b', 'c', 'd', 'e'],
        survivors: ['a', 'b'],
        stop: 'completed',
      }),
    });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
    expect(calls.ticks).toHaveLength(1);
    expect(calls.ticks[0]).toMatchObject({
      status: 'ran',
      ideasGenerated: 5,
      ideasRouted: 2,
      ideasDeduped: 3, // scored − survivors (the critics' prune)
      budgetUsedUsd: 0.42,
      detail: { cycleId: 'cyc-1', reason: 'idle-capacity', stop: 'completed' },
    });
    expect(calls.ticks[0].gate).toBeUndefined();
  });

  it('records zero counts on a ran tick whose cycle reports no stage arrays (minimal ScoutCycleLike)', async () => {
    const { deps, calls } = makeDeps({ runCycle: async () => fakeCycle([]) });
    await runScoutTick(deps);
    expect(calls.ticks[0]).toMatchObject({ status: 'ran', ideasGenerated: 0, ideasRouted: 0, ideasDeduped: 0 });
  });

  it('persists per-ideator slot outcomes on the ran tick detail when the cycle carries them (EI-13119)', async () => {
    const ideators = [
      { lens: 'analogical', ok: true, raw: 3, produced: 0 },
      { lens: 'first-principles', ok: false, raw: 0, produced: 0, error: 'transport boom' },
    ];
    const { deps, calls } = makeDeps({ runCycle: async () => ({ ...fakeCycle([]), ideators }) });
    await runScoutTick(deps);
    expect(calls.ticks[0].status).toBe('ran');
    expect(calls.ticks[0].detail?.ideators).toEqual(ideators);
  });

  it('omits the ideators detail key entirely when the cycle reports none (EI-13119)', async () => {
    const { deps, calls } = makeDeps({ runCycle: async () => fakeCycle([]) });
    await runScoutTick(deps);
    expect(calls.ticks[0].status).toBe('ran');
    expect(calls.ticks[0].detail ?? {}).not.toHaveProperty('ideators');
  });

  it('records an error tick (with the message) when the cycle throws', async () => {
    const { deps, calls } = makeDeps({
      runCycle: async () => {
        throw new Error('llm exploded');
      },
    });
    await runScoutTick(deps);
    expect(calls.ticks).toHaveLength(1);
    expect(calls.ticks[0].status).toBe('error');
    expect(calls.ticks[0].detail).toMatchObject({
      cycleId: 'cyc-1',
      error: 'llm exploded',
      capacityClassifierVersion: 1,
    });
  });

  it('persists a typed no-free-slot denial as a loud versioned error', async () => {
    const denial = Object.assign(new Error('admission unavailable'), {
      admissionDenial: { reason: 'no-free-slot' as const, freeSlots: 0 },
    });
    const { deps, calls } = makeDeps({
      runCycle: async () => {
        throw denial;
      },
    });
    const r = await runScoutTick(deps);
    expect(r.reason).toBe('cycle-error');
    expect(calls.ticks[0]).toMatchObject({
      status: 'error',
      detail: {
        error: 'admission unavailable',
        capacityClassifierVersion: 1,
        admissionDenial: { reason: 'no-free-slot', freeSlots: 0 },
      },
    });
  });

  it('persists typed pool exhaustion as a versioned no-capacity gate', async () => {
    const denial = Object.assign(new Error('pool exhausted'), {
      admissionDenial: { reason: 'rate-limit-blocked' as const, via: 'governor' as const, pausedAccounts: 3, freeSlots: 0 },
    });
    const { deps, calls } = makeDeps({
      runCycle: async () => {
        throw denial;
      },
    });
    const r = await runScoutTick(deps);
    expect(r.reason).toBe('no-capacity');
    expect(calls.ticks[0]).toMatchObject({
      status: 'gated',
      gate: 'no-capacity',
      detail: {
        error: 'pool exhausted',
        capacityClassifierVersion: 1,
        admissionDenial: { reason: 'rate-limit-blocked', via: 'governor', pausedAccounts: 3, freeSlots: 0 },
      },
    });
  });

  it('keeps an UNATTESTED capacity-reason denial a loud error (fail closed, WI-5391)', async () => {
    const denial = Object.assign(new Error('429 rate limit exceeded'), {
      admissionDenial: { reason: 'provider-429' as const },
    });
    const { deps, calls } = makeDeps({
      runCycle: async () => {
        throw denial;
      },
    });
    const r = await runScoutTick(deps);
    expect(r.reason).toBe('cycle-error');
    expect(calls.ticks[0].status).toBe('error');
  });

  /**
   * P-016 (blender-su-grade-integration-2026-08-11, D-020) — the cycle-top POOL PRECHECK.
   *
   * The failure it replaces: with the pool exhausted, ideator calls CLEAR admission, stall
   * downstream and time out at the full 600s cycle budget, landing as `error` ticks that
   * read like a producer defect. The precheck must refuse early and loudly instead — but
   * only on affirmative evidence, and only when NO route is left.
   */
  describe('cycle-top pool precheck (P-016)', () => {
    const exhausted = { probedAtMs: 9, healthyAccounts: 0, codexConfigured: false };

    it('refuses the cycle BEFORE running it when neither claude nor codex is routable', async () => {
      const { deps, calls } = makeDeps({
        runCycle: async () => {
          throw new Error('the cycle must never run when the pool is known-exhausted');
        },
      });
      deps.readPoolSnapshot = async () => exhausted;
      const r = await runScoutTick(deps);
      expect(r).toMatchObject({ fired: false, reason: 'no-capacity' });
      expect(calls.ticks[0]).toMatchObject({
        status: 'gated',
        gate: 'no-capacity',
        detail: { reason: 'pool-exhausted-precheck', precheck: true, poolSnapshotAtFire: exhausted },
      });
    });

    /**
     * THE LIVE SHAPE, measured 2026-08-11T23:12Z and pinned here so this stays honest:
     * `codexHealthyAccounts: 2` with `codexConfigured: false`. The router's own derivation
     * treats codex as unroutable on the `configured` flag, so the precheck must agree with
     * it and gate — the two now share one derivation precisely so they cannot disagree.
     * (That 2-healthy-but-unconfigured codex pool is a SEPARATE defect,
     * EI-20200247707626194; gating loudly surfaces it instead of burying it in timeouts.)
     */
    it('gates on the live production snapshot shape (healthy codex accounts the router cannot use)', async () => {
      const live = { probedAtMs: 9, healthyAccounts: 0, codexHealthyAccounts: 2, codexConfigured: false };
      const { deps, calls } = makeDeps({
        runCycle: async () => {
          throw new Error('must not run');
        },
      });
      deps.readPoolSnapshot = async () => live;
      expect((await runScoutTick(deps)).reason).toBe('no-capacity');
      expect(calls.ticks[0].gate).toBe('no-capacity');
    });

    /**
     * CALIBRATION + the anti-regression that matters most: codex up ⇒ the cycle still runs.
     * Scout falls back to the codex model when claude is walled, so a precheck keyed on
     * claude alone would refuse cycles that codex could serve.
     */
    it('does NOT gate when claude is out but codex is routable — the cycle still runs', async () => {
      const { deps, calls } = makeDeps();
      deps.readPoolSnapshot = async () => ({
        probedAtMs: 9,
        healthyAccounts: 0,
        codexConfigured: true,
        codexCliAccountCount: 1,
      });
      const r = await runScoutTick(deps);
      expect(r.fired).toBe(true);
      expect(calls.ticks[0].status).toBe('ran');
    });

    /**
     * THE TRISTATE. An unreadable gateway must never be able to silence Scout: that would
     * turn a probe outage into a total production stop, strictly worse than the degradation
     * this precheck replaces. Unknown ⇒ run, exactly as before.
     */
    it('does NOT gate on an UNKNOWN snapshot — a probe outage cannot silence the producer', async () => {
      const { deps, calls } = makeDeps();
      deps.readPoolSnapshot = async () => undefined;
      expect((await runScoutTick(deps)).fired).toBe(true);
      expect(calls.ticks[0].status).toBe('ran');

      const { deps: throwing, calls: throwingCalls } = makeDeps();
      throwing.readPoolSnapshot = async () => {
        throw new Error('gateway probe down');
      };
      expect((await runScoutTick(throwing)).fired).toBe(true);
      expect(throwingCalls.ticks[0].status).toBe('ran');
    });

    it('does NOT gate when the snapshot omits healthyAccounts — a missing field is not a zero', async () => {
      const { deps, calls } = makeDeps();
      deps.readPoolSnapshot = async () => ({ probedAtMs: 9, codexConfigured: false });
      expect((await runScoutTick(deps)).fired).toBe(true);
      expect(calls.ticks[0].status).toBe('ran');
    });
  });

  describe('record-time pool-snapshot discrimination (WI-5391 Part B)', () => {
    const http429 = () =>
      Object.assign(new Error('429 from gateway'), {
        admissionDenial: { reason: 'provider-429' as const, via: 'http-429' as const },
      });

    it('records an http-429 denial CONTRADICTED by healthy accounts as a loud error with evidence', async () => {
      const snapshot = { probedAtMs: 123, healthyAccounts: 3, codexConfigured: false };
      const { deps, calls } = makeDeps({ runCycle: async () => { throw http429(); } });
      deps.readPoolSnapshot = async () => snapshot;
      const r = await runScoutTick(deps);
      expect(r.reason).toBe('cycle-error');
      expect(calls.ticks[0]).toMatchObject({
        status: 'error',
        detail: {
          capacityClassifierVersion: 1,
          admissionDenial: { reason: 'provider-429', via: 'http-429' },
          capacityContradicted: true,
          poolSnapshot: snapshot,
        },
      });
    });

    /**
     * P-016 UPDATED THIS FIXTURE, deliberately — read this before "simplifying" it back.
     *
     * This test is about the RECORD-TIME discrimination (WI-5391 Part B): a cycle that
     * ran and then hit a 429 which the gateway's own stats CORROBORATE. It used to return
     * one constant zero-account snapshot for every read, which was fine while nothing
     * consumed the fire-time reading. The P-016 precheck now gates on it, so a constant
     * zero fixture never reaches the cycle at all and this test would silently stop
     * exercising the path it names.
     *
     * The two reads are two INSTANTS the scheduler already documents ("Two instants, two
     * questions, two keys"): healthy AT FIRE (the precheck correctly lets the cycle run),
     * exhausted AT RECORD TIME (the denial is corroborated). That is also the only shape
     * this branch has in production — a pool exhausted before the fire is now short-
     * circuited by the precheck, by design.
     */
    it('gates an http-429 denial CORROBORATED by zero healthy accounts, persisting the snapshot', async () => {
      const snapshot = { probedAtMs: 123, healthyAccounts: 0, codexConfigured: false };
      const { deps, calls } = makeDeps({ runCycle: async () => { throw http429(); } });
      let read = 0;
      deps.readPoolSnapshot = async () =>
        // 1st = cycle-top precheck (healthy ⇒ the cycle runs); 2nd = record time (exhausted).
        read++ === 0 ? { probedAtMs: 120, healthyAccounts: 2, codexConfigured: false } : snapshot;
      const r = await runScoutTick(deps);
      expect(r.reason).toBe('no-capacity');
      expect(calls.ticks[0]).toMatchObject({
        status: 'gated',
        gate: 'no-capacity',
        detail: { poolSnapshot: snapshot },
      });
      expect(calls.ticks[0].detail).not.toHaveProperty('capacityContradicted');
    });

    it('gates on an UNKNOWN snapshot (probe failed / unwired) — the attestation is trusted', async () => {
      const { deps: unwired, calls: unwiredCalls } = makeDeps({ runCycle: async () => { throw http429(); } });
      expect((await runScoutTick(unwired)).reason).toBe('no-capacity');
      expect(unwiredCalls.ticks[0].status).toBe('gated');

      const { deps: throwing, calls: throwingCalls } = makeDeps({ runCycle: async () => { throw http429(); } });
      throwing.readPoolSnapshot = async () => {
        throw new Error('gateway probe down');
      };
      expect((await runScoutTick(throwing)).reason).toBe('no-capacity');
      expect(throwingCalls.ticks[0].status).toBe('gated');
    });

    it('does NOT cross-check a governor-attested wall against gateway stats (different pool authority)', async () => {
      // WI-5436 note: this test used to assert the pool was never probed at all for a
      // governor denial. The probe now happens at CYCLE-TOP for a different question
      // (see the poolSnapshotAtFire suite below). The invariant it exists to protect is
      // unchanged and asserted directly: a governor denial is never CONTRADICTED, and
      // the record-time `poolSnapshot` evidence key stays absent.
      const denial = Object.assign(new Error('pool exhausted'), {
        admissionDenial: { reason: 'rate-limit-blocked' as const, via: 'governor' as const },
      });
      const { deps, calls } = makeDeps({ runCycle: async () => { throw denial; } });
      deps.readPoolSnapshot = async () => ({ probedAtMs: 1, healthyAccounts: 5, codexConfigured: false });
      const r = await runScoutTick(deps);
      expect(r.reason).toBe('no-capacity');
      expect(calls.ticks[0].status).toBe('gated');
      expect(calls.ticks[0].detail).not.toHaveProperty('capacityContradicted');
      expect(calls.ticks[0].detail).not.toHaveProperty('poolSnapshot');
    });
  });

  describe('cycle-top pool snapshot — the failover-vs-exhaustion discriminator (WI-5436)', () => {
    const governorDenial = () =>
      Object.assign(new Error('rate-limit pause exceeds maxWait'), {
        admissionDenial: {
          reason: 'rate-limit-blocked' as const,
          via: 'governor' as const,
          totalAccounts: 2,
          pausedAccounts: 1,
        },
      });

    it('stamps healthyAccounts on a GOVERNOR-denied gated tick — the case the record-time read never saw', async () => {
      // The live repro: 2026-07-19T01:09:56Z recorded via:'governor' with pausedAccounts:1
      // of totalAccounts:2 and NO pool key at all, leaving "failover skipped a healthy
      // account" and "the pool was genuinely empty" indistinguishable.
      const atFire = { probedAtMs: 1, healthyAccounts: 1, codexConfigured: false };
      const { deps, calls } = makeDeps({ runCycle: async () => { throw governorDenial(); } });
      deps.readPoolSnapshot = async () => atFire;
      const r = await runScoutTick(deps);
      expect(r.reason).toBe('no-capacity');
      expect(calls.ticks[0]).toMatchObject({
        status: 'gated',
        gate: 'no-capacity',
        detail: { poolSnapshotAtFire: atFire },
      });
      // Widening WHEN the pool is read must not widen WHAT counts as contradicted.
      expect(calls.ticks[0].detail).not.toHaveProperty('capacityContradicted');
    });

    it('stamps the pool baseline on a SUCCESSFUL cycle, so a gated tick has something to compare against', async () => {
      const atFire = { probedAtMs: 1, healthyAccounts: 2, codexConfigured: false };
      const { deps, calls } = makeDeps({});
      deps.readPoolSnapshot = async () => atFire;
      const r = await runScoutTick(deps);
      expect(r.fired).toBe(true);
      expect(calls.ticks[0]).toMatchObject({ status: 'ran', detail: { poolSnapshotAtFire: atFire } });
    });

    it('stamps a NON-capacity error tick too (a genuine failure still reports the pool it ran against)', async () => {
      const { deps, calls } = makeDeps({
        runCycle: async () => {
          throw new Error('transport died');
        },
      });
      deps.readPoolSnapshot = async () => ({ probedAtMs: 1, healthyAccounts: 4, codexConfigured: false });
      const r = await runScoutTick(deps);
      expect(r.reason).toBe('cycle-error');
      expect(calls.ticks[0]).toMatchObject({
        status: 'error',
        detail: { poolSnapshotAtFire: { healthyAccounts: 4 } },
      });
    });

    it('is best-effort — a probe that throws omits the key and never fails the tick', async () => {
      const { deps, calls } = makeDeps({});
      deps.readPoolSnapshot = async () => {
        throw new Error('gateway probe down');
      };
      const r = await runScoutTick(deps);
      expect(r.fired).toBe(true);
      expect(calls.ticks[0].status).toBe('ran');
      expect(calls.ticks[0].detail).not.toHaveProperty('poolSnapshotAtFire');
    });

    it('does NOT probe on a tick the cadence gate withheld (no cycle fired, nothing to describe)', async () => {
      let probed = 0;
      const { deps, calls } = makeDeps({ state: { idleRatio: 0, frictionSignals: 0, lastRunAtMs: NOW - 60_000 } });
      deps.readPoolSnapshot = async () => {
        probed += 1;
        return { probedAtMs: 1, healthyAccounts: 1, codexConfigured: false };
      };
      const r = await runScoutTick(deps, { cadence: { minIntervalSec: 3600 } });
      expect(r.fired).toBe(false);
      expect(probed).toBe(0);
      expect(calls.ticks[0].status).toBe('gated');
      expect(calls.ticks[0].detail ?? {}).not.toHaveProperty('poolSnapshotAtFire');
    });
  });

  describe('cross-provider fallback trail on tick detail (WI-5391 item 3)', () => {
    const fallbackEvent = {
      from: 'claude-opus-4-8',
      to: 'chatgpt:5.5:low',
      succeeded: true,
      via: 'http-429',
      reason: 'provider-429',
    };

    it('persists capacityFallbacks from a returned cycle on the ran-tick detail', async () => {
      const { deps, calls } = makeDeps({
        runCycle: async () => ({ ...fakeCycle(), capacityFallbacks: [fallbackEvent] }),
      });
      await runScoutTick(deps);
      expect(calls.ticks[0].status).toBe('ran');
      expect(calls.ticks[0].detail).toMatchObject({ capacityFallbacks: [fallbackEvent] });
    });

    it('omits the key entirely when no fallback happened', async () => {
      const { deps, calls } = makeDeps();
      await runScoutTick(deps);
      expect(calls.ticks[0].detail ?? {}).not.toHaveProperty('capacityFallbacks');
    });

    it('persists capacityFallbacks riding a THROWN capacity denial on the gated tick detail', async () => {
      // A throwing cycle can't return its trail — the runner attaches it to the error.
      const denial = Object.assign(new Error('pool exhausted'), {
        admissionDenial: { reason: 'rate-limit-blocked' as const, via: 'governor' as const },
        capacityFallbacks: [{ ...fallbackEvent, succeeded: false, via: 'governor', reason: 'rate-limit-blocked' }],
      });
      const { deps, calls } = makeDeps({ runCycle: async () => { throw denial; } });
      const r = await runScoutTick(deps);
      expect(r.reason).toBe('no-capacity');
      expect(calls.ticks[0]).toMatchObject({
        status: 'gated',
        gate: 'no-capacity',
        detail: {
          capacityFallbacks: [{ ...fallbackEvent, succeeded: false, via: 'governor', reason: 'rate-limit-blocked' }],
        },
      });
    });

    it('persists capacityFallbacks riding a THROWN plain error on the error tick detail', async () => {
      const err = Object.assign(new Error('llm exploded after fallback'), {
        capacityFallbacks: [{ ...fallbackEvent, succeeded: false }],
      });
      const { deps, calls } = makeDeps({ runCycle: async () => { throw err; } });
      const r = await runScoutTick(deps);
      expect(r.reason).toBe('cycle-error');
      expect(calls.ticks[0]).toMatchObject({
        status: 'error',
        detail: { capacityFallbacks: [{ ...fallbackEvent, succeeded: false }] },
      });
    });
  });

  it('records an error tick, aborts the cycle, and releases the fire as error when the cycle times out', async () => {
    let cycleSignal: AbortSignal | undefined;
    const { deps, calls } = makeDeps({
      runCycle: ({ signal, onPhase }) => {
        cycleSignal = signal;
        onPhase?.('critique');
        return new Promise(() => undefined);
      },
    });
    const r = await runScoutTick(deps, { cycleTimeoutMs: 5 });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('cycle-error');
    expect(r.error).toContain('Scout cycle timed out after 5ms during phase critique');
    expect(cycleSignal?.aborted).toBe(true);
    expect(calls.fire).toEqual(['attempt', 'error']);
    expect(calls.ticks).toHaveLength(1);
    expect(calls.ticks[0].status).toBe('error');
    expect(calls.ticks[0].detail).toMatchObject({
      cycleId: 'cyc-1',
      error: 'Scout cycle timed out after 5ms during phase critique',
      timeoutMs: 5,
      phase: 'critique',
    });
    expect(typeof calls.ticks[0].detail?.elapsedMs).toBe('number');
  });

  it('is best-effort: a throwing recorder never fails the tick (gated and ran paths)', async () => {
    const boom = vi.fn(async () => {
      throw new Error('pg down');
    });
    const ran = await runScoutTick(makeDeps({ recordTick: boom }).deps);
    expect(ran.fired).toBe(true);
    const gated = await runScoutTick(
      makeDeps({ recordTick: boom, state: { idleRatio: 0, lastRunAtMs: NOW - 1000 } }).deps,
    );
    expect(gated.fired).toBe(false);
    expect(gated.reason).toBe('min-interval');
    expect(boom).toHaveBeenCalledTimes(2);
  });

  it('runs fine with no recorder dep at all (recordTick is optional)', async () => {
    const { deps } = makeDeps();
    delete (deps as Partial<ScoutTickDeps>).recordTick;
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
  });
});

describe('runScoutTick — gate ordering + uncovered exits (scout-loop-test-plan P-005)', () => {
  it('checks the cadence gate BEFORE the fire-gate: a withheld tick never consults the circuit', async () => {
    const fireGate = vi.fn(async () => ({ allow: false as const }));
    const { deps } = makeDeps({ fireGate, state: { idleRatio: 0, frictionSignals: 0, lastRunAtMs: NOW - 1000 } });
    const r = await runScoutTick(deps);
    expect(r.reason).toBe('min-interval');
    expect(fireGate).not.toHaveBeenCalled();
  });

  it('mints the default cycle id from the cadence-state clock (scout-<nowMs>)', async () => {
    const { deps } = makeDeps();
    delete (deps as Partial<ScoutTickDeps>).newCycleId;
    const r = await runScoutTick(deps);
    expect(r.cycleId).toBe(`scout-${NOW}`);
  });

  it('reports cycle-error (attempt+error) when provenance persistence fails after a good cycle', async () => {
    const { deps, calls } = makeDeps({
      persistRouted: async () => {
        throw new Error('pg down');
      },
    });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('cycle-error');
    expect(r.error).toContain('pg down');
    expect(calls.fire).toEqual(['attempt', 'error']);
    expect(calls.ticks[0].status).toBe('error');
  });

  it('invalid budget overrides resolve to the defaults before reaching the cycle', async () => {
    const { deps, calls } = makeDeps();
    await runScoutTick(deps, { budget: { maxCostUsd: -3, maxIdeators: 0 } });
    expect(calls.ranBudget).toBe(1.0); // DEFAULT_SCOUT_BUDGET.maxCostUsd, not -3
  });

  it('tolerates a cycle result with no provenance field (defensive ?? [])', async () => {
    const { deps, calls } = makeDeps({ runCycle: async () => ({}) as ScoutCycleLike });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
    expect(r.routedCount).toBe(0);
    expect(calls.persisted).toBe(0);
  });
});

describe('runScoutTick — double-fire / overlapping ticks (scout-loop-test-plan P-005)', () => {
  /**
   * Shared-state deps mirroring the PRODUCTION clock seam: autoloop recordFire
   * sets last_fired_at = now() on EVERY outcome (attempt/ok/error), and
   * readCadenceState reads it back as lastRunAtMs on the next tick. The only
   * re-fire protection runScoutTick has is that read-back through the cadence
   * min-interval floor.
   */
  function sharedClockDeps() {
    const shared = { lastRunAtMs: null as number | null };
    const calls = { cycles: 0, fire: [] as string[], ticks: [] as ScoutTickRecord[] };
    const deps: ScoutTickDeps = {
      readCadenceState: async () => ({
        idleRatio: 1,
        frictionSignals: 0,
        lastRunAtMs: shared.lastRunAtMs,
        nowMs: NOW,
      }),
      runCycle: async () => {
        calls.cycles += 1;
        return { provenance: [] };
      },
      persistRouted: async () => {},
      // Mirrors autoloop.claimFire's CAS: win only while the shared slot still
      // matches what this tick read; the winner stamps it (last_fired_at=now()).
      claimFire: async (expected) => {
        if (shared.lastRunAtMs !== expected) return false;
        shared.lastRunAtMs = NOW;
        return true;
      },
      recordFire: async (o) => {
        calls.fire.push(o);
        shared.lastRunAtMs = NOW; // autoloop: last_fired_at = now()
      },
      recordTick: async (rec) => {
        calls.ticks.push(rec);
      },
      newCycleId: () => 'cyc-dbl',
    };
    return { deps, calls };
  }

  it('SEQUENTIAL ticks are idempotent: the second tick is gated by the min-interval floor', async () => {
    const { deps, calls } = sharedClockDeps();
    const first = await runScoutTick(deps);
    const second = await runScoutTick(deps);
    expect(first.fired).toBe(true);
    expect(second.fired).toBe(false);
    expect(second.reason).toBe('min-interval');
    expect(calls.cycles).toBe(1); // exactly one cycle across both ticks
  });

  it('EI-304 FIXED: two OVERLAPPING ticks collapse to ONE cycle via the single-flight claim', async () => {
    // The historical defect (pinned here until 2026-06-11): runScoutTick was
    // check-then-act — both overlapping ticks snapshotted stale lastRunAtMs,
    // both passed the min-interval floor, both ran a full budgeted cycle.
    // The fix is the claimFire CAS step between the gates and the cycle:
    // exactly one tick wins the claim; the loser exits as a gated no-op with
    // reason 'claim-lost'. (Production wiring: autoloop.claimFire — a CAS
    // UPDATE on autoloop_state.last_fired_at, cross-process correct.)
    const { deps, calls } = sharedClockDeps();
    const [a, b] = await Promise.all([runScoutTick(deps), runScoutTick(deps)]);
    const winner = a.fired ? a : b;
    const loser = a.fired ? b : a;
    expect(winner.fired).toBe(true);
    expect(loser.fired).toBe(false);
    expect(loser.reason).toBe('claim-lost');
    expect(calls.cycles).toBe(1); // exactly one cycle across overlapping ticks
    expect(calls.fire.filter((o) => o === 'attempt')).toHaveLength(1);
    expect(calls.ticks.filter((t) => t.status === 'ran')).toHaveLength(1);
    expect(calls.ticks.filter((t) => t.status === 'gated' && t.gate === 'claim-lost')).toHaveLength(1);
  });

  it('EI-1600: a RECENT fire-slot clock does NOT gate a real cycle — the floor measures the last RUN', async () => {
    // The dormancy bug: lastRunAtMs was sourced from the autoloop fire-ATTEMPT clock
    // (advanced by a hung/errored fire that never ran a cycle), so the min-interval
    // floor gated every real cycle as 'min-interval' (~24h dark). Now the cadence
    // floor measures the last RUN (lastRunAtMs = last scout_ticks 'ran') and the
    // single-flight claim CAS's against the SEPARATE fire-slot clock (fireSlotLastMs).
    const claimExpected: Array<number | null> = [];
    const calls = { cycles: 0 };
    const deps: ScoutTickDeps = {
      // last RUN is long ago (3h), but the fire-slot was just stamped (1 min ago).
      readCadenceState: async () => ({
        idleRatio: 0,
        frictionSignals: 0,
        lastRunAtMs: NOW - 3 * 3600_000,
        fireSlotLastMs: NOW - 60_000,
        nowMs: NOW,
      }),
      runCycle: async () => {
        calls.cycles += 1;
        return { provenance: [] };
      },
      persistRouted: async () => {},
      claimFire: async (expected) => {
        claimExpected.push(expected);
        return true;
      },
      recordFire: async () => {},
      recordTick: async () => {},
      newCycleId: () => 'cyc-1600',
    };
    const r = await runScoutTick(deps, { cadence: { minIntervalSec: 3600, maxIntervalSec: 3600 } });
    // Floor is measured from the last RUN (3h ago) → fires (heartbeat), NOT gated.
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('heartbeat');
    expect(calls.cycles).toBe(1);
    // The single-flight claim CAS'd against the FIRE-SLOT clock, not the cadence clock.
    expect(claimExpected).toEqual([NOW - 60_000]);
  });

  it('EI-1600: claimFire falls back to lastRunAtMs when fireSlotLastMs is absent (unit-test fakes)', async () => {
    const claimExpected: Array<number | null> = [];
    const deps: ScoutTickDeps = {
      readCadenceState: async () => ({ idleRatio: 1, frictionSignals: 0, lastRunAtMs: NOW - 3600_000, nowMs: NOW }),
      runCycle: async () => ({ provenance: [] }),
      persistRouted: async () => {},
      claimFire: async (expected) => {
        claimExpected.push(expected);
        return true;
      },
      recordFire: async () => {},
      recordTick: async () => {},
      newCycleId: () => 'cyc-fallback',
    };
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
    expect(claimExpected).toEqual([NOW - 3600_000]); // fell back to lastRunAtMs (no fireSlotLastMs)
  });

  it('production wiring includes the single-flight claim (buildScoutTickDeps)', async () => {
    const deps = buildScoutTickDeps({
      harnessSlug: 'papercup',
      runCycle: async () => ({ provenance: [] }),
      readIdleRatio: async () => 1,
      readFrictionSignals: async () => 0,
    });
    expect(typeof deps.claimFire).toBe('function');
  });

  it('production wiring includes the revision-request channel (buildScoutTickDeps)', async () => {
    const deps = buildScoutTickDeps({
      harnessSlug: 'papercusp',
      runCycle: async () => ({ provenance: [] }),
      readIdleRatio: async () => 1,
      readFrictionSignals: async () => 0,
    });
    expect(typeof deps.readRevisionRequests).toBe('function');
    expect(typeof deps.ackRevisionRequests).toBe('function');
  });
});

describe('runScoutTick — steward/reviewer→Scout revision requests', () => {
  const item = (planSlug: string): ScoutRevisionRequest => ({
    planSlug,
    body: 'tighten the Now block',
    fromOwnerId: 'q-1',
    msgId: `m-${planSlug}`,
    ts: '2026-06-08T11:00:00Z',
  });

  function depsWithFeedback(opts: {
    feedback: ScoutRevisionRequest[];
    idleRatio?: number;
    lastRunAtMs?: number | null;
    runCycle?: ScoutTickDeps['runCycle'];
    readThrows?: boolean;
  }): {
    deps: ScoutTickDeps;
    seen: { threaded?: ScoutRevisionRequest[]; acked: ScoutRevisionRequest[][]; cycleRan: boolean };
  } {
    const seen = {
      threaded: undefined as ScoutRevisionRequest[] | undefined,
      acked: [] as ScoutRevisionRequest[][],
      cycleRan: false,
    };
    const deps: ScoutTickDeps = {
      readCadenceState: async () => ({
        idleRatio: opts.idleRatio ?? 0,
        frictionSignals: 0,
        // honor an EXPLICIT null (never-run); default 1m-ago so the normal floor would gate
        lastRunAtMs: 'lastRunAtMs' in opts ? (opts.lastRunAtMs ?? null) : NOW - 60_000,
        nowMs: NOW,
      }),
      readRevisionRequests: async () => {
        if (opts.readThrows) throw new Error('coord down');
        return opts.feedback;
      },
      ackRevisionRequests: async (items) => {
        seen.acked.push(items);
      },
      runCycle:
        opts.runCycle ??
        (async ({ revisionRequests }) => {
          seen.cycleRan = true;
          seen.threaded = revisionRequests;
          return { provenance: [], costUsd: 0.2 };
        }),
      persistRouted: async () => {},
      recordFire: async () => {},
      newCycleId: () => 'cyc-qf',
    };
    return { deps, seen };
  }

  it('fires out-of-cadence past the floor, threads feedback into runCycle, acks on success', async () => {
    const fb = [item('scout-a-2026-06-20')];
    const { deps, seen } = depsWithFeedback({ feedback: fb, lastRunAtMs: NOW - 60_000 });
    const r = await runScoutTick(deps, { cadence: { minIntervalSec: 3600 } });
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('revision-request');
    expect(seen.cycleRan).toBe(true);
    expect(seen.threaded).toEqual(fb);
    expect(seen.acked).toEqual([fb]); // acked exactly once, on success
  });

  it('does NOT ack when the revision cycle throws (feedback re-fires next tick)', async () => {
    const fb = [item('scout-b-2026-06-20')];
    const { deps, seen } = depsWithFeedback({
      feedback: fb,
      runCycle: async () => {
        throw new Error('llm down');
      },
    });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('cycle-error');
    expect(seen.acked).toEqual([]); // NOT acked → retried next tick
  });

  it('no feedback → normal cadence; nothing threaded, nothing acked', async () => {
    const { deps, seen } = depsWithFeedback({ feedback: [], idleRatio: 1, lastRunAtMs: null });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('idle-capacity'); // NOT revision-request
    expect(seen.threaded).toBeUndefined(); // ctx.revisionRequests not passed when empty
    expect(seen.acked).toEqual([]);
  });

  it('a throwing readRevisionRequests is swallowed — falls back to normal cadence', async () => {
    const { deps } = depsWithFeedback({
      feedback: [item('x-2026-06-20')],
      readThrows: true,
      lastRunAtMs: NOW - 60_000,
    });
    const r = await runScoutTick(deps, { cadence: { minIntervalSec: 3600 } });
    // the read threw → no feedback → the 1m-ago run is gated by the floor
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('min-interval');
  });

  it('records revision-request in the tick observability row', async () => {
    const fb = [item('scout-c-2026-06-20')];
    const ticks: import('./tick-ledger').ScoutTickRecord[] = [];
    const { deps } = depsWithFeedback({ feedback: fb });
    deps.recordTick = async (rec) => {
      ticks.push(rec);
    };
    await runScoutTick(deps, { cadence: { minIntervalSec: 3600 } });
    const ran = ticks.find((t) => t.status === 'ran');
    expect(ran?.detail?.reason).toBe('revision-request');
    expect(ran?.detail?.revisionRequestCount).toBe(1);
  });
});

describe('groundingLaneHistogram (blender-self-learning-2026-07-12 P-006)', () => {
  it('buckets refs by lane prefix and counts them', async () => {
    const { groundingLaneHistogram } = await import('./scheduler');
    expect(
      groundingLaneHistogram([
        { addressesPatternRefs: ['rubric:r#c@h', 'wi:12', 'spend:attribution-gap'] },
        { addressesPatternRefs: ['fact:workspace:k', 'niche:n1', 'rubric:r2#c@h', 'owner-correction:idea:i1'] },
        { addressesPatternRefs: ['knowledge:search-miss:docs:q', 'plan-health:stale-backlog:h:p'] },
        {},
      ]),
    ).toEqual({
      'rubric-rating': 2,
      corpus: 1,
      'standing-fact': 1,
      'niche-map': 1,
      'spend-anomaly': 1,
      'owner-correction': 1,
      'knowledge-reuse-gap': 1,
      'plan-health': 1,
    });
  });

  it('empty provenance yields an empty histogram (detail key omitted upstream)', async () => {
    const { groundingLaneHistogram } = await import('./scheduler');
    expect(groundingLaneHistogram([])).toEqual({});
  });
});

describe('persistRoutedRecordsIsolated — per-record error isolation (WI-6338)', () => {
  const rec = (ideaId: string): ScoutRoutedRecord => ({
    ideaId,
    lens: 'first-principles',
    rail: 'improvement',
    routedRef: `wi:${ideaId}`,
  });

  it('a failing record does not abort the batch — every sibling still gets written', async () => {
    const written: string[] = [];
    const write = vi.fn(async (r: ScoutRoutedRecord) => {
      if (r.ideaId === 'bad') throw new Error('insert failed');
      written.push(r.ideaId);
    });
    const errors: Array<{ ideaId: string; message: string }> = [];
    await persistRoutedRecordsIsolated([rec('a'), rec('bad'), rec('c')], write, (r, e) =>
      errors.push({ ideaId: r.ideaId, message: e instanceof Error ? e.message : String(e) }),
    );
    // Pre-fix (a bare for-loop with no try/catch) this would have thrown out of
    // the loop after 'bad', so 'c' would never be attempted — the exact WI-6338
    // divergence mechanism (issue captured+tagged, but no scout_routed_ideas row).
    expect(written).toEqual(['a', 'c']);
    expect(write).toHaveBeenCalledTimes(3);
    expect(errors).toEqual([{ ideaId: 'bad', message: 'insert failed' }]);
  });

  it('no failures ⇒ every record written, onError never called', async () => {
    const write = vi.fn(async () => {});
    const onError = vi.fn();
    await persistRoutedRecordsIsolated([rec('a'), rec('b')], write, onError);
    expect(write).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('onError is optional — a failure is swallowed rather than thrown', async () => {
    const write = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(persistRoutedRecordsIsolated([rec('a')], write)).resolves.toBeUndefined();
  });
});
