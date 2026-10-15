/**
 * outcome-refresh-sweep.test.ts — autonomous-loop-prod-audit-2026-07-02 P-006
 * (SPOF 5a/5b). Pure throttle decider + the sweep's orchestration (per-workspace
 * de-dup, refresh, stale-pending debounce/alert, fail-soft, kill switches) via
 * injected deps — no PG (mirrors rubric-staleness-watchdog.test.ts /
 * signal-accumulator.test.ts, the sibling watchdog-family sweeps).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../pot/started', () => ({
  listBlenderMaintenanceScopes: vi.fn(async () => []),
  listBlenderMaintenanceWorkspaceIds: vi.fn(() => []),
}));
vi.mock('./routed-ledger', () => ({
  AGENT_REVIEW_LEDGER_ORIGIN: 'agent-review',
  refreshScoutOutcomes: vi.fn(async () => ({ total: 0, byLens: {}, ranked: [] })),
  countStalePendingIdeas: vi.fn(async () => 0),
  readPendingOutcomeCandidates: vi.fn(async () => []),
  readTerminalUnresolvedRefIdeaIds: vi.fn(async () => []),
}));
vi.mock('../pot/watchdog', () => ({
  recentWatchdogFires: vi.fn(async () => 0),
  recordFire: vi.fn(async () => undefined),
}));
vi.mock('../agent-tools/coordination/escalations', () => ({ openEscalation: vi.fn(async () => ({}) as never) }));

import {
  shouldRefreshNow,
  scoutOutcomeRefreshIntervalSec,
  scoutOutcomeStalePendingThresholdSec,
  scoutPortfolioFrontierItemBudget,
  scoutPortfolioFrontierTimeBudgetMs,
  scoutOutcomeRefreshSweep,
  agentReviewOutcomeBatchSize,
  __resetOutcomeRefreshThrottleForTests,
} from './outcome-refresh-sweep';

const NOW = Date.parse('2026-07-15T12:00:00Z');

afterEach(() => {
  vi.unstubAllEnvs();
  __resetOutcomeRefreshThrottleForTests();
});

describe('shouldRefreshNow — the in-process throttle', () => {
  it('runs on the first call (no prior sweep)', () => {
    expect(shouldRefreshNow(null, NOW, 900)).toBe(true);
  });

  it('does not re-run before the interval elapses', () => {
    expect(shouldRefreshNow(NOW - 100_000, NOW, 900)).toBe(false);
  });

  it('re-runs once the interval has elapsed', () => {
    expect(shouldRefreshNow(NOW - 901_000, NOW, 900)).toBe(true);
  });

  it('never runs when the sweep interval is a kill switch (<=0)', () => {
    expect(shouldRefreshNow(null, NOW, 0)).toBe(false);
    expect(shouldRefreshNow(null, NOW, -1)).toBe(false);
  });
});

describe('env tunables', () => {
  it('defaults the cadence, staleness threshold, and bounded frontier budgets', () => {
    expect(scoutOutcomeRefreshIntervalSec()).toBe(900);
    expect(scoutOutcomeStalePendingThresholdSec()).toBe(86_400);
    expect(scoutPortfolioFrontierItemBudget()).toBe(25);
    expect(scoutPortfolioFrontierTimeBudgetMs()).toBe(5_000);
  });

  it('read the env override', () => {
    vi.stubEnv('PAPERCUSP_SCOUT_OUTCOME_REFRESH_SEC', '60');
    vi.stubEnv('PAPERCUSP_SCOUT_OUTCOME_STALE_PENDING_SEC', '3600');
    vi.stubEnv('PAPERCUSP_SCOUT_PORTFOLIO_FRONTIER_ITEMS', '3');
    vi.stubEnv('PAPERCUSP_SCOUT_PORTFOLIO_FRONTIER_MS', '750');
    expect(scoutOutcomeRefreshIntervalSec()).toBe(60);
    expect(scoutOutcomeStalePendingThresholdSec()).toBe(3_600);
    expect(scoutPortfolioFrontierItemBudget()).toBe(3);
    expect(scoutPortfolioFrontierTimeBudgetMs()).toBe(750);
  });
});

describe('scoutOutcomeRefreshSweep — orchestration (injected deps, no PG)', () => {
  const deps = (over: Parameters<typeof scoutOutcomeRefreshSweep>[0] = {}) => ({
    listBlenderMaintenanceScopes: vi.fn(async () => [{ workspaceId: 'ws1', installSlug: 'papercusp' }]),
    refreshScoutOutcomes: vi.fn(async () => ({ total: 0, byLens: {}, ranked: [] }) as never),
    countStalePendingIdeas: vi.fn(async () => 0),
    readPendingOutcomeCandidates: vi.fn(async () => []),
    readTerminalUnresolvedRefIdeaIds: vi.fn(async () => [] as string[]),
    readPortfolioGradingBacklog: vi.fn(async () => 0),
    readPortfolioFrontierCheckpoint: vi.fn(async () => null),
    writePortfolioFrontierCheckpoint: vi.fn(async () => undefined),
    recentWatchdogFires: vi.fn(async () => 0),
    recordFire: vi.fn(async () => undefined),
    openEscalation: vi.fn(async () => ({}) as never),
    now: NOW,
    ...over,
  });

  it('records a drained checkpoint and reports no stale-pending when the whole portfolio is empty', async () => {
    const d = deps();
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results).toEqual([
      {
        workspaceId: 'ws1',
        installSlug: 'papercusp',
        outcome: 'refreshed',
        evaluatedWorkspaceCount: 1,
        evaluatedScopeCount: 1,
        eligibleBacklogCount: 0,
        stalePendingCount: 0,
        alerted: false,
        frontier: expect.objectContaining({ phase: 'drained', consumedItems: 0 }),
        reason: '0 verified; no stale-pending',
      },
    ]);
    expect(d.refreshScoutOutcomes).not.toHaveBeenCalled();
    expect(d.writePortfolioFrontierCheckpoint).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ phase: 'drained' }),
    );
    expect(d.recordFire).not.toHaveBeenCalled();
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  it('de-dups by workspace — a multi-pot workspace refreshes once, not per pot', async () => {
    const d = deps({
      listBlenderMaintenanceScopes: vi.fn(async () => [
        { workspaceId: 'ws1', installSlug: 'papercusp' },
        { workspaceId: 'ws1', installSlug: 'papercusp-b' },
      ]),
    });
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results).toHaveLength(1);
    expect(d.readPendingOutcomeCandidates).toHaveBeenCalledTimes(1);
    expect(d.writePortfolioFrontierCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('refreshes only the bounded selected ids in both learning partitions', async () => {
    const d = deps({
      readPendingOutcomeCandidates: vi.fn(async () => [
        { ideaId: 'scout-a', origin: 'scout', routedRef: 'plan:a', routedAtMs: NOW, humanGrade: 5 },
        { ideaId: 'su-b', origin: 'su-ideate', routedRef: 'wi:b', routedAtMs: NOW + 1, humanGrade: 4 },
      ]),
    });
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results[0]?.frontier).toMatchObject({ phase: 'outcome-verification', consumedItems: 2 });
    expect(d.refreshScoutOutcomes).toHaveBeenCalledTimes(2);
    expect(d.refreshScoutOutcomes).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      harnessSlug: 'papercusp',
      ideaIds: ['scout-a'],
    });
    expect(d.refreshScoutOutcomes).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      harnessSlug: 'papercusp',
      origin: 'su-ideate',
      ideaIds: ['su-b'],
    });
  });

  it('stops before starting another refresh once the wall-clock budget is exhausted', async () => {
    vi.stubEnv('PAPERCUSP_SCOUT_PORTFOLIO_FRONTIER_ITEMS', '3');
    vi.stubEnv('PAPERCUSP_SCOUT_PORTFOLIO_FRONTIER_MS', '10');
    let clockMs = NOW;
    const refreshScoutOutcomes = vi.fn(async () => {
      clockMs += 10;
      return { total: 0, byLens: {}, ranked: [] } as never;
    });
    const d = deps({
      clock: () => clockMs,
      refreshScoutOutcomes,
      readPendingOutcomeCandidates: vi.fn(async () => [
        { ideaId: 'a', origin: 'scout', routedRef: 'plan:a', routedAtMs: NOW, humanGrade: 5 },
        { ideaId: 'b', origin: 'scout', routedRef: 'plan:b', routedAtMs: NOW + 1, humanGrade: 4 },
        { ideaId: 'c', origin: 'scout', routedRef: 'plan:c', routedAtMs: NOW + 2, humanGrade: 3 },
      ]),
    });

    const results = await scoutOutcomeRefreshSweep(d);

    expect(refreshScoutOutcomes).toHaveBeenCalledTimes(1);
    expect(refreshScoutOutcomes).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      harnessSlug: 'papercusp',
      ideaIds: ['a'],
    });
    expect(results[0]?.frontier).toMatchObject({
      phase: 'outcome-verification',
      cursorIdeaId: 'a',
      currentIdeaId: 'a',
      consumedItems: 1,
      elapsedMs: 10,
      itemBudget: 3,
      timeBudgetMs: 10,
      pendingOutcomes: 3,
    });
  });

  it('reserves a verification slice while grading remains actionable and preserves the cursor', async () => {
    const d = deps({
      readPortfolioGradingBacklog: vi.fn(async () => 2),
      readPendingOutcomeCandidates: vi.fn(async () => [
        { ideaId: 'pending-a', origin: 'scout', routedRef: 'plan:a', routedAtMs: NOW, humanGrade: 5 },
        { ideaId: 'pending-b', origin: 'scout', routedRef: 'plan:b', routedAtMs: NOW + 1, humanGrade: 4 },
        { ideaId: 'pending-c', origin: 'scout', routedRef: 'plan:c', routedAtMs: NOW + 2, humanGrade: 3 },
        { ideaId: 'pending-d', origin: 'scout', routedRef: 'plan:d', routedAtMs: NOW + 3, humanGrade: 2 },
      ]),
      readPortfolioFrontierCheckpoint: vi.fn(async () => ({
        version: 1 as const,
        phase: 'outcome-verification' as const,
        cursorIdeaId: 'resume-after',
        cursorGrade: 4,
        cursorRoutedAtMs: NOW - 2_000,
        currentIdeaId: null,
        itemBudget: 25,
        timeBudgetMs: 5_000,
        consumedItems: 1,
        elapsedMs: 10,
        gradingBacklog: 0,
        pendingOutcomes: 1,
        evidenceSource: { kind: 'plan-run', ref: 'plan:last' },
        updatedAt: new Date(NOW - 1_000).toISOString(),
      })),
    });
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results[0]).toMatchObject({
      eligibleBacklogCount: 2,
      alerted: false,
      frontier: { phase: 'outcome-verification', gradingBacklog: 2, consumedItems: 3 },
    });
    expect(d.refreshScoutOutcomes).toHaveBeenCalledTimes(3);
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  // WI-10005247: a shipped goal-plan route (origin su-ideate, never verified)
  // sat 27h behind a cursor deep in the scout region because the lap ignored
  // outcome_checked_at. The sweep must verify it on the very next wake and must
  // not drag the round-robin cursor onto it.
  it('verifies a never-checked su-ideate route first and leaves the round-robin cursor alone', async () => {
    const written: Array<{ cursorIdeaId: string | null }> = [];
    const d = deps({
      readPortfolioGradingBacklog: vi.fn(async () => 861),
      readPendingOutcomeCandidates: vi.fn(async () => [
        {
          ideaId: 'goal-plan:stranded',
          origin: 'su-ideate',
          routedRef: 'plan:frontier-remediation',
          routedAtMs: NOW - 27 * 3_600_000,
          humanGrade: 4,
          outcomeCheckedAtMs: null,
        },
        ...['s1', 's2', 's3', 's4'].map((id, i) => ({
          ideaId: id,
          origin: 'scout',
          routedRef: `wi:${id}`,
          routedAtMs: NOW - 90 * 86_400_000 + i,
          humanGrade: null,
          outcomeCheckedAtMs: NOW - 600_000,
        })),
      ]),
      readPortfolioFrontierCheckpoint: vi.fn(async () => ({
        version: 1 as const,
        phase: 'outcome-verification' as const,
        cursorIdeaId: 's1',
        cursorGrade: null,
        cursorRoutedAtMs: NOW - 90 * 86_400_000,
        currentIdeaId: null,
        itemBudget: 25,
        timeBudgetMs: 5_000,
        consumedItems: 3,
        elapsedMs: 10,
        gradingBacklog: 861,
        pendingOutcomes: 5,
        evidenceSource: null,
        updatedAt: new Date(NOW - 1_000).toISOString(),
      })),
      writePortfolioFrontierCheckpoint: vi.fn(async (_ws: string, cp: { cursorIdeaId: string | null }) => {
        written.push(cp);
      }),
    });
    await scoutOutcomeRefreshSweep(d);
    const refreshed = (d.refreshScoutOutcomes as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { ideaIds: string[]; origin?: string }),
    );
    expect(refreshed[0]).toMatchObject({ ideaIds: ['goal-plan:stranded'], origin: 'su-ideate' });
    expect(refreshed).toHaveLength(3);
    // cursor advanced only by the round-robin rows (s2, s3), not by the priority pick
    expect(written.at(-1)?.cursorIdeaId).toBe('s3');
  });

  it('rechecks at the write boundary and narrows to the reserved slice when grading arrives', async () => {
    const readBacklog = vi.fn(async () => 0);
    readBacklog.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const d = deps({
      readPortfolioGradingBacklog: readBacklog,
      readPendingOutcomeCandidates: vi.fn(async () => [
        { ideaId: 'pending-a', origin: 'scout', routedRef: 'plan:a', routedAtMs: NOW, humanGrade: 5 },
        { ideaId: 'pending-b', origin: 'scout', routedRef: 'plan:b', routedAtMs: NOW + 1, humanGrade: 4 },
        { ideaId: 'pending-c', origin: 'scout', routedRef: 'plan:c', routedAtMs: NOW + 2, humanGrade: 3 },
        { ideaId: 'pending-d', origin: 'scout', routedRef: 'plan:d', routedAtMs: NOW + 3, humanGrade: 2 },
      ]),
    });
    const results = await scoutOutcomeRefreshSweep(d);
    expect(readBacklog).toHaveBeenCalledTimes(2);
    expect(results[0]?.frontier).toMatchObject({
      phase: 'outcome-verification',
      gradingBacklog: 1,
      consumedItems: 3,
    });
    expect(d.refreshScoutOutcomes).toHaveBeenCalledTimes(3);
  });

  it('alerts stale-pending work even while grading is active', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps({
      readPortfolioGradingBacklog: vi.fn(async () => 2),
      readPendingOutcomeCandidates: vi.fn(async () => [
        { ideaId: 'pending', origin: 'scout', routedRef: 'plan:p', routedAtMs: NOW, humanGrade: 5 },
      ]),
      countStalePendingIdeas: vi.fn(async () => 3),
    });
    const results = await scoutOutcomeRefreshSweep(d);
    warn.mockRestore();
    expect(results[0]).toMatchObject({
      eligibleBacklogCount: 2,
      stalePendingCount: 3,
      alerted: true,
      frontier: { phase: 'outcome-verification', gradingBacklog: 2, consumedItems: 1 },
    });
    expect(d.recordFire).toHaveBeenCalledTimes(1);
    expect(d.openEscalation).toHaveBeenCalledTimes(1);
  });

  it('alerts (both channels) when ideas sit stale-pending and no recent fire exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps({ countStalePendingIdeas: vi.fn(async () => 3) });
    const results = await scoutOutcomeRefreshSweep(d);
    warn.mockRestore();
    expect(results[0]).toMatchObject({ outcome: 'refreshed', stalePendingCount: 3, alerted: true });
    expect(d.recordFire).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.recordFire).mock.calls[0]![0]).toMatchObject({ source: 'scout-outcome-stale-pending' });
    expect(d.openEscalation).toHaveBeenCalledTimes(1);
    const esc = vi.mocked(d.openEscalation).mock.calls[0]![1] as { summary: string };
    expect(esc.summary).toContain('3 Scout-routed idea(s)');
  });

  it('debounces the stale-pending alert via the fires ledger', async () => {
    const d = deps({ countStalePendingIdeas: vi.fn(async () => 2), recentWatchdogFires: vi.fn(async () => 1) });
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results[0]).toMatchObject({ stalePendingCount: 2, alerted: false });
    expect(d.recordFire).not.toHaveBeenCalled();
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  it('skips the stale-pending check entirely when its threshold is a kill switch (<=0), refresh still runs', async () => {
    vi.stubEnv('PAPERCUSP_SCOUT_OUTCOME_STALE_PENDING_SEC', '0');
    const d = deps();
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results[0]).toMatchObject({ outcome: 'refreshed', stalePendingCount: 0 });
    expect(d.countStalePendingIdeas).not.toHaveBeenCalled();
  });

  it('is fail-soft per workspace — a refresh error is recorded, never thrown', async () => {
    const d = deps({
      readPendingOutcomeCandidates: vi.fn(async () => [
        { ideaId: 'a', origin: 'scout', routedRef: 'plan:a', routedAtMs: NOW, humanGrade: 5 },
      ]),
      refreshScoutOutcomes: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results[0]).toMatchObject({ workspaceId: 'ws1', outcome: 'error', reason: 'pg down' });
  });

  it('is fail-soft overall — scope discovery error yields no throw (empty results)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps({
      listBlenderMaintenanceScopes: vi.fn(async () => {
        throw new Error('registry unavailable');
      }),
    });
    const results = await scoutOutcomeRefreshSweep(d);
    warn.mockRestore();
    expect(results).toEqual([]);
  });

  it('the env kill switch (refresh interval <=0) skips the whole sweep', async () => {
    vi.stubEnv('PAPERCUSP_SCOUT_OUTCOME_REFRESH_SEC', '0');
    const d = deps();
    const results = await scoutOutcomeRefreshSweep(d);
    expect(results).toEqual([]);
    expect(d.listBlenderMaintenanceScopes).not.toHaveBeenCalled();
  });

  it('the in-process throttle skips a second sweep within the interval', async () => {
    const d = deps();
    const first = await scoutOutcomeRefreshSweep(d);
    expect(first).toHaveLength(1);
    const second = await scoutOutcomeRefreshSweep({ ...d, now: NOW + 1000 });
    expect(second).toEqual([]);
  });

  it('the throttle allows a fresh sweep once the interval elapses', async () => {
    const d = deps();
    await scoutOutcomeRefreshSweep(d);
    const later = await scoutOutcomeRefreshSweep({ ...d, now: NOW + 901_000 });
    expect(later).toHaveLength(1);
  });
});

// WI-10007540: agent-review routes sit outside the learning frontier, so a route whose
// work item terminalized without the eager write stayed outcome NULL forever (885 rows
// measured 2026-10-08). The sweep now settles exactly those rows in a bounded batch.
describe('scoutOutcomeRefreshSweep — agent-review terminal reconciliation (WI-10007540)', () => {
  const baseDeps = (over: Parameters<typeof scoutOutcomeRefreshSweep>[0] = {}) => ({
    listBlenderMaintenanceScopes: vi.fn(async () => [{ workspaceId: 'ws1', installSlug: 'papercusp' }]),
    refreshScoutOutcomes: vi.fn(async () => ({ total: 0, byLens: {}, ranked: [] }) as never),
    countStalePendingIdeas: vi.fn(async () => 0),
    readPendingOutcomeCandidates: vi.fn(async () => []),
    readTerminalUnresolvedRefIdeaIds: vi.fn(async () => [] as string[]),
    readPortfolioGradingBacklog: vi.fn(async () => 0),
    readPortfolioFrontierCheckpoint: vi.fn(async () => null),
    writePortfolioFrontierCheckpoint: vi.fn(async () => undefined),
    recentWatchdogFires: vi.fn(async () => 0),
    recordFire: vi.fn(async () => undefined),
    openEscalation: vi.fn(async () => ({}) as never),
    now: NOW,
    ...over,
  });

  const evidence = (ideaId: string, status: 'won' | 'lost' | 'unknown') => ({
    ideaId,
    origin: 'agent-review',
    routedRef: `wi:${ideaId}`,
    status,
    sourceKind: status === 'unknown' ? 'none' : 'completion',
    sourceRef: status === 'unknown' ? null : `wi:${ideaId}`,
    observedAt: new Date(NOW).toISOString(),
    reason: 'test',
  });

  it('refreshes the terminal-but-unresolved agent-review ids under origin agent-review and counts the settled ones', async () => {
    const refresh = vi.fn(async () => ({
      total: 0,
      byLens: {},
      ranked: [],
      refreshed: [evidence('EI-1', 'won'), evidence('EI-2', 'lost'), evidence('EI-3', 'unknown')],
    }) as never);
    const d = baseDeps({
      refreshScoutOutcomes: refresh,
      readTerminalUnresolvedRefIdeaIds: vi.fn(async () => ['EI-1', 'EI-2', 'EI-3']),
    });
    const results = await scoutOutcomeRefreshSweep(d);
    expect(d.readTerminalUnresolvedRefIdeaIds).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      origin: 'agent-review',
      limit: 200,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      harnessSlug: 'papercusp',
      origin: 'agent-review',
      ideaIds: ['EI-1', 'EI-2', 'EI-3'],
    });
    // 'unknown' is still pending: only won/lost count as settled.
    expect(results[0]).toMatchObject({ outcome: 'refreshed', agentReviewReconciled: 2 });
  });

  it('never calls refresh when no agent-review route is terminal-but-unresolved, and omits the count', async () => {
    const d = baseDeps();
    const results = await scoutOutcomeRefreshSweep(d);
    expect(d.readTerminalUnresolvedRefIdeaIds).toHaveBeenCalledTimes(1);
    expect(d.refreshScoutOutcomes).not.toHaveBeenCalled();
    expect(results[0]).not.toHaveProperty('agentReviewReconciled');
  });

  it('is fail-soft: a reconciliation error leaves the workspace result refreshed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = baseDeps({
      readTerminalUnresolvedRefIdeaIds: vi.fn(async () => {
        throw new Error('join timed out');
      }),
    });
    const results = await scoutOutcomeRefreshSweep(d);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent-review reconciliation failed'));
    warn.mockRestore();
    expect(results[0]).toMatchObject({ outcome: 'refreshed', reason: '0 verified; no stale-pending' });
    expect(results[0]).not.toHaveProperty('agentReviewReconciled');
  });

  it('honours the batch env override, and <=0 disables only this pass', async () => {
    vi.stubEnv('PAPERCUSP_AGENT_REVIEW_OUTCOME_BATCH', '7');
    expect(agentReviewOutcomeBatchSize()).toBe(7);
    const d = baseDeps();
    await scoutOutcomeRefreshSweep(d);
    expect(d.readTerminalUnresolvedRefIdeaIds).toHaveBeenCalledWith(expect.objectContaining({ limit: 7 }));

    __resetOutcomeRefreshThrottleForTests();
    vi.stubEnv('PAPERCUSP_AGENT_REVIEW_OUTCOME_BATCH', '0');
    const off = baseDeps();
    const results = await scoutOutcomeRefreshSweep(off);
    expect(off.readTerminalUnresolvedRefIdeaIds).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ outcome: 'refreshed' });
  });
});
