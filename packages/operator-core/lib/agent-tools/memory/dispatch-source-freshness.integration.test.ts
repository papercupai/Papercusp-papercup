/** P001 contributing capture: persisted bearer → real MCP dispatch → memory:search
 * → hybrid/canonical readers. Database handles and embeddings are controlled;
 * host transport authentication, RLS and production freshness remain unqualified.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalVectorStore, EMBEDDER_DIM_SPECS, MEMORY_VECTOR_STORAGE_PROFILES,
  HybridBackend, LexicalLegBackend, Mem0Backend, type Mem0BackendDeps } from '@papercusp/memory';
import { dispatch, dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveBearer, invalidate, _resetAuthCacheForTests } from '../../../../agent-mcp/src/auth';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const seams = vi.hoisted(() => ({ backend: null as unknown, sql: null as Sql | null }));
vi.mock('../../memory/backend', async original => ({
  ...await original<typeof import('../../memory/backend')>(), getMemoryBackend: () => seams.backend,
}));
// Only the database connection boundary is replaced. Every authorization,
// registry, user, wearer and package query below executes against private PG.
// This admin-role shim does NOT establish connection middleware or RLS proof.
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: seams.sql }),
  getOrgPgListener: () => ({ sql: {} }), // NOTIFY delivery is outside this capture.
  withWorkspace: async (workspace: string, callback: (tx: unknown) => Promise<unknown>) =>
    seams.sql!.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return callback(tx);
    }),
}));
vi.mock('@papercusp/flags/server', async original => {
  const { FLAGS } = await import('@papercusp/flags');
  return { ...await original<typeof import('@papercusp/flags/server')>(),
    getFlag: async (flag: string) => flag === FLAGS.MEMORY_WORKSPACE_SCOPED_RECALL || flag === FLAGS.SCOPED_SUPERUSER_CLAMP };
});
vi.mock('../../memory/configure', async original => ({
  ...await original<typeof import('../../memory/configure')>(), isOpenAiEmbedInCooldown: () => false,
}));
vi.mock('../../memory/feedback-rerank', async original => ({
  ...await original<typeof import('../../memory/feedback-rerank')>(),
  loadFeedbackSignals: async () => ({ tombstonedIds: new Set(), deletedContent: [] }),
  applyFeedbackRerank: <T>(hits: T) => hits,
}));
vi.mock('../../memory/surfaced-outcomes', async original => ({
  ...await original<typeof import('../../memory/surfaced-outcomes')>(), loadOutcomeCounts: async () => new Map(),
}));

import './search'; // Real defineTool registration; no handler or identity/auth mock.
import { MemoryTimeoutError, resetMemoryDegradedForTest } from '../../memory/op-deadline';
import { IDENTITY_PACKAGE_RESOURCE } from '../../blueprint/package-memory-visibility';

const QUERY = 'zephyrdispatchmemory';
const WS_A = 'p001-memory-dispatch-a';
const WS_B = 'p001-memory-dispatch-b';
const USER = 'p001-default-user';
const profile = EMBEDDER_DIM_SPECS.gemma;
const vector = [1, ...Array(profile.targetDims - 1).fill(0)];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value: unknown) => sha(JSON.stringify(value));
const CASES = ['bearer-refusals', 'workspace-fanout', 'wearer-revocation', 'projected-hive-and-judge'] as const;
const modes = ['hybrid', 'lexical-fallback'] as const;
type Mode = typeof modes[number];
type Wire = { ok: boolean; reason?: string; fallback?: string; results: Array<{
  id: string; memory: string; metadata: Record<string, unknown> }> };
const receipts: unknown[] = [];
const executed = new Set<string>();
const sourcePaths = [
  'packages/agent-mcp/src/server.ts', 'packages/agent-mcp/src/auth.ts',
  'packages/operator-core/lib/agent-tools/memory/search.ts', 'packages/operator-core/lib/auth.ts',
  'packages/operator-core/lib/agent-tools/coordination/identity.ts',
  'packages/operator-core/lib/harness-registry.ts', 'packages/operator-core/lib/operator-state-pg.ts',
  'packages/operator-core/lib/memory/hive-scope.ts', 'packages/operator-core/lib/memory/workspace-scope-recall.ts',
  'packages/operator-core/lib/blueprint/package-memory-visibility.ts',
  'libs/generic/tooldef/src/define-tool.ts', 'libs/generic/tooldef/src/dispatch-projected.ts',
  'libs/generic/tooldef/src/dispatch-stack.ts', 'libs/generic/memory/src/hybrid-backend.ts',
];
let pins: Array<{ path: string; sha256: string }> = [];
let db: FreshPgDb;
let store: CanonicalVectorStore;
let backend: HybridBackend;

async function principal(workspace: string, name: string, capabilities = ['memory:search:read']) {
  // Private fixture token only; receipts retain the label and hash, never bearer bytes.
  const token = `fixture-only-${workspace}-${name}`;
  await db.sql`INSERT INTO harness_shared.token_index VALUES (${token}, 'system', ${'system:' + name}, ${workspace})`;
  await db.sql`INSERT INTO harness_shared.system_principals VALUES (${workspace}, ${name}, ${sha(token)}, ${db.sql.json(capabilities)})`;
  return token;
}

async function seed(id: string, scope: string, extra: Record<string, unknown> = {}, archived = false) {
  await db.sql`INSERT INTO harness_shared.memory_canonical (id,payload,state)
    VALUES (${id}, ${db.sql.json({ user_id: scope, data: `${QUERY} ${id}`, name: QUERY, kind: 'project', ...extra })},
      ${archived ? 'archived' : 'active'})`;
  await db.sql`INSERT INTO harness_shared.memory_vec_gemma VALUES (${id}, ${JSON.stringify(vector)}::vector, 'memory')`;
}

async function authority() {
  const [users, principals, registry, packages, canonical] = await Promise.all([
    db.sql`SELECT id,username,is_active,xmin::text AS revision FROM harness_shared.users ORDER BY id`,
    db.sql`SELECT workspace_id,name,bearer_hash,capabilities,xmin::text AS revision
      FROM harness_shared.system_principals ORDER BY workspace_id,name`,
    db.sql`SELECT workspace_id,payload,xmin::text AS revision FROM harness_shared.harness_registry ORDER BY workspace_id`,
    db.sql`SELECT workspace_id,dependent_id,owner_id,phase,xmin::text AS revision
      FROM harness_shared.blueprint_package_installations ORDER BY workspace_id,dependent_id`,
    db.sql`SELECT id,payload,state,xmin::text AS revision FROM harness_shared.memory_canonical ORDER BY id`,
  ]);
  return { users, principals, registry, packages, canonical };
}

async function capture(mode: Mode, phase: string, token: string, expected: string[],
  args: Record<string, unknown> = {}, session?: { harnessSlug: string; judge?: boolean }) {
  const before = await authority();
  const startedAtMs = Date.now();
  const [telemetry] = await db.sql`SELECT count(*)::int AS count FROM harness_shared.memory_recall_stats`;
  if (mode === 'lexical-fallback') vi.spyOn(backend, 'search')
    .mockRejectedValueOnce(new MemoryTimeoutError('P001 controlled semantic refusal'));
  const request = { query: QUERY, limit: 20, ...args };
  let wire: Wire;
  if (session) {
    const resolved = await resolveBearer(token);
    expect(resolved).not.toBeNull();
    const projected = lookupByMcpName('memory:search');
    expect(projected).toBeDefined();
    const ctx: UnifiedToolContext = {
      log: () => {}, progress: () => {}, emit: () => {}, signal: new AbortController().signal,
      role: session.judge ? 'judge' : 'operator', runId: 'p001-memory-dispatch', harnessSlug: session.harnessSlug,
      workspaceId: resolved!.workspaceId, principal: resolved!, tx: db.sql,
      transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
    };
    const result = await dispatchProjectedTool(projected!, 'memory:search', request, ctx, {});
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    wire = result.result!.structuredContent as Wire;
  } else {
    const result = await dispatch({ toolName: 'memory:search', args: request, bearer: token });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const response = result.response as unknown as { content: Array<{ text: string }> };
    wire = JSON.parse(response.content[0]!.text) as Wire;
  }
  await vi.waitFor(async () => {
    const [row] = await db.sql`SELECT count(*)::int AS count FROM harness_shared.memory_recall_stats`;
    expect(row.count).toBe(telemetry.count + 1);
  }, { timeout: 5000, interval: 10 });
  const after = await authority();
  expect(after).toEqual(before);
  expect(wire.ok).toBe(true);
  expect(wire.results.map(row => row.id).sort()).toEqual([...expected].sort());
  expect(wire.fallback).toBe(mode === 'lexical-fallback' ? 'lexical' : undefined);
  for (const row of wire.results) {
    expect(row.memory).toBe(after.canonical.find(raw => raw.id === row.id)!.payload.data);
  }
  receipts.push({ mode, phase, request, tokenHash: sha(token), session,
    path: session ? 'resolveBearer → dispatchProjectedTool → memory:search → hybrid/canonical'
      : 'dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical',
    startedAtMs, responseAtMs: Date.now(), before, after, output: wire, expected,
    fixtureAuthorityEpoch: fingerprint(before), fieldCurrentness: 'unknown' });
  vi.restoreAllMocks();
  return wire;
}

beforeAll(async () => {
  pins = sourcePaths.map(path => ({ path, sha256: sha(readFileSync(new URL(`../../../../../${path}`, import.meta.url))) }));
  db = await createFreshPgDb('memory-dispatch-source-freshness');
  seams.sql = db.sql;
  await db.sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE harness_shared.users (id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      username text UNIQUE, display_name text, password_hash text, is_active boolean DEFAULT true);
    CREATE TABLE harness_shared.token_index (token text PRIMARY KEY,kind text,harness_slug text,workspace_id text);
    CREATE TABLE harness_shared.system_principals (workspace_id text,name text,bearer_hash text,capabilities jsonb,
      PRIMARY KEY(workspace_id,name));
    CREATE TABLE harness_shared.harness_registry (workspace_id text PRIMARY KEY,payload jsonb);
    CREATE TABLE harness_shared.memory_canonical (id text PRIMARY KEY,payload jsonb NOT NULL,
      state text NOT NULL DEFAULT 'active',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
      valid_at timestamptz,invalid_at timestamptz,superseded_by text,
      row_kind text GENERATED ALWAYS AS (CASE WHEN payload ? 'entityType' THEN 'entity' ELSE 'memory' END) STORED);
    CREATE TABLE harness_shared.memory_vec_gemma (memory_id text PRIMARY KEY,vector vector(768),row_kind text);
    CREATE TABLE harness_shared.blueprint_package_installations (workspace_id text,dependent_id text,owner_id text,phase text);
    CREATE TABLE harness_shared.blueprint_package_dependents (workspace_id text,dependent_id text,resource_key text,phase text);
    CREATE TABLE harness_shared.blueprint_package_resources (workspace_id text,resource_key text,phase text,resource_kind text);
    CREATE TABLE harness_shared.memory_recall_stats (id bigserial PRIMARY KEY,surface text,hit_count integer,
      top_score double precision,scores jsonb,fragment_count integer,pools jsonb,workspace_id text,pot_slug text,
      score_scale text,query_chars integer,query_sha256 text,query_origin text,session_id text,legs jsonb,admission jsonb,
      client text,top_cosine_score double precision,cosine_scores jsonb);`);
  const url = new URL(db.url);
  store = new CanonicalVectorStore({ host: url.hostname, port: Number(url.port),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), dbname: url.pathname.slice(1),
    schema: 'harness_shared', vecTable: 'memory_vec_gemma', embeddingModelDims: profile.targetDims,
    embeddingProfile: profile, storageProfile: MEMORY_VECTOR_STORAGE_PROFILES.gemma });
  const inner = new Mem0Backend({
    getClient: (async () => ({ search: async (_text: string, options: {
      topK: number; filters: Parameters<CanonicalVectorStore['searchWithProfile']>[3];
    }) => ({ results: (await store.searchWithProfile(vector, profile, options.topK, options.filters))
      .map(row => ({ id: row.id, memory: row.payload.data, metadata: row.payload, score: row.score })) })
    })) as unknown as NonNullable<Mem0BackendDeps['getClient']>,
    embedQuery: async () => vector,
    lexicalSearch: (text, limit, filters) => store.lexicalSearch(text, limit, filters),
    vectorSearch: (value, limit, filters) => store.searchWithProfile(value, profile, limit, filters),
  });
  backend = new HybridBackend(new LexicalLegBackend(inner), inner, { name: 'hybrid-pg' });
  seams.backend = backend;
}, 60_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  await _resetAuthCacheForTests();
  resetMemoryDegradedForTest();
  await db.sql.unsafe(`TRUNCATE harness_shared.users,harness_shared.token_index,harness_shared.system_principals,
    harness_shared.harness_registry,harness_shared.memory_canonical,harness_shared.memory_vec_gemma,
    harness_shared.blueprint_package_installations,harness_shared.blueprint_package_dependents,
    harness_shared.blueprint_package_resources,harness_shared.memory_recall_stats`);
  await db.sql`INSERT INTO harness_shared.users (id,username,display_name) VALUES (${USER},'default','P001 default')`;
  for (const [workspace, projects] of [[WS_A, [
    { slug: 'p001-home', harness_kind: 'hive' }, { slug: 'p001-child', hive_slug: 'p001-home' },
    { slug: 'p001-sibling', harness_kind: 'hive' },
  ]], [WS_B, [{ slug: 'p001-foreign', harness_kind: 'hive' }]]] as const) {
    await db.sql`INSERT INTO harness_shared.harness_registry VALUES (${workspace}, ${db.sql.json({ projects })})`;
  }
});

describe('P001 actual memory dispatch/auth/scope capture', () => {
  it('refuses invalid bearer, stored hash mismatch, missing grant and caller-supplied scope channels before recall', async () => {
    const denied = await principal(WS_A, 'denied', []);
    const mismatch = await principal(WS_A, 'mismatch');
    await db.sql`UPDATE harness_shared.system_principals SET bearer_hash='wrong' WHERE name='mismatch'`;
    const allowed = await principal(WS_A, 'reader');
    const search = vi.spyOn(backend, 'search');
    for (const [phase, token, args, code] of [
      ['unknown-token', 'fixture-missing', { query: QUERY }, 'invalid_bearer'],
      ['stored-hash-mismatch', mismatch, { query: QUERY }, 'invalid_bearer'],
      ['missing-capability', denied, { query: QUERY }, 'missing_capability'],
      ['caller-workspace-channel', allowed, { query: QUERY, workspaceId: WS_B }, 'invalid_args'],
      ['caller-user-channel', allowed, { query: QUERY, user_id: 'foreign-user' }, 'invalid_args'],
    ] as const) {
      const result = await dispatch({ toolName: 'memory:search', args, bearer: token });
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(result.response).toBeUndefined();
      receipts.push({ phase, result });
    }
    expect(search).not.toHaveBeenCalled();
    executed.add('bearer-refusals');
  });

  it.each(modes)('%s derives default user and workspace fan-out from persisted authority', async mode => {
    const a = await principal(WS_A, 'reader');
    const b = await principal(WS_B, 'reader'); // Same slug, distinct authenticated workspace/cache key.
    await seed('personal-a', USER, { workspace_id: WS_A });
    await seed('personal-b', USER, { workspace_id: WS_B });
    await seed('foreign-user', 'foreign-user');
    await seed('home', 'harness:p001-home');
    await seed('child', 'harness:p001-child');
    await seed('sibling', 'harness:p001-sibling');
    await seed('foreign', 'harness:p001-foreign');
    await capture(mode, 'workspace-a', a, ['personal-a', 'home', 'child', 'sibling']);
    await capture(mode, 'workspace-b-same-principal-slug', b, ['personal-b', 'foreign']);
    await capture(mode, 'scoped-workspace-argument-does-not-retarget', a,
      ['personal-a', 'home', 'child', 'sibling'], { workspace: WS_B });
    executed.add('workspace-fanout');
  });

  it.each(modes)('%s derives wearer identity and observes package/grant revocation', async mode => {
    const wearer = await principal(WS_A, 'reader');
    const other = await principal(WS_A, 'other');
    await seed('organic', 'harness:p001-home');
    await seed('pinned', 'harness:p001-home', { source: 'pack', pack_id: 'p001-pack', pack_item_id: 'note',
      pack_version: '1.0.0', [IDENTITY_PACKAGE_RESOURCE]: 'resource-v1' }, true);
    await db.sql`INSERT INTO harness_shared.blueprint_package_installations
      VALUES (${WS_A},'installation','system:reader','applied')`;
    await db.sql`INSERT INTO harness_shared.blueprint_package_dependents VALUES (${WS_A},'installation','resource-v1','applied')`;
    await db.sql`INSERT INTO harness_shared.blueprint_package_resources VALUES (${WS_A},'resource-v1','ready','memory')`;
    const request = { harness_slug: 'p001-home', harnessOnly: true };
    await capture(mode, 'authenticated-wearer', wearer, ['organic', 'pinned'], request);
    await capture(mode, 'different-authenticated-wearer', other, ['organic'], request);
    await db.sql`UPDATE harness_shared.blueprint_package_installations SET phase='removed'`;
    await capture(mode, 'package-revoked', wearer, ['organic'], request);
    await db.sql`UPDATE harness_shared.system_principals SET capabilities='[]'::jsonb WHERE name='reader'`;
    invalidate(WS_A, 'system:reader'); // Exercise the real invalidation API; NOTIFY transport is not claimed.
    const result = await dispatch({ toolName: 'memory:search', args: { query: QUERY }, bearer: wearer });
    expect(result).toMatchObject({ ok: false, error: { code: 'missing_capability' } });
    receipts.push({ phase: 'grant-revoked-after-explicit-invalidation', result });
    executed.add('wearer-revocation');
  });

  it.each(modes)('%s preserves hive and judge session scope through actual projected dispatch', async mode => {
    const reader = await principal(WS_A, 'reader');
    const judge = await principal(WS_A, 'judge');
    await seed('home', 'harness:p001-home');
    await seed('child', 'harness:p001-child');
    await seed('sibling', 'harness:p001-sibling');
    await seed('personal', USER, { workspace_id: WS_A });
    await capture(mode, 'session-hive-clamp', reader, ['home', 'child', 'personal'], {}, { harnessSlug: 'p001-home' });
    await capture(mode, 'judge-own-harness', judge, ['child'], {}, { harnessSlug: 'p001-child', judge: true });
    const resolved = await resolveBearer(judge);
    const result = await dispatchProjectedTool(lookupByMcpName('memory:search')!, 'memory:search',
      { query: QUERY, harness_slug: 'p001-sibling' }, {
        log: () => {}, progress: () => {}, emit: () => {}, signal: new AbortController().signal,
        role: 'judge', runId: 'p001-memory-dispatch', harnessSlug: 'p001-child', workspaceId: WS_A,
        principal: resolved!, tx: db.sql, transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
      }, {});
    expect(result.result?.structuredContent).toMatchObject({ ok: false, reason: 'judge_harness_scope_mismatch', results: [] });
    receipts.push({ phase: 'judge-foreign-harness-refused', result });
    executed.add('projected-hive-and-judge');
  });
});

afterAll(async () => {
  try {
    for (const pin of pins) expect(sha(readFileSync(new URL(`../../../../../${pin.path}`, import.meta.url))), pin.path).toBe(pin.sha256);
    const path = process.env.PAPERCUSP_MEMORY_DISPATCH_SOURCE_WITNESS_FILE;
    if (path) writeFileSync(path, JSON.stringify({ schemaVersion: 1, query: QUERY, sourcePins: pins,
      testSha256: sha(readFileSync(new URL(import.meta.url))), profileId: profile.profileId,
      vectorFingerprint: fingerprint(vector), population: CASES, executed: [...executed],
      unexecuted: CASES.filter(c => !executed.has(c)), receipts, fieldCurrentness: 'unknown',
      limits: ['Private minimal PG schema and admin connection shim; production RLS/connection middleware unmeasured.',
        'Real persisted system bearer resolution/dispatch; host HTTP/cookie/spawn authentication and PI grants unmeasured.',
        'Actual user helper selects single-user default without an ambient browser cookie; multi-user browser binding unmeasured.',
        'Projected session harness/role are fixture inputs after real bearer resolution; host derivation unmeasured.',
        'Grant invalidation API is real; NOTIFY transport, TTL expiry and cross-process epochs unmeasured.',
        'Controlled embeddings, single-scope client facade, flags and ancillary ranking; quality/ingestion/index/freshness/budget/runtime closure unmeasured.',
        'Canonical value equality and fixture authority fingerprint are contributing evidence, not production field freshness.'],
    }, null, 2) + '\n');
  } finally {
    vi.restoreAllMocks();
    await _resetAuthCacheForTests();
    await store?.dispose();
    await db?.cleanup();
  }
}, 30_000);
