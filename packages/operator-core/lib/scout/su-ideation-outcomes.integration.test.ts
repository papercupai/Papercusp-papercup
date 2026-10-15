/**
 * su-ideation-outcomes.integration.test.ts — su-ideate-learning-substrate-2026-07-10
 * P-003: the OUTCOME READBACK leg of the su ideation learning loop, against real
 * migrated Postgres. Pins:
 *  - blender:ideation-feedback's outcomes[] + summary classify a su filing by its
 *    routed artifact's fate — resolved wi ⇒ won, deprecated wi ⇒ lost (the su
 *    loss-read the production feed deliberately omits), open wi ⇒ pending — with
 *    grade passthrough (humanGrade/gradedBy) and grade-BLIND outcome counts (D-002);
 *  - scout isolation: a scout-origin row never appears in the su read, and the
 *    WORKSPACE-WIDE (un-ref-scoped) su loss-read never reaches the scout path.
 *    Scout classifies a losing ref through its OWN ref-scoped loss arm instead
 *    (EI-20307121130730172) — so a scout idea on the same losing ref is 'lost',
 *    not the 'pending' the win-only wi rail used to return;
 *  - refreshScoutOutcomes({ origin:'su-ideate' }) (the P-016 backfill sweep)
 *    persists the su outcome cache but NEVER writes scout_lens_weights (D-003 —
 *    su lens learning is read-time only), while the default scout refresh still
 *    closes the weight loop (the guard is origin-based, not broken plumbing);
 *  - lensWinRates[] (P-004): per-su-lens win-rates over the full
 *    SU_IDEATION_LENSES roster at read time (grade-dominated, sentinel rows in
 *    no lens row, floored sampling weights summing to 1) — with the D-003
 *    weight-table emptiness re-checked AFTER the read (read-time truly means
 *    no write).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SU_IDEATION_LENSES } from './types';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
// PARTIAL mock: the tool module's import graph (agent-mcp bootstrap) reads the
// real `generated` schema export, so only the connection accessor is faked.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
// recordRoutedIdea / gradeRoutedIdea fire-and-forget a learning.scout invalidate
// via a lazy import — mock the SSE seam so it is a no-op under test.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { recordRoutedIdea, gradeRoutedIdea, getScoutLensOutcomes, refreshScoutOutcomes } =
  await import('./routed-ledger');
const { runIdeationFeedback } = await import('../agent-tools/scout/ideation-feedback');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-su-ideation-outcomes';
const HARNESS = 'papercup';
const T = Date.parse('2026-07-10T08:00:00Z');

describe('su ideation outcome readback (real PG — P-003)', () => {
  let db: OrgTestDb;
  let envBefore: string | undefined;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    // Pin activeWorkspaceId() for the handler path (it passes no workspaceId,
    // resolving from ALS/env like production).
    envBefore = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;

    // Three su-ideate filings — one per fate — plus a SCOUT idea routed to the
    // SAME deprecated ref (the loss-read must never reach the scout path).
    await recordRoutedIdea({
      origin: 'su-ideate', ideaId: 'su-won', lens: 'user-value', rail: 'improvement',
      routedRef: 'wi:EI-SU-WON', harnessSlug: HARNESS, title: 'ship the felt thing',
      workspaceId: WS, routedAt: T, createdBy: 'su-test-1',
    });
    await recordRoutedIdea({
      origin: 'su-ideate', ideaId: 'su-lost', lens: 'risk-first', rail: 'improvement',
      routedRef: 'wi:F-SU-LOST', harnessSlug: HARNESS, title: 'de-risk the rig',
      workspaceId: WS, routedAt: T + 1000, createdBy: 'su-test-1',
    });
    await recordRoutedIdea({
      origin: 'su-ideate', ideaId: 'su-open', lens: 'su-ideate', rail: 'improvement',
      routedRef: 'wi:EI-SU-OPEN', harnessSlug: HARNESS, title: 'sentinel-lens idea',
      workspaceId: WS, routedAt: T + 2000, createdBy: 'su-test-2',
    });
    await recordRoutedIdea({
      ideaId: 'scout-dep', lens: 'analogical', rail: 'improvement',
      routedRef: 'wi:F-SU-LOST', harnessSlug: HARNESS, title: 'scout idea on the deprecated ref',
      workspaceId: WS, routedAt: T + 3000,
    });

    // The routed artifacts. Winning terminals need the WI-1403/WI-1405
    // completion-integrity pair to enter the change feed; the deprecated LOSS
    // deliberately carries none (a hygiene deprecation still counts as lost).
    await db.adminSql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, scope, title, state, updated_at,
         terminal_owner, terminal_completion_ref)
      VALUES
        (${WS}, 'EI-SU-WON', 'harness:papercup', 'shipped su filing', 'resolved',
         ${new Date(T + 10_000)}, 'su-test-1', 'landed in PR #7'),
        (${WS}, 'EI-SU-OPEN', 'harness:papercup', 'still-open su filing', 'open',
         ${new Date(T + 10_000)}, NULL, NULL)`;
    await db.adminSql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, updated_ts)
      VALUES
        (${WS}, ${HARNESS}, 'F-SU-LOST', 'deprecated su filing', 'deprecated', ${T + 10_000})`;

    // One graded filing so grade passthrough + priming compose with outcomes.
    await gradeRoutedIdea({
      ideaId: 'su-won', grade: 5, feedback: 'exactly the felt need', gradedBy: 'owner',
    });
  }, 120_000);

  afterAll(async () => {
    if (envBefore === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = envBefore;
    await db?.cleanup();
  });

  it('outcomes[]: resolved ⇒ won, deprecated ⇒ lost, open ⇒ pending; grades ride along; scout rows excluded', async () => {
    const res = await runIdeationFeedback({});
    const byId = new Map(res.outcomes.map((o) => [o.ideaId, o]));

    expect(byId.get('su-won')).toMatchObject({
      rail: 'improvement', routedRef: 'wi:EI-SU-WON', outcome: 'won',
      humanGrade: 5, gradedBy: 'owner', title: 'ship the felt thing',
    });
    expect(byId.get('su-lost')).toMatchObject({ routedRef: 'wi:F-SU-LOST', outcome: 'lost' });
    expect(byId.get('su-open')).toMatchObject({ routedRef: 'wi:EI-SU-OPEN', outcome: 'pending' });
    expect(byId.get('su-open')?.humanGrade).toBeUndefined();
    // Origin isolation: the scout row sharing the deprecated ref is NOT ours.
    expect(byId.has('scout-dep')).toBe(false);

    // `unresolvable` (scout-su-ideate-pipeline-gaps-2026-10-08 P-002): no paused rail here, so 0.
    expect(res.summary).toEqual({ won: 1, lost: 1, pending: 1, unresolvable: 0, graded: 1, total: 3 });
    expect(res.outcomesError).toBeUndefined();

    // The priming leg still composes: the graded filing appears, newest-first.
    expect(res.count).toBe(1);
    expect(res.entries[0]).toContain('★5');
    expect(res.entries[0]).toContain('ship the felt thing: exactly the felt need');
  });

  it('lensWinRates[] (P-004): per-su-lens tallies over the full 7-lens roster, sentinel excluded, floored weights sum to 1', async () => {
    const res = await runIdeationFeedback({});
    // One row per SU_IDEATION_LENSES member, roster order — never a sentinel row.
    expect(res.lensWinRates.map((r) => r.lens)).toEqual([...SU_IDEATION_LENSES]);
    const byLens = new Map(res.lensWinRates.map((r) => [r.lens, r]));

    // su-won (user-value, grade 5): the grade DOMINATES the tally — full win mass.
    expect(byLens.get('user-value')).toMatchObject({ ideas: 1, won: 1, lost: 0, pending: 0, winRate: 1 });
    // su-lost (risk-first, deprecated wi): the loss-read decides it.
    expect(byLens.get('risk-first')).toMatchObject({ ideas: 1, won: 0, lost: 1, pending: 0, winRate: 0 });
    // A roster lens with no su filings: present, neutral, floor-alive.
    expect(byLens.get('analogical')).toMatchObject({ ideas: 0, winRate: null });
    // su-open declared the 'su-ideate' sentinel — it is in outcomes/summary (total 3)
    // but in NO lens row (already pinned by the roster equality above).

    // The anti-strangle floor: every lens keeps a positive share, the shares are a
    // distribution, and the winner outweighs the loser.
    for (const r of res.lensWinRates) expect(r.weight).toBeGreaterThan(0);
    const sum = res.lensWinRates.reduce((a, r) => a + r.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(byLens.get('user-value')!.weight).toBeGreaterThan(byLens.get('risk-first')!.weight);
  });

  it("refreshScoutOutcomes({ origin:'su-ideate' }) persists the su outcome cache but NEVER writes scout_lens_weights (D-003)", async () => {
    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS, origin: 'su-ideate' });

    const rows = await db.adminSql<{ idea_id: string; outcome: string | null }[]>`
      SELECT idea_id, outcome FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${WS} ORDER BY idea_id`;
    const byId = Object.fromEntries(rows.map((r) => [r.idea_id, r.outcome]));
    expect(byId['su-won']).toBe('won');
    expect(byId['su-lost']).toBe('lost');
    expect(byId['su-open']).toBe('pending');
    // The su sweep only touches su rows — the scout row's cache is still unset.
    expect(byId['scout-dep']).toBeNull();

    const weights = await db.adminSql<{ n: string }[]>`
      SELECT count(*) AS n FROM harness_shared.scout_lens_weights WHERE workspace_id = ${WS}`;
    expect(Number(weights[0].n)).toBe(0);
  });

  it("the scout path classifies its OWN ref-scoped loss (EI-20307121130730172) while the unscoped su loss-read stays su-only, and the weight loop still closes", async () => {
    // Read path: the scout idea on the losing ref classifies 'lost' — via
    // readScoutRefScopedTerminalEntries' own wi loss arm, which is scoped to
    // origin='scout' routed refs exactly like the plan (P-006) and gym-archive
    // (GYM-3) loss arms beside it.
    //
    // ⚠ This assertion was 'pending' until EI-20307121130730172, guarding a
    // real concern (readWorkItemLossEntries is a WORKSPACE-WIDE, un-ref-scoped
    // LIMIT-500 read — leaking THAT into scout would classify scout ideas off
    // an unrelated global query). That read is still su-only in
    // gatherCompletionsForOrigin, and `total === 1` below still pins the
    // ref-scope. What it ALSO froze, though, was the wi rail being win-only:
    // 854 routed refs, 100 wins, ZERO losses in two months, so `winRate =
    // won/(won+lost)` could not fall for any ungraded filing. Scout is ~9%
    // graded, so it is the population that read was silently protecting from
    // ever losing.
    const report = await getScoutLensOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    expect(report.total).toBe(1);
    expect(report.byLens.analogical.routed).toBe(1);
    expect(report.byLens.analogical.lost).toBe(1);
    expect(report.byLens.analogical.pending).toBe(0);

    // Refresh path: same classification persisted, and the D-003 guard is
    // origin-based — the DEFAULT refresh still writes the lens weights.
    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });
    const [row] = await db.adminSql<{ outcome: string | null }[]>`
      SELECT outcome FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${WS} AND idea_id = 'scout-dep'`;
    expect(row.outcome).toBe('lost');

    const weights = await db.adminSql<{ n: string }[]>`
      SELECT count(*) AS n FROM harness_shared.scout_lens_weights WHERE workspace_id = ${WS}`;
    expect(Number(weights[0].n)).toBeGreaterThan(0);
  });
});
