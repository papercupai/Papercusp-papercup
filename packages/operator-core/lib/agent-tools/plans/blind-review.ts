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
} from '../../blind-review-gate';
import { runBlindReviewMintOp } from './blind-review-mint-op';

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
    "Blind gap review before acceptance. op 'brief' returns the owner's source turns only (never plan text); op 'post' records the reviewer's gaps; op 'dispose' maps each gap to a plan item or an accepted-risk Decision; op 'mint' launches a fresh confined reviewer. Required before a plan reaches awaiting-acceptance and at ship.",
  guidance: {
    when: "A plan is refused with blind_review_missing or blind_review_gap_undispositioned, or you were asked to blind-review a plan you have not read.",
    notWhen: 'Reading the plan (plans:get). A reviewer who already read the plan, its specs, rubric or evidence: its post will not count.',
    chaining:
      "author: op 'mint' { howToRun }. reviewer: op 'brief' → run the product → op 'post' { gaps }. author: op 'dispose' { dispositions } → the drain moves the plan to awaiting-acceptance.",
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: z.object({
    harness: harnessArg,
    slug: z.string().min(1).describe('The plan under review.'),
    op: z.enum(['brief', 'post', 'dispose', 'mint']),
    howToRun: z.string().max(4000).optional().describe('mint: how the reviewer runs the product.'),
    productReads: z.object({
      docsHarness: z.string().min(1).max(120).optional(),
      docsSlugs: z.array(z.string().min(1).max(1000)).max(10).optional(),
      testFiles: z.array(z.string().min(1).max(1000)).max(20).optional(),
    }).strict().optional().describe('mint: nominate exact maintained product doc slugs and test files for bounded raw history. No plan artifacts or proof IDs.'),
    activationAuditSeq: z.number().int().positive().optional().describe("post: the brief's activationAuditSeq."),
    gaps: z.array(z.object({ text: z.string().min(1).max(4000) })).max(100).optional().describe('post: one entry per gap; [] when none.'),
    dispositions: z.array(dispositionSchema).min(1).max(200).optional().describe('dispose: one per gap.'),
    summary: z.string().max(4000).optional(),
  }).superRefine((args, ctx) => {
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
    if (args.op !== 'mint' && args.howToRun !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['howToRun'], message: "howToRun is op 'mint' only" });
    }
    if (args.op !== 'mint' && args.productReads !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['productReads'], message: "productReads is op 'mint' only" });
    }
  }),
  async handler(args, ctx) {
    const opts = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
    const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
    const scope = { workspaceId, planSlug: args.slug, harnessSlug };

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
        productReads: args.productReads,
        ctx: ctx as unknown as Record<string, unknown>,
      });
      return text(minted.payload, minted.isError);
    }

    let createdBy: string;
    try {
      createdBy = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId;
    } catch {
      return text({ error: 'identity_unresolved', slug: args.slug, message: 'a blind review record needs an attributable caller' }, true);
    }

    const written = args.op === 'post'
      ? await recordBlindReview({ ...scope, createdBy, gaps: args.gaps ?? [], activationAuditSeq: args.activationAuditSeq, summary: args.summary })
      : await recordBlindGapDispositions({ ...scope, createdBy, dispositions: args.dispositions ?? [], summary: args.summary });
    if (!written.ok) return text({ error: written.code, slug: args.slug, message: written.message }, true);

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
      door: { satisfied: verdict.satisfied, code: verdict.code ?? null, message: verdict.message ?? null },
    });
  },
});
