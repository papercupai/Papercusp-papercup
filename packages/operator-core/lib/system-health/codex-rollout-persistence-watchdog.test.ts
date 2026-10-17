import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleMocks = vi.hoisted(() => ({
  endSession: vi.fn(async () => undefined),
  cancelInboxWake: vi.fn(async () => 0),
  cancelClaimable: vi.fn(async () => 0),
  retireLifecycleWatches: vi.fn(async () => ({ awaits: 0, predicateWatches: 0 })),
  releaseWorkItems: vi.fn(async () => ({ releasedIds: [], claimsCleared: 0 })),
  notifyAttention: vi.fn(async () => undefined),
  broadcast: vi.fn(async () => true),
  resolve: vi.fn(async () => true),
}));

vi.mock('../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adv-sessions')>()),
  markAdvSessionEnded: lifecycleMocks.endSession,
}));
vi.mock('../events/await/store', () => ({
  cancelInboxWakeAwaits: lifecycleMocks.cancelInboxWake,
  cancelClaimableAwaits: lifecycleMocks.cancelClaimable,
  retireWatchesForReapedOwners: lifecycleMocks.retireLifecycleWatches,
}));
vi.mock('../work-item-lease-release', () => ({
  releaseAllWorkItemLeasesForOwner: lifecycleMocks.releaseWorkItems,
}));
vi.mock('../attention-notify', () => ({ notifyAttention: lifecycleMocks.notifyAttention }));
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: lifecycleMocks.broadcast }));
vi.mock('../agent-tools/coordination/tools/conditions', () => ({
  computeConditionStates: (envelopes: Array<Record<string, unknown>>) => {
    type FixtureState = {
      condition_key: string; open: boolean; open_since: string | null; first_seen: string;
      last_seen: string; alarm_count: number; one_shot: boolean; resolved_at: string | null;
    };
    const states = new Map<string, FixtureState>();
    for (const envelope of envelopes) {
      const ts = typeof envelope.ts === 'string' ? envelope.ts : null;
      if (!ts) continue;
      const resolveKeys = new Set<string>();
      if (typeof envelope.resolves_condition === 'string' && envelope.resolves_condition) {
        resolveKeys.add(envelope.resolves_condition);
      }
      if (Array.isArray(envelope.resolves_conditions)) {
        for (const conditionKey of envelope.resolves_conditions) {
          if (typeof conditionKey === 'string' && conditionKey) resolveKeys.add(conditionKey);
        }
      }
      if (resolveKeys.size > 0) {
        for (const conditionKey of resolveKeys) {
          const state = states.get(conditionKey);
          if (!state) {
            states.set(conditionKey, { condition_key: conditionKey, open: false, open_since: null,
              first_seen: ts, last_seen: ts, alarm_count: 0, one_shot: false, resolved_at: ts });
          } else if (!state.resolved_at || ts > state.resolved_at) {
            state.resolved_at = ts;
            if (state.open_since !== null && ts >= state.open_since) state.open_since = null;
          }
        }
        continue;
      }

      const conditionKey = envelope.condition_key;
      if (typeof conditionKey !== 'string' || !conditionKey) continue;
      const state = states.get(conditionKey);
      if (!state) {
        states.set(conditionKey, { condition_key: conditionKey, open: true, open_since: ts,
          first_seen: ts, last_seen: ts, alarm_count: 1, one_shot: envelope.one_shot === true,
          resolved_at: null });
      } else {
        state.alarm_count += 1;
        if (state.open_since === null) state.open_since = ts;
        if (ts >= state.last_seen) {
          state.last_seen = ts;
          state.one_shot = envelope.one_shot === true;
        }
      }
    }
    return [...states.values()].map((state) => {
      state.open = state.alarm_count > 0 && (!state.resolved_at || state.last_seen > state.resolved_at);
      if (!state.open) state.open_since = null;
      else if (state.open_since === null) state.open_since = state.last_seen;
      return state;
    });
  },
  readConditionEnvelopes: async () => [],
}));
vi.mock('../agent-tools/coordination/log', () => ({
  coordScopeReady: async () => undefined,
  coordScopeWorkspace: () => 'workspace:1',
}));

