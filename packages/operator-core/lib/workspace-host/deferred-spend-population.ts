/** P007: retained evidence only. Adapters own scoped, consistent, read-only access. */
import { z } from 'zod';
import {
  createWorkspaceHostSpendObservation,
  evaluateWorkspaceHostSpendFinality,
  type WorkspaceHostSpendObservation,
  type WorkspaceHostSpendFinality,
} from '@papercusp/deployment-driver';
import { parseGcpBillingExportDescriptor, type GcpBillingExportDescriptor } from './gcp-api-client';
import {
  deferredSpendEvidenceIdentitySchema,
  deferredSpendFingerprint,
  evaluateDeferredSpendEvidence,
  type DeferredSpendEvidenceIdentity,
  type DeferredSpendEvidenceSlice,
  type DeferredSpendImmutable,
  type EvidenceVerdict,
} from './deferred-spend-acceptance-contract';

/** Reviewed production predicate in hosted-lifecycle-store; no mutable store import. */
export const DEFERRED_SPEND_STABILITY_WINDOW_MS = 1_800_000;
export const DEFERRED_SPEND_RETAINED_RUNS = ['p018-canary-20260905-r4', 'p018-canary-20260905-r5'] as const;
const nonempty = z.string().trim().min(1);
const refs = z.array(nonempty).min(1);
const date = z.string().datetime({ offset: true });
const deferralSchema = z.object({
  status: z.literal('deferred'), actorId: nonempty, reason: nonempty,
  procedureRef: nonempty, reconcileAfter: date,
}).passthrough();
const hostSchema = z.object({ workspaceId: nonempty, id: nonempty, connectionId: nonempty, costSignals: z.unknown() }).strict();
const connectionSchema = z.object({
  workspaceId: nonempty, id: nonempty, target: nonempty,
  readable: z.boolean(), providerConfig: z.unknown(), evidenceRefs: refs,
}).strict();
const observationSchema = z.object({
  currency: nonempty, grossMicros: nonempty, creditMicros: nonempty, netMicros: nonempty,
  observedAt: date, providerEvidenceRef: nonempty, budgetCents: z.number().int().nonnegative(),
}).strict();
const jobSchema = z.object({
  workspaceId: nonempty, hostId: nonempty, runId: nonempty, usageStartAt: date, usageEndAt: date,
  endpoint: z.literal('https://bigquery.googleapis.com/bigquery/v2'),
  descriptor: z.unknown(), configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  jobReference: z.object({ projectId: nonempty, jobId: nonempty, location: nonempty.optional() }).strict(),
  observation: observationSchema,
  authenticity: z.enum(['verified', 'unverified', 'unsupported']),
  evidenceRefs: refs,
}).strict();
type JsonObject = Record<string, unknown>;
const object = (v: unknown): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v);
const validTime = (v: unknown): v is string => typeof v === 'string' && date.safeParse(v).success;

