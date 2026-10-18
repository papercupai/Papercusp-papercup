/**
 * emit-acceptance-reference.integration.test.ts — P-003 author acceptance by EXACT
 * independent scorecard reference, against real migrated Postgres.
 *
 * Clause SPEC-P003-SCORECARD-REFERENCE@1 requires BOTH an integration and a unit
 * layer, and names three pieces of evidence: an authorized reference acceptance,
 * a PERSISTENCE READBACK, and wrong-subject + prohibited-lineage negative controls.
 * The sibling unit suite (emit-evaluate.test.ts) mocks `listScorecards` and
 * `captureImprovement`, so it can only assert what emit *tried* to write. That is
 * precisely what cannot answer the readback requirement: a mocked capture proves
 * the call shape, never that the adopted ratings and their provenance survived the
 * round trip through `engineer_issues.payload->'observation'` and read back as a
 * complete card. Everything here therefore runs against a real database:
 *   - the rubric resolves through the live `getRubric` store (harness_plans),
 *   - the independent grading is a real ledger row read back by the real
 *     `listScorecards` (which recomputes rubricResolved/missingKeys itself, so an
 *     ineligible fixture cannot be faked into eligibility),
 *   - the author's verdict is persisted by the real capture path and then SELECTed
 *     back out of Postgres and asserted on.
 *
 * Docker-gated, like every `*.integration.test.ts` here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

// Re-point reads AND writes at the migrated throwaway DB. Spread the ACTUAL module
// rather than hand-listing exports: this import graph transitively reaches other
// db-org consumers that touch exports at module load, and vitest throws on any
// access to an export missing from a partial mock.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(ws: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
      (h.sql as postgres.Sql).begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return cb(tx as unknown as postgres.Sql);
      }) as Promise<T>,
  };
});

const { emitScorecard } = await import('./emit');
const { getRubricCriteriaHash } = await import('../../rubrics');
const { createIssue, issuesScopeWorkspace } = await import('../../issues-engineer');
const { OBSERVATION_TOPIC } = await import('../../harness/improvements/read-items');
const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../workspace-registry');
const { drainDetached } = await import('../../detached-imports');
const { getReport } = await import('../../report-library');
const { captureAcceptanceVerdict } = await import('../../report-capture');

/** The acceptance-rubric AUTHOR — the implementer, the only party who may record a verdict. */
const AUTHOR = 'su-p003-author';
/** A genuinely independent grader: outside the author's lineage. */
const GRADER = 'su-p003-grader';
const RUBRIC = 'p003-acceptance-rubric';
const SUBJECT_PLAN = 'p003-subject-plan';
/** The rubric's harness_plans.version — the card's rubricRevision must equal it or
 *  the stale-revision rail fires before adoption. */
const REVISION = 3;

const CRITERIA = [
  {
    key: 'reference-fidelity',
    title: 'Reference fidelity',
    model: 'The verdict cites the exact independent card whose ratings it adopts.',
    method: 'Read the persisted acceptance card and compare adoptedRatingsFrom to the cited card.',
    driftMarkers: 'A verdict whose ratings match no independent card.',
    ratingScale: ['pass', 'partial', 'fail', 'unknown', 'n/a'],
  },
  {
    key: 'no-transcription',
    title: 'No ratings transcription',
    model: 'The author records a verdict without re-typing a grading they did not perform.',
    method: 'Emit an acceptance with ratings omitted and assert the persisted card is still complete.',
    driftMarkers: 'Authors hand-copying grader evidence strings.',
    ratingScale: ['pass', 'partial', 'fail', 'unknown', 'n/a'],
  },
];

/** What the INDEPENDENT grader wrote. Deliberately distinctive prose: the author
 *  never types these strings, so finding them on the persisted card can only mean
 *  adoption actually ran — the assertion cannot pass by coincidence. */
const GRADER_RATINGS = {
  'reference-fidelity': { rating: 'pass', evidence: 'grader re-derived reference fidelity from source' },
  'no-transcription': { rating: 'pass', evidence: 'grader re-derived the no-transcription property from source' },
};

