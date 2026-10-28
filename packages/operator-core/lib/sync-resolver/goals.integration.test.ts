/**
 * goals.integration.test.ts — the goals.* sync resolvers against REAL SQL.
 *
 * Plan: goal-mode-2026-08-07 (P-021).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Both resolvers shipped REFERENCING COLUMNS THAT DO NOT EXIST
 * (`wi.closed_at`, `wi.updated_at`; the real ones are the bigint epoch-ms
 * `closed_ts` / `updated_ts`), and nothing caught it:
 *
 *   - tsc cannot see inside a SQL template string;
 *   - every test on this path mocked the sync layer, so the SQL never ran;
 *   - the resolvers were recorded DONE on those green tests, and two UI
 *     surfaces (the rail Goal tab, the HUD goals tab) were then built on top
 *     of them and also recorded done.
 *
 * The whole goal UI was dead on arrival — `{"error":"column wi.closed_at does
 * not exist"}` for every goal read — and it stayed invisible because a mocked
 * resolver is green exactly as loudly as a working one. The first time the
 * query hit a real database was during P-021's live verification.
 *
 * So the guard has to RUN THE SQL. That is the only thing that fails on this
 * class, and it is why this file cannot be replaced by a faster unit test.
 *
 * ⚠ THE SCHEMA MUST COME FROM THE REAL MIGRATIONS — never a hand-rolled
 * `CREATE TABLE` fixture. A fixture is written by the same author, from the
 * same wrong belief about the schema, so it would happily declare `closed_at`
 * and keep this test green while production 500s. `applyPendingMigrations`
 * over the whole sql/ directory is what makes the assertion mean something.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   npm run test:file -- packages/operator-core/lib/sync-resolver/goals.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { GOAL_SPEND_SNAPSHOT_SOURCE } from '@papercusp/db-org';
import { readTypedPropertyCollection } from '../typed-properties';
import { flushFallbackObservations, observeFallback } from '../degradation/fallback-observations';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..', '..');
const SQL_DIR = join(REPO, 'libs', 'papercusp', 'libs', 'db', 'sql');
const RUNNER = join(
  REPO,
  'libs',
  'papercusp',
  'packages',
  'embedded-postgres-server',
  'src',
  'migration-runner.js',
);

const WS = 'papercusp-workspace';
const GOAL = 'goal-under-test';

let db: MigratedTestDb;
let sql: Sql;
let nestedPg: BaselineCoordFixture;

// The resolvers reach for their connection through `getOrgPg()` at call time
// (a dynamic import inside each function), so pointing that at the test
// database is all the wiring this needs.
//
// PARTIAL mock, deliberately: `resolveGoalsList` also imports the REAL
// `portfolioSpend` from this module, and a whole-module replacement silently
// removes it — which surfaces as "No portfolio export is defined on the mock"
// from inside the resolver, i.e. an error about MY test dressed up as one
// about the code under test.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql }),
}));

const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: {
        client: Sql;
        sqlDir: string;
      }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    // A PARTIAL migration run would give this suite a schema that is neither
    // the real one nor an honest fixture — the worst of both, and it would
    // most likely fail in a way that reads as a resolver bug.
    if (appliedCount !== totalKnown) {
      throw new Error(`migrations incomplete: applied ${appliedCount} of ${totalKnown}`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  db = await createFreshTestDb({ provision });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
  // The owner report also uses dedicated connections outside getOrgPg().
  nestedPg = await setupBaselineCoordFixture({ dsn: db.url });
  // A name-filtered run may start with the deadline regression. Keep Vitest's
  // cold module transforms in suite setup, outside its per-case timer; a timed
  // out async test keeps running and would otherwise race the next SQL fixture.
  await Promise.all([import('./goals'), import('../goal-launch-settings'), import('../agent-obligation-reader'),
    import('../goal-rubric-stewardship')]);
}, 600_000);

async function closeGoalSql(timeout: number): Promise<void> {
  try {
    // A bounded read can leave telemetry buffered beyond the test body. Drain
    // its real writer before ending the handle it captured or replacing sql.
    expect(await flushFallbackObservations({ sql })).toMatchObject({ failed: 0, dropped: 0 });
  } finally {
    await sql?.end({ timeout });
  }
}

afterAll(async () => {
  try {
    await closeGoalSql(5);
  } finally {
    await nestedPg?.dispose();
    await db?.drop();
  }
});

beforeEach(async () => {
  // CASCADE because `harness_plans` is FK-referenced (plan assertions/items);
  // this is a throwaway per-file testcontainer, so cascading is exactly right
  // and the alternative — enumerating every referencing table here — rots the
  // moment someone adds another one.
  await sql`TRUNCATE harness_shared.goals, harness_shared.goal_pots,
                     harness_shared.work_items, harness_shared.agent_usage_samples,
                     harness_shared.agent_usage_harness_spend_totals,
                     harness_shared.harness_plans, harness_shared.agent_modes CASCADE`;
});

async function goal(
  over: {
    body?: string;
    killCriterion?: string | null;
    tripwires?: unknown;
    launchSettings?: unknown;
    metadata?: Record<string, unknown> | null;
    /** ISO; default now(). Attributed spend is bounded below by it. */
    createdAt?: string;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.goals (id, workspace_id, install_slug, title, body, status,
                                      budget_cents, kill_criterion, tripwires, launch_settings,
                                      metadata, created_at, updated_at)
    VALUES (${GOAL}, ${WS}, 'papercusp', 'Ship the thing', ${over.body ?? 'body'}, 'active', 50000,
            ${over.killCriterion === undefined ? 'Stop at day 30' : over.killCriterion},
            ${sql.json((over.tripwires ?? []) as never)},
            ${over.launchSettings === undefined ? null : sql.json(over.launchSettings as never)},
            ${over.metadata === undefined ? null : sql.json(over.metadata as never)},
            COALESCE(${over.createdAt ?? null}::timestamptz, now()), now())
  `;
}

describe('goal rubric stewardship SQL', () => {
  it('reads a preserved goal-owned baseline, verified repair and audited regrade while rejecting foreign and unsettled controls', async () => {
    const { readGoalRubricStewardship } = await import('../goal-rubric-stewardship');
    const { proposeRubric } = await import('../rubrics');
    const packageBody = JSON.parse(readFileSync(join(REPO, 'goal-packages', 'work-on-everything', 'goal.json'), 'utf8')).body;
    await goal({ body: packageBody });
    const criterion = { key: 'quality', title: 'Quality', model: 'The target meets its quality contract.',
      method: 'Compare the exact target before and after the verified repair.', driftMarkers: 'A confirmed defect remains.' };
    const rubric = await proposeRubric({ rubricId: 'stewardship-fixture-quality', title: 'Fixture quality',
      characteristic: 'quality', criteria: [criterion], status: 'active', gradingAuthority: 'independent', by: 'fixture-author' });
    const meta = await proposeRubric({ rubricId: 'grading-integrity', title: 'Grading integrity fixture',
      characteristic: 'grading-integrity', criteria: [criterion], status: 'active', by: 'fixture-auditor' });
    const now = Date.now(), baselineAt = now - 7200_000, repairedAt = now - 3600_000, regradedAt = now - 1800_000;
    const columns = await sql<{ column_name: string; is_generated: string }[]>`
      SELECT column_name, is_generated FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'work_items'`;
    for (const name of ['feature_id', 'workspace_id', 'harness_slug', 'item_kind', 'title', 'status',
      'created_ts', 'updated_ts', 'closed_ts', 'goal_id', 'terminal_owner', 'authority', 'payload']) {
      expect(columns.find(c => c.column_name === name)?.is_generated, `writable positive fixture column ${name}`).toBe('NEVER');
    }
    const subject = { kind: 'pot', ref: 'fixture-target' };
    const card = (rating: string, baselineRef?: string, auditState = 'passed') => ({
      rubricRef: rubric.rubricId, rubricRevision: rubric.revision, criteriaHash: rubric.criteriaHash,
      subject, ...(baselineRef ? { baselineRef } : {}),
      ratings: { quality: { rating, evidence: 'Independent measurement of the same fixture target',
        ...(rating === 'fail' ? { remediation: 'WI-12' } : {}) } },
      gradingAudit: { state: auditState, metaRubricRef: meta.rubricId, rubricRevision: meta.revision,
        criteriaHash: meta.criteriaHash, stampedAt: new Date(baselineAt).toISOString(),
        auditIssueId: 'EI-fixture-audit', auditor: 'independent-auditor', auditedAt: new Date(regradedAt).toISOString() },
    });
    const insertCard = async (id: string, goalId: string | null, at: number, observation: unknown, grader = 'independent-grader') => {
      await sql`INSERT INTO harness_shared.work_items
        (feature_id, workspace_id, harness_slug, item_kind, title, status, created_ts, updated_ts, goal_id, payload)
        VALUES (${id}, ${WS}, 'papercusp', 'change', ${id}, 'open', ${at}, ${at}, ${goalId},
          ${sql.json({ lane: 'observation', _ei: { created_by: grader }, observation } as never)})`;
    };
    await insertCard('EI-owned-baseline', GOAL, baselineAt, card('fail'));
    const repairEvidence = { summary: 'Fixture repair verified', testsRun: 'Canonical fixture repair suite',
      testResult: 'passed', verifiedHow: 'Recurrence guard failed before repair and passed after repair',
      filesChanged: ['packages/operator-core/lib/goal-rubric-stewardship.test.ts'] };
    // Honor migration 972's real content-identity floor. These synthetic matching
    // blobs model a committed fixture repair; missing identity must stay proposed.
    const committedEvidence = { ...repairEvidence, treeStamp: { contentIdentity: [{
      path: repairEvidence.filesChanged[0], workingTreeBlobSha: 'a'.repeat(40), headBlobSha: 'a'.repeat(40),
    }] } };
    const insertRepair = async (id: string, evidence: unknown) => sql`INSERT INTO harness_shared.work_items
      (feature_id, workspace_id, harness_slug, item_kind, title, status, created_ts, updated_ts, closed_ts,
       goal_id, terminal_owner, authority, payload)
      VALUES (${id}, ${WS}, 'papercusp', 'change', 'Fixture repair', 'done', ${baselineAt + 1000},
        ${repairedAt}, ${repairedAt}, ${GOAL}, 'fixture-builder', 'committed',
        ${sql.json({ _completionEvidence: evidence } as never)})`;
    await insertRepair('WI-12', committedEvidence);
    await insertRepair('WI-13', repairEvidence);
    const repairAuthority = await sql<{ feature_id: string; authority: string }[]>`
      SELECT feature_id, authority FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ANY(${['WI-12', 'WI-13']}) ORDER BY feature_id`;
    expect(repairAuthority, 'Migrated authority guard decides committed versus unproven repair').toEqual([
      { feature_id: 'WI-12', authority: 'committed' }, { feature_id: 'WI-13', authority: 'proposed' },
    ]);
    await insertCard('EI-owned-regrade', GOAL, regradedAt, card('pass', 'EI-owned-baseline'));
    await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, launch_spec)
      VALUES (${WS}, 'console', 'fixture-builder-child', ${sql.json({ launchedBy: 'fixture-builder' })})`;
    await insertCard('EI-inlineage-regrade', GOAL, regradedAt, card('pass', 'EI-owned-baseline'), 'fixture-builder-child');
    const unprovenBaseline = card('fail');
    unprovenBaseline.ratings.quality.remediation = 'WI-13';
    await insertCard('EI-unproven-baseline', GOAL, baselineAt, unprovenBaseline);
    await insertCard('EI-unproven-regrade', GOAL, regradedAt, card('pass', 'EI-unproven-baseline'));
    await insertCard('EI-null-goal', null, regradedAt + 1, card('pass', 'EI-owned-baseline'));
    await insertCard('EI-other-goal', 'distinct-other-goal', regradedAt + 2, card('pass', 'EI-owned-baseline'));
    await insertCard('EI-owned-unsettled', GOAL, regradedAt + 3, card('pass', undefined, 'pending'));
    // Actual GRADE lifecycle, tracked session, claim and progress are separate
    // ledgers. A foreign-goal assignment/work item must never enter this read.
    for (const [owner, goalId] of [['fixture-grader', GOAL], ['foreign-grader', 'distinct-other-goal']]) {
      await sql`INSERT INTO harness_shared.session_briefs (workspace_id, owner_id, goal_id)
        VALUES (${WS}, ${owner}, ${goalId})`;
      await sql`INSERT INTO harness_shared.agent_mode_changes
        (workspace_id, owner_id, axis_key, new_mode, subject, set_by, changed_at)
        VALUES (${WS}, ${owner}, 'overlay:grade', 'grade', ${rubric.rubricId}, 'fixture-launcher',
          ${new Date(baselineAt).toISOString()}::timestamptz)`;
      await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id)
        VALUES (${WS}, 'console', ${owner})`;
    }
    await sql`INSERT INTO harness_shared.work_items
      (feature_id, workspace_id, harness_slug, item_kind, title, status, created_ts, updated_ts,
       goal_id, taken_by, taken_at, last_progress_at, payload)
      VALUES ('WI-14', ${WS}, 'papercusp', 'task', 'Claimed grading assignment', 'wip', ${baselineAt}, ${regradedAt},
        ${GOAL}, 'fixture-grader', ${new Date(repairedAt).toISOString()}::timestamptz,
        ${new Date(regradedAt).toISOString()}::timestamptz, '{}'::jsonb)`;
    // Canonical scorecard capture writes kind=change and observation lane; the
    // engineer_issues view intentionally excludes synthetic item_kind=observation.
    const seeded = await sql<{ issue_id: string; created_by: string }[]>`
      SELECT issue_id, created_by FROM harness_shared.engineer_issues
       WHERE workspace_id = ${WS} AND issue_id = ANY(${['EI-owned-baseline', 'EI-owned-regrade', 'EI-owned-unsettled']})`;
    expect(seeded).toHaveLength(3);
    expect(seeded.every(row => row.created_by === 'independent-grader')).toBe(true);
    const { getWorkItemsByIds } = await import('../work-items');
    const repaired = await getWorkItemsByIds(['WI-12']);
    expect(repaired, 'The canonical repair read must preserve terminal proof before cycle classification').toEqual([
      expect.objectContaining({ id: 'WI-12', state: 'done', completionAuthority: 'committed',
        closedAt: new Date(repairedAt).toISOString(), terminalCompletionEvidence: expect.objectContaining({
          testsRun: 'Canonical fixture repair suite', testResult: 'passed',
        }) }),
    ]);
    const reading = await readGoalRubricStewardship({ workspaceId: WS, goalId: GOAL, nowMs: now }, { sql });
    expect(reading.error).toBeNull();
    expect(reading.complete).toBe(true);
    expect(reading.assignmentsComplete).toBe(true);
    expect(reading.gradingAssignments).toEqual([expect.objectContaining({ ownerId: 'fixture-grader',
      subject: rubric.rubricId, launchRef: expect.stringMatching(/^adv-session:/),
      work: [{ ref: 'WI-14', state: 'wip', claimedAt: new Date(repairedAt).toISOString(),
        progressAt: new Date(regradedAt).toISOString(), authority: null }],
    })]);
    expect(reading.cycles).toEqual(expect.arrayContaining([
      expect.objectContaining({ scorecardRef: 'EI-owned-regrade', baselineRef: 'EI-owned-baseline',
        repairRefs: ['WI-12'], status: 'verified' }),
      expect.objectContaining({ scorecardRef: 'EI-owned-unsettled', status: 'unverified' }),
      expect.objectContaining({ scorecardRef: 'EI-unproven-regrade', repairRefs: ['WI-13'], status: 'unverified' }),
      expect.objectContaining({ scorecardRef: 'EI-inlineage-regrade', status: 'unverified',
        reason: 'This rubric requires acceptance by a grader independent of the implementers.' }),
    ]));
    expect(reading.cycles.map(c => c.scorecardRef)).not.toContain('EI-null-goal');
    expect(reading.cycles.map(c => c.scorecardRef)).not.toContain('EI-other-goal');
    const { readGoalPortfolioBrief, renderGoalPortfolioBrief } = await import('../goal-launch-settings');
    const portfolio = await readGoalPortfolioBrief({ workspaceId: WS, goalId: GOAL, sql,
      now: new Date(now), claimability: 'skip' });
    expect(portfolio?.rubricStewardship?.cycles).toEqual(reading.cycles);
    const rendered = renderGoalPortfolioBrief(portfolio!);
    for (const phrase of ['Maintain rubric coverage', 'Improve rubric quality', 'Grade, improve and re-grade',
      'baseline=EI-owned-baseline', 'regrade=EI-owned-regrade', 'repairs=WI-12']) expect(rendered).toContain(phrase);
    const { renderGoalHolderWakeState } = await import('../goal-holder-wake-state');
    const wake = renderGoalHolderWakeState({ read: { goalId: GOAL, portfolio, observedAt: new Date(now).toISOString(),
      degradedSources: [], agenda: { schemaVersion: 'agent-obligations-v1', evaluatedAt: new Date(now).toISOString(),
        sourceGeneration: 'fixture', evaluations: [], primary: [], conflicts: [] } },
      loop: { fireNumber: 1, intervalSec: 300, firedAtMs: now } });
    for (const phrase of ['Maintain rubric coverage', 'Improve rubric quality', 'Grade, improve and re-grade',
      'baselineRef', 'supersedes corrects']) expect(wake).toContain(phrase);
    // The preserved baseline remains readable after a re-grade; it is not superseded.
    const { listScorecards } = await import('../scorecards');
    expect((await listScorecards({ issueIds: ['EI-owned-baseline'], limit: 1 })).map(c => c.issueId))
      .toEqual(['EI-owned-baseline']);
  });
  it('reads the migrated ledgers and distinguishes absent evidence from a foreign goal card', async () => {
    const { readGoalRubricStewardship } = await import('../goal-rubric-stewardship');
    await goal();
    // Preflight the actual migrated write contract: lane is generated from payload,
    // and lifecycle status is the persisted column (state is a reader projection).
    const columns = await sql<{ column_name: string; is_generated: string }[]>`
      SELECT column_name, is_generated FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'work_items'`;
    for (const name of ['feature_id', 'workspace_id', 'harness_slug', 'item_kind', 'title', 'status',
      'created_ts', 'updated_ts', 'goal_id', 'payload']) {
      expect(columns.find(c => c.column_name === name)?.is_generated, `writable fixture column ${name}`).toBe('NEVER');
    }
    expect(columns.find(c => c.column_name === 'lane')?.is_generated).toBe('ALWAYS');
    await sql`INSERT INTO harness_shared.work_items (feature_id, workspace_id, harness_slug, item_kind, title, status, created_ts, updated_ts, goal_id, payload)
      VALUES ('EI-stewardship-foreign', ${WS}, 'papercusp', 'observation', 'Foreign card', 'open',
        ${Date.now()}, ${Date.now()}, NULL,
        ${sql.json({ lane: 'observation', observation: { rubricRef: 'work-on-everything-stewardship-health', ratings: {} } } as never)})`;
    const reading = await readGoalRubricStewardship({ workspaceId: WS, goalId: GOAL }, { sql });
    expect(reading.error).toBeNull();
    expect(reading.complete).toBe(true);
    expect(reading.cycles).toEqual([]);
    expect(Object.values(reading.criteria)).toEqual([null, null, null]);
    await sql`UPDATE harness_shared.goals SET property_schema = ${sql.json({ worklist: {
      datatype: 'plan-ref-list', default: [], editable_by: 'both', collection: { source: 'active-workspace-plans',
        policy: 'worklist_policy', order: 'priority', selectable: true, defaultSelected: false },
    }, worklist_policy: { datatype: 'ordered-selection-policy', default: { order: [], excluded: [] },
      editable_by: 'owner' } } as never)} WHERE id = ${GOAL} AND workspace_id = ${WS}`;
    const { resolveGoalDetail } = await import('./goals');
    const detail = await resolveGoalDetail({ workspaceId: WS, goalId: GOAL }) as {
      rubricStewardship: { error: string | null; cycles: unknown[] } | null;
    };
    expect(detail.rubricStewardship).toMatchObject({ error: null, cycles: [] });
  });
});

async function pot(
  slug: string,
  over: { role?: string; removedAt?: string | null; killCriterion?: string | null } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.goal_pots (workspace_id, goal_id, harness_slug, role,
                                          added_at, removed_at, kill_criterion, note)
    VALUES (${WS}, ${GOAL}, ${slug}, ${over.role ?? 'owner'}, now(),
            ${over.removedAt ?? null}, ${over.killCriterion ?? 'ship or stop'}, 'a note')
  `;
}

