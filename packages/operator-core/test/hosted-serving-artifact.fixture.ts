/** Private hosted serving acceptance; real provider execution requires the separate explicit pool opt-in. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadIsolatedHostedTestUserKit } from '../lib/llm-testing/isolated-hosted-test-user.mts';

const root = resolve(import.meta.dirname, '../../..');
const secretFields = ['PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF', 'WORKOS_API_KEY_REF',
  'WORKOS_COOKIE_PASSWORD_REF', 'WORKOS_WEBHOOK_SECRET_REF'] as const;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let credentialStage = 'environment-parser-import';

async function credentials() {
  const { parseEnvFile } = await import('../../../scripts/lib/pg-url.mjs');
  credentialStage = 'operator-environment';
  const operator = Object.fromEntries(parseEnvFile(readFileSync(join(root, 'apps/operator/.env.local'), 'utf8')));
  // This process reads only the encrypted credential store; it never admits a user.
  Object.assign(process.env, operator);
  process.env.HARNESS_ADMIN_DATABASE_URL = operator.HARNESS_ADMIN_DATABASE_URL ?? operator.DATABASE_URL;
  process.env.DATABASE_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
  delete process.env.PAPERCUSP_DEPLOYMENT_ENVIRONMENT;
  const file = process.env.PAPERCUSP_TEST_HOSTED_SERVING_ENV_FILE
    ?? join(process.env.HOME!, '.config/papercusp/hosted-control-plane.env');
  credentialStage = 'hosted-environment';
  const configuration = Object.fromEntries(parseEnvFile(readFileSync(file, 'utf8')));
  credentialStage = 'secret-resolver-import';
  const { resolveHostedSecretRef } = await import('../lib/auth/hosted/secret-ref');
  const environment: Record<string, string> = {};
  for (const [index, field] of secretFields.entries()) {
    credentialStage = field;
    environment[`HOSTED_SERVING_SECRET_${index}`] = await resolveHostedSecretRef(configuration[field]);
  }
  credentialStage = 'test-key-validation';
  assert.match(environment.HOSTED_SERVING_SECRET_1, /^sk_test_/, 'WorkOS TEST credentials required');
  return { clientId: configuration.WORKOS_CLIENT_ID, environment };
}

async function acceptance() {
  assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.match(process.env.PAPERCUSP_WORKSPACE!, /^test-runtime-/);
  const admin = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
  assert.ok(['localhost', '127.0.0.1'].includes(admin.hostname));
  assert.equal(admin.port, process.env.PAPERCUSP_PG_PORT);
  assert.notEqual(admin.port, '5432');
  const configuration = JSON.parse(process.env.HOSTED_SERVING_TEST_CONFIGURATION!);
  Object.assign(process.env, configuration.environment);
  delete process.env.HOSTED_SERVING_TEST_CONFIGURATION;
  const artifact = resolve(process.env.HOSTED_SERVING_TEST_ARTIFACT!);
  const evidenceDir = process.env.HOSTED_SERVING_TEST_EVIDENCE_DIR!;
  const poolConfiguration = process.env.HOSTED_SERVING_TEST_POOL_CONFIGURATION
    ? JSON.parse(process.env.HOSTED_SERVING_TEST_POOL_CONFIGURATION) as
      import('./hosted-pool-qualification').HostedPoolQualificationConfiguration : undefined;
  const bundleSha256 = sha(readFileSync(artifact));
  const publicOrigin = 'https://p537-serving.example.test';
  const origin = `http://127.0.0.1:${process.env.PAPERCUSP_HONO_PORT}`;
  const hosted: Record<string, string> = { PAPERCUSP_HOSTED_PUBLIC_ORIGIN: publicOrigin,
    PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID: process.env.PAPERCUSP_WORKSPACE!,
    WORKOS_CLIENT_ID: configuration.clientId };
  secretFields.forEach((field, index) => { hosted[field] = `env:HOSTED_SERVING_SECRET_${index}`; });
  const envFile = join(process.env.HOME!, 'hosted-serving.env');
  writeFileSync(envFile, Object.entries(hosted).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  Object.assign(process.env, hosted, { PAPERCUSP_INTEGRATION_ROOT: root,
    PAPERCUSP_PORTAL_HOSTED_ENV_FILE: envFile, PORTAL_HOSTED_CONTROL_PLANE_ORIGIN: origin });
  const policy = JSON.stringify({ assignmentDurationMs: 86_400_000, bundle: {
    schemaVersion: 1, bundleId: 'p537-private-serving', bundleVersion: 1,
    record: { source: 'trial', actor: { kind: 'service', principalId: 'service:trial-policy' },
      auditReceiptId: 'trial-policy:p537-private-serving', effectiveFrom: '2020-01-01T00:00:00Z', effectiveUntil: null },
    entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 1, members: 1 },
      browserAccess: { pty: true, files: true }, supportTier: 'trial',
      quotas: { 'pool.agents': 50, 'pool.hosts': 1, 'pool.cpu-millicores': 4000,
        'pool.memory-mib': 16384, 'pool.db-gib': 256, 'pool.workspace-gib': 100 },
      budgets: { 'pool.cost.usd.minor': 10000 }, rolloutFlags: {} } } });
  const runtimeEnv: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_DISTRIBUTION_PROFILE: 'hosted-control-plane',
    PAPERCUSP_ENV_OPERATOR_ID: 'hosted-control-plane', PAPERCUSP_USE_EMBEDDED_PG: '0',
    PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_DBOS_ENABLE: '0', PAPERCUSP_DBOS_ORCHESTRATOR: '0',
    PAPERCUSP_HOSTED_TRIAL_ENTITLEMENT: policy };
  // A private request host must have no provisioning executor or rollout allowlist.
  delete runtimeEnv.DBOS__APPVERSION;
  delete runtimeEnv.PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION;
  delete runtimeEnv.PAPERCUSP_HOSTED_FIRST_WORKSPACE_ORGANIZATIONS;
  let host: ChildProcess | undefined;
  const processes: ChildProcess[] = [];
  let kit: Awaited<ReturnType<typeof loadIsolatedHostedTestUserKit>> | undefined;
  let user: Awaited<ReturnType<NonNullable<typeof kit>['create']>> | undefined;
  let hostLog = '';
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.HARNESS_ADMIN_DATABASE_URL!, { max: 1 });
  const operationCount = async () => Number((await sql`SELECT count(*)::int AS n
    FROM harness_shared.workspace_host_operations WHERE workspace_id = ${process.env.PAPERCUSP_WORKSPACE!}`)[0].n);
  const operationsBefore = await operationCount();
  const receipt: Record<string, unknown> = { profile: 'hosted-control-plane', bundleSha256,
    policySha256: sha(policy),
    scope: 'Private serving/authentication/config refusal; cloud readiness, policy qualification and final shipment excluded' };
  const sanitize = (value: unknown) => {
    let text = String(value);
    for (const secret of Object.values(configuration.environment) as string[]) text = text.split(secret).join('[redacted]');
    return text;
  };
  const start = (trial: string) => {
    const child = spawn(process.execPath, [artifact], { cwd: join(root, 'apps/operator'),
      env: { ...runtimeEnv, PAPERCUSP_HOSTED_TRIAL_ENTITLEMENT: trial }, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.push(child);
    child.stdout!.on('data', data => { hostLog += sanitize(data); });
    child.stderr!.on('data', data => { hostLog += sanitize(data); });
    return child;
  };
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const until = Date.now() + 10_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < until) await delay(50);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>(done => child.once('exit', () => done()));
    }
  }
  async function request(path: string, options: RequestInit = {}) {
    return fetch(origin + path, { ...options, headers: { host: new URL(publicOrigin).host,
      origin: publicOrigin, ...options.headers }, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
  }
  try {
    console.log('HOSTED_SERVING_PHASE invalid-policy-boot');
    const invalid = start('{');
    const deadline = Date.now() + 60_000;
    while (invalid.exitCode === null && invalid.signalCode === null && Date.now() < deadline) await delay(50);
    assert.notEqual(invalid.exitCode, null, 'malformed policy must terminate startup');
    assert.notEqual(invalid.exitCode, 0);
    assert.match(hostLog, /SyntaxError:.*JSON|JSON.*SyntaxError/s,
      'invalid-policy refusal must come from JSON parsing, not an unrelated startup failure');
    receipt.invalidPolicyRefused = true;
    console.log('HOSTED_SERVING_PHASE configured-boot');
    host = start(policy);
    const readyDeadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < readyDeadline && host.exitCode === null && host.signalCode === null) {
      try {
        const response = await request('/api/health');
        if (response.status === 200 && (await response.json()).ok === true) { ready = true; break; }
      } catch { /* readiness remains bounded by the fixed deadline */ }
      await delay(200);
    }
    assert.equal(ready, true, 'actual hosted artifact must serve JSON health');
    assert.ok(hostLog.includes('HOSTED CONTROL PLANE'), 'serve.ts must select its hosted branch');
    const missing = await request('/api/hosted/browser/onboarding/first-workspace', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 401);
    receipt.missingSessionStatus = missing.status;
    const forbidden = await request('/api/agent-mcp/tools');
    assert.equal(forbidden.status, 404, 'local operator routes must not enter the hosted allowlist');
    console.log('HOSTED_SERVING_PHASE genuine-test-admission');
    // The private identity producer and request artifact must resolve the same trial
    // authority. An auth-only fixture never needed pool quotas during user creation.
    if (poolConfiguration) process.env.PAPERCUSP_HOSTED_TRIAL_ENTITLEMENT = policy;
    kit = await loadIsolatedHostedTestUserKit({ portalRoot: process.env.HOSTED_SERVING_TEST_PORTAL_ROOT!, timeoutMs: 120_000 });
    user = await kit.create({ email: `p537-${randomUUID()}@example.test`, attemptId: randomUUID(),
      firstName: 'Private', lastName: 'Acceptance', displayName: 'Private serving acceptance' });
    const cookie = user.cookie(publicOrigin);
    const headers = { cookie: `${cookie.name}=${cookie.value}` };
    const session = await request('/api/hosted/auth/session', { headers });
    assert.equal(session.status, 200);
    const body = await session.json();
    assert.equal(body.ok, true);
    assert.equal(body.session.organizationId, user.organizationId);
    assert.equal(body.session.sessionId, user.sessionId);
    receipt.authenticatedSession = true;
    receipt.organizationMatches = true;
    if (poolConfiguration) {
      const { admissionIdentity } = await import('../lib/auth/hosted/workspace-admission');
      const { workspaceHostCanaryIdentityLabels } = await import('@papercusp/deployment-driver');
      const { qualifyHostedPool } = await import('./hosted-pool-qualification');
      const canary = { ...poolConfiguration.canary, workspaceId: process.env.PAPERCUSP_WORKSPACE! };
      const identity = admissionIdentity(user.organizationId, canary.runId);
      const desired = { ...poolConfiguration.desired, hostId: identity.hostId,
        labels: { ...poolConfiguration.desired.labels, ...workspaceHostCanaryIdentityLabels(canary) } };
      Object.assign(process.env, { PAPERCUSP_DBOS_ENABLE: '1', PAPERCUSP_BACKGROUND_WORKERS: '1',
        DBOS__APPVERSION: `p544-${canary.runId}` });
      receipt.pool = await qualifyHostedPool({ configuration: { ...poolConfiguration, canary, desired },
        artifact, evidenceDir, organizationId: user.organizationId, sessionId: user.sessionId, sql });
      receipt.scope = 'Private authenticated artifact and real pooled admission/DBOS provision/destroy; guest UX, costs and shipment remain open';
    } else {
      const closed = await request('/api/hosted/browser/onboarding/first-workspace', { method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({
          attemptKey: 'p537-private-serving-0123456789', displayName: 'Private acceptance', label: 'Private acceptance',
          hosting: 'papercusp', organizationId: randomUUID(), quotas: { 'pool.hosts': 999999 } }) });
      receipt.closedAdmissionStatus = closed.status;
      const closedBody = await closed.json();
      receipt.closedAdmissionError = closedBody.error;
      assert.equal(closed.status, 403);
      assert.equal(closedBody.error, 'first_workspace_not_enabled');
    }
    await user.cleanup('P537 private serving acceptance complete');
    user = undefined;
    receipt.testUserCleaned = true;
    const revoked = await request('/api/hosted/auth/session', { headers });
    assert.equal(revoked.status, 401);
    receipt.revokedSessionStatus = revoked.status;
    receipt.provisionOperationsCreated = await operationCount() - operationsBefore;
    if (poolConfiguration) assert.ok(Number(receipt.provisionOperationsCreated) >= 2, 'real provision and destroy operations required');
    else assert.equal(receipt.provisionOperationsCreated, 0);
    assert.equal(sha(readFileSync(artifact)), bundleSha256, 'artifact must remain unchanged through requests');
  } finally {
    const failures: unknown[] = [];
    for (const clean of [async () => { if (user) {
      await user.cleanup('P537 failed acceptance cleanup'); receipt.testUserCleaned = true;
    } },
      async () => { await kit?.close(); }, ...processes.map(child => async () => stop(child)),
      async () => { await sql.end({ timeout: 5 }); }]) {
      try { await clean(); } catch (error) { failures.push(error); }
    }
    receipt.hostStopped = processes.every(child => child.exitCode !== null || child.signalCode !== null);
    writeFileSync(join(evidenceDir, 'host.log'), hostLog, { mode: 0o600 });
    writeFileSync(join(evidenceDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    if (failures.length) throw new AggregateError(failures, 'Private hosted acceptance cleanup failed');
  }
  console.log('HOSTED_SERVING_ARTIFACT_RECEIPT ' + JSON.stringify(receipt));
}

if (process.argv.includes('--credentials')) {
  credentials().then(value => process.stdout.write(JSON.stringify(value), () => process.exit(0)),
    error => { console.error('HOSTED_SERVING_CREDENTIAL_PREFLIGHT_FAILED ' + JSON.stringify({
      stage: credentialStage, name: error?.name, code: error?.code,
      sourceGuardRefusal: String(error?.message).startsWith('COMMITTED_SOURCE refused ') })); process.exit(1); });
} else {
  acceptance().catch(error => { console.error('HOSTED_SERVING_FAILURE ' + String(error)); process.exitCode = 1; });
}
