import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { createAddressFromString, bytesToHex } from '@ethereumjs/util';
import type { Address } from 'viem';
import { readDaoPeople } from './people';
import { readDaoCapTable } from './cap-table';
import { inspectEquityCapTable, type CapTableChainReader } from '../equity/cap-table';
import { grantDaoHrAdmin } from './contract-templates';
import { saveWorkProfile, linkMemberIdentity, linkVerifiedWallet } from './work-profile';
import { equityEvm } from '../equity/evm-test-helpers';
import { inspectEquity, type EquityChainReader } from '../equity/runtime';
import type { HiveMemberRecord } from '../hive-membership-store';
import type { HivePolicy } from '../hive-policy-schema';

const WS = 'ws-dao-hr-people';
const DAO = 'people-dao';
let db: OrgTestDb;
let chain: Awaited<ReturnType<typeof equityEvm>>;
let policy: HivePolicy;
const members: HiveMemberRecord[] = [1, 2, 3, 4].map(id => ({ workspaceId: WS, potHomeSlug: DAO, githubUserId: id,
  githubUsername: 'member-' + id, displayName: 'Member ' + id, avatarUrl: null, bindingStatus: 'bound', deviceAttestations: [], revokedPubkeys: [] }));
const key = { workspaceId: WS, daoSlug: DAO };

beforeAll(async () => {
  db = await createOrgTestDb();
  chain = await equityEvm();
  await chain.register(1);
  policy = { finance: { equity: { chainId: 1, equity: chain.equity.address, governor: chain.governor.address, timelock: chain.timelock.address } } } as HivePolicy;
  for (const [id, title, member, wallet] of [
    ['PER-alice', 'Alice', 1, chain.accounts[1]], ['PER-bob', 'Bob', 2, chain.accounts[0]],
    ['PER-admin', 'HR Admin', 3, chain.accounts[2]], ['PER-candidate', 'Candidate', 99, chain.accounts[3]],
  ] as const) {
    await db.adminSql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,title,payload)
      VALUES (${WS},'papercusp',${id},'person',${title},'{}'::jsonb)`;
    await saveWorkProfile({ ...key, personId: id, title: 'Engineer', team: 'Product', engagementType: 'contractor', jurisdiction: 'US',
      pay: { amount: member === 2 ? '70000.00' : '50000.00', currency: 'USD', cadence: 'annual' } }, { sql: db.adminSql });
    await linkMemberIdentity({ ...key, personId: id, member: { githubUserId: member } }, { sql: db.adminSql });
    await linkVerifiedWallet({ ...key, personId: id, principalGithubUserId: member, binding: { ok: true, status: 200,
      value: { bound: true, binding: { walletAddress: wallet, chainId: 1, challengeId: 'people-wallet-proof', verifiedAtMs: Date.now() } } } }, { sql: db.adminSql });
  }
  await grantDaoHrAdmin({ ...key, personId: 'PER-admin', bootstrapOperator: 'fixture-operator' }, { sql: db.adminSql });
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

async function read(viewer: number | null) {
  const reader: EquityChainReader = {
    getChainId: async () => 1, getBlockNumber: async () => 1n,
    getCode: async ({ address }) => bytesToHex(await chain.vm.stateManager.getCode(createAddressFromString(address))),
    readContract: async ({ address, abi, functionName, args }) => chain.read({ address: address as Address, abi }, functionName, args ? [...args] : []),
  };
  return readDaoPeople({ ...key, policy }, { sql: db.adminSql, members: async () => members, viewerGithubId: async () => viewer,
    inspectEquity: async (p, holder) => inspectEquity(reader, { ...p.finance!.equity!, holder }) });
}

describe('SPEC-P-009 / A — the directory population is current membership', () => {
  it('includes a member with no work profile and excludes an unadmitted candidate profile', async () => {
    const rows = await read(1);
    expect(rows.map(r => r.memberId)).toEqual([1, 2, 3, 4]);
    expect(rows.find(r => r.memberId === 4)?.profile).toBeNull();
    expect(rows.some(r => r.personId === 'PER-candidate')).toBe(false);
  });
});
describe('SPEC-P-009-B / C — another member sees equity without pay terms', () => {
  it('reads the other member balance from a real EVM and omits their pay from the serialized response', async () => {
    const bob = (await read(1)).find(r => r.personId === 'PER-bob')!;
    expect(bob.equity).toMatchObject({ status: 'ready', value: { shares: '100000', ownershipPercent: '100.00' } });
    expect(bob).not.toHaveProperty('pay');
    expect(JSON.stringify(bob)).not.toContain('70000');
  });
});
describe('SPEC-P-009-D — self pay terms', () => {
  it('returns pay only for the server-resolved member viewing their own profile', async () => {
    const rows = await read(2);
    expect(rows.find(r => r.personId === 'PER-bob')?.pay).toMatchObject({ amount: '70000.00', currency: 'USD' });
    expect(rows.find(r => r.personId === 'PER-alice')).not.toHaveProperty('pay');
    expect((await read(null)).every(r => !('pay' in r))).toBe(true);
  });
});
describe('SPEC-P-009-E — per-DAO HR admin visibility', () => {
  it('returns another member equity and pay only for a person in this DAO HR roster', async () => {
    const bob = (await read(3)).find(r => r.personId === 'PER-bob')!;
    expect(bob.pay).toMatchObject({ amount: '70000.00' });
    expect(bob.equity).toMatchObject({ status: 'ready', value: { shares: '100000' } });
    expect((await read(4)).every(r => !('pay' in r))).toBe(true);
  });
});

describe('SPEC-P-011 / A — public cap table, trusted self, issuing entity marker', () => {
  it('maps the on-chain holder to the canonical person, marks self server-side and omits pay', async () => {
    const reader: CapTableChainReader = {
      getChainId: async () => 1, getBlockNumber: async () => chain.blockNumber(),
      getCode: async ({ address }) => bytesToHex(await chain.vm.stateManager.getCode(createAddressFromString(address))),
      readContract: async ({ address, abi, functionName, args }) => chain.read({ address: address as Address, abi }, functionName, args ? [...args] : []),
      getContractEvents: input => chain.getContractEvents(input),
    };
    const deps = { sql: db.adminSql, members: async () => members,
      inspectCapTable: (p: HivePolicy) => inspectEquityCapTable(reader, p.finance!.equity!) };
    const table = await readDaoCapTable({ ...key, policy }, { ...deps, viewerGithubId: async () => 1 });
    expect(table.nonBinding).toBe(true);
    expect(table.positions[0]).toMatchObject({ personId: 'PER-bob', displayName: 'Bob', shares: '100000', isSelf: false });
    expect(table.positions[1]).toMatchObject({ personId: 'PER-alice', isSelf: true });
    expect(JSON.stringify(table)).not.toContain('70000');
    expect(table.positions.every(p => !('pay' in p))).toBe(true);
    const other = await readDaoCapTable({ ...key, policy }, { ...deps, viewerGithubId: async () => 2 });
    expect(other.positions[0].isSelf).toBe(true);
    expect(other.positions[1].isSelf).toBe(false);
  });
});
