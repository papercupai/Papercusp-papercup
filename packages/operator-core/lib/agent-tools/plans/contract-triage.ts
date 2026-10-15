/**
 * Contract triage for active plans that carry no requirement contract — P-004 of
 * verification-system-improvements-2026-10-10 (D-013, D-018, D-019).
 *
 * # The defect this closes
 *
 * Measured 2026-10-10, 182 of 183 active plans predated the requirement contract and had
 * none, so nothing they claimed was checkable. Each one must end in exactly one recorded
 * disposition (SPEC-P-004-TRIAGE):
 *
 *  - **contract backfilled** — `harness_plans.acceptance_bar_set_hash` is set (the
 *    legacy-backfilled cohort, lib/acceptance-bar-migration.ts). No row here;
 *  - **exempt** — a row in `harness_shared.plan_contract_triage` with a reason;
 *  - **closed** — the plan left `active` (superseded/shipped/…) AND a row records the
 *    plan's OWN reason. A reason shared with another closure is counted as missing, so a
 *    bulk closure with one pasted reason cannot satisfy the bar (R-4).
 *
 * # The measurement (D-013 metric definitions, D-019 denominator)
 *
 * {@link measureContractTriage} returns never-null integers:
 *   - `uncoveredActivePlans` — active plans older than the 24-hour grace window with no
 *     contract, no exemption and no closure reason;
 *   - `uncoveredActivePlansRaw` — the same without the grace window;
 *   - `closureReasonMissing` — triage closures whose reason is not the plan's own;
 *   - `triageGaps` — the sum, the R-4 probe value;
 *   - `unreachablePlans` — uncovered plans whose harness has no Hive plan scope (D-030):
 *     no plans:* verb can address them, so they are reported here instead of as gaps.
 *     Only a confirmed `isUnknownPlanScopeError` moves a plan here; a registry fault
 *     fails the measurement;
 *   - `activePlansConsidered` — the active plans examined. The verification-health cell
 *     reports `triageGaps` as null when this is 0, so an empty population or a wrong
 *     workspace filter cannot pass an `eq 0` probe.
 *
 * # Grace clock
 *
 * `harness_plans` records no "became active at" time (`harness_plan_status` is empty in
 * practice), so the window runs from the plan's creation: `created_at`, else the
 * frontmatter `created` date, else `updated_at`. A long-lived plan that was activated
 * minutes ago therefore gets NO grace — the clock errs toward counting a gap, never toward
 * hiding one.
 */

/** A plan created less than this many hours ago is inside its grace window. */
export const CONTRACT_TRIAGE_GRACE_HOURS = 24;

/** The two dispositions this ledger records (a backfilled contract needs no row). */
export const CONTRACT_TRIAGE_DISPOSITIONS = ['exempt', 'closed'] as const;
export type ContractTriageDisposition = (typeof CONTRACT_TRIAGE_DISPOSITIONS)[number];

/** Refusal codes {@link validateContractTriageDisposition} / {@link recordContractTriageDisposition} emit. */
export const CONTRACT_TRIAGE_REFUSAL_CODES = [
  'contract_triage_disposition_invalid',
  'contract_triage_reason_missing',
  'contract_triage_reason_shared',
  'contract_triage_plan_not_found',
  'contract_triage_has_contract',
  'contract_triage_not_closed',
] as const;
export type ContractTriageRefusalCode = (typeof CONTRACT_TRIAGE_REFUSAL_CODES)[number];

export type ContractTriageValidation =
  | { ok: true; disposition: ContractTriageDisposition; reason: string; evidenceRef: string | null }
  | { ok: false; code: ContractTriageRefusalCode; message: string };

/**
 * Normalise a reason for the shared-reason comparison: trimmed, whitespace collapsed,
 * lower-cased. Mirrored by the SQL in {@link measureContractTriage}; keep them identical.
 */
