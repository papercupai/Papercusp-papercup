import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { judgeTestsFromLedger, productionConformanceDeps } from './conformance-run-deps';
import * as ledger from '../check-results-ledger';

describe('conformance test-ledger evidence population', () => {
  let db: FreshPgDb;
  const file = 'lib/guard.test.ts';
  const input = {
    files: [file],
    workspaceId: 'conformance-workspace',
    now: () => new Date(Date.UTC(2026, 9, 15, 0, 10)),
  };

  beforeAll(async () => {
    db = await createFreshPgDb('conformance-test-sources');
    await db.sql`CREATE TABLE harness_shared.test_runs (
      id bigserial PRIMARY KEY, file_path text NOT NULL, workspace_id text,
      framework text, source text, status text NOT NULL, finished_at timestamptz
    )`;
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => { await db.sql`TRUNCATE harness_shared.test_runs`; });

  async function record(source: string | null, status: string, minute: number, workspace: string | null = input.workspaceId) {
    const finishedAt = new Date(Date.UTC(2026, 9, 15, 0, minute));
    await db.sql`INSERT INTO harness_shared.test_runs(file_path, workspace_id, framework, source, status, finished_at)
      VALUES (${file}, ${workspace}, 'vitest', ${source}, ${status}, ${finishedAt})`;
  }

  it('keeps a production pass after a newer intentional mutant failure', async () => {
    await record('local', 'pass', 1);
    await record('mutation-probe', 'fail', 2);
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'pass', value: 1 });
  });

  it('does not let a passing mutation control hide a production failure', async () => {
    await record('local', 'fail', 1);
    await record('mutation-probe', 'pass', 2);
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'fail', value: 0 });
  });

  it('reports missing production evidence when only mutation evidence exists', async () => {
    await record('mutation-probe', 'pass', 1);
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'error', detail: expect.stringContaining('no test-run ledger row') });
  });

  it.each(['local', 'ci', 'admin-ui', null])('retains genuine failures from source %s, including legacy rows', async source => {
    await record(source, 'pass', 1);
    await record(source, 'error', 2);
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'fail', value: 0 });
  });

  it('keeps workspace isolation and permits workspace-neutral CI evidence', async () => {
    await record('ci', 'pass', 1, null);
    await record('local', 'fail', 2, 'another-workspace');
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'pass', value: 1 });
  });

  it('reports stale evidence as unknown instead of a current regression', async () => {
    await record('local', 'fail', 1);
    const result = await judgeTestsFromLedger({
      ...input,
      now: () => new Date(Date.UTC(2026, 9, 23, 0, 0)),
    }, db.sql);
    expect(result).toMatchObject({ verdict: 'error', value: null, unit: 'files' });
    expect(result.detail).toContain('stale');
    expect(result.detail).toContain('test_runs #');
  });

  it('forwards canonical workspace and harness into executable platform checks', async () => {
    const run = vi.spyOn(ledger, 'runInstrumentChecks').mockResolvedValue([]);
    try {
      const deps = productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'harness', planSlug: 'plan' });
      await deps.evaluateCheck({ barKey: 'R-1', role: 'falsifier', checkId: 'R-1:mounts',
        check: { kind: 'instrument', instrumentKey: 'storage:cold-mounts-reboot' } });
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace', harnessSlug: 'harness' }));
    } finally { run.mockRestore(); }
  });
});
