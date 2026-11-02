import { z } from 'zod';
import { readAcceptanceBarContractSnapshot, type AcceptanceBarTrace } from './acceptance-bar-contract-snapshot';
import { readCurrentOperationalArtifacts } from './agent-tools/plans/spec-evidence-store';
import type { ApplicationRuntimeAcceptance, ApplicationRuntimeCandidate } from './bundled-node';
import { envelopeSchema } from './application-runtime-acceptance-offline';
export { readSignedApplicationRuntimeAcceptance } from './application-runtime-acceptance-offline';

export const BUN_MIGRATION_PLAN = 'node-to-bun-staged-migration-2026-10-22';
const ELIGIBILITY_BARS = ['R-1', 'R-2', 'R-3', 'R-4', 'R-5', 'R-6', 'R-7'];
const digest = z.string().regex(/^[a-f0-9]{64}$/);

// This immutable artifact precedes grading. Grade/verdict identities come from
// the canonical snapshot, never from self-referential fields in the artifact.
export const applicationRuntimeCandidateReceiptSchema = z.object({
  schemaVersion: z.literal('application-runtime-candidate/v1'),
  planSlug: z.literal(BUN_MIGRATION_PLAN),
  candidateSha256: digest,
  sourceSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  role: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  binarySha256: digest,
  nodeBinarySha256: digest,
  entrypointSha256: digest,
  // R-6 grades these final signed packages before cutover. R-8 later proves
  // byte-preserving promotion of this same set; its whole BAR is not waived.
  signedArtifacts: z.array(z.object({
    scope: z.string().min(1), sha256: digest, candidateSha256: digest,
    signatureVerificationRef: z.string().min(1),
  }).strict()).min(1).max(100),
  validUntil: z.number().int().positive(),
}).strict();

export interface ApplicationRuntimeAcceptanceRequest {
  harnessSlug: string;
  evidenceRef: string;
  candidate: ApplicationRuntimeCandidate;
  role: string;
}

