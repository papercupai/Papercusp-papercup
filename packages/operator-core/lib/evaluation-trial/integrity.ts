/**
 * Evidence integrity and replay (plan
 * `llm-agent-evaluation-measurement-integrity-2026-08-25`, item P-005).
 *
 * ## The three refusal classes P-005 names
 *
 * P-005's assertion requires that "corruption, missing artifacts, or identity
 * mismatch fails". Those are three genuinely different faults and they are
 * reported as three distinct findings, because the repair for each differs:
 *
 *   - `evidence-corrupt`  — the bytes resolved, and they are NOT the bytes that
 *                           were graded. The stored verdict is about something
 *                           else. Nothing here is recoverable by retrying.
 *   - `artifact-missing`  — a part the manifest names could not be produced. The
 *                           verdict may still be sound; it is simply no longer
 *                           checkable, which is a different (and often recoverable)
 *                           situation from corruption.
 *   - `identity-mismatch` — the evidence is intact but belongs to a different
 *                           trial, or the trial's own binding is incomplete so no
 *                           attachment can be established at all.
 *
 * ## An UNSEALED envelope is a failure, not a pass
 *
 * The most dangerous input this function can receive is an envelope with no
 * `contentHash`. It has nothing to disagree with, so a naive verifier finds no
 * mismatch and returns ok — turning "we never recorded a hash" into "verified",
 * which is exactly the direction D-021 forbids an unknown to fail in.
 *
 * `evidence-unsealed` therefore exists and is a hard failure. The distinction is
 * carried faithfully: an envelope whose `contentHash` is `undefined` was never
 * sealed, while one recording `null` states that the source has no hash to give —
 * both refuse, and they refuse with different findings so the fix is obvious.
 *
 * ## What "replay" can and cannot reproduce
 *
 * `replayTrialEvidence` re-derives everything that IS derived — the evidence seal,
 * the trial identity, and the compact judge view — and compares each against what
 * was stored. It does NOT re-run a model, and could not: identity.ts states the
 * premise this whole contract rests on, that LLM evaluation structurally cannot
 * re-derive its verdict on demand. That is precisely why binding and integrity are
 * the mechanisms available, and why a claim that replay "reproduces the outcome"
 * must mean the derived artifacts and never the grader's judgement.
 *
 * @see evidence.ts   — the seal being verified
 * @see judge-view.ts — the derived view replay reproduces
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../external-bench/reproducibility/canonical-json';
import { sealEvidence, type EvidenceManifest, type PreservedEvidence, type TrajectoryStep } from './evidence';
import { computeTrialIdentity, type TrialIdentity } from './identity';
import {
  DEFAULT_JUDGE_VIEW_POLICY,
  deriveJudgeView,
  verifyJudgeView,
  type CompactJudgeView,
  type JudgeViewPolicy,
  type JudgeViewVerification,
} from './judge-view';
import type { EvaluationTrial, EvidenceEnvelope } from './schema';

/** How an evidence set failed verification. */
export type IntegrityFailureKind =
  /** A part resolved, but its content hash differs from the manifest's. */
  | 'evidence-corrupt'
  /** A part the manifest names was not present in the resolved evidence. */
  | 'artifact-missing'
  /** The resolved evidence carries a part the manifest does not name. */
  | 'part-unexpected'
  /** The evidence belongs to a different trial, or the trial's binding is incomplete. */
  | 'identity-mismatch'
  /** The envelope carries no content hash at all — unverifiable, never "verified". */
  | 'evidence-unsealed'
  /** Fewer steps than the manifest recorded: a partial trajectory. */
  | 'trajectory-truncated'
  /** The step indices are not a complete 0..n-1 run: a trajectory with a hole. */
  | 'trajectory-hole'
  | 'completion-contract-invalid'
  | 'completion-artifact-missing'
  | 'durable-transition-missing'
  | 'context-delivery-mismatch'
  | 'downstream-outcome-missing';

