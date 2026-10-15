/** R11 record detector. Reuses operation/corpus authority and immutable evidence
 * readers; creates no trial ledger. Passing fixture controls is not a live trial,
 * customer acceptance, or shipment proof. Resolvers are trusted store adapters,
 * never lookups over the caller's supplied bindings. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { operationFromSpecification } from '@papercusp/orchestrator/blueprint';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { inspectEnterpriseEvidenceRecord, type EnterpriseEvidenceRecord } from '../doc-claims/enterprise-evidence';
import { readHostedAllocationAccountingExport } from '../auth/hosted/billing/allocation-store';
import { readBlueprintSpecificationSnapshot } from './project-to-pg';
import { supportOperationReservationId } from './support-workflow-budget';
import { getBlueprintOperationResult, getBlueprintOperationTerminalWorker,
  type BlueprintOperationHandle } from './operation-service';

const id = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const number = z.number().finite().nonnegative();
const measurement = z.union([z.object({ value: number }).strict(), z.object({ unknownReason: id }).strict()]);
export const SUPPORT_TRIAL_METRICS = ['costMicros', 'reviewSeconds', 'reworkCount', 'supportSeconds', 'recoverySeconds'] as const;
const metrics = z.object({ costMicros: measurement, reviewSeconds: measurement, reworkCount: measurement,
  supportSeconds: measurement, recoverySeconds: measurement }).strict();
const maximum = z.object({ pass: number, stop: number }).strict().refine(v => v.pass <= v.stop);
const minimum = z.object({ pass: number, stop: number }).strict().refine(v => v.pass >= v.stop);
export const SupportTrialRegistrationSchema = z.object({
  trialId: id, planRevision: id, candidateSha256: hash, workflowRevision: hash, operationId: id,
  startsAt: z.string().datetime(), endsAt: z.string().datetime(), reviewer: id,
  implementers: z.array(id).min(1), resultLabel: z.literal('internal-simulation'),
  cohort: z.array(z.object({ id, supportCaseId: id, submitter: id,
    provenance: z.enum(['synthetic', 'self-sourced']), source: id, sourceSha256: hash }).strict()).min(1),
  thresholds: z.object({ acceptedRate: minimum.refine(v => v.pass <= 1),
    repeatUses: minimum.refine(v => Number.isInteger(v.pass) && Number.isInteger(v.stop) && v.pass >= 2),
    costMicros: maximum, reviewSeconds: maximum, reworkCount: maximum, supportSeconds: maximum,
    recoverySeconds: maximum }).strict(),
}).strict();
export type SupportTrialRegistration = z.infer<typeof SupportTrialRegistrationSchema>;
export const SupportTrialObservationSchema = z.object({
  trialId: id, cohortId: id, receiptId: z.number().int().positive(), candidateSha256: hash,
  resultLabel: z.literal('internal-simulation'), resultFingerprint: hash,
  observedAt: z.string().datetime(), baseline: metrics, measured: metrics,
  // The immutable observation is the measured procedure/result, including these
  // non-numeric observations; a reference alone is insufficient.
  administration: z.boolean(), policyUnderstood: z.boolean(), recovered: z.boolean(),
}).strict();
export type SupportTrialObservation = z.infer<typeof SupportTrialObservationSchema>;
export interface SupportTrialArtifact {
  record: EnterpriseEvidenceRecord; body: unknown;
  approval?: { principal: string; at: string };
}
export interface SupportTrialAuthority {
  workspace: string; harness: string; subject: string; planRevision: string; candidateSha256: string;
  workflowRevision: string; approvers: readonly string[]; now: number;
  /** Resolve immutable bytes AND qualified approval from the maintained store. */
  resolve: (ref: string) => Promise<SupportTrialArtifact | undefined>;
}
export interface SupportTrialFinding { code: string; subject: string; kind: 'unknown' | 'refused' | 'failed' | 'degraded' }
export interface SupportTrialInput {
  registration: EnterpriseEvidenceRecord;
  prerequisites: { id: string; record: EnterpriseEvidenceRecord }[];
  observations: { record: EnterpriseEvidenceRecord; handle: BlueprintOperationHandle; callerId: string }[];
}
export function supportTrialBodyHash(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/** Both this inspector and the PG entry below keep unknowns alongside failures.
 * No global early-return may turn a known contradiction into an unknown. */
export async function inspectSupportTrialEvidence(input: SupportTrialInput, authority: SupportTrialAuthority) {
  const findings: SupportTrialFinding[] = [];
  const add = (kind: SupportTrialFinding['kind'], code: string, subject: string) => findings.push({ kind, code, subject });
  const read = async (binding: EnterpriseEvidenceRecord) => {
    const artifact = await authority.resolve(binding.ref);
    const errors = inspectEnterpriseEvidenceRecord(binding, { workspace: authority.workspace,
      subject: authority.subject, profile: 'assumed-internal', now: authority.now }, () => artifact?.record);
    for (const error of errors) add(error.code === 'record-missing' || error.code === 'record-stale' ? 'unknown' : 'refused', error.code, `${binding.ref}:${error.subject}`);
    const bytesMatch = artifact && artifact.body !== undefined && supportTrialBodyHash(artifact.body) === artifact.record.hash;
    if (artifact && !bytesMatch) add('refused', 'artifact-bytes', binding.ref);
    return errors.length || !bytesMatch ? undefined : artifact;
  };
  const approved = (artifact: SupportTrialArtifact, before: number) => {
    const approval = artifact.approval, at = Date.parse(approval?.at ?? '');
    if (!approval || !authority.approvers.includes(approval.principal) || artifact.record.owner !== approval.principal ||
        !Number.isFinite(at) || at < Date.parse(artifact.record.observedAt) || at >= before) {
      add('refused', 'prior-qualified-approval', artifact.record.ref);
    }
  };
  const stored = await read(input.registration);
  const parsed = SupportTrialRegistrationSchema.safeParse(stored?.body);
  if (!parsed.success) add('unknown', 'registration-missing-or-invalid', input.registration.ref);
  const registration = parsed.success ? parsed.data : undefined;
  const sources = new Map<string, string[]>();
  if (stored && (stored.body as Record<string, unknown>)?.resultLabel !== 'internal-simulation') add('refused', 'evidence-class', stored.record.ref);
  if (registration) {
    const start = Date.parse(registration.startsAt), end = Date.parse(registration.endsAt);
    if (start >= end || end > authority.now || Date.parse(stored!.record.observedAt) >= start) add('refused', 'trial-dates', registration.trialId);
    approved(stored!, start);
    for (const key of ['planRevision', 'candidateSha256', 'workflowRevision'] as const) {
      if (registration[key] !== authority[key]) add('refused', 'candidate-binding', key);
    }
    if (registration.implementers.some(p => samePrincipal(p, registration.reviewer))) add('refused', 'implementer-reviewer', registration.reviewer);
    if (new Set(registration.cohort.map(c => c.id)).size !== registration.cohort.length ||
        new Set(registration.cohort.map(c => c.supportCaseId)).size !== registration.cohort.length) add('refused', 'cohort-duplicate', registration.trialId);
    for (const cohort of registration.cohort) {
      if (samePrincipal(cohort.submitter, registration.reviewer)) add('refused', 'submitter-reviewer', cohort.id);
      const source = await authority.resolve(cohort.source);
      if (!source) { add('unknown', 'cohort-source-missing', cohort.id); continue; }
      const body = z.object({ supportCaseId: z.literal(cohort.supportCaseId), provenance: z.literal(cohort.provenance),
        documentIds: z.array(id).min(1) }).strict().safeParse(source.body);
      const errors = inspectEnterpriseEvidenceRecord(source.record, { workspace: authority.workspace, subject: authority.subject,
        profile: 'assumed-internal', now: authority.now }, () => source.record);
      if (!body.success || errors.length || source.record.hash !== cohort.sourceSha256 ||
          source.body === undefined || supportTrialBodyHash(source.body) !== cohort.sourceSha256 || Date.parse(source.record.observedAt) >= start) add('refused', 'cohort-source-binding', cohort.id);
      else sources.set(cohort.id, body.data.documentIds);
    }
  }
  const prerequisiteIds = [...Array.from({ length: 10 }, (_, i) => `A-${i + 1}`), 'P-002', 'P-003', 'R-8'];
  for (const required of prerequisiteIds) {
    const matches = input.prerequisites.filter(p => p.id === required);
    if (matches.length !== 1) { add('unknown', 'prerequisite-population', required); continue; }
    const artifact = await read(matches[0]!.record);
    // The upstream approved disposition must explicitly cover this prerequisite.
    const body = z.object({ prerequisite: z.literal(required), state: z.enum(['satisfied', 'failed', 'degraded', 'refused', 'unknown']), planRevision: z.literal(authority.planRevision),
      candidateSha256: z.literal(authority.candidateSha256) }).passthrough().safeParse(artifact?.body);
    if (!body.success) add('unknown', 'prerequisite-not-established', required);
    else if (body.data.state !== 'satisfied') add(body.data.state, 'prerequisite-disposition', required);
    if (artifact && registration) approved(artifact, Date.parse(registration.startsAt));
  }
  const observations: { observation: SupportTrialObservation; input: SupportTrialInput['observations'][number] }[] = [];
  const seen = new Set<number>();
  for (const supplied of input.observations) {
    const artifact = await read(supplied.record);
    if (artifact && (artifact.body as Record<string, unknown>)?.resultLabel !== 'internal-simulation') add('refused', 'evidence-class', supplied.record.ref);
    const parsedObservation = SupportTrialObservationSchema.safeParse(artifact?.body);
    if (!parsedObservation.success) { add('unknown', 'observation-missing-or-invalid', supplied.record.ref); continue; }
    const observation = parsedObservation.data;
    if (seen.has(observation.receiptId)) add('refused', 'receipt-reused', supplied.record.ref);
    seen.add(observation.receiptId);
    observations.push({ observation, input: supplied });
    const cohort = registration?.cohort.find(c => c.id === observation.cohortId);
    if (!cohort || observation.trialId !== registration!.trialId || observation.candidateSha256 !== authority.candidateSha256 ||
        observation.receiptId !== supplied.handle.receiptId || cohort.submitter !== supplied.callerId) add('refused', 'observation-binding', supplied.record.ref);
    const at = Date.parse(observation.observedAt);
    if (registration && (at < Date.parse(registration.startsAt) || at > Date.parse(registration.endsAt) ||
        Date.parse(artifact!.record.observedAt) < at)) add('refused', 'observation-dates', supplied.record.ref);
    for (const key of ['administration', 'policyUnderstood', 'recovered'] as const) if (!observation[key]) add('failed', key, supplied.record.ref);
    for (const metric of SUPPORT_TRIAL_METRICS) {
      const measured = observation.measured[metric], baseline = observation.baseline[metric];
      if (!('value' in baseline)) add('unknown', 'baseline-not-measured', `${supplied.record.ref}:${metric}`);
      if (!('value' in measured)) add('unknown', 'observation-not-measured', `${supplied.record.ref}:${metric}`);
      else if (registration) compare(measured.value, registration.thresholds[metric], false, `${supplied.record.ref}:${metric}`, add);
    }
  }
  if (registration) for (const cohort of registration.cohort) {
    if (!observations.some(o => o.observation.cohortId === cohort.id)) add('unknown', 'cohort-unobserved', cohort.id);
  }
  if (!observations.length) add('unknown', 'observations-empty', input.registration.ref);
  return { registration, observations, findings, sources };
}

function samePrincipal(a: string, b: string) { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function compare(value: number, threshold: { pass: number; stop: number }, minimum: boolean, subject: string,
  add: (kind: SupportTrialFinding['kind'], code: string, subject: string) => void) {
  if (minimum ? value < threshold.stop : value > threshold.stop) add('failed', 'threshold-stop', subject);
  else if (minimum ? value < threshold.pass : value > threshold.pass) add('degraded', 'threshold-pass', subject);
}

/** Actual-record entry: receipt, input, completion, result fingerprint and live
 * employee/reviewer ACLs are read from maintained operation stores. Artifacts
 * alone cannot satisfy this detector. Exceptions propagate (no catch-and-pass). */
export async function evaluateSupportWorkflowTrial(sql: Sql, input: SupportTrialInput, authority: SupportTrialAuthority) {
  const inspected = await inspectSupportTrialEvidence(input, authority);
  const { registration, findings } = inspected;
  const add = (kind: SupportTrialFinding['kind'], code: string, subject: string) => findings.push({ kind, code, subject });
  let accepted = 0, reviewed = 0;
  const uses = new Map<string, Set<number>>();
  if (registration) for (const { observation, input: supplied } of inspected.observations) {
    const { handle } = supplied, ref = supplied.record.ref;
    if (handle.workspaceId !== authority.workspace || handle.harnessSlug !== authority.harness ||
        handle.operationId !== registration.operationId || handle.specificationRevision !== authority.workflowRevision) {
      add('refused', 'operation-scope', ref); continue;
    }
    const [receipt] = await sql<{ created_at: Date | string }[]>`SELECT created_at FROM harness_shared.blueprint_operation_invocations
      WHERE id = ${handle.receiptId} AND workspace_id = ${authority.workspace} AND harness_slug = ${authority.harness}`;
    if (!receipt) { add('unknown', 'receipt-missing', ref); continue; }
    const at = new Date(receipt.created_at).getTime();
    if (at <= Date.parse(registration.startsAt) || at > Date.parse(registration.endsAt) || at > Date.parse(observation.observedAt)) add('refused', 'receipt-dates', ref);
    const result = await getBlueprintOperationResult(sql, handle, registration.reviewer, { principalId: registration.reviewer });
    if (result.state !== 'ready' || !result.businessReview?.decision) { add('unknown', 'canonical-review-unavailable', ref); continue; }
    const worker = await getBlueprintOperationTerminalWorker(sql, handle, supplied.callerId);
    const cohort = registration.cohort.find(c => c.id === observation.cohortId);
    if (!cohort || worker.input.supportCaseId !== cohort.supportCaseId ||
        canonicalJson(worker.input.documentIds) !== canonicalJson(inspected.sources.get(cohort?.id ?? '') ?? []) ||
        samePrincipal(worker.ownerId, registration.reviewer) || result.businessReview.decision.reviewerPrincipal !== registration.reviewer ||
        result.businessReview.resultFingerprint !== observation.resultFingerprint) { add('refused', 'canonical-attribution', ref); continue; }
    const reviewAt = Date.parse(result.businessReview.decision.at);
    if (reviewAt < at || reviewAt > Date.parse(observation.observedAt) || reviewAt > Date.parse(registration.endsAt)) add('refused', 'review-dates', ref);
    reviewed++;
    if (result.businessReview.state === 'accepted') accepted++;
    const receipts = uses.get(cohort.submitter) ?? new Set<number>(); receipts.add(handle.receiptId); uses.set(cohort.submitter, receipts);
    const specification = await readBlueprintSpecificationSnapshot(sql, handle.workspaceId, handle.harnessSlug, handle.specificationRevision);
    const funding = specification && operationFromSpecification(specification, handle.operationId).operation.policy.supportCase?.funding;
    if (!funding || funding.organization.controlWorkspaceId !== authority.workspace) { add('unknown', 'funding-unavailable', ref); continue; }
    const accounting = await sql.begin(tx => readHostedAllocationAccountingExport(tx as unknown as Sql, funding));
    const reservationId = supportOperationReservationId(handle);
    const cost = accounting.rows.find(row => row.reservationId === reservationId && row.allocationId === funding.allocationId);
    const outcome = accounting.outcomes.find(row => row.outcomeId === reservationId);
    if (!cost || !outcome || outcome.evidenceClass !== 'internal-simulation' ||
        outcome.workflowRef !== `${handle.harnessSlug}:${handle.operationId}:${handle.specificationRevision}` ||
        outcome.resultState !== (result.businessReview.state === 'accepted' ? 'accepted' : result.businessReview.state === 'rejected' ? 'rejected' : 'rework-requested')) add('refused', 'outcome-binding', ref);
    if (!cost || !('value' in cost.providerFinalCostMicros)) add('unknown', 'provider-final-cost-unknown', ref);
    else {
      compare(cost.providerFinalCostMicros.value, registration.thresholds.costMicros, false, `${ref}:canonical-costMicros`, add);
      const measured = observation.measured.costMicros;
      if ('value' in measured && measured.value !== cost.providerFinalCostMicros.value) add('refused', 'cost-misattributed', ref);
    }
  }
  if (registration) {
    if (reviewed !== inspected.observations.length) add('unknown', 'canonical-population-incomplete', registration.trialId);
    // Missing reviews never dilute a measured rejected/rework result.
    if (reviewed) compare(accepted / reviewed, registration.thresholds.acceptedRate, true, 'acceptedRate', add);
    if (reviewed === inspected.observations.length && reviewed > 0 &&
        !findings.some(f => f.code === 'cohort-unobserved' || f.code === 'observation-missing-or-invalid')) {
      for (const submitter of new Set(registration.cohort.map(c => c.submitter))) compare(uses.get(submitter)?.size ?? 0,
        registration.thresholds.repeatUses, true, `repeatUses:${submitter}`, add);
    } else add('unknown', 'repeat-use-unavailable', registration.trialId);
  }
  const status = (['failed', 'refused', 'degraded', 'unknown'] as const).find(kind => findings.some(f => f.kind === kind)) ?? 'satisfied';
  return { status, evidenceClass: 'internal-simulation' as const, scope: 'internal-trial-records' as const, findings,
    coverage: { population: registration?.cohort.map(c => c.id) ?? [],
      checked: registration?.cohort.filter(c => inspected.observations.some(o => o.observation.cohortId === c.id)).map(c => c.id) ?? [],
      notChecked: registration?.cohort.filter(c => !inspected.observations.some(o => o.observation.cohortId === c.id)).map(c => c.id) ?? [] } };
}
