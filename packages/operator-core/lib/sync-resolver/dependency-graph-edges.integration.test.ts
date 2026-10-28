/**
 * dependency-graph-edges.integration.test.ts — the graph pane's edge seam, against real SQL.
 *
 * Plan: dependency-health-pane-2026-08-02 (P-003).
 *
 * WHY INTEGRATION AND NOT A UNIT TEST. Every property worth asserting here is a property of a
 * JOIN — specifically of endpoint resolution, where the ref FORM depends on the family of the
 * row being pointed at. A mock would encode the author's belief about that convention, which
 * is the belief under test, and it is precisely the belief the D-017 incident proved wrong in
 * production: six edges that were form-valid, mirrored and acyclic, and joined nothing.
 *
 * ⚠ THE FIXTURE MUST NOT RESTATE THE CONVENTION. `canonicalRef` (dependency-fixture.ts) encodes
 * INV-01, so building a row with it and asserting the row matches it proves only that a pure
 * function agrees with itself. The refs below are therefore written LITERALLY — 'papercup#F-1'
 * and a bare 'EI-1' — so a test failure means the RESOLVER disagrees with the stored
 * convention, not that two copies of my own belief disagree.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   npm run test:file -- packages/operator-core/lib/sync-resolver/dependency-graph-edges.integration.test.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { EVENT_AWAITS_MIN_DDL, HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { fireCertifiesCondition } from '../external-condition-reachability';
import {
  resolveDependencyGraphEdges,
  resolveDependencyGraphWaits,
  DEP_EDGES_MAX_LIMIT,
  DEP_WAITS_LIMITS,
  DEP_WAITS_PER_HOLDER,
} from './dependency-graph-edges';

const WS = 'papercusp-workspace';
const H = 'papercup';
/** The coordination workspace every edge row lives in — NOT the item workspace. */
const COORD = 'default';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('dependency-graph-edges');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(EVENT_AWAITS_MIN_DDL).simple();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

/** `kind` is a REAL item_kind value — the engine derives family from it, never from a name. */
async function item(
  id: string,
  kind: 'feature' | 'bug' | 'change' | 'task',
  opts: { status?: string; harness?: string; workspace?: string; planSlug?: string } = {},
): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, title, status, item_kind, workspace_id, taken_by, created_ts, updated_ts, payload,
       source_plan_slug)
    VALUES (${opts.harness ?? H}, ${id}, ${`item ${id}`}, ${opts.status ?? 'open'}, ${kind},
            ${opts.workspace ?? WS}, NULL, 0, 0, '{}'::jsonb,
            ${opts.planSlug ?? null})`;
}

/** Refs are written LITERALLY — see the header's note on not restating the convention. */
async function edge(
  blockedKind: 'feature' | 'issue',
  blockedRef: string,
  blockerKind: 'feature' | 'issue',
  blockerRef: string,
  workspace = COORD,
): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${workspace}, ${blockedKind}, ${blockedRef}, ${blockerKind}, ${blockerRef}, 'blocks')`;
}

const edges = () => resolveDependencyGraphEdges(db.sql, { workspaceId: WS, harnessSlug: H });

describe('resolveDependencyGraphEdges — family-aware endpoint resolution', () => {
  it('resolves a FEATURE endpoint by its harness-QUALIFIED ref', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);

    expect(await edges()).toEqual([
      expect.objectContaining({ blockedId: 'F-1', blockerId: 'F-2', blockedKind: 'feature', blockerKind: 'feature' }),
    ]);
  });

  it('resolves an ISSUE endpoint by its BARE ref', async () => {
    await item('EI-1', 'bug');
    await item('EI-2', 'task');
    await edge('issue', 'EI-1', 'issue', 'EI-2');

    expect(await edges()).toEqual([
      expect.objectContaining({ blockedId: 'EI-1', blockerId: 'EI-2', blockedKind: 'bug', blockerKind: 'task' }),
    ]);
  });

  // THE D-017 CASE. A join matching only one ref form drops every mixed-family edge, and
  // mixed-family is the common shape in real data — a feature blocked by a bug.
  it('resolves MIXED-family edges in BOTH directions — the D-017 shape', async () => {
    await item('F-1', 'feature');
    await item('EI-1', 'bug');
    await edge('feature', `${H}#F-1`, 'issue', 'EI-1'); // feature blocked BY an issue
    await edge('issue', 'EI-1', 'feature', `${H}#F-1`); // …and the reverse

    const got = await edges();
    expect(got).toHaveLength(2);
    expect(got).toContainEqual(expect.objectContaining({ blockedId: 'F-1', blockerId: 'EI-1' }));
    expect(got).toContainEqual(expect.objectContaining({ blockedId: 'EI-1', blockerId: 'F-1' }));
  });

  // NEGATIVE CONTROL for the two above: had the resolver matched refs family-BLIND (e.g. bare
  // on both sides), THIS row would resolve — and it must not. Without it, the passing tests
  // above are also satisfied by a resolver that ignores the convention entirely.
  it('does NOT resolve a feature endpoint written in the BARE (issue) form', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await edge('feature', 'F-1', 'feature', 'F-2'); // both bare — wrong form for features

    expect(await edges()).toEqual([]);
  });
});