const ACCEPT = { verdict: 'accept' as const, reasoning: 'The independent grading meets this plan.' };

/** Seed the acceptance rubric directly as a rubric-template plan row. This is the
 *  READ leg's input: `proposeRubric`'s authoring floors (citation-path resolution,
 *  the structured-check floor) are a different subsystem with their own coverage,
 *  and going around them here keeps this suite about the acceptance-by-reference
 *  path. `owner` is the column `getRubric` projects as the rubric's createdBy —
 *  i.e. the implementer this test authorizes against. */
async function insertAcceptanceRubric(db: OrgTestDb): Promise<void> {
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
       created, updated, owner, archived, template, template_data, template_slug, origin)
    VALUES (${activeWorkspaceId()}, 'papercusp', ${RUBRIC}, '', md5(${RUBRIC}), ${REVISION},
            'P-003 acceptance rubric', 'active', '2026-09-10', '2026-09-10', ${AUTHOR}, false,
            'rubric',
            ${JSON.stringify({
              kind: 'acceptance',
              subjectPlan: SUBJECT_PLAN,
              characteristic: 'plan-acceptance',
              criteria: CRITERIA,
              ratingScale: ['pass', 'partial', 'fail', 'unknown'],
              methodRef: 'acceptance-rubrics-on-every-plan-runbook',
              description: 'Acceptance of the P-003 reference path.',
            })}::text::jsonb,
            null, 'local')`;
}

/** File a real independent grading into the observation ledger. Returns its issue id —
 *  the exact reference the author's verdict will cite. */
async function fileIndependentGrading(opts: {
  createdBy: string;
  subjectRef?: string;
  ratings?: Record<string, { rating: string; evidence: string }>;
  rubricRevision?: number;
}): Promise<string> {
  // The exact-reference rail compares BOTH halves of the current rubric identity.
  // Derive the hash from the same live rubric read the writer uses instead of
  // freezing a fixture constant that drifts whenever the criterion contract moves.
  const criteriaHash = await getRubricCriteriaHash(RUBRIC);
  if (!criteriaHash) throw new Error(`fixture could not resolve criteriaHash for '${RUBRIC}'`);
  const issue = await createIssue({
    title: 'independent grading',
    kind: 'change',
    topics: [OBSERVATION_TOPIC],
    createdBy: opts.createdBy,
    payload: {
      observation: {
        rubricRef: RUBRIC,
        sourceHive: 'papercusp',
        rubricRevision: opts.rubricRevision ?? REVISION,
        criteriaHash,
        subject: { kind: 'plan', ref: opts.subjectRef ?? SUBJECT_PLAN },
        ratings: opts.ratings ?? GRADER_RATINGS,
      },
    },
  });
  return issue.id;
}

/** The author's verdict citing an exact card, carrying NO ratings of its own. */
const acceptanceArgs = (acceptanceOf: string, over: Record<string, unknown> = {}) => ({
  rubricRef: RUBRIC,
  subject: { kind: 'plan', ref: SUBJECT_PLAN },
  acceptance: ACCEPT,
  acceptanceOf,
  ...over,
});

const asAuthor = { createdBy: AUTHOR, workspaceId: activeWorkspaceId() };

/** Read the author's persisted acceptance card straight back out of Postgres.
 *  This is the readback the clause requires: it asserts what actually LANDED,
 *  not what the writer was asked to write. */
async function readBackAcceptanceCard(
  db: OrgTestDb,
): Promise<{ issue_id: string; created_by: string; observation: Record<string, unknown> } | null> {
  const rows = await db.adminSql<Array<{ issue_id: string; created_by: string; observation: Record<string, unknown> }>>`
    SELECT issue_id, created_by, payload -> 'observation' AS observation
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND payload -> 'observation' ->> 'rubricRef' = ${RUBRIC}
       AND payload -> 'observation' -> 'acceptance' IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`;
  return rows[0] ?? null;
}

describe('scorecards:emit — author acceptance by exact reference (P-003), real PG', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    // Each case seeds its own rubric + cards. CASCADE because plan_items/plan_decisions
    // hold FKs into harness_plans and a bare TRUNCATE of a referenced table is refused.
    await db.adminSql`TRUNCATE harness_shared.harness_plans CASCADE`;
    // engineer_issues is an issue-family VIEW over harness_shared.work_items, not a
    // table: TRUNCATE is refused on it ("engineer_issues is not a table"). The view is
    // insertable (that is how the sibling scorecard suites file cards), so clear through
    // it with a scoped DELETE rather than reaching past it to the base relation.
    await db.adminSql`DELETE FROM harness_shared.engineer_issues WHERE workspace_id = ${issuesScopeWorkspace()}`;
    await insertAcceptanceRubric(db);
  });

  it.each([false, true])('binds an omitted grader subject to the rubric plan and permits author adoption (author omits subject: %s)', async (omitAuthorSubject) => {
    const grading = await emitScorecard({
      rubricRef: RUBRIC,
      ratings: GRADER_RATINGS,
    } as never, { createdBy: GRADER, workspaceId: activeWorkspaceId() });
    expect(grading, JSON.stringify(grading)).toMatchObject({ ok: true, created: true });

    const rows = await db.adminSql<Array<{ issue_id: string; observation: Record<string, unknown> }>>`
      SELECT issue_id, payload -> 'observation' AS observation
        FROM harness_shared.engineer_issues
       WHERE workspace_id = ${issuesScopeWorkspace()}
         AND created_by = ${GRADER}
         AND payload -> 'observation' ->> 'rubricRef' = ${RUBRIC}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].observation.subject).toEqual({ kind: 'plan', ref: SUBJECT_PLAN });

    const args = acceptanceArgs(rows[0].issue_id);
    if (omitAuthorSubject) delete (args as { subject?: unknown }).subject;
    const accepted = await emitScorecard(args as never, asAuthor as never);
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, created: true });
    const persisted = await readBackAcceptanceCard(db);
    expect(persisted!.observation).toMatchObject({
      subject: { kind: 'plan', ref: SUBJECT_PLAN },
      ratings: GRADER_RATINGS,
      acceptance: { verdict: 'accept', adoptedRatingsFrom: { scorecardId: rows[0].issue_id } },
    });
  });

  it('preserves an explicitly different grader subject and refuses its adoption for the rubric plan', async () => {
    const subject = { kind: 'plan', ref: 'a-completely-different-plan' };
    const grading = await emitScorecard({
      rubricRef: RUBRIC,
      subject,
      ratings: GRADER_RATINGS,
    } as never, { createdBy: GRADER, workspaceId: activeWorkspaceId() });
    expect(grading, JSON.stringify(grading)).toMatchObject({ ok: true, created: true });
    const rows = await db.adminSql<Array<{ issue_id: string; observation: Record<string, unknown> }>>`
      SELECT issue_id, payload -> 'observation' AS observation
        FROM harness_shared.engineer_issues
       WHERE workspace_id = ${issuesScopeWorkspace()}
         AND created_by = ${GRADER}
         AND payload -> 'observation' ->> 'rubricRef' = ${RUBRIC}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].observation.subject).toEqual(subject);
    expect(await emitScorecard(acceptanceArgs(rows[0].issue_id) as never, asAuthor as never))
      .toMatchObject({ ok: false, code: 'acceptance_of_wrong_subject' });
    expect(await readBackAcceptanceCard(db)).toBeNull();
  });

  it('adopts the cited card ratings and PERSISTS them — readback proves the round trip', async () => {
    const independentId = await fileIndependentGrading({ createdBy: GRADER });

    const r = await emitScorecard(acceptanceArgs(independentId) as never, asAuthor as never);

    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, created: true });

    // THE READBACK. Everything above this line could be satisfied by a writer that
    // returned ok:true and persisted nothing; only a real SELECT can tell.
    const persisted = await readBackAcceptanceCard(db);
    expect(persisted).not.toBeNull();
    expect(persisted!.created_by).toBe(AUTHOR);

    // The grader's evidence prose landed on the AUTHOR's card. The author never
    // typed these strings, so their presence can only mean adoption ran and survived.
    expect(persisted!.observation).toMatchObject({
      ratings: {
        'reference-fidelity': { evidence: expect.stringContaining('grader re-derived reference fidelity') },
        'no-transcription': { evidence: expect.stringContaining('grader re-derived the no-transcription property') },
      },
      // Provenance names the exact card and its grader, so a later reader can trace
      // whose judgment the verdict rests on.
      acceptance: {
        verdict: 'accept',
        adoptedRatingsFrom: { scorecardId: independentId, gradedBy: GRADER },
        independentGrading: { scorecardId: independentId, gradedBy: GRADER, selectedBy: 'acceptanceOf' },
      },
    });
  });

  it('automatically publishes the persisted acceptance verdict through the real Reports producer', async () => {
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
    try {
      const independentId = await fileIndependentGrading({ createdBy: GRADER });
      const acceptanceTitle = 'Acceptance producer readback';
      const acceptanceBody = 'The original verdict body is preserved.';
      const args = acceptanceArgs(independentId, { title: acceptanceTitle, body: acceptanceBody });
      const producer = { ...asAuthor, ctxHarness: 'papercusp' };
      const result = await emitScorecard(args as never, producer as never);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, created: true });
      const issueId = (result as { issueId: string }).issueId;
      expect(issueId).toBeTruthy();
      const persisted = await readBackAcceptanceCard(db);
      expect(persisted?.issue_id).toBe(issueId);

      // Wait for the actual producer's tracked publication, rather than calling
      // the adapter ourselves or asserting arguments on a publisher mock.
      await drainDetached();
      const requestKey = `capture:acceptance:${createHash('sha256').update(issueId).digest('hex')}`;
      const rows = await db.adminSql<Array<{ report_id: string }>>`
        SELECT report_id FROM harness_shared.report_library
         WHERE workspace_id = ${activeWorkspaceId()} AND request_key = ${requestKey}`;
      expect(rows).toHaveLength(1);
      const report = await getReport(db.adminSql, activeWorkspaceId(), rows[0].report_id, { isOwner: true });
      expect(report).toMatchObject({
        title: 'Acceptance producer readback', kind: 'review', visibility: 'owner',
        source: 'capture:acceptance', requestKey,
        subject: { kind: 'plan', ref: SUBJECT_PLAN },
        origin: { authorOwnerId: AUTHOR, harnessSlug: 'papercusp', authorSessionRef: AUTHOR },
      });
      expect(report!.bodyMd).toContain('The original verdict body is preserved.');
      expect(report!.bodyMd).toContain(`Source reference: ${issueId}`);
      const verdict = report!.bodyMd.match(/```json\n([\s\S]*?)\n```/);
      expect(verdict).not.toBeNull();
      expect(JSON.parse(verdict![1])).toEqual({
        ratings: persisted!.observation.ratings, acceptance: persisted!.observation.acceptance,
      });

      // The outer emit replay below is an unchanged-evidence fast path. Invoke
      // the real adapter too, using the persisted card's author and verdict.
      const capturedId = await captureAcceptanceVerdict({ workspaceId: activeWorkspaceId(),
        ownerId: persisted!.created_by, harnessSlug: 'papercusp', sessionRef: persisted!.created_by,
        issueId: persisted!.issue_id, rubricRef: RUBRIC, title: acceptanceTitle, planSlug: SUBJECT_PLAN,
        body: acceptanceBody, ratings: persisted!.observation.ratings,
        acceptance: persisted!.observation.acceptance });
      const retryFailures = capturedId ? [] : await db.adminSql`SELECT title, body
        FROM harness_shared.engineer_issues WHERE title = 'Reports automatic capture failed'`;
      expect(capturedId, JSON.stringify(retryFailures)).toBe(report!.reportId);
      expect(await getReport(db.adminSql, activeWorkspaceId(), capturedId!, { isOwner: true })).toEqual(report);
      expect(await db.adminSql`SELECT report_id FROM harness_shared.report_library
        WHERE workspace_id = ${activeWorkspaceId()} AND request_key = ${requestKey}`).toEqual(rows);

      const replay = await emitScorecard(args as never, producer as never);
      expect(replay, JSON.stringify(replay)).toMatchObject({
        ok: true, created: false, reason: 'unchanged-evidence', previousIssueId: issueId,
      });
      await drainDetached();
      const retried = await db.adminSql<Array<{ report_id: string }>>`
        SELECT report_id FROM harness_shared.report_library
         WHERE workspace_id = ${activeWorkspaceId()} AND request_key = ${requestKey}`;
      expect(retried).toEqual(rows);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // WI-10003534: the rail admits an author verdict only against a complete grading
  // from outside the implementer's lineage, but it used to record WHICH card only on
  // the adoption path. A verdict with transcribed ratings and no `acceptanceOf` must
  // still cite the reviewer the scan admitted it against.
  it('cites the scan-admitted independent reviewer on a TRANSCRIBED verdict with no acceptanceOf', async () => {
    const independentId = await fileIndependentGrading({ createdBy: GRADER });
    const authorRatings = {
      'reference-fidelity': { rating: 'pass', evidence: 'author transcription of reference fidelity' },
      'no-transcription': { rating: 'pass', evidence: 'author transcription of the no-transcription property' },
    };

    const r = await emitScorecard(
      {
        rubricRef: RUBRIC,
        subject: { kind: 'plan', ref: SUBJECT_PLAN },
        acceptance: ACCEPT,
        ratings: authorRatings,
      } as never,
      asAuthor as never,
    );
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, created: true });

    const persisted = await readBackAcceptanceCard(db);
    expect(persisted).not.toBeNull();
    expect(persisted!.created_by).toBe(AUTHOR);
    const acceptance = persisted!.observation.acceptance as Record<string, unknown>;
    expect(acceptance).toMatchObject({
      verdict: 'accept',
      independentGrading: { scorecardId: independentId, gradedBy: GRADER, selectedBy: 'scan' },
    });
    // The author rated these themselves, so the ratings are NOT marked as adopted.
    expect(acceptance.adoptedRatingsFrom).toBeUndefined();
    // The cited reviewer is never the implementer.
    expect((acceptance.independentGrading as { gradedBy: string }).gradedBy).not.toBe(AUTHOR);
  });

  it('refuses a card that graded a DIFFERENT SUBJECT — wrong-subject negative control', async () => {
    // Eligible in every other respect (complete, live, current revision, independent)
    // and differing ONLY in what it graded. Adopting it would file a verdict whose
    // evidence describes someone else's work.
    const otherSubjectId = await fileIndependentGrading({
      createdBy: GRADER,
      subjectRef: 'a-completely-different-plan',
    });

    const r = await emitScorecard(acceptanceArgs(otherSubjectId) as never, asAuthor as never);

    // Pin the EXACT code. A bare ok:false cannot distinguish the subject rail from
    // any unrelated refusal, so it would keep passing with the rail removed — a
    // negative control that cannot fail for the right reason is not evidence.
    expect(r).toMatchObject({ ok: false, code: 'acceptance_of_wrong_subject' });
    // And nothing was written: a refusal must not leave a verdict behind.
    expect(await readBackAcceptanceCard(db)).toBeNull();
  });

  it('refuses a grading from the author’s OWN LINEAGE — prohibited-lineage negative control', async () => {
    // The ancestry WALK itself (spawn/rebind edges) is `areAcceptanceLineageRelated`,
    // covered by its own suite. What this control must prove is emit's response to a
    // prohibited verdict: that a lineage-related grading is refused with the precise
    // code and adopts nothing. Injected through emit's own declared `deps` seam so
    // the answer is deterministic rather than dependent on seeded session ancestry.
    const kinId = await fileIndependentGrading({ createdBy: 'su-p003-kin' });

    const r = await emitScorecard(acceptanceArgs(kinId) as never, asAuthor as never, {
      lineageRelated: async (first: string, second: string) =>
        // The kin grader is inside the author's lineage; everyone else is not.
        (first === AUTHOR && second === 'su-p003-kin') || (first === 'su-p003-kin' && second === AUTHOR),
    } as never);

    expect(r).toMatchObject({ ok: false, code: 'acceptance_of_not_independent' });
    expect(await readBackAcceptanceCard(db)).toBeNull();
  });
});