/** Frozen completion criteria, supplied by the existing workload's declaration. */
export interface WorkloadCompletionRequirements {
  artifacts: Array<{ id: string; minBytes: number; sha256?: string }>;
  /** Required transitions in their causal order. */
  transitions: Array<{
    id: string; subjectRef: string; from: string; to: string;
    /** Omitted means all declared inputs; [] explicitly needs no input. */
    afterContextIds?: string[];
  }>;
  context: Array<{
    id: string; consumer: string; sha256: string;
    /** A result/checkpoint input must be delivered after its producer receipt. */
    afterTransitionId?: string;
  }>;
  downstream: { id: string; value: string | number | boolean; graderRef: string };
}

/** One concrete integrity fault, with enough detail to act on. */
export interface IntegrityFinding {
  kind: IntegrityFailureKind;
  /** The part id this concerns, when the fault is about one part. */
  part?: string;
  expected?: string;
  actual?: string;
  detail: string;
}

/** The verdict on one evidence set. */
export interface IntegrityReport {
  ok: boolean;
  findings: IntegrityFinding[];
  /** How many manifest parts were actually checked — a bounded check must say its bound. */
  partsChecked: number;
  /** The root hash recomputed from the resolved evidence. */
  recomputedRootHash: string;
  /** Present only for a declared workload completion check. */
  completionRequirementsHash?: string;
}

/** What `verifyEvidence` is given. */
export interface VerifyEvidenceInput {
  /** The manifest recorded when the evidence was sealed. */
  manifest: EvidenceManifest;
  /** The evidence as resolved back — what a replay actually got hold of. */
  evidence: PreservedEvidence;
  /** The envelope stored beside the verdict, when there is one to cross-check. */
  envelope?: Pick<EvidenceEnvelope, 'contentHash'>;
  /** The trial this evidence is claimed to belong to. */
  trial?: EvaluationTrial;
  /** The identity the evidence was sealed under, when one was recorded. */
  expectedIdentity?: TrialIdentity;
  /**
   * Refs a resolver could not fetch. Declared explicitly rather than inferred from
   * a shorter artifact list, so "the resolver failed" and "the source never
   * recorded it" stay distinguishable.
   */
  unresolvedRefs?: string[];
  /** Exit status is never a substitute for these declared outcome observations. */
  completionRequirements?: WorkloadCompletionRequirements;
  /** Required for workload completion: actual bytes read from each artifact ref. */
  resolvedArtifactContents?: Array<{ id: string; ref?: string | null; content: Uint8Array }>;
  /** Independently projected observations read from the receipt authority.
   * Candidate trajectory metadata is a claim, never its own receipt proof. */
  resolvedWorkloadObservations?: TrajectoryStep[];
}

