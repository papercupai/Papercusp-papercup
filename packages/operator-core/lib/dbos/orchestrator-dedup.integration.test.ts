/**
 * orchestrator-dedup.integration.test.ts — plan harness-test-coverage-for-launch
 * P-008: double-dispatch dedup, proven against a REAL DBOS runtime.
 *
 * The dedup guarantee that keeps two orchestrators (the 30s tick + the on-settle
 * refill, or two operator instances) from running a feature's pipeline twice is
 * NOT pure code — it's DBOS's own behavior, so it can only be proven with a live
 * DBOS instance. `startFeaturePipeline` builds a deterministic workflow id
 * (`pipeline:<slug>:<feature>:e<epoch>`) and enqueues with that as the
 * `deduplicationID`; the queue's default `duplicationPolicy: 'reject'` throws
 * `DBOSQueueDuplicatedError` for the loser of a concurrent double-start, and
 * DBOS's once-and-only-once workflow-id semantics cover the sequential case — so
 * exactly ONE pipeline runs per (harness, feature, epoch). A new epoch is a fresh
 * lifetime (distinct id) and DOES run again.
 *
 * This is the first test in the repo to launch DBOS. It boots against a throwaway
 * database on the shared testcontainer (DBOS creates its own `dbos` schema there),
 * injects a counting fake runner (so no real agent spawns), and shuts DBOS down in
 * afterAll. The integration config runs files in separate processes, so the DBOS
 * singleton is isolated to this file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, teardownTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { SpineSchema } from '@papercusp/orchestrator/blueprint';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';

/**
 * The spine these dedup tests run against, declared INLINE and passed on
 * `PipelineInput.spine` rather than inherited from the engine's no-spine
 * fallback. What is under test is workflow-id dedup (one lifetime per
 * harness/feature/epoch), which needs only a decider that terminates; the
 * engine's DEFAULT blueprint is an unrelated product choice. Inheriting it made
 * these tests silently assert that choice — when the fallback was repointed to
 * the single-agent `coding-solo` spine (decider `worker`) on 2026-07-20, the
 * `role === 'director'` branch below stopped matching, the decision fell through
 * to `default: idle`, and every assertion read `last=IDLE` (EI-20631691687347174).
 */
const DEDUP_SPINE = SpineSchema.parse({
  decider: 'director',
  maxTurns: 10,
  edges: { DONE: { to: 'done' } },
  default: { to: 'idle' },
});

let DBOS: typeof DBOSType;
let startFeaturePipeline: typeof import('./orchestrator-workflow').startFeaturePipeline;
let adminUri: string;
let dbName: string;

// featureId → number of times the orchestrator (director) was asked to decide.
// One pipeline lifetime = exactly one decide that returns DONE.
const directorCalls: Record<string, number> = {};

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `dbos_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  const dbUrl = u.toString();

  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({
    name: 'papercusp-test',
    systemDatabaseUrl: dbUrl,
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: 'test-v1',
    runAdminServer: false, // avoid the :3001 admin-server EADDRINUSE on this box
  });

  // Register the workflow + queue (module-load side effect) AFTER setConfig,
  // BEFORE launch — mirrors lib/dbos/bootstrap.ts.
  const wf = await import('./orchestrator-workflow');
  startFeaturePipeline = wf.startFeaturePipeline;
  // Inject a fake runner: the director decides DONE immediately (one decide step,
  // terminal, no dispatch). No real agent spawns; no finalizer/settled hook wired.
  wf.setPipelineInvokeRunner(async (_slug, role, feature) => {
    if (role === 'director') {
      directorCalls[feature] = (directorCalls[feature] ?? 0) + 1;
      return { output: 'DONE', exitCode: 0 };
    }
    return { output: `ran ${role}`, exitCode: 0 };
  });

  await DBOS.launch();
}, 90_000);

afterAll(async () => {
  try {
    await DBOS.shutdown();
  } catch {
    /* best-effort */
  }
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('DBOS feature-pipeline dedup (P-008)', () => {
  it('two concurrent starts for the same (harness, feature, epoch) collapse to ONE pipeline', async () => {
    const input = { harnessSlug: 'sheets', featureId: 'F-DEDUP', epoch: 0, workspaceId: 'ws-1', spine: DEDUP_SPINE };

    // Two orchestrators race to start the same feature. The deterministic
    // workflow id + dedup 'reject' policy means one wins and the other's enqueue
    // is rejected — we tolerate the rejection via allSettled.
    const settled = await Promise.allSettled([
      startFeaturePipeline(input),
      startFeaturePipeline(input),
    ]);
    expect(settled.some((s) => s.status === 'fulfilled')).toBe(true);

    const workflowID = 'pipeline:sheets:F-DEDUP:e0';
    const result = await DBOS.getResult<string>(workflowID, 30);
    expect(result).toBe('pipeline-complete (last=DONE)');

    // The decisive assertion: the pipeline executed exactly once.
    expect(directorCalls['F-DEDUP']).toBe(1);
  }, 60_000);

  it('a different epoch is a fresh lifetime — distinct workflow id, runs again', async () => {
    const base = { harnessSlug: 'sheets', featureId: 'F-EPOCH', workspaceId: 'ws-1', spine: DEDUP_SPINE };

    const id0 = await startFeaturePipeline({ ...base, epoch: 0 });
    expect(await DBOS.getResult<string>(id0, 30)).toBe('pipeline-complete (last=DONE)');

    const id1 = await startFeaturePipeline({ ...base, epoch: 1 });
    expect(await DBOS.getResult<string>(id1, 30)).toBe('pipeline-complete (last=DONE)');

    expect(id0).not.toBe(id1);
    expect(directorCalls['F-EPOCH']).toBe(2); // two epochs → two independent pipelines
  }, 60_000);

  it('re-starting an already-completed pipeline (same id) does not re-run it', async () => {
    const input = { harnessSlug: 'sheets', featureId: 'F-REPLAY', epoch: 0, workspaceId: 'ws-1', spine: DEDUP_SPINE };

    const id = await startFeaturePipeline(input);
    expect(await DBOS.getResult<string>(id, 30)).toBe('pipeline-complete (last=DONE)');
    expect(directorCalls['F-REPLAY']).toBe(1);

    // A later re-dispatch within the same epoch must reuse the completed workflow,
    // not spawn a second one (DBOS once-and-only-once on the workflow id).
    await startFeaturePipeline(input).catch(() => {
      /* a duplicate may reject; the invariant we assert is "no second execution" */
    });
    await DBOS.getResult<string>(id, 30);
    expect(directorCalls['F-REPLAY']).toBe(1);
  }, 60_000);
});
