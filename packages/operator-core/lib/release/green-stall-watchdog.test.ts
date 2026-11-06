/**
 * EI-455 bug #2 — green-stall-watchdog verdict logic. The DB wiring (checkGreenStall)
 * is integration-covered by the live self-test; here we pin the pure decision +
 * escalation body that decide WHEN the silent-stall alarm fires.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { promisify } from 'node:util';

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

// EI-9922: stub async `execFile` so stderr suppression and fail-soft behavior are
// deterministic regardless of what git checkout (or non-repo) the test runs inside.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: childProcessMocks.execFile };
});
import { execFile } from 'node:child_process';

// Match Node's execFile promisifier: the callback API resolves both output streams as an object.
Object.defineProperty(childProcessMocks.execFile, promisify.custom, {
  value: (...args: unknown[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      Reflect.apply(childProcessMocks.execFile, undefined, [
        ...args,
        (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        },
      ]);
    }),
});

// EI-10103: checkMainBehindStaging's DB writes are exercised with mocked sql/notify/broadcast
// surfaces (mirrors workspace-for-harness.test.ts's mock-the-dependency unit style) rather than
// a live PG — the regression is about which VALUE reaches the harness_escalations insert, not
// schema/constraint enforcement itself.
const resolveWorkspaceForHarnessMock = vi.fn();
vi.mock('../harness/workspace-for-harness', () => ({
  resolveWorkspaceForHarness: (...args: unknown[]) => resolveWorkspaceForHarnessMock(...args),
}));
const notifyAttentionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../attention-notify', () => ({
  notifyAttention: (...args: unknown[]) => notifyAttentionMock(...args),
  // The P-003 rate-alarm block lazy-imports notifyAttentionOnce; a mock module
  // omitting it makes that path throw-into-fail-soft under test, silently.
  notifyAttentionOnce: (...args: unknown[]) => notifyAttentionMock(...args),
}));
const broadcastSevereEventMock = vi.fn().mockResolvedValue(true);
const broadcastSevereEventResolvedMock = vi.fn().mockResolvedValue(true);
vi.mock('../severe-event-broadcast', () => ({
  broadcastSevereEvent: (...args: unknown[]) => broadcastSevereEventMock(...args),
  broadcastSevereEventResolved: (...args: unknown[]) => broadcastSevereEventResolvedMock(...args),
}));

// WI-4322: checkReleaseTriggerFreeze's DB wiring is exercised the same way — mock the
// pipeline-snapshot + status-computation seams it dynamically imports rather than hitting
// real git/PG (the regression under test is the DECISION logic, not those functions).
const gitPipelineSnapshotMock = vi.fn().mockResolvedValue({});
vi.mock('../git-pipeline-stats', () => ({
  gitPipelineSnapshot: (...args: unknown[]) => gitPipelineSnapshotMock(...args),
}));
const computeDeployStatusMock = vi.fn();
const integrationRootMock = vi.fn(() => '/DEFAULT');
vi.mock('../release-deploy-launch', () => ({
  computeDeployStatus: (...args: unknown[]) => computeDeployStatusMock(...args),
  integrationRoot: () => integrationRootMock(),
}));

const resolveCheckpointRoutingMock = vi.fn();
vi.mock('../harness/routines/hive-release-env', () => ({
  resolveCheckpointRouting: (...args: unknown[]) => resolveCheckpointRoutingMock(...args),
}));
const isCheckpointRunLockHeldCheapMock = vi.fn();
const readCheckpointRunPhaseCheapMock = vi.fn();
vi.mock('../release-checkpoint-launch', () => ({
  isCheckpointRunLockHeldCheap: (...args: unknown[]) => isCheckpointRunLockHeldCheapMock(...args),
  readCheckpointRunPhaseCheap: (...args: unknown[]) => readCheckpointRunPhaseCheapMock(...args),
}));
const readRoutineEngineLivenessMock = vi.fn();
vi.mock('./routine-engine-liveness', () => ({
  readRoutineEngineLiveness: (...args: unknown[]) => readRoutineEngineLivenessMock(...args),
}));
const dispatchReleaseFixerMock = vi.fn();
vi.mock('../harness/routines/release-actions', () => ({
  dispatchReleaseFixer: (...args: unknown[]) => dispatchReleaseFixerMock(...args),
}));

import {
  evaluateGreenStall,
  evaluatePausedGreenCheckpoint,
  decidePausedGreenCheckpointRecovery,
  greenCheckpointPausedEscalationBody,
  checkGreenStall,
  parseGreenCheckpointStallEscalation,
  decideGreenCheckpointStallRecovery,
  greenStallEscalationBody,
  evaluateMainBehindStaging,
  mainBehindRecoverySummary,
  computeMainBehindStaging,
  checkMainBehindStaging,
  runInstallScopedWatchdogs,
  evaluateReleaseTriggerFreeze,
  checkReleaseTriggerFreeze,
  lastReleaseTriggerPauseOwner,
  evaluateReleaseTriggerFireStale,
  evaluateStrandedRepairQueue,
  evaluateQuietLiveFixer,
  type StrandedRepairQueueSnapshot,
  checkReleaseTriggerFireStale,
  attributeVerdictStale,
  readLastGateRunEvidence,
  judgeVerdictlessDeath,
  DEFAULT_VERDICTLESS_GRACE_MS,
  decideVerdictlessRefire,
  readGateFireOwnerWall,
  resolveVerdictlessRefireEpisode,
  wakeAbandonedCheckpointAwaits,
  readCheckpointRunState,
  type CheckpointEvidence,
} from './green-stall-watchdog';
import type { StoredInFlightCandidate } from './in-flight-candidate';
import type { EmitAwaitedEventOpts } from '../events/await/engine';
// Imported, never restated: the re-fire tests enumerate the REAL abort table, so adding a
// status there (or reclassifying one) is reported by these tests instead of silently changing
// what the gate will automatically fire on.
import { RECORDED_INCONCLUSIVE_STATUSES, classifyGateAbort } from './gate-abort-status';

const H = 60 * 60 * 1000;
const NOW = 1_750_000_000_000; // fixed epoch ms

describe('install-scoped watchdog dispatch', () => {
  it('runs each sibling check for every matching install, including non-home hives', async () => {
    const rows = [
      { install_slug: 'papercusp', name: 'green-checkpoint', target_role: 'system:green-checkpoint' },
      { install_slug: 'oddsmith', name: 'green-checkpoint', target_role: 'system:green-checkpoint' },
      { install_slug: 'sidestage', name: 'release-trigger', target_role: null },
      { install_slug: 'papercusp', name: 'release-trigger', target_role: null },
      { install_slug: '', name: 'release-trigger', target_role: null },
    ];
    const sql = (async () => rows) as unknown as Sql;
    const checks = {
      releaseTriggerFreeze: vi.fn(async (_installSlug: string) => undefined),
      releaseTriggerFireStale: vi.fn(async (_installSlug: string) => undefined),
      strandedRepairQueue: vi.fn(async (_installSlug: string) => undefined),
      idleRepairQueue: vi.fn(async (_installSlug: string) => undefined),
      gateLiveInvariants: vi.fn(async (_installSlug: string) => undefined),
      greenMainSlo: vi.fn(async (_installSlug: string) => undefined),
    };

    const result = await runInstallScopedWatchdogs(sql, checks);

    expect(result.targets).toEqual({
      greenCheckpoint: ['oddsmith', 'papercusp'],
      releaseTrigger: ['papercusp', 'sidestage'],
    });
    expect(result.failures).toEqual([]);
    for (const check of [checks.strandedRepairQueue, checks.idleRepairQueue, checks.gateLiveInvariants, checks.greenMainSlo]) {
      expect(check.mock.calls.map(([slug]) => slug)).toEqual(['oddsmith', 'papercusp']);
    }
    for (const check of [checks.releaseTriggerFreeze, checks.releaseTriggerFireStale]) {
      expect(check.mock.calls.map(([slug]) => slug)).toEqual(['papercusp', 'sidestage']);
    }
  });
});

function mockGitStdout(...outputs: string[]): void {
  childProcessMocks.execFile.mockImplementation(
    (_command: string, _args: string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, outputs.shift() ?? '', '');
    },
  );
}

const deadCheckpointMarker = (over: Partial<StoredInFlightCandidate> = {}): StoredInFlightCandidate => ({
  candidate: 'deadbeef00112233445566778899aabbccddeeff',
  candidateSource: 'tip',
  base: 'cafe0000112233445566778899aabbccddeeff00',
  selectedAtMs: NOW - 120_000,
  quietCutApplied: false,
  tipAtSelection: null,
  refireDepth: 0,
  pid: 424242,
  observedAtMs: NOW - 120_000,
  // EI-20427717764878875. `null` is the right default for THIS fixture specifically: it models an
  // ABANDONED run — one that died without ever reaching a verdict — so a stamped decision time
  // would contradict the very condition these cases exercise.
  verdictWrittenAtMs: null,
  ...over,
});

describe('wakeAbandonedCheckpointAwaits (WI-6989)', () => {
  it.each(['live', 'unknown', 'dead'] as const)(
    'checks qualification custody before treating a dead marker PID as abandoned: %s', async liveness => {
      const { beginQualificationTransaction, reserveQualificationRunner } =
        await import('./checkpoint-qualification-transaction');
      const begun = beginQualificationTransaction(null, { attemptId: 'marker-custody', nowMs: NOW - 60_000 }).transaction;
      const qualification = reserveQualificationRunner(begun, {
        attemptId: begun.attemptId, runnerId: 'marker-runner',
        unit: 'checkpoint-root.scope', leaseDurationMs: 1_000, nowMs: NOW - 60_000,
      }).transaction;
      const probeQualificationRunner = vi.fn(async () => liveness);
      const emit = vi.fn().mockResolvedValue({ ok: true });
      const recordLostRun = vi.fn().mockResolvedValue(undefined);
      const clearIfUnchanged = vi.fn().mockResolvedValue(true);
      const result = await wakeAbandonedCheckpointAwaits({
        installSlug: 'papercusp', workspaceId: 'papercusp-workspace',
        rawMarker: deadCheckpointMarker(), rawQualification: qualification,
      }, { nowMs: NOW, selfPid: 7, pidAlive: () => false, probeQualificationRunner,
        emit, recordLostRun, clearIfUnchanged });
      expect(probeQualificationRunner).toHaveBeenCalledWith(qualification.currentPhysicalRunner, NOW);
      if (liveness === 'dead') {
        expect(result.status).toBe('woken');
        expect(recordLostRun).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledTimes(2);
        expect(clearIfUnchanged).toHaveBeenCalledOnce();
      } else {
        expect(result).toEqual({ status: 'not-abandoned', reason: `qualification-custody-${liveness}` });
        expect(recordLostRun).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(clearIfUnchanged).not.toHaveBeenCalled();
      }
    },
  );

  it('emits the existing global + pipeline inconclusive keys for an unscoped or candidate-bound waiter', async () => {
    const order: string[] = [];
    const emit = vi.fn(async (opts: EmitAwaitedEventOpts) => {
      order.push(`emit:${opts.key}`);
      return { ok: true };
    });
    const recordLostRun = vi.fn(async () => {
      order.push('record');
    });
    const clearIfUnchanged = vi.fn(async () => {
      order.push('clear');
      return true;
    });

    await expect(
      wakeAbandonedCheckpointAwaits(
        {
          installSlug: 'papercusp',
          workspaceId: 'papercusp-workspace',
          rawMarker: deadCheckpointMarker(),
        },
        { nowMs: NOW, selfPid: 7, pidAlive: () => false, emit, recordLostRun, clearIfUnchanged },
      ),
    ).resolves.toEqual({
      status: 'woken',
      candidate: deadCheckpointMarker().candidate,
      markerCleared: true,
    });

    expect(order).toEqual([
      'record',
      'emit:green-checkpoint:inconclusive',
      'emit:green-checkpoint:inconclusive:papercusp',
      'clear',
    ]);
    expect(emit).toHaveBeenCalledTimes(2);
    for (const [opts] of emit.mock.calls) {
      expect(opts.payload).toMatchObject({
        sha: deadCheckpointMarker().candidate,
        pipeline: 'papercusp',
        reason: 'process-disappeared',
      });
      expect(opts.cancelSiblingKeysFor).toEqual([
        'release:green',
        'release:green:papercusp',
        'green-checkpoint:red',
        'green-checkpoint:red:papercusp',
        'green-checkpoint:held',
        'green-checkpoint:held:papercusp',
      ]);
    }
  });

  it('records the lost run and clears only its DBOS dedup row in one transaction', async () => {
    const order: string[] = [];
    const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
    const transaction = {
      unsafe: async (text: string, values: unknown[] = []) => {
        sqlCalls.push({ text, values });
        order.push(text.includes('UPDATE dbos.workflow_status') ? 'dedup-clear' : 'lost-run-record');
        return text.includes('UPDATE dbos.workflow_status')
          ? [{ workflow_uuid: 'routine-fire-workflow-42' }]
          : [];
      },
    };
    const dbosSql = {
      begin: async (run: (tx: typeof transaction) => Promise<unknown>) => {
        order.push('transaction-begin');
        const result = await run(transaction);
        order.push('transaction-commit');
        return result;
      },
    } as unknown as Sql;
    const emit = vi.fn(async (opts: EmitAwaitedEventOpts) => {
      order.push(`emit:${opts.key}`);
      return { ok: true };
    });
    const clearIfUnchanged = vi.fn(async () => {
      order.push('marker-clear');
      return true;
    });
    const marker = {
      ...deadCheckpointMarker(),
      routineId: 'rt_papercusp_green_checkpoint',
      routineFireWorkflowId: 'routine-fire-workflow-42',
    };

    await expect(
      wakeAbandonedCheckpointAwaits(
        { installSlug: 'papercusp', workspaceId: 'papercusp-workspace', rawMarker: marker },
        { nowMs: NOW, selfPid: 7, pidAlive: () => false, dbosSql, emit, clearIfUnchanged },
      ),
    ).resolves.toEqual({ status: 'woken', candidate: marker.candidate, markerCleared: true });

    expect(order).toEqual([
      'transaction-begin',
      'lost-run-record',
      'dedup-clear',
      'transaction-commit',
      'emit:green-checkpoint:inconclusive',
      'emit:green-checkpoint:inconclusive:papercusp',
      'marker-clear',
    ]);
    expect(sqlCalls[1]?.text).toContain('workflow_uuid = $1');
    expect(sqlCalls[1]?.text).toContain('deduplication_id = $2');
    expect(sqlCalls[1]?.values).toEqual([
      marker.routineFireWorkflowId,
      `routine:${marker.routineId}`,
      marker.observedAtMs,
      marker.routineId,
      'papercusp',
      'papercusp-workspace',
    ]);
  });

  it('keeps the dead marker for retry when the lost-run/dedup transaction fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn();
    const clearIfUnchanged = vi.fn();
    const dbosSql = {
      begin: async () => {
        throw new Error('transaction unavailable');
      },
    } as unknown as Sql;
    const marker = {
      ...deadCheckpointMarker(),
      routineId: 'rt_papercusp_green_checkpoint',
      routineFireWorkflowId: 'routine-fire-workflow-42',
    };

    await expect(
      wakeAbandonedCheckpointAwaits(
        { installSlug: 'papercusp', workspaceId: 'papercusp-workspace', rawMarker: marker },
        { nowMs: NOW, selfPid: 7, pidAlive: () => false, dbosSql, emit, clearIfUnchanged },
      ),
    ).resolves.toEqual({ status: 'dedup-clear-failed', candidate: marker.candidate });
    expect(emit).not.toHaveBeenCalled();
    expect(clearIfUnchanged).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('will retry'));
    warn.mockRestore();
  });

  it('leaves a live checkpoint marker and all await registrations untouched', async () => {
    const emit = vi.fn();
    const recordLostRun = vi.fn();
    const clearIfUnchanged = vi.fn();
    const dbosSql = { begin: vi.fn() } as unknown as Sql;
    const marker = {
      ...deadCheckpointMarker(),
      routineId: 'rt_papercusp_green_checkpoint',
      routineFireWorkflowId: 'routine-fire-workflow-42',
    };
    await expect(
      wakeAbandonedCheckpointAwaits(
        {
          installSlug: 'papercusp',
          workspaceId: 'papercusp-workspace',
          rawMarker: marker,
        },
        { nowMs: NOW, selfPid: 7, pidAlive: () => true, emit, recordLostRun, clearIfUnchanged, dbosSql },
      ),
    ).resolves.toEqual({ status: 'not-abandoned', reason: 'pid-alive' });
    expect(emit).not.toHaveBeenCalled();
    expect(recordLostRun).not.toHaveBeenCalled();
    expect(clearIfUnchanged).not.toHaveBeenCalled();
    expect(dbosSql.begin).not.toHaveBeenCalled();
  });

  it('retains the dead marker when event delivery fails so the next watchdog pass retries', async () => {
    const clearIfUnchanged = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      wakeAbandonedCheckpointAwaits(
        {
          installSlug: 'papercusp',
          workspaceId: 'papercusp-workspace',
          rawMarker: deadCheckpointMarker(),
        },
        {
          nowMs: NOW,
          selfPid: 7,
          pidAlive: () => false,
          recordLostRun: vi.fn().mockResolvedValue(undefined),
          emit: vi.fn().mockRejectedValue(new Error('event store unavailable')),
          clearIfUnchanged,
        },
      ),
    ).resolves.toEqual({ status: 'emit-failed', candidate: deadCheckpointMarker().candidate });
    expect(clearIfUnchanged).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('will retry'));
    warn.mockRestore();
  });
});

describe('evaluateGreenStall', () => {
  it('a fresh install (never fired, never green) does not alarm', () => {
    const v = evaluateGreenStall({ lastFiredMs: null, lastGreenAt: null, watchdogAlerted: false }, NOW);
    expect(v.stalled).toBe(false);
    expect(v.fireStale).toBe(false);
    expect(v.verdictStale).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('a healthy routine (fired + greened within the hour) does not alarm', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 20 * 60 * 1000, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  /**
   * P-016 — "muted" and "healthy" are different answers.
   *
   * Both render `stalled: false`, and collapsing them is what made the watchdog
   * broadcast `green-checkpoint RECOVERED — the gate is producing verdicts
   * again` from the branch that deliberately declined to check. Engine staleness
   * flickers on a loaded box, so that false all-clear fired on every flicker —
   * the observed STALLED/RECOVERED alternation inside one window on oddsmith.
   */
  describe('suppressed is not healthy (P-016)', () => {
    /** A gate that IS genuinely stalled — 4h since a fire, 4h since a green. */
    const STALLED = { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 4 * H, watchdogAlerted: false };

    it('a stalled gate under a STALE root engine reports suppressed, not healthy', () => {
      const v = evaluateGreenStall({ ...STALLED, routineEngineStale: true }, NOW);
      expect(v.suppressed).toBe(true);
      expect(v.stalled).toBe(false); // muted — infra-liveness owns the root alarm
    });

    it('CONTROL: the SAME snapshot with a live engine is a real stall, not suppressed', () => {
      // The discriminator is the engine reading alone — proving `suppressed`
      // tracks "did we look", not "is the gate fine".
      const v = evaluateGreenStall({ ...STALLED, routineEngineStale: false }, NOW);
      expect(v.suppressed).toBe(false);
      expect(v.stalled).toBe(true);
    });

    it('CONTROL: a genuinely healthy gate is NOT suppressed — it was judged, and judged fine', () => {
      const v = evaluateGreenStall(
        { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 20 * 60 * 1000, watchdogAlerted: false },
        NOW,
      );
      expect(v.suppressed).toBe(false);
      expect(v.stalled).toBe(false);
      // Healthy and suppressed are now distinguishable from the verdict alone —
      // which is the property the recovery branch depends on.
      expect(v.stalled === false && v.suppressed === false).toBe(true);
    });

    it('unknown engine liveness fails OPEN (undefined is not stale) — a real stall still alarms', () => {
      const v = evaluateGreenStall({ ...STALLED }, NOW);
      expect(v.suppressed).toBe(false);
      expect(v.stalled).toBe(true);
    });
  });

  it('FIRE-STALE: an active routine that stopped firing (>3h) alarms — the EI-455 wedge signature', () => {
    // The in-routine detector is blind to this (it only runs when the routine fires).
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 4 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.fireStale).toBe(true);
    expect(v.reason).toContain('has not FIRED');
  });

  it('VERDICT-STALE: firing fine but no green in >12h alarms (deep backstop)', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.fireStale).toBe(false);
    expect(v.verdictStale).toBe(true);
    expect(v.reason).toContain('no GREEN verdict');
  });

  it('does NOT double-fire with the in-routine 6h alarm: a 7h-stale green while still firing is not yet watchdog-stalled', () => {
    // The in-routine STALL_AGE_MS=6h owns this window; the watchdog's 12h backstop
    // only trips if that path also failed. So 7h-stale-while-firing stays quiet here.
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 7 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  it('BOTH stale: the wedge that also aged past the green backstop reports both clauses', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 5 * H, lastGreenAt: NOW - 24 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.fireStale).toBe(true);
    expect(v.verdictStale).toBe(true);
    expect(v.reason).toContain('has not FIRED');
    expect(v.reason).toContain('no GREEN verdict');
  });

  it('honors custom thresholds', () => {
    const tight = { fireStaleMs: 30 * 60 * 1000, noGreenMs: H };
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 45 * 60 * 1000, lastGreenAt: NOW - 45 * 60 * 1000, watchdogAlerted: false },
      NOW,
      tight,
    );
    expect(v.fireStale).toBe(true);
  });

  it('boundary: exactly at the fire-stale threshold does not alarm (strict >)', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 3 * H, lastGreenAt: NOW - 3 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.fireStale).toBe(false);
    expect(v.stalled).toBe(false);
  });

  it('a routine that fired recently but has NEVER greened does not verdict-alarm (no lastGreenAt to age)', () => {
    // Fire-recency is healthy here; lastGreenAt null can't be aged. Caught only once
    // firing also goes stale (the wedge) — avoids false alarms on a never-green fresh start.
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 10 * 60 * 1000, lastGreenAt: null, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  it('EI-2994: a stale root routine engine suppresses green-specific symptom alarms', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 5 * H, lastGreenAt: NOW - 24 * H, watchdogAlerted: false, routineEngineStale: true },
      NOW,
    );
    expect(v.stalled).toBe(false);
    expect(v.fireStale).toBe(false);
    expect(v.verdictStale).toBe(false);
    expect(v.reason).toBeNull();
  });

  describe('active checkpoint delivery suppression (EI-20378004056924553)', () => {
    const STALLED = {
      lastFiredMs: NOW - 4 * H,
      lastGreenAt: NOW - 13 * H,
      watchdogAlerted: false,
    };

    it('suppresses only a live run in the exact delivering phase', () => {
      const v = evaluateGreenStall(
        { ...STALLED, checkpointRunActive: true, checkpointRunPhase: 'delivering' },
        NOW,
      );
      // Exact-shape on purpose: a suppressed pass must claim NOTHING, so every limb —
      // including P-006's `verdictless` — has to read false here, not merely `stalled`.
      expect(v).toEqual({
        stalled: false,
        fireStale: false,
        verdictStale: false,
        verdictless: false,
        suppressed: true,
        reason: null,
      });
    });

    it.each([
      ['missing phase', { checkpointRunActive: true, checkpointRunPhase: undefined }],
      ['unknown phase', { checkpointRunActive: true, checkpointRunPhase: null }],
      ['different phase', { checkpointRunActive: true, checkpointRunPhase: 'suite' }],
      ['no live lock', { checkpointRunActive: false, checkpointRunPhase: 'delivering' }],
      ['unknown lock', { checkpointRunActive: undefined, checkpointRunPhase: 'delivering' }],
    ])('%s fails open to the ordinary stall verdict', (_label, state) => {
      const v = evaluateGreenStall({ ...STALLED, ...state }, NOW);
      expect(v.suppressed).toBe(false);
      expect(v.stalled).toBe(true);
      expect(v.fireStale).toBe(true);
      expect(v.verdictStale).toBe(true);
    });
  });

  // EI-7505: the alarm reason previously never named WHICH test(s) are failing
  // the verdict, forcing a responder to hand-spelunk harness_shared.test_runs
  // (inconclusive — mixes every agent's local dev-test runs with the verdict
  // run) during a live deploy-freeze. gate_health.failingTests (persisted by
  // trackGateStall in release-actions.ts) is now threaded into the reason.
  it('EI-7505: a verdict-stale alarm names the failing test(s) when gate_health carries them', () => {
    const v = evaluateGreenStall(
      {
        lastFiredMs: NOW - 20 * 60 * 1000,
        lastGreenAt: NOW - 13 * H,
        watchdogAlerted: false,
        failingTests: ['pkgA/foo.test.ts', 'pkgB/bar.test.ts'],
      },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('no GREEN verdict');
    expect(v.reason).toContain('Failing verdict test(s): pkgA/foo.test.ts, pkgB/bar.test.ts');
  });

  it('EI-7505: truncates the reason to the first 5 tests with a "+N more" tail', () => {
    const tests = Array.from({ length: 8 }, (_, i) => `pkg/file-${i}.test.ts`);
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false, failingTests: tests },
      NOW,
    );
    expect(v.reason).toContain('pkg/file-0.test.ts, pkg/file-1.test.ts, pkg/file-2.test.ts, pkg/file-3.test.ts, pkg/file-4.test.ts');
    expect(v.reason).toContain('(+3 more)');
  });

  it('EI-7505: no failing-test suffix when the list is absent/empty', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.reason).not.toContain('Failing verdict test(s)');
  });
});

