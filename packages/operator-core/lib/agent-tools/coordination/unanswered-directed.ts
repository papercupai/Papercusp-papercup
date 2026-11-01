/**
 * unanswered-directed.ts — per-recipient UNANSWERED DIRECTED MESSAGE aggregate
 * (fleet-reliability-verification-2026-07-10 P-007, the fleet:leader-brief primitive).
 *
 * Night-shift lesson (2026-07-10 outage review): the leader hand-tracked "who
 * hasn't answered me yet" from memory across ~45 monitor wakes — nothing
 * surfaced it mechanically. reply-deadline-sweep already nudges the rare
 * message that opts into an explicit `replyDeadlineSec`; this is the general
 * per-member READ a leader's fleet-health check needs for EVERY directed
 * message, deadline or not.
 *
 * Definitions:
 *   - "directed": kind='message' (or unset, the default), addressed via
 *     explicit ownerId(s), a resolved `@file` selector, or a resolved
 *     `@fleet-leader` selector (which names one concrete recipient). Selector
 *     expansion stores concrete ownerIds in `to` and the original selector in
 *     `audience`. Wildcard broadcasts and multi-recipient selector audiences
 *     remain excluded until their group-reply semantics are defined. Sender !=
 *     recipient (never counts a message against its own author, e.g. a fanout
 *     that lists the sender).
 *   - "expects reply": the sender explicitly sets `expectsReply:true`, or
 *     uses the coord:send ergonomic `wake:'required'` + `replyDeadlineSec`
 *     combination (which stamps the same field). FYI/status reports are
 *     intentionally absent from this aggregate. EI-19315474516256070: an
 *     explicit `expects:'none'` (D-048's REQUIRED coord:send field, or the
 *     write-time machine-emitter stamp in messages.ts) OVERRIDES a stale/
 *     inconsistent `expectsReply:true` — the two fields are independently
 *     settable on a raw sendMessage() call and can diverge; see the SQL below.
 *   - "answered": a sibling row carrying `related_msg_id = <this msg_id>`
 *     AUTHORED BY the recipient — an explicit ack (kind='ack') or a genuine
 *     reply both satisfy it (mirrors reply-deadline-sweep's own NOT EXISTS
 *     check). EI-13819 / WI-5345: ALSO satisfied by an UN-THREADED directed
 *     message the recipient sent back to the same original sender after the
 *     ask — this fleet's agents overwhelmingly answer in fresh standalone
 *     messages rather than re-threading onto the exact msg_id that set
 *     `expectsReply`, so an exact-match-only rule left real, substantively
 *     answered exchanges stuck "unanswered" forever (see the EI-13819
 *     postmortem below). WI-6729 bounds that loose branch, which had grown
 *     wide enough to silently DROP live obligations: a reply threaded to a
 *     DIFFERENT message no longer counts (it is evidence the reply is about
 *     something else), and one loose reply clears at most ONE ask (a sender's
 *     open asks are ranked newest-first; the k-th needs k loose replies after
 *     it). See the WI-6729 note below for why the residual error is
 *     deliberately a false POSITIVE.
 *
 * WI-4537 — what this counter must NOT count. It is wired to PREEMPT an agent's
 * work ("a directed message awaiting YOUR answer OUTRANKS your own work"), so a
 * false positive costs a real interruption. Measured live, 2791 "unanswered"
 * rows fleet-wide were mostly things nobody was waiting on:
 *   (a) auto:true machine lifecycle chatter (work-item:done, hold_open_clear…);
 *   (b) machine SENDERS that never carried the flag — claim-discipline-watch
 *       (390!), plan-clobber-watch, system:delivery-ladder (the sweep whose job
 *       is to nag you about unread directed mail, itself generating unread
 *       directed mail), … — see machine-authored.ts, whose pattern is shared
 *       with sendMessage's new write-time stamp so the two cannot drift;
 *   (c) the ACK-PING-PONG: a message that is itself a REPLY to something the
 *       RECIPIENT sent. An answer arriving was counted as a question landing,
 *       clearable only by acking the ack — forever (184 rows). EI-22192594388203470:
 *       (c) itself over-fires when the reply carries an explicit expects:'action'/
 *       'answer' — that is the sender's OWN declaration of a fresh ask, not an ack,
 *       and now overrides the structural reply-chain heuristic (see the \`directed\`
 *       CTE below for the incident this was filed from).
 * All three are excluded below. What remains is what the name promises: a
 * message from a real correspondent, still awaiting this recipient's reply.
 *
 * EI-13819 (leader-brief false-sticky postmortem, 2026-07-17): a leader sent a
 * lane offer with expectsReply:true; the member did the work, then sent a
 * FRESH "DONE, standing down" message (no `related_msg_id`) followed by a
 * separate `related_msg_id`-carrying ack of the leader's own later closing
 * message — a completely normal exchange, but NEITHER reply pointed at the
 * ORIGINAL lane-offer msg_id, so the strict exact-thread check left it
 * "unanswered" for good: every leader wake re-read a false "member hasn't
 * answered me" signal long after the member had visibly replied twice. Fixed
 * by ALSO accepting a reply the recipient sent back to the same sender after
 * the ask, without requiring it to be threaded onto the ask — see
 * `unanswered` below.
 *
 * WI-6729 (leader-brief false-ZERO postmortem, 2026-08-01) — the correction to
 * the above. EI-13819's fix, widened again by WI-5345, ended up accepting ANY
 * directed message back to the sender, threaded to anything or nothing. So a
 * single reply to a correspondent cleared EVERY outstanding ask from that
 * correspondent, on any topic. Observed live: a member sent a design fork it
 * was blocked on (expectsReply, 19:41Z); the leader replied ~6min later about
 * an unrelated work-item, threaded to a different message; every surface then
 * reported `unanswered_directed: 0`, twice, with `unanswered_lookup_failed:
 * false`. The leader acted on that zero and publicly retracted the commitment
 * as non-existent — only the member's pushback recovered it.
 *
 * Two properties made it critical rather than cosmetic: it is the SAME
 * primitive behind leader-brief, fleet:assignments AND
 * coord:inbox{unanswered_only}, so the "independent second check" could not
 * disagree; and the failure SCALES WITH RESPONSIVENESS — the more promptly a
 * leader answers a member, the more of that member's other asks it erases.
 * Note the direction each postmortem pushed: EI-13819/WI-5345 traded away
 * false positives (a counter stuck at 1 — annoying, visible, self-limiting)
 * and bought false negatives (a dropped commitment — silent, permanent,
 * unbounded). For a "what do I still owe?" counter that is the wrong trade,
 * and `unanswered` below now errs the other way on purpose.
 *
 * Batched: ONE query for the whole roster (mirrors fetchContextPressure /
 * fetchWakeability) — enriching N members costs one read, not N. Bounded to a
 * recent lookback window (default 3d) so an ancient backlog from a long-idle
 * member doesn't bloat every fleet-health read forever; each recipient's
 * `newest` list is capped even when its unanswered count is large.
 *
 * The SQL aggregation is thin IO (fetchUnansweredDirected); the row→summary
 * fold is a PURE function (rowsToUnansweredMap) so it unit-tests without PG.
 */
import { coordSql, coordWorkspaceId, coordHasPgFastPath } from './log';
import { MACHINE_SENDER_PATTERN } from './machine-authored';
import { fetchSatisfiedDirectiveMessageIds } from './directive-effect-read';
import { endedRecordedOwnerIds } from '../../adv-sessions';
import { listPresence } from './presence';
import { resolveSessionStates, type LivenessSubject } from './liveness-oracle';
import type { SessionState } from './presence-wakeability';

export interface UnansweredDirectedEntry {
  msgId: string;
  from: string;
  summary?: string;
  ageMs: number;
  /**
   * EI-20085805220385722: which population this entry belongs to. `'ended'`
   * means the SENDER is positively dead, so nobody is behind the ask and it is
   * counted in `staleCount` rather than `count`. Every other value — including
   * `'unknown'` — means it still counts. Absent when liveness was never
   * resolved at all (the pure fold, a swapped seam), which reads the same as
   * `'unknown'`: it counts.
   */
  senderState?: SessionState | 'unknown';
}

