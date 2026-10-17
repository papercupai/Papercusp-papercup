import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { withBoundedTimeout } from './bounded-timeout';
import { resolveConcreteWorkspaceId } from './workspace-registry';
import type { AgentObligationAgendaRead } from './agent-obligation-reader';

/** Unknown evidence never proves an empty wake. */
export interface WakeDelta {
  directedMail: boolean;
  eventPayload: boolean;
  ownerDirective: boolean;
  heldItemChange: boolean;
  dueObligation: boolean;
}
export function wakeHasNoDelta(delta: WakeDelta | null): boolean {
  return delta !== null && Object.values(delta).every((value) => value === false);
}

/** Reuse the transcript completion clock, orientation's held cursor and the
 * canonical obligation agenda. No new queue or per-wake watermark is written.
 */
export async function readWakeDelta(input: {
  ownerId: string; workspaceId: string; sql?: Sql; nowMs?: number;
  readAgenda?: (input: { workspaceId: string; ownerId: string }) => Promise<AgentObligationAgendaRead>;
}): Promise<WakeDelta | null> {
  const read = async (): Promise<WakeDelta | null> => {
    const sql = input.sql ?? getOrgPg().sql;
    const workspaceId = resolveConcreteWorkspaceId(input.workspaceId);
    const baseline = await sql<Array<{ last_turn_at: Date | string | null; held: string | null }>>`
      SELECT (SELECT max(ts) FROM (
                SELECT ts FROM harness_shared.session_turns
                 WHERE workspace_id IN ('default', ${workspaceId}) AND owner = ${input.ownerId} AND speaker = 'assistant'
                UNION ALL
                SELECT created_at AS ts FROM harness_shared.session_turn_journal
                 WHERE workspace_id = ${workspaceId} AND owner_id = ${input.ownerId}
              ) turns) AS last_turn_at,
             (SELECT committed->>'held' FROM harness_shared.coord_read_cursors
               WHERE workspace_id = ${workspaceId} AND owner_id = ${input.ownerId}
                 AND surface = 'orientation') AS held
    `;
    const prior = baseline[0];
    if (!prior?.last_turn_at || prior.held == null || prior.held === '!unavailable') return null;
    const lastTurnMs = new Date(prior.last_turn_at).getTime();
    if (!Number.isFinite(lastTurnMs)) return null;
    const lastTurn = new Date(lastTurnMs).toISOString();
    const priorHeldIds = prior.held.split(',').filter(Boolean).map((entry) => entry.split(':')[0]!);
    const readAgenda = input.readAgenda ?? (await import('./agent-obligation-reader')).readAgentObligationAgenda;
    const [rows, obligation] = await Promise.all([
      sql<Array<{ mail: boolean; event: boolean; directive: boolean; held: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM harness_shared.coord_event_log
                 WHERE workspace_id = ${workspaceId} AND surface = 'messages'
                   AND ts > ${lastTurn}::timestamptz AND (body->'to') ? ${input.ownerId}) AS mail,
               EXISTS (SELECT 1 FROM harness_shared.event_wake_deliveries d
                 JOIN harness_shared.event_awaits a ON a.workspace_id = d.workspace_id AND a.id = d.await_id
                 WHERE d.workspace_id = ${workspaceId} AND d.subscriber_id = ${input.ownerId}
                   AND a.event_key NOT LIKE 'coord:inbox-wake:%'
                   AND (d.created_at > ${lastTurn}::timestamptz OR d.status IN ('pending','parked','delivering'))) AS event,
               EXISTS (SELECT 1 FROM harness_shared.owner_directives
                 WHERE workspace_id = ${workspaceId} AND recorded_by = ${input.ownerId}
                   AND created_at > ${lastTurn}::timestamptz) AS directive,
               EXISTS (SELECT 1 FROM harness_shared.work_items
                 WHERE workspace_id = ${workspaceId}
                   AND (taken_by = ${input.ownerId} OR feature_id = ANY(${priorHeldIds}::text[]))
                   AND (updated_ts > ${lastTurnMs} OR last_progress_at > ${lastTurn}::timestamptz)) AS held
      `,
      readAgenda({ workspaceId, ownerId: input.ownerId }),
    ]);
    const row = rows[0];
    if (!row || obligation.degradedSources.length || obligation.agenda.evaluations.some((item) => item.status === 'unknown')) return null;
    const nowMs = input.nowMs ?? Date.now();
    const dueObligation = obligation.agenda.evaluations.some((item) =>
      (item.status === 'due' || item.status === 'in-progress') &&
      (!item.dueAt || !Number.isFinite(Date.parse(item.dueAt)) || Date.parse(item.dueAt) <= nowMs));
    return { directedMail: row.mail, eventPayload: row.event, ownerDirective: row.directive,
      heldItemChange: row.held, dueObligation };
  };
  try {
    return (await withBoundedTimeout(read(), { fallback: null, timeoutMs: 4_000, label: 'loop-wake-delta' })).value;
  } catch { return null; }
}
