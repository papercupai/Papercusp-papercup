/** Original-record validation for the maintained computed candidate pipeline.
 * Readers acquire custody; this module never selects candidates or performs effects. */
import { canonicalJson, verifyAuthorityRpc, type AuthorityRpcAuth } from '../../../../packages/operator-core/lib/authority/authority-rpc-envelope';
import { planItemTextHash, type PlanAudit } from '../../../../packages/operator-core/lib/plan-audits';
import { hashPlanContent } from '../../../../packages/operator-core/lib/agent-tools/plans/content-hash';
import type { PlanRow } from '../../../../packages/operator-core/lib/agent-tools/plans/source';
import type { PlanRevisionSnapshot } from '../../../../packages/operator-core/lib/agent-tools/plans/revisions';
import type { GraderEligibility } from '../../../../packages/operator-core/lib/agent-tools/scorecards/grader-eligibility';
import { inspectRubricRevisionSnapshot, type Rubric } from '../../../../packages/operator-core/lib/rubrics';
import { validatePhysicalDrillEvidence } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-evidence';
import type { PhysicalDrillHostIdentity, PhysicalDrillHostReceipt } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-host-receipt';
import { validatePhysicalPhaseG, type PhysicalPhaseGInput } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-phase-g';
import { validatePhysicalPhaseI, phaseITargetOf, type PhysicalPhaseIInput } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-phase-i';
import {
  deriveJourneyEvidence, validateEndgameDefaultChoice,
  type DerivedCandidateProvenance, type EvidenceDocInput, type ProvenanceCheck,
} from './p2p-candidate-evidence';
import { buildP2pCandidateManifest, P521_JOURNEYS, type P521LocalPrecheck } from './p2p-candidate-manifest';
import type { CurrentReadinessManifest } from './current-readiness-manifest';
import {
  P521_PLAN, originalSha256, originalBytes, requireEvidence, sameEvidence,
  validateP521Qualifications, type EndgameRawOriginal, type P521QualificationInput, type P521QualificationDeps,
} from './p521-qualification-evidence';
import { verifyP521SeedPopulation, type P521SeedPopulationInput, type P521SeedPopulationDeps } from './p521-seed-population';

export const ENDGAME_OUTCOMES = ['P-401', 'P-502', 'P-503', 'P-521'] as const;
export type EndgameOutcome = typeof ENDGAME_OUTCOMES[number];
export interface EndgameOutcomeRequest {
  outcome: EndgameOutcome; planSlug: typeof P521_PLAN; workspaceId: string; harnessSlug: string;
  sourceSha: string; artifactDigest: string;
}
type Physical = { evidence: Parameters<typeof validatePhysicalDrillEvidence>[0]; trust: Parameters<typeof validatePhysicalDrillEvidence>[1];
  receipts: readonly PhysicalDrillHostReceipt[]; original: EndgameRawOriginal };
interface CandidateBinding {
  planSlug: string; auditSeq: number; candidate: DerivedCandidateProvenance;
  citations: readonly { citation: PlanAudit['items'][number]['citations'][number]; auditedBlob: string | null; candidateBlob: string | null }[];
}
export interface EndgameGoOriginals extends Omit<EndgameOutcomeRequest, 'outcome'> {
  outcome: 'P-401'; readiness: CurrentReadinessManifest; journeyEvidence: readonly EvidenceDocInput[];
  localPrechecks?: readonly P521LocalPrecheck[];
  ledgerFlips: readonly { current: PlanRow; snapshot: PlanRevisionSnapshot; audit: PlanAudit }[];
  approval: { audit: PlanAudit; planRevision: { current: PlanRow; snapshot: PlanRevisionSnapshot };
    rubric: Rubric; rubricSnapshot: PlanRevisionSnapshot;
    eligibility: { auditorId: string; at: string; result: GraderEligibility }; candidateBindings: readonly CandidateBinding[] };
  signedGo: { harnessSlug: string; kind: 'p2p-endgame-go/v1'; payload: {
    schemaVersion: 1; workspaceId: string; planSlug: string; sourceSha: string; artifactDigest: string;
    readinessSha256: string; ledgerSha256: string; approvalAuditSeq: number; auditorId: string; approvedAt: string;
  }; auth: AuthorityRpcAuth };
  signerIdentity: PhysicalDrillHostIdentity; signerTrust: Omit<Physical, 'original'>;
}
export interface EndgameDrillOriginals extends Omit<EndgameOutcomeRequest, 'outcome'> {
  outcome: 'P-502'; independentGo: EndgameGoOriginals; physical: Physical; phaseG: PhysicalPhaseGInput; phaseI: PhysicalPhaseIInput;
}
export interface EndgameDefaultOriginals extends Omit<EndgameOutcomeRequest, 'outcome'> {
  outcome: 'P-503'; decision: { current: PlanRow; snapshot: PlanRevisionSnapshot;
    entry: PlanRow['decisions'][number]; record: unknown };
  policy: { newHiveGitMode?: string } | null; witness: Physical; independentGo: EndgameGoOriginals;
  ownerDrill: EndgameDrillOriginals;
  citationBlobs: readonly { kind: string; original: EndgameRawOriginal }[];
}
/** D307's internal layout: all six D297 populations remain original data. */
export interface P521CandidateOriginals extends Omit<EndgameOutcomeRequest, 'outcome'> {
  outcome: 'P-521'; firstBuild: DerivedCandidateProvenance; repeatBuild: DerivedCandidateProvenance;
  qualification: { input: P521QualificationInput; deps: P521QualificationDeps };
  seedPopulation: { input: P521SeedPopulationInput; deps: P521SeedPopulationDeps };
  physical: Physical; journeyEvidence: readonly EvidenceDocInput[]; localPrechecks: readonly P521LocalPrecheck[];
}
export type EndgameOutcomeOriginals = EndgameGoOriginals | EndgameDrillOriginals | EndgameDefaultOriginals | P521CandidateOriginals;
/** D309: canonical component pins are useful even when custody cannot be reconstructed.
 * They describe acquisition, and never substitute for a complete outcome original. */
