/**
 * check-results-ledger.integration.test.ts — plan test-rubric-unification-2026-10-12 P-006 (R-6).
 *
 * BAR R-6: "Every executed probe or instrument check writes exactly one row carrying its check
 * id, value and unit to the same results ledger that holds test-case rows."
 *
 * Against REAL Postgres (testcontainer + the full migrated baseline), this pins:
 *   - one harness_shared.test_runs row per EXECUTED probe (a grouped `all` check is one row per
 *     child), framework 'rubric-check', in the same table as a vitest file row;
 *   - instrument readings recorded with their unit, judged pass/fail against the threshold,
 *     and 'error' with a null value when nothing was measured (never a silent 0);
 *   - manual ('none') and platform-computed instrument bindings write nothing (not executed here);
 *   - one history per check: repeated runs append to the same file_path, and the latest-result
 *     read returns the newest row per check, scoped to the workspace;
 *   - a stored row reads back through the shared strict execution_details parser that
 *     testing:runs uses, so the check is visible, not 'invalid-or-unsupported'.
 *
 * The probe path runs the REAL evaluateCriterionProbeChecks over a dispatcher that answers in
 * dev:pg_query's result shape; only the tool's data is canned (rubric-probe-sql.test.ts pins
 * the real dev:pg_query guard itself).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as nativeAdoption from './code-intelligence/native-adoption';
import { rescoreRubric, type RubricRescoreDeps } from './harness/routines/rubric-rescore-action';
import { fillRatingsFromLedger } from './scorecard-ledger-fill';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import type { OrgTestDb } from '../test/_org-test-db';
import { createOrgTestDb } from '../test/_org-test-db';
import {
  RUBRIC_CHECK_FRAMEWORK,
  probeCheckResults,
  readLatestRubricCheckResults,
  recordRubricCheckResults,
  rubricCheckLedgerPath,
  runInstrumentChecks,
  type RubricCheckResult,
} from './check-results-ledger';
import { SQL_PROBE_TOOL, continuityProbeRevision } from './continuity-probes';
import { evaluateCriterionProbeChecks } from './rubrics-criterion-checks';
import type { InstrumentReading } from './rubric-instrument-registry';
// A sql probe pins dev:pg_query's projected schema revision, which resolves only once the tool is
// registered: importing it is what makes continuityProbeRevision(SQL_PROBE_TOOL) non-null.
import './agent-tools/dev/pg_query';

const WS = 'ws-check-ledger';
const OTHER_WS = 'ws-check-ledger-other';
const RUBRIC = 'acceptance-check-ledger-fixture';
const SCOPE = { workspaceId: WS, harnessSlug: 'papercusp', root: '/repo' };

let db: OrgTestDb;
type Sql = Parameters<typeof recordRubricCheckResults>[2];
const sql = (): Sql => db.adminSql as unknown as Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

function sqlProbe(expectValue: number) {
  const schemaRevision = continuityProbeRevision(SQL_PROBE_TOOL);
  if (!schemaRevision) throw new Error(`${SQL_PROBE_TOOL} is not registered; its probe revision is unresolvable`);
  return {
    kind: 'sql',
    sql: 'SELECT 1 AS n',
    schemaRevision,
    expect: { path: '$.rowCount', op: 'eq', value: expectValue },
  };
}

/** Answers like dev:pg_query: one row. */
async function dispatchTool(name: string): Promise<unknown> {
  if (name !== SQL_PROBE_TOOL) throw new Error(`unexpected tool ${name}`);
  return { data: { mode: 'query', rowCount: 1, truncated: false, fields: ['n'], rows: [{ n: 1 }] } };
}

async function rowsById(ids: number[]) {
  return (await db.adminSql`
    SELECT id, file_path, framework, status, workspace_id, output_tail, execution_details
      FROM harness_shared.test_runs WHERE id = ANY(${ids}) ORDER BY id
  `) as unknown as Array<{
    id: number; file_path: string; framework: string; status: string; workspace_id: string | null;
    output_tail: string | null; execution_details: unknown;
  }>;
}

