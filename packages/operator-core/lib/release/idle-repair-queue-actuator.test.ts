import { describe, expect, it } from 'vitest';
import {
  IDLE_REPAIR_QUEUE_MS,
  IDLE_RUNG_GRACE_MS,
  IDLE_DISPATCH_RETRY_LIMIT,
  decideIdleQueueAction,
  dispatchIdleQueueFixer,
  idleQueueFixerDispatch,
  parseEpisode,
  runIdleQueueActuatorPass,
  evaluateIdleQueueActuatorWindow,
  buildIdleQueueActuatorObservation,
  IDLE_ACTUATOR_PASS_MARKER,
  type IdleQueueActuatorObservation,
  type IdleQueueActuatorDeps,
  type IdleQueueEpisode,
  type IdleQueueSnapshot,
  type IdleRungResult,
} from './idle-repair-queue-actuator';
import type { PipelineEventWindowRead } from '../harness/git-sync/pipeline-events';
import { currentRepairLimbExecutor, parseRepairLimbExecutor, type RepairLimbExecutor } from './repair-limb-executor';
import { createFrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import { buildCandidateSnapshot, candidateSnapshotMatchesDispatch } from './candidate-snapshot';

const MIN = 60_000;
const OPENED = Date.parse('2026-10-08T00:00:00Z');

function snapshot(over: Partial<IdleQueueSnapshot> = {}): IdleQueueSnapshot {
  return {
    candidate: 'ad82b273aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    repairHead: 'f07043bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    phase: 'awaiting-fixer',
    openedAtMs: OPENED,
    lastAdmittedAtMs: null,
    lastResumeRunStartedAtMs: null,
    runInFlight: false,
    failingLegs: 3,
    fixerSpawnId: null,
    fixerAlive: null,
    gateHolder: 'su-gate-holder',
    gateHolderWakeable: true,
    blockedReason: null,
    ...over,
  };
}

/** A stalled-queue fixture: a fake clock, a mutable queue, and a log of every effect in order. */
function fixture(
  initial: IdleQueueSnapshot,
  results: Partial<Record<'dispatch' | 'wake' | 'escalate', IdleRungResult[]>> = {},
) {
  const state = { now: OPENED, snap: initial as IdleQueueSnapshot | null, episode: null as IdleQueueEpisode | null };
  const calls: string[] = [];
  const messages: Array<{ to: string; summary: string; body: string }> = [];
  const next = (k: 'dispatch' | 'wake' | 'escalate'): IdleRungResult =>
    results[k]?.shift() ?? { ok: true, detail: `${k} ok` };
  const deps: IdleQueueActuatorDeps = {
    installSlug: 'papercusp',
    nowMs: () => state.now,
    readSnapshot: async () => state.snap,
    loadEpisode: async () => state.episode,
    saveEpisode: async (e) => {
      state.episode = e;
    },
    dispatchFixer: async () => {
      calls.push('dispatch-fixer');
      const result = next('dispatch');
      if (result.ok && state.snap?.phase === 'awaiting-fixer') {
        state.snap = { ...state.snap, fixerSpawnId: 'spawn-fixture', fixerAlive: true };
      }
      return result;
    },
    wakeGateOwner: async (holder, msg) => {
      calls.push(`wake-gate-owner:${holder}`);
      messages.push({ to: holder, ...msg });
      return next('wake');
    },
    escalateOwner: async (msg) => {
      calls.push('escalate-owner');
      messages.push({ to: 'owner', ...msg });
      return next('escalate');
    },
  };
  const at = async (minutesAfterOpen: number) => {
    state.now = OPENED + minutesAfterOpen * MIN;
    return runIdleQueueActuatorPass(deps);
  };
  return { state, calls, messages, at, deps };
}

describe('idle repair-queue fixer handoff', () => {
  const queue = createFrozenCandidateRepairQueue({
    candidate: 'a'.repeat(40),
    base: 'b'.repeat(40),
    failingTests: ['lib/failing.test.ts'],
    nowMs: OPENED,
  });

  it('persists the spawned fixer assignment before the idle rung reports success', async () => {
    const reserved = {
      ...queue,
      updatedAtMs: OPENED + 1,
      dispatchReservation: { token: 'reservation-token', claimedAtMs: OPENED + 1, expiresAtMs: OPENED + 10 * MIN },
    };
    const calls: string[] = [];
    const result = await dispatchIdleQueueFixer(queue, {
      reserve: async (current) => {
        calls.push('reserve');
        expect(current).toBe(queue);
        return reserved;
      },
      dispatch: async (current) => {
        calls.push('dispatch');
        expect(current).toBe(reserved);
        return { spawnId: 'spawn-123', runId: 'run-123' };
      },
      finalize: async (current, fired) => {
        calls.push('finalize');
        expect(current).toBe(reserved);
        expect(fired).toEqual({ spawnId: 'spawn-123', runId: 'run-123' });
        return { ...queue, fixerSpawnId: 'spawn-123' };
      },
    });

    expect(calls).toEqual(['reserve', 'dispatch', 'finalize']);
    expect(result).toEqual({
      ok: true,
      detail: 'dispatched fixer spawn-123 and persisted its queue assignment',
    });
  });

  it('does not report a spawned fixer as successful when the queue CAS did not bind it', async () => {
    const reserved = {
      ...queue,
      updatedAtMs: OPENED + 1,
      dispatchReservation: { token: 'reservation-token', claimedAtMs: OPENED + 1, expiresAtMs: OPENED + 10 * MIN },
    };
    const result = await dispatchIdleQueueFixer(queue, {
      reserve: async () => reserved,
      dispatch: async (current) => {
        expect(current).toBe(reserved);
        return { spawnId: 'spawn-123', runId: 'run-123' };
      },
      finalize: async () => null,
    });

    expect(result).toEqual({
      ok: false,
      detail: 'spawned fixer spawn-123, but queue assignment was not persisted',
    });
  });

  it('releases a reservation when the dispatcher returns no spawn', async () => {
    const reserved = {
      ...queue,
      updatedAtMs: OPENED + 1,
      dispatchReservation: { token: 'reservation-token', claimedAtMs: OPENED + 1, expiresAtMs: OPENED + 10 * MIN },
    };
    const calls: string[] = [];
    const result = await dispatchIdleQueueFixer(queue, {
      reserve: async () => reserved,
      dispatch: async (current) => {
        expect(current).toBe(reserved);
        return null;
      },
      finalize: async (current, fired) => {
        calls.push('finalize');
        expect(current).toBe(reserved);
        expect(fired).toBeNull();
        return { ...queue, updatedAtMs: OPENED + 2 };
      },
    });

    expect(calls).toEqual(['finalize']);
    expect(result).toEqual({
      ok: false,
      detail: 'dispatcher returned no spawn; reservation released',
    });
  });
});

describe('idle rung dispatch targets the repair head (WI-6554700010029686)', () => {
  const frozenCandidate = 'a'.repeat(40);
  const repairHead = 'c'.repeat(40);
  // A queue that has admitted a fix: its repair head has moved off the immutable pin.
  const admitted = {
    ...createFrozenCandidateRepairQueue({
      candidate: frozenCandidate, base: 'b'.repeat(40), failingTests: ['lib/red.test.ts'], nowMs: OPENED,
    }),
    repairHead,
    phase: 'awaiting-fixer' as const,
  };

  it('hands the dispatcher the repair head, the queue failures and the queue row', async () => {
    const calls: unknown[][] = [];
    const dispatch = idleQueueFixerDispatch('target', async (...args) => {
      calls.push(args);
      return null;
    });
    await dispatch(admitted, () => {});
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 5)).toEqual(['target', repairHead, ['lib/red.test.ts'], admitted, undefined]);
  });

  it('builds a dispatch the real snapshot matcher accepts once the repair head has moved', async () => {
    const snapshot = buildCandidateSnapshot(
      {
        candidate: repairHead,
        failingTests: ['lib/red.test.ts'],
        repairQueue: { candidate: frozenCandidate, repairHead, phase: 'awaiting-fixer' },
      },
      OPENED,
    );
    expect(snapshot).not.toBeNull();
    const verdicts: boolean[] = [];
    const dispatch = idleQueueFixerDispatch('target', async (_target, candidate, failingTests, repairQueue) => {
      verdicts.push(candidateSnapshotMatchesDispatch(snapshot, { candidate, failingTests, repairQueue, nowMs: OPENED + MIN }));
      return null;
    });
    await dispatch(admitted, () => {});
    expect(verdicts).toEqual([true]);
    // The pre-fix argument, the immutable pin, is refused by construction: the
    // snapshot-mismatch the idle rung hit on every attempt on 2026-10-26.
    expect(
      candidateSnapshotMatchesDispatch(snapshot, {
        candidate: frozenCandidate,
        failingTests: admitted.failingTests,
        repairQueue: admitted,
        nowMs: OPENED + MIN,
      }),
    ).toBe(false);
  });
});

