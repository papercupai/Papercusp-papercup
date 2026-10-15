/**
 * list-derived-lifecycle.ts — P-007 of derived-status-not-hand-written-2026-10-12 (R-6).
 *
 * `plans:list` used to call `derivePlanLifecycle(items)` with NO signals, so its
 * verdict could only ever be decided by the item graph: every plan with a live
 * item read `active`, however long ago anyone touched it. A plan nobody had
 * worked on for months was indistinguishable, in the directory, from one being
 * worked on right now — the exact "stored status claims liveness" defect this
 * plan exists to remove, reproduced one layer down.
 *
 * This module supplies the two signals `plans:get` already feeds the same pure
 * derivation (`plan-lifecycle-derivation.ts`), batched for a whole list:
 *
 *   · FRESHNESS — the newest of (a) the plan's own last write, (b) the newest
 *     transition on any work item linked to the plan, and (c) "now" when a
 *     linked work item is currently CLAIMED. A held claim is somebody working on
 *     the plan at this moment, so it counts as activity at read time; without it
 *     a plan whose only activity is an in-flight claim would read `stalled`.
 *   · ACCEPTANCE — whether an acceptance rubric is active, which is what tells
 *     `implementation-complete` apart from `awaiting-acceptance`.
 *
 * Linked work items are matched exactly as `plans:get` matches them
 * (`source_plan_slug`, or the `payload.plan_item.plan_slug` stamp), scoped by
 * workspace and keyed by plan slug, so the list and the single-plan read cannot
 * disagree about which rows belong to a plan.
 *
 * Both reads are best-effort. A failed read comes back `null` and is reported in
 * `unmeasured` — never defaulted to "no activity", which would turn a database
 * fault into a confident `stalled` verdict.
 */
import {
  derivePlanLifecycle,
  reconcilePlanLifecycle,
  type PlanItem,
  type PlanLifecycleDisposition,
  type PlanLifecycleUnmeasured,
  type PlanLifecycleVerdict,
} from '@papercusp/plan-parser';
import {
  activeAcceptanceRubricsQuery,
  buildPlanFreshness,
  normalizeActivityTimestamp,
  type PlanActivitySource,
} from './plan-lifecycle-derivation';

/** Every verdict `derivePlanLifecycle` can return — the `lifecycle` filter's vocabulary. */
export const PLAN_LIFECYCLE_VERDICTS = [
  'no-items',
  'active',
  'stalled',
  'implementation-complete',
  'awaiting-acceptance',
] as const satisfies readonly PlanLifecycleVerdict[];

// Compile-time exhaustiveness: a verdict added to the parser and forgotten here
// would make the filter silently unable to select it.
type MissingVerdict = Exclude<PlanLifecycleVerdict, (typeof PLAN_LIFECYCLE_VERDICTS)[number]>;
const VERDICTS_ARE_EXHAUSTIVE: [MissingVerdict] extends [never] ? true : never = true;
void VERDICTS_ARE_EXHAUSTIVE;

/** Work-item statuses after which a claim no longer means somebody is working. */
const TERMINAL_WORK_ITEM_STATUSES = ['done', 'dropped', 'resolved', 'closed'];

export interface PlanLinkedActivity {
  /** Newest transition across the plan's linked work items (ISO), or null. */
  lastActivityAt: string | null;
  /** Linked, non-terminal work items currently claimed by someone. */
  liveClaims: number;
}

export interface PlanListLifecycleSignals {
  /** slug → linked work-item activity; `null` when the read failed (unmeasured). */
  activity: ReadonlyMap<string, PlanLinkedActivity> | null;
  /** slug → active acceptance rubric slug; `null` when the read failed (unmeasured). */
  acceptance: ReadonlyMap<string, string> | null;
}

/** What `linked-work-item` adds to the parser's own unmeasured axes. */
export type ListLifecycleUnmeasured = PlanLifecycleUnmeasured | 'linked-work-item';

export interface DerivedLifecycleRow {
  verdict: PlanLifecycleVerdict;
  disposition: PlanLifecycleDisposition;
  contradiction: { claim: string; evidence: string } | null;
  /** Whole days since the newest measured activity; null when nothing was measurable. */
  idleDays: number | null;
  lastActivityAt: string | null;
  /** Live claims on linked work items; null when the linked-work-item read failed. */
  liveClaims: number | null;
  /** Signals this verdict could not see. Empty means fully measured. */
  unmeasured: ListLifecycleUnmeasured[];
}

/**
 * Read both signals for a batch of plan slugs, in parallel. Never throws: each
 * read that fails is returned as `null` so the caller can report it.
 */
