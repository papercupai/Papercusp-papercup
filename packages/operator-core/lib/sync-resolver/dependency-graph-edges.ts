/**
 * dependency-graph-edges.ts — the EDGE half of the Work-tab dependency graph pane.
 *
 * Plan: dependency-health-pane-2026-08-02 (P-003, the data seam).
 *
 * ── WHY THIS IS EDGES ONLY (AND WHY EACH EDGE CARRIES ITS ENDPOINTS) ────────────────────
 * The owner's ask was a pane that "shows all the same data as our work items list view but in
 * graph form". Taken literally, that means the graph's NODES are the list's rows — so this
 * module deliberately does NOT re-query work items as a second corpus. The pane reuses the
 * existing `workItems.byHarness` sync query for the rich row fields and adds only the edges
 * the list has no column for. Two things follow, and both are the point:
 *
 *   • ONE node corpus. A second independent node query would drift from the list's (different
 *     limit, different filters, different projection) and the two panes would disagree about
 *     what exists — the precise failure the "same data" phrasing rules out.
 *   • The same trick DetailPanel already uses: it reads the selected row out of the
 *     already-loaded `workItems.byHarness` result rather than firing its own fetch, because
 *     a second multi-MB fetch starves the WebView2 ~6-connection-per-host cap and shows up
 *     as a pane stuck on "Loading".
 *
 * ⚠ BUT "edges only" MUST NOT MEAN "edges whose endpoints happen to be in the list's page"
 * (WI-36045). `workItems.byHarness` is a WINDOW — 500 rows ordered `updated_ts DESC` — while
 * this query is HARNESS-WIDE. Those are different scopes, and pairing them silently discarded
 * almost the entire graph: measured 2026-08-08 on `papercusp` (47,906 items), 79 edges
 * resolved but only **1** had BOTH endpoints inside the 500-row window, so the pane rendered
 * 2 nodes out of a real 122 and looked like honest sparse data.
 *
 * The fix is NOT a second node query (that reintroduces the drift above) and NOT a bigger
 * window (47,906 enriched rows is exactly the multi-MB fetch the cap forbids). It is to make
 * each edge row SELF-SUFFICIENT: the joins below already touch both endpoint rows, so they
 * now also project the four fields a graph NODE needs (title, status, kind, plan provenance).
 * The graph can therefore always draw an edge it was told about, whether or not that endpoint
 * fell inside the list's window — while the values still come from the same `work_items` rows
 * the list reads, so "one corpus" is strengthened rather than weakened. The list's page stays
 * the source of the RICHER row fields and of filter composition; these fields are the floor
 * that guarantees no edge is silently undrawable.
 *
 * ── ENDPOINT RESOLUTION IS FAMILY-AWARE, AND THAT IS THE WHOLE SUBTLETY ─────────────────
 * `work_item_deps` stores each endpoint as a `*_ref` whose FORM depends on the family of the
 * row it points at (D-009 rule 1, and the invariant registry's INV-01):
 *
 *     feature family → '<harness>#<feature_id>'   (harness-qualified)
 *     issue   family → '<feature_id>'             (bare, unqualified)
 *
 * so a join that matches only one form silently drops every edge of the other family. That is
 * not hypothetical: it is exactly the D-017 defect — six live edges that were form-valid,
 * mirrored and acyclic, and gated nothing, because the writer emitted the feature convention
 * while the issue floor matched bare. The join below therefore dispatches on the TARGET ROW'S
 * `item_kind`, mirroring `work_item_is_blocked` (migration 719) rather than re-deciding the
 * convention here.
 *
 * ⚠ `d.workspace_id` is pinned to the COORDINATION workspace ('default'), NOT the caller's
 * workspace. Every edge row lives there by design whatever workspace its items live in
 * (migration 719 says so explicitly and warns against "fixing" it: scoping the edge lookup to
 * the item workspace "would match zero rows and disable blocking entirely"). The ITEM joins
 * are scoped to the caller's workspace; the EDGE table is not. Those are different axes.
 *
 * ── DANGLING EDGES ARE RETURNED, NOT FILTERED ──────────────────────────────────────────
 * The blocker side is a LEFT JOIN on purpose. An edge whose blocker resolves to no row in this
 * harness is a FINDING (INV-13, the stale class) and Phase 3's integrity mode has to render
 * it; an INNER JOIN would make exactly the broken edges invisible in the pane built to show
 * broken edges. `blockerId === null` is how the UI spots one.
 */
import type { Sql } from 'postgres';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import { createEventKeyParser, eventKeySubjectItemId } from '../events/await/catalog';
import { EXPLICIT_PARK_NOTE_MARKER } from '../events/await/types';
import {
  activeExternalBlockers,
  type ExternalBlockerCapability,
  type ExternalBlockerKind,
} from '../external-blockers';
import {
  uncertifiedConditionReason,
  type UncertifiedConditionReason,
} from '../external-condition-reachability';

import { ISSUE_FAMILY_ROUTE_KINDS } from '../work-nature/agent-work-predicate';
/** The coordination workspace `work_item_deps` is keyed in. NOT a tenant knob — see header. */
const COORD_WORKSPACE = 'default';

/** Families, as the ENGINE decides them: by the VALUE of item_kind, never by a family name. */
const ISSUE_KINDS = ISSUE_FAMILY_ROUTE_KINDS;

