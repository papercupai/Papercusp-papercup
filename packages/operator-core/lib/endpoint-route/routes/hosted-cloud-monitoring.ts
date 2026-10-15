import { defineTool } from '@papercusp/tooldef/define-tool';
import type { VerifiedTenantServerContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { isHostedPrincipal } from '../../auth/hosted-principal';
import { getBuildInfo } from '../../build-info';
import { readCloudTelemetryConsent, writeCloudTelemetryConsent, type CloudTelemetryContext } from '../../cloud-telemetry';
import { cloudTelemetryConsentUpdateSchema, cloudTelemetryEventSchema } from '../../telemetry-kinds';
import { exactOriginOr403, jsonError, workspaceHeaderMismatch } from '../hosted-browser-context';

export const HOSTED_BROWSER_MONITORING_PATH = '/hosted/browser/monitoring' as const;
export const HOSTED_BROWSER_MONITORING_EVENT_PATH = '/hosted/browser/monitoring/event' as const;

/** Extend the existing scoped hosted preference surface; do not expose desktop
 * consent or keys to hosted browsers. The same verified tenant runner checks
 * membership/session validity before every read, update and delivery. */
export function createHostedCloudMonitoringRoutes({ origin, controlPlaneWorkspaceId, runTenant, deliver }: {
  origin: string; controlPlaneWorkspaceId: string;
  runTenant: <T>(context: VerifiedTenantServerContext, fn: (tx: Sql) => Promise<T>) => Promise<T>;
  deliver?: (input: unknown, context: CloudTelemetryContext, readConsent: () => Promise<unknown>) => Promise<{ delivered: boolean; code?: string }>;
}) {
  return (['GET', 'POST', 'event'] as const).map(operation => defineTool({
    method: operation === 'GET' ? 'GET' : 'POST',
    path: operation === 'event' ? HOSTED_BROWSER_MONITORING_EVENT_PATH : HOSTED_BROWSER_MONITORING_PATH,
    auth: { capabilities: [], kind: ['user'], trust: ['verified'] }, cors: { origins: [origin] }, sampleRate: 0,
    async handler(request, ctx) {
      const principal = ctx.principal;
      if (!principal || !isHostedPrincipal(principal)) return jsonError('hosted_principal_required', 401);
      if (principal.workspaceId !== controlPlaneWorkspaceId) return jsonError('control_plane_binding_mismatch', 403);
      const mismatch = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (mismatch) return mismatch;
      if (operation !== 'GET') {
        const csrf = exactOriginOr403(request, origin);
        if (csrf) return csrf;
      }
      const account: VerifiedTenantServerContext = { principal: {
        kind: 'user', profile: 'hosted', authMethod: 'cookie-session', trust: 'verified', slug: principal.userId,
        workspaceId: principal.workspaceId, userId: principal.userId, activeOrganizationId: principal.activeOrganizationId,
        sessionId: principal.sessionId, sessionVersion: principal.sessionVersion,
      } };
      try {
        if (operation === 'GET') {
          const consent = await runTenant(account, tx => readCloudTelemetryConsent(tx, principal));
          return Response.json({ consent }, { headers: { 'cache-control': 'no-store' } });
        }
        const input = await request.json().catch(() => null);
        if (operation === 'POST') {
          const parsed = cloudTelemetryConsentUpdateSchema.safeParse(input);
          if (!parsed.success) return jsonError('invalid_monitoring_choice', 400);
          if (parsed.data.diagnostics === true && !principal.permissions.has('members:manage')) {
            return jsonError('diagnostic_export_admin_required', 403);
          }
          const consent = await runTenant(account, tx => writeCloudTelemetryConsent(tx, principal, parsed.data));
          return Response.json({ consent }, { headers: { 'cache-control': 'no-store' } });
        }
        const parsed = cloudTelemetryEventSchema.safeParse(input);
        if (!parsed.success) return jsonError('invalid_cloud_event', 400);
        // This endpoint witnesses browser metadata only. A customer aggregate
        // requires its own selected-workspace export surface, and provisioning
        // outcomes require the server lifecycle witness.
        if (['cloud_diagnostic_aggregate', 'cloud_workspace_provisioning'].includes(parsed.data.event)) {
          return jsonError('unwitnessed_outcome', 400);
        }
        if (parsed.data.event === 'product_tutorial' && parsed.data.properties.action === 'explanation_reviewed') {
          return jsonError('unwitnessed_outcome', 400);
        }
        const sender = deliver ?? (await import('../../cloud-telemetry-posthog')).deliverCloudPosthog;
        const context: CloudTelemetryContext = { principal,
          environment: process.env.PORT === '3170' ? 'staging' : process.env.NODE_ENV === 'production' ? 'production' : 'development',
          release: getBuildInfo().sha ?? '', origin: 'portal', hostingMode: 'byoc' };
        const result = await sender(parsed.data, context, () => runTenant(account, tx => readCloudTelemetryConsent(tx, principal)));
        // Optional analytics cannot turn a completed product action into a failure.
        return Response.json(result, { status: 202, headers: { 'cache-control': 'no-store' } });
      } catch { return operation === 'event'
        ? Response.json({ delivered: false, code: 'delivery_unavailable' }, { status: 202 })
        : jsonError('monitoring_preferences_unavailable', 503); }
    },
  }));
}
