/** The existing loopback owner perimeter is the publication authority. Visitors
 * only use Pages/GitHub; this route never accepts credentials, Gist IDs or scope. */
import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef/define-tool';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getReport } from '../../../report-library';
import { changeReportSharing, reportSharingGithub, ReportSharingError } from '../../../report-sharing';
import { postgresReportShareStore } from '../../../report-sharing-store';
import { notifySyncInvalidate } from '../../../sync-sse';

export const reportSharingInput = z.object({ reportId: z.string().min(1).max(400),
  accountId: z.number().int().positive(), action: z.enum(['share','stop']) }).strict();

export async function reportSharingStatus(reportId: string) {
  const sql = getOrgPg().sql;
  const report = await getReport(sql, activeWorkspaceId(), reportId, { isOwner: true });
  if (!report) return [];
  const github = await reportSharingGithub();
  const user = await github.user();
  return [await changeReportSharing({report,accountId:user.id,action:'status'}, {github,store:postgresReportShareStore(sql)})];
}

export default defineTool({
  method:'POST',path:'/reports/sharing',auth:'loopback',input:reportSharingInput,
  async handler(_req,ctx) {
    const input=ctx.input;
    try {
      const sql=getOrgPg().sql;
      const report=await getReport(sql,activeWorkspaceId(),input.reportId,{isOwner:true});
      if (!report) return Response.json({error:'This report is unavailable in the current workspace.'},{status:404});
      const github=await reportSharingGithub();
      const sharing=await changeReportSharing({...input,report},{github,store:postgresReportShareStore(sql)});
      await notifySyncInvalidate('reports.sharing',{reportId:input.reportId});
      return Response.json({ok:true,sharing});
    } catch(error) {
      if(error instanceof ReportSharingError) return Response.json({code:error.code,error:error.message},{status:409});
      const status=error && typeof error==='object' && 'status' in error ? error.status : null;
      // Never forward an Octokit error, request, token, response body or stack.
      const message=status===401 ? 'GitHub sign-in expired. Sign in again and retry.'
        : status===403 ? 'GitHub refused this action. Check Gist, repository and Pages permissions or retry after the rate limit resets.'
        : status===429 ? 'GitHub is limiting requests. Retry later.'
        : 'Sharing could not be confirmed. Retry to reconcile the saved operation.';
      return Response.json({code:'github_unavailable',error:message},{status:503});
    }
  },
});
