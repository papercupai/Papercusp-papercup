/**
 * DAO HR equity + hiring policy against real Postgres and the V2 equity contract on an in-process
 * EVM (dao-hr-people-2026-10-11 P-003). The org fixture applies the full migration set (incl.
 * 1460-dao-hr-equity-policy). Admins and actors are real canonical PER- person records.
 *   - SPEC-P-003   an admin update above an immutable maximum is rejected and nothing is saved;
 *   - SPEC-P-003-A a policy change leaves every existing grant's terms unchanged;
 *   - SPEC-P-003-B an offer override outside the stored policy's bounds is rejected;
 *   - SPEC-P-003-C every policy change writes an audit row naming its actor;
 *   - SPEC-P-003-E a chain-enforced change executes through admin calls, with no proposal;
 *   - SPEC-P-003-F each saved change creates a new version and every earlier one stays readable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { getAddress, type Hex } from 'viem';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const {
  DEFAULT_EQUITY_POLICY,
  EQUITY_V2_CEILINGS,
  EquityPolicyError,
  getCurrentEquityPolicy,
  getEquityPolicyVersion,
  listEquityPolicyAudit,
  listEquityPolicyVersions,
  prepareChainPolicyTransactions,
  resolveOfferTerms,
  updateEquityPolicy,
} = await import('./equity-policy');
const { grantDaoHrAdmin } = await import('./contract-templates');
const { createOrgTestDb } = await import('../../test/_org-test-db');
const { equityV2Evm, digest, V2_ADMIN } = await import('../equity/evm-test-helpers');

const WS = 'ws-dao-hr-policy';
const HARNESS = 'papercusp';
const ADMIN = 'PER-policy-admin';
const MEMBER = 'PER-policy-member';
const DAY = 86_400n;

let db: OrgTestDb;
let sql: Sql;

async function seedPerson(id: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, title, payload)
    VALUES (${WS}, ${HARNESS}, ${id}, 'person', ${`Person ${id}`}, ${sql.json({})})`;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(EquityPolicyError);
  return (error as InstanceType<typeof EquityPolicyError>).code;
}

async function dao(slug: string): Promise<{ workspaceId: string; daoSlug: string }> {
  await grantDaoHrAdmin({ workspaceId: WS, daoSlug: slug, personId: ADMIN, bootstrapOperator: 'test-operator' });
  return { workspaceId: WS, daoSlug: slug };
}

const count = async (table: 'dao_hr_policy_versions' | 'dao_hr_policy_audit', slug: string): Promise<number> => {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM ${sql('harness_shared.' + table)} WHERE workspace_id = ${WS} AND dao_slug = ${slug}`;
  return row!.n;
};

type GrantRow = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint];

/** The V2 contract with one holder hired through governance, as the policy's chain target. */
async function hiredChain() {
  const e = await equityV2Evm();
  const t = e.equity;
  await e.register(1);
  const g1 = digest('policy-grant-1');
  const start = e.now();
  await e.govern([{ contract: t, name: 'commitGrant', args: [g1, e.accounts[1], 10_000n, start, start + 30n * DAY, start + 400n * DAY] }]);
  const grant = async (id: Hex) => (await e.read(t, 'grants', [id])) as GrantRow;
  /** Send the planned policy calls from the admin wallet, straight to the equity contract. */
  const sendAsAdmin = async (calls: ReadonlyArray<{ functionName: string; args: string[] }>) => {
    for (const call of calls) await e.send(t, call.functionName, call.args.map(a => BigInt(a)), V2_ADMIN);
  };
  return { e, t, g1, grant, sendAsAdmin };
}

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  h.sql = sql;
  // Exercise the reserved migration while it is still invisible to production
  // auto-apply; after arming, the fixture already applies it and this is idempotent.
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1461-dao-hr-policy-audit-snapshots.sql', import.meta.url);
  await sql.unsafe(readFileSync(existsSync(migration) ? migration : new URL(migration.href + '.DRAFT'), 'utf8'));
  for (const id of [ADMIN, MEMBER]) await seedPerson(id);
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('SPEC-P-003 — an admin update above an immutable maximum is rejected', () => {
  it('refuses a return rate over the 10%/yr ceiling, an interval under 30 days and a limit over the deployment cap, saving nothing', async () => {
    const key = await dao('dao-ceiling');
    expect(await refusal(updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { returnRateBps: 1001 } }))).toBe('above_immutable_max');
    expect(await refusal(updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { returnIntervalDays: 7 } }))).toBe('above_immutable_max');
    expect(
      await refusal(updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { perGrantLimitShares: 9_001 }, maxima: { maxGrantLimit: 9_000n } })),
    ).toBe('above_immutable_max');
    expect(await count('dao_hr_policy_versions', 'dao-ceiling')).toBe(0);
    expect(await count('dao_hr_policy_audit', 'dao-ceiling')).toBe(0);
    const ok = await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { returnRateBps: 1000 } });
    expect(ok.settings.returnRateBps).toBe(1000);
  });
});