const textPresent = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Checks resolved observations; callers must resolve receipts from their authority. */
function verifyWorkloadCompletion(input: VerifyEvidenceInput, findings: IntegrityFinding[]): string {
  const requirements = input.completionRequirements!;
  const requirementsHash = sha256(canonicalJson(requirements));
  const validNames = (rows: Array<{ id: string }>) => rows.every(row => textPresent(row.id)) && new Set(rows.map(row => row.id)).size === rows.length;
  const digestValid = (value: string) => /^[a-f0-9]{64}$/.test(value);
  const contexts = new Map(requirements.context.map(row => [row.id, row]));
  const transitionOrder = new Map(requirements.transitions.map((row, index) => [row.id, index]));
  const contextPrerequisites = (row: WorkloadCompletionRequirements['transitions'][number]) => row.afterContextIds ?? [...contexts.keys()];
  if (!requirements.artifacts.length || !requirements.transitions.length ||
      ![requirements.artifacts, requirements.transitions, requirements.context].every(validNames) ||
      requirements.artifacts.some(row => !Number.isSafeInteger(row.minBytes) || row.minBytes < 1 || row.sha256 !== undefined && !digestValid(row.sha256)) ||
      requirements.transitions.some(row => ![row.subjectRef, row.from, row.to].every(textPresent) || row.from === row.to) ||
      requirements.context.some(row => !textPresent(row.consumer) || !digestValid(row.sha256)) ||
      requirements.context.some(row => row.afterTransitionId !== undefined && !transitionOrder.has(row.afterTransitionId)) ||
      requirements.transitions.some((row, index) => {
        const ids = contextPrerequisites(row);
        return !Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => {
          const context = contexts.get(id);
          return !context || context.afterTransitionId !== undefined && transitionOrder.get(context.afterTransitionId)! >= index;
        });
      }) ||
      !textPresent(requirements.downstream.id) || !textPresent(requirements.downstream.graderRef) ||
      !['string', 'number', 'boolean'].includes(typeof requirements.downstream.value) ||
      typeof requirements.downstream.value === 'number' && !Number.isFinite(requirements.downstream.value)) {
    findings.push({ kind: 'completion-contract-invalid', detail: 'Completion needs valid artifact/transition/context/outcome criteria and acyclic prerequisites referencing declared inputs and earlier transitions.' });
    return requirementsHash;
  }
  if (!input.trial || !input.expectedIdentity?.bindingComplete || !input.envelope?.contentHash) {
    findings.push({ kind: 'identity-mismatch', detail: 'Workload completion requires a sealed envelope, trial and complete independently expected identity.' });
    return requirementsHash;
  }
  // Bind observations to this exact run as well as its comparable configuration.
  const observed = (step: TrajectoryStep) => {
    const metadata = step.metadata;
    if (metadata?.trialBindingHash !== input.expectedIdentity!.bindingHash ||
        metadata.runId !== input.trial!.lineage.runId || !textPresent(metadata.receiptRef)) return false;
    const resolved = input.resolvedWorkloadObservations?.filter(value =>
      value.index === step.index && value.metadata?.receiptRef === metadata.receiptRef) ?? [];
    return resolved.length === 1 && canonicalJson(resolved[0]) === canonicalJson(step);
  };
  for (const required of requirements.artifacts) {
    const matches = input.evidence.artifacts.filter(artifact => artifact.id === required.id);
    const artifact = matches[0];
    const resolved = input.resolvedArtifactContents?.filter(value => value.id === required.id) ?? [];
    const content = resolved[0];
    if (matches.length !== 1 || !artifact || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < required.minBytes ||
        !digestValid(artifact.sha256) || required.sha256 !== undefined && artifact.sha256 !== required.sha256 ||
        resolved.length !== 1 || !(content?.content instanceof Uint8Array) || content.ref !== artifact.ref ||
        content.content.byteLength !== artifact.bytes || createHash('sha256').update(content.content).digest('hex') !== artifact.sha256) {
      findings.push({ kind: 'completion-artifact-missing', part: required.id, detail: 'Required completion artifact is missing, duplicated, empty or its resolved ref/bytes differ from the declared content.' });
    }
  }
  const transitionReceipts = new Map(requirements.transitions.map(required => [required.id, input.evidence.trajectory.filter(step => {
    if (step.kind !== 'tool-result') return false;
    const transition = step.metadata?.durableTransition as Record<string, unknown> | undefined;
    return transition?.id === required.id && transition.subjectRef === required.subjectRef && transition.from === required.from && transition.to === required.to;
  })]));
  const contextIndices = new Map<string, number>();
  let latestRequiredInput = -1;
  for (const required of requirements.context) {
    const matches = input.evidence.trajectory.filter(step => step.kind === 'input' && step.role === required.consumer &&
      step.metadata?.contextId === required.id && sha256(step.content) === required.sha256);
    const producer = required.afterTransitionId === undefined ? undefined : transitionReceipts.get(required.afterTransitionId);
    if (matches.length !== 1 || !observed(matches[0]) ||
        producer !== undefined && (producer.length !== 1 || !observed(producer[0]) || matches[0].index <= producer[0].index)) {
      findings.push({ kind: 'context-delivery-mismatch', part: required.id, detail: 'Required context bytes lack a unique sealed input for the declared consumer and run after their producing transition.' });
    } else {
      contextIndices.set(required.id, matches[0].index);
      latestRequiredInput = Math.max(latestRequiredInput, matches[0].index);
    }
  }
  let latestRequiredTransition = -1;
  let priorTransitionMissing = false;
  for (const required of requirements.transitions) {
    const matches = transitionReceipts.get(required.id)!;
    const inputs = contextPrerequisites(required);
    if (matches.length !== 1 || !observed(matches[0]) || priorTransitionMissing || matches[0].index <= latestRequiredTransition ||
        inputs.some(id => !contextIndices.has(id) || matches[0].index <= contextIndices.get(id)!)) {
      findings.push({ kind: 'durable-transition-missing', part: required.id, detail: 'Required durable transition lacks a unique run-bound receipt after its prerequisite inputs and preceding transitions.' });
      priorTransitionMissing = true;
    } else latestRequiredTransition = matches[0].index;
  }
  const results = input.evidence.trajectory.filter(step => {
    if (step.kind !== 'tool-result' || step.index <= Math.max(latestRequiredInput, latestRequiredTransition)) return false;
    const outcome = step.metadata?.workloadOutcome as Record<string, unknown> | undefined;
    return outcome?.id === requirements.downstream.id && outcome.value === requirements.downstream.value && outcome.graderRef === requirements.downstream.graderRef;
  });
  if (results.length !== 1 || !observed(results[0])) findings.push({ kind: 'downstream-outcome-missing', part: requirements.downstream.id,
    detail: 'Required downstream graded outcome lacks a unique run-bound receipt after the required context and transitions.' });
  return requirementsHash;
}