describe('attributeVerdictStale — the alarm may not assert a cause it did not observe (WI-39704)', () => {
  /** oddsmith 2026-08-17: suite PASSED, run died in the publish step, no credential. */
  const ODDSMITH_CRASH = {
    crashed: true,
    green: null,
    firstLine:
      "green-checkpoint crashed before producing a normal verdict: Error: git -C /clones/oddsmith push origin 07220893:refs/heads/main exited 128: fatal: could not read Username for 'https://github.com': No such device or address",
    candidate: 'ad976f129ccb',
    observedAt: '2026-08-17T18:19:36.190Z',
  };

  it('THE REGRESSION: a crash with zero failing tests is never called a failing suite', () => {
    const a = attributeVerdictStale({ failingTests: [], last: ODDSMITH_CRASH });
    // The exact claim that cost WI-39671 a whole investigation, then re-minted as WI-39704.
    // Assert the AFFIRMATIVE form is absent — "(a failing suite)" is how the entitled
    // branch states it — while the explicit denial below is exactly what we DO want.
    expect(a.summary).not.toContain('(a failing suite)');
    expect(a.summary).toContain('NOT a failing suite');
    expect(a.cause).toContain('CRASHED before rendering a verdict');
    expect(a.cause).toContain('ZERO failing tests');
  });

  it('QUOTES the blocker verbatim rather than inferring from it', () => {
    const a = attributeVerdictStale({ failingTests: [], last: ODDSMITH_CRASH });
    expect(a.cause).toContain("could not read Username for 'https://github.com'");
    expect(a.cause).toContain('ad976f129ccb');
    expect(a.cause).toContain('2026-08-17T18:19:36.190Z');
  });

  it('the remedy does NOT tell the reader to re-fire the suite (~55min into the same wall)', () => {
    const a = attributeVerdictStale({ failingTests: [], last: ODDSMITH_CRASH });
    expect(a.remedy).toContain('Do NOT reflexively fire release:checkpoint-run');
    expect(a.remedy).toContain('PUBLISH step is blocked');
    // Points at the run's own promotion trailer, with the anchor WI-37636 requires
    // (a bare `GATE_PROMOTION.*` grep also matches vitest test names in the same log).
    expect(a.remedy).toContain("grep -o 'GATE_PROMOTION candidate=.*'");
  });

  it('named failing tests ARE a failing suite — the one branch entitled to say so', () => {
    const a = attributeVerdictStale({
      failingTests: ['a.test.ts', 'b.test.ts'],
      last: { crashed: false, green: false, firstLine: null, candidate: 'deadbeef1234', observedAt: null },
    });
    expect(a.summary).toContain('a failing suite');
    expect(a.cause).toContain('named 2 failing test(s)');
    expect(a.remedy).toContain('release:checkpoint-run');
  });

  it('named failing tests WIN over a crash record — the strongest evidence is reported', () => {
    const a = attributeVerdictStale({ failingTests: ['x.test.ts'], last: ODDSMITH_CRASH });
    expect(a.summary).toContain('a failing suite');
    expect(a.cause).not.toContain('CRASHED');
  });

  it('a RED verdict that named no test is reported as unattributable, not as a test list', () => {
    const a = attributeVerdictStale({
      failingTests: [],
      last: { crashed: false, green: false, firstLine: null, candidate: null, observedAt: null },
    });
    expect(a.cause).toContain('unattributable red');
    expect(a.remedy).toContain('AFFECTED_TESTS_FAILING_FILES');
    expect(a.remedy).toContain('not attributable');
  });

  it('no run on record states the GAP instead of filling it with a guess', () => {
    const a = attributeVerdictStale({ failingTests: [], last: null });
    expect(a.cause).toContain('cannot be attributed from the ledger');
    expect(a.summary).toContain('no run on record');
    // Never invents a failing suite out of an absent ledger.
    expect(a.cause).not.toContain('failing suite');
  });

  it('a green-but-uncounted verdict is named as such (held / superseded / not promoted)', () => {
    const a = attributeVerdictStale({
      failingTests: [],
      last: { crashed: false, green: true, firstLine: null, candidate: 'abc123abc123', observedAt: null },
    });
    expect(a.cause).toContain('green=true');
    expect(a.remedy).toContain('did not COUNT');
  });
});

describe('evaluateGreenStall — the verdictless limb: FIRING but recording nothing (P-006 / WI-41755)', () => {
  /** A gate mid-cadence: it fired 20 minutes ago, so `fireStale` is false. */
  const FIRING = NOW - 20 * 60 * 1000;

  it('THE 12h HOLE: greened recently, still firing, but no verdict in 5h ⇒ STALLED', () => {
    // Before this limb, BOTH other limbs read this as healthy:
    //   fireStale    — false, the routine is firing hourly on schedule.
    //   verdictStale — false, it greened only 2h ago (needs 12h).
    // …while every run since has been dying silently. That is the gap.
    const v = evaluateGreenStall(
      {
        lastFiredMs: FIRING,
        lastVerdictAtMs: NOW - 5 * H,
        lastGreenAt: NOW - 2 * H,
        watchdogAlerted: false,
      },
      NOW,
    );
    expect(v.fireStale).toBe(false);
    expect(v.verdictStale).toBe(false);
    expect(v.verdictless).toBe(true);
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('FIRING but has recorded NO verdict');
    expect(v.reason).toContain('NOT a failing suite');
  });

  it('a HEALTHY gate (verdict ~45min ago, the measured live cadence) never trips it', () => {
    const v = evaluateGreenStall(
      {
        lastFiredMs: FIRING,
        lastVerdictAtMs: NOW - 45 * 60 * 1000,
        lastGreenAt: NOW - 45 * 60 * 1000,
        watchdogAlerted: false,
      },
      NOW,
    );
    expect(v.verdictless).toBe(false);
    expect(v.stalled).toBe(false);
  });

  it('THE FALSE-POSITIVE GUARD: a gate producing honest REDS hourly is WORKING', () => {
    // Keyed on ANY verdict, never on greens — otherwise a legitimate red streak,
    // which is a gate doing its job, would read as a dead gate.
    const v = evaluateGreenStall(
      {
        lastFiredMs: FIRING,
        lastVerdictAtMs: NOW - 30 * 60 * 1000, // reds ARE verdicts
        lastGreenAt: NOW - 20 * H, // no GREEN in 20h
        watchdogAlerted: false,
      },
      NOW,
    );
    expect(v.verdictless).toBe(false);
    // The 12h no-green backstop still owns this case, unchanged.
    expect(v.verdictStale).toBe(true);
  });

  it('is mutually exclusive with fireStale — a routine that is NOT firing is that other bug', () => {
    const v = evaluateGreenStall(
      {
        lastFiredMs: NOW - 8 * H, // not firing at all
        lastVerdictAtMs: NOW - 9 * H,
        lastGreenAt: NOW - 9 * H,
        watchdogAlerted: false,
      },
      NOW,
    );
    expect(v.fireStale).toBe(true);
    expect(v.verdictless).toBe(false);
  });

  it('declines with no verdict ever recorded — a fresh install must not alarm', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: FIRING, lastVerdictAtMs: null, lastGreenAt: null, watchdogAlerted: false },
      NOW,
    );
    expect(v.verdictless).toBe(false);
  });

  it('omitting lastVerdictAtMs entirely preserves pre-P-006 behaviour', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: FIRING, lastGreenAt: NOW - 2 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.verdictless).toBe(false);
    expect(v.stalled).toBe(false);
  });

  it('a suppressed pass does not judge this limb either', () => {
    const v = evaluateGreenStall(
      {
        lastFiredMs: FIRING,
        lastVerdictAtMs: NOW - 5 * H,
        lastGreenAt: NOW - 2 * H,
        watchdogAlerted: false,
        routineEngineStale: true,
      },
      NOW,
    );
    expect(v.suppressed).toBe(true);
    expect(v.verdictless).toBe(false);
    // suppressed is NOT healthy — the file's own warning; assert we did not claim health.
    expect(v.stalled).toBe(false);
  });

  it('an in-flight delivering run is suppressed, not called dead', () => {
    const v = evaluateGreenStall(
      {
        lastFiredMs: FIRING,
        lastVerdictAtMs: NOW - 5 * H,
        lastGreenAt: NOW - 2 * H,
        watchdogAlerted: false,
        checkpointRunActive: true,
        checkpointRunPhase: 'delivering',
      },
      NOW,
    );
    expect(v.verdictless).toBe(false);
  });

  it('the threshold is configurable and its boundary is exclusive', () => {
    const at = evaluateGreenStall(
      { lastFiredMs: FIRING, lastVerdictAtMs: NOW - 1 * H, lastGreenAt: NOW, watchdogAlerted: false },
      NOW,
      { verdictlessMs: 1 * H },
    );
    expect(at.verdictless).toBe(false); // exactly at the deadline is still in flight
    const past = evaluateGreenStall(
      {
        lastFiredMs: FIRING,
        lastVerdictAtMs: NOW - 1 * H - 1,
        lastGreenAt: NOW,
        watchdogAlerted: false,
      },
      NOW,
      { verdictlessMs: 1 * H },
    );
    expect(past.verdictless).toBe(true);
  });
});

describe('verdict-less death — a fire that recorded NOTHING (P-006 / WI-41755)', () => {
  const T = Date.parse('2026-08-25T23:00:00.000Z');

  /** The 2026-08-17 oddsmith crash row, reused: a REAL recorded crash, but an OLD one. */
  const OLD_CRASH = {
    crashed: true,
    green: null,
    firstLine: 'green-checkpoint crashed before producing a normal verdict: Error: push exited 128',
    candidate: 'ad976f129ccb',
    observedAt: new Date(T - 6 * H).toISOString(),
  };

  /**
   * FALSIFIABILITY CONTROL, kept permanently (repo discipline: a guard that has never failed
   * is a guard you have not tested). This reproduces the PRE-FIX behaviour — attribute from
   * the newest row and never look at when the fire happened. Every assertion in THE INCIDENT
   * below must reject this, or those assertions are not measuring anything.
   */
  const staleBlindAttribution = (last: typeof OLD_CRASH) => ({
    summary: 'no green verdicts; deploys frozen.',
    cause: `The gate's last run (candidate ${last.candidate}) CRASHED before rendering a verdict.`,
    remedy: "Read that run's AFFECTED_TESTS_FAILING_FILES line.",
  });

  it('THE INCIDENT: a fire whose newest evidence PREDATES it is named a verdict-less death', () => {
    const a = attributeVerdictStale({
      failingTests: [],
      last: OLD_CRASH,
      lastFiredMs: T,
      now: T + 4 * H, // past the 3h grace
    });
    expect(a.cause).toContain('VERDICT-LESS DEATH');
    expect(a.cause).toContain('recorded NOTHING');
    expect(a.summary).toContain('NOT a failing suite');
    // The whole point: it must NOT retell the older run's crash as this run's cause.
    expect(a.cause).not.toContain('CRASHED before rendering');

    // The control fails exactly the assertion that matters, proving it discriminates.
    const blind = staleBlindAttribution(OLD_CRASH);
    expect(blind.cause).toContain('CRASHED before rendering');
    expect(blind.cause).not.toContain('VERDICT-LESS DEATH');
  });

  it('the remedy forbids chasing the stale run’s failing files', () => {
    const a = attributeVerdictStale({
      failingTests: [],
      last: OLD_CRASH,
      lastFiredMs: T,
      now: T + 4 * H,
    });
    expect(a.remedy).toContain('DIFFERENT, EARLIER run');
    expect(a.remedy).toContain('writeSelfWatchdogArmMarker');
    // The control points the responder at precisely the wrong artifact.
    expect(staleBlindAttribution(OLD_CRASH).remedy).toContain('AFFECTED_TESTS_FAILING_FILES');
  });

  it('STAYS SILENT inside the grace window — a slow run is not a dead one', () => {
    const a = attributeVerdictStale({
      failingTests: [],
      last: OLD_CRASH,
      lastFiredMs: T,
      now: T + 1 * H, // a full suite is ~55min; still legitimately in flight
    });
    expect(a.cause).not.toContain('VERDICT-LESS DEATH');
    expect(a.cause).toContain('CRASHED before rendering');
  });

  it('evidence NEWER than the fire is that fire’s own verdict, not a death', () => {
    const a = attributeVerdictStale({
      failingTests: [],
      last: { ...OLD_CRASH, observedAt: new Date(T + 30 * 60_000).toISOString() },
      lastFiredMs: T,
      now: T + 4 * H,
    });
    expect(a.cause).not.toContain('VERDICT-LESS DEATH');
  });

  it('no run on record at all, past the grace, IS a verdict-less death', () => {
    const a = attributeVerdictStale({ failingTests: [], last: null, lastFiredMs: T, now: T + 4 * H });
    expect(a.cause).toContain('VERDICT-LESS DEATH');
    expect(a.cause).toContain('no green-checkpoint run is on record');
  });

  it('named failing tests still WIN — they are independently sourced and actionable', () => {
    const a = attributeVerdictStale({
      failingTests: ['x.test.ts'],
      last: OLD_CRASH,
      lastFiredMs: T,
      now: T + 4 * H,
    });
    expect(a.summary).toContain('a failing suite');
    expect(a.cause).not.toContain('VERDICT-LESS DEATH');
  });

  it('OMITTING lastFiredMs preserves the pre-P-006 behaviour exactly', () => {
    const a = attributeVerdictStale({ failingTests: [], last: OLD_CRASH });
    expect(a.cause).toContain('CRASHED before rendering');
    expect(a.cause).not.toContain('VERDICT-LESS DEATH');
  });

  describe('judgeVerdictlessDeath declines to claim what it cannot prove', () => {
    it('never fired ⇒ nothing was owed', () => {
      expect(
        judgeVerdictlessDeath({ last: null, lastFiredMs: null, now: T }).verdictless,
      ).toBe(false);
    });

    it('undated evidence cannot be compared ⇒ stays silent', () => {
      expect(
        judgeVerdictlessDeath({
          last: { ...OLD_CRASH, observedAt: null },
          lastFiredMs: T,
          now: T + 4 * H,
        }).verdictless,
      ).toBe(false);
    });

    it('an unparseable timestamp is UNKNOWN, never a death', () => {
      expect(
        judgeVerdictlessDeath({
          last: { ...OLD_CRASH, observedAt: 'not-a-date' },
          lastFiredMs: T,
          now: T + 4 * H,
        }).verdictless,
      ).toBe(false);
    });

    it('reports HOW FAR the evidence predates the fire, for the alarm body', () => {
      const v = judgeVerdictlessDeath({ last: OLD_CRASH, lastFiredMs: T, now: T + 4 * H });
      expect(v.reason).toBe('evidence-predates-fire');
      expect(v.evidencePredatesFireByMs).toBe(6 * H);
    });

    it('the grace boundary is exclusive — exactly at the deadline is still in flight', () => {
      expect(
        judgeVerdictlessDeath({
          last: null,
          lastFiredMs: T,
          now: T + DEFAULT_VERDICTLESS_GRACE_MS,
        }).verdictless,
      ).toBe(false);
      expect(
        judgeVerdictlessDeath({
          last: null,
          lastFiredMs: T,
          now: T + DEFAULT_VERDICTLESS_GRACE_MS + 1,
        }).verdictless,
      ).toBe(true);
    });
  });
});