describe('typed dispatcher refusals (WI-6554700010015397)', () => {
  it('surfaces the skip reason and retryability after releasing the reservation', async () => {
    const queue = createFrozenCandidateRepairQueue({
      candidate: 'a'.repeat(40), base: 'b'.repeat(40), failingTests: ['lib/red.test.ts'], nowMs: OPENED,
    });
    const reason = 'frozen repair queue has no measured failing tests; a fresh verdict is the unblock';
    const result = await dispatchIdleQueueFixer(queue, {
      reserve: async () => queue,
      dispatch: async (_reserved, onSkip) => {
        onSkip({ code: 'no-measured-failures', reason, retryable: false });
        return null;
      },
      finalize: async (_reserved, fired) => {
        expect(fired).toBeNull();
        return queue;
      },
    });
    expect(result).toEqual({ ok: false, retryable: false, detail: reason + '; reservation released' });
  });

  it('retains a deterministic refusal through an active run and a persisted new idle episode', async () => {
    const reason = 'no measured failing tests; a fresh verdict is the unblock';
    const f = fixture(snapshot({ lastVerdictAtMs: OPENED }), {
      dispatch: [{ ok: false, retryable: false, detail: reason }],
    });
    await f.at(61);
    expect(f.messages[0].body).toContain(reason);
    expect(f.messages[0].body).toContain('release:checkpoint-run');
    f.state.snap = snapshot({ lastVerdictAtMs: OPENED, lastResumeRunStartedAtMs: OPENED + 100 * MIN, runInFlight: true });
    expect((await f.at(130)).decision).toBe('not-idle');
    f.state.episode = parseEpisode(JSON.stringify(f.state.episode));
    expect(f.state.episode?.dispatchRefusal).toBeDefined();
    f.state.snap.runInFlight = false;
    await f.at(161);
    expect(f.calls.filter(c => c === 'dispatch-fixer')).toHaveLength(1);
    expect(f.calls.at(-1)).toBe('wake-gate-owner:su-gate-holder');
    expect(f.messages.at(-1)?.body).toContain(reason);
  });

  it.each([
    { candidate: 'd'.repeat(40) },
    { repairHead: 'e'.repeat(40) },
    { lastVerdictAtMs: OPENED + 110 * MIN },
  ])('re-enables dispatch after a new candidate, head or verdict: %j', async change => {
    const f = fixture(snapshot({ lastVerdictAtMs: OPENED }), {
      dispatch: [{ ok: false, retryable: false, detail: 'unmeasured verdict' }],
    });
    await f.at(61);
    f.state.episode = parseEpisode(JSON.stringify(f.state.episode));
    f.state.snap = snapshot({ lastVerdictAtMs: OPENED, ...change });
    // No idle-clock change is required for new evidence to permit a retry.
    await f.at(62);
    expect(f.calls.filter(c => c === 'dispatch-fixer')).toHaveLength(2);
  });

  it('keeps transient refusals retryable after a round resets the episode', async () => {
    const f = fixture(snapshot(), { dispatch: [{ ok: false, retryable: true, detail: 'snapshot changed' }] });
    await f.at(61);
    f.state.snap = snapshot({ lastResumeRunStartedAtMs: OPENED + 100 * MIN });
    await f.at(130);
    expect(f.state.episode).toBeNull();
    await f.at(161);
    expect(f.calls.filter(c => c === 'dispatch-fixer')).toHaveLength(2);
  });
});

