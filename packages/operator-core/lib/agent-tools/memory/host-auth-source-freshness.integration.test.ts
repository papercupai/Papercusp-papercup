/** P001 contributing identity capture. Real SDK carrier, host authentication,
 * context builder, dispatcher and cookie SQL; private admin PG and a controlled
 * memory backend. This does not qualify RLS, NOTIFY, browser binding or freshness.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const seams = vi.hoisted(() => ({ sql: null as Sql | null, scopes: [] as string[][] }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: seams.sql }),
  getOrgPgListener: () => ({ sql: {} }), // No LISTEN/NOTIFY claim.
  withWorkspace: async (workspace: string, callback: (tx: unknown) => Promise<unknown>) =>
    seams.sql!.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return callback(tx);
    }),
}));
vi.mock('../../memory/backend', async original => ({
  ...await original<typeof import('../../memory/backend')>(),
  getMemoryBackend: () => ({
    scoreScale: 'cosine', available: async () => ({ ok: true }),
    search: async (_query: string, options: { scope: string | readonly string[] }) => {
      const scopes = typeof options.scope === 'string' ? [options.scope] : [...options.scope];
      seams.scopes.push(scopes);
      return scopes.filter(scope => scope === 'p001-default' || scope === 'p001-browser')
        .map(scope => ({ id: scope + '-hit', text: 'host identity sentinel', scope, score: 0.9 }));
    },
  }),
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
// This unit measures the PI host/context boundary and generic capability gate.
// Operator kernel, quota and telemetry need their own migrated runtime fixture.
vi.mock('../../projected-tool-deps', async original => ({
  ...await original<typeof import('../../projected-tool-deps')>(), PROJECTED_DEPS: {},
}));

import './search';
import { tryBuildSpawnContext, __buildMcpToolContext_forTests } from '../../endpoint-route/routes/transport/_mcp-host';
import { invalidate, _resetAuthCacheForTests } from '../../../../agent-mcp/src/auth';
import { getSessionUser, getSessionUserOrDefault, SESSION_COOKIE, _resetLastSeenDebounceForTests } from '../../auth';

const WS = 'p001-host-auth';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const receipts: unknown[] = [];
const completed = new Set<string>();
const sources = [
  'packages/operator-core/lib/agent-tools/memory/host-auth-source-freshness.integration.test.ts',
  'packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts',
  'packages/operator-core/lib/endpoint-route/routes/transport/role-principal-caps.ts',
  'packages/operator-core/lib/auth.ts', 'packages/agent-mcp/src/auth.ts',
  'packages/operator-core/lib/agent-tools/memory/search.ts',
  'libs/generic/tooldef/src/define-tool.ts', 'libs/generic/tooldef/src/dispatch-projected.ts',
  'libs/generic/tooldef/src/dispatch-stack.ts',
];
let pins: Array<{ path: string; sha256: string }>;
let db: FreshPgDb;
type Rpc = { result: { isError?: boolean; content: Array<{ text: string }>;
  structuredContent?: { ok: boolean; results: Array<{ id: string }> } } };
interface Transport {
  handleRequest(request: Request): Promise<Response>;
  close(): Promise<void>;
}
interface Protocol {
  setRequestHandler(schema: unknown, handler: (request: { params: { arguments?: Record<string, unknown> } },
    extra: unknown) => Promise<unknown>): void;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

async function pi(name: string, capabilities = ['memory:search:read']) {
  const token = 'fixture-' + randomUUID();
  await db.sql`INSERT INTO harness_shared.token_index VALUES (${token},'pi',${'pi:' + name},${WS})`;
  await db.sql`INSERT INTO harness_shared.pi_sessions VALUES
    (${WS},${name},${sha(token)},${db.sql.json(capabilities)},NULL,NULL,now() + interval '1 hour')`;
  return token;
}

async function call(token: string, query = '?principal=pi&workspace=' + WS, cookie?: string): Promise<Rpc> {
  // Resolve the SDK exactly as the actual mcp-handler package does.
  const require = createRequire(import.meta.url);
  const fromHandler = createRequire(require.resolve('mcp-handler'));
  const transportModule = await import(pathToFileURL(fromHandler.resolve('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')).href);
  const serverModule = await import(pathToFileURL(fromHandler.resolve('@modelcontextprotocol/sdk/server/index.js')).href);
  const schemas = await import(pathToFileURL(fromHandler.resolve('@modelcontextprotocol/sdk/types.js')).href);
  const transport = new transportModule.WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined,
    enableJsonResponse: true }) as Transport;
  const server = new serverModule.Server({ name: 'p001-host-auth', version: '1' },
    { capabilities: { tools: {} } }) as Protocol;
  server.setRequestHandler(schemas.CallToolRequestSchema, async (request, extra) => {
    const auth = await tryBuildSpawnContext(extra);
    if (auth.kind !== 'ok') {
      receipts.push({ query, auth, backendCalls: seams.scopes.length });
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(auth) }] };
    }
    const ctx = await __buildMcpToolContext_forTests(auth.ctx, undefined, undefined, 'agent-mcp', 'json', true);
    receipts.push({ query, workspace: ctx.workspaceId, harness: ctx.harnessSlug, role: ctx.role,
      principal: ctx.principal && { kind: ctx.principal.kind, slug: ctx.principal.slug,
        workspace: ctx.principal.workspaceId, capabilities: [...ctx.principal.capabilities] } });
    return ctx.dispatchTool!('memory:search', request.params.arguments ?? {});
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(new Request('http://127.0.0.1:3170/api/mcp' + query, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + token, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'memory:search', arguments: { query: 'host identity sentinel', limit: 5 } } }),
    }));
    expect(response.status).toBe(200);
    const rpc = await response.json() as Rpc;
    receipts.push({ query, rpc, scopes: seams.scopes.map(scope => [...scope]) });
    return rpc;
  } finally {
    await server.close();
  }
}

beforeAll(async () => {
  pins = sources.map(path => ({ path, sha256: sha(readFileSync(new URL('../../../../../' + path, import.meta.url))) }));
  db = await createFreshPgDb('p001-host-auth'); // Setup failure fails this suite; no early-return skip.
  seams.sql = db.sql;
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.users (id text PRIMARY KEY DEFAULT gen_random_uuid()::text,username text UNIQUE,display_name text,
      password_hash text,is_active boolean DEFAULT true);
    CREATE TABLE harness_shared.user_sessions (token text PRIMARY KEY,user_id text,expires_at timestamptz,
      workspace_id text,capabilities text[],last_seen_at timestamptz);
    CREATE TABLE harness_shared.token_index (token text PRIMARY KEY,kind text,harness_slug text,workspace_id text);
    CREATE TABLE harness_shared.pi_sessions (workspace_id text,session_id text,bearer_hash text,
      capabilities jsonb,allowed_tools jsonb,ended_at timestamptz,expires_at timestamptz);
    CREATE TABLE harness_shared.harness_registry (workspace_id text PRIMARY KEY,payload jsonb);
    CREATE TABLE harness_shared.blueprint_package_installations (workspace_id text,dependent_id text,owner_id text,phase text);
    CREATE TABLE harness_shared.blueprint_package_dependents (workspace_id text,dependent_id text,resource_key text,phase text);
    CREATE TABLE harness_shared.blueprint_package_resources (workspace_id text,resource_key text,phase text,resource_kind text);
    CREATE TABLE harness_shared.memory_recall_stats (id bigserial PRIMARY KEY,surface text,hit_count integer,
      top_score double precision,scores jsonb,fragment_count integer,pools jsonb,workspace_id text,pot_slug text,
      score_scale text,query_chars integer,query_sha256 text,query_origin text,session_id text,legs jsonb,admission jsonb,
      client text,top_cosine_score double precision,cosine_scores jsonb);`);
}, 60_000);

beforeEach(async () => {
  await _resetAuthCacheForTests();
  _resetLastSeenDebounceForTests();
  seams.scopes.length = 0;
  await db.sql.unsafe(`TRUNCATE harness_shared.users,harness_shared.user_sessions,harness_shared.token_index,
    harness_shared.pi_sessions,harness_shared.harness_registry,harness_shared.memory_recall_stats`);
  await db.sql`INSERT INTO harness_shared.users (id,username,display_name) VALUES
    ('p001-default','default','Default'),('p001-browser','browser','Browser')`;
  await db.sql`INSERT INTO harness_shared.harness_registry VALUES (${WS},${db.sql.json({ projects: [] })})`;
});

describe('P001 SDK → host PI authentication → actual memory dispatcher', () => {
  it('carries persisted PI authority through the real context builder into default-user recall', async () => {
    const rpc = await call(await pi('reader'));
    expect(rpc.result.isError, JSON.stringify(rpc)).not.toBe(true);
    expect(rpc.result.structuredContent).toMatchObject({ ok: true, results: [{ id: 'p001-default-hit' }] });
    expect(seams.scopes).toEqual([['p001-default']]);
    completed.add('pi-host-dispatch');
  });

  it('distinguishes persisted cookie-user lookup from the SDK host default-user path', async () => {
    const token = 'private-browser-' + randomUUID();
    await db.sql`INSERT INTO harness_shared.user_sessions VALUES
      (${token},'p001-browser',now() + interval '1 hour',${WS},ARRAY['memory:search:read'],NULL)`;
    const cookie = SESSION_COOKIE + '=' + token;
    expect(await getSessionUser(new Headers({ cookie }))).toMatchObject({ id: 'p001-browser', workspace_id: WS });
    expect(await getSessionUserOrDefault()).toMatchObject({ id: 'p001-default' });
    const rpc = await call(await pi('cookie-reader'), undefined, cookie);
    expect(rpc.result.isError, JSON.stringify(rpc)).not.toBe(true);
    expect(rpc.result.structuredContent?.results.map(row => row.id), JSON.stringify(rpc)).toEqual(['p001-default-hit']);
    expect(seams.scopes).toEqual([['p001-default']]);
    await db.sql`UPDATE harness_shared.user_sessions SET expires_at=now() - interval '1 second'`;
    expect(await getSessionUser(new Headers({ cookie }))).toBeNull();
    receipts.push({ phase: 'cookie-vs-host', browserUser: 'p001-browser', hostUser: 'p001-default', expiredCookie: 'refused' });
    completed.add('cookie-vs-default');
  });

  it.each(['role=operator', 'harness=foreign', 'spawn=foreign', 'superuser=0', 'power_user=0'])
    ('refuses the PI authority override %s before recall', async parameter => {
      const rpc = await call(await pi('override'), '?principal=pi&workspace=' + WS + '&' + parameter);
      expect(rpc.result.isError).toBe(true);
      expect(rpc.result.content[0]!.text).toContain('pi_principal_forbidden_param:' + parameter.split('=')[0]);
      expect(seams.scopes).toEqual([]);
      completed.add('override:' + parameter);
    });

  it('refuses foreign workspace and missing capability before recall', async () => {
    const token = await pi('denied', []);
    const foreign = await call(token, '?principal=pi&workspace=foreign');
    expect(foreign.result.isError).toBe(true);
    expect(foreign.result.content[0]!.text).toContain('pi_principal_workspace_mismatch');
    const denied = await call(token);
    expect(denied.result.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('missing_capability');
    expect(seams.scopes).toEqual([]);
    completed.add('scope-and-grant-refusals');
  });

  it('refuses an ended PI after explicit invalidation and an expired PI on first resolution', async () => {
    const token = await pi('revoked');
    const initial = await call(token);
    expect(initial.result.isError, JSON.stringify(initial)).not.toBe(true);
    await db.sql`UPDATE harness_shared.pi_sessions SET ended_at=now() WHERE session_id='revoked'`;
    invalidate(WS, 'pi:revoked'); // Explicit local invalidation only, not a NOTIFY witness.
    const revoked = await call(token);
    expect(revoked.result.isError).toBe(true);
    expect(revoked.result.content[0]!.text).toContain('pi_principal_invalid_bearer');
    const expiredToken = await pi('expired');
    await db.sql`UPDATE harness_shared.pi_sessions SET expires_at=now() - interval '1 second' WHERE session_id='expired'`;
    expect((await call(expiredToken)).result.isError).toBe(true);
    expect(seams.scopes).toEqual([['p001-default']]);
    completed.add('ended-and-expired');
  });
});

afterAll(async () => {
  let sourceStable = false;
  let cleanup = 'not-attempted';
  try {
    const after = sources.map(path => ({ path, sha256: sha(readFileSync(new URL('../../../../../' + path, import.meta.url))) }));
    sourceStable = JSON.stringify(after) === JSON.stringify(pins);
    expect(after).toEqual(pins);
    expect([...completed].sort()).toEqual(['pi-host-dispatch', 'cookie-vs-default', 'scope-and-grant-refusals',
      'ended-and-expired', ...['role=operator', 'harness=foreign', 'spawn=foreign', 'superuser=0', 'power_user=0']
        .map(parameter => 'override:' + parameter)].sort());
  } finally {
    try {
      await _resetAuthCacheForTests();
      await db?.cleanup();
      cleanup = 'dropped';
    } finally {
      // Failure evidence survives assertion and cleanup failures too.
      if (process.env.PAPERCUSP_P001_HOST_AUTH_CAPTURE_OUT) writeFileSync(process.env.PAPERCUSP_P001_HOST_AUTH_CAPTURE_OUT,
        JSON.stringify({ schemaVersion: 'p001-host-auth-capture-v1', sourcePins: pins, sourceStable, cleanup,
          completed: [...completed], receipts,
          limitations: ['Private admin PG shim; no production middleware/RLS proof.',
            'Controlled backend/flags/reranking; no field/provider freshness claim.',
            'Operator kernel/quota/telemetry dependencies omitted; generic capability enforcement is real.',
            'Actual SDK carrier and host helpers; protocol callback is fixture-owned, not registerMcpHost or browser HTTP acceptance.',
            'Cookie helper and default-user behavior distinguished; authenticated browser binding remains unresolved.',
            'Explicit local invalidation only; no cross-process TTL/NOTIFY/epoch proof.',
            'SU, power-user, connected-app and signed-spawn paths remain open.'] }, null, 2));
    }
  }
}, 30_000);