describe('readLastGateRunEvidence (WI-39704)', () => {
  function makeFakeSql(rows: unknown[]) {
    return ((_s: TemplateStringsArray, ..._v: unknown[]) =>
      Promise.resolve(rows)) as unknown as import('postgres').Sql;
  }

  it('reads crashed + the FIRST line of the crash summary (the fault, not the stack)', async () => {
    const sql = makeFakeSql([
      {
        detail: {
          crashed: true,
          green: null,
          candidate: 'ad976f129ccb',
          summary:
            "green-checkpoint crashed before producing a normal verdict: Error: git push origin exited 128: fatal: could not read Username\n    at ChildProcess.<anonymous> (/x/green-checkpoint.ts:10206:11)\n    at ChildProcess.emit (node:events:509:20)",
        },
        created_at: '2026-08-17T18:19:36.190Z',
      },
    ]);
    const ev = await readLastGateRunEvidence(sql, 'oddsmith');
    expect(ev?.crashed).toBe(true);
    expect(ev?.green).toBeNull();
    expect(ev?.candidate).toBe('ad976f129ccb');
    expect(ev?.firstLine).toContain('could not read Username');
    expect(ev?.firstLine).not.toContain('at ChildProcess');
    expect(ev?.observedAt).toBe('2026-08-17T18:19:36.190Z');
  });

  it('a non-crash red row reads green:false with no crash line', async () => {
    const sql = makeFakeSql([{ detail: { green: false, candidate: '7c6e395f021b' }, created_at: null }]);
    const ev = await readLastGateRunEvidence(sql, 'oddsmith');
    expect(ev).toEqual({
      crashed: false,
      green: false,
      firstLine: null,
      candidate: '7c6e395f021b',
      observedAt: null,
    });
  });

  it('no rows ⇒ null (an absent ledger is not evidence of anything)', async () => {
    expect(await readLastGateRunEvidence(makeFakeSql([]), 'oddsmith')).toBeNull();
  });

  it('fails soft (null, never throws) when the query rejects — it only ENRICHES a live alarm', async () => {
    const sql = (() => Promise.reject(new Error('db blew up'))) as unknown as import('postgres').Sql;
    await expect(readLastGateRunEvidence(sql, 'oddsmith')).resolves.toBeNull();
  });
});

describe('greenStallEscalationBody', () => {
  it('serializes the watchdog escalation with the stall axes + iso timestamps', () => {
    const verdict = evaluateGreenStall(
      { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 26 * H, watchdogAlerted: false },
      NOW,
    );
    const body = JSON.parse(
      greenStallEscalationBody({
        installSlug: 'papercusp',
        verdict,
        lastFiredMs: NOW - 4 * H,
        lastGreenAt: NOW - 26 * H,
        nowMs: NOW,
      }),
    );
    expect(body.kind).toBe('green-checkpoint-watchdog');
    expect(body.harness_slug).toBe('papercusp');
    expect(body.fireStale).toBe(true);
    expect(body.verdictStale).toBe(true);
    expect(body.lastFiredAt).toBe(new Date(NOW - 4 * H).toISOString());
    expect(body.detail).toContain('silent stall');
  });

  it('EI-7505: includes failingTests (truncated to 20) in the escalation body when present', () => {
    const failingTests = Array.from({ length: 25 }, (_, i) => `pkg/file-${i}.test.ts`);
    const verdict = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false, failingTests },
      NOW,
    );
    const body = JSON.parse(
      greenStallEscalationBody({
        installSlug: 'papercusp',
        verdict,
        lastFiredMs: NOW - 20 * 60 * 1000,
        lastGreenAt: NOW - 13 * H,
        nowMs: NOW,
        failingTests,
      }),
    );
    expect(body.failingTests).toHaveLength(20);
    expect(body.failingTests).toEqual(failingTests.slice(0, 20));
  });

  it('EI-7505: failingTests defaults to an empty array when omitted', () => {
    const verdict = evaluateGreenStall(
      { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 26 * H, watchdogAlerted: false },
      NOW,
    );
    const body = JSON.parse(
      greenStallEscalationBody({
        installSlug: 'papercusp',
        verdict,
        lastFiredMs: NOW - 4 * H,
        lastGreenAt: NOW - 26 * H,
        nowMs: NOW,
      }),
    );
    expect(body.failingTests).toEqual([]);
  });
});

describe('checkGreenStall checkpoint-run routing (EI-20378004056924553)', () => {
  const staleLastFiredMs = () => Date.now() - 4 * H;
  const recentLastGreenAt = () => Date.now() - 20 * 60 * 1000;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readRoutineEngineLivenessMock.mockResolvedValue({ stale: false });
    integrationRootMock.mockClear();
    resolveCheckpointRoutingMock.mockReset();
    isCheckpointRunLockHeldCheapMock.mockReset();
    readCheckpointRunPhaseCheapMock.mockReset();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    readRoutineEngineLivenessMock.mockReset();
    resolveCheckpointRoutingMock.mockReset();
    isCheckpointRunLockHeldCheapMock.mockReset();
    readCheckpointRunPhaseCheapMock.mockReset();
  });

  function makeFakeSql(row: {
    install_slug: string;
    workspace_id: string;
    last_fired_ms: number;
    gh: { lastGreenAt?: number; watchdogAlerted?: boolean; failingTests?: string[] };
  }) {
    const calls: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push([text, ...values]);
      if (text.includes('FROM harness_shared.routines')) return Promise.resolve([row]);
      return Promise.resolve(Object.assign([], { count: 1 }));
    }) as unknown as import('postgres').Sql;
    return { sql, calls };
  }

  it('routes lock and phase reads to the subject hive and suppresses active delivering salvage', async () => {
    resolveCheckpointRoutingMock.mockResolvedValue({
      root: '/DEFAULT',
      extraEnv: {
        PAPERCUSP_INTEGRATION_ROOT: '/hives/oddsmith',
        PAPERCUSP_CHECKPOINT_LOG_DIR: '/logs/oddsmith',
      },
      clearEnv: [],
    });
    isCheckpointRunLockHeldCheapMock.mockReturnValue({ held: true, pid: 1234, elapsedSec: 30 });
    readCheckpointRunPhaseCheapMock.mockReturnValue({ phase: 'delivering', at: new Date().toISOString() });
    const { sql, calls } = makeFakeSql({
      install_slug: 'oddsmith',
      workspace_id: 'papercusp-workspace',
      last_fired_ms: staleLastFiredMs(),
      gh: { lastGreenAt: Date.now() - 13 * H, watchdogAlerted: false },
    });

    await expect(checkGreenStall(sql)).resolves.toEqual({
      alarmed: [],
      recovered: [],
      suppressed: ['oddsmith'],
    });
    expect(resolveCheckpointRoutingMock).toHaveBeenCalledWith(
      { installSlug: 'oddsmith', workspaceId: 'papercusp-workspace' },
      '/DEFAULT',
    );
    expect(isCheckpointRunLockHeldCheapMock).toHaveBeenCalledWith(
      '/hives/oddsmith',
      undefined,
      undefined,
      undefined,
      '/logs/oddsmith',
    );
    expect(readCheckpointRunPhaseCheapMock).toHaveBeenCalledWith('/hives/oddsmith', '/logs/oddsmith');
    // NARROWED, not weakened (EI-21297913810967409). The property this protects is that a
    // SUPPRESSED pass writes no watchdog STATE — it must not flip `gate_health.watchdogAlerted`.
    // Every pass now also reports its own liveness to `metadata.watchdog_health` from a
    // `finally`, so that a watchdog which CANNOT RUN stops being indistinguishable from one that
    // ran and found nothing. That write is a different subject: it is keyed by pass name, it
    // matches zero rows in the healthy steady state, and it deliberately does not touch
    // `updated_at` (which is the release-trigger freeze signal). It carries a `watchdog-health`
    // marker comment precisely so this assertion can exclude one known statement rather than
    // relax to a whole category.
    const routineWrites = calls.map((call) => String(call[0])).filter((t) => t.includes('UPDATE harness_shared.routines'));
    expect(routineWrites.filter((t) => !t.includes('watchdog-health'))).toEqual([]);
    // ...and state the original intent positively, so this cannot pass by accident later.
    expect(routineWrites.some((t) => t.includes('gate_health'))).toBe(false);
  });

  it('fails open when the routed lock is not live even if a stale phase says delivering', async () => {
    resolveCheckpointRoutingMock.mockResolvedValue({
      root: '/DEFAULT',
      extraEnv: {
        PAPERCUSP_INTEGRATION_ROOT: '/hives/oddsmith',
        PAPERCUSP_CHECKPOINT_LOG_DIR: '/logs/oddsmith',
      },
      clearEnv: [],
    });
    isCheckpointRunLockHeldCheapMock.mockReturnValue({ held: false, elapsedSec: null });
    readCheckpointRunPhaseCheapMock.mockReturnValue({ phase: 'delivering' });
    const { sql } = makeFakeSql({
      install_slug: 'oddsmith',
      workspace_id: 'papercusp-workspace',
      last_fired_ms: staleLastFiredMs(),
      gh: { lastGreenAt: recentLastGreenAt(), watchdogAlerted: false },
    });

    await expect(checkGreenStall(sql)).resolves.toEqual({
      alarmed: ['oddsmith'],
      recovered: [],
      suppressed: [],
    });
  });

  it('fails open when routing is unknown instead of hiding a real stall', async () => {
    resolveCheckpointRoutingMock.mockRejectedValue(new Error('registry unavailable'));
    const { sql } = makeFakeSql({
      install_slug: 'oddsmith',
      workspace_id: 'papercusp-workspace',
      last_fired_ms: staleLastFiredMs(),
      gh: { lastGreenAt: recentLastGreenAt(), watchdogAlerted: false },
    });

    await expect(checkGreenStall(sql)).resolves.toEqual({
      alarmed: ['oddsmith'],
      recovered: [],
      suppressed: [],
    });
  });
});

describe('readCheckpointRunState routing eligibility', () => {
  it('does not count an expected non-gated route skip as a degraded eligible read', async () => {
    const observeFallback = vi.fn((_mechanism: string, _decision: unknown) => true);
    const readLock = vi.fn();
    const readPhase = vi.fn();

    await expect(readCheckpointRunState('no-gate', 'coverage', {
      route: async () => ({ root: '/DEFAULT', extraEnv: {}, clearEnv: [], skip: { reason: 'gate_disabled' } }),
      observeFallback,
      readLock,
      readPhase,
    })).resolves.toEqual({});

    expect(observeFallback).not.toHaveBeenCalled();
    expect(readLock).not.toHaveBeenCalled();
    expect(readPhase).not.toHaveBeenCalled();
  });

  it('keeps a misconfigured gated route visible with a specific degradation reason', async () => {
    const observeFallback = vi.fn((_mechanism: string, _decision: unknown) => true);

    await expect(readCheckpointRunState('bad-gate', 'coverage', {
      route: async () => ({
        root: '/DEFAULT',
        extraEnv: {},
        clearEnv: [],
        skip: { reason: 'integration-equals-release', misconfigured: true },
      }),
      observeFallback,
    })).resolves.toEqual({});

    expect(observeFallback).toHaveBeenCalledWith(
      'release-state-read',
      expect.objectContaining({
        eligible: 1,
        applied: 0,
        reason: 'routing-misconfigured',
        scope: 'coverage:bad-gate:checkpoint-run-state',
      }),
      { workspaceId: 'coverage' },
    );
  });
});

describe('evaluatePausedGreenCheckpoint (EI-21190903677660085)', () => {
  const overdue = {
    active: false,
    groupSlug: 'release',
    targetRole: 'system:green-checkpoint',
    nextFireMs: NOW - H,
    pauseRecorded: true,
    pauseReason: 'until the release writer regression is verified',
    pausedBy: 'su-dead-owner',
    pausedAtMs: NOW - 2 * H,
  } as const;

  it('alarms only when a release green-checkpoint pause is past next_fire_at', () => {
    const v = evaluatePausedGreenCheckpoint(overdue, NOW);
    expect(v.overdue).toBe(true);
    expect(v.reason).toContain('PAUSED');
    expect(v.reason).toContain('until the release writer regression is verified');
    expect(v.reason).toContain('su-dead-owner');
    expect(v.reason).toContain(new Date(NOW - H).toISOString());
  });

  it.each([
    ['active routine', { ...overdue, active: true }],
    ['non-release group', { ...overdue, groupSlug: 'other' }],
    ['non-green target', { ...overdue, targetRole: 'system:release-trigger' }],
    ['not overdue', { ...overdue, nextFireMs: NOW }],
    ['no pause record', { ...overdue, pauseRecorded: false, pauseReason: null, pausedBy: null, pausedAtMs: null }],
  ])('%s is not an overdue paused gate', (_label, snapshot) => {
    expect(evaluatePausedGreenCheckpoint(snapshot, NOW)).toEqual({ overdue: false, reason: null });
  });

  it('suppresses the overdue alarm only for the exact live D-012/D-016 serializer shape', () => {
    const liveSerializerEvidence = {
      pauseReason: 'D-012/D-013 live quiescence hold under WI-40086: deliberate quiescence hold',
      serializerItemId: 'WI-40086',
      serializerClaimHold: true,
      serializerOwner: 'su-c58f545d-f8a4-4afe-b755-1bf613bd8083',
      serializerHoldReason: 'D-016 sole serializer hold: observe the acceptance gate',
      serializerOwnerLive: true,
    } as const;
    expect(
      evaluatePausedGreenCheckpoint(
        {
          ...overdue,
          ...liveSerializerEvidence,
        },
        NOW,
      ),
    ).toEqual({ overdue: false, reason: null });
  });

  it('auto-recovery is limited to an overdue structured serializer hold whose owner is non-live', () => {
    const structured = {
      ...overdue,
      pauseReason: 'D-012/D-013 live quiescence hold under WI-40086: deliberate quiescence hold',
      serializerItemId: 'WI-40086',
      serializerClaimHold: true,
      serializerOwner: 'su-dead-owner',
      serializerHoldReason: 'D-016 sole serializer hold: observe the acceptance gate',
      serializerOwnerLive: false,
    } as const;
    expect(decidePausedGreenCheckpointRecovery(structured, NOW)).toEqual({
      action: 'rearm',
      reason: 'serializer-owner-non-live',
      itemId: 'WI-40086',
      ownerId: 'su-dead-owner',
      holdReason: 'D-016 sole serializer hold: observe the acceptance gate',
    });
    expect(
      decidePausedGreenCheckpointRecovery({ ...structured, serializerOwnerLive: true }, NOW),
    ).toEqual({ action: 'none', reason: 'not-overdue' });
    expect(decidePausedGreenCheckpointRecovery(overdue, NOW)).toEqual({
      action: 'none',
      reason: 'not-structured-serializer-hold',
    });
  });

  it.each([
    [
      'pause marker names no item',
      {
        ...overdue,
        pauseReason: 'D-012/D-013 quiescence hold: WI-40086',
        serializerItemId: 'WI-40086',
        serializerClaimHold: true,
        serializerOwner: 'su-c58f545d-f8a4-4afe-b755-1bf613bd8083',
        serializerHoldReason: 'D-016 sole serializer hold: observe the acceptance gate',
        serializerOwnerLive: true,
      },
    ],
    [
      'serializer item does not match the pause marker',
      {
        ...overdue,
        pauseReason: 'D-012/D-013 live quiescence hold under WI-40086: deliberate quiescence hold',
        serializerItemId: 'WI-40087',
        serializerClaimHold: true,
        serializerOwner: 'su-c58f545d-f8a4-4afe-b755-1bf613bd8083',
        serializerHoldReason: 'D-016 sole serializer hold: observe the acceptance gate',
        serializerOwnerLive: true,
      },
    ],
    [
      'claim hold is absent',
      {
        ...overdue,
        pauseReason: 'D-012/D-013 live quiescence hold under WI-40086: deliberate quiescence hold',
        serializerItemId: 'WI-40086',
        serializerClaimHold: false,
        serializerOwner: 'su-c58f545d-f8a4-4afe-b755-1bf613bd8083',
        serializerHoldReason: 'D-016 sole serializer hold: observe the acceptance gate',
        serializerOwnerLive: true,
      },
    ],
    [
      'serializer reason is not D-016',
      {
        ...overdue,
        pauseReason: 'D-012/D-013 live quiescence hold under WI-40086: deliberate quiescence hold',
        serializerItemId: 'WI-40086',
        serializerClaimHold: true,
        serializerOwner: 'su-c58f545d-f8a4-4afe-b755-1bf613bd8083',
        serializerHoldReason: 'manual hold',
        serializerOwnerLive: true,
      },
    ],
    [
      'owner liveness is stale/unknown',
      {
        ...overdue,
        pauseReason: 'D-012/D-013 live quiescence hold under WI-40086: deliberate quiescence hold',
        serializerItemId: 'WI-40086',
        serializerClaimHold: true,
        serializerOwner: 'su-c58f545d-f8a4-4afe-b755-1bf613bd8083',
        serializerHoldReason: 'D-016 sole serializer hold: observe the acceptance gate',
        serializerOwnerLive: false,
      },
    ],
  ])('%s fails open to the overdue alarm', (_label, snapshot) => {
    expect(
      evaluatePausedGreenCheckpoint(
        {
          ...snapshot,
        },
        NOW,
      ).overdue,
    ).toBe(true);
  });

  it('serializes the pause owner, pause time, next fire, and reason in the durable body', () => {
    const verdict = evaluatePausedGreenCheckpoint(overdue, NOW);
    const body = JSON.parse(
      greenCheckpointPausedEscalationBody({
        installSlug: 'papercusp',
        verdict,
        pauseReason: overdue.pauseReason,
        pausedBy: overdue.pausedBy,
        pausedAtMs: overdue.pausedAtMs,
        nextFireMs: overdue.nextFireMs,
        nowMs: NOW,
      }),
    );
    expect(body.kind).toBe('green-checkpoint-paused-watchdog');
    expect(body.pauseReason).toBe(overdue.pauseReason);
    expect(body.pausedBy).toBe(overdue.pausedBy);
    expect(body.pausedAt).toBe(new Date(overdue.pausedAtMs).toISOString());
    expect(body.nextFireAt).toBe(new Date(overdue.nextFireMs).toISOString());
    expect(body.detail).toContain('paused-release watchdog');
  });
});

