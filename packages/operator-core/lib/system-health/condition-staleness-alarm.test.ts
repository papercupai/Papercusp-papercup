import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateStaleConditions,
  runConditionStalenessTick,
  selectReconcilableConditions,
  selectAbsentConditions,
  readInfraLivenessHealthFromSharedSnapshot,
  hasFreshSuccessfulGitSyncCompletion,
  verifiedGitSyncHealth,
  gitSyncMissedIntervalsAlarmActive,
  selectDeadOneShotConditions,
  toBridgeConditionStates,
  _resetConditionStalenessDebounce,
  reportConditionStalenessTick,
  formatConditionStalenessFailures,
} from './condition-staleness-alarm';
import type { ConditionStalenessTickResult } from './condition-staleness-alarm';
import type { ConditionState } from '../agent-tools/coordination/tools/conditions';
import type { EscalationRecord } from '../agent-tools/coordination/escalations';
import { PANEL_ORDER } from './types';
import type { HealthPanel, SystemHealth } from './types';

function mkState(over: Partial<ConditionState> = {}): ConditionState {
  return {
    condition_key: 'git-sync-stall:papercusp',
    open: true,
    from: 'system-watchdog',
    category: 'severe-event',
    first_seen: '2026-07-05T00:00:00.000Z',
    open_since: '2026-07-05T00:00:00.000Z',
    last_seen: '2026-07-05T00:00:00.000Z',
    alarm_count: 1,
    latest_summary: 'git-sync stalled',
    latest_body: null,
    resolved_at: null,
    resolved_summary: null,
    ...over,
  };
}

function mkHealthySystemHealth(): SystemHealth {
  const panels = Object.fromEntries(
    PANEL_ORDER.map((key) => [
      key,
      { key, label: key, status: 'ok', summary: 'ok', metrics: [], data: null } satisfies HealthPanel<unknown>,
    ]),
  ) as unknown as SystemHealth['panels'];
  return {
    workspaceId: 'ws-shared',
    evaluatedAt: Date.now(),
    overall: 'ok',
    crossMonitor: { queenAlive: true, overwatchAlive: null },
    panels,
  };
}

describe('git-sync recovery verification', () => {
  const now = Date.parse('2026-09-23T07:00:00.000Z');
  const fresh = { status: 'fresh', age_ms: 30_000, stale_after_ms: 9 * 60_000 };
  const liveEngine = { stale: false, unknown: false };

  it('only verifies a recent whole-fire success', () => {
    const activity = {
      active: false,
      phase: 'complete',
      completed_at: now - 20_000,
      outcome_status: 'synced',
    };
    expect(hasFreshSuccessfulGitSyncCompletion(activity, fresh, now)).toBe(true);
    expect(verifiedGitSyncHealth({ stalled: false }, liveEngine, true)).toBe(true);
  });

  it('does not clear a stall from an in-flight fire and an old local-sync receipt', () => {
    const activity = {
      active: true,
      phase: 'local-sync',
      completed_at: null,
      outcome_status: null,
    };
    const staleReceipt = {
      status: 'degraded',
      age_ms: 57 * 60_000,
      stale_after_ms: 9 * 60_000,
    };
    const freshProof = hasFreshSuccessfulGitSyncCompletion(activity, staleReceipt, now);
    expect(freshProof).toBe(false);
    expect(verifiedGitSyncHealth({ stalled: false }, liveEngine, freshProof)).toBeUndefined();
  });

  it('does not treat skipped or failed outcomes as recovery even when an older receipt is fresh', () => {
    const skipped = {
      active: false,
      phase: 'complete',
      completed_at: now - 20_000,
      outcome_status: 'skipped-locked',
    };
    expect(hasFreshSuccessfulGitSyncCompletion(skipped, fresh, now)).toBe(false);
  });

  it('keeps a stalled watchdog verdict unhealthy after a fresh successful completion', () => {
    const activity = {
      active: false,
      phase: 'complete',
      completed_at: now - 20_000,
      outcome_status: 'nothing',
    };
    expect(hasFreshSuccessfulGitSyncCompletion(activity, fresh, now)).toBe(true);
    expect(verifiedGitSyncHealth({ stalled: true }, liveEngine, true)).toBe(false);
  });
});

describe('readInfraLivenessHealthFromSharedSnapshot', () => {
  const key = 'infra-liveness:panel:overwatch';

  it('maps a fresh shared snapshot without invoking any local health aggregation', async () => {
    let healthReads = 0;
    const result = await readInfraLivenessHealthFromSharedSnapshot([key], {
      workspaceId: () => 'ws-shared',
      readHealth: async () => {
        healthReads += 1;
        return mkHealthySystemHealth();
      },
      readBeesLiveness: async () => undefined,
    });

    expect(healthReads).toBe(1);
    expect(result).toEqual(new Map([[key, true]]));
  });

  it('treats a missing shared snapshot as unknown and never false-clears a key', async () => {
    let beesReads = 0;
    const result = await readInfraLivenessHealthFromSharedSnapshot([key], {
      workspaceId: () => 'ws-shared',
      readHealth: async () => null,
      readBeesLiveness: async () => {
        beesReads += 1;
        return undefined;
      },
    });

    expect(result).toEqual(new Map());
    expect(beesReads).toBe(0);
  });

  // EI-22175580395708679: `readSharedSystemHealthSnapshot` itself accepts a row up
  // to several minutes old — too old to ground a "verified healthy RIGHT NOW"
  // claim used to auto-clear an open alarm. A snapshot that old must be treated
  // exactly like a MISSING one (unknown), never trusted as current.
  it('treats a shared snapshot older than the verify-freshness bar as unknown, never a false clear', async () => {
    const now = Date.parse('2026-09-02T18:31:00.000Z');
    const staleHealth = { ...mkHealthySystemHealth(), evaluatedAt: now - 5 * 60_000 }; // 5min old
    let beesReads = 0;
    const result = await readInfraLivenessHealthFromSharedSnapshot([key], {
      workspaceId: () => 'ws-shared',
      readHealth: async () => staleHealth,
      readBeesLiveness: async () => {
        beesReads += 1;
        return undefined;
      },
      now: () => now,
    });

    expect(result).toEqual(new Map());
    // The staleness gate must reject the snapshot BEFORE the bees-liveness read
    // (and therefore before evaluateLivenessAlarm) ever runs.
    expect(beesReads).toBe(0);
  });

  it('still trusts a snapshot comfortably inside the verify-freshness bar', async () => {
    const now = Date.parse('2026-09-02T18:31:00.000Z');
    const freshHealth = { ...mkHealthySystemHealth(), evaluatedAt: now - 10_000 }; // 10s old
    const result = await readInfraLivenessHealthFromSharedSnapshot([key], {
      workspaceId: () => 'ws-shared',
      readHealth: async () => freshHealth,
      readBeesLiveness: async () => undefined,
      now: () => now,
    });

    expect(result).toEqual(new Map([[key, true]]));
  });

  it('CONTROL: threads the real snapshot age into evaluateLivenessAlarm, not a hardcoded null', async () => {
    // Regression guard for the actual defect: previously this call passed `null`
    // for snapshotAgeMs unconditionally, which evaluateLivenessAlarm reads as
    // "computed fresh this tick" and therefore disables ITS OWN tick-stale
    // suppression — masking exactly the kind of stale-cache read this file's
    // own health-tick-stale signal exists to catch. A snapshot just OUTSIDE this
    // reconciler's tighter verify bar but still comfortably inside
    // liveness-alarm's own (looser) tick-stale bar exercises this: the fix's
    // explicit gate must reject it before evaluateLivenessAlarm is ever called.
    const now = Date.parse('2026-09-02T18:31:00.000Z');
    const justOverVerifyBar = { ...mkHealthySystemHealth(), evaluatedAt: now - 91_000 }; // 91s old
    let evaluated = false;
    const result = await readInfraLivenessHealthFromSharedSnapshot([key], {
      workspaceId: () => 'ws-shared',
      readHealth: async () => justOverVerifyBar,
      readBeesLiveness: async () => {
        evaluated = true;
        return undefined;
      },
      now: () => now,
    });

    expect(result).toEqual(new Map());
    expect(evaluated).toBe(false);
  });
});

describe('verifiedGitSyncHealth', () => {
  it('keeps a stale routine-engine verdict unknown instead of treating suppressed alarms as healthy', () => {
    expect(
      verifiedGitSyncHealth(
        { stalled: false },
        { stale: true, unknown: false },
        true,
      ),
    ).toBeUndefined();
  });

  it('keeps an unreadable routine-engine verdict unknown', () => {
    expect(
      verifiedGitSyncHealth(
        { stalled: false },
        { stale: false, unknown: true },
        true,
      ),
    ).toBeUndefined();
  });

  it('returns the stall verdict only when routine-engine liveness and completion proof are current', () => {
    expect(verifiedGitSyncHealth({ stalled: false }, { stale: false, unknown: false }, true)).toBe(true);
    expect(verifiedGitSyncHealth({ stalled: true }, { stale: false, unknown: false }, true)).toBe(false);
    expect(verifiedGitSyncHealth({ stalled: false }, { stale: false, unknown: false }, false)).toBeUndefined();
  });
});

