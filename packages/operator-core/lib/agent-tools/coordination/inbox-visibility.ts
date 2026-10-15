import { createHash } from 'node:crypto';
import { asSevereEventEmitter, renderSevereEventEmitter } from '../../severe-event-emitter';

/**
 * inbox-visibility.ts — the PURE "is this entry visible in a default coord:inbox
 * read?" predicates. PURE: no I/O, no PG, no tool registration.
 *
 * WHY THIS MODULE EXISTS (unread-count-truthfulness-2026-07-27 P-005, D-006).
 * These three rules used to live inside `tools/inbox.ts`, which is a
 * `defineTool` module. That was fine while `coord:inbox` was their only caller,
 * but the owner-visible unread badge (`deriveCoordState` in `adv-agent-detail.ts`,
 * reached from the sync-resolver read path) must apply the SAME rules — and
 * importing a tool-definition module from a UI read path would drag zod + tool
 * registration into it.
 *
 * They were RELOCATED here rather than copied, exactly as P-002 relocated
 * `pickUnreadCursor` into `coordination/watermarks.ts`. A second definition of
 * "what counts as ambient" would drift from the first, and a counter disagreeing
 * with the reader is the very bug this plan exists to fix. `tools/inbox.ts`
 * re-exports all three, so its public surface (and every existing importer) is
 * unchanged.
 *
 * NOT here, deliberately (D-006): the display `limit`/`boundInboxEntries` cap and
 * the OPT-IN narrowing filters (`from`, `unanswered_only`). Those are paging and
 * caller-supplied narrowing — not "what a default read shows".
 */

/** Ambient system-broadcast categories excluded from the default inbox — they
 *  are high-volume status firehoses (service up/down, rate-limit pauses, and the
 *  per-git-sync doc-freshness RE-VERIFY digest) that bury addressed work. Every
 *  one is broadcast to '*' and actionable to almost no single reader, so on a busy
 *  fleet they drown out directed messages (EI-2826/EI-2871: a doc-drift flood
 *  literally BURIED a peer's "details inside" build-blocker so it was never read).
 *  `doc-drift` earns its place here even though it's individually useful: the
 *  fan-out is to `*`, not to the doc's owner, so for ~every recipient it is pure
 *  noise — the right long-term fix is owner/subscriber targeting (EI-2826 opt c),
 *  but exclude-by-default (opt a) unburies the channel for the whole fleet NOW.
 *  Still `message`s (D-002); opt back in via include_ambient. */
const AMBIENT_CATEGORIES = new Set([
  "service-health",
  "agent-governor",
  "doc-drift",
  // P-009 (fleet-worker-lifecycle-convergence-2026-08-26): these are
  // fleet-wide/status-plane broadcasts, useful in topic/audience history but
  // too noisy for a recipient's default action inbox. The broadcast-only guard
  // below keeps a direct deploy/perf/migration/task-manager message visible.
  "deploy",
  "release-deploy",
  "deployment",
  "perf",
  "performance",
  "migration",
  "task-manager",
  // EI-386: named-resource drain/back-up templates (resource-broadcast.ts) —
  // stamped for classification consistency with the others above. In practice
  // these are always sent to specific holders/waiters, never `to: ['*']`, so
  // isAmbientBroadcast's broadcast-only guard (below) keeps them visible to
  // the recipient who must act; this entry only takes effect if a future
  // caller ever genuinely broadcasts one to '*'.
  "resource-locks",
]);

/** P-005 (fleet-member-dx-improvements-2026-07-10) pure rule: exclude peers'
 *  auto `now working on:` intent-declare messages (lifecycle:'intent') from the
 *  default read — they are presence state re-broadcast to every @plan/@fleet
 *  subscriber, and on a busy fleet they dominate the window and make
 *  `summary.total` meaningless (observed: the bulk of a 2,332-message inbox).
 *  KEPT when the caller opted in (`includeIntents`) OR passed a sender `from`
 *  filter (a sender-scoped read wants that sender's status line). Pure.
 *
 *  Note for the unread badge (D-006): these are NOT broadcasts — they fan out
 *  ADDRESSED to each subscriber, so a recipient-keyed counter counts every one.
 *  Measured 2026-07-27: 506 in 24h, and up to 68% of a single agent's counted
 *  messages over 12h. This is the larger of the two Phase-2 legs, not ambient. */
