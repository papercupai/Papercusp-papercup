/** Operator-side issuance is intentionally outside the hosted browser manifest. */
import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef/define-tool';
import { resolveSessionToken } from '../../auth';
import { createPostgresHostedLeadBindingService, hostedLeadBindingIssuerRef } from '../../auth/hosted-lead-binding-authority';
import { resolveSecretRef } from '../../inference-gateway/egress-providers/secret-ref';
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

/** The ordinary operator registry uses the SAME existing host configuration
 * as hosted-runtime. No request-origin inference or alternate signing key. */
export default defineTool({
  method: 'POST', path: '/operator/lead-binding/challenge',
  auth: { kind: ['user'], trust: ['verified'], capabilities: ['*'] }, sampleRate: 0,
  async handler(request, ctx) {
    const origin = process.env.PAPERCUSP_HOSTED_PUBLIC_ORIGIN?.trim();
    const graphWorkspaceId = process.env.PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID?.trim();
    const secretRef = process.env.PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF?.trim();
    if (!origin || !graphWorkspaceId || graphWorkspaceId === '*' || !secretRef) return jsonError('lead_binding_host_not_configured', 503);
    try {
      if (new URL(origin).origin !== origin || !origin.startsWith('https://')) return jsonError('lead_binding_host_not_configured', 503);
      // Refuse unauthorized/cross-origin callers before dereferencing a secret.
      if (!ctx.principal || ctx.principal.kind !== 'user' || ctx.principal.trust !== 'verified' ||
          ctx.principal.authMethod !== 'cookie-session' || !ctx.principal.capabilities.has('*') ||
          ctx.principal.workspaceId !== graphWorkspaceId) return jsonError('operator_session_required', 403);
      const denied = exactOriginOr403(request, origin);
      if (denied) return denied;
      const environment = process.env.PORT === '3170' ? 'staging' : process.env.NODE_ENV === 'production' ? 'production' : 'development';
      return createOperatorLeadBindingRoute({ origin, graphWorkspaceId, environment,
        service: createPostgresHostedLeadBindingService({ graphWorkspaceId, environment, secret: await resolveSecretRef(secretRef) }),
      }).handler(request, ctx);
    } catch {
      return jsonError('lead_binding_service_unavailable', 503);
    }
  },
});
