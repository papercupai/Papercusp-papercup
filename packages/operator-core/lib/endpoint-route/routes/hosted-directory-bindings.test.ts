import { describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';
import { createHostedPrincipal, type HostedPrincipal } from '../../auth/hosted-principal';
import type { HostedDirectoryBindingManager, DirectoryBindingInput } from '../../auth/hosted/governance';
import { createHostedDirectoryBindingRoutes } from './hosted-directory-bindings';

function context(organizationId = 'org', permissions = ['members:manage']): RouteContext {
  return { principal: createHostedPrincipal({ workspaceId: 'control', userId: 'admin', activeOrganizationId: 'org',
    sessionId: 'session', sessionVersion: 1, permissions }), params: { organizationId, userId: 'member' },
    input: undefined, log: () => {}, signal: new AbortController().signal };
}
const body = { externalOrganizationId: 'workos-org', directoryId: 'dir', directoryUserId: 'dsync-user',
  authorizedGroupIds: ['group'], purpose: 'Approved mapping', organizationId: 'foreign', userId: 'foreign-user', role: 'owner' };
const request = (method: string, payload = body) => new Request('https://app.papercusp.com/api/hosted/organizations/org/members/member/directory-binding',
  { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

describe('hosted directory binding routes', () => {
  it('passes only path-bound target and requested reduction to the manager', async () => {
    const reduceMembership = vi.fn(async () => ({ membershipId: 'membership', status: 'suspended', auditId: 'audit', changed: true }));
    const route = createHostedDirectoryBindingRoutes({ reduceMembership } as unknown as HostedDirectoryBindingManager)[3];
    const response = await route.handler(request('POST', { status: 'suspended', purpose: 'Remove access' } as never), context());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(reduceMembership.mock.calls[0]).toEqual([context().principal,
      { organizationId: 'org', userId: 'member', status: 'suspended', purpose: 'Remove access' }]);
    expect(await response.json()).toMatchObject({ ok: true, membership: { status: 'suspended', changed: true } });
  });
  it('rejects foreign/unauthorized reductions and body authority overrides before calling the manager', async () => {
    const reduceMembership = vi.fn();
    const route = createHostedDirectoryBindingRoutes({ reduceMembership } as unknown as HostedDirectoryBindingManager)[3];
    expect((await route.handler(request('POST'), context('foreign'))).status).toBe(403);
    expect((await route.handler(request('POST'), context('org', ['workspace:view']))).status).toBe(403);
    expect((await route.handler(request('POST'), context())).status).toBe(400);
    expect(reduceMembership).not.toHaveBeenCalled();
  });
  it.each([
    ['membership_reduction_forbidden', 403], ['membership_reduction_restore_forbidden', 409],
    ['membership_reduction_member_not_found', 404], ['membership_reduction_organization_not_found', 404],
    ['membership_reduction_invalid:status', 400], ['database credential=internal-secret', 503],
  ])('maps reduction %s without leaking internal failure details', async (code, status) => {
    const route = createHostedDirectoryBindingRoutes({ reduceMembership: vi.fn().mockRejectedValue(new TypeError(code)) } as unknown as HostedDirectoryBindingManager)[3];
    const response = await route.handler(request('POST', { status: 'revoked', purpose: 'Remove access' } as never), context());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code: status === 503 ? 'membership_reduction_unavailable' : code } });
  });
  it('exports only the session/path organization with no-store download headers', async () => {
    const review = vi.fn(async (_principal: HostedPrincipal, _input: { organizationId: string; purpose: string }) => ({ members: [], auditId: 'audit' }));
    const route = createHostedDirectoryBindingRoutes({ review } as unknown as HostedDirectoryBindingManager)[2];
    const response = await route.handler(request('POST', { ...body, purpose: 'Quarterly review' }), context());
    expect(response.status).toBe(200);
    expect(review.mock.calls[0]?.[1]).toEqual({ organizationId: 'org', purpose: 'Quarterly review' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toContain('directory-access-review.json');
    expect(await response.json()).toEqual({ ok: true, review: { members: [], auditId: 'audit' } });
  });

  it('rejects unauthorized access review before calling the manager', async () => {
    const review = vi.fn();
    const route = createHostedDirectoryBindingRoutes({ review } as unknown as HostedDirectoryBindingManager)[2];
    expect((await route.handler(request('POST'), context('foreign'))).status).toBe(403);
    expect((await route.handler(request('POST'), context('org', ['workspace:view']))).status).toBe(403);
    expect(review).not.toHaveBeenCalled();
  });

  it('conceals unexpected TypeError details instead of treating all TypeErrors as input failures', async () => {
    const review = vi.fn().mockRejectedValue(new TypeError('credential=internal-secret'));
    const route = createHostedDirectoryBindingRoutes({ review } as unknown as HostedDirectoryBindingManager)[2];
    const response = await route.handler(request('POST'), context());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'directory_access_review_unavailable' } });
  });

  it.each([
    ['directory_access_review_forbidden', 403], ['directory_access_review_organization_not_found', 404],
    ['directory_access_review_member_limit', 409], ['directory_access_review_identity_limit', 409],
    ['database query credential=internal-secret', 503],
  ])('maps access-review %s without exposing internal failures', async (code, status) => {
    const review = vi.fn().mockRejectedValue(new Error(code));
    const route = createHostedDirectoryBindingRoutes({ review } as unknown as HostedDirectoryBindingManager)[2];
    const response = await route.handler(request('POST'), context());
    expect(response.status).toBe(status);
    if (status === 503) expect(await response.json()).toEqual({ error: { code: 'directory_access_review_unavailable' } });
  });
  it.each([0, 1])('rejects foreign organization and non-admin permissions on route %i before writes', async (index) => {
    const set = vi.fn(); const remove = vi.fn();
    const route = createHostedDirectoryBindingRoutes({ set, remove } as unknown as HostedDirectoryBindingManager)[index];
    expect((await route.handler(request(route.method), context('foreign'))).status).toBe(403);
    expect((await route.handler(request(route.method), context('org', ['workspace:view']))).status).toBe(403);
    expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });

  it('reports the exact organization and permission checks that lift a directory-binding refusal', async () => {
    const route = createHostedDirectoryBindingRoutes({ set: vi.fn() } as unknown as HostedDirectoryBindingManager)[0];
    const foreign = await route.handler(request('PUT'), context('foreign'));
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({
      error: {
        code: 'directory_binding_forbidden',
        refusal: {
          observed: { organizationMatches: 'false', membersManage: 'true' },
          liftsWhen: expect.stringContaining('members:manage'),
          whoCanMakeItTrue: ['self', 'owner', 'host'],
        },
      },
    });

    const unauthorized = await route.handler(request('PUT'), context('org', ['workspace:view']));
    expect(unauthorized.status).toBe(403);
    expect(await unauthorized.json()).toMatchObject({
      error: {
        code: 'directory_binding_forbidden',
        refusal: {
          observed: { organizationMatches: 'true', membersManage: 'false' },
          liftsWhen: expect.stringContaining('members:manage'),
          whoCanMakeItTrue: ['self', 'owner', 'host'],
        },
      },
    });
  });

  it.each([0, 1])('uses path/session tenant binding and excludes email, roles and body user overrides on route %i', async (index) => {
    const set = vi.fn(async (_principal: HostedPrincipal, _input: DirectoryBindingInput) => ({ identityId: 'identity', auditId: 'audit' }));
    const remove = vi.fn(async (_principal: HostedPrincipal, _input: DirectoryBindingInput) => ({ identityId: 'identity', auditId: 'audit' }));
    const route = createHostedDirectoryBindingRoutes({ set, remove } as unknown as HostedDirectoryBindingManager)[index];
    const response = await route.handler(request(route.method), context());
    expect(response.status).toBe(200);
    expect((index === 0 ? set : remove).mock.calls[0]?.[1]).toEqual({ organizationId: 'org', userId: 'member',
      externalOrganizationId: 'workos-org', directoryId: 'dir', directoryUserId: 'dsync-user', authorizedGroupIds: ['group'], purpose: 'Approved mapping' });
  });

  it('returns conflict for subject collision and conceals database errors', async () => {
    const set = vi.fn().mockRejectedValueOnce(new Error('directory_binding_subject_conflict'))
      .mockRejectedValueOnce(new Error('database query credential=internal-secret'));
    const route = createHostedDirectoryBindingRoutes({ set } as unknown as HostedDirectoryBindingManager)[0];
    expect((await route.handler(request('PUT'), context())).status).toBe(409);
    const failed = await route.handler(request('PUT'), context());
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: { code: 'directory_binding_unavailable' } });
  });

  const mappingRequest = (method: string, payload: Record<string, unknown>) => new Request(
    'https://app.papercusp.com/api/hosted/organizations/org/directory-group-mappings',
    { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const routeAt = (manager: Partial<HostedDirectoryBindingManager>, method: string, suffix: string) =>
    createHostedDirectoryBindingRoutes(manager as HostedDirectoryBindingManager)
      .find((route) => route.method === method && route.path.endsWith(suffix))!;

  it('binds group mappings to the path organization and refuses body authority overrides', async () => {
    const setGroupMapping = vi.fn(async () => ({ mappingId: 'm', status: 'active', revokedMembershipIds: [] }));
    const removeGroupMapping = vi.fn(async (_principal: unknown, _input: unknown) => ({ mappingId: 'm', status: 'removed', revokedMembershipIds: ['x'] }));
    const put = routeAt({ setGroupMapping } as never, 'PUT', '/directory-group-mappings');
    const del = routeAt({ removeGroupMapping } as never, 'DELETE', '/directory-group-mappings');
    const mapping = { directoryId: 'dir', groupId: 'group', role: 'member', purpose: 'Approve engineering' };
    const response = await put.handler(mappingRequest('PUT', mapping), context());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(setGroupMapping.mock.calls[0]).toEqual([context().principal, { organizationId: 'org', ...mapping }]);
    expect((await del.handler(mappingRequest('DELETE', { directoryId: 'dir', groupId: 'group', purpose: 'Retire' }), context())).status).toBe(200);
    expect(removeGroupMapping.mock.calls[0]?.[1]).toEqual({ organizationId: 'org', directoryId: 'dir', groupId: 'group', purpose: 'Retire' });
    // A role on DELETE, a foreign organization in the body, or a foreign session never reaches the manager.
    expect((await del.handler(mappingRequest('DELETE', { ...mapping }), context())).status).toBe(400);
    expect((await put.handler(mappingRequest('PUT', { ...mapping, organizationId: 'foreign' }), context())).status).toBe(400);
    expect((await put.handler(mappingRequest('PUT', mapping), context('foreign'))).status).toBe(403);
    expect((await put.handler(mappingRequest('PUT', mapping), context('org', ['workspace:view']))).status).toBe(403);
    expect(setGroupMapping).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['directory_group_mapping_forbidden_role', 403], ['directory_group_mapping_not_found', 404],
    ['directory_group_mapping_convergence_limit', 409], ['directory_group_mapping_invalid:role', 400],
    ['connection to db password=secret refused', 503],
  ])('maps group mapping refusal %s without leaking internals', async (code, status) => {
    const put = routeAt({ setGroupMapping: vi.fn().mockRejectedValue(new Error(code)) } as never, 'PUT', '/directory-group-mappings');
    const response = await put.handler(mappingRequest('PUT', { directoryId: 'd', groupId: 'g', role: 'admin', purpose: 'p' }), context());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code: status === 503 ? 'directory_group_mapping_unavailable' : code } });
  });

  it('provisions only the named directory user and maps refusals to stable codes', async () => {
    const provisionFromDirectory = vi.fn(async (_principal: unknown, _input: unknown) => ({ membershipId: 'mem', role: 'member', mappedGroupIds: ['g'] }));
    const post = routeAt({ provisionFromDirectory } as never, 'POST', '/members/directory-provision');
    const input = { userId: 'u', directoryId: 'dir', directoryUserId: 'du', purpose: 'Onboard' };
    const response = await post.handler(mappingRequest('POST', input), context());
    expect(response.status).toBe(200);
    expect(provisionFromDirectory.mock.calls[0]?.[1]).toEqual({ organizationId: 'org', ...input });
    expect((await post.handler(mappingRequest('POST', { ...input, role: 'admin' }), context())).status).toBe(400);
    expect(provisionFromDirectory).toHaveBeenCalledTimes(1);
    for (const [code, status] of [['directory_provision_membership_exists', 409], ['directory_provision_not_observed', 409],
      ['directory_provision_forbidden_role', 403], ['directory_provision_user_not_found', 404], ['boom', 503]] as const) {
      const failing = routeAt({ provisionFromDirectory: vi.fn().mockRejectedValue(new Error(code)) } as never, 'POST', '/members/directory-provision');
      const refused = await failing.handler(mappingRequest('POST', input), context());
      expect(refused.status).toBe(status);
      expect(await refused.json()).toEqual({ error: { code: status === 503 ? 'directory_provision_unavailable' : code } });
    }
  });
});
