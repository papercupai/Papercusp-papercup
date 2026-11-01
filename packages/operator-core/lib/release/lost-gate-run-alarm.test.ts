/**
 * P-005 (gate-throughput-shift-left-2026-10-06, R-5): a gate run whose pid is gone with its
 * in-flight marker still set pages the gate holder and fleet leader ONCE, within minutes, and is
 * silent while the pid is alive or the marker is cleared.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import type { StoredInFlightCandidate } from './in-flight-candidate';
import {
  beginQualificationTransaction,
  QUALIFICATION_POST_VERDICT_HANG_MS,
  settleQualificationTransaction,
  type CheckpointQualificationTransaction,
} from './checkpoint-qualification-transaction';
import { GREEN_CHECKPOINT_SYSTEMD_TERMINAL_MARKER } from '../release-checkpoint-launch';
import {
  LOST_RUN_SWEEP_INTERVAL_MS,
  claimLostRunAlarm,
  decideLostRunAlarm,
  lostRunAlarmKey,
  resolveLostRunRoutes,
  sweepLostGateRuns,
  type LostRunSweepDeps,
} from './lost-gate-run-alarm';
import { currentRepairLimbExecutor, type RepairLimbExecutor } from './repair-limb-executor';
import { GREEN_CHECKPOINT_RESULT_MARKER } from './checkpoint-log-tags';

const NOW = 1_750_000_000_000;
const SELF_PID = 7;
const DEAD_PID = 424242;

const marker = (over: Partial<StoredInFlightCandidate> = {}): StoredInFlightCandidate => ({
  candidate: 'deadbeef00112233445566778899aabbccddeeff',
  candidateSource: 'tip',
  base: 'cafe0000112233445566778899aabbccddeeff00',
  selectedAtMs: NOW - 120_000,
  quietCutApplied: false,
  tipAtSelection: null,
  refireDepth: 0,
  pid: DEAD_PID,
  observedAtMs: NOW - 120_000,
  verdictWrittenAtMs: null,
  ...over,
});

/**
 * A stateful stand-in for ONE green-checkpoint routines row. It answers the sweep's SELECT from
 * current state and applies the claim/release UPDATEs with the same predicate the SQL states
 * (claim only when the stored key IS DISTINCT FROM the new key; release only on an equal key), so
 * dedup is exercised across passes and simulated restarts rather than asserted on a mock count.
 */
function fakeRoutineRow(initialMarker: StoredInFlightCandidate | null, qualification: unknown = null) {
  const row = {
    installSlug: 'papercusp',
    workspaceId: 'papercusp-workspace',
    marker: initialMarker as StoredInFlightCandidate | null,
    alarmKey: null as string | null,
    progressAlarmKey: null as string | null,
    qualification,
    retries: 0,
    /** The executor stamp each alarm field's winning claim merged into its record (R-1). */
    stamps: {} as Record<'alarmKey' | 'progressAlarmKey', unknown>,
  };
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (/^\s*SELECT install_slug/.test(text)) {
      return Promise.resolve(
        [{ install_slug: row.installSlug, workspace_id: row.workspaceId, marker: row.marker, alarmed_key: row.alarmKey, progress_alarmed_key: row.progressAlarmKey, qualification: row.qualification }],
      );
    }
    if (text.includes('next_fire_at')) {
      row.retries += 1;
      return Promise.resolve({ count: 1 });
    }
    if (text.includes('IS DISTINCT FROM')) {
      const field = values[0] === 'qualificationProgressAlarm' ? 'progressAlarmKey' : 'alarmKey';
      const key = values[1] as string;
      if (row[field] === key) return Promise.resolve({ count: 0 });
      row[field] = key;
      row.stamps[field] = JSON.parse(values[3] as string);
      return Promise.resolve({ count: 1 });
    }
    if (text.includes("(metadata->'gate_health') -")) {
      const field = values[0] === 'qualificationProgressAlarm' ? 'progressAlarmKey' : 'alarmKey';
      const key = values[4] as string;
      if (row[field] === key) row[field] = null;
      return Promise.resolve({ count: 1 });
    }
    if (/coord_presence/.test(text)) return Promise.resolve([]);
    throw new Error(`unexpected query: ${text}`);
  }) as unknown as Sql;
  return { row, sql };
}