import {
  checkCodexRolloutPersistence,
  codexRolloutConditionKey,
  classifyCodexProviderError,
  evaluateCodexRolloutPersistence,
  evaluateCodexProviderFailureRecurrence,
  latestCodexProviderErrorAfter,
  providerFailureDisposition,
  readCodexRolloutTail,
  scanCodexProviderFailureTail,
  type CodexRolloutPersistenceSnapshot,
  type CodexRolloutPersistenceWatchdogOptions,
} from './codex-rollout-persistence-watchdog';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const base: CodexRolloutPersistenceSnapshot = {
  sessionId: '11801',
  ownerId: 'su-owner',
  pidAlive: true,
  historyMtimeMs: NOW - 60_000,
  rolloutMtimeMs: NOW - 60_000,
};

describe('evaluateCodexRolloutPersistence', () => {
  it('alarms when a live Codex process has fresh history but no rollout file', () => {
    const verdict = evaluateCodexRolloutPersistence({ ...base, rolloutMtimeMs: null }, NOW);
    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toContain('no rollout JSONL exists');
  });

  it('alarms when history is fresh but the rollout falls behind the lag ceiling', () => {
    const verdict = evaluateCodexRolloutPersistence(
      { ...base, rolloutMtimeMs: NOW - 17 * 60_000 },
      NOW,
    );
    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toContain('behind history.jsonl');
  });

  it('does not alarm for an idle session, a dead process, or a fresh rollout', () => {
    expect(evaluateCodexRolloutPersistence({ ...base, historyMtimeMs: NOW - 6 * 60_000 }, NOW).stalled).toBe(false);
    expect(evaluateCodexRolloutPersistence({ ...base, pidAlive: false, rolloutMtimeMs: null }, NOW).stalled).toBe(false);
    expect(evaluateCodexRolloutPersistence({ ...base, rolloutMtimeMs: NOW - 2 * 60_000 }, NOW).stalled).toBe(false);
  });
});

