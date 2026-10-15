import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openEscalation: vi.fn(),
  armEscalationRequesterInterest: vi.fn(),
  getModeSubject: vi.fn(async () => null as string | null),
  // P-005: null = truth reads unavailable (fail-open); keeps this suite DB-free.
  readGoalOwnerReportTruth: vi.fn(async (..._args: unknown[]): Promise<any> => null),
}));

vi.mock('../identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'requester-1', ownerLabel: 'Requester 1', workspaceId: 'ws-1' }),
}));
vi.mock('../escalations', () => ({
  openEscalation: h.openEscalation,
  armEscalationRequesterInterest: h.armEscalationRequesterInterest,
}));
vi.mock('../../../modes/store', () => ({ getModeSubject: h.getModeSubject }));
vi.mock('../../../goal-owner-report-truth', () => ({ readGoalOwnerReportTruth: h.readGoalOwnerReportTruth }));

import tool from './escalate';

const handle = {
  event_keys: ['escalation:resolved:esc-1'],
  await_ids: [51],
  cancel: { tool: 'events:cancel' as const, args: { await_ids: [51] } },
  handle_note: 'captured requester wake handle',
};

beforeEach(() => {
  h.openEscalation.mockReset().mockResolvedValue({ msg_id: 'esc-1', ts: '2026-08-21T00:00:00.000Z' });
  h.armEscalationRequesterInterest.mockReset().mockResolvedValue(handle);
  h.getModeSubject.mockReset().mockResolvedValue(null);
  h.readGoalOwnerReportTruth.mockReset().mockResolvedValue(null);
});

describe('coord:escalate GOAL owner-report boundary (P-006 / A-05)', () => {
  const goalId = 'goal-1';
  const completeBody =
    'MOVED: P-006 advanced\nCOST: unknown (goal-pots unavailable)\nOWNER-WALLED: none\nKILLED: none\nNEXT WAKE: owner reply';

  it('stamps a complete report with the server-resolved current subject', async () => {
    h.getModeSubject.mockResolvedValueOnce(goalId);
    const out = await (tool as any).handler(
      { severity: 'advisory', summary: 'Goal owner report', body: completeBody },
      {},
    );
    const result = JSON.parse(out.content[0].text);

    expect(result.goal_owner_report).toEqual({ status: 'stamped', goalId });
    expect(h.getModeSubject).toHaveBeenCalledWith('ws-1', 'requester-1', 'goal');
    expect(h.openEscalation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        meta: expect.objectContaining({
          goalOwnerReport: {
            schemaVersion: 'goal-owner-report-v1',
            goalId,
            moved: 'P-006 advanced',
            cost: 'unknown (goal-pots unavailable)',
            ownerWalled: 'none',
            killed: 'none',
            nextWake: 'owner reply',
          },
        }),
      }),
    );
  });

  it('refuses a partial attempted report before opening an escalation', async () => {
    h.getModeSubject.mockResolvedValueOnce(goalId);
    const out = await (tool as any).handler(
      { severity: 'advisory', summary: 'Goal owner report', body: 'MOVED: P-006\nCOST: 1c' },
      {},
    );
    const result = JSON.parse(out.content[0].text);

    expect(out.isError).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: 'goal-owner-report-incomplete',
      goalId,
      missing: ['ownerWalled', 'killed', 'nextWake'],
    });
    expect(h.openEscalation).not.toHaveBeenCalled();
  });

  // P-005 (goal-holder-plans-ideation-truthful-reports-2026-10-03): the escalate
  // rail applies the same measured-state truth gate as coord:send.
  it('refuses a complete report that a readable measurement contradicts, before opening an escalation', async () => {
    h.getModeSubject.mockResolvedValueOnce(goalId);
    const violation = {
      check: 'owner-walled',
      kind: 'wall-not-listed',
      ref: 'WI-10004856',
      expected: 'choose the hud P-003 route',
      message: 'OWNER-WALLED omits open owner wall WI-10004856; list it with "choose the hud P-003 route".',
    };
    h.readGoalOwnerReportTruth.mockResolvedValueOnce({
      violations: [violation],
      summary: { cost: 'unread', ownerWalls: 'unread', corrections: 'no-baseline' },
      citedRefStates: [],
    });
    const out = await (tool as any).handler(
      { severity: 'advisory', summary: 'Goal owner report', body: completeBody },
      {},
    );
    const result = JSON.parse(out.content[0].text);

    expect(h.readGoalOwnerReportTruth).toHaveBeenCalledWith('ws-1', goalId, expect.objectContaining({ ownerWalled: 'none' }));
    expect(out.isError).toBe(true);
    expect(result).toMatchObject({ ok: false, error: 'goal-owner-report-untruthful', goalId, violations: [violation] });
    expect(h.openEscalation).not.toHaveBeenCalled();
  });

  it('stamps the truth summary when the readable checks pass, and stamps without one when the read throws', async () => {
    h.getModeSubject.mockResolvedValueOnce(goalId);
    h.readGoalOwnerReportTruth.mockResolvedValueOnce({
      violations: [],
      summary: { cost: 'goal-spend-unmeasured', ownerWalls: 'none-open', corrections: 'none-owed' },
      citedRefStates: [],
    });
    await (tool as any).handler({ severity: 'advisory', summary: 'Goal owner report', body: completeBody }, {});
    expect(h.openEscalation.mock.calls[0]![1].meta.goalOwnerReport).toMatchObject({
      goalId,
      citedRefStates: [],
      truth: { cost: 'goal-spend-unmeasured', ownerWalls: 'none-open', corrections: 'none-owed' },
    });

    h.getModeSubject.mockResolvedValueOnce(goalId);
    h.readGoalOwnerReportTruth.mockRejectedValueOnce(new Error('pg unavailable'));
    const out = await (tool as any).handler({ severity: 'advisory', summary: 'Goal owner report', body: completeBody }, {});
    expect(JSON.parse(out.content[0].text).goal_owner_report).toEqual({ status: 'stamped', goalId });
    expect(h.openEscalation.mock.calls[1]![1].meta.goalOwnerReport.truth).toBeUndefined();
  });

  it('does not read GOAL state for ordinary diagnostic/remediation escalation text', async () => {
    await (tool as any).handler(
      { severity: 'blocker', summary: 'Database unavailable', body: 'Retry the canonical reader.' },
      {},
    );
    expect(h.getModeSubject).not.toHaveBeenCalled();
    expect(h.openEscalation).toHaveBeenCalledTimes(1);
  });

  it('keeps the escalation usable with an explicit non-evidence warning when the mode read fails', async () => {
    h.getModeSubject.mockRejectedValueOnce(new Error('mode store unavailable'));
    const out = await (tool as any).handler(
      { severity: 'advisory', summary: 'Goal owner report', body: completeBody },
      {},
    );
    const result = JSON.parse(out.content[0].text);
    expect(result.goal_owner_report_warning).toContain('mode store unavailable');
    expect(h.openEscalation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        meta: expect.objectContaining({
          goalOwnerReportValidation: expect.objectContaining({ status: 'unknown' }),
        }),
      }),
    );
  });
});

describe('coord:escalate requester interest handle (P-024)', () => {
  it('arms the concrete resolution edge and returns its cancel handle', async () => {
    const out = await (tool as any).handler({ severity: 'question', summary: 'Choose a route' }, {});
    const body = JSON.parse(out.content[0].text);
    expect(h.armEscalationRequesterInterest).toHaveBeenCalledWith('requester-1', 'esc-1');
    expect(body).toMatchObject({ ok: true, msg_id: 'esc-1', interest_watch: handle });
  });
});
