import { describe, expect, it } from 'vitest';
import { createHostedPrincipal, type HostedPermission } from '../../../auth/hosted-principal';
import type { HostedPrincipalResolver } from '../../../auth/hosted-principal-resolver';
import type { HostedConnectorBinding } from '../../hosted-workspace-connector';
import {
  createHostedCliRoutes, DEFAULT_CLIENT_LABEL, HOSTED_CLI_ROUTES, normalizeUserCode, PORTAL_RELAY_NOTICE, sanitizeClientLabel,
} from './index';
import {
  linkedWorkspaceIdentity,
  type HostedCliStore, type HostedCliToken, type HostedCliWorkspace, type HostedDeviceGrantPurpose,
} from './store';

const ORIGIN = 'https://app.papercusp.com';

/** In-memory store with the SQL store's semantics: hash-only, single consumption, org-scoped listing. */
function memoryStore(workspaces: Record<string, HostedCliWorkspace[]>) {
  const grants = new Map<string, {
    userCode: string; clientLabel: string; state: string; userId?: string; organizationId?: string;
    expiresAt: Date; lastPolledAt?: Date; purpose: HostedDeviceGrantPurpose; installId: string | null;
  }>();
  const tokens = new Map<string, HostedCliToken & { revoked: boolean }>();
  /** customer_workspaces rows of kind 'linked', keyed by workspace id. */
  const linked = new Map<string, { organizationId: string; installId: string; displayName: string; createdBy: string; state: 'active' | 'deleted' }>();
  const store: HostedCliStore = {
    async createGrant(input) {
      if ([...grants.values()].some((g) => g.userCode === input.userCode)) return false;
      const purpose = input.purpose ?? 'cli';
      grants.set(input.deviceCodeHash, {
        userCode: input.userCode, clientLabel: input.clientLabel, state: 'pending', expiresAt: input.expiresAt,
        purpose, installId: purpose === 'relay-link' ? (input.installId ?? null) : null,
      });
      return true;
    },
    async findPendingGrant(userCode, now) {
      const grant = [...grants.values()].find((g) => g.userCode === userCode && g.state === 'pending' && g.expiresAt > now);
      return grant ? { userCode, clientLabel: grant.clientLabel, expiresAt: grant.expiresAt, purpose: grant.purpose, installId: grant.installId } : null;
    },
    async decideGrant(input) {
      const grant = [...grants.values()].find((g) => g.userCode === input.userCode && g.state === 'pending');
      if (!grant) return false;
      grant.state = input.decision;
      if (input.decision === 'approved') Object.assign(grant, { userId: input.userId, organizationId: input.organizationId });
      return true;
    },
    async exchangeGrant(input) {
      const grant = grants.get(input.deviceCodeHash);
      // Same filter as the SQL store: a relay-link grant is never a CLI sign-in.
      if (!grant || grant.purpose !== 'cli' || grant.state === 'consumed') return { status: 'invalid' };
      if (grant.expiresAt <= input.now) return { status: 'expired' };
      if (grant.state === 'denied') return { status: 'denied' };
      if (grant.state === 'pending') {
        const last = grant.lastPolledAt;
        grant.lastPolledAt = input.now;
        return { status: last && input.now.getTime() - last.getTime() < input.minPollIntervalMs ? 'slow_down' : 'pending' };
      }
      grant.state = 'consumed';
      const token = { id: input.token.id, userId: grant.userId!, organizationId: grant.organizationId!, clientLabel: grant.clientLabel, expiresAt: input.token.expiresAt, revoked: false };
      tokens.set(input.token.tokenHash, token);
      return { status: 'issued', token };
    },
    async exchangeRelayLinkGrant(input) {
      const grant = grants.get(input.deviceCodeHash);
      if (!grant || grant.purpose !== 'relay-link' || grant.state === 'consumed') return { status: 'invalid' };
      if (grant.expiresAt <= input.now) return { status: 'expired' };
      if (grant.state === 'denied') return { status: 'denied' };
      if (grant.state === 'pending') {
        const last = grant.lastPolledAt;
        grant.lastPolledAt = input.now;
        return { status: last && input.now.getTime() - last.getTime() < input.minPollIntervalMs ? 'slow_down' : 'pending' };
      }
      grant.state = 'consumed';
      return { status: 'approved', userId: grant.userId!, organizationId: grant.organizationId!, installId: grant.installId!, clientLabel: grant.clientLabel };
    },
    async upsertLinkedWorkspace(input) {
      const identity = linkedWorkspaceIdentity(input.organizationId, input.installId);
      linked.set(identity.customerWorkspaceId, {
        organizationId: input.organizationId, installId: input.installId, displayName: input.displayName,
        createdBy: linked.get(identity.customerWorkspaceId)?.createdBy ?? input.userId, state: 'active',
      });
      return identity;
    },
    async unlinkLinkedWorkspace(input) {
      const row = linked.get(input.customerWorkspaceId);
      if (!row || row.organizationId !== input.organizationId) return false;
      row.state = 'deleted';
      return true;
    },
    async resolveToken(hash, now) {
      const token = tokens.get(hash);
      return token && !token.revoked && token.expiresAt > now ? token : null;
    },
    async revokeToken(id) {
      const token = [...tokens.values()].find((t) => t.id === id && !t.revoked);
      if (token) token.revoked = true;
      return Boolean(token);
    },
    async listWorkspaces(organizationId) {
      return workspaces[organizationId] ?? [];
    },
    async organizationName(organizationId) {
      return ({ 'org-a': 'Avi Labs' } as Record<string, string>)[organizationId] ?? null;
    },
  };
  return { store, grants, tokens, linked };
}

