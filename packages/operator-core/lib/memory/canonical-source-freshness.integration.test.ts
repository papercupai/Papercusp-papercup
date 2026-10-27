/** P001 contributing proof through the real canonical-memory SQL readers.
 * Controlled vectors/private schema do not establish ingestion, trusted caller
 * authorization, approximate-index completeness, model quality or tool dispatch.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanonicalVectorStore, EMBEDDER_DIM_SPECS, MEMORY_VECTOR_STORAGE_PROFILES } from '@papercusp/memory';
import { assertSearchFieldFreshness, type SearchFieldFreshnessPolicy } from '@papercusp/search-core';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const query = 'zephyrcanonicalmemory';
const profile = EMBEDDER_DIM_SPECS.gemma;
const vector = [1, ...Array(profile.targetDims - 1).fill(0)];
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = ['name', 'description', 'data', 'user_id', 'kind'] as const;
// Prospective policy frozen before this capture; never inferred from row dates.
const policies = fields.map(fieldPath => ({ fieldPath,
  authority: 'harness_shared.memory_canonical canonical payload', clock: 'canonical-read',
  maxAgeMs: 0, maxFutureSkewMs: 0, readAfterWrite: 'not-promised', onUnknown: 'degrade',
} satisfies SearchFieldFreshnessPolicy));
const modes = ['lexical', 'vector'] as const;
const population = modes.map(mode => `canonical-memory/${mode}`);
const completed: string[] = [];
const receipts: unknown[] = [];
let db: FreshPgDb;
let store: CanonicalVectorStore;

beforeAll(async () => {
  db = await createFreshPgDb('canonical-memory-source-freshness');
  await db.sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE harness_shared.memory_canonical (
      id text PRIMARY KEY, payload jsonb NOT NULL, state text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT '2019-01-01T00:00:00Z',
      updated_at timestamptz NOT NULL DEFAULT '2019-01-01T00:00:00Z',
      valid_at timestamptz, invalid_at timestamptz, superseded_by text,
      row_kind text GENERATED ALWAYS AS
        (CASE WHEN payload ? 'entityType' THEN 'entity' ELSE 'memory' END) STORED
    );
    -- No FK intentionally: an orphan is an explicit reader negative control.
    -- No HNSW index: this fixture cannot qualify approximate-index coverage.
    CREATE TABLE harness_shared.memory_vec_gemma (
      memory_id text PRIMARY KEY, vector vector(768) NOT NULL, row_kind text NOT NULL
    );`);
  const url = new URL(db.url);
  store = new CanonicalVectorStore({ host: url.hostname, port: Number(url.port),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    dbname: url.pathname.slice(1), schema: 'harness_shared', vecTable: 'memory_vec_gemma',
    embeddingModelDims: profile.targetDims, embeddingProfile: profile,
    storageProfile: MEMORY_VECTOR_STORAGE_PROFILES.gemma });
}, 60_000);

describe('P001 — canonical memory fields, lifecycle and candidate boundaries', () => {
  for (const mode of modes) it(`${mode}: independent canonical and vector controls`, async () => {
    const scope = `p001-canonical-memory-${mode}`;
    const target = `${mode}:target`;
    const id = (label: string) => `${mode}:${label}`;
    const seed = async (label: string, owner = scope, indexed = true, entity = false) => {
      await db.sql`INSERT INTO harness_shared.memory_canonical (id,payload)
        VALUES (${id(label)},${db.sql.json({ user_id: owner, name: `${query} name`,
          description: `${query} description`, data: `${query} original value`, kind: 'project',
          ...(entity ? { entityType: 'THING' } : {}) })})`;
      if (indexed) await reindex(label, entity ? 'entity' : 'memory');
    };
    async function reindex(label: string, kind = 'memory') {
      await db.sql`INSERT INTO harness_shared.memory_vec_gemma (memory_id,vector,row_kind)
        VALUES (${id(label)},${JSON.stringify(vector)}::vector,${kind})
        ON CONFLICT (memory_id) DO UPDATE SET vector=EXCLUDED.vector,row_kind=EXCLUDED.row_kind`;
    }
    const run = (filters: Record<string, unknown>) => mode === 'lexical'
      ? store.lexicalSearch(query, 20, filters)
      : store.searchWithProfile(vector, profile, 20, filters);
    const canonical = async (filters: Record<string, unknown>) => {
      const rows = await db.sql`SELECT id,payload,state,created_at,updated_at,valid_at,invalid_at,
        superseded_by,xmin::text AS revision FROM harness_shared.memory_canonical ORDER BY id`;
      const vectors = await db.sql`SELECT memory_id,vector::text,row_kind,xmin::text AS revision
        FROM harness_shared.memory_vec_gemma ORDER BY memory_id`;
      return { rows, vectors, readAtMs: Date.now(), epoch: fingerprint(filters) };
    };
    async function capture(phase: string, labels: string[], controls: Record<string, unknown> = {}) {
      const filters = { user_id: scope, ...controls };
      const requestStartedAtMs = Date.now();
      const before = await canonical(filters);
      const rows = await run(filters);
      const responseAtMs = Date.now();
      const after = await canonical(filters);
      expect(after.rows).toEqual(before.rows);
      expect(after.vectors).toEqual(before.vectors);
      expect(rows.map(row => row.id).sort()).toEqual(labels.map(id).sort());
      const observations = rows.flatMap(row => {
        const raw = after.rows.find(candidate => candidate.id === row.id)!;
        expect(raw).toBeDefined();
        return policies.map(policy => {
          const field = policy.fieldPath;
          const input = { returned: { entityRef: row.id, fieldPath: field,
            valueFingerprint: fingerprint(row.payload[field] ?? null) }, indexed: null,
            canonical: { entityRef: row.id, fieldPath: field,
              valueFingerprint: fingerprint(raw.payload[field] ?? null), authority: policy.authority,
              authorityEpoch: after.epoch, sourceRevision: String(raw.revision), readAtMs: after.readAtMs },
            requestStartedAtMs, responseAtMs };
          const oracle = assertSearchFieldFreshness(policy, input);
          expect(row.payload[field]).toEqual(raw.payload[field]);
          expect(oracle.status).toBe('unknown');
          expect(oracle.action).toBe('degrade');
          expect(oracle.reasons).toContain('index witness unavailable');
          return { id: row.id, field, input, oracle };
        });
      });
      receipts.push({ caseId: `canonical-memory/${mode}`, phase, filters,
        expectedIds: labels.map(id), before, after, rows, observations });
      return { rows, after, observations };
    }
    await seed('target');
    await seed('foreign', `${scope}-foreign`);
    await seed('entity', scope, true, true);
    await seed('archived');
    await db.sql`UPDATE harness_shared.memory_canonical SET state='archived' WHERE id=${id('archived')}`;
    const initial = await capture('initial-fields-scope-kind-and-archive-fences', ['target']);
    // Mutable canonical payload changes while timestamps and vectors stay fixed.
    await db.sql`UPDATE harness_shared.memory_canonical SET payload=payload ||
      ${db.sql.json({ name: `${query} replacement name`, description: `${query} replacement description`,
        data: `${query} replacement value`, kind: 'preference' })} WHERE id=${target}`;
    const changed = await capture('canonical-content-changed-vector-and-dates-unchanged', ['target']);
    const oldRaw = initial.after.rows.find(row => row.id === target)!;
    const newRaw = changed.after.rows.find(row => row.id === target)!;
    expect(newRaw.revision).not.toBe(oldRaw.revision);
    expect(newRaw.updated_at).toEqual(oldRaw.updated_at);
    expect(changed.after.vectors).toEqual(initial.after.vectors);
    for (const field of ['name', 'description', 'data', 'kind']) {
      const previous = initial.observations.find(row => row.id === target && row.field === field)!;
      const current = changed.observations.find(row => row.id === target && row.field === field)!;
      const input = { ...current.input, returned: previous.input.returned };
      const oracle = assertSearchFieldFreshness(policies.find(policy => policy.fieldPath === field)!, input);
      expect(oracle.status).toBe('stale');
      expect(oracle.reasons).toContain('canonical: returned value differs');
      receipts.push({ caseId: `canonical-memory/${mode}`, phase: 'copied-old-field-fresh-envelope', field, input, oracle });
    }
    await seed('added', scope, false);
    await capture('canonical-add-before-vector', mode === 'lexical' ? ['target', 'added'] : ['target']);
    await reindex('added');
    await capture('candidate-after-controlled-vector-backfill', ['target', 'added']);
    await db.sql`DELETE FROM harness_shared.memory_canonical WHERE id=${id('added')}`;
    await capture('orphan-vector-after-parent-delete', ['target']);
    await db.sql`DELETE FROM harness_shared.memory_vec_gemma WHERE memory_id=${target}`;
    await capture('canonical-present-vector-missing', mode === 'lexical' ? ['target'] : []);
    await reindex('target');
    await capture('vector-restored', ['target']);
    // Payload scope changes independently from vector identity/content.
    await db.sql`UPDATE harness_shared.memory_canonical SET payload=payload ||
      ${db.sql.json({ user_id: `${scope}-moved` })} WHERE id=${target}`;
    await capture('scope-moved-old-reader', []);
    const moved = await capture('scope-moved-new-reader', ['target'], { user_id: `${scope}-moved` });
    expect(moved.after.epoch).not.toBe(initial.after.epoch);
    await capture('foreign-scope-positive-control', ['foreign'], { user_id: `${scope}-foreign` });
    await db.sql`UPDATE harness_shared.memory_canonical SET payload=payload ||
      ${db.sql.json({ user_id: scope })},valid_at='2019-01-01T00:00:00Z',invalid_at='2020-01-01T00:00:00Z',
      superseded_by=${id('replacement')} WHERE id=${target}`;
    const [window] = await db.sql`SELECT valid_at,invalid_at FROM harness_shared.memory_canonical WHERE id=${target}`;
    expect(window.valid_at).toEqual(new Date('2019-01-01T00:00:00Z'));
    expect(window.invalid_at).toEqual(new Date('2020-01-01T00:00:00Z'));
    await capture('closed-validity-excluded-by-default', []);
    const historical = await capture('half-open-validity-inside', ['target'], { as_of: '2019-06-01T00:00:00Z' });
    expect((historical.rows[0].payload.validity as { status: string }).status).toBe('current');
    await capture('half-open-validity-end-excluded', [], { as_of: '2020-01-01T00:00:00Z' });
    await capture('as-of-boundary-not-widened-by-history-flag', [],
      { as_of: '2020-01-01T00:00:00Z', include_superseded: true });
    const lifecycle = await capture('explicit-lifecycle-read', ['target'], { include_superseded: true });
    expect((lifecycle.rows[0].payload.validity as { status: string }).status).toBe('superseded');
    if (mode === 'vector') {
      expect(await store.searchWithProfile(vector, EMBEDDER_DIM_SPECS.openai, 20,
        { user_id: scope, include_superseded: true })).toEqual([]);
      expect(await store.search(vector.slice(1), 20, { user_id: scope })).toEqual([]);
      receipts.push({ caseId: `canonical-memory/${mode}`, phase: 'wrong-profile-and-width-refused' });
    }
    completed.push(`canonical-memory/${mode}`);
  });
});

afterAll(async () => {
  try {
    if (process.env.PAPERCUSP_CANONICAL_MEMORY_SOURCE_WITNESS_FILE) {
      const paths = ['packages/operator-core/lib/memory/canonical-source-freshness.integration.test.ts',
        'libs/generic/memory/src/canonical-store.ts', 'libs/generic/memory/src/embedder-dims.ts',
        'libs/generic/memory/src/vec-write.ts'];
      const pins = paths.map(path => ({ path, sha256: createHash('sha256')
        .update(readFileSync(new URL(`../../../../${path}`, import.meta.url))).digest('hex') }));
      writeFileSync(process.env.PAPERCUSP_CANONICAL_MEMORY_SOURCE_WITNESS_FILE, JSON.stringify({
        schemaVersion: 1, population, completed, pins, query, profileId: profile.profileId,
        queryVectorFingerprint: fingerprint(vector), policies, receipts, limits: [
          'Real CanonicalVectorStore lexical/vector readers over a minimal private PostgreSQL schema.',
          'Controlled payload, vector backfill, scope and validity changes; no production managed-write/ingest witness.',
          'No HNSW index, query embedder, model quality, hybrid fusion, memory:search handler or injection-path proof.',
          'Fixture filter epoch is not trusted server authorization; field/index revision proof remains unavailable.',
          'Matching fields remain unknown; copied stale values are rejected; omitted candidates are separate.',
          'Historical validity status is a lifecycle label, never a field-freshness current claim.',
          'Other memory surfaces, Restart, budgets, runtime acceptance and shipment remain open.',
        ],
      }, null, 2) + '\n');
    }
  } finally {
    await store?.dispose();
    await db?.cleanup();
  }
});