describe('gitSyncMissedIntervalsAlarmActive', () => {
  it('matches the inclusive source alarm threshold and in-flight exclusions from writer-backed routine data', () => {
    const routineFreshness = {
      missed_intervals: 4,
      scheduler: { stalled_behind_in_flight_fire: false },
      execution: { status: 'idle' },
    };
    expect(gitSyncMissedIntervalsAlarmActive(routineFreshness, 'nothing', null)).toBe(true);
    expect(gitSyncMissedIntervalsAlarmActive({ ...routineFreshness, missed_intervals: 3 }, 'nothing', null)).toBe(true);
    expect(gitSyncMissedIntervalsAlarmActive({ ...routineFreshness, missed_intervals: 2 }, 'nothing', null)).toBe(false);
    expect(gitSyncMissedIntervalsAlarmActive(routineFreshness, 'error', null)).toBe(false);
    expect(gitSyncMissedIntervalsAlarmActive(routineFreshness, 'skipped', 'no_path')).toBe(false);
    expect(
      gitSyncMissedIntervalsAlarmActive({
        ...routineFreshness,
        missed_intervals: 3,
        scheduler: { stalled_behind_in_flight_fire: true },
        execution: { status: 'in-flight' },
      }, 'nothing', null),
    ).toBe(false);
    expect(
      gitSyncMissedIntervalsAlarmActive({
        ...routineFreshness,
        missed_intervals: 3,
        scheduler: { stalled_behind_in_flight_fire: true },
        execution: { status: 'stuck' },
      }, 'nothing', null),
    ).toBe(true);
    expect(gitSyncMissedIntervalsAlarmActive({ missed_intervals: null }, 'nothing', null)).toBeUndefined();
  });
});

describe('evaluateStaleConditions (pure)', () => {
  it('an OPEN condition younger than staleMs → no signal', () => {
    const now = Date.parse('2026-07-05T00:10:00.000Z'); // 10min old
    expect(evaluateStaleConditions([mkState()], now, 45 * 60_000)).toEqual([]);
  });

  it('an OPEN condition older than staleMs → one stale-condition signal, keyed by condition_key', () => {
    const now = Date.parse('2026-07-05T01:00:00.000Z'); // 60min old
    const sigs = evaluateStaleConditions([mkState()], now, 45 * 60_000);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].key).toBe('stale-condition:git-sync-stall:papercusp');
    expect(sigs[0].conditionKey).toBe('git-sync-stall:papercusp');
    expect(sigs[0].severity).toBe('advisory');
    expect(sigs[0].summary).toContain('60m');
    expect(sigs[0].summary).toContain('git-sync stalled');
  });

  it('EI-10653: a FLAPPING condition freshly reopened is judged by open_since, not first_seen', () => {
    // first alarm 1967m ago (the reported symptom), but it recovered many times
    // and only reopened 3m ago → open_since is recent → NOT stuck-open.
    const now = Date.parse('2026-07-05T00:00:00.000Z');
    const flapping = mkState({
      condition_key: 'infra-liveness:panel:infra',
      first_seen: new Date(now - 1967 * 60_000).toISOString(),
      open_since: new Date(now - 3 * 60_000).toISOString(),
      last_seen: new Date(now - 3 * 60_000).toISOString(),
      resolved_at: new Date(now - 8 * 60_000).toISOString(),
      alarm_count: 40,
    });
    // Anchoring on open_since (3m) → below the 45m stale bar → no reminder.
    expect(evaluateStaleConditions([flapping], now, 45 * 60_000)).toEqual([]);
    // Anchoring on the OLD first_seen would (wrongly) have fired — pin that the
    // regression is real: same state, but if we pretend open_since == first_seen
    // it does trip the bar.
    expect(
      evaluateStaleConditions([mkState({ ...flapping, open_since: flapping.first_seen })], now, 45 * 60_000),
    ).toHaveLength(1);
  });

  it('EI-10653: a genuinely-stuck (never-recovered) condition still fires — open_since == first_seen', () => {
    const now = Date.parse('2026-07-05T01:00:00.000Z'); // 60min continuously open
    const stuck = mkState({
      first_seen: '2026-07-05T00:00:00.000Z',
      open_since: '2026-07-05T00:00:00.000Z',
      last_seen: '2026-07-05T00:00:00.000Z',
      resolved_at: null,
    });
    expect(evaluateStaleConditions([stuck], now, 45 * 60_000)).toHaveLength(1);
  });

  it('a RESOLVED condition never fires, regardless of age', () => {
    const now = Date.parse('2026-07-06T00:00:00.000Z'); // 1 day old
    const sigs = evaluateStaleConditions(
      [mkState({ open: false, resolved_at: '2026-07-05T00:05:00.000Z' })],
      now,
      45 * 60_000,
    );
    expect(sigs).toEqual([]);
  });

  it('an unparseable open-episode anchor is skipped rather than throwing', () => {
    const now = Date.parse('2026-07-05T01:00:00.000Z');
    // The age anchor is now open_since (EI-10653); an unparseable one is skipped.
    const bad = mkState({ open_since: 'not-a-date' });
    expect(() => evaluateStaleConditions([bad], now, 0)).not.toThrow();
    expect(evaluateStaleConditions([bad], now, 0)).toEqual([]);
    // Fallback path: open_since null → first_seen used; an unparseable one is skipped too.
    const badFallback = mkState({ open_since: null, first_seen: 'not-a-date' });
    expect(evaluateStaleConditions([badFallback], now, 0)).toEqual([]);
  });

  it('multiple stale conditions each get their own signal', () => {
    const now = Date.parse('2026-07-05T01:00:00.000Z');
    const sigs = evaluateStaleConditions(
      [mkState({ condition_key: 'a' }), mkState({ condition_key: 'b' })],
      now,
      45 * 60_000,
    );
    expect(sigs.map((s) => s.conditionKey).sort()).toEqual(['a', 'b']);
  });

  it('EI-15182: an OPEN+stale condition whose last_seen has also gone SIGNAL-ABSENT never fires — regardless of family', () => {
    // first_seen/open_since/last_seen all pinned to the same very-old instant:
    // stuck open per staleMs (60min > 45min), AND last_seen is 60min old —
    // beyond a 45min absenceMs — so nobody has re-observed this signal recently.
    const now = Date.parse('2026-07-05T01:00:00.000Z');
    const goneQuiet = mkState({ condition_key: 'git-sync-stall:dummy-pot-0707' });
    expect(evaluateStaleConditions([goneQuiet], now, 45 * 60_000, 45 * 60_000)).toEqual([]);
  });

  it('EI-15182: an OPEN+stale condition with a RECENT last_seen still fires (absenceMs alone does not suppress an actively-observed signal)', () => {
    const now = Date.parse('2026-07-05T01:00:00.000Z'); // 60min since open_since
    const activelyFiring = mkState({
      condition_key: 'embed-exhaustion:openai_billing',
      last_seen: new Date(now - 60_000).toISOString(), // re-alarmed 1min ago
    });
    // staleMs=45min (still stuck open), absenceMs=90min (last_seen 1min old, well within it).
    const sigs = evaluateStaleConditions([activelyFiring], now, 45 * 60_000, 90 * 60_000);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].conditionKey).toBe('embed-exhaustion:openai_billing');
  });
});

