/**
 * getNextForBee's plan-item-lane retry loop (WI-3667). The global SQL floors
 * (claimFloorsWhereSql) can't express a linked plan-item's own resolved
 * effectiveStatus (a JS-side blocked-by-graph computation), so getNextForBee
 * claims atomically as before, then POST-CHECKS the plan-item lane via
 * planItemLaneBlockReason: on a hit it releases (never surfaced to the
 * caller) and retries the next row, bounded, failing CLOSED (report no
 * claimable item) once the retry budget is exhausted (EI-9108 — a prior
 * fail-open-serve-anyway exhaustion path guaranteed handing out a row already
 * confirmed blocked; see the last test below).
 *
 * getNextWorkItem / planItemLaneBlockReason / releaseWorkItem / recordClaimAttempt
 * are mocked at the module boundary — no PG. `ignoreStoredSpec:true` still
 * resolves the claim-spec record so WI-4770's fleet-transition guard can fail
 * closed; the SQL fixture therefore behaves like an empty store while isolating
 * the loop under test. Run: cd packages/operator-core && npx vitest run
 * lib/scheduler/get-next-for-bee-plan-lane-guard.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { poolIdleTimeoutSec } from '@papercusp/db-org';
import { createBranchedSqlMock } from '../testing/sql-mock';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));
const getLongLivedAdminPoolMock = vi.hoisted(() => vi.fn(() => sqlMock));
const boundedOrgTxnMock = vi.hoisted(() =>
  vi.fn(async (run: (tx: unknown) => Promise<unknown>, opts: { client?: unknown }) => run(opts.client)),
);

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

vi.mock('../long-lived-admin-pool', () => ({
  getLongLivedAdminPool: getLongLivedAdminPoolMock,
}));

vi.mock('../pg-bounded-txn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pg-bounded-txn')>()),
  boundedOrgTxn: (...args: unknown[]) => boundedOrgTxnMock(...(args as [never, never])),
}));

const getNextWorkItemMock = vi.fn();
vi.mock('./get-next', () => ({
  getNextWorkItem: (...args: unknown[]) => getNextWorkItemMock(...args),
}));

const planItemLaneBlockReasonMock = vi.fn();
vi.mock('./plan-item-lane-guard', () => ({
  planItemLaneBlockReason: (...args: unknown[]) => planItemLaneBlockReasonMock(...args),
}));

// P-002(b): the acceptance-readiness hold is getNextForBee's SECOND post-claim verdict. Mocked
// at the module boundary (default: not held) so this suite pins the WIRING; without it the real
// hold reached the mocked lane-guard module, threw, and silently failed open.
const acceptanceReadinessHoldMock = vi.fn();
vi.mock('./acceptance-readiness-hold', () => ({
  acceptanceReadinessHold: (...args: unknown[]) => acceptanceReadinessHoldMock(...args),
}));

const releaseWorkItemMock = vi.fn(async (..._args: unknown[]) => null);
vi.mock('../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../work-items')>()),
  releaseWorkItem: (...args: unknown[]) => releaseWorkItemMock(...args),
}));

const recordClaimAttemptMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../orchestrator/claim-audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orchestrator/claim-audit')>()),
  recordClaimAttempt: (...args: unknown[]) => recordClaimAttemptMock(...args),
}));

const matchesWorkItemClaimSpecMock = vi.fn((..._args: unknown[]) => true);
vi.mock('./claim-spec-match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claim-spec-match')>()),
  matchesWorkItemClaimSpec: (...args: unknown[]) => matchesWorkItemClaimSpecMock(...args),
}));

import {
  getNextForBee,
  SCHEDULER_CLAIM_COLD_SETUP_ACQUIRE_BUDGET_MS,
  SCHEDULER_CLAIM_SETUP_BUDGET_MS,
} from './claim-spec-store';
import { buildP2pLaneFence } from './p2p-lane-fence';

function claimResult(id: string) {
  return {
    workItem: {
      id,
      family: 'feature' as 'feature' | 'issue',
      payload: { plan_item: { plan_slug: 'a-plan', item_id: id } },
      harness: 'papercusp',
    },
    claimedUnder: { specId: 'default', revision: 1 },
  };
}

// @covers INV-07
describe('getNextForBee — plan-item-lane guard retry loop', () => {
  beforeEach(() => {
    sqlMock.mockReset().mockResolvedValue([]);
    getNextWorkItemMock.mockReset();
    planItemLaneBlockReasonMock.mockReset();
    acceptanceReadinessHoldMock.mockReset().mockResolvedValue(null);
    releaseWorkItemMock.mockReset().mockResolvedValue(null);
    matchesWorkItemClaimSpecMock.mockReset().mockReturnValue(true);
    recordClaimAttemptMock.mockReset().mockResolvedValue(undefined);
    getLongLivedAdminPoolMock.mockReset().mockReturnValue(sqlMock);
    boundedOrgTxnMock
      .mockReset()
      .mockImplementation(async (run: (tx: unknown) => Promise<unknown>, opts: { client?: unknown }) =>
        run(opts.client),
      );
  });

  it('routes the public pull path through the isolated scheduler claim pool', async () => {
    const branches = createBranchedSqlMock([
      {
        label: 'per-bee claim-spec lookup',
        match: (q) => q.includes('FROM harness_shared.cup_claim_specs'),
        respond: () => [],
      },
      {
        label: 'fleet-membership lookup',
        match: (q) => q.includes('FROM harness_shared.fleet_membership_events'),
        respond: () => [],
      },
      {
        label: 'active claims lookup',
        match: (q) => q.includes('taken_by'),
        respond: () => [],
      },
    ]);
    sqlMock.mockImplementation(branches.handler);
    getNextWorkItemMock.mockResolvedValue(null);

    const signal = new AbortController().signal;
    const steps: string[] = [];
    await getNextForBee({
      cupId: 'me',
      harness: 'papercusp',
      ignoreStoredSpec: true,
      useDedicatedClaimPool: true,
      signal,
      onClaimStep: (step) => {
        steps.push(step);
      },
    });

    expect(getLongLivedAdminPoolMock).toHaveBeenCalledWith('scheduler-claim', {
      max: 2,
      prepare: false,
    });
    expect(getNextWorkItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ client: sqlMock, acquirePool: 'scheduler-claim' }),
    );
    expect(boundedOrgTxnMock).toHaveBeenCalledTimes(1);
    expect(boundedOrgTxnMock).toHaveBeenCalledWith(expect.any(Function), {
      client: sqlMock,
      acquirePool: 'scheduler-claim',
      signal,
      acquireTimeoutMs: SCHEDULER_CLAIM_COLD_SETUP_ACQUIRE_BUDGET_MS,
      acquireRetries: 0,
      statementTimeoutMs: SCHEDULER_CLAIM_SETUP_BUDGET_MS,
      lockTimeoutMs: SCHEDULER_CLAIM_SETUP_BUDGET_MS,
    });
    branches.assertAllMatched();
    expect(steps).toEqual([
      'claim-setup-acquisition',
      'claim-spec-read',
      'claim-concurrency-read',
      'candidate-resolution',
    ]);
  });

  it('uses a longer bounded acquisition only on first-use and idle-cold pool paths', async () => {
    const branches = createBranchedSqlMock([
      {
        label: 'per-bee claim-spec lookup',
        match: (q) => q.includes('FROM harness_shared.cup_claim_specs'),
        respond: () => [],
      },
      {
        label: 'fleet-membership lookup',
        match: (q) => q.includes('FROM harness_shared.fleet_membership_events'),
        respond: () => [],
      },
      {
        label: 'active claims lookup',
        match: (q) => q.includes('taken_by'),
        respond: () => [],
      },
    ]);
    const poolSqlMock = vi.fn(branches.handler);
    getLongLivedAdminPoolMock.mockReturnValue(poolSqlMock);
    getNextWorkItemMock.mockResolvedValue(null);

    const pull = () => getNextForBee({
      cupId: 'cold-pool-member',
      harness: 'papercusp',
      ignoreStoredSpec: true,
      useDedicatedClaimPool: true,
    });
    const expectedSetupTimeouts = {
      acquirePool: 'scheduler-claim',
      statementTimeoutMs: SCHEDULER_CLAIM_SETUP_BUDGET_MS,
      lockTimeoutMs: SCHEDULER_CLAIM_SETUP_BUDGET_MS,
    };

    await pull();
    expect(boundedOrgTxnMock).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      expect.objectContaining({
        client: poolSqlMock,
        acquireTimeoutMs: SCHEDULER_CLAIM_COLD_SETUP_ACQUIRE_BUDGET_MS,
        ...expectedSetupTimeouts,
      }),
    );

    await pull();
    expect(boundedOrgTxnMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      expect.objectContaining({
        client: poolSqlMock,
        acquireTimeoutMs: SCHEDULER_CLAIM_SETUP_BUDGET_MS,
        ...expectedSetupTimeouts,
      }),
    );

    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync((poolIdleTimeoutSec() + 1) * 1_000);
      await pull();
      expect(boundedOrgTxnMock).toHaveBeenNthCalledWith(
        3,
        expect.any(Function),
        expect.objectContaining({
          client: poolSqlMock,
          acquireTimeoutMs: SCHEDULER_CLAIM_COLD_SETUP_ACQUIRE_BUDGET_MS,
          ...expectedSetupTimeouts,
        }),
      );
    } finally {
      vi.useRealTimers();
    }

    branches.assertAllMatched();
  });

  it('passes candidate subphases to the public timeout observer', async () => {
    const steps: string[] = [];
    getNextWorkItemMock.mockImplementation(async (
      _spec: unknown, _bee: unknown, opts: { onResolutionStep?: (step: string) => void },
    ) => {
      opts.onResolutionStep?.('candidate-ready-flag-read');
      opts.onResolutionStep?.('candidate-worker-binding-read');
      return null;
    });
    await getNextForBee({
      cupId: 'me',
      harness: 'papercusp',
      ignoreStoredSpec: true,
      onClaimStep: (step) => steps.push(step),
    });
    expect(steps).toContain('candidate-ready-flag-read');
    expect(steps).toContain('candidate-worker-binding-read');
  });

  it('a throwing phase observer cannot break the claim path', async () => {
    getNextWorkItemMock.mockResolvedValue(claimResult('F-observer'));
    planItemLaneBlockReasonMock.mockResolvedValue(null);
    const result = await getNextForBee({
      cupId: 'me',
      harness: 'papercusp',
      ignoreStoredSpec: true,
      onClaimStep: () => {
        throw new Error('diagnostic observer failed');
      },
    });
    expect(result?.workItem.id).toBe('F-observer');
  });

  it('fails closed when the bee already holds an active or parked claim (EI-11796)', async () => {
    // EI-12141 (the durable fix for THIS bug's class — a hand-rolled `.includes()`
    // matcher silently rotting to false-red/false-green on a query-shape refactor):
    // an explicit branch per query getNextForBee's call chain actually issues, via
    // the shared createBranchedSqlMock helper. Even with ignoreStoredSpec:true,
    // getClaimSpecRecord still runs first (its per-bee row lookup, then — on a
    // miss — a fleet-membership lookup) before getActiveClaimsForBee's `taken_by`
    // query; all three are declared here so an unmatched query throws loudly
    // instead of masquerading as an unrelated red/green, and assertAllMatched()
    // below catches a branch going dead the moment a future refactor stops
    // exercising it.
    const branches = createBranchedSqlMock([
      {
        label: 'per-bee claim-spec lookup (cup_claim_specs) — none stored',
        match: (q) => q.includes('FROM harness_shared.cup_claim_specs'),
        respond: () => [],
      },
      {
        label: 'fleet-membership lookup (fleet_membership_events) — no membership',
        match: (q) => q.includes('FROM harness_shared.fleet_membership_events'),
        respond: () => [],
      },
      {
        // getActiveClaimsForBee (claim-spec-store.ts) selects `feature_id AS id,
        // item_kind AS kind ... WHERE ... taken_by = ...` — countActiveClaimsForBee
        // is just `.length` of those rows, so the guard cares about ROW COUNT, not
        // any literal "active_claims" column/alias (there isn't one). Match on
        // `taken_by` (unique to this query among the ones this loop issues) and
        // return one row to simulate the bee already holding a claim.
        label: 'active-claims-by-taken_by',
        match: (q) => q.includes('taken_by'),
        respond: () => [{ id: 'F-held', kind: 'feature' }],
      },
    ]);
    sqlMock.mockImplementation(branches.handler);

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    expect(res).toBeNull();
    expect(getNextWorkItemMock).not.toHaveBeenCalled();
    branches.assertAllMatched();
  });

  it('honors an explicitly authored concurrency limit above one', async () => {
    // EI-12141: explicit branches (see the previous test's comment) instead of a
    // hand-rolled `.includes()` chain — a per-bee spec row exists here, so
    // getClaimSpecRecord returns on the FIRST query and never reaches the
    // fleet-membership lookup (unlike the previous test).
    const branches = createBranchedSqlMock([
      {
        label: 'per-bee claim-spec lookup (cup_claim_specs) — authored maxConcurrentClaims:2',
        match: (q) => q.includes('FROM harness_shared.cup_claim_specs'),
        respond: () => [
          {
            spec: {
              specVersion: '1.0',
              specId: 'parallel-lane',
              revision: 1,
              view: {},
              rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
              limits: { maxConcurrentClaims: 2 },
            },
            revision: 1,
            updated_by: 'leader',
            updated_at: new Date().toISOString(),
            harness_slug: null,
          },
        ],
      },
      {
        // One held claim (< the spec's maxConcurrentClaims:2 authored above) — the
        // guard should let this one through. See the row-shape note in the
        // previous test.
        label: 'active-claims-by-taken_by',
        match: (q) => q.includes('taken_by'),
        respond: () => [{ id: 'F-held', kind: 'feature' }],
      },
    ]);
    sqlMock.mockImplementation(branches.handler);
    getNextWorkItemMock.mockResolvedValueOnce(claimResult('F-parallel'));
    planItemLaneBlockReasonMock.mockResolvedValueOnce(null);

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp' });

    expect(res?.workItem.id).toBe('F-parallel');
    expect(getNextWorkItemMock).toHaveBeenCalledOnce();
    branches.assertAllMatched();
  });

  it('serves the first claim straight through when its plan-item lane is clear', async () => {
    getNextWorkItemMock.mockResolvedValueOnce(claimResult('F-1'));
    planItemLaneBlockReasonMock.mockResolvedValueOnce(null);

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    expect(res?.workItem.id).toBe('F-1');
    expect(res?.specSource).toBe('default');
    expect(getNextWorkItemMock).toHaveBeenCalledTimes(1);
    expect(releaseWorkItemMock).not.toHaveBeenCalled();
  });

  it('applies the shared p2p fence only to default-source pulls (EI-20185650623647293)', async () => {
    getNextWorkItemMock.mockResolvedValueOnce(claimResult('F-default'));
    planItemLaneBlockReasonMock.mockResolvedValueOnce(null);

    const defaultResult = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    expect(defaultResult?.specSource).toBe('default');
    const effectiveDefault = getNextWorkItemMock.mock.calls[0]?.[0] as {
      view?: { filter?: unknown };
    };
    expect(effectiveDefault.view?.filter).toEqual(buildP2pLaneFence());
  });

  it('leaves an explicitly authored bee spec unchanged', async () => {
    const authoredFilter = { field: 'kind' as const, op: 'in' as const, value: ['bug'] };
    sqlMock.mockResolvedValueOnce([
      {
        spec: {
          specVersion: '1.0',
          specId: 'authored-bug-lane',
          revision: 4,
          view: { filter: authoredFilter },
          rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
        },
        revision: 4,
        updated_by: 'leader',
        updated_at: new Date().toISOString(),
        harness_slug: null,
      },
    ]);
    getNextWorkItemMock.mockResolvedValueOnce(claimResult('F-authored'));
    planItemLaneBlockReasonMock.mockResolvedValueOnce(null);

    const authoredResult = await getNextForBee({ cupId: 'me', harness: 'papercusp' });

    expect(authoredResult?.specSource).toBe('cup');
    const effectiveAuthored = getNextWorkItemMock.mock.calls[0]?.[0] as {
      view?: { filter?: unknown };
    };
    expect(effectiveAuthored.view?.filter).toEqual(authoredFilter);
  });

  it('releases a blocked plan-linked claim and serves the next clear one', async () => {
    getNextWorkItemMock
      .mockResolvedValueOnce(claimResult('F-1')) // blocked
      .mockResolvedValueOnce(claimResult('F-2')); // clear
    planItemLaneBlockReasonMock
      .mockResolvedValueOnce({ reason: 'blocked', planSlug: 'a-plan', itemId: 'F-1', effectiveStatus: 'blocked' })
      .mockResolvedValueOnce(null);

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    expect(res?.workItem.id).toBe('F-2');
    expect(getNextWorkItemMock).toHaveBeenCalledTimes(2);
    expect(releaseWorkItemMock).toHaveBeenCalledTimes(1);
    // EI-14837 (completes the EI-15019 class asserted in the quarantine test below): the
    // plan-lane-blocked release is an INTERNAL claim-then-release round-trip — a plan-lane-
    // blocked row is not genuinely claimable by anyone, so re-announcing the broad
    // work-item:claimable key here only spam-wakes every live awaiter for a doomed pick.
    // It MUST suppress the broad co-fire (announceClaimable:false); the targeted
    // claim:released:<id> still fires and the unblock/requeue path re-announces for real.
    expect(releaseWorkItemMock).toHaveBeenCalledWith('F-1', {
      harness: 'papercusp',
      expectedAssignee: 'me',
      announceClaimable: false,
    });
  });

  it('returns null (never serves a blocked row) when the queue drains mid-retry', async () => {
    getNextWorkItemMock.mockResolvedValueOnce(claimResult('F-1')).mockResolvedValueOnce(null); // nothing left after releasing F-1
    planItemLaneBlockReasonMock.mockResolvedValueOnce({
      reason: 'blocked',
      planSlug: 'a-plan',
      itemId: 'F-1',
      effectiveStatus: 'blocked',
    });

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    expect(res).toBeNull();
    expect(releaseWorkItemMock).toHaveBeenCalledTimes(1);
  });

  // P-002(b) wiring: an acceptance hold bounces the row like a lane block, but it must
  // RELEASE before it routes. The dependency store refuses a new unresolved `blocks` edge
  // behind a still-claimed dependant, so routing first would make the hold edge
  // unwritable on every real pull.
  it('releases an acceptance-held row BEFORE routing it, audits the routing outcome, and serves the next row', async () => {
    getNextWorkItemMock
      .mockResolvedValueOnce(claimResult('F-1')) // acceptance-held
      .mockResolvedValueOnce(claimResult('F-2')); // clear
    planItemLaneBlockReasonMock.mockResolvedValue(null);
    const routeAfterRelease = vi.fn(async () => 'held behind repair task EI-R1 (filed now)');
    acceptanceReadinessHoldMock
      .mockResolvedValueOnce({
        reason: 'plan-item a-plan#F-1 is bound to an incomplete acceptance requirement',
        planSlug: 'a-plan',
        itemId: 'F-1',
        effectiveStatus: 'acceptance-incomplete',
        staleBlockedHint: null,
        routeAfterRelease,
      })
      .mockResolvedValueOnce(null);

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    expect(res?.workItem.id).toBe('F-2');
    expect(acceptanceReadinessHoldMock).toHaveBeenCalledTimes(2);
    expect(acceptanceReadinessHoldMock.mock.calls[0]?.[0]).toMatchObject({ id: 'F-1' });
    expect(acceptanceReadinessHoldMock.mock.calls[0]?.[1]).toMatchObject({ by: 'me' });
    expect(releaseWorkItemMock).toHaveBeenCalledTimes(1);
    expect(releaseWorkItemMock).toHaveBeenCalledWith('F-1', {
      harness: 'papercusp',
      expectedAssignee: 'me',
      announceClaimable: false,
    });
    expect(routeAfterRelease).toHaveBeenCalledTimes(1);
    // The order IS the fix: release, then route.
    expect(releaseWorkItemMock.mock.invocationCallOrder[0]).toBeLessThan(
      routeAfterRelease.mock.invocationCallOrder[0] as number,
    );
    const lost = recordClaimAttemptMock.mock.calls
      .map(([raw]) => raw as { feature_id: string; outcome: string; detail?: string })
      .filter((a) => a.outcome === 'lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]?.feature_id).toBe('F-1');
    expect(JSON.parse(lost[0]?.detail ?? '{}')).toMatchObject({
      reason: 'acceptance-readiness-held',
      planSlug: 'a-plan',
      itemId: 'F-1',
      effectiveStatus: 'acceptance-incomplete',
      acceptanceRouting: 'held behind repair task EI-R1 (filed now)',
    });
  });

  it('lets a lane block win: the acceptance hold is not consulted for a lane-blocked row', async () => {
    getNextWorkItemMock
      .mockResolvedValueOnce(claimResult('F-1')) // lane-blocked
      .mockResolvedValueOnce(claimResult('F-2')); // clear
    planItemLaneBlockReasonMock
      .mockResolvedValueOnce({ reason: 'blocked', planSlug: 'a-plan', itemId: 'F-1', effectiveStatus: 'blocked' })
      .mockResolvedValueOnce(null);

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    expect(res?.workItem.id).toBe('F-2');
    expect(acceptanceReadinessHoldMock).toHaveBeenCalledTimes(1);
    expect(acceptanceReadinessHoldMock.mock.calls[0]?.[0]).toMatchObject({ id: 'F-2' });
    const lost = recordClaimAttemptMock.mock.calls
      .map(([raw]) => raw as { outcome: string; detail?: string })
      .filter((a) => a.outcome === 'lost')
      .map((a) => JSON.parse(a.detail ?? '{}') as Record<string, unknown>);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toBe('plan-lane-blocked');
    expect(lost[0]).not.toHaveProperty('acceptanceRouting');
  });

  it('quarantines an issue-family fallback that fails the complete claim spec before serving the next row', async () => {
    const outside = claimResult('EI-out');
    outside.workItem.family = 'issue';
    const inside = claimResult('F-in');
    inside.workItem.family = 'feature';
    getNextWorkItemMock.mockResolvedValueOnce(outside).mockResolvedValueOnce(inside);
    matchesWorkItemClaimSpecMock.mockReturnValueOnce(false);
    planItemLaneBlockReasonMock.mockResolvedValueOnce(null);

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    expect(res?.workItem.id).toBe('F-in');
    expect(matchesWorkItemClaimSpecMock).toHaveBeenCalledOnce();
    // EI-15019: the quarantine release is an INTERNAL claim-then-release round-trip
    // (the row was claimable before and after — nothing observable changed), so it
    // must suppress the broad work-item:claimable co-fire (announceClaimable:false)
    // to stop spamming every live awaiter for a doomed-from-the-start tier-3 pick
    // (e.g. a harness:null item whose title a spec's WI-3268 glob excludes).
    expect(releaseWorkItemMock).toHaveBeenCalledWith('EI-out', {
      harness: 'papercusp',
      expectedAssignee: 'me',
      announceClaimable: false,
    });
    expect(planItemLaneBlockReasonMock).toHaveBeenCalledOnce();
  });

  // EI-9108 (2026-07-10: WI-3503/P-401 handed out via scheduler:get_next while its
  // 7-deep blockedBy chain was still open): the retry-budget-exhaustion path used to
  // FAIL OPEN and serve the last (confirmed-blocked) claim. That guaranteed handing out
  // exactly the row this guard exists to withhold, so it now fails CLOSED — release the
  // last row too and report no claimable item, same as any other exhausted miss.
  it('fails CLOSED (returns null) once the 5-attempt retry budget is exhausted — never serves a confirmed-blocked row (EI-9108)', async () => {
    for (let i = 0; i < 5; i += 1) {
      getNextWorkItemMock.mockResolvedValueOnce(claimResult(`F-${i}`));
      planItemLaneBlockReasonMock.mockResolvedValueOnce({
        reason: 'blocked',
        planSlug: 'a-plan',
        itemId: `F-${i}`,
        effectiveStatus: 'blocked',
      });
    }

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    // Never served (fail-closed): every confirmed-blocked candidate — including the
    // last one at the retry budget's edge — is released, and the caller sees a miss.
    expect(res).toBeNull();
    expect(getNextWorkItemMock).toHaveBeenCalledTimes(5);
    expect(releaseWorkItemMock).toHaveBeenCalledTimes(5);
    // EI-14837: every plan-lane-blocked release on this exhaustion path is likewise an
    // internal round-trip and suppresses the broad work-item:claimable co-fire.
    expect(releaseWorkItemMock).toHaveBeenLastCalledWith('F-4', {
      harness: 'papercusp',
      expectedAssignee: 'me',
      announceClaimable: false,
    });
  });

  /**
   * P-011 (work-item-dependency-edges-2026-08-02): the lane-guard bounce is
   * deliberately INVISIBLE to the caller — the row is claimed, lane-checked, released,
   * and never returned — so until this instrumentation landed it left no trace at all:
   * no counter, no log, no ledger row. That made the plan's own closing question ("has
   * the lane guard demoted to a backstop now that the dependency floor does the work
   * pre-claim?") unanswerable, because the quantity it asks about was never recorded.
   * An invisible cost cannot be shown to have dropped.
   *
   * These tests exist because a detector/instrument that is only asserted against a
   * happy run is indistinguishable from one that never fires (D-019's negative-control
   * rule, recorded on this same plan). So: prove it FIRES on the bounce, prove it
   * DISCRIMINATES (a clear lane writes no bounce row — otherwise the count is
   * meaningless), prove it COUNTS one per bounce, and prove it can never touch
   * admission.
   */
  // @covers INV-14
  // The 'writes NO bounce row when the lane is clear' case is the half that makes the count
  // mean something: an always-recording instrument would pass every other case identically.
  describe('claim_audit instrumentation of the bounce (P-011)', () => {
    function auditCalls() {
      return recordClaimAttemptMock.mock.calls.map(([raw]) => {
        const attempt = raw as {
          feature_id: string;
          claimer_pubkey: string;
          harnessSlug: string;
          outcome: string;
          detail?: string;
        };
        return {
          ...attempt,
          // auditClaimAttempt JSON-stringifies detail (and truncates at 2000 chars)
          // before handing it to the emitter — parse it back to assert on fields.
          detail: JSON.parse(attempt.detail ?? '{}') as Record<string, unknown>,
        };
      });
    }
    const bounceRows = () => auditCalls().filter((c) => c.detail.reason === 'plan-lane-blocked');

    it("records a claim_audit row carrying the lane guard's verdict when it bounces a row", async () => {
      getNextWorkItemMock
        .mockResolvedValueOnce(claimResult('F-1')) // blocked
        .mockResolvedValueOnce(claimResult('F-2')); // clear
      planItemLaneBlockReasonMock
        .mockResolvedValueOnce({
          reason: 'blocked-by',
          planSlug: 'a-plan',
          itemId: 'P-007',
          effectiveStatus: 'blocked',
        })
        .mockResolvedValueOnce(null);

      const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

      expect(res?.workItem.id).toBe('F-2');
      const bounces = bounceRows();
      expect(bounces).toHaveLength(1);
      expect(bounces[0]).toMatchObject({
        feature_id: 'F-1',
        claimer_pubkey: 'me',
        harnessSlug: 'papercusp',
        // 'lost' is the existing outcome for a NON-COMPETITIVE refusal (the fail-closed
        // fleet-scope refusal uses it too) — nothing was lost to another claimer here, so
        // `reason` is what distinguishes this from a genuine race.
        outcome: 'lost',
      });
      // The guard's own verdict, not just a count: which plan item held the row and why.
      // Without these the ledger says churn happened but not which of the guard's three
      // distinct jobs produced it — and only the blocked-by one is the job the dependency
      // floor is expected to take over, which is the whole question P-011 asks.
      expect(bounces[0].detail).toMatchObject({
        planSlug: 'a-plan',
        itemId: 'P-007',
        effectiveStatus: 'blocked',
        laneReason: 'blocked-by',
        family: 'feature',
      });
      // Instrumentation is ADDITIVE — the release it observes still happens, unchanged.
      expect(releaseWorkItemMock).toHaveBeenCalledWith('F-1', {
        harness: 'papercusp',
        expectedAssignee: 'me',
        announceClaimable: false,
      });
    });

    // NEGATIVE CONTROL (D-019). Without this, a `reason` field that was always present —
    // or an assertion that merely counted audit rows — would pass identically, and the
    // bounce count P-011 reads would silently include every ordinary won claim.
    it('writes NO bounce row when the lane is clear — the reason field is what makes the churn countable', async () => {
      getNextWorkItemMock.mockResolvedValueOnce(claimResult('F-clear'));
      planItemLaneBlockReasonMock.mockResolvedValueOnce(null);

      const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

      expect(res?.workItem.id).toBe('F-clear');
      expect(bounceRows()).toHaveLength(0);
      // The won claim is still audited (that path predates P-011) — so the discriminator
      // has to be `reason`, not the mere presence of a row.
      const all = auditCalls();
      expect(all).toHaveLength(1);
      expect(all[0].outcome).toBe('won');
      expect(all[0].detail.reason).toBeUndefined();
      expect(releaseWorkItemMock).not.toHaveBeenCalled();
    });

    it('records one row per bounce, so the ledger count IS the churn count (exhaustion path)', async () => {
      for (let i = 0; i < 5; i += 1) {
        getNextWorkItemMock.mockResolvedValueOnce(claimResult(`F-${i}`));
        planItemLaneBlockReasonMock.mockResolvedValueOnce({
          reason: 'blocked',
          planSlug: 'a-plan',
          itemId: `F-${i}`,
          effectiveStatus: 'blocked',
        });
      }

      const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

      expect(res).toBeNull();
      const bounces = bounceRows();
      expect(bounces).toHaveLength(5);
      expect(bounces.map((b) => b.feature_id)).toEqual(['F-0', 'F-1', 'F-2', 'F-3', 'F-4']);
      // Fail-closed exhaustion writes no `won` row — every audit row on this path is a bounce.
      expect(auditCalls()).toHaveLength(5);
    });

    // Pure observability: a claim_audit hiccup (PG blip, schema drift) must never fail or
    // delay a real claim. The instrument is allowed to lose data; it is NOT allowed to
    // change who gets served.
    it('never lets an audit-write failure touch admission', async () => {
      recordClaimAttemptMock.mockRejectedValue(new Error('claim_audit unavailable'));
      getNextWorkItemMock
        .mockResolvedValueOnce(claimResult('F-1')) // blocked → bounce audit throws
        .mockResolvedValueOnce(claimResult('F-2')); // clear → won audit throws too
      planItemLaneBlockReasonMock
        .mockResolvedValueOnce({ reason: 'blocked', planSlug: 'a-plan', itemId: 'F-1', effectiveStatus: 'blocked' })
        .mockResolvedValueOnce(null);

      const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

      expect(res?.workItem.id).toBe('F-2');
      expect(releaseWorkItemMock).toHaveBeenCalledTimes(1);
      expect(recordClaimAttemptMock).toHaveBeenCalledTimes(2);
    });
  });
});
