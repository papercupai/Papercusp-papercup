/** Operator-side issuance is intentionally outside the hosted browser manifest. */
import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef/define-tool';
import { resolveSessionToken } from '../../auth';
import { hostedLeadBindingIssuerRef } from '../../auth/hosted-lead-binding-authority';
import type { HostedLeadBindingScope } from '../../auth/hosted-lead-binding';
import type { HostedLeadBindingService } from '../../auth/hosted-lead-binding-service';
import { exactOriginOr403, jsonError } from '../hosted-browser-context';

const inputSchema = z.object({ personRef: z.string().regex(/^PER-[A-Za-z0-9-]{1,160}$/) }).strict();
export function createOperatorLeadBindingRoute(config: {
  origin: string; graphWorkspaceId: string; environment: HostedLeadBindingScope['environment'];
  service: Pick<HostedLeadBindingService, 'issue'>;
  resolveOperatorSession?: typeof resolveSessionToken;
}) {
  return defineTool({
    method: 'POST', path: '/operator/lead-binding/challenge',
    auth: { kind: ['user'], trust: ['verified'], capabilities: ['*'] }, sampleRate: 0,
    async handler(request, ctx) {
      const principal = ctx.principal;
      if (!principal || principal.kind !== 'user' || principal.trust !== 'verified' ||
          principal.authMethod !== 'cookie-session' || !principal.capabilities.has('*') ||
          principal.workspaceId !== config.graphWorkspaceId) return jsonError('operator_session_required', 403);
      const originError = exactOriginOr403(request, config.origin);
      if (originError) return originError;
      const parsed = inputSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return jsonError('lead_binding_invalid_request', 400);
      try {
        const session = await (config.resolveOperatorSession ?? resolveSessionToken)(request.headers);
        if (!session) return jsonError('operator_session_required', 403);
        const token = await config.service.issue({ graphWorkspaceId: config.graphWorkspaceId,
          personRef: parsed.data.personRef, environment: config.environment }, hostedLeadBindingIssuerRef(session));
        return token ? Response.json({ token }, { headers: { 'cache-control': 'no-store' } })
          : jsonError('lead_binding_issue_refused', 403);
      } catch {
        return jsonError('lead_binding_service_unavailable', 503);
      }
    },
  });
}
