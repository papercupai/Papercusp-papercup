/**
 * external-app-access-to-workspaces-2026-09-29 P-002 — R-2 (an app key works
 * over HTTP) and R-25 (pause and revoke stop a key).
 *
 * Only the database handle is faked: it answers the connected_apps lookup with
 * one row the test controls. Everything above it is real — the key parser, the
 * sha256 comparison, the revoked/paused/expired checks in `verifyAppKey`, the
 * `/api/agent-tools/*` catch-all, and `requirePrincipal`'s auth chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const sql = Object.assign(
    // Other modules in the catchall's graph also reach this client, some via
    // postgres.js helper calls (`sql(value)`) rather than a tagged template —
    // answer those with no rows instead of throwing an unhandled rejection.
    async (strings: TemplateStringsArray | unknown) => {
      const text = Array.isArray(strings) ? strings.join('?') : '';
      if (db.row && /SELECT[\s\S]*FROM harness_shared\.connected_apps/.test(text)) return [db.row];
      return [];
    },
    { unsafe: (fragment: string) => fragment },
  );
  return {
    ...(await importOriginal<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql }),
    withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn(sql),
  };
});

import { registerProjectedTool, _resetProjectionRegistryForTests, type ProjectedTool } from '@papercusp/agent-mcp';
import catchall from '../endpoint-route/routes/agent-tools/catchall';
import type { RouteContext } from '../endpoint-route/define-route';
import { PrincipalCheckError, requirePrincipal, tryResolvePrincipal } from '../auth/require-principal';
import { mintAppKey } from './key';
import { setKernelEnforcementResolver } from '../projected-tool-deps';
// lib/events/index.ts installs the DB-backed control-anchor kernel resolver at import time.
// This fixture mocks @papercusp/db-org, so that control-anchor read rejects and every call is
// denied policy-unavailable (403). Uninstall it: app-key scope + structural kernel checks stay real.
beforeEach(() => { setKernelEnforcementResolver(null); });

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

const postRoute = catchall.find((d) => d.method === 'POST');
if (!postRoute) throw new Error('agent-tools catchall has no POST route');

function whoamiTool(): ProjectedTool {
  return {
    pluginName: 'agent-mcp',
    description: 'echoes the resolved principal',
    inputSchema: { type: 'object' },
    capabilities: [],
    public: true,
    expose: {
      http: { path: '/api/agent-tools/fix/app-whoami', methods: ['POST'] },
      mcp: { name: 'fix:app-whoami' },
    },
    fn: async (_input, ctx) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            slug: ctx.principal?.slug ?? null,
            workspace: ctx.principal?.workspaceId ?? null,
          }),
        },
      ],
    }),
  };
}

async function callWhoami(bearer: string): Promise<{ slug: string | null; workspace: string | null }> {
  const res = await postRoute!.handler(
    new Request('http://x.test/api/agent-tools/fix/app-whoami', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: '{}',
    }),
    CTX,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { content: Array<{ text: string }> };
  return JSON.parse(body.content[0].text);
}

function appRow(tokenHash: string, id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    user_email: 'owner@example.com',
    workspace_id: 'ws-app',
    kind: 'app',
    label: 'ci bot',
    // P-003: an app key is default-deny, so the fixture key lists the one tool it calls.
    scopes: { capabilities: ['harness:read'], tools: ['fix:app-whoami'] },
    limits: {},
    paired_at: new Date('2026-09-29T00:00:00Z'),
    expires_at: null,
    paused_at: null,
    revoked_at: null,
    last_seen: null,
    last_ip: null,
    token_hash: tokenHash,
    // P-010 (D-025): verifyAppKey reads the workspace's Remote access switch with the key and
    // fails closed without it; this fixture's workspace has remote access on.
    remote_access_enabled: true,
    ...over,
  };
}

let minted: ReturnType<typeof mintAppKey>;

beforeEach(() => {
  _resetProjectionRegistryForTests();
  registerProjectedTool(whoamiTool());
  minted = mintAppKey();
  db.row = appRow(minted.tokenHash, minted.id);
});

describe('R-2 — an app key works over HTTP', () => {
  it('a valid key reaches a blueprint operation through /api/agent-tools as app:<id> in its own workspace', async () => {
    const echoed = await callWhoami(minted.key);
    expect(echoed).toEqual({ slug: `app:${minted.id}`, workspace: 'ws-app' });
  });

  it('requirePrincipal resolves a valid key to a verified service principal with the key capabilities', async () => {
    const principal = await requirePrincipal(new Headers({ authorization: `Bearer ${minted.key}` }));
    expect(principal).toMatchObject({
      kind: 'service',
      slug: `app:${minted.id}`,
      workspaceId: 'ws-app',
      authMethod: 'bearer-token',
      trust: 'verified',
      label: 'ci bot',
    });
    expect([...principal.capabilities]).toEqual(['harness:read']);
  });
});

describe('R-25 — pause and revoke stop a key', () => {
  const refusals: Array<[string, Record<string, unknown>]> = [
    ['paused', { paused_at: new Date() }],
    ['revoked', { revoked_at: new Date() }],
    ['expired', { expires_at: new Date(Date.now() - 1000) }],
  ];

  for (const [reason, over] of refusals) {
    it(`a ${reason} key no longer acts as the app over HTTP`, async () => {
      db.row = appRow(minted.tokenHash, minted.id, over);
      expect(await callWhoami(minted.key)).toEqual({ slug: null, workspace: null });
    });

    it(`a ${reason} key is a 401 from requirePrincipal, naming the reason`, async () => {
      db.row = appRow(minted.tokenHash, minted.id, over);
      const err = await requirePrincipal(new Headers({ authorization: `Bearer ${minted.key}` })).catch((e) => e);
      expect(err).toBeInstanceOf(PrincipalCheckError);
      expect(err.status).toBe(401);
      expect(err.reason).toBe(`app key refused: ${reason}`);
    });
  }

  it('a resumed key (paused_at cleared) works again', async () => {
    db.row = appRow(minted.tokenHash, minted.id, { paused_at: null });
    expect((await callWhoami(minted.key)).slug).toBe(`app:${minted.id}`);
  });

  it('a key whose secret does not match the stored hash is refused', async () => {
    const other = mintAppKey();
    const forged = `pcapp_${minted.id}_${other.key.split('_').slice(2).join('_')}`;
    const err = await requirePrincipal(new Headers({ authorization: `Bearer ${forged}` })).catch((e) => e);
    expect(err).toBeInstanceOf(PrincipalCheckError);
    expect(err.reason).toBe('app key refused: mismatch');
  });

  it('a refused key on a loopback request does NOT fall through to loopback trust (D-015)', async () => {
    db.row = appRow(minted.tokenHash, minted.id, { revoked_at: new Date() });
    const headers = new Headers({ host: '127.0.0.1:3070', authorization: `Bearer ${minted.key}` });
    await expect(requirePrincipal(headers)).rejects.toMatchObject({ status: 401 });
    expect(await tryResolvePrincipal(headers)).toBeNull();
  });

  it('a request with no app key still reaches the rest of the chain (loopback here)', async () => {
    const principal = await tryResolvePrincipal(new Headers({ host: '127.0.0.1:3070' }));
    expect(principal?.kind).toBe('loopback');
  });
});
