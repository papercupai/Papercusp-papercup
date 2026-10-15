/**
 * The git-sync restricted-write hold against real Postgres (WI-10005571, plan
 * personal-data-reader-set-labels-2026-10-01 P-014, D-006 point 3, BAR R-10).
 *
 * The unit suite (git-sync-hold.test.ts) pins the census mapping and the git-sync
 * seam with a fake sql. This suite runs the hold's SQL on a migrated throwaway
 * database, so the rule itself is measured, not assumed:
 *
 *   a path an agent edited at time t is held while that agent has a disclosure
 *   with delivered_at <= t whose released_at is still NULL.
 *
 * It asserts each boundary of that rule (an edit before delivery, a released
 * disclosure, an agent with no disclosure, two disclosures of one agent), that one
 * holding is kept per (repo_root, file) using the latest edit, that a missing
 * ledger fails closed, and that the production wiring (`recordRestrictedEditBeforeRelease`
 * and `readGitSyncCensusStrict` with their default deps) reads and writes this
 * database through getOrgPg.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyMigrationForTest } from '../../test/_pg-helpers';

const holder = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: holder.sql }),
}));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { recordEditAttributionStrict } = await import('../edit-attribution');
const {
  readRestrictedEditHoldings,
  ownerHasActiveDisclosure,
  recordRestrictedEditBeforeRelease,
  readGitSyncCensusStrict,
  RESTRICTED_HOLD_INTENT,
} = await import('./git-sync-hold');
type OrgTestDb = import('../../test/_org-test-db').OrgTestDb;

const WS = 'git-sync-hold-test';
const ACTIVE = 'su-hold-active';
const RELEASED = 'su-hold-released';
const TWO = 'su-hold-two-disclosures';
const OTHER = 'su-hold-no-disclosure';
const REPO_A = '/repo/a';
const REPO_B = '/repo/b';

const T0 = '2026-01-01T00:30:00Z';
const T1 = '2026-01-01T01:00:00Z';
const T2 = '2026-01-01T02:00:00Z';
const T2B = '2026-01-01T02:30:00Z';
const T3 = '2026-01-01T03:00:00Z';
const T4 = '2026-01-01T04:00:00Z';

let org: OrgTestDb;
let sql: postgres.Sql;
let userId: string;

async function disclose(agent: string, deliveredAt: string, releasedAt: string | null): Promise<void> {
  await sql`
    INSERT INTO harness_shared.personal_disclosures
      (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set,
       delivered_via, delivered_at, released_at, released_by, release_ref)
    VALUES (${WS}, ${userId}, ${agent}, gen_random_uuid(), 'email', 'participants',
            ${['alice@example.com']}::text[], 'personal:search', ${deliveredAt}::timestamptz,
            ${releasedAt}::timestamptz, ${releasedAt ? 'owner' : null},
            ${releasedAt ? 'fixture-release' : null})`;
}

async function edit(agent: string, repoRoot: string, file: string, ts: string, workItemId: string | null = null) {
  await sql`
    INSERT INTO harness_shared.edit_attribution_ledger (repo_root, file, agent_id, work_item_id, ts)
    VALUES (${repoRoot}, ${file}, ${agent}, ${workItemId}, ${ts}::timestamptz)`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  // Exercise the registered upgrade privately before it is armed; after arming,
  // the full fixture already applies it and this also proves idempotent replay.
  const migration = fileURLToPath(new URL(
    '../../../../libs/papercusp/libs/db/sql/1367-edit-attribution-dispatch-call-id.sql', import.meta.url,
  ));
  await applyMigrationForTest(sql, existsSync(migration) ? migration : `${migration}.DRAFT`);
  holder.sql = sql;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'git-sync-hold-' + Date.now()}, 'git-sync hold')
    RETURNING id`;
  userId = user.id;

  // ACTIVE: one unreleased disclosure delivered at T1.
  await disclose(ACTIVE, T1, null);
  await edit(ACTIVE, REPO_A, 'before-delivery.ts', T0);
  await edit(ACTIVE, REPO_A, 'at-delivery.ts', T1);
  await edit(ACTIVE, REPO_A, 'after.ts', T2, 'WI-early');
  await edit(ACTIVE, REPO_A, 'after.ts', T2B, 'WI-late');
  await edit(ACTIVE, REPO_B, 'after.ts', T2);

  // RELEASED: the only disclosure was released, so nothing it edited is held.
  await disclose(RELEASED, T1, T3);
  await edit(RELEASED, REPO_A, 'released-window.ts', T2);
  await edit(RELEASED, REPO_A, 'after-release.ts', T4);

  // TWO: a released disclosure [T0, T1) and an active one from T3.
  await disclose(TWO, T0, T1);
  await disclose(TWO, T3, null);
  await edit(TWO, REPO_A, 'between.ts', T2);
  await edit(TWO, REPO_A, 'late.ts', T4);

  // OTHER: no disclosure at all.
  await edit(OTHER, REPO_A, 'unrestricted.ts', T2);
}, 120_000);

afterAll(async () => {
  if (org && userId) {
    await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`.catch(() => {});
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  }
  holder.sql = null;
  await org?.cleanup();
});

function keyOf(h: { coordinationDomain?: string; path: string }): string {
  return `${h.coordinationDomain ?? ''}:${h.path}`;
}

describe('readRestrictedEditHoldings (real Postgres)', () => {
  it('holds exactly the paths edited at or after an unreleased disclosure was delivered to the same agent', async () => {
    const holdings = await readRestrictedEditHoldings(sql);
    expect(holdings.map(keyOf).sort()).toEqual(
      [`${REPO_A}:after.ts`, `${REPO_A}:at-delivery.ts`, `${REPO_A}:late.ts`, `${REPO_B}:after.ts`].sort(),
    );
  });

  it('does not hold an edit made before delivery, inside a released window, or by an agent with no disclosure', async () => {
    const paths = new Set((await readRestrictedEditHoldings(sql)).map((h) => h.path));
    for (const p of ['before-delivery.ts', 'released-window.ts', 'after-release.ts', 'between.ts', 'unrestricted.ts']) {
      expect(paths.has(p), p).toBe(false);
    }
  });

  it('keeps one holding per (repo_root, file), carrying the latest edit, in the domain it was edited under', async () => {
    const holdings = await readRestrictedEditHoldings(sql);
    const a = holdings.filter((h) => h.path === 'after.ts' && h.coordinationDomain === REPO_A);
    expect(a).toEqual([
      { path: 'after.ts', owner: ACTIVE, intent: RESTRICTED_HOLD_INTENT, goalRef: 'WI-late', coordinationDomain: REPO_A },
    ]);
    const b = holdings.filter((h) => h.path === 'after.ts' && h.coordinationDomain === REPO_B);
    expect(b).toEqual([{ path: 'after.ts', owner: ACTIVE, intent: RESTRICTED_HOLD_INTENT, coordinationDomain: REPO_B }]);
  });

  it('lifts the hold once the disclosure is released', async () => {
    await sql.begin(async (tx) => {
      await tx`UPDATE harness_shared.personal_disclosures
                  SET released_at = now(), released_by = 'owner', release_ref = 'fixture-release'
                WHERE agent_owner_id = ${ACTIVE} AND released_at IS NULL`;
      const owners = new Set((await readRestrictedEditHoldings(tx)).map((h) => h.owner));
      expect(owners.has(ACTIVE)).toBe(false);
      expect(owners.has(TWO)).toBe(true);
      throw new RollbackSentinel();
    }).catch((e) => {
      if (!(e instanceof RollbackSentinel)) throw e;
    });
    // Rolled back: the hold is in force again.
    expect((await readRestrictedEditHoldings(sql)).some((h) => h.owner === ACTIVE)).toBe(true);
  });

  it('fails closed: an unreadable disclosure ledger is a refusal, never an empty census', async () => {
    await sql.begin(async (tx) => {
      await tx`ALTER TABLE harness_shared.personal_disclosures RENAME TO personal_disclosures_hidden`;
      await expect(readRestrictedEditHoldings(tx)).rejects.toMatchObject({ code: 'disclosure_ledger_unavailable' });
      throw new RollbackSentinel();
    }).catch((e) => {
      if (!(e instanceof RollbackSentinel)) throw e;
    });
    expect((await readRestrictedEditHoldings(sql)).length).toBeGreaterThan(0);
  });
});

describe('ownerHasActiveDisclosure (real Postgres)', () => {
  it('is true only for an owner with an unreleased disclosure', async () => {
    expect(await ownerHasActiveDisclosure(sql, ACTIVE)).toBe(true);
    expect(await ownerHasActiveDisclosure(sql, TWO)).toBe(true);
    expect(await ownerHasActiveDisclosure(sql, RELEASED)).toBe(false);
    expect(await ownerHasActiveDisclosure(sql, OTHER)).toBe(false);
  });
});

describe('production wiring through getOrgPg (real Postgres)', () => {
  it('captures each file once per dispatch while retaining separate calls and legacy captures', async () => {
    const input = { repoRoot: REPO_A, files: ['dispatch-a.ts', 'dispatch-b.ts'], agentId: ACTIVE };
    await recordEditAttributionStrict({ ...input, dispatchCallId: 'hold-dispatch-1' });
    await recordEditAttributionStrict({ ...input, dispatchCallId: 'hold-dispatch-1' });
    await recordEditAttributionStrict({ ...input, dispatchCallId: 'hold-dispatch-2' });
    await recordEditAttributionStrict(input);
    await recordEditAttributionStrict(input);
    const rows = await sql<Array<{ file: string; dispatch_call_id: string | null }>>`
      SELECT file, dispatch_call_id FROM harness_shared.edit_attribution_ledger
       WHERE repo_root = ${REPO_A} AND file = ANY(${input.files}::text[])
       ORDER BY file, dispatch_call_id NULLS LAST`;
    for (const file of input.files) {
      expect(rows.filter((row) => row.file === file).map((row) => row.dispatch_call_id))
        .toEqual(['hold-dispatch-1', 'hold-dispatch-2', null, null]);
    }
  });

  it('recordRestrictedEditBeforeRelease writes the ledger row for a restricted owner, and the census then holds it', async () => {
    const recorded = await recordRestrictedEditBeforeRelease({
      repoRoot: REPO_A,
      files: ['written-before-release.ts'],
      ownerId: ACTIVE,
    });
    expect(recorded).toBe(true);
    const census = await readGitSyncCensusStrict({ locks: async () => [] });
    expect(census.map(keyOf)).toContain(`${REPO_A}:written-before-release.ts`);
  });

  it('recordRestrictedEditBeforeRelease writes nothing for an owner with no active disclosure', async () => {
    const recorded = await recordRestrictedEditBeforeRelease({
      repoRoot: REPO_A,
      files: ['unrestricted-release.ts'],
      ownerId: OTHER,
    });
    expect(recorded).toBe(false);
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.edit_attribution_ledger
       WHERE agent_id = ${OTHER} AND file = 'unrestricted-release.ts'`;
    expect(row.n).toBe(0);
  });

  it('readGitSyncCensusStrict is the union of the live locks and the restricted holds', async () => {
    const lock = { path: 'locked.ts', owner: 'su-peer', intent: 'editing', coordinationDomain: REPO_A };
    const census = await readGitSyncCensusStrict({ locks: async () => [lock] });
    expect(census).toContainEqual(lock);
    expect(census.filter((h) => h.intent === RESTRICTED_HOLD_INTENT).length).toBeGreaterThanOrEqual(4);
  });
});

class RollbackSentinel extends Error {}
