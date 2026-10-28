import { describe, it, expect, vi } from 'vitest';

const mockGetPlanRow = vi.fn();
vi.mock('./agent-tools/plans/source', () => ({
  getPlanRow: (...args: unknown[]) => mockGetPlanRow(...args),
}));

import { getClaimTimePlanDecisions, renderPlanDecisionsNote } from './plan-decisions-claim-port';

const PLAN_WITH_DECISIONS = `## Now

State: ready.

## Decisions

### D-001 — A retirement is done when every reference is re-pointed
Date: 2026-07-26
Code removal alone is not enough — dispatch contracts crossing an HTTP
boundary are the invisible fourth reference class.

### D-002 — A ruling other lanes must follow is recorded as a plan Decision at the moment it forms
Date: 2026-07-26
Never only as a coord message — decisions are the auditable substrate;
messages are the notification.
`;

const PLAN_WITHOUT_DECISIONS = `## Now

State: ready.
`;

/**
 * 12 decisions — deliberately OVER the 8 cap, which no fixture here used to be
 * (EI-19396519606401168). The cap was therefore never exercised, and the bug it
 * hid was that `slice(0, 8)` kept the OLDEST eight while the note reported the
 * post-slice length as the total. D-012 below stands in for the real-world case
 * that caught it: a late ruling that DEFERS an item, which a claimer that only
 * sees D-001..D-008 will go ahead and build.
 */
