---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/host-authority-recovery-20261027/fixture.ts"
updated_at: 1793066155161
_body: "content"
---

/** P001 contributing host-authority capture. Real SDK, authentication, signing,
 * persisted private PG authority, context builder and memory dispatcher.
 * Controlled recall backend; no production middleware, RLS or browser claim.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const seams = vi.hoisted(() => ({ sql: null as Sql | null,
  orm: null as ReturnType<typeof drizzle> | null, scopes: [] as string[][] }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: seams.sql, db: seams.orm }),
  getOrgPgListener: () => ({ sql: {} }), // No LISTEN/NOTIFY witness.
  withWorkspace: async (workspace: string, callback: (tx: unknown) => Promise<unknown>) =>
    seams.sql!.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return callback(tx);
    }),
}));
vi.mock('../../memory/backend', async original => ({
  ...await original<typeof import('../../memory/backend')>(),
  getMemoryBackend: () => ({ scoreScale: 'cosine', available: async () => ({ ok: true }),
    search: async (_query: string, options: { scope: string | readonly string[] }) => {
      const scopes = typeof options.scope === 'string' ? [options.scope] : [...options.scope];
      seams.scopes.push(scopes);
      return scopes.filter(scope => scope === 'p001-authority-default').map(scope =>
        ({ id: scope + '-hit', text: 'authority sentinel', scope, score: 0.9 }));
    } }),
}));
vi.mock('@papercusp/flags/server', async original => ({
  ...await original<typeof import('@papercusp/flags/server')>(), getFlag: async () => false,
}));
vi.mock('../../memory/feedback-rerank', async original => ({
  ...await original<typeof import('../../memory/feedback-rerank')>(),
  loadFeedbackSignals: async () => ({ tombstonedIds: new Set(), deletedContent: [] }),
  applyFeedbackRerank: <T>(hits: T) => hits,
}));
vi.mock('../../memory/surfaced-outcomes', async original => ({
  ...await original<typeof import('../../memory/surfaced-outcomes')>(), loadOutcomeCounts: async () => new Map(),
}));
vi.mock('../../projected-tool-deps', async original => ({
  ...await original<typeof import('../../projected-tool-deps')>(), PROJECTED_DEPS: {},
}));
vi.mock('../../connected-apps/alerts', async original => ({
  ...await original<typeof import('../../connected-apps/alerts')>(), onAppKeyUsed: async () => {},
})); // Alerts/telemetry are outside this authority fixture.

import './search';
import { tryBuildSpawnContext, __buildMcpToolContext_forTests } from '../../endpoint-route/routes/transport/_mcp-host';
import { mintAccessToken, _resetPowerUserTokenKeyCache } from '../../power-user-token';
import { signSpawnParams, _resetSpawnSigningKeyCache, _resetVerifiedSpawns } from '../../spawn-signing';
import { mintAppKey } from '../../connected-apps/key';

const WS = 'p001-host-authority';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourcePaths = [
  'packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts',
  'packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts',
  'packages/operator-core/lib/endpoint-route/routes/transport/role-principal-caps.ts',
  'packages/operator-core/lib/superuser-token.ts', 'packages/operator-core/lib/power-user-token.ts',
  'packages/operator-core/lib/spawn-signing.ts', 'packages/operator-core/lib/connected-apps/key.ts',
  'packages/operator-core/lib/connected-apps/principal.ts', 'packages/operator-core/lib/connected-apps/store.ts',
  'packages/operator-core/lib/agent-tools/memory/search.ts',
  'libs/generic/tooldef/src/dispatch-stack.ts',
];
const receipts: unknown[] = [];
const completed = new Set<string>();
let db: FreshPgDb;
let ormSql: Sql;
let home: string;
let superuserToken: string;
let pins: Array<{ path: string; sha256: string }>;
type Rpc = { result: { isError?: boolean; content: Array<{ text: string }>;
  structuredContent?: { ok: boolean; results: Array<{ id: string }> } } };

async function call(query: string, token = '', remote = false): Promise<Rpc> {
  const require = createRequire(import.meta.url);
  const fromHandler = createRequire(require.resolve('mcp-handler'));
  const { WebStandardStreamableHTTPServerTransport } = await import(pathToFileURL(
    fromHandler.resolve('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')).href);
  const { Server } = await import(pathToFileURL(fromHandler.resolve('@modelcontextprotocol/sdk/server/index.js')).href);
  const { CallToolRequestSchema } = await import(pathToFileURL(fromHandler.resolve('@modelcontextprotocol/sdk/types.js')).href);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = new Server({ name: 'p001-host-authority', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { arguments?: Record<string, unknown> } }, extra: unknown) => {
    const auth = await tryBuildSpawnContext(extra);
    if (auth.kind !== 'ok') {
      receipts.push({ phase: 'refusal', auth, backendCalls: seams.scopes.length });
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(auth) }] };
    }
    const ctx = await __buildMcpToolContext_forTests(auth.ctx, undefined, undefined, 'agent-mcp', 'json', true);
    receipts.push({ phase: 'authority', workspace: ctx.workspaceId, role: ctx.role,
      superuser: auth.ctx.isSuperuser === true, powerUser: auth.ctx.isPowerUser === true,
      signed: auth.ctx.sigVerifiedSpawn === true,
      principal: ctx.principal && { kind: ctx.principal.kind, slug: ctx.principal.slug,
        workspace: ctx.principal.workspaceId, capabilities: [...ctx.principal.capabilities] } });
    return ctx.dispatchTool!('memory:search', request.params.arguments ?? {});
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(new Request('http://127.0.0.1:3170/api/mcp' + query, {
      method: 'POST', headers: { host: '127.0.0.1:3170', 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(remote ? { 'x-forwarded-for': '203.0.113.1' } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'memory:search', arguments: { query: 'authority sentinel', limit: 5 } } }),
    }));
    expect(response.status).toBe(200);
    const rpc = await response.json() as Rpc;
    receipts.push({ phase: 'dispatch', rpc, scopes: seams.scopes.map(scope => [...scope]) });
    return rpc;
  } finally { await server.close(); }
}

function permitted(rpc: Rpc) {
  expect(rpc.result.isError, JSON.stringify(rpc)).not.toBe(true);
  expect(rpc.result.structuredContent).toMatchObject({ ok: true,
    results: [{ id: 'p001-authority-default-hit' }] });
}
function refused(rpc: Rpc, reason: string) {
  expect(rpc.result.isError, JSON.stringify(rpc)).toBe(true);
  expect(JSON.stringify(rpc)).toContain(reason);
}
async function app(capabilities = ['memory:search:read']) {
  const minted = mintAppKey();
  await db.sql`INSERT INTO harness_shared.connected_apps (id,user_email,workspace_id,kind,label,scopes,token_hash)
    VALUES (${minted.id},'fixture@example.invalid',${WS},'app','P001 fixture',
      ${db.sql.json({ capabilities, tools: ['memory:search'] })},${minted.tokenHash})`;
  return minted;
}
async function signed() {
  const params = new URLSearchParams({ workspace: WS, harness: '*', role: 'operator',
    run: randomUUID(), spawn: 'p001-' + randomUUID() });
  await signSpawnParams(params, { ttlSec: 3600 });
  return params;
}

beforeAll(async () => {
  pins = sourcePaths.map(path => ({ path, sha256: sha(readFileSync(new URL('../../../../../' + path, import.meta.url))) }));
  db = await createFreshPgDb('p001-host-authority'); // Setup failure fails; no passing early returns.
  seams.sql = db.sql;
  // Drizzle installs identity serializers. Keep raw SQL/telemetry's JSON and
  // timestamp serializers intact by using a distinct client for ORM calls.
  ormSql = postgres(db.url, { max: 4, prepare: false, onnotice: () => {} });
  seams.orm = drizzle(ormSql);
  home = mkdtempSync(join(tmpdir(), 'p001-host-authority-'));
  superuserToken = randomBytes(32).toString('hex');
  writeFileSync(join(home, 'superuser-token'), superuserToken, { mode: 0o600 });
  vi.stubEnv('PAPERCUSP_HOME', home);
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.operator_secrets (name text PRIMARY KEY,value_b64 text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),rotated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE harness_shared.users (id text PRIMARY KEY DEFAULT gen_random_uuid()::text,username text UNIQUE,
      display_name text,password_hash text,is_active boolean DEFAULT true);
    CREATE TABLE harness_shared.harness_registry (workspace_id text PRIMARY KEY,payload jsonb);
    CREATE TABLE harness_shared.blueprint_package_installations (workspace_id text,dependent_id text,owner_id text,phase text);
    CREATE TABLE harness_shared.blueprint_package_dependents (workspace_id text,dependent_id text,resource_key text,phase text);
    CREATE TABLE harness_shared.blueprint_package_resources (workspace_id text,resource_key text,phase text,resource_kind text);
    CREATE TABLE harness_shared.connected_apps (id text PRIMARY KEY,user_email text,workspace_id text,kind text,label text,
      scopes jsonb,limits jsonb DEFAULT '{}',paired_at timestamptz DEFAULT now(),expires_at timestamptz,paused_at timestamptz,
      revoked_at timestamptz,last_seen timestamptz,last_ip text,spend_cap_cents bigint,spend_cap_window_sec integer,
      rotated_at timestamptz,previous_token_valid_until timestamptz,client_auth text,token_hash text,previous_token_hash text);
    CREATE TABLE harness_shared.connected_app_access_settings (workspace_id text PRIMARY KEY,enabled boolean);
    CREATE TABLE harness_shared.connected_app_auth_failures (app_id text,workspace_id text,hour timestamptz,
      failures integer,last_reason text,last_at timestamptz,PRIMARY KEY(app_id,hour));
    CREATE TABLE harness_shared.system_principals (workspace_id text,name text,capabilities jsonb,
      PRIMARY KEY(workspace_id,name));
    CREATE TABLE harness_shared.spawn_sig_verification_failures (id bigserial PRIMARY KEY,ts timestamptz DEFAULT now(),
      reason text,claimed_role text,claimed_harness text,claimed_workspace text,claimed_spawn text,
      exp_claim bigint,remote_addr text,user_agent text,classification text);
    CREATE TABLE harness_shared.memory_recall_stats (id bigserial PRIMARY KEY,surface text,hit_count integer,
      top_score double precision,scores jsonb,fragment_count integer,pools jsonb,workspace_id text,pot_slug text,
      score_scale text,query_chars integer,query_sha256 text,query_origin text,session_id text,legs jsonb,admission jsonb,
      client text,top_cosine_score double precision,cosine_scores jsonb);`);
}, 60_000);

beforeEach(async () => {
  _resetPowerUserTokenKeyCache(); _resetSpawnSigningKeyCache(); _resetVerifiedSpawns();
  seams.scopes.length = 0;
  await db.sql.unsafe(`TRUNCATE harness_shared.operator_secrets,harness_shared.users,harness_shared.harness_registry,
    harness_shared.connected_apps,harness_shared.connected_app_access_settings,
    harness_shared.connected_app_auth_failures,harness_shared.system_principals,
    harness_shared.spawn_sig_verification_failures,harness_shared.memory_recall_stats`);
  await db.sql`INSERT INTO harness_shared.users (id,username,display_name,is_active)
    VALUES ('p001-authority-default','default','Default',true)`;
  await db.sql`INSERT INTO harness_shared.harness_registry VALUES (${WS},${db.sql.json({ projects: [] })})`;
  await db.sql`INSERT INTO harness_shared.system_principals VALUES
    (${WS},'operator',${db.sql.json(['memory:search:read'])})`;
  // A preflight guard for the mixed raw/ORM fixture's serializer boundary.
  const [roundTrip] = await db.sql`SELECT ${db.sql.json({ fixture: true })}::jsonb AS payload,
    ${new Date('2026-01-01T00:00:00Z')}::timestamptz AS at`;
  expect(roundTrip.payload).toEqual({ fixture: true });
  expect(new Date(roundTrip.at).toISOString()).toBe('2026-01-01T00:00:00.000Z');
});

describe('P001 actual additional host authority branches', () => {
  it('admits a local SU file credential and refuses a wrong or remote credential before recall', async () => {
    const query = '?superuser=1&workspace=' + WS;
    permitted(await call(query, superuserToken));
    expect(seams.scopes).toEqual([['p001-authority-default']]);
    refused(await call(query, 'wrong-private-fixture-token'), 'superuser_invalid_bearer');
    refused(await call(query, superuserToken, true), 'superuser_non_loopback');
    expect(seams.scopes).toHaveLength(1);
    completed.add('superuser');
  });

  it('clamps a real power-user HMAC to its workspace and refuses expiry, tampering and remote ingress', async () => {
    const claims = { workspaceId: WS, userId: 'p001-authority-default', authSessionId: 'p001-power' };
    const { token } = await mintAccessToken(claims);
    permitted(await call('?power_user=1&workspace=foreign', token));
    expect(receipts).toContainEqual(expect.objectContaining({ phase: 'authority', workspace: WS, powerUser: true }));
    refused(await call('?power_user=1', token + 'x'), 'power_user_invalid_token');
    refused(await call('?power_user=1', (await mintAccessToken({ ...claims, ttlSec: -1 })).token), 'power_user_invalid_token');
    refused(await call('?power_user=1', token, true), 'power_user_non_loopback');
    expect(seams.scopes).toEqual([['p001-authority-default']]);
    completed.add('power-user');
  });

  it('uses persisted app grants and rejects missing capability, foreign scope and revocation before recall', async () => {
    const minted = await app();
    permitted(await call('?workspace=' + WS, minted.key));
    refused(await call('?workspace=foreign', minted.key), 'connected_app_workspace_mismatch');
    refused(await call('?role=operator', minted.key), 'connected_app_forbidden_param:role');
    refused(await call('', (await app([])).key), 'missing_capability');
    await db.sql`UPDATE harness_shared.connected_apps SET revoked_at=now() WHERE id=${minted.id}`;
    refused(await call('', minted.key), 'connected_app_invalid_key:revoked');
    expect(seams.scopes).toEqual([['p001-authority-default']]);
    completed.add('connected-app');
  });

  it('verifies a real signed spawn and refuses a changed authority field before recall', async () => {
    const incident = vi.spyOn(console, 'error').mockImplementation(() => {});
    const params = await signed();
    permitted(await call('?' + params));
    expect(receipts).toContainEqual(expect.objectContaining({ phase: 'authority', workspace: WS, signed: true }));
    params.set('workspace', 'foreign');
    refused(await call('?' + params), 'spawn_sig_invalid_signature');
    expect(incident).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('[spawn-signing][INCIDENT] rotation_strand'));
    incident.mockRestore();
    expect(seams.scopes).toEqual([['p001-authority-default']]);
    completed.add('signed-spawn');
  });

  it('re-reads a changed persisted power signing epoch without resetting its process cache', async () => {
    const claims = { workspaceId: WS, userId: 'p001-authority-default', authSessionId: 'p001-power-epoch' };
    const { token } = await mintAccessToken(claims);
    permitted(await call('?power_user=1', token));
    await db.sql`UPDATE harness_shared.operator_secrets SET value_b64=${randomBytes(32).toString('base64')},
      rotated_at=rotated_at + interval '1 second' WHERE name='power-user-token-key'`;
    refused(await call('?power_user=1', token), 'power_user_invalid_token');
    permitted(await call('?power_user=1', (await mintAccessToken(claims)).token));
    expect(seams.scopes).toEqual([['p001-authority-default'], ['p001-authority-default']]);
    completed.add('power-key-epoch');
  });

  it('re-reads a changed persisted spawn signing epoch without resetting its process cache', async () => {
    const incident = vi.spyOn(console, 'error').mockImplementation(() => {});
    const params = await signed();
    permitted(await call('?' + params));
    await db.sql`UPDATE harness_shared.operator_secrets SET value_b64=${randomBytes(32).toString('base64')},
      rotated_at=rotated_at + interval '1 second' WHERE name='spawn-signing-key'`;
    refused(await call('?' + params), 'spawn_sig_invalid_signature');
    permitted(await call('?' + await signed()));
    expect(incident).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('[spawn-signing][INCIDENT] rotation_strand'));
    incident.mockRestore();
    expect(seams.scopes).toEqual([['p001-authority-default'], ['p001-authority-default']]);
    completed.add('spawn-key-epoch');
  });
});

afterAll(async () => {
  let sourceStable = false;
  let cleanup = 'not-attempted';
  try {
    const after = sourcePaths.map(path => ({ path, sha256: sha(readFileSync(new URL('../../../../../' + path, import.meta.url))) }));
    sourceStable = JSON.stringify(after) === JSON.stringify(pins);
    expect(after).toEqual(pins);
    expect([...completed].sort()).toEqual(['superuser', 'power-user', 'connected-app', 'signed-spawn',
      'power-key-epoch', 'spawn-key-epoch'].sort());
  } finally {
    try {
      _resetPowerUserTokenKeyCache(); _resetSpawnSigningKeyCache(); _resetVerifiedSpawns();
      vi.unstubAllEnvs();
      if (home) rmSync(home, { recursive: true, force: true });
      await ormSql?.end({ timeout: 5 });
      await db?.cleanup(); cleanup = 'dropped';
    } finally {
      if (process.env.PAPERCUSP_P001_HOST_AUTHORITY_CAPTURE_OUT) writeFileSync(process.env.PAPERCUSP_P001_HOST_AUTHORITY_CAPTURE_OUT,
        JSON.stringify({ schemaVersion: 'p001-host-authority-capture-v1', sourcePins: pins, sourceStable, cleanup,
          completed: [...completed], receipts, limitations: [
            'Private admin PG and projected schema; no production middleware or RLS proof.',
            'Fixture SDK callback calls real host auth/context/dispatch; not registerMcpHost or browser HTTP.',
            'Controlled backend, flags and ranking; operator kernel/quota/telemetry and app alerts omitted.',
            'Persisted key epoch changes in one process; no independent-process, TTL or NOTIFY proof.',
            'SU fixture has no coordinated SID/native-session binding; those controls remain unqualified.',
            'No field/provider/index/quality/budget/runtime qualification or spec-binding upgrade.',
          ] }, null, 2));
    }
  }
}, 30_000);

