import { describe, expect, it } from 'vitest';
import type { FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import {
  FROZEN_REPAIR_BOUNDED_LIFE_HISTORY_CAP,
  FROZEN_REPAIR_BOUNDED_LIFE_MAX_AGE_MS,
  FROZEN_REPAIR_BOUNDED_LIFE_RETIRE_WINDOW_MS,
  buildFrozenRepairBoundedLifeRecord,
  decideFrozenRepairBoundedLife,
  frozenRepairBoundedLifeStateAfterEscalation,
  frozenRepairBoundedLifeStateAfterRetire,
  frozenRepairConvergenceTrajectory,
  parseFrozenRepairBoundedLifeState,
  planFrozenRepairCarry,
  type FrozenRepairBoundedLifeRecord,
} from './frozen-repair-bounded-life';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const C = 'c'.repeat(40);
const H = 'd'.repeat(40);

function queue(counts: number[], ageMs: number, extra: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue {
  return {
    schemaVersion: 4,
    phase: 'awaiting-fixer',
    candidate: C,
    base: null,
    repairHead: H,
    attempts: 1,
    openedAtMs: NOW - ageMs,
    updatedAtMs: NOW - 1,
    fixerSpawnId: null,
    failingTests: [],
    signature: [],
    convergenceRounds: counts.map((failingCount, index) => ({ round: index + 1, head: H, failingCount, atMs: NOW })),
    ...extra,
  };
}

function record(retiredAtMs: number, candidate = C): FrozenRepairBoundedLifeRecord {
  const decision = decideFrozenRepairBoundedLife(queue([3, 5, 8, 12, 28], HOUR), { nowMs: NOW, state: null });
  if (decision.kind !== 'retire') throw new Error('fixture must retire');
  return {
    ...buildFrozenRepairBoundedLifeRecord({
      queue: queue([3, 5, 8, 12, 28], HOUR, { candidate }),
      decision,
      nowMs: retiredAtMs,
      target: { sha: 'e'.repeat(40), source: 'staging-tip' },
      carry: { carriedPaths: [{ path: 'a.ts', status: 'contained' }], readmitPaths: [], truncated: false },
    }),
  };
}

describe('P-021 convergence trajectory', () => {
  it('counts rounds since the last strict new low; ties are not new lows', () => {
    expect(frozenRepairConvergenceTrajectory([])).toEqual({
      roundsRecorded: 0,
      comparableRounds: 0,
      roundsSinceLow: 0,
      lowestFailingCount: null,
      latestFailingCount: null,
    });
    expect(frozenRepairConvergenceTrajectory(queue([3, 5, 8, 12, 28], 0).convergenceRounds)).toMatchObject({
      roundsSinceLow: 4,
      lowestFailingCount: 3,
      latestFailingCount: 28,
    });
    expect(frozenRepairConvergenceTrajectory(queue([4, 4, 4, 4, 4], 0).convergenceRounds).roundsSinceLow).toBe(4);
    expect(frozenRepairConvergenceTrajectory(queue([10, 8, 9, 9, 6], 0).convergenceRounds).roundsSinceLow).toBe(0);
  });

  it('orders by the stable round number, not array position', () => {
    const rounds = queue([3, 5, 8, 12, 28], 0).convergenceRounds ?? [];
    expect(frozenRepairConvergenceTrajectory([...rounds].reverse()).roundsSinceLow).toBe(4);
  });
});

describe('P-021 bounded-life decision', () => {
  it('stays within bounds at 3 rounds without a low and at exactly 24h', () => {
    expect(decideFrozenRepairBoundedLife(queue([3, 5, 8, 12], HOUR), { nowMs: NOW, state: null }).kind).toBe('within-bounds');
    expect(
      decideFrozenRepairBoundedLife(queue([10, 8], FROZEN_REPAIR_BOUNDED_LIFE_MAX_AGE_MS), { nowMs: NOW, state: null }).kind,
    ).toBe('within-bounds');
  });

  it('retires on 4 rounds without a new low, and on age past 24h even while improving', () => {
    expect(decideFrozenRepairBoundedLife(queue([3, 5, 8, 12, 28], HOUR), { nowMs: NOW, state: null })).toMatchObject({
      kind: 'retire',
      trigger: 'non-improving',
    });
    expect(
      decideFrozenRepairBoundedLife(queue([10, 8, 6], FROZEN_REPAIR_BOUNDED_LIFE_MAX_AGE_MS + 1), { nowMs: NOW, state: null }),
    ).toMatchObject({ kind: 'retire', trigger: 'age' });
  });

  it('defers while promoting, while an admission pre-check runs, or under a live dispatch reservation', () => {
    const stuck = [3, 5, 8, 12, 28];
    expect(decideFrozenRepairBoundedLife(queue(stuck, HOUR, { phase: 'ready-to-promote' }), { nowMs: NOW, state: null })).toMatchObject({
      kind: 'deferred',
      reason: 'promoting',
    });
    const precheck = {
      schemaVersion: 1 as const, operationId: 'op', status: 'running' as const, candidate: C, repairHead: H,
      builtCommit: H, files: [], actor: 'a', startedAtMs: NOW - 1, updatedAtMs: NOW - 1, expiresAtMs: NOW + HOUR,
    };
    expect(decideFrozenRepairBoundedLife(queue(stuck, HOUR, { admissionPrecheck: precheck }), { nowMs: NOW, state: null })).toMatchObject({
      kind: 'deferred',
      reason: 'admission-precheck-running',
    });
    expect(
      decideFrozenRepairBoundedLife(queue(stuck, HOUR, { admissionPrecheck: { ...precheck, expiresAtMs: NOW - 1 } }), { nowMs: NOW, state: null }).kind,
    ).toBe('retire');
    expect(
      decideFrozenRepairBoundedLife(
        queue(stuck, HOUR, { dispatchReservation: { token: 't', claimedAtMs: NOW - 1, expiresAtMs: NOW + 1 } }),
        { nowMs: NOW, state: null },
      ),
    ).toMatchObject({ kind: 'deferred', reason: 'dispatch-reserved' });
  });

  it('rate-limits a second retirement inside 24h and escalates once per candidate', () => {
    const last = record(NOW - 2 * HOUR, 'f'.repeat(40));
    const state = frozenRepairBoundedLifeStateAfterRetire(null, last);
    expect(decideFrozenRepairBoundedLife(queue([3, 5, 8, 12, 28], HOUR), { nowMs: NOW, state })).toMatchObject({
      kind: 'rate-limited',
      escalate: true,
      lastRetireAtMs: NOW - 2 * HOUR,
      retryAfterMs: FROZEN_REPAIR_BOUNDED_LIFE_RETIRE_WINDOW_MS - 2 * HOUR,
    });
    const escalated = frozenRepairBoundedLifeStateAfterEscalation(state, {
      candidate: C,
      trigger: 'non-improving',
      atMs: NOW - 1,
      lastRetireAtMs: last.retiredAtMs,
    });
    expect(decideFrozenRepairBoundedLife(queue([3, 5, 8, 12, 28], HOUR), { nowMs: NOW, state: escalated })).toMatchObject({
      kind: 'rate-limited',
      escalate: false,
    });
    const expired = frozenRepairBoundedLifeStateAfterRetire(null, record(NOW - FROZEN_REPAIR_BOUNDED_LIFE_RETIRE_WINDOW_MS));
    expect(decideFrozenRepairBoundedLife(queue([3, 5, 8, 12, 28], HOUR), { nowMs: NOW, state: expired }).kind).toBe('retire');
  });
});

describe('P-021 carry', () => {
  const T = 't'.repeat(40);
  const admitted = (paths: string[], blobs: Record<string, string | null>) =>
    queue([], 0, {
      admissions: [
        { atMs: 1, actor: 'a', source: { ref: 'staging', sha: T }, fromRepairHead: C, toRepairHead: H, paths, unchanged: [], blobs },
      ],
    });

  it('classifies each admitted path against the target by content', async () => {
    const atTarget: Record<string, string | null> = { 'same.ts': 'b1', 'newer.ts': 'b9', 'gone.ts': null, 'deleted.ts': null };
    const result = await planFrozenRepairCarry({
      queue: admitted(['same.ts', 'newer.ts', 'gone.ts', 'deleted.ts', 'broken.ts'], {
        'same.ts': 'b1', 'newer.ts': 'b2', 'gone.ts': 'b3', 'deleted.ts': null, 'broken.ts': 'b4',
      }),
      target: { sha: T, source: 'staging-tip' },
      blobAt: async (_sha, path) => {
        if (path === 'broken.ts') throw new Error('git failed');
        return atTarget[path] ?? null;
      },
    });
    expect(result.carriedPaths).toEqual([
      { path: 'broken.ts', status: 'unverified' },
      { path: 'deleted.ts', status: 'contained' },
      { path: 'gone.ts', status: 'absent-at-target' },
      { path: 'newer.ts', status: 'superseded' },
      { path: 'same.ts', status: 'contained' },
    ]);
    // A staging-tip re-cut never needs re-admission: every admission came from staging.
    expect(result.readmitPaths).toEqual([]);
  });

  it('lists the paths a known-good target lacks for re-admission', async () => {
    const result = await planFrozenRepairCarry({
      queue: admitted(['fix.ts', 'kept.ts'], { 'fix.ts': 'b1', 'kept.ts': 'b2' }),
      target: { sha: T, source: 'known-good' },
      blobAt: async (_sha, path) => (path === 'kept.ts' ? 'b2' : null),
    });
    expect(result.readmitPaths).toEqual(['fix.ts']);
  });

  it('falls back to the repair head for a legacy admission without blobs', async () => {
    const result = await planFrozenRepairCarry({
      queue: admitted(['legacy.ts'], {}),
      target: { sha: T, source: 'staging-tip' },
      blobAt: async (sha) => (sha === H ? 'head-blob' : 'head-blob'),
    });
    expect(result.carriedPaths).toEqual([{ path: 'legacy.ts', status: 'contained' }]);
  });
});

describe('P-021 state persistence', () => {
  it('round-trips through JSON and bounds the history', () => {
    let state = null as ReturnType<typeof frozenRepairBoundedLifeStateAfterRetire> | null;
    for (let index = 0; index < FROZEN_REPAIR_BOUNDED_LIFE_HISTORY_CAP + 3; index += 1) {
      state = frozenRepairBoundedLifeStateAfterRetire(state, record(NOW - index * HOUR));
    }
    const parsed = parseFrozenRepairBoundedLifeState(JSON.stringify(state));
    expect(parsed?.history).toHaveLength(FROZEN_REPAIR_BOUNDED_LIFE_HISTORY_CAP);
    expect(parsed?.lastRetire).toEqual(state?.lastRetire);
  });

  it('reads malformed state as absent', () => {
    expect(parseFrozenRepairBoundedLifeState(null)).toBeNull();
    expect(parseFrozenRepairBoundedLifeState('{not json')).toBeNull();
    expect(parseFrozenRepairBoundedLifeState({ schemaVersion: 2 })).toBeNull();
    expect(parseFrozenRepairBoundedLifeState({ schemaVersion: 1, lastRetire: { trigger: 'bogus' } })).toMatchObject({
      lastRetire: null,
      history: [],
    });
  });
});
