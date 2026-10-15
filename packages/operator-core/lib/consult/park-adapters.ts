/**
 * Park adapters (consult-backed-parking-2026-10-12 P-006, WI-6554700010009494).
 *
 * Binds the pure park resolver (park-resolver.ts) to storage, per the contract agreed
 * with P-004/P-005 (plan Decision D-013):
 *  - park IDENTITY rides consult_state.routing.cascade as DecisionReviewCascadeMeta,
 *    read with decisionReviewMetaFromRouting (decision-review.ts);
 *  - the consult id is consult_state.conversation_id;
 *  - reviewer stances are consult_post_meta.stance (migration 1482), responder =
 *    author_id, at = created_at;
 *  - park PROGRESS (outcomes, parker adopt/rebut, owner answer) is
 *    consult_state.park_state (migration 1483). It is NOT kept on routing because the
 *    cascade's min-answers refill rewrites routing wholesale from an in-memory copy.
 *
 * `parkStateFromRows` is pure and unit-tested; the SQL helpers are thin and covered by
 * the real-Postgres integration test (P-009, park.integration.test.ts).
 */
import type { Sql } from 'postgres';
import { decisionReviewMetaFromRouting, type DecisionReviewStance } from './decision-review';
import {
  runParkTriggers,
  TERMINAL_PARK_VERDICTS,
  type OwnerAnswer,
  type ParkerResponse,
  type ParkOutcomeRecord,
  type ParkReply,
  type ParkState,
  type ParkTriggerDeps,
  type ParkTriggerResult,
} from './park-resolver';

/** The stored park progress (consult_state.park_state). */
export interface StoredParkState {
  outcomes?: ParkOutcomeRecord[];
  parkerResponses?: ParkerResponse[];
  ownerQuestionOpened?: boolean;
  /** The coord:ask-owner conversation the park's owner question opened (R-17). */
  ownerConversationId?: string | null;
  ownerAnswer?: OwnerAnswer | null;
}

export interface ParkConsultRow {
  conversation_id: string;
  question: string;
  state: string;
  closed_at: string | Date | null;
  cascade_cursor: number;
  routing: unknown;
  park_state: StoredParkState | string | null;
}

export interface ParkPostRow {
  post_id: number | string;
  author_id: string;
  created_at: string | Date;
  stance: DecisionReviewStance | string | null;
}