/**
 * Verify resolved evidence against the manifest it was sealed under.
 *
 * Re-seals what was resolved and compares part by part, so a failure names the
 * part rather than only the root. Every finding is returned — verification does
 * not stop at the first fault, because "the submission is corrupt AND two
 * artifacts are missing" is a materially different situation from either alone.
 */
export function verifyEvidence(input: VerifyEvidenceInput): IntegrityReport {
  const { manifest, evidence, envelope, trial, expectedIdentity, unresolvedRefs } = input;
  const findings: IntegrityFinding[] = [];

  const resealed = sealEvidence(evidence);
  const recomputed = resealed.manifest;

  const expectedParts = new Map(manifest.parts.map((p) => [p.id, p]));
  const actualParts = new Map(recomputed.parts.map((p) => [p.id, p]));

  for (const [id, expected] of expectedParts) {
    const actual = actualParts.get(id);
    if (!actual) {
      findings.push({
        kind: 'artifact-missing',
        part: id,
        expected: expected.sha256,
        detail: `manifest names part "${id}" but the resolved evidence does not carry it`,
      });
      continue;
    }
    if (actual.sha256 !== expected.sha256) {
      findings.push({
        kind: 'evidence-corrupt',
        part: id,
        expected: expected.sha256,
        actual: actual.sha256,
        detail: `part "${id}" resolved to different content than was sealed`,
      });
    } else if (actual.bytes !== expected.bytes) {
      // Same hash, different declared length: the content is right and the
      // bookkeeping is wrong. Reported as corruption of the manifest, not of the
      // content, so nobody goes hunting for a byte difference that is not there.
      findings.push({
        kind: 'evidence-corrupt',
        part: id,
        expected: String(expected.bytes),
        actual: String(actual.bytes),
        detail: `part "${id}" hashes correctly but its recorded byte length disagrees`,
      });
    }
  }

  for (const id of actualParts.keys()) {
    if (!expectedParts.has(id)) {
      findings.push({
        kind: 'part-unexpected',
        part: id,
        detail: `resolved evidence carries part "${id}", which the manifest does not name`,
      });
    }
  }

  for (const ref of unresolvedRefs ?? []) {
    findings.push({
      kind: 'artifact-missing',
      part: ref,
      detail: `resolver reported it could not fetch "${ref}"`,
    });
  }

  if (recomputed.stepCount < manifest.stepCount) {
    findings.push({
      kind: 'trajectory-truncated',
      expected: String(manifest.stepCount),
      actual: String(recomputed.stepCount),
      detail: `resolved trajectory is shorter than the sealed one`,
    });
  }

  // A trajectory whose indices are not 0..n-1 has a hole or a duplicate, which no
  // part hash can reveal on its own: each surviving step still hashes correctly.
  const indices = evidence.trajectory.map((s) => s.index).sort((a, b) => a - b);
  const contiguous = indices.every((value, position) => value === position);
  if (indices.length > 0 && !contiguous) {
    findings.push({
      kind: 'trajectory-hole',
      expected: `0..${indices.length - 1}`,
      actual: indices.join(','),
      detail: `trajectory step indices are not a complete run — a step is missing or duplicated`,
    });
  }

  if (envelope) {
    if (envelope.contentHash === undefined) {
      findings.push({
        kind: 'evidence-unsealed',
        detail: 'envelope records no content hash — the evidence was never sealed, so it cannot be verified',
      });
    } else if (envelope.contentHash === null) {
      findings.push({
        kind: 'evidence-unsealed',
        detail: 'envelope records its content hash as absent — the source has no hash to verify against',
      });
    } else if (envelope.contentHash !== manifest.rootHash) {
      findings.push({
        kind: 'identity-mismatch',
        expected: manifest.rootHash,
        actual: envelope.contentHash,
        detail: 'envelope content hash does not match the manifest it is paired with',
      });
    }
  }

  if (recomputed.rootHash !== manifest.rootHash && !findings.some((f) => f.kind === 'evidence-corrupt')) {
    // The root moved but no individual part did: something outside the part list
    // changed — an empty slot's token, or the privacy class.
    findings.push({
      kind: 'evidence-corrupt',
      expected: manifest.rootHash,
      actual: recomputed.rootHash,
      detail:
        'evidence root hash changed while every named part matched — an unsealed field ' +
        '(a recorded-absent slot, or the privacy class) differs',
    });
  }

  if (trial) {
    const identity = computeTrialIdentity(trial);
    if (!identity.bindingComplete) {
      findings.push({
        kind: 'identity-mismatch',
        detail:
          `trial identity is incomplete (missing: ${identity.missingBindings.join(', ')}) — ` +
          'evidence cannot be bound to a trial whose comparability is unestablished',
      });
    }
    if (expectedIdentity && identity.bindingHash !== expectedIdentity.bindingHash) {
      findings.push({
        kind: 'identity-mismatch',
        expected: expectedIdentity.bindingHash,
        actual: identity.bindingHash,
        detail: 'evidence was sealed under a different trial binding than the trial it is attached to',
      });
    }
  }

  const completionRequirementsHash = input.completionRequirements ? verifyWorkloadCompletion(input, findings) : undefined;
  return {
    ok: findings.length === 0,
    findings,
    partsChecked: expectedParts.size,
    recomputedRootHash: recomputed.rootHash,
    ...(completionRequirementsHash === undefined ? {} : { completionRequirementsHash }),
  };
}

