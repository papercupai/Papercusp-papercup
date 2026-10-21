import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionNotifyResult, ReplaySafeAttentionNotifyInput } from '../attention-notify';
import type { SevereEventBroadcast } from '../severe-event-broadcast';
import type { GreenMainSloQueue } from './green-main-slo';
import { checkGreenMainSlo, fileRecurringNonVerdictReason, parseLastGreenAtMs, runGreenMainSloPass, type GreenMainSloPassDeps } from './green-main-slo-watchdog';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 2, 0, 0);

const mocks = vi.hoisted(() => ({
  readVerdictRateWindow: vi.fn(),
  readGateNonVerdictReasons: vi.fn(),
  readGateOwnership: vi.fn(),
  createOneWorkItem: vi.fn(),
  claimWorkItem: vi.fn(),
  getWorkItem: vi.fn(),
  readFrozenCandidateRepairQueueState: vi.fn(),
  notifyAttentionOnce: vi.fn(),
  recordWatchdogPassOutcome: vi.fn(),
  broadcastSevereEvent: vi.fn(async () => true),
  readConditionEnvelopes: vi.fn(async () => []),
}));
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: mocks.broadcastSevereEvent }));
vi.mock('../agent-tools/coordination/tools/conditions', () => ({
  readConditionEnvelopes: mocks.readConditionEnvelopes,
  computeConditionStates: () => [],
}));
vi.mock('./gate-verdict-rate-alarm', () => ({ readVerdictRateWindow: mocks.readVerdictRateWindow }));
vi.mock('./gate-fire-ledger', () => ({ readGateNonVerdictReasons: mocks.readGateNonVerdictReasons }));
vi.mock('../harness/routines/release-actions', () => ({
  readFrozenCandidateRepairQueueState: mocks.readFrozenCandidateRepairQueueState,
}));
vi.mock('../attention-notify', () => ({ notifyAttentionOnce: mocks.notifyAttentionOnce }));
vi.mock('./watchdog-health', () => ({ recordWatchdogPassOutcome: mocks.recordWatchdogPassOutcome }));
vi.mock('../coord/gate-ownership', async (original) => ({
  ...await original<typeof import('../coord/gate-ownership')>(), readGateOwnership: mocks.readGateOwnership,
}));
vi.mock('../agent-tools/work_items/_create-core', () => ({ createOneWorkItem: mocks.createOneWorkItem }));
vi.mock('../work-items', () => ({ claimWorkItem: mocks.claimWorkItem, getWorkItem: mocks.getWorkItem }));

/** A durable once-per-key store, the contract notifyAttentionOnce gives a stable dedupeKey. */
function onceStore() {
  const seen = new Set<string>();
  const sent: ReplaySafeAttentionNotifyInput[] = [];
  const notifyOnce = vi.fn(async (input: ReplaySafeAttentionNotifyInput): Promise<AttentionNotifyResult> => {
    const deduped = seen.has(input.dedupeKey);
    if (!deduped) {
      seen.add(input.dedupeKey);
      sent.push(input);
    }
    return { recordId: deduped ? null : sent.length, deduped, mobileDelivered: !deduped, desktopDelivered: !deduped };
  });
  return { notifyOnce, sent };
}

function deps(over: Partial<GreenMainSloPassDeps> = {}): GreenMainSloPassDeps {
  return {
    installSlug: 'papercusp',
    workspaceId: 'ws-1',
    nowMs: NOW,
    readLastGreenAtMs: async () => NOW - 2 * HOUR,
    readLastVerdictAtMs: async () => NOW - 1 * HOUR,
    readQueue: async () => null,
    notifyOnce: onceStore().notifyOnce,
    readConditions: async () => [],
    rail: { broadcast: async () => true, resolve: async () => true },
    ...over,
  };
}

