/**
 * datatype-registry.integration.test.ts — the datatype registry CRUD + dedup
 * (`harness_shared.datatype_registry`, migration 421;
 * reflexive-platform-extensibility-datatypes-2026-06-24 P-013) against real Postgres.
 *
 * Mirrors code-recipes-store.integration.test.ts: the store is transport-agnostic
 * (every fn TAKES the `sql` handle), so we pass the org-fixture's admin (RLS-bypass)
 * client directly and scope by the explicit workspaceId arg. This ALSO verifies that
 * migration 421 applies cleanly on the real baseline (the generated title_tsv column,
 * the VECTOR (prose-width) column, the JSONB payload/self_improvement columns, the partial
 * unique index on work_item_kind) — the thing a unit test can't cover.
 *
 * Validates: upsert insert→update-in-place by (workspace,id); tier routing fields;
 * hasGenericKind (the P-001 work_items:create gate); findSimilarDatatypes (the D-010
 * soft semantic-dedup, title_tsv lexical leg); list/count; listRegisteredDatatypeNames;
 * and WORKSPACE ISOLATION (a datatype in ws-A is invisible from ws-B).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  upsertDatatype,
  getDatatype,
  listDatatypes,
  countDatatypes,
  findSimilarDatatypes,
  hasGenericKind,
  listRegisteredDatatypeNames,
} from './datatype-registry-store';
import { PROSE_VECTOR_DIMS } from './search/prose-vector-dims';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { resolveProseProfileSelection } from './search/prose-vector-dims';

const { createOrgTestDb } = await import('../test/_org-test-db');

/**
 * A throwaway embedding (only presence/cosine is exercised, not a real vector).
 *
 * DERIVED from `PROSE_VECTOR_DIMS`, never restated. `datatype_registry.embedding`
 * is one of the columns that constant governs (it is listed in
 * `PROSE_VECTOR_COLUMNS`), so a hardcoded width here goes stale the moment a
 * width migration lands — which is exactly what happened: migration 727 moved
 * every prose column 384 → 768 and this fixture stayed at 384, so both upsert
 * tests failed with `expected 768 dimensions, not 384`. That is the precise
 * failure mode prose-vector-dims.ts exists to prevent ("a declaration that can
 * drift from the code it describes is just a second docblock") — it just could
 * not see this copy, because the copy lived in a test.
 */
const fakeEmbedding = (seed = 0.1): number[] => Array.from({ length: PROSE_VECTOR_DIMS }, () => seed);
const profiledEmbedding = (embedding: number[]) => ({
  embedding,
  embeddingMode: 'gemma' as const,
  embeddingProfile: resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma)!,
});

