/**
 * WI-3519 regression — the fast-orphan reap branch must NOT cancel healthy
 * BACKLOGGED fires (proven against real PG) when liveness is inferred from
 * workflow_status siblings.
 *
 * THE BUG (2026-09-06): the deployed DBOS schema does not provide a queue-row
 * relation, so any direct dependency on it aborts the entire reap pass before
 * workflow_status liveness can be evaluated. Under queue-slot starvation
 * (routines-critical concurrency=2, two slow fires under host CPU pressure)
 * every git-sync fire waiting >10min must remain protected by live workflow_status
 * siblings and explicit deadlines rather than a missing optional relation.
 *
 * THE PROPERTY proven here: an over-window ENQUEUED routineFire is reaped ONLY
 * when its workflow_status queue is dead — no sibling on the same queue_name either actively
 * PENDING (recent updated_at) or recently drained to SUCCESS/ERROR. A healthy
 * backlog behind live workers is left alone; the reaper's own CANCELLED rows do
 * not count as liveness (they must not self-mask a genuinely wedged queue).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/dbos/dbos-executor-reaper-queue-liveness.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { reapDeadExecutorWorkflows } from './dbos-executor-reaper';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-reaper-liveness';
const HARNESS = 'papercup';

// Explicit windows so the test is deterministic and only the fast-orphan branch
// is in play: liveness 5m (all seeded executors stay "alive" via recent
// updated_at), scheduler 90s (no routinesTick rows seeded), no-output 60m
// (targets are younger), orphan 10m (targets are older).
const LIVENESS_MS = 5 * 60 * 1000;
const SCHEDULER_MS = 90 * 1000;
const NO_OUTPUT_MS = 60 * 60 * 1000;
const ORPHAN_MS = 10 * 60 * 1000;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  // Minimal dbos schema — exactly the columns reapDeadExecutorWorkflows touches.
  await sql`CREATE SCHEMA IF NOT EXISTS dbos`;
  await sql`
    CREATE TABLE IF NOT EXISTS dbos.workflow_status (
      workflow_uuid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      executor_id TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      deduplication_id TEXT,
      queue_name TEXT,
      workflow_deadline_epoch_ms BIGINT
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS dbos.operation_outputs (
      workflow_uuid TEXT NOT NULL,
      function_id INT NOT NULL,
      completed_at_epoch_ms BIGINT
    )`;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM dbos.workflow_status`;
  await sql`DELETE FROM dbos.operation_outputs`;
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS}`;
});

type WfSeed = {
  uuid: string;
  name?: string;
  status: 'ENQUEUED' | 'PENDING' | 'SUCCESS' | 'ERROR' | 'CANCELLED';
  queue: string;
  createdAgoMs: number;
  updatedAgoMs: number;
  dedup?: string | null;
  deadlineInMs?: number | null;
};

async function seedWf(w: WfSeed): Promise<void> {
  const now = Date.now();
  await sql`
    INSERT INTO dbos.workflow_status
      (workflow_uuid, name, status, executor_id, created_at, updated_at, deduplication_id, queue_name,
       workflow_deadline_epoch_ms)
    VALUES (
      ${w.uuid}, ${w.name ?? 'routineFire'}, ${w.status}, 'exec-live',
      ${now - w.createdAgoMs}, ${now - w.updatedAgoMs}, ${w.dedup ?? null}, ${w.queue},
      ${w.deadlineInMs == null ? null : now + w.deadlineInMs}
    )`;
}

async function seedRoutine(id: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
    VALUES (${id}, ${HARNESS}, 'git-sync', 'cron', '{}'::jsonb, 'su', TRUE, ${WS}, '{}'::jsonb)`;
}

/** The over-orphan-window ENQUEUED fire under test (no op outputs, no live sibling). */
async function seedBackloggedTarget(queue: string, routineId: string): Promise<string> {
  const uuid = `wf-target-${queue}`;
  await seedWf({
    uuid,
    status: 'ENQUEUED',
    queue,
    createdAgoMs: 15 * 60 * 1000, // past the 10m orphan window, below the 60m no-output window
    updatedAgoMs: 30 * 1000, // executor recently active → dead-executor branch stays out of play
    dedup: `routine:${routineId}`,
  });
  await seedRoutine(routineId);
  return uuid;
}

async function reap() {
  return reapDeadExecutorWorkflows(sql, LIVENESS_MS, SCHEDULER_MS, NO_OUTPUT_MS, ORPHAN_MS);
}

async function wfStatus(uuid: string): Promise<string> {
  const r = await sql<{ status: string }[]>`
    SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${uuid}`;
  return r[0]?.status ?? 'MISSING';
}

async function routineMeta(id: string): Promise<Record<string, unknown> | null> {
  const r = await sql<{ metadata: Record<string, unknown> | null }[]>`
    SELECT metadata FROM harness_shared.routines WHERE id = ${id}`;
  return r[0]?.metadata ?? null;
}

