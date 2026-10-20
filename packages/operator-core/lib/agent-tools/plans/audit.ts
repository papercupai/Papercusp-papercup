/**
 * plans:audit — record either a completion/code-truth audit or the
 * conversation-completeness audit required before activation.
 *
 * The implementer traces every plan item to the code that implements it and CITES it,
 * before authoring the acceptance rubric (plan D-004). Citations of kind `code`/`test`
 * are resolved against the real tree HERE, at write time, so a fabricated path fails
 * immediately rather than at ship time — and a stored audit is therefore always
 * self-consistent. The completion gate re-resolves them again later, because the tree
 * moves between audit and ship.
 *
 * WHY VALIDATION IS COLLECTED, NOT SHORT-CIRCUITED: an audit of a 20-item plan is one
 * expensive pass of agent attention. Failing on the first bad citation would send the
 * agent round the loop once per problem. Every problem is collected and returned
 * together, so one fix-up pass clears them all.
 *
 * NOT BULK: the house contract is bulk-by-default, but an audit is inherently one
 * plan's worth of work and its payload is large. Auditing two plans in one call has no
 * real caller, so the single-plan shape is the honest one.
 */
import { z } from 'zod';
import { refineEvenWithShapeIssues } from '../_refine-with-shape-issues';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { isNonCodeAuditVerdict, resolveVerification } from '../../plan-verification-profile';
import { isGenericCitationKind, resolveGenericCitation } from '../../plan-audits-generic-citations';
import { execFileSync } from 'node:child_process';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx, resolveHarnessScope } from '../_harness-scope';
import { resolveAgentIdentity } from '../coordination/identity';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import {
  AUDIT_VERDICTS,
  ACTIVATION_REAUDIT_COSMETIC_CHANGES,
  ACTIVATION_REAUDIT_MATERIAL_CHANGES,
  CITATION_KINDS,
  citationBlobSha,
  citationBlobShaAt,
  CitationGitReadError,
  entryHasVerifyingCitation,
  getEffectiveItemAudits,
  loadGenericCitationLookupForWorkspace,
  getLatestActivationAudit,
  getPlanItemStatuses,
  isRepoFileCitation,
  isVerifyingCitation,
  isCitationContextFailure,
  mergeActivationAuditCoverage,
  prepareAuditPassEntries,
  recordCurrentActivationAudit,
  previewCurrentActivationAudit,
  recordPlanAudit,
  repoCitationContextForHarness,
  resolveCitation,
  resolvePlanItemHomeHarness,
  summarizeCoverage,
  deadActivationAuditTargets,
  describeActivationAuditPlanTargetProblems,
  validateActivationAuditPlanTargets,
  type AuditCitation,
  type AuditItemEntry,
  type ActivationAuditPayload,
} from '../../plan-audits';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  parseSessionSelector,
  parseTurnRef,
  resolveSessionTurnRefs,
  SESSION_SOURCE_KINDS,
} from '../sessions/_shared';
import { ensureActivationAuditRepairFiling } from './activation-audit-repair';
import {
  currentPlanItemIds,
  dbRefOriginLookup,
  evaluateActivationItemProvenance,
  fetchOrderSourceTurns,
  itemProvenanceMissingProblems,
  parseOrderSourceRef,
  type TurnSql,
} from '../../activation-item-provenance';
import { persistDerivedDraftClauses } from '../../derive-draft-spec-clauses';
import { detectUnderReadFromSource } from '../../activation-under-read';
import { restrictedTurnSql } from '../../personal-vault/transcript-exclusion';
import { assertSourceSpan } from '../../activation-source-span';
import { setSpecClause } from './spec-clauses-store';
import { getPlanRow } from './source';
import {
  MAX_BAR_PROJECTION_EDGES,
  acceptanceBarProjectionConflictDetail,
  unexpectedAcceptanceBarProjectionIds,
  validateAcceptanceBarSource,
} from '../../acceptance-bar-seed';
import { parsePlan } from './parser';
import { stagingFirstActivationProblems } from './staging-first-activation-guard';
import { conformanceActivationVerdict } from '../../spec-conformance/activation-gate';
import { PLAN_CLASS_RUBRIC_REFS } from './spec-test-adequacy';
import { resolveActivationClassRef } from './activation-class-ref';
import { previewPlanStartConsult } from './get-activation-readiness';
import { previewProductShaping } from './product-shaping';
import {
  checkLibraryDeclarations,
  evaluateActivationDeclarations,
  previewPlanDeclarations,
  resolveReuseReferences,
  type LibraryCheckReport,
  type ReuseReferenceReport,
} from './plan-declarations';
import {
  captureDependencyBaseline,
  defaultLibraryCheckDeps,
  defaultReuseReferenceResolvers,
  readPlanCompletionFilesChanged,
  readWorkspacePackageNames,
} from './plan-declaration-resolvers';
import { dependencyBaselineFrom, runLibraryShipCheck } from './plan-library-ship-check';
import { recoverHarnessFromSlugs, slugScopeErrorResult } from './slug-scope';
import { proposeAuditCitations } from './audit-derived-citations';

const citationPathSchema = z.string().min(1).describe(
  'Repo-relative path. No leading `/` or `~`, no `..` segments — a citation that needs one is not evidence.',
);
const citationOptionalFields = {
  line: z.number().int().positive().optional().describe('Optional line number; must exist in the cited file.'),
  symbol: z.string().min(1).optional().describe('Optional symbol that must literally appear in the cited file.'),
  ref: z.string().min(1).optional().describe('PG-canonical doc id for a `doc` citation; requires `reason`.'),
  reason: z.string().min(1).optional().describe('REQUIRED for kind `none`, and for a `doc` cited by `ref` alone: why this item has no code-resolvable artifact.'),
};
const citationSchema = z.union([
  z.object({
    kind: z.literal('code'),
    path: citationPathSchema,
    ...citationOptionalFields,
  }),
  z.object({
    kind: z.literal('test'),
    path: citationPathSchema,
    ...citationOptionalFields,
  }),
  z.object({
    kind: z.literal('doc').describe(
      '`doc` records where a non-source deliverable lives: give `path` if it is a tree file (resolved like any other path) or `ref` + `reason` if it is a PG-canonical doc — either way it never supports `implemented`.',
    ),
    path: citationPathSchema.optional(),
    ...citationOptionalFields,
  }),
  z.object({
    kind: z.literal('none').describe(
      '`none` is the escape hatch and REQUIRES `reason`. The unverified counts come back in the result and go in front of the independent grader, because a self-audit cannot police its own use of them.',
    ),
    path: citationPathSchema.optional(),
    ...citationOptionalFields,
  }),
  // P-003 (R-7): platform-held evidence. Verifies a non-code deliverable only; the server
  // stamps the target's content hash, so any wire `contentHash` is stripped.
  z.object({
    kind: z.enum(['artifact', 'work-item', 'measurement']).describe(
      'Non-code evidence; verifies only a non-code deliverable. `ref`: rpt_… / plan:<slug> / doc:<id> | a done WI-/EI-/F- | test-run:<id> (pass).',
    ),
    ref: z.string().min(1),
    reason: citationOptionalFields.reason,
  }),
  z.object({
    kind: z.literal('external'),
    url: z.string().url(),
    snapshotHash: z.string().regex(/^[0-9a-fA-F]{64}$/).describe('sha256 hex of the snapshot you captured.'),
    reason: citationOptionalFields.reason,
  }),
]);

const itemSchema = z.object({
  itemId: z.string().regex(/^P-\d{3,}$/).describe('The plan item this entry audits.'),
  verdict: z.enum(AUDIT_VERDICTS).describe(
    'implemented (you READ the code that implements it — REQUIRES a resolving `code`/`test` citation; a `doc` citation cannot support this verdict) | not-code (a decision/doc/investigation — REQUIRES `note`, and is counted, because it exempts the item from code verification) | partial | missing | dropped (intentionally departed from — REQUIRES `note`). Per plan D-002 no verdict refuses a ship on its own; they RECORD. The ship-blocking question is the item\'s own status.',
  ),
  citations: z.array(citationSchema).max(20).optional(),
  note: z.string().min(1).max(2000).optional().describe('REQUIRED for `dropped`: explain the intentional departure (D-002). REQUIRED for `not-code`: name the deliverable and why it has no code implementation.'),
});

const findingSchema = z.object({
  summary: z.string().min(1).max(1000),
  severity: z.string().min(1).max(40).optional(),
  disposition: z.enum(['fixed', 'filed']).describe('`fixed` — you fixed it in this pass. `filed` — it is out of scope and REQUIRES `ref`, the work-item it now lives on.'),
  ref: z.string().min(1).optional(),
});

const sourceRangeSchema = z.object({
  sourceKind: z.enum(SESSION_SOURCE_KINDS),
  sessionId: z.string().min(1).max(300),
  fromTurn: z.number().int().min(0),
  toTurn: z.number().int().min(0),
}).refine((range) => range.fromTurn <= range.toTurn, {
  message: 'fromTurn must be <= toTurn',
  path: ['toTurn'],
});

const activationMappingSchema = z.object({
  id: z.string().regex(/^M-\d{3,}$/),
  sourceRefs: z.array(z.string().min(1).max(500)).min(1).max(100),
  requirement: z.string().min(1).max(4000),
  planTargets: z.array(z.string().min(1).max(500)).min(1).max(100).describe(
    'Plan destinations: use R-N for exact acceptance-bar records in Requirements, P-NNN for plan items, D-NNN for decisions, or section:<heading> for exact plan sections; the section: prefix is required.',
  ),
  disposition: z.enum(['covered', 'repaired', 'rejected', 'open']),
}).superRefine((mapping, ctx) => {
  if (new Set(mapping.sourceRefs).size !== mapping.sourceRefs.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceRefs'], message: 'sourceRefs must be unique within a mapping' });
  }
  if (new Set(mapping.planTargets).size !== mapping.planTargets.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['planTargets'], message: 'planTargets must be unique within a mapping' });
  }
});