describe('datatype_registry store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    // Profile columns also come from the migrated fixture. Replaying 1154 here
    // would ALTER personal_documents after 1327 has made it a compatibility view.
    // createOrgTestDb applies the FULL migration set (incl. 421/425 and the D-007
    // pot-rename 506/523), so datatype_registry already exists in its post-rename
    // (pot_slug) shape — a broken 421 would fail the fixture setup itself, so the
    // "does the migration apply?" check is preserved. (Replaying 421 verbatim here is
    // now redundant AND re-runs its old hive_slug index against the post-523 schema,
    // 42703-ing "column hive_slug does not exist".)
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('declares a generic-kind datatype and reads it back (get + list + count)', async () => {
    const ws = 'ws-dt-basic';
    const row = await upsertDatatype(db.adminSql, {
      id: 'bet',
      workspaceId: ws,
      potSlug: 'oddsmith-ops',
      title: 'Bet',
      description: 'a thesis: market + p_model + edge + rationale',
      tier: 'generic-kind', nature: 'record', // D-007: a bet is a record
      workItemKind: 'bet',
      payloadSchema: { type: 'object', properties: { market: { type: 'string' }, edge: { type: 'number' } } },
      display: { widget: 'record', params: { fields: [{ name: 'market', datatype: 'string', required: true }] }, summary: '{{market}}' },
      selfImprovement: { improvements: ['miscalibrated'], scorecard: 'brier', gym: ['no-stale-data'] },
      ...profiledEmbedding(fakeEmbedding()),
      tags: ['oddsmith'],
      createdBy: 'owner-1',
    });
    expect(row.id).toBe('bet');
    expect(row.tier).toBe('generic-kind');
    expect(row.workItemKind).toBe('bet');
    expect(row.authoritativeWriter).toBe('papercusp');
    expect(row.hasEmbedding).toBe(true);
    const [storedIdentity] = await db.adminSql<Array<{
      embedding_mode: string | null;
      embedding_profile: string | null;
    }>>`
      SELECT embedding_mode, embedding_profile
        FROM harness_shared.datatype_registry
       WHERE workspace_id = ${ws} AND id = 'bet'`;
    expect(storedIdentity).toEqual({
      embedding_mode: 'gemma',
      embedding_profile: EMBEDDER_DIM_SPECS.gemma.profileId,
    });
    expect(row.payloadSchema).toMatchObject({ type: 'object' });
    expect(row.display).toMatchObject({ widget: 'record', summary: '{{market}}' });
    expect(row.selfImprovement).toMatchObject({ scorecard: 'brier' });

    const got = await getDatatype(db.adminSql, ws, 'bet');
    expect(got?.title).toBe('Bet');

    const list = await listDatatypes(db.adminSql, ws);
    expect(list.map((d) => d.id)).toContain('bet');
    expect(await countDatatypes(db.adminSql, ws)).toBe(1);
  });

  it('re-declaring the same id UPDATES in place (and COALESCE-preserves the embedding)', async () => {
    const ws = 'ws-dt-update';
    await upsertDatatype(db.adminSql, {
      id: 'wager', workspaceId: ws, title: 'Wager', description: 'first', tier: 'generic-kind', nature: 'record',
      ...profiledEmbedding(fakeEmbedding(0.2)), createdBy: 'a',
    });
    const updated = await upsertDatatype(db.adminSql, {
      id: 'wager', workspaceId: ws, title: 'Wager', description: 'an intent: proposed stake/price/size',
      tier: 'generic-kind', nature: 'record', embedding: null, createdBy: 'b', // null embedding must NOT wipe the stored one
    });
    expect(updated.description).toBe('an intent: proposed stake/price/size');
    expect(updated.hasEmbedding).toBe(true); // preserved via COALESCE
    expect(await countDatatypes(db.adminSql, ws)).toBe(1); // updated, not duplicated
  });

  it('hasGenericKind gates registered generic-kinds (the P-001 work_items:create gate)', async () => {
    const ws = 'ws-dt-kind';
    await upsertDatatype(db.adminSql, {
      id: 'forecast', workspaceId: ws, title: 'Forecast', description: 'a probability forecast',
      tier: 'generic-kind', nature: 'record', workItemKind: 'forecast', createdBy: 'a',
    });
    // a projection-tier datatype registers NO work_item_kind → not a generic-kind gate hit
    await upsertDatatype(db.adminSql, {
      id: 'position', workspaceId: ws, title: 'Position', description: 'money-truth position',
      tier: 'projection', nature: 'record', authoritativeWriter: 'engine:oddsmith', createdBy: 'a',
    });
    expect(await hasGenericKind(db.adminSql, ws, 'forecast')).toBe(true);
    expect(await hasGenericKind(db.adminSql, ws, 'position')).toBe(false); // projection, no kind
    expect(await hasGenericKind(db.adminSql, ws, 'feature')).toBe(false); // built-in, not registered
    expect(await hasGenericKind(db.adminSql, ws, 'nonexistent')).toBe(false);
    expect((await listRegisteredDatatypeNames(db.adminSql, ws)).sort()).toEqual(['forecast', 'position']);
  });

  it('findSimilarDatatypes surfaces a near-duplicate via the title_tsv lexical leg (D-010 dedup)', async () => {
    const ws = 'ws-dt-dedup';
    await upsertDatatype(db.adminSql, {
      id: 'calibration-record', workspaceId: ws, title: 'Calibration record',
      description: 'a record of forecast calibration accuracy over time', tier: 'generic-kind', nature: 'record', createdBy: 'a',
    });
    const hits = await findSimilarDatatypes(db.adminSql, ws, {
      title: 'calibration accuracy log',
      description: 'tracks forecast calibration accuracy',
    });
    expect(hits.map((h) => h.id)).toContain('calibration-record');
    expect(hits[0]?.score).toBeGreaterThan(0);
    // an unrelated query returns nothing
    const none = await findSimilarDatatypes(db.adminSql, ws, { title: 'kubernetes ingress controller' });
    expect(none.find((h) => h.id === 'calibration-record')).toBeUndefined();
  });

  it('semantic neighbours require exact profile identity; current-mode legacy rows remain compatible', async () => {
    const ws = 'ws-dt-profile';
    await upsertDatatype(db.adminSql, {
      id: 'semantic-profile-control',
      workspaceId: ws,
      title: 'Profile anchor',
      description: 'vector-only candidate',
      tier: 'generic-kind', nature: 'work', audience: 'agent',
      ...profiledEmbedding(fakeEmbedding(0.25)),
    });
    await db.adminSql`
      UPDATE harness_shared.datatype_registry
         SET embedding_profile = ${EMBEDDER_DIM_SPECS.openai.profileId}
       WHERE workspace_id = ${ws} AND id = 'semantic-profile-control'`;
    const query = {
      title: 'unrelated-token-zqxj',
      embedding: fakeEmbedding(0.25),
      embeddingProfile: resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma)!,
    };
    expect((await findSimilarDatatypes(db.adminSql, ws, query)).map((row) => row.id))
      .not.toContain('semantic-profile-control');

    await db.adminSql`
      UPDATE harness_shared.datatype_registry
         SET embedding_mode = 'gemma', embedding_profile = NULL
       WHERE workspace_id = ${ws} AND id = 'semantic-profile-control'`;
    expect((await findSimilarDatatypes(db.adminSql, ws, query)).map((row) => row.id))
      .toContain('semantic-profile-control');
  });

  it('is WORKSPACE-ISOLATED — a datatype declared in ws-A is invisible from ws-B', async () => {
    await upsertDatatype(db.adminSql, {
      id: 'order', workspaceId: 'ws-A', title: 'Order', description: 'an order', tier: 'projection', nature: 'record', createdBy: 'a',
    });
    expect(await getDatatype(db.adminSql, 'ws-A', 'order')).not.toBeNull();
    expect(await getDatatype(db.adminSql, 'ws-B', 'order')).toBeNull();
    expect(await hasGenericKind(db.adminSql, 'ws-B', 'order')).toBe(false);
  });

  // The read-filter broadening (P-001): listWorkItems/countWorkItems/searchWorkItems use
  // featureFamilyKindClause(sql, ws), which admits the 3 built-in feature kinds OR a
  // registered generic-kind. Verify the exact SQL logic against a seeded feature table:
  // a registered generic-kind row IS visible, an UNregistered one is NOT (the dark gate).
  it('feature-family read filter admits a REGISTERED generic-kind but not an unregistered one', async () => {
    const ws = 'ws-vis';
    await upsertDatatype(db.adminSql, {
      id: 'bet', workspaceId: ws, title: 'Bet', description: 'a thesis', tier: 'generic-kind', nature: 'record', workItemKind: 'bet', createdBy: 'a',
    });
    // a registered generic-kind item + an UNregistered-kind item, both in the workspace
    await db.adminSql`
      INSERT INTO harness_shared.harness_features_consolidated
        (harness_slug, feature_id, title, summary, status, item_kind, taken_by, workspace_id,
         feature_order, metadata, origin, ts, created_ts, updated_ts)
      VALUES
        ('oddsmith', 'F-BET', 'a bet', '', 'todo', 'bet',   NULL, ${ws}, 1, '{}'::jsonb, 'local', 1000, 1000, 1000),
        ('oddsmith', 'F-WAG', 'a wager', '', 'todo', 'wager', NULL, ${ws}, 2, '{}'::jsonb, 'local', 1000, 1000, 1000)`;
    // the exact predicate featureFamilyKindClause produces
    const rows = await db.adminSql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.harness_features_consolidated
       WHERE (item_kind IN ('feature', 'chunk')
              OR item_kind IN (
                SELECT work_item_kind FROM harness_shared.datatype_registry
                 WHERE workspace_id = ${ws} AND tier = 'generic-kind' AND status = 'active'
                   AND work_item_kind IS NOT NULL))
         AND workspace_id = ${ws}
       ORDER BY feature_id`;
    const ids = rows.map((r) => r.feature_id);
    expect(ids).toContain('F-BET');   // registered generic-kind → visible
    expect(ids).not.toContain('F-WAG'); // unregistered kind → hidden (the dark gate)
  });
});
