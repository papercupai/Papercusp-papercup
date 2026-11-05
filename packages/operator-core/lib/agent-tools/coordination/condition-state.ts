/**
 * Shared condition fold and readers, independent of MCP tool registration.
 *
 * Severe system conditions (pipeline stalls, gate freezes) are broadcast as
 * condition-KEYED alarms and superseded by resolution broadcasts on recovery
 * (WI-1444: severe-event-broadcast.ts). That gives conditions a derivable
 * STATE — open vs resolved — but until this tool the only way to read it was
 * replaying message history. This folds the condition-keyed envelope stream
 * into current state: every key whose latest alarm is NEWER than its latest
 * resolution is OPEN; everything else is resolved.
 *
 * Read-only, low-tier (`coord:read`): the underlying condition rows are read
 * from the shared event log, independent of whether the caller subscribes to
 * the severe-events topic or received a particular alarm in its inbox.
 */

import { createCache } from "@papercusp/cache";
import type { CoordEnvelope } from "@papercusp/coordination/core";
import { coordLog, coordSql, coordWorkspaceId, coordHasPgFastPath } from "./log";
import { MESSAGE_GC_RETENTION_DAYS } from "./message-log-gc";
import { asSevereEventEmitter, type SevereEventEmitter } from "../../severe-event-emitter";

/** EI-9447 (WI-3937/WI-3869 furnace class): hard backstop on rows scanned by
 *  `readConditionEnvelopes`'s PG fast path, applied even within the retention
 *  window — the one bound that holds regardless of any burst of condition
 *  traffic. Condition rows are a rare sliver of the `messages` surface (live
 *  observed ~774 rows/call), so this comfortably clears any legitimate read
 *  while still capping a genuinely pathological burst. Mirrors
 *  INBOX_FAST_PATH_ROW_CAP (messages.ts). */
export const CONDITIONS_FAST_PATH_ROW_CAP = 25_000;

// Independent watchdogs can request the same 25k-row window concurrently.
// Reuse the cache's single-flight primitive, scoped to the actual PG handle
// AND workspace. Zero hard TTL forbids settled-result reuse; forget also drops
// the envelope window immediately instead of retaining an expired large value.
const conditionReads = new WeakMap<ReturnType<typeof coordSql>, ReturnType<typeof createCache>>();

/** One condition's folded state. */
export interface ConditionState {
  condition_key: string;
  /** open ⇔ the latest alarm is newer than the latest resolution. */
  open: boolean;
  /** sender of the latest alarm (usually 'system-watchdog'). */
  from: string;
  /** ambient category of the latest alarm (e.g. 'severe-event'). */
  category: string | null;
  /** ts of the FIRST alarm ever seen for this key (across ALL episodes — a
   *  flapping condition keeps this at its very first alarm forever). */
  first_seen: string;
  /** ts the CURRENT open episode began — the first alarm strictly newer than the
   *  latest resolution (equals `first_seen` when the key never resolved). null
   *  when the condition is currently resolved. Distinct from `first_seen` for a
   *  FLAPPING condition: use THIS, not first_seen, to judge how long a condition
   *  has been *continuously* open (EI-10653 — the staleness alarm reported a
   *  freshly-reopened flap as "OPEN for 1967m" by anchoring on first_seen). */
  open_since: string | null;
  /** ts of the LATEST alarm or condition heartbeat. */
  last_seen: string;
  /** total alarm broadcasts for this key (re-alarms after flapping included). */
  alarm_count: number;
  /** the latest alarm's one-line summary. */
  latest_summary: string | null;
  /** process identity stamped by the latest alarm emitter, when available. */
  latest_emitter?: SevereEventEmitter;
  /**
   * P-007 (converge-frozen-candidate-by-fix-only-admission-2026-08-27): the latest
   * alarm's FULLER BODY — what `SevereEventInput.body` is documented to carry,
   * "evidence + the recommended first step".
   *
   * Folding it is not cosmetic. The owning work-item the condition bridge mints is
   * the one surface a claimant reads at the moment of failure, and it is built from
   * this state — so while only `latest_summary` was folded, EVERY emitter's evidence
   * and recommended first step was dropped on the floor for EVERY condition family,
   * leaving the claimant a boilerplate template and a single headline. Null when the
   * emitter sent no body (most watchdogs), which reads as "there was none", never as
   * "it was lost".
   */
  latest_body: string | null;
  /**
   * WI-6228: the latest alarm declared its emitter ONE-SHOT — it alarms once per
   * episode and stays silent until recovery, so `last_seen` freezing is NOT
   * evidence the signal cleared. Optional: an envelope from an emitter that never
   * declared it is left `undefined`, preserving the pre-WI-6228 reading.
   */
  one_shot?: boolean;
  /** ts of the latest resolution, when one exists. */
  resolved_at: string | null;
  /** the latest resolution's one-line summary, when one exists. */
  resolved_summary: string | null;
}

