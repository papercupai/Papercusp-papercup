/**
 * work-item-claim-lease-issue-cleanup.integration.test.ts — EI-6480 issue-family stale-lease
 * cleanup against real Postgres.
 *
 * THE BUG (confirmed live 2026-07-03): an issue claimed via work_items:claim_next acquires a
 * per-Hive lease keyed on the claiming agent's BARE harness (leaseClaimedWorkItem's
 * `args.harness`, e.g. 'papercusp'), but the issue-family taken_by-clearing paths
 * (reclaimStaleIssueClaims / releaseIssue) clear only `engineer_issues.assignee` — which has
 * NO harness_slug and, for an `operator:<ws>`-scope issue, no way to recover the claiming
 * harness. So the exact-key lease release misses and the lease ORPHANS: the item reads
 * unclaimed yet fails lease arbitration for every new claimer until the TTL — the reported
 * "ready but a peer raced you (retry)" miss with readyUnclaimed>0.
 *
 * THE FIX: key issue-family lease cleanup on (workspace_id, work_item_id, owner) — harness-
 * agnostic, safe because issue ids are GLOBALLY UNIQUE — in the reaper's per-row pass, plus a
 * bounded orphan-GC (scoped to claim_next-intent leases on UNCLAIMED, NON-TERMINAL issues so
 * it can never touch an executor lease or a live claim). This proves both, and the safety
 * boundaries, on real PG with the WORKITEM_CLAIM_LEASE flag ON.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { emitFlagChange } from '@papercusp/flags/server';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { reclaimStaleIssueClaims } = await import('./work-items-stale-claims');
const { workItemClaimLeaseEnabled, gcOrphanIssueLeases, releaseIssueClaimLease } = await import(
  './work-item-claim-lease-wiring'
);

/** WORKITEM_CLAIM_LEASE FLAG (P-012/D-008): sync-cached, refreshed on flag change. */
async function setLeaseFlag(on: boolean): Promise<void> {
  setFlagOverridesForTest({ [FLAGS.WORKITEM_CLAIM_LEASE]: on });
  emitFlagChange(FLAGS.WORKITEM_CLAIM_LEASE);
  await new Promise((r) => setTimeout(r, 0));
}

const WORK_ITEM_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, work_item_id text NOT NULL,
    pot_slug text, claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL, owner_label text, holder_pubkey text,
    intent text DEFAULT ''::text NOT NULL, ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_claims_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id))`;
// liveHolderFragment (mig-225 alias-aware liveness) reads these — a holder with no fresh row
// in either is DEAD, so the reaper frees the claim.
const PRESENCE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
    owner_id text PRIMARY KEY, heartbeat_at timestamptz)`;
const SPAWNED_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY, session_owner text, run_id text, status text NOT NULL,
    heartbeat_at timestamptz, finished_at timestamptz, cancelled_at timestamptz)`;
// EI-18674157526367861: liveHolderFragment ALSO unconditionally folds in
// activeTurnHolderFragment (a recent harness_shared.agent_activity row confers
// liveness too) — this fixture predates that change, so reclaimStaleIssueClaims
// hard-errored here with "relation harness_shared.agent_activity does not exist"
// the moment that fragment landed (a stale-fixture class per the CLAUDE.md "trigger
// to watch" note: a dependency ADDED to a shared query, not selected by this file's
// own schema). Deliberately minimal — same projection as
// work-items-stale-claims.integration.test.ts's own AGENT_ACTIVITY_DDL.
const AGENT_ACTIVITY_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.agent_activity (
    id BIGSERIAL PRIMARY KEY, owner_id text NOT NULL, kind text NOT NULL, summary text,
    created_at timestamptz NOT NULL DEFAULT now())`;
