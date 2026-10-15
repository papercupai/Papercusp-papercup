/**
 * Retro-fit conformance census (R-22, spec-driven-tooling-integration-2026-10-05 P-031).
 *
 * "Apply the loop to all active plans and report unenforced requirements per plan." The
 * census joins every live plan's `## Requirements` with its `## Conformance` contract
 * through the same {@link evaluateRequirementEnforcement} the activation gate and the
 * conformance run use, so the report can never disagree with what those gates enforce.
 *
 * The one property this module exists to guarantee is COVERAGE: every plan in the input
 * population appears in the report. A plan with no parseable requirements is listed as
 * `applicable:false`; a plan whose text cannot be evaluated at all is listed with an
 * `error` — neither is ever dropped, because a census that silently shrinks reads as a
 * clean one (the R-22 falsifier is exactly "an active plan is missing from the report").
 *
 * `plans:conformance { op:'report' }` serves it; the sweep (sweep-action.ts) is the
 * continuous half.
 */
import { getOrgPg } from '@papercusp/db-org';
import { evaluateRequirementEnforcement, type EnforcementStatus } from './conformance-contract';

/** Plan statuses the census covers by default — the live (not shipped, not drafted) plans. */
export const CONFORMANCE_REPORT_DEFAULT_STATUSES: readonly string[] = ['active', 'ready'];

export interface ConformanceReportPlanInput {
  planSlug: string;
  harnessSlug: string;
  status: string;
  content: string;
}

export interface ConformanceReportPlanRow {
  planSlug: string;
  harnessSlug: string;
  status: string;
  /** False when the plan has no parseable `## Requirements`: listed, never dropped. */
  applicable: boolean;
  contractPresent: boolean;
  requirements: number;
  counts: Record<EnforcementStatus, number>;
  /** Requirement keys with no runnable check, no falsifier and no approved declaration. */
  unenforced: string[];
  /** Requirement keys enforced only by an approved `unenforced` declaration. */
  declaredUnenforced: string[];
  pendingFalsifiers: number;
  problems: number;
  /** Set when the plan text could not be evaluated at all. */
  error?: string;
}

export interface ConformanceReportTotals {
  plans: number;
  applicable: number;
  notApplicable: number;
  errored: number;
  requirements: number;
  unenforced: number;
  declaredUnenforced: number;
  plansWithUnenforced: number;
}

export interface ConformanceReport {
  generatedAt: string;
  statuses: string[];
  plans: ConformanceReportPlanRow[];
  totals: ConformanceReportTotals;
}

const zeroCounts = (): Record<EnforcementStatus, number> => ({
  executable: 0,
  falsified: 0,
  'declared-unenforced': 0,
  unenforced: 0,
});

