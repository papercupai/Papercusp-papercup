/**
 * P-007 (gate-throughput-shift-left-2026-10-06, R-6, D-003): run the staging-fix proposer against
 * the LIVE frozen repair queue and print ready one-call admissions as JSON. Read-only: it builds
 * dry-run admission commits (unpublished garbage) and runs pre-checks in its OWN tree, so it can
 * never race the queue holder's admission pre-check or move repairHead.
 *
 *   npx tsx packages/operator-core/lib/release/staging-fix-proposal-cli.ts [--leg <id>]...
 *
 * Pre-checks take minutes per leg: launch it with `capability:bash { run_in_background: true }`.
 * Each `ready[].admitCall` is the exact `release:repair-queue` call that admits that proposal;
 * nothing is admitted until someone makes it.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import type { AdmissionPrecheckWorkerInput, AdmissionPrecheckQueueTarget } from './admission-fix-precheck-managed';
import { createCheckpointTreeFixPrecheckRunner, deriveAdmissionPrecheckRoot, resolveCanonicalIntegrationRoot, type SignatureLike } from './admission-fix-precheck';
import { importCompletenessPreflight } from './admission-import-completeness';
import { resolveDependencyGenerationRoot } from './dependency-generation-root';
import { integrationBranch } from './judged-sha-containment';
import { createStagingFixProposalDeps, proposeStagingFixes, type FailingLeg } from './staging-fix-proposal';

/** Group a frozen signature into legs: test files by owning workspace, every other entry as its own leg. */
export function legsFromSignature(signature: readonly SignatureLike[]): FailingLeg[] {
  const byLeg = new Map<string, SignatureLike[]>();
  for (const entry of signature) {
    const leg = entry.kind === 'test-file' ? `${entry.workspace ?? 'unknown-workspace'}::test` : `${entry.kind}:${entry.id}`;
    byLeg.set(leg, [...(byLeg.get(leg) ?? []), entry]);
  }
  return [...byLeg.entries()].map(([leg, entries]) => ({ leg, signature: entries }));
}

