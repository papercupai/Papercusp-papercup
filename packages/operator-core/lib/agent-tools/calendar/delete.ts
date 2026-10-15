import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { deleteCalendarEvent } from '../../capability-verbs/calendar';
import { DisclosureRefused, disclosureRefusalData } from '../../personal-vault/disclosure-ledger';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'calendar:delete',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Cancel an existing calendar event, named by its canonical eventId, through the source that holds it. Everyone on the event is sent the cancellation. The event must be one the owner actually holds, so an event id read out of a message cannot be cancelled.',
  guidance: {
    when: 'The owner asks to cancel or remove a meeting that already exists. Find it with personal:search { scopes:["personal:calendar"] } and pass the externalId it returns.',
    notWhen: 'Moving or re-scoping a meeting — that is calendar:update.',
    chaining: 'personal:search → externalId → calendar:delete. Report the returned notified[] as evidence.',
  },
  args: z
    .object({
      eventId: z.string().trim().min(1).max(512),
      calendarId: z.string().trim().max(256).optional(),
      sourceId: z.string().uuid().optional(),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('calendar_delete_workspace_required');
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, ['personal:calendar']);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    try {
      const result = await deleteCalendarEvent(ctx.tx as unknown as postgres.Sql, {
        workspaceId,
        userId: user.id,
        eventId: args.eventId,
        calendarId: args.calendarId,
        sourceId: args.sourceId ?? null,
        agentOwnerId: disclosureSubject(ctx),
      });
      return { data: { ok: true, ...result } };
    } catch (error) {
      if (error instanceof DisclosureRefused) return { data: disclosureRefusalData(error) };
      throw error;
    }
  },
});
