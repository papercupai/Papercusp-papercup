import { z } from 'zod';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { computeIdentityHash, JUDGE_PROMPT_SCAFFOLD_VERSION, type PersonaTraits } from '@papercusp/testing-shell/llm';
import { canonicalJson } from '@papercusp/hash-chain';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { formatSpecRef } from '../scheduler/claim-spec';
import type { CommandInstrument } from '../rubric-instrument-registry';
import { judgeS42Run, S42_CASES } from '../llm-testing/scenarios/su/S42-drain-watch-recheck';

export const LUNA_CAPACITY_PLAN = 'luna-drain-capacity-recovery-2026-10-23';
export const LUNA_CAPACITY_INSTRUMENTS = {
  recovery: 'fleet:luna-capacity-census', shipment: 'fleet:luna-capacity-shipment',
  diagnostic: 'fleet:luna-capacity-diagnostic', continuation: 'fleet:luna-capacity-continuation',
} as const;
const text = z.string().trim().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const time = z.string().datetime({ offset: true });
const ids = z.array(text);
const candidate = z.object({ commit, sourceDigest: digest, buildDigest: digest,
  specSetHash: digest, barSetHash: digest }).strict();
const spec = z.object({ ref: text, revision: z.number().int().positive(),
  maxConcurrentClaims: z.number().int().positive() }).strict();
const member = z.object({ id: text, effectiveSpec: spec, runtimeState: z.enum(['parked', 'live', 'ended']),
  wakeable: z.boolean(), ownerRestricted: z.boolean(), gateProtected: z.boolean(),
  activeClaims: z.number().int().nonnegative().nullable(), activeIds: ids.nullable(),
  heldIds: ids, blockerParkedIds: ids, admittedIds: ids.nullable(),
  typedBlockers: z.array(z.object({ workItemId: text, ref: text, status: z.literal('active'), receiptRef: text }).strict()),
  disposition: z.enum(['eligible', 'at-capacity', 'protected', 'working', 'historical', 'no-work', 'unknown']),
  reason: text, receiptRef: text,
}).strict();
const recovery = z.object({ snapshotId: text, memberId: text, leaderId: text, leaderReceiptRef: text,
  effectiveSpec: spec, restrictionsRecheckedAt: time, ownerRestricted: z.boolean(), gateProtected: z.boolean(),
  admission: z.object({ memberId: text, effectiveSpec: spec, admittedIds: ids,
    ownerRestricted: z.boolean(), gateProtected: z.boolean(), observedAt: time, receiptRef: text }).strict(),
  control: z.object({ verb: z.enum(['coord:wake', 'coord:send', 'capability:launch-agent']),
    memberId: text, actorId: text, receiptRef: text, invokedAt: time, resumeRef: text.optional() }).strict(),
  turn: z.object({ id: text, memberId: text, triggerReceiptRef: text, startedAt: time }).strict(),
  claim: z.object({ workItemId: text, memberId: text, takenBy: text, takenAt: time,
    receiptRef: text, writers: ids, writerAuditReceiptRef: text }).strict(),
}).strict();
export const recoveryProofSchema = z.object({ schemaVersion: z.literal('luna-capacity-recovery-v1'),
  plan: z.literal(LUNA_CAPACITY_PLAN), candidate,
  snapshot: z.object({ id: text, observedAt: time, generation: text, fleet: text,
    leaderId: text, leaderAfterId: text, fleetCap: z.literal(2), receiptRef: text,
    roster: ids, members: z.array(member) }).strict(),
  recoveries: z.array(recovery),
}).strict();
export type CapacityRecoveryProof = z.infer<typeof recoveryProofSchema>;

const acceptance = z.object({ ref: text, reviewerId: text, authorId: text, implementerIds: ids,
  verdict: z.literal('accept'), pendingFindings: ids, candidate, acceptedAt: time, receiptRef: text }).strict();
export const shipmentProofSchema = z.object({ schemaVersion: z.literal('luna-capacity-shipment-v1'),
  plan: z.literal(LUNA_CAPACITY_PLAN), candidate, acceptance,
  evidence: z.array(z.object({ barKey: z.enum(['R-1', 'R-2', 'R-3', 'R-4', 'R-5']),
    fingerprint: digest, candidate, observedAt: time, receiptRef: text }).strict()),
  green: z.object({ runId: text, verdict: z.literal('green'), candidate,
    ownerId: text, actorId: text, receiptRef: text }).strict(),
  release: z.object({ deployId: text, commit, sourceDigest: digest, buildDigest: digest,
    deployedAt: time, receiptRef: text }).strict(),
  provenance: z.object({ candidateCommit: commit, artifactCommit: commit, sourceDigest: digest,
    inputBuildDigest: digest, artifactDigest: digest, acceptanceRef: text, verifiedBy: text,
    deterministic: z.literal(true), receiptRef: text }).strict().optional(),
  probe: z.object({ runtime: z.literal('release-operator'), sourceDigest: digest,
    buildDigest: digest, observedAt: time, verdict: z.literal('pass'), receiptRef: text }).strict(),
}).strict();
export type CapacityShipmentProof = z.infer<typeof shipmentProofSchema>;
export interface NativeCapacityBarEvidence {
  id: number; barKey: string; specId: string; specRevision: number; currentRevision: number;
  currentness: string; sourceFingerprint: string; sourceMatchesCandidate: boolean;
  commitSha: string | null; worktreeDirty: boolean | null;
  testRunId: number | null; status: string | null; passed: number; failed: number;
  collectionFailed: boolean; observedAt: string;
}
/** Fingerprint the exact native binding/run population, independent of query order.
 * Artifact-authored digests cannot substitute for the records this joins. */
export function capacityBarEvidenceFingerprint(rows: NativeCapacityBarEvidence[]): string {
  return createHash('sha256').update(canonicalJson([...rows].sort((a, b) => a.id - b.id))).digest('hex');
}
export function validateCapacityShipmentEvidence(input: unknown, rows: NativeCapacityBarEvidence[],
  instruments: Array<{ barKey: string; key: string; value: number | null }>): CapacityProofVerdict {
  const parsed = shipmentProofSchema.safeParse(input);
  if (!parsed.success) return { status: 'fail', violations: ['native-shipment-proof-missing'] };
  const p = parsed.data, errors: string[] = [];
  const bars = ['R-1', 'R-2', 'R-3', 'R-4', 'R-5'];
  if (!rows.length || rows.length >= 200 || !unique(rows.map(r => String(r.id)))
    || rows.some(r => !bars.includes(r.barKey))) errors.push('native-shipment-evidence-population');
  for (const e of p.evidence) {
    const group = rows.filter(r => r.barKey === e.barKey);
    // Operational receipts carry the later evidence-publication commit. The
    // registered reader compares every measured source byte with the accepted
    // candidate independently; keep both immutable identities instead of
    // requiring a publication to exist in the candidate it documents.
    if (!group.length || group.some(r => r.currentness !== 'current' || r.specRevision !== r.currentRevision
      || !/^[a-f0-9]{40}$/.test(r.commitSha ?? '') || r.worktreeDirty !== false
      || !r.sourceMatchesCandidate || !/^sha256-file-set-v1:[a-f0-9]{64}$/.test(r.sourceFingerprint)
      || !r.testRunId || !['pass', 'passed'].includes(r.status ?? '') || r.failed !== 0
      || r.passed < 1 || r.collectionFailed || !Number.isFinite(Date.parse(r.observedAt))
      || Date.parse(r.observedAt) > Date.parse(p.acceptance.acceptedAt))
      || e.receiptRef !== 'spec-evidence-set:' + e.barKey
      || e.fingerprint !== capacityBarEvidenceFingerprint(group)
      || Date.parse(e.observedAt) !== Math.max(...group.map(r => Date.parse(r.observedAt))))
      errors.push('native-shipment-evidence:' + e.barKey);
  }
  const expected = [{ barKey: 'R-2', key: LUNA_CAPACITY_INSTRUMENTS.diagnostic },
    { barKey: 'R-4', key: LUNA_CAPACITY_INSTRUMENTS.continuation },
    { barKey: 'R-5', key: LUNA_CAPACITY_INSTRUMENTS.recovery }];
  if (instruments.length !== expected.length || expected.some(e =>
    instruments.filter(i => i.barKey === e.barKey && i.key === e.key && i.value === 1).length !== 1))
    errors.push('native-shipment-current-instruments');
  return { status: errors.length ? 'fail' : 'pass', violations: [...new Set(errors)] };
}
/** Read from the existing resolved independent consult and its authenticated post;
 * the author cannot supply a reviewer identity or a pending-findings assertion. */
