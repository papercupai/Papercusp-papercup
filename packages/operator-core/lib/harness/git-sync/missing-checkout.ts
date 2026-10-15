/**
 * WI-10006867 — a git-sync install whose checkout has VANISHED.
 *
 * `gitSyncRuntimeGate` already refuses such an install (`no_path`: the registry
 * entry is gone, or its path no longer exists), so the fire no-ops instead of
 * error-escalating. What nothing did was ACT on that verdict once the install was
 * already seeded: the routine stayed `active` and skipped every tick forever, while
 * `last_synced_at` froze at the last real sync. Every downstream reader derives
 * `missed_intervals` from that frozen clock, so the per-install starvation alarm
 * reported "missed 5,493 consecutive scheduler intervals: nothing written there is
 * being committed" — naming the scheduler as the cause when the scheduler was firing
 * fine and the checkout was simply gone (measured 2026-10-06: four such active rows,
 * two of them silently re-activated on 2026-08-31 by a restart that restored a saved
 * active set).
 *
 * This module owns the vanished-checkout lifecycle:
 *   1. RECORD — each `no_path` skip stamps `metadata.missing_checkout { since, path }`,
 *      preserving the FIRST-seen `since` across ticks (atomic, in SQL), so the
 *      condition has an age and a real cause readers can name.
 *   2. CLEAR  — git-sync-action's `recordOutcome` writes `missing_checkout: null` in its
 *      existing outcome UPDATE (an outcome means the gate passed, so the checkout exists),
 *      so a checkout that comes back starts a FRESH clock if it ever vanishes again. A
 *      JSON null reads as absent here and in the RECORD step's CASE.
 *   3. RETIRE — once the checkout has been missing for
 *      `GIT_SYNC_MISSING_CHECKOUT_RETIRE_AFTER_MS`, the routine is paused with a recorded
 *      `metadata.pause { reason, pausedBy, pausedAtMs }` — the same record
 *      `routines:set { active:false }` writes, so every pause reader (the stale-paused
 *      detector, routines:list) understands it — and stops firing. A row re-activated
 *      later by a bulk restore keeps its `since`, so its next fire retires it again.
 *
 * The read half (`readMissingCheckout`) is what system-health uses to exclude these
 * installs from the missed-intervals measure and surface them under their real cause.
 */

/** How long a checkout may be missing before its git-sync routine is retired. A day
 *  covers a re-clone, a remount or a reboot of the box; a checkout gone for longer than
 *  that is an abandoned install, and firing it forever only manufactures a false alarm. */
export const GIT_SYNC_MISSING_CHECKOUT_RETIRE_AFTER_MS = 24 * 60 * 60 * 1000;

/** The `pause.pausedBy` stamp on an automatic retirement — distinct from any agent id,
 *  so a responder can tell the system retired it rather than a person pausing it. */
export const GIT_SYNC_MISSING_CHECKOUT_PAUSED_BY = 'system:git-sync:missing-checkout';

export interface MissingCheckoutState {
  /** ms epoch of the FIRST `no_path` skip in the current run of them. */
  since: number;
  /** The path the gate could not find, or null when the registry entry itself is gone. */
  path: string | null;
}

/** Parse `metadata.missing_checkout`; anything malformed reads as absent (null). */
export function readMissingCheckout(metadata: Record<string, unknown> | null | undefined): MissingCheckoutState | null {
  const raw = metadata?.missing_checkout;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const since = typeof rec.since === 'number' && Number.isFinite(rec.since) ? rec.since : null;
  if (since === null) return null;
  return { since, path: typeof rec.path === 'string' && rec.path.length > 0 ? rec.path : null };
}

/** True once the checkout has been missing for at least `graceMs`. */
export function missingCheckoutRetireDue(
  since: number,
  nowMs: number,
  graceMs: number = GIT_SYNC_MISSING_CHECKOUT_RETIRE_AFTER_MS,
): boolean {
  return nowMs - since >= graceMs;
}

