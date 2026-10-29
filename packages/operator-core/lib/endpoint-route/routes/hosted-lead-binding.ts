/** D-052: the browser may redeem a signed operator challenge for itself.
 * It cannot issue challenges or name the hosted user/organization to bind. */
import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef/define-tool';
import type { HostedLeadBindingService } from '../../auth/hosted-lead-binding-service';
import type { HostedLeadBindingScope } from '../../auth/hosted-lead-binding';
import { isHostedPrincipal } from '../../auth/hosted-principal';
import { exactOriginOr403, jsonError, workspaceHeaderMismatch } from '../hosted-browser-context';

export const HOSTED_LEAD_BINDING_ROUTES = [
  { method: 'POST', path: '/hosted/browser/lead-binding/redeem', access: 'authenticated' },
  { method: 'GET', path: '/hosted/browser/lead-binding', access: 'authenticated' },
  { method: 'DELETE', path: '/hosted/browser/lead-binding', access: 'authenticated' },
] as const;
const scopeSchema = z.object({
  graphWorkspaceId: z.string().min(1).max(200).refine(value => value.trim() === value && value !== '*'),
  personRef: z.string().regex(/^PER-[A-Za-z0-9-]{1,160}$/),
}).strict();
const redeemSchema = scopeSchema.extend({ token: z.string().min(1).max(4096) }).strict();

export function createHostedLeadBindingRoutes(config: {
  origin: string; controlPlaneWorkspaceId: string;
  environment: HostedLeadBindingScope['environment'];
  service: Pick<HostedLeadBindingService, 'redeem' | 'read' | 'revoke'>;
}) {
  return HOSTED_LEAD_BINDING_ROUTES.map(route => defineTool({
    method: route.method, path: route.path,
    auth: { capabilities: ['workspace:view'], kind: ['user'], trust: ['verified'] },
    cors: { origins: [config.origin] }, sampleRate: 0,
    async handler(request, ctx) {
      const principal = ctx.principal;
      if (!principal || !isHostedPrincipal(principal)) return jsonError('hosted_principal_required', 401);
      if (!principal.permissions.has('workspace:view')) return jsonError('permission_missing', 403);
      if (principal.workspaceId !== config.controlPlaneWorkspaceId) return jsonError('control_plane_binding_mismatch', 403);
      const headerError = workspaceHeaderMismatch(request, principal, config.controlPlaneWorkspaceId);
      if (headerError) return headerError;
      if (route.method !== 'GET') {
        const originError = exactOriginOr403(request, config.origin);
        if (originError) return originError;
      }
      // Environment is server-owned. Strict schemas reject supplied user/org,
      // issuer, consent and environment instead of silently accepting them.
      const input: unknown = route.method === 'GET'
        ? Object.fromEntries(new URL(request.url).searchParams)
        : await request.json().catch(() => null);
      const parsed = (route.method === 'POST' ? redeemSchema : scopeSchema).safeParse(input);
      if (!parsed.success) return jsonError('lead_binding_invalid_request', 400);
      const scope = { graphWorkspaceId: parsed.data.graphWorkspaceId, personRef: parsed.data.personRef,
        environment: config.environment };
      try {
        if (route.method === 'DELETE') {
          const revoked = await config.service.revoke(scope, principal);
          return revoked ? Response.json({ revoked: true }, { headers: { 'cache-control': 'no-store' } })
            : jsonError('lead_binding_unavailable', 404);
        }
        const receipt = route.method === 'POST'
          ? await config.service.redeem(scope, (parsed.data as z.infer<typeof redeemSchema>).token, principal)
          : await config.service.read(scope, principal);
        return receipt ? Response.json({ receipt }, { headers: { 'cache-control': 'no-store' } })
          : jsonError('lead_binding_unavailable', 404);
      } catch {
        // Never expose token, SQL errors, identity ids or existence of another
        // user's receipt through an internal exception.
        return jsonError('lead_binding_service_unavailable', 503);
      }
    },
  }));
}