export interface NativeCapacityAcceptanceReceipt {
  conversationId: string; acceptedPostId: number | null; state: string;
  postId: number; reviewerId: string; createdAt: string; body: unknown;
  authorId: string | null; implementerIds: string[]; lineageIndependent: boolean;
}
export function validateCapacityShipmentAcceptance(input: unknown, native: NativeCapacityAcceptanceReceipt): CapacityProofVerdict {
  const p = shipmentProofSchema.safeParse(input);
  if (!p.success) return { status: 'fail', violations: ['native-shipment-proof-missing'] };
  const proof = p.data, a = proof.acceptance, body = record(native.body), errors: string[] = [];
  if (native.state !== 'resolved' || native.acceptedPostId !== native.postId
    || a.ref !== native.conversationId || a.receiptRef !== 'thread-post:' + native.postId
    || native.reviewerId !== a.reviewerId || native.createdAt !== a.acceptedAt
    || !native.authorId || native.authorId !== a.authorId || !native.implementerIds.length
    || !sameSet(native.implementerIds, a.implementerIds) || !native.lineageIndependent)
    errors.push('native-shipment-acceptance-custody');
  if (body.verdict !== 'accept' || body.plan !== LUNA_CAPACITY_PLAN
    || canonicalJson(body.candidate) !== canonicalJson(proof.candidate)
    || canonicalJson(body.evidence) !== canonicalJson(proof.evidence)
    || !Array.isArray(body.pendingFindings) || body.pendingFindings.length !== 0)
    errors.push('native-shipment-acceptance-candidate-or-findings');
  if (proof.provenance && canonicalJson(body.provenance) !== canonicalJson(proof.provenance))
    errors.push('native-shipment-provenance-not-reviewed');
  return { status: errors.length ? 'fail' : 'pass', violations: errors };
}
export const diagnosticProofSchema = z.object({ schemaVersion: z.literal('luna-capacity-diagnostic-v1'),
  plan: z.literal(LUNA_CAPACITY_PLAN), candidate,
  runtime: z.object({ id: z.literal('staging-operator'), containsSource: z.literal(true),
    sourceDigest: digest, buildDigest: digest, observedAt: time, receiptRef: text }).strict(),
  scope: z.object({ fleet: text, harness: text, specRef: text.nullable(),
    specRevision: z.number().int().positive().nullable(), populationBasis: text.nullable(), receiptRef: text }).strict(),
  status: z.enum(['measured', 'degraded']), briefCount: z.number().int().nonnegative().nullable(),
  callerCount: z.number().int().nonnegative().nullable(),
  reconciliation: z.object({ specRef: text, specRevision: z.number().int().positive(), harness: text,
    callerFloorExclusions: z.array(z.object({ id: text, reason: text, receiptRef: text }).strict()), receiptRef: text }).strict().optional(),
  diagnosticBudgetMs: z.number().int().min(12_000), deadlineReceiptRef: text,
  degraded: z.object({ reasonClass: text, reason: text, recoveryVerb: text, recoveryActorId: text,
    retryOrEscalationCondition: text, receiptRef: text }).strict().optional(),
}).strict();
export type CapacityDiagnosticProof = z.infer<typeof diagnosticProofSchema>;
export interface CapacityProofVerdict { status: 'pass' | 'fail'; violations: string[] }
export const capacityBriefCaptureSchema = z.object({ invocationId: z.number().int().positive(),
  result: z.record(z.string(), z.unknown()),
}).strict();
const storedCapacityCaptureSchema = z.union([capacityBriefCaptureSchema,
  z.object({ invocationId: z.number().int().positive(), resultFile: z.object({
    path: z.string().regex(/^docs\/evidence\/[a-zA-Z0-9_./-]+\.json$/)
      .refine(path => path.split('/').every(part => part !== '' && part !== '.' && part !== '..')),
    sha256: digest,
  }).strict() }).strict(),
]);
/** Keep the manifest small without changing the full native output being authenticated.
 * The reader must pin the sidecar to the operational receipt's immutable commit. */
export async function resolveCapacityCapture(input: unknown,
  readPinned: (path: string, sha256: string) => Promise<Uint8Array>,
): Promise<z.infer<typeof capacityBriefCaptureSchema>> {
  const capture = storedCapacityCaptureSchema.parse(input);
  if ('result' in capture) return capture;
  const { REPO_FILE_SET_READ_LIMITS } = await import('../agent-tools/plans/committed-tree-reader');
  const bytes = Buffer.from(await readPinned(capture.resultFile.path, capture.resultFile.sha256));
  if (bytes.length > REPO_FILE_SET_READ_LIMITS.maxFileBytes) throw new Error('native-capture-too-large');
  if (createHash('sha256').update(bytes).digest('hex') !== capture.resultFile.sha256)
    throw new Error('native-capture-sha256-mismatch');
  return capacityBriefCaptureSchema.parse({ invocationId: capture.invocationId, result: JSON.parse(bytes.toString('utf8')) });
}
export const capacityAdmissionCapturesSchema = z.array(z.object({ memberId: text,
  capture: storedCapacityCaptureSchema }).strict()).max(100);
export const capacityRuntimeCapturesSchema = z.array(storedCapacityCaptureSchema).min(1).max(32);
/** Read from tool_invocations by the instrument, never from artifact-authored metadata. */
export interface NativeCapacityBriefReceipt {
  id: number; toolName: string; status: string; workspaceId: string; actorId: string | null;
  /** Canonical tool_invocations.invoked_at is dispatch SETTLE time (EI-7040). */
  invokedAt: string; durationMs: number | null; metadata: unknown; args?: unknown;
  servingHost?: string | null; servingProcessId?: string | null; servingBuildSha?: string | null;
}
function observationWithinNativeRun(native: NativeCapacityBriefReceipt, observedAt: unknown,
  window: { now: string; startedAt: string; finishedAt: string }): boolean {
  const [at, settled, start, end, now] = [String(observedAt), native.invokedAt,
    window.startedAt, window.finishedAt, window.now].map(Date.parse);
  const duration = native.durationMs;
  return duration !== null && Number.isFinite(duration) && duration >= 0
    && [at, settled, start, end, now].every(Number.isFinite)
    && start <= settled - duration && settled - duration <= at && at <= settled
    && settled <= end && end <= now && now - at <= 15 * 60_000;
}
/** Source/runtime and admission producers retain this digest in the same
 * invocation ledger. The caller supplies only the row id and captured bytes. */
