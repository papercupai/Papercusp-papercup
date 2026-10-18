import { describe, expect, it } from 'vitest';
import { acceptanceGraderRecovery, acceptanceGraderRefusalFields } from './set-plan-status';
import { planAcceptanceRepairAction } from '../../plan-acceptance-gate';
import type { AcceptanceGraderLifecycle } from '../../acceptance-grader';
import type { AcceptanceGradingSweepState } from '../../acceptance-grading-sweep-state';

// EI-24032136322947460 — a ship refused as `acceptance_ungraded` used to tell the
// shipper that "its lifecycle and the grading sweep own dispatch/recovery" even
// while the acceptance-grading-sweep sat paused under an owner hold, so every plan
// deduped onto an unassigned grading request stalled silently. The refusal now says
// when automatic recovery is unavailable and names the route that still works.

const PAUSED: AcceptanceGradingSweepState = {
  status: 'paused',
  reason: '[owner 2026-09-15] pause ALL background LLM-spending loops. Re-arm only on the owner\'s word.',
  pausedBy: 'su-holder',
  pausedAt: '2026-09-15T16:04:03.666Z',
  autoResumesAt: null,
};
const INACTIVE: AcceptanceGradingSweepState = { status: 'inactive' };
const RUNNING: AcceptanceGradingSweepState = { status: 'running' };

const lifecycle = (over: Partial<AcceptanceGraderLifecycle>): AcceptanceGraderLifecycle => ({
  state: 'deduped',
  idempotencyKey: '',
  label: '',
  ...over,
});

const gateRepair = planAcceptanceRepairAction('plan-a', { satisfied: false, code: 'acceptance_ungraded' }, {
  harnessSlug: 'papercusp',
});

