/** Item-close deferral is a reviewed relation, never proof of the parent BAR. */
import { z } from 'zod';
import { areAcceptanceLineageRelated, resolvePlanImplementerIdentities } from '../../acceptance-author-identity';
import { parseBarMappings, parseRequirementBars } from '../../acceptance-bar-seed';
import { acceptanceBarProjectedBehavior } from '../../acceptance-bar-projection';
import { getRubric } from '../../rubrics';
import { conformanceClosureAssessment, type RequirementClosureDeclaration } from '../../spec-conformance/closure-guard';
import { readPlanBySlug } from '../plans/source';
import { planStampOf, type WorkItemForContract } from '../plans/behavior-contract-resolver';
import type { SpecClauseRevision } from '../plans/spec-clauses-store';
import { activeSpecEvidence, type SpecEvidenceForAdequacy } from '../plans/spec-test-adequacy';

const pinSchema = z.object({
  planSlug: z.string().min(1), specId: z.string().min(1),
  revision: z.number().int().positive(), contentHash: z.string().min(1),
}).strict();
const cohortSchema = z.array(z.object({ bindingId: z.number().int().positive(),
  bindingFingerprint: z.string().min(1), }).strict()).min(1).max(128)
  .refine(rows => new Set(rows.map(row => row.bindingId)).size === rows.length, 'unique proof binding IDs required');

/** Stored on an immutable independent-verification binding of the covering proof.
 * The verifier assesses the contribution boundary, including behavior/falsifier
 * coverage; the server owns identity, freshness, mapping and proof enforcement.
 * No layer or plane of the parent BAR is credited by this relation.
 */
export const itemCloseContributionSchema = z.object({
  schemaVersion: z.literal(1),
  workItemId: z.string().min(1), planItemId: z.string().regex(/^P-\d{3,}$/),
  requirementKey: z.string().min(1), barHash: z.string().min(1),
  projection: pinSchema, covering: pinSchema,
  proofCohort: cohortSchema,
  itemClose: z.object({
    behavior: z.string().min(1),
    falsifier: z.string().min(1),
    requiredTestLayers: z.array(z.string().min(1)).min(1),
    requiredEvidence: z.array(z.string().min(1)),
    mutationRequired: z.boolean(), evidencePlane: z.literal('tree'),
  }).strict(),
  disposition: z.literal('defer-parent-proof-to-plan-shipment'),
}).strict();

export interface DeferredContribution {
  requirementKey: string;
  projection: z.infer<typeof pinSchema>;
  covering: z.infer<typeof pinSchema>;
  verificationBindingId: number;
  proofCohort: z.infer<typeof cohortSchema>;
  evidencePlane: 'tree';
  reason: 'independently-verified-item-contract';
  finalGate: 'plan-shipment';
}

export interface ContributionDeferralDeps {
  /** Production reads both the canonical map and the current immutable BAR identity. */
  mappedProjection?: (clause: SpecClauseRevision) => Promise<boolean>;
  independent?: (reviewer: string, authors: string[], planSlug: string) => Promise<boolean>;
}

const pinOf = (clause: SpecClauseRevision): z.infer<typeof pinSchema> => ({
  planSlug: clause.planSlug, specId: clause.specId,
  revision: clause.revision, contentHash: clause.contentHash,
});
const samePin = (pin: z.infer<typeof pinSchema>, clause: SpecClauseRevision) =>
  pin.planSlug === clause.planSlug && pin.specId === clause.specId &&
  pin.revision === clause.revision && pin.contentHash === clause.contentHash;
const currentClause = (clause: SpecClauseRevision) =>
  clause.revision === clause.currentRevision && ['active', 'accepted'].includes(clause.lifecycleStatus);

/** Returns candidates only. The caller MUST still enforce every covering clause
 * through the ordinary adequacy gate before returning a deferral receipt. */
