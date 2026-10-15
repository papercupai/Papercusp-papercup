import { describe, expect, it } from 'vitest';
import { isHostedPrincipal } from './hosted-principal';
import type { HostedMembershipAuthority, HostedMembershipAuthorityReader } from './hosted-membership-authority';
import { hostedPermissionsForMembership } from './hosted-role-permissions';
import type { HostedSession } from './hosted-session';
import {
  createHostedPrincipalResolver,
  createHostedChannelPrincipalResolver,
  hostedSessionAuthorizationState,
  type HostedPrincipalResolverDependencies,
} from './hosted-principal-resolver';

const CONTROL_PLANE_WORKSPACE = 'papercusp-control-plane';
const SESSION_ID = `hs_${'A'.repeat(43)}`;
const NOW = new Date('2026-08-27T12:00:00.000Z');

const TENANT_A = {
  userId: '11111111-1111-4111-8111-111111111111',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspaceId: 'cw-tenant-a',
};
const TENANT_B = {
  userId: '22222222-2222-4222-8222-222222222222',
  organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workspaceId: 'cw-tenant-b',
};

const AUTHORITY_VERSION = 1_756_296_000;

function session(overrides: Partial<HostedSession> = {}): HostedSession {
  return {
    id: SESSION_ID,
    userId: TENANT_A.userId,
    organizationId: TENANT_A.organizationId,
    workspaceId: null,
    permissionVersion: AUTHORITY_VERSION,
    upstreamProvider: 'workos',
    upstreamSessionId: 'upstream-session-1',
    createdAt: NOW,
    rotatedAt: null,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    lastSeenAt: null,
    revokedAt: null,
    revocationReason: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function membership(overrides: Partial<HostedMembershipAuthority> = {}): HostedMembershipAuthority {
  const role = overrides.role ?? 'member';
  return {
    organizationId: TENANT_A.organizationId,
    userId: TENANT_A.userId,
    role,
    status: 'active',
    permissionVersion: AUTHORITY_VERSION,
    permissions: hostedPermissionsForMembership({ role, status: 'active' }),
    ...overrides,
  };
}

interface Harness {
  deps: HostedPrincipalResolverDependencies;
  resolve: ReturnType<typeof createHostedPrincipalResolver>;
  headers: Headers;
}

function harness(options: {
  cookieSessionId?: string | null;
  session?: HostedSession | null;
  membership?: HostedMembershipAuthority | null;
  ownedWorkspaces?: ReadonlySet<string>;
  sessionStoreThrows?: boolean;
  authorityThrows?: boolean;
  workspaceLookupThrows?: boolean;
  observedWorkspaceLookups?: Array<{
    userId: string;
    sessionId: string;
    sessionVersion: number;
    organizationId: string;
    customerWorkspaceId: string;
    controlPlaneWorkspaceId: string;
  }>;
}): Harness {
  const cookieSessionId = options.cookieSessionId === undefined ? SESSION_ID : options.cookieSessionId;
  const stored = options.session === undefined ? session() : options.session;
  const authority = options.membership === undefined ? membership() : options.membership;
  const owned = options.ownedWorkspaces ?? new Set([TENANT_A.workspaceId]);

  const membershipAuthority: HostedMembershipAuthorityReader = {
    async resolveActive(input) {
      if (options.authorityThrows) throw new Error('pg down');
      if (!authority) return null;
      // Model the real adapter: the row is keyed by (user, organization).
      if (authority.userId !== input.userId || authority.organizationId !== input.organizationId) {
        return null;
      }
      return authority;
    },
    async workspaceBelongsToOrganization(input) {
      if (options.workspaceLookupThrows) throw new Error('pg down');
      options.observedWorkspaceLookups?.push(input);
      return (
        input.organizationId === TENANT_A.organizationId &&
        input.controlPlaneWorkspaceId === CONTROL_PLANE_WORKSPACE &&
        owned.has(input.customerWorkspaceId)
      );
    },
  };

  const deps: HostedPrincipalResolverDependencies = {
    sessionCookieCodec: { read: () => cookieSessionId },
    sessionStore: {
      async resolve(id) {
        if (options.sessionStoreThrows) throw new Error('pg down');
        if (!stored) return null;
        return id === stored.id && stored.revokedAt === null ? stored : null;
      },
    },
    membershipAuthority,
    controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
  };

  return { deps, resolve: createHostedPrincipalResolver(deps), headers: new Headers() };
}

describe('authenticated connector session authority', () => {
  const channel = () => ({ controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
    organizationId: TENANT_A.organizationId, customerWorkspaceId: TENANT_A.workspaceId,
    hostId: 'host-1', routeLabel: 'alpha', generation: 1, transport: 'websocket' as const,
    state: 'active' as const, kind: 'session' as const, userId: TENANT_A.userId,
    hostedSessionId: SESSION_ID, audience: 'workspace-operator', expiresAt: NOW });

  it('uses the consumed channel session and fresh membership without a cookie', async () => {
    const f = harness({ session: session({ workspaceId: TENANT_A.workspaceId }) });
    const resolve = createHostedChannelPrincipalResolver(f.deps, channel());
    expect(await resolve()).toMatchObject({ ok: true, principal: {
      userId: TENANT_A.userId, sessionId: SESSION_ID, selectedWorkspaceId: TENANT_A.workspaceId } });
    f.deps.membershipAuthority.resolveActive = async () => null;
    expect(await resolve()).toMatchObject({ ok: false, reason: 'membership_not_active' });
  });

  it.each(['userId', 'hostedSessionId', 'organizationId', 'customerWorkspaceId',
    'controlPlaneWorkspaceId', 'audience', 'kind', 'state', 'transport'])(
    'refuses a mismatched %s binding', async key => {
      const f = harness({ session: session({ workspaceId: TENANT_A.workspaceId }) });
      const changed = { ...channel(), [key]: 'foreign' };
      expect((await createHostedChannelPrincipalResolver(f.deps, changed as ReturnType<typeof channel>)()).ok).toBe(false);
    });

  it('pins channel input and denies revocation, rotation and store faults', async () => {
    const f = harness({ session: session({ workspaceId: TENANT_A.workspaceId }) });
    const input = channel(); const resolve = createHostedChannelPrincipalResolver(f.deps, input);
    input.userId = TENANT_B.userId;
    expect((await resolve()).ok).toBe(true);
    f.deps.sessionStore.resolve = async () => null;
    expect((await resolve()).ok).toBe(false);
    f.deps.sessionStore.resolve = async () => { throw new Error('private database failure'); };
    expect(await resolve()).toEqual({ ok: false, reason: 'authority_unavailable' });
  });
});

describe('hosted principal resolver', () => {
  it('requires a control-plane workspace id', () => {
    expect(() => createHostedPrincipalResolver({ ...harness({}).deps, controlPlaneWorkspaceId: '  ' })).toThrow(
      /control_plane_workspace_id/,
    );
  });

  it('resolves a verified hosted principal from cookie, session, and live membership', async () => {
    const { resolve, headers } = harness({});
    const result = await resolve(headers);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isHostedPrincipal(result.principal)).toBe(true);
    expect(result.principal.kind).toBe('user');
    expect(result.principal.trust).toBe('verified');
    expect(result.principal.authMethod).toBe('cookie-session');
    expect(result.principal.userId).toBe(TENANT_A.userId);
    expect(result.principal.activeOrganizationId).toBe(TENANT_A.organizationId);
    expect(result.principal.sessionId).toBe(SESSION_ID);
    expect(result.principal.sessionVersion).toBe(AUTHORITY_VERSION);
    expect([...result.principal.permissions].sort()).toEqual(['workspace:operate', 'workspace:view']);
  });

  it('scopes the principal to the control plane, never to the customer workspace', async () => {
    const { resolve, headers } = harness({
      session: session({ workspaceId: TENANT_A.workspaceId }),
    });
    const result = await resolve(headers);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The shared Principal contract's workspaceId stays the operator scope; the
    // customer's selection is a separate field so ambient control-plane scope
    // never becomes customer resource authority.
    expect(result.principal.workspaceId).toBe(CONTROL_PLANE_WORKSPACE);
    expect(result.principal.selectedWorkspaceId).toBe(TENANT_A.workspaceId);
  });

  it('derives permissions live from the current role, per role', async () => {
    for (const [role, expected] of [
      [
        'owner',
        [
          'billing:manage',
          'cloud-connection:manage',
          'members:manage',
          'workspace:destroy',
          'workspace:operate',
          'workspace:view',
        ],
      ],
      [
        'admin',
        ['cloud-connection:manage', 'members:manage', 'workspace:destroy', 'workspace:operate', 'workspace:view'],
      ],
      ['member', ['workspace:operate', 'workspace:view']],
      ['billing', ['billing:manage', 'workspace:view']],
    ] as const) {
      const { resolve, headers } = harness({ membership: membership({ role }) });
      const result = await resolve(headers);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect([...result.principal.permissions].sort()).toEqual([...expected]);
    }
  });

  it('denies when no hosted cookie is present', async () => {
    const { resolve, headers } = harness({ cookieSessionId: null });
    const result = await resolve(headers);
    expect(result).toEqual({ ok: false, reason: 'session_cookie_missing' });
  });

  it('denies an unknown or expired session id', async () => {
    const { resolve, headers } = harness({ session: null });
    const result = await resolve(headers);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('session_not_found');
  });

  it('denies a revoked session', async () => {
    const { resolve, headers } = harness({
      session: session({ revokedAt: NOW, revocationReason: 'logout' }),
    });
    const result = await resolve(headers);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('session_not_found');
  });

  it('denies when the membership is no longer active', async () => {
    const { resolve, headers } = harness({ membership: null });
    const result = await resolve(headers);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('membership_not_active');
  });

  it('denies a membership whose derived permissions are empty', async () => {
    const { resolve, headers } = harness({
      membership: membership({ status: 'suspended', permissions: new Set() }),
    });
    const result = await resolve(headers);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('membership_not_active');
  });

  it('denies a session whose permission snapshot is stale', async () => {
    // A role change moves the membership row's updated_at, and therefore its
    // derived authority version, past the version stamped into the session.
    const { resolve, headers } = harness({
      membership: membership({ role: 'owner', permissionVersion: AUTHORITY_VERSION + 60 }),
    });
    const result = await resolve(headers);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('session_permission_version_stale');
  });

  it('never lets a stale session carry the OLD role forward', async () => {
    // The demotion case that matters: the session was minted while the user was
    // an owner; they are now a member. Even if the version check were removed,
    // permissions are re-derived from the current row, so destroy authority is
    // gone either way.
    const demoted = membership({ role: 'member' });
    const { resolve, headers } = harness({ membership: demoted });
    const result = await resolve(headers);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.permissions.has('workspace:destroy')).toBe(false);
    expect(result.principal.permissions.has('billing:manage')).toBe(false);
  });

  describe('cross-tenant isolation', () => {
    it('denies when the session names a tenant the user has no membership in', async () => {
      // Tenant A's user presenting a session bound to Tenant B's organization.
      const { resolve, headers } = harness({
        session: session({ organizationId: TENANT_B.organizationId }),
      });
      const result = await resolve(headers);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('membership_not_active');
    });

    it('denies when the authority row disagrees with the session about the tenant', async () => {
      // Defends against an adapter bug: a loader that ignored its arguments and
      // returned some other organization's row must not widen the boundary.
      const rogue: HostedMembershipAuthorityReader = {
        async resolveActive() {
          return membership({ organizationId: TENANT_B.organizationId });
        },
        async workspaceBelongsToOrganization() {
          return true;
        },
      };
      const base = harness({});
      const resolve = createHostedPrincipalResolver({
        ...base.deps,
        membershipAuthority: rogue,
      });
      const result = await resolve(base.headers);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('session_organization_mismatch');
    });

    it('denies a selected workspace that belongs to another organization', async () => {
      const { resolve, headers } = harness({
        session: session({ workspaceId: TENANT_B.workspaceId }),
      });
      const result = await resolve(headers);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('workspace_not_in_organization');
    });

    it('scopes the workspace ownership check to the control plane workspace', async () => {
      const observedWorkspaceLookups: Array<{
        userId: string;
        sessionId: string;
        sessionVersion: number;
        organizationId: string;
        customerWorkspaceId: string;
        controlPlaneWorkspaceId: string;
      }> = [];
      const { resolve, headers } = harness({
        session: session({ workspaceId: TENANT_A.workspaceId }),
        observedWorkspaceLookups,
      });
      await resolve(headers);

      expect(observedWorkspaceLookups).toEqual([
        {
          userId: TENANT_A.userId,
          sessionId: SESSION_ID,
          sessionVersion: AUTHORITY_VERSION,
          organizationId: TENANT_A.organizationId,
          customerWorkspaceId: TENANT_A.workspaceId,
          controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
        },
      ]);
    });

    it('does not consult the workspace directory when no workspace is selected', async () => {
      const observedWorkspaceLookups: Array<{
        userId: string;
        sessionId: string;
        sessionVersion: number;
        organizationId: string;
        customerWorkspaceId: string;
        controlPlaneWorkspaceId: string;
      }> = [];
      const { resolve, headers } = harness({ observedWorkspaceLookups });
      const result = await resolve(headers);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.principal.selectedWorkspaceId).toBeUndefined();
      expect(observedWorkspaceLookups).toEqual([]);
    });
  });

  describe('fails closed on infrastructure faults', () => {
    it.each([
      ['session store', { sessionStoreThrows: true }],
      ['membership authority', { authorityThrows: true }],
    ])('denies with authority_unavailable when the %s throws', async (_label, options) => {
      const { resolve, headers } = harness(options);
      const result = await resolve(headers);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('authority_unavailable');
    });

    it('denies with authority_unavailable when the workspace directory throws', async () => {
      const { resolve, headers } = harness({
        session: session({ workspaceId: TENANT_A.workspaceId }),
        workspaceLookupThrows: true,
      });
      const result = await resolve(headers);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('authority_unavailable');
    });

    it('denies rather than throwing when the principal cannot be constructed', async () => {
      const { resolve, headers } = harness({
        membership: membership({
          permissions: new Set(['not-a-hosted-permission']) as never,
        }),
      });
      const result = await resolve(headers);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('authority_unavailable');
    });
  });

  describe('hostedSessionAuthorizationState', () => {
    it('reports the same version the principal carries, so the gate agrees with itself', async () => {
      const { resolve, headers } = harness({});
      const result = await resolve(headers);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const state = hostedSessionAuthorizationState(result.session);
      expect(state).toEqual({
        sessionId: result.principal.sessionId,
        sessionVersion: result.principal.sessionVersion,
        revoked: false,
      });
    });

    it('reports revocation', () => {
      expect(hostedSessionAuthorizationState(session({ revokedAt: NOW })).revoked).toBe(true);
    });
  });
});