describe('selectAbsentConditions (pure — EI-15182 guard #3, family-agnostic)', () => {
  it('an OPEN condition whose last_seen exceeds absenceMs is absent', () => {
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const states = [
      mkState({ condition_key: 'single-primary:split-brain-primary', last_seen: '2026-07-11T02:13:00.000Z' }),
    ];
    expect(selectAbsentConditions(states, now, 2 * 60 * 60_000)).toEqual(['single-primary:split-brain-primary']);
  });

  it('an OPEN condition whose last_seen is within absenceMs is NOT absent', () => {
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const states = [mkState({ last_seen: new Date(now - 30 * 60_000).toISOString() })];
    expect(selectAbsentConditions(states, now, 2 * 60 * 60_000)).toEqual([]);
  });

  it('WI-6228: a ONE-SHOT condition is NEVER absent, however long its last_seen has been frozen', () => {
    // The regression this guards. A one-shot emitter (`if (alerted) continue`)
    // broadcasts once and stays deliberately silent while the condition remains
    // continuously true, so `last_seen` freezing carries NO information about
    // recovery. Resolving it by absence is a false green — and, unlike a
    // coalescing race, it is GUARANTEED for any one-shot condition outlasting
    // absenceMs. Without the one_shot check this returns the key and fails.
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const states = [
      mkState({
        condition_key: 'origin-freshness:papercusp',
        last_seen: '2026-07-11T02:13:00.000Z', // ~6 days frozen
        one_shot: true,
      }),
    ];
    expect(selectAbsentConditions(states, now, 2 * 60 * 60_000)).toEqual([]);
  });

  it('WI-6228: replays the real incident — the single alarm is NOT auto-resolved at the 120m mark', () => {
    // Measured timeline, 2026-07-26 fleet-wide git egress freeze:
    //   21:13:41Z  the one and only origin-freshness:papercusp alarm
    //   23:13:48Z  reconciler auto-resolved it (120m+7s later, to the second)
    //   23:39:42Z  origin actually recovered — 26min AFTER the false green
    // At the moment of the false green the outage was live and worsening.
    const alarmedAt = '2026-07-26T21:13:41.000Z';
    const falselyResolvedAt = Date.parse('2026-07-26T23:13:48.000Z');
    const stillFrozen = mkState({
      condition_key: 'origin-freshness:papercusp',
      first_seen: alarmedAt,
      open_since: alarmedAt,
      last_seen: alarmedAt,
      one_shot: true,
    });
    expect(falselyResolvedAt - Date.parse(alarmedAt)).toBeGreaterThan(2 * 60 * 60_000); // absence window HAD elapsed
    expect(selectAbsentConditions([stillFrozen], falselyResolvedAt, 2 * 60 * 60_000)).toEqual([]);
  });

  it('WI-6228: a NON-one-shot condition is still resolved by absence (EI-15182 is preserved, not weakened)', () => {
    // The dead/quiet-pot case guard #3 exists for must keep working: an emitter
    // that re-alarms every sweep and has gone quiet really has stopped observing.
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const reAlarming = mkState({
      condition_key: 'git-sync-stall:dummy-pot-0707',
      last_seen: '2026-07-11T02:13:00.000Z',
      one_shot: false,
    });
    const undeclared = mkState({
      condition_key: 'single-primary:split-brain-primary',
      last_seen: '2026-07-11T02:13:00.000Z',
    }); // legacy emitter, never declared — unchanged behaviour
    expect(selectAbsentConditions([reAlarming, undeclared], now, 2 * 60 * 60_000)).toEqual([
      'git-sync-stall:dummy-pot-0707',
      'single-primary:split-brain-primary',
    ]);
  });

  it('an already-RESOLVED condition is never flagged absent, even with an ancient last_seen', () => {
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const states = [
      mkState({ open: false, resolved_at: '2026-07-11T00:00:00.000Z', last_seen: '2026-07-11T00:00:00.000Z' }),
    ];
    expect(selectAbsentConditions(states, now, 2 * 60 * 60_000)).toEqual([]);
  });

  it('covers every family — not just infra-liveness', () => {
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const stale = '2026-07-11T00:10:00.000Z';
    const states = [
      mkState({ condition_key: 'git-sync-stall:dummy-pot-0707', last_seen: stale, open_since: stale, first_seen: stale }),
      mkState({ condition_key: 'git-sync-stall:quartermaster-hive', last_seen: stale, open_since: stale, first_seen: stale }),
      mkState({ condition_key: 'embed-exhaustion:daily_cap', last_seen: stale, open_since: stale, first_seen: stale }),
      mkState({ condition_key: 'infra-liveness:pg-restarted', last_seen: stale, open_since: stale, first_seen: stale }),
    ];
    expect(selectAbsentConditions(states, now, 2 * 60 * 60_000).sort()).toEqual([
      'embed-exhaustion:daily_cap',
      'git-sync-stall:dummy-pot-0707',
      'git-sync-stall:quartermaster-hive',
      'infra-liveness:pg-restarted',
    ]);
  });
});

describe('selectDeadOneShotConditions (WI-6554700010016120)', () => {
  const emitter = {
    pid: 4242,
    startedAt: '2026-07-17T19:00:00.000Z',
    uptimeSec: 60,
    cwd: '/repo',
    host: 'host-a',
    processIdentity: 'linux:boot:4242',
  };

  it('selects only open one-shot conditions with a positive dead probe', () => {
    const states = [
      mkState({ condition_key: 'origin-freshness:papercusp', one_shot: true, latest_emitter: emitter }),
      mkState({ condition_key: 'origin-freshness:other', one_shot: true, latest_emitter: emitter }),
      mkState({ condition_key: 'git-sync-stall:papercusp', one_shot: false, latest_emitter: emitter }),
      mkState({ condition_key: 'origin-freshness:closed', one_shot: true, latest_emitter: emitter, open: false }),
    ];
    expect(
      selectDeadOneShotConditions(states, new Map([
        ['origin-freshness:papercusp', 'dead'],
        ['origin-freshness:other', 'alive'],
        ['git-sync-stall:papercusp', 'dead'],
        ['origin-freshness:closed', 'dead'],
      ])),
    ).toEqual(['origin-freshness:papercusp']);
  });

  it('leaves alive and unknown emitters open', () => {
    const state = mkState({
      condition_key: 'origin-freshness:papercusp',
      one_shot: true,
      latest_emitter: emitter,
    });
    expect(selectDeadOneShotConditions([state], new Map([['origin-freshness:papercusp', 'unknown']]))).toEqual([]);
  });

  it('does not resolve a degraded one-shot condition from emitter death alone', () => {
    const state = mkState({
      condition_key: 'degraded:retrieval:mixed',
      one_shot: true,
      latest_emitter: emitter,
    });
    expect(selectDeadOneShotConditions([state], new Map([['degraded:retrieval:mixed', 'dead']]))).toEqual([]);
  });

  // EI-27231825178306204: the leg router runs inside the gate's per-RUN process, so its
  // stamped emitter is dead after every run while the leg is still failing.
  it('does not resolve a frozen-repair-leg condition from its gate run exiting, but still resolves an ordinary one-shot', () => {
    const leg = 'frozen-repair-leg:papercusp:lint:mock-cast-escape';
    const ordinary = 'origin-freshness:papercusp';
    const states = [
      mkState({ condition_key: leg, one_shot: true, latest_emitter: emitter }),
      mkState({ condition_key: ordinary, one_shot: true, latest_emitter: emitter }),
    ];
    expect(
      selectDeadOneShotConditions(states, new Map([[leg, 'dead'], [ordinary, 'dead']])),
    ).toEqual([ordinary]);
  });
});

