/** Reports UI reads reuse the store and wire projection, never a second ACL/index. */
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { listReports, listReportLineage } from '../report-library';
import {
  reportsLibraryDisabled, toReportSummary, zReportKind, zReportSubjectKind, zReportVisibility,
} from '../agent-tools/reports/_shared';

export const reportsListArgs = z.object({
  kind: zReportKind.optional(),
  subject: z.object({ kind: zReportSubjectKind, ref: z.string().min(1).optional() }).strict().optional(),
  originHarnessSlug: z.string().min(1).optional(),
  visibility: zReportVisibility.optional(),
  query: z.string().max(500).optional(),
  tags: z.array(z.string().min(1)).max(20).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  cursor: z.object({ publishedAt: z.iso.datetime({ offset: true }), reportId: z.string().min(1) }).strict().optional(),
  includeRetired: z.boolean().optional(),
  collapseLineage: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

export async function resolveReportsList(args: z.infer<typeof reportsListArgs>) {
  const disabled = await reportsLibraryDisabled();
  if (disabled) throw new Error(disabled.message);
  const rows = await listReports(getOrgPg().sql, {
    ...args, workspaceId: activeWorkspaceId(), viewer: { isOwner: true },
  });
  return rows.map(toReportSummary);
}

export const reportsLineageArgs = z.object({ lineageId: z.string().min(1).max(400) }).strict();
export async function resolveReportsLineage(args: z.infer<typeof reportsLineageArgs>) {
  const disabled = await reportsLibraryDisabled();
  if (disabled) throw new Error(disabled.message);
  const rows = await listReportLineage(getOrgPg().sql, activeWorkspaceId(), args.lineageId, { isOwner: true });
  return rows.map(toReportSummary);
}
