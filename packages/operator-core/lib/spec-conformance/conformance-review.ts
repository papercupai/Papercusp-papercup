/**
 * Independent conformance review (R-21, spec-driven-tooling-integration-2026-10-05 P-030).
 *
 * Mechanised conformance (falsifiers, done-when checks, footprint) cannot see everything a
 * spec asks for, so a plan also gets a periodic spec-versus-implementation REVIEW done by
 * someone who did not build it. Two halves:
 *
 *  - `system:spec-conformance-review` (plan-schedulable) files ONE deduplicated review
 *    work-item per plan through the condition-key upsert, and records in its payload the
 *    implementer set the review must exclude (`payload.specConformanceReview`).
 *  - `work_items:complete` calls {@link conformanceReviewClosureRefusal}: a successful close
 *    of a review item is refused when the closer, or anyone in the closer's spawn/rebind
 *    lineage, belongs to the plan's implementer set. The set is the one recorded at filing
 *    time UNIONED with the set re-resolved at close time, so an implementer who joined the
 *    plan after the review was filed is excluded too.
 *
 * Fail-closed throughout: an unreadable implementer population or an unattributed closer is
 * a refusal, never a clean pass (the acceptance-author-identity resolvers document the same
 * rule: silently shrinking an independence population is a fail-open gate).
 */
import { getOrgPg } from '@papercusp/db-org';
import { upsertConditionWorkItem } from '../coord/condition-upsert';
import { acceptanceLineageClosure, resolvePlanImplementerIdentities } from '../acceptance-author-identity';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from '../harness/routines/system-actions';

export const CONFORMANCE_REVIEW_ACTION = 'spec-conformance-review';
export const CONFORMANCE_REVIEW_ACTOR = `system:${CONFORMANCE_REVIEW_ACTION}`;
/** Payload key the review record lives under on the filed work-item. */
export const CONFORMANCE_REVIEW_PAYLOAD_KEY = 'specConformanceReview';
/** Error code `work_items:complete` returns when an implementer closes the review. */
export const CONFORMANCE_REVIEW_IMPLEMENTER_REFUSAL = 'conformance_review_implementer_closer';

/** Dedup identity: one open review per (harness, plan). */
export function conformanceReviewConditionKey(harnessSlug: string, planSlug: string): string {
  return `spec-conformance-review:${harnessSlug}/${planSlug}`;
}

export interface ConformanceReviewRecord {
  planSlug: string;
  harnessSlug: string;
  /** Sorted, deduplicated implementer identities at filing time. */
  excludedImplementers: string[];
  filedAt: string;
}

const normalizeIdentities = (ids: Iterable<string>): string[] =>
  [...new Set([...ids].map((id) => id.trim()).filter(Boolean))].sort();

/** The review record on a work-item payload, or null when the item is not a conformance review. */
export function conformanceReviewFromPayload(payload: unknown): ConformanceReviewRecord | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>)[CONFORMANCE_REVIEW_PAYLOAD_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const planSlug = typeof rec.planSlug === 'string' ? rec.planSlug.trim() : '';
  const harnessSlug = typeof rec.harnessSlug === 'string' ? rec.harnessSlug.trim() : '';
  if (!planSlug || !harnessSlug) return null;
  const excluded = Array.isArray(rec.excludedImplementers)
    ? rec.excludedImplementers.filter((v): v is string => typeof v === 'string')
    : [];
  return {
    planSlug,
    harnessSlug,
    excludedImplementers: normalizeIdentities(excluded),
    filedAt: typeof rec.filedAt === 'string' ? rec.filedAt : '',
  };
}

// ---------------------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------------------

export interface ReviewFiling {
  conditionKey: string;
  title: string;
  summary: string;
  record: ConformanceReviewRecord;
}

export interface FileConformanceReviewDeps {
  /** The plan's implementer identities. MUST throw when unreadable — never return []. */
  resolveImplementers(planSlug: string): Promise<string[]>;
  /** File-or-refresh the deduplicated review work-item. */
  upsertReview(filing: ReviewFiling): Promise<{ id: string; created: boolean }>;
  now?: () => string;
}

