/**
 * DAO HR work profile against real Postgres (dao-hr-people-2026-10-11 P-002, R-1).
 *
 * The full migration set (incl. 1456-dao-hr-work-profiles) is applied by the org fixture; person
 * records are real canonical PER- rows in harness_shared.work_items, read through the
 * relationship graph's getCanonicalEntity. Properties under test:
 *   - SPEC-P-002   a profile cannot be saved for a person id with no shared person record;
 *   - SPEC-P-002-C a saved profile reloads unchanged, for an employee AND a contractor;
 *   - SPEC-P-002-D a candidate with no wallet link saves;
 *   - SPEC-P-002-E a candidate with no DAO member identity saves;
 *   - SPEC-P-002-A onboarding cannot complete without a verified wallet link — refused by the
 *                  writer AND by the table's CHECK constraint;
 *   - R-1          the profile table holds no contact column, and ids are merge survivors.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { WalletBindingHostedResult } from '../cupboard/wallet-binding-io';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const {
  WorkProfileError,
  completeOnboarding,
  getWorkProfile,
  linkMemberIdentity,
  linkVerifiedWallet,
  listWorkProfiles,
  saveWorkProfile,
  setWorkProfileStatus,
} = await import('./work-profile');
const { isContactColumnName } = await import('./schema-guard');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-dao-hr-profile';
const HARNESS = 'papercusp';
const DAO = 'acme-dao';
const WALLET = '0x1111111111111111111111111111111111111111';

let db: OrgTestDb;
let sql: Sql;

async function seedPerson(id: string, payload: Record<string, unknown> = {}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, title, payload)
    VALUES (${WS}, ${HARNESS}, ${id}, 'person', ${`Person ${id}`}, ${sql.json(payload as never)})`;
}

function boundWallet(overrides: Record<string, unknown> = {}): WalletBindingHostedResult {
  return {
    ok: true,
    status: 200,
    value: {
      bound: true,
      binding: {
        walletAddress: WALLET.toUpperCase().replace('0X', '0x'),
        chainId: 8453,
        challengeId: 'chal-123',
        verifiedAtMs: Date.UTC(2026, 9, 1, 12, 0, 0),
        createdAtMs: Date.UTC(2026, 9, 1, 12, 0, 0),
        updatedAtMs: Date.UTC(2026, 9, 1, 12, 0, 0),
        ...overrides,
      },
    },
  };
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkProfileError);
  expect((error as InstanceType<typeof WorkProfileError>).code).toBe(code);
}

async function profileRowCount(personId: string): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM harness_shared.dao_hr_work_profiles
     WHERE workspace_id = ${WS} AND person_id = ${personId}`;
  return row!.n;
}

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  h.sql = sql;
  for (const id of ['PER-ana', 'PER-ben', 'PER-cara', 'PER-dev', 'PER-eli', 'PER-mgr', 'PER-fay', 'PER-gus']) await seedPerson(id);
  // PER-ana-dup was merged into PER-ana: readers and writers follow it to the survivor.
  await seedPerson('PER-ana-dup', { mergedInto: 'PER-ana' });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('SPEC-P-002 — a profile needs a shared person record', () => {
  it('rejects a person id that has no person record and writes nothing', async () => {
    await expectRefusal(
      saveWorkProfile({
        workspaceId: WS,
        daoSlug: DAO,
        personId: 'PER-nobody',
        title: 'Engineer',
        engagementType: 'employee',
        jurisdiction: 'US-CA',
      }),
      'person_missing',
    );
    expect(await profileRowCount('PER-nobody')).toBe(0);
  });

  it('rejects a person record from another workspace', async () => {
    await expectRefusal(
      saveWorkProfile({
        workspaceId: 'ws-other',
        daoSlug: DAO,
        personId: 'PER-ana',
        title: 'Engineer',
        engagementType: 'employee',
        jurisdiction: 'US-CA',
      }),
      'person_missing',
    );
  });

  it('rejects a manager who is not a person', async () => {
    await expectRefusal(
      saveWorkProfile({
        workspaceId: WS,
        daoSlug: DAO,
        personId: 'PER-ben',
        title: 'Engineer',
        managerPersonId: 'PER-ghost',
        engagementType: 'employee',
        jurisdiction: 'US-CA',
      }),
      'manager_missing',
    );
    expect(await profileRowCount('PER-ben')).toBe(0);
  });
});

describe('SPEC-P-002-C — a saved profile reloads unchanged', () => {
  it('employee: every field round-trips', async () => {
    const input = {
      workspaceId: WS,
      daoSlug: DAO,
      personId: 'PER-cara',
      title: 'Staff Engineer',
      team: 'Platform',
      managerPersonId: 'PER-mgr',
      level: 'L6',
      startDate: '2026-11-02',
      engagementType: 'employee' as const,
      jurisdiction: 'US-NY',
      pay: { amount: '185000.00', currency: 'USD', cadence: 'annual' as const },
    };
    const saved = await saveWorkProfile(input);
    const reloaded = await getWorkProfile({ workspaceId: WS, daoSlug: DAO, personId: 'PER-cara' });
    expect(reloaded).toEqual(saved);
    expect(reloaded).toMatchObject({
      personId: 'PER-cara',
      title: 'Staff Engineer',
      team: 'Platform',
      managerPersonId: 'PER-mgr',
      level: 'L6',
      startDate: '2026-11-02',
      engagementType: 'employee',
      jurisdiction: 'US-NY',
      pay: { amount: '185000.00', currency: 'USD', cadence: 'annual' },
      status: 'candidate',
    });
  });

  it('contractor: every field round-trips, including pay per milestone and no team', async () => {
    const saved = await saveWorkProfile({
      workspaceId: WS,
      daoSlug: DAO,
      personId: 'PER-dev',
      title: 'Smart-contract auditor',
      team: null,
      level: null,
      startDate: '2026-12-01',
      engagementType: 'contractor',
      jurisdiction: 'DE',
      pay: { amount: '4200.5', currency: 'EUR', cadence: 'per-milestone' },
    });
    const reloaded = await getWorkProfile({ workspaceId: WS, daoSlug: DAO, personId: 'PER-dev' });
    expect(reloaded).toEqual(saved);
    expect(reloaded).toMatchObject({
      title: 'Smart-contract auditor',
      team: null,
      managerPersonId: null,
      level: null,
      startDate: '2026-12-01',
      engagementType: 'contractor',
      jurisdiction: 'DE',
      pay: { amount: '4200.50', currency: 'EUR', cadence: 'per-milestone' },
    });
  });

  it('an update replaces the work facts and keeps the created time', async () => {
    const first = await getWorkProfile({ workspaceId: WS, daoSlug: DAO, personId: 'PER-dev' });
    const updated = await saveWorkProfile(
      {
        workspaceId: WS,
        daoSlug: DAO,
        personId: 'PER-dev',
        title: 'Lead auditor',
        engagementType: 'contractor',
        jurisdiction: 'DE',
        pay: null,
      },
      { now: () => new Date('2030-01-01T00:00:00Z') },
    );
    expect(updated).toMatchObject({ title: 'Lead auditor', pay: null, startDate: null, createdAt: first!.createdAt });
    expect(updated.updatedAt).toBe('2030-01-01T00:00:00.000Z');
  });

  it('lists a DAO’s profiles, filtered by status', async () => {
    const all = await listWorkProfiles({ workspaceId: WS, daoSlug: DAO });
    expect(all.map((p) => p.personId)).toEqual(expect.arrayContaining(['PER-cara', 'PER-dev']));
    expect(await listWorkProfiles({ workspaceId: WS, daoSlug: DAO, status: 'active' })).toEqual([]);
  });

  it('refuses incomplete or malformed pay terms', async () => {
    await expectRefusal(
      saveWorkProfile({
        workspaceId: WS,
        daoSlug: DAO,
        personId: 'PER-dev',
        title: 'x',
        engagementType: 'contractor',
        jurisdiction: 'DE',
        pay: { amount: '12.345', currency: 'EUR', cadence: 'monthly' },
      }),
      'invalid_input',
    );
  });
});

describe('SPEC-P-002-D / -E — a candidate needs neither wallet nor member identity', () => {
  it('saves a candidate with no wallet link and no DAO member identity', async () => {
    const saved = await saveWorkProfile({
      workspaceId: WS,
      daoSlug: DAO,
      personId: 'PER-eli',
      title: 'Designer',
      engagementType: 'employee',
      jurisdiction: 'GB',
    });
    expect(saved).toMatchObject({ status: 'candidate', wallet: null, memberGithubUserId: null });
    expect(await profileRowCount('PER-eli')).toBe(1);
  });
});

describe('SPEC-P-002-A — onboarding needs a verified wallet link', () => {
  it('refuses to complete onboarding without a verified wallet link', async () => {
    await saveWorkProfile({ workspaceId: WS, daoSlug: DAO, personId: 'PER-fay', title: 'Ops', engagementType: 'employee', jurisdiction: 'US-TX' });
    await setWorkProfileStatus({ workspaceId: WS, daoSlug: DAO, personId: 'PER-fay', status: 'offered' });
    await setWorkProfileStatus({ workspaceId: WS, daoSlug: DAO, personId: 'PER-fay', status: 'onboarding' });
    await linkMemberIdentity({ workspaceId: WS, daoSlug: DAO, personId: 'PER-fay', member: { githubUserId: 9001 } });

    await expectRefusal(completeOnboarding({ workspaceId: WS, daoSlug: DAO, personId: 'PER-fay' }), 'wallet_unverified');
    expect(await getWorkProfile({ workspaceId: WS, daoSlug: DAO, personId: 'PER-fay' })).toMatchObject({
      status: 'onboarding',
      onboardedAt: null,
      wallet: null,
    });
  });

  it('the table itself refuses an onboarded row with no wallet link', async () => {
    await expect(
      sql`UPDATE harness_shared.dao_hr_work_profiles SET status = 'active', onboarded_at = now()
           WHERE workspace_id = ${WS} AND dao_slug = ${DAO} AND person_id = 'PER-fay'`,
    ).rejects.toThrow(/dao_hr_work_profiles_onboarded_needs_wallet/);
    await expect(
      sql`UPDATE harness_shared.dao_hr_work_profiles SET status = 'active'
           WHERE workspace_id = ${WS} AND dao_slug = ${DAO} AND person_id = 'PER-fay'`,
    ).rejects.toThrow(/dao_hr_work_profiles_active_is_onboarded/);
  });

  it('a wallet is linked only from a verified hosted binding of the member’s own principal', async () => {
    const key = { workspaceId: WS, daoSlug: DAO, personId: 'PER-fay' };
    await expectRefusal(linkVerifiedWallet({ ...key, principalGithubUserId: 42, binding: boundWallet() }), 'wallet_principal_mismatch');
    await expectRefusal(
      linkVerifiedWallet({ ...key, principalGithubUserId: 9001, binding: { ok: true, status: 200, value: { bound: false, binding: null } } }),
      'wallet_unverified',
    );
    await expectRefusal(
      linkVerifiedWallet({ ...key, principalGithubUserId: 9001, binding: { ok: false, status: 401, error: 'unauthorized', detail: null } }),
      'wallet_unverified',
    );
    await expectRefusal(
      linkVerifiedWallet({ ...key, principalGithubUserId: 9001, binding: boundWallet({ verifiedAtMs: null }) }),
      'wallet_unverified',
    );
    expect((await getWorkProfile(key))!.wallet).toBeNull();
  });

  it('completes onboarding once the verified wallet is linked', async () => {
    const key = { workspaceId: WS, daoSlug: DAO, personId: 'PER-fay' };
    const linked = await linkVerifiedWallet({ ...key, principalGithubUserId: 9001, binding: boundWallet() });
    expect(linked.wallet).toEqual({
      address: WALLET,
      chainId: 8453,
      bindingRef: 'chal-123',
      verifiedAt: '2026-10-01T12:00:00.000Z',
    });
    const active = await completeOnboarding(key, { now: () => new Date('2026-11-03T09:00:00Z') });
    expect(active).toMatchObject({ status: 'active', onboardedAt: '2026-11-03T09:00:00.000Z' });
    await expectRefusal(setWorkProfileStatus({ ...key, status: 'candidate' }), 'invalid_transition');
  });

  it('a wallet cannot be linked before the DAO member identity', async () => {
    await saveWorkProfile({ workspaceId: WS, daoSlug: DAO, personId: 'PER-gus', title: 'QA', engagementType: 'contractor', jurisdiction: 'CA' });
    await expectRefusal(
      linkVerifiedWallet({ workspaceId: WS, daoSlug: DAO, personId: 'PER-gus', principalGithubUserId: 7, binding: boundWallet() }),
      'member_identity_missing',
    );
  });

  it('one DAO member identity maps to one profile per DAO', async () => {
    await expectRefusal(
      linkMemberIdentity({ workspaceId: WS, daoSlug: DAO, personId: 'PER-gus', member: { githubUserId: 9001 } }),
      'member_identity_conflict',
    );
  });
});

describe('R-1 — the person record stays the only contact store', () => {
  it('the work-profile table has no contact column', async () => {
    const columns = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'dao_hr_work_profiles'`;
    expect(columns.length).toBeGreaterThan(10);
    expect(columns.map((c) => c.column_name).filter(isContactColumnName)).toEqual([]);
  });

  it('a merged-away person id resolves to its survivor for writes and reads', async () => {
    const saved = await saveWorkProfile({
      workspaceId: WS,
      daoSlug: 'other-dao',
      personId: 'PER-ana-dup',
      title: 'Researcher',
      engagementType: 'employee',
      jurisdiction: 'FR',
    });
    expect(saved.personId).toBe('PER-ana');
    expect(await getWorkProfile({ workspaceId: WS, daoSlug: 'other-dao', personId: 'PER-ana-dup' })).toEqual(saved);
    expect(await profileRowCount('PER-ana-dup')).toBe(0);
  });
});
