/**
 * cascade-core.ts — the ALWAYS-ADVANCE consult cascade (plan
 * consult-min-max-and-rubric-vetting-2026-08-17, P-013; owner ruling D-005).
 *
 * With max N selected responders, the chain advances after responder k
 * REPLIES (any kind), DECLINES, or EXPIRES unanswered: the next selected
 * responder is woken with the original question PLUS a bounded digest of the
 * feedback gathered so far — so each later reviewer builds on (or contests)
 * earlier reviews, and a consult with max 5 actually collects up to 5
 * perspectives. The chain ends at menu exhaustion (or max, which bounded the
 * menu at selection time). Advance is SERVER-driven from the reply/decline
 * verbs + the expiry sweep — a silent responder cannot stall the chain.
 *
 * Shared by consult-verbs-core (reply/decline) and consult-expiry-core (the
 * sweep) so the advance semantics cannot drift between the three triggers.
 * All responders reply into the ONE consult conversation — the thread IS the
 * accumulator; cascade_digest is the bounded rendering carried on each wake.
 *
 * Schema: migration 844 (cascade_cursor + cascade_digest on consult_state).
 */
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { HARD_BLOCKED_EXPIRY_MS, PROCEED_EXPIRY_MS } from './get-feedback-core';
import { qualifyingScoreOf, snapshotCandidateQualifies } from './relevance-router';
import { consultCurrentReviewContext, consultResponderVerbMenu } from './responder-verb-menu';
import { gradingCascadeMetaFromRouting, gradingCascadeWakeCopy, sourceAuditCascadeMetaFromRouting, sourceAuditWakeCopy } from './grading-cascade';

/** Chain events a digest entry can record: the responder reply kinds, plus
 * the non-reply advance triggers.
 *
 * `dispatch_failed` is D-002's replacement for `wake_failed` — the trigger is no
 * longer "the wake reached nobody" but "every allowed model was exhausted for
 * this expert's transcript". `wake_failed` is RETAINED because it is persisted in
 * `consult_state.cascade_digest` on historical rows, and a reader that drops it
 * would render those digests as having no reason at all. */
export type CascadeEventKind =
  | 'answer'
  | 'clarifying_question'
  | 'new_fact'
  | 'decline'
  | 'expired'
  | 'dispatch_failed'
  | 'wake_failed';

export interface CascadeDigestEntry {
  ownerId: string;
  kind: CascadeEventKind;
  at: string;
  excerpt: string;
}

/** Per-entry excerpt bound — the digest is a pointer into the thread, never a
 * transcript copy (the wake body carries the conversation ref for the rest). */
export const CASCADE_EXCERPT_MAX = 400;
/** Digest entries kept (oldest dropped) — covers the widest tool-layer menu
 * (max_agents ≤ 8) with room for decline/expiry events alongside replies. */
export const CASCADE_DIGEST_MAX_ENTRIES = 16;

/** One selection.selected entry from the persisted routing snapshot
 * (relevance-router selectionSnapshot — the shape is migration-comment-owned). */
export interface CascadeSelectionEntry {
  ownerId: string;
  via: 'floor' | 'minimum';
  /** Stage-2 comparison score (relevance × freshness) — the ORDERING number. */
  score: number;
  /** Stage-1 qualification score. Recorded beside `via` because `via` is
   * DERIVED from it: a record carrying only the comparison score cannot be
   * audited against the floors it claims to have cleared. */
  relevance: number;
  similarity: number;
  liveness: string;
  /** Exact session turns that made this expert relevant. Kept through the
   * cascade so a cross-backend conversion carries only its evidence span. */
  evidence?: Array<{
    session_id: string;
    turn_idx: number;
    ts?: string | null;
    sim?: number;
    lexicalRank?: number;
  }>;
  /**
   * D-002: the identity that will actually POST for this selectee, stamped when
   * dispatch launches the answering session. It differs from `ownerId` on a FORK
   * — psu gives a fork a new coord id so it cannot collide with a still-live
   * original — and equals it on a cross-backend conversion.
   *
   * This is the participant key for the answering session. `ownerId` keeps
   * naming the expert whose KNOWLEDGE was routed, which is what the routing
   * provenance, the cascade cursor and the requester's hint all mean by it; only
   * the reply gate needs to know who holds the keyboard.
   */
  answeringOwnerId?: string;
  /** RETIRED with the revival apparatus (D-002/D-010) — still READ from
   * historical persisted snapshots, never written. */
  revived?: boolean;
  /** RETIRED with the revival apparatus (D-002/D-010) — read-only, as above. */
  revivalPending?: boolean;
  /** WI-39861: selectee entered on the ONE post-exhaustion refill round. */
  refill?: boolean;
}

/** The selected cascade menu from a persisted routing snapshot. Tolerant of
 * string jsonb (driver may hand it back unparsed) and of pre-min/max rows
 * (no selection block ⇒ empty menu ⇒ every advance exhausts). */
export function selectionFromRouting(routing: unknown): CascadeSelectionEntry[] {
  const snap = typeof routing === 'string' ? (JSON.parse(routing) as unknown) : routing;
  const selected = (snap as { selection?: { selected?: unknown } } | null)?.selection?.selected;
  if (!Array.isArray(selected)) return [];
  return selected.filter(
    (e): e is CascadeSelectionEntry => Boolean(e) && typeof (e as { ownerId?: unknown }).ownerId === 'string',
  );
}

/** Normalize a persisted cascade_digest column value. */
export function digestFromRow(raw: unknown): CascadeDigestEntry[] {
  const v = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is CascadeDigestEntry => Boolean(e) && typeof (e as { ownerId?: unknown }).ownerId === 'string',
  );
}