describe('SPEC-P-003-A — a policy change leaves every existing grant unchanged', () => {
  it('a chain-enforced and an off-chain change leave the hired grant and the earlier policy version exactly as they were', async () => {
    const { e, t, g1, grant, sendAsAdmin } = await hiredChain();
    const key = await dao('dao-grants');
    const v1 = await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { cliffDays: 300 } });
    const grantBefore = await grant(g1);
    const v2 = await updateEquityPolicy({
      ...key,
      actorPersonId: ADMIN,
      changes: { vestingDays: 730, cliffDays: 180, perGrantLimitShares: 5_000, offerBounds: { sharesMin: 0, sharesMax: 5_000, vestingDaysMin: 365, vestingDaysMax: 1460, cliffDaysMin: 0, cliffDaysMax: 365 }, returnRateBps: 800 },
      maxima: { maxGrantLimit: (await e.read(t, 'maxGrantLimit')) as bigint },
    });
    await sendAsAdmin(v2.chainCalls);
    expect(BigInt(await e.read(t, 'grantLimit') as bigint)).toBe(5_000n);
    expect(await grant(g1)).toEqual(grantBefore);
    expect(grantBefore[1]).toBe(10_000n);
    expect((await getEquityPolicyVersion({ ...key, version: v1.version })).settings).toEqual(v1.settings);
  }, 180_000);
});

describe('SPEC-P-003-B — an offer override outside the stored policy bounds is rejected', () => {
  it('resolves terms from the saved policy and refuses shares, vesting or cliff outside its bounds', async () => {
    const key = await dao('dao-offers');
    await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { defaultGrants: [{ role: 'Engineer', level: 'L3', shares: 3_000 }] } });
    const ok = await resolveOfferTerms({ ...key, role: 'Engineer', level: 'L3', overrides: { shares: 6_000 } });
    expect(ok).toMatchObject({ shares: 6_000, vestingDays: 1460, cliffDays: 365, policyVersion: 1 });
    expect(await refusal(resolveOfferTerms({ ...key, role: 'Engineer', level: 'L3', overrides: { shares: 10_001 } }))).toBe('override_out_of_bounds');
    expect(await refusal(resolveOfferTerms({ ...key, role: 'Engineer', level: 'L3', overrides: { vestingDays: 30 } }))).toBe('override_out_of_bounds');
    expect(await refusal(resolveOfferTerms({ ...key, role: 'Engineer', level: 'L3', overrides: { cliffDays: 400 } }))).toBe('override_out_of_bounds');
  });
});