export interface DependencyGraphEdge {
  /** feature_id of the BLOCKED item (the dependant). Always resolves — it is an inner join. */
  blockedId: string;
  /** feature_id of the BLOCKER, or null when the ref resolves to no row here (INV-13). */
  blockerId: string | null;
  /** The blocker's raw ref as stored — the only handle a dangling edge has. */
  blockerRef: string;
  blockedKind: string;
  blockerKind: string | null;
  /** Blocker lifecycle status — lets the UI grey out an edge whose blocker is already terminal. */
  blockerStatus: string | null;
  satisfaction: 'settled' | 'success';

  // ── ENDPOINT HYDRATION (WI-36045) ──────────────────────────────────────────────────────
  // The minimum a graph NODE needs, carried on the edge so an endpoint outside the list's
  // 500-row window is still drawable. See the header: without these, 78 of 79 papercusp
  // edges were fetched and then discarded client-side. Nullable on the blocker side only,
  // where the LEFT JOIN may not resolve (a dangling edge has no row to project).
  /** The BLOCKED row's title. */
  blockedTitle: string | null;
  /** The BLOCKED row's lifecycle status. Its own status, not the blocker's. */
  blockedStatus: string | null;
  /** The BLOCKED row's originating plan, or null if it did not come from one. */
  blockedPlanSlug: string | null;
  /** The BLOCKER row's title, or null when the ref resolves to no row (dangling). */
  blockerTitle: string | null;
  /** The BLOCKER row's originating plan, or null (no row, or no plan). */
  blockerPlanSlug: string | null;
  blockedPlanItemId: string | null;
  blockerPlanItemId: string | null;
  blockedPhase: string | null;
  blockerPhase: string | null;
  blockedPlanBlockedBy: string[];
}

/** Bound the payload. The pane renders a filtered subgraph (D-003), never the whole corpus. */
export const DEP_EDGES_MAX_LIMIT = 5000;

/**
 * Every `blocks` edge with at least its BLOCKED endpoint resolving into (workspace, harness).
 *
 * @param sql org admin postgres handle.
 * @param opts workspaceId + harnessSlug scope the ITEM joins (never the edge table); `limit` is
 *   CLAMPED, never rejected — a client asking for more than the cap must degrade gracefully
 *   rather than error the panel (the same reason `workItems.byHarness` clamps instead of
 *   `.max()`-ing its schema: a newer client against an older resolver would otherwise turn a
 *   version skew into a panel-breaking failure).
 */