describe('runGreenMainSloPass', () => {
  it('delivers nothing while main is inside its SLO', async () => {
    const store = onceStore();
    const res = await runGreenMainSloPass(
      deps({ readLastGreenAtMs: async () => NOW - 11 * HOUR, readLastVerdictAtMs: async () => NOW - 5 * HOUR, notifyOnce: store.notifyOnce }),
    );
    expect(res.slo.breaches).toEqual([]);
    expect(store.notifyOnce).not.toHaveBeenCalled();
    expect(res.readErrors).toEqual([]);
  });

  it('pages the owner exactly ONCE per red episode across many ticks, and again for a new episode', async () => {
    const store = onceStore();
    const lastGreen = NOW - 13 * HOUR;
    const ticks = [0, 15, 30, 45, 60, 600].map((min) => NOW + min * 60_000);
    const fresh: string[] = [];
    for (const nowMs of ticks) {
      // Red verdicts keep landing (the gate is alive), so only the red page is in play.
      const res = await runGreenMainSloPass(
        deps({
          nowMs,
          readLastGreenAtMs: async () => lastGreen,
          readLastVerdictAtMs: async () => nowMs - 30 * 60_000,
          notifyOnce: store.notifyOnce,
        }),
      );
      fresh.push(...res.deliveries.filter((d) => !d.deduped).map((d) => d.episodeKey));
    }
    expect(fresh).toEqual([`green-main-slo:papercusp:time-since-green:${lastGreen}`]);
    expect(store.notifyOnce).toHaveBeenCalledTimes(ticks.length);
    expect(store.sent[0]).toMatchObject({
      kind: 'intervention',
      importance: 'urgent',
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      dedupeKey: `green-main-slo:papercusp:time-since-green:${lastGreen}`,
      data: { source: 'green-main-slo', metric: 'time-since-green', severity: 'page' },
    });

    // Main goes green, then red again for 12h+: a NEW episode, so exactly one new page.
    const nextGreen = NOW + 1 * HOUR;
    const later = await runGreenMainSloPass(
      deps({ nowMs: nextGreen + 12 * HOUR, readLastGreenAtMs: async () => nextGreen, readLastVerdictAtMs: async () => nextGreen + 11 * HOUR, notifyOnce: store.notifyOnce }),
    );
    expect(later.deliveries).toEqual([
      { episodeKey: `green-main-slo:papercusp:time-since-green:${nextGreen}`, severity: 'page', deduped: false },
    ]);
    expect(store.sent).toHaveLength(2);
  });

  it('pages a silent gate (no verdict of any kind for 6h+) once', async () => {
    const store = onceStore();
    const lastVerdict = NOW - 7 * HOUR;
    const res = await runGreenMainSloPass(deps({ readLastVerdictAtMs: async () => lastVerdict, notifyOnce: store.notifyOnce }));
    expect(res.deliveries).toEqual([
      { episodeKey: `green-main-slo:papercusp:time-since-verdict:${lastVerdict}`, severity: 'page', deduped: false },
    ]);
    expect(store.sent[0].importance).toBe('urgent');
  });

  it('a failed reader is reported, never read as fine, and does not silence the other page', async () => {
    const store = onceStore();
    const res = await runGreenMainSloPass(
      deps({
        readLastGreenAtMs: async () => {
          throw new Error('pg down');
        },
        readLastVerdictAtMs: async () => NOW - 8 * HOUR,
        notifyOnce: store.notifyOnce,
      }),
    );
    expect(res.readErrors).toEqual([{ input: 'lastGreenAt', message: 'pg down' }]);
    expect(res.slo.metrics.timeSinceGreenMs).toBeNull();
    expect(res.deliveries.map((d) => d.episodeKey)).toEqual([`green-main-slo:papercusp:time-since-verdict:${NOW - 8 * HOUR}`]);
  });

  it('a failed delivery is recorded and retried on the next tick (never lost)', async () => {
    const store = onceStore();
    let failNext = true;
    const flaky = vi.fn(async (input: ReplaySafeAttentionNotifyInput) => {
      if (failNext) {
        failNext = false;
        throw new Error('push gateway 503');
      }
      return store.notifyOnce(input);
    });
    const d = deps({ readLastGreenAtMs: async () => NOW - 20 * HOUR, notifyOnce: flaky });
    const first = await runGreenMainSloPass(d);
    expect(first.deliveries).toEqual([
      expect.objectContaining({ severity: 'page', deduped: false, error: 'push gateway 503' }),
    ]);
    const second = await runGreenMainSloPass(d);
    expect(second.deliveries).toEqual([expect.objectContaining({ severity: 'page', deduped: false })]);
    expect(second.deliveries[0].error).toBeUndefined();
    expect(store.sent).toHaveLength(1);
  });
});

