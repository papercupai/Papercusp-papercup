/** P001 contributing capture through the actual memory:search handler, package
 * resolver, hybrid adapters and canonical PostgreSQL readers. The principal,
 * embedder, flags and ancillary ranking inputs are controlled here;
 * this does not qualify production authentication, ingestion or model quality.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalVectorStore, EMBEDDER_DIM_SPECS, MEMORY_VECTOR_STORAGE_PROFILES,
  HybridBackend, LexicalLegBackend, Mem0Backend, type Mem0BackendDeps } from '@papercusp/memory';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const seams = vi.hoisted(() => ({ backend: null as unknown, sql: null as unknown }));
vi.mock('../../memory/backend', async (original) => ({
  ...await original<typeof import('../../memory/backend')>(),
  getMemoryBackend: () => seams.backend,
}));
vi.mock('@papercusp/agent-mcp', async (original) => ({
  ...await original<typeof import('@papercusp/agent-mcp')>(),
  defineTool: (definition: unknown) => definition,
}));
vi.mock('../../auth', async (original) => ({
  ...await original<typeof import('../../auth')>(),
  getSessionUserOrDefault: async () => ({ id: 'p001-user', display_name: 'P001 controlled user' }),
}));
vi.mock('../coordination/identity', async (original) => ({
  ...await original<typeof import('../coordination/identity')>(),
  resolveAgentIdentity: () => ({ ownerId: 'p001-wearer' }),
}));
vi.mock('../../harness-registry', async (original) => ({
  ...await original<typeof import('../../harness-registry')>(),
  loadHarnessRegistry: async () => ({ projects: [{ slug: 'p001-memory' }] }),
}));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: seams.sql }),
}));
vi.mock('@papercusp/flags/server', async (original) => {
  const { FLAGS } = await import('@papercusp/flags');
  return { ...await original<typeof import('@papercusp/flags/server')>(),
    getFlag: async (flag: string) => flag === FLAGS.MEMORY_WORKSPACE_SCOPED_RECALL };
});
vi.mock('../../memory/configure', async (original) => ({
  ...await original<typeof import('../../memory/configure')>(),
  isOpenAiEmbedInCooldown: () => false,
}));
vi.mock('../../memory/feedback-rerank', async (original) => ({
  ...await original<typeof import('../../memory/feedback-rerank')>(),
  loadFeedbackSignals: async () => ({ tombstonedIds: new Set(), deletedContent: [] }),
  applyFeedbackRerank: <T>(hits: T) => hits,
}));
vi.mock('../../memory/surfaced-outcomes', async (original) => ({
  ...await original<typeof import('../../memory/surfaced-outcomes')>(),
  loadOutcomeCounts: async () => new Map(),
}));

import search from './search';
import { MemoryTimeoutError, resetMemoryDegradedForTest } from '../../memory/op-deadline';
import { IDENTITY_PACKAGE_RESOURCE } from '../../blueprint/package-memory-visibility';

const query = 'zephyrhandlermemory';
const profile = EMBEDDER_DIM_SPECS.gemma;
const vector = [1, ...Array(profile.targetDims - 1).fill(0)];
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ctx = { principal: { workspaceId: 'p001-workspace' }, harnessSlug: 'p001-memory', contextTier: 'full' } as never;
const modes = ['hybrid', 'lexical-fallback'] as const;
type Mode = typeof modes[number];
type Wire = { ok: boolean; reason?: string; fallback?: string; degraded?: boolean; score_scale?: string;
  results: Array<{ id: string; memory: string; metadata: Record<string, unknown> }> };
const receipts: unknown[] = [];
let db: FreshPgDb;
let store: CanonicalVectorStore;
let backend: HybridBackend;

beforeAll(async () => {
  db = await createFreshPgDb('memory-handler-source-freshness');
  seams.sql = db.sql;
  await db.sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE harness_shared.memory_canonical (
      id text PRIMARY KEY, payload jsonb NOT NULL, state text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT '2019-01-01T00:00:00Z',
      updated_at timestamptz NOT NULL DEFAULT '2019-01-01T00:00:00Z',
      valid_at timestamptz, invalid_at timestamptz, superseded_by text,
      row_kind text GENERATED ALWAYS AS
        (CASE WHEN payload ? 'entityType' THEN 'entity' ELSE 'memory' END) STORED
    );
    CREATE TABLE harness_shared.memory_vec_gemma (
      memory_id text PRIMARY KEY, vector vector(768) NOT NULL, row_kind text NOT NULL
    );
    CREATE TABLE harness_shared.blueprint_package_installations (
      workspace_id text, dependent_id text, owner_id text, phase text
    );
    CREATE TABLE harness_shared.blueprint_package_dependents (
      workspace_id text, dependent_id text, resource_key text, phase text
    );
    CREATE TABLE harness_shared.blueprint_package_resources (
      workspace_id text, resource_key text, phase text, resource_kind text
    );
    -- Exact columns written by recordRecallStatsNow; telemetry is real and
    -- awaited below, so its deferred writes cannot leak across fixture cleanup.
    CREATE TABLE harness_shared.memory_recall_stats (
      id bigserial PRIMARY KEY, surface text, hit_count integer, top_score double precision,
      scores jsonb, fragment_count integer, pools jsonb, workspace_id text, pot_slug text,
      score_scale text, query_chars integer, query_sha256 text, query_origin text,
      session_id text, legs jsonb, admission jsonb, client text,
      top_cosine_score double precision, cosine_scores jsonb
    );`);
  const url = new URL(db.url);
  store = new CanonicalVectorStore({ host: url.hostname, port: Number(url.port),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    dbname: url.pathname.slice(1), schema: 'harness_shared', vecTable: 'memory_vec_gemma',
    embeddingModelDims: profile.targetDims, embeddingProfile: profile,
    storageProfile: MEMORY_VECTOR_STORAGE_PROFILES.gemma });
  const inner = new Mem0Backend({
    // Single-scope reads deliberately retain Mem0Backend's legacy client path.
    // This controlled client translates its documented wire shape only; all
    // filters and ranking are delegated unchanged to the real canonical reader.
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
  // Automatic preflight for the harness defect classes from attempts r1/r2:
  // collection already validated complete mocks; exercise both vector entry
  // paths, fallback and the deferred telemetry sink before lifecycle scenarios.
  await capture('hybrid', 'preflight-multi-scope-and-telemetry', []);
  await capture('hybrid', 'preflight-single-scope-client', [], { harnessOnly: true });
  await capture('lexical-fallback', 'preflight-fallback-and-telemetry', []);
}, 60_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  resetMemoryDegradedForTest();
  await db.sql`TRUNCATE harness_shared.memory_vec_gemma,harness_shared.memory_canonical,
    harness_shared.blueprint_package_installations,harness_shared.blueprint_package_dependents,
    harness_shared.blueprint_package_resources,harness_shared.memory_recall_stats`;
});

async function seed(id: string, payload: Record<string, unknown> = {},
  options: { archived?: boolean; from?: string; until?: string; indexed?: boolean } = {}) {
  await db.sql`INSERT INTO harness_shared.memory_canonical (id,payload,state,valid_at,invalid_at)
    VALUES (${id},${db.sql.json({ user_id: 'harness:p001-memory', data: `${query} ${id}`,
      name: query, kind: 'project', ...payload })},${options.archived ? 'archived' : 'active'},
      ${options.from ?? null},${options.until ?? null})`;
  if (options.indexed !== false) await db.sql`INSERT INTO harness_shared.memory_vec_gemma
    VALUES (${id},${JSON.stringify(vector)}::vector,${payload.entityType ? 'entity' : 'memory'})`;
}

async function capture(mode: Mode, phase: string, expected: string[],
  extra: { as_of?: string; include_superseded?: boolean; harnessOnly?: boolean } = {}) {
  const canonical = () => db.sql`SELECT id,payload,state,valid_at,invalid_at,xmin::text AS revision
    FROM harness_shared.memory_canonical ORDER BY id`;
  const before = await canonical();
  const [telemetryBefore] = await db.sql`SELECT count(*)::int AS count FROM harness_shared.memory_recall_stats`;
  // Deliberately inject the semantic failure at the handler's dependency seam;
  // the fallback, its SQL reader and its option propagation remain real.
  if (mode === 'lexical-fallback') vi.spyOn(backend, 'search')
    .mockRejectedValueOnce(new MemoryTimeoutError('P001 controlled semantic refusal'));
  const args = { query, harness_slug: 'p001-memory', limit: 20, ...extra };
  const response = await search.handler(args, ctx);
  const envelope = response as { content: Array<{ text: string }> };
  const output = JSON.parse(envelope.content[0].text) as Wire;
  // The handler starts telemetry asynchronously. Observe its committed insert
  // before moving to the next scenario or tearing down the private database.
  await vi.waitFor(async () => {
    const [row] = await db.sql`SELECT count(*)::int AS count FROM harness_shared.memory_recall_stats`;
    expect(row.count).toBe(telemetryBefore.count + 1);
  }, { timeout: 5000, interval: 10 });
  const after = await canonical();
  receipts.push({ mode, phase, args, before, after, output, expected,
    fieldCurrentness: 'unknown', authority: 'private canonical PostgreSQL',
    scopeEpoch: 'controlled p001-workspace/p001-user/p001-memory' });
  expect(after).toEqual(before);
  expect(output.ok).toBe(true);
  expect(output.results.map(row => row.id).sort()).toEqual([...expected].sort());
  if (mode === 'lexical-fallback') {
    expect(output).toMatchObject({ fallback: 'lexical', degraded: true, score_scale: 'lexical' });
  } else {
    expect(output.fallback).toBeUndefined();
    expect(output.score_scale).toBe('rrf');
  }
  for (const row of output.results) {
    const raw = after.find(item => item.id === row.id)!;
    expect(row.memory).toBe(raw.payload.data);
    expect(row.metadata.kind).toBe(raw.payload.kind);
    expect(row.metadata.name).toBe(raw.payload.name);
  }
  return output;
}

describe('P001 actual memory:search handler capture', () => {
  it.each(modes)('%s preserves wire values, scope fences, candidate changes and real package pins', async mode => {
    await seed('organic');
    await seed('personal', { user_id: 'p001-user', workspace_id: 'p001-workspace' });
    await seed('other-workspace', { user_id: 'p001-user', workspace_id: 'foreign-workspace' });
    await seed('other-user', { user_id: 'foreign-user' });
    await seed('other-harness', { user_id: 'harness:foreign' });
    await seed('entity', { entityType: 'plan' });
    await seed('pinned', { source: 'pack', pack_id: 'p001-pack', pack_item_id: 'note',
      pack_version: '1.0.0', [IDENTITY_PACKAGE_RESOURCE]: 'resource-v1' }, { archived: true, indexed: false });
    await seed('unpinned', { [IDENTITY_PACKAGE_RESOURCE]: 'resource-v2' }, { archived: true });
    await db.sql`INSERT INTO harness_shared.blueprint_package_installations
      VALUES ('p001-workspace','installation','p001-wearer','applied'),
             ('p001-workspace','foreign-installation','foreign-wearer','applied')`;
    await db.sql`INSERT INTO harness_shared.blueprint_package_dependents
      VALUES ('p001-workspace','installation','resource-v1','applied'),
             ('p001-workspace','foreign-installation','resource-v2','applied')`;
    await db.sql`INSERT INTO harness_shared.blueprint_package_resources
      VALUES ('p001-workspace','resource-v1','ready','memory'),
             ('p001-workspace','resource-v2','ready','memory')`;
    const initial = await capture(mode, 'initial', ['organic', 'personal', 'pinned']);
    expect(initial.results.find(row => row.id === 'pinned')?.metadata.identity_package)
      .toEqual({ pack_id: 'p001-pack', pack_version: '1.0.0', pack_item_id: 'note', pinned: true });
    await capture(mode, 'harness-only', ['organic', 'pinned'], { harnessOnly: true });
    await db.sql`UPDATE harness_shared.memory_canonical SET payload=payload ||
      ${db.sql.json({ data: `${query} canonical replacement`, name: `${query} new name`, kind: 'preference' })}
      WHERE id='organic'`;
    const changed = await capture(mode, 'canonical-update-with-unchanged-vector', ['organic', 'personal', 'pinned']);
    expect(changed.results.find(row => row.id === 'organic')?.memory).toBe(`${query} canonical replacement`);
    await seed('addition', {}, { indexed: false });
    await capture(mode, 'lexical-only-candidate-addition', ['organic', 'personal', 'pinned', 'addition']);
    // Retain the stale vector deliberately: canonical deletion must win.
    await db.sql`DELETE FROM harness_shared.memory_canonical WHERE id='organic'`;
    await capture(mode, 'canonical-removal-with-orphan-vector', ['personal', 'pinned', 'addition']);
    await db.sql`UPDATE harness_shared.blueprint_package_installations SET phase='removed'
      WHERE owner_id='p001-wearer'`;
    await capture(mode, 'package-pin-revoked', ['personal', 'addition']);
  });

  it.each(modes)('%s preserves temporal boundaries through the handler', async mode => {
    await seed('history', {}, { from: '2019-01-01T00:00:00Z', until: '2020-01-01T00:00:00Z', indexed: false });
    await seed('current', {}, { from: '2025-01-01T00:00:00Z' });
    await capture(mode, 'historical-window', ['history'], { as_of: '2019-06-01T00:00:00Z' });
    await capture(mode, 'history-flag-does-not-broaden-window', ['history'], {
      as_of: '2019-06-01T00:00:00Z', include_superseded: true });
    await capture(mode, 'half-open-end', [], { as_of: '2020-01-01T00:00:00Z' });
    await capture(mode, 'default-current', ['current']);
    await capture(mode, 'full-lifecycle', ['history', 'current'], { include_superseded: true });
  });
});

afterAll(async () => {
  try {
    const path = process.env.PAPERCUSP_MEMORY_HANDLER_SOURCE_WITNESS_FILE;
    if (path) writeFileSync(path, JSON.stringify({ schemaVersion: 1, query,
      profileId: profile.profileId, vectorFingerprint: fingerprint(vector),
      population: modes, receipts, limits: [
        'Actual handler invoked directly; defineTool transport/principal enforcement is not exercised.',
        'Controlled auth user, wearer identity, registry, flags, embeddings and semantic-failure injection.',
        'Controlled single-scope client facade maps actual canonical reads; native Mem0 entity-graph boosting is unmeasured.',
        'Feedback ranking is neutralized; stored outcome ranking has empty inputs; deferred recall telemetry inserts are real and awaited.',
        'Actual package installation/dependent/resource SQL and canonical vector/lexical readers.',
        'No production authority/scope epoch, ingestion, HNSW, provider freshness or quality/budget proof.',
        'Canonical equality contributes evidence; field currentness remains unknown.',
      ] }, null, 2) + '\n');
  } finally {
    vi.restoreAllMocks();
    await store?.dispose();
    await db?.cleanup();
  }
});