const reading = (key: string, unit: InstrumentReading['unit'], value: number | null): InstrumentReading => ({
  key, unit, value, argv: ['true'], measuredAt: '2026-10-13T02:00:00.000Z', ...(value === null ? { error: 'output did not parse' } : {}),
});

describe('R-6 — every executed probe or instrument check writes one row to the results ledger', () => {
  it('scheduled adoption measures the real activity ledger, records regression, and grades from the stored result', async () => {
    const rubricRef = 'acceptance-scheduled-native-fixture';
    const at = '2026-10-13T04:00:00.000Z';
    const criteria = [{ key: 'r-31', check: { kind: 'instrument' as const, instrumentKey: nativeAdoption.NATIVE_ADOPTION_INSTRUMENT_KEYS.goodUse } }];
    await db.adminSql`
      INSERT INTO harness_shared.agent_activity (workspace_id, owner_id, kind, tool_name, phase, detail, created_at)
      SELECT ${WS}, 'fixture-' || n, 'tool', 'Bash', 'post',
        jsonb_build_object('command', ${"rg -n 'export function alpha' src"}::text), '2026-10-12T04:00:00Z'::timestamptz
      FROM generate_series(1, 500) AS n
    `;
    await recordRubricCheckResults([{
      check: { id: 'r-31:instrument', rubricRef, criterionKey: 'r-31', kind: 'instrument', value: 1, unit: 'count' },
      verdict: 'pass', measuredAt: '2026-10-13T03:00:00.000Z', durationMs: 0,
    }], SCOPE, sql());
    const measureFromDb = nativeAdoption.measureNativeAdoptionWindow;
    const measure = vi.spyOn(nativeAdoption, 'measureNativeAdoptionWindow')
      .mockImplementation(window => measureFromDb(window, db.adminSql));
    const emit = vi.fn<NonNullable<RubricRescoreDeps['emit']>>(async opts => ({
      ok: true, key: opts.key, woken: 0, notified: [], msgId: null, waiters: 0,
    }));
    const deps: RubricRescoreDeps = {
      getRubric: async () => ({ rubricId: rubricRef, workspaceId: WS, criteria }),
      readLatest: (input: Parameters<typeof readLatestRubricCheckResults>[0]) => readLatestRubricCheckResults(input, sql()),
      record: (results: ReadonlyArray<RubricCheckResult>, scope: Parameters<typeof recordRubricCheckResults>[1]) =>
        recordRubricCheckResults(results, scope, sql()),
      runInstruments: (input: Parameters<typeof runInstrumentChecks>[0]) => runInstrumentChecks({ ...input, now: () => Date.parse(at) }),
      emit,
    };
    try {
      const outcome = await rescoreRubric({ rubricRef, workspaceId: OTHER_WS, harnessSlug: 'papercusp' }, deps);
      expect(measure).toHaveBeenCalledWith({ workspaceId: WS, windowStart: '2026-10-10T04:00:00.000Z', windowEnd: at });
      expect(outcome.executed).toBe(1);
      expect(outcome.crossings).toEqual([{ rubricRef, criterionKey: 'r-31', before: 'pass', after: 'fail', testRunId: outcome.testRunIds[0] }]);
      expect(emit).toHaveBeenCalledTimes(1);
      const rows = await rowsById(outcome.testRunIds);
      expect(rows[0]).toMatchObject({ framework: 'rubric-check', status: 'fail', workspace_id: WS });
      expect(rows[0]?.output_tail).toContain('500 lookups');
      const latest = await readLatestRubricCheckResults({ rubricRef, workspaceId: WS }, sql());
      const grade = fillRatingsFromLedger({ criteria, callerRatings: undefined, latest, rubricRatingScale: ['meets', 'misses'] });
      expect(grade).toMatchObject({ ok: true, ledgerFilled: ['r-31'], ratings: { 'r-31': { rating: 'misses' } } });
      expect(await readLatestRubricCheckResults({ rubricRef, workspaceId: OTHER_WS }, sql())).toEqual(new Map());

      await db.adminSql`DELETE FROM harness_shared.agent_activity WHERE workspace_id = ${WS}`;
      emit.mockClear();
      const empty = await rescoreRubric({ rubricRef, workspaceId: WS, harnessSlug: 'papercusp' }, deps);
      expect(empty.crossings).toEqual([]);
      expect(emit).not.toHaveBeenCalled();
      expect((await rowsById(empty.testRunIds))[0]?.status).toBe('error');
    } finally { measure.mockRestore(); }
  });

  it('records one row per executed probe (grouped checks per child) beside a vitest file row, with id, value and unit', async () => {
    const [vitestRow] = (await db.adminSql`
      INSERT INTO harness_shared.test_runs (file_path, framework, status, workspace_id)
      VALUES ('packages/x/a.test.ts', 'vitest', 'pass', ${WS}) RETURNING id
    `) as unknown as Array<{ id: number }>;

    const evaluation = await evaluateCriterionProbeChecks({
      criteria: [
        { key: 'r-1', check: { kind: 'probe', probe: sqlProbe(1) } },
        { key: 'r-2', check: { kind: 'probe', all: [sqlProbe(1), sqlProbe(5)] } },
      ] as never,
      ratings: { 'r-1': { rating: '' }, 'r-2': { rating: '' } },
      dispatchTool,
    });
    // On failure, show the whole refusal (error + detail), not just `ok:false`.
    expect(evaluation.ok ? 'ok' : evaluation).toBe('ok');
    if (!evaluation.ok) return;

    const results = probeCheckResults(RUBRIC, evaluation.checkRuns);
    expect(results.map((r) => r.check.id)).toEqual(['r-1:0', 'r-2:0', 'r-2:1']);
    const ids = await recordRubricCheckResults(results, SCOPE, sql());
    expect(ids).toHaveLength(3);

    const rows = await rowsById(ids);
    expect(rows.map((r) => [r.file_path, r.framework, r.status])).toEqual([
      [rubricCheckLedgerPath(RUBRIC, 'r-1:0'), RUBRIC_CHECK_FRAMEWORK, 'pass'],
      [rubricCheckLedgerPath(RUBRIC, 'r-2:0'), RUBRIC_CHECK_FRAMEWORK, 'pass'],
      [rubricCheckLedgerPath(RUBRIC, 'r-2:1'), RUBRIC_CHECK_FRAMEWORK, 'fail'],
    ]);
    const checks = rows.map((r) => parseTestRunExecutionDetails(r.execution_details)?.check);
    expect(checks[0]).toEqual({ id: 'r-1:0', rubricRef: RUBRIC, criterionKey: 'r-1', kind: 'probe', value: 1, unit: null });
    expect(checks[2]).toMatchObject({ id: 'r-2:1', criterionKey: 'r-2', value: 1 });
    expect(rows[2]!.output_tail).toMatch(/did not match/);

    // Same ledger: the vitest row and the check rows are one table, one workspace slice.
    const [{ n }] = (await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.test_runs
       WHERE workspace_id = ${WS} AND id = ANY(${[vitestRow!.id, ...ids]})
    `) as unknown as Array<{ n: number }>;
    expect(n).toBe(4);
  });

  it('records instrument readings with their unit, judged against the threshold; a failed measurement is error with a null value', async () => {
    const readings: Record<string, InstrumentReading> = {
      'host:df-root-used-pct': reading('host:df-root-used-pct', '%', 91),
      'host:cgroup-cpu-delta-cores': reading('host:cgroup-cpu-delta-cores', 'cores', 0.4),
      'host:docker-test-container-max-age-s': reading('host:docker-test-container-max-age-s', 's', null),
    };
    const ran: string[] = [];
    const results = await runInstrumentChecks({
      rubricRef: RUBRIC,
      criteria: [
        { key: 'r-3', check: { kind: 'instrument', instrumentKey: 'host:df-root-used-pct', expect: { op: 'lt', value: 80 } } },
        { key: 'r-4', check: { kind: 'instrument', instrumentKey: 'host:cgroup-cpu-delta-cores', expect: { op: 'lte', value: 2 } } },
        { key: 'r-5', check: { kind: 'instrument', instrumentKey: 'host:docker-test-container-max-age-s' } },
        { key: 'r-6', check: { kind: 'instrument', instrumentKey: 'none' } },
        { key: 'r-7', check: { kind: 'instrument', instrumentKey: 'woe.goal-mode-base-scorecard' } },
        { key: 'r-8', check: { kind: 'tests', files: ['x.test.ts'] } as never },
      ],
      run: async (key) => { ran.push(key); return readings[key]!; },
    });
    // Manual, platform-computed and non-instrument criteria are not executed, so write nothing.
    expect(ran).toEqual(['host:df-root-used-pct', 'host:cgroup-cpu-delta-cores', 'host:docker-test-container-max-age-s']);
    expect(results.map((r) => [r.check.id, r.verdict])).toEqual([
      ['r-3:instrument', 'fail'], ['r-4:instrument', 'pass'], ['r-5:instrument', 'error'],
    ]);

    const ids = await recordRubricCheckResults(results, SCOPE, sql());
    const rows = await rowsById(ids);
    expect(rows.map((r) => r.status)).toEqual(['fail', 'pass', 'error']);
    const checks = rows.map((r) => parseTestRunExecutionDetails(r.execution_details)?.check);
    expect(checks[0]).toEqual({
      id: 'r-3:instrument', rubricRef: RUBRIC, criterionKey: 'r-3', kind: 'instrument',
      value: 91, unit: '%', expect: { op: 'lt', value: 80 },
    });
    expect(checks[1]).toMatchObject({ value: 0.4, unit: 'cores' });
    expect(checks[2]).toMatchObject({ value: null, unit: 's' });
    expect(rows[2]!.output_tail).toMatch(/measured nothing/);
  });

  it('keeps one history per check and reads back the latest result per check, scoped to the workspace', async () => {
    const at = (iso: string, value: number, verdict: RubricCheckResult['verdict']): RubricCheckResult => ({
      check: { id: 'r-9:instrument', rubricRef: 'acceptance-history-fixture', criterionKey: 'r-9', kind: 'instrument', value, unit: '%' },
      verdict, measuredAt: iso, durationMs: 5,
    });
    const [older] = await recordRubricCheckResults([at('2026-10-13T01:00:00.000Z', 40, 'pass')], SCOPE, sql());
    const [newer] = await recordRubricCheckResults([at('2026-10-13T01:30:00.000Z', 95, 'fail')], SCOPE, sql());
    await recordRubricCheckResults(
      [at('2026-10-13T01:45:00.000Z', 1, 'pass')], { ...SCOPE, workspaceId: OTHER_WS }, sql(),
    );

    const history = (await db.adminSql`
      SELECT id FROM harness_shared.test_runs
       WHERE file_path = ${rubricCheckLedgerPath('acceptance-history-fixture', 'r-9:instrument')} AND workspace_id = ${WS}
       ORDER BY id
    `) as unknown as Array<{ id: number }>;
    expect(history.map((r) => r.id)).toEqual([older, newer]);

    const latest = await readLatestRubricCheckResults({ rubricRef: 'acceptance-history-fixture', workspaceId: WS }, sql());
    expect([...latest.keys()]).toEqual(['r-9:instrument']);
    expect(latest.get('r-9:instrument')).toMatchObject({ testRunId: newer, status: 'fail', check: { value: 95, unit: '%' } });
  });

  it('refuses to write a row the shared ledger reader could not parse, and writes nothing', async () => {
    const bad: RubricCheckResult = {
      check: { id: '', rubricRef: RUBRIC, criterionKey: 'r-10', kind: 'probe', value: 1, unit: null },
      verdict: 'pass', measuredAt: '2026-10-13T02:00:00.000Z', durationMs: null,
    };
    await expect(recordRubricCheckResults([bad], SCOPE, sql())).rejects.toThrow(/readable ledger row/);
    const [{ n }] = (await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.test_runs WHERE file_path = ${rubricCheckLedgerPath(RUBRIC, '')}
    `) as unknown as Array<{ n: number }>;
    expect(n).toBe(0);
  });
});
