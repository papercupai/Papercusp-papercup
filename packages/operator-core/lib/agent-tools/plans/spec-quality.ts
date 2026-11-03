/** Plan-level spec quality over the exact current first-class clause set (P-004). */
import { createHash } from 'node:crypto';
import { RECORDED_TEST_LAYERS, isRecordedTestLayer } from '@papercusp/test-config/execution-details';
import type { SpecClauseRevision } from './spec-clauses-store';
import { isNonAutomatedBehaviorClass } from '../../plan-verification-profile';
import {
  computeSpecSetHash,
  inspectPlanAcceptanceRef,
  normalizeSpecSemanticText,
  specBehaviorImplementationPresenceReason,
  specBehaviorNonAtomicReason,
  specBehaviorNonFalsifiableReason,
} from './spec-clause-compiler';
import { PLAN_CLASS_RUBRIC_REFS, type PlanClassRubricRef } from './spec-test-adequacy';
import { planClassAllowsAllExemptItems } from '../../plan-class-refs';

export const SPEC_QUALITY_RUBRIC_REF = 'spec-quality';

export const SPEC_QUALITY_CRITERIA = [
  'stable-revision-identity',
  'item-contract-coverage',
  'atomic-observable-behavior',
  'falsifiability',
  'implementation-independence',
  'explicit-non-behavioral-exemptions',
  'plan-class-specialization',
  'spec-set-freshness',
] as const;
export type SpecQualityCriterion = (typeof SPEC_QUALITY_CRITERIA)[number];
export type SpecQualityRating = 'pass' | 'fail' | 'unknown' | 'waived' | 'not-applicable';

export interface SpecQualityReplaySnapshot {
  planContentHash: string;
  clausesAsOf: string;
}

export interface SpecQualityRatingEntry {
  rating: SpecQualityRating;
  evidence: string;
  suggestion?: string;
}

export interface PlanSpecQualityResult {
  planSlug: string;
  classRef: PlanClassRubricRef;
  specSetHash: string;
  clauseCount: number;
  planItemCount: number;
  ratings: Record<SpecQualityCriterion, SpecQualityRatingEntry>;
  verdict: 'pass' | 'fail' | 'unknown';
  wouldBlock: SpecQualityCriterion[];
  details: {
    uncoveredPlanItemIds: string[];
    invalidExemptionSpecIds: string[];
    exemptionCensus: {
      specSetHash: string;
      currentClauseCount: number;
      exemptClauseCount: number;
      validExemptionSpecIds: string[];
      invalidExemptionSpecIds: string[];
      censusSha256: string;
      rows: Array<{
        specId: string;
        revision: number;
        planItemId: string;
        lifecycleStatus: SpecClauseRevision['lifecycleStatus'];
        behaviorClass: SpecClauseRevision['behaviorClass'];
        exemptionDeclared: boolean;
        valid: boolean | null;
        hasJustification: boolean;
        hasProvenance: boolean;
      }>;
    };
    draftSpecIds: string[];
    atomicityClauseDiagnostics: SpecQualityAtomicityClauseDiagnostic[];
    atomicityDetectorControls: Array<{ behavior: string; expected: 'atomic' | 'compound'; actual: 'atomic' | 'compound'; passed: boolean }>;
    implementationIndependenceClauseDiagnostics: SpecQualityClauseDiagnostic[];
    implementationIndependenceDetectorControls: Array<{ behavior: string; expected: 'coupled' | 'independent'; actual: 'coupled' | 'independent'; passed: boolean }>;
    exemptSourceBarProjectionMismatches: Array<{
      exemptItemId: string;
      barKey: string;
      projectionSpecId: string;
    }>;
    prerequisiteRuntimeBarMismatches: Array<{
      prerequisiteItemId: string;
      barKey: string;
      projectionSpecId: string;
      dependentImplementationItemIds: string[];
    }>;
  };
  scorecardDraft: {
    rubricRef: typeof SPEC_QUALITY_RUBRIC_REF;
    subject: { kind: 'plan'; ref: string };
    title: string;
    body: string;
    ratings: Record<SpecQualityCriterion, SpecQualityRatingEntry>;
    terminal: true;
  };
}

/** The dependency slice needed to validate BAR ownership during plan activation. */
export interface SpecQualityPlanItem {
  id: string;
  blockedBy?: readonly string[];
}

export type SpecQualityAtomicityClauseDiagnostic = SpecQualityClauseDiagnostic;

export type SpecQualityClauseDiagnostic =
  | {
      specId: string;
      planItemId: string;
      behavior: string;
      disposition: 'evaluated';
      rating: 'pass';
      reason: null;
    }
  | {
      specId: string;
      planItemId: string;
      behavior: string;
      disposition: 'evaluated';
      rating: 'fail';
      reason: string;
    }
  | {
      specId: string;
      planItemId: string;
      behavior: string;
      disposition: 'excluded';
      rating: 'not-applicable';
      reason: string;
    };

const CONTRACT_STATUSES = new Set(['active', 'accepted']);
const CURRENT_SET_STATUSES = new Set(['draft', 'active', 'accepted', 'exempt']);

function pass(evidence: string): SpecQualityRatingEntry {
  return { rating: 'pass', evidence };
}

function fail(evidence: string, suggestion: string): SpecQualityRatingEntry {
  return { rating: 'fail', evidence, suggestion };
}

function unknown(evidence: string): SpecQualityRatingEntry {
  return { rating: 'unknown', evidence };
}

function notApplicable(evidence: string): SpecQualityRatingEntry {
  return { rating: 'not-applicable', evidence };
}

function rerunnableEvidence(
  input: { planSlug: string; harnessSlug: string; classRef: PlanClassRubricRef; replaySnapshot?: SpecQualityReplaySnapshot },
  criterion: SpecQualityCriterion,
  evidence: string,
  expectedSpecSetHash: string,
): string {
  const planArgs = `slug:${JSON.stringify(input.planSlug)}, harness:${JSON.stringify(input.harnessSlug)}`;
  const evaluationArgs = planArgs + ', classRef:' + JSON.stringify(input.classRef) +
    ', expectedSpecSetHash:' + JSON.stringify(expectedSpecSetHash);
  return (
    `Source store: plans:get-specs { ${planArgs} }. ` +
    `Re-run exactly: plans:evaluate-spec-quality { ${evaluationArgs} }; ` +
    `confirm the returned specSetHash equals ${JSON.stringify(expectedSpecSetHash)}; ` +
    `inspect ratings[${JSON.stringify(criterion)}]. ${evidence}` +
    (input.replaySnapshot ? ' Historical replay (same rated snapshot): plans:evaluate-spec-quality ' +
      JSON.stringify({ slug: input.planSlug, harness: input.harnessSlug, classRef: input.classRef,
        expectedSpecSetHash, replaySnapshot: input.replaySnapshot }) + '.' : '')
  );
}

/** Replay metadata is orthogonal to the current gate's exact findings. Do not
 * relax the stored card fingerprint or normalize any other evidence text. */
export function specQualityEvidenceWithoutReplay(evidence: string, input: {
  planSlug: string; classRef: PlanClassRubricRef; specSetHash: string;
}): string {
  const marker = ' Historical replay (same rated snapshot): plans:evaluate-spec-quality ';
  const at = evidence.lastIndexOf(marker);
  if (at < 0 || !evidence.endsWith('.')) return evidence;
  try {
    const args = JSON.parse(evidence.slice(at + marker.length, -1));
    if (args.slug !== input.planSlug || args.classRef !== input.classRef ||
      args.expectedSpecSetHash !== input.specSetHash || typeof args.harness !== 'string' ||
      !/^[a-f0-9]{64}$/.test(args.replaySnapshot?.planContentHash ?? '') ||
      !Number.isFinite(Date.parse(args.replaySnapshot?.clausesAsOf))) return evidence;
    return evidence.slice(0, at);
  } catch { return evidence; }
}