export function validateCapacityOutputReceipt(capture: unknown, native: NativeCapacityBriefReceipt | null,
  expected: { toolName: string; actorId: string; now: string; startedAt: string; finishedAt: string; sourceMatches: boolean }): CapacityProofVerdict {
  const c = capacityBriefCaptureSchema.safeParse(capture);
  if (!c.success || !native) return { status: 'fail', violations: ['native-output-missing'] };
  const pin = record(record(native.metadata).operationalOutput);
  const errors: string[] = [];
  if (!expected.sourceMatches) errors.push('native-output-source');
  if (native.id !== c.data.invocationId || native.status !== 'ok' || native.toolName !== expected.toolName
    || native.workspaceId !== 'papercusp-workspace' || native.actorId !== expected.actorId || pin.schemaVersion !== 1
    || pin.sha256 !== createHash('sha256').update(canonicalJson(c.data.result)).digest('hex')) errors.push('native-output-custody');
  if (!observationWithinNativeRun(native, pin.observedAt, expected)) errors.push('native-output-stale-or-outside-run');
  return { status: errors.length ? 'fail' : 'pass', violations: errors };
}

/** Join action-time admission to the same member/spec/item before its claim. */
export function validateCapacityAdmissionReceipt(input: unknown, memberId: string, capture: unknown,
  native: NativeCapacityBriefReceipt | null, window: { now: string; startedAt: string; finishedAt: string; sourceMatches: boolean }): CapacityProofVerdict {
  const p = recoveryProofSchema.safeParse(input);
  const c = capacityBriefCaptureSchema.safeParse(capture);
  if (!p.success || !c.success || !native) return { status: 'fail', violations: ['native-admission-missing'] };
  const errors = validateCapacityOutputReceipt(capture, native,
    { ...window, toolName: 'work_items:claimable', actorId: memberId }).violations;
  const recovery = p.data.recoveries.find(r => r.memberId === memberId);
  const data = c.data.result;
  const actualSpec = record(data.spec);
  const contract = record(record(data.countEvidence).contract);
  const caller = record(contract.scope);
  const selector = record(record(contract.population).selector);
  const actualIds = Array.isArray(data.claimable) ? data.claimable.map(v => String(record(v).id)) : [];
  const at = record(record(native.metadata).operationalOutput).observedAt;
  if (!recovery || data.ok !== true || caller.caller !== memberId
    || (record(selector.claimSpec).fleetSlug ?? record(record(data.claimableCallerScope).fleetSpecComparison).fleetSlug) !== p.data.snapshot.fleet
    || data.harness !== record(native.args).harness
    || actualSpec.revision !== recovery.effectiveSpec.revision
    || typeof actualSpec.specId !== 'string' || formatSpecRef(String(actualSpec.specId), actualSpec.revision as number) !== recovery.effectiveSpec.ref
    || recovery.admission.receiptRef !== 'tool-invocation:' + native.id || recovery.admission.observedAt !== at
    || !sameSet(actualIds, recovery.admission.admittedIds) || !actualIds.includes(recovery.claim.workItemId)
    || record(record(record(data.countEvidence).metrics).claimable).exactness == null
    || record(record(record(record(data.countEvidence).metrics).claimable).exactness).status !== 'exact'
    || typeof data.claimableCount !== 'number' || data.claimableCount < actualIds.length) errors.push('native-action-admission');
  return { status: errors.length ? 'fail' : 'pass', violations: errors };
}
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

export interface NativeCapacityOutput {
  capture: z.infer<typeof capacityBriefCaptureSchema>; native: NativeCapacityBriefReceipt; sourceMatches: boolean;
}
export interface NativeCapacityPipelineReceipt {
  id: string; kind: string; status: string; createdAt: string; detail: unknown;
}
export interface NativeCapacityGateActionReceipt {
  id: string; actor: string; action: string; details: unknown;
}
/** Canonical action receipts lock the owning claim through launch; pipeline
 * events prove the later verdict/deployment, rather than merely enqueueing it. */
