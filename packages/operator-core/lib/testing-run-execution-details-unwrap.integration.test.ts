/**
 * EI-24799048791133095: test_runs.execution_details must be stored as a jsonb
 * OBJECT. Writers that hand postgres-js a pre-stringified value through a client
 * that keeps the default jsonb serializer (JSON.stringify) get it encoded twice,
 * and the row lands as a jsonb STRING scalar. `execution_details->>'key'` then
 * reads NULL: a confident, well-formed empty answer. On 2026-10-01, 826,257 ledger
 * rows were shaped that way.
 *
 * This applies exactly the real migration 1311 to a minimal test_runs table and
 * asserts both halves: the backfill of existing string rows, and the trigger
 * that normalizes rows written by older-generation writers still deployed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, '../../../libs/papercusp/libs/db/sql/1311-test-runs-execution-details-unwrap.sql'),
  'utf8',
);

const details = { schemaVersion: 1, mutationPhase: 'mutant', passed: 1 };

let db: FreshPgDb;

async function typeAndPhase(id: number): Promise<{ t: string | null; phase: string | null }> {
  const [row] = await db.sql<{ t: string | null; phase: string | null }[]>`
    SELECT jsonb_typeof(execution_details) AS t, execution_details->>'mutationPhase' AS phase
      FROM harness_shared.test_runs WHERE id = ${id}`;
  return row!;
}

async function insertRaw(value: unknown): Promise<number> {
  // `${JSON.stringify(x)}::jsonb` on this client (default jsonb serializer) is
  // exactly the writer bug: it double-encodes into a jsonb string scalar.
  const [row] = await db.sql<{ id: number }[]>`
    INSERT INTO harness_shared.test_runs (execution_details)
    VALUES (${value === null ? null : JSON.stringify(value)}::jsonb) RETURNING id`;
  return Number(row!.id);
}

describe('migration 1311: test_runs.execution_details is a jsonb object', () => {
  let legacyString: number;
  let legacyInvalid: number;
  let legacyObject: number;
  let legacyNull: number;

  beforeAll(async () => {
    db = await createFreshPgDb('exec-details-unwrap');
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.test_runs (
        id bigserial PRIMARY KEY,
        execution_details jsonb
      )`);
    legacyString = await insertRaw(details);
    // A string that is not valid JSON text must survive untouched.
    const [bad] = await db.sql<{ id: number }[]>`
      INSERT INTO harness_shared.test_runs (execution_details)
      VALUES (to_jsonb('{not json'::text)) RETURNING id`;
    legacyInvalid = Number(bad!.id);
    const [obj] = await db.sql<{ id: number }[]>`
      INSERT INTO harness_shared.test_runs (execution_details)
      VALUES (${JSON.stringify(details)}::text::jsonb) RETURNING id`;
    legacyObject = Number(obj!.id);
    legacyNull = await insertRaw(null);

    // Calibration: the fixture really reproduces the defect before the migration.
    expect(await typeAndPhase(legacyString)).toEqual({ t: 'string', phase: null });
    expect(await typeAndPhase(legacyObject)).toEqual({ t: 'object', phase: 'mutant' });

    await db.sql.unsafe(MIGRATION);
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('backfills existing double-encoded rows into objects', async () => {
    expect(await typeAndPhase(legacyString)).toEqual({ t: 'object', phase: 'mutant' });
  });

  it('leaves objects, NULLs and non-JSON strings as they were', async () => {
    expect(await typeAndPhase(legacyObject)).toEqual({ t: 'object', phase: 'mutant' });
    expect(await typeAndPhase(legacyNull)).toEqual({ t: null, phase: null });
    const [bad] = await db.sql<{ t: string; v: string }[]>`
      SELECT jsonb_typeof(execution_details) AS t, execution_details #>> '{}' AS v
        FROM harness_shared.test_runs WHERE id = ${legacyInvalid}`;
    expect(bad).toEqual({ t: 'string', v: '{not json' });
  });

  it('normalizes a double-encoded INSERT from an older-generation writer', async () => {
    const id = await insertRaw(details);
    expect(await typeAndPhase(id)).toEqual({ t: 'object', phase: 'mutant' });
  });

  it('normalizes a double-encoded UPDATE of execution_details', async () => {
    const id = await insertRaw(null);
    await db.sql`
      UPDATE harness_shared.test_runs
         SET execution_details = ${JSON.stringify(details)}::jsonb
       WHERE id = ${id}`;
    expect(await typeAndPhase(id)).toEqual({ t: 'object', phase: 'mutant' });
  });

  it('is idempotent when applied again', async () => {
    await expect(db.sql.unsafe(MIGRATION)).resolves.toBeDefined();
    expect(await typeAndPhase(legacyString)).toEqual({ t: 'object', phase: 'mutant' });
  });
});