// EI-21431501901242395: liveHolderFragment now also reads the armed-loop
// continuation authority. Minimal projection for this isolated fixture.
const ROUTINES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.routines (
    id text PRIMARY KEY, target_owner_id text,
    reschedule_interval_sec integer, active boolean NOT NULL DEFAULT true)`;
const CLAIM_NEXT_INTENT = 'work-stealing claim (claim_next)';

let db: FreshPgDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshPgDb('wi-claim-lease-issue-cleanup');
  sql = db.sql;
  h.sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  // EI-25188751918038775: the private sign-of-life projection missed fed_ts when
  // the reaper moved to the content clock. Reuse the shared complete base table
  // and compatibility view so future shared-query fields are maintained once.
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL).simple();
  await sql.unsafe(WORK_ITEM_CLAIMS_DDL);
  await sql.unsafe(PRESENCE_DDL);
  await sql.unsafe(SPAWNED_DDL);
  await sql.unsafe(AGENT_ACTIVITY_DDL);
  await sql.unsafe(ROUTINES_DDL);
}, 120_000);

afterAll(async () => {
  setFlagOverridesForTest(null);
  await db?.cleanup();
});

beforeEach(async () => {
  // engineer_issues is a compatibility view of work_items in the shared schema.
  await sql`TRUNCATE harness_shared.work_item_claims, harness_shared.work_items, harness_shared.coord_presence, harness_shared.spawned_agents, harness_shared.agent_activity, harness_shared.routines`;
  await setLeaseFlag(true);
});
afterEach(async () => {
  await setLeaseFlag(false);
});

/** Seed an engineer_issues row (operator scope, like the confirmed-orphan case). */
async function seedIssue(
  issueId: string,
  kind: string,
  assignee: string | null,
  assignedAgoMin: number,
  state = 'open',
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, kind, scope, title, state, assignee, assigned_by, assigned_at, created_at, updated_at)
    VALUES ('default', ${issueId}, ${kind}, 'operator', ${issueId}, ${state}, ${assignee},
      ${kind === 'task' ? 'operator' : null},
      ${assignee ? sql`now() - make_interval(mins => ${assignedAgoMin})` : null}, now(), now())`;
}

/** Seed a lease row — like leaseClaimedWorkItem's acquire (bare harness, claim_next intent). */
async function seedLease(
  workItemId: string,
  owner: string,
  opts: { intent?: string; harness?: string } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_item_claims
      (workspace_id, harness_slug, work_item_id, owner, intent, ttl_sec, expires_ts)
    VALUES ('default', ${opts.harness ?? 'papercusp'}, ${workItemId}, ${owner},
      ${opts.intent ?? CLAIM_NEXT_INTENT}, 1800, clock_timestamp() + interval '1800 seconds')`;
}

async function leaseExists(workItemId: string, owner: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM harness_shared.work_item_claims WHERE work_item_id = ${workItemId} AND owner = ${owner}`;
  return rows.length > 0;
}
async function assigneeOf(issueId: string): Promise<string | null> {
  const [row] = await sql<{ assignee: string | null }[]>`
    SELECT assignee FROM harness_shared.engineer_issues WHERE issue_id = ${issueId}`;
  return row?.assignee ?? null;
}

