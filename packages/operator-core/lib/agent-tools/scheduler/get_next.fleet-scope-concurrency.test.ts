/**
 * WI-6409: a FLEET MEMBER at its concurrency cap must get the cap-led refusal — never
 * `fleetScopedMiss`'s CLAIM-PATH/READ-PATH DIVERGENCE verdict.
 *
 * THE DEFECT THIS PINS. `buildMissDiagnosis` has checked concurrency first since EI-12095, and
 * EI-19931420102632438 hardened its wording ("lead with the CAP, never with the lane-empty
 * phrase"). But get_next.ts skips `buildMissDiagnosis` ENTIRELY when `reconciliation.scope` is
 * set, routing a fleet member's miss to `fleetScopedMiss` instead — so neither fix ever ran on
 * the branch every fleet member actually takes. The sibling branch kept the bug.
 *
 * It is worse there than the case EI-19931420102632438 fixed. `fleetScopedMiss` does not merely
 * describe an empty lane; on seeing survivors in the oracle it pronounces an INTERNAL DEFECT
 * ("this is an internal inconsistency in the claim path's own spec narrowing"), calls the
 * breakdown "the reproduction", and advises the member to file a claim-path bug and NOT stand
 * down. A capped member therefore files a fabricated bug against healthy code — which is
 * exactly what happened on fleet nonp2p-bug-drain, repeatedly, including a "fresh reproduction"
 * appended to this very work-item and broadcast to 10 members.
 *
 * MEASURED (2026-08-09, pool held constant): holding 1/1, two consecutive scheduler:get_next
 * calls returned divergenceRecheck:"confirmed-twice" with "232 of 411 rows pass every floor";
 * releasing to 0 claims and re-calling seconds later SERVED an item under the same spec (rev 7).
 *
 * Note also WHY the check must precede the WI-5947 divergence re-check: that re-check re-runs the
 * same cap-blocked claim, so "confirmed-twice" is guaranteed rather than corroborating. The
 * mechanism built to separate a real defect from lane churn cannot see this cause at all, and
 * dresses the false verdict in its strongest evidence.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const getNextForBeeM = vi.hoisted(() => vi.fn());
const getClaimSpecRecordM = vi.hoisted(() => vi.fn());
// WI-7376: mock `readClaimConcurrency` itself — the actual boundary get_next.ts crosses.
// Overriding the exported getActiveClaimsForBee never reaches claim-spec-store's internal
// same-module call, and the assertion silently drifts onto a real DB read.
const readClaimConcurrencyM = vi.hoisted(() => vi.fn());
const fleetScopedMissM = vi.hoisted(() => vi.fn());
const issueFloorMissM = vi.hoisted(() => vi.fn());
const cooldownMissM = vi.hoisted(() => vi.fn());
const featureFamilyMatchM = vi.hoisted(() => vi.fn());

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-member', workspaceId: 'ws-1' }),
}));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'papercusp' }] })),
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: vi.fn(async () => true),
}));
// The member IS fleet-scoped — this is the branch buildMissDiagnosis never reaches.
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  reconcileFleetScopeClaims: vi.fn(async () => ({
    // `scope.record.source` is read directly by the handler (a 'default' source is the
    // mid-fleet-transition guard), so the fixture must carry the real record shape — a
    // bare {fleet,specId,revision} throws before the branch under test is ever reached.
    scope: {
      fleet: 'nonp2p-bug-drain',
      specId: 'nonp2p-bug-drain',
      revision: 7,
      record: {
        source: 'fleet',
        spec: { specId: 'nonp2p-bug-drain', revision: 7, limits: { maxConcurrentClaims: 1 } },
        revision: 7,
        fleetSlug: 'nonp2p-bug-drain',
      },
    },
    quarantinedIds: [],
  })),
  fleetScopedMiss: fleetScopedMissM,
  diagnoseFleetScopeIssueFloorMiss: issueFloorMissM,
  diagnoseFleetScopeCooldownMiss: cooldownMissM,
  diagnoseFleetScopeFeatureFamilyExclusions: featureFamilyMatchM,
  diagnoseFleetScopePlanTerminality: vi.fn(async () => null),
  diagnoseFleetScopeLeaderLiveness: vi.fn(async () => null),
  reconcileFleetScopeLeaderSuccession: vi.fn(async () => null),
  // EI-12832: a fleet-scoped pull reads the durable pause state before pulling. Unlike the
  // non-fleet suite (whose scope is null, so it never reaches this line), these tests DO —
  // stub it un-paused so the concurrency branch under test is what decides the outcome.
  readFleetPauseState: vi.fn(async () => ({ windingDown: false })),
}));
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scheduler/claim-spec-store')>();
  return {
    ...actual,
    getNextForBee: getNextForBeeM,
    getClaimSpecRecord: getClaimSpecRecordM,
    readClaimConcurrency: readClaimConcurrencyM,
  };
});

import getNextTool from './get_next';
import { evaluateClaimConcurrency } from '../../scheduler/claim-spec-store';

async function callMiss() {
  const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
    data?: unknown;
    content?: Array<{ text: string }>;
  };
  // EI-20245892539908894: a successful claim returns `{ data }` (defineTool renders it into
  // BOTH structuredContent and text); a miss still returns the plain `{ content }` projection.
  // Unwrap either, so this helper asserts on the payload rather than on the envelope shape.
  return out.data ?? JSON.parse(out.content![0]!.text);
}

const SPEC_REC = {
  source: 'fleet',
  spec: { specId: 'nonp2p-bug-drain', revision: 7, limits: { maxConcurrentClaims: 1 } },
  revision: 7,
  updatedBy: null,
  updatedAt: null,
};

/** The verdict fleetScopedMiss really returns for a capped member — survivors present, so it
 *  pronounces a claim-path defect and tells the member not to stand down. */
