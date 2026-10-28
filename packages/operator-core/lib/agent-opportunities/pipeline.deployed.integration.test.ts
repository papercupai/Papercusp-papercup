/**
 * Native production probe, explicitly selected by an operator. No fixture DB,
 * authored workflow output, receipt insertion or dependency override belongs here.
 *
 * PAPERCUSP_SQL_INTENT_DEPLOYED_RUN is JSON containing identifiers only:
 * { workspaceId, harnessSlug, runId, runtime, phase: "exercise" | "settled" }.
 * Set PAPERCUSP_TEST_RUN_GROUP=monitoredTestRunGroup(runId,runtime) BEFORE
 * launching the native runner. Exercise must enclose the actual scheduler fire.
 * It cannot certify its own unfinished reporter row. After native settlement,
 * run the settled phase, which reads that original row through the same reader.
 * An absent configuration never registers an R13-DEPLOYED case.
 */
import { expect, it } from 'vitest';
import { adminUrl } from '@papercusp/db-org/connection';
import { getOrgPg } from '@papercusp/db-org';
import { MONITORED_FAMILIES, assessMonitoredRun } from './pipeline';
import { monitoredTestRunGroup, readMonitoredRunEvidence } from './run-evidence';

const raw = process.env.PAPERCUSP_SQL_INTENT_DEPLOYED_RUN;
if (!raw) {
  it('requires an explicit production selection before registering deployed proof', () => {
    expect(process.env.PAPERCUSP_TEST_RUN_GROUP ?? '').not.toMatch(/^sql-intent-monitored:/);
  });
} else {
  const selection: unknown = JSON.parse(raw);
  if (!selection || typeof selection !== 'object' || Array.isArray(selection))
    throw new Error('R13 production selection must contain identifiers');
  const s = selection as Record<string, unknown>;
  for (const key of ['workspaceId', 'harnessSlug', 'runId', 'runtime'])
    if (typeof s[key] !== 'string' || !s[key].trim()) throw new Error(`R13 requires ${key}`);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(String(s.runId))
    || !['exercise', 'settled'].includes(String(s.phase)))
    throw new Error('R13 requires a canonical run UUID and exercise/settled phase');
  const workspaceId = s.workspaceId as string, harnessSlug = s.harnessSlug as string;
  const runId = s.runId as string, runtime = s.runtime as string;

  it(s.phase === 'exercise' ? 'R13-DEPLOYED' : 'R13-SETTLED', async () => {
    const enteredAt = Date.now();
    expect(process.env.PAPERCUSP_WORKSPACE_ID).toBe(workspaceId);
    expect(process.env.PAPERCUSP_TEST_RUN_HARNESS).toBe(harnessSlug);
    expect(process.env.PAPERCUSP_TEST_RUN_GROUP).toBe(monitoredTestRunGroup(runId, runtime));
    // A disposable fixture connection cannot certify the production reporter sink.
    // Compare in memory; connection strings and the scope key are never emitted.
    expect(Boolean(process.env.PAPERCUSP_TEST_RUNS_DB_URL
      && adminUrl() === process.env.PAPERCUSP_TEST_RUNS_DB_URL)).toBe(true);
    const sql = getOrgPg().sql;
    const { censusMiningOptions } = await import('../harness/routines/sql-read-census-action');
    const { loadHarnessRegistry } = await import('../harness-registry');
    const base = censusMiningOptions({ workspaceId, harnessSlug, timeBudgetMs: 30_000 });
    // Reuse the system action's scope/key custody. Restrict its trusted internal
    // grant to the explicitly selected, currently registered harness on EACH read.
    const authorize: typeof base.authorize = async scope => {
      if (scope.workspaceId !== workspaceId || scope.harnessSlug !== harnessSlug
        || scope.sourceBoundary !== base.scope.sourceBoundary) return false;
      const registry = await loadHarnessRegistry(workspaceId, { fresh: true });
      return registry.projects.some(project => project.slug === harnessSlug);
    };
    const opts = { ...base, runId, authorize };
    await expect.poll(async () => {
      const [row] = await sql`SELECT finished_at FROM harness_shared.sql_intent_runs
        WHERE workspace_id=${workspaceId} AND harness_slug=${harnessSlug} AND run_id=${runId}::uuid`;
      return Boolean(row?.finished_at);
    }, { timeout: 120_000, interval: 2000 }).toBe(true);
    const result = await readMonitoredRunEvidence(opts); // Production SDK and native joins; no deps.
    expect(result.status).toBe('read');
    if (result.status !== 'read') throw new Error(`R13 UNKNOWN: ${result.reasons.join(',')}`);
    const e = result.evidence;
    expect(e.run.runtime).toBe(runtime);
    // The reader independently binds this selection to the scheduler's before/
    // after runtime observations, configuration, due slot and canonical reviews.
    const rows = await sql`SELECT family,diagnostics FROM harness_shared.sql_intent_family_runs
      WHERE workspace_id=${workspaceId} AND run_id=${runId}::uuid ORDER BY family LIMIT 6`;
    expect(rows.map(r => r.family).sort()).toEqual([...MONITORED_FAMILIES].sort());
    for (const row of rows) {
      const window = row.diagnostics?.window;
      expect(Date.parse(window?.until) - Date.parse(window?.since)).toBe(7 * 86400_000);
    }
    const matrix = rows.find(r => r.family === 'native-operation')?.diagnostics?.sourceCoverage?.matrix;
    for (const provider of ['claude', 'codex', 'omp'])
      for (const kind of ['shell', 'browser'])
        expect(matrix).toEqual(expect.arrayContaining([
          expect.objectContaining({ provider, kind, source: 'transcript', status: 'measured' }),
        ]));
    const assessment = assessMonitoredRun(e);
    if (s.phase === 'exercise') {
      expect(Date.parse(e.run.startedAt)).toBeGreaterThanOrEqual(enteredAt);
      expect(e.testRuns).toEqual([]);
      expect(assessment).toMatchObject({ status: 'fail', failures: ['deployed-test-binding'], unknown: [] });
      // This pass means the production exercise ran. Only R13-SETTLED may
      // subsequently certify the native reporter's original case and timestamps.
    } else {
      expect(assessment).toMatchObject({ status: 'pass', failures: [], unknown: [] });
      expect(e.testRuns.length).toBeGreaterThan(0);
    }
    // Rehydrate after the extra window/matrix reads; a retained earlier snapshot
    // must not hide a concurrent ACL/config/review/test revocation.
    const final = await readMonitoredRunEvidence(opts);
    expect(final.status).toBe('read');
    if (final.status === 'read') expect(final.evidence).toEqual(e);
  }, 180_000);
}
