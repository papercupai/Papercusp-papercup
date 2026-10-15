/**
 * work_items.closed_ts — REAL-PG guard for migration 698 (EI-18820653360383242).
 *
 * WHY REAL PG, NOT A UNIT TEST. The entire behaviour under test lives in a
 * BEFORE trigger. A mocked state-writer proves the writer was ASKED to close an
 * item; it cannot prove Postgres kept a close time, froze it, or cleared it.
 * That distinction is not theoretical here — migration 677 added `authority` and
 * the issue family silently could not record one, green unit tests throughout,
 * because they mocked the writer. 679 had to repair it, and its header says so
 * explicitly. So every assertion below reads back from the base table.
 *
 * WHAT IT PINS
 *   1. the state-machine semantics (stamp on the boundary crossing, freeze on a
 *      terminal->terminal re-close, clear on reopen, re-stamp on re-close);
 *   2. THE NEGATIVE CONTROL — an unrelated write moves updated_ts and does NOT
 *      move closed_ts. This is the whole point of the column: a test that only
 *      asserts "is it set?" passes just as happily against a closed_ts that
 *      drifts, which would be strictly worse than the updated_ts proxy it
 *      replaced;
 *   3. federation honesty — a close time is never INVENTED on insert, and a
 *      supplied origin time wins over local now();
 *   4. the invariant closed_ts IS NOT NULL => status is terminal;
 *   5. both family views expose the column;
 *   6. a bidirectional DRIFT GUARD between the SQL terminal-status set and the
 *      TypeScript one. That guard is not ceremony: this repo has already had a
 *      hand-copied terminal set go stale and score ~88% of finished units as
 *      failed placements (see ANY_FAMILY_TERMINAL_STATES' header).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createFreshPgDb,
  applyMigrationsForTest,
  type FreshPgDb,
  type KnownInapplicableMigration,
} from '../test/_pg-helpers';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';

/**
 * WI-35535 — later migrations the stale-migration-list audit (EI-18808675015292160)
 * correctly finds post-date 698 and touch ONLY `work_items`, but each is
 * structurally inapplicable to THIS fixture's deliberately-minimal DDL (see the
 * BASE_DDL comment below): they depend on columns (`payload`, `harness_slug`)
 * this fixture never builds, or replace a view with an incompatible column set.
 * Turning this fixture into a near-full schema replica to satisfy them would
 * defeat its stated design. Acknowledged here, per file, with why — see
 * `KnownInapplicableMigration` in _pg-helpers.ts for what this does and does
 * not suppress (every OTHER later migration is still audited).
 */
const KNOWN_INAPPLICABLE: KnownInapplicableMigration[] = [
  {
    file: '721-work-items-lane-generated-column.sql',
    reason:
      "ADD COLUMN lane GENERATED ALWAYS AS (payload ->> 'lane') and a CREATE OR REPLACE VIEW " +
      'engineer_issues with a full-width column set both depend on `payload`, which this ' +
      'fixture does not build (Postgres also refuses CREATE OR REPLACE VIEW when the column ' +
      'set changes, which this migration structurally does against the minimal view here).',
  },
  {
    file: '725-payload-object-shape-guard-and-plan-item-stamp-index.sql',
    reason:
      'The CHECK constraint and the partial expression index both reference `payload`, which ' +
      'this fixture does not build.',
  },
  {
    file: '741-work-items-condition-key-singleton.sql',
    reason:
      'The new condition_key column and its unique index are scoped by `harness_slug`, which ' +
      'this fixture does not build.',
  },
  {
    file: '1110-work-items-admission-flags-generated-columns.sql',
    reason:
      'This deliberately minimal fixture has no payload column, but 1110 derives generated ' +
      'columns from payload and verifies them. The canonical live-shape fixture covers it.',
  },
  {
    file: '1294-work-item-readiness-payload-projections.sql',
    reason:
      'This deliberately minimal fixture has no payload column, but 1294 derives STORED ' +
      'readiness projections from payload. The canonical live-shape fixture covers it.',
  },
  {
    file: '1308-work-items-severity-projection.sql',
    reason:
      'This deliberately minimal fixture has no payload column, but 1308 derives a STORED ' +
      'severity_projection from payload and verifies it against payload. The canonical ' +
      'live-shape fixture covers it.',
  },
];

const WS = 'ws-closed-ts';

/**
 * A minimal `work_items` carrying only what 698 touches, plus the two family
 * views in the shape the live ones have (the migration anchors on the deparsed
 * `FROM harness_shared.work_items` that pg_get_viewdef emits, so building them
 * as real views — rather than asserting against a hand-written string — is what
 * makes this a genuine test of the surgery).
 */