export interface FiledConformanceReview {
  id: string;
  created: boolean;
  excludedImplementers: string[];
}

export async function fileConformanceReview(
  input: { planSlug: string; harnessSlug: string },
  deps: FileConformanceReviewDeps,
): Promise<FiledConformanceReview> {
  const planSlug = input.planSlug.trim();
  const harnessSlug = input.harnessSlug.trim();
  if (!planSlug) throw new Error('spec_conformance_review_plan_required: planSlug is required');
  if (!harnessSlug) throw new Error('spec_conformance_review_harness_required: harnessSlug is required');
  const excludedImplementers = normalizeIdentities(await deps.resolveImplementers(planSlug));
  const record: ConformanceReviewRecord = {
    planSlug,
    harnessSlug,
    excludedImplementers,
    filedAt: (deps.now ?? (() => new Date().toISOString()))(),
  };
  const excludedText = excludedImplementers.length ? excludedImplementers.join(', ') : 'none recorded yet';
  const filed = await deps.upsertReview({
    conditionKey: conformanceReviewConditionKey(harnessSlug, planSlug),
    title: `Conformance review: ${planSlug}`,
    summary:
      `Independent spec-versus-implementation review of plan ${planSlug} (R-21). Read each ` +
      `requirement and its falsifiers against the shipped code and record what the mechanised ` +
      `conformance checks cannot see. A plan implementer may not close this item; excluded: ${excludedText}.`,
    record,
  });
  return { id: filed.id, created: filed.created, excludedImplementers };
}

/** DB-backed filing deps for one workspace + harness. */
export function productionReviewDeps(input: { workspaceId: string; harnessSlug: string }): FileConformanceReviewDeps {
  return {
    resolveImplementers: (planSlug) => resolvePlanImplementerIdentities(planSlug, { workspaceId: input.workspaceId }),
    async upsertReview(filing) {
      const res = await upsertConditionWorkItem(filing.conditionKey, {
        kind: 'task',
        severity: 'minor',
        harness: input.harnessSlug,
        workspaceId: input.workspaceId,
        createdBy: CONFORMANCE_REVIEW_ACTOR,
        title: filing.title,
        summary: filing.summary,
        payload: { [CONFORMANCE_REVIEW_PAYLOAD_KEY]: filing.record },
      });
      if (!res.id) {
        throw new Error(`spec-conformance-review: ${filing.conditionKey} returned no work-item id`);
      }
      if (!res.created) {
        // An adopted incumbent keeps its original payload; refresh the excluded set.
        await getOrgPg().sql`
          UPDATE harness_shared.work_items
             SET payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{specConformanceReview}', ${filing.record as never}::jsonb)
           WHERE feature_id = ${res.id} AND workspace_id = ${input.workspaceId}
        `;
      }
      return { id: res.id, created: res.created };
    },
  };
}

// ---------------------------------------------------------------------------------------
// Closure refusal
// ---------------------------------------------------------------------------------------

export interface ConformanceReviewClosureDeps {
  /** Current implementer identities. MUST throw when unreadable. */
  resolveImplementers(planSlug: string): Promise<string[]>;
  /** Every identity lineage-related to `id`, `id` itself included. MUST throw when unreadable. */
  lineageOf(id: string): Promise<ReadonlySet<string>>;
}

export interface ConformanceReviewRefusal {
  error: string;
  code: typeof CONFORMANCE_REVIEW_IMPLEMENTER_REFUSAL;
  planSlug: string;
  closer: string;
  /** Excluded identities the closer is (or is lineage-related to). Empty for a fail-closed refusal. */
  conflicts: string[];
  reason: 'implementer' | 'unattributed-closer' | 'population-unreadable';
}

/** Excluded identities that fall inside the closer's lineage (the closer itself included). */
export function implementerConflicts(closerLineage: ReadonlySet<string>, excluded: Iterable<string>): string[] {
  return normalizeIdentities([...excluded].filter((id) => closerLineage.has(id.trim())));
}

