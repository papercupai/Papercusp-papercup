/**
 * degradation-watchdog unit tests (degradation-signals-on-condition-rail-2026-10-11 P-003;
 * BARs R-2 pure-decision edges, R-7 dominance, R-8 actor registration).
 *
 * The windows are built with the REAL summariser (`summarizeFallbackWindow`), so these
 * cases exercise the same arithmetic the sweep sees from Postgres.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { summarizeFallbackWindow, type FallbackReasonAggregate } from '../degradation/fallback-observations';
import { actionableConditionFor, isActionableConditionKey } from '../coord/actionable-conditions';
import { CONDITION_BRIDGE_ACTOR } from '../coord/condition-bridge';
import { getSignal, isSignalCovered } from '../signal-actor-registry';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import type { SevereEventBroadcast, SevereEventResolution } from '../severe-event-broadcast';
import {
  DEGRADATION_WATCHDOG_SIGNAL_ID,
  _resetDegradationPruneClockForTests,
  _unregisterDegradationMechanismForTests,
  degradationConditionKey,
  degradationKeyPrefix,
  getDegradationMechanism,
  judgeDegradation,
  judgeYieldDrop,
  keyBelongsToPrefix,
  planDegradationActions,
  registerDegradationMechanism,
  resolveObservationWorkspaceId,
  runDegradationSweepOnce,
  type DegradationMechanism,
} from './degradation-watchdog';
import { runWithWorkspace } from '../workspace-als';

const M = 'test-mechanism';

/** A window with `eligible` units of which `applied` took the primary path; the rest split by `fallbacks`. */
function windowOf(eligible: number, applied: number, fallbacks: Record<string, number> = { otherRunner: eligible - applied }) {
  const aggs: FallbackReasonAggregate[] = [];
  if (applied > 0) aggs.push({ reason: 'applied', samples: 1, eligible: applied, applied });
  for (const [reason, n] of Object.entries(fallbacks)) if (n > 0) aggs.push({ reason, samples: 1, eligible: n, applied: 0 });
  return summarizeFallbackWindow(M, 3_600_000, aggs);
}