describe('P-014 original Codex persistence and provider condition episodes', () => {
  let root: string, history: string, rollout: string;
  let previousHome: string | undefined;
  let now: number;
  const row = { id: 42, owner_id: 'owner:42', pid: 123, workspace_id: 'workspace:1' };
  let rows: typeof row[];
  let open: Array<{ conditionKey: string; openedAtMs: number }>;
  let updates: unknown[][];
  let legacyFailure: boolean;
  let coalesced: boolean;
  let endedSessionIds: number[];
  let conditionEvents: Array<{ body: unknown }>;
  let conditionQuerySeen: boolean;
  let conditionQueryText: string | null;
  const broadcast = vi.fn(async (_event: { conditionKey?: string; oneShot?: boolean }) => true);
  const resolve = vi.fn(async (_event: { conditionKey: string }) => true);
  let opts: CodexRolloutPersistenceWatchdogOptions;
  const key = (kind: 'persistence' | 'provider') => codexRolloutConditionKey(kind, row.workspace_id, '42', row.owner_id);
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('');
    if (query.includes('SELECT id, coord_owner_id AS owner_id')) return rows;
    if (query.includes('SELECT id') && query.includes('ended_at IS NOT NULL')) {
      return endedSessionIds.map(id => ({ id }));
    }
    if (query.includes('FROM harness_shared.coord_event_log') && query.includes('ORDER BY id ASC')) {
      conditionQuerySeen = true;
      conditionQueryText = query;
      return conditionEvents;
    }
    if (query.includes('INSERT INTO harness_shared.harness_escalations')) {
      expect(broadcast).toHaveBeenCalled();
      if (legacyFailure) throw new Error('legacy write failed');
      return coalesced ? [] : [{ phase: values[0] }];
    }
    if (query.includes('SELECT phase')) return [{ phase: values[0] === 'codex-rollout-stall:%'
      ? 'codex-rollout-stall:42' : 'codex-provider-failure:42' }];
    if (query.includes('UPDATE harness_shared.harness_escalations')) updates.push(values);
    return [];
  }) as unknown as import('postgres').Sql;
  const pass = () => checkCodexRolloutPersistence(sql, opts);
  const setTimes = async (historyAt: number, rolloutAt: number) => {
    await utimes(history, new Date(historyAt), new Date(historyAt));
    await utimes(rollout, new Date(rolloutAt), new Date(rolloutAt));
  };
  const success = async (at: number = now) => {
    await writeFile(rollout, JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg',
      payload: { type: 'task_complete', status: 'completed' } }) + '\n');
    await setTimes(now, now);
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    now = Date.now() + 1000;
    rows = [{ ...row }]; open = []; updates = []; legacyFailure = false; coalesced = true; endedSessionIds = [];
    conditionEvents = []; conditionQuerySeen = false; conditionQueryText = null;
    broadcast.mockResolvedValue(true); resolve.mockResolvedValue(true);
    root = await mkdtemp(join(tmpdir(), 'codex-condition-'));
    previousHome = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
    const day = join(root, 'session-42', 'sessions', '2026', '10', '12');
    await mkdir(day, { recursive: true });
    history = join(root, 'session-42', 'history.jsonl');
    rollout = join(day, 'rollout-original.jsonl');
    await writeFile(history, '{}\n');
    await writeFile(rollout, ['t1', 't2', 't3'].map(turn => providerTaskCompleteLine(turn)).join('\n') + '\n');
    await setTimes(now - 60_000, now - 17 * 60_000);
    opts = { now: () => now, pidAlive: () => true, readOpenConditions: async () => open,
      rail: { broadcast, resolve } };
  });
  afterEach(async () => {
    if (previousHome === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
    else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = previousHome;
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const remember = () => { open = ['persistence', 'provider'].map(kind => ({
    conditionKey: key(kind as 'persistence' | 'provider'), openedAtMs: now - 1000,
  })); };

  it('opens both exact one-shot keys before coalescing and recovers after restart with measured files and a successful terminal', async () => {
    expect((await pass()).alarmed).toEqual([]);
    expect(broadcast.mock.calls.map(([event]) => event.conditionKey)).toEqual([key('persistence'), key('provider')]);
    expect(broadcast.mock.calls.every(([event]) => event.oneShot === true)).toBe(true);
    expect(lifecycleMocks.notifyAttention).not.toHaveBeenCalled();
    remember(); await success();
    const result = await pass();
    expect(resolve.mock.calls.map(([event]) => event.conditionKey)).toEqual([key('persistence'), key('provider')]);
    expect(result.recovered).toEqual(['42']); expect(result.providerRecovered).toEqual(['42']);
    expect(updates).toHaveLength(2);
    expect(lifecycleMocks.endSession).not.toHaveBeenCalled();
  });

  it.each(['missing-row', 'foreign-owner', 'foreign-workspace', 'duplicate', 'invalid-id', 'invalid-pid'])(
    'preserves durable episodes for %s registration', async mode => {
      remember(); await success();
      if (mode === 'missing-row') rows = [];
      if (mode === 'foreign-owner') rows = [{ ...row, owner_id: 'foreign' }];
      if (mode === 'foreign-workspace') rows = [{ ...row, workspace_id: 'foreign' }];
      if (mode === 'duplicate') rows = [{ ...row }, { ...row }];
      if (mode === 'invalid-id') rows = [{ ...row, id: true as unknown as number }];
      if (mode === 'invalid-pid') rows = [{ ...row, pid: Number.NaN }];
      await pass(); expect(resolve).not.toHaveBeenCalled(); expect(updates).toEqual([]);
    });

  it('resolves one-shot provider alarms only after their Codex adv session is durably ended', async () => {
    const providerKey = key('provider');
    rows = [];
    endedSessionIds = [42];
    open = [{ conditionKey: providerKey, openedAtMs: now - 60_000 }];

    const result = await pass();

    expect(resolve).toHaveBeenCalledWith({
      conditionKey: providerKey,
      summary: 'codex-rollout-watchdog recovered',
    });
    expect(result.providerRecovered).toEqual(['42']);
    expect(updates).toHaveLength(1);
    expect(lifecycleMocks.endSession).not.toHaveBeenCalled();
    expect(lifecycleMocks.releaseWorkItems).not.toHaveBeenCalled();
  });

  it('passes the active SQL client and measured time to the condition-reader substitute', async () => {
    rows = [];
    endedSessionIds = [42];
    const providerKey = key('provider');
    const readOpenConditions = vi.fn(async (client: unknown, measuredNow: number) => {
      expect(client).toBe(sql);
      expect(measuredNow).toBe(now);
      return [{ conditionKey: providerKey, openedAtMs: measuredNow - 60_000 }];
    });
    opts = { ...opts, readOpenConditions };

    const result = await pass();

    expect(readOpenConditions).toHaveBeenCalledExactlyOnceWith(sql, now);
    expect(result.providerRecovered).toEqual(['42']);
    expect(resolve).toHaveBeenCalledWith({
      conditionKey: providerKey,
      summary: 'codex-rollout-watchdog recovered',
    });
  });

  it('finds an ended one-shot episode outside the generic 25k condition window', async () => {
    const providerKey = key('provider');
    rows = [];
    endedSessionIds = [42];
    conditionEvents = [
      { body: { ts: new Date(now - 4_000).toISOString(), condition_key: providerKey,
        one_shot: true, summary: 'Codex provider failures repeated' } },
    ];
    opts = { ...opts, readOpenConditions: undefined };

    const result = await pass();

    expect(conditionQuerySeen).toBe(true);
    expect(conditionQueryText).toContain("body ? 'resolves_conditions'");
    const { computeConditionStates } = await import('../agent-tools/coordination/tools/conditions');
    expect(computeConditionStates(conditionEvents.map((event) => event.body as Record<string, unknown>)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ condition_key: providerKey, open: true })]));
    expect(resolve).toHaveBeenCalledWith({
      conditionKey: providerKey,
      summary: 'codex-rollout-watchdog recovered',
    });
    expect(result.providerRecovered).toEqual(['42']);
  });

  it('includes batch-resolution envelopes when folding Codex condition episodes', async () => {
    const providerKey = key('provider');
    rows = [];
    endedSessionIds = [42];
    conditionEvents = [
      { body: { ts: new Date(now - 8_000).toISOString(), condition_key: providerKey,
        one_shot: true, summary: 'Codex provider failures repeated' } },
      { body: { ts: new Date(now - 4_000).toISOString(), resolves_conditions: [providerKey],
        summary: 'Codex provider failure resolved' } },
    ];
    opts = { ...opts, readOpenConditions: undefined };

    const result = await pass();

    expect(conditionQuerySeen).toBe(true);
    expect(conditionQueryText).toContain("body ? 'resolves_conditions'");
    const { computeConditionStates } = await import('../agent-tools/coordination/tools/conditions');
    expect(computeConditionStates(conditionEvents.map((event) => event.body as Record<string, unknown>)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ condition_key: providerKey, open: false })]));
    expect(resolve).not.toHaveBeenCalled();
    expect(result.providerRecovered).toEqual([]);
  });

  it.each(['missing-history', 'missing-rollout', 'partial-directory', 'dead-pid', 'idle-history', 'future-mtime', 'failed-episodes'])(
    'preserves persistence recovery for %s evidence', async mode => {
      remember(); await success();
      // A missing history does not invalidate independently measured provider success.
      open = open.filter(episode => episode.conditionKey === key('persistence'));
      if (mode === 'missing-history') await rm(history);
      if (mode === 'missing-rollout') await rm(rollout);
      if (mode === 'partial-directory') await writeFile(join(root, 'session-42', 'sessions', 'not-a-directory'), 'x');
      if (mode === 'dead-pid') opts.pidAlive = () => false;
      if (mode === 'idle-history') await setTimes(now - 6 * 60_000, now);
      if (mode === 'future-mtime') await setTimes(now, now + 60_000);
      if (mode === 'failed-episodes') opts.readOpenConditions = async () => { throw new Error('condition read failed'); };
      await pass(); expect(resolve).not.toHaveBeenCalled(); expect(updates).toEqual([]);
    });

  it.each(['empty-tail', 'failed-tail', 'throwing-tail', 'old-success', 'future-success', 'undated-success', 'invalid-open-time'])(
    'preserves provider episodes for %s evidence', async mode => {
      const warnings = mode === 'throwing-tail'
        ? vi.spyOn(console, 'warn').mockImplementation(() => undefined) : null;
      remember(); open = open.filter(episode => episode.conditionKey === key('provider')); await success();
      if (mode === 'empty-tail') await writeFile(rollout, '{}\n');
      if (mode === 'failed-tail') opts.readRolloutTail = async () => null;
      if (mode === 'throwing-tail') opts.readRolloutTail = async () => { throw new Error('tail failed'); };
      if (mode === 'old-success') await success(now - 2000);
      if (mode === 'future-success') await success(now + 60_000);
      if (mode === 'undated-success') await writeFile(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }));
      if (mode === 'invalid-open-time') open[0]!.openedAtMs = Number.NaN;
      await setTimes(now, now);
      await pass(); expect(resolve).not.toHaveBeenCalled(); expect(updates).toEqual([]);
      if (warnings) expect(warnings).toHaveBeenCalledWith(
        '[codex-rollout-watchdog] provider tail read failed for session 42: tail failed',
      );
    });

  it('measures the clock after asynchronous file reads rather than treating writes during the sweep as future evidence', async () => {
    await setTimes(now, now);
    opts.now = vi.fn().mockReturnValueOnce(now - 1000).mockReturnValue(now);
    expect((await pass()).providerFailureSessionIds).toEqual(['42']);
    expect(opts.now).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: key('provider') }));
  });

  it('compares fractional filesystem mtimes at the whole-millisecond clock precision', async () => {
    const at = now + 0.5;
    await utimes(rollout, at / 1000, at / 1000);
    expect((await pass()).providerFailureSessionIds).toEqual(['42']);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: key('provider') }));
  });

  it('keeps delivery legs independent when the legacy insert or condition broadcast fails', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    legacyFailure = true;
    await pass(); expect(broadcast).toHaveBeenCalledTimes(2);
    expect(warnings).not.toHaveBeenCalled();
    legacyFailure = false; coalesced = false;
    broadcast.mockRejectedValue(new Error('condition rail unavailable'));
    await pass(); expect(lifecycleMocks.notifyAttention).toHaveBeenCalledTimes(2);
    expect(warnings.mock.calls).toEqual([
      ['[codex-rollout-watchdog] ALARM: owner:42 (session 42)'],
      ['[codex-rollout-watchdog] PROVIDER ALARM: owner:42 (session 42)'],
    ]);
    expect(lifecycleMocks.endSession).not.toHaveBeenCalled();
  });

  it('does not re-alarm on a provider failure streak whose latest terminal is stale', async () => {
    const staleAt = new Date(now - 3 * 60 * 60_000).toISOString();
    await writeFile(rollout, [
      providerTaskCompleteLine('old-1', 'usageLimitExceeded', 'quota exceeded', staleAt),
      providerTaskCompleteLine('old-2', 'usageLimitExceeded', 'quota exceeded', staleAt),
      providerTaskCompleteLine('old-3', 'usageLimitExceeded', 'quota exceeded', staleAt),
    ].join('\n') + '\n');
    await setTimes(now, now);
    const result = await pass();
    expect(result.providerFailureSessionIds).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not retire legacy markers after failed resolution', async () => {
    remember(); await success(); resolve.mockResolvedValue(false);
    await pass(); expect(resolve).toHaveBeenCalledTimes(2); expect(updates).toEqual([]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('refuses invalid threshold %s as recovery evidence', async value => {
    remember(); open = open.filter(episode => episode.conditionKey === key('persistence')); await success();
    opts.rolloutLagMs = value;
    await pass(); expect(resolve).not.toHaveBeenCalled(); expect(updates).toEqual([]);
  });
});

function providerErrorLine(
  turn: string,
  code = 'usageLimitExceeded',
  message = 'provider failed',
  timestamp = new Date().toISOString(),
): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'error', codex_error_info: code, message, turn_id: turn },
  });
}