function signedInResolver(organizationId: string | null): HostedPrincipalResolver {
  return async () => organizationId
    ? { ok: true, principal: principal(organizationId, ['workspace:view']), session: {} as never, membership: {} as never }
    : { ok: false, reason: 'session_cookie_missing' };
}

function principal(organizationId: string, permissions: HostedPermission[]) {
  return createHostedPrincipal({
    workspaceId: 'control-plane', userId: 'user-1', activeOrganizationId: organizationId,
    sessionId: 'hs-1', sessionVersion: 1, permissions,
  });
}

function setup(options: { permissions?: HostedPermission[]; signedIn?: boolean } = {}) {
  // The relay stamps heartbeat_at on every pong, so a connected machine's stamp is seconds old.
  const connectorA = { state: 'active' as const, routeLabel: 'host-a', transport: 'websocket' as const, generation: 3, heartbeatAt: new Date('2026-09-24T03:59:50Z') as Date | null };
  const memory = memoryStore({
    'org-a': [{
      id: 'ws-a', displayName: 'Avi test', state: 'active', hostId: 'host-a',
      connector: connectorA,
    }],
    'org-b': [{
      id: 'ws-b', displayName: 'Other tenant', state: 'active', hostId: 'host-b',
      connector: { state: 'active', routeLabel: 'host-b', transport: 'websocket', generation: 1, heartbeatAt: new Date('2026-09-24T03:59:50Z') },
    }],
  });
  const tickets: unknown[] = [];
  const enrollments: unknown[] = [];
  const revoked: unknown[] = [];
  /** Connector bearers the fake gateway recognizes; tests register one per linked install. */
  const bearers = new Map<string, HostedConnectorBinding>();
  let now = new Date('2026-09-24T04:00:00Z');
  let counter = 0;
  const routes = createHostedCliRoutes({
    publicOrigin: ORIGIN,
    controlPlaneWorkspaceId: 'control-plane',
    store: memory.store,
    membershipAuthority: {
      resolveActive: async ({ userId, organizationId }) => ({
        userId, organizationId, role: 'owner', permissionVersion: 1,
        permissions: new Set(options.permissions ?? ['workspace:view', 'workspace:operate']),
      }) as never,
    },
    connectorGateway: {
      issueSessionTicket: async (input) => {
        tickets.push(input);
        return { ticket: `ht_${'t'.repeat(43)}`, binding: { ...input, kind: 'session', expiresAt: new Date(now.getTime() + 60_000) } } as never;
      },
      enroll: async (input, ttlMs) => {
        enrollments.push({ ...input, ttlMs });
        return {
          ticket: `ht_${'e'.repeat(43)}`,
          binding: { ...input, generation: 1, state: 'pending', kind: 'enrollment', audience: 'connector-register', expiresAt: new Date(now.getTime() + (ttlMs ?? 0)) },
        };
      },
      authenticate: async (bearer) => {
        const binding = bearers.get(bearer);
        return binding && binding.state === 'active' ? binding : null;
      },
      revoke: async (input) => {
        revoked.push(input);
        for (const [bearer, binding] of bearers) {
          if (binding.customerWorkspaceId === input.customerWorkspaceId) bearers.set(bearer, { ...binding, state: 'revoked' });
        }
        return true;
      },
    },
    resolvePrincipal: signedInResolver(options.signedIn === false ? null : 'org-a'),
    clock: () => now,
    // Deterministic but distinct draws so user codes and tokens never collide within a test.
    randomBytes: (size) => Buffer.alloc(size, (counter += 1) % 251),
  });
  const route = (method: string, path: string) => routes.find((r) => r.method === method && r.path === path)!;
  const call = (method: string, path: string, init: RequestInit & { params?: Record<string, string>; principal?: unknown } = {}) =>
    route(method, path).handler(new Request(`${ORIGIN}/api${path}`, init), { params: init.params ?? {}, principal: init.principal ?? null } as never) as Promise<Response>;
  return {
    memory, tickets, enrollments, revoked, bearers, routes, call, connectorA,
    now: () => now,
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
  };
}