describe('routinesTick staleness is judged by step progress, not updated_at (EI-25221129396992808, real PG)', () => {
  // DBOS bumps workflow_status.updated_at only on a status transition, so a live
  // tick still checkpointing steps keeps a frozen updated_at. Reaping on updated_at
  // alone cancelled working ticks mid-run and blinded the routine-engine liveness
  // reader (false health-tick-stale pages).
  async function seedStep(uuid: string, functionId: number, completedAgoMs: number): Promise<void> {
    await sql`
      INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, completed_at_epoch_ms)
      VALUES (${uuid}, ${functionId}, ${Date.now() - completedAgoMs})`;
  }

  it('leaves a long-running tick alone while it is still checkpointing steps', async () => {
    await seedWf({ uuid: 'tick-working', name: 'routinesTick', status: 'PENDING', queue: 'q-tick', createdAgoMs: 200_000, updatedAgoMs: 200_000 });
    await seedStep('tick-working', 1, 195_000); // list-due-routines, long ago
    await seedStep('tick-working', 2, 10_000); // a routineFire step 10s ago: still progressing
    await reap();
    expect(await wfStatus('tick-working')).toBe('PENDING');
  });

  it('still reaps a tick whose last step checkpoint is older than the scheduler window (wedged)', async () => {
    await seedWf({ uuid: 'tick-wedged', name: 'routinesTick', status: 'PENDING', queue: 'q-tick', createdAgoMs: 200_000, updatedAgoMs: 200_000 });
    await seedStep('tick-wedged', 1, 195_000);
    await seedStep('tick-wedged', 2, 120_000); // silent for 120s > 90s window
    await reap();
    expect(await wfStatus('tick-wedged')).toBe('CANCELLED');
  });

  it('still reaps a tick past the window that never checkpointed a step', async () => {
    await seedWf({ uuid: 'tick-no-step', name: 'routinesTick', status: 'PENDING', queue: 'q-tick', createdAgoMs: 120_000, updatedAgoMs: 120_000 });
    await reap();
    expect(await wfStatus('tick-no-step')).toBe('CANCELLED');
  });
});

describe('routinesSweepTick is reaped only past the overlap guard window (WI-6554700010019234, real PG)', () => {
  // The sweep tick's first step (loop-rebase-sweep) is ONE DBOS step that legitimately
  // runs past the 90s scheduler window (measured 2026-10-21: up to 292s). Reaping it
  // there did not stop the step; it removed the PENDING row the overlap guard keys on,
  // so a second pass started concurrently, every pass slowed past 90s and was reaped,
  // and the sweep's later steps (incl. the plan-run executor recruiter) never ran.
  // These calls use the PRODUCTION default sweep window (no 6th/7th positional arg).
  async function reapWithDefaultSweepWindow() {
    return reapDeadExecutorWorkflows(sql, LIVENESS_MS, SCHEDULER_MS, NO_OUTPUT_MS, ORPHAN_MS);
  }

  it('leaves a sweep tick alone while its first long step is still inside the guard window', async () => {
    // 150s silent with no step checkpoint yet: past the 90s scheduler window, inside 5 min.
    await seedWf({ uuid: 'sweep-long-step', name: 'routinesSweepTick', status: 'PENDING', queue: 'q-sweep', createdAgoMs: 150_000, updatedAgoMs: 150_000 });
    await reapWithDefaultSweepWindow();
    expect(await wfStatus('sweep-long-step')).toBe('PENDING');
  });

  it('still reaps a dispatch routinesTick at the same age (the 90s window is unchanged for it)', async () => {
    await seedWf({ uuid: 'dispatch-same-age', name: 'routinesTick', status: 'PENDING', queue: 'q-tick', createdAgoMs: 150_000, updatedAgoMs: 150_000 });
    await reapWithDefaultSweepWindow();
    expect(await wfStatus('dispatch-same-age')).toBe('CANCELLED');
  });

  it('reaps a sweep tick once it has been silent past the guard window (wedged)', async () => {
    await seedWf({ uuid: 'sweep-wedged', name: 'routinesSweepTick', status: 'PENDING', queue: 'q-sweep', createdAgoMs: 7 * 60_000, updatedAgoMs: 7 * 60_000 });
    await reapWithDefaultSweepWindow();
    expect(await wfStatus('sweep-wedged')).toBe('CANCELLED');
  });

  it('honours an explicit sweep window override', async () => {
    await seedWf({ uuid: 'sweep-override', name: 'routinesSweepTick', status: 'PENDING', queue: 'q-sweep', createdAgoMs: 150_000, updatedAgoMs: 150_000 });
    await reapDeadExecutorWorkflows(sql, LIVENESS_MS, SCHEDULER_MS, NO_OUTPUT_MS, ORPHAN_MS, undefined, 120_000);
    expect(await wfStatus('sweep-override')).toBe('CANCELLED');
  });
});

