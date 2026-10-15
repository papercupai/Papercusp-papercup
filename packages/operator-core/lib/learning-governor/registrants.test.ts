/**
 * registrants.test.ts — the flag-gated governor glue (self-learning-frontier
 * P-003 / FB-01). Pins, with injected deps and zero PG/flags IO:
 *   - flag OFF ⇒ every entry point no-ops ('flag-off' / 'governor-dark');
 *   - the gym mirror registers every autoloop row and ledgers a ran cycle's
 *     spend WITHOUT accumulating (gym_autoloop_config stays authoritative);
 *   - the scout mirror registers the per-cycle cap and ACCUMULATES fired spend;
 *   - the never-throws contract (an IO error returns reason:'error');
 *   - the preflight fail-CLOSED contract ('governor-error' on IO failure).
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  learningGovernorPreflight,
  recordGymTickToGovernor,
  recordScoutTickToGovernor,
  runGovernedSpendAttempt,
  type GovernedSpendAttemptInput,
  type GovernorGlueDeps,
} from './registrants';
import type {
  RecordLearningSpendInput,
  RegisterLearningLoopInput,
  ReserveLearningSpendInput,
  ReserveLearningSpendResult,
  SettleLearningSpendResult,
} from './store';
import { cycleReservationRunRef } from './store';

const SQL = {} as Sql;

function fakeDeps(opts: { enabled?: boolean } = {}) {
  const calls = { register: [] as RegisterLearningLoopInput[], spend: [] as RecordLearningSpendInput[], logs: [] as string[] };
  const deps: GovernorGlueDeps = {
    enabled: async () => opts.enabled ?? true,
    getSql: async () => SQL,
    register: async (_sql, input) => {
      calls.register.push(input);
    },
    recordSpend: async (_sql, input) => {
      calls.spend.push(input);
    },
    // P-004: hermetic pot resolve — 'the pot that owns hive-X is hive-X' for
    // hive-shaped slugs, unresolvable otherwise (the workspace-brain case).
    resolvePot: async (q) => (q.harnessSlug.startsWith('hive-') ? q.harnessSlug : null),
    check: async () => ({ allow: true, remainingUsd: 5 }),
    log: (m) => calls.logs.push(m),
  };
  return { deps, calls };
}

/**
 * A governor stub for the attempt seam (P-005): grants what is asked and
 * records every settlement, so a test can assert that an attempt CLOSED and
 * with which disposition.
 */
function fakeAttemptDeps(
  opts: { enabled?: boolean; reserve?: ReserveLearningSpendResult; settleThrows?: boolean; settlement?: SettleLearningSpendResult } = {},
) {
  const settlements: Array<{ disposition: string; usedUsd?: number }> = [];
  const logs: string[] = [];
  const granted: ReserveLearningSpendResult = opts.reserve ?? {
    ok: true,
    clamped: false,
    headroomUsd: 9,
    reservation: {
      id: 'res-1',
      workspaceId: 'w',
      loopId: 'frontier:x',
      potSlug: null,
      attemptKind: 'proposer',
      requestedUsd: 1,
      reservedUsd: 1,
      usedUsd: 0,
      status: 'open',
      signalOrigin: 'organic',
      runRef: null,
      note: null,
      createdAt: 0,
      settledAt: null,
    },
  };
  const deps: GovernorGlueDeps = {
    enabled: async () => opts.enabled ?? true,
    getSql: async () => SQL,
    reserve: async () => granted,
    settle: async (_sql, input) => {
      if (opts.settleThrows) throw new Error('settlement write failed');
      settlements.push({ disposition: input.disposition, usedUsd: input.usedUsd });
      if (opts.settlement) return opts.settlement;
      if (!granted.ok) throw new Error('cannot settle a refused reservation');
      return {
        ok: true,
        reservation: { ...granted.reservation, usedUsd: input.usedUsd ?? 0,
          status: input.disposition === 'used' ? 'settled' : input.disposition, settledAt: 123 },
        event: null,
        releasedUsd: granted.reservation.reservedUsd - (input.usedUsd ?? 0),
        overrunUsd: 0,
      };
    },
    log: (m) => logs.push(m),
  };
  return { deps, settlements, logs };
}