export function normaliseTriageReason(reason: string): string {
  return reason.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Pure validation. Never coerces an unknown disposition to a known one. */
export function validateContractTriageDisposition(input: {
  disposition: unknown;
  reason: unknown;
  evidenceRef?: unknown;
}): ContractTriageValidation {
  const disposition = typeof input.disposition === 'string' ? input.disposition.trim() : '';
  if (!(CONTRACT_TRIAGE_DISPOSITIONS as readonly string[]).includes(disposition)) {
    return {
      ok: false,
      code: 'contract_triage_disposition_invalid',
      message:
        `contract-triage disposition '${String(input.disposition)}' is not one of ` +
        `${CONTRACT_TRIAGE_DISPOSITIONS.join(' | ')}. A backfilled contract needs no ` +
        `disposition row: it is read from the plan's acceptance bar.`,
    };
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) {
    return {
      ok: false,
      code: 'contract_triage_reason_missing',
      message: `a contract-triage ${disposition} needs the plan's own one-line reason.`,
    };
  }
  const evidenceRef =
    typeof input.evidenceRef === 'string' && input.evidenceRef.trim() ? input.evidenceRef.trim() : null;
  return { ok: true, disposition: disposition as ContractTriageDisposition, reason, evidenceRef };
}

/** Minimal tagged-template SQL surface, so callers pass a `postgres` sql or a tx. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;

export interface ContractTriageMeasurement {
  /** Active > 24h, no contract, no exemption, no closure reason. */
  uncoveredActivePlans: number;
  /** As above, without the grace window. */
  uncoveredActivePlansRaw: number;
  /** Triage closures whose reason is missing or shared with another closure. */
  closureReasonMissing: number;
  /** uncoveredActivePlans + closureReasonMissing — the R-4 probe value. */
  triageGaps: number;
  /** Active plans examined (D-019 denominator). */
  activePlansConsidered: number;
  /**
   * Uncovered active plans whose harness has no Hive plan scope (D-030), regardless of
   * age. No plans:* verb can close, supersede, archive or exempt them, so they are
   * reported here and never counted in `uncoveredActivePlans*` or `triageGaps`.
   */
  unreachablePlans: number;
  /** `<harness>/<plan>` for the first {@link UNREACHABLE_PLAN_REFS_CAP} unreachable plans. */
  unreachablePlanRefs: string[];
  thresholds: { graceHours: number };
}

/** Bound on `unreachablePlanRefs`; `unreachablePlans` stays the authoritative count. */
export const UNREACHABLE_PLAN_REFS_CAP = 50;

/**
 * Can the plans:* verbs address plans keyed by (workspace, harness)? `'no-plan-scope'` ONLY
 * for a confirmed refusal (the resolver's own "no plan scope" error) or a resolution to a
 * different workspace; a registry fault must throw, so the measurement fails (D-019) instead
 * of hiding the plans as unreachable (D-030, D-031).
 */
export type PlanScopeReach = 'reachable' | 'no-plan-scope';
export type PlanScopeProbe = (workspaceId: string, harnessSlug: string) => Promise<PlanScopeReach>;

/**
 * Build a {@link PlanScopeProbe} from a scope resolver and the classifier for its
 * "no Hive plan scope" error. Exported so the classification is testable without a DB.
 *
 * The resolver is called exactly as the plans:* verbs call it, `{ harnessSlug }` with NO
 * workspace (verification-system-improvements-2026-10-10#D-031). Passing the measured
 * workspace would skip the registry lookup the verbs depend on: a harness missing from
 * `harness_registry`/`projects` then resolves here while every verb refuses it. A harness
 * that resolves to a DIFFERENT workspace is also unreachable, because the verbs would address
 * that workspace's plan rows, not the ones being measured.
 */
export function planScopeProbeFrom(
  resolve: (opts: { harnessSlug: string }) => Promise<{ workspaceId: string }>,
  isUnknownScope: (error: unknown) => boolean,
): PlanScopeProbe {
  return async (workspaceId, harnessSlug) => {
    let resolved: { workspaceId: string };
    try {
      resolved = await resolve({ harnessSlug });
    } catch (error) {
      if (isUnknownScope(error)) return 'no-plan-scope';
      throw error;
    }
    return resolved.workspaceId === workspaceId ? 'reachable' : 'no-plan-scope';
  };
}

/** The production probe: the same resolver and classifier every plans:* verb goes through. */
export const defaultPlanScopeProbe: PlanScopeProbe = async (workspaceId, harnessSlug) => {
  const { resolvePlanScope, isUnknownPlanScopeError } = await import('./source');
  return planScopeProbeFrom(resolvePlanScope, isUnknownPlanScopeError)(workspaceId, harnessSlug);
};

/**
 * Measure the contract triage (D-013 definitions). Scope: non-archived, non-rubric plans in
 * the workspace (optionally one harness). Throws on a query failure — the caller reports the
 * metric as unmeasured, never as 0 (D-019).
 */