describe('resolveDependencyGraphEdges — what it deliberately KEEPS', () => {
  // An INNER join on the blocker would hide exactly the broken edges the integrity mode exists
  // to show. `blockerId: null` is the UI's handle on a dangling ref (INV-13).
  it('RETURNS a dangling edge with blockerId null rather than dropping it', async () => {
    await item('F-1', 'feature');
    await edge('feature', `${H}#F-1`, 'issue', 'EI-does-not-exist');

    expect(await edges()).toEqual([
      expect.objectContaining({ blockedId: 'F-1', blockerId: null, blockerRef: 'EI-does-not-exist' }),
    ]);
  });

  /**
   * WI-36045 — the endpoint fields that make an edge drawable without the list's window.
   *
   * These are not cosmetic: `workItems.byHarness` is a 500-row recency window over ~48k rows,
   * so before these columns existed the pane discarded 78 of 79 real papercusp edges and drew
   * 2 nodes. The graph builds a NODE from these values, so a null here is a blank node.
   */
  it('carries the BLOCKED endpoint fields so a node can be built without the list page', async () => {
    await item('F-1', 'feature', { status: 'open', planSlug: 'my-plan' });
    await item('F-2', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);

    expect((await edges())[0]).toMatchObject({
      blockedId: 'F-1',
      blockedTitle: 'item F-1',
      blockedStatus: 'open',
      blockedPlanSlug: 'my-plan',
    });
  });

  it('carries the BLOCKER endpoint fields too — the failure was symmetric', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature', { status: 'done', planSlug: 'blocker-plan' });
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);

    expect((await edges())[0]).toMatchObject({
      blockerId: 'F-2',
      blockerTitle: 'item F-2',
      blockerPlanSlug: 'blocker-plan',
    });
  });

  it('leaves the blocker endpoint fields NULL for a dangling edge, without dropping it', async () => {
    // A dangling edge has no blocker row to project from, and that must stay distinguishable
    // from a hydrated one: the UI draws the first as a BREAK and the second as a real item.
    await item('F-1', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#GONE`);

    const [row] = await edges();
    expect(row).toMatchObject({ blockerId: null, blockerTitle: null, blockerPlanSlug: null });
    // The BLOCKED side still hydrates — the edge is renderable as a break off a real node.
    expect(row?.blockedTitle).toBe('item F-1');
  });

  it('reports a NULL plan slug as null, not the string "null"', async () => {
    // The graph branches on truthiness to draw the plan marker, so a stringified null would
    // mark every non-plan item as plan-derived.
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);

    const [row] = await edges();
    expect(row?.blockedPlanSlug).toBeNull();
    expect(row?.blockerPlanSlug).toBeNull();
  });

  it('carries the blocker STATUS so the UI can grey out an already-satisfied edge', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature', { status: 'done' });
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);

    expect((await edges())[0]).toMatchObject({ blockerId: 'F-2', blockerStatus: 'done' });
  });
});

describe('resolveDependencyGraphEdges — scoping', () => {
  // The single most dangerous thing to get wrong here (migration 719's own warning): the EDGE
  // table is keyed in the coordination workspace, the ITEMS are not. Scoping the edge lookup to
  // the item workspace "would match zero rows and disable blocking entirely".
  it('reads edges from the COORDINATION workspace while scoping items to the caller workspace', async () => {
    await item('F-1', 'feature'); // in WS ('papercusp-workspace')
    await item('F-2', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`, COORD); // edge in 'default'

    expect(await edges()).toHaveLength(1);
  });

  it('ignores an edge row written under the WRONG (item) workspace — the inert class', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`, WS); // edge misfiled in the item ws

    expect(await edges()).toEqual([]);
  });

  it('excludes an edge whose BLOCKED item belongs to another harness', async () => {
    await item('F-1', 'feature', { harness: 'other-pot' });
    await item('F-2', 'feature');
    await edge('feature', 'other-pot#F-1', 'feature', `${H}#F-2`);

    expect(await edges()).toEqual([]);
  });

  it('ignores a non-blocks dep_type', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await db.sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      VALUES (${COORD}, 'feature', ${`${H}#F-1`}, 'feature', ${`${H}#F-2`}, 'relates')`;

    expect(await edges()).toEqual([]);
  });
});

describe('resolveDependencyGraphEdges — the limit CLAMPS rather than rejecting', () => {
  // A hard reject turns a client/server version skew into a panel-breaking error; the pane must
  // degrade instead. Same contract as workItems.byHarness.
  it('clamps an over-large limit to the cap instead of throwing', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);

    const got = await resolveDependencyGraphEdges(db.sql, {
      workspaceId: WS,
      harnessSlug: H,
      limit: DEP_EDGES_MAX_LIMIT * 100,
    });
    expect(got).toHaveLength(1);
  });

  it('honours a small limit', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await item('F-3', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-3`);

    expect(
      await resolveDependencyGraphEdges(db.sql, { workspaceId: WS, harnessSlug: H, limit: 1 }),
    ).toHaveLength(1);
  });
});

