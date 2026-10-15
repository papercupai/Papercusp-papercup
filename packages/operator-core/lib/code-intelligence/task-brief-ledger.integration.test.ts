import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupPlanPgFixture, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { readTaskFailureSignals } from './task-brief';

describe('native P018 real scoped incident ledger', () => {
  let fixture: PlanPgFixture;
  let ledger: postgres.Sql;
  const harness = `native-incident-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = '/private/native-incident-fixture';
  const path = 'target.test.ts';
  beforeAll(async () => {
    fixture = await setupPlanPgFixture();
    // Match the reader's late import: the required ecosystem suite installs a
    // private dispatcher DB while composing its imports. A static import here
    // can retain the earlier client, splitting the seed and read databases.
    const { getOrgPg } = await import('@papercusp/db-org');
    ledger = getOrgPg().sql;
  });
  afterAll(async () => {
    if (!fixture) return;
    try { await ledger`DELETE FROM harness_shared.test_runs WHERE harness_slug = ${harness}`; }
    finally { await fixture.dispose(); }
  });
  it('uses the latest normal run, hashes its error log, and excludes mutation and foreign-scope failures', async () => {
    const insert = async (status: string, source = 'local', workspace = fixture.workspaceId, checkout = root, file = path) => {
      const [row] = await ledger<{ id: string }[]>`
        INSERT INTO harness_shared.test_runs
          (workspace_id, harness_slug, file_path, status, source, framework, commit_sha, output_tail, execution_details)
        VALUES (${workspace}, ${harness}, ${file}, ${status}, ${source}, 'vitest', ${'a'.repeat(40)}, 'observed assertion failure',
          ${JSON.stringify({ root: checkout })}::text::jsonb) RETURNING id`;
      return Number(row.id);
    };
    const scope = { workspaceId: fixture.workspaceId, harness, root, paths: [path] };
    const failed = await insert('fail');
    const [seed] = await ledger<{ root: string; workspace_id: string }[]>`
      SELECT execution_details->>'root' AS root, workspace_id
      FROM harness_shared.test_runs WHERE id = ${failed}`;
    expect(seed).toEqual({ root, workspace_id: fixture.workspaceId });
    expect(await readTaskFailureSignals(scope)).toEqual([{ testRunId: failed, path, status: 'fail', commit: 'a'.repeat(40),
      logSha256: createHash('sha256').update('observed assertion failure').digest('hex') }]);
    await insert('fail', 'mutation-probe');
    await insert('error', 'local', 'foreign-workspace');
    await insert('error', 'local', fixture.workspaceId, root, 'outside.test.ts');
    await insert('error', 'local', fixture.workspaceId, '/another/checkout');
    expect((await readTaskFailureSignals(scope)).map(row => row.testRunId)).toEqual([failed]);
    await insert('pass');
    expect(await readTaskFailureSignals(scope)).toEqual([]);
    await insert('error', 'local', fixture.workspaceId, '/another/checkout');
    expect(await readTaskFailureSignals(scope)).toEqual([]);
  });
});
