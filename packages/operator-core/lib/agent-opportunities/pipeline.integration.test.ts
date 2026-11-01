import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { mineSqlCandidateSlice } from '../bash-substitution/sql-tool-candidates';
import { getBuildInfo } from '../build-info';
import { readMonitoredCandidate, runMonitoredCensus } from './census';
import { MONITORED_FAMILIES } from './pipeline';
let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
beforeAll(async () => {
  f = await sqlMiningFixture();
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1583-sql-intent-monitored-family-runs.sql', import.meta.url);
  await f.db.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : new URL(migration.href + '.DRAFT'), 'utf8'));
}, 120_000);
afterAll(async () => { await f?.cleanup(); });
beforeEach(async () => { await f.clear(); });
it('R13-CONTRACT', async () => {
  await f.seed(); await f.seed();
  const opts = Object.assign(f.opts({ rowBudget: 100, timeBudgetMs: 30_000 }), {
    verified: true, shipped: true, sourceComplete: true, coverage: 'measured',
    routineId: 'caller-claimed-scheduler', workflowId: 'r13-contract-fixture',
  });
  // Exercise the maintained production census and PostgreSQL child rows, not
  // an authored MonitoredRunEvidence object. Caller success claims cannot fill
  // gaps in native source coverage or create scheduler/review evidence.
  const run = await runMonitoredCensus(opts, () => mineSqlCandidateSlice(opts));
  const [identity] = await f.db.adminSql`SELECT source_sha,runtime_id,routine_id,workflow_id,finished_at
    FROM harness_shared.sql_intent_runs WHERE workspace_id=${opts.workspaceId} AND run_id=${run.runId}::uuid`;
  expect(identity).toMatchObject({ source_sha: getBuildInfo().sha,
    runtime_id: expect.any(String), routine_id: opts.routineId, workflow_id: opts.workflowId,
    finished_at: expect.any(Date) });
  const children = await f.db.adminSql`SELECT family,coverage,scanned,qualifying,diagnostics
    FROM harness_shared.sql_intent_family_runs WHERE workspace_id=${opts.workspaceId} AND run_id=${run.runId}::uuid`;
  expect(children.map(row => row.family).sort()).toEqual([...MONITORED_FAMILIES].sort());
  for (const child of children) {
    const measured = run.families.find(row => row.family === child.family)!;
    expect(child).toMatchObject({ coverage: measured.coverage, scanned: measured.scanned, qualifying: measured.qualifying });
    expect(child.diagnostics.window).toEqual({
      since: new Date(f.now - 7 * 86400_000).toISOString(), until: new Date(f.now).toISOString(),
    });
  }
  const native = children.find(row => row.family === 'native-operation')!;
  expect(native).toMatchObject({ coverage: 'UNKNOWN', scanned: 0, qualifying: 0,
    diagnostics: { reviewEligible: false } });
  expect(run.coverage.notChecked).toContain('native-operation');
  expect(run.coverage.residue).toContain('native-operation:UNKNOWN');
  expect([...run.coverage.checked, ...run.coverage.notChecked].sort()).toEqual([...MONITORED_FAMILIES].sort());
  expect(run.coverage.notApplicable).toEqual([]);
  const sql = run.families.find(row => row.family === 'sql')!;
  const candidate = (sql.diagnostics.candidates as { id: string }[])[0]!;
  expect(candidate).toBeDefined();
  const authorizeSource = async (token: string) => {
    const rows = await f.db.adminSql`SELECT 1 FROM harness_shared.sql_intent_operations o
      JOIN harness_shared.tool_invocations i ON i.id=o.source_id AND i.workspace_id=o.workspace_id
      WHERE o.workspace_id=${opts.workspaceId} AND o.source_token=${token} AND i.harness_slug=${opts.harnessSlug}`;
    return rows.length === 1;
  };
  const read = () => readMonitoredCandidate({ ...opts, runId: run.runId, family: 'sql', candidateId: candidate.id, authorizeSource });
  expect(await read()).not.toBeNull();
  // A retained parent or forged success flag never repairs a missing normalized
  // child. The canonical reader must re-read current rows, rather than the run's
  // old in-memory success or a manual receipt supplied by a caller.
  await f.db.adminSql`DELETE FROM harness_shared.sql_intent_family_runs
    WHERE workspace_id=${opts.workspaceId} AND run_id=${run.runId}::uuid AND family='sql'`;
  expect(await read()).toBeNull();
  expect(run.families.find(row => row.family === 'sql')).toEqual(sql);
  expect(JSON.stringify(children)).not.toMatch(/private-one|su-private-actor|SELECT id FROM jobs/);
});

