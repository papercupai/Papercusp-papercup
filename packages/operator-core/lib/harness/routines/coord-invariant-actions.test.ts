/**
 * coord-invariant-actions — unit tests for the Layer D watchers
 * (coord-system-e2e-testing-2026-06-10 P-012/P-013): the pure probe verdict,
 * the fake-driven probe cycle (happy path, contention violation, mid-cycle
 * failure leaves no held lock), the pure invariant evaluation (each check's
 * threshold + stable dedup titles), and registration.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  evaluateProbe,
  attributeBreach,
  classifyBreach,
  breachDisposition,
  runProbeCycle,
  evaluateInvariants,
  isBackupOrMaintenanceStatement,
  planStaleHandoffAccepts,
  planSharedHiveCapture,
  filterSharedHiveScopes,
  looksLikeWorkItemId,
  type RawSharedHiveScope,
  planClaimIntegrityAlarms,
  planOrphanSweepNotices,
  drainOperationalEscalationsBeforeMeasure,
  DEFAULT_THRESHOLDS,
  ESCALATION_RECONCILE_GRACE_MS,
  PROBE_A,
  PROBE_B,
  type ProbeDeps,
  type ProbeStep,
  type ProbeVerdict,
  type InvariantSnapshot,
  type ClaimIntegrityViolation,
} from './coord-invariant-actions';
import { OPERATIONAL_ESCALATION_TTL_MS } from '../../attention/reconcile-escalations';
import { getSystemAction } from './system-actions';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { isWorkspaceGlobalLabel } from '../../pot-membership';

const idA = { ownerId: PROBE_A, ownerLabel: PROBE_A, source: 'omp-hook-session', workspaceId: 'ws', userId: null } as AgentIdentity;
const idB = { ownerId: PROBE_B, ownerLabel: PROBE_B, source: 'omp-hook-session', workspaceId: 'ws', userId: null } as AgentIdentity;

/** A well-behaved in-memory coordination + lock fake. */
function fakeDeps(over: Partial<ProbeDeps> = {}): ProbeDeps & { held: Map<string, string> } {
  const held = new Map<string, string>();
  let seq = 0;
  let clock = 0;
  const deps: ProbeDeps & { held: Map<string, string> } = {
    held,
    baseline: async () => ({ ok: true }),
    send: async () => ({ msg_id: `m-${++seq}`, ts: new Date(1_700_000_000_000 + seq).toISOString() }),
    inboxHas: async () => true,
    ack: async () => {},
    ackedHas: async () => true,
    acquire: async (owner) => {
      const cur = held.get('probe');
      if (cur && cur !== owner) return { ok: false, busyOwner: cur };
      held.set('probe', owner);
      return { ok: true };
    },
    release: async (owner) => {
      if (held.get('probe') === owner) held.delete('probe');
    },
    now: () => (clock += 10),
    ...over,
  };
  return deps;
}

describe('runProbeCycle + evaluateProbe', () => {
  // A green verdict over ZERO measurements is the "passing probe that never read
  // the value" class: on an empty array the reduce yields 0 and the find yields
  // undefined, so ok would be vacuously true and indistinguishable from a real
  // all-steps-passed cycle. Pinned because the guard is otherwise unreachable
  // from the live caller (runProbeCycle always pushes `baseline` first), which is
  // exactly the condition under which such a guard silently rots.
  it('a cycle that measured NOTHING is never green, and fails open to file', () => {
    const verdict = evaluateProbe([], 10_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.failedStep).toBe('no-steps');
    expect(verdict.sloBreached).toBe(false);
    expect(verdict.totalMs).toBe(0);
    // 'no-steps' matches no real ProbeStep, so there is no `contended` step to
    // downgrade on: the disposition must be 'file', never 'ok' or 'note'.
    expect(breachDisposition(verdict, [])).toBe('file');
  });

  it('happy path: all eight steps (baseline first) pass and the lock ends free', async () => {
    const deps = fakeDeps();
    const steps = await runProbeCycle(deps, idA, idB);
    expect(steps.map((s) => s.step)).toEqual([
      'baseline', 'ping', 'inbox', 'ack', 'lock-acquire', 'lock-contend', 'lock-release', 'lock-regrant',
    ]);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(deps.held.size).toBe(0);
    const verdict = evaluateProbe(steps, 10_000);
    expect(verdict.ok).toBe(true);
    expect(verdict.sloBreached).toBe(false);
  });

  it('reports ack and lock subphase timings inside the measured steps', async () => {
    const deps = fakeDeps();
    const acquire = deps.acquire;
    deps.acquire = async (owner) => ({
      ...(await acquire(owner)),
      detail: 'inWorkspaceTxn=12ms; tryAcquire=2ms',
    });
    const release = deps.release;
    deps.release = async (owner) => {
      await release(owner);
      return { detail: 'inWorkspaceTxn=8ms; tryRelease=1ms' };
    };

    const steps = await runProbeCycle(deps, idA, idB);
    expect(steps.find((step) => step.step === 'ack')?.detail)
      .toBe('appendAck/sendMessage=10ms; readAckedMsgIds=10ms');
    expect(steps.find((step) => step.step === 'lock-acquire')?.detail)
      .toBe('inWorkspaceTxn=12ms; tryAcquire=2ms');
    expect(steps.find((step) => step.step === 'lock-contend')?.detail)
      .toBe('inWorkspaceTxn=12ms; tryAcquire=2ms');
    expect(steps.find((step) => step.step === 'lock-release')?.detail)
      .toBe('inWorkspaceTxn=8ms; tryRelease=1ms');
    expect(steps.find((step) => step.step === 'lock-regrant')?.detail)
      .toBe('inWorkspaceTxn=12ms; tryAcquire=2ms; regrant release: inWorkspaceTxn=8ms; tryRelease=1ms');
  });

  it('a contender GRANTED a held lock is a violation, and the holder still releases', async () => {
    const deps = fakeDeps({
      acquire: async () => ({ ok: true }), // mutual exclusion broken
    });
    const steps = await runProbeCycle(deps, idA, idB);
    const contend = steps.find((s) => s.step === 'lock-contend');
    expect(contend?.ok).toBe(false);
    expect(contend?.detail).toContain('GRANTED');
    const verdict = evaluateProbe(steps, 10_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.failedStep).toBe('lock-contend');
  });

  it('a throwing step records the failure and stops the cycle', async () => {
    const deps = fakeDeps({ inboxHas: async () => Promise.reject(new Error('inbox query died')) });
    const steps = await runProbeCycle(deps, idA, idB);
    expect(steps.map((s) => s.step)).toEqual(['baseline', 'ping', 'inbox']);
    expect(steps[2].ok).toBe(false);
    expect(steps[2].detail).toContain('inbox query died');
  });

  it('keeps transaction phase diagnostics visible when a lock step throws', async () => {
    const failure = Object.assign(new Error('workspace transaction failed'), {
      probeTimingDetail: 'txnPhases=pool-acquire-and-begin=31.2ms, transaction-settlement=2.1ms',
    });
    const deps = fakeDeps({ acquire: async () => { throw failure; } });
    const steps = await runProbeCycle(deps, idA, idB);
    const acquire = steps.find((step) => step.step === 'lock-acquire');
    expect(acquire?.ok).toBe(false);
    expect(acquire?.detail).toBe(
      'workspace transaction failed; txnPhases=pool-acquire-and-begin=31.2ms, transaction-settlement=2.1ms',
    );
  });

  it('a failed baseline (DB unreachable) aborts before any coord verb', async () => {
    const deps = fakeDeps({ baseline: async () => Promise.reject(new Error('SELECT 1 timed out')) });
    const steps = await runProbeCycle(deps, idA, idB);
    expect(steps.map((s) => s.step)).toEqual(['baseline']);
    expect(steps[0].ok).toBe(false);
    expect(steps[0].detail).toContain('SELECT 1 timed out');
  });

  it('a clean-but-slow cycle breaches the SLO', () => {
    const steps: ProbeStep[] = [
      { step: 'ping', ok: true, ms: 6_000 },
      { step: 'inbox', ok: true, ms: 6_000 },
    ];
    const verdict = evaluateProbe(steps, 10_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.sloBreached).toBe(true);
    expect(verdict.failedStep).toBeUndefined();
  });
});

