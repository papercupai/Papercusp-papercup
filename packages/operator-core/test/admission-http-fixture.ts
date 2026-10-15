/** Private request/response acceptance for inventory and same-repository admission routing. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { readProcessIdentity } from '../lib/process-identity';
import { getTask } from '../lib/task-manager/store';
import { killTask } from '../lib/task-manager/control';
import { absCgroupDir, walkCgroupTree } from '../lib/task-manager/cgroup-read';
import { isTerminalState, scopeUnitForTask } from '../lib/task-manager/types';
import { createFrozenCandidateRepairQueue, parseFrozenCandidateRepairQueue } from '../lib/release/frozen-candidate-repair-queue';
import { assertPrivateManagedTaskRoute, preparePrivateHttpWorkspaces, preparePrivateOperatorApiBundle } from './private-http-workspace-preflight';

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;
let precheckTaskId: string | undefined;
async function taskScopeEmpty(cgroupPath: string) {
  return walkCgroupTree(absCgroupDir(cgroupPath)).length === 0;
}
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
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private admission host survived cleanup');
}

async function main() {
  const e = process.env;
  const { workspace } = preparePrivateHttpWorkspaces();
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.equal(e.PAPERCUSP_POT_HOME_SLUG, workspace);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.ADMISSION_HTTP_EVIDENCE_DIR!;
  assert.ok(evidenceDir, 'retained evidence directory required');
  const ordinary = e.ADMISSION_HTTP_CASE === 'ordinary';
  if (ordinary) {
    const route = assertPrivateManagedTaskRoute(e);
    writeFileSync(join(evidenceDir, 'managed-task-route.json'), JSON.stringify(route));
  }
  const sources = ['packages/operator-core/lib/agent-tools/release/repair-queue.ts',
    'packages/operator-core/lib/release/admission-jobs.ts',
    'packages/operator-core/lib/release/admission-offthread.ts',
    'packages/operator-core/lib/release/admission-jobs.worker.ts',
    'packages/operator-core/lib/release/admission-fix-precheck.ts',
    'packages/operator-core/lib/release/admission-import-completeness.ts',
    'packages/operator-core/lib/release/frozen-candidate-repair-queue.ts',
    'apps/operator/bin/bundle-host.sh',
    'apps/operator/bin/bundle-host-common.sh',
    'scripts/lib/related-tests.mjs'];
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const fingerprint = () => Object.fromEntries(sources.map(path => [path, digest(join(root, path))]));
  const sourceBefore = fingerprint();

  // Repositories and commits below are disposable fixture data in the supervisor's
  // private TMPDIR. The shared source checkout and its Git index are never written.
  const fixture = mkdtempSync(join(e.TMPDIR!, 'admission-http-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const init = (cwd: string) => {
    git(cwd, 'init', '-q', '-b', 'staging');
    git(cwd, 'config', 'user.email', 'test@example.invalid');
    git(cwd, 'config', 'user.name', 'Private admission fixture');
  };
  init(fixture);
  let servedRoot = fixture;
  let candidate: string;
  let sourceCommit: string;
  const admittedPath = ordinary ? 'test/ordinary.test.mjs' : 'component';
  if (ordinary) {
    // Fixture tools exercise real materialization and a real Node test. Production
    // dependency-generation capacity is deliberately outside this routing case.
    const files: Record<string, string> = {
      'scripts/npm-install-safe.mjs': `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(process.argv.indexOf('--') + 1);
const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`,
      'apps/operator/bin/release/setup-release-checkout.sh': `#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) admission_ref="$2"; shift 2 ;;
    --integration) admission_integration="$2"; shift 2 ;;
    --release) admission_release="$2"; shift 2 ;;
    *) shift ;;
  esac
done
git -C "$admission_integration" worktree add --detach "$admission_release" "$admission_ref"
`,
      'scripts/test-files.mjs': `import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', process.argv[2]], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`,
      'test/ordinary.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('private ordinary admission', () => assert.equal(false, true));\n",
    };
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(fixture, path, '..'), { recursive: true });
      writeFileSync(join(fixture, path), contents);
    }
    git(fixture, 'add', '.');
    git(fixture, 'commit', '-q', '-m', 'private ordinary frozen candidate');
    candidate = git(fixture, 'rev-parse', 'HEAD');
    writeFileSync(join(fixture, admittedPath), files[admittedPath]!.replace('assert.equal(false, true)', 'assert.equal(true, true)'));
    git(fixture, 'add', admittedPath);
    git(fixture, 'commit', '-q', '-m', 'private ordinary test fix');
    sourceCommit = git(fixture, 'rev-parse', 'HEAD');
    servedRoot = join(e.TMPDIR!, 'ordinary-served-build');
    git(fixture, 'worktree', 'add', '--detach', servedRoot, sourceCommit);
    assert.notEqual(servedRoot, fixture);
    assert.equal(git(servedRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'), join(fixture, '.git'));
  } else {
  const child = join(fixture, 'component');
  mkdirSync(child);
  init(child);
  writeFileSync(join(child, 'api.mjs'), 'export const value = 1;\n');
  writeFileSync(join(child, 'native.test.rs'), '#[test] fn paired_native_test() { assert!(true); }\n');
  git(child, 'add', '.');
  git(child, 'commit', '-q', '-m', 'initial private component');
  const oldPin = git(child, 'rev-parse', 'HEAD');
  writeFileSync(join(fixture, 'parent.test.mjs'), "import './component/api.mjs';\n");
  git(fixture, 'add', 'parent.test.mjs');
  git(fixture, 'update-index', '--add', '--cacheinfo', `160000,${oldPin},component`);
  git(fixture, 'commit', '-q', '-m', 'private frozen candidate');
  candidate = git(fixture, 'rev-parse', 'HEAD');
  writeFileSync(join(child, 'api.mjs'), 'export const value = 2;\n');
  git(child, 'add', 'api.mjs');
  git(child, 'commit', '-q', '-m', 'private gitlink update');
  git(fixture, 'update-index', '--cacheinfo', `160000,${git(child, 'rev-parse', 'HEAD')},component`);
  git(fixture, 'commit', '-q', '-m', 'private integration source');
  sourceCommit = git(fixture, 'rev-parse', 'HEAD');
  }
  const lineageRef = 'refs/papercusp/frozen/' + candidate;
  git(fixture, 'update-ref', lineageRef, candidate);
  const queue = createFrozenCandidateRepairQueue({ candidate, base: candidate,
    failingTests: [ordinary ? admittedPath : 'component::test'], nowMs: Date.now() });
  assert.deepEqual(parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(queue))), queue,
    'private queue fixture must satisfy the current persisted contract before bundling');
  const { sql } = getOrgPg();
  // Only initial private fixture data is seeded directly. The tested operation
  // itself crosses the real HTTP dispatcher and admission worker.
  await sql`INSERT INTO harness_shared.routines
    (id, install_slug, name, trigger_kind, trigger_config, target_role, active, metadata, workspace_id)
    VALUES ('private-admission-gate', ${workspace}, 'Private admission gate', 'interval', '{}'::jsonb,
      'system:green-checkpoint', false, ${JSON.stringify({ repair_queue: queue })}::jsonb, ${workspace})`;
  const readQueue = async () => {
    const rows = await sql`SELECT metadata->'repair_queue' AS queue FROM harness_shared.routines
      WHERE workspace_id = ${workspace} AND id = 'private-admission-gate'`;
    assert.equal(rows.length, 1);
    return rows[0].queue;
  };
  const before = await readQueue();
  console.log('ADMISSION_HTTP_PHASE bundle-start');
  const prepared = preparePrivateOperatorApiBundle(root, evidenceDir);
  // The maintained host builder emits its worker siblings from these same sources.
  // Reuse that output; invoking the host builder again would repeat every worker build.
  const worker = join(evidenceDir, 'admission-jobs.worker.mjs');
  const bundleBytes = readFileSync(prepared.path);
  assert.ok(bundleBytes.includes(Buffer.from('precheck-population')), 'inventory dispatch missing from host bundle');
  assert.ok(readFileSync(worker).includes(Buffer.from('no discoverable test files')),
    'inventory guard missing from admission worker bundle');
  assert.deepEqual(fingerprint(), sourceBefore, 'source moved during preparation');
  host = spawn(process.execPath, [prepared.path], { cwd: root,
    env: { ...e, PAPERCUSP_INTEGRATION_ROOT: servedRoot, PAPERCUSP_INTEGRATION_BRANCH: 'staging',
      ...(ordinary ? { PAPERCUSP_CHECKPOINT_LOG_DIR: join(evidenceDir, 'checkpoint-logs') } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host kernel identity required');
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  let health: { service?: string } | undefined;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    assert.equal(host.exitCode, null, 'private host exited before readiness');
    assert.equal(host.signalCode, null, 'private host was signaled before readiness');
    try {
      const response = await fetch(base + '/api/health', { headers, signal: AbortSignal.timeout(2_000) });
      if (response.ok) { health = await response.json(); break; }
    } catch { /* Only bounded readiness convergence retries. */ }
    await new Promise(done => setTimeout(done, 250));
  }
  assert.equal(health?.service, 'papercusp-operator', 'private operator never became ready');
  console.log('ADMISSION_HTTP_PHASE request-ready');
  const args = { op: 'admit', paths: [admittedPath], wholeBlob: true, sourceCommit, confirm: true,
    reason: ordinary ? 'Private same-repository ordinary test admission acceptance'
      : 'Private current-build immutable gitlink inventory acceptance',
    expectedCandidate: candidate, expectedRepairHead: candidate, expectedUpdatedAtMs: queue.updatedAtMs };
  let requestNumber = 0;
  const admit = async (input: typeof args) => {
  const request = await fetch(base + '/api/agent-mcp/run-tool', { method: 'POST', headers,
    body: JSON.stringify({ name: 'release:repair-queue', args: input, harness: workspace,
      callerSid: 'private-admission-http-fixture', confirmed: true }), signal: AbortSignal.timeout(120_000) });
  const envelope = await request.json() as any;
  writeFileSync(join(evidenceDir, `admission-request-${++requestNumber}.json`),
    JSON.stringify({ args: input, status: request.status, envelope }));
  assert.equal(request.status, 200, JSON.stringify(envelope));
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
  const serialized = envelope.result?.content?.find((item: { type: string; text?: string }) =>
    item.type === 'text' && item.text?.trim().startsWith('{'));
  return envelope.result?.structuredContent ?? (serialized ? JSON.parse(serialized.text) : envelope.result?.data ?? envelope.result);
  };
  let response = await admit(args);
  let ordinaryProof: Record<string, unknown> | undefined;
  if (ordinary) {
    assert.equal(response.pending, true, JSON.stringify(response));
    assert.equal(response.admitted, false, JSON.stringify(response));
    const operationId = response.precheckOperation?.operationId;
    assert.ok(operationId, 'managed precheck operation identity required');
    precheckTaskId = parseFrozenCandidateRepairQueue(await readQueue())?.admissionPrecheck?.runnerTaskId;
    assert.ok(precheckTaskId, 'private managed task identity required');
    const precheckDeadline = Date.now() + 90_000;
    let settled: ReturnType<typeof parseFrozenCandidateRepairQueue> | undefined;
    while (Date.now() < precheckDeadline) {
      settled = parseFrozenCandidateRepairQueue(await readQueue());
      assert.ok(settled, 'private queue must remain valid while the precheck is running');
      assert.equal(settled.admissionPrecheck?.operationId, operationId);
      if (settled.admissionPrecheck?.status !== 'running') break;
      await new Promise(done => setTimeout(done, 250));
    }
    const precheck = settled?.admissionPrecheck;
    assert.equal(precheck?.status, 'passed', JSON.stringify(precheck));
    assert.equal(precheck?.verdict?.ran, true, JSON.stringify(precheck));
    assert.deepEqual(precheck?.verdict?.passing, [admittedPath]);
    assert.equal(settled?.repairHead, candidate, 'background precheck must not publish');
    assert.equal(git(fixture, 'rev-parse', lineageRef), candidate);
    response = await admit({ ...args, expectedUpdatedAtMs: settled!.updatedAtMs });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.admitted, true, JSON.stringify(response));
    const after = parseFrozenCandidateRepairQueue(await readQueue());
    assert.ok(after, 'admitted private queue must remain valid');
    assert.notEqual(after.repairHead, candidate);
    assert.equal(git(fixture, 'rev-parse', lineageRef), after.repairHead);
    assert.match(git(fixture, 'show', after.repairHead + ':' + admittedPath), /assert.equal\(true, true\)/);
    let task = await getTask(precheckTaskId);
    const taskExitDeadline = Date.now() + 10_000;
    while (task && !isTerminalState(task.state) && Date.now() < taskExitDeadline) {
      await new Promise(done => setTimeout(done, 100));
      task = await getTask(precheckTaskId);
    }
    assert.ok(task?.confined && task.cgroupPath, 'precheck must be actually cgroup-confined');
    assert.equal(task.workspaceId, workspace, 'task must belong to private runtime');
    assert.equal(task.scopeUnit, scopeUnitForTask(precheckTaskId));
    assert.ok(isTerminalState(task.state), 'precheck task must finish before retiring private PG');
    assert.equal(task.exitCode, 0, 'managed worker must exit successfully');
    assert.equal(await taskScopeEmpty(task.cgroupPath), true, 'private task scope must have no surviving processes');
    ordinaryProof = { operationId, precheck, admittedPath, servedRoot, canonicalRoot: fixture,
      materialization: 'fixture-tools', noBackgroundPublication: true, finalRepairHead: after.repairHead,
      managedTask: { taskId: task.taskId, confined: task.confined, scopeUnit: task.scopeUnit,
        cgroupPath: task.cgroupPath, state: task.state, exitCode: task.exitCode, scopeEmpty: true } };
  } else {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.admitted, false, JSON.stringify(response));
  assert.equal(response.reason, 'admission-precheck-unavailable', JSON.stringify(response));
  assert.match(response.detail, /no discoverable test files/);
  assert.match(response.builtCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(await readQueue(), before, 'refused inventory changed the private queue');
  assert.equal(git(fixture, 'rev-parse', lineageRef), candidate, 'refused inventory published the private lineage');
  }
  assert.deepEqual(fingerprint(), sourceBefore, 'source changed during acceptance');
  await stopHost();
  console.log('ADMISSION_HTTP_RECEIPT ' + JSON.stringify({ workspace, hostStopped: true, health, response,
    queueUnchanged: !ordinary, lineageUnchanged: !ordinary, sourceUnchanged: true, sourceBefore, ordinaryProof,
    bundleSha256: digest(prepared.path), workerSha256: digest(worker) }));
}

try { await main(); }
catch (error) {
  const assertion = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('ADMISSION_HTTP_FAILURE ' + JSON.stringify({ message: assertion.message ?? String(error),
    stack: assertion.stack, actual: assertion.actual, expected: assertion.expected }));
  process.exitCode = 1;
} finally {
  await stopHost();
  if (precheckTaskId) {
    const task = await getTask(precheckTaskId);
    if (task?.confined && task.cgroupPath && !(await taskScopeEmpty(task.cgroupPath))) {
      const stopped = await killTask(precheckTaskId, { reapTerminalResidue: true, includeSubtree: true });
      assert.ok(stopped.ok || stopped.error === 'already_gone', JSON.stringify(stopped));
      assert.equal(await taskScopeEmpty(task.cgroupPath), true, 'private managed task survived cleanup');
    }
  }
  await getOrgPg().sql.end({ timeout: 1 });
}
