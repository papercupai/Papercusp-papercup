/**
 * hive-roster.integration.test.ts — the presence-v2 Phase 3 fold (P-006/P-015)
 * against REAL Postgres. The pure halves (foldHiveRoster / filterPresenceToHive /
 * toRosterSnapshot) are unit-tested in hive-roster.test.ts; this verifies the IO
 * composition that unit tests can't: the hive-scoping read over coord_presence's
 * mig-277 hive_slug, the per-agent merge of presence + the fleet_assignment
 * work-detail + Tier-1, against seeded rows.
 *
 * Uses a caller-owned migrated DB (full migration set incl. 277) via the coord
 * fixture, so listHiveRoster's own getOrgPg()/listPresence/listFleetAssignments/
 * fetchPresenceTier1 handles resolve to it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { listHiveRoster, listHiveRosterSnapshot } from './hive-roster';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;
let isolatedDb: OrgTestDb;

const WS = 'default';
const HIVE = 'papercup';

async function truncateAll(): Promise<void> {
  await admin`TRUNCATE harness_shared.coord_presence`;
  await admin`TRUNCATE harness_shared.plan_item_claims`;
  await admin`DELETE FROM harness_shared.harness_features_consolidated WHERE feature_id LIKE 'HR-TEST-%'`;
}

/** Seed a coord_presence row WITH the mig-277 columns (pot_slug / last_active_at
 *  / agent_role) — the assignments fixture's seedPresence predates them. (pot_slug
 *  is the D-007 pot-rename successor to the mig-277 hive_slug hive-scope key.)
 *  WI-5964: coord_presence_pkey is PRIMARY KEY(owner_id) ONLY — globally unique,
 *  not scoped by workspace_id — so a bare INSERT can collide with a same-named
 *  literal owner_id seeded by another concurrent *.integration.test.ts process on
 *  this shared fixture. Upsert so this test's own values always win. */
async function seedPresence(
  ownerId: string,
  opts: {
    potSlug?: string | null;
    lastActiveAgeSec?: number | null;
    agentRole?: string | null;
    intent?: string;
    planSlug?: string | null;
    heartbeatAgeSec?: number;
  } = {},
): Promise<void> {
  await admin`
    INSERT INTO harness_shared.coord_presence
      (owner_id, owner_label, workspace_id, source, intent, current_plan_slug,
       heartbeat_at, last_active_at, agent_role, pot_slug)
    VALUES (
      ${ownerId}, ${ownerId}, ${WS}, 'test', ${opts.intent ?? ''}, ${opts.planSlug ?? null},
      now() - ${`${opts.heartbeatAgeSec ?? 0} seconds`}::interval,
      ${opts.lastActiveAgeSec == null ? null : admin`now() - ${`${opts.lastActiveAgeSec} seconds`}::interval`},
      ${opts.agentRole ?? null},
      ${opts.potSlug === undefined ? HIVE : opts.potSlug}
    )
    ON CONFLICT (owner_id) DO UPDATE SET
      owner_label = EXCLUDED.owner_label,
      workspace_id = EXCLUDED.workspace_id,
      source = EXCLUDED.source,
      intent = EXCLUDED.intent,
      current_plan_slug = EXCLUDED.current_plan_slug,
      heartbeat_at = EXCLUDED.heartbeat_at,
      last_active_at = EXCLUDED.last_active_at,
      agent_role = EXCLUDED.agent_role,
      pot_slug = EXCLUDED.pot_slug
  `;
}

async function seedPlanClaim(owner: string, item: string, plan = 'plan-x'): Promise<void> {
  await admin`
    INSERT INTO harness_shared.plan_item_claims
      (workspace_id, harness_slug, plan_slug, item_id, owner, owner_name, intent, expires_ts)
    VALUES (${WS}, 'all', ${plan}, ${item}, ${owner}, null, 'testing', now() + interval '1200 seconds')
  `;
}

async function seedWorkItem(feature: string, owner: string, harness = 'demo'): Promise<void> {
  await admin`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, taken_by, taken_at, source_plan_slug)
    VALUES (${WS}, ${harness}, ${feature}, ${`work ${feature}`}, 'todo', ${owner}, now(), 'plan-x')
  `;
}