describe('attributeBreach (measured-boundary wording)', () => {
  const step = (s: string, ms: number): ProbeStep => ({ step: s, ok: true, ms });

  it('reports a slow baseline control without localizing its cause', () => {
    const hint = attributeBreach([step('baseline', 9_000), step('ping', 12_000), step('ack', 9_000)]);
    expect(hint).toContain('SELECT 1 baseline control took 9000ms');
    expect(hint).toContain('does not distinguish connection-pool wait');
    expect(hint).not.toContain('DB-wide');
  });

  it('reports end-to-end coord timings without naming a database cause', () => {
    const hint = attributeBreach([step('baseline', 5), step('ping', 12_000), step('ack', 9_000), step('inbox', 477)]);
    expect(hint).toContain('end-to-end coord ping took 12000ms and ack-plus-readback took 9000ms');
    expect(hint).toContain('do not isolate coord_event_log INSERT/commit/NOTIFY');
    expect(hint).not.toContain('the cost is');
  });

  it('leaves the full-cycle cause unattributed when compared timings are below threshold', () => {
    const hint = attributeBreach([step('baseline', 5), step('ping', 100), step('ack', 80)]);
    expect(hint).toContain('do not isolate the cause of the full-cycle delay');
  });

  it('does not infer write-layer dominance from the Sep 26 end-to-end timings', () => {
    const hint = attributeBreach([
      step('baseline', 1_591),
      step('ping', 2_894),
      step('inbox', 292),
      step('ack', 6_044),
      step('lock-acquire', 11_333),
      step('lock-contend', 3_065),
      step('lock-release', 4_161),
      step('lock-regrant', 2_749),
    ]);
    expect(hint).toContain('end-to-end coord ping took 2894ms and ack-plus-readback took 6044ms');
    expect(hint).toContain('do not isolate coord_event_log INSERT/commit/NOTIFY');
    expect(hint).toContain('or show that these steps dominate the full cycle');
  });
});

describe('classifyBreach', () => {
  const step = (s: string, ms: number): ProbeStep => ({ step: s, ok: true, ms });

  it('classifies only the measured baseline and end-to-end operation thresholds', () => {
    expect(classifyBreach([step('baseline', 9_000), step('ping', 12_000), step('ack', 9_000)])).toBe('baseline-slow');
    expect(classifyBreach([step('baseline', 5), step('ping', 12_000), step('ack', 9_000)])).toBe('coord-operations-slow');
  });

  it('returns unattributed when compared timings are below threshold, none without a baseline', () => {
    expect(classifyBreach([step('baseline', 5), step('ping', 100), step('ack', 80)])).toBe('unattributed');
    expect(classifyBreach([step('ping', 12_000), step('ack', 9_000)])).toBe('none');
  });
});

describe('breachDisposition (EI-401 file-vs-note)', () => {
  const step = (s: string, ms: number): ProbeStep => ({ step: s, ok: true, ms });
  const verdict = (over: Partial<ProbeVerdict>): ProbeVerdict =>
    ({ ok: false, totalMs: 30_001, sloBreached: true, ...over });

  it('keeps the owner-ratified note disposition for a pure SLO breach with a slow baseline control', () => {
    const steps = [step('baseline', 9_000), step('ping', 12_000), step('ack', 9_000)];
    expect(breachDisposition(verdict({ sloBreached: true }), steps)).toBe('note');
  });

  it('FILES a pure SLO breach with slow end-to-end coord operations for further investigation', () => {
    const steps = [step('baseline', 5), step('ping', 12_000), step('ack', 9_000), step('inbox', 477)];
    expect(breachDisposition(verdict({ sloBreached: true }), steps)).toBe('file');
  });

  it('FILES a cumulative breach and an unattributable one (fail open, never swallow)', () => {
    expect(breachDisposition(verdict({ sloBreached: true }), [step('baseline', 5), step('ping', 100), step('ack', 80)])).toBe('file');
    // no baseline sampled ⇒ classifyBreach 'none' ⇒ still files.
    expect(breachDisposition(verdict({ sloBreached: true }), [step('ping', 40_000)])).toBe('file');
  });

  it('always FILES a failed step regardless of latency attribution', () => {
    // A failed step is a correctness failure: evaluateProbe leaves sloBreached=false,
    // so even a slow baseline never downgrades it.
    const steps = [step('baseline', 9_000), { step: 'lock-contend', ok: false, ms: 5 }];
    expect(breachDisposition(verdict({ sloBreached: false, failedStep: 'lock-contend' }), steps)).toBe('file');
  });

  it('a clean cycle is ok (nothing filed or noted)', () => {
    expect(breachDisposition({ ok: true, totalMs: 200, sloBreached: false }, [step('baseline', 5)])).toBe('ok');
  });
});

