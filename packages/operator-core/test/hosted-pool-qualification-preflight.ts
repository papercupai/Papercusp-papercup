/** Admission for the opt-in, private, real-provider qualification fixture (P-544). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { WorkspaceHostDesiredSpec, WorkspaceHostProviderConnection } from '@papercusp/deployment-driver';
import { validateWorkspaceHostCanaryAdmission,
  type WorkspaceHostCanaryAdmission } from '../lib/workspace-host/provisioning-runner';

export interface HostedPoolQualificationPreflight {
  environment: NodeJS.ProcessEnv;
  systemDatabaseUrl: string;
  artifact: string;
  expectedBundleSha256: string;
  sourceRevision: { expected: string; actual: string };
  desired: WorkspaceHostDesiredSpec;
  connection: WorkspaceHostProviderConnection;
  canary: WorkspaceHostCanaryAdmission;
  /** End workload early enough to finish the separately bounded teardown. */
  workloadDeadlineAt: string;
  teardownBudgetMs: number;
}

/** No provider, DBOS client or user is created until this entire preflight passes. */
export function assertHostedPoolQualificationPreflight(input: HostedPoolQualificationPreflight) {
  const env = input.environment;
  const workspaceId = env.PAPERCUSP_WORKSPACE ?? '';
  assert.match(workspaceId, /^test-runtime-[a-z0-9-]+$/, 'qualification requires an isolated workspace');
  assert.equal(env.PAPERCUSP_SKIP_PG_DISCOVERY, '1', 'PG discovery must remain disabled');
  assert.match(env.PAPERCUSP_PG_PORT ?? '', /^\d+$/, 'private PG port is required');
  assert.notEqual(env.PAPERCUSP_PG_PORT, '5432', 'shared PG is forbidden');
  const database = (value: string | undefined) => {
    assert.ok(value, 'private database URL is required');
    const url = new URL(value);
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'Postgres URL is required');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'PG must be loopback');
    assert.equal(url.port, env.PAPERCUSP_PG_PORT, 'database must use the private PG port');
    assert.ok(url.pathname.length > 1, 'database name is required');
    // Role-specific URLs may differ in credentials, never in database identity.
    return `${url.port}${url.pathname}`;
  };
  const identity = database(env.HARNESS_ADMIN_DATABASE_URL);
  assert.equal(database(env.DATABASE_URL), identity, 'application database differs');
  assert.equal(database(input.systemDatabaseUrl), identity, 'DBOS database differs');
  assert.equal(env.PAPERCUSP_DBOS_ENABLE, '1', 'qualification requires real DBOS');
  assert.equal(env.PAPERCUSP_BACKGROUND_WORKERS, '1', 'qualification requires a worker');
  assert.ok(input.canary, 'finite canary admission is required');
  assert.equal(env.DBOS__APPVERSION, `p544-${input.canary.runId}`, 'private DBOS version must match the run');
  const hooks = (globalThis as typeof globalThis & {
    __papercuspWorkspaceHostProvisioningHooks__?: { executor?: unknown };
  }).__papercuspWorkspaceHostProvisioningHooks__;
  assert.equal(hooks?.executor, undefined, 'a substituted provisioning executor cannot qualify');
  assert.match(input.expectedBundleSha256, /^[a-f0-9]{64}$/, 'exact artifact hash is required');
  assert.match(input.sourceRevision.expected, /^[a-f0-9]{40}$/, 'exact controller source revision is required');
  assert.equal(input.sourceRevision.actual, input.sourceRevision.expected, 'controller source differs from the candidate');
  const bundleSha256 = createHash('sha256').update(readFileSync(input.artifact)).digest('hex');
  assert.equal(bundleSha256, input.expectedBundleSha256, 'artifact differs from the admitted bundle');
  assert.equal(input.canary.workspaceId, workspaceId, 'canary must belong to the private workspace');
  assert.ok(Number.isSafeInteger(input.canary.maxSpendCents) && input.canary.maxSpendCents! > 0,
    'an explicit finite spend bound is required');
  assert.ok(Number.isSafeInteger(input.teardownBudgetMs) && input.teardownBudgetMs > 0,
    'a finite teardown budget is required');
  const workloadDeadline = Date.parse(input.workloadDeadlineAt);
  const teardownDeadline = Date.parse(input.canary.teardownDeadlineAt);
  assert.ok(Number.isFinite(workloadDeadline) && workloadDeadline > Date.now(), 'workload deadline has expired');
  assert.ok(Number.isFinite(teardownDeadline) && workloadDeadline + input.teardownBudgetMs <= teardownDeadline,
    'the fixed provider deadline must reserve the complete teardown budget');
  // The serving fixture also needs time to revoke its TEST user and stop private PG.
  // This is the absolute millisecond deadline written by the managed task launcher.
  const taskDeadline = Number(env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS);
  assert.ok(Number.isSafeInteger(taskDeadline) && taskDeadline >= teardownDeadline + 180_000,
    'the enclosing task must outlive cloud teardown and private runtime cleanup');
  validateWorkspaceHostCanaryAdmission({ workspaceId, desired: input.desired,
    connection: input.connection, canary: input.canary });
  return { workspaceId, bundleSha256, appVersion: env.DBOS__APPVERSION!, workloadDeadline, teardownDeadline };
}