describe('syncTalliesFromDeltaCoverage', () => {
  it('counts only judged (green|red) batches from the delta-check coverage ledger, and null when unreadable', async () => {
    const { syncTalliesFromDeltaCoverage } = await import('./green-main-slo');
    const ticks = ['green', 'red', 'skipped', 'up-to-date', 'red', 'radius-too-wide', 'missed-opportunity', 'green', 'leg-timeout'].map(
      (status, i) => ({ atMs: NOW - i * 300_000, evaluated: true, status }),
    );
    expect(syncTalliesFromDeltaCoverage({ coverage: { ticks } })).toEqual([{ fleet: null, judgedBatches: 4, redBatches: 2, observedAtMs: NOW }]);
    expect(syncTalliesFromDeltaCoverage({ coverage: { ticks: [] } })).toEqual([{ fleet: null, judgedBatches: 0, redBatches: 0 }]);
    expect(syncTalliesFromDeltaCoverage(undefined)).toBeNull();
    expect(syncTalliesFromDeltaCoverage({ coverage: { ticks: 'nope' } })).toBeNull();
  });

  it('a red-heavy delta ledger raises the per-sync red-rate alert through the pass', async () => {
    const store = onceStore();
    const ticks = Array.from({ length: 10 }, (_, i) => ({ atMs: NOW - i * 300_000, evaluated: true, status: i < 4 ? 'red' : 'green' }));
    const { syncTalliesFromDeltaCoverage } = await import('./green-main-slo');
    const res = await runGreenMainSloPass(
      deps({ readSyncTallies: async () => syncTalliesFromDeltaCoverage({ coverage: { ticks } }), notifyOnce: store.notifyOnce }),
    );
    expect(res.slo.metrics.perSyncRedRate).toEqual([{ fleet: null, judgedBatches: 10, redBatches: 4, rate: 0.4 }]);
    expect(res.deliveries).toEqual([expect.objectContaining({ severity: 'alert', deduped: false })]);
    expect(store.sent[0]).toMatchObject({ importance: 'normal', title: 'All agents: 40% of syncs red on papercusp' });
  });
});

describe('parseLastGreenAtMs', () => {
  it('reads the stored epoch and refuses garbage instead of reading it as "never green"', () => {
    expect(parseLastGreenAtMs(null)).toBeNull();
    expect(parseLastGreenAtMs('')).toBeNull();
    expect(parseLastGreenAtMs('1791000000000')).toBe(1791000000000);
    expect(parseLastGreenAtMs(1791000000000)).toBe(1791000000000);
    expect(() => parseLastGreenAtMs('not-a-date')).toThrow(/not an epoch ms/);
    for (const value of [true, false, ' ', ' 1791000000000', {}, NaN, Infinity]) {
      expect(() => parseLastGreenAtMs(value)).toThrow(/not an epoch ms/);
    }
  });
});