/**
 * `closed_ts` / `updated_ts` are BIGINT EPOCH-MS — the very columns the bug got
 * wrong, so the fixture writes them in their real type.
 *
 * ⚠ CLOSING A ROW TAKES BOTH a terminal `status` AND an explicit `closedTs`.
 * `stamp_before_fed_work_item_closed_ts_trg` (BEFORE INSERT OR UPDATE) NULLs `closed_ts`
 * whenever the status is non-terminal, and on INSERT it deliberately never
 * INVENTS one — an already-terminal row arriving is a federated replica or a
 * restore, where stamping now() would record its ARRIVAL as its close. So a
 * timestamp without a terminal status is silently discarded, and a terminal
 * status without a timestamp leaves an honest NULL; either alone produces a row
 * that reads as still-open.
 */
async function workItem(
  id: string,
  over: {
    harness?: string;
    status?: string;
    closedTs?: number | null;
    needsHuman?: boolean;
    updatedTs?: number;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, title, status, item_kind, workspace_id, goal_id,
       created_ts, updated_ts, closed_ts, payload)
    VALUES (${over.harness ?? 'alpha'}, ${id}, ${`item ${id}`}, ${over.status ?? 'open'}, 'task',
            ${WS}, ${GOAL}, 0, ${over.updatedTs ?? 1_700_000_000_000}, ${over.closedTs ?? null},
            ${sql.json({ needsHuman: over.needsHuman ?? false } as never)})
  `;
}

/** A genuinely CLOSED row — both halves the trigger requires, in one place so
 *  no case can accidentally set only one of them. */
const CLOSED_AT = Date.parse('2026-08-03T12:00:00Z');
function closedItem(id: string, updatedTs = CLOSED_AT): Promise<void> {
  return workItem(id, { status: 'done', closedTs: CLOSED_AT, updatedTs });
}

/* ── P-019/D-010 fixtures ────────────────────────────────────────────────
   A work item that CAME FROM a plan. `source_plan_slug` is the only column
   tying a work item to a plan, and it is the entire basis of the goal→plan
   derivation — see D-010 for why the pots-based alternative is rejected. */
async function planItem(
  id: string,
  planSlug: string,
  over: { harness?: string; closedTs?: number | null; status?: string; updatedTs?: number } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, title, status, item_kind, workspace_id, goal_id,
       source_plan_slug, created_ts, updated_ts, closed_ts, payload)
    VALUES (${over.harness ?? 'alpha'}, ${id}, ${`item ${id}`}, ${over.status ?? 'open'}, 'task',
            ${WS}, ${GOAL}, ${planSlug}, 0, ${over.updatedTs ?? 1_700_000_000_000},
            ${over.closedTs ?? null}, ${sql.json({} as never)})
  `;
}

