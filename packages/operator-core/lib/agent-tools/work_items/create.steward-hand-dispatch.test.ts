/**
 * create.steward-hand-dispatch.test — WI-10005281 (recurrence of WI-10004867).
 *
 * A goal HOLDER (the session that RUNS the goal) files work unassigned and steers
 * through the claim rails; `work_items:create { assign_to: <other agent> }` by it is a
 * hand-dispatch and is DOWNGRADED to an unassigned filing (never refused — the finding
 * stays durable), with a loud caller-facing notice and a persisted payload marker.
 * Inherited goal context (a fleet member/leader) is NOT a steward and keeps assigning.
 *
 * The REAL `evaluateStewardHandDispatch` runs here (only the authority SQL read and the
 * downstream admission seams are mocked), so this pins the WIRING, not just the helper.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getFlag: vi.fn(async () => true),
  resolveGoalContext: vi.fn(async (): Promise<string | null> => 'goal-123'),
  readAuthority: vi.fn(),
  admit: vi.fn(async () => ({ allowed: true, scoped: false }) as any),
  gateWorkScope: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'me', workspaceId: 'default' }),
  resolveSelfLiteral: (value: string | undefined, callerOwnerId: string) => (value === 'self' ? callerOwnerId : value),
}));
vi.mock('./_create-core', () => ({ createOneWorkItem: vi.fn() }));
vi.mock('../../modes/store', () => ({ getModes: vi.fn(async () => []) }));
vi.mock('./drain-flow', () => ({ withDrainBugAdmission: vi.fn() }));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitSubjectForFleetTarget: m.admit,
  notifyFleetScopeRefusal: vi.fn(),
  fleetScopeLeaderRemedy: vi.fn(() => 'remedy'),
}));
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: m.getFlag }));
vi.mock('../../modes/goal-context', () => ({ resolveGoalContext: m.resolveGoalContext }));
vi.mock('../../work-scope-policy', () => ({ gateWorkScope: m.gateWorkScope }));
vi.mock('../../work-item-holder-identity', () => ({
  canonicalizeAssigneeOwnerId: vi.fn(async (input: string) => ({ ok: true, ownerId: input })),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../goals/holder-authority', () => ({ readGoalHolderAuthority: m.readAuthority }));

import { createOneWorkItem, type CreateOneWorkItemResult } from './_create-core';
import type { WorkItem } from '../../work-items';
const createM = vi.mocked(createOneWorkItem);

const okCore = (title: string): CreateOneWorkItemResult => ({
  ok: true,
  workItem: { id: `WI-${title}`, kind: 'change', family: 'issue', harness: 'papercup', title, state: 'open' } as unknown as WorkItem,
});
const tool = (await import('./create')).default;
const ctx = { workspaceId: 'default', harnessSlug: 'papercup' } as never;
const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
const entry = async (args: unknown) => {
  const out = ((await tool.handler(parse(args) as never, ctx)) as Out).data;
  return (out.results ?? [out])[0];
};
const authority = (status: string) => ({
  status,
  goalId: 'goal-123',
  electedOwnerId: status === 'elected' ? 'me' : 'someone-else',
  electedEpoch: 1,
  handoffExpiresAt: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.getFlag.mockResolvedValue(true);
  m.resolveGoalContext.mockResolvedValue('goal-123');
  m.readAuthority.mockResolvedValue(authority('elected'));
  m.gateWorkScope.mockResolvedValue({ allowed: true });
  createM.mockImplementation(async (spec) => okCore(spec.title));
});

describe('work_items:create × goal-holder hand-dispatch downgrade (WI-10005281)', () => {
  it('HOLDER + assign_to another agent → filed UNASSIGNED, marker persisted, notice returned, NO admission bypass', async () => {
    const out = await entry({ kind: 'change', title: 'goal attribution ladder', assign_to: 'su-drain-leader' });
    expect(out.ok).toBe(true);
    expect(out.stewardHandDispatchDowngrade).toMatch(/FILED UNASSIGNED/);
    expect(out.stewardHandDispatchDowngrade).toMatch(/goal-123/);
    expect(out.stewardHandDispatchDowngrade).toMatch(/su-drain-leader/);
    const spec = createM.mock.calls[0][0] as any;
    expect(spec.assign_to).toBeUndefined();
    expect(spec.admissionBypass).toBeUndefined(); // a named assignment must not skip the screening floor
    expect(spec.payload.stewardHandDispatchDowngrade).toMatchObject({
      requestedAssignee: 'su-drain-leader',
      reportedBy: 'me',
      goalId: 'goal-123',
    });
    // The hand-out was dropped BEFORE the fleet-scope admission, so no claim could be minted.
    expect(m.admit).not.toHaveBeenCalled();
  });

  it('a live named HANDOFF holder is also a steward', async () => {
    m.readAuthority.mockResolvedValue(authority('handoff'));
    const out = await entry({ kind: 'change', title: 't', assign_to: 'su-other' });
    expect(out.stewardHandDispatchDowngrade).toMatch(/FILED UNASSIGNED/);
    expect((createM.mock.calls[0][0] as any).assign_to).toBeUndefined();
  });

  it('INHERITED goal context (a fleet member/leader — authority none) keeps its assignment', async () => {
    m.readAuthority.mockResolvedValue(authority('none'));
    const out = await entry({ kind: 'change', title: 't', assign_to: 'su-member' });
    expect(out.stewardHandDispatchDowngrade).toBeUndefined();
    expect((createM.mock.calls[0][0] as any).assign_to).toBe('su-member');
    expect(m.admit).toHaveBeenCalledOnce();
  });

  it("the holder assigning to SELF is not a hand-out (assign_to:'self' and the literal id)", async () => {
    for (const assign_to of ['self', 'me']) {
      createM.mockClear();
      const out = await entry({ kind: 'change', title: 't', assign_to });
      expect(out.stewardHandDispatchDowngrade).toBeUndefined();
      expect((createM.mock.calls[0][0] as any).assign_to).toBe('me');
    }
  });

  it('no assign_to → the authority store is never read (the common path costs nothing)', async () => {
    await entry({ kind: 'change', title: 't' });
    expect(m.readAuthority).not.toHaveBeenCalled();
  });

  it('no resolved goal context → never read, assignment untouched', async () => {
    m.resolveGoalContext.mockResolvedValue(null);
    const out = await entry({ kind: 'change', title: 't', assign_to: 'su-other' });
    expect(m.readAuthority).not.toHaveBeenCalled();
    expect(out.stewardHandDispatchDowngrade).toBeUndefined();
    expect((createM.mock.calls[0][0] as any).assign_to).toBe('su-other');
  });

  it('an unreadable authority store FAILS OPEN — the filing and its assignment proceed', async () => {
    m.readAuthority.mockRejectedValue(new Error('pg down'));
    const out = await entry({ kind: 'change', title: 't', assign_to: 'su-other' });
    expect(out.ok).toBe(true);
    expect(out.stewardHandDispatchDowngrade).toBeUndefined();
    expect((createM.mock.calls[0][0] as any).assign_to).toBe('su-other');
  });
});