/** The result of replaying a trial's evidence end to end. */
export interface ReplayReport {
  ok: boolean;
  integrity: IntegrityReport;
  /** Present only when a stored judge view was supplied to check against. */
  judgeView: JudgeViewVerification | null;
  /** The view re-derived from the resolved evidence — the judge input, reproduced. */
  derivedJudgeView: CompactJudgeView;
  /** True when the re-derived view is byte-identical to the stored one. */
  judgeViewReproduced: boolean | null;
}

/**
 * Replay a trial's evidence: verify integrity, then re-derive the judge input and
 * compare it to what was stored.
 *
 * `storedJudgeView` is optional because replay is useful before any view has been
 * stored (deriving one for the first time). When it IS supplied, reproduction is
 * checked by hash rather than by eye, and `judgeViewReproduced` is the answer.
 */
export function replayTrialEvidence(input: {
  trial: EvaluationTrial;
  evidence: PreservedEvidence;
  manifest: EvidenceManifest;
  envelope?: Pick<EvidenceEnvelope, 'contentHash'>;
  expectedIdentity?: TrialIdentity;
  unresolvedRefs?: string[];
  completionRequirements?: WorkloadCompletionRequirements;
  resolvedArtifactContents?: VerifyEvidenceInput['resolvedArtifactContents'];
  resolvedWorkloadObservations?: VerifyEvidenceInput['resolvedWorkloadObservations'];
  storedJudgeView?: CompactJudgeView;
  policy?: JudgeViewPolicy;
}): ReplayReport {
  const policy = input.policy ?? input.storedJudgeView?.policy ?? DEFAULT_JUDGE_VIEW_POLICY;

  const integrity = verifyEvidence({
    manifest: input.manifest,
    evidence: input.evidence,
    envelope: input.envelope,
    completionRequirements: input.completionRequirements,
    resolvedArtifactContents: input.resolvedArtifactContents,
    resolvedWorkloadObservations: input.resolvedWorkloadObservations,
    trial: input.trial,
    expectedIdentity: input.expectedIdentity,
    unresolvedRefs: input.unresolvedRefs,
  });

  const derivedJudgeView = deriveJudgeView(input.trial, input.evidence, input.manifest, policy);

  let judgeView: JudgeViewVerification | null = null;
  let judgeViewReproduced: boolean | null = null;
  if (input.storedJudgeView) {
    judgeView = verifyJudgeView(input.storedJudgeView, input.trial, input.manifest);
    judgeViewReproduced = input.storedJudgeView.viewHash === derivedJudgeView.viewHash;
  }

  return {
    ok: integrity.ok && (judgeView?.ok ?? true) && (judgeViewReproduced ?? true),
    integrity,
    judgeView,
    derivedJudgeView,
    judgeViewReproduced,
  };
}