export async function resolveDependencyGraphEdges(
  sql: Sql,
  opts: { workspaceId: string; harnessSlug: string; limit?: number },
): Promise<DependencyGraphEdge[]> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEP_EDGES_MAX_LIMIT)), DEP_EDGES_MAX_LIMIT);
  const qualifiedPrefix = `${opts.harnessSlug}#`;
  const rows = await sql<
    Array<{
      blocked_id: string;
      blocker_id: string | null;
      blocker_ref: string;
      blocked_kind: string;
      blocker_kind: string | null;
      blocker_status: string | null;
      satisfaction: 'settled' | 'success';
      blocked_title: string | null;
      blocked_status: string | null;
      blocked_plan_slug: string | null;
      blocker_title: string | null;
      blocker_plan_slug: string | null;
      blocked_plan_item_id: string | null;
      blocker_plan_item_id: string | null;
      blocked_phase: string | null;
      blocker_phase: string | null;
      blocked_plan_blocked_by: string[] | null;
    }>
  >`
    SELECT bd.feature_id  AS blocked_id,
           bk.feature_id  AS blocker_id,
           d.blocker_ref  AS blocker_ref,
           bd.item_kind   AS blocked_kind,
           bk.item_kind   AS blocker_kind,
           bk.status      AS blocker_status,
           d.satisfaction AS satisfaction,
           -- Endpoint hydration (WI-36045). Free: both rows are already joined below, so
           -- this adds columns to an existing scan rather than a second query.
           bd.title            AS blocked_title,
           bd.status           AS blocked_status,
           bd.source_plan_slug AS blocked_plan_slug,
           bk.title            AS blocker_title,
           bk.source_plan_slug AS blocker_plan_slug,
           bpi.item_id         AS blocked_plan_item_id,
           kpi.item_id         AS blocker_plan_item_id,
           bpi.phase           AS blocked_phase,
           kpi.phase           AS blocker_phase,
           bpi.blocked_by      AS blocked_plan_blocked_by
      FROM harness_shared.work_item_deps d
      -- BLOCKED side: inner. An edge whose dependant is not in this harness is not ours.
      JOIN harness_shared.work_items bd
        ON bd.workspace_id = ${opts.workspaceId}
       AND bd.harness_slug = ${opts.harnessSlug}
       -- Give Postgres an equality on the indexed endpoint identity BEFORE the
       -- family-aware exact-ref check below. Without this anchor the blocker-side
       -- LEFT JOIN becomes a join filter: for every edge Postgres materializes and
       -- scans the harness's entire work-item corpus (114k rows in papercusp), which
       -- exceeded the named-query resolver's 10s deadline and left the pane loading.
       --
       -- This is only a candidate-id extraction, not a second ref convention. The
       -- predicate below remains authoritative and rejects a bare feature ref or a
       -- qualified issue ref exactly as before.
       AND bd.feature_id = CASE
         WHEN starts_with(d.blocked_ref, ${qualifiedPrefix})
           THEN substr(d.blocked_ref, char_length(${qualifiedPrefix}) + 1)
         ELSE d.blocked_ref
       END
       AND (
         (bd.item_kind = ANY (${ISSUE_KINDS as unknown as string[]}) AND d.blocked_ref = bd.feature_id)
         OR
         (bd.item_kind <> ALL (${ISSUE_KINDS as unknown as string[]})
           AND d.blocked_ref = bd.harness_slug || '#' || bd.feature_id)
       )
      -- BLOCKER side: LEFT. A blocker resolving to nothing is a dangling edge — a finding the
      -- integrity mode must render, not a row to drop (see header).
      LEFT JOIN harness_shared.work_items bk
        ON bk.workspace_id = ${opts.workspaceId}
       AND bk.harness_slug = ${opts.harnessSlug}
       AND bk.feature_id = CASE
         WHEN starts_with(d.blocker_ref, ${qualifiedPrefix})
           THEN substr(d.blocker_ref, char_length(${qualifiedPrefix}) + 1)
         ELSE d.blocker_ref
       END
       AND (
         (bk.item_kind = ANY (${ISSUE_KINDS as unknown as string[]}) AND d.blocker_ref = bk.feature_id)
         OR
         (bk.item_kind <> ALL (${ISSUE_KINDS as unknown as string[]})
           AND d.blocker_ref = bk.harness_slug || '#' || bk.feature_id)
       )
      LEFT JOIN LATERAL (
        SELECT pi.item_id, pi.phase, pi.blocked_by
          FROM harness_shared.plan_items pi
         WHERE pi.workspace_id = bd.workspace_id
           AND pi.harness_slug = bd.harness_slug
           AND pi.plan_slug = bd.source_plan_slug
           AND pi.item_id = COALESCE(bd.source_plan_item_ids[1], bd.payload -> 'plan_item' ->> 'item_id')
         LIMIT 1
      ) bpi ON true
      LEFT JOIN LATERAL (
        SELECT pi.item_id, pi.phase
          FROM harness_shared.plan_items pi
         WHERE pi.workspace_id = bk.workspace_id
           AND pi.harness_slug = bk.harness_slug
           AND pi.plan_slug = bk.source_plan_slug
           AND pi.item_id = COALESCE(bk.source_plan_item_ids[1], bk.payload -> 'plan_item' ->> 'item_id')
         LIMIT 1
      ) kpi ON true
     WHERE d.dep_type = 'blocks'
       AND d.workspace_id = ${COORD_WORKSPACE}
     ORDER BY bd.feature_id, d.blocker_ref
     LIMIT ${limit}`;

  return rows.map((r) => ({
    blockedId: r.blocked_id,
    blockerId: r.blocker_id,
    blockerRef: r.blocker_ref,
    blockedKind: r.blocked_kind,
    blockerKind: r.blocker_kind,
    blockerStatus: r.blocker_status,
    satisfaction: r.satisfaction,
    blockedTitle: r.blocked_title,
    blockedStatus: r.blocked_status,
    blockedPlanSlug: r.blocked_plan_slug,
    blockerTitle: r.blocker_title,
    blockerPlanSlug: r.blocker_plan_slug,
    blockedPlanItemId: r.blocked_plan_item_id,
    blockerPlanItemId: r.blocker_plan_item_id,
    blockedPhase: r.blocked_phase,
    blockerPhase: r.blocker_phase,
    blockedPlanBlockedBy: r.blocked_plan_blocked_by ?? [],
  }));
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// THE WAIT LEG — event waits on items (event-wait-settlement-2026-10-20 P-009, D-003).
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// The owner asked for agents' waits on the items they hold to appear in the dependency graph
// (directive #2038). A `blocks` edge is item → item; a wait is item → EVENT, so it needs its
// own rows. Two families, both read live:
//
//   • 'session-await' — an active `events:await` registration (`event_awaits`):
//       – BOUND to the item (`bound_to.kind` work-item-claim | work-item-blocked, ref = the
//         item id), whoever the subscriber is — a contender parked on `claim:released:<id>`
//         is as much a wait on the item as its holder's own park;
//       – and the HOLDER's other non-inbox-wake awaits (the "why is this held item not
//         moving? its holder is parked on X" answer), capped per holder.
//     Exclusions are derive-awaiting.ts's Leg 1 verbatim: the standing
//     `coord:inbox-wake:<owner>` subscription is plumbing every live agent holds, unless it
//     carries an explicit park note; `policy='announce'` rows are gate DECLARATIONS, not waits.
//   • 'item-blocker' — the item's OWN active `event`/`gate` external blocker
//     (`work_items:set_blocker`).
//   • 'item-park' — the item's DURABLE PARK (`work_items:release { claimHold, claimHoldRelease }`).
//     A park keeps its wait only in `payload.claim_hold_release.trigger` and writes no
//     externalBlockers row, so without this family a parked item showed no wait at all
//     (WI-6554700010030343, blind review #110 G-1). Same population as the park audit and
//     attention/durable-park-recheck.ts: `_claimHold` true with a string trigger. A held-open
//     lease alone carries no contract and is not a wait. Each row names who parked it and the
//     re-check date an unprovable trigger is given (WI-6554700010030346).
//   • 'item-condition' — the item's OWN active `runtime` or `human` external blocker
//     (WI-6554700010030344, blind review #110 G-2). No event proves these: they are what
//     wait-ref admission redirects a refused wait into (WAIT_REF_OPTIONS option 4), so leaving
//     them out drew every refused wait as no wait at all. `eventKey` carries the blocker's
//     REF, which is not an event key: `certification` is 'not-an-event' and the row is never
//     looked up as an announced key. Its capability and re-check date travel with it.
//
// Each row carries the item's node fields (title/status/kind/plan), for the same reason the
// edge rows do (WI-36045): the item may sit outside the list's 500-row window.
//
// ⚠ This is a SIBLING read, not more rows on `resolveDependencyGraphEdges`: that query's
// contract is "every row is a `blocks` edge", and its consumers (integrity findings) must not
// start seeing event endpoints. The model counts an item's OWN waits (blocker, park,
// condition) toward depth and the critical path, never a session await, and keeps every wait
// out of the integrity findings (dep-graph-model.ts; event-wait-settlement-2026-10-20#D-015).
//
// LIVENESS. A wait whose subscriber session has ENDED is not a wait anyone is keeping alive:
// it is marked `stale` (R-16). The verdict comes from the ONE shared liveness oracle
// (`resolveSessionStates`), never a local re-derivation. `subscriberState: null` means NOT
// MEASURED (oracle unknown, failed, or timed out) — never "alive".
//
// CERTIFICATION. `certification` is `uncertifiedConditionReason`'s answer: 'proving' when one
// fire of the key establishes the condition (P-001's `fireCertifiesCondition`), otherwise why
// not ('broad' | 'change-notification' | 'uncatalogued'). An announced key is producer-declared.
//
// COST (R-19, measured 2026-10-21 on papercusp, 217,649 non-terminal items): blocker leg 31 ms
// on work_items_external_blockers_gin_idx (migration 1539); holder leg 46 ms on
// hfc_taken_by_idx + idx_event_awaits_subscriber; bound leg on event_awaits_bound_to_active.
// Park leg (measured 2026-10-27, 895 live parks): 58 ms on work_items_claim_hold_release_trigger_idx,
// which is why its WHERE repeats that partial index's `payload ? 'claim_hold_release'`.
// Condition leg (measured 2026-10-27: 1,465 items carrying 1,489 active runtime/human rows):
// 67 ms, a BitmapOr of two `@>` probes on work_items_external_blockers_gin_idx. The blocker,
// park and condition legs share ONE statement (a UNION ALL of three independently capped
// branches), so a call is still four SQL statements regardless of corpus size, plus the
// liveness batch.

