/**
 * scorecards.integration.test.ts — the scorecard READ surface end-to-end against
 * real migrated Postgres (plan-templates-and-rubric-v2-2026-06-20 P-013 / D-005).
 *
 * Proves what a mock-SQL unit test can't: that `listScorecards` actually reads
 * rubric-graded observations back out of `engineer_issues.payload.observation`
 * (the WRITE-only gap D-005 found), filters by rubricRef + sourceHive + a since
 * window, sorts created_at DESC, and computes nKeys/missingKeys against the live
 * rubric store (getRubric) — including the partial-scorecard case P-014's
 * completeness gate hangs on. Scorecards are written via the real createIssue
 * path; created_at is then pinned so the ordering + since assertions are
 * deterministic. Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import type { OrgSql } from './work-items';
import { composeCompanionSummary } from '@papercusp/facets';
import type { StructuredObservation } from './harness/improvements/observation-types';

const h = vi.hoisted(() => ({ sql: null as unknown }));

// getOrgPg for the reads; withWorkspace for the re-pointed proposeRubric write path
// (withPlanLock → withWorkspace, P-007). The advisory xact-lock needs a real
// transaction — `.begin` provides one against the migrated throwaway DB's admin client.
//
// Spread the ACTUAL module (vi.importActual) rather than hand-listing every export:
// this test's import graph reaches multiple other db-org consumers transitively
// (agent-tools/locks/configure.ts calls setAdminPoolStatementTimeoutProvider at module
// top-level — WI-832; @papercusp/agent-mcp's bootstrap reads the `generated` schema
// namespace) and vitest throws on ANY access to an export missing from a partial mock.
// Those extra exports are pure (drizzle schema defs / a config-seam setter), so
// importing them for real has no I/O side effect — only getOrgPg/withWorkspace need
// faking to re-point reads/writes at the migrated throwaway test DB.
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

const {
  builtInCriterionKeysForRubric,
  listScorecardPage,
  listScorecards,
  readScorecardEvidence,
  recordGradingAudit,
  scorecardTotalCountsByRubric,
  scorecardTrend,
} = await import('./scorecards');
const { createIssue, getIssue, issueRef, issuesScopeWorkspace, linkIssue } = await import('./issues-engineer');
const { getRubric, proposeRubric, setRubricHistoryReset } = await import('./rubrics');
const { actOnHumanMarketItem, reviewHumanMarketItem } = await import('./work-items-human-market-store');
const { readHumanMarketJob } = await import('./work-items-human-market');
const { OBSERVATION_TOPIC } = await import('./harness/improvements/read-items');
const { resolveLocalRubric } = await import('./cupboard/rubric-store');
const { createOrgTestDb } = await import('../test/_org-test-db');
const { confirmPendingGradingAuditReservation } = await import('./grading-integrity');
const {
  buildScorecardHistoryPredicate,
  normalizeScorecardHistoryArgs,
  readScorecardHistoryPage,
  readScorecardHistorySummary,
} = await import('./sync-resolver/scorecard-history-list-query');

const RUBRIC = 'test-coord-health';
const CRITERIA = [
  // WI-4607: end-to-end-flow carries a trailing [instrumentKey:] token; watchdog is
  // explicitly `none`; ideation-quality carries no token (→ instrumentKey null).
  {
    key: 'end-to-end-flow',
    title: 'End-to-end flow',
    model: 'work flows [instrumentKey: placement-count]',
    method: 'count placements',
    driftMarkers: 'stuck frontier',
  },
  {
    key: 'ideation-quality',
    title: 'Ideation quality',
    model: 'good ideas',
    method: 'assess idea quality',
    driftMarkers: 'stale ideas',
  },
  {
    key: 'watchdog-determinism',
    title: 'Watchdog determinism',
    model: 'deterministic [instrumentKey: none]',
    method: 'replay',
    driftMarkers: 'flaky red-tests',
  },
];

// P-010 supersession fixture — a SEPARATE rubric so the counts/series the tests
// above assert are untouched, and deliberately dated a day EARLIER so the
// unfiltered newest-first listing just gains a tail.
//
// The shape is the real defect, not a synthetic one: a grade is filed, later
// found to be a MISREADING, and a correction is filed. Both then sat in the
// series, so the correction moved the trend twice — once for the reading now
// known to be wrong, again for the right one. Here the wrong reading is the
// OLDEST sample, which is what makes it visible: it anchors `first`, so the
// trend reports an "improvement" that is purely an artifact of the correction.
const RUBRIC_SUPERSEDE = 'test-supersession';
const SUPERSEDE_KEY = 'grading-honesty';
// ── D-015 contract-generation fixture. Deliberately SEPARATE from RUBRIC_SUPERSEDE so
// the boundary test cannot pass on a rubric whose samples another test already thinned.
const RUBRIC_RESET = 'test-contract-reset';
const RESET_KEY = 'contract-honesty';
const RESET_BOUNDARY = '2026-06-18T12:00:00.000Z';
const reset: { oldSuperseded: string; oldReviser: string; current: string } = {
  oldSuperseded: '',
  oldReviser: '',
  current: '',
};
const supersede: { original: string; correction: string; independent: string } = {
  original: '',
  correction: '',
  independent: '',
};
let roundtripScorecardId = '';

/** File a scorecard via the real write path, then pin its created_at deterministically. */
async function fileScorecard(
  db: OrgTestDb,
  opts: {
    id: string;
    rubricRef?: string;
    sourceHive?: string;
    rubricRevision?: number;
    criteriaHash?: string;
    evidenceFingerprint?: StructuredObservation['evidenceFingerprint'];
    ratings: NonNullable<StructuredObservation['ratings']>;
    instrumentSnapshots?: Record<string, unknown>;
    subject?: StructuredObservation['subject'];
    rollup?: StructuredObservation['rollup'];
    createdAt: string;
    createdBy?: string;
  },
): Promise<string> {
  const issue = await createIssue({
    title: `scorecard ${opts.id}`,
    kind: 'change',
    topics: [OBSERVATION_TOPIC],
    createdBy: opts.createdBy ?? 'kettle',
    payload: {
      observation: {
        ...(opts.rubricRef ? { rubricRef: opts.rubricRef } : {}),
        ...(opts.rubricRevision != null ? { rubricRevision: opts.rubricRevision } : {}),
        ...(opts.criteriaHash ? { criteriaHash: opts.criteriaHash } : {}),
        ...(opts.evidenceFingerprint ? { evidenceFingerprint: opts.evidenceFingerprint } : {}),
        ...(opts.sourceHive ? { sourceHive: opts.sourceHive } : {}),
        ratings: opts.ratings,
        ...(opts.instrumentSnapshots ? { instrumentSnapshots: opts.instrumentSnapshots } : {}),
        ...(opts.subject ? { subject: opts.subject } : {}),
        ...(opts.rollup ? { rollup: opts.rollup } : {}),
      },
    },
  });
  await db.adminSql`UPDATE harness_shared.engineer_issues SET created_at = ${opts.createdAt} WHERE issue_id = ${issue.id}`;
  return issue.id;
}