describe('acceptanceGraderRecovery', () => {
  it('names the unassigned deduped request and the manual route while the sweep is paused', () => {
    const recovery = acceptanceGraderRecovery(
      lifecycle({ existingWorkItemId: 'WI-2144068', existingWorkItemAssignee: null }),
      PAUSED,
    );
    expect(recovery).toMatchObject({ code: 'grading_sweep_paused', sweep: PAUSED });
    expect(recovery!.instruction).toContain('WI-2144068');
    expect(recovery!.instruction).toContain('unassigned');
    expect(recovery!.instruction).toContain(PAUSED.reason!);
    expect(recovery!.instruction).toMatch(/will not re-dispatch or escalate/);
    // A deliberate hold must never be "fixed" by re-arming the LLM-spending loop.
    expect(recovery!.instruction).toMatch(/Do not re-arm the sweep/);
    // D-001 (review-routing-through-relevance-router-2026-09-26): the route out is the
    // recruiter, never a grader the shipper picks.
    expect(recovery!.instruction).toMatch(/Do not pick a grader yourself/);
    expect(recovery!.instruction).toMatch(/retry plans:set-plan-status/i);
    expect(recovery!.instruction).not.toMatch(/Have a live non-implementer/);
    expect(recovery!.instruction).toContain('Do not self-grade or launch a parallel reviewer.');
    expect(recovery!.instruction).not.toMatch(/sweep own/i);
  });

  it('points at the holder of a held deduped request', () => {
    const recovery = acceptanceGraderRecovery(
      lifecycle({ existingWorkItemId: 'WI-live', existingWorkItemAssignee: 'su-independent' }),
      PAUSED,
    );
    expect(recovery!.instruction).toContain('held by su-independent');
    // Wait on the routed request; never message the holder (D-001).
    expect(recovery!.instruction).toContain('events:await work-item:done:WI-live');
    expect(recovery!.instruction).toContain('work_items:release WI-live');
    expect(recovery!.instruction).not.toContain('coord:send');
  });

  it('tells a launched-but-never-started judge to retry, since nothing else will', () => {
    const recovery = acceptanceGraderRecovery(lifecycle({ state: 'launched', agentStarted: false }), PAUSED);
    expect(recovery!.instruction).toMatch(/never started/);
    expect(recovery!.instruction).toMatch(/retry plans:set-plan-status/i);
  });

  it('carries a recruitment failure and its retry route', () => {
    const recovery = acceptanceGraderRecovery(
      lifecycle({ state: 'failed', error: 'launch refused: account walled' }),
      PAUSED,
    );
    expect(recovery!.instruction).toContain('launch refused: account walled');
    expect(recovery!.instruction).toMatch(/retry plans:set-plan-status/i);
  });

  it('names assigned graders by owner id and the grading conversation, never "[object Object]"', () => {
    const recovery = acceptanceGraderRecovery(
      lifecycle({
        state: 'assigned',
        conversationId: 'conv-grading-1',
        graders: [
          { ownerId: 'su-grader-a', score: 0.9, liveness: 'live', via: 'floor' },
          { ownerId: 'su-grader-b', score: 0.4, liveness: 'live', via: 'minimum' },
        ],
      }),
      PAUSED,
    );
    expect(recovery!.instruction).toContain('Graders were assigned (su-grader-a, su-grader-b)');
    expect(recovery!.instruction).toContain('grading conversation conv-grading-1');
    expect(recovery!.instruction).not.toContain('[object Object]');
  });

  it('reports an unexplained inactive sweep as its own code, without calling it a deliberate hold', () => {
    const recovery = acceptanceGraderRecovery(lifecycle({ state: 'assigned', graders: [] }), INACTIVE);
    expect(recovery).toMatchObject({ code: 'grading_sweep_inactive', sweep: INACTIVE });
    expect(recovery!.instruction).toContain('routines:list');
    expect(recovery!.instruction).not.toMatch(/Do not re-arm/);
  });

  it('adds nothing when the sweep is running, unknown, or the grading is already settled', () => {
    expect(acceptanceGraderRecovery(lifecycle({}), RUNNING)).toBeUndefined();
    expect(acceptanceGraderRecovery(lifecycle({}), { status: 'unknown', detail: 'boom' })).toBeUndefined();
    expect(acceptanceGraderRecovery(lifecycle({ state: 'settled' }), PAUSED)).toBeUndefined();
    expect(acceptanceGraderRecovery(lifecycle({}), undefined)).toBeUndefined();
  });
});

describe('acceptanceGraderRefusalFields', () => {
  it('replaces only the repair instruction and attaches recovery to the lifecycle', () => {
    const grader = lifecycle({ existingWorkItemId: 'WI-2144068', existingWorkItemAssignee: null });
    const fields = acceptanceGraderRefusalFields(gateRepair, grader, PAUSED);

    // The route stays machine-usable: same kind and the same retry verb.
    expect(fields.repairAction).toEqual({ ...gateRepair, instruction: fields.acceptanceGrader!.recovery!.instruction });
    expect(fields.repairAction!.nextVerb).toEqual(gateRepair.nextVerb);
    expect(fields.acceptanceGrader).toMatchObject({
      state: 'deduped',
      existingWorkItemId: 'WI-2144068',
      recovery: { code: 'grading_sweep_paused' },
    });
  });

  it('leaves the gate repair untouched when recovery is automatic', () => {
    const grader = lifecycle({ state: 'launched' });
    const fields = acceptanceGraderRefusalFields(gateRepair, grader, RUNNING);
    expect(fields.acceptanceGrader).toMatchObject(grader);
    expect(fields.acceptanceGrader?.routeScope).toContain('one-agent/no-additional-agents');
    expect(fields.acceptanceGrader?.routeScope).toContain('platform-routed independent acceptance');
    expect('repairAction' in fields).toBe(false);
  });

  it('returns no fields when no grader was recruited', () => {
    expect(acceptanceGraderRefusalFields(gateRepair, undefined, PAUSED)).toEqual({});
  });
});
