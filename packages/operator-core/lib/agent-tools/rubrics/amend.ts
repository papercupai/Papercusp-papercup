/**
 * rubrics:amend — patch ONE criterion field and/or the rubric-level methodRef
 * without the whole-document rubrics:propose replace (rubric-system-improvements-
 * 2026-07-12 P-003). The replace ceremony (refetch → resubmit every criterion →
 * ack loss-guards) deterred a same-day one-paragraph amendment; small rubric
 * improvements were being skipped. Amending preserves the stored lifecycle
 * status — an active rubric stays active.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { projectBoundedPayload, type AbortCompletionReceipt, type ToolResult } from '@papercusp/tooldef';
import { completedResultPayload } from '../abort-completion-payload';
import { canonicalJson } from '@papercusp/hash-chain';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  auditInstrumentBindings,
  unregisteredInstrumentRefusal,
  type InstrumentBindingAudit,
} from '../../rubric-instrument-registry';
import {
  amendRubric,
  applyRubricAmendment,
  getRubric,
  mintAmendmentIdempotencyKey,
  previewAcceptanceBarAmendment,
  rubricCompleteness,
  AMENDABLE_CRITERION_FIELDS,
  type AmendRubricInput,
} from '../../rubrics';
import { trackAmendRun } from './amend-receipts';
import { getPlanRow } from '../plans/source';
import { refineEvenWithShapeIssues } from '../_refine-with-shape-issues';
import { validateRubricReplicationSql } from '../../rubrics-replication-sql';
import { trackDetached } from '../../detached-imports';
import { requirementCriterionInputSchema, requirementAmendmentSchema } from '../plans/rubric-template';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { lintAcceptanceMethods } from '../../rubrics-method-lint';
import { runtimeVettingFindings } from '../../acceptance-runtime-citation';
import { openAcceptanceBarAmendmentReview } from '../../consult/acceptance-bar-amendment-review';
import { acceptanceBarMappingDeltaEntrySchema } from '../../acceptance-bar-amendment';
import { hostIdentity } from '../../serving-host-identity';
import { readIdentity, type IdentityCtx } from '../locks/identity';
import { resourceLockDomain } from '../locks/coordination-domain';
import { guardResource } from '../locks/resource-lock-guard';
import { DEFAULT_LOCK_TTL_SEC } from '../locks/lock-config';
import { heartbeatSharedResourceAtomic } from '../locks/su-lock-store';

/** Keep the executor alive until the tracked run has settled its durable receipt.
 * The foreground deadline only detaches the caller; it must not release this lease.
 */
async function guardAmendRun(
  ctx: IdentityCtx,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const host = hostIdentity();
  const resource = host === 'port-3170' ? 'staging-server'
    : host === 'port-3070' ? 'dev-server' : null;
  if (resource === null) return run();
  const { ownerId, ownerLabel } = readIdentity(ctx);
  const leaseOwner = `${ownerId}:rubrics-amend:${randomUUID()}`;
  const coordinationDomain = resourceLockDomain(resource);
  const outcome = await guardResource({
    coordinationDomain,
    // Concurrent runs need independent leases: reusing the caller's lease lets
    // the first completed run release protection while another is still active.
    ownerId: leaseOwner,
    ownerLabel,
    coordIdentity: resolveAgentIdentity(ctx),
    resource,
    mode: 'shared',
    ttlSec: DEFAULT_LOCK_TTL_SEC,
    reason: 'rubrics:amend keeps its serving runtime alive through terminal receipt settlement',
  }, async (fence) => {
    let renewal: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (renewal) return;
      renewal = heartbeatSharedResourceAtomic({
        coordinationDomain, resource, owner: leaseOwner, lockId: fence.lockId,
        ttlSec: DEFAULT_LOCK_TTL_SEC,
      }).then((result) => {
        if (!result.extended) console.warn('rubrics:amend runtime lease lost', { resource, lockId: fence.lockId });
      }).catch((error: unknown) => {
        console.warn('rubrics:amend runtime lease renewal failed', { resource, lockId: fence.lockId, error });
      }).finally(() => { renewal = undefined; });
    }, DEFAULT_LOCK_TTL_SEC * 500);
    timer.unref();
    try {
      return await run();
    } finally {
      clearInterval(timer);
      // Finish any in-flight renewal before guardResource releases the lease.
      await renewal;
    }
  });
  if (outcome.acquired) return outcome.result;
  return {
    ok: false,
    code: 'amendment_runtime_unavailable',
    reason: `resource_${outcome.reason}`,
    resource,
    holders: outcome.holders,
  };
}

/** P-006: the requirement this dry run still owes when nobody has opened its review. */
const REVIEW_NOT_REQUESTED_NEXT =
  "Repeat this dry run with requestReview:{ workItemId } (the server posts preview.approval on that work-item and opens the review), or post it yourself and pass reviewPreviewPost:'thread-post:<that post id>'. The relevance router picks and screens the outside-lineage reviewer; do not pick or message one yourself. A one-agent/no-additional-agents implementation route does not prohibit this platform-routed review. Keep the review request; no owner exception is needed for that route.";

const NO_LIVE_DISCHARGE_MAPPING_CODE = 'acceptance_bar_amendment_no_live_discharge_mapping';
const NO_LIVE_DISCHARGE_MAPPING_NEXT =
  "Add the changed BAR to the subject plan's `## Requirements` section and add a matching row to `## Design` → `### Bar-to-work map for this plan`, mapping it to at least one non-dropped `P-NNN` item. Then retry. The amendment guard exempts a BAR being removed from the discharge-map check.";