export function makeDigestEntry(ownerId: string, kind: CascadeEventKind, at: string, text: string): CascadeDigestEntry {
  const t = text.replace(/\s+/g, ' ').trim();
  return { ownerId, kind, at, excerpt: t.length <= CASCADE_EXCERPT_MAX ? t : `${t.slice(0, CASCADE_EXCERPT_MAX - 1)}…` };
}

/**
 * WI-10005360: did the min-ANSWERS refill round (WI-39861) launch NOTHING?
 *
 * The ONE-round guard bounds how many answering sessions a refill may LAUNCH. A
 * pick refused before launch (cooldown, ownership, transcript preflight, a walled
 * backend) is recorded as `dispatch_failed` under the expert's own owner id and
 * costs no session. Treating it as a spent round ended a live consult as
 * `refill-spent` while five launchable experts stayed untried (conv-muqlw2ay).
 *
 * True only when the stamp names at least one added owner AND every added owner's
 * digest outcomes are exclusively `dispatch_failed`. Anything else is a spent
 * round, conservatively: an empty/unreadable `added` list (legacy stamps), an
 * owner with no digest record at all (e.g. a fork launched and posted under its
 * own identity), or any launched outcome (answer/decline/expired/...).
 */
export function refillRoundLaunchedNothing(refill: unknown, digest: CascadeDigestEntry[]): boolean {
  const added = (refill as { added?: unknown } | null | undefined)?.added;
  if (!Array.isArray(added) || added.length === 0) return false;
  return added.every((ownerId) => {
    if (typeof ownerId !== 'string') return false;
    const outcomes = digest.filter((e) => e.ownerId === ownerId);
    return outcomes.length > 0 && outcomes.every((e) => e.kind === 'dispatch_failed');
  });
}

/**
 * Everything a wake-copy writer is entitled to know about the advance it is
 * announcing. Deliberately data-only: the copy seam decides WORDS, never who is
 * woken, when, or under what CAS guard.
 */
export interface CascadeWakeContext {
  question: string;
  /** Existing persisted selection policy, used only to render review context. */
  policy?: string;
  conversationId: string;
  /** 1-based position in the menu of the responder being woken. */
  position: number;
  menuSize: number;
  next: CascadeSelectionEntry;
  digest: CascadeDigestEntry[];
  /** Set when this wake is the ONE post-exhaustion menu extension, naming which
   * kind — the copy may want to say so; the mechanism does not change. */
  extension?: 'min-answers refill' | 'refill-exhaustion revival';
}

/** Notification summary + body for one cascade advance. */
export interface CascadeWakeCopy {
  summary: string;
  body: string;
}

/**
 * The wake-copy seam (unified-responder-selection-critique-and-grading-2026-08-30
 * D-005). ONE advance path serves every cascading flow, but not every flow is a
 * consult: acceptance grading advances through this same CAS-guarded cursor and
 * must wake its next grader with grading instructions, not a consult verb menu.
 * Copy is the ONLY thing that legitimately differs between them, so copy is the
 * only thing that varies — a second advance loop for grading is exactly what
 * D-005 forbids.
 */
export type CascadeWakeCopyWriter = (ctx: CascadeWakeContext) => CascadeWakeCopy;

/** The next selectee's wake body: why-them framing (honest for a minimum-fill
 * pick, mirroring get-feedback-core's D-002 body), the prior-feedback digest,
 * and the typed-reply protocol. */
export function cascadeWakeBody(input: CascadeWakeContext): string {
  const { next } = input;
  const reviewCopy = consultCurrentReviewContext(input.policy);
  const why =
    next.via === 'minimum'
      ? `Selected as BEST-AVAILABLE reviewer (relevance ${qualifyingScoreOf(next).toFixed(2)}, sim ${next.similarity.toFixed(2)} — BELOW the relevance floor). This is a FIRST-PRINCIPLES review request, not a claim your transcript covers it — do NOT decline solely for lack of context.`
      : `Routed to you by transcript relevance (relevance ${qualifyingScoreOf(next).toFixed(2)}, sim ${next.similarity.toFixed(2)}).` +
        (reviewCopy ? '' : ' Validate relevance first; answer FROM your transcript, citing evidence.');
  const digestLines =
    input.digest.length === 0
      ? '(none yet — every earlier selectee declined or expired unanswered)'
      : input.digest
          .map((e) => `- ${e.ownerId} (${e.kind}): ${e.excerpt}`)
          .join('\n');
  return (
    `Consult cascade — you are reviewer ${input.position}/${input.menuSize} (the chain advances after each reply, decline, or expiry; D-005).\n` +
    `QUESTION: ${input.question}\n` +
    (reviewCopy ? `${reviewCopy}\n` : '') +
    `${why}\n` +
    `FEEDBACK SO FAR (build on it or contest it — the full thread is conversation ${input.conversationId}):\n` +
    `${digestLines}\n` +
    consultResponderVerbMenu({
      conversationId: input.conversationId,
      evidenceNote:
        'answer requires evidence; labeled first-principles reasoning is admissible for a best-available pick',
    })
  );
}

/** The DEFAULT copy writer — the consult cascade's own. Every pre-existing
 * caller gets exactly the summary and body it got before the seam existed. */
export const consultCascadeWakeCopy: CascadeWakeCopyWriter = (ctx) => ({
  summary:
    `🧭 consult cascade (reviewer ${ctx.position}/${ctx.menuSize}` +
    `${ctx.extension ? `, ${ctx.extension}` : ''}): ${ctx.question.replace(/\s+/g, ' ').slice(0, 72)}`,
  body: cascadeWakeBody(ctx),
});