beforeAll(async () => {
  // The roster intentionally includes default/global rows. Isolate the real
  // reader rather than changing its scope or truncating another suite's rows.
  isolatedDb = await createOrgTestDb();
  fx = await setupBaselineCoordFixture({ dsn: isolatedDb.adminDsn });
  admin = fx.admin;
  // Exercise membership enforcement with real Pots, including the platform
  // Pot that activates the guard in this workspace.
  for (const slug of ['papercusp', 'demo']) {
    await admin`
      INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
      VALUES (${WS}, ${slug}, ${Buffer.from(`pk:roster:${slug}`)}, ${`kc-roster-${slug}`}, 0)
      ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  }
  await truncateAll();
}, 120_000);

afterAll(async () => {
  try {
    await truncateAll().catch(() => {});
  } finally {
    try {
      await fx?.dispose();
    } finally {
      await isolatedDb?.cleanup();
    }
  }
});

beforeEach(async () => {
  await truncateAll();
});

describe('listHiveRoster (presence-v2 P-006 fold, real PG)', () => {
  it('keeps the real membership guard active for an unregistered Pot', async () => {
    await expect(seedWorkItem('HR-TEST-INVALID', 'su-invalid', 'not-a-real-pot'))
      .rejects.toThrow('pot-membership violation');
  });

  it('hive-scopes: keeps the hive + NULL-hive standalone, drops other hives', async () => {
    await seedPresence('su-in', { potSlug: HIVE });
    await seedPresence('su-null', { potSlug: null }); // SU / standalone
    await seedPresence('su-other', { potSlug: 'other-hive' });

    const roster = await listHiveRoster({ potSlug: HIVE, workspaceId: WS });
    const ids = roster.map((e) => e.agentId).sort();
    expect(ids).toEqual(['su-in', 'su-null']);
    expect(roster.some((e) => e.agentId === 'su-other')).toBe(false);
  });

  it('includeUnattributed:false excludes NULL-hive agents', async () => {
    await seedPresence('su-in', { potSlug: HIVE });
    await seedPresence('su-null', { potSlug: null });
    const roster = await listHiveRoster({ potSlug: HIVE, workspaceId: WS, includeUnattributed: false });
    expect(roster.map((e) => e.agentId)).toEqual(['su-in']);
  });

  it('folds presence identity + mig-277 scalars + Tier-1 + the fleet work-detail per agent', async () => {
    await seedPresence('su-busy', {
      potSlug: HIVE,
      agentRole: 'su',
      lastActiveAgeSec: 30,
      intent: 'building the fold',
      planSlug: 'plan-x',
    });
    await seedPlanClaim('su-busy', 'P-006'); // Tier-1 claimedItems
    await seedWorkItem('HR-TEST-1', 'su-busy'); // work-item → doing/load

    const roster = await listHiveRoster({ potSlug: HIVE, workspaceId: WS });
    const e = roster.find((r) => r.agentId === 'su-busy');
    expect(e).toBeDefined();
    // mig-277 scalars
    expect(e!.agentRole).toBe('su');
    expect(e!.potSlug).toBe(HIVE);
    expect(e!.lastActiveSecAgo).not.toBeNull();
    expect(e!.lastActiveSecAgo!).toBeGreaterThanOrEqual(25);
    // Tier-1 claim lane
    expect(e!.claimedItems).toContain('P-006');
    // fleet work-detail (shape preserved, P-015)
    expect(e!.doing?.id).toBe('HR-TEST-1');
    expect(e!.load).toBe(1);
    expect(e!.federated).toBe(false);
  });

  it('listHiveRosterSnapshot returns the lean per-agent lines', async () => {
    await seedPresence('su-x', { potSlug: HIVE, agentRole: 'su', lastActiveAgeSec: 5 });
    await seedWorkItem('HR-TEST-2', 'su-x');
    const snap = await listHiveRosterSnapshot({ potSlug: HIVE, workspaceId: WS });
    const line = snap.find((l) => l.ownerId === 'su-x');
    expect(line).toBeDefined();
    expect(line!.doing).toBe('HR-TEST-2'); // id only
    expect(line!.load).toBe(1);
    expect(line!.agentRole).toBe('su');
    expect('queued' in (line as object)).toBe(false); // lean — heavy arrays dropped
  });
});
