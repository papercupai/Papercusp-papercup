/**
 * acceptance-grader-select.integration.test.ts — the grader-selection SQL against a
 * REAL Postgres schema. Plan `acceptance-grading-cascade-never-executes-2026-08-31`, P-005.
 *
 * WHY THIS FILE EXISTS. `computeGraderExclusions` queried a column that does not
 * exist — `assignee` on `harness_shared.work_items`. Postgres rejected the whole
 * UNION, so the function threw on EVERY call; `resolveAcceptanceGrader` caught it
 * and fell back with `freshReason:'discovery_error'`, and the acceptance-grading
 * cascade therefore never opened once: 0 of 349 `consult_state` rows carried
 * `routing->'cascade'->>'flavor'='acceptance-grading'` (plan D-001).
 *
 * The unit suite could not see it, and could never have seen it. Every unit test
 * drives this function through `fakeSql()`, a stub that returns canned rows and
 * never parses SQL — a mocked SQL tag cannot detect a non-existent column. That is
 * not a gap to patch with more unit tests; it is the reason this integration file
 * has to exist. The sibling `relevance-router.integration.test.ts` carries the same
 * scar from the same class (EI-20816404371786180: a hand-rolled fixture declared
 * `completion_authority`/`closed_at` to match the code rather than the schema, so
 * the suite stayed green while production died on a missing column).
 *
 * So this file takes its `work_items` shape from the SHARED, migration-audited
 * `HARNESS_FEATURES_CONSOLIDATED_DDL` rather than inventing one locally. A fixture
 * written to match the code proves only that the code matches itself.
 *
 * FALSIFIABILITY. `PRE_FIX_EXCLUSION_SQL` below is the pre-fix query, kept in the
 * tree permanently as a committed control and asserted to FAIL. It is the
 * repo's tier-1 pattern — a deliberately-wrong implementation living beside the
 * real one — so nothing in the shared tree is ever mutated to prove this guard can
 * fail. A guard that has never failed is not a guard.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { computeGraderExclusions } from './acceptance-grader-select';

const WS = 'ws-grader';
const OTHER_WS = 'ws-other';
const H = 'papercusp';
const PLAN = 'a-plan-under-grading';

let db: FreshPgDb;

/**
 * THE COMMITTED CONTROL (P-005). This is the exclusion query EXACTLY as it stood
 * before the fix, `assignee` branch included. It must FAIL against the real
 * schema. If this ever starts passing, either the base table grew an `assignee`
 * column or the fixture stopped being faithful — and in both cases the guard
 * below has quietly stopped being able to catch the defect it exists for.
 */
async function preFixExclusionQuery(sql: FreshPgDb['sql'], planSlug: string): Promise<unknown> {
  return sql`
    SELECT DISTINCT x.owner FROM (
      SELECT terminal_owner AS owner FROM harness_shared.work_items
       WHERE source_plan_slug = ${planSlug} AND terminal_owner IS NOT NULL
      UNION
      SELECT assignee FROM harness_shared.work_items
       WHERE source_plan_slug = ${planSlug} AND assignee IS NOT NULL
      UNION
      SELECT taken_by FROM harness_shared.work_items
       WHERE source_plan_slug = ${planSlug} AND taken_by IS NOT NULL
    ) x
    WHERE x.owner IS NOT NULL
  `;
}