export interface EndgameOriginalAcquisition extends EndgameOutcomeRequest {
  kind: 'endgame-original-acquisition/v1';
  components: readonly { name: string; ref: string; sha256: string }[];
  missing: readonly string[];
  originals: EndgameOutcomeOriginals | null;
}
export interface EndgameOutcomeReport {
  ok: boolean; checks: ProvenanceCheck[]; go: EndgameGoOriginals | null; drill: EndgameDrillOriginals | null;
  defaultChoice: EndgameDefaultOriginals | null; candidateAcceptance: P521CandidateOriginals | null;
  acquisitions?: Partial<Record<EndgameOutcome, Omit<EndgameOriginalAcquisition, 'originals'>>>;
}
function scope(value: Omit<EndgameOutcomeRequest, 'outcome'>, request: EndgameOutcomeRequest): void {
  requireEvidence(value && ['workspaceId', 'harnessSlug', 'planSlug', 'sourceSha', 'artifactDigest'].every(k =>
    Reflect.get(value, k) === Reflect.get(request, k)), 'original outcome scope differs');
}
function revision(current: PlanRow, snapshot: PlanRevisionSnapshot, request: EndgameOutcomeRequest): void {
  requireEvidence(current.workspaceId === request.workspaceId && current.harnessSlug === request.harnessSlug && current.planSlug === request.planSlug
    && snapshot.planSlug === current.planSlug && snapshot.seq === current.version && snapshot.contentHash === current.contentHash
    && snapshot.contentSnapshot === current.content && originalSha256(snapshot.contentSnapshot) === snapshot.contentSnapshotHash
    && hashPlanContent(current.content) === current.contentHash && !current.forcedPast, 'current plan/revision originals differ');
}
function physical(packet: Omit<Physical, 'original'>, request: EndgameOutcomeRequest): void {
  requireEvidence(validatePhysicalDrillEvidence(packet.evidence, packet.trust).ok && packet.receipts.length >= 2, 'physical original validation failed');
  const evidence = packet.evidence as { sourceSha?: string; artifactDigest?: string; runId: string };
  requireEvidence(evidence.sourceSha === request.sourceSha && evidence.artifactDigest === request.artifactDigest, 'physical candidate differs');
  requireEvidence(new Set(packet.receipts.map(r => r.hostId)).size === packet.receipts.length, 'duplicate physical receipt');
  // The maintained physical validator checks each receipt against its complete
  // original trust packet; retain the explicit original receipt population too.
  const trust = packet.trust as { receipts: readonly PhysicalDrillHostReceipt[] };
  requireEvidence(sameEvidence(packet.receipts, trust.receipts), 'physical receipt inventory differs');
}
const GO_PREREQUISITES = ['P-512', 'P-513', 'P-514', 'P-515', 'P-516', 'P-517', 'P-518', 'P-520', 'P-521'];
async function go(value: EndgameGoOriginals, request: EndgameOutcomeRequest, candidate: DerivedCandidateProvenance): Promise<void> {
  scope(value, request);
  const signed = value.signedGo, p = signed.payload, approval = value.approval;
  const time = Date.parse(p.approvedAt);
  requireEvidence(Number.isSafeInteger(time) && p.schemaVersion === 1 && signed.kind === 'p2p-endgame-go/v1'
    && signed.harnessSlug === request.harnessSlug && p.workspaceId === request.workspaceId && p.planSlug === request.planSlug
    && p.sourceSha === request.sourceSha && p.artifactDigest === request.artifactDigest
    && signed.auth.device_pubkey === value.signerIdentity.deviceKey
    && verifyAuthorityRpc(signed, signed.auth, { nowMs: time }), 'archived GO signature/scope invalid');
  physical(value.signerTrust, request);
  requireEvidence(value.signerTrust.receipts.some(r => ['hostId', 'deviceKey', 'keychainId', 'githubUserId', 'githubLogin', 'machineFingerprint']
    .every(k => Reflect.get(r, k) === Reflect.get(value.signerIdentity, k))), 'GO signer custody differs');
  const witness = value.signerTrust.evidence as { window: { finishedAt: string } };
  requireEvidence(Date.parse(witness.window.finishedAt) <= time, 'GO precedes its witness');
  const evidence = deriveJourneyEvidence({ candidate, evidence: value.journeyEvidence });
  const readiness = await buildP2pCandidateManifest({ candidate, journeys: evidence.journeys,
    localPrechecks: value.localPrechecks ?? evidence.localPrechecks, now: Date.parse(value.readiness.generatedAt) });
  requireEvidence(readiness.current.go && sameEvidence(readiness, value.readiness)
    && sameEvidence(readiness.current.rows.map(r => r.capability), P521_JOURNEYS.map(j => j.key))
    && originalSha256(canonicalJson(readiness)) === p.readinessSha256, 'GO complete recomputed readiness differs');
  requireEvidence(value.ledgerFlips.length === 1 && new Set(value.ledgerFlips.map(f => f.current.planSlug)).size === value.ledgerFlips.length,
    'GO current ledger original missing or duplicated');
  for (const f of value.ledgerFlips) {
    revision(f.current, f.snapshot, request);
    requireEvidence(GO_PREREQUISITES.every(id => f.current.items.filter(i => i.id === id && i.status === 'done').length === 1)
      && f.audit.auditSeq === approval.audit.auditSeq && sameEvidence(f.audit, approval.audit), 'GO prerequisite ledger/audit incomplete');
  }
  const ledger = [...value.ledgerFlips].sort((a, b) => a.current.planSlug.localeCompare(b.current.planSlug) || a.current.harnessSlug.localeCompare(b.current.harnessSlug));
  requireEvidence(originalSha256(canonicalJson(ledger)) === p.ledgerSha256, 'GO ledger bytes differ');
  revision(approval.planRevision.current, approval.planRevision.snapshot, request);
  const a = approval.audit, snap = approval.planRevision.snapshot;
  requireEvidence(a && a.planSlug === request.planSlug && a.harnessSlug === request.harnessSlug && a.auditedSha === request.sourceSha
    && p.approvalAuditSeq === a.auditSeq && p.auditorId === a.createdBy && Date.parse(a.createdAt) <= time
    && a.auditedPlanRevision?.id === snap.id && a.auditedPlanRevision.seq === snap.seq && a.auditedPlanRevision.contentHash === snap.contentHash
    && a.findings.every(f => f.disposition === 'fixed'), 'current GO approval audit unavailable');
  const eligibility = approval.eligibility;
  requireEvidence(eligibility.auditorId === a.createdBy && eligibility.at === a.createdAt && eligibility.result.refusal === null
    && eligibility.result.callerIsImplementer === false && eligibility.result.implementer
    && a.createdBy !== eligibility.result.implementer && !eligibility.result.principalImplementers.includes(a.createdBy), 'GO auditor independence unavailable');
  const inspection = inspectRubricRevisionSnapshot(approval.rubricSnapshot.contentSnapshot);
  requireEvidence(approval.rubric.status === 'active' && approval.rubric.subjectPlan === request.planSlug
    && approval.rubricSnapshot.planSlug === approval.rubric.rubricId && inspection.kind === 'enriched'
    && inspection.criteriaHash === approval.rubric.criteriaHash
    && originalSha256(approval.rubricSnapshot.contentSnapshot) === approval.rubricSnapshot.contentSnapshotHash, 'GO eligibility rubric original invalid');
  for (const id of [...GO_PREREQUISITES, 'P-401']) {
    const item = approval.planRevision.current.items.find(i => i.id === id);
    const entries = a.items.filter(i => i.itemId === id);
    requireEvidence(item && entries.length === 1 && entries[0]!.verdict === 'implemented' && entries[0]!.itemTextHash === planItemTextHash(item.text)
      && entries[0]!.auditedSha === request.sourceSha && entries[0]!.citations.length > 0, 'GO audited item text/citations differ');
    for (const citation of entries[0]!.citations) requireEvidence(approval.candidateBindings.some(binding => binding.planSlug === request.planSlug
      && binding.auditSeq === a.auditSeq && binding.candidate.sourceSha === request.sourceSha
      && binding.candidate.provenance.candidateDigest === request.artifactDigest && binding.citations.some(c =>
        sameEvidence(c.citation, citation) && c.auditedBlob && c.auditedBlob === c.candidateBlob && citation.blobSha === c.auditedBlob)), 'GO candidate citation unresolved');
  }
}
async function drill(value: EndgameDrillOriginals, request: EndgameOutcomeRequest, candidate: DerivedCandidateProvenance): Promise<void> {
  scope(value, request); await go(value.independentGo, request, candidate); physical(value.physical, request);
  requireEvidence(sameEvidence(JSON.parse(originalBytes(value.physical.original).toString('utf8')), value.physical.evidence), 'drill original bytes differ');
  requireEvidence(validatePhysicalPhaseG(value.phaseG).ok && validatePhysicalPhaseI(value.phaseI).ok
    && phaseITargetOf(value.phaseI).kind === 'canary-owner', 'owning canary phase G/I validation failed');
  const evidence = value.physical.evidence as { legG: unknown; legI: unknown; window: { startedAt: string } };
  requireEvidence(sameEvidence(evidence.legG, value.phaseG) && sameEvidence(evidence.legI, value.phaseI)
    && Date.parse(value.independentGo.signedGo.payload.approvedAt) < Date.parse(evidence.window.startedAt), 'GO/drill chronology or originals differ');
}
async function choice(value: EndgameDefaultOriginals, request: EndgameOutcomeRequest, candidate: DerivedCandidateProvenance): Promise<void> {
  scope(value, request); revision(value.decision.current, value.decision.snapshot, request);
  await go(value.independentGo, request, candidate); await drill(value.ownerDrill, request, candidate); physical(value.witness, request);
  const record = value.decision.record as { choice: string; recordedAt: string; decisionRef: string; evidence: { kind: string; ref: string; sha256: string }[] };
  requireEvidence(validateEndgameDefaultChoice(record, request).length === 0 && value.policy?.newHiveGitMode === record.choice
    && record.decisionRef === `${request.planSlug}#${value.decision.entry.id}`
    && sameEvidence(JSON.parse(value.decision.entry.body), record)
    && value.decision.current.decisions.filter(d => sameEvidence(d, value.decision.entry)).length === 1
    && value.decision.current.content.includes(value.decision.entry.body), 'explicit current default original differs');
  const originals = [value.witness.original, value.independentGo.signedGo, value.ownerDrill.physical.original];
  const kinds = ['witness', 'independent-go', 'owner-freeze-recovery-drill'];
  requireEvidence(value.citationBlobs.length === kinds.length, 'default original citation population incomplete');
  kinds.forEach((kind, i) => {
    const refs = value.citationBlobs.filter(b => b.kind === kind), claimed = record.evidence.filter(e => e.kind === kind);
    requireEvidence(refs.length === 1 && claimed.length === 1 && claimed[0]!.ref === refs[0]!.original.ref
      && claimed[0]!.sha256 === refs[0]!.original.sha256, 'default original citation unresolved');
    const decoded = JSON.parse(originalBytes(refs[0]!.original).toString('utf8'));
    const expected = i === 1 ? originals[i] : JSON.parse(originalBytes(originals[i] as EndgameRawOriginal).toString('utf8'));
    requireEvidence(sameEvidence(decoded, expected), 'default citation byte association differs');
  });
  requireEvidence(sameEvidence(JSON.parse(originalBytes(value.witness.original).toString('utf8')), value.witness.evidence), 'default witness bytes differ');
}
async function p521(value: P521CandidateOriginals, request: EndgameOutcomeRequest, candidate: DerivedCandidateProvenance): Promise<void> {
  scope(value, request);
  for (const build of [value.firstBuild, value.repeatBuild]) requireEvidence(build.provenance.ok
    && build.sourceSha === request.sourceSha && build.provenance.candidateDigest === request.artifactDigest
    && sameEvidence(build.artifacts, candidate.artifacts) && build.provenance.legs.length > 0
    && build.provenance.legs.every(l => !l.gitDirty && l.gitDirtyAtEmit === false && !l.reused)
    && build.provenance.buildCommand?.invocationId, 'complete clean repeated candidate build missing');
  requireEvidence(value.firstBuild.provenance.buildCommand!.invocationId !== value.repeatBuild.provenance.buildCommand!.invocationId,
    'independent repeat build invocation missing');
  const subject = value.seedPopulation.input.subject;
  requireEvidence(subject.sourceSha === request.sourceSha && subject.artifactDigest === request.artifactDigest
    && candidate.artifacts.some(a => a.sha256 === subject.installerSha256)
    && value.firstBuild.provenance.legs.some(l => l.seed?.manifestSha256 === subject.seedSha256)
    && value.firstBuild.provenance.legs.some(l => l.sidecar?.serveMjsSha256 === subject.runtimeSha256)
    && sameEvidence(value.qualification.input.subject, subject), 'installer/runtime/seed/qualification binding differs');
  requireEvidence(validateP521Qualifications(value.qualification.input, value.qualification.deps).ok
    && (await verifyP521SeedPopulation(value.seedPopulation.input, value.seedPopulation.deps)).ok, 'actual qualification or seed population failed');
  physical(value.physical, request);
  requireEvidence(sameEvidence(JSON.parse(originalBytes(value.physical.original).toString('utf8')), value.physical.evidence), 'physical witness original bytes differ');
  const journeys = deriveJourneyEvidence({ candidate, evidence: value.journeyEvidence });
  const readiness = await buildP2pCandidateManifest({ candidate, journeys: journeys.journeys, localPrechecks: value.localPrechecks });
  requireEvidence(readiness.current.go && sameEvidence(readiness.current.rows.map(r => r.capability), P521_JOURNEYS.map(j => j.key)), 'complete same-candidate journey/precheck originals unavailable');
}