describe('fast-orphan reap requires no live workflow_status sibling (WI-3519, real PG)', () => {
  it('leaves a backlogged ENQUEUED fire alone while a sibling PENDING worker is live on the queue', async () => {
    const target = await seedBackloggedTarget('q-live-pending', 'rt-live-pending');
    // The healthy-but-slow worker occupying a concurrency slot (recent updated_at).
    await seedWf({
      uuid: 'wf-worker',
      status: 'PENDING',
      queue: 'q-live-pending',
      createdAgoMs: 20 * 60 * 1000,
      updatedAgoMs: 2 * 60 * 1000,
    });

    const res = await reap();

    expect(res.staleWorkflowIds).not.toContain(target);
    expect(res.requeuedRoutineIds).not.toContain('rt-live-pending');
    expect(await wfStatus(target)).toBe('ENQUEUED');
    expect((await routineMeta('rt-live-pending'))?.reaped_count).toBeUndefined();
  });

  it('treats a long PENDING worker inside its explicit deadline as live even when workflow_status is old', async () => {
    const target = await seedBackloggedTarget('q-live-deadline', 'rt-live-deadline');
    // A green-checkpoint-like single step: its external log can progress for hours,
    // while DBOS does not refresh workflow_status until the step completes. Its
    // explicit deadline is the writer-owned liveness bound during that interval.
    await seedWf({
      uuid: 'wf-long-worker',
      status: 'PENDING',
      queue: 'q-live-deadline',
      createdAgoMs: 20 * 60 * 1000,
      updatedAgoMs: 20 * 60 * 1000,
      deadlineInMs: 90 * 60 * 1000,
    });

    const res = await reap();

    expect(res.staleWorkflowIds).not.toContain(target);
    expect(res.requeuedRoutineIds).not.toContain('rt-live-deadline');
    expect(await wfStatus(target)).toBe('ENQUEUED');
    expect((await routineMeta('rt-live-deadline'))?.reaped_count).toBeUndefined();
  });

  it('leaves a backlogged ENQUEUED fire alone when the queue recently drained a fire to SUCCESS', async () => {
    const target = await seedBackloggedTarget('q-live-drain', 'rt-live-drain');
    await seedWf({
      uuid: 'wf-drained',
      status: 'SUCCESS',
      queue: 'q-live-drain',
      createdAgoMs: 30 * 60 * 1000,
      updatedAgoMs: 3 * 60 * 1000,
    });

    const res = await reap();

    expect(res.staleWorkflowIds).not.toContain(target);
    expect(await wfStatus(target)).toBe('ENQUEUED');
  });

  it('reaps + requeues the fire when the queue is genuinely dead (no live sibling, no recent drain)', async () => {
    const target = await seedBackloggedTarget('q-dead', 'rt-q-dead');

    const res = await reap();

    expect(res.staleWorkflowIds).toContain(target);
    expect(res.requeuedRoutineIds).toContain('rt-q-dead');
    expect(await wfStatus(target)).toBe('CANCELLED');
    const meta = await routineMeta('rt-q-dead');
    expect(meta?.reaped_count).toBe(1);
    expect(String(meta?.last_error ?? '')).toContain('executor reaper cancelled the stuck fire');
  });

  it("the reaper's own CANCELLED rows are NOT liveness — a wedged queue full of prior cancels still reaps", async () => {
    const target = await seedBackloggedTarget('q-self-mask', 'rt-self-mask');
    // A fresh cancel from a prior sweep on the same queue must not read as "alive".
    await seedWf({
      uuid: 'wf-prior-cancel',
      status: 'CANCELLED',
      queue: 'q-self-mask',
      createdAgoMs: 25 * 60 * 1000,
      updatedAgoMs: 60 * 1000,
    });

    const res = await reap();

    expect(res.staleWorkflowIds).toContain(target);
    expect(await wfStatus(target)).toBe('CANCELLED');
  });

  it('rolls back workflow cancellation when the routine requeue write fails', async () => {
    const routineId = 'rt-atomic-requeue';
    const target = await seedBackloggedTarget('q-atomic-requeue', routineId);
    // Force the metadata UPDATE to fail after the workflow UPDATE has executed.
    // Without one transaction, the target is left CANCELLED and the routine is
    // still scheduled for its next normal cadence — the production 17:15 loss.
    await sql`
      UPDATE harness_shared.routines
         SET metadata = jsonb_build_object('reaped_count', 'not-an-integer')
       WHERE id = ${routineId}`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await reap();
      const rows = await sql<{ status: string; deduplication_id: string | null }[]>`
        SELECT status, deduplication_id
          FROM dbos.workflow_status
         WHERE workflow_uuid = ${target}`;

      expect(res.cancelled).toBe(0);
      expect(res.staleWorkflowIds).toEqual([]);
      expect(rows[0]).toEqual({
        status: 'ENQUEUED',
        deduplication_id: `routine:${routineId}`,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[dbos-executor-reaper] reap pass failed'));
    } finally {
      warn.mockRestore();
    }
  });
});