/**
 * Fold condition-keyed envelopes (ascending ts) into per-key state. An
 * envelope with `resolves_condition` is a RESOLUTION for that key; an envelope
 * with `condition_key` and no `resolves_condition` is an ALARM. A key is open
 * iff its latest alarm ts is strictly newer than its latest resolution ts
 * (a re-alarm after recovery re-opens it). Pure.
 */
export function computeConditionStates(
  envelopes: readonly Record<string, unknown>[],
): ConditionState[] {
  const byKey = new Map<string, ConditionState>();
  // `last_seen` includes liveness heartbeats, but openness must still be decided
  // from the latest real alarm. Keeping that timestamp separately prevents a
  // late or out-of-order heartbeat from re-opening a condition after recovery.
  const latestAlarmByKey = new Map<string, string>();
  const emitterOf = (envelope: Record<string, unknown>): SevereEventEmitter | undefined => {
    const direct = asSevereEventEmitter(envelope["emitter"]);
    if (direct) return direct;
    const extra = envelope["extra"];
    return extra && typeof extra === "object" && !Array.isArray(extra)
      ? asSevereEventEmitter((extra as Record<string, unknown>)["emitter"])
      : undefined;
  };
  for (const e of envelopes) {
    const ts = typeof e["ts"] === "string" ? (e["ts"] as string) : null;
    if (!ts) continue;
    const extra = e["extra"];
    const conditionHeartbeat =
      e["condition_heartbeat"] === true ||
      (extra && typeof extra === "object" && !Array.isArray(extra) &&
        (extra as Record<string, unknown>)["condition_heartbeat"] === true);
    // EI-14072: a resolution can name ONE key (`resolves_condition`, singular —
    // broadcastSevereEventResolved) or SEVERAL at once (`resolves_conditions`,
    // plural array — broadcastSevereEventResolvedMany, EI-9030b's batched
    // "RECOVERED (a, b, c)" broadcast). Both must close EVERY key they name —
    // mirroring coord:inbox's `annotateResolvedConditions`, which already reads
    // both. This fold used to read ONLY the singular field, so a batched
    // recovery closed just its first key and left every other key it named
    // stuck open:true forever (feeding false condition-staleness escalations —
    // WI-2965's actor).
    const resolveKeys = new Set<string>();
    const resolvesSingle = e["resolves_condition"];
    if (typeof resolvesSingle === "string" && resolvesSingle) resolveKeys.add(resolvesSingle);
    const resolvesMany = e["resolves_conditions"];
    if (Array.isArray(resolvesMany)) {
      for (const k of resolvesMany) if (typeof k === "string" && k) resolveKeys.add(k);
    }
    if (resolveKeys.size > 0) {
      for (const resolves of resolveKeys) {
        const s = byKey.get(resolves);
        if (s) {
          if (!s.resolved_at || ts > s.resolved_at) {
            s.resolved_at = ts;
            s.resolved_summary =
              typeof e["summary"] === "string" ? (e["summary"] as string) : null;
          }
          // This recovery CLOSES the current open episode: the next alarm strictly
          // after it opens a fresh one (guarded so an out-of-order resolution older
          // than the current episode's open can't wrongly close it).
          if (s.open_since !== null && ts >= s.open_since) s.open_since = null;
        } else {
          // A resolution for a key we never saw alarm (log GC ate the alarm, or
          // a partial window). Record it resolved so it never reads as open.
          byKey.set(resolves, {
            condition_key: resolves,
            open: false,
            from: typeof e["from"] === "string" ? (e["from"] as string) : "",
            category: null,
            first_seen: ts,
            open_since: null,
            last_seen: ts,
            alarm_count: 0,
            latest_summary: null,
            latest_body: null,
            latest_emitter: undefined,
            resolved_at: ts,
            resolved_summary:
              typeof e["summary"] === "string" ? (e["summary"] as string) : null,
          });
        }
      }
      continue;
    }
    const key = e["condition_key"];
    if (typeof key !== "string" || !key) continue;
    const prev = byKey.get(key);
    if (conditionHeartbeat) {
      // Heartbeats are durable freshness markers emitted for a repeated, still-open
      // alarm. They must not count as another alarm or replace the alarm's evidence,
      // summary, emitter, episode start, or one-shot declaration. An orphan marker
      // cannot establish a condition by itself, so ignore it until its alarm is seen.
      if (prev && prev.alarm_count > 0 && ts >= prev.last_seen) prev.last_seen = ts;
      continue;
    }
    if (!prev) {
      byKey.set(key, {
        condition_key: key,
        open: true, // provisional; finalized below against resolved_at
        from: typeof e["from"] === "string" ? (e["from"] as string) : "",
        category:
          typeof e["category"] === "string" ? (e["category"] as string) : null,
        first_seen: ts,
        open_since: ts, // this alarm opens the first episode
        last_seen: ts,
        alarm_count: 1,
        latest_summary:
          typeof e["summary"] === "string" ? (e["summary"] as string) : null,
        latest_body: typeof e["body"] === "string" ? (e["body"] as string) : null,
        latest_emitter: emitterOf(e),
        one_shot: e["one_shot"] === true,
        resolved_at: null,
        resolved_summary: null,
      });
      latestAlarmByKey.set(key, ts);
    } else {
      prev.alarm_count += 1;
      const latestAlarm = latestAlarmByKey.get(key);
      if (!latestAlarm || ts > latestAlarm) latestAlarmByKey.set(key, ts);
      // Re-open a resolved (closed) key: this alarm starts a new episode. While
      // an episode is already open, keep its original start.
      if (prev.open_since === null) prev.open_since = ts;
      if (ts < prev.first_seen) prev.first_seen = ts;
      if (ts >= prev.last_seen) {
        prev.last_seen = ts;
        prev.latest_summary =
          typeof e["summary"] === "string" ? (e["summary"] as string) : null;
        // Assigned unconditionally beside latest_summary, so the two always describe
        // the SAME alarm. Carrying a previous episode's body forward past a body-less
        // re-alarm would attach stale evidence to a fresh failure — worse than none.
        prev.latest_body = typeof e["body"] === "string" ? (e["body"] as string) : null;
        prev.latest_emitter = emitterOf(e);
        // WI-6228: the LATEST alarm decides — an emitter that switched to/from
        // one-shot is described by what it most recently declared.
        prev.one_shot = e["one_shot"] === true;
        prev.from = typeof e["from"] === "string" ? (e["from"] as string) : prev.from;
        prev.category =
          typeof e["category"] === "string" ? (e["category"] as string) : prev.category;
      }
    }
  }
  const out = [...byKey.values()];
  for (const s of out) {
    const latestAlarm = latestAlarmByKey.get(s.condition_key);
    s.open = s.alarm_count > 0 && !!latestAlarm && (!s.resolved_at || latestAlarm > s.resolved_at);
    // Keep open_since consistent with the finalized open flag: a resolved
    // condition carries no current episode; an open one always has a start
    // (defensively fall back to last_seen if out-of-order folding left it null).
    if (!s.open) s.open_since = null;
    else if (s.open_since === null) s.open_since = s.last_seen;
  }
  // Open first, then most-recently-active first.
  out.sort((a, b) =>
    a.open !== b.open ? (a.open ? -1 : 1) : b.last_seen.localeCompare(a.last_seen),
  );
  return out;
}