describe('checkGreenMainSlo (production wiring)', () => {
  const fakeSql = (rows: unknown[]) => (async () => rows) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readVerdictRateWindow.mockResolvedValue({ fires: 3, verdicts: 2, lastVerdictBearingAtMs: NOW - 1 * HOUR });
    mocks.readGateNonVerdictReasons.mockResolvedValue({ windowHours: 24, sinceMs: NOW - 24 * HOUR, measuredAtMs: NOW, reasons: [] });
    mocks.readFrozenCandidateRepairQueueState.mockResolvedValue({ status: 'absent' });
    mocks.notifyAttentionOnce.mockResolvedValue({ recordId: 1, deduped: false, mobileDelivered: true, desktopDelivered: true });
    mocks.recordWatchdogPassOutcome.mockResolvedValue(0);
  });

  it('reads lastGreenAt from the gate routine row, pages through notifyAttentionOnce, and records a healthy pass', async () => {
    const lastGreen = NOW - 14 * HOUR;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await checkGreenMainSlo(fakeSql([{ workspace_id: 'ws-1', last_green_at: String(lastGreen) }]), {
      installSlug: 'papercusp',
      nowMs: () => NOW,
    });
    expect(warn).toHaveBeenCalledWith(`[green-main-slo] papercusp: delivered page green-main-slo:papercusp:time-since-green:${lastGreen}`);
    warn.mockRestore();
    expect(res?.deliveries.map((d) => d.episodeKey)).toEqual([`green-main-slo:papercusp:time-since-green:${lastGreen}`]);
    expect(mocks.readVerdictRateWindow).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', installSlug: 'papercusp' });
    expect(mocks.notifyAttentionOnce).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: `green-main-slo:papercusp:time-since-green:${lastGreen}`, importance: 'urgent' }),
    );
    expect(mocks.recordWatchdogPassOutcome).toHaveBeenCalledWith(
      expect.anything(),
      'green-main-slo',
      { routineName: 'green-checkpoint', installSlug: 'papercusp' },
      undefined,
    );
    expect(mocks.broadcastSevereEvent).toHaveBeenCalledWith(expect.objectContaining({
      oneShot: true,
      conditionKey: `alarm:green-main-slo:${encodeURIComponent(JSON.stringify([
        'ws-1', 'papercusp', 'time-since-green', `green-main-slo:papercusp:time-since-green:${lastGreen}`, null,
      ]))}`,
    }));
  });

  it('an unreadable frozen queue records a FAILED pass instead of reading as "no queue"', async () => {
    mocks.readFrozenCandidateRepairQueueState.mockResolvedValue({ status: 'unreadable', reason: 'invalid-shape', schemaVersion: null });
    const res = await checkGreenMainSlo(fakeSql([{ workspace_id: 'ws-1', last_green_at: String(NOW - 1 * HOUR) }]), {
      installSlug: 'papercusp',
      nowMs: () => NOW,
    });
    expect(res?.readErrors).toEqual([{ input: 'queue', message: 'frozen repair queue unreadable: invalid-shape' }]);
    const passError = mocks.recordWatchdogPassOutcome.mock.calls[0][3];
    expect(passError).toBeInstanceOf(Error);
    expect(String(passError)).toMatch(/read queue: frozen repair queue unreadable/);
  });

  it('reports a failed reason read through watchdog health instead of a measured zero', async () => {
    mocks.readGateNonVerdictReasons.mockRejectedValue(new Error('reason ledger down'));
    const res = await checkGreenMainSlo(fakeSql([{ workspace_id: 'ws-1', last_green_at: String(NOW) }]), { installSlug: 'papercusp', nowMs: () => NOW });
    expect(res?.slo.metrics.nonVerdictReasons).toBeNull();
    expect(res?.readErrors).toContainEqual({ input: 'nonVerdictReasons', message: 'reason ledger down' });
    expect(String(mocks.recordWatchdogPassOutcome.mock.calls[0][3])).toContain('reason ledger down');
  });

  it('keeps the pass healthy and the SLO alert active when no live gate owner can take a reason follow-up', async () => {
    mocks.readGateNonVerdictReasons.mockResolvedValue({
      windowHours: 24,
      sinceMs: NOW - 24 * HOUR,
      measuredAtMs: NOW,
      reasons: [{ reason: 'skipped-qualification-conflict', count: 7, latestAtMs: NOW - 1 }],
    });
    mocks.readGateOwnership.mockResolvedValueOnce({ claimState: 'held', takenBy: 'su-dead', holderSessionState: 'ended' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await checkGreenMainSlo(fakeSql([{ workspace_id: 'ws-1', last_green_at: String(NOW - 2 * HOUR) }]), {
      installSlug: 'papercusp', nowMs: () => NOW,
    });

    expect(res?.slo.breaches.some((breach) => breach.metric === 'non-verdict-reason' &&
      breach.subject === 'skipped-qualification-conflict')).toBe(true);
    expect(res?.reasonItems).toEqual([]);
    expect(res?.reasonFilingSkips).toEqual([{ reason: 'skipped-qualification-conflict', cause: 'no-live-gate-owner' }]);
    expect(res?.conditionErrors).toEqual([]);
    expect(mocks.createOneWorkItem).not.toHaveBeenCalled();
    expect(mocks.broadcastSevereEvent).toHaveBeenCalled();
    expect(mocks.notifyAttentionOnce).toHaveBeenCalled();
    expect(mocks.recordWatchdogPassOutcome).toHaveBeenCalledWith(
      expect.anything(), 'green-main-slo', { routineName: 'green-checkpoint', installSlug: 'papercusp' }, undefined,
    );
    warn.mockRestore();
  });

  it('does nothing (and records a healthy pass) when the install has no gate routine', async () => {
    const res = await checkGreenMainSlo(fakeSql([]), { installSlug: 'papercusp', nowMs: () => NOW });
    expect(res).toBeNull();
    expect(mocks.notifyAttentionOnce).not.toHaveBeenCalled();
    expect(mocks.recordWatchdogPassOutcome).toHaveBeenCalledWith(expect.anything(), 'green-main-slo', expect.anything(), undefined);
  });
});