/**
 * EI-20085805220385722: one row per distinct sender still awaiting this
 * recipient's reply. The liveness split CANNOT be computed from `newest` —
 * that list is capped at `cap` while `count` is exact, so a sender beyond the
 * cap is simply absent from it. This rollup is what makes an exact-as-bounded
 * partition possible.
 */
export interface UnansweredSenderRollup {
  from: string;
  count: number;
  oldestAgeMs: number;
  senderState?: SessionState | 'unknown';
}

export interface UnansweredDirectedSummary {
  /**
   * Messages this recipient still OWES an answer to, from a sender who is not
   * positively dead. THIS is the number wired to preempt an agent's own work
   * ("a directed message awaiting YOUR answer OUTRANKS your own work"), so it
   * deliberately counts every sender whose liveness is live, parked, suspect,
   * recorded OR unknown — only a POSITIVE `'ended'` verdict demotes a message
   * out of it (EI-20085805220385722; see partitionUnansweredByLiveness).
   */
  count: number;
  /** Oldest age within `count`'s population. */
  oldestAgeMs: number;
  /**
   * Newest-first, capped at NEWEST_CAP even when `count` is larger. Spans BOTH
   * populations — read each entry's `senderState` to tell which. (Capping this
   * list per-population would make a 3-entry display depend on which side a
   * liveness probe happened to resolve.)
   */
  newest: UnansweredDirectedEntry[];
  /**
   * Still-unanswered messages whose sender is positively `'ended'`. Nobody is
   * blocked on these: they are reported so the obligation is never silently
   * dropped, but they do not ride the preemption priority.
   *
   * ⚠ A FLOOR, not a total — it is computed over at most
   * {@link UNANSWERED_SENDER_CAP} distinct senders, and any sender past that
   * cap stays in `count`. `staleCountBounded` is set when that happened. The
   * asymmetry is deliberate: under-reporting stale is today's behaviour, while
   * over-reporting it would suppress a real blocked peer.
   */
  staleCount: number;
  /** Oldest age within `staleCount`'s population; 0 when it is empty. */
  staleOldestAgeMs: number;
  /** Set only when the distinct-sender set exceeded {@link UNANSWERED_SENDER_CAP},
   *  so `staleCount` is a floor rather than a total. */
  staleCountBounded?: true;
  /** Per-sender rollup, bounded to {@link UNANSWERED_SENDER_CAP} (busiest first). */
  senders: UnansweredSenderRollup[];
  /** Set when `senders` omits at least one distinct sender. */
  sendersTruncated?: true;
}

/** A message older than this is dropped from the read entirely — an ancient,
 *  long-abandoned thread isn't "fleet health" signal, it's noise. */
export const UNANSWERED_LOOKBACK_MS = 3 * 24 * 3600 * 1000;
/** Per-recipient cap on the `newest` list (the count itself is never capped). */
export const UNANSWERED_NEWEST_CAP = 3;
/**
 * Per-recipient cap on the distinct senders whose liveness is resolved for the
 * stale split. fetchUnansweredDirected is called with WHOLE ROSTERS
 * (fleet/assignments.ts, fleet-audit.ts), and while a recipient's sender set is
 * normally tiny it is not bounded by construction — so the decoration is capped
 * rather than allowed to grow with the fleet. Senders past the cap stay in
 * `count` (fail open) and set `staleCountBounded`.
 */
export const UNANSWERED_SENDER_CAP = 32;

/**
 * Positive death evidence for a set of ownerIds — the ONLY signal allowed to
 * demote a message. Returns just the ids proven ended; an id it knows nothing
 * about is simply ABSENT, which is what makes the seam fail open by
 * construction rather than by remembering to.
 *
 * ⚠⚠ DO NOT "UPGRADE" THIS TO `resolveSessionStates`. That is the obvious
 * refactor, it is what this code did first, and it is WRONG here — measured
 * 2026-09-05, it took every unanswered message in the integration suite to
 * zero. `resolveSessionStates` returns `sessionState: 'ended'` for a BARE id
 * it has never heard of (no presence row, no recorded session): a bare subject
 * carries no heartbeat, so the derivation reads not-wakeable + no-live-turn as
 * death, and reports it as a measured verdict — `signalMissing` is NOT set, and
 * the verdict even carries `heartbeatFresh: true` beside `ended`. The oracle is
 * built to be fed subjects that CARRY presence data (or `hydratePerId: true`,
 * whose own doc forbids it for whole rosters, which is exactly how this
 * function is called). Feeding it bare ids converts ABSENCE OF EVIDENCE into
 * EVIDENCE OF DEATH — the precise inversion this whole split exists to avoid.
 */
export type EndedSendersFn = (ownerIds: string[]) => Promise<ReadonlySet<string>>;

/** DI seam for the sender-side mirror's batched recipient-liveness read. */
export type OpenAskRecipientStatesFn = (
  ownerIds: string[],
) => Promise<ReadonlyMap<string, SessionState | null | undefined>>;

export interface UnansweredDirectedRow {
  recipient: string;
  cnt: string | number;
  oldest_ts_ms: string | number;
  newest_ids: (string | null)[] | null;
  newest_from: (string | null)[] | null;
  newest_summary: (string | null)[] | null;
  newest_ts_ms: (string | number | null)[] | null;
  /** EI-20085805220385722 per-sender rollup — absent on a hand-built row. */
  sender_total?: string | number | null;
  sender_ids?: (string | null)[] | null;
  sender_cnts?: (string | number | null)[] | null;
  sender_oldest_ts_ms?: (string | number | null)[] | null;
}

/**
 * PURE: fold the aggregated SQL rows (one row per recipient with >=1
 * unanswered directed message) into the per-recipient summary map.
 * Unit-testable with hand-built rows — no PG required.
 *
 * `cap` bounds how many of each recipient's `newest` entries are kept —
 * default {@link UNANSWERED_NEWEST_CAP} (the fleet-health display cap). A
 * caller reading for exactly ONE recipient (e.g. coord:inbox's
 * `unanswered_only` filter, EI-13159) passes a larger cap so it can recover
 * every unanswered message's msg_id, not just the newest 3 — `count` was
 * always exact; only `newest` was ever capped.
 *
 * EI-20085805220385722: this fold stays PURE and liveness-BLIND. It returns the
 * TOTAL as `count` (unchanged, pre-partition) with `staleCount: 0`, and merely
 * populates `senders` — the rollup that makes the split computable at all.
 * The split itself is {@link partitionUnansweredByLiveness}, a separate pure
 * function, so both of its failure directions unit-test without PG.
 */
export function rowsToUnansweredMap(
  rows: readonly UnansweredDirectedRow[],
  nowMs: number,
  cap: number = UNANSWERED_NEWEST_CAP,
): Map<string, UnansweredDirectedSummary> {
  const out = new Map<string, UnansweredDirectedSummary>();
  for (const r of rows) {
    const cnt = Number(r.cnt);
    if (!Number.isFinite(cnt) || cnt <= 0) continue;
    const oldestTs = Number(r.oldest_ts_ms);
    const ids = r.newest_ids ?? [];
    const froms = r.newest_from ?? [];
    const summaries = r.newest_summary ?? [];
    const timestamps = r.newest_ts_ms ?? [];
    const newest: UnansweredDirectedEntry[] = [];
    for (let i = 0; i < ids.length && newest.length < cap; i++) {
      const msgId = ids[i];
      const from = froms[i];
      if (!msgId || !from) continue;
      const ts = Number(timestamps[i]);
      newest.push({
        msgId,
        from,
        ...(summaries[i] ? { summary: summaries[i] as string } : {}),
        ageMs: Number.isFinite(ts) ? Math.max(0, nowMs - ts) : 0,
      });
    }
    const senderIds = r.sender_ids ?? [];
    const senderCnts = r.sender_cnts ?? [];
    const senderOldest = r.sender_oldest_ts_ms ?? [];
    const senders: UnansweredSenderRollup[] = [];
    for (let i = 0; i < senderIds.length; i++) {
      const from = senderIds[i];
      if (!from) continue;
      const scnt = Number(senderCnts[i]);
      if (!Number.isFinite(scnt) || scnt <= 0) continue;
      const sOldest = Number(senderOldest[i]);
      senders.push({
        from,
        count: scnt,
        oldestAgeMs: Number.isFinite(sOldest) ? Math.max(0, nowMs - sOldest) : 0,
      });
    }
    const senderTotal = Number(r.sender_total);
    out.set(r.recipient, {
      count: cnt,
      oldestAgeMs: Number.isFinite(oldestTs) ? Math.max(0, nowMs - oldestTs) : 0,
      newest,
      staleCount: 0,
      staleOldestAgeMs: 0,
      senders,
      ...(Number.isFinite(senderTotal) && senderTotal > senders.length
        ? { sendersTruncated: true as const }
        : {}),
    });
  }
  return out;
}

