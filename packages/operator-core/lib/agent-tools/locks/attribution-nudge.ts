/**
 * attribution-nudge — the edit-time "you hold no work item" nudge
 * (code-intel-delivery-and-outcomes-2026-10-26 P-010, SPEC-P-010).
 *
 * Measured before this landed: 1,321 of 1,808 edit_attribution_ledger rows in 24h
 * carried a NULL work_item_id, so function-level provenance could not name the work
 * behind most edits. An edit is attributed only to a work item its editor holds, so
 * the cheapest lever is to tell the editor, at the moment of the edit, that it holds
 * none.
 *
 * A locks:acquire grant carries `attribution_nudge` when the lock owner holds no
 * non-terminal work item in the workspace. The PreToolUse lock hook passes it to the
 * model as additionalContext. The nudge never blocks the edit and never invents an
 * attribution: the edit is still recorded with work_item_id NULL plus the declared
 * intent and plan slug.
 *
 * Fails silent: a missing workspace or a failed read yields no nudge, because a false
 * "you hold nothing" would push an agent that does hold an item to create a duplicate.
 */

import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';

export const ATTRIBUTION_NUDGE =
  'Attribution: you hold no work item, so this edit is recorded unattributed '
  + '(work_item_id NULL; only your declared intent and plan slug are kept). Claim one '
  + '(work_items:claim) or create one (work_items:create { assign_to:"self", state:"wip" }) '
  + 'so provenance and git-sync can credit the work.';

/** A tagged-template SQL runner (postgres.js shape); injectable for unit tests. */
export type NudgeSql = <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/**
 * Does `ownerId` hold at least one non-terminal work item in `workspaceId`? Reads the
 * canonical holder column (`work_items.taken_by`, indexed by hfc_taken_by_idx), not the
 * TTL lease table `work_item_claims`, which holds only a small fraction of real holds.
 * Returns null when the answer cannot be measured.
 */
export async function ownerHoldsOpenWorkItem(
  sql: NudgeSql,
  workspaceId: string,
  ownerId: string,
): Promise<boolean | null> {
  try {
    const rows = await sql<Array<{ held: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND taken_by = ${ownerId}
           AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
      ) AS held
    `;
    const held = rows?.[0]?.held;
    return typeof held === 'boolean' ? held : null;
  } catch {
    return null;
  }
}

/** The grant path never waits longer than this for the nudge read. */
export const ATTRIBUTION_NUDGE_TIMEOUT_MS = 250;

/**
 * The nudge text for a granted edit, or undefined when the owner holds a work item or
 * the answer is unknown (including a read slower than `timeoutMs`). Never throws.
 */
export async function readAttributionNudge(input: {
  sql: NudgeSql | null | undefined;
  workspaceId: string | null | undefined;
  ownerId: string | null | undefined;
  timeoutMs?: number;
}): Promise<string | undefined> {
  if (!input.sql || !input.workspaceId || !input.ownerId) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), input.timeoutMs ?? ATTRIBUTION_NUDGE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const held = await Promise.race([
      ownerHoldsOpenWorkItem(input.sql, input.workspaceId, input.ownerId),
      timedOut,
    ]);
    return held === false ? ATTRIBUTION_NUDGE : undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Production glue for locks:acquire: resolve the workspace and the org pool lazily and
 * start the read, so it overlaps the grant. Every failure resolves to no nudge.
 */
export function startAttributionNudge(input: {
  ownerId: string | null | undefined;
  resolveWorkspaceId: () => string | null | undefined;
  resolveSql: () => NudgeSql | null | undefined;
}): Promise<string | undefined> {
  try {
    return readAttributionNudge({
      sql: input.resolveSql(),
      workspaceId: input.resolveWorkspaceId(),
      ownerId: input.ownerId,
    }).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}