function providerTaskCompleteLine(
  turn: string,
  code = 'usageLimitExceeded',
  message = 'provider failed',
  timestamp = new Date().toISOString(),
): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      status: 'error',
      turn_id: turn,
      error: { codex_error_info: code, message },
    },
  });
}

describe('native Codex provider-error recurrence', () => {
  it('classifies usage-limit and nested unauthorized records with bounded evidence', () => {
    const message = 'Your access token could not be refreshed because you have since logged out or signed in to another account.';
    const error = classifyCodexProviderError(providerTaskCompleteLine('t-1', 'unauthorized', message));
    expect(error).toMatchObject({
      source: 'event_msg:task_complete',
      code: 'unauthorized',
      rawCode: 'unauthorized',
      message,
      turnKey: 't-1',
    });
    expect(classifyCodexProviderError('{not-json')).toBeNull();
    expect(classifyCodexProviderError(JSON.stringify({ type: 'response_item', payload: { type: 'error' } }))).toBeNull();
  });

  it('counts an error/task_complete pair as one failed turn and trips the threshold', () => {
    const lines = [
      providerErrorLine('t-1', 'usageLimitExceeded'),
      providerTaskCompleteLine('t-1', 'usageLimitExceeded'),
      providerErrorLine('t-2', 'usageLimitExceeded'),
      providerTaskCompleteLine('t-2', 'usageLimitExceeded'),
      providerErrorLine('t-3', 'usageLimitExceeded'),
      providerTaskCompleteLine('t-3', 'usageLimitExceeded'),
    ];
    const recurrence = evaluateCodexProviderFailureRecurrence(lines);
    expect(recurrence).toMatchObject({ consecutiveFailures: 3, threshold: 3, dead: true });
    expect(recurrence.failures).toHaveLength(3);
    expect(recurrence.latest?.source).toBe('event_msg:task_complete');
  });

  it('returns only a structured provider error after the loop fire and clears it on a later success', () => {
    const beforeFire = JSON.stringify({
      timestamp: '2026-08-27T00:00:01Z',
      type: 'event_msg',
      payload: { type: 'error', codex_error_info: 'usageLimitExceeded', turn_id: 'old' },
    });
    const afterFire = JSON.stringify({
      timestamp: '2026-08-27T00:01:01Z',
      type: 'event_msg',
      payload: { type: 'error', codex_error_info: 'usageLimitExceeded', turn_id: 'current' },
    });
    const success = JSON.stringify({
      timestamp: '2026-08-27T00:02:01Z',
      type: 'event_msg',
      payload: { type: 'task_complete', status: 'completed' },
    });
    const fireMs = Date.parse('2026-08-27T00:01:00Z');

    expect(latestCodexProviderErrorAfter(beforeFire, fireMs)).toBeNull();
    expect(latestCodexProviderErrorAfter(afterFire, fireMs)?.code).toBe('usage_limit_exceeded');
    expect(latestCodexProviderErrorAfter(`${afterFire}\n${success}`, fireMs)).toBeNull();
  });

  it('resets the trailing streak after a successful terminal and parses a bounded tail', () => {
    const success = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', status: 'completed' } });
    const recurrence = scanCodexProviderFailureTail(
      [providerErrorLine('old-1'), providerTaskCompleteLine('old-1'), success, providerErrorLine('new-1')].join('\n'),
      { consecutiveFailures: 2 },
    );
    expect(recurrence).toMatchObject({ consecutiveFailures: 1, threshold: 2, dead: false });
    expect(recurrence.latest?.turnKey).toBe('new-1');
  });

  it('classifies recovery without making the provider observer a lifecycle killer', () => {
    expect(providerFailureDisposition(classifyCodexProviderError(providerTaskCompleteLine('t-1', 'server_overloaded'))!)).toBe('backoff');
    expect(providerFailureDisposition(classifyCodexProviderError(providerTaskCompleteLine('t-2', 'unauthorized'))!)).toBe('park');
    expect(providerFailureDisposition(classifyCodexProviderError(providerTaskCompleteLine('t-3', 'usageLimitExceeded'))!)).toBe('park');
    expect(providerFailureDisposition(classifyCodexProviderError(providerTaskCompleteLine('t-4', 'context_window_exceeded', 'prompt too long'))!)).toBe('carry_recovery');
  });
});