describe('idle repair-queue actuator (P-002, WI-10007476)', () => {
  it('records effect completion after the awaited action, not its invocation clock', async () => {
    const f = fixture(snapshot());
    f.deps.dispatchFixer = async () => {
      f.state.now += 2 * MIN;
      return { ok: true, detail: 'dispatch completed' };
    };
    const result = await f.at(61);
    expect(result.acted[0]).toMatchObject({ startedAtMs: OPENED + 61 * MIN,
      completedAtMs: OPENED + 63 * MIN, outcome: 'acted' });
  });
  it('a stalled queue walks dispatch-fixer, then wake-gate-owner, then escalate-owner, in order and once each', async () => {
    const f = fixture(snapshot());
    const grace = IDLE_RUNG_GRACE_MS / MIN;
    const idle = IDLE_REPAIR_QUEUE_MS / MIN;

    expect((await f.at(idle)).decision).toBe('not-idle'); // exactly 60 min is not yet "> 60 min"
    expect(f.calls).toEqual([]);

    expect((await f.at(idle + 1)).decision).toBe('act');
    expect(f.calls).toEqual(['dispatch-fixer']);

    expect((await f.at(idle + 15)).decision).toBe('wait'); // a dispatched fixer gets the grace
    expect(f.calls).toEqual(['dispatch-fixer']);

    await f.at(idle + 1 + grace);
    expect(f.calls).toEqual(['dispatch-fixer', 'wake-gate-owner:su-gate-holder']);

    await f.at(idle + 1 + 2 * grace);
    expect(f.calls).toEqual(['dispatch-fixer', 'wake-gate-owner:su-gate-holder', 'escalate-owner']);

    expect((await f.at(idle + 1 + 5 * grace)).decision).toBe('exhausted');
    expect((await f.at(idle + 1 + 9 * grace)).decision).toBe('exhausted');
    expect(f.calls).toHaveLength(3); // never re-fires within one idle episode
  });

  it('the wake and the escalation both name the concrete next action, not just the age', async () => {
    const f = fixture(snapshot());
    for (const m of [61, 91, 121]) await f.at(m);
    expect(f.messages.map((m) => m.to)).toEqual(['su-gate-holder', 'owner']);
    for (const m of f.messages) {
      expect(m.summary).toContain('papercusp');
      expect(m.body).toContain("release:repair-queue { op:'admit'");
      expect(m.body).toContain('3 failing leg(s)');
    }
    // The escalation reports what the earlier rungs already did.
    expect(f.messages[1].body).toMatch(/dispatch-fixer: acted .*wake-gate-owner: acted/);
  });

  it('a failed dispatch falls through to the gate owner in the SAME pass', async () => {
    const f = fixture(snapshot(), { dispatch: [{ ok: false, detail: 'dispatcher refused: reservation held' }] });
    const r = await f.at(61);
    expect(f.calls).toEqual(['dispatch-fixer', 'wake-gate-owner:su-gate-holder']);
    expect(r.acted.map((a) => a.outcome)).toEqual(['failed', 'acted']);
    expect(f.state.episode?.rungs['dispatch-fixer']?.detail).toBe('dispatcher refused: reservation held');
  });

  it('with no wakeable gate holder a failed dispatch goes straight to the owner', async () => {
    const f = fixture(snapshot({ gateHolderWakeable: false }), { dispatch: [{ ok: false, detail: 'spawn plane down' }] });
    await f.at(61);
    expect(f.calls).toEqual(['dispatch-fixer', 'escalate-owner']);
    expect(f.state.episode?.rungs['wake-gate-owner']?.outcome).toBe('not-applicable');

    const unheld = fixture(snapshot({ gateHolder: null }), { dispatch: [{ ok: false, detail: 'x' }] });
    await unheld.at(61);
    expect(unheld.calls).toEqual(['dispatch-fixer', 'escalate-owner']);
  });

  it('a live fixer is not doubled: no dispatch, the grace, then the gate owner', async () => {
    const f = fixture(snapshot({ fixerSpawnId: 'spawn-live', fixerAlive: true }));
    expect((await f.at(61)).decision).toBe('wait');
    expect(f.calls).toEqual([]);
    expect(f.state.episode?.rungs['dispatch-fixer']?.detail).toContain('spawn-live');
    await f.at(61 + IDLE_RUNG_GRACE_MS / MIN);
    expect(f.calls).toEqual(['wake-gate-owner:su-gate-holder']);
  });

  it('retries one acted dispatch with no assigned fixer, then wakes the gate owner instead of looping', async () => {
    const f = fixture(snapshot());
    f.state.episode = {
      candidate: snapshot().candidate,
      idleSinceMs: OPENED,
      dispatchRetryCount: 0,
      rungs: {
        'dispatch-fixer': {
          atMs: OPENED + 61 * MIN,
          outcome: 'acted',
          detail: 'initial spawn was accepted',
        },
      },
    };
    f.deps.dispatchFixer = async () => {
      f.calls.push('dispatch-fixer');
      expect(f.state.episode?.dispatchRetryCount).toBe(IDLE_DISPATCH_RETRY_LIMIT);
      return { ok: true, detail: 'bounded retry accepted' };
    };

    expect((await f.at(92)).decision).toBe('act');
    expect(f.calls).toEqual(['dispatch-fixer']);
    expect(f.state.episode?.dispatchRetryCount).toBe(IDLE_DISPATCH_RETRY_LIMIT);

    // The retry also exits before producing a queue assignment. The budget is spent, so the
    // next grace expiry wakes the gate owner instead of launching a third fixer.
    expect((await f.at(123)).decision).toBe('act');
    expect(f.calls).toEqual(['dispatch-fixer', 'wake-gate-owner:su-gate-holder']);
    expect(f.state.episode?.dispatchRetryCount).toBe(IDLE_DISPATCH_RETRY_LIMIT);
  });

  it('retries a confirmed-dead spawn but does not guess when assigned-spawn liveness is unknown', async () => {
    const dead = fixture(snapshot({ fixerSpawnId: 'spawn-dead', fixerAlive: false }));
    dead.state.episode = {
      candidate: snapshot().candidate,
      idleSinceMs: OPENED,
      rungs: { 'dispatch-fixer': { atMs: OPENED + 61 * MIN, outcome: 'acted', detail: 'spawn assigned' } },
    };
    await dead.at(92);
    expect(dead.calls).toEqual(['dispatch-fixer']);
    expect(dead.state.episode?.dispatchRetryCount).toBe(IDLE_DISPATCH_RETRY_LIMIT);

    const unknown = fixture(snapshot({ fixerSpawnId: 'spawn-unknown', fixerAlive: null }));
    unknown.state.episode = {
      candidate: snapshot().candidate,
      idleSinceMs: OPENED,
      rungs: { 'dispatch-fixer': { atMs: OPENED + 61 * MIN, outcome: 'acted', detail: 'spawn assigned' } },
    };
    await unknown.at(92);
    expect(unknown.calls).toEqual(['wake-gate-owner:su-gate-holder']);
    expect(unknown.state.episode?.dispatchRetryCount ?? 0).toBe(0);
  });

  it('round-trips the retry budget and defaults older persisted episodes to zero', () => {
    const legacy = {
      candidate: snapshot().candidate,
      idleSinceMs: OPENED,
      rungs: { 'dispatch-fixer': { atMs: OPENED, outcome: 'acted', detail: 'legacy' } },
    };
    expect(parseEpisode(JSON.stringify(legacy))?.dispatchRetryCount).toBe(0);
    expect(parseEpisode(JSON.stringify({ ...legacy, dispatchRetryCount: 1 }))?.dispatchRetryCount).toBe(1);
  });

  it('a queue waiting on a gate run skips the fixer and names release:checkpoint-run', async () => {
    const f = fixture(snapshot({ phase: 'ready-to-verify' }));
    await f.at(61);
    expect(f.calls).toEqual(['wake-gate-owner:su-gate-holder']);
    expect(f.messages[0].body).toContain('release:checkpoint-run');
    expect(f.messages[0].body).toContain('f07043bbbbbb');
    expect(f.state.episode?.rungs['dispatch-fixer']?.outcome).toBe('not-applicable');
  });

  it('a recent admission resets idle time even when the queue itself is old', async () => {
    const admittedAt = OPENED + 100 * MIN;
    const f = fixture(snapshot({
      phase: 'ready-to-verify',
      lastAdmittedAtMs: admittedAt,
      lastResumeRunStartedAtMs: OPENED + 20 * MIN,
    }));

    expect((await f.at(150)).decision).toBe('not-idle'); // 50 minutes since admission
    expect(f.calls).toEqual([]);
    await f.at(161);
    expect(f.calls).toEqual(['wake-gate-owner:su-gate-holder']);
  });

  it('never recommends another checkpoint run while the checkpoint run lock is held', async () => {
    const f = fixture(snapshot({ phase: 'ready-to-verify', runInFlight: true }));

    expect((await f.at(61)).decision).toBe('not-idle');
    expect(f.calls).toEqual([]);
    expect(f.state.episode).toBeNull();
  });

  it('preserves an aged episode without acting when checkpoint run-lock state is unknown', async () => {
    const f = fixture(snapshot({ phase: 'ready-to-verify', runInFlight: null }));

    expect((await f.at(61)).decision).toBe('wait');
    expect(f.calls).toEqual([]);
    expect(f.state.episode).not.toBeNull();
  });

  it('a round starting ends the episode; the next stall climbs the ladder again from rung 1', async () => {
    const f = fixture(snapshot());
    await f.at(61);
    await f.at(91);
    expect(f.calls).toEqual(['dispatch-fixer', 'wake-gate-owner:su-gate-holder']);

    // A round starts at +100 min: not idle again until +160, and the stored episode is cleared.
    f.state.snap = snapshot({ lastResumeRunStartedAtMs: OPENED + 100 * MIN });
    expect((await f.at(130)).decision).toBe('not-idle');
    expect(f.state.episode).toBeNull();

    await f.at(161);
    expect(f.calls).toEqual(['dispatch-fixer', 'wake-gate-owner:su-gate-holder', 'dispatch-fixer']);
  });

  it('nothing fires without failing legs, on a promotable queue, or with no queue at all', async () => {
    for (const snap of [snapshot({ failingLegs: 0 }), snapshot({ phase: 'ready-to-promote' }), null]) {
      const f = fixture(snapshot());
      f.state.snap = snap;
      expect((await f.at(600)).decision).toBe('not-idle');
      expect(f.calls).toEqual([]);
    }
  });

  it('a failed owner escalation is retried after the grace, never left silently exhausted', async () => {
    const f = fixture(snapshot({ phase: 'blocked', gateHolder: null, blockedReason: 'attempts-exhausted' }), {
      escalate: [{ ok: false, detail: 'attention surface down' }],
    });
    await f.at(61);
    expect(f.calls).toEqual(['escalate-owner']);
    expect((await f.at(80)).decision).toBe('wait');
    await f.at(61 + IDLE_RUNG_GRACE_MS / MIN);
    expect(f.calls).toEqual(['escalate-owner', 'escalate-owner']);
    expect(f.messages[1].body).toContain('attempts-exhausted');
    expect((await f.at(300)).decision).toBe('exhausted');
  });

  it('decideIdleQueueAction is pure: it never mutates the prior episode it was handed', () => {
    const prior: IdleQueueEpisode = { candidate: snapshot().candidate, idleSinceMs: OPENED, rungs: {} };
    const frozen = JSON.stringify(prior);
    decideIdleQueueAction(snapshot({ phase: 'ready-to-test' }), prior, OPENED + 61 * MIN);
    expect(JSON.stringify(prior)).toBe(frozen);
  });
});