// Receipt progress writes take an independent SQL checkout. Apply phases inside the
// acceptance transaction are intentionally excluded while plan locks are held.
const APPLY_RECEIPT_PROGRESS_PHASES = new Set([
  'instrument-bindings',
  'rubric-write-scope',
  'acceptance-routing',
  'acceptance-composition-links',
  'acceptance-contract-snapshot',
  'acceptance-transaction-acquire',
  'acceptance-now-readiness-refresh',
  'response-validation',
]);

const ACCEPTANCE_BAR_APPROVAL_REQUIRED_CODE = 'acceptance_bar_approval_required';
const ACCEPTANCE_BAR_APPROVAL_REQUIRED_NEXT =
  "Run rubrics:amend with dryRun:true and requestReview:{ workItemId } (or post preview.approval yourself and pass reviewPreviewPost:'thread-post:<preview-id>'), follow review.next, and apply only with approvalRef:'thread-post:<reviewer-answer-id>'. A one-agent implementation route does not prohibit platform-routed independent acceptance review.";

const REVIEWER_MODEL_NOT_ALLOWED_CODE = 'reviewer_model_not_allowed';
const REVIEWER_MODEL_NOT_ALLOWED_NEXT =
  'Choose an agent/model pair present in the workspace expert model allowlist, or update that allowlist before retrying. rubrics:amend never substitutes an unavailable reviewer.';
const ACCEPTANCE_BAR_CONTRACT_REFUSAL_NEXT =
  'Correct the acceptance BAR contract before retrying: requiredTestLayers must use a recorded layer (unit, integration, e2e, llm, or browser), the check must cover every declared layer, and an automated BAR must declare its test layer.';
const PROPOSE_RUBRIC_INVALID_ARGS_PREFIX = 'invalid_args: proposeRubric:';
const PROPOSE_RUBRIC_INVALID_ARGS_NEXT =
  'Correct the rubric input described in the error, then retry. For off-scale criterion instructions, use the rubric’s effective ratingScale or revise the procedure prose.';

function rubricReadFailedRefusal(error: unknown, rubricRef: string) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith('rubric_read_failed:')) return null;
  return {
    ok: false as const,
    code: 'rubric_read_failed',
    error: message,
    rubricRef,
    retryable: true,
    next: 'Retry the same amendment after rubric reads recover; this failure does not establish that the rubric is missing.',
  };
}

function proposeRubricInvalidArgsRefusal(error: unknown): {
  ok: false;
  code: string;
  error: string;
  next: string;
} | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith(PROPOSE_RUBRIC_INVALID_ARGS_PREFIX)) return null;
  return {
    ok: false,
    code: 'invalid_args',
    error: message,
    next: PROPOSE_RUBRIC_INVALID_ARGS_NEXT,
  };
}

function acceptanceBarContractRefusal(error: unknown): {
  ok: false;
  code: string;
  error: string;
  next: string;
} | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(
    /^(acceptance_bar_amendment_(?:test_layers_missing|test_layer_unrecordable|check_layer_mismatch)):/,
  );
  if (!match) return null;
  return {
    ok: false,
    code: match[1]!,
    error: message,
    next: ACCEPTANCE_BAR_CONTRACT_REFUSAL_NEXT,
  };
}

function noLiveDischargeMappingRefusal(error: unknown): {
  ok: false;
  code: string;
  error: string;
  next: string;
} | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith(`${NO_LIVE_DISCHARGE_MAPPING_CODE}:`)) return null;
  return {
    ok: false,
    code: NO_LIVE_DISCHARGE_MAPPING_CODE,
    error: message,
    next: NO_LIVE_DISCHARGE_MAPPING_NEXT,
  };
}

function acceptanceBarApprovalRequiredRefusal(error: unknown): {
  ok: false;
  code: string;
  error: string;
  next: string;
} | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith(`${ACCEPTANCE_BAR_APPROVAL_REQUIRED_CODE}:`)) return null;
  return {
    ok: false,
    code: ACCEPTANCE_BAR_APPROVAL_REQUIRED_CODE,
    error: message,
    next: ACCEPTANCE_BAR_APPROVAL_REQUIRED_NEXT,
  };
}

function reviewerModelNotAllowedRefusal(error: unknown): {
  ok: false;
  code: string;
  error: string;
  next: string;
} | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith(`${REVIEWER_MODEL_NOT_ALLOWED_CODE}:`)) return null;
  return {
    ok: false,
    code: REVIEWER_MODEL_NOT_ALLOWED_CODE,
    error: message,
    next: REVIEWER_MODEL_NOT_ALLOWED_NEXT,
  };
}

/** The amendment fields exactly as requested, so a routed reviewer can reproduce the preview. */
function amendmentPatch(args: z.infer<typeof rubricsAmendArgs>): Record<string, unknown> {
  const fields = ['requirement', 'criteria', 'criterion', 'criterionClass', 'criterionEvidencePlane', 'methodRef', 'classRef', 'composes', 'restoreOrphanedBarContract', 'barMappingDelta'] as const;
  return Object.fromEntries(fields.filter((field) => args[field] !== undefined).map((field) => [field, args[field]]));
}