/**
 * PURE: split a summary's `count` into the population a peer is actually
 * BLOCKED behind (`count`) and the population whose sender is positively dead
 * (`staleCount`) — EI-20085805220385722.
 *
 * ⚠ THE LOAD-BEARING INVARIANT — FAIL OPEN TOWARD COUNTING. Only a POSITIVE
 * `'ended'` verdict may demote a message. An oracle error, a timeout, an
 * unknown verdict, a missing row, a sender past {@link UNANSWERED_SENDER_CAP},
 * or a `senderState` predicate that THROWS all leave the message in `count` —
 * today's behaviour. The degradation direction is not symmetric and must stay
 * that way: suppressing a genuinely blocked peer because a liveness probe
 * failed is strictly worse than the stale-counter noise this fixes. Both
 * directions are tested explicitly.
 *
 * `senderState` is the caller's liveness lookup. Returning `null`/`undefined`
 * means "not measured" and is recorded as `'unknown'` — never collapsed into a
 * state (mirrors LivenessVerdict.sessionState's own null contract).
 */
export function partitionUnansweredByLiveness(
  summary: UnansweredDirectedSummary,
  senderState: (ownerId: string) => SessionState | null | undefined,
): UnansweredDirectedSummary {
  const resolve = (ownerId: string): SessionState | 'unknown' => {
    try {
      return senderState(ownerId) ?? 'unknown';
    } catch {
      // A throwing probe is ABSENCE of evidence, never evidence of death.
      return 'unknown';
    }
  };

  const senders: UnansweredSenderRollup[] = [];
  let staleCount = 0;
  let staleOldestAgeMs = 0;
  let liveCount = 0;
  let liveOldestAgeMs = 0;
  for (const s of summary.senders) {
    const state = resolve(s.from);
    senders.push({ ...s, senderState: state });
    if (state === 'ended') {
      staleCount += s.count;
      staleOldestAgeMs = Math.max(staleOldestAgeMs, s.oldestAgeMs);
    } else {
      liveCount += s.count;
      liveOldestAgeMs = Math.max(liveOldestAgeMs, s.oldestAgeMs);
    }
  }

  // Messages the rollup could not account for (a sender past the cap, or a row
  // carrying no rollup at all) are UNKNOWN, so they stay in `count` — and their
  // ages are unknown too, which is why `oldestAgeMs` then falls back to the
  // whole population's oldest rather than the live subset's.
  const unaccounted = Math.max(0, summary.count - (staleCount + liveCount));
  const bounded = unaccounted > 0 || summary.sendersTruncated === true;
  const count = liveCount + unaccounted;
  if (staleCount === 0) {
    // Nothing to demote: preserve the original numbers byte-for-byte so a
    // fully-live recipient is untouched by this pass. `staleCountBounded` still
    // applies — a ZERO computed over a capped sender set is a floor too, and
    // reading it as a total is the exact error the marker exists to prevent.
    return {
      ...summary,
      senders,
      staleCount: 0,
      staleOldestAgeMs: 0,
      ...(bounded ? { staleCountBounded: true as const } : {}),
    };
  }

  const stateByFrom = new Map(senders.map((s) => [s.from, s.senderState]));
  return {
    ...summary,
    count,
    oldestAgeMs: unaccounted > 0 ? summary.oldestAgeMs : liveOldestAgeMs,
    newest: summary.newest.map((e) => ({
      ...e,
      senderState: stateByFrom.get(e.from) ?? 'unknown',
    })),
    staleCount,
    staleOldestAgeMs,
    ...(bounded ? { staleCountBounded: true as const } : {}),
    senders,
  };
}

/**
 * IO seam: batch-read unanswered directed messages for a set of ownerIds.
 * Only recipients with >=1 unanswered message come back (absent ⇒ zero,
 * mirroring fetchContextPressure's "absent ⇒ default" contract).
 *
 * Runs on the SAME handle + workspace the coordLog seam reads/writes (mirrors
 * readAckedMsgIds/readInbox's fast-path convention) — gated on
 * `coordHasPgFastPath()` so a swapped seam (tests, an in-memory double) never
 * queries an unrelated store; it resolves to an empty map instead (this is a
 * fleet-health NICE-TO-HAVE decoration, best-effort like its siblings
 * decorateContextPressure/decorateParkedOn — never worth a slow full-scan
 * fallback).
 *
 * `opts.perRecipientCap` overrides {@link UNANSWERED_NEWEST_CAP} for both the
 * SQL array slice and the fold — pass a larger value for a single-recipient
 * read that needs every unanswered msg_id (EI-13159), not just the newest 3.
 */
