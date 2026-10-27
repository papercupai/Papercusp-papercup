/**
 * DB half of the `repeat_report_no_delta` rail (WI-6554700010029331). The pure
 * judgement lives in ./repeat-report; this module reads what it judges against:
 *
 *   - the writer's own messages to any of these recipients inside the window
 *     (coord_event_log, scoped through coordSql()/coordWorkspaceId() like every
 *     other targeted coord-log read; `body->'to' ?|` uses coord_event_log_msgs_to_gin);
 *   - the current recipient-visible state of every cited work item.
 *
 * Every read fails OPEN: an unreadable input returns null and the message is
 * sent unstamped. A message is refused only when a READABLE history shows it
 * is a no-delta repeat.
 */
import { getOrgPg } from '@papercusp/db-org';
import { coordHasPgFastPath, coordScopeReady, coordSql, coordWorkspaceId } from './log';
import {
  judgeRepeatReport,
  readCitedItemStates,
  CITED_ITEM_STATES_FIELD,
  REPEAT_REPORT_PRIOR_SCAN_CAP,
  REPEAT_REPORT_WINDOW_MS,
  type ItemStateRow,
  type PriorSend,
  type RepeatReportVerdict,
} from './repeat-report';

export interface RepeatReportReads {
  readPriorSends(input: { from: string; to: readonly string[]; sinceMs: number }): Promise<PriorSend[] | null>;
  readItemStates(input: { workspaceId: string; refs: readonly string[] }): Promise<Map<string, ItemStateRow> | null>;
}

const failOpen = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/** Postgres-backed reads. */
export const pgRepeatReportReads: RepeatReportReads = {
  async readPriorSends({ from, to, sinceMs }) {
    if (to.length === 0) return [];
    if (!coordHasPgFastPath()) return null;
    await coordScopeReady();
    const sql = coordSql();
    const rows = await sql<
      { msg_id: string; ts: Date | string; to_ids: unknown; summary: string | null; body_text: string | null; states: unknown }[]
    >`
      SELECT e.msg_id,
             e.ts,
             e.body->'to' AS to_ids,
             e.body->>'summary' AS summary,
             e.body->>'body' AS body_text,
             e.body->${CITED_ITEM_STATES_FIELD} AS states
        FROM harness_shared.coord_event_log e
       WHERE e.workspace_id = ${coordWorkspaceId()}
         AND e.surface = 'messages'
         AND e.ts >= to_timestamp(${sinceMs}::double precision / 1000)
         AND e.body->>'kind' = 'message'
         AND e.body->>'from' = ${from}
         AND jsonb_typeof(e.body->'to') = 'array'
         AND e.body->'to' ?| ${[...to]}::text[]
       ORDER BY e.ts DESC
       LIMIT ${REPEAT_REPORT_PRIOR_SCAN_CAP}`;
    return rows.map((row) => ({
      msgId: row.msg_id,
      ts: isoOrNull(row.ts) ?? new Date(0).toISOString(),
      to: Array.isArray(row.to_ids) ? row.to_ids.filter((id): id is string => typeof id === 'string') : [],
      text: `${row.summary ?? ''}\n${row.body_text ?? ''}`,
      citedItemStates: readCitedItemStates(row.states),
    }));
  },
  async readItemStates({ workspaceId, refs }) {
    if (refs.length === 0) return new Map();
    if (!workspaceId) return null;
    const rows = await getOrgPg().sql<
      {
        ref: string;
        status: string;
        holder: string | null;
        state_changed_at: Date | string | null;
        taken_at: Date | string | null;
        last_released_at: Date | string | null;
        admitted_at: Date | string | null;
        active_blockers: number | string | null;
      }[]
    >`
      SELECT w.feature_id AS ref,
             w.status,
             w.taken_by AS holder,
             w.state_changed_at,
             w.taken_at,
             w.last_released_at,
             w.admitted_at,
             (SELECT count(*)
                FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(w.payload->'externalBlockers') = 'array'
                            THEN w.payload->'externalBlockers' ELSE '[]'::jsonb END) AS blocker
               WHERE COALESCE(blocker->>'status', 'active') = 'active') AS active_blockers
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${workspaceId} AND w.feature_id = ANY(${[...refs]}::text[])`;
    return new Map(
      rows.map((row) => [
        row.ref,
        {
          ref: row.ref,
          status: row.status,
          holder: row.holder,
          stateChangedAt: isoOrNull(row.state_changed_at),
          takenAt: isoOrNull(row.taken_at),
          lastReleasedAt: isoOrNull(row.last_released_at),
          admittedAt: isoOrNull(row.admitted_at),
          activeBlockers: Number(row.active_blockers ?? 0),
        },
      ]),
    );
  },
};

/**
 * Read and judge one send. Never throws. `judge:false` (a threaded reply) only
 * reads the item states for the stamp.
 */
export async function evaluateRepeatReport(
  input: {
    from: string;
    to: readonly string[];
    refs: readonly string[];
    workspaceId: string;
    judge: boolean;
    ownMsgId?: string;
    nowMs?: number;
  },
  reads: RepeatReportReads = pgRepeatReportReads,
): Promise<RepeatReportVerdict> {
  if (input.refs.length === 0) return { kind: 'pass', stamps: [] };
  const nowMs = input.nowMs ?? Date.now();
  const [priors, current] = await Promise.all([
    input.judge
      ? failOpen(() => reads.readPriorSends({ from: input.from, to: input.to, sinceMs: nowMs - REPEAT_REPORT_WINDOW_MS }))
      : Promise.resolve([] as PriorSend[]),
    failOpen(() => reads.readItemStates({ workspaceId: input.workspaceId, refs: input.refs })),
  ]);
  return judgeRepeatReport({
    refs: input.refs,
    to: input.to,
    priors: priors ?? [],
    current,
    // An unreadable history can only ever pass: judge against nothing.
    judge: input.judge && priors !== null,
    ownMsgId: input.ownMsgId,
    nowMs,
  });
}
