/**
 * WI-6554700010029607 — loop:end refuses a fleet member of an ACTIVE fleet while work is
 * claimable under its spec. These cases pin the decision with injected reads: every
 * unknown is fail-open, the bounded retry escape opens after a get_next, and the recovery
 * is set_blocker then scheduler:get_next, never an acknowledgement.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FLEET_MEMBER_CLAIMABLE_WORK_REFUSED,
  buildFleetMemberClaimableRefusal,
  readFleetMemberClaimableWork,
  readFleetMemberLoopEndRefusal,
  shouldRefuseFleetMemberLoopEnd,
  type FleetMemberClaimableDeps,
} from './fleet-member-claimable-work';

const OWNER = 'su-member-1';
const WS = 'ws-1';

function deps(overrides: Partial<FleetMemberClaimableDeps> = {}): FleetMemberClaimableDeps {
  return {
    readMembership: vi.fn(async () => ({ fleetSlug: 'drain-fleet', fleetRole: 'member' })),
    readFleetControlState: vi.fn(async () => 'active'),
    resolveHarness: vi.fn(async () => 'papercusp'),
    countClaimable: vi.fn(async () => 1041),
    readRetriedAfterRefusal: vi.fn(async () => false),
    ...overrides,
  };
}

const input = { ownerId: OWNER, workspaceId: WS, sessionHarness: null, ctx: {} };
const held = [
  { id: 'EI-1', harness: 'papercusp', status: 'open', eventBlockers: [] },
  { id: 'EI-2', harness: 'papercusp', status: 'blocked', eventBlockers: [] },
];

describe('readFleetMemberClaimableWork (positive-finding-only)', () => {
  it('reads a positive finding for a member of an active fleet with claimable work', async () => {
    await expect(readFleetMemberClaimableWork(input, deps())).resolves.toEqual({
      fleetSlug: 'drain-fleet',
      harness: 'papercusp',
      claimableCount: 1041,
    });
  });

  it.each([
    ['not in a fleet', { readMembership: vi.fn(async () => ({ fleetSlug: null, fleetRole: null })) }],
    ['the fleet leader', { readMembership: vi.fn(async () => ({ fleetSlug: 'drain-fleet', fleetRole: 'leader' })) }],
    ['a winding-down fleet', { readFleetControlState: vi.fn(async () => 'winding-down') }],
    ['an unreadable fleet', { readFleetControlState: vi.fn(async () => null) }],
    ['an unresolvable harness', { resolveHarness: vi.fn(async () => null) }],
    ['nothing claimable', { countClaimable: vi.fn(async () => 0) }],
    ['an unknown count', { countClaimable: vi.fn(async () => null) }],
    ['a failed count read', { countClaimable: vi.fn(async () => { throw new Error('pg down'); }) }],
    ['a failed membership read', { readMembership: vi.fn(async () => { throw new Error('pg down'); }) }],
  ] as Array<[string, Partial<FleetMemberClaimableDeps>]>)('returns null for %s', async (_label, override) => {
    await expect(readFleetMemberClaimableWork(input, deps(override))).resolves.toBeNull();
  });

  it('never reads the count once membership rules the session out', async () => {
    const d = deps({ readMembership: vi.fn(async () => ({ fleetSlug: null, fleetRole: null })) });
    await readFleetMemberClaimableWork(input, d);
    expect(d.countClaimable).not.toHaveBeenCalled();
  });
});

describe('shouldRefuseFleetMemberLoopEnd', () => {
  const reading = { fleetSlug: 'drain-fleet', harness: 'papercusp', claimableCount: 3 };

  it('refuses only a readable not-yet-retried positive finding', () => {
    expect(shouldRefuseFleetMemberLoopEnd({ reading, exitAuthorized: false, retriedAfterRefusal: false })).toBe(true);
  });

  it('opens the bounded escape once get_next was called since the refusal', () => {
    expect(shouldRefuseFleetMemberLoopEnd({ reading, exitAuthorized: false, retriedAfterRefusal: true })).toBe(false);
  });

  it('fails open when the retry read is unknown', () => {
    expect(shouldRefuseFleetMemberLoopEnd({ reading, exitAuthorized: false, retriedAfterRefusal: null })).toBe(false);
  });

  it('never refuses an authorized exit or a null reading', () => {
    expect(shouldRefuseFleetMemberLoopEnd({ reading, exitAuthorized: true, retriedAfterRefusal: false })).toBe(false);
    expect(shouldRefuseFleetMemberLoopEnd({ reading: null, exitAuthorized: false, retriedAfterRefusal: false })).toBe(false);
  });
});

describe('buildFleetMemberClaimableRefusal', () => {
  it('routes to set_blocker on waiting held items, then scheduler:get_next, with no acknowledgement override', () => {
    const refusal = buildFleetMemberClaimableRefusal({
      ownerId: OWNER,
      reading: { fleetSlug: 'drain-fleet', harness: 'papercusp', claimableCount: 1041 },
      held,
    });
    expect(refusal.error).toBe(FLEET_MEMBER_CLAIMABLE_WORK_REFUSED);
    expect(refusal.claimableCount).toBe(1041);
    expect(refusal.acknowledgeWakeLessAutonomyOverrides).toBe(false);
    const recovery = refusal.recovery as Array<{ tool: string; args: Record<string, unknown> }>;
    expect(recovery.map((step) => step.tool)).toEqual(['work_items:set_blocker', 'scheduler:get_next']);
    expect(recovery[0]?.args).toEqual({ id: 'EI-1', harness: 'papercusp' });
    expect(recovery[1]?.args).toEqual({ harness: 'papercusp' });
    expect(JSON.stringify(refusal)).not.toContain('acknowledgeWakeLessAutonomy: true');
  });
});

describe('readFleetMemberLoopEndRefusal', () => {
  it('returns the refusal for a member that has not retried', async () => {
    const refusal = await readFleetMemberLoopEndRefusal({ ...input, held }, deps());
    expect(refusal?.error).toBe(FLEET_MEMBER_CLAIMABLE_WORK_REFUSED);
  });

  it('returns null after a get_next retry, and never reads the retry ledger without a positive finding', async () => {
    await expect(
      readFleetMemberLoopEndRefusal({ ...input, held }, deps({ readRetriedAfterRefusal: vi.fn(async () => true) })),
    ).resolves.toBeNull();
    const d = deps({ countClaimable: vi.fn(async () => 0) });
    await expect(readFleetMemberLoopEndRefusal({ ...input, held }, d)).resolves.toBeNull();
    expect(d.readRetriedAfterRefusal).not.toHaveBeenCalled();
  });

  it('fails open when the retry ledger read throws', async () => {
    const d = deps({ readRetriedAfterRefusal: vi.fn(async () => { throw new Error('pg down'); }) });
    await expect(readFleetMemberLoopEndRefusal({ ...input, held }, d)).resolves.toBeNull();
  });
});