describe('checkGreenStall paused release green-checkpoint watchdog (EI-21190903677660085)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    readRoutineEngineLivenessMock.mockResolvedValue({ stale: false });
    resolveCheckpointRoutingMock.mockResolvedValue({ skip: true });
    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    broadcastSevereEventResolvedMock.mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    dateNowSpy.mockRestore();
    readRoutineEngineLivenessMock.mockReset();
    resolveCheckpointRoutingMock.mockReset();
    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    broadcastSevereEventResolvedMock.mockClear();
  });

  function makeFakeSql(opts: {
    pausedRows: Array<Record<string, unknown>>;
    activeRows?: Array<Record<string, unknown>>;
    existingPaused?: Array<{ escalation: unknown }>;
    rearmSucceeded?: boolean;
  }) {
    const calls: unknown[][] = [];
    const activeRows = opts.activeRows ?? [];
    const existingPaused = opts.existingPaused ?? [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push([text, ...values]);
      if (text.includes("metadata->'pause' AS pause")) return Promise.resolve(opts.pausedRows);
      if (text.includes('FROM harness_shared.routines')) return Promise.resolve(activeRows);
      if (
        text.includes('FROM harness_shared.harness_escalations') &&
        values.includes('green-checkpoint-paused-watchdog')
      ) {
        return Promise.resolve(existingPaused);
      }
      if (text.includes('UPDATE harness_shared.harness_escalations')) {
        return Promise.resolve(Object.assign([], { count: 1 }));
      }
      if (text.includes('UPDATE harness_shared.routines')) {
        return Promise.resolve(
          opts.rearmSucceeded
            ? [{ install_slug: 'papercusp' }]
            : Object.assign([], { count: 0 }),
        );
      }
      return Promise.resolve(Object.assign([], { count: 0 }));
    }) as unknown as import('postgres').Sql;
    return { sql, calls };
  }

  const overdueRow = {
    install_slug: 'papercusp',
    workspace_id: 'papercusp-workspace',
    active: false,
    group_slug: 'release',
    target_role: 'system:green-checkpoint',
    next_fire_ms: NOW - H,
    pause: {
      reason: 'until EI-40422 is terminal',
      pausedBy: 'su-dead-owner',
      pausedAtMs: NOW - 2 * H,
    },
  };

  const liveSerializerOverdueRow = {
    ...overdueRow,
    pause: {
      ...overdueRow.pause,
      reason: 'D-012/D-013 live quiescence hold under WI-40086: deliberate quiescence hold',
    },
    serializer_item_id: 'WI-40086',
    serializer_claim_hold: true,
    serializer_owner: 'su-c58f545d-f8a4-4afe-b755-1bf613bd8083',
    serializer_hold_reason: 'D-016 sole serializer hold: observe the acceptance gate',
    serializer_owner_live: true,
  };

  it('alarms once and writes the independent durable paused-watchdog row', async () => {
    const { sql, calls } = makeFakeSql({ pausedRows: [overdueRow] });
    const result = await checkGreenStall(sql);

    expect(result).toEqual({ alarmed: ['papercusp'], recovered: [], suppressed: [] });
    expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ conditionKey: 'green-checkpoint-paused:papercusp', oneShot: true }),
    );
    const insert = calls.find(
      (call) =>
        String(call[0]).includes('INSERT INTO harness_shared.harness_escalations') &&
        call.includes('green-checkpoint-paused-watchdog'),
    );
    expect(insert).toBeDefined();
    expect(insert![2]).toBe('green-checkpoint-paused-watchdog');
    const body = JSON.parse(String(insert![3]));
    expect(body.pauseReason).toBe('until EI-40422 is terminal');
    expect(body.pausedBy).toBe('su-dead-owner');
    expect(body.nextFireAt).toBe(new Date(NOW - H).toISOString());
  });

  it('does not re-alarm while the paused-watchdog escalation is already present', async () => {
    const { sql, calls } = makeFakeSql({
      pausedRows: [overdueRow],
      existingPaused: [{ escalation: { kind: 'green-checkpoint-paused-watchdog' } }],
    });
    const result = await checkGreenStall(sql);

    expect(result).toEqual({ alarmed: [], recovered: [], suppressed: [] });
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(broadcastSevereEventMock).not.toHaveBeenCalled();
    expect(calls.some((call) => String(call[0]).includes('INSERT INTO harness_shared.harness_escalations'))).toBe(false);
  });

  it('clears the paused alarm when the routine resumes', async () => {
    const { sql } = makeFakeSql({
      pausedRows: [{ ...overdueRow, active: true }],
      existingPaused: [{ escalation: { kind: 'green-checkpoint-paused-watchdog' } }],
    });
    const result = await checkGreenStall(sql);

    expect(result).toEqual({ alarmed: [], recovered: ['papercusp'], suppressed: [] });
    expect(broadcastSevereEventResolvedMock).toHaveBeenCalledWith(
      expect.objectContaining({ conditionKey: 'green-checkpoint-paused:papercusp' }),
    );
  });

  it('does not alarm when the DB read finds the exact live serializer/quiescence exception', async () => {
    const { sql, calls } = makeFakeSql({ pausedRows: [liveSerializerOverdueRow] });
    const result = await checkGreenStall(sql);

    expect(result).toEqual({ alarmed: [], recovered: [], suppressed: [] });
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(broadcastSevereEventMock).not.toHaveBeenCalled();
    expect(calls.some((call) => String(call[0]).includes('harness_shared.work_items'))).toBe(true);
    expect(calls.some((call) => String(call[0]).includes('harness_shared.coord_presence'))).toBe(true);
  });

  it('atomically re-arms a structured stranded serializer pause without inventing a verdict', async () => {
    const stranded = {
      ...liveSerializerOverdueRow,
      serializer_owner: 'su-dead-owner',
      serializer_owner_live: false,
    };
    const { sql, calls } = makeFakeSql({ pausedRows: [stranded], rearmSucceeded: true });
    const result = await checkGreenStall(sql);

    expect(result).toEqual({ alarmed: ['papercusp'], recovered: [], suppressed: [] });
    const rearm = calls.find((call) => String(call[0]).includes('UPDATE harness_shared.routines'));
    expect(rearm).toBeDefined();
    expect(String(rearm![0])).toContain('active = true');
    expect(String(rearm![0])).toContain('next_fire_at = now()');
    expect(String(rearm![0])).toContain('NOT EXISTS');
    const lastPause = calls
      .flat()
      .filter((value): value is string => typeof value === 'string')
      .map((value) => {
        try {
          return JSON.parse(value) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((value) => value?.autoRecoveredBy === 'green-stall-watchdog');
    expect(lastPause).toMatchObject({
      autoRecoveredAtMs: NOW,
      autoRecoveredBy: 'green-stall-watchdog',
      autoRecoveryReason: 'serializer-owner-non-live',
    });

    const insert = calls.find(
      (call) =>
        String(call[0]).includes('INSERT INTO harness_shared.harness_escalations') &&
        call.includes('green-checkpoint-paused-watchdog'),
    );
    const body = JSON.parse(String(insert![3]));
    expect(body.verdict).toBeNull();
    expect(body.autoRecovery).toMatchObject({
      state: 'rearmed',
      itemId: 'WI-40086',
      ownerId: 'su-dead-owner',
      reason: 'serializer-owner-non-live',
    });
    expect(body.detail).toContain('fresh verdict is pending');
    expect(notifyAttentionMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('RECOVERING') }),
    );
  });
});

describe('green-checkpoint-stall recovery parser + decision', () => {
  it('parses JSON and normalizes the bounded recovery fields without losing the raw evidence', () => {
    const raw = {
      kind: 'green-checkpoint-stall',
      harness_slug: ' oddsmith ',
      candidate: '  abcdef1234567890  ',
      failingTests: [' pkg/a.test.ts ', '', 42, 'pkg/b.test.ts'],
      checkpointEvidence: {
        logPath: ' /var/lib/papercusp/checkpoint-logs/oddsmith-run.log ',
        runId: ' run-oddsmith-1 ',
        integrationRoot: ' /srv/oddsmith ',
      },
      ownership: { covered: false },
      recovery: {
        attempts: '2',
        lastAttemptAt: String(NOW - H),
        outcome: 'no-progress',
        notifiedAt: null,
      },
      detail: 'preserve this',
    };

    expect(parseGreenCheckpointStallEscalation(JSON.stringify(raw))).toEqual({
      raw: expect.objectContaining({ detail: 'preserve this' }),
      installSlug: 'oddsmith',
      candidate: 'abcdef1234567890',
      failingTests: ['pkg/a.test.ts', 'pkg/b.test.ts'],
      checkpointEvidence: {
        logPath: '/var/lib/papercusp/checkpoint-logs/oddsmith-run.log',
        runId: 'run-oddsmith-1',
        integrationRoot: '/srv/oddsmith',
      },
      ownershipCovered: false,
      recovery: {
        attempts: 2,
        lastAttemptAt: NOW - H,
        outcome: 'no-progress',
        notifiedAt: null,
      },
    });
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['wrong kind', JSON.stringify({ kind: 'green-checkpoint-watchdog' })],
    ['array input', JSON.stringify([])],
  ])('rejects %s rather than treating it as an uncovered red', (_label, raw) => {
    expect(parseGreenCheckpointStallEscalation(raw)).toBeNull();
  });

  it('keeps missing checkpoint evidence explicitly absent instead of selecting a global fallback log', () => {
    const parsed = parseGreenCheckpointStallEscalation({
      kind: 'green-checkpoint-stall',
      harness_slug: 'oddsmith',
      candidate: 'abcdef1234567890',
      failingTests: ['pkg/a.test.ts'],
      ownership: { covered: false },
    });

    expect(parsed?.checkpointEvidence).toBeNull();
  });

  it('dispatches only a stale, uncovered, actionable row and bounds retries/notification', () => {
    const valid = {
      mtimeMs: NOW - 4 * H,
      nowMs: NOW,
      ownershipCovered: false,
      candidate: 'abcdef1234567890',
      failingTests: ['pkg/a.test.ts'],
      staleMs: H,
      maxAttempts: 3,
    } as const;

    expect(decideGreenCheckpointStallRecovery({ ...valid, mtimeMs: NOW - 30 * 60 * 1000 })).toEqual({
      action: 'none',
      reason: 'not-stale',
      nextAttempt: 0,
    });
    expect(decideGreenCheckpointStallRecovery({ ...valid, ownershipCovered: true })).toEqual({
      action: 'none',
      reason: 'covered',
      nextAttempt: 0,
    });
    expect(decideGreenCheckpointStallRecovery({ ...valid, candidate: null })).toEqual({
      action: 'none',
      reason: 'invalid',
      nextAttempt: 0,
    });
    expect(decideGreenCheckpointStallRecovery(valid)).toEqual({
      action: 'dispatch',
      reason: 'retry',
      nextAttempt: 1,
    });
    expect(decideGreenCheckpointStallRecovery({ ...valid, recoveryAttempts: 3 })).toEqual({
      action: 'notify',
      reason: 'max-attempts',
      nextAttempt: 3,
    });
    expect(
      decideGreenCheckpointStallRecovery({ ...valid, recoveryAttempts: 3, recoveryNotifiedAt: NOW - H }),
    ).toEqual({
      action: 'none',
      reason: 'max-attempts',
      nextAttempt: 3,
    });
  });
});

describe('checkGreenStall stale green-checkpoint-stall recovery', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    readRoutineEngineLivenessMock.mockResolvedValue({ stale: false });
    dispatchReleaseFixerMock.mockReset();
    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    resolveCheckpointRoutingMock.mockReset();
    isCheckpointRunLockHeldCheapMock.mockReset();
    readCheckpointRunPhaseCheapMock.mockReset();
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
    warnSpy.mockRestore();
    readRoutineEngineLivenessMock.mockReset();
    dispatchReleaseFixerMock.mockReset();
    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    resolveCheckpointRoutingMock.mockReset();
    isCheckpointRunLockHeldCheapMock.mockReset();
    readCheckpointRunPhaseCheapMock.mockReset();
  });

  function makeRecoveryFakeSql(escalations: unknown[]) {
    const calls: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push([text, ...values]);
      if (text.includes('FROM harness_shared.routines')) return Promise.resolve([]);
      if (text.includes('FROM harness_shared.harness_escalations')) return Promise.resolve(escalations);
      return Promise.resolve(Object.assign([], { count: 1 }));
    }) as unknown as import('postgres').Sql;
    return { sql, calls };
  }

  function recoveryRow(overrides: Record<string, unknown> = {}) {
    return {
      harness_slug: 'oddsmith',
      workspace_id: 'papercusp-workspace',
      mtime_ms: NOW - 4 * H,
      escalation: {
        kind: 'green-checkpoint-stall',
        harness_slug: 'oddsmith',
        candidate: 'abcdef1234567890',
        failingTests: ['pkg/a.test.ts'],
        checkpointEvidence: {
          logPath: '/var/lib/papercusp/checkpoint-logs/oddsmith-run.log',
          runId: 'run-oddsmith-1',
          integrationRoot: '/srv/oddsmith',
        },
        ownership: { covered: false },
        ...overrides,
      },
    };
  }

  function recoveryUpdates(calls: unknown[][]) {
    return calls.filter((call) => String(call[0]).includes('SET escalation ='));
  }

  it('dispatches a stale uncovered escalation with the repair-queue slot empty and preserves evidence', async () => {
    dispatchReleaseFixerMock.mockResolvedValue({ spawnId: 'spawn-1', runId: 'run-1' });
    const { sql, calls } = makeRecoveryFakeSql([recoveryRow()]);

    await expect(
      checkGreenStall(sql, {
        greenCheckpointStallRecoveryStaleMs: H,
        greenCheckpointStallRecoveryMaxAttempts: 3,
      }),
    ).resolves.toEqual({ alarmed: [], recovered: [], suppressed: [] });

    expect(dispatchReleaseFixerMock).toHaveBeenCalledWith(
      { installSlug: 'oddsmith', workspaceId: 'papercusp-workspace' },
      'abcdef1234567890',
      ['pkg/a.test.ts'],
    );
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(broadcastSevereEventMock).not.toHaveBeenCalled();

    const updates = recoveryUpdates(calls);
    expect(updates).toHaveLength(2); // conditional claim, then dispatch result
    const dispatchedEscalation = JSON.parse(String(updates[1]![1]));
    expect(dispatchedEscalation.checkpointEvidence).toEqual({
      logPath: '/var/lib/papercusp/checkpoint-logs/oddsmith-run.log',
      runId: 'run-oddsmith-1',
      integrationRoot: '/srv/oddsmith',
    });
    expect(dispatchedEscalation.recovery).toMatchObject({
      attempts: 1,
      outcome: 'dispatched',
      notifiedAt: null,
    });
  });

  it('marks a no-progress dispatch and bounds recovery notifications to 20 data tests / 5 body tests', async () => {
    const failingTests = Array.from({ length: 25 }, (_, i) => `pkg/test-${i}.test.ts`);
    dispatchReleaseFixerMock.mockResolvedValue(null);
    const { sql, calls } = makeRecoveryFakeSql([
      recoveryRow({ candidate: 'abcdef1234567890', failingTests }),
    ]);

    await checkGreenStall(sql, { greenCheckpointStallRecoveryStaleMs: H, greenCheckpointStallRecoveryMaxAttempts: 3 });

    expect(dispatchReleaseFixerMock).toHaveBeenCalledTimes(1);
    expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
    const notice = notifyAttentionMock.mock.calls[0]![0] as {
      body: string;
      data: {
        candidate: string;
        failingTests: string[];
        checkpointEvidence: CheckpointEvidence;
        attempts: number;
        reason: string;
      };
    };
    expect(notice.data.candidate).toBe('abcdef123456');
    expect(notice.data.failingTests).toEqual(failingTests.slice(0, 20));
    expect(notice.body).toContain(failingTests.slice(0, 5).join(', '));
    expect(notice.body).not.toContain(failingTests[5]!);
    expect(notice.data.attempts).toBe(1);
    expect(notice.data.reason).toBe('no-progress');
    expect(notice.data.checkpointEvidence).toEqual({
      logPath: '/var/lib/papercusp/checkpoint-logs/oddsmith-run.log',
      runId: 'run-oddsmith-1',
      integrationRoot: '/srv/oddsmith',
    });
    expect(notice.body).toContain('Exact checkpoint log: /var/lib/papercusp/checkpoint-logs/oddsmith-run.log');
    expect(broadcastSevereEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conditionKey: 'green-checkpoint-stall-recovery:oddsmith',
        oneShot: true,
      }),
    );

    const updates = recoveryUpdates(calls);
    expect(updates).toHaveLength(3); // claim, no-progress result, notification latch
    expect(JSON.parse(String(updates[2]![1])).recovery).toMatchObject({
      attempts: 1,
      outcome: 'no-progress',
      notifiedAt: NOW,
    });
  });

  it('notifies once at the retry cap and skips dispatch when the cap marker is already latched', async () => {
    dispatchReleaseFixerMock.mockResolvedValue({ spawnId: 'should-not-fire', runId: null });
    const first = makeRecoveryFakeSql([
      recoveryRow({
        recovery: { attempts: 3, lastAttemptAt: NOW - H, outcome: 'no-progress', notifiedAt: null },
      }),
    ]);

    await checkGreenStall(first.sql, {
      greenCheckpointStallRecoveryStaleMs: H,
      greenCheckpointStallRecoveryMaxAttempts: 3,
    });

    expect(dispatchReleaseFixerMock).not.toHaveBeenCalled();
    expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventMock).toHaveBeenCalledTimes(1);
    const marked = JSON.parse(String(recoveryUpdates(first.calls)[0]![1]));
    expect(marked.recovery).toMatchObject({ attempts: 3, outcome: 'max-attempts', notifiedAt: NOW });

    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    const second = makeRecoveryFakeSql([recoveryRow({ recovery: marked.recovery })]);
    await checkGreenStall(second.sql, {
      greenCheckpointStallRecoveryStaleMs: H,
      greenCheckpointStallRecoveryMaxAttempts: 3,
    });

    expect(dispatchReleaseFixerMock).not.toHaveBeenCalled();
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(broadcastSevereEventMock).not.toHaveBeenCalled();
    expect(recoveryUpdates(second.calls)).toHaveLength(0);
  });
});

describe('evaluateMainBehindStaging (EI-9762)', () => {
  it('does not alarm when main and staging are in sync (commitsBehind 0)', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 0, behindMs: null });
    expect(v.stalled).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('does not alarm on a small/fresh lag (a handful of commits just landed)', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 5, behindMs: 5 * 60 * 1000 });
    expect(v.stalled).toBe(false);
  });

  it('does not alarm on a small lag even if it sits for a while (low commit count alone is not the signal)', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 3, behindMs: 5 * H });
    expect(v.stalled).toBe(false);
  });

  it('does not alarm on a big burst that has not aged yet (lots of commits, all fresh)', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 40, behindMs: 2 * 60 * 1000 });
    expect(v.stalled).toBe(false);
  });

  it('ALARMS on the EI-9762 signature: many commits AND aged well past the threshold', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 56, behindMs: Math.round(4.8 * H) });
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('56 commits');
    expect(v.reason).toContain('4.8h');
  });

  it('respects custom thresholds', () => {
    const v = evaluateMainBehindStaging(
      { commitsBehind: 10, behindMs: 30 * 60 * 1000 },
      { commitsThreshold: 5, msThreshold: 15 * 60 * 1000 },
    );
    expect(v.stalled).toBe(true);
  });

  it('fails open (never alarms) when the git read could not resolve a value', () => {
    expect(evaluateMainBehindStaging({ commitsBehind: null, behindMs: null }).stalled).toBe(false);
    expect(evaluateMainBehindStaging({ commitsBehind: 56, behindMs: null }).stalled).toBe(false);
  });
});