/** Consult states in which the review cascade can still ask another reviewer. */
const OPEN_CONSULT_STATES = new Set(['routing', 'awaiting_responder', 'active']);

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function parseJson<T>(v: T | string | null | undefined): T | null {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

function selectedCount(routing: unknown): number {
  const snap = parseJson<{ selection?: { selected?: unknown } }>(routing as never);
  const selected = snap?.selection?.selected;
  return Array.isArray(selected) ? selected.length : 0;
}

/** A stored stance as the resolver's reply shape; null for a malformed stance. */
export function parkReplyFromPost(post: ParkPostRow): ParkReply | null {
  const stance = parseJson<DecisionReviewStance>(post.stance);
  if (!stance || typeof stance !== 'object') return null;
  const base = { id: String(post.post_id), responderOwnerId: post.author_id, at: iso(post.created_at) };
  if (stance.position === 'support' || stance.position === 'no-view') {
    return { ...base, stance: stance.position, reason: stance.reason ?? null, alternative: null, basis: null };
  }
  if (stance.position !== 'object') return null;
  switch (stance.basis) {
    case 'alternative':
      return { ...base, stance: 'object', basis: 'alternative', reason: stance.reason, alternative: stance.alternative };
    case 'hazard':
      return {
        ...base,
        stance: 'object',
        basis: 'hazard',
        reason: `${stance.reason} (evidence: ${stance.evidence.join(', ')})`,
        alternative: null,
      };
    case 'owner-authority':
      return {
        ...base,
        stance: 'object',
        basis: 'owner-authority',
        reason: stance.reason ?? `Owner-authority topic: ${stance.topic}`,
        alternative: null,
      };
    default:
      return null;
  }
}

/**
 * Map one consult row plus its stance-bearing posts onto the resolver's ParkState.
 * Returns null when the consult is not a decision review (no park identity).
 */
export function parkStateFromRows(consult: ParkConsultRow, posts: readonly ParkPostRow[]): ParkState | null {
  const meta = decisionReviewMetaFromRouting(consult.routing);
  if (!meta) return null;
  const stored = parseJson<StoredParkState>(consult.park_state) ?? {};
  const replies = posts
    .filter((p) => p.author_id !== meta.setterId)
    .map(parkReplyFromPost)
    .filter((r): r is ParkReply => r !== null);
  const consultOpen = consult.closed_at == null && OPEN_CONSULT_STATES.has(consult.state);
  const total = selectedCount(consult.routing);
  // The cascade has nobody left to ask: the consult closed/expired, or the last
  // selected reviewer is the current one and has already replied.
  const lastSlotAnswered = total > 0 && consult.cascade_cursor >= total - 1 && replies.length >= total;
  return {
    consultId: consult.conversation_id,
    workItemId: meta.workItemId,
    blockerRef: parkBlockerRef(consult.conversation_id),
    parkerOwnerId: meta.setterId,
    question: consult.question,
    defaultAction: meta.defaultAction,
    deadlineAt: meta.deadlineAt,
    ownerAuthority: meta.ownerAuthorityTopic !== null,
    ownerAuthorityTopic: meta.ownerAuthorityTopic,
    replies,
    parkerResponses: stored.parkerResponses ?? [],
    ownerAnswer: stored.ownerAnswer ?? null,
    reviewersExhausted: !consultOpen || lastSlotAnswered,
    outcomes: stored.outcomes ?? [],
    ownerQuestionOpened: stored.ownerQuestionOpened === true,
  };
}

/** The blocker ref a park's product-decision blocker carries (set_blocker, P-005). */
export function parkBlockerRef(consultId: string): string {
  return `consult:${consultId}`;
}

// ── SQL ──────────────────────────────────────────────────────────────────────

/** routing may be stored as a jsonb STRING by older writers; normalise in SQL. */
const ROUTING_JSONB = `(CASE WHEN jsonb_typeof(routing) = 'string' THEN (routing #>> '{}')::jsonb ELSE routing END)`;

export async function loadParkState(sql: Sql, workspaceId: string, consultId: string): Promise<ParkState | null> {
  const rows = await sql<ParkConsultRow[]>`
    SELECT conversation_id, question, state, closed_at, cascade_cursor, routing, park_state
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${consultId}`;
  const consult = rows[0];
  if (!consult) return null;
  if (!decisionReviewMetaFromRouting(consult.routing)) return null;
  const posts = await sql<ParkPostRow[]>`
    SELECT pm.post_id, pm.author_id, pm.created_at, pm.stance
      FROM harness_shared.consult_post_meta pm
     WHERE pm.workspace_id = ${workspaceId} AND pm.conversation_id = ${consultId}
       AND pm.stance IS NOT NULL
     ORDER BY pm.created_at, pm.post_id`;
  return parkStateFromRows(consult, posts);
}

/** Append one park outcome; an owner-deciding outcome also marks the owner question opened. */
export async function appendParkOutcome(
  sql: Sql,
  workspaceId: string,
  consultId: string,
  outcome: ParkOutcomeRecord,
): Promise<void> {
  const opensOwnerQuestion = outcome.verdict === 'owner-deciding';
  await sql`
    UPDATE harness_shared.consult_state
       SET park_state = jsonb_set(
             jsonb_set(COALESCE(park_state, '{}'::jsonb), '{outcomes}',
                       COALESCE(park_state->'outcomes', '[]'::jsonb) || jsonb_build_array(${sql.json(outcome as never)}::jsonb)),
             '{ownerQuestionOpened}',
             to_jsonb(${opensOwnerQuestion}::boolean OR COALESCE((park_state->>'ownerQuestionOpened')::boolean, false))),
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${consultId}`;
}

/** Record the parked agent's adopt/rebut (consult:reply parkResponse). */
export async function appendParkerResponse(
  sql: Sql,
  workspaceId: string,
  consultId: string,
  response: ParkerResponse,
): Promise<void> {
  await sql`
    UPDATE harness_shared.consult_state
       SET park_state = jsonb_set(COALESCE(park_state, '{}'::jsonb), '{parkerResponses}',
             COALESCE(park_state->'parkerResponses', '[]'::jsonb) || jsonb_build_array(${sql.json(response as never)}::jsonb)),
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${consultId}`;
}

/** Record the owner's answer. The FIRST answer wins (R-18); returns false when one already exists. */
export async function recordParkOwnerAnswer(
  sql: Sql,
  workspaceId: string,
  consultId: string,
  answer: OwnerAnswer,
): Promise<boolean> {
  const rows = await sql`
    UPDATE harness_shared.consult_state
       SET park_state = jsonb_set(COALESCE(park_state, '{}'::jsonb), '{ownerAnswer}', ${sql.json(answer as never)}::jsonb),
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${consultId}
       AND COALESCE(park_state->'ownerAnswer', 'null'::jsonb) = 'null'::jsonb
     RETURNING conversation_id`;
  return rows.length > 0;
}

/** Remember the owner question's conversation so its answer can be read back (R-18). */
export async function setParkOwnerConversation(
  sql: Sql,
  workspaceId: string,
  consultId: string,
  ownerConversationId: string,
): Promise<void> {
  await sql`
    UPDATE harness_shared.consult_state
       SET park_state = jsonb_set(COALESCE(park_state, '{}'::jsonb), '{ownerConversationId}', to_jsonb(${ownerConversationId}::text)),
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${consultId}`;
}

/** Parks whose owner question is open and has no recorded answer yet. */
export async function findParksAwaitingOwner(
  sql: Sql,
  limit: number,
): Promise<Array<{ workspace_id: string; conversation_id: string; owner_conversation_id: string; parker_id: string }>> {
  return sql<Array<{ workspace_id: string; conversation_id: string; owner_conversation_id: string; parker_id: string }>>`
    SELECT workspace_id, conversation_id,
           park_state->>'ownerConversationId' AS owner_conversation_id,
           ${sql.unsafe(ROUTING_JSONB)} #>> '{cascade,setterId}' AS parker_id
      FROM harness_shared.consult_state
     WHERE park_state->>'ownerConversationId' IS NOT NULL
       AND COALESCE(park_state->'ownerAnswer', 'null'::jsonb) = 'null'::jsonb
     ORDER BY updated_at
     LIMIT ${limit}`;
}

/**
 * The owner-answer leg (R-18): read each open owner question's answer and, when one
 * exists, record it (first answer wins) and resolve the park immediately.
 */
export async function pollParkOwnerAnswers(opts: {
  sql: Sql;
  seamsFor: (workspaceId: string) => ParkEffectSeams;
  readAnswer: (input: {
    workspaceId: string;
    conversationId: string;
    askerId: string;
  }) => Promise<{ answered: boolean; answer: string | null }>;
  now?: string;
  limit?: number;
}): Promise<ParkSweepResult> {
  const now = opts.now ?? new Date().toISOString();
  const limit = opts.limit ?? 100;
  const waiting = await findParksAwaitingOwner(opts.sql, limit);
  const result: ParkSweepResult = { resolved: [], failures: [], saturated: waiting.length >= limit };
  for (const row of waiting) {
    try {
      const ans = await opts.readAnswer({
        workspaceId: row.workspace_id,
        conversationId: row.owner_conversation_id,
        askerId: row.parker_id,
      });
      if (!ans.answered || !ans.answer?.trim()) continue;
      await recordParkOwnerAnswer(opts.sql, row.workspace_id, row.conversation_id, { at: now, text: ans.answer });
      const r = await runParkTriggersForConsult(opts.sql, row.workspace_id, row.conversation_id, opts.seamsFor(row.workspace_id), now);
      if (r) result.resolved.push(r);
    } catch (e) {
      result.failures.push({ conversationId: row.conversation_id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/**
 * Parks the deadline sweep must resolve: decision-review consults (open OR closed —
 * the review cascade can expire before the park's deadline) whose deadline has passed
 * and which have no settling or owner-deciding outcome yet.
 */
export async function findDueParks(
  sql: Sql,
  nowIso: string,
  limit: number,
): Promise<Array<{ workspace_id: string; conversation_id: string }>> {
  return sql<Array<{ workspace_id: string; conversation_id: string }>>`
    SELECT workspace_id, conversation_id
      FROM harness_shared.consult_state
     WHERE ${sql.unsafe(ROUTING_JSONB)} #>> '{cascade,flavor}' = 'decision-review'
       AND (${sql.unsafe(ROUTING_JSONB)} #>> '{cascade,deadlineAt}')::timestamptz <= ${nowIso}::timestamptz
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(park_state->'outcomes', '[]'::jsonb)) o
          WHERE o->>'verdict' IN ('proceed', 'adopted', 'owner-decided', 'owner-deciding'))
     ORDER BY (${sql.unsafe(ROUTING_JSONB)} #>> '{cascade,deadlineAt}')::timestamptz
     LIMIT ${limit}`;
}

// ── trigger wiring ───────────────────────────────────────────────────────────

/** The side effects that live outside the consult tables (owned by other lanes). */
export interface ParkEffectSeams {
  emitVerdict: ParkTriggerDeps['emitVerdict'];
  clearBlocker: ParkTriggerDeps['clearBlocker'];
  advanceCascade: ParkTriggerDeps['advanceCascade'];
  askOwner: ParkTriggerDeps['askOwner'];
}

export function makeParkTriggerDeps(sql: Sql, workspaceId: string, seams: ParkEffectSeams): ParkTriggerDeps {
  return {
    loadPark: (consultId) => loadParkState(sql, workspaceId, consultId),
    recordOutcome: (state, outcome) => appendParkOutcome(sql, workspaceId, state.consultId, outcome),
    ...seams,
  };
}

/** Resolve one consult's park now. Null when the consult is not a park. */
export function runParkTriggersForConsult(
  sql: Sql,
  workspaceId: string,
  consultId: string,
  seams: ParkEffectSeams,
  now?: string,
): Promise<ParkTriggerResult | null> {
  return runParkTriggers(makeParkTriggerDeps(sql, workspaceId, seams), consultId, now);
}

export interface ParkSweepResult {
  resolved: ParkTriggerResult[];
  failures: Array<{ conversationId: string; error: string }>;
  saturated: boolean;
}

/**
 * The deadline leg (R-5): resolve every due park. Called from the consult expiry
 * sweep each tick. One park's failure never stops the others; it is retried next tick
 * because nothing was recorded for it.
 */
export async function sweepDueParks(opts: {
  sql: Sql;
  seamsFor: (workspaceId: string) => ParkEffectSeams;
  now?: string;
  limit?: number;
}): Promise<ParkSweepResult> {
  const now = opts.now ?? new Date().toISOString();
  const limit = opts.limit ?? 100;
  const due = await findDueParks(opts.sql, now, limit);
  const result: ParkSweepResult = { resolved: [], failures: [], saturated: due.length >= limit };
  for (const row of due) {
    try {
      const r = await runParkTriggersForConsult(opts.sql, row.workspace_id, row.conversation_id, opts.seamsFor(row.workspace_id), now);
      if (r) result.resolved.push(r);
    } catch (e) {
      result.failures.push({ conversationId: row.conversation_id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/** Is this verdict one after which the park needs nothing more from the sweep? */
export function parkSettled(state: Pick<ParkState, 'outcomes'>): boolean {
  return state.outcomes.some((o) => TERMINAL_PARK_VERDICTS.has(o.verdict));
}