async function plan(
  planSlug: string,
  over: {
    harness?: string;
    title?: string;
    status?: string;
    archived?: boolean;
    /** Migration 791: the plan was CREATED under this goal. Defaults to NULL —
     *  the overwhelmingly common case, and the one the derived leg covers. */
    goalId?: string | null;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, archived, goal_id)
    VALUES (${WS}, ${over.harness ?? 'alpha'}, ${planSlug}, ${over.title ?? `Plan ${planSlug}`},
            ${over.status ?? 'ready'}, ${over.archived ?? false}, ${over.goalId ?? null})
  `;
}

/** The goal↔agent marker (D-007): `agent_modes.subject`, no dedicated column. */
async function agentOnGoal(ownerId: string, subject: string = GOAL): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_modes
      (workspace_id, owner_id, axis_key, mode, reason, set_by, subject)
    VALUES (${WS}, ${ownerId}, 'overlay:goal', 'goal', 'test', 'operator-ui', ${subject})
  `;
}

async function usage(slug: string, tsMs: number, costUsd: number, goalId: string | null = null): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, harness_slug, cost_usd, bucket_key, provider, model_class, source, goal_id)
    VALUES (${WS}, ${tsMs}, ${slug}, ${costUsd}, 'b', 'anthropic', 'sonnet', 'test', ${goalId})
  `;
}

describe('goals.* resolvers against real SQL', () => {
  it('bounds pending collection reads together while retaining a ready collection', async () => {
    await goal();
    await plan('ready-plan', { harness: 'alpha', title: 'Ready collection', status: 'active' });
    const schema = Object.fromEntries(['ready', 'slow-a', 'slow-b'].flatMap(property => [
      [property, { datatype: 'plan-ref-list', default: [], editable_by: 'both',
        collection: { source: 'active-workspace-plans', policy: `${property}_policy`, order: 'priority',
          selectable: true, defaultSelected: true } }],
      [`${property}_policy`, { datatype: 'ordered-selection-policy', editable_by: 'owner',
        default: { order: [], excluded: [] } }],
    ]));
    await sql`UPDATE harness_shared.goals SET property_schema=${sql.json(schema)}
      WHERE workspace_id=${WS} AND id=${GOAL}`;
    const [{ resolveGoalDetail }, settings] = await Promise.all([
      import('./goals'), import('../goal-launch-settings'),
    ]);
    const original = settings.readGoalPortfolioBrief;
    let releasePending!: () => void;
    const pending = new Promise<void>(resolve => { releasePending = resolve; });
    const portfolio = vi.spyOn(settings, 'readGoalPortfolioBrief').mockImplementation(async args => {
      if (args.collectionProperty !== 'ready') await pending;
      return original(args);
    });
    try {
      const detail = await resolveGoalDetail({ workspaceId: WS, goalId: GOAL }) as {
        goalData: { collections: Record<string, { selection: { ok: boolean }; rows: Array<{ planSlug: string }> }> };
      };
      expect(portfolio.mock.calls.map(([args]) => args.collectionProperty).sort())
        .toEqual(['ready', 'slow-a', 'slow-b']);
      expect(detail.goalData.collections.ready.selection.ok).toBe(true);
      expect(detail.goalData.collections.ready.rows).toContainEqual(expect.objectContaining({ planSlug: 'ready-plan' }));
      for (const property of ['slow-a', 'slow-b']) {
        expect(detail.goalData.collections[property].selection.ok).toBe(false);
        expect(detail.goalData.collections[property].rows).toEqual([]);
        expect(JSON.stringify(detail.goalData.collections[property]))
          .toContain('Active workspace plans could not be read in time.');
      }
    } finally {
      // Release and drain the losing IO before the next fixture truncates.
      releasePending();
      await Promise.allSettled(portfolio.mock.results.filter(result => result.type === 'return')
        .map(result => Promise.resolve(result.value)));
      portfolio.mockRestore();
    }
  }, 15_000);

  it('reads the active-plan collection even when the goal has no attached holder', async () => {
    await goal();
    await plan('worklist-a', { harness: 'alpha', title: 'Readable without a holder', status: 'active' });
    const schema = { worklist: { datatype: 'plan-ref-list', default: [], editable_by: 'both',
      collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority', selectable: true, defaultSelected: true } },
      worklist_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner', default: { order: [], excluded: [] } } };
    await sql`UPDATE harness_shared.goals SET property_schema = ${sql.json(schema)} WHERE id = ${GOAL} AND workspace_id = ${WS}`;
    const { resolveGoalDetail } = await import('./goals');
    const detail = await resolveGoalDetail({ workspaceId: WS, goalId: GOAL }) as {
      goalModeState: { ownerId: string | null }; goalData: { collections: Record<string, {
        selection: { ok: boolean; configured: boolean }; rows: Array<{ label: string; planSlug: string }> }> } };
    expect(detail.goalModeState.ownerId).toBeNull();
    expect(detail.goalData.collections.worklist.selection).toMatchObject({ ok: true, configured: true });
    expect(detail.goalData.collections.worklist.rows).toContainEqual(expect.objectContaining({
      label: 'Readable without a holder', planSlug: 'worklist-a' }));
  });
  it('keeps discovered scheduled runs addressable and applies their saved exclusion in goal detail', async () => {
    await goal();
    await plan('ordinary', { harness: 'alpha', status: 'active' });
    const runSlug = 'nightly@run-1786557604333';
    const runRef = `plan:alpha/${runSlug}`;
    await plan(runSlug, { harness: 'alpha', title: 'Scheduled run', status: 'active' });
    const schema = { worklist: { datatype: 'plan-ref-list', default: [], editable_by: 'both',
      collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority', selectable: true, defaultSelected: true } },
      worklist_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner', default: { order: [], excluded: [] } } };
    const policy = { value: { order: [runRef, 'plan:alpha/ordinary'], excluded: [runRef] }, version: 4,
      provenance: 'owner-edit', edited_by: 'human', edited_at: '2026-10-01T00:00:00Z' };
    await sql`UPDATE harness_shared.goals SET property_schema = ${sql.json(schema)},
      properties = ${sql.json({ worklist_policy: policy })} WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    const { resolveGoalDetail } = await import('./goals');
    const detail = await resolveGoalDetail({ workspaceId: WS, goalId: GOAL }) as {
      goalData: { collections: Record<string, { selection: { ok: boolean; selected: string[] }; rows: Array<{ id: string; selected: boolean }> }> } };
    expect(detail.goalData.collections.worklist.selection).toMatchObject({ ok: true, selected: ['plan:alpha/ordinary'] });
    expect(detail.goalData.collections.worklist.rows).toMatchObject([
      { id: runRef, selected: false }, { id: 'plan:alpha/ordinary', selected: true },
    ]);
    const [stored] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    expect(stored.properties.worklist_policy).toEqual(policy);
  });

  it('starts the declared collection portfolio while holder liveness is pending', async () => {
    await goal();
    await agentOnGoal('su-overlapping-holder');
    await plan('overlapping-plan', { harness: 'alpha', title: 'Overlapping reads', status: 'active' });
    const ref = 'plan:alpha/overlapping-plan';
    const schema = { worklist: { datatype: 'plan-ref-list', default: [], editable_by: 'both',
      collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority',
        selectable: true, defaultSelected: false } },
      worklist_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner',
        default: { order: [], excluded: [] } } };
    const properties = { worklist: { value: [ref], version: 7 },
      worklist_policy: { value: { order: [ref], included: [ref], excluded: [] }, version: 3,
        provenance: 'owner-edit', edited_by: 'human', edited_at: '2026-10-01T00:00:00Z' } };
    await sql`UPDATE harness_shared.goals SET property_schema=${sql.json(schema)}, properties=${sql.json(properties)}
      WHERE workspace_id=${WS} AND id=${GOAL}`;
    const [{ resolveGoalDetail }, holderReader, portfolioReader] = await Promise.all([
      import('./goals'), import('../goals/holder'), import('../goal-launch-settings'),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let releaseHolder!: () => void;
    const holderPending = new Promise<void>(resolve => { releaseHolder = resolve; });
    const original = holderReader.resolveHolderLiveness;
    const holder = vi.spyOn(holderReader, 'resolveHolderLiveness').mockImplementation(async ids => {
      await holderPending;
      return original(ids);
    });
    const portfolio = vi.spyOn(portfolioReader, 'readGoalPortfolioBrief');
    const read = resolveGoalDetail({ workspaceId: WS, goalId: GOAL });
    try {
      await expect.poll(() => holder.mock.calls.length, { timeout: 3000 }).toBeGreaterThan(0);
      // Holding liveness open must not prevent the independent collection
      // read from starting. A longer outer resolver timeout cannot pass this.
      await expect.poll(() => portfolio.mock.calls.length, { timeout: 1000 }).toBe(1);
      releaseHolder();
      const detail = await read as { goalData: { collections: { worklist: {
        selection: { ok: boolean; selected: string[] };
      } } } };
      expect(detail.goalData.collections.worklist.selection).toMatchObject({ ok: true, selected: [ref] });
      expect(portfolio).toHaveBeenCalledTimes(1);
      const { AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS } = await import('../agent-obligation-reader');
      const warningMessages = warn.mock.calls.map(([message]) => String(message));
      // The deliberately held holder read can make an optional source either
      // exceed its bound or finish with its canonical fallback error, depending
      // on scheduling. Assert the exact warning grammar and the required
      // plan-acceptance warning without making the timing race a product bar.
      const warningPattern = new RegExp(
        `^\\[bounded-timeout\\] agent-obligations:[\\w:-]+ (?:exceeded ${AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS}ms|failed: .+) — degrading to fallback$`,
      );
      expect(warningMessages.length).toBeGreaterThan(0);
      expect(warningMessages.every((message) => warningPattern.test(message))).toBe(true);
      expect(warningMessages.some((message) => message.startsWith(
        '[bounded-timeout] agent-obligations:plan-acceptance:overlapping-plan ',
      ))).toBe(true);
      const [saved] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id=${WS} AND id=${GOAL}`;
      expect(saved.properties).toEqual(properties);
    } finally {
      releaseHolder();
      // The failing ordering control must drain and restore both spies too.
      try { await read; } finally {
        holder.mockRestore();
        portfolio.mockRestore();
        warn.mockRestore();
      }
    }
  });

  it('starts stewardship while the shared portfolio read is pending', async () => {
    await goal();
    await plan('concurrent-plan', { harness: 'alpha', title: 'Concurrent evidence', status: 'active' });
    const schema = { worklist: { datatype: 'plan-ref-list', default: [], editable_by: 'both',
      collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority',
        selectable: true, defaultSelected: false } },
      worklist_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner',
        default: { order: [], excluded: [] } } };
    const properties = { worklist: { value: ['plan:alpha/concurrent-plan'], version: 1 },
      worklist_policy: { value: { order: ['plan:alpha/concurrent-plan'],
        included: ['plan:alpha/concurrent-plan'], excluded: [] }, version: 1,
        provenance: 'owner-edit', edited_by: 'human', edited_at: '2026-10-01T00:00:00Z' } };
    expect(readTypedPropertyCollection({ propertySchema: schema, properties, property: 'worklist',
      source: { ok: true, items: ['plan:alpha/concurrent-plan'] } }))
      .toMatchObject({ ok: true, selected: ['plan:alpha/concurrent-plan'] });
    await sql`UPDATE harness_shared.goals SET property_schema=${sql.json(schema)}, properties=${sql.json(properties)}
      WHERE workspace_id=${WS} AND id=${GOAL}`;
    const [{ resolveGoalDetail }, portfolioReader, stewardshipReader] = await Promise.all([
      import('./goals'), import('../goal-launch-settings'), import('../goal-rubric-stewardship'),
    ]);
    let markPortfolioStarted!: () => void, releasePortfolio!: () => void;
    const portfolioStarted = new Promise<void>(resolve => { markPortfolioStarted = resolve; });
    const portfolioPending = new Promise<void>(resolve => { releasePortfolio = resolve; });
    const original = portfolioReader.readGoalPortfolioBrief;
    const portfolio = vi.spyOn(portfolioReader, 'readGoalPortfolioBrief').mockImplementation(async args => {
      markPortfolioStarted();
      await portfolioPending;
      return original(args);
    });
    const stewardship = vi.spyOn(stewardshipReader, 'readGoalRubricStewardship');
    const read = resolveGoalDetail({ workspaceId: WS, goalId: GOAL });
    try {
      await portfolioStarted;
      // A serial implementation cannot reach stewardship until this test
      // releases the portfolio. No timing sum or widened resolver clock can
      // make that ordering pass.
      await expect.poll(() => stewardship.mock.calls.length, { timeout: 1000 }).toBe(1);
    } finally {
      releasePortfolio();
      // Drain even on an assertion failure before the next TRUNCATE fixture.
      try { await read; } finally {
        portfolio.mockRestore();
        stewardship.mockRestore();
      }
    }
    const detail = await read as { rubricStewardship: unknown; goalData: { collections: { worklist: {
      selection: { ok: boolean; selected: string[] };
    } } } };
    expect(detail.rubricStewardship).not.toBeNull();
    expect(detail.goalData.collections.worklist.selection.ok).toBe(true);
    expect(detail.goalData.collections.worklist.selection.selected).toEqual(['plan:alpha/concurrent-plan']);
    const [saved] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id=${WS} AND id=${GOAL}`;
    expect(saved.properties).toEqual(properties);
  });

  it.each(['late success', 'failure'] as const)(
    'shares the holder portfolio with the collection after optional read %s', async (outcome) => {
      await goal();
      await agentOnGoal('su-slow-portfolio');
      await plan('shared-plan', { harness: 'alpha', title: 'Shared portfolio', status: 'active' });
      const schema = { worklist: { datatype: 'plan-ref-list', default: [], editable_by: 'both',
        collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority',
          selectable: true, defaultSelected: false } },
        worklist_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner',
          default: { order: [], excluded: [] } } };
      const properties = { worklist: { value: ['plan:alpha/shared-plan'], version: 1 },
        worklist_policy: { value: { order: ['plan:alpha/shared-plan'], included: ['plan:alpha/shared-plan'],
          excluded: [] }, version: 1,
          provenance: 'owner-edit', edited_by: 'human', edited_at: '2026-10-01T00:00:00Z' } };
      expect(readTypedPropertyCollection({ propertySchema: schema, properties, property: 'worklist',
        source: { ok: true, items: ['plan:alpha/shared-plan'] } }))
        .toMatchObject({ ok: true, selected: ['plan:alpha/shared-plan'] });
      await sql`UPDATE harness_shared.goals SET property_schema = ${sql.json(schema)},
        properties = ${sql.json(properties)} WHERE id = ${GOAL} AND workspace_id = ${WS}`;
      const settings = await import('../goal-launch-settings');
      const read = settings.readGoalPortfolioBrief;
      const { AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS } = await import('../agent-obligation-reader');
      const spy = vi.spyOn(settings, 'readGoalPortfolioBrief').mockImplementation(async (args) => {
        // A real pending read outlives the agenda's optional bound. The table
        // must consume its eventual result (or error), without starting again.
        await new Promise((resolve) => setTimeout(resolve, AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS + 100));
        if (outcome === 'failure') throw new Error('portfolio unavailable');
        return read(args);
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { resolveGoalDetail } = await import('./goals');
        const detail = await resolveGoalDetail({ workspaceId: WS, goalId: GOAL }) as {
          goalModeState: { status: string; portfolio: unknown };
          goalData: { collections: Record<string, {
            selection: { ok: boolean; selected?: string[] }; rows: Array<{ id: string; label: string }> }> };
        };
        expect(detail.goalModeState).toMatchObject({ status: 'degraded', portfolio: null });
        expect(warn).toHaveBeenCalledWith(
          `[bounded-timeout] agent-obligations:goal-portfolio exceeded ${AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS}ms — degrading to fallback`,
        );
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, goalId: GOAL,
          collectionProperty: 'worklist', sql, claimability: 'skip', rubricStewardship: 'skip' }));
        if (outcome === 'late success') {
          expect(detail.goalData.collections.worklist.selection).toMatchObject({
            ok: true, selected: ['plan:alpha/shared-plan'] });
          expect(detail.goalData.collections.worklist.rows).toContainEqual(expect.objectContaining({
            id: 'plan:alpha/shared-plan', label: 'Shared portfolio' }));
        } else {
          expect(detail.goalData.collections.worklist.selection.ok).toBe(false);
          expect(detail.goalData.collections.worklist.rows).toEqual([]);
        }
        const [stored] = await sql`SELECT properties FROM harness_shared.goals WHERE id = ${GOAL} AND workspace_id = ${WS}`;
        expect(stored.properties).toEqual(properties);
      } finally {
        spy.mockRestore();
        warn.mockRestore();
      }
    }, 15_000,
  );

  it('reads a non-plan collection through the shared reader, retaining owner choices', async () => {
    await goal();
    const { resolveGoalDetail } = await import('./goals');
    const schema = { tea_choices: { datatype: 'list', default: ['mint', 'rooibos'], editable_by: 'both',
      collection: { source: 'manual', policy: 'tea_policy', order: 'priority', selectable: true, defaultSelected: true } },
      tea_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner', default: { order: [], excluded: [] } } };
    const policy = { value: { order: ['rooibos', 'mint', 'dormant'], excluded: ['mint'] }, version: 4,
      provenance: 'owner-edit', edited_by: 'human', edited_at: '2026-10-01T00:00:00Z' };
    await sql`UPDATE harness_shared.goals SET property_schema = ${sql.json(schema)},
      properties = ${sql.json({ tea_policy: policy })} WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    const detail = await resolveGoalDetail({ workspaceId: WS, goalId: GOAL }) as {
      goalData: { collections: Record<string, { selection: { selected: string[]; policyVersion: number }; rows: Array<{ id: string; selected: boolean }> }> } };
    expect(detail.goalData.collections.tea_choices.selection).toMatchObject({ policyVersion: 4, selected: ['rooibos'] });
    expect(detail.goalData.collections.tea_choices.rows).toMatchObject([{ id: 'rooibos', selected: true }, { id: 'mint', selected: false }]);
    const [stored] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    expect(stored.properties.tea_policy).toEqual(policy);
  });

  it('reads manual display order after the canonical owner save and a fresh detail read', async () => {
    const { nativeCollectionDeclaration, insertNativeCollectionGoal } =
      await import('../../../../apps/operator/e2e/_ongoing-work-native-fixture');
    const { ensureOrderedSelectionPolicyDatatype } = await import('../goals/package-property-datatypes');
    const { applyGoalPropertyWrite } = await import('../typed-properties-db');
    const { resolveGoalDetail } = await import('./goals');
    const ids = ['mint', 'chamomile', 'rooibos'];
    const { property, policyName, schema } = nativeCollectionDeclaration('tea', ids,
      { order: ['mint', 'lavender'], excluded: ['lavender'] });
    await ensureOrderedSelectionPolicyDatatype(sql, WS);
    await insertNativeCollectionGoal(sql, { workspaceId: WS, goalId: GOAL, title: 'Manual display', schema });
    const read = async () => {
      const detail = await resolveGoalDetail({ workspaceId: WS, goalId: GOAL }) as {
        goalData: { collections: Record<string, {
          selection: { policyVersion: number }; rows: Array<{ id: string; selected: boolean }>;
        }> };
      };
      return detail.goalData.collections[property];
    };
    expect((await read()).rows.map(row => row.id)).toEqual(ids);
    const value = { order: ['chamomile', 'mint', 'rooibos', 'lavender'], excluded: ['lavender'] };
    const saved = await sql.begin(tx => applyGoalPropertyWrite(tx as unknown as typeof sql, {
      workspaceId: WS, goalId: GOAL, property: policyName, value, expectedVersion: 0,
      provenance: 'owner-edit', actorId: 'human',
    }));
    expect(saved).toMatchObject({ ok: true });
    const [stored] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id=${WS} AND id=${GOAL}`;
    expect(stored.properties[policyName]).toMatchObject({ value, version: 1, provenance: 'owner-edit' });
    // A new resolver call must observe the saved envelope, rather than a UI
    // reorder or a directly seeded policy that bypassed the writer.
    const reloaded = await read();
    expect(reloaded.selection.policyVersion).toBe(1);
    expect(reloaded.rows.map(row => row.id)).toEqual(['chamomile', 'mint', 'rooibos']);
    expect(reloaded.rows.every(row => row.selected)).toBe(true);
  });

  it.each(['manual', 'active-workspace-plans'] as const)(
    'returns multiple selected members in saved owner priority order for %s collections',
    async (source) => {
      await goal();
      const ids = source === 'manual'
        ? ['mint', 'rooibos', 'chamomile']
        : ['plan:alpha/first', 'plan:alpha/second', 'plan:alpha/excluded'];
      if (source === 'active-workspace-plans') {
        for (const slug of ['first', 'second', 'excluded']) {
          await plan(slug, { harness: 'alpha', status: 'active' });
        }
      }
      const schema = {
        choices: {
          datatype: source === 'manual' ? 'list' : 'plan-ref-list',
          default: ids, editable_by: 'both',
          collection: { source, policy: 'choices_policy', order: 'priority', selectable: true, defaultSelected: true },
        },
        choices_policy: {
          datatype: 'ordered-selection-policy', editable_by: 'owner',
          default: { order: [], excluded: [] },
        },
      };
      const policy = {
        value: { order: [ids[1], ids[0], ids[2], source === 'manual' ? 'dormant' : 'plan:alpha/dormant'],
          excluded: [ids[2], source === 'manual' ? 'dormant' : 'plan:alpha/dormant'] },
        version: 4, provenance: 'owner-edit', edited_by: 'human', edited_at: '2026-10-01T00:00:00Z',
      };
      // Calibrate the fixture before writing it; policy-only dormant members
      // must obey the source's reference grammar too.
      expect(readTypedPropertyCollection({ propertySchema: schema,
        properties: { choices_policy: policy }, property: 'choices', source: { ok: true, items: ids } }))
        .toMatchObject({ ok: true, configured: true });
      await sql`UPDATE harness_shared.goals SET property_schema = ${sql.json(schema)},
        properties = ${sql.json({ choices_policy: policy })} WHERE workspace_id = ${WS} AND id = ${GOAL}`;
      const { resolveGoalDetail } = await import('./goals');
      const detail = await resolveGoalDetail({ workspaceId: WS, goalId: GOAL }) as {
        goalData: { collections: Record<string, {
          selection: { selected: string[]; policyVersion: number };
          rows: Array<{ id: string; selected: boolean }>;
        }> };
      };
      const collection = detail.goalData.collections.choices;
      expect(collection.selection).toMatchObject({ policyVersion: 4, selected: [ids[1], ids[0]] });
      expect(collection.rows.map(row => ({ id: row.id, selected: row.selected }))).toEqual([
        { id: ids[1], selected: true }, { id: ids[0], selected: true }, { id: ids[2], selected: false },
      ]);
      const [stored] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
      expect(stored.properties.choices_policy).toEqual(policy);
      const [claims] = await sql`SELECT count(*)::int AS count FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
      expect(claims.count).toBe(0);
    },
  );

  it('keeps independent owner policies for two declared active-plan collections', async () => {
    await goal();
    for (const slug of ['first', 'second', 'third']) await plan(slug, { status: 'active' });
    const ids = ['first', 'second', 'third'].map(slug => `plan:alpha/${slug}`);
    const collection = (policy: string) => ({
      datatype: 'plan-ref-list', default: ids, editable_by: 'both',
      collection: { source: 'active-workspace-plans', policy, order: 'priority', selectable: true, defaultSelected: true },
    });
    const policyDefinition = { datatype: 'ordered-selection-policy', editable_by: 'owner', default: { order: [], excluded: [] } };
    const schema = { worklist: collection('worklist_policy'), choices: collection('choices_policy'),
      worklist_policy: policyDefinition, choices_policy: policyDefinition };
    const policy = (order: string[], excluded: string[]) => ({
      value: { order, excluded }, version: 4, provenance: 'owner-edit', edited_by: 'human', edited_at: '2026-10-01T00:00:00Z',
    });
    const properties = { worklist_policy: policy(ids, [ids[2]]),
      choices_policy: policy([ids[1], ids[2], ids[0]], [ids[0]]) };
    for (const property of ['worklist', 'choices']) {
      expect(readTypedPropertyCollection({ propertySchema: schema, properties, property,
        source: { ok: true, items: ids } })).toMatchObject({ ok: true, configured: true });
    }
    await sql`UPDATE harness_shared.goals SET property_schema = ${sql.json(schema)},
      properties = ${sql.json(properties)} WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    const { resolveGoalDetail } = await import('./goals');
    const detail = await resolveGoalDetail({ workspaceId: WS, goalId: GOAL }) as {
      goalData: { collections: Record<string, { selection: { selected: string[] }; rows: Array<{ id: string }> }> };
    };
    expect(detail.goalData.collections.worklist.selection.selected).toEqual([ids[0], ids[1]]);
    expect(detail.goalData.collections.choices.selection.selected).toEqual([ids[1], ids[2]]);
    expect(detail.goalData.collections.choices.rows.map(row => row.id)).toEqual([ids[1], ids[2], ids[0]]);
    const [stored] = await sql`SELECT properties FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    expect(stored.properties).toEqual(properties);
  });

  it('exposes stored standing identity in list and detail even after a goal is renamed', async () => {
    await goal();
    await sql`UPDATE harness_shared.goals SET standing = true, title = 'Renamed steward' WHERE id = ${GOAL}`;
    const { resolveGoalsList, resolveGoalDetail } = await import('./goals');
    const list = await resolveGoalsList({ workspaceId: WS });
    const detail = await resolveGoalDetail({ workspaceId: WS, goalId: GOAL }) as { goal: { standing: boolean } | null };
    expect(list.goals.find((g) => g.id === GOAL)?.standing).toBe(true);
    expect(detail.goal?.standing).toBe(true);
    await sql`UPDATE harness_shared.goals SET standing = false WHERE id = ${GOAL}`;
    const ordinary = await resolveGoalDetail({ workspaceId: WS, goalId: GOAL }) as { goal: { standing: boolean } | null };
    expect(ordinary.goal?.standing).toBe(false);
  });
  it('resolveGoalsList RUNS — the assertion the whole file exists for', async () => {
    // Before the fix this threw `column wi.closed_at does not exist`. Every
    // mocked test on this path was green at the same moment.
    const { resolveGoalsList } = await import('./goals');
    await goal();
    await pot('alpha');
    await workItem('WI-1');
    await closedItem('WI-2');
    await workItem('WI-3', { needsHuman: true });

    const out = await resolveGoalsList({ workspaceId: WS });
    expect(out.goals).toHaveLength(1);
    const g = out.goals[0];
    expect(g.id).toBe(GOAL);
    expect(g.killCriterion).toBe('Stop at day 30');
    // Counters read through the epoch-ms columns: 2 open (WI-1, WI-3), 1 of
    // them parked on the owner. A wrong closed-column would count all three.
    expect(g.openWorkItems).toBe(2);
    expect(g.needsHuman).toBe(1);
    expect(g.potCount).toBe(1);
    // P-007/D-022: the card names WHICH pots, so the list query now carries a
    // bounded sample beside the count. Asserted here rather than only in the
    // pure chip test, because the shape is produced by json_agg + a correlated
    // servesGoals sub-select — SQL the client tests cannot see.
    expect(g.pots).toEqual([{ harnessSlug: 'alpha', role: 'owner', servesGoals: 1 }]);
    // EI-20080280064869122: the count is UNBOUNDED and must not be the capped
    // array's length. Untruncated here, so both agree — the control is below.
    expect(out.totalGoals).toBe(1);
    expect(out.truncatedByLimit).toBe(false);
  });

  it('reports the TRUE goal count even when the limit cut the rows', async () => {
    // The defect: the board rendered a capped list with nothing saying so, and
    // a truncated board is pixel-identical to a complete one. Driving the cap
    // below the row count is the only way to prove the aggregate is computed
    // independently rather than derived from the rows that survived it — which
    // is exactly the failure the paired assertion above cannot catch.
    const { resolveGoalsList } = await import('./goals');
    await goal();
    await pot('alpha');

    const cut = await resolveGoalsList({ workspaceId: WS, limit: 0 });
    expect(cut.goals).toHaveLength(0);
    expect(cut.totalGoals).toBe(1);
    expect(cut.truncatedByLimit).toBe(true);
  });

  it('harness-scoped listing includes an installed goal with no pot attachment', async () => {
    const { resolveGoalsList } = await import('./goals');
    await goal();

    const out = await resolveGoalsList({ workspaceId: WS, harnessSlugs: ['papercusp'] });
    expect(out.goals).toHaveLength(1);
    expect(out.goals[0]?.id).toBe(GOAL);
    expect(out.totalGoals).toBe(1);
    expect(out.truncatedByLimit).toBe(false);
  });

  it('does not expose a legacy hand-entered spend snapshot as measured', async () => {
    const { resolveGoalsList } = await import('./goals');
    await goal({ metadata: { spentCents: 302 } });

    const out = await resolveGoalsList({ workspaceId: WS });
    expect(out.goals[0]?.spentCents).toBeNull();
  });

  it('exposes a spend snapshot only when its goal-pot provenance is present', async () => {
    const { resolveGoalsList } = await import('./goals');
    await goal({
      metadata: { spentCents: 302, spentCentsSource: GOAL_SPEND_SNAPSHOT_SOURCE },
    });

    const out = await resolveGoalsList({ workspaceId: WS });
    expect(out.goals[0]?.spentCents).toBe(302);
  });

  it('resolveGoalDetail RUNS and returns every section the detail view reads', async () => {
    const { resolveGoalDetail } = await import('./goals');
    await goal({ createdAt: '2026-07-01T00:00:00Z' });
    await pot('alpha');
    await workItem('WI-open');
    await workItem('WI-wall', { needsHuman: true });
    // The chart and the total are the goal-attributed stream (WI-1074208): the
    // pot-harness sample with no goal_id must NOT appear in either.
    await usage('alpha', Date.parse('2026-08-01T10:00:00Z'), 3, GOAL);
    await usage('alpha', Date.parse('2026-08-02T10:00:00Z'), 8, GOAL);
    await usage('alpha', Date.parse('2026-08-03T10:00:00Z'), 50);

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      goal: { id: string } | null;
      pots: unknown[];
      waitingOnYou: Array<{ id: string; updatedAt: string | null }>;
      activity: Array<{ id: string; closedAt: string | null; updatedAt: string | null }>;
      spendByDay: Array<{ day: string; costUsd: number }>;
      spendLabel: string;
      goalModeState: { status: string; unknown?: { code?: string } };
    };

    expect(out.goal?.id).toBe(GOAL);
    expect(out.pots).toHaveLength(1);
    expect((out.pots[0] as { spendUsd?: number }).spendUsd).toBe(61);
    expect(out.waitingOnYou.map((w) => w.id)).toEqual(['WI-wall']);
    expect(out.activity).toHaveLength(2);
    expect(out.spendByDay.map((d) => d.day)).toEqual(['2026-08-01', '2026-08-02']);
    expect((out.goal as { spendUsd?: number | null } | null)?.spendUsd).toBe(11);
    expect(out.spendLabel).toBe('goal-attributed spend');
    expect(out.goalModeState).toMatchObject({
      status: 'unknown',
      unknown: { code: 'no-canonical-goal-holder' },
    });
  });

  it('backfills and maintains workspace-scoped lifetime pot spend without scanning source samples on detail reads', async () => {
    const priorSql = sql;
    const observedQueries: string[] = [];
    const observedSql = postgres(db.url, {
      max: 4,
      onnotice: () => {},
      prepare: false,
      debug: (_connection, query) => observedQueries.push(query),
    });
    sql = observedSql;
    try {
      const { resolveGoalDetail } = await import('./goals');
      await goal();
      await pot('alpha');

      const [{ id: sampleId }] = await sql`
        INSERT INTO harness_shared.agent_usage_samples
          (workspace_id, ts, harness_slug, cost_usd, bucket_key, provider, model_class, source)
        VALUES (${WS}, ${Date.parse('2026-08-01T10:00:00Z')}, 'alpha', 5, 'b', 'anthropic', 'sonnet', 'test')
        RETURNING id
      `;
      await sql`
        INSERT INTO harness_shared.agent_usage_samples
          (workspace_id, ts, harness_slug, cost_usd, bucket_key, provider, model_class, source)
        VALUES (${WS}, ${Date.parse('2026-08-02T10:00:00Z')}, 'alpha', NULL, 'b', 'anthropic', 'sonnet', 'test')
      `;
      await sql`
        INSERT INTO harness_shared.agent_usage_samples
          (workspace_id, ts, harness_slug, cost_usd, bucket_key, provider, model_class, source)
        VALUES ('other-workspace', ${Date.parse('2026-08-03T10:00:00Z')}, 'alpha', 1000, 'b', 'anthropic', 'sonnet', 'test'),
               (${WS}, ${Date.parse('2026-08-04T10:00:00Z')}, 'beta', 900, 'b', 'anthropic', 'sonnet', 'test')
      `;

      // Simulate legacy rows that predate the summary table, then execute the
      // exact migration backfill against them before checking trigger deltas.
      await sql`TRUNCATE harness_shared.agent_usage_harness_spend_totals`;
      const migration = readFileSync(join(SQL_DIR, '1605-agent-usage-harness-spend-totals.sql'), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(migration);
      });

      const scopedTotals = await sql.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE harness_app');
        await tx`SELECT set_config('app.workspace_id', ${WS}, true)`;
        return tx`
          SELECT harness_slug, total_cost_usd
            FROM harness_shared.agent_usage_harness_spend_totals
           ORDER BY harness_slug
        `;
      });
      expect(scopedTotals).toEqual([
        { harness_slug: 'alpha', total_cost_usd: 5 },
        { harness_slug: 'beta', total_cost_usd: 900 },
      ]);

      const readAlphaSpend = async (): Promise<number> => {
        const detail = await resolveGoalDetail({ workspaceId: WS, goalId: GOAL }) as {
          pots: Array<{ spendUsd: number }>;
        };
        return detail.pots[0]?.spendUsd ?? NaN;
      };
      expect(await readAlphaSpend()).toBe(5);

      await sql`UPDATE harness_shared.agent_usage_samples SET cost_usd = 8 WHERE id = ${sampleId}`;
      expect(await readAlphaSpend()).toBe(8);
      await sql`UPDATE harness_shared.agent_usage_samples SET harness_slug = 'beta' WHERE id = ${sampleId}`;
      expect(await readAlphaSpend()).toBe(0);
      await sql`DELETE FROM harness_shared.agent_usage_samples WHERE id = ${sampleId}`;
      const betaAfterDelete = await sql`
        SELECT total_cost_usd
          FROM harness_shared.agent_usage_harness_spend_totals
         WHERE workspace_id = ${WS} AND harness_slug = 'beta'
      `;
      expect(betaAfterDelete).toEqual([{ total_cost_usd: 900 }]);

      const potSpendQuery = observedQueries.find((query) => query.includes('FROM harness_shared.goal_pots gp'));
      expect(potSpendQuery).toBeDefined();
      expect(potSpendQuery).toContain('agent_usage_harness_spend_totals');
      expect(potSpendQuery?.toLowerCase()).not.toContain('sum(s.cost_usd)');
    } finally {
      await observedSql.end({ timeout: 5 });
      sql = priorSql;
    }
  });

  it.each(['available', 'pending'] as const)(
    'releases the detail transaction before holder liveness acquires the same one-connection pool with %s optional portfolio', async (portfolioState) => {
    const { resolveGoalDetail } = await import('./goals');
    const settings = await import('../goal-launch-settings');
    const { AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS } = await import('../agent-obligation-reader');
    await goal();
    await agentOnGoal('su-single-connection');
    const telemetryRef = randomUUID();
    expect(observeFallback('goal-fixture-pool-close', { eligible: 1, applied: 0,
      reason: 'fixture pool replacement' }, { sql, workspaceId: WS, correlationId: telemetryRef })).toBe(true);
    try {
      await closeGoalSql(5);
    } finally {
      sql = postgres(db.url, { max: 1, onnotice: () => {}, prepare: false });
    }
    // The buffered observation survives the old pool's closure; resetting or
    // discarding the queue would make this real migrated SQL assertion fail.
    expect(await sql`SELECT mechanism, reason FROM harness_shared.fallback_observations
      WHERE workspace_id=${WS} AND correlation_id=${telemetryRef}`)
      .toEqual([{ mechanism: 'goal-fixture-pool-close', reason: 'fixture pool replacement' }]);
    const originalPortfolio = settings.readGoalPortfolioBrief;
    let releasePortfolio!: () => void;
    const pendingPortfolio = new Promise<void>(resolve => { releasePortfolio = resolve; });
    const portfolio = vi.spyOn(settings, 'readGoalPortfolioBrief').mockImplementation(async args => {
      if (portfolioState === 'pending') await pendingPortfolio;
      return originalPortfolio(args);
    });
    // Optional agenda reads can legitimately use their bounded fallback while
    // the transaction/connection contract stays intact. Assert that disclosure
    // explicitly; unrelated warnings and read errors must still fail this case.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        resolveGoalDetail({ workspaceId: WS, goalId: GOAL }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('goal detail held the only connection during holder liveness')), 5_000);
        }),
      ]) as { goal: { id: string }; agents: Array<{ ownerId: string }>; holderLiveness: string;
        goalModeState: { status: string; portfolio: unknown; degradedReasons: string[] } };
      expect(out.goal.id).toBe(GOAL);
      expect(out.agents.map((agent) => agent.ownerId)).toEqual(['su-single-connection']);
      expect(['held', 'lost', 'unknown']).toContain(out.holderLiveness);
      expect(await sql`SELECT 1 AS n`).toEqual([{ n: 1 }]);
      expect(['known', 'degraded']).toContain(out.goalModeState.status);
      for (const [message] of warn.mock.calls) {
        expect(message).toMatch(/^\[bounded-timeout\] agent-obligations:[\w:-]+ exceeded \d+ms — degrading to fallback$/);
        expect(out.goalModeState.status).toBe('degraded');
        expect(out.goalModeState.degradedReasons.length).toBeGreaterThan(0);
      }
      if (portfolioState === 'pending') {
        expect(portfolio).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          `[bounded-timeout] agent-obligations:goal-portfolio exceeded ${AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS}ms — degrading to fallback`,
        );
        expect(out.goalModeState.portfolio).toBeNull();
      }
    } finally {
      clearTimeout(timer);
      releasePortfolio();
      await Promise.allSettled(portfolio.mock.results.filter(result => result.type === 'return')
        .map(result => Promise.resolve(result.value)));
      portfolio.mockRestore();
      warn.mockRestore();
      try {
        await closeGoalSql(1);
      } finally {
        sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
      }
    }
  }, 15_000);

  it('returns the goal holder’s exact turn-start obligation projection and canonical portfolio', async () => {
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await agentOnGoal('su-mine');
    await plan('goal-plan', { goalId: GOAL });
    // The optional acceptance source is intentionally bounded at 900ms. A
    // cold migrated test DB may cross that bound and log its fail-soft warning;
    // either result is valid here because the state must remain renderable as
    // known OR explicitly degraded, never fail the whole goals.detail query.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
        agents: Array<{ ownerId: string }>;
        goalModeState: {
          schemaVersion: string;
          status: string;
          degradedReasons: string[];
          ownerId: string | null;
          portfolio: { goal: { id: string } } | null;
          obligations: {
            sourceGeneration: string;
            projection: { receipt: { sink: string; entriesOmitted: number } };
            detailRef: string;
          } | null;
        };
      };

      expect(out.agents[0]?.ownerId).toBe('su-mine');
      expect(out.goalModeState).toMatchObject({
        schemaVersion: 'agent-goal-mode-state-v1',
        ownerId: 'su-mine',
        portfolio: { goal: { id: GOAL } },
        obligations: {
          projection: { receipt: { sink: 'turn-start' } },
          detailRef: 'coord:orient for the complete obligation agenda',
        },
      });
      expect(['known', 'degraded']).toContain(out.goalModeState.status);
      expect(out.goalModeState.obligations?.sourceGeneration).toMatch(/^[0-9a-f]{20}$/);
      for (const [message] of warn.mock.calls) {
        expect(message).toMatch(/^\[bounded-timeout\] agent-obligations:[\w:-]+ (?:exceeded \d+ms|failed: .+) — degrading to fallback$/);
        expect(out.goalModeState.status).toBe('degraded');
        expect(out.goalModeState.degradedReasons.length).toBeGreaterThan(0);
      }
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * LAUNCH SETTINGS on the detail payload (goal-mode-hardening P-005).
   *
   * Against real SQL because the whole point of this file: the column is read
   * inside the existing goal SELECT, and a wrong column name throws at RUNTIME
   * ONLY — every mocked test on this path would stay green.
   */
  it('carries the goal’s launch settings, parsed, with the editor’s option lists', async () => {
    const { resolveGoalDetail } = await import('./goals');
    await goal({ launchSettings: { maxAgents: 3, defaults: { model: 'sonnet' } } });

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      launchSettings: { maxAgents?: number; defaults?: { model?: string } } | null;
      launchSettingsInvalid: string | null;
      launchSettingsOptions: { agent?: readonly string[] };
      launchSettingsDefaults: { maxAgents?: number; maxPerFleet?: number } | null;
    };

    expect(out.launchSettings).toEqual({ maxAgents: 3, defaults: { model: 'sonnet' } });
    expect(out.launchSettingsInvalid).toBeNull();
    // Shipped from the schema's own constants so the editor cannot offer a value
    // the write refuses (D-011). Asserted as non-empty rather than by literal
    // membership: the point is that the list ARRIVES, not what is in it today.
    expect(out.launchSettingsOptions.agent?.length).toBeGreaterThan(0);
    // Same reasoning one field over (D-015): the editor says "default 12" only
    // because the server told it 12. If this stops arriving the panel silently
    // reverts to describing a blank ceiling as nothing-in-force — the exact
    // misreading the defaults were added to end. Asserted as PRESENT and
    // positive rather than by value, so tuning the numbers is not a test edit.
    expect(out.launchSettingsDefaults?.maxAgents).toBeGreaterThan(0);
    expect(out.launchSettingsDefaults?.maxPerFleet).toBeGreaterThan(0);
  });

  it('reports an UNREADABLE settings document instead of rendering it as “none”', async () => {
    // The two states look identical on the page and mean opposite things: no
    // settings is a deliberate absence of a ceiling, while an unparseable
    // document means the owner's ceiling is NOT being enforced. Fail-open is
    // correct (see the store's header) — silent fail-open is not.
    const { resolveGoalDetail } = await import('./goals');
    await goal({ launchSettings: { maxAgents: -5 } });

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      launchSettings: unknown;
      launchSettingsInvalid: string | null;
    };

    expect(out.launchSettings).toBeNull();
    expect(out.launchSettingsInvalid).toContain('invalid');
  });

  it('reports no settings as null, which is the launch default and not an error', async () => {
    const { resolveGoalDetail } = await import('./goals');
    await goal();

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      launchSettings: unknown;
      launchSettingsInvalid: string | null;
    };

    expect(out.launchSettings).toBeNull();
    expect(out.launchSettingsInvalid).toBeNull();
  });

  it('counts waiting-on-you UNBOUNDED while capping the rows it returns', async () => {
    // The D-018 defect, pinned against real SQL: the rows are fetched LIMIT 25,
    // and the aggregate used to be `waiting.length` — so a goal with 31 parked
    // items reported 25 here while goals.list (which counts unbounded) reported
    // 31 on the card, with nothing disclosing the cap.
    //
    // Asserted BEHAVIOURALLY, not by field name: rows are bounded, the count is
    // not, and the two disagree by exactly the overflow. Anchoring to the
    // literal 25 as well is deliberate — a silent change to the cap should fail
    // here rather than quietly change what the owner is shown.
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    for (let i = 0; i < 31; i += 1) {
      await workItem(`WI-wait-${String(i).padStart(2, '0')}`, { needsHuman: true });
    }
    // One row that must be counted by NEITHER — same goal, but not parked on the
    // owner. A count that drops the predicate would read 32 and still look sane.
    await workItem('WI-not-waiting');

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      goal: { needsHuman: number } | null;
      waitingOnYou: unknown[];
      waitingOnYouTotal: number;
    };

    expect(out.waitingOnYou).toHaveLength(25);
    expect(out.waitingOnYouTotal).toBe(31);
    // The headline the card also renders — the two surfaces must agree BY
    // CONSTRUCTION, which is the whole point of sourcing both from one predicate.
    expect(out.goal?.needsHuman).toBe(31);
  });

  it('converts the epoch-ms timestamps into something Date can parse', async () => {
    // The columns are bigint epoch-ms but the row mappers hand them to `iso()`,
    // which expects a Date/ISO string — so passing the raw number through would
    // yield a field that looks populated and parses to NaN downstream (every
    // row then silently renders "unknown age").
    const { resolveGoalDetail } = await import('./goals');
    const updated = Date.parse('2026-08-05T09:30:00Z');
    await goal();
    await pot('alpha');
    await closedItem('WI-done', updated);

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      activity: Array<{ closedAt: string | null; updatedAt: string | null }>;
    };
    const row = out.activity[0];

    // `updated_ts` is ours to set, so it is asserted EXACTLY — this is the
    // conversion under test.
    expect(new Date(row.updatedAt as string).getTime()).toBe(updated);

    // `closed_ts` travels the same bigint→timestamp conversion, and the two are
    // asserted to DIFFER so a resolver that mapped one column into both fields
    // could not pass.
    expect(row.closedAt).not.toBeNull();
    expect(new Date(row.closedAt as string).getTime()).toBe(CLOSED_AT);
    expect(row.closedAt).not.toBe(row.updatedAt);
  });

  it('KEEPS a removed project in the payload, carrying removedAt', async () => {
    // The detail view greys these rather than dropping them; the resolver is
    // the other half of that decision, so it is pinned on both sides.
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await pot('alpha');
    await pot('beta', { role: 'contributing', removedAt: new Date().toISOString() });

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      goal: { potCount: number };
      pots: Array<{ harnessSlug: string; removedAt: string | null }>;
    };
    expect(out.pots.map((p) => p.harnessSlug).sort()).toEqual(['alpha', 'beta']);
    expect(out.pots.find((p) => p.harnessSlug === 'beta')?.removedAt).not.toBeNull();
    // ...but a removed project must not inflate the ACTIVE count.
    expect(out.goal.potCount).toBe(1);
  });

  /* ── P-019/D-010: plans, DERIVED through stamped work items ────────────── */
  it('derives plans from the goal’s work items — and never from its pots’ harnesses', async () => {
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await pot('alpha');
    await plan('ship-it', { title: 'Ship it' });
    // A plan in the SAME harness that no goal-stamped item came from. The
    // rejected derivation (every plan in a linked project's harness) would
    // return this one; the adopted one must not.
    await plan('unrelated', { title: 'Unrelated work' });
    await planItem('WI-a', 'ship-it');
    await planItem('WI-b', 'ship-it', { status: 'done', closedTs: CLOSED_AT });
    await workItem('WI-noplan'); // no source_plan_slug ⇒ contributes no plan row

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      plans: Array<{ planSlug: string; title: string | null; items: number; openItems: number }>;
    };

    expect(out.plans.map((p) => p.planSlug)).toEqual(['ship-it']);
    expect(out.plans[0]).toMatchObject({ title: 'Ship it', items: 2, openItems: 1 });
  });

  /* ── 791: the STAMPED leg, unioned with the derived one ─────────────────── */
  it('shows a plan the goal’s agent AUTHORED before any work item has come from it', async () => {
    // The owner-reported bug. Derivation alone cannot see this plan: no work
    // item names it yet, which is the state every goal starts in.
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await plan('authored-here', { title: 'Authored here', goalId: GOAL });

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      plans: Array<{ planSlug: string; items: number; openItems: number; stamped: boolean }>;
    };
    expect(out.plans).toHaveLength(1);
    // Counts stay strictly DERIVED — a truthful zero. `stamped` is what lets the
    // UI say "started by this goal" instead of rendering that zero as failure.
    expect(out.plans[0]).toMatchObject({
      planSlug: 'authored-here',
      items: 0,
      openItems: 0,
      stamped: true,
    });
  });

  it('keeps the DERIVED leg for a plan the goal inherited but never authored', async () => {
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await plan('inherited', { title: 'Inherited' });
    await planItem('WI-a', 'inherited');

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      plans: Array<{ planSlug: string; items: number; stamped: boolean }>;
    };
    expect(out.plans).toHaveLength(1);
    expect(out.plans[0]).toMatchObject({ planSlug: 'inherited', items: 1, stamped: false });
  });

  it('returns a plan that is BOTH stamped and derived exactly ONCE', async () => {
    // The union key is (plan_slug, harness_slug); a plan satisfying both legs
    // must not double-render, and its counts must stay the derived ones.
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await plan('both', { title: 'Both', goalId: GOAL });
    await planItem('WI-a', 'both');
    await planItem('WI-b', 'both', { status: 'done', closedTs: CLOSED_AT });

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      plans: Array<{ planSlug: string; items: number; openItems: number; stamped: boolean }>;
    };
    expect(out.plans).toHaveLength(1);
    expect(out.plans[0]).toMatchObject({
      planSlug: 'both',
      items: 2,
      openItems: 1,
      stamped: true,
    });
  });

  it('does not lend the stamp to ANOTHER goal’s plan', async () => {
    // goal_id is a scoped filter, not a truthiness test — the failure mode is a
    // rail that fills up with every goal's plans and looks busy while lying.
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await plan('other-goals-plan', { title: 'Other', goalId: 'some-other-goal' });

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      plans: Array<{ planSlug: string }>;
    };
    expect(out.plans).toEqual([]);
  });

  it('keeps a plan whose row is GONE, carrying a null title rather than dropping it', async () => {
    // Live work items pointing at a deleted plan is the state worth SEEING —
    // an INNER JOIN here would silently hide it.
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await planItem('WI-orphan', 'deleted-plan');

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      plans: Array<{ planSlug: string; title: string | null; archived: boolean }>;
    };
    expect(out.plans).toHaveLength(1);
    expect(out.plans[0]).toMatchObject({ planSlug: 'deleted-plan', title: null, archived: false });
  });

  it('does not borrow another tenant’s plan row for the title', async () => {
    // The plan join is the one place a wrong scope reads as merely "a nicer
    // label" instead of an error — hence the explicit case.
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await planItem('WI-a', 'ship-it');
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, archived)
      VALUES ('some-other-workspace', 'alpha', 'ship-it', 'OTHER TENANT PLAN', 'ready', false)
    `;

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      plans: Array<{ title: string | null }>;
    };
    expect(out.plans[0]?.title).toBeNull();
  });

  /* ── P-018/D-007: the goal↔agent pairing ───────────────────────────────── */
  it('returns the agent RUNNING this goal, and only that goal', async () => {
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await agentOnGoal('su-mine');
    await agentOnGoal('su-someone-elses', 'a-different-goal');

    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
      agents: Array<{ ownerId: string; setBy: string | null }>;
    };
    expect(out.agents.map((a) => a.ownerId)).toEqual(['su-mine']);
    expect(out.agents[0]?.setBy).toBe('operator-ui');
  });

  it.each(['known', 'degraded', 'unknown'] as const)(
    'surfaces BOTH stamps when two agents claim one goal with %s optional agenda state', async (status) => {
    // D-006 makes one the normal case; two is a coordination fault, and a
    // resolver that returned a scalar would hide it.
    const { resolveGoalDetail } = await import('./goals');
    await goal();
    await agentOnGoal('su-one');
    await agentOnGoal('su-two');
    // This case measures the real agent_modes SQL predicate. Optional agenda
    // providers have their own reader suite and explicit timeout cases above;
    // their cold imports/reads must not decide whether two SQL stamps survive.
    const reader = await import('../agent-obligation-reader');
    const state: Awaited<ReturnType<typeof reader.readAgentGoalModeState>> = {
      schemaVersion: 'agent-goal-mode-state-v1', status, ownerId: 'su-two',
      observedAt: new Date().toISOString(), portfolio: null, obligations: null,
      degradedReasons: status === 'degraded' ? ['fixture optional source unavailable'] : [],
      ...(status === 'unknown' ? { unknown: { code: 'goal-mode-state-read-failed',
        detail: 'fixture optional source unavailable', retry: 'refresh goals.detail' } } : {}),
    };
    const optional = vi.spyOn(reader, 'readAgentGoalModeState').mockResolvedValue(state);
    try {
      const out = (await resolveGoalDetail({ workspaceId: WS, goalId: GOAL })) as {
        agents: Array<{ ownerId: string }>; goalModeState: typeof state;
      };
      expect(out.agents.map((a) => a.ownerId).sort()).toEqual(['su-one', 'su-two']);
      expect(optional).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        workspaceId: WS, goalId: GOAL, ownerId: out.agents[0]?.ownerId,
      }));
      expect(out.goalModeState).toEqual(state);
    } finally {
      optional.mockRestore();
    }
  });

  it('the LIST carries the same agents as the detail, so the HUD Goals tab can filter by agent id', async () => {
    // hud-unified-search-filter-2026-08-10 P-006. The board and the popup must
    // answer "who is on this goal" identically — they read the same
    // agent_modes predicate, and this is what stops them drifting apart.
    // Two agents again, for the same reason the detail test uses two: a
    // resolver that collapsed to a scalar would hide the coordination fault.
    const { resolveGoalsList } = await import('./goals');
    await goal();
    await agentOnGoal('su-one');
    await agentOnGoal('su-two');

    const out = (await resolveGoalsList({ workspaceId: WS })) as {
      goals: Array<{ id: string; agents: Array<{ ownerId: string }> }>;
    };
    const row = out.goals.find((g) => g.id === GOAL);
    expect(row).toBeDefined();
    expect(row!.agents.map((a) => a.ownerId).sort()).toEqual(['su-one', 'su-two']);
  });

  it('a goal with NO agent gets an empty list, never null — the board maps over it', async () => {
    // The subselect COALESCEs to '[]'. If that ever regressed to SQL NULL the
    // Goals tab would throw on `.map` and take the whole board down over a
    // filter, so the empty case is pinned separately from the populated one.
    const { resolveGoalsList } = await import('./goals');
    await goal();

    const out = (await resolveGoalsList({ workspaceId: WS })) as {
      goals: Array<{ id: string; agents: Array<{ ownerId: string }> }>;
    };
    const row = out.goals.find((g) => g.id === GOAL);
    expect(row!.agents).toEqual([]);
  });

  it('returns { goal: null } for a goal that does not exist', async () => {
    const { resolveGoalDetail } = await import('./goals');
    const out = (await resolveGoalDetail({ workspaceId: WS, goalId: 'nope' })) as { goal: null };
    expect(out.goal).toBeNull();
  });

  it('scopes to the workspace it was asked for', async () => {
    const { resolveGoalsList } = await import('./goals');
    await goal();
    const other = await resolveGoalsList({ workspaceId: 'some-other-workspace' });
    expect(other.goals).toHaveLength(0);
  });
});