/**
 * Resolve the copy writer FROM THE ROW, not from the caller.
 *
 * Deliberately derived rather than passed as a parameter. Three of the four
 * advance triggers are generic — the decline verb, the expiry sweep and a
 * failed-wake advance all move whatever cursor they find, and none of them has
 * any way to know it is holding an acceptance-grading cascade. A `wakeCopy`
 * argument would therefore have been correct only on the triggers that happen to
 * know, and a grader woken by an expiry would silently receive consult copy
 * telling them to answer from their transcript. Reading the flavour off the
 * snapshot the advance is already parsing makes that unrepresentable.
 */
export function cascadeWakeCopyForRouting(routing: unknown): CascadeWakeCopyWriter {
  const audit = sourceAuditCascadeMetaFromRouting(routing);
  if (audit) return (ctx) => sourceAuditWakeCopy(audit, ctx.conversationId);
  const grading = gradingCascadeMetaFromRouting(routing);
  if (grading) return gradingCascadeWakeCopy(grading);
  let snapshot: { policy?: unknown } | null;
  try { snapshot = (typeof routing === 'string' ? JSON.parse(routing) : routing) as typeof snapshot; }
  catch { snapshot = null; }
  const policy = typeof snapshot?.policy === 'string' ? snapshot.policy : undefined;
  return policy ? (ctx) => consultCascadeWakeCopy({ ...ctx, policy }) : consultCascadeWakeCopy;
}

/**
 * The consult DELIVERY seam (D-002/D-010/D-011). Prod binds the fork/convert
 * dispatcher (`makeConsultReachDispatcher`), NEVER a wake: `responder` names the
 * expert whose TRANSCRIPT answers, and a non-zero `woke` means an answering
 * session was launched from it. Zero WITHOUT an answering identity means no
 * session was launched; zero WITH an identity means the session is still booting.
 *
 * `answeringOwnerId` is who will actually post — it differs from `responder` on a
 * fork, and `stampAnsweringOwner` persists it so the launched session's reply is
 * not refused `not_a_participant`.
 */
export type CascadeDispatch = (opts: {
  responder: string;
  conversationId: string;
  summary: string;
  body: string;
  evidence?: CascadeSelectionEntry['evidence'];
  /** Persist the answering identity AS SOON AS that session is running, rather
   *  than when dispatch returns: the launched session can post during the
   *  dispatcher's verification wait, and the reply gate refuses an author the
   *  row does not name yet. The post-dispatch stamp stays as the backstop. */
  onAnsweringOwner?: (answeringOwnerId: string) => void | Promise<void>;
}) => Promise<{ woke: number; answeringOwnerId?: string | null; pending?: boolean }>;

/** Accept a cascade delivery on the existing consult row. The cursor has
 * already moved, so the previous responder cannot replay their disposition.
 * Only the launch copy is queued; selection and expiry remain authoritative. */
export async function queueCascadeDispatch(
  sql: Sql, workspaceId: string, opts: Parameters<CascadeDispatch>[0],
): Promise<boolean> {
  const pending = {
    version: 1, responder: opts.responder, summary: opts.summary, body: opts.body,
    ...(opts.evidence ? { evidence: opts.evidence } : {}), leaseToken: null, leaseUntil: null,
  };
  const rows = await sql`
    UPDATE harness_shared.consult_state
       SET routing = jsonb_set(CASE WHEN jsonb_typeof(routing) = 'string' THEN (routing #>> '{}')::jsonb ELSE routing END, '{cascadeDispatch}',
             ${sql.json(pending as never)}::jsonb || jsonb_build_object('cursor', cascade_cursor))
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${opts.conversationId}
       AND responder_id = ${opts.responder} AND closed_at IS NULL
       AND state IN ('awaiting_responder', 'active')
       AND (CASE WHEN jsonb_typeof(routing) = 'string' THEN (routing #>> '{}')::jsonb ELSE routing END)
         #>> ARRAY['selection', 'selected', cascade_cursor::text, 'ownerId'] = ${opts.responder}
    RETURNING conversation_id`;
  return rows.length > 0;
}

/** Recover the queued launch using the request lifecycle's bounded CAS lease.
 * The dispatcher must check isCurrent immediately before its spawn seam. An
 * answer-owner reservation prevents replay after process death: the existing
 * silent-answerer detector then settles a reserved slot that never launched. */
