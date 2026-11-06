import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  clearAbandonedCheckpointRoutineFire,
  clearStaleReaperLastError,
  reapDeadExecutorWorkflows,
  startExecutorReaper,
  REAPER_LAST_ERROR_SOURCE,
} from './dbos-executor-reaper';

// Capture the tick fn `startExecutorReaper` registers with managedSetInterval, so a
// reap-tick failure can be invoked directly instead of waiting on a real interval —
// mirrors how the production code actually calls it (EI-3673 regression coverage).
let capturedTick: (() => void | Promise<void>) | null = null;
vi.mock('@papercusp/scheduled-registry', () => ({
  managedSetInterval: vi.fn((_name: string, _intervalMs: number, fn: () => void | Promise<void>) => {
    capturedTick = fn;
    return { stop: vi.fn() };
  }),
}));

type Call = { text: string; values: unknown[] };

function fakeSql(handler: (text: string, values: unknown[]) => unknown) {
  const calls: Call[] = [];
  const sqlFn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.from(strings).join('?');
    calls.push({ text, values });
    if (text.includes("r.metadata->'qualificationTransaction' AS qualification")) return [];
    return handler(text, values);
  };
  const unsafe = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    return handler(text, values);
  };
  // Production postgres.js supplies `begin`; keep the mock transaction-transparent
  // so unit tests continue to inspect the same statement stream. Real rollback
  // semantics are covered by dbos-executor-reaper-queue-liveness.integration.test.ts.
  Object.assign(sqlFn, {
    begin: async (run: (tx: typeof sqlFn) => unknown) => run(sqlFn),
    unsafe,
  });
  const sql = sqlFn as unknown as Sql;
  return { sql, calls };
}

describe('clearAbandonedCheckpointRoutineFire', () => {
  const input = {
    installSlug: 'papercusp',
    workspaceId: 'papercusp-workspace',
    routineId: 'rt_papercusp_green_checkpoint',
    workflowId: 'routine-fire-workflow-42',
    observedAtMs: 1_790_194_000_000,
  };

  it('clears only the exact pending green-checkpoint routineFire owned by the abandoned marker', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('UPDATE dbos.workflow_status')) return [{ workflow_uuid: input.workflowId }];
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(clearAbandonedCheckpointRoutineFire(sql, input)).resolves.toBe(true);

    const update = calls[0]!;
    expect(update.text).toContain('workflow_uuid = $1');
    expect(update.text).toContain("name = 'routineFire'");
    expect(update.text).toContain('deduplication_id = $2');
    expect(update.text).toContain("status IN ('PENDING', 'ENQUEUED')");
    expect(update.text).toContain('created_at <= $3');
    expect(update.text).toContain("r.target_role = 'system:green-checkpoint'");
    expect(update.values).toEqual([
      input.workflowId,
      `routine:${input.routineId}`,
      input.observedAtMs,
      input.routineId,
      input.installSlug,
      input.workspaceId,
    ]);
  });

  it('leaves a different/newer workflow row untouched', async () => {
    const { sql } = fakeSql(() => []);
    await expect(clearAbandonedCheckpointRoutineFire(sql, input)).resolves.toBe(false);
  });
});

