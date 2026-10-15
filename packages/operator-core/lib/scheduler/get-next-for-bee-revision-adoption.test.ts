/**
 * Plan `bug-queue-legitimacy-and-actionable-validation-2026-10-10`, D-011 ruling B
 * (SPEC-BQL-P-009-ADOPTION-PULL): an implementation spec with `revisionAdoption: 'first'` adopts
 * ONE orphaned content revision through adoptNextAgentReviewRevision BEFORE its ordinary claim,
 * scoped by the spec's view.filter. No adoption falls through to the ordinary claim; a spec
 * without the field never reaches the adoption core.
 *
 * Same module-boundary mocking as get-next-for-bee-verification-lane.test.ts — no PG. The
 * stored spec is re-validated on read, so these fixtures also prove the field survives the
 * claim-spec schema.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBranchedSqlMock } from '../testing/sql-mock';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

const getNextWorkItemMock = vi.fn();
vi.mock('./get-next', () => ({
  getNextWorkItem: (...args: unknown[]) => getNextWorkItemMock(...args),
}));

const planItemLaneBlockReasonMock = vi.fn(async (..._args: unknown[]) => null);
vi.mock('./plan-item-lane-guard', () => ({
  planItemLaneBlockReason: (...args: unknown[]) => planItemLaneBlockReasonMock(...args),
}));

const acceptanceReadinessHoldMock = vi.fn(async (..._args: unknown[]) => null);
vi.mock('./acceptance-readiness-hold', () => ({
  acceptanceReadinessHold: (...args: unknown[]) => acceptanceReadinessHoldMock(...args),
}));

const recordClaimAttemptMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../orchestrator/claim-audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orchestrator/claim-audit')>()),
  recordClaimAttempt: (...args: unknown[]) => recordClaimAttemptMock(...args),
}));

const adoptNextMock = vi.fn();
const claimNextVerificationWorkMock = vi.fn();
vi.mock('../harness/improvements/agent-review', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/improvements/agent-review')>()),
  adoptNextAgentReviewRevision: (...args: unknown[]) => adoptNextMock(...args),
  claimNextVerificationWork: (...args: unknown[]) => claimNextVerificationWorkMock(...args),
}));

import { getNextForBee } from './claim-spec-store';

function storedSpec(opts: { revisionAdoption?: 'first'; filter?: unknown; states?: string[] }) {
  return {
    specVersion: '1.0',
    specId: 'drain-lane',
    revision: 7,
    view: opts.filter ? { filter: opts.filter } : {},
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    ...(opts.states ? { states: opts.states } : {}),
    ...(opts.revisionAdoption ? { revisionAdoption: opts.revisionAdoption } : {}),
  };
}

function withStoredSpec(opts: { revisionAdoption?: 'first'; filter?: unknown; states?: string[] } = {}) {
  const branches = createBranchedSqlMock([
    {
      label: 'per-bee claim-spec lookup (cup_claim_specs)',
      match: (q) => q.includes('FROM harness_shared.cup_claim_specs'),
      respond: () => [
        {
          spec: storedSpec(opts),
          revision: 7,
          updated_by: 'leader',
          updated_at: new Date().toISOString(),
          harness_slug: null,
        },
      ],
    },
    {
      label: 'active-claims-by-taken_by (none held)',
      match: (q) => q.includes('taken_by'),
      respond: () => [],
    },
  ]);
  sqlMock.mockImplementation(branches.handler);
  return branches;
}

function workItem(id: string, family: 'issue' | 'feature' = 'issue') {
  return { id, family, payload: {}, harness: 'papercusp' };
}

const brief = {
  lane: 'revision-adoption' as const,
  round: 2,
  previousSubmitter: 'su-gone',
  next: ['Read round 2 feedback', 'Revise the report', 'Resubmit'],
};

describe("getNextForBee — revisionAdoption:'first' (D-011 B)", () => {
  beforeEach(() => {
    sqlMock.mockReset().mockResolvedValue([]);
    getNextWorkItemMock.mockReset();
    adoptNextMock.mockReset();
    claimNextVerificationWorkMock.mockReset();
    planItemLaneBlockReasonMock.mockReset().mockResolvedValue(null);
    acceptanceReadinessHoldMock.mockReset().mockResolvedValue(null);
    recordClaimAttemptMock.mockReset().mockResolvedValue(undefined);
  });

  it('serves an adopted revision BEFORE the ordinary claim, scoped by the spec filter, with its brief', async () => {
    const filter = { not: { field: 'title', op: 'glob', value: '*p2p*' } };
    withStoredSpec({ revisionAdoption: 'first', filter });
    adoptNextMock.mockResolvedValueOnce({ adopted: true, workItem: workItem('EI-ORPHAN'), brief, scanned: 3, refusals: {} });
    const abort = new AbortController();
    const steps: string[] = [];

    const res = await getNextForBee({
      cupId: 'su-member', harness: 'papercusp', workspaceId: 'ws-1', signal: abort.signal,
      onClaimStep: (s) => void steps.push(s),
    });

    expect(adoptNextMock).toHaveBeenCalledOnce();
    expect(adoptNextMock).toHaveBeenCalledWith({
      adopter: 'su-member', harnessSlug: 'papercusp', workspaceId: 'ws-1', filter, signal: abort.signal,
    });
    expect(getNextWorkItemMock).not.toHaveBeenCalled();
    expect(res?.workItem.id).toBe('EI-ORPHAN');
    expect(res?.revisionAdoption).toEqual(brief);
    expect(res?.claimedUnder).toEqual({ specId: 'drain-lane', revision: 7 });
    expect(steps).toContain('revision-adoption');
  });

  it('no adoptable revision falls through to the ordinary claim', async () => {
    withStoredSpec({ revisionAdoption: 'first' });
    adoptNextMock.mockResolvedValueOnce({ adopted: false, workItem: null, scanned: 25, refusals: { 'not-submitter': 25 } });
    getNextWorkItemMock.mockResolvedValueOnce({
      workItem: workItem('F-IMPL', 'feature'),
      claimedUnder: { specId: 'drain-lane', revision: 7 },
    });

    const res = await getNextForBee({ cupId: 'su-member', harness: 'papercusp' });

    expect(adoptNextMock).toHaveBeenCalledOnce();
    expect(getNextWorkItemMock).toHaveBeenCalledOnce();
    expect(res?.workItem.id).toBe('F-IMPL');
    expect(res?.revisionAdoption).toBeUndefined();
  });

  it('FALSIFIABILITY CONTROL: a spec without the field never reaches the adoption core', async () => {
    withStoredSpec();
    getNextWorkItemMock.mockResolvedValueOnce({
      workItem: workItem('F-IMPL', 'feature'),
      claimedUnder: { specId: 'drain-lane', revision: 7 },
    });

    const res = await getNextForBee({ cupId: 'su-member', harness: 'papercusp' });

    expect(adoptNextMock).not.toHaveBeenCalled();
    expect(res?.workItem.id).toBe('F-IMPL');
  });

  it("a caller or spec narrowing states away from 'open' skips adoption (adoption rows are open rows)", async () => {
    // CLAIM_STATES_ALLOWLIST is open|failing, so 'failing' alone is the narrowing that matters.
    withStoredSpec({ revisionAdoption: 'first' });
    getNextWorkItemMock.mockResolvedValue({ workItem: workItem('EI-FAILING'), claimedUnder: { specId: 'drain-lane', revision: 7 } });
    await getNextForBee({ cupId: 'su-member', harness: 'papercusp', states: ['failing'] });
    expect(adoptNextMock).not.toHaveBeenCalled();

    withStoredSpec({ revisionAdoption: 'first', states: ['failing'] });
    await getNextForBee({ cupId: 'su-member', harness: 'papercusp' });
    expect(adoptNextMock).not.toHaveBeenCalled();

    withStoredSpec({ revisionAdoption: 'first', states: ['open', 'failing'] });
    adoptNextMock.mockResolvedValueOnce({ adopted: false, workItem: null, scanned: 0, refusals: {} });
    await getNextForBee({ cupId: 'su-member', harness: 'papercusp' });
    expect(adoptNextMock).toHaveBeenCalledOnce();
  });

  it('an adoption fault falls through to the ordinary claim instead of failing the pull', async () => {
    withStoredSpec({ revisionAdoption: 'first' });
    adoptNextMock.mockRejectedValueOnce(new Error('oracle exploded'));
    getNextWorkItemMock.mockResolvedValueOnce({
      workItem: workItem('F-IMPL', 'feature'),
      claimedUnder: { specId: 'drain-lane', revision: 7 },
    });
    const steps: string[] = [];

    const res = await getNextForBee({ cupId: 'su-member', harness: 'papercusp', onClaimStep: (s) => void steps.push(s) });

    expect(res?.workItem.id).toBe('F-IMPL');
    expect(steps).toContain('revision-adoption-failed');
  });

  it('an ABORTED caller stops at the adoption leg rather than claiming ordinary work', async () => {
    withStoredSpec({ revisionAdoption: 'first' });
    const abort = new AbortController();
    adoptNextMock.mockImplementationOnce(async () => {
      abort.abort();
      throw new Error('aborted');
    });

    await expect(getNextForBee({ cupId: 'su-member', harness: 'papercusp', signal: abort.signal })).rejects.toThrow('aborted');
    expect(getNextWorkItemMock).not.toHaveBeenCalled();
  });
});
