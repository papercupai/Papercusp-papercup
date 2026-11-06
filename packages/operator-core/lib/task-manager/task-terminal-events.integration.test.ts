// @vitest-environment node
/**
 * CAP-CONTRACT-P003 task-terminal bridge proof against real Postgres.
 *
 * Exercises the production closeTask -> dynamic event-engine import -> await
 * store path. The unit tests pin the emitted tuple; this integration test pins
 * the cross-module persistence boundary and first-terminal exactly-once rule.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { formatJobLogEndMarker } from '../agent-tools/capability/bash-jobs';
import bashOutputTool from '../agent-tools/capability/bash_output';

const h = vi.hoisted(() => ({ sql: null as unknown as postgres.Sql, ws: 'ws-task-terminal' }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
  backgroundWorkspaceIds: () => [h.ws],
}));

const taskStore = await import('./store');
const eventStore = await import('../events/await/store');
const eventEngine = await import('../events/await/engine');
const { taskTerminalEventKey, emitTaskTerminalEvent } = await import('./task-terminal-events');
const { createOrgTestDb } = await import('../../test/_org-test-db');
const bashOutput = bashOutputTool as unknown as {
  handler: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

async function waitForEmission(eventKey: string, taskId = 'task-terminal-integration'): Promise<{
  fire: Record<string, any>;
  delivery: Record<string, any>;
}> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [fire] = await h.sql`
      SELECT fire_count, last_payload, last_fired_by
        FROM harness_shared.event_key_fires
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${eventKey}
    `;
    const [delivery] = await h.sql`
      SELECT payload, summary, source
        FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${eventKey}
    `;
    if (fire && delivery) return { fire, delivery };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const taskRows = await h.sql`
    SELECT state, exit_code, exit_reason, ended_at
      FROM harness_shared.task_ledger
     WHERE task_id = ${taskId}
  `;
  const fireRows = await h.sql`
    SELECT workspace_id, event_key, fire_count
      FROM harness_shared.event_key_fires
     WHERE event_key = ${eventKey}
  `;
  throw new Error(
    `task-terminal event did not fire for ${eventKey}; ` +
      `task=${JSON.stringify(taskRows)} fires=${JSON.stringify(fireRows)}`,
  );
}

describe('task terminal awaited-event bridge (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    // The test asserts durable queue creation, not host delivery. Disabling the
    // asynchronous pump keeps the proof deterministic and process-local.
    eventEngine.setAutoPumpEnabledForTests(false);
  }, 120_000);

  afterAll(async () => {
    eventEngine.setAutoPumpEnabledForTests(true);
    await db?.cleanup();
  });

  async function insertTask(taskId: string) {
    await h.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, harness_slug, class, title,
        argv, launched_by, confined, state, detail
      ) VALUES (${taskId}, ${h.ws}, ${taskId}, 'papercusp', 'bash-job', ${taskId},
        '[]'::jsonb, 'su-terminal-owner', true, 'running', '{}'::jsonb)
    `;
  }

  it('recovers persisted delivery failure after losing the closer and wakes the exact waiter once', async () => {
    const taskId = 'terminal-restart-retry';
    const eventKey = taskTerminalEventKey(taskId);
    await insertTask(taskId);
    await eventStore.registerAwait({ subscriberId: 'su-restart-waiter', eventKey, policy: 'wake' });
    await expect(taskStore.closeTask(taskId, { state: 'exited', exitCode: 7, exitReason: 'runner-log' }, undefined, {
      emitTerminal: event => emitTaskTerminalEvent(event, { emit: async () => { throw new Error('event backend unavailable'); }, warn: () => {} }),
    })).resolves.toBe(true);
    expect(await h.sql`SELECT state, exit_code, detail -> 'terminalEventPending' AS pending
      FROM harness_shared.task_ledger WHERE task_id = ${taskId}`)
      .toEqual([{ state: 'exited', exit_code: 7, pending: true }]);
    expect(await h.sql`SELECT event_key FROM harness_shared.event_key_fires WHERE event_key = ${eventKey}`).toHaveLength(0);
    // No closure-local memory or original emitter survives into this call.
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(1);
    const { fire, delivery } = await waitForEmission(eventKey);
    expect(fire.last_payload).toMatchObject({ taskId, state: 'exited', exitCode: 7, exitReason: 'runner-log' });
    expect(delivery.payload).toEqual(fire.last_payload);
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(0);
    expect(await h.sql`SELECT fire_count FROM harness_shared.event_key_fires WHERE event_key = ${eventKey}`)
      .toEqual([{ fire_count: 1 }]);
  });

  it('recovers a successful JOB END through BashOutput and wakes an already-armed exact waiter', async () => {
    const taskId = 'tskterminal1234';
    const bashJobId = 'bash-terminal-recovery';
    const scopeUnit = `pc-${taskId}.service`;
    const invocationId = 'terminal-recovery-invocation';
    const nonce = 'a'.repeat(64);
    const eventKey = taskTerminalEventKey(taskId);
    const stateDir = mkdtempSync(join(tmpdir(), 'bash-output-terminal-event-'));
    const logPath = join(stateDir, 'terminal.log');
    const fakeBin = join(stateDir, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    const fakeSystemctl = join(fakeBin, 'systemctl');
    writeFileSync(
      fakeSystemctl,
      '#!/bin/sh\nfor unit; do :; done\nprintf "Id=%s\\nLoadState=loaded\\nActiveState=active\\nResult=success\\nExecMainCode=0\\nExecMainStatus=0\\nInvocationID=terminal-recovery-invocation\\n" "$unit"\n',
    );
    chmodSync(fakeSystemctl, 0o755);
    writeFileSync(logPath, `successful output${formatJobLogEndMarker('completed', 0, Date.now(), {
      taskId, bashJobId, scopeUnit, invocationId, nonce,
    })}`);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    try {
      await insertTask(taskId);
      await h.sql`
        UPDATE harness_shared.task_ledger
           SET scope_unit = ${scopeUnit}, log_path = ${logPath},
               detail = ${JSON.stringify({ bashJobId, runnerMarkerNonceHash: nonce })}::jsonb
         WHERE task_id = ${taskId}
      `;
      await eventStore.registerAwait({
        subscriberId: 'su-bash-output-terminal-waiter', eventKey, policy: 'wake',
      });

      const result = await bashOutput.handler({ task_id: taskId }, {
        workspaceId: h.ws,
        stateDir,
        signal: new AbortController().signal,
        emit: () => {},
        role: 'su',
      });
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

      expect(result.isError).toBeUndefined();
      expect(payload).toMatchObject({
        task_id: taskId,
        status: 'completed',
        exit_code: 0,
        running: false,
        recovered_from_log_marker: true,
        recovered_from_live_runner_marker: true,
        ledger_state: 'exited',
        ledger_reconciled: true,
      });
      const { fire, delivery } = await waitForEmission(eventKey, taskId);
      expect(fire.last_payload).toMatchObject({
        taskId, state: 'exited', exitCode: 0, terminalEventRevision: 1,
      });
      expect(delivery.payload).toEqual(fire.last_payload);
      expect(await h.sql`SELECT state, exit_code FROM harness_shared.task_ledger WHERE task_id = ${taskId}`)
        .toEqual([{ state: 'exited', exit_code: 0 }]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('backfills an existing terminal row with no pending marker and no exact fire', async () => {
    const taskId = 'terminal-legacy-missing-fire';
    const eventKey = taskTerminalEventKey(taskId);
    await insertTask(taskId);
    await h.sql`UPDATE harness_shared.task_ledger SET state = 'exited', exit_code = 2, ended_at = now()
      WHERE task_id = ${taskId}`;
    await eventStore.registerAwait({ subscriberId: 'su-legacy-waiter', eventKey, policy: 'wake' });
    await expect(taskStore.recoverPendingTaskTerminalEvents('other-workspace')).resolves.toBe(0);
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(1);
    expect((await waitForEmission(eventKey)).fire.last_payload).toMatchObject({ taskId, state: 'exited', exitCode: 2 });
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(0);
  });

  it('retries a fail-soft latch failure so late exact waiters have durable fire evidence', async () => {
    const taskId = 'terminal-latch-write-failed';
    const eventKey = taskTerminalEventKey(taskId);
    await insertTask(taskId);
    await eventStore.registerAwait({ subscriberId: 'su-latch-waiter', eventKey, policy: 'wake' });
    await h.sql.unsafe(`CREATE FUNCTION harness_shared.reject_terminal_test_fire() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_key = 'task:terminal:terminal-latch-write-failed' THEN
        RAISE EXCEPTION 'injected terminal latch failure'; END IF; RETURN NEW; END $$`);
    await h.sql.unsafe(`CREATE TRIGGER reject_terminal_test_fire BEFORE INSERT OR UPDATE ON harness_shared.event_key_fires
      FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_terminal_test_fire()`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(taskStore.closeTask(taskId, { state: 'exited', exitCode: 0 })).resolves.toBe(true);
      expect(await h.sql`SELECT detail -> 'terminalEventPending' AS pending FROM harness_shared.task_ledger WHERE task_id = ${taskId}`)
        .toEqual([{ pending: true }]);
      expect(await h.sql`SELECT event_key FROM harness_shared.event_key_fires WHERE event_key = ${eventKey}`).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('injected terminal latch failure'));
    } finally {
      warn.mockRestore();
      await h.sql.unsafe('DROP TRIGGER reject_terminal_test_fire ON harness_shared.event_key_fires');
      await h.sql.unsafe('DROP FUNCTION harness_shared.reject_terminal_test_fire()');
    }
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(1);
    expect((await waitForEmission(eventKey)).fire.last_payload).toMatchObject({ taskId, state: 'exited', exitCode: 0 });
    // This is the unconditional evidence queried by events:await's late-registration latch.
    expect(await h.sql`SELECT fire_count FROM harness_shared.event_key_fires WHERE event_key = ${eventKey}`)
      .toEqual([{ fire_count: 1 }]);
    expect(await h.sql`SELECT count(*)::int AS count FROM harness_shared.event_wake_deliveries WHERE event_key = ${eventKey}`)
      .toEqual([{ count: 1 }]);
  });

  it('does not acknowledge a newer terminal tuple with an older in-flight emit', async () => {
    const taskId = 'terminal-upgrade-during-emit';
    await insertTask(taskId);
    await taskStore.closeTask(taskId, { state: 'ended_unobserved' }, undefined, { emitTerminal: async () => {
      await h.sql`UPDATE harness_shared.task_ledger SET state = 'exited', exit_code = 9,
        exit_reason = 'late-runner-log' WHERE task_id = ${taskId}`;
    } });
    expect(await h.sql`SELECT detail -> 'terminalEventPending' AS pending FROM harness_shared.task_ledger WHERE task_id = ${taskId}`)
      .toEqual([{ pending: true }]);
    const emitted = vi.fn(async () => true);
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws, undefined, emitted)).resolves.toBe(1);
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ taskId, state: 'exited', exitCode: 9, exitReason: 'late-runner-log' }));
  });

  it('retains pending delivery when only the terminal revision changes during a successful emit', async () => {
    const taskId = 'terminal-revision-only-during-emit';
    const eventKey = taskTerminalEventKey(taskId);
    await insertTask(taskId);
    await expect(taskStore.closeTask(taskId, {
      state: 'exited', exitCode: 9, exitReason: 'runner-log',
    }, undefined, { emitTerminal: async event => {
      expect(event).toMatchObject({ revision: 1 });
      // Keep the tuple identical: only the SQL acknowledgement's revision
      // predicate can stop this successful older emission clearing pending.
      await h.sql`UPDATE harness_shared.task_ledger
        SET detail = detail || '{"terminalEventRevision":7}'::jsonb
        WHERE task_id = ${taskId}`;
      return true;
    } })).resolves.toBe(true);
    expect(await h.sql`SELECT state, exit_code, exit_reason,
      detail -> 'terminalEventRevision' AS revision, detail -> 'terminalEventPending' AS pending
      FROM harness_shared.task_ledger WHERE task_id = ${taskId}`)
      .toEqual([{ state: 'exited', exit_code: 9, exit_reason: 'runner-log', revision: 7, pending: true }]);
    const recovery = vi.fn(emitTaskTerminalEvent);
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws, undefined, recovery)).resolves.toBe(1);
    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      taskId, state: 'exited', exitCode: 9, exitReason: 'runner-log', revision: 7,
    }));
    expect(await h.sql`SELECT fire_count, last_payload -> 'terminalEventRevision' AS revision
      FROM harness_shared.event_key_fires WHERE event_key = ${eventKey}`)
      .toEqual([{ fire_count: 1, revision: 7 }]);
    expect(await h.sql`SELECT detail -> 'terminalEventPending' AS pending
      FROM harness_shared.task_ledger WHERE task_id = ${taskId}`).toEqual([{ pending: false }]);
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws, undefined, recovery)).resolves.toBe(0);
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it('retains the newer acknowledged tuple when an older recovery emission finishes last', async () => {
    const taskId = 'terminal-older-emission-finishes-last';
    const eventKey = taskTerminalEventKey(taskId);
    await insertTask(taskId);
    await taskStore.closeTask(taskId, { state: 'ended_unobserved' }, undefined, {
      emitTerminal: async () => false,
    });
    let releaseOlder!: () => void;
    let olderStarted!: () => void;
    const olderBlocked = new Promise<void>(resolve => { olderStarted = resolve; });
    const olderReleased = new Promise<void>(resolve => { releaseOlder = resolve; });
    let olderResult: boolean | undefined;
    const recovering = taskStore.recoverPendingTaskTerminalEvents(h.ws, undefined, async event => {
      if (event.taskId === taskId && event.state === 'ended_unobserved') {
        olderStarted();
        await olderReleased;
      }
      olderResult = await emitTaskTerminalEvent(event);
      return olderResult;
    });
    try {
      await olderBlocked;
      await expect(taskStore.closeTask(taskId, {
        state: 'exited', exitCode: 9, exitReason: 'definitive-runner-log',
      })).resolves.toBe(true);
      expect(await eventStore.getKeyFireLatch(eventKey)).toMatchObject({
        lastPayload: { state: 'exited', exitCode: 9, exitReason: 'definitive-runner-log' },
      });
      expect(await h.sql`SELECT detail -> 'terminalEventPending' AS pending
        FROM harness_shared.task_ledger WHERE task_id = ${taskId}`).toEqual([{ pending: false }]);
      // A stale resumed emitter must not consume a waiter registered after the
      // newer acknowledgement, including one with a payload filter.
      await eventStore.registerAwait({ subscriberId: 'su-newer-ack-waiter', eventKey, policy: 'wake',
        payloadFilter: { state: 'ended_unobserved' } });
    } finally {
      releaseOlder();
      await recovering;
    }
    expect(await eventStore.getKeyFireLatch(eventKey)).toMatchObject({
      lastPayload: { state: 'exited', exitCode: 9, exitReason: 'definitive-runner-log' },
      fireCount: 1,
    });
    expect(olderResult).toBe(false);
    expect(await h.sql`SELECT fired_at FROM harness_shared.event_awaits
      WHERE subscriber_id = 'su-newer-ack-waiter' AND event_key = ${eventKey}`)
      .toEqual([{ fired_at: null }]);
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(0);
  });

  it('does not claim new waiters when an accepted older latch resumes after a newer acknowledgement', async () => {
    const taskId = 'terminal-accepted-latch-resumes-last';
    const eventKey = taskTerminalEventKey(taskId);
    await insertTask(taskId);
    await taskStore.closeTask(taskId, { state: 'ended_unobserved' }, undefined, { emitTerminal: async () => false });
    let releaseOlder!: () => void;
    let olderLatched!: () => void;
    const latched = new Promise<void>(resolve => { olderLatched = resolve; });
    const released = new Promise<void>(resolve => { releaseOlder = resolve; });
    const shared = h.sql;
    let blockFirstLatch = true;
    h.sql = new Proxy(shared, {
      apply(target, thisArg, args) {
        const query = Reflect.apply(target, thisArg, args);
        if (blockFirstLatch && args[0].join('').includes('WITH current_terminal AS MATERIALIZED')) {
          blockFirstLatch = false;
          return query.then(async (rows: unknown) => {
            olderLatched();
            await released;
            return rows;
          });
        }
        return query;
      },
    });
    const recovering = taskStore.recoverPendingTaskTerminalEvents(h.ws);
    try {
      await latched;
      await taskStore.closeTask(taskId, { state: 'exited', exitCode: 4, exitReason: 'newer-after-latch' });
      for (const [subscriberId, key, payloadFilter] of [
        ['su-post-latch-unfiltered', eventKey, undefined],
        ['su-post-latch-filtered', eventKey, { state: 'ended_unobserved' }],
        ['su-post-latch-pattern', 'task:terminal:*', { taskId, state: 'ended_unobserved' }],
      ] as const) {
        await eventStore.registerAwait({ subscriberId, eventKey: key, policy: 'wake', payloadFilter });
      }
    } finally {
      releaseOlder();
      await recovering;
      h.sql = shared;
    }
    expect(await eventStore.getKeyFireLatch(eventKey)).toMatchObject({
      lastPayload: { state: 'exited', exitCode: 4, terminalEventRevision: 2 }, fireCount: 2,
    });
    expect(await h.sql`SELECT fired_at FROM harness_shared.event_awaits
      WHERE subscriber_id LIKE 'su-post-latch-%' ORDER BY subscriber_id`)
      .toEqual([{ fired_at: null }, { fired_at: null }, { fired_at: null }]);
    expect(await h.sql`SELECT detail -> 'terminalEventPending' AS pending
      FROM harness_shared.task_ledger WHERE task_id = ${taskId}`).toEqual([{ pending: false }]);
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(0);
  });

  it('rereads a newer terminal value after the recovery candidate snapshot', async () => {
    const taskId = 'terminal-stale-candidate-snapshot';
    await insertTask(taskId);
    await taskStore.closeTask(taskId, { state: 'ended_unobserved' }, undefined, { emitTerminal: async () => false });
    const snapshotSql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = h.sql(parts, ...values as never[]);
      if (!parts.join('').includes('LIMIT 100')) return query;
      return query.then(async rows => {
        await taskStore.closeTask(taskId, { state: 'exited', exitCode: 6, exitReason: 'newer-canonical' },
          undefined, { emitTerminal: async () => false });
        return rows;
      });
    }) as unknown as postgres.Sql;
    const emitted = vi.fn(async () => true);
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws, snapshotSql, emitted)).resolves.toBe(1);
    expect(emitted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      taskId, state: 'exited', exitCode: 6, exitReason: 'newer-canonical', revision: 2,
    }));
  });

  it('rejects stale generations before the first latch or waiter claim, then retries the latest', async () => {
    const taskId = 'terminal-stale-before-first-latch';
    const eventKey = taskTerminalEventKey(taskId);
    await insertTask(taskId);
    let stale: Parameters<typeof emitTaskTerminalEvent>[0] | undefined;
    await taskStore.closeTask(taskId, { state: 'ended_unobserved' }, undefined, {
      emitTerminal: async event => { stale = event; return false; },
    });
    await taskStore.closeTask(taskId, { state: 'exited', exitCode: 3 }, undefined, { emitTerminal: async () => false });
    await eventStore.registerAwait({ subscriberId: 'su-stale-generation-waiter', eventKey, policy: 'wake' });
    await expect(emitTaskTerminalEvent(stale!)).resolves.toBe(false);
    expect(await eventStore.getKeyFireLatch(eventKey)).toBeNull();
    expect(await h.sql`SELECT fired_at FROM harness_shared.event_awaits
      WHERE subscriber_id = 'su-stale-generation-waiter' AND event_key = ${eventKey}`)
      .toEqual([{ fired_at: null }]);
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(1);
    expect((await waitForEmission(eventKey)).delivery.payload).toMatchObject({ state: 'exited', exitCode: 3 });
  });

  it('delivers through the engine with one shared pool connection', async () => {
    const taskId = 'terminal-single-connection';
    const shared = h.sql;
    const single = postgres(db.adminDsn, { max: 1, prepare: false });
    try {
      h.sql = single;
      await insertTask(taskId);
      await expect(taskStore.closeTask(taskId, { state: 'exited', exitCode: 0 })).resolves.toBe(true);
      expect(await eventStore.getKeyFireLatch(taskTerminalEventKey(taskId))).toMatchObject({
        lastPayload: { taskId, state: 'exited', terminalEventRevision: 1 },
      });
    } finally {
      h.sql = shared;
      await single.end({ timeout: 5 });
    }
  });

  it('fires and queues exactly one event after the first authoritative terminal update', async () => {
    const taskId = 'task-terminal-integration';
    const eventKey = taskTerminalEventKey(taskId);
    await h.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, harness_slug, class, title,
        argv, launched_by, confined, state, detail
      ) VALUES (
        ${taskId}, ${h.ws}, ${taskId}, 'papercusp', 'pty', 'integration PTY',
        '[]'::jsonb, 'su-terminal-owner', true, 'running', '{}'::jsonb
      )
    `;
    await eventStore.registerAwait({
      subscriberId: 'su-terminal-waiter',
      eventKey,
      policy: 'wake',
    });

    await expect(taskStore.closeTask(taskId, { state: 'exited', exitCode: 0 })).resolves.toBe(true);
    const { fire, delivery } = await waitForEmission(eventKey);
    expect(fire).toMatchObject({
      fire_count: 1,
      last_fired_by: 'task-manager',
      last_payload: {
        taskId,
        state: 'exited',
        exitCode: 0,
        exitReason: null,
        taskClass: 'pty',
        harness: 'papercusp',
        launchedBy: 'su-terminal-owner',
      },
    });

    const [awaitRow] = await h.sql`
      SELECT fired_at
        FROM harness_shared.event_awaits
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${eventKey}
    `;
    expect(awaitRow?.fired_at).toBeTruthy();
    expect(delivery).toEqual({
      payload: fire.last_payload,
      summary: `Managed pty task ${taskId} entered terminal state exited.`,
      source: 'task-manager',
    });

    // A competing/idempotent closer cannot write ended_at again, so it must
    // neither re-fire the latch nor queue a second delivery.
    await expect(taskStore.closeTask(taskId, { state: 'killed', exitReason: 'late close' })).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await h.sql`
      SELECT fire_count FROM harness_shared.event_key_fires
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${eventKey}
    `).toEqual([{ fire_count: 1 }]);
    expect(await h.sql`
      SELECT count(*)::int AS count FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${eventKey}
    `).toEqual([{ count: 1 }]);
  });
});