/** A retry for one routed review must reuse its receipt across workers. */
async function reviewReceiptKey(
  args: z.infer<typeof rubricsAmendArgs>,
  identity: ReturnType<typeof resolveAgentIdentity>,
  previewSource: string,
): Promise<string> {
  const rubric = await getRubric(args.rubricRef);
  const subject = rubric?.subjectPlan && rubric.subjectHarnessSlug
    ? await getPlanRow(rubric.subjectPlan, {
        workspaceId: rubric.workspaceId, harnessSlug: rubric.subjectHarnessSlug,
      })
    : null;
  const request = {
    schemaVersion: 2,
    workspaceId: identity.workspaceId ?? null,
    requesterId: identity.ownerId,
    rubricRef: args.rubricRef,
    // A caller post keeps its historical key; requestReview keys on its target
    // work-item, so a retry replays the receipt instead of posting again.
    previewPostRef: previewSource,
    // Replaying a routed preview must honor both the caller's CAS expectations
    // and the current server revisions, including callers that omitted CAS.
    expectedRubricRevision: args.expectedRubricRevision ?? null,
    expectedSubjectPlanRevision: args.expectedSubjectPlanRevision ?? null,
    idempotencyKey: args.idempotencyKey ?? null,
    rubricRevision: rubric?.revision ?? null,
    subjectPlanRevision: subject?.version ?? null,
    // An unmeasured legacy subject scope cannot safely identify a cached preview.
    ...(rubric?.subjectPlan && !subject ? { unmeasuredSubject: randomUUID() } : {}),
    reason: args.reason ?? null,
    patch: amendmentPatch(args),
    reviewerModel: args.reviewerModel ?? null,
    ...(args.reviewEvidencePost ? { reviewEvidencePost: args.reviewEvidencePost } : {}),
  };
  const digest = createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
  return `review-${digest}`;
}

/**
 * P-004 (plan-verification-friction-reduction-2026-10-11): post preview.approval
 * on the named work-item so the routed review opens in the same call. The body is
 * the approval JSON exactly, which is what the apply resolver parses. No
 * writerOwnerId: this is server-templated, and a sealed stub would fail that parse.
 */
async function postPreviewApproval(
  target: { workItemId: string; harness?: string },
  approval: unknown,
  identity: ReturnType<typeof resolveAgentIdentity>,
): Promise<{ ref: string } | { ok: false; code: string; error: string; next: string }> {
  const { commentWorkItem } = await import('../../work-items');
  const post = await commentWorkItem(target.workItemId, JSON.stringify(approval), identity.ownerId, {
    ...(identity.workspaceId ? { workspaceId: identity.workspaceId } : {}),
    ...(target.harness ? { harness: target.harness } : {}),
  });
  if (!post) {
    return {
      ok: false,
      code: 'review_work_item_not_found',
      error: `no work-item '${target.workItemId}' to post the preview approval on`,
      next: 'Pass requestReview.workItemId (plus harness when it is not the default) of a work-item whose thread the reviewer can answer on.',
    };
  }
  return { ref: `thread-post:${post.id}` };
}

const AMEND_REVIEW_PRESERVE_PATHS = [
  'receipt.poll.tool',
  'receipt.poll.args.rubricRef',
  'receipt.poll.args.idempotencyKey',
  'receipt.registered',
  'receipt.rubricRef',
  'receipt.idempotencyKey',
  'receipt.progress.phase',
  'receipt.progress.phaseStartedAt',
  'receipt.progress.observedAt',
  'review.state',
  'review.conversationId',
  'review.previewPostRef',
  'review.next',
  'ok',
  'dryRun',
  'preview.approvalRef',
] as const;

// The result door is ~6000 characters; leave room for its wire envelope and guidance.
export const AMEND_REPLY_BUDGET_CHARS = 5_000;

export function amendAbortCompletionReceipt(_args: unknown, result: ToolResult): AbortCompletionReceipt {
  const payload = completedResultPayload(result);
  const receipt = payload?.receipt as Record<string, unknown> | undefined;
  if (payload?.ok === true && receipt?.registered === true &&
    typeof receipt.rubricRef === 'string' && typeof receipt.idempotencyKey === 'string') {
    return { status: 'recorded', effectRef: `rubric-amend:${receipt.rubricRef}:${receipt.idempotencyKey}` };
  }
  return { status: 'recovery-incomplete', reason: 'No registered amendment receipt was confirmed.', failures: ['unconfirmed-amend-receipt'] };
}

function shapeAmendReviewPayload(
  data: unknown,
  { tier }: { tier: 'trimmed' | 'standard' },
): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  const originalChars = JSON.stringify(data).length;
  const targetChars = AMEND_REPLY_BUDGET_CHARS;
  if (originalChars <= targetChars) return data;

  // Keep the complete approval in the existing durable receipt. A large approval must
  // never be copied into a preserved field that makes the projector exceed its budget.
  const preview = record.preview as Record<string, unknown> | undefined;
  const { approval: _approval, ...previewSummary } = preview ?? {};
  const review = record.review as Record<string, unknown> | undefined;
  const receipt = record.receipt as Record<string, unknown> | undefined;
  const compact = preview ? {
    ...record,
    preview: {
      ...previewSummary,
      approvalRef: review?.previewPostRef ?? (receipt?.poll ? { ...receipt.poll as object, path: 'result.preview.approval' } : undefined),
    },
  } : record;

  return projectBoundedPayload(compact, {
    toolName: 'rubrics:amend',
    tier,
    originalChars,
    targetChars: targetChars - 1_000,
    preservePaths: AMEND_REVIEW_PRESERVE_PATHS,
  });
}

const amendmentCriterionSchema = requirementCriterionInputSchema;

