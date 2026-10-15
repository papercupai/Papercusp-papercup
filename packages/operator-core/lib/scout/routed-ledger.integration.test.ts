/**
 * routed-ledger.integration.test.ts — Scout P-013 production wiring against real
 * migrated Postgres (migration 194). Pins:
 *  - recordRoutedIdea upsert + readRoutedIdeas round-trip (provenance shape, scope filter);
 *  - getScoutLensOutcomes deriving per-lens outcomes by JOINING the ledger's
 *    routedRef to the live Change Feed (gym_proposals / harness_plans);
 *  - refreshScoutOutcomes persisting the outcome cache back to the ledger;
 *  - gradeRoutedIdea (scout-idea-grading C-2, migration 234): the owner-sovereign
 *    precedence guard against live rows + the C-1 → C-1b grade read-back.
 *
 * The pure derivation is covered by outcome-feedback.test.ts; this proves the
 * real join + the SQL are correct (the change-feed-deps Phase-7 lesson: a wrong
 * query silently returns [] — so pin it against the migrated schema).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));
// recordRoutedIdea/gradeRoutedIdea fire-and-forget a learning.scout invalidate
// via a lazy import — mock the SSE seam so the grade tests can assert it.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const {
  recordRoutedIdea,
  readRoutedIdeas,
  gradeRoutedIdea,
  getScoutLensOutcomes,
  refreshScoutOutcomes,
  readPendingOutcomeCandidates,
  getScoutLensWeights,
  buildScoutOutcomeReaders,
  readLensRecency,
} = await import('./routed-ledger');
const { rosterForBudget } = await import('./cycle-deps');
const invalidate = vi.mocked((await import('../sync-sse')).notifySyncInvalidate);
const { createOrgTestDb } = await import('../../test/_org-test-db');
// EI-11978: prove the aged-out win is genuinely OUTSIDE the raw feed window, so
// the recovered 'won' can only come from the ref-scoped augmentation.
const { gatherCompletions } = await import('../curation/change-feed');
const { buildChangeFeedReaders } = await import('../curation/change-feed-deps');

const WS = 'ws-scout-ledger-test';
const HARNESS = 'papercup';
const T_GYM = Date.parse('2026-06-07T08:00:00Z');
const T_PLAN = Date.parse('2026-06-06T07:00:00Z');

describe('scout routed-ledger (real PG, migration 194)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    const sql = db.adminSql;

    // Completions the ledger refs will join against:
    // gym sp-1 accepted (a win), sp-2 rejected (a loss). GYM-3: production
    // gym_proposals rows are keyed by a COMPOUND id (`${variantId}__${role}`,
    // control-plane.ts recordProposal) — a Scout routedRef (`gym:<candidateId>`)
    // always joins on the separate `variant_id` column, never `id`. Model that
    // shape here (id != variant_id) so this fixture doesn't silently validate
    // the pre-fix wrong-column join.
    await sql`
      INSERT INTO harness_shared.gym_proposals
        (id, workspace_id, harness_slug, role, variant_id, proposed_md, status, created_at, decided_at)
      VALUES
        ('sp-1__worker', ${WS}, ${HARNESS}, 'worker', 'sp-1', '# v', 'accepted', ${T_GYM - 1000}, ${T_GYM}),
        ('sp-2__worker', ${WS}, ${HARNESS}, 'worker', 'sp-2', '# v', 'rejected', ${T_GYM - 1000}, ${T_GYM})`;
    // plan scout-x op done (a win).
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, op_status, op_updated_at)
      VALUES
        (${WS}, ${HARNESS}, 'scout-x', 'A Scout-spawned plan', 'done', ${new Date(T_PLAN)})`;

    // Routed-idea provenance (via the production write path — also exercises upsert).
    await recordRoutedIdea({ ideaId: 'i1', lens: 'analogical', rail: 'gym', routedRef: 'gym:sp-1', harnessSlug: HARNESS, cycleId: 'c1', title: 'win idea', workspaceId: WS, addressesPatternRefs: ['wi:F-1'] });
    await recordRoutedIdea({ ideaId: 'i2', lens: 'analogical', rail: 'gym', routedRef: 'gym:sp-2', harnessSlug: HARNESS, cycleId: 'c1', title: 'loss idea', workspaceId: WS });
    await recordRoutedIdea({ ideaId: 'i3', lens: 'reframing', rail: 'plan', routedRef: 'plan:scout-x', harnessSlug: HARNESS, cycleId: 'c1', title: 'plan idea', workspaceId: WS });
    await recordRoutedIdea({ ideaId: 'i4', lens: 'first-principles', rail: 'improvement', routedRef: 'wi:EI-NONE', harnessSlug: HARNESS, cycleId: 'c1', title: 'pending idea', workspaceId: WS });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('rotates the real capped roster across zero-route Scout attempts (EI-24926443593885283)', async () => {
    const workspace = 'ws-scout-zero-route-rotation';
    const visited: string[] = [];
    const base = Date.parse('2026-10-03T00:00:00Z');
    for (let cycle = 0; cycle < 4; cycle++) {
      const recency = await readLensRecency({ workspaceId: workspace });
      const lens = rosterForBudget(1, undefined, recency).lenses![0];
      visited.push(lens);
      const detail = JSON.stringify({ ideators: [{ lens, ideas: 0 }] });
      const at = new Date(base + cycle * 1000).toISOString();
      await db.adminSql`
        INSERT INTO harness_shared.scout_ticks
          (workspace_id, install_slug, origin, status, ideas_routed, tick_at, detail)
        VALUES (${workspace}, '@singleton', 'scout', 'ran', 0, ${at}::timestamptz, ${detail}::text::jsonb)`;
    }
    expect(visited).toEqual(['analogical', 'first-principles', 'reframing', 'constraint-removal']);
    const counts = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.scout_routed_ideas WHERE workspace_id = ${workspace}`;
    expect(counts[0].n).toBe(0); // Fairness did not depend on a routed artifact.
  });

  it('attempt recency excludes other workspaces, origins, failures and malformed slot metadata', async () => {
    const workspace = 'ws-scout-attempt-isolation';
    const success = JSON.stringify({ ideators: [{ lens: 'reframing', ideas: 0 }] });
    const failed = JSON.stringify({ ideators: [{ lens: 'analogical', error: 'transport failed' }] });
    const other = JSON.stringify({ ideators: [{ lens: 'first-principles' }] });
    await db.adminSql`
      INSERT INTO harness_shared.scout_ticks
        (workspace_id, install_slug, origin, status, tick_at, detail)
      VALUES
        (${workspace}, '@singleton', 'scout', 'ran', '2026-10-03T00:00:01Z'::timestamptz, ${success}::text::jsonb),
        (${workspace}, '@singleton', 'scout', 'ran', '2026-10-03T00:00:02Z'::timestamptz, ${failed}::text::jsonb),
        (${workspace}, '@singleton', 'su-ideate', 'ran', '2026-10-03T00:00:03Z'::timestamptz, ${other}::text::jsonb),
        (${workspace}, '@singleton', 'scout', 'error', '2026-10-03T00:00:04Z'::timestamptz, ${other}::text::jsonb),
        ('other-scout-workspace', '@singleton', 'scout', 'ran', '2026-10-03T00:00:05Z'::timestamptz, ${other}::text::jsonb),
        (${workspace}, '@singleton', 'scout', 'ran', '2026-10-03T00:00:06Z'::timestamptz, '{"ideators":{}}'::jsonb)`;
    expect(await readLensRecency({ workspaceId: workspace })).toEqual({ reframing: Date.parse('2026-10-03T00:00:01Z') });
    expect(await readLensRecency({ workspaceId: workspace, origin: 'su-ideate' })).toEqual({});
  });

  it('preserves historical routing recency when a lens has no attempt metadata', async () => {
    const recency = await readLensRecency({ workspaceId: WS });
    expect(recency.analogical).toBeGreaterThan(0);
    expect(recency['first-principles']).toBeGreaterThan(0);
    expect(recency.reframing).toBeGreaterThan(0);
  });

  it('reads back routed provenance, newest-first, scoped to the workspace', async () => {
    const rows = await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS });
    expect(rows.map((r) => r.ideaId).sort()).toEqual(['i1', 'i2', 'i3', 'i4']);
    const i1 = rows.find((r) => r.ideaId === 'i1')!;
    expect(i1.lens).toBe('analogical');
    expect(i1.rail).toBe('gym');
    expect(i1.routedRef).toBe('gym:sp-1');
    expect(i1.cycleId).toBe('c1');
    expect(i1.title).toBe('win idea');
    expect(typeof i1.routedAt).toBe('string');
    // WI-4474 REGRESSION GUARD. `addresses_pattern_refs` was SELECTed, typed on
    // LedgerRow, and SET BY THIS VERY FIXTURE (i1, above) — but never mapped onto
    // the provenance, so every ledger-read consumer saw it as undefined. This
    // round-trip test asserted six other fields and omitted the seventh, so the
    // drop was invisible: the fixture had the coverage, the assertion didn't.
    // A read-side field-drop looks EXACTLY like an upstream population failure
    // downstream (it made the P-006 grounding lanes and the P-015 rubric bar
    // structurally unpassable), so assert the field, not just the row.
    expect(i1.addressesPatternRefs).toEqual(['wi:F-1']);
    // ...and an absent ref-set stays absent (not [] — the provenance omits the key).
    expect(rows.find((r) => r.ideaId === 'i2')!.addressesPatternRefs).toBeUndefined();
  });

  it('projects typed issue→revises→original edges as feedback revision lineage', async () => {
    await recordRoutedIdea({
      ideaId: 'i-feedback-original',
      lens: 'risk-first',
      rail: 'improvement',
      routedRef: 'wi:EI-FEEDBACK-ORIGINAL',
      harnessSlug: HARNESS,
      workspaceId: WS,
      origin: 'su-ideate',
      createdBy: 'su-originator',
    });
    const revisedAt = new Date('2026-07-13T13:05:00.000Z');
    await db.adminSql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source, state,
         assignee, assigned_by, assigned_at, payload, found_during, created_by,
         signal_origin, created_at, updated_at)
      VALUES
        (${WS}, 'EI-FEEDBACK-REVISION', 'change', ${`harness:${HARNESS}`},
         'feedback revision', '', 'minor', 'engineer', 'open', NULL, NULL, NULL,
         '{}'::jsonb, NULL, 'su-originator', 'organic', ${revisedAt}, ${revisedAt})`;
    await db.adminSql`
      INSERT INTO harness_shared.coord_links
        (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel, created_by, created_at)
      VALUES
        ('default', 'issue', 'EI-FEEDBACK-REVISION', 'issue', 'EI-FEEDBACK-ORIGINAL',
         'revises', 'su-originator', ${revisedAt})`;

    const original = (await readRoutedIdeas({ workspaceId: WS, origin: 'su-ideate' }))
      .find((row) => row.ideaId === 'i-feedback-original')!;
    expect(original.feedbackRevisions).toEqual([{
      revisionRef: 'EI-FEEDBACK-REVISION',
      createdBy: 'su-originator',
      revisedAt: revisedAt.toISOString(),
    }]);
  });

  it('upserts by ideaId (re-routing overwrites, no duplicate row)', async () => {
    await recordRoutedIdea({ ideaId: 'i1', lens: 'analogical', rail: 'gym', routedRef: 'gym:sp-1', harnessSlug: HARNESS, cycleId: 'c1', title: 'win idea (re-routed)', workspaceId: WS });
    const rows = await readRoutedIdeas({ workspaceId: WS });
    expect(rows.filter((r) => r.ideaId === 'i1')).toHaveLength(1);
    expect(rows.find((r) => r.ideaId === 'i1')!.title).toBe('win idea (re-routed)');
  });

  // P-006/EI-10607: a re-record that OMITS addressesPatternRefs must not wipe the
  // grounding a prior record established (blender:route-idea's re-route path omits
  // them by design — a bare EXCLUDED.addresses_pattern_refs nulled the column).
  it('a refs-less re-record preserves existing addresses_pattern_refs; declared refs still replace', async () => {
    await recordRoutedIdea({ ideaId: 'i-ground', lens: 'analogical', rail: 'improvement', routedRef: 'wi:EI-1', harnessSlug: HARNESS, title: 'grounded', workspaceId: WS, addressesPatternRefs: ['wi:EI-10587'] });
    // The rail hop: same idea re-recorded with NO refs declared.
    await recordRoutedIdea({ ideaId: 'i-ground', lens: 'analogical', rail: 'plan', routedRef: 'plan:g-1', harnessSlug: HARNESS, title: 'grounded', workspaceId: WS });
    let row = (await readRoutedIdeas({ workspaceId: WS })).find((r) => r.ideaId === 'i-ground')!;
    expect(row.rail).toBe('plan'); // the hop itself landed
    expect(row.addressesPatternRefs).toEqual(['wi:EI-10587']); // grounding survived it
    // An explicit new declaration still replaces (COALESCE, not immutability).
    await recordRoutedIdea({ ideaId: 'i-ground', lens: 'analogical', rail: 'plan', routedRef: 'plan:g-1', harnessSlug: HARNESS, title: 'grounded', workspaceId: WS, addressesPatternRefs: ['wi:EI-999'] });
    row = (await readRoutedIdeas({ workspaceId: WS })).find((r) => r.ideaId === 'i-ground')!;
    expect(row.addressesPatternRefs).toEqual(['wi:EI-999']);
  });

  it('derives per-lens outcomes by joining routedRef to the Change Feed', async () => {
    const report = await getScoutLensOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    // analogical: one accepted gym (won) + one rejected gym (lost) → winRate 0.5
    expect(report.byLens.analogical.won).toBe(1);
    expect(report.byLens.analogical.lost).toBe(1);
    expect(report.byLens.analogical.winRate).toBeCloseTo(0.5, 9);
    // reframing: one op-done plan (won)
    expect(report.byLens.reframing.won).toBe(1);
    expect(report.byLens.reframing.winRate).toBe(1);
    // first-principles: routed to an artifact NOT in the feed → pending
    expect(report.byLens['first-principles'].pending).toBe(1);
    expect(report.byLens['first-principles'].winRate).toBeNull();
    // every lens carries a weight; they sum to 1
    const total = (['analogical', 'first-principles', 'reframing', 'constraint-removal'] as const).reduce(
      (a, l) => a + report.byLens[l].weight,
      0,
    );
    expect(total).toBeCloseTo(1, 9);
    expect(report.generatedAt).toBeTruthy();
  });

  it('refreshScoutOutcomes persists the outcome cache back to the ledger', async () => {
    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    const rows = await db.adminSql<{ idea_id: string; outcome: string | null; outcome_checked_at: string | null }[]>`
      SELECT idea_id, outcome, outcome_checked_at
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${WS}
       ORDER BY idea_id`;
    const byId = new Map(rows.map((r) => [r.idea_id, r]));
    expect(byId.get('i1')!.outcome).toBe('won');
    expect(byId.get('i2')!.outcome).toBe('lost');
    expect(byId.get('i3')!.outcome).toBe('won');
    expect(byId.get('i4')!.outcome).toBe('pending');
    expect(byId.get('i1')!.outcome_checked_at).toBeTruthy();
  });

  it('bounded refresh updates only selected ids and returns typed authoritative/unknown evidence', async () => {
    await db.adminSql`
      UPDATE harness_shared.scout_routed_ideas
         SET outcome = NULL, outcome_checked_at = NULL
       WHERE workspace_id = ${WS} AND idea_id = ANY(${['i1', 'i2', 'i3', 'i4']}::text[])`;

    const pending = await readPendingOutcomeCandidates({ workspaceId: WS, limit: 10 });
    expect(pending.map((row) => row.ideaId)).toEqual(expect.arrayContaining(['i1', 'i2', 'i3', 'i4']));

    const report = await refreshScoutOutcomes({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ideaIds: ['i1', 'i4'],
      // The ordinary newest-first lens report can be empty without hiding the
      // exact frontier selection from its dedicated bounded provenance read.
      limit: 0,
    });
    expect(report.refreshed).toHaveLength(2);
    expect(report.refreshed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ideaId: 'i1',
        routedRef: 'gym:sp-1',
        status: 'won',
        sourceKind: 'proposal',
        sourceRef: 'gym:sp-1',
      }),
      expect.objectContaining({
        ideaId: 'i4',
        routedRef: 'wi:EI-NONE',
        status: 'unknown',
        sourceKind: 'none',
        sourceRef: null,
      }),
    ]));

    const rows = await db.adminSql<
      { idea_id: string; outcome: string | null; outcome_checked_at: string | null }[]
    >`
      SELECT idea_id, outcome, outcome_checked_at
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${WS} AND idea_id = ANY(${['i1', 'i2', 'i3', 'i4']}::text[])
       ORDER BY idea_id`;
    const byId = new Map(rows.map((row) => [row.idea_id, row]));
    expect(byId.get('i1')).toMatchObject({ outcome: 'won' });
    expect(byId.get('i1')?.outcome_checked_at).toBeTruthy();
    expect(byId.get('i4')).toMatchObject({ outcome: 'pending' });
    expect(byId.get('i4')?.outcome_checked_at).toBeTruthy();
    expect(byId.get('i2')).toMatchObject({ outcome: null, outcome_checked_at: null });
    expect(byId.get('i3')).toMatchObject({ outcome: null, outcome_checked_at: null });

    // Leave the shared fixture in its normal fully-refreshed state for later tests.
    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
  });

  it('refreshScoutOutcomes ALSO lands the per-lens weight rows (the upsert is best-effort — a serialization throw is swallowed, so assert the rows, not just no-error)', async () => {
    // Regression: the unnest(${jsArray}::text[]) form threw bytes.js
    // "Received an instance of Array" under the getOrgPg client — caught LIVE
    // in the 2026-06-11 cadence rehearsal because the swallow made it
    // invisible to this suite's no-error pass. Fixed via jsonb_to_recordset
    // over one ::text::jsonb param; this test pins the rows actually landing.
    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    const weightRows = await db.adminSql<{ lens: string; wins: number; decided: number; weight: string | number }[]>`
      SELECT lens, wins, decided, weight
        FROM harness_shared.scout_lens_weights
       WHERE workspace_id = ${WS}
       ORDER BY lens`;
    expect(weightRows.length).toBeGreaterThan(0);
    const total = weightRows.reduce((s, r) => s + Number(r.weight), 0);
    expect(total).toBeCloseTo(1, 6); // normalized shares
    for (const r of weightRows) expect(r.decided).toBeGreaterThanOrEqual(0);
  });

  // EI-10520 REGRESSION: the Scout lens-weight corpus is ONE per-workspace bucket —
  // the workspace Scout writes every idea under SCOUT_TICK_INSTALL_SLUG ('@singleton')
  // and persists weights under the hive-home / workspace-sentinel scope, NOT the
  // member harness_slug. refreshScoutOutcomes used to FILTER the corpus read by the
  // scheduler's current harness_slug, so a win recorded under a different/older
  // harness_slug (the pre-'@singleton' cutover rows) was orphaned from the refresh —
  // 61 'won' outcomes moved the weights ZERO (uniform 0.25, wins=0/decided=0). The
  // corpus must be read workspace-wide: a refresh keyed to a harness_slug that
  // matches NO routed row must STILL see the workspace's scout wins.
  it('EI-10520: reads the scout corpus workspace-wide, not filtered by the scheduler harness_slug', async () => {
    // 'no-such-harness-slug' matches none of the seeded rows (all harness_slug='papercup').
    // Before the fix: readRoutedIdeas filtered harness_slug='no-such-harness-slug' → 0 rows
    // → every lens decided=0 (the dead uniform state). After: workspace-wide → analogical
    // sees gym sp-1 accepted (won) + gym sp-2 rejected/graded (decided) → decided > 0.
    const report = await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: 'no-such-harness-slug' });
    const analogical = report.byLens.analogical;
    expect(analogical.won + analogical.lost).toBeGreaterThan(0);
  });

  // ── scout-idea-grading C-2 (migration 234): gradeRoutedIdea against the real
  //    guard SQL + the C-1 → C-1b read-back. Runs LAST — grades must not
  //    perturb the outcome-derivation tests above (classifyIdeaOutcome is
  //    grade-blind by design, but ordering keeps the suites independent).
  describe('gradeRoutedIdea (C-2)', () => {
    const gradeRow = async (ideaId: string) =>
      (
        await db.adminSql<
          { human_grade: number | null; human_feedback: string | null; graded_by: string | null; graded_at: Date | null }[]
        >`
        SELECT human_grade, human_feedback, graded_by, graded_at
          FROM harness_shared.scout_routed_ideas
         WHERE idea_id = ${ideaId}`
      )[0];

    it('auto-grader grades an ungraded idea; readRoutedIdeas maps C-1 → C-1b', async () => {
      invalidate.mockClear();
      const res = await gradeRoutedIdea({ ideaId: 'i2', grade: 2, feedback: 'derivative', gradedBy: 'auto-grader' });
      expect(res).toEqual({ applied: true });
      await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith('learning.scout'));

      const row = await gradeRow('i2');
      expect(row.human_grade).toBe(2);
      expect(row.human_feedback).toBe('derivative');
      expect(row.graded_by).toBe('auto-grader');
      expect(row.graded_at).toBeTruthy();

      const i2 = (await readRoutedIdeas({ workspaceId: WS })).find((r) => r.ideaId === 'i2')!;
      expect(i2.humanGrade).toBe(2);
      expect(i2.humanFeedback).toBe('derivative');
      expect(i2.gradedBy).toBe('auto-grader');
      expect(typeof i2.gradedAt).toBe('string');
      // ungraded rows stay bare — the optional C-1b fields are absent
      const i3 = (await readRoutedIdeas({ workspaceId: WS })).find((r) => r.ideaId === 'i3')!;
      expect(i3.humanGrade).toBeUndefined();
      expect(i3.gradedBy).toBeUndefined();
    });

    it('regrade is idempotent and reflects the LATEST call in full (omitted feedback clears)', async () => {
      const res = await gradeRoutedIdea({ ideaId: 'i2', grade: 3, gradedBy: 'auto-grader' });
      expect(res).toEqual({ applied: true });
      const row = await gradeRow('i2');
      expect(row.human_grade).toBe(3);
      expect(row.human_feedback).toBeNull();
    });

    it('owner overwrites an auto-grader grade (the owner overwrites anything, D-004)', async () => {
      const res = await gradeRoutedIdea({ ideaId: 'i2', grade: 5, feedback: 'actually great', gradedBy: 'owner' });
      expect(res).toEqual({ applied: true });
      const row = await gradeRow('i2');
      expect(row.human_grade).toBe(5);
      expect(row.graded_by).toBe('owner');
    });

    it('auto-grader on an owner-graded row is a NO-OP: owner-grade-sovereign, row untouched, no invalidate', async () => {
      invalidate.mockClear();
      const res = await gradeRoutedIdea({ ideaId: 'i2', grade: 1, feedback: 'overruled?', gradedBy: 'auto-grader' });
      expect(res).toEqual({ applied: false, reason: 'owner-grade-sovereign' });
      const row = await gradeRow('i2');
      expect(row.human_grade).toBe(5); // the owner's verdict stands
      expect(row.human_feedback).toBe('actually great');
      expect(row.graded_by).toBe('owner');
      await new Promise((r) => setTimeout(r, 10));
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('grading a nonexistent idea → not-found', async () => {
      const res = await gradeRoutedIdea({ ideaId: 'i-missing', grade: 4, gradedBy: 'owner' });
      expect(res).toEqual({ applied: false, reason: 'not-found' });
    });
  });

  // ── workspace-scoped-coordination-2026-06-20 P-002 / D-006: K1 reversible
  //    sentinel keying for the Scout's lens-weight state behind FLAGS.WORKSPACE_COORDINATION.
  //    OFF = legacy per-hive (byte-identical); ON = ONE workspace-sentinel row
  //    (hive_slug = workspaceId), with read-fallback to the per-hive row.
  describe('K1 workspace-coordination scope (FLAGS.WORKSPACE_COORDINATION)', () => {
    afterAll(() => setFlagOverridesForTest(null));

    it('flag ON: persists lens weights under the workspace sentinel (pot_slug = workspaceId)', async () => {
      setFlagOverridesForTest({ [FLAGS.WORKSPACE_COORDINATION]: true });
      await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
      const rows = await db.adminSql<{ pot_slug: string }[]>`
        SELECT DISTINCT pot_slug FROM harness_shared.scout_lens_weights
         WHERE workspace_id = ${WS}`;
      const hives = rows.map((r) => r.pot_slug);
      expect(hives).toContain(WS); // the workspace-sentinel row was written
      // the ideator read-path resolves them back via the sentinel (read-fallback)
      const { lensWeights } = await getScoutLensWeights({ workspaceId: WS, harnessSlug: HARNESS });
      const total = (['analogical', 'first-principles', 'reframing', 'constraint-removal'] as const).reduce(
        (a, l) => a + lensWeights[l],
        0,
      );
      expect(total).toBeCloseTo(1, 6);
    });

    it('flag OFF: persists + reads under the per-hive slug (byte-identical to today)', async () => {
      setFlagOverridesForTest({ [FLAGS.WORKSPACE_COORDINATION]: false });
      await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
      const rows = await db.adminSql<{ pot_slug: string }[]>`
        SELECT DISTINCT pot_slug FROM harness_shared.scout_lens_weights
         WHERE workspace_id = ${WS}`;
      // the per-hive row (resolved hive-home of HARNESS, which falls back to the slug
      // itself in this test workspace) is present — the legacy keying is untouched.
      expect(rows.map((r) => r.pot_slug)).toContain(HARNESS);
    });
  });

  // workspace-scoped-coordination P-002 / D-003: routing-by-hive — a routed idea
  // derived from a rubric pattern carrying an @<hive> tag persists that hive as
  // target_hive (the cross-hive routing signal the workspace-Queen places on).
  // Ungated (pure provenance enrichment).
  describe('routing-by-hive (D-003 target_hive from the addressed pattern)', () => {
    it('a rubric pattern ref @<hive> populates target_hive on the routed idea', async () => {
      await recordRoutedIdea({
        ideaId: 'i-xhive',
        lens: 'analogical',
        rail: 'plan',
        routedRef: 'plan:cross-hive-x',
        harnessSlug: HARNESS,
        workspaceId: WS,
        addressesPatternRefs: ['rubric:pot-coordination-health#wake-latency@spreadsheet-hive'],
      });
      const rows = await db.adminSql<{ target_hive: string | null; source_hive: string | null }[]>`
        SELECT target_hive, source_hive FROM harness_shared.scout_routed_ideas WHERE idea_id = 'i-xhive'`;
      expect(rows[0]?.target_hive).toBe('spreadsheet-hive');
      expect(rows[0]?.source_hive).toBeTruthy(); // source still always populated (D-003 required)
    });

    it('a non-rubric pattern ref leaves target_hive null', async () => {
      await recordRoutedIdea({
        ideaId: 'i-selfhive',
        lens: 'reframing',
        rail: 'gym',
        routedRef: 'gym:sp-self',
        harnessSlug: HARNESS,
        workspaceId: WS,
        addressesPatternRefs: ['wi:F-9'],
      });
      const rows = await db.adminSql<{ target_hive: string | null }[]>`
        SELECT target_hive FROM harness_shared.scout_routed_ideas WHERE idea_id = 'i-selfhive'`;
      expect(rows[0]?.target_hive).toBeNull();
    });
  });

  // ── EI-11978: scout lens-weight DURABILITY. refreshScoutOutcomes recomputes
  //    lens weights LIVE from the Change Feed each cycle. The feed's completion
  //    readers are each a top-500 recency window (change-feed-deps.ts), so a scout
  //    idea whose winning artifact has since aged past that window is no longer
  //    joinable → classifyIdeaOutcome returns 'pending' → upsertScoutLensWeights
  //    OVERWRITES the persisted weights back toward uniform. su-ideate-learning-
  //    substrate P-016 fixed this exact window problem for origin='su-ideate' via
  //    a ledger-ref-scoped terminal read, but that was gated to su; scout never
  //    got it. gatherCompletionsForOrigin now folds scout's ref-scoped, WINDOW-FREE
  //    winning terminals into the completions join, so an aged-out win stays 'won'.
  //    Runs LAST — it seeds 520 filler completions that would perturb the count-
  //    sensitive outcome tests above.
  describe('EI-11978: aged-out scout wins stay durable (ref-scoped, window-free)', () => {
    const CYCLE = 'ei-11978-aged';
    const AGED_TS = Date.parse('2026-01-01T00:00:00Z'); // older than every filler
    const FILLER_BASE = Date.parse('2026-07-01T00:00:00Z'); // all strictly newer

    beforeAll(async () => {
      const sql = db.adminSql;
      // The aged scout win: a winning work-item WITH the WI-1403/WI-1405
      // completion-integrity pair (so it qualifies for the feed), but OLD.
      await sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (workspace_id, harness_slug, feature_id, title, status, updated_ts,
           terminal_owner, terminal_completion_ref)
        VALUES
          (${WS}, ${HARNESS}, 'F-AGED-WIN', 'aged scout win', 'passed', ${AGED_TS},
           'agent-x', 'landed in PR #99')`;
      // 520 NEWER winning completions (integrity-paired, but routed by NO scout
      // idea) — they fill the feed's top-500 window and push F-AGED-WIN out of it.
      await sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (workspace_id, harness_slug, feature_id, title, status, updated_ts,
           terminal_owner, terminal_completion_ref)
        SELECT ${WS}, ${HARNESS}, 'F-FILLER-' || g, 'filler ' || g, 'passed',
               (${FILLER_BASE}::bigint + g), 'filler-owner', 'filler-ref'
          FROM generate_series(1, 520) AS g`;
      // A scout idea routing a UNIQUE lens to the aged win, on a fresh cycle so
      // this assertion is fully isolated from the shared fixture above.
      await recordRoutedIdea({
        ideaId: 'i-aged-win', lens: 'constraint-removal', rail: 'improvement',
        routedRef: 'wi:F-AGED-WIN', harnessSlug: HARNESS, cycleId: CYCLE,
        title: 'aged-out scout win', workspaceId: WS,
      });
    }, 120_000);

    it('the raw feed drops the aged win (window guard) yet getScoutLensOutcomes recovers it as won', async () => {
      // Guard: the win is genuinely OUT of the raw feed window — so a recovered
      // 'won' can only come from the ref-scoped read, never a false green.
      const feed = await gatherCompletions(buildChangeFeedReaders());
      expect(feed.some((e) => e.ref === 'wi:F-AGED-WIN')).toBe(false);

      const report = await getScoutLensOutcomes({ workspaceId: WS, harnessSlug: HARNESS, cycleId: CYCLE });
      expect(report.total).toBe(1); // only the one cycle-scoped idea
      const cr = report.byLens['constraint-removal'];
      expect(cr.won).toBe(1); // pre-fix: 0 (aged out → pending)
      expect(cr.pending).toBe(0);
      expect(cr.winRate).toBe(1);
    });

    it('refreshScoutOutcomes persists the recovered win (durable, not reset to pending)', async () => {
      await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
      const [row] = await db.adminSql<{ outcome: string | null }[]>`
        SELECT outcome FROM harness_shared.scout_routed_ideas
         WHERE workspace_id = ${WS} AND idea_id = 'i-aged-win'`;
      expect(row.outcome).toBe('won');
    });
  });

  // ── GYM-3 (autonomous-loop-prod-audit-2026-07-02 P-013): the gym-rail and
  //    plan-rail terminal sources this task added. A dedicated cycle isolates
  //    these assertions from the shared corpus above.
  describe('GYM-3: gym_qd_archive terminal for Scout-seeded QD niches', () => {
    const CYCLE = 'gym3-archive';

    beforeAll(async () => {
      const sql = db.adminSql;
      // A LIVE gym (plan scout-su-ideate-pipeline-gaps-2026-10-08 P-002): an enabled
      // autoloop AND an active gym-cycle routine on this harness. Without both, the gym
      // rail is paused (paused-rails.ts) and a non-terminal gym idea is 'unresolvable',
      // not 'pending' — the paused case is asserted explicitly at the end of this block.
      await sql`
        INSERT INTO harness_shared.gym_autoloop_config (workspace_id, harness_slug, enabled, updated_at)
        VALUES (${WS}, ${HARNESS}, true, ${Date.now()})
        ON CONFLICT (workspace_id, harness_slug) DO UPDATE SET enabled = true`;
      await sql`
        INSERT INTO harness_shared.routines (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id)
        VALUES ('gym3-gym-cycle', ${HARNESS}, 'gym-cycle', 'schedule', '{}'::jsonb, 'worker', true, ${WS})
        ON CONFLICT (id) DO UPDATE SET active = true`;
      // A Scout-seeded candidate that STILL holds its QD niche (the reigning
      // elite) — router.ts always writes routedRef = `gym:<candidateId>`,
      // which is NEVER a gym_proposals.id (a compound `${variantId}__${role}`
      // key) — its only real terminal is the archive itself.
      await sql`
        INSERT INTO harness_shared.gym_qd_archive
          (workspace_id, harness_slug, niche_key, candidate_id, scope, domain, risk, fitness, descriptor, source, updated_at)
        VALUES
          (${WS}, ${HARNESS}, 'gym3|held|niche', 'qd-held-1', 'gym3', 'held', 'niche', 0,
           '{}'::jsonb, 'scout', ${Date.now()})`;
      await recordRoutedIdea({
        ideaId: 'i-qd-held', lens: 'analogical', rail: 'gym', routedRef: 'gym:qd-held-1',
        harnessSlug: HARNESS, cycleId: CYCLE, workspaceId: WS,
      });
      // A Scout-seeded candidate that never became (or no longer is) the elite —
      // no archive row, no gym_proposals row at all.
      await recordRoutedIdea({
        ideaId: 'i-qd-lost', lens: 'reframing', rail: 'gym', routedRef: 'gym:qd-lost-1',
        harnessSlug: HARNESS, cycleId: CYCLE, workspaceId: WS,
      });
    }, 60_000);

    it('a candidate still holding its niche classifies won; one that never did (or no longer does) classifies lost', async () => {
      const report = await getScoutLensOutcomes({ workspaceId: WS, harnessSlug: HARNESS, cycleId: CYCLE });
      expect(report.byLens.analogical).toMatchObject({ won: 1, lost: 0, pending: 0 });
      expect(report.byLens.reframing).toMatchObject({ won: 0, lost: 1, pending: 0 });
    });

    it('refreshScoutOutcomes persists both terminals to the ledger', async () => {
      await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
      const rows = await db.adminSql<{ idea_id: string; outcome: string | null }[]>`
        SELECT idea_id, outcome FROM harness_shared.scout_routed_ideas
         WHERE workspace_id = ${WS} AND idea_id IN ('i-qd-held', 'i-qd-lost')`;
      const byId = new Map(rows.map((r) => [r.idea_id, r.outcome]));
      expect(byId.get('i-qd-held')).toBe('won');
      expect(byId.get('i-qd-lost')).toBe('lost');
    });

    it('a candidate that DID advance to full proposal review stays pending under the archive read (never guessed lost)', async () => {
      // No archive row for 'qd-underreview-1', but an OPEN (still-pending)
      // gym_proposals row under the same id — the archive-lost read must defer
      // to it rather than pre-emptively calling it lost.
      await db.adminSql`
        INSERT INTO harness_shared.gym_proposals
          (id, workspace_id, harness_slug, role, variant_id, proposed_md, status, created_at)
        VALUES ('qd-underreview-1__worker', ${WS}, ${HARNESS}, 'worker', 'qd-underreview-1', '# v', 'pending', ${Date.now()})`;
      await recordRoutedIdea({
        ideaId: 'i-qd-underreview', lens: 'first-principles', rail: 'gym', routedRef: 'gym:qd-underreview-1',
        harnessSlug: HARNESS, cycleId: CYCLE, workspaceId: WS,
      });
      const report = await getScoutLensOutcomes({ workspaceId: WS, harnessSlug: HARNESS, cycleId: CYCLE });
      expect(report.byLens['first-principles']).toMatchObject({ won: 0, lost: 0, pending: 1 });
    });

    it('P-002: with the gym-cycle routine paused, the still-undecided gym idea is unresolvable and leaves pending; decided ones keep their verdict', async () => {
      await db.adminSql`
        UPDATE harness_shared.routines SET active = false
         WHERE workspace_id = ${WS} AND install_slug = ${HARNESS} AND name = 'gym-cycle'`;
      try {
        const report = await getScoutLensOutcomes({ workspaceId: WS, harnessSlug: HARNESS, cycleId: CYCLE });
        expect(report.byLens['first-principles']).toMatchObject({ won: 0, lost: 0, pending: 0, unresolvable: 1 });
        // A verdict reached before the pause still decides (not reclassified).
        expect(report.byLens.analogical).toMatchObject({ won: 1, lost: 0, pending: 0, unresolvable: 0 });
        expect(report.byLens.reframing).toMatchObject({ won: 0, lost: 1, pending: 0, unresolvable: 0 });

        await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
        const [row] = await db.adminSql<{ outcome: string | null }[]>`
          SELECT outcome FROM harness_shared.scout_routed_ideas
           WHERE workspace_id = ${WS} AND idea_id = 'i-qd-underreview'`;
        expect(row.outcome).toBe('unresolvable');
      } finally {
        await db.adminSql`
          UPDATE harness_shared.routines SET active = true
           WHERE workspace_id = ${WS} AND install_slug = ${HARNESS} AND name = 'gym-cycle'`;
      }
    });
  });

  describe('GYM-3: plan frontmatter status terminal (shipped/superseded, distinct from op_status)', () => {
    const CYCLE = 'gym3-plan-status';

    beforeAll(async () => {
      const sql = db.adminSql;
      // Both plans NEVER ran as a tracked harness op (op_status stays NULL) —
      // only the plan-store's own lifecycle status resolves them.
      await sql`
        INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, title, status)
        VALUES
          (${WS}, ${HARNESS}, 'gym3-shipped-draft', 'A shipped scout plan draft', 'shipped'),
          (${WS}, ${HARNESS}, 'gym3-superseded-draft', 'A superseded scout plan draft', 'superseded')`;
      await recordRoutedIdea({
        ideaId: 'i-plan-shipped', lens: 'analogical', rail: 'plan', routedRef: 'plan:gym3-shipped-draft',
        harnessSlug: HARNESS, cycleId: CYCLE, workspaceId: WS,
      });
      await recordRoutedIdea({
        ideaId: 'i-plan-superseded', lens: 'reframing', rail: 'plan', routedRef: 'plan:gym3-superseded-draft',
        harnessSlug: HARNESS, cycleId: CYCLE, workspaceId: WS,
      });
    }, 60_000);

    it('status=shipped classifies won; status=superseded classifies lost, both with op_status still NULL', async () => {
      const report = await getScoutLensOutcomes({ workspaceId: WS, harnessSlug: HARNESS, cycleId: CYCLE });
      expect(report.byLens.analogical).toMatchObject({ won: 1, lost: 0, pending: 0 });
      expect(report.byLens.reframing).toMatchObject({ won: 0, lost: 1, pending: 0 });
    });

    it('refreshScoutOutcomes persists both terminals to the ledger', async () => {
      await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
      const rows = await db.adminSql<{ idea_id: string; outcome: string | null }[]>`
        SELECT idea_id, outcome FROM harness_shared.scout_routed_ideas
         WHERE workspace_id = ${WS} AND idea_id IN ('i-plan-shipped', 'i-plan-superseded')`;
      const byId = new Map(rows.map((r) => [r.idea_id, r.outcome]));
      expect(byId.get('i-plan-shipped')).toBe('won');
      expect(byId.get('i-plan-superseded')).toBe('lost');
    });
  });

  // ── EI-20307121130730172: the wi rail must be able to record a LOSS AT ALL.
  //    It could not, for two months: `classifyIdeaOutcome` accepted exactly one
  //    losing wi terminal, 'deprecated' (31 rows workspace-wide, ZERO among the
  //    854 routed refs), while 'dropped' — 1,972 rows, and how work actually
  //    dies here — was in neither the win set nor the loss set. It produced no
  //    feed entry, so it read 'pending' forever: 100 wins, 0 losses, and a
  //    `winRate = won/(won+lost)` that could not fall for any ungraded filing.
  //
  //    A win-only channel is the metric analogue of a gate that never fires, so
  //    the assertion that matters is the CHANNEL one — this rail can produce a
  //    loss — not just that one status string maps somewhere. The 'open' case
  //    is the calibration control: it must still be pending, or a block where
  //    everything classifies 'lost' would pass this suite just as happily.
  describe('EI-20307121130730172: the wi rail can record a loss (dropped is the live loss terminal)', () => {
    const CYCLE = 'wi-loss-terminal';
    const T_WI = Date.parse('2026-08-01T00:00:00Z');

    beforeAll(async () => {
      // The dropped item deliberately carries NO completion-integrity pair
      // (terminal_owner / terminal_completion_ref): those columns exist to
      // prove a WIN shipped, and a dropped item never sets them — requiring
      // them on the loss arm would rebuild the zero-loss channel exactly.
      await db.adminSql`
        INSERT INTO harness_shared.harness_features_consolidated
          (workspace_id, harness_slug, feature_id, title, status, updated_ts)
        VALUES
          (${WS}, ${HARNESS}, 'F-WI-DROPPED', 'a dropped scout filing', 'dropped', ${T_WI}),
          (${WS}, ${HARNESS}, 'F-WI-DEPRECATED', 'a deprecated scout filing', 'deprecated', ${T_WI}),
          (${WS}, ${HARNESS}, 'F-WI-OPEN', 'a still-open scout filing', 'open', ${T_WI})`;
      await recordRoutedIdea({
        ideaId: 'i-wi-dropped', lens: 'first-principles', rail: 'improvement', routedRef: 'wi:F-WI-DROPPED',
        harnessSlug: HARNESS, cycleId: CYCLE, workspaceId: WS,
      });
      await recordRoutedIdea({
        ideaId: 'i-wi-deprecated', lens: 'constraint-removal', rail: 'improvement', routedRef: 'wi:F-WI-DEPRECATED',
        harnessSlug: HARNESS, cycleId: CYCLE, workspaceId: WS,
      });
      await recordRoutedIdea({
        ideaId: 'i-wi-open', lens: 'analogical', rail: 'improvement', routedRef: 'wi:F-WI-OPEN',
        harnessSlug: HARNESS, cycleId: CYCLE, workspaceId: WS,
      });
    }, 60_000);

    it('a scout idea whose work-item was DROPPED classifies lost, not pending forever', async () => {
      const report = await getScoutLensOutcomes({ workspaceId: WS, harnessSlug: HARNESS, cycleId: CYCLE });
      expect(report.byLens['first-principles']).toMatchObject({ won: 0, lost: 1, pending: 0 }); // pre-fix: pending 1
      // The rail-level property, stated directly: the loss channel is LIVE.
      const wiLosses = report.byLens['first-principles'].lost + report.byLens['constraint-removal'].lost;
      expect(wiLosses).toBeGreaterThan(0);
    });

    it("'deprecated' still classifies lost — the fix widened the vocabulary, it did not swap it", async () => {
      const report = await getScoutLensOutcomes({ workspaceId: WS, harnessSlug: HARNESS, cycleId: CYCLE });
      expect(report.byLens['constraint-removal']).toMatchObject({ won: 0, lost: 1, pending: 0 });
    });

    it('CONTROL: a still-open work item stays pending — the rail did not simply start calling everything lost', async () => {
      const report = await getScoutLensOutcomes({ workspaceId: WS, harnessSlug: HARNESS, cycleId: CYCLE });
      expect(report.byLens.analogical).toMatchObject({ won: 0, lost: 0, pending: 1 });
    });

    it('refreshScoutOutcomes persists the loss terminals to the ledger', async () => {
      await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
      const rows = await db.adminSql<{ idea_id: string; outcome: string | null }[]>`
        SELECT idea_id, outcome FROM harness_shared.scout_routed_ideas
         WHERE workspace_id = ${WS} AND idea_id IN ('i-wi-dropped', 'i-wi-deprecated', 'i-wi-open')`;
      const byId = new Map(rows.map((r) => [r.idea_id, r.outcome]));
      expect(byId.get('i-wi-dropped')).toBe('lost');
      expect(byId.get('i-wi-deprecated')).toBe('lost');
      expect(byId.get('i-wi-open')).toBe('pending');
    });
  });

  // Goal Rail P-005: the pure classifier already pins achieved -> won and
  // killed -> lost. This suite proves the production, migrated-PG seam that
  // supplies those terminal entries and persists the resulting learning signal.
  // A dedicated cycle keeps both goal ideas out of every count-sensitive case
  // above, and the fixtures never touch the organic routed-idea ledger.
  describe('Goal Rail P-005: terminal goals close the routed-idea learning loop', () => {
    const CYCLE = 'p005-goal-terminal';
    const ACHIEVED_GOAL = 'p005-goal-achieved';
    const KILLED_GOAL = 'p005-goal-killed';

    beforeAll(async () => {
      const achievedAt = new Date('2026-08-20T20:00:00.000Z');
      const killedAt = new Date('2026-08-20T20:01:00.000Z');
      await db.adminSql`
        INSERT INTO harness_shared.goals
          (id, workspace_id, install_slug, title, status, created_at, updated_at)
        VALUES
          (${ACHIEVED_GOAL}, ${WS}, ${HARNESS}, 'P-005 achieved goal', 'achieved', ${achievedAt}, ${achievedAt}),
          (${KILLED_GOAL}, ${WS}, ${HARNESS}, 'P-005 killed goal', 'killed', ${killedAt}, ${killedAt})`;
      await recordRoutedIdea({
        ideaId: 'i-goal-achieved', lens: 'analogical', rail: 'goal', routedRef: `goal:${ACHIEVED_GOAL}`,
        harnessSlug: HARNESS, cycleId: CYCLE, workspaceId: WS,
      });
      await recordRoutedIdea({
        ideaId: 'i-goal-killed', lens: 'reframing', rail: 'goal', routedRef: `goal:${KILLED_GOAL}`,
        harnessSlug: HARNESS, cycleId: CYCLE, workspaceId: WS,
      });
    }, 60_000);

    it('renders achieved and killed goals as production Change Feed terminal entries', async () => {
      const completions = await buildScoutOutcomeReaders({
        workspaceId: WS,
        harnessSlug: HARNESS,
        cycleId: CYCLE,
      }).completions();
      const byRef = new Map(completions.map((entry) => [entry.ref, entry]));

      expect(byRef.get(`goal:${ACHIEVED_GOAL}`)).toMatchObject({
        id: `goal:${ACHIEVED_GOAL}`,
        kind: 'completion',
        title: 'Goal achieved: P-005 achieved goal',
        detail: 'Status: achieved',
        harness: HARNESS,
        ref: `goal:${ACHIEVED_GOAL}`,
      });
      expect(byRef.get(`goal:${KILLED_GOAL}`)).toMatchObject({
        id: `goal:${KILLED_GOAL}`,
        kind: 'completion',
        title: 'Goal killed: P-005 killed goal',
        detail: 'Status: killed',
        harness: HARNESS,
        ref: `goal:${KILLED_GOAL}`,
      });
    });

    it('classifies achieved as won and killed as lost through the production readers', async () => {
      const report = await getScoutLensOutcomes({
        workspaceId: WS,
        harnessSlug: HARNESS,
        cycleId: CYCLE,
      });
      expect(report.byLens.analogical).toMatchObject({ won: 1, lost: 0, pending: 0 });
      expect(report.byLens.reframing).toMatchObject({ won: 0, lost: 1, pending: 0 });
    });

    it('refreshScoutOutcomes persists won/lost plus the checked timestamp', async () => {
      await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS, cycleId: CYCLE });
      const rows = await db.adminSql<
        { idea_id: string; outcome: string | null; outcome_checked_at: string | null }[]
      >`
        SELECT idea_id, outcome, outcome_checked_at
          FROM harness_shared.scout_routed_ideas
         WHERE workspace_id = ${WS}
           AND idea_id IN ('i-goal-achieved', 'i-goal-killed')`;
      const byId = new Map(rows.map((row) => [row.idea_id, row]));
      expect(byId.get('i-goal-achieved')).toMatchObject({ outcome: 'won' });
      expect(byId.get('i-goal-killed')).toMatchObject({ outcome: 'lost' });
      expect(byId.get('i-goal-achieved')?.outcome_checked_at).toBeTruthy();
      expect(byId.get('i-goal-killed')?.outcome_checked_at).toBeTruthy();
    });
  });
});