/**
 * Load every condition-carrying envelope, cheapest available path. Exported
 * (WI-2965) so the coord:conditions staleness actor (system-health/
 * condition-staleness-alarm.ts) reads the SAME rows this tool's handler folds,
 * rather than re-deriving its own read path.
 */
export async function readConditionEnvelopes(): Promise<Record<string, unknown>[]> {
  // PG pushdown: condition rows are a tiny sliver of the messages surface —
  // filter server-side on the jsonb keys (mirrors readInbox's fast path: the
  // seam read is for a non-PG backend only; on PG a query error PROPAGATES,
  // never the whole-surface read — host-memory-reduction-2026-09-27 D-011).
  //
  // EI-9447 (WI-3937/WI-3869 furnace class): this was an UNBOUNDED scan of the
  // WHOLE `messages` surface — no ts/id lower bound, no LIMIT — averaging
  // 7.1s/call across 3,351 calls (the `body ? ...` jsonb-existence filter has
  // no supporting index, so every call walked the full surface, 774
  // rows/call). Two independent bounds, mirroring readInbox (WI-3825):
  //   (a) a `ts >=` lower bound at the message-log GC retention window
  //       (MESSAGE_GC_RETENTION_DAYS) — nothing older survives GC anyway, so
  //       this drops zero live state while giving the query a selective range
  //       to seek on;
  //   (b) a hard LIMIT backstop (CONDITIONS_FAST_PATH_ROW_CAP) regardless of
  //       the ts bound, so a pathological burst can never re-open the
  //       unbounded-scan hole.
  // Both are safe: a condition whose LATEST alarm/resolution both fall
  // outside the retention window is, by definition, not "wrong right now" —
  // GC would have already reaped it.
  if (coordHasPgFastPath()) {
    const sql = coordSql();
    const workspaceId = coordWorkspaceId();
    let shared = conditionReads.get(sql);
    if (!shared) {
      shared = createCache({ maxL1Entries: 1, defaultHardTtlMs: 0 });
      conditionReads.set(sql, shared);
    }
    try {
      const envelopes = await shared.getOrSet(workspaceId, "conditions", async () => {
        const sinceBound = new Date(Date.now() - MESSAGE_GC_RETENTION_DAYS * 86_400_000).toISOString();
        const rows = await sql<{ body: unknown }[]>`
          SELECT body
            FROM harness_shared.coord_event_log
           WHERE workspace_id = ${workspaceId}
             AND surface = 'messages'
             AND ts >= ${sinceBound}
             AND (body ? 'condition_key' OR body ? 'resolves_condition')
           ORDER BY id DESC
           LIMIT ${CONDITIONS_FAST_PATH_ROW_CAP}
        `;
        // Keep recent resolutions within the cap, then restore chronological
        // order for the fold. Transport and JSON parsing happen once per burst.
        return rows.reverse().map((r) =>
          (typeof r.body === "string" ? JSON.parse(r.body) : r.body) as Record<string, unknown>,
        );
      });
      // A caller can reorder its window or annotate fold fields independently.
      return envelopes.map((envelope) => ({
        ...envelope,
        ...(Array.isArray(envelope.resolves_conditions)
          ? { resolves_conditions: [...envelope.resolves_conditions] } : {}),
      }));
    } finally {
      shared.forget(workspaceId, "conditions");
    }
  }
  const lines = (await coordLog.readLines("messages")) as CoordEnvelope[];
  return (lines as unknown as Record<string, unknown>[]).filter(
    (l) => "condition_key" in l || "resolves_condition" in l,
  );
}

