/**
 * watchdog-key-fold.ts — the backlog fold for bug-inflow-one-problem-one-row-2026-10-18
 * P-008 (R-7, owner directive #1990: one problem, one row; a duplicate is a FIELD).
 *
 * Two passes, both dry-run by DEFAULT (report, write nothing):
 *
 *  1. KEY FOLD. When the D-004 key migration (watchdog-key-migration.ts) re-keys open
 *     `repeated-tool-error:*` rows, several legacy rows can land on ONE structural key.
 *     `recomputeWatchdogKeys` reports those as collisions and leaves them alone. This
 *     pass folds each collision onto the open row that holds the key: the loser gets
 *     `duplicate_of` = that row (duplicate_source 'fold', migration 1534), its
 *     occurrence count is added to the canonical row's `repeatCount`, and it is
 *     dropped under {@link WATCHDOG_KEY_FOLD_OWNER}. Only an open, unclaimed loser in
 *     the SAME workspace as its canonical row folds; anything else is reported as
 *     skipped, never forced.
 *
 *  2. LINK BACKFILL. A `duplicates` edge in coord_links is mirrored onto
 *     `duplicate_of` at link time since migration 1534 (stampDuplicateVerdictFromLink),
 *     but edges written before it carry no verdict. This pass stamps the source row
 *     of every such edge (duplicate_source 'agent', first edge wins) when the target
 *     is a work item in the same workspace.
 *
 * Mirrors tool-failure-signature-fold.ts: mark the duplicate with its survivor, then
 * close it under a dedicated owner (not the watchdog auto-close owner, so no
 * exact-key reopen path fires — and the loser keeps its old key anyway).
 */
import { getOrgPg } from '@papercusp/db-org';
import { setIssueState } from '../../issues-engineer';
import { runWithWorkspace } from '../../workspace-als';
import type { WatchdogKeyCollision } from './watchdog-key-migration';

type Sql = ReturnType<typeof getOrgPg>['sql'];

export const WATCHDOG_KEY_FOLD_OWNER = 'system:watchdog-key-fold';

/** One shared key: the canonical open row and the rows that fold onto it. */
export interface WatchdogKeyFoldGroup {
  key: string;
  canonical: string;
  folded: string[];
}

/** Pure: group the key migration's collisions by shared key onto the row holding it. */
export function planWatchdogKeyFolds(collisions: readonly WatchdogKeyCollision[]): WatchdogKeyFoldGroup[] {
  const byKey = new Map<string, WatchdogKeyFoldGroup>();
  for (const c of collisions) {
    if (c.id === c.heldBy) continue;
    const group = byKey.get(c.newKey) ?? { key: c.newKey, canonical: c.heldBy, folded: [] };
    if (group.canonical !== c.heldBy) continue; // one holder per key by construction; never fold across two
    if (!group.folded.includes(c.id)) group.folded.push(c.id);
    byKey.set(c.newKey, group);
  }
  return [...byKey.values()].sort((a, b) => b.folded.length - a.folded.length || a.key.localeCompare(b.key));
}

export interface WatchdogKeyFoldResult {
  dryRun: boolean;
  /** Per-key fold plan: `folded.length` rows fold onto `canonical`. */
  groups: WatchdogKeyFoldGroup[];
  /** Rows folded (or, in a dry run, that would fold). */
  folded: number;
  /** Losers left alone: not open, claimed, already a duplicate, or in another workspace. */
  skipped: string[];
}

export interface WatchdogKeyFoldDeps {
  sql?: Sql;
  /**
   * Close one folded row. Default: setIssueState(id, 'dropped', WATCHDOG_KEY_FOLD_OWNER)
   * inside the row's own workspace (setIssueState resolves the row by the active one).
   */
  dropDuplicate?: (id: string, workspaceId: string) => Promise<unknown>;
}

// A loser folds only while it is open, unclaimed and not yet a duplicate, and only
// onto a canonical row in its own workspace. One statement per loser: the stamp and
// the canonical's count move together or not at all.
const FOLD_ELIGIBLE_SQL = `
  SELECT l.feature_id AS id
    FROM harness_shared.work_items l
    JOIN harness_shared.work_items c
      ON c.workspace_id = l.workspace_id AND c.feature_id = $2
   WHERE l.feature_id = $1
     AND l.status = 'open'
     AND l.taken_by IS NULL
     AND l.duplicate_of IS NULL`;

const FOLD_STAMP_SQL = `
  WITH loser AS (
    UPDATE harness_shared.work_items l
       SET duplicate_of = c.feature_id,
           duplicate_source = 'fold',
           duplicate_confidence = 1,
           duplicate_evidence = jsonb_build_object('matchedOn', 'structural-key', 'key', $3::text),
           payload = COALESCE(l.payload, '{}'::jsonb) || jsonb_build_object(
             'watchdogKeyFoldedInto', c.feature_id,
             'decidedReason', 'duplicate of ' || c.feature_id || ' — watchdog key fold onto ' || $3::text
               || ' (bug-inflow-one-problem-one-row-2026-10-18 P-008)')
      FROM harness_shared.work_items c
     WHERE l.feature_id = $1
       AND c.workspace_id = l.workspace_id AND c.feature_id = $2
       AND l.status = 'open' AND l.taken_by IS NULL AND l.duplicate_of IS NULL
    RETURNING l.workspace_id, l.feature_id,
              GREATEST(COALESCE((l.payload->>'repeatCount')::int, 1), 1) AS n
  )
  UPDATE harness_shared.work_items c
     SET payload = COALESCE(c.payload, '{}'::jsonb) || jsonb_build_object(
           'repeatCount', GREATEST(COALESCE((c.payload->>'repeatCount')::int, 1), 1) + loser.n)
    FROM loser
   WHERE c.workspace_id = loser.workspace_id AND c.feature_id = $2
  RETURNING loser.feature_id AS id, loser.workspace_id`;