// RSR-P-008-A: refineEvenWithShapeIssues so a request with a shape defect AND an
// invalid field combination is refused naming both, not one per round-trip.
export const rubricsAmendArgs = refineEvenWithShapeIssues(
  z.object({
    rubricRef: z.string().min(1).max(120).describe('the rubric ref/slug to amend'),
    requirement: requirementAmendmentSchema
      .optional()
      .describe(
        'patch one requirement Intent, Acceptance or Verification; promise changes use the BAR amendment transaction',
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        'Preview only. requestReview:{workItemId} posts approval and starts review in one call; reviewPreviewPost remains supported.',
      ),
    reviewPreviewPost: z
      .string()
      .trim()
      .regex(/^thread-post:[1-9][0-9]*$/)
      .optional()
      .describe(
        "dryRun only: thread-post:<id> containing this preview's approval JSON; opens the routed review when required and returns its state/next.",
      ),
    requestReview: z
      .object({
        workItemId: z.string().trim().min(1).max(64),
        harness: z.string().trim().min(1).max(120).optional(),
      })
      .strict()
      .optional()
      .describe(
        'dryRun only: the server posts preview.approval on this work-item and opens the routed review in the same call.',
      ),
    reviewEvidencePost: z.string().trim().regex(/^thread-post:[1-9][0-9]*$/).optional().describe(
      'dryRun + retained reviewPreviewPost only: later non-empty local verification evidence on that thread. After an ended reviewer objection, requests an independent re-review of the unchanged preview; retries reuse that review.',
    ),
    reviewerModel: z.object({
      agent: z.enum(['claude', 'codex', 'omp']),
      model: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    }).strict().optional().describe(
      'Review backend/model and optional effort; required with reviewPreviewPost. Must match the workspace expert-model allowlist; unavailable pairs are refused, never substituted.',
    ),
    criteria: z
      .array(amendmentCriterionSchema)
      .min(1)
      .max(200)
      .optional()
      .describe(
        'acceptance-kind only: atomically replace the full set; read rubrics:get and resubmit all stored criteria. Prefer structured acceptance/verification; legacy aliases must match or fail requirement_alias_conflict.',
      ),
    criterionEvidencePlane: z
      .object({ key: z.string().min(1), evidencePlane: z.enum(['tree', 'deployed', 'live']) })
      .optional()
      .describe(
        "Set a criterion's evidence plane through the BAR amendment transaction.",
      ),
    criterion: z
      .object({
        key: z.string().min(1).describe('the criterion key (must exist — keys are identity, not amendable)'),
        field: z.enum(AMENDABLE_CRITERION_FIELDS).describe('which prose field to patch'),
        mode: z
          .enum(['append', 'replace'])
          .describe(
            "'append' adds text as a new paragraph (never guarded); 'replace' swaps the whole field (shrink-guarded)",
          ),
        text: z.string().min(1).max(20000).describe('the text to append / the full replacement text'),
      })
      .optional()
      .describe('patch one criterion field'),
    criterionClass: z
      .object({
        key: z.string().min(1).describe('the criterion key (must exist)'),
        class: z.enum(['settle-once', 'violatable']),
      })
      .optional()
      .describe(
        "P-008 class update; upgrade-only. 'violatable' tightens grading and preserves status/ratifier; downgrades use rubrics:propose with classDowngradeReason.",
      ),
    methodRef: z
      .string()
      .max(200)
      .optional()
      .describe('Set the agent-insights runbook slug for the rubric method.'),
    classRef: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Bind a missing class or repeat it, preserving BARs/criteria. With a reason, general/investigation may strengthen to coding; prior class/compositions remain. Other replacements are refused.',
      ),
    composes: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(16)
      .optional()
      .describe(
        'Replace unpinned refs with existing standard rubric IDs; omit to preserve. Revision pins are unsupported.',
      ),
    allowMethodShrink: z
      .boolean()
      .optional()
      .describe(
        "loss-guard ack for mode:'replace' that shrinks a procedure >40% or drops its REPLICATION DRILL marker; requires shrinkReason",
      ),
    shrinkReason: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('why the shrink is intentional (required with allowMethodShrink)'),
    reason: z
      .string()
      .min(1)
      .max(4000)
      .optional()
      .describe('reason for a started-BAR meaning amendment; recorded on the subject-plan Decision'),
    expectedRubricRevision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('optimistic CAS for the acceptance-rubric plan revision'),
    expectedSubjectPlanRevision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('optimistic CAS for the subject-plan revision'),
    idempotencyKey: z.string().min(1).max(200).optional().describe('stable replay token for a started-BAR amendment'),
    restoreOrphanedBarContract: z
      .literal(true)
      .optional()
      .describe('BAR recovery: restore an orphaned started contract from the subject-pinned rubric revision snapshot'),
    barMappingDelta: z
      .array(acceptanceBarMappingDeltaEntrySchema)
      .min(1)
      .max(50)
      .optional()
      .describe('move an unchanged BAR\'s Bar-to-work row: {barKey, prior:{planItemIds,evidencePlane} = locked row, next}; needs outside approval'),
    approvalRef: z
      .string()
      .min(1)
      .max(240)
      .optional()
      .describe(
        'thread-post:<id> of an authenticated outside-lineage reviewer with preview approval JSON. It authorizes a patch, not its fields; include an amendment field.',
      ),
    approvedBy: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Optional reviewer identity assertion; must match the approval post author. dryRun eligibility is diagnostic; routed review screens candidates. approvedBy=caller yields selfScreen:true/eligible:null (no verdict); relatedVia=caller needs an unrelated applier (WI-10002357).',
      ),
    approvedAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('legacy hint; authoritative approval time is always read from the post'),
    // No faultInjection arg: the rollback probe is test-only and lives on the lib input
    // (AmendRubricInput.faultInjection) where the integration tests call it directly
    // (WI-6554700010018783).
  }),
  (args, ctx) => {
    if (args.requirement && (args.criteria || args.criterion || args.criterionClass || args.criterionEvidencePlane)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requirement'],
        message: 'requirement amendment cannot be combined with other criterion patches',
      });
    }
    if (args.criteria && (args.criterion || args.criterionClass || args.criterionEvidencePlane)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        message:
          'criteria is the complete replacement set and cannot be combined with criterion, criterionClass, or criterionEvidencePlane patches',
      });
    }
    const hasPatch =
      args.requirement !== undefined ||
      args.criteria !== undefined ||
      args.criterionEvidencePlane !== undefined ||
      args.criterion !== undefined ||
      args.criterionClass !== undefined ||
      args.methodRef !== undefined ||
      args.classRef !== undefined ||
      args.composes !== undefined ||
      args.restoreOrphanedBarContract !== undefined ||
      args.barMappingDelta !== undefined;
    if (!hasPatch) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message:
          'nothing to amend — include at least one amendment field; approvalRef authorizes a patch but does not supply one',
      });
    }
    if (args.reviewPreviewPost !== undefined && args.dryRun !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewPreviewPost'],
        message: 'reviewPreviewPost opens the review for a preview, so it requires dryRun:true',
      });
    }
    if (args.requestReview !== undefined && args.dryRun !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestReview'],
        message: 'requestReview opens the review for a preview, so it requires dryRun:true',
      });
    }
    if (args.requestReview !== undefined && args.reviewPreviewPost !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestReview'],
        message: 'pass requestReview (the server posts the preview) or reviewPreviewPost (your own post), not both',
      });
    }
    if (args.reviewerModel && !args.reviewPreviewPost && !args.requestReview) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reviewerModel'],
        message: 'reviewerModel requires dryRun:true and reviewPreviewPost or requestReview' });
    }
    if (args.reviewEvidencePost && (!args.reviewPreviewPost || args.dryRun !== true)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reviewEvidencePost'],
        message: 'reviewEvidencePost requires dryRun:true and the retained reviewPreviewPost' });
    }
  },
);