export function productionClosureDeps(workspaceId?: string): ConformanceReviewClosureDeps {
  return {
    resolveImplementers: (planSlug) => resolvePlanImplementerIdentities(planSlug, workspaceId ? { workspaceId } : {}),
    lineageOf: (id) => acceptanceLineageClosure(id, workspaceId ? { workspaceId } : {}),
  };
}

/**
 * The refusal for a successful close of a conformance-review item by `closer`, or null when
 * the closer is independent of the plan's implementers.
 */
export async function conformanceReviewClosureRefusal(
  args: { itemId: string; review: ConformanceReviewRecord; closer: string | null | undefined },
  deps: ConformanceReviewClosureDeps = productionClosureDeps(),
): Promise<ConformanceReviewRefusal | null> {
  const closer = args.closer?.trim() ?? '';
  const { planSlug } = args.review;
  const refuse = (reason: ConformanceReviewRefusal['reason'], conflicts: string[], detail: string): ConformanceReviewRefusal => ({
    error: `refusing to complete ${args.itemId}: ${CONFORMANCE_REVIEW_IMPLEMENTER_REFUSAL} — ${detail}`,
    code: CONFORMANCE_REVIEW_IMPLEMENTER_REFUSAL,
    planSlug,
    closer,
    conflicts,
    reason,
  });
  if (!closer) {
    return refuse('unattributed-closer', [], `a conformance review of plan ${planSlug} must be closed by an attributed, independent reviewer (R-21).`);
  }
  let excluded: string[];
  let lineage: ReadonlySet<string>;
  try {
    const current = await deps.resolveImplementers(planSlug);
    excluded = normalizeIdentities([...args.review.excludedImplementers, ...current]);
    lineage = await deps.lineageOf(closer);
  } catch (err) {
    return refuse(
      'population-unreadable',
      [],
      `the implementer population of plan ${planSlug} could not be read (${err instanceof Error ? err.message : String(err)}); independence cannot be shown, so the close is refused (R-21). Retry.`,
    );
  }
  const effectiveLineage = lineage.has(closer) ? lineage : new Set([...lineage, closer]);
  const conflicts = implementerConflicts(effectiveLineage, excluded);
  if (conflicts.length === 0) return null;
  return refuse(
    'implementer',
    conflicts,
    `${closer} is in, or lineage-related to, plan ${planSlug}'s implementer set (${conflicts.join(', ')}). ` +
      `A conformance review must be closed by someone who did not build the plan (R-21); leave it for an independent reviewer.`,
  );
}

// ---------------------------------------------------------------------------------------
// System action
// ---------------------------------------------------------------------------------------

/** The routine handler: payload `{ templateSlug, harnessSlug, input: { planSlug } }`. */
export async function runConformanceReviewAction(
  ctx: SystemActionCtx,
  deps?: FileConformanceReviewDeps,
): Promise<SystemActionResult> {
  const payload = (ctx.payloadTemplate ?? {}) as { harnessSlug?: unknown; input?: { planSlug?: unknown } };
  const planSlug = typeof payload.input?.planSlug === 'string' ? payload.input.planSlug.trim() : '';
  if (!planSlug) throw new Error('spec_conformance_review_plan_required: input.planSlug is required');
  const harnessSlug =
    typeof payload.harnessSlug === 'string' && payload.harnessSlug.trim() ? payload.harnessSlug.trim() : ctx.installSlug;
  const filed = await fileConformanceReview(
    { planSlug, harnessSlug },
    deps ?? productionReviewDeps({ workspaceId: ctx.workspaceId, harnessSlug }),
  );
  return {
    diagnostics: {
      specConformanceReview: {
        planSlug,
        harnessSlug,
        workItemId: filed.id,
        created: filed.created,
        excludedImplementers: filed.excludedImplementers.length,
      },
    },
  };
}

registerSystemAction(CONFORMANCE_REVIEW_ACTION, (ctx) => runConformanceReviewAction(ctx), {
  scheduling: 'on-demand',
  planSchedulable: true,
});