function deps(over: Partial<LostRunSweepDeps> = {}): LostRunSweepDeps & {
  broadcast: ReturnType<typeof vi.fn>;
  notifyOwner: ReturnType<typeof vi.fn>;
} {
  return {
    nowMs: NOW,
    selfPid: SELF_PID,
    pidAlive: (pid: number) => pid !== DEAD_PID,
    hostFleetSlug: null,
    claim: claimLostRunAlarm,
    readHolder: async () => 'su-holder',
    readOwnerFleetSlug: async () => 'gate-fleet',
    attention: { resolve: async () => true },
    ...over,
    broadcast: (over.broadcast as ReturnType<typeof vi.fn>) ?? vi.fn(async () => true),
    notifyOwner: (over.notifyOwner as ReturnType<typeof vi.fn>) ?? vi.fn(async () => {}),
  } as never;
}

describe('decideLostRunAlarm (P-005 / R-5)', () => {
  const base = { alreadyAlarmedKey: null, selfPid: SELF_PID, nowMs: NOW };

  it('alarms for a marker whose pid is gone, with no grace period', () => {
    const fresh = marker({ observedAtMs: NOW - 30_000 });
    const d = decideLostRunAlarm({ ...base, rawMarker: fresh, pidAlive: () => false });
    expect(d).toMatchObject({ action: 'alarm', pid: DEAD_PID, key: lostRunAlarmKey(fresh) });
  });

  it('is silent while the pid is alive, when liveness is unknown, for its own run, and with no marker', () => {
    expect(decideLostRunAlarm({ ...base, rawMarker: marker(), pidAlive: () => true })).toEqual({
      action: 'silent',
      reason: 'pid-alive',
    });
    expect(decideLostRunAlarm({ ...base, rawMarker: marker(), pidAlive: () => null })).toEqual({
      action: 'silent',
      reason: 'pid-unknown',
    });
    expect(
      decideLostRunAlarm({ ...base, rawMarker: marker({ pid: SELF_PID }), pidAlive: () => false }),
    ).toEqual({ action: 'silent', reason: 'own-run' });
    expect(decideLostRunAlarm({ ...base, rawMarker: null, pidAlive: () => false })).toEqual({
      action: 'silent',
      reason: 'no-marker',
    });
  });

  it('is silent for a run it already alarmed, but alarms again for a DIFFERENT dead run', () => {
    const first = marker();
    expect(
      decideLostRunAlarm({ ...base, rawMarker: first, alreadyAlarmedKey: lostRunAlarmKey(first), pidAlive: () => false }),
    ).toEqual({ action: 'silent', reason: 'already-alarmed' });
    const second = marker({ pid: DEAD_PID + 1, observedAtMs: NOW - 10_000 });
    expect(
      decideLostRunAlarm({ ...base, rawMarker: second, alreadyAlarmedKey: lostRunAlarmKey(first), pidAlive: () => false }),
    ).toMatchObject({ action: 'alarm', key: lostRunAlarmKey(second) });
  });
});

describe('resolveLostRunRoutes', () => {
  it("pages the holder and the holder's fleet leader", () => {
    expect(
      resolveLostRunRoutes({ installSlug: 'papercusp', holderOwnerId: 'su-h', holderFleetSlug: 'f1', hostFleetSlug: 'host' })
        .map((r) => r.ownerSelector),
    ).toEqual(['su-h', '@fleet-leader:f1']);
  });

  it("falls back to this host's fleet when the holder has none, and to nobody when neither exists", () => {
    expect(
      resolveLostRunRoutes({ installSlug: 'papercusp', holderOwnerId: 'su-h', holderFleetSlug: null, hostFleetSlug: 'host' })
        .map((r) => r.ownerSelector),
    ).toEqual(['su-h', '@fleet-leader:host']);
    expect(
      resolveLostRunRoutes({ installSlug: 'papercusp', holderOwnerId: null, holderFleetSlug: null, hostFleetSlug: null }),
    ).toEqual([]);
  });
});

