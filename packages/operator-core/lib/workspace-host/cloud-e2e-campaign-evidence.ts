import { z } from 'zod';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import {
  hasEnumeratedVerificationCoverage,
  missingRootCauseVerificationV2Fields,
  RootCauseVerificationSchema,
} from '../coord-lifecycle/records';
import { workspaceHostResourceCensusOutcome } from './teardown-release-receipt';
import type { WorkspaceHostResourceCensus } from './gcp-safety';

/**
 * Read-only checks over the existing campaign evidence manifest. These check joins and
 * contradictions; callers must obtain the records from the test/provider/release writers.
 * A unit fixture that exercises this validator is never a real execution receipt.
 */
const text = z.string().trim().min(1);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.string().regex(/^[a-f0-9]{40}$/);
const runtime = z.enum(['operator-api', 'hosted', 'desktop-native', 'gcp', 'aws']);
const measured = z.object({
  evidenceRef: text,
  evidenceSha256: sha,
  sourceSha: source,
  observedAt: z.string().datetime(),
});
const detector = measured.extend({
  id: text,
  scenario: text,
  class: z.enum(['happy', 'adversarial']),
  testFile: text,
  caseName: text,
  testFileSha256: sha,
  testRunId: z.number().int().positive(),
  result: z.enum(['passed', 'failed', 'skipped', 'unknown']),
  selectedByAffected: z.boolean(),
  negativeControl: z.enum(['caught', 'missed', 'not-run']),
});
const execution = measured.extend({
  id: text,
  runtime,
  artifactSha256: sha,
  authenticated: z.boolean(),
  syntheticCloudResponses: z.boolean(),
  tenantId: text,
  workspaceId: text,
  accountId: text,
  runId: text,
  resourceLabel: text,
  /** Loaded serving identity is required for final deployed acceptance, not candidate R5. */
  deploymentRef: text.optional(),
  servingIdentity: text.optional(),
  actions: z.array(z.object({ scenario: text, result: z.enum(['passed', 'failed', 'skipped', 'unknown']), evidenceRef: text })),
  hostId: text.optional(),
  census: z.custom<WorkspaceHostResourceCensus>().optional(),
  billingClosure: z.object({ result: z.enum(['passed', 'failed', 'unknown']), evidenceRef: text, observedAt: z.string().datetime() }).optional(),
});
const defect = z.object({
  id: text,
  assignee: text.nullable(),
  state: z.enum(['open', 'done', 'deferred']),
  completionAuthority: z.enum(['committed', 'proposed', 'unknown']),
  rootCauseVerification: RootCauseVerificationSchema.optional(),
  originatingFixRef: text.optional(),
  regressionDetectorId: text.optional(),
  triggeringJourneyReceiptId: text.optional(),
});
const shipment = measured.extend({
  runtime,
  artifactSha256: sha,
  authenticated: z.boolean(),
  promotedSourceSha: source,
  promotedArtifactSha256: sha,
  promotionRef: text,
  deploymentRef: text,
  servingRef: text,
  servingIdentity: text,
  finalExecutionId: text,
  auditRef: text,
  gradingRef: text,
  reportReadbackRef: text,
});

