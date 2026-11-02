/**
 * plans:blind-review — the blind gap review surface
 * (verification-system-improvements-2026-10-10 P-006, D-006, D-039).
 *
 * The ONLY plans:* tool a blind reviewer may call on the plan it reviews: the door's
 * ledger probe (blind-review-gate.ts firstArtifactRead) ignores this tool and counts
 * every other plans:/rubrics:/scorecards:/acceptance: call naming the slug as a read
 * of the plan's artifacts. So it must never return plan text: `brief` returns only the
 * owner's own turns (blind-review-brief.ts), `post` and `dispose` return ids and codes.
 *
 * A separate tool rather than new plans:audit phases because audit.ts is bound proof
 * source for other plans' clauses (D-039 (2), revised).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { resolvePlanScope } from './source';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  evaluateBlindReviewGate,
  loadBlindReviewBrief,
  recordBlindGapDispositions,
  recordBlindReview,
  blindReviewSummaryOutcome,
} from '../../blind-review-gate';
import { runBlindReviewMintOp } from './blind-review-mint-op';
import { archiveBlindReviewScratchPlans } from '../../blind-review-scratch-plans';
import { resumeBlindGapReviewer } from '../../blind-reviewer-mint';
import { replaceBlindGapReviewer } from '../../blind-review-replacement';
import {
  findLatestBlindReviewSessionBindingByReviewer,
  recordBlindReviewSessionPost,
  verifyBlindReviewSessionBinding,
} from '../../blind-review-session-bindings';
import { blindReviewPostedEventKey } from '../../blind-review-post-event';

const text =(payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

const dispositionSchema = z.object({
  reviewId: z.number().int().positive(),
  gapId: z.string().regex(/^G-\d+$/),
  itemId: z.string().regex(/^P-\d{3,}$/).optional().describe('A non-dropped plan item that now carries the gap.'),
  acceptedRiskDecisionId: z.string().regex(/^D-\d{3,}$/).optional().describe('A Decision recording the gap as an accepted risk.'),
}).refine((d) => (d.itemId === undefined) !== (d.acceptedRiskDecisionId === undefined), {
  message: 'exactly one of itemId or acceptedRiskDecisionId',
});

export default defineTool({
  name: 'plans:blind-review',
  description:
    "Blind gap review before acceptance. op 'brief' returns the owner's source turns only; 'mint' launches a confined reviewer; 'resume' recovers that exact reviewer; 'replace' recruits an independent replacement for an ended, posted inconclusive review while preserving its history; 'post' records the reviewer's outcome; 'dispose' maps gaps to plan items or accepted risks.",
  guidance: {
    when: "A plan is refused with blind_review_missing or blind_review_gap_undispositioned, or you were asked to blind-review a plan you have not read.",
    notWhen: 'Reading the plan (plans:get). A reviewer who already read the plan, its specs, rubric or evidence: its post will not count.',
    chaining:
      "author: op 'mint' { howToRun }. If the exact reviewer session ends, the recruiter uses op 'resume' to recover it in place. reviewer: op 'brief' → run the product → op 'post' { activationAuditSeq, outcome, gaps }. Use inconclusive when product access or verification is incomplete. author: op 'dispose' { dispositions } → the drain moves the plan to awaiting-acceptance.",
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: z.object({
    harness: harnessArg,
    slug: z.string().min(1).describe('The plan under review.'),
    op: z.enum(['brief', 'post', 'dispose', 'mint', 'resume', 'replace']),
    howToRun: z.string().max(4000).optional().describe('mint/replace: how the reviewer runs the product.'),
    productReads: z.object({
      docsHarness: z.string().min(1).max(120).optional(),
      docsSlugs: z.array(z.string().min(1).max(1000)).max(10).optional(),
      testFiles: z.array(z.string().min(1).max(1000)).max(20).optional(),
    }).strict().optional().describe('mint/replace: exact maintained product doc slugs and test files. replace persists this corrected manifest immutably for the authenticated request. No plan artifacts or proof IDs.'),
    activationAuditSeq: z.number().int().positive().optional().describe("post/replace: the exact current activationAuditSeq."),
    sourceReviewId: z.number().int().positive().optional().describe('replace: exact original inconclusive material receipt.'),
    requestKey: z.string().trim().min(1).max(200).optional().describe('mint/replace: stable identity for this authenticated request. Repeat it to reconcile; use a new key only after a confirmed no-process failure.'),
    gaps: z.array(z.object({ text: z.string().min(1).max(4000) })).max(100).optional().describe('post: one entry per gap; [] when none.'),
    dispositions: z.array(dispositionSchema).min(1).max(200).optional().describe('dispose: one per gap.'),
    summary: z.string().max(4000).optional(),
    outcome: z.enum(['conclusive', 'inconclusive']).optional().describe('post: conclusive only after completing the product review; inconclusive when access or verification is incomplete. Empty gaps alone are not completion.'),
  }).superRefine((args, ctx) => {
    if (args.op === 'replace') {
      for (const key of ['sourceReviewId', 'requestKey', 'activationAuditSeq', 'productReads'] as const) {
        if (args[key] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required for op 'replace'` });
      }
    } else {
      if (args.sourceReviewId !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceReviewId'], message: "sourceReviewId is op 'replace' only" });
      }
      if (args.op !== 'mint' && args.requestKey !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requestKey'], message: "requestKey is op 'mint' or 'replace' only" });
      }
    }
    if (args.op === 'post' && args.outcome === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outcome'], message: "outcome is required for op 'post'" });
    }
    if (args.op !== 'post' && args.outcome !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outcome'], message: "outcome is op 'post' only" });
    }
    const marker = blindReviewSummaryOutcome(args.summary);
    if (args.op === 'post' && marker && args.outcome && marker !== args.outcome) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outcome'], message: 'summary verdict contradicts outcome' });
    }
    if (args.op === 'post' && args.gaps === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gaps'], message: "gaps is required for op 'post' ([] when none)" });
    }
    if (args.op === 'dispose' && args.dispositions === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dispositions'], message: "dispositions is required for op 'dispose'" });
    }
    if (args.op !== 'post' && args.gaps !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gaps'], message: "gaps is op 'post' only" });
    }
    if (args.op !== 'dispose' && args.dispositions !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dispositions'], message: "dispositions is op 'dispose' only" });
    }
    if (args.op !== 'mint' && args.op !== 'replace' && args.howToRun !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['howToRun'], message: "howToRun is op 'mint' or 'replace' only" });
    }
    if (args.op !== 'mint' && args.op !== 'replace' && args.productReads !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['productReads'], message: "productReads is op 'mint' or 'replace' only" });
    }
    if (args.op !== 'post' && args.op !== 'replace' && args.activationAuditSeq !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activationAuditSeq'], message: "activationAuditSeq is op 'post' or 'replace' only" });
    }
  }),
  async handler(args, ctx) {
    const opts = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
    const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
    const scope = { workspaceId, planSlug: args.slug, harnessSlug };

    if (args.op === 'replace') {
      const result = await replaceBlindGapReviewer({ workspaceId, harness: harnessSlug, slug: args.slug,
        activationAuditSeq: args.activationAuditSeq!, sourceReviewId: args.sourceReviewId!,
        requestKey: args.requestKey!, productReads: args.productReads!, howToRun: args.howToRun,
        ctx: { ...(ctx as unknown as Record<string, unknown>), workspaceId } });
      return text(result, result.ok !== true);
    }

    if (args.op === 'brief') {
      const brief = await loadBlindReviewBrief(scope);
      if (!brief) {
        return text({ error: 'no_activation_audit', slug: args.slug, message: 'the plan has no activation audit to brief a blind review from' }, true);
      }
      return text({
        ok: true,
        slug: args.slug,
        activationAuditSeq: brief.activationAuditSeq,
        ownerTurnCount: brief.ownerTurns.length,
        unverifiedTurnCount: brief.unverifiedTurns.length,
        excludedRefs: brief.excludedRefs,
        brief: brief.text,
      });
    }

    if (args.op === 'mint') {
      // D-041/D-042: launches a fresh reviewer confined to the blind-review tool ceiling.
      const minted = await runBlindReviewMintOp({
        slug: args.slug,
        harness: harnessSlug,
        workspaceId,
        howToRun: args.howToRun,
        requestKey: args.requestKey,
        productReads: args.productReads,
        ctx: ctx as unknown as Record<string, unknown>,
      });
      return text(minted.payload, minted.isError);
    }

    if (args.op === 'resume') {
      let recruiterOwnerId: string;
      try {
        recruiterOwnerId = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId;
      } catch {
        return text({ error: 'identity_unresolved', slug: args.slug, message: 'A reviewer recovery needs an attributable recruiter.' }, true);
      }
      const resumed = await resumeBlindGapReviewer({
        slug: args.slug, harness: harnessSlug, recruiterOwnerId,
        ctx: { ...(ctx as unknown as Record<string, unknown>), workspaceId },
      });
      if (!resumed.ok) return text({ error: resumed.code, slug: args.slug, message: resumed.message }, true);
      return text({
        ok: true, slug: args.slug, op: 'resume', activationAuditSeq: resumed.activationAuditSeq,
        reviewerOwnerId: resumed.reviewerOwnerId, leaseReleased: resumed.leaseReleased, launch: resumed.launch,
        // R-2: the exact key the recovered reviewer's post fires — await it, never construct it.
        bindingId: resumed.bindingId, awaitKey: blindReviewPostedEventKey(args.slug, resumed.bindingId),
      });
    }

    let createdBy: string;
    try {
      createdBy = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId;
    } catch {
      return text({ error: 'identity_unresolved', slug: args.slug, message: 'a blind review record needs an attributable caller' }, true);
    }
    let reviewerBinding: Awaited<ReturnType<typeof findLatestBlindReviewSessionBindingByReviewer>> = null;
    if (args.op === 'post') {
      try {
        reviewerBinding = await findLatestBlindReviewSessionBindingByReviewer({
          workspaceId, planSlug: args.slug, reviewerOwnerId: createdBy,
        });
      } catch (error) {
        return text({ error: 'session_binding_unavailable', slug: args.slug,
          message: error instanceof Error ? error.message : String(error) }, true);
      }
      if (reviewerBinding) {
        if (args.activationAuditSeq !== undefined && args.activationAuditSeq !== reviewerBinding.activationAuditSeq) {
          return text({ error: 'stale_activation_audit', slug: args.slug,
            message: 'This reviewer session is bound to a different activation audit.' }, true);
        }
        if (reviewerBinding.status === 'closed' || reviewerBinding.status === 'failed') {
          return text({ error: 'review_session_closed', slug: args.slug,
            message: 'This reviewer session is no longer allowed to post.' }, true);
        }
        const verified = await verifyBlindReviewSessionBinding(reviewerBinding);
        if (!verified.ok) return text({ error: verified.code, slug: args.slug, message: verified.message }, true);
      }
    }

    const written = args.op === 'post'
      ? await recordBlindReview({ ...scope, createdBy, gaps: args.gaps ?? [],
          activationAuditSeq: reviewerBinding?.activationAuditSeq ?? args.activationAuditSeq, summary: args.summary, outcome: args.outcome! })
      : await recordBlindGapDispositions({ ...scope, createdBy, dispositions: args.dispositions ?? [], summary: args.summary });
    if (!written.ok) return text({ error: written.code, slug: args.slug, message: written.message }, true);
    if (args.op === 'post' && reviewerBinding) {
      let receiptRecorded = false;
      try {
        receiptRecorded = await recordBlindReviewSessionPost({
          workspaceId, planSlug: args.slug, activationAuditSeq: written.activationAuditSeq,
          reviewerOwnerId: createdBy, reviewId: written.id,
        });
      } catch {
        receiptRecorded = false;
      }
      if (!receiptRecorded) return text({ error: 'review_session_receipt_pending', slug: args.slug, id: written.id,
        message: 'The review is saved idempotently, but its session receipt did not persist. Retry the same post; do not mint or repost with a new session.' }, true);
    }

    if (args.op === 'post' && reviewerBinding) {
      // awaitable-review-post-events-2026-10-27 R-1: a post is observable only after both
      // the review and its session receipt persist, and only on the poster's OWN binding
      // key. Events latch, so a per-plan key would wake a later reviewer's waiter on an
      // earlier review. An unbound post has no recruiter waiting on a key, so it emits
      // nothing. This signals a posted review, not that the acceptance door passed.
      // Best-effort: an emit failure never voids the recorded review.
      const bindingId = reviewerBinding.id;
      await import('../../events/await/engine').then(({ emitAwaitedEvent }) => emitAwaitedEvent({
        key: blindReviewPostedEventKey(args.slug, bindingId),
        workspaceId,
        source: createdBy,
        summary: `Blind review ${written.id} posted for ${args.slug} (${args.outcome})`,
        payload: { slug: args.slug, harness: harnessSlug, bindingId, reviewId: written.id,
          activationAuditSeq: written.activationAuditSeq, reviewerOwnerId: createdBy, outcome: args.outcome },
      })).catch(() => {});
    }

    // D-050 (5): the reviewer's scratch plans are done with once its gaps are recorded.
    // Best-effort: a cleanup failure is reported and never voids the recorded review.
    let scratchPlans: Record<string, unknown> | null = null;
    if (args.op === 'post') {
      try {
        scratchPlans = await archiveBlindReviewScratchPlans({ workspaceId, ownerId: createdBy });
      } catch (e) {
        scratchPlans = { error: 'scratch_cleanup_failed', message: e instanceof Error ? e.message : String(e) };
      }
    }

    // Report the door's view now, so a reviewer learns at once whether its post counts.
    const verdict = await evaluateBlindReviewGate({ ...scope });
    const rejected = verdict.rejectedReviews.find((r) => r.reviewId === written.id);
    return text({
      ok: true,
      slug: args.slug,
      id: written.id,
      activationAuditSeq: written.activationAuditSeq,
      gapIds: written.gapIds,
      ...(args.op === 'post' ? { counts: verdict.acceptedReviewIds.includes(written.id), ...(rejected ? { rejected } : {}) } : {}),
      ...(scratchPlans ? { scratchPlans } : {}),
      door: { satisfied: verdict.satisfied, code: verdict.code ?? null, message: verdict.message ?? null },
    });
  },
});