describe('sweepLostGateRuns (P-005 / R-5)', () => {
  it('pages the holder and fleet leader exactly once for a dead run, across passes and a restart', async () => {
    const { sql, row } = fakeRoutineRow(marker());
    const d = deps();

    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: ['papercusp'], deduped: [], failed: [] });
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    const ev = d.broadcast.mock.calls[0][0];
    expect(ev.route.ownerSelector).toBe('su-holder');
    expect(ev.extraRoutes.map((r: { ownerSelector: string }) => r.ownerSelector)).toEqual(['@fleet-leader:gate-fleet']);
    expect(ev.conditionKey).toBe('green-checkpoint-lost-run:papercusp');
    expect(ev.summary).toContain(`pid ${DEAD_PID}`);
    expect(row.alarmKey).toBe(lostRunAlarmKey(marker()));

    // The marker lingers (e.g. the 15-minute wake failed): the next pass must not re-page.
    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: [], deduped: ['papercusp'], failed: [] });
    // A restarted process has fresh deps but the same durable stamp: still no re-page.
    const restarted = deps();
    await sweepLostGateRuns(sql, restarted);
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    expect(restarted.broadcast).not.toHaveBeenCalled();
  });

  it('a concurrent pass that loses the compare-and-set stays silent', async () => {
    const { sql, row } = fakeRoutineRow(marker());
    row.alarmKey = null;
    const a = deps();
    const b = deps();
    const [ra, rb] = await Promise.all([sweepLostGateRuns(sql, a), sweepLostGateRuns(sql, b)]);
    expect([...ra.alarmed, ...rb.alarmed]).toEqual(['papercusp']);
    expect(a.broadcast.mock.calls.length + b.broadcast.mock.calls.length).toBe(1);
  });

  it('is silent while the pid is alive and once the marker is cleared', async () => {
    const { sql, row } = fakeRoutineRow(marker());
    const d = deps({ pidAlive: () => true });
    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: [], deduped: [], failed: [] });
    row.marker = null;
    await expect(sweepLostGateRuns(sql, deps())).resolves.toEqual({ alarmed: [], deduped: [], failed: [] });
    expect(d.broadcast).not.toHaveBeenCalled();
  });

  it('raises to the owner when no holder or fleet leader is resolvable', async () => {
    const { sql } = fakeRoutineRow(marker());
    const d = deps({ readHolder: async () => null, hostFleetSlug: null });
    await sweepLostGateRuns(sql, d);
    const ev = d.broadcast.mock.calls[0][0];
    expect(ev.route).toBeUndefined();
    expect(d.notifyOwner).toHaveBeenCalledTimes(1);
  });

  it('the real owner fallback raises an actionable key and only measured recovery resolves it', async () => {
    const { sql, row } = fakeRoutineRow(marker());
    const broadcast = vi.fn(async (_event: { conditionKey?: string }) => true);
    const resolve = vi.fn(async (_event: { conditionKey: string; summary: string }) => true);
    const notify = vi.fn(async () => {});
    const d: LostRunSweepDeps = { nowMs: NOW, selfPid: SELF_PID, pidAlive: () => false,
      readHolder: async () => null, hostFleetSlug: null, broadcast,
      attention: { broadcast, resolve, notify } };
    await sweepLostGateRuns(sql, d);
    expect(notify).toHaveBeenCalledOnce();
    // The injected seam must observe the SAME input production delivers (WI-6554700010009741):
    // a {title, body}-only seam call silently dropped kind/importance/workspaceId/data.
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'intervention', importance: 'urgent', workspaceId: expect.any(String),
      data: expect.objectContaining({ installSlug: 'papercusp' }),
    }));
    const key = 'green-checkpoint-lost-run:papercusp';
    expect(broadcast.mock.calls.map(([event]) => event.conditionKey)).toEqual([key, key]);
    const { actionableConditionFor } = await import('../coord/actionable-conditions');
    expect(actionableConditionFor(key)).toMatchObject({ harnessFrom: 'suffix', severity: 'critical' });
    await sweepLostGateRuns(sql, { ...d, pidAlive: () => null });
    expect(resolve).not.toHaveBeenCalled();
    const unreadable = (async () => { throw new Error('scan unavailable'); }) as unknown as Sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { await sweepLostGateRuns(unreadable, d); } finally { warn.mockRestore(); }
    expect(resolve).not.toHaveBeenCalled();
    row.marker = null;
    await sweepLostGateRuns(sql, d);
    expect(resolve).toHaveBeenCalledWith({ conditionKey: key, summary: 'lost-gate-run-alarm recovered' });
  });

  it('an unreadable holder never suppresses the alarm', async () => {
    const { sql } = fakeRoutineRow(marker());
    const d = deps({
      readHolder: async () => {
        throw new Error('ownership store down');
      },
      hostFleetSlug: 'host-fleet',
    });
    await expect(sweepLostGateRuns(sql, d)).resolves.toMatchObject({ alarmed: ['papercusp'] });
    expect(d.broadcast.mock.calls[0][0].route.ownerSelector).toBe('@fleet-leader:host-fleet');
  });

  it('an undelivered page releases its claim so the next pass retries it', async () => {
    const { sql, row } = fakeRoutineRow(marker());
    const failing = deps({ broadcast: vi.fn(async () => false) });
    await expect(sweepLostGateRuns(sql, failing)).resolves.toEqual({ alarmed: [], deduped: [], failed: ['papercusp'] });
    expect(row.alarmKey).toBeNull();
    const retry = deps();
    await expect(sweepLostGateRuns(sql, retry)).resolves.toMatchObject({ alarmed: ['papercusp'] });
    expect(retry.broadcast).toHaveBeenCalledTimes(1);
  });
});

