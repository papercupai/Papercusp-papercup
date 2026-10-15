/**
 * reports:get — read one OR many published reports back by id, including the full
 * body and (optionally) the lineage behind them (P-003; satisfies R-3, R-7).
 *
 * Deliberately resolves RETIRED reports: retirement is a soft state, and a citation
 * to a report id must keep resolving forever (R-3). The row's `retired_at` says so.
 *
 * Reads are gated by the store's `visibleTo` fragment via a viewer — there is no
 * JavaScript re-implementation of the visibility matrix here, because two
 * implementations of one security rule drift silently in the permissive direction.
 * An invisible report is reported as `not_found`, not `forbidden`: which reports
 * exist is itself information the matrix is meant to withhold.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getReport, listReportLineage, type ReportCitationReadScope } from '../../report-library';
import { readScorecardEvidence, type ScorecardEvidenceCriterion } from '../../scorecards';
import { mergeIds, runBulk, bulkContent, bulkEnvelopeSchema } from '../_bulk';
import { reportsLibraryDisabled, resolveViewer, resolveWorkspaceId, toReportFull, toReportSummary } from './_shared';

function hasExactReportCitation(criteria: readonly ScorecardEvidenceCriterion[], reportId: string): boolean {
  if (!reportId) return false;
  const token = 'report:' + reportId;
  const hasToken = (text: string | undefined): boolean => {
    if (!text) return false;
    let start = text.indexOf(token);
    while (start >= 0) {
      const before = text[start - 1];
      const after = text[start + token.length];
      const leftBoundary = before === undefined || !/[A-Za-z0-9_]/.test(before);
      const rightBoundary = after === undefined || !/[A-Za-z0-9_-]/.test(after);
      if (leftBoundary && rightBoundary) return true;
      start = text.indexOf(token, start + 1);
    }
    return false;
  };
  return criteria.some(
    (criterion) =>
      hasToken(criterion.evidence) ||
      criterion.evidenceRef === reportId ||
      hasToken(criterion.evidenceRef),
  );
}

export default defineTool({
  name: 'reports:get',
  description:
    'Fetch one OR many published reports by id — including the full markdown body. Pass `id` for one or ' +
    '`ids` for several. A RETIRED report still resolves (retirement is soft, so a citation to a report id ' +
    'never breaks); its `retired_at` is set. Pass `lineage:true` to also get the full supersede history ' +
    'behind each report, newest first. Read-only. Reports you may not see come back as `not_found`.',
  guidance: {
    when:
      'When you have a report_id (from reports:list / reports:search, a `report:published:<id>` event, or a ' +
      'citation) and want to read what it actually says before relying on or superseding it.',
    notWhen:
      'To browse or discover — reports:list (filters) or reports:search (full text). Fetching many bodies ' +
      'to skim is expensive; a body can be 512KB.',
    chaining:
      'reports:list / reports:search → reports:get { ids:[…] } (read) → reports:publish { supersedes: id } ' +
      '(correct it). Bulk: single | ids[] → { ok, results, counts }; correlate by id not position.',
    returns:
      '{ ok, results:[{ ok, id, report? | error }], counts } — correlate by id, NOT position; one missing ' +
      'id never fails the rest. `report` carries the full record plus `path` (the owner deep link) and ' +
      '`body_md`. With `lineage:true` each result also carries `lineage:[…]` newest-first, INCLUDING ' +
      'retired steps — the history is the record, and hiding a retired step would make the chain read as ' +
      'if it never happened. error is `not_found` both when the id does not exist and when it is not ' +
      'visible to you: the visibility matrix withholds existence too.',
    seeAlso: ['reports:list (browse)', 'reports:search (full text)', 'reports:publish (supersede one)'],
  },
  // The envelope is `_bulk`'s to describe, not this tool's. Per-item stays OPEN because
  // a result carries `report` OR `error`, and `lineage:true` adds a third key — a closed
  // per-item schema would assert a shape the producer does not promise.
  result: bulkEnvelopeSchema(),
  capability: 'reports:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single report id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).min(1).max(50).optional().describe('report ids to fetch (1–50)'),
      lineage: z
        .boolean()
        .optional()
        .describe('also return the full supersede history behind each report, newest first'),
      scorecardIssueId: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('judge-only scope: the scorecard issue id whose criteria cite this single id; do not combine with ids or lineage'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args, ctx) {
    const disabled = await reportsLibraryDisabled();
    if (disabled) return { data: disabled };
    const sql = getOrgPg().sql;
    const workspaceId = resolveWorkspaceId(ctx);
    const viewer = resolveViewer(ctx);
    const ids = mergeIds(args.id, args.ids);
    let citationScope: ReportCitationReadScope | undefined;
    let citationError: string | undefined;

    if (args.scorecardIssueId !== undefined) {
      if (ctx.role !== 'judge') {
        citationError = 'not_found';
      } else if (args.id === undefined || args.ids !== undefined || args.lineage === true) {
        citationError = 'invalid_evidence_scope';
      } else {
        const evidence = await readScorecardEvidence(args.scorecardIssueId);
        if (
          evidence.kind !== 'found' ||
          !hasExactReportCitation(evidence.scorecard.criteria, args.id)
        ) {
          citationError = 'not_found';
        } else {
          citationScope = { kind: 'scorecard-citation', reportId: args.id };
        }
      }
    }

    const env = await runBulk(
      ids,
      async (id) => {
        if (citationError) return { ok: false as const, id, error: citationError };
        const exactScope = citationScope?.reportId === id ? citationScope : undefined;
        const report = await getReport(sql, workspaceId, id, viewer, exactScope);
        if (!report) return { ok: false as const, id, error: 'not_found' };

        const lineage = args.lineage
          ? (await listReportLineage(sql, workspaceId, report.lineageId, viewer)).map(toReportSummary)
          : undefined;

        return {
          ok: true as const,
          id,
          report: toReportFull(report),
          ...(lineage ? { lineage } : {}),
        };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
