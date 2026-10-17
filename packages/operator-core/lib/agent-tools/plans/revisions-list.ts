/**
 * plans:revisions — the PG-canonical revision chain for a plan.
 *
 * plan-agent-launch-2026-05-21, Phase 1 (P-004 / D-003).
 *
 * One row per recorded plans:* write (the plan_revisions spine),
 * newest-first: seq, author, rationale, the session that produced it,
 * a +/- diff-stat vs the prior revision, and a timestamp. This is
 * metadata only; use plans:revision-diff for a single revision's patch
 * and plans:revision-transcript for its authoring conversation.
 *
 * A plan with no recorded revisions returns an empty chain, not an
 * error. A genuine DB failure is reported as revisions_unavailable
 * rather than a misleading empty list.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { listPlanRevisions } from './revisions';
import { resolvePlanScope } from './source';

const argsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .describe('Plan slug (filename stem) whose revision chain to read.'),
  harness: harnessArg,
});

export default defineTool({
  name: 'plans:revisions',
  description:
    'The PG-canonical revision chain for a plan, newest-first — one metadata row per recorded plans:* write: seq, author (agent|human), rationale, authoring session, diff-stat, and timestamp. Use plans:revision-diff for one revision patch and plans:revision-transcript for its authoring conversation. This list does not include full historical snapshots.',
  guidance: {
    when: "You need a plan's edit history with the *why* — what changed at each revision and the rationale behind it. The basis of the Revisions panel and of the context an agent launched from the plan is seeded with.",
    notWhen:
      'You want a single revision patch — plans:revision-diff. You want the authoring conversation — plans:revision-transcript. You want the current plan body — plans:get. This list is metadata only.',
    chaining:
      'plans:revisions → plans:revision-diff for one revision patch, or plans:revision-transcript for the conversation behind a revision.',
    seeAlso: [
      'plans:revision-diff (the patch for one revision)',
      'plans:revision-transcript (the authoring conversation)',
      'plans:summarize-revision (backfill a rationale)',
    ],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // Acceptance judges need the revision history named by their rubric methods;
  // keep this read grant local rather than widening the general SU role set.
  agentRoles: [...SU_ROLES, 'judge'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    try {
      // Resolve the full (workspaceId, harnessSlug) scope so the read
      // targets the plan's own workspace spine (audit P-008 / mig 218).
      const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
      const revisions = await listPlanRevisions(args.slug, scope);
      ctxAny.metadata?.({ slug: args.slug, revisionCount: revisions.length });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ revisions }) }],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'revisions_unavailable',
              message: message.slice(0, 400),
              slug: args.slug,
            }),
          },
        ],
        isError: true,
      };
    }
  },
});
