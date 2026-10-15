/**
 * Public agent-review door over the existing work-item + Blender lifecycle.
 *
 * Identity is always caller-derived. Review pickup requires one concrete harness
 * and cannot select the submitter's own row; resubmission is accepted only from
 * the original submittedBy owner in the lifecycle core.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import type { AbortCompletionContext, AbortCompletionReceipt, ToolResult } from '@papercusp/tooldef';
import {
  adoptAgentReviewRevision,
  adoptNextAgentReviewRevision,
  claimAgentReview,
  claimNextAgentReview,
  resubmitAgentReview,
  type AgentReviewClaimNextDiagnostics,
} from '../../harness/improvements/agent-review';
import { readAgentReviewState } from '../../harness/improvements/agent-review-policy';
import type { WorkItem } from '../../work-items';
import { asRecord, completedResultPayload } from '../abort-completion-payload';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';
import { getClaimSpecRecord } from '../../scheduler/claim-spec-store';

function gradeHandoff(workItem: WorkItem | null) {
  const review = workItem ? readAgentReviewState(workItem.payload) : null;
  if (review?.status !== 'pending') return {};
  return {
    ledgerIdeaId: review.ledgerIdeaId,
    gradeWith: { ideaId: review.ledgerIdeaId },
  };
}

/**
 * A review pickup/resubmission can commit before its handler returns past the dispatch
 * deadline. Name the returned work-item/round so callers do not retry an already-landed
 * mutation. Claim misses fail closed: claim-next may heal or reconcile rows while scanning,
 * and a directed claim can heal an own-node origin before a later refusal.
 */
export function agentReviewAbortCompletionReceipt(
  args: unknown,
  result: ToolResult,
  _context: AbortCompletionContext,
): AbortCompletionReceipt {
  const input = asRecord(args);
  const payload = completedResultPayload(result);
  const mode = input?.mode;
  if (!payload || payload.ok !== true || payload.mode !== mode) {
    return {
      status: 'recovery-incomplete',
      reason: 'improvements:agent-review result did not confirm the requested mode and success envelope',
      failures: ['missing-success-envelope'],
    };
  }

  if (mode === 'claim' || mode === 'claim-next') {
    const workItem = asRecord(payload.workItem);
    const workItemId = workItem?.id;
    if (
      payload.claimed === true &&
      typeof workItemId === 'string' &&
      workItemId.trim().length > 0 &&
      (mode !== 'claim' || input?.id === workItemId)
    ) {
      return {
        status: 'recorded',
        effectRef: `improvements-agent-review:${mode}:${workItemId}`,
      };
    }

    // These two directed-claim exits happen before origin healing or any claim attempt.
    if (
      mode === 'claim' &&
      payload.claimed === false &&
      (payload.reason === 'not-found' || payload.reason === 'not-open')
    ) {
      return { status: 'not-recorded', reason: payload.reason };
    }

    return {
      status: 'recovery-incomplete',
      reason: 'claim refusal or queue miss may include lifecycle repair side effects and cannot safely invite a retry',
      failures: ['ambiguous-claim-outcome'],
    };
  }

  if (mode === 'adopt' || mode === 'adopt-next') {
    const workItemId = asRecord(payload.workItem)?.id;
    if (
      payload.adopted === true &&
      typeof workItemId === 'string' &&
      workItemId.trim().length > 0 &&
      (mode !== 'adopt' || input?.id === workItemId)
    ) {
      return { status: 'recorded', effectRef: `improvements-agent-review:${mode}:${workItemId}` };
    }
    // Every adoption refusal except 'state-changed' exits before or at a failed claim CAS,
    // so nothing landed; 'state-changed' may have claimed then released.
    const stateChanged = payload.reason === 'state-changed' ||
      (asRecord(payload.refusals)?.['state-changed'] ?? 0) !== 0;
    if (payload.adopted === false && !stateChanged) {
      return { status: 'not-recorded', reason: typeof payload.reason === 'string' ? payload.reason : 'no-adoptable-revision' };
    }
    return {
      status: 'recovery-incomplete',
      reason: 'adoption raced a lifecycle change and may have claimed then released the row',
      failures: ['ambiguous-adoption-outcome'],
    };
  }

  if (mode === 'resubmit') {
    const state = asRecord(payload.state);
    const itemId = input?.id;
    const round = state?.round;
    if (
      payload.resubmitted === true &&
      typeof itemId === 'string' &&
      itemId.trim().length > 0 &&
      state?.status === 'pending' &&
      typeof round === 'number' &&
      Number.isSafeInteger(round) &&
      round > 0
    ) {
      return {
        status: 'recorded',
        effectRef: `improvements-agent-review:resubmit:${itemId}:round:${round}`,
      };
    }
    if (payload.resubmitted === false && typeof payload.reason === 'string' && payload.reason.trim()) {
      return { status: 'not-recorded', reason: payload.reason };
    }
  }

  return {
    status: 'recovery-incomplete',
    reason: 'improvements:agent-review result did not identify its completed effect',
    failures: ['missing-effect-identity'],
  };
}

