// @vitest-environment node
/**
 * EI-25841466577299173: distinguish a first terminal-event import that overlaps
 * an unfinished notification dependency from the existing cold-engine control.
 * Observe Vitest's actual evaluated-module state; never preload/reset its graph
 * or replace the native module loader. A passing current-source witness does
 * not attribute the historical message-only TDZ.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { withActiveTestDeadline } from '../../test/_active-test-deadline';

const h = vi.hoisted(() => ({
  sql: null as unknown as postgres.Sql,
  ws: 'ws-task-terminal-overlap',
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
const { emitTaskTerminalEvent, taskTerminalEventKey } = await import('./task-terminal-events');
const { createOrgTestDb } = await import('../../test/_org-test-db');

type ModuleNode = { evaluated: boolean; promise?: unknown; exports?: unknown };
type WorkerState = {
  evaluatedModules: { getModulesByFile(path: string): Set<ModuleNode> | undefined };
};

function moduleState(relativePath: string) {
  const worker = (globalThis as unknown as { __vitest_worker__: WorkerState }).__vitest_worker__;
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  const nodes = [...(worker.evaluatedModules.getModulesByFile(path) ?? [])];
  return {
    present: nodes.length > 0,
    pending: nodes.some(node => Boolean(node.promise) && !node.evaluated),
    evaluated: nodes.some(node => node.evaluated),
    exportsCreated: nodes.some(node => Boolean(node.exports)),
  };
}

describe('task terminal overlapping initialization (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('persists the terminal event while the notification root is still initializing', () => withActiveTestDeadline(async () => {
    expect(h.engineLoads).toBe(0);
    expect(moduleState('../attention-notify.ts').evaluated).toBe(false);
    const taskId = 'task-terminal-overlap';
    await h.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, harness_slug, class, title,
        argv, launched_by, confined, state, detail
      ) VALUES (
        ${taskId}, ${h.ws}, ${taskId}, 'papercusp', 'bash-job', 'overlapping import',
        '[]'::jsonb, 'test-overlap-owner', true, 'running', '{}'::jsonb
      )
    `;

    // Attach both outcomes immediately: retain the original stack without an
    // unhandled rejection if the root fails before the event bridge catches it.
    const root = import('../connected-apps/alerts').then(
      value => ({ value, error: null }),
      error => ({ value: null, error: error instanceof Error ? error.stack || error.message : String(error) }),
    );
    let rootSettled = false;
    void root.then(() => { rootSettled = true; });
    let notification = moduleState('../attention-notify.ts');
    while (!notification.pending && !rootSettled) {
      await nextTurn();
      notification = moduleState('../attention-notify.ts');
    }
    const engine = moduleState('../events/await/engine.ts');
    console.info('TERMINAL_IMPORT_OVERLAP', JSON.stringify({ notification, engine, engineLoads: h.engineLoads }));

    try {
      // Fail closed if this process missed the partial-initialization window.
      expect(notification.pending).toBe(true);
      expect(notification.evaluated).toBe(false);
      expect(notification.exportsCreated).toBe(true);
      expect(engine.evaluated).toBe(false);
      const warnings: string[] = [];
      let emissionCalls = 0;
      await expect(taskStore.closeTask(taskId, {
        state: 'killed', exitCode: 137, exitReason: 'oom-kill',
      }, undefined, {
        emitTerminal: event => {
          emissionCalls += 1;
          const atEmission = {
            notification: moduleState('../attention-notify.ts'),
            engine: moduleState('../events/await/engine.ts'),
            engineLoads: h.engineLoads,
          };
          console.info('TERMINAL_IMPORT_AT_EMISSION', JSON.stringify(atEmission));
          expect(atEmission.notification.pending).toBe(true);
          expect(atEmission.notification.evaluated).toBe(false);
          expect(atEmission.engine.evaluated).toBe(false);
          return emitTaskTerminalEvent(event, { warn: value => { warnings.push(value); } });
        },
      })).resolves.toBe(true);
      const initialized = await root;
      expect(initialized.error).toBeNull();
      expect(initialized.value?.raiseConnectedAppAlert).toBeTypeOf('function');
      expect(warnings, warnings.join('\n')).toEqual([]);
      expect(emissionCalls).toBe(1);
      expect(h.engineLoads).toBe(1);
      expect(await h.sql`
        SELECT state, exit_code, exit_reason FROM harness_shared.task_ledger WHERE task_id = ${taskId}
      `).toEqual([{ state: 'killed', exit_code: 137, exit_reason: 'oom-kill' }]);
      const key = taskTerminalEventKey(taskId);
      expect(await h.sql`
        SELECT fire_count, last_payload FROM harness_shared.event_key_fires
         WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${key}
      `).toEqual([{
        fire_count: 1,
        last_payload: {
          taskId, state: 'killed', exitCode: 137, exitReason: 'oom-kill',
          taskClass: 'bash-job', harness: 'papercusp', launchedBy: 'test-overlap-owner',
        },
      }]);
    } finally {
      const outcome = await root;
      if (outcome.error) console.info('TERMINAL_IMPORT_ROOT_FAILURE', outcome.error);
    }
  }, {
    timeoutMs: 60_000,
    wallTimeoutMs: 600_000,
    onTiming: timing => console.info('TERMINAL_IMPORT_OVERLAP_DEADLINE', JSON.stringify(timing)),
  }), 0);
});