// Read-only projections of existing release, completion-audit, scorecard and
// report writers. These are independently collected context, never taken from
// acceptanceEvidence or inferred from a submitted reference string.
const canonicalRecord = z.object({ ref: text, evidenceSha256: sha, observedAt: z.string().datetime() });
const planIdentity = z.object({ planSlug: text, planRevision: z.number().int().positive(), planContentHash: sha });
const artifactIdentity = z.object({ runtime, sourceSha: source, artifactSha256: sha });
const shipmentContext = z.object({
  subject: planIdentity.extend({
    rubricRef: text, rubricRevision: z.number().int().positive(), criteriaHash: sha,
    authorId: text, workItemIds: z.array(text).min(1),
  }),
  obligations: z.array(z.object({
    runtime, evidenceRef: text, evidenceSha256: sha,
    promotionRef: text, deploymentRef: text, servingRef: text,
    auditRef: text, gradingRef: text, reportReadbackRef: text,
  })),
  promotions: z.array(canonicalRecord.merge(artifactIdentity).extend({ verdict: z.enum(['green', 'red', 'unknown']) })),
  deployments: z.array(canonicalRecord.merge(artifactIdentity).extend({
    promotionRef: text, status: z.enum(['deployed', 'failed', 'unknown']),
  })),
  serving: z.array(canonicalRecord.merge(artifactIdentity).extend({
    deploymentRef: text, identity: text, authenticated: z.boolean(),
    tenantId: text, workspaceId: text, accountId: text, runId: text, resourceLabel: text,
  })),
  completionAudits: z.array(canonicalRecord.merge(planIdentity).extend({
    sourceSha: source, workItemIds: z.array(text).min(1),
    verdict: z.enum(['passed', 'failed', 'unknown']), completionAuthority: z.enum(['committed', 'proposed', 'unknown']),
  })),
  planGrades: z.array(canonicalRecord.merge(planIdentity).extend({
    sourceSha: source, rubricRef: text, rubricRevision: z.number().int().positive(), criteriaHash: sha,
    verdict: z.enum(['passed', 'failed', 'unknown']), createdBy: text,
    independenceVerified: z.boolean(), gradingAuditState: z.enum(['passed', 'failed', 'pending', 'unknown']),
  })),
  reportReadbacks: z.array(canonicalRecord.merge(planIdentity).extend({
    sourceSha: source, reportId: text, path: text, publicationRef: text,
    publishedAt: z.string().datetime(), visibility: z.enum(['owner', 'workspace', 'public']),
    publishedMarkdownSha256: sha, readbackMarkdownSha256: sha, complete: z.boolean(),
  })),
});

const manifest = z.object({
  population: z.array(text).min(1),
  inventory: z.object({ checked: z.array(text), notChecked: z.array(text), notApplicable: z.array(text), residue: z.array(text) }),
  acceptanceEvidence: z.object({
    detectors: z.array(detector),
    defects: z.array(defect),
    realRuntimeReceipts: z.array(execution),
    shipmentReceipts: z.array(shipment),
  }),
});

export type CloudCampaignExecution = z.infer<typeof execution>;
export type CloudCampaignDetector = z.infer<typeof detector>;
export type CloudCampaignDefect = z.infer<typeof defect>;
export type CloudCampaignShipment = z.infer<typeof shipment>;
export type CloudCampaignManifest = z.infer<typeof manifest>;
export type CloudCampaignShipmentContext = z.infer<typeof shipmentContext>;
export type CloudCampaignBar = 'R-1' | 'R-2' | 'R-3' | 'R-4' | 'R-5' | 'R-6';
export interface CloudCampaignEvidenceContext {
  /** Source-derived denominator and obligations, NOT inferred from submitted receipts. */
  population: readonly string[];
  detectorObligations: readonly {
    scenario: string;
    class: 'happy' | 'adversarial';
    testFile: string;
    caseName: string;
    sourceSha: string;
    testFileSha256: string;
  }[];
  discoveredDefectIds: readonly string[];
  /** Unmodified rows read from the maintained ledger, joined by exact id and case title. */
  testRuns: readonly {
    id: number;
    filePath: string;
    status: string;
    commitSha: string;
    finishedAt: string;
    executionDetails: unknown;
  }[];
  runtimeObligations: readonly {
    runtime: CloudCampaignExecution['runtime'];
    sourceSha: string;
    artifactSha256: string;
    tenantId: string;
    workspaceId: string;
    accountId: string;
    runId: string;
    resourceLabel: string;
    scenarios: readonly string[];
  }[];
  /** Explicit evidence window from the campaign, never Date.now() inside a test. */
  notBefore: string;
  now: string;
  /** Exact current subject and unmodified canonical record projections. Missing context fails R6. */
  shipment?: CloudCampaignShipmentContext;
}