export async function measureContractTriage(
  sql: Sql,
  opts: { workspaceId: string; harnessSlug?: string | null; now?: Date; planScope?: PlanScopeProbe },
): Promise<ContractTriageMeasurement> {
  const now = (opts.now ?? new Date()).toISOString();
  const harness = opts.harnessSlug ?? null;
  const rows = (await sql`
    WITH plans AS (
      SELECT p.workspace_id, p.harness_slug, p.plan_slug, p.status,
             p.acceptance_bar_set_hash IS NOT NULL AS has_contract,
             COALESCE(p.created_at,
                      CASE WHEN p.created ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                           THEN (substring(p.created FROM 1 FOR 10) || 'T00:00:00Z')::timestamptz END,
                      p.updated_at) AS active_since
        FROM harness_shared.harness_plans p
       WHERE p.workspace_id = ${opts.workspaceId}
         AND p.archived IS NOT TRUE
         AND (p.template IS NULL OR p.template <> 'rubric')
         AND (${harness}::text IS NULL OR p.harness_slug = ${harness}::text)
    ), closures AS (
      SELECT t.workspace_id, t.harness_slug, t.plan_slug,
             count(*) OVER (
               PARTITION BY lower(regexp_replace(btrim(t.reason), '\\s+', ' ', 'g'))
             ) AS reason_uses
        FROM harness_shared.plan_contract_triage t
       WHERE t.workspace_id = ${opts.workspaceId}
         AND t.disposition = 'closed'
    ), triage AS (
      SELECT t.workspace_id, t.harness_slug, t.plan_slug, t.disposition
        FROM harness_shared.plan_contract_triage t
       WHERE t.workspace_id = ${opts.workspaceId}
    ), uncovered AS (
      SELECT p.harness_slug, p.plan_slug, p.active_since
        FROM plans p
        LEFT JOIN triage t
          ON t.workspace_id = p.workspace_id AND t.harness_slug = p.harness_slug
         AND t.plan_slug = p.plan_slug AND t.disposition = 'exempt'
       WHERE p.status = 'active' AND NOT p.has_contract AND t.plan_slug IS NULL
    )
    SELECT
      (SELECT count(*) FROM plans WHERE status = 'active')::int AS considered,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'harness', h.harness_slug, 'raw', h.raw, 'past', h.past, 'plans', h.plans)), '[]'::jsonb)
         FROM (SELECT u.harness_slug,
                      count(*)::int AS raw,
                      (count(*) FILTER (
                         WHERE u.active_since IS NULL
                            OR u.active_since < ${now}::timestamptz
                                                - make_interval(hours => ${CONTRACT_TRIAGE_GRACE_HOURS})))::int AS past,
                      array_agg(u.plan_slug ORDER BY u.plan_slug) AS plans
                 FROM uncovered u
                GROUP BY u.harness_slug) h) AS uncovered_by_harness,
      (SELECT count(*) FROM closures c
         JOIN plans p ON p.workspace_id = c.workspace_id AND p.harness_slug = c.harness_slug
                     AND p.plan_slug = c.plan_slug
        WHERE p.status <> 'active' AND c.reason_uses > 1)::int AS closure_reason_missing
  `) as Array<{
    considered: number | null;
    uncovered_by_harness: unknown;
    closure_reason_missing: number | null;
  }>;
  const r = rows[0];
  if (!r) throw new Error('measureContractTriage: the measurement query returned no row');
  const raw = r.uncovered_by_harness;
  const groups = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{
    harness: string;
    raw: number;
    past: number;
    plans: string[];
  }>;
  if (!Array.isArray(groups)) {
    throw new Error('measureContractTriage: uncovered_by_harness is not an array');
  }
  // D-030: one scope probe per harness. A fault propagates (the caller reports the metric
  // as unmeasured, D-019); only a confirmed "no Hive plan scope" moves plans out of the gaps.
  const probe = opts.planScope ?? defaultPlanScopeProbe;
  let uncovered = 0;
  let uncoveredRaw = 0;
  let unreachablePlans = 0;
  const unreachablePlanRefs: string[] = [];
  for (const g of groups) {
    if ((await probe(opts.workspaceId, g.harness)) === 'no-plan-scope') {
      unreachablePlans += Number(g.raw);
      for (const plan of g.plans) {
        if (unreachablePlanRefs.length < UNREACHABLE_PLAN_REFS_CAP) unreachablePlanRefs.push(`${g.harness}/${plan}`);
      }
    } else {
      uncovered += Number(g.past);
      uncoveredRaw += Number(g.raw);
    }
  }
  const closureReasonMissing = Number(r.closure_reason_missing ?? 0);
  return {
    uncoveredActivePlans: uncovered,
    uncoveredActivePlansRaw: uncoveredRaw,
    closureReasonMissing,
    triageGaps: uncovered + closureReasonMissing,
    activePlansConsidered: Number(r.considered ?? 0),
    unreachablePlans,
    unreachablePlanRefs,
    thresholds: { graceHours: CONTRACT_TRIAGE_GRACE_HOURS },
  };
}