describe('readCodexRolloutTail', () => {
  it('reads only the requested suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-watchdog-tail-'));
    const path = join(root, 'rollout.jsonl');
    try {
      await writeFile(path, '0123456789', 'utf8');
      await expect(readCodexRolloutTail(path, 4)).resolves.toBe('6789');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('checkCodexRolloutPersistence provider preservation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleMocks.endSession.mockResolvedValue(undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('deduplicates the provider escalation while preserving the session and owner surfaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-watchdog-runtime-'));
    const previousHome = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
    const day = join(root, 'session-42', 'sessions', '2026', '08', '27');
    await mkdir(day, { recursive: true });
    const rolloutPath = join(day, 'rollout-2026-08-27T00-00-00-session-42.jsonl');
    await writeFile(join(root, 'session-42', 'history.jsonl'), '{}\n', 'utf8');
    await writeFile(
      rolloutPath,
      [
        providerErrorLine('t-1'), providerTaskCompleteLine('t-1'),
        providerErrorLine('t-2'), providerTaskCompleteLine('t-2'),
        providerErrorLine('t-3'), providerTaskCompleteLine('t-3'),
      ].join('\n') + '\n',
      'utf8',
    );
    const queries: string[] = [];
    let escalationClaimed = false;
    const sql = (async (strings: TemplateStringsArray): Promise<unknown[]> => {
      const query = strings.join('');
      queries.push(query);
      if (query.includes('SELECT id, coord_owner_id AS owner_id')) {
        return [{ id: 42, owner_id: 'owner-42', pid: 123, workspace_id: 'workspace-1' }];
      }
      if (query.includes('INSERT INTO harness_shared.harness_escalations')) {
        if (!escalationClaimed) {
          escalationClaimed = true;
          return [{ phase: 'codex-provider-failure:42' }];
        }
        return [];
      }
      return [];
    }) as unknown;

    try {
      const providerConditionKey = codexRolloutConditionKey('provider', 'workspace-1', '42', 'owner-42');
      let providerConditionOpen = false;
      const opts: CodexRolloutPersistenceWatchdogOptions = {
        pidAlive: () => true,
        readOpenConditions: async () => providerConditionOpen
          ? [{ conditionKey: providerConditionKey, openedAtMs: Date.now() - 1000 }]
          : [],
      };
      const result = await checkCodexRolloutPersistence(sql as never, opts);
      providerConditionOpen = true;
      const repeated = await checkCodexRolloutPersistence(sql as never, opts);
      expect(result.providerFailureSessionIds).toEqual(['42']);
      expect(result.providerAlarmed).toEqual(['42']);
      expect(result.providerPreservedSessionIds).toEqual(['42']);
      expect(result.providerEndedSessionIds).toEqual([]);
      expect(result.providerCleanupFailed).toEqual([]);
      expect(repeated.providerFailureSessionIds).toEqual(['42']);
      expect(repeated.providerAlarmed).toEqual([]);
      expect(lifecycleMocks.broadcast).toHaveBeenCalledTimes(1);
      expect(lifecycleMocks.endSession).not.toHaveBeenCalled();
      expect(lifecycleMocks.cancelInboxWake).not.toHaveBeenCalled();
      expect(lifecycleMocks.cancelClaimable).not.toHaveBeenCalled();
      expect(lifecycleMocks.retireLifecycleWatches).not.toHaveBeenCalled();
      expect(lifecycleMocks.releaseWorkItems).not.toHaveBeenCalled();
      expect(lifecycleMocks.notifyAttention).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('[codex-rollout-watchdog] PROVIDER ALARM: owner-42 (session 42)');
      expect(queries.filter((query) => query.includes('INSERT INTO harness_shared.harness_escalations'))).toHaveLength(2);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
      else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects repeated provider failures for an open PID-less psu/carry-respawn session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-watchdog-pidless-'));
    const previousHome = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
    const day = join(root, 'session-44', 'sessions', '2026', '08', '27');
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, 'rollout-2026-08-27T00-00-00-session-44.jsonl'),
      [
        providerTaskCompleteLine('t-1', 'internal_server_error', 'high demand'),
        providerTaskCompleteLine('t-2', 'internal_server_error', 'high demand'),
        providerTaskCompleteLine('t-3', 'internal_server_error', 'high demand'),
      ].join('\n') + '\n',
      'utf8',
    );
    const sql = (async (strings: TemplateStringsArray): Promise<unknown[]> => {
      const query = strings.join('');
      if (query.includes('SELECT id, coord_owner_id AS owner_id')) {
        return [{ id: 44, owner_id: 'owner-44', pid: null, workspace_id: 'workspace-1' }];
      }
      if (query.includes('INSERT INTO harness_shared.harness_escalations')) {
        return [{ phase: 'codex-provider-failure:44' }];
      }
      return [];
    }) as unknown;

    try {
      const result = await checkCodexRolloutPersistence(sql as never, {
        pidAlive: () => {
          throw new Error('a NULL pid must not be probed');
        },
      });
      expect(result.providerFailureSessionIds).toEqual(['44']);
      expect(result.providerAlarmed).toEqual(['44']);
      expect(result.providerPreservedSessionIds).toEqual(['44']);
      expect(result.providerEndedSessionIds).toEqual([]);
      expect(lifecycleMocks.endSession).not.toHaveBeenCalled();
      expect(lifecycleMocks.releaseWorkItems).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
      else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never invokes lifecycle cleanup even when provider failures recur', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-watchdog-end-failure-'));
    const previousHome = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
    const day = join(root, 'session-43', 'sessions', '2026', '08', '27');
    await mkdir(day, { recursive: true });
    const rolloutPath = join(day, 'rollout-2026-08-27T00-00-00-session-43.jsonl');
    await writeFile(
      rolloutPath,
      [
        providerErrorLine('t-1'), providerTaskCompleteLine('t-1'),
        providerErrorLine('t-2'), providerTaskCompleteLine('t-2'),
        providerErrorLine('t-3'), providerTaskCompleteLine('t-3'),
      ].join('\n') + '\n',
      'utf8',
    );
    try {
      const result = await checkCodexRolloutPersistence((async (strings: TemplateStringsArray): Promise<unknown[]> => {
        const query = strings.join('');
        if (query.includes('SELECT id, coord_owner_id AS owner_id')) {
          return [{ id: 43, owner_id: 'owner-43', pid: 124, workspace_id: 'workspace-1' }];
        }
        return [];
      }) as never, { pidAlive: () => true });
      expect(result.providerFailureSessionIds).toEqual(['43']);
      expect(result.providerPreservedSessionIds).toEqual(['43']);
      expect(result.providerEndedSessionIds).toEqual([]);
      expect(lifecycleMocks.endSession).not.toHaveBeenCalled();
      expect(lifecycleMocks.cancelInboxWake).not.toHaveBeenCalled();
      expect(lifecycleMocks.cancelClaimable).not.toHaveBeenCalled();
      expect(lifecycleMocks.retireLifecycleWatches).not.toHaveBeenCalled();
      expect(lifecycleMocks.releaseWorkItems).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
      else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('WI-6554700010008587 provider tail scan cost', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleMocks.endSession.mockResolvedValue(undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('parses only event_msg lines and tolerates non-object JSON without changing the verdict', () => {
    const noise = [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'mentions "event_msg" and task_complete' } }),
      'null',
      '"event_msg"',
      '[1,2]',
      '{"type":"event_msg"',
    ];
    const failures = [
      providerErrorLine('t-1'), providerTaskCompleteLine('t-1'),
      providerErrorLine('t-2'), providerTaskCompleteLine('t-2'),
      providerErrorLine('t-3'), providerTaskCompleteLine('t-3'),
    ];
    const interleaved = failures.flatMap((line) => [...noise, line]);
    const clean = evaluateCodexProviderFailureRecurrence(failures);
    const noisy = evaluateCodexProviderFailureRecurrence(interleaved);
    expect(noisy).toMatchObject({ consecutiveFailures: 3, dead: true });
    expect(noisy.consecutiveFailures).toBe(clean.consecutiveFailures);
    expect(noisy.failures.map((f) => f.turnKey)).toEqual(clean.failures.map((f) => f.turnKey));
    for (const line of noise) expect(classifyCodexProviderError(line)).toBeNull();
  });

  it('re-reads a rollout only when its size or mtime changes, and prunes vanished rollouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-watchdog-cache-'));
    const previousHome = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
    const day = join(root, 'session-42', 'sessions', '2026', '08', '27');
    await mkdir(day, { recursive: true });
    const rolloutPath = join(day, 'rollout-2026-08-27T00-00-00-session-42.jsonl');
    await writeFile(join(root, 'session-42', 'history.jsonl'), '{}\n', 'utf8');
    const failing = [
      providerErrorLine('t-1'), providerTaskCompleteLine('t-1'),
      providerErrorLine('t-2'), providerTaskCompleteLine('t-2'),
      providerErrorLine('t-3'), providerTaskCompleteLine('t-3'),
    ].join('\n') + '\n';
    await writeFile(rolloutPath, failing, 'utf8');
    let rows: unknown[] = [{ id: 42, owner_id: 'owner-42', pid: null, workspace_id: 'workspace-1' }];
    const sql = (async (strings: TemplateStringsArray): Promise<unknown[]> => {
      const query = strings.join('');
      if (query.includes('SELECT id, coord_owner_id AS owner_id')) return rows;
      if (query.includes('INSERT INTO harness_shared.harness_escalations')) return [{ phase: 'codex-provider-failure:42' }];
      return [];
    }) as unknown;
    const reads: string[] = [];
    const readRolloutTail: typeof readCodexRolloutTail = async (path, maxBytes) => {
      reads.push(path);
      return readCodexRolloutTail(path, maxBytes);
    };
    const cache = new Map();
    const pass = () =>
      checkCodexRolloutPersistence(sql as never, { pidAlive: () => false, readRolloutTail, providerTailScanCache: cache });

    try {
      expect((await pass()).providerFailureSessionIds).toEqual(['42']);
      expect(reads).toHaveLength(1);

      // Unchanged rollout: the cached verdict is reused and the tail is not read again.
      expect((await pass()).providerFailureSessionIds).toEqual(['42']);
      expect(reads).toHaveLength(1);

      // An appended success changes the size: the tail is re-read and the streak resets.
      await writeFile(
        rolloutPath,
        failing + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', status: 'completed' } }) + '\n',
        'utf8',
      );
      expect((await pass()).providerFailureSessionIds).toEqual([]);
      expect(reads).toHaveLength(2);

      // A session that is no longer open drops out of the cache.
      expect(cache.size).toBe(1);
      rows = [];
      await pass();
      expect(cache.size).toBe(0);

      // Without a cache every pass reads the tail, as before.
      rows = [{ id: 42, owner_id: 'owner-42', pid: null, workspace_id: 'workspace-1' }];
      await checkCodexRolloutPersistence(sql as never, { pidAlive: () => false, readRolloutTail });
      await checkCodexRolloutPersistence(sql as never, { pidAlive: () => false, readRolloutTail });
      expect(reads).toHaveLength(4);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
      else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});