export async function deriveEndgameOutcomes(candidate: DerivedCandidateProvenance,
  context: { workspaceId: string; harnessSlug: string },
  read?: (request: EndgameOutcomeRequest, candidate: DerivedCandidateProvenance) => Promise<unknown>): Promise<EndgameOutcomeReport> {
  const report: EndgameOutcomeReport = { ok: false, checks: [], go: null, drill: null, defaultChoice: null, candidateAcceptance: null };
  for (const outcome of ENDGAME_OUTCOMES) {
    const request: EndgameOutcomeRequest = { outcome, planSlug: P521_PLAN, ...context,
      sourceSha: candidate.sourceSha, artifactDigest: candidate.provenance.candidateDigest };
    let status: ProvenanceCheck['status'] = 'fail';
    let detail = 'canonical outcome original reader unavailable';
    if (read) try {
      let raw = await read(request, candidate);
      if (raw && typeof raw === 'object' && Reflect.get(raw, 'kind') === 'endgame-original-acquisition/v1') {
        const acquisition = raw as EndgameOriginalAcquisition;
        scope(acquisition, request);
        requireEvidence(acquisition.outcome === outcome && Array.isArray(acquisition.components)
          && Array.isArray(acquisition.missing), 'canonical acquisition scope unavailable');
        const { originals, ...diagnostics } = acquisition;
        (report.acquisitions ??= {})[outcome] = diagnostics;
        raw = originals;
      }
      requireEvidence(raw && typeof raw === 'object' && Reflect.get(raw, 'outcome') === outcome, 'canonical outcome original missing');
      const value = raw as EndgameOutcomeOriginals; scope(value, request);
      requireEvidence(candidate.provenance.ok, 'computed candidate provenance failed');
      switch (value.outcome) {
        case 'P-401': await go(value, request, candidate); report.go = value; break;
        case 'P-502': await drill(value, request, candidate); report.drill = value; break;
        case 'P-503': await choice(value, request, candidate); report.defaultChoice = value; break;
        case 'P-521': await p521(value, request, candidate); report.candidateAcceptance = value; break;
      }
      status = 'pass'; detail = 'complete candidate-bound original outcome verified';
    } catch { detail = 'canonical outcome originals missing, unresolved or invalid'; }
    report.checks.push({ id: outcome, status, detail });
  }
  report.ok = report.checks.every(c => c.status === 'pass');
  return report;
}
