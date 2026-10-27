/** D307/D309 read-only acquisition behind the existing databaseDeps port.
 * A canonical plan, build or native run is a component, not an enrollment of
 * physical expected hosts or original inventories. Keep those gaps explicit. */
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import { canonicalJson } from '../../../../packages/operator-core/lib/authority/authority-rpc-envelope';
import { getPlanRow } from '../../../../packages/operator-core/lib/agent-tools/plans/source';
import { getPlanRevisionSnapshot } from '../../../../packages/operator-core/lib/agent-tools/plans/revisions';
import { hashPlanContent } from '../../../../packages/operator-core/lib/agent-tools/plans/content-hash';
import { listSpecEvidence } from '../../../../packages/operator-core/lib/agent-tools/plans/spec-evidence-store';
import { getLatestPlanAudit, getLatestActivationAudit } from '../../../../packages/operator-core/lib/plan-audits';
import { readHarnessTestRunEvidence, readTrustedHarnessTestRunProvenance } from '../../../../packages/operator-core/lib/testing-run-store';
import { getRubricWithoutSeeding } from '../../../../packages/operator-core/lib/rubrics';
import { listScorecards } from '../../../../packages/operator-core/lib/scorecards';
import { activeWorkspaceId } from '../../../../packages/operator-core/lib/workspace-registry';
import { candidateArtifactDigest } from './p2p-candidate-manifest';
import { artifactBasename, ENDGAME_SHIPMENT_PLANS, type DerivedCandidateProvenance } from './p2p-candidate-evidence';
import { originalSha256 } from './p521-qualification-evidence';
import type { EndgameOriginalAcquisition, EndgameOutcomeRequest } from './p2p-endgame-outcomes';
import type { ComputeDeps } from './run-p2p-candidate-manifest';

type NativeSql = NonNullable<Parameters<typeof readHarnessTestRunEvidence>[0]['sql']>;
interface Readers extends Pick<ComputeDeps, 'readLedger' | 'readBuildCommand'> {
  workspaceId: string;
  sql: NativeSql;
}

/** No filesystem locator or caller-supplied trust root is an acquisition input.
 * Each pin below comes from the existing scoped canonical reader. Failed reads
 * retain their own diagnostic instead of erasing independently available peers. */