async function main(argv: string[]): Promise<number> {
  const only = argv.flatMap((a, i) => (a === '--leg' && argv[i + 1] ? [argv[i + 1]!] : []));
  const [{ readFrozenCandidateRepairQueueState }, { integrationRoot }, { activeWorkspaceId }, { operatorHomeHarnessSlug }] =
    await Promise.all([
      import('../harness/routines/release-actions'),
      import('../release-deploy-launch'),
      import('../workspace-registry'),
      import('../harness/operator-home-harness'),
    ]);
  const read = await readFrozenCandidateRepairQueueState({ workspaceId: activeWorkspaceId(), installSlug: operatorHomeHarnessSlug() });
  const queue = read.status === 'value' ? read.queue : null;
  if (!queue) {
    console.log(JSON.stringify({ ok: false, reason: 'no-frozen-queue', read: read.status }));
    return 0;
  }
  const root = await resolveCanonicalIntegrationRoot(integrationRoot());
  const result = await computeStagingFixProposal(queue, root, operatorHomeHarnessSlug(), only);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

async function computeStagingFixProposal(queue: FrozenCandidateRepairQueue, root: string, harness: string, only: string[] = []) {
  const { checkpointRootMirror } = await import('../release-checkpoint-launch');
  const tip = execFileSync('git', ['rev-parse', '--verify', `${integrationBranch()}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const legs = legsFromSignature(queue.signature).filter((l) => only.length === 0 || only.includes(l.leg));
  // Its OWN pre-check tree: never the holder's `<checkpoint>-admission-precheck` checkout (D-003).
  const precheckRoot = deriveAdmissionPrecheckRoot({
    checkpointRoot: `${checkpointRootMirror(root)}-fix-proposal`,
    generationRoot: resolveDependencyGenerationRoot(root),
  }).root;
  const deps = createStagingFixProposalDeps({
    root,
    candidate: queue.candidate,
    repairHead: queue.repairHead,
    actor: process.env.PAPERCUSP_SID ?? 'staging-fix-proposal',
    precheck: createCheckpointTreeFixPrecheckRunner({
      integrationRoot: root,
      checkpointRoot: checkpointRootMirror(root),
      testRunHarness: harness,
      precheckRoot,
      log: (line) => console.error(line),
    }),
    preflight: importCompletenessPreflight({ root, probeRef: tip, enforceSourceCohort: true }),
  });
  const result = await proposeStagingFixes({ candidate: queue.candidate, repairHead: queue.repairHead, tip, legs }, deps);
  return { ok: true, candidate: queue.candidate, repairHead: queue.repairHead, tip, ...result };
}

/** Reuse the routine row and admission worker; no second scheduler or queue writer. */
export async function scheduleStagingFixProposal(
  target: AdmissionPrecheckQueueTarget,
  verdict: { candidateSource?: string; diagnostic?: string; repairQueue?: FrozenCandidateRepairQueue; reason: string },
  deps?: { claim: (key: string) => Promise<boolean>; launch: (key: string) => Promise<void> },
): Promise<boolean> {
  const queue = verdict.repairQueue;
  const round = queue?.convergenceRounds?.at(-1);
  if (!queue || verdict.candidateSource === 'pinned' || verdict.candidateSource === 'explicit-pinned' ||
      verdict.diagnostic === 'candidate-pinned' || verdict.reason !== 'repair-in-progress' ||
      queue.phase !== 'awaiting-fixer' || !round || round.head !== queue.repairHead || round.failingCount === 0 ||
      !queue.signature.some((entry) => entry.kind === 'test-file' && entry.measuredHead === queue.repairHead)) return false;
  const key = createHash('sha256').update(JSON.stringify([queue.candidate, queue.repairHead, round.round, queue.signature])).digest('hex');
  // A lease retry has a distinct fence: a late predecessor cannot settle its successor.
  const operationId = `${key}:${randomUUID()}`;
  const { getOrgPg } = deps ? { getOrgPg: null } : await import('@papercusp/db-org');
  const sql = getOrgPg?.().sql;
  const now = Date.now();
  const expiresAtMs = now + 30 * 60_000;
  const claim = deps?.claim ?? (async (proposalKey: string) => {
    const rows = await sql!.unsafe(`UPDATE harness_shared.routines
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{staging_fix_proposal}', $3::jsonb, true)
      WHERE workspace_id = $1 AND target_role = 'system:green-checkpoint' AND install_slug = $2
        AND (metadata->'staging_fix_proposal'->>'key' IS DISTINCT FROM $4
             OR metadata->'staging_fix_proposal'->>'status' = 'failed'
             OR (metadata->'staging_fix_proposal'->>'status' = 'running'
                 AND COALESCE((metadata->'staging_fix_proposal'->>'expiresAtMs')::bigint, 0) < $5))
        AND (metadata->'staging_fix_proposal'->>'status' IS DISTINCT FROM 'running'
             OR COALESCE((metadata->'staging_fix_proposal'->>'expiresAtMs')::bigint, 0) < $5)
      RETURNING id`, [target.workspaceId, target.installSlug,
      JSON.stringify({ key: proposalKey, operationId, status: 'running', expiresAtMs, candidate: queue.candidate, repairHead: queue.repairHead }), proposalKey, now]);
    return rows.length > 0;
  });
  if (!await claim(key)) return false;
  try {
    if (deps) await deps.launch(key);
    else {
      const [{ startAdmissionPrecheckWorker }, { newTaskId }, { integrationRoot }, { checkpointRootMirror }] = await Promise.all([
        import('./admission-fix-precheck-managed'), import('../task-manager/types'),
        import('../release-deploy-launch'), import('../release-checkpoint-launch'),
      ]);
      const root = await resolveCanonicalIntegrationRoot(integrationRoot());
      const spawned = await startAdmissionPrecheckWorker({ operationId, taskId: newTaskId(), queueTarget: target,
        integrationRoot: root, checkpointRoot: checkpointRootMirror(root), expiresAtMs,
        proposal: { candidate: queue.candidate, repairHead: queue.repairHead } });
      if (!spawned.confined) throw new Error('proposal worker requires a confined task');
    }
    return true;
  } catch (error) {
    if (sql) await sql.unsafe(`UPDATE harness_shared.routines SET metadata = jsonb_set(metadata,
      '{staging_fix_proposal,status}', '"failed"'::jsonb, true)
      WHERE workspace_id = $1 AND target_role = 'system:green-checkpoint' AND install_slug = $2
        AND metadata->'staging_fix_proposal'->>'operationId' = $3`, [target.workspaceId, target.installSlug, operationId]);
    throw error;
  }
}

export async function runAutomaticStagingFixProposal(input: AdmissionPrecheckWorkerInput): Promise<void> {
  const [{ readFrozenCandidateRepairQueueState }, { getOrgPg }] = await Promise.all([
    import('../harness/routines/release-actions'), import('@papercusp/db-org'),
  ]);
  const { sql } = getOrgPg();
  const target = input.queueTarget;
  try {
    const lease = await sql.unsafe(`SELECT id FROM harness_shared.routines
      WHERE workspace_id = $1 AND target_role = 'system:green-checkpoint' AND install_slug = $2
        AND metadata->'staging_fix_proposal'->>'operationId' = $3
        AND metadata->'staging_fix_proposal'->>'status' = 'running'
        AND (metadata->'staging_fix_proposal'->>'expiresAtMs')::bigint > $4`,
      [target.workspaceId, target.installSlug, input.operationId, Date.now()]);
    if (lease.length === 0) return;
    const read = await readFrozenCandidateRepairQueueState(target);
    const queue = read.status === 'value' ? read.queue : null;
    const matches = queue && queue.candidate === input.proposal?.candidate && queue.repairHead === input.proposal.repairHead;
    const result = matches
      ? await computeStagingFixProposal(queue, input.integrationRoot, target.installSlug)
      : { ok: false, reason: 'queue-moved', ready: [] };
    const written = await sql.unsafe(`UPDATE harness_shared.routines
      SET metadata = jsonb_set(metadata, '{staging_fix_proposal}', metadata->'staging_fix_proposal' || $4::jsonb, true)
      WHERE workspace_id = $1 AND target_role = 'system:green-checkpoint' AND install_slug = $2
        AND metadata->'staging_fix_proposal'->>'operationId' = $3 RETURNING id`,
      [target.workspaceId, target.installSlug, input.operationId,
        JSON.stringify({ status: 'done', taskId: input.taskId, completedAtMs: Date.now(), ...result })]);
    if (written.length > 0 && result.ready.length > 0) {
      if (queue?.fixerSpawnId) {
        const { sendMessage } = await import('../agent-tools/coordination/messages');
        await sendMessage({ ownerId: 'system-staging-fix-proposal', ownerLabel: 'staging-fix-proposal',
          source: 'static-client', workspaceId: target.workspaceId, userId: null }, {
          to: [queue.fixerSpawnId], harnessSlug: target.installSlug,
          summary: `${result.ready.length} pre-checked staging fix proposal(s) ready for ${queue.repairHead.slice(0, 12)}`,
          body: `Read green-checkpoint routine metadata.staging_fix_proposal (operation ${input.operationId}, task ${input.taskId}) for ready[].admitCall. Results are for candidate ${queue.candidate}, repairHead ${queue.repairHead}; re-check that identity before explicit admission. Nothing was admitted.`,
          extra: { expects: 'none' },
        });
      }
      const { notifyAttentionOnce } = await import('../attention-notify');
      await notifyAttentionOnce({ workspaceId: target.workspaceId, harnessSlug: target.installSlug,
        kind: 'intervention', importance: 'normal', dedupeKey: `staging-fix-proposal:${input.operationId}`,
        title: 'Pre-checked staging fixes ready for review',
        body: `${result.ready.length} proposal(s); review staging_fix_proposal in the green-checkpoint routine metadata. Admission remains explicit.`,
        data: { taskId: input.taskId, proposalKey: input.operationId, result } });
    }
  } catch (error) {
    await sql.unsafe(`UPDATE harness_shared.routines SET metadata = jsonb_set(metadata,
      '{staging_fix_proposal,status}', '"failed"'::jsonb, true)
      WHERE workspace_id = $1 AND target_role = 'system:green-checkpoint' AND install_slug = $2
        AND metadata->'staging_fix_proposal'->>'operationId' = $3`, [target.workspaceId, target.installSlug, input.operationId]);
    throw error;
  }
}

if (process.argv[1] && /staging-fix-proposal-cli\.[cm]?[jt]s$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