describe('runGovernedSpendAttempt — complete usage settles, incomplete usage remains open', () => {
  const attempt = <T,>(run: GovernedSpendAttemptInput<T>['run']): GovernedSpendAttemptInput<T> => ({
    workspaceId: 'w',
    loopId: 'frontier:x',
    attemptKind: 'proposer',
    requestedUsd: 1,
    run,
  });

  const cycleRunId = '6ac8aa8a-7f50-49ac-9f62-8a89a506a5d9';
  const cycleReservationId = '07850477-4239-41b5-8f0e-dfb5456994dd';
  function cycleDeps() {
    const fixture = fakeAttemptDeps();
    const reserve = fixture.deps.reserve!;
    const requests: ReserveLearningSpendInput[] = [];
    fixture.deps.reserve = async (sql, input) => {
      requests.push(input);
      const receipt = await reserve(sql, input);
      if (!receipt.ok) throw new Error('fixture must grant');
      Object.assign(receipt.reservation, { id: cycleReservationId,
        runRef: cycleReservationRunRef(input.cycle ?? { runId: cycleRunId, budgetUsd: 10 }, cycleReservationId) });
      return receipt;
    };
    return { ...fixture, requests };
  }

  it('forwards a cycle scope to the issuer and settles that attempt with mirror accounting', async () => {
    const { deps, requests } = cycleDeps();
    let settlementInput: unknown;
    const settle = deps.settle!;
    deps.settle = async (sql, input) => { settlementInput = input; return settle(sql, input); };
    const out = await runGovernedSpendAttempt({ ...attempt(async grant => {
      expect(grant.reservationId).toBe(cycleReservationId);
      return { costUsd: 0.4, value: 'native judge' };
    }), cycle: { runId: cycleRunId, budgetUsd: 10 }, accumulate: false }, deps);
    expect(requests[0]).toMatchObject({ cycle: { runId: cycleRunId, budgetUsd: 10 } });
    expect(out).toMatchObject({ ok: true, settlement: { ok: true, reservation: { id: cycleReservationId } } });
    expect(settlementInput).toMatchObject({ reservationId: cycleReservationId, usedUsd: 0.4, accumulate: false });
  });

  it('snapshots the cycle scope before asynchronous admission', async () => {
    const { deps, requests } = cycleDeps();
    let resume!: () => void;
    deps.enabled = () => new Promise(resolve => { resume = () => resolve(true); });
    const cycle = { runId: cycleRunId, budgetUsd: 10 };
    const pending = runGovernedSpendAttempt({ ...attempt(async () => ({ costUsd: 0, value: null })), cycle }, deps);
    cycle.runId = '368d69c4-8ea2-478c-9f9f-3499a914f7d1';
    cycle.budgetUsd = 100;
    resume();
    expect(await pending).toMatchObject({ ok: true });
    expect(requests[0]).toMatchObject({ cycle: { runId: cycleRunId, budgetUsd: 10 } });
  });

  it.each(['foreign-cycle', 'foreign-attempt', 'missing-scope', 'headroom-above-cap'])(
    'refuses a cycle receipt with %s without dispatching or settling', async mismatch => {
      const { deps, settlements } = cycleDeps();
      const reserve = deps.reserve!;
      deps.reserve = async (sql, input) => {
        const receipt = await reserve(sql, input);
        if (!receipt.ok) throw new Error('fixture must grant');
        if (mismatch === 'foreign-cycle') receipt.reservation.runRef = `cycle:${'368d69c4-8ea2-478c-9f9f-3499a914f7d1'}/cap:10000000/attempt:${cycleReservationId}`;
        if (mismatch === 'foreign-attempt') receipt.reservation.runRef = `cycle:${cycleRunId}/cap:10000000/attempt:${cycleRunId}`;
        if (mismatch === 'missing-scope') receipt.reservation.runRef = null;
        if (mismatch === 'headroom-above-cap') receipt.headroomUsd = 11;
        return receipt;
      };
      let ran = false;
      const out = await runGovernedSpendAttempt({ ...attempt(async () => {
        ran = true; return { costUsd: 0, value: null };
      }), cycle: { runId: cycleRunId, budgetUsd: 10 } }, deps);
      expect(ran).toBe(false);
      expect(settlements).toEqual([]);
      expect(out).toMatchObject({ ok: false, reason: 'failed', reservationId: null });
    },
  );

  it('settles a completed attempt as used, at its actual cost', async () => {
    const { deps, settlements } = fakeAttemptDeps();
    const out = await runGovernedSpendAttempt(
      attempt(async () => ({ costUsd: 0.4, value: 'lessons' })),
      deps,
    );
    expect(out).toMatchObject({ ok: true, value: 'lessons', costUsd: 0.4, cancelled: false });
    expect(out).toMatchObject({ settlement: { ok: true, reservation: {
      id: 'res-1', requestedUsd: 1, reservedUsd: 1, usedUsd: 0.4, status: 'settled', settledAt: 123,
    } } });
    expect(settlements).toEqual([{ disposition: 'used', usedUsd: 0.4 }]);
  });

  it.each(['missing', 'arm', 'input', 'output', 'unexpected'] as const)(
    'refuses a substituted cycle resource receipt (%s) before dispatch or settlement', async mismatch => {
      const { deps, settlements } = cycleDeps();
      const resources = { armId: 'judge', inputTokens: 12, outputTokens: 4 };
      const reserve = deps.reserve!;
      deps.reserve = async (sql, input) => {
        const receipt = await reserve(sql, input);
        if (!receipt.ok) throw new Error('fixture must grant');
        if (mismatch !== 'missing') receipt.reservation.resources = { ...resources };
        if (mismatch === 'arm') receipt.reservation.resources!.armId = 'proposer';
        if (mismatch === 'input') receipt.reservation.resources!.inputTokens++;
        if (mismatch === 'output') receipt.reservation.resources!.outputTokens++;
        return receipt;
      };
      const cycle = { runId: cycleRunId, budgetUsd: 10,
        ...(mismatch === 'unexpected' ? {} : { resources,
          expectedResourceBudget: { inputTokens: 24, outputTokens: 8, requestsPerArm: 2, armIds: ['judge'] } }) };
      let dispatched = false;
      const out = await runGovernedSpendAttempt({ ...attempt(async () => {
        dispatched = true; return { costUsd: 0, value: null };
      }), cycle }, deps);
      expect(out).toMatchObject({ ok: false, reason: 'failed', reservationId: null });
      expect(dispatched).toBe(false);
      expect(settlements).toEqual([]);
    },
  );

  it('snapshots configured cycle resources before admission and dispatches immutable admitted bounds', async () => {
    const { deps, requests } = cycleDeps();
    const reserve = deps.reserve!;
    deps.reserve = async (sql, input) => {
      const receipt = await reserve(sql, input);
      if (!receipt.ok) throw new Error('fixture must grant');
      receipt.reservation.resources = { armId: 'judge', inputTokens: 12, outputTokens: 4 };
      return receipt;
    };
    let resume!: () => void;
    deps.enabled = () => new Promise(resolve => { resume = () => resolve(true); });
    const cycle = { runId: cycleRunId, budgetUsd: 10,
      resources: { armId: 'judge', inputTokens: 12, outputTokens: 4 },
      expectedResourceBudget: { inputTokens: 24, outputTokens: 8, requestsPerArm: 2, armIds: ['judge'] } };
    const pending = runGovernedSpendAttempt({ ...attempt(async grant => {
      expect(grant.resources).toEqual({ armId: 'judge', inputTokens: 12, outputTokens: 4 });
      expect(Object.isFrozen(grant.resources)).toBe(true);
      return { costUsd: 0, value: 'judge result' };
    }), cycle, accumulate: false }, deps);
    cycle.resources.outputTokens = 999;
    cycle.expectedResourceBudget.outputTokens = 999;
    cycle.expectedResourceBudget.armIds.push('invented');
    resume();
    expect(await pending).toMatchObject({ ok: true, value: 'judge result' });
    expect(requests[0]).toMatchObject({ cycle: {
      resources: { armId: 'judge', inputTokens: 12, outputTokens: 4 },
      expectedResourceBudget: { inputTokens: 24, outputTokens: 8, requestsPerArm: 2, armIds: ['judge'] },
    } });
  });

  it.each([1, 0.25, 0])('gives work an immutable reservation identity with the actual $%s grant', async reservedUsd => {
    const { deps } = fakeAttemptDeps();
    const reserved = await deps.reserve!(SQL, {} as never);
    if (!reserved.ok) throw new Error('fixture must grant');
    Object.assign(reserved.reservation, { reservedUsd });
    Object.assign(reserved, { clamped: reservedUsd < 1 });
    let seen: unknown;
    const out = await runGovernedSpendAttempt(attempt(async grant => {
      seen = grant;
      expect(grant).toEqual({ reservationId: 'res-1', reservedUsd, clamped: reservedUsd < 1 });
      expect(Object.isFrozen(grant)).toBe(true);
      expect(() => Object.defineProperty(grant, 'reservedUsd', { value: 99 })).toThrow(TypeError);
      return { costUsd: 0, value: 'bounded work' };
    }), deps);
    expect(out).toMatchObject({ ok: true, reservationId: 'res-1', clamped: reservedUsd < 1 });
    expect(seen).toEqual({ reservationId: 'res-1', reservedUsd, clamped: reservedUsd < 1 });
  });

  it('keeps the dispatched grant snapshot when the reservation adapter changes its own result', async () => {
    const { deps } = fakeAttemptDeps();
    const reserved = await deps.reserve!(SQL, {} as never);
    if (!reserved.ok) throw new Error('fixture must grant');
    Object.assign(reserved, { clamped: true });
    reserved.reservation.reservedUsd = 0.25;
    const out = await runGovernedSpendAttempt(attempt(async grant => {
      Object.assign(reserved, { clamped: false });
      Object.assign(reserved.reservation, { reservedUsd: 99 });
      expect(grant).toEqual({ reservationId: 'res-1', reservedUsd: 0.25, clamped: true });
      return { costUsd: 0, value: 'completed' };
    }), deps);
    expect(out).toMatchObject({ ok: true, reservationId: 'res-1', clamped: true });
  });

  it('snapshots the exact reservation policy and settlement identity before asynchronous preflight', async () => {
    const { deps } = fakeAttemptDeps();
    const exact = { reservationId: 'res-1', binding: 'a'.repeat(64), expectedBudgetUsd: 10,
      resources: { armId: 'judge', inputTokens: 12, outputTokens: 4 },
      expectedResourceBudget: { inputTokens: 24, outputTokens: 8, requestsPerArm: 2, armIds: ['judge'] } };
    const input = { ...attempt(async () => ({ costUsd: 0.1, value: 'original work' })),
      exact, floorUsd: 0, accumulate: false };
    const expectedExact = structuredClone(exact);
    const admitted = await deps.reserve!(SQL, {} as never);
    if (!admitted.ok) throw new Error('fixture must grant');
    admitted.reservation.runRef = `manifest:${exact.binding}/attempt:${exact.reservationId}`;
    admitted.reservation.resources = { ...exact.resources };
    let reservedInput: ReserveLearningSpendInput | undefined;
    let settlementWorkspace: string | undefined;
    const reserve = deps.reserve!;
    const settle = deps.settle!;
    deps.enabled = async () => {
      input.workspaceId = 'other-workspace';
      input.loopId = 'other-loop';
      input.requestedUsd = 99;
      input.accumulate = true;
      input.exact.binding = 'b'.repeat(64);
      input.exact.resources.outputTokens = 999;
      input.exact.expectedResourceBudget.armIds.push('invented');
      input.run = async () => { throw new Error('replacement work'); };
      return true;
    };
    deps.reserve = async (sql, request) => { reservedInput = request; return reserve(sql, request); };
    deps.settle = async (sql, request) => {
      settlementWorkspace = request.workspaceId;
      expect(request.accumulate).toBe(false);
      return settle(sql, request);
    };
    const out = await runGovernedSpendAttempt(input, deps);
    expect(reservedInput).toMatchObject({ workspaceId: 'w', loopId: 'frontier:x', requestedUsd: 1,
      floorUsd: 0, exact: expectedExact });
    expect(settlementWorkspace).toBe('w');
    expect(out).toMatchObject({ ok: true, value: 'original work', costUsd: 0.1 });
  });

  it('gives dispatch immutable resource bounds from the actual reservation rather than the request', async () => {
    const { deps } = fakeAttemptDeps();
    const reserved = await deps.reserve!(SQL, {} as never);
    if (!reserved.ok) throw new Error('fixture must grant');
    const resources = { armId: 'judge', inputTokens: 12, outputTokens: 4 };
    reserved.reservation.resources = resources;
    const out = await runGovernedSpendAttempt(attempt(async grant => {
      expect(grant).toMatchObject({ resources: { armId: 'judge', inputTokens: 12, outputTokens: 4 } });
      const dispatched = (grant as unknown as { resources: object }).resources;
      expect(Object.isFrozen(dispatched)).toBe(true);
      expect(() => Object.defineProperty(dispatched, 'outputTokens', { value: 999 })).toThrow(TypeError);
      resources.outputTokens = 999;
      expect(grant).toMatchObject({ resources: { outputTokens: 4 } });
      return { costUsd: 0, value: 'bounded dispatch' };
    }), deps);
    expect(out).toMatchObject({ ok: true, value: 'bounded dispatch', reservationId: 'res-1' });
  });

  it.each([
    ['id', ''], ['id', 1], ['workspaceId', 'foreign'], ['loopId', 'foreign'],
    ['attemptKind', 'evaluation'], ['requestedUsd', 0.5], ['requestedUsd', NaN],
    ['reservedUsd', 2], ['reservedUsd', -1], ['reservedUsd', NaN], ['reservedUsd', Infinity],
    ['reservedUsd', '1'], ['usedUsd', 0.1], ['usedUsd', NaN],
    ['status', 'settled'], ['status', 'failed'], ['status', 'cancelled'],
    ['settledAt', 1], ['settledAt', undefined], ['runRef', 'foreign-run'],
    ['signalOrigin', 'shadow'],
  ])('refuses an inconsistent successful reservation receipt (%s=%s) before dispatch', async (field, value) => {
    const { deps, settlements } = fakeAttemptDeps();
    const admitted = await deps.reserve!(SQL, {} as never);
    if (!admitted.ok) throw new Error('fixture must grant');
    Object.assign(admitted.reservation, { [field as string]: value });
    let ran = false;
    const out = await runGovernedSpendAttempt(attempt(async () => {
      ran = true;
      return { costUsd: 0, value: 'must not dispatch' };
    }), deps);
    expect(ran).toBe(false);
    expect(settlements).toEqual([]);
    expect(out).toMatchObject({ ok: false, reason: 'failed', costUsd: 0,
      reservationId: null, settlement: null, error: 'governor reservation receipt does not match request' });
  });

  it.each([
    { clamped: true }, { clamped: 'false' }, { headroomUsd: 0.5 }, { headroomUsd: NaN },
    { headroomUsd: null }, { reservation: null },
  ])('refuses malformed grant metadata %j without dispatch or settlement', async mutation => {
    const { deps, settlements } = fakeAttemptDeps();
    const admitted = await deps.reserve!(SQL, {} as never);
    Object.assign(admitted, mutation);
    let ran = false;
    const out = await runGovernedSpendAttempt(attempt(async () => {
      ran = true;
      return { costUsd: 0, value: null };
    }), deps);
    expect(ran).toBe(false);
    expect(settlements).toEqual([]);
    expect(out).toMatchObject({ ok: false, reason: 'failed', reservationId: null, settlement: null });
  });

  it.each([
    { armId: '', inputTokens: 12, outputTokens: 4 },
    { armId: 'judge', inputTokens: -1, outputTokens: 4 },
    { armId: 'judge', inputTokens: 1.5, outputTokens: 4 },
    { armId: 'judge', inputTokens: 12, outputTokens: 0 },
    { armId: 'judge', inputTokens: 12, outputTokens: Infinity },
  ])('refuses invalid actual resource bounds %j', async resources => {
    const { deps, settlements } = fakeAttemptDeps();
    const admitted = await deps.reserve!(SQL, {} as never);
    if (!admitted.ok) throw new Error('fixture must grant');
    admitted.reservation.resources = resources;
    let ran = false;
    const out = await runGovernedSpendAttempt(attempt(async () => {
      ran = true;
      return { costUsd: 0, value: null };
    }), deps);
    expect(ran).toBe(false);
    expect(settlements).toEqual([]);
    expect(out).toMatchObject({ ok: false, reason: 'failed', reservationId: null });
  });

  it.each(['id', 'runRef', 'resources', 'reservedUsd', 'potSlug'] as const)(
    'refuses an exact reservation receipt with mismatched %s', async field => {
      const { deps, settlements } = fakeAttemptDeps();
      const admitted = await deps.reserve!(SQL, {} as never);
      if (!admitted.ok) throw new Error('fixture must grant');
      const exact = { reservationId: 'res-1', binding: 'a'.repeat(64), expectedBudgetUsd: 10,
        resources: { armId: 'judge', inputTokens: 12, outputTokens: 4 },
        expectedResourceBudget: { inputTokens: 24, outputTokens: 8, requestsPerArm: 2, armIds: ['judge'] } };
      Object.assign(admitted.reservation, { runRef: `manifest:${exact.binding}/attempt:res-1`,
        resources: { ...exact.resources }, potSlug: 'owned-pot' });
      if (field === 'resources') admitted.reservation.resources!.outputTokens = 999;
      else if (field === 'reservedUsd') {
        admitted.reservation.reservedUsd = 0.25;
        admitted.clamped = true;
      } else Object.assign(admitted.reservation, { [field]: 'foreign' });
      let ran = false;
      const out = await runGovernedSpendAttempt({ ...attempt(async () => {
        ran = true;
        return { costUsd: 0, value: null };
      }), exact, potSlug: 'owned-pot' }, deps);
      expect(ran).toBe(false);
      expect(settlements).toEqual([]);
      expect(out).toMatchObject({ ok: false, reason: 'failed', reservationId: null });
    },
  );

  it.each([null, false, 'resources'])('refuses a non-object resource receipt %s', async resources => {
    const { deps, settlements } = fakeAttemptDeps();
    const admitted = await deps.reserve!(SQL, {} as never);
    if (!admitted.ok) throw new Error('fixture must grant');
    Object.assign(admitted.reservation, { resources });
    let ran = false;
    const out = await runGovernedSpendAttempt(attempt(async () => {
      ran = true;
      return { costUsd: 0, value: null };
    }), deps);
    expect(ran).toBe(false);
    expect(settlements).toEqual([]);
    expect(out).toMatchObject({ ok: false, reason: 'failed', reservationId: null });
  });

  it('settles a PARTIAL attempt at the partial cost, not the reservation', async () => {
    const { deps, settlements } = fakeAttemptDeps();
    const out = await runGovernedSpendAttempt(
      attempt(async () => ({ costUsd: 0.1, value: '3 of 10 tasks' })),
      deps,
    );
    expect(out).toMatchObject({ settlement: { ok: true, reservation: { usedUsd: 0.1, status: 'settled' } } });
    expect(settlements).toEqual([{ disposition: 'used', usedUsd: 0.1 }]);
  });

  it('settles a CANCELLED attempt as cancelled', async () => {
    const { deps, settlements } = fakeAttemptDeps();
    const out = await runGovernedSpendAttempt(
      attempt(async () => ({ costUsd: 0, value: null, cancelled: true })),
      deps,
    );
    expect(out).toMatchObject({ ok: true, cancelled: true });
    expect(out).toMatchObject({ settlement: { ok: true, reservation: { usedUsd: 0, status: 'cancelled' } } });
    expect(settlements).toEqual([{ disposition: 'cancelled', usedUsd: 0 }]);
  });

  it('settles a THROWN attempt as failed, charged for what it burned first', async () => {
    // The proposer case: tokens spent, then the parse blows up. Pre-P-005 this
    // ledgered nothing at all.
    const { deps, settlements } = fakeAttemptDeps();
    const out = await runGovernedSpendAttempt(
      attempt(async () => {
        throw Object.assign(new Error('bad JSON'), { costUsd: 0.02 });
      }),
      deps,
    );
    expect(out).toMatchObject({ ok: false, reason: 'failed', error: 'bad JSON', costUsd: 0.02 });
    expect(out).toMatchObject({ settlement: { ok: true, reservation: { usedUsd: 0.02, status: 'failed' } } });
    expect(settlements).toEqual([{ disposition: 'failed', usedUsd: 0.02 }]);
  });

  it('settles a thrown attempt at zero when nothing was burned', async () => {
    const { deps, settlements } = fakeAttemptDeps();
    await runGovernedSpendAttempt(
      attempt(async () => {
        throw Object.assign(new Error('transcript unreadable before dispatch'), { costUsd: 0 });
      }),
      deps,
    );
    expect(settlements).toEqual([{ disposition: 'failed', usedUsd: 0 }]);
  });

  it.each([0, 0.42])('keeps missing failure usage OPEN while retaining its $%s subtotal', async costUsd => {
    const { deps, settlements } = fakeAttemptDeps();
    const out = await runGovernedSpendAttempt(attempt(async () => {
      throw Object.assign(new Error('pipeline usage incomplete'), { costUsd, costUsdMeasurementMissing: true });
    }), deps);
    expect(out).toMatchObject({ ok: false, reason: 'failed', error: 'pipeline usage incomplete',
      costUsd, costUsdMeasurementMissing: true, reservationId: 'res-1', settlement: null,
      settlementError: 'usage measurement incomplete; reservation remains open' });
    expect(settlements).toEqual([]);
  });

  it.each([false, true])('keeps incomplete successful/cancelled usage OPEN (cancelled=%s)', async cancelled => {
    const { deps, settlements } = fakeAttemptDeps();
    const out = await runGovernedSpendAttempt(attempt(async () => ({
      costUsd: 0.3, value: 'partial result', cancelled, costUsdMeasurementMissing: true,
    })), deps);
    expect(out).toMatchObject({ ok: true, value: 'partial result', costUsd: 0.3, cancelled,
      costUsdMeasurementMissing: true, reservationId: 'res-1', settlement: null,
      settlementError: 'usage measurement incomplete; reservation remains open' });
    expect(settlements).toEqual([]);
  });

  it.each([NaN, Infinity, -1])('does not send an invalid reported cost (%s) to settlement', async costUsd => {
    const { deps, settlements } = fakeAttemptDeps();
    const out = await runGovernedSpendAttempt(attempt(async () => ({ costUsd, value: 'result' })), deps);
    expect(out).toMatchObject({ ok: true, value: 'result', costUsd: 0, costUsdMeasurementMissing: true,
      reservationId: 'res-1', settlement: null });
    expect(settlements).toEqual([]);
  });

  it.each([undefined, NaN, Infinity, -1])('does not invent zero spend from a failed call with cost %s', async costUsd => {
    const { deps, settlements } = fakeAttemptDeps();
    const out = await runGovernedSpendAttempt(attempt(async () => {
      throw Object.assign(new Error('unpriced inference failed'), { costUsd });
    }), deps);
    expect(out).toMatchObject({ ok: false, reason: 'failed', error: 'unpriced inference failed',
      costUsd: 0, costUsdMeasurementMissing: true, settlement: null });
    expect(settlements).toEqual([]);
  });

  it('does NOT run the work when the reservation is refused', async () => {
    let ran = false;
    const { deps, settlements } = fakeAttemptDeps({
      reserve: { ok: false, reason: 'no-headroom', requestedUsd: 1, headroomUsd: 0 },
    });
    const out = await runGovernedSpendAttempt(
      attempt(async () => {
        ran = true;
        return { costUsd: 1, value: null };
      }),
      deps,
    );
    expect(ran).toBe(false);
    expect(out).toMatchObject({ ok: false, reason: 'refused', refusal: 'no-headroom' });
    expect(settlements).toEqual([]);
  });

  it('flag OFF ⇒ governor-dark, and the work never runs', async () => {
    let ran = false;
    const { deps } = fakeAttemptDeps({ enabled: false });
    const out = await runGovernedSpendAttempt(
      attempt(async () => {
        ran = true;
        return { costUsd: 1, value: null };
      }),
      deps,
    );
    expect(ran).toBe(false);
    expect(out).toEqual({ ok: false, reason: 'governor-dark' });
  });

  it('a settlement write failure preserves the work and leaves settlement explicitly unknown', async () => {
    // A transport failure may happen before or after commit; it proves neither
    // a closed reservation nor an open one.
    const { deps, logs } = fakeAttemptDeps({ settleThrows: true });
    const out = await runGovernedSpendAttempt(
      attempt(async () => ({ costUsd: 0.3, value: 'lessons' })),
      deps,
    );
    expect(out).toMatchObject({ ok: true, value: 'lessons', costUsd: 0.3 });
    expect(out).toMatchObject({ settlement: null, settlementError: 'settlement write failed' });
    expect(logs.join('\n')).toMatch(/settlement outcome unconfirmed/s);
  });

  it.each(['not-found', 'already-settled', 'exact-settlement-required'] as const)(
    'retains the actual %s settlement refusal without masking the work', async (reason) => {
      const settlement: SettleLearningSpendResult = { ok: false, reason, reservation: null };
      const { deps, logs } = fakeAttemptDeps({ settlement });
      const out = await runGovernedSpendAttempt(attempt(async () => ({ costUsd: 0.4, value: 'lessons' })), deps);
      expect(out).toMatchObject({ ok: true, value: 'lessons', costUsd: 0.4, settlement });
      expect(logs.join('\n')).toContain(reason);
    },
  );

  it('retains the persisted charge rather than rebuilding it from the work report', async () => {
    const { deps } = fakeAttemptDeps();
    const settle = deps.settle!;
    deps.settle = async (sql, input) => {
      const result = await settle(sql, { ...input, usedUsd: 0.25 });
      return result;
    };
    const out = await runGovernedSpendAttempt(attempt(async () => ({ costUsd: 0.4, value: 'lessons' })), deps);
    expect(out).toMatchObject({ costUsd: 0.4, settlement: { ok: true, reservation: { usedUsd: 0.25 } } });
  });

  it('retains settlement uncertainty when the spending work also failed', async () => {
    const { deps } = fakeAttemptDeps({ settleThrows: true });
    const out = await runGovernedSpendAttempt(attempt(async () => {
      throw Object.assign(new Error('bad JSON'), { costUsd: 0.02 });
    }), deps);
    expect(out).toMatchObject({ ok: false, reason: 'failed', error: 'bad JSON', costUsd: 0.02,
      settlement: null, settlementError: 'settlement write failed' });
  });
});