describe('SPEC-P-003-C — every policy change writes an audit row naming its actor', () => {
  it('two changes write two audit rows naming the admin; a non-admin change is refused and writes none', async () => {
    const key = await dao('dao-audit');
    await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { cliffDays: 200 } });
    await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { returnRateBps: 250, returnIntervalDays: 60 } });
    expect(await refusal(updateEquityPolicy({ ...key, actorPersonId: MEMBER, changes: { cliffDays: 100 } }))).toBe('not_admin');
    const audit = await listEquityPolicyAudit(key);
    expect(audit.map(a => [a.version, a.actorPersonId, a.changedFields])).toEqual([
      [1, ADMIN, ['cliffDays']],
      [2, ADMIN, ['returnRateBps', 'returnIntervalDays']],
    ]);
    expect(await count('dao_hr_policy_audit', 'dao-audit')).toBe(await count('dao_hr_policy_versions', 'dao-audit'));
  });
});

describe('SPEC-P-003-G — a policy change records the value before the change', () => {
  it('stores the initial defaults and then the exact prior version, without rewriting either snapshot', async () => {
    const key = await dao('dao-audit-before');
    const first = await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { cliffDays: 100 } });
    await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { returnRateBps: 600 } });
    const audit = await listEquityPolicyAudit(key);
    expect(audit.map(a => a.beforeSettings)).toEqual([DEFAULT_EQUITY_POLICY, first.settings]);
    const stored = await sql<Array<{ before_settings: unknown }>>`
      SELECT before_settings FROM harness_shared.dao_hr_policy_audit
       WHERE workspace_id = ${WS} AND dao_slug = ${key.daoSlug} ORDER BY version`;
    expect(stored.map(r => r.before_settings)).toEqual([DEFAULT_EQUITY_POLICY, first.settings]);
    await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { cliffDays: 200 } });
    expect((await listEquityPolicyAudit(key)).slice(0, 2).map(a => a.beforeSettings)).toEqual(audit.map(a => a.beforeSettings));
  });
});

describe('SPEC-P-003-H — a policy change records the value after the change', () => {
  it('stores each complete saved document and the append-only guard rejects a snapshot rewrite', async () => {
    const key = await dao('dao-audit-after');
    const first = await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { cliffDays: 100 } });
    const second = await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { returnRateBps: 600 } });
    expect((await listEquityPolicyAudit(key)).map(a => a.afterSettings)).toEqual([first.settings, second.settings]);
    const stored = await sql<Array<{ after_settings: unknown }>>`
      SELECT after_settings FROM harness_shared.dao_hr_policy_audit
       WHERE workspace_id = ${WS} AND dao_slug = ${key.daoSlug} ORDER BY version`;
    expect(stored.map(r => r.after_settings)).toEqual([first.settings, second.settings]);
    await expect(sql`
      UPDATE harness_shared.dao_hr_policy_audit SET after_settings = '{}'::jsonb
       WHERE workspace_id = ${WS} AND dao_slug = ${key.daoSlug}`).rejects.toThrow(/append-only/);
  });
});

