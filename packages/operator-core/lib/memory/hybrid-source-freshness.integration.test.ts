/** P001 actual hybrid/adapter/SQL controls. Controlled vectors do not qualify
 * production authorization, ingestion, approximate indexes or model quality. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CanonicalVectorStore, EMBEDDER_DIM_SPECS, MEMORY_VECTOR_STORAGE_PROFILES,
  HybridBackend, LexicalLegBackend, Mem0Backend, type Mem0BackendDeps,
  type SearchOptions } from '@papercusp/memory';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const query = 'zephyrhybridmemory';
const profile = EMBEDDER_DIM_SPECS.gemma;
const vector = [1, ...Array(profile.targetDims - 1).fill(0)];
const receipts: unknown[] = [];
let db: FreshPgDb;
let store: CanonicalVectorStore;
let backend: HybridBackend;
const scope = 'p001-hybrid-filters';

beforeAll(async () => {
  db = await createFreshPgDb('hybrid-source-freshness');
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
    );`);
  const url = new URL(db.url);
  store = new CanonicalVectorStore({ host: url.hostname, port: Number(url.port),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    dbname: url.pathname.slice(1), schema: 'harness_shared', vecTable: 'memory_vec_gemma',
    embeddingModelDims: profile.targetDims, embeddingProfile: profile,
    storageProfile: MEMORY_VECTOR_STORAGE_PROFILES.gemma });
  const inner = new Mem0Backend({
    // The precomputed-vector path never calls this client's search method.
    getClient: (async () => ({ search: () => { throw new Error('unexpected legacy client path'); } })) as unknown as NonNullable<Mem0BackendDeps['getClient']>,
    lexicalSearch: (text, limit, filters) => store.lexicalSearch(text, limit, filters),
    vectorSearch: (value, limit, filters) => store.searchWithProfile(value, profile, limit, filters),
  });
  backend = new HybridBackend(new LexicalLegBackend(inner), inner, { name: 'hybrid-pg' });
}, 60_000);

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.memory_vec_gemma,harness_shared.memory_canonical`;
});

async function seed(id: string, opts: { from?: string; until?: string; archived?: boolean;
  pack?: string; indexed?: boolean; owner?: string } = {}) {
  await db.sql`INSERT INTO harness_shared.memory_canonical
    (id,payload,state,valid_at,invalid_at) VALUES (${id},${db.sql.json({
      user_id: opts.owner ?? scope, data: `${query} ${id}`, name: query, kind: 'project',
      ...(opts.pack ? { packageVersion: opts.pack } : {}),
    })},${opts.archived ? 'archived' : 'active'},${opts.from ?? null},${opts.until ?? null})`;
  if (opts.indexed) await db.sql`INSERT INTO harness_shared.memory_vec_gemma
    VALUES (${id},${JSON.stringify(vector)}::vector,'memory')`;
}

async function capture(phase: string,
  opts: Pick<SearchOptions, 'asOf' | 'includeSuperseded' | 'archivedEligibility'>,
  expected: string[]) {
  const canonical = () => db.sql`SELECT id,payload,state,valid_at,invalid_at,xmin::text AS revision
    FROM harness_shared.memory_canonical ORDER BY id`;
  const before = await canonical();
  const rows = await backend.search(query, { scope, vector, limit: 20, ...opts });
  const after = await canonical();
  receipts.push({ phase, opts, before, after, rows, expected });
  expect(after).toEqual(before);
  expect(rows.map(row => row.id).sort()).toEqual([...expected].sort());
  for (const row of rows) {
    const raw = after.find(item => item.id === row.id)!;
    expect(row.text).toBe(raw.payload.data);
    expect(row.metadata?.name).toBe(raw.payload.name);
    expect(row.kind).toBe(raw.payload.kind);
    expect(row.scope).toBe(raw.payload.user_id);
  }
  return rows;
}

describe('P001 actual hybrid memory lifecycle and eligibility', () => {
  it('applies historical and lifecycle controls to lexical-only candidates', async () => {
    await seed('history', { from: '2019-01-01T00:00:00Z', until: '2020-01-01T00:00:00Z', indexed: true });
    await seed('current', { from: '2025-01-01T00:00:00Z', indexed: true });
    await seed('foreign', { owner: 'other-scope', indexed: true });
    await capture('historical-window', { asOf: '2019-06-01T00:00:00Z' }, ['history']);
    await capture('history-flag-does-not-widen-asOf', {
      asOf: '2019-06-01T00:00:00Z', includeSuperseded: true,
    }, ['history']);
    await capture('half-open-end', { asOf: '2020-01-01T00:00:00Z' }, []);
    await capture('explicit-full-lifecycle', { includeSuperseded: true }, ['current', 'history']);
    await capture('default-current', {}, ['current']);
    await db.sql`DELETE FROM harness_shared.memory_vec_gemma`;
    await db.sql`DELETE FROM harness_shared.memory_canonical`;
  });

  it('admits only pinned archived lexical rows and reads canonical updates', async () => {
    // No vector rows: this population can be recalled only by the lexical leg.
    await seed('eligible', { archived: true, pack: 'v1' });
    await seed('ineligible', { archived: true, pack: 'v2' });
    const options = { archivedEligibility: { key: 'packageVersion', values: ['v1'] } };
    await capture('pinned-archive-only', options, ['eligible']);
    await db.sql`UPDATE harness_shared.memory_canonical SET payload=payload ||
      ${db.sql.json({ data: `${query} canonical replacement`, name: `${query} new name`, kind: 'preference' })}
      WHERE id='eligible'`;
    const changed = await capture('canonical-fields-changed-without-vector', options, ['eligible']);
    expect(changed[0].text).toContain('canonical replacement');
    await capture('pin-revoked', {}, []);
  });
});

afterAll(async () => {
  try {
    if (process.env.PAPERCUSP_HYBRID_MEMORY_SOURCE_WITNESS_FILE) writeFileSync(
      process.env.PAPERCUSP_HYBRID_MEMORY_SOURCE_WITNESS_FILE, JSON.stringify({
        schemaVersion: 1, query, profileId: profile.profileId,
        vectorFingerprint: createHash('sha256').update(JSON.stringify(vector)).digest('hex'),
        receipts, limits: ['Actual HybridBackend/Mem0Backend/LexicalLegBackend/CanonicalVectorStore readers.',
          'Private PostgreSQL with controlled vectors; no ingestion, authorization, handler, injection or HNSW completeness proof.',
          'Canonical field equality is contributing evidence; no current-field/index witness is claimed.'],
      }, null, 2) + '\n');
  } finally {
    await store?.dispose();
    await db?.cleanup();
  }
});
