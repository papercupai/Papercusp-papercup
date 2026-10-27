import { describe, expect, it } from 'vitest';
import {
  HOLD_AGENT_MAX_REVIEW_DAYS,
  canLiftHold,
  holdReviewState,
  isHoldLifted,
  liftHold,
  parseHoldSpec,
  renewHold,
  type HoldPlacedBy,
  type RestrictionHold,
} from './restriction-holds';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000).toISOString();
const agent = { now: NOW, placedBy: 'agent' as const, placedById: 'su-agent-1' };
const owner = { now: NOW, placedBy: 'owner' as const, placedById: 'owner:avi' };

const validSpec = {
  target: { kind: 'machine', id: 'p2p-rig-a' },
  forbids: 'reinstall',
  reason: 'preserve the Oct 15 offline-restore failure state until it is snapshotted',
  reviewAt: inDays(2),
};

function placed(
  overrides: Partial<typeof validSpec> = {},
  ctx: { now: Date; placedBy: HoldPlacedBy; placedById: string } = agent,
): RestrictionHold {
  const r = parseHoldSpec({ ...validSpec, ...overrides }, ctx);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.value;
}

describe('parseHoldSpec', () => {
  it('accepts a complete agent hold and stamps placer + placedAt from context, not input', () => {
    const r = parseHoldSpec(validSpec, agent);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      target: { kind: 'machine', id: 'p2p-rig-a' },
      forbids: 'reinstall',
      placedBy: 'agent',
      placedById: 'su-agent-1',
      placedAt: NOW.toISOString(),
      reviewAt: inDays(2),
      reviews: [],
    });
  });

  it('requires a placer-chosen reviewAt — there is no default', () => {
    const r = parseHoldSpec({ ...validSpec, reviewAt: undefined }, agent);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toMatch(/reviewAt is required/);
  });

  it('refuses a reviewAt in the past', () => {
    const r = parseHoldSpec({ ...validSpec, reviewAt: inDays(-1) }, agent);
    expect(r.ok).toBe(false);
  });

  it(`caps an agent hold at ${HOLD_AGENT_MAX_REVIEW_DAYS} days but not an owner hold`, () => {
    expect(parseHoldSpec({ ...validSpec, reviewAt: inDays(HOLD_AGENT_MAX_REVIEW_DAYS) }, agent).ok).toBe(true);
    expect(parseHoldSpec({ ...validSpec, reviewAt: inDays(HOLD_AGENT_MAX_REVIEW_DAYS + 1) }, agent).ok).toBe(false);
    expect(parseHoldSpec({ ...validSpec, reviewAt: inDays(90) }, owner).ok).toBe(true);
  });

  it('refuses free-text actions and unknown target kinds', () => {
    const r = parseHoldSpec({ ...validSpec, forbids: 'do not touch anything', target: { kind: 'vibe', id: 'x' } }, agent);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toMatch(/forbids must be one of/);
    expect(r.errors.join(' ')).toMatch(/target\.kind must be one of/);
  });

  it('shape-checks target ids, including scoped decision refs', () => {
    expect(parseHoldSpec({ ...validSpec, target: { kind: 'work-item', id: 'WI-2144482' } }, agent).ok).toBe(true);
    expect(parseHoldSpec({ ...validSpec, target: { kind: 'work-item', id: 'the p2p rig' } }, agent).ok).toBe(false);
    expect(
      parseHoldSpec({ ...validSpec, target: { kind: 'decision', id: 'p2p-public-release-endgame-2026-09-01#D-249' } }, agent).ok,
    ).toBe(true);
    // A bare D-NNN is not globally unique and is refused.
    expect(parseHoldSpec({ ...validSpec, target: { kind: 'decision', id: 'D-249' } }, agent).ok).toBe(false);
  });

  it('requires a reason', () => {
    expect(parseHoldSpec({ ...validSpec, reason: '   ' }, agent).ok).toBe(false);
  });
});

describe('holdReviewState', () => {
  it('stays active before reviewAt and becomes due after it — never released by time', () => {
    const hold = placed();
    expect(holdReviewState(hold, { now: NOW })).toBe('active');
    expect(holdReviewState(hold, { now: new Date(inDays(3)) })).toBe('due');
    // Due is still a hold: nothing in the record is lifted by the passage of time.
    expect(isHoldLifted(hold)).toBe(false);
  });

  it('becomes due early when its reviewWhen event fired', () => {
    const hold = placed({}, agent);
    expect(holdReviewState(hold, { now: NOW, reviewWhenFired: true })).toBe('due');
  });
});

describe('lift and renew authority (R-6)', () => {
  it('lets any agent lift an agent hold but only the owner lift an owner hold', () => {
    expect(canLiftHold(placed({}, agent), 'agent')).toBe(true);
    expect(canLiftHold(placed({}, owner), 'agent')).toBe(false);
    expect(canLiftHold(placed({}, owner), 'owner')).toBe(true);
  });

  it('records a lift with its reason', () => {
    const r = liftHold(placed(), { reason: 'snapshot recorded at /mnt/data/snapshots/p2p-rig-a.qcow2' }, { now: NOW, actor: 'agent', actorId: 'su-agent-2' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isHoldLifted(r.value)).toBe(true);
    expect(r.value.reviews?.at(-1)).toMatchObject({ outcome: 'lifted', byId: 'su-agent-2' });
  });

  it('refuses an agent lifting an owner hold', () => {
    const r = liftHold(placed({}, owner), { reason: 'no longer needed' }, { now: NOW, actor: 'agent', actorId: 'su-agent-2' });
    expect(r.ok).toBe(false);
  });
});

describe('renewHold', () => {
  it('renews with a new review date and a current reason', () => {
    const due = new Date(inDays(3));
    const r = renewHold(
      placed(),
      { reviewAt: new Date(due.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(), reason: 'snapshot job still copying (62%)' },
      { now: due, actor: 'agent', actorId: 'su-agent-2' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(holdReviewState(r.value, { now: due })).toBe('active');
    expect(r.value.reviews?.at(-1)).toMatchObject({ outcome: 'renewed', byId: 'su-agent-2' });
  });

  it('refuses a renewal that repeats the previous reason verbatim', () => {
    const r = renewHold(
      placed(),
      { reviewAt: inDays(5), reason: validSpec.reason.toUpperCase() },
      { now: NOW, actor: 'agent', actorId: 'su-agent-2' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toMatch(/current reason/);
  });

  it('keeps the agent cap on renewal even when the owner renews an agent hold', () => {
    const r = renewHold(placed(), { reviewAt: inDays(60), reason: 'owner wants it kept' }, { now: NOW, actor: 'owner', actorId: 'owner:avi' });
    expect(r.ok).toBe(false);
  });

  it('refuses an agent renewing an owner hold', () => {
    const r = renewHold(placed({}, owner), { reviewAt: inDays(5), reason: 'still needed' }, { now: NOW, actor: 'agent', actorId: 'su-agent-2' });
    expect(r.ok).toBe(false);
  });
});
