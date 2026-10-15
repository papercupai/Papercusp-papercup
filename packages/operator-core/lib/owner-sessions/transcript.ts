/**
 * Owner-session transcript reading — the ONE implementation shared by the
 * desktop conversation stream (`GET /adv/session/thinking`, its JSON
 * `historyPage=1` mode) and the device session routes
 * (mobile-agent-sessions-2026-10-12 P-001; the device route itself is P-003).
 *
 * Moved here from `endpoint-route/routes/harness/streams.ts` so a second route
 * does not have to import a route module, or grow a copy of the paging rules.
 * The stream route imports these back; nothing about the desktop page changes.
 */
import {
  TRANSCRIPT_RENDER_TEXT_CAP,
  capWithMarker,
} from '../transcript-text-caps';
import type { AgentTimelineEntry } from '../cross-boundary-event-contracts';

/** Per-entry text cap for UI-bound thinking entries. A single tool_result can
 *  carry a whole file (hundreds of KB); the pane renders it in a ~120px scroll
 *  box, so ship a bounded excerpt — this also keeps the one-shot `backfill`
 *  lean over the desktop IPC hop. Pure — exported for tests.
 *
 *  This is the RENDER budget, and it is now THE canonical cap: the ingest
 *  store derives its prose cap from it (see ../transcript-text-caps), so
 *  raising it here widens what gets stored rather than leaving the store 4x
 *  tighter than the pane, which is the drift this alias exists to prevent. */
export const THINKING_ENTRY_TEXT_CAP = TRANSCRIPT_RENDER_TEXT_CAP;
export function capEntryText(e: AgentTimelineEntry): AgentTimelineEntry {
  if (typeof e.text !== 'string') return e;
  const capped = capWithMarker(e.text, THINKING_ENTRY_TEXT_CAP);
  return capped === e.text ? e : { ...e, text: capped };
}

/** A stored session_turns speaker → the timeline entry kind. A user/human turn
 *  is the frontend's turn boundary (`prompt`); everything else is `text`. Pure —
 *  exported for tests. */
export function sessionTurnEntryKind(speaker: string | null | undefined): 'prompt' | 'text' {
  return speaker === 'user' || speaker === 'human' ? 'prompt' : 'text';
}

export interface OwnerHistoryCursor {
  at: string;
  sourceKind: string;
  sessionId: string;
  turnIdx: number;
}

export interface OwnerHistoryPage {
  entries: AgentTimelineEntry[];
  anchorIndex: number | null;
  hasMore: boolean;
  cursor: string | null;
}

/** The longest cursor string either caller accepts. */
export const OWNER_HISTORY_CURSOR_MAX_CHARS = 800;

/** Opaque cursor for the complete deterministic owner-history ordering tuple. */
export function encodeOwnerHistoryCursor(cursor: OwnerHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Fail-closed decoder for a caller-supplied owner-history cursor. */
export function decodeOwnerHistoryCursor(raw: string): OwnerHistoryCursor | null {
  if (!raw || raw.length > OWNER_HISTORY_CURSOR_MAX_CHARS) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<OwnerHistoryCursor>;
    if (
      typeof value.at !== 'string'
      || Number.isNaN(Date.parse(value.at))
      || typeof value.sourceKind !== 'string'
      || value.sourceKind.length === 0
      || typeof value.sessionId !== 'string'
      || value.sessionId.length === 0
      || !Number.isInteger(value.turnIdx)
      || value.turnIdx! < 0
    ) return null;
    return value as OwnerHistoryCursor;
  } catch {
    return null;
  }
}

/**
 * The ordinary HUD conversation is an OWNER conversation, not one native
 * transcript file. A carry-respawn keeps the coord owner id and creates a new
 * native session id, so session-keyed backfill necessarily drops every
 * predecessor epoch.
 *
 * Select from session_turns deliberately. It is the user/assistant
 * CONVERSATION store and retains 45 days; session_turn_parts retains 14 days
 * and includes every tool/thinking part. A busy current epoch can fill all 200
 * part slots by itself (measured live while implementing this fix), recreating
 * the exact missing-predecessor symptom despite an owner predicate. Text turns
 * preserve the bounded popup contract while letting prior conversation epochs
 * survive current-epoch tool volume. The live follower remains tied to the
 * resolved current transcript file, so tool activity still appears as it is
 * appended now.
 */