describe('listScorecards (P-013) — real PG', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;

    // Seed an ACTIVE test rubric (3 criteria) so missingKeys resolves.
    await proposeRubric({
      rubricId: RUBRIC,
      characteristic: 'hive-coordination',
      title: 'Test coord health',
      criteria: CRITERIA,
      status: 'active',
      by: 'su-test',
    });

    // A historically malformed papercusp scorecard: all 3 required criteria plus
    // one extra key. Direct createIssue intentionally bypasses the capture gate so
    // the read path proves old rows remain auditable without polluting trends.
    roundtripScorecardId = await fileScorecard(db, {
      id: 'complete',
      rubricRef: RUBRIC,
      rubricRevision: 17,
      criteriaHash: 'criteria-hash-roundtrip',
      evidenceFingerprint: 'evidence-fingerprint-roundtrip',
      subject: {
        kind: 'agent-run', ref: 'historical-holder',
        windowStart: '2026-06-05T00:00:00.000Z', windowEnd: '2026-06-06T00:00:00.000Z',
      },
      rollup: {
        verdict: 'fail', criticalKeys: ['end-to-end-flow'], criticalFailures: ['end-to-end-flow'],
        criticalUnknowns: [], coverage: { rated: 3, required: 3, sufficient: true },
      },
      sourceHive: 'papercusp',
      createdAt: '2026-06-20T12:00:00.000Z',
      ratings: {
        'end-to-end-flow': {
          rating: 'broken', evidence: '88 unplaced', evidenceRef: 'test:placement-snapshot',
          evidenceKind: 'test', attribution: 'subject',
        },
        'ideation-quality': { rating: 'healthy', evidence: 'fresh ideas' },
        'watchdog-determinism': { rating: 'degraded', evidence: '2 flaky red-tests' },
        'legacy-ad-hoc-check': { rating: 'healthy', evidence: 'old writer invented a dimension' },
      },
      instrumentSnapshots: {
        'spec-quality.proof': {
          verdict: 'pass',
          measuredAt: '2026-06-20T11:59:30.000Z',
          value: { checked: 4 },
          evidenceRef: 'test:spec-quality-proof',
        },
      },
    });
    // A malformed historical candidate still passes the SQL rubricRef/sourceHive
    // predicates, but the canonical observation parser drops its invalid rating
    // entry. Pagination must advance past this raw row without consuming a public
    // scorecard page slot or making `hasMore` read false.
    await db.adminSql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source,
         state, payload, created_by, signal_origin, created_at, updated_at)
      VALUES (
        ${issuesScopeWorkspace()}, 'EI-scorecard-malformed', 'change',
        'harness:papercusp', 'malformed scorecard', '', 'minor', 'test',
        'done',
        ${JSON.stringify({
          observation: {
            rubricRef: RUBRIC,
            sourceHive: 'papercusp',
            ratings: {
              malformed: { rating: 42, evidence: null },
            },
          },
        })}::text::jsonb,
        'su-test', 'organic',
        timestamptz '2026-06-20T13:00:00Z',
        timestamptz '2026-06-20T13:00:00Z'
      )`;
    // A PARTIAL papercusp scorecard (1 of 3) — the drift P-014 must catch.
    await fileScorecard(db, {
      id: 'partial',
      rubricRef: RUBRIC,
      sourceHive: 'papercusp',
      createdAt: '2026-06-20T10:00:00.000Z',
      ratings: { 'end-to-end-flow': { rating: 'degraded', evidence: 'slow' } },
    });
    // Same rubric, DIFFERENT source-hive (separate by sourceHive filter).
    await fileScorecard(db, {
      id: 'generic',
      rubricRef: RUBRIC,
      sourceHive: 'generic-test',
      createdAt: '2026-06-20T11:00:00.000Z',
      ratings: { 'end-to-end-flow': { rating: 'healthy', evidence: 'fine' } },
    });
    // A scorecard against an UNKNOWN rubric — rubricResolved must be false.
    await fileScorecard(db, {
      id: 'unknown-rubric',
      rubricRef: 'no-such-rubric',
      sourceHive: 'papercusp',
      createdAt: '2026-06-20T09:00:00.000Z',
      ratings: { whatever: { rating: 'healthy', evidence: 'x' } },
    });
    // A FREE-TEXT observation (no rubricRef) — must NOT appear as a scorecard.
    await createIssue({
      title: 'free-text obs',
      kind: 'change',
      topics: [OBSERVATION_TOPIC],
      createdBy: 'cup',
      payload: { observation: { kind: 'friction', scope: 'papercusp', refs: [] } },
    });

    // ── P-010 supersession fixture (see RUBRIC_SUPERSEDE above). Seeded WITHOUT
    //    the `revises` edge: the test files it mid-way so the same trend can be
    //    read before and after, which is what proves the exclusion is
    //    load-bearing rather than coincidental.
    await proposeRubric({
      rubricId: RUBRIC_SUPERSEDE,
      characteristic: 'hive-coordination',
      title: 'Test supersession',
      criteria: [
        {
          key: SUPERSEDE_KEY,
          title: 'Grading honesty',
          model: 'grades reflect reality',
          method: 'compare to source',
          driftMarkers: 'uncorrected misreadings',
        },
      ],
      status: 'active',
      by: 'su-test',
    });
    supersede.original = await fileScorecard(db, {
      id: 'supersede-original',
      rubricRef: RUBRIC_SUPERSEDE,
      sourceHive: 'papercusp',
      createdAt: '2026-06-19T10:00:00.000Z',
      ratings: { [SUPERSEDE_KEY]: { rating: 'broken', evidence: 'ORIGINAL — the evidence was misread' } },
    });
    supersede.correction = await fileScorecard(db, {
      id: 'supersede-correction',
      rubricRef: RUBRIC_SUPERSEDE,
      sourceHive: 'papercusp',
      createdAt: '2026-06-19T11:00:00.000Z',
      ratings: {
        [SUPERSEDE_KEY]: { rating: 'healthy', evidence: 'CORRECTION — re-read the source; it was fine all along' },
      },
    });
    supersede.independent = await fileScorecard(db, {
      id: 'supersede-independent',
      rubricRef: RUBRIC_SUPERSEDE,
      sourceHive: 'papercusp',
      createdAt: '2026-06-19T12:00:00.000Z',
      ratings: { [SUPERSEDE_KEY]: { rating: 'healthy', evidence: 'a genuinely separate later observation' } },
    });

    // ── D-015 contract-generation fixture. Seeded WITHOUT a declared boundary, and
    //    WITH the `revises` edge already in place, so the test can read the same trend
    //    before and after declaring the boundary. The overlap is the point: one sample
    //    is BOTH pre-boundary AND superseded, which is the case where two independent
    //    exclusion paths can double-count the same row.
    await proposeRubric({
      rubricId: RUBRIC_RESET,
      characteristic: 'hive-coordination',
      title: 'Test contract reset',
      criteria: [
        {
          key: RESET_KEY,
          title: 'Contract honesty',
          model: 'grades measure the live contract',
          method: 'compare to contract',
          driftMarkers: 'gradings of a rewritten contract',
        },
      ],
      status: 'active',
      by: 'su-test',
    });
    reset.oldSuperseded = await fileScorecard(db, {
      id: 'reset-old-superseded',
      rubricRef: RUBRIC_RESET,
      sourceHive: 'papercusp',
      createdAt: '2026-06-18T10:00:00.000Z',
      ratings: {
        [RESET_KEY]: { rating: 'broken', evidence: 'PRE-REWRITE, and later corrected — excluded by BOTH paths' },
      },
    });
    reset.oldReviser = await fileScorecard(db, {
      id: 'reset-old-reviser',
      rubricRef: RUBRIC_RESET,
      sourceHive: 'papercusp',
      createdAt: '2026-06-18T11:00:00.000Z',
      ratings: { [RESET_KEY]: { rating: 'healthy', evidence: 'PRE-REWRITE correction of the above' } },
    });
    reset.current = await fileScorecard(db, {
      id: 'reset-current',
      rubricRef: RUBRIC_RESET,
      sourceHive: 'papercusp',
      createdAt: '2026-06-18T13:00:00.000Z',
      ratings: {
        [RESET_KEY]: { rating: 'healthy', evidence: 'POST-REWRITE — the only sample that grades the live contract' },
      },
    });
    await linkIssue(reset.oldReviser, issueRef(reset.oldSuperseded), 'revises', 'su-test');
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('returns only rubric-graded scorecards (free-text observations excluded), newest-first', async () => {
    const rows = await listScorecards({});
    const ids = rows.map((r) => r.rubricRef);
    // complete + partial + generic + unknown-rubric + the 3 supersession fixtures
    // (06-19) + the 3 contract-reset fixtures (06-18); free-text excluded. NOTE
    // listScorecards is the raw READ surface and is deliberately supersession-blind —
    // the exclusion belongs to the TREND, so all 3 appear here even after the `revises`
    // edge is filed. The SAME holds for the D-015 contract-generation boundary: it is a
    // TREND-level exclusion, so a retired-contract grading is still readable here. That
    // is deliberate — the raw read is how you audit what was excluded and why, which an
    // exclusion applied at the read surface would make impossible.
    expect(rows.length).toBe(10);
    expect(ids.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
    // created_at DESC: complete(12:00) > generic(11:00) > partial(10:00) > unknown(09:00)
    expect(rows.map((r) => r.createdAt)).toEqual([
      '2026-06-20T12:00:00.000Z',
      '2026-06-20T11:00:00.000Z',
      '2026-06-20T10:00:00.000Z',
      '2026-06-20T09:00:00.000Z',
      '2026-06-19T12:00:00.000Z',
      '2026-06-19T11:00:00.000Z',
      '2026-06-19T10:00:00.000Z',
      '2026-06-18T13:00:00.000Z',
      '2026-06-18T11:00:00.000Z',
      '2026-06-18T10:00:00.000Z',
    ]);
  });

  it('projects createdBy + sourceHive + nKeys, and computes missingKeys against the rubric', async () => {
    const rows = await listScorecards({ rubricRef: RUBRIC, sourceHive: 'papercusp' });
    expect(rows.map((r) => r.createdAt)).toEqual(['2026-06-20T12:00:00.000Z', '2026-06-20T10:00:00.000Z']); // complete, partial

    const complete = rows[0];
    expect(complete.createdBy).toBe('kettle');
    expect(complete.sourceHive).toBe('papercusp');
    expect(complete.nKeys).toBe(4);
    expect(complete.missingKeys).toEqual([]); // all 3 criteria rated
    expect(complete.extraKeys).toEqual(['legacy-ad-hoc-check']);
    expect(complete.rubricResolved).toBe(true);
    expect(complete.rubricRevision).toBe(17);
    expect(complete.criteriaHash).toBe('criteria-hash-roundtrip');
    expect(complete.score10).toBe(5); // known criteria only: broken(0), healthy(10), degraded(5)
    expect(complete.ratings['end-to-end-flow']).toEqual({
      rating: 'broken', evidence: '88 unplaced', evidenceRef: 'test:placement-snapshot',
      evidenceKind: 'test', attribution: 'subject',
    });
    expect(complete.rollup?.verdict).toBe('fail');
    expect(complete.instrumentSnapshots).toEqual({
      'spec-quality.proof': {
        verdict: 'pass',
        measuredAt: '2026-06-20T11:59:30.000Z',
        value: { checked: 4 },
        evidenceRef: 'test:spec-quality-proof',
      },
    });

    const partial = rows[1];
    expect(partial.nKeys).toBe(1);
    expect(partial.missingKeys).toEqual(['ideation-quality', 'watchdog-determinism']); // unrated, in rubric order
    expect(partial.extraKeys).toEqual([]);
    expect(partial.rubricResolved).toBe(true);
  });

  it('round-trips the substantive rubric identity through the evidence-first reader', async () => {
    const result = await readScorecardEvidence(roundtripScorecardId);

    expect(result).toMatchObject({
      kind: 'found',
      scorecard: {
        issueId: roundtripScorecardId,
        rubricRevision: 17,
        criteriaHash: 'criteria-hash-roundtrip',
        rubricCurrentness: expect.objectContaining({
          state: 'stale', reason: 'criteria-hash-mismatch',
          recordedCriteriaHash: 'criteria-hash-roundtrip',
        }),
        evidenceFingerprint: 'evidence-fingerprint-roundtrip',
        rollup: { verdict: 'fail' },
        criteria: expect.arrayContaining([expect.objectContaining({
          key: 'end-to-end-flow', evidenceRef: 'test:placement-snapshot', evidenceKind: 'test', attribution: 'subject',
        })]),
      },
    });

    const [listed] = await listScorecards({ issueIds: [roundtripScorecardId], includeSuperseded: true });
    expect(listed?.rubricCurrentness).toMatchObject({ state: 'stale', reason: 'criteria-hash-mismatch' });
  });

  it('filters by sourceHive — same rubric, different hive is a separate result', async () => {
    const rows = await listScorecards({ rubricRef: RUBRIC, sourceHive: 'generic-test' });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceHive).toBe('generic-test');
    expect(rows[0].nKeys).toBe(1);
    expect(rows[0].missingKeys).toEqual(['ideation-quality', 'watchdog-determinism']);
  });

  it('filters by the since time-window (created_at >= since)', async () => {
    const rows = await listScorecards({ since: '2026-06-20T10:30:00.000Z' });
    // Only complete(12:00) + generic(11:00) are at/after 10:30.
    expect(rows.map((r) => r.createdAt)).toEqual(['2026-06-20T12:00:00.000Z', '2026-06-20T11:00:00.000Z']);
  });

  it('an unknown rubric yields rubricResolved=false + empty missingKeys (never a false "complete")', async () => {
    const rows = await listScorecards({ rubricRef: 'no-such-rubric' });
    expect(rows).toHaveLength(1);
    expect(rows[0].rubricResolved).toBe(false);
    expect(rows[0].missingKeys).toEqual([]); // can't compute — but rubricResolved=false flags it
    expect(rows[0].extraKeys).toEqual([]); // unknown rubric ⇒ no declared key set to compare
    expect(rows[0].nKeys).toBe(1);
  });

  it('has a built-in completeness fallback only for the owner-mandated hive coordination rubric', () => {
    expect(builtInCriterionKeysForRubric('pot-coordination-health')).toHaveLength(15);
    expect(builtInCriterionKeysForRubric('pot-coordination-health')).toContain('scheduler-usage');
    expect(builtInCriterionKeysForRubric('pot-coordination-health')).toContain('context-burn');
    expect(builtInCriterionKeysForRubric('no-such-rubric')).toBeNull();
  });

  // EI-13292 recurrence guard: the built-in fallback drifted to 14 keys (missing
  // `context-burn`) after the first-party bundle (rubrics/pot-coordination-health/
  // rubric.json) was extended to 15 — a scorecard rating all 15 (correctly) then read
  // as "unexpected criterion key(s): context-burn" whenever this fallback was consulted.
  // Pin the fallback to the bundle's OWN criteria list so the two can never silently
  // diverge again.
  it('keeps the built-in fallback in lockstep with the first-party rubric bundle (EI-13292)', () => {
    const bundled = resolveLocalRubric('pot-coordination-health');
    expect(bundled).not.toBeNull();
    const bundledKeys = bundled!.criteria.map((c) => c.key);
    expect(builtInCriterionKeysForRubric('pot-coordination-health')).toEqual(bundledKeys);
  });

  it('respects the limit (newest-first)', async () => {
    const rows = await listScorecards({ limit: 2 });
    expect(rows.map((r) => r.createdAt)).toEqual(['2026-06-20T12:00:00.000Z', '2026-06-20T11:00:00.000Z']);
  });

  it('selects an older scorecard by exact issue ID before applying the limit', async () => {
    const rows = await listScorecards({ issueIds: [reset.oldSuperseded], limit: 1 });
    expect(rows.map((row) => row.issueId)).toEqual([reset.oldSuperseded]);
    expect(await listScorecards({ issueIds: [], limit: 1 })).toEqual([]);
  });

  it('fills valid page slots past malformed raw rows and reports authoritative hasMore', async () => {
    const first = await listScorecardPage({ rubricRef: RUBRIC, sourceHive: 'papercusp', limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.createdAt).toBe('2026-06-20T12:00:00.000Z');
    expect(first.hasMore).toBe(true);

    const second = await listScorecardPage({
      rubricRef: RUBRIC,
      sourceHive: 'papercusp',
      limit: 1,
      before: {
        createdAt: first.rows[0]!.createdAt,
        issueId: first.rows[0]!.issueId,
      },
    });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.createdAt).toBe('2026-06-20T10:00:00.000Z');
    expect(second.hasMore).toBe(false);
  });

  // ── scorecardTrend (P-010) — end-to-end aggregation over the same seeded data.
  //    papercusp end-to-end-flow: partial(10:00, degraded) → complete(12:00, broken) = worsening.
  it('scorecardTrend: groups per criterion, RLE series when requested, worsening direction (P-010)', async () => {
    const trend = await scorecardTrend({ rubricRef: RUBRIC, sourceHive: 'papercusp', includeSeries: true });
    expect(trend.rubricRef).toBe(RUBRIC);
    expect(trend.sourceHive).toBe('papercusp');
    expect(trend.scorecardCount).toBe(2); // complete + partial (generic-test excluded by sourceHive)
    expect(trend.window).toEqual({ from: '2026-06-20T10:00:00.000Z', to: '2026-06-20T12:00:00.000Z' });
    expect(trend.filingWindow).toEqual(trend.window);
    expect(trend.observationWindow).toEqual({ from: '2026-06-05T00:00:00.000Z', to: '2026-06-06T00:00:00.000Z' });
    const lag = Date.parse('2026-06-20T12:00:00.000Z') - Date.parse('2026-06-06T00:00:00.000Z');
    expect(trend.filingLagMs).toEqual({ min: lag, max: lag, mean: lag, measured: 1 });
    expect(trend.scorecardIdentities).toEqual([
      expect.objectContaining({ createdAt: '2026-06-20T10:00:00.000Z' }),
      expect.objectContaining({
        issueId: roundtripScorecardId, rubricRevision: 17, criteriaHash: 'criteria-hash-roundtrip',
        subject: { kind: 'agent-run', ref: 'historical-holder', windowStart: '2026-06-05T00:00:00.000Z', windowEnd: '2026-06-06T00:00:00.000Z' },
      }),
    ]);
    // criteria sorted ASC by key.
    expect(trend.criteria.map((c) => c.criterion)).toEqual([
      'end-to-end-flow',
      'ideation-quality',
      'watchdog-determinism',
    ]);
    expect(trend.criteria.some((c) => c.criterion === 'legacy-ad-hoc-check')).toBe(false);

    const e2e = trend.criteria.find((c) => c.criterion === 'end-to-end-flow')!;
    expect(e2e.count).toBe(2);
    // WI-2943: the series is RLE runs (oldest first), opt-in via includeSeries.
    expect(e2e.series).toEqual([
      { rating: 'degraded', from: '2026-06-20T10:00:00.000Z', to: '2026-06-20T10:00:00.000Z', n: 1 },
      { rating: 'broken', from: '2026-06-20T12:00:00.000Z', to: '2026-06-20T12:00:00.000Z', n: 1 },
    ]);
    expect(e2e.first).toEqual({ rating: 'degraded', at: '2026-06-20T10:00:00.000Z' });
    expect(e2e.latest).toEqual({ rating: 'broken', at: '2026-06-20T12:00:00.000Z' });
    expect(e2e.direction).toBe('worsening');
    expect(e2e.distribution).toEqual({ degraded: 1, broken: 1 });
    expect(e2e.idleCount).toBe(0); // no idle-tagged unknowns seeded

    // Single-point criteria (only the complete scorecard rated them) → unknown direction.
    const single = trend.criteria.find((c) => c.criterion === 'ideation-quality')!;
    expect(single.count).toBe(1);
    expect(single.direction).toBe('unknown');
  });

  it('scorecardTrend: series is OMITTED by default (WI-2943 — summary fields are the payload)', async () => {
    const trend = await scorecardTrend({ rubricRef: RUBRIC, sourceHive: 'papercusp' });
    expect(trend.criteria.length).toBeGreaterThan(0);
    for (const c of trend.criteria) expect(c.series).toBeUndefined();
    expect(trend.scorecardIdentities).toBeUndefined();
    // The summary fields still fully describe the criterion.
    const e2e = trend.criteria.find((c) => c.criterion === 'end-to-end-flow')!;
    expect(e2e.direction).toBe('worsening');
    expect(e2e.distribution).toEqual({ degraded: 1, broken: 1 });
  });

  it('scorecardTrend: threads governance provenance + per-criterion instrumentKey (WI-4607)', async () => {
    const trend = await scorecardTrend({ rubricRef: RUBRIC, sourceHive: 'papercusp' });
    // Governance provenance sourced from the same getRubric() read the mean10 scale uses.
    expect(trend.status).toBe('active');
    expect(typeof trend.proposedBy).toBe('string');
    expect((trend.proposedBy ?? '').length).toBeGreaterThan(0);
    // instrumentKey parsed from each criterion's trailing model token.
    const byKey = Object.fromEntries(trend.criteria.map((c) => [c.criterion, c.instrumentKey]));
    expect(byKey['end-to-end-flow']).toBe('placement-count');
    expect(byKey['watchdog-determinism']).toBe('none'); // explicit no-instrument binding
    expect(byKey['ideation-quality']).toBeNull(); // no token → null
  });

  it('scorecardTrend: cross-hive (no sourceHive) folds every source into one series', async () => {
    const trend = await scorecardTrend({ rubricRef: RUBRIC, includeSeries: true });
    expect(trend.scorecardCount).toBe(3); // papercusp complete + partial + generic-test
    const e2e = trend.criteria.find((c) => c.criterion === 'end-to-end-flow')!;
    // degraded(10:00, papercusp) → healthy(11:00, generic) → broken(12:00, papercusp): net first→latest = worsening.
    expect(e2e.count).toBe(3);
    expect(e2e.series!.map((p) => p.rating)).toEqual(['degraded', 'healthy', 'broken']);
    expect(e2e.series!.every((p) => p.n === 1)).toBe(true);
    expect(e2e.direction).toBe('worsening');
  });

  // ── P-010: a re-grade must not move the trend twice.
  //
  // Read the SAME trend before and after filing the `revises` edge. The "before"
  // half is the falsifier: without it, an assertion that the corrected trend is
  // `stable` proves nothing, because it would also pass if the fixture had simply
  // never been improving. What makes the defect real is that the direction FLIPS —
  // the reported "improvement" was entirely an artifact of correcting a bad grade.
  it('scorecardTrend: a `revises` correction supersedes the grade it corrects, and the direction it faked goes with it (P-010)', async () => {
    const before = await scorecardTrend({ rubricRef: RUBRIC_SUPERSEDE, sourceHive: 'papercusp', includeSeries: true });
    expect(before.scorecardCount).toBe(3);
    expect(before.supersededExcluded).toBe(0); // nothing revised yet — the field is honest at zero, not absent
    const beforeCriterion = before.criteria.find((c) => c.criterion === SUPERSEDE_KEY)!;
    expect(beforeCriterion.series!.map((p) => p.rating)).toEqual(['broken', 'healthy']); // RLE: healthy(11:00)+healthy(12:00) collapse into one run
    expect(beforeCriterion.count).toBe(3);
    expect(beforeCriterion.direction).toBe('improving'); // ← the artifact: driven entirely by the misreading it later corrected
    expect(before.window).toEqual({ from: '2026-06-19T10:00:00.000Z', to: '2026-06-19T12:00:00.000Z' });

    // The correction declares what it corrects. src = the reviser, dst = the superseded.
    await linkIssue(supersede.correction, issueRef(supersede.original), 'revises', 'su-test');

    const after = await scorecardTrend({ rubricRef: RUBRIC_SUPERSEDE, sourceHive: 'papercusp', includeSeries: true });
    expect(after.scorecardCount).toBe(2); // counts only what actually fed the series
    expect(after.supersededExcluded).toBe(1); // …and says so, rather than dropping it silently
    const afterCriterion = after.criteria.find((c) => c.criterion === SUPERSEDE_KEY)!;
    expect(afterCriterion.count).toBe(2);
    expect(afterCriterion.series!.map((p) => p.rating)).toEqual(['healthy']); // the misreading is gone from the series
    expect(afterCriterion.first).toEqual({ rating: 'healthy', at: '2026-06-19T11:00:00.000Z' });
    expect(afterCriterion.direction).toBe('stable'); // ← the whole point: no phantom improvement
    expect(afterCriterion.distribution).toEqual({ healthy: 2 });
    // The excluded sample also stops anchoring the reported window.
    expect(after.window).toEqual({ from: '2026-06-19T11:00:00.000Z', to: '2026-06-19T12:00:00.000Z' });

    // Only the REVISED one drops — a correction chain must not take its own corrections with it.
    expect(after.criteria.find((c) => c.criterion === SUPERSEDE_KEY)!.latest).toEqual({
      rating: 'healthy',
      at: '2026-06-19T12:00:00.000Z',
    });
  });

  // ── D-015: gradings of a REWRITTEN contract must not blend into the live trend.
  //
  // The before/after is the falsifier, same as P-010's: asserting that the post-boundary
  // trend reads 'healthy' proves nothing on its own, because the fixture's newest sample
  // is healthy anyway. What proves the exclusion is load-bearing is that the criterion's
  // SAMPLE COUNT and DIRECTION change when the boundary is declared, and that they change
  // by exactly the samples that pre-date it.
  it('scorecardTrend: a declared contract-generation boundary excludes pre-rewrite gradings, and the two exclusion paths never double-count (D-015)', async () => {
    const before = await scorecardTrend({ rubricRef: RUBRIC_RESET, sourceHive: 'papercusp', includeSeries: true });
    // No boundary declared yet, so this is the OLD behaviour: pre-rewrite gradings feed
    // the series, and the only thing thinning it is the revises edge.
    expect(before.preContractResetExcluded).toBe(0); // honest at zero, not absent — a rubric that never rewrote its contract is unaffected
    expect(before.supersededExcluded).toBe(1);
    expect(before.scorecardCount).toBe(2);
    const beforeCriterion = before.criteria.find((c) => c.criterion === RESET_KEY)!;
    expect(beforeCriterion.count).toBe(2);
    expect(beforeCriterion.first).toEqual({ rating: 'healthy', at: '2026-06-18T11:00:00.000Z' }); // ← a PRE-rewrite grading anchoring the series

    const updated = await setRubricHistoryReset(RUBRIC_RESET, RESET_BOUNDARY, 'su-test');
    expect(updated?.historyResetAt).toBe(RESET_BOUNDARY);
    // The boundary is governance state, NOT content: declaring it must not demote a
    // ratified rubric (which a propose would). This is the assertion that fails if
    // anyone later reroutes this through amendRubric.
    expect(updated?.status).toBe('active');

    const afterReset = await scorecardTrend({ rubricRef: RUBRIC_RESET, sourceHive: 'papercusp', includeSeries: true });
    expect(afterReset.preContractResetExcluded).toBe(2); // both pre-rewrite gradings, said out loud
    expect(afterReset.scorecardCount).toBe(1); // only the sample that grades the LIVE contract
    const afterCriterion = afterReset.criteria.find((c) => c.criterion === RESET_KEY)!;
    expect(afterCriterion.count).toBe(1);
    expect(afterCriterion.first).toEqual({ rating: 'healthy', at: '2026-06-18T13:00:00.000Z' });
    // The retired gradings stop anchoring the reported window too — a window still
    // reaching back into the old contract would reintroduce the blend in the one field
    // a reader uses to judge how current the trend is.
    expect(afterReset.window).toEqual({ from: '2026-06-18T13:00:00.000Z', to: '2026-06-18T13:00:00.000Z' });

    // THE DOUBLE-COUNT GUARD. `reset.oldSuperseded` qualifies for BOTH exclusions: it
    // pre-dates the boundary AND a later filing revises it. It must be counted ONCE.
    // supersededExcluded is measured against the post-boundary set, so it reads 0 here —
    // not because nothing was superseded, but because the only superseded row had already
    // left the population. Measuring it against the raw rows instead would report 1 here
    // and make the two figures sum to 3 exclusions out of 3 rows, with 1 row still in the
    // series: arithmetic that cannot be true, in the exact fields that exist to make the
    // thinning legible.
    expect(afterReset.supersededExcluded).toBe(0);
    expect(afterReset.preContractResetExcluded + afterReset.supersededExcluded).toBe(3 - afterReset.scorecardCount);
  });
});

describe('scorecard history P-009 — real PG large-corpus contract', () => {
  const rubricRef = 'test-large-scorecard-history';
  const criterion = 'bounded-history';
  const seededRows = 843;
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    await proposeRubric({
      rubricId: rubricRef,
      characteristic: 'hive-coordination',
      title: 'Large scorecard history',
      criteria: [
        {
          key: criterion,
          title: 'Bounded history',
          model: 'history reads stay bounded',
          method: 'page the corpus',
          driftMarkers: 'page length presented as a total',
        },
      ],
      status: 'active',
      by: 'su-test',
    });

    // Direct through the canonical issue-family compatibility view, in one
    // statement. Paired timestamps force the cursor's issue-id tie-breaker to
    // carry real correctness rather than merely decorate an all-unique fixture.
    await db.adminSql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source,
         state, payload, created_by, signal_origin, created_at, updated_at)
      SELECT ${issuesScopeWorkspace()},
             'EI-p009-' || lpad(g::text, 4, '0'),
             'change',
             'harness:papercusp',
             'P-009 scorecard ' || g,
             '',
             'minor',
             'test',
             'done',
             ${JSON.stringify({
               observation: {
                 rubricRef,
                 ratings: {
                   [criterion]: {
                     rating: 'pass',
                     evidence: 'seeded large-corpus scorecard',
                   },
                 },
               },
             })}::text::jsonb,
             'su-test',
             'organic',
             timestamptz '2026-08-01T00:00:00Z'
               + floor(g / 2.0) * interval '1 second',
             timestamptz '2026-08-01T00:00:00Z'
               + floor(g / 2.0) * interval '1 second'
        FROM generate_series(1, ${seededRows}) AS g`;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('keeps exact corpus truth independent from the 500-row trend sample and keyset-pages every row', async () => {
    const firstPredicate = buildScorecardHistoryPredicate(normalizeScorecardHistoryArgs({ rubricRef, limit: 137 }));
    const started = performance.now();
    const [aggregateRows, trend] = await Promise.all([
      readScorecardHistorySummary(firstPredicate, {
        countByRubric: scorecardTotalCountsByRubric,
      }),
      scorecardTrend({ rubricRef }),
    ]);
    const summary = composeCompanionSummary(aggregateRows);
    expect(summary).toMatchObject({ total: seededRows, matched: seededRows });
    expect(trend.sample).toEqual({ limit: 500, inputCount: 500 });
    expect(trend.scorecardCount).toBe(500);
    expect(performance.now() - started).toBeLessThan(6_000);

    const ids: string[] = [];
    let cursor: string | null = null;
    let pageNo = 0;
    let maxPageBytes = 0;
    let maxPageMs = 0;
    for (;;) {
      const pageStarted = performance.now();
      const page = await readScorecardHistoryPage(
        buildScorecardHistoryPredicate(normalizeScorecardHistoryArgs({ rubricRef, limit: 137, cursor })),
        { listPage: listScorecardPage },
      );
      maxPageMs = Math.max(maxPageMs, performance.now() - pageStarted);
      maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page.rows)));
      ids.push(...page.rows.map((row) => row.issueId));
      cursor = page.nextCursor;

      if (pageNo === 0) {
        // A new row above the cursor must not duplicate or skip the immutable
        // snapshot prefix already traversed.
        await db.adminSql`
          INSERT INTO harness_shared.engineer_issues
            (workspace_id, issue_id, kind, scope, title, body, severity, source,
             state, payload, created_by, signal_origin, created_at, updated_at)
          VALUES (
            ${issuesScopeWorkspace()}, 'EI-p009-newer', 'change',
            'harness:papercusp', 'newer after cursor', '', 'minor', 'test',
            'done',
            ${JSON.stringify({
              observation: {
                rubricRef,
                ratings: {
                  [criterion]: { rating: 'pass', evidence: 'newer insertion' },
                },
              },
            })}::text::jsonb,
            'su-test', 'organic',
            timestamptz '2026-08-02T00:00:00Z',
            timestamptz '2026-08-02T00:00:00Z'
          )`;
      }

      pageNo += 1;
      if (!cursor) break;
      expect(pageNo).toBeLessThan(20);
    }

    expect(ids).toHaveLength(seededRows);
    expect(new Set(ids).size).toBe(seededRows);
    expect(ids).not.toContain('EI-p009-newer');
    expect(maxPageBytes).toBeLessThan(250_000);
    expect(maxPageMs).toBeLessThan(6_000);

    const updatedAggregate = await readScorecardHistorySummary(firstPredicate, {
      countByRubric: scorecardTotalCountsByRubric,
    });
    expect(composeCompanionSummary(updatedAggregate).matched).toBe(seededRows + 1);
  }, 120_000);

  it('preserves an exact zero when the history page is empty', async () => {
    const predicate = buildScorecardHistoryPredicate(normalizeScorecardHistoryArgs({ rubricRef: 'missing-rubric' }));
    const [page, aggregateRows] = await Promise.all([
      readScorecardHistoryPage(predicate, { listPage: listScorecardPage }),
      readScorecardHistorySummary(predicate, {
        countByRubric: scorecardTotalCountsByRubric,
      }),
    ]);
    expect(page).toMatchObject({ rows: [], nextCursor: null, hasMore: false });
    expect(composeCompanionSummary(aggregateRows)).toMatchObject({
      total: 0,
      matched: 0,
    });
  });

  it('CAS-restamps a legacy settled audit and cannot overwrite a concurrent correction', async () => {
    const target = await createIssue({
      title: 'legacy grading-audit target',
      kind: 'change',
      topics: [OBSERVATION_TOPIC],
      createdBy: 'su-target-author',
      payload: {
        observation: {
          rubricRef: RUBRIC,
          ratings: {
            'end-to-end-flow': { rating: 'healthy', evidence: 'current proof' },
          },
          gradingAudit: {
            state: 'failed',
            metaRubricRef: 'grading-integrity',
            auditIssueId: 'EI-AUDIT-OLD',
            auditor: 'su-old-auditor',
            stampedAt: '2026-09-07T00:00:00.000Z',
            auditedAt: '2026-09-07T00:01:00.000Z',
          },
        },
      },
    });
    const staleSnapshot = await getIssue(target.id);
    await db.adminSql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               payload,
               '{observation,ratings,end-to-end-flow,evidence}',
               ${JSON.stringify('concurrent proof must survive the audit CAS')}::jsonb,
               false
             )
       WHERE workspace_id = ${issuesScopeWorkspace()}
         AND feature_id = ${target.id}`;

    const winner = await recordGradingAudit(target.id, {
      auditIssueId: 'EI-AUDIT-WINNER',
      auditor: 'su-winning-auditor',
      verdict: 'passed',
      rubricRevision: 7,
      criteriaHash: 'grading-integrity-v7',
      requireCurrentIdentity: true,
      supersedesAuditIssueId: 'EI-AUDIT-OLD',
    });
    expect(winner).toMatchObject({
      ok: true,
      gradingAudit: {
        state: 'passed',
        auditIssueId: 'EI-AUDIT-WINNER',
        rubricRevision: 7,
        criteriaHash: 'grading-integrity-v7',
      },
    });

    const late = await recordGradingAudit(
      target.id,
      {
        auditIssueId: 'EI-AUDIT-LATE',
        auditor: 'su-late-auditor',
        verdict: 'failed',
        rubricRevision: 7,
        criteriaHash: 'grading-integrity-v7',
        requireCurrentIdentity: true,
        supersedesAuditIssueId: 'EI-AUDIT-OLD',
      },
      { getIssue: vi.fn(async () => staleSnapshot) as never },
    );
    expect(late).toMatchObject({ ok: false, issueId: target.id });

    const stored = await getIssue(target.id);
    const storedObservation = (
      stored?.payload as {
        observation?: {
          ratings?: Record<string, { evidence?: string }>;
          gradingAudit?: unknown;
        };
      }
    )?.observation;
    expect(storedObservation?.gradingAudit).toMatchObject({
      state: 'passed',
      auditIssueId: 'EI-AUDIT-WINNER',
      auditor: 'su-winning-auditor',
      rubricRevision: 7,
      criteriaHash: 'grading-integrity-v7',
    });
    expect(storedObservation?.ratings?.['end-to-end-flow']?.evidence).toBe(
      'concurrent proof must survive the audit CAS',
    );
  });
});

describe('grading-audit reservation identity — real PG', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  it('confirms the canonical author while refusing a changed author, fingerprint or lease', async () => {
    const workspaceId = issuesScopeWorkspace();
    const issueId = 'EI-reservation-identity';
    const reservationKey = `grading-audit:${issueId}`;
    const reservedAt = '2026-10-07T07:22:44.515Z';
    const expectedCard = {
      createdBy: 'su-reservation-author',
      evidenceFingerprint: 'reservation-fingerprint',
      rubricRef: 'test-reservation-rubric',
    };
    const payload = {
      _ei: { created_by: expectedCard.createdBy },
      observation: {
        evidenceFingerprint: expectedCard.evidenceFingerprint,
        rubricRef: expectedCard.rubricRef,
        gradingAudit: {
          state: 'pending',
          dispatchReservation: { key: reservationKey, reservedAt },
        },
      },
    };
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, payload)
      VALUES (${workspaceId}, 'papercusp', ${issueId}, 'change', 'done', 'admitted',
        'Reservation identity fixture', '', ${JSON.stringify(payload)}::text::jsonb)`;

    await db.adminSql.begin(async (tx) => {
      const confirm = (card = expectedCard, epoch = reservedAt) =>
        confirmPendingGradingAuditReservation(issueId, reservationKey, {
          workspaceId,
          reservedAt: epoch,
          tx: tx as unknown as OrgSql,
          expectedCard: card,
        });
      await expect(confirm()).resolves.toBe(true);
      await expect(confirm({ ...expectedCard, createdBy: 'su-other-author' })).resolves.toBe(false);
      await expect(confirm({ ...expectedCard, evidenceFingerprint: 'changed' })).resolves.toBe(false);
      await expect(confirm({ ...expectedCard, rubricRef: 'other-rubric' })).resolves.toBe(false);
      await expect(confirm(expectedCard, 'different-epoch')).resolves.toBe(false);
    });
  });
});

