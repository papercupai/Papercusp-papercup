/**
 * WI-5947: a "CLAIM-PATH/READ-PATH DIVERGENCE" must be CONFIRMED by re-asking the claim path
 * before it is pronounced.
 *
 * The divergence verdict compares two observations taken at two DIFFERENT INSTANTS — the claim
 * attempt, and a floor breakdown read afterwards — against a table the whole fleet is mutating.
 * Any row that becomes claimable in between (a peer releasing, a claim-hold lapsing, a detector
 * filing a new bug) reproduces "claimed nothing AND claimable > 0" with a perfectly healthy claim
 * path. That mattered because the verdict does not merely report, it INSTRUCTS: "report this
 * verdict to your fleet leader as a CLAIM-PATH BUG ... it is the reproduction". So ordinary lane
 * churn manufactured fabricated bug reports against healthy code, carrying what read like a clean
 * repro. Observed live 2026-07-26 05:18Z on fleet nonp2p-bug-drain-0725 during a 0->2->4
 * claimable burst.
 *
 * The fix: on a would-be-divergent miss, ask the CLAIM path again (the only oracle that can
 * settle it) — if the retry claims, the caller gets real work instead of a false alarm; if it
 * misses again and a fresh reading still shows survivors, the divergence is real and is reported
 * as `divergenceRecheck: 'confirmed-twice'`.
 *
 * These tests pin the retry BEHAVIOR at the call site. The verdict wording each outcome produces
 * is pinned in fleet-scope-admission.test.ts.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const getNextForBeeM = vi.hoisted(() => vi.fn());
const issueFloorMissM = vi.hoisted(() => vi.fn());
const terminalExhaustionM = vi.hoisted(() => vi.fn());
const planTerminalityM = vi.hoisted(() => vi.fn());
const leaderLivenessM = vi.hoisted(() => vi.fn());
const featureFamilyBreakdownM = vi.hoisted(() => vi.fn());
const fleetScopedMissM = vi.hoisted(() => vi.fn());
const cooldownMissM = vi.hoisted(() => vi.fn());

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-member', workspaceId: 'ws-1' }),
}));
// WI-39730 bridged scheduler:get_next onto the per-Hive claim lease, so every claim now runs
// through leaseClaimedWorkItem — a REAL PG write the unit-test guard refuses. This file is about
// the divergence RE-CHECK, not the lease, so the seam is stubbed with the lease DISABLED:
// `leaseOn === false` short-circuits arbitrateSchedulerClaim before either PG call, leaving the
// exact claim path these assertions were written against. get_next.test.ts owns the lease's own
// coverage (it drives the lease-lost release). BOTH exports must be supplied — get_next imports
// them together, so a factory missing one fails collection, not just the call.
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
  // A fleet-scoped member: this is the path that can report a divergence at all.
  reconcileFleetScopeClaims: vi.fn(async () => ({
    scope: { fleetSlug: 'drain-fleet', ownerId: 'su-member', record: { source: 'fleet', spec: { specId: 'drain', revision: 8, view: { filter: undefined }, states: ['open'] } } },
    quarantinedIds: [],
  })),
  readFleetPauseState: vi.fn(async () => ({ paused: false, reason: null })),
  diagnoseFleetScopeCooldownMiss: cooldownMissM,
  diagnoseFleetScopeIssueFloorMiss: issueFloorMissM,
  diagnoseFleetScopeTerminalExhaustion: terminalExhaustionM,
  diagnoseFleetScopePlanTerminality: planTerminalityM,
  diagnoseFleetScopeLeaderLiveness: leaderLivenessM,
  reconcileFleetScopeLeaderSuccession: vi.fn(async () => null),
  // WI-7151: only ever reached when a breakdown reports matchedByFilter===0 — none of this
  // file's fixtures do (survivors/drained are both 22), so this is a defensive stub only.
  diagnoseFleetScopeFeatureFamilyExclusions: featureFamilyBreakdownM,
  fleetScopedMiss: fleetScopedMissM,
}));
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scheduler/claim-spec-store')>();
  return { ...actual, getNextForBee: getNextForBeeM };
});

import getNextTool from './get_next';

const survivors = { matchedByFilter: 22, claimable: 19, excluded: {} as never };
const drained = { matchedByFilter: 22, claimable: 0, excluded: {} as never };

async function call() {
  const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
    data?: unknown;
    content?: Array<{ text: string }>;
  };
  // EI-20245892539908894: a successful claim returns `{ data }` (defineTool renders it into
  // BOTH structuredContent and text); a miss still returns the plain `{ content }` projection.
  // Unwrap either, so this helper asserts on the payload rather than on the envelope shape.
  return out.data ?? JSON.parse(out.content![0]!.text);
}

/** The opts object the tool handed to fleetScopedMiss (the verdict inputs under test). */
function missOpts() {
  return fleetScopedMissM.mock.calls[0]?.[2] as
    | { divergenceRecheck?: string; issueBreakdown?: unknown; terminalExhaustion?: unknown }
    | undefined;
}

