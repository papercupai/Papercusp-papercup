/** Shared post-commit effects for explicit publication and automatic capture. */
import type { Sql } from 'postgres';
import { publishReport, type PublishReportInput, type ReportOrigin } from './report-library';
import { emitAwaitedEvent } from './events/await/engine';
import { trackDetached } from './detached-imports';
import { invalidateReportsSync, reportUiPath } from './agent-tools/reports/_shared';

export async function publishReportWithEffects(
  sql: Sql, input: PublishReportInput, origin: ReportOrigin, log: (message: string) => void,
) {
  const report = await publishReport(sql, input, origin);
  let eventEmitted = true;
  try {
    await emitAwaitedEvent({
      key: `report:published:${report.reportId}`,
      payload: { report_id: report.reportId, lineage_id: report.lineageId,
        supersedes_report_id: report.supersedesReportId, kind: report.kind,
        visibility: report.visibility, subject: report.subject, origin: report.origin,
        path: reportUiPath(report.reportId) },
      summary: `report published: ${report.title}`,
      source: origin.authorOwnerId ?? 'reports:publish', workspaceId: input.workspaceId,
    });
  } catch (error) {
    eventEmitted = false;
    log(`report:published emit failed for ${report.reportId}: ${error instanceof Error ? error.message : error}`);
  }
  invalidateReportsSync(log);
  void trackDetached(import('./search/report-index')
    .then(({ indexReport }) => indexReport(sql, report))
    .catch(error => log(`Report ${report.reportId} indexing pending sweep recovery: ${String(error)}`)));
  return { report, eventEmitted };
}