describe('judgeDegradation — pinned defaults (R-2)', () => {
  it('19 eligible is insufficient; 20 eligible at a 0 rate collapses', () => {
    expect(judgeDegradation(windowOf(19, 0), { mechanism: M }).kind).toBe('insufficient');
    const v = judgeDegradation(windowOf(20, 0), { mechanism: M });
    expect(v.kind).toBe('collapsed');
  });

  it('an applied rate of 0.20 collapses; 0.21 does not', () => {
    expect(judgeDegradation(windowOf(20, 4), { mechanism: M }).kind).toBe('collapsed'); // 0.20
    expect(judgeDegradation(windowOf(100, 21), { mechanism: M }).kind).toBe('between'); // 0.21
  });

  it('recovery needs 0.50: 0.49 holds, 0.50 recovers', () => {
    expect(judgeDegradation(windowOf(100, 49), { mechanism: M }).kind).toBe('between');
    expect(judgeDegradation(windowOf(100, 50), { mechanism: M }).kind).toBe('recovered');
  });

  it('a window with nothing eligible is insufficient, never healthy', () => {
    expect(judgeDegradation(summarizeFallbackWindow(M, 1, []), { mechanism: M }).kind).toBe('insufficient');
  });

  it('per-mechanism thresholds override the defaults', () => {
    expect(judgeDegradation(windowOf(10, 0), { mechanism: M }, { minEligible: 5 }).kind).toBe('collapsed');
  });

  it('keeps retrieval degradation per caller and alerts after repeated semantic blocks', () => {
    const mechanism = getDegradationMechanism('retrieval');
    if (!mechanism) throw new Error('retrieval registration is missing');
    expect(mechanism.scopeKeyed).toBe(true);

    const target = { mechanism: 'retrieval', scope: 'docs:search' };
    const oneAttempt = judgeDegradation(
      windowOf(1, 0, { 'semantic-blocked': 1 }),
      target,
      mechanism.thresholds,
    );
    expect(oneAttempt).toMatchObject({ kind: 'insufficient', eligible: 1, minEligible: 2 });

    const oneFailureInPair = judgeDegradation(
      windowOf(2, 1, { 'semantic-blocked': 1 }),
      target,
      mechanism.thresholds,
    );
    expect(oneFailureInPair).toMatchObject({ kind: 'insufficient', eligible: 2, minEligible: 2 });

    const repeatedBlocks = judgeDegradation(
      windowOf(2, 0, { 'semantic-blocked': 2 }),
      target,
      mechanism.thresholds,
    );
    expect(repeatedBlocks).toMatchObject({
      kind: 'collapsed',
      reason: 'semantic-blocked',
      conditionKey: degradationConditionKey('retrieval', 'docs:search', 'semantic-blocked'),
    });
  });

  it('the gate reuse registration lowers the floor only for hard fail-open reasons', () => {
    const mechanism = getDegradationMechanism('gate-pass-reuse');
    if (!mechanism) throw new Error('gate-pass-reuse registration is missing');

    for (const reason of [
      'workspace-unresolved', 'no-judged-sha', 'head-mismatch', 'checkout-status-unknown',
      'checkpoint-root-unverified', 'checkpoint-restore-failed', 'checkpoint-remains-dirty',
      'dirty-checkout', 'no-runner-identity', 'pg-unavailable', 'proofs-unavailable',
      'lane-filter-unavailable', 'skip-list-unwritable', 'arming-threw',
    ]) {
      expect(judgeDegradation(windowOf(1, 0, { [reason]: 1 }), { mechanism: mechanism.mechanism }, mechanism.thresholds))
        .toMatchObject({ kind: 'collapsed', topReason: reason, conditionKey: `degraded:gate-pass-reuse:${reason}` });
    }

    for (const reason of ['disabled-by-env', 'script-cannot-run-zero-files']) {
      expect(judgeDegradation(windowOf(1, 0, { [reason]: 1 }), { mechanism: mechanism.mechanism }, mechanism.thresholds))
        .toMatchObject({ kind: 'insufficient', eligible: 1, minEligible: 20 });
    }
    expect(judgeDegradation(windowOf(19, 0, { otherRunner: 19 }), { mechanism: mechanism.mechanism }, mechanism.thresholds))
      .toMatchObject({ kind: 'insufficient', eligible: 19, minEligible: 20 });
  });
});

describe('judgeDegradation — dominant reason names the key (R-7)', () => {
  it('a top reason holding 0.80 of eligible units is named in the key', () => {
    const v = judgeDegradation(windowOf(100, 0, { otherRunner: 80, headMismatch: 20 }), { mechanism: M });
    expect(v).toMatchObject({ kind: 'collapsed', reason: 'otherRunner' });
    if (v.kind === 'collapsed') expect(v.conditionKey).toBe(`degraded:${M}:otherRunner`);
  });

  it('a top reason holding 0.79 keys the condition as mixed', () => {
    const v = judgeDegradation(windowOf(100, 0, { otherRunner: 79, headMismatch: 21 }), { mechanism: M });
    expect(v).toMatchObject({ kind: 'collapsed', reason: 'mixed', topReason: 'otherRunner' });
    if (v.kind === 'collapsed') expect(v.conditionKey).toBe(`degraded:${M}:mixed`);
  });

  it('dominance is measured against ELIGIBLE units, not only fallen-back ones', () => {
    // 20 applied + 70 otherRunner + 10 other: rate 0.2 collapses; otherRunner is 0.875 of the
    // fallen-back units but only 0.70 of eligible, so it does not dominate.
    const v = judgeDegradation(windowOf(100, 20, { otherRunner: 70, dirty: 10 }), { mechanism: M });
    expect(v).toMatchObject({ kind: 'collapsed', reason: 'mixed' });
  });

  it('a scoped key carries the scope between mechanism and reason', () => {
    const v = judgeDegradation(windowOf(30, 0), { mechanism: 'gate-pass-reuse', scope: 'operator-core' });
    if (v.kind !== 'collapsed') throw new Error('expected collapsed');
    expect(v.conditionKey).toBe('degraded:gate-pass-reuse:operator-core:otherRunner');
  });
});

