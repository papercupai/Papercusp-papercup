import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const resolveGoalHolders = vi.hoisted(() => vi.fn());
vi.mock('./goals/holder', () => ({ resolveGoalHolders }));
import { makeGoalReportReferenceReads } from './goal-owner-report-reference';

const workspaceId = 'ws-report';
const goalId = 'goal-report';
const expectedAt = '2026-10-05T21:00:00.000Z';

describe('canonical GOAL report wake ownership', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['loop', 'event'] as const)('refuses a %s wake for a dead or unresolved holder before consulting stale registrations', async (kind) => {
    resolveGoalHolders.mockResolvedValue({ live: [] });
    const sql = vi.fn(async () => [{ id: 1, event_key: 'report-ready', expires_ts: expectedAt }]);
    const reads = makeGoalReportReferenceReads(sql as unknown as Sql, workspaceId, goalId);
    expect(await reads.wake({ kind, ref: 'report-ready', evidenceRef: 'await:1', expectedAt })).toBe(false);
    expect(resolveGoalHolders).toHaveBeenCalledWith(sql, { workspaceId, goalId });
    expect(sql).not.toHaveBeenCalled();
  });

  it.each(['loop', 'event'] as const)('binds a %s registration to the elected live holder', async (kind) => {
    resolveGoalHolders.mockResolvedValue({ live: [{ ownerId: 'live-holder' }] });
    const sql = vi.fn(async () => kind === 'loop'
      ? [{ id: 'routine-report', next_fire_at: expectedAt, updated_at: '2026-10-05T20:00:00.000Z' }]
      : [{ id: 1, event_key: 'report-ready', expires_ts: expectedAt }]);
    const reads = makeGoalReportReferenceReads(sql as unknown as Sql, workspaceId, goalId);
    expect(await reads.wake({ kind, ref: kind === 'loop' ? 'routine-report' : 'report-ready',
      evidenceRef: kind === 'loop' ? 'routine:routine-report@2026-10-05T20:00:00.000Z' : 'await:1', expectedAt })).toBe(true);
    expect(sql.mock.calls[0]).toEqual(expect.arrayContaining([workspaceId, goalId, 'live-holder']));
  });
});