describe('evaluateInvariants', () => {
  const NOW = Date.parse('2026-06-10T12:00:00Z');
  const cleanSnap: InvariantSnapshot = {
    openHandoffTs: [],
    openEscalations: [],
    longExpiredLocks: 0,
    presenceGhosts: 0,
    wakeQueueDepth: 0,
    wakeQueueOldestMs: null,
    coordLogFurnaces: [],
    coordLogActiveOffenders: [],
    sessionTurnPartsCopyHolders: [],
    sessionTurnPartsLockWaiters: [],
    accessExclusiveLockWaiters: [],
    accessShareLockWaiters: [],
  };
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  const TTL_H = OPERATIONAL_ESCALATION_TTL_MS / 3_600_000;
  // EI-7087: the invariant's effective threshold is TTL + a reconcile-cadence grace
  // (see ESCALATION_RECONCILE_GRACE_MS) — assert against the EFFECTIVE boundary, not
  // the bare TTL, so these tests track what the check actually fires on.
  const GRACE_H = ESCALATION_RECONCILE_GRACE_MS / 3_600_000;
  const EFFECTIVE_H = TTL_H + GRACE_H;
  /** An OPERATIONAL escalation (system/infra-emitter, option-less) opened `h` hours ago. */
  const opEsc = (h: number, from = 'system') => ({ ts: hoursAgo(h), from, hasOptions: false });

  it('a clean snapshot yields no violations', () => {
    expect(evaluateInvariants(cleanSnap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it('each check fires past its threshold with a STABLE dedup title', () => {
    const snap: InvariantSnapshot = {
      openHandoffTs: [hoursAgo(13), hoursAgo(1)], // 1 stuck, 1 fresh
      openEscalations: [opEsc(EFFECTIVE_H + 1)], // operational, past TTL + reconcile grace
      longExpiredLocks: 2,
      presenceGhosts: 3,
      wakeQueueDepth: 251, // EI-10177: > wakeQueueDepthMax (250) — a genuine runaway
      wakeQueueOldestMs: NOW - 1_000,
      coordLogFurnaces: [
        { queryid: '123', queryPreview: 'SELECT body FROM harness_shared.coord_event_log ...', calls: 285_000, rowsPerCall: 80_000, meanExecMs: 500 },
      ],
      coordLogActiveOffenders: [],
      sessionTurnPartsCopyHolders: [{ pid: 1176879, applicationName: 'pg_dump', durationSeconds: 690 }],
      sessionTurnPartsLockWaiters: [{
        pid: 1177000,
        applicationName: 'operator',
        mode: 'RowExclusiveLock',
        durationSeconds: 600,
        queryPreview: 'INSERT INTO harness_shared.session_turn_parts ...',
      }],
      accessExclusiveLockWaiters: [],
      accessShareLockWaiters: [],
    };
    const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
    expect(violations.map((v) => v.title)).toEqual([
      'coord invariant: handoffs stuck pending past 12h',
      'coord invariant: operational escalations undrained past reconcile TTL',
      'coord invariant: file locks held past TTL without sweep',
      'coord invariant: presence ghosts lingering past 72h',
      'coord invariant: wake-queue depth/age growth',
      'coord invariant: session_turn_parts COPY lock convoy',
      'coord invariant: unbounded coord_event_log read pattern (furnace class)',
    ]);
    // Stability: re-evaluating yields the SAME titles (the dedup key).
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW).map((v) => v.title)).toEqual(
      violations.map((v) => v.title),
    );
  });

  it('fresh handoffs + operational escalations under their windows do not fire', () => {
    const snap = {
      ...cleanSnap,
      openHandoffTs: [hoursAgo(11)], // under the 12h stuck-handoff window
      openEscalations: [opEsc(TTL_H - 1)], // operational, still within the reconcile TTL
    };
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it('EI-7087: an escalation past the bare TTL but still within the reconcile-cadence grace does not fire', () => {
    // This is the exact false-positive this fix closes: an operational escalation
    // that crossed the 48h TTL boundary between two hourly reconcile ticks is, by
    // construction, still "open" when the invariant checks — but the reconcile sweep
    // is working fine and will drain it at its very next tick. Only past TTL+grace
    // is a genuine drain-failure signal.
    const snap = { ...cleanSnap, openEscalations: [opEsc(TTL_H + GRACE_H / 2)] };
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it('EI-6910: the escalation invariant measures substrate DRAIN failure, not the human backlog', () => {
    // GENUINE human-decision escalations (real sender, and/or options) are the human's
    // attention queue — NEVER a substrate leak, however old: no violation.
    expect(
      evaluateInvariants(
        {
          ...cleanSnap,
          openEscalations: [
            { ts: hoursAgo(1000), from: 'operator', hasOptions: true }, // ancient blocker decision
            { ts: hoursAgo(500), from: 's-dead-agent-42', hasOptions: false }, // orphaned agent escalation
          ],
        },
        DEFAULT_THRESHOLDS,
        NOW,
      ),
    ).toEqual([]);

    // OPERATIONAL escalations within the reconcile TTL are being drained on cadence: no violation.
    expect(
      evaluateInvariants(
        { ...cleanSnap, openEscalations: [opEsc(TTL_H - 1, 'system:hive-placement-watchdog'), opEsc(6, 'steering-lease')] },
        DEFAULT_THRESHOLDS,
        NOW,
      ),
    ).toEqual([]);

    // OPERATIONAL escalations PAST the reconcile TTL (+ grace) = the reconcile sweep is
    // genuinely failing: ONE violation.
    const v = evaluateInvariants(
      { ...cleanSnap, openEscalations: [opEsc(EFFECTIVE_H + 1, 'steering-lease'), opEsc(EFFECTIVE_H + 5, 'system')] },
      DEFAULT_THRESHOLDS,
      NOW,
    );
    expect(v).toHaveLength(1);
    expect(v[0].title).toBe('coord invariant: operational escalations undrained past reconcile TTL');
    expect(v[0].detail).toContain('2 operational escalation(s)');
    expect(v[0].severity).toBe('minor');
  });

  it('WI-206095: excludes emitter-owned operational rows from drain-failure alarms', () => {
    const v = evaluateInvariants(
      {
        ...cleanSnap,
        openEscalations: [
          {
            ...opEsc(EFFECTIVE_H + 5, 'system:infra-liveness-alarm'),
            livenessSignature: 'stale-paused-routines',
          },
          {
            ...opEsc(EFFECTIVE_H + 4, 'system:escalation-aging-alarm'),
            selfReconciling: true,
          },
          // Calibration control: the ordinary mass-emitter row remains a real
          // signal if it survives past the sweep deadline.
          opEsc(EFFECTIVE_H + 3, 'system:pot-placement-watchdog'),
        ],
      },
      DEFAULT_THRESHOLDS,
      NOW,
    );
    expect(v).toHaveLength(1);
    expect(v[0].title).toBe('coord invariant: operational escalations undrained past reconcile TTL');
    expect(v[0].detail).toContain('1 operational escalation(s)');
  });

  it('wake-queue fires on AGE only past the auto-expiry deadline + grace (a genuine sweep failure)', () => {
    // pendingWakeStaleHours (24h) + WAKE_QUEUE_STALE_GRACE_MS (1h) = 25h. A wake surviving
    // past that means sweepStalePendingWakes (which runs in-pass just before the check and
    // reaps everything past 24h) genuinely failed — the only real substrate leak.
    const snap = { ...cleanSnap, wakeQueueDepth: 1, wakeQueueOldestMs: NOW - 26 * 3_600_000 };
    const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
    expect(violations).toHaveLength(1);
    expect(violations[0].title).toBe('coord invariant: wake-queue depth/age growth');
  });

  it('EI-8664: does NOT fire on a wake aging within the auto-expiry window (live-owner review backlog, not a leak)', () => {
    // The exact false positive this fixes: a staged wake aged 12.8h — past the OLD 6h
    // alert but well within the 24h auto-expiry sweep window. sweepStalePendingWakes reaps
    // it at 24h; until then it is expected live-owner review backlog, NOT a substrate leak.
    // Alarming on it is the EI-6910 anti-pattern (the human's normal backlog re-filed hourly).
    const snap = { ...cleanSnap, wakeQueueDepth: 16, wakeQueueOldestMs: NOW - 12.8 * 3_600_000 };
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    // Even a wake right at the 24h deadline (just under it) is still within the grace: no fire.
    const atDeadline = { ...cleanSnap, wakeQueueDepth: 1, wakeQueueOldestMs: NOW - 24 * 3_600_000 };
    expect(evaluateInvariants(atDeadline, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it('wake-queue still fires on DEPTH regardless of age (genuine-runaway bloat backstop)', () => {
    // EI-10177: the depth backstop fires only on a genuine runaway (> wakeQueueDepthMax=250),
    // regardless of age — young wakes count here (unlike the AGE leg), this is the storm signal.
    const snap = { ...cleanSnap, wakeQueueDepth: 251, wakeQueueOldestMs: NOW - 1_000 };
    const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
    expect(violations).toHaveLength(1);
    expect(violations[0].title).toBe('coord invariant: wake-queue depth/age growth');
  });

  it('EI-21363741549000811: detects long parts COPYs and queued waiters, but not a short unqueued COPY', () => {
    const shortCopy = {
      ...cleanSnap,
      sessionTurnPartsCopyHolders: [{ pid: 1, applicationName: 'pg_dump', durationSeconds: 10 }],
    };
    expect(evaluateInvariants(shortCopy, DEFAULT_THRESHOLDS, NOW)).toEqual([]);

    const queued = {
      ...shortCopy,
      sessionTurnPartsLockWaiters: [{
        pid: 2,
        applicationName: 'operator',
        mode: 'RowExclusiveLock',
        durationSeconds: 2,
        queryPreview: 'UPDATE harness_shared.session_turn_parts ...',
      }],
    };
    const queuedViolations = evaluateInvariants(queued, DEFAULT_THRESHOLDS, NOW);
    expect(queuedViolations).toHaveLength(1);
    expect(queuedViolations[0].title).toBe('coord invariant: session_turn_parts COPY lock convoy');
    expect(queuedViolations[0].detail).toContain('UPDATE harness_shared.session_turn_parts');

    const longCopy = {
      ...cleanSnap,
      sessionTurnPartsCopyHolders: [{ pid: 3, applicationName: 'pg_dump', durationSeconds: 61 }],
    };
    expect(evaluateInvariants(longCopy, DEFAULT_THRESHOLDS, NOW).map((v) => v.title)).toEqual([
      'coord invariant: session_turn_parts COPY lock convoy',
    ]);
  });

  it('EI-21374588273323330: detects same-relation waiting DDL plus queued readers, but not either side alone', () => {
    const waitingDdlOnly = {
      ...cleanSnap,
      accessExclusiveLockWaiters: [{
        relation: 'harness_shared.scout_routed_ideas',
        pid: 100,
        applicationName: 'psql',
        durationSeconds: 115,
        queryPreview: 'ALTER TABLE ...',
      }],
    };
    expect(evaluateInvariants(waitingDdlOnly, DEFAULT_THRESHOLDS, NOW)).toEqual([]);

    const queuedReaderOnly = {
      ...cleanSnap,
      accessShareLockWaiters: [{
        relation: 'harness_shared.scout_routed_ideas',
        pid: 101,
        applicationName: 'operator',
        durationSeconds: 2,
        queryPreview: 'SELECT ...',
      }],
    };
    expect(evaluateInvariants(queuedReaderOnly, DEFAULT_THRESHOLDS, NOW)).toEqual([]);

    const convoy = {
      ...cleanSnap,
      accessExclusiveLockWaiters: [{
        relation: 'harness_shared.scout_routed_ideas',
        pid: 100,
        applicationName: 'psql',
        durationSeconds: 115,
        queryPreview: 'ALTER TABLE ...',
      }],
      accessShareLockWaiters: [{
        relation: 'harness_shared.scout_routed_ideas',
        pid: 101,
        applicationName: 'operator',
        durationSeconds: 2,
        queryPreview: 'SELECT ...',
      }],
    };
    const violations = evaluateInvariants(convoy, DEFAULT_THRESHOLDS, NOW);
    expect(violations).toHaveLength(1);
    expect(violations[0].title).toBe('coord invariant: waiting AccessExclusiveLock queues AccessShare readers');
    expect(violations[0].severity).toBe('major');
    expect(violations[0].detail).toContain('harness_shared.scout_routed_ideas');
    expect(violations[0].detail).toContain('pid=100');
    expect(violations[0].detail).toContain('pid=101');
  });

  it('EI-10177: does NOT fire on normal live-owner review backlog (depth under the runaway cap)', () => {
    // The exact false positive this fixes: 57 young staged wakes for LIVE owners (observed
    // live, one owner alone at 32) — 0 stale, all within the 24h auto-expiry window. The
    // in-pass sweeps can't/shouldn't reap them (they reap only dead-owner + >staleHours), so
    // the OLD flat cap of 50 re-filed a non-actionable EI every hour (recurred 5×) — the
    // EI-6910/EI-8664 anti-pattern (a count threshold measuring the human's normal review
    // backlog). A busy-fleet backlog under the runaway cap is expected, never a filed bug.
    const snap = { ...cleanSnap, wakeQueueDepth: 57, wakeQueueOldestMs: NOW - 9 * 3_600_000 };
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  it('EI-10257 / EI-10248: the exact stale-re-file snapshot (depth 56, oldest ~10-11h) no longer alarms under the CURRENT thresholds', () => {
    // EI-10257 (auto-filed 2026-07-12 07:37) and its twin EI-10248 (auto-filed 06:37, 2.5min
    // BEFORE the fix committed) are stale re-files of the EI-10177/EI-8664 class: both fired
    // citing "depth=56 (max 50), oldest=~10-11h" — but that `max 50` is the OLD threshold.
    // EI-10177 raised wakeQueueDepthMax 50 → 250 (committed + green in main at 06:39), and the
    // AGE alarm already fires only past the 24h+1h auto-expiry deadline (EI-8664). The alarm
    // kept re-filing only because the deployed :3070 operator predated the raise; the fix is
    // in-tree and this pin proves it. With the CURRENT thresholds, 56 < 250 and 10-11h < 25h
    // ⇒ ZERO violations.
    const snap = { ...cleanSnap, wakeQueueDepth: 56, wakeQueueOldestMs: NOW - 11 * 3_600_000 };
    expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    // EI-10248's exact snapshot: depth=56, oldest=10.0h — same class, same verdict.
    const ei10248 = { ...cleanSnap, wakeQueueDepth: 56, wakeQueueOldestMs: NOW - 10 * 3_600_000 };
    expect(evaluateInvariants(ei10248, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    // EI-10301 (auto-filed 2026-07-12 10:37): another re-file of the SAME class from the
    // still-behind :3070 operator — depth=56, oldest=14.0h. 56 < 250 and 14h < 25h (the 24h
    // auto-expiry + 1h grace) ⇒ ZERO violations. Closest to the AGE deadline of the three
    // pinned snapshots, and still safely under it.
    const ei10301 = { ...cleanSnap, wakeQueueDepth: 56, wakeQueueOldestMs: NOW - 14 * 3_600_000 };
    expect(evaluateInvariants(ei10301, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
  });

  describe('WI-3959: coord_event_log furnace-class recurrence guard', () => {
    it('does not fire under both thresholds', () => {
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [{ queryid: '1', queryPreview: 'SELECT ...', calls: 100, rowsPerCall: 200, meanExecMs: 5 }],
      };
      expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    });

    it('fires on rows/call alone, even with a fast mean exec time', () => {
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          // The WI-3937 shape (readLines full-surface scan): huge rows/call, each
          // individual call still fast (sub-2s) — the aggregate is the furnace, not
          // any single slow call, which is exactly why a rows/call threshold (not
          // just a mean-exec-time one) is needed to catch this class.
          { queryid: 'wi3937', queryPreview: 'SELECT body FROM harness_shared.coord_event_log ORDER BY id ASC', calls: 285_000, rowsPerCall: 80_000, meanExecMs: 500 },
        ],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
      expect(violations[0].title).toBe('coord invariant: unbounded coord_event_log read pattern (furnace class)');
      expect(violations[0].severity).toBe('major');
      expect(violations[0].detail).toContain('wi3937');
      expect(violations[0].detail).toContain('80000');
    });

    it('fires on mean exec time alone, even under the rows/call threshold', () => {
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [{ queryid: 'slow', queryPreview: 'SELECT ... coord_event_log ...', calls: 10, rowsPerCall: 5, meanExecMs: 5_000 }],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
      expect(violations[0].title).toBe('coord invariant: unbounded coord_event_log read pattern (furnace class)');
    });

    it('folds a currently-active offender pid/application_name into the detail when caught mid-scan', () => {
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [{ queryid: 'active-one', queryPreview: 'SELECT ... coord_event_log ...', calls: 1, rowsPerCall: 8_000_000_000, meanExecMs: 130_000 }],
        coordLogActiveOffenders: [{ pid: 4242, applicationName: 'bg-host-substrate', durationSeconds: 130.4 }],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
      expect(violations[0].detail).toContain('pid=4242');
      expect(violations[0].detail).toContain('bg-host-substrate');
    });

    it('EI-9420: a mean-exec-time breach is SUPPRESSED when min_exec_time proves a fast path already exists', () => {
      // Live-verified shape (2026-07-11): a query fixed hours ago (a new index / an
      // added LIMIT) but whose pg_stat_statements lifetime mean is still dragged up by
      // historical pre-fix calls. min_exec_time in the low-hundreds-ms range proves the
      // CURRENT code already has a fast/bounded route — the alarming mean is stale
      // debris, not a live furnace.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          { queryid: 'fixed-hours-ago', queryPreview: 'SELECT body FROM harness_shared.coord_event_log ...', calls: 3202, rowsPerCall: 772, meanExecMs: 7511, minExecMs: 2.3 },
        ],
      };
      expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    });

    it('EI-9420: a mean-exec-time breach STILL fires when min_exec_time shows no fast path ever existed', () => {
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          { queryid: 'genuinely-still-broken', queryPreview: 'SELECT body FROM harness_shared.coord_event_log ...', calls: 500, rowsPerCall: 1000, meanExecMs: 3_000, minExecMs: 2_800 },
        ],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
      expect(violations[0].title).toBe('coord invariant: unbounded coord_event_log read pattern (furnace class)');
      expect(violations[0].detail).toContain('min_exec_ms=2800');
    });

    it('EI-9420: an ABSENT min_exec_time never suppresses (unknown ⇒ still judged on mean alone)', () => {
      // Same shape as the pre-existing "fires on mean exec time alone" test but
      // explicit that omitting minExecMs (an older snapshot shape) is NOT treated as
      // "proven fast" — only a known, low value suppresses.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [{ queryid: 'no-min-data', queryPreview: 'SELECT ... coord_event_log ...', calls: 10, rowsPerCall: 5, meanExecMs: 5_000 }],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
    });

    it('EI-9420: the rows/call leg fires regardless of min_exec_time (never suppressed by a fast best-case)', () => {
      // The WI-3937 class: a habitually-huge row count IS the furnace even when every
      // individual call (including the best case) is fast — rows/call must stay an
      // unconditional trigger, independent of the mean-exec proven-fast-path guard.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          { queryid: 'wi3937-fast-min', queryPreview: 'SELECT body FROM harness_shared.coord_event_log ORDER BY id ASC', calls: 285_000, rowsPerCall: 80_000, meanExecMs: 500, minExecMs: 1 },
        ],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
      expect(violations[0].title).toBe('coord invariant: unbounded coord_event_log read pattern (furnace class)');
    });

    it('EI-9506: a backup/maintenance COPY dump is NOT judged a furnace (rows/call leg exempt)', () => {
      // Live-verified shape (2026-07-11, EI-9506): a pg_dump-style full-table
      // `COPY ... TO stdout` returns the WHOLE table (~102k rows/call) every time —
      // it is a backup, not an application read pattern, so there is nothing to
      // bound. It trips the rows/call leg (>50k) and, having no fast path, is NOT
      // rescued by EI-9420's min_exec suppression — so before this fix it fired the
      // furnace alarm forever with no fixable target.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          {
            queryid: '-6142784371100098654',
            queryPreview:
              'COPY harness_shared.coord_event_log (id, surface, writer_key, msg_id, body, ts, workspace_id, harness_slug, origin, author_pubkey, fed_ts, fed_hlc) TO stdout',
            calls: 1,
            rowsPerCall: 102_306,
            meanExecMs: 2733,
            minExecMs: 2733,
          },
        ],
      };
      expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    });

    it('EI-9506: a genuine application query with the SAME huge rows/call STILL fires (guard is COPY-specific)', () => {
      // The exemption must key on the backup STATEMENT KIND, never on "huge rows are
      // fine" — an app SELECT that habitually returns 100k rows is exactly the
      // WI-3937 furnace the rows/call leg exists to catch.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          {
            queryid: 'app-full-scan',
            queryPreview: 'SELECT body FROM harness_shared.coord_event_log WHERE workspace_id = $1 AND surface = $2 ORDER BY id ASC',
            calls: 285_000,
            rowsPerCall: 102_306,
            meanExecMs: 500,
          },
        ],
      };
      const violations = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW);
      expect(violations).toHaveLength(1);
      expect(violations[0].title).toBe('coord invariant: unbounded coord_event_log read pattern (furnace class)');
    });

    it('EI-9506: isBackupOrMaintenanceStatement matches COPY (any case / leading whitespace) but not a SELECT', () => {
      expect(isBackupOrMaintenanceStatement('COPY harness_shared.coord_event_log (...) TO stdout')).toBe(true);
      expect(isBackupOrMaintenanceStatement('  copy harness_shared.coord_event_log TO stdout')).toBe(true);
      expect(isBackupOrMaintenanceStatement('SELECT body FROM harness_shared.coord_event_log ORDER BY id ASC')).toBe(false);
      // Not a false-positive on a query that merely mentions COPY in a string/column.
      expect(isBackupOrMaintenanceStatement("SELECT body FROM harness_shared.coord_event_log WHERE body->>'kind' = 'copy'")).toBe(false);
    });

    it('EI-9533: a slow VACUUM/ANALYZE maintenance op on coord_event_log is NOT judged a furnace', () => {
      // Live-verified shape (2026-07-11, EI-9533): autovacuum/maintenance
      // `VACUUM ANALYZE` / `ANALYZE harness_shared.coord_event_log` runs multi-second
      // (2.4–3.4s observed) — it touches the whole table BY DESIGN, exactly like the
      // EI-9506 COPY dump, so it must never be judged an application furnace. It trips
      // the MEAN-exec leg (>2000ms) and has NO fast path (min_exec is high too, so
      // EI-9420's suppression cannot rescue it) — the only correct fix is to classify
      // it out by statement kind. (Before this it escaped only incidentally, via the
      // top-N-by-rows/call gather window that its rows/call=0 always ranked below.)
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          {
            queryid: 'vacuum-analyze',
            queryPreview: 'VACUUM ANALYZE harness_shared.coord_event_log',
            calls: 1,
            rowsPerCall: 0,
            meanExecMs: 3432,
            minExecMs: 3432,
          },
          {
            queryid: 'analyze',
            queryPreview: 'ANALYZE harness_shared.coord_event_log',
            calls: 2,
            rowsPerCall: 0,
            meanExecMs: 2378,
            minExecMs: 2209,
          },
        ],
      };
      expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    });

    it('EI-9533: isBackupOrMaintenanceStatement matches VACUUM/ANALYZE but not a SELECT that mentions them', () => {
      expect(isBackupOrMaintenanceStatement('VACUUM ANALYZE harness_shared.coord_event_log')).toBe(true);
      expect(isBackupOrMaintenanceStatement('vacuum harness_shared.coord_event_log')).toBe(true);
      expect(isBackupOrMaintenanceStatement('ANALYZE harness_shared.coord_event_log')).toBe(true);
      expect(isBackupOrMaintenanceStatement('  analyze (verbose) harness_shared.coord_event_log')).toBe(true);
      // Not a false-positive on a SELECT whose body merely mentions vacuum/analyze.
      expect(isBackupOrMaintenanceStatement("SELECT body FROM harness_shared.coord_event_log WHERE body->>'op' = 'vacuum'")).toBe(false);
      expect(isBackupOrMaintenanceStatement("SELECT 'analyze this' FROM harness_shared.coord_event_log")).toBe(false);
    });

    it('EI-21896608538525240/EI-21900571774725690: a CREATE TABLE ... AS SELECT diagnostic scratch snapshot is NOT judged a furnace', () => {
      // Live-verified shape (2026-08-30): an ad-hoc forensic `CREATE TABLE su_probe.cel
      // AS SELECT ... FROM harness_shared.coord_event_log WHERE workspace_id = $5 AND
      // harness_slug = $6` — an operator/agent materializing a one-off scratch snapshot
      // to investigate this very detector — trips the rows/call leg (82,647 > 50,000)
      // exactly like the EI-9506 COPY dump, with no fast path to be rescued by EI-9420's
      // min_exec suppression. Because pg_stat_statements never decays, the SAME byte-
      // identical stats (queryid=-6648459463434723089, calls=3, rows/call=82647,
      // meanExecMs=3136, minExecMs=983) were independently re-observed and re-filed as
      // TWO separate open bugs 63 minutes apart (EI-21896608538525240 at 16:37Z,
      // EI-21900571774725690 at 17:40Z) with zero new activity between the ticks — an
      // unbounded stream of near-duplicate reports about a historical diagnostic query,
      // not a live application furnace.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          {
            queryid: '-6648459463434723089',
            queryPreview:
              'CREATE TABLE su_probe.cel AS SELECT id, workspace_id, harness_slug, surface, ' +
              "CASE WHEN body -> $1 IS NOT NULL THEN jsonb_build_object($2, body -> $3) ELSE $4::jsonb END AS body " +
              'FROM harness_shared.coord_event_log WHERE workspace_id = $5 AND harness_slug = $6',
            calls: 3,
            rowsPerCall: 82_647,
            meanExecMs: 3136,
            minExecMs: 983,
          },
        ],
      };
      expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    });

    it('EI-21896608538525240: isBackupOrMaintenanceStatement matches CREATE [TEMP|UNLOGGED] TABLE but not a SELECT that mentions it', () => {
      expect(isBackupOrMaintenanceStatement('CREATE TABLE su_probe.cel AS SELECT * FROM harness_shared.coord_event_log')).toBe(true);
      expect(isBackupOrMaintenanceStatement('  create table su_probe.cel as select * from harness_shared.coord_event_log')).toBe(true);
      expect(
        isBackupOrMaintenanceStatement('CREATE TEMP TABLE scratch AS SELECT * FROM harness_shared.coord_event_log'),
      ).toBe(true);
      expect(
        isBackupOrMaintenanceStatement('CREATE TEMPORARY TABLE scratch AS SELECT * FROM harness_shared.coord_event_log'),
      ).toBe(true);
      expect(
        isBackupOrMaintenanceStatement('CREATE UNLOGGED TABLE scratch AS SELECT * FROM harness_shared.coord_event_log'),
      ).toBe(true);
      // Not a false-positive on a SELECT whose body merely mentions "create table".
      expect(
        isBackupOrMaintenanceStatement("SELECT body FROM harness_shared.coord_event_log WHERE body->>'op' = 'create table'"),
      ).toBe(false);
    });

    it('EI-9525/EI-9539/EI-9556/EI-9558: the exact 4-furnace snapshot those EIs filed no longer alarms under the CURRENT detector', () => {
      // Regression pin for EI-9525 (auto-filed 2026-07-11 01:38), its exact
      // duplicate EI-9539 (03:38), the third identical recurrence EI-9556
      // (06:38), AND the fourth EI-9558 (07:38) — the same 2h cadence, all minted
      // by a PRE-EI-9420 monitor whose snapshot carried no minExecMs, so nothing
      // could be proven fast, and all flagging the IDENTICAL four queryids below.
      // (The alarm keeps re-filing only because the deployed :3070 operator
      // predates the EI-9420/9506/9533 guards; the fix is in-tree and this pin
      // proves it — each recurrence gets auto-resolved, so the next stale-operator
      // fire 2h later sees no OPEN dup and mints a fresh EI. It stops when the
      // release gate carries these guards to :3070.) Every one of the four
      // statements they flagged is now closed by an EXISTING guard, re-verified
      // against LIVE pg_stat_statements (2026-07-11, EI-9558):
      //   (queryid min_exec_time live values: 7163…=68ms, -5934…=2ms, -1079…=0ms)
      //   1. the pg_dump COPY ... TO stdout (~102k rows/call) → excluded by
      //      isBackupOrMaintenanceStatement (EI-9506) — a backup, not an app read.
      //   2. readInbox's jsonb_exists membership scan (mean 2082ms) → LIMIT +
      //      ts-index (WI-3825); live min_exec_time 68ms proves the fast path.
      //   3. the conditions `(body ? .. OR body ? ..)` scan (mean 6755ms) → ts +
      //      LIMIT + partial index (migration 561); live min_exec_time 2ms.
      //   4. readEventsBounded's `body->>'kind' = ANY(..) LIMIT` (mean 4432ms) →
      //      already LIMIT-clamped + index; live min_exec_time 0ms.
      // With EI-9420's proven-fast-path suppression + EI-9506's COPY exemption both
      // in the deployed code, this snapshot must produce ZERO furnace violations —
      // the alarming means are lifetime debris from before those bounds landed.
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [
          {
            queryid: '-6142784371100098654',
            queryPreview:
              'COPY harness_shared.coord_event_log (id, surface, writer_key, msg_id, body, ts, workspace_id, harness_slug, origin, author_pubkey, fed_ts, fed_hlc) TO stdout',
            calls: 1,
            rowsPerCall: 102_306,
            meanExecMs: 2733,
            minExecMs: 2733,
          },
          {
            queryid: '7163057393307833526',
            queryPreview:
              'SELECT body FROM harness_shared.coord_event_log WHERE workspace_id = $1 AND surface = $3 AND jsonb_typeof(body->$4) = $5 AND (jsonb_exists(body->$6, $2) OR jsonb_exists(body->$7, $8)) ORDER BY id ASC',
            calls: 11_704,
            rowsPerCall: 12_444,
            meanExecMs: 2082,
            minExecMs: 68,
          },
          {
            queryid: '-5934058039784757788',
            queryPreview:
              'SELECT body FROM harness_shared.coord_event_log WHERE workspace_id = $1 AND surface = $2 AND (body ? $3 OR body ? $4) ORDER BY id ASC',
            calls: 3520,
            rowsPerCall: 780,
            meanExecMs: 6765,
            minExecMs: 2,
          },
          {
            queryid: '-1079103094344669412',
            queryPreview:
              "SELECT body FROM harness_shared.coord_event_log WHERE workspace_id = $1 AND surface = $2 AND body->>$5 = ANY($3::text[]) ORDER BY id DESC LIMIT $4",
            calls: 22_034,
            rowsPerCall: 497,
            meanExecMs: 4432,
            minExecMs: 0,
          },
        ],
      };
      expect(evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW)).toEqual([]);
    });

    it('is a stable dedup title across repeated evaluation (never floods the backlog)', () => {
      const snap = {
        ...cleanSnap,
        coordLogFurnaces: [{ queryid: '1', queryPreview: 'x', calls: 1, rowsPerCall: 100_000, meanExecMs: 100 }],
      };
      const first = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW).map((v) => v.title);
      const second = evaluateInvariants(snap, DEFAULT_THRESHOLDS, NOW).map((v) => v.title);
      expect(first).toEqual(second);
    });
  });
});