export async function readPlanListLifecycleSignals(input: {
  workspaceId: string;
  planSlugs: readonly string[];
}): Promise<PlanListLifecycleSignals> {
  const slugs = [...new Set(input.planSlugs)];
  if (slugs.length === 0) return { activity: new Map(), acceptance: new Map() };
  const { withWorkspace } = await import('@papercusp/db-org');
  const workspaceId = input.workspaceId;

  const [activity, acceptance] = await Promise.allSettled([
    withWorkspace(workspaceId, (tx) =>
      // Two index-friendly branches instead of one OR: the OR over a jsonb path
      // forces a parallel seq scan (measured 118ms, 75k buffers workspace-wide);
      // the split uses hfc_source_plan_slug_idx and work_items_plan_item_stamp_idx
      // (measured 64ms for all 2,447 workspace slugs, 2026-10-12).
      tx<{ plan_slug: string; last_ts: string | number | null; live_claims: string | number }[]>`
        SELECT plan_slug,
               max(updated_ts) AS last_ts,
               count(*) FILTER (
                 WHERE taken_by IS NOT NULL AND status <> ALL(${TERMINAL_WORK_ITEM_STATUSES})
               ) AS live_claims
          FROM (
            SELECT source_plan_slug AS plan_slug, updated_ts, taken_by, status
              FROM harness_shared.harness_features_consolidated
             WHERE workspace_id = ${workspaceId}
               AND source_plan_slug = ANY(${slugs})
            UNION ALL
            SELECT payload -> 'plan_item' ->> 'plan_slug', updated_ts, taken_by, status
              FROM harness_shared.harness_features_consolidated
             WHERE workspace_id = ${workspaceId}
               AND source_plan_slug IS NULL
               AND payload -> 'plan_item' IS NOT NULL
               AND payload -> 'plan_item' ->> 'plan_slug' = ANY(${slugs})
          ) linked
         GROUP BY plan_slug
      `,
    ),
    withWorkspace(workspaceId, (tx) => activeAcceptanceRubricsQuery(tx, { workspaceId, planSlugs: slugs })),
  ]);

  return {
    activity:
      activity.status === 'fulfilled'
        ? new Map(
            activity.value.map((r) => [
              r.plan_slug,
              {
                lastActivityAt: normalizeActivityTimestamp(r.last_ts),
                liveClaims: Number(r.live_claims) || 0,
              },
            ]),
          )
        : null,
    acceptance:
      acceptance.status === 'fulfilled'
        ? new Map(acceptance.value.map((r) => [r.subject_plan, r.plan_slug]))
        : null,
  };
}

/**
 * The per-row verdict. Pure — the caller supplies the batch signals and the
 * clock — so it is the same function the unit tests drive.
 */
export function deriveListLifecycle(input: {
  planSlug: string;
  storedStatus: string;
  /** The plan's COMPLETE item list; a narrowed list would census a different plan. */
  items: readonly PlanItem[];
  /** `harness_plans.updated_at` — the plan's own last write. */
  planUpdatedAt: unknown;
  signals: PlanListLifecycleSignals;
  /** ISO clock. */
  now: string;
}): DerivedLifecycleRow {
  const { activity, acceptance } = input.signals;
  const linked = activity ? activity.get(input.planSlug) : undefined;
  const liveClaims = activity ? (linked?.liveClaims ?? 0) : null;

  const sources: PlanActivitySource[] = [
    { source: 'plan-write', at: normalizeActivityTimestamp(input.planUpdatedAt) },
  ];
  if (activity) {
    sources.push({ source: 'linked-work-item', at: linked?.lastActivityAt ?? null });
    if (liveClaims !== null && liveClaims > 0) sources.push({ source: 'live-claim', at: input.now });
  }
  const freshness = buildPlanFreshness(sources, input.now);

  const rubricRef = acceptance ? (acceptance.get(input.planSlug) ?? null) : undefined;
  const derived = derivePlanLifecycle(input.items, {
    freshness,
    ...(rubricRef !== undefined ? { acceptance: { rubricActive: rubricRef !== null, rubricRef } } : {}),
  });
  const reconciled = reconcilePlanLifecycle(input.storedStatus, derived);

  const unmeasured: ListLifecycleUnmeasured[] = [...derived.unmeasured];
  if (!activity) unmeasured.push('linked-work-item');

  return {
    verdict: derived.verdict,
    disposition: reconciled.disposition,
    contradiction: reconciled.contradiction,
    idleDays: derived.idleDays,
    lastActivityAt: freshness.lastActivityAt,
    liveClaims,
    unmeasured,
  };
}
