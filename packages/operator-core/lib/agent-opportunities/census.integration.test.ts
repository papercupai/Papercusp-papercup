import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { mineSqlCandidateSlice } from '../bash-substitution/sql-tool-candidates';
import { readMonitoredCandidate, readProductionMonitoredCandidate, runMonitoredCensus } from './census';
import { MONITORED_FAMILIES } from './pipeline';
import { censusMiningOptions, DEFAULT_INTENT_CENSUS_TIME_BUDGET_MS, runSqlOpportunityCensus } from '../harness/routines/sql-read-census-action';
import { buildScratchUri, safeScratchFilesystemPath } from '../scratch-uri';
import { writeScratchReference } from '../scratch-reference';
import { miningScopeId } from './privacy';
let f: Awaited<ReturnType<typeof sqlMiningFixture>>, dir: string, oldRoot: string | undefined;
beforeAll(async () => {
  f = await sqlMiningFixture();
  dir = await mkdtemp(join(tmpdir(), 'monitored-census-'));
  oldRoot = process.env.PAPERCUSP_SCRATCH_ROOT; process.env.PAPERCUSP_SCRATCH_ROOT = dir;
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1583-sql-intent-monitored-family-runs.sql', import.meta.url);
  await f.db.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : new URL(migration.href + '.DRAFT'), 'utf8'));
  for (const name of ['1581-sql-intent-source-retention-boundary', '1582-sql-intent-retention-settlement-preserves-coverage']) {
    const receipt = new URL(`../../../../libs/papercusp/libs/db/sql/${name}.sql`, import.meta.url);
    if (!existsSync(receipt)) await f.db.adminSql.unsafe(readFileSync(new URL(receipt.href + '.DRAFT'), 'utf8'));
  }
}, 120_000);
afterAll(async () => {
  if (oldRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = oldRoot;
  await f?.cleanup(); if (dir) await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await f.clear(); await f.db.adminSql`TRUNCATE harness_shared.sql_intent_runs CASCADE`;
  await f.db.adminSql`DELETE FROM harness_shared.agent_activity`;
});
async function candidateFixture() {
  const ids = [await f.seed(), await f.seed()];
  const opts = f.opts({ rowBudget: 100, timeBudgetMs: 30_000 });
  const run = await runMonitoredCensus(opts, () => mineSqlCandidateSlice(opts));
  const candidates = run.families[0]!.diagnostics.candidates as Array<{ id: string; sourceRefs: string[] }>;
  const candidate = candidates[0]!;
  expect(candidate.sourceRefs).toHaveLength(2);
  const denied = new Set<string>();
  const authorizeSource = async (token: string) => {
    const rows = await f.db.adminSql`SELECT o.source_id::text FROM harness_shared.sql_intent_operations o
      JOIN harness_shared.tool_invocations i ON i.id=o.source_id AND i.workspace_id=o.workspace_id
      WHERE o.workspace_id=${opts.workspaceId} AND o.source_token=${token} AND i.harness_slug=${opts.harnessSlug}`;
    return rows.length === 1 && !denied.has(token);
  };
  const read = (over: Partial<Parameters<typeof readMonitoredCandidate>[0]> = {}) => readMonitoredCandidate({ ...opts,
    runId: run.runId, family: 'sql', candidateId: candidate.id, authorizeSource, ...over });
  return { ids, opts, run, candidate, denied, authorizeSource, read };
}
it('R23-DERIVED-ACL monitored candidates recheck every contributing source without cached grants or aggregate leakage', async () => {
  const c = await candidateFixture();
  const allowed = await c.read();
  expect(allowed).toMatchObject({ id: c.candidate.id, sourceRefs: c.candidate.sourceRefs,
    metrics: { successful: 2 }, reviewEligible: false });
  expect(Object.keys(allowed!).sort()).toEqual(['id', 'metrics', 'operationRefs', 'reviewEligible', 'sourceRefs']);
  c.denied.add(c.candidate.sourceRefs[1]!);
  expect(await c.read()).toBeNull();
  c.denied.clear(); expect(await c.read()).toEqual(allowed);
  expect(await c.read({ authorizeSource: async () => { throw new Error('unavailable'); } })).toBeNull();
  expect(await c.read({ authorize: async () => false })).toBeNull();
  expect(await c.read({ scope: { ...c.opts.scope, epoch: 'rotated' } })).toBeNull();
  expect(await c.read({ scope: { ...c.opts.scope, sourceBoundary: 'denied-boundary' } })).toBeNull();
  expect(await c.read({ workspaceId: 'other-workspace' })).toBeNull();
  expect(await c.read({ candidateId: '0'.repeat(64) })).toBeNull();
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${c.ids[0]!}::bigint`;
  expect(await c.read()).toBeNull();
});
it('R23-DERIVED-ACL monitored packets deny revoke, source deletion and snapshot replacement during read IO', async () => {
  const c = await candidateFixture();
  let calls = 0;
  expect(await c.read({ authorizeSource: async token => {
    const allowed = await c.authorizeSource(token);
    if (++calls === 2) c.denied.add(c.candidate.sourceRefs[0]!);
    return allowed;
  } })).toBeNull();
  c.denied.clear(); calls = 0;
  expect(await c.read({ authorizeSource: async token => {
    if (++calls === 1) await f.db.adminSql`UPDATE harness_shared.sql_intent_family_runs
      SET diagnostics=jsonb_set(diagnostics,'{candidates,0,metrics,successful}','99'::jsonb)
      WHERE run_id=${c.run.runId}::uuid AND family='sql'`;
    return c.authorizeSource(token);
  } })).toBeNull();
  calls = 0;
  expect(await c.read({ authorizeSource: async token => {
    const allowed = await c.authorizeSource(token);
    if (++calls === 2) await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${c.ids[0]!}::bigint`;
    return allowed;
  } })).toBeNull();
});
it('monitored candidate reads allowlist stored fields and deny incomplete, ambiguous, expired and malformed evidence', async () => {
  const c = await candidateFixture();
  await f.db.adminSql`UPDATE harness_shared.sql_intent_family_runs SET diagnostics=
    jsonb_set(jsonb_set(diagnostics,'{candidates,0,rawText}','"private-source-sentinel"'),
      '{candidates,0,metrics,private-relation-name}','123') WHERE run_id=${c.run.runId}::uuid AND family='sql'`;
  const allowed = await c.read();
  expect(allowed).not.toBeNull(); expect(JSON.stringify(allowed)).not.toMatch(/private-source|private-relation/);
  const [stored] = await f.db.adminSql`SELECT diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE run_id=${c.run.runId}::uuid AND family='sql'`;
  const original = stored!.diagnostics;
  for (const candidates of [[], [original.candidates[0], original.candidates[0]],
    [{ ...original.candidates[0], sourceRefs: [] }], [{ ...original.candidates[0], sourceRefs: ['raw-id'] }],
    [{ ...original.candidates[0], metrics: { successful: '2' } }]]) {
    await f.db.adminSql`UPDATE harness_shared.sql_intent_family_runs SET diagnostics=${JSON.stringify({ ...original, candidates })}::jsonb
      WHERE run_id=${c.run.runId}::uuid AND family='sql'`;
    expect(await c.read()).toBeNull();
  }
  await f.db.adminSql`UPDATE harness_shared.sql_intent_family_runs SET diagnostics=${JSON.stringify(original)}::jsonb
    WHERE run_id=${c.run.runId}::uuid AND family='sql'`;
  await f.db.adminSql`UPDATE harness_shared.sql_intent_runs SET started_at=${new Date(f.now).toISOString()}::timestamptz,
    finished_at=NULL WHERE run_id=${c.run.runId}::uuid`;
  expect(await c.read()).toBeNull();
  await f.db.adminSql`UPDATE harness_shared.sql_intent_runs SET finished_at=now() WHERE run_id=${c.run.runId}::uuid`;
  expect(await c.read({ now: f.now + 120 * 86400_000 - 1 })).not.toBeNull();
  expect(await c.read({ now: f.now + 120 * 86400_000 })).toBeNull();
});
it('persists exactly five normalized family outcomes from real adapters and preserves unknown source coverage', async () => {
  await f.seed();
  const opts = f.opts({ rowBudget: 100, timeBudgetMs: 30_000 });
  const result = await runMonitoredCensus({ ...opts, routineId: 'canonical-routine', workflowId: 'workflow-one' },
    () => mineSqlCandidateSlice(opts));
  expect(result.families.map(f => f.family)).toEqual(MONITORED_FAMILIES);
  expect(result.families[0]).toMatchObject({ family: 'sql', coverage: 'measured', scanned: 1 });
  expect(result.families.slice(1).every(f => f.coverage === 'UNKNOWN')).toBe(true);
  const rows = await f.db.adminSql`SELECT family,coverage,scanned,diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE run_id=${result.runId}::uuid ORDER BY family`;
  expect(rows).toHaveLength(5);
  expect(rows.filter(r => r.family !== 'native-operation').every(r => r.scanned === 1)).toBe(true);
  const [parent] = await f.db.adminSql`SELECT routine_id,workflow_id,finished_at IS NOT NULL AS finished FROM harness_shared.sql_intent_runs`;
  expect(parent).toMatchObject({ routine_id: 'canonical-routine', workflow_id: 'workflow-one', finished: true });
  expect(JSON.stringify(rows)).not.toMatch(/private-one|SELECT id|su-private-actor/);
  expect(result.coverage.checked).toEqual(['sql']);
  expect(result.coverage.notChecked).toHaveLength(4);
  const sqlEvidence = result.families[0]!.diagnostics.candidates as Array<{ id: string; sourceRefs: string[]; operationRefs: string[] }>;
  expect(sqlEvidence).toHaveLength(1);
  expect(sqlEvidence[0]).toMatchObject({ id: expect.stringMatching(/^[a-f0-9]{64}$/),
    sourceRefs: [expect.stringMatching(/^[a-f0-9]{64}$/)], operationRefs: [expect.stringMatching(/^[a-f0-9]{64}$/)] });
});
it('records failed SQL stage separately and still measures the other four families', async () => {
  await f.seed(); const opts = f.opts({ rowBudget: 100 });
  const result = await runMonitoredCensus(opts, async () => {
    const error = new Error('private query secret'); Object.assign(error, { code: '42P01' }); throw error;
  });
  expect(result.families[0]).toMatchObject({ coverage: 'UNKNOWN', diagnostics: { reason: 'database-42P01' } });
  expect(result.families[1]).toMatchObject({ family: 'search-reformulation', scanned: 1 });
  expect(JSON.stringify(result)).not.toContain('private query secret');
  expect(await f.db.adminSql`SELECT 1 FROM harness_shared.sql_intent_family_runs`).toHaveLength(5);
});
it('denied scope produces unknown stages without exposing evidence and never becomes measured empty demand', async () => {
  await f.seed(); const opts = f.opts({ authorize: async () => false });
  const result = await runMonitoredCensus(opts, () => mineSqlCandidateSlice(opts));
  expect(result.families.every(f => f.coverage === 'UNKNOWN' && f.qualifying === 0)).toBe(true);
  expect(result.coverage.checked).toEqual([]);
  expect(result.coverage.notChecked).toEqual(MONITORED_FAMILIES);
});
it('rejects completed-workflow replay and runtime drift instead of relabeling new evidence with an old build', async () => {
  const opts = { ...f.opts(), workflowId: 'same-workflow' };
  const first = await runMonitoredCensus(opts, () => mineSqlCandidateSlice(opts));
  await expect(runMonitoredCensus(opts, () => mineSqlCandidateSlice(opts))).rejects.toThrow('sql_mining_run_identity_or_replay');
  await f.db.adminSql`UPDATE harness_shared.sql_intent_runs SET finished_at=NULL,runtime_id='other-loaded-process'`;
  await expect(runMonitoredCensus(opts, () => mineSqlCandidateSlice(opts))).rejects.toThrow('sql_mining_run_identity_or_replay');
  expect(await f.db.adminSql`SELECT 1 FROM harness_shared.sql_intent_family_runs WHERE run_id=${first.runId}::uuid`).toHaveLength(5);
});
it('wires the production census facade through SQL intake and all four passive adapters on the same workflow', async () => {
  await f.seed();
  const opts = f.opts({ rowBudget: 100, timeBudgetMs: undefined });
  expect(censusMiningOptions(opts).timeBudgetMs).toBe(DEFAULT_INTENT_CENSUS_TIME_BUDGET_MS);
  expect(censusMiningOptions({ ...opts, timeBudgetMs: 12_000 }).timeBudgetMs).toBe(12_000);
  const result = await runSqlOpportunityCensus({ ...opts,
    routineId: 'production-facade', workflowId: 'production-workflow' });
  expect(result.sql).toMatchObject({ status: 'ok', rows: 1 });
  expect(result.monitored?.families.map(f => f.family)).toEqual(MONITORED_FAMILIES);
  expect(result.monitored?.families.every(f => f.diagnostics.reason !== 'sql_mining_time_budget')).toBe(true);
  const [parent] = await f.db.adminSql`SELECT routine_id,workflow_id FROM harness_shared.sql_intent_runs`;
  expect(parent).toMatchObject({ routine_id: 'production-facade', workflow_id: 'production-workflow' });
});
it('persists elapsed time for the phase that reaches its bounded timeout', async () => {
  const budgetMs = 250;
  const opts = f.opts({ timeBudgetMs: budgetMs });
  const run = await runMonitoredCensus(opts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }), {
    readContinuity: async ({ family }) => family === 'native-operation'
      ? new Promise<'complete' | 'gap' | 'unknown'>(() => {}) : 'unknown',
  });
  const native = run.families.find(row => row.family === 'native-operation')!;
  expect(native).toMatchObject({ coverage: 'UNKNOWN', diagnostics: {
    phase: 'continuity-before', reason: 'sql_mining_time_budget' } });
  const elapsed = Number((native.diagnostics.phaseDurationsMs as Record<string, number>)['continuity-before']);
  expect(elapsed).toBeGreaterThanOrEqual(200);
  const [saved] = await f.db.adminSql`SELECT diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE workspace_id=${opts.workspaceId} AND run_id=${run.runId}::uuid AND family='native-operation'`;
  expect(saved!.diagnostics.phaseDurationsMs['continuity-before']).toBeGreaterThanOrEqual(200);
});
it('drains a fixed activity window across equal-timestamp keyset pages before grouping a search chain', async () => {
  for (const query of ['job queue', 'job status', 'job owner']) {
    const id = await f.seed();
    await f.db.adminSql`UPDATE harness_shared.tool_invocations SET tool_name='tools:find',
      args_json=${JSON.stringify({ query })}::jsonb WHERE id=${id}::bigint`;
  }
  const result = await runMonitoredCensus(f.opts({ rowBudget: 1, windowRowBudget: 10, timeBudgetMs: 30_000 }),
    async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  const search = result.families.find(row => row.family === 'search-reformulation')!;
  expect(search).toMatchObject({ scanned: 3, qualifying: 1, coverage: 'UNKNOWN', diagnostics: {
    reviewEligible: false, sourceCoverage: { scanned: 3, denied: 0, pages: 3,
      windowExhausted: true, stop: 'window-exhausted', unmeasuredProviders: ['claude', 'codex', 'omp'] },
  } });
  for (const family of ['result-recovery', 'workaround-funnel']) expect(result.families.find(row => row.family === family))
    .toMatchObject({ scanned: 3, coverage: 'UNKNOWN', diagnostics: { sourceCoverage: { pages: 3, windowExhausted: true } } });
  const [stored] = await f.db.adminSql`SELECT diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE run_id=${result.runId}::uuid AND family='search-reformulation'`;
  expect(stored!.diagnostics.sourceCoverage).toMatchObject({ scanned: 3, pages: 3, windowExhausted: true });
  expect(stored!.diagnostics.candidates).toEqual([expect.objectContaining({
    id: expect.stringMatching(/^[a-f0-9]{64}$/), sourceRefs: expect.any(Array), operationRefs: expect.any(Array),
    metrics: { logicalDemand: 3, reformulations: 2, fallbacks: 0 }, reviewEligible: false,
  })]);
  expect(stored!.diagnostics.candidates[0].sourceRefs).toHaveLength(3);
  expect(stored!.diagnostics.candidates[0].operationRefs).toHaveLength(3);
  expect(JSON.stringify(stored)).not.toMatch(/job queue|job status|job owner|su-private-actor/);
});
it('caps activity scans without upgrading a partial window to measured or exposing a raw cursor', async () => {
  for (let i = 0; i < 4; i++) await f.seed();
  const result = await runMonitoredCensus(f.opts({ rowBudget: 1, windowRowBudget: 2, timeBudgetMs: 30_000 }),
    async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  for (const family of ['search-reformulation', 'result-recovery', 'workaround-funnel']) {
    const row = result.families.find(row => row.family === family)!;
    expect(row).toMatchObject({ scanned: 2, coverage: 'truncated', diagnostics: { reviewEligible: false,
      sourceCoverage: { pages: 2, windowExhausted: false, stop: 'row-cap' } } });
    expect(JSON.stringify(row)).not.toContain('2026-10-24T12:00:00.123456Z');
  }
  expect(result.coverage.checked).toEqual([]);
  expect(result.coverage.residue).toContain('search-reformulation:truncated');
});
it('drains native activity pages while retaining earlier provider cells and explicit missing transcripts', async () => {
  for (const provider of ['codex', 'claude']) await f.db.adminSql`INSERT INTO harness_shared.agent_activity
    (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,status,created_at)
    VALUES ('sql-mining-test','mining-test','su-native-test',${provider},${provider + '-session'},'tool','browser',
      'pre',${provider + '-call'},'{"action":"click","selector":"#private-target"}'::jsonb,'ok',
      '2026-10-24T12:00:00.123456Z'::timestamptz)`;
  const result = await runMonitoredCensus(f.opts({ rowBudget: 1, windowRowBudget: 10, timeBudgetMs: 30_000 }),
    async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  const native = result.families.find(row => row.family === 'native-operation')!;
  expect(native).toMatchObject({ scanned: 2, coverage: 'UNKNOWN', diagnostics: { reviewEligible: false,
    sourceCoverage: { pages: 2, windowExhausted: true, complete: false, matrix: expect.arrayContaining([
      { provider: 'codex', kind: 'browser', source: 'activity', status: 'measured' },
      { provider: 'claude', kind: 'browser', source: 'activity', status: 'measured' },
      { provider: 'omp', kind: 'browser', source: 'activity', status: 'missing' },
      { provider: 'codex', kind: 'browser', source: 'transcript', status: 'missing' },
    ]) },
  } });
  expect(JSON.stringify(native)).not.toMatch(/private-target|su-native-test|codex-session|claude-session/);
});
it('keeps existing SQL mining live when the monitored-run persistence dependency is unavailable', async () => {
  await f.seed();
  await f.db.adminSql`ALTER TABLE harness_shared.sql_intent_runs RENAME TO sql_intent_runs_unavailable`;
  try {
    const result = await runSqlOpportunityCensus(f.opts({ rowBudget: 100, timeBudgetMs: 30_000 }));
    expect(result).toMatchObject({ sql: { status: 'ok', rows: 1 }, monitored: null, reason: 'database-42P01' });
    expect(await f.db.adminSql`SELECT 1 FROM harness_shared.sql_intent_history`).toHaveLength(1);
    expect(await f.db.adminSql`SELECT 1 FROM harness_shared.sql_intent_operations`).toHaveLength(1);
  } finally {
    await f.db.adminSql`ALTER TABLE harness_shared.sql_intent_runs_unavailable RENAME TO sql_intent_runs`;
  }
});

async function ledgerEvidence(tool: string, args: unknown, body: unknown, at: string,
  status = 'ok', metadata: unknown = {}) {
  const id = await f.seed('unused', at);
  const uri = buildScratchUri({ workspaceId: 'sql-mining-test', toolName: tool, runId: randomUUID(), basename: 'result.spill' });
  writeScratchReference({ filePath: safeScratchFilesystemPath(uri), payload: JSON.stringify(body),
    workspaceId: 'sql-mining-test', ownerId: 'su-private-actor', mediaType: 'application/json', bodyOffsetInPayload: 0 });
  await f.db.adminSql`UPDATE harness_shared.tool_invocations SET tool_name=${tool},args_json=${JSON.stringify(args)}::jsonb,
    status=${status},metadata_json=${JSON.stringify(metadata)}::jsonb,output_ref=${uri} WHERE id=${id}::bigint`;
  return id;
}
it('R23-DERIVED-ACL production search replay denies edits, deletion, revoked scope, missing bindings and incomplete scans', async () => {
  const ids: string[] = [];
  for (const query of ['job queue', 'job status', 'job owner']) {
    ids.push(await ledgerEvidence('tools:find', { query }, { unrecognized: true }, '2026-10-24T12:00:00Z'));
  }
  const opts = f.opts({ rowBudget: 1, windowRowBudget: 10, timeBudgetMs: 30_000 });
  const run = await runMonitoredCensus(opts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  const candidateId = (run.families.find(r => r.family === 'search-reformulation')!.diagnostics.candidates as { id: string }[])[0]!.id;
  const read = (over: Partial<typeof opts> = {}) => readProductionMonitoredCandidate({ ...opts, ...over,
    runId: run.runId, family: 'search-reformulation', candidateId });
  const allowed = await read();
  expect(allowed).toMatchObject({ metrics: { logicalDemand: 3, reformulations: 2 }, reviewEligible: false });
  expect(JSON.stringify(allowed)).not.toMatch(/job queue|job status|job owner|sourceRevisions|window/);
  // Both semantic outcomes are UNKNOWN; current physical output availability
  // must still revoke the aggregate, and restoration must make it readable again.
  const [output] = await f.db.adminSql`SELECT output_ref FROM harness_shared.tool_invocations WHERE id=${ids[0]!}::bigint`;
  const outputPath = safeScratchFilesystemPath(output!.output_ref), original = readFileSync(outputPath);
  await rm(outputPath); expect(await read()).toBeNull();
  await writeFile(outputPath, original); expect(await read()).toEqual(allowed);
  // Expire the single read budget between ACL passes. Giving the second pass
  // a fresh budget would incorrectly release the same otherwise valid packet.
  const started = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(started);
  let snapshots = 0;
  const client = new Proxy(opts.client!, { apply(target, thisArg, args) {
    if (Array.isArray(args[0]) && args[0].join('').includes('SELECT f.diagnostics')) {
      snapshots++;
      if (snapshots === 2) clock.mockReturnValue(started + 5001);
    }
    return Reflect.apply(target, thisArg, args);
  } });
  try {
    expect(await read({ client, timeBudgetMs: 5000 })).toBeNull();
    expect(snapshots).toBe(2);
  } finally { clock.mockRestore(); }
  expect(await read({ authorize: async () => false })).toBeNull();
  expect(await read({ windowRowBudget: 2 })).toBeNull();
  expect(await read({ scope: { ...opts.scope, epoch: 'rotated' } })).toBeNull();
  await f.db.adminSql`UPDATE harness_shared.tool_invocations SET args_json='{"query":"unrelated"}'::jsonb WHERE id=${ids[0]!}::bigint`;
  expect(await read()).toBeNull();
  await f.db.adminSql`UPDATE harness_shared.tool_invocations SET args_json='{"query":"job queue"}'::jsonb WHERE id=${ids[0]!}::bigint`;
  expect(await read()).toEqual(allowed);
  const [stored] = await f.db.adminSql`SELECT diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE run_id=${run.runId}::uuid AND family='search-reformulation'`;
  await f.db.adminSql`UPDATE harness_shared.sql_intent_family_runs SET diagnostics=diagnostics-'sourceRevisions'
    WHERE run_id=${run.runId}::uuid AND family='search-reformulation'`;
  expect(await read()).toBeNull();
  await f.db.adminSql`UPDATE harness_shared.sql_intent_family_runs SET diagnostics=${JSON.stringify(stored!.diagnostics)}::jsonb
    WHERE run_id=${run.runId}::uuid AND family='search-reformulation'`;
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${ids[1]!}::bigint`;
  expect(await read()).toBeNull();
});
it('R23-DERIVED-ACL production recovery and workaround replay checks exact output copies and exposure sources', async () => {
  const ids: string[] = [];
  for (const episode of [0, 1]) {
    const start = Date.parse('2026-10-24T12:00:00Z') + episode * 600_000;
    const at = (offset: number) => new Date(start + offset * 1000).toISOString();
    const uri = `papercusp://scratch/private-recovery-${episode}`;
    ids.push(await ledgerEvidence('plans:get', { slug: 'private-recovery' }, { ok: true }, at(0), 'ok',
      { spillUri: uri, returnedContextBytes: 6000, spilledBytes: 90000, spillFailed: false }));
    ids.push(await ledgerEvidence('capability:read', { uri }, { ok: true }, at(1)));
    ids.push(await ledgerEvidence('docs:get', { slug: 'private-repair' }, { ok: false, error: 'invalid_args' }, at(10), 'error'));
    ids.push(await ledgerEvidence('docs:get', { slug: 'private-repair', corrected: true }, { ok: true }, at(11)));
  }
  const denominator = await ledgerEvidence('plans:get', { slug: 'private-small-result' }, { ok: true }, '2026-10-24T13:00:00Z');
  const opts = f.opts({ rowBudget: 2, windowRowBudget: 20, timeBudgetMs: 30_000 });
  const run = await runMonitoredCensus(opts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  const read = (family: 'result-recovery' | 'workaround-funnel') => readProductionMonitoredCandidate({ ...opts,
    family, runId: run.runId,
    candidateId: (run.families.find(r => r.family === family)!.diagnostics.candidates as { id: string }[])[0]!.id });
  expect(await read('result-recovery')).not.toBeNull();
  expect(await read('workaround-funnel')).not.toBeNull();
  const [source] = await f.db.adminSql`SELECT output_ref FROM harness_shared.tool_invocations WHERE id=${ids[0]!}::bigint`;
  const path = safeScratchFilesystemPath(source!.output_ref);
  const original = readFileSync(path);
  await rm(path); expect(await read('result-recovery')).toBeNull();
  await writeFile(path, original); expect(await read('result-recovery')).not.toBeNull();
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${denominator}::bigint`;
  expect(await read('result-recovery')).toBeNull();
  expect(await read('workaround-funnel')).not.toBeNull();
  await f.db.adminSql`UPDATE harness_shared.tool_invocations SET status='error' WHERE id=${ids[3]!}::bigint`;
  expect(await read('workaround-funnel')).toBeNull();
});
it('persists recovery and workaround candidate membership from exact real output sources without private semantics', async () => {
  for (const episode of [0, 1]) {
    const start = Date.parse('2026-10-24T12:00:00Z') + episode * 600_000;
    const at = (offset: number) => new Date(start + offset * 1000).toISOString();
    const uri = `papercusp://scratch/private-recovery-${episode}`;
    await ledgerEvidence('plans:get', { slug: 'private-recovery' }, { ok: true }, at(0), 'ok',
      { spillUri: uri, returnedContextBytes: 6000, spilledBytes: 90000, spillFailed: false });
    await ledgerEvidence('capability:read', { uri }, { ok: true }, at(1));
    await ledgerEvidence('docs:get', { slug: 'private-repair' }, { ok: false, error: 'invalid_args' }, at(10), 'error');
    await ledgerEvidence('docs:get', { slug: 'private-repair', corrected: true }, { ok: true }, at(11));
  }
  // The exposure denominator contributes authority even without a recovery episode.
  await ledgerEvidence('plans:get', { slug: 'private-small-result' }, { ok: true }, '2026-10-24T13:00:00Z');
  const result = await runMonitoredCensus(f.opts({ rowBudget: 1, windowRowBudget: 20, timeBudgetMs: 30_000 }),
    async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  const rows = await f.db.adminSql`SELECT family,diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE run_id=${result.runId}::uuid AND family IN ('result-recovery','workaround-funnel')`;
  for (const row of rows) {
    expect(row.diagnostics.candidates).toHaveLength(1);
    const c = row.diagnostics.candidates[0];
    expect(c).toMatchObject({ id: expect.stringMatching(/^[a-f0-9]{64}$/), reviewEligible: false });
    const contributing = row.family === 'result-recovery' ? 5 : 4;
    expect(c.sourceRefs).toHaveLength(contributing); expect(c.operationRefs).toHaveLength(contributing);
    if (row.family === 'result-recovery') expect(c.metrics.exposure).toBe(3);
    expect([...c.sourceRefs, ...c.operationRefs].every((t: string) => /^[a-f0-9]{64}$/.test(t))).toBe(true);
  }
  expect(JSON.stringify(rows)).not.toMatch(/private-recovery|private-repair|su-private-actor|papercusp:\/\//);
  const firstIds = rows.map(r => [r.family, r.diagnostics.candidates[0].id]).sort();
  const again = await runMonitoredCensus(f.opts({ rowBudget: 2, windowRowBudget: 20, timeBudgetMs: 30_000 }),
    async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  expect(again.families.filter(r => ['result-recovery','workaround-funnel'].includes(r.family))
    .map(r => [r.family, (r.diagnostics.candidates as Array<{ id: string }>)[0]!.id]).sort()).toEqual(firstIds);
  const rotatedOpts = f.opts({ rowBudget: 20, timeBudgetMs: 30_000 });
  rotatedOpts.scope = { ...rotatedOpts.scope, epoch: 'rotated-private-scope' };
  const rotated = await runMonitoredCensus(rotatedOpts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  for (const row of rotated.families.filter(r => ['result-recovery','workaround-funnel'].includes(r.family)))
    expect((row.diagnostics.candidates as Array<{ id: string }>)[0]!.id).not.toBe(firstIds.find(([family]) => family === row.family)![1]);
});
it('binds a qualifying SQL candidate to the exact source set and fails closed if that set disappears', async () => {
  for (let i = 0; i < 12; i++) {
    const id = await f.seed(undefined, i < 6 ? '2026-10-23T12:00:00Z' : '2026-10-24T12:00:00Z');
    await f.db.adminSql`UPDATE harness_shared.tool_invocations SET coord_owner_id=${'su-private-agent-' + i % 3}
      WHERE id=${id}::bigint`;
  }
  const opts = f.opts({ rowBudget: 100, timeBudgetMs: 30_000 });
  const first = await runMonitoredCensus(opts, () => mineSqlCandidateSlice(opts));
  expect(first.families[0]).toMatchObject({ qualifying: 1, coverage: 'measured', diagnostics: {
    candidates: [expect.objectContaining({ reviewEligible: true,
      metrics: { successful: 12, error: 0, refused: 0, unknown: 0, verifiedAgents: 3, activeDays: 2 } })],
  } });
  const candidates = first.families[0]!.diagnostics.candidates as Array<{ sourceRefs: string[]; operationRefs: string[] }>;
  expect(candidates[0]!.sourceRefs).toHaveLength(12); expect(candidates[0]!.operationRefs).toHaveLength(12);
  const missing = await runMonitoredCensus(opts, async () => {
    const result = await mineSqlCandidateSlice(opts);
    await f.db.adminSql`DELETE FROM harness_shared.sql_intent_operations`;
    return result;
  });
  expect(missing.families[0]).toMatchObject({ coverage: 'UNKNOWN', qualifying: 0,
    diagnostics: { reviewEligible: false, candidates: [], reason: 'sql_mining_source_missing' } });
  expect(JSON.stringify(first.families[0])).not.toMatch(/private-one|su-private-agent/);
});
it('D030 native index candidates and supplied transcript paths cannot authorize production evidence', async () => {
  const session = randomUUID(), actor = 'su-native-private';
  await f.db.adminSql`INSERT INTO harness_shared.adv_sessions (workspace_id,mode,coord_owner_id,agent,session_id)
    VALUES ('sql-mining-test','console',${actor},'codex',${session})`;
  const lines: unknown[] = [];
  for (const i of [0, 1]) {
    const callId = `private-call-${i}`;
    await f.db.adminSql`INSERT INTO harness_shared.agent_activity
      (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,status,created_at)
      VALUES ('sql-mining-test','mining-test',${actor},'codex',${session},'tool','exec_command','pre',${callId},
        '{"cmd":"rg private-path src"}'::jsonb,'ok','2026-10-24T12:00:00Z')`;
    lines.push({ timestamp: '2026-10-24T12:00:00Z', type: 'response_item', payload: {
      type: 'function_call', name: 'exec_command', call_id: callId, arguments: '{"cmd":"rg private-path src"}' } },
    { timestamp: '2026-10-24T12:00:01Z', type: 'response_item', payload: {
      type: 'function_call_output', call_id: callId, output: '{"exit_code":0}' } });
  }
  const path = join(dir, 'native.jsonl'); await writeFile(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const opts = f.opts({ rowBudget: 1, timeBudgetMs: 30_000 });
  let bodyReads = 0, continuity: 'complete' | 'gap' | 'unknown' = 'complete';
  const deps = { locateTranscript: async () => { bodyReads++; return path; }, readContinuity: async () => continuity };
  const result = await runMonitoredCensus(opts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }),
    deps);
  expect(bodyReads).toBe(0);
  const [row] = await f.db.adminSql`SELECT diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE run_id=${result.runId}::uuid AND family='native-operation'`;
  expect(row!.diagnostics.candidates).toEqual([expect.objectContaining({
    id: expect.stringMatching(/^[a-f0-9]{64}$/), reviewEligible: false,
    metrics: { logicalDemand: 2, successful: 0, unknown: 2 },
  })]);
  expect(row!.diagnostics.candidates[0].sourceRefs).toHaveLength(2);
  expect(row!.diagnostics.candidates[0].operationRefs).toHaveLength(2);
  expect(JSON.stringify(row)).not.toMatch(/private-path|private-call|su-native-private|native.jsonl/);
  const read = () => readProductionMonitoredCandidate({ ...opts,
    family: 'native-operation', runId: result.runId, candidateId: row!.diagnostics.candidates[0].id }, deps);
  const allowed = await read();
  expect(allowed).toMatchObject({ reviewEligible: false, metrics: { logicalDemand: 2, successful: 0, unknown: 2 } });
  expect(JSON.stringify(allowed)).not.toMatch(/private-path|private-call|su-native-private|native.jsonl/);
  // A complete-looking retention reply cannot replace exact-call authority.
  // Candidate-only path overrides must never trigger production body IO.
  const native = result.families.find(r => r.family === 'native-operation')!;
  expect(native).toMatchObject({ coverage: 'UNKNOWN', diagnostics: { reviewEligible: false,
    sourceCoverage: { incomplete: 2, windowExhausted: true },
    candidates: [expect.objectContaining({ reviewEligible: false })] } });
  const transcripts = (native.diagnostics.sourceCoverage as { matrix: { source: string; status: string }[] }).matrix
    .filter(c => c.source === 'transcript');
  expect(transcripts).toHaveLength(6); expect(transcripts.every(c => c.status === 'missing')).toBe(true);
  continuity = 'gap'; expect(await read()).toEqual(allowed);
  continuity = 'unknown'; expect(await read()).toEqual(allowed);
  continuity = 'complete'; expect(await read()).toEqual(allowed);
  // Untrusted paths cannot change a minimized activity-only UNKNOWN summary.
  const original = readFileSync(path);
  await writeFile(path, original.toString().replaceAll('private-path', 'changed-path'));
  expect(await read()).toEqual(allowed);
  await writeFile(path, original); expect(await read()).toEqual(allowed);
  await f.db.adminSql`UPDATE harness_shared.agent_activity SET harness_slug='other-harness'
    WHERE owner_id=${actor}`;
  expect(await read()).toBeNull();
  await f.db.adminSql`UPDATE harness_shared.agent_activity SET harness_slug='mining-test' WHERE owner_id=${actor}`;
  expect(await read()).toEqual(allowed);
  await rm(path);
  expect(await read()).toEqual(allowed);
  const lost = await runMonitoredCensus(opts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }), deps);
  expect(lost.families.find(r => r.family === 'native-operation')).toMatchObject({ coverage: 'UNKNOWN',
    diagnostics: { reviewEligible: false, sourceCoverage: { incomplete: 2 } } });
  const missing = await runMonitoredCensus(opts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }),
    { locateTranscript: async () => path });
  const unknown = missing.families.find(r => r.family === 'native-operation')!;
  expect(unknown).toMatchObject({ coverage: 'UNKNOWN', diagnostics: { reviewEligible: false,
    candidates: [expect.objectContaining({ reviewEligible: false, metrics: { logicalDemand: 2, successful: 0, unknown: 2 } })] } });
  const evidence = (unknown.diagnostics.candidates as Array<{ sourceRefs: string[] }>)[0]!;
  expect(evidence.sourceRefs).toHaveLength(2);
  expect(bodyReads).toBe(0);
});

it('R13-CONTRACT ledger continuity and current output completeness gate all three activity candidate families', async () => {
  const ids: string[] = [];
  for (const query of ['job queue', 'job status', 'job owner'])
    ids.push(await ledgerEvidence('tools:find', { query }, { results: [] }, '2026-10-24T11:00:00Z'));
  for (const episode of [0, 1]) {
    const start = Date.parse('2026-10-24T12:00:00Z') + episode * 600_000;
    const at = (offset: number) => new Date(start + offset * 1000).toISOString();
    const uri = `papercusp://scratch/continuity-${episode}`;
    ids.push(await ledgerEvidence('plans:get', { slug: 'private-recovery' }, { ok: true }, at(0), 'ok', { spillUri: uri }));
    ids.push(await ledgerEvidence('capability:read', { uri }, { ok: true }, at(1)));
    ids.push(await ledgerEvidence('docs:get', { slug: 'private-repair' }, { ok: false, error: 'invalid_args' }, at(10), 'error'));
    ids.push(await ledgerEvidence('docs:get', { slug: 'private-repair', corrected: true }, { ok: true }, at(11)));
  }
  const opts = f.opts({ retainedFrom: undefined, rowBudget: 2, timeBudgetMs: 30_000 });
  const run = () => runMonitoredCensus(opts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  const families = ['search-reformulation', 'result-recovery', 'workaround-funnel'] as const;
  // No oldest-row, policy or caller lookback inference can create a receipt.
  const absent = await run();
  for (const family of families) expect(absent.families.find(r => r.family === family)).toMatchObject({ coverage: 'UNKNOWN' });
  await f.db.adminSql`INSERT INTO harness_shared.sql_intent_progress
    (workspace_id,scope_id,harness_slug,retained_from) VALUES (${opts.workspaceId},
      ${miningScopeId(opts.scope, opts.harnessSlug)},${opts.harnessSlug},'2026-10-01T00:00:00Z')`;
  const complete = await run();
  for (const family of families) {
    const row = complete.families.find(r => r.family === family)!;
    expect(row).toMatchObject({ coverage: 'measured', diagnostics: { reviewEligible: true,
      continuity: { before: 'complete', after: 'complete' },
      sourceCoverage: { incomplete: 0, pages: family === 'search-reformulation' ? 2 : 6 } } });
    expect(row.diagnostics.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ reviewEligible: true })]));
  }
  const candidate = (complete.families.find(r => r.family === 'search-reformulation')!.diagnostics.candidates as { id: string }[])[0]!;
  const read = () => readProductionMonitoredCandidate({ ...opts, family: 'search-reformulation',
    runId: complete.runId, candidateId: candidate.id });
  expect(await read()).toMatchObject({ reviewEligible: true });
  const [source] = await f.db.adminSql`SELECT output_ref FROM harness_shared.tool_invocations WHERE id=${ids[0]!}::bigint`;
  const path = safeScratchFilesystemPath(source!.output_ref), bytes = readFileSync(path);
  await rm(path); expect(await read()).toBeNull();
  const lost = await run();
  expect(lost.families.find(r => r.family === 'search-reformulation')).toMatchObject({ coverage: 'UNKNOWN',
    diagnostics: { reviewEligible: false, sourceCoverage: { incomplete: 1 } } });
  await writeFile(path, bytes); expect(await read()).toMatchObject({ reviewEligible: true });
  await f.db.adminSql`ALTER TABLE harness_shared.tool_invocations DISABLE TRIGGER sql_intent_retention_delete`;
  try {
    expect(await read()).toBeNull();
    const uninstrumented = await run();
    for (const family of families) expect(uninstrumented.families.find(r => r.family === family)).toMatchObject({ coverage: 'UNKNOWN' });
  } finally { await f.db.adminSql`ALTER TABLE harness_shared.tool_invocations ENABLE ALWAYS TRIGGER sql_intent_retention_delete`; }
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${ids.at(-1)!}::bigint`;
  expect(await read()).toBeNull();
  const gap = await run();
  for (const family of families) expect(gap.families.find(r => r.family === family)).toMatchObject({ coverage: 'UNKNOWN',
    diagnostics: { reviewEligible: false, continuity: { before: 'gap', after: 'gap' } } });
});

it('D030 all six native provider/kind indexes stay UNKNOWN without independently authorized transcripts', async () => {
  const paths = new Map<string, string>();
  // Cross a decimal-width boundary: ORDER BY the id::text projection would
  // disagree with the numeric keyset predicate and silently omit whole cells.
  let sourceId = 990;
  for (const provider of ['codex', 'claude', 'omp'] as const) {
    const session = randomUUID(), actor = `su-native-${provider}`, lines: unknown[] = [];
    await f.db.adminSql`INSERT INTO harness_shared.adv_sessions (workspace_id,mode,coord_owner_id,agent,session_id)
      VALUES ('sql-mining-test','console',${actor},${provider},${session})`;
    for (const kind of ['shell', 'browser']) for (const i of [0, 1]) {
      const callId = `${kind}-${i}`, at = '2026-10-24T12:00:00Z';
      const tool = kind === 'browser' ? 'browser' : provider === 'codex' ? 'exec_command' : provider === 'claude' ? 'Bash' : 'bash';
      const args = kind === 'browser' ? { action: 'click', selector: '#save' } : { command: 'rg private src' };
      const body = kind === 'browser' ? { ok: true } : { exit_code: 0 };
      await f.db.adminSql`INSERT INTO harness_shared.agent_activity
        (id,workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,status,created_at)
        VALUES (${sourceId++},'sql-mining-test','mining-test',${actor},${provider},${session},'tool',${tool},'pre',${callId},
          ${JSON.stringify(args)}::jsonb,'ok',${at}::timestamptz)`;
      if (provider === 'codex') lines.push(
        { timestamp: at, type: 'response_item', payload: { type: 'function_call', name: tool, call_id: callId, arguments: JSON.stringify(args) } },
        { timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify(body) } });
      else if (provider === 'claude') lines.push(
        { timestamp: at, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: tool, input: args }] } },
        { timestamp: at, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: JSON.stringify(body) }] } });
      else lines.push(
        { timestamp: at, type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: tool, arguments: args }] } },
        { timestamp: at, type: 'message', message: { role: 'toolResult', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(body) }] } });
    }
    const path = join(dir, `${session}.jsonl`); paths.set(provider, path);
    await writeFile(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  }
  let bodyReads = 0, continuity: 'complete' | 'gap' = 'complete';
  const deps: NonNullable<Parameters<typeof runMonitoredCensus>[2]> = {
    locateTranscript: async ({ provider }) => { bodyReads++; return paths.get(provider) ?? null; },
    readContinuity: async ({ family }) => family === 'native-operation' ? continuity : 'unknown',
  };
  const opts = f.opts({ rowBudget: 2, timeBudgetMs: 30_000 });
  const [population] = await f.db.adminSql`SELECT count(*)::int AS count FROM harness_shared.agent_activity`;
  expect(population!.count).toBe(12);
  const run = () => runMonitoredCensus(opts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }), deps);
  const complete = await run(), native = complete.families.find(r => r.family === 'native-operation')!;
  expect(bodyReads).toBe(0);
  expect(native).toMatchObject({ coverage: 'UNKNOWN', diagnostics: { reviewEligible: false, sourceCoverage: { incomplete: 12, pages: 6 } } });
  const candidates = native.diagnostics.candidates as { id: string; reviewEligible: boolean }[];
  expect(candidates).toHaveLength(2); expect(candidates.every(c => !c.reviewEligible)).toBe(true);
  const transcripts = (native.diagnostics.sourceCoverage as { matrix: { source: string; status: string }[] }).matrix
    .filter(c => c.source === 'transcript');
  expect(transcripts).toHaveLength(6); expect(transcripts.every(c => c.status === 'missing')).toBe(true);
  const read = () => readProductionMonitoredCandidate({ ...opts, family: 'native-operation',
    runId: complete.runId, candidateId: candidates[0]!.id }, deps);
  const allowed = await read();
  expect(allowed).toMatchObject({ reviewEligible: false, metrics: { successful: 0 } });
  expect(allowed!.metrics.unknown).toBeGreaterThan(0);
  continuity = 'gap'; expect(await read()).toEqual(allowed); continuity = 'complete';
  const path = paths.get('omp')!, original = readFileSync(path);
  await rm(path); expect(await read()).toEqual(allowed);
  expect((await run()).families.find(r => r.family === 'native-operation')).toMatchObject({ coverage: 'UNKNOWN',
    diagnostics: { reviewEligible: false, sourceCoverage: { incomplete: 12 } } });
  await writeFile(path, original); expect(await read()).toEqual(allowed);
  expect(bodyReads).toBe(0);
});