async function signIn(t: ReturnType<typeof setup>, organizationId = 'org-a') {
  const code = await (await t.call('POST', '/hosted/cli/device/code', { method: 'POST', body: JSON.stringify({ clientLabel: 'laptop' }) })).json();
  const decided = await t.call('POST', '/hosted/cli/device/decision', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ userCode: code.userCode, decision: 'approve' }),
    principal: principal(organizationId, ['workspace:view']),
  });
  expect(decided.status).toBe(200);
  const token = await (await t.call('POST', '/hosted/cli/device/token', { method: 'POST', body: JSON.stringify({ deviceCode: code.deviceCode }) })).json();
  return { code, token };
}

describe('hosted psu CLI routes', () => {
  it('publishes exactly the routes it builds, with the access tier each declares', () => {
    const { routes } = setup();
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(HOSTED_CLI_ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const entry of HOSTED_CLI_ROUTES) {
      const built = routes.find((r) => r.method === entry.method && r.path === entry.path)!;
      expect(built.auth === 'public').toBe(entry.access === 'public');
    }
  });

  it('signs a CLI in through a browser approval and hands out the token exactly once', async () => {
    const t = setup();
    const code = await (await t.call('POST', '/hosted/cli/device/code', { method: 'POST', body: '{}' })).json();
    expect(code.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(code.verificationUriComplete).toBe(`${ORIGIN}/api/hosted/cli/device?user_code=${code.userCode}`);
    expect([...t.memory.grants.keys()][0]).not.toContain(code.deviceCode); // hash-only
    // A CLI that sends no label is named DEFAULT_CLIENT_LABEL on the approval page.
    expect([...t.memory.grants.values()][0].clientLabel).toBe(DEFAULT_CLIENT_LABEL);

    const poll = () => t.call('POST', '/hosted/cli/device/token', { method: 'POST', body: JSON.stringify({ deviceCode: code.deviceCode }) });
    expect(await (await poll()).json()).toMatchObject({ error: 'authorization_pending' });
    expect(await (await poll()).json()).toMatchObject({ error: 'slow_down' });

    const page = await t.call('GET', `/hosted/cli/device`, { headers: {}, params: {} });
    expect(page.status).toBe(200);
    const approve = await t.call('POST', '/hosted/cli/device/decision', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: `user_code=${code.userCode.toLowerCase().replace('-', '')}&decision=approve`,
      principal: principal('org-a', ['workspace:view']),
    });
    expect(approve.status).toBe(200);
    expect(approve.headers.get('x-frame-options')).toBe('DENY');
    // WI-10003612: under 'no-referrer' a browser serializes the approve form's POST Origin as
    // "null", which the decision route refused — every real sign-in failed cross_origin_blocked.
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    expect(approve.headers.get('referrer-policy')).toBe('same-origin');

    t.advance(5_000);
    const issued = await (await poll()).json();
    // WI-10003910: the organization's name travels with the token so several sign-ins can be told apart.
    expect(issued).toMatchObject({ ok: true, tokenType: 'Bearer', organizationId: 'org-a', organizationName: 'Avi Labs', userId: 'user-1' });
    expect(issued.accessToken).toMatch(/^pct_[A-Za-z0-9_-]{43}$/);
    expect(await (await poll()).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a cross-origin approval and reports a denied grant to the CLI', async () => {
    const t = setup();
    const code = await (await t.call('POST', '/hosted/cli/device/code', { method: 'POST', body: '{}' })).json();
    const forged = await t.call('POST', '/hosted/cli/device/decision', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ userCode: code.userCode, decision: 'approve' }),
      principal: principal('org-a', ['workspace:view']),
    });
    expect(forged.status).toBe(403);
    await t.call('POST', '/hosted/cli/device/decision', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ userCode: code.userCode, decision: 'deny' }),
      principal: principal('org-a', ['workspace:view']),
    });
    const polled = await t.call('POST', '/hosted/cli/device/token', { method: 'POST', body: JSON.stringify({ deviceCode: code.deviceCode }) });
    expect(await polled.json()).toMatchObject({ error: 'access_denied' });
  });

  it('accepts an opaque Origin only when Fetch Metadata proves a same-origin form post (WI-10003612)', async () => {
    const t = setup();
    const decide = async (userCode: string, headers: Record<string, string>) =>
      t.call('POST', '/hosted/cli/device/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: `user_code=${userCode}&decision=approve`,
        principal: principal('org-a', ['workspace:view']),
      });

    const sandboxed = await (await t.call('POST', '/hosted/cli/device/code', { method: 'POST', body: '{}' })).json();
    for (const headers of [
      { origin: 'null' } as Record<string, string>,
      { origin: 'null', 'sec-fetch-site': 'cross-site' },
      { origin: 'null', 'sec-fetch-site': 'same-site' },
    ]) {
      const refused = await decide(sandboxed.userCode, headers);
      expect(refused.status).toBe(403);
      // The exact body the owner saw from `psu cloud login`.
      expect(await refused.text()).toBe('{"ok":false,"error":{"code":"cross_origin_blocked"}}');
    }

    const privacyBrowser = await (await t.call('POST', '/hosted/cli/device/code', { method: 'POST', body: '{}' })).json();
    const approved = await decide(privacyBrowser.userCode, { origin: 'null', 'sec-fetch-site': 'same-origin' });
    expect(approved.status).toBe(200);
  });

  it('sends a signed-out visitor to sign-in and back to the same code', async () => {
    const t = setup({ signedIn: false });
    const response = await t.call('GET', '/hosted/cli/device', {});
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(`${ORIGIN}/api/hosted/auth/sign-in`);
    expect(location.searchParams.get('returnTo')).toBe('/api/hosted/cli/device');
  });

  it('lists only the token organization\'s workspaces and issues a terminal ticket on its own session', async () => {
    const t = setup();
    const { token } = await signIn(t);
    const auth = { authorization: `Bearer ${token.accessToken}` };
    const listed = await (await t.call('GET', '/hosted/cli/workspaces', { headers: auth })).json();
    expect(listed.workspaces.map((w: { id: string }) => w.id)).toEqual(['ws-a']);
    expect(listed.workspaces[0].reachable).toBe(true);
    expect(listed.workspaces[0].connector).toMatchObject({
      state: 'active', routeLabel: 'host-a', transport: 'websocket', generation: 3,
    });
    expect(listed.organizationName).toBe('Avi Labs');

    const other = await t.call('POST', '/hosted/cli/workspaces/:workspaceId/terminal', {
      method: 'POST', headers: auth, body: '{}', params: { workspaceId: 'ws-b' },
    });
    expect(other.status).toBe(404);

    const opened = await t.call('POST', '/hosted/cli/workspaces/:workspaceId/terminal', {
      method: 'POST', headers: auth, body: JSON.stringify({ session: 'resume-me' }), params: { workspaceId: 'ws-a' },
    });
    const body = await opened.json();
    expect(body.socketUrl).toBe(`wss://app.papercusp.com/api/hosted/connectors/socket?ticket=ht_${'t'.repeat(43)}`);
    expect(t.tickets[0]).toMatchObject({
      organizationId: 'org-a', customerWorkspaceId: 'ws-a', hostId: 'host-a', routeLabel: 'host-a', generation: 3,
      userId: 'user-1', audience: 'workspace-operator', transport: 'websocket',
      hostedSessionId: `cli.${token.tokenId}.resume-me`,
    });
    expect(body.program).toBe('shell');
  });

  // D-002 (psu-cloud-connector-liveness-multi-signin-2026-09-29): the machine starts psu itself.
  describe('program psu (D-002)', () => {
    async function open(payload: Record<string, unknown>) {
      const t = setup();
      const { token } = await signIn(t);
      const response = await t.call('POST', '/hosted/cli/workspaces/:workspaceId/terminal', {
        method: 'POST',
        headers: { authorization: `Bearer ${token.accessToken}` },
        body: JSON.stringify(payload),
        params: { workspaceId: 'ws-a' },
      });
      return { t, token, response, body: await response.json() };
    }

    it('asks the relay for the psu kind with the normalised argv, on a separate session id', async () => {
      const { t, token, response, body } = await open({ session: 'k1', program: 'psu', argv: ['--agent', 'codex', '--no-picker'] });
      expect(response.status).toBe(200);
      expect(body.program).toBe('psu');
      const url = new URL(body.socketUrl);
      expect(url.searchParams.get('kind')).toBe('psu');
      expect(JSON.parse(url.searchParams.get('argv')!)).toEqual(['--agent=codex', '--no-picker']);
      expect(t.tickets[0]).toMatchObject({ hostedSessionId: `cli.${token.tokenId}.psu.k1` });
    });

    it('sends an empty argv when the client passed none', async () => {
      const { body } = await open({ program: 'psu' });
      expect(JSON.parse(new URL(body.socketUrl).searchParams.get('argv')!)).toEqual([]);
    });

    it('refuses an argv outside the allowlist with its reason, before any ticket is minted', async () => {
      const { t, response, body } = await open({ program: 'psu', argv: ['--', 'sh'] });
      expect(response.status).toBe(400);
      expect(body).toMatchObject({ ok: false, error: { code: 'psu_argv_refused', reason: 'flag_not_allowed:--' } });
      expect(t.tickets).toHaveLength(0);
    });

    it('refuses an unknown program rather than falling back to a shell', async () => {
      const { t, response, body } = await open({ program: 'bash' });
      expect(response.status).toBe(400);
      expect(body).toMatchObject({ ok: false, error: { code: 'invalid_program' } });
      expect(t.tickets).toHaveLength(0);
    });

    it('keeps a shell request free of psu parameters', async () => {
      const { body } = await open({ program: 'shell', argv: ['--agent', 'codex'] });
      expect(body.program).toBe('shell');
      const url = new URL(body.socketUrl);
      expect(url.searchParams.has('kind')).toBe(false);
      expect(url.searchParams.has('argv')).toBe(false);
    });
  });

  // P-001 (psu-cloud-connector-liveness-multi-signin-2026-09-29). avi-test, 2026-09-29: the row said
  // active, psu printed "connected to …", and the relay then closed 4411 connector_unavailable,
  // because nothing but the row state decided reachability.
  it('treats an active connector without a fresh heartbeat as unreachable and mints no ticket', async () => {
    const t = setup();
    const { token } = await signIn(t);
    const auth = { authorization: `Bearer ${token.accessToken}` };
    const open = () => t.call('POST', '/hosted/cli/workspaces/:workspaceId/terminal', {
      method: 'POST', headers: auth, body: '{}', params: { workspaceId: 'ws-a' },
    });
    const reachable = async () => (await (await t.call('GET', '/hosted/cli/workspaces', { headers: auth })).json()).workspaces[0].reachable;

    t.connectorA.heartbeatAt = new Date(t.now().getTime() - 2 * 60 * 60_000);
    expect(await reachable()).toBe(false);
    const refused = await open();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      ok: false,
      error: { code: 'workspace_not_reachable', connectorHeartbeatAt: t.connectorA.heartbeatAt.toISOString() },
    });

    t.connectorA.heartbeatAt = null;
    expect(await reachable()).toBe(false);
    expect((await open()).status).toBe(409);
    expect(t.tickets).toHaveLength(0);

    // The relay stamps a pong: reachable again, and the ticket is minted.
    t.connectorA.heartbeatAt = new Date(t.now().getTime() - 5_000);
    expect(await reachable()).toBe(true);
    expect((await open()).status).toBe(200);
    expect(t.tickets).toHaveLength(1);

    // Staleness is measured against the clock, not stored: the same stamp ages out.
    t.advance(2 * 60_000);
    expect(await reachable()).toBe(false);
  });

  it('re-derives permissions per request: a view-only member cannot open a terminal', async () => {
    const t = setup({ permissions: ['workspace:view'] });
    const { token } = await signIn(t);
    const denied = await t.call('POST', '/hosted/cli/workspaces/:workspaceId/terminal', {
      method: 'POST', headers: { authorization: `Bearer ${token.accessToken}` }, body: '{}', params: { workspaceId: 'ws-a' },
    });
    expect(denied.status).toBe(403);
    expect(t.tickets).toHaveLength(0);
  });

  it('signs a CLI out: the token stops working', async () => {
    const t = setup();
    const { token } = await signIn(t);
    const auth = { authorization: `Bearer ${token.accessToken}` };
    expect((await t.call('POST', '/hosted/cli/logout', { method: 'POST', headers: auth })).status).toBe(200);
    expect((await t.call('GET', '/hosted/cli/workspaces', { headers: auth })).status).toBe(401);
  });

  it('normalizes typed codes and display labels', () => {
    expect(normalizeUserCode(' bcdf ghjk ')).toBe('BCDF-GHJK');
    expect(normalizeUserCode('short')).toBeNull();
    expect(sanitizeClientLabel('host\n\u0007name')).toBe('host name');
    // Nothing printable left -> '' so a route that requires a label can refuse it;
    // routes that want a fallback name apply DEFAULT_CLIENT_LABEL themselves.
    expect(sanitizeClientLabel('')).toBe('');
    expect(sanitizeClientLabel('   ')).toBe('');
    expect(sanitizeClientLabel('\u0007\n\t')).toBe('');
    expect(sanitizeClientLabel(42)).toBe('');
  });
});