describe('reapDeadExecutorWorkflows', () => {
  it('reaps stale routinesTick rows even when the stable executor id has fresh activity', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) return [{ workflow_uuid: 'sched-.routinesTick-old' }];
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 1 };
      throw new Error(`unexpected query: ${text}`);
    });

    const res = await reapDeadExecutorWorkflows(sql, 300_000, 90_000, 300_000);

    expect(res).toEqual({
      cancelled: 1,
      queuePurged: 0,
      requeuedRoutineIds: [],
      deadExecutorIds: [],
      staleWorkflowIds: ['sched-.routinesTick-old'],
    });
    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    expect(staleSelect.text).toContain("name IN ('routinesTick', 'routinesSweepTick')");
    expect(staleSelect.text).toContain("name = 'routineFire'");
    expect(staleSelect.text).toContain('created_at <');
    expect(staleSelect.text).toContain('NOT EXISTS');
    expect(staleSelect.text).toContain('dbos.operation_outputs');
    expect(staleSelect.text).toContain('workflow_deadline_epoch_ms');
  });

  it('reaps stale routineFire rows only when no DBOS operation output was recorded', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) {
        return [{ workflow_uuid: 'sched-.routineFire-no-step', requeue_routine_id: 'rt_scout' }];
      }
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 1 };
      if (text.includes('UPDATE harness_shared.routines')) return { count: 1 };
      throw new Error(`unexpected query: ${text}`);
    });

    const res = await reapDeadExecutorWorkflows(sql, 300_000, 90_000, 300_000);

    expect(res.cancelled).toBe(1);
    expect(res.staleWorkflowIds).toEqual(['sched-.routineFire-no-step']);
    expect(res.requeuedRoutineIds).toEqual(['rt_scout']);
    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    expect(staleSelect.text).toContain("name = 'routineFire'");
    expect(staleSelect.text).toContain("deduplication_id LIKE 'routine:%'");
    expect(staleSelect.text).toContain('substring(deduplication_id from 9)');
    expect(staleSelect.text).toContain('created_at <');
    expect(staleSelect.text).toContain('op.workflow_uuid = dbos.workflow_status.workflow_uuid');
    expect(staleSelect.text).toContain('op.function_id > 0');
    const requeueUpdate = calls.find((c) => c.text.includes('UPDATE harness_shared.routines'))!;
    expect(requeueUpdate.text).toContain('next_fire_at = LEAST');
    expect(requeueUpdate.text).toContain('dbos-executor-reaper');
    expect(requeueUpdate.values).toContainEqual(['rt_scout']);
  });

  it('uses immutable created_at for no-output workflow staleness because DBOS recovery refreshes started_at', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) {
        return [
          { workflow_uuid: 'sched-.routinesTick-recovered-no-step', requeue_routine_id: null },
          { workflow_uuid: 'sched-.routineFire-recovered-no-step', requeue_routine_id: 'rt_recovered' },
        ];
      }
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 2 };
      if (text.includes('UPDATE harness_shared.routines')) return { count: 1 };
      throw new Error(`unexpected query: ${text}`);
    });

    const res = await reapDeadExecutorWorkflows(sql, 300_000, 90_000, 300_000);

    expect(res.staleWorkflowIds).toEqual([
      'sched-.routinesTick-recovered-no-step',
      'sched-.routineFire-recovered-no-step',
    ]);
    expect(res.requeuedRoutineIds).toEqual(['rt_recovered']);
    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    expect(staleSelect.text).toContain("name IN ('routinesTick', 'routinesSweepTick')");
    expect(staleSelect.text).toContain("name = 'routineFire'");
    expect(staleSelect.text).toContain('created_at <');
    expect(staleSelect.text).not.toContain('COALESCE(started_at_epoch_ms, created_at)');
  });

  it('uses a longer no-output window for routineFire so active first steps can finish', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) return [];
      throw new Error(`unexpected query: ${text}`);
    });

    await reapDeadExecutorWorkflows(sql);

    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    const numericValues = staleSelect.values.filter((v): v is number => typeof v === 'number');
    const thresholdSpan = Math.max(...numericValues) - Math.min(...numericValues);
    expect(thresholdSpan).toBeGreaterThanOrEqual(20 * 60 * 1000);
  });

  it('fast-reaps orphaned no-output routineFire rows that have no live workflow_status sibling', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) {
        return [{ workflow_uuid: 'sched-.routineFire-orphaned-before-first-step', requeue_routine_id: 'rt_scout' }];
      }
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 1 };
      if (text.includes('UPDATE harness_shared.routines')) return { count: 1 };
      throw new Error(`unexpected query: ${text}`);
    });

    const res = await reapDeadExecutorWorkflows(sql, 300_000, 90_000, 25 * 60_000);

    expect(res.cancelled).toBe(1);
    expect(res.staleWorkflowIds).toEqual(['sched-.routineFire-orphaned-before-first-step']);
    expect(res.requeuedRoutineIds).toEqual(['rt_scout']);
    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    expect(staleSelect.text).not.toContain('workflow_queue');
    expect(staleSelect.text).toContain('op.function_id > 0');

    const numericValues = staleSelect.values.filter((v): v is number => typeof v === 'number');
    const createdAtChecks = numericValues.length;
    expect(createdAtChecks).toBeGreaterThanOrEqual(4);
  });

  it('WI-1416: the fast-orphan path is ENQUEUED-only — a PENDING fire is left to the long liveness windows', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) return [];
      throw new Error(`unexpected query: ${text}`);
    });

    await reapDeadExecutorWorkflows(sql);

    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    // Both the requeue CASE and the WHERE restrict the fast orphan heuristic to
    // ENQUEUED rows. PENDING fires are left to the long no-output window, explicit
    // deadline, or dead-executor path.
    const enqueuedGuards = staleSelect.text.match(/status = 'ENQUEUED'/g) ?? [];
    expect(enqueuedGuards.length).toBe(2);
    // …and each guard rides its OWN longer orphan window, not the 90s scheduler one.
    const numericValues = staleSelect.values.filter((v): v is number => typeof v === 'number');
    const now = Math.max(...numericValues);
    const distinctWindows = new Set(numericValues.map((v) => now - v));
    expect(distinctWindows.has(10 * 60 * 1000)).toBe(true); // default orphan window (env-tunable)
  });

  it('WI-1416: a reaped git-sync fire INCREMENTS reaped_count on the routine metadata (consecutive-reap signal)', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) {
        return [{ workflow_uuid: 'sched-.routineFire-gitsync', requeue_routine_id: 'rt_gitsync' }];
      }
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 1 };
      if (text.includes('UPDATE harness_shared.routines')) return { count: 1 };
      throw new Error(`unexpected query: ${text}`);
    });

    const res = await reapDeadExecutorWorkflows(sql, 300_000, 90_000, 300_000);

    expect(res.requeuedRoutineIds).toEqual(['rt_gitsync']);
    const requeueUpdate = calls.find((c) => c.text.includes('UPDATE harness_shared.routines'))!;
    expect(requeueUpdate.text).toContain("'reaped_count'");
    expect(requeueUpdate.text).toContain("COALESCE((metadata->>'reaped_count')::int, 0) + 1");
    expect(requeueUpdate.text).toContain("target_role = 'system:git-sync'");
    expect(requeueUpdate.text).toContain("'git_sync_history'");
    expect(requeueUpdate.text).toContain("'status', 'reaped'");
    expect(requeueUpdate.text).toContain("'dirty_path_count', NULL");
    expect(requeueUpdate.text).toContain("'committed_count', NULL");
    expect(requeueUpdate.text).toContain("'reaped', true");
    expect(requeueUpdate.text).toContain('WITH ORDINALITY');
    expect(requeueUpdate.text).toContain('LIMIT ?');
    expect(requeueUpdate.values).toContain(30);
  });

  it('deduplicates requeued routines from multiple no-output routineFire rows', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) {
        return [
          { workflow_uuid: 'sched-.routineFire-no-step-a', requeue_routine_id: 'rt_scout' },
          { workflow_uuid: 'sched-.routineFire-no-step-b', requeue_routine_id: 'rt_scout' },
          { workflow_uuid: 'sched-.routineFire-deadline', requeue_routine_id: null },
        ];
      }
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 3 };
      if (text.includes('UPDATE harness_shared.routines')) return { count: 1 };
      throw new Error(`unexpected query: ${text}`);
    });

    const res = await reapDeadExecutorWorkflows(sql, 300_000, 90_000, 300_000);

    expect(res.cancelled).toBe(3);
    expect(res.requeuedRoutineIds).toEqual(['rt_scout']);
    const requeueUpdate = calls.find((c) => c.text.includes('UPDATE harness_shared.routines'))!;
    expect(requeueUpdate.values).toContainEqual(['rt_scout']);
  });

  it('preserves the original dead-executor reap path and reports both classes', async () => {
    const { sql } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [{ executor_id: 'dead-exec' }];
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('executor_id = ANY')) return { count: 2 };
      if (text.includes('SELECT workflow_uuid')) return [{ workflow_uuid: 'expired-fire', requeue_routine_id: null }];
      if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 1 };
      throw new Error(`unexpected query: ${text}`);
    });

    const res = await reapDeadExecutorWorkflows(sql);

    expect(res.cancelled).toBe(3);
    expect(res.queuePurged).toBe(0);
    expect(res.requeuedRoutineIds).toEqual([]);
    expect(res.deadExecutorIds).toEqual(['dead-exec']);
    expect(res.staleWorkflowIds).toEqual(['expired-fire']);
  });

  it('fails soft and returns an empty result if the reap query errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sql } = fakeSql(() => {
      throw new Error('pg unavailable');
    });

    await expect(reapDeadExecutorWorkflows(sql)).resolves.toEqual({
      cancelled: 0,
      queuePurged: 0,
      requeuedRoutineIds: [],
      deadExecutorIds: [],
      staleWorkflowIds: [],
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  describe('EI-18752434722211671 — processStartedAtMs: a local-executor routineFire orphaned by a restart is reaped immediately, not after 185m', () => {
    it('reaps a no-output PENDING routineFire tagged executor_id=local when its created_at predates this process start, well inside the normal 185m window', async () => {
      const { sql, calls } = fakeSql((text) => {
        if (text.includes('SELECT executor_id')) return []; // the stable-id dead-executor path never sees it (see EI-18752434722211671)
        if (text.includes('SELECT workflow_uuid')) {
          return [{ workflow_uuid: 'sched-.routineFire-restart-orphan', requeue_routine_id: 'rt_papercusp_git_sync' }];
        }
        if (text.includes('UPDATE dbos.workflow_status') && text.includes('workflow_uuid = ANY')) return { count: 1 };
        if (text.includes('UPDATE harness_shared.routines')) return { count: 1 };
        throw new Error(`unexpected query: ${text}`);
      });

      // Default 185m no-output window would NOT reap this on its own — proves the
      // fast-reap here is genuinely coming from processStartedAtMs, not the window.
      const processStartedAtMs = Date.now() - 60_000; // this process booted 1 minute ago
      const res = await reapDeadExecutorWorkflows(sql, undefined, undefined, undefined, undefined, processStartedAtMs);

      expect(res.cancelled).toBe(1);
      expect(res.staleWorkflowIds).toEqual(['sched-.routineFire-restart-orphan']);
      expect(res.requeuedRoutineIds).toEqual(['rt_papercusp_git_sync']);
      const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
      expect(staleSelect.text).toContain("executor_id = 'local'");
      expect(staleSelect.values).toContain(true); // the hasProcessStartedAtMs gate param
      expect(staleSelect.values).toContain(processStartedAtMs);
    });

    it('does NOT widen reaping when processStartedAtMs is omitted (default behavior byte-for-byte unaffected)', async () => {
      const { sql, calls } = fakeSql((text) => {
        if (text.includes('SELECT executor_id')) return [];
        if (text.includes('SELECT workflow_uuid')) return []; // a fresh no-output fire, well inside every window, is left alone
        throw new Error(`unexpected query: ${text}`);
      });

      const res = await reapDeadExecutorWorkflows(sql);

      expect(res).toEqual({
        cancelled: 0,
        queuePurged: 0,
        requeuedRoutineIds: [],
        deadExecutorIds: [],
        staleWorkflowIds: [],
      });
      const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
      expect(staleSelect.text).toContain("executor_id = 'local'"); // the clause is present…
      expect(staleSelect.values).toContain(false); // …but gated off (hasProcessStartedAtMs=false)
    });
  });
});

