/**
 * acceptance-grading-authority.integration.test.ts — `readGraderSelectionVia`
 * against a REAL Postgres. P-007 of
 * unified-responder-selection-critique-and-grading-2026-08-30.
 *
 * WHY THIS FILE EXISTS, IN D-007'S OWN WORDS. D-007 measured the read against
 * live `papercusp-workspace` PG and found it well-formed — but also found that
 * `routing->'cascade'->>'flavor' = 'acceptance-grading'` matched ZERO rows,
 * because P-003 had landed hours earlier and no grading cascade had yet been
 * dispatched. Its closing instruction: *"the read is proven well-formed and
 * proven to read the right keys, but has NEVER YET MATCHED A LIVE GRADING ROW.
 * P-007 should assert that first real cascade rather than assume it."* Re-measured
 * 2026-08-30T23:55Z, still 0 of 344 rows (positive control passed, so a genuine
 * zero rather than a broken instrument). Production cannot supply the row, so
 * this file constructs it against the real schema instead of waiting for one.
 *
 * WHAT ONLY A REAL-PG TEST CAN PROVE HERE — and it is the whole point, because
 * D-007 says so explicitly: *"A FAIL-SOFT READ MAKES A MALFORMED QUERY INVISIBLE
 * and unit tests cannot catch that."* The sibling unit tests
 * (`acceptance-grading-authority.test.ts`) hand `readGraderSelectionVia` a fake
 * `sql` tag, so they assert the SHAPE of the query text and the folding of rows
 * that the test itself supplied. A column rename, a jsonb path typo, or a
 * predicate that silently matches nothing all survive them and then degrade —
 * via the deliberate `catch { return new Map() }` — into "every card ranks as
 * floor", i.e. the pre-P-004 latest-wins the gate was built to replace, *with
 * nothing red anywhere*. Only a real round-trip through the migration-owned
 * table can falsify that.
 *
 * The table is created by applying the REAL migration (834-consult-threads.sql,
 * readFileSync) — never a hand-mirrored CREATE that silently falls behind the
 * schema. Same idiom, and same reason, as get-feedback-core.integration.test.ts.
 *
 * CONTROLS. Per D-007/D-008's standing discipline ("every rule needs its in-test
 * CONTROL PAIR — the identical fixture with the pair made UNRELATED must select
 * both, or the guard is untested rather than passing"), every predicate below is
 * asserted against a near-identical row that must NOT match. A test that only
 * ever inserts matching rows cannot tell a working predicate from `WHERE true`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-grading-authority';
const OTHER_WS = 'ws-somebody-else';
const RUBRIC = 'acceptance-rubric-under-test';
const OTHER_RUBRIC = 'some-other-rubric';

const MIGRATION_834 = fileURLToPath(
  new URL('../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url),
);

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

// Imported AFTER the mock so the module binds the test pool.
const { readGraderSelectionVia, graderSelectionVia, GRADING_CASCADE_AUTHORITY_LOOKBACK_ROWS } = await import(
  './acceptance-grading-authority'
);
const { GRADING_CASCADE_FLAVOR } = await import('./consult/grading-cascade');

let rootSql: Sql;

/** The persisted routing snapshot of a grading cascade, exactly as the cascade writes it. */
const gradingRouting = (
  selected: Array<{ ownerId: string; via: 'floor' | 'minimum' }>,
  opts: { flavor?: string; rubricId?: string } = {},
) => ({
  cascade: { flavor: opts.flavor ?? GRADING_CASCADE_FLAVOR, rubricId: opts.rubricId ?? RUBRIC },
  selection: { selected },
});

