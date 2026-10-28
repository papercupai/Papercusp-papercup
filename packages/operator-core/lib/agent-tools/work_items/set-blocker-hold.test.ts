/**
 * Unit layer for prepareHoldPlacement (plan one-work-graph-structured-holds-2026-10-26, P-010,
 * #D-014). No database: the target lookup, clock and caller identity are injected.
 *
 * SPEC-P-010: a hold whose target does not resolve is refused, and nothing is prepared.
 * SPEC-P-010-CAP / AUTO-BAR-R-4-P-010: an agent hold's review date is capped at
 * HOLD_AGENT_MAX_REVIEW_DAYS; the placer is the calling agent, never an argument.
 * The real-Postgres placement path is set_blocker.hold.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: (ctx: { testOwner?: string }) => {
    if (!ctx?.testOwner) throw new Error('unattributable');
    return { ownerId: ctx.testOwner };
  },
}));

import { HOLD_AGENT_MAX_REVIEW_DAYS, type HoldTarget } from '../../restriction-holds';
import { holdBlockerRef, prepareHoldPlacement, type HoldArg } from './set-blocker-hold';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const CALLER = { testOwner: 'su-hold-unit-placer' };
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY_MS).toISOString();

const validHold: HoldArg = {
  target: { kind: 'work-item', id: 'WI-1234' },
  forbids: 'reset',
  reviewAt: inDays(7),
};

function place(
  hold: HoldArg,
  targetExists: (workspaceId: string, target: HoldTarget) => Promise<boolean>,
  extra: { admitReviewWhen?: (ref: string) => Promise<{ ok: true }> } = {},
) {
  return prepareHoldPlacement(
    { workspaceId: 'ws-unit', hold, reason: 'Rig is mid-drill; a reset loses the capture.', ctx: CALLER },
    { now: () => NOW, targetExists, ...extra },
  );
}

describe('prepareHoldPlacement — target must resolve (SPEC-P-010)', () => {
  it('refuses a target that does not exist and prepares no hold', async () => {
    const seen: Array<[string, HoldTarget]> = [];
    const res = await place(validHold, async (ws, target) => {
      seen.push([ws, target]);
      return false;
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('hold_target_unresolved');
    expect(res.field).toBe('hold.target');
    expect(res.error).toContain("work-item 'WI-1234' does not exist in workspace 'ws-unit'");
    expect('hold' in res).toBe(false);
    expect(seen).toEqual([['ws-unit', { kind: 'work-item', id: 'WI-1234' }]]);
  });

  it('refuses an unresolved target before admitting reviewWhen', async () => {
    const admitReviewWhen = vi.fn(async () => ({ ok: true as const }));
    const res = await place({ ...validHold, reviewWhen: 'work-item:done:WI-1' }, async () => false, { admitReviewWhen });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('hold_target_unresolved');
    expect(admitReviewWhen).not.toHaveBeenCalled();
  });

  it('fails closed when the target cannot be checked', async () => {
    const res = await place(validHold, async () => {
      throw new Error('pool exhausted');
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('hold_target_unverifiable');
    expect(res.error).toContain('pool exhausted');
  });

  it('prepares the hold when the target resolves, with the caller as placer', async () => {
    const res = await place(validHold, async () => true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hold).toMatchObject({
      target: { kind: 'work-item', id: 'WI-1234' },
      forbids: 'reset',
      placedBy: 'agent',
      placedById: 'su-hold-unit-placer',
      reviewAt: validHold.reviewAt,
    });
    expect(res.ref).toBe(holdBlockerRef(res.hold));
    expect(res.ref).toBe('hold:work-item:WI-1234:reset');
  });
});

describe('prepareHoldPlacement — agent review-date cap (SPEC-P-010-CAP)', () => {
  it(`accepts a review date exactly ${HOLD_AGENT_MAX_REVIEW_DAYS} days ahead`, async () => {
    const res = await place({ ...validHold, reviewAt: inDays(HOLD_AGENT_MAX_REVIEW_DAYS) }, async () => true);
    expect(res.ok).toBe(true);
  });

  it('refuses a review date one day past the cap, before any target lookup', async () => {
    const targetExists = vi.fn(async () => true);
    const res = await place({ ...validHold, reviewAt: inDays(HOLD_AGENT_MAX_REVIEW_DAYS + 1) }, targetExists);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('hold_spec_invalid');
    expect(res.error).toMatch(new RegExp(`more than ${HOLD_AGENT_MAX_REVIEW_DAYS} days ahead`));
    expect(targetExists).not.toHaveBeenCalled();
  });

  it('refuses a placement with no review date', async () => {
    const { reviewAt: _omit, ...noReview } = validHold;
    const res = await place(noReview as HoldArg, async () => true);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('hold_spec_invalid');
  });

  it('refuses an unattributable caller instead of recording an anonymous placer', async () => {
    const res = await prepareHoldPlacement(
      { workspaceId: 'ws-unit', hold: validHold, reason: 'x', ctx: {} },
      { now: () => NOW, targetExists: async () => true },
    );
    expect(res.ok).toBe(false);
  });
});