describe('planStaleHandoffAccepts (F-FIX-037 stale-handoff auto-accept)', () => {
  const NOW = Date.parse('2026-06-20T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

  it('returns the msg_ids of only the handoffs older than the threshold', () => {
    const open = [
      { msg_id: 'h-stale', ts: hoursAgo(13) },
      { msg_id: 'h-fresh', ts: hoursAgo(11) },
      { msg_id: 'h-ancient', ts: hoursAgo(48) },
    ];
    expect(planStaleHandoffAccepts(open, 12, NOW)).toEqual(['h-stale', 'h-ancient']);
  });

  it('is empty when nothing crosses the threshold (and on an empty list)', () => {
    expect(planStaleHandoffAccepts([{ msg_id: 'h1', ts: hoursAgo(1) }], 12, NOW)).toEqual([]);
    expect(planStaleHandoffAccepts([], 12, NOW)).toEqual([]);
  });

  it('uses a strict boundary — exactly-at-threshold is not yet stale, one ms past is', () => {
    expect(planStaleHandoffAccepts([{ msg_id: 'edge', ts: hoursAgo(12) }], 12, NOW)).toEqual([]);
    const justOver = new Date(NOW - 12 * 3_600_000 - 1).toISOString();
    expect(planStaleHandoffAccepts([{ msg_id: 'edge', ts: justOver }], 12, NOW)).toEqual(['edge']);
  });
});

describe('drainOperationalEscalationsBeforeMeasure (EI-8786 drain-before-measure)', () => {
  it('drains stale operational escalations via the reconcile sweep and returns the resolved count', async () => {
    // The fix: the invariant DRAINS in-pass before measuring (mirroring the handoff
    // auto-accept + wake-queue sweeps), so it no longer false-fires when the SEPARATE
    // hourly reconcile DBOS tick is late / shed / down. Here the in-pass reconcile
    // clears the operational backlog itself.
    const reconcile = vi.fn().mockResolvedValue({ resolved: 3 });
    expect(await drainOperationalEscalationsBeforeMeasure(reconcile)).toBe(3);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('is best-effort: a reconcile failure never aborts the invariant pass (returns 0)', async () => {
    // Fail-open: if the in-pass drain throws, the pass continues and the invariant
    // measures the un-drained state (filing a genuine violation) — it must NOT reject.
    const reconcile = vi.fn().mockRejectedValue(new Error('drain failed'));
    await expect(drainOperationalEscalationsBeforeMeasure(reconcile)).resolves.toBe(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});

describe('registration', () => {
  it('all three system actions are registered by the module side-effect', () => {
    expect(getSystemAction('coord-probe-canary')).toBeTypeOf('function');
    expect(getSystemAction('coord-invariant-monitor')).toBeTypeOf('function');
    expect(getSystemAction('claim-integrity-sweep')).toBeTypeOf('function');
  });
});

describe('planClaimIntegrityAlarms (fleet-reliability-verification-2026-07-10 P-001 / EI-8999)', () => {
  const orphaned: ClaimIntegrityViolation = {
    kind: 'orphaned-wip',
    harnessSlug: 'papercusp',
    planSlug: 'some-plan',
    itemId: 'P-001',
    holderOwnerId: 'su-holder-1',
    holderOwnerLabel: 'su · holder-1',
    detail: 'orphaned wip detail',
  };
  // EI-10506: 'unbacked-assignment' was removed as a violation kind — a second
  // orphaned-wip (distinct holder/item) exercises the same independent-per-
  // violation batch behavior the old mixed batch tested.
  const orphaned2: ClaimIntegrityViolation = {
    kind: 'orphaned-wip',
    harnessSlug: 'papercusp',
    planSlug: 'some-plan',
    itemId: 'P-002',
    holderOwnerId: 'su-holder-2',
    holderOwnerLabel: 'su-holder-2',
    detail: 'orphaned wip detail 2',
  };

  it('alarms holder + fleet leader (deduped) when a leader is known and distinct', () => {
    const leaderByOwner = new Map([['su-holder-1', 'su-leader-9']]);
    const [alarm] = planClaimIntegrityAlarms([orphaned], leaderByOwner);
    expect(alarm.targets).toEqual(['su-holder-1', 'su-leader-9']);
    expect(alarm.summary).toContain('orphaned-wip');
    expect(alarm.summary).toContain('some-plan#P-001');
    expect(alarm.violation).toBe(orphaned);
  });

  it('alarms ONLY the holder when no leader is known (null)', () => {
    const leaderByOwner = new Map([['su-holder-1', null]]);
    const [alarm] = planClaimIntegrityAlarms([orphaned], leaderByOwner);
    expect(alarm.targets).toEqual(['su-holder-1']);
  });

  it('alarms ONLY the holder when no leader entry exists at all (map miss)', () => {
    const [alarm] = planClaimIntegrityAlarms([orphaned], new Map());
    expect(alarm.targets).toEqual(['su-holder-1']);
  });

  it('does not double-target when the holder IS the fleet leader', () => {
    const leaderByOwner = new Map([['su-holder-1', 'su-holder-1']]);
    const [alarm] = planClaimIntegrityAlarms([orphaned], leaderByOwner);
    expect(alarm.targets).toEqual(['su-holder-1']);
  });

  it('plans one alarm per violation, independently, for a multi-violation batch', () => {
    const leaderByOwner = new Map([
      ['su-holder-1', 'su-leader-9'],
      ['su-holder-2', null],
    ]);
    const planned = planClaimIntegrityAlarms([orphaned, orphaned2], leaderByOwner);
    expect(planned).toHaveLength(2);
    expect(planned[0].targets).toEqual(['su-holder-1', 'su-leader-9']);
    expect(planned[0].summary).toContain('some-plan#P-001');
    expect(planned[1].targets).toEqual(['su-holder-2']);
    expect(planned[1].summary).toContain('some-plan#P-002');
    expect(planned.every((p) => p.summary.includes('orphaned-wip'))).toBe(true);
  });

  it('returns an empty plan for an empty violation list', () => {
    expect(planClaimIntegrityAlarms([], new Map())).toEqual([]);
  });

  it('EI-10506: unbacked-assignment is removed — the finder is gone and orphaned-wip is the only violation kind', async () => {
    // An assigned-but-unclaimed item is `assigned-idle` — a first-class,
    // EXPECTED disposition: claimPlanItem (liveness.ts, D-004) REFUSES any
    // non-assignee claim, so the assignment IS the anti-double-claim anchor,
    // not a gap a peer can exploit. The old `unbacked-assignment` sweep alarmed
    // on exactly this normal state (a solo agent's lane, one item at a time) —
    // pure false positives. It must stay removed.
    const mod = await import('./coord-invariant-actions');
    expect(typeof mod.findOrphanedWipClaims).toBe('function');
    expect('findUnbackedActiveAssignments' in mod).toBe(false);
    // The sole surviving claim-integrity violation kind.
    const kind: ClaimIntegrityViolation['kind'] = 'orphaned-wip';
    expect(kind).toBe('orphaned-wip');
    // @ts-expect-error — 'unbacked-assignment' must no longer be assignable to the kind union.
    const removed: ClaimIntegrityViolation['kind'] = 'unbacked-assignment';
    expect(removed).toBe('unbacked-assignment');
  });
});

describe('planSharedHiveCapture (shared-hive-loop P-012/P-013 leg)', () => {
  const requireCapturePlan = (...args: Parameters<typeof planSharedHiveCapture>) => {
    const plan = planSharedHiveCapture(...args);
    expect(plan).not.toBeNull();
    return plan!;
  };

  it('maps every incident kind to a STABLE dedup title + severity', () => {
    const detail = { whatever: true };
    expect(requireCapturePlan({ kind: 'double-completion', title: 'noisy: F-123 by pk-abc…', detail }, 'h1')).toEqual({
      title: 'shared-hive invariant: cross-swarm double completion in h1',
      severity: 'major',
      watchdogKey: 'shared-hive:double-completion:h1',
    });
    expect(requireCapturePlan({ kind: 'outbox-health', title: 'depth 12345 > 10000', detail }, 'h1')).toEqual({
      title: 'shared-hive invariant: substrate outbox depth/age breach in h1',
      severity: 'major',
      watchdogKey: 'shared-hive:outbox-health:h1',
    });
    expect(requireCapturePlan({ kind: 'presence-ghost', title: 'ghost pk-xyz… holds 3', detail }, 'h1')).toEqual({
      title: 'shared-hive invariant: presence ghost anchoring live leases in h1',
      severity: 'minor',
      watchdogKey: 'shared-hive:presence-ghost:h1',
    });
    // A successful orphan sweep is healthy recovery, not a defect. The caller
    // still receives the incident so it can notify the swept holder.
    expect(planSharedHiveCapture({ kind: 'orphaned-taken-by', title: '2 cleared', detail }, 'h1')).toBeNull();
    // The volatile per-incident text never leaks into the dedup title.
    expect(requireCapturePlan({ kind: 'double-completion', title: 'F-999 other noise', detail }, 'h1').title).toBe(
      requireCapturePlan({ kind: 'double-completion', title: 'F-123 different noise', detail }, 'h1').title,
    );
  });

  // ── EI-20579195481991931 regression guard ─────────────────────────────────
  // The bug this pins is NOT hypothetical: on the 2026-08-16T11:40Z pass the
  // `peer-federation-silence` incident for `papercusp` (20 of 21 remote logs
  // silent) was declined as a hard-semantic DUPLICATE of the one filed 2s
  // earlier for `hello-world-3-pot` (2 of 3 silent), because the two titles
  // differ only by a harness name. The worse breach vanished; which scope won
  // was decided by the unordered `GROUP BY harness_slug` scan order.
  //
  // A per-harness TITLE is not enough on its own — the semantic band collapsed
  // exactly that. The identity that survives it is `watchdogKey`, so assert on
  // the key, and assert BOTH directions: distinct across scopes (no collapse)
  // and stable across ticks (cross-tick dedup still works).
  it('gives each harness its OWN signal identity so one scope cannot swallow another', () => {
    const detail = { whatever: true };
    const kinds = [
      'peer-federation-silence',
      'double-completion',
      'outbox-health',
      'presence-ghost',
    ] as const;

    for (const kind of kinds) {
      const a = requireCapturePlan({ kind, title: 'volatile text A', detail }, 'papercusp');
      const b = requireCapturePlan({ kind, title: 'volatile text B', detail }, 'hello-world-3-pot');
      // Two scopes breaching the same way are TWO signals, never one.
      expect(a.watchdogKey).not.toBe(b.watchdogKey);
      // …and the harness is what distinguishes them, not the volatile text.
      expect(a.watchdogKey).toContain('papercusp');
      expect(b.watchdogKey).toContain('hello-world-3-pot');
      // The title must be harness-scoped too, so the two rows are legible to a
      // human without opening the payload.
      expect(a.title).not.toBe(b.title);
      // Cross-TICK dedup is preserved: the same scope + kind is the same signal
      // however much the per-incident text changed between passes.
      expect(requireCapturePlan({ kind, title: 'a later, different reading', detail }, 'papercusp').watchdogKey).toBe(
        a.watchdogKey,
      );
    }

    // Different KINDS in one harness are also different signals — otherwise a
    // noisy minor (orphan sweep) could swallow the major it shares a scope with.
    const perKind = kinds.map((kind) => requireCapturePlan({ kind, title: 't', detail }, 'papercusp').watchdogKey);
    expect(new Set(perKind).size).toBe(kinds.length);
  });

  // FALSIFIABILITY CONTROL (tier 1 — a deliberately-wrong implementation kept in
  // the test file, so proving this guard CAN fail never mutates the shared tree).
  // `legacyPlan` is the pre-fix shape: harness-scoped titles for most kinds, ONE
  // global title for outbox-health, and no signal identity at all. The property
  // below must REJECT it and ACCEPT the real function; if it accepts both, the
  // property is vacuous and the guard above is worthless.
  it('the cross-scope property actually rejects the pre-fix implementation', () => {
    const detail = { whatever: true };
    type Plan = { title: string; watchdogKey?: string };
    const legacyPlan = (kind: string, harness: string): Plan =>
      kind === 'outbox-health'
        ? { title: 'shared-hive invariant: substrate outbox depth/age breach' }
        : { title: `shared-hive invariant: ${kind} in ${harness}` };

    /** Two scopes breaching the same way must be distinguishable as two signals. */
    const scopesAreDistinguishable = (plan: (k: string, h: string) => Plan, kind: string): boolean => {
      const a = plan(kind, 'papercusp');
      const b = plan(kind, 'hello-world-3-pot');
      return a.watchdogKey !== undefined && a.watchdogKey !== b.watchdogKey && a.title !== b.title;
    };

    const real = (k: string, h: string): Plan =>
      requireCapturePlan({ kind: k as 'outbox-health', title: 'volatile', detail }, h);

    // The control FAILS the property — on the peer-silence kind (no key to tell
    // the scopes apart, which is exactly how papercusp got swallowed)…
    expect(scopesAreDistinguishable(legacyPlan, 'peer-federation-silence')).toBe(false);
    // …and on outbox-health, where even the TITLE was shared across harnesses.
    expect(scopesAreDistinguishable(legacyPlan, 'outbox-health')).toBe(false);
    // The real implementation PASSES it (calibration: the property is not
    // trivially false for everything).
    expect(scopesAreDistinguishable(real, 'peer-federation-silence')).toBe(true);
    expect(scopesAreDistinguishable(real, 'outbox-health')).toBe(true);
  });

  it('scopes the pass-level "zero scopes" incident to the PASS, not a harness', () => {
    const detail = { whatever: true };
    // "the monitor resolved zero scopes" is a fact about the whole pass, so it
    // must NOT be harness-keyed — otherwise it re-files once per harness.
    const a = requireCapturePlan({ kind: 'monitor-scope-empty', title: 'x', detail }, 'papercusp');
    const b = requireCapturePlan({ kind: 'monitor-scope-empty', title: 'x', detail }, 'hello-world-3-pot');
    expect(a.watchdogKey).toBe(b.watchdogKey);
    expect(a.title).toBe(b.title);
  });
});

// ── EI-21051034011804969 regression guard ───────────────────────────────────
// The bug this pins: shared-hive scope DISCOVERY (the three-table UNION query in
// `runSharedHiveLeg`) can surface `harness_slug = 'operator:<workspaceId>'` — the
// workspace-global pseudo-harness label an OPERATOR-SCOPE work-item claim
// legitimately carries (get-next.ts's `operatorScopeSlug`), never a real bootable
// Pot/harness. Left unfiltered, every per-harness shared-hive invariant (outbox
// health, double-completion, presence ghosts, orphan sweep) gets computed against
// that phantom scope and re-files a perpetual false positive — exactly what was
// observed live: "shared-hive invariant: substrate outbox depth/age breach in
// operator:default" filed against an outbox that was already fully drained
// (depth 0) by the time it was investigated, because the SCOPE was bogus, not
// the SLO reading.
describe('filterSharedHiveScopes (EI-21051034011804969 regression guard)', () => {
  const scope = (harness_slug: string, pot_slug: string | null = null): RawSharedHiveScope => ({ harness_slug, pot_slug });

  it('excludes the workspace-global operator-scope pseudo-harness label', () => {
    const raw = [scope('operator:default'), scope('papercusp'), scope('oddsmith-hive', 'oddsmith-hive')];
    const filtered = filterSharedHiveScopes(raw, 'default');
    expect(filtered.map((s) => s.harness_slug)).toEqual(['papercusp', 'oddsmith-hive']);
  });

  it('excludes every workspace-global label isWorkspaceGlobalLabel recognizes, not just operator:', () => {
    const raw = [
      scope('operator:ws1'),
      scope('*'),
      scope('@singleton'),
      scope('all'),
      scope('hive-canary'),
      scope('ws1'), // the bare workspace id itself is a partition, not a Pot
      scope('real-pot'),
    ];
    const filtered = filterSharedHiveScopes(raw, 'ws1');
    expect(filtered.map((s) => s.harness_slug)).toEqual(['real-pot']);
  });

  it('keeps real Pot scopes untouched (no over-filtering)', () => {
    const raw = [scope('papercusp', 'papercusp'), scope('oddsmith-hive', 'oddsmith-hive')];
    expect(filterSharedHiveScopes(raw, 'ws1')).toEqual(raw);
  });

  // FALSIFIABILITY CONTROL (tier 1 — a deliberately-wrong pre-fix implementation
  // kept permanently in the test file, per the repo's mutation-probe discipline:
  // proving this guard CAN fail must never mutate the shared tree). This is
  // exactly `runSharedHiveLeg`'s shape BEFORE the EI-21051034011804969 fix — no
  // filter at all, `rawScopes` used as-is.
  it('the exclusion property actually rejects the pre-fix (unfiltered) implementation', () => {
    const raw = [scope('operator:default'), scope('papercusp')];
    const legacyUnfiltered = (rawScopes: RawSharedHiveScope[], _workspaceId: string): RawSharedHiveScope[] => rawScopes;
    // The control keeps the phantom scope — reproducing the live false positive.
    expect(legacyUnfiltered(raw, 'default').some((s) => s.harness_slug === 'operator:default')).toBe(true);
    // The real function excludes it (calibration: the property is not vacuous).
    expect(filterSharedHiveScopes(raw, 'default').some((s) => s.harness_slug === 'operator:default')).toBe(false);
  });
});

// EI-21100148946854844: the live incident this regression guards was filed as
// "shared-hive invariant: substrate outbox depth/age breach in WI-40022" — a
// bogus `harness_slug = 'WI-40022'` (a work-item id, not a harness) reached one
// of the three scope-discovery sources and was scanned as if it were a real
// Pot/harness, producing an unfixable alarm (there is no such harness to green).
describe('filterSharedHiveScopes / looksLikeWorkItemId (EI-21100148946854844 regression guard)', () => {
  const scope = (harness_slug: string, pot_slug: string | null = null): RawSharedHiveScope => ({ harness_slug, pot_slug });

  it('recognizes every work-item family prefix as an id, not a harness slug', () => {
    expect(looksLikeWorkItemId('WI-40022')).toBe(true);
    expect(looksLikeWorkItemId('EI-21100148946854844')).toBe(true);
    expect(looksLikeWorkItemId('F-1234')).toBe(true);
  });

  it('never flags a real (lowercase kebab-case) harness/Pot slug', () => {
    expect(looksLikeWorkItemId('papercusp')).toBe(false);
    expect(looksLikeWorkItemId('hotel-reservations')).toBe(false);
    expect(looksLikeWorkItemId('larkfield-android-20260821')).toBe(false);
    expect(looksLikeWorkItemId('p021-release-proof-android-e5e2cf1')).toBe(false);
  });

  it('excludes a work-item-id scope from the shared-hive monitor, alongside real scopes', () => {
    const raw = [scope('WI-40022'), scope('papercusp'), scope('EI-9', 'EI-9')];
    const filtered = filterSharedHiveScopes(raw, 'default');
    expect(filtered.map((s) => s.harness_slug)).toEqual(['papercusp']);
  });

  // FALSIFIABILITY CONTROL (tier 1 — see the identical control above; the same
  // mutation-probe discipline applies): the pre-fix shape kept ONLY the
  // workspace-global-label filter, which does not reject a work-item id at all.
  it('the exclusion property actually rejects the pre-fix (workspace-label-only) implementation', () => {
    const raw = [scope('WI-40022'), scope('papercusp')];
    const legacyWorkspaceLabelOnly = (rawScopes: RawSharedHiveScope[], workspaceId: string): RawSharedHiveScope[] =>
      rawScopes.filter((s) => !isWorkspaceGlobalLabel(s.harness_slug, workspaceId));
    // The pre-fix control keeps the phantom work-item-id scope — reproducing the live false positive.
    expect(legacyWorkspaceLabelOnly(raw, 'default').some((s) => s.harness_slug === 'WI-40022')).toBe(true);
    // The real function excludes it (calibration: the property is not vacuous).
    expect(filterSharedHiveScopes(raw, 'default').some((s) => s.harness_slug === 'WI-40022')).toBe(false);
  });
});

// WI-39736 fix property 2: a background sweep that DOES release a claim must
// notify the holder, so a silent divergence (agent keeps working an item the
// fleet has re-issued) is impossible. `sweepOrphanedTakenBy` deliberately omits
// the sibling reaper's known-holder clause, so a live REMOTE holder with no
// local presence row is still swept — that is precisely who this notice reaches.
describe('planOrphanSweepNotices (WI-39736 — the swept holder is told)', () => {
  const leaders = (m: Record<string, string | null>) => new Map(Object.entries(m));

  it('addresses the HOLDER and its fleet leader, naming every item it lost', () => {
    const notices = planOrphanSweepNotices(
      [
        { workItemId: 'WI-1', takenBy: 'su-aaa' },
        { workItemId: 'WI-2', takenBy: 'su-aaa' },
      ],
      leaders({ 'su-aaa': 'su-leader' }),
      'sidestage',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].targets).toEqual(['su-aaa', 'su-leader']);
    expect(notices[0].workItemIds).toEqual(['WI-1', 'WI-2']);
    expect(notices[0].summary).toContain('WI-1, WI-2');
    expect(notices[0].summary).toContain('sidestage');
  });

  it('sends ONE notice per holder, not one per item — a swarm death frees many at once', () => {
    // The incident that motivated the fix cleared two items in a single
    // statement; N wakes to the same owner would be a storm, not a signal.
    const notices = planOrphanSweepNotices(
      [
        { workItemId: 'WI-1', takenBy: 'su-aaa' },
        { workItemId: 'WI-2', takenBy: 'su-aaa' },
        { workItemId: 'WI-3', takenBy: 'su-bbb' },
      ],
      leaders({}),
      'sidestage',
    );
    expect(notices.map((n) => n.holderOwnerId).sort()).toEqual(['su-aaa', 'su-bbb']);
    expect(notices.every((n) => n.targets.length === 1)).toBe(true);
  });

  it('never addresses a holder that is itself its fleet leader twice', () => {
    const notices = planOrphanSweepNotices(
      [{ workItemId: 'WI-1', takenBy: 'su-aaa' }],
      leaders({ 'su-aaa': 'su-aaa' }),
      'sidestage',
    );
    expect(notices[0].targets).toEqual(['su-aaa']);
  });

  it('drops non-agent holders — a reaper/system marker has nobody to wake', () => {
    const notices = planOrphanSweepNotices(
      [
        { workItemId: 'WI-1', takenBy: 'reaper:orphan-sweep' },
        { workItemId: 'WI-2', takenBy: 'system:claim-integrity-monitor' },
        { workItemId: 'WI-3', takenBy: '  ' },
        { workItemId: 'WI-4', takenBy: 'su-real' },
      ],
      leaders({}),
      'sidestage',
    );
    expect(notices.map((n) => n.holderOwnerId)).toEqual(['su-real']);
  });

  it('bounds the summary but keeps the full id list on the notice', () => {
    const cleared = Array.from({ length: 8 }, (_, i) => ({ workItemId: `WI-${i}`, takenBy: 'su-aaa' }));
    const [notice] = planOrphanSweepNotices(cleared, leaders({}), 'sidestage');
    expect(notice.workItemIds).toHaveLength(8);
    expect(notice.summary).toContain('+3 more');
    expect(notice.summary).not.toContain('WI-7');
  });

  it('CALIBRATION: an empty sweep produces no notice at all', () => {
    expect(planOrphanSweepNotices([], leaders({}), 'sidestage')).toEqual([]);
  });
});