async function readApplicationRuntimeAcceptanceRecord(request: ApplicationRuntimeAcceptanceRequest)
  : Promise<{ acceptance: ApplicationRuntimeAcceptance; snapshotHash: string } | null> {
  const { harnessSlug, evidenceRef, role } = request;
  const candidate = structuredClone(request.candidate);
  if (!harnessSlug || !evidenceRef || !candidate.bun || !candidate.roles.includes(role)) return null;
  const snapshot = await readAcceptanceBarContractSnapshot(BUN_MIGRATION_PLAN, {}, { harnessSlug });
  const { plan, rubric, grading } = snapshot;
  if (!snapshot.applicable || snapshot.planSlug !== BUN_MIGRATION_PLAN
    || !snapshot.completeness.complete || snapshot.completeness.truncated || !snapshot.lineage.complete
    || Object.values(snapshot.bounded).some(bound => bound.truncated)
    || !plan || plan.harnessSlug !== harnessSlug || !rubric
    || !rubric.revision || !rubric.criteriaHash || !rubric.barSetHash
    || plan.rubricSlug !== rubric.rubricId || plan.rubricRevision !== rubric.revision
    || plan.barSetHash !== rubric.barSetHash || grading.vetting.state !== 'current'
    || !grading.authoritativeScorecardId || !grading.gradedBy || !grading.selectedVia
    || grading.rubricRevision !== rubric.revision || grading.criteriaHash !== rubric.criteriaHash) return null;

  const author = grading.authorVerdict;
  if (!['accepted', 'accepted-pending-delivery'].includes(author.state)
    || !author.scorecardId || author.supersedes !== grading.authoritativeScorecardId
    || author.rubricRevision !== rubric.revision || author.criteriaHash !== rubric.criteriaHash) return null;
  // This projection recognizes exactly this migration's contract. A changed BAR
  // population needs an explicit code review rather than an implicit exclusion.
  if (snapshot.bars.length !== 8 || !snapshot.bars.some(bar => bar.barKey === 'R-8')) return null;
  const evidence = new Map<number, NonNullable<AcceptanceBarTrace['proof']['history']>[number]>();
  for (const key of ELIGIBILITY_BARS) {
    const matches = snapshot.bars.filter(bar => bar.barKey === key);
    if (matches.length !== 1) return null;
    const bar = matches[0]!;
    if (bar.mandatory !== true || bar.readiness.state !== 'ready'
      || bar.proof.state !== 'current' || bar.proof.uncertainEvidence !== 0
      || bar.grading.state !== 'pass' || bar.grading.scorecardId !== grading.authoritativeScorecardId
      || bar.grading.rubricRevision !== rubric.revision || bar.grading.criteriaHash !== rubric.criteriaHash
      || !bar.grading.rating || !bar.passRatings.includes(bar.grading.rating.toLowerCase())) return null;
    const card = bar.grading.history?.find(card => card.scorecardId === grading.authoritativeScorecardId
      && card.role === 'independent' && card.authoritative && card.currentRevision && card.complete && !card.retracted);
    if (!card || !Number.isFinite(Date.parse(card.createdAt))) return null;
    // The exact candidate must have been part of each graded eligibility BAR.
    // An artifact bound after grading cannot borrow an older passing verdict.
    const rows = bar.proof.history?.filter(row => row.evidenceRef === evidenceRef
      && row.matchesCurrentSpec && row.activeAttempt === true && row.currentness.overall === 'current'
      && Number.isFinite(Date.parse(row.createdAt)) && Date.parse(row.createdAt) <= Date.parse(card.createdAt));
    if (!rows?.length) return null;
    for (const row of rows) evidence.set(row.id, row);
  }
  const artifacts = await readCurrentOperationalArtifacts(plan.workspaceId, harnessSlug, [...evidence.values()]);
  if (artifacts.size !== evidence.size) return null;
  let accepted: ApplicationRuntimeAcceptance | null = null;
  for (const artifact of artifacts.values()) {
    if ('error' in artifact || !artifact.measuredAtCommit) return null;
    const parsed = applicationRuntimeCandidateReceiptSchema.safeParse(artifact.artifact);
    if (!parsed.success) return null;
    const receipt = parsed.data;
    const scopes = snapshot.bars.find(bar => bar.barKey === 'R-6')!.requiredScope;
    if (!scopes.length || new Set(scopes).size !== scopes.length
      || receipt.signedArtifacts.length !== scopes.length
      || new Set(receipt.signedArtifacts.map(artifact => artifact.scope)).size !== scopes.length
      || receipt.signedArtifacts.some(artifact => !scopes.includes(artifact.scope))
      || !receipt.signedArtifacts.some(artifact => artifact.candidateSha256 === candidate.candidateSha256)) return null;
    if (receipt.candidateSha256 !== candidate.candidateSha256 || receipt.sourceSha !== candidate.sourceSha
      || receipt.role !== role || receipt.binarySha256 !== candidate.bun.binarySha256
      || receipt.nodeBinarySha256 !== candidate.node.binarySha256
      || receipt.entrypointSha256 !== candidate.entrypointSha256 || receipt.validUntil <= Date.now()) return null;
    accepted = { verdict: 'accepted', evidenceRef, candidateSha256: receipt.candidateSha256,
      sourceSha: receipt.sourceSha, role, binarySha256: receipt.binarySha256,
      nodeBinarySha256: receipt.nodeBinarySha256, entrypointSha256: receipt.entrypointSha256,
      validUntil: receipt.validUntil };
  }
  const current = await readAcceptanceBarContractSnapshot(BUN_MIGRATION_PLAN, {}, { harnessSlug });
  return accepted && current.contentHash === snapshot.contentHash
    ? { acceptance: accepted, snapshotHash: snapshot.contentHash } : null;
}

/** Pre-cutover eligibility projection; final R-8 shipment remains a separate gate. */
export async function readApplicationRuntimeAcceptance(request: ApplicationRuntimeAcceptanceRequest)
  : Promise<ApplicationRuntimeAcceptance | null> {
  return (await readApplicationRuntimeAcceptanceRecord(request))?.acceptance ?? null;
}

/**
 * Prepare exact bytes for the existing release signer, ONLY from canonical
 * eligibility. Keep this detached from the final packages it approves. This
 * unsigned return value is never authority at an installed host.
 */
export async function prepareApplicationRuntimeAcceptanceEnvelope(request: ApplicationRuntimeAcceptanceRequest)
  : Promise<string | null> {
  const frozen = structuredClone(request);
  const record = await readApplicationRuntimeAcceptanceRecord(frozen);
  if (!record) return null;
  const issuedAt = Date.now();
  if (record.acceptance.validUntil <= issuedAt) return null;
  const envelope = envelopeSchema.safeParse({ schemaVersion: 'application-runtime-acceptance/v1',
    planSlug: BUN_MIGRATION_PLAN, harnessSlug: frozen.harnessSlug,
    canonicalSnapshotHash: record.snapshotHash, issuedAt, acceptance: record.acceptance });
  return envelope.success ? JSON.stringify(envelope.data) + '\n' : null;
}
