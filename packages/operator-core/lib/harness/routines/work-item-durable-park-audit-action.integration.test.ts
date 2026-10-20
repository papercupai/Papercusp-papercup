import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

// The real action deliberately refuses VITEST. Keep this assertion in the
// canonical integration suite, but execute its unmodified production handler
// in the maintained disposable background profile, with no dependency stubs.
const productionAssertion = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const env = process.env;
assert.equal(env.VITEST, undefined);
assert.match(env.PAPERCUSP_WORKSPACE_ID, /^test-runtime-/);
assert.match(env.HOME, /papercusp-test-runtime-.*\/home$/);
assert.equal(env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
for (const key of ['PAPERCUSP_DBOS_ROUTINES', 'PAPERCUSP_DBOS_TIMERS',
  'PAPERCUSP_CLUSTER', 'PAPERCUSP_SPAWNER_SIDECAR', 'PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR']) {
  assert.equal(env[key], '0', key);
}
assert.equal(env.PAPERCUSP_BACKGROUND_WORKERS, '1');
assert.equal(env.PAPERCUSP_DBOS_ENABLE, '1');
for (const key of ['PAPERCUSP_SUBSTRATE_IPC_SOCKET', 'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) assert.equal(env[key], undefined, key);
const dbUrl = new URL(env.HARNESS_ADMIN_DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(dbUrl.hostname));
assert.equal(dbUrl.port, env.PAPERCUSP_PG_PORT);
assert.notEqual(dbUrl.port, '5432');

const { getOrgPg } = await import('@papercusp/db-org');
const { setWorkItemClaimHold } = await import('./packages/operator-core/lib/work-items.ts');
const { buildDurableParkReleaseContract } = await import('./packages/operator-core/lib/durable-park-release-contract.ts');
const { recordKeyFire } = await import('./packages/operator-core/lib/events/await/store.ts');
const { loadTextArtifact } = await import('./packages/operator-core/lib/text-artifacts.ts');
const { WORK_ITEM_DURABLE_PARK_AUDIT } = await import('./packages/operator-core/lib/work-items-durable-park-audit.ts');
await import('./packages/operator-core/lib/harness/routines/work-item-durable-park-audit-action.ts');
const { getSystemActionEntry } = await import('./packages/operator-core/lib/harness/routines/system-actions.ts');
const entry = getSystemActionEntry(WORK_ITEM_DURABLE_PARK_AUDIT);
assert.equal(entry.scheduling, 'standing');
const { sql } = getOrgPg();
const ws = env.PAPERCUSP_WORKSPACE_ID;
const harness = ws;
const readItems = () => sql.unsafe('SELECT feature_id, payload, taken_by FROM harness_shared.work_items WHERE workspace_id = $1 ORDER BY feature_id', [ws]);
const readRun = async (id) => (await sql.unsafe('SELECT run_kind, detail FROM harness_shared.admission_runs WHERE workspace_id = $1 AND id = $2', [ws, id]))[0];
const invoke = (payloadTemplate) => entry.fn({ workspaceId: ws, installSlug: harness, triggerConfig: {}, payloadTemplate });
const ids = ['WI-lease', 'WI-assigned', 'WI-stale', 'WI-pending'];
try {
  assert.equal((await readItems()).length, 0);
  for (const id of ids) {
    const lease = id === 'WI-lease' ? { held_open_by: 'independent-reviewer', held_open_reason: 'review pending', held_open_at: '2020-01-01T00:00:00Z' } : {};
    await sql.unsafe('INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts, payload) VALUES ($1,$2,$3,$4,$3,$5,0,0,$6::jsonb)', [ws, harness, id, 'bug', 'open', JSON.stringify(lease)]);
    // A completion key: a change notification (work-item:unblocked) can no longer certify a
    // condition (event-wait-settlement-2026-10-20 P-001), so its fire would not read as met.
    const trigger = 'work-item:done:' + id + '-dependency';
    const releaseContract = await buildDurableParkReleaseContract({ condition: 'typed dependency is resolved', owner: 'condition-owner', trigger }, 'condition-owner');
    await setWorkItemClaimHold(id, true, { harness, parkedBy: 'departed-parker', reason: 'until typed dependency resolves', releaseContract });
  }
  const original = await readItems();
  await invoke({ runId: 'production-before' });
  assert.deepEqual(await readItems(), original, 'scheduled audit must remain report-only');
  const before = await readRun('production-before');
  assert.equal(before.run_kind, 'durable-park-audit');
  assert.equal(before.detail.status, 'complete');
  assert.equal(before.detail.report.reportOnly, true);
  assert.equal(before.detail.report.population.axes.durableParks, 4);
  assert.equal(before.detail.outcome.uniqueRowsChanged, 0);

  for (const id of ids.filter(id => id !== 'WI-pending')) {
    await recordKeyFire({ eventKey: 'work-item:done:' + id + '-dependency', firedBy: 'real-fixture-producer' });
  }
  await invoke({ runId: 'production-after' });
  const after = await readRun('production-after');
  assert.equal(after.detail.report.releaseConditionHealth.statusCounts['satisfied-still-parked'], 3);
  assert.equal(after.detail.report.releaseConditionHealth.statusCounts.tracked, 1);
  assert.deepEqual(await readItems(), original, 'fired events are refreshed without clearing a park');
  const matrix = JSON.parse(await loadTextArtifact(harness, after.detail.evidenceMatrix.artifactPath));
  assert.equal(matrix.workspaceId, ws);
  assert.equal(matrix.rows.length, 4);
  for (const row of matrix.rows) assert.deepEqual(row.sourcePayload, original.find(item => item.feature_id === row.id).payload);

  // An assignment and a park-control edit AFTER the evidence snapshot must
  // defeat reconciliation, even though their event conditions really fired.
  await sql.unsafe('UPDATE harness_shared.work_items SET taken_by = $1 WHERE workspace_id = $2 AND feature_id = $3', ['concurrent-builder', ws, 'WI-assigned']);
  await sql.unsafe('UPDATE harness_shared.work_items SET payload = jsonb_set(payload, $1::text[], $2::jsonb) WHERE workspace_id = $3 AND feature_id = $4', ['{claim_hold_release,condition}', JSON.stringify('a new dependency must resolve first'), ws, 'WI-stale']);
  const controlSnapshot = await readItems();
  const decisions = matrix.rows.filter(row => row.id !== 'WI-pending').map(row => ({
    id: row.id, expectedParkFingerprint: row.parkFingerprint, reasonCode: 'condition-satisfied',
    evidence: 'private event_key_fires confirms work-item:done:' + row.id + '-dependency',
  }));
  await invoke({ mode: 'reconcile', runId: 'production-reconcile', actor: 'fixture-operator', decisions });
  const reconciled = await readRun('production-reconcile');
  assert.equal(reconciled.detail.status, 'complete');
  assert.equal(reconciled.detail.result.cleared, 1);
  assert.equal(reconciled.detail.result.unchanged, 2);
  assert.deepEqual(Object.fromEntries(reconciled.detail.result.rows.map(row => [row.id, row.outcome])), {
    'WI-assigned': 'assigned', 'WI-lease': 'cleared', 'WI-stale': 'stale-fingerprint',
  });
  const final = await readItems();
  const lease = final.find(row => row.feature_id === 'WI-lease').payload;
  assert.equal(lease.claim_hold_by, undefined);
  assert.equal(lease.claim_hold_release, undefined);
  assert.equal(lease._claimHold, true);
  assert.equal(lease.held_open_by, 'independent-reviewer');
  for (const id of ['WI-assigned', 'WI-stale', 'WI-pending']) {
    assert.deepEqual(final.find(row => row.feature_id === id), controlSnapshot.find(row => row.feature_id === id));
  }
  await invoke({ mode: 'reconcile', runId: 'production-reconcile', actor: 'fixture-operator', decisions });
  const clears = await sql.unsafe('SELECT subject FROM harness_shared.audit_log WHERE workspace_id = $1 AND action = $2', [ws, 'work_items:durable_park:clear']);
  assert.deepEqual(clears.map(row => row.subject), ['WI-lease'], 'idempotent replay must not duplicate clears');
  assert.equal(JSON.parse(await loadTextArtifact(harness, reconciled.detail.artifactPath)).cleared, 1);
  // P-003: a generic wake and completion of the pause task cannot substitute
  // for the explicit owner resume. Exercise the real action and persisted CAS.
  const pauseId = 'WI-owner-pause';
  await sql.unsafe('INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts, payload) VALUES ($1,$2,$3,$4,$3,$5,0,0,$6::jsonb)',
    [ws, harness, pauseId, 'bug', 'open', JSON.stringify({ sibling: 'keep', held_open_by: 'independent-reviewer', held_open_reason: 'independent lease' })]);
  const pauseContract = await buildDurableParkReleaseContract({
    condition: 'WI-pause-task reaches terminal done, ending this system-wide pause.',
    owner: 'fixture-owner', trigger: 'work-item:done:WI-pause-task',
  }, 'fixture-owner');
  assert.equal(pauseContract.reachability, 'blocked');
  await setWorkItemClaimHold(pauseId, true, { harness, parkedBy: 'pause-driver', reason: 'explicit owner pause', releaseContract: pauseContract });
  const paused = (await readItems()).find(row => row.feature_id === pauseId);
  for (const eventKey of ['work-item:claimable', 'work-item:done:WI-pause-task']) {
    await recordKeyFire({ eventKey, firedBy: 'fixture-wake-producer' });
    const runId = eventKey === 'work-item:claimable' ? 'pause-generic-wake' : 'pause-task-completed';
    await invoke({ runId });
    const report = await readRun(runId);
    const pauseMatrix = JSON.parse(await loadTextArtifact(harness, report.detail.evidenceMatrix.artifactPath));
    const row = pauseMatrix.rows.find(row => row.id === pauseId);
    assert.ok(row);
    await invoke({ mode: 'reconcile', runId: runId + '-reconcile', actor: 'fixture-operator', decisions: [{
      id: pauseId, expectedParkFingerprint: row.parkFingerprint, reasonCode: 'condition-satisfied',
      evidence: 'Observed fired event ' + eventKey,
    }] });
    const result = await readRun(runId + '-reconcile');
    assert.equal(result.detail.result.cleared, 0);
    assert.equal(result.detail.result.rows[0].outcome, 'unverified-condition');
    assert.deepEqual((await readItems()).find(row => row.feature_id === pauseId), paused);
  }
  await invoke({ runId: 'pause-before-explicit-resume' });
  const pauseBeforeResume = await readRun('pause-before-explicit-resume');
  const resumeMatrix = JSON.parse(await loadTextArtifact(harness, pauseBeforeResume.detail.evidenceMatrix.artifactPath));
  const resumeRow = resumeMatrix.rows.find(row => row.id === pauseId);
  await invoke({ mode: 'reconcile', runId: 'pause-explicit-resume', actor: 'fixture-owner', decisions: [{
    id: pauseId, expectedParkFingerprint: resumeRow.parkFingerprint, reasonCode: 'operator-directed',
    evidence: 'Fixture owner explicitly authorizes resuming this exact operation; credential and destructive permissions remain separate.',
  }] });
  const resumed = (await readItems()).find(row => row.feature_id === pauseId);
  assert.equal(resumed.payload.claim_hold_by, undefined);
  assert.equal(resumed.payload.claim_hold_release, undefined);
  assert.equal(resumed.payload._claimHold, true);
  assert.equal(resumed.payload.held_open_by, 'independent-reviewer');
  assert.equal(resumed.payload.sibling, 'keep');
  assert.equal(resumed.taken_by, paused.taken_by);
  console.log('P003_PAUSE_PROOF=' + JSON.stringify({ genericWakeCleared: false, pauseCompletionCleared: false,
    explicitResumeCleared: true, independentLeaseRetained: true, unrelatedPayloadRetained: true }));
  const paths = ['packages/operator-core/lib/work-items-durable-park-audit.ts',
    'packages/operator-core/lib/harness/routines/work-item-durable-park-audit-action.ts'];
  console.log('P028_PRODUCTION_PROOF=' + JSON.stringify({
    workspaceId: ws, runtimeRoot: dirname(env.HOME), pgPort: Number(dbUrl.port),
    buildSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
    productionHandler: true, privateStateWrite: true, auditReportOnly: true,
    refreshedConditions: 3, cleared: 1, retainedControls: 3, replayClearCount: clears.length,
  }));
} finally {
  await sql.end({ timeout: 1 });
}
process.exit(0);
`;

function executeProductionAssertion(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['scripts/with-test-pg.mjs', '--isolated-runtime', '--',
      process.execPath, '--import', 'tsx', '--input-type=module', '-e', productionAssertion], {
      cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (data: string) => { output += data; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 240_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolveResult({ code, output }); });
  });
}

function requireClosedPort(port: number): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); reject(new Error('disposable Postgres still accepts connections')); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolveClosed();
      else reject(error);
    });
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error('Postgres teardown was not measured')); });
  });
}

describe('P-028 production background durable-park action', () => {
  it('uses the registered production handler in a private migrated runtime and preserves concurrent controls through teardown', async () => {
    const result = await executeProductionAssertion();
    expect(result.code, result.output).toBe(0);
    const proofLine = result.output.split('\n').find(line => line.startsWith('P028_PRODUCTION_PROOF='));
    expect(proofLine, result.output).toBeDefined();
    const proof = JSON.parse(proofLine!.slice('P028_PRODUCTION_PROOF='.length));
    expect(proof).toMatchObject({ productionHandler: true, privateStateWrite: true,
      auditReportOnly: true, refreshedConditions: 3, cleared: 1, retainedControls: 3, replayClearCount: 1 });
    expect(proof.buildSha).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.values(proof.sourceHashes)).toHaveLength(2);
    for (const hash of Object.values(proof.sourceHashes)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const dataDir = /\(datadir ([^)]+)\)/.exec(result.output)?.[1];
    expect(dataDir, result.output).toBeDefined();
    expect(existsSync(dataDir!)).toBe(false);
    expect(existsSync(proof.runtimeRoot)).toBe(false);
    await requireClosedPort(proof.pgPort);
    console.log('P028_BACKGROUND_ACCEPTANCE=' + JSON.stringify({ ...proof, teardown: 'directories removed and PG connection refused' }));
  }, 300_000);
});
