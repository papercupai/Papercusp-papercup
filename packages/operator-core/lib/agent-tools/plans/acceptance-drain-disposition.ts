/**
 * Typed dispositions for STALE awaiting-acceptance plans — P-005 of
 * verification-system-improvements-2026-10-10 (D-013, D-015, D-018).
 *
 * # The defect this closes
 *
 * The acceptance drain (`acceptance-drain-sweep.ts`) files one work item per plan
 * held in `awaiting-acceptance`, and P-016 classifies how each one is stuck. Nothing
 * ever forced a DECISION on a plan that has sat there for weeks: measured
 * 2026-10-10, 101 papercusp plans had been idle 28+ days in `awaiting-acceptance`
 * (WI-10008289), each with an open filing nobody acted on. A filing that never
 * resolves is a queue that never drains.
 *
 * # What this adds
 *
 *  1. **Surfacing.** When the drain observes a plan idle more than
 *     {@link ACCEPTANCE_STALE_SURFACE_AFTER_DAYS} days, it stamps the filing's
 *     `payload.staleSurfacedAt` (once) and `payload.dispositionRequired`, and the
 *     filing's title says a disposition is owed. The filing IS the attention item:
 *     claimable work, not a notification to an author who has usually ended.
 *  2. **A typed disposition.** Exactly one of {@link ACCEPTANCE_DISPOSITION_KINDS},
 *     each with an evidence ref and a reason, recorded on the canonical filing as
 *     `payload.acceptanceDisposition`. Anything else is refused with a typed code.
 *  3. **A measurement that cannot read 0 when the drain is dead.**
 *     {@link measureStaleAcceptance} counts BOTH plans the drain surfaced more than
 *     {@link ACCEPTANCE_STALE_GRACE_DAYS} days ago that still have no disposition,
 *     AND plans idle more than {@link ACCEPTANCE_NEVER_SURFACED_AFTER_DAYS} days
 *     that the drain never surfaced (D-015 point 1). The verification-health cell
 *     (P-002) imports it rather than re-deriving the SQL (D-018).
 *
 * # Idle clock
 *
 * "Idle" is the plan's last recorded write, the frontmatter `updated` date — the
 * same clock P-016's `planIdleDays` uses on `PlanIndexRow.updated`, so the sweep's
 * surfacing decision and this measurement can never disagree about a plan's age.
 * A row with no parseable `updated` falls back to `harness_plans.updated_at`.
 */

// Deliberately imports nothing from acceptance-drain-filing.ts: that module
// imports the surfacing helper from here, and a cycle would leave constants
// undefined under the tsx CJS preflight.

import { isHarnessInScope, primeWorkScopePolicy, workScopePolicy } from '../../work-scope-policy';

/** The drain surfaces a plan once it has been idle MORE than this many days. */
export const ACCEPTANCE_STALE_SURFACE_AFTER_DAYS = 14;

/** A surfaced plan counts as stale-undispositioned only after this grace. */
export const ACCEPTANCE_STALE_GRACE_DAYS = 3;

/**
 * A plan idle more than this many days that the drain NEVER surfaced counts as
 * stale-undispositioned regardless — the surfacing threshold plus the grace, so a
 * dead, unscheduled or misfiltering drain shows up as a non-zero count (D-015).
 */
export const ACCEPTANCE_NEVER_SURFACED_AFTER_DAYS =
  ACCEPTANCE_STALE_SURFACE_AFTER_DAYS + ACCEPTANCE_STALE_GRACE_DAYS;

/** The only four dispositions a stale awaiting-acceptance plan may receive. */
export const ACCEPTANCE_DISPOSITION_KINDS = ['regrade', 'repair', 'accept-risk', 'drop'] as const;
export type AcceptanceDispositionKind = (typeof ACCEPTANCE_DISPOSITION_KINDS)[number];