describe('qualification progress in the existing lost-run sweep', () => {
  function qualification(heartbeatAtMs = NOW - 4 * 60_000): CheckpointQualificationTransaction {
    const ready = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: NOW - 5 * 60_000,
    }).transaction;
    return {
      ...ready, phase: 'running', lastProgressAtMs: heartbeatAtMs,
      currentPhysicalRunner: {
        id: 'runner-1', candidate: 'candidate-1', reservedAtMs: NOW - 5 * 60_000,
        heartbeatAtMs, leaseExpiresAtMs: NOW + 60 * 60_000,
        pid: DEAD_PID, pidIdentity: 'test-boot:test-start', phase: 'suite', evidenceRefs: [],
      },
    };
  }

  function progressDeps(liveness: 'live' | 'dead' | 'unknown') {
    return Object.assign(deps(), { probeQualificationRunner: vi.fn(() => liveness) });
  }

  function progressingSuccessor(): CheckpointQualificationTransaction {
    const tx = qualification(NOW - 60_000);
    tx.currentPhysicalRunner = { ...tx.currentPhysicalRunner!, id: 'successor-runner', pid: DEAD_PID + 1 };
    return tx;
  }

  it.each(['live', 'unknown', 'dead'] as const)('an alarmed old marker cannot hide a newer %s qualification runner', async (liveness) => {
    const oldMarker = marker();
    const { sql, row } = fakeRoutineRow(oldMarker);
    await sweepLostGateRuns(sql, deps());
    expect(row.alarmKey).toBe(lostRunAlarmKey(oldMarker));

    const tx = qualification();
    tx.currentPhysicalRunner = { ...tx.currentPhysicalRunner!, id: 'successor-runner', pid: DEAD_PID + 1 };
    row.qualification = tx;
    const d = progressDeps(liveness);
    const expectedRetries = liveness === 'dead' ? 1 : 0;
    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: ['papercusp'], deduped: [], failed: [] });
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    expect(d.broadcast.mock.calls[0][0].body).toContain('successor-runner');
    expect(row.retries).toBe(expectedRetries);
    expect(row.qualification).toEqual(tx);

    // Keeping the old marker must not alternate its alarm with the new runner's alarm.
    const repeated = progressDeps(liveness);
    await expect(sweepLostGateRuns(sql, repeated)).resolves.toEqual({ alarmed: [], deduped: ['papercusp'], failed: [] });
    expect(repeated.broadcast).not.toHaveBeenCalled();
    expect(row.retries).toBe(expectedRetries);
    expect(row.alarmKey).toBe(lostRunAlarmKey(oldMarker));

    row.qualification = { ...tx, phase: 'terminal', outcome: { kind: 'green', reason: 'advanced' } };
    const recovered = progressDeps('live');
    await sweepLostGateRuns(sql, recovered);
    expect(recovered.broadcast).not.toHaveBeenCalled();
  });

  it.each(['live', 'unknown'] as const)('pages once for stale progress with %s liveness and never starts another runner', async (liveness) => {
    const { sql, row } = fakeRoutineRow(null, qualification());
    const d = progressDeps(liveness);
    await sweepLostGateRuns(sql, d);
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    expect(d.broadcast.mock.calls[0][0]).toMatchObject({
      conditionKey: 'green-checkpoint-run-progress:papercusp',
      route: { ownerSelector: 'su-holder' },
    });
    expect(d.broadcast.mock.calls[0][0].body).toContain('attempt-1');
    expect(d.broadcast.mock.calls[0][0].body).toContain('preserve single flight');
    const event = d.broadcast.mock.calls[0][0];
    const routes = [event.route, ...event.extraRoutes];
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(route.reason).toContain('qualification progress is stale');
      expect(route.reason).not.toContain('died');
    }
    await sweepLostGateRuns(sql, progressDeps(liveness));
    expect(row.retries).toBe(0);
    expect(row.progressAlarmKey).not.toBeNull();
    expect(d.broadcast).toHaveBeenCalledTimes(1);
  });

  it('stays silent for a recently progressing runner and for a terminal attempt', async () => {
    const { sql, row } = fakeRoutineRow(null, qualification(NOW - 60_000));
    const d = progressDeps('live');
    await sweepLostGateRuns(sql, d);
    expect(d.broadcast).not.toHaveBeenCalled();
    row.qualification = { ...qualification(), phase: 'terminal', outcome: { kind: 'green', reason: 'advanced' } };
    await sweepLostGateRuns(sql, d);
    expect(d.broadcast).not.toHaveBeenCalled();
    expect(row.retries).toBe(0);
  });

  it('ignores a stale dead candidate marker while the current qualification runner is progressing', async () => {
    const { sql, row } = fakeRoutineRow(marker(), progressingSuccessor());
    const d = progressDeps('live');

    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: [], deduped: [], failed: [] });
    expect(d.broadcast).not.toHaveBeenCalled();
    expect(row.alarmKey).toBeNull();
    expect(row.progressAlarmKey).toBeNull();
    expect(row.retries).toBe(0);
  });

  it('resolves an old lost-run alarm when a current qualification runner proves progress', async () => {
    const resolve = vi.fn(async () => true);
    const { sql, row } = fakeRoutineRow(marker(), progressingSuccessor());
    row.alarmKey = lostRunAlarmKey(marker());
    const d = Object.assign(deps({ attention: { resolve } }), { probeQualificationRunner: vi.fn(() => 'live' as const) });

    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: [], deduped: [], failed: [] });
    expect(d.broadcast).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({
      conditionKey: 'green-checkpoint-lost-run:papercusp',
      summary: 'lost-gate-run-alarm recovered',
    });
    expect(row.alarmKey).toBe(lostRunAlarmKey(marker()));
  });

  // WI-6554700010009616: run b874ad21 sat ~2h past its verdict while its heartbeat stayed fresh.
  function parkedInFinalizing(parkedMs: number): CheckpointQualificationTransaction {
    const tx = qualification(NOW - 30_000);
    return { ...tx, currentPhysicalRunner: {
      ...tx.currentPhysicalRunner!, phase: 'finalizing', phaseEnteredAtMs: NOW - parkedMs,
    } };
  }

  it('pages once for a live runner parked past its final verdict, although its heartbeat is fresh', async () => {
    const resolve = vi.fn(async () => true);
    const parkedMs = QUALIFICATION_POST_VERDICT_HANG_MS + 60_000;
    const { sql, row } = fakeRoutineRow(null, parkedInFinalizing(parkedMs));
    const d = Object.assign(deps({ attention: { resolve } }), { probeQualificationRunner: vi.fn(() => 'live' as const) });
    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: ['papercusp'], deduped: [], failed: [] });
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    expect(d.broadcast.mock.calls[0][0]).toMatchObject({ conditionKey: 'green-checkpoint-run-progress:papercusp' });
    expect(d.broadcast.mock.calls[0][0].body).toContain('POST-VERDICT HANG');
    expect(d.broadcast.mock.calls[0][0].body).toContain('Preserve single flight');
    expect(row.progressAlarmKey).toBe(`qualification:attempt-1:runner-1:post-verdict-hang:${NOW - parkedMs}`);
    expect(row.retries).toBe(0);
    // The fresh heartbeat reads `progressing`: that must neither resolve the hang nor page it again.
    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: [], deduped: ['papercusp'], failed: [] });
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    // The attempt settling is the measured recovery.
    row.qualification = { ...parkedInFinalizing(parkedMs), phase: 'terminal', outcome: { kind: 'red', reason: 'not-green' } };
    await sweepLostGateRuns(sql, d);
    expect(resolve).toHaveBeenCalledWith({ conditionKey: 'green-checkpoint-run-progress:papercusp', summary: 'lost-gate-run-alarm recovered' });
  });

  it('stays silent inside the post-verdict bound, for unknown liveness, and for a long verdict path still delivering', async () => {
    const within = fakeRoutineRow(null, parkedInFinalizing(QUALIFICATION_POST_VERDICT_HANG_MS - 60_000));
    const live = progressDeps('live');
    await sweepLostGateRuns(within.sql, live);
    expect(live.broadcast).not.toHaveBeenCalled();

    const unknown = fakeRoutineRow(null, parkedInFinalizing(QUALIFICATION_POST_VERDICT_HANG_MS + 60_000));
    const unknownDeps = progressDeps('unknown');
    await sweepLostGateRuns(unknown.sql, unknownDeps);
    expect(unknownDeps.broadcast).not.toHaveBeenCalled();

    // Prefix salvage can legitimately run a second suite while the run is still `delivering`.
    const salvage = parkedInFinalizing(QUALIFICATION_POST_VERDICT_HANG_MS + 60_000);
    salvage.currentPhysicalRunner = { ...salvage.currentPhysicalRunner!, phase: 'delivering' };
    const delivering = fakeRoutineRow(null, salvage);
    const deliveringDeps = progressDeps('live');
    await sweepLostGateRuns(delivering.sql, deliveringDeps);
    expect(deliveringDeps.broadcast).not.toHaveBeenCalled();
    expect([within.row, unknown.row, delivering.row].map((row) => row.progressAlarmKey)).toEqual([null, null, null]);
  });

  it('promptly retries a confirmed-dead runner before its unexpired lease, without manufacturing a verdict', async () => {
    const tx = qualification(NOW - 60_000);
    const { sql, row } = fakeRoutineRow(null, tx);
    const d = progressDeps('dead');
    await sweepLostGateRuns(sql, d);
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    expect(row.retries).toBe(1);
    expect(row.qualification).toEqual(tx);
    expect(d.broadcast.mock.calls[0][0].body).toContain('proved dead');
    const event = d.broadcast.mock.calls[0][0];
    expect([event.route, ...event.extraRoutes].map((route) => route.reason)).toEqual([
      'you hold the papercusp gate and its in-flight run died',
      "the papercusp gate's in-flight run died; fleet gate-fleet leads it",
    ]);
  });

  it('settles an exact terminal repair-in-progress result without a lost-run alarm or retry', async () => {
    const tx = qualification();
    tx.candidate = 'repair-head-1';
    tx.runId = 'run-1';
    tx.currentPhysicalRunner = {
      ...tx.currentPhysicalRunner!,
      candidate: 'repair-head-1',
      unit: 'papercup-green-checkpoint-scheduled-run-1.service',
      evidenceRefs: ['gate-fire:runner-1', 'checkpoint-run:run-1'],
    };
    const { sql, row } = fakeRoutineRow(null, tx);
    const log = [
      `${GREEN_CHECKPOINT_RESULT_MARKER} ${JSON.stringify({
        runId: 'run-1', candidate: 'frozen-candidate-1', reason: 'repair-in-progress', advanced: false,
        repairQueue: { candidate: 'frozen-candidate-1', repairHead: 'repair-head-1' },
      })}`,
      `${GREEN_CHECKPOINT_SYSTEMD_TERMINAL_MARKER} service_result=success exit_code=exited exit_status=0`,
    ].join('\n');
    const reconcile = vi.fn(async (
      _target: { installSlug: string; workspaceId: string },
      input: {
        attemptId?: string; reason: string; green?: boolean | null; candidate?: string | null;
        repairHead?: string | null; runId?: string | null; evidenceRefs?: readonly string[]; nowMs?: number;
      },
    ) => {
      const result = settleQualificationTransaction(tx, {
        ...input,
        attemptId: input.attemptId ?? tx.attemptId,
      });
      row.qualification = result.transaction;
      return result;
    });
    const d = Object.assign(progressDeps('dead'), {
      readQualificationRunLog: vi.fn(async () => log),
      reconcileTerminalNoVerdict: reconcile,
    });

    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: [], deduped: [], failed: [] });
    expect(d.readQualificationRunLog).toHaveBeenCalledWith(tx.currentPhysicalRunner);
    expect(reconcile).toHaveBeenCalledWith(
      { installSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
      expect.objectContaining({
        attemptId: 'attempt-1', reason: 'repair-in-progress', candidate: 'frozen-candidate-1',
        repairHead: 'repair-head-1', runId: 'run-1',
        evidenceRefs: expect.arrayContaining(['checkpoint-terminal:run-1']),
      }),
    );
    expect(row.qualification).toMatchObject({
      phase: 'waiting',
      candidate: 'frozen-candidate-1',
      repairHead: 'repair-head-1',
      outcome: { kind: 'pre-suite-no-verdict', reason: 'repair-in-progress' },
      currentPhysicalRunner: null,
    });
    expect(row.retries).toBe(0);
    expect(d.broadcast).not.toHaveBeenCalled();
  });

  it('does not reconcile a terminal repair-in-progress marker bound to another run', async () => {
    const tx = qualification();
    tx.runId = 'run-1';
    tx.currentPhysicalRunner = {
      ...tx.currentPhysicalRunner!,
      unit: 'papercup-green-checkpoint-scheduled-run-1.service',
      evidenceRefs: ['gate-fire:runner-1', 'checkpoint-run:run-1'],
    };
    const { sql, row } = fakeRoutineRow(null, tx);
    const log = [
      `${GREEN_CHECKPOINT_RESULT_MARKER} ${JSON.stringify({
        runId: 'other-run', candidate: 'candidate-1', reason: 'repair-in-progress', advanced: false,
      })}`,
      `${GREEN_CHECKPOINT_SYSTEMD_TERMINAL_MARKER} service_result=success exit_code=exited exit_status=0`,
    ].join('\n');
    const reconcile = vi.fn();
    const d = Object.assign(progressDeps('dead'), {
      readQualificationRunLog: vi.fn(async () => log),
      reconcileTerminalNoVerdict: reconcile,
    });

    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: ['papercusp'], deduped: [], failed: [] });
    expect(reconcile).not.toHaveBeenCalled();
    expect(row.retries).toBe(1);
    expect(d.broadcast).toHaveBeenCalledTimes(1);
  });

  it('reports reconciliation refusal as terminal no-verdict and still does not retry', async () => {
    const tx = qualification();
    tx.runId = 'run-1';
    tx.currentPhysicalRunner = {
      ...tx.currentPhysicalRunner!,
      unit: 'papercup-green-checkpoint-scheduled-run-1.service',
      evidenceRefs: ['gate-fire:runner-1', 'checkpoint-run:run-1'],
    };
    const { sql, row } = fakeRoutineRow(null, tx);
    const log = [
      `${GREEN_CHECKPOINT_RESULT_MARKER} ${JSON.stringify({
        runId: 'run-1', candidate: 'candidate-1', reason: 'repair-in-progress', advanced: false,
      })}`,
      `${GREEN_CHECKPOINT_SYSTEMD_TERMINAL_MARKER} service_result=success exit_code=exited exit_status=0`,
    ].join('\n');
    const d = Object.assign(progressDeps('dead'), {
      readQualificationRunLog: vi.fn(async () => log),
      reconcileTerminalNoVerdict: vi.fn(async () => ({ status: 'conflict' as const, transaction: tx })),
    });

    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: ['papercusp'], deduped: [], failed: [] });
    expect(row.retries).toBe(0);
    expect(d.broadcast.mock.calls[0]![0].summary).toContain('ended without a verdict');
    expect(d.broadcast.mock.calls[0]![0].body).toContain("terminal no-verdict reason 'repair-in-progress'");
    expect(d.broadcast.mock.calls[0]![0].body).toContain("reconciliation returned 'conflict'");
    expect(d.broadcast.mock.calls[0]![0].body).not.toContain('proved dead without a terminal verdict');
    expect(d.broadcast.mock.calls[0]![0].route.reason).toContain('ended with a terminal no-verdict result');
  });

  it('requeues a run-bound clean superseded red round without paging it as a lost runner', async () => {
    const candidate = 'a1b2c3d4'.repeat(5);
    const tx = qualification(NOW - 60_000);
    tx.candidate = candidate;
    tx.runId = 'run-superseded-1';
    tx.currentPhysicalRunner = {
      ...tx.currentPhysicalRunner!, candidate, phase: 'finalizing',
      unit: 'papercup-green-checkpoint-manual-run.service',
      evidenceRefs: ['gate-fire:runner-1', 'checkpoint-run:run-superseded-1'],
    };
    const { sql, row } = fakeRoutineRow(null, tx);
    const log = [
      `FROZEN_REPAIR_VERDICT_SUPERSEDED: red at ${candidate.slice(0, 8)} recorded as round 1 at that head`,
      `${GREEN_CHECKPOINT_RESULT_MARKER} ${JSON.stringify({
        runId: 'run-superseded-1', candidate, reason: 'not-green', green: false,
      })}`,
      '__GREEN_CHECKPOINT_SYSTEMD_TERMINAL__ service_result=success exit_code=exited exit_status=0',
    ].join('\n');
    const reconcile = vi.fn(async () => {
      const waiting: CheckpointQualificationTransaction = {
        ...tx, phase: 'waiting', currentPhysicalRunner: null,
        outcome: { kind: 'pre-suite-no-verdict', reason: 'repair-in-progress' },
      };
      row.qualification = waiting;
      return { status: 'updated', transaction: waiting };
    });
    const d = Object.assign(progressDeps('dead'), {
      readQualificationRunLog: vi.fn(async () => log),
      reconcileSupersededRun: reconcile,
    });

    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: [], deduped: [], failed: [] });
    expect(d.readQualificationRunLog).toHaveBeenCalledWith(tx.currentPhysicalRunner);
    expect(row.retries).toBe(1);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ installSlug: 'papercusp' }), {
      attemptId: 'attempt-1', runnerId: 'runner-1', runId: 'run-superseded-1', candidate, round: 1, nowMs: NOW,
    });
    expect(d.broadcast).not.toHaveBeenCalled();
    await sweepLostGateRuns(sql, d);
    expect(d.broadcast).not.toHaveBeenCalled();
  });

  it('releases an undelivered stale-progress alarm for the next pass to retry', async () => {
    const { sql, row } = fakeRoutineRow(null, qualification());
    const d = Object.assign(progressDeps('unknown'), { broadcast: vi.fn(async () => false) });
    await expect(sweepLostGateRuns(sql, d)).resolves.toMatchObject({ failed: ['papercusp'] });
    expect(row.progressAlarmKey).toBeNull();
    const retry = progressDeps('unknown');
    await sweepLostGateRuns(sql, retry);
    expect(retry.broadcast).toHaveBeenCalledTimes(1);
  });

  it('fails closed for malformed qualification metadata', async () => {
    const { sql } = fakeRoutineRow(null, { currentPhysicalRunner: { id: 'unproven' } });
    const d = progressDeps('dead');
    await sweepLostGateRuns(sql, d);
    expect(d.broadcast).not.toHaveBeenCalled();
    expect(d.probeQualificationRunner).not.toHaveBeenCalled();
  });
});