describe('startExecutorReaper — the registered tick must genuinely AWAIT the reap (EI-3673)', () => {
  afterEach(() => {
    capturedTick = null;
    vi.restoreAllMocks();
  });

  it('a reap failure never throws/rejects out of startExecutorReaper (reapDeadExecutorWorkflows catches its own errors)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sql } = fakeSql(() => {
      throw new Error('pg unreachable — pool still reconnecting after restart');
    });

    expect(() => startExecutorReaper(sql)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forgotten boot reap settle

    // reapDeadExecutorWorkflows's own top-level try/catch logs this — proves the
    // failure was observed + handled, not silently lost.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reap pass failed (non-fatal)'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pg unreachable'));
  });

  it('the registered tick fn returns a REAL pending promise that resolves only once the reap actually completes', async () => {
    let releaseReap: (() => void) | null = null;
    const reapGate = new Promise<void>((resolve) => {
      releaseReap = resolve;
    });
    const { sql } = fakeSql(async (text) => {
      if (text.includes('SELECT executor_id')) {
        await reapGate; // block until the test releases it
        return [];
      }
      if (text.includes('SELECT workflow_uuid')) return [];
      return { count: 0 };
    });

    startExecutorReaper(sql, { intervalMs: 10_000 });
    expect(capturedTick).not.toBeNull();

    // Before EI-3673, `run()` returned `undefined` SYNCHRONOUSLY (a fire-and-forget
    // `void promise.then(onSuccess)`) — managedSetInterval's tick wrapper would have
    // seen the tick "complete" immediately, flipping its re-entrancy guard back off
    // and stamping `lastFireAt` before the reap had done any real work. Now the tick
    // fn returns the actual promise chain, so callers (the tick wrapper) genuinely
    // await it — provable here: the returned promise must NOT resolve while the
    // underlying query is still gated open.
    let resolved = false;
    const tickPromise = capturedTick!() as Promise<void>;
    void tickPromise.then(() => {
      resolved = true;
    });

    await new Promise((r) => setTimeout(r, 5)); // give the microtask queue a chance
    expect(resolved).toBe(false); // still awaiting the gated query — NOT settled early

    releaseReap!();
    await tickPromise;
    expect(resolved).toBe(true); // settles only once the real work finished
  });

  it('a SUCCESSFUL reap tick still resolves cleanly (no behavior change on the happy path)', async () => {
    const { sql } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) return [];
      return { count: 0 };
    });

    startExecutorReaper(sql);
    await new Promise((r) => setTimeout(r, 0));

    expect(capturedTick).not.toBeNull();
    await expect(capturedTick!()).resolves.toBeUndefined();
  });

  it('EI-18752434722211671: derives processStartedAtMs from process.uptime() by default and threads it into the reap query', async () => {
    const before = Date.now() - process.uptime() * 1000;
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) return [];
      return { count: 0 };
    });

    startExecutorReaper(sql);
    await new Promise((r) => setTimeout(r, 0));
    const after = Date.now() - process.uptime() * 1000;

    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    expect(staleSelect.values).toContain(true); // hasProcessStartedAtMs — always derived, never omitted
    const numericValues = staleSelect.values.filter((v): v is number => typeof v === 'number');
    // the derived process-start estimate must land in the [before, after] bracket
    // taken around the startExecutorReaper() call — proves it used process.uptime(),
    // not some other fixed/omitted value.
    expect(numericValues.some((v) => v >= before - 5 && v <= after + 5)).toBe(true);
  });

  it('EI-18752434722211671: an explicit opts.processStartedAtMs overrides the derived default', async () => {
    const explicit = 1_700_000_000_000;
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) return [];
      return { count: 0 };
    });

    startExecutorReaper(sql, { processStartedAtMs: explicit });
    await new Promise((r) => setTimeout(r, 0));

    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    expect(staleSelect.values).toContain(explicit);
  });

  // ── EI-19441859859931739 recurrence guards ──────────────────────────────
  // The two tests above proved the value was PLUMBED and landed in the right
  // RANGE — and a float satisfies a range check perfectly, which is exactly why
  // they were blind to the real defect for hours. `process.uptime()` returns a
  // FLOAT (seconds), so the derived epoch carried a fractional part
  // ("1785734149790.5593"); `created_at` is a BIGINT column, so Postgres
  // rejected the literal outright with `invalid input syntax for type bigint`
  // and aborted EVERY reap pass — logged at info as "non-fatal", so it read as
  // benign noise while the reaper cleaned up nothing. Range-correct is not
  // type-correct: assert the TYPE of what actually reaches the bind site.
  it('EI-19441859859931739: every numeric value bound into the reap query is an INTEGER (bigint-safe)', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) return [];
      return { count: 0 };
    });

    startExecutorReaper(sql);
    await new Promise((r) => setTimeout(r, 0));

    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    const numericValues = staleSelect.values.filter((v): v is number => typeof v === 'number');
    expect(numericValues.length).toBeGreaterThan(0);
    // listing the offenders (rather than a boolean) names the bad value on failure
    expect(numericValues.filter((v) => !Number.isInteger(v))).toEqual([]);
  });

  it('EI-19441859859931739: an explicit FLOAT processStartedAtMs is floored at the bind site, not passed through', async () => {
    // the exact value Postgres rejected in production
    const floatEpoch = 1_785_734_149_790.5593;
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT executor_id')) return [];
      if (text.includes('SELECT workflow_uuid')) return [];
      return { count: 0 };
    });

    startExecutorReaper(sql, { processStartedAtMs: floatEpoch });
    await new Promise((r) => setTimeout(r, 0));

    const staleSelect = calls.find((c) => c.text.includes('SELECT workflow_uuid'))!;
    expect(staleSelect.values).toContain(Math.floor(floatEpoch));
    expect(staleSelect.values).not.toContain(floatEpoch);
  });
});

