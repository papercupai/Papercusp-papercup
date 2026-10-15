/**
 * P-007 Phase B (D-027): a claim spec with `lane: 'verification'` staffs a verifier fleet.
 * getNextForBee must serve such a member ONLY verification work (pending agent reviews, then
 * verification tasks, through claimNextVerificationWork) and never fall through to the
 * implementation pool. A spec with no lane, or lane 'implementation', keeps the ordinary pull.
 *
 * getNextWorkItem and claimNextVerificationWork are mocked at the module boundary — no PG.
 * The stored spec is answered by the per-bee cup_claim_specs lookup, as in the
 * plan-lane-guard suite.
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

const claimNextVerificationWorkMock = vi.fn();
vi.mock('../harness/improvements/agent-review', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/improvements/agent-review')>()),
  claimNextVerificationWork: (...args: unknown[]) => claimNextVerificationWorkMock(...args),
}));

import { getNextForBee } from './claim-spec-store';

function storedSpec(lane?: 'implementation' | 'verification', filter?: unknown) {
  return {
    specVersion: '1.0',
    specId: lane === 'verification' ? 'verifier-lane' : 'builder-lane',
    revision: 3,
    view: filter ? { filter } : {},
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    ...(lane ? { lane } : {}),
  };
}

function withStoredSpec(lane?: 'implementation' | 'verification', filter?: unknown) {
  const branches = createBranchedSqlMock([
    {
      label: 'per-bee claim-spec lookup (cup_claim_specs)',
      match: (q) => q.includes('FROM harness_shared.cup_claim_specs'),
      respond: () => [
        {
          spec: storedSpec(lane, filter),
          revision: 3,
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

function workItem(id: string) {
  return { id, family: 'issue' as const, payload: {}, harness: 'papercusp' };
}

describe('getNextForBee — verifier lane (P-007 Phase B / D-027)', () => {
  beforeEach(() => {
    sqlMock.mockReset().mockResolvedValue([]);
    getNextWorkItemMock.mockReset();
    claimNextVerificationWorkMock.mockReset();
    planItemLaneBlockReasonMock.mockReset().mockResolvedValue(null);
    acceptanceReadinessHoldMock.mockReset().mockResolvedValue(null);
    recordClaimAttemptMock.mockReset().mockResolvedValue(undefined);
  });

  it('serves a verifier-lane member verification work, tagged by kind, and never the implementation pool', async () => {
    withStoredSpec('verification');
    claimNextVerificationWorkMock.mockResolvedValueOnce({ workItem: workItem('EI-REVIEW'), kind: 'agent-review' });
    const steps: string[] = [];

    const res = await getNextForBee({ cupId: 'su-verifier', harness: 'papercusp', onClaimStep: (s) => void steps.push(s) });

    expect(claimNextVerificationWorkMock).toHaveBeenCalledOnce();
    expect(claimNextVerificationWorkMock).toHaveBeenCalledWith({
      verifier: 'su-verifier', harnessSlug: 'papercusp',
      filter: undefined, workspaceId: undefined, signal: undefined,
    });
    expect(getNextWorkItemMock).not.toHaveBeenCalled();
    expect(res?.workItem.id).toBe('EI-REVIEW');
    expect(res?.verificationKind).toBe('agent-review');
    expect(res?.claimedUnder).toEqual({ specId: 'verifier-lane', revision: 3 });
    expect(res?.specSource).toBe('cup');
    expect(steps).toContain('verification-lane');
  });

  it('carries the verification-task kind through unchanged', async () => {
    withStoredSpec('verification');
    claimNextVerificationWorkMock.mockResolvedValueOnce({ workItem: workItem('WI-TASK'), kind: 'verification-task' });

    const res = await getNextForBee({ cupId: 'su-verifier', harness: 'papercusp' });

    expect(res?.workItem.id).toBe('WI-TASK');
    expect(res?.verificationKind).toBe('verification-task');
  });

  it('a verifier-lane miss returns null and does NOT fall back to implementation work', async () => {
    const filter = { not: { field: 'plan', op: 'glob', value: 'p2p-*' } };
    withStoredSpec('verification', filter);
    const abort = new AbortController();
    claimNextVerificationWorkMock.mockResolvedValueOnce(null);
    await getNextForBee({ cupId: 'su-verifier', harness: 'papercusp', workspaceId: 'ws-scoped', signal: abort.signal });
    expect(claimNextVerificationWorkMock).toHaveBeenCalledWith({
      verifier: 'su-verifier', harnessSlug: 'papercusp', filter, workspaceId: 'ws-scoped', signal: abort.signal,
    });
    expect(getNextWorkItemMock).not.toHaveBeenCalled();
  });

  it('an unfiltered verifier miss does not fall back to implementation work', async () => {
    withStoredSpec('verification');
    claimNextVerificationWorkMock.mockResolvedValueOnce(null);
    getNextWorkItemMock.mockResolvedValue({ workItem: workItem('F-IMPL'), claimedUnder: { specId: 'x', revision: 1 } });

    const res = await getNextForBee({ cupId: 'su-verifier', harness: 'papercusp' });

    expect(res).toBeNull();
    expect(getNextWorkItemMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no lane', undefined],
    ["lane 'implementation'", 'implementation' as const],
  ])('a spec with %s keeps the ordinary pull and never calls the verifier pool', async (_label, lane) => {
    withStoredSpec(lane);
    getNextWorkItemMock.mockResolvedValueOnce({
      workItem: { ...workItem('F-IMPL'), family: 'feature' as const },
      claimedUnder: { specId: 'builder-lane', revision: 3 },
    });

    const res = await getNextForBee({ cupId: 'su-builder', harness: 'papercusp' });

    expect(claimNextVerificationWorkMock).not.toHaveBeenCalled();
    expect(getNextWorkItemMock).toHaveBeenCalledOnce();
    expect(res?.workItem.id).toBe('F-IMPL');
    expect(res?.verificationKind).toBeUndefined();
  });
});