async function seedWorkItem(
  id: string,
  opts: { takenBy?: string | null; terminalOwner?: string | null; planSlug?: string | null; ws?: string } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, terminal_owner,
       source_plan_slug, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'task', ${`title ${id}`}, 'open', ${opts.takenBy ?? null},
            ${opts.terminalOwner ?? null}, ${opts.planSlug === undefined ? PLAN : opts.planSlug},
            ${opts.ws ?? WS}, 0, 0)`;
}

async function seedConsult(
  conversationId: string,
  opts: {
    requester: string;
    responder?: string | null;
    state?: string;
    originTaskRef?: string;
    ws?: string;
    routing?: Record<string, unknown> | null;
  },
) {
  await db.sql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, origin_task_ref, routing)
    VALUES (${opts.ws ?? WS}, ${conversationId}, ${opts.requester}, ${opts.responder ?? null},
            ${opts.state ?? 'closed_answered'}, ${opts.originTaskRef ?? PLAN},
            ${opts.routing == null ? null : db.sql.json(opts.routing as never)})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('grader-select');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  // Only the columns computeGraderExclusions reads. ⚠ Verified against the live
  // relation before being written here (dev:pg_query describe
  // harness_shared.consult_state) — see the header on why a fixture written to
  // match the CODE rather than the SCHEMA is the exact bug this file guards.
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.consult_state (
      workspace_id text NOT NULL,
      conversation_id text NOT NULL,
      requester_id text,
      responder_id text,
      state text,
      origin_task_ref text,
      routing jsonb,
      PRIMARY KEY (workspace_id, conversation_id)
    )`);
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.consult_state`;
});

describe('the exclusion query runs against the REAL schema (P-005 / D-001)', () => {
  it('CONTROL — the pre-fix query FAILS on the real schema: `assignee` is not a work_items column', async () => {
    await seedWorkItem('WI-1', { takenBy: 'su-impl' });

    await expect(preFixExclusionQuery(db.sql, PLAN)).rejects.toThrow(/column "assignee" does not exist/i);
  });

  it('CALIBRATION — the same shape with the REAL column resolves, so the control above indicts the column, not the harness', async () => {
    await seedWorkItem('WI-1', { takenBy: 'su-impl' });

    // Identical query, `assignee` -> `taken_by`. If this also threw, the control
    // would be measuring a broken fixture rather than a real missing column.
    const rows = (await db.sql`
      SELECT DISTINCT taken_by AS owner FROM harness_shared.work_items
       WHERE source_plan_slug = ${PLAN} AND taken_by IS NOT NULL
    `) as unknown as Array<{ owner: string }>;
    expect(rows.map((r) => r.owner)).toEqual(['su-impl']);
  });

  it('the SHIPPED query resolves against the real schema and collects every implementer', async () => {
    await seedWorkItem('WI-1', { takenBy: 'su-taken' });
    await seedWorkItem('WI-2', { terminalOwner: 'su-terminal' });
    await seedConsult('conv-1', { requester: 'su-requester' });
    await seedConsult('conv-2', { requester: 'su-r2', responder: 'su-responder', state: 'closed_answered' });

    const out = await computeGraderExclusions(db.sql, WS, PLAN, ['su-extra']);

    // This assertion is secondary. The PRIMARY guarantee is that the call above
    // did not throw: every column the shipped SQL names resolves on a real schema.
    expect([...out].sort()).toEqual(
      ['su-extra', 'su-r2', 'su-requester', 'su-responder', 'su-taken', 'su-terminal'].sort(),
    );
  });

  it('a declined/no-show responder does NOT contaminate the exclusion set', async () => {
    await seedConsult('conv-1', { requester: 'su-asked', responder: 'su-declined', state: 'declined' });

    const out = await computeGraderExclusions(db.sql, WS, PLAN);

    expect(out).toContain('su-asked');
    expect(out).not.toContain('su-declined');
  });

  it('GRADE-ELIGIBLE (P-007 / D-004) — a bar-critique responder stays eligible; its requester does not', async () => {
    await seedConsult('conv-crit', {
      requester: 'su-author',
      responder: 'su-critic',
      state: 'closed_answered',
      routing: { policy: 'bar-critique' },
    });

    const out = await computeGraderExclusions(db.sql, WS, PLAN);

    expect(out).not.toContain('su-critic');
    expect(out).toContain('su-author');
  });

  it('CONTROL — the same answered thread under any other policy DOES exclude its responder', async () => {
    // Without this pair, the assertion above would also pass if the responder
    // leg had stopped matching anything at all.
    await seedConsult('conv-other', {
      requester: 'su-author',
      responder: 'su-critic',
      state: 'closed_answered',
      routing: { policy: 'rubric-vetting' },
    });
    await seedConsult('conv-null', { requester: 'su-r3', responder: 'su-unrouted', state: 'closed_answered' });

    const out = await computeGraderExclusions(db.sql, WS, PLAN);

    expect(out).toContain('su-critic');
    expect(out).toContain('su-unrouted');
  });
});

describe('the work_items legs are workspace-scoped (P-005 / D-002)', () => {
  it('an identically-slugged work-item in ANOTHER workspace is not treated as an implementer', async () => {
    await seedWorkItem('WI-mine', { takenBy: 'su-mine', ws: WS });
    await seedWorkItem('WI-theirs', { takenBy: 'su-theirs', ws: OTHER_WS });

    const out = await computeGraderExclusions(db.sql, WS, PLAN);

    expect(out).toContain('su-mine');
    expect(out).not.toContain('su-theirs');
  });

  it('CONTROL — the same row IS found when the query is scoped to its own workspace', async () => {
    // Without this pair, the assertion above would also pass if the workspace
    // predicate were excluding everything.
    await seedWorkItem('WI-theirs', { takenBy: 'su-theirs', ws: OTHER_WS });

    const out = await computeGraderExclusions(db.sql, OTHER_WS, PLAN);

    expect(out).toContain('su-theirs');
  });
});

describe('the view/base asymmetry that caused D-001 is real and pinned', () => {
  it('`assignee` exists ONLY on the engineer_issues VIEW, as an alias of work_items.taken_by', async () => {
    const cols = (await db.sql`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name IN ('work_items', 'engineer_issues')
         AND column_name = 'assignee'
    `) as unknown as Array<{ table_name: string; column_name: string }>;

    const relations = cols.map((c) => c.table_name);
    // The whole defect in one assertion: the VIEW has it, the BASE TABLE does not.
    expect(relations).toContain('engineer_issues');
    expect(relations).not.toContain('work_items');

    // ...and the view's `assignee` IS `taken_by`, which is why dropping the
    // `assignee` UNION branch was semantics-preserving rather than a narrowing.
    await seedWorkItem('WI-1', { takenBy: 'su-one' });
    const view = (await db.sql`
      SELECT assignee FROM harness_shared.engineer_issues WHERE issue_id = 'WI-1'
    `) as unknown as Array<{ assignee: string | null }>;
    expect(view[0]?.assignee).toBe('su-one');
  });
});