export function excludeIntentDeclares<T extends Record<string, unknown>>(
  entries: readonly T[],
  opts: { includeIntents?: boolean; from?: string | null },
): { kept: T[]; excluded: number } {
  if (opts.includeIntents || opts.from) return { kept: [...entries], excluded: 0 };
  // Only machine-authored lifecycle projections are presence noise. A directed,
  // contextual message must never disappear merely because a producer reused the
  // `intent` lifecycle label; `auto:true` is the authoritative projection stamp.
  const kept = entries.filter(
    (e) => !(e["lifecycle"] === "intent" && e["auto"] === true),
  );
  return { kept, excluded: entries.length - kept.length };
}

/** Ambient suppression is intentionally broadcast-only. Category labels describe
 * content, not delivery importance; a system or peer may send the same category
 * directly to one agent, and that addressed traffic must remain visible. Mixed
 * `['*', owner]` delivery is also treated as directed. */
export function isAmbientBroadcast(e: Record<string, unknown>): boolean {
  const category = e["category"];
  const recipients = e["to"];
  return (
    typeof category === "string" &&
    AMBIENT_CATEGORIES.has(category) &&
    Array.isArray(recipients) &&
    recipients.length > 0 &&
    recipients.every((recipient) => recipient === "*")
  );
}

/**
 * Is this entry addressed to this specific reader rather than broadcast to everyone?
 *
 * P-001: coord:inbox's directed filter answers "who wrote to ME." Its base read
 * includes entries for this reader and broadcasts, so a mixed recipient list is
 * directed only when it actually names ownerId. For example, ['*', ownerId] is
 * directed to this reader, while ['*', otherOwner] is still only a broadcast here.
 * isAmbientBroadcast answers a different question: whether a categorized system
 * broadcast should be hidden by default.
 *
 * Keep the fail-open for a missing or malformed recipient list: such an entry has
 * already reached this reader's inbox, and silently hiding it would be lossy.
 */
export function isDirectedDelivery(e: Record<string, unknown>, ownerId: string): boolean {
  const recipients = e["to"];
  if (!Array.isArray(recipients) || recipients.length === 0) return true;
  return ownerId.length > 0 && recipients.includes(ownerId);
}

/** EI-6144 ambient/broadcast coalescing: collapse REPEATED categorized system
 *  broadcasts — same sender, kind, category, and summary (modulo embedded
 *  ISO-8601 instants, see VOLATILE_TIMESTAMP_RE), addressed to
 *  '*' — into ONE row (the newest of the group), annotated `repeat_count` +
 *  `first_seen_ts`. Watchdog/status firehoses re-emit the same line for hours;
 *  without this they fill the `limit` window with repetition and crowd distinct
 *  signal out. Only categorized broadcasts coalesce: direct messages (a peer
 *  legitimately saying the same thing twice) and uncategorized rows pass
 *  through untouched. Read-time only — the log keeps every row. Ascending
 *  order is preserved (each group's newest keeps its original position). Pure. */
