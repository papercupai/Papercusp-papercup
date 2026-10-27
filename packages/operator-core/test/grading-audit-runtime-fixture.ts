/** Real process/ledger acceptance, invoked only by the isolated integration suite. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { adminUrl, appUrl } from '@papercusp/db-org/connection';
import { getBuildInfo } from '../lib/build-info';
import { createScratchClone } from '../lib/scratch-git-clone';
import { readVerifierSourceReceiptSync } from '../lib/verifier-source';
import { absCgroupDir, walkCgroupTree } from '../lib/task-manager/cgroup-read';
import { linuxProcessIdentityFromStat, linuxProcStateFromStat } from '../lib/process-identity';
import { killTask } from '../lib/task-manager/control';
import { SCOPE_HANDOFF_GRACE_MS, SCOPE_HANDOFF_RECHECK_MS } from '../lib/task-manager/managed-spawn';
import { getTask, listTasks } from '../lib/task-manager/store';
import { isTerminalState, type TaskRow } from '../lib/task-manager/types';
import { ensureGradingAuditRuntime, retireUnusedGradingAuditRuntimes, type GradingAuditRuntimeDeps,
  type GradingAuditRuntimeLocator } from '../lib/release/grading-audit-runtime';
import { readGradingAuditSourcePin } from '../lib/release/grading-audit-source-pin';
import { archivePrivateOperatorApiBuild, assertPrivateManagedTaskRoute, preparePrivateHttpWorkspaces, preparePrivateOperatorApiBundle, privateGitCloneBundleEnv,
  privateBundleRuntimeEnv } from './private-http-workspace-preflight';
// @ts-ignore -- share the maintained dependency process-group and progress contract.
import { runVerifierDependencyCommand } from '../../../scripts/source-preview.mjs';

export interface GradingRuntimeReceipt {
  workspace: string;
  reused: boolean;
  recovered: boolean;
  confined: boolean;
  exactHealth: boolean;
  warmingRetained: boolean;
  transientProbeRetained: boolean;
  partialReferenceRetained: boolean;
  scopeEmpty: boolean;
  pinRemoved: boolean;
  expiredSourceRecovered: boolean;
  settledAuditAcceptanceRetained: boolean;
  recoveredBundleSha256: string;
  bundleSha256: string;
  evaluatorBuild: ReturnType<typeof getBuildInfo>;
  taskIds: string[];
}

const taskIds = new Set<string>();
const evidenceDir = process.env.GRADING_RUNTIME_EVIDENCE_DIR!;
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
const observations: object[] = [];
let fixtureScratch: string | undefined;

function retainRuntimeDiagnostics() {
  const logs = readdirSync(evidenceDir).filter(name => /^grading-audit-runtime-[a-f0-9]+\.log$/.test(name)).sort();
  writeFileSync(join(evidenceDir, 'grading-runtime-host.log'), logs.map(name =>
    `--- ${name} ---\n${readFileSync(join(evidenceDir, name), 'utf8')}`).join('\n'));
  writeFileSync(join(evidenceDir, 'grading-runtime-diagnostics.json'), JSON.stringify({ workspace, observations }));
}

async function emptyScope(taskId: string) {
  const task = await getTask(taskId);
  assert.ok(task?.confined && task.cgroupPath, 'real confined task ledger identity required');
  return walkCgroupTree(absCgroupDir(task.cgroupPath)).length === 0;
}

function runtimeOwnership(task: TaskRow) {
  const scopePath = task.cgroupPath ? absCgroupDir(task.cgroupPath) : null;
  const scopeGroups = scopePath ? walkCgroupTree(scopePath) : [];
  let launcherIdentity: string | null = null;
  let launcherState: string | null = null;
  let launcherObservationError: string | null = null;
  try {
    if (task.pid) {
      const stat = readFileSync(`/proc/${task.pid}/stat`, 'utf8');
      launcherIdentity = linuxProcessIdentityFromStat(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'), stat);
      launcherState = linuxProcStateFromStat(stat);
    }
  } catch (error) { launcherObservationError = String(error); }
  const launcherAlive = Boolean(task.processIdentity && launcherIdentity === task.processIdentity
    && launcherState && !['Z', 'X'].includes(launcherState));
  return { scopePath, scopeGroups, launcherPid: task.pid, recordedIdentity: task.processIdentity,
    launcherIdentity, launcherState, launcherAlive, launcherObservationError };
}

async function assertRetainedRuntime(taskId: string, phase: string) {
  // managedSpawn stamps its systemd-run client before the payload joins the
  // scope. An empty first cgroup read cannot establish process retirement.
  // Reuse the launcher's existing bounded handoff policy if both witnesses
  // disappear between reads; HTTP health must still prove readiness later.
  const deadline = Date.now() + SCOPE_HANDOFF_GRACE_MS;
  for (;;) {
    const task = await getTask(taskId);
    assert.ok(task?.confined && task.cgroupPath, 'real confined task ledger identity required');
    const ownership = runtimeOwnership(task);
    observations.push({ phase, taskId, state: task.state, ...ownership, observedAt: new Date().toISOString() });
    retainRuntimeDiagnostics();
    assert.ok(!isTerminalState(task.state), `retained runtime has terminal ledger state ${task.state}`);
    if (ownership.scopeGroups.length || ownership.launcherAlive) return;
    if (Date.now() >= deadline) {
      assert.fail('Runtime ownership could not be verified: no populated scope or matching live launcher');
    }
    await new Promise(done => setTimeout(done, SCOPE_HANDOFF_RECHECK_MS));
  }
}

async function acquireReady(input: Parameters<typeof ensureGradingAuditRuntime>[0],
  deps: GradingAuditRuntimeDeps, expectedTaskId?: string) {
  // Exercise the canonical repair contract: unknown readiness preserves one
  // enrolled task. A retry may bind that task; it may never silently replace it.
  // Keep the maintained private HTTP fixture's 90s readiness allowance inside
  // the existing encompassing worker deadline.
  const deadline = Date.now() + 90_000;
  let enrolled = expectedTaskId;
  for (;;) {
    try {
      const binding = await ensureGradingAuditRuntime(input, deps);
      taskIds.add(binding.taskId);
      if (enrolled) assert.equal(binding.taskId, enrolled, 'readiness retry replaced the enrolled endpoint');
      return binding;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Audit runtime readiness is unknown') throw error;
      const tasks = await listTasks({ workspaceId: workspace, labelPrefix: 'grading-audit-runtime:', limit: 200 });
      assert.equal(tasks.length, 1, 'unknown readiness must retain exactly one live endpoint');
      const task = tasks[0];
      taskIds.add(task.taskId);
      if (enrolled) assert.equal(task.taskId, enrolled, 'readiness retry restarted the endpoint');
      enrolled = task.taskId;
      await assertRetainedRuntime(task.taskId, 'unknown-readiness-ownership');
      const locator = task.detail.gradingAuditRuntime as GradingAuditRuntimeLocator;
      assert.ok(readGradingAuditSourcePin(locator.sourceRoot, locator.ownerRef));
      observations.push({ phase: 'unknown-readiness', taskId: task.taskId, baseUrl: locator.baseUrl,
        issueIds: locator.issueIds, observedAt: new Date().toISOString() });
      if (Date.now() >= deadline) throw new Error('Retained endpoint did not become ready within the fixture deadline', { cause: error });
      await new Promise(done => setTimeout(done, 250));
    }
  }
}

async function main() {
  assert.ok(evidenceDir, 'retained evidence directory required');
  assertPrivateManagedTaskRoute(process.env);
  assert.equal(preparePrivateHttpWorkspaces().workspace, workspace);
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(process.env.PAPERCUSP_DBOS_ENABLE, '0');
  assert.notEqual(process.env.PAPERCUSP_PG_PORT, '5432');
  // The worker already loaded its TS entry. Its native bundle descendants use
  // the same maintained preload policy as the other private HTTP fixtures.
  process.env.NODE_OPTIONS = privateBundleRuntimeEnv(process.env).NODE_OPTIONS;
  const root = resolve(import.meta.dirname, '../../..');
  // Keep the maintained builder's complete output in the same physical layout
  // production retains; the disposable supervisor owns this whole generation.
  // Linux can expose the same device through distinct mounts that reject
  // hardlinks. A sibling of the frozen donor shares its actual mount; private
  // TMPDIR may be a different bind mount even when stat().dev agrees.
  fixtureScratch = mkdtempSync(join(dirname(root), 'grading-runtime-'));
  accessSync(fixtureScratch, constants.W_OK | constants.X_OK);
  let sourceRoot = join(fixtureScratch, '.candidate-runtime-proof', 'checkout');
  const parentBuild = getBuildInfo();
  assert.ok(parentBuild.sha && parentBuild.sha !== 'unknown');
  mkdirSync(dirname(sourceRoot), { recursive: true });
  const cloned = await createScratchClone({ source: root, ref: parentBuild.sha,
    destination: sourceRoot, includeSubmodules: true, signal: AbortSignal.timeout(180_000) });
  // The maintained locked snapshot rewrites workspace links into the exact
  // source clone; borrowing the donor's node_modules would escape the pin.
  // The selected donor is already a frozen verifier tree. Its preparation
  // commands need no test preloads; stream their original diagnostics and reap
  // the complete process group on failure instead of losing buffered output.
  console.info('GRADING_RUNTIME_PREPARATION ' + JSON.stringify({ phase: 'dependencies',
    sourceRoot, donor: root, startedAt: new Date().toISOString(), timeoutMs: 180_000 }));
  await runVerifierDependencyCommand('bash', [join(sourceRoot, 'papercusp-desktop/bin/lib/pinned-deps.sh'),
    'snapshot-locked', root, sourceRoot, 'hardlink'], { cwd: root,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, timeoutMs: 180_000, maxMs: 180_000 });
  console.info('GRADING_RUNTIME_PREPARATION ' + JSON.stringify({ phase: 'dependencies',
    completedAt: new Date().toISOString() }));
  // Diagnostic phase replays never produce the lifecycle receipt required by
  // the integration test. They isolate preparation without rebuilding hosts.
  if (process.argv.includes('--prepare-only')) {
    console.info('GRADING_RUNTIME_PREPARATION_RECEIPT ' + JSON.stringify({
      sourceRoot, sourceSha: cloned.sha, dependenciesPrepared: true }));
    return;
  }
  const output = join(sourceRoot, 'apps/operator/dist-host');
  mkdirSync(output, { recursive: true });
  const prepared = await preparePrivateOperatorApiBundle(sourceRoot, output, { builder: {
    timeoutMs: 240_000, maxMs: 420_000,
    env: privateGitCloneBundleEnv(sourceRoot, cloned.sha),
    retainedEvidenceDir: join(evidenceDir, 'grading-runtime-builds/initial'),
  } });
  // The maintained archive builder stamps twelve source characters. The
  // unbundled worker's Git abbreviation is independently configurable.
  const selected = process.env.VERIFY_TAURI_SOURCE_RECEIPT
    ? readVerifierSourceReceiptSync(root) : null;
  if (selected) assert.ok(parentBuild.sha && selected.sourceCommit.startsWith(parentBuild.sha),
    'unbundled worker and prepared bundle must share the selected source');
  assert.ok(cloned.sha.startsWith(parentBuild.sha));
  const evaluatorBuild = { ...parentBuild, sha: execFileSync('git', ['-C', sourceRoot, 'rev-parse', '--short', 'HEAD'],
    { encoding: 'utf8', timeout: 10_000 }).trim() };
  assert.ok(evaluatorBuild.sha && evaluatorBuild.sha !== 'unknown');
  const deps: GradingAuditRuntimeDeps = {
    // The private supervisor removes its state directory during teardown.
    // Keep the real endpoint's startup evidence with the original worker.
    logDir: evidenceDir,
    currentSource: () => ({ schemaVersion: 1, sourceRoot, bundlePath: prepared.path,
      evaluatorBuild, bundleSha256: prepared.sha256, ownerRef: '' }),
  };
  const input = { workspaceId: workspace, issueId: 'private-audit-a', evaluatorBuild };
  // Deterministically exhaust readiness without waiting for a host-specific
  // startup speed. The real confined process, ledger and source pin must live.
  // Model a parent whose target was resolved without exported DSNs. The child
  // has no operator env file and its fallback is deliberately unreachable;
  // actual HTTP readiness below must therefore use the parent's resolved pins.
  adminUrl(); appUrl();
  const targetKeys = ['DATABASE_URL', 'HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL',
    'PAPERCUSP_DATABASE_URL', 'PAPERCUSP_PG_PORT'] as const;
  const targetEnv = targetKeys.map(key => [key, process.env[key]] as const);
  try {
    for (const key of targetKeys) delete process.env[key];
    process.env.PAPERCUSP_PG_PORT = '1';
    await assert.rejects(ensureGradingAuditRuntime(input, { ...deps,
      probe: async () => null, sleep: async () => {} }), /Audit runtime readiness is unknown/);
  } finally {
    for (const [key, value] of targetEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const warming = await listTasks({ workspaceId: workspace, labelPrefix: 'grading-audit-runtime:', limit: 200 });
  assert.equal(warming.length, 1);
  taskIds.add(warming[0].taskId);
  await assertRetainedRuntime(warming[0].taskId, 'initial-unknown-ownership');
  const ready = await acquireReady({ ...input, allowSeed: false }, deps, warming[0].taskId);
  const [first, reused] = await Promise.all([acquireReady(input, deps, ready.taskId),
    acquireReady({ ...input, issueId: 'private-audit-b' }, deps, ready.taskId)]);
  taskIds.add(first.taskId); taskIds.add(reused.taskId);
  assert.equal(first.taskId, reused.taskId, 'concurrent audits must share one owned endpoint');
  const health = await fetch(first.baseUrl + '/api/health').then(response => response.json());
  assert.equal(health.sha, evaluatorBuild.sha);
  assert.equal(health.version, evaluatorBuild.version);
  const task = await getTask(first.taskId);
  assert.ok(task?.confined && task.cgroupPath);
  assert.equal(await emptyScope(first.taskId), false);
  const locator = task.detail.gradingAuditRuntime as { ownerRef: string; issueIds: string[] };
  assert.deepEqual(locator.issueIds.sort(), ['private-audit-a', 'private-audit-b']);
  assert.ok(readGradingAuditSourcePin(sourceRoot, locator.ownerRef));
  await assert.rejects(ensureGradingAuditRuntime({ ...input, issueId: 'private-audit-c' },
    { ...deps, probe: async () => null }), /Audit runtime readiness is unknown/);
  assert.equal(await emptyScope(first.taskId), false, 'a missed probe retired the live endpoint');
  assert.equal((await acquireReady({ ...input, issueId: 'private-audit-c', allowSeed: false }, deps,
    first.taskId)).taskId, first.taskId);
  const retained = (await getTask(first.taskId))?.detail.gradingAuditRuntime as GradingAuditRuntimeLocator;
  assert.deepEqual(retained.issueIds.sort(), ['private-audit-a', 'private-audit-b', 'private-audit-c']);
  const stopped = await killTask(first.taskId, { includeSubtree: true, escalateAfterMs: 5000 });
  assert.ok(stopped.ok, JSON.stringify(stopped));
  assert.equal(await emptyScope(first.taskId), true);
  const recovered = await acquireReady({ ...input, allowSeed: false }, {
    logDir: evidenceDir,
    currentSource: () => { throw new Error('mutable staging alias has advanced'); },
  });
  taskIds.add(recovered.taskId);
  assert.notEqual(recovered.taskId, first.taskId);
  assert.equal(recovered.bundleSha256, first.bundleSha256);
  assert.equal(recovered.baseUrl, first.baseUrl);
  const recoveredHealth = await fetch(recovered.baseUrl + '/api/health').then(response => response.json());
  assert.equal(recoveredHealth.sha, evaluatorBuild.sha);
  assert.equal(recoveredHealth.version, evaluatorBuild.version);
  await retireUnusedGradingAuditRuntimes(workspace, async ids => ids.filter(id => id === 'private-audit-b'));
  assert.equal(await emptyScope(recovered.taskId), false, 'last pending reference must retain the endpoint');
  const partial = (await getTask(recovered.taskId))?.detail.gradingAuditRuntime as { issueIds: string[] };
  assert.deepEqual(partial.issueIds, ['private-audit-b']);
  await retireUnusedGradingAuditRuntimes(workspace, async () => []);
  assert.equal(await emptyScope(recovered.taskId), true);
  assert.equal(readGradingAuditSourcePin(sourceRoot, locator.ownerRef), null);
  assert.equal(await fetch(recovered.baseUrl + '/api/health', { signal: AbortSignal.timeout(1000) })
    .then(() => true, () => false), false);

  // The audit is settled but source acceptance can arrive later. Remove the
  // original physical locator by relocating this independently built, exact
  // Git checkout, then run the maintained builder at its new physical root.
  // Both artifacts retain their own compiler manifest and byte digest.
  const oldSourceRoot = sourceRoot;
  const movedHome = join(fixtureScratch, '.candidate-runtime-rematerialized');
  renameSync(dirname(sourceRoot), movedHome);
  sourceRoot = join(movedHome, 'checkout');
  const recoveredOutput = join(sourceRoot, 'apps/operator/dist-host');
  // Relocation carries the first builder's journal too. Preserve its complete
  // output before starting an independent build at the runtime's canonical path.
  archivePrivateOperatorApiBuild(recoveredOutput, join(fixtureScratch, 'initial-build'));
  const rebuilt = await preparePrivateOperatorApiBundle(sourceRoot,
    recoveredOutput, { builder: { timeoutMs: 240_000, maxMs: 420_000,
      env: privateGitCloneBundleEnv(sourceRoot, cloned.sha),
      retainedEvidenceDir: join(evidenceDir, 'grading-runtime-builds/recovered') } });
  let acceptancePending = true;
  const acceptanceRef = 'private-source-acceptance';
  const acceptanceDeps: GradingAuditRuntimeDeps = { logDir: evidenceDir,
    pendingAcceptanceRefs: async (_workspace, refs) => acceptancePending ? refs.filter(ref => ref === acceptanceRef) : [] };
  const sourceAcceptance = await acquireReady({ ...input, issueId: 'private-source-acceptance',
    acceptanceRef, allowSeed: false, recoverySourceRoot: sourceRoot }, acceptanceDeps);
  taskIds.add(sourceAcceptance.taskId);
  assert.equal(sourceAcceptance.sourceRecovery?.sourceSha, cloned.sha);
  assert.equal(sourceAcceptance.sourceRecovery?.previousTaskId, recovered.taskId);
  assert.equal(sourceAcceptance.sourceRecovery?.previousSourceRoot, oldSourceRoot);
  assert.equal(sourceAcceptance.sourceRecovery?.previousBundleSha256, prepared.sha256);
  assert.equal(sourceAcceptance.bundleSha256, rebuilt.sha256);
  // Audit settlement must clear only audit refs. The independently pending
  // source acceptance still owns the real confined process and physical pin.
  await retireUnusedGradingAuditRuntimes(workspace, async () => [], acceptanceDeps, [acceptanceRef]);
  assert.equal(await emptyScope(sourceAcceptance.taskId), false);
  const acceptanceLocator = (await getTask(sourceAcceptance.taskId))?.detail.gradingAuditRuntime as GradingAuditRuntimeLocator;
  assert.deepEqual(acceptanceLocator.issueIds, []);
  assert.deepEqual(acceptanceLocator.acceptanceRefs, [acceptanceRef]);
  assert.ok(readGradingAuditSourcePin(sourceRoot, acceptanceLocator.ownerRef));
  // Advance the cleanup clock through the bounded window while acceptance is
  // still pending. Recovery must not extend the old process's hard deadline.
  await retireUnusedGradingAuditRuntimes(workspace, async ids => ids,
    { ...acceptanceDeps, now: () => (sourceAcceptance.expiresAtSec + 1) * 1000 });
  assert.equal(await emptyScope(sourceAcceptance.taskId), true);
  assert.equal(readGradingAuditSourcePin(sourceRoot, locator.ownerRef), null);
  const renewed = await acquireReady({ ...input, issueId: 'private-source-acceptance',
    acceptanceRef, allowSeed: false, recoverySourceRoot: sourceRoot }, acceptanceDeps);
  taskIds.add(renewed.taskId);
  assert.notEqual(renewed.taskId, sourceAcceptance.taskId);
  assert.equal(renewed.sourceRecovery?.previousTaskId, sourceAcceptance.taskId);
  assert.ok(renewed.expiresAtSec <= Math.floor(Date.now() / 1000) + 21600);
  const finalHealth = await fetch(renewed.baseUrl + '/api/health').then(response => response.json());
  assert.equal(finalHealth.sha, evaluatorBuild.sha);
  assert.equal(finalHealth.version, evaluatorBuild.version);
  acceptancePending = false;
  await retireUnusedGradingAuditRuntimes(workspace, async () => [], acceptanceDeps);
  assert.equal(await emptyScope(renewed.taskId), true);
  assert.equal(readGradingAuditSourcePin(sourceRoot, locator.ownerRef), null);
  assert.equal(createHash('sha256').update(readFileSync(join(sourceRoot, 'apps/operator/dist-host/hono-host.mjs')))
    .digest('hex'), rebuilt.sha256);
  const receipt: GradingRuntimeReceipt = { workspace, reused: true, recovered: true, confined: true, exactHealth: true,
    warmingRetained: true, transientProbeRetained: true,
    partialReferenceRetained: true, scopeEmpty: true, pinRemoved: true, expiredSourceRecovered: true,
    settledAuditAcceptanceRetained: true, bundleSha256: prepared.sha256, recoveredBundleSha256: rebuilt.sha256,
    evaluatorBuild, taskIds: [...taskIds] };
  writeFileSync(join(evidenceDir, 'grading-runtime-receipt.json'), JSON.stringify(receipt));
  console.log('GRADING_RUNTIME_RECEIPT ' + JSON.stringify(receipt));
}

try { await main(); }
catch (error) {
  const failure = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('GRADING_RUNTIME_FAILURE ' + JSON.stringify({ message: failure.message ?? String(error),
    stack: failure.stack, actual: failure.actual, expected: failure.expected }));
  process.exitCode = 1;
} finally {
  // Preserve the original startup log even if census or cleanup itself fails.
  retainRuntimeDiagnostics();
  // Include processes that were registered just before readiness threw.
  for (const task of await listTasks({ workspaceId: workspace, labelPrefix: 'grading-audit-runtime:', limit: 200 })) {
    taskIds.add(task.taskId);
  }
  for (const taskId of taskIds) {
    const task = await getTask(taskId);
    const locator = task?.detail.gradingAuditRuntime as GradingAuditRuntimeLocator | undefined;
    if (task && locator) {
      const health = await fetch(locator.baseUrl + '/api/health', { signal: AbortSignal.timeout(2000) })
        .then(async response => {
          const body = response.ok ? await response.json() : null;
          return { status: response.status, sha: body?.sha, version: body?.version, service: body?.service };
        }).catch(error => ({ error: String(error) }));
      observations.push({ phase: 'before-teardown', taskId, state: task.state, baseUrl: locator.baseUrl,
        issueIds: locator.issueIds, health, sourcePinPresent: Boolean(readGradingAuditSourcePin(locator.sourceRoot, locator.ownerRef)),
        ownership: runtimeOwnership(task),
        observedAt: new Date().toISOString() });
      retainRuntimeDiagnostics();
    }
    if (task?.confined && !(await emptyScope(taskId))) {
      const result = await killTask(taskId, { includeSubtree: true, reapTerminalResidue: isTerminalState(task.state) });
      assert.ok(result.ok || result.error === 'already_gone', JSON.stringify(result));
      assert.equal(await emptyScope(taskId), true, 'owned runtime survived teardown');
    }
  }
  retainRuntimeDiagnostics();
  await getOrgPg().sql.end({ timeout: 1 });
  if (fixtureScratch) rmSync(fixtureScratch, { recursive: true, force: true });
}
