/** Shared amend receipts must survive module/worker boundaries in real Postgres. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { hostname } from 'node:os';

const h = vi.hoisted(() => ({ sql: null as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...await orig<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../workspace-registry');
const { trackAmendRun, getAmendReceipt } = await import('./amend-receipts');
const amendStatusTool = (await import('./amend-status')).default;
const { readProcessIdentity } = await import('../../process-identity');
const { flushFallbackObservations } = await import('../../degradation/fallback-observations');
let db: Awaited<ReturnType<typeof createOrgTestDb>>;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);
afterAll(async () => {
  await flushFallbackObservations();
  await db?.cleanup();
});

describe('rubric amend receipts in shared Postgres', () => {
  it('persists running and committed results across fresh modules, and reserves a key once', async () => {
    const key = 'shared-receipt-integration';
    const rubric = 'acceptance-receipt-integration';
    let release!: (value: Record<string, unknown>) => void;
    const work = new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
    let started!: () => void;
    const startedWork = new Promise<void>((resolve) => { started = resolve; });
    let executions = 0;
    const first = trackAmendRun(key, rubric, () => {
      executions++;
      started();
      return work;
    });
    await startedWork;

    vi.resetModules();
    const otherWorker = await import('./amend-receipts');
    expect(await otherWorker.getAmendReceipt(rubric, key)).toMatchObject({ state: 'running' });
    const retry = await otherWorker.trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: true };
    });
    expect(retry).toMatchObject({ pending: true, idempotencyKey: key });
    expect(executions).toBe(1);

    release({ ok: true, rubric: { id: rubric } });
    await first;
    expect(await getAmendReceipt(rubric, key)).toMatchObject({
      state: 'committed', result: { ok: true, rubric: { id: rubric } },
    });
    const rows = await db.adminSql<{ workspace_id: string; state: string }[]>`
      SELECT workspace_id, state FROM harness_shared.rubric_amend_receipts
       WHERE idempotency_key = ${key}
    `;
    expect(rows).toEqual([{ workspace_id: activeWorkspaceId(), state: 'committed' }]);
  });

  it('shares timestamped preview progress across fresh modules and preserves exact terminal replay', async () => {
    const key = 'preview-shared-progress-integration';
    const rubric = 'acceptance-preview-progress-integration';
    let release!: (value: Record<string, unknown>) => void;
    const work = new Promise<Record<string, unknown>>(resolve => { release = resolve; });
    let started!: () => void;
    const startedWork = new Promise<void>(resolve => { started = resolve; });
    let reportPhase!: (phase: string) => void;
    const result = { ok: true, dryRun: true, review: { state: 'routed', conversationId: 'conv-pg-progress' } };
    const first = trackAmendRun(key, rubric, onPhase => {
      reportPhase = onPhase;
      onPhase('review-route');
      started();
      return work;
    }, { persistPreviewProgress: true });
    try {
      await startedWork;
      vi.resetModules();
      const otherWorker = await import('./amend-receipts');
      await vi.waitFor(async () => expect(await otherWorker.getAmendReceipt(rubric, key)).toMatchObject({
        state: 'running', progress: { phase: 'review-route', phaseStartedAt: expect.any(Number), observedAt: expect.any(Number) },
      }));
      const snapshot = (await otherWorker.getAmendReceipt(rubric, key))!.progress;
      expect((await otherWorker.getAmendReceipt(rubric, key))!.progress).toEqual(snapshot);
      reportPhase('review-launch');
      await vi.waitFor(async () => expect(await otherWorker.getAmendReceipt(rubric, key)).toMatchObject({
        progress: { phase: 'review-launch' },
      }));
      const duplicate = vi.fn(async () => ({ ok: false, duplicate: true }));
      expect(await otherWorker.trackAmendRun(key, rubric, duplicate, { persistPreviewProgress: true }))
        .toMatchObject({ pending: true, receipt: { progress: { phase: 'review-launch' } } });
      expect(duplicate).not.toHaveBeenCalled();
      release(result);
      expect(await first).toEqual(result);
      expect(await otherWorker.getAmendReceipt(rubric, key)).toMatchObject({ state: 'previewed', result });
      expect((await otherWorker.getAmendReceipt(rubric, key))!.progress).toBeUndefined();
      expect(await otherWorker.trackAmendRun(key, rubric, duplicate, { persistPreviewProgress: true })).toEqual(result);
      expect(duplicate).not.toHaveBeenCalled();
    } finally {
      release(result);
      await first;
    }
  });

  it.each(['success', 'failure'])('a superseded preview cannot publish its terminal %s over a newer attempt', async outcome => {
    const key = `preview-superseded-${outcome}`;
    const rubric = 'acceptance-preview-superseded';
    let release!: (value: Record<string, unknown>) => void;
    let fail!: (error: Error) => void;
    const work = new Promise<Record<string, unknown>>((resolve, reject) => { release = resolve; fail = reject; });
    let started!: () => void;
    const startedWork = new Promise<void>(resolve => { started = resolve; });
    const first = trackAmendRun(key, rubric, onPhase => {
      onPhase('review-route');
      started();
      return work;
    }, { persistPreviewProgress: true }).catch((error: unknown) => error);
    try {
      await startedWork;
      await vi.waitFor(async () => expect(await getAmendReceipt(rubric, key))
        .toMatchObject({ progress: { phase: 'review-route' } }));
      const nextAttempt = { _progressRun: 'superseding-attempt',
        progress: { phase: 'review-new-attempt', phaseStartedAt: 123, observedAt: 123 } };
      await h.sql`UPDATE harness_shared.rubric_amend_receipts
        SET result_json = ${JSON.stringify(nextAttempt)}::text::jsonb
        WHERE workspace_id = ${activeWorkspaceId()} AND rubric_ref = ${rubric} AND idempotency_key = ${key}`;
      if (outcome === 'failure') fail(new Error('old preview failed'));
      else release({ ok: true, dryRun: true });
      const settled = await first;
      if (outcome === 'failure') expect(settled).toBeInstanceOf(Error);
      else expect(settled).toEqual({ ok: true, dryRun: true });
      expect(await getAmendReceipt(rubric, key)).toMatchObject({
        state: 'running', progress: nextAttempt.progress,
      });
      const rows = await h.sql<{ result_json: Record<string, unknown> }[]>`
        SELECT result_json FROM harness_shared.rubric_amend_receipts
        WHERE workspace_id = ${activeWorkspaceId()} AND rubric_ref = ${rubric} AND idempotency_key = ${key}`;
      expect(rows[0]!.result_json).toEqual(nextAttempt);
    } finally {
      release({ ok: true, dryRun: true });
      await first;
    }
  });

  // EI-26711589178349168: a pending foreground response cannot hide a late failure.
  it('preserves the last phase and a durable failure signal after a pending response', async () => {
    const key = 'late-failure-phase-evidence';
    const rubric = 'acceptance-late-failure-evidence';
    let rejectWork!: (error: Error) => void;
    const work = new Promise<Record<string, unknown>>((_resolve, reject) => { rejectWork = reject; });
    let started!: () => void;
    const startedWork = new Promise<void>((resolve) => { started = resolve; });
    const first = trackAmendRun(key, rubric, (onPhase) => {
      onPhase('acceptance-contract-snapshot');
      started();
      return work;
    });
    const outcome = first.catch((error: unknown) => error);
    await startedWork;
    expect(await trackAmendRun(key, rubric, async () => ({ ok: true, duplicate: true })))
      .toMatchObject({ pending: true });
    rejectWork(new Error('write CONNECTION_CLOSED 127.0.0.1:6432'));
    expect(await outcome).toBeInstanceOf(Error);

    const receipt = await getAmendReceipt(rubric, key);
    expect(receipt).toMatchObject({
      state: 'failed', error: 'write CONNECTION_CLOSED 127.0.0.1:6432',
      result: { ok: false, failure: {
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/), rubricRef: rubric, idempotencyKey: key,
        phase: 'acceptance-contract-snapshot', executorPid: process.pid,
        elapsedMs: expect.any(Number), phaseElapsedMs: expect.any(Number),
      } },
    });
    const correlationId = (receipt!.result!.failure as { correlationId: string }).correlationId;
    await flushFallbackObservations();
    const signals = await db.adminSql<{ eligible: number; applied: number; reason: string }[]>`
      SELECT eligible, applied, reason FROM harness_shared.fallback_observations
       WHERE workspace_id = ${activeWorkspaceId()} AND correlation_id = ${correlationId}
         AND scope = 'rubrics:amend:execute'`;
    expect(signals).toEqual([{ eligible: 1, applied: 0, reason: 'error' }]);
  });

  // EI-24680663429090445: retry the failed request rather than replaying its error.
  it('re-runs a same-key retry after a failure instead of replaying the stored error', async () => {
    const key = 'failed-receipt-rerun';
    const rubric = 'acceptance-receipt-rerun';
    let executions = 0;
    await expect(trackAmendRun(key, rubric, async () => {
      executions++;
      throw new Error('acceptance_bar_revision_projection_unmapped:AUTO-BAR-R-10-P-004');
    })).rejects.toThrow('projection_unmapped');
    expect(await getAmendReceipt(rubric, key)).toMatchObject({ state: 'failed' });

    const retried = await trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: true, rubric: { id: rubric } };
    });
    expect(retried).toEqual({ ok: true, rubric: { id: rubric } });
    expect(executions).toBe(2);
    const receipt = await getAmendReceipt(rubric, key);
    expect(receipt).toMatchObject({ state: 'committed', result: { ok: true } });
    expect(receipt?.error).toBeUndefined();

    // A COMMITTED receipt still replays: only failures are re-run.
    const replayed = await trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: true, rerun: true };
    });
    expect(replayed).toEqual({ ok: true, rubric: { id: rubric } });
    expect(executions).toBe(2);
  });

  it('re-runs a stored ok:false result and lets exactly one of two concurrent retries run it', async () => {
    const key = 'failed-result-concurrent-rerun';
    const rubric = 'acceptance-receipt-concurrent';
    let executions = 0;
    expect(await trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: false, error: 'stale build refusal' };
    })).toEqual({ ok: false, error: 'stale build refusal' });
    expect(await getAmendReceipt(rubric, key)).toMatchObject({ state: 'failed', error: 'stale build refusal' });

    let release!: (value: Record<string, unknown>) => void;
    const work = new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
    let started!: () => void;
    const startedWork = new Promise<void>((resolve) => { started = resolve; });
    const first = trackAmendRun(key, rubric, () => {
      executions++;
      started();
      return work;
    });
    await startedWork;
    const second = await trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: true, duplicate: true };
    });
    expect(second).toMatchObject({ pending: true, idempotencyKey: key });
    release({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(executions).toBe(2);
    expect(await getAmendReceipt(rubric, key)).toMatchObject({ state: 'committed' });
  });

  it.each([true, false])('retries an unstaffed review with an outer ok:true (fresh launch detail: %s)', async (withFresh) => {
    const key = `unstaffed-review-${withFresh}`;
    const rubric = 'acceptance-receipt-unstaffed';
    let executions = 0;
    const failedPreview = {
      ok: true, dryRun: true, preview: { approvalRequired: true },
      review: {
        state: 'no-eligible-reviewer', reason: 'no_qualified_responder',
        ...(withFresh ? { freshReviewer: { state: 'not-launched', reason: 'headless spawn failed spawn E2BIG' } } : {}),
      },
    };
    expect(await trackAmendRun(key, rubric, async () => {
      executions++;
      return failedPreview;
    })).toEqual(failedPreview);
    expect(await getAmendReceipt(rubric, key)).toMatchObject({
      state: 'failed', result: failedPreview,
      error: withFresh ? 'headless spawn failed spawn E2BIG' : 'no eligible amendment reviewer was routed or launched',
    });
    const launched = {
      ...failedPreview,
      review: { state: 'no-eligible-reviewer', freshReviewer: { state: 'launched', taskId: 'fresh-1' } },
    };
    expect(await trackAmendRun(key, rubric, async () => {
      executions++;
      return launched;
    })).toEqual(launched);
    expect(await getAmendReceipt(rubric, key)).toMatchObject({ state: 'previewed', result: launched });
    // A successful fresh fallback is kept even though routing found nobody.
    expect(await trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: false, error: 'duplicate reviewer' };
    })).toEqual(launched);
    expect(executions).toBe(2);
  });

  it('re-runs a launched-reviewer preview once its task ended with no answer, but replays it while live or answered (WI-6554700010010527)', async () => {
    const ws = activeWorkspaceId();
    const rubric = 'acceptance-receipt-dead-reviewer';
    const thread = 'issue-thread-WI-dead-reviewer';
    await h.sql`INSERT INTO harness_shared.coord_thread_posts (id, thread_id, workspace_id) VALUES (990001, ${thread}, ${ws})`;
    const preview = (taskId: string) => ({
      ok: true, dryRun: true, preview: { approvalRequired: true },
      review: { state: 'no-eligible-reviewer', previewPostRef: 'thread-post:990001', freshReviewer: { state: 'launched', taskId } },
    });
    const ledger = (taskId: string, state: string) => h.sql`
      INSERT INTO harness_shared.task_ledger (task_id, workspace_id, root_task_id, class, title, launched_by, state)
      VALUES (${taskId}, ${ws}, ${taskId}, 'agent', 'bar-amendment-review', 'system:acceptance-bar-amendment-review', ${state})`;
    let executions = 0;
    const runWith = (key: string, result: Record<string, unknown>) =>
      trackAmendRun(key, rubric, async () => { executions++; return result; });

    // Live reviewer: replayed, never duplicated.
    await ledger('rev-live', 'running');
    await runWith('live', preview('rev-live'));
    expect(await runWith('live', { ok: false, error: 'duplicate reviewer' })).toEqual(preview('rev-live'));
    // Dead reviewer, nothing posted after the preview: the next same-key call RE-RUNS.
    await ledger('rev-dead', 'ended_unobserved');
    await runWith('dead', preview('rev-dead'));
    expect(await runWith('dead', preview('rev-new'))).toEqual(preview('rev-new'));
    expect(await getAmendReceipt(rubric, 'dead')).toMatchObject({ state: 'previewed', result: preview('rev-new') });
    // Dead reviewer that DID answer (a later post on the thread): replayed.
    await ledger('rev-answered', 'exited');
    await runWith('answered', preview('rev-answered'));
    await h.sql`INSERT INTO harness_shared.coord_thread_posts (id, thread_id, workspace_id) VALUES (990002, ${thread}, ${ws})`;
    expect(await runWith('answered', { ok: false, error: 'duplicate reviewer' })).toEqual(preview('rev-answered'));
    expect(executions).toBe(4);
  });

  it('atomically reclaims a legacy preview that started no reviewer across workers', async () => {
    const key = 'legacy-unstaffed-preview';
    const rubric = 'acceptance-receipt-legacy';
    const legacy = {
      ok: true, dryRun: true,
      review: { state: 'no-eligible-reviewer', freshReviewer: { state: 'not-launched', reason: 'spawn E2BIG' } },
    };
    await db.adminSql`
      INSERT INTO harness_shared.rubric_amend_receipts
        (workspace_id, rubric_ref, idempotency_key, state, result_json, finished_at)
      VALUES (${activeWorkspaceId()}, ${rubric}, ${key}, 'previewed', ${JSON.stringify(legacy)}::text::jsonb, now())
    `;
    let executions = 0;
    let release!: (value: Record<string, unknown>) => void;
    const work = new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
    let started!: () => void;
    const startedWork = new Promise<void>((resolve) => { started = resolve; });
    const first = trackAmendRun(key, rubric, () => {
      executions++;
      started();
      return work;
    });
    await startedWork;
    vi.resetModules();
    const otherWorker = await import('./amend-receipts');
    expect(await otherWorker.trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: true, duplicate: true };
    })).toMatchObject({ pending: true, idempotencyKey: key });
    const routed = { ok: true, dryRun: true, review: { state: 'routed', conversationId: 'review-1' } };
    release(routed);
    expect(await first).toEqual(routed);
    expect(executions).toBe(1);
    expect(await getAmendReceipt(rubric, key)).toMatchObject({ state: 'previewed', result: routed });
    expect(await trackAmendRun(key, rubric, async () => {
      executions++;
      return { ok: false, error: 'duplicate routed reviewer' };
    })).toEqual(routed);
    expect(executions).toBe(1);
  });

  it('keeps preview-only and no-review-required results replayable', async () => {
    let executions = 0;
    for (const [key, result] of [
      ['preview-only', { ok: true, dryRun: true, review: { state: 'not-requested' } }],
      ['review-not-required', { ok: true, dryRun: true, review: { state: 'not-required' } }],
    ] as const) {
      const rubric = 'acceptance-receipt-preview-controls';
      expect(await trackAmendRun(key, rubric, async () => {
        executions++;
        return result;
      })).toEqual(result);
      expect(await getAmendReceipt(rubric, key)).toMatchObject({ state: 'previewed' });
      expect(await trackAmendRun(key, rubric, async () => {
        executions++;
        return { ok: false };
      })).toEqual(result);
    }
    expect(executions).toBe(2);
  });

  // WI-10006937: an operator restart killed the worker mid-run, so its receipt stayed
  // 'running' with no finished_at. The key is deterministic, so every retry answered
  // `pending` forever and the review request could never be re-sent.
  it('reclaims a running receipt past its lease, but not one inside it', async () => {
    const { AMEND_RECEIPT_RUNNING_LEASE_MS } = await import('./amend-receipts');
    const rubric = 'acceptance-receipt-orphaned';
    const leaseSeconds = Math.round(AMEND_RECEIPT_RUNNING_LEASE_MS / 1000);
    const seedRunning = async (key: string, ageSeconds: number) => {
      await db.adminSql`
        INSERT INTO harness_shared.rubric_amend_receipts
          (workspace_id, rubric_ref, idempotency_key, state, started_at)
        VALUES (${activeWorkspaceId()}, ${rubric}, ${key}, 'running',
                now() - make_interval(secs => ${ageSeconds}))
      `;
    };
    let executions = 0;
    const run = async () => {
      executions++;
      return { ok: true, rerun: true };
    };

    // Control: a run still inside its lease is a live peer, so the retry must wait.
    await seedRunning('orphan-inside-lease', leaseSeconds - 60);
    expect(await trackAmendRun('orphan-inside-lease', rubric, run)).toMatchObject({ pending: true });
    expect(executions).toBe(0);

    await seedRunning('orphan-past-lease', leaseSeconds + 60);
    expect(await trackAmendRun('orphan-past-lease', rubric, run)).toEqual({ ok: true, rerun: true });
    expect(executions).toBe(1);
    expect(await getAmendReceipt(rubric, 'orphan-past-lease')).toMatchObject({ state: 'committed' });
  });

  it('reports a dead executor as orphaned and reclaims it before the lease', async () => {
    const ws = activeWorkspaceId();
    const rubric = 'acceptance-receipt-executor-identity';
    const liveKey = 'executor-live';
    const orphanKey = 'executor-orphan';
    const executorHost = hostname();
    const executorProcessId = readProcessIdentity(process.pid);
    expect(executorProcessId).toBeTruthy();
    await db.adminSql`
      INSERT INTO harness_shared.rubric_amend_receipts
        (workspace_id, rubric_ref, idempotency_key, state, executor_host, executor_pid, executor_process_id)
      VALUES (${ws}, ${rubric}, ${liveKey}, 'running', ${executorHost}, ${process.pid}, ${executorProcessId})
    `;
    const liveStatus = await amendStatusTool.handler(
      { rubricRef: rubric, idempotencyKey: liveKey }, {} as never,
    ) as { data: Record<string, unknown> };
    expect(liveStatus.data).toMatchObject({ state: 'running', source: 'receipt' });
    expect(await trackAmendRun(liveKey, rubric, async () => ({ ok: true, duplicate: true }))).toMatchObject({ pending: true });

    await db.adminSql`
      INSERT INTO harness_shared.rubric_amend_receipts
        (workspace_id, rubric_ref, idempotency_key, state, executor_host, executor_pid, executor_process_id)
      VALUES (${ws}, ${rubric}, ${orphanKey}, 'running', ${executorHost}, 99999999, 'linux:dead-boot:1')
    `;
    const orphanStatus = await amendStatusTool.handler(
      { rubricRef: rubric, idempotencyKey: orphanKey }, {} as never,
    ) as { data: Record<string, unknown> };
    expect(orphanStatus.data).toMatchObject({
      state: 'orphaned', source: 'receipt', reclaimableAt: expect.any(Number),
    });
    let executions = 0;
    expect(await trackAmendRun(orphanKey, rubric, async () => {
      executions++;
      return { ok: true, rerun: true };
    })).toEqual({ ok: true, rerun: true });
    expect(executions).toBe(1);
    expect(await getAmendReceipt(rubric, orphanKey)).toMatchObject({ state: 'committed' });
  });
});
