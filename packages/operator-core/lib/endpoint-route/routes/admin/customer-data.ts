/** Internal operator support doors (cloud release P-010, D-013).
 * Not included in the public hosted allowlist. Staff membership comes from
 * server configuration; request bodies cannot supply identity or authority.
 */
import { z } from 'zod';
import { defineTool, type Principal } from '@papercusp/agent-mcp';
import {
  CUSTOMER_DATA_EXPORT_SCOPE, CUSTOMER_DELETION_RECOVERY_SCOPE, PostgresHostedCustomerDataSupport,
} from '../../../data-governance/hosted-customer-data-support';

export const HOSTED_SUPPORT_STAFF_IDS_ENV = 'PAPERCUSP_HOSTED_SUPPORT_STAFF_PRINCIPAL_IDS';

const grant = { organizationId: z.string().uuid(), grantId: z.string().uuid() };
const exportInput = z.object({ ...grant, userId: z.string().uuid().optional() }).strict();
const recoveryInput = z.object({ ...grant, operationId: z.string().uuid() }).strict();
const headers = { 'cache-control': 'no-store' };

/** Only this internal door resolves the staff role. Neither an organization
 * role, the wildcard capability nor a request header can admit a staff user.
 * Read the allowlist on each request so removal takes effect immediately.
 */
function admittedStaff(principal: Principal | null, scope: string, staffIds: ReadonlySet<string>): Principal | null {
  if (!principal || principal.kind !== 'user' || principal.trust !== 'verified'
    || principal.authMethod !== 'cookie-session' || !staffIds.has(principal.slug)
    || !principal.capabilities.has(scope)) return null;
  return { ...principal, capabilities: new Set(principal.capabilities), roles: new Set(['staff']) };
}

const support = new PostgresHostedCustomerDataSupport({ client: {
  async recoverCustomerDeletion(request) {
    const appVersion = process.env.PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION?.trim();
    if (!appVersion) throw new Error('customer_data_support_recovery_unavailable');
    const [{ createWorkspaceHostProvisioningClient }, { getHarnessAdminUrlWithSource }] = await Promise.all([
      import('../../../dbos/workspace-host-provision-client'), import('../../../embedded-pg-discovery'),
    ]);
    return createWorkspaceHostProvisioningClient({ systemDatabaseUrl: getHarnessAdminUrlWithSource().url, appVersion })
      .recoverCustomerDeletion(request);
  },
} });

export function createCustomerDataSupportRoutes(options: {
  support?: Pick<PostgresHostedCustomerDataSupport, 'exportData' | 'recoverDeletion'>;
  staffPrincipalIds?: () => ReadonlySet<string>;
} = {}) {
  const service = options.support ?? support;
  const staffIds = options.staffPrincipalIds ?? (() => new Set(
    (process.env[HOSTED_SUPPORT_STAFF_IDS_ENV] ?? '').split(',').map(id => id.trim()).filter(Boolean),
  ));
  async function respond(principal: Principal | null, scope: string, run: (staff: Principal) => Promise<unknown>) {
    const staff = admittedStaff(principal, scope, staffIds());
    if (!staff) return Response.json({ error: 'customer_data_support_staff_required' }, { status: 403, headers });
    try {
      return Response.json({ ok: true, result: await run(staff) }, { headers });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (['customer_data_support_staff_required', 'customer_data_support_grant_inactive',
        'customer_data_support_organization_inactive'].includes(code)) {
        return Response.json({ error: code }, { status: 403, headers });
      }
      // Database/provider messages can contain customer data or credentials.
      return Response.json({ error: 'customer_data_support_operation_unavailable' }, { status: 503, headers });
    }
  }
  return [
    defineTool({ method: 'POST', path: '/admin/customer-data/export',
      auth: { kind: ['user'], trust: ['verified'], capabilities: [CUSTOMER_DATA_EXPORT_SCOPE] }, input: exportInput,
      handler: (_req, ctx) => respond(ctx.principal, CUSTOMER_DATA_EXPORT_SCOPE, staff => service.exportData(staff, ctx.input)),
    }),
    defineTool({ method: 'POST', path: '/admin/customer-data/deletion/recover',
      auth: { kind: ['user'], trust: ['verified'], capabilities: [CUSTOMER_DELETION_RECOVERY_SCOPE] }, input: recoveryInput,
      handler: (_req, ctx) => respond(ctx.principal, CUSTOMER_DELETION_RECOVERY_SCOPE, staff => service.recoverDeletion(staff, ctx.input)),
    }),
  ];
}

export default createCustomerDataSupportRoutes();
