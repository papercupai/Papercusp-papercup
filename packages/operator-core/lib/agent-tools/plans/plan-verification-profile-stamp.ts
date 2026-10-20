/**
 * The verification profile `plans:new` stamps on a new plan
 * (plan-verification-profiles-2026-10-17 P-002, requirements R-4 and R-5).
 *
 * A plan's profile (coding | general, D-001) sets the default deliverable kind for its items.
 * `plans:new` records it once, at creation:
 *   - declared: the caller passed `verificationProfile`;
 *   - harness-default: otherwise, from the harness blueprint. A code-producing harness
 *     (`isCodingBlueprint`, the same predicate the release gate reads) gets `coding`; any other
 *     registered harness gets `general`.
 *
 * An unregistered harness, a missing or invalid blueprint, or an operator-level plan with no
 * harness gets `coding`. Unknown fails safe to the stricter profile: a coding plan can only
 * demand MORE evidence than a general one, never less.
 *
 * The column is machine state like `template_data`: content writes never touch it
 * (with-plan-lock's upsert omits it), and the stamp only fills a NULL, so a later re-run can
 * never overwrite a value. Changing a stamped profile is a separate, decision-gated verb (P-005).
 */
import type { TransactionSql } from 'postgres';
import type { VerificationProfile } from '@papercusp/plan-parser';

export type NewPlanProfileSource = 'declared' | 'harness-default';

/** Why the harness default came out the way it did (returned so the caller can see it). */
export type NewPlanProfileBasis =
  | 'declared'
  | 'coding-harness'
  | 'non-coding-harness'
  | 'harness-unresolved'
  | 'no-harness';

export interface NewPlanVerificationProfile {
  profile: VerificationProfile;
  source: NewPlanProfileSource;
  basis: NewPlanProfileBasis;
}

/** `true` = code harness, `false` = registered non-code harness, `null` = cannot tell. */
export type HarnessIsCoding = (harnessSlug: string, workspaceId: string) => Promise<boolean | null>;

async function defaultHarnessIsCoding(harnessSlug: string, workspaceId: string): Promise<boolean | null> {
  // Dynamic import: hive-release-env pulls the harness registry and blueprint resolver, which the
  // rest of plans:new never needs.
  const { resolveHarnessIsCoding } = await import('../../harness/routines/hive-release-env');
  return resolveHarnessIsCoding(harnessSlug, workspaceId);
}

export async function resolveNewPlanVerificationProfile(input: {
  declared?: VerificationProfile;
  harnessSlug?: string | null;
  workspaceId: string;
  isCoding?: HarnessIsCoding;
}): Promise<NewPlanVerificationProfile> {
  if (input.declared) return { profile: input.declared, source: 'declared', basis: 'declared' };
  const slug = input.harnessSlug?.trim();
  if (!slug || slug === 'all') return { profile: 'coding', source: 'harness-default', basis: 'no-harness' };
  let isCoding: boolean | null;
  try {
    isCoding = await (input.isCoding ?? defaultHarnessIsCoding)(slug, input.workspaceId);
  } catch {
    isCoding = null;
  }
  if (isCoding === true) return { profile: 'coding', source: 'harness-default', basis: 'coding-harness' };
  if (isCoding === false) return { profile: 'general', source: 'harness-default', basis: 'non-coding-harness' };
  return { profile: 'coding', source: 'harness-default', basis: 'harness-unresolved' };
}

/**
 * Write the stamp inside the plan-creating transaction (with-plan-lock's `inTransaction` hook), so a
 * created plan and its profile commit together. Fills only a NULL column.
 */
export async function stampNewPlanVerificationProfile(
  tx: TransactionSql,
  scope: { workspaceId: string; harnessSlug: string },
  planSlug: string,
  stamp: NewPlanVerificationProfile,
): Promise<void> {
  await tx`
    UPDATE harness_shared.harness_plans
       SET verification_profile = ${stamp.profile},
           verification_profile_source = ${stamp.source}
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${planSlug}
       AND verification_profile IS NULL
  `;
}