let seq = 0;
/** Insert one consult_state row. `createdAt` drives the LIMIT-8 recency window. */
async function insertCascade(opts: {
  routing: unknown;
  workspaceId?: string;
  createdAt?: string;
  closedAt?: string | null;
}): Promise<string> {
  const conversationId = `conv-grading-${(seq += 1).toString().padStart(4, '0')}`;
  await rootSql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, state, routing, created_at, closed_at)
    VALUES (
      ${opts.workspaceId ?? WS},
      ${conversationId},
      ${'su-requester'},
      ${'closed_answered'},
      ${rootSql.json(opts.routing as never)},
      ${opts.createdAt ?? '2026-08-30T12:00:00Z'},
      ${opts.closedAt ?? null}
    )`;
  return conversationId;
}

/** Every test owns the table; wiping between cases keeps the recency window honest. */
async function truncate(): Promise<void> {
  await rootSql`DELETE FROM harness_shared.consult_state`;
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `gradeauth_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  h.sql = rootSql;
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  // Minimal landing pad for the migration's coord_conversations kind-CHECK
  // widening (the real table is migration-132-owned; only `kind` matters here).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_conversations (
      id text PRIMARY KEY,
      kind text NOT NULL DEFAULT 'question'
    )`);
  // The REAL migration — consult_state cannot drift from what the gate reads.
  await rootSql.unsafe(readFileSync(MIGRATION_834, 'utf8'));
}, 120_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('readGraderSelectionVia against real Postgres — the live grading cascade D-007 deferred to P-007', () => {
  it('MATCHES a real acceptance-grading cascade row and folds its selection block', async () => {
    // The assertion D-007 explicitly deferred: production has never produced this
    // row, so the query has never been proven to match one. It is proven here.
    await truncate();
    await insertCascade({
      routing: gradingRouting([
        { ownerId: 'su-grader-1', via: 'floor' },
        { ownerId: 'su-grader-2', via: 'minimum' },
      ]),
    });

    const via = await readGraderSelectionVia(WS, RUBRIC);

    expect(via.get('su-grader-1')).toBe('floor');
    expect(via.get('su-grader-2')).toBe('minimum');
    expect(via.size).toBe(2);
  });

  it('CONTROL: the identical row under a NON-grading flavor is not read', async () => {
    // Without this, the flavor predicate could be dropped entirely and the test
    // above would still pass — it would just read every cascade in the table.
    await truncate();
    await insertCascade({
      routing: gradingRouting([{ ownerId: 'su-grader-1', via: 'floor' }], { flavor: 'critique' }),
    });

    expect(await readGraderSelectionVia(WS, RUBRIC)).toEqual(new Map());
  });

  it('CONTROL: the identical row under a DIFFERENT rubric is not read', async () => {
    // The rubricId predicate carries the same risk as the flavor one, and a
    // cross-rubric leak is worse than a miss: it would import another plan's
    // grader provenance into this plan's ship decision.
    await truncate();
    await insertCascade({
      routing: gradingRouting([{ ownerId: 'su-grader-1', via: 'floor' }], { rubricId: OTHER_RUBRIC }),
    });

    expect(await readGraderSelectionVia(WS, RUBRIC)).toEqual(new Map());
  });

  it('CONTROL: another workspace’s identical cascade does not leak in', async () => {
    await truncate();
    await insertCascade({
      routing: gradingRouting([{ ownerId: 'su-other-ws-grader', via: 'minimum' }]),
      workspaceId: OTHER_WS,
    });

    expect(await readGraderSelectionVia(WS, RUBRIC)).toEqual(new Map());
  });

  it('reads a CLOSED cascade — the no-closed_at rule, proved behaviourally rather than by query text', async () => {
    // The unit test asserts the query STRING does not contain 'closed_at'. That
    // is a spelling check: it survives any rewrite that filters closed rows by
    // another route, and D-007 warns this exact failure would present as the gate
    // silently reverting to pre-P-004 latest-wins with nothing red. By gate time
    // the cascade has USUALLY closed, so a liveness predicate here would empty the
    // map in the common case. This asserts the behaviour against a real closed row.
    await truncate();
    await insertCascade({
      routing: gradingRouting([{ ownerId: 'su-grader-1', via: 'floor' }]),
      closedAt: '2026-08-30T13:00:00Z',
    });

    const via = await readGraderSelectionVia(WS, RUBRIC);

    expect(via.get('su-grader-1')).toBe('floor');
  });

  it('resolves a grader appearing in two real rounds UPWARD — floor beats minimum regardless of row order', async () => {
    // Round 1 fills the grader below the floor; a later round qualifies them.
    // Proves the fold survives a real jsonb round-trip across multiple rows,
    // not just the hand-built arrays the unit tests pass in.
    await truncate();
    await insertCascade({
      routing: gradingRouting([{ ownerId: 'su-grader-1', via: 'minimum' }]),
      createdAt: '2026-08-30T10:00:00Z',
    });
    await insertCascade({
      routing: gradingRouting([{ ownerId: 'su-grader-1', via: 'floor' }]),
      createdAt: '2026-08-30T11:00:00Z',
    });

    expect((await readGraderSelectionVia(WS, RUBRIC)).get('su-grader-1')).toBe('floor');
  });

  it('bounds the lookback to the newest rounds — an older round beyond the window is not read', async () => {
    // The LIMIT exists so a rubric with a long cascade history does not scan every
    // round it ever had. Asserted against real ORDER BY created_at DESC rather
    // than a fake tag that ignores the clause entirely.
    await truncate();
    const rounds = GRADING_CASCADE_AUTHORITY_LOOKBACK_ROWS + 2;
    for (let i = 0; i < rounds; i += 1) {
      // i=0 is the OLDEST; the newest LOOKBACK rows are the ones that must survive.
      const hour = String(i).padStart(2, '0');
      await insertCascade({
        routing: gradingRouting([{ ownerId: `su-round-${i}`, via: 'floor' }]),
        createdAt: `2026-08-30T${hour}:00:00Z`,
      });
    }

    const via = await readGraderSelectionVia(WS, RUBRIC);

    expect(via.size).toBe(GRADING_CASCADE_AUTHORITY_LOOKBACK_ROWS);
    // The newest round is in; the two oldest fell outside the window.
    expect(via.has(`su-round-${rounds - 1}`)).toBe(true);
    expect(via.has('su-round-0')).toBe(false);
    expect(via.has('su-round-1')).toBe(false);
  });

  it('ignores a malformed selection entry without discarding its well-formed siblings', async () => {
    // Real rows are written by code that can change. A row carrying an
    // unrecognised `via`, or an entry missing ownerId, must not take the whole
    // round's provenance down with it — that would silently demote every other
    // grader in the same cascade to unknown.
    await truncate();
    await insertCascade({
      routing: {
        cascade: { flavor: GRADING_CASCADE_FLAVOR, rubricId: RUBRIC },
        selection: {
          selected: [
            { ownerId: 'su-good', via: 'floor' },
            { ownerId: 'su-unknown-label', via: 'teleported' },
            { via: 'floor' },
            null,
          ],
        },
      },
    });

    const via = await readGraderSelectionVia(WS, RUBRIC);

    expect(via.get('su-good')).toBe('floor');
    expect(via.has('su-unknown-label')).toBe(false);
    expect(via.size).toBe(1);
  });
});

/**
 * FALSIFIABILITY — permanent in-test controls, no tree mutation.
 *
 * A guard that has never failed is a guard nobody has tested. The repo's
 * mutation-probe table prescribes, for "a MODULE / logic you import", keeping a
 * deliberately-wrong implementation PERMANENTLY in the test file rather than
 * mutating production code: this checkout is swept and committed by git-sync on a
 * schedule, so a file held mutated for the duration of a run can be committed even
 * when nothing goes wrong and no handler fails — a `trap` does not close that
 * window. Same pattern, and same wording, as the sibling unit suite's
 * "CONTROL (falsifiability, in-test — no tree mutation)" cases.
 *
 * These run the DEFECTIVE variants of the real query against the SAME real
 * fixtures and assert they produce the WRONG answer. That is what converts the
 * assertions above from "they passed" into "they would have caught this" — and it
 * matters most here precisely because the read fails SOFT: every defect below
 * degrades to an empty map, which the gate reads as "every card ranks floor",
 * i.e. silent reversion to pre-P-004 latest-wins with nothing red anywhere.
 */
describe('CONTROLS (falsifiability, in-test — no tree mutation)', () => {
  it('the pre-P-004 liveness predicate WOULD empty the map on a closed cascade', async () => {
    // The defect D-007 names by name: copying `closed_at IS NULL` from the two
    // OTHER readers of these rows. By gate time the cascade has usually closed, so
    // this empties the map in exactly the common case. If the real query ever
    // acquires this predicate, the "reads a CLOSED cascade" case above goes red.
    await truncate();
    await insertCascade({
      routing: gradingRouting([{ ownerId: 'su-grader-1', via: 'floor' }]),
      closedAt: '2026-08-30T13:00:00Z',
    });

    const defective = (await rootSql`
      SELECT routing FROM harness_shared.consult_state
       WHERE workspace_id = ${WS}
         AND routing -> 'cascade' ->> 'flavor' = ${GRADING_CASCADE_FLAVOR}
         AND routing -> 'cascade' ->> 'rubricId' = ${RUBRIC}
         AND closed_at IS NULL
    `) as unknown as Array<{ routing: unknown }>;

    expect(graderSelectionVia(defective.map((r) => r.routing))).toEqual(new Map());
    // …while the real read, against this very row, does not.
    expect((await readGraderSelectionVia(WS, RUBRIC)).get('su-grader-1')).toBe('floor');
  });

  it('a wrong jsonb path WOULD silently match nothing on a real grading row', async () => {
    // A typo'd path is the defect a fake `sql` tag can never catch: the unit tests
    // supply rows directly, so the path is never exercised against real jsonb.
    // Here `selection` is looked up one level too high — the shape a plausible
    // refactor produces — and the fail-soft read turns it into a clean empty map.
    await truncate();
    await insertCascade({ routing: gradingRouting([{ ownerId: 'su-grader-1', via: 'floor' }]) });

    const defective = (await rootSql`
      SELECT routing FROM harness_shared.consult_state
       WHERE workspace_id = ${WS}
         AND routing ->> 'flavor' = ${GRADING_CASCADE_FLAVOR}
    `) as unknown as Array<{ routing: unknown }>;

    expect(defective).toHaveLength(0);
    expect((await readGraderSelectionVia(WS, RUBRIC)).size).toBe(1);
  });

  it('CALIBRATION: the fixtures and the folding instrument are themselves sound', async () => {
    // Guards the controls above from passing for the WRONG reason. If the INSERT
    // silently wrote nothing, or `graderSelectionVia` returned empty for every
    // input, both controls would "pass" while proving nothing at all. This pins
    // that the same instrument, on the same table, does return a non-empty fold.
    await truncate();
    await insertCascade({ routing: gradingRouting([{ ownerId: 'su-grader-1', via: 'floor' }]) });

    const rows = (await rootSql`
      SELECT routing FROM harness_shared.consult_state WHERE workspace_id = ${WS}
    `) as unknown as Array<{ routing: unknown }>;

    expect(rows).toHaveLength(1);
    expect(graderSelectionVia(rows.map((r) => r.routing)).get('su-grader-1')).toBe('floor');
  });
});
