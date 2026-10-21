/** Real process/ledger acceptance, invoked only by the isolated integration suite. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { getBuildInfo } from '../lib/build-info';
import { readVerifierSourceReceiptSync } from '../lib/verifier-source';
import { absCgroupDir, walkCgroupTree } from '../lib/task-manager/cgroup-read';
import { killTask } from '../lib/task-manager/control';
import { getTask, listTasks } from '../lib/task-manager/store';
import { isTerminalState } from '../lib/task-manager/types';
import { ensureGradingAuditRuntime, retireUnusedGradingAuditRuntimes, type GradingAuditRuntimeDeps } from '../lib/release/grading-audit-runtime';
import { readGradingAuditSourcePin } from '../lib/release/grading-audit-source-pin';
import { assertPrivateManagedTaskRoute, preparePrivateHttpWorkspaces, preparePrivateOperatorApiBundle } from './private-http-workspace-preflight';

export interface GradingRuntimeReceipt {
  workspace: string;
  reused: boolean;
  recovered: boolean;
  confined: boolean;
  exactHealth: boolean;
  partialReferenceRetained: boolean;
  scopeEmpty: boolean;
  pinRemoved: boolean;
  bundleSha256: string;
  evaluatorBuild: ReturnType<typeof getBuildInfo>;
  taskIds: string[];
}

const taskIds = new Set<string>();
const evidenceDir = process.env.GRADING_RUNTIME_EVIDENCE_DIR!;
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;

async function emptyScope(taskId: string) {
  const task = await getTask(taskId);
  assert.ok(task?.confined && task.cgroupPath, 'real confined task ledger identity required');
  return walkCgroupTree(absCgroupDir(task.cgroupPath)).length === 0;
}

async function main() {
  assert.ok(evidenceDir, 'retained evidence directory required');
  assertPrivateManagedTaskRoute(process.env);
  assert.equal(preparePrivateHttpWorkspaces().workspace, workspace);
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(process.env.PAPERCUSP_DBOS_ENABLE, '0');
  assert.notEqual(process.env.PAPERCUSP_PG_PORT, '5432');
  const root = resolve(import.meta.dirname, '../../..');
  // Keep the maintained builder's complete output in the same physical layout
  // production retains; the disposable supervisor owns this whole generation.
  const sourceRoot = join(evidenceDir, '.candidate-runtime-proof', 'checkout');
  const output = join(sourceRoot, 'apps/operator/dist-host');
  mkdirSync(output, { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(sourceRoot, 'node_modules'), 'dir');
  const prepared = preparePrivateOperatorApiBundle(root, output);
  const parentBuild = getBuildInfo();
  // The maintained archive builder stamps twelve source characters. The
  // unbundled worker's Git abbreviation is independently configurable.
  const selected = process.env.VERIFY_TAURI_SOURCE_RECEIPT
    ? readVerifierSourceReceiptSync(root) : null;
  if (selected) assert.ok(parentBuild.sha && selected.sourceCommit.startsWith(parentBuild.sha),
    'unbundled worker and prepared bundle must share the selected source');
  const evaluatorBuild = { ...parentBuild, sha: selected?.sourceCommit.slice(0, 12) ?? parentBuild.sha };
  assert.ok(evaluatorBuild.sha && evaluatorBuild.sha !== 'unknown');
  const deps: GradingAuditRuntimeDeps = {
    currentSource: () => ({ schemaVersion: 1, sourceRoot, bundlePath: prepared.path,
      evaluatorBuild, bundleSha256: prepared.sha256, ownerRef: '' }),
  };
  const input = { workspaceId: workspace, issueId: 'private-audit-a', evaluatorBuild };
  const [first, reused] = await Promise.all([ensureGradingAuditRuntime(input, deps),
    ensureGradingAuditRuntime({ ...input, issueId: 'private-audit-b' }, deps)]);
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
  const stopped = await killTask(first.taskId, { includeSubtree: true, escalateAfterMs: 5000 });
  assert.ok(stopped.ok, JSON.stringify(stopped));
  assert.equal(await emptyScope(first.taskId), true);
  const recovered = await ensureGradingAuditRuntime({ ...input, allowSeed: false }, {
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
  assert.equal(createHash('sha256').update(readFileSync(prepared.path)).digest('hex'), prepared.sha256);
  const receipt: GradingRuntimeReceipt = { workspace, reused: true, recovered: true, confined: true, exactHealth: true,
    partialReferenceRetained: true, scopeEmpty: true, pinRemoved: true, bundleSha256: prepared.sha256,
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
  // Include processes that were registered just before readiness threw.
  for (const task of await listTasks({ workspaceId: workspace, labelPrefix: 'grading-audit-runtime:', limit: 200 })) {
    taskIds.add(task.taskId);
  }
  for (const taskId of taskIds) {
    const task = await getTask(taskId);
    if (task?.confined && !(await emptyScope(taskId))) {
      const result = await killTask(taskId, { includeSubtree: true, reapTerminalResidue: isTerminalState(task.state) });
      assert.ok(result.ok || result.error === 'already_gone', JSON.stringify(result));
      assert.equal(await emptyScope(taskId), true, 'owned runtime survived teardown');
    }
  }
  await getOrgPg().sql.end({ timeout: 1 });
}