describe('readScorecardEvidence audit-target status (EI-24583166035391772) — real PG', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  // EI-24583166035391772: the grading-audit dispatch brief tells the auditor to
  // re-check supersession, retraction and subject-rubric currentness before
  // emitting. Those are READ-TIME relations, never stamps on the card, so the
  // evidence-first reader must compute them — and answer explicitly, so an
  // absent key is never read as "current".
  it('evidence-first reader reports the audit-target status: superseded, retracted, rubric-subject currentness', async () => {
    const AUDIT_RUBRIC = 'test-audit-target-status';
    const insert = async (issueId: string, observation: Record<string, unknown>, at: string) => {
      await db.adminSql`
        INSERT INTO harness_shared.engineer_issues
          (workspace_id, issue_id, kind, scope, title, body, severity, source,
           state, payload, created_by, signal_origin, created_at, updated_at)
        VALUES (
          ${issuesScopeWorkspace()}, ${issueId}, 'change',
          'harness:papercusp', ${`scorecard ${issueId}`}, '', 'minor', 'test',
          'done',
          ${JSON.stringify({ observation: { rubricRef: AUDIT_RUBRIC, sourceHive: 'papercusp', ...observation } })}::text::jsonb,
          'su-test', 'organic',
          ${at}::timestamptz, ${at}::timestamptz
        )`;
    };
    const ratings = { honesty: { rating: 'pass', evidence: 'ran the probe' } };
    const replayRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      classRef: 'plan-class-risk-floor',
      args: {
        harness: 'papercusp',
        slug: 'test-rerun-recipe-plan',
        classRef: 'plan-class-risk-floor',
        specIds: ['SPEC-001'],
        specRevision: 1,
        specFingerprint: 'a'.repeat(64),
        includeDraft: true,
      },
      selection: {
        planSlug: 'test-rerun-recipe-plan',
        specId: 'SPEC-001',
        specRevision: 1,
        specFingerprint: 'a'.repeat(64),
        evidence: [{ evidenceKind: 'test-run', evidenceRef: 'run:recipe-reader' }],
      },
      current: { supplied: false, fingerprints: [] },
      derivation: {
        kind: 'listSpecEvidence.currentness',
        classifier: 'classifySpecEvidenceCurrentness',
        unknownWhenMissing: true,
      },
    };
    await insert('EI-audit-target-plain', { ratings }, '2026-06-21T10:00:00Z');
    await insert('EI-audit-target-old', { ratings }, '2026-06-21T10:01:00Z');
    await insert('EI-audit-target-new', { ratings, supersedes: 'EI-audit-target-old' }, '2026-06-21T10:02:00Z');
    await insert('EI-audit-target-retracted', {
      ratings,
      retracted: { at: '2026-06-21T10:05:00Z', by: 'su-test', reason: 'wrong subject' },
    }, '2026-06-21T10:03:00Z');
    await insert('EI-audit-target-rubric-subject', {
      ratings,
      subject: { kind: 'rubric', ref: 'no-such-rubric-for-audit-target' },
    }, '2026-06-21T10:04:00Z');
    await insert('EI-audit-target-rerun-recipe', { ratings, rerunRecipe: replayRecipe }, '2026-06-21T10:04:30Z');

    const bindingWorkItemId = 'WI-audit-target-binding';
    const bindingPlanSlug = 'test-audit-target-binding';
    const bindingSpecId = 'SPEC-1';
    const bindingSpecFingerprint = 'a'.repeat(64);
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
      VALUES (${issuesScopeWorkspace()}, 'papercusp', ${bindingPlanSlug})`;
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, payload)
      VALUES (${issuesScopeWorkspace()}, 'papercusp', ${bindingWorkItemId}, 'bug', 'open', 'admitted',
        'Audit target binding fixture', '', '{}'::jsonb)`;
    const bindingId = await db.adminSql.begin(async (tx) => {
      // The identity → immutable revision → pointer update is one transaction
      // because the current-revision FK is deferred until commit.
      await tx`
        INSERT INTO harness_shared.plan_spec_clauses
          (workspace_id, harness_slug, plan_slug, spec_id, current_revision, created_by)
        VALUES (${issuesScopeWorkspace()}, 'papercusp', ${bindingPlanSlug}, ${bindingSpecId}, 0, 'su-test')`;
      await tx`
        INSERT INTO harness_shared.plan_spec_clause_revisions
          (workspace_id, harness_slug, plan_slug, spec_id, revision, plan_item_id, behavior,
           behavior_class, lifecycle_status, content_hash, created_by)
        VALUES (${issuesScopeWorkspace()}, 'papercusp', ${bindingPlanSlug}, ${bindingSpecId}, 1,
          'P-001', 'A cited binding becomes stale after retraction.', 'lifecycle', 'draft',
          ${bindingSpecFingerprint}, 'su-test')`;
      await tx`
        UPDATE harness_shared.plan_spec_clauses SET current_revision = 1
         WHERE workspace_id = ${issuesScopeWorkspace()} AND harness_slug = 'papercusp'
           AND plan_slug = ${bindingPlanSlug} AND spec_id = ${bindingSpecId}`;
      await tx`
        INSERT INTO harness_shared.work_item_spec_revision_edges
          (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint, created_by)
        VALUES (${issuesScopeWorkspace()}, 'papercusp', ${bindingWorkItemId}, ${bindingPlanSlug},
          ${bindingSpecId}, 1, ${bindingSpecFingerprint}, 'su-test')`;
      const [row] = await tx<Array<{ id: number }>>`
        INSERT INTO harness_shared.spec_evidence_bindings
          (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint,
           evidence_kind, evidence_ref, source_fingerprint, binding_fingerprint, created_by)
        VALUES (${issuesScopeWorkspace()}, 'papercusp', ${bindingWorkItemId}, ${bindingPlanSlug},
          ${bindingSpecId}, 1, ${bindingSpecFingerprint}, 'mutation', 'test-run:scorecard-binding',
          'source-fingerprint', ${'b'.repeat(64)}, 'su-test')
        RETURNING id`;
      return Number(row.id);
    });
    const reboundBindingId = await db.adminSql.begin(async (tx) => {
      const [row] = await tx<Array<{ id: number }>>`
        INSERT INTO harness_shared.spec_evidence_bindings
          (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint,
           evidence_kind, evidence_ref, source_fingerprint, binding_fingerprint, created_by)
        VALUES (${issuesScopeWorkspace()}, 'papercusp', ${bindingWorkItemId}, ${bindingPlanSlug},
          ${bindingSpecId}, 1, ${bindingSpecFingerprint}, 'mutation', 'test-run:scorecard-binding-rebound',
          'replacement-source-fingerprint', ${'c'.repeat(64)}, 'su-test')
        RETURNING id`;
      return Number(row.id);
    });
    await insert('EI-audit-target-binding', {
      ratings,
      rerunRecipe: { args: { harness: 'papercusp' }, selection: { bindingIds: [bindingId] } },
    }, '2026-06-21T10:05:00Z');
    await insert('EI-audit-target-binding-rebound', {
      ratings,
      rerunRecipe: { args: { harness: 'papercusp' }, selection: { bindingIds: [reboundBindingId] } },
    }, '2026-06-21T10:05:15Z');
    await insert('EI-audit-target-binding-legacy', {
      ratings,
      // Legacy evaluator recipes retained the exact structured evidence tuple
      // but predated selection.bindingIds. The reader must still resolve that
      // tuple to the immutable row and fail closed after its retraction.
      rerunRecipe: {
        args: {
          harness: 'papercusp',
          current: [{
            planSlug: bindingPlanSlug,
            specId: bindingSpecId,
            specRevision: 1,
            specFingerprint: bindingSpecFingerprint,
            evidenceKind: 'mutation',
            evidenceRef: 'test-run:scorecard-binding',
            sourceFingerprint: 'source-fingerprint',
            testFingerprint: null,
            fixtureFingerprint: null,
            rubricFingerprint: null,
            environmentFingerprint: null,
          }],
        },
      },
    }, '2026-06-21T10:05:30Z');
    await insert('EI-audit-target-binding-unavailable', {
      ratings,
      rerunRecipe: {
        args: { harness: 'papercusp' },
        selection: { bindingIds: [Number.MAX_SAFE_INTEGER] },
      },
    }, '2026-06-21T10:05:45Z');

    const read = async (id: string) => {
      const result = await readScorecardEvidence(id);
      if (result.kind !== 'found') throw new Error(`${id}: ${result.kind}`);
      return result.scorecard;
    };

    // A plain card answers EXPLICITLY — every key present, not absent-means-current.
    expect((await read('EI-audit-target-plain')).auditTarget).toEqual({
      current: true, superseded: false, supersededBy: null, retracted: false, subjectRubricCurrentness: null,
    });
    expect((await read('EI-audit-target-plain')).rubricCurrentness).toMatchObject({
      state: 'unknown', reason: 'recorded-identity-missing',
    });
    expect((await read('EI-audit-target-rerun-recipe')).rerunRecipe).toEqual(replayRecipe);

    const old = await read('EI-audit-target-old');
    expect(old.supersededBy).toBe('EI-audit-target-new');
    expect(old.auditTarget).toMatchObject({ current: false, superseded: true, supersededBy: 'EI-audit-target-new' });
    // The superseder itself is current.
    expect((await read('EI-audit-target-new')).auditTarget).toMatchObject({ current: true, superseded: false });

    const retracted = await read('EI-audit-target-retracted');
    expect(retracted.auditTarget).toMatchObject({ current: false, retracted: true, superseded: false });

    // An unresolved subject identity is unknown, not a known stale result.
    const rubricSubject = await read('EI-audit-target-rubric-subject');
    expect(rubricSubject.subjectRubricCurrentness).toMatchObject({ state: 'unknown', reason: 'live-identity-missing' });
    expect(rubricSubject.auditTarget).toMatchObject({
      current: null,
      subjectRubricCurrentness: expect.objectContaining({ state: 'unknown' }),
    });

    // An exact rerun recipe is only current while every cited immutable proof row
    // remains active. Retraction removes the row from evaluator reads, so the
    // audit-target reader must invalidate the original pass at read time.
    const bindingCard = await read('EI-audit-target-binding');
    expect(bindingCard.auditTarget).toMatchObject({
      current: true,
      evidenceBindingCurrentness: {
        state: 'current', reason: 'current', citedBindingCount: 1,
        retractedBindingIds: [], unavailableBindingIds: [],
      },
    });
    expect((await read('EI-audit-target-binding-legacy')).auditTarget).toMatchObject({
      current: true,
      evidenceBindingCurrentness: {
        state: 'current', reason: 'current', citedBindingCount: 1,
        retractedBindingIds: [], unavailableBindingIds: [],
      },
    });
    const bindingUnavailable = await read('EI-audit-target-binding-unavailable');
    expect(bindingUnavailable.auditTarget).toMatchObject({
      current: null,
      evidenceBindingCurrentness: {
        state: 'unknown', reason: 'cited-binding-unavailable', citedBindingCount: 1,
        retractedBindingIds: [], unavailableBindingIds: [String(Number.MAX_SAFE_INTEGER)],
      },
    });
    // Rebinding installs a fresh live row and retracts the previous cohort.
    // Both exact-id and legacy tuple readers must keep the old card from becoming
    // an audit target while the replacement remains current.
    await db.adminSql`
      UPDATE harness_shared.spec_evidence_bindings
         SET retracted_at = now(), retracted_by = 'su-test', retraction_reason = 'fixture withdrawal'
       WHERE workspace_id = ${issuesScopeWorkspace()} AND id = ${bindingId}`;
    const bindingRetractedCard = await read('EI-audit-target-binding');
    expect(bindingRetractedCard.auditTarget).toMatchObject({
      current: false,
      evidenceBindingCurrentness: {
        state: 'stale', reason: 'cited-binding-retracted', citedBindingCount: 1,
        retractedBindingIds: [String(bindingId)], unavailableBindingIds: [],
      },
    });
    expect((await read('EI-audit-target-binding-legacy')).auditTarget).toMatchObject({
      current: false,
      evidenceBindingCurrentness: {
        state: 'stale', reason: 'cited-binding-retracted', citedBindingCount: 1,
        retractedBindingIds: [String(bindingId)], unavailableBindingIds: [],
      },
    });
    expect((await read('EI-audit-target-binding-rebound')).auditTarget).toMatchObject({
      current: true,
      evidenceBindingCurrentness: {
        state: 'current', reason: 'current', citedBindingCount: 1,
        retractedBindingIds: [], unavailableBindingIds: [],
      },
    });
  });
});