describe('judgeYieldDrop — adjacent healthy-window yield declines', () => {
  const mechanism = getDegradationMechanism('gate-pass-reuse');
  if (!mechanism?.yieldDrop) throw new Error('gate-pass-reuse yield-drop registration is missing');
  // Capture the narrowed value: TS resets property narrowing inside the `it` callbacks below.
  const yieldDrop = mechanism.yieldDrop;

  it('alarms at a 0.50 absolute drop, but not below it or without a sampled healthy baseline', () => {
    const prior = windowOf(40, 40);
    const exactDrop = windowOf(100, 50, { otherRunner: 50 });
    expect(judgeYieldDrop(prior, exactDrop, { mechanism: mechanism.mechanism, scope: 'task' }, yieldDrop))
      .toMatchObject({ kind: 'collapsed', reason: 'yield-decline', conditionKey: 'degraded:gate-pass-reuse:task:yield-decline' });

    const smallerDrop = windowOf(100, 51, { otherRunner: 49 });
    expect(judgeYieldDrop(prior, smallerDrop, { mechanism: mechanism.mechanism, scope: 'task' }, yieldDrop)).toBeNull();
    expect(judgeYieldDrop(windowOf(19, 19), windowOf(1, 0), { mechanism: mechanism.mechanism }, yieldDrop)).toBeNull();
    expect(judgeYieldDrop(windowOf(40, 19), windowOf(1, 0), { mechanism: mechanism.mechanism }, yieldDrop)).toBeNull();
  });
});

describe('keys', () => {
  it('collapses separators inside a segment so prefix membership stays exact', () => {
    expect(degradationConditionKey('m', 'a:b c', 'r:x')).toBe('degraded:m:a-b-c:r-x');
    const prefix = degradationKeyPrefix('m', 'a');
    expect(keyBelongsToPrefix('degraded:m:a:otherRunner', prefix)).toBe(true);
    // A key for a deeper scope ('a:b' was flattened, but a hand-written key could still nest).
    expect(keyBelongsToPrefix('degraded:m:a:b:otherRunner', prefix)).toBe(false);
    expect(keyBelongsToPrefix('degraded:m:ab:otherRunner', prefix)).toBe(false);
  });

  it('degraded: keys are opted into the actionable catalog with an ambient harness', () => {
    expect(isActionableConditionKey('degraded:gate-pass-reuse:operator-core:otherRunner')).toBe(true);
    expect(actionableConditionFor('degraded:x:y')).toMatchObject({ harnessFrom: 'ambient', severity: 'major' });
  });
});

describe('planDegradationActions', () => {
  const collapsed = judgeDegradation(windowOf(20, 0), { mechanism: M });
  const prefix = degradationKeyPrefix(M);

  it('opens a collapsed key that is not already open', () => {
    expect(planDegradationActions(collapsed, prefix, [])).toEqual({ open: `degraded:${M}:otherRunner`, resolve: [] });
  });

  it('does not re-open a key that is already open', () => {
    expect(planDegradationActions(collapsed, prefix, [`degraded:${M}:otherRunner`])).toEqual({ open: null, resolve: [] });
  });

  it('a changed dominant reason resolves the old key and opens the new one', () => {
    expect(planDegradationActions(collapsed, prefix, [`degraded:${M}:mixed`, 'degraded:other:mixed'])).toEqual({
      open: `degraded:${M}:otherRunner`,
      resolve: [`degraded:${M}:mixed`],
    });
  });

  it('recovery resolves every open key of that mechanism and none of another', () => {
    const recovered = judgeDegradation(windowOf(100, 60), { mechanism: M });
    expect(planDegradationActions(recovered, prefix, [`degraded:${M}:mixed`, 'degraded:other:mixed'])).toEqual({
      open: null,
      resolve: [`degraded:${M}:mixed`],
    });
  });

  it('hysteresis and insufficient data change nothing', () => {
    const open = [`degraded:${M}:otherRunner`];
    expect(planDegradationActions(judgeDegradation(windowOf(100, 30), { mechanism: M }), prefix, open)).toEqual({ open: null, resolve: [] });
    expect(planDegradationActions(judgeDegradation(windowOf(5, 0), { mechanism: M }), prefix, open)).toEqual({ open: null, resolve: [] });
  });
});