export interface DeferredSpendRetainedTarget {
  readonly hostId: string;
  readonly runId: string;
  /** Independently selected historical baseline, never copied from today's signal. */
  readonly originalDeferral: unknown;
  readonly evidenceRefs: readonly string[];
}
export interface DeferredSpendPopulationRequest {
  readonly expectedIdentity: DeferredSpendEvidenceIdentity;
  readonly targets: readonly DeferredSpendRetainedTarget[];
  readonly maxPages?: number;
}
export interface DeferredSpendPopulationCensus {
  readonly snapshotRef: string;
  readonly upperWatermark: string;
  readonly hostCount: number;
  readonly evidenceRefs: readonly string[];
}
export interface DeferredSpendHostPage {
  readonly snapshotRef: string;
  readonly configurationHash: string;
  readonly upperWatermark: string;
  readonly after: string | null;
  readonly nextAfter: string | null;
  readonly hosts: readonly unknown[];
  readonly evidenceRef: string;
}
export interface DeferredSpendJobEvidence {
  readonly snapshotRef: string;
  readonly complete: boolean;
  readonly records: readonly unknown[];
  readonly evidenceRefs: readonly string[];
}
export interface DeferredSpendPopulationSnapshot {
  readonly identity: DeferredSpendEvidenceIdentity;
  readonly census: () => Promise<DeferredSpendPopulationCensus>;
  readonly readHosts: (after: string | null, upperWatermark: string) => Promise<DeferredSpendHostPage>;
  readonly readConnection: (id: string) => Promise<unknown>;
  /** Reads retained authoritative job artifacts; must never create/query a provider job. */
  readonly readJobs: (target: DeferredSpendRetainedTarget) => Promise<DeferredSpendJobEvidence>;
}
export interface DeferredSpendPopulationDependencies {
  readonly withSnapshot: <T>(
    expectedIdentity: DeferredSpendEvidenceIdentity,
    read: (snapshot: DeferredSpendPopulationSnapshot) => Promise<T>,
  ) => Promise<T>;
}
export interface DeferredSpendPopulationTargetResult {
  readonly hostId: string;
  readonly runId: string;
  readonly verdict: EvidenceVerdict;
  readonly reasons: readonly string[];
  readonly signalMember?: string;
  readonly signalHash?: string;
  readonly originalDeferralHash?: string;
  readonly descriptor: { readonly state: 'absent' | 'present-valid' | 'present-invalid' | 'unreadable'; readonly value?: GcpBillingExportDescriptor };
  readonly finality?: WorkspaceHostSpendFinality;
  readonly evidenceRefs: readonly string[];
}
export interface DeferredSpendPopulationResult {
  readonly verdict: EvidenceVerdict;
  readonly identity?: DeferredSpendEvidenceIdentity;
  readonly slices: readonly DeferredSpendEvidenceSlice[];
  readonly targets: readonly DeferredSpendPopulationTargetResult[];
  readonly gaps: readonly string[];
}
function freeze<T>(value: T): DeferredSpendImmutable<T> {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value as DeferredSpendImmutable<T>;
}
function unknown(reason: string): DeferredSpendPopulationResult {
  return freeze({ verdict: 'unknown', slices: [], targets: [], gaps: [reason] });
}
const hostMember = (id: string) => `host:${id}`;
const runMember = (id: string) => `run:${id}`;