export async function continueCascadeDispatchCore(
  workspaceId: string, conversationId: string,
  deps: { getSql: () => Sql; now?: () => Date;
    dispatch: (isCurrent: () => Promise<boolean>) => CascadeDispatch },
): Promise<boolean> {
  const sql = deps.getSql();
  const now = () => deps.now?.() ?? new Date();
  const token = randomUUID();
  const rows = await sql<Array<{ cascade_cursor: number; routing: { cascadeDispatch: {
    responder: string; summary: string; body: string; evidence?: CascadeSelectionEntry['evidence']; attempts?: number;
  } } }>>`
    UPDATE harness_shared.consult_state
       SET routing = jsonb_set(routing, '{cascadeDispatch}', (routing->'cascadeDispatch') ||
         ${sql.json({ leaseToken: token, leaseUntil: new Date(now().getTime() + 120_000).toISOString() } as never)}::jsonb)
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
       AND closed_at IS NULL AND state IN ('awaiting_responder', 'active')
       AND routing #>> '{cascadeDispatch,version}' = '1'
       AND (routing #>> '{cascadeDispatch,cursor}')::int = cascade_cursor
       AND routing #>> '{cascadeDispatch,responder}' = responder_id
       AND COALESCE((routing #>> '{cascadeDispatch,attempts}')::int, 0) < 3
       AND routing #>> ARRAY['selection', 'selected', cascade_cursor::text, 'answeringOwnerId'] IS NULL
       AND COALESCE((routing #>> '{cascadeDispatch,leaseUntil}')::timestamptz, '-infinity'::timestamptz) <= ${now().toISOString()}::timestamptz
    RETURNING cascade_cursor, routing`;
  const row = rows[0];
  if (!row) return false;
  const routing = typeof row.routing === 'string' ? JSON.parse(row.routing) as typeof row.routing : row.routing;
  const pending = routing.cascadeDispatch;
  const isCurrent = async () => {
    const current = await sql`
      SELECT conversation_id FROM harness_shared.consult_state
       WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
         AND closed_at IS NULL AND state IN ('awaiting_responder', 'active')
         AND cascade_cursor = ${row.cascade_cursor} AND responder_id = ${pending.responder}
         AND routing #>> '{cascadeDispatch,leaseToken}' = ${token}
         AND (routing #>> '{cascadeDispatch,leaseUntil}')::timestamptz > ${now().toISOString()}::timestamptz`;
    return current.length > 0;
  };
  try {
    const onAnsweringOwner = async (owner: string) => {
        if (!(await isCurrent())) throw new Error('consult-cascade-dispatch-lease-lost');
        const stamped = await sql`
          UPDATE harness_shared.consult_state
             SET routing = jsonb_set(routing,
               ARRAY['selection', 'selected', ${String(row.cascade_cursor)}, 'answeringOwnerId'], to_jsonb(${owner}::text))
           WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
             AND closed_at IS NULL AND cascade_cursor = ${row.cascade_cursor}
             AND routing #>> '{cascadeDispatch,leaseToken}' = ${token}
          RETURNING conversation_id`;
        if (!stamped.length) throw new Error('consult-cascade-dispatch-lease-lost');
    };
    const result = await deps.dispatch(isCurrent)({
      responder: pending.responder, conversationId, summary: pending.summary, body: pending.body,
      ...(pending.evidence ? { evidence: pending.evidence } : {}),
      onAnsweringOwner,
    });
    if (result.answeringOwnerId && await isCurrent()) await onAnsweringOwner(result.answeringOwnerId);
    // A refusal has no answering session. Make it due now so the maintained
    // expiry path advances/settles it and emits the requester event, rather
    // than waiting a whole new TTL for a responder that cannot arrive.
    await sql`
      UPDATE harness_shared.consult_state
         SET routing = CASE WHEN ${result.woke === 0 && !result.answeringOwnerId}::boolean
               THEN (routing - 'cascadeDispatch') #- ARRAY['selection', 'selected', ${String(row.cascade_cursor)}, 'answeringOwnerId']
               ELSE routing - 'cascadeDispatch' END,
             expires_at = CASE WHEN ${result.woke === 0 && !result.answeringOwnerId}::boolean
               THEN ${now().toISOString()}::timestamptz - interval '1 millisecond' ELSE expires_at END
       WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
         AND cascade_cursor = ${row.cascade_cursor} AND closed_at IS NULL
         AND routing #>> '{cascadeDispatch,leaseToken}' = ${token}`;
  } catch (error) {
    const attempts = (pending.attempts ?? 0) + 1;
    await sql`
      UPDATE harness_shared.consult_state
         SET routing = jsonb_set(routing, '{cascadeDispatch}', (routing->'cascadeDispatch') ||
           ${sql.json({ leaseToken: null, leaseUntil: attempts < 3 ? new Date(now().getTime() + 30_000).toISOString() : null,
             attempts, lastError: String(error).slice(0, 500) } as never)}::jsonb),
             expires_at = CASE WHEN ${attempts >= 3}::boolean
               THEN ${now().toISOString()}::timestamptz - interval '1 millisecond' ELSE expires_at END
       WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
         AND cascade_cursor = ${row.cascade_cursor} AND routing #>> '{cascadeDispatch,leaseToken}' = ${token}`;
    throw error;
  }
  return true;
}

export interface AdvanceCascadeParams {
  workspaceId: string;
  conversationId: string;
  question: string;
  latencyContract: string;
  /** The consult's requester (row.requester_id) — named in the
   * refill-exhaustion revival brief (EI-20864690354207496). Optional only for
   * older fixtures; the brief falls back to a neutral phrase. */
  requesterId?: string;
  /** Persisted routing snapshot (selection.selected is the menu). */
  routing: unknown;
  /** Current cursor (index of the responder whose event triggered this). */
  cascadeCursor: number;
  /** Current persisted digest (row.cascade_digest). */
  digest: unknown;
  /** The chain event that triggered this advance — appended to the digest. */
  event: CascadeDigestEntry;
  /** Row state to leave on a successful advance: 'active' when triggered by a
   * reply (a responder engaged), 'awaiting_responder' for decline/expiry. */
  stateOnAdvance: 'awaiting_responder' | 'active';
  /** Optional expiry-sweep snapshot guards. A due-row snapshot must not append
   * an expiry event or advance after another writer has refreshed its TTL. */
  expectedState?: string;
  expectedExpiresAt?: string | Date | null;
  nowIso: string;
}

export interface AdvanceCascadeResult {
  advanced: boolean;
  /** Launch accepted durably; no answering session is claimed yet. */
  pending?: boolean;
  /** True when the menu had no next entry — the caller owns the terminal
   * transition (decline-close / expire); this helper only records the event. */
  exhausted: boolean;
  /** True when the CAS guard matched no row — a concurrent actor (the other
   * verb, or the expiry sweep) advanced or closed the consult between the
   * caller's read and this write. NOTHING was written (no digest append, no
   * wake); the concurrent winner's advance stands and already did both. */
  raced: boolean;
  next: { ownerId: string; via: 'floor' | 'minimum' } | null;
  woke: number;
  /** A failed-dispatch walk exhausted at a later slot than the caller read.
   * Terminal writers must guard this snapshot, not the original slot's TTL. */
  exhaustedAfterDispatch?: {
    cascadeCursor: number;
    state: 'awaiting_responder' | 'active';
    expiresAt: string;
  };
  /** WI-39861: this advance was the ONE bounded min-ANSWERS refill round — the
   * menu exhausted with fewer substantive answers than selection.min, so the
   * menu was extended from the untried route-time-live remainder of the
   * snapshot pool (selection.refill stamps the round). */
  refilled?: boolean;
  /** EI-20864690354207496 honest terminal: the cascade ended with fewer
   * substantive answers than selection.min and the menu could not be extended
   * to close the gap — `reason` names why. Mirrored durably onto the persisted
   * snapshot as selection.underFilled so the label survives the caller.
   *
   * D-002/D-004 retired the revival-specific reasons: liveness is no longer a
   * filter on the refill (dispatch forks a dead expert's transcript exactly as
   * it forks a live one), so the only two ways to run out are a pool with no
   * untried candidate left, and the ONE bounded refill round already spent —
   * where "spent" means it LAUNCHED an answering session (WI-10005360); a round
   * refused entirely before launch extends rather than ending `refill-spent`. */
  underFilled?: {
    answers: number;
    min: number;
    reason: 'no-untried-candidate' | 'refill-spent';
  };
}