export default defineTool({
  name: 'improvements:agent-review',
  profile: 'engineer',
  abortCompletionReceipt: agentReviewAbortCompletionReceipt,
  description:
    'Claim a specific or the next peer-review item in one concrete harness, resubmit a revision-requested item, or adopt one whose submitter is provably gone. Review grades still go through blender:grade-idea; this door only owns reviewer pickup and submitter resubmission.',
  guidance: {
    when: "Use mode:'claim' with an id when a directed review must take one known pending item without consuming unrelated review work. Use mode:'claim-next' only to take the next pending change/feature. Then grade its routed idea with blender:grade-idea. Use mode:'resubmit' after addressing the review feedback on your own revision-requested item. Use mode:'adopt' (id) or 'adopt-next' to take a content revision whose original submitter is provably gone, then revise and resubmit it.",
    notWhen:
      'Do not use this to grade or approve — blender:grade-idea is the sole grade authority. Do not use ordinary scheduler:get_next for pending review work; that lane excludes it until approval.',
    chaining:
      "improvements:agent-review { mode:'claim', id, harness? } (directed) OR { mode:'claim-next', harness? } (queue order) → use returned gradeWith.ideaId or ledgerIdeaId with blender:grade-idea { ideaId, grade, feedback? }; revision author fixes → improvements:agent-review { mode:'resubmit', id }.",
    seeAlso: [
      'blender:grade-idea (record the peer grade and drive approval/revision)',
      'work_items:get (read the claimed work and its checkpoint)',
      'work_items:comment (record review-relevant progress)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('claim'),
      id: z
        .string()
        .min(1)
        .max(80)
        .describe('The pending peer-review work-item id to claim without consuming another review candidate.'),
      harness: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "Harness containing the review item. Omit only when the session is already scoped to one concrete harness; 'all' and '*' are refused.",
        ),
    }),
    z.object({
      mode: z.literal('claim-next'),
      harness: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "Harness to review. Omit only when the session is already scoped to one concrete harness; 'all' and '*' are refused.",
        ),
    }),
    z.object({
      mode: z.literal('resubmit'),
      id: z
        .string()
        .min(1)
        .max(80)
        .describe("The revision-requested work-item id — yours, or an orphan whose submitter is gone."),
      reproduction: z
        .object({
          kind: z.enum(['failing-test', 'scripted-repro', 'current-build-observation']),
          ref: z.string().min(1).max(2000),
          buildSha: z.string().regex(/^[0-9a-f]{7,40}$/i),
        })
        .optional()
        .describe('Only for a bug claimed as reproduction validation: your current-build reproduction receipt. The next review round verifies it.'),
    }),
    z.object({
      mode: z.literal('adopt'),
      id: z.string().min(1).max(80).describe('A revision-requested work-item whose original submitter is provably gone.'),
      harness: z.string().min(1).max(120).optional().describe("Harness containing the item; 'all' and '*' are refused."),
    }),
    z.object({
      mode: z.literal('adopt-next'),
      harness: z.string().min(1).max(120).optional().describe("Harness to scan; 'all' and '*' are refused."),
    }),
  ]),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    if (args.mode === 'claim' || args.mode === 'claim-next') {
      const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
      if (!harnessSlug) return harnessRequiredResult('improvements:agent-review');
      if (args.mode === 'claim') {
        const result = await claimAgentReview({
          id: args.id,
          reviewer: identity.ownerId,
          harnessSlug,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                mode: 'claim',
                ...result,
                ...gradeHandoff(result.claimed ? result.workItem : null),
              }),
            },
          ],
        };
      }
      const record = await getClaimSpecRecord({ cupId: identity.ownerId, workspaceId: identity.workspaceId ?? undefined });
      if (record.source === 'default' && record.fleetSlug) {
        throw new Error('Review pickup requires a valid fleet claim spec; no claim was attempted.');
      }
      const workItem = await claimNextAgentReview({
        reviewer: identity.ownerId, harnessSlug, filter: record.spec.view.filter,
        workspaceId: identity.workspaceId ?? undefined, signal: ctx.signal,
        onDiagnostics: (diagnostics: AgentReviewClaimNextDiagnostics) => {
          try {
            ctx.metadata?.({ agentReviewClaimNext: diagnostics });
          } catch {
            /* Diagnostic delivery must never change claim completion or its error. */
          }
        },
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'claim-next',
              claimed: workItem !== null,
              workItem,
              ...gradeHandoff(workItem),
            }),
          },
        ],
      };
    }

    if (args.mode === 'adopt' || args.mode === 'adopt-next') {
      const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
      if (!harnessSlug) return harnessRequiredResult('improvements:agent-review');
      const result = args.mode === 'adopt'
        ? await adoptAgentReviewRevision({ id: args.id, adopter: identity.ownerId, harnessSlug })
        : await adoptNextAgentReviewRevision({
            adopter: identity.ownerId,
            harnessSlug,
            workspaceId: identity.workspaceId ?? undefined,
          });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, mode: args.mode, ...result }) }],
      };
    }

    const result = await resubmitAgentReview({
      id: args.id,
      submittedBy: identity.ownerId,
      ...(args.reproduction ? { reproduction: args.reproduction } : {}),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, mode: 'resubmit', ...result }),
        },
      ],
    };
  },
});