describe('human market canonical review readers — real PG', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  });
  afterAll(async () => db?.cleanup());

  it('grades the exact human submission with the real rubric and scorecard readers and rechecks payment evidence', async () => {
    const rubricId = 'test-human-market-review';
    await proposeRubric({
      rubricId, characteristic: 'human-work-quality', title: 'Human work review fixture',
      criteria: [{ key: 'result', title: 'Result', model: 'A complete result.',
        method: 'Read the submitted result.', driftMarkers: 'Missing result.' }],
      status: 'active', by: 'su-test',
    });
    const rubric = await getRubric(rubricId);
    expect(rubric).toMatchObject({ status: 'active' });
    expect(rubric!.criteriaHash).toMatch(/^[a-f0-9]{64}$/);
    const owner = '00000000-0000-4000-8000-000000000001';
    const human = '00000000-0000-4000-8000-000000000002';
    const scope = { workspaceId: issuesScopeWorkspace(), harness: 'human-market-reader', id: 'WI-human-reader' };
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, payload)
      VALUES (${scope.workspaceId}, ${scope.harness}, ${scope.id}, 'task', 'needs-human', 'admitted',
        'Human review fixture', '', ${JSON.stringify({ humanWork: {
          route: 'market', version: 0, ownerUserId: owner, brief: 'Submit a complete result.',
          rubricRef: rubricId, rubricRevision: rubric!.revision, rubricCriteriaHash: rubric!.criteriaHash,
          amountCents: 500, currency: 'USD',
        } })}::text::jsonb)`;
    await actOnHumanMarketItem({ ...scope, userId: human, version: 0, action: 'claim' });
    const submitted = await actOnHumanMarketItem({ ...scope, userId: human, version: 1,
      action: 'submit', result: 'A complete result.' });
    const submission = readHumanMarketJob(submitted)!.submission!;
    const cardId = await fileScorecard(db, {
      id: 'human-result', rubricRef: rubricId, rubricRevision: rubric!.revision,
      criteriaHash: rubric!.criteriaHash!, subject: { kind: 'work-item', ref: scope.id },
      ratings: { result: { rating: 'healthy', evidence: `Read the result; submission-sha256:${submission.sha256}` } },
      createdAt: new Date().toISOString(), createdBy: 'su-unrelated-review-fixture',
    });
    const evidence = await readScorecardEvidence(cardId);
    expect(evidence.kind).toBe('found');
    if (evidence.kind !== 'found') throw new Error('canonical scorecard fixture missing');
    expect(evidence.scorecard).toMatchObject({ rubricResolved: true, missingKeys: [], extraKeys: [],
      auditTarget: { current: true }, rubricRevision: rubric!.revision, criteriaHash: rubric!.criteriaHash });
    const graded = await reviewHumanMarketItem({ ...scope, userId: owner, version: 2, action: 'grade', scorecardRef: cardId });
    expect(readHumanMarketJob(graded)!.grade).toMatchObject({ passed: true, scorecardRef: cardId,
      submissionSha256: submission.sha256, graderId: 'su-unrelated-review-fixture' });

    // The real reader must invalidate a grade retracted after acceptance.
    await db.adminSql`UPDATE harness_shared.engineer_issues
      SET payload = jsonb_set(payload, '{observation,retracted}', ${JSON.stringify({
        at: new Date().toISOString(), by: 'su-audit-fixture', reason: 'wrong submission',
      })}::text::jsonb)
      WHERE workspace_id = ${scope.workspaceId} AND issue_id = ${cardId}`;
    const retracted = await readScorecardEvidence(cardId);
    expect(retracted.kind === 'found' && retracted.scorecard.auditTarget.retracted).toBe(true);
    await expect(reviewHumanMarketItem({ ...scope, userId: owner, version: 3, action: 'payment',
      receiptRef: 'test-only-manual-receipt' })).rejects.toThrow('market_scorecard_mismatch');
    await db.adminSql`UPDATE harness_shared.engineer_issues
      SET payload = payload #- '{observation,retracted}'
      WHERE workspace_id = ${scope.workspaceId} AND issue_id = ${cardId}`;
    const paid = await reviewHumanMarketItem({ ...scope, userId: owner, version: 3, action: 'payment',
      receiptRef: 'test-only-manual-receipt' });
    expect(readHumanMarketJob(paid)!.payment).toMatchObject({ paidBy: owner, amountCents: 500, currency: 'USD' });
    // This fixture attests persistence only; it never transfers money or accepts E3.
  });
});

describe('listScorecardPage provisionalOnly (WI-6554700010009935) — real PG', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  // The grading-integrity terminal-re-rate drill needs only the interim (provisional)
  // cards for one subject. Without a server-side filter judges paged 200-500 terminal
  // cards (1.6-4MB per read) to find them.
  it('returns only cards whose observation.provisional is an object, newest-first, composed with subjectRef', async () => {
    const RUBRIC = 'test-provisional-only';
    const insert = async (issueId: string, observation: Record<string, unknown>, at: string) => {
      await db.adminSql`
        INSERT INTO harness_shared.engineer_issues
          (workspace_id, issue_id, kind, scope, title, body, severity, source,
           state, payload, created_by, signal_origin, created_at, updated_at)
        VALUES (
          ${issuesScopeWorkspace()}, ${issueId}, 'change',
          'harness:papercusp', ${`scorecard ${issueId}`}, '', 'minor', 'test',
          'done',
          ${JSON.stringify({ observation: { rubricRef: RUBRIC, sourceHive: 'papercusp', ...observation } })}::text::jsonb,
          'su-test', 'organic',
          ${at}::timestamptz, ${at}::timestamptz
        )`;
    };
    const ratings = { honesty: { rating: 'pass', evidence: 'ran the probe' } };
    const provisional = { violatableKeys: ['honesty'], stampedAt: '2026-10-13T01:00:00.000Z' };
    await insert('EI-PROV-A1', { ratings, subject: { kind: 'agent-run', ref: 'run-a' }, provisional }, '2026-10-13T01:00:00.000Z');
    await insert('EI-PROV-A2', { ratings, subject: { kind: 'agent-run', ref: 'run-a' }, provisional }, '2026-10-13T02:00:00.000Z');
    await insert('EI-TERM-A', { ratings, subject: { kind: 'agent-run', ref: 'run-a' } }, '2026-10-13T03:00:00.000Z');
    await insert('EI-PROV-B', { ratings, subject: { kind: 'agent-run', ref: 'run-b' }, provisional }, '2026-10-13T04:00:00.000Z');
    // A JSON null stamp is not a provisional card.
    await insert('EI-NULL-B', { ratings, subject: { kind: 'agent-run', ref: 'run-b' }, provisional: null }, '2026-10-13T05:00:00.000Z');

    const ids = async (filter: Parameters<typeof listScorecardPage>[0]) =>
      (await listScorecardPage({ rubricRef: RUBRIC, ...filter })).rows.map((row) => row.issueId);

    expect(await ids({})).toEqual(['EI-NULL-B', 'EI-PROV-B', 'EI-TERM-A', 'EI-PROV-A2', 'EI-PROV-A1']);
    expect(await ids({ provisionalOnly: true })).toEqual(['EI-PROV-B', 'EI-PROV-A2', 'EI-PROV-A1']);
    expect(await ids({ provisionalOnly: true, subjectRef: 'run-a' })).toEqual(['EI-PROV-A2', 'EI-PROV-A1']);
    expect(await ids({ provisionalOnly: false, subjectRef: 'run-a' })).toEqual(['EI-TERM-A', 'EI-PROV-A2', 'EI-PROV-A1']);
  });
});
