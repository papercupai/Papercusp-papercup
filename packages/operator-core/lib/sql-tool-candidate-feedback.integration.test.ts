import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import { readLatestRubricCheckResults } from './check-results-ledger';
import { recordSqlCandidateFeedback, sqlFeedbackIdentity, sqlFeedbackRubricDefinition, SQL_FEEDBACK_RUBRIC, type SqlCandidateFeedbackInput } from './sql-tool-candidate-feedback';
import { fillRatingsFromLedger } from './scorecard-ledger-fill';
import { runSqlIntentCensus } from './harness/routines/sql-read-census-action';
import { rescoreRubric } from './harness/routines/rubric-rescore-action';
import './agent-tools/dev/pg_query';
import { continuityProbeSchema } from './continuity-probes';
import { buildTenantScopeAdvisory } from './pg-read-query';

let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb(); }, 180_000);
afterAll(async () => { await db?.cleanup(); });
const input = (): SqlCandidateFeedbackInput => ({
  workspaceId: 'sql-feedback-fixture', harnessSlug: 'papercusp', measuredAt: '2026-10-25T00:00:00Z',
  sourceRef: { scopeId: 'opaque-scope', ranOn: '2026-10-24' },
  review: { status: 'accepted', lifecycleId: 'opaque-lifecycle', editionId: 'contract-v1',
    workItemId: 'EI-feedback-fixture', owner: 'su-implementer', queue: 'implementation' },
  repair: {
    baseline: { scopeRef: 'sql-feedback-fixture/papercusp', shapesRef: 'covered-shapes-v1',
      since: '2026-10-01T00:00:00Z', until: '2026-10-08T00:00:00Z', rawAgents: 8, activeAgents: 10, toolAgents: 0, complete: true },
    observation: { scopeRef: 'sql-feedback-fixture/papercusp', shapesRef: 'covered-shapes-v1',
      since: '2026-10-10T00:00:00Z', until: '2026-10-17T00:00:00Z', rawAgents: 2, activeAgents: 10, toolAgents: 7, complete: true },
    exposure: { build: 'a'.repeat(40), observedAt: '2026-10-09T00:00:00Z', evidenceRef: 'release:observed-fixture' },
    coverage: 'pass',
  },
});
const record = (value: SqlCandidateFeedbackInput) => recordSqlCandidateFeedback(value, { client: db.adminSql });
it('persists repeatable scoped checks with build baseline windows and denominators R7-CONTRACT OUTCOME-P-007', async () => {
  const value = input(), first = await record(value);
  expect(first.outcome).toMatchObject({ status: 'healthy', disposition: 'adopted' });
  const rows = await db.adminSql`SELECT * FROM harness_shared.test_runs WHERE id=ANY(${first.testRunIds}::bigint[]) ORDER BY id`;
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row).toMatchObject({ framework: 'rubric-check', status: 'pass', workspace_id: value.workspaceId,
      harness_slug: value.harnessSlug, commit_sha: 'a'.repeat(40) });
    const details = parseTestRunExecutionDetails(row.execution_details)!;
    expect(details.check?.provenance).toMatchObject({ truncated: false, redacted: false });
    const context = JSON.parse(details.check!.provenance!.procedure.snapshot);
    expect(context.measurement).toEqual(value.repair);
  }
  const repeat = await record({ ...value, measuredAt: '2026-10-25T01:00:00Z' });
  expect(repeat.testRunIds).not.toEqual(first.testRunIds);
  const latest = await readLatestRubricCheckResults({ rubricRef: SQL_FEEDBACK_RUBRIC, workspaceId: value.workspaceId }, db.adminSql);
  expect([...latest.values()].map(row => row.testRunId).sort()).toEqual([...repeat.testRunIds].sort());
  const criteria = ['proposal-quality', 'repair-outcome'].map(key => ({ key: `${sqlFeedbackIdentity(value)}:${key}`,
    check: { kind: 'probe', probe: { expect: { op: 'eq', path: '$', value: true } } } }));
  expect(fillRatingsFromLedger({ criteria, latest, rubricRatingScale: ['healthy', 'broken'], callerRatings: undefined }))
    .toMatchObject({ ok: true, ledgerFilled: criteria.map(c => c.key) });
  expect(await readLatestRubricCheckResults({ rubricRef: SQL_FEEDBACK_RUBRIC, workspaceId: 'other' }, db.adminSql)).toHaveProperty('size', 0);
});
it('records lower-activity no-fall and failed coverage dispositions R7-CONTRACT OUTCOME-P-007', async () => {
  for (const coverage of ['pass', 'fail'] as const) {
    const value = input(); value.repair!.coverage = coverage;
    Object.assign(value.repair!.observation, { rawAgents: 4, activeAgents: 5, toolAgents: 1 });
    const result = await record(value);
    expect(result.outcome).toMatchObject({ status: 'failed', disposition: coverage === 'pass' ? 'no-fall' : 'coverage-failed' });
    const [row] = await db.adminSql`SELECT status,output_tail FROM harness_shared.test_runs WHERE id=${result.testRunIds[1]!}`;
    expect(row).toMatchObject({ status: 'fail', output_tail: result.outcome.disposition });
  }
});
it.each(['exposure', 'denominator', 'window', 'low-demand', 'foreign-scope', 'invalid-build', 'future-window'])(
  'records %s unknown without converting it to a passing result R7-CONTRACT OUTCOME-P-007', async defect => {
    const value = input();
    if (defect === 'exposure') value.repair!.exposure = null;
    if (defect === 'denominator') value.repair!.observation.activeAgents = 0;
    if (defect === 'window') value.repair!.observation.since = '';
    if (defect === 'low-demand') value.repair!.baseline.rawAgents = 1;
    if (defect === 'invalid-build') value.repair!.exposure!.build = 'not-a-build';
    if (defect === 'future-window') value.measuredAt = '2026-10-15T00:00:00Z';
    if (defect === 'foreign-scope') {
      value.repair!.baseline.scopeRef = 'other/papercusp'; value.repair!.observation.scopeRef = 'other/papercusp';
    }
    const result = await record(value);
    expect(result.outcome.status).toBe('unknown');
    const [row] = await db.adminSql`SELECT status,execution_details FROM harness_shared.test_runs WHERE id=${result.testRunIds[1]!}`;
    expect(row.status).toBe('error'); expect(parseTestRunExecutionDetails(row.execution_details)?.check?.value).toBeNull();
  });
