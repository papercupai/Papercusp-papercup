/**
 * routed-ledger-origin.integration.test.ts — su-loop-capability-parity-2026-07-03 P-005 /
 * D-009: the ORIGIN dimension on the routed-idea ledger (migration 470), against real
 * migrated Postgres. Pins:
 *  - the `origin` column exists + DEFAULTS to 'scout' (every existing writer, which passes
 *    no origin, lands a Scout-origin row exactly as before);
 *  - recordRoutedIdea({ origin:'su-ideate' }) persists a su-ideate row;
 *  - readRoutedIdeas() DEFAULTS to origin='scout' and EXCLUDES su-ideate — proven with a
 *    su-ideate row carrying a REAL CreativeLens, so the isolation is by ORIGIN, not by a
 *    sentinel lens (D-009: an origin is not a pseudo-lens; SU provenance never reaches
 *    the lens-weight learners, which all read through this default);
 *  - readRoutedIdeas({ origin:'su-ideate' }) reads them back (the SU-priming path);
 *    { origin:'all' } reads both;
 *  - a su-ideate row is gradeable (the blender:grade-idea seam is origin-blind) and reads
 *    back with the grade — so an SU-originated idea earns a grade slot + priming;
 *  - created_by (migration 558, su-ideate-learning-substrate P-001): persisted for the
 *    su-ideate writer, NULL for scout writers, mapped to RoutedIdeaProvenance.createdBy,
 *    and NEVER erased by a provenance-less upsert (a re-route keeps the originator);
 *  - getScoutLensOutcomes — the lens-weight LEARNER read (su-ideate-learning-substrate
 *    P-002 / D-002 guard): its default origin='scout' report never counts a su-ideate
 *    row even when that row carries a REAL CreativeLens.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { IDEA_ORIGIN_PAYLOAD_KEY } from './ideation-origin';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));
// recordRoutedIdea / gradeRoutedIdea fire-and-forget a learning.scout invalidate via a lazy
// import — mock the SSE seam so it is a no-op under test.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { recordRoutedIdea, readRoutedIdeas, gradeRoutedIdea, getScoutLensOutcomes, readScoutPlanRefs } =
  await import('./routed-ledger');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-scout-origin-test';
const HARNESS = 'papercup';
const T = Date.parse('2026-07-03T08:00:00Z');

describe('scout routed-ledger ORIGIN dimension (real PG, migration 470)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    // A scout-origin idea (writer passes NO origin → defaults to 'scout') + an su-ideate
    // origination. The su-ideate row deliberately carries a REAL lens ('analogical') so the
    // exclusion below is proven to be ORIGIN-based, not an accident of a sentinel lens.
    await recordRoutedIdea({
      ideaId: 'scout-1', lens: 'analogical', rail: 'gym', routedRef: 'gym:sp-x',
      harnessSlug: HARNESS, title: 'a scout-routed idea', workspaceId: WS, routedAt: T,
    });
    await recordRoutedIdea({
      origin: 'su-ideate', ideaId: 'EI-su-1', lens: 'analogical', rail: 'improvement',
      routedRef: 'wi:EI-su-1', harnessSlug: HARNESS, title: 'an su superuser feature idea',
      workspaceId: WS, routedAt: T + 1000, createdBy: 'su-test-owner-1',
    });
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  it("the origin column DEFAULTS to 'scout' for a writer that passes no origin", async () => {
    const rows = await db.adminSql<{ origin: string }[]>`
      SELECT origin FROM harness_shared.scout_routed_ideas WHERE idea_id = 'scout-1'`;
    expect(rows[0]?.origin).toBe('scout');
  });

  it('persists an explicit su-ideate origin', async () => {
    const rows = await db.adminSql<{ origin: string }[]>`
      SELECT origin FROM harness_shared.scout_routed_ideas WHERE idea_id = 'EI-su-1'`;
    expect(rows[0]?.origin).toBe('su-ideate');
  });

  it.each(['open', ...ANY_FAMILY_TERMINAL_STATES])(
    'backfills origin only on a nonterminal artifact (state %s)',
    async (status) => {
      const workspace = 'ws-origin-backfill-' + status;
      const id = 'EI-origin-backfill-' + status;
      await db.adminSql`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, payload)
        VALUES (${workspace}, ${HARNESS}, ${id}, ${'origin replay ' + status}, ${status}, 'change',
          ${JSON.stringify({ retained: 'exact payload' })}::jsonb)`;
      const [before] = await db.adminSql`SELECT payload FROM harness_shared.work_items
        WHERE workspace_id = ${workspace} AND feature_id = ${id}`;
      const input = {
        origin: 'dream' as const, ideaId: 'dream:' + id, lens: 'dream' as const, rail: 'improvement' as const,
        routedRef: 'wi:' + id, harnessSlug: HARNESS, workspaceId: workspace, preserveExisting: true,
      };
      await Promise.all([recordRoutedIdea(input), recordRoutedIdea(input)]);
      await recordRoutedIdea(input);
      const [after] = await db.adminSql`SELECT payload FROM harness_shared.work_items
        WHERE workspace_id = ${workspace} AND feature_id = ${id}`;
      expect(after!.payload).toEqual(status === 'open'
        ? { ...before!.payload, [IDEA_ORIGIN_PAYLOAD_KEY]: 'dream' }
        : before!.payload);
      const ledger = await readRoutedIdeas({ workspaceId: workspace, origin: 'dream' });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.routedRef).toBe('wi:' + id);
    },
  );

  it('keeps an existing unrelated origin on a nonterminal routed artifact', async () => {
    const workspace = 'ws-origin-backfill-existing';
    const id = 'EI-origin-backfill-existing';
    await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, payload)
      VALUES (${workspace}, ${HARNESS}, ${id}, 'existing origin replay', 'open', 'change',
        ${JSON.stringify({ retained: 'exact payload', [IDEA_ORIGIN_PAYLOAD_KEY]: 'su-ideate' })}::jsonb)`;
    const [before] = await db.adminSql`SELECT payload FROM harness_shared.work_items
      WHERE workspace_id = ${workspace} AND feature_id = ${id}`;
    await recordRoutedIdea({
      origin: 'dream', ideaId: 'dream:' + id, lens: 'dream', rail: 'improvement', routedRef: 'wi:' + id,
      harnessSlug: HARNESS, workspaceId: workspace, preserveExisting: true,
    });
    const [after] = await db.adminSql`SELECT payload FROM harness_shared.work_items
      WHERE workspace_id = ${workspace} AND feature_id = ${id}`;
    expect(after!.payload).toEqual(before!.payload);
  });

  it('readRoutedIdeas() DEFAULTS to scout-origin — EXCLUDES su-ideate by ORIGIN (D-009 lens isolation)', async () => {
    const ids = (await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS })).map((r) => r.ideaId);
    expect(ids).toContain('scout-1');
    // A REAL-lens su-ideate row is still excluded — so it can never reach the lens-weight
    // learners (which all read through this default), i.e. it can't skew the diversity floor.
    expect(ids).not.toContain('EI-su-1');
  });

  it('readRoutedIdeas({ origin:"su-ideate" }) reads su-ideate rows back (the SU-priming path)', async () => {
    const ids = (await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS, origin: 'su-ideate' })).map((r) => r.ideaId);
    expect(ids).toEqual(['EI-su-1']);
  });

  it('readRoutedIdeas({ origin:"all" }) reads both origins', async () => {
    const ids = (await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS, origin: 'all' })).map((r) => r.ideaId).sort();
    expect(ids).toEqual(['EI-su-1', 'scout-1']);
  });

  it('a su-ideate row is gradeable + reads back with the grade (grade slot for priming)', async () => {
    const res = await gradeRoutedIdea({ ideaId: 'EI-su-1', grade: 4, feedback: 'promising', gradedBy: 'owner' });
    expect(res.applied).toBe(true);
    const [row] = await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS, origin: 'su-ideate' });
    expect(row.humanGrade).toBe(4);
    expect(row.gradedBy).toBe('owner');
  });

  it('persists created_by for the su-ideate writer + leaves scout rows NULL (migration 558)', async () => {
    const rows = await db.adminSql<{ idea_id: string; created_by: string | null }[]>`
      SELECT idea_id, created_by FROM harness_shared.scout_routed_ideas
       WHERE idea_id IN ('scout-1', 'EI-su-1')`;
    expect(rows.find((r) => r.idea_id === 'EI-su-1')?.created_by).toBe('su-test-owner-1');
    expect(rows.find((r) => r.idea_id === 'scout-1')?.created_by).toBeNull();
  });

  it('readRoutedIdeas maps created_by → createdBy, omitting it when NULL', async () => {
    const [su] = await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS, origin: 'su-ideate' });
    expect(su.createdBy).toBe('su-test-owner-1');
    const [scout] = await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS });
    expect(scout.createdBy).toBeUndefined();
  });

  it('a provenance-less upsert NEVER erases created_by (a re-route keeps the originator)', async () => {
    await recordRoutedIdea({
      origin: 'su-ideate', ideaId: 'EI-su-1', lens: 'analogical', rail: 'improvement',
      routedRef: 'wi:EI-su-1', harnessSlug: HARNESS, title: 'an su superuser feature idea (re-routed)',
      workspaceId: WS, routedAt: T + 2000,
    });
    const rows = await db.adminSql<{ created_by: string | null }[]>`
      SELECT created_by FROM harness_shared.scout_routed_ideas WHERE idea_id = 'EI-su-1'`;
    expect(rows[0]?.created_by).toBe('su-test-owner-1');
  });

  // WI-39439. readScoutPlanRefs feeds the plans:list `origin:'scout'` flag, which two
  // surfaces read as "Blender-made": the PlansPane provenance icon and the Create tab's
  // scout filter facet. It shipped WITHOUT the origin predicate every other read in this
  // module applies, so it answered "routed by ANYTHING" — measured on live data, 6 genuinely
  // scout plans against 18 su-ideate, i.e. wrong on 75% of the rows it lit. The su-ideate row
  // below carries a REAL lens for the same reason the fixture above does: the exclusion must
  // be by ORIGIN, not by an accident of a sentinel lens.
  it('readScoutPlanRefs returns ONLY genuinely-scout plan refs — never a su-ideate one (WI-39439)', async () => {
    // Deliberately a DIFFERENT workspace from the shared fixture. Two reasons, both
    // real: (1) the sibling getScoutLensOutcomes guard below asserts an exact count
    // over WS ("exactly ONE scout-origin 'analogical' idea"), so adding rows to WS
    // makes THAT test fail — a fixture-coupling bug this test hit for real before
    // being isolated; (2) readScoutPlanRefs is deliberately workspace-FREE (its
    // docblock: a workspace clause silently empties the join under the 'default' ALS
    // of in-process dispatch), so reading these rows back from another workspace
    // PROVES that documented property instead of merely not contradicting it.
    const PLAN_WS = 'ws-scout-planrefs-test';
    await recordRoutedIdea({
      ideaId: 'scout-plan-1', lens: 'analogical', rail: 'plan', routedRef: 'plan:a-blender-plan',
      harnessSlug: HARNESS, title: 'a Blender-routed plan', workspaceId: PLAN_WS, routedAt: T + 3000,
    });
    await recordRoutedIdea({
      origin: 'su-ideate', ideaId: 'su-plan-1', lens: 'analogical', rail: 'plan',
      routedRef: 'plan:an-su-ideated-plan', harnessSlug: HARNESS,
      title: 'a plan an su agent ideated', workspaceId: PLAN_WS, routedAt: T + 4000,
      createdBy: 'su-test-owner-1',
    });

    const refs = await readScoutPlanRefs();
    expect(refs.has('plan:a-blender-plan')).toBe(true);
    expect(refs.has('plan:an-su-ideated-plan')).toBe(false);
    // Positive control on the instrument itself: a set that came back EMPTY would also
    // satisfy the not-contains assertion above, so an unfiltered-read regression could hide
    // behind a broken query. Pin the exact population instead.
    expect([...refs].sort()).toEqual(['plan:a-blender-plan']);
  });

  it("getScoutLensOutcomes' DEFAULT report never counts a REAL-lens su-ideate row (P-002 / D-002 guard)", async () => {
    const report = await getScoutLensOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    // Exactly ONE scout-origin 'analogical' idea exists in the fixture; the su-ideate row
    // deliberately shares that REAL lens, so any origin leak into the lens-weight learner
    // (the D-002 partition failing) would double these counts and skew the diversity floor.
    expect(report.total).toBe(1);
    expect(report.byLens.analogical.routed).toBe(1);
  });
});