export default defineTool({
  name: 'rubrics:amend',
  profile: 'engineer',
  description:
    'Patch a rubric criterion/requirement, acceptance criteria, evidence plane, or refs; include an amendment field (approvalRef alone is not a patch). Use rubrics:propose for standard criterion/key/rating changes. Started BAR meaning changes require outside-lineage approval (see chaining).',
  guidance: {
    returns:
      "The subject Decision, BAR/spec revisions, and rebind commit atomically; prior proof and grades remain history; the shrink guard applies. { ok, rubric, completeness, replicationSqlCheck, methodLint, idempotencyKey }. methodLint is a non-blocking advisory for acceptance methods that prescribe native shell commands (judges cannot run shell; MCP tools such as testing:run stay valid). Missing live BAR mapping (`acceptance_bar_amendment_no_live_discharge_mapping`), invalid BAR contract fields (`acceptance_bar_amendment_test_layers_missing`, `acceptance_bar_amendment_test_layer_unrecordable`, `acceptance_bar_amendment_check_layer_mismatch`), required outside-lineage approval (`acceptance_bar_approval_required`), and unavailable reviewer models (`reviewer_model_not_allowed`) return { ok:false, code, error, next } as domain refusals and make no write. An amend or dry-run preview still running after ~40s returns { ok:true, pending:true, receipt } instead of timing out: the work continues server-side; poll rubrics:amend-status { rubricRef, idempotencyKey } and do not re-issue while it reads running. A dry run with reviewPreviewPost adds review { state, conversationId, previewPostRef, screenedOut, next }. The resolver loads the immutable preview in the same workspace and checks every changed BAR hash against the current delta; authorship/time come from the reviewer post.",
    when: 'A targeted acceptance-BAR change, evidence-plane binding, or rubric-ref update.',
    notWhen:
      'For standard rubric criteria, key, or rating changes use rubrics:propose. Complete `criteria` is acceptance-only and must preserve stored keys unless removal is explicitly allowed.',
    chaining:
      "Started BAR: read the subject plan's `## Requirements`/`## Design`; map changes to a non-dropped P-NNN item in `### Bar-to-work map for this plan` (removals exempt). Prefer `dryRun:true, requestReview:{workItemId}` to post approval and start review in one call. Manual compatibility: post preview.approval via work_items:comment (a thread post is readable on every surface; a payload needs payloadTier) and pass `reviewPreviewPost:'thread-post:<preview-id>'`. Follow review.next; after `approve thread-post:<preview-post-id>`, apply the same patch with `approvalRef:'thread-post:<answer-id>'`. Large previews return an approvalRef/receipt. The relevance router chooses the outside-lineage reviewer; never pick or message one yourself; do not create a counter-sign work-item. Posts are immutable workspace/id refs (no hash transcription). Full contract: /internal/docs/agent-insights/unified-requirement-contract.",
    seeAlso: [
      'rubrics:propose (whole-document revision)',
      'rubrics:get (read before amending)',
      'work_items:comment (post the exact approval JSON as a Threadable body)',
      'conversations:get (find the routed reviewer answer post id)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  abortCompletionReceipt: amendAbortCompletionReceipt,
  args: rubricsAmendArgs,
  shape: {
    standard: shapeAmendReviewPayload,
    trimmed: shapeAmendReviewPayload,
  },
  // Structural shape behind `guidance.returns` (guidance-output-schema-live-guard).
  // OPEN on purpose: the dry-run, applied and receipt arms carry different fields.
  result: z
    .object({
      ok: z.boolean(),
      error: z.string().optional(),
      code: z.string().optional(),
      next: z.string().optional(),
      dryRun: z.boolean().optional(),
      rubric: z.record(z.string(), z.unknown()).optional(),
      completeness: z.record(z.string(), z.unknown()).optional(),
      preview: z.record(z.string(), z.unknown()).optional(),
      review: z
        .object({
          state: z.string(),
          conversationId: z.string().nullable().optional(),
          previewPostRef: z.string().optional(),
          next: z.string(),
        })
        .passthrough()
        .optional(),
      replicationSqlCheck: z.unknown().optional(),
      methodLint: z.array(z.record(z.string(), z.unknown())).optional(),
      idempotencyKey: z.string().optional(),
      pending: z.boolean().optional(),
      receipt: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const foregroundDeadline = Math.min(
      Date.now() + amendForegroundBudgetMs(),
      ctx.deadlineAtMs === undefined ? Infinity : ctx.deadlineAtMs - 1_000,
    );
    const remainingBudget = () => Math.max(0, foregroundDeadline - Date.now());
    // ⚠ DO NOT pass `by: id.ownerId` here. AMENDING IS NOT AUTHORING (EI-10746 follow-on,
    // 2026-07-12). A rubric persists as a PLAN, and a plan has ONE `owner` — so
    // planRowToRubric projects createdBy AND proposedBy AND ratifiedBy from that single
    // field (rubrics.ts:213-215). Forcing `by` to the caller therefore silently TRANSFERS
    // AUTHORSHIP of the rubric to whoever amends it.
    //
    // That is not cosmetic: D-012 requires a NON-AUTHOR to ratify. So a reviewer who
    // improves a rubric before ratifying it — exactly the diligent path — becomes its
    // recorded author, and their ratification is silently converted into the
    // SELF-RATIFICATION the rule exists to forbid. The act of reviewing well disqualified
    // the reviewer. Observed live: a non-author ratifier amended blender-release-readiness
    // and instantly became its createdBy/proposedBy, erasing su-eb9b7ae3.
    //
    // amendRubric already does the right thing on its own (`input.by ?? stored.createdBy`,
    // rubrics.ts:801) — that fallback preserves the original author. It was simply DEAD,
    // because this wrapper always supplied `by`. Omitting it lets the guard actually run.
    //
    // Who amended is not lost: per D-002 the plan's revision spine carries the edit history.
    // (The deeper defect — that proposedBy/ratifiedBy are unrepresentable because all three
    // identities collapse onto plan.owner, making D-012 unauditable — is tracked separately.)
    const identity = resolveAgentIdentity(ctx); // authz/identity side-effects + a clear failure if unidentified
    const input: AmendRubricInput = {
      rubricId: args.rubricRef,
      ...(args.requirement ? { requirement: args.requirement } : {}),
      ...(args.criteria ? { criteria: args.criteria } : {}),
      ...(args.criterion ? { criterion: args.criterion } : {}),
      ...(args.criterionClass ? { criterionClass: args.criterionClass } : {}),
      ...(args.criterionEvidencePlane ? { criterionEvidencePlane: args.criterionEvidencePlane } : {}),
      ...(args.methodRef !== undefined ? { methodRef: args.methodRef } : {}),
      ...(args.classRef !== undefined ? { classRef: args.classRef } : {}),
      ...(args.composes !== undefined ? { composes: args.composes } : {}),
      ...(args.allowMethodShrink !== undefined ? { allowMethodShrink: args.allowMethodShrink } : {}),
      ...(args.shrinkReason !== undefined ? { shrinkReason: args.shrinkReason } : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      ...(args.expectedRubricRevision !== undefined ? { expectedRubricRevision: args.expectedRubricRevision } : {}),
      ...(args.expectedSubjectPlanRevision !== undefined
        ? { expectedSubjectPlanRevision: args.expectedSubjectPlanRevision }
        : {}),
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      ...(args.restoreOrphanedBarContract ? { restoreOrphanedBarContract: true } : {}),
      ...(args.barMappingDelta ? { barMappingDelta: args.barMappingDelta } : {}),
      ...(args.approvalRef !== undefined ? { approvalRef: args.approvalRef } : {}),
      ...(args.approvedBy !== undefined ? { approvedBy: args.approvedBy } : {}),
      ...(args.approvedAt !== undefined ? { approvedAt: args.approvedAt } : {}),
      checkPathRoot: resolveAgentWorkspaceRoot(ctx),
      actorId: identity.ownerId,
    };
    if (args.dryRun) {
      const previewSource =
        args.reviewPreviewPost ??
        (args.requestReview
          ? `request:${args.requestReview.harness ?? ''}:${args.requestReview.workItemId}`
          : undefined);
      const receiptKey = previewSource
        ? await reviewReceiptKey(args, identity, previewSource)
        : 'preview-' + randomUUID();
      let registered = false;
      let progress: { phase: string; phaseStartedAt: number } | undefined;
      const receipt = (includeProgress = false) => ({
        idempotencyKey: receiptKey, rubricRef: args.rubricRef, registered,
        poll: { tool: 'rubrics:amend-status', args: { rubricRef: args.rubricRef, idempotencyKey: receiptKey } },
        // A foreground snapshot; shared status carries its separately published
        // observation. Never refresh a retained snapshot's timestamp on replay.
        ...(includeProgress && progress ? { progress: { ...progress, observedAt: Date.now() } } : {}),
      });
      // notify-classification: {"classification":"durable","reason":"Tracked amendment preview can request an independent review; preserve that terminal handoff obligation through this wrapper.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
      const run = guardAmendRun(ctx, () => trackAmendRun(receiptKey, args.rubricRef, async (onPhase): Promise<Record<string, unknown>> => {
        const reportPhase = (phase: string) => {
          onPhase(phase);
          progress = { phase, phaseStartedAt: Date.now() };
        };
        // A preview must enforce the same instrument admission as apply before
        // spending a reviewer turn on a patch the authoring guard will refuse.
        reportPhase('preview-instrument-audit');
        const instrumentAudit = await auditAmendInstrumentBindings(input);
        const instrumentRefusal = instrumentAudit ? unregisteredInstrumentRefusal(instrumentAudit) : null;
        if (instrumentRefusal) return { ...instrumentRefusal, dryRun: true };
        let preview: Awaited<ReturnType<typeof previewAcceptanceBarAmendment>>;
        try {
          reportPhase('preview-build');
          preview = await previewAcceptanceBarAmendment(input);
        } catch (error) {
          const refusal = rubricReadFailedRefusal(error, args.rubricRef) ??
            noLiveDischargeMappingRefusal(error) ?? acceptanceBarContractRefusal(error);
          if (refusal) return { ...refusal, dryRun: true };
          throw error;
        }
        if (preview === null) {
          return {
            ok: false,
            dryRun: true,
            code: 'rubric_not_found',
            error: `no rubric '${args.rubricRef}' — rubrics:list to see refs`,
            rubricRef: args.rubricRef,
          };
        }
        // requestReview on a preview that needs no outside approval posts nothing.
        const wantsReview = Boolean(args.reviewPreviewPost) || (Boolean(args.requestReview) && preview.approvalRequired);
        if (!wantsReview) {
          return {
            ok: true,
            dryRun: true,
            preview,
            ...(preview.approvalRequired ? { review: { state: 'not-requested', next: REVIEW_NOT_REQUESTED_NEXT } } : {}),
          };
        }
        if (!identity.workspaceId) {
          throw new Error('acceptance_bar_amendment_review_unscoped: a routed review needs a concrete workspace identity');
        }
        let previewPostRef = args.reviewPreviewPost;
        if (!previewPostRef && args.requestReview) {
          reportPhase('preview-post-approval');
          const posted = await postPreviewApproval(args.requestReview, preview.approval, identity);
          if (!('ref' in posted)) return { ...posted, dryRun: true, preview };
          previewPostRef = posted.ref;
        }
        let review: Awaited<ReturnType<typeof openAcceptanceBarAmendmentReview>>;
        try {
          review = await openAcceptanceBarAmendmentReview({
            onPhase: reportPhase,
            rubricRef: args.rubricRef,
            previewPostRef: previewPostRef!,
            preview,
            ...(args.reason ? { reason: args.reason } : {}),
            patch: amendmentPatch(args),
            identity,
            workspaceId: identity.workspaceId,
            // WI-10003299: a fresh-reviewer launch reuses this call's context,
            // re-attributed to the review's system principal.
            launchCtx: ctx,
            ...(args.reviewerModel ? { reviewerModel: args.reviewerModel } : {}),
            ...(args.reviewEvidencePost ? { reviewEvidencePost: args.reviewEvidencePost } : {}),
          });
        } catch (error) {
          const refusal = reviewerModelNotAllowedRefusal(error);
          if (refusal) return { ...refusal, dryRun: true };
          throw error;
        }
        return { ok: true, dryRun: true, preview, review };
      }, {
        onRegistered: () => { registered = true; },
        persistPhaseProgress: true,
        omittedReviewRecovery: { ownerId: identity.ownerId, retryArgs: { ...args } },
      }));
      const settled = await settleWithin(run, remainingBudget(), ctx.signal);
      if (settled.kind === 'rejected') {
        const refusal = proposeRubricInvalidArgsRefusal(settled.error) ?? acceptanceBarContractRefusal(settled.error);
        if (refusal) return { data: { ...refusal, dryRun: true } };
        throw settled.error;
      }
      const payload = settled.kind === 'resolved'
        ? (settled.value.ok === true ? { ...settled.value, receipt: receipt() } : settled.value)
        : {
            ok: true,
            dryRun: true,
            pending: true,
            idempotencyKey: receiptKey,
            receipt: receipt(true),
            note:
              'The preview reached its foreground response deadline and continues server-side. Poll rubrics:amend-status with this receipt; dryRun does not apply the amendment.',
          };
      return { data: payload };
    }
    // RSR-P-008-C: hold a receipt BEFORE the work starts. An amend that outlives
    // the foreground budget returns that receipt instead of letting the transport
    // time out with an unknown commit state; the work keeps running and its outcome
    // is readable through rubrics:amend-status. A caller-supplied key is kept as-is;
    // a minted one is deterministic, so a re-issued identical request still replays.
    const idempotencyKey =
      input.idempotencyKey ?? mintAmendmentIdempotencyKey(input, (await getRubric(args.rubricRef))?.revision);
    let registered = false;
    const receipt = () => ({
      idempotencyKey, rubricRef: args.rubricRef, registered,
      poll: { tool: 'rubrics:amend-status', args: { rubricRef: args.rubricRef, idempotencyKey } },
    });
    const run = guardAmendRun(ctx, () => trackAmendRun(
      idempotencyKey,
      args.rubricRef,
      (onPhase) => executeAmend({ ...input, idempotencyKey, onPhase }, args.rubricRef),
      {
        onRegistered: () => { registered = true; },
        persistPhaseProgress: true,
        persistProgressForPhase: (phase) => APPLY_RECEIPT_PROGRESS_PHASES.has(phase),
      },
    ));
    const settled = await settleWithin(run, remainingBudget(), ctx.signal);
    if (settled.kind === 'rejected') throw settled.error;
    const payload =
      settled.kind === 'resolved'
        ? { ...settled.value, idempotencyKey, receipt: receipt() }
        : {
            ok: true,
            pending: true,
            idempotencyKey,
            receipt: receipt(),
            note:
              'The amendment reached its foreground response deadline and continues ' +
              'server-side. Poll rubrics:amend-status with this receipt; do not re-issue the amend while it reads running.',
          };
    return { data: payload };
  },
});

/** RSR-P-008-C: how long the handler waits before answering with a receipt.
 *  Well under the 55s MCP transport deadline so the receipt always wins the
 *  race. Overridable for tests through the env var. */
export const AMEND_FOREGROUND_BUDGET_MS = 40_000;

function amendForegroundBudgetMs(): number {
  const override = Number(process.env.PAPERCUSP_RUBRICS_AMEND_FOREGROUND_MS);
  return override > 0 ? override : AMEND_FOREGROUND_BUDGET_MS;
}

type Settled<T> = { kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'pending' };

/** Wait up to `budgetMs` for `run`. On `pending`, `run` keeps going; its
 *  rejection is already observed by trackAmendRun's receipt, so it is swallowed
 *  here rather than surfacing as an unhandled rejection. */
async function settleWithin<T>(run: Promise<T>, budgetMs: number, signal?: AbortSignal): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const pending = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'pending' }), budgetMs);
    onAbort = () => resolve({ kind: 'pending' });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  const outcome = run.then(
    (value): Settled<T> => ({ kind: 'resolved', value }),
    (error: unknown): Settled<T> => ({ kind: 'rejected', error }),
  );
  try {
    return await Promise.race([outcome, pending]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * P-005 (plan D-006): audit the instrument bindings the amendment would leave, against the
 * stored revision. Null when there is no stored rubric or the amendment does not apply — the
 * real amend reports that input error itself, so this pre-check never masks it.
 */
async function auditAmendInstrumentBindings(input: AmendRubricInput): Promise<InstrumentBindingAudit | null> {
  const stored = await getRubric(input.rubricId);
  if (!stored) return null;
  let amendedCriteria: ReturnType<typeof applyRubricAmendment>['criteria'];
  try {
    amendedCriteria = applyRubricAmendment(stored, input).criteria;
  } catch {
    return null;
  }
  return auditInstrumentBindings({ prior: stored.criteria, next: amendedCriteria });
}

/** The synchronous amend: apply, then build the response payload. */
async function executeAmend(input: AmendRubricInput, rubricRef: string): Promise<Record<string, unknown>> {
  // test-rubric-unification-2026-10-12 P-005 (plan D-006): the amended criteria may not bind a
  // NEW or CHANGED unregistered instrument; a key carried unchanged is grandfathered.
  input.onPhase?.('instrument-bindings');
  const instrumentAudit = await auditAmendInstrumentBindings(input);
  const instrumentRefusal = instrumentAudit ? unregisteredInstrumentRefusal(instrumentAudit) : null;
  if (instrumentRefusal) return instrumentRefusal;
  let rubric: Awaited<ReturnType<typeof amendRubric>>;
  try {
    rubric = await amendRubric(input);
  } catch (error) {
    const refusal =
      rubricReadFailedRefusal(error, rubricRef) ??
      noLiveDischargeMappingRefusal(error) ??
      acceptanceBarContractRefusal(error) ??
      acceptanceBarApprovalRequiredRefusal(error) ??
      proposeRubricInvalidArgsRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
  if (!rubric) return { ok: false, error: `no rubric '${rubricRef}' — rubrics:list to see refs` };
  input.onPhase?.('response-validation');
  const completeness = rubricCompleteness(rubric);
  // EI-10514: schema-validate embedded replication-drill SQL against live PG (non-blocking).
  const replicationSqlCheck = await validateRubricReplicationSql(rubric.criteria);
  const methodLint = rubric.kind === 'acceptance' ? await lintAcceptanceMethods(rubric.criteria, rubric.subjectHarnessSlug ?? undefined) : [];
  // acceptance-runtime-plane P-004: same non-blocking vetting finding as rubrics:propose.
  const runtimeFindings = rubric.kind === 'acceptance' ? runtimeVettingFindings(rubric.criteria) : [];
  // Push-on-write (push-audit 2026-07-26): the Rubrics pane + trend read these.
  void trackDetached(import('../../sync-sse'))
    .then((m) => {
      m.notifySyncInvalidate('rubrics.list');
      m.notifySyncInvalidate('rubrics.trend');
    })
    .catch(() => {});
  return {
    ok: true,
    rubric,
    completeness,
    replicationSqlCheck,
    methodLint,
    ...(runtimeFindings.length ? { runtimeFindings } : {}),
  };
}
