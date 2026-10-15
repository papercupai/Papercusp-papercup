/**
 * work-items-federation-detector-exclusion.integration.test.ts — the issue-family
 * replication-liveness detector self-select exclusion (WI-2633).
 *
 * The replication-liveness detector (replication-stall-ei.ts, P-004/WI-1840) auto-files durable
 * EIs for connected-but-dead peers (no_replicator / frozen / connected_never_replicated /
 * drain_stalled / drain_backlog_stalled / drain_orphan_tail), stamped with the stable filer
 * identity `payload._ei.created_by = 'system:replication-liveness'`. These land in the GENERAL
 * papercusp backlog every fleet member self-pulls through — but a generic backlog-drain worker
 * structurally CANNOT resolve one (verifying the current verdict needs the p2p-release-readiness
 * fleet's live in-process getReplicationLiveness()/dogfood-substrate diagnostics, not
 * PG-queryable). So each generic pickup could only ever close it as gated-to-another-fleet after
 * a live-status check it can't cheaply make — burning a wake each time (WI-2633 observed this
 * repeatedly; the detector's recovery auto-resolve is edge-triggered, so an EI whose harness/log
 * never re-boots sits open indefinitely and keeps re-surfacing to self-selectors).
 *
 * Mirrors work-items-needs-human-exclusion.integration.test.ts's shape exactly (same self-select
 * floor pattern, applied to a different — nested — payload key):
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • claimNextWorkItem's issue tier SKIPS a detector EI and serves a real one instead — even
 *     when the detector EI is oldest (would otherwise win the oldest-first steal);
 *   • a detector EI is STILL directly claimable BY ID (the floor only gates self-select);
 *   • an EI with a DIFFERENT _ei.created_by (a normal engineer/human filing) is NOT excluded;
 *   • a row with no payload / no _ei envelope is NOT excluded (NULL-safe);
 *   • diagnoseClaimNextMiss reports a detector-ONLY backlog as DRAINED (pendingUnclaimed===0,
 *     drained===true) — a detector EI is not generic-work-queue material AT ALL, so a drainer
 *     facing only these must be told to idle, never "work exists, don't idle";
 *   • a real ready item alongside a detector EI counts fully (the detector row neither shadows
 *     siblings nor inflates the pending/ready counts).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-federation-detector-exclusion.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  ADV_SESSIONS_CLAIM_MIN_DDL,
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
/** The detector's stable filer identity — must match replication-stall-ei.ts (createdBy /
 *  RECOVERY_OWNER) and federationDetectorExclusionSql's discriminator. */
const DETECTOR = 'system:replication-liveness';
let db: FreshPgDb;

/** An issue-family row in the work_items BASE. */
async function seedIssue(
  id: string,
  opts: { kind?: string; status?: string; takenBy?: string | null; createdTs?: number; payload?: Record<string, unknown> | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, ${opts.kind ?? 'bug'}, ${`title ${id}`}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null},
       ${WS}, ${opts.createdTs ?? 0}, 0, ${
         opts.payload ? db.sql.json(opts.payload as unknown as Parameters<typeof db.sql.json>[0]) : null
       })`;
}

/** The `_ei` envelope work_items mirrors from engineer_issues, carrying the detector's identity. */
const detectorPayload = (extra: Record<string, unknown> = {}) => ({
  _ei: { scope: 'operator', source: 'engineer', created_by: DETECTOR, found_during: 'replication-liveness-detector', ...extra },
});

beforeAll(async () => {
  db = await createFreshPgDb('wi-federation-detector');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  // Every claim door reads adv_sessions for operation-worker claim authority; without the
  // table the door fails closed before the detector floor is ever exercised.
  await db.sql.unsafe(ADV_SESSIONS_CLAIM_MIN_DDL);
  // The by-id issue claim auto-subscribes the claimer (coord_entity_subscriptions).
  await ensureCoordCapabilityTables(db.sql);
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => setFlagOverridesForTest({}));

describe('claimNextWorkItem SKIPS a replication-liveness detector EI (WI-2633)', () => {
  it('serves the real item, never the detector EI, even when it is oldest', async () => {
    await seedIssue('EI-detector', { createdTs: 100, payload: detectorPayload() });
    await seedIssue('WI-real', { createdTs: 200 });

    // Oldest-first would normally serve EI-detector (createdTs:100) — the floor must skip it.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-real');

    // Only one real candidate existed — it's now claimed, so the pool is genuinely dry.
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' })).toBeNull();

    // The detector EI was NEVER claimed by the self-select path.
    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'EI-detector'`;
    expect(rows[0]?.taken_by).toBeNull();
  });

  it('a detector EI is STILL directly claimable by id (the floor only gates self-select)', async () => {
    await seedIssue('EI-detector-direct', { createdTs: 100, payload: detectorPayload() });
    const claimed = await wi.claimWorkItem('EI-detector-direct', 'p2p-fleet', { harness: H });
    expect(claimed?.id).toBe('EI-detector-direct');
    expect(claimed?.assignee).toBe('p2p-fleet');
  });

  it('an EI with a DIFFERENT _ei.created_by is NOT excluded (only the detector identity gates)', async () => {
    await seedIssue('WI-human-ei', {
      kind: 'change',
      createdTs: 100,
      payload: { _ei: { scope: 'operator', source: 'engineer', created_by: 'engineer' } },
    });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-human-ei');
  });

  it('a row with no payload / no _ei envelope is NOT excluded (NULL-safe)', async () => {
    await seedIssue('WI-no-payload', { createdTs: 100, payload: null });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-no-payload');
  });
});

