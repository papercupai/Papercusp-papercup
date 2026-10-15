/** Organization-scoped administration of immutable WorkOS directory references. */
import { defineTool } from '@papercusp/agent-mcp';
import { isHostedPrincipal } from '../../auth/hosted-principal';
import type { RefusalContract } from '../../capability-envelope/refusal-contract-types';
import type {
  HostedDirectoryBindingManager, DirectoryBindingInput, DirectoryGroupMappingInput, DirectoryProvisionInput,
} from '../../auth/hosted/governance';

export const HOSTED_DIRECTORY_BINDING_ROUTES = [
  { method: 'PUT', path: '/hosted/organizations/:organizationId/members/:userId/directory-binding', access: 'authenticated' },
  { method: 'DELETE', path: '/hosted/organizations/:organizationId/members/:userId/directory-binding', access: 'authenticated' },
  { method: 'POST', path: '/hosted/organizations/:organizationId/members/access-review', access: 'authenticated' },
  { method: 'POST', path: '/hosted/organizations/:organizationId/members/:userId/reduce-access', access: 'authenticated' },
  { method: 'PUT', path: '/hosted/organizations/:organizationId/directory-group-mappings', access: 'authenticated' },
  { method: 'DELETE', path: '/hosted/organizations/:organizationId/directory-group-mappings', access: 'authenticated' },
  { method: 'POST', path: '/hosted/organizations/:organizationId/members/directory-provision', access: 'authenticated' },
] as const;

const NO_STORE = { 'cache-control': 'no-store' } as const;

function directoryBindingAuthorizationRefusal(
  organizationMatches: boolean,
  hasMembersManage: boolean,
): RefusalContract {
  return {
    observed: {
      organizationMatches: String(organizationMatches),
      membersManage: String(hasMembersManage),
    },
    liftsWhen:
      'the hosted session is scoped to the organization in the path and its permissions include members:manage',
    whoCanMakeItTrue: ['self', 'owner', 'host'],
  };
}

/** Refusal codes keep their own meaning; anything unrecognised is an outage,
 * never a leak of an internal message. */
function directoryAdministrationStatus(code: string, prefix: 'directory_group_mapping' | 'directory_provision'): number {
  if (code === `${prefix}_forbidden` || code === `${prefix}_forbidden_role`) return 403;
  if (/_not_found$/.test(code) || code === `${prefix}_organization_not_found`) return 404;
  if (['directory_provision_membership_exists', 'directory_provision_not_observed', 'directory_provision_no_mapped_group',
    'directory_group_mapping_convergence_limit', 'directory_binding_subject_conflict', 'directory_binding_inactive'].includes(code)) return 409;
  if (code.startsWith(`${prefix}_invalid:`) || code.startsWith('hosted-governance:')) return 400;
  return 503;
}