export function validateCapacityShipmentRelease(input: unknown, native: {
  greenAction: NativeCapacityGateActionReceipt; deployAction: NativeCapacityGateActionReceipt;
  green: NativeCapacityPipelineReceipt; release: NativeCapacityPipelineReceipt;
  runtime: NativeCapacityOutput[];
}, current: { root: string; sources: Array<{ path: string; sha256: string; gitBlob: string }>;
  now: string; startedAt: string; finishedAt: string }): CapacityProofVerdict {
  const parsed = shipmentProofSchema.safeParse(input);
  if (!parsed.success) return { status: 'fail', violations: ['native-shipment-proof-missing'] };
  const p = parsed.data, errors: string[] = [];
  const ga = record(native.greenAction.details), da = record(native.deployAction.details);
  const go = record(ga.ownership), target = record(ga.target), dt = record(da.target);
  const green = record(native.green.detail), release = record(native.release.detail);
  if (native.greenAction.id !== p.green.receiptRef || native.greenAction.action !== 'release:checkpoint-run'
    || native.greenAction.actor !== p.green.actorId || ga.ownerId !== p.green.ownerId
    || ga.schemaVersion !== 2 || ga.phase !== 'settled' || go.certainty !== 'claim-row-locked-through-effect'
    || go.holder !== p.green.ownerId || !text.safeParse(go.workItem).success
    || target.candidate !== p.candidate.commit || record(ga.effect).status !== 'detached-launch-accepted'
    || !Number.isFinite(Date.parse(String(ga.settledAt)))
    || Date.parse(String(ga.settledAt)) > Date.parse(native.green.createdAt)) errors.push('native-shipment-gate-owner');
  if (native.green.kind !== 'green_checkpoint' || green.green !== true
    || !['advanced', 'advanced-prefix', 'up-to-date'].includes(native.green.status)
    || green.fullCandidate !== p.candidate.commit || green.runId !== p.green.runId
    || green.diagnostic === true || green.candidateSource === 'pinned'
    || Date.parse(native.green.createdAt) > Date.parse(p.release.deployedAt)) errors.push('native-shipment-green-verdict');
  const deployOwnership = record(da.ownership);
  if (native.deployAction.id !== p.release.receiptRef || native.deployAction.action !== 'release:deploy'
    || da.schemaVersion !== 2 || da.phase !== 'settled' || da.ownerId !== p.green.ownerId
    || !['claim-row-locked-through-effect', 'no-linked-condition-observed'].includes(String(deployOwnership.certainty))
    || (deployOwnership.certainty === 'claim-row-locked-through-effect' && deployOwnership.holder !== p.green.ownerId)
    || dt.op !== 'trigger' || dt.greenPinSha !== p.release.commit
    || record(da.effect).status !== 'detached-launch-accepted'
    || !(Date.parse(native.green.createdAt) <= Date.parse(String(da.settledAt))
      && Date.parse(String(da.settledAt)) <= Date.parse(native.release.createdAt))) errors.push('native-shipment-deploy-action');
  if (native.release.id !== p.release.deployId || native.release.kind !== 'deploy' || native.release.status !== 'ok'
    || release.fullTargetSha !== p.release.commit || native.release.createdAt !== p.release.deployedAt)
    errors.push('native-shipment-deploy-verdict');
  const paths: string[] = [], observations: number[] = [], receipts: Array<{ path: string; invocationId: number }> = [];
  for (const output of native.runtime) {
    const { capture, native: run, sourceMatches } = output;
    errors.push(...validateCapacityOutputReceipt(capture, run, { ...current, sourceMatches,
      toolName: 'dev:pipeline_position', actorId: run.actorId ?? '' }).violations);
    const args = record(run.args), data = capture.result, accepted = record(data.acceptedSource);
    const observer = record(data.observingRuntime), artifact = record(observer.artifact);
    const source = current.sources.find(s => s.path === args.path);
    if (!source || args.sourceRuntimeOnly !== true || args.expectedSourceSha256 !== source.sha256
      || data.repoRoot !== current.root || data.submodule != null || accepted.matches !== true
      || accepted.expectedSha256 !== source.sha256 || accepted.observedSha256 !== source.sha256
      || record(accepted.runtimeContainment)['release-operator'] !== true
      || observer.host !== 'port-3070' || run.servingHost !== observer.host
      || !run.servingProcessId || observer.processId !== run.servingProcessId
      || observer.buildSha !== run.servingBuildSha || !p.release.commit.startsWith(String(observer.buildSha))
      || artifact.status !== 'measured' || artifact.sourceSha !== p.release.commit
      || artifact.bundleSha256 !== p.release.buildDigest || !digest.safeParse(artifact.manifestSha256).success
      || !text.safeParse(artifact.evidenceRef).success || record(artifact.sourceBlobs)[source.path] !== source.gitBlob)
      errors.push('native-shipment-release-runtime');
    const at = Date.parse(String(record(record(run.metadata).operationalOutput).observedAt));
    if (at < Date.parse(p.release.deployedAt)) errors.push('native-shipment-probe-before-deploy');
    paths.push(String(args.path)); observations.push(at); receipts.push({ path: String(args.path), invocationId: capture.invocationId });
  }
  receipts.sort((a, b) => a.path.localeCompare(b.path));
  if (!current.sources.length || !sameSet(paths, current.sources.map(s => s.path)) || !unique(paths)
    || Date.parse(p.probe.observedAt) !== Math.max(...observations)
    || p.probe.receiptRef !== 'native-release-file-set:' + createHash('sha256').update(canonicalJson(receipts)).digest('hex'))
    errors.push('native-shipment-probe-population');
  return { status: errors.length ? 'fail' : 'pass', violations: [...new Set(errors)] };
}
export interface NativeCapacityRecoveryOperation {
  memberId: string;
  control: NativeCapacityBriefReceipt; claim: NativeCapacityBriefReceipt;
  controlSourceMatches: boolean; claimSourceMatches: boolean;
  delivery: { id: number; workspaceId: string; subscriberId: string; eventKey: string; source: string | null;
    status: string; turnProof: string | null; createdAt: string; deliveredAt: string | null; turnStartedAt: string | null };
  claimAudit: { id: number; workItemId: string; memberId: string; outcome: string; takenAt: string; detail: unknown };
  writers: Array<{ id: number; actorId: string | null }>;
}
/** The audited population is the bounded native write ledger for the same item
 * and claim interval, not an artifact-authored list of purported writers. */
export function capacityWriterAuditRef(workItemId: string, takenAt: string, finishedAt: string,
  writers: NativeCapacityRecoveryOperation['writers']): string {
  return 'native-writer-audit:' + createHash('sha256').update(canonicalJson({ workItemId, takenAt, finishedAt,
    writers: [...writers].sort((a, b) => a.id - b.id) })).digest('hex');
}
export function validateCapacityRecoveryOperations(input: unknown, operations: NativeCapacityRecoveryOperation[],
  after: NativeCapacityOutput, window: { now: string; startedAt: string; finishedAt: string }): CapacityProofVerdict {
  const p = recoveryProofSchema.safeParse(input);
  if (!p.success) return { status: 'fail', violations: ['native-recovery-proof-missing'] };
  const proof = p.data, errors: string[] = [];
  if (!sameSet(operations.map(o => o.memberId), proof.recoveries.map(r => r.memberId))) errors.push('native-recovery-population');
  for (const r of proof.recoveries) {
    const o = operations.find(o => o.memberId === r.memberId);
    if (!o) continue;
    const c = o.control, claim = o.claim, d = o.delivery, audit = o.claimAudit;
    const args = record(c.args), disposition = record(record(claim.metadata).schedulerDisposition);
    const controlStart = Date.parse(c.invokedAt) - (c.durationMs ?? NaN);
    const claimStart = Date.parse(claim.invokedAt) - (claim.durationMs ?? NaN);
    const target = c.toolName === 'coord:wake' ? args.to === r.memberId
      : c.toolName === 'coord:send' && args.wake === 'required'
        && Array.isArray(args.to) && sameSet(args.to as string[], [r.memberId]);
    if (!o.controlSourceMatches || c.workspaceId !== 'papercusp-workspace' || c.status !== 'ok'
      || c.actorId !== proof.snapshot.leaderId || c.toolName !== r.control.verb || !target
      || !Number.isFinite(c.durationMs) || (c.durationMs ?? -1) < 0
      || r.control.receiptRef !== 'tool-invocation:' + c.id || Date.parse(r.control.invokedAt) !== controlStart
      || controlStart < Date.parse(window.startedAt) || Date.parse(c.invokedAt) > Date.parse(window.finishedAt))
      errors.push('native-recovery-control:' + r.memberId);
    // Wake receipts use the coordination store's namespace, independently of
    // the tenant-scoped invocation and scheduler receipts joined above/below.
    if (d.workspaceId !== DEFAULT_COORD_WORKSPACE || d.subscriberId !== r.memberId
      || d.source !== proof.snapshot.leaderId || d.eventKey !== 'coord:inbox-wake:' + r.memberId
      || d.status !== 'delivered' || !['observed', 'host-attested'].includes(d.turnProof ?? '')
      || r.turn.id !== 'event-wake-delivery:' + d.id || d.turnStartedAt !== r.turn.startedAt
      || !d.deliveredAt || !(controlStart <= Date.parse(d.createdAt) && Date.parse(d.createdAt) <= Date.parse(c.invokedAt)
        && Date.parse(d.createdAt) <= Date.parse(d.deliveredAt) && Date.parse(d.deliveredAt) <= Date.parse(r.turn.startedAt)))
      errors.push('native-recovery-turn:' + r.memberId);
    const detail = record(audit.detail);
    if (!o.claimSourceMatches || claim.workspaceId !== 'papercusp-workspace' || claim.status !== 'ok'
      || claim.toolName !== 'scheduler:get_next' || claim.actorId !== r.memberId
      || r.claim.receiptRef !== 'tool-invocation:' + claim.id || disposition.kind !== 'claimed'
      || disposition.workItemId !== r.claim.workItemId || disposition.revision !== r.effectiveSpec.revision
      || typeof disposition.specId !== 'string' || formatSpecRef(disposition.specId, disposition.revision as number) !== r.effectiveSpec.ref
      || audit.workItemId !== r.claim.workItemId || audit.memberId !== r.memberId || audit.outcome !== 'won'
      || audit.takenAt !== r.claim.takenAt || detail.specId !== disposition.specId || detail.revision !== disposition.revision
      || !Number.isFinite(claim.durationMs) || (claim.durationMs ?? -1) < 0
      || !(Date.parse(r.turn.startedAt) <= claimStart && claimStart <= Date.parse(audit.takenAt)
        && Date.parse(audit.takenAt) <= Date.parse(claim.invokedAt) && Date.parse(claim.invokedAt) <= Date.parse(window.finishedAt)))
      errors.push('native-recovery-claim:' + r.memberId);
    const writers = [...new Set(o.writers.map(w => w.actorId))];
    if (!o.writers.length || o.writers.length > 1000 || !unique(o.writers.map(w => String(w.id)))
      || !sameSet(writers as string[], [r.memberId]) || !sameSet(r.claim.writers, writers as string[])
      || r.claim.writerAuditReceiptRef !== capacityWriterAuditRef(r.claim.workItemId, r.claim.takenAt, window.finishedAt, o.writers))
      errors.push('native-recovery-writers:' + r.memberId);
  }
  errors.push(...validateBriefCustody(after.capture, after.native, { ...window, sourceMatches: after.sourceMatches }));
  const pin = record(record(after.native.metadata).identityContribution), scope = record(pin.scope);
  if (after.native.actorId !== proof.snapshot.leaderId || proof.snapshot.leaderAfterId !== after.native.actorId
    || scope.workspace !== 'papercusp-workspace' || scope.fleet !== proof.snapshot.fleet
    || record(after.capture.result.summary).fleet !== proof.snapshot.fleet
    || Date.parse(String(pin.observedAt)) < Math.max(Date.parse(proof.snapshot.observedAt),
      ...proof.recoveries.map(r => Date.parse(r.claim.takenAt)))) errors.push('native-recovery-leader-after');
  return { status: errors.length ? 'fail' : 'pass', violations: [...new Set(errors)] };
}
/** Resolve each source/runtime observation and the caller-only floor difference
 * against producer rows. An internally consistent count pair is insufficient. */
