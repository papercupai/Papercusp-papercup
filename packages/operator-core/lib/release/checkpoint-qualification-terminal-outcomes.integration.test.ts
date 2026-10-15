/** Real Postgres proof that every terminal colour persists once with its exact attempt. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const db = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: db.sql }),
}));
vi.mock('../pg-bounded-txn', () => ({
  boundedOrgTxn: async (run: (tx: Sql) => Promise<unknown>) => db.sql!.begin(async (tx) => run(tx as unknown as Sql)),
}));

import {
  beginStoredQualification,
  readStoredQualification,
  recordStoredQualificationVerdict,
} from './checkpoint-qualification-transaction';

let org: OrgTestDb;
let sql: Sql;
const target = { workspaceId: 'ws-checkpoint-terminal-outcomes', installSlug: 'papercusp' };

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  db.sql = sql;
});
afterAll(async () => {
  db.sql = null;
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.pipeline_events WHERE workspace_id = ${target.workspaceId}`;
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
    VALUES ('rt-checkpoint-terminal-outcomes', ${target.installSlug}, 'green-checkpoint', 'cron', '{}'::jsonb,
            'system:green-checkpoint', TRUE, ${target.workspaceId}, '{}'::jsonb)
  `;
});

describe('checkpoint qualification terminal outcomes (real Postgres)', () => {
  it.each([
    { reason: 'advanced', green: true, outcome: 'green' },
    { reason: 'not-green', green: false, outcome: 'red' },
    // Infra inconclusive is a retryable pre-suite no-verdict; this code outcome is terminal.
    { reason: 'not-fast-forward', green: null, outcome: 'code-inconclusive' },
  ] as const)('persists one $outcome result and rejects a foreign candidate', async ({ reason, green, outcome }) => {
    const runId = `run-${reason}`;
    expect((await beginStoredQualification(target, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    })).status).toBe('updated');

    const terminal = {
      attemptId: 'attempt-1', candidate: 'candidate-1', runId,
      reason, green, nowMs: 200,
      terminalEvent: { status: reason, detail: { candidate: 'candidate-1', runId } },
    };
    expect((await recordStoredQualificationVerdict(target, {
      ...terminal, candidate: 'foreign-candidate',
    })).status).toBe('conflict');
    expect((await recordStoredQualificationVerdict(target, terminal)).status).toBe('updated');
    expect((await recordStoredQualificationVerdict(target, terminal)).status).toBe('terminal');

    expect(await readStoredQualification(target)).toMatchObject({
      status: 'present',
      transaction: {
        attemptId: 'attempt-1', candidate: 'candidate-1', runId,
        phase: 'terminal', lastTerminalVerdictAtMs: 200,
        outcome: { kind: outcome, reason },
      },
    });
    // WI-10007497: the caller's detail carries no attemptId; the committed event must still name
    // the logical attempt it settled, from the transaction itself.
    const events = await sql<{ status: string; candidate: string; run_id: string; attempt_id: string | null }[]>`
      SELECT status, detail->>'candidate' AS candidate, detail->>'runId' AS run_id,
             detail->>'attemptId' AS attempt_id
        FROM harness_shared.pipeline_events
       WHERE workspace_id = ${target.workspaceId} AND install_slug = ${target.installSlug}
         AND kind = 'green_checkpoint'
    `;
    expect(events).toEqual([{ status: reason, candidate: 'candidate-1', run_id: runId, attempt_id: 'attempt-1' }]);
  });
});