async function evaluateTarget(
  target: DeferredSpendRetainedTarget,
  host: z.infer<typeof hostSchema> | undefined,
  snapshot: DeferredSpendPopulationSnapshot,
): Promise<DeferredSpendPopulationTargetResult> {
  const reasons: string[] = [];
  const evidenceRefs: string[] = [...target.evidenceRefs];
  let violation = false;
  let signalMember: string | undefined;
  let signalHash: string | undefined;
  let originalDeferralHash: string | undefined;
  let finality: WorkspaceHostSpendFinality | undefined;
  let descriptor: DeferredSpendPopulationTargetResult['descriptor'] = { state: 'unreadable' };
  const result = (): DeferredSpendPopulationTargetResult => ({
    hostId: target.hostId, runId: target.runId, verdict: violation ? 'fail' : reasons.length ? 'unknown' : 'pass',
    reasons, descriptor, evidenceRefs, ...(signalMember ? { signalMember, signalHash } : {}),
    ...(originalDeferralHash ? { originalDeferralHash } : {}), ...(finality ? { finality } : {}),
  });
  if (!host || !Array.isArray(host.costSignals)) { reasons.push('retained host or signal array missing/unreadable'); return result(); }
  const matches = host.costSignals.map((signal, ordinal) => ({ signal, ordinal }))
    .filter(({ signal }) => object(signal) && signal.runId === target.runId);
  if (matches.length !== 1) { reasons.push('retained run mapping missing or ambiguous'); return result(); }
  const { signal, ordinal } = matches[0];
  if (!object(signal) || signal.kind !== 'workspace-host-canary-cost-evidence-v1') {
    reasons.push('retained signal kind is malformed'); return result();
  }
  signalMember = `signal:${host.id}:${ordinal}`;
  signalHash = deferredSpendFingerprint(signal);
  const original = deferralSchema.safeParse(target.originalDeferral);
  const retained = deferralSchema.safeParse(signal.spendSettlement);
  if (!original.success || !retained.success ||
      deferredSpendFingerprint(original.data) !== deferredSpendFingerprint(retained.data)) reasons.push('original deferral is missing, changed or unprovable');
  else originalDeferralHash = deferredSpendFingerprint(original.data);
  const baseline = object(signal.preRunZeroBaseline) ? signal.preRunZeroBaseline : {};
  const completion = object(signal.completion) ? signal.completion : {};
  const start = baseline.observedAt, end = completion.completedAt;
  if (!validTime(start) || !validTime(end) || Date.parse(start) >= Date.parse(end)) reasons.push('usage window/baseline/completion missing or invalid');
  try {
    const parsed = connectionSchema.safeParse(await snapshot.readConnection(host.connectionId));
    if (!parsed.success || !parsed.data.readable || parsed.data.id !== host.connectionId ||
        parsed.data.workspaceId !== snapshot.identity.scope.workspaceId || parsed.data.target !== 'gcp') reasons.push('connection unreadable, missing or outside requested scope');
    else {
      evidenceRefs.push(...parsed.data.evidenceRefs);
      const config = parsed.data.providerConfig;
      if (!object(config)) reasons.push('connection provider configuration unreadable');
      else if (config.billingExport === undefined || config.billingExport === null) descriptor = { state: 'absent' };
      else {
        try { descriptor = { state: 'present-valid', value: parseGcpBillingExportDescriptor(config.billingExport) }; }
        catch { descriptor = { state: 'present-invalid' }; }
      }
    }
  } catch { reasons.push('connection read failed'); }
  const reconciliation = object(signal.spendReconciliation) ? signal.spendReconciliation : {};
  const settled = reconciliation.status === 'settled';
  const parsedHistory = z.array(observationSchema).safeParse(signal.spendObservations);
  if (!parsedHistory.success) { reasons.push('spend observation history missing or malformed'); return result(); }
  const history: WorkspaceHostSpendObservation[] = parsedHistory.data;
  try {
    // Rebuild each amount and the entire history; never trust rounded cents or stored status.
    history.forEach((entry) => {
      if (createWorkspaceHostSpendObservation(entry).budgetCents !== entry.budgetCents) throw new Error('rounded cents mismatch');
    });
    finality = evaluateWorkspaceHostSpendFinality(history, DEFERRED_SPEND_STABILITY_WINDOW_MS);
  } catch {
    if (settled) violation = true;
    reasons.push('invalid exact accounting or observation history'); return result();
  }
  if (history.some((entry) => Date.parse(entry.observedAt) > Date.parse(snapshot.identity.observation.window.endAt))) reasons.push('observation exceeds the fixed evidence watermark');
  if (settled && (finality.status !== 'settled' || !object(reconciliation.finality) ||
      deferredSpendFingerprint(finality) !== deferredSpendFingerprint(reconciliation.finality))) {
    violation = true; reasons.push('stored settled evidence contradicts recomputed finality');
  }
  if (!settled && reconciliation.status !== 'retryable') reasons.push('missing explicit retryable/unsettled reconciliation state');
  if (!settled && reconciliation.status === 'retryable' && !nonempty.safeParse(reconciliation.reason).success) reasons.push('retryable state has no reason');
  try {
    const jobs = await snapshot.readJobs(target);
    if (!jobs.complete || jobs.snapshotRef !== snapshot.identity.observation.snapshot.id || !jobs.evidenceRefs.length) reasons.push('authoritative job population incomplete or mismatched');
    evidenceRefs.push(...jobs.evidenceRefs);
    const parsedJobs = jobs.records.map((entry) => jobSchema.safeParse(entry));
    if (parsedJobs.some((entry) => !entry.success)) reasons.push('authoritative job provenance malformed');
    const records = parsedJobs.flatMap((entry) => entry.success ? [entry.data] : []);
    const used = new Set<string>();
    for (const observation of history) {
      const candidates = records.filter((entry) => entry.observation.providerEvidenceRef === observation.providerEvidenceRef);
      if (candidates.length !== 1) { reasons.push('authoritative observation missing or duplicated'); continue; }
      const job = candidates[0];
      const ref = `gcp://bigquery/projects/${job.jobReference.projectId}/jobs/${job.jobReference.jobId}`;
      used.add(ref);
      let historicalDescriptor: GcpBillingExportDescriptor;
      try { historicalDescriptor = parseGcpBillingExportDescriptor(job.descriptor); }
      catch { reasons.push('historical descriptor invalid'); continue; }
      const attributable = job.workspaceId === snapshot.identity.scope.workspaceId && job.hostId === target.hostId &&
        job.runId === target.runId && job.usageStartAt === start && job.usageEndAt === end &&
        job.jobReference.projectId === historicalDescriptor.projectId && job.jobReference.location === historicalDescriptor.location &&
        job.configurationHash === deferredSpendFingerprint(historicalDescriptor) && ref === observation.providerEvidenceRef;
      if (!attributable) { reasons.push('job/run/window/configuration identity mismatch'); continue; }
      evidenceRefs.push(...job.evidenceRefs);
      if (job.authenticity === 'unsupported' || deferredSpendFingerprint(job.observation) !== deferredSpendFingerprint(observation)) {
        if (settled) violation = true;
        reasons.push('retained authoritative evidence contradicts the supported observation');
      } else if (job.authenticity !== 'verified') reasons.push('job authenticity unverified');
    }
    if (records.some((entry) => !used.has(entry.observation.providerEvidenceRef))) reasons.push('unmatched retained authoritative observation');
  } catch { reasons.push('authoritative job evidence unreadable'); }
  // Current config absence is not proof against a legitimate historical settlement.
  if (!settled && history.length === 0 && !['absent', 'present-invalid', 'present-valid'].includes(descriptor.state)) reasons.push('no-data configuration evidence unreadable');
  return result();
}

