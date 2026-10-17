/**
 * Repair neutral, stranded subject pins without requiring another plan-start call
 * (WI-6554700010014766). Runs on the existing acceptance-grading sweep cadence.
 * The scan is only a hint: the reconciler re-reads under the plan lock and retains
 * all witness, BAR-source, rubric-revision and BAR-hash checks.
 */
import { getOrgPg } from '@papercusp/db-org';
import { reconcileStaleAcceptanceBarSubjectPin } from './acceptance-bar-pin-reconcile';
import { isHarnessInScope, primeWorkScopePolicy } from './work-scope-policy';

export const ACCEPTANCE_BAR_PIN_SWEEP_LIMIT = 50;

export interface AcceptanceBarPinSweepCursor {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}

export interface AcceptanceBarPinSweepResult {
  scanned: number;
  reconciled: number;
  scopeSkipped: number;
  held: Record<string, number>;
  errors: Array<AcceptanceBarPinSweepCursor & { error: string }>;
  nextCursor: AcceptanceBarPinSweepCursor | null;
}

/**
 * Keyset pagination advances even past semantic changes, unavailable witnesses
 * and out-of-scope plans. Otherwise the first permanently held batch would starve
 * every later neutral pin forever. A restart safely begins another pass.
 */
export async function runAcceptanceBarPinSweep(options: {
  after?: AcceptanceBarPinSweepCursor | null;
  limit?: number;
} = {}): Promise<AcceptanceBarPinSweepResult> {
  await primeWorkScopePolicy();
  const limit = Number.isSafeInteger(options.limit) && options.limit! > 0
    ? Math.min(options.limit!, ACCEPTANCE_BAR_PIN_SWEEP_LIMIT)
    : ACCEPTANCE_BAR_PIN_SWEEP_LIMIT;
  const after = options.after ?? null;
  const { sql } = getOrgPg();
  const rows = await sql<AcceptanceBarPinSweepCursor[]>`
    SELECT p.workspace_id AS "workspaceId", p.harness_slug AS "harnessSlug",
           p.plan_slug AS "planSlug"
      FROM harness_shared.harness_plans p
      JOIN harness_shared.harness_plans rubric
        ON rubric.workspace_id = p.workspace_id AND rubric.harness_slug = p.harness_slug
       AND rubric.plan_slug = p.acceptance_bar_rubric_slug
     WHERE p.archived = FALSE AND p.status NOT IN ('shipped', 'superseded')
       AND p.template IS DISTINCT FROM 'rubric'
       AND rubric.template = 'rubric' AND rubric.template_data->>'kind' = 'acceptance'
       AND rubric.template_data->>'subjectPlan' = p.plan_slug
       AND rubric.template_data->'barContract'->>'subjectPlanRevision' IS NOT NULL
       AND rubric.template_data->'barContract'->>'subjectPlanRevision' <> p.version::text
       AND (${after?.workspaceId ?? null}::text IS NULL OR
            (p.workspace_id, p.harness_slug, p.plan_slug) >
            (${after?.workspaceId ?? null}::text, ${after?.harnessSlug ?? null}::text,
             ${after?.planSlug ?? null}::text))
     ORDER BY p.workspace_id, p.harness_slug, p.plan_slug
     LIMIT ${limit}`;

  const result: AcceptanceBarPinSweepResult = {
    scanned: rows.length, reconciled: 0, scopeSkipped: 0, held: {}, errors: [],
    nextCursor: rows.length === limit ? rows[rows.length - 1]! : null,
  };
  for (const row of rows) {
    if (!isHarnessInScope(row.harnessSlug)) {
      result.scopeSkipped++;
      continue;
    }
    try {
      // Bound lock waiting per target; a busy plan can be retried on the next pass.
      const outcome = await reconcileStaleAcceptanceBarSubjectPin({ ...row, ttlSec: 1 });
      if (outcome.reconciled) result.reconciled++;
      else result.held[outcome.reason] = (result.held[outcome.reason] ?? 0) + 1;
    } catch (error) {
      result.errors.push({ ...row, error: String(error instanceof Error ? error.message : error).slice(0, 500) });
    }
  }
  return result;
}