/** The `bound_to.kind` values that bind an await to a work item by id. */
export const ITEM_BOUND_AWAIT_KINDS = ['work-item-claim', 'work-item-blocked'] as const;

/** Statuses after which an item's own blockers and holder waits stop mattering. */
const WAIT_LEG_TERMINAL = ['done', 'resolved', 'closed', 'dropped', 'deprecated', 'passed'] as const;

/**
 * Per-leg row caps. A leg that hits its cap stamps `legTruncated` on its rows (never silent).
 * The holder leg is the one that fans out — every holder await repeats on every item that
 * holder holds — so it gets the tightest cap. MEASURED 2026-10-21 on papercusp at a 1,500 cap:
 * 2,351 rows, 1.6 MB, the holder leg truncated, and 1,185 of the rows stale (sessions that
 * ended while holding items). Ordered by the item's recency, so the cap drops the least
 * recently touched holds first.
 */
export const DEP_WAITS_LIMITS = { bound: 1000, holder: 600, blocker: 2000, park: 2000, condition: 2000 } as const;

/** The blocker kinds no event can prove — the 'item-condition' leg. */
export const CONDITION_BLOCKER_KINDS = ['runtime', 'human'] as const satisfies readonly ExternalBlockerKind[];
export type ConditionBlockerKind = (typeof CONDITION_BLOCKER_KINDS)[number];
const isConditionBlockerKind = (kind: ExternalBlockerKind): kind is ConditionBlockerKind =>
  (CONDITION_BLOCKER_KINDS as readonly ExternalBlockerKind[]).includes(kind);
/** The holder's other awaits shown per held item — the most recent first. */
export const DEP_WAITS_PER_HOLDER = 3;
/** The liveness oracle gets this long before every subscriber reads as not measured. */
export const DEP_WAITS_LIVENESS_TIMEOUT_MS = 3000;

/**
 * 'proving' when one fire of the key proves the condition; otherwise why not. 'not-an-event'
 * is the 'item-condition' answer: the wait names a runtime or human condition, not a key, so
 * no fire can prove it and only its re-check date revisits it.
 */
export type DependencyGraphWaitCertification = 'proving' | UncertifiedConditionReason | 'not-an-event';