export async function fetchUnansweredDirected(
  recipientIds: string[],
  opts: {
    nowMs?: number;
    lookbackMs?: number;
    perRecipientCap?: number;
    /** Explicit workspace for background sweeps that scan multiple coord partitions. */
    workspaceId?: string;
    /** DI seam (unit tests): override the positive death-evidence read used for
     *  the EI-20085805220385722 live/stale split. */
    endedSendersFn?: EndedSendersFn;
  } = {},
): Promise<Map<string, UnansweredDirectedSummary>> {
  if (recipientIds.length === 0 || !coordHasPgFastPath()) return new Map();
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = nowMs - (opts.lookbackMs ?? UNANSWERED_LOOKBACK_MS);
  const cap = opts.perRecipientCap ?? UNANSWERED_NEWEST_CAP;
  const senderCap = UNANSWERED_SENDER_CAP;
  const sql = coordSql();
  const workspaceId = opts.workspaceId ?? coordWorkspaceId();
  // P-013: an expectEffect directive is answered by the named side effect itself,
  // even when the recipient never sends a reply. Resolve these through the same
  // actuation reader used by fleet:leader-brief, then exclude only proven-satisfied
  // envelope ids below. Unknown/not-yet/pre-existing effects remain unanswered.
  const satisfiedEffectMsgIds = await fetchSatisfiedDirectiveMessageIds(recipientIds, {
    nowMs,
    lookbackMs: opts.lookbackMs,
    workspaceId,
  });
  // P-005 (plan papercusp-performance-audit-2026-10-12, decision D-002): JIT is off for
  // this one statement. Its estimated cost (~750k on the live box, inflated by
  // jsonb-expression misestimates) is far above jit_above_cost, so every bulk call paid
  // 110-180 ms of LLVM code emission for a statement that executes in 150-380 ms.
  // SET LOCAL needs a transaction; the setting ends with it.
  const rows = await sql.begin(async (tx) => {
    await tx`SET LOCAL jit = off`;
    return await tx<UnansweredDirectedRow[]>`
    -- P-005 (papercusp-performance-audit-2026-10-12, D-002): start from the ASKS and probe
    -- for their answers, so the cost grows with the directed asks addressed to the roster,
    -- not with everything the roster ever wrote.
    --
    -- WHAT THIS REPLACED. WI-6853 / WI-6875 (P-017) materialized every message ever
    -- authored by a roster member (a roster_authored CTE) and anti-joined the asks against
    -- it, because the planner trusted a 1-row estimate for jsonb-expression filters and
    -- re-ran each correlated probe over ~75k rows. That removed the per-row rescans but made
    -- the cost track the roster's whole authored history. Measured 2026-10-12 on the live
    -- box: 2,880 ms mean over 26,430 calls (pg_stat_statements); top-100 roster 1,237 ms,
    -- the roster_authored scan alone 29,458 rows and 109,798 buffers.
    --
    -- HOW THIS FORM AVOIDS BOTH TRAPS.
    --   * Every lookup is a correlated LATERAL fenced with OFFSET 0, so the planner cannot
    --     flatten it into a join and choose a hash join over every reply-shaped row (unfenced
    --     it did: 62,654 rows, 629 ms). Each probe is an index lookup keyed by the ask:
    --       the asks       -> coord_event_log_msgs_to_expects_reply_gin (migration 1479)
    --       replies        -> coord_event_log_related_msg_id_idx
    --       ack ping-pong  -> coord_event_log_msg_id_idx (the msg_id column equals
    --                         body->>'msg_id' on every message row)
    --       loose replies  -> coord_event_log_msgs_from_idx plus
    --                         coord_event_log_msgs_from_system_session_idx (migration 1479),
    --                         only for recipients that still have open asks
    --   * Each body is decompressed ONCE. Bodies average ~2.5 kB and are stored
    --     pglz-compressed, and every body->>'x' decompresses the whole value again (~4 us).
    --     LATERAL (SELECT body || '{}'::jsonb ... OFFSET 0) yields one decompressed copy and
    --     the fields are read from it. Predicates a partial index must prove (expectsReply,
    --     the to-array overlap) stay on the base column.
    --
    -- SEMANTICS ARE UNCHANGED, including what is deliberately NOT time-bounded: the
    -- threaded-reply and ack ping-pong lookups have no time bound, and a message's 'ts' is
    -- supplied by its sender (peer hosts' clocks included), so nothing here assumes the
    -- insertion-time ts column tracks body ts. Loose replies keep their lookback and are also
    -- limited to rows no older than the pair's oldest open ask, which the count below already
    -- requires (lr.ts_ms >= o.ts_ms). A 'system:<role>/<session>' sender still counts as
    -- <session> (identity.ts senderMatchesFilter); 'body ? related_msg_id' stays a
    -- key-presence test.
    --
    -- Verified 2026-10-12 against the previous form with identical bound parameters on the
    -- live workspace: identical result rows for the top 20 / 50 / 100 recipients, at
    -- 154 vs 352 ms, 266 vs 1,396 ms and 302-384 vs 1,251-1,994 ms (JIT off for both).
    -- unanswered-directed-query-plan.integration.test.ts keeps the previous form as a frozen
    -- oracle and asserts equivalence and the access paths.
    WITH directed AS MATERIALIZED (
      SELECT
        e.id AS event_id,
        e.workspace_id,
        eb.b->>'msg_id' AS msg_id,
        eb.b->>'from' AS from_id,
        eb.b->>'summary' AS summary,
        eb.b->'why'->>'goalRef' AS goal_ref,
        (extract(epoch FROM (eb.b->>'ts')::timestamptz) * 1000)::bigint AS ts_ms,
        r AS recipient
      FROM harness_shared.coord_event_log e
      CROSS JOIN LATERAL (SELECT e.body || '{}'::jsonb AS b OFFSET 0) eb
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(eb.b->'to') = 'array' THEN eb.b->'to' ELSE '[]'::jsonb END
      ) AS r
      WHERE e.workspace_id = ${workspaceId}
        AND e.surface = 'messages'
        AND e.body->'to' ?| ${recipientIds}::text[]
        AND (e.body->>'expectsReply') = 'true'
        AND (eb.b->>'kind' IS NULL OR eb.b->>'kind' = 'message')
        AND (
          NOT (eb.b ? 'audience')
          OR (
            jsonb_typeof(eb.b->'audience') = 'array'
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(eb.b->'audience') = 'array'
                    THEN eb.b->'audience'
                    ELSE '[]'::jsonb
                  END
                ) AS audience_selector(value)
               WHERE audience_selector.value LIKE '@file:%'
                  OR audience_selector.value LIKE '@fleet-leader:%'
            )
            AND NOT ((eb.b->'audience') ? '*')
          )
        )
        AND jsonb_typeof(eb.b->'to') = 'array'
        AND r = ANY(${recipientIds}::text[])
        AND eb.b->>'from' IS DISTINCT FROM r
        AND (eb.b->>'msg_id' IS NULL OR NOT (eb.b->>'msg_id' = ANY(${[...satisfiedEffectMsgIds]}::text[])))
        AND (eb.b->>'ts')::timestamptz >= to_timestamp(${sinceMs}::double precision / 1000)
        AND ((eb.b->>'expects') IS DISTINCT FROM 'none'
             OR eb.b->>'lifecycle' = 'release_request')
        AND ((eb.b->>'auto') IS DISTINCT FROM 'true'
             OR eb.b->>'lifecycle' = 'release_request')
        AND NOT (eb.b->>'from' ~ ${MACHINE_SENDER_PATTERN})
        -- WI-4537(c) ack ping-pong: a non-action, non-answer reply to something the
        -- recipient itself sent is not a fresh ask.
        AND NOT (
          eb.b ? 'related_msg_id'
          AND (eb.b->>'expects') IS DISTINCT FROM 'action'
          AND (eb.b->>'expects') IS DISTINCT FROM 'answer'
          AND EXISTS (
            SELECT 1 FROM harness_shared.coord_event_log ra
             WHERE ra.workspace_id = e.workspace_id
               AND ra.msg_id = eb.b->>'related_msg_id'
               AND ra.surface = 'messages'
               AND CASE
                     WHEN ra.body->>'from' LIKE 'system:%' AND strpos(ra.body->>'from', '/') > 0
                     THEN substr(ra.body->>'from', strpos(ra.body->>'from', '/') + 1)
                     ELSE ra.body->>'from'
                   END = r
          )
        )
    ),
    -- Threaded replies (related_msg_id = the ask) written by the ask's recipient.
    replies AS MATERIALIZED (
      SELECT rr.reply_event_id, d.msg_id AS asked_msg_id, d.recipient, rr.goal_ref, rr.reply_ts_ms
        FROM (SELECT DISTINCT workspace_id, msg_id, recipient FROM directed WHERE msg_id IS NOT NULL) d
        CROSS JOIN LATERAL (
          SELECT ra.id AS reply_event_id,
                 rb.b->'why'->>'goalRef' AS goal_ref,
                 (extract(epoch FROM (rb.b->>'ts')::timestamptz) * 1000)::bigint AS reply_ts_ms
            FROM harness_shared.coord_event_log ra
            CROSS JOIN LATERAL (SELECT ra.body || '{}'::jsonb AS b OFFSET 0) rb
           WHERE (ra.body->>'related_msg_id') = d.msg_id
             AND ra.body ? 'related_msg_id'
             AND ra.workspace_id = d.workspace_id
             AND ra.surface = 'messages'
             AND CASE
                   WHEN rb.b->>'from' LIKE 'system:%' AND strpos(rb.b->>'from', '/') > 0
                   THEN substr(rb.b->>'from', strpos(rb.b->>'from', '/') + 1)
                   ELSE rb.b->>'from'
                 END = d.recipient
          OFFSET 0
        ) rr
    ),
    -- EI-22458045233456597: one exact reply clears every EARLIER same-goal ask from
    -- that sender, never a later one.
    answered_goal_clusters AS MATERIALIZED (
      SELECT DISTINCT d.workspace_id, d.recipient, d.from_id, d.goal_ref,
             rp.reply_ts_ms, rp.reply_event_id
        FROM directed d
        JOIN replies rp ON rp.asked_msg_id = d.msg_id AND rp.recipient = d.recipient
       WHERE d.goal_ref IS NOT NULL
         AND rp.goal_ref = d.goal_ref
    ),
    open_asks AS MATERIALIZED (
      SELECT d.*,
             row_number() OVER (
               PARTITION BY d.recipient, d.from_id ORDER BY d.ts_ms DESC, d.msg_id DESC
             ) AS ask_rank
        FROM directed d
       WHERE NOT EXISTS (
               SELECT 1 FROM replies rp
                WHERE rp.asked_msg_id = d.msg_id AND rp.recipient = d.recipient
             )
         AND NOT EXISTS (
               SELECT 1 FROM answered_goal_clusters agc
                WHERE agc.workspace_id = d.workspace_id
                  AND agc.recipient = d.recipient
                  AND agc.from_id = d.from_id
                  AND agc.goal_ref = d.goal_ref
                  AND (agc.reply_ts_ms > d.ts_ms
                       OR (agc.reply_ts_ms = d.ts_ms AND agc.reply_event_id >= d.event_id))
             )
    ),
    ask_pairs AS (
      SELECT recipient, from_id AS asker, min(ts_ms) AS oldest_ts_ms
        FROM open_asks
       GROUP BY recipient, from_id
    ),
    -- WI-5345 / WI-6729: un-threaded messages a recipient sent back to the asker. Read
    -- only for recipients that still have open asks.
    loose_candidates AS MATERIALIZED (
      SELECT ar.recipient, c.id, c.b->'to' AS to_arr,
             (extract(epoch FROM (c.b->>'ts')::timestamptz) * 1000)::bigint AS ts_ms
        FROM (SELECT DISTINCT recipient FROM ask_pairs) ar
        CROSS JOIN LATERAL (
          SELECT x.id, xb.b
            FROM harness_shared.coord_event_log x
            CROSS JOIN LATERAL (SELECT x.body || '{}'::jsonb AS b OFFSET 0) xb
           WHERE x.workspace_id = ${workspaceId} AND x.surface = 'messages'
             AND x.body->>'from' = ar.recipient
          UNION ALL
          SELECT x.id, xb.b
            FROM harness_shared.coord_event_log x
            CROSS JOIN LATERAL (SELECT x.body || '{}'::jsonb AS b OFFSET 0) xb
           WHERE x.workspace_id = ${workspaceId} AND x.surface = 'messages'
             AND x.body->>'from' LIKE 'system:%'
             AND strpos(x.body->>'from', '/') > 0
             AND substr(x.body->>'from', strpos(x.body->>'from', '/') + 1) = ar.recipient
        ) c
       WHERE CASE
               WHEN c.b->>'from' LIKE 'system:%' AND strpos(c.b->>'from', '/') > 0
               THEN substr(c.b->>'from', strpos(c.b->>'from', '/') + 1)
               ELSE c.b->>'from'
             END = ar.recipient
         AND NOT (c.b ? 'related_msg_id')
         -- A new message that itself requests a reply is not evidence that the
         -- recipient answered an older ask. Keep legacy envelopes with no
         -- "expects" field, but explicit ack/answer/action asks stay open.
         AND ((c.b->>'expects') IS NULL OR c.b->>'expects' = 'none')
         AND c.b->>'lifecycle' IS DISTINCT FROM 'release_request'
         AND (c.b->>'ts')::timestamptz >= to_timestamp(${sinceMs}::double precision / 1000)
    ),
    loose_replies AS MATERIALIZED (
      SELECT DISTINCT lc.id, p.recipient AS from_id, p.asker AS to_id, lc.ts_ms
        FROM ask_pairs p
        JOIN loose_candidates lc ON lc.recipient = p.recipient AND lc.ts_ms >= p.oldest_ts_ms
       WHERE EXISTS (
               SELECT 1
                 FROM jsonb_array_elements_text(
                        CASE WHEN jsonb_typeof(lc.to_arr) = 'array' THEN lc.to_arr ELSE '[]'::jsonb END
                      ) AS rt
                WHERE rt = p.asker
             )
    ),
    -- N un-threaded replies clear the N most recent asks from that sender.
    unanswered AS (
      SELECT o.* FROM open_asks o
       WHERE (
         SELECT count(*) FROM loose_replies lr
          WHERE lr.from_id = o.recipient
            AND lr.to_id = o.from_id
            AND lr.ts_ms >= o.ts_ms
       ) < o.ask_rank
    ),
    per_sender AS (
      SELECT recipient, from_id AS sender, count(*)::bigint AS scnt, min(ts_ms) AS soldest
        FROM unanswered
       GROUP BY recipient, from_id
    ),
    -- Busiest sender first, so the bounded slice keeps the senders accounting
    -- for the most of cnt; sender_total reports whether anything was dropped
    -- (the fold turns that into sendersTruncated / staleCountBounded rather
    -- than letting a floor read as a total).
    sender_rollup AS (
      SELECT recipient,
             count(*)::bigint AS sender_total,
             (array_agg(sender ORDER BY scnt DESC, sender))[1:${senderCap}] AS sender_ids,
             (array_agg(scnt ORDER BY scnt DESC, sender))[1:${senderCap}] AS sender_cnts,
             (array_agg(soldest ORDER BY scnt DESC, sender))[1:${senderCap}] AS sender_oldest_ts_ms
        FROM per_sender
       GROUP BY recipient
    )
    SELECT u.recipient,
           count(*) AS cnt,
           min(u.ts_ms) AS oldest_ts_ms,
           (array_agg(u.msg_id ORDER BY u.ts_ms DESC))[1:${cap}] AS newest_ids,
           (array_agg(u.from_id ORDER BY u.ts_ms DESC))[1:${cap}] AS newest_from,
           (array_agg(u.summary ORDER BY u.ts_ms DESC))[1:${cap}] AS newest_summary,
           (array_agg(u.ts_ms ORDER BY u.ts_ms DESC))[1:${cap}] AS newest_ts_ms,
           sr.sender_total,
           sr.sender_ids,
           sr.sender_cnts,
           sr.sender_oldest_ts_ms
      FROM unanswered u
      JOIN sender_rollup sr ON sr.recipient = u.recipient
     GROUP BY u.recipient, sr.sender_total, sr.sender_ids, sr.sender_cnts, sr.sender_oldest_ts_ms
    `;
  });
  const map = rowsToUnansweredMap(rows, nowMs, cap);
  return decorateUnansweredLiveness(map, opts);
}