export function validateCapacityDiagnosticOutputs(input: unknown, runtime: NativeCapacityOutput[],
  caller: NativeCapacityOutput | null, current: { root: string; sources: Array<{ path: string; sha256: string; gitBlob: string }>;
    now: string; startedAt: string; finishedAt: string }): CapacityProofVerdict {
  const p = diagnosticProofSchema.safeParse(input);
  if (!p.success || !current.sources.length || !runtime.length) return { status: 'fail', violations: ['native-diagnostic-outputs-missing'] };
  const proof = p.data, errors: string[] = [];
  const paths: string[] = [], observed: number[] = [];
  for (const output of runtime) {
    const { native, capture, sourceMatches } = output;
    errors.push(...validateCapacityOutputReceipt(capture, native,
      { ...current, sourceMatches, toolName: 'dev:pipeline_position', actorId: native.actorId ?? '' }).violations);
    const args = record(native.args), data = capture.result, accepted = record(data.acceptedSource);
    const source = current.sources.find(s => s.path === args.path);
    const entries = Array.isArray(data.servingRuntimes) ? data.servingRuntimes : record(data.servingRuntimes).entries;
    const entry = Array.isArray(entries) ? record(entries.find(e => record(e).runtime === 'staging-operator')) : {};
    const observer = record(data.observingRuntime), artifact = record(observer.artifact);
    const matchesCommit = (sha: unknown) => typeof sha === 'string' && /^[a-f0-9]{7,40}$/.test(sha)
      && proof.candidate.commit.startsWith(sha);
    if (!source || args.sourceRuntimeOnly !== true || args.expectedSourceSha256 !== source.sha256
      || data.repoRoot !== current.root || data.submodule != null || accepted.expectedSha256 !== source.sha256
      || accepted.observedSha256 !== source.sha256 || accepted.matches !== true
      || record(accepted.runtimeContainment)['staging-operator'] !== true
      || entry.containsChange !== true || !matchesCommit(entry.buildSha)) errors.push('native-runtime-containment');
    if (observer.host !== 'port-3170' || observer.host !== native.servingHost
      || !native.servingProcessId || observer.processId !== native.servingProcessId
      || observer.buildSha !== native.servingBuildSha || !matchesCommit(observer.buildSha)
      || artifact.status !== 'measured' || artifact.sourceSha !== proof.candidate.commit
      || artifact.bundleSha256 !== proof.candidate.buildDigest || !digest.safeParse(artifact.manifestSha256).success
      || !text.safeParse(artifact.evidenceRef).success || !source
      || !/^[a-f0-9]{40}$/.test(source.gitBlob) || record(artifact.sourceBlobs)[source.path] !== source.gitBlob)
      errors.push('native-runtime-artifact');
    paths.push(String(args.path));
    observed.push(Date.parse(String(record(record(native.metadata).operationalOutput).observedAt)));
  }
  if (!sameSet(paths, current.sources.map(s => s.path)) || new Set(runtime.map(r => r.native.id)).size !== runtime.length
    || Date.parse(proof.runtime.observedAt) !== Math.max(...observed)) errors.push('native-runtime-population');
  const runtimeRef = 'native-runtime-file-set:' + createHash('sha256')
    .update(canonicalJson(runtime.map(r => ({ path: record(r.native.args).path, invocationId: r.native.id }))
      .sort((a, b) => String(a.path).localeCompare(String(b.path))))).digest('hex');
  if (proof.runtime.receiptRef !== runtimeRef) errors.push('native-runtime-reference');
  if (proof.status === 'degraded') {
    if (caller !== null) errors.push('native-degraded-caller-residue');
  } else if (!caller || !proof.reconciliation) errors.push('native-caller-missing');
  else {
    const { capture, native, sourceMatches } = caller;
    errors.push(...validateCapacityOutputReceipt(capture, native,
      { ...current, sourceMatches, toolName: 'work_items:claimable', actorId: native.actorId ?? '' }).violations);
    const data = capture.result, actualSpec = record(data.spec), count = record(data.countEvidence);
    const scope = record(record(count.contract).scope);
    const sample = record(data.excludedSample);
    const exclusions = ['cooldown', 'planLaneReserved'].flatMap(key => Array.isArray(sample[key])
      ? (sample[key] as unknown[]).map(v => String(record(v).id ?? v)) : []);
    const ref = 'tool-invocation:' + native.id;
    if (data.ok !== true || data.harness !== proof.scope.harness || scope.caller !== native.actorId
      || typeof actualSpec.specId !== 'string' || formatSpecRef(String(actualSpec.specId), actualSpec.revision as number) !== proof.scope.specRef
      || actualSpec.revision !== proof.scope.specRevision || data.claimableCount !== proof.callerCount
      || record(record(record(count.metrics).claimable).exactness).status !== 'exact'
      || proof.reconciliation.receiptRef !== ref
      || proof.reconciliation.callerFloorExclusions.some(e => e.receiptRef !== ref || !exclusions.includes(e.id)))
      errors.push('native-caller-reconciliation');
  }
  return { status: errors.length ? 'fail' : 'pass', violations: errors };
}

/** The existing identity producer hashes the complete, unshaped brief. A saved
 * result is evidence only when its hash resolves to that native producer row. */
