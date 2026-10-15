/**
 * OAuth client-credentials grant (external-app-access-to-workspaces-2026-09-29 P-016, D-022).
 *
 *   R-15  every access token has a finite expiry: at most one hour, never after the client itself.
 *   R-35  a token never carries scope the client does not hold; a request for more is invalid_scope.
 *
 * Plus the rules around them: the client's own secret is refused as a bearer, revoking / pausing /
 * leaving client-credentials mode ends live tokens, a signed assertion is accepted once, and the
 * dispatch seat applies a narrowed token's scope on top of the client's.
 */
import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { KernelEnforcementRequest } from '@papercusp/agent-mcp';
import {
  CLIENT_CREDENTIALS_TOKEN_TTL_SEC,
  JWT_BEARER_ASSERTION_TYPE,
  accessTokenExpiry,
  handleClientCredentialsGrant,
  narrowClientScopes,
  validateClientJwk,
  type ClientCredentialsStore,
  type ClientKeyRow,
} from './client-credentials';
import { appKeyToolListFilter, enforceAppKeyScope } from './enforce';
import { mintAccessToken, mintAppKey } from './key';
import { accessTokenVerdictOf, appKeyVerdictOf, type AppKeyRow, type AppKeyScopes } from './store';
import type { AppScopeRow } from './scope-policy';

const NOW = new Date('2026-09-30T09:00:00Z');
const AUDIENCE = 'https://machine.example/api/connected-apps/oauth/token';

function clientRow(over: Partial<ClientKeyRow> = {}): { row: ClientKeyRow; key: string } {
  const minted = mintAppKey();
  const row: ClientKeyRow = {
    id: minted.id,
    user_email: 'local@desktop',
    workspace_id: 'ws-1',
    kind: 'service',
    label: 'nightly sync',
    scopes: { capabilities: [], tools: ['plans:*', 'work_items:get'] },
    limits: {},
    paired_at: new Date('2026-09-01T00:00:00Z'),
    expires_at: null,
    paused_at: null,
    revoked_at: null,
    last_seen: null,
    last_ip: null,
    spend_cap_cents: 500,
    spend_cap_window_sec: null,
    rotated_at: null,
    previous_token_valid_until: null,
    client_auth: 'client_secret',
    token_hash: minted.tokenHash,
    previous_token_hash: null,
    client_jwk: null,
    remote_access_enabled: true,
    ...over,
  };
  return { row, key: minted.key };
}