export interface DependencyGraphWait {
  /** feature_id of the item the wait is on. */
  itemId: string;
  itemKind: string;
  itemTitle: string | null;
  itemStatus: string | null;
  itemPlanSlug: string | null;
  /** The item's current holder (`taken_by`), or null when unclaimed. */
  holderId: string | null;
  waitKind: 'session-await' | 'item-blocker' | 'item-park' | 'item-condition';
  /**
   * What is waited on. An event key for an await, an event/gate blocker (its ref) and a park
   * (its release trigger). For 'item-condition' it is the runtime/human blocker's REF, which
   * is NOT an event key — `certification` is then 'not-an-event'.
   */
  eventKey: string;
  /**
   * The work item `eventKey` is ABOUT, when the key's catalog family carries one
   * (`claim:released:<id>`, `work-item:done:<id>`) — read from the key through the catalog's
   * own templates, never a hand-kept list. The graph draws it as a provenance link from that
   * item to the event node (WI-6554700010030578). Null for 'item-condition' (its ref is not an
   * event key), for an uncatalogued key, and for a key that names no work item.
   */
  subjectItemId: string | null;
  /** 'session-await' only: the `event_awaits` row id. */
  awaitId: string | null;
  /** 'item-blocker' ('event' | 'gate') and 'item-condition' ('runtime' | 'human'): the blocker's kind. */
  blockerKind: ExternalBlockerKind | null;
  /** 'item-condition' only: the capability that clears the condition (e.g. 'credential'). */
  capability: ExternalBlockerCapability | null;
  /** 'session-await' only: true when `bound_to` names THIS item. */
  bound: boolean;
  /** 'session-await' only: the `bound_to.kind`, when bound. */
  boundKind: string | null;
  /** 'session-await' only: who registered the await. */
  subscriberId: string | null;
  /** 'session-await' only: the subscriber currently holds the item. */
  subscriberIsHolder: boolean;
  /** ISO — when the await / blocker was registered, or the item was parked. */
  since: string | null;
  /** 'item-park' only: who parked the item (`claim_hold_by`). */
  parkedBy: string | null;
  /**
   * 'item-park': ISO `claim_hold_release.recheckAt` — set when no fire can prove the trigger,
   * so the park is escalated for review on that date (WI-6554700010030346).
   * 'item-condition': the blocker's own `recheckAt`, when the re-check sweep revisits it.
   */
  recheckAt: string | null;
  /** Whether one fire of the key proves the condition, or why not. */
  certification: DependencyGraphWaitCertification;
  /** A producer declared (announced) this key. Always false for 'item-condition'. */
  announced: boolean;
  /** Who declared the key: the most recent live announcement's owner, or null when none. */
  announcedBy: string | null;
  /** 'session-await' only: the oracle's verdict for the subscriber; null = not measured. */
  subscriberState: SessionState | null;
  /** The wait is dead: its subscriber session ended, or the await expired unfired. */
  stale: boolean;
  staleReason: 'subscriber-ended' | 'await-expired' | null;
  /** This row's leg hit its cap — more waits exist than were returned. */
  legTruncated: boolean;
}

export interface DependencyGraphWaitDeps {
  /** Batched session verdicts; a missing key reads as not measured. */
  resolveSessionStates?: (ownerIds: readonly string[]) => Promise<Map<string, SessionState | null>>;
  livenessTimeoutMs?: number;
}

/** Session states that mean nobody is keeping the wait alive. */
const DEAD_SESSION_STATES: ReadonlySet<SessionState> = new Set<SessionState>(['ended', 'suspect']);

async function oracleSessionStates(ownerIds: readonly string[]): Promise<Map<string, SessionState | null>> {
  const { resolveSessionStates } = await import('../agent-tools/coordination/liveness-oracle');
  const verdicts = await resolveSessionStates(
    ownerIds.map((ownerId) => ({ ownerId })),
    { hydrateBatch: true },
  );
  return new Map([...verdicts.values()].map((v) => [v.ownerId, v.sessionState]));
}