/** Host-owned readers must enforce the frozen private workload's reference
 * allowlist and project the actual native/ledger receipt into TrajectorySteps.
 * Readers receive the expected binding, never candidate observations to echo. */
export interface WorkloadEvidenceResolver {
  readArtifact(ref: string, binding: Readonly<{ runId: string; trialBindingHash: string }>): Promise<Uint8Array | null>;
  readObservations(ref: string, binding: Readonly<{ runId: string; trialBindingHash: string }>): Promise<readonly TrajectoryStep[] | null>;
}

/** Resolve private workload evidence through its host authority, then reuse the
 * existing replay verifier. Missing/failed reads remain explicit failures. This
 * verifies preserved observations; it neither executes nor grades a workload. */
export async function replayResolvedWorkloadEvidence(
  input: Omit<Parameters<typeof replayTrialEvidence>[0], 'resolvedArtifactContents' | 'resolvedWorkloadObservations'>,
  resolver: WorkloadEvidenceResolver,
): Promise<ReplayReport> {
  const frozen = structuredClone(input);
  const expected = frozen.expectedIdentity;
  if (!frozen.completionRequirements || !expected?.bindingComplete ||
      computeTrialIdentity(frozen.trial).bindingHash !== expected.bindingHash) return replayTrialEvidence(frozen);
  const io = { ...resolver };
  const binding = Object.freeze({ runId: frozen.trial.lineage.runId, trialBindingHash: expected.bindingHash });
  const unresolvedRefs = [...(frozen.unresolvedRefs ?? [])];
  const requiredArtifacts = new Set(frozen.completionRequirements.artifacts.map(row => row.id));
  const requiredContexts = new Set(frozen.completionRequirements.context.map(row => row.id));
  const requiredTransitions = new Set(frozen.completionRequirements.transitions.map(row => row.id));
  const receiptRefs = new Set<string>();
  for (const step of frozen.evidence.trajectory) {
    const metadata = step.metadata;
    const transition = metadata?.durableTransition as { id?: string } | undefined;
    const outcome = metadata?.workloadOutcome as { id?: string } | undefined;
    if (textPresent(metadata?.receiptRef) && (requiredContexts.has(String(metadata.contextId)) ||
        requiredTransitions.has(String(transition?.id)) || outcome?.id === frozen.completionRequirements.downstream.id))
      receiptRefs.add(metadata.receiptRef);
  }
  const [artifacts, observations] = await Promise.all([
    Promise.all(frozen.evidence.artifacts.filter(row => requiredArtifacts.has(row.id)).map(async row => {
      if (!textPresent(row.ref)) return null;
      const bytes = await io.readArtifact(row.ref, binding).catch(() => null);
      if (!(bytes instanceof Uint8Array)) { unresolvedRefs.push(row.ref); return null; }
      return { id: row.id, ref: row.ref, content: new Uint8Array(bytes) };
    })),
    Promise.all([...receiptRefs].map(async ref => {
      const rows = await io.readObservations(ref, binding).catch(() => null);
      if (!Array.isArray(rows) || rows.some(row => row?.metadata?.receiptRef !== ref)) {
        unresolvedRefs.push(ref); return [];
      }
      return structuredClone(rows);
    })),
  ]);
  return replayTrialEvidence({ ...frozen, unresolvedRefs: [...new Set(unresolvedRefs)].sort(),
    resolvedArtifactContents: artifacts.filter(row => row !== null), resolvedWorkloadObservations: observations.flat() });
}