/** An embedded ISO-8601 instant is pure restatement of ONE condition, so it must
 *  not split a coalescing group. Same class as escalations.ts' VOLATILE_DURATION_RE
 *  (which neutralises `12m` / `3h` in a dedup key, after that bug recurred four
 *  times); this is its timestamp sibling, and it is applied to the KEY ONLY — the
 *  surviving row still displays its own verbatim summary, which is the newest of
 *  the group, so the reader sees the LATEST instant rather than a placeholder.
 *
 *  MEASURED on 24h of live ambient broadcasts (2026-08-03): 4 groups / 111 rows
 *  recovered, every one a rate-limit pause — `bucket "anthropic:haiku" paused
 *  until <ts>` alone was 60 separate rows for a single ongoing condition.
 *
 *  DELIBERATELY NARROW: bare integers are PRESERVED. Blanking all digits instead
 *  would have scored higher (18 groups / 161 rows) by folding together messages
 *  that genuinely differ — `deploy stale: … N commits behind` is a different
 *  signal at 3 commits than at 40, and collapsing those loses information rather
 *  than repetition. A count is signal; an instant is noise. */
const VOLATILE_TIMESTAMP_RE =
  /\d{4}-\d{2}-\d{2}[T ][\d:]{5,8}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

function isSystemNotice(entry: Record<string, unknown>): boolean {
  const to = entry['to'];
  return entry['auto'] === true && entry['kind'] === 'message' && !entry['lifecycle'] &&
    Array.isArray(to) && to.length > 0 && to.every(recipient => recipient === '*') &&
    typeof entry['category'] === 'string' && typeof entry['summary'] === 'string';
}

/** Native delivery only: derive scope from live presence and held claims, never
 * from an alarm's guessed audience. VIEW/feed history keeps the complete rows.
 * A failed scope read passes null and preserves delivery. */
export function relevantSystemNoticeDelivery<T extends Record<string, unknown>>(
  entries: readonly T[],
  scope: { ownerId: string; workItemIds: readonly string[]; planSlug?: string | null;
    files?: readonly string[]; fleetSlug?: string | null } | null,
): { entries: T[]; excluded: number } {
  if (!scope) return { entries: [...entries], excluded: 0 };
  const refs = [scope.ownerId, ...scope.workItemIds, scope.planSlug, scope.fleetSlug,
    ...(scope.files ?? [])].filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);
  const mentions = (text: string, ref: string): boolean => {
    for (let index = text.indexOf(ref); index >= 0; index = text.indexOf(ref, index + 1)) {
      const before = text[index - 1];
      const after = text[index + ref.length];
      if ((!before || !/[\w./-]/.test(before)) && (!after || !/[\w./-]/.test(after))) return true;
    }
    return false;
  };
  const kept = entries.filter(entry => {
    if (!isSystemNotice(entry) || entry['blocking'] === true ||
        ['ack', 'answer', 'action'].includes(String(entry['expects']))) return true;
    // Exclude emitter bookkeeping: its checkout/cwd identifies the producer,
    // not the subject. Preserve both structured references and literal prose.
    const text = JSON.stringify([entry['summary'], entry['body'], entry['sections'],
      entry['condition_key'], entry['resolves_condition'], entry['resolves_conditions'],
      entry['plan_slug'], entry['files'], entry['items'], entry['why']]);
    return refs.some(ref => mentions(text, ref));
  });
  return { entries: kept, excluded: entries.length - kept.length };
}

/** Remember only compact fingerprints on the existing two-phase inbox cursor.
 * Public inbox VIEW reads do not use this filter. Directed/mixed deliveries and
 * peer broadcasts always pass through. Losing state re-delivers, never skips. */