/** Fail-soft and bounded: a liveness failure or overrun yields "not measured", never a throw. */
async function boundedSessionStates(
  ownerIds: readonly string[],
  deps: DependencyGraphWaitDeps,
): Promise<Map<string, SessionState | null>> {
  if (ownerIds.length === 0) return new Map();
  const resolve = deps.resolveSessionStates ?? oracleSessionStates;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolve(ownerIds),
      new Promise<Map<string, SessionState | null>>((ok) => {
        timer = setTimeout(() => ok(new Map()), deps.livenessTimeoutMs ?? DEP_WAITS_LIVENESS_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return new Map();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isoOrNull(v: Date | string | null | undefined): string | null {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

type WaitItemRow = {
  feature_id: string;
  item_kind: string;
  title: string | null;
  status: string | null;
  source_plan_slug: string | null;
  taken_by: string | null;
};
type AwaitRow = WaitItemRow & {
  await_id: string | number;
  subscriber_id: string;
  event_key: string;
  created_at: Date | string;
  expires_ts: Date | string | null;
  bound_kind: string | null;
  bound_ref: string | null;
};
/** One row of the combined blocker/park/condition statement; an unused branch's columns are NULL. */
type ItemLegRow = WaitItemRow & {
  leg: 'blocker' | 'park' | 'condition';
  blockers: unknown;
  park_trigger: string | null;
  park_recheck_at: string | null;
  parked_by: string | null;
  parked_at: string | null;
};

/**
 * Every live wait on an item in (workspace, harness): session awaits bound to it, its holder's
 * other awaits, its own active event/gate blockers, its durable park, and its own active
 * runtime/human blockers. See the section header.
 */
export async function resolveDependencyGraphWaits(
  sql: Sql,
  opts: { workspaceId: string; harnessSlug: string },
  deps: DependencyGraphWaitDeps = {},
): Promise<DependencyGraphWait[]> {
  const awaitWorkspaces = [...new Set([COORD_WORKSPACE, opts.workspaceId])];
  const terminal = WAIT_LEG_TERMINAL as unknown as string[];
  const boundKinds = ITEM_BOUND_AWAIT_KINDS as unknown as string[];
  const parkNoteLike = `${EXPLICIT_PARK_NOTE_MARKER}%`;

  const [bound, holder, itemLegs] = await Promise.all([
    // Leg 1 — awaits BOUND to an item in this harness (any subscriber).
    sql<AwaitRow[]>`
      SELECT a.id AS await_id, a.subscriber_id, a.event_key, a.created_at, a.expires_ts,
             a.bound_to ->> 'kind' AS bound_kind, a.bound_to ->> 'ref' AS bound_ref,
             w.feature_id, w.item_kind, w.title, w.status, w.source_plan_slug, w.taken_by
        FROM harness_shared.event_awaits a
        JOIN harness_shared.work_items w
          ON w.workspace_id = ${opts.workspaceId}
         AND w.harness_slug = ${opts.harnessSlug}
         AND w.feature_id = a.bound_to ->> 'ref'
       WHERE a.bound_to IS NOT NULL
         AND a.cancelled_at IS NULL
         AND a.fired_at IS NULL
         AND (a.bound_to ->> 'kind') = ANY(${boundKinds})
         AND a.workspace_id = ANY(${awaitWorkspaces})
         AND a.policy <> 'announce'
         AND (a.event_key NOT LIKE 'coord:inbox-wake:%' OR a.note LIKE ${parkNoteLike})
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${DEP_WAITS_LIMITS.bound + 1}`,
    // Leg 2 — each held item's HOLDER's other awaits, newest first, capped per holder. Rows
    // already returned by leg 1 for this item (bound to it) are excluded, not duplicated.
    sql<AwaitRow[]>`
      SELECT a.await_id, a.subscriber_id, a.event_key, a.created_at, a.expires_ts,
             a.bound_kind, a.bound_ref,
             w.feature_id, w.item_kind, w.title, w.status, w.source_plan_slug, w.taken_by
        FROM harness_shared.work_items w
        CROSS JOIN LATERAL (
          SELECT ea.id AS await_id, ea.subscriber_id, ea.event_key, ea.created_at, ea.expires_ts,
                 ea.bound_to ->> 'kind' AS bound_kind, ea.bound_to ->> 'ref' AS bound_ref
            FROM harness_shared.event_awaits ea
           WHERE ea.subscriber_id = w.taken_by
             AND ea.fired_at IS NULL
             AND ea.cancelled_at IS NULL
             AND ea.workspace_id = ANY(${awaitWorkspaces})
             AND ea.policy <> 'announce'
             AND (ea.event_key NOT LIKE 'coord:inbox-wake:%' OR ea.note LIKE ${parkNoteLike})
             AND NOT (ea.bound_to IS NOT NULL
                      AND (ea.bound_to ->> 'kind') = ANY(${boundKinds})
                      AND (ea.bound_to ->> 'ref') = w.feature_id)
           ORDER BY ea.created_at DESC, ea.id DESC
           LIMIT ${DEP_WAITS_PER_HOLDER}
        ) a
       WHERE w.workspace_id = ${opts.workspaceId}
         AND w.taken_by IS NOT NULL
         AND w.harness_slug = ${opts.harnessSlug}
         AND w.status <> ALL(${terminal})
       ORDER BY w.updated_ts DESC NULLS LAST, w.feature_id, a.created_at DESC
       LIMIT ${DEP_WAITS_LIMITS.holder + 1}`,
    // Legs 3-5 — ONE statement, three independently capped branches (so a call stays at four
    // statements). Branch 'blocker': items carrying an ACTIVE event/gate external blocker; the
    // `@>` shape is what work_items_external_blockers_gin_idx (migration 1539) serves. Branch
    // 'park': durably parked items with a string release trigger; `payload ? 'claim_hold_release'`
    // is work_items_claim_hold_release_trigger_idx's predicate. Branch 'condition': items
    // carrying an ACTIVE runtime/human blocker, the same `@>` shape on the same GIN index. An
    // item with both kinds appears in both branches; each keeps only its own kinds below.
    // Payload sub-objects are projected instead of the whole payload.
    sql<Array<ItemLegRow>>`
      (SELECT 'blocker' AS leg, w.feature_id, w.item_kind, w.title, w.status, w.source_plan_slug, w.taken_by,
              w.payload -> 'externalBlockers' AS blockers,
              NULL::text AS park_trigger, NULL::text AS park_recheck_at,
              NULL::text AS parked_by, NULL::text AS parked_at
         FROM harness_shared.work_items w
        WHERE w.workspace_id = ${opts.workspaceId}
          AND w.harness_slug = ${opts.harnessSlug}
          AND w.status <> ALL(${terminal})
          AND ((w.payload -> 'externalBlockers') @> '[{"kind":"event","status":"active"}]'::jsonb
               OR (w.payload -> 'externalBlockers') @> '[{"kind":"gate","status":"active"}]'::jsonb)
        ORDER BY w.feature_id
        LIMIT ${DEP_WAITS_LIMITS.blocker + 1})
      UNION ALL
      (SELECT 'park' AS leg, w.feature_id, w.item_kind, w.title, w.status, w.source_plan_slug, w.taken_by,
              NULL::jsonb AS blockers,
              btrim(w.payload -> 'claim_hold_release' ->> 'trigger') AS park_trigger,
              w.payload -> 'claim_hold_release' ->> 'recheckAt' AS park_recheck_at,
              w.payload ->> 'claim_hold_by' AS parked_by,
              w.payload ->> 'claim_hold_at' AS parked_at
         FROM harness_shared.work_items w
        WHERE w.workspace_id = ${opts.workspaceId}
          AND w.harness_slug = ${opts.harnessSlug}
          AND w.status <> ALL(${terminal})
          AND w.payload ? 'claim_hold_release'
          AND w.payload ->> '_claimHold' = 'true'
          AND jsonb_typeof(w.payload -> 'claim_hold_release' -> 'trigger') = 'string'
          AND btrim(w.payload -> 'claim_hold_release' ->> 'trigger') <> ''
        ORDER BY w.feature_id
        LIMIT ${DEP_WAITS_LIMITS.park + 1})
      UNION ALL
      (SELECT 'condition' AS leg, w.feature_id, w.item_kind, w.title, w.status, w.source_plan_slug, w.taken_by,
              w.payload -> 'externalBlockers' AS blockers,
              NULL::text AS park_trigger, NULL::text AS park_recheck_at,
              NULL::text AS parked_by, NULL::text AS parked_at
         FROM harness_shared.work_items w
        WHERE w.workspace_id = ${opts.workspaceId}
          AND w.harness_slug = ${opts.harnessSlug}
          AND w.status <> ALL(${terminal})
          AND ((w.payload -> 'externalBlockers') @> '[{"kind":"runtime","status":"active"}]'::jsonb
               OR (w.payload -> 'externalBlockers') @> '[{"kind":"human","status":"active"}]'::jsonb)
        ORDER BY w.feature_id
        LIMIT ${DEP_WAITS_LIMITS.condition + 1})`,
  ]);

  const blockers = itemLegs.filter((r) => r.leg === 'blocker');
  const parks = itemLegs.filter((r) => r.leg === 'park');
  const conditions = itemLegs.filter((r) => r.leg === 'condition');
  const boundTruncated = bound.length > DEP_WAITS_LIMITS.bound;
  const holderTruncated = holder.length > DEP_WAITS_LIMITS.holder;
  const blockerTruncated = blockers.length > DEP_WAITS_LIMITS.blocker;
  const parkTruncated = parks.length > DEP_WAITS_LIMITS.park;
  const conditionTruncated = conditions.length > DEP_WAITS_LIMITS.condition;
  const boundRows = bound.slice(0, DEP_WAITS_LIMITS.bound);
  const holderRows = holder.slice(0, DEP_WAITS_LIMITS.holder);
  const blockerRows = blockers.slice(0, DEP_WAITS_LIMITS.blocker);
  const parkRows = parks.slice(0, DEP_WAITS_LIMITS.park);
  const conditionRows = conditions.slice(0, DEP_WAITS_LIMITS.condition);

  type BlockerWait = { item: WaitItemRow; kind: 'event' | 'gate'; ref: string; since: string | null };
  const blockerWaits: BlockerWait[] = [];
  for (const row of blockerRows) {
    for (const b of activeExternalBlockers({ externalBlockers: row.blockers })) {
      if (b.kind !== 'event' && b.kind !== 'gate') continue;
      blockerWaits.push({ item: row, kind: b.kind, ref: b.ref, since: isoOrNull(b.createdAt) });
    }
  }
  // The SQL already requires a non-blank string trigger; the guard keeps the type honest.
  const parkWaits = parkRows.flatMap((row) => row.park_trigger ? [{ item: row, trigger: row.park_trigger }] : []);
  type ConditionWait = {
    item: WaitItemRow;
    kind: ConditionBlockerKind;
    ref: string;
    capability: ExternalBlockerCapability;
    recheckAt: string | null;
    since: string | null;
  };
  const conditionWaits: ConditionWait[] = [];
  for (const row of conditionRows) {
    for (const b of activeExternalBlockers({ externalBlockers: row.blockers })) {
      if (!isConditionBlockerKind(b.kind)) continue;
      conditionWaits.push({
        item: row,
        kind: b.kind,
        ref: b.ref,
        capability: b.capability,
        recheckAt: isoOrNull(b.recheckAt),
        since: isoOrNull(b.createdAt),
      });
    }
  }

  // One read for "which of these keys did a producer announce, and who", and one oracle batch.
  // A condition's ref is not an event key, so it is never looked up here.
  const keys = [...new Set([
    ...boundRows.map((r) => r.event_key),
    ...holderRows.map((r) => r.event_key),
    ...blockerWaits.map((w) => w.ref),
    ...parkWaits.map((w) => w.trigger),
  ])];
  const subscribers = [...new Set([...boundRows, ...holderRows].map((r) => r.subscriber_id))];
  const [announcedRows, states] = await Promise.all([
    keys.length === 0
      ? Promise.resolve([] as Array<{ event_key: string; announced_by: string }>)
      : sql<Array<{ event_key: string; announced_by: string }>>`
          SELECT DISTINCT ON (event_key) event_key, subscriber_id AS announced_by
            FROM harness_shared.event_awaits
           WHERE workspace_id = ANY(${awaitWorkspaces})
             AND policy = 'announce'
             AND superseded_at IS NULL
             AND cancelled_at IS NULL
             AND event_key = ANY(${keys})
           ORDER BY event_key, created_at DESC, id DESC`,
    boundedSessionStates(subscribers, deps),
  ]);
  const announcer = new Map(announcedRows.map((r) => [r.event_key, r.announced_by]));
  const certify = (key: string): DependencyGraphWaitCertification =>
    uncertifiedConditionReason(key, announcer.has(key)) ?? 'proving';
  const announcement = (key: string) => ({ announced: announcer.has(key), announcedBy: announcer.get(key) ?? null });
  // Compiled once per resolve: the parser builds a regex for every catalog template.
  const parseKey = createEventKeyParser();
  const subjectOf = (key: string): string | null => eventKeySubjectItemId(parseKey(key));
  const nowMs = Date.now();

  const itemFields = (r: WaitItemRow) => ({
    itemId: r.feature_id,
    itemKind: r.item_kind,
    itemTitle: r.title,
    itemStatus: r.status,
    itemPlanSlug: r.source_plan_slug,
    holderId: r.taken_by,
  });
  const fromAwait = (r: AwaitRow, legTruncated: boolean): DependencyGraphWait => {
    const subscriberState = states.get(r.subscriber_id) ?? null;
    const expiresMs = r.expires_ts == null ? null : new Date(r.expires_ts).getTime();
    const staleReason = subscriberState && DEAD_SESSION_STATES.has(subscriberState)
      ? 'subscriber-ended'
      : expiresMs != null && expiresMs <= nowMs
        ? 'await-expired'
        : null;
    const isBound = r.bound_ref === r.feature_id && boundKinds.includes(r.bound_kind ?? '');
    return {
      ...itemFields(r),
      waitKind: 'session-await',
      eventKey: r.event_key,
      subjectItemId: subjectOf(r.event_key),
      awaitId: String(r.await_id),
      blockerKind: null,
      capability: null,
      bound: isBound,
      boundKind: r.bound_kind,
      subscriberId: r.subscriber_id,
      subscriberIsHolder: r.taken_by != null && r.taken_by === r.subscriber_id,
      since: isoOrNull(r.created_at),
      parkedBy: null,
      recheckAt: null,
      certification: certify(r.event_key),
      ...announcement(r.event_key),
      subscriberState,
      stale: staleReason !== null,
      staleReason,
      legTruncated,
    };
  };

  return [
    ...boundRows.map((r) => fromAwait(r, boundTruncated)),
    ...holderRows.map((r) => fromAwait(r, holderTruncated)),
    ...blockerWaits.map((w): DependencyGraphWait => ({
      ...itemFields(w.item),
      waitKind: 'item-blocker',
      eventKey: w.ref,
      subjectItemId: subjectOf(w.ref),
      awaitId: null,
      blockerKind: w.kind,
      capability: null,
      bound: false,
      boundKind: null,
      subscriberId: null,
      subscriberIsHolder: false,
      since: w.since,
      parkedBy: null,
      recheckAt: null,
      certification: certify(w.ref),
      ...announcement(w.ref),
      subscriberState: null,
      stale: false,
      staleReason: null,
      legTruncated: blockerTruncated,
    })),
    ...parkWaits.map(({ item, trigger }): DependencyGraphWait => ({
      ...itemFields(item),
      waitKind: 'item-park',
      eventKey: trigger,
      subjectItemId: subjectOf(trigger),
      awaitId: null,
      blockerKind: null,
      capability: null,
      bound: false,
      boundKind: null,
      subscriberId: null,
      subscriberIsHolder: false,
      since: isoOrNull(item.parked_at),
      parkedBy: item.parked_by,
      recheckAt: isoOrNull(item.park_recheck_at),
      certification: certify(trigger),
      ...announcement(trigger),
      subscriberState: null,
      stale: false,
      staleReason: null,
      legTruncated: parkTruncated,
    })),
    ...conditionWaits.map((w): DependencyGraphWait => ({
      ...itemFields(w.item),
      waitKind: 'item-condition',
      eventKey: w.ref,
      subjectItemId: null,
      awaitId: null,
      blockerKind: w.kind,
      capability: w.capability,
      bound: false,
      boundKind: null,
      subscriberId: null,
      subscriberIsHolder: false,
      since: w.since,
      parkedBy: null,
      recheckAt: w.recheckAt,
      certification: 'not-an-event',
      announced: false,
      announcedBy: null,
      subscriberState: null,
      stale: false,
      staleReason: null,
      legTruncated: conditionTruncated,
    })),
  ];
}