describe('diagnoseClaimNextMiss treats a detector-only backlog as DRAINED (WI-2633)', () => {
  it('pendingUnclaimed === 0 and drained === true (idle is correct — NOT pending-but-gated)', async () => {
    // Like needsHuman/observation (and unlike _claimHold): a detector EI is not generic-work-
    // queue material at all, so it must NOT inflate the pool — a detector-only queue reads
    // drained, so a drainer idles instead of hot-retrying an item it can never self-select.
    await seedIssue('EI-detector-diag', { createdTs: 100, payload: detectorPayload() });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(0);
    expect(diag.readyUnclaimed).toBe(0);
    expect(diag.drained).toBe(true);
  });

  it('a real ready item alongside a detector EI counts fully (detector neither shadows nor inflates)', async () => {
    await seedIssue('EI-detector-diag-2', { createdTs: 100, payload: detectorPayload() });
    await seedIssue('WI-ready-diag-2', { createdTs: 200 });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(1); // ONLY the real item — the detector row is excluded
    expect(diag.readyUnclaimed).toBe(1);
    expect(diag.drained).toBe(false);
  });
});

/**
 * WI-37761 — the ADVERTISE floor, the half this file did not cover.
 *
 * Everything above proves a detector EI cannot be CLAIMED by a self-selector. Nothing
 * proved it is not OFFERED, and those are different code paths: the claim path runs
 * federationDetectorExclusionSql (work-items.ts), the listing path runs
 * issueAdmissibleWhereSql (issues-engineer.ts) — which never mirrored it.
 *
 * That gap was live, not theoretical. `coord:orient { intent }` with no `harness` takes
 * the `work_items:list({ admissibleOnly:true })` leg, and returned a claimable list of 8
 * containing 2 detector EIs (EI-20083218992626765, EI-20083218888012602); 97 open rows
 * carried that filer. An agent picked one, hit the claim floor, and bounced — the exact
 * "advertised then refused" trip WI-2633 exists to prevent.
 *
 * A guard that only tests the claim floor cannot catch that, so these pin the other side.
 */
describe('admissibleOnly EXCLUDES a replication-liveness detector EI from the advertised backlog (WI-37761)', () => {
  it('is offered WITHOUT admissibleOnly but NOT with it (the floor is what removes it)', async () => {
    await seedIssue('EI-detector-list', { createdTs: 100, payload: detectorPayload() });
    await seedIssue('WI-real-list', { createdTs: 200 });

    // FALSIFIER FIRST: the unfiltered read must SEE the row. Without this, the
    // admissibleOnly assertion below would also pass if the fixture never seeded, if the
    // harness/state filter excluded it, or if the view stopped projecting created_by —
    // i.e. it would pass for reasons that have nothing to do with the floor.
    const unfiltered = await wi.listWorkItems({ harness: H, state: 'open' });
    expect(unfiltered.map((r) => r.id)).toContain('EI-detector-list');

    const admissible = await wi.listWorkItems({ harness: H, state: 'open', admissibleOnly: true });
    const ids = admissible.map((r) => r.id);
    expect(ids).not.toContain('EI-detector-list');
    expect(ids).toContain('WI-real-list'); // and it did not over-filter the real work
  });

  it('a DIFFERENT _ei.created_by is still advertised (only the detector identity gates)', async () => {
    await seedIssue('WI-human-list', {
      kind: 'change',
      createdTs: 100,
      payload: { _ei: { scope: 'operator', source: 'engineer', created_by: 'engineer' } },
    });
    const ids = (await wi.listWorkItems({ harness: H, state: 'open', admissibleOnly: true })).map((r) => r.id);
    expect(ids).toContain('WI-human-list');
  });

  it('a row with no payload / no _ei envelope is still advertised (NULL-safe)', async () => {
    // engineer_issues.created_by is the VIEW's `(payload->'_ei')->>'created_by'`, so a
    // null payload yields NULL — and `NULL IS DISTINCT FROM '<detector>'` is TRUE, i.e.
    // INCLUDED. A plain `<>` here would silently drop every payload-less row.
    await seedIssue('WI-no-payload-list', { createdTs: 100, payload: null });
    const ids = (await wi.listWorkItems({ harness: H, state: 'open', admissibleOnly: true })).map((r) => r.id);
    expect(ids).toContain('WI-no-payload-list');
  });

  it('a detector-only backlog advertises NOTHING (an agent is told to idle, not offered a bounce)', async () => {
    await seedIssue('EI-detector-only-1', { createdTs: 100, payload: detectorPayload() });
    await seedIssue('EI-detector-only-2', { createdTs: 200, payload: detectorPayload() });
    const admissible = await wi.listWorkItems({ harness: H, state: 'open', admissibleOnly: true });
    expect(admissible.map((r) => r.id)).toEqual([]);
  });
});