/**
 * Advance the cascade by one responder. On advance: cursor + responder_id +
 * state + a fresh latency-contract expiry window + digest append + wake (via
 * `reach`, when provided — prod binds notifyAgents, which subscribes + pings +
 * wakes, so a later selectee joins the conversation durably). On exhaustion:
 * appends the event to the digest and returns without touching
 * state/responder_id — terminal semantics stay with the caller.
 *
 * CAS-guarded: both writes require `cascade_cursor` to still equal the cursor
 * the caller READ (params.cascadeCursor) and the row to still be open. Three
 * concurrent triggers share these semantics (reply, decline, the expiry
 * sweep); the guard makes the loser's advance a clean no-op (`raced`) instead
 * of a duplicate cursor bump + duplicate wake.
 */
/**
 * Stamp WHO will actually post for the selectee at `cursor` (D-002). A fork
 * answers under a new coord identity, and `isConsultParticipant` reads this field
 * to let that session's reply through — without it, the session this cascade step
 * just launched is refused `not_a_participant`.
 *
 * Additive and guarded: the answering session may already have replied by the
 * time this lands, so it touches ONLY this one path and never rewrites
 * state/responder_id/cursor.
 */
async function stampAnsweringOwner(
  sql: Sql,
  params: Pick<AdvanceCascadeParams, 'workspaceId' | 'conversationId'>,
  cursor: number,
  answeringOwnerId: string | null | undefined,
): Promise<void> {
  if (!answeringOwnerId) return;
  const stamped = await sql<{ answering_owner_id: string | null }[]>`
    UPDATE harness_shared.consult_state
       SET routing = jsonb_set(
             routing,
             ARRAY['selection', 'selected', ${String(cursor)}, 'answeringOwnerId'],
             -- to_jsonb, NOT a JSON.stringify'd parameter cast ::jsonb: the
             -- driver JSON-encodes the already-quoted text again, storing
             -- "\"su-x\"". The stamp then matches no author, so the answering
             -- session is refused not_a_participant by its own launcher —
             -- silently, because the write succeeds.
             to_jsonb(${answeringOwnerId}::text)
           )
     WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
       AND routing #>> ARRAY['selection', 'selected', ${String(cursor)}, 'ownerId'] IS NOT NULL
    RETURNING routing #>> ARRAY['selection', 'selected', ${String(cursor)}, 'answeringOwnerId'] AS answering_owner_id
  `;
  if (stamped[0]?.answering_owner_id !== answeringOwnerId) {
    throw new Error('consult-cascade-answering-owner-stamp-not-persisted');
  }
}