export function changedSystemNoticeDelivery<T extends Record<string, unknown>>(
  entries: readonly T[],
  previous: unknown,
  shownLimit = entries.length,
): { entries: T[]; state: Record<string, string>; suppressed: number } {
  const state: Record<string, string> = {};
  if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
    for (const [key, value] of Object.entries(previous)) {
      if (/^[a-f0-9]{64}$/.test(key) && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) {
        state[key] = value;
      }
    }
  }
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const kept: T[] = [];
  const pending = new Map<T, { key: string; fingerprint: string }>();
  for (const entry of entries) {
    if (!isSystemNotice(entry) || entry['blocking'] === true ||
        ['ack', 'answer', 'action'].includes(String(entry['expects']))) {
      kept.push(entry);
      continue;
    }
    const normalize = (value: unknown): unknown =>
      typeof value === 'string' ? value.replace(VOLATILE_TIMESTAMP_RE, '<ts>') : value;
    const emitter = asSevereEventEmitter(entry['emitter']);
    let body = entry['body'];
    if (emitter && typeof body === 'string') {
      const trailer = renderSevereEventEmitter(emitter);
      if (body.endsWith(trailer)) body = body.slice(0, -trailer.length);
    }
    const condition = entry['condition_key'];
    const key = digest([entry['from'], typeof condition === 'string' && condition
      ? condition : [entry['kind'], entry['category'], normalize(entry['summary'])]]);
    const sectionText = body === undefined && Array.isArray(entry['sections'])
      ? entry['sections'].map((section) => section && typeof section === 'object'
        ? normalize((section as Record<string, unknown>)['text']) : null) : null;
    const fingerprint = digest([entry['kind'], entry['category'], normalize(entry['summary']),
      normalize(body), sectionText, entry['resolved'] === true, emitter?.pid, emitter?.startedAt]);
    if (state[key] !== fingerprint) kept.push(entry);
    pending.set(entry, { key, fingerprint });
  }
  // Native injection renders the newest bounded rows. Never remember a notice
  // that its overflow omitted. Machine messages have no intent/digest collapse.
  const shown = shownLimit > 0
    ? [...kept].sort((a, b) => String(a['ts']).localeCompare(String(b['ts']))).slice(-shownLimit)
    : [];
  for (const entry of shown) {
    const notice = pending.get(entry);
    if (!notice) continue;
    const { key, fingerprint } = notice;
    delete state[key];
    state[key] = fingerprint;
  }
  const keys = Object.keys(state);
  for (const key of keys.slice(0, Math.max(0, keys.length - 256))) delete state[key];
  return { entries: kept, state, suppressed: entries.length - kept.length };
}

export function coalesceRepeatedBroadcasts<T extends Record<string, unknown>>(
  entries: readonly T[],
): Array<Record<string, unknown>> {
  type Group = { lastIdx: number; count: number; firstTs: string };
  const groups = new Map<string, Group>();
  const keyOf = (e: Record<string, unknown>): string | null => {
    const category = e["category"];
    const summary = e["summary"];
    const to = e["to"];
    if (typeof category !== "string" || !category) return null;
    if (typeof summary !== "string" || !summary) return null;
    if (!Array.isArray(to) || !to.includes("*")) return null;
    const summaryKey = summary.replace(VOLATILE_TIMESTAMP_RE, "<ts>");
    return `${String(e["from"] ?? "")}\x00${String(e["kind"] ?? "")}\x00${category}\x00${summaryKey}`;
  };
  entries.forEach((e, i) => {
    const key = keyOf(e);
    if (key === null) return;
    const ts = typeof e["ts"] === "string" ? (e["ts"] as string) : "";
    const g = groups.get(key);
    if (!g) groups.set(key, { lastIdx: i, count: 1, firstTs: ts });
    else {
      g.count += 1;
      g.lastIdx = i; // entries are ascending — the latest index is the newest
      if (ts && (!g.firstTs || ts < g.firstTs)) g.firstTs = ts;
    }
  });
  if (![...groups.values()].some((g) => g.count > 1))
    return entries as unknown as Array<Record<string, unknown>>;
  const out: Array<Record<string, unknown>> = [];
  entries.forEach((e, i) => {
    const key = keyOf(e);
    if (key === null) {
      out.push(e);
      return;
    }
    const g = groups.get(key)!;
    if (i !== g.lastIdx) return; // an older duplicate — folded into the newest
    out.push(
      g.count > 1 ? { ...e, repeat_count: g.count, first_seen_ts: g.firstTs } : e,
    );
  });
  return out;
}

const ACTION_EXPECTS = new Set(["action", "answer"]);
const SECONDARY_LIFECYCLES = new Set(["claim", "dependency", "handoff"]);
const SECONDARY_CATEGORIES = new Set(["claim", "dependency", "work-item-claim"]);

