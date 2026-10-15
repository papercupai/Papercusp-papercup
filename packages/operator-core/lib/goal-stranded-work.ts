/**
 * Goal-created work must not be stranded by a refused placement (P-005 / R-5 of
 * plan goal-grading-live-coverage-and-holder-followthrough-2026-10-08).
 *
 * MEASURED 2026-10-07T12:03:40Z: a goal holder created WI-10007120, then asked
 * `capability:launch-agent` for one executor to work it. The launch was refused
 * (`goal_max_agents`: "allows 6 concurrent agent(s); 8 live"), the refusal went
 * back to the caller as a plain error, and nothing recorded that the item had
 * been left behind. It sat open and unassigned for 30h. The same goal carried 36
 * open, unassigned goal-created items on 2026-10-08, the oldest from 2026-09-20.
 *
 * Two halves, one module:
 *
 * 1. The REFUSAL half (`recordGoalPlacementRefusal`). When a goal launch is
 *    refused, every goal-created item the launch named (its `feature` /
 *    `workItem` argument, or a WI-/EI- id in its brief) that is still open and
 *    unassigned is stamped with `payload.placementRefusal`. The item stays in
 *    the claimable queue (it is not moved or reassigned), and the stamp makes it
 *    visible to the goal's obligation agenda IMMEDIATELY instead of after the
 *    age threshold. The holder's two lawful dispositions are to place it again
 *    or to drop it with a reason.
 *
 * 2. The AGENDA half (`readStrandedGoalWork`). The goal holder's obligation
 *    agenda reads the goal's open, unassigned, non-observation items that are
 *    either older than {@link GOAL_STRANDED_WORK_THRESHOLD_MS} or carry a
 *    placement-refusal stamp. A non-empty read is a DUE `stranded-goal-work`
 *    obligation. It clears when every such item is claimed, dropped or finished.
 *
 * Why not edit the launch resolver in goal-launch-settings.ts: that file is
 * bound source for other plans' acceptance evidence, and a refusal is a fact
 * about the CALLER's work, not about the ceiling. The resolver stays the single
 * authority on whether a launch fits; this module only records what a refusal
 * left behind.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/**
 * How long a goal-created item may sit open and unassigned before the holder's
 * agenda calls it stranded. Long enough that an item created moments before a
 * drain fleet claims it does not alarm; short enough that a day-long strand
 * (the measured 30h case) is impossible to miss.
 */
export const GOAL_STRANDED_WORK_THRESHOLD_MS = 4 * 60 * 60_000;

/** How many stranded items the agenda names individually. The count is never bounded. */
export const GOAL_STRANDED_WORK_SAMPLE = 5;

/** Most ids one refusal will stamp. A brief naming more is not a single placement. */
export const GOAL_PLACEMENT_REFUSAL_MAX_IDS = 10;

/**
 * The claimable spellings. `open` is the unified token; `todo` is its retired
 * spelling, still held by a few un-backfilled rows (work-item-dispatch-states.ts
 * FEATURE_NON_REQUEUE_STATES). `blocked` and `needs-human` are excluded on
 * purpose: those are parked with a recorded reason, not stranded.
 */
export const GOAL_STRANDED_CLAIMABLE_STATES: readonly string[] = ['open', 'todo'];

export interface GoalPlacementRefusalMark {
  /** ISO timestamp of the refusal. */
  at: string;
  /** The resolver's refusal reason, e.g. `goal_max_agents`. */
  reason: string;
  goalId: string;
  /** The session whose launch was refused. */
  launcherOwnerId: string;
  /** The resolver's message, bounded. */
  message: string;
  /** Which launch surface refused. */
  source: string;
}

export interface StrandedGoalWorkRow {
  id: string;
  title: string;
  /** ISO creation time, or null when the row carries no creation stamp. */
  createdAt: string | null;
  placementRefusal: GoalPlacementRefusalMark | null;
}

export interface StrandedGoalWork {
  goalId: string;
  thresholdMs: number;
  /** Every stranded item for the goal. Never bounded by the sample size. */
  total: number;
  /** How many of `total` carry a placement-refusal stamp. */
  refusedCount: number;
  /** Refusal-stamped first, then oldest first; at most {@link GOAL_STRANDED_WORK_SAMPLE}. */
  sample: StrandedGoalWorkRow[];
  /** True when `sample` names fewer items than `total`. */
  truncatedByLimit: boolean;
}

const WORK_ITEM_REF = /\b(?:WI|EI)-\d{3,}\b/g;