export async function backfillFromOwnerSessionTurns(
  owner: string,
  opts: { cap?: number; cursor?: OwnerHistoryCursor | null } = {},
): Promise<OwnerHistoryPage | null> {
  const cap = Math.max(1, opts.cap ?? 200);
  const cursor = opts.cursor ?? null;
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const textCap = THINKING_ENTRY_TEXT_CAP + 200;
  // Bind cursor timestamps as text before PostgreSQL parses them. A directly
  // inferred timestamptz parameter uses postgres.js's Date serializer, which
  // drops retained microseconds and skips rows at the page boundary.
  const rows = await sql<Array<{
    event_at: string; source_kind: string; session_id: string; turn_idx: number;
    speaker: string | null; text: string | null;
  }>>`
    SELECT to_json(event_at) #>> '{}' AS event_at,
           source_kind, session_id, turn_idx, speaker, left(text, ${textCap}) AS text
      FROM (
        SELECT COALESCE(ts, ingested_at) AS event_at,
               speaker, text, source_kind, session_id, turn_idx
          FROM harness_shared.session_turns
         WHERE owner = ${owner}
           AND (
             ${cursor?.at ?? null}::text::timestamptz IS NULL
             OR (COALESCE(ts, ingested_at), source_kind, session_id, turn_idx)
                < (${cursor?.at ?? null}::text::timestamptz,
                   ${cursor?.sourceKind ?? null}::text,
                   ${cursor?.sessionId ?? null}::text,
                   ${cursor?.turnIdx ?? null}::int)
           )
         ORDER BY event_at DESC,
                  source_kind DESC, session_id DESC, turn_idx DESC
         LIMIT ${cap + 1}
      ) recent
     ORDER BY event_at ASC,
              source_kind ASC, session_id ASC, turn_idx ASC
  `;
  if (rows.length === 0) return null;
  // The query returns the newest cap+1 rows in chronological order. The first
  // row is the one-row look-behind used only to prove another page exists;
  // drop it so adjacent pages neither overlap nor exceed the public page cap.
  const hasMore = rows.length > cap;
  const selected = hasMore ? rows.slice(1) : rows;
  const first = selected[0];
  return {
    entries: selected.map((r) => capEntryText({
      kind: sessionTurnEntryKind(r.speaker),
      text: r.text ?? '',
      ts: r.event_at,
    })),
    anchorIndex: null,
    hasMore,
    cursor: hasMore && first
      ? encodeOwnerHistoryCursor({
          at: first.event_at,
          sourceKind: first.source_kind,
          sessionId: first.session_id,
          turnIdx: first.turn_idx,
        })
      : null,
  };
}

/** One owner-history page as a caller-facing result: a page, or a refusal with
 *  the HTTP status both routes answer with. */
export type OwnerHistoryPageRead =
  | { ok: true; entries: AgentTimelineEntry[]; hasMore: boolean; cursor: string | null }
  | { ok: false; status: 400 | 503; error: string };

/**
 * Read one page of an owner's conversation history from a caller-supplied
 * (untrusted) cursor string. The desktop stream's JSON history page and the
 * device transcript route both answer through this, so a cursor issued by one
 * pages identically on the other.
 */
export async function readOwnerHistoryPage(
  owner: string,
  opts: { cursorRaw?: string | null; cap?: number } = {},
): Promise<OwnerHistoryPageRead> {
  const cursorRaw = (opts.cursorRaw ?? '').slice(0, OWNER_HISTORY_CURSOR_MAX_CHARS + 1);
  const cursor = cursorRaw ? decodeOwnerHistoryCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return { ok: false, status: 400, error: 'invalid historyCursor' };
  try {
    const page = await backfillFromOwnerSessionTurns(owner, {
      cursor,
      ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
    });
    return {
      ok: true,
      entries: page?.entries ?? [],
      hasMore: page?.hasMore ?? false,
      cursor: page?.cursor ?? null,
    };
  } catch {
    return { ok: false, status: 503, error: 'owner history unavailable' };
  }
}