describe('runDegradationSweepOnce — one alarm per episode against a durable open-key fold', () => {
  const mech: DegradationMechanism = { mechanism: M, description: 'test mechanism' };
  let open: Set<string>;
  let broadcasts: SevereEventBroadcast[];
  let resolutions: SevereEventResolution[];
  let window = windowOf(40, 0);

  const deps = () => ({
    mechanisms: () => [mech],
    readWindows: async () => [{ scope: null, window }],
    readOpenConditionKeys: async () => [...open],
    broadcast: async (ev: SevereEventBroadcast) => {
      broadcasts.push(ev);
      if (ev.conditionKey) open.add(ev.conditionKey);
      return true;
    },
    resolve: async (r: SevereEventResolution) => {
      resolutions.push(r);
      open.delete(r.conditionKey);
      return true;
    },
    prune: null,
  });

  beforeEach(() => {
    open = new Set();
    broadcasts = [];
    resolutions = [];
    window = windowOf(40, 0);
  });

  it('resolves opted-in inactive scopes only after their full observation window, without claiming recovery', async () => {
    const nowMs = Date.parse('2026-11-02T22:10:00.000Z');
    const windowMs = 60_000;
    const scoped: DegradationMechanism = {
      mechanism: 'bounded-operation',
      description: 'bounded operation',
      scopeKeyed: true,
      resolveOnScopeInactivity: true,
      windowMs,
    };
    const oldScope = 'coord:inbox-wake:s-old';
    const youngScope = 'coord:inbox-wake:s-young';
    const unknownScope = 'coord:inbox-wake:s-unknown';
    const oldKey = degradationConditionKey(scoped.mechanism, oldScope, 'timeout');
    const youngKey = degradationConditionKey(scoped.mechanism, youngScope, 'timeout');
    const unknownKey = degradationConditionKey(scoped.mechanism, unknownScope, 'timeout');
    open = new Set([oldKey, youngKey, unknownKey]);

    const result = await runDegradationSweepOnce({
      ...deps(),
      mechanisms: () => [scoped],
      now: () => new Date(nowMs),
      readWindows: async () => [],
      readOpenConditionKeys: async () => [...open],
      readOpenConditionEpisodes: async () => [
        { conditionKey: oldKey, openedAtMs: nowMs - windowMs },
        { conditionKey: youngKey, openedAtMs: nowMs - windowMs + 1 },
      ],
    });

    expect(result.resolved).toEqual([oldKey]);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].summary).toMatch(/^STALE: bounded-operation/);
    expect(resolutions[0].summary).not.toMatch(/^RECOVERED/);
    expect(open.has(oldKey)).toBe(false);
    expect(open.has(youngKey)).toBe(true);
    expect(open.has(unknownKey)).toBe(true);
  });

  it('three sweeps over a collapsed window broadcast exactly once, one-shot, on the rail', async () => {
    for (let i = 0; i < 3; i++) await runDegradationSweepOnce(deps());
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ conditionKey: `degraded:${M}:otherRunner`, oneShot: true, category: 'degradation' });
    expect(broadcasts[0].summary).toContain('0 of 40');
    expect(resolutions).toHaveLength(0);
  });

  it('a recovered window resolves the open key', async () => {
    await runDegradationSweepOnce(deps());
    window = windowOf(40, 30);
    const r = await runDegradationSweepOnce(deps());
    expect(r.resolved).toEqual([`degraded:${M}:otherRunner`]);
    expect(resolutions[0].summary).toMatch(/^RECOVERED/);
    expect(open.size).toBe(0);
  });

  it('resolves owner-scoped degradation only after positive ended-session evidence', async () => {
    const scoped: DegradationMechanism = {
      mechanism: 'compaction-force-respawn', description: 'x', scopeKeyed: true, scopeIsSessionOwner: true,
      thresholds: { minEligible: 1 },
    };
    const owner = 'su-ended-owner';
    const key = degradationConditionKey(scoped.mechanism, owner, 'force-unavailable');
    open.add(key);
    const r = await runDegradationSweepOnce({
      ...deps(),
      mechanisms: () => [scoped],
      readWindows: async () => [],
      readEndedSessionOwners: async (owners) => {
        expect(owners).toEqual([owner]);
        return new Set([owner]);
      },
    });

    expect(r.resolved).toEqual([key]);
    expect(resolutions[0]).toMatchObject({
      conditionKey: key,
      summary: 'Superseded: compaction-force-respawn (su-ended-owner) owner session ended; scope is no longer applicable.',
    });
    expect(broadcasts).toHaveLength(0);
    expect(open.has(key)).toBe(false);
  });

  it('does not re-open an ended owner condition from a stale collapsed window', async () => {
    const scoped: DegradationMechanism = {
      mechanism: 'compaction-force-respawn', description: 'x', scopeKeyed: true, scopeIsSessionOwner: true,
      thresholds: { minEligible: 1 },
    };
    const owner = 'su-ended-owner';
    const key = degradationConditionKey(scoped.mechanism, owner, 'force-unavailable');
    open.add(key);
    const r = await runDegradationSweepOnce({
      ...deps(),
      mechanisms: () => [scoped],
      readWindows: async () => [{ scope: owner, window: windowOf(1, 0) }],
      readEndedSessionOwners: async () => new Set([owner]),
    });

    expect(r.resolved).toEqual([key]);
    expect(r.opened).toEqual([]);
    expect(broadcasts).toHaveLength(0);
    expect(open.has(key)).toBe(false);
  });

  it('explains owner-end recovery for session-scoped degradation alarms', async () => {
    const scoped: DegradationMechanism = {
      mechanism: 'compaction-force-respawn', description: 'x', scopeKeyed: true, scopeIsSessionOwner: true,
      thresholds: { minEligible: 1 },
    };
    const result = await runDegradationSweepOnce({
      ...deps(),
      mechanisms: () => [scoped],
      readWindows: async () => [{ scope: 'su-current-owner', window: windowOf(1, 0) }],
      readOpenConditionKeys: async () => [],
    });
    expect(broadcasts[0]?.body).toContain('resolves itself once the rate reaches 0.5 or the scoped owner session ends.');
    expect(result.opened).toEqual(['degraded:compaction-force-respawn:su-current-owner:otherRunner']);
  });

  it('keeps owner-scoped conditions open when liveness is live, unknown, or unreadable', async () => {
    const scoped: DegradationMechanism = {
      mechanism: 'compaction-force-respawn', description: 'x', scopeKeyed: true, scopeIsSessionOwner: true,
    };
    const owner = 'su-live-owner';
    const key = degradationConditionKey(scoped.mechanism, owner, 'force-unavailable');
    open.add(key);
    const r = await runDegradationSweepOnce({
      ...deps(),
      mechanisms: () => [scoped],
      readWindows: async () => [],
      readEndedSessionOwners: async () => new Set(),
    });
    expect(r.resolved).toEqual([]);
    expect(resolutions).toHaveLength(0);
    expect(open.has(key)).toBe(true);

    const failed = await runDegradationSweepOnce({
      ...deps(),
      mechanisms: () => [scoped],
      readWindows: async () => [],
      readEndedSessionOwners: async () => { throw new Error('liveness unavailable'); },
    });
    expect(failed.errors).toContain('compaction-force-respawn ended-session liveness: liveness unavailable');
    expect(resolutions).toHaveLength(0);
    expect(open.has(key)).toBe(true);
  });

  it('resolves an owner-scoped condition from a predecessor after owner-id reuse', async () => {
    const scoped: DegradationMechanism = {
      mechanism: 'compaction-force-respawn', description: 'x', scopeKeyed: true, scopeIsSessionOwner: true,
    };
    const owner = 'su-reused-owner';
    const key = degradationConditionKey(scoped.mechanism, owner, 'force-unavailable');
    open.add(key);
    const predecessorConditionAt = Date.parse('2026-10-16T13:35:43.146Z');
    const successorStartedAt = Date.parse('2026-10-16T20:27:43.004Z');
    const r = await runDegradationSweepOnce({
      ...deps(),
      mechanisms: () => [scoped],
      readWindows: async () => [],
      readOpenConditionEpisodes: async () => [{ conditionKey: key, openedAtMs: predecessorConditionAt }],
      readSessionStartedAt: async (owners) => {
        expect(owners).toEqual([owner]);
        return new Map([[owner, successorStartedAt]]);
      },
      readEndedSessionOwners: async () => new Set(),
    });

    expect(r.resolved).toEqual([key]);
    expect(resolutions[0]).toMatchObject({
      conditionKey: key,
      summary: 'Superseded: compaction-force-respawn (su-reused-owner) condition predates the current session incarnation.',
    });
    expect(open.has(key)).toBe(false);
  });

  it('keeps an owner condition when it opened during the current incarnation', async () => {
    const scoped: DegradationMechanism = {
      mechanism: 'compaction-force-respawn', description: 'x', scopeKeyed: true, scopeIsSessionOwner: true,
    };
    const owner = 'su-current-owner';
    const key = degradationConditionKey(scoped.mechanism, owner, 'force-unavailable');
    open.add(key);
    const currentStartedAt = Date.parse('2026-10-16T20:27:43.004Z');
    const currentConditionAt = currentStartedAt + 1_000;
    const r = await runDegradationSweepOnce({
      ...deps(),
      mechanisms: () => [scoped],
      readWindows: async () => [],
      readOpenConditionEpisodes: async () => [{ conditionKey: key, openedAtMs: currentConditionAt }],
      readSessionStartedAt: async () => new Map([[owner, currentStartedAt]]),
      readEndedSessionOwners: async () => new Set(),
    });

    expect(r.resolved).toEqual([]);
    expect(resolutions).toHaveLength(0);
    expect(open.has(key)).toBe(true);
  });

  it('a failed open-key read makes no rail writes', async () => {
    const r = await runDegradationSweepOnce({
      ...deps(),
      readOpenConditionKeys: async () => {
        throw new Error('fold unavailable');
      },
    });
    expect(broadcasts).toHaveLength(0);
    expect(r.errors[0]).toContain('fold unavailable');
  });

  it('uses the family episode read to recover a key missing from the bounded aggregate fold', async () => {
    const key = degradationConditionKey(M, null, 'otherRunner');
    const r = await runDegradationSweepOnce({
      ...deps(),
      readOpenConditionKeys: async () => [],
      readOpenConditionEpisodes: async () => [{ conditionKey: key, openedAtMs: Date.now() - 60_000 }],
      readWindows: async () => [{ scope: null, window: windowOf(40, 30) }],
    });

    expect(r.resolved).toEqual([key]);
    expect(resolutions).toHaveLength(1);
    expect(open.has(key)).toBe(false);
  });

  it('one unreadable mechanism does not stop the others', async () => {
    const other: DegradationMechanism = { mechanism: 'other-mechanism', description: 'x' };
    const r = await runDegradationSweepOnce({
      ...deps(),
      mechanisms: () => [other, mech],
      readWindows: async (m: DegradationMechanism) => {
        if (m.mechanism === 'other-mechanism') throw new Error('boom');
        return [{ scope: null, window }];
      },
    });
    expect(r.opened).toEqual([`degraded:${M}:otherRunner`]);
    expect(r.errors).toEqual(['other-mechanism: boom']);
  });

  it('a scope-keyed mechanism opens one key per collapsed scope and ignores a healthy one', async () => {
    const scoped: DegradationMechanism = { mechanism: 'gate-pass-reuse', description: 'x', scopeKeyed: true };
    const r = await runDegradationSweepOnce({
      ...deps(),
      mechanisms: () => [scoped],
      readWindows: async () => [
        { scope: 'lane-a', window: windowOf(25, 0) },
        { scope: 'lane-b', window: windowOf(25, 25) },
      ],
    });
    expect(r.opened).toEqual(['degraded:gate-pass-reuse:lane-a:otherRunner']);
  });

  it('runs the pruner at most once per prune interval', async () => {
    _resetDegradationPruneClockForTests();
    let prunes = 0;
    const prune = async () => {
      prunes += 1;
      return 3;
    };
    const t0 = new Date('2026-10-11T00:00:00Z');
    const first = await runDegradationSweepOnce({ ...deps(), prune, now: () => t0 });
    await runDegradationSweepOnce({ ...deps(), prune, now: () => new Date(t0.getTime() + 30 * 60_000) });
    await runDegradationSweepOnce({ ...deps(), prune, now: () => new Date(t0.getTime() + 61 * 60_000) });
    expect(first.pruned).toBe(3);
    expect(prunes).toBe(2);
  });
});