/**
 * EI-20085805220385722: resolve each still-waiting SENDER's liveness and apply
 * {@link partitionUnansweredByLiveness}. A sender whose session has ended has
 * nobody behind the ask, so its message must not ride the "outranks your own
 * work" preemption — but it is REPORTED (staleCount), never silently dropped.
 *
 * The evidence source is {@link EndedSendersFn} — POSITIVE death evidence only
 * (`endedRecordedOwnerIds`: the sender's most-recent recorded session has an
 * `ended_at`). Read that type's warning before changing it: the obvious
 * "upgrade" to the full `resolveSessionStates` verdict is what this code did
 * first, and it zeroed every unanswered counter, because that oracle answers
 * `'ended'` for a bare id it has never heard of. One batched query, no
 * per-subject point reads, and an unknown sender is absent from the set rather
 * than presumed dead.
 *
 * The distinct-sender set is additionally capped in SQL
 * ({@link UNANSWERED_SENDER_CAP} per recipient).
 *
 * Best-effort like its sibling decorations: ANY failure returns the
 * unpartitioned map, i.e. every message keeps counting.
 */
export async function decorateUnansweredLiveness(
  map: Map<string, UnansweredDirectedSummary>,
  opts: { endedSendersFn?: EndedSendersFn } = {},
): Promise<Map<string, UnansweredDirectedSummary>> {
  const senderIds = new Set<string>();
  for (const summary of map.values()) {
    for (const s of summary.senders) senderIds.add(s.from);
  }
  if (senderIds.size === 0) return map;
  const endedFn = opts.endedSendersFn ?? endedRecordedOwnerIds;
  let ended: ReadonlySet<string>;
  try {
    ended = await endedFn([...senderIds]);
  } catch {
    return map; // fail OPEN — a read failure never demotes a live obligation
  }
  const out = new Map<string, UnansweredDirectedSummary>();
  for (const [recipient, summary] of map) {
    out.set(
      recipient,
      // Absent from the set ⇒ `undefined` ⇒ 'unknown' ⇒ still counts.
      partitionUnansweredByLiveness(summary, (ownerId) => (ended.has(ownerId) ? 'ended' : undefined)),
    );
  }
  return out;
}