function memoryStore(rows: ClientKeyRow[]) {
  const issued: { app: AppKeyRow; scopes: AppKeyScopes; expiresAt: Date; token: string }[] = [];
  const jtis = new Set<string>();
  const store: ClientCredentialsStore = {
    async loadClient(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async rememberAssertion({ appId, jti }) {
      const k = `${appId}:${jti}`;
      if (jtis.has(k)) return false;
      jtis.add(k);
      return true;
    },
    async issueToken({ app, scopes, expiresAt }) {
      const token = mintAccessToken().key;
      issued.push({ app, scopes, expiresAt, token });
      return token;
    },
  };
  return { store, issued };
}

const grant = (store: ClientCredentialsStore, fields: Record<string, string>, basic: { id: string; secret: string } | null = null) =>
  handleClientCredentialsGrant({ fields: { grant_type: 'client_credentials', ...fields }, basic, audience: AUDIENCE, now: NOW, store });

describe('R-15: access tokens always expire', () => {
  it('issues a token that expires within the one-hour TTL', async () => {
    const { row, key } = clientRow();
    const { store, issued } = memoryStore([row]);
    const answer = await grant(store, {}, { id: row.id, secret: key });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ token_type: 'Bearer', expires_in: CLIENT_CREDENTIALS_TOKEN_TTL_SEC });
    expect(String(answer.body.access_token)).toMatch(/^pcat_[A-Za-z0-9]{16}_[A-Za-z0-9_-]{43}$/);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.expiresAt.getTime() - NOW.getTime()).toBe(CLIENT_CREDENTIALS_TOKEN_TTL_SEC * 1000);
  });

  it('never outlives the client: a client expiring in ten minutes gets a ten-minute token', async () => {
    const { row, key } = clientRow({ expires_at: new Date(NOW.getTime() + 600_000) });
    const { store, issued } = memoryStore([row]);
    const answer = await grant(store, {}, { id: row.id, secret: key });
    expect(answer.body.expires_in).toBe(600);
    expect(issued[0]!.expiresAt.toISOString()).toBe(row.expires_at!.toISOString());
    expect(accessTokenExpiry({ expires_at: null }, NOW).getTime()).toBeLessThan(Infinity);
  });

  it('a token past its expiry is refused on use', () => {
    const { row } = clientRow();
    const t = mintAccessToken();
    const stored = { id: t.id, token_hash: t.tokenHash, app_id: row.id, scopes: row.scopes, expires_at: new Date(NOW.getTime() - 1) };
    expect(accessTokenVerdictOf(stored, row, t.key, NOW)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('R-35: no scope beyond the client', () => {
  it('refuses a tool the client does not hold, and a whole group behind an exact grant', async () => {
    const { row, key } = clientRow();
    const { store, issued } = memoryStore([row]);
    for (const scope of ['tool:work_items:list', 'tool:work_items:*', 'tool:plans:get tool:harness:list']) {
      const answer = await grant(store, { scope }, { id: row.id, secret: key });
      expect(answer).toMatchObject({ status: 400, body: { error: 'invalid_scope' } });
    }
    expect(issued).toHaveLength(0);
  });

  it('refuses a harness outside a harness-limited client', () => {
    expect(narrowClientScopes({ tools: ['plans:get'], harnesses: ['alpha'] }, { harnesses: ['beta'] })).toMatchObject({ ok: false });
  });

  it('narrows to what was asked for, and reports it', async () => {
    const { row, key } = clientRow();
    const { store, issued } = memoryStore([row]);
    const answer = await grant(store, { scope: 'tool:plans:get harness:alpha' }, { id: row.id, secret: key });
    expect(answer).toMatchObject({ status: 200, body: { scope: 'tool:plans:get harness:alpha' } });
    expect(issued[0]!.scopes).toEqual({ capabilities: [], tools: ['plans:get'], harnesses: ['alpha'] });
  });

  it('with no scope parameter the token carries exactly the client scope', async () => {
    const { row, key } = clientRow();
    const { store, issued } = memoryStore([row]);
    await grant(store, {}, { id: row.id, secret: key });
    expect(issued[0]!.scopes).toEqual({ capabilities: [], tools: ['plans:*', 'work_items:get'] });
  });
});

describe('client authentication', () => {
  it('accepts client_secret_post as well as basic, but not both at once', async () => {
    const { row, key } = clientRow();
    const { store } = memoryStore([row]);
    expect((await grant(store, { client_id: row.id, client_secret: key })).status).toBe(200);
    expect(await grant(store, { client_secret: key }, { id: row.id, secret: key })).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
  });

  it('refuses a wrong secret, a key not in client-credentials mode, and a paused or revoked client', async () => {
    const { row, key } = clientRow();
    const other = mintAppKey().key;
    for (const [candidate, secret] of [
      [row, other],
      [{ ...row, client_auth: null }, key],
      [{ ...row, paused_at: NOW }, key],
      [{ ...row, revoked_at: NOW }, key],
      [{ ...row, kind: 'app' as const }, key],
    ] as const) {
      const { store } = memoryStore([candidate as ClientKeyRow]);
      expect(await grant(store, {}, { id: row.id, secret })).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    }
  });

  it('refuses the client secret as a bearer; only the token endpoint accepts it', () => {
    const { row, key } = clientRow();
    expect(appKeyVerdictOf(row, key, NOW)).toEqual({ ok: false, reason: 'token_endpoint_only' });
    expect(appKeyVerdictOf(row, key, NOW, { at: 'token-endpoint' })).toMatchObject({ ok: true });
    expect(appKeyVerdictOf({ ...row, client_auth: null }, key, NOW)).toMatchObject({ ok: true });
  });
});

describe('a token re-checks its client on every use', () => {
  const setup = () => {
    const { row } = clientRow();
    const t = mintAccessToken();
    const stored = { id: t.id, token_hash: t.tokenHash, app_id: row.id, scopes: { tools: ['plans:get'] }, expires_at: new Date(NOW.getTime() + 3_600_000) };
    return { row, t, stored };
  };

  it('a live token authenticates as its client, carrying its own scope', () => {
    const { row, t, stored } = setup();
    expect(accessTokenVerdictOf(stored, row, t.key, NOW)).toMatchObject({
      ok: true,
      app: { id: row.id },
      accessToken: { id: t.id, scopes: { tools: ['plans:get'] } },
    });
  });

  it('revoking, pausing, expiring or leaving client-credentials mode ends it', () => {
    const { row, t, stored } = setup();
    expect(accessTokenVerdictOf(stored, { ...row, revoked_at: NOW }, t.key, NOW)).toEqual({ ok: false, reason: 'revoked' });
    expect(accessTokenVerdictOf(stored, { ...row, paused_at: NOW }, t.key, NOW)).toEqual({ ok: false, reason: 'paused' });
    expect(accessTokenVerdictOf(stored, { ...row, expires_at: NOW }, t.key, NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(accessTokenVerdictOf(stored, { ...row, client_auth: null }, t.key, NOW)).toEqual({ ok: false, reason: 'revoked' });
    expect(accessTokenVerdictOf(stored, null, t.key, NOW)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses a wrong secret for a real token id', () => {
    const { row, t, stored } = setup();
    const forged = `${t.key.slice(0, 'pcat_'.length + 17)}${'A'.repeat(43)}`;
    expect(accessTokenVerdictOf(stored, row, forged, NOW)).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('private_key_jwt (RFC 7523)', () => {
  async function jwtClient() {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const checked = await validateClientJwk(await exportJWK(publicKey));
    if (!checked.ok) throw new Error(checked.problem);
    const { row } = clientRow({ client_auth: 'private_key_jwt', client_jwk: checked.jwk });
    const sign = (claims: { aud?: string; jti?: string; expSec?: number } = {}) =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer(row.id)
        .setSubject(row.id)
        .setAudience(claims.aud ?? AUDIENCE)
        .setJti(claims.jti ?? 'jti-1')
        .setIssuedAt(Math.floor(NOW.getTime() / 1000))
        .setExpirationTime(Math.floor(NOW.getTime() / 1000) + (claims.expSec ?? 120))
        .sign(privateKey);
    return { row, sign, privateJwk: await exportJWK(privateKey) };
  }
  const assertionFields = (assertion: string) => ({ client_assertion_type: JWT_BEARER_ASSERTION_TYPE, client_assertion: assertion });

  it('issues a token for a valid assertion and refuses the same assertion again', async () => {
    const { row, sign } = await jwtClient();
    const { store } = memoryStore([row]);
    const assertion = await sign();
    expect((await grant(store, assertionFields(assertion))).status).toBe(200);
    expect(await grant(store, assertionFields(assertion))).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
  });

  it('refuses a wrong audience and an assertion that lives too long', async () => {
    const { row, sign } = await jwtClient();
    const { store } = memoryStore([row]);
    expect((await grant(store, assertionFields(await sign({ aud: 'https://elsewhere.example/token', jti: 'a' })))).status).toBe(401);
    expect((await grant(store, assertionFields(await sign({ expSec: 3600, jti: 'b' })))).status).toBe(401);
  });

  it('refuses the key\'s secret for a signed-assertion client', async () => {
    const { row: base } = await jwtClient();
    const minted = mintAppKey(base.id);
    const row = { ...base, token_hash: minted.tokenHash };
    const { store } = memoryStore([row]);
    expect((await grant(store, {}, { id: row.id, secret: minted.key })).status).toBe(401);
  });

  it('registers only a public key', async () => {
    const { privateJwk } = await jwtClient();
    expect(await validateClientJwk(privateJwk)).toMatchObject({ ok: false });
    expect(await validateClientJwk({ kty: 'oct', k: 'c2VjcmV0' })).toMatchObject({ ok: false });
  });
});

describe('the dispatch seat applies the token scope on top of the client scope', () => {
  const parent: AppScopeRow = { id: 'k'.repeat(16), workspace_id: 'ws-1', scopes: { tools: ['plans:*'] }, revoked_at: null, paused_at: null, expires_at: null };
  const tokenRow: AppScopeRow = { ...parent, scopes: { tools: ['plans:get'] } };
  const call = (toolName: string, slug: string, withTokenLoader = true) =>
    enforceAppKeyScope(
      { toolName, capabilities: [], boundary: 'http', args: {}, ctx: { principal: { slug, workspaceId: 'ws-1' }, workspaceId: 'ws-1' } } as unknown as KernelEnforcementRequest,
      {
        loadRow: async (id) => (id === parent.id ? parent : null),
        ...(withTokenLoader ? { loadAccessTokenRow: async (tokenId: string, appId: string) => (tokenId === 't'.repeat(16) && appId === parent.id ? tokenRow : null) } : {}),
        lookupTool: (name) => ({ name, capabilities: [] }),
        now: () => NOW,
      },
    );
  const tokenSlug = `app:${parent.id}/${'t'.repeat(16)}`;

  it('allows what both allow and refuses what only the client allows', async () => {
    expect(await call('plans:get', tokenSlug)).toBeNull();
    expect(await call('plans:list', tokenSlug)).toMatchObject({ decision: 'deny', code: 'app_scope:tool_not_in_scope' });
    expect(await call('plans:list', `app:${parent.id}`)).toBeNull();
  });

  it('fails closed on an unknown token or a seat without a token loader', async () => {
    expect(await call('plans:get', `app:${parent.id}/${'u'.repeat(16)}`)).toMatchObject({ code: 'app_scope:key_unknown' });
    expect(await call('plans:get', tokenSlug, false)).toMatchObject({ code: 'app_scope:key_unknown' });
    expect(await call('plans:get', `app:${parent.id}/`)).toMatchObject({ code: 'app_scope:key_unknown' });
  });
});

describe('parent/token chain listing and invocation use the same restrictions', () => {
  const parent: AppScopeRow = { id: 'p'.repeat(16), workspace_id: 'ws-1', scopes: { tools: ['plans:*'], harnesses: ['approved'] }, revoked_at: null, paused_at: null, expires_at: null };
  const token: AppScopeRow = { ...parent, id: 't'.repeat(16), scopes: { tools: ['plans:get'] } };
  const slug = `app:${parent.id}/${token.id}`;
  const deps = (child: AppScopeRow | null) => ({
    loadRow: async () => parent,
    loadAccessTokenRow: async () => child,
    lookupTool: (name: string) => ({ name, capabilities: [], acceptsHarness: true }),
    now: () => NOW,
  });
  const request = (args: Record<string, unknown>) => ({
    toolName: 'plans:get', capabilities: [], boundary: 'http', args,
    ctx: { principal: { slug, workspaceId: 'ws-1' }, workspaceId: 'ws-1' },
  }) as unknown as KernelEnforcementRequest;

  it('a visible harness-deferred tool is invoked only with an approved harness', async () => {
    const filter = await appKeyToolListFilter({ slug, workspaceId: 'ws-1' }, 'ws-1', deps(token));
    expect(filter?.('plans:get')).toBe(true);
    expect(filter?.('plans:list')).toBe(false);
    expect(await enforceAppKeyScope(request({}), deps(token))).toMatchObject({ code: 'app_scope:harness_required_by_scope' });
    expect(await enforceAppKeyScope(request({ harness: 'approved' }), deps(token))).toBeNull();
    expect(await enforceAppKeyScope(request({ harness: 'outside' }), deps(token))).toMatchObject({ code: 'app_scope:harness_not_in_scope' });
  });

  it.each([
    { revoked_at: NOW }, { expires_at: NOW }, { paused_at: NOW },
  ])('hides and denies a child restriction behind a harness-deferred parent: %j', async (restriction) => {
    const d = deps({ ...token, ...restriction });
    const filter = await appKeyToolListFilter({ slug, workspaceId: 'ws-1' }, 'ws-1', d);
    expect(filter?.('plans:get')).toBe(false);
    expect(await enforceAppKeyScope(request({ harness: 'approved' }), d)).toMatchObject({ decision: 'deny' });
  });

  it('hides and denies a missing child row', async () => {
    const d = deps(null);
    const filter = await appKeyToolListFilter({ slug, workspaceId: 'ws-1' }, 'ws-1', d);
    expect(filter?.('plans:get')).toBe(false);
    expect(await enforceAppKeyScope(request({ harness: 'approved' }), d)).toMatchObject({ code: 'app_scope:key_unknown' });
  });
});