describe('mechanism registry', () => {
  it('seeds gate-pass-reuse once, scope-keyed (R-3)', () => {
    expect(getDegradationMechanism('gate-pass-reuse')).toMatchObject({
      scopeKeyed: true,
      observationWorkspaceId: 'default',
      observationProcessTag: `gate-reuse:green-checkpoint:${operatorHomeHarnessSlug()}`,
    });
    expect(() => registerDegradationMechanism({ mechanism: 'gate-pass-reuse', description: 'dup' })).toThrow(/already registered/);
  });

  it('does not pin scoped gate-pass-reuse alarms to a historical run', () => {
    const mechanism = getDegradationMechanism('gate-pass-reuse');
    if (!mechanism) throw new Error('gate-pass-reuse registration is missing');
    expect(mechanism.description).not.toContain('762a13a6');
    expect(mechanism.description).not.toMatch(/\brun [a-f0-9]{8}\b/i);
  });

  it('registers and unregisters a test mechanism', () => {
    registerDegradationMechanism({ mechanism: 'unit-test-only', description: 'x' });
    expect(getDegradationMechanism('unit-test-only')).toBeDefined();
    _unregisterDegradationMechanismForTests('unit-test-only');
    expect(getDegradationMechanism('unit-test-only')).toBeUndefined();
  });

  it('uses the ambient workspace for unpinned readers while preserving an explicit pin', () => {
    runWithWorkspace('workspace-from-context', () => {
      expect(resolveObservationWorkspaceId({})).toBe('workspace-from-context');
      expect(resolveObservationWorkspaceId({ observationWorkspaceId: 'explicit-workspace' }))
        .toBe('explicit-workspace');
    });
  });
});

describe('signal-actor-registry entry (R-8)', () => {
  it('names the actionable-condition bridge as its actor, with no waiver', () => {
    const entry = getSignal(DEGRADATION_WATCHDOG_SIGNAL_ID);
    expect(entry).toBeDefined();
    expect(entry?.actingConsumer).toBe(CONDITION_BRIDGE_ACTOR);
    expect(entry?.waiver).toBeUndefined();
    expect(entry && isSignalCovered(entry)).toBe(true);
  });
});