export interface ContractTriageRecord {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  disposition: ContractTriageDisposition;
  reason: string;
  evidenceRef: string | null;
  closedToStatus: string | null;
  recordedBy: string;
  recordedAt: string;
}

export type RecordContractTriageResult =
  | { ok: true; record: ContractTriageRecord; replaced: boolean }
  | { ok: false; code: ContractTriageRefusalCode; message: string };

/**
 * Record one plan's triage disposition (upsert: a later call replaces the plan's row).
 *
 * Refuses: an unknown disposition or blank reason; a plan that does not exist or already
 * carries a contract (nothing to triage); a `closed` record for a plan that is still
 * `active` (move its status first with plans:set-plan-status — this ledger records a
 * closure, it does not perform one); and a closure reason already used by another plan's
 * closure (`contract_triage_reason_shared` — each closure needs its own reason).
 */
export async function recordContractTriageDisposition(
  sql: Sql,
  input: {
    workspaceId: string;
    harnessSlug: string;
    planSlug: string;
    disposition: unknown;
    reason: unknown;
    evidenceRef?: unknown;
    recordedBy: string;
    now?: Date;
  },
): Promise<RecordContractTriageResult> {
  const v = validateContractTriageDisposition(input);
  if (!v.ok) return v;
  const plan = (await sql`
    SELECT status, acceptance_bar_set_hash IS NOT NULL AS has_contract
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${input.harnessSlug}
       AND plan_slug = ${input.planSlug}
       AND archived IS NOT TRUE
     LIMIT 1
  `) as Array<{ status: string | null; has_contract: boolean }>;
  const row = plan[0];
  if (!row) {
    return {
      ok: false,
      code: 'contract_triage_plan_not_found',
      message: `no non-archived plan '${input.planSlug}' in harness '${input.harnessSlug}'.`,
    };
  }
  if (row.has_contract) {
    return {
      ok: false,
      code: 'contract_triage_has_contract',
      message:
        `plan '${input.planSlug}' already carries a requirement contract, so it needs no ` +
        `triage disposition.`,
    };
  }
  if (v.disposition === 'closed' && row.status === 'active') {
    return {
      ok: false,
      code: 'contract_triage_not_closed',
      message:
        `plan '${input.planSlug}' is still active. Close it first (plans:set-plan-status, ` +
        `e.g. status:'superseded'), then record the closure reason here.`,
    };
  }
  if (v.disposition === 'closed') {
    const shared = (await sql`
      SELECT plan_slug FROM harness_shared.plan_contract_triage
       WHERE workspace_id = ${input.workspaceId}
         AND disposition = 'closed'
         AND lower(regexp_replace(btrim(reason), '\\s+', ' ', 'g')) = ${normaliseTriageReason(v.reason)}
         AND NOT (harness_slug = ${input.harnessSlug} AND plan_slug = ${input.planSlug})
       LIMIT 1
    `) as Array<{ plan_slug: string }>;
    if (shared[0]) {
      return {
        ok: false,
        code: 'contract_triage_reason_shared',
        message:
          `that closure reason is already recorded for plan '${shared[0].plan_slug}'. ` +
          `Each closure needs the plan's own reason — say what about THIS plan makes it ` +
          `not worth a contract.`,
      };
    }
  }
  const record: ContractTriageRecord = {
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    planSlug: input.planSlug,
    disposition: v.disposition,
    reason: v.reason,
    evidenceRef: v.evidenceRef,
    closedToStatus: v.disposition === 'closed' ? row.status : null,
    recordedBy: input.recordedBy,
    recordedAt: (input.now ?? new Date()).toISOString(),
  };
  const written = (await sql`
    INSERT INTO harness_shared.plan_contract_triage
      (workspace_id, harness_slug, plan_slug, disposition, reason, evidence_ref,
       closed_to_status, recorded_by, recorded_at)
    VALUES (${record.workspaceId}, ${record.harnessSlug}, ${record.planSlug}, ${record.disposition},
            ${record.reason}, ${record.evidenceRef}, ${record.closedToStatus}, ${record.recordedBy},
            ${record.recordedAt}::timestamptz)
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE
       SET disposition = EXCLUDED.disposition,
           reason = EXCLUDED.reason,
           evidence_ref = EXCLUDED.evidence_ref,
           closed_to_status = EXCLUDED.closed_to_status,
           recorded_by = EXCLUDED.recorded_by,
           recorded_at = EXCLUDED.recorded_at
    RETURNING (xmax::text <> '0') AS replaced
  `) as Array<{ replaced: boolean }>;
  return { ok: true, record, replaced: Boolean(written[0]?.replaced) };
}