describe('SPEC-P-003-E — a chain-enforced policy change executes without a governance proposal', () => {
  it('the saved change yields admin calls that update the contract at once from the admin wallet, with no vote or delay', async () => {
    const { e, t, sendAsAdmin } = await hiredChain();
    const key = await dao('dao-chain');
    const saved = await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { returnRateBps: 600, returnIntervalDays: 45 } });
    expect(saved.chainCalls.map(c => c.functionName)).toEqual(['setReturnPolicy']);
    const before = e.now();
    await sendAsAdmin(saved.chainCalls);
    expect(Number(await e.read(t, 'returnRateBps'))).toBe(600);
    expect(Number(await e.read(t, 'returnInterval'))).toBe(45 * 86_400);
    // Each send mines one block (+1s); a proposal could not land before the timelock delay alone.
    expect(Number(e.now() - before)).toBeLessThan(Number(await e.read(e.timelock, 'getMinDelay')));
    const [tx] = prepareChainPolicyTransactions({ chainId: 31337, adminAddress: e.accounts[V2_ADMIN]!, equityAddress: t.address, calls: saved.chainCalls });
    // prepareEquityTransaction returns EIP-55 checksummed addresses; the deployed address reads lowercase.
    expect(tx).toMatchObject({ from: getAddress(e.accounts[V2_ADMIN]!), to: getAddress(t.address), requiresWalletSignature: true });
    expect((await listEquityPolicyAudit(key))[0]!.chainCalls).toEqual(saved.chainCalls);
    // Pin the TS ceilings to the contract's own constants.
    expect(Number(await e.read(t, 'ANNUAL_RETURN_CAP_BPS'))).toBe(EQUITY_V2_CEILINGS.annualReturnCapBps);
    expect(Number(await e.read(t, 'MIN_RETURN_INTERVAL'))).toBe(EQUITY_V2_CEILINGS.minReturnIntervalDays * 86_400);
    expect(Number(await e.read(t, 'MAX_RETURN_INTERVAL'))).toBe(EQUITY_V2_CEILINGS.maxReturnIntervalDays * 86_400);
    expect(Number(await e.read(t, 'MAX_GRANT_DURATION'))).toBe(EQUITY_V2_CEILINGS.maxGrantDurationDays * 86_400);
  }, 180_000);
});

describe('SPEC-P-003-F — each saved policy change creates a new readable version', () => {
  it('versions 1..3 stay readable with their own settings and a stored version cannot be edited', async () => {
    const key = await dao('dao-versions');
    expect(await getCurrentEquityPolicy(key)).toBeNull();
    const a = await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { cliffDays: 100 } });
    const b = await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { cliffDays: 200 } });
    const c = await updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { cliffDays: 300 } });
    expect([a.version, b.version, c.version]).toEqual([1, 2, 3]);
    expect((await listEquityPolicyVersions(key)).map(v => v.settings.cliffDays)).toEqual([100, 200, 300]);
    expect((await getEquityPolicyVersion({ ...key, version: 1 })).settings.cliffDays).toBe(100);
    expect((await getCurrentEquityPolicy(key))!.version).toBe(3);
    expect(await refusal(updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { cliffDays: 300 } }))).toBe('no_change');
    await expect(sql`
      UPDATE harness_shared.dao_hr_policy_versions SET settings = '{}'::jsonb
       WHERE workspace_id = ${WS} AND dao_slug = 'dao-versions' AND version = 1`).rejects.toThrow(/append-only/);
  });
});

describe('AUTO-BAR-R-2-P-003 — versioned, audited org policy with bounded overrides and admin chain execution', () => {
  it('an admin saves a policy, an offer is checked against it, and the chain value moves with no proposal', async () => {
    const { e, t, g1, grant, sendAsAdmin } = await hiredChain();
    const key = await dao('dao-bar');
    const grantBefore = await grant(g1);
    const saved = await updateEquityPolicy({
      ...key,
      actorPersonId: ADMIN,
      changes: { defaultGrants: [{ role: 'Designer', level: 'L1', shares: 2_000 }], vestingDays: 1095, startRule: 'contract_signed', returnRateBps: 300 },
    });
    await sendAsAdmin(saved.chainCalls);
    expect(Number(await e.read(t, 'returnRateBps'))).toBe(300);
    expect(await grant(g1)).toEqual(grantBefore);
    expect(await resolveOfferTerms({ ...key, role: 'Designer', level: 'L1' })).toMatchObject({ shares: 2_000, vestingDays: 1095, startRule: 'contract_signed' });
    expect(await refusal(resolveOfferTerms({ ...key, role: 'Designer', level: 'L1', overrides: { shares: 20_000 } }))).toBe('override_out_of_bounds');
    expect(await refusal(updateEquityPolicy({ ...key, actorPersonId: ADMIN, changes: { returnRateBps: 5_000 } }))).toBe('above_immutable_max');
    expect((await listEquityPolicyAudit(key)).map(a => a.actorPersonId)).toEqual([ADMIN]);
  }, 180_000);
});