function validateBriefCustody(capture: unknown, native: NativeCapacityBriefReceipt | null,
  context: { now: string; startedAt: string; finishedAt: string; sourceMatches: boolean }): string[] {
  const c = capacityBriefCaptureSchema.safeParse(capture);
  if (!c.success || !native) return ['native-brief-missing'];
  const errors: string[] = [];
  const data = c.data.result;
  const pin = record(record(native.metadata).identityContribution);
  const resultHash = createHash('sha256').update(canonicalJson(data)).digest('hex');
  if (native.id !== c.data.invocationId || native.toolName !== 'fleet:leader-brief'
    || native.status !== 'ok' || native.workspaceId !== 'papercusp-workspace'
    || data.ok !== true || data.notLeader || pin.status !== 'bound'
    || pin.identityId !== 'su.fleet-leader' || pin.contributionId !== 'fleet-leader-brief'
    || pin.outputRevision !== resultHash) errors.push('native-brief-custody');
  if (!context.sourceMatches) errors.push('native-brief-source');
  if (!observationWithinNativeRun(native, pin.observedAt, context)) errors.push('native-brief-stale-or-outside-run');
  return errors;
}
export function validateCapacityBriefReceipt(input: unknown, capture: unknown,
  native: NativeCapacityBriefReceipt | null, context: {
    now: string; startedAt: string; finishedAt: string; sourceMatches: boolean;
  }): CapacityProofVerdict {
  const p = diagnosticProofSchema.safeParse(input);
  const r = recoveryProofSchema.safeParse(input);
  const c = capacityBriefCaptureSchema.safeParse(capture);
  if ((!p.success && !r.success) || !c.success || !native) return { status: 'fail', violations: ['native-brief-missing'] };
  const errors = validateBriefCustody(capture, native, context);
  const data = c.data.result, pin = record(record(native.metadata).identityContribution), scope = record(pin.scope);
  const receiptRef = 'tool-invocation:' + native.id;
  const summary = record(data.summary);
  if (p.success) {
    const proof = p.data;
    const actual = record(summary.claimable_now);
    const population = record(actual.population);
    const spec = record(population.spec);
    if (scope.workspace !== native.workspaceId || scope.fleet !== proof.scope.fleet
      || scope.harness !== proof.scope.harness || population.fleet !== proof.scope.fleet
      || population.harness !== proof.scope.harness || proof.scope.receiptRef !== receiptRef
      || proof.scope.specRef !== (spec.ref ?? null) || proof.scope.specRevision !== (spec.revision ?? null)
      || proof.scope.populationBasis !== population.basis || proof.briefCount !== actual.value
      || (proof.status === 'degraded') !== Boolean(actual.unknown)) errors.push('native-diagnostic-population');
  } else if (r.success) {
    const proof = r.data;
    const s = proof.snapshot;
    const members = Array.isArray(data.members) ? data.members.map(record) : [];
    if (scope.workspace !== native.workspaceId || scope.fleet !== s.fleet || summary.fleet !== s.fleet
      || native.actorId !== s.leaderId || s.receiptRef !== receiptRef
      || s.observedAt !== pin.observedAt || !pin.specificationRevision
      || s.generation !== pin.specificationRevision + ':' + pin.outputRevision
      || data.membersTruncated || record(summary.population).complete === false
      || !sameSet(s.roster, members.map(m => String(m.agentId)))
      || s.members.some(m => m.receiptRef !== receiptRef)
      || proof.recoveries.some(r => r.leaderReceiptRef !== receiptRef)) errors.push('native-census-registration');
    for (const m of s.members) {
      const actual = members.find(a => a.agentId === m.id);
      const capacity = record(actual?.parkedCapacity);
      if (!actual || actual.sessionState !== m.runtimeState || actual.wakeable !== m.wakeable
        || (m.runtimeState === 'parked' && (capacity.status !== m.disposition
          || capacity.activeClaims !== m.activeClaims || capacity.maxConcurrentClaims !== m.effectiveSpec.maxConcurrentClaims
          || capacity.specRef !== m.effectiveSpec.ref
          || !sameSet(Array.isArray(capacity.heldIds) ? capacity.heldIds as string[] : [], m.heldIds)
          || !sameSet(Array.isArray(capacity.blockerParkedIds) ? capacity.blockerParkedIds as string[] : [], m.blockerParkedIds))))
        errors.push('native-census-member:' + m.id);
    }
  }
  return { status: errors.length ? 'fail' : 'pass', violations: errors };
}
export interface CapacityContractContext { specSetHash: string; barSetHash: string; sourceFingerprint: string }
/** Context is read from the native measurement and current stores by the instrument. */
export function validateCapacityContractProof(input: unknown, current: CapacityContractContext): CapacityProofVerdict {
  const parsed = z.object({ candidate }).safeParse(input);
  if (!parsed.success) return { status: 'fail', violations: ['missing-candidate-contract'] };
  const c = parsed.data.candidate;
  const violations: string[] = [];
  if (c.specSetHash !== current.specSetHash || c.barSetHash !== current.barSetHash) violations.push('noncanonical-current-contract');
  if (!/^sha256-file-set-v1:[a-f0-9]{64}$/.test(current.sourceFingerprint)
    || c.sourceDigest !== current.sourceFingerprint.split(':')[1]) violations.push('noncanonical-source-digest');
  return { status: violations.length ? 'fail' : 'pass', violations };
}
const unique = (values: string[]) => new Set(values).size === values.length;
const sameSet = (a: string[], b: string[]) => unique(a) && unique(b) && a.length === b.length && a.every(id => b.includes(id));
const sameCandidate = (a: z.infer<typeof candidate>, b: z.infer<typeof candidate>) =>
  a.commit === b.commit && a.sourceDigest === b.sourceDigest && a.buildDigest === b.buildDigest &&
  a.specSetHash === b.specSetHash && a.barSetHash === b.barSetHash;

