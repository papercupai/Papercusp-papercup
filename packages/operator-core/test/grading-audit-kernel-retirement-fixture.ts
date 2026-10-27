/** Private real-kernel/store proof for EI-26731333304037424.
 * Only scorecard inputs and the final routing boundary are synthetic. The task
 * process, scope, reconciliation oracle and terminal ledger CAS are production.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { dispatchPendingGradingAudits, GRADING_INTEGRITY_RUBRIC_REF,
  type DispatchPendingGradingAuditsDeps, type DispatchPendingGradingAuditsInput } from '../lib/grading-integrity';
import type { Rubric } from '../lib/rubrics';
import type { ScorecardRow } from '../lib/scorecards';
import { absCgroupDir, walkCgroupTree } from '../lib/task-manager/cgroup-read';
import { killTask } from '../lib/task-manager/control';
import { managedSpawn } from '../lib/task-manager/managed-spawn';
import { reconcileTick } from '../lib/task-manager/reconcile-tick';
import { getTask } from '../lib/task-manager/store';
import { isTerminalState } from '../lib/task-manager/types';
import { runWithWorkspace } from '../lib/workspace-als';
import { assertPrivateManagedTaskRoute, preparePrivateHttpWorkspaces } from './private-http-workspace-preflight';

const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
const evidenceDir = process.env.GRADING_KERNEL_EVIDENCE_DIR!;
const owned = new Set<string>();
const root = resolve(import.meta.dirname, '../../..');

export interface GradingKernelReceipt {
  workspace: string;
  sourceSha256: string;
  outwardLaunches: number;
  cases: readonly { taskId: string; ended: boolean; routes: number; notifications: number }[];
}

async function scopeEmpty(taskId: string) {
  const task = await getTask(taskId);
  assert.ok(task?.confined && task.cgroupPath, 'real confined private task required');
  return walkCgroupTree(absCgroupDir(task.cgroupPath)).length === 0;
}

async function scenario(ended: boolean) {
  const issueId = ended ? 'private-kernel-ended' : 'private-kernel-live';
  const label = `grading-audit:${issueId}`;
  const now = new Date().toISOString();
  const readyMarker = 'PRIVATE_KERNEL_CHILD_READY';
  let childReady = false;
  let childStdout = '';
  let childStderr = '';
  const argv = ['-e', ended ? 'process.exit(0)'
    : `console.log(${JSON.stringify(readyMarker)});setInterval(() => {}, 1000)`];
  const task = await managedSpawn(process.execPath, argv, { class: 'other', title: label,
    argv: [process.execPath, ...argv],
    cwd: root, launchedBy: 'system:test-private-grading-retirement',
    detail: { label } }, { workspaceId: workspace, requireRegistration: true,
    requireConfinement: true, spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] },
    // Observe before asynchronous ledger persistence can outlive a short child.
    onSpawn: child => {
      child.stdout?.on('data', chunk => {
        childStdout = (childStdout + String(chunk)).slice(-4096);
        childReady ||= childStdout.split('\n').includes(readyMarker);
      });
      child.stderr?.on('data', chunk => {
        childStderr = (childStderr + String(chunk)).slice(-4096);
      });
    } });
  owned.add(task.taskId);
  assert.ok(task.confined, 'kernel proof must not degrade to an unconfined child');
  if (ended) {
    assert.equal((await task.waitForCompletion()).status, 'recorded');
    assert.equal(await scopeEmpty(task.taskId), true);
    // Model a lost exit observer only in this disposable database, after the
    // real child and scope have stopped. Preserve its exact kernel identity.
    // The canonical grace uses the newer of started_at and last_seen_at, so
    // both timestamps must describe an old auditor rather than a new launch.
    const changed = await getOrgPg().sql`
      UPDATE harness_shared.task_ledger
      SET state='running', ended_at=NULL, exit_code=NULL, exit_reason=NULL,
          started_at=now()-interval '1 hour', last_seen_at=now()-interval '1 hour'
      WHERE task_id=${task.taskId} AND workspace_id=${workspace}
      RETURNING task_id`;
    assert.equal(changed.length, 1);
    const stale = await getTask(task.taskId);
    assert.ok(stale, 'private stale auditor row required');
    const kernel = await reconcileTick({ workspaceId: workspace, dryRun: true,
      listLive: async () => [stale] });
    const control = { taskId: task.taskId, startedAt: stale.startedAt,
      lastSeenAt: stale.lastSeenAt, degraded: kernel.degraded,
      degradedReason: kernel.degradedReason, scan: kernel.scan, result: kernel.result };
    writeFileSync(join(evidenceDir, 'grading-kernel-ended-control.json'), JSON.stringify(control, null, 2));
    assert.equal(kernel.degraded, false, JSON.stringify(control));
    assert.ok(kernel.result.endedUnobserved.some(row => row.taskId === task.taskId),
      'private stale auditor must have a positive canonical kernel verdict: ' + JSON.stringify(control));
  } else {
    // Registration alone does not prove that the live control has executed.
    // Keep it alive until owned teardown, and preserve scope-launch failures.
    const readyDeadline = Date.now() + 5000;
    while (!childReady && task.child.exitCode === null && Date.now() < readyDeadline) {
      await new Promise(done => setTimeout(done, 20));
    }
    assert.ok(childReady, 'private live child did not become ready: ' + childStderr);
    assert.equal(await scopeEmpty(task.taskId), false, 'ready live child must occupy its confined scope');
  }

  const card: ScorecardRow = { issueId, createdAt: now, createdBy: 'private-fixture', rubricRef: 'private-standard',
    ratings: {}, nKeys: 0, missingKeys: [], extraKeys: [], rubricResolved: true,
    synthesized: false, score10: null, linkedItems: [], gradingAudit: { state: 'pending',
      metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF, stampedAt: now } };
  let routes = 0;
  let notifications = 0;
  const deps: DispatchPendingGradingAuditsDeps = {
    listScorecards: async () => [card], getRubric: async () => ({ kind: 'standard' }) as Rubric,
    readEvidence: async () => ({ kind: 'not_found' }),
    reserve: async () => ({ status: 'claimed', reservation: { key: label, reservedAt: now } }),
    confirmReservation: async () => true, release: async () => true,
    listWorkspaceWideLoopStanddownOwners: async () => new Set<string>(),
    route: async () => {
      routes++;
      assert.equal(ended, true, 'a live private auditor must retain its route');
      assert.equal((await getTask(task.taskId))?.state, 'ended_unobserved',
        'the canonical terminal CAS must persist before replacement routing');
      return { state: 'routed', conversationId: 'private-routing-boundary' };
    },
    notifyRetainedAuditor: async () => { notifications++; return { state: 'delivered',
      ownerId: 'private-fixture', msgId: 'private-notification', queued: 0, pickupConfirmed: false }; },
    launch: async () => { throw new Error('outward auditor launch forbidden in private fixture'); },
  };
  const ctx = { workspaceId: workspace, harnessSlug: 'papercusp' } as DispatchPendingGradingAuditsInput['ctx'];
  const result = await dispatchPendingGradingAudits({ targetIds: [issueId], ctx }, deps);
  const receipt = result.receipts[0];
  assert.equal(receipt?.state, ended ? 'routed' : 'deduped', JSON.stringify(result));
  assert.equal(routes, ended ? 1 : 0);
  assert.equal(notifications, ended ? 0 : 1);
  assert.equal((await getTask(task.taskId))?.state, ended ? 'ended_unobserved' : 'running');
  return { taskId: task.taskId, ended, routes, notifications, receipt };
}

async function main() {
  assert.ok(evidenceDir, 'retained evidence directory required');
  assertPrivateManagedTaskRoute(process.env);
  assert.equal(preparePrivateHttpWorkspaces().workspace, workspace);
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(process.env.PAPERCUSP_DBOS_ENABLE, '0');
  assert.notEqual(process.env.PAPERCUSP_PG_PORT, '5432');
  const sourceSha256 = createHash('sha256').update(readFileSync(join(root,
    'packages/operator-core/lib/grading-integrity.ts'))).digest('hex');
  const cases = await runWithWorkspace(workspace, async () => [await scenario(false), await scenario(true)]);
  const receipt: GradingKernelReceipt = { workspace, sourceSha256, cases, outwardLaunches: 0 };
  writeFileSync(join(evidenceDir, 'grading-kernel-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log('GRADING_KERNEL_RECEIPT ' + JSON.stringify(receipt));
}

try { await main(); }
catch (error) { console.error('GRADING_KERNEL_FAILURE', error); process.exitCode = 1; }
finally {
  for (const taskId of owned) {
    const task = await getTask(taskId);
    if (task && !(await scopeEmpty(taskId))) {
      const stopped = await killTask(taskId, { includeSubtree: true,
        reapTerminalResidue: isTerminalState(task.state) });
      assert.ok(stopped.ok || stopped.error === 'already_gone', JSON.stringify(stopped));
      assert.equal(await scopeEmpty(taskId), true, 'private scope survived teardown');
    }
  }
  await getOrgPg().sql.end({ timeout: 1 });
}