export async function advanceCascade(
  params: AdvanceCascadeParams,
  sql: Sql,
  /** D-011: the DISPATCH seam — every advance launches a fresh answering
   *  session from the next expert's transcript. Never a wake. Absent ⇒ the
   *  cursor advances and nobody is dispatched (lower-level fixtures). */
  dispatch?: CascadeDispatch,
): Promise<AdvanceCascadeResult> {
  const sourceAudit = sourceAuditCascadeMetaFromRouting(params.routing);
  if (sourceAudit) {
    // Repair a missed post-emit cleanup before any decline/expiry/refill wake.
    // The settled source card is authoritative even when its closer failed.
    const settled = await sql<{ state: string }[]>`
      SELECT payload->'observation'->'gradingAudit'->>'state' AS state
      FROM harness_shared.work_items
      WHERE workspace_id = ${params.workspaceId} AND feature_id = ${sourceAudit.issueId}`;
    if (settled[0]?.state === 'passed' || settled[0]?.state === 'failed') {
      await sql`
        UPDATE harness_shared.consult_state
        SET state = 'closed_answered', closed_at = ${params.nowIso}::timestamptz,
            updated_at = ${params.nowIso}::timestamptz,
            outcome = jsonb_build_object('source', 'grading-integrity', 'issueId', ${sourceAudit.issueId}::text)
        WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
          AND state IN ('awaiting_responder', 'active', 'no_qualified_responder', 'no_launchable_responder')`;
      return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };
    }
  }
  const selected = selectionFromRouting(params.routing);
  const digest = [...digestFromRow(params.digest), params.event].slice(-CASCADE_DIGEST_MAX_ENTRIES);
  const nextIdx = params.cascadeCursor + 1;
  const next = nextIdx < selected.length ? selected[nextIdx] : null;
  const clearFailedAnsweringOwner = params.event.kind === 'dispatch_failed';
  const failedAnsweringCursor = String(params.cascadeCursor);
  // EI-24351703367365896: a refused dispatch cannot leave an unstaffed slot
  // awaiting a fresh TTL. Reuse this same finite menu/refill walk, guarded by
  // the slot we just wrote. A concurrent reply/expiry refresh wins the CAS.
  const skipUndispatched = async (
    ownerId: string, cursor: number, routing: unknown, expiresAt: string,
  ): Promise<AdvanceCascadeResult> => {
    const result = await advanceCascade({
      ...params,
      routing,
      cascadeCursor: cursor,
      digest,
      expectedState: params.stateOnAdvance,
      expectedExpiresAt: expiresAt,
      event: makeDigestEntry(ownerId, 'dispatch_failed', params.nowIso,
        'Dispatch returned without launching an answering session; advancing to the next selected expert.'),
    }, sql, dispatch);
    return result.exhausted && !result.exhaustedAfterDispatch
      ? { ...result, exhaustedAfterDispatch: { cascadeCursor: cursor, state: params.stateOnAdvance, expiresAt } }
      : result;
  };
  if (!next) {
    // WI-39861 min-ANSWERS refill: the menu is exhausted. If fewer substantive
    // ANSWERS than selection.min were collected (counting the just-appended
    // event), extend the menu from the snapshot pool's untried remainder
    // instead of going terminal — ONE bounded round, guarded by the
    // selection.refill stamp. When the round cannot fill the gap, the terminal
    // state honestly reports WHY the min stays unfilled
    // (selection.underFilled). It all lives HERE — shared by all three
    // triggers (reply/decline/expiry) — so the semantics cannot drift.
    //
    // D-002/D-004 retired the separate revival leg this used to carry. Its job
    // was reaching a DEAD above-floor candidate the live refill had to skip;
    // dispatch forks that candidate's transcript whether or not the original is
    // running, so liveness is no longer a filter here and the dead candidate is
    // an ordinary refill pick.
    const snap =
      typeof params.routing === 'string'
        ? (JSON.parse(params.routing) as Record<string, unknown> | null)
        : (params.routing as Record<string, unknown> | null);
    const sel = (snap?.selection ?? null) as
      | ({ min?: unknown; selected?: unknown; refill?: unknown } & Record<string, unknown>)
      | null;
    const answers = digest.filter((e) => e.kind === 'answer').length;
    const min = typeof sel?.min === 'number' ? sel.min : 0;
    // A grading-integrity reservation epoch is a single-auditor attempt.
    // Refill would dispatch another auditor under the same lease after a
    // decline/expiry, while the previous answering session may still be
    // finishing its evidence pass. A later attempt must first acquire a fresh
    // reservation epoch through the source-audit dispatcher.
    if (!sourceAudit && snap && sel && min > 0 && answers < min) {
      const tried = new Set<string>([...selected.map((e) => e.ownerId), ...digest.map((e) => e.ownerId)]);
      const needed = Math.max(0, min - answers);
      type SnapCand = {
        ownerId: string;
        score?: number;
        relevance?: number;
        signals?: { similarity?: number };
        liveness?: string;
        evidence?: unknown;
      };
      const untried = (Array.isArray(snap.candidates) ? snap.candidates : []).filter(
        (c): c is SnapCand =>
          Boolean(c) &&
          typeof (c as { ownerId?: unknown }).ownerId === 'string' &&
          !tried.has((c as { ownerId: string }).ownerId),
      );
      const entryOf = (c: SnapCand, extra: Partial<CascadeSelectionEntry>): CascadeSelectionEntry => {
        const score = typeof c.score === 'number' ? c.score : 0;
        const relevance = typeof c.relevance === 'number' ? c.relevance : 0;
        const similarity = typeof c.signals?.similarity === 'number' ? c.signals.similarity : 0;
        return {
          ownerId: c.ownerId,
          // Honest floor-vs-minimum recomputed from the snapshot's own floors
          // (D-002: labeled, never silent) — a refill pick below them is a
          // best-available fill, not a costumed expert. Delegated rather than
          // re-implemented: this predicate has ONE home in relevance-router, so
          // a refill cannot be labeled by a rule the route itself no longer
          // uses. It also reads the snapshot's OWN generation, which matters
          // here because this column holds pre-D-001 records whose `floor`
          // gated a recency-bearing score.
          via: snapshotCandidateQualifies(snap, c) ? 'floor' : 'minimum',
          score,
          relevance,
          similarity,
          liveness: c.liveness ?? 'unknown',
          ...(Array.isArray(c.evidence) ? { evidence: c.evidence as CascadeSelectionEntry['evidence'] } : {}),
          ...extra,
        };
      };
      // WI-39861 refill (ONE bounded round — selection.refill guards it).
      //
      // No liveness filter (D-002/D-004). The route-time `liveness` stamp is
      // kept on the entry as provenance, but it no longer decides WHO is
      // addable: dispatch answers from the candidate's transcript, so a dead
      // expert is dispatchable on exactly the same terms as a live one. This is
      // what retired the separate revival leg — its reserve-then-spawn dance
      // existed only because a dead candidate could not be woken.
      //
      // WI-10005360: the round is SPENT once it launched an answering session,
      // not once it was attempted. A round whose every pick was refused before
      // launch (only `dispatch_failed` on record) extends to the next untried
      // candidate(s) instead of closing `refill-spent` with launchable experts
      // left. Still finite: each extension moves its picks into `tried`, and the
      // snapshot pool is static.
      const refillSpent = Boolean(sel.refill) && !refillRoundLaunchedNothing(sel.refill, digest);
      const add: CascadeSelectionEntry[] = !refillSpent
        ? untried.slice(0, needed).map((c) => entryOf(c, { refill: true }))
        : [];
      const rawSelected = Array.isArray(sel.selected) ? (sel.selected as unknown[]) : [];
      const cursorIdx = selected.length;
      if (add.length > 0) {
        const updatedSnap = {
          ...snap,
          selection: {
            ...sel,
            selected: [...rawSelected, ...add],
            // The refill stamp guards the ONE round (WI-39861) — stamped
            // whenever that round ran, even when it found nothing (the
            // snapshot pool is static, so a later re-scan cannot do better).
            // A continuation (WI-10005360 — the stamped round launched nothing)
            // keeps the original stamp and APPENDS its picks, so `added` stays
            // the full record that refillRoundLaunchedNothing judges next time.
            refill: !sel.refill
              ? {
                  at: params.nowIso,
                  added: add.map((a) => a.ownerId),
                  reason: `cascade exhausted with ${answers} answer(s) < min ${min}`,
                }
              : {
                  ...(sel.refill as Record<string, unknown>),
                  added: [
                    ...(Array.isArray((sel.refill as { added?: unknown }).added)
                      ? ((sel.refill as { added: unknown[] }).added)
                      : []),
                    ...add.map((a) => a.ownerId),
                  ],
                  continued: {
                    at: params.nowIso,
                    reason: 'every earlier refill pick was refused before launch (WI-10005360)',
                  },
                },
          },
        };
        // Cursor lands on the FIRST refill entry: in the selectionFromRouting
        // view the adds append after the `selected.length` well-formed entries.
        const first = add[0]!;
        const expiresAt = new Date(
          Date.parse(params.nowIso) +
            (params.latencyContract === 'hard-blocked' ? HARD_BLOCKED_EXPIRY_MS : PROCEED_EXPIRY_MS),
        ).toISOString();
        const willAttempt = Boolean(dispatch);
        // The creation caller's snapshot predates accepted-request persistence
        // and answering-owner stamps. Change only the selection fields owned
        // by this advance, using the current row as the routing base.
        const persistedRouting = sql`(CASE WHEN jsonb_typeof(routing) = 'string'
          THEN (routing #>> '{}')::jsonb ELSE routing END)`;
        const refillRouting = sql`jsonb_set(${persistedRouting}, '{selection}',
          COALESCE(${persistedRouting}->'selection', ${sql.json(sel as never)}) ||
          jsonb_build_object(
            'selected', COALESCE(${persistedRouting} #> '{selection,selected}',
              ${sql.json(rawSelected as never)}) || ${sql.json(add as never)},
            'refill', ${sql.json(updatedSnap.selection.refill as never)}))`;
        const wrote = (await sql`
          UPDATE harness_shared.consult_state
             SET cascade_cursor = ${cursorIdx},
                 responder_id = ${first.ownerId},
                 state = ${params.stateOnAdvance},
                 expires_at = ${expiresAt}::timestamptz,
                 wakes_used = wakes_used + ${willAttempt ? 1 : 0},
                 cascade_digest = ${sql.json(digest as never)},
                 routing = CASE
                   WHEN ${clearFailedAnsweringOwner}::boolean
                     THEN ${refillRouting} #- ARRAY['selection', 'selected', ${failedAnsweringCursor}, 'answeringOwnerId']
                   ELSE ${refillRouting}
                 END,
                 updated_at = ${params.nowIso}::timestamptz
           WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
             AND cascade_cursor = ${params.cascadeCursor} AND closed_at IS NULL
             AND (${params.expectedState === undefined}::boolean OR state = ${params.expectedState ?? null}::text)
             AND (${params.expectedExpiresAt === undefined}::boolean OR expires_at IS NOT DISTINCT FROM ${params.expectedExpiresAt ?? null}::timestamptz)
          RETURNING conversation_id
        `) as unknown as Array<{ conversation_id: string }>;
        if (wrote.length === 0) return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };
        let woke = 0;
        if (dispatch) {
          const menuSize = selected.length + add.length;
          const copy = cascadeWakeCopyForRouting(params.routing)({
            question: params.question,
            conversationId: params.conversationId,
            position: cursorIdx + 1,
            menuSize,
            next: first,
            digest,
            extension: 'min-answers refill',
          });
          const r = await dispatch({
            responder: first.ownerId,
            conversationId: params.conversationId,
            summary: copy.summary,
            body: copy.body,
            ...(first.evidence ? { evidence: first.evidence } : {}),
            onAnsweringOwner: (owner) => stampAnsweringOwner(sql, params, cursorIdx, owner),
          });
          woke = r.woke;
          // Backstop for a dispatcher that does not call the hook. Stamped on
          // the ANSWERING IDENTITY, never on `woke`: a fork that launched but
          // has not confirmed pickup reports woke:0 while already owning the
          // keyboard, and without the stamp its first reply is refused
          // not_a_participant. stampAnsweringOwner no-ops on absent.
          await stampAnsweringOwner(sql, params, cursorIdx, r.answeringOwnerId);
          // The callback reserves participant identity before spawn so a fast
          // first reply is accepted. It does not prove launch: only the
          // dispatch result can distinguish that reservation from a failed
          // spawn. A failed slot is cleared by the next CAS below.
          if (r.pending) return { advanced: true, exhausted: false, raced: false,
            next: { ownerId: first.ownerId, via: first.via }, woke: 0, pending: true,
            ...(sel.refill ? {} : { refilled: true }) };
          if (woke === 0 && !r.answeringOwnerId) {
            const result = await skipUndispatched(first.ownerId, cursorIdx, updatedSnap, expiresAt);
            return { ...result, ...(sel.refill ? {} : { refilled: true }) };
          }
        }
        return {
          advanced: true,
          exhausted: false,
          raced: false,
          next: { ownerId: first.ownerId, via: first.via },
          woke,
          ...(sel.refill ? {} : { refilled: true }),
        };
      }
      // Nothing addable — HONEST terminal (EI-20864690354207496): the min
      // stays unfilled and the persisted snapshot says WHY, so "exhausted"
      // can never silently paper over an expert nobody tried. The caller still
      // owns the terminal state transition. Written as a full rewrite of the
      // parsed snapshot (same style as the extension write above, same CAS
      // guard) — NOT jsonb_set on the column, which raises "cannot set path in
      // scalar" when the row's routing round-tripped as a jsonb string scalar
      // (the documented driver quirk selectionFromRouting tolerates on the
      // read side).
      const underFilled = {
        answers,
        min,
        reason: (refillSpent ? 'refill-spent' : 'no-untried-candidate') as NonNullable<
          AdvanceCascadeResult['underFilled']
        >['reason'],
      };
      const persistedRouting = sql`(CASE WHEN jsonb_typeof(routing) = 'string'
        THEN (routing #>> '{}')::jsonb ELSE routing END)`;
      const terminalRouting = sql`jsonb_set(${persistedRouting}, '{selection}',
        COALESCE(${persistedRouting}->'selection', ${sql.json(sel as never)}) ||
        ${sql.json({ underFilled: { at: params.nowIso, ...underFilled } } as never)})`;
      const wroteTerminal = ((await sql`
            UPDATE harness_shared.consult_state
               SET cascade_digest = ${sql.json(digest as never)},
                   routing = CASE
                     WHEN ${clearFailedAnsweringOwner}::boolean
                       THEN ${terminalRouting} #- ARRAY['selection', 'selected', ${failedAnsweringCursor}, 'answeringOwnerId']
                     ELSE ${terminalRouting}
                   END,
                   updated_at = ${params.nowIso}::timestamptz
             WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
               AND cascade_cursor = ${params.cascadeCursor} AND closed_at IS NULL
               AND (${params.expectedState === undefined}::boolean OR state = ${params.expectedState ?? null}::text)
               AND (${params.expectedExpiresAt === undefined}::boolean OR expires_at IS NOT DISTINCT FROM ${params.expectedExpiresAt ?? null}::timestamptz)
            RETURNING conversation_id
          `) as unknown as Array<{ conversation_id: string }>);
      if (wroteTerminal.length === 0) return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };
      return {
        advanced: false,
        exhausted: true,
        raced: false,
        next: null,
        woke: 0,
        underFilled,
      };
    }
    const wrote = (await sql`
      UPDATE harness_shared.consult_state
         SET cascade_digest = ${sql.json(digest as never)},
             updated_at = ${params.nowIso}::timestamptz
       WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
         AND cascade_cursor = ${params.cascadeCursor} AND closed_at IS NULL
         AND (${params.expectedState === undefined}::boolean OR state = ${params.expectedState ?? null}::text)
         AND (${params.expectedExpiresAt === undefined}::boolean OR expires_at IS NOT DISTINCT FROM ${params.expectedExpiresAt ?? null}::timestamptz)
      RETURNING conversation_id
    `) as unknown as Array<{ conversation_id: string }>;
    if (wrote.length === 0) return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };
    return { advanced: false, exhausted: true, raced: false, next: null, woke: 0 };
  }

  const expiresAt = new Date(
    Date.parse(params.nowIso) + (params.latencyContract === 'hard-blocked' ? HARD_BLOCKED_EXPIRY_MS : PROCEED_EXPIRY_MS),
  ).toISOString();
  const willAttempt = Boolean(dispatch);
  const wrote = (await sql`
    UPDATE harness_shared.consult_state
       SET cascade_cursor = ${nextIdx},
           responder_id = ${next.ownerId},
           state = ${params.stateOnAdvance},
           expires_at = ${expiresAt}::timestamptz,
           wakes_used = wakes_used + ${willAttempt ? 1 : 0},
           cascade_digest = ${sql.json(digest as never)},
           routing = CASE
             WHEN ${clearFailedAnsweringOwner}::boolean THEN
               (CASE WHEN jsonb_typeof(routing) = 'string'
                 THEN (routing #>> '{}')::jsonb
                 ELSE routing
               END) #- ARRAY['selection', 'selected', ${failedAnsweringCursor}, 'answeringOwnerId']
             ELSE routing
           END,
           updated_at = ${params.nowIso}::timestamptz
     WHERE workspace_id = ${params.workspaceId} AND conversation_id = ${params.conversationId}
       AND cascade_cursor = ${params.cascadeCursor} AND closed_at IS NULL
       AND (${params.expectedState === undefined}::boolean OR state = ${params.expectedState ?? null}::text)
       AND (${params.expectedExpiresAt === undefined}::boolean OR expires_at IS NOT DISTINCT FROM ${params.expectedExpiresAt ?? null}::timestamptz)
    RETURNING conversation_id
  `) as unknown as Array<{ conversation_id: string }>;
  if (wrote.length === 0) return { advanced: false, exhausted: false, raced: true, next: null, woke: 0 };

  let woke = 0;
  if (dispatch) {
    const copy = cascadeWakeCopyForRouting(params.routing)({
      question: params.question,
      conversationId: params.conversationId,
      position: nextIdx + 1,
      menuSize: selected.length,
      next,
      digest,
    });
    const r = await dispatch({
      responder: next.ownerId,
      conversationId: params.conversationId,
      summary: copy.summary,
      body: copy.body,
      ...(next.evidence ? { evidence: next.evidence } : {}),
      onAnsweringOwner: (owner) => stampAnsweringOwner(sql, params, nextIdx, owner),
    });
    woke = r.woke;
    // Backstop, on the answering identity and never on `woke` — as above.
    await stampAnsweringOwner(sql, params, nextIdx, r.answeringOwnerId);
    if (r.pending) return { advanced: true, exhausted: false, raced: false,
      next: { ownerId: next.ownerId, via: next.via }, woke: 0, pending: true };
    if (woke === 0 && !r.answeringOwnerId) {
      return skipUndispatched(next.ownerId, nextIdx, params.routing, expiresAt);
    }
  }
  return { advanced: true, exhausted: false, raced: false, next: { ownerId: next.ownerId, via: next.via }, woke };
}