const PLAN_WITH_MANY_DECISIONS = `## Now

State: ready.

## Decisions
${Array.from({ length: 11 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0');
  return `### D-${n} — Early ruling ${i + 1}\nDate: 2026-07-26\nBody of early ruling ${i + 1}.\n`;
}).join('\n')}
### D-012 — Do not start P-004; it is deferred
Date: 2026-08-02
P-004 has no evidence behind it. Do not start that phase.
`;

function workItemWithPlan(planSlug: string | null) {
  return {
    payload: planSlug ? { plan_item: { plan_slug: planSlug, item_id: 'P-003' } } : {},
  };
}

describe('getClaimTimePlanDecisions (agent-trap-guards-2026-07-26 P-003b)', () => {
  it('returns null when the work-item carries no plan_item back-pointer', async () => {
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan(null) });
    expect(r).toBeNull();
    expect(mockGetPlanRow).not.toHaveBeenCalled();
  });

  it('returns null when the plan does not resolve', async () => {
    mockGetPlanRow.mockResolvedValueOnce(null);
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('ghost-plan') });
    expect(r).toBeNull();
  });

  it('returns null when the plan has zero decisions (the common case) — stays silent', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITHOUT_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('quiet-plan') });
    expect(r).toBeNull();
  });

  it('surfaces every structured decision, bounded + slug-tagged, when the plan has decisions', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('agent-trap-guards-2026-07-26') });
    expect(r).not.toBeNull();
    expect(r?.planSlug).toBe('agent-trap-guards-2026-07-26');
    expect(r?.decisions.map((d) => d.id)).toEqual(['D-001', 'D-002']);
    expect(r?.decisions[1]?.title).toMatch(/ruling other lanes must follow/);
    // The snippet is a bounded, single-line excerpt of the body — never the raw
    // multi-line markdown.
    expect(r?.decisions[1]?.snippet).not.toMatch(/\n/);
    // Under the cap, the window IS the whole set — so the count a caller renders
    // is honest without any "showing N of M" hedging.
    expect(r?.totalDecisions).toBe(2);
  });

  // EI-19396519606401168 — the cap kept the OLDEST decisions, so a late ruling
  // that defers the very item being claimed never reached the claimer.
  it('over the cap: keeps the MOST RECENT window, not the oldest', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_MANY_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('busy-plan') });
    expect(r?.decisions).toHaveLength(8);
    // The newest 8 of 12 — D-001..D-004 fall out of the window, D-012 survives.
    expect(r?.decisions.map((d) => d.id)).toEqual([
      'D-005', 'D-006', 'D-007', 'D-008', 'D-009', 'D-010', 'D-011', 'D-012',
    ]);
  });

  it('over the cap: a late DEFERRAL ruling reaches the claimer (the regression that motivated this)', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_MANY_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('busy-plan') });
    const deferral = r?.decisions.find((d) => d.id === 'D-012');
    expect(deferral).toBeDefined();
    expect(deferral?.title).toMatch(/deferred/i);
    // Under the old slice(0, 8) this was the observed failure: the last id
    // surfaced was D-008 and the deferral was invisible.
    expect(r?.decisions.at(-1)?.id).not.toBe('D-008');
  });

  it('over the cap: reports the TRUE total so the window cannot read as the whole set', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_MANY_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('busy-plan') });
    expect(r?.totalDecisions).toBe(12);
    // The whole point: total and window length must be independently readable,
    // so a caller can say "8 of 12" instead of announcing 8 as the total.
    expect(r?.totalDecisions).toBeGreaterThan(r!.decisions.length);
  });

  it('puts source-qualified affected-plan authority before local decisions and warns explicitly', async () => {
    mockGetPlanRow.mockResolvedValueOnce({
      content: PLAN_WITH_DECISIONS,
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'target-plan',
    });
    const lookupAffectedDecisions = vi.fn(async () => ({
      decisions: [
        {
          planSlug: 'source-plan',
          decisionId: 'D-900',
          title: 'The target must not launch from staging',
          body: 'This affected-plan ruling supersedes stale local carry prose.',
        },
      ],
      totalDecisions: 1,
    }));
    // P-018 (D-012 item 4): rows are keyed by the decision's OWN plan, so the affected decision
    // is joined against source-plan and the local ones against target-plan.
    const loadProvenance = vi.fn(async (scope: { planSlug: string }, ids: readonly string[]) => {
      const out = new Map<string, { kind: 'agent'; agentId: string; source: 'write'; recordedAt: string } | { kind: 'unrecorded' }>();
      for (const id of ids) out.set(id, { kind: 'unrecorded' });
      if (scope.planSlug === 'source-plan') {
        out.set('D-900', { kind: 'agent', agentId: 'su-x', source: 'write', recordedAt: '2026-10-28T00:00:00.000Z' });
      }
      return out;
    });

    const r = await getClaimTimePlanDecisions({
      planSlug: 'target-plan',
      harness: 'papercusp',
      workspaceId: 'ws-1',
      lookupAffectedDecisions,
      loadProvenance,
    });

    expect(r?.decisions.map((d) => d.id)).toEqual(['D-900', 'D-001', 'D-002']);
    expect(r?.decisions.map((d) => d.provenance.kind)).toEqual(['agent', 'unrecorded', 'unrecorded']);
    expect(loadProvenance).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: 'source-plan' },
      ['D-900'],
    );
    expect(loadProvenance).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: 'target-plan' },
      ['D-001', 'D-002'],
    );
    expect(r?.decisions[0]).toMatchObject({
      sourcePlanSlug: 'source-plan',
      ref: 'source-plan#D-900',
      relation: 'affects',
    });
    expect(r).toMatchObject({
      affectedDecisions: 1,
      totalAffectedDecisions: 1,
      totalLocalDecisions: 2,
      authorityReadFailed: false,
    });
    expect(renderPlanDecisionsNote(r!)).toMatch(/^⚠ CROSS-PLAN AUTHORITY CONFLICT\/SUPERSESSION WARNING:/);
    expect(lookupAffectedDecisions).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      affectedPlanSlug: 'target-plan',
      limit: 8,
    });
  });

  it('surfaces an explicit authority-read failure instead of asserting that no affected decision exists', async () => {
    mockGetPlanRow.mockResolvedValueOnce({
      content: PLAN_WITHOUT_DECISIONS,
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'target-plan',
    });
    const r = await getClaimTimePlanDecisions({
      planSlug: 'target-plan',
      lookupAffectedDecisions: async () => {
        throw new Error('column read failed');
      },
    });
    expect(r?.authorityReadFailed).toBe(true);
    expect(r?.decisions).toEqual([]);
    expect(renderPlanDecisionsNote(r!)).toMatch(/^⚠ CROSS-PLAN AUTHORITY READ FAILED/);
  });

  it('P-018: an unscoped row or a failed provenance read reads unavailable, never unrecorded', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_DECISIONS });
    const unscoped = await getClaimTimePlanDecisions({ planSlug: 'p' });
    expect(unscoped?.decisions.map((d) => d.provenance.kind)).toEqual(['unavailable', 'unavailable']);

    mockGetPlanRow.mockResolvedValueOnce({
      content: PLAN_WITH_DECISIONS,
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'p',
    });
    const failed = await getClaimTimePlanDecisions({
      planSlug: 'p',
      lookupAffectedDecisions: async () => ({ decisions: [], totalDecisions: 0 }),
      loadProvenance: async () => {
        throw new Error('relation missing');
      },
    });
    expect(failed?.decisions.map((d) => d.id)).toEqual(['D-001', 'D-002']);
    expect(failed?.decisions[0].provenance).toEqual({
      kind: 'unavailable',
      reason: 'provenance read failed: relation missing',
    });
  });

  it('fails soft to null on a lookup error — never throws, never blocks the claim it decorates', async () => {
    mockGetPlanRow.mockRejectedValueOnce(new Error('pg hiccup'));
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('flaky-plan') });
    expect(r).toBeNull();
  });
});

// EI-19963837641363759: plan_items:claim already knows the plan slug from its own
// { plan, item } args — no work-item back-pointer to derive it from (a bare-lease
// claim mints no work_item at all). This pins the direct `planSlug` path the fix added.
describe('getClaimTimePlanDecisions — direct `planSlug` (EI-19963837641363759)', () => {
  it('resolves decisions from `planSlug` alone, with no `workItem` at all', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_DECISIONS });
    const r = await getClaimTimePlanDecisions({ planSlug: 'agent-trap-guards-2026-07-26' });
    expect(r).not.toBeNull();
    expect(r?.planSlug).toBe('agent-trap-guards-2026-07-26');
    expect(r?.decisions.map((d) => d.id)).toEqual(['D-001', 'D-002']);
    expect(mockGetPlanRow).toHaveBeenCalledWith('agent-trap-guards-2026-07-26', {});
  });

  it('returns null when `planSlug` is null/undefined and no `workItem` is given either', async () => {
    mockGetPlanRow.mockClear();
    const r1 = await getClaimTimePlanDecisions({ planSlug: null });
    const r2 = await getClaimTimePlanDecisions({});
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(mockGetPlanRow).not.toHaveBeenCalled();
  });

  it('`planSlug` wins over a `workItem` back-pointer when both are given', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_DECISIONS });
    const r = await getClaimTimePlanDecisions({ planSlug: 'explicit-plan', workItem: workItemWithPlan('back-pointer-plan') });
    expect(r?.planSlug).toBe('explicit-plan');
    expect(mockGetPlanRow).toHaveBeenCalledWith('explicit-plan', {});
  });
});