/** One plan's census row. Never throws: an unevaluable plan becomes an `error` row. */
export function conformanceReportRow(plan: ConformanceReportPlanInput): ConformanceReportPlanRow {
  const base = { planSlug: plan.planSlug, harnessSlug: plan.harnessSlug, status: plan.status };
  try {
    const report = evaluateRequirementEnforcement(plan.content);
    const pick = (status: EnforcementStatus) =>
      report.requirements.filter((req) => req.status === status).map((req) => req.barKey);
    return {
      ...base,
      applicable: report.applicable,
      contractPresent: report.contractPresent,
      requirements: report.requirements.length,
      counts: {
        executable: report.counts.executable,
        falsified: report.counts.falsified,
        'declared-unenforced': report.counts['declared-unenforced'],
        unenforced: report.counts.unenforced,
      },
      unenforced: pick('unenforced'),
      declaredUnenforced: pick('declared-unenforced'),
      pendingFalsifiers: report.counts.pendingFalsifiers,
      problems: report.problems.length,
    };
  } catch (err) {
    return {
      ...base,
      applicable: false,
      contractPresent: false,
      requirements: 0,
      counts: zeroCounts(),
      unenforced: [],
      declaredUnenforced: [],
      pendingFalsifiers: 0,
      problems: 1,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const normalizeStatus = (status: string) => status.trim().toLowerCase();

/**
 * The census over `plans`, filtered to `statuses` (default active + ready). Rows are
 * ordered worst-first (most unenforced requirements), then by harness and slug, so the
 * plans that need repair lead.
 */
export function buildConformanceReport(
  plans: ReadonlyArray<ConformanceReportPlanInput>,
  opts: { statuses?: readonly string[]; now?: () => string } = {},
): ConformanceReport {
  const statuses = [...new Set((opts.statuses ?? CONFORMANCE_REPORT_DEFAULT_STATUSES).map(normalizeStatus))];
  const wanted = new Set(statuses);
  const rows = plans
    .filter((plan) => wanted.has(normalizeStatus(plan.status)))
    .map(conformanceReportRow)
    .sort(
      (a, b) =>
        b.unenforced.length - a.unenforced.length ||
        a.harnessSlug.localeCompare(b.harnessSlug) ||
        a.planSlug.localeCompare(b.planSlug),
    );
  const totals: ConformanceReportTotals = {
    plans: rows.length,
    applicable: rows.filter((row) => row.applicable).length,
    notApplicable: rows.filter((row) => !row.applicable && !row.error).length,
    errored: rows.filter((row) => row.error).length,
    requirements: rows.reduce((sum, row) => sum + row.requirements, 0),
    unenforced: rows.reduce((sum, row) => sum + row.unenforced.length, 0),
    declaredUnenforced: rows.reduce((sum, row) => sum + row.declaredUnenforced.length, 0),
    plansWithUnenforced: rows.filter((row) => row.unenforced.length > 0).length,
  };
  return { generatedAt: (opts.now ?? (() => new Date().toISOString()))(), statuses, plans: rows, totals };
}

/** Render the census as Markdown (the retro-fit report body). */
export function renderConformanceReportMarkdown(report: ConformanceReport): string {
  const t = report.totals;
  const lines = [
    `# Spec-conformance retro-fit report`,
    '',
    `Generated ${report.generatedAt} over plans with status ${report.statuses.map((s) => `\`${s}\``).join(', ')}.`,
    '',
    `- Plans covered: **${t.plans}** (${t.applicable} with parseable requirements, ${t.notApplicable} without, ${t.errored} unevaluable)`,
    `- Requirements: **${t.requirements}**; unenforced: **${t.unenforced}** across **${t.plansWithUnenforced}** plan(s); declared-unenforced: ${t.declaredUnenforced}`,
    '',
    'An **unenforced** requirement has no runnable done-when check, no violated-when falsifier and no approved',
    '`unenforced` declaration: nothing would notice if the implementation drifted from it.',
    '',
    '| Plan | Harness | Status | Requirements | Executable | Falsified | Declared-unenforced | Unenforced | Unenforced keys |',
    '|---|---|---|---:|---:|---:|---:|---:|---|',
  ];
  for (const row of report.plans) {
    const keys = row.error
      ? `error: ${row.error.replace(/\|/g, '\\|').slice(0, 120)}`
      : row.applicable
        ? row.unenforced.join(', ') || '—'
        : '(no parseable requirements)';
    lines.push(
      `| \`${row.planSlug}\` | ${row.harnessSlug} | ${row.status} | ${row.requirements} | ${row.counts.executable} | ` +
        `${row.counts.falsified} | ${row.counts['declared-unenforced']} | ${row.counts.unenforced} | ${keys} |`,
    );
  }
  return lines.join('\n');
}

/** The live plan population for the census: non-archived plans in `statuses`. */
export async function loadConformanceReportPlans(input: {
  workspaceId: string;
  harnessSlug?: string;
  statuses?: readonly string[];
}): Promise<ConformanceReportPlanInput[]> {
  const { sql } = getOrgPg();
  const statuses = [...new Set((input.statuses ?? CONFORMANCE_REPORT_DEFAULT_STATUSES).map(normalizeStatus))];
  const rows = await sql<Array<{ plan_slug: string; harness_slug: string; status: string | null; content: string | null }>>`
    SELECT plan_slug, harness_slug, status, content
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${input.workspaceId}
       AND lower(status) = ANY(${statuses}::text[])
       AND archived IS NOT TRUE
       ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
     ORDER BY harness_slug, plan_slug`;
  return rows.map((row) => ({
    planSlug: row.plan_slug,
    harnessSlug: row.harness_slug,
    status: row.status ?? '',
    content: row.content ?? '',
  }));
}
