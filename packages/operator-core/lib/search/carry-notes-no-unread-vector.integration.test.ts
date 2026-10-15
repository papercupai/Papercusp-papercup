/**
 * generic-rag-chunking-2026-09-29 P-014 / D-020 — carry notes carry NO unread vector.
 *
 * harness_shared.carry_notes.note_embedding had no reader (EI-24609404813504679:
 * zero `<=>` users; carry notes are recovered by scope key and full text), yet the
 * embed-backfill sweep kept filling it and every prose-width migration kept
 * resizing it. D-020 dropped it rather than invent a reader: migration 1243 removes
 * the column (+ mode/profile + both indexes) and the TARGETS entry is gone.
 *
 * This is the recurrence guard for the clause "every carry-note vector the embed
 * sweep fills is read by a search site": re-adding a carry-note vector column, or
 * a carry_notes embed target, fails HERE — a vector nobody reads must come with
 * its reader (and a change to this test) in the same change.
 */
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import { TARGETS } from './embed-backfill';
import { PROSE_VECTOR_COLUMNS } from './prose-vector-dims';

describe('carry notes carry no unread vector (generic-rag-chunking P-014 / D-020)', () => {
  let sql: postgres.Sql | undefined;

  beforeAll(async () => {
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'carry-notes-no-unread-vector.integration');
    sql = postgres(dsn, { max: 1, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('the migrated schema still has the carry_notes table (positive control)', async () => {
    const rows = await sql!<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'harness_shared' AND table_name = 'carry_notes'`;
    expect(rows[0]?.n).toBe(1);
  });

  it('carry_notes has no vector column and no embedding index after every migration', async () => {
    const cols = await sql!<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'carry_notes'
         AND (udt_name = 'vector' OR column_name LIKE 'note_embedding%')`;
    expect(cols.map((c) => c.column_name)).toEqual([]);
    const idx = await sql!<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'harness_shared' AND tablename = 'carry_notes'
         AND indexdef ILIKE '%embedding%'`;
    expect(idx.map((i) => i.indexname)).toEqual([]);
  });

  it('the embed-backfill sweep has no carry_notes target', () => {
    // Positive control: the sweep does target other prose tables, so an empty
    // TARGETS (a broken import) cannot pass this vacuously.
    expect(TARGETS.length).toBeGreaterThan(0);
    expect(TARGETS.map((t) => t.table)).not.toContain('harness_shared.carry_notes');
  });

  it('the prose-width dims registration has no carry_notes column', () => {
    // A PROSE_VECTOR_COLUMNS entry is what the next width migration ALTERs, so a
    // carry_notes entry would re-create the dropped vector's upkeep. Positive
    // control: the list is the real, populated registration (an empty list from a
    // broken import cannot pass vacuously).
    expect(PROSE_VECTOR_COLUMNS.length).toBeGreaterThan(0);
    expect(PROSE_VECTOR_COLUMNS).toContainEqual({ table: 'harness_shared.session_turns', column: 'text_embedding' });
    expect(PROSE_VECTOR_COLUMNS.map((c) => c.table)).not.toContain('harness_shared.carry_notes');
  });
});
