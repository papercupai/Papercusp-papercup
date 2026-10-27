// @vitest-environment node
/**
 * EI-25841466577299173: exercise the first lazy terminal-event import against
 * real Postgres. The existing queue integration test preloads the engine.
 * This load witness delegates to the real module; no emitter is substituted.
 * Resolve the DB and registry mocks through the same importActual factories as
 * store.integration.test.ts, so this control covers that original import path.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { withActiveTestDeadline } from '../../test/_active-test-deadline';

const h = vi.hoisted(() => ({
  sql: null as unknown as postgres.Sql,
  ws: 'ws-task-terminal-cold',
  engineLoads: 0,
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await importOriginal<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return {
    ...actual,
    activeWorkspaceId: () => h.ws,
    backgroundWorkspaceIds: () => [h.ws],
  };
});
vi.mock('../events/await/engine', async (importOriginal) => {
  h.engineLoads += 1;
  return importOriginal<typeof import('../events/await/engine')>();
});

const taskStore = await import('./store');
const { taskTerminalEventKey } = await import('./task-terminal-events');
const { createOrgTestDb } = await import('../../test/_org-test-db');

describe('task terminal cold awaited-event bridge (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('persists concurrent terminal events through the first lazy engine import', () => withActiveTestDeadline(async () => {
    // Refuse a warmed control: it cannot distinguish cold import failures.
    expect(h.engineLoads).toBe(0);
    const taskIds = ['task-terminal-cold-a', 'task-terminal-cold-b'];
    for (const taskId of taskIds) {
      await h.sql`
        INSERT INTO harness_shared.task_ledger (
          task_id, workspace_id, root_task_id, harness_slug, class, title,
          argv, launched_by, confined, state, detail
        ) VALUES (
          ${taskId}, ${h.ws}, ${taskId}, 'papercusp', 'bash-job', 'cold terminal',
          '[]'::jsonb, 'test-cold-owner', true, 'running', '{}'::jsonb
        )
      `;
    }

    await expect(Promise.all(taskIds.map((taskId) => taskStore.closeTask(taskId, {
      state: 'killed', exitCode: 137, exitReason: 'oom-kill',
    })))).resolves.toEqual([true, true]);
    expect(h.engineLoads).toBe(1);

    for (const taskId of taskIds) {
      const [task] = await h.sql`
        SELECT state, exit_code, exit_reason, ended_at
          FROM harness_shared.task_ledger WHERE task_id = ${taskId}
      `;
      expect(task).toMatchObject({ state: 'killed', exit_code: 137, exit_reason: 'oom-kill' });
      expect(task.ended_at).toBeTruthy();

      const eventKey = taskTerminalEventKey(taskId);
      const expectedPayload = {
        terminalEventRevision: 1,
        taskId, state: 'killed', exitCode: 137, exitReason: 'oom-kill',
        taskClass: 'bash-job', harness: 'papercusp', launchedBy: 'test-cold-owner',
      };
      expect(await h.sql`
        SELECT fire_count, last_payload, last_fired_by
          FROM harness_shared.event_key_fires
         WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${eventKey}
      `).toEqual([{
        fire_count: 1, last_payload: expectedPayload, last_fired_by: 'task-manager',
      }]);

      await expect(taskStore.closeTask(taskId, { state: 'exited', exitCode: 0 })).resolves.toBe(false);
      expect(await h.sql`
        SELECT fire_count FROM harness_shared.event_key_fires
         WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${eventKey}
      `).toEqual([{ fire_count: 1 }]);
    }
  }, {
    timeoutMs: 60_000,
    wallTimeoutMs: 600_000,
    onTiming: timing => console.info('COLD_TERMINAL_DEADLINE', JSON.stringify(timing)),
  }), 0); // The measured active deadline owns this test; preserve the cold import.
});
