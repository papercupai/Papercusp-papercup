/**
 * consult-backed-parking-2026-10-12 P-005 — the product-decision park door.
 *
 * R-3: a park without a default action or a deadline is refused, and nothing is opened.
 * R-13: an accepted park opens a decision-review consult carrying the park identity,
 *       stores consult:<id> as the blocker ref, registers the setter's verdict wake and
 *       sends the owner a low-importance FYI.
 * R-14: an owner-authority topic is recorded on the consult's cascade.
 */
import { describe, expect, it, vi } from 'vitest';
const acceptFeedbackRequestProd = vi.hoisted(() => vi.fn());
vi.mock('./get-feedback-prod', () => ({
  acceptFeedbackRequestProd: (...args: unknown[]) => acceptFeedbackRequestProd(...args),
}));
import {
  PARK_DEADLINE_MAX_MINUTES,
  PARK_DEADLINE_MIN_MINUTES,
  PARK_WAKE_GRACE_SEC,
  isParkReassertion,
  makeProdParkDoorDeps,
  openDecisionReviewPark,
  parkCascadeMeta,
  validateParkRequest,
  type ParkDoorDeps,
  type ParkDoorRequest,
} from './park-door';
import { DECISION_REVIEW_CASCADE_FLAVOR } from './decision-review';

const NOW = Date.parse('2026-10-13T00:00:00.000Z');
const inMinutes = (m: number) => new Date(NOW + m * 60_000).toISOString();

function req(over: Partial<ParkDoorRequest> = {}): ParkDoorRequest {
  return {
    workItemId: 'WI-1',
    setterId: 'su-setter',
    question: 'Ship the compact layout as the default?',
    defaultIfUnanswered: 'ship compact as default',
    decideBy: inMinutes(60),
    ownerAuthorityTopic: null,
    callerRef: 'decision:layout',
    ...over,
  };
}

function deps(over: Partial<ParkDoorDeps> = {}) {
  const d = {
    now: vi.fn(() => NOW),
    openConsult: vi.fn(async () => ({ consultId: 'conv-abc' })),
    registerVerdictWake: vi.fn(async () => undefined),
    notifyOwner: vi.fn(async () => undefined),
    ...over,
  };
  return d;
}

describe('validateParkRequest — R-3 refusals', () => {
  it('refuses a park with no default action', () => {
    for (const v of [undefined, null, '', '   ']) {
      const r = validateParkRequest(req({ defaultIfUnanswered: v }), NOW);
      expect(r).toMatchObject({ ok: false, code: 'park_default_required' });
    }
  });

  it('refuses a park with no deadline', () => {
    for (const v of [undefined, null, '', '  ']) {
      const r = validateParkRequest(req({ decideBy: v }), NOW);
      expect(r).toMatchObject({ ok: false, code: 'park_deadline_required' });
    }
  });

  it('refuses a deadline outside 15..1440 minutes or unparseable', () => {
    for (const v of [inMinutes(PARK_DEADLINE_MIN_MINUTES - 1), inMinutes(PARK_DEADLINE_MAX_MINUTES + 1), inMinutes(-30), 'not-a-date']) {
      const r = validateParkRequest(req({ decideBy: v }), NOW);
      expect(r).toMatchObject({ ok: false, code: 'park_deadline_out_of_bounds' });
    }
  });

  it('accepts the deadline bounds inclusively', () => {
    expect(validateParkRequest(req({ decideBy: inMinutes(PARK_DEADLINE_MIN_MINUTES) }), NOW).ok).toBe(true);
    expect(validateParkRequest(req({ decideBy: inMinutes(PARK_DEADLINE_MAX_MINUTES) }), NOW).ok).toBe(true);
  });

  it('refuses an unknown owner-authority topic', () => {
    const r = validateParkRequest(req({ ownerAuthorityTopic: 'vibes' }), NOW);
    expect(r).toMatchObject({ ok: false, code: 'park_owner_authority_topic_invalid' });
  });

  it('normalizes the accepted request', () => {
    const r = validateParkRequest(req({ defaultIfUnanswered: '  ship it  ', ownerAuthorityTopic: 'spend' }), NOW);
    expect(r).toEqual({ ok: true, defaultAction: 'ship it', deadlineAt: inMinutes(60), ownerAuthorityTopic: 'spend' });
  });
});

describe('openDecisionReviewPark — refusals open nothing', () => {
  it.each([
    ['park_default_required', { defaultIfUnanswered: null }],
    ['park_deadline_required', { decideBy: null }],
    ['park_deadline_out_of_bounds', { decideBy: inMinutes(5) }],
    ['park_owner_authority_topic_invalid', { ownerAuthorityTopic: 'nope' }],
  ] as const)('%s: no consult, wake or notice', async (code, over) => {
    const d = deps();
    const r = await openDecisionReviewPark(req(over as Partial<ParkDoorRequest>), d);
    expect(r).toMatchObject({ ok: false, code });
    expect(d.openConsult).not.toHaveBeenCalled();
    expect(d.registerVerdictWake).not.toHaveBeenCalled();
    expect(d.notifyOwner).not.toHaveBeenCalled();
  });
});

