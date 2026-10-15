/**
 * portfolio-act-predicate.integration.test — `portfolioActLedgerPredicate`
 * EXECUTED against a real Postgres (WI-2142888).
 *
 * ── WHY THIS FILE EXISTS, AND WHY THE UNIT TEST IS NOT ENOUGH ───────────────
 *
 * `portfolio-acts.test.ts` pins the predicate by rendering it through a recording
 * sql tag and asserting on the SQL TEXT. That is the right pin for "are both legs
 * present, with the right parameters" — and it is structurally unable to catch a
 * predicate that is well-formed and returns the WRONG ROWS.
 *
 * It missed exactly that, once, in the direction the module most cares about.
 * The `default-act` polarity was first written with a plain `=` on its valued
 * clause:
 *
 *     NOT ( (args_json -> 'lane') = to_jsonb('observation') OR … )
 *
 * `->` yields SQL NULL for an ABSENT key, so for the commonest real act — a
 * capture with no `lane` at all — that reads `NOT (NULL OR false)` → NULL, and
 * the row is not counted. The rendered text looked perfect and the unit test
 * passed. Executed against the live ledger, the motivating 80-minute window
 * scored 0 acts where the steward had filed 5: the exact false-IDLE bug the
 * entry was added to fix, reintroduced one layer down.
 *
 * Three-valued logic is not visible in SQL text. It is only visible in rows.
 * Every case below is therefore a ROW COUNT, and the absent-key row is the
 * control that fails on the `=` spelling and passes on `IS NOT DISTINCT FROM`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

import { portfolioActLedgerPredicate } from './portfolio-throughput';

let sql: postgres.Sql;
let dbName: string;
let adminUri: string;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `portfolioact_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 2, onnotice: () => {} });

  // Only the two columns the predicate reads. A narrow fixture on purpose: the
  // subject here is the predicate's LOGIC, not the ledger's schema.
  await sql.unsafe(`
    CREATE TABLE tool_invocations (
      id bigserial PRIMARY KEY,
      label text NOT NULL,
      tool_name text,
      args_json jsonb
    )`);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}, 120_000);

/** Labels of the rows the predicate selects — an order-independent set. */
async function selectedLabels(): Promise<string[]> {
  const rows = await sql<{ label: string }[]>`
    SELECT ti.label FROM tool_invocations ti
     WHERE ${portfolioActLedgerPredicate(sql)}
     ORDER BY ti.label`;
  return rows.map((r) => r.label);
}