export interface AcceptanceDisposition {
  kind: AcceptanceDispositionKind;
  /** What the decision rests on: a work-item id, a plan Decision ref, a scorecard id, a URL. */
  evidenceRef: string;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

/** Refusal codes {@link validateAcceptanceDisposition} / {@link recordAcceptanceDrainDisposition} emit. */
export const ACCEPTANCE_DISPOSITION_REFUSAL_CODES = [
  'acceptance_disposition_kind_invalid',
  'acceptance_disposition_evidence_missing',
  'acceptance_disposition_reason_missing',
  'acceptance_disposition_no_filing',
] as const;
export type AcceptanceDispositionRefusalCode = (typeof ACCEPTANCE_DISPOSITION_REFUSAL_CODES)[number];

export type AcceptanceDispositionValidation =
  | { ok: true; kind: AcceptanceDispositionKind; evidenceRef: string; reason: string }
  | { ok: false; code: AcceptanceDispositionRefusalCode; message: string };

/** Pure validation. Never coerces an unknown kind to a known one. */
export function validateAcceptanceDisposition(input: {
  kind: unknown;
  evidenceRef: unknown;
  reason: unknown;
}): AcceptanceDispositionValidation {
  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
  if (!(ACCEPTANCE_DISPOSITION_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      code: 'acceptance_disposition_kind_invalid',
      message:
        `acceptance disposition kind '${String(input.kind)}' is not one of ` +
        `${ACCEPTANCE_DISPOSITION_KINDS.join(' | ')}.`,
    };
  }
  const evidenceRef = typeof input.evidenceRef === 'string' ? input.evidenceRef.trim() : '';
  if (!evidenceRef) {
    return {
      ok: false,
      code: 'acceptance_disposition_evidence_missing',
      message:
        'an acceptance disposition needs an evidenceRef naming what it rests on ' +
        '(a work-item id, a plan Decision ref such as <slug>#D-NNN, a scorecard id, or a URL).',
    };
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) {
    return {
      ok: false,
      code: 'acceptance_disposition_reason_missing',
      message: 'an acceptance disposition needs a one-line reason of its own.',
    };
  }
  return { ok: true, kind: kind as AcceptanceDispositionKind, evidenceRef, reason };
}

export interface AcceptanceStaleSurfacingPatch {
  staleSurfacedAt?: string;
  dispositionRequired: boolean;
}

/**
 * Pure: what the drain writes onto a filing for a plan of the given idle age.
 *
 * Returns null when the plan is not stale (nothing to stamp). `staleSurfacedAt`
 * is written ONCE — a later sweep never moves it forward, which would restart the
 * grace window forever and keep the stale count at zero.
 */
export function acceptanceStaleSurfacingPatch(
  existingPayload: Record<string, unknown> | null | undefined,
  idleDays: number | null,
  now: Date,
): AcceptanceStaleSurfacingPatch | null {
  if (idleDays === null || idleDays <= ACCEPTANCE_STALE_SURFACE_AFTER_DAYS) return null;
  const dispositioned = existingPayload?.acceptanceDisposition != null;
  const already = existingPayload?.staleSurfacedAt;
  return {
    ...(typeof already === 'string' && Number.isFinite(Date.parse(already))
      ? {}
      : { staleSurfacedAt: now.toISOString() }),
    dispositionRequired: !dispositioned,
  };
}

/** Title for a filing that owes a disposition — the attention line on the queue. */
export function staleAcceptanceTitle(planSlug: string, idleDays: number | null): string {
  return (
    `Disposition stale plan '${planSlug}' (awaiting-acceptance, idle ${idleDays ?? '?'}d): ` +
    `${ACCEPTANCE_DISPOSITION_KINDS.join(' | ')}`
  );
}

/** Minimal tagged-template SQL surface, so callers pass a `postgres` sql or a tx. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;

export interface StaleAcceptanceMeasurement {
  /** Drain-surfaced more than the grace ago, still no typed disposition. */
  staleAcceptanceSurfaced: number;
  /** Idle more than 17 days, never surfaced by the drain, no typed disposition. */
  staleAcceptanceNeverSurfaced: number;
  /** The sum — the R-5 probe value. In-scope harnesses only (D-029). */
  staleAcceptanceUndispositioned: number;
  /**
   * Stale, undispositioned plans (surfaced or never-surfaced, same thresholds) homed in a
   * harness the workspace work-scope policy excludes (D-029). The drain skips these by
   * design, so they are not stalls and are NOT in {@link staleAcceptanceUndispositioned};
   * they are counted here so they are never silently dropped (workspace-work-scope-policy
   * P-007 "counted, never dropped"). Widening the policy is the owner's lever.
   */
  staleAcceptanceScopeExcluded: number;
  /**
   * Non-archived, non-rubric plans in scope, ANY status (D-019 denominator), filtered by
   * the work-scope policy too (D-029). The verification-health cell reports the R-5
   * reading as null when this is 0, so a wrong workspace filter, an empty population, or
   * a policy that excludes everything cannot pass an `eq 0` probe.
   */
  acceptancePlansConsidered: number;
  thresholds: { surfaceAfterDays: number; graceDays: number; neverSurfacedAfterDays: number };
}

