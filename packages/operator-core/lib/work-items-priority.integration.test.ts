/**
 * work-items-priority.integration.test.ts — the Queen's steer-don't-dispatch BACKLOG
 * priority lever against real Postgres (autoloop-pot-operator-rebuild B7 /
 * decentralized-dispatch-scaling D-003/D-004, P-009/P-010).
 *
 * Proves:
 *   • setWorkItemPriority / getWorkItemPriority round-trip `feature_order` (set, read, clear).
 *   • bumpWorkItemPriority { 'top' | 'bottom' } moves an item just past the current
 *     extreme; an empty/all-null backlog ⇒ 0.
 *   • claimNextWorkItem RESPECTS a just-set priority WHEN swarmId is passed (the
 *     per-Hive-lease path), and IGNORES it on the single-instance default — the
 *     steering→dispatch wiring (P-010), mirroring the affinity test.
 *   • issue-family items (bugs/changes) are a no-op (`applicable: false`) — they aren't
 *     the dispatched backlog.
 *   • the work_items:set_priority tool: read / explicit-set / clear / bump / not-found.
 *
 * Mirrors work-items-swarm-affinity.integration.test.ts's schema bootstrap.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps } from '../test/_work-items-schema';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

// Canonical complete consolidated-features schema (single source of truth, incl.
// feature_order + swarm_affinity) — see test/_work-items-schema.ts (D-014).
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

const wi = await import('./work-items');
const setPriorityTool = (await import('./agent-tools/work_items/set_priority')).default;
// work_items:set_priority is bulk-standardized (bulk-endpoint-standardization-2026-06-21):
// it returns the keyed-array envelope { ok, results:[{ ok, workItem, mode, … | error }],
// counts }. Every call below is single-item, so the n=1 result is results[0] — return it
// directly so the per-mode assertions (mode/action/priority/ok) read naturally.
const runSetPriority = async (args: Record<string, unknown>) => {
  // work_items:set_priority is bulk (P-006): the handler returns { data: envelope }.
  const env = (
    await (
      setPriorityTool as unknown as {
        handler: (a: unknown, c: unknown) => Promise<{ data: any }>;
      }
    ).handler(args, { log() {}, workspaceId: 'default', role: 'operator' })
  ).data;
  return env.results[0];
};
const H = 'papercup';
let db: FreshPgDb;

async function seedFeature(
  id: string,
  opts: { createdTs?: number; order?: number | null; takenBy?: string | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, feature_order, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', 'open', ${opts.takenBy ?? null}, ${opts.order ?? null}, 'default', ${opts.createdTs ?? 0}, 0)`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-priority');
  h.sql = db.sql;
  await db.sql.unsafe(HFC_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple()); // trust list, deps, adv_sessions, event tables (WI-10005130)
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.harness_features_consolidated`;
  await db.sql`DELETE FROM harness_shared.engineer_issues`;
});

describe('P-011 single-steerer lease gates the priority write (D-004)', () => {
  const lease = () => import('./steering-lease');
  afterEach(async () => (await lease()).__setSteeringLeaseTestDeps(null));

  it('a NON-HOLDER steer is withheld: no write, proposed result, sinks fired', async () => {
    await seedFeature('F-1', { createdTs: 100, order: 7 });
    const comments: { featureId: string; body: string }[] = [];
    const escalations: { summary: string }[] = [];
    (await lease()).__setSteeringLeaseTestDeps({
      resolveHive: async () => 'the-hive',
      // P-021 queen-home gate (steering-lease.ts): its default resolveQueenHome does a
      // PG read (hive-settings-store) the throwaway DB lacks → it would throw → the
      // lease fails OPEN (holder:true) and the non-holder steer wrongly commits. Inject
      // the common production case: no recorded queen home → fall through to the
      // authority election (the injected hiveAuthority below decides the holder).
      resolveQueenHome: async () => null,
      hiveAuthority: async () => ({
        isSelf: false,
        liveCount: 2,
        peer: { devicePubkey: 'pk-remote', githubUserId: 1, machineLabel: 'box-b' },
      }),
      comment: async (c) => void comments.push(c),
      escalate: async (e) => void escalations.push(e),
    });
    const res = await wi.setWorkItemPriority('F-1', 1, { harness: H });
    expect(res).toMatchObject({
      id: 'F-1',
      priority: 7, // the STORED value — the requested 1 was not committed
      applicable: true,
      proposed: true,
      steeringHolder: 'box-b',
    });
    expect((await wi.getWorkItemPriority('F-1', { harness: H }))?.priority).toBe(7);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('feature_order=1');
    expect(escalations).toHaveLength(1);
    // bump routes through the same chokepoint — also withheld.
    const bumped = await wi.bumpWorkItemPriority('F-1', 'top', { harness: H });
    expect(bumped?.proposed).toBe(true);
    expect((await wi.getWorkItemPriority('F-1', { harness: H }))?.priority).toBe(7);
  });

  it('the HOLDER commits exactly as before (and fail-open keeps committing)', async () => {
    await seedFeature('F-1', { createdTs: 100 });
    (await lease()).__setSteeringLeaseTestDeps({
      resolveHive: async () => 'the-hive',
      hiveAuthority: async () => ({ isSelf: true, liveCount: 2 }),
    });
    const res = await wi.setWorkItemPriority('F-1', 5, { harness: H });
    expect(res).toMatchObject({ priority: 5, applicable: true });
    expect(res?.proposed).toBeUndefined();

    // Fail-open (election unavailable) — the steer still commits (D-004).
    (await lease()).__setSteeringLeaseTestDeps({
      resolveHive: async () => 'the-hive',
      hiveAuthority: async () => {
        throw new Error('presence outage');
      },
    });
    expect((await wi.setWorkItemPriority('F-1', 9, { harness: H }))?.priority).toBe(9);
  });
});

describe('setWorkItemPriority / getWorkItemPriority', () => {
  it('round-trips feature_order: set → read → clear', async () => {
    await seedFeature('F-1', { createdTs: 100 });
    expect((await wi.getWorkItemPriority('F-1', { harness: H }))?.priority).toBeNull();

    const set = await wi.setWorkItemPriority('F-1', 5, { harness: H });
    expect(set).toMatchObject({ id: 'F-1', priority: 5, applicable: true });
    expect((await wi.getWorkItemPriority('F-1', { harness: H }))?.priority).toBe(5);

    const cleared = await wi.setWorkItemPriority('F-1', null, { harness: H });
    expect(cleared).toMatchObject({ priority: null, applicable: true });
    expect((await wi.getWorkItemPriority('F-1', { harness: H }))?.priority).toBeNull();
  });

  it('returns null for a missing item', async () => {
    expect(await wi.setWorkItemPriority('F-nope', 1, { harness: H })).toBeNull();
    expect(await wi.getWorkItemPriority('F-nope', { harness: H })).toBeNull();
  });
});

describe('bumpWorkItemPriority', () => {
  it("'top'/'bottom' on an empty backlog ⇒ 0", async () => {
    await seedFeature('F-1', { createdTs: 100 });
    expect((await wi.bumpWorkItemPriority('F-1', 'top', { harness: H }))?.priority).toBe(0);
    // F-1 is now the only item with an order (0); 'bottom' relative to NO OTHERS ⇒ 0 again.
    expect((await wi.bumpWorkItemPriority('F-1', 'bottom', { harness: H }))?.priority).toBe(0);
  });

  it("'top' = min−1, 'bottom' = max+1 over the OTHER items", async () => {
    await seedFeature('F-1', { createdTs: 100, order: 10 });
    await seedFeature('F-2', { createdTs: 200, order: 20 });
    await seedFeature('F-3', { createdTs: 300 });

    const top = await wi.bumpWorkItemPriority('F-3', 'top', { harness: H });
    expect(top?.priority).toBe(9); // min(10,20) − 1

    const bottom = await wi.bumpWorkItemPriority('F-3', 'bottom', { harness: H });
    expect(bottom?.priority).toBe(21); // max(10,20) + 1 (F-3 itself excluded)
  });
});

describe('claimNextWorkItem honours the Queen priority only under the lease (P-010)', () => {
  it('IGNORES feature_order on the single-instance default (no swarmId) — oldest-first', async () => {
    await seedFeature('F-1', { createdTs: 100 }); // oldest, unprioritized
    await seedFeature('F-2', { createdTs: 200, order: -5 }); // newer but top-priority
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-x' });
    expect(got?.id).toBe('F-1'); // priority NOT consulted without a swarmId
  });

  it('RESPECTS feature_order when swarmId is set (the per-Hive lease path)', async () => {
    await seedFeature('F-1', { createdTs: 100 }); // oldest, unprioritized (sorts last)
    await seedFeature('F-2', { createdTs: 200, order: -5 }); // newer but promoted
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-x', swarmId: 's1' });
    expect(got?.id).toBe('F-2'); // lower feature_order wins over older created_ts
  });

  it('a claim now picks up an item the Queen just bumped to the top', async () => {
    await seedFeature('F-old', { createdTs: 100 });
    await seedFeature('F-hot', { createdTs: 999 }); // newest, would normally be claimed last
    await wi.bumpWorkItemPriority('F-hot', 'top', { harness: H });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-x', swarmId: 's1' });
    expect(got?.id).toBe('F-hot');
  });
});

describe('issue-family is a no-op (not the dispatched backlog)', () => {
  // This describes the FEATURE-ONLY world (SCHEDULER_ISSUES_CLAIMABLE OFF). The flag now defaults ON
  // (issues self-pickable + steerable, owner-ratified P-007), so pin it OFF to assert the kill-switch
  // path stays byte-identical. (The ON behavior is covered by claim-issues-claimable.)
  beforeEach(() => setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: false }));
  afterEach(() => setFlagOverridesForTest({}));

  it('returns applicable:false and writes nothing', async () => {
    await db.sql`
      INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, title)
      VALUES ('default', 'EI-1', 'a bug')`;
    const set = await wi.setWorkItemPriority('EI-1', 3, { harness: H });
    expect(set).toMatchObject({ id: 'EI-1', priority: null, applicable: false });
    const read = await wi.getWorkItemPriority('EI-1', { harness: H });
    expect(read).toMatchObject({ priority: null, applicable: false });
  });
});

describe('priority surfaces on the unified WorkItem (the work_items:list/get field)', () => {
  it('getWorkItem / listWorkItems carry feature_order as `priority`; unprioritized is null', async () => {
    await seedFeature('F-1', { createdTs: 100, order: 7 });
    await seedFeature('F-2', { createdTs: 200 }); // unprioritized
    await db.sql`
      INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, title)
      VALUES ('default', 'EI-1', 'a bug')`;

    // get — the Queen reads any one item's backlog priority off the unified shape.
    expect((await wi.getWorkItem('F-1', H))?.priority).toBe(7);
    expect((await wi.getWorkItem('F-2', H))?.priority).toBeNull();
    expect((await wi.getWorkItem('EI-1', H))?.priority).toBeNull(); // never explicitly prioritized

    // list — the Queen sees the whole backlog's order in one call (the B7 deferred follow-up).
    const listed = await wi.listWorkItems({ harness: H });
    expect(listed.find((w) => w.id === 'F-1')?.priority).toBe(7);
    expect(listed.find((w) => w.id === 'F-2')?.priority).toBeNull();
  });

  // EI-10421: `setWorkItemPriority` writes `feature_order` on the `work_items` base row for
  // issue-family items too (P-007/EI-7407), and `claimNextIssueWorkItem`'s claim order already
  // read it unconditionally — but the READ side (issueToWorkItem, backed by the
  // `engineer_issues` view) never surfaced it: the view didn't select `feature_order` and
  // `issueToWorkItem` hardcoded `priority: null`. So a caller who wrote a priority via
  // `work_items:set_priority` (confirmed `written:true`) and then read it back via
  // `work_items:get`/`work_items:list` always saw `priority: null` — indistinguishable from a
  // silent no-op even though the write AND the claim ordering were both already correct
  // (migration 588 + this fix close the read-side gap).
  it('an EXPLICITLY prioritized issue-family item surfaces its priority on get/list too', async () => {
    // scope must resolve to this harness (harness:<H>) — `listWorkItems({ harness })`
    // filters issue-family rows by scope, and a scope-less insert defaults to the
    // global 'operator' scope, which `listed.find(...)` would never match.
    await db.sql`
      INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, title, scope)
      VALUES ('default', 'EI-2', 'a prioritized bug', ${'harness:' + H})`;
    const set = await wi.setWorkItemPriority('EI-2', 12, { harness: H });
    expect(set).toMatchObject({ priority: 12, applicable: true });

    expect((await wi.getWorkItem('EI-2', H))?.priority).toBe(12);
    const listed = await wi.listWorkItems({ harness: H });
    expect(listed.find((w) => w.id === 'EI-2')?.priority).toBe(12);
  });
});

describe('work_items:set_priority tool', () => {
  it('read mode reports the current backlog priority without writing', async () => {
    await seedFeature('F-1', { createdTs: 100, order: 7 });
    const r = await runSetPriority({ workItem: 'F-1', harness: H });
    expect(r).toMatchObject({ ok: true, mode: 'read', workItem: 'F-1', priority: 7, applicable: true });
  });

  it('explicit mode sets the order, and null clears it', async () => {
    await seedFeature('F-1', { createdTs: 100 });
    const set = await runSetPriority({ workItem: 'F-1', harness: H, priority: 3 });
    expect(set).toMatchObject({ ok: true, mode: 'set', action: 'set', priority: 3 });
    expect((await wi.getWorkItemPriority('F-1', { harness: H }))?.priority).toBe(3);

    const cleared = await runSetPriority({ workItem: 'F-1', harness: H, priority: null });
    expect(cleared).toMatchObject({ ok: true, action: 'clear', priority: null });
  });

  it('bump mode moves to the head of the backlog', async () => {
    await seedFeature('F-1', { createdTs: 100, order: 0 });
    await seedFeature('F-2', { createdTs: 200 });
    const r = await runSetPriority({ workItem: 'F-2', harness: H, position: 'top' });
    expect(r).toMatchObject({ ok: true, mode: 'bump', action: 'top', priority: -1 });
  });

  it('reports not-found for a missing item', async () => {
    const r = await runSetPriority({ workItem: 'F-nope', harness: H, priority: 1 });
    expect(r.ok).toBe(false);
  });
});