describe('WI-5947 — scheduler:get_next re-confirms a would-be divergence before pronouncing it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cooldownMissM.mockResolvedValue(null);
    terminalExhaustionM.mockResolvedValue(null);
    planTerminalityM.mockResolvedValue(null);
    leaderLivenessM.mockResolvedValue(null);
    featureFamilyBreakdownM.mockResolvedValue(null);
    fleetScopedMissM.mockReturnValue({ ok: false, error: 'miss', windDown: false });
  });

  it('retries the claim when the breakdown reports survivors, and RETURNS the item the retry wins', async () => {
    // The common case: the first attempt lost a race, the row (or another) is claimable now.
    getNextForBeeM
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ workItem: { id: 'WI-1', harness: 'papercusp' }, claimedUnder: 'drain', specSource: 'fleet' });
    issueFloorMissM.mockResolvedValue(survivors);

    const res = await call();

    expect(getNextForBeeM).toHaveBeenCalledTimes(2);
    expect(getNextForBeeM.mock.calls[1]?.[0]).toMatchObject({ useDedicatedClaimPool: true });
    // the caller gets the work it came for — not an error telling it to file a bug
    expect(res.ok).toBe(true);
    expect(res.workItem.id).toBe('WI-1');
    expect(fleetScopedMissM).not.toHaveBeenCalled();
  });

  it('a retry that also misses, with survivors STILL reported, is stamped confirmed-twice', async () => {
    getNextForBeeM.mockResolvedValue(null);
    issueFloorMissM.mockResolvedValue(survivors); // both the initial read and the re-read

    const res = await call();

    expect(getNextForBeeM).toHaveBeenCalledTimes(2);
    expect(getNextForBeeM.mock.calls[1]?.[0]).toMatchObject({ useDedicatedClaimPool: true });
    expect(issueFloorMissM).toHaveBeenCalledTimes(2);
    expect(missOpts()?.divergenceRecheck).toBe('confirmed-twice');
    expect(res.ok).toBe(false);
  });

  it('a retry that misses while the pool has MOVED ON reports no divergence at all', async () => {
    // The racing row was taken by a peer — the re-read shows a genuinely floor-gated pool.
    getNextForBeeM.mockResolvedValue(null);
    issueFloorMissM.mockResolvedValueOnce(survivors).mockResolvedValueOnce(drained);

    await call();

    expect(missOpts()?.divergenceRecheck).toBeUndefined();
    // and the FRESH reading is what the verdict is built from, not the stale suspicion
    expect(missOpts()?.issueBreakdown).toEqual(drained);
  });

  it('does NOT retry on an ordinary drained miss — the common shape pays nothing', async () => {
    getNextForBeeM.mockResolvedValue(null);
    issueFloorMissM.mockResolvedValue(drained);

    await call();

    expect(getNextForBeeM).toHaveBeenCalledTimes(1);
    expect(issueFloorMissM).toHaveBeenCalledTimes(1);
    expect(missOpts()?.divergenceRecheck).toBeUndefined();
  });

  it('passes a status-floor-free all-terminal match to the miss verdict without retrying', async () => {
    // Terminal rows are absent from the claimable-state breakdown, so this second diagnostic is
    // the only signal that distinguishes a completed id-pinned tranche from a stale spec.
    const zeroMatches = { matchedByFilter: 0, claimable: 0, excluded: {} as never };
    getNextForBeeM.mockResolvedValue(null);
    issueFloorMissM.mockResolvedValue(zeroMatches);
    const exhaustion = { matchedByFilter: 2, terminalMatchedByFilter: 2, inFlightMatchedByFilter: 0, parkedMatchedByFilter: 0 };
    terminalExhaustionM.mockResolvedValue(exhaustion);

    const res = await call();

    expect(res.ok).toBe(false);
    expect(getNextForBeeM).toHaveBeenCalledTimes(1);
    expect(terminalExhaustionM).toHaveBeenCalledTimes(1);
    expect(missOpts()?.terminalExhaustion).toEqual(exhaustion);
  });

  it('passes plan terminality and leader liveness to the zero-match miss verdict', async () => {
    const zeroMatches = { matchedByFilter: 0, claimable: 0, excluded: {} as never };
    const activePlan = {
      planSlugs: ['finished-plan'],
      terminalPlanSlugs: [],
      allTerminal: false,
    };
    const planTerminality = {
      planSlugs: ['finished-plan'],
      terminalPlanSlugs: ['finished-plan'],
      allTerminal: true,
    };
    getNextForBeeM.mockResolvedValue(null);
    issueFloorMissM.mockResolvedValue(zeroMatches);
    // The preflight must see NONTERMINAL plan work or the newer plan-complete
    // guard correctly returns before the claim path. The fresh zero-match
    // diagnostic then observes terminality and leader loss and carries both
    // transitions into the miss verdict.
    planTerminalityM.mockResolvedValueOnce(activePlan).mockResolvedValueOnce(planTerminality);
    // Preflight uses the succession seam; this diagnostic reads liveness once.
    leaderLivenessM.mockResolvedValueOnce(false);

    const res = await call();

    expect(res.ok).toBe(false);
    expect(planTerminalityM).toHaveBeenCalledTimes(2);
    expect(leaderLivenessM).toHaveBeenCalledOnce();
    expect(missOpts()).toMatchObject({ planTerminality, leaderLiveness: false });
  });

  it('does not retry on a successful first claim (the hot path is untouched)', async () => {
    getNextForBeeM.mockResolvedValue({ workItem: { id: 'WI-2', harness: 'papercusp' }, claimedUnder: 'drain', specSource: 'fleet' });

    const res = await call();

    expect(res.ok).toBe(true);
    expect(getNextForBeeM).toHaveBeenCalledTimes(1);
    expect(issueFloorMissM).not.toHaveBeenCalled();
  });

  it('uses the dedicated claim pool for a feature-family retry too', async () => {
    const zeroMatches = { matchedByFilter: 0, claimable: 0, excluded: {} as never };
    getNextForBeeM
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ workItem: { id: 'WI-feature', harness: 'papercusp' }, claimedUnder: 'drain', specSource: 'fleet' });
    issueFloorMissM.mockResolvedValue(zeroMatches);
    featureFamilyBreakdownM.mockResolvedValue({ matchedByFilter: 3, claimable: 3, excluded: { claimFloors: 0, reservedPlanLane: 0 } });

    const res = await call();

    expect(getNextForBeeM).toHaveBeenCalledTimes(2);
    expect(getNextForBeeM.mock.calls[1]?.[0]).toMatchObject({ useDedicatedClaimPool: true });
    expect(res.ok).toBe(true);
    expect(res.workItem.id).toBe('WI-feature');
  });

  it('an unavailable breakdown (diagnosis failed soft) never triggers a retry or a divergence claim', async () => {
    getNextForBeeM.mockResolvedValue(null);
    issueFloorMissM.mockResolvedValue(null);

    await call();

    expect(getNextForBeeM).toHaveBeenCalledTimes(1);
    expect(missOpts()?.divergenceRecheck).toBeUndefined();
  });

  it('EI-24905216534076710: forwards pre-floor held feature matches without another claim attempt', async () => {
    getNextForBeeM.mockResolvedValue(null);
    issueFloorMissM.mockResolvedValue({ matchedByFilter: 0, claimable: 0, excluded: {} });
    const featureBreakdown = { matchedByFilter: 1, claimable: 0, excluded: { claimFloors: 1, reservedPlanLane: 0 } };
    featureFamilyBreakdownM.mockResolvedValue(featureBreakdown);

    await call();

    expect(getNextForBeeM).toHaveBeenCalledTimes(1);
    expect(fleetScopedMissM.mock.calls[0]?.[2]).toMatchObject({ featureBreakdown });
    expect(featureFamilyBreakdownM).toHaveBeenCalledTimes(1);
  });

  it('a retry that THROWS leaves the original reading in place and still refuses to claim confirmation', async () => {
    // A degraded retry proves nothing either way; it must not be read as confirmation.
    // The shared bounded-timeout wrapper swallows the throw into a degraded result and logs it —
    // assert that rather than letting an unexpected console.warn fail the run, since the log is
    // the operator's only trace that the re-check could not be completed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getNextForBeeM.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('pg gone'));
    issueFloorMissM.mockResolvedValue(survivors);

    const res = await call();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scheduler:get_next:divergenceRecheck'));
    // a failed re-check is NOT confirmation — the miss reports the honest unconfirmed shape,
    // and the second (fresh) reading is never taken on a degraded retry
    expect(missOpts()?.divergenceRecheck).toBeUndefined();
    expect(issueFloorMissM).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    warn.mockRestore();
  });
});