describe('evaluateMainBehindStaging gate-advance suppression (EI-10202)', () => {
  const MIN = 60 * 1000;

  it('THE FALSE ALARM: a deep+old backlog is NOT a stall when the gate greened within the last ~2 cycles', () => {
    // The 2026-07-12 incident: main fell "39/45 commits behind, >1h" while the
    // green-checkpoint routine was HEALTHY and advancing main every ~15-20 min.
    // The oldest un-promoted commit is >1h old (behindMs), yet the gate greened
    // ~35m ago — churn, not a wedge. Must NOT alarm.
    const v = evaluateMainBehindStaging({ commitsBehind: 45, behindMs: 70 * MIN, lastGreenAgeMs: 35 * MIN });
    expect(v.stalled).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('PRESERVES EI-9762: a deep+old backlog WITH no green advance in a long time is still a stall', () => {
    // Persistent-red / killed-runs: main 56 commits / ~4.8h behind AND the gate
    // has not produced a green advance in ~4.8h. This is the genuine wedge — alarm.
    const v = evaluateMainBehindStaging({
      commitsBehind: 56,
      behindMs: Math.round(4.8 * H),
      lastGreenAgeMs: Math.round(4.8 * H),
    });
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('56 commits');
    // The reason now names the no-advance signal so it can't be mistaken for a depth-only cry.
    expect(v.reason).toContain('no green-checkpoint advance in ~4.8h');
  });

  it('an UNKNOWN gate signal (lastGreenAgeMs null) falls back to depth+age — never silently suppresses a possible stall', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 30, behindMs: 2 * H, lastGreenAgeMs: null });
    expect(v.stalled).toBe(true);
    // No advance-age clause when the signal is unknown.
    expect(v.reason).not.toContain('no green-checkpoint advance');
  });

  it('boundary: a green advance exactly at the recent-green window does NOT suppress (strict <=)', () => {
    // lastGreenAgeMs === recentGreenMs is treated as "recently advanced" (<=), so it suppresses.
    const atWindow = evaluateMainBehindStaging({ commitsBehind: 30, behindMs: 3 * H, lastGreenAgeMs: 2 * H });
    expect(atWindow.stalled).toBe(false);
    // Just past the window ⇒ genuinely stale ⇒ alarms.
    const pastWindow = evaluateMainBehindStaging({ commitsBehind: 30, behindMs: 3 * H, lastGreenAgeMs: 2 * H + 1 });
    expect(pastWindow.stalled).toBe(true);
  });

  it('honors a custom recentGreenMs', () => {
    // Tighten the window to 30m: a 45m-old green advance is now "stale" ⇒ alarms.
    const v = evaluateMainBehindStaging(
      { commitsBehind: 30, behindMs: 2 * H, lastGreenAgeMs: 45 * MIN },
      { recentGreenMs: 30 * MIN },
    );
    expect(v.stalled).toBe(true);
  });

  it('a recent green advance does not rescue a still-small backlog into an alarm (depth+age still required)', () => {
    // Suppression only ever REMOVES an alarm; it never manufactures one. A tiny
    // lag with a stale green is still healthy (depth/age not met).
    const v = evaluateMainBehindStaging({ commitsBehind: 3, behindMs: 5 * H, lastGreenAgeMs: 9 * H });
    expect(v.stalled).toBe(false);
  });
});

describe('evaluateMainBehindStaging: motion is not progress (WI-38340)', () => {
  const MIN = 60 * 1000;

  // THE INCIDENT, to scale. 2026-08-12T22:27Z: the partial-green salvage (WI-38218)
  // advanced main 8779b1c7 → e16f9529 — the longest green PREFIX, 3 commits — while
  // the tip stayed red and `main` sat 327 commits behind `staging`. That advance
  // reset `lastGreenAt`, EI-10202's `recentlyAdvanced` flipped true, `stalled` went
  // false, and the fleet was broadcast an all-clear.
  const salvage = { commitsBehind: 327, behindMs: 30 * H, lastGreenAgeMs: 4 * MIN };

  it('THE BUG: a fresh PREFIX advance against a deep old backlog no longer suppresses the alarm', () => {
    const v = evaluateMainBehindStaging(salvage);
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('327 commits');
  });

  it('the alarm does not misstate its own trigger — it says the gate DID advance, not that it stopped', () => {
    // An alarm claiming "no green-checkpoint advance in ~0.1h" about a gate that
    // just advanced sends the reader hunting a wedge that is not there.
    const reason = evaluateMainBehindStaging(salvage).reason ?? '';
    expect(reason).toContain('the gate DID advance main');
    expect(reason).toContain('advanced the tip end, not this backlog');
    expect(reason).not.toContain('no green-checkpoint advance');
  });

  it('RE-ARMING: repeated prefix advances cannot silence it forever — each pass still alarms', () => {
    // The compounding half of the bug: the suppression re-arms on EVERY partial
    // advance, so a persistently-red tip that keeps salvaging small green prefixes
    // would reset `lastGreenAgeMs` each cycle and the alarm would never fire again.
    for (const sinceAdvanceMin of [1, 20, 60, 119]) {
      const v = evaluateMainBehindStaging({ ...salvage, lastGreenAgeMs: sinceAdvanceMin * MIN });
      expect(v.stalled, `${sinceAdvanceMin}m after a prefix advance`).toBe(true);
    }
  });

  it('PRESERVES EI-10202: a real advance that DID consume the backlog still suppresses', () => {
    // The distinction is measured, not asserted. After a genuine full advance the
    // oldest un-promoted commit is young — `behindMs` collapses to about the
    // candidate's own age and then grows one-for-one with elapsed time. Here the
    // gate greened 35m ago and the oldest un-promoted commit is 70m old: consistent
    // with real consumption. Still churn, still no alarm.
    const v = evaluateMainBehindStaging({ commitsBehind: 45, behindMs: 70 * MIN, lastGreenAgeMs: 35 * MIN });
    expect(v.stalled).toBe(false);
  });

  it('the boundary is behindMs vs (lastGreenAgeMs + advanceHorizonMs), not depth', () => {
    // Depth is deliberately NOT the discriminator: a deep backlog being actively
    // consumed is healthy, and a shallow one that is stuck is not this alarm's job.
    const consuming = { commitsBehind: 500, behindMs: 2 * H, lastGreenAgeMs: 10 * MIN };
    expect(evaluateMainBehindStaging(consuming).stalled).toBe(false); // 2h <= 10m + 2h
    const stuck = { ...consuming, behindMs: 2 * H + 11 * MIN }; // just past 10m + 2h
    expect(evaluateMainBehindStaging(stuck).stalled).toBe(true);
  });

  it('honors a custom advanceHorizonMs', () => {
    const s = { commitsBehind: 40, behindMs: 90 * MIN, lastGreenAgeMs: 10 * MIN };
    expect(evaluateMainBehindStaging(s).stalled).toBe(false); // 90m <= 10m + 2h
    expect(evaluateMainBehindStaging(s, { advanceHorizonMs: 30 * MIN }).stalled).toBe(true); // 90m > 10m + 30m
  });

  it('an UNKNOWN advance signal still falls back to depth+age — never silently suppresses', () => {
    // Unchanged contract: the new condition can only ever REMOVE a suppression, so
    // a null gate signal behaves exactly as before.
    const v = evaluateMainBehindStaging({ commitsBehind: 30, behindMs: 2 * H, lastGreenAgeMs: null });
    expect(v.stalled).toBe(true);
  });

  it('still never manufactures an alarm: a shallow backlog stays quiet however unproductive the advance', () => {
    const v = evaluateMainBehindStaging({ commitsBehind: 3, behindMs: 30 * H, lastGreenAgeMs: 1 * MIN });
    expect(v.stalled).toBe(false);
  });
});

describe('mainBehindRecoverySummary — an all-clear may not claim what it did not measure (WI-38340)', () => {
  it('THE BROADCAST THAT WAS WRONG: still-deep behind is NOT reported as "recovered"', () => {
    // Verbatim shape of the 2026-08-12T23:03Z broadcast: `main RECOVERED on
    // papercusp — no longer meaningfully behind staging`, sent at 327 behind.
    const s = mainBehindRecoverySummary('papercusp', { commitsBehind: 327 });
    expect(s).toContain('STILL 327 commits behind');
    expect(s).not.toContain('RECOVERED');
    expect(s).not.toContain('no longer meaningfully behind');
  });

  it('a genuine catch-up IS reported as recovered, and states the number it measured', () => {
    const s = mainBehindRecoverySummary('papercusp', { commitsBehind: 4 });
    expect(s).toContain('RECOVERED');
    expect(s).toContain('4 commits behind');
  });

  it('the threshold is the boundary between the two arms, and is configurable', () => {
    expect(mainBehindRecoverySummary('h', { commitsBehind: 20 })).toContain('RECOVERED');
    expect(mainBehindRecoverySummary('h', { commitsBehind: 21 })).toContain('STILL 21 commits');
    expect(mainBehindRecoverySummary('h', { commitsBehind: 21 }, { commitsThreshold: 50 })).toContain('RECOVERED');
  });

  it('an UNMEASURABLE distance is its own arm — never dressed up as a recovery', () => {
    // A missing branch / git error clears the alarm because the signal went
    // unreadable, which is not evidence main caught up.
    const s = mainBehindRecoverySummary('papercusp', { commitsBehind: null });
    expect(s).toContain('could NOT be measured');
    expect(s).not.toContain('RECOVERED');
  });

  it('every arm names the harness', () => {
    for (const commitsBehind of [4, 327, null]) {
      expect(mainBehindRecoverySummary('oddsmith', { commitsBehind })).toContain('oddsmith');
    }
  });
});

describe('evaluateMainBehindStaging in-flight-aware remedy (EI-19459452257836856)', () => {
  // THE DEFECT: this alarm is broadcast hive-wide as a severe-event, and its remedy
  // used to end with an UNCONDITIONAL "Fire a fresh gate run (release:checkpoint-run)"
  // — the one action the repo guide flags in bold as never-do-while-a-run-is-live
  // (firing inside a run's re-triage window discards an in-progress rescue and costs
  // a full ~55min suite). On 2026-08-03 an agent did exactly that during a stall and
  // conceded it was premature. The remedy must now branch on whether a run is live.
  //
  // BOTH ARMS ARE ASSERTED ON PURPOSE. A single-arm test is always-true here: the
  // fire-phrase is either present or absent in one fixed string, so asserting only
  // "the live-run arm omits it" passes just as happily against a function that never
  // emits it at all — which would silently destroy the real remedy.
  const FIRE = 'Fire a fresh gate run (release:checkpoint-run)';
  const deep = { commitsBehind: 56, behindMs: Math.round(4.8 * H), lastGreenAgeMs: Math.round(4.8 * H) };

  it('THE BUG: a run IS in flight ⇒ the remedy must NOT tell the hive to fire another', () => {
    const v = evaluateMainBehindStaging({ ...deep, runInFlight: true, runInFlightElapsedSec: 1980 });
    expect(v.stalled).toBe(true);
    expect(v.reason).not.toContain(FIRE);
    expect(v.reason).toContain('IN FLIGHT');
    expect(v.reason).toContain('do NOT launch another');
    // Says WHY, so the reader can't mistake it for timidity, and names the wait lever.
    expect(v.reason).toContain('re-triage');
    expect(v.reason).toContain('checkpoint:await');
    // Elapsed is rendered in minutes when known (1980s ⇒ ~33m).
    expect(v.reason).toContain('~33m ago');
  });

  it('THE OTHER ARM: no run in flight ⇒ the fire remedy IS still emitted (not neutered)', () => {
    const v = evaluateMainBehindStaging({ ...deep, runInFlight: false });
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain(FIRE);
  });

  it('UNKNOWN in-flight state is its OWN arm — neither the blind instruction nor silence', () => {
    // Treating unknown as "no run" is exactly the original bug; treating it as "a run
    // is live" would suppress the remedy on a genuine stall. So: alarm, and make the
    // check the first step.
    const v = evaluateMainBehindStaging(deep); // field omitted entirely
    expect(v.stalled).toBe(true);
    expect(v.reason).not.toContain(FIRE);
    expect(v.reason).toContain('CHECK FIRST');
    expect(v.reason).toContain('gate.checkpointRunInFlight');
    // An explicit null is the same unknown, not a `false`.
    expect(evaluateMainBehindStaging({ ...deep, runInFlight: null }).reason).toContain('CHECK FIRST');
  });

  it('the three arms are genuinely DISTINCT strings (a future refactor must not collapse them)', () => {
    const live = evaluateMainBehindStaging({ ...deep, runInFlight: true }).reason;
    const none = evaluateMainBehindStaging({ ...deep, runInFlight: false }).reason;
    const unknown = evaluateMainBehindStaging(deep).reason;
    expect(new Set([live, none, unknown]).size).toBe(3);
  });

  it('the in-flight signal gates the REMEDY ONLY — it must never suppress the alarm itself', () => {
    // A run being in flight does not mean the gate is healthy: it may be the 12th
    // consecutive red. Suppressing on it would hide a real wedge. Gate-is-advancing
    // suppression is lastGreenAgeMs's job (EI-10202), not this field's.
    for (const runInFlight of [true, false, null, undefined]) {
      expect(evaluateMainBehindStaging({ ...deep, runInFlight }).stalled).toBe(true);
    }
    // ...and it must not manufacture one either: a healthy shallow lag stays quiet
    // no matter what the run-lock says.
    for (const runInFlight of [true, false, null, undefined]) {
      expect(evaluateMainBehindStaging({ commitsBehind: 3, behindMs: 5 * H, runInFlight }).stalled).toBe(false);
    }
  });

  it('the field is OPTIONAL — existing snapshot literals that omit it still evaluate', () => {
    // The required-field-strand trap: every other call site in this file builds the
    // snapshot as an object literal with only the fields it needs. Making the new
    // field required would strand all of them at once.
    expect(evaluateMainBehindStaging({ commitsBehind: 56, behindMs: Math.round(4.8 * H) }).stalled).toBe(true);
  });

  it('omits the elapsed clause when the run age is not measurable', () => {
    const v = evaluateMainBehindStaging({ ...deep, runInFlight: true, runInFlightElapsedSec: null });
    expect(v.reason).toContain('IN FLIGHT');
    expect(v.reason).not.toContain('ago');
  });

  it('every arm points at the authoritative break-set line, not the old undirected "find whatever is failing"', () => {
    // The agent who mis-fired during the 2026-08-03 stall verified ONE red and never
    // the failing SET. The break set has an authoritative source; name it.
    for (const runInFlight of [true, false, undefined]) {
      const r = evaluateMainBehindStaging({ ...deep, runInFlight }).reason;
      expect(r).toContain('AFFECTED_TESTS_FAILING_FILES');
      expect(r).toContain('coverage');
      expect(r).not.toContain('find + fix whatever is actually failing');
    }
  });
});

describe('computeMainBehindStaging git shell-out (EI-9922 no-stderr-leak)', () => {
  // On a PACKAGED install this watchdog's boot pass shells git in a NON-repo dir.
  // `execFile` captures child output by default; gitOut consumes stdout and discards stderr.
  it('EI-9922: shells git asynchronously using captured output and keeps the fail-soft behavior', async () => {
    mockGitStdout('0\n');
    await expect(computeMainBehindStaging('/some/packaged/install')).resolves.toEqual({
      commitsBehind: 0,
      behindMs: null,
    });
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/some/packaged/install', 'rev-list', '--count', 'main..staging'],
      { encoding: 'utf8' },
      expect.any(Function),
    );
  });

  it('uses the configured release and integration refs by default', async () => {
    const oldReleaseRef = process.env.PAPERCUSP_RELEASE_REF;
    const oldIntegrationBranch = process.env.PAPERCUSP_INTEGRATION_BRANCH;
    process.env.PAPERCUSP_RELEASE_REF = 'release-candidate';
    process.env.PAPERCUSP_INTEGRATION_BRANCH = 'workstream';
    childProcessMocks.execFile.mockClear();
    mockGitStdout('2\n', '1792280000\n');
    try {
      await computeMainBehindStaging('/fake/repo');
      expect(execFile).toHaveBeenNthCalledWith(
        1,
        'git',
        ['-C', '/fake/repo', 'rev-list', '--count', 'release-candidate..workstream'],
        { encoding: 'utf8' },
        expect.any(Function),
      );
      expect(execFile).toHaveBeenNthCalledWith(
        2,
        'git',
        ['-C', '/fake/repo', 'log', 'release-candidate..workstream', '--format=%ct', '--reverse'],
        { encoding: 'utf8' },
        expect.any(Function),
      );
    } finally {
      if (oldReleaseRef === undefined) delete process.env.PAPERCUSP_RELEASE_REF;
      else process.env.PAPERCUSP_RELEASE_REF = oldReleaseRef;
      if (oldIntegrationBranch === undefined) delete process.env.PAPERCUSP_INTEGRATION_BRANCH;
      else process.env.PAPERCUSP_INTEGRATION_BRANCH = oldIntegrationBranch;
    }
  });

  it('EI-9922: fails open (all-null) without throwing when async git rejects (non-repo)', async () => {
    childProcessMocks.execFile.mockImplementationOnce(
      (_command: string, _args: string[], _options: object, callback: (error: Error) => void) => {
        callback(new Error('fatal: not a git repository (or any parent up to mount point /)'));
      },
    );
    await expect(computeMainBehindStaging('/some/packaged/install')).resolves.toEqual({
      commitsBehind: null,
      behindMs: null,
    });
  });
});

// EI-10103: main-behind-staging-watchdog crashes every pass — the escalation INSERT
// explicitly wrote `workspace_id: NULL` (opts.workspaceId ?? null), violating the
// column's NOT NULL constraint on every real stall (the promotion-stall detector
// could never actually escalate). A tagged-template fake `sql` records every call so
// we can assert on the exact value threaded into the INSERT.
function makeFakeSql(existingRows: { escalation: unknown }[] = []) {
  const calls: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push([text, ...values]);
    if (text.includes('SELECT escalation')) return Promise.resolve(existingRows);
    // INSERT / UPDATE — postgres-js resolves a write to a result-like array with `.count`.
    return Promise.resolve(Object.assign([], { count: 1 }));
  }) as unknown as import('postgres').Sql;
  return { sql, calls };
}

function findInsertCall(calls: unknown[][]) {
  return calls.find((c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO harness_shared.harness_escalations'));
}

describe('checkMainBehindStaging DB wiring (EI-10103: workspace_id NOT NULL)', () => {
  // This path legitimately console.warn's on a real ALARM (and on a caught resolution
  // failure) — expected, vitest-fail-on-console guarded behavior, not noise to silence
  // elsewhere. Spy + restore locally so it doesn't mask unrelated warnings in other suites.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resolveWorkspaceForHarnessMock.mockReset();
    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    broadcastSevereEventResolvedMock.mockClear();
    childProcessMocks.execFile.mockReset();
    warnSpy.mockRestore();
  });

  // Force a stalled verdict deterministically: commitsBehind (30) > DEFAULT_MAIN_BEHIND_COMMITS (20)
  // AND behindMs (2h) > DEFAULT_MAIN_BEHIND_MS (1h). opts.root is passed explicitly so
  // computeMainBehindStaging's two git calls (rev-list --count, then log --format=%ct --reverse)
  // are the only ones made.
  function mockStalledGit() {
    mockGitStdout('30\n', `${Math.floor((Date.now() - 2 * H) / 1000)}\n`);
  }

  it('threads a resolved, non-null workspace_id into the escalation insert (previously always NULL)', async () => {
    resolveWorkspaceForHarnessMock.mockResolvedValueOnce('papercusp-workspace');
    mockStalledGit();
    const { sql, calls } = makeFakeSql([]);
    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    expect(resolveWorkspaceForHarnessMock).toHaveBeenCalledWith('papercusp');
    const insertCall = findInsertCall(calls);
    expect(insertCall).toBeDefined();
    // template values are [harnessSlug, phase, escalationJson, mtimeMs, workspaceId]
    expect(insertCall![5]).toBe('papercusp-workspace');
    expect(insertCall![5]).not.toBeNull();
  });

  it('falls back to the column default ("") instead of NULL when workspace resolution fails — the escalation write must never be blocked', async () => {
    resolveWorkspaceForHarnessMock.mockRejectedValueOnce(new Error('harness not registered in any workspace'));
    mockStalledGit();
    const { sql, calls } = makeFakeSql([]);
    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });
    // The whole point of the fix: a resolution failure must not re-create the original
    // "the escalation never gets written" bug via a different code path.
    expect(result.alarmed).toBe(true);
    const insertCall = findInsertCall(calls);
    expect(insertCall).toBeDefined();
    expect(insertCall![5]).toBe('');
    expect(insertCall![5]).not.toBeNull();
  });

  it('honors an explicit opts.workspaceId verbatim, skipping resolution entirely', async () => {
    mockStalledGit();
    const { sql, calls } = makeFakeSql([]);
    await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp', workspaceId: 'explicit-ws' });
    expect(resolveWorkspaceForHarnessMock).not.toHaveBeenCalled();
    const insertCall = findInsertCall(calls);
    expect(insertCall![5]).toBe('explicit-ws');
  });

  it('labels an active protected checkpoint run as active progress, not a stalled promotion', async () => {
    resolveWorkspaceForHarnessMock.mockResolvedValueOnce('papercusp-workspace');
    isCheckpointRunLockHeldCheapMock.mockReturnValueOnce({ held: true, elapsedSec: 1980 });
    mockStalledGit();
    const { sql } = makeFakeSql([]);

    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });

    expect(result.alarmed).toBe(true);
    expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
    const notice = notifyAttentionMock.mock.calls[0]![0] as { title: string; body: string };
    expect(notice.title).toContain('ACTIVE');
    expect(notice.title).not.toContain('STALLED');
    expect(notice.body).toContain('IN FLIGHT');

    expect(broadcastSevereEventMock).toHaveBeenCalledTimes(1);
    const event = broadcastSevereEventMock.mock.calls[0]![0] as { summary: string; body: string };
    expect(event.summary).toContain('checkpoint run is active');
    expect(event.summary).not.toContain('promotion pipeline stalled');
    expect(event.body).toContain('do NOT launch another');
  });

  it('does not insert at all when nothing is stalled (no regression to the happy path)', async () => {
    // in-sync (0 commits behind) — evaluateMainBehindStaging never alarms.
    mockGitStdout('0\n');
    const { sql, calls } = makeFakeSql([]);
    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(findInsertCall(calls)).toBeUndefined();
    expect(resolveWorkspaceForHarnessMock).not.toHaveBeenCalled();
  });
});