describe('openDecisionReviewPark — R-13 accepted park', () => {
  it('opens a decision-review consult with the full park context for reviewers', async () => {
    const d = deps();
    const r = await openDecisionReviewPark(req({
      evidence: 'The plan currently names P-001 as owner and D-001 forbids reassignment.',
      nextVerb: 'resume P-001 or record a superseding plan decision',
    }), d);
    expect(r.ok).toBe(true);
    expect(d.openConsult).toHaveBeenCalledTimes(1);
    expect(d.openConsult).toHaveBeenCalledWith(expect.objectContaining({
      question: 'Ship the compact layout as the default?',
      originTaskRef: 'WI-1',
      observed: 'The plan currently names P-001 as owner and D-001 forbids reassignment.',
      decisionAtStake: [
        'Parked work item: WI-1',
        'Blocker reference: decision:layout',
        `Default if no reviewer objects by ${inMinutes(60)}: ship compact as default`,
        'Next action after review: resume P-001 or record a superseding plan decision',
      ].join('\n'),
      cascade: {
        flavor: DECISION_REVIEW_CASCADE_FLAVOR,
        workItemId: 'WI-1',
        setterId: 'su-setter',
        defaultAction: 'ship compact as default',
        deadlineAt: inMinutes(60),
        ownerAuthorityTopic: null,
      },
      onAccepted: expect.any(Function),
    }));
  });

  it('registers the verdict wake before the accepted-request continuation starts', async () => {
    const order: string[] = [];
    const d = deps({
      openConsult: vi.fn(async (input) => {
        order.push(`accepted:${input.requestKey}`);
        await input.onAccepted?.('conv-abc');
        order.push('dispatch');
        return { consultId: 'conv-abc' };
      }),
      registerVerdictWake: vi.fn(async () => void order.push('wake')),
      notifyOwner: vi.fn(async () => void order.push('notice')),
    });
    const r = await openDecisionReviewPark(req({ requestKey: 'set-blocker-retry-key' }), d);
    expect(r.ok).toBe(true);
    expect(order).toEqual(['accepted:set-blocker-retry-key', 'wake', 'dispatch', 'notice']);
  });

  it('returns consult:<id> as the blocker ref and keeps the caller ref as evidence', async () => {
    const r = await openDecisionReviewPark(req(), deps());
    if (!r.ok) throw new Error('expected ok');
    expect(r.park.consultId).toBe('conv-abc');
    expect(r.park.blockerRef).toBe('consult:conv-abc');
    expect(r.park.evidence).toContain('conv-abc');
    expect(r.park.evidence).toContain('decision:layout');
  });

  it("registers the setter's wake on the verdict event, outliving the deadline", async () => {
    const d = deps();
    const r = await openDecisionReviewPark(req(), d);
    if (!r.ok) throw new Error('expected ok');
    expect(r.park.verdictEvent).toBe('consult:park-verdict:conv-abc');
    expect(r.park.wakeRegistered).toBe(true);
    expect(d.registerVerdictWake).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriberId: 'su-setter',
        eventKey: 'consult:park-verdict:conv-abc',
        timeoutSec: 60 * 60 + PARK_WAKE_GRACE_SEC,
      }),
    );
  });

  it('sends the owner a low-importance FYI naming the default and the consult', async () => {
    const d = deps();
    const r = await openDecisionReviewPark(req(), d);
    if (!r.ok) throw new Error('expected ok');
    expect(r.park.ownerNotified).toBe(true);
    expect(d.notifyOwner).toHaveBeenCalledTimes(1);
    const notice = vi.mocked(d.notifyOwner).mock.calls[0]![0] as { summary: string; body: string; workItemId: string };
    expect(notice.workItemId).toBe('WI-1');
    expect(notice.summary).toMatch(/low importance/i);
    expect(notice.body).toContain('ship compact as default');
    expect(notice.body).toContain('conv-abc');
  });

  it('opens the consult before the wake and the notice', async () => {
    const order: string[] = [];
    const d = deps({
      openConsult: vi.fn(async () => (order.push('consult'), { consultId: 'c1' })),
      registerVerdictWake: vi.fn(async () => void order.push('wake')),
      notifyOwner: vi.fn(async () => void order.push('notice')),
    });
    await openDecisionReviewPark(req(), d);
    expect(order).toEqual(['consult', 'wake', 'notice']);
  });
});