function hasFleetAudience(e: Record<string, unknown>): boolean {
  const audience = e["audience"];
  const to = e["to"];
  const hasFleet = (v: unknown) => typeof v === "string" && v.startsWith("@fleet:");
  if (hasFleet(audience)) return true;
  if (Array.isArray(audience) && audience.some(hasFleet)) return true;
  return Array.isArray(to) && to.some(hasFleet);
}

/** P-009 priority bucket for a default inbox read. Lower is more urgent.
 *
 * Bucket 0: directed actionable asks (`expects:'action'|'answer'`, including
 * the legacy `expectsReply:true` stamp).
 * Bucket 1: claim/dependency/handoff/same-fleet traffic — useful coordination
 * state, but below explicit asks.
 * Bucket 2: everything else.
 *
 * Pure/read-time only: coord_event_log history remains append-only and feed /
 * catch-up readers can still use their own ordering. */
export function inboxPriorityBucket(e: Record<string, unknown>): number {
  const expects = e["expects"];
  if ((typeof expects === "string" && ACTION_EXPECTS.has(expects)) || e["expectsReply"] === true) {
    return 0;
  }
  const lifecycle = e["lifecycle"];
  const category = e["category"];
  if (
    (typeof lifecycle === "string" && SECONDARY_LIFECYCLES.has(lifecycle)) ||
    (typeof category === "string" && SECONDARY_CATEGORIES.has(category)) ||
    hasFleetAudience(e)
  ) {
    return 1;
  }
  return 2;
}

interface InboxChunkPart {
  group: string;
  part: number;
  of: number;
}

const CHUNK_HEADER_RE = /^⟦part (\d+)\/(\d+) g:([0-9a-f]{8})( cont)?⟧$/;
const CHUNK_SUMMARY_RE = /\(part (\d+)\/(\d+)\)$/;

/**
 * Read the chunker-owned header + summary suffix. Requiring both keeps an
 * ordinary message that merely starts with marker-like prose out of the group
 * path. These fields are already present on every persisted coord:send chunk.
 */
function inboxChunkPart(e: Record<string, unknown>): InboxChunkPart | null {
  const body = e['body'];
  if (typeof body !== 'string') return null;
  const header = CHUNK_HEADER_RE.exec(body.split(/\r?\n/, 1)[0] ?? '');
  const summary = typeof e['summary'] === 'string' ? CHUNK_SUMMARY_RE.exec(e['summary']) : null;
  if (!header || !summary) return null;
  const part = Number(header[1]);
  const of = Number(header[2]);
  if (
    part !== Number(summary[1]) ||
    of !== Number(summary[2]) ||
    of < 2 ||
    part < 1 ||
    part > of
  ) {
    return null;
  }
  return { group: header[3]!, part, of };
}

function inboxChunkGroupKey(e: Record<string, unknown>, chunk: InboxChunkPart): string | null {
  const from = e['from'];
  const to = e['to'];
  if (typeof from !== 'string' || from.length === 0 || !Array.isArray(to)) return null;
  const recipients = to.map((recipient) => String(recipient)).sort();
  return JSON.stringify([from, recipients, e['harness_slug'] ?? null, chunk.group, chunk.of]);
}

/**
 * Expand a message-id selection to include every available part of any matching
 * chunked message. A coord:send chunk is one logical message even though only
 * its final part can carry `expects:'answer'`; filtering on that part's msg_id
 * alone would make the window selector see an incomplete group and suppress the
 * whole answer. Keep this expansion beside the chunk parser so filter callers
 * use the same grouping identity as {@link prioritizedInboxWindow}.
 */
