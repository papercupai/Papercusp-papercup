/**
 * EI-12095: scheduler:get_next's miss diagnosis must recognize "you already hold your max
 * concurrent claims" as a DISTINCT cause from pool/floor admissibility.
 *
 * `getNextForBee` (claim-spec-store.ts) short-circuits BEFORE the claim query whenever the
 * caller already holds >= its spec's maxConcurrentClaims (default 1) — a parked/held item
 * still counts (it retains `taken_by`). Before this fix, the miss-diagnosis path
 * (`buildMissDiagnosis` → `diagnoseClaimNextMiss` / `explainIssueClaimFloors`) had no idea
 * this had happened and reported ordinary pool/floor admissibility stats (e.g. "26 admissible,
 * 0 floored") — a real, expensive false signal: a live fleet leader burned hours bisecting the
 * claim query/tier-3 flag/workspace scope for a member that was simply holding its one slot.
 *
 * These tests pin: a concurrency-blocked miss is reported plainly, with the held ids, and
 * WITHOUT ever invoking the pool/floor diagnosis machinery.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const diagnoseM = vi.hoisted(() => vi.fn());
const explainFloorsM = vi.hoisted(() => vi.fn());
const getClaimSpecRecordM = vi.hoisted(() => vi.fn());
// WI-7376: get_next.ts calls `readClaimConcurrency` (not `getActiveClaimsForBee` directly) —
// readClaimConcurrency is defined INSIDE claim-spec-store.ts and calls its own local
// getActiveClaimsForBee via a same-module binding, which a `vi.mock` override on the
// EXPORTED getActiveClaimsForBee never reaches (mocking an export only redirects OUTSIDE
// callers). Mock readClaimConcurrency itself — the actual boundary get_next.ts crosses —
// so this test can't silently drift onto a real DB read again if claim-spec-store's
// internals are refactored further.
const readClaimConcurrencyM = vi.hoisted(() => vi.fn());
const getNextForBeeM = vi.hoisted(() => vi.fn());
const resolveHolderAdvisoryMapM = vi.hoisted(() => vi.fn());

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-member', workspaceId: 'ws-1' }),
}));
// EI-16057: the harness-existence gate (checked on every miss) resolves `harness` against
// the registry — stub it so every miss here still resolves 'papercusp' as registered and
// falls through to the concurrency/pool-floor diagnosis these tests actually exercise.
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'papercusp' }] })),
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: vi.fn(async () => true),
}));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  // No fleet scope in play — the miss must fall through to buildMissDiagnosis.
  reconcileFleetScopeClaims: vi.fn(async () => ({ scope: null, quarantinedIds: [] })),
  diagnoseFleetScopePlanTerminality: vi.fn(async () => null),
  diagnoseFleetScopeLeaderLiveness: vi.fn(async () => null),
  fleetScopedMiss: vi.fn(),
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
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  diagnoseClaimNextMiss: diagnoseM,
  explainIssueClaimFloors: explainFloorsM,
}));
// EI-20268301668126253: scheduler miss diagnosis must not fan out into holder
// goal/agent_facts reads. Keep a mock at the boundary so a future reintroduction
// of this optional decoration fails this focused regression instead of silently
// restoring the contention amplifier.
vi.mock('../coordination/holder-advisory', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHolderAdvisoryMap: resolveHolderAdvisoryMapM,
}));

import getNextTool from './get_next';
// The REAL evaluateClaimConcurrency (pure, un-mocked — only getNextForBee/getClaimSpecRecord/
// readClaimConcurrency are overridden above) so each test can build its verdict from the same
// held-ids shape the old getActiveClaimsForBee-based mocking used, without duplicating the
// blocked/activeClaims/heldIds arithmetic by hand.
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

describe('scheduler:get_next miss diagnosis is concurrency-aware (EI-12095)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNextForBeeM.mockResolvedValue(null); // every test here is a miss
    diagnoseM.mockResolvedValue({ drained: false, pendingUnclaimed: 26, readyUnclaimed: 26 });
    explainFloorsM.mockResolvedValue([]);
  });

  it('reports the concurrency block plainly, with held ids, WITHOUT running the pool/floor diagnosis', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'x', revision: 1, limits: { maxConcurrentClaims: 1 } },
      revision: 1,
      updatedBy: null,
      updatedAt: null,
    });
    readClaimConcurrencyM.mockResolvedValue(
      evaluateClaimConcurrency({ activeClaims: [{ id: 'EI-10058' }], maxConcurrentClaims: 1 }),
    );

    const b = await callMiss();

    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/claim cap reached: you already hold 1\/1 concurrent claim\(s\)/);
    expect(b.error).toMatch(/held: EI-10058/);
    // EI-23739078854372403: the refusal must name the sanctioned LEADER-owned lever and the
    // EI-11796 rule that a parked/blocked claim still counts, so a member told to "pull other
    // lane work while blocked" learns why it cannot and what would let it — instead of reading
    // a bare wall and releasing a parked item it still owns (the single-fixer failure mode).
    expect(b.error).toContain("scheduler:get_claim_spec { cupId: 'su-member' }");
    expect(b.error).toContain(
      "scheduler:set_claim_spec { cupId: 'su-member', spec: { ...current.spec, " +
        'limits: { ...current.spec.limits, maxConcurrentClaims: N } } }',
    );
    expect(b.error).toContain('exactly one target selector (cupId or fleet) and a full replacement spec');
    expect(b.error).not.toMatch(/scheduler:set_claim_spec \{ limits:/);
    expect(b.error).toMatch(/LEADER raises your cap/);
    // P-010 (plan D-010): a plain park still counts (EI-11796), but the refusal must name
    // set_blocker as the lever that frees a slot for an item waiting on an external condition.
    expect(b.error).toMatch(/plainly parked claim STILL counts \(EI-11796\)/);
    expect(b.error).toContain('work_items:set_blocker — that frees its slot while you keep it');
    expect(b.error).not.toMatch(/declaring a blocker does not buy a slot/);
    expect(b.error).not.toMatch(/Already parked on a recorded blocker/);
    expect(b.diagnosis).toMatchObject({
      concurrencyBlocked: true,
      activeClaims: 1,
      maxConcurrentClaims: 1,
      heldIds: ['EI-10058'],
      blockerParkedIds: [],
    });
    // The whole point: a concurrency-blocked miss must never reach — let alone report — the
    // pool/floor admissibility stats that misled the live incident this closes.
    expect(diagnoseM).not.toHaveBeenCalled();
    expect(explainFloorsM).not.toHaveBeenCalled();
  });

  it('EI-19931420102632438: never leads a concurrency-blocked refusal with the lane-empty STATIC phrase', async () => {
    // The refusal is PRE-LANE — the claim lane was never consulted — so the headline must
    // never read as a statement about lane contents. This is the exact false-alarm shape a
    // fleet leader hit live: the member quoted the old headline verbatim as "282 claimable,
    // 0 returned", a healthy 9-agent lane included, because the string LOOKED like a lane
    // verdict even though only the caller's own concurrency cap was ever evaluated.
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'x', revision: 1, limits: { maxConcurrentClaims: 1 } },
      revision: 1,
      updatedBy: null,
      updatedAt: null,
    });
    readClaimConcurrencyM.mockResolvedValue(
      evaluateClaimConcurrency({ activeClaims: [{ id: 'EI-10058' }], maxConcurrentClaims: 1 }),
    );

    const b = await callMiss();

    expect(b.error).not.toMatch(/no claimable work-item matched your spec within the floors/);
    // The fix must be additive, not merely different wording: the cap facts stay present.
    expect(b.error).toMatch(/1\/1/);
    expect(b.error).toMatch(/EI-10058/);
  });

  it('names EVERY held id when a spec authorizes more than one concurrent claim', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'x', revision: 1, limits: { maxConcurrentClaims: 2 } },
      revision: 1,
      updatedBy: null,
      updatedAt: null,
    });
    readClaimConcurrencyM.mockResolvedValue(
      evaluateClaimConcurrency({
        activeClaims: [{ id: 'EI-1' }, { id: 'EI-2' }],
        maxConcurrentClaims: 2,
      }),
    );

    const b = await callMiss();

    expect(b.error).toMatch(/you already hold 2\/2 concurrent claim\(s\)/);
    expect(b.error).toMatch(/held: EI-1, EI-2/);
    expect(diagnoseM).not.toHaveBeenCalled();
  });

  it('falls through to the pool/floor diagnosis when the caller is UNDER its concurrency limit', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'x', revision: 1, limits: { maxConcurrentClaims: 1 } },
      revision: 1,
      updatedBy: null,
      updatedAt: null,
    });
    readClaimConcurrencyM.mockResolvedValue(
      evaluateClaimConcurrency({ activeClaims: [], maxConcurrentClaims: 1 }),
    ); // holds nothing — a genuine pool/floor miss

    const b = await callMiss();

    expect(b.error).toMatch(/the backlog is NOT drained: 26 unclaimed/);
    expect(b.diagnosis).toMatchObject({ drained: false, pendingUnclaimed: 26, readyUnclaimed: 26 });
    expect(diagnoseM).toHaveBeenCalledOnce();
  });

  it('does not fan out holder advisories while explaining an already-taken floor', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: {
        specId: 'x',
        revision: 1,
        limits: { maxConcurrentClaims: 1 },
        view: { filter: { all: [{ field: 'id', op: 'in', value: ['EI-held'] }] } },
      },
      revision: 1,
      updatedBy: null,
      updatedAt: null,
    });
    readClaimConcurrencyM.mockResolvedValue(
      evaluateClaimConcurrency({ activeClaims: [], maxConcurrentClaims: 1 }),
    );
    explainFloorsM.mockResolvedValue([
      { id: 'EI-held', admissible: false, refusedBy: 'already-taken', heldBy: 'su-holder' },
    ]);

    const b = await callMiss();

    expect(b.floors).toEqual([
      { id: 'EI-held', admissible: false, refusedBy: 'already-taken', heldBy: 'su-holder' },
    ]);
    expect(resolveHolderAdvisoryMapM).not.toHaveBeenCalled();
  });

  it('defaults maxConcurrentClaims to 1 when the spec omits `limits` (matches getNextForBee)', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'default',
      spec: { specId: 'default', revision: 0 }, // no `limits` at all
      revision: null,
      updatedBy: null,
      updatedAt: null,
    });
    readClaimConcurrencyM.mockResolvedValue(
      // spec omits `limits` entirely — evaluateClaimConcurrency's own default (1) applies,
      // matching getNextForBee's default, same as `maxConcurrentClaims: undefined` would.
      evaluateClaimConcurrency({ activeClaims: [{ id: 'WI-42' }] }),
    );

    const b = await callMiss();

    expect(b.error).toMatch(/you already hold 1\/1 concurrent claim\(s\)/);
    expect(diagnoseM).not.toHaveBeenCalled();
  });

  it('fails soft to the ordinary pool/floor diagnosis if readClaimConcurrency errors', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'x', revision: 1, limits: { maxConcurrentClaims: 1 } },
      revision: 1,
      updatedBy: null,
      updatedAt: null,
    });
    // get_next.ts wraps its readClaimConcurrency call in `.catch(() => null)` — a rejection
    // here is the exact boundary that fail-soft path guards.
    readClaimConcurrencyM.mockRejectedValue(new Error('pg boom'));

    const b = await callMiss();

    expect(b.error).toMatch(/the backlog is NOT drained/);
    expect(diagnoseM).toHaveBeenCalledOnce();
  });
});
