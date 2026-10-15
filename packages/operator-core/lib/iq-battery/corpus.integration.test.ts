/**
 * Corpus seeding tests — verify seedCorpus populates iq_battery_cases idempotently.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readRepoFile } from '@papercusp/test-config';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { seedCorpus, AllCases } from './corpus';

describe('seedCorpus', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const adminUri = await getTestPg();
    const dbName = `iq_battery_seed_${randomBytes(5).toString('hex')}`;
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
      await markManagedTestDatabase(admin, dbName);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const u = new URL(adminUri);
    u.pathname = `/${dbName}`;
    sql = postgres(u.toString(), { max: 8, onnotice: () => {} });

    // Apply the migration DDL — depth-/machine-proof walk-up (DG-6 P-049).
    const ddl = readRepoFile(__dirname, 'libs/papercusp/libs/db/sql/179-iq-battery-corpus.sql');
    await sql.unsafe(ddl);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    // Clear tables before each test (cascade to handle foreign keys)
    await sql.unsafe('TRUNCATE TABLE iq_battery_metrics, iq_battery_cases');
  });

  it('populates iq_battery_cases table from AllCases', async () => {
    await seedCorpus(sql);

    const cases = await sql<Array<{ id: string; variant: string; title: string }>>`
      SELECT id, variant, title FROM iq_battery_cases ORDER BY variant, id
    `;

    expect(cases.length).toBe(AllCases.length);
    expect(cases[0].variant).toBeDefined();
    expect(cases[0].title).toBeDefined();
    expect(cases[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('is idempotent — second run does not duplicate rows', async () => {
    await seedCorpus(sql);
    const firstCount = await sql<Array<{ count: number }>>`
      SELECT COUNT(*) as count FROM iq_battery_cases
    `;

    await seedCorpus(sql);
    const secondCount = await sql<Array<{ count: number }>>`
      SELECT COUNT(*) as count FROM iq_battery_cases
    `;

    expect(secondCount[0].count).toBe(firstCount[0].count);
  });

  it('re-seed refreshes prompt/ground_truth on existing rows (EI-162 propagation)', async () => {
    await seedCorpus(sql);
    const [row] = await sql<Array<{ id: string; prompt: string }>>`
      SELECT id, prompt FROM iq_battery_cases LIMIT 1
    `;

    await sql`UPDATE iq_battery_cases SET prompt = 'stale drifted prompt', ground_truth = '{}'::jsonb WHERE id = ${row.id}`;
    await seedCorpus(sql);

    const [after] = await sql<Array<{ prompt: string; ground_truth: Record<string, unknown> }>>`
      SELECT prompt, ground_truth FROM iq_battery_cases WHERE id = ${row.id}
    `;
    expect(after.prompt).toBe(row.prompt);
    expect(Object.keys(after.ground_truth).length).toBeGreaterThan(0);
  });

  it('stores ground_truth and rubric as jsonb', async () => {
    await seedCorpus(sql);

    // The column TYPE is what "stored as jsonb" actually means — assert it
    // directly. (postgres-js 3.4.x hands a jsonb column back to a raw client as
    // the JSON *text*, which production normalizes at each read site via
    // beekeeper-gen0-runner's `asObj`/JSON.parse; so a bare `typeof === 'object'`
    // on the raw read tests client auto-parsing, not storage.)
    const cols = await sql<Array<{ column_name: string; data_type: string }>>`
      SELECT column_name, data_type
        FROM information_schema.columns
       WHERE table_name = 'iq_battery_cases'
         AND column_name IN ('ground_truth', 'rubric')
    `;
    const colType = new Map(cols.map((c) => [c.column_name, c.data_type]));
    expect(colType.get('ground_truth')).toBe('jsonb');
    expect(colType.get('rubric')).toBe('jsonb');

    const cases = await sql<Array<{ ground_truth: unknown; rubric: unknown }>>`
      SELECT ground_truth, rubric FROM iq_battery_cases ORDER BY id LIMIT 1
    `;
    expect(cases[0]).toBeDefined();
    // Normalize exactly as production does (asObj): jsonb arrives as JSON text here.
    const parseJsonb = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
    const groundTruth = parseJsonb(cases[0].ground_truth) as Record<string, unknown>;
    const rubric = parseJsonb(cases[0].rubric) as Record<string, unknown>;
    expect(typeof groundTruth).toBe('object');
    expect(Object.keys(groundTruth).length).toBeGreaterThan(0);
    expect(typeof rubric).toBe('object');
    expect(Array.isArray(rubric.dimensions)).toBe(true);
  });

  it('sets rotation_index correctly for each variant', async () => {
    await seedCorpus(sql);

    const indices = await sql<Array<{ variant: string; rotation_index: number; count: number }>>`
      SELECT variant, rotation_index, COUNT(*) as count
      FROM iq_battery_cases
      GROUP BY variant, rotation_index
      ORDER BY variant, rotation_index
    `;

    const variantGroups = new Map<string, number[]>();
    for (const row of indices) {
      if (!variantGroups.has(row.variant)) {
        variantGroups.set(row.variant, []);
      }
      variantGroups.get(row.variant)!.push(row.rotation_index);
    }

    for (const [variant, indices] of variantGroups) {
      const sorted = [...indices].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; i++) {
        expect(sorted[i]).toBe(i);
      }
    }
  });
});
