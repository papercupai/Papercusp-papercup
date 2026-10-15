/** Disposable current-build HTTP proof. This worker never uses the shared operator or database. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { readProcessIdentity } from '../lib/process-identity';
import { privateBundleRuntimeEnv, resolvePreparedPrivateApiBundle, waitForPrivateOperator } from './private-http-workspace-preflight';

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;
async function stopHost() {
  if (!host) return;
  if (host.exitCode === null && host.signalCode === null) {
    const closed = new Promise<void>(done => host!.once('close', () => done()));
    host.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 5_000); })]);
    clearTimeout(timer);
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await closed;
  }
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private cleanup host survived cleanup');
}

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_POT_HOME_SLUG, workspace);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.PLAN_CLEANUP_HTTP_EVIDENCE_DIR!;
  assert.ok(evidenceDir, 'retained evidence directory required');
  const sourcePath = 'packages/operator-core/lib/plan-cleanup/action-dispatch.ts';
  const sourceSha256 = createHash('sha256').update(readFileSync(join(root, sourcePath))).digest('hex');
  const bundle = resolvePreparedPrivateApiBundle(process.argv.slice(2), evidenceDir);
  assert.ok(bundle, 'private cleanup request worker requires its original prepared pinned API');
  console.log('PLAN_CLEANUP_HTTP_PHASE prepared-bundle-verified');
  const bundleBytes = readFileSync(bundle);
  assert.ok(bundleBytes.includes(Buffer.from('plan-cleanup/action-dispatch.ts')), 'canonical action dispatcher missing from executed bundle');
  const bundleSha256 = createHash('sha256').update(bundleBytes).digest('hex');
  const hostEnv = privateBundleRuntimeEnv(e);
  host = spawn(process.execPath, [bundle], { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host kernel identity required');
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  const health = await waitForPrivateOperator({ host, base, headers, evidenceDir, hostIdentity, environment: hostEnv });
  console.log('PLAN_CLEANUP_HTTP_PHASE request-ready');
  async function tool(name: string, args: Record<string, unknown>) {
    const response = await fetch(base + '/api/agent-mcp/run-tool', { method: 'POST', headers,
      body: JSON.stringify({ name, args, harness: workspace, callerSid: 'private-cleanup-http-fixture' }),
      signal: AbortSignal.timeout(30_000) });
    const envelope = await response.json();
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
    const serialized = envelope.result?.content?.find((item: { type: string; text?: string }) => item.type === 'text' && item.text?.trim().startsWith('{'));
    return envelope.result?.structuredContent ?? (serialized ? JSON.parse(serialized.text) : envelope.result?.data ?? envelope.result);
  }
  const granted = await tool('inbox:automation-policy', { op: 'set', level: 'L2', minConfidence: 'medium',
    riskLevels: { low: 'automatic', medium: 'automatic', high: 'automatic' } });
  assert.equal(granted.applied, true, JSON.stringify(granted));
  const { policy } = await tool('inbox:automation-policy', { op: 'get' });
  assert.deepEqual(policy.riskLevels, { low: 'automatic', medium: 'automatic', high: 'automatic' });
  assert.equal(policy.minConfidence, 'medium');
  const { sql } = getOrgPg();
  // Seed two old completed plans in the disposable DB. Operations themselves
  // go through the HTTP route and canonical tool dispatcher, never SQL writes.
  for (const slug of ['private-cleanup-selected', 'private-cleanup-outside']) {
    const content = '---\ntitle: Private cleanup fixture\nstatus: shipped\n---\n\n## Items\n\n- **P-001** `done` Completed fixture work.\n';
    await sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items, created_at, updated_at)
      VALUES (${workspace}, ${workspace}, ${slug}, 'Private cleanup fixture', 'shipped', ${content},
        ${createHash('sha256').update(content).digest('hex')},
        ${JSON.stringify([{ id: 'P-001', text: 'Completed fixture work.', status: 'done', blockedBy: [] }])}::jsonb,
        now() - interval '50 days', now() - interval '40 days')`;
  }
  const readPlans = async () => {
    const rows = await sql`SELECT plan_slug, archived FROM harness_shared.harness_plans
      WHERE workspace_id = ${workspace} AND harness_slug = ${workspace}
        AND plan_slug IN ('private-cleanup-selected', 'private-cleanup-outside')
      ORDER BY plan_slug DESC`;
    assert.equal(rows.length, 2, 'private fixture plans missing');
    return rows.map(row => ({ ...row }));
  };
  const before = await readPlans();
  assert.ok(before.every(plan => plan.archived === false), 'fixture must begin unarchived');
  const requestBody = { op: 'start', harness: workspace, planSlugs: ['private-cleanup-selected'] };
  const response = await fetch(base + '/api/admin/plan-cleanup', { method: 'POST', headers,
    body: JSON.stringify(requestBody), signal: AbortSignal.timeout(120_000) });
  const request = await response.json();
  writeFileSync(join(evidenceDir, 'cleanup-request.json'), JSON.stringify({ base, requestBody, status: response.status, request }));
  assert.equal(response.status, 200, JSON.stringify(request));
  assert.equal(request.ok, true, JSON.stringify(request));
  assert.equal(request.launched, false, 'automatic archive must not launch a resolver');
  assert.equal(request.resolverNeeded, false);
  const after = await readPlans();
  assert.deepEqual(after, [{ plan_slug: 'private-cleanup-selected', archived: true },
    { plan_slug: 'private-cleanup-outside', archived: false }], 'HTTP cleanup must archive exactly its selected plan');
  const findings = await sql`SELECT outcome, finding_kind AS kind, plan_slug FROM harness_shared.plan_cleanup_run_findings
    WHERE workspace_id = ${workspace} AND run_id = ${request.runId}`;
  assert.equal(findings.length, 1, 'exact automatic effect must have one persisted finding');
  const outcome = { ...findings[0] };
  assert.deepEqual(outcome, { outcome: 'auto_applied', kind: 'archive-candidate', plan_slug: 'private-cleanup-selected' });
  const runs = await sql`SELECT phase, auto_resolved, recommended, failed, automation_policy FROM harness_shared.attention_bulk_runs
    WHERE workspace_id = ${workspace} AND run_id = ${request.runId}`;
  assert.equal(runs.length, 1);
  const run = { ...runs[0] };
  assert.equal(run.phase, 'complete');
  assert.equal(run.auto_resolved, 1);
  assert.equal(run.recommended, 0);
  assert.equal(run.failed, 0);
  assert.deepEqual(run.automation_policy.riskLevels, policy.riskLevels);
  await stopHost();
  console.log('PLAN_CLEANUP_HTTP_RECEIPT ' + JSON.stringify({ workspace, hostStopped: true, sourcePath, sourceSha256,
    bundleSha256, health, policy, before, after, runId: request.runId, request: { ...request, status: response.status }, outcome, run }));
}

try { await main(); }
catch (error) {
  const assertion = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('PLAN_CLEANUP_HTTP_FAILURE ' + JSON.stringify({ message: assertion.message ?? String(error),
    stack: assertion.stack, actual: assertion.actual, expected: assertion.expected }));
  process.exitCode = 1;
} finally {
  await stopHost();
  await getOrgPg().sql.end({ timeout: 1 });
}