describe('portfolioActLedgerPredicate executed against real Postgres', () => {
  beforeAll(async () => {
    await sql`DELETE FROM tool_invocations`;
    await sql`
      INSERT INTO tool_invocations ${sql(
        [
          // ── default-act: improvements:capture ──────────────────────────────
          /**
           * ⚠ THE CONTROL. No `lane` key at all — the DEFAULT filing, and the
           * single most common real act. This row is what a plain `=` on the
           * valued clause silently drops, and it is the whole reason this file
           * executes rather than inspects.
           */
          { label: 'capture-absent-lane', tool_name: 'improvements:capture', args_json: { title: 't' } },
          // Explicit non-observation lane: the schema's own default, spelled out.
          {
            label: 'capture-explicit-improvement',
            tool_name: 'improvements:capture',
            args_json: { title: 't', lane: 'improvement' },
          },
          // A falsy probe flag still means "really file it".
          {
            label: 'capture-probe-false',
            tool_name: 'improvements:capture',
            args_json: { title: 't', checkDuplicatesOnly: false },
          },
          // Opted out: a turn-end reflection.
          {
            label: 'x-capture-observation',
            tool_name: 'improvements:capture',
            args_json: { title: 't', lane: 'observation' },
          },
          // Opted out: a dedup PROBE creates nothing, and a read is never an act.
          {
            label: 'x-capture-probe-true',
            tool_name: 'improvements:capture',
            args_json: { title: 't', checkDuplicatesOnly: true },
          },
          // Both clauses at once — OR-ed, so still excluded exactly once.
          {
            label: 'x-capture-both-optouts',
            tool_name: 'improvements:capture',
            args_json: { title: 't', lane: 'observation', checkDuplicatesOnly: true },
          },
          /**
           * ⚠ THE CONSERVATIVE FLOOR, in SQL. args_json NULL and a scalar
           * args_json both have no keys, so no opt-out clause can hold — without
           * the `jsonb_typeof(...) = 'object'` guard these count as acts, which
           * is the false-BUSY direction that lets a reading-and-reporting
           * steward pass.
           */
          { label: 'x-capture-null-args', tool_name: 'improvements:capture', args_json: null },
          {
            label: 'x-capture-scalar-args',
            tool_name: 'improvements:capture',
            args_json: JSON.stringify('observation'),
          },

          // ── key-present: work_items:update (unchanged polarity) ────────────
          {
            label: 'update-goal',
            tool_name: 'work_items:update',
            args_json: { id: 'WI-1', goal: 'g' },
          },
          // A deliberate clear is a release, and releasing changes who is on it.
          {
            label: 'update-goal-null',
            tool_name: 'work_items:update',
            args_json: { id: 'WI-1', goal: null },
          },
          {
            label: 'update-batch-goal',
            tool_name: 'work_items:update',
            args_json: { items: [{ id: 'WI-1', title: 't' }, { id: 'WI-2', goal: 'g' }] },
          },
          {
            label: 'x-update-retitle',
            tool_name: 'work_items:update',
            args_json: { id: 'WI-1', title: 'retitled' },
          },
          // The batch leg's jsonb_typeof guard keeps jsonb_array_elements off a
          // scalar, which would raise and make the whole read ledger-unreadable.
          {
            label: 'x-update-scalar-items',
            tool_name: 'work_items:update',
            args_json: { items: 'WI-1' },
          },

          // ── by NAME, and a plain non-act ───────────────────────────────────
          { label: 'create-by-name', tool_name: 'work_items:create', args_json: { title: 't' } },
          { label: 'x-read', tool_name: 'dev:pg_query', args_json: { sql: 'select 1' } },
        ],
        'label',
        'tool_name',
        'args_json',
      )}`;
  }, 60_000);

  /**
   * Every label prefixed `x-` must be excluded and every other label included,
   * so a single assertion covers both directions and a new fixture row cannot be
   * added without deciding which side it is on.
   */
  it('selects exactly the acts — absent keys included, opt-outs and reads excluded', async () => {
    const selected = await selectedLabels();
    expect(selected).toEqual([
      'capture-absent-lane',
      'capture-explicit-improvement',
      'capture-probe-false',
      'create-by-name',
      'update-batch-goal',
      'update-goal',
      'update-goal-null',
    ]);
  });

  /**
   * The regression stated as its own case, because it is the one that shipped.
   * A NULL verdict is not the same as a FALSE one: `WHERE` treats both as "skip
   * the row", so a NULL is invisible in the result and in any count taken from
   * it — which is precisely how the bug read as "this steward did nothing"
   * rather than as an error anyone would investigate.
   *
   * ⚠ SCOPED TO OBJECT args_json, deliberately, and this is a real bound rather
   * than a convenience. `jsonb_typeof(NULL)` is itself NULL, so a row with NULL
   * or scalar args CANNOT produce a strict boolean — and must not: that is the
   * conservative floor, where NULL and FALSE agree on excluding the row and the
   * exclusion is the answer we want. The invariant worth pinning is that a
   * WELL-FORMED row always gets a decisive verdict, because that is the only
   * population where a NULL silently loses a real act. With the `=` spelling the
   * absent-lane control lands in exactly this scope and returns NULL, so this
   * case fails on the regression and passes on the fix.
   */
  it('never returns a NULL verdict for well-formed args — a NULL silently loses an act', async () => {
    const [row] = await sql<{ nulls: string }[]>`
      SELECT count(*) AS nulls FROM tool_invocations ti
       WHERE jsonb_typeof(ti.args_json) = 'object'
         AND (${portfolioActLedgerPredicate(sql)}) IS NULL`;
    expect(Number(row!.nulls)).toBe(0);
  });

  /**
   * ── THE NEGATIVE CONTROL ────────────────────────────────────────────────────
   *
   * A guard that has never failed is a guard nobody has tested, and the two cases
   * above would BOTH pass against a fixture that simply had no absent-key row.
   * So the wrong spelling is kept here permanently, executed side by side with
   * the real one against the same rows — the module-level control pattern, and
   * the one shape of falsifiability proof that never mutates the shared tree.
   *
   * This is the ACTUAL first implementation, not an invented straw man: a plain
   * `=` on the valued clause. It must (a) still be a well-formed query, (b)
   * return NULL rather than TRUE for the absent-key row, and (c) therefore select
   * strictly fewer acts than the real predicate. If a future edit makes the two
   * agree, the real one has regressed to the broken semantics.
   */
  it('the `=` spelling it replaced still returns NULL here — the guard is falsifiable', async () => {
    const [row] = await sql<{ verdict: boolean | null }[]>`
      SELECT (NOT (((ti.args_json -> 'lane') = to_jsonb('observation'::text))
                OR ((ti.args_json -> 'checkDuplicatesOnly') IS NOT NULL
                    AND (ti.args_json -> 'checkDuplicatesOnly')
                        NOT IN ('false'::jsonb,'null'::jsonb,'0'::jsonb,'""'::jsonb)))) AS verdict
        FROM tool_invocations ti WHERE ti.label = 'capture-absent-lane'`;
    // The bug, reproduced: a real act whose verdict is neither true nor false.
    expect(row!.verdict).toBeNull();

    // And the fix, on the same row, decisively true.
    const [fixed] = await sql<{ verdict: boolean | null }[]>`
      SELECT (${portfolioActLedgerPredicate(sql)}) AS verdict
        FROM tool_invocations ti WHERE ti.label = 'capture-absent-lane'`;
    expect(fixed!.verdict).toBe(true);
  });
});