// EAA P-008 (plan external-app-access-to-workspaces-2026-09-29, D-031): a local install links to
// the portal relay through the same device grant, as a customer workspace of kind 'linked'.
describe('portal relay link routes', () => {
  const INSTALL_ID = 'install-0123456789abcdef';

  async function openRelayCode(t: ReturnType<typeof setup>, installId = INSTALL_ID) {
    return t.call('POST', '/hosted/relay/device/code', {
      method: 'POST', body: JSON.stringify({ installId, installLabel: 'home desktop' }),
    });
  }

  function decide(t: ReturnType<typeof setup>, userCode: string, decision: 'approve' | 'deny', permissions: HostedPermission[]) {
    return t.call('POST', '/hosted/cli/device/decision', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ userCode, decision }),
      principal: principal('org-a', permissions),
    });
  }

  const pollRelay = (t: ReturnType<typeof setup>, deviceCode: string) =>
    t.call('POST', '/hosted/relay/device/token', { method: 'POST', body: JSON.stringify({ deviceCode }) });

  it('links an install: code, relay approval page, operator approval, one enrollment ticket', async () => {
    const t = setup();
    const opened = await openRelayCode(t);
    expect(opened.status).toBe(200);
    const code = await opened.json();
    expect(code.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(code.verificationUriComplete).toBe(`${ORIGIN}/api/hosted/cli/device?user_code=${code.userCode}`);
    const stored = [...t.memory.grants.values()][0];
    expect(stored).toMatchObject({ purpose: 'relay-link', installId: INSTALL_ID, clientLabel: 'home desktop' });

    expect(await (await pollRelay(t, code.deviceCode)).json()).toMatchObject({ error: 'authorization_pending' });

    // The approval page names the relay and carries the D-009 notice, not the psu sign-in copy.
    const pageWithCode = await t.routes
      .find((r) => r.method === 'GET' && r.path === '/hosted/cli/device')!
      .handler(new Request(`${ORIGIN}/api/hosted/cli/device?user_code=${code.userCode}`), { params: {}, principal: null } as never) as Response;
    const html = await pageWithCode.text();
    expect(html).toContain('Connect this computer to the Papercusp relay?');
    expect(html).toContain('Papercusp can read those calls and their results while they pass through, and does not store them.');
    expect(PORTAL_RELAY_NOTICE).toContain('use your own tunnel instead');
    expect(html).not.toContain('Allow psu to use your workspaces?');

    // The browser posts the page's form; the reply is the relay's own confirmation page.
    const approved = await t.call('POST', '/hosted/cli/device/decision', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: `user_code=${code.userCode}&decision=approve`,
      principal: principal('org-a', ['workspace:view', 'workspace:operate']),
    });
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain('Computer connected');

    t.advance(5_000);
    const linked = await pollRelay(t, code.deviceCode);
    expect(linked.status).toBe(200);
    const body = await linked.json();
    const identity = linkedWorkspaceIdentity('org-a', INSTALL_ID);
    expect(body).toMatchObject({
      ok: true,
      organizationId: 'org-a',
      organizationName: 'Avi Labs',
      customerWorkspaceId: identity.customerWorkspaceId,
      enrollmentTicket: `ht_${'e'.repeat(43)}`,
      registerUrl: `${ORIGIN}/api/hosted/connectors/register`,
      connectorUrl: 'wss://app.papercusp.com/api/hosted/connectors/socket',
      appBaseUrl: `${ORIGIN}/api/workspaces/${identity.customerWorkspaceId}`,
    });
    // One linked workspace row, created by the approver, and one enrollment for exactly its identity.
    expect(t.memory.linked.get(identity.customerWorkspaceId)).toMatchObject({
      organizationId: 'org-a', installId: INSTALL_ID, displayName: 'home desktop', createdBy: 'user-1', state: 'active',
    });
    expect(t.enrollments).toEqual([expect.objectContaining({
      controlPlaneWorkspaceId: 'control-plane', organizationId: 'org-a', customerWorkspaceId: identity.customerWorkspaceId,
      hostId: identity.hostId, routeLabel: identity.routeLabel, transport: 'websocket',
    })]);
    // The grant is consumed: a replay links nothing further and never mints a second ticket.
    expect(await (await pollRelay(t, code.deviceCode)).json()).toMatchObject({ error: 'invalid_grant' });
    expect(t.enrollments).toHaveLength(1);
  });

  it('needs workspace:operate to approve a relay link; a view-only member may still deny it', async () => {
    const t = setup();
    const code = await (await openRelayCode(t)).json();
    const refused = await decide(t, code.userCode, 'approve', ['workspace:view']);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'forbidden', missingPermission: 'workspace:operate' } });
    expect([...t.memory.grants.values()][0].state).toBe('pending');

    const denied = await decide(t, code.userCode, 'deny', ['workspace:view']);
    expect(denied.status).toBe(200);
    expect(await (await pollRelay(t, code.deviceCode)).json()).toMatchObject({ error: 'access_denied' });
    expect(t.enrollments).toHaveLength(0);
    expect(t.memory.linked.size).toBe(0);
  });

  it('re-checks the approver at exchange time: a member who lost operate links nothing', async () => {
    const t = setup({ permissions: ['workspace:view'] });
    const code = await (await openRelayCode(t)).json();
    // The approver held operate when approving (the principal), but the live membership has only view.
    expect((await decide(t, code.userCode, 'approve', ['workspace:view', 'workspace:operate'])).status).toBe(200);
    t.advance(5_000);
    const refused = await pollRelay(t, code.deviceCode);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'membership_not_active' } });
    expect(t.enrollments).toHaveLength(0);
    expect(t.memory.linked.size).toBe(0);
  });

  it('keeps the two grant purposes apart: neither exchange accepts the other kind of code', async () => {
    const t = setup();
    const relay = await (await openRelayCode(t)).json();
    await decide(t, relay.userCode, 'approve', ['workspace:view', 'workspace:operate']);
    t.advance(5_000);
    // A relay-link code is never a psu sign-in token.
    const asCli = await t.call('POST', '/hosted/cli/device/token', { method: 'POST', body: JSON.stringify({ deviceCode: relay.deviceCode }) });
    expect(await asCli.json()).toMatchObject({ error: 'invalid_grant' });
    expect(t.memory.tokens.size).toBe(0);

    // A psu sign-in code is never a relay link.
    const cli = await (await t.call('POST', '/hosted/cli/device/code', { method: 'POST', body: '{}' })).json();
    await decide(t, cli.userCode, 'approve', ['workspace:view', 'workspace:operate']);
    t.advance(5_000);
    expect(await (await pollRelay(t, cli.deviceCode)).json()).toMatchObject({ error: 'invalid_grant' });
    expect(t.enrollments).toHaveLength(0);
  });

  it('refuses an install id that is not the machine-generated shape', async () => {
    const t = setup();
    for (const installId of ['', 'short', 'UPPER-case-install-id', '-leading-dash-id', 'a'.repeat(65), 42]) {
      const response = await t.call('POST', '/hosted/relay/device/code', { method: 'POST', body: JSON.stringify({ installId }) });
      expect(response.status).toBe(400);
    }
    expect(t.memory.grants.size).toBe(0);
  });

  it('unlinks only a linked install, with its own connector bearer, idempotently', async () => {
    const t = setup();
    const identity = linkedWorkspaceIdentity('org-a', INSTALL_ID);
    const code = await (await openRelayCode(t)).json();
    await decide(t, code.userCode, 'approve', ['workspace:view', 'workspace:operate']);
    t.advance(5_000);
    expect((await pollRelay(t, code.deviceCode)).status).toBe(200);
    const linkedBearer = `hc_${'l'.repeat(43)}`;
    const hostedBearer = `hc_${'h'.repeat(43)}`;
    t.bearers.set(linkedBearer, {
      controlPlaneWorkspaceId: 'control-plane', organizationId: 'org-a', customerWorkspaceId: identity.customerWorkspaceId,
      hostId: identity.hostId, routeLabel: identity.routeLabel, generation: 1, transport: 'websocket', state: 'active',
    });
    t.bearers.set(hostedBearer, {
      controlPlaneWorkspaceId: 'control-plane', organizationId: 'org-a', customerWorkspaceId: 'ws-a',
      hostId: 'host-a', routeLabel: 'host-a', generation: 3, transport: 'websocket', state: 'active',
    });
    const unlink = (bearer?: string) => t.call('POST', '/hosted/relay/unlink', {
      method: 'POST', headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });

    expect((await unlink()).status).toBe(401);
    // A Papercusp-hosted machine's connector cannot delete its workspace through this route.
    const hosted = await unlink(hostedBearer);
    expect(hosted.status).toBe(403);
    expect(await hosted.json()).toMatchObject({ error: { code: 'not_a_linked_install' } });
    expect(t.revoked).toHaveLength(0);

    const done = await unlink(linkedBearer);
    expect(await done.json()).toEqual({ ok: true, unlinked: true });
    expect(t.memory.linked.get(identity.customerWorkspaceId)?.state).toBe('deleted');
    expect(t.revoked).toEqual([expect.objectContaining({ customerWorkspaceId: identity.customerWorkspaceId, hostId: identity.hostId })]);
    // The revoked bearer is already unlinked; a retry is a no-op, not an error.
    expect(await (await unlink(linkedBearer)).json()).toEqual({ ok: true, unlinked: false });
  });
});
