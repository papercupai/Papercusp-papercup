import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { withActiveTestDeadline } from '../../test/_active-test-deadline';

const h = vi.hoisted(() => ({
  sql: null as unknown as postgres.Sql,
  ws: 'ws-task-terminal-enforce-overlap',
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

function initializationState() {
  return {
    store: moduleState('../connected-apps/store.ts'),
    spend: moduleState('../connected-apps/spend.ts'),
    enforce: moduleState('../connected-apps/enforce.ts'),
    engine: moduleState('../events/await/engine.ts'),
  };
}

function hasColdEnforcementRoot(state: ReturnType<typeof initializationState>) {
  return state.enforce.pending && !state.enforce.evaluated &&
    state.enforce.exportsCreated && !state.engine.present &&
    !state.engine.evaluated && !state.store.evaluated && !state.spend.evaluated;
}

// A separate file keeps this root order cold under Vitest's worker isolation.
// Reuse the real-PG/deadline fixtures from the alerts overlap guard. Observe
// the engine cache without wrapping its import in a mock: even a delegating
// factory can change the resolver's handling of a partially initialized graph.
// Do not reset a warmed module cache to manufacture this window.
describe('task terminal enforcement-provider overlap (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('persists the terminal event while the enforcement root initializes ahead of its providers', () => withActiveTestDeadline(async () => {
    const initial = initializationState();
    console.info('TERMINAL_ENFORCE_INITIAL', JSON.stringify(initial));
    expect(initial.engine.present).toBe(false);
    expect(initial.engine.evaluated).toBe(false);
    expect(initial.store.evaluated).toBe(false);
    expect(initial.spend.evaluated).toBe(false);
    const taskId = 'task-terminal-enforce-overlap';
    await h.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, harness_slug, class, title,
        argv, launched_by, confined, state, detail
      ) VALUES (
        ${taskId}, ${h.ws}, ${taskId}, 'papercusp', 'bash-job', 'enforcement overlap',
        '[]'::jsonb, 'test-enforce-overlap-owner', true, 'running', '{}'::jsonb
      )
    `;

    const root = import('../connected-apps/enforce').then(
      value => ({ value, error: null }),
      error => ({ value: null, error: error instanceof Error ? error.stack || error.message : String(error) }),
    );
    let rootSettled = false;
    void root.then(() => { rootSettled = true; });
    let partial = initializationState();
    while (!partial.enforce.pending && !rootSettled) {
      await nextTurn();
      partial = initializationState();
    }
    console.info('TERMINAL_ENFORCE_OVERLAP', JSON.stringify(partial));

    try {
      expect(hasColdEnforcementRoot(partial)).toBe(true);
      expect(partial.engine.present).toBe(false);
      expect(partial.engine.evaluated).toBe(false);
      const warnings: string[] = [];
      let emissionCalls = 0;
      await expect(taskStore.closeTask(taskId, {
        state: 'killed', exitCode: 137, exitReason: 'oom-kill',
      }, undefined, {
        emitTerminal: event => {
          emissionCalls += 1;
          const atEmission = initializationState();
          console.info('TERMINAL_ENFORCE_AT_EMISSION', JSON.stringify(atEmission));
          expect(hasColdEnforcementRoot(atEmission)).toBe(true);
          expect(atEmission.engine.present).toBe(false);
          expect(atEmission.engine.evaluated).toBe(false);
          return emitTaskTerminalEvent(event, { warn: value => { warnings.push(value); } });
        },
      })).resolves.toBe(true);
      const initialized = await root;
      expect(initialized.error).toBeNull();
      expect(initialized.value?.enforceAppKeyScope).toBeTypeOf('function');
      expect(warnings, warnings.join('\n')).toEqual([]);
      expect(emissionCalls).toBe(1);
      expect(moduleState('../events/await/engine.ts').evaluated).toBe(true);
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
          taskClass: 'bash-job', harness: 'papercusp', launchedBy: 'test-enforce-overlap-owner',
        },
      }]);
    } finally {
      const outcome = await root;
      if (outcome.error) console.info('TERMINAL_ENFORCE_ROOT_FAILURE', outcome.error);
    }
  }, {
    timeoutMs: 60_000,
    wallTimeoutMs: 600_000,
    onTiming: timing => console.info('TERMINAL_ENFORCE_DEADLINE', JSON.stringify(timing)),
  }), 0);
});
