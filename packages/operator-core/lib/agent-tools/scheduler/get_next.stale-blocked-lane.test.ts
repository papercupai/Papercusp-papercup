/**
 * WI-7316 — a stale plan-item block must not reach the caller as a drained lane.
 *
 * The post-claim plan-lane bounce is the one miss cause every other diagnosis on this path is
 * structurally blind to: `getNextForBee` CLAIMS the row, runs the lane guard, finds it blocked,
 * releases it and retries — so the SQL floors counted that row as claimable and nothing recorded
 * why it was refused. EI-19397307303043951 gave the resolver a `staleBlockedHint` for exactly the
 * contradiction that matters here (a stored `blocked` token whose every blocked-by dependency has
 * already resolved) and surfaced it on plans:get-item / plans:lint — tools a member polling by
 * claim-spec never calls. These tests pin the WIRING that carries it to the surface such a member
 * does read.
 *
 * The distinction being defended is behavioural, not cosmetic: an ordinary block self-clears when
 * its blocker lifts, so "park and re-poll" is right for it; a stale token clears only when a human
 * runs plans:set-status, so the same advice parks a member on a lane that can never clear itself.
 *
 * Verdict WORDING for the fleet-member path is pinned in fleet-scope-admission.test.ts; this file
 * pins what get_next COLLECTS and what it hands on.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const getNextForBeeM = vi.hoisted(() => vi.fn());
const issueFloorMissM = vi.hoisted(() => vi.fn());
const fleetScopedMissM = vi.hoisted(() => vi.fn());
const cooldownMissM = vi.hoisted(() => vi.fn());

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-member', workspaceId: 'ws-1' }),
}));
// Same seam as get_next.divergence-recheck.test.ts: the per-Hive claim lease is a REAL PG write
// the unit-test guard refuses, and this file is about the bounce collector, not the lease.
// BOTH exports must be supplied — get_next imports them together, so a factory missing one fails
// collection rather than just the call.
vi.mock('../../work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: () => false,
  leaseClaimedWorkItem: vi.fn(async () => true),
}));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'papercusp' }] })),
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: vi.fn(async () => true),
}));
vi.mock('../../events/await/store', () => ({ cancelClaimableAwaits: vi.fn(async () => 0) }));
vi.mock('../../scheduler/fleet-scope-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/fleet-scope-admission')>()),
  // A fleet-scoped member — the caller the original report was written by.
  reconcileFleetScopeClaims: vi.fn(async () => ({
    scope: {
      fleetSlug: 'drain-fleet',
      ownerId: 'su-member',
      record: { source: 'fleet', spec: { specId: 'drain', revision: 8, view: { filter: undefined }, states: ['open'] } },
    },
    quarantinedIds: [],
  })),
  readFleetPauseState: vi.fn(async () => ({ paused: false, reason: null })),
  diagnoseFleetScopeCooldownMiss: cooldownMissM,
  diagnoseFleetScopeIssueFloorMiss: issueFloorMissM,
  diagnoseFleetScopeTerminalExhaustion: vi.fn(async () => null),
  diagnoseFleetScopePlanTerminality: vi.fn(async () => null),
  diagnoseFleetScopeLeaderLiveness: vi.fn(async () => null),
  diagnoseFleetScopeFeatureFamilyExclusions: vi.fn(async () => null),
  fleetScopedMiss: fleetScopedMissM,
}));
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scheduler/claim-spec-store')>();
  return { ...actual, getNextForBee: getNextForBeeM };
});

import getNextTool, { renderStaleBlockedSoloNote, type StaleBlockedLaneRow } from './get_next';

/** A lane-guard block the resolver flagged as self-contradictory. */
const STALE = {
  reason: 'plan-item drain#P-011 is effectively blocked',
  planSlug: 'drain',
  itemId: 'P-011',
  effectiveStatus: 'blocked',
  staleBlockedHint: "stored status 'blocked' but every blocked-by dependency (P-004) is already resolved",
};
/** An ORDINARY block — something really is gating it, so re-polling IS the right advice. */
const HONEST = { ...STALE, staleBlockedHint: null };

/** Breakdown shapes: `drained` ends the pull at one claim, `survivors` triggers the divergence retry. */
const drained = { matchedByFilter: 22, claimable: 0, excluded: {} as never };
const survivors = { matchedByFilter: 22, claimable: 19, excluded: {} as never };

/** Make getNextForBee bounce the given blocks (in order, one per call) and always miss. */
function bounceOnEachPull(...blocks: Array<{ workItemId: string; staleBlockedHint: string | null }>) {
  let call = 0;
  getNextForBeeM.mockImplementation(async (a: { onPlanLaneBlocked?: (b: unknown) => void }) => {
    const block = blocks[Math.min(call++, blocks.length - 1)];
    if (block) a.onPlanLaneBlocked?.({ ...STALE, ...block });
    return null;
  });
}