it.each(['continuity-before', 'window', 'continuity-after'] as const)(
  'native source failures retain the %s boundary and independently observed continuity', async failure => {
    let nativeContinuityCalls = 0, readingWindow = false;
    const timeout = () => { throw new Error('sql_mining_time_budget'); };
    const opts = f.opts({ authorize: async () => readingWindow ? timeout() : true });
    const run = await runMonitoredCensus(opts,
      async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0, reason: 'sql_mining_source_missing' }), {
        readContinuity: async ({ family }) => {
          if (family !== 'native-operation') return 'unknown';
          nativeContinuityCalls++;
          if (failure === 'continuity-before' || failure === 'continuity-after' && nativeContinuityCalls === 2)
            return timeout();
          if (failure === 'window') readingWindow = true;
          return 'unknown';
        },
      });
    const expected = { stage: 'source', phase: failure, reason: 'sql_mining_time_budget', reviewEligible: false,
      continuity: { before: failure === 'continuity-before' ? null : 'unknown', after: null } };
    const native = run.families.find(row => row.family === 'native-operation');
    expect(native).toMatchObject({ coverage: 'UNKNOWN', diagnostics: expected });
    const [saved] = await f.db.adminSql`SELECT coverage,diagnostics FROM harness_shared.sql_intent_family_runs
      WHERE workspace_id=${opts.workspaceId} AND run_id=${run.runId}::uuid AND family='native-operation'`;
    expect(saved).toMatchObject({ coverage: 'UNKNOWN', diagnostics: expected });
    expect(saved!.diagnostics.candidates).toEqual([]);
  });

it('R18-UNKNOWN', async () => {
  await f.seed(); await mineSqlCandidateSlice(f.opts());
  const [before] = await f.db.adminSql`SELECT cursor_id::text FROM harness_shared.sql_intent_progress`;
  const result = await mineSqlCandidateSlice(f.opts(), { fetch: async () => { throw new Error('private query detail'); } });
  expect(result).toMatchObject({ status: 'UNKNOWN', stage: 'source', reason: 'dependency-error' });
  const [after] = await f.db.adminSql`SELECT cursor_id::text FROM harness_shared.sql_intent_progress`;
  expect(after).toEqual(before);
  const [failure] = await f.db.adminSql`SELECT stage,status,reason FROM harness_shared.sql_intent_stages WHERE stage='source'`;
  expect(failure).toMatchObject({ status: 'UNKNOWN', reason: 'dependency-error' });
});
it('R20-ISOLATION', async () => {
  let started!: () => void, release!: () => void;
  const pending = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { started = r; });
  const mining = mineSqlCandidateSlice(f.opts(), { fetch: async () => { started(); await pending; throw new Error('failed mining'); } });
  await ready;
  const id = await f.seed(); // canonical recording progresses while the miner is blocked
  expect(id).toMatch(/^\d+$/); release();
  expect(await mining).toMatchObject({ status: 'UNKNOWN', stage: 'source' });
});
it('R25-PASSIVE', async () => {
  await f.seed("SELECT set_config('mining_must_not_run','executed',false)");
  await f.seed('DROP TABLE harness_shared.sql_intent_history');
  expect(await mineSqlCandidateSlice(f.opts())).toMatchObject({ status: 'ok', logicalCalls: 0 });
  const [effect] = await f.db.adminSql`SELECT current_setting('mining_must_not_run',true) AS value,
    to_regclass('harness_shared.sql_intent_history') IS NOT NULL AS history`;
  expect(effect!.value).toBeNull(); expect(effect!.history).toBe(true);
});