function trimmedField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function validExplicitExemption(clause: SpecClauseRevision): boolean {
  if (clause.lifecycleStatus !== 'exempt' || !isNonAutomatedBehaviorClass(clause.behaviorClass)) return false;
  const exemption = clause.exemption;
  if (!exemption || typeof exemption !== 'object' || Array.isArray(exemption)) return false;
  return Boolean(trimmedField(exemption.justification) && trimmedField(exemption.provenance));
}

function sourceBarIdentity(clause: SpecClauseRevision): string | null {
  const pin = clause.sourceBar;
  if (!pin) return null;
  return JSON.stringify([
    pin.rubricSlug,
    pin.barKey,
    pin.barHash,
    pin.barSetHash,
    pin.rubricRevision,
    pin.evidencePlane,
  ]);
}

function requiresRuntimeEvidence(clause: SpecClauseRevision): boolean {
  return clause.requiredTestLayers.length > 0 || clause.requiredEvidence.length > 0 || clause.mutationRequired;
}

function dependentItemIdsOf(
  prerequisiteItemId: string,
  planItemIds: readonly string[],
  planItems: readonly SpecQualityPlanItem[],
): string[] {
  const inPlan = new Set(planItemIds);
  const descendants = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of planItems) {
      if (!inPlan.has(item.id) || item.id === prerequisiteItemId || descendants.has(item.id)) continue;
      if ((item.blockedBy ?? []).some((blocker) => blocker === prerequisiteItemId || descendants.has(blocker))) {
        descendants.add(item.id);
        changed = true;
      }
    }
  }
  return [...descendants].sort();
}

function prerequisiteRuntimeBarMismatches(input: {
  planItemIds: readonly string[];
  planItems?: readonly SpecQualityPlanItem[];
  behavioralClauses: readonly SpecClauseRevision[];
  validExemptions: readonly SpecClauseRevision[];
}): PlanSpecQualityResult['details']['prerequisiteRuntimeBarMismatches'] {
  if (!input.planItems?.length) return [];

  const nonCodePrerequisiteItemIds = new Set([
    ...input.validExemptions
      .filter((clause) => clause.requiredTestLayers.length === 0 && !clause.mutationRequired)
      .map((clause) => clause.planItemId),
    ...input.behavioralClauses
      .filter((clause) =>
        isNonAutomatedBehaviorClass(clause.behaviorClass) &&
        clause.requiredTestLayers.length === 0 &&
        !clause.mutationRequired,
      )
      .map((clause) => clause.planItemId),
  ]);
  const runtimeProjections = input.behavioralClauses.filter(
    (clause) => clause.sourceBar && requiresRuntimeEvidence(clause),
  );
  const runtimeImplementations = input.behavioralClauses.filter(
    (clause) =>
      !clause.sourceBar &&
      !isNonAutomatedBehaviorClass(clause.behaviorClass) &&
      requiresRuntimeEvidence(clause),
  );
  const mismatches: PlanSpecQualityResult['details']['prerequisiteRuntimeBarMismatches'] = [];

  for (const prerequisiteItemId of nonCodePrerequisiteItemIds) {
    // An active independent behavior contract makes this a mixed/code item, not a
    // purely non-code prerequisite. Do not use the exemption to classify it away.
    if (input.behavioralClauses.some(
      (clause) =>
        clause.planItemId === prerequisiteItemId &&
        !clause.sourceBar &&
        !isNonAutomatedBehaviorClass(clause.behaviorClass),
    )) continue;

    const descendants = dependentItemIdsOf(prerequisiteItemId, input.planItemIds, input.planItems);
    if (descendants.length === 0) continue;
    const descendantSet = new Set(descendants);
    const ownProjections = runtimeProjections.filter((clause) => clause.planItemId === prerequisiteItemId);
    for (const projection of ownProjections) {
      const identity = sourceBarIdentity(projection);
      if (!identity) continue;
      const dependentImplementationItemIds = [...new Set(
        runtimeProjections
          .filter((candidate) =>
            descendantSet.has(candidate.planItemId) &&
            sourceBarIdentity(candidate) === identity &&
            !nonCodePrerequisiteItemIds.has(candidate.planItemId) &&
            runtimeImplementations.some((contract) => contract.planItemId === candidate.planItemId),
          )
          .map((candidate) => candidate.planItemId),
      )].sort();
      if (dependentImplementationItemIds.length === 0) continue;
      mismatches.push({
        prerequisiteItemId,
        barKey: projection.sourceBar!.barKey,
        projectionSpecId: projection.specId,
        dependentImplementationItemIds,
      });
    }
  }

  return mismatches.sort((a, b) =>
    a.prerequisiteItemId.localeCompare(b.prerequisiteItemId) ||
    a.barKey.localeCompare(b.barKey) ||
    a.projectionSpecId.localeCompare(b.projectionSpecId),
  );
}

/**
 * A non-behavioral exemption covers the item's complete current clause scope.
 * An active sourceBar projection is itself an enforceable behavior clause, so it
 * cannot share that item with an exemption even when no dependency edge happens
 * to expose the contradiction as a prerequisite mismatch.
 */
function exemptSourceBarProjectionMismatches(input: {
  behavioralClauses: readonly SpecClauseRevision[];
  validExemptions: readonly SpecClauseRevision[];
}): PlanSpecQualityResult['details']['exemptSourceBarProjectionMismatches'] {
  const exemptItemIds = new Set(input.validExemptions.map((clause) => clause.planItemId));
  return input.behavioralClauses
    .filter((clause) => clause.sourceBar && exemptItemIds.has(clause.planItemId))
    .map((clause) => ({
      exemptItemId: clause.planItemId,
      barKey: clause.sourceBar!.barKey,
      projectionSpecId: clause.specId,
    }))
    .sort((a, b) =>
      a.exemptItemId.localeCompare(b.exemptItemId) ||
      a.barKey.localeCompare(b.barKey) ||
      a.projectionSpecId.localeCompare(b.projectionSpecId),
    );
}

/**
 * A repository path in contract text: a source-tree directory token (`src/`,
 * `tests/fixtures/x.json`) or a markup/data/config file that is not a served
 * URL. Served paths (`/architecture/index.html`, `https://…/x.json`) start
 * with `/` or a scheme and are observable boundaries, so they are skipped.
 * A directory token counts only with a trailing slash, a second segment or a
 * file extension, so English such as "opt out/in" stays independent. An
 * unqualified test/run/case-style category chain in a parallel conceptual
 * list is ambiguous, not evidence of a filesystem prescription.
 */