describe('clearStaleReaperLastError', () => {
  it('strips the reaper marker keys (incl. reaped_count) with a SOURCE-SCOPED UPDATE (EI-5938)', async () => {
    const { sql, calls } = fakeSql(() => ({ count: 1 }));

    await clearStaleReaperLastError(sql, 'rt-loop-883');

    expect(calls).toHaveLength(1);
    const upd = calls[0];
    expect(upd.text).toContain('UPDATE');
    expect(upd.text).toContain('harness_shared.routines');
    expect(upd.text).toContain("- 'last_error'");
    expect(upd.text).toContain("- 'last_error_at'");
    expect(upd.text).toContain("- 'last_error_source'");
    // WI-1416: a completed dispatch also disproves the consecutive-reap counter.
    expect(upd.text).toContain("- 'reaped_count'");
    // SAFETY: the clear is scoped to the reaper source ONLY — a `runner`-sourced action
    // error and git-sync's own no-source error must be left intact, so a genuine wedge
    // still surfaces. The routine id + the source value are the only bound params.
    expect(upd.text).toContain("metadata->>'last_error_source' =");
    expect(upd.values).toEqual(['rt-loop-883', REAPER_LAST_ERROR_SOURCE]);
    expect(REAPER_LAST_ERROR_SOURCE).toBe('dbos-executor-reaper');
  });

  it('fails soft — never throws even if the UPDATE errors (it rides a live fire)', async () => {
    const { sql } = fakeSql(() => {
      throw new Error('pg unavailable');
    });
    await expect(clearStaleReaperLastError(sql, 'rt-x')).resolves.toBeUndefined();
  });
});