/**
 * fetchOpenAsks — the SENDER-side mirror of fetchUnansweredDirected above
 * (WI-2142142). unanswered-directed answers "what do I still OWE?" (a
 * per-RECIPIENT aggregate); this answers "what am I still OWED?" — directed
 * messages THIS agent sent, expecting a reply, that the recipient has not
 * yet answered by any of the same rules (exact thread, or the WI-6729
 * narrowed+paired loose-reply branch).
 *
 * Filed from a turn-start-orientation review: the per-recipient "what do I
 * still owe?" counter has no sender-side counterpart anywhere in the block,
 * so an agent is told what it owes and never what it is owed. Measured
 * 2026-09-02 (same query shape as below, workspace papercusp-workspace): 79
 * open asks across 34 distinct askers, mean age 17.0h.
 *
 * SAME exclusion rules as fetchUnansweredDirected, mirrored rather than
 * reimplemented from scratch, so the two definitions cannot silently diverge
 * on what counts as "directed" / "expects reply" / "noise":
 *   - directed, non-broadcast, sender != recipient (WI-4537-style);
 *   - expectsReply / expects!='none' (EI-19315474516256070), with the
 *     release_request carve-out (WI-7147);
 *   - machine-sender exclusion (WI-4537 a/b);
 *   - the ACK-PING-PONG exclusion (WI-4537 c), reversed: a message THIS
 *     sender sent that is itself a reply to something the RECIPIENT sent is
 *     our answer arriving to them, not a fresh ask on them;
 *   - the exact-thread-reply check (open_asks), and the WI-6729
 *     narrowed+paired loose-reply branch (open_final) — a reply threaded to
 *     a DIFFERENT message is not evidence for THIS ask, and one loose reply
 *     clears at most one ask (newest-first).
 *
 * NOT mirrored: the P-013 expectEffect satisfied-directive exclusion
 * (fetchSatisfiedDirectiveMessageIds). That reads "did the RECIPIENT already
 * satisfy this by an observed side effect", which needs the recipient set
 * BEFORE it can be queried — this function derives that set FROM the sent
 * CTE below, so resolving it would need a second round trip. Left as a
 * known scope boundary: an ask whose obligation was satisfied by effect
 * rather than reply will show here as still-open until the recipient also
 * replies (or it ages out of the lookback window). Filed as a follow-up
 * rather than blocking this fold on it.
 *
 * PERFORMANCE: unlike the recipient-side query (which scans the WHOLE
 * roster against the whole table and needed the WI-7048 indexes + WI-6875
 * materialization to avoid a per-row full scan), this is scoped from the
 * start to senderIds — typically ONE owner, called once per turn. The sent
 * CTE is bounded by the existing coord_event_log_msgs_from_idx partial
 * index (migration 1053), and replier_authored is bounded by that same
 * index to only the recipients sent actually names (never the whole
 * roster) — the same equivalence-preserving pre-filter shape WI-6875
 * established, just derived from sent instead of a caller-supplied array.
 */
export interface OpenAskEntry {
  msgId: string;
  /** The recipient we are still waiting on. */
  to: string;
  summary?: string;
  ageMs: number;
  /** Populated only when the sender-side liveness partition runs. */
  recipientState?: SessionState | 'unknown';
}

/**
 * EI-22401733710869471: one row per distinct recipient still owed an answer.
 * The `newest` array is display-capped, so this bounded rollup is what lets the
 * liveness partition account for the exact count it can safely classify.
 */
export interface OpenAskRecipientRollup {
  to: string;
  count: number;
  oldestAgeMs: number;
  recipientState?: SessionState | 'unknown';
}

export interface OpenAskSummary {
  count: number;
  oldestAgeMs: number;
  /** The recipient of the OLDEST open ask — computed directly in SQL so it
   *  is always correct even when `count` exceeds the `newest` cap below. */
  oldestTo: string;
  /** Newest-first, capped at NEWEST_CAP even when `count` is larger. */
  newest: OpenAskEntry[];
  /** As with unanswered_directed.staleCount, positively-dead asks are retained
   *  here for reporting but no longer count as a live obligation. */
  staleCount: number;
  staleOldestAgeMs: number;
  /** Bounded per-recipient rollup used by the liveness partition. */
  recipients: OpenAskRecipientRollup[];
  /** Set when the rollup omits at least one distinct recipient. */
  recipientsTruncated?: true;
  /** A stale count is a floor when recipients were omitted or unaccounted. */
  staleCountBounded?: true;
}

export interface OpenAskRow {
  sender: string;
  cnt: string | number;
  oldest_ts_ms: string | number;
  oldest_to: string | null;
  newest_ids: (string | null)[] | null;
  newest_to: (string | null)[] | null;
  newest_summary: (string | null)[] | null;
  newest_ts_ms: (string | number | null)[] | null;
  /** EI-22401733710869471 per-recipient rollup — absent on hand-built rows. */
  recipient_total?: string | number | null;
  recipient_ids?: (string | null)[] | null;
  recipient_cnts?: (string | number | null)[] | null;
  recipient_oldest_ts_ms?: (string | number | null)[] | null;
}

/**
 * PURE: fold the aggregated SQL rows into the per-sender summary map.
 * Mirrors rowsToUnansweredMap — unit-testable with hand-built rows, no PG
 * required. A row with `oldest_to` null (should not happen once `cnt` > 0,
 * since the aggregate always has at least one member) degrades to the
 * first `newest` entry's recipient rather than an empty string.
 */
export function rowsToOpenAsksMap(
  rows: readonly OpenAskRow[],
  nowMs: number,
  cap: number = UNANSWERED_NEWEST_CAP,
): Map<string, OpenAskSummary> {
  const out = new Map<string, OpenAskSummary>();
  for (const r of rows) {
    const cnt = Number(r.cnt);
    if (!Number.isFinite(cnt) || cnt <= 0) continue;
    const oldestTs = Number(r.oldest_ts_ms);
    const ids = r.newest_ids ?? [];
    const tos = r.newest_to ?? [];
    const summaries = r.newest_summary ?? [];
    const timestamps = r.newest_ts_ms ?? [];
    const newest: OpenAskEntry[] = [];
    for (let i = 0; i < ids.length && newest.length < cap; i++) {
      const msgId = ids[i];
      const to = tos[i];
      if (!msgId || !to) continue;
      const ts = Number(timestamps[i]);
      newest.push({
        msgId,
        to,
        ...(summaries[i] ? { summary: summaries[i] as string } : {}),
        ageMs: Number.isFinite(ts) ? Math.max(0, nowMs - ts) : 0,
      });
    }
    const recipientIds = r.recipient_ids ?? [];
    const recipientCnts = r.recipient_cnts ?? [];
    const recipientOldest = r.recipient_oldest_ts_ms ?? [];
    const recipients: OpenAskRecipientRollup[] = [];
    for (let i = 0; i < recipientIds.length; i++) {
      const to = recipientIds[i];
      if (!to) continue;
      const rcnt = Number(recipientCnts[i]);
      if (!Number.isFinite(rcnt) || rcnt <= 0) continue;
      const rOldest = Number(recipientOldest[i]);
      recipients.push({
        to,
        count: rcnt,
        oldestAgeMs: Number.isFinite(rOldest) ? Math.max(0, nowMs - rOldest) : 0,
      });
    }
    const recipientTotal = Number(r.recipient_total);
    out.set(r.sender, {
      count: cnt,
      oldestAgeMs: Number.isFinite(oldestTs) ? Math.max(0, nowMs - oldestTs) : 0,
      oldestTo: r.oldest_to ?? newest[0]?.to ?? '',
      newest,
      staleCount: 0,
      staleOldestAgeMs: 0,
      recipients,
      ...(Number.isFinite(recipientTotal) && recipientTotal > recipients.length
        ? { recipientsTruncated: true as const }
        : {}),
    });
  }
  return out;
}