function railStore() {
  const states = new Map<string, { condition_key: string; open: boolean; open_since: string; last_seen: string }>();
  const opens: SevereEventBroadcast[] = [];
  const closed: string[] = [];
  let clock = NOW;
  const broadcast = vi.fn(async (event: SevereEventBroadcast) => {
    opens.push(event);
    const at = new Date(clock).toISOString();
    states.set(event.conditionKey!, { condition_key: event.conditionKey!, open: true, open_since: at, last_seen: at });
    return true;
  });
  const resolve = vi.fn(async ({ conditionKey }: { conditionKey: string }) => {
    states.get(conditionKey)!.open = false;
    closed.push(conditionKey);
    return true;
  });
  const run = async (over: Partial<GreenMainSloPassDeps> = {}) => {
    clock = over.nowMs ?? NOW;
    return runGreenMainSloPass(deps({ readConditions: async () => [...states.values()].map((s) => ({ ...s })),
      rail: { broadcast, resolve }, ...over }));
  };
  return { run, states, opens, closed, broadcast, resolve };
}

describe('recurring non-verdict reasons (P-029)', () => {
  const reading = (at: number, rows: Array<{ reason: string; count: number }>) => ({
    windowHours: 24 as const, sinceMs: at - 24 * HOUR, measuredAtMs: at,
    reasons: rows.map((r) => ({ ...r, latestAtMs: at - 1 })),
  });
  const mixed = [{ reason: 'skipped-joined-attempt', count: 7 }, { reason: 'skipped-memory-budget', count: 2 }];

  it('files only recurring reasons, preserves one daily notification, and surfaces filing failures', async () => {
    const owner = onceStore();
    const file = vi.fn(async () => ({ id: 'WI-reason', assignee: 'su-current' }));
    const h = railStore();
    for (const at of [NOW, NOW + 60_000]) {
      const result = await h.run({ nowMs: at, notifyOnce: owner.notifyOnce,
        readNonVerdictReasons: async () => reading(at, mixed), fileNonVerdictReason: file });
      expect(result.reasonItems).toEqual([{ reason: 'skipped-joined-attempt', id: 'WI-reason', assignee: 'su-current' }]);
      expect(result.conditionErrors).toEqual([]);
    }
    expect(file).toHaveBeenCalledTimes(2);
    expect(owner.sent).toHaveLength(1);
    expect(h.opens).toHaveLength(1);
    const failed = await h.run({ readNonVerdictReasons: async () => reading(NOW, mixed),
      fileNonVerdictReason: async () => { throw new Error('claim refused'); } });
    expect(failed.reasonItems).toEqual([]);
    expect(failed.conditionErrors).toContain('file skipped-joined-attempt: claim refused');
  });

  it('resolves only after a complete new exact-scope window; failed or stale reads retain the episode', async () => {
    const h = railStore();
    await h.run({ readNonVerdictReasons: async () => reading(NOW, mixed),
      fileNonVerdictReason: async () => ({ id: 'WI-reason', assignee: 'su-current' }) });
    const at = NOW + 25 * HOUR;
    await h.run({ nowMs: at, readNonVerdictReasons: async () => { throw new Error('db down'); } });
    await h.run({ nowMs: at, readNonVerdictReasons: async () => reading(NOW, []) });
    expect(h.closed).toEqual([]);
    await h.run({ nowMs: at, readNonVerdictReasons: async () => reading(at, []) });
    expect(h.closed).toEqual([h.opens[0].conditionKey]);
  });

  describe('production reason filing', () => {
    const target = { workspaceId: 'ws-1', installSlug: 'papercusp' };
    const breach = { metric: 'non-verdict-reason' as const, subject: 'skipped-joined-attempt', value: 7,
      threshold: 6, episodeKey: 'daily-key', title: 'Recurring joined attempt', detail: 'Seven outcomes', severity: 'alert' as const };
    const neverClosed = { readLastClosedAtMs: async () => null, countSince: async () => { throw new Error('no close to count from'); } };
    beforeEach(() => {
      mocks.readGateOwnership.mockResolvedValue({ claimState: 'held', takenBy: 'su-current', holderSessionState: 'live', assessment: 'held-live' });
      mocks.createOneWorkItem.mockResolvedValue({ ok: true, workItem: { id: 'WI-reason', assignee: 'su-current', harness: 'papercusp' } });
      mocks.claimWorkItem.mockReset(); mocks.getWorkItem.mockReset();
    });
    it('reuses a reason key across days and passes an atomic assignment to the existing create seam', async () => {
      expect(await fileRecurringNonVerdictReason(target, breach, neverClosed)).toEqual({ id: 'WI-reason', assignee: 'su-current' });
      const key = mocks.createOneWorkItem.mock.lastCall?.[0].conditionKey;
      await fileRecurringNonVerdictReason(target, { ...breach, episodeKey: 'next-day' }, neverClosed);
      expect(mocks.createOneWorkItem.mock.lastCall?.[0]).toMatchObject({ conditionKey: key, assign_to: 'su-current' });
      expect(mocks.claimWorkItem).not.toHaveBeenCalled();
    });
    it('preserves a different incumbent and claims an unassigned adopted item without force', async () => {
      mocks.createOneWorkItem.mockResolvedValueOnce({ ok: true, workItem: { id: 'WI-reason', assignee: 'su-incumbent' } });
      expect(await fileRecurringNonVerdictReason(target, breach, neverClosed)).toMatchObject({ id: 'WI-reason', assignee: 'su-incumbent' });
      mocks.createOneWorkItem.mockResolvedValueOnce({ ok: true, workItem: { id: 'WI-reason', assignee: null, harness: 'papercusp' } });
      mocks.claimWorkItem.mockResolvedValueOnce({ id: 'WI-reason', assignee: 'su-current' });
      expect(await fileRecurringNonVerdictReason(target, breach, neverClosed)).toMatchObject({ id: 'WI-reason', assignee: 'su-current' });
      expect(mocks.claimWorkItem).toHaveBeenCalledWith('WI-reason', 'su-current', { harness: 'papercusp', assignedBy: 'system:green-main-slo' });
    });
    // EI-26555742295077041: the close nulls condition_key, so only this guard stops a closed item
    // from being re-filed for the same pre-close outcomes while they stay inside the rolling day.
    it('does not re-file a closed reason for outcomes it already covered, and recounts from the close', async () => {
      const closedAtMs = NOW - 3 * HOUR;
      const countSince = vi.fn(async () => 0);
      mocks.createOneWorkItem.mockClear(); mocks.readGateOwnership.mockClear();
      await expect(fileRecurringNonVerdictReason(target, breach, { readLastClosedAtMs: async () => closedAtMs, countSince }))
        .resolves.toEqual({ skipped: 'covered-by-closed-item' });
      expect(countSince).toHaveBeenCalledWith(closedAtMs);
      expect(mocks.createOneWorkItem).not.toHaveBeenCalled();
      expect(mocks.readGateOwnership).not.toHaveBeenCalled();
      countSince.mockResolvedValueOnce(breach.threshold - 1);
      await expect(fileRecurringNonVerdictReason(target, breach, { readLastClosedAtMs: async () => closedAtMs, countSince }))
        .resolves.toEqual({ skipped: 'covered-by-closed-item' });
      expect(mocks.createOneWorkItem).not.toHaveBeenCalled();
    });
    it('re-files once the reason recurs at threshold after the close', async () => {
      const countSince = vi.fn(async () => breach.threshold);
      await expect(fileRecurringNonVerdictReason(target, breach, { readLastClosedAtMs: async () => NOW - HOUR, countSince }))
        .resolves.toEqual({ id: 'WI-reason', assignee: 'su-current' });
      expect(mocks.createOneWorkItem).toHaveBeenCalledTimes(1);
    });
    it('surfaces an unreadable close history instead of guessing', async () => {
      mocks.createOneWorkItem.mockClear();
      await expect(fileRecurringNonVerdictReason(target, breach, {
        readLastClosedAtMs: async () => { throw new Error('work_items read failed'); }, countSince: async () => 0,
      })).rejects.toThrow('work_items read failed');
      expect(mocks.createOneWorkItem).not.toHaveBeenCalled();
    });
    it('skips without a verified live owner and never reports an unassigned filing as successful', async () => {
      mocks.readGateOwnership.mockResolvedValueOnce({ claimState: 'held', takenBy: 'su-dead', holderSessionState: 'ended' });
      mocks.createOneWorkItem.mockClear();
      await expect(fileRecurringNonVerdictReason(target, breach, neverClosed)).resolves.toEqual({ skipped: 'no-live-gate-owner' });
      expect(mocks.createOneWorkItem).not.toHaveBeenCalled();
      mocks.readGateOwnership.mockRejectedValueOnce(new Error('ownership ledger unavailable'));
      await expect(fileRecurringNonVerdictReason(target, breach, neverClosed)).rejects.toThrow('ownership ledger unavailable');
      mocks.createOneWorkItem.mockResolvedValueOnce({ ok: true, workItem: { id: 'WI-reason', assignee: null, harness: 'papercusp' } });
      mocks.claimWorkItem.mockResolvedValueOnce(null); mocks.getWorkItem.mockResolvedValueOnce(null);
      await expect(fileRecurringNonVerdictReason(target, breach, neverClosed)).rejects.toThrow('remains unassigned');
      mocks.createOneWorkItem.mockResolvedValueOnce({ ok: false, error: 'write refused' });
      await expect(fileRecurringNonVerdictReason(target, breach, neverClosed)).rejects.toThrow('write refused');
    });
  });
});