const AUTOLOOPS = [
  { workspaceId: 'w', harnessSlug: 'alpha', enabled: true, budgetUsd: 20, spentUsd: 2 },
  { workspaceId: 'w', harnessSlug: 'beta', enabled: false, budgetUsd: null, spentUsd: 0 },
];

describe('recordGymTickToGovernor', () => {
  it('flag OFF ⇒ no-op, no reads, no writes', async () => {
    const { deps, calls } = fakeDeps({ enabled: false });
    let listed = 0;
    const out = await recordGymTickToGovernor(
      { workspaceId: 'w', sql: SQL, listAutoloops: async () => ((listed += 1), AUTOLOOPS), ran: null },
      deps,
    );
    expect(out).toEqual({ applied: false, reason: 'flag-off' });
    expect(listed).toBe(0); // the mirror source is only read once the flag check passes
    expect(calls.register).toHaveLength(0);
    expect(calls.spend).toHaveLength(0);
  });

  it('mirrors every autoloop row (budget + spent overwritten, native enforcement)', async () => {
    const { deps, calls } = fakeDeps();
    const out = await recordGymTickToGovernor(
      { workspaceId: 'w', sql: SQL, listAutoloops: async () => AUTOLOOPS, ran: null },
      deps,
    );
    expect(out).toEqual({ applied: true });
    expect(calls.register.map((r) => r.loopId)).toEqual(['gym:alpha', 'gym:beta']);
    expect(calls.register[0]).toMatchObject({ budgetKind: 'lifetime', budgetUsd: 20, spentUsd: 2, enforcement: 'native' });
    expect(calls.register[1]).toMatchObject({ budgetUsd: null, enabled: false });
    expect(calls.spend).toHaveLength(0); // idle tick ⇒ no spend event
  });

  it('ledgers a ran cycle as an EVENT ONLY (accumulate:false — the row spent comes from the mirror)', async () => {
    const { deps, calls } = fakeDeps();
    await recordGymTickToGovernor(
      {
        workspaceId: 'w',
        sql: SQL,
        listAutoloops: async () => AUTOLOOPS,
        ran: { harnessSlug: 'alpha', spentUsd: 1.25, runRef: 'gym-cycle:alpha' },
      },
      deps,
    );
    expect(calls.spend).toEqual([
      {
        workspaceId: 'w',
        loopId: 'gym:alpha',
        potSlug: 'alpha',
        costUsd: 1.25,
        runRef: 'gym-cycle:alpha',
        note: 'gym autoloop cycle',
        accumulate: false,
      },
    ]);
  });

  it('mirrors N per-hive rows to distinct gym:<hive> loops and ledgers the ran hive only (P-030)', async () => {
    // Per-hive-learning-loops P-030: the workspace sweep returns one gym autoloop
    // row per hive; the mirror must register EACH under its own gym:<hive> loopId
    // and ledger spend only against the hive that actually ran this tick.
    const perHive = [
      { workspaceId: 'w', harnessSlug: 'hive-acme', enabled: true, budgetUsd: 20, spentUsd: 2 },
      { workspaceId: 'w', harnessSlug: 'hive-beta', enabled: true, budgetUsd: 15, spentUsd: 7 },
      { workspaceId: 'w', harnessSlug: 'hive-gamma', enabled: false, budgetUsd: null, spentUsd: 0 },
    ];
    const { deps, calls } = fakeDeps();
    const out = await recordGymTickToGovernor(
      {
        workspaceId: 'w',
        sql: SQL,
        listAutoloops: async () => perHive,
        ran: { harnessSlug: 'hive-beta', spentUsd: 0.9, runRef: 'gym-cycle:hive-beta' },
      },
      deps,
    );
    expect(out).toEqual({ applied: true });
    // One registration per hive, each its own loopId + native enforcement.
    expect(calls.register.map((r) => r.loopId)).toEqual(['gym:hive-acme', 'gym:hive-beta', 'gym:hive-gamma']);
    expect(calls.register.every((r) => r.enforcement === 'native')).toBe(true);
    // Spend ledgered against the ran hive ONLY (event-only, the row spent comes from the mirror).
    expect(calls.spend).toEqual([
      { workspaceId: 'w', loopId: 'gym:hive-beta', potSlug: 'hive-beta', costUsd: 0.9, runRef: 'gym-cycle:hive-beta', note: 'gym autoloop cycle', accumulate: false },
    ]);
  });

  it('skips the spend event for a zero-spend run', async () => {
    const { deps, calls } = fakeDeps();
    await recordGymTickToGovernor(
      { workspaceId: 'w', sql: SQL, listAutoloops: async () => [], ran: { harnessSlug: 'alpha', spentUsd: 0 } },
      deps,
    );
    expect(calls.spend).toHaveLength(0);
  });

  it('NEVER throws — an IO failure logs and returns reason:error', async () => {
    const { deps, calls } = fakeDeps();
    deps.register = async () => {
      throw new Error('pg down');
    };
    const out = await recordGymTickToGovernor(
      { workspaceId: 'w', sql: SQL, listAutoloops: async () => AUTOLOOPS, ran: null },
      deps,
    );
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('error');
    expect(out.error).toMatch(/pg down/);
    expect(calls.logs.some((l) => l.includes('pg down'))).toBe(true);
  });
});