/**
 * PURE: split an open-ask summary into asks whose recipient is positively dead
 * and asks that still have a recipient who may answer. Only an explicit
 * `'ended'` verdict demotes; unknown, missing, throwing, and over-cap evidence
 * all keep the ask counted. This mirrors partitionUnansweredByLiveness while
 * preserving the sender-side summary shape.
 */
export function partitionOpenAsksByLiveness(
  summary: OpenAskSummary,
  recipientState: (ownerId: string) => SessionState | null | undefined,
): OpenAskSummary {
  const resolve = (ownerId: string): SessionState | 'unknown' => {
    try {
      return recipientState(ownerId) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  const recipients: OpenAskRecipientRollup[] = [];
  let staleCount = 0;
  let staleOldestAgeMs = 0;
  let liveCount = 0;
  let liveOldestAgeMs = 0;
  for (const r of summary.recipients) {
    const state = resolve(r.to);
    recipients.push({ ...r, recipientState: state });
    if (state === 'ended') {
      staleCount += r.count;
      staleOldestAgeMs = Math.max(staleOldestAgeMs, r.oldestAgeMs);
    } else {
      liveCount += r.count;
      liveOldestAgeMs = Math.max(liveOldestAgeMs, r.oldestAgeMs);
    }
  }

  // A recipient beyond the rollup cap, or a legacy row without a rollup, is
  // unaccounted/unknown and therefore remains a live obligation.
  const unaccounted = Math.max(0, summary.count - (staleCount + liveCount));
  const bounded = unaccounted > 0 || summary.recipientsTruncated === true;
  const count = liveCount + unaccounted;
  if (staleCount === 0) {
    return {
      ...summary,
      recipients,
      staleCount: 0,
      staleOldestAgeMs: 0,
      ...(bounded ? { staleCountBounded: true as const } : {}),
    };
  }

  const stateByTo = new Map(recipients.map((r) => [r.to, r.recipientState]));
  const oldestLive = recipients.reduce<OpenAskRecipientRollup | undefined>((oldest, r) => {
    if (r.recipientState === 'ended') return oldest;
    return !oldest || r.oldestAgeMs > oldest.oldestAgeMs ? r : oldest;
  }, undefined);
  return {
    ...summary,
    count,
    oldestAgeMs: unaccounted > 0 ? summary.oldestAgeMs : liveOldestAgeMs,
    oldestTo: unaccounted > 0 ? summary.oldestTo : oldestLive?.to ?? '',
    newest: summary.newest.map((e) => ({
      ...e,
      recipientState: stateByTo.get(e.to) ?? 'unknown',
    })),
    staleCount,
    staleOldestAgeMs,
    recipients,
    ...(bounded ? { staleCountBounded: true as const } : {}),
  };
}

/**
 * Resolve open-ask recipients through the shared liveness oracle in one batch.
 * Presence rows are read first so a missing owner remains UNKNOWN rather than
 * inheriting the oracle's bare-id `ended` derivation. Positive ended-session
 * evidence still demotes a reaped recipient. No `hydratePerId`: this is a
 * bounded batch and every subject sent to the oracle already carries its
 * presence-row fields.
 */
async function resolveOpenAskRecipientStates(ownerIds: string[]): Promise<Map<string, SessionState | null>> {
  const ids = [...new Set(ownerIds.filter(Boolean))].slice(0, UNANSWERED_SENDER_CAP);
  if (ids.length === 0) return new Map();
  try {
    const presence = await listPresence({ workspaceId: coordWorkspaceId(), ownerIds: ids });
    const present = new Map(presence.map((p) => [p.ownerId, p]));
    const subjects: LivenessSubject[] = presence.map((p) => ({
      ownerId: p.ownerId,
      heartbeatAt: p.heartbeatAt,
      stale: p.stale,
      host: p.host,
      pid: p.pid,
      source: p.source,
      agentRole: p.agentRole ?? null,
    }));
    const [verdicts, ended] = await Promise.all([
      resolveSessionStates(subjects),
      endedRecordedOwnerIds(ids),
    ]);
    return new Map(
      ids.map((id) => {
        if (!present.has(id)) return [id, ended.has(id) ? ('ended' as const) : null];
        const state = verdicts.get(id)?.sessionState;
        return [id, state ?? (ended.has(id) ? ('ended' as const) : null)];
      }),
    );
  } catch {
    return new Map(ids.map((id) => [id, null]));
  }
}

/** Batch-decorate open asks with recipient liveness; failures fail open. */
export async function decorateOpenAsksLiveness(
  map: Map<string, OpenAskSummary>,
  opts: { recipientStatesFn?: OpenAskRecipientStatesFn } = {},
): Promise<Map<string, OpenAskSummary>> {
  const recipientIds = new Set<string>();
  for (const summary of map.values()) {
    for (const r of summary.recipients) recipientIds.add(r.to);
  }
  if (recipientIds.size === 0) return map;
  let states: ReadonlyMap<string, SessionState | null | undefined>;
  try {
    states = await (opts.recipientStatesFn ?? resolveOpenAskRecipientStates)([...recipientIds]);
  } catch {
    return map;
  }
  return new Map(
    [...map].map(([sender, summary]) => [
      sender,
      partitionOpenAsksByLiveness(summary, (ownerId) => states.get(ownerId)),
    ]),
  );
}

/**
 * IO seam: batch-read open (unanswered-by-recipient) directed messages sent
 * BY a set of senderIds. Only senders with >=1 open ask come back (absent ⇒
 * zero), mirroring fetchUnansweredDirected's contract.
 */
export async function fetchOpenAsks(
  senderIds: string[],
  opts: {
    nowMs?: number;
    lookbackMs?: number;
    perRecipientCap?: number;
    /** DI seam for the sender-side recipient-liveness partition. */
    recipientStatesFn?: OpenAskRecipientStatesFn;
  } = {},
): Promise<Map<string, OpenAskSummary>> {
  if (senderIds.length === 0 || !coordHasPgFastPath()) return new Map();
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = nowMs - (opts.lookbackMs ?? UNANSWERED_LOOKBACK_MS);
  const cap = opts.perRecipientCap ?? UNANSWERED_NEWEST_CAP;
  const recipientCap = UNANSWERED_SENDER_CAP;
  const sql = coordSql();
  const workspaceId = coordWorkspaceId();
  const rows = await sql<OpenAskRow[]>`
    WITH sent AS MATERIALIZED (
             SELECT
        e.id,
        e.workspace_id,
        e.body->>'msg_id'             AS msg_id,
        e.body->>'from'               AS from_id,
        e.body->>'summary'            AS summary,
        e.body->'why'->>'goalRef'    AS goal_ref,
        (extract(epoch FROM (e.body->>'ts')::timestamptz) * 1000)::bigint AS ts_ms,
        e.body ? 'related_msg_id'     AS has_related,
        e.body->>'related_msg_id'     AS related_msg_id,
        e.body->>'expects'            AS expects,
        r                             AS recipient
        FROM harness_shared.coord_event_log e
        CROSS JOIN LATERAL jsonb_array_elements_text(e.body->'to') AS r
       WHERE e.workspace_id = ${workspaceId}
         AND e.surface = 'messages'
         AND e.body->>'from' = ANY(${senderIds}::text[])
         AND jsonb_typeof(e.body->'to') = 'array'
         AND r IS DISTINCT FROM e.body->>'from'
         AND (e.body->>'kind' IS NULL OR e.body->>'kind' = 'message')
         AND (
           NOT (e.body ? 'audience')
           OR (
             jsonb_typeof(e.body->'audience') = 'array'
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements_text(
                   CASE WHEN jsonb_typeof(e.body->'audience') = 'array'
                     THEN e.body->'audience'
                     ELSE '[]'::jsonb
                   END
                 ) AS audience_selector(value)
                WHERE audience_selector.value LIKE '@file:%'
                   OR audience_selector.value LIKE '@fleet-leader:%'
             )
             AND NOT ((e.body->'audience') ? '*')
           )
         )
         AND (e.body->>'ts')::timestamptz >= to_timestamp(${sinceMs}::double precision / 1000)
         AND (e.body->>'expectsReply') = 'true'
         AND ((e.body->>'expects') IS DISTINCT FROM 'none' OR e.body->>'lifecycle' = 'release_request')
         AND ((e.body->>'auto') IS DISTINCT FROM 'true' OR e.body->>'lifecycle' = 'release_request')
         AND NOT (e.body->>'from' ~ ${MACHINE_SENDER_PATTERN})
    ),
    -- Bounded by the sent CTE above, never the whole roster — the recipients
    -- we might be waiting on are exactly (and only) the ones sent already named.
    replier_authored AS MATERIALIZED (
      SELECT ra.id,
             ra.workspace_id,
             ra.body->>'from'              AS from_id,
             ra.body->>'msg_id'            AS msg_id,
             ra.body->>'related_msg_id'    AS related_msg_id,
             ra.body->'why'->>'goalRef'    AS goal_ref,
             ra.body ? 'related_msg_id'    AS has_related,
             ra.body->'to'                 AS to_arr,
             ra.body->>'expects'          AS expects,
             ra.body->>'lifecycle'         AS lifecycle,
             (ra.body->>'ts')::timestamptz AS ts,
             (extract(epoch FROM (ra.body->>'ts')::timestamptz) * 1000)::bigint AS ts_ms
        FROM harness_shared.coord_event_log ra
       WHERE ra.workspace_id = ${workspaceId}
         AND ra.surface = 'messages'
         AND ra.body->>'from' IN (SELECT DISTINCT recipient FROM sent)
    ),
    loose_replies AS MATERIALIZED (
      SELECT DISTINCT ra.id, ra.workspace_id, ra.from_id, rt AS to_id,
             (extract(epoch FROM ra.ts) * 1000)::bigint AS ts_ms
        FROM replier_authored ra
        CROSS JOIN LATERAL jsonb_array_elements_text(ra.to_arr) AS rt
       WHERE NOT ra.has_related
         AND jsonb_typeof(ra.to_arr) = 'array'
         -- Keep this mirror aligned with fetchUnansweredDirected: an explicit
         -- reply expectation is a new ask, not a loose reply to the old one.
         AND (ra.expects IS NULL OR ra.expects = 'none')
         AND ra.lifecycle IS DISTINCT FROM 'release_request'
         AND ra.ts >= to_timestamp(${sinceMs}::double precision / 1000)
    ),
    -- WI-4537(c) mirrored: a message WE sent that is itself a reply to
    -- something the RECIPIENT sent is our answer arriving, not a fresh ask.
    -- EI-22192594388203470 mirrored: an explicit expects:'action'/'answer' on OUR OWN
    -- message overrides the structural reply-chain heuristic, same as the recipient-side
    -- fix above — it is our own declaration that this is a fresh ask on them, not merely
    -- our answer to something they sent. See fetchUnansweredDirected's \`directed\` CTE for
    -- the full incident writeup; kept in lockstep on purpose.
    candidate AS (
      SELECT s.* FROM sent s
       WHERE NOT (
         s.has_related
         AND s.expects IS DISTINCT FROM 'action'
         AND s.expects IS DISTINCT FROM 'answer'
         AND EXISTS (
           SELECT 1 FROM replier_authored ra
            WHERE ra.workspace_id = s.workspace_id
              AND ra.msg_id = s.related_msg_id
              AND ra.from_id = s.recipient
         )
         )
    ),
    -- Mirror fetchUnansweredDirected's goal-cluster fold for the sender-side
    -- open-ask read. Keep the same exact-thread + chronology rails so the two
    -- surfaces cannot disagree about whether one reply settled a cluster.
    answered_goal_clusters AS MATERIALIZED (
      SELECT DISTINCT c.workspace_id,
             c.recipient,
             c.from_id,
             c.goal_ref,
             ra.ts_ms AS reply_ts_ms,
             ra.id AS reply_event_id
        FROM candidate c
        JOIN replier_authored ra
          ON ra.workspace_id = c.workspace_id
         AND ra.from_id = c.recipient
         AND ra.related_msg_id = c.msg_id
       WHERE c.goal_ref IS NOT NULL
         AND ra.goal_ref = c.goal_ref
    ),
    open_asks AS (
      SELECT c.*,
             row_number() OVER (
               PARTITION BY c.recipient, c.from_id ORDER BY c.ts_ms DESC, c.msg_id DESC
             ) AS ask_rank
        FROM candidate c
       WHERE NOT EXISTS (
         SELECT 1 FROM replier_authored ra
          WHERE ra.workspace_id = c.workspace_id
            AND ra.from_id = c.recipient
            AND ra.related_msg_id = c.msg_id
       )
         AND NOT EXISTS (
           SELECT 1 FROM answered_goal_clusters agc
            WHERE agc.workspace_id = c.workspace_id
              AND agc.recipient = c.recipient
              AND agc.from_id = c.from_id
              AND agc.goal_ref = c.goal_ref
              AND (
                agc.reply_ts_ms > c.ts_ms
                OR (agc.reply_ts_ms = c.ts_ms AND agc.reply_event_id >= c.id)
              )
         )
    ),
    open_final AS (
      SELECT o.* FROM open_asks o
       WHERE (
         SELECT count(*) FROM loose_replies lr
          WHERE lr.workspace_id = o.workspace_id
            AND lr.from_id = o.recipient
            AND lr.to_id = o.from_id
            AND lr.ts_ms >= o.ts_ms
       ) < o.ask_rank
    ),
    -- EI-22401733710869471: "newest_*" is display-capped, so the sender-side
    -- liveness split needs its own bounded per-recipient rollup. Recipients
    -- beyond the cap stay counted as unknown by the pure partition.
    per_recipient AS (
      SELECT from_id AS sender,
             recipient AS to_id,
             count(*)::bigint AS rcnt,
             min(ts_ms) AS roldest
        FROM open_final
       GROUP BY from_id, recipient
    ),
    recipient_rollup AS (
      SELECT sender,
             count(*)::bigint AS recipient_total,
             (array_agg(to_id ORDER BY rcnt DESC, to_id))[1:${recipientCap}] AS recipient_ids,
             (array_agg(rcnt ORDER BY rcnt DESC, to_id))[1:${recipientCap}] AS recipient_cnts,
             (array_agg(roldest ORDER BY rcnt DESC, to_id))[1:${recipientCap}] AS recipient_oldest_ts_ms
        FROM per_recipient
       GROUP BY sender
    )
    SELECT from_id AS sender,
           count(*) AS cnt,
           min(ts_ms) AS oldest_ts_ms,
           (array_agg(recipient ORDER BY ts_ms ASC))[1] AS oldest_to,
           (array_agg(msg_id ORDER BY ts_ms DESC))[1:${cap}] AS newest_ids,
           (array_agg(recipient ORDER BY ts_ms DESC))[1:${cap}] AS newest_to,
           (array_agg(summary ORDER BY ts_ms DESC))[1:${cap}] AS newest_summary,
           (array_agg(ts_ms ORDER BY ts_ms DESC))[1:${cap}] AS newest_ts_ms,
           rr.recipient_total,
           rr.recipient_ids,
           rr.recipient_cnts,
           rr.recipient_oldest_ts_ms
      FROM open_final
      JOIN recipient_rollup rr ON rr.sender = open_final.from_id
     GROUP BY from_id, rr.recipient_total, rr.recipient_ids, rr.recipient_cnts, rr.recipient_oldest_ts_ms
  `;
  const map = rowsToOpenAsksMap(rows, nowMs, cap);
  return decorateOpenAsksLiveness(map, opts);
}