export async function readCanonicalEndgameComponents(
  request: EndgameOutcomeRequest, candidate: DerivedCandidateProvenance, readers: Readers,
): Promise<EndgameOriginalAcquisition> {
  const components: EndgameOriginalAcquisition['components'][number][] = [];
  const missing = new Set<string>();
  async function acquire<T>(name: string, read: () => Promise<T | null>,
    validate: (value: T) => boolean, ref: (value: T) => string): Promise<T | null> {
    try {
      const value = await read();
      if (value === null || !validate(value)) { missing.add(name); return null; }
      // Fingerprint the canonical record actually returned, including originals
      // such as the immutable revision content. Refs never come from evidence JSON.
      components.push({ name, ref: ref(value), sha256: originalSha256(canonicalJson(value)) });
      return value;
    } catch { missing.add(name); return null; }
  }
  const result = (): EndgameOriginalAcquisition => ({
    ...request, kind: 'endgame-original-acquisition/v1', components,
    missing: [...missing], originals: null,
  });
  // The second port argument is the compute function's derived cohort, not a
  // second selector. Re-read its ledger/build originals before retaining it.
  if (request.workspaceId !== readers.workspaceId || request.harnessSlug !== 'papercusp'
    || !candidate.provenance.ok || candidate.sourceSha !== request.sourceSha
    || candidate.provenance.candidateDigest !== request.artifactDigest
    || candidateArtifactDigest(candidate.artifacts) !== request.artifactDigest) {
    missing.add('candidate-scope'); return result();
  }
  const { version, channel } = candidate.provenance;
  const ledger = await acquire('release-ledger', () => readers.readLedger(version, channel), row =>
    row.version === version && row.channel === channel && row.gitSha === request.sourceSha
    && candidateArtifactDigest(row.artifacts.map(a => ({ name: artifactBasename(a.name), sha256: a.sha256 }))) === request.artifactDigest,
  () => `release:${request.workspaceId}:${channel}:${version}`);
  await acquire('build-invocation', () => readers.readBuildCommand(version, channel, request.sourceSha), row =>
    ledger !== null && row.tool === 'release:cut' && row.args.op === 'run' && row.args.confirm === true
    && row.args.version === version && (row.args.channel ?? channel) === channel
    && row.args.sourceSha === request.sourceSha && row.invocationId != null
    && row.invocationId === candidate.provenance.buildCommand?.invocationId,
  row => `tool-invocation:${request.workspaceId}:${row.invocationId}`);

  const scope = { workspaceId: request.workspaceId, harnessSlug: request.harnessSlug };
  for (const slug of [request.planSlug, ...ENDGAME_SHIPMENT_PLANS]) {
    const plan = await acquire(`plan:${slug}`, () => getPlanRow(slug, { ...scope, prefetchAcceptance: true }), row =>
      row.workspaceId === scope.workspaceId && row.harnessSlug === scope.harnessSlug && row.planSlug === slug
      && !row.forcedPast && hashPlanContent(row.content) === row.contentHash,
    row => `plan:${scope.workspaceId}:${scope.harnessSlug}:${slug}:${row.version}`);
    if (!plan) continue;
    const revision = await acquire(`revision:${slug}`, () => getPlanRevisionSnapshot(slug, plan.version, scope), row =>
      row.planSlug === slug && row.seq === plan.version && row.contentHash === plan.contentHash
      && row.contentSnapshot === plan.content && row.contentSnapshotHash === originalSha256(row.contentSnapshot),
    row => `plan-revision:${scope.workspaceId}:${scope.harnessSlug}:${slug}:${row.id}`);
    await acquire(`audit:${slug}`, () => getLatestPlanAudit(slug, scope), row =>
      revision !== null && row.planSlug === slug && row.harnessSlug === scope.harnessSlug
      && row.auditedSha === request.sourceSha && row.auditedPlanRevision?.id === revision.id
      && row.auditedPlanRevision.contentHash === revision.contentHash,
    row => `plan-audit:${scope.workspaceId}:${scope.harnessSlug}:${slug}:${row.auditSeq}`);
    await acquire(`activation:${slug}`, () => getLatestActivationAudit(slug, scope), row =>
      revision !== null && row.planSlug === slug && row.harnessSlug === scope.harnessSlug
      && row.auditedPlanRevision?.id === revision.id && row.auditedPlanRevision.contentHash === revision.contentHash,
    row => `plan-audit:${scope.workspaceId}:${scope.harnessSlug}:${slug}:${row.auditSeq}`);
    // Explicit id lookup deliberately avoids the seedable rubric getter.
    const rubricRef = plan.activeAcceptanceRubricRef;
    if (rubricRef) {
      // These maintained readers resolve the active workspace internally and
      // have no per-call scope option. Never label a different workspace's
      // rubric/card component as belonging to this plan's explicit scope.
      if (activeWorkspaceId() !== scope.workspaceId) {
        missing.add(`rubric:${slug}:workspace-context`);
        continue;
      }
      const rubric = await acquire(`rubric:${slug}`, () => getRubricWithoutSeeding(rubricRef), row =>
        row.rubricId === rubricRef && row.subjectPlan === slug && row.status === 'active',
      row => `rubric:${scope.workspaceId}:${row.rubricId}:${row.criteriaHash}`);
      if (rubric) await acquire(`scorecards:${slug}`, () => listScorecards({ rubricRef, subjectRef: slug, limit: 201 }), rows =>
        rows.length > 0 && rows.length < 201 && rows.every(row => row.rubricRef === rubricRef),
      () => `scorecards:${scope.workspaceId}:${rubricRef}:${rubric.criteriaHash}`);
    } else missing.add(`rubric:${slug}`);
  }

  // The binding supplies exact native IDs, never an invented latest-run selector.
  const bindings = await acquire('spec-evidence', () => listSpecEvidence({ ...scope,
    planSlugs: [request.planSlug], evidenceKinds: ['operational'], limit: 201 }), rows => rows.length < 201,
  () => `spec-evidence:${scope.workspaceId}:${scope.harnessSlug}:${request.planSlug}`);
  for (const binding of bindings ?? []) {
    if (binding.currentness.overall !== 'current' || !binding.testRunId
      || binding.testRunProvenance?.commitSha !== request.sourceSha
      || binding.testRunProvenance.worktreeDirty !== false) continue;
    const id = binding.testRunId;
    await acquire(`native:${id}`, async () => {
      // Only the canonical binding's exact tenant-scoped ID may establish the
      // group needed by the maintained full evidence/provenance readers.
      const rows = await readers.sql`SELECT id, run_group_id, execution_details
        FROM harness_shared.test_runs WHERE workspace_id = ${scope.workspaceId}
          AND harness_slug = ${scope.harnessSlug} AND id = ${id}`;
      if (!Array.isArray(rows) || rows.length !== 1 || Number(rows[0]?.id) !== id) return null;
      const execution = parseTestRunExecutionDetails(rows[0]!.execution_details);
      if (!execution?.runGroupId || execution.runGroupId !== rows[0]!.run_group_id) return null;
      const query = { ...scope, runGroupId: execution.runGroupId, root: execution.root,
        filePaths: [execution.filePath], testRunIds: [id], sql: readers.sql };
      const [evidence, provenance] = await Promise.all([
        readHarnessTestRunEvidence(query), readTrustedHarnessTestRunProvenance(query),
      ]);
      if (!evidence || !provenance || provenance.commitSha !== request.sourceSha
        || execution.failed || execution.skipped || execution.collectionFailed || !execution.passed) return null;
      for (const receipt of execution.isolatedRuntimeReceipts ?? []) {
        await acquire(`native-original:${id}:${receipt.runId}`, async () => {
          // The retained root is the SAME maintained resolver used by the
          // reporter which wrote these hashes. A private input path cannot
          // redirect it, and a deleted/pruned original remains a missing link.
          const [{ defaultEvidenceRoot }, fs, path] = await Promise.all([
            import('@papercusp/verification-harness'), import('node:fs/promises'), import('node:path'),
          ]);
          const base = await fs.realpath(defaultEvidenceRoot('isolated-integration'));
          let directory = path.join(base, 'retained', receipt.runId);
          try { await fs.access(directory); } catch { directory = path.join(base, receipt.runId); }
          const originals = [];
          for (const [name, hash] of [
            ['result.json', receipt.resultSha256], ['phases/prepare/source.json', receipt.sourceSha256],
            ['phases/execute/lifecycle.json', receipt.lifecycleSha256],
          ]) {
            const file = await fs.realpath(path.join(directory, name!));
            const relative = path.relative(base, file);
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
            const stat = await fs.stat(file);
            if (!stat.isFile() || stat.size > 1_048_576) return null;
            const bytes = await fs.readFile(file);
            if (originalSha256(bytes) !== hash) return null;
            // Parse only AFTER matching the reporter-owned hash. These bytes
            // remain a native component, never self-authenticating host custody.
            originals.push({ name, sha256: hash, original: JSON.parse(bytes.toString('utf8')) as unknown });
          }
          return originals;
        }, originals => originals.length === 3,
        () => `test-run:${scope.workspaceId}:${scope.harnessSlug}:${id}:isolated:${receipt.runId}`);
      }
      return { evidence, provenance, isolatedRuntimeReceipts: execution.isolatedRuntimeReceipts ?? [] };
    }, () => true, () => `test-run:${scope.workspaceId}:${scope.harnessSlug}:${id}`);
  }

  // D309 expressly establishes no candidate-linked custody enrollment. Native
  // execution receipts and scoped DB originals above do not authorize choosing
  // expected hosts/inventories or locating private archives from evidence JSON.
  // The later admitted ceremony must establish those independent links before
  // a complete packet can be reconstructed; preserve exactly what is missing.
  if (!components.some(c => c.name.startsWith('native-original:'))) missing.add('native-original-bytes');
  for (const name of ['candidate-linked-host-custody', 'qualification-original-inventory',
    'seed-original-inventory', 'physical-receipt-custody']) missing.add(name);
  return result();
}