describe('resolveDependencyGraphEdges — endpoint lookup stays indexed at production scale', () => {
  it('resolves 1,000 edges inside a 20k-item harness under a 750ms database deadline', async () => {
    // WI-42428: the old blocker LEFT JOIN had no indexed feature_id equality. Postgres
    // therefore materialized the whole harness and evaluated the family-aware OR as a
    // join filter for EVERY edge: ~20m row comparisons for this fixture (and ~123m
    // in the 114k-item / 1,082-edge live shape that hit the resolver's 10s timeout).
    //
    // One set-based insert keeps the fixture cheap. The DB-side deadline is the guard:
    // it measures the SQL statement itself (not a scheduler-dependent JS stopwatch) and
    // leaves ample headroom for the indexed plan, which performs two identity lookups per
    // edge while preserving the exact family-aware ref check.
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, status, item_kind, workspace_id, taken_by,
         created_ts, updated_ts, payload)
      SELECT ${H},
             'PERF-' || lpad(g::text, 6, '0'),
             'performance fixture ' || g::text,
             'open',
             'bug',
             ${WS},
             NULL,
             0,
             0,
             '{}'::jsonb
        FROM generate_series(1, 20000) AS g`;

    await db.sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      SELECT ${COORD},
             'issue',
             'PERF-' || lpad(g::text, 6, '0'),
             'issue',
             'PERF-' || lpad((g + 10000)::text, 6, '0'),
             'blocks'
        FROM generate_series(1, 1000) AS g`;

    const got = await db.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '750ms'`);
      return resolveDependencyGraphEdges(tx as unknown as typeof db.sql, {
        workspaceId: WS,
        harnessSlug: H,
      });
    });

    expect(got).toHaveLength(1000);
    expect(got[0]).toMatchObject({ blockedId: 'PERF-000001', blockerId: 'PERF-010001' });
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The WAIT leg (event-wait-settlement-2026-10-20 P-009, D-003). Await rows live in the
// COORDINATION workspace ('default') while items live in the tenant workspace — measured on
// papercusp 2026-10-21: all 1,728 active awaits carry workspace_id 'default'. The fixture keeps
// that split, so a resolver joining on one workspace would return nothing here.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('resolveDependencyGraphWaits — event waits on items', () => {
  beforeEach(async () => {
    await db.sql`TRUNCATE harness_shared.event_awaits`;
  });

  async function heldItem(
    id: string,
    holder: string | null,
    opts: { status?: string; harness?: string; blockers?: unknown[]; payload?: Record<string, unknown> } = {},
  ): Promise<void> {
    const payload = { ...(opts.payload ?? {}), ...(opts.blockers ? { externalBlockers: opts.blockers } : {}) };
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, status, item_kind, workspace_id, taken_by, created_ts, updated_ts, payload)
      VALUES (${opts.harness ?? H}, ${id}, ${`item ${id}`}, ${opts.status ?? 'blocked'}, 'bug', ${WS},
              ${holder}, 0, 0, ${db.sql.json(payload as never)})`;
  }

  async function awaitRow(
    subscriber: string,
    eventKey: string,
    opts: { bound?: { kind: string; ref: string }; policy?: string; note?: string; expiresInSec?: number; firedAt?: boolean } = {},
  ): Promise<void> {
    await db.sql`
      INSERT INTO harness_shared.event_awaits
        (workspace_id, subscriber_id, event_key, policy, note, bound_to, expires_ts, fired_at, once)
      VALUES (${COORD}, ${subscriber}, ${eventKey}, ${opts.policy ?? 'wake'}, ${opts.note ?? null},
              ${opts.bound ? db.sql.json(opts.bound) : null},
              ${opts.expiresInSec == null ? null : new Date(Date.now() + opts.expiresInSec * 1000)},
              ${opts.firedAt ? new Date() : null},
              ${!eventKey.startsWith('coord:inbox-wake:')})`;
  }

  const blocker = (kind: string, ref: string, status: 'active' | 'cleared' = 'active') => ({
    kind, ref, status, summary: `waiting on ${ref}`, createdAt: '2026-10-21T00:00:00.000Z', createdBy: 'su-holder', updatedAt: '2026-10-21T00:00:00.000Z',
  });

  const states = (m: Record<string, SessionState | null>) => ({
    resolveSessionStates: async (ids: readonly string[]) =>
      new Map(ids.filter((id) => id in m).map((id) => [id, m[id] ?? null])),
  });

  const waits = (deps = states({})) => resolveDependencyGraphWaits(db.sql, { workspaceId: WS, harnessSlug: H }, deps);

  it('AUTO-BAR-R-15-P-009: returns the holder\'s await bound to an in-harness item, and its other non-inbox awaits, but never inbox-wake plumbing or announcements', async () => {
    await heldItem('WI-1', 'su-holder');
    await heldItem('WI-OTHER', 'su-holder', { harness: 'some-other-harness' });
    await awaitRow('su-holder', 'work-item:done:WI-2', { bound: { kind: 'work-item-blocked', ref: 'WI-1' } });
    await awaitRow('su-holder', 'release:deployed:abc123def'); // unbound: one of the holder's other waits
    await awaitRow('su-holder', 'coord:inbox-wake:su-holder'); // plumbing — excluded
    await awaitRow('su-holder', 'fleet:alpha:schema-ready', { policy: 'announce' }); // a declaration, not a wait
    await awaitRow('su-holder', 'work-item:done:WI-9', { bound: { kind: 'work-item-blocked', ref: 'WI-OTHER' } }); // other harness
    await awaitRow('su-holder', 'work-item:done:WI-7', { bound: { kind: 'work-item-blocked', ref: 'WI-1' }, firedAt: true }); // already fired

    const got = await waits(states({ 'su-holder': 'live' }));
    const onItem = got.filter((w) => w.itemId === 'WI-1');
    expect(onItem.map((w) => [w.eventKey, w.bound]).sort()).toEqual([
      ['release:deployed:abc123def', false],
      ['work-item:done:WI-2', true],
      // The holder's await bound to an item in ANOTHER harness is still one of the holder's
      // other waits — it explains why this held item is not moving — just not bound to it.
      ['work-item:done:WI-9', false],
    ]);
    expect(onItem.find((w) => w.bound)).toMatchObject({
      waitKind: 'session-await',
      subscriberId: 'su-holder',
      subscriberIsHolder: true,
      boundKind: 'work-item-blocked',
      holderId: 'su-holder',
      certification: 'proving',
      subscriberState: 'live',
      stale: false,
    });
    expect(got.some((w) => w.eventKey.startsWith('coord:inbox-wake:'))).toBe(false);
    expect(got.some((w) => w.eventKey === 'fleet:alpha:schema-ready')).toBe(false);
    expect(got.some((w) => w.itemId === 'WI-OTHER')).toBe(false);
    // A contender parked on the claim is a wait on the item too, marked as not the holder.
    await awaitRow('su-contender', 'claim:released:WI-1', { bound: { kind: 'work-item-claim', ref: 'WI-1' } });
    const again = await waits(states({}));
    expect(again.find((w) => w.subscriberId === 'su-contender')).toMatchObject({ itemId: 'WI-1', bound: true, subscriberIsHolder: false });
  });

  it('AUTO-BAR-R-16-P-009: marks a wait stale when the oracle says its subscriber session ended, or the await expired; not measured is not stale', async () => {
    await heldItem('WI-1', 'su-dead');
    await heldItem('WI-2', 'su-unknown');
    await heldItem('WI-3', 'su-live');
    await awaitRow('su-dead', 'work-item:done:WI-10', { bound: { kind: 'work-item-blocked', ref: 'WI-1' } });
    await awaitRow('su-unknown', 'work-item:done:WI-11', { bound: { kind: 'work-item-blocked', ref: 'WI-2' } });
    await awaitRow('su-live', 'work-item:done:WI-12', { bound: { kind: 'work-item-blocked', ref: 'WI-3' }, expiresInSec: -60 });

    const got = await waits(states({ 'su-dead': 'ended', 'su-live': 'live' }));
    const by = (item: string) => got.find((w) => w.itemId === item && w.bound);
    expect(by('WI-1')).toMatchObject({ subscriberState: 'ended', stale: true, staleReason: 'subscriber-ended' });
    expect(by('WI-2')).toMatchObject({ subscriberState: null, stale: false, staleReason: null });
    expect(by('WI-3')).toMatchObject({ subscriberState: 'live', stale: true, staleReason: 'await-expired' });

    // A liveness failure degrades to not measured, never to a thrown pane.
    const failed = await resolveDependencyGraphWaits(db.sql, { workspaceId: WS, harnessSlug: H }, {
      resolveSessionStates: async () => { throw new Error('oracle down'); },
    });
    expect(failed.every((w) => w.subscriberState === null)).toBe(true);
  });

  it('AUTO-BAR-R-17-P-009: returns an item\'s own active event and gate blockers, not cleared, runtime, or terminal-item ones', async () => {
    await heldItem('WI-1', null, {
      blockers: [
        blocker('event', 'release:deployed:abc123def'),
        blocker('gate', 'fleet:alpha:schema-ready'),
        blocker('event', 'work-item:done:WI-5', 'cleared'),
        blocker('runtime', 'pc-heavy queue'),
      ],
    });
    await heldItem('WI-DONE', null, { status: 'done', blockers: [blocker('event', 'release:deployed:ffff')] });
    await awaitRow('su-leader', 'fleet:alpha:schema-ready', { policy: 'announce' });

    const got = (await waits()).filter((w) => w.waitKind === 'item-blocker');
    expect(got.map((w) => [w.itemId, w.blockerKind, w.eventKey]).sort()).toEqual([
      ['WI-1', 'event', 'release:deployed:abc123def'],
      ['WI-1', 'gate', 'fleet:alpha:schema-ready'],
    ]);
    const gate = got.find((w) => w.blockerKind === 'gate');
    // An announced key is producer-declared, so one fire of it proves the condition.
    expect(gate).toMatchObject({ announced: true, certification: 'proving', subscriberId: null, stale: false });
    expect(got.find((w) => w.blockerKind === 'event')).toMatchObject({ announced: false, since: '2026-10-21T00:00:00.000Z' });
  });

  it('WI-6554700010030344 G-2: returns an item\'s own active runtime and human blockers as item-condition waits, with capability and re-check date, never as event waits', async () => {
    await heldItem('WI-C1', 'su-holder', {
      blockers: [
        { ...blocker('runtime', 'pc-heavy queue'), capability: 'live-dependency', recheckAt: '2026-10-30T00:00:00.000Z' },
        { ...blocker('human', 'owner picks the vendor'), capability: 'product-decision' },
        blocker('runtime', 'an old queue', 'cleared'),
        blocker('event', 'release:deployed:abc123def'),
      ],
    });
    await heldItem('WI-CDONE', null, { status: 'done', blockers: [blocker('runtime', 'pc-heavy queue')] });
    await heldItem('WI-COTHER', null, { harness: 'some-other-harness', blockers: [blocker('human', 'owner picks the vendor')] });
    // An announcement whose key equals a condition's ref must not make the condition "proving":
    // a ref is never looked up as a key.
    await awaitRow('su-leader', 'pc-heavy queue', { policy: 'announce' });
    await awaitRow('su-leader', 'release:deployed:abc123def', { policy: 'announce' });

    const got = await waits();
    const conditions = got.filter((w) => w.waitKind === 'item-condition');
    expect(conditions.map((w) => [w.itemId, w.blockerKind, w.eventKey]).sort()).toEqual([
      ['WI-C1', 'human', 'owner picks the vendor'],
      ['WI-C1', 'runtime', 'pc-heavy queue'],
    ]);
    expect(conditions.find((w) => w.blockerKind === 'runtime')).toMatchObject({
      capability: 'live-dependency',
      recheckAt: '2026-10-30T00:00:00.000Z',
      certification: 'not-an-event',
      announced: false,
      announcedBy: null,
      since: '2026-10-21T00:00:00.000Z',
      holderId: 'su-holder',
      subscriberId: null,
      awaitId: null,
      parkedBy: null,
      stale: false,
      legTruncated: false,
    });
    expect(conditions.find((w) => w.blockerKind === 'human')).toMatchObject({ capability: 'product-decision', recheckAt: null });
    // The event blocker on the same item stays an event wait, attributed to its announcer.
    expect(got.filter((w) => w.itemId === 'WI-C1' && w.waitKind === 'item-blocker')).toEqual([
      expect.objectContaining({ blockerKind: 'event', announced: true, announcedBy: 'su-leader', capability: null }),
    ]);
    // Every non-condition wait leaves capability null.
    expect(got.filter((w) => w.waitKind !== 'item-condition').every((w) => w.capability === null)).toBe(true);
  });

  it('WI-6554700010030344 G-3c: an announced key names its most recent live announcer; an unannounced key names none', async () => {
    await heldItem('WI-A1', null, { blockers: [blocker('gate', 'fleet:alpha:schema-ready'), blocker('event', 'release:deployed:ffff')] });
    await awaitRow('su-first', 'fleet:alpha:schema-ready', { policy: 'announce' });
    await awaitRow('su-second', 'fleet:alpha:schema-ready', { policy: 'announce' });
    await db.sql`UPDATE harness_shared.event_awaits SET created_at = now() - interval '1 hour' WHERE subscriber_id = 'su-first'`;

    const got = (await waits()).filter((w) => w.itemId === 'WI-A1');
    expect(got.find((w) => w.eventKey === 'fleet:alpha:schema-ready')).toMatchObject({ announced: true, announcedBy: 'su-second' });
    expect(got.find((w) => w.eventKey === 'release:deployed:ffff')).toMatchObject({ announced: false, announcedBy: null });
  });

  it('WI-6554700010030344 G-2: the condition branch is capped on its own and says so, without truncating the event-blocker branch', async () => {
    const n = DEP_WAITS_LIMITS.condition + 3;
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, status, item_kind, workspace_id, created_ts, updated_ts, payload)
      SELECT ${H}, 'WI-CAP-' || lpad(g::text, 5, '0'), 'capped', 'blocked', 'bug', ${WS}, 0, 0,
             jsonb_build_object('externalBlockers', jsonb_build_array(jsonb_build_object(
               'kind', 'runtime', 'ref', 'queue ' || g, 'status', 'active', 'summary', 's',
               'createdAt', '2026-10-21T00:00:00.000Z', 'createdBy', 'su-holder', 'updatedAt', '2026-10-21T00:00:00.000Z')))
        FROM generate_series(1, ${n}) g`;
    await heldItem('WI-EV', null, { blockers: [blocker('event', 'release:deployed:abc123def')] });

    const got = await waits();
    const conditions = got.filter((w) => w.waitKind === 'item-condition');
    expect(conditions).toHaveLength(DEP_WAITS_LIMITS.condition);
    expect(conditions.every((w) => w.legTruncated)).toBe(true);
    expect(got.filter((w) => w.waitKind === 'item-blocker')).toEqual([
      expect.objectContaining({ itemId: 'WI-EV', legTruncated: false }),
    ]);
  }, 60_000);

  it('WI-6554700010030343: returns a durable park\'s release trigger as an item-park wait, but not a lease, a stale contract, a blank trigger, or a terminal item', async () => {
    const parked = (trigger: unknown, over: Record<string, unknown> = {}) => ({
      _claimHold: true,
      claim_hold_by: 'su-parker',
      claim_hold_reason: 'blocked',
      claim_hold_at: '2026-10-25T08:14:09.576Z',
      claim_hold_release: { condition: 'the condition', owner: 'su-parker', trigger, ...over },
    });
    await heldItem('WI-P1', null, { payload: parked('work-item:done:WI-5', { recheckAt: '2026-10-28T00:00:00.000Z' }) });
    await heldItem('WI-P2', 'su-holder', { payload: parked('waiting on the vendor reply') });
    // A park beside an active blocker on the same key: both waits are returned.
    await heldItem('WI-P3', null, { payload: parked('release:deployed:abc123def'), blockers: [blocker('event', 'release:deployed:abc123def')] });
    await heldItem('WI-LEASE', 'su-holder', { payload: { _claimHold: true, held_open_by: 'su-holder', held_open_at: '2026-10-25T08:14:09.576Z' } });
    await heldItem('WI-UNPARKED', null, { payload: { claim_hold_release: { trigger: 'work-item:done:WI-8' } } });
    await heldItem('WI-BLANK', null, { payload: parked('   ') });
    await heldItem('WI-NOTSTRING', null, { payload: parked({ key: 'work-item:done:WI-8' }) });
    await heldItem('WI-PDONE', null, { status: 'done', payload: parked('work-item:done:WI-9') });
    await heldItem('WI-POTHER', null, { harness: 'some-other-harness', payload: parked('work-item:done:WI-9') });

    const got = await waits();
    const parks = got.filter((w) => w.waitKind === 'item-park');
    expect(parks.map((w) => [w.itemId, w.eventKey]).sort()).toEqual([
      ['WI-P1', 'work-item:done:WI-5'],
      ['WI-P2', 'waiting on the vendor reply'],
      ['WI-P3', 'release:deployed:abc123def'],
    ]);
    expect(parks.find((w) => w.itemId === 'WI-P1')).toMatchObject({
      parkedBy: 'su-parker',
      since: '2026-10-25T08:14:09.576Z',
      recheckAt: '2026-10-28T00:00:00.000Z',
      certification: 'proving',
      holderId: null,
      subscriberId: null,
      blockerKind: null,
      awaitId: null,
      bound: false,
      stale: false,
      legTruncated: false,
    });
    // The certification is the shared predicate's answer for the trigger, as on every leg.
    expect(parks.find((w) => w.itemId === 'WI-P2')).toMatchObject({ certification: 'uncatalogued', recheckAt: null, holderId: 'su-holder' });
    expect(got.filter((w) => w.itemId === 'WI-P3').map((w) => w.waitKind).sort()).toEqual(['item-blocker', 'item-park']);
    expect(got.filter((w) => w.waitKind !== 'item-park').every((w) => w.parkedBy === null && w.recheckAt === null)).toBe(true);
  });

  it('AUTO-BAR-R-17-P-009: labels each wait proving exactly when fireCertifiesCondition holds for its key, and names why otherwise', async () => {
    await heldItem('WI-1', 'su-holder', {
      blockers: [
        blocker('event', 'release:deployed:abc123def'),
        blocker('event', 'work-item:status:WI-5'),
        blocker('event', 'git-sync:committed'),
        blocker('gate', 'waiting on the vendor reply'),
      ],
    });
    await awaitRow('su-holder', 'work-item:status:WI-6', { bound: { kind: 'work-item-blocked', ref: 'WI-1' } });
    await awaitRow('su-holder', 'work-item:done:WI-7', { bound: { kind: 'work-item-blocked', ref: 'WI-1' } });

    const got = (await waits(states({ 'su-holder': 'live' }))).filter((w) => w.itemId === 'WI-1');
    const label = (kind: string, key: string) => got.find((w) => w.waitKind === kind && w.eventKey === key)?.certification;
    // A change-notification wait is never labelled proving, on either leg; a proving wait always is.
    expect(label('item-blocker', 'release:deployed:abc123def')).toBe('proving');
    expect(label('item-blocker', 'work-item:status:WI-5')).toBe('change-notification');
    expect(label('item-blocker', 'git-sync:committed')).toBe('broad');
    expect(label('item-blocker', 'waiting on the vendor reply')).toBe('uncatalogued');
    expect(label('session-await', 'work-item:status:WI-6')).toBe('change-notification');
    expect(label('session-await', 'work-item:done:WI-7')).toBe('proving');
    // The label is the shared predicate's answer, never a second classification.
    expect(got).toHaveLength(6);
    for (const w of got) {
      expect(w.certification === 'proving', w.eventKey).toBe(fireCertifiesCondition(w.eventKey, w.announced === true));
    }
  });

  it('AUTO-BAR-R-19-P-009: answers in at most four SQL statements and one liveness batch, inside a tight statement timeout at volume', async () => {
    // The production indexes the three legs are written against (event_awaits: 000-baseline /
    // later migrations; work_items: hfc_taken_by_idx and migration 1539's GIN). The fixture DDL
    // omits them, and without them the holder leg's per-item LATERAL degrades to a nested
    // seq scan — which is exactly what this statement timeout exists to catch.
    await db.sql.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_event_awaits_subscriber ON harness_shared.event_awaits (subscriber_id)
        WHERE fired_at IS NULL AND cancelled_at IS NULL;
      CREATE INDEX IF NOT EXISTS event_awaits_bound_to_active ON harness_shared.event_awaits
        ((bound_to ->> 'kind'), (bound_to ->> 'ref')) WHERE bound_to IS NOT NULL AND cancelled_at IS NULL;
      CREATE INDEX IF NOT EXISTS hfc_taken_by_idx ON harness_shared.work_items (workspace_id, taken_by)
        WHERE taken_by IS NOT NULL;
      CREATE INDEX IF NOT EXISTS work_items_external_blockers_gin_idx ON harness_shared.work_items
        USING gin ((payload -> 'externalBlockers') jsonb_path_ops) WHERE (payload -> 'externalBlockers') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS work_items_claim_hold_release_trigger_idx ON harness_shared.work_items
        (((payload -> 'claim_hold_release') ->> 'trigger')) WHERE payload ? 'claim_hold_release';
    `).simple();
    // Volume: 3,000 held items across 300 holders, each holder with 5 unbound awaits; 600 items
    // with an active event blocker; 2,001 durably parked items (one over the park cap); 300
    // bound awaits.
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, status, item_kind, workspace_id, taken_by, created_ts, updated_ts, payload)
      SELECT ${H}, 'VOL-' || g, 'volume ' || g, 'blocked', 'bug', ${WS}, 'su-' || (g % 300), 0, g,
             CASE WHEN g <= 600
               THEN jsonb_build_object('externalBlockers', jsonb_build_array(jsonb_build_object(
                 'kind', 'event', 'ref', 'work-item:done:X-' || g, 'status', 'active', 'summary', 's',
                 'createdAt', '2026-10-21T00:00:00.000Z', 'createdBy', 'su', 'updatedAt', '2026-10-21T00:00:00.000Z')))
               WHEN g <= 2601
               THEN jsonb_build_object('_claimHold', true, 'claim_hold_by', 'su', 'claim_hold_at', '2026-10-21T00:00:00.000Z',
                 'claim_hold_release', jsonb_build_object('condition', 'c', 'trigger', 'work-item:done:Z-' || g))
               ELSE '{}'::jsonb END
        FROM generate_series(1, 3000) AS g`;
    await db.sql`
      INSERT INTO harness_shared.event_awaits (workspace_id, subscriber_id, event_key, policy, once)
      SELECT ${COORD}, 'su-' || (g % 300), 'work-item:done:Y-' || g, 'wake', true
        FROM generate_series(1, 1500) AS g`;
    await db.sql`
      INSERT INTO harness_shared.event_awaits (workspace_id, subscriber_id, event_key, policy, once, bound_to)
      SELECT ${COORD}, 'su-' || (g % 300), 'work-item:unblocked:VOL-' || g, 'wake', true,
             jsonb_build_object('kind', 'work-item-blocked', 'ref', 'VOL-' || g)
        FROM generate_series(1, 300) AS g`;
    await db.sql`ANALYZE harness_shared.work_items`;
    await db.sql`ANALYZE harness_shared.event_awaits`;

    let statements = 0;
    let livenessBatches = 0;
    const got = await db.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '750ms'`);
      const counted = new Proxy(tx, {
        apply(target, thisArg, args) {
          statements++;
          return Reflect.apply(target as never, thisArg, args);
        },
      });
      return resolveDependencyGraphWaits(counted as unknown as typeof db.sql, { workspaceId: WS, harnessSlug: H }, {
        resolveSessionStates: async (ids) => {
          livenessBatches++;
          return new Map(ids.map((id) => [id, 'live' as const]));
        },
      });
    });

    expect(statements).toBeLessThanOrEqual(4);
    expect(livenessBatches).toBe(1);
    expect(got.filter((w) => w.waitKind === 'item-blocker')).toHaveLength(600);
    expect(got.filter((w) => w.bound)).toHaveLength(300);
    // The park branch shares the blocker leg's statement, is capped on its own, and says so.
    const parkRows = got.filter((w) => w.waitKind === 'item-park');
    expect(parkRows).toHaveLength(DEP_WAITS_LIMITS.park);
    expect(parkRows.every((w) => w.legTruncated)).toBe(true);
    expect(got.filter((w) => w.waitKind === 'item-blocker').every((w) => !w.legTruncated)).toBe(true);
    // The holder leg is capped per holder AND overall, and says so when it truncates.
    const holderRows = got.filter((w) => w.waitKind === 'session-await' && !w.bound);
    const perItem = new Map<string, number>();
    for (const w of holderRows) perItem.set(w.itemId, (perItem.get(w.itemId) ?? 0) + 1);
    expect(Math.max(...perItem.values())).toBeLessThanOrEqual(DEP_WAITS_PER_HOLDER);
    expect(holderRows.length).toBe(DEP_WAITS_LIMITS.holder);
    expect(holderRows.every((w) => w.legTruncated)).toBe(true);
  }, 60_000);

  it('SPEC-P-009: migration 1546 notifies sync_invalidate for a non-inbox await write and stays silent for inbox-wake re-arms', async () => {
    const migration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1546-event-awaits-change-notify.sql', import.meta.url));
    await db.sql.unsafe(readFileSync(migration, 'utf8')).simple();

    const got: Array<{ name: string; args: { op: string } }> = [];
    const listener = await db.sql.listen('sync_invalidate', (payload) => {
      const parsed = JSON.parse(payload) as { name: string; args: { op: string } };
      if (parsed.name === 'harness_shared.event_awaits.changed') got.push(parsed);
    });
    try {
      await awaitRow('su-a', 'coord:inbox-wake:su-a');
      await db.sql`UPDATE harness_shared.event_awaits SET note = 're-armed' WHERE event_key = 'coord:inbox-wake:su-a'`;
      await db.sql`DELETE FROM harness_shared.event_awaits WHERE event_key = 'coord:inbox-wake:su-a'`;
      await awaitRow('su-a', 'work-item:done:WI-1', { bound: { kind: 'work-item-blocked', ref: 'WI-2' } });
      await db.sql`UPDATE harness_shared.event_awaits SET fired_at = now() WHERE event_key = 'work-item:done:WI-1'`;
      await db.sql`DELETE FROM harness_shared.event_awaits WHERE event_key = 'work-item:done:WI-1'`;

      const deadline = Date.now() + 5000;
      while (got.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 200)); // room for any stray inbox-wake notice to arrive
      expect(got.map((n) => n.args.op)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
    } finally {
      await listener.unlisten();
    }
  });
});
