import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ read: vi.fn(), outcome: vi.fn(), sql: {} }));
vi.mock('../cupboard/metered-invocation-door-io', () => ({ readPrincipalUsagePage: H.read }));
vi.mock('../cupboard/shadow-metering-reader', () => ({ readIdentityOutcomeCost: H.outcome }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'server-workspace' }));
vi.mock('@papercusp/db-org', async importOriginal => ({ ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: H.sql }) }));
import { getRegistryEntryV2, resolveNamedQueryV2 } from './index';

beforeEach(() => {
  H.read.mockReset();
  H.read.mockResolvedValue({ ok: true, page: { receipts: [], nextCursor: null } });
  H.outcome.mockReset();
  H.outcome.mockImplementation(async (_sql, input) => ({ basis: 'local-funded-release-usage',
    releaseRef: input.releaseRef, currency: 'USD', status: 'unavailable', costPerAcceptedOutcomeMicros: null,
    reason: 'no-funded-usage' }));
});

describe('P-018 cupboard.identityOutcomeCosts named query', () => {
  const releaseRef = 'identity-release:acme/reviewer@1.0.0';
  it('deduplicates exact release refs and uses the server workspace for local evidence', async () => {
    const rows = await resolveNamedQueryV2('cupboard.identityOutcomeCosts', { releaseRefs: [releaseRef, releaseRef], readKey: 'refresh-2' });
    expect(rows).toEqual([{ basis: 'local-funded-release-usage', releaseRef, currency: 'USD',
      status: 'unavailable', costPerAcceptedOutcomeMicros: null, reason: 'no-funded-usage' }]);
    expect(H.outcome).toHaveBeenCalledExactlyOnceWith(H.sql, { workspaceId: 'server-workspace', releaseRef });
    expect(getRegistryEntryV2('cupboard.identityOutcomeCosts')?.backingTables).toEqual([]);
  });
  it('returns exact verified numerator/denominator evidence without making hosted receipts the authority', async () => {
    const metric = { basis: 'local-funded-release-usage', releaseRef, currency: 'USD', status: 'verified',
      costPerAcceptedOutcomeMicros: '2', totalCostMicros: '3', acceptedOutcomes: 2, totalOutcomes: 3,
      turns: 4, evidenceRefs: ['graded-clause:accepted'] };
    H.outcome.mockResolvedValue(metric);
    await expect(resolveNamedQueryV2('cupboard.identityOutcomeCosts', { releaseRefs: [releaseRef] })).resolves.toEqual([metric]);
    expect(H.read).not.toHaveBeenCalled();
  });
  it.each([{ releaseRefs: [releaseRef], workspaceId: 'foreign' }, { releaseRefs: [releaseRef], ownerId: 'foreign' },
    { releaseRefs: [releaseRef], workItem: 'WI-1' }, { releaseRefs: Array(101).fill(releaseRef) }])(
    'refuses browser authority or oversized populations (%j)', async input => {
      await expect(resolveNamedQueryV2('cupboard.identityOutcomeCosts', input)).rejects.toBeTruthy();
      expect(H.outcome).not.toHaveBeenCalled();
    });
  it('leaves malformed and absent release identities unavailable without a database evidence read', async () => {
    await expect(resolveNamedQueryV2('cupboard.identityOutcomeCosts', { releaseRefs: ['identity-release:bad'] }))
      .resolves.toMatchObject([{ status: 'unavailable', reason: 'invalid-scope', costPerAcceptedOutcomeMicros: null }]);
    await expect(resolveNamedQueryV2('cupboard.identityOutcomeCosts', { releaseRefs: [] })).resolves.toEqual([]);
    expect(H.outcome).not.toHaveBeenCalled();
  });
});

describe('P-018 cupboard.identityUsage named query', () => {
  it('passes bounded navigation into the existing server-authenticated client', async () => {
    const input = { limit: 20, cursor: '["a","b"]' };
    await expect(resolveNamedQueryV2('cupboard.identityUsage', input)).resolves.toEqual([
      { ok: true, page: { receipts: [], nextCursor: null } },
    ]);
    expect(H.read).toHaveBeenCalledExactlyOnceWith(input);
    expect(getRegistryEntryV2('cupboard.identityUsage')?.backingTables).toEqual([]);
  });
  it.each([{ payer: 'foreign' }, { principalId: 'foreign' }, { authToken: 'foreign' }, { limit: 201 }])(
    'refuses caller account/credential selection or unbounded requests (%j)', async input => {
      await expect(resolveNamedQueryV2('cupboard.identityUsage', input)).rejects.toBeTruthy();
      expect(H.read).not.toHaveBeenCalled();
    },
  );
  it('carries unavailable evidence as a failure, rather than a measured empty account', async () => {
    H.read.mockResolvedValue({ ok: false, code: 'gh_auth_required', detail: 'sign in', status: 401 });
    await expect(resolveNamedQueryV2('cupboard.identityUsage', {})).resolves.toEqual([
      { ok: false, code: 'gh_auth_required', detail: 'sign in', status: 401 },
    ]);
  });
});