export function createHostedDirectoryBindingRoutes(manager: HostedDirectoryBindingManager) {
  return HOSTED_DIRECTORY_BINDING_ROUTES.map((route) => defineTool({
    method: route.method, path: route.path,
    auth: { capabilities: ['members:manage'], kind: ['user'], trust: ['verified'] },
    async handler(request, ctx) {
      const principal = ctx.principal;
      if (!principal || !isHostedPrincipal(principal)) return Response.json({ error: { code: 'hosted_principal_required' } }, { status: 401 });
      const organizationId = String(ctx.params.organizationId ?? '');
      if (principal.activeOrganizationId !== organizationId || !principal.permissions.has('members:manage')) {
        return Response.json({
          error: {
            code: 'directory_binding_forbidden',
            refusal: directoryBindingAuthorizationRefusal(
              principal.activeOrganizationId === organizationId,
              principal.permissions.has('members:manage'),
            ),
          },
        }, { status: 403 });
      }
      let body: Record<string, unknown>;
      try {
        const value = await request.json();
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json');
        body = value;
      } catch { return Response.json({ error: { code: 'invalid_json' } }, { status: 400 }); }
      if (route.path.endsWith('/directory-group-mappings')) {
        const allowed = route.method === 'PUT' ? ['directoryId', 'groupId', 'role', 'purpose'] : ['directoryId', 'groupId', 'purpose'];
        if (Object.keys(body).some((key) => !allowed.includes(key))) {
          return Response.json({ error: { code: 'directory_group_mapping_invalid:fields' } }, { status: 400, headers: NO_STORE });
        }
        const input = { organizationId, directoryId: body.directoryId, groupId: body.groupId, purpose: body.purpose } as
          Omit<DirectoryGroupMappingInput, 'role'>;
        try {
          const mapping = route.method === 'PUT'
            ? await manager.setGroupMapping(principal, { ...input, role: body.role } as DirectoryGroupMappingInput)
            : await manager.removeGroupMapping(principal, input);
          return Response.json({ ok: true, mapping }, { headers: NO_STORE });
        } catch (cause) {
          const code = cause instanceof Error ? cause.message : 'directory_group_mapping_failed';
          const status = directoryAdministrationStatus(code, 'directory_group_mapping');
          return Response.json({ error: { code: status === 503 ? 'directory_group_mapping_unavailable' : code } },
            { status, headers: NO_STORE });
        }
      }
      if (route.path.endsWith('/directory-provision')) {
        if (Object.keys(body).some((key) => !['userId', 'directoryId', 'directoryUserId', 'purpose'].includes(key))) {
          return Response.json({ error: { code: 'directory_provision_invalid:fields' } }, { status: 400, headers: NO_STORE });
        }
        try {
          const provisioned = await manager.provisionFromDirectory(principal, {
            organizationId, userId: body.userId, directoryId: body.directoryId, directoryUserId: body.directoryUserId, purpose: body.purpose,
          } as DirectoryProvisionInput);
          return Response.json({ ok: true, provisioned }, { headers: NO_STORE });
        } catch (cause) {
          const code = cause instanceof Error ? cause.message : 'directory_provision_failed';
          const status = directoryAdministrationStatus(code, 'directory_provision');
          return Response.json({ error: { code: status === 503 ? 'directory_provision_unavailable' : code } },
            { status, headers: NO_STORE });
        }
      }
      if (route.path.endsWith('/reduce-access')) {
        if (Object.keys(body).some((key) => !['status', 'purpose'].includes(key))) {
          return Response.json({ error: { code: 'membership_reduction_invalid:fields' } }, { status: 400 });
        }
        try {
          const membership = await manager.reduceMembership(principal, {
            organizationId, userId: String(ctx.params.userId ?? ''),
            status: body.status as 'suspended' | 'revoked', purpose: body.purpose as string,
          });
          return Response.json({ ok: true, membership }, { headers: { 'cache-control': 'no-store' } });
        } catch (cause) {
          const code = cause instanceof Error ? cause.message : 'membership_reduction_failed';
          const status = code === 'membership_reduction_forbidden' ? 403
            : code === 'membership_reduction_restore_forbidden' ? 409
            : ['membership_reduction_member_not_found', 'membership_reduction_organization_not_found'].includes(code) ? 404
            : /^membership_reduction_invalid:/.test(code) || /^hosted-governance:/.test(code) ? 400 : 503;
          return Response.json({ error: { code: status === 503 ? 'membership_reduction_unavailable' : code } },
            { status, headers: { 'cache-control': 'no-store' } });
        }
      }
      if (route.method === 'POST') {
        try {
          const review = await manager.review(principal, { organizationId, purpose: body.purpose as string });
          return Response.json({ ok: true, review }, { headers: {
            'cache-control': 'no-store', 'content-disposition': 'attachment; filename="directory-access-review.json"',
          } });
        } catch (cause) {
          const code = cause instanceof Error ? cause.message : 'directory_access_review_failed';
          const status = code === 'directory_access_review_forbidden' ? 403
            : code === 'directory_access_review_organization_not_found' ? 404
            : code === 'directory_access_review_member_limit' || code === 'directory_access_review_identity_limit' ? 409
            : /^directory_access_review_invalid:/.test(code) || /^hosted-governance:/.test(code) ? 400 : 503;
          return Response.json({ error: { code: status === 503 ? 'directory_access_review_unavailable' : code } },
            { status, headers: { 'cache-control': 'no-store' } });
        }
      }
      const input = {
        organizationId, userId: String(ctx.params.userId ?? ''), externalOrganizationId: body.externalOrganizationId,
        directoryId: body.directoryId, directoryUserId: body.directoryUserId, authorizedGroupIds: body.authorizedGroupIds,
        purpose: body.purpose,
      } as DirectoryBindingInput;
      try {
        const binding = route.method === 'DELETE' ? await manager.remove(principal, input) : await manager.set(principal, input);
        return Response.json({ ok: true, binding });
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : 'directory_binding_failed';
        const status = /forbidden|organization_mismatch/.test(code) ? 403 : /not_found/.test(code) ? 404
          : /subject_conflict|inactive/.test(code) ? 409 : cause instanceof TypeError || /hosted-governance/.test(code) ? 400 : 503;
        return Response.json({ error: { code: status === 503 ? 'directory_binding_unavailable' : code } }, { status });
      }
    },
  }));
}