describe('makeProdParkDoorDeps — durable accepted consult identity', () => {
  it('uses acceptFeedbackRequestProd and forwards the request key and pre-dispatch wake', async () => {
    acceptFeedbackRequestProd.mockReset().mockResolvedValue({ conversation_id: 'conv-durable' });
    const identity = { ownerId: 'su-setter', workspaceId: 'ws-1' } as never;
    const request = req({
      requestKey: 'work_items:set_blocker:park:retry',
      evidence: 'The plan currently names P-001 as owner and D-001 forbids reassignment.',
      nextVerb: 'resume P-001 or record a superseding plan decision',
    });
    const validation = validateParkRequest(request, NOW);
    if (!validation.ok) throw new Error('expected valid park');
    const decisionAtStake = [
      `Parked work item: ${request.workItemId}`,
      `Blocker reference: ${request.callerRef}`,
      `Default if no reviewer objects by ${validation.deadlineAt}: ${validation.defaultAction}`,
      `Next action after review: ${request.nextVerb}`,
    ].join('\n');
    const onAccepted = vi.fn(async () => undefined);
    const result = await makeProdParkDoorDeps(identity).openConsult({
      question: request.question,
      originTaskRef: request.workItemId,
      observed: request.evidence!,
      decisionAtStake,
      cascade: parkCascadeMeta(request, validation),
      requestKey: request.requestKey!,
      onAccepted,
    });

    expect(result).toEqual({ consultId: 'conv-durable' });
    expect(acceptFeedbackRequestProd).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        requesterId: 'su-setter',
        requestKey: 'work_items:set_blocker:park:retry',
        question: request.question,
        originTaskRef: request.workItemId,
        observed: request.evidence,
        decisionAtStake,
        cascade: parkCascadeMeta(request, validation),
      }),
      identity,
      { onAccepted: expect.any(Function) },
    );
    const forwarded = acceptFeedbackRequestProd.mock.calls[0]![2].onAccepted;
    await forwarded({ conversation_id: 'conv-durable' });
    expect(onAccepted).toHaveBeenCalledWith('conv-durable');
  });
});

describe('openDecisionReviewPark — R-14 owner-authority topic', () => {
  it('records the topic on the cascade and in the owner notice', async () => {
    const d = deps();
    const r = await openDecisionReviewPark(req({ ownerAuthorityTopic: 'destructive' }), d);
    if (!r.ok) throw new Error('expected ok');
    expect(r.park.ownerAuthorityTopic).toBe('destructive');
    const call = vi.mocked(d.openConsult).mock.calls[0]![0] as { cascade: { ownerAuthorityTopic: string | null } };
    expect(call.cascade.ownerAuthorityTopic).toBe('destructive');
    const notice = vi.mocked(d.notifyOwner).mock.calls[0]![0] as { body: string };
    expect(notice.body).toContain('destructive');
  });

  it('parkCascadeMeta copies the validated topic verbatim', () => {
    const valid = validateParkRequest(req({ ownerAuthorityTopic: 'credentials' }), NOW);
    if (!valid.ok) throw new Error('expected ok');
    expect(parkCascadeMeta({ workItemId: 'WI-9', setterId: 's' }, valid)).toMatchObject({
      flavor: DECISION_REVIEW_CASCADE_FLAVOR,
      workItemId: 'WI-9',
      ownerAuthorityTopic: 'credentials',
    });
  });
});

describe('openDecisionReviewPark — failure handling', () => {
  it('refuses the blocker when the consult cannot be opened, and wakes/notifies nobody', async () => {
    const d = deps({ openConsult: vi.fn(async () => Promise.reject(new Error('router down'))) });
    const r = await openDecisionReviewPark(req(), d);
    expect(r).toMatchObject({ ok: false, code: 'park_consult_failed' });
    if (r.ok) throw new Error('expected refusal');
    expect(r.error).toContain('router down');
    expect(d.registerVerdictWake).not.toHaveBeenCalled();
    expect(d.notifyOwner).not.toHaveBeenCalled();
  });

  it('reports a failed wake or notice on the result instead of un-parking', async () => {
    const d = deps({
      registerVerdictWake: vi.fn(async () => Promise.reject(new Error('await store down'))),
      notifyOwner: vi.fn(async () => Promise.reject(new Error('coord down'))),
    });
    const r = await openDecisionReviewPark(req(), d);
    if (!r.ok) throw new Error('expected ok');
    expect(r.park.blockerRef).toBe('consult:conv-abc');
    expect(r.park.wakeRegistered).toBe(false);
    expect(r.park.ownerNotified).toBe(false);
  });
});

describe('isParkReassertion', () => {
  it('is true only when the ref is already an active product-decision blocker', () => {
    expect(isParkReassertion('consult:conv-abc', ['consult:conv-abc'])).toBe(true);
    expect(isParkReassertion('ask:legacy', ['ask:legacy'])).toBe(true);
    expect(isParkReassertion('consult:other', ['consult:conv-abc'])).toBe(false);
    expect(isParkReassertion(undefined, ['consult:conv-abc'])).toBe(false);
    expect(isParkReassertion('consult:conv-abc', [])).toBe(false);
  });
});
