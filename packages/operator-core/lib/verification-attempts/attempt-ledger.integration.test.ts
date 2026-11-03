/**
 * R-1 (expensive-verification-loops-2026-09-29): a slow attempt started through a
 * ledgered launcher is recorded against its work item with duration, outcome and a
 * failure fingerprint. Drives the real closeTask seam against a fresh Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const store = await import('../task-manager/store');
const ledger = await import('./attempt-ledger');

const WS = 'default';
const WI = 'WI-test-attempts';
let db: FreshPgDb;
let logDir: string;

async function insertJob(taskId: string, opts: { minutesAgo: number; logBody?: string; workItemId?: string | null }) {
  const logPath = join(logDir, `${taskId}.log`);
  if (opts.logBody !== undefined) writeFileSync(logPath, opts.logBody);
  await db.sql`
    INSERT INTO harness_shared.task_ledger (
      task_id, workspace_id, root_task_id, class, title, argv, launched_by,
      work_item_id, confined, state, started_at, log_path, detail
    ) VALUES (
      ${taskId}, ${WS}, ${taskId}, 'bash-job', 'drill run',
      ${JSON.stringify(['bash', '-c', `scripts/drill.sh --run-id ${taskId}`])}::jsonb, 'su-test',
      ${opts.workItemId === undefined ? WI : opts.workItemId}, true, 'running',
      now() - make_interval(mins => ${opts.minutesAgo}), ${logPath}, '{}'::jsonb
    )
  `;
}

/** Close through the real seam and wait for the fire-and-forget attempt stamp. */
async function close(taskId: string, exitCode: number) {
  let pending: Promise<unknown> = Promise.resolve();
  const closed = await store.closeTask(
    taskId,
    { state: 'exited', exitCode, exitReason: exitCode === 0 ? null : `exit ${exitCode}` },
    db.sql,
    {
      emitTerminal: () => {},
      recordAttempt: (row, deps) => {
        const p = ledger.recordAttemptOnClose(row, deps);
        pending = p;
        return p;
      },
    },
  );
  expect(closed).toBe(true);
  await pending;
}

const drillFail = (reason: string, ts: string) =>
  [
    `hive-git-physical-scenario: PHASE_START D phase_d_worktree_materialization ${ts}`,
    `phase D (phase_d_worktree_materialization): ${reason}`,
    'DRILL_EXIT=1',
  ].join('\n');

beforeAll(async () => {
  db = await createFreshPgDb('verification-attempt-ledger');
  h.sql = db.sql;
  for (const m of ['632-event-key-fire-latch.sql', '696-task-ledger.sql', '700-task-ledger-bash-job-id-idx.sql']) {
    await applyMigrationForTest(db.sql, resolve(SQL_DIR, m));
  }
  logDir = mkdtempSync(join(tmpdir(), 'attempt-ledger-'));
});

afterAll(async () => {
  await db?.cleanup();
  if (logDir) rmSync(logDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.task_ledger`;
});

describe('verification attempt ledger (R-1)', () => {
  it('records a slow failed attempt with duration, outcome and failure fingerprint', async () => {
    await insertJob('t-fail', { minutesAgo: 20, logBody: drillFail('did not converge within 180s', '2026-09-29T03:12:00Z') });
    await close('t-fail', 1);

    const [a] = await ledger.listWorkItemAttempts({ workspaceId: WS, workItemId: WI });
    expect(a).toMatchObject({ taskId: 't-fail', outcome: 'fail', source: 'log' });
    expect(a!.durationMs).toBeGreaterThanOrEqual(19 * 60_000);
    expect(a!.fingerprint).toMatch(/^log:[0-9a-f]{12}$/);
    expect(a!.label).toContain('phase D (phase_d_worktree_materialization)');
    expect(a!.commandFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(a!.evidenceExcerpt).toContain('did not converge within 180s');
    const [task] = await store.listTasks({ taskId: 't-fail', includeEnded: true }, db.sql);
    expect(task?.detail.verificationAttempt).toMatchObject({
      evidenceExcerpt: expect.stringContaining('did not converge within 180s'),
      evidenceExcerptTruncated: false,
    });
  });

  it('gives the same failure the same fingerprint across runs, and a different failure a different one', async () => {
    await insertJob('t-a', { minutesAgo: 30, logBody: drillFail('did not converge within 180s', '2026-09-29T03:12:00Z') });
    await close('t-a', 1);
    await insertJob('t-b', { minutesAgo: 25, logBody: drillFail('did not converge within 180s', '2026-09-29T05:40:11Z') });
    await close('t-b', 1);
    await insertJob('t-c', { minutesAgo: 20, logBody: drillFail('host key mismatch', '2026-09-29T06:01:00Z') });
    await close('t-c', 1);

    const attempts = await ledger.listWorkItemAttempts({ workspaceId: WS, workItemId: WI });
    expect(attempts.map((a) => a.taskId)).toEqual(['t-a', 't-b', 't-c']);
    expect(attempts[0]!.fingerprint).toBe(attempts[1]!.fingerprint);
    expect(attempts[2]!.fingerprint).not.toBe(attempts[0]!.fingerprint);
  });

  it('records a slow pass with no fingerprint', async () => {
    await insertJob('t-pass', { minutesAgo: 10, logBody: 'PASS=15 FAIL=0 SKIP=0\nDRILL_EXIT=0' });
    await close('t-pass', 0);
    const [a] = await ledger.listWorkItemAttempts({ workspaceId: WS, workItemId: WI });
    expect(a).toMatchObject({ taskId: 't-pass', outcome: 'pass', fingerprint: null });
  });

  it('does not record a short job or a job with no work item', async () => {
    await insertJob('t-short', { minutesAgo: 1, logBody: 'error: boom' });
    await close('t-short', 1);
    await insertJob('t-nowi', { minutesAgo: 20, logBody: 'error: boom', workItemId: null });
    await close('t-nowi', 1);
    expect(await ledger.listWorkItemAttempts({ workspaceId: WS, workItemId: WI })).toEqual([]);
    const [row] = await db.sql<Array<{ has: boolean }>>`
      SELECT detail ? 'verificationAttempt' AS has FROM harness_shared.task_ledger WHERE task_id = 't-nowi'`;
    expect(row!.has).toBe(false);
  });

  it('lists a still-running slow attempt as running', async () => {
    await insertJob('t-live', { minutesAgo: 5 });
    const [a] = await ledger.listWorkItemAttempts({ workspaceId: WS, workItemId: WI });
    expect(a).toMatchObject({ taskId: 't-live', outcome: 'running', endedAt: null });
  });

  it('keeps a harness-reported structured result over the parsed log', async () => {
    await insertJob('t-structured', { minutesAgo: 20, logBody: 'error: something generic' });
    expect(
      await ledger.recordStructuredAttemptResult(
        't-structured',
        { phase: 'E', step: 'github-bridge-push', reasonCode: 'egress_refused' },
        db.sql,
      ),
    ).toBe(true);
    await close('t-structured', 1);
    const [a] = await ledger.listWorkItemAttempts({ workspaceId: WS, workItemId: WI });
    expect(a).toMatchObject({ source: 'structured', label: 'phase=E step=github-bridge-push reason=egress_refused' });
  });
});