/**
 * Read the lifecycle envelopes for one exact condition key.
 *
 * The aggregate fold above is intentionally bounded to the newest condition
 * window.  An exact lookup must not make callers scan or page that aggregate:
 * the partial JSONB index can seek the requested key directly, including keys
 * that are quiet while unrelated conditions keep the aggregate window full.
 * The non-PG seam keeps the same contract by filtering the already available
 * log rows locally.
 */
export async function readConditionEnvelopesForKey(
  conditionKey: string,
): Promise<Record<string, unknown>[]> {
  const key = conditionKey.trim();
  if (!key) return [];
  if (!coordHasPgFastPath()) {
    const envelopes = await readConditionEnvelopes();
    return envelopes.filter((envelope) => {
      if (envelope["condition_key"] === key || envelope["resolves_condition"] === key) return true;
      const resolvesMany = envelope["resolves_conditions"];
      return Array.isArray(resolvesMany) && resolvesMany.includes(key);
    });
  }

  const sql = coordSql();
  const workspaceId = coordWorkspaceId();
  let shared = conditionReads.get(sql);
  if (!shared) {
    shared = createCache({ maxL1Entries: 1, defaultHardTtlMs: 0 });
    conditionReads.set(sql, shared);
  }
  const cacheKey = `conditions:${key}`;
  try {
    const envelopes = await shared.getOrSet(workspaceId, cacheKey, async () => {
      const sinceBound = new Date(Date.now() - MESSAGE_GC_RETENTION_DAYS * 86_400_000).toISOString();
      const rows = await sql<{ body: unknown }[]>`
        SELECT body
          FROM harness_shared.coord_event_log
         WHERE workspace_id = ${workspaceId}
           AND surface = 'messages'
           AND ts >= ${sinceBound}
           AND (body ? 'condition_key' OR body ? 'resolves_condition' OR body ? 'resolves_conditions')
           AND (body->>'condition_key' = ${key}
                OR body->>'resolves_condition' = ${key}
                OR body->'resolves_conditions' ? ${key})
         ORDER BY id DESC
         LIMIT ${CONDITIONS_FAST_PATH_ROW_CAP}
      `;
      return rows.reverse().map((r) =>
        (typeof r.body === "string" ? JSON.parse(r.body) : r.body) as Record<string, unknown>,
      );
    });
    return envelopes.map((envelope) => ({
      ...envelope,
      ...(Array.isArray(envelope.resolves_conditions)
        ? { resolves_conditions: [...envelope.resolves_conditions] }
        : {}),
    }));
  } finally {
    shared.forget(workspaceId, cacheKey);
  }
}