async function call() {
  const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
    data?: unknown;
    content?: Array<{ text: string }>;
  };
  return out.data ?? JSON.parse(out.content![0]!.text);
}

/** The opts object the tool handed to fleetScopedMiss — where the collected rows land. */
function missOpts() {
  return fleetScopedMissM.mock.calls[0]?.[2] as { staleBlockedLane?: StaleBlockedLaneRow[] } | undefined;
}

describe('WI-7316 — get_next collects post-claim plan-lane bounces and hands them to the miss', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cooldownMissM.mockResolvedValue(null);
    issueFloorMissM.mockResolvedValue(drained);
    fleetScopedMissM.mockReturnValue({ ok: false, error: 'miss', windDown: true });
  });

  it('passes an onPlanLaneBlocked collector into the claim — without it the bounce is unobservable', async () => {
    getNextForBeeM.mockResolvedValue(null);

    await call();

    expect(getNextForBeeM).toHaveBeenCalledTimes(1);
    expect(getNextForBeeM.mock.calls[0]![0]).toEqual(expect.objectContaining({ onPlanLaneBlocked: expect.any(Function) }));
  });

  it('a STALE bounce reaches fleetScopedMiss as a staleBlockedLane row (the drained-lane report it overrides)', async () => {
    bounceOnEachPull({ workItemId: 'WI-9', staleBlockedHint: STALE.staleBlockedHint });

    await call();

    expect(missOpts()?.staleBlockedLane).toEqual([
      { workItemId: 'WI-9', planSlug: 'drain', itemId: 'P-011', hint: STALE.staleBlockedHint },
    ]);
  });

  it('an ORDINARY block contributes nothing — only a resolver-detected contradiction changes the verdict', async () => {
    bounceOnEachPull({ workItemId: 'WI-9', staleBlockedHint: HONEST.staleBlockedHint });

    await call();

    // Empty, not absent: the option is always threaded, so an ordinary block is reported as the
    // measurement it is ("checked, found none") rather than as an unasked question.
    expect(missOpts()?.staleBlockedLane).toEqual([]);
  });

  it('the SAME row bounced by both the claim and the divergence retry is reported once, not twice', async () => {
    // survivors > 0 makes get_next re-ask the claim path; the same row bounces again.
    issueFloorMissM.mockResolvedValue(survivors);
    bounceOnEachPull({ workItemId: 'WI-9', staleBlockedHint: STALE.staleBlockedHint });

    await call();

    expect(getNextForBeeM).toHaveBeenCalledTimes(2);
    // Both retries got the collector too — a bounce on a retry is the same evidence as on pull 1.
    expect(getNextForBeeM.mock.calls[1]![0]).toEqual(expect.objectContaining({ onPlanLaneBlocked: expect.any(Function) }));
    // De-duped by work-item: a caller reads this length as a ROW count, so a double-report would
    // overstate how much of the lane is stuck.
    expect(missOpts()?.staleBlockedLane).toEqual([
      { workItemId: 'WI-9', planSlug: 'drain', itemId: 'P-011', hint: STALE.staleBlockedHint },
    ]);
  });

  it('DIFFERENT rows bounced across the claim and the retry are both reported', async () => {
    issueFloorMissM.mockResolvedValue(survivors);
    bounceOnEachPull(
      { workItemId: 'WI-9', staleBlockedHint: STALE.staleBlockedHint },
      { workItemId: 'WI-10', staleBlockedHint: STALE.staleBlockedHint },
    );

    await call();

    expect(missOpts()?.staleBlockedLane?.map((r) => r.workItemId)).toEqual(['WI-9', 'WI-10']);
  });
});

describe('WI-7316 — renderStaleBlockedSoloNote (the solo/leader counterpart of the member verdict)', () => {
  const row = (n: number): StaleBlockedLaneRow => ({
    workItemId: `WI-${n}`,
    planSlug: 'drain',
    itemId: `P-0${n}`,
    hint: 'blocked-by already resolved',
  });

  it('is EMPTY with no bounces — an ordinary miss reads exactly as it did before', () => {
    expect(renderStaleBlockedSoloNote([])).toBe('');
  });

  it('names the remedy, and says plainly that re-polling cannot help', () => {
    const note = renderStaleBlockedSoloNote([row(1)]);
    expect(note).toContain('NOT A DRAINED LANE');
    expect(note).toContain('plans:set-status');
    expect(note).toContain('re-polling this lane cannot help');
    expect(note).toContain('WI-1 (drain#P-01 — blocked-by already resolved)');
  });

  it('caps the inline list at 3 rows and points at the structured field for the rest', () => {
    const note = renderStaleBlockedSoloNote([row(1), row(2), row(3), row(4), row(5)]);
    expect(note).toContain('5 row(s) WERE claimed');
    expect(note).toContain('WI-3');
    expect(note).not.toContain('WI-4');
    expect(note).toContain('+2 more (see staleBlockedLane)');
  });
});