describe('original idle-actuator history acceptance', () => {
  // A synthetic history tests the measurement only. The real actuator's >60-minute trigger
  // must not be mistaken for a measured <=60-minute operational pass.
  function history(): PipelineEventWindowRead {
    const rows = [45, 60, 75].map((minute, i) => {
      const startedAtMs = OPENED + minute * MIN;
      const completedAtMs = i === 0 ? OPENED + 59 * MIN : startedAtMs;
      const observation: IdleQueueActuatorObservation = {
        version: 1, startedAtMs, completedAtMs, snapshot: snapshot(), episode: null,
        result: { decision: i === 0 ? 'act' : 'wait', acted: i === 0 ? [{
          rung: 'dispatch-fixer', outcome: 'acted', detail: 'original receipt', startedAtMs, completedAtMs,
        }] : [] },
      };
      return { id: String(i + 1), kind: 'green_checkpoint_repair_latency' as const, status: 'converging',
        createdAtMs: completedAtMs, detail: { candidate: snapshot().candidate, idleActuator: observation } };
    });
    return { status: 'complete', total: rows.length, rows, reason: null,
      windowStartMs: OPENED + 45 * MIN, windowEndMs: OPENED + 75 * MIN };
  }
  const evaluate = (h: PipelineEventWindowRead) => evaluateIdleQueueActuatorWindow(h, h.windowEndMs);
  const observation = (h: PipelineEventWindowRead, index = 0) => h.rows[index]!.detail.idleActuator as IdleQueueActuatorObservation;
  const passes = (h: PipelineEventWindowRead) => evaluate(h).assertions.every(a => a.passed);

  it('uses original completed receipts and preserves their event identities', () => {
    const h = history();
    expect(passes(h)).toBe(true);
    expect(evaluate(h).eventIds).toEqual(['1', '2', '3']);
    expect(evaluate(h).episodes[0]!.firstActionAtMs).toBe(OPENED + 59 * MIN);
  });

  it('does not turn an attempted, failed or missing action into a delivered action', () => {
    for (const kind of ['failed', 'missing', 'carried-only']) {
      const h = history(), o = observation(h);
      if (kind === 'failed') o.result.acted[0]!.outcome = 'failed';
      else o.result.acted = [];
      if (kind === 'carried-only') o.episode = { candidate: o.snapshot.candidate, idleSinceMs: OPENED,
        rungs: { 'dispatch-fixer': { atMs: OPENED + 30 * MIN, outcome: 'acted', detail: 'mutable legacy stamp' } } };
      expect(passes(h)).toBe(false);
    }
  });

  it('keeps the strict 60-minute bound, without an extra tick of slack', () => {
    const h = history(), o = observation(h);
    o.completedAtMs = o.result.acted[0]!.completedAtMs = OPENED + 60 * MIN + 1;
    h.rows[0]!.createdAtMs = o.completedAtMs;
    expect(evaluate(h).assertions.find(a => a.id === 'idle-actuator-action-at-most-60min')!.passed).toBe(false);
  });

  it.each(['capped', 'unavailable', 'invalid'] as const)('rejects a %s population', status => {
    const h = history(); h.status = status;
    expect(passes(h)).toBe(false);
  });

  it.each(['empty', 'count', 'duplicate-id', 'duplicate-observation', 'legacy', 'unknown-lock',
    'foreign-candidate', 'future', 'gap', 'head-gap', 'tail-gap', 'invalid-receipt'])('rejects %s evidence', kind => {
    const h = history();
    if (kind === 'empty') { h.rows = []; h.total = 0; }
    if (kind === 'count') h.total = 4;
    if (kind === 'duplicate-id') h.rows[1]!.id = h.rows[0]!.id;
    if (kind === 'duplicate-observation') { h.rows.push({ ...h.rows[0]!, id: '4' }); h.total = 4; }
    if (kind === 'legacy') delete h.rows[0]!.detail.idleActuator;
    if (kind === 'unknown-lock') observation(h).snapshot.runInFlight = null;
    if (kind === 'foreign-candidate') observation(h).snapshot.candidate = 'foreign';
    if (kind === 'future') observation(h).completedAtMs = h.windowEndMs + 1;
    if (kind === 'gap') { h.rows.splice(1, 1); h.total = 2; }
    if (kind === 'head-gap') h.windowStartMs -= 16 * MIN;
    if (kind === 'tail-gap') h.windowEndMs += 16 * MIN;
    if (kind === 'invalid-receipt') observation(h).result.acted[0]!.startedAtMs = OPENED;
    expect(passes(h)).toBe(false);
  });

  it('rejects a future window and invalid observation cadence', () => {
    const h = history();
    expect(evaluateIdleQueueActuatorWindow(h, h.windowEndMs - 1).assertions.every(a => a.passed)).toBe(false);
    expect(evaluateIdleQueueActuatorWindow(h, h.windowEndMs, Infinity).assertions.every(a => a.passed)).toBe(false);
  });
});