/**
 * Read every retained lifecycle envelope whose condition identity starts with
 * `conditionKeyPrefix`. The general conditions fold is intentionally capped
 * across all families; this scoped reader pages the matching family so an old,
 * quiet key cannot disappear behind unrelated condition traffic.
 */
export async function readConditionEnvelopesForPrefix(
  conditionKeyPrefix: string,
): Promise<Record<string, unknown>[]> {
  const prefix = conditionKeyPrefix.trim();
  if (!prefix) return [];
  const likePrefix = `${prefix.replace(/[!%_]/g, (character) => `!${character}`)}%`;
  const startsWithPrefix = (value: unknown): value is string =>
    typeof value === "string" && value.startsWith(prefix);

  if (!coordHasPgFastPath()) {
    const envelopes = await readConditionEnvelopes();
    return envelopes.filter((envelope) =>
      startsWithPrefix(envelope["condition_key"]) ||
      startsWithPrefix(envelope["resolves_condition"]) ||
      (Array.isArray(envelope["resolves_conditions"]) && envelope["resolves_conditions"].some(startsWithPrefix)),
    );
  }

  const sql = coordSql();
  const workspaceId = coordWorkspaceId();
  let shared = conditionReads.get(sql);
  if (!shared) {
    shared = createCache({ maxL1Entries: 1, defaultHardTtlMs: 0 });
    conditionReads.set(sql, shared);
  }
  const cacheKey = `conditions:prefix:${prefix}`;
  try {
    const envelopes = await shared.getOrSet(workspaceId, cacheKey, async () => {
      const sinceBound = new Date(Date.now() - MESSAGE_GC_RETENTION_DAYS * 86_400_000).toISOString();
      const all: Record<string, unknown>[] = [];
      let afterId = "0";
      for (;;) {
        const rows = await sql<{ id: string; body: unknown }[]>`
          SELECT id::text AS id, body
            FROM harness_shared.coord_event_log
           WHERE workspace_id = ${workspaceId}
             AND surface = 'messages'
             AND ts >= ${sinceBound}
             AND id > ${afterId}::bigint
             AND (body ? 'condition_key' OR body ? 'resolves_condition' OR body ? 'resolves_conditions')
             AND (
               body->>'condition_key' LIKE ${likePrefix} ESCAPE '!'
               OR body->>'resolves_condition' LIKE ${likePrefix} ESCAPE '!'
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements_text(
                     CASE WHEN jsonb_typeof(body->'resolves_conditions') = 'array'
                       THEN body->'resolves_conditions' ELSE '[]'::jsonb END
                   ) AS resolved(key)
                  WHERE resolved.key LIKE ${likePrefix} ESCAPE '!'
               )
             )
           ORDER BY id ASC
           LIMIT ${CONDITIONS_FAST_PATH_ROW_CAP}
        `;
        if (rows.length === 0) break;
        all.push(...rows.map((row) =>
          (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as Record<string, unknown>,
        ));
        if (rows.length < CONDITIONS_FAST_PATH_ROW_CAP) break;
        afterId = rows[rows.length - 1]!.id;
      }
      return all;
    });
    return envelopes.map((envelope) => ({
      ...envelope,
      ...(Array.isArray(envelope.resolves_conditions)
        ? { resolves_conditions: [...envelope.resolves_conditions] }
        : {}),
    }));
  } finally {
    shared.forget(workspaceId, cacheKey);
  }
}

/**
 * WI-6554700010011878: the NEWEST condition-keyed envelope (alarm OR resolution) that names
 * `conditionKey`, or null when none survives in the retention window or there is no PG fast
 * path. This is the per-emit read `broadcastSevereEvent` uses to enforce the one-shot
 * contract, so it must NOT go through `readConditionEnvelopes`' bounded window: a long-open
 * one-shot key that has fallen out of that window still has to read as open here.
 *
 * One backward seek on the conditions partial index that stops at the first match. Measured
 * 2026-10-14 on 56k condition rows: 0.08ms for a busy open key, 341ms for a key with no row
 * (full partial-index walk). Only first alarms and long-quiet keys pay the slow case.
 */
export async function readLatestConditionEnvelope(
  conditionKey: string,
): Promise<Record<string, unknown> | null> {
  if (!coordHasPgFastPath()) return null;
  const sql = coordSql();
  const workspaceId = coordWorkspaceId();
  const sinceBound = new Date(Date.now() - MESSAGE_GC_RETENTION_DAYS * 86_400_000).toISOString();
  const rows = await sql<{ body: unknown }[]>`
    SELECT body
      FROM harness_shared.coord_event_log
     WHERE workspace_id = ${workspaceId}
       AND surface = 'messages'
       AND ts >= ${sinceBound}
       AND (body ? 'condition_key' OR body ? 'resolves_condition')
       AND (body->>'condition_key' = ${conditionKey}
            OR body->>'resolves_condition' = ${conditionKey}
            OR body->'resolves_conditions' ? ${conditionKey})
     ORDER BY id DESC
     LIMIT 1
  `;
  const body = rows[0]?.body;
  if (body === undefined || body === null) return null;
  return (typeof body === "string" ? JSON.parse(body) : body) as Record<string, unknown>;
}

