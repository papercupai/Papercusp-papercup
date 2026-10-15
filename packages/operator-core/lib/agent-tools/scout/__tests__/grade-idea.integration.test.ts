/**
 * grade-idea.integration.test.ts — EI-15389 recurrence guard against real migrated
 * Postgres. The bug: blender:grade-idea silently no-op'd when keyed by a BARE
 * work-item id (`EI-15375`) instead of the cycle-prefixed ledger idea_id, because
 * a Scout-dispatched row is keyed by the full idea_id and found only via its
 * `routed_ref` (`wi:EI-15375`). Grades vanished; the ungraded backlog grew.
 *
 * This pins the REAL resolution SQL (resolveIdeaIdFromKey, exercised through the
 * default-deps runGradeIdea) — the unit suite mocks that resolver, so only a
 * real-PG test proves the query actually lands the grade on the right row.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
// Keep db-org's generated schema exports intact: importing the projected
// blender tool loads agent-mcp bootstrap, which reads generated.* at module
// initialization. Only replace the PG handle used by this real-PG fixture.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { runGradeIdea } = await import('../grade-idea');
const { recordRoutedIdea } = await import('../../../scout/routed-ledger');
const { claimAgentReview } = await import('../../../harness/improvements/agent-review');
const { getWorkItem } = await import('../../../work-items');
const { createOrgTestDb } = await import('../../../../test/_org-test-db');

const WS = 'ws-grade-idea-ei15389';
const HARNESS = 'papercup';

describe('blender:grade-idea by bare work-item id (EI-15389, real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;

    // A Scout-dispatched work-item idea: keyed by the CYCLE-PREFIXED idea_id, found
    // by a caller only via routed_ref 'wi:EI-777' (the exact bug shape).
    await recordRoutedIdea({
      ideaId: 'scout-1784334639774:scout-idea-reframing-1-1',
      lens: 'reframing',
      rail: 'improvement',
      routedRef: 'wi:EI-777',
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      cycleId: 'c1',
      title: 'routed work-item idea',
      workspaceId: WS,
    });
    // A gym idea: routed_ref 'gym:SP-002' — the 'gym:' prefix branch.
    await recordRoutedIdea({
      ideaId: 'scout-1784334639774:scout-idea-analogical-2-1',
      lens: 'analogical',
      rail: 'gym',
      routedRef: 'gym:SP-002',
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      cycleId: 'c1',
      title: 'routed gym idea',
      workspaceId: WS,
    });
    // A fresh row for the identified-SU attribution regression. Keep it
    // separate from SP-002, which the preceding human-grade test intentionally
    // claims for the owner and therefore cannot be regraded by an agent.
    await recordRoutedIdea({
      ideaId: 'scout-1784334639774:scout-idea-constraint-removal-3-1',
      lens: 'constraint-removal',
      rail: 'improvement',
      routedRef: 'wi:SU-003',
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      cycleId: 'c1',
      title: 'identified SU attribution idea',
      workspaceId: WS,
    });
    // A su re-route row keyed by the BARE work-item id DIRECTLY (route-idea.ts
    // re-route path) — the direct-idea_id branch must still resolve.
    await recordRoutedIdea({
      ideaId: 'EI-888',
      lens: 'su-ideate',
      rail: 'plan',
      routedRef: 'plan:some-plan-2026-07-19',
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      cycleId: 'c1',
      title: 'su re-routed idea',
      workspaceId: WS,
    });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function humanGradeOf(ideaId: string): Promise<{ human_grade: number | null; graded_by: string | null } | undefined> {
    const rows = await db.adminSql<{ human_grade: number | null; graded_by: string | null }[]>`
      SELECT human_grade, graded_by FROM harness_shared.scout_routed_ideas WHERE idea_id = ${ideaId}`;
    return rows[0];
  }

  it('a bare work-item id (EI-777) resolves via routed_ref and the grade LANDS on the cycle-prefixed row', async () => {
    const out = await runGradeIdea({ ideaId: 'EI-777', grade: 4, feedback: 'sharp reframe' }, { role: 'mug' });
    expect(out.applied).toBe(true);
    expect(out.ideaId).toBe('scout-1784334639774:scout-idea-reframing-1-1');

    const row = await humanGradeOf('scout-1784334639774:scout-idea-reframing-1-1');
    expect(row).toBeDefined();
    expect(Number(row!.human_grade)).toBe(4);
    expect(row!.graded_by).toBe('auto-grader');
  });

  it('a bare gym id (SP-002) resolves via the gym: routed_ref prefix', async () => {
    const out = await runGradeIdea({ ideaId: 'SP-002', grade: 2 }, undefined);
    expect(out.applied).toBe(true);
    expect(out.ideaId).toBe('scout-1784334639774:scout-idea-analogical-2-1');
    const row = await humanGradeOf('scout-1784334639774:scout-idea-analogical-2-1');
    expect(Number(row!.human_grade)).toBe(2);
    expect(row!.graded_by).toBe('owner');
  });

  it('an identified su caller writes its ownerId, leaving the literal owner for human grades', async () => {
    const out = await runGradeIdea(
      { ideaId: 'SU-003', grade: 4, feedback: 'steward signal' },
      { role: 'operator', ownerId: 'su-steward-grade-1' },
    );
    expect(out.applied).toBe(true);
    expect(out.gradedBy).toBe('su-steward-grade-1');
    const row = await humanGradeOf('scout-1784334639774:scout-idea-constraint-removal-3-1');
    expect(row!.graded_by).toBe('su-steward-grade-1');
  });

  it('a bare id whose row is keyed DIRECTLY by that id (su re-route) still resolves', async () => {
    const out = await runGradeIdea({ ideaId: 'EI-888', grade: 5, feedback: 'love it' }, { role: 'mug' });
    expect(out.applied).toBe(true);
    expect(out.ideaId).toBe('EI-888');
    const row = await humanGradeOf('EI-888');
    expect(Number(row!.human_grade)).toBe(5);
  });

  it('an unresolvable bare id returns a LOUD not-found (never a success-shaped no-op)', async () => {
    const out = await runGradeIdea({ ideaId: 'EI-does-not-exist', grade: 3 }, { role: 'mug' });
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('not-found');
    expect(out.ideaId).toBeNull();
  });
});

describe('blender:grade-idea keyed by routedRef (EI-21864158051054483, real PG)', () => {
  // EI-21864158051054483: an agent-review caller routinely holds only the BARE
  // work-item id, not the canonical `wi:<id>`/`gym:<id>` change-feed ref this
  // path's docstring calls "the accepted reference format" — a straight
  // symmetry gap against the ideaId-side fix already proven above (EI-15389).
  // Own fixture rows (not the shared beforeAll set) so each test is independent
  // of grading order/sovereignty from the ideaId-keyed suite above.
  let db: OrgTestDb;
  const WS2 = 'ws-grade-idea-ei21864158051054483';

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function humanGradeOf(ideaId: string): Promise<{ human_grade: number | null; graded_by: string | null } | undefined> {
    const rows = await db.adminSql<{ human_grade: number | null; graded_by: string | null }[]>`
      SELECT human_grade, graded_by FROM harness_shared.scout_routed_ideas WHERE idea_id = ${ideaId}`;
    return rows[0];
  }

  it('a bare work-item id passed as routedRef resolves via the wi: prefix fallback', async () => {
    await recordRoutedIdea({
      ideaId: 'scout-1784334639774:scout-idea-reframing-9-1',
      lens: 'reframing',
      rail: 'improvement',
      routedRef: 'wi:EI-19991080208681012',
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      cycleId: 'c9',
      title: 'agent-review routed work-item idea',
      workspaceId: WS2,
    });
    // Reproduces the exact reported shape: routedRef holds the bare work-item
    // id (the id an agent-review round is keyed by), not `wi:<id>`.
    const out = await runGradeIdea({ routedRef: 'EI-19991080208681012', grade: 4 }, { role: 'mug' });
    expect(out.applied).toBe(true);
    expect(out.ideaId).toBe('scout-1784334639774:scout-idea-reframing-9-1');
    const row = await humanGradeOf('scout-1784334639774:scout-idea-reframing-9-1');
    expect(Number(row!.human_grade)).toBe(4);
  });

  it('a bare gym id passed as routedRef resolves via the gym: prefix fallback', async () => {
    await recordRoutedIdea({
      ideaId: 'scout-1784334639774:scout-idea-analogical-9-2',
      lens: 'analogical',
      rail: 'gym',
      routedRef: 'gym:SP-901',
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      cycleId: 'c9',
      title: 'agent-review routed gym idea',
      workspaceId: WS2,
    });
    const out = await runGradeIdea({ routedRef: 'SP-901', grade: 3 }, { role: 'mug' });
    expect(out.applied).toBe(true);
    expect(out.ideaId).toBe('scout-1784334639774:scout-idea-analogical-9-2');
  });

  it('a bare id passed as routedRef whose row is keyed DIRECTLY by that id still resolves', async () => {
    await recordRoutedIdea({
      ideaId: 'EI-999',
      lens: 'su-ideate',
      rail: 'plan',
      routedRef: 'plan:some-other-plan-2026-07-20',
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      cycleId: 'c9',
      title: 'su re-routed idea (direct idea_id)',
      workspaceId: WS2,
    });
    const out = await runGradeIdea({ routedRef: 'EI-999', grade: 5 }, { role: 'mug' });
    expect(out.applied).toBe(true);
    expect(out.ideaId).toBe('EI-999');
  });

  it('a canonical wi: ref passed as routedRef still resolves via the exact match (no regression)', async () => {
    await recordRoutedIdea({
      ideaId: 'scout-1784334639774:scout-idea-firstprinciples-9-3',
      lens: 'first-principles',
      rail: 'improvement',
      routedRef: 'wi:EI-777900',
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      cycleId: 'c9',
      title: 'canonical-ref regression guard',
      workspaceId: WS2,
    });
    const out = await runGradeIdea({ routedRef: 'wi:EI-777900', grade: 5 }, { role: 'mug' });
    expect(out.applied).toBe(true);
    expect(out.ideaId).toBe('scout-1784334639774:scout-idea-firstprinciples-9-3');
  });

  it('an unresolvable bare routedRef returns a LOUD not-found (never a success-shaped no-op)', async () => {
    const out = await runGradeIdea({ routedRef: 'EI-nonexistent-999999', grade: 3 }, { role: 'mug' });
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('not-found');
    expect(out.ideaId).toBeNull();
  });
});

describe('prefixed agent-review grading (EI-24742538368325488, real PG)', () => {
  const workspace = 'ws-grade-idea-prefixed-review';
  const harness = 'papercusp';
  const reviewer = 'su-prefixed-grade-reviewer';
  const submitter = 'su-prefixed-grade-author';
  let db: OrgTestDb;
  let priorWorkspace: string | undefined;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    priorWorkspace = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = workspace;
  }, 120_000);

  afterAll(async () => {
    if (priorWorkspace === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = priorWorkspace;
    await db?.cleanup();
  });

  async function pendingReview(id: string, ledgerIdeaId: string): Promise<void> {
    const now = new Date('2026-10-06T00:00:00.000Z');
    // Use the same migrated issue view as the plan-route integration fixture.
    // All writes stay in this throwaway DB; the production review lifecycle and
    // resolver use their default dependencies rather than mocked SQL results.
    await db.adminSql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source, state,
         payload, created_by, signal_origin, created_at, updated_at, admission)
      VALUES
        (${workspace}, ${id}, 'change', ${`harness:${harness}`},
         'Prefixed lookup must grade the pending review', 'Private integration fixture',
         'minor', 'engineer', 'open',
         ${JSON.stringify({
           agentReview: { status: 'pending', submittedBy: submitter, ledgerIdeaId, round: 1 },
         })}::text::jsonb,
         ${submitter}, 'organic', ${now}, ${now}, 'pending')`;
    await recordRoutedIdea({
      ideaId: ledgerIdeaId,
      lens: 'agent-review',
      rail: 'improvement',
      routedRef: `wi:${id}`,
      harnessSlug: harness,
      workspaceId: workspace,
      origin: 'agent-review',
      createdBy: submitter,
      title: 'Prefixed lookup must grade the pending review',
    });
    const claim = await claimAgentReview({ id, reviewer, harnessSlug: harness });
    expect(claim.claimed).toBe(true);
  }

  async function assertApproved(id: string, ledgerIdeaId: string): Promise<void> {
    const [ledger] = await db.adminSql<{ human_grade: number; graded_by: string }[]>`
      SELECT human_grade, graded_by FROM harness_shared.scout_routed_ideas
       WHERE idea_id = ${ledgerIdeaId}`;
    expect(Number(ledger.human_grade)).toBe(5);
    expect(ledger.graded_by).toBe(reviewer);
    const item = await getWorkItem(id, harness);
    expect((item!.payload as { agentReview: { status: string; ledgerIdeaId: string } }).agentReview)
      .toMatchObject({ status: 'approved', ledgerIdeaId });
    expect(item!.assignee).toBeNull();
  }

  it('falls back from a missing prefixed key, persists the grade, and approves the bare-keyed review', async () => {
    const id = 'EI-PREFIXED-GRADE-BARE';
    await pendingReview(id, id);
    const out = await runGradeIdea(
      { ideaId: `agent-review:${id}`, grade: 5, feedback: 'Ready for implementation.' },
      { ownerId: reviewer, role: 'operator' },
    );
    expect(out).toMatchObject({
      applied: true,
      ideaId: id,
      agentReview: { workItemId: id, status: 'approved', changed: true },
    });
    await assertApproved(id, id);
  });

  it('keeps exact prefixed authority and leaves the colliding historical bare row ungraded', async () => {
    const id = 'EI-PREFIXED-GRADE-COLLISION';
    const ledgerIdeaId = `agent-review:${id}`;
    await recordRoutedIdea({
      ideaId: id,
      lens: 'su-ideate',
      rail: 'plan',
      routedRef: 'plan:historical-prefixed-grade-fixture',
      harnessSlug: harness,
      workspaceId: workspace,
      title: 'Historical plan authority',
    });
    await pendingReview(id, ledgerIdeaId);
    const out = await runGradeIdea(
      { ideaId: ledgerIdeaId, grade: 5, feedback: 'Ready for implementation.' },
      { ownerId: reviewer, role: 'operator' },
    );
    expect(out).toMatchObject({
      applied: true,
      ideaId: ledgerIdeaId,
      agentReview: { workItemId: id, status: 'approved', changed: true },
    });
    await assertApproved(id, ledgerIdeaId);
    const [historical] = await db.adminSql<{ human_grade: number | null; graded_by: string | null }[]>`
      SELECT human_grade, graded_by FROM harness_shared.scout_routed_ideas WHERE idea_id = ${id}`;
    expect(historical).toEqual({ human_grade: null, graded_by: null });
  });
});