/** The pause reason recorded on retirement: names the cause, the path and how to undo it. */
export function missingCheckoutPauseReason(state: MissingCheckoutState, graceMs: number): string {
  const hours = Math.round(graceMs / 3_600_000);
  const where = state.path ? `checkout ${state.path} has been missing` : 'its harness registry entry has been missing';
  return (
    `WI-10006867 auto-retire: ${where} since ${new Date(state.since).toISOString()} (more than ${hours}h), ` +
    `so every fire skipped with no_path. Restore the checkout and resume with routines:set { active:true }, ` +
    `or delete the install.`
  );
}

/** The one postgres.js surface this module needs (`getOrgPg().sql.unsafe`). Method
 *  syntax on purpose: its bivariant parameter check accepts postgres.js's narrower
 *  parameter type, and `PromiseLike` accepts its `PendingQuery`. */
export interface MissingCheckoutSql {
  unsafe(query: string, params?: unknown[]): PromiseLike<ReadonlyArray<Record<string, unknown>>>;
}

/**
 * Record one `no_path` skip and, when the grace has elapsed, retire the routine.
 *
 * ONE UPDATE writes the skip fields and `missing_checkout`, keeping the stored `since`
 * when one is present (so concurrent or repeated skips never reset the clock); a second,
 * guarded UPDATE retires only a row that is still active. Returns what was stored.
 *
 * Params follow git-sync's routine-UPDATE convention (`$1` slug, `$2` workspaceId, `$3`
 * the jsonb patch — EI-18799539619330782), so this write carries the same skip-field
 * patch every other skip reason writes and reads identically to every patch consumer.
 */
export async function recordMissingCheckoutSkip(
  sql: MissingCheckoutSql,
  args: { slug: string; workspaceId: string; path: string | null; nowMs: number; graceMs?: number },
): Promise<{ since: number; retired: boolean } | null> {
  const graceMs = args.graceMs ?? GIT_SYNC_MISSING_CHECKOUT_RETIRE_AFTER_MS;
  const skipPatch = {
    last_status: 'skipped',
    local_sync_status: 'skipped',
    last_skip_reason: 'no_path',
    last_skipped_at: args.nowMs,
  };
  const rows = await sql.unsafe(
    // $3 is bound as TEXT and parsed here (see the retire UPDATE below for why).
    `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::text::jsonb || jsonb_build_object(
              'missing_checkout', jsonb_build_object(
                'since', CASE
                           WHEN jsonb_typeof(metadata->'missing_checkout'->'since') = 'number'
                             THEN metadata->'missing_checkout'->'since'
                           ELSE $3::text::jsonb->'last_skipped_at'
                         END,
                'path', to_jsonb($4::text)
              )
            ),
            updated_at = now()
      WHERE install_slug = $1 AND workspace_id = $2 AND target_role = 'system:git-sync'
      RETURNING (metadata->'missing_checkout'->>'since')::bigint AS since, active`,
    [args.slug, args.workspaceId, JSON.stringify(skipPatch), args.path],
  );
  const row = rows[0];
  // A NULL since (metadata that is not a JSON object, so missing_checkout never landed)
  // must read as "not recorded", never as Number(null) === 0 — a since of 1970 retires
  // the routine on the spot.
  if (!row || row.since === null || row.since === undefined) return null;
  const since = Number(row.since);
  if (!Number.isFinite(since)) return null;
  if (row.active !== true || !missingCheckoutRetireDue(since, args.nowMs, graceMs)) {
    return { since, retired: false };
  }
  const pause = {
    reason: missingCheckoutPauseReason({ since, path: args.path }, graceMs),
    pausedBy: GIT_SYNC_MISSING_CHECKOUT_PAUSED_BY,
    pausedAtMs: args.nowMs,
  };
  const retired = await sql.unsafe(
    `UPDATE harness_shared.routines
        SET active = false,
            -- $3 is bound as TEXT and parsed here: binding a JSON string straight to a jsonb
            -- parameter lets the driver JSON-encode it a second time, storing pause as a string.
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('pause', $3::text::jsonb),
            updated_at = now()
      WHERE install_slug = $1 AND workspace_id = $2 AND target_role = 'system:git-sync' AND active = true
      RETURNING install_slug`,
    [args.slug, args.workspaceId, JSON.stringify(pause)],
  );
  return { since, retired: retired.length > 0 };
}
