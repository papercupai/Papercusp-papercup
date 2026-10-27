/**
 * scope-roster.test.ts — P-006 §5.2/§5.3 roster seam. Pure over an injected
 * live hive membership/epoch readers + optional directory (P-101), no real PG.
 *
 * The load-bearing properties:
 *   - tier-1 (no directory): only an attested, unrevoked owner is a member;
 *   - with a P-101 directory: membership widens to {owner} ∪ publisher-set, and
 *     the owner is always included even if the directory omits them;
 *   - disclosure uses the live hive epoch, independently of grant replay counters;
 *     unresolved authority cannot manufacture an owner grant or baseline epoch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GrantBackedScopeRoster, type FleetDirectory } from './scope-roster';
import type { ScopeId } from '../sync/pot-git/scope-repo';

const SCOPE: ScopeId = { kind: 'fleet', ownerGithubUserId: 42, slug: 'widgets' };
const authority = vi.hoisted(() => ({ members: vi.fn(), epoch: vi.fn() }));
vi.mock('../federated-pot-scope', () => ({ listHiveMembersForLocalPot: authority.members }));
vi.mock('../sync/hyperbee/hive-epoch-state', () => ({ getHiveEpoch: authority.epoch }));
const member = (githubUserId: number, device = `device-${githubUserId}`, revokedPubkeys: string[] = []) =>
  ({ githubUserId, deviceAttestations: [{ device_pubkey: device }], revokedPubkeys });
beforeEach(() => {
  authority.members.mockReset().mockResolvedValue([member(42), member(100), member(200)]);
  authority.epoch.mockReset().mockResolvedValue(0);
});

/** A fake `sql` tag returning a fixed grantor-epoch row set. */
function fakeSql(rows: { high_water_epoch: number }[]) {
  const calls: unknown[][] = [];
  const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    return Promise.resolve(rows);
  }) as unknown as import('../work-items').OrgSql;
  return { tag, calls };
}

describe('tier-1 (no directory) — owner-only', () => {
  it('the owner is a member; everyone else is not', async () => {
    const { tag } = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', potSlug: 'papercusp', sqlOverride: tag });
    expect(await roster.isMember(SCOPE, 42)).toBe(true);
    expect(await roster.isMember(SCOPE, 999)).toBe(false);
    expect(await roster.members(SCOPE)).toEqual([42]);
  });

  it('does not grant an owner scope without a live attested hive member', async () => {
    const sql = fakeSql([]);
    authority.members.mockResolvedValue([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', potSlug: 'papercusp', sqlOverride: sql.tag });
    expect(await roster.isMember(SCOPE, 42)).toBe(false);
    expect(authority.members).toHaveBeenCalledWith('ws-1', 'papercusp', sql.tag);
    expect(sql.calls.length).toBe(0);
  });

  it('denies owner membership when the hive authority read fails', async () => {
    authority.members.mockRejectedValue(new Error('roster unavailable'));
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', potSlug: 'papercusp' });
    expect(await roster.isMember(SCOPE, 42)).toBe(false);
  });

  it('the predicate is the same membership answer', async () => {
    const { tag } = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', potSlug: 'papercusp', sqlOverride: tag });
    expect(await roster.predicate(SCOPE, 42)).toBe(true);
    expect(await roster.predicate(SCOPE, 7)).toBe(false);
  });
});

describe('with a P-101 directory — {owner} ∪ publisher-set', () => {
  it('admits publisher-set members and always includes the owner', async () => {
    const directory: FleetDirectory = { scopeMembers: vi.fn(async () => [100, 200]) };
    const { tag } = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', potSlug: 'papercusp', directory, sqlOverride: tag });
    expect(await roster.isMember(SCOPE, 100)).toBe(true);
    expect(await roster.isMember(SCOPE, 42)).toBe(true); // owner
    expect(await roster.isMember(SCOPE, 300)).toBe(false);
    expect((await roster.members(SCOPE)).sort((a, b) => a - b)).toEqual([42, 100, 200]);
  });

  it('does not duplicate the owner when the directory already lists them', async () => {
    const directory: FleetDirectory = { scopeMembers: async () => [42, 100] };
    const { tag } = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', potSlug: 'papercusp', directory, sqlOverride: tag });
    expect(await roster.members(SCOPE)).toEqual([42, 100]);
  });

  it('a directory MISS (null) falls back to owner-only', async () => {
    const directory: FleetDirectory = { scopeMembers: async () => null };
    const { tag } = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', potSlug: 'papercusp', directory, sqlOverride: tag });
    expect(await roster.isMember(SCOPE, 100)).toBe(false);
    expect(await roster.members(SCOPE)).toEqual([42]);
  });

  it('a directory cannot retain a revoked member, but an unrevoked rejoin device restores access', async () => {
    const directory: FleetDirectory = { scopeMembers: async () => [42, 100] };
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', potSlug: 'papercusp', directory });
    expect(await roster.isMember(SCOPE, 100)).toBe(true);
    authority.members.mockResolvedValue([member(42, 'owner', ['device-100']), member(100)]);
    expect(await roster.members(SCOPE)).toEqual([42]);
    expect(await roster.isMember(SCOPE, 100)).toBe(false);
    authority.members.mockResolvedValue([member(42, 'owner', ['device-100']), member(100, 'rejoin')]);
    expect(await roster.isMember(SCOPE, 100)).toBe(true);
  });
});

describe('currentEpoch (X6)', () => {
  it('reads the hive epoch live instead of the independent grant replay high-water', async () => {
    const sql = fakeSql([{ high_water_epoch: 5 }]);
    authority.epoch.mockResolvedValue(3);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', potSlug: 'papercusp', sqlOverride: sql.tag });
    expect(await roster.currentEpoch(SCOPE)).toBe(3);
    expect(authority.epoch).toHaveBeenCalledWith('ws-1', 'papercusp', sql.tag);
    expect(sql.calls).toEqual([]);
  });

  it('is 0 when the owner has no epoch row', async () => {
    const { tag } = fakeSql([]);
    const roster = new GrantBackedScopeRoster({ workspaceId: 'ws-1', potSlug: 'papercusp', sqlOverride: tag });
    expect(await roster.currentEpoch(SCOPE)).toBe(0);
  });

  it('refuses an unresolvable workspace partition without manufacturing epoch zero', async () => {
    const sql = fakeSql([{ high_water_epoch: 9 }]);
    // 'default' resolves to undefined via resolveP2pGrantWorkspace (WI-1564).
    const roster = new GrantBackedScopeRoster({ workspaceId: 'default', potSlug: 'papercusp', sqlOverride: sql.tag });
    expect(await roster.isMember(SCOPE, 42)).toBe(false);
    await expect(roster.currentEpoch(SCOPE)).rejects.toThrow('unresolved workspace');
    expect(authority.epoch).not.toHaveBeenCalled();
    expect(sql.calls.length).toBe(0);
  });
});
