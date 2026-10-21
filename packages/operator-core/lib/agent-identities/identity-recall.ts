/**
 * Identity-declared recall bounds (identity-system-everything-migration-2026-10-18
 * P-012: R-9 budget share, R-17 memory scope, R-18 knowledge corpora, R-19
 * mid-turn bounds).
 *
 * The declaration is an IDENTITY field (`recall:` on the blueprint, composed
 * restriction-only down the stack by MERGE_RULES), never a workspace runtime
 * setting (D-008). It reaches recall through the wearer's APPLIED artifact, the
 * same receipt the worn-rule guards read, so a session recalls under exactly the
 * identity it is authorized as.
 *
 * Every bound only narrows. An identity that declares nothing yields `null`, and
 * `null` leaves every recall input untouched: that is the R-9 "recalls exactly as
 * before" half, and it is why the helpers below are identities on `null`.
 *
 * The Personal Vault is not a corpus here and cannot be declared (the schema has
 * no value for it); its leg is authorized separately and is never bounded or
 * widened by this module.
 */
import { RecallSchema, type BlueprintRecall } from '@papercusp/orchestrator/blueprint';

export type IdentityRecallPolicy = BlueprintRecall;
export type RecallMemoryPool = NonNullable<BlueprintRecall['memoryScopes']>[number];

/** Recalls nothing: the fail-closed answer for a declaration that no longer parses. */
const RECALL_NOTHING: IdentityRecallPolicy = Object.freeze({ memoryScopes: [], corpora: [] });

/**
 * The recall bounds an applied artifact declares, or null when it declares none.
 * An applied artifact was schema-validated at compile time, so an unparsable
 * declaration means the receipt is corrupt: it recalls nothing rather than
 * falling back to unbounded recall.
 */
export function identityRecallPolicy(
  configuration: { readonly recall?: unknown } | null | undefined,
): IdentityRecallPolicy | null {
  const declared = configuration?.recall;
  if (declared === undefined || declared === null) return null;
  const parsed = RecallSchema.safeParse(declared);
  return parsed.success ? parsed.data : RECALL_NOTHING;
}

/** True when the identity may recall from `pool`. */
export function recallsMemoryPool(policy: IdentityRecallPolicy | null | undefined, pool: RecallMemoryPool): boolean {
  return !policy?.memoryScopes || policy.memoryScopes.includes(pool);
}

/** True when the identity may draw knowledge from corpus source `name`. */
export function recallsCorpus(policy: IdentityRecallPolicy | null | undefined, name: string): boolean {
  return !policy?.corpora || (policy.corpora as readonly string[]).includes(name);
}

/**
 * A count ceiling (hit limit) under the identity's budget share. A positive share
 * of a positive ceiling never rounds to zero: a share bounds recall, it does not
 * switch it off (an empty `memoryScopes` does that).
 */
export function shareOfLimit(limit: number, policy: IdentityRecallPolicy | null | undefined): number {
  const share = policy?.budgetShare;
  if (share === undefined || !Number.isFinite(limit) || limit <= 0) return limit;
  return Math.max(1, Math.floor(limit * share));
}

/** A character budget under the identity's budget share. */
export function shareOfBudgetChars(budgetChars: number, policy: IdentityRecallPolicy | null | undefined): number {
  const share = policy?.budgetShare;
  if (share === undefined || !Number.isFinite(budgetChars) || budgetChars <= 0) return budgetChars;
  return Math.max(1, Math.floor(budgetChars * share));
}

/**
 * A stable key for the declared bounds, '' when none. Recall caches keyed by
 * session append it so a block built under one identity's bounds is never served
 * under another's, while an unconfigured identity keeps its existing key.
 */
export function identityRecallCacheSuffix(policy: IdentityRecallPolicy | null | undefined): string {
  if (!policy) return '';
  const scopes = policy.memoryScopes ? [...policy.memoryScopes].sort().join(',') : '*';
  const corpora = policy.corpora ? [...policy.corpora].sort().join(',') : '*';
  return `:recall=${policy.budgetShare ?? 1}|${scopes}|${corpora}`;
}

/**
 * The applied identity's recall bounds for a session. Null when the session
 * wears no identity or its identity declares none. Throws when an identity is
 * applied but its artifact cannot be read: the caller then omits recall for the
 * turn instead of recalling past bounds it could not see.
 */
export async function readAppliedIdentityRecall(
  ownerId: string,
  workspaceId: string,
): Promise<IdentityRecallPolicy | null> {
  const { readAppliedIdentityRules } = await import('./sync-hook-rules');
  const applied = await readAppliedIdentityRules(ownerId, workspaceId);
  return applied?.recall ?? null;
}
