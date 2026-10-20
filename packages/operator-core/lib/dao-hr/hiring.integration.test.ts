import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { grantDaoHrAdmin } from './contract-templates';
import { DEFAULT_EQUITY_POLICY, updateEquityPolicy } from './equity-policy';
import { addHiringCandidate, approveHiringOffer, createHiringOffer, createHiringRole, getHiringOffer, listHiringHistory, requireHiringStage, readHiringView, runHiringAction } from './hiring';
import { linkMemberIdentity, saveWorkProfile } from './work-profile';
import type { HiveMemberRecord } from '../hive-membership-store';
import type { HivePolicy } from '../hive-policy-schema';
import type { EquityCapTable } from '../equity/cap-table';

const key = { workspaceId: 'ws-hiring-test', daoSlug: 'hiring-dao' };
let db: OrgTestDb;
let roleId: string;
const pay = { amount: '5000.00', currency: 'USD', cadence: 'monthly' as const };
beforeAll(async () => {
  db = await createOrgTestDb();
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1462-dao-hr-hiring.sql', import.meta.url);
  await db.adminSql.unsafe(readFileSync(fileURLToPath(existsSync(migration) ? migration : new URL(migration.href + '.DRAFT')), 'utf8'));
  for (const id of ['PER-author','PER-reviewer','PER-reviewer2','PER-candidate'])
    await db.adminSql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,title,payload) VALUES (${key.workspaceId},'papercusp',${id},'person',${id},'{}'::jsonb)`;
  await grantDaoHrAdmin({ ...key, personId: 'PER-author', bootstrapOperator: 'fixture' }, { sql: db.adminSql });
  for (const id of ['PER-reviewer','PER-reviewer2']) await grantDaoHrAdmin({ ...key, personId: id, grantedBy: 'PER-author' }, { sql: db.adminSql });
  await saveWorkProfile({ ...key, personId: 'PER-author', title: 'Admin', engagementType: 'employee', jurisdiction: 'US' }, { sql: db.adminSql });
  await linkMemberIdentity({ ...key, personId: 'PER-author', member: { githubUserId: 101 } }, { sql: db.adminSql });
  await updateEquityPolicy({ ...key, actorPersonId: 'PER-author', changes: { ...DEFAULT_EQUITY_POLICY, offerApprovalsRequired: 2 } }, { sql: db.adminSql });
  const role = await createHiringRole({ ...key, actorPersonId: 'PER-author', title: 'Engineer', level: 'L3', managerPersonId: 'PER-author', exclusive: true }, { sql: db.adminSql });
  roleId = role.roleId;
  await addHiringCandidate({ ...key, roleId, personId: 'PER-candidate', actorPersonId: 'PER-author' }, { sql: db.adminSql });
}, 180_000);
afterAll(async () => { await db?.cleanup(); });
const offer = (extra = {}) => createHiringOffer({ ...key, roleId, personId: 'PER-candidate', actorPersonId: 'PER-author', engagementType: 'contractor', jurisdiction: 'US', pay, overrides: { shares: 1000 }, ...extra }, { sql: db.adminSql });

describe('SPEC-P-005-A/F/G/H — hiring approval and history', () => {
  it('rejects self approval and stage skipping; distinct concurrent approvals produce one approved transition', async () => {
    const saved = await offer();
    expect(saved.terms.employmentLike).toBe(true);
    await expect(approveHiringOffer({ ...key, offerId: saved.offerId, actorPersonId: 'PER-author' }, { sql: db.adminSql })).rejects.toMatchObject({ code: 'self_approval' });
    await expect(requireHiringStage({ ...key, offerId: saved.offerId, stage: 'contract' }, { sql: db.adminSql })).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(requireHiringStage({ ...key, offerId: saved.offerId, stage: 'hire' }, { sql: db.adminSql })).rejects.toMatchObject({ code: 'invalid_transition' });
    await Promise.all(['PER-reviewer','PER-reviewer2'].map(actorPersonId => approveHiringOffer({ ...key, offerId: saved.offerId, actorPersonId }, { sql: db.adminSql })));
    await expect(requireHiringStage({ ...key, offerId: saved.offerId, stage: 'contract' }, { sql: db.adminSql })).resolves.toMatchObject({ state: 'approved' });
    await expect(requireHiringStage({ ...key, offerId: saved.offerId, stage: 'hire' }, { sql: db.adminSql })).rejects.toMatchObject({ code: 'invalid_transition' });
    const events = await listHiringHistory({ ...key, subjectKind: 'offer', subjectId: saved.offerId }, { sql: db.adminSql });
    expect(events.map(e => e.state)).toEqual(['offered','approval-recorded','approval-recorded','approved']);
    expect(events[0].actor_person_id).toBe('PER-author');
    expect(new Set(events.slice(1).map(e => e.actor_person_id))).toEqual(new Set(['PER-reviewer','PER-reviewer2']));
    expect((await getHiringOffer({ ...key, offerId: saved.offerId }, { sql: db.adminSql })).terms).toEqual(saved.terms);
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_offers SET terms='{}'::jsonb WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND offer_id=${saved.offerId}`).rejects.toThrow('immutable');
  });
  it('does not count repeat approval twice and refuses another DAO or a non-admin', async () => {
    const saved = await offer();
    for (let i = 0; i < 2; i++) await approveHiringOffer({ ...key, offerId: saved.offerId, actorPersonId: 'PER-reviewer' }, { sql: db.adminSql });
    expect((await getHiringOffer({ ...key, offerId: saved.offerId }, { sql: db.adminSql })).state).toBe('offered');
    await expect(approveHiringOffer({ ...key, offerId: saved.offerId, actorPersonId: 'PER-candidate' }, { sql: db.adminSql })).rejects.toMatchObject({ code: 'not_admin' });
    await expect(getHiringOffer({ ...key, daoSlug: 'other', offerId: saved.offerId }, { sql: db.adminSql })).rejects.toMatchObject({ code: 'offer_missing' });
  });
});
describe('SPEC-P-005-B — required pay fields', () => {
  it.each(['amount','currency','cadence'] as const)('%s-missing is rejected', async field => {
    const missing = { ...pay } as Record<string, unknown>; delete missing[field];
    await expect(offer({ pay: missing })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('Hiring product projection and trusted actor', () => {
  const deps = () => ({ sql: db.adminSql, viewerGithubId: async () => 101,
    members: async () => [{ githubUserId: 101 }] as HiveMemberRecord[] });
  it('refuses a caller-supplied actor and an authenticated non-member', async () => {
    await expect(runHiringAction(key, { action: 'role', title: 'Spoof', level: 'L1', actorPersonId: 'PER-reviewer' }, deps())).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(runHiringAction(key, { action: 'role', title: 'Spoof', level: 'L1' }, { ...deps(), members: async () => [] })).rejects.toMatchObject({ code: 'not_admin' });
  });
  it('uses current chain totals and keeps missing-chain and unformed-entity states explicit', async () => {
    const policy = { finance: { equity: { chainId: 1 } } } as HivePolicy;
    const inspect = (issuedShares: string) => async () => ({ chainId: 1, blockNumber: '42', issuedShares, reservedShares: '1000', positions: [] }) as unknown as Promise<EquityCapTable>;
    const first = await readHiringView({ ...key, policy }, { ...deps(), inspectCapTable: inspect('1000') });
    const second = await readHiringView({ ...key, policy }, { ...deps(), inspectCapTable: inspect('2000') });
    expect(first.actorPersonId).toBe('PER-author');
    expect(first.nonBinding).toBe(true);
    expect(first.people.map(p => p.personId)).toContain('PER-candidate');
    expect(first.roles.find(r => r.roleId === roleId)?.candidates).toContain('PER-candidate');
    expect(first.offers[0]!.preview?.fullyDilutedPercent).not.toBe(second.offers[0]!.preview?.fullyDilutedPercent);
    expect(first.history.some(e => e.actorPersonId === 'PER-author' && e.state === 'offered')).toBe(true);
    const unavailable = await readHiringView({ ...key, policy: null }, deps());
    expect(unavailable.chain).toBeNull();
    expect(unavailable.offers.every(o => o.preview === null)).toBe(true);
    expect(unavailable.chainError).toContain('unavailable');
    await expect(readHiringView({ ...key, policy }, { ...deps(), viewerGithubId: async () => 999 })).rejects.toMatchObject({ code: 'not_admin' });
  });
  it('projects current-DAO signer eligibility while preserving the workspace candidate directory', async () => {
    await db.adminSql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,title,payload)
      VALUES (${key.workspaceId},'papercusp','PER-foreign-admin','person','PER-reviewer','{}'::jsonb)`;
    await grantDaoHrAdmin({ ...key, daoSlug: 'another-dao', personId: 'PER-foreign-admin', bootstrapOperator: 'fixture' }, { sql: db.adminSql });
    const view = await readHiringView({ ...key, policy: null }, deps());
    expect(view.people.find(p => p.personId === 'PER-reviewer')).toMatchObject({ isHrAdmin: true });
    expect(view.people.find(p => p.personId === 'PER-foreign-admin')).toMatchObject({ displayName: 'PER-reviewer', isHrAdmin: false });
    expect(view.people.find(p => p.personId === 'PER-candidate')).toMatchObject({ isHrAdmin: false });
    expect(view.people.filter(p => p.isHrAdmin).map(p => p.personId).sort()).toEqual(['PER-author','PER-reviewer','PER-reviewer2']);
  });
});