describe('EI-6480 — issue-family stale-lease cleanup (WORKITEM_CLAIM_LEASE on)', () => {
  it('the flag override is live for this suite', () => {
    expect(workItemClaimLeaseEnabled()).toBe(true);
  });

  it('reclaimStaleIssueClaims frees a dead holder AND clears its orphaned lease (the core fix)', async () => {
    // Operator-scope issue held by a DEAD holder (STALE presence row — locally known but not
    // live, WI-1999), claimed long enough ago to be past the 10-min grace — exactly the shape
    // that orphaned leases in prod.
    await seedIssue('EI-1', 'change', 'dead-holder', 30, 'open');
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('dead-holder', now() - interval '1 hour')
              ON CONFLICT (owner_id) DO NOTHING`;
    await seedLease('EI-1', 'dead-holder');

    const r = await reclaimStaleIssueClaims(sql);

    expect(r.released.map((x) => x.issue_id)).toContain('EI-1'); // the issue was reaped
    expect(await assigneeOf('EI-1')).toBeNull(); // assignee cleared → back in the OPEN pool
    expect(await leaseExists('EI-1', 'dead-holder')).toBe(false); // …and the lease is GONE
    expect(r.orphanLeasesCleared).toBeGreaterThanOrEqual(1);
  });

  it.each([
    { label: 'recent content write preserves the claim', fedAgoMin: 0, updatedAgoMin: 30, released: false },
    { label: 'bookkeeping-only write does not preserve the claim', fedAgoMin: 30, updatedAgoMin: 0, released: true },
    { label: 'legacy NULL content clock uses the recent update fallback', fedAgoMin: null, updatedAgoMin: 0, released: false },
  ])('unknown holder: $label', async ({ fedAgoMin, updatedAgoMin, released }) => {
    await seedIssue('EI-CLOCK', 'bug', 'never-seen-holder', 30);
    await seedLease('EI-CLOCK', 'never-seen-holder');
    // Keep the held issue itself idle, so only the sibling's clock can prevent
    // fallback reaping. Issue rows now live in the same canonical base table.
    await sql`
      UPDATE harness_shared.work_items
         SET fed_ts = (extract(epoch FROM now() - interval '30 minutes') * 1000)::bigint,
             updated_ts = (extract(epoch FROM now() - interval '30 minutes') * 1000)::bigint
       WHERE feature_id = 'EI-CLOCK'`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by, fed_ts, updated_ts)
      VALUES ('default', 'papercusp', 'F-CLOCK-SIBLING', 'feature', 'Sibling content clock', 'wip',
              'never-seen-holder',
              ${fedAgoMin === null ? null : sql`(extract(epoch FROM now() - make_interval(mins => ${fedAgoMin})) * 1000)::bigint`},
              (extract(epoch FROM now() - make_interval(mins => ${updatedAgoMin})) * 1000)::bigint)`;

    const result = await reclaimStaleIssueClaims(sql, { unknownHolderFallbackMs: 10 * 60_000 });

    expect(result.released.some((row) => row.issue_id === 'EI-CLOCK')).toBe(released);
    expect(await assigneeOf('EI-CLOCK')).toBe(released ? null : 'never-seen-holder');
    expect(await leaseExists('EI-CLOCK', 'never-seen-holder')).toBe(!released);
  });

  it('the orphan-GC heals a lingering lease on an already-unclaimed, non-terminal issue', async () => {
    // The historical-backlog shape: item already free (assignee null), lease left behind.
    await seedIssue('EI-2', 'bug', null, 0, 'open');
    await seedLease('EI-2', 'ghost-owner');

    const cleared = await gcOrphanIssueLeases();

    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(await leaseExists('EI-2', 'ghost-owner')).toBe(false);
  });

  it('releaseIssueClaimLease removes exactly the freed owner+item lease (harness-agnostic)', async () => {
    // The lease was acquired under the bare harness 'papercusp'; release keys on owner+item and
    // still finds it despite never knowing that harness (the operator-scope core of the fix).
    await seedIssue('EI-3', 'change', null, 0, 'open');
    await seedLease('EI-3', 'holder-x', { harness: 'papercusp' });

    const deleted = await releaseIssueClaimLease({ workItemId: 'EI-3', owner: 'holder-x' });

    expect(deleted).toBe(true);
    expect(await leaseExists('EI-3', 'holder-x')).toBe(false);
  });

  describe('safety — the GC never deletes a lease that matters', () => {
    it('PRESERVES a lease on a still-CLAIMED issue (assignee set)', async () => {
      await seedIssue('EI-4', 'bug', 'live-owner', 1, 'open');
      await seedLease('EI-4', 'live-owner');

      const cleared = await gcOrphanIssueLeases();

      expect(cleared).toBe(0);
      expect(await leaseExists('EI-4', 'live-owner')).toBe(true);
    });

    it('PRESERVES a non-claim_next (executor dispatch) lease on an unclaimed issue', async () => {
      await seedIssue('EI-5', 'change', null, 0, 'open');
      await seedLease('EI-5', 'exec-owner', { intent: 'executor dispatch (orchestrator)' });

      const cleared = await gcOrphanIssueLeases();

      expect(cleared).toBe(0);
      expect(await leaseExists('EI-5', 'exec-owner')).toBe(true);
    });

    it('PRESERVES a lease on a TERMINAL (resolved) issue (not claimable → nothing to un-poison)', async () => {
      await seedIssue('EI-6', 'bug', null, 0, 'resolved');
      await seedLease('EI-6', 'done-owner');

      const cleared = await gcOrphanIssueLeases();

      expect(cleared).toBe(0);
      expect(await leaseExists('EI-6', 'done-owner')).toBe(true);
    });
  });

  it('flag OFF → reclaimStaleIssueClaims still reaps but leaves the lease untouched (gated, byte-identical)', async () => {
    await setLeaseFlag(false);
    await seedIssue('EI-7', 'change', 'dead-holder', 30, 'open');
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('dead-holder', now() - interval '1 hour')
              ON CONFLICT (owner_id) DO NOTHING`;
    await seedLease('EI-7', 'dead-holder');

    const r = await reclaimStaleIssueClaims(sql);

    expect(await assigneeOf('EI-7')).toBeNull(); // the reap itself is unchanged by the flag
    expect(r.orphanLeasesCleared).toBe(0); // …but no lease cleanup runs
    expect(await leaseExists('EI-7', 'dead-holder')).toBe(true); // lease left for the flag-off path
  });
});
