/** D-053: explicit service-only usage grant, separate from identity reads. */
import { defineTool, AGENT_ROLES, type KernelEnforcementRequest } from '@papercusp/agent-mcp';
import { HostedLeadUsageService, hostedLeadUsageInputSchema } from '../../auth/hosted-lead-usage';
import { isCodingAgentRole } from '../../personal-vault/coding-roles';

export default defineTool({
  name: 'people:usage',
  description: 'Read consented hosted product observations for one exact canonical PER- id and a window of at most 30 days. ' +
    'Requires an authenticated connected-app service bearer and an exact people:usage grant on both parent key and token. ' +
    'Broad people:* grants do not authorize this read. Current binding, membership and consent are rechecked around vendor reads. ' +
    'Returns { ok, usage }: observed counts with opaque bindingRef/evidenceRef, or unknown with a reason. No score, hosted identity ids or inferred consent.',
  guidance: {
    when: 'An explicitly authorized background collector needs original consented hosted usage for a canonically bound person.',
    notWhen: 'For person identity use people:get; this does not grant communication consent or measure customer-runtime activity.',
  },
  // The role-tool branch preserves UnifiedToolContext. The legacy
  // principal-gated branch substitutes ToolContext and loses dispatch fields;
  // require the verified service explicitly below and in the exact-grant seat.
  capability: 'intel:read', requirePrincipal: false, agentRoles: [...AGENT_ROLES],
  args: hostedLeadUsageInputSchema,
  async handler(args, ctx) {
    const unknown = (reason: string) => ({ data: { ok: true, usage: { status: 'unknown' as const, reason } } });
    if (isCodingAgentRole(ctx.role)) return unknown('coding_agent_denied');
    const principal = ctx.principal;
    if (!principal || principal.kind !== 'service' || principal.trust !== 'verified' ||
        principal.authMethod !== 'bearer-token') return unknown('service_required');
    const graphWorkspaceId = process.env.PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID?.trim();
    if (!graphWorkspaceId || graphWorkspaceId === '*') return unknown('host_not_configured');
    if (ctx.workspaceId !== graphWorkspaceId || principal.workspaceId !== graphWorkspaceId) return unknown('authority_unavailable');
    // Same server-owned environment selection as hosted-runtime and the
    // operator binding issuer. Request JSON cannot select another environment.
    const environment = process.env.PORT === '3170' ? 'staging' : process.env.NODE_ENV === 'production' ? 'production' : 'development';
    const request: KernelEnforcementRequest = {
      phase: 'enforce', boundary: ctx.kernelBoundary ?? ctx.dispatchBoundary ?? 'dispatch',
      toolName: 'people:usage', capabilities: ['intel:read'], args, ctx,
    };
    const usage = await new HostedLeadUsageService({ graphWorkspaceId, environment }).read(args, request);
    return { data: { ok: true, usage } };
  },
});
