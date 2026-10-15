/**
 * emit-from-ledger.integration.test.ts — plan test-rubric-unification-2026-10-12 P-007 (R-7).
 *
 * BAR R-7: "A ledger-filled scorecard emission rates every executable criterion from its latest
 * ledger result." BROKEN if any ONE: (1) an executable criterion with a recorded result still
 * needs a hand-typed rating; (2) it is rated from anything other than its latest ledger result;
 * (3) the criterion's threshold is not applied to that result; (4) a manual criterion is
 * auto-rated instead of asked; (5) an executable criterion with no ledger result rates anything
 * but unknown.
 *
 * Real Postgres (testcontainer + the full migrated baseline) and the real emit path: the fixture
 * rubric is proposed through proposeRubric, its ledger rows are written by
 * recordRubricCheckResults into harness_shared.test_runs, scorecards:emit reads them back through
 * the production readLatestRubricCheckResults (getOrgPg points at the test database), and the
 * filed card is read back from the work-item row it persisted. Nothing in the rating path is
 * mocked; the only injected seam is a probe dispatcher that throws, so a ledger-owned probe that
 * were re-executed live would fail the emit instead of passing silently.
 *
 * Fixture (mixed executable and manual criteria):
 *   - disk-latest      instrument, threshold < 80 %: an OLDER row 91 % (fail) and a NEWER row
 *                      42 % (pass) — only the latest counts, so it rates the best level;
 *   - cpu-threshold    instrument, threshold <= 2 cores: one row of 3.5 cores RECORDED as pass
 *                      (under an older, looser threshold) — today's threshold rates it the worst level;
 *   - query-cost       sql probe, threshold <= 50 ms and band <= 80 ms: one row at 62.38 ms rates
 *                      the intermediate level from its numeric ledger value;
 *   - probe-recorded   sql probe, rowCount eq 1: one row observing 1 → best level, not re-run;
 *   - probe-unrecorded sql probe with no ledger row → unknown (not-exercised), not asked;
 *   - manual-judgement no check → never auto-rated; the emit asks for it by key.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(workspaceId: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
      (h.sql as postgres.Sql).begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        return cb(tx as unknown as postgres.Sql);
      }) as Promise<T>,
  };
});

// A sql probe pins dev:pg_query's projected schema revision, which resolves only once the tool
// is registered in this process.
await import('../dev/pg_query');
const { emitScorecard, _closeScorecardEmitMutexForTests } = await import('./emit');
const { proposeRubric, getRubric } = await import('../../rubrics');
const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../workspace-registry');
const { _resetHarnessAdminUrlCacheForTests } = await import('../../embedded-pg-discovery');
const { recordRubricCheckResults, rubricCheckLedgerPath } = await import('../../check-results-ledger');
const { SQL_PROBE_TOOL, continuityProbeRevision } = await import('../../continuity-probes');
const { asStructuredObservation } = await import('../../harness/improvements/observation-types');
type RubricCheckResult = import('../../check-results-ledger').RubricCheckResult;

const RUBRIC = 'emit-from-ledger-fixture';
const OWNER = 'su-emit-from-ledger-grader';
const MANUAL_RATING = { rating: 'healthy', evidence: 'read the release notes; the wording matches the shipped behaviour' };
const CPU_REMEDIATION = 'WI-6554700010009536 cpu regression follow-up';

let db: Awaited<ReturnType<typeof createOrgTestDb>>;
let workspaceId: string | null = null;
const SAVED_ADMIN_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
type Sql = Parameters<typeof recordRubricCheckResults>[2];
const sql = (): Sql => db.adminSql as unknown as Sql;

/** Live probe dispatch must never happen for a ledger-owned criterion. */
const dispatched: string[] = [];
const dispatchTool = async (name: string): Promise<unknown> => {
  dispatched.push(name);
  throw new Error(`fromLedger must not re-run a ledger-owned probe live (dispatched ${name})`);
};