const REPO_DIR_TOKEN_RE =
  /(?:^|[\s(\[`'"])((?:\.\/)?(?:src|tests?|libs?|packages|apps|scripts|fixtures|dist|out)\/[\w*.-]*(?:\/[\w*.-]*)*)/gi;
const NON_CODE_FILE_TOKEN_RE = /(?:^|[\s(\[`'"])([^\s()[\]`'"]+\.(?:html?|css|json|ya?ml|toml))\b/gi;
// A code-file NAME needs a basename before its extension, like NON_CODE_FILE_TOKEN_RE.
// A bare extension used as a population qualifier ("500 .ts edit-ledger rows") names a
// file TYPE, not a file (WI-6554700010029504). Non-global: used with .test().
const CODE_FILE_TOKEN_RE = /(?:^|[\s(\[`'"])[^\s()[\]`'"]+\.(?:[cm]?[jt]sx?|rs|py|sql|sh)\b/i;

function repositoryPathReason(text: string): string | null {
  for (const match of text.matchAll(REPO_DIR_TOKEN_RE)) {
    const token = match[1].replace(/\.+$/, '');
    // "between test/run/case, invocation/workflow" lists domain categories.
    // Require a bare singular test chain, the list introducer, and a peer
    // that is not another source-tree path. Quotes, ./, extensions, globs,
    // trailing slashes and explicit path qualifiers retain the path check.
    const peer = /^\s*,\s*([a-z]+(?:\/[a-z]+)+)\b/i.exec(text.slice(match.index! + match[0].length));
    if (/^test\/[a-z]+(?:\/[a-z]+)+$/i.test(token) &&
        match[0].trimStart() === token &&
        /\b(?:between|among|across)$/i.test(text.slice(0, match.index).trimEnd()) &&
        peer && !new RegExp(REPO_DIR_TOKEN_RE.source, 'i').test(peer[1])) continue;
    const rest = token.replace(/^(?:\.\/)?[^/]+\//, '');
    if (rest === '' || rest.includes('/') || /\.\w+$/.test(rest) || rest.includes('*')) {
      return 'names a repository path ' + JSON.stringify(token);
    }
  }
  for (const match of text.matchAll(NON_CODE_FILE_TOKEN_RE)) {
    const token = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i.test(token)) continue;
    return 'names an implementation file ' + JSON.stringify(token);
  }
  return null;
}

/**
 * The clause fields whose text must stay implementation-independent: the
 * behavior AND the falsifier's observation (what a reader would SEE if the
 * promise broke). `falsifier.probeMethod` is deliberately excluded — it says
 * HOW to elicit the observation and legitimately names tests and probes.
 */
function clauseImplementationCouplingReason(clause: SpecClauseRevision): string | null {
  const behaviorReason = implementationCouplingReason(clause.behavior);
  if (behaviorReason) return behaviorReason;
  const observation = clause.falsifier?.observation;
  if (!observation) return null;
  const observationReason = implementationCouplingReason(observation, clause.behavior);
  return observationReason ? 'falsifier observation ' + observationReason : null;
}

/** Public data names describe an observable contract. Mask only their declared
 * occurrences; the same name used later as private machinery still fails. */
function withoutPublicContractIdentifiers(behavior: string): string {
  let text = behavior.replace(
    /\b[a-z][a-z0-9-]*(?::(?:[a-z][a-z0-9-]*|<[A-Za-z_][A-Za-z0-9_]*>)){1,}/g,
    (template) => template.replace(/<[A-Za-z_][A-Za-z0-9_]*>/g, (param) => ' '.repeat(param.length)),
  );
  text = text.replace(
    /(\b(?:response|results?|payload)\s+(?:includes?|contains?|returns?)\s+)([A-Za-z_$][A-Za-z0-9_$]*)/gi,
    (_match, prefix: string, field: string) => prefix + ' '.repeat(field.length),
  );
  // A recorded field with a literal value describes public data, just as a
  // response field does. Require a data subject and the quoted value; mask only
  // this occurrence so a helper or later use of the same name still fails.
  text = text.replace(
    /(\b(?:scorecard|criterion|rating|receipt|record|row|payload|response|result|assessment|entry)\b[^.;\n]{0,160}?\b(?:recorded|stored|persisted|returned)\s+with\s+)([a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*)(?=\s+(?:'[^'\r\n]+'|"[^"\r\n]+"))/gi,
    (_match, prefix: string, field: string) => prefix + ' '.repeat(field.length),
  );
  // Names in persisted/public records are observable even when an observation
  // describes a missing or lost field instead of a successful response. Stop
  // before explanatory clauses so a private helper later in the sentence is
  // still inspected by the implementation-coupling checks.
  text = text.replace(
    /\b(?:(?:persisted|stored|serialized|public|diagnostic|assessment)\s+){0,2}(?:data|receipt|record|row|payload|response|results?)\s+(?:includes?|contains?|returns?|lists?|records?|stores?|persists?|loses?|omits?|drops?|lacks?)\s+([^.;\n]*?)(?=\s*,?\s+(?:or\s+(?:has|have|is|are|was|were|does|do|did)|because|which|that)\b|[.;\n]|$)/gi,
    (_match, fields: string) => fields.replace(
      /\b[a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/g,
      (field) => ' '.repeat(field.length),
    ),
  );
  // Timestamp properties describe an externally visible row shape when the
  // contract observes a stamped record, not the implementation that wrote it.
  text = text.replace(
    /\b([a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*)-(?:stamped|timestamped)\s+(?:row|record|entry|receipt|assessment)\b/gi,
    (_match, field: string) => ' '.repeat(field.length),
  );
  // Catalog/schema parameter lists and classifications expose data to callers.
  // Bound each match to its sentence so it cannot hide a later helper call.
  text = text.replace(/[^.;\n]+/g, (sentence) => {
    if (!/\b(?:catalog|schema)\b/i.test(sentence)) return sentence;
    return sentence
      .replace(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:\s*(?:,|and)\s*[A-Za-z_$][A-Za-z0-9_$]*)*\s+(?:params|parameters)\b/g,
        (params) => params.replace(/\b[a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/g, (param) => ' '.repeat(param.length)))
      .replace(/(\bclassifies\s+)([A-Za-z_$][A-Za-z0-9_$]*)/g,
        (_match, prefix: string, field: string) => prefix + ' '.repeat(field.length));
  });
  return text;
}

function implementationCouplingReason(behavior: string, publicContract?: string): string | null {
  const sourcePresence = specBehaviorImplementationPresenceReason(behavior);
  if (sourcePresence) return sourcePresence;
  if (CODE_FILE_TOKEN_RE.test(behavior)) return 'names an implementation file';
  const repositoryPath = repositoryPathReason(behavior);
  if (repositoryPath) return repositoryPath;
  const internalRouteCall =
    /\b(?:call(?:s|ed)?|invoke(?:s|d)?|route(?:s|d)?|wire(?:s|d)?)\b[^.\n]{0,160}\/(?:admin|internal|oauth|api)(?:\/[A-Za-z0-9._~-]+)*/i.exec(behavior);
  if (internalRouteCall) {
    return 'prescribes an internal route ' + JSON.stringify(internalRouteCall[0].trim());
  }
  // Hyphenated domain adjectives ("customer-local operation", "read-only
  // operation") do not identify code. Require a call prescription, an explicit
  // internal/name qualifier, or a quoted identifier before treating one as an
  // implementation reference. Quoted names must not evade the same detector.
  const operationReference =
    /\b(?:calls?|called|invokes?|invoked|dispatch(?:es|ed)?|executes?|executed|runs?|ran)\s+(?:the\s+)?(?:internal\s+)?[a-z][a-z0-9]*(?:-[a-z0-9]+)+\s+(?:op|operation)\b/i.exec(behavior) ??
    /\b(?:internal|named)\s+[a-z][a-z0-9]*(?:-[a-z0-9]+)+\s+(?:op|operation)\b/i.exec(behavior) ??
    /[`'"][a-z][a-z0-9]*(?:-[a-z0-9]+)+[`'"]\s+(?:op|operation)\b/i.exec(behavior);
  if (operationReference) {
    return 'names an internal operation ' + JSON.stringify(operationReference[0]);
  }
  const existingSurfaceReuse =
    /\b(?:extend|extends|reuse|reuses|modify|modifies|wire|wires|integrate|integrates)\b[^.\n]{0,80}\bexisting\s+(?:[\w/-]+\s+){0,6}(?:page|screen|route|endpoint|component|handler|operation|op|module|service|runtime|flow|ledger|diagnostics|instrumentation|mechanism|pipeline|records?|capability)\b/i.exec(behavior);
  if (existingSurfaceReuse) {
    return 'prescribes reuse of an existing implementation surface ' + JSON.stringify(existingSurfaceReuse[0].trim());
  }
  // A contract can prescribe machinery without a reuse verb ("through the
  // existing runtime"), or name the machinery directly ("Reuse PostHog").
  // Restrict the former to implementation nouns and usage/subject positions:
  // an existing customer/account is an observable identity, not code coupling.
  const implementationPrescription =
    /\b(?:through|via|using)\s+(?:the\s+)?existing\s+(?:[\w/-]+\s+){0,6}(?:page|screen|route|endpoint|component|handler|operation|op|module|service|runtime|flow|ledger|diagnostics|instrumentation|mechanism|pipeline|records?|capability)\b/i.exec(behavior) ??
    /\bexisting\s+(?:[\w/-]+\s+){0,6}(?:page|screen|route|endpoint|component|handler|operation|op|module|service|runtime|flow|ledger|diagnostics|instrumentation|mechanism|pipeline|records?|capability)\s+(?:implements?|handles?|runs?|invokes?|provides?)\b/i.exec(behavior);
  if (implementationPrescription) {
    return 'prescribes implementation reuse or selection ' + JSON.stringify(implementationPrescription[0].trim());
  }
  // Reusing verification proof does not choose the implementation under test.
  // Inspect each imperative separately so a proof-reuse instruction cannot hide
  // a later machinery choice. All source/route/storage/construct checks still
  // inspect the complete behavior, including any qualifying proof condition.
  const verificationProofReuse = /^reuse\s+(?:(?:the|prior|previous|current|clean|passing|verified|existing)\s+)*(?:(?:verification|test|check|proof)\s+)?(?:receipts?|evidence|(?:test|check)\s+results?)(?:\s+(?:when|if)\s+[^.!?;\n]+)?$/i;
  const imperativePrescriptions = /(?:^|[.!?;]\s*)(?:reuse|extend|modify|wire|integrate|evaluate)\s+(?!(?:of|is|was|will|must|can|may)\b)[^.!?;\n]+/gi;
  for (const match of behavior.matchAll(imperativePrescriptions)) {
    const prescription = match[0].replace(/^[.!?;]\s*/, '').trim();
    if (!verificationProofReuse.test(prescription)) {
      return 'prescribes implementation reuse or selection ' + JSON.stringify(prescription);
    }
  }
  // A semicolon separates observations just like a sentence boundary. Do not
  // join a persistence verb in one clause to a backend or permission in another.
  const filesystemPermission =
    /\b0[0-7]{3}\b[^.!?;\n]{0,60}\b(?:file|file\s+system|filesystem|directory)\b|\b(?:file|file\s+system|filesystem|directory)\b[^.!?;\n]{0,60}\b0[0-7]{3}\b/i.exec(behavior);
  const namedStorageBackend =
    /\b(?:stored|persisted|written|saved|kept|mirrored|replicated)\b[^.!?;\n]{0,80}\b(?:postgres(?:ql)?|mysql|mariadb|sqlite|redis|s3|object\s+storage|keychain|key\s+store)\b|\b(?:postgres(?:ql)?|mysql|mariadb|sqlite|redis|s3|object\s+storage|keychain|key\s+store)\b[^.!?;\n]{0,80}\b(?:database|storage|store)\b/i.exec(behavior);
  const storageEncryptionOrMirroring =
    /\b(?:encrypt(?:ed|ion|ing)?|mirror(?:s|ed|ing)?|replicat(?:e|es|ed|ing|ion)|replica)\b[^.!?;\n]{0,80}\b(?:postgres(?:ql)?|database|db|file|filesystem|storage|store)\b|\b(?:postgres(?:ql)?|database|db|file|filesystem|storage|store)\b[^.!?;\n]{0,80}\b(?:encrypt(?:ed|ion|ing)?|mirror(?:s|ed|ing)?|replicat(?:e|es|ed|ing|ion)|replica)\b/i.exec(behavior);
  const storageMechanism = filesystemPermission ?? namedStorageBackend ?? storageEncryptionOrMirroring;
  if (storageMechanism) {
    return 'prescribes a storage mechanism ' + JSON.stringify(storageMechanism[0].trim());
  }
  const constructReference =
    /\b(?:function|class|method|variable|private field|implementation detail)\s+(`[^`]+`|'[^']+'|"[^"]+"|[A-Za-z_$][A-Za-z0-9_$]*)/gi;
  for (const match of behavior.matchAll(constructReference)) {
    const token = match[1];
    const explicitlyQuoted = new RegExp('^[`' + '\'"' + ']').test(token);
    const identifier = explicitlyQuoted ? token.slice(1, -1) : token;
    const identifierLooksLikeSymbol =
      /^[A-Z_$]/.test(identifier) || /[_$]/.test(identifier) || /[A-Z0-9]/.test(identifier.slice(1));
    if (explicitlyQuoted || identifierLooksLikeSymbol) {
      return 'names implementation construct ' + JSON.stringify(match[0]) + ' instead of an observable contract';
    }
  }
  // A bare lower-camel identifier is also an implementation reference: clauses
  // can name a function directly (for example, `runSyncBatchDeltaCheck
  // evaluates the batch`) without an introductory "function" or code quotes.
  // Public platform and device product names (Apple brands them lowerCamel)
  // describe the environment visible to a user, not code. Continue scanning
  // after them so a later actual implementation symbol still fails.
  const publicPlatformNames = new Set([
    'macOS',
    'iOS',
    'iPadOS',
    'watchOS',
    'tvOS',
    'visionOS',
    'iPhone',
    'iPad',
    'iPod',
    'iMac',
  ]);
  let identifierText = withoutPublicContractIdentifiers(behavior);
  if (publicContract) {
    const contractText = withoutPublicContractIdentifiers(publicContract);
    const publicNames = new Set([...publicContract.matchAll(/\b[a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/g)]
      .map((match) => match[0]).filter((name) => !contractText.includes(name)));
    identifierText = identifierText.replace(
      /(\bwithout\s+|\bits\s+)([A-Za-z_$][A-Za-z0-9_$]*)(?=\b)/gi,
      (match, prefix: string, name: string) => publicNames.has(name) ? prefix + ' '.repeat(name.length) : match,
    );
  }
  for (const match of identifierText.matchAll(/\b[a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/g)) {
    if (!publicPlatformNames.has(match[0])) {
      return 'names implementation construct ' + JSON.stringify(match[0]) + ' instead of an observable contract';
    }
  }
  return null;
}

function planClassFit(classRef: PlanClassRubricRef, clauses: SpecClauseRevision[]): { ok: boolean; evidence: string } {
  const classes = [...new Set(clauses.map((clause) => clause.behaviorClass))].sort();
  if (classRef === 'plan-class-feature-ship') {
    return {
      ok: clauses.length > 0,
      evidence: clauses.length
        ? `Feature plan has ${clauses.length} active behavioral clause(s): ${classes.join(', ')}.`
        : 'Feature plans require at least one active behavioral clause.',
    };
  }
  if (classRef === 'plan-class-bugfix') {
    const ok = clauses.some((clause) => clause.behaviorClass === 'failure' || clause.behaviorClass === 'boundary');
    return {
      ok,
      evidence: ok
        ? 'Bugfix plan includes an active failure/boundary regression contract.'
        : 'Bugfix plans require an active failure or boundary clause for the reproduced defect.',
    };
  }
  if (classRef === 'plan-class-migration') {
    const ok = clauses.some((clause) => clause.behaviorClass === 'migration-data-integrity');
    return {
      ok,
      evidence: ok
        ? 'Migration plan includes an active migration-data-integrity contract.'
        : 'Migration plans require an active migration-data-integrity clause.',
    };
  }
  if (classRef === 'plan-class-general') {
    // The general-plan variant of this criterion (plan-verification-profiles P-006): any
    // active outcome contract qualifies, and none is required to declare a test layer —
    // a general plan's non-code deliverables are verified by artifact, work-item,
    // measurement or external citations, not by a test run.
    return {
      ok: clauses.length > 0,
      evidence: clauses.length
        ? `General plan has ${clauses.length} active outcome contract(s): ${classes.join(', ')}; no test layer is required of a general plan.`
        : 'General plans require at least one active outcome contract, or explicit item exemptions.',
    };
  }
  const ok = clauses.some(
    (clause) => clause.behaviorClass === 'observability' || isNonAutomatedBehaviorClass(clause.behaviorClass),
  );
  return {
    ok,
    evidence: ok
      ? 'Investigation plan includes an active observability/non-automated contract.'
      : 'Investigation plans require an observability or non-automated clause, or explicit item exemptions.',
  };
}

/** Stable, bounded scorecard subject for one plan/class/exact current spec set. */
export function specQualitySubjectRef(planSlug: string, classRef: PlanClassRubricRef, specSetHash: string): string {
  const planKey = createHash('sha256').update(planSlug).digest('hex').slice(0, 16);
  return `spec-set:${classRef}:${specSetHash}:${planKey}`;
}

/**
 * The plan items that owe a spec contract: every item except a deliberately
 * dropped one. A dropped item is a recorded departure (`plans:set-status
 * { status:'dropped', note }`), so demanding a clause or exemption for it forced
 * authors to file fake exemptions just to start a plan (WI-10006208). Every
 * caller that feeds `planItemIds` to the spec-quality evaluator or gate builds
 * the list through this one function so the rule cannot drift between them.
 */
export function specQualityPlanItemIds(
  items: ReadonlyArray<{ id: string; storedStatus?: string | null; status?: string | null }>,
): string[] {
  // The canonical derived index stores `status`; the Markdown parser exposes
  // `storedStatus`. Preflight, locked approval and promotion must agree on both.
  return items.filter((item) => (item.storedStatus ?? item.status) !== 'dropped').map((item) => item.id);
}

/**
 * Grade one exact current set. Every plan item must either own an active behavior
 * clause or an explicit non-automated exemption; absence is never inferred as
 * non-behavioral.
 */
export function evaluatePlanSpecQuality(input: {
  planSlug: string;
  harnessSlug: string;
  planItemIds: readonly string[];
  planItems?: readonly SpecQualityPlanItem[];
  clauses: readonly SpecClauseRevision[];
  classRef: PlanClassRubricRef;
  expectedSpecSetHash?: string;
  replaySnapshot?: SpecQualityReplaySnapshot;
}): PlanSpecQualityResult {
  const planItemIds = [...new Set(input.planItemIds)].sort();
  const currentSet = input.clauses
    .filter((clause) => CURRENT_SET_STATUSES.has(clause.lifecycleStatus))
    .slice()
    .sort((a, b) => a.specId.localeCompare(b.specId));
  const behavioral = currentSet.filter((clause) => CONTRACT_STATUSES.has(clause.lifecycleStatus));
  const exemptions = currentSet.filter((clause) => clause.lifecycleStatus === 'exempt');
  const validExemptions = exemptions.filter(validExplicitExemption);
  const invalidExemptionSpecIds = exemptions
    .filter((clause) => !validExplicitExemption(clause))
    .map((clause) => clause.specId);
  const specSetHash = computeSpecSetHash(currentSet);
  const exemptionCensusRows = currentSet.map((clause) => {
    const exemptionDeclared = clause.lifecycleStatus === 'exempt';
    const hasJustification = typeof clause.exemption?.justification === 'string' &&
      Boolean(clause.exemption.justification.trim());
    const hasProvenance = typeof clause.exemption?.provenance === 'string' &&
      Boolean(clause.exemption.provenance.trim());
    return {
      specId: clause.specId,
      revision: clause.revision,
      planItemId: clause.planItemId,
      lifecycleStatus: clause.lifecycleStatus,
      behaviorClass: clause.behaviorClass,
      exemptionDeclared,
      valid: exemptionDeclared ? validExplicitExemption(clause) : null,
      hasJustification,
      hasProvenance,
    };
  });
  const exemptionCensusSha256 = createHash('sha256').update(JSON.stringify(exemptionCensusRows)).digest('hex');
  const exemptionCensus = {
    specSetHash,
    currentClauseCount: currentSet.length,
    exemptClauseCount: exemptions.length,
    validExemptionSpecIds: validExemptions.map((clause) => clause.specId),
    invalidExemptionSpecIds,
    censusSha256: exemptionCensusSha256,
    rows: exemptionCensusRows,
  };
  const exemptionCensusEvidence =
    `Exact clause scope ${specSetHash} contains ${currentSet.length} current row(s); ` +
    `${exemptions.length} exempt (${JSON.stringify(exemptions.map((clause) => `${clause.specId}@${clause.revision}`))}), ` +
    `${validExemptions.length} valid and ${invalidExemptionSpecIds.length} invalid; ` +
    `invalid ids=${JSON.stringify(invalidExemptionSpecIds)}; row census SHA-256=${exemptionCensusSha256}. ` +
    'Replay this exact snapshot and compare details.exemptionCensus.rows.';
  const ratings = {} as Record<SpecQualityCriterion, SpecQualityRatingEntry>;

  const seenSpecIds = new Set<string>();
  const seenAliases = new Set<string>();
  const identityFailures: string[] = [];
  for (const clause of currentSet) {
    if (seenSpecIds.has(clause.specId)) identityFailures.push(`${clause.specId}:duplicate-spec-id`);
    seenSpecIds.add(clause.specId);
    if (clause.sourceValId) {
      if (seenAliases.has(clause.sourceValId)) identityFailures.push(`${clause.sourceValId}:duplicate-source-alias`);
      seenAliases.add(clause.sourceValId);
    }
    if (clause.revision !== clause.currentRevision) identityFailures.push(`${clause.specId}:not-current-revision`);
    if (!clause.contentHash.trim()) identityFailures.push(`${clause.specId}:missing-content-hash`);
    if (CONTRACT_STATUSES.has(clause.lifecycleStatus) && (!clause.acceptedBy || !clause.acceptanceRef)) {
      identityFailures.push(`${clause.specId}:missing-acceptance-provenance`);
    }
    const acceptanceRefInspection = inspectPlanAcceptanceRef(clause.acceptanceRef, clause.planItemId, input.harnessSlug);
    if (acceptanceRefInspection.kind === 'invalid') {
      identityFailures.push(`${clause.specId}:${acceptanceRefInspection.code}`);
    }
  }
  const provenanceBearingClauses = currentSet.filter((clause) => CONTRACT_STATUSES.has(clause.lifecycleStatus));
  const draftClauses = currentSet.filter((clause) => clause.lifecycleStatus === 'draft');
  const exemptClauses = currentSet.filter((clause) => clause.lifecycleStatus === 'exempt');
  const provenanceEvidence = [
    // Evidence participates in the audited card fingerprint. The original wording
    // is truthful for an all-active/accepted set; do not churn its settled cards
    // when correcting the distinct draft/exempt populations (EI-22759986393772535).
    `${provenanceBearingClauses.length} ${provenanceBearingClauses.length === currentSet.length ? 'current' : 'active/accepted current'} clause(s) have unique identities, content hashes, and acceptance provenance.`,
    draftClauses.length
      ? `${draftClauses.length} draft current clause(s) are present and excluded from the acceptance-provenance count.`
      : null,
    exemptClauses.length
      ? `${exemptClauses.length} exempt current clause(s) are present and do not require acceptance provenance.`
      : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(' ');
  ratings['stable-revision-identity'] = identityFailures.length
    ? fail(
        `Revision/identity failures: ${identityFailures.join(', ')}.`,
        'Repair duplicate identities, select only current revisions, and use valid acceptance provenance; structured plan refs must name a positive revision and matching plan item.',
      )
    : pass(provenanceEvidence);

  const behaviorGroups = new Map<string, SpecClauseRevision[]>();
  for (const clause of behavioral) {
    const key = normalizeSpecSemanticText(clause.behavior);
    const group = behaviorGroups.get(key) ?? [];
    group.push(clause);
    behaviorGroups.set(key, group);
  }
  // A sourceBar pin makes this clause a projection of the canonical acceptance
  // BAR, repeated once for each mapped plan item. It is not an independently
  // authored item contract, so item coverage, atomicity, and falsifiability use
  // unpinned item clauses. The first-party implementation-independence rubric
  // applies to active behavior text, so that criterion also checks BAR copies.
  const isProjectedBar = (clause: SpecClauseRevision) => clause.sourceBar != null;
  const isUnpinnedAutoBar = (clause: SpecClauseRevision) =>
    !clause.sourceBar && clause.specId.startsWith('AUTO-BAR-');
  const itemBehavioral = behavioral.filter((clause) => !isProjectedBar(clause));
  const independentItemBehavioral = itemBehavioral.filter((clause) => !isUnpinnedAutoBar(clause));
  const barPinMismatches = [...behaviorGroups.values()]
    .filter((group) => new Set(group.map((clause) => clause.planItemId)).size > 1)
    .filter((group) => group.some((clause) => isProjectedBar(clause) || isUnpinnedAutoBar(clause)))
    .filter((group) => {
      const pin = group[0]?.sourceBar;
      return !pin || group.some((clause) => {
        const source = clause.sourceBar;
        return (
          source == null ||
          source.rubricSlug !== pin.rubricSlug ||
          source.barKey !== pin.barKey ||
          source.barHash !== pin.barHash ||
          source.barSetHash !== pin.barSetHash ||
          source.evidencePlane !== pin.evidencePlane
        );
      });
    })
    .map((group) => {
      const specIds = [...new Set(group.map((clause) => clause.specId))].sort();
      return 'projected specs ' + specIds.join(', ') + ' do not share one identical source BAR pin';
    });
  const itemBehaviorGroups = new Map<string, SpecClauseRevision[]>();
  for (const clause of itemBehavioral) {
    const key = normalizeSpecSemanticText(clause.behavior);
    const group = itemBehaviorGroups.get(key) ?? [];
    group.push(clause);
    itemBehaviorGroups.set(key, group);
  }
  const duplicateBehaviorReuse = [...itemBehaviorGroups.values()]
    .filter((group) => new Set(group.map((clause) => clause.planItemId)).size > 1)
    .map((group) => {
      const specIds = [...new Set(group.map((clause) => clause.specId))].sort();
      const itemIds = [...new Set(group.map((clause) => clause.planItemId))].sort();
      return 'specs ' + specIds.join(', ') + ' reuse the same behavior text across plan items ' + itemIds.join(', ');
    });
  const unpinnedAutoBarIds = itemBehavioral.filter(isUnpinnedAutoBar).map((clause) => clause.specId).sort();
  const coveredItems = new Set([...independentItemBehavioral, ...validExemptions].map((clause) => clause.planItemId));
  const uncoveredPlanItemIds = planItemIds.filter((itemId) => !coveredItems.has(itemId));
  const runtimeBarMismatches = prerequisiteRuntimeBarMismatches({
    planItemIds,
    planItems: input.planItems,
    behavioralClauses: behavioral,
    validExemptions,
  });
  const exemptProjectionMismatches = exemptSourceBarProjectionMismatches({
    behavioralClauses: behavioral,
    validExemptions,
  });
  const projectionEvidence = behavioral.some((clause) => clause.sourceBar)
    ? ` ${behavioral.filter((clause) => clause.sourceBar).length} sourceBar-pinned projection(s) are excluded as copies of canonical acceptance BARs; added or meaning-changed BAR projections are checked on rubric writes, while unchanged legacy BARs are not re-certified here.`
    : '';
  ratings['item-contract-coverage'] = uncoveredPlanItemIds.length
    ? fail(
        `Plan item(s) lack an active clause or valid explicit exemption: ${uncoveredPlanItemIds.join(', ')}.`,
        'Add at least one active behavioral clause per item, or an explicit non-automated exemption with justification and provenance.',
      )
    : runtimeBarMismatches.length
      ? fail(
          'Runtime BAR projection(s) are assigned to explicitly non-code prerequisite item(s) even though dependent implementation item(s) carry the same BAR: ' +
            runtimeBarMismatches.map((entry) =>
              `${entry.projectionSpecId} on ${entry.prerequisiteItemId} -> ${entry.dependentImplementationItemIds.join(', ')}`,
            ).join('; ') +
            '.',
          'Move runtime BAR mappings off non-code prerequisites and onto the dependent implementation item(s), then regenerate the exact spec-quality card. Keep the canonical shipment BAR contract unchanged.',
        )
      : exemptProjectionMismatches.length
        ? fail(
            'Active sourceBar-pinned projection(s) are assigned to explicitly non-behavioral exempt item(s): ' +
              exemptProjectionMismatches.map((entry) => `${entry.projectionSpecId} on ${entry.exemptItemId}`).join('; ') +
              '.',
            'Remove the sourceBar projection from the exempt item or replace its exemption with an active behavioral contract, then regenerate the exact spec-quality card.',
          )
      : barPinMismatches.length || duplicateBehaviorReuse.length || unpinnedAutoBarIds.length
      ? unknown(
        'Potential contract coverage issue: ' +
            [
              ...barPinMismatches,
              ...(unpinnedAutoBarIds.length
                ? ['AUTO-BAR specs lack a trusted source BAR pin: ' + unpinnedAutoBarIds.join(', ')]
                : []),
              ...duplicateBehaviorReuse,
            ].join('; ') +
            '. Review whether these clauses represent independent item contracts.',
        )
      : pass(`All ${planItemIds.length} plan item(s) are covered by active item clauses or explicit exemptions.${projectionEvidence}`);

  const atomicityEvaluation = behavioral.map((clause) => {
    let diagnostic: SpecQualityAtomicityClauseDiagnostic;
    if (isProjectedBar(clause)) {
      diagnostic = {
        specId: clause.specId,
        planItemId: clause.planItemId,
        behavior: clause.behavior,
        disposition: 'excluded',
        rating: 'not-applicable',
        reason: 'sourceBar-pinned BAR projection is not an independent item behavior clause.',
      };
    } else {
      const reason = specBehaviorNonAtomicReason(clause.behavior);
      diagnostic = reason === null
        ? {
            specId: clause.specId,
            planItemId: clause.planItemId,
            behavior: clause.behavior,
            disposition: 'evaluated',
            rating: 'pass',
            reason: null,
          }
        : {
            specId: clause.specId,
            planItemId: clause.planItemId,
            behavior: clause.behavior,
            disposition: 'evaluated',
            rating: 'fail',
            reason,
          };
    }
    return { clause, diagnostic };
  });
  const draftSourceBarProjections = draftClauses.filter((clause) => isProjectedBar(clause));
  const draftProjectionDiagnostics: SpecQualityAtomicityClauseDiagnostic[] = draftSourceBarProjections.map((clause) => ({
    specId: clause.specId,
    planItemId: clause.planItemId,
    behavior: clause.behavior,
    disposition: 'excluded',
    rating: 'not-applicable',
    reason: 'draft sourceBar-pinned BAR projection is not an active item behavior clause.',
  }));
  const atomicityClauseDiagnostics = [
    ...atomicityEvaluation.map(({ diagnostic }) => diagnostic),
    ...draftProjectionDiagnostics,
  ];
  const atomicityFailures = atomicityEvaluation.flatMap(({ clause, diagnostic }) => {
    if (diagnostic.disposition !== 'evaluated' || diagnostic.rating !== 'fail') return [];
    return [{ clause, reason: diagnostic.reason }];
  });
  // State the evaluated population on the rating itself (WI-10006862): a grader reading
  // only the evidence must be able to tell which share of the active behavioral clauses the
  // verdict covers, and that sourceBar projections were excluded rather than judged atomic.
  const atomicityEvaluatedCount = atomicityEvaluation.filter(({ diagnostic }) => diagnostic.disposition === 'evaluated').length;
  const activeSourceBarExcludedCount = behavioral.filter((clause) => isProjectedBar(clause)).length;
  const draftSourceBarExcludedCount = draftSourceBarProjections.length;
  const atomicityCoverage =
    ` Coverage: ${atomicityEvaluatedCount} of ${behavioral.length} active behavioral clause(s) evaluated` +
    `; ${activeSourceBarExcludedCount} active sourceBar-pinned BAR projection(s) excluded (new or meaning-changed canonical BAR projections are checked on rubric writes; unchanged legacy BARs are not re-certified here)` +
    (draftSourceBarExcludedCount
      ? `; ${draftSourceBarExcludedCount} draft sourceBar-pinned projection(s) excluded from the active population`
      : '') +
    '; per-clause dispositions are in details.atomicityClauseDiagnostics.';
  // Exercise both sides of the predicate in the result itself. A no-hit census
  // alone cannot show that a broken detector would reject a compound contract.
  const atomicityDetectorControls = [
    { behavior: 'The price sheet reproduces measured costs, separates platform margin and specifies an allowance.', expected: 'compound' as const },
    { behavior: 'The customer journey satisfies the security and operating promises.', expected: 'compound' as const },
    { behavior: 'Each original parked-agent request has exactly one evidence-based disposition and never counts queued or delivered as pickup.', expected: 'compound' as const },
    { behavior: 'A current-build dogfood run completes the parked-agent audit through coord:roster view=audit without caller SQL and records complete coverage.', expected: 'compound' as const },
    { behavior: 'The price sheet reproduces the measured cost for each workload case.', expected: 'atomic' as const },
    { behavior: 'The customer journey stops when the inference allowance is exhausted.', expected: 'atomic' as const },
    { behavior: 'Each original parked-agent request has exactly one evidence-based disposition.', expected: 'atomic' as const },
    { behavior: 'A current-build dogfood run completes the parked-agent audit through coord:roster view=audit without caller SQL.', expected: 'atomic' as const },
  ].map((control) => {
    const actual = specBehaviorNonAtomicReason(control.behavior) === null ? 'atomic' as const : 'compound' as const;
    return { ...control, actual, passed: actual === control.expected };
  });
  const atomicityControlsPassed = atomicityDetectorControls.every((control) => control.passed);
  const compoundControls = atomicityDetectorControls.filter((control) => control.expected === 'compound');
  const singleOutcomeControls = atomicityDetectorControls.filter((control) => control.expected === 'atomic');
  const atomicityControlEvidence =
    ` Detector controls: ${compoundControls.filter((control) => control.passed).length}/${compoundControls.length} compound counterexamples rejected; ` +
    `${singleOutcomeControls.filter((control) => control.passed).length}/${singleOutcomeControls.length} single-outcome controls accepted; see details.atomicityDetectorControls.` +
    ' Coverage is structural pattern detection, not a proof of arbitrary natural-language semantics.';
  ratings['atomic-observable-behavior'] =
    behavioral.length === 0
      ? notApplicable(
          `0 active behavioral clause(s) are available for structural atomicity evaluation.${draftSourceBarExcludedCount ? ` ${draftSourceBarExcludedCount} draft sourceBar-pinned projection(s) are excluded from the active population.` : ''}` +
            (draftSourceBarExcludedCount ? ' Per-clause dispositions are in details.atomicityClauseDiagnostics.' : ''),
        )
      : itemBehavioral.length === 0
        ? notApplicable(`Only sourceBar-pinned projections are present; they are not independent item contracts.${atomicityCoverage}`)
      : !atomicityControlsPassed
        ? unknown(`The atomicity detector failed its counterexample/single-outcome controls; no atomicity pass is earned.${atomicityCoverage}`)
      : atomicityFailures.length
        ? fail(
            atomicityFailures.map(({ clause, reason }) => `${clause.specId}:${reason}`).join('; ') + '.' + atomicityCoverage,
            'Split compound outcomes into atomic clauses with one observable behavior each.',
          )
        : pass(`${itemBehavioral.length} independent item behavior clause(s) passed the supported structural atomicity checks.${projectionEvidence}${atomicityCoverage}${atomicityControlEvidence}`);

  const falsifiabilityFailures = itemBehavioral
    .map((clause) => ({ clause, reason: specBehaviorNonFalsifiableReason(clause.behavior) }))
    .filter((entry): entry is { clause: SpecClauseRevision; reason: string } => Boolean(entry.reason));
  ratings.falsifiability =
    behavioral.length === 0
      ? notApplicable('0 behavioral clause(s) are available for falsifiability evaluation.')
      : itemBehavioral.length === 0
        ? notApplicable('Only AUTO-BAR projections are present; they are not independent item contracts.')
      : falsifiabilityFailures.length
        ? fail(
            falsifiabilityFailures.map(({ clause, reason }) => `${clause.specId}:${reason}`).join('; '),
            'Rewrite vague or discretionary text as a concrete outcome that can be shown false.',
          )
        : pass(`${itemBehavioral.length} independent item behavior clause(s) state falsifiable outcomes.${projectionEvidence}`);

  const implementationIndependenceClauseDiagnostics: SpecQualityClauseDiagnostic[] = currentSet.map((clause) => {
    const identity = { specId: clause.specId, planItemId: clause.planItemId, behavior: clause.behavior };
    if (!CONTRACT_STATUSES.has(clause.lifecycleStatus)) {
      return { ...identity, disposition: 'excluded', rating: 'not-applicable',
        reason: `${clause.lifecycleStatus} clause is outside the active/accepted behavioral population.` };
    }
    const reason = clauseImplementationCouplingReason(clause);
    return reason
      ? { ...identity, disposition: 'evaluated', rating: 'fail', reason }
      : { ...identity, disposition: 'evaluated', rating: 'pass', reason: null };
  });
  const couplingFailures = implementationIndependenceClauseDiagnostics.filter(
    (entry) => entry.disposition === 'evaluated' && entry.rating === 'fail',
  );
  const implementationIndependenceDetectorControls = [
    { behavior: 'The customer job completes through the existing runtime.', expected: 'coupled' as const },
    { behavior: 'The existing cloud subscription flow implements the approved offer.', expected: 'coupled' as const },
    { behavior: 'A failure produces an alarm through the existing alarm subscription mechanism.', expected: 'coupled' as const },
    { behavior: 'FAQ content stays synchronized through the existing source-linked maintenance pipeline.', expected: 'coupled' as const },
    { behavior: 'Reuse the runtime usage ledger for per-call token counts.', expected: 'coupled' as const },
    { behavior: 'Reuse PostHog for consented portal events.', expected: 'coupled' as const },
    { behavior: 'Reuse prior clean receipts when current; reuse PostHog for consented portal events.', expected: 'coupled' as const },
    { behavior: 'The private field condition_key retains episode coalescing.', expected: 'coupled' as const },
    { behavior: 'runSyncBatchDeltaCheck evaluates the batch under sustained load.', expected: 'coupled' as const },
    { behavior: 'A clickable block has no clip in src/cup-audio/.', expected: 'coupled' as const },
    { behavior: 'Wording from tests/fixtures/cupboard-brief.json appears outside a label.', expected: 'coupled' as const },
    { behavior: 'The built out/*/index.html leaves a placeholder behind.', expected: 'coupled' as const },
    { behavior: 'Readers see correlation between `test/run/case`, invocation/workflow and trace/span.', expected: 'coupled' as const },
    { behavior: 'Readers see correlation between test/run/case, invocation/workflow and trace/span.', expected: 'independent' as const },
    { behavior: 'An existing customer sees their subscription after signing in.', expected: 'independent' as const },
    { behavior: 'GET /architecture/index.html returns 200 with the map.', expected: 'independent' as const },
    { behavior: 'A visitor who opts out/in keeps that choice after a reload.', expected: 'independent' as const },
    { behavior: 'The customer reuses an existing account when accepting an invitation.', expected: 'independent' as const },
    { behavior: 'Reuse of an expired invitation is refused.', expected: 'independent' as const },
    { behavior: 'Reuse prior clean receipts when current; do not recreate proof just for recovery.', expected: 'independent' as const },
  ].map((control) => {
    const actual = implementationCouplingReason(control.behavior) === null ? 'independent' as const : 'coupled' as const;
    return { ...control, actual, passed: actual === control.expected };
  });
  const implementationIndependenceControlsPassed = implementationIndependenceDetectorControls.every((control) => control.passed);
  const implementationIndependenceCoverage =
    ' Fields inspected per clause: behavior and falsifier.observation (falsifier.probeMethod is excluded because it legitimately names the test or probe).' +
    ' Detector coverage: implementation filenames, explicitly qualified/quoted construct symbols (including snake_case identifiers), bare lowerCamel identifiers (excluding recognized public platform/device names), repository paths, internal route literals, named operations, mandated reuse of existing surfaces (including runtimes, flows, pipelines, ledgers and mechanisms), imperative implementation selection, filesystem permission modes, named storage backends, encryption, and mirroring. Inspected ' +
    behavioral.length + ' active/accepted behavior clause(s), including ' +
    behavioral.filter(isProjectedBar).length + ' sourceBar-pinned acceptance BAR projection(s).' +
    ` ${currentSet.length - behavioral.length} draft/exempt clause(s) excluded; per-clause dispositions are in details.implementationIndependenceClauseDiagnostics.` +
    ' Detector controls: see details.implementationIndependenceDetectorControls for coupled counterexamples and independent observable outcomes.' +
    ' Coverage is structural pattern detection, not a proof of arbitrary natural-language semantics.';
  ratings['implementation-independence'] =
    behavioral.length === 0
      ? notApplicable('0 behavioral clause(s) are available for implementation-independence evaluation.')
      : !implementationIndependenceControlsPassed
        ? unknown('The implementation-independence detector failed its coupled/independent controls; no pass is earned.' + implementationIndependenceCoverage)
      : couplingFailures.length
        ? fail(
            couplingFailures.map(({ specId, reason }) => `${specId}:${reason}`).join('; ') + '.' + implementationIndependenceCoverage,
            'Describe externally observable behavior instead of filenames or internal constructs.',
          )
        : pass('No active/accepted behavior clause is coupled to an implementation detail covered by the detector.' + implementationIndependenceCoverage);

  ratings['explicit-non-behavioral-exemptions'] = invalidExemptionSpecIds.length
    ? fail(
        `${exemptionCensusEvidence} Invalid exemption(s): ${invalidExemptionSpecIds.join(', ')}.`,
        'Use lifecycleStatus=exempt, behaviorClass=non-automated, and non-empty justification + provenance.',
      )
    : exemptions.length
      ? pass(`${exemptionCensusEvidence} Every exemption carries explicit justification and provenance.`)
      : { rating: 'not-applicable', evidence: `${exemptionCensusEvidence} No clause claims a non-behavioral exemption.` };

  const classFit = planClassFit(input.classRef, itemBehavioral);
  const everyItemExplicitlyExempt =
    planItemIds.length > 0 &&
    planItemIds.every((itemId) => validExemptions.some((clause) => clause.planItemId === itemId));
  // Old internal writers could bypass plans:set-specs validation. A class-fit
  // pass cannot endorse an active proof obligation the recorder cannot satisfy.
  // Draft history is preserved and is not an enforceable runtime requirement.
  const invalidLayerDeclarations = behavioral.flatMap((clause) => {
    const invalid = clause.requiredTestLayers.filter((layer) => !isRecordedTestLayer(layer));
    return invalid.length ? [`${clause.specId}@${clause.revision}:${JSON.stringify(invalid)}`] : [];
  });
  ratings['plan-class-specialization'] =
    invalidLayerDeclarations.length > 0
      ? fail(
          `Active clause(s) declare unrecordable required test layers: ${invalidLayerDeclarations.join('; ')}. Recorded layers: ${RECORDED_TEST_LAYERS.join(', ')}.`,
          'Append explicit revisions with recorded layers; preserve every original behavior, scenario and evidence obligation instead of silently dropping or mapping legacy labels.',
        )
      : classFit.ok || (planClassAllowsAllExemptItems(input.classRef) && everyItemExplicitlyExempt)
      ? pass(
          classFit.ok
            ? classFit.evidence
            : `Every ${input.classRef === 'plan-class-general' ? 'general' : 'investigation'} plan item is explicitly non-behavioral and exempt with provenance.`,
        )
      : fail(
          classFit.evidence,
          `Evaluate against the correct class (${PLAN_CLASS_RUBRIC_REFS.join(', ')}) or add its required behavior class.`,
        );

  ratings['spec-set-freshness'] =
    input.expectedSpecSetHash && input.expectedSpecSetHash !== specSetHash
      ? unknown(
          'Expected specSetHash ' +
            input.expectedSpecSetHash +
            ', but the current clauses hash to ' +
            specSetHash +
            '; the replayed probe describes a different clause set.',
        )
      : pass(
          'Verdict is pinned to exact current specSetHash ' +
            specSetHash +
            ' over ' +
            currentSet.length +
            ' clause(s).',
        );

  // The start gate pins the exact ratings fingerprint, so the evaluator itself
  // must emit evidence that a non-author can execute verbatim. Otherwise a
  // grading-integrity repair changes the fingerprint and can never satisfy both
  // gates. Keep the raw finding, but prefix its source store, full probe args,
  // and exact result field for every criterion.
  for (const criterion of SPEC_QUALITY_CRITERIA) {
    const entry = ratings[criterion];
    ratings[criterion] = {
      ...entry,
      evidence: rerunnableEvidence(input, criterion, entry.evidence, specSetHash),
    };
  }

  const wouldBlock = SPEC_QUALITY_CRITERIA.filter((key) => ['fail', 'unknown'].includes(ratings[key].rating));
  const verdict = wouldBlock.some((key) => ratings[key].rating === 'fail')
    ? 'fail'
    : wouldBlock.length
      ? 'unknown'
      : 'pass';
  const subjectRef = specQualitySubjectRef(input.planSlug, input.classRef, specSetHash);
  const draftSpecIds = currentSet.filter((clause) => clause.lifecycleStatus === 'draft').map((clause) => clause.specId);
  return {
    planSlug: input.planSlug,
    classRef: input.classRef,
    specSetHash,
    clauseCount: currentSet.length,
    planItemCount: planItemIds.length,
    ratings,
    verdict,
    wouldBlock,
    details: {
      uncoveredPlanItemIds,
      invalidExemptionSpecIds,
      exemptionCensus,
      draftSpecIds,
      atomicityClauseDiagnostics,
      atomicityDetectorControls,
      implementationIndependenceClauseDiagnostics,
      implementationIndependenceDetectorControls,
      exemptSourceBarProjectionMismatches: exemptProjectionMismatches,
      prerequisiteRuntimeBarMismatches: runtimeBarMismatches,
    },
    scorecardDraft: {
      rubricRef: SPEC_QUALITY_RUBRIC_REF,
      subject: { kind: 'plan', ref: subjectRef },
      title: `${input.planSlug} spec quality (${input.classRef})`,
      body: `Plan ${input.planSlug}; class ${input.classRef}; exact current specSetHash ${specSetHash}; ${currentSet.length} current clause(s), ${planItemIds.length} plan item(s).`,
      ratings,
      terminal: true,
    },
  };
}
