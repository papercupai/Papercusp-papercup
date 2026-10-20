/**
 * plans:set-verification-profile — change a plan's stamped verification profile
 * (plan-verification-profiles-2026-10-17 P-005, requirement R-14; D-004, D-008).
 *
 * `plans:new` stamps the profile once (P-002) and content writes never touch the column, so
 * this verb is the only way to change it. Raising (general → coding) is always allowed: it can
 * only demand more evidence. Lowering (coding → general) after activation drops the code
 * verification module for every item without its own deliverable, so it needs a Decision that
 * is already recorded in the plan (`decisionId`) AND a latest activation audit that reviewed
 * the current plan content (so the audit has seen that Decision). While the plan is a draft,
 * either direction is free.
 *
 * The write takes the same transaction-scoped advisory lock as every plan content writer, so
 * the content the freshness check hashes cannot move under it.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { parsePlan } from '@papercusp/plan-parser';
import { resolvePlanWriteScope } from './_write-scope';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './plan-lock-key';
import { hashPlanContent } from './content-hash';
import {
  evaluateProfileLowering,
  isPlanActivated,
  readLatestActivationAuditAnchor,
  type VerificationLoweringRefusal,
} from '../../plan-verification-escape';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug.'),
  profile: z.enum(['coding', 'general']).describe('The new verification profile.'),
  decisionId: z
    .string()
    .regex(/^D-\d{3,}$/)
    .optional()
    .describe('Recorded Decision (D-NNN) explaining a coding → general change. Required to lower an activated plan.'),
});

export type SetVerificationProfileResult =
  | {
      ok: true;
      slug: string;
      from: string | null;
      fromSource: string | null;
      to: 'coding' | 'general';
      changed: boolean;
      decisionId: string | null;
    }
  | { ok: false; code: 'plan_not_found'; slug: string }
  | (VerificationLoweringRefusal & { slug: string });

/** The handler body, exported for the integration test (it runs inside the caller's workspace scope). */
export async function setVerificationProfile(input: {
  workspaceId: string;
  harnessSlug: string;
  slug: string;
  profile: 'coding' | 'general';
  decisionId?: string;
}): Promise<SetVerificationProfileResult> {
  const { workspaceId, harnessSlug, slug, profile } = input;
  return withWorkspace(workspaceId, async (tx) => {
    await acquirePlanAdvisoryLock(tx as never, planAdvisoryLockKey(workspaceId, harnessSlug, slug));
    const rows = await tx<
      { content: string; status: string | null; verification_profile: string | null; verification_profile_source: string | null }[]
    >`
      SELECT content, status, verification_profile, verification_profile_source
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND plan_slug = ${slug}
       FOR UPDATE`;
    const cur = rows[0];
    if (!cur) return { ok: false as const, code: 'plan_not_found' as const, slug };
    const audit = await readLatestActivationAuditAnchor(tx as never, { workspaceId, harnessSlug, planSlug: slug });
    const refusal = evaluateProfileLowering({
      planSlug: slug,
      activated: isPlanActivated(cur.status, audit !== null),
      from: cur.verification_profile,
      to: profile,
      decisionId: input.decisionId ?? null,
      decisions: parsePlan(cur.content).decisions,
      currentContentHash: hashPlanContent(cur.content),
      latestActivationAudit: audit,
    });
    if (refusal) return { ...refusal, slug };
    await tx`
      UPDATE harness_shared.harness_plans
         SET verification_profile = ${profile},
             verification_profile_source = 'declared'
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND plan_slug = ${slug}`;
    return {
      ok: true as const,
      slug,
      from: cur.verification_profile,
      fromSource: cur.verification_profile_source,
      to: profile,
      changed: cur.verification_profile !== profile,
      decisionId: input.decisionId ?? null,
    };
  });
}

export default defineTool({
  name: 'plans:set-verification-profile',
  description:
    "Change a plan's verification profile (coding | general). Raising to coding is always allowed. Lowering an activated plan to general needs a recorded Decision (decisionId) and a fresh activation audit.",
  guidance: {
    when: 'A plan was stamped with the wrong profile: its items are not code work (general) or are code work (coding).',
    notWhen: "Changing one item's deliverable: edit its `deliverable:` keyword instead (plans:edit).",
    chaining: "Lowering: plans:add-decision → plans:audit { phase:'activation' } → this verb with decisionId.",
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const { workspaceId, harnessSlug } = await resolvePlanWriteScope(sctx);
    const result = await setVerificationProfile({
      workspaceId,
      harnessSlug,
      slug: args.slug,
      profile: args.profile,
      decisionId: args.decisionId,
    });
    if (!result.ok) return { data: { ...result, error: result.code }, isError: true as const };
    if (result.changed) {
      try {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        await notifySyncInvalidate('plans.list', undefined);
      } catch {
        /* best-effort — the next natural refresh picks it up */
      }
    }
    return { data: result };
  },
});