/**
 * Count stale, undispositioned awaiting-acceptance plans (D-015 definition).
 *
 * Every filing for the plan's ref is read regardless of status: a disposition
 * recorded on a filing that was later closed still disposes of the plan, and a
 * plan is "surfaced" if any filing for it ever carried the stamp.
 *
 * Scope (D-029): the counting population is the drain's population. The sweep never
 * files a plan homed in a harness the workspace work-scope policy excludes (same
 * `isHarnessInScope` predicate), so such a plan is reported in
 * `staleAcceptanceScopeExcluded`, never as a stall, and is left out of
 * `acceptancePlansConsidered`. The policy is primed first, exactly as the sweep does
 * (WI-10002448: an unprimed cache reads as "not enforced"), and snapshotted once so every
 * harness is judged against the same policy. No stored policy keeps every harness in
 * scope. `opts.inScope` replaces the predicate (tests).
 */
export async function measureStaleAcceptance(
  sql: Sql,
  opts: {
    workspaceId: string;
    harnessSlug?: string | null;
    now?: Date;
    inScope?: (harnessSlug: string) => boolean;
  },
): Promise<StaleAcceptanceMeasurement> {
  const now = (opts.now ?? new Date()).toISOString();
  const harness = opts.harnessSlug ?? null;
  let inScope = opts.inScope;
  if (!inScope) {
    await primeWorkScopePolicy();
    const policy = workScopePolicy();
    inScope = (slug: string) => isHarnessInScope(slug, policy);
  }
  const staleRows = (await sql`
    WITH plans AS (
      SELECT p.harness_slug,
             p.workspace_id || '/' || p.harness_slug || '/' || p.plan_slug AS ref,
             CASE WHEN p.updated ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                  THEN (substring(p.updated FROM 1 FOR 10) || 'T00:00:00Z')::timestamptz
                  ELSE p.updated_at END AS idle_since
        FROM harness_shared.harness_plans p
       WHERE p.workspace_id = ${opts.workspaceId}
         AND p.status = 'awaiting-acceptance'
         AND p.archived IS NOT TRUE
         AND (p.template IS NULL OR p.template <> 'rubric')
         AND (${harness}::text IS NULL OR p.harness_slug = ${harness}::text)
    ), filings AS (
      SELECT wi.payload->>'acceptanceDrainPlan' AS ref,
             bool_or(wi.payload ? 'acceptanceDisposition'
                     AND jsonb_typeof(wi.payload->'acceptanceDisposition') = 'object') AS dispositioned,
             min(CASE WHEN wi.payload->>'staleSurfacedAt' ~ '^[0-9]{4}-'
                      THEN (wi.payload->>'staleSurfacedAt')::timestamptz END) AS surfaced_at
        FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${opts.workspaceId}
         AND wi.payload->>'acceptanceDrainPlan' IN (SELECT ref FROM plans)
       GROUP BY 1
    )
    SELECT
      p.harness_slug,
      count(*) FILTER (
        WHERE f.surfaced_at IS NOT NULL
          AND f.surfaced_at < ${now}::timestamptz - make_interval(days => ${ACCEPTANCE_STALE_GRACE_DAYS})
          AND COALESCE(f.dispositioned, false) = false
      )::int AS surfaced,
      count(*) FILTER (
        WHERE f.surfaced_at IS NULL
          AND p.idle_since < ${now}::timestamptz - make_interval(days => ${ACCEPTANCE_NEVER_SURFACED_AFTER_DAYS})
          AND COALESCE(f.dispositioned, false) = false
      )::int AS never_surfaced
      FROM plans p
      LEFT JOIN filings f ON f.ref = p.ref
     GROUP BY p.harness_slug
  `) as Array<{ harness_slug: string; surfaced: number | null; never_surfaced: number | null }>;
  const consideredRows = (await sql`
    SELECT q.harness_slug, count(*)::int AS considered
      FROM harness_shared.harness_plans q
     WHERE q.workspace_id = ${opts.workspaceId}
       AND q.archived IS NOT TRUE
       AND (q.template IS NULL OR q.template <> 'rubric')
       AND (${harness}::text IS NULL OR q.harness_slug = ${harness}::text)
     GROUP BY q.harness_slug
  `) as Array<{ harness_slug: string; considered: number | null }>;
  // Grouped per harness and judged in JS: the policy's harness patterns are matched by
  // matchHarnessPattern, which SQL cannot reproduce faithfully.
  let surfaced = 0;
  let neverSurfaced = 0;
  let scopeExcluded = 0;
  for (const r of staleRows) {
    const s = Number(r.surfaced ?? 0);
    const n = Number(r.never_surfaced ?? 0);
    if (inScope(r.harness_slug)) {
      surfaced += s;
      neverSurfaced += n;
    } else {
      scopeExcluded += s + n;
    }
  }
  let considered = 0;
  for (const r of consideredRows) {
    if (inScope(r.harness_slug)) considered += Number(r.considered ?? 0);
  }
  return {
    staleAcceptanceSurfaced: surfaced,
    staleAcceptanceNeverSurfaced: neverSurfaced,
    staleAcceptanceUndispositioned: surfaced + neverSurfaced,
    staleAcceptanceScopeExcluded: scopeExcluded,
    acceptancePlansConsidered: considered,
    thresholds: {
      surfaceAfterDays: ACCEPTANCE_STALE_SURFACE_AFTER_DAYS,
      graceDays: ACCEPTANCE_STALE_GRACE_DAYS,
      neverSurfacedAfterDays: ACCEPTANCE_NEVER_SURFACED_AFTER_DAYS,
    },
  };
}