export function expandInboxChunkGroupsForMessageIds<T extends Record<string, unknown>>(
  entries: readonly T[],
  messageIds: ReadonlySet<string>,
): T[] {
  if (messageIds.size === 0 || entries.length === 0) return [];

  const matchingIds = new Set<string>();
  const matchingGroups = new Set<string>();
  for (const entry of entries) {
    const msgId = entry['msg_id'];
    if (typeof msgId !== 'string' || !messageIds.has(msgId)) continue;
    matchingIds.add(msgId);
    const chunk = inboxChunkPart(entry);
    if (chunk) {
      const key = inboxChunkGroupKey(entry, chunk);
      if (key !== null) matchingGroups.add(key);
    }
  }

  return entries.filter((entry) => {
    const msgId = entry['msg_id'];
    if (typeof msgId === 'string' && matchingIds.has(msgId)) return true;
    const chunk = inboxChunkPart(entry);
    if (!chunk) return false;
    const key = inboxChunkGroupKey(entry, chunk);
    return key !== null && matchingGroups.has(key);
  });
}

/** Select + order the visible inbox window by P-009 priority before applying
 * the caller's display limit. Rows within a bucket are newest-first so a flood
 * of low-priority broadcasts cannot crowd an older actionable ask out of a
 * bounded default read. A chunked coord:send is one logical message even though
 * only its final row carries `expects`; select a complete group together or do
 * not show any part. Otherwise the final actionable part can survive the limit
 * while the continuation holding the first half of its instructions disappears. */
export function prioritizedInboxWindow<T extends Record<string, unknown>>(
  entries: readonly T[],
  limit: number,
): T[] {
  if (limit <= 0) return [];
  type RankedUnit = { entries: T[]; bucket: number; ts: string; msgId: string };
  type ChunkGroup = {
    of: number;
    entries: Array<{ entry: T; part: number }>;
    parts: Set<number>;
    invalid: boolean;
  };

  const units: RankedUnit[] = [];
  const chunkGroups = new Map<string, ChunkGroup>();
  for (const entry of entries) {
    const chunk = inboxChunkPart(entry);
    const key = chunk ? inboxChunkGroupKey(entry, chunk) : null;
    if (!chunk || key === null) {
      units.push({
        entries: [entry],
        bucket: inboxPriorityBucket(entry),
        ts: String(entry['ts'] ?? ''),
        msgId: String(entry['msg_id'] ?? ''),
      });
      continue;
    }
    const group = chunkGroups.get(key) ?? {
      of: chunk.of,
      entries: [],
      parts: new Set<number>(),
      invalid: false,
    };
    if (group.of !== chunk.of) group.invalid = true;
    group.entries.push({ entry, part: chunk.part });
    group.parts.add(chunk.part);
    chunkGroups.set(key, group);
  }

  for (const group of chunkGroups.values()) {
    const complete = !group.invalid && Array.from({ length: group.of }, (_, index) => index + 1)
      .every((part) => group.parts.has(part));
    if (!complete) continue;

    const chunkEntries = group.entries
      .sort((a, b) => {
        if (a.part !== b.part) return a.part - b.part;
        const ats = String(a.entry['ts'] ?? '');
        const bts = String(b.entry['ts'] ?? '');
        if (ats !== bts) return ats.localeCompare(bts);
        return String(a.entry['msg_id'] ?? '').localeCompare(String(b.entry['msg_id'] ?? ''));
      })
      .map(({ entry }) => entry);
    const newest = chunkEntries.reduce((best, entry) =>
      String(entry['ts'] ?? '') > String(best['ts'] ?? '') ? entry : best,
    );
    units.push({
      entries: chunkEntries,
      bucket: Math.min(...chunkEntries.map(inboxPriorityBucket)),
      ts: String(newest['ts'] ?? ''),
      msgId: String(newest['msg_id'] ?? ''),
    });
  }

  units.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket;
    if (a.ts !== b.ts) return b.ts.localeCompare(a.ts);
    return b.msgId.localeCompare(a.msgId);
  });

  const selected: T[] = [];
  for (const unit of units) {
    if (selected.length + unit.entries.length > limit) continue;
    selected.push(...unit.entries);
  }
  return selected;
}
