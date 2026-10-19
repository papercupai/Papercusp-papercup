import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { HiveMemberRecord } from '../hive-membership-store';
import * as resolver from '../relationship-graph/resolver';
import * as workProfiles from './work-profile';
import { projectPersonEquity, readDaoPeople } from './people';

const wallet = '0x1111111111111111111111111111111111111111';
const inspection = { governanceBound: true, supplyInvariant: true, chainId: 1, issuedShares: '300000', holder: { wallet, balance: '100000' } };

describe('public person equity projection', () => {
  it('keeps integer share amounts exact and derives a percentage without floating point', () => {
    expect(projectPersonEquity(inspection, wallet)).toMatchObject({ shares: '100000', issuedShares: '300000', ownershipPercent: '33.33' });
    const large = '900719925474099300000';
    expect(projectPersonEquity({ ...inspection, issuedShares: large, holder: { wallet, balance: large } }, wallet)).toMatchObject({ shares: large, ownershipPercent: '100.00' });
  });
  it('rejects an unverified deployment, another holder and missing chain balances', () => {
    expect(() => projectPersonEquity({ ...inspection, governanceBound: false }, wallet)).toThrow('integrity');
    expect(() => projectPersonEquity({ ...inspection, holder: { ...inspection.holder, wallet: '0x2222222222222222222222222222222222222222' } }, wallet)).toThrow('holder');
    expect(() => projectPersonEquity({ ...inspection, issuedShares: undefined }, wallet)).toThrow('balances');
  });
});

describe('SPEC-P-009 / A — membership defines the people directory', () => {
  const key = { workspaceId: 'ws-people-unit', daoSlug: 'people-dao', policy: null };
  const profile = (personId: string, memberGithubUserId: number): workProfiles.WorkProfile => ({
    workspaceId: key.workspaceId, daoSlug: key.daoSlug, personId, memberGithubUserId,
    title: 'Engineer', team: 'Product', managerPersonId: null, level: null, startDate: null,
    engagementType: 'contractor', jurisdiction: 'US', status: 'active', pay: null, wallet: null,
    onboardedAt: null, createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z',
  });
  const profiles = [profile('PER-alice', 1), profile('PER-candidate', 99)];
  const members: HiveMemberRecord[] = [1, 4].map(id => ({
    workspaceId: key.workspaceId, potHomeSlug: key.daoSlug, githubUserId: id,
    githubUsername: `member-${id}`, displayName: `Member ${id}`, avatarUrl: null,
    deviceAttestations: [], revokedPubkeys: [], bindingStatus: 'bound',
  }));
  const people: Record<string, resolver.CanonicalEntity> = {
    'PER-alice': { id: 'PER-alice', datatype: 'person', title: 'Alice', payload: {} },
    'PER-candidate': { id: 'PER-candidate', datatype: 'person', title: 'Candidate', payload: {} },
  };
  const sql = vi.fn(() => { throw new Error('Unexpected database access in membership unit test'); }) as unknown as Sql;

  beforeEach(() => {
    vi.spyOn(workProfiles, 'listWorkProfiles').mockResolvedValue(profiles);
    vi.spyOn(resolver, 'getCanonicalEntity').mockImplementation(async (_sql, _workspace, _datatype, id) => people[id] ?? null);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('includes an unprofiled member and excludes a candidate who is not a current member', async () => {
    const rows = await readDaoPeople(key, { sql, members: async () => members, viewerGithubId: async () => null });

    expect(rows.map(row => row.memberId)).toEqual([1, 4]);
    expect(rows[0]).toMatchObject({ personId: 'PER-alice', displayName: 'Alice', profile: { title: 'Engineer' } });
    expect(rows[1]).toMatchObject({ memberId: 4, personId: null, displayName: 'Member 4', profile: null });
  });

  it('returns an empty directory when there are profiles but no current members', async () => {
    const rows = await readDaoPeople(key, { sql, members: async () => [], viewerGithubId: async () => null });

    expect(rows).toEqual([]);
  });
});