describe('lost-run sweep wiring (R-5: within 10 minutes of the death)', () => {
  it('the sweep cadence leaves the 10-minute bound with margin', () => {
    expect(LOST_RUN_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('startGreenStallWatchdog runs the sweep at boot and on its own timer', () => {
    const src = readFileSync(join(__dirname, 'green-stall-watchdog.ts'), 'utf8');
    const starter = src.slice(src.indexOf('export function startGreenStallWatchdog('));
    expect(starter).toMatch(/sweepLostGateRuns\(sql\)/);
    expect(starter).toMatch(/sweepLostRuns\(\);/);
    expect(starter).toMatch(
      /managedSetInterval\(\s*'green-checkpoint-lost-run-alarm',\s*opts\.lostRunIntervalMs \?\? LOST_RUN_SWEEP_INTERVAL_MS,\s*sweepLostRuns/,
    );
  });
});

describe('claimLostRunAlarm executor stamp (gate-repair-plane-on-current-build-2026-10-15 R-1)', () => {
  const target = { installSlug: 'papercusp', workspaceId: 'papercusp-workspace' };
  const bgHost: RepairLimbExecutor = {
    hostId: 'port-3271',
    processId: 'pid-4242',
    executingBuild: { sha: 'a1b2c3d4e5f6', source: 'baked' },
  };

  it('stamps the winning alarm with the claiming host, process and executing build', async () => {
    const { row, sql } = fakeRoutineRow(marker());
    expect(await claimLostRunAlarm(sql, target, 'run-1', NOW, bgHost)).toBe(true);
    expect(row.stamps.alarmKey).toEqual(bgHost);

    // A second executor racing on the SAME key loses and cannot overwrite the winner's stamp.
    const other: RepairLimbExecutor = { ...bgHost, hostId: 'port-3070', processId: 'pid-7' };
    expect(await claimLostRunAlarm(sql, target, 'run-1', NOW + 1, other)).toBe(false);
    expect(row.stamps.alarmKey).toEqual(bgHost);

    // The progress alarm is stamped on its own field, by whoever claims it.
    expect(
      await claimLostRunAlarm(sql, { ...target, alarmField: 'qualificationProgressAlarm' }, 'q-1', NOW, other),
    ).toBe(true);
    expect(row.stamps.progressAlarmKey).toEqual(other);
    expect(row.stamps.alarmKey).toEqual(bgHost);
  });

  it("defaults the stamp to THIS process's executor, never a git read", async () => {
    const { row, sql } = fakeRoutineRow(marker());
    expect(await claimLostRunAlarm(sql, target, 'run-2', NOW)).toBe(true);
    expect(row.stamps.alarmKey).toEqual(currentRepairLimbExecutor());
  });
});