const BASE_DDL = `
  CREATE TABLE harness_shared.work_items (
    workspace_id            text   NOT NULL,
    feature_id              text   NOT NULL,
    item_kind               text   NOT NULL,
    status                  text   NOT NULL,
    title                   text,
    created_ts              bigint,
    updated_ts              bigint,
    terminal_owner          text,
    terminal_completion_ref text,
    authority               text,
    admission text, admitted_at timestamptz, admitted_by text,
    PRIMARY KEY (workspace_id, feature_id)
  );

  CREATE VIEW harness_shared.engineer_issues AS
    SELECT feature_id AS issue_id,
           workspace_id,
           item_kind AS kind,
           title,
           status AS state,
           terminal_owner,
           terminal_completion_ref,
           authority
      FROM harness_shared.work_items
     WHERE (item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text]));

  CREATE VIEW harness_shared.harness_features_consolidated AS
    SELECT feature_id,
           workspace_id,
           item_kind,
           title,
           status,
           terminal_owner,
           terminal_completion_ref,
           authority
      FROM harness_shared.work_items
     WHERE (item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text]));
`;

describe('work_items.closed_ts (migration 698)', () => {
  let db: FreshPgDb;
  let sql: FreshPgDb['sql'];

  beforeAll(async () => {
    db = await createFreshPgDb('closedts');
    sql = db.sql;
    await sql.unsafe(BASE_DDL);
    await applyMigrationsForTest(sql, [
      '698-work-items-closed-ts.sql',
      '777-work-items-embedding-recipe-discriminator.sql',
      '1135-work-items-epoch-ms-timestamp-guard.sql',
      '1194-work-items-directive-ref.sql',
    ], {
      label: 'work-items-closed-ts',
      knownInapplicable: KNOWN_INAPPLICABLE,
    });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  /** Insert a fresh item and return its id. */
  async function seed(id: string, status = 'open', kind = 'bug', closedTs: number | null = null) {
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, feature_id, item_kind, status, title, created_ts, updated_ts, closed_ts)
      VALUES (${WS}, ${id}, ${kind}, ${status}, ${'t-' + id}, ${Date.now()}, ${Date.now()}, ${closedTs})`;
    return id;
  }

  async function read(id: string) {
    const [row] = await sql<{ status: string; closed_ts: number | null; updated_ts: number | null }[]>`
      SELECT status, closed_ts, updated_ts
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    return row;
  }

  it('leaves closed_ts NULL on a freshly-created non-terminal item', async () => {
    await seed('wi-1');
    expect((await read('wi-1')).closed_ts).toBeNull();
  });

  it('stamps closed_ts on the non-terminal -> terminal crossing', async () => {
    await seed('wi-2');
    const before = Date.now();
    await sql`UPDATE harness_shared.work_items SET status = 'done'
               WHERE workspace_id = ${WS} AND feature_id = 'wi-2'`;
    const row = await read('wi-2');
    expect(row.closed_ts).not.toBeNull();
    // Within a sane window of the write, i.e. it is a real close time and not a
    // copy of created_ts or a zero.
    expect(row.closed_ts!).toBeGreaterThanOrEqual(before - 1000);
    expect(row.closed_ts!).toBeLessThanOrEqual(Date.now() + 1000);
  });

  // ---------------------------------------------------------------------------
  // THE NEGATIVE CONTROL. Without this assertion the whole change is unverified:
  // a closed_ts that moves on every write is exactly the updated_ts proxy that
  // produced the phantom "3,833 items closed in one hour" reading, only now
  // wearing a name nobody would think to distrust.
  // ---------------------------------------------------------------------------
  it('does NOT move closed_ts on an unrelated write, while updated_ts does move', async () => {
    await seed('wi-3');
    await sql`UPDATE harness_shared.work_items SET status = 'done'
               WHERE workspace_id = ${WS} AND feature_id = 'wi-3'`;
    const closedAt = (await read('wi-3')).closed_ts;
    expect(closedAt).not.toBeNull();

    // A retag / payload merge / bulk sweep — anything that is not a state change.
    const bumped = Date.now() + 60_000;
    await sql`UPDATE harness_shared.work_items
                 SET title = 'retagged', updated_ts = ${bumped}
               WHERE workspace_id = ${WS} AND feature_id = 'wi-3'`;

    const after = await read('wi-3');
    expect(after.closed_ts).toBe(closedAt); // frozen
    expect(after.updated_ts).toBe(bumped); // and the proxy demonstrably moved
  });

  it('freezes closed_ts across a terminal -> terminal re-close, even one that writes the column', async () => {
    await seed('wi-4');
    await sql`UPDATE harness_shared.work_items SET status = 'done'
               WHERE workspace_id = ${WS} AND feature_id = 'wi-4'`;
    const first = (await read('wi-4')).closed_ts;

    // A reconciler re-closing an already-terminal row, explicitly trying to set
    // the column. This is the mass-write shape that corrupted the old reading;
    // the caller does not get to win.
    await sql`UPDATE harness_shared.work_items
                 SET status = 'resolved', closed_ts = ${Date.now() + 900_000}
               WHERE workspace_id = ${WS} AND feature_id = 'wi-4'`;

    const after = await read('wi-4');
    expect(after.status).toBe('resolved');
    expect(after.closed_ts).toBe(first);
  });

  it('clears closed_ts on a genuine reopen, and re-stamps a later re-close', async () => {
    await seed('wi-5');
    await sql`UPDATE harness_shared.work_items SET status = 'done'
               WHERE workspace_id = ${WS} AND feature_id = 'wi-5'`;
    const first = (await read('wi-5')).closed_ts;
    expect(first).not.toBeNull();

    await sql`UPDATE harness_shared.work_items SET status = 'open'
               WHERE workspace_id = ${WS} AND feature_id = 'wi-5'`;
    // A reopened item is not closed, so it must stop counting as closed.
    expect((await read('wi-5')).closed_ts).toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    await sql`UPDATE harness_shared.work_items SET status = 'dropped'
               WHERE workspace_id = ${WS} AND feature_id = 'wi-5'`;
    const second = (await read('wi-5')).closed_ts;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('never INVENTS a close time for a row that arrives already-terminal', async () => {
    // A federated replica / restore. Stamping now() here would record ARRIVAL
    // time as close time — the precise wrong-timestamp class 698 exists to end.
    await seed('wi-6', 'done');
    expect((await read('wi-6')).closed_ts).toBeNull();
  });

  it('honours a supplied origin close time, on insert and on the first close', async () => {
    const origin = Date.now() - 86_400_000; // a day ago, i.e. clearly not now()

    await seed('wi-7', 'done', 'bug', origin);
    expect((await read('wi-7')).closed_ts).toBe(origin);

    await seed('wi-8');
    await sql`UPDATE harness_shared.work_items SET status = 'done', closed_ts = ${origin}
               WHERE workspace_id = ${WS} AND feature_id = 'wi-8'`;
    expect((await read('wi-8')).closed_ts).toBe(origin);
  });

  it('upholds the invariant: a non-terminal row can never carry a closed_ts', async () => {
    await seed('wi-9', 'open', 'bug', Date.now());
    expect((await read('wi-9')).closed_ts).toBeNull();

    await sql`UPDATE harness_shared.work_items SET closed_ts = ${Date.now()}
               WHERE workspace_id = ${WS} AND feature_id = 'wi-9'`;
    expect((await read('wi-9')).closed_ts).toBeNull();
  });

  it('exposes closed_ts on BOTH family views, reading through to the base row', async () => {
    await seed('wi-10', 'open', 'bug');
    await seed('wi-11', 'open', 'feature');
    await sql`UPDATE harness_shared.work_items SET status = 'done'
               WHERE workspace_id = ${WS} AND feature_id IN ('wi-10','wi-11')`;

    const [issue] = await sql<{ closed_ts: number | null }[]>`
      SELECT closed_ts FROM harness_shared.engineer_issues
       WHERE workspace_id = ${WS} AND issue_id = 'wi-10'`;
    const [feat] = await sql<{ closed_ts: number | null }[]>`
      SELECT closed_ts FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${WS} AND feature_id = 'wi-11'`;

    expect(issue.closed_ts).toBe((await read('wi-10')).closed_ts);
    expect(feat.closed_ts).toBe((await read('wi-11')).closed_ts);
    expect(issue.closed_ts).not.toBeNull();
  });

  it('is idempotent — re-applying 698 changes nothing and does not double-append', async () => {
    await applyMigrationsForTest(sql, [
      '698-work-items-closed-ts.sql',
      '777-work-items-embedding-recipe-discriminator.sql',
      '1135-work-items-epoch-ms-timestamp-guard.sql',
      '1194-work-items-directive-ref.sql',
    ], {
      label: 're-apply',
      knownInapplicable: KNOWN_INAPPLICABLE,
    });

    for (const view of ['engineer_issues', 'harness_features_consolidated']) {
      const [{ n }] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM information_schema.columns
         WHERE table_schema = 'harness_shared' AND table_name = ${view} AND column_name = 'closed_ts'`;
      expect(n).toBe(1);
    }
  });

  // ---------------------------------------------------------------------------
  // The drift guard. Bidirectional set equality, not a spot-check: a spot-check
  // catches a state SQL forgot but not one SQL invented, and either direction
  // silently mis-buckets rows.
  // ---------------------------------------------------------------------------
  it('keeps the SQL terminal-status set identical to the TypeScript one', async () => {
    const [{ def }] = await sql<{ def: string }[]>`
      SELECT pg_get_functiondef(p.oid) AS def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'harness_shared' AND p.proname = 'work_item_status_is_terminal'`;

    const literals = [...def.matchAll(/'([a-z_]+)'::text|'([a-z_]+)'/g)]
      .map((m) => m[1] ?? m[2])
      .filter((s) => s !== 'text');
    expect(new Set(literals)).toEqual(new Set(ANY_FAMILY_TERMINAL_STATES));

    // And the installed function actually behaves that way for every state, so
    // the guard cannot pass on a definition that merely mentions the words.
    for (const s of [...ANY_FAMILY_TERMINAL_STATES, 'open', 'todo', 'wip', 'blocked', 'needs-human']) {
      const [{ t }] = await sql<{ t: boolean }[]>`
        SELECT harness_shared.work_item_status_is_terminal(${s}) AS t`;
      expect(t, `status '${s}'`).toBe(ANY_FAMILY_TERMINAL_STATES.includes(s));
    }
  });
});