describe('pass-record content marker (gate-repair-plane R-6)', () => {
  const pass = () => ({ startedAtMs: OPENED, completedAtMs: OPENED + MIN, snapshot: snapshot(), episode: null,
    result: { decision: 'not-idle' as const, acted: [] } });

  const writer: RepairLimbExecutor = {
    hostId: 'port-3271',
    processId: '424242',
    executingBuild: { sha: 'abc1234def5678', source: 'baked' },
  };

  it('stamps every pass record with the build marker and keeps the pass fields intact', () => {
    const record = buildIdleQueueActuatorObservation(pass(), writer);
    expect(IDLE_ACTUATOR_PASS_MARKER).toMatch(/\S/);
    expect(record).toEqual({ version: 1, ...pass(), executor: writer, marker: IDLE_ACTUATOR_PASS_MARKER });
  });

  it('leaves a marked record valid for the original-history measurement', () => {
    const marked = buildIdleQueueActuatorObservation(pass(), writer);
    expect(marked.version).toBe(1);
    expect(Object.keys(marked).sort()).toEqual(
      ['completedAtMs', 'episode', 'executor', 'marker', 'result', 'snapshot', 'startedAtMs', 'version']);
  });

  // #P-038 / #D-010: R-6's subject is the first record carrying the marker whose OWN stamped
  // build contains it, so the stamp must be on the pass record itself, not only on the
  // upserted episode row (pipeline_events 842662/843492 carried none).
  it('stamps the pass record with the writing executor (host, process, loaded build) by default', () => {
    const record = buildIdleQueueActuatorObservation(pass());
    expect(record.executor).toEqual(currentRepairLimbExecutor());
    expect(record.executor?.hostId).toMatch(/\S/);
  });

  it('keeps the executor stamp evaluable from the stored record alone (JSON round trip)', () => {
    const stored = JSON.parse(JSON.stringify(buildIdleQueueActuatorObservation(pass(), writer))) as Record<string, unknown>;
    expect(stored.marker).toBe(IDLE_ACTUATOR_PASS_MARKER);
    expect(parseRepairLimbExecutor(stored.executor)).toEqual(writer);
  });

  it('runs a fresh proof: the marker is not the unstamped 2026-10-27 value whose records are residue', () => {
    expect(IDLE_ACTUATOR_PASS_MARKER).not.toBe('gate-repair-plane-r6-proof-2026-10-27');
  });
});