const DIVERGENCE_VERDICT = {
  ok: false,
  error:
    'CLAIM-PATH/READ-PATH DIVERGENCE: the claim path selected nothing, but the shared ' +
    'claimability oracle reports 232 of 411 in-spec issue-family row(s) passing spec_match AND ' +
    'every claim floor for fleet scope nonp2p-bug-drain (spec rev 7).',
  divergenceRecheck: 'confirmed-twice',
  windDown: false,
};

describe('scheduler:get_next — a fleet-scoped miss is concurrency-aware (WI-6409)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNextForBeeM.mockResolvedValue(null); // every test here is a miss
    fleetScopedMissM.mockReturnValue(DIVERGENCE_VERDICT);
    issueFloorMissM.mockResolvedValue({ matchedByFilter: 411, claimable: 232, excluded: {} });
    cooldownMissM.mockResolvedValue(null);
    featureFamilyMatchM.mockResolvedValue(null);
    getClaimSpecRecordM.mockResolvedValue(SPEC_REC);
  });

  it('returns the cap-led refusal instead of the DIVERGENCE verdict', async () => {
    readClaimConcurrencyM.mockResolvedValue(
      evaluateClaimConcurrency({ activeClaims: [{ id: 'WI-6409' }], maxConcurrentClaims: 1 }),
    );

    const b = await callMiss();

    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/claim cap reached: you already hold 1\/1 concurrent claim\(s\)/);
    expect(b.error).toMatch(/held: WI-6409/);
    expect(b.diagnosis).toMatchObject({
      concurrencyBlocked: true,
      activeClaims: 1,
      maxConcurrentClaims: 1,
      heldIds: ['WI-6409'],
    });
    // The whole point: the member must never be told its lane is internally inconsistent.
    expect(b.error).not.toMatch(/DIVERGENCE/);
    expect(b.divergenceRecheck).toBeUndefined();
    expect(fleetScopedMissM).not.toHaveBeenCalled();
  });

  it('does not even run the divergence machinery — the re-check would only affirm itself', async () => {
    // The WI-5947 re-check re-runs the SAME cap-blocked claim, so it can only ever return
    // "confirmed-twice". Skipping it is both the correctness fix and a saved claim attempt +
    // two oracle reads on the path a saturated fleet hits most often.
    readClaimConcurrencyM.mockResolvedValue(
      evaluateClaimConcurrency({ activeClaims: [{ id: 'WI-6409' }], maxConcurrentClaims: 1 }),
    );

    await callMiss();

    expect(issueFloorMissM).not.toHaveBeenCalled();
    expect(getNextForBeeM).toHaveBeenCalledTimes(1); // the original claim only — no retry
  });

  it('CONTROL: an UNCAPPED fleet member still gets the ordinary fleet-scoped miss', async () => {
    // Without this, a fix that unconditionally reported "capped" would pass the tests above
    // while silently destroying every genuine fleet-scope miss diagnosis.
    readClaimConcurrencyM.mockResolvedValue(
      evaluateClaimConcurrency({ activeClaims: [], maxConcurrentClaims: 1 }),
    );

    const b = await callMiss();

    expect(fleetScopedMissM).toHaveBeenCalled();
    expect(b.error).toMatch(/DIVERGENCE/);
    expect(b.diagnosis?.concurrencyBlocked).toBeUndefined();
  });

  it('FAILS SOFT: a concurrency READ error leaves the ordinary miss reporting intact', async () => {
    // A diagnosis must never become a new way for the claim path to fail.
    readClaimConcurrencyM.mockRejectedValue(new Error('pool exhausted'));

    const b = await callMiss();

    expect(fleetScopedMissM).toHaveBeenCalled();
    expect(b.error).toMatch(/DIVERGENCE/);
  });
});