export function evaluateCloudCampaignEvidence(input: unknown, context: CloudCampaignEvidenceContext) {
  const problems: Record<CloudCampaignBar, string[]> = { 'R-1': [], 'R-2': [], 'R-3': [], 'R-4': [], 'R-5': [], 'R-6': [] };
  const parsed = manifest.safeParse(input);
  if (!parsed.success) {
    for (const bar of Object.keys(problems) as CloudCampaignBar[]) problems[bar].push('missing-or-malformed-campaign-evidence');
    return { passed: false, problems };
  }
  const data = parsed.data;
  const lower = Date.parse(context.notBefore), upper = Date.parse(context.now);
  const fresh = (stamp: string) => Number.isFinite(lower) && Number.isFinite(upper) && lower <= upper
    && Date.parse(stamp) >= lower && Date.parse(stamp) <= upper;
  const samePopulation = data.population.length === context.population.length
    && data.population.every((entry, index) => entry === context.population[index]);
  if (!samePopulation || !hasEnumeratedVerificationCoverage({ population: data.population, ...data.inventory })) {
    problems['R-1'].push('source-population-or-partition-mismatch');
  }
  const rows = data.acceptanceEvidence;
  const unique = (entries: readonly { id: string }[]) => new Set(entries.map((entry) => entry.id)).size === entries.length;
  const detectorPassed = (entry: CloudCampaignDetector) => entry.result === 'passed' && entry.selectedByAffected && fresh(entry.observedAt)
    && context.testRuns.some((row) => {
      const details = parseTestRunExecutionDetails(row.executionDetails);
      return row.id === entry.testRunId && row.filePath === entry.testFile && row.commitSha === entry.sourceSha
        && row.status === 'pass' && fresh(row.finishedAt) && details?.collectionFailed === false
        && details.failed === 0 && details.passedCaseTitles?.includes(entry.caseName) === true;
    });
  for (const kind of ['happy', 'adversarial'] as const) {
    const bar = kind === 'happy' ? 'R-2' : 'R-3';
    const required = context.detectorObligations.filter((entry) => entry.class === kind);
    if (!required.length || !unique(rows.detectors)) problems[bar].push('empty-obligations-or-duplicate-detectors');
    for (const obligation of required) {
      if (!context.population.includes(obligation.scenario)) problems[bar].push(`unknown-scenario:${obligation.scenario}`);
      const matches = rows.detectors.filter((entry) => entry.scenario === obligation.scenario && entry.class === kind
        && entry.testFile === obligation.testFile && entry.caseName === obligation.caseName
        && entry.sourceSha === obligation.sourceSha && entry.testFileSha256 === obligation.testFileSha256);
      if (!matches.some((entry) => detectorPassed(entry) && (kind === 'happy' || entry.negativeControl === 'caught'))) {
        problems[bar].push(`unproven-detector:${obligation.scenario}`);
      }
    }
  }
  if (!unique(rows.defects) || rows.defects.length !== context.discoveredDefectIds.length
    || context.discoveredDefectIds.some((id) => !rows.defects.some((entry) => entry.id === id))) {
    problems['R-4'].push('discovered-defect-population-mismatch');
  }
  for (const entry of rows.defects) {
    if (entry.state !== 'done') {
      if (!entry.assignee) problems['R-4'].push(`unowned-residue:${entry.id}`);
      if (entry.state === 'open') problems['R-4'].push(`unfinished-repair:${entry.id}`);
      // Deferred residue is accounted for by its owner. An open repair still owes
      // the originating fix and triggering journey, regardless of ownership.
      continue;
    }
    const root = entry.rootCauseVerification;
    if (entry.completionAuthority !== 'committed' || !entry.originatingFixRef || !root
      || missingRootCauseVerificationV2Fields(root).length || root.evidenceRefs?.length === 0) {
      problems['R-4'].push(`unverified-repair:${entry.id}`);
    }
    if (!rows.detectors.some((row) => row.id === entry.regressionDetectorId && detectorPassed(row) && row.negativeControl === 'caught')
      || !rows.realRuntimeReceipts.some((row) => row.id === entry.triggeringJourneyReceiptId && fresh(row.observedAt)
        && row.authenticated && !row.syntheticCloudResponses && row.actions.length > 0 && row.actions.every((action) => action.result === 'passed'))) {
      problems['R-4'].push(`missing-regression-or-triggering-journey:${entry.id}`);
    }
  }
  const requiredRuntimes = runtime.options;
  if (requiredRuntimes.some((name) => !context.runtimeObligations.some((entry) => entry.runtime === name))
    || context.runtimeObligations.length !== requiredRuntimes.length || !unique(rows.realRuntimeReceipts)) {
    problems['R-5'].push('incomplete-runtime-obligations-or-duplicate-receipts');
  }
  const validExecutions = new Set<string>();
  for (const obligation of context.runtimeObligations) {
    const matches = rows.realRuntimeReceipts.filter((entry) => entry.runtime === obligation.runtime);
    const valid = matches.filter((entry) => {
      if (!fresh(entry.observedAt) || !entry.authenticated || entry.syntheticCloudResponses || !obligation.scenarios.length) return false;
      for (const field of ['sourceSha', 'artifactSha256', 'tenantId', 'workspaceId', 'accountId', 'runId', 'resourceLabel'] as const) {
        if (entry[field] !== obligation[field]) return false;
      }
      if (new Set(entry.actions.map((action) => action.scenario)).size !== entry.actions.length) return false;
      if (obligation.scenarios.some((name) => !entry.actions.some((action) => action.scenario === name && action.result === 'passed'))) return false;
      if (entry.actions.some((action) => action.result !== 'passed' || !context.population.includes(action.scenario))) return false;
      if (entry.runtime === 'gcp' || entry.runtime === 'aws') {
        const census = entry.census;
        // Validate the census shape before invoking the canonical provider-specific judge.
        if (!entry.hostId || !census || census.controllerIndependent !== true || census.inventoryComplete !== true
          || census.clean !== true || !Array.isArray(census.inventoryEvidence)
          || !['managed', 'untracked', 'missing', 'labelMismatches'].every((key) => Array.isArray(census[key as keyof WorkspaceHostResourceCensus]))
          || !Array.isArray(census.reaperPlan) || census.reaperPlan.length
          || census.inventoryEvidence.some((row) => !row || typeof row.kind !== 'string'
            || !['managed-labels', 'deterministic-name'].includes(row.strategy)
            || typeof row.providerEvidenceRef !== 'string' || !row.providerEvidenceRef.trim())
          || !fresh(census.evaluatedAt) || census.managed.length || census.untracked.length || census.missing.length || census.labelMismatches.length) return false;
        if (workspaceHostResourceCensusOutcome({ subject: { workspaceId: entry.workspaceId, hostId: entry.hostId }, provider: entry.runtime, disposition: 'discard', census }).outcome !== 'committed') return false;
        if (Date.parse(census.evaluatedAt) < Date.parse(entry.observedAt) || entry.billingClosure?.result !== 'passed'
          || !fresh(entry.billingClosure.observedAt) || Date.parse(entry.billingClosure.observedAt) < Date.parse(census.evaluatedAt)) return false;
      }
      return true;
    });
    if (!valid.length) problems['R-5'].push(`unproven-runtime:${obligation.runtime}`);
    for (const entry of valid) validExecutions.add(entry.id);
  }
  const canonical = shipmentContext.safeParse(context.shipment);
  const shipping = canonical.success ? canonical.data : undefined;
  const refsUnique = (entries: readonly { ref: string }[]) => new Set(entries.map((entry) => entry.ref)).size === entries.length;
  const canonicalComplete = shipping !== undefined
    && shipping.obligations.length === requiredRuntimes.length
    && new Set(shipping.obligations.map((entry) => entry.runtime)).size === requiredRuntimes.length
    && requiredRuntimes.every((name) => shipping.obligations.some((entry) => entry.runtime === name))
    && [shipping.promotions, shipping.deployments, shipping.serving, shipping.completionAudits, shipping.planGrades, shipping.reportReadbacks].every(refsUnique)
    && new Set(shipping.subject.workItemIds).size === shipping.subject.workItemIds.length;
  if (!canonicalComplete) problems['R-6'].push('missing-or-malformed-canonical-shipment-context');
  const samePlan = (record: z.infer<typeof planIdentity>) => shipping !== undefined
    && record.planSlug === shipping.subject.planSlug && record.planRevision === shipping.subject.planRevision
    && record.planContentHash === shipping.subject.planContentHash;
  for (const obligation of context.runtimeObligations) {
    const valid = rows.shipmentReceipts.some((entry) => {
      if (!canonicalComplete || !shipping) return false;
      const final = rows.realRuntimeReceipts.find((row) => row.id === entry.finalExecutionId);
      const expected = shipping.obligations.find((row) => row.runtime === obligation.runtime);
      if (!expected || entry.runtime !== obligation.runtime || !entry.authenticated || !fresh(entry.observedAt)
        || entry.sourceSha !== obligation.sourceSha || entry.promotedSourceSha !== obligation.sourceSha
        || entry.artifactSha256 !== obligation.artifactSha256 || entry.promotedArtifactSha256 !== obligation.artifactSha256
        || final?.runtime !== entry.runtime || !validExecutions.has(final.id)) return false;
      for (const field of ['evidenceRef', 'evidenceSha256', 'promotionRef', 'deploymentRef', 'servingRef', 'auditRef', 'gradingRef', 'reportReadbackRef'] as const) {
        if (entry[field] !== expected[field]) return false;
      }
      const promotion = shipping.promotions.find((row) => row.ref === entry.promotionRef);
      const deployment = shipping.deployments.find((row) => row.ref === entry.deploymentRef);
      const served = shipping.serving.find((row) => row.ref === entry.servingRef);
      const audit = shipping.completionAudits.find((row) => row.ref === entry.auditRef);
      const grade = shipping.planGrades.find((row) => row.ref === entry.gradingRef);
      const report = shipping.reportReadbacks.find((row) => row.ref === entry.reportReadbackRef);
      if (!promotion || !deployment || !served || !audit || !grade || !report) return false;
      if (![promotion, deployment, served, audit, grade, report].every((record) => fresh(record.observedAt))) return false;
      if (![promotion, deployment, served].every((record) => record.runtime === obligation.runtime
        && record.sourceSha === obligation.sourceSha && record.artifactSha256 === obligation.artifactSha256)) return false;
      if (promotion.verdict !== 'green' || deployment.status !== 'deployed' || deployment.promotionRef !== promotion.ref
        || served.deploymentRef !== deployment.ref || !served.authenticated
        || entry.servingIdentity !== served.identity || final.servingIdentity !== served.identity
        || final.deploymentRef !== deployment.ref || entry.observedAt !== deployment.observedAt) return false;
      for (const field of ['tenantId', 'workspaceId', 'accountId', 'runId', 'resourceLabel'] as const) {
        if (served[field] !== final[field] || served[field] !== obligation[field]) return false;
      }
      if (Date.parse(deployment.observedAt) < Date.parse(promotion.observedAt)
        || Date.parse(served.observedAt) < Date.parse(deployment.observedAt)
        || Date.parse(final.observedAt) <= Date.parse(deployment.observedAt)
        || Date.parse(final.observedAt) < Date.parse(served.observedAt)) return false;
      if (![audit, grade, report].every((record) => samePlan(record) && record.sourceSha === obligation.sourceSha
        && Date.parse(record.observedAt) >= Date.parse(final.observedAt))) return false;
      if (audit.verdict !== 'passed' || audit.completionAuthority !== 'committed'
        || audit.workItemIds.length !== shipping.subject.workItemIds.length
        || new Set(audit.workItemIds).size !== audit.workItemIds.length
        || shipping.subject.workItemIds.some((id) => !audit.workItemIds.includes(id))) return false;
      if (grade.verdict !== 'passed' || !grade.independenceVerified || grade.createdBy === shipping.subject.authorId
        || grade.gradingAuditState !== 'passed' || grade.rubricRef !== shipping.subject.rubricRef
        || grade.rubricRevision !== shipping.subject.rubricRevision || grade.criteriaHash !== shipping.subject.criteriaHash) return false;
      if (!report.complete || report.visibility !== 'owner' || !fresh(report.publishedAt)
        || Date.parse(report.publishedAt) < Date.parse(final.observedAt)
        || Date.parse(report.observedAt) < Date.parse(report.publishedAt)
        || report.publishedMarkdownSha256 !== report.readbackMarkdownSha256) return false;
      return true;
    });
    if (!valid) problems['R-6'].push(`unproven-shipment:${obligation.runtime}`);
  }
  if (!context.runtimeObligations.length || rows.defects.some((entry) => entry.state !== 'done') || data.inventory.residue.length
    || !unique(rows.shipmentReceipts.map((entry) => ({ id: entry.runtime })))) problems['R-6'].push('unresolved-residue-or-runtime-population');
  // Final shipment cannot override an earlier unmet acceptance bar.
  if ((['R-1', 'R-2', 'R-3', 'R-4', 'R-5'] as const).some((bar) => problems[bar].length)) problems['R-6'].push('prior-acceptance-bar-unmet');
  return { passed: Object.values(problems).every((entries) => entries.length === 0), problems };
}