describe('green-main SLO keyed lifecycle (original producer)', () => {
  const red = { readLastGreenAtMs: async () => NOW - 13 * HOUR, readLastVerdictAtMs: async () => NOW - 7 * HOUR };

  it('opens independent oneShot episodes before owner dedupe and preserves them across restarted passes', async () => {
    const h = railStore();
    const owner = onceStore();
    const d = { ...red, notifyOnce: owner.notifyOnce };
    await h.run(d);
    await h.run(d);
    expect(h.opens).toHaveLength(2);
    expect(h.opens.every((e) => e.oneShot)).toBe(true);
    expect(h.states.size).toBe(2);
    expect(owner.sent).toHaveLength(2);
    expect(h.closed).toEqual([]);
    expect(owner.notifyOnce).toHaveBeenCalledTimes(4);
  });

  it('recovers the exact measured green independently while a missing verdict preserves its sibling', async () => {
    const h = railStore();
    await h.run(red);
    await h.run({ nowMs: NOW + HOUR, readLastGreenAtMs: async () => NOW + 1,
      readLastVerdictAtMs: async () => null });
    expect(h.closed).toHaveLength(1);
    expect(JSON.parse(decodeURIComponent(h.closed[0].split('alarm:green-main-slo:')[1]))[2]).toBe('time-since-green');
    expect([...h.states.values()].filter((s) => s.open)).toHaveLength(1);
  });

  it.each([null, NOW - 1, NOW + 2 * HOUR, NaN, Infinity])('preserves recovery on missing/old/future/invalid green %s', async (stamp) => {
    const h = railStore();
    await h.run(red);
    await h.run({ nowMs: NOW + HOUR, readLastGreenAtMs: async () => stamp, readLastVerdictAtMs: async () => null });
    expect(h.closed).toEqual([]);
  });

  it.each([{ workspaceId: 'ws-foreign' }, { installSlug: 'foreign-install' }])('does not resolve another scope %j', async (scope) => {
    const h = railStore();
    await h.run(red);
    await h.run({ ...scope, nowMs: NOW + HOUR, readLastGreenAtMs: async () => NOW + 1, readLastVerdictAtMs: async () => NOW + 1 });
    expect(h.closed).toEqual([]);
  });

  it('preserves failed reads and still delivers unrelated breaches', async () => {
    const h = railStore();
    await h.run(red);
    const res = await h.run({ ...red, readLastGreenAtMs: async () => { throw new Error('unreadable'); } });
    expect(res.readErrors).toEqual([{ input: 'lastGreenAt', message: 'unreadable' }]);
    expect(res.deliveries).toHaveLength(1);
    expect(h.closed).toEqual([]);
  });

  it('a failed condition read/open does not suppress legacy attention or clear anything', async () => {
    const owner = onceStore();
    const res = await runGreenMainSloPass(deps({ ...red, notifyOnce: owner.notifyOnce,
      readConditions: async () => { throw new Error('conditions unavailable'); },
      rail: { broadcast: async () => false, resolve: vi.fn() } }));
    expect(owner.sent).toHaveLength(2);
    expect(res.conditionErrors).toHaveLength(3);
  });

  it('a failed owner delivery cannot prevent condition opening', async () => {
    const h = railStore();
    const res = await h.run({ ...red, notifyOnce: async () => { throw new Error('notification failed'); } });
    expect(h.opens).toHaveLength(2);
    expect(res.deliveries.every((d) => d.error === 'notification failed')).toBe(true);
  });

  it('a malformed condition census preserves legacy delivery and reports the missing instrument', async () => {
    const res = await runGreenMainSloPass(deps({ ...red, readConditions: async () => ({}) as never }));
    expect(res.deliveries).toHaveLength(2);
    expect(res.conditionErrors).toEqual(['read conditions: invalid condition census']);
  });

  it.each([
    { judgedBatches: 5, redBatches: 6 },
    { judgedBatches: -1, redBatches: 0 },
    { judgedBatches: 5, redBatches: -1 },
    { judgedBatches: NaN, redBatches: 0 },
    { judgedBatches: 5, redBatches: 0, observedAtMs: NOW + 1 },
  ])('invalid sync measurements cannot open or resolve rate episodes: %j', async (tally) => {
    const h = railStore();
    await h.run({ readSyncTallies: async () => [{ fleet: 'f', judgedBatches: 5, redBatches: 3, observedAtMs: NOW }] });
    const res = await h.run({ readSyncTallies: async () => [{ fleet: 'f', ...tally }] });
    expect(h.opens).toHaveLength(1);
    expect(h.closed).toEqual([]);
    expect(res.readErrors).toEqual([{ input: 'syncTallies', message: 'invalid syncTallies measurement' }]);
  });

  it('a refused resolution preserves the durable episode and exposes failure', async () => {
    const h = railStore();
    await h.run(red);
    const res = await h.run({ nowMs: NOW + HOUR, readLastGreenAtMs: async () => NOW + 1,
      rail: { broadcast: h.broadcast, resolve: async () => false } });
    expect(res.conditionErrors).toHaveLength(1);
    expect(h.closed).toEqual([]);
  });

  it('sync-rate recovery requires fresh counted samples for the same fleet, across day changes', async () => {
    const h = railStore();
    await h.run({ readSyncTallies: async () => [{ fleet: 'f1', judgedBatches: 10, redBatches: 5, observedAtMs: NOW }] });
    for (const tally of [
      { fleet: 'f2', judgedBatches: 10, redBatches: 0, observedAtMs: NOW + 1 },
      { fleet: 'f1', judgedBatches: 10, redBatches: 0 },
      { fleet: 'f1', judgedBatches: 10, redBatches: 0, observedAtMs: NOW - 1 },
      { fleet: 'f1', judgedBatches: 1, redBatches: 0, observedAtMs: NOW + 1 },
    ]) {
      await h.run({ nowMs: NOW + HOUR, readSyncTallies: async () => [tally] });
      expect(h.closed).toEqual([]);
    }
    await h.run({ nowMs: NOW + 24 * HOUR, readSyncTallies: async () => [
      { fleet: 'f1', judgedBatches: 10, redBatches: 1, observedAtMs: NOW + 24 * HOUR },
    ] });
    expect(h.closed).toHaveLength(1);
  });

  it('queue recovery requires the same candidate and positive later progress for all three queue metrics', async () => {
    const h = railStore();
    const queue: GreenMainSloQueue = { candidate: 'candidate-a', phase: 'awaiting-fixer', openedAtMs: NOW - 10 * HOUR,
      convergenceRounds: [
        { round: 1, head: 'h1', failingCount: 3, atMs: NOW - 8 * HOUR },
        { round: 2, head: 'h2', failingCount: 6, atMs: NOW - 4 * HOUR },
      ],
      admissions: [{ atMs: NOW - 6 * HOUR, actor: 'a', source: { ref: 'staging', sha: 's' },
        fromRepairHead: 'h1', toRepairHead: 'h2', paths: ['x.ts'], unchanged: [], blobs: {} }],
    };
    await h.run({ readQueue: async () => queue });
    expect(h.opens).toHaveLength(3);
    await h.run({ nowMs: NOW + HOUR, readQueue: async () => null });
    expect(h.closed).toEqual([]);
    const recovered: GreenMainSloQueue = { ...queue, phase: 'ready-to-promote', fixerSpawnedAtMs: NOW + 1,
      lastResumeRunStartedAtMs: NOW + 2, lastVerdictAtMs: NOW + 30 * 60_000,
      convergenceRounds: [...queue.convergenceRounds!,
        { round: 3, head: 'h3', failingCount: 3, atMs: NOW + 15 * 60_000 },
        { round: 4, head: 'h4', failingCount: 3, atMs: NOW + 30 * 60_000 }],
    };
    await h.run({ nowMs: NOW + HOUR, readQueue: async () => ({ ...recovered, candidate: 'candidate-other' }) });
    expect(h.closed).toEqual([]);
    await h.run({ nowMs: NOW + HOUR, readQueue: async () => ({ ...recovered, lastVerdictAtMs: NOW + 2 * HOUR }) });
    expect(h.closed).toEqual([]);
    await h.run({ nowMs: NOW + HOUR, readQueue: async () => recovered });
    expect(h.closed).toHaveLength(3);
    await h.run({ nowMs: NOW + HOUR, readQueue: async () => recovered });
    expect(h.opens).toHaveLength(3);
  });
});