function sqlProbe(expectValue: number) {
  const schemaRevision = continuityProbeRevision(SQL_PROBE_TOOL);
  if (!schemaRevision) throw new Error(`${SQL_PROBE_TOOL} is not registered; its probe revision is unresolvable`);
  return { kind: 'sql', sql: 'SELECT 1 AS n', schemaRevision, expect: { path: '$.rowCount', op: 'eq', value: expectValue } };
}

const criterion = (key: string, check?: Record<string, unknown>) => ({
  key,
  title: key,
  model: `${key} holds`,
  method: `read ${key}`,
  driftMarkers: `${key} drifts`,
  ...(check ? { check } : {}),
});

const row = (
  criterionKey: string,
  kind: 'probe' | 'instrument',
  value: number,
  unit: string | null,
  verdict: RubricCheckResult['verdict'],
  measuredAt: string,
  expect?: { op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq'; value: number },
): RubricCheckResult => ({
  check: {
    id: kind === 'probe' ? `${criterionKey}:0` : `${criterionKey}:instrument`,
    rubricRef: RUBRIC,
    criterionKey,
    kind,
    value,
    unit,
    ...(expect ? { expect } : {}),
  },
  verdict,
  measuredAt,
  durationMs: 5,
});

const ids: Record<string, number> = {};

async function ledgerRowCount(): Promise<number> {
  const [{ n }] = (await db.adminSql`
    SELECT count(*)::int AS n FROM harness_shared.test_runs
     WHERE left(file_path, ${`rubric-check/${RUBRIC}/`.length}) = ${`rubric-check/${RUBRIC}/`}
  `) as unknown as Array<{ n: number }>;
  return n;
}

async function persistedObservation(issueId: string): Promise<Record<string, unknown>> {
  const [found] = (await db.adminSql`
    SELECT payload FROM harness_shared.work_items WHERE feature_id = ${issueId}
  `) as unknown as Array<{ payload: { observation?: Record<string, unknown> } | null }>;
  if (!found?.payload?.observation) throw new Error(`no observation persisted on ${issueId}`);
  return found.payload.observation;
}

const emit = (args: Record<string, unknown>) =>
  emitScorecard({ rubricRef: RUBRIC, fromLedger: true, ...args } as never, {
    createdBy: OWNER,
    ctxHarness: 'papercusp',
    workspaceId: activeWorkspaceId(),
  }, { dispatchTool });

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 8 });
  h.sql = db.adminSql;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  _resetHarnessAdminUrlCacheForTests();

  await proposeRubric({
    rubricId: RUBRIC,
    characteristic: 'scorecard-emission',
    title: 'Scorecards filled from the results ledger (fixture)',
    criteria: [
      criterion('disk-latest', { kind: 'instrument', instrumentKey: 'host:df-root-used-pct', expect: { op: 'lt', value: 80 } }),
      criterion('cpu-threshold', { kind: 'instrument', instrumentKey: 'host:cgroup-cpu-delta-cores', expect: { op: 'lte', value: 2 } }),
      criterion('query-cost', {
        kind: 'probe',
        probe: {
          kind: 'sql',
          sql: 'SELECT 1 AS mean_ms',
          schemaRevision: continuityProbeRevision(SQL_PROBE_TOOL),
          expect: { path: '$.rows[0].mean_ms', op: 'lte', value: 50 },
        },
        unit: 'ms',
        ratingBands: [{ rating: 'degraded', expect: { op: 'lte', value: 80 } }],
      }),
      criterion('probe-recorded', { kind: 'probe', probe: sqlProbe(1) }),
      criterion('probe-unrecorded', { kind: 'probe', probe: sqlProbe(1) }),
      criterion('manual-judgement'),
    ] as never,
    status: 'active',
    by: 'su-emit-from-ledger-author',
  });
  workspaceId = (await getRubric(RUBRIC))?.workspaceId ?? null;
  const scope = { workspaceId, harnessSlug: 'papercusp', root: '/repo' };

  // Two results for disk-latest: the older one fails the threshold, the newer one passes.
  [ids.diskOlder] = await recordRubricCheckResults(
    [row('disk-latest', 'instrument', 91, '%', 'fail', '2026-10-13T01:00:00.000Z', { op: 'lt', value: 80 })], scope, sql(),
  );
  [ids.diskNewer] = await recordRubricCheckResults(
    [row('disk-latest', 'instrument', 42, '%', 'pass', '2026-10-13T01:30:00.000Z', { op: 'lt', value: 80 })], scope, sql(),
  );
  // Recorded as pass under an older, looser threshold (<= 4); today's rubric says <= 2.
  [ids.cpu] = await recordRubricCheckResults(
    [row('cpu-threshold', 'instrument', 3.5, 'cores', 'pass', '2026-10-13T01:30:00.000Z', { op: 'lte', value: 4 })], scope, sql(),
  );
  [ids.queryCost] = await recordRubricCheckResults(
    [row('query-cost', 'probe', 62.38, 'ms', 'fail', '2026-10-13T01:30:00.000Z', { op: 'lte', value: 50 })], scope, sql(),
  );
  [ids.probe] = await recordRubricCheckResults(
    [row('probe-recorded', 'probe', 1, null, 'pass', '2026-10-13T01:30:00.000Z')], scope, sql(),
  );
}, 180_000);

