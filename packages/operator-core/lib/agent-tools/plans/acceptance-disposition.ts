/**
 * `plans:acceptance-disposition` — record the typed disposition a STALE
 * awaiting-acceptance plan owes (P-005, verification-system-improvements-2026-10-10).
 *
 * The acceptance drain surfaces a plan idle more than 14 days by stamping its
 * filing `dispositionRequired`. This verb is how that debt is paid: exactly one of
 * regrade | repair | accept-risk | drop, with an evidence ref and a reason, written
 * onto the plan's canonical drain filing. The result carries the harness's current
 * stale count so the caller sees it move.
 *
 * Reuses the existing drain filing as the record instead of adding a table: the
 * filing is already the per-plan attention item, and the measurement
 * (`measureStaleAcceptance`) joins on it.
 */
import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { resolvePlanScope } from './source';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  ACCEPTANCE_DISPOSITION_KINDS,
  measureStaleAcceptance,
  recordAcceptanceDrainDisposition,
} from './acceptance-drain-disposition';

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:acceptance-disposition',
  description:
    "Record the typed disposition a stale awaiting-acceptance plan owes: kind regrade | repair | accept-risk | drop, plus an evidenceRef and a reason, written onto the plan's acceptance-drain filing (clears dispositionRequired). Refuses with acceptance_disposition_kind_invalid / _evidence_missing / _reason_missing / _no_filing. Returns the harness's stale-acceptance counts after the write.",
  guidance: {
    when: "A plan sits in awaiting-acceptance past 14 days and its drain filing says 'Disposition stale plan' — decide what happens to it.",
    notWhen:
      'Grading or shipping the plan itself (scorecards:emit, plans:set-plan-status). Dropping individual items (plans:set-status). The decision does not move the plan; carry it out separately.',
    chaining:
      'work_items:list { q: "Disposition stale plan" } → read the plan → plans:acceptance-disposition { slug, kind, evidenceRef, reason } → then act on the kind (regrade: request grading; repair: fix the refusal; drop: plans:set-plan-status).',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: z.object({
    harness: harnessArg,
    slug: z.string().min(1).describe('Plan slug of the stale awaiting-acceptance plan.'),
    kind: z.enum(ACCEPTANCE_DISPOSITION_KINDS).describe('regrade | repair | accept-risk | drop'),
    evidenceRef: z
      .string()
      .describe('What the decision rests on: a work-item id, <slug>#D-NNN, a scorecard id, or a URL.'),
    reason: z.string().describe('One line: why this disposition.'),
  }),
  async handler(args, ctx) {
    const opts = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
    const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
    let recordedBy = 'system';
    try {
      recordedBy = resolveAgentIdentity(ctx).ownerId;
    } catch {
      /* unresolvable identity → recorded as 'system' */
    }

    const outcome = await withWorkspace(workspaceId, async (tx) => {
      const sql = tx as unknown as postgres.Sql;
      const result = await recordAcceptanceDrainDisposition(sql, {
        workspaceId,
        harnessSlug,
        planSlug: args.slug,
        kind: args.kind,
        evidenceRef: args.evidenceRef,
        reason: args.reason,
        recordedBy,
      });
      const staleAcceptance = result.ok ? await measureStaleAcceptance(sql, { workspaceId, harnessSlug }) : null;
      return { result, staleAcceptance };
    });

    if (!outcome.result.ok) {
      return text({ error: outcome.result.code, slug: args.slug, message: outcome.result.message }, true);
    }
    return text({
      ok: true,
      slug: args.slug,
      workItemId: outcome.result.workItemId,
      disposition: outcome.result.disposition,
      replaced: outcome.result.replaced,
      staleAcceptance: outcome.staleAcceptance,
    });
  },
});
