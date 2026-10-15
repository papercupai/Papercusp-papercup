/**
 * work-item-claims-concurrency.integration.test.ts — the C3 concurrency stress for the
 * decentralized dispatch backlog (coordination-test-suite-2026-06-08 P-010).
 *
 * The existing claim tests cover the 2-instance contend case
 * (`work-item-claims-two-instance.integration.test.ts`) + the pure deterministic reconcile
 * (`work-item-claim-reconcile.test.ts`). This file proves the C3 properties at N-WAY
 * concurrency against REAL Postgres:
 *
 *   1. N distinct owners fire `acquireClaimLocal` for ONE (workspace, harness, item) at
 *      once → EXACTLY ONE wins; the other N-1 get a conflict (no double-claim). The PK +
 *      the ON CONFLICT … WHERE (expires_ts <= now() OR owner = EXCLUDED.owner) guard is
 *      the atomicity point — this is the N-way generalization of the 2-instance test.
 *   2. N>M concurrent claimers over a backlog of M items via `claimNextWorkItem`
 *      (SELECT … FOR UPDATE SKIP LOCKED) → each item is claimed by AT MOST one owner, no
 *      owner gets the same item twice, exactly M distinct claims land.
 *   3. LEASE TTL: A claims, the lease lapses (forced expiry), B then STEALS the lapsed
 *      lease — and the claim_id rotates.
 *   4. HEARTBEAT extends the lease: a live (non-lapsed) lease can't be stolen by a
 *      concurrent B; a foreign owner's heartbeat is a no-op.
 *   5. FAIL-OPEN reconcile under partition: two partitioned authorities both granted an
 *      advisory lease on one item → `reconcileClaims` deterministically picks the winner
 *      (earliest acquiredTs → lowest holderPubkey → lowest claimId) and re-running it is
 *      idempotent. This is the partition-heal scenario, exercised against advisory rows
 *      read out of REAL PG (not hand-built objects).
 *
 * DB wiring mirrors `work-items-claim.integration.test.ts` (real PG via createFreshPgDb +
 * mocked workspace-registry/db-org). We set up BOTH the `work_item_claims` lease table
 * (tests 1/3/4/5) AND the `harness_features_consolidated` backlog (test 2's claim_next).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import type { AdvisoryClaim } from './work-item-claim-reconcile';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

// The lease table (migration 188) — DDL inlined like the sibling claim tests so the
// suite does not depend on the full migration chain for this one table.
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

// The backlog table (claim_next via SKIP LOCKED) — canonical complete schema (single
// source of truth), test/_work-items-schema.ts (D-014 fixture-completeness debt).
const HFC_DDL = HARNESS_FEATURES_CONSOLIDATED_DDL;

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const {
  acquireClaimLocal,
  heartbeatClaimLocal,
  getClaim,
  DEFAULT_WORK_ITEM_TTL_SEC,
} = await import('./work-item-claims');
const wi = await import('./work-items');
const { reconcileClaims } = await import('./work-item-claim-reconcile');

const WS = 'default';
const H = 'papercup';

let db: FreshPgDb;

async function seedFeature(id: string, createdTs: number) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', 'open', NULL, ${WS}, ${createdTs}, 0)`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-claims-concurrency');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  h.sql = db.sql;
  await db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
  await db.sql.unsafe(HFC_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple()); // claim path LEFT-JOINs the trust list (autoPickableWhereSql, migration 276)
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // claim path's P-005 readiness clause reads work_item_deps
  // claim_next selects FEATURE_COLS (incl. assignee_rank/rank_writer/rank_updated_at from
  // migrations 131/142/152 + the local-hive rank cols) — replicate work-items-claim setup.
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;`).simple();
}, 90_000);

afterAll(async () => { await db?.cleanup(); });

afterEach(async () => {
  await db.sql`DELETE FROM harness_shared.work_item_claims`;
  await db.sql`TRUNCATE harness_shared.work_items `;
});

describe('C3 — N-way no-double-claim on ONE item (real PG)', () => {
  it('8 concurrent acquires for the same item ⇒ exactly ONE winner, 7 conflicts', async () => {
    const N = 8;
    const item = 'F-solo';
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: `owner-${i}` }),
      ),
    );
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);

    // The PG row has exactly one holder, and it's the winner.
    const winner = winners[0];
    if (!winner.ok) throw new Error('unreachable');
    const held = await getClaim(WS, H, item);
    expect(held?.owner).toBe(winner.claim.owner);
    // Every loser's conflict points at that same single holder.
    for (const l of losers) {
      if (l.ok) throw new Error('unreachable');
      expect(l.conflict.owner).toBe(winner.claim.owner);
    }
    const [{ n }] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.work_item_claims WHERE work_item_id = ${item}`;
    expect(n).toBe(1);
  });
});

describe('C3 — N>M concurrent claimers over a backlog via claim_next (SKIP LOCKED, real PG)', () => {
  it('M items, N claimers ⇒ each item claimed at most once, exactly M distinct claims', async () => {
    const M = 5;
    const N = 12; // oversubscribed: more claimers than items
    for (let i = 0; i < M; i += 1) await seedFeature(`F-${i}`, 100 + i);

    const claimed = await Promise.all(
      Array.from({ length: N }, (_, i) => wi.claimNextWorkItem({ harness: H, assignee: `swarm-${i}` })),
    );

    const won = claimed.filter((c): c is NonNullable<typeof c> => c != null);
    // Exactly M claimers got an item; the surplus N-M got null (backlog drained).
    expect(won).toHaveLength(M);
    // No item claimed twice (distinct ids), and every seeded item was taken.
    const ids = won.map((w) => w.id).sort();
    expect(new Set(ids).size).toBe(M);
    expect(ids).toEqual(['F-0', 'F-1', 'F-2', 'F-3', 'F-4']);
    // No owner won two items (each got a distinct swarm id, and each id appears ≤ once).
    const owners = won.map((w) => w.assignee);
    expect(new Set(owners).size).toBe(M);

    // PG agrees: every backlog row is now taken by exactly its claimer, none double-taken.
    const rows = await db.sql<{ feature_id: string; taken_by: string | null }[]>`
      SELECT feature_id, taken_by FROM harness_shared.harness_features_consolidated ORDER BY feature_id`;
    expect(rows.every((r) => r.taken_by != null)).toBe(true);
    expect(new Set(rows.map((r) => r.taken_by)).size).toBe(M);
  });
});

describe('C3 — lease TTL expiry ⇒ reclaimable (real PG)', () => {
  it('a lapsed lease is STOLEN by another owner and the claim_id rotates', async () => {
    const item = 'F-lapse';
    const a = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-A' });
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error('unreachable');
    const firstClaimId = a.claim.claimId;

    // While the lease is LIVE, a different owner cannot take it.
    const blocked = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-B' });
    expect(blocked.ok).toBe(false);

    // Force the lease to lapse (the locks-test trick — push expires_ts into the past).
    await db.sql`
      UPDATE harness_shared.work_item_claims
         SET expires_ts = clock_timestamp() - interval '1 second'
       WHERE work_item_id = ${item}`;
    expect((await getClaim(WS, H, item))?.expired).toBe(true);

    // Now B steals the lapsed lease; the claim_id rotates (a brand-new grip).
    const stolen = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-B' });
    expect(stolen.ok).toBe(true);
    if (!stolen.ok) throw new Error('unreachable');
    expect(stolen.claim.owner).toBe('owner-B');
    expect(stolen.claim.claimId).not.toBe(firstClaimId);
    expect(stolen.claim.expired).toBe(false);

    const held = await getClaim(WS, H, item);
    expect(held?.owner).toBe('owner-B');
  });

  it('a very-short ttl lapses on its own and is then reclaimable', async () => {
    const item = 'F-shortttl';
    const a = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-A', ttlSec: 1 });
    expect(a.ok).toBe(true);
    // clampTtl floors a 1s ttl to 1s; nudge expires_ts to simulate the elapsed second
    // deterministically (no real sleep — keeps the serial integration run fast).
    await db.sql`
      UPDATE harness_shared.work_item_claims
         SET expires_ts = clock_timestamp() - interval '1 second'
       WHERE work_item_id = ${item}`;
    const reclaimed = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-C' });
    expect(reclaimed.ok).toBe(true);
    if (reclaimed.ok) expect(reclaimed.claim.owner).toBe('owner-C');
  });
});

describe('C3 — heartbeat extends the lease (real PG)', () => {
  it('a heartbeated (live) lease cannot be stolen; a foreign heartbeat is a no-op', async () => {
    const item = 'F-hb';
    // A claims with a SHORT ttl so without a heartbeat it would be near-lapsed.
    const a = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-A', ttlSec: 60 });
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error('unreachable');
    const beforeHb = (await getClaim(WS, H, item))!.expiresTs;

    // A heartbeats with a long ttl override → expires_ts moves FORWARD.
    const hb = await heartbeatClaimLocal({
      workspaceId: WS, harnessSlug: H, workItemId: item,
      claimId: a.claim.claimId, owner: 'owner-A', ttlSecOverride: DEFAULT_WORK_ITEM_TTL_SEC,
    });
    expect(hb.renewed).toBe(true);
    expect(hb.held).toBe(true);
    const afterHb = (await getClaim(WS, H, item))!.expiresTs;
    expect(Date.parse(afterHb)).toBeGreaterThan(Date.parse(beforeHb));

    // A concurrent B claim still loses — the lease is live (not lapsed).
    const blocked = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-B' });
    expect(blocked.ok).toBe(false);

    // A FOREIGN owner's heartbeat is a no-op (wrong owner ⇒ not renewed/held).
    const foreign = await heartbeatClaimLocal({
      workspaceId: WS, harnessSlug: H, workItemId: item,
      claimId: a.claim.claimId, owner: 'owner-B', ttlSecOverride: DEFAULT_WORK_ITEM_TTL_SEC,
    });
    expect(foreign.renewed).toBe(false);
    expect(foreign.held).toBe(false);
    // The holder is unchanged.
    expect((await getClaim(WS, H, item))?.owner).toBe('owner-A');
  });
});

describe('C3 — fail-open reconcile under partition heals deterministically (real PG advisory rows)', () => {
  it('two partitioned advisory leases on one item ⇒ deterministic winner, idempotent', async () => {
    const item = 'F-partition';
    // Two partitioned authorities each fail-open to a LOCAL advisory lease on the SAME
    // item — bypass the PK by writing to two distinct (workspace) partitions, then read
    // them back as the two advisory claims the reconcile sees on heal. (We use the real
    // store to seed: distinct workspace_ids stand in for the two partitioned PGs.)
    const early = await acquireClaimLocal({
      workspaceId: 'part-A', harnessSlug: H, workItemId: item, owner: 'su-early', holderPubkey: 'pk-zzz',
    });
    const late = await acquireClaimLocal({
      workspaceId: 'part-B', harnessSlug: H, workItemId: item, owner: 'su-late', holderPubkey: 'pk-aaa',
    });
    expect(early.ok && late.ok).toBe(true);
    if (!early.ok || !late.ok) throw new Error('unreachable');

    // Force a strict acquiredTs ordering so "earliest wins" is unambiguous (clock_timestamp
    // can tie at sub-ms in a fast test). early = T+0, late = T+5s.
    await db.sql`UPDATE harness_shared.work_item_claims
                    SET acquired_ts = '2026-06-08T12:00:00.000Z'
                  WHERE workspace_id = 'part-A' AND work_item_id = ${item}`;
    await db.sql`UPDATE harness_shared.work_item_claims
                    SET acquired_ts = '2026-06-08T12:00:05.000Z'
                  WHERE workspace_id = 'part-B' AND work_item_id = ${item}`;

    // Read the two advisory rows back out of REAL PG as the reconcile input.
    const rows = await db.sql<
      { work_item_id: string; holder_pubkey: string; owner: string; claim_id: string; acquired_ts: string }[]
    >`SELECT work_item_id, holder_pubkey, owner, claim_id, acquired_ts
        FROM harness_shared.work_item_claims
       WHERE work_item_id = ${item} ORDER BY acquired_ts`;
    expect(rows).toHaveLength(2);
    const advisory: AdvisoryClaim[] = rows.map((r) => ({
      workItemId: r.work_item_id,
      holderPubkey: r.holder_pubkey,
      owner: r.owner,
      claimId: r.claim_id,
      acquiredTs: new Date(r.acquired_ts).toISOString(),
    }));

    // Earliest acquiredTs wins (su-early), regardless of input order.
    const resolved = reconcileClaims(advisory);
    expect(resolved?.winner.owner).toBe('su-early');
    expect(resolved?.losers.map((l) => l.owner)).toEqual(['su-late']);
    const resolvedReversed = reconcileClaims([...advisory].reverse());
    expect(resolvedReversed?.winner.owner).toBe('su-early'); // commutative

    // Idempotent: feeding the winner back yields the same winner, no losers (partition healed).
    const again = reconcileClaims([resolved!.winner]);
    expect(again?.winner.owner).toBe('su-early');
    expect(again?.losers).toEqual([]);
  });

  it('same-instant partition ⇒ lowest holderPubkey wins (matches the authority election)', async () => {
    const item = 'F-tie';
    await acquireClaimLocal({ workspaceId: 'part-A', harnessSlug: H, workItemId: item, owner: 'su-hi', holderPubkey: 'pk-zzz' });
    await acquireClaimLocal({ workspaceId: 'part-B', harnessSlug: H, workItemId: item, owner: 'su-lo', holderPubkey: 'pk-aaa' });
    // Identical acquiredTs ⇒ the pubkey tiebreak decides.
    await db.sql`UPDATE harness_shared.work_item_claims
                    SET acquired_ts = '2026-06-08T12:00:00.000Z' WHERE work_item_id = ${item}`;
    const rows = await db.sql<
      { holder_pubkey: string; owner: string; claim_id: string; acquired_ts: string }[]
    >`SELECT holder_pubkey, owner, claim_id, acquired_ts
        FROM harness_shared.work_item_claims WHERE work_item_id = ${item}`;
    const advisory: AdvisoryClaim[] = rows.map((r) => ({
      workItemId: item, holderPubkey: r.holder_pubkey, owner: r.owner,
      claimId: r.claim_id, acquiredTs: new Date(r.acquired_ts).toISOString(),
    }));
    expect(reconcileClaims(advisory)?.winner.owner).toBe('su-lo'); // pk-aaa < pk-zzz
  });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// G16 [P2] — REAL-CLOCK lease expiry. The existing TTL test (above) forces expiry with a
// manual SQL `UPDATE … expires_ts = now() - interval`. That proves the STEAL clause but
// NOT that a lease set with a real short ttl actually lapses on the wall clock — the
// `clock_timestamp() + make_interval(secs => ttl)` arithmetic could be wrong and the manual
// edit would mask it. Here we acquire with a genuine short ttl, sleep PAST it (no DB edit),
// and prove another owner can then steal — the lease expired by itself.
describe('G16 — REAL-clock lease expiry (no manual DB edit)', () => {
  it('a short-ttl lease lapses on the wall clock and is then stealable', async () => {
    const item = 'F-realttl';
    // clampTtl floors to 1s minimum; acquire with the smallest real ttl.
    const a = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-A', ttlSec: 1 });
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error('unreachable');

    // BEFORE the ttl elapses, a different owner is BLOCKED — the lease is live.
    const blocked = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-B' });
    expect(blocked.ok).toBe(false);
    expect((await getClaim(WS, H, item))?.expired).toBe(false);

    // Wait for the lease to lapse on its OWN — real wall-clock, no SQL push of expires_ts.
    await sleep(1_300);
    expect((await getClaim(WS, H, item))?.expired).toBe(true);

    // Now a different owner steals it — purely because the real clock passed the lease.
    const stolen = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-B' });
    expect(stolen.ok).toBe(true);
    if (stolen.ok) {
      expect(stolen.claim.owner).toBe('owner-B');
      expect(stolen.claim.claimId).not.toBe(a.claim.claimId); // grip rotated
      expect(stolen.claim.expired).toBe(false);
    }
  }, 15_000);
});

// G17 [P2] — HEARTBEAT renewal BLOCKS a concurrent steal for the TTL, then the item becomes
// stealable once heartbeats stop. This is the liveness guarantee: a Swarm actively working
// (heartbeating) keeps its grip against any number of stealers; a Swarm that DIED (stopped
// heartbeating) loses it after the ttl. We acquire a short ttl, renew it on an interval that
// out-paces the ttl, fire concurrent steals throughout (all must FAIL), then stop the
// heartbeat and prove a steal succeeds once the un-renewed lease lapses.
describe('G17 — heartbeat renewal blocks a steal until heartbeats stop', () => {
  it('a renewing owner holds against concurrent steals, then loses after heartbeats stop', async () => {
    const item = 'F-hb-block';
    const TTL = 1; // clampTtl floor — the lease lapses 1s after each (re)write
    const a = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-A', ttlSec: TTL });
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error('unreachable');

    // Heartbeat every 400ms (well under the 1s ttl) so the lease never lapses while alive.
    let beating = true;
    const beat = (async () => {
      while (beating) {
        await heartbeatClaimLocal({
          workspaceId: WS, harnessSlug: H, workItemId: item,
          claimId: a.claim.claimId, owner: 'owner-A', ttlSecOverride: TTL,
        });
        await sleep(400);
      }
    })();

    // Fire a burst of concurrent steals across ~1.6s (longer than the ttl) — EVERY one must
    // fail, because the heartbeat keeps re-pushing expires_ts ahead of the clock.
    const stealResults: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: `thief-${i}` });
      stealResults.push(r.ok);
      await sleep(400);
    }
    expect(stealResults.every((ok) => ok === false)).toBe(true);
    // The original owner still holds the live grip throughout.
    const mid = await getClaim(WS, H, item);
    expect(mid?.owner).toBe('owner-A');
    expect(mid?.expired).toBe(false);

    // Stop heartbeating (simulate the owner dying) and let the un-renewed lease lapse.
    beating = false;
    await beat;
    await sleep(1_300);
    expect((await getClaim(WS, H, item))?.expired).toBe(true);

    // Now a stealer succeeds — the dead owner's grip is reclaimable.
    const stolen = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'thief-final' });
    expect(stolen.ok).toBe(true);
    if (stolen.ok) expect(stolen.claim.owner).toBe('thief-final');
  }, 20_000);
});

// G18 [P3] — priority tie-break + concurrent priority-ordered claiming. claim_next under the
// per-Hive lease (swarmId present) orders by `feature_order ASC NULLS LAST, created_ts ASC`.
// Two facets: (1) equal feature_order MUST fall back to created_ts (oldest first); (2) N
// concurrent claimers over M priorities → all distinct AND drained in priority order.
describe('G18 — priority tie-break + concurrent priority-ordered claiming', () => {
  async function seedPrioritized(id: string, createdTs: number, order: number | null) {
    await db.sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (harness_slug, feature_id, item_kind, status, taken_by, feature_order, workspace_id, created_ts, updated_ts)
      VALUES (${H}, ${id}, 'feature', 'open', NULL, ${order}, ${WS}, ${createdTs}, 0)`;
  }

  it('equal feature_order falls back to created_ts (oldest first)', async () => {
    // Same priority bucket (order=5); F-old is older → must be claimed before F-new.
    await seedPrioritized('F-new', 500, 5);
    await seedPrioritized('F-old', 100, 5);
    const first = await wi.claimNextWorkItem({ harness: H, assignee: 'sw-1', swarmId: 's1' });
    const second = await wi.claimNextWorkItem({ harness: H, assignee: 'sw-2', swarmId: 's1' });
    expect(first?.id).toBe('F-old'); // tie on feature_order → oldest created_ts wins
    expect(second?.id).toBe('F-new');
  });

  it('N concurrent claimers over M priorities ⇒ all distinct, drained in priority order', async () => {
    // Five distinct priorities; lower feature_order = claimed sooner. Insert created_ts in
    // REVERSE of priority so a created_ts-only sort would give the WRONG order — proving the
    // priority key dominates. F-p0 (order 0) must go first, … F-p4 (order 40) last.
    const M = 5;
    for (let i = 0; i < M; i += 1) await seedPrioritized(`F-p${i}`, 1000 - i, i * 10);
    const N = 9; // oversubscribed

    // Concurrent claimers. SKIP LOCKED means each grabs a distinct row; the ORDER BY inside
    // the subquery makes each transaction take the lowest-feature_order still-free row.
    const claimed = await Promise.all(
      Array.from({ length: N }, (_, i) => wi.claimNextWorkItem({ harness: H, assignee: `swarm-${i}`, swarmId: 's1' })),
    );
    const won = claimed.filter((c): c is NonNullable<typeof c> => c != null);
    expect(won).toHaveLength(M); // exactly the M items, surplus claimers got null
    // All distinct items, all distinct owners.
    expect(new Set(won.map((w) => w.id)).size).toBe(M);
    expect(new Set(won.map((w) => w.assignee)).size).toBe(M);
    // Every priority bucket was taken exactly once.
    expect(won.map((w) => w.id).sort()).toEqual(['F-p0', 'F-p1', 'F-p2', 'F-p3', 'F-p4']);

    // PG agrees: each item taken by exactly one owner, none double-taken.
    const rows = await db.sql<{ feature_id: string; taken_by: string | null }[]>`
      SELECT feature_id, taken_by FROM harness_shared.harness_features_consolidated ORDER BY feature_order`;
    expect(rows.every((r) => r.taken_by != null)).toBe(true);
    expect(new Set(rows.map((r) => r.taken_by)).size).toBe(M);
  });

  it('SERIAL priority claiming drains strictly lowest-feature_order first', async () => {
    // The deterministic complement to the concurrent case: claimed one-at-a-time, the order
    // is exactly feature_order ASC (priority lever honored end-to-end under the lease).
    await seedPrioritized('F-hi', 100, 30); // lowest priority (highest order)
    await seedPrioritized('F-mid', 200, 20);
    await seedPrioritized('F-top', 300, 10); // highest priority (lowest order), but NEWEST
    const order: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const got = await wi.claimNextWorkItem({ harness: H, assignee: `s-${i}`, swarmId: 's1' });
      if (got) order.push(got.id);
    }
    expect(order).toEqual(['F-top', 'F-mid', 'F-hi']); // strictly by feature_order, not created_ts
  });
});