/** Fail closed on missing fields as well as internally contradictory receipts. */
export function validateCapacityRecoveryProof(input: unknown): CapacityProofVerdict {
  const parsed = recoveryProofSchema.safeParse(input);
  if (!parsed.success) return { status: 'fail', violations: parsed.error.issues.map(i => 'schema:' + i.path.join('.')) };
  const { snapshot: s, recoveries } = parsed.data;
  const errors: string[] = [];
  if (!sameSet(s.roster, s.members.map(m => m.id))) errors.push('census-population');
  if (s.leaderAfterId !== s.leaderId) errors.push('leader-changed');
  const eligible: string[] = [];
  for (const m of s.members) {
    if (m.effectiveSpec.maxConcurrentClaims > s.fleetCap) errors.push('effective-cap-exceeds-fleet:' + m.id);
    if (!unique(m.heldIds) || !unique(m.blockerParkedIds) || !unique(m.admittedIds ?? [])) errors.push('duplicate-member-ids:' + m.id);
    if (m.activeIds !== null && (m.activeClaims !== m.activeIds.length ||
      !sameSet(m.heldIds, [...m.activeIds, ...m.blockerParkedIds]))) errors.push('claim-accounting:' + m.id);
    if (m.blockerParkedIds.some(id => !m.typedBlockers.some(b => b.workItemId === id))) errors.push('untyped-exemption:' + m.id);
    const expected = m.runtimeState === 'ended' ? 'historical' : m.runtimeState === 'live' ? 'working'
      : !m.wakeable || m.ownerRestricted || m.gateProtected ? 'protected'
      : m.activeClaims === null || m.activeIds === null ? 'unknown'
      : m.activeClaims >= m.effectiveSpec.maxConcurrentClaims ? 'at-capacity'
      : m.admittedIds === null ? 'unknown' : m.admittedIds.length === 0 ? 'no-work' : 'eligible';
    if (m.disposition !== expected) errors.push('false-disposition:' + m.id);
    if (expected === 'eligible') eligible.push(m.id);
  }
  if (eligible.length === 0 && s.members.some(m => m.disposition === 'unknown')) errors.push('unknown-is-not-empty');
  if (eligible.length > 0 && recoveries.length === 0) errors.push('eligible-without-pickup');
  if (eligible.length === 0 && recoveries.length > 0) errors.push('recovery-without-eligible-member');
  if (!unique(recoveries.map(r => r.memberId)) || !unique(recoveries.map(r => r.claim.workItemId))) errors.push('duplicate-recovery');
  for (const r of recoveries) {
    if (r.effectiveSpec.maxConcurrentClaims > s.fleetCap) errors.push('recovery-cap-exceeds-fleet:' + r.memberId);
    const m = s.members.find(m => m.id === r.memberId);
    if (!m || !eligible.includes(r.memberId)) { errors.push('ineligible-recovery:' + r.memberId); continue; }
    if (r.snapshotId !== s.id || r.leaderId !== s.leaderId || r.control.actorId !== s.leaderId) errors.push('recovery-authority');
    if (r.effectiveSpec.ref !== m.effectiveSpec.ref || r.effectiveSpec.revision !== m.effectiveSpec.revision ||
      r.effectiveSpec.maxConcurrentClaims !== m.effectiveSpec.maxConcurrentClaims || r.ownerRestricted || r.gateProtected) errors.push('recovery-permission-change');
    if (r.admission.memberId !== m.id || r.admission.ownerRestricted || r.admission.gateProtected
      || canonicalJson(r.admission.effectiveSpec) !== canonicalJson(r.effectiveSpec)
      || !unique(r.admission.admittedIds) || !r.admission.admittedIds.includes(r.claim.workItemId)) errors.push('action-time-admission');
    if (r.control.memberId !== m.id || r.turn.memberId !== m.id || r.claim.memberId !== m.id ||
      r.claim.takenBy !== m.id || !sameSet(r.claim.writers, [m.id]) ||
      !m.admittedIds?.includes(r.claim.workItemId) || m.heldIds.includes(r.claim.workItemId)) errors.push('pickup-identity-or-duplicate-writer');
    if (r.turn.triggerReceiptRef !== r.control.receiptRef ||
      (r.control.verb === 'capability:launch-agent' && !r.control.resumeRef)) errors.push('unmanaged-pickup');
    const [snapshotAt, recheckAt, admittedAt, controlAt, turnAt, claimAt] =
      [s.observedAt, r.restrictionsRecheckedAt, r.admission.observedAt, r.control.invokedAt, r.turn.startedAt, r.claim.takenAt].map(Date.parse);
    if (!(snapshotAt <= recheckAt && recheckAt <= controlAt && controlAt <= turnAt && turnAt <= claimAt
      && recheckAt <= admittedAt && admittedAt <= claimAt) ||
      controlAt - snapshotAt > 15 * 60_000 || controlAt - recheckAt > 5 * 60_000) errors.push('pickup-time-or-stale-recheck');
  }
  return { status: errors.length ? 'fail' : 'pass', violations: [...new Set(errors)] };
}

export function validateCapacityShipmentProof(input: unknown): CapacityProofVerdict {
  const parsed = shipmentProofSchema.safeParse(input);
  if (!parsed.success) return { status: 'fail', violations: parsed.error.issues.map(i => 'schema:' + i.path.join('.')) };
  const p = parsed.data;
  const errors: string[] = [];
  const a = p.acceptance;
  if (!a.implementerIds.length || !unique(a.implementerIds) || a.reviewerId === a.authorId ||
    a.implementerIds.includes(a.reviewerId) || a.pendingFindings.length) errors.push('acceptance-not-independent-or-settled');
  if (!sameCandidate(p.candidate, a.candidate) || !sameCandidate(p.candidate, p.green.candidate)) errors.push('candidate-identity');
  if (!sameSet(p.evidence.map(e => e.barKey), ['R-1', 'R-2', 'R-3', 'R-4', 'R-5']) ||
    p.evidence.some(e => !sameCandidate(e.candidate, p.candidate) || Date.parse(e.observedAt) > Date.parse(a.acceptedAt))) errors.push('r1-r5-proof-join');
  if (p.green.actorId !== p.green.ownerId) errors.push('live-gate-owner');
  if (p.release.sourceDigest !== p.candidate.sourceDigest) errors.push('released-source-identity');
  if (p.release.commit !== p.candidate.commit || p.release.buildDigest !== p.candidate.buildDigest) {
    const chain = p.provenance;
    if (!chain || chain.candidateCommit !== p.candidate.commit || chain.artifactCommit !== p.release.commit ||
      chain.sourceDigest !== p.candidate.sourceDigest || chain.inputBuildDigest !== p.candidate.buildDigest ||
      chain.artifactDigest !== p.release.buildDigest || chain.acceptanceRef !== a.ref || chain.verifiedBy !== a.reviewerId) errors.push('release-provenance-chain');
  }
  if (p.probe.sourceDigest !== p.release.sourceDigest || p.probe.buildDigest !== p.release.buildDigest) errors.push('release-runtime-identity');
  if (!(Date.parse(a.acceptedAt) <= Date.parse(p.release.deployedAt) &&
    Date.parse(p.release.deployedAt) <= Date.parse(p.probe.observedAt))) errors.push('shipment-order');
  return { status: errors.length ? 'fail' : 'pass', violations: [...new Set(errors)] };
}

export function validateCapacityDiagnosticProof(input: unknown): CapacityProofVerdict {
  const parsed = diagnosticProofSchema.safeParse(input);
  if (!parsed.success) return { status: 'fail', violations: parsed.error.issues.map(i => 'schema:' + i.path.join('.')) };
  const p = parsed.data;
  const errors: string[] = [];
  if (p.runtime.sourceDigest !== p.candidate.sourceDigest || p.runtime.buildDigest !== p.candidate.buildDigest) errors.push('serving-source-identity');
  if (p.status === 'degraded') {
    if (p.briefCount !== null || p.callerCount !== null || p.reconciliation || !p.degraded) errors.push('degraded-not-explicit-unknown');
  } else {
    if (p.degraded) errors.push('measured-with-degraded-residue');
    const r = p.reconciliation;
    if (p.briefCount === null || p.callerCount === null || !r || p.scope.specRef === null || p.scope.specRevision === null) errors.push('measured-scope-incomplete');
    else {
      if (r.specRef !== p.scope.specRef || r.specRevision !== p.scope.specRevision || r.harness !== p.scope.harness) errors.push('caller-population-mismatch');
      const exclusions = r.callerFloorExclusions.map(e => e.id);
      if (!unique(exclusions) || p.briefCount !== p.callerCount + exclusions.length) errors.push('unreconciled-caller-floors');
    }
  }
  return { status: errors.length ? 'fail' : 'pass', violations: errors };
}