describe('checkMainBehindStaging gate-advance suppression wiring (EI-10202)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resolveWorkspaceForHarnessMock.mockReset();
    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    childProcessMocks.execFile.mockReset();
    warnSpy.mockRestore();
  });

  // git: 30 commits / 2h behind (over both DEFAULT thresholds) — the same stalled
  // git snapshot the EI-10103 suite uses.
  function mockStalledGit() {
    mockGitStdout('30\n', `${Math.floor((Date.now() - 2 * H) / 1000)}\n`);
  }

  /** A fake sql that ALSO answers the gate_health lastGreenAt read this path now
   *  issues (a recent value ⇒ the gate is advancing ⇒ suppress). */
  function makeGateFakeSql(lastGreenAtMs: number | null) {
    const calls: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push([text, ...values]);
      if (text.includes("gate_health'->>'lastGreenAt")) {
        return Promise.resolve(lastGreenAtMs != null ? [{ last_green_at: lastGreenAtMs }] : []);
      }
      if (text.includes('SELECT escalation')) return Promise.resolve([]);
      return Promise.resolve(Object.assign([], { count: 1 }));
    }) as unknown as import('postgres').Sql;
    return { sql, calls };
  }

  function findInsert(calls: unknown[][]) {
    return calls.find((c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO harness_shared.harness_escalations'));
  }

  it('SUPPRESSES the alarm when the gate greened recently, even with a deep+old git backlog', async () => {
    mockStalledGit();
    const { sql, calls } = makeGateFakeSql(Date.now() - 20 * 60 * 1000); // greened 20m ago
    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(findInsert(calls)).toBeUndefined();
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(broadcastSevereEventMock).not.toHaveBeenCalled();
    // It DID consult the gate-advance signal (the whole point of the fix).
    expect(calls.some((c) => typeof c[0] === 'string' && (c[0] as string).includes("gate_health'->>'lastGreenAt"))).toBe(true);
  });

  it('still ALARMS on a deep+old git backlog when the gate has NOT greened in a long time', async () => {
    resolveWorkspaceForHarnessMock.mockResolvedValueOnce('papercusp-workspace');
    mockStalledGit();
    const { sql, calls } = makeGateFakeSql(Date.now() - 5 * H); // last green 5h ago ⇒ stale
    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    expect(findInsert(calls)).toBeDefined();
  });

  it('still ALARMS when the gate signal is unreadable (no green-checkpoint row) — fail-open, never hide a real stall', async () => {
    resolveWorkspaceForHarnessMock.mockResolvedValueOnce('papercusp-workspace');
    mockStalledGit();
    const { sql, calls } = makeGateFakeSql(null); // no gate_health row
    const result = await checkMainBehindStaging(sql, { root: '/fake/repo', harnessSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    expect(findInsert(calls)).toBeDefined();
  });
});

describe('evaluateReleaseTriggerFreeze (WI-4322)', () => {
  it('a fresh/active routine never alarms, however much green code is stranded', () => {
    const v = evaluateReleaseTriggerFreeze({ active: true, activeChangedAtMs: NOW - 24 * H, deployedBehindGreenPin: 44 }, NOW);
    expect(v.frozen).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('no routine row (active: null — no deploy target declared) never alarms', () => {
    const v = evaluateReleaseTriggerFreeze({ active: null, activeChangedAtMs: null, deployedBehindGreenPin: 44 }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('paused but nothing green is stranded — harmless, never alarms', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, activeChangedAtMs: NOW - 2 * H, deployedBehindGreenPin: 0 }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('paused with null deployedBehindGreenPin never alarms (unknown ≠ pending)', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, activeChangedAtMs: NOW - 2 * H, deployedBehindGreenPin: null }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('paused + green stranded, but only just (< 30m threshold) — a normal short manual pause, not yet a freeze', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, activeChangedAtMs: NOW - 10 * 60_000, deployedBehindGreenPin: 44 }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('THE SIGNATURE: paused > 30m + green code stranded ⇒ frozen, with an actionable reason', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, activeChangedAtMs: NOW - 45 * 60_000, deployedBehindGreenPin: 44 }, NOW);
    expect(v.frozen).toBe(true);
    expect(v.reason).toContain('PAUSED');
    expect(v.reason).toContain('44 green commit');
    expect(v.reason).toContain("routines:set");
    expect(v.reason).toContain('release-trigger');
  });

  it('boundary: exactly at the threshold does not alarm (strict >)', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, activeChangedAtMs: NOW - 30 * 60_000, deployedBehindGreenPin: 5 }, NOW);
    expect(v.frozen).toBe(false);
  });

  it('an unresolvable updated_at (null) while paused + green-ahead is treated as maximally stale, not healthy', () => {
    const v = evaluateReleaseTriggerFreeze({ active: false, activeChangedAtMs: null, deployedBehindGreenPin: 3 }, NOW);
    expect(v.frozen).toBe(true);
    expect(v.reason).toContain('pause duration unknown');
  });

  it('kill switch: thresholdMs <= 0 never alarms', () => {
    const v = evaluateReleaseTriggerFreeze(
      { active: false, activeChangedAtMs: NOW - 99 * H, deployedBehindGreenPin: 44 },
      NOW,
      { thresholdMs: 0 },
    );
    expect(v.frozen).toBe(false);
  });

  it('honors a custom (tighter) threshold', () => {
    const v = evaluateReleaseTriggerFreeze(
      { active: false, activeChangedAtMs: NOW - 6 * 60_000, deployedBehindGreenPin: 1 },
      NOW,
      { thresholdMs: 5 * 60_000 },
    );
    expect(v.frozen).toBe(true);
  });
});

describe('lastReleaseTriggerPauseOwner (WI-4329)', () => {
  function makeFakeSql(row: { coord_owner_id: string | null; invoked_at_ms: number | null } | null) {
    return ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
      Promise.resolve(row ? [row] : [])) as unknown as import('postgres').Sql;
  }

  it('returns the owner + timestamp when a matching row exists', async () => {
    const sql = makeFakeSql({ coord_owner_id: 'su-d1425c47-dbac-4640-93c1-d708e3dcff03', invoked_at_ms: NOW });
    const result = await lastReleaseTriggerPauseOwner(sql);
    expect(result).toEqual({ ownerId: 'su-d1425c47-dbac-4640-93c1-d708e3dcff03', invokedAtMs: NOW });
  });

  it('returns null when no matching row exists', async () => {
    const sql = makeFakeSql(null);
    expect(await lastReleaseTriggerPauseOwner(sql)).toBeNull();
  });

  it('returns null when the row has no coord_owner_id (a non-agent/system caller)', async () => {
    const sql = makeFakeSql({ coord_owner_id: null, invoked_at_ms: NOW });
    expect(await lastReleaseTriggerPauseOwner(sql)).toBeNull();
  });

  it('fails soft (returns null, never throws) when the query rejects', async () => {
    const sql = (() => Promise.reject(new Error('db blew up'))) as unknown as import('postgres').Sql;
    await expect(lastReleaseTriggerPauseOwner(sql)).resolves.toBeNull();
  });
});

describe('checkReleaseTriggerFreeze DB wiring (WI-4322)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    broadcastSevereEventResolvedMock.mockClear();
    gitPipelineSnapshotMock.mockClear();
    computeDeployStatusMock.mockReset();
    warnSpy.mockRestore();
  });

  /** A fake sql tag that dispatches on query shape: the routines-row read, the
   *  escalation-dedup read, and everything else (INSERT/UPDATE) falls through
   *  to a write-ack — mirrors makeFakeSql's dispatch style but supports the
   *  extra routines-row SELECT this check issues first. */
  function makeRTFakeSql(opts: {
    routineRow?: { active: boolean; updated_at_ms: number | null; workspace_id: string } | null;
    existingEscalation?: { escalation: unknown }[];
    pauseOwnerRow?: { coord_owner_id: string | null; invoked_at_ms: number | null } | null;
  }) {
    const calls: unknown[][] = [];
    const routineRows = opts.routineRow ? [opts.routineRow] : [];
    const existing = opts.existingEscalation ?? [];
    const pauseOwnerRows = opts.pauseOwnerRow ? [opts.pauseOwnerRow] : [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push([text, ...values]);
      if (text.includes('FROM harness_shared.routines')) return Promise.resolve(routineRows);
      if (text.includes('SELECT escalation')) return Promise.resolve(existing);
      if (text.includes('FROM harness_shared.tool_invocations')) return Promise.resolve(pauseOwnerRows);
      return Promise.resolve(Object.assign([], { count: 1 }));
    }) as unknown as import('postgres').Sql;
    return { sql, calls };
  }

  function findRTInsertCall(calls: unknown[][]) {
    return calls.find((c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO harness_shared.harness_escalations'));
  }

  it('no routine row (no deploy target for this hive) is a complete no-op', async () => {
    const { sql, calls } = makeRTFakeSql({ routineRow: null });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(result.recovered).toBe(false);
    expect(gitPipelineSnapshotMock).not.toHaveBeenCalled();
    expect(findRTInsertCall(calls)).toBeUndefined();
  });

  it('ALARMS on the exact WI-4322 signature: active:false, stale updated_at, green ahead', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 44 } });
    const { sql, calls } = makeRTFakeSql({
      routineRow: { active: false, updated_at_ms: NOW - 45 * 60_000, workspace_id: 'papercusp-workspace' },
    });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    expect(gitPipelineSnapshotMock).toHaveBeenCalledWith('papercusp');
    expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventMock).toHaveBeenCalledTimes(1);
    const insertCall = findRTInsertCall(calls);
    expect(insertCall).toBeDefined();
    // template values are [installSlug, phase, escalationJson, mtimeMs, workspaceId]
    expect(insertCall![1]).toBe('papercusp');
    expect(insertCall![5]).toBe('papercusp-workspace');
  });

  it('WI-4329: attributes the pause to its actual owner when tool_invocations has a matching row', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 44 } });
    const { sql } = makeRTFakeSql({
      routineRow: { active: false, updated_at_ms: NOW - 45 * 60_000, workspace_id: 'papercusp-workspace' },
      pauseOwnerRow: { coord_owner_id: 'su-d1425c47-dbac-4640-93c1-d708e3dcff03', invoked_at_ms: NOW - 45 * 60_000 },
    });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    const notifyBody = notifyAttentionMock.mock.calls[0]![0].body as string;
    expect(notifyBody).toContain('su-d1425c47-dbac-4640-93c1-d708e3dcff03');
    expect(notifyBody).toContain('Coordinate with them');
    expect(notifyAttentionMock.mock.calls[0]![0].data.pausedBy).toBe('su-d1425c47-dbac-4640-93c1-d708e3dcff03');
    const broadcastBody = broadcastSevereEventMock.mock.calls[0]![0].body as string;
    expect(broadcastBody).toContain('su-d1425c47-dbac-4640-93c1-d708e3dcff03');
  });

  it('WI-4329: no matching tool_invocations row (attribution unavailable) still alarms, just without a "last paused by" line', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 44 } });
    const { sql } = makeRTFakeSql({
      routineRow: { active: false, updated_at_ms: NOW - 45 * 60_000, workspace_id: 'papercusp-workspace' },
      pauseOwnerRow: null,
    });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    const notifyBody = notifyAttentionMock.mock.calls[0]![0].body as string;
    expect(notifyBody).not.toContain('Coordinate with them');
    expect(notifyAttentionMock.mock.calls[0]![0].data.pausedBy).toBeNull();
  });

  it('does NOT re-alarm when already alarmed (one-shot until recovery)', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 44 } });
    const { sql, calls } = makeRTFakeSql({
      routineRow: { active: false, updated_at_ms: NOW - 45 * 60_000, workspace_id: 'papercusp-workspace' },
      existingEscalation: [{ escalation: { kind: 'release-trigger-freeze-watchdog' } }],
    });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(broadcastSevereEventMock).not.toHaveBeenCalled();
    expect(findRTInsertCall(calls)).toBeUndefined();
  });

  it('clears + broadcasts recovery once the routine is active again (or nothing is stranded)', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 0 } });
    const { sql } = makeRTFakeSql({
      routineRow: { active: true, updated_at_ms: NOW, workspace_id: 'papercusp-workspace' },
      existingEscalation: [{ escalation: { kind: 'release-trigger-freeze-watchdog' } }],
    });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.recovered).toBe(true);
    expect(broadcastSevereEventResolvedMock).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventResolvedMock).toHaveBeenCalledWith(
      expect.objectContaining({ conditionKey: 'release-trigger-freeze:papercusp' }),
    );
  });

  it('healthy + never-alarmed is a complete no-op (no writes, no broadcasts)', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 0 } });
    const { sql, calls } = makeRTFakeSql({
      routineRow: { active: false, updated_at_ms: NOW - 45 * 60_000, workspace_id: 'papercusp-workspace' },
    });
    const result = await checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(result.recovered).toBe(false);
    expect(findRTInsertCall(calls)).toBeUndefined();
    expect(broadcastSevereEventResolvedMock).not.toHaveBeenCalled();
  });

  it('a thrown gitPipelineSnapshot never propagates — fail-soft', async () => {
    gitPipelineSnapshotMock.mockRejectedValueOnce(new Error('git blew up'));
    const { sql } = makeRTFakeSql({
      routineRow: { active: false, updated_at_ms: NOW - 45 * 60_000, workspace_id: 'papercusp-workspace' },
    });
    await expect(checkReleaseTriggerFreeze(sql, { installSlug: 'papercusp' })).resolves.toEqual({
      alarmed: false,
      recovered: false,
    });
  });
});

describe('evaluateReleaseTriggerFireStale (EI-14003)', () => {
  it('active + firing within cadence never alarms, however much green code is stranded', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: NOW - 5 * 60_000, deployedBehindGreenPin: 44 }, NOW);
    expect(v.stale).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('no routine row (active: null) never alarms', () => {
    const v = evaluateReleaseTriggerFireStale({ active: null, lastFiredMs: null, deployedBehindGreenPin: 44 }, NOW);
    expect(v.stale).toBe(false);
  });

  it('PAUSED (active:false) never alarms here — checkReleaseTriggerFreeze owns that case', () => {
    const v = evaluateReleaseTriggerFireStale({ active: false, lastFiredMs: NOW - 3 * H, deployedBehindGreenPin: 44 }, NOW);
    expect(v.stale).toBe(false);
  });

  it('stale-fired but nothing green is stranded — harmless, never alarms', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: NOW - 3 * H, deployedBehindGreenPin: 0 }, NOW);
    expect(v.stale).toBe(false);
  });

  it('stale-fired with null deployedBehindGreenPin never alarms (unknown ≠ pending)', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: NOW - 3 * H, deployedBehindGreenPin: null }, NOW);
    expect(v.stale).toBe(false);
  });

  it('not fired long enough yet (< 30m threshold) — normal cadence jitter, not a stall', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: NOW - 20 * 60_000, deployedBehindGreenPin: 44 }, NOW);
    expect(v.stale).toBe(false);
  });

  it('THE EI-14003 SIGNATURE: active, not fired in 65m (the real repro gap), green stranded ⇒ stale', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: NOW - 65 * 60_000, deployedBehindGreenPin: 8 }, NOW);
    expect(v.stale).toBe(true);
    expect(v.reason).toContain('ACTIVE');
    expect(v.reason).toContain('not FIRED');
    expect(v.reason).toContain('8 green commit');
    expect(v.reason).toContain('release-trigger');
  });

  it('boundary: exactly at the threshold does not alarm (strict >)', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: NOW - 30 * 60_000, deployedBehindGreenPin: 5 }, NOW);
    expect(v.stale).toBe(false);
  });

  it('an unresolvable last_fired_at (null) while active + green-ahead is treated as maximally stale', () => {
    const v = evaluateReleaseTriggerFireStale({ active: true, lastFiredMs: null, deployedBehindGreenPin: 3 }, NOW);
    expect(v.stale).toBe(true);
    expect(v.reason).toContain('never fired');
  });

  it('kill switch: thresholdMs <= 0 never alarms', () => {
    const v = evaluateReleaseTriggerFireStale(
      { active: true, lastFiredMs: NOW - 99 * H, deployedBehindGreenPin: 44 },
      NOW,
      { thresholdMs: 0 },
    );
    expect(v.stale).toBe(false);
  });

  it('honors a custom (tighter) threshold', () => {
    const v = evaluateReleaseTriggerFireStale(
      { active: true, lastFiredMs: NOW - 6 * 60_000, deployedBehindGreenPin: 1 },
      NOW,
      { thresholdMs: 5 * 60_000 },
    );
    expect(v.stale).toBe(true);
  });
});

describe('checkReleaseTriggerFireStale DB wiring (EI-14003)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    notifyAttentionMock.mockClear();
    broadcastSevereEventMock.mockClear();
    broadcastSevereEventResolvedMock.mockClear();
    gitPipelineSnapshotMock.mockClear();
    computeDeployStatusMock.mockReset();
    warnSpy.mockRestore();
  });

  function makeFireStaleFakeSql(opts: {
    routineRow?: { active: boolean; last_fired_ms: number | null; workspace_id: string } | null;
    existingEscalation?: { escalation: unknown }[];
  }) {
    const calls: unknown[][] = [];
    const routineRows = opts.routineRow ? [opts.routineRow] : [];
    const existing = opts.existingEscalation ?? [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push([text, ...values]);
      if (text.includes('FROM harness_shared.routines')) return Promise.resolve(routineRows);
      if (text.includes('SELECT escalation')) return Promise.resolve(existing);
      return Promise.resolve(Object.assign([], { count: 1 }));
    }) as unknown as import('postgres').Sql;
    return { sql, calls };
  }

  function findFSInsertCall(calls: unknown[][]) {
    return calls.find((c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO harness_shared.harness_escalations'));
  }

  it('no routine row (no deploy target for this hive) is a complete no-op', async () => {
    const { sql, calls } = makeFireStaleFakeSql({ routineRow: null });
    const result = await checkReleaseTriggerFireStale(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(result.recovered).toBe(false);
    expect(gitPipelineSnapshotMock).not.toHaveBeenCalled();
    expect(findFSInsertCall(calls)).toBeUndefined();
  });

  it('ALARMS on the exact EI-14003 signature: active:true, stale last_fired_at, green ahead', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 8 } });
    const { sql, calls } = makeFireStaleFakeSql({
      routineRow: { active: true, last_fired_ms: NOW - 65 * 60_000, workspace_id: 'papercusp-workspace' },
    });
    const result = await checkReleaseTriggerFireStale(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(true);
    expect(gitPipelineSnapshotMock).toHaveBeenCalledWith('papercusp');
    expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventMock).toHaveBeenCalledTimes(1);
    const insertCall = findFSInsertCall(calls);
    expect(insertCall).toBeDefined();
    // template values are [installSlug, phase, escalationJson, mtimeMs, workspaceId]
    expect(insertCall![1]).toBe('papercusp');
    expect(insertCall![5]).toBe('papercusp-workspace');
  });

  it('does NOT re-alarm when already alarmed (one-shot until recovery)', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 8 } });
    const { sql, calls } = makeFireStaleFakeSql({
      routineRow: { active: true, last_fired_ms: NOW - 65 * 60_000, workspace_id: 'papercusp-workspace' },
      existingEscalation: [{ escalation: { kind: 'release-trigger-fire-stale-watchdog' } }],
    });
    const result = await checkReleaseTriggerFireStale(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(broadcastSevereEventMock).not.toHaveBeenCalled();
    expect(findFSInsertCall(calls)).toBeUndefined();
  });

  it('clears + broadcasts recovery once firing on cadence again (or nothing is stranded)', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 0 } });
    const { sql } = makeFireStaleFakeSql({
      routineRow: { active: true, last_fired_ms: NOW, workspace_id: 'papercusp-workspace' },
      existingEscalation: [{ escalation: { kind: 'release-trigger-fire-stale-watchdog' } }],
    });
    const result = await checkReleaseTriggerFireStale(sql, { installSlug: 'papercusp' });
    expect(result.recovered).toBe(true);
    expect(broadcastSevereEventResolvedMock).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventResolvedMock).toHaveBeenCalledWith(
      expect.objectContaining({ conditionKey: 'release-trigger-fire-stale:papercusp' }),
    );
  });

  it('does NOT alarm when PAUSED (active:false) — that failure mode belongs to checkReleaseTriggerFreeze', async () => {
    computeDeployStatusMock.mockReturnValue({ deploy: { deployedBehindGreenPin: 44 } });
    const { sql } = makeFireStaleFakeSql({
      routineRow: { active: false, last_fired_ms: NOW - 3 * H, workspace_id: 'papercusp-workspace' },
    });
    const result = await checkReleaseTriggerFireStale(sql, { installSlug: 'papercusp' });
    expect(result.alarmed).toBe(false);
  });

  it('a thrown gitPipelineSnapshot never propagates — fail-soft', async () => {
    gitPipelineSnapshotMock.mockRejectedValueOnce(new Error('git blew up'));
    const { sql } = makeFireStaleFakeSql({
      routineRow: { active: true, last_fired_ms: NOW - 65 * 60_000, workspace_id: 'papercusp-workspace' },
    });
    await expect(checkReleaseTriggerFireStale(sql, { installSlug: 'papercusp' })).resolves.toEqual({
      alarmed: false,
      recovered: false,
    });
  });
});

