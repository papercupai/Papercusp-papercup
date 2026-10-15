/**
 * steward-hand-dispatch.test — the pure predicate (WI-10005281). The create-tool WIRING
 * is pinned in agent-tools/work_items/create.steward-hand-dispatch.test.ts; this file
 * pins the verdict table and the notice's operative content, with a deliberately-wrong
 * control (`naive`) proving the table would catch a "any goal context = steward" regression.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('./holder-authority', () => ({ readGoalHolderAuthority: m.read }));

import { evaluateStewardHandDispatch, stewardHandDispatchNotice } from './steward-hand-dispatch';

const auth = (status: string, goalId: string | null = 'g1') => ({
  status,
  goalId,
  electedOwnerId: 'x',
  electedEpoch: 1,
  handoffExpiresAt: null,
});
const base = { workspaceId: 'ws', ownerId: 'steward', assignTo: 'su-other', goalContextId: 'g1' };

/** The WRONG rule this module exists to avoid: treat any resolved goal context as a steward. */
const naive = (a: { assignTo?: string; goalContextId: string | null; ownerId?: string }) =>
  Boolean(a.assignTo && a.goalContextId && a.assignTo !== a.ownerId);

// Braces matter: `() => m.read.mockReset()` RETURNS the mock, and vitest runs a beforeEach's return value as its
// cleanup hook — so the mock itself was invoked after each test and its 'boom' impl surfaced as a test failure.
beforeEach(() => {
  m.read.mockReset();
});

describe('evaluateStewardHandDispatch', () => {
  it.each([
    ['elected', true],
    ['handoff', true],
    ['none', false], // inherited context only — a fleet member/leader
    ['superseded', false], // resolveGoalContext's fence refuses these upstream; never a hand-out here
  ])('authority %s → handDispatch=%s', async (status, expected) => {
    m.read.mockResolvedValue(auth(status));
    const v = await evaluateStewardHandDispatch(base);
    expect(v.handDispatch).toBe(expected);
    if (v.handDispatch) {
      expect(v.goalId).toBe('g1');
      expect(v.requestedAssignee).toBe('su-other');
    }
  });

  it('control: the naive any-goal-context rule would flag the inherited member this guard must spare', async () => {
    m.read.mockResolvedValue(auth('none'));
    expect(naive(base)).toBe(true);
    expect((await evaluateStewardHandDispatch(base)).handDispatch).toBe(false);
  });

  it('self-assignment, missing assignee, missing goal context, wildcard workspace → no read, no verdict', async () => {
    for (const over of [
      { assignTo: 'steward' },
      { assignTo: undefined },
      { goalContextId: null },
      { workspaceId: '*' },
      { ownerId: undefined },
    ]) {
      expect((await evaluateStewardHandDispatch({ ...base, ...over })).handDispatch).toBe(false);
    }
    expect(m.read).not.toHaveBeenCalled();
  });

  it('an unreadable authority store fails OPEN', async () => {
    m.read.mockImplementation(async () => {
      throw new Error('boom');
    });
    expect((await evaluateStewardHandDispatch(base)).handDispatch).toBe(false);
  });

  it('falls back to the resolved goal context when the authority row carries no goal id', async () => {
    m.read.mockResolvedValue(auth('elected', null));
    const v = await evaluateStewardHandDispatch(base);
    expect(v.handDispatch && v.goalId).toBe('g1');
  });
});

describe('stewardHandDispatchNotice', () => {
  it('names the goal, the dropped assignee, the rail verbs, and the WI-10004867 named-claim rule', () => {
    const n = stewardHandDispatchNotice('g1', 'su-other');
    for (const part of ['FILED UNASSIGNED', 'g1', 'su-other', 'scheduler:set_claim_spec', 'fleet:launch-on-plan', 'WI-10004867']) {
      expect(n).toContain(part);
    }
  });
});