afterAll(async () => {
  await _closeScorecardEmitMutexForTests();
  await db?.cleanup();
  _resetHarnessAdminUrlCacheForTests();
  if (SAVED_ADMIN_URL === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
  else process.env.HARNESS_ADMIN_DATABASE_URL = SAVED_ADMIN_URL;
});

describe('R-7 — scorecards:emit { fromLedger: true } rates executable criteria from their latest ledger result', () => {
  it('asks only for the manual criterion: with no ratings the emit is refused naming exactly that key, and nothing is filed', async () => {
    const result = await emit({});
    expect(result).toMatchObject({
      ok: false,
      ledgerFillRefusal: { error: 'manual_rating_missing', criterionKeys: ['manual-judgement'] },
    });
    const [{ n }] = (await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.work_items WHERE payload->'observation'->>'rubricRef' = ${RUBRIC}
    `) as unknown as Array<{ n: number }>;
    expect(n).toBe(0);
  }, 60_000);

  it('refuses a hand rating that contradicts the latest ledger result of an executable criterion', async () => {
    const result = await emit({
      ratings: { 'manual-judgement': MANUAL_RATING, 'disk-latest': { rating: 'broken', evidence: 'the old 91% reading' } },
    });
    expect(result).toMatchObject({
      ok: false,
      ledgerFillRefusal: { error: 'ledger_rating_contradicted', criterionKeys: ['disk-latest'] },
    });
  }, 60_000);

  it('a poor ledger result still needs an owned disposition, and the refusal names the rating-free route', async () => {
    const result = await emit({ ratings: { 'manual-judgement': MANUAL_RATING } });
    expect(result.ok).toBe(false);
    expect(String((result as { error?: unknown }).error)).toMatch(/cpu-threshold.*NO disposition[\s\S]*ledgerDispositions/);
  }, 60_000);

  it('refuses a ledger disposition aimed at a criterion the ledger does not rate', async () => {
    const result = await emit({
      ratings: { 'manual-judgement': MANUAL_RATING },
      ledgerDispositions: { 'manual-judgement': { disregard: 'manual criteria are routed on their own rating' } },
    });
    expect(result).toMatchObject({
      ok: false,
      ledgerFillRefusal: { error: 'ledger_disposition_unowned', criterionKeys: ['manual-judgement'] },
    });
  }, 60_000);

  it('files a card rating every executable criterion from the ledger and the manual one from the grader', async () => {
    const rowsBefore = await ledgerRowCount();
    const result = await emit({
      ratings: { 'manual-judgement': MANUAL_RATING },
      // The poor cpu result is routed WITHOUT a hand-typed rating.
      ledgerDispositions: {
        'cpu-threshold': { remediation: CPU_REMEDIATION },
        'query-cost': { disregard: 'Intermediate fixture band is recorded without a separate remediation.' },
      },
      instrumentSnapshots: {
        'host:df-root-used-pct': {
          verdict: 'pass',
          measuredAt: '2026-10-13T01:30:00.000Z',
          value: 42,
          provenance: 'self-reported',
        },
      },
    });
    expect(result.ok ? 'ok' : result).toBe('ok');
    if (!result.ok) return;
    expect(result).toMatchObject({
      created: true,
      ledgerFill: { filled: ['disk-latest', 'cpu-threshold', 'query-cost', 'probe-recorded'], unrecorded: ['probe-unrecorded'] },
    });
    // The ledger-owned probe was rated from its recorded row, never re-run live, and the emit
    // wrote no new ledger row that the rating did not see.
    expect(dispatched).toEqual([]);
    expect(await ledgerRowCount()).toBe(rowsBefore);

    const issueId = 'issueId' in result ? result.issueId : undefined;
    expect(typeof issueId).toBe('string');
    const observation = await persistedObservation(issueId as string);
    expect(observation.ledgerFilled).toBe(true);
    const ratings = observation.ratings as Record<string, Record<string, unknown>>;

    // (1)+(2): rated with no hand rating, from the NEWER of two rows (42 %, pass), not the older 91 %.
    expect(ratings['disk-latest']).toMatchObject({
      rating: 'healthy',
      ratedFrom: 'ledger',
      ledgerResult: { testRunId: ids.diskNewer, value: 42, unit: '%' },
      evidenceRef: `test_runs:${ids.diskNewer}`,
    });
    expect(ids.diskOlder).not.toBe(ids.diskNewer);

    // (3): the row was recorded as pass, but today's threshold (<= 2 cores) rates 3.5 cores a fail.
    expect(ratings['cpu-threshold']).toMatchObject({
      rating: 'broken',
      ratedFrom: 'ledger',
      ledgerResult: { testRunId: ids.cpu, value: 3.5, unit: 'cores' },
      remediation: CPU_REMEDIATION,
    });
    expect(String(ratings['cpu-threshold']!.evidence)).toMatch(/cpu-threshold:instrument=3\.5 cores → fail/);

    // The recorded status fails the meets threshold, but the scalar remains inside the
    // explicitly declared intermediate band and must not collapse to the worst rating.
    expect(ratings['query-cost']).toMatchObject({
      rating: 'degraded',
      ratedFrom: 'ledger',
      ledgerResult: { testRunId: ids.queryCost, value: 62.38, unit: 'ms' },
      disregard: 'Intermediate fixture band is recorded without a separate remediation.',
    });
    expect(String(ratings['query-cost']!.evidence)).toMatch(/query-cost:0=62\.38 ms → fail; scorecard rating degraded/);

    expect(ratings['probe-recorded']).toMatchObject({
      rating: 'healthy',
      ratedFrom: 'ledger',
      ledgerResult: { testRunId: ids.probe, value: 1, unit: null },
    });

    // (5): an executable criterion with no ledger result is unknown, and was not asked of the grader.
    expect(ratings['probe-unrecorded']).toMatchObject({ rating: 'unknown', unknownReason: 'not-exercised' });
    expect(String(ratings['probe-unrecorded']!.nextEvidenceAction)).toMatch(/probe-unrecorded:0/);
    expect(ratings['probe-unrecorded']!.ratedFrom).toBeUndefined();

    // (4): the manual criterion carries the grader's rating, untouched by the ledger.
    expect(ratings['manual-judgement']).toMatchObject(MANUAL_RATING);
    expect(ratings['manual-judgement']!.ratedFrom).toBeUndefined();

    // The stamps survive the shared observation reader that scorecard surfaces use.
    const structured = asStructuredObservation(observation);
    expect(structured?.ledgerFilled).toBe(true);
    expect(structured?.ratings?.['disk-latest']).toMatchObject({
      ratedFrom: 'ledger',
      ledgerResult: { testRunId: ids.diskNewer, value: 42, unit: '%' },
    });
    expect(rubricCheckLedgerPath(RUBRIC, 'disk-latest:instrument')).toBe(`rubric-check/${RUBRIC}/disk-latest:instrument`);
  }, 120_000);
});