describe('decideVerdictlessRefire — D-006: detection does not authorize actuation (P-006 / WI-41755)', () => {
  const base = { verdictless: true as const, nowMs: NOW, ownerWallActive: false };

  /**
   * PERMANENT FALSIFIABILITY CONTROL. The naive implementation this gate exists to prevent:
   * "verdict-less ⇒ fire it again". Kept in the file forever so the assertions below are
   * demonstrably capable of failing — a suite where the control and the real subject agree
   * is a suite proving nothing.
   */
  const naiveRefire = (verdictless: boolean) => (verdictless ? 'refire' : 'none');

  it('CALIBRATION: the real subject does re-fire the case it should, so the controls below are not passing merely because it always alarms', () => {
    const d = decideVerdictlessRefire({ ...base, abortStatus: 'cancelled' });
    expect(d.action).toBe('refire');
    expect(d.reason).toBe('transient-retry');
    expect(d.abortKind).toBe('transient');
    expect(d.nextAttempt).toBe(1);
  });

  it('CONTROL: on a standing-condition abort the naive implementation re-fires and the real one refuses', () => {
    const status = 'migrations-pending';
    expect(naiveRefire(true)).toBe('refire'); // what we must NOT do
    const d = decideVerdictlessRefire({ ...base, abortStatus: status });
    expect(d.action).toBe('alarm');
    expect(d.reason).toBe('not-transient');
  });

  it('the owner wall (D-080) makes `refire` structurally unreachable — for EVERY recorded status, transient included', () => {
    for (const status of [...RECORDED_INCONCLUSIVE_STATUSES, 'totally-unknown-status']) {
      const walled = decideVerdictlessRefire({
        ...base,
        ownerWallActive: true,
        abortStatus: status,
      });
      expect(walled.action).not.toBe('refire');
      expect(walled.reason).toBe('owner-wall');
    }
  });

  it('an UNSPECIFIED owner wall fails CLOSED — omitting the flag must not silently authorize firing', () => {
    const d = decideVerdictlessRefire({ verdictless: true, nowMs: NOW, abortStatus: 'cancelled' });
    expect(d.action).toBe('alarm');
    expect(d.reason).toBe('owner-wall');
  });

  it('classifies EVERY recorded abort status straight off the real table — never a restated copy', () => {
    for (const status of RECORDED_INCONCLUSIVE_STATUSES) {
      const kind = classifyGateAbort(status);
      const d = decideVerdictlessRefire({ ...base, abortStatus: status });
      expect(d.abortKind).toBe(kind);
      if (kind === 'transient') {
        expect(d.action).toBe('refire');
      } else {
        expect(d.action).toBe('alarm');
        expect(d.reason).toBe('not-transient');
      }
    }
  });

  it('an UNCLASSIFIABLE abort is not transient — an unknown cause is not evidence of a harmless one', () => {
    for (const status of [null, 'some-brand-new-status']) {
      const d = decideVerdictlessRefire({ ...base, abortStatus: status });
      expect(d.action).toBe('alarm');
      expect(d.reason).toBe('unclassifiable');
      expect(d.abortKind).toBe('unknown');
    }
  });

  it('a peer-owned abort alarms rather than contending with the owner mid-repair', () => {
    const d = decideVerdictlessRefire({ ...base, abortStatus: 'repair-in-progress' });
    expect(d.abortKind).toBe('peer-owned');
    expect(d.action).toBe('alarm');
  });

  describe('P-002: the verdict-rate alarm axis engages the same bounded recovery', () => {
    it('rate alarm ALONE (clock quiet) reaches refire on a transient abort, labelled verdict-rate', () => {
      const d = decideVerdictlessRefire({
        verdictless: false,
        rateAlarmed: true,
        nowMs: NOW,
        ownerWallActive: false,
        abortStatus: 'cancelled',
      });
      expect(d.action).toBe('refire');
      expect(d.reason).toBe('transient-retry');
      expect(d.axis).toBe('verdict-rate');
      expect(d.detail).toContain('verdict-rate alarm');
    });

    it('NEITHER axis ⇒ none/not-verdictless with a null axis', () => {
      const d = decideVerdictlessRefire({
        verdictless: false,
        rateAlarmed: false,
        nowMs: NOW,
        ownerWallActive: false,
        abortStatus: 'cancelled',
      });
      expect(d.action).toBe('none');
      expect(d.reason).toBe('not-verdictless');
      expect(d.axis).toBeNull();
    });

    it('BOTH axes ⇒ the clock wins the label', () => {
      const d = decideVerdictlessRefire({ ...base, rateAlarmed: true, abortStatus: 'cancelled' });
      expect(d.action).toBe('refire');
      expect(d.axis).toBe('verdictless-clock');
    });

    it('the owner wall governs the alarm axis identically — fail-closed when unspecified', () => {
      const d = decideVerdictlessRefire({
        verdictless: false,
        rateAlarmed: true,
        nowMs: NOW,
        abortStatus: 'cancelled',
      });
      expect(d.action).toBe('alarm');
      expect(d.reason).toBe('owner-wall');
      expect(d.axis).toBe('verdict-rate');
    });

    it('an UNCLASSIFIABLE abort on the alarm axis still alarms rather than re-firing', () => {
      const d = decideVerdictlessRefire({
        verdictless: false,
        rateAlarmed: true,
        nowMs: NOW,
        ownerWallActive: false,
        abortStatus: null,
      });
      expect(d.action).toBe('alarm');
      expect(d.reason).toBe('unclassifiable');
      expect(d.axis).toBe('verdict-rate');
    });
  });

  /**
   * The measured oddsmith case (2026-08-26): `error` classifies transient — correctly, it
   * latches nothing — yet that install had reproduced it 530 consecutive times. "Nothing to
   * clear" is not the same claim as "waiting fixes it", and only the second one justifies
   * spending a ~55min suite.
   */
  it('STOPS on the first repeat: a transient abort that already came back is reproducible, not self-clearing', () => {
    const d = decideVerdictlessRefire({
      ...base,
      abortStatus: 'error',
      attempts: 1,
      lastAttemptStatus: 'error',
    });
    expect(d.action).toBe('alarm');
    expect(d.reason).toBe('reproduced');
    // and it stops WELL inside the budget rather than burning it to re-learn the same fact
    expect(d.nextAttempt).toBe(1);
  });

  it('CONTROL for the repeat rule: a DIFFERENT transient abort still re-fires, so `reproduced` is not just "any second attempt"', () => {
    const d = decideVerdictlessRefire({
      ...base,
      abortStatus: 'error',
      attempts: 1,
      lastAttemptStatus: 'cancelled',
    });
    expect(d.action).toBe('refire');
    expect(d.nextAttempt).toBe(2);
  });

  it('bounds attempts with the established budget rather than inventing a second one', () => {
    const d = decideVerdictlessRefire({
      ...base,
      abortStatus: 'error',
      attempts: 3,
      lastAttemptStatus: 'cancelled',
    });
    expect(d.action).toBe('alarm');
    expect(d.reason).toBe('max-attempts');
  });

  it('never stacks onto a run already in flight', () => {
    const d = decideVerdictlessRefire({ ...base, abortStatus: 'cancelled', refireInFlight: true });
    expect(d.action).toBe('none');
    expect(d.reason).toBe('refire-in-flight');
  });

  it('waits out a cooldown longer than one full suite, so a second attempt cannot overlap the first', () => {
    const cooling = decideVerdictlessRefire({
      ...base,
      abortStatus: 'cancelled',
      attempts: 1,
      lastAttemptStatus: 'error',
      lastAttemptAtMs: NOW - 10 * 60_000,
    });
    expect(cooling.action).toBe('none');
    expect(cooling.reason).toBe('cooling-down');

    const elapsed = decideVerdictlessRefire({
      ...base,
      abortStatus: 'cancelled',
      attempts: 1,
      lastAttemptStatus: 'error',
      lastAttemptAtMs: NOW - 3 * H,
    });
    expect(elapsed.action).toBe('refire');
  });

  it('says nothing at all when no verdict-less death was detected', () => {
    const d = decideVerdictlessRefire({ ...base, verdictless: false, abortStatus: 'cancelled' });
    expect(d.action).toBe('none');
    expect(d.reason).toBe('not-verdictless');
    expect(naiveRefire(false)).toBe('none'); // the one case the naive version also gets right
  });

  it('carries an operator-facing sentence on every arm — the judgement must be quotable into an alarm', () => {
    const arms = [
      decideVerdictlessRefire({ ...base, abortStatus: 'cancelled' }),
      decideVerdictlessRefire({ ...base, abortStatus: 'migrations-pending' }),
      decideVerdictlessRefire({ ...base, abortStatus: null }),
      decideVerdictlessRefire({ ...base, ownerWallActive: true, abortStatus: 'cancelled' }),
    ];
    for (const a of arms) expect(a.detail.length).toBeGreaterThan(20);
  });
});

describe('readGateFireOwnerWall (D-003 — the owner wall is a REAL signal, fail-closed)', () => {
  type WallReader = Parameters<typeof readGateFireOwnerWall>[0];
  const reader = (v: unknown): WallReader => (async () => v) as unknown as WallReader;
  const held = { status: 'held', hold: { governingRef: 'D-080' } };
  const clear = { status: 'clear' };

  it('EITHER hold scope reads as an ACTIVE wall, naming its governingRef', async () => {
    await expect(readGateFireOwnerWall(reader(held), reader(clear))).resolves.toEqual({
      active: true,
      detail: 'qualification hold: D-080',
    });
    await expect(readGateFireOwnerWall(reader(clear), reader(held))).resolves.toEqual({
      active: true,
      detail: 'manual-run hold: D-080',
    });
  });

  it('a held scope with no attribution still walls (unattributed)', async () => {
    await expect(readGateFireOwnerWall(reader({ status: 'held' }), reader(clear))).resolves.toEqual({
      active: true,
      detail: 'qualification hold: unattributed',
    });
  });

  it('both scopes clear ⇒ no wall', async () => {
    await expect(readGateFireOwnerWall(reader(clear), reader(clear))).resolves.toEqual({
      active: false,
      detail: null,
    });
  });

  it('a FAILED read is an ACTIVE wall (fail-closed), never a cleared one', async () => {
    const throwing = (async () => {
      throw new Error('config unreadable');
    }) as unknown as WallReader;
    const wall = await readGateFireOwnerWall(throwing, reader(clear));
    expect(wall.active).toBe(true);
    expect(wall.detail).toContain('fail-closed');
    expect(wall.detail).toContain('config unreadable');
  });
});

describe('resolveVerdictlessRefireEpisode (D-003 — the durable episode budget and its reset rule)', () => {
  const fresh = { attempts: 0, lastAttemptStatus: null, lastAttemptAtMs: null };

  it('absent or malformed state reads as a FRESH episode — never as spent budget', () => {
    expect(resolveVerdictlessRefireEpisode(null, NOW)).toEqual(fresh);
    expect(resolveVerdictlessRefireEpisode(undefined, NOW)).toEqual(fresh);
    expect(resolveVerdictlessRefireEpisode({}, NOW)).toEqual(fresh);
    expect(resolveVerdictlessRefireEpisode({ verdictlessRefire: null }, NOW)).toEqual(fresh);
    expect(resolveVerdictlessRefireEpisode({ verdictlessRefire: { attempts: Number.NaN } }, NOW)).toEqual(fresh);
    // attempts without a lastAttemptAtMs anchor cannot be aged against a verdict — fresh
    expect(resolveVerdictlessRefireEpisode({ verdictlessRefire: { attempts: 2 } }, NOW)).toEqual(fresh);
  });

  it('a valid stored episode is carried when no newer verdict has landed', () => {
    expect(
      resolveVerdictlessRefireEpisode(
        { verdictlessRefire: { attempts: 2, lastAttemptStatus: 'cancelled', lastAttemptAtMs: NOW - H } },
        NOW - 2 * H,
      ),
    ).toEqual({ attempts: 2, lastAttemptStatus: 'cancelled', lastAttemptAtMs: NOW - H });
  });

  it('a verdict of ANY colour landing AFTER the last attempt ends the episode (fresh budget)', () => {
    expect(
      resolveVerdictlessRefireEpisode(
        { verdictlessRefire: { attempts: 3, lastAttemptStatus: 'cancelled', lastAttemptAtMs: NOW - 2 * H } },
        NOW - H,
      ),
    ).toEqual(fresh);
  });
});

describe('checkGreenStall D-006 actuation (gate-verdict-liveness-and-repair-reliability-2026-08-31 D-003)', () => {
  // A status the taxonomy itself says is transient — picked from the REAL table so a
  // reclassification there is reported by the premise test instead of silently changing
  // what these sweep tests exercise.
  const transientStatus: string =
    RECORDED_INCONCLUSIVE_STATUSES.find((s) => classifyGateAbort(s) === 'transient') ?? 'cancelled';

  it('premise: the chosen abort status really is transient in the live taxonomy', () => {
    expect(classifyGateAbort(transientStatus)).toBe('transient');
  });

  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readRoutineEngineLivenessMock.mockResolvedValue({ stale: false });
    resolveCheckpointRoutingMock.mockResolvedValue({ root: '/DEFAULT', extraEnv: {}, clearEnv: [] });
    isCheckpointRunLockHeldCheapMock.mockReturnValue({ held: false, elapsedSec: null });
    readCheckpointRunPhaseCheapMock.mockReturnValue(null);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    readRoutineEngineLivenessMock.mockReset();
    resolveCheckpointRoutingMock.mockReset();
    isCheckpointRunLockHeldCheapMock.mockReset();
    readCheckpointRunPhaseCheapMock.mockReset();
  });

  /** A FIRING gate whose every run dies before writing a verdict: recent fire, 4h-old verdict. */
  function makeVerdictlessSql(
    opts: {
      installSlug?: string;
      verdictlessRefire?: { attempts?: number; lastAttemptStatus?: string | null; lastAttemptAtMs?: number | null } | null;
      watchdogAlerted?: boolean;
    } = {},
  ) {
    const now = Date.now();
    const row = {
      install_slug: opts.installSlug ?? 'papercusp',
      workspace_id: 'papercusp-workspace',
      last_fired_ms: now - 30 * 60_000, // fired recently — NOT fireStale (the verdictless limb requires that)
      last_verdict_ms: now - 4 * H, // no verdict of ANY kind in 4h ⇒ verdictless (grace 3h)
      gh: {
        lastGreenAt: now - 4 * H, // < 12h ⇒ verdictStale stays false; this isolates the verdictless limb
        watchdogAlerted: opts.watchdogAlerted ?? false,
        inconclusive: { status: transientStatus },
        verdictlessRefire: opts.verdictlessRefire ?? null,
      },
    };
    const calls: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push([text, ...values]);
      if (text.includes('FROM harness_shared.routines')) return Promise.resolve([row]);
      return Promise.resolve(Object.assign([], { count: 1 }));
    }) as unknown as import('postgres').Sql;
    /** Episode persistence: the ONE write whose interpolated value carries "verdictlessRefire". */
    const episodeWrites = () =>
      calls
        .flatMap((c) => c.filter((v): v is string => typeof v === 'string' && v.includes('"verdictlessRefire"')))
        .map((v) => JSON.parse(v) as { verdictlessRefire: Record<string, unknown> });
    return { sql, calls, episodeWrites };
  }

  const wallClear = async () => ({ active: false, detail: null });
  const wallHeld = async () => ({ active: true, detail: 'manual-run hold: D-080' });
  const home = { refireHomeSlug: 'papercusp' };

  it('ACTUATES: wall clear + transient abort + fresh budget ⇒ launches once and persists attempt 1', async () => {
    const launch = vi.fn().mockResolvedValue({ launched: true, unit: 'papercusp-checkpoint-test.service' });
    const { sql, episodeWrites } = makeVerdictlessSql();
    await checkGreenStall(sql, { ...home, readGateFireWall: wallClear, launchCheckpoint: launch });
    expect(launch).toHaveBeenCalledTimes(1);
    const writes = episodeWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].verdictlessRefire).toEqual({
      attempts: 1,
      lastAttemptStatus: transientStatus,
      lastAttemptAtMs: expect.any(Number),
    });
  });

  it('actuation runs UPSTREAM of the one-shot watchdogAlerted gate: an already-alarmed episode still recovers', async () => {
    const launch = vi.fn().mockResolvedValue({ launched: true, unit: 'u' });
    const { sql, episodeWrites } = makeVerdictlessSql({ watchdogAlerted: true });
    const out = await checkGreenStall(sql, { ...home, readGateFireWall: wallClear, launchCheckpoint: launch });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(episodeWrites()).toHaveLength(1);
    expect(out.alarmed).toEqual([]); // the alarm stays one-shot; only the bounded recovery re-evaluates
  });

  it('wall HELD ⇒ no launch, no attempt burned', async () => {
    const launch = vi.fn();
    const { sql, episodeWrites } = makeVerdictlessSql();
    await checkGreenStall(sql, { ...home, readGateFireWall: wallHeld, launchCheckpoint: launch });
    expect(launch).not.toHaveBeenCalled();
    expect(episodeWrites()).toHaveLength(0);
  });

  it('a bare sweep (no wall reader wired) is fail-closed: never launches even with a launcher wired', async () => {
    const launch = vi.fn();
    const { sql, episodeWrites } = makeVerdictlessSql();
    await checkGreenStall(sql, { ...home, launchCheckpoint: launch });
    expect(launch).not.toHaveBeenCalled();
    expect(episodeWrites()).toHaveLength(0);
  });

  it('a wall reader that THROWS is fail-closed: no launch, no attempt burned', async () => {
    const launch = vi.fn();
    const { sql, episodeWrites } = makeVerdictlessSql();
    await checkGreenStall(sql, {
      ...home,
      readGateFireWall: async () => {
        throw new Error('wall read blew up');
      },
      launchCheckpoint: launch,
    });
    expect(launch).not.toHaveBeenCalled();
    expect(episodeWrites()).toHaveLength(0);
  });

  it('a non-home install stays advisory (home-scoped): no launch, no attempt burned', async () => {
    const launch = vi.fn();
    const { sql, episodeWrites } = makeVerdictlessSql({ installSlug: 'oddsmith' });
    await checkGreenStall(sql, { ...home, readGateFireWall: wallClear, launchCheckpoint: launch });
    expect(launch).not.toHaveBeenCalled();
    expect(episodeWrites()).toHaveLength(0);
  });

  it('cooldown (recent prior attempt) ⇒ no launch, no attempt burned', async () => {
    const launch = vi.fn();
    const { sql, episodeWrites } = makeVerdictlessSql({
      verdictlessRefire: { attempts: 1, lastAttemptStatus: 'some-earlier-status', lastAttemptAtMs: Date.now() - 10 * 60_000 },
    });
    await checkGreenStall(sql, { ...home, readGateFireWall: wallClear, launchCheckpoint: launch });
    expect(launch).not.toHaveBeenCalled();
    expect(episodeWrites()).toHaveLength(0);
  });

  it('a REPRODUCED abort (same status as the previous attempt) ⇒ no launch, no attempt burned', async () => {
    const launch = vi.fn();
    const { sql, episodeWrites } = makeVerdictlessSql({
      verdictlessRefire: { attempts: 1, lastAttemptStatus: transientStatus, lastAttemptAtMs: Date.now() - 2 * H },
    });
    await checkGreenStall(sql, { ...home, readGateFireWall: wallClear, launchCheckpoint: launch });
    expect(launch).not.toHaveBeenCalled();
    expect(episodeWrites()).toHaveLength(0);
  });

  it('a spent budget (max attempts) ⇒ no launch, no attempt burned', async () => {
    const launch = vi.fn();
    const { sql, episodeWrites } = makeVerdictlessSql({
      verdictlessRefire: { attempts: 3, lastAttemptStatus: 'some-earlier-status', lastAttemptAtMs: Date.now() - 2 * H },
    });
    await checkGreenStall(sql, { ...home, readGateFireWall: wallClear, launchCheckpoint: launch });
    expect(launch).not.toHaveBeenCalled();
    expect(episodeWrites()).toHaveLength(0);
  });

  it('a REFUSED launch (launched:false) burns no attempt', async () => {
    const launch = vi.fn().mockResolvedValue({ launched: false, reason: 'run-lock held' });
    const { sql, episodeWrites } = makeVerdictlessSql();
    await checkGreenStall(sql, { ...home, readGateFireWall: wallClear, launchCheckpoint: launch });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(episodeWrites()).toHaveLength(0);
  });

  it('a THROWN launch is non-fatal and burns no attempt', async () => {
    const launch = vi.fn().mockRejectedValue(new Error('systemd-run unavailable'));
    const { sql, episodeWrites } = makeVerdictlessSql();
    await expect(
      checkGreenStall(sql, { ...home, readGateFireWall: wallClear, launchCheckpoint: launch }),
    ).resolves.toBeTruthy();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(episodeWrites()).toHaveLength(0);
  });

  it('a newer verdict RESETS the episode: spent budget no longer blocks the next verdict-less death', async () => {
    const launch = vi.fn().mockResolvedValue({ launched: true, unit: 'u' });
    // attempts:3 (spent) but the newest verdict (4h ago) is NEWER than the last attempt (6h ago)
    const { sql, episodeWrites } = makeVerdictlessSql({
      verdictlessRefire: { attempts: 3, lastAttemptStatus: transientStatus, lastAttemptAtMs: Date.now() - 6 * H },
    });
    await checkGreenStall(sql, { ...home, readGateFireWall: wallClear, launchCheckpoint: launch });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(episodeWrites()[0]?.verdictlessRefire).toMatchObject({ attempts: 1 });
  });
});