describe('recordScoutTickToGovernor', () => {
  it('flag OFF ⇒ no-op', async () => {
    const { deps, calls } = fakeDeps({ enabled: false });
    const out = await recordScoutTickToGovernor(
      { workspaceId: 'w', harnessSlug: 'papercup', perCycleBudgetUsd: 1, fired: { costUsd: 0.5 } },
      deps,
    );
    expect(out).toEqual({ applied: false, reason: 'flag-off' });
    expect(calls.register).toHaveLength(0);
    expect(calls.spend).toHaveLength(0);
  });

  it('mirrors the per-cycle cap and ACCUMULATES a fired cycle’s spend', async () => {
    const { deps, calls } = fakeDeps();
    const out = await recordScoutTickToGovernor(
      { workspaceId: 'w', harnessSlug: 'papercup', perCycleBudgetUsd: 1.5, fired: { costUsd: 0.4, cycleId: 'scout-9' } },
      deps,
    );
    expect(out).toEqual({ applied: true });
    expect(calls.register[0]).toMatchObject({
      loopId: 'blender:papercup',
      budgetKind: 'per-cycle',
      budgetUsd: 1.5,
      enforcement: 'native',
    });
    expect(calls.spend).toEqual([
      {
        workspaceId: 'w',
        loopId: 'blender:papercup',
        potSlug: null,
        costUsd: 0.4,
        runRef: 'scout-9',
        note: 'scout ideation cycle',
        accumulate: true,
      },
    ]);
  });

  it('P-004 re-key: a resolved pot keys BOTH the registration and the spend by blender:<pot>', async () => {
    const { deps, calls } = fakeDeps();
    const out = await recordScoutTickToGovernor(
      { workspaceId: 'w', harnessSlug: 'hive-acme', perCycleBudgetUsd: 1.5, fired: { costUsd: 0.4, cycleId: 'scout-10' } },
      deps,
    );
    expect(out).toEqual({ applied: true });
    expect(calls.register[0]).toMatchObject({ loopId: 'blender:hive-acme', potSlug: 'hive-acme' });
    expect(calls.spend[0]).toMatchObject({ loopId: 'blender:hive-acme', potSlug: 'hive-acme' });
  });

  it('a withheld tick mirrors the registration only', async () => {
    const { deps, calls } = fakeDeps();
    await recordScoutTickToGovernor({ workspaceId: 'w', harnessSlug: 'h', perCycleBudgetUsd: 1, fired: null }, deps);
    expect(calls.register).toHaveLength(1);
    expect(calls.spend).toHaveLength(0);
  });

  it('NEVER throws on IO failure', async () => {
    const { deps } = fakeDeps();
    deps.getSql = async () => {
      throw new Error('no pool');
    };
    const out = await recordScoutTickToGovernor(
      { workspaceId: 'w', harnessSlug: 'h', perCycleBudgetUsd: 1, fired: null },
      deps,
    );
    expect(out).toEqual({ applied: false, reason: 'error', error: 'no pool' });
  });
});

describe('learningGovernorPreflight — the frontier gate', () => {
  it("flag OFF ⇒ refuses with 'governor-dark'", async () => {
    const { deps } = fakeDeps({ enabled: false });
    const v = await learningGovernorPreflight({ workspaceId: 'w', loopId: 'frontier:replay' }, deps);
    expect(v).toEqual({ allow: false, reason: 'governor-dark', remainingUsd: null });
  });

  it('flag ON ⇒ returns the registration verdict', async () => {
    const { deps } = fakeDeps();
    const v = await learningGovernorPreflight({ workspaceId: 'w', loopId: 'frontier:replay' }, deps);
    expect(v).toEqual({ allow: true, remainingUsd: 5 });
  });

  it("fail-CLOSED: an IO error refuses with 'governor-error' (never allows on a broken ledger)", async () => {
    const { deps, calls } = fakeDeps();
    deps.check = async () => {
      throw new Error('pg down');
    };
    const v = await learningGovernorPreflight({ workspaceId: 'w', loopId: 'frontier:replay' }, deps);
    expect(v).toEqual({ allow: false, reason: 'governor-error', remainingUsd: null });
    expect(calls.logs.some((l) => l.includes('fail-closed'))).toBe(true);
  });
});