/** No default adapter: this function cannot acquire credentials, issue SQL or call a provider. */
export async function collectDeferredSpendPopulation(
  request: DeferredSpendPopulationRequest,
  dependencies: DeferredSpendPopulationDependencies,
): Promise<DeferredSpendPopulationResult> {
  const identity = deferredSpendEvidenceIdentitySchema.safeParse(request.expectedIdentity);
  const maxPages = request.maxPages ?? 100;
  if (!identity.success || !Number.isSafeInteger(maxPages) || maxPages < 1 || request.targets.length !== 2 ||
      DEFERRED_SPEND_RETAINED_RUNS.some((id) => request.targets.filter((target) => target.hostId === id && target.runId === id).length !== 1) ||
      request.targets.some((target) => !target.evidenceRefs.length || !deferralSchema.safeParse(target.originalDeferral).success)) return unknown('invalid independent identity, retained targets or page budget');
  const selected = freeze(structuredClone({ identity: identity.data, targets: request.targets }));
  try {
    return await dependencies.withSnapshot(selected.identity, async (snapshot) => {
      const actual = deferredSpendEvidenceIdentitySchema.safeParse(snapshot.identity);
      if (!actual.success || deferredSpendFingerprint(actual.data) !== deferredSpendFingerprint(selected.identity)) return unknown('snapshot identity does not match independent request');
      const gaps: string[] = [];
      const population = new Set<string>(selected.targets.map((target) => runMember(target.runId)));
      const checked = new Set<string>();
      const notApplicable: { member: string; reason: string; evidenceRefs: string[] }[] = [];
      const pageRefs: string[] = [];
      const hosts = new Map<string, z.infer<typeof hostSchema>>();
      const snapshotRef = actual.data.observation.snapshot.id;
      let census: DeferredSpendPopulationCensus;
      try { census = await snapshot.census(); }
      catch { return unknown('host census unreadable'); }
      if (census.snapshotRef !== snapshotRef || !census.evidenceRefs.length || !Number.isSafeInteger(census.hostCount) || census.hostCount <= 0 || !census.upperWatermark) return unknown('host positive-control census missing or mismatched');
      let after: string | null = null;
      let exhausted = false;
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
        let page: DeferredSpendHostPage;
        try { page = await snapshot.readHosts(after, census.upperWatermark); }
        catch { gaps.push('host page unreadable'); break; }
        if (page.snapshotRef !== snapshotRef || page.configurationHash !== actual.data.configurationHash ||
            page.upperWatermark !== census.upperWatermark || page.after !== after || !page.evidenceRef || !Array.isArray(page.hosts)) {
          gaps.push('page identity, configuration or cursor mismatch'); break;
        }
        pageRefs.push(page.evidenceRef);
        let previous: string | null = after;
        for (const [index, raw] of page.hosts.entries()) {
          const parsed = hostSchema.safeParse(raw);
          const fallback = `unreadable-host:${pageNumber}:${index}`;
          if (!parsed.success) { population.add(fallback); gaps.push(`malformed host row: ${fallback}`); continue; }
          const host = parsed.data;
          const member = hostMember(host.id);
          population.add(member);
          if (host.workspaceId !== actual.data.scope.workspaceId || (previous !== null && host.id <= previous) || host.id > census.upperWatermark || hosts.has(host.id)) {
            gaps.push(`host scope, ordering or duplicate mismatch: ${member}`); continue;
          }
          previous = host.id; hosts.set(host.id, host);
          if (!Array.isArray(host.costSignals)) { gaps.push(`signal array unreadable: ${member}`); continue; }
          checked.add(member);
          host.costSignals.forEach((signal, ordinal) => {
            const signalRef = `signal:${host.id}:${ordinal}`;
            population.add(signalRef);
            if (!object(signal) || !nonempty.safeParse(signal.kind).success || !nonempty.safeParse(signal.runId).success) gaps.push(`malformed signal: ${signalRef}`);
            else if (selected.targets.some((target) => target.hostId === host.id && target.runId === signal.runId)) checked.add(signalRef);
            else notApplicable.push({ member: signalRef, reason: 'enumerated signal outside the two retained run identities', evidenceRefs: [page.evidenceRef] });
          });
        }
        if (page.nextAfter === null) { exhausted = true; break; }
        if (!page.hosts.length || previous === after || page.nextAfter !== previous) { gaps.push('duplicate, empty or skipped page cursor'); break; }
        after = page.nextAfter;
      }
      if (!exhausted) gaps.push('host census not exhausted within page budget');
      if (hosts.size !== census.hostCount) gaps.push('same-snapshot host population count mismatch');
      const targets = await Promise.all(selected.targets.map((target) => evaluateTarget(target, hosts.get(target.hostId), snapshot)));
      const violations: { member: string; reason: string; evidenceRefs: string[] }[] = [];
      for (const target of targets) {
        const member = runMember(target.runId);
        if (target.verdict !== 'unknown') checked.add(member);
        if (target.verdict === 'unknown') gaps.push(...target.reasons.map((reason) => `${member}: ${reason}`));
        if (target.verdict === 'fail') violations.push({ member, reason: target.reasons.join('; '), evidenceRefs: [...target.evidenceRefs] });
      }
      if (!pageRefs.length) return unknown('no witnessed host pages');
      const excluded = new Set(notApplicable.map((entry) => entry.member));
      const notChecked = [...population].filter((member) => !checked.has(member) && !excluded.has(member));
      const verdict: EvidenceVerdict = violations.length ? 'fail' : gaps.length || notChecked.length ? 'unknown' : 'pass';
      const slice: DeferredSpendEvidenceSlice = {
        id: 'retained-spend-population', verdict, violations,
        ...(verdict === 'unknown' ? { reason: gaps.join('; ') || 'unchecked population members' } : {}),
        evidenceRefs: [...census.evidenceRefs],
        coverage: { state: gaps.length || notChecked.length ? 'partial' : 'complete', population: [...population], checked: [...checked],
          notChecked, notApplicable, residue: [], gaps, snapshotRef, pageRefs, emptyPopulationEvidenceRefs: [] },
      };
      const validated = evaluateDeferredSpendEvidence({ expectedIdentity: selected.identity, requiredSlices: [slice.id] }, { identity: actual.data, slices: [slice] });
      return freeze({ verdict: validated.verdict, identity: validated.identity, slices: validated.slices, targets, gaps });
    });
  } catch { return unknown('consistent read-only population snapshot unavailable'); }
}