/** Native ledger coverage, not a hand-written claim that the named scenarios ran. */
const continuationBindingsSchema = z.array(z.object({ bindingId: z.number().int().positive(),
  testRunId: z.number().int().positive(), currentness: z.literal('current'), status: z.enum(['pass', 'passed']),
  failed: z.literal(0), passed: z.number().int().positive(), collectionFailed: z.literal(false),
  testLayer: z.enum(['unit', 'llm']), filePath: text, scenarioId: text.optional(), passedCaseTitles: ids.optional(),
  sourceFingerprint: text, nativeRunIds: ids.optional(),
}).strict()).min(1).max(20);
export function validateCapacityContinuationProof(input: unknown): CapacityProofVerdict {
  const parsed = continuationBindingsSchema.safeParse(input);
  if (!parsed.success) return { status: 'fail', violations: parsed.error.issues.map(i => 'schema:' + i.path.join('.')) };
  const rows = parsed.data;
  const errors: string[] = [];
  if (!unique(rows.map(r => String(r.bindingId))) || !unique(rows.map(r => String(r.testRunId)))) errors.push('duplicate-native-binding');
  if (new Set(rows.map(r => r.sourceFingerprint)).size !== 1) errors.push('mixed-candidate-source');
  const nativeIds = rows.flatMap(r => r.nativeRunIds ?? []);
  if (!unique(nativeIds)) errors.push('duplicate-native-llm-run');
  for (const row of rows.filter(r => r.testLayer === 'llm')) {
    if (!row.filePath.endsWith('/su/S42-drain-watch-recheck.ts') || !row.nativeRunIds?.length
      || row.nativeRunIds.length !== row.passed) errors.push('unverified-native-llm-run:' + row.bindingId);
  }
  for (const arrival of ['preexisting', 'during-registration', 'empty']) {
    if (!rows.some(r => r.testLayer === 'llm' && r.scenarioId === 'su-S42-drain-watch-' + arrival)) errors.push('missing-native-arrival:' + arrival);
  }
  const unit = (suffix: string) => rows.filter(r => r.testLayer === 'unit' && r.filePath.endsWith(suffix));
  if (!unit('/events/watch.test.ts').some(r => r.passedCaseTitles?.some(t => t.includes('the drained-lane contract is IDEMPOTENT')))) errors.push('missing-watch-guard');
  for (const client of ['codex', 'claude']) {
    if (!unit('/scheduler/idle-loop-recipe-pin.test.ts').some(r => r.passedCaseTitles?.some(t => t.includes('fresh ' + client + ' member render')))) errors.push('missing-fresh-render:' + client);
  }
  if (!unit('/su/S42-drain-watch-recheck.test.ts').some(r => ['preexisting', 'during-registration', 'empty'].every(arrival =>
    r.passedCaseTitles?.some(t => t.includes('accepts the correct ' + arrival + ' lifecycle'))))) errors.push('missing-lifecycle-calibration');
  return { status: errors.length ? 'fail' : 'pass', violations: errors };
}

export interface NativeCapacityLlmRun {
  id: string; scenarioId: string; scenarioVersion: number; scenarioHash: string; identityHash: string;
  personaId: string; personaTraits: PersonaTraits; rubricVersion: string; sutModel: string; judgeModel: string;
  status: string; turns: Parameters<typeof judgeS42Run>[1]['turns']; rawEvents: Array<{ name: string; data: unknown }>;
}
export interface NativeCapacityLlmContext {
  scenarioId: string; scenarioVersion: number; scenarioHash: string; personaId: string; personaTraits: PersonaTraits;
  rubricVersion: string; provider: 'anthropic' | 'codex'; systemSha256: string[];
}
/** Replays original model calls; success labels and a matching scenario name are insufficient. */
export function validateCapacityNativeLlmRun(run: NativeCapacityLlmRun, expected: NativeCapacityLlmContext): CapacityProofVerdict {
  const violations: string[] = [];
  const kind = S42_CASES.find(kind => expected.scenarioId === 'su-S42-drain-watch-' + kind);
  if (!kind || !run.id || run.status !== 'passed' || run.scenarioId !== expected.scenarioId
    || run.scenarioVersion !== expected.scenarioVersion || run.scenarioHash !== expected.scenarioHash
    || run.personaId !== expected.personaId || canonicalJson(run.personaTraits) !== canonicalJson(expected.personaTraits)
    || run.rubricVersion !== expected.rubricVersion || !run.sutModel || !run.judgeModel) violations.push('native-llm-identity');
  const identity = computeIdentityHash({ ...expected, sutModel: run.sutModel, judgeModel: run.judgeModel,
    judgeScaffoldVersion: JUDGE_PROMPT_SCAFFOLD_VERSION });
  if (run.identityHash !== identity) violations.push('native-llm-composite-identity');
  const manifests = run.rawEvents.filter(event => event.name === 'tool_definition_manifest');
  if (!manifests.length) violations.push('native-prompt-manifest-missing');
  for (const event of manifests) {
    const parsed = z.object({ schemaVersion: z.literal('su-tool-definitions-v1'), provider: z.literal(expected.provider),
      systemSha256: digest, sha256: digest, definitions: z.array(z.unknown()) }).safeParse(event.data);
    if (!parsed.success || !expected.systemSha256.includes(parsed.data.systemSha256)
      || createHash('sha256').update(JSON.stringify(parsed.data.definitions)).digest('hex') !== parsed.data.sha256)
      violations.push('native-prompt-or-client-mismatch');
  }
  if (!Array.isArray(run.turns) || !run.turns.length || run.turns.some(turn => !Array.isArray(turn.toolCalls)
    || turn.toolCalls.some(call => typeof call.name !== 'string' || !call.input || typeof call.input !== 'object')))
    violations.push('native-trace-malformed');
  else {
    const normalizedCalls = run.turns.flatMap(turn => turn.toolCalls).map(({ name, input }) => ({ name, input }));
    const originalCalls = run.rawEvents.filter(event => event.name === 'tool_call').map(event => {
      const data = event.data as { name?: unknown; input?: unknown };
      return { name: data?.name, input: data?.input };
    });
    if (canonicalJson(originalCalls) !== canonicalJson(normalizedCalls)) violations.push('native-trace-custody-mismatch');
    if (kind) violations.push(...judgeS42Run(kind, { turns: run.turns }).map(v => v.assertKind));
  }
  return { status: violations.length ? 'fail' : 'pass', violations: [...new Set(violations)] };
}

/** Extend the existing instrument surface; no new tool, store or polling loop. */
export function lunaCapacityInstruments(root: string): CommandInstrument[] {
  return (['recovery', 'shipment', 'diagnostic', 'continuation'] as const).map(phase => ({
    key: LUNA_CAPACITY_INSTRUMENTS[phase], evaluator: 'command', unit: 'count', timeoutMs: 120_000,
    description: 'Validate current native spec evidence: serving diagnostic, watch/recheck layers, census/pickup, or independently accepted release identity. 1 valid, 0 contradicted, absent/unreadable unknown.',
    argv: [process.execPath, '--import', 'tsx', join(root, 'scripts/verify-fleet-capacity-recovery.mts'), root, phase],
    parse(stdout: string) {
      try {
        const r = JSON.parse(stdout.trim());
        if (r.scope !== 'luna-capacity-semantic-v1' || r.phase !== phase || !Array.isArray(r.bindingIds) || !r.bindingIds.length) return null;
        return r.status === 'pass' ? 1 : r.status === 'fail' ? 0 : null;
      } catch { return null; }
    },
  }));
}