it.each(['invalid-time', 'future-time', 'invalid-source-date'])(
  'rejects %s before writing misleading ledger metadata R7-CONTRACT', async defect => {
    const value = input(); let writes = 0;
    if (defect === 'invalid-time') value.measuredAt = 'invalid';
    if (defect === 'future-time') value.measuredAt = '2999-01-01T00:00:00Z';
    if (defect === 'invalid-source-date') value.sourceRef.ranOn = '2026-02-30';
    await expect(recordSqlCandidateFeedback(value, { record: async () => { writes++; return []; } }))
      .rejects.toThrow(/^invalid_sql_feedback_/);
    expect(writes).toBe(0);
  });
it('acceptance alone is not shipment; proposal quality reflects actual review disposition R7-CONTRACT', async () => {
  const accepted = await record({ ...input(), repair: null });
  expect(accepted).toMatchObject({ quality: true, outcome: { status: 'unknown' } });
  for (const status of ['pending', 'declined'] as const) {
    const value = input(); value.review.status = status;
    const result = await record(value);
    expect(result.testRunIds).toHaveLength(1);
    const [row] = await db.adminSql`SELECT status FROM harness_shared.test_runs WHERE id=${result.testRunIds[0]!}`;
    expect(row.status).toBe(status === 'pending' ? 'error' : 'fail');
  }
});
it('ledger failure propagates instead of claiming feedback was saved R7-CONTRACT', async () => {
  await expect(recordSqlCandidateFeedback(input(), { record: async () => { throw new Error('ledger unavailable'); } }))
    .rejects.toThrow('ledger unavailable');
});
it('production census persists feedback after the actual mined review with missing exposure unknown R7-CONTRACT OUTCOME-P-007', async () => {
  const workspaceId = 'sql-feedback-census', harnessSlug = 'papercusp';
  for (let i = 0; i < 12; i++) {
    await db.adminSql`INSERT INTO harness_shared.tool_invocations
      (workspace_id,harness_slug,plugin_name,tool_name,role,spawn_id,window_key,invoked_at,status,
       coord_owner_id,args_json,transport,call_origin,call_origin_source,duration_ms)
      VALUES (${workspaceId},${harnessSlug},'agent-mcp','dev:pg_query','operator','test-request','test',
        ${i < 6 ? '2026-10-23T12:00:00Z' : '2026-10-24T12:00:00Z'}::timestamptz,'ok',
        ${`su-fixture-${i % 3}`},${JSON.stringify({ sql: 'SELECT id FROM jobs' })}::jsonb,'mcp','agent','declared',12)`;
  }
  const options = { workspaceId, harnessSlug, client: db.adminSql,
    scope: { workspaceId, sourceBoundary: 'ledger', epoch: '2026-10', key: new Uint8Array(32).fill(71) },
    authorize: async () => true, retainedFrom: '2026-10-01T00:00:00Z', rowBudget: 100,
    timeBudgetMs: 30_000, now: Date.parse('2026-10-25T12:00:00Z') };
  let reviews = 0;
  const result = await runSqlIntentCensus(options, { review: async () => { reviews++; return input().review; } });
  expect(result).toMatchObject({ status: 'ok', reviewIntake: { selected: 1 } }); expect(reviews).toBe(1);
  const latest = await readLatestRubricCheckResults({ rubricRef: SQL_FEEDBACK_RUBRIC, workspaceId }, db.adminSql);
  expect([...latest.values()].map(row => [row.check.criterionKey.split(':').at(-1), row.status]).sort())
    .toEqual([['proposal-quality', 'pass'], ['repair-outcome', 'error']]);
  expect([...latest.values()].find(row => row.status === 'error')?.detail).toBe('insufficient-evidence');
});
it('registered workspace rubric rescores the real ledger without masking another candidate and grades from ledger R7-CONTRACT OUTCOME-P-007', async () => {
  const workspaceId = "feedback-aggregate-'scope";
  const definition = sqlFeedbackRubricDefinition(workspaceId);
  // The live SQL dispatcher rejects this advisory before execution. Prove the
  // negative control and run the same boundary on every real-ledger measurement.
  expect(await buildTenantScopeAdvisory(definition.criteria[0]!.check.probe.sql.replace(" AND source='local'", '')))
    .toContain('NULL-by-design');
  // Match rubrics:propose's writer normalization: stored probes pin the registered read contract.
  for (const criterion of definition.criteria) criterion.check.probe = continuityProbeSchema.parse(criterion.check.probe) as typeof criterion.check.probe;
  const rubric = { ...definition, rubricId: definition.rubricRef, workspaceId };
  const measure = async () => {
    const rescore = await rescoreRubric({ rubricRef: definition.rubricRef, workspaceId, harnessSlug: 'papercusp' }, {
      getRubric: async () => rubric as never,
      dispatchTool: async (_tool, args) => {
        const sql = String(args.sql);
        expect(await buildTenantScopeAdvisory(sql, { workspaceId, harnessSlug: 'papercusp' })).toBeNull();
        return { rows: await db.adminSql.unsafe(sql) };
      },
      readLatest: value => readLatestRubricCheckResults(value, db.adminSql),
      record: (rows, scope) => import('./check-results-ledger').then(m => m.recordRubricCheckResults(rows, scope, db.adminSql)),
      emit: async () => ({}) as never,
    });
    expect(rescore.probeError).toBeUndefined(); expect(rescore.executed).toBe(2);
    const latest = await readLatestRubricCheckResults({ rubricRef: definition.rubricRef, workspaceId }, db.adminSql);
    const filled = fillRatingsFromLedger({ criteria: definition.criteria, latest, rubricRatingScale: definition.ratingScale, callerRatings: undefined,
      dispositions: { 'proposal-quality': { remediation: 'review failing proposal' }, 'repair-outcome': { remediation: 'repair adoption or coverage' } } });
    expect(filled.ok).toBe(true);
    return filled.ok ? Object.fromEntries(Object.entries(filled.ratings).map(([key, value]) => [key, value.rating])) : {};
  };
  expect(await measure()).toEqual({ 'proposal-quality': 'unknown', 'repair-outcome': 'unknown' });
  const value = { ...input(), workspaceId, measuredAt: new Date().toISOString() };
  value.repair!.baseline.scopeRef = `${workspaceId}/papercusp`;
  value.repair!.observation.scopeRef = `${workspaceId}/papercusp`;
  await record(value);
  expect(await measure()).toEqual({ 'proposal-quality': 'healthy', 'repair-outcome': 'healthy' });
  const failed = structuredClone(value); failed.review.lifecycleId = 'failed-cohort-member';
  failed.measuredAt = new Date().toISOString(); failed.repair!.coverage = 'fail';
  await record(failed);
  const passing = structuredClone(value); passing.review.lifecycleId = 'later-passing-member';
  passing.measuredAt = new Date().toISOString(); await record(passing);
  expect(await measure()).toEqual({ 'proposal-quality': 'healthy', 'repair-outcome': 'broken' });
  failed.repair = null; failed.measuredAt = new Date().toISOString(); await record(failed);
  expect(await measure()).toEqual({ 'proposal-quality': 'healthy', 'repair-outcome': 'unknown' });
  await db.adminSql`DELETE FROM harness_shared.test_runs WHERE workspace_id=${workspaceId}
    AND file_path=${`rubric-check/${definition.rubricRef}/${sqlFeedbackIdentity(failed)}:repair-outcome:0`}`;
  expect(await measure()).toEqual({ 'proposal-quality': 'healthy', 'repair-outcome': 'unknown' });
});