export async function resolveItemCloseContributions(input: {
  workItem: WorkItemForContract;
  workspaceId: string;
  completion?: RequirementClosureDeclaration;
  /** The already resolved ENFORCED population, never a caller-selected clause list. */
  clauses: readonly SpecClauseRevision[];
  evidence: SpecEvidenceForAdequacy[];
  codeDeliverable: (clause: SpecClauseRevision) => boolean | undefined;
}, deps: ContributionDeferralDeps = {}): Promise<DeferredContribution[]> {
  const stamp = planStampOf(input.workItem);
  const contributions = input.completion?.contributesTo ?? [];
  const discharges = new Set(input.completion?.discharges ?? []);
  if (!stamp || !input.workspaceId || stamp.planItemIds.length !== 1 || !contributions.length ||
      contributions.some((key) => discharges.has(key))) return [];
  const [itemId] = stamp.planItemIds;
  const evidence = activeSpecEvidence(input.evidence);
  const relations = evidence.flatMap((row) => {
    const parsed = itemCloseContributionSchema.safeParse(row.details.itemCloseContribution);
    return parsed.success && row.evidenceKind === 'independent-verification' &&
      row.id != null && row.createdBy && row.verifiesBindingId != null &&
      row.currentness.provenance === 'server-measured' && row.currentness.overall === 'current'
      ? [{ row, relation: parsed.data }] : [];
  });
  if (!relations.length) return [];

  const mappedProjection = deps.mappedProjection ?? (async (clause: SpecClauseRevision) => {
    const pin = clause.sourceBar;
    if (!pin || clause.specId !== `AUTO-BAR-${pin.barKey}-${itemId}`) return false;
    const plan = await readPlanBySlug(stamp.planSlug, {
      workspaceId: input.workspaceId, harnessSlug: stamp.harnessSlug,
    });
    if (!plan) return false;
    const bars = parseRequirementBars(plan.row.content);
    if (!bars.ok) return false;
    const map = parseBarMappings(plan.row.content, new Set(bars.bars.map((bar) => bar.barKey)));
    if (!map.ok || !map.mappings.some((entry) => entry.barKey === pin.barKey &&
      entry.planItemIds.includes(itemId!) && entry.evidencePlane === pin.evidencePlane)) return false;
    const rubric = await getRubric(pin.rubricSlug);
    if (!rubric || rubric.rubricId !== pin.rubricSlug || rubric.kind !== 'acceptance' ||
        rubric.subjectPlan !== stamp.planSlug) return false;
    // Amendments preserve unchanged clauses' historical aggregate stamps.
    // Resolve that immutable history, then compare this BAR's current meaning
    // as the canonical acceptance snapshot does; aggregate age is not drift.
    const pinned = rubric.revision === pin.rubricRevision
      ? rubric : await getRubric(pin.rubricSlug, pin.rubricRevision);
    if (!pinned || pinned.rubricId !== pin.rubricSlug || pinned.kind !== 'acceptance' ||
        pinned.subjectPlan !== stamp.planSlug || pinned.revision !== pin.rubricRevision ||
        pinned.barSetHash !== pin.barSetHash) return false;
    const historicalBar = pinned.criteria.filter((entry) => entry.barKey === pin.barKey);
    if (historicalBar.length !== 1 || historicalBar[0]!.barHash !== pin.barHash ||
        historicalBar[0]!.evidencePlane !== pin.evidencePlane ||
        acceptanceBarProjectedBehavior(historicalBar[0]!) !== clause.behavior) return false;
    const bar = rubric.criteria.filter((entry) => entry.barKey === pin.barKey);
    if (bar.length !== 1 || bar[0]!.barHash !== pin.barHash ||
        bar[0]!.evidencePlane !== pin.evidencePlane ||
        acceptanceBarProjectedBehavior(bar[0]!) !== clause.behavior ||
        (bar[0]!.requiredTestLayers ?? []).some((layer) => !clause.requiredTestLayers.includes(layer))) return false;
    const assessment = await conformanceClosureAssessment({
      workspaceId: input.workspaceId, harnessSlug: stamp.harnessSlug,
      planSlug: stamp.planSlug, planItemIds: [itemId!], completion: input.completion!,
    });
    return assessment.applicable && assessment.declarationSatisfied === true &&
      !assessment.refusal && assessment.mappedRequirements.includes(pin.barKey);
  });
  const independent = deps.independent ?? (async (reviewer: string, authors: string[], planSlug: string) => {
    const implementers = await resolvePlanImplementerIdentities(planSlug, { workspaceId: input.workspaceId });
    if (!implementers.length || !reviewer || authors.some((author) => !author)) return false;
    for (const author of new Set([...implementers, ...authors])) {
      if (await areAcceptanceLineageRelated(author, reviewer, { workspaceId: input.workspaceId })) return false;
    }
    return true;
  });

  const deferred: DeferredContribution[] = [];
  for (const projection of input.clauses) {
    const bar = projection.sourceBar;
    if (!bar || projection.planSlug !== stamp.planSlug || projection.planItemId !== itemId ||
        !currentClause(projection) || !contributions.includes(bar.barKey) || discharges.has(bar.barKey)) continue;
    const matches: DeferredContribution[] = [];
    for (const { row, relation } of relations) {
      if (relation.workItemId !== input.workItem.id || relation.planItemId !== itemId ||
          relation.requirementKey !== bar.barKey || relation.barHash !== bar.barHash ||
          !samePin(relation.projection, projection)) continue;
      const covers = input.clauses.filter((clause) => samePin(relation.covering, clause));
      if (covers.length !== 1) continue;
      const covering = covers[0]!;
      if (covering.sourceBar || !currentClause(covering) || covering.planSlug !== projection.planSlug ||
          covering.planItemId !== itemId || input.codeDeliverable(covering) === false ||
          covering.exemption || covering.behaviorClass === 'non-automated' || !covering.falsifier ||
          !covering.requiredTestLayers.length || relation.itemClose.behavior !== covering.behavior ||
          relation.itemClose.falsifier !== covering.falsifier.observation ||
          relation.itemClose.mutationRequired !== covering.mutationRequired ||
          JSON.stringify(relation.itemClose.requiredTestLayers) !== JSON.stringify(covering.requiredTestLayers) ||
          JSON.stringify(relation.itemClose.requiredEvidence) !== JSON.stringify(covering.requiredEvidence)) continue;
      const proof = evidence.find((candidate) => candidate.id === row.verifiesBindingId);
      const matchesCovering = (candidate: SpecEvidenceForAdequacy) =>
        candidate.workItemId === input.workItem.id && candidate.planSlug === covering.planSlug &&
        candidate.specId === covering.specId && candidate.specRevision === covering.revision &&
        candidate.specFingerprint === covering.contentHash && candidate.currentness.overall === 'current' &&
        candidate.currentness.provenance === 'server-measured';
      if (!proof || proof.evidenceKind === 'independent-verification' || !proof.createdBy ||
          !matchesCovering(proof) || !matchesCovering(row) ||
          row.currentness.dimensions.environment !== proof.currentness.dimensions.environment ||
          !['current', 'not-applicable'].includes(row.currentness.dimensions.environment) ||
          JSON.stringify(row.fingerprints) !== JSON.stringify(proof.fingerprints)) continue;
      const cohort = relation.proofCohort.map(pin => evidence.find(candidate =>
        candidate.id === pin.bindingId &&
        (candidate as SpecEvidenceForAdequacy & { bindingFingerprint?: string }).bindingFingerprint === pin.bindingFingerprint));
      if (!relation.proofCohort.some(pin => pin.bindingId === proof.id) ||
          cohort.some(candidate => !candidate || !matchesCovering(candidate) ||
            candidate.details.itemCloseContribution !== undefined)) continue;
      // The contract author and its verifier have distinct independence duties.
      // A verifier signature cannot turn an implementer's self-authored contract
      // into an independently authored scope boundary.
      if (!covering.createdBy || [projection.createdBy, proof.createdBy].includes(covering.createdBy)) continue;
      // A failed identity/mapping read is never an exemption. Keep the projection
      // in the ordinary proof population and let its existing refusal stand.
      try {
        if (!await mappedProjection(projection) ||
          !await independent(covering.createdBy, [projection.createdBy, proof.createdBy], stamp.planSlug) ||
          !await independent(row.createdBy!,
          [projection.createdBy, covering.createdBy, proof.createdBy], stamp.planSlug)) continue;
      } catch { continue; }
      matches.push({ requirementKey: bar.barKey, projection: pinOf(projection), covering: pinOf(covering),
        verificationBindingId: row.id!, evidencePlane: 'tree',
        proofCohort: [...relation.proofCohort].sort((a, b) => a.bindingId - b.bindingId),
        reason: 'independently-verified-item-contract', finalGate: 'plan-shipment' });
    }
    // Repeated or conflicting certificates are not an arbitrary tie-breaker.
    if (matches.length === 1) deferred.push(matches[0]!);
  }
  return deferred;
}