/**
 * The work-item ids a launch names: its explicit `feature` / `workItem` binding
 * first, then any WI-/EI- id in its brief. Deduplicated, order-preserving and
 * bounded. Brief ids are only CANDIDATES — the writer stamps an id only after
 * the database confirms it is an open, unassigned item of the refused goal, so a
 * brief that merely mentions an unrelated id stamps nothing.
 */
export function launchNamedWorkItemIds(args: {
  feature?: string | null;
  workItem?: string | null;
  brief?: string | null;
}): string[] {
  const out: string[] = [];
  const add = (id: string | null | undefined) => {
    const trimmed = id?.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  add(args.feature);
  add(args.workItem);
  for (const match of (args.brief ?? '').matchAll(WORK_ITEM_REF)) add(match[0]);
  return out.slice(0, GOAL_PLACEMENT_REFUSAL_MAX_IDS);
}

function parseRefusalMark(raw: unknown): GoalPlacementRefusalMark | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const str = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : '');
  if (!str('at') || !str('reason') || !str('goalId')) return null;
  return {
    at: str('at'),
    reason: str('reason'),
    goalId: str('goalId'),
    launcherOwnerId: str('launcherOwnerId'),
    message: str('message'),
    source: str('source'),
  };
}

function parseStrandedRows(raw: unknown): StrandedGoalWorkRow[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: StrandedGoalWorkRow[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) continue;
    const createdTs = typeof row.createdTs === 'number' ? row.createdTs : Number(row.createdTs);
    out.push({
      id: row.id,
      title: typeof row.title === 'string' ? row.title : '',
      createdAt: Number.isFinite(createdTs) && createdTs > 0 ? new Date(createdTs).toISOString() : null,
      placementRefusal: parseRefusalMark(row.placementRefusal),
    });
  }
  return out;
}

/**
 * The goal's stranded work, measured in one statement so the count and the
 * sample describe the same snapshot. Throws on a read failure: the caller (the
 * obligation reader) turns a throw into an UNKNOWN obligation, never a zero.
 */
export async function readStrandedGoalWork(args: {
  workspaceId: string;
  goalId: string;
  nowMs?: number;
  thresholdMs?: number;
  sql?: Sql;
}): Promise<StrandedGoalWork> {
  const thresholdMs = args.thresholdMs ?? GOAL_STRANDED_WORK_THRESHOLD_MS;
  const cutoffMs = (args.nowMs ?? Date.now()) - thresholdMs;
  const sql = args.sql ?? getOrgPg().sql;
  const rows = await sql<{ total: number; refused: number; sample: unknown }[]>`
    WITH stranded AS (
      SELECT wi.feature_id, wi.title, wi.created_ts,
        CASE WHEN jsonb_typeof(wi.payload->'placementRefusal') = 'object'
          THEN wi.payload->'placementRefusal' END AS refusal
      FROM harness_shared.work_items wi
      WHERE wi.workspace_id = ${args.workspaceId}
        AND wi.goal_id = ${args.goalId}
        AND wi.status = ANY(${[...GOAL_STRANDED_CLAIMABLE_STATES]}::text[])
        AND wi.taken_by IS NULL
        AND wi.lane IS DISTINCT FROM 'observation'
        AND (wi.created_ts < ${cutoffMs}
          OR jsonb_typeof(wi.payload->'placementRefusal') = 'object')
    )
    SELECT
      (SELECT count(*)::int FROM stranded) AS total,
      (SELECT count(*)::int FROM stranded WHERE refusal IS NOT NULL) AS refused,
      coalesce((
        SELECT json_agg(json_build_object(
          'id', s.feature_id, 'title', s.title, 'createdTs', s.created_ts, 'placementRefusal', s.refusal
        ))
        FROM (
          SELECT * FROM stranded
          ORDER BY (refusal IS NULL), created_ts ASC NULLS LAST, feature_id
          LIMIT ${GOAL_STRANDED_WORK_SAMPLE}
        ) s
      ), '[]'::json) AS sample`;
  const row = rows[0] ?? { total: 0, refused: 0, sample: [] };
  const total = Number(row.total ?? 0);
  const sample = parseStrandedRows(row.sample);
  return {
    goalId: args.goalId,
    thresholdMs,
    total,
    refusedCount: Number(row.refused ?? 0),
    sample,
    truncatedByLimit: sample.length < total,
  };
}