// plan-item-provenance-2026-09-29 P-002: the REVERSE direction of the audit. Every
// current item must trace to an owner turn; items that do not are declared here.
const itemIdSchema = z.string().regex(/^P-\d{3,}$/);
const itemProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({
    itemId: itemIdSchema,
    kind: z.literal('derived'),
    from: z.array(z.string().min(1).max(500)).min(1).max(50).describe('Owner-backed P-NNN/D-NNN/R-N/section:<heading> targets.'),
    note: z.string().min(1).max(2000).optional(),
  }),
  z.object({
    itemId: itemIdSchema,
    kind: z.literal('agent-added'),
    reason: z.string().min(1).max(2000).describe('Why the agent added it; shown to the owner.'),
  }),
]).meta({
  // The compact discovery projection merges array-item union fields. Preserve
  // this branch contract beside the schema so callers cannot combine fields
  // from the `derived` and `agent-added` variants.
  'x-papercusp-call-constraint':
    'when kind=derived => from required; when kind!=derived => from forbidden; when kind=agent-added => note forbidden; when kind=agent-added => reason required; when kind!=agent-added => reason forbidden',
});

// RSR-P-008-A: the activation rules are reported alongside any shape defect.
const argsSchema = refineEvenWithShapeIssues(z.object({
  slug: z.string().min(1).describe('The plan being audited.'),
  harness: harnessArg,
  phase: z.enum(['completion', 'activation', 'shaping']).default('completion').describe(
    '`shaping` previews the product brief/scenario gaps and original-intent reviewer context without writes. `completion` (default) audits implemented code. `activation` records the source-conversation audit.',
  ),
  dryRun: z.boolean().default(false).describe(
    'Validate and preview the audit without recording an audit row, repair filing, derived spec clause, or plan event.',
  ),
  proposeCitations: z.boolean().optional().describe('Completion only: read-only proposals for done items from edit/commit attribution, with measured blob SHAs; records no audit.'),
  classRef: z.enum(PLAN_CLASS_RUBRIC_REFS).optional().describe(
    'Activation: the plans:evaluate-spec-quality class; derived when omitted; must match the acceptance class. Ignored at completion.',
  ),
  items: z.array(itemSchema).min(1).max(200).optional().describe('Completion phase only: one entry per plan item audited.'),
  findings: z.array(findingSchema).max(50).optional().describe('Completion phase only: out-of-scope discoveries.'),
  auditedSha: z.string().min(7).max(64).optional().describe('Completion phase only: commit audited against; resolved from the local tree when omitted.'),
  sourceRanges: z.array(sourceRangeSchema).max(50).optional().describe(
    'Activation phase: bounded source conversations covered by this pass. Required and nonempty for the first audit; omitted or empty on a re-audit carries prior ranges forward.',
  ),
  mappings: z.array(activationMappingSchema).max(300).optional().describe(
    'Activation phase: every requirement/constraint/decision mapped from canonical session_turn refs to current R-N acceptance bars, P-NNN items, D-NNN decisions, or section:<heading> targets. Required and nonempty for the first audit; omitted or empty on a re-audit carries prior mappings forward.',
  ),
  itemProvenance: z.array(itemProvenanceSchema).max(200).optional().describe(
    'Activation: items no owner-turn mapping backs, as `derived` or `agent-added`. Carried across re-audits.',
  ),
  repairedOmissions: z.array(z.string().min(1).max(2000)).max(100).optional(),
  rejectedOrSuperseded: z.array(z.string().min(1).max(2000)).max(100).optional(),
  unresolvedBlockers: z.array(z.string().min(1).max(2000)).max(100).optional().describe(
    'Activation phase: blockers that are still unresolved. Any nonempty array blocks activation and means nothing is recorded; do not use it for a resolved or conditional live-environment limitation. Put resolved limitations in a covered mapping and explain the condition in summary.',
  ),
  summary: z.string().max(4000).optional().describe(
    'Optional audit context. For activation, use this to explain resolved conditional/live-environment limitations after mapping them to the plan; it does not make unresolvedBlockers acceptable.',
  ),
}), (args, ctx) => {
  if (args.phase === 'activation') {
    // Whether coverage is required depends on whether this is the first audit.
    // The prior-audit lookup is async and belongs in the handler, so the input
    // schema must admit omitted/empty arrays for carry-forward re-audits. An omitted
    // classRef is derived in the handler from the latest spec-quality evaluation (P-003).
    if (args.mappings && new Set(args.mappings.map((mapping) => mapping.id)).size !== args.mappings.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mappings'], message: 'mapping ids must be unique within an activation audit' });
    }
    for (const field of ['items', 'findings', 'auditedSha', 'proposeCitations'] as const) {
      if (args[field] !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is completion-phase only` });
      }
    }
  } else if (args.phase === 'shaping') {
    for (const field of ['items', 'findings', 'auditedSha', 'sourceRanges', 'mappings', 'itemProvenance', 'repairedOmissions', 'rejectedOrSuperseded', 'unresolvedBlockers', 'classRef', 'proposeCitations'] as const) {
      if (args[field] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is not used by the read-only shaping preview` });
    }
  } else {
    if (!args.items && !args.proposeCitations) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'items is required for phase:completion' });
    }
    // classRef is accepted and ignored here (with a result note) rather than refused (P-003).
    for (const field of ['sourceRanges', 'mappings', 'itemProvenance', 'repairedOmissions', 'rejectedOrSuperseded', 'unresolvedBlockers'] as const) {
      if (args[field] !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is activation-phase only` });
      }
    }
  }
}).meta({
  'x-papercusp-call-constraint':
    'phase=shaping => read-only preview; audit payload fields forbidden. phase=activation => classRef derived if omitted; items, findings, auditedSha, proposeCitations forbidden. phase=completion (including omitted phase) => items required unless proposeCitations=true (read-only); classRef ignored; sourceRanges, mappings, itemProvenance, repairedOmissions, rejectedOrSuperseded, unresolvedBlockers forbidden.',
});

interface Problem {
  itemId?: string;
  code: string;
  detail: string;
}

/**
 * Fresh items in one pass must agree on the blob provenance for a cited path.
 * Carried-forward items intentionally retain the blob provenance from the pass
 * that inspected them, so they are not comparable with this pass's fresh
 * snapshot and must be excluded from this consistency check.
 */
function divergentCitationBlobShaProblems(entries: AuditItemEntry[]): Problem[] {
  const byPath = new Map<string, Map<string, Set<string>>>();

  for (const entry of entries) {
    if (entry.carriedFrom !== undefined) continue;
    for (const citation of entry.citations) {
      if (!isRepoFileCitation(citation) || !citation.path || !citation.blobSha) continue;
      const path = citation.path.trim();
      if (!path) continue;
      const bySha = byPath.get(path) ?? new Map<string, Set<string>>();
      const itemIds = bySha.get(citation.blobSha) ?? new Set<string>();
      itemIds.add(entry.itemId);
      bySha.set(citation.blobSha, itemIds);
      byPath.set(path, bySha);
    }
  }

  return [...byPath.entries()]
    .filter(([, bySha]) => bySha.size > 1)
    .map(([path, bySha]) => ({
      code: 'citation_blob_sha_conflict',
      detail:
        `citation path '${path}' has divergent blobSha values in this audit pass: ` +
        `${[...bySha.entries()]
          .map(([blobSha, itemIds]) => `${blobSha} (${[...itemIds].join(', ')})`)
          .join('; ')}. Re-audit every listed item against one tree snapshot; nothing was recorded.`,
    }));
}

/** Best-effort local HEAD. An audit whose sha cannot be resolved is still a real
 *  audit, so this never throws — the column is nullable for exactly this case. */
function resolveHeadSha(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim() || null;
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'plans:audit',
  description:
    "Activation: any nonempty `unresolvedBlockers` list refuses the audit and records nothing. Shaping previews product intent/scenario gaps without writes; completion checks actual code. BAR seeding needs requirement JSON and a Design map.",
  guidance: {
    when: "Before activation read the COMPLETE source conversation; map every requirement, boundary, constraint, correction, rejection, decision, dependency, sequence, acceptance condition, open question, follow-up. ## Requirements: **R-N — Title.** outcome; use a fenced `requirement` JSON block for METHOD/check/layers. Design needs a BAR-to-work map; ordinary bullet lists do not satisfy the BAR parser. Shape brief/scenarios/assumptions before specs; completion cites actual code.",
    returns:
      "Shaping: {productShaping}, advisory gaps/trace/reviewerBrief, not semantic proof. Activation: {auditSeq, auditedPlanRevision, mappings, sourceRefsResolved, itemProvenance, barSeed, activationReadiness}; provenance gaps refuse. Completion: {auditSeq, coverage, uncoveredItems, partial, problems, rejectedItemIds}; proposeCitations:true returns {proposals, unresolved, truncatedByLimit} without recording an audit.",
    notWhen: "Rubrics: scorecards:emit. Decisions: plans:add-decision.",
    chaining:
      `shaping → plans:set-content → independent review → activation → start. Edits preserve audited/current revision id/seq/contentHash; re-audit after ${ACTIVATION_REAUDIT_MATERIAL_CHANGES.join(', ')}; not ${ACTIVATION_REAUDIT_COSMETIC_CHANGES.join(', ')}. completion → rubric/scorecard → shipped.`,
    seeAlso: [
      'plans:set-status (drop an item you intentionally departed from, with a reason)',
      'plans:set-plan-status (the completion gate that reads this audit)',
    ],
  },
  capability: 'plans:write',
  skipWorkspaceTx: true,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  // Activation and completion are two envelopes from one audited write path.
  // Publish their shared load-bearing fields plus the completion diagnostics;
  // passthrough preserves the phase-specific additions without making prose a
  // second source of response types.
  result: z
    .object({
      ok: z.boolean().optional(),
      phase: z.enum(['activation', 'completion', 'shaping']).optional(),
      productShaping: z.unknown().optional(),
      dryRun: z.boolean().optional(),
      preview: z.boolean().optional(),
      proposals: z.unknown().optional(),
      unresolved: z.unknown().optional(),
      truncatedByLimit: z.boolean().optional(),
      auditSeq: z.number().int().nonnegative().optional(),
      auditedPlanRevision: z.unknown().optional(),
      mappings: z.unknown().optional(),
      // `returns` promises barSeed on the activation envelope (the active rubric
      // revision, barSetHash, BAR count, projection-edge count). Declare it here so
      // that promise is backed by the registered schema rather than by prose —
      // guidance-output-schema-live-guard fails a promised-but-undeclared field.
      barSeed: z.unknown().optional(),
      barSeedPendingAmendment: z.unknown().optional(),
      barSeedPendingRepair: z.unknown().optional(),
      activationReadiness: z.object({ consult: z.unknown() }).optional(),
      // P-003: which class seeded the BARs, and whether the caller supplied it or it was
      // derived from the plan's latest plans:evaluate-spec-quality card.
      classRefResolution: z.object({
        classRef: z.enum(PLAN_CLASS_RUBRIC_REFS),
        source: z.enum(['supplied', 'derived']),
        evaluationScorecardId: z.string().optional(),
      }).optional(),
      // WI-10008137: outcome of the plans:start run that follows a recorded
      // activation audit on a draft plan (started, or plans:start's refusal).
      autoStart: z.unknown().optional(),
      // Activation's owner-provenance check (itemProvenanceResult below); null
      // when no current plan was read. `returns` names this nested shape.
      itemProvenance: z
        .object({ enforced: z.boolean(), counts: z.unknown(), unresolved: z.array(z.string()) })
        .passthrough()
        .nullable()
        .optional(),
      sourceRefsResolved: z.number().int().nonnegative().optional(),
      slug: z.string().optional(),
      itemsAuditedThisPass: z.number().int().nonnegative().optional(),
      itemsCarriedForward: z.number().int().nonnegative().optional(),
      coverage: z.unknown().optional(),
      uncoveredItems: z.array(z.string()).optional(),
      partial: z.boolean().optional(),
      problems: z.array(z.unknown()).optional(),
      rejectedItemIds: z.array(z.string()).optional(),
      error: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    // EI-22078133656298536: an audit already names an exact plan slug, so a
    // workspace-scoped operator call can recover its owning harness from the
    // canonical plan index instead of failing with an undiscoverable
    // `harness_required`. A slug present in >1 harness refuses (P-006: the
    // decider itself refuses ambiguity, for reads and writes alike).
    const scope = resolveHarnessScope(args.harness, ctx);
    let sctx: typeof ctx & { harnessSlug: string };
    if (scope.kind === 'none') {
      const decision = await recoverHarnessFromSlugs(ctx, [args.slug]);
      if (decision.status !== 'resolved') return slugScopeErrorResult('plans:audit', decision);
      sctx = { ...ctx, harnessSlug: decision.harnessSlug };
      (ctx as { metadata?: (d: Record<string, unknown>) => void }).metadata?.({
        harnessAutoResolved: decision.bySlug,
      });
    } else {
      sctx = harnessScopedCtx(args.harness, ctx);
    }
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const dryRun = args.dryRun === true;

    if (args.phase === 'shaping') {
      const plan = await getPlanRow(args.slug, { harnessSlug });
      if (!plan) return { data: { ok: false, slug: args.slug, phase: 'shaping', error: 'plan_not_found' } };
      return { data: { ok: true, slug: args.slug, phase: 'shaping', dryRun: true, preview: true,
        productShaping: previewProductShaping(plan.content),
        planDeclarations: previewPlanDeclarations(plan.content) } };
    }

    if (args.phase === 'activation') {
      const workspaceId = sctx.workspaceId ?? activeWorkspaceId();
      const classResolution = await resolveActivationClassRef({
        planSlug: args.slug, harnessSlug: harnessSlug ?? '', suppliedClassRef: args.classRef,
      });
      if (!classResolution.ok) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          error: 'activation_audit_invalid',
          problems: [{
            code: classResolution.code,
            detail: classResolution.detail,
          }],
          message: 'Activation audits require the exact evaluated PlanClassRubricRef so the acceptance BAR seed preserves plan-class provenance.',
        } };
      }
      const activationClassRef = classResolution.classRef;
      const submittedActivation: ActivationAuditPayload = {
        sourceRanges: (args.sourceRanges ?? []).map((range) => {
          // `sessions:list` exposes both the raw session id and the convenient
          // `<sourceKind>:<sessionId>` selector. Store the canonical id so a
          // selector range covers the public `session_turn:` refs it names and
          // re-audits do not accumulate equivalent raw/prefixed ranges.
          const selector = parseSessionSelector(range.sessionId);
          return {
            ...range,
            sessionId:
              selector.sourceKind === undefined || selector.sourceKind === range.sourceKind
                ? selector.sessionId
                : range.sessionId,
          };
        }),
        mappings: args.mappings ?? [],
        repairedOmissions: args.repairedOmissions ?? [],
        rejectedOrSuperseded: args.rejectedOrSuperseded ?? [],
        unresolvedBlockers: args.unresolvedBlockers ?? [],
        ...(args.itemProvenance?.length ? { itemProvenance: args.itemProvenance } : {}),
      };

      if (
        submittedActivation.unresolvedBlockers.length > 0 ||
        submittedActivation.mappings.some((mapping) => mapping.disposition === 'open')
      ) {
        const repairFiling = dryRun
          ? null
          : await ensureActivationAuditRepairFiling({
              workspaceId,
              harnessSlug: harnessSlug ?? '',
              planSlug: args.slug,
              activation: submittedActivation,
            });
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          ...(dryRun ? { dryRun: true as const, preview: true as const } : {}),
          error: 'activation_blocked',
          message:
            'Activation audit has unresolved blockers or open mappings. Any nonempty unresolvedBlockers list blocks and records nothing; repair/map them before ready/active. Put resolved conditional limitations in covered mappings/summary.',
          unresolvedBlockers: submittedActivation.unresolvedBlockers,
          openMappingIds: submittedActivation.mappings
            .filter((mapping) => mapping.disposition === 'open')
            .map((mapping) => mapping.id),
          ...(repairFiling ? { repairWorkItem: repairFiling.id, repairFiling } : {}),
        } };
      }

      const previousAudit = await getLatestActivationAudit(args.slug, { workspaceId });
      if (!previousAudit) {
        const missingCoverage: Problem[] = [];
        if (submittedActivation.sourceRanges.length === 0) {
          missingCoverage.push({
            code: 'source_ranges_required',
            detail: 'sourceRanges must contain at least one conversation range on the first activation audit',
          });
        }
        if (submittedActivation.mappings.length === 0) {
          missingCoverage.push({
            code: 'mappings_required',
            detail: 'mappings must contain at least one requirement mapping on the first activation audit',
          });
        }
        if (missingCoverage.length > 0) {
          return { data: {
            ok: false as const,
            slug: args.slug,
            phase: 'activation' as const,
            error: 'activation_audit_invalid',
            problems: missingCoverage,
            message: 'The first activation audit requires nonempty sourceRanges and mappings; nothing was recorded.',
          } };
        }
      }
      const currentPlan = await getPlanRow(args.slug, {
        workspaceId,
        harnessSlug: harnessSlug ?? '',
      });
      // A prior target whose destination the current plan no longer contains (an R-N removed
      // by a rubric amendment, a deleted item/decision/section) is dead: it may be retired,
      // because keeping it could never pass the plan-target validation below. A malformed
      // target is not "dead" — it never named a destination, so it stays a conflict; nor is
      // an R-N this build cannot parse (deadActivationAuditTargets, WI-6554700010015337).
      const deadTargets = previousAudit?.activation && currentPlan
        ? deadActivationAuditTargets(
          validateActivationAuditPlanTargets(previousAudit.activation, currentPlan.content),
        )
        : [];
      const merged = mergeActivationAuditCoverage(previousAudit?.activation, submittedActivation, {
        deadTargets,
        // WI-10006324: retire carried provenance for items the plan has since dropped.
        ...(currentPlan ? { liveItemIds: currentPlanItemIds(currentPlan.content) } : {}),
      });
      if (!merged.ok) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          error: 'activation_coverage_regression' as const,
          previousAuditSeq: previousAudit?.auditSeq ?? null,
          conflicts: merged.conflicts,
          message:
            'This re-audit would replace or shrink prior source-conversation coverage. ' +
            'Keep existing M-NNN ids stable and additive; allocate new ids for new requirements. Nothing was recorded.',
        } };
      }
      const activation = merged.activation;
      const sourceRanges = activation.sourceRanges;
      const mappings = activation.mappings;

      if (dryRun && !currentPlan) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          dryRun: true as const,
          preview: true as const,
          error: 'plan_not_found',
          message: `Plan '${args.slug}' could not be read for a side-effect-free activation preview.`,
        } };
      }
      if (currentPlan) {
        const stagingProblems = stagingFirstActivationProblems(
          parsePlan(currentPlan.content, { filePath: `${args.slug}.md` }),
        );
        if (stagingProblems.length > 0) {
          return { data: {
            ok: false as const,
            slug: args.slug,
            phase: 'activation' as const,
            error: 'staging_first_guard_failed' as const,
            problems: stagingProblems,
            message:
              `${stagingProblems.length} non-final item(s) gate implementation on the release plane. ` +
              'Rewrite them for staging/current-build acceptance or add the narrow deployed-only exception described per item; nothing was recorded.',
          } };
        }
      }
      // spec-conformance-loop-2026-10-14 R-1: every requirement compiles to an
      // executable check (done-when, falsifier, or approved unenforced declaration).
      // Evaluated LAST, just before success/record, so every more specific
      // diagnostic (source refs, provenance, BAR seed) is reported first.
      const conformanceRefusal = (preview: boolean) => {
        if (!currentPlan) return null;
        const conformance = conformanceActivationVerdict(currentPlan.content);
        if (conformance.ok) return null;
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          ...(preview ? { dryRun: true as const, preview: true as const } : {}),
          error: conformance.error,
          problems: conformance.problems,
          message: conformance.message,
        } };
      };

      const sourceProblems: Problem[] = [];
      const sourceRefs: string[] = [];
      const orderRefs: string[] = [];
      for (const mapping of mappings) {
        for (const ref of mapping.sourceRefs) {
          // WI-6554700010017011: an owner directive is cited by id. It belongs to no
          // transcript, so no sourceRange can cover it; it resolves against the orders
          // store below instead.
          if (parseOrderSourceRef(ref) != null) {
            orderRefs.push(ref);
            continue;
          }
          sourceRefs.push(ref);
          const parsed = parseTurnRef(ref);
          if (!parsed || !ref.startsWith('session_turn:')) {
            sourceProblems.push({
              itemId: mapping.id,
              code: 'invalid_session_turn_ref',
              detail: `${mapping.id} source ref '${ref}' is not a canonical session_turn:<kind>:<session>:<turn> or order:<id> reference`,
            });
            continue;
          }
          const covered = sourceRanges.some(
            (range) =>
              range.sourceKind === parsed.sourceKind &&
              range.sessionId === parsed.sessionId &&
              parsed.turnIdx >= range.fromTurn &&
              parsed.turnIdx <= range.toTurn,
          );
          if (!covered) {
            sourceProblems.push({
              itemId: mapping.id,
              code: 'source_ref_outside_range',
              detail: `${mapping.id} source ref '${ref}' is outside every declared sourceRange`,
            });
          }
        }
      }
      if (sourceProblems.length > 0) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          error: 'activation_audit_invalid',
          problems: sourceProblems,
          message: `${sourceProblems.length} source mapping problem(s) — nothing was recorded.`,
        } };
      }

      // This tool opts out of the ambient workspace transaction because the
      // activation writer takes its own advisory-locked transaction below.
      // Consequently ctx.tx is intentionally absent at runtime; resolve the
      // canonical session refs through the same org SQL surface as the writer.
      const { sql } = getOrgPg();
      const orderTurns = await fetchOrderSourceTurns(sql as unknown as TurnSql, workspaceId, orderRefs);
      const resolutions: Array<{
        ref: string;
        ok: boolean;
        source?: 'index' | 'archive' | 'orders';
        reason?: 'invalid_ref' | 'not_found' | 'order_not_found';
      }> = [
        ...(await resolveSessionTurnRefs(
          sql as Parameters<typeof resolveSessionTurnRefs>[0],
          workspaceId,
          sourceRefs,
        )),
        ...[...new Set(orderRefs)].map((ref) => (orderTurns.has(ref)
          ? { ref, ok: true, source: 'orders' as const }
          : { ref, ok: false, reason: 'order_not_found' as const })),
      ];
      const unresolved = resolutions.filter((resolution) => !resolution.ok);
      if (unresolved.length > 0) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          error: 'source_refs_unresolved',
          problems: unresolved.map((resolution) => (resolution.reason === 'order_not_found'
            ? {
                code: 'owner_directive_not_found',
                detail: `'${resolution.ref}' is not an owner directive in this workspace (orders:get)`,
              }
            : {
                code: resolution.reason === 'invalid_ref' ? 'invalid_session_turn_ref' : 'session_turn_not_found',
                detail: `'${resolution.ref}' could not be resolved through sessions:read's index/archive stores`,
              })),
          message:
            `${unresolved.length} source ref(s) are not directly readable. Refresh/repair the transcript source; no audit was recorded.`,
        } };
      }

      // plan-item-provenance-2026-09-29 P-002: the reverse check. Every current item
      // must trace to an OWNER turn (not an assistant or machine-injected one), a valid
      // derivation, or an explicit agent-added declaration.
      const provenance = currentPlan
        ? await evaluateActivationItemProvenance({
            planContent: currentPlan.content,
            mappings,
            declarations: activation.itemProvenance ?? [],
            previous: {
              exists: previousAudit != null,
              check: previousAudit?.activation?.itemProvenanceCheck ?? null,
            },
            lookupOrigins: dbRefOriginLookup(sql as Parameters<typeof dbRefOriginLookup>[0], workspaceId),
          })
        : null;
      if (provenance && provenance.problems.length > 0) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          ...(dryRun ? { dryRun: true as const, preview: true as const } : {}),
          error: 'item_provenance_invalid' as const,
          problems: provenance.problems,
          message: `${provenance.problems.length} itemProvenance declaration problem(s); nothing was recorded.`,
        } };
      }
      if (provenance?.refuse) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          ...(dryRun ? { dryRun: true as const, preview: true as const } : {}),
          error: 'item_provenance_missing' as const,
          unresolvedItems: provenance.check.unresolved,
          problems: itemProvenanceMissingProblems(provenance.summary),
          message:
            `${provenance.check.unresolved.length} plan item(s) do not trace to anything the owner said: ` +
            `${provenance.check.unresolved.join(', ')}. Cite the owner turn in a mapping targeting the item, or declare it ` +
            'in itemProvenance as derived (from an owner-backed target) or agent-added (with a reason). Nothing was recorded.',
        } };
      }
      if (provenance) activation.itemProvenanceCheck = provenance.check;
      const itemProvenanceResult = provenance
        ? {
            enforced: provenance.check.enforced,
            counts: provenance.summary.counts,
            unresolved: provenance.check.unresolved,
            ...(provenance.warning ? { warning: provenance.warning } : {}),
          }
        : null;

      // plan-reuse-and-library-declarations-2026-10-20 R-3 / D-003: a draft or ready
      // plan activates only with valid reuse and libraries sections (or a one-line
      // notApplicable reason in each). Active and shipped plans are not retrofitted.
      const declarationGate = currentPlan
        ? evaluateActivationDeclarations(currentPlan.content, currentPlan.status)
        : null;
      if (declarationGate && !declarationGate.ok) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          ...(dryRun ? { dryRun: true as const, preview: true as const } : {}),
          error: 'plan_declarations_invalid' as const,
          problems: declarationGate.blockers,
          diagnostics: declarationGate.preview.diagnostics,
          message:
            `${declarationGate.blockers.map((blocker) => `"## ${blocker.section}" is ${blocker.status}`).join('; ')}. ` +
            'Fill in each section\'s JSON block, or set its notApplicable to a one-line reason; nothing was recorded.',
        } };
      }
      // R-4 (D-002, D-004 #2, D-013 #2): every reuse entry must name something that
      // exists, and its items must be this plan's P-NNN ids. Only a definitive
      // not-found refuses; a lookup backend that is down leaves the entry unverified.
      let reuseReferences: ReuseReferenceReport | null = null;
      const reuseData = declarationGate?.applies && declarationGate.preview.reuse.status === 'declared'
        ? declarationGate.preview.reuse.data
        : null;
      const librariesData = declarationGate?.applies && declarationGate.preview.libraries.status === 'declared'
        ? declarationGate.preview.libraries.data
        : null;
      // An unresolvable citation root leaves file / symbol / package entries unverified,
      // never falsely not-found against the wrong tree.
      let declarationRepoRoot: string | null = null;
      if (declarationGate?.applies) {
        try {
          const context = await repoCitationContextForHarness(harnessSlug);
          if (context && !isCitationContextFailure(context)) declarationRepoRoot = context.repoRoot;
        } catch {
          declarationRepoRoot = null;
        }
      }
      if (reuseData && currentPlan) {
        reuseReferences = await resolveReuseReferences(reuseData, {
          resolvers: defaultReuseReferenceResolvers({ repoRoot: declarationRepoRoot, sql: getOrgPg().sql as never, workspaceId }),
          planItemIds: new Set(parsePlan(currentPlan.content, { filePath: `${args.slug}.md` }).items.map((item) => item.id)),
        });
        if (!reuseReferences.ok) {
          return { data: {
            ok: false as const,
            slug: args.slug,
            phase: 'activation' as const,
            ...(dryRun ? { dryRun: true as const, preview: true as const } : {}),
            error: 'plan_reuse_references_unresolved' as const,
            problems: reuseReferences.blockers,
            unverified: reuseReferences.unverified,
            message:
              `${reuseReferences.blockers.length} reuse entr${reuseReferences.blockers.length === 1 ? 'y does' : 'ies do'} not resolve: ` +
              reuseReferences.blockers.map((blocker) => `${blocker.ref} (${blocker.detail})`).join('; ') +
              '. Fix each reference in "## Existing infrastructure reused" (exact path, path#Symbol, tool, schema.table, package, routine or doc slug); nothing was recorded.',
          } };
        }
      }
      // R-5 (D-004 #4/#6, D-013 #3): already-in-project names a real dependency and an
      // owner-specified row cites an owner-typed turn; unavailable lookups are unverified.
      let libraryChecks: LibraryCheckReport | null = null;
      if (librariesData) {
        libraryChecks = await checkLibraryDeclarations(librariesData,
          await defaultLibraryCheckDeps({ repoRoot: declarationRepoRoot, sql: getOrgPg().sql as never, workspaceId }));
        if (!libraryChecks.ok) {
          return { data: {
            ok: false as const,
            slug: args.slug,
            phase: 'activation' as const,
            ...(dryRun ? { dryRun: true as const, preview: true as const } : {}),
            error: 'plan_library_rows_invalid' as const,
            problems: libraryChecks.blockers,
            unverified: libraryChecks.unverified,
            message:
              libraryChecks.blockers.map((blocker) => `needs.${blocker.row} (${blocker.need}): ${blocker.detail}`).join('; ') +
              '. Fix each row in "## Third-party libraries"; nothing was recorded.',
          } };
        }
      }
      // D-013 #1: the lifecycle doors re-check the declarations on the plan's CURRENT
      // content whenever the audit they rely on was itself gated on them.
      // Server-written: a caller-supplied value is never trusted.
      if (declarationGate?.applies) {
        // R-6 (D-013 #4): the ship check's baseline is read from this row.
        const dependencyBaseline = await captureDependencyBaseline(declarationRepoRoot);
        activation.declarationsCheck = {
          enforced: true,
          ...(dependencyBaseline ? { dependencyBaseline } : {}),
          reuse: declarationGate.preview.reuse.status,
          libraries: declarationGate.preview.libraries.status,
          ...(reuseReferences ? {
            references: {
              checked: reuseReferences.checks.length,
              found: reuseReferences.checks.filter((check) => check.status === 'found').length,
              unverified: reuseReferences.unverified,
            },
          } : {}),
          ...(libraryChecks ? {
            libraryChecks: { unverified: libraryChecks.unverified, advice: libraryChecks.advice },
          } : {}),
        };
      } else {
        delete activation.declarationsCheck;
      }

      if (dryRun) {
        const targetProblems = validateActivationAuditPlanTargets(activation, currentPlan!.content);
        if (targetProblems.length > 0) {
          return { data: {
            ok: false as const,
            slug: args.slug,
            phase: 'activation' as const,
            dryRun: true as const,
            preview: true as const,
            error: 'plan_targets_invalid' as const,
            problems: targetProblems,
            message: describeActivationAuditPlanTargetProblems(targetProblems, 'no writes were performed.'),
          } };
        }
        // BAR seeding is a precondition on the PLAN, not on this payload, so the
        // preview used to pass while the identical dryRun:false call refused
        // `bar_mapping_missing` — an ok:true scoped to the payload but read as a
        // verdict on the call. Mirror the writer's own gate EXACTLY: plan-audits
        // wraps every BAR branch in `if (current.acceptance_bar_epoch != null)`,
        // so a plan outside the contract requires no Bar-to-work map. Checking
        // unconditionally would refuse the ~94% of plans whose epoch is NULL
        // (measured 2026-09-20: 1916 of 2044) — the mirror-image false verdict.
        const barGateRows = await sql<Array<{
          acceptance_bar_epoch: string | null;
          acceptance_bar_cohort: string | null;
          acceptance_bar_rubric_slug: string | null;
        }>>`
          SELECT acceptance_bar_epoch, acceptance_bar_cohort, acceptance_bar_rubric_slug
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug ?? ''}
             AND plan_slug = ${args.slug}
        `;
        if (barGateRows?.[0]?.acceptance_bar_epoch != null) {
          const barSource = validateAcceptanceBarSource(currentPlan!.content);
          if (!barSource.ok) {
            return { data: {
              ok: false as const,
              slug: args.slug,
              phase: 'activation' as const,
              dryRun: true as const,
              preview: true as const,
              error: barSource.problems[0]!.code,
              problems: barSource.problems,
              message:
                `${barSource.problems.length} BAR seed problem(s): ` +
                `${barSource.problems.map((problem) => problem.detail).join('; ')}`,
            } };
          }
          const projectionIdentities = await sql<Array<{
            spec_id: string;
            source_bar_key: string | null;
            lifecycle_status: 'draft' | 'active' | 'accepted' | 'superseded';
          }>>`
            SELECT c.spec_id, r.source_bar_key, r.lifecycle_status
              FROM harness_shared.plan_spec_clauses c
              JOIN harness_shared.plan_spec_clause_revisions r
                ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
               AND r.plan_slug = c.plan_slug AND r.spec_id = c.spec_id
               AND r.revision = c.current_revision
             WHERE c.workspace_id = ${workspaceId}
               AND c.harness_slug = ${harnessSlug ?? ''}
               AND c.plan_slug = ${args.slug}
               AND c.spec_id ~ '^AUTO-BAR-R-[0-9]+-P-[0-9]{3,}$'
             ORDER BY c.spec_id
             LIMIT ${MAX_BAR_PROJECTION_EDGES + 1}`;
          if (projectionIdentities.length > MAX_BAR_PROJECTION_EDGES) {
            return { data: {
              ok: false as const,
              slug: args.slug,
              phase: 'activation' as const,
              dryRun: true as const,
              preview: true as const,
              error: 'bar_projection_set_too_large' as const,
              problems: [{
                code: 'bar_projection_set_too_large' as const,
                detail: `existing projection identity read exceeded ${MAX_BAR_PROJECTION_EDGES}; refusing a truncated comparison`,
              }],
              message: `1 BAR seed problem(s): existing projection identity read exceeded ${MAX_BAR_PROJECTION_EDGES}; refusing a truncated comparison`,
            } };
          }
          const expectedProjectionIds = new Set(
            barSource.mappings.flatMap((mapping) =>
              mapping.planItemIds.map((planItemId) => `AUTO-BAR-${mapping.barKey}-${planItemId}`),
            ),
          );
          const unexpected = unexpectedAcceptanceBarProjectionIds(
            expectedProjectionIds,
            projectionIdentities,
          );
          if (unexpected.length > 0) {
            const detail = acceptanceBarProjectionConflictDetail(unexpected);
            return { data: {
              ok: false as const,
              slug: args.slug,
              phase: 'activation' as const,
              dryRun: true as const,
              preview: true as const,
              error: 'bar_projection_conflict' as const,
              problems: [{
                code: 'bar_projection_conflict' as const,
                detail,
              }],
              message: `1 BAR seed problem(s): ${detail}`,
            } };
          }
          // A pin may name a retired rubric while the writer is adopting an
          // unstarted successor. Reuse its complete transactional decision;
          // presence of a pin is not proof that every current BAR is preserved.
          const seedPreview = await previewCurrentActivationAudit({
            workspaceId, harnessSlug: harnessSlug ?? '', planSlug: args.slug,
            createdBy: resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId,
            classRef: activationClassRef, activation,
          });
          if (!seedPreview.ok) return { data: {
            ...seedPreview, slug: args.slug, phase: 'activation' as const,
            dryRun: true as const, preview: true as const,
          } };
        }
        const previewConformance = conformanceRefusal(true);
        if (previewConformance) return previewConformance;
        return { data: {
          ok: true as const,
          slug: args.slug,
          phase: 'activation' as const,
          dryRun: true as const,
          preview: true as const,
          sourceRanges: sourceRanges.length,
          mappings: mappings.length,
          carriedMappings: merged.carriedMappingIds.length,
          carriedMappingIds: merged.carriedMappingIds,
          ...(merged.retiredTargets.length ? { retiredTargets: merged.retiredTargets } : {}),
          coverageBaseAuditSeq: previousAudit?.auditSeq ?? null,
          sourceRefsResolved: resolutions.length,
          itemProvenance: itemProvenanceResult,
          planSnapshot: {
            version: currentPlan!.version,
            contentHash: currentPlan!.contentHash,
          },
          message: 'Activation audit validation passed; no audit, repair, clause, or event writes were performed.',
        } };
      }

      const writeConformance = conformanceRefusal(false);
      if (writeConformance) return writeConformance;
      const recorded = await recordCurrentActivationAudit({
        workspaceId,
        planSlug: args.slug,
        harnessSlug: harnessSlug ?? '',
        createdBy: resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId,
        classRef: activationClassRef,
        activation,
        summary: args.summary ?? null,
      });
      if (!recorded.ok) {
        return { data: {
          slug: args.slug,
          phase: 'activation' as const,
          ...recorded,
        } };
      }

      // plan-item-provenance P-004: plan_audits has no change trigger, so this — the sole
      // activation-audit writer — pushes the provenance view itself after the commit.
      try {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        await notifySyncInvalidate('plans.provenance', undefined);
      } catch {
        /* best-effort — the panel refreshes on its next mount */
      }

      // EI-22638466916646751: surface the same side-effect-free checkpoint
      // consult preview that plans:start would evaluate. The audit is already
      // durable at this point, so an unavailable advisory preview must remain
      // visible without changing the successful audit outcome.
      const activationReadiness = {
        consult: currentPlan?.content
          ? await previewPlanStartConsult({
              workspaceId,
              requesterId: resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId,
              planSlug: args.slug,
              planContent: currentPlan.content,
            })
          : {
              outcome: 'unavailable' as const,
              error: 'consult_preview_unavailable' as const,
              message: 'Consult candidate preview could not be evaluated because the canonical plan content was unavailable.',
            },
      };

      // P-019 / D-047: derive DRAFT spec clauses from the realizing mappings this audit
      // just recorded, so the design→code contract exists BY DEFAULT rather than by
      // opt-in. Safe to run unconditionally: a `draft` clause is outside the coverage
      // gate's ENFORCEABLE_LIFECYCLE, and the DB constraint
      // plan_spec_clause_revisions_acceptance_exact makes promotion impossible without a
      // named accepter — so this can never refuse anyone's ship.
      //
      // NON-FATAL BY CONSTRUCTION. The audit is already durably recorded at this point.
      // A derivation failure must therefore be REPORTED, never propagated: throwing here
      // would turn a successful audit into a caller-visible failure and invite a retry
      // that re-records nothing, which is strictly worse than deriving no clauses.
      let derivedSpecClauses: Awaited<ReturnType<typeof persistDerivedDraftClauses>> | {
        error: string;
      } | null = null;
      // Post-epoch plans already persisted their BAR-derived clause projections in
      // recordCurrentActivationAudit's SAME transaction. Running the legacy mapper
      // again would create a competing projection family from source-conversation
      // M-NNN rows. Historical plans retain the old non-fatal behavior until P-010
      // gives them an explicit cohort.
      if (!recorded.barSeed && !recorded.barSeedPendingAmendment && !recorded.barSeedPendingRepair) {
        try {
          derivedSpecClauses = await persistDerivedDraftClauses(
            {
              planSlug: args.slug,
              ...(harnessSlug ? { harnessSlug } : {}),
              mappings,
              // Liveness: an empty read is UNKNOWN, and the deriver fails open on it
              // (D-040's rule) — `setSpecClause` is the backstop that refuses a target the
              // plan does not actually have.
              // WI-10005174: `harnessSlug` is only a candidate here; read the items
              // of the harness that actually owns the plan.
              planItems: await getPlanItemStatuses(args.slug, {
                harnessSlug: await resolvePlanItemHomeHarness(args.slug, harnessSlug),
              }),
              actorId: resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId,
            },
            setSpecClause,
          );
        } catch (error) {
          derivedSpecClauses = { error: error instanceof Error ? error.message : String(error) };
        }
      }

      // P-017: the UNDER-READ detector. Independently re-extracts requirement-shaped
      // turns from the ranges this audit DECLARED and reports the ones no mapping cited.
      // ADVISORY by construction (see the module header): it is lexical, so it can see
      // that a turn sounds like a requirement but never that its content went unabsorbed.
      // Refusing an audit on that basis would block correct work on a guess.
      //
      // The verdict carries its own coverage (`unsuppliedTurns`), so a bounded read
      // degrades it to inconclusive rather than silently shrinking the denominator —
      // which would be the very self-chosen-denominator failure P-017 exists to close.
      let underRead:
        | Awaited<ReturnType<typeof detectUnderReadFromSource>>
        | { error: string };
      try {
        underRead = await detectUnderReadFromSource(
          { sourceRanges, mappings },
          async (ranges, cap) => {
            if (ranges.length === 0) return [];
            const sourceKinds = ranges.map((range) => range.sourceKind);
            const sessionIds = ranges.map((range) => range.sessionId);
            const rows = await sql<
              Array<{ source_kind: string; session_id: string; turn_idx: number; speaker: string; text: string }>
            >`
              SELECT turns.source_kind, turns.session_id, turns.turn_idx, turns.speaker, turns.text
                FROM harness_shared.session_turns AS turns
               WHERE (turns.workspace_id = ${workspaceId} OR turns.workspace_id = 'default')
                 -- Keep the two columns paired with one unnest. sql.array() is
                 -- required here: binding a JS array directly expands it as a
                 -- comma-separated SQL fragment, which is invalid as one unnest
                 -- argument on getOrgPg.
                 AND EXISTS (
                   SELECT 1
                     FROM unnest(
                       ${sql.array(sourceKinds)}::text[],
                       ${sql.array(sessionIds)}::text[]
                     ) AS wanted(source_kind, session_id)
                    WHERE wanted.source_kind = turns.source_kind
                      AND wanted.session_id = turns.session_id
                 )
                 AND turns.turn_idx BETWEEN ${Math.min(...ranges.map((r) => r.fromTurn))}
                                        AND ${Math.max(...ranges.map((r) => r.toTurn))}
                 -- D-006: the detector echoes uncited turn text back to the auditor, so a
                 -- turn another agent recorded inside its disclosure window never enters it.
                 AND NOT ${restrictedTurnSql(sql, 'turns', [resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId])}
               ORDER BY turns.source_kind, turns.session_id, turns.turn_idx
               LIMIT ${cap}`;
            // Over-fetches across gaps between ranges of the SAME session; detectUnderRead
            // filters to the declared set, so the extra rows change no count.
            return rows.map((row) => ({
              sourceKind: row.source_kind,
              sessionId: row.session_id,
              turnIdx: row.turn_idx,
              speaker: row.speaker,
              text: row.text,
            }));
          },
        );
      } catch (error) {
        underRead = { error: error instanceof Error ? error.message : String(error) };
      }

      // P-018: the SOURCE-SPAN assertion — the complement of P-017 above. P-017 asks
      // "within the ranges you declared, what did you skip"; this asks the prior question
      // that decides the denominator: "were the ranges you declared the whole
      // conversation". An auditor who declares turns 60-120 of a 200-turn session has
      // excluded 140 turns before any mapping is written, and every other check operates
      // inside that choice and cannot see past it.
      //
      // Advisory for the same reason as P-017, and inconclusive rather than clean when a
      // declared session's extent cannot be measured — concluding "fully spanned" from a
      // failed measurement would be the very hole this closes, moved into the detector.
      let sourceSpan: ReturnType<typeof assertSourceSpan> | { error: string };
      try {
        const sessionKeys = [
          ...new Map(
            sourceRanges.map((range) => [
              `${range.sourceKind}::${range.sessionId}`,
              [range.sourceKind, range.sessionId] as const,
            ]),
          ).values(),
        ];
        const sourceKinds = sessionKeys.map(([sourceKind]) => sourceKind);
        const sessionIds = sessionKeys.map(([, sessionId]) => sessionId);
        const extents = sessionKeys.length === 0
          ? []
          : (
              await sql<Array<{ source_kind: string; session_id: string; min_turn: number; max_turn: number }>>`
                SELECT turns.source_kind, turns.session_id,
                       MIN(turns.turn_idx) AS min_turn, MAX(turns.turn_idx) AS max_turn
                  FROM harness_shared.session_turns AS turns
                 WHERE (turns.workspace_id = ${workspaceId} OR turns.workspace_id = 'default')
                   -- Keep the two key columns paired; a pair of independent ANY
                   -- predicates would admit cross-session combinations. Use
                   -- sql.array() so each array remains one SQL argument.
                   AND EXISTS (
                     SELECT 1
                       FROM unnest(
                         ${sql.array(sourceKinds)}::text[],
                         ${sql.array(sessionIds)}::text[]
                       ) AS wanted(source_kind, session_id)
                      WHERE wanted.source_kind = turns.source_kind
                        AND wanted.session_id = turns.session_id
                   )
                 GROUP BY turns.source_kind, turns.session_id`
            ).map((row) => ({
              sourceKind: row.source_kind,
              sessionId: row.session_id,
              minTurn: Number(row.min_turn),
              maxTurn: Number(row.max_turn),
            }));
        sourceSpan = assertSourceSpan({ sourceRanges, extents });
      } catch (error) {
        sourceSpan = { error: error instanceof Error ? error.message : String(error) };
      }

      await emitPlanEventForCaller(ctx as Parameters<typeof emitPlanEventForCaller>[0], {
        planSlug: args.slug,
        event: 'plan_audited',
        detail: `activation audit #${recorded.audit.auditSeq}`,
        after:
          `${mappings.length} mapping(s), ${resolutions.length} canonical source ref(s), ` +
          `revision ${recorded.auditedPlanRevision.seq}`,
      });

      // WI-10008137: a draft plan activates at the end of its activation audit by
      // running the real plans:start (start gate, dependencies, spec quality, consult).
      // A refusal leaves it draft and is reported here; it never fails the audit.
      const { autoStartAfterActivationAudit } = await import('./auto-start-after-audit');
      const autoStart = await autoStartAfterActivationAudit({
        slug: args.slug,
        harness: harnessSlug,
        planContent: currentPlan?.content,
        start: async (startArgs) => {
          const { default: startTool } = await import('./start');
          return startTool.handler(startArgs as never, ctx as never);
        },
      });

      return { data: {
        ok: true as const,
        slug: args.slug,
        autoStart,
        phase: 'activation' as const,
        auditSeq: recorded.audit.auditSeq,
        auditedPlanRevision: recorded.auditedPlanRevision,
        sourceRanges: sourceRanges.length,
        mappings: mappings.length,
        carriedMappings: merged.carriedMappingIds.length,
        carriedMappingIds: merged.carriedMappingIds,
        ...(merged.retiredTargets.length ? { retiredTargets: merged.retiredTargets } : {}),
        coverageBaseAuditSeq: previousAudit?.auditSeq ?? null,
        sourceRefsResolved: resolutions.length,
        sourceRefsFromArchive: resolutions.filter((resolution) => resolution.source === 'archive').length,
        repairedOmissions: activation.repairedOmissions.length,
        rejectedOrSuperseded: activation.rejectedOrSuperseded.length,
        itemProvenance: itemProvenanceResult,
        derivedSpecClauses,
        activationReadiness,
        classRefResolution: {
          classRef: classResolution.classRef,
          source: classResolution.source,
          ...(classResolution.evaluationScorecardId
            ? { evaluationScorecardId: classResolution.evaluationScorecardId }
            : {}),
        },
        ...(recorded.barSeed ? { barSeed: recorded.barSeed } : {}),
        ...(recorded.barSeedPendingAmendment
          ? { barSeedPendingAmendment: recorded.barSeedPendingAmendment }
          : {}),
        ...(recorded.barSeedPendingRepair
          ? { barSeedPendingRepair: recorded.barSeedPendingRepair }
          : {}),
        underRead,
        sourceSpan,
      } };
    }

    // The plan's real items. An empty read is ambiguous between "no such plan" and "the
    // index read failed", and BOTH must refuse: validating against an empty list would
    // accept every itemId, which is the opposite of this tool's job.
    // WI-10005174: scope to the plan's own harness; a same-slug plan in another harness
    // would otherwise lend its item ids to this validation.
    const planItems = await getPlanItemStatuses(args.slug, {
      harnessSlug: await resolvePlanItemHomeHarness(args.slug, harnessSlug),
    });
    if (planItems.length === 0) {
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'plan_items_unreadable',
        message:
          `No items could be read for plan '${args.slug}'. Either the plan does not exist, or it has no ` +
          `parsed items (item lines must be \`- **P-001** \\\`todo\\\` text\`). An audit cannot be validated ` +
          `against an unknown item set, so this is refused rather than recorded.`,
      } };
    }
    const known = new Set(planItems.map((i) => i.itemId));

    if (args.proposeCitations) {
      const context = await repoCitationContextForHarness(harnessSlug);
      if (!harnessSlug || !context || isCitationContextFailure(context)) {
        return { data: { ok: false as const, error: 'citation_context_unavailable', slug: args.slug } };
      }
      const derived = await proposeAuditCitations({
        workspaceId: sctx.workspaceId ?? activeWorkspaceId(), harnessSlug, planSlug: args.slug, items: planItems,
      }, { blobSha: (path) => context.deps.blobSha?.(path) ?? null });
      return { data: { ok: true as const, phase: 'completion' as const, preview: true, slug: args.slug, ...derived } };
    }

    const submittedCitations = (args.items ?? []).flatMap((item) => item.citations ?? []) as AuditCitation[];
    // Root selection is deliberately still a WHOLE-PLAN decision: mixing evidence from
    // two equally-valid Hive checkouts would make the audit impossible to revalidate at
    // ship time. But a single bad citation must not discard every other item in the same
    // call. When the all-citations selection reports paths absent everywhere, retry root
    // selection after removing only those known-global misses; the per-item resolver below
    // then records the good entries and returns the bad ones as a partial result.
    let citationContext = await repoCitationContextForHarness(
      harnessSlug,
      submittedCitations,
    );
    const initialCitationFailure = isCitationContextFailure(citationContext) ? citationContext : null;
    if (initialCitationFailure) {
      const globallyUnresolvable = initialCitationFailure.citations;
      const mayResolve = submittedCitations.filter(
        (citation) =>
          !globallyUnresolvable.some(
            (failure) =>
              failure.path === citation.path &&
              failure.line === citation.line &&
              failure.symbol === citation.symbol,
          ),
      );
      const partialContext = await repoCitationContextForHarness(harnessSlug, mayResolve);
      // A null/failed retry means this was not a simple item-local citation miss (for
      // example, the available roots are ambiguous). Keep the original fail-closed
      // response rather than guessing a tree.
      if (partialContext && !isCitationContextFailure(partialContext)) citationContext = partialContext;
    }
    if (isCitationContextFailure(citationContext)) {
      const rendered = citationContext.citations
        .map((citation) =>
          `${citation.path ?? '(missing path)'}${citation.symbol ? `#${citation.symbol}` : ''} (${citation.reason})`,
        )
        .join('; ');
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'citation_unresolvable',
        citations: citationContext.citations,
        message:
          `One or more code/test citations could not be resolved in any available checkout: ${rendered}. ` +
          `Fix the cited path, line, or symbol; the harness source root is not the cause.`,
      } };
    }
    if (!citationContext) {
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'harness_repo_unresolved',
        message:
          `The canonical source root for harness '${harnessSlug ?? '(none)'}' could not be resolved. ` +
          `No audit was recorded. The resolver tried the registry root, every discovered hive ` +
          `checkout, and (for a repo-less hive with zero resolving checkouts) the canonical repo — ` +
          `so either the citations resolve nowhere, or more than one hive checkout resolves them ` +
          `(an ambiguous tie is refused). Register/fix the harness path rather than validating ` +
          `citations against a different checkout.`,
      } };
    }
    // P-003: generic citations resolve against platform storage. Their content hashes are
    // stamped from the store here, and each entry records the deliverable it was audited
    // against so a generic citation verifies only a non-code item (R-7).
    const genericLookup = await loadGenericCitationLookupForWorkspace(
      submittedCitations,
      sctx.workspaceId ?? activeWorkspaceId(),
    );
    const deps = { ...citationContext.deps, generic: genericLookup };
    // An unreadable plan row leaves the profile unknown, which resolves to coding (D-005).
    const planRow = await getPlanRow(args.slug, { harnessSlug });
    const verificationProfile = planRow?.verificationProfile ?? null;
    const declaredDeliverable = new Map(planItems.map((item) => [item.itemId, item.deliverable ?? null]));
    const auditedSha = args.auditedSha ?? resolveHeadSha(citationContext.repoRoot);
    const problems: Problem[] = [];
    const entries: AuditItemEntry[] = [];
    const seenItems = new Set<string>();
    const workingTreeDrift = new Set<string>();
    let citationsChecked = 0;

    for (const it of args.items ?? []) {
      const itemProblemStart = problems.length;
      if (seenItems.has(it.itemId)) {
        problems.push({
          itemId: it.itemId,
          code: 'duplicate_item',
          detail: `'${it.itemId}' appears more than once in this audit pass`,
        });
        continue;
      }
      seenItems.add(it.itemId);
      if (!known.has(it.itemId)) {
        problems.push({
          itemId: it.itemId,
          code: 'unknown_item',
          detail: `'${it.itemId}' is not an item of plan '${args.slug}'`,
        });
        continue;
      }

      const citations = (it.citations ?? []) as AuditCitation[];
      const itemDeliverable = declaredDeliverable.get(it.itemId) ?? null;
      const verification = resolveVerification(
        { verificationProfile },
        { deliverable: itemDeliverable, auditVerdict: it.verdict },
      );

      if (it.verdict === 'implemented' && citations.length === 0) {
        problems.push({
          itemId: it.itemId,
          code: 'uncited_verdict',
          detail: `verdict 'implemented' needs at least one citation — that claim is the whole point of the audit`,
        });
      } else if (
        it.verdict === 'implemented' &&
        !entryHasVerifyingCitation({ citations, codeDeliverable: verification.codeDeliverable })
      ) {
        // D-008. Requiring "at least one citation" was not enough: `doc` satisfied it, so
        // `implemented` — whose documented meaning is "traced to as-built code the auditor
        // READ" — could be claimed on a document asserting completion. Only code/test are
        // evidence for a code deliverable; a doc says where a deliverable lives, never that
        // code exists. P-003: a NON-code deliverable may instead cite generic evidence.
        problems.push({
          itemId: it.itemId,
          code: 'implemented_without_code',
          detail: verification.codeDeliverable
            ? `verdict 'implemented' requires at least one \`code\` or \`test\` citation resolving against the ` +
              `tree — a \`doc\` or generic citation cannot support it for a code deliverable. Read the CODE and ` +
              `cite the file that implements '${it.itemId}'; do not rely on a doc, a work-item, or your memory ` +
              `of writing it. If the item's deliverable genuinely is not source, declare it (plans:add-item ` +
              `deliverable) or use the verdict 'not-code' (with \`note\`).`
            : `verdict 'implemented' for the non-code deliverable '${verification.deliverable ?? 'undeclared'}' ` +
              `requires a \`code\`/\`test\` citation or a resolving generic citation (artifact, work-item, ` +
              `measurement, external) — a \`doc\` citation records a location, not evidence.`,
        });
      }
      if (isNonCodeAuditVerdict(it.verdict) && itemDeliverable === 'code') {
        // D-004 / D-006: a declared code deliverable cannot be audited out of code checks.
        problems.push({
          itemId: it.itemId,
          code: 'not_code_contradicts_deliverable',
          detail:
            `'${it.itemId}' declares deliverable 'code', so verdict 'not-code' cannot exempt it from code ` +
            `verification. Cite the code, or change the declared deliverable with a recorded plan Decision first.`,
        });
      }
      if (isNonCodeAuditVerdict(it.verdict) && !it.note) {
        // The widest escape hatch in the design — wider than `none`, and unmetered until
        // D-008. A reason is the minimum bar, and summarizeCoverage now counts these.
        problems.push({
          itemId: it.itemId,
          code: 'not_code_without_reason',
          detail:
            `verdict 'not-code' requires \`note\` saying what the deliverable IS and why no code implements ` +
            `it. This verdict exempts an item from code verification, so it is recorded and counted, never ` +
            `assumed (D-008).`,
        });
      }
      if (it.verdict === 'dropped' && !it.note) {
        problems.push({
          itemId: it.itemId,
          code: 'drop_without_reason',
          detail: `verdict 'dropped' requires \`note\` — departing from the plan is fine, departing silently is not (D-002)`,
        });
      }

      const storedCitations: AuditCitation[] = [];
      for (const c of citations) {
        citationsChecked += 1;
        const res = resolveCitation(c, deps);
        if (!res.ok) {
          problems.push({
            itemId: it.itemId,
            code: `citation_${res.reason}`,
            detail: res.detail ?? `${c.kind} citation did not resolve (${res.reason})`,
          });
          storedCitations.push(c);
          continue;
        }
        if (isRepoFileCitation(c)) {
          const blobSha = citationBlobSha(c, deps);
          if (!blobSha) {
            problems.push({
              itemId: it.itemId,
              code: 'citation_blob_unreadable',
              detail: `${c.kind} citation '${c.path ?? ''}' resolved but its bytes could not be fingerprinted`,
            });
            storedCitations.push(c);
            continue;
          }
          if (auditedSha) {
            if (!deps.blobShaAt) {
              problems.push({
                itemId: it.itemId,
                code: 'citation_audited_sha_unverifiable',
                detail:
                  `${c.kind} citation '${c.path ?? ''}' cannot be checked against auditedSha '${auditedSha}' ` +
                  `because the citation context does not provide a commit-scoped blob resolver`,
              });
              storedCitations.push(c);
              continue;
            }
            let auditedBlobSha: string | null;
            try {
              auditedBlobSha = await citationBlobShaAt(c, auditedSha, deps);
            } catch (error) {
              if (!(error instanceof CitationGitReadError)) throw error;
              problems.push({
                itemId: it.itemId,
                code: 'citation_audited_sha_unavailable',
                detail: `${c.kind} citation '${c.path ?? ''}' could not be checked against auditedSha ` +
                  `'${auditedSha}' because the Git read failed; retry after the repository is available. ` +
                  `${error.message}`,
              });
              storedCitations.push(c);
              continue;
            }
            if (!auditedBlobSha) {
              problems.push({
                itemId: it.itemId,
                code: 'citation_audited_sha_unresolvable',
                detail:
                  `${c.kind} citation '${c.path ?? ''}' resolves in the current tree but not at auditedSha ` +
                  `'${auditedSha}' (the commit may not contain the cited path or may be unavailable)`,
              });
              storedCitations.push(c);
              continue;
            }
            // P-019 (proof-freshness-pinned-candidate-2026-10-06 D-001): the audit records
            // the COMMITTED bytes at auditedSha, which is what the ship gate re-measures
            // (at its own measurement commit). A peer's uncommitted edit in the shared
            // tree is reported, not refused: it is not evidence until it is committed.
            if (auditedBlobSha !== blobSha) workingTreeDrift.add(c.path?.trim() ?? '');
            storedCitations.push({ ...c, blobSha: auditedBlobSha });
            continue;
          }
          storedCitations.push({ ...c, blobSha });
        } else if (isGenericCitationKind(c.kind)) {
          // R-8: stamp the store's current content hash — never the auditor's — so a later
          // change to the cited artifact makes this audit stale.
          const generic = resolveGenericCitation(c, genericLookup);
          storedCitations.push(generic.ok ? { ...c, contentHash: generic.contentHash } : c);
        } else {
          storedCitations.push(c);
        }
      }

      // An item with any problem is not an auditable entry. Keep it out of the
      // persisted pass so a partial result can never look like that item passed.
      if (problems.length === itemProblemStart) {
        entries.push({
          itemId: it.itemId,
          verdict: it.verdict,
          citations: storedCitations,
          deliverable: verification.deliverable,
          codeDeliverable: verification.codeDeliverable,
          ...(it.note ? { note: it.note } : {}),
        });
      }
    }

    for (const f of args.findings ?? []) {
      if (f.disposition === 'filed' && !f.ref) {
        problems.push({
          code: 'finding_undisposed',
          detail: `finding "${f.summary.slice(0, 60)}" is marked 'filed' but carries no work-item ref — file it, then cite it`,
        });
      }
    }

    // A mixed batch is useful when its valid items can be committed independently:
    // persist those entries, surface the item-scoped problems, and let the caller retry
    // only the rejected items. Batch-wide problems (for example an invalid finding)
    // remain atomic because they are not attributable to one persisted item.
    const canRecordPartial =
      entries.length > 0 &&
      problems.length > 0 &&
      problems.every((problem) => problem.itemId !== undefined);
    if (problems.length > 0 && !canRecordPartial) {
      // Preserve the original, more actionable error for an all-invalid batch. A
      // retry against an empty citation subset is useful for mixed batches, but if
      // it produced no valid entry there is still no audit to record.
      if (
        initialCitationFailure &&
        entries.length === 0 &&
        problems.every((problem) => problem.code.startsWith('citation_'))
      ) {
        const rendered = initialCitationFailure.citations
          .map((citation) =>
            `${citation.path ?? '(missing path)'}${citation.symbol ? `#${citation.symbol}` : ''} (${citation.reason})`,
          )
          .join('; ');
        return { data: {
          ok: false as const,
          slug: args.slug,
          error: 'citation_unresolvable',
          citations: initialCitationFailure.citations,
          message:
            `One or more code/test citations could not be resolved in any available checkout: ${rendered}. ` +
            `Fix the cited path, line, or symbol; the harness source root is not the cause.`,
        } };
      }
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'audit_invalid',
        problems,
        message:
          `${problems.length} problem(s) — nothing was recorded. Every problem is listed above so one fix-up ` +
          `pass clears them all. A citation that will not resolve is usually a real finding about the work, ` +
          `not a typo: if the file you expected is not there, the item may not actually be implemented.`,
      } };
    }

    const auditedAt = new Date().toISOString();
    const previous = await getEffectiveItemAudits(args.slug);
    const effectiveEntries = prepareAuditPassEntries({
      planItems,
      submitted: entries,
      previous,
      auditedSha,
      auditedAt,
    });
    const submittedIds = new Set(entries.map((entry) => entry.itemId));
    const carriedItemIds = effectiveEntries
      .filter((entry) => !submittedIds.has(entry.itemId))
      .map((entry) => entry.itemId);

    const provenanceProblems = divergentCitationBlobShaProblems(effectiveEntries);
    if (provenanceProblems.length > 0) {
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'audit_invalid',
        problems: [...problems, ...provenanceProblems],
        message:
          'The audit pass is internally inconsistent: one or more cited paths carry multiple blobSha values. ' +
          'Nothing was recorded; re-audit every listed item against one tree snapshot.',
      } };
    }

    // R-6 (plan-reuse-and-library-declarations-2026-10-20, D-013 #4): read the JS/TS
    // imports of every cited file plus the plan's work-item filesChanged; refuse a
    // third-party package that is neither declared nor a dependency at activation.
    const shipWorkspaceId = sctx.workspaceId ?? activeWorkspaceId();
    const shipDeclarations = planRow?.content ? previewPlanDeclarations(planRow.content) : null;
    const shipBaseline = dependencyBaselineFrom(
      (await getLatestActivationAudit(args.slug, { workspaceId: shipWorkspaceId, harnessSlug: harnessSlug ?? undefined }))?.activation,
    );
    const declaresAnything = shipDeclarations !== null &&
      (shipDeclarations.reuse.status === 'declared' || shipDeclarations.libraries.status === 'declared');
    let libraryShipCheck: Awaited<ReturnType<typeof runLibraryShipCheck>> | { status: 'not-applicable'; reason: string };
    const workspacePackages = declaresAnything || shipBaseline
      ? await readWorkspacePackageNames(citationContext.repoRoot)
      : null;
    if (!declaresAnything && !shipBaseline) {
      libraryShipCheck = { status: 'not-applicable', reason: 'the plan declares neither section and its activation recorded no dependency baseline' };
    } else if (!workspacePackages) {
      libraryShipCheck = { status: 'not-applicable', reason: 'workspace manifests could not be read, so first-party imports cannot be told apart' };
    } else {
      const filesChanged = harnessSlug
        ? await readPlanCompletionFilesChanged({ sql: getOrgPg().sql as never, workspaceId: shipWorkspaceId, harnessSlug, planSlug: args.slug })
        : null;
      const citedFiles = effectiveEntries.flatMap((entry) =>
        entry.citations.flatMap((citation) => (isRepoFileCitation(citation) && citation.path ? [citation.path] : [])));
      const report = await runLibraryShipCheck({
        files: [...citedFiles, ...(filesChanged ?? [])],
        repoRoot: citationContext.repoRoot,
        libraries: shipDeclarations?.libraries.status === 'declared' ? shipDeclarations.libraries.data ?? null : null,
        reuse: shipDeclarations?.reuse.status === 'declared' ? shipDeclarations.reuse.data ?? null : null,
        baseline: shipBaseline,
        workspacePackages,
      });
      if (filesChanged === null) report.unverified.push('the plan\'s work-item filesChanged could not be read; only cited files were inspected');
      if (report.status === 'pass' && report.unverified.length > 0) report.status = 'unverified';
      libraryShipCheck = report;
    }
    if (libraryShipCheck.status === 'refuse') {
      const blockers = libraryShipCheck.blockers;
      return { data: {
        ok: false as const,
        slug: args.slug,
        phase: 'completion' as const,
        ...(dryRun ? { dryRun: true as const, preview: true as const } : {}),
        error: 'plan_undeclared_third_party_packages' as const,
        problems: blockers,
        libraryShipCheck,
        message:
          `${blockers.length} third-party package(s) are imported but neither declared in "## Third-party libraries" ` +
          `nor a dependency when the plan was activated: ` +
          blockers.map((blocker) => `${blocker.package} (${blocker.files.slice(0, 3).join(', ')})`).join('; ') +
          '. Declare each in the libraries section (amend the plan) or remove the import; nothing was recorded.',
      } };
    }

    const coverage = summarizeCoverage(effectiveEntries);
    const audited = new Set(effectiveEntries.map((e) => e.itemId));
    // Items with no current OR historical audit entry. Unlisted prior entries were
    // carried by the verb with their original provenance, so callers never have to
    // copy them forward and accidentally re-stamp them at this pass's sha (D-006).
    const uncoveredItems = planItems
      .filter((i) => !audited.has(i.itemId) && i.status !== 'dropped')
      .map((i) => i.itemId);

    const rejectedItemIds = [...new Set(problems.flatMap((problem) => (problem.itemId ? [problem.itemId] : [])))];
    const partialNote = problems.length > 0
      ? `${dryRun ? 'Would record' : 'Recorded'} ${entries.length} valid item(s); ${rejectedItemIds.length} item(s) were not recorded. ` +
        `Retry only the rejected item ids after fixing their listed problems.`
      : null;
    const uncoveredNote = uncoveredItems.length > 0
      ? `${uncoveredItems.length} non-dropped item(s) have no audit entry. Audit ONLY those listed ` +
        `items (or drop them with a reason); every other unlisted item already carried forward with ` +
        `its original provenance.`
      : null;
    const driftNote = workingTreeDrift.size > 0
      ? `${workingTreeDrift.size} cited file(s) differ in the working tree from auditedSha ` +
        `${(auditedSha ?? '').slice(0, 12)}: ${[...workingTreeDrift].slice(0, 5).join(', ')}` +
        `${workingTreeDrift.size > 5 ? ` (+${workingTreeDrift.size - 5} more)` : ''}. The audit recorded the ` +
        `committed bytes at auditedSha; the citations' line/symbol checks read the working tree. If the ` +
        `uncommitted edits matter to these items, re-audit them after the edits are committed.`
      : null;
    const classRefIgnoredNote = args.classRef
      ? `classRef '${args.classRef}' was ignored: it applies only to phase:'activation'.`
      : null;
    const resultNote = [partialNote, uncoveredNote, driftNote, classRefIgnoredNote]
      .filter((note): note is string => Boolean(note)).join(' ');
    const libraryShipCheckSummary = libraryShipCheck.status === 'not-applicable'
      ? libraryShipCheck
      : {
          status: libraryShipCheck.status,
          unverified: libraryShipCheck.unverified,
          warnings: libraryShipCheck.warnings,
          thirdPartyPackages: libraryShipCheck.packages.map((entry) => `${entry.package} (${entry.admittedBy})`),
          inspectedFiles: libraryShipCheck.inspected.length,
          notInspected: libraryShipCheck.notInspected.slice(0, 20),
          notInspectedCount: libraryShipCheck.notInspected.length,
          scope: libraryShipCheck.scope,
        };

    if (dryRun) {
      return { data: {
        ok: true as const,
        slug: args.slug,
        phase: 'completion' as const,
        dryRun: true as const,
        preview: true as const,
        auditedSha,
        auditedAt,
        citationRepoRoot: citationContext.repoRoot,
        citationRootSource: citationContext.rootSource,
        citationsChecked,
        itemsAuditedThisPass: entries.length,
        itemsCarriedForward: carriedItemIds.length,
        carriedItemIds,
        coverage,
        uncoveredItems,
        ...(problems.length > 0
          ? {
              partial: true as const,
              problems,
              rejectedItemIds,
            }
          : {}),
        ...(resultNote ? { note: resultNote } : {}),
        libraryShipCheck: libraryShipCheckSummary,
        message: 'Completion audit validation passed; no audit or plan-event writes were performed.',
      } };
    }

    const audit = await recordPlanAudit({
      planSlug: args.slug,
      harnessSlug: harnessSlug ?? '',
      // Cast at the call, exactly as the sibling set-plan-status.ts does. Passing `ctx`
      // raw makes TS infer the handler's ctx parameter as ResolveIdentityCtx, which no
      // defineTool overload supplies — the whole call then fails overload resolution with
      // a TS2769 that points at `handler` and says nothing about identity.
      createdBy: resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId,
      auditedSha,
      items: effectiveEntries,
      findings: args.findings ?? [],
      summary: args.summary ?? null,
    });

    await emitPlanEventForCaller(ctx as Parameters<typeof emitPlanEventForCaller>[0], {
      planSlug: args.slug,
      event: 'plan_audited',
      detail: `audit #${audit.auditSeq}`,
      after: `${coverage.auditedItems} item(s), ${citationsChecked} citation(s) resolved`,
    });

    return { data: {
      ok: true as const,
      slug: args.slug,
      auditSeq: audit.auditSeq,
      auditedSha: audit.auditedSha,
      auditedAt,
      // WI-41365: which tree the citations were verified against, and why. Derivable
      // later by re-running the same selection, so it is disclosed here rather than
      // stored as a second copy the tree could drift from.
      citationRepoRoot: citationContext.repoRoot,
      citationRootSource: citationContext.rootSource,
      citationsChecked,
      itemsAuditedThisPass: entries.length,
      itemsCarriedForward: carriedItemIds.length,
      carriedItemIds,
      coverage,
      uncoveredItems,
      ...(problems.length > 0
        ? {
            partial: true as const,
            problems,
            rejectedItemIds,
          }
        : {}),
      ...(resultNote ? { note: resultNote } : {}),
      libraryShipCheck: libraryShipCheckSummary,
    } };
  },
});