/** Fold the key migration's collisions. Dry-run by default. */
export async function foldWatchdogKeyCollisions(
  collisions: readonly WatchdogKeyCollision[],
  deps: WatchdogKeyFoldDeps = {},
  opts: { dryRun?: boolean } = {},
): Promise<WatchdogKeyFoldResult> {
  const dryRun = opts.dryRun ?? true;
  const sql = deps.sql ?? getOrgPg().sql;
  const drop = deps.dropDuplicate ??
    ((id: string, workspaceId: string) => runWithWorkspace(workspaceId, () =>
      setIssueState(id, 'dropped', WATCHDOG_KEY_FOLD_OWNER, undefined, { skipCompletionGate: true })));
  const groups = planWatchdogKeyFolds(collisions);
  const result: WatchdogKeyFoldResult = { dryRun, groups, folded: 0, skipped: [] };
  for (const group of groups) {
    for (const id of group.folded) {
      if (dryRun) {
        const eligible = await sql.unsafe<{ id: string }[]>(FOLD_ELIGIBLE_SQL, [id, group.canonical]);
        if (eligible.length) result.folded++;
        else result.skipped.push(id);
        continue;
      }
      const stamped = await sql.unsafe<{ id: string; workspace_id: string }[]>(FOLD_STAMP_SQL, [id, group.canonical, group.key]);
      if (!stamped.length) {
        result.skipped.push(id);
        continue;
      }
      await drop(id, stamped[0].workspace_id);
      result.folded++;
    }
  }
  return result;
}

// Every `duplicates` edge whose source row carries no verdict yet and whose target is
// a work item in the same workspace; the FIRST edge per source wins (matching the
// link-time writer's `duplicate_of IS NULL` rule). Refs may be qualified
// (`<harness>#<id>`, the feature form) or bare (`EI-…`, `WI-…`).
const LINK_BACKFILL_CTE = `
  WITH edges AS (
    SELECT l.id AS link_id, l.workspace_id, l.created_by, l.created_at,
           CASE WHEN position('#' in l.src_ref) > 0 THEN split_part(l.src_ref, '#', 2) ELSE l.src_ref END AS src_id,
           CASE WHEN position('#' in l.dst_ref) > 0 THEN split_part(l.dst_ref, '#', 2) ELSE l.dst_ref END AS dst_id
      FROM harness_shared.coord_links l
     WHERE l.rel = 'duplicates'
       AND l.src_kind IN ('issue', 'feature', 'work_item')
       AND l.dst_kind IN ('issue', 'feature', 'work_item')
  ), first_edge AS (
    SELECT DISTINCT ON (e.workspace_id, e.src_id) e.*
      FROM edges e
      JOIN harness_shared.work_items t ON t.workspace_id = e.workspace_id AND t.feature_id = e.dst_id
     WHERE e.src_id <> e.dst_id
     ORDER BY e.workspace_id, e.src_id, e.created_at, e.link_id
  )`;

const LINK_BACKFILL_COUNT_SQL = `${LINK_BACKFILL_CTE}
  SELECT count(*)::int AS n,
         count(*) FILTER (WHERE w.status = 'open')::int AS open_n
    FROM first_edge f
    JOIN harness_shared.work_items w ON w.workspace_id = f.workspace_id AND w.feature_id = f.src_id
   WHERE w.duplicate_of IS NULL`;

const LINK_BACKFILL_APPLY_SQL = `${LINK_BACKFILL_CTE}
  UPDATE harness_shared.work_items w
     SET duplicate_of = f.dst_id,
         duplicate_source = 'agent',
         duplicate_confidence = NULL,
         duplicate_evidence = jsonb_build_object('matchedOn', 'agent-link', 'by', f.created_by, 'backfill', true)
    FROM first_edge f
   WHERE w.workspace_id = f.workspace_id AND w.feature_id = f.src_id
     AND w.duplicate_of IS NULL
  RETURNING w.feature_id AS id, w.status`;

export interface DuplicateLinkBackfillResult {
  dryRun: boolean;
  /** Source rows stamped (or, in a dry run, that would be). */
  stamped: number;
  /** Of those, rows still open — they leave the claimable set. */
  open: number;
}

/** Stamp duplicate_of from pre-1534 `duplicates` edges. Dry-run by default. */
export async function backfillDuplicateOfFromLinks(
  deps: { sql?: Sql } = {},
  opts: { dryRun?: boolean } = {},
): Promise<DuplicateLinkBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  const sql = deps.sql ?? getOrgPg().sql;
  if (dryRun) {
    const [row] = await sql.unsafe<{ n: number; open_n: number }[]>(LINK_BACKFILL_COUNT_SQL);
    return { dryRun, stamped: row?.n ?? 0, open: row?.open_n ?? 0 };
  }
  const rows = await sql.unsafe<{ id: string; status: string | null }[]>(LINK_BACKFILL_APPLY_SQL);
  return { dryRun, stamped: rows.length, open: rows.filter((r) => r.status === 'open').length };
}