export interface RecordGoalPlacementRefusalDeps {
  /** The subset of `ids` that are open, unassigned, non-observation items of `goalId`, with their harness. */
  eligible: (args: { workspaceId: string; goalId: string; ids: string[] }) => Promise<Array<{ id: string; harness: string }>>;
  /** Merge the stamp onto one item; resolves null when the item is gone or already terminal. */
  stamp: (id: string, harness: string, mark: GoalPlacementRefusalMark) => Promise<unknown>;
}

export function defaultRecordGoalPlacementRefusalDeps(sql?: Sql): RecordGoalPlacementRefusalDeps {
  return {
    eligible: async ({ workspaceId, goalId, ids }) => {
      const db = sql ?? getOrgPg().sql;
      const rows = await db<{ feature_id: string; harness_slug: string | null }[]>`
        SELECT feature_id, harness_slug
        FROM harness_shared.work_items
        WHERE workspace_id = ${workspaceId}
          AND goal_id = ${goalId}
          AND feature_id = ANY(${ids}::text[])
          AND status = ANY(${[...GOAL_STRANDED_CLAIMABLE_STATES]}::text[])
          AND taken_by IS NULL
          AND lane IS DISTINCT FROM 'observation'`;
      return rows
        .filter((r) => typeof r.harness_slug === 'string' && r.harness_slug.length > 0)
        .map((r) => ({ id: r.feature_id, harness: r.harness_slug as string }));
    },
    stamp: async (id, harness, mark) => {
      const { mergeWorkItemPayload } = await import('./work-items');
      return mergeWorkItemPayload(id, { placementRefusal: mark }, { harness, requireNonTerminal: true });
    },
  };
}

export interface GoalPlacementRefusalRecord {
  /** Ids the launch named (before eligibility). */
  named: string[];
  /** Ids actually stamped. */
  marked: string[];
  /** A write/read failure, reported in band. A refusal is never turned into a success by this. */
  error: string | null;
}

/**
 * Stamp what a refused goal launch left behind. Best-effort by contract: the
 * caller is ALREADY returning the refusal, so a failure here is reported in the
 * refusal text and never changes the launch outcome.
 */
export async function recordGoalPlacementRefusal(
  args: {
    workspaceId: string;
    goalId: string;
    launcherOwnerId: string;
    reason: string;
    message: string;
    source: string;
    named: string[];
    at?: Date;
  },
  deps: RecordGoalPlacementRefusalDeps = defaultRecordGoalPlacementRefusalDeps(),
): Promise<GoalPlacementRefusalRecord> {
  const named = [...new Set(args.named.map((id) => id.trim()).filter(Boolean))].slice(0, GOAL_PLACEMENT_REFUSAL_MAX_IDS);
  if (!args.workspaceId || !args.goalId || named.length === 0) return { named, marked: [], error: null };
  const mark: GoalPlacementRefusalMark = {
    at: (args.at ?? new Date()).toISOString(),
    reason: args.reason,
    goalId: args.goalId,
    launcherOwnerId: args.launcherOwnerId,
    message: args.message.slice(0, 500),
    source: args.source,
  };
  const marked: string[] = [];
  const failures: string[] = [];
  let eligible: Array<{ id: string; harness: string }>;
  try {
    eligible = await deps.eligible({ workspaceId: args.workspaceId, goalId: args.goalId, ids: named });
  } catch (e) {
    return { named, marked, error: `eligibility read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  for (const item of eligible) {
    try {
      const written = await deps.stamp(item.id, item.harness, mark);
      if (written) marked.push(item.id);
    } catch (e) {
      failures.push(`${item.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { named, marked, error: failures.length ? `stamp failed for ${failures.join('; ')}` : null };
}

/**
 * The sentence appended to a refused launch so the caller knows what its
 * refusal left behind and what the two lawful dispositions are. Empty when the
 * launch named no goal-created item.
 */
export function goalPlacementRefusalNote(record: GoalPlacementRefusalRecord): string {
  if (record.marked.length > 0) {
    const ids = record.marked.join(', ');
    return (
      ` Goal work left unplaced by this refusal: ${ids} stays open in the claimable queue and is now ` +
      `flagged on your goal's stranded-goal-work agenda. Place it again once a seat frees, or drop it ` +
      `with work_items:set_state { state: 'dropped', reason } — do not leave it unassigned.`
    );
  }
  if (record.error) {
    return ` Recording the goal work this refusal left unplaced failed (${record.error}); check ${record.named.join(', ')} yourself.`;
  }
  return '';
}
