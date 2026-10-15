import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { fileTicketFromPlanRun, TicketFilingError, TICKET_FIELD_MAX, TICKET_REASON_MAX, TICKET_TITLE_MAX } from '../../capability-verbs/ticket';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

/** Provider-neutral ticket filing for trigger-pack workflows (cupboard-distributable-integrations-2026-10-10 D-012). */
export default defineTool({
  name: 'ticket:file', needsWorkspaceTx: false, profile: 'engineer',
  capability: 'operator:write', requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description: 'Record your trigger-pack run classification and file only bug verdicts at its installation destination. Non-bug and needs-information verdicts are durable and never call a provider. Existing filing calls default to bug; replays never file twice.',
  guidance: {
    when: 'A trigger-pack workflow classified its own plan run as bug, non-bug, or needs-information.',
    notWhen: 'Choosing or changing the destination, ad-hoc tickets outside a trigger-pack run, or re-filing after a pending result.',
    chaining: 'Keep externalRef as proof. pendingReconciliation means retry later with the same planRunId; it never re-creates.',
  },
  args: z.object({
    planRunId: z.number().int().positive(),
    classification: z.enum(['bug', 'non-bug', 'needs-information']).default('bug'),
    reason: z.string().max(TICKET_REASON_MAX).optional(),
    title: z.string().min(1).max(TICKET_TITLE_MAX).optional(),
    observed: z.string().max(TICKET_FIELD_MAX).optional(),
    expected: z.string().max(TICKET_FIELD_MAX).optional(),
  }).strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('ticket_file_workspace_required');
    try {
      return { data: { ok: true, ...await fileTicketFromPlanRun(getOrgPg().sql, { workspaceId, ...args }) } };
    } catch (error) {
      if (error instanceof TicketFilingError) return { data: { ok: false, code: error.code, message: error.message } };
      throw error;
    }
  },
});