export type RecordAcceptanceDispositionResult =
  | { ok: true; workItemId: string; harnessSlug: string; disposition: AcceptanceDisposition; replaced: AcceptanceDisposition | null }
  | { ok: false; code: AcceptanceDispositionRefusalCode; message: string };

/**
 * Record a typed disposition on the plan's canonical acceptance-drain filing.
 *
 * The canonical filing is the oldest OPEN one (the drain's canonical order); when
 * none is open, the most recent filing of any status. A plan the drain has never
 * filed has no filing to carry the record, so the call is refused with
 * `acceptance_disposition_no_filing` rather than inventing a row outside the drain.
 */
export async function recordAcceptanceDrainDisposition(
  sql: Sql,
  input: {
    workspaceId: string;
    harnessSlug: string;
    planSlug: string;
    kind: unknown;
    evidenceRef: unknown;
    reason: unknown;
    recordedBy: string;
    now?: Date;
  },
): Promise<RecordAcceptanceDispositionResult> {
  const v = validateAcceptanceDisposition(input);
  if (!v.ok) return v;
  const ref = `${input.workspaceId}/${input.harnessSlug}/${input.planSlug}`;
  const filing = (await sql`
    SELECT feature_id, harness_slug, payload->'acceptanceDisposition' AS prior
      FROM harness_shared.work_items
     WHERE workspace_id = ${input.workspaceId}
       AND payload->>'acceptanceDrainPlan' = ${ref}
     ORDER BY (status IN ('open','todo','wip','in_progress','blocked','needs-human','validating','failing')) DESC,
              CASE WHEN status IN ('open','todo','wip','in_progress','blocked','needs-human','validating','failing')
                   THEN created_ts END ASC,
              created_ts DESC, feature_id
     LIMIT 1
  `) as Array<{ feature_id: string; harness_slug: string; prior: AcceptanceDisposition | null }>;
  const row = filing[0];
  if (!row) {
    return {
      ok: false,
      code: 'acceptance_disposition_no_filing',
      message:
        `plan '${input.planSlug}' has no acceptance-drain filing to carry a disposition. ` +
        `The drain files one for every awaiting-acceptance plan; if this plan is in ` +
        `awaiting-acceptance and still unfiled, the drain is not reaching it — run the ` +
        `acceptance-drain-sweep routine and re-read before recording.`,
    };
  }
  const disposition: AcceptanceDisposition = {
    kind: v.kind,
    evidenceRef: v.evidenceRef,
    reason: v.reason,
    recordedBy: input.recordedBy,
    recordedAt: (input.now ?? new Date()).toISOString(),
  };
  await sql`
    UPDATE harness_shared.work_items
       SET payload = COALESCE(payload, '{}'::jsonb)
                     || jsonb_build_object('acceptanceDisposition', ${JSON.stringify(disposition)}::jsonb,
                                           'dispositionRequired', false),
           updated_ts = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${row.harness_slug}
       AND feature_id = ${row.feature_id}
  `;
  return { ok: true, workItemId: row.feature_id, harnessSlug: row.harness_slug, disposition, replaced: row.prior ?? null };
}