describe('runConditionStalenessTick — one-shot emitter death reconciliation', () => {
  it('broadcasts a durable resolution only after a positive dead-emitter probe', async () => {
    const now = Date.parse('2026-10-16T19:00:00.000Z');
    const key = 'origin-freshness:papercusp';
    const broadcasts: string[][] = [];
    const state = mkState({
      condition_key: key,
      one_shot: true,
      latest_emitter: {
        pid: 4242,
        startedAt: '2026-10-16T17:00:00.000Z',
        uptimeSec: 60,
        cwd: '/repo',
        host: 'host-a',
        processIdentity: 'linux:boot:4242',
      },
      last_seen: '2026-10-16T17:30:00.000Z',
    });
    const result = await runConditionStalenessTick({
      readStates: async () => [state],
      probeEmitter: () => 'dead',
      readHealthByKey: async () => new Map(),
      readGitSyncHealthByKey: async () => new Map(),
      broadcastResolvedMany: async ({ conditionKeys }) => {
        broadcasts.push(conditionKeys);
        return true;
      },
      listOpen: async () => [],
      resolve: async () => undefined,
      escalate: async () => { throw new Error('dead one-shot must not be escalated'); },
      now: () => now,
      staleMs: 45 * 60_000,
      absenceMs: 2 * 60 * 60_000,
    });
    expect(result.reconciled).toEqual([key]);
    expect(broadcasts).toEqual([[key]]);
    expect(result.fired).toEqual([]);
  });

  it('does not resolve a one-shot condition when emitter liveness is unknown', async () => {
    const key = 'origin-freshness:papercusp';
    const state = mkState({
      condition_key: key,
      one_shot: true,
      latest_emitter: {
        pid: 4242,
        startedAt: '2026-10-16T17:00:00.000Z',
        uptimeSec: 60,
        cwd: '/repo',
        host: 'host-a',
        processIdentity: 'linux:boot:4242',
      },
    });
    const broadcasts: string[][] = [];
    const result = await runConditionStalenessTick({
      readStates: async () => [state],
      probeEmitter: () => 'unknown',
      readHealthByKey: async () => new Map(),
      readGitSyncHealthByKey: async () => new Map(),
      broadcastResolvedMany: async ({ conditionKeys }) => {
        broadcasts.push(conditionKeys);
        return true;
      },
      listOpen: async () => [],
      resolve: async () => undefined,
      escalate: async () => undefined,
      now: () => Date.parse('2026-10-16T19:00:00.000Z'),
      staleMs: 45 * 60_000,
      absenceMs: 2 * 60 * 60_000,
    });
    expect(result.reconciled).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('keeps a degraded one-shot condition open until metric recovery is emitted', async () => {
    const key = 'degraded:retrieval:mixed';
    const state = mkState({
      condition_key: key,
      one_shot: true,
      latest_emitter: {
        pid: 4242,
        startedAt: '2026-10-16T17:00:00.000Z',
        uptimeSec: 60,
        cwd: '/repo',
        host: 'host-a',
        processIdentity: 'linux:boot:4242',
      },
      last_seen: '2026-10-16T17:30:00.000Z',
    });
    const broadcasts: string[][] = [];
    const result = await runConditionStalenessTick({
      readStates: async () => [state],
      probeEmitter: () => 'dead',
      readHealthByKey: async () => new Map(),
      readGitSyncHealthByKey: async () => new Map(),
      broadcastResolvedMany: async ({ conditionKeys }) => {
        broadcasts.push(conditionKeys);
        return true;
      },
      listOpen: async () => [],
      resolve: async () => undefined,
      escalate: async () => undefined,
      now: () => Date.parse('2026-10-16T19:00:00.000Z'),
      staleMs: 45 * 60_000,
      absenceMs: 2 * 60 * 60_000,
    });
    expect(result.reconciled).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('keeps a still-failing frozen-repair-leg condition open after the gate run that opened it exits (EI-27231825178306204)', async () => {
    const leg = 'frozen-repair-leg:papercusp:lint:condition-rail';
    const ordinary = 'origin-freshness:papercusp';
    const gateRun = {
      pid: 2668804,
      startedAt: '2026-10-28T12:33:00.000Z',
      uptimeSec: 60,
      cwd: '/repo',
      host: 'host-a',
      processIdentity: 'linux:boot:2668804',
    };
    const states = [
      mkState({ condition_key: leg, one_shot: true, latest_emitter: gateRun, last_seen: '2026-10-28T13:00:00.000Z' }),
      mkState({ condition_key: ordinary, one_shot: true, latest_emitter: gateRun, last_seen: '2026-10-28T13:00:00.000Z' }),
    ];
    const broadcasts: string[][] = [];
    const result = await runConditionStalenessTick({
      readStates: async () => states,
      probeEmitter: () => 'dead',
      readHealthByKey: async () => new Map(),
      readGitSyncHealthByKey: async () => new Map(),
      broadcastResolvedMany: async ({ conditionKeys }) => {
        broadcasts.push(conditionKeys);
        return true;
      },
      listOpen: async () => [],
      resolve: async () => undefined,
      escalate: async () => undefined,
      now: () => Date.parse('2026-10-28T13:52:28.000Z'),
      staleMs: 45 * 60_000,
      absenceMs: 2 * 60 * 60_000,
    });
    expect(result.reconciled).toEqual([ordinary]);
    expect(broadcasts).toEqual([[ordinary]]);
  });
});

describe('selectReconcilableConditions (pure — EI-14072 guard #2)', () => {
  it('an OPEN condition whose key is verified healthy (true) is reconcilable', () => {
    const states = [mkState({ condition_key: 'infra-liveness:panel:overwatch' })];
    const healthByKey = new Map([['infra-liveness:panel:overwatch', true]]);
    expect(selectReconcilableConditions(states, healthByKey)).toEqual(['infra-liveness:panel:overwatch']);
  });

  it('an OPEN condition verified UNhealthy (false) is left alone', () => {
    const states = [mkState({ condition_key: 'infra-liveness:panel:overwatch' })];
    const healthByKey = new Map([['infra-liveness:panel:overwatch', false]]);
    expect(selectReconcilableConditions(states, healthByKey)).toEqual([]);
  });

  it('an OPEN condition with NO health entry (unknown/unchecked family) is left alone — fail-open', () => {
    const states = [mkState({ condition_key: 'git-sync-stall:papercusp' })];
    expect(selectReconcilableConditions(states, new Map())).toEqual([]);
  });

  it('an already-RESOLVED condition is never reconciled, even if marked healthy', () => {
    const states = [mkState({ condition_key: 'infra-liveness:panel:overwatch', open: false, resolved_at: '2026-07-05T00:05:00.000Z' })];
    const healthByKey = new Map([['infra-liveness:panel:overwatch', true]]);
    expect(selectReconcilableConditions(states, healthByKey)).toEqual([]);
  });

  it('multiple open+healthy keys are all reconciled', () => {
    const states = [
      mkState({ condition_key: 'infra-liveness:panel:overwatch' }),
      mkState({ condition_key: 'infra-liveness:panel:bees' }),
      mkState({ condition_key: 'infra-liveness:dead-routines', open: false, resolved_at: 'x' }),
    ];
    const healthByKey = new Map([
      ['infra-liveness:panel:overwatch', true],
      ['infra-liveness:panel:bees', true],
      ['infra-liveness:dead-routines', true],
    ]);
    expect(selectReconcilableConditions(states, healthByKey).sort()).toEqual([
      'infra-liveness:panel:bees',
      'infra-liveness:panel:overwatch',
    ]);
  });
});

describe('runConditionStalenessTick — durable dedup + auto-resolve (mirrors liveness-alarm EI-2146 shape)', () => {
  beforeEach(() => _resetConditionStalenessDebounce());

  /** A minimal in-memory escalation store mirroring the append-only open/resolve log. */
  function makeStore() {
    const opens: EscalationRecord[] = [];
    const resolvedIds = new Set<string>();
    let seq = 0;
    return {
      escalate: async (input: { severity: string; summary: string; meta?: Record<string, unknown> }) => {
        seq += 1;
        opens.push({
          ts: new Date(seq * 1000).toISOString(),
          msg_id: `esc-${seq}`,
          from: 'system:condition-staleness-alarm',
          to: ['human'],
          kind: 'escalation',
          severity: input.severity,
          summary: input.summary,
          resolved: null,
          ...(input.meta ?? {}),
        } as unknown as EscalationRecord);
      },
      listOpen: async (): Promise<EscalationRecord[]> => opens.filter((e) => !resolvedIds.has(e.msg_id)),
      resolve: async (msg_id: string) => {
        resolvedIds.add(msg_id);
      },
      openCount: () => opens.filter((e) => !resolvedIds.has(e.msg_id)).length,
    };
  }

  it('(a) a repeat firing of the same signature opens NO second escalation — even across a worker restart', async () => {
    const store = makeStore();
    const stale = [mkState()];
    const deps = {
      readStates: async () => stale,
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      now: () => Date.parse('2026-07-05T01:00:00.000Z'),
      staleMs: 45 * 60_000,
      debounceMs: 30 * 60_000,
    };

    const first = await runConditionStalenessTick(deps);
    expect(first.fired.map((s) => s.key)).toEqual(['stale-condition:git-sync-stall:papercusp']);
    expect(store.openCount()).toBe(1);

    // Simulate a worker restart: in-memory debounce wiped. Durable dedup off the
    // open escalation log must still collapse the repeat — no second row.
    _resetConditionStalenessDebounce();
    const second = await runConditionStalenessTick(deps);
    expect(second.fired).toEqual([]);
    expect(store.openCount()).toBe(1);
  });

  it('(b) a condition that RESOLVES auto-resolves its open reminder, then re-fires only if it re-opens and goes stale again', async () => {
    const store = makeStore();
    let resolved = false;
    let now = Date.parse('2026-07-05T01:00:00.000Z');
    const deps = {
      readStates: async () => [resolved ? mkState({ open: false, resolved_at: '2026-07-05T00:30:00.000Z' }) : mkState()],
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      now: () => now,
      staleMs: 45 * 60_000,
      debounceMs: 30 * 60_000,
    };

    const t1 = await runConditionStalenessTick(deps);
    expect(t1.fired.map((s) => s.key)).toEqual(['stale-condition:git-sync-stall:papercusp']);
    expect(store.openCount()).toBe(1);

    resolved = true;
    now += 60_000;
    const t2 = await runConditionStalenessTick(deps);
    expect(t2.resolved.length).toBe(1);
    expect(store.openCount()).toBe(0);

    // Re-open + go stale again fires fresh, proving recovery cleared the cooldown.
    resolved = false;
    now += 60_000;
    const t3 = await runConditionStalenessTick(deps);
    expect(t3.fired.map((s) => s.key)).toEqual(['stale-condition:git-sync-stall:papercusp']);
    expect(store.openCount()).toBe(1);
  });

  it('a read failure degrades to a no-op tick, never throws', async () => {
    const deps = {
      readStates: async () => {
        throw new Error('db unavailable');
      },
    };
    await expect(runConditionStalenessTick(deps)).resolves.toEqual({
      fired: [],
      signals: [],
      resolved: [],
      reconciled: [],
      bridged: { acquired: [], released: [], skipped: 0 },
      heldOwnerSweep: { ran: false, released: 0, settled: 0, error: null },
      // EI-27066473667693647: the no-op is fail-soft, but the failure is RECORDED.
      failures: [{ stage: 'read-states', error: 'db unavailable' }],
    });
  });

  it('an escalate failure never crashes the tick (best-effort)', async () => {
    const deps = {
      readStates: async () => [mkState()],
      escalate: async () => {
        throw new Error('send failed');
      },
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      now: () => Date.parse('2026-07-05T01:00:00.000Z'),
      staleMs: 45 * 60_000,
    };
    const r = await runConditionStalenessTick(deps);
    // Still reported as a signal + a fire attempt, even though the send itself failed.
    expect(r.signals.map((s) => s.key)).toEqual(['stale-condition:git-sync-stall:papercusp']);
  });

  it('EI-14072 guard #2: an open+stale infra-liveness row with a VERIFIED-healthy signal is reconciled — broadcast fires, and it is NOT also flagged stale this same tick', async () => {
    const broadcasts: Array<{ conditionKeys: string[]; summary: string }> = [];
    const stuck = mkState({
      condition_key: 'infra-liveness:panel:overwatch',
      first_seen: '2026-07-05T00:00:00.000Z',
      open_since: '2026-07-05T00:00:00.000Z',
      last_seen: '2026-07-05T00:00:00.000Z',
    });
    const deps = {
      readStates: async () => [stuck],
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      escalate: async () => {
        throw new Error('escalate should NOT be called for a reconciled key');
      },
      now: () => Date.parse('2026-07-05T01:00:00.000Z'), // 60min open — would be stale
      staleMs: 45 * 60_000,
      readHealthByKey: async (keys: readonly string[]) =>
        new Map(keys.map((k) => [k, true])), // verified healthy
      broadcastResolvedMany: async (input: { conditionKeys: string[]; summary: string }) => {
        broadcasts.push(input);
        return true;
      },
    };
    const r = await runConditionStalenessTick(deps);
    expect(r.reconciled).toEqual(['infra-liveness:panel:overwatch']);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.conditionKeys).toEqual(['infra-liveness:panel:overwatch']);
    // The reconciled key must NOT also earn a staleness reminder in the same tick.
    expect(r.signals).toEqual([]);
    expect(r.fired).toEqual([]);
  });

  it('EI-14072 guard #2: an open+stale infra-liveness row whose signal is VERIFIED unhealthy is left open and still fires the staleness reminder', async () => {
    const stuck = mkState({
      condition_key: 'infra-liveness:panel:overwatch',
      first_seen: '2026-07-05T00:00:00.000Z',
      open_since: '2026-07-05T00:00:00.000Z',
      last_seen: '2026-07-05T00:00:00.000Z',
    });
    const escalated: string[] = [];
    const deps = {
      readStates: async () => [stuck],
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      escalate: async (input: { summary: string }) => {
        escalated.push(input.summary);
      },
      now: () => Date.parse('2026-07-05T01:00:00.000Z'),
      staleMs: 45 * 60_000,
      readHealthByKey: async (keys: readonly string[]) => new Map(keys.map((k) => [k, false])),
      broadcastResolvedMany: async () => {
        throw new Error('must not be called — nothing verified healthy');
      },
    };
    const r = await runConditionStalenessTick(deps);
    expect(r.reconciled).toEqual([]);
    expect(r.fired.map((s) => s.key)).toEqual(['stale-condition:infra-liveness:panel:overwatch']);
    expect(escalated).toHaveLength(1);
  });

  it('EI-14072 guard #2: a non-infra-liveness key is never passed to readHealthByKey (family-scoped)', async () => {
    const seenKeys: string[][] = [];
    const stuck = mkState({ condition_key: 'git-sync-stall:papercusp' });
    const deps = {
      readStates: async () => [stuck],
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      escalate: async () => {},
      now: () => Date.parse('2026-07-05T01:00:00.000Z'),
      staleMs: 45 * 60_000,
      readHealthByKey: async (keys: readonly string[]) => {
        seenKeys.push([...keys]);
        return new Map();
      },
    };
    await runConditionStalenessTick(deps);
    expect(seenKeys).toEqual([[]]);
  });

  it('does not false-clear a git-sync missed-interval condition at the inclusive source threshold', async () => {
    const now = Date.parse('2026-10-08T09:00:00.000Z');
    const key = 'infra-liveness:git-sync-missed-intervals:papercusp';
    const recentlyObserved = new Date(now - 30_000).toISOString();
    const condition = mkState({
      condition_key: key,
      first_seen: recentlyObserved,
      open_since: recentlyObserved,
      last_seen: recentlyObserved,
    });
    const snapshotKeys: string[][] = [];
    const routineReads: Array<{ keys: string[]; at: number }> = [];
    const broadcasts: string[][] = [];
    const deps = {
      readStates: async () => [condition],
      readHealthByKey: async (keys: readonly string[]) => {
        snapshotKeys.push([...keys]);
        return new Map(keys.map((requestedKey) => [requestedKey, true]));
      },
      readGitSyncHealthByKey: async (keys: readonly string[], at: number) => {
        routineReads.push({ keys: [...keys], at });
        const alarmActive = gitSyncMissedIntervalsAlarmActive(
          {
            missed_intervals: 3,
            scheduler: { stalled_behind_in_flight_fire: false },
            execution: { status: 'idle' },
          },
          'nothing',
          null,
        );
        return keys.includes(key) && alarmActive !== undefined
          ? new Map([[key, !alarmActive]])
          : new Map<string, boolean>();
      },
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      escalate: async () => {
        throw new Error('the fresh open condition is not stale');
      },
      now: () => now,
      staleMs: 45 * 60_000,
      absenceMs: 2 * 60 * 60_000,
      broadcastResolvedMany: async (input: { conditionKeys: string[] }) => {
        broadcasts.push(input.conditionKeys);
        return true;
      },
    };

    const result = await runConditionStalenessTick(deps);
    expect(snapshotKeys).toEqual([[]]);
    expect(routineReads).toEqual([{ keys: [key], at: now }]);
    expect(result.reconciled).toEqual([]);
    expect(broadcasts).toEqual([]);
    expect(result.fired).toEqual([]);
  });

  it('EI-211981: a recovered git-sync routine resolves its stale condition before the watchdog broadcast', async () => {
    const now = Date.parse('2026-08-22T23:30:00.000Z');
    const recovered = mkState({
      condition_key: 'git-sync-stall:papercusp',
      first_seen: '2026-08-22T23:26:16.000Z',
      open_since: '2026-08-22T23:26:16.000Z',
      // Keep the source observed recently so EI-15182 does not resolve this via
      // absence; this assertion is specifically the writer-backed health path.
      last_seen: '2026-08-22T23:29:00.000Z',
    });
    const seen: { keys: string[]; at: number }[] = [];
    const broadcasts: string[][] = [];
    const deps = {
      readStates: async () => [recovered],
      readHealthByKey: async (keys: readonly string[]) => {
        expect(keys).toEqual([]);
        return new Map<string, boolean>();
      },
      readGitSyncHealthByKey: async (keys: readonly string[], at: number) => {
        seen.push({ keys: [...keys], at });
        return new Map([['git-sync-stall:papercusp', true]]);
      },
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      escalate: async () => {
        throw new Error('a verified recovery must not be escalated as stale');
      },
      now: () => now,
      staleMs: 1,
      absenceMs: 2 * 60 * 60_000,
      broadcastResolvedMany: async (input: { conditionKeys: string[] }) => {
        broadcasts.push(input.conditionKeys);
        return true;
      },
    };

    const result = await runConditionStalenessTick(deps);
    expect(seen).toEqual([{ keys: ['git-sync-stall:papercusp'], at: now }]);
    expect(broadcasts).toEqual([['git-sync-stall:papercusp']]);
    expect(result.reconciled).toEqual(['git-sync-stall:papercusp']);
    expect(result.signals).toEqual([]);
    expect(result.fired).toEqual([]);
  });

  it('EI-211981: an unknown git-sync read leaves the condition open', async () => {
    const now = Date.parse('2026-08-22T23:30:00.000Z');
    const stuck = mkState({
      condition_key: 'git-sync-stall:papercusp',
      first_seen: '2026-08-22T23:26:16.000Z',
      open_since: '2026-08-22T23:26:16.000Z',
      last_seen: '2026-08-22T23:29:00.000Z',
    });
    const escalated: string[] = [];
    const deps = {
      readStates: async () => [stuck],
      readGitSyncHealthByKey: async () => new Map<string, boolean>(),
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      escalate: async (input: { summary: string }) => {
        escalated.push(input.summary);
      },
      now: () => now,
      staleMs: 1,
      absenceMs: 2 * 60 * 60_000,
      broadcastResolvedMany: async () => {
        throw new Error('unknown health must not resolve the condition');
      },
    };

    const result = await runConditionStalenessTick(deps);
    expect(result.reconciled).toEqual([]);
    expect(result.fired.map((signal) => signal.key)).toEqual(['stale-condition:git-sync-stall:papercusp']);
    expect(escalated).toHaveLength(1);
  });

  it('EI-15182 guard #3: a signal-absent condition of ANY family is auto-resolved (broadcast fires) and never flagged stale this same tick', async () => {
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const staleTs = '2026-07-11T00:10:00.000Z'; // ~6.8d old — the real dummy-pot-0707 evidence
    const goneQuiet = mkState({
      condition_key: 'git-sync-stall:dummy-pot-0707',
      first_seen: staleTs,
      open_since: staleTs,
      last_seen: staleTs,
    });
    const broadcasts: Array<{ conditionKeys: string[]; summary: string }> = [];
    const deps = {
      readStates: async () => [goneQuiet],
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      escalate: async () => {
        throw new Error('escalate should NOT be called for a signal-absent condition');
      },
      now: () => now,
      staleMs: 45 * 60_000,
      absenceMs: 2 * 60 * 60_000,
      readHealthByKey: async () => new Map<string, boolean>(), // git-sync-stall is not infra-liveness — never consulted
      broadcastResolvedMany: async (input: { conditionKeys: string[]; summary: string }) => {
        broadcasts.push(input);
        return true;
      },
    };
    const r = await runConditionStalenessTick(deps);
    expect(r.reconciled).toEqual(['git-sync-stall:dummy-pot-0707']);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.conditionKeys).toEqual(['git-sync-stall:dummy-pot-0707']);
    expect(r.signals).toEqual([]);
    expect(r.fired).toEqual([]);
  });

  it('EI-15182 guard #3: a signal-absent condition is suppressed EVEN when the reconcile broadcast fails (suppression never depends on the broadcast landing)', async () => {
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const staleTs = '2026-07-09T00:00:00.000Z';
    const goneQuiet = mkState({
      condition_key: 'embed-exhaustion:openai_billing',
      first_seen: staleTs,
      open_since: staleTs,
      last_seen: staleTs,
    });
    const deps = {
      readStates: async () => [goneQuiet],
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      escalate: async () => {
        throw new Error('escalate should NOT be called for a signal-absent condition');
      },
      now: () => now,
      staleMs: 45 * 60_000,
      absenceMs: 2 * 60 * 60_000,
      broadcastResolvedMany: async () => {
        throw new Error('broadcast fails — the durable resolve never lands this tick');
      },
    };
    const r = await runConditionStalenessTick(deps);
    // Not durably reconciled (the broadcast failed) but STILL never paged.
    expect(r.reconciled).toEqual([]);
    expect(r.signals).toEqual([]);
    expect(r.fired).toEqual([]);
  });

  it('EI-15182 guard #3: an EXISTING open stale-reminder escalation auto-resolves once its condition goes signal-absent (stops the re-page)', async () => {
    const store = makeStore();
    const staleTs = '2026-07-11T02:13:00.000Z';
    const stuck = mkState({
      condition_key: 'single-primary:split-brain-primary',
      first_seen: staleTs,
      open_since: staleTs,
      last_seen: staleTs,
    });
    // Tick #1: while the fixture's `now` is still within absenceMs of last_seen,
    // the condition is stale-but-observed and earns a real open reminder.
    const t1Now = Date.parse('2026-07-11T03:30:00.000Z'); // 77min after open_since — stale; last_seen 77min old too
    const deps = {
      readStates: async () => [stuck],
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      now: () => t1Now,
      staleMs: 45 * 60_000,
      absenceMs: 2 * 60 * 60_000, // 77min < 2h: not yet signal-absent
      broadcastResolvedMany: async () => true,
    };
    const t1 = await runConditionStalenessTick(deps);
    expect(t1.fired.map((s) => s.key)).toEqual(['stale-condition:single-primary:split-brain-primary']);
    expect(store.openCount()).toBe(1);

    // Tick #2, days later: nobody ever re-alarmed (last_seen unchanged) — now
    // well past absenceMs. The prior escalation must auto-resolve.
    _resetConditionStalenessDebounce();
    const t2Now = Date.parse('2026-07-17T21:00:00.000Z');
    const t2 = await runConditionStalenessTick({ ...deps, now: () => t2Now });
    expect(t2.resolved.length).toBe(1);
    expect(t2.fired).toEqual([]);
    expect(store.openCount()).toBe(0);
  });

  it('EI-15182 recurrence guard: ZERO escalations for a batch of conditions that are EITHER signal-absent OR already resolved in the store — across every family', async () => {
    const now = Date.parse('2026-07-17T21:00:00.000Z');
    const staleTs = '2026-07-10T00:00:00.000Z';
    const states = [
      // signal-absent, never explicitly resolved (the dummy-pot-0707 class):
      mkState({ condition_key: 'git-sync-stall:dummy-pot-0707', first_seen: staleTs, open_since: staleTs, last_seen: staleTs }),
      mkState({ condition_key: 'git-sync-stall:quartermaster-hive', first_seen: staleTs, open_since: staleTs, last_seen: staleTs }),
      mkState({ condition_key: 'embed-exhaustion:daily_cap', first_seen: staleTs, open_since: staleTs, last_seen: staleTs }),
      mkState({ condition_key: 'infra-liveness:pg-restarted', first_seen: staleTs, open_since: staleTs, last_seen: staleTs }),
      // already resolved in the store (open:false) — must never fire regardless of age:
      mkState({ condition_key: 'infra-liveness:panel:overwatch', open: false, resolved_at: '2026-07-17T09:37:00.000Z', last_seen: staleTs }),
    ];
    const deps = {
      readStates: async () => states,
      listOpen: async () => [] as EscalationRecord[],
      resolve: async () => {},
      escalate: async () => {
        throw new Error('escalate must NEVER be called in this scenario');
      },
      now: () => now,
      staleMs: 45 * 60_000,
      absenceMs: 2 * 60 * 60_000,
      readHealthByKey: async () => new Map<string, boolean>(),
      broadcastResolvedMany: async () => true,
    };
    const r = await runConditionStalenessTick(deps);
    expect(r.fired).toEqual([]);
    expect(r.signals).toEqual([]);
  });
});

describe('WI-7254 — the dedup key must not contain the condition age', () => {
  // The bug: this tick passed ONLY `meta.conditionStalenessSignature`, but
  // escalations.ts coalesces on `meta.subjectSignature` (else it hashes the
  // SUMMARY). The summary embeds the age — "has been OPEN for 267m" — so every
  // emission produced a key no previous emission could match. Measured live
  // 2026-08-03: 71 open rows, 71 distinct signatures, 4 distinct once
  // `open for <N>m` is normalized away — 5h45m where 4 rows were warranted.
  //
  // These assert the INVARIANT (same condition ⇒ same dedup identity at any age),
  // not the specific field plumbing, so a future refactor that keeps the
  // invariant stays green and one that reintroduces an age-varying key reds.
  function captureMeta() {
    const metas: Record<string, unknown>[] = [];
    return {
      metas,
      escalate: async (input: { meta?: Record<string, unknown> }) => {
        metas.push(input.meta ?? {});
        return undefined;
      },
    };
  }

  const stuck = mkState({
    condition_key: 'single-primary:no-primary',
    open_since: '2026-08-02T20:31:00.000Z',
    last_seen: '2026-08-03T00:58:00.000Z',
    latest_summary: 'no background primary running',
  });

  it('passes an explicit subjectSignature — the field escalations.ts actually reads', async () => {
    _resetConditionStalenessDebounce();
    const cap = captureMeta();
    await runConditionStalenessTick({
      readStates: async () => [stuck],
      escalate: cap.escalate,
      listOpen: async () => [],
      resolve: async () => undefined,
      now: () => Date.parse('2026-08-03T00:58:59.000Z'),
      staleMs: 45 * 60_000,
      absenceMs: 6 * 60 * 60_000,
    });
    expect(cap.metas).toHaveLength(1);
    expect(cap.metas[0].subjectSignature).toBe('stale-condition:single-primary:no-primary');
    // The module's own auto-resolve sweep reads this one back
    // (staleConditionSignatureOf) — dropping it would strand every open row.
    expect(cap.metas[0].conditionStalenessSignature).toBe('stale-condition:single-primary:no-primary');
  });

  it('the dedup signature is IDENTICAL at two different ages', async () => {
    // The actual regression test: same condition, +90 minutes older.
    const capA = captureMeta();
    _resetConditionStalenessDebounce();
    await runConditionStalenessTick({
      readStates: async () => [stuck],
      escalate: capA.escalate,
      listOpen: async () => [],
      resolve: async () => undefined,
      now: () => Date.parse('2026-08-03T00:58:59.000Z'),
      staleMs: 45 * 60_000,
      absenceMs: 6 * 60 * 60_000,
    });

    const capB = captureMeta();
    _resetConditionStalenessDebounce();
    await runConditionStalenessTick({
      readStates: async () => [stuck],
      escalate: capB.escalate,
      listOpen: async () => [],
      resolve: async () => undefined,
      now: () => Date.parse('2026-08-03T02:28:59.000Z'),
      staleMs: 45 * 60_000,
      absenceMs: 6 * 60 * 60_000,
    });

    expect(capA.metas[0].subjectSignature).toBe(capB.metas[0].subjectSignature);
    // ...and it must not carry a minute count, which is what made it unique.
    expect(String(capA.metas[0].subjectSignature)).not.toMatch(/\d+m/);
  });
});

// ── P-003: the condition→work-item bridge wiring ──
describe('toBridgeConditionStates (pure)', () => {
  it('keeps only opted-in condition keys', () => {
    const states = [
      mkState({ condition_key: 'green-stall:papercusp' }),
      mkState({ condition_key: 'infra-liveness:panel:bees' }), // not actionable
      mkState({ condition_key: 'git-sync-stall:papercusp' }), // not actionable
    ];
    expect(toBridgeConditionStates(states, 'papercusp').map((s) => s.conditionKey)).toEqual([
      'green-stall:papercusp',
    ]);
  });

  it('takes the harness from the key SUFFIX for slug-suffixed families', () => {
    const out = toBridgeConditionStates([mkState({ condition_key: 'green-stall:oddsmith' })], 'papercusp');
    expect(out[0].harness).toBe('oddsmith');
  });

  // REGRESSION GUARD. `single-primary:${verdict.key}` suffixes a VERDICT, not a
  // harness slug. A `split(':')[1]` derivation files the work-item under harness
  // 'no-primary', and createWorkItem does NOT validate the harness — the row is
  // created, scoped to a harness nobody queries, and is invisible forever.
  it('NEVER derives a harness from a verdict-suffixed key — uses the ambient harness', () => {
    const out = toBridgeConditionStates([mkState({ condition_key: 'single-primary:no-primary' })], 'papercusp');
    expect(out).toHaveLength(1);
    expect(out[0].harness).toBe('papercusp');
    expect(out[0].harness).not.toBe('no-primary');
  });

  it('SKIPS a condition whose harness cannot be established, rather than guessing', () => {
    expect(toBridgeConditionStates([mkState({ condition_key: 'single-primary:no-primary' })], '')).toEqual([]);
  });

  it('carries the open/closed state through, so a resolved condition can close its item', () => {
    const out = toBridgeConditionStates(
      [mkState({ condition_key: 'green-stall:papercusp', open: false })],
      'papercusp',
    );
    expect(out[0].open).toBe(false);
  });

  // ── P-007 (converge-frozen-candidate-by-fix-only-admission-2026-08-27) ──────────
  // The minted work-item is the ONE surface a claimant opens at the moment of failure.
  // Until this fold existed it carried a boilerplate template plus a one-line summary,
  // so every emitter's `body` — documented as "evidence + the recommended first step" —
  // was discarded for every condition family. Measured live 2026-08-29 against
  // coord_event_log: real alarm bodies of 543–1097 chars were being dropped.
  describe('P-007: the emitter body reaches the owning work-item', () => {
    // FALSIFIABILITY CONTROL, kept permanently (CLAUDE.md: prove a guard can fail
    // WITHOUT mutating the shared tree). This is the pre-P-007 summary shape. Every
    // assertion below must REJECT it — if one passes here, that assertion is vacuous
    // and would go green against a regression that dropped the fold again.
    const preFoldSummary =
      `Owning work-item for condition 'gate-red-streak:papercusp', minted by the condition bridge ` +
      `(P-003, gate-ownership-condition-singleton-2026-08-03).\n\n` +
      `Latest alarm: the gate is red\n` +
      `First seen: 2026-07-05T00:00:00.000Z · open since: 2026-07-05T00:00:00.000Z · alarms: 1`;

    it('renders the emitter body under its own heading', () => {
      const out = toBridgeConditionStates(
        [
          mkState({
            condition_key: 'gate-red-streak:papercusp',
            latest_summary: 'the gate is red',
            latest_body: 'WHERE TO FIX IT: .papercusp/worktrees/green-candidate-<pipeline>-<sha12>',
          }),
        ],
        'papercusp',
      );
      expect(out[0]!.summary).toContain('Latest alarm detail (from the emitter):');
      expect(out[0]!.summary).toContain('green-candidate-<pipeline>-<sha12>');
      // The control lacks both — proving neither assertion is trivially satisfied.
      expect(preFoldSummary).not.toContain('Latest alarm detail (from the emitter):');
      expect(preFoldSummary).not.toContain('green-candidate-<pipeline>-<sha12>');
    });

    it('OMITS the block entirely when the emitter sent no body', () => {
      // Most watchdogs send summary-only; a bare heading with nothing under it would
      // read as "the evidence was lost" rather than "there was none".
      const out = toBridgeConditionStates(
        [mkState({ condition_key: 'gate-red-streak:papercusp', latest_body: null })],
        'papercusp',
      );
      expect(out[0]!.summary).not.toContain('Latest alarm detail');
    });

    it('TRUNCATES a runaway body and MARKS the truncation', () => {
      // Bounded because every reader of the item pays for this text. An unmarked clip
      // is worse than a clip: it reads as the whole of what the emitter said.
      const out = toBridgeConditionStates(
        [mkState({ condition_key: 'gate-red-streak:papercusp', latest_body: 'x'.repeat(5000) })],
        'papercusp',
      );
      expect(out[0]!.summary).toContain('…[truncated at 2000 chars');
      // `summary` is OPTIONAL on the bridge's ConditionState (condition-bridge.ts:171),
      // so the bang belongs on `summary`, not only on `out[0]` — the possibly-undefined
      // object under `.length` is the summary itself. Asserting here does NOT weaken the
      // production type; the preceding toContain already proves it is present.
      expect(out[0]!.summary!.length).toBeLessThan(3000);
    });
  });
});

describe('runConditionStalenessTick — bridge wiring', () => {
  beforeEach(() => _resetConditionStalenessDebounce());

  it('does NOT write when no bridge is injected (the write-side dep is opt-in)', async () => {
    const res = await runConditionStalenessTick({
      readStates: async () => [mkState({ condition_key: 'green-stall:papercusp' })],
      listOpen: async () => [],
      escalate: async () => undefined,
    });
    expect(res.bridged).toEqual({ acquired: [], released: [], skipped: 0 });
  });

  it('passes the FINAL states to the bridge, so a condition healed this tick closes its item', async () => {
    const seen: { key: string; open: boolean }[] = [];
    await runConditionStalenessTick({
      readStates: async () => [mkState({ condition_key: 'green-stall:papercusp', open: true })],
      listOpen: async () => [],
      // guard #3 resolves it this tick (last_seen far older than absenceMs)
      absenceMs: 1,
      now: () => Date.parse('2026-07-06T00:00:00.000Z'),
      broadcastResolvedMany: async () => true,
      homeHarness: () => 'papercusp',
      bridgeConditions: async (states) => {
        for (const s of states) seen.push({ key: s.conditionKey, open: s.open });
        return { acquired: [], released: [], skipped: 0 };
      },
    });
    expect(seen).toEqual([{ key: 'green-stall:papercusp', open: false }]);
  });

  it('WI-6554700010009404: keeps a stale one-shot provider condition open through the final bridge input', async () => {
    // Use the current actionable degradation namespace. The historical Codex
    // provider alarm was intentionally not in the bridge catalog, so that old
    // key could never reach bridgeInputs and made this lifecycle assertion
    // vacuous after the catalog was narrowed.
    const key = 'degraded:release-state-read:papercusp-pr-drill-20261014-dependency-prebuild-state:prebuild-state-unavailable';
    const condition = mkState({
      condition_key: key,
      first_seen: '2026-10-12T20:55:48.319Z',
      open_since: '2026-10-12T20:55:48.319Z',
      last_seen: '2026-10-13T06:35:46.575Z',
      alarm_count: 87,
      one_shot: true,
    });
    const resolutionBroadcasts: string[][] = [];
    const bridgeInputs: Array<{ key: string; open: boolean }> = [];

    const result = await runConditionStalenessTick({
      readStates: async () => [condition],
      listOpen: async () => [],
      escalate: async () => undefined,
      now: () => Date.parse('2026-10-13T10:00:00.000Z'),
      absenceMs: 2 * 60 * 60_000,
      homeHarness: () => 'papercusp',
      broadcastResolvedMany: async ({ conditionKeys }) => {
        resolutionBroadcasts.push(conditionKeys);
        return true;
      },
      bridgeConditions: async (states) => {
        bridgeInputs.push(...states.map((state) => ({ key: state.conditionKey, open: state.open })));
        return { acquired: [], released: [], skipped: 0 };
      },
    });

    expect(result.reconciled).toEqual([]);
    expect(resolutionBroadcasts).toEqual([]);
    expect(bridgeInputs).toEqual([{ key, open: true }]);
  });

  it('WI-6554700010029296: hands the held-owner sweep the bridged keys and appends its releases', async () => {
    const coveredSeen: string[][] = [];
    const swept = { conditionKey: 'alarm:codex-rollout-provider:x', released: 'WI-1', settled: true };
    const res = await runConditionStalenessTick({
      readStates: async () => [mkState({ condition_key: 'green-stall:papercusp', open: true })],
      listOpen: async () => [],
      escalate: async () => undefined,
      homeHarness: () => 'papercusp',
      bridgeConditions: async () => ({
        acquired: [],
        released: [{ conditionKey: 'green-stall:other', released: 'WI-0', settled: true }],
        skipped: 0,
      }),
      reconcileHeldOwners: async (covered) => {
        coveredSeen.push([...covered]);
        return [swept];
      },
    });
    expect(coveredSeen).toEqual([['green-stall:papercusp']]);
    expect(res.bridged.released.map((r) => r.conditionKey)).toEqual(['green-stall:other', swept.conditionKey]);
  });

  it('WI-6554700010029296: a held-owner sweep failure keeps the bridge result', async () => {
    const res = await runConditionStalenessTick({
      readStates: async () => [mkState({ condition_key: 'green-stall:papercusp' })],
      listOpen: async () => [],
      escalate: async () => undefined,
      homeHarness: () => 'papercusp',
      bridgeConditions: async () => ({ acquired: [], released: [], skipped: 3 }),
      reconcileHeldOwners: async () => {
        throw new Error('sweep down');
      },
    });
    expect(res.bridged).toEqual({ acquired: [], released: [], skipped: 3 });
    // EI-27066473667693647: the swallowed sweep error is now reported, not lost.
    expect(res.heldOwnerSweep).toEqual({ ran: true, released: 0, settled: 0, error: 'sweep down' });
    expect(res.failures).toEqual([{ stage: 'held-owner-sweep', error: 'sweep down' }]);
  });

  it('EI-27066473667693647: counts the held-owner sweep releases and settles on a clean tick', async () => {
    const res = await runConditionStalenessTick({
      readStates: async () => [mkState({ condition_key: 'green-stall:papercusp' })],
      listOpen: async () => [],
      escalate: async () => undefined,
      homeHarness: () => 'papercusp',
      bridgeConditions: async () => ({ acquired: [], released: [], skipped: 0 }),
      reconcileHeldOwners: async () => [
        { conditionKey: 'alarm:a', released: 'WI-1', settled: true },
        { conditionKey: 'alarm:b', released: 'WI-2', settled: false },
        { conditionKey: 'alarm:c', released: null, settled: false },
      ],
    });
    expect(res.heldOwnerSweep).toEqual({ ran: true, released: 2, settled: 1, error: null });
    expect(res.failures).toEqual([]);
  });

  it('EI-27066473667693647: records every failed leg in order without throwing', async () => {
    const res = await runConditionStalenessTick({
      // Pinned clock: 60m open (stale past 45m) but last seen inside the absence
      // window, so the condition escalates instead of auto-resolving as absent.
      now: () => Date.parse('2026-07-05T01:00:00.000Z'),
      staleMs: 45 * 60_000,
      readStates: async () => [mkState({ condition_key: 'green-stall:papercusp' })],
      listOpen: async () => {
        throw new Error('escalation read down');
      },
      escalate: async () => {
        throw new Error('send refused');
      },
      homeHarness: () => 'papercusp',
      bridgeConditions: async () => {
        throw new Error('bridge exploded');
      },
    });
    expect(res.failures.map((f) => f.stage)).toEqual(['list-open', 'bridge', 'escalate']);
    expect(res.failures.map((f) => f.error)).toEqual(['escalation read down', 'bridge exploded', 'send refused']);
  });

  describe('reportConditionStalenessTick — the production timer outcome (EI-27066473667693647)', () => {
  const clean = (over: Partial<ConditionStalenessTickResult> = {}): ConditionStalenessTickResult => ({
    fired: [],
    signals: [],
    resolved: [],
    reconciled: [],
    bridged: { acquired: [], released: [], skipped: 0 },
    heldOwnerSweep: { ran: false, released: 0, settled: 0, error: null },
    failures: [],
    ...over,
  });

  it('a clean tick neither throws nor logs', () => {
    const lines: string[] = [];
    expect(() => reportConditionStalenessTick(clean(), (l) => lines.push(l))).not.toThrow();
    expect(lines).toEqual([]);
  });

  it('a failed leg rejects the tick so managedSetInterval records lastError', () => {
    const result = clean({
      heldOwnerSweep: { ran: true, released: 0, settled: 0, error: 'sweep down' },
      failures: [{ stage: 'held-owner-sweep', error: 'sweep down' }],
    });
    expect(() => reportConditionStalenessTick(result, () => undefined)).toThrow(
      'condition-staleness tick: 1 leg failure(s): held-owner-sweep: sweep down',
    );
  });

  it('logs the sweep settle counts when it released items', () => {
    const lines: string[] = [];
    reportConditionStalenessTick(clean({ heldOwnerSweep: { ran: true, released: 3, settled: 2, error: null } }), (l) =>
      lines.push(l),
    );
    expect(lines).toEqual(['[condition-staleness-alarm] held-owner sweep released 3 item(s) (2 settled)']);
  });

  it('bounds the failure summary so it fits lastError', () => {
    const text = formatConditionStalenessFailures(
      Array.from({ length: 50 }, () => ({ stage: 'escalate' as const, error: 'x'.repeat(40) })),
    );
    expect(text.length).toBe(600);
    expect(text.endsWith('…')).toBe(true);
  });
  });

  it('a bridge failure never crashes the tick', async () => {
    const res = await runConditionStalenessTick({
      readStates: async () => [mkState({ condition_key: 'green-stall:papercusp' })],
      listOpen: async () => [],
      escalate: async () => undefined,
      homeHarness: () => 'papercusp',
      bridgeConditions: async () => {
        throw new Error('bridge exploded');
      },
    });
    expect(res.bridged).toEqual({ acquired: [], released: [], skipped: 0 });
  });

  // REGRESSION GUARD: a read failure must not look like "every condition resolved",
  // which would SETTLE every owning work-item on a transient DB blip.
  it('does NOT bridge at all when the state read fails', async () => {
    let bridgeCalls = 0;
    const res = await runConditionStalenessTick({
      readStates: async () => {
        throw new Error('db unavailable');
      },
      bridgeConditions: async () => {
        bridgeCalls += 1;
        return { acquired: [], released: [], skipped: 0 };
      },
    });
    expect(bridgeCalls).toBe(0);
    expect(res.bridged).toEqual({ acquired: [], released: [], skipped: 0 });
  });

  // REGRESSION GUARD (EI-19930875455827867): the tick MUST hand the bridge a concrete
  // workspaceId.
  //
  // This assertion is deliberately about the OPTS the production call site passes —
  // the one thing none of the sibling tests above check. All three of them stub
  // `bridgeConditions` with a callback that ignores its second argument, and every
  // condition-bridge integration test passes `{ workspaceId: WS }` explicitly. So the
  // entire suite modelled a caller that supplies the workspace, while production
  // supplied `{}` — 111 green tests over a bug that minted ~150 junk work-items/hour
  // for five days. The defect was never in the normalization logic (D-022's
  // `resolveStoredConditionHarness` is correct and was deployed); it was that its only
  // caller passed nothing, and nothing asserted on what that caller passed.
  //
  // Assert the PROPERTY that fails in production (a concrete, non-empty workspace),
  // not a specific value — the resolved workspace legitimately differs per deployment.
  it('passes a concrete workspaceId to the bridge (never an empty opts object)', async () => {
    const seenOpts: ({ workspaceId?: string } | undefined)[] = [];
    await runConditionStalenessTick({
      readStates: async () => [mkState({ condition_key: 'green-stall:papercusp', open: true })],
      listOpen: async () => [],
      escalate: async () => undefined,
      homeHarness: () => 'papercusp',
      bridgeConditions: async (_states, opts) => {
        seenOpts.push(opts);
        return { acquired: [], released: [], skipped: 0 };
      },
    });

    expect(seenOpts).toHaveLength(1);
    const opts = seenOpts[0];
    expect(opts).toBeDefined();
    // The exact failure mode: `workspaceId` undefined makes resolveWorkItemPot
    // short-circuit and return the RAW member slug, so the ownership read misses a
    // holder stored under the resolved pot slug.
    expect(opts?.workspaceId).toBeDefined();
    expect(typeof opts?.workspaceId).toBe('string');
    expect((opts?.workspaceId ?? '').trim()).not.toBe('');
  });
});
