/**
 * Real-PostgreSQL removal-parity guard for temporal-lite memory (P-012).
 *
 * This runs the production backend stack over the fully migrated schema:
 * CanonicalVectorStore -> Mem0Backend -> hybrid-pg's LexicalLegBackend /
 * HybridBackend composition. It proves the two intentionally different
 * removal contracts at the storage boundary:
 *
 *   - hard/privacy removal deletes the canonical source, every derived vector
 *     space, anchors, replayable journal content, and both semantic + lexical
 *     recallability without touching another scope;
 *   - soft removal closes the validity window and cancels replay, while keeping
 *     the canonical/vector/anchor/committed-journal history available only via
 *     explicit historical reads.
 *
 * Run:
 *   npm run test:file -- packages/operator-core/lib/memory/memory-removal-parity.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CanonicalVectorStore } from '../../../../libs/generic/memory/src/canonical-store';
import { HybridBackend } from '../../../../libs/generic/memory/src/hybrid-backend';
import { LexicalLegBackend } from '../../../../libs/generic/memory/src/lexical-leg';
import { Mem0Backend } from '../../../../libs/generic/memory/src/mem0-backend';
import { EMBEDDER_DIM_SPECS } from '../../../../libs/generic/memory/src/embedder-dims';
import { MEMORY_VECTOR_STORAGE_PROFILES } from '../../../../libs/generic/memory/src/vec-write';
import type { EmbedderProfileSpec } from '../../../../libs/generic/memory/src/embedder-dims';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { purgeJournalForMemory } from './write-journal';

const TARGET_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const SOFT_ID = '33333333-3333-4333-8333-333333333333';
const REPL_ID = '44444444-4444-4444-8444-444444444444';
const SCOPE_A = 'harness:removal-a';
const SCOPE_B = 'harness:removal-b';
const VECTOR_384 = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
const VECTOR_768_LITERAL = `[${Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
const VECTOR_1024_LITERAL = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
const VECTOR_384_LITERAL = `[${VECTOR_384.join(',')}]`;

type CanonicalRow = Awaited<ReturnType<CanonicalVectorStore['get']>>;

function toMem0Row(row: NonNullable<CanonicalRow>) {
  const {
    data,
    user_id: userId,
    ...metadata
  } = row.payload as { data?: unknown; user_id?: unknown } & Record<string, unknown>;
  return {
    id: row.id,
    memory: typeof data === 'string' ? data : String(data ?? ''),
    user_id: typeof userId === 'string' ? userId : undefined,
    metadata,
  };
}

describe('memory removal parity (fully migrated real PG)', () => {
  let db: OrgTestDb;
  let store: CanonicalVectorStore;
  let mem0: Mem0Backend;
  let hybrid: HybridBackend;

  beforeAll(async () => {
    db = await createOrgTestDb();
    const dsn = new URL(db.adminDsn);
    store = new CanonicalVectorStore({
      host: dsn.hostname,
      port: Number(dsn.port),
      user: decodeURIComponent(dsn.username),
      password: decodeURIComponent(dsn.password),
      dbname: dsn.pathname.slice(1),
      schema: 'harness_shared',
      collectionName: 'operator_memory_local',
      vecTable: 'memory_vec_local',
      embeddingModelDims: VECTOR_384.length,
      embeddingProfile: EMBEDDER_DIM_SPECS.local,
      storageProfile: MEMORY_VECTOR_STORAGE_PROFILES.local,
    });

    const client = {
      get: async (id: string) => {
        const row = await store.get(id);
        return row ? toMem0Row(row) : null;
      },
      delete: async (id: string) => {
        await store.delete(id);
        return {};
      },
      getAll: async (opts: { filters?: Record<string, string>; topK?: number }) => {
        const [rows] = await store.list(opts.filters, opts.topK ?? 100);
        return { results: rows.map((row) => toMem0Row(row)) };
      },
      search: async (
        query: string,
        opts: { filters?: Record<string, string>; topK?: number; limit?: number },
      ) => {
        const rows = await store.lexicalSearch(
          query,
          opts.topK ?? opts.limit ?? 8,
          opts.filters,
        );
        return {
          results: rows.map((row) => ({ ...toMem0Row(row), score: row.score })),
        };
      },
    };

    mem0 = new Mem0Backend({
      getClient: async () => client as never,
      lexicalSearch: (query, topK, filters) => store.lexicalSearch(query, topK, filters),
      invalidateEntry: (id, opts) => store.invalidate(id, opts),
    });
    // This is the production hybrid-pg shape: the lexical leg is a different
    // ranking over the SAME canonical store, so it must neither double-write
    // nor double-delete the row.
    hybrid = new HybridBackend(new LexicalLegBackend(mem0), mem0, {
      name: 'hybrid-pg-removal-parity',
    });
  }, 120_000);

  afterAll(async () => {
    await store?.dispose();
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.adminSql.unsafe(`
      TRUNCATE
        harness_shared.memory_write_journal,
        harness_shared.memory_anchors,
        harness_shared.memory_vec_local,
        harness_shared.memory_vec_openai,
        harness_shared.memory_vec_gemma,
        harness_shared.memory_vec_harrier,
        harness_shared.memory_canonical
      CASCADE
    `);
  });

  async function seedMemory(id: string, scope: string, text: string): Promise<void> {
    await store.insert([VECTOR_384], [id], [{ data: text, user_id: scope, kind: 'project' }]);
    await db.adminSql`
      INSERT INTO harness_shared.memory_vec_openai (memory_id, vector)
      VALUES (${id}::uuid, ${VECTOR_768_LITERAL}::vector)`;
    await db.adminSql`
      INSERT INTO harness_shared.memory_vec_gemma (memory_id, vector)
      VALUES (${id}::uuid, ${VECTOR_768_LITERAL}::vector)`;
    await db.adminSql`
      INSERT INTO harness_shared.memory_vec_harrier (memory_id, vector)
      VALUES (${id}::uuid, ${VECTOR_1024_LITERAL}::vector)`;
    await db.adminSql`
      INSERT INTO harness_shared.memory_anchors (memory_id, kind, value)
      VALUES (${id}::uuid, 'file', ${`memory-${id}.md`})`;
  }

  async function seedJournal(args: {
    scope: string;
    content: string;
    status: 'pending' | 'committed';
    committedMemoryId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await db.adminSql`
      INSERT INTO harness_shared.memory_write_journal
        (scope, content, status, committed_memory_id, committed_at, metadata)
      VALUES (
        ${args.scope},
        ${args.content},
        ${args.status},
        ${args.committedMemoryId ?? null}::uuid,
        ${args.status === 'committed' ? new Date() : null},
        ${args.metadata ? JSON.stringify(args.metadata) : null}::text::jsonb
      )`;
  }

  async function artifactCounts(id: string) {
    const [row] = await db.adminSql<
      Array<{
        canonical: number;
        local_vec: number;
        openai_vec: number;
        gemma_vec: number;
        harrier_vec: number;
        anchors: number;
      }>
    >`
      SELECT
        (SELECT count(*)::int FROM harness_shared.memory_canonical WHERE id = ${id}::uuid) AS canonical,
        (SELECT count(*)::int FROM harness_shared.memory_vec_local WHERE memory_id = ${id}::uuid) AS local_vec,
        (SELECT count(*)::int FROM harness_shared.memory_vec_openai WHERE memory_id = ${id}::uuid) AS openai_vec,
        (SELECT count(*)::int FROM harness_shared.memory_vec_gemma WHERE memory_id = ${id}::uuid) AS gemma_vec,
        (SELECT count(*)::int FROM harness_shared.memory_vec_harrier WHERE memory_id = ${id}::uuid) AS harrier_vec,
        (SELECT count(*)::int FROM harness_shared.memory_anchors WHERE memory_id = ${id}::uuid) AS anchors`;
    return row;
  }

  it('ranks only an exact-profile query and fails closed for an equal-width foreign profile', async () => {
    await seedMemory(TARGET_ID, SCOPE_A, 'profile-bound semantic target');
    const exact = await store.searchWithProfile(
      VECTOR_384,
      EMBEDDER_DIM_SPECS.local,
      5,
      { user_id: SCOPE_A },
    );
    expect(exact.map((row) => row.id)).toEqual([TARGET_ID]);

    const foreign: EmbedderProfileSpec = {
      ...EMBEDDER_DIM_SPECS.local,
      profileId: 'equal-width-foreign-space@v1',
    };
    await expect(
      store.searchWithProfile(VECTOR_384, foreign, 5, { user_id: SCOPE_A }),
    ).resolves.toEqual([]);
  });

  it('hard forget removes every recall surface and replay source without crossing scopes', async () => {
    const targetText = 'private cobalt needle';
    const otherText = 'other-scope amber needle';
    await seedMemory(TARGET_ID, SCOPE_A, targetText);
    await seedMemory(OTHER_ID, SCOPE_B, otherText);

    await seedJournal({
      scope: SCOPE_A,
      content: targetText,
      status: 'committed',
      committedMemoryId: TARGET_ID,
    });
    await seedJournal({
      scope: SCOPE_A,
      content: 'pending target edit',
      status: 'pending',
      metadata: { __journal_update_of: TARGET_ID },
    });
    await seedJournal({
      scope: SCOPE_A,
      content: 'pending target replacement',
      status: 'pending',
      metadata: { __journal_supersede_of: TARGET_ID },
    });
    // A timed-out remember can land canonically before its journal row learns
    // the id. Exact scope+content is the only link available in that state.
    await seedJournal({ scope: SCOPE_A, content: targetText, status: 'pending' });
    await seedJournal({ scope: SCOPE_B, content: targetText, status: 'pending' });

    expect((await store.search(VECTOR_384, 5, { user_id: SCOPE_A })).map((row) => row.id)).toEqual([
      TARGET_ID,
    ]);
    expect((await hybrid.searchLexical('cobalt', { scope: SCOPE_A })).map((row) => row.id)).toEqual([
      TARGET_ID,
    ]);
    expect(await mem0.get(TARGET_ID)).not.toBeNull();

    await expect(
      purgeJournalForMemory(
        { id: TARGET_ID, mode: 'hard', snapshot: { scope: SCOPE_A, text: targetText } },
        { sql: db.adminSql as never },
      ),
    ).resolves.toBe(4);
    await hybrid.forget(TARGET_ID);

    expect(await artifactCounts(TARGET_ID)).toEqual({
      canonical: 0,
      local_vec: 0,
      openai_vec: 0,
      gemma_vec: 0,
      harrier_vec: 0,
      anchors: 0,
    });
    expect(await store.get(TARGET_ID)).toBeNull();
    expect(await mem0.get(TARGET_ID)).toBeNull();
    expect(await store.search(VECTOR_384, 5, { user_id: SCOPE_A })).toEqual([]);
    expect(await hybrid.searchLexical('cobalt', { scope: SCOPE_A })).toEqual([]);

    // All id/snapshot-linked replay rows are gone, so the journal drain has no
    // source from which it could resurrect the forgotten content.
    const [replayable] = await db.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM harness_shared.memory_write_journal
       WHERE committed_memory_id::text = ${TARGET_ID}
          OR metadata->>'__journal_update_of' = ${TARGET_ID}
          OR metadata->>'__journal_supersede_of' = ${TARGET_ID}
          OR (scope = ${SCOPE_A} AND content = ${targetText})`;
    expect(replayable.n).toBe(0);

    // The same content in another scope is not a deletion target, and every
    // derived artifact + both recall paths remain intact there.
    expect(await artifactCounts(OTHER_ID)).toEqual({
      canonical: 1,
      local_vec: 1,
      openai_vec: 1,
      gemma_vec: 1,
      harrier_vec: 1,
      anchors: 1,
    });
    expect((await hybrid.searchLexical('amber', { scope: SCOPE_B })).map((row) => row.id)).toEqual([
      OTHER_ID,
    ]);
    const [otherJournal] = await db.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM harness_shared.memory_write_journal
       WHERE scope = ${SCOPE_B} AND content = ${targetText}`;
    expect(otherJournal.n).toBe(1);
  });

  it('soft forget cancels replay but preserves explicit historical reads and artifacts', async () => {
    const softText = 'historical violet needle';
    await seedMemory(SOFT_ID, SCOPE_A, softText);
    await seedMemory(OTHER_ID, SCOPE_B, 'current amber neighbor');
    const asOfBeforeClose = new Date().toISOString();

    await seedJournal({
      scope: SCOPE_A,
      content: softText,
      status: 'committed',
      committedMemoryId: SOFT_ID,
    });
    await seedJournal({
      scope: SCOPE_A,
      content: 'pending historical edit',
      status: 'pending',
      metadata: { __journal_update_of: SOFT_ID },
    });
    await seedJournal({ scope: SCOPE_A, content: softText, status: 'pending' });
    // A pending CORRECTION of the forgotten memory (a timed-out
    // remember { supersede }). It carries the replacement's content, so soft
    // forget must not cancel it (EI-26515229747561182).
    await seedJournal({
      scope: SCOPE_A,
      content: 'corrected indigo needle',
      status: 'pending',
      metadata: { __journal_supersede_of: SOFT_ID },
    });

    await expect(
      purgeJournalForMemory(
        { id: SOFT_ID, mode: 'soft', snapshot: { scope: SCOPE_A, text: softText } },
        { sql: db.adminSql as never },
      ),
    ).resolves.toBe(2);
    const [correction] = await db.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM harness_shared.memory_write_journal
       WHERE status = 'pending' AND metadata->>'__journal_supersede_of' = ${SOFT_ID}`;
    expect(correction.n).toBe(1);
    await expect(hybrid.invalidateEntry(SOFT_ID)).resolves.toBe(true);
    // A bare re-close of the already-closed row stays a first-wins no-op.
    await expect(hybrid.invalidateEntry(SOFT_ID)).resolves.toBe(false);

    expect(await artifactCounts(SOFT_ID)).toEqual({
      canonical: 1,
      local_vec: 1,
      openai_vec: 1,
      gemma_vec: 1,
      harrier_vec: 1,
      anchors: 1,
    });
    expect(await hybrid.searchLexical('violet', { scope: SCOPE_A })).toEqual([]);
    expect(
      (await hybrid.searchLexical('violet', { scope: SCOPE_A, includeSuperseded: true })).map(
        (row) => row.id,
      ),
    ).toEqual([SOFT_ID]);
    expect(
      (await hybrid.searchLexical('violet', { scope: SCOPE_A, asOf: asOfBeforeClose })).map(
        (row) => row.id,
      ),
    ).toEqual([SOFT_ID]);

    const historical = await mem0.get(SOFT_ID);
    expect(historical?.metadata?.validity).toMatchObject({ status: 'superseded' });
    const [journal] = await db.adminSql<Array<{ committed: number; pending: number }>>`
      SELECT
        count(*) FILTER (WHERE status = 'committed')::int AS committed,
        count(*) FILTER (WHERE status = 'pending')::int AS pending
        FROM harness_shared.memory_write_journal
       WHERE committed_memory_id::text = ${SOFT_ID}
          OR metadata->>'__journal_update_of' = ${SOFT_ID}
          OR (scope = ${SCOPE_A} AND content = ${softText})`;
    expect(journal).toEqual({ committed: 1, pending: 0 });

    // Lineage attach (EI-26515229747561182): the soft-forgotten row is closed
    // with no winner, so it still accepts its correction's link. Its window
    // stays as soft forget left it, and the first winner then stands.
    const closedAt = (historical?.metadata?.validity as { invalid_at?: unknown }).invalid_at;
    expect(closedAt).toBeTruthy();
    await seedMemory(REPL_ID, SCOPE_A, 'corrected indigo needle');
    await expect(hybrid.invalidateEntry(SOFT_ID, { supersededBy: REPL_ID })).resolves.toBe(true);
    const linked = await mem0.get(SOFT_ID);
    expect(linked?.metadata?.validity).toMatchObject({
      status: 'superseded',
      superseded_by: REPL_ID,
      invalid_at: closedAt,
    });
    await expect(hybrid.invalidateEntry(SOFT_ID, { supersededBy: OTHER_ID })).resolves.toBe(false);
    expect((await mem0.get(SOFT_ID))?.metadata?.validity).toMatchObject({ superseded_by: REPL_ID });

    expect((await hybrid.searchLexical('amber', { scope: SCOPE_B })).map((row) => row.id)).toEqual([
      OTHER_ID,
    ]);
  });
});