describe('checkGreenStall P-003 verdict-rate alarm wiring (gate-verdict-liveness-and-repair-reliability-2026-08-31)', () => {
  // Sweep-level wiring tests for the no-verdict RATE alarm block. The evaluation
  // itself is pure and tested in gate-verdict-rate-alarm.test.ts; these four pin
  // the WIRING contract: alarm ⇒ escalation + one-shot flag flip; recovery ⇒ flag
  // reset; a green un-alarmed gate pays ZERO rate queries; a broken read is
  // non-fatal to the sweep.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    notifyAttentionMock.mockClear();
    readRoutineEngineLivenessMock.mockResolvedValue({ stale: false });
    resolveCheckpointRoutingMock.mockResolvedValue({ root: '/DEFAULT', extraEnv: {}, clearEnv: [] });
    isCheckpointRunLockHeldCheapMock.mockReturnValue({ held: false, elapsedSec: null });
    readCheckpointRunPhaseCheapMock.mockReturnValue(null);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    readRoutineEngineLivenessMock.mockReset();
    resolveCheckpointRoutingMock.mockReset();
    isCheckpointRunLockHeldCheapMock.mockReset();
    readCheckpointRunPhaseCheapMock.mockReset();
  });

  /** A gate with a QUIET verdict clock (recent verdict, recent fire, fresh green
   *  stamp) so the verdictless/stale limbs stay silent and only the rate block's
   *  own inputs (consecutiveReds / verdictRateAlarmed / the pipeline_events
   *  window) drive the outcome. */
  function makeRateSql(
    opts: {
      consecutiveReds?: number;
      verdictRateAlarmed?: boolean;
      /** P-002: a recorded abort status, so the D-006 decision has something to classify. */
      inconclusiveStatus?: string;
      /** pipeline_events window aggregates, or 'reject' to make that read throw. */
      window?: { fires: number; verdicts: number; last_verdict_ms: number | null } | 'reject';
    } = {},
  ) {
    const now = Date.now();
    const row = {
      install_slug: 'papercusp',
      workspace_id: 'papercusp-workspace',
      last_fired_ms: now - 10 * 60_000,
      last_verdict_ms: now - 10 * 60_000, // recent verdict ⇒ the verdictless limb stays quiet
      gh: {
        lastGreenAt: now - 60 * 60_000,
        watchdogAlerted: false,
        consecutiveReds: opts.consecutiveReds ?? 0,
        verdictRateAlarmed: opts.verdictRateAlarmed ?? false,
        ...(opts.inconclusiveStatus ? { inconclusive: { status: opts.inconclusiveStatus } } : {}),
      },
    };
    const calls: string[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push(text);
      void values;
      if (text.includes('FROM harness_shared.routines') && text.includes('SELECT')) {
        return Promise.resolve([row]);
      }
      // The rate-window read is the ONE pipeline_events query aliased `AS fires` —
      // other limbs legitimately read pipeline_events too, and the cost-gate claim
      // is about the RATE read specifically.
      if (text.includes('harness_shared.pipeline_events') && text.includes('AS fires')) {
        if (opts.window === 'reject') return Promise.reject(new Error('rate window read blew up'));
        const w = opts.window ?? { fires: 0, verdicts: 0, last_verdict_ms: now - 5 * 60_000 };
        return Promise.resolve([{ fires: w.fires, verdicts: w.verdicts, last_verdict_ms: w.last_verdict_ms }]);
      }
      return Promise.resolve(Object.assign([], { count: 1 }));
    }) as unknown as import('postgres').Sql;
    const flipWrites = () => calls.filter((t) => t.includes('"verdictRateAlarmed":true'));
    const clearWrites = () => calls.filter((t) => t.includes('"verdictRateAlarmed":false'));
    const rateReads = () => calls.filter((t) => t.includes('harness_shared.pipeline_events') && t.includes('AS fires'));
    return { sql, calls, flipWrites, clearWrites, rateReads };
  }

  it('ALARM: red gate + starved verdict rate ⇒ one-shot flag flip + urgent escalation on the verdict-rate axis', async () => {
    const { sql, flipWrites } = makeRateSql({
      consecutiveReds: 3,
      // 1 verdict / 10 fires: under the 0.5 threshold, above any min-fires floor.
      window: { fires: 10, verdicts: 1, last_verdict_ms: Date.now() - 5 * 60_000 },
    });
    const out = await checkGreenStall(sql, {});
    expect(flipWrites()).toHaveLength(1);
    expect(out.alarmed).toContain('papercusp');
    expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
    const page = notifyAttentionMock.mock.calls[0]?.[0] as {
      importance?: string;
      data?: { alarmAxis?: string; reason?: string };
    };
    expect(page.importance).toBe('urgent');
    expect(page.data?.alarmAxis).toBe('verdict-rate');
    expect(page.data?.reason).toBe('no-verdict-rate');
  });

  it('RECOVERY: alarmed flag + no-longer-alarming evaluation ⇒ flag reset so a future episode can page again', async () => {
    // gateRed=false makes the evaluation decline immediately; verdictRateAlarmed=true
    // still enters the block (recovery must be reachable from a green gate).
    const { sql, clearWrites, flipWrites } = makeRateSql({ consecutiveReds: 0, verdictRateAlarmed: true });
    const out = await checkGreenStall(sql, {});
    expect(clearWrites()).toHaveLength(1);
    expect(flipWrites()).toHaveLength(0);
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(out.recovered).toContain('papercusp');
  });

  it('COST GATE: a green, un-alarmed gate issues ZERO rate-window queries', async () => {
    const { sql, rateReads } = makeRateSql({ consecutiveReds: 0, verdictRateAlarmed: false });
    await checkGreenStall(sql, {});
    expect(rateReads()).toHaveLength(0);
    expect(notifyAttentionMock).not.toHaveBeenCalled();
  });

  it('FAIL-SOFT: a throwing rate read is non-fatal — the sweep completes, warns, and flips nothing', async () => {
    const { sql, flipWrites, clearWrites } = makeRateSql({ consecutiveReds: 3, window: 'reject' });
    await expect(checkGreenStall(sql, {})).resolves.toBeTruthy();
    expect(flipWrites()).toHaveLength(0);
    expect(clearWrites()).toHaveLength(0);
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('P-003 verdict-rate alarm failed'))).toBe(true);
  });

  it('P-002 WIRING: an ALARMED verdict-rate axis engages the D-006 refire decision while the verdict-less clock is QUIET (advisory warn — no launcher wired)', async () => {
    const { sql } = makeRateSql({
      consecutiveReds: 3,
      inconclusiveStatus: 'cancelled', // transient — the one abort class that authorizes a re-fire
      window: { fires: 10, verdicts: 1, last_verdict_ms: Date.now() - 5 * 60_000 },
    });
    await checkGreenStall(sql, { readGateFireWall: async () => ({ active: false, detail: null }) });
    expect(
      warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('D-006 refire warranted')),
    ).toBe(true);
  });

  it('P-002 CONTROL: the same alarmed axis WITHOUT a wall reader stays behind the fail-closed owner wall — refire structurally unreachable', async () => {
    const { sql } = makeRateSql({
      consecutiveReds: 3,
      inconclusiveStatus: 'cancelled',
      window: { fires: 10, verdicts: 1, last_verdict_ms: Date.now() - 5 * 60_000 },
    });
    await checkGreenStall(sql, {});
    expect(
      warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('D-006 refire warranted')),
    ).toBe(false);
  });
});

// WI-10002439: P-010 promised an 8h-rung age escalation for a held frozen candidate; nothing read
// the rung, and a queue sat awaiting-fixer ~40h with no alarm. These pin the evaluator's contract.
describe('evaluateStrandedRepairQueue (WI-10002439)', () => {
  const H = 3_600_000;
  const base = (over: Partial<StrandedRepairQueueSnapshot> = {}): StrandedRepairQueueSnapshot => ({
    candidate: 'a'.repeat(40),
    phase: 'awaiting-fixer',
    ageMs: 9 * H,
    ageEscalationRung: 1,
    attempts: 1,
    fixerSpawnId: 'spawn-1',
    fixerAlive: false,
    gateOwnership: 'unowned',
    decision: 'recover-dead-fixer',
    manifest: { legs: 2, red: 1, admitted: 0, green: 1, pathless: 0 },
    ...over,
  });

  it('no queue ⇒ no alarm', () => {
    expect(evaluateStrandedRepairQueue(null)).toEqual({ alarm: false, rung: 0, stranded: false, reason: null });
  });

  it('under the first 8h rung ⇒ no alarm, however stranded it looks', () => {
    const v = evaluateStrandedRepairQueue(base({ ageMs: 7 * H, ageEscalationRung: 0 }));
    expect(v.alarm).toBe(false);
  });

  it('the 40h incident shape (rung 5, awaiting-fixer, dead fixer) ⇒ STRANDED alarm naming the rung and the dead fixer', () => {
    const v = evaluateStrandedRepairQueue(base({ ageMs: 40 * H, ageEscalationRung: 5 }));
    expect(v.alarm).toBe(true);
    expect(v.rung).toBe(5);
    expect(v.stranded).toBe(true);
    expect(v.reason).toContain('~40h');
    expect(v.reason).toContain('DEAD');
    expect(v.reason).toContain('STRANDED SHAPE');
  });

  it('no fixer ever recorded is stranded too (liveness null is NOT treated as live)', () => {
    const v = evaluateStrandedRepairQueue(base({ fixerSpawnId: null, fixerAlive: null, attempts: 0 }));
    expect(v.stranded).toBe(true);
    expect(v.reason).toContain('NO fixer recorded');
  });

  it('a LIVE fixer still escalates on age (P-010: the rung is an alert cadence) but is not called stranded', () => {
    const v = evaluateStrandedRepairQueue(base({ fixerAlive: true, decision: 'wait-for-fixer' }));
    expect(v.alarm).toBe(true);
    expect(v.stranded).toBe(false);
    expect(v.reason).not.toContain('STRANDED SHAPE');
  });

  it('a held-live gate owner prevents the false none-live alarm despite no recorded fixer', () => {
    const v = evaluateStrandedRepairQueue(base({ fixerSpawnId: null, fixerAlive: null, gateOwnership: 'held-live' }));
    expect(v.alarm).toBe(true);
    expect(v.stranded).toBe(false);
    expect(v.reason).toContain('gate ownership held-live');
    expect(v.reason).not.toContain('STRANDED SHAPE');
  });

  it('a lapsed claim lease with a live holder is not "none live" (WI-10005262)', () => {
    // Measured 2026-10-02: holder su-3ee17ad9 live and driving a verify run, lease lapsed at
    // 03:03Z, and the watchdog broadcast an URGENT "STRANDED — none live".
    for (const holder of ['live', 'parked', 'recorded'] as const) {
      const v = evaluateStrandedRepairQueue(
        base({ fixerSpawnId: null, fixerAlive: null, gateOwnership: 'lease-expired', gateHolderSessionState: holder }),
      );
      expect(v.alarm).toBe(true);
      expect(v.stranded).toBe(false);
      expect(v.reason).toContain(`gate ownership lease-expired (holder ${holder})`);
      expect(v.reason).not.toContain('STRANDED SHAPE');
    }
  });

  it('a lapsed lease whose holder ended or is unmeasured still counts as absent', () => {
    for (const holder of ['ended', null, undefined] as const) {
      const v = evaluateStrandedRepairQueue(
        base({ fixerSpawnId: null, fixerAlive: null, gateOwnership: 'lease-expired', gateHolderSessionState: holder }),
      );
      expect(v.stranded).toBe(true);
      expect(v.reason).toContain('STRANDED SHAPE');
    }
  });

  it('a stalled but live owner is not absent; an ended owner is', () => {
    expect(evaluateStrandedRepairQueue(base({ gateOwnership: 'held-stalled' })).stranded).toBe(false);
    expect(evaluateStrandedRepairQueue(base({ gateOwnership: 'held-by-ended-session' })).stranded).toBe(true);
  });

  it('unknown gate ownership or fixer liveness cannot prove nobody is live', () => {
    for (const over of [
      { fixerSpawnId: null, fixerAlive: null, gateOwnership: null },
      { fixerSpawnId: 'spawn-1', fixerAlive: null, gateOwnership: 'unowned' as const },
      { fixerSpawnId: null, fixerAlive: null, gateOwnership: 'held-needs-confirmation' as const },
    ]) {
      const v = evaluateStrandedRepairQueue(base(over));
      expect(v.alarm).toBe(true);
      expect(v.stranded).toBe(false);
    }
  });

  it('pathless manifest rows are REPORTED, never a trigger on their own (pathless = admittable by hand)', () => {
    const young = evaluateStrandedRepairQueue(
      base({ ageMs: 1 * H, ageEscalationRung: 0, manifest: { legs: 1, red: 1, admitted: 0, green: 0, pathless: 1 } }),
    );
    expect(young.alarm).toBe(false);
    const old = evaluateStrandedRepairQueue(base({ manifest: { legs: 1, red: 1, admitted: 0, green: 0, pathless: 1 } }));
    expect(old.reason).toContain('1 pathless (paths must be named by hand)');
  });

  it('non-awaiting-fixer phases escalate on age without the stranded label', () => {
    const v = evaluateStrandedRepairQueue(base({ phase: 'blocked', decision: 'hold-exhausted' }));
    expect(v.alarm).toBe(true);
    expect(v.stranded).toBe(false);
  });

  it('startGreenStallWatchdog actually RUNS the pass — the promised-but-unwired class this item exists for', async () => {
    const { readFileSync } = await import('node:fs');
    // Overridable so scripts/mutation-probe.sh can point this guard at a mutated COPY (tier 2).
    const subject = process.env.STRANDED_WIRING_SUBJECT ?? new URL('./green-stall-watchdog.ts', import.meta.url);
    const src = readFileSync(subject, 'utf8');
    const starter = src.slice(src.indexOf('export function startGreenStallWatchdog('));
    expect(starter.length).toBeGreaterThan(0);
    expect(starter).toMatch(/\n\s*void runInstallScopedWatchdogs\(sql,/);
    expect(starter).toMatch(/checkStrandedRepairQueue\(sql,\s*\{\s*installSlug\s*\}\)/);
    expect(starter).not.toMatch(/checkStrandedRepairQueue\(sql\)/);
  });
});

describe('evaluateQuietLiveFixer advisory (EI-24932471671159980)', () => {
  const tenMinutes = 10 * 60_000;
  const base = (over: Partial<Parameters<typeof evaluateQuietLiveFixer>[0]> = {}) =>
    evaluateQuietLiveFixer({
      phase: 'awaiting-fixer',
      fixerSpawnId: 'spawn-1',
      fixerAlive: true,
      lastOutputAtMs: 1_000,
      nowMs: 1_000 + tenMinutes,
      ...over,
    });

  it('nudges only after the shared 10-minute stream-silence threshold', () => {
    expect(base()).toEqual({ state: 'silent', silentMs: tenMinutes });
    expect(base({ nowMs: 1_000 + tenMinutes - 1 })).toEqual({
      state: 'active',
      silentMs: tenMinutes - 1,
    });
  });

  it('missing output or uncertain liveness is unknown, never a stale-fixer verdict', () => {
    expect(base({ lastOutputAtMs: null })).toEqual({ state: 'unknown', silentMs: null });
    expect(base({ fixerAlive: null })).toEqual({ state: 'unknown', silentMs: null });
  });

  it('does not classify a changed phase, missing fixer, or dead fixer as a quiet live fixer', () => {
    expect(base({ phase: 'ready-to-verify' }).state).toBe('not-applicable');
    expect(base({ fixerSpawnId: null }).state).toBe('not-applicable');
    expect(base({ fixerAlive: false }).state).toBe('not-applicable');
  });

  it('the production queue watchdog invokes the advisory classifier', async () => {
    const { readFileSync } = await import('node:fs');
    const subject = process.env.STRANDED_WIRING_SUBJECT ?? new URL('./green-stall-watchdog.ts', import.meta.url);
    const src = readFileSync(subject, 'utf8');
    const check = src.slice(src.indexOf('export async function checkStrandedRepairQueue('));
    expect(check).toContain('evaluateQuietLiveFixer(');
    expect(check).toContain('STRANDED_REPAIR_FIXER_SILENCE_PHASE');
  });
});
