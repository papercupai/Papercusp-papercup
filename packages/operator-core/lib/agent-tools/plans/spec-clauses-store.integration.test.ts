/** P-002 real-Postgres coverage for canonical plan spec revisions and tools. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { RECORDED_TEST_LAYERS } from '@papercusp/test-config/execution-details';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import type { SpecClauseBarPin, SpecClauseRevision, SpecClauseSql, SpecClauseWrite } from './spec-clauses-store';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: postgres.Sql) => Promise<T>) =>
      h.sql.begin(async (tx) => fn(tx as unknown as postgres.Sql)),
  };
});

const WORKSPACE = 'ws-spec-test';
const HARNESS = 'web';
vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return {
    ...actual,
    resolvePlanScope: async (opts: { harnessSlug?: string } = {}) => ({
      workspaceId: WORKSPACE,
      harnessSlug: opts.harnessSlug?.trim() || HARNESS,
    }),
  };
});

const store = await import('./spec-clauses-store');
const setSpecsTool = (await import('./set-specs')).default;
const getSpecsTool = (await import('./get-specs')).default;

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_851 = path.resolve(
  here,
  '../../../../../libs/papercusp/libs/db/sql/851-first-class-plan-spec-clauses.sql',
);
const MIGRATION_852 = path.resolve(
  here,
  '../../../../../libs/papercusp/libs/db/sql/852-plan-spec-clause-integrity.sql',
);
const MIGRATION_929 = path.resolve(here, '../../../../../libs/papercusp/libs/db/sql/929-spec-clause-falsifier.sql');
const MIGRATION_930 = path.resolve(
  here,
  '../../../../../libs/papercusp/libs/db/sql/930-spec-clause-falsifier-null-safe.sql',
);
const MIGRATION_1111 = path.resolve(
  here,
  '../../../../../libs/papercusp/libs/db/sql/1111-acceptance-bar-contract-seed.sql',
);
const sqlMigration = (file: string) => path.resolve(here, `../../../../../libs/papercusp/libs/db/sql/${file}`);
const MIGRATION_855 = sqlMigration('855-work-item-spec-evidence-bindings.sql');
const MIGRATION_1174 = sqlMigration('1174-spec-evidence-binding-retraction.sql');
const MIGRATION_1175 = sqlMigration('1175-spec-evidence-dedup-partial-on-live.sql');
const MIGRATION_1176 = sqlMigration('1176-spec-evidence-drop-total-dedup-contract-phase.sql');
const CTX = {
  isSuperuser: true,
  uiClientId: 'su-spec-integration',
  workspaceId: WORKSPACE,
  harnessSlug: HARNESS,
} as never;

let db: FreshPgDb;

function clause(over: Partial<SpecClauseWrite> = {}): SpecClauseWrite {
  return {
    harnessSlug: HARNESS,
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    expectedRevision: 0,
    sourceValId: 'VAL-003-01',
    planItemId: 'P-003',
    behavior: 'Acknowledged event 42 is not replayed after reconnect.',
    behaviorClass: 'concurrency',
    requiredEvidence: ['integration replay trace', 'boundary counterexample'],
    requiredTestLayers: ['integration'],
    mutationRequired: true,
    lifecycleStatus: 'active',
    acceptanceRef: 'D-003',
    actorId: 'su-spec-integration',
    ...over,
  };
}

const BAR_PIN: SpecClauseBarPin = {
  barKey: 'R-1',
  barHash: 'a'.repeat(64),
  barSetHash: 'b'.repeat(64),
  rubricSlug: 'acceptance-reconnect-plan',
  rubricRevision: 4,
  evidencePlane: 'tree',
};
const BAR_ACCEPTANCE_REF = 'acceptance-reconnect-plan@4:R-1';

async function barKeyAt(specId: string, revision: number): Promise<string | null> {
  const [row] = await db.sql<{ source_bar_key: string | null }[]>`
    SELECT source_bar_key FROM harness_shared.plan_spec_clause_revisions
     WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
       AND plan_slug = 'reconnect-plan' AND spec_id = ${specId} AND revision = ${revision}`;
  // An ABSENT row and a CLEARED pin both read as null, and this helper exists to tell
  // a carried-forward pin from a destroyed one — so refuse the ambiguity rather than
  // let a missing revision pass for an unlinked one.
  if (!row) throw new Error(`no ${specId} revision ${revision}`);
  return row.source_bar_key;
}

beforeAll(async () => {
  db = await createFreshPgDb('plan-spec-clauses');
  h.sql = db.sql;
  await db.sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin; END IF;
  END $$;`);
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      content text NOT NULL DEFAULT '',
      content_hash text NOT NULL DEFAULT '',
      template text,
      verification_profile text,
      verification_profile_source text,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.plan_revisions (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      seq integer NOT NULL,
      content_hash text NOT NULL,
      content_snapshot text NOT NULL,
      rationale text,
      author_kind text NOT NULL,
      author_id text NOT NULL,
      session_id text,
      session_kind text,
      created_at bigint NOT NULL,
      UNIQUE (workspace_id, harness_slug, plan_slug, seq)
    );
    CREATE TABLE harness_shared.plan_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      item_id text NOT NULL,
      seq integer NOT NULL DEFAULT 0,
      owner_gate_marker text,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id),
      FOREIGN KEY (workspace_id, harness_slug, plan_slug)
        REFERENCES harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.harness_plan_assertions (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      val_id text NOT NULL,
      plan_slug text NOT NULL,
      item_id text NOT NULL,
      verify_text text NOT NULL,
      evidence_text text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'todo',
      requires_test boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug, val_id)
    );
    -- work_items is the FK target of 855's work_item_spec_revision_edges. setSpecClause
    -- writes edges on a lifecycle-only revision (WI-10002889), so this fixture must carry
    -- the evidence tables; a fixture one table behind the real schema is EI-21270668928342264.
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      source_plan_slug text,
      source_plan_item_ids text[] NOT NULL DEFAULT '{}',
      status text NOT NULL DEFAULT 'open',
      taken_by text,
      payload jsonb NOT NULL DEFAULT '{}',
      admission text, admitted_at timestamptz, admitted_by text,
      PRIMARY KEY (harness_slug, feature_id)
    );
  `);
  await db.sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  await applyMigrationForTest(db.sql, sqlMigration('1107-plan-revisions-content-snapshot-hash.sql'));
  await applyMigrationForTest(db.sql, MIGRATION_851);
  await applyMigrationForTest(db.sql, MIGRATION_852);
  // Idempotency is part of the migration contract, not just a comment.
  await applyMigrationForTest(db.sql, MIGRATION_852);
  await applyMigrationForTest(db.sql, MIGRATION_929);
  // 929 drops-then-adds its own CHECK precisely so it is re-runnable; prove that.
  await applyMigrationForTest(db.sql, MIGRATION_929);
  await applyMigrationForTest(db.sql, MIGRATION_930);
  await applyMigrationForTest(db.sql, MIGRATION_930);
  await applyMigrationForTest(db.sql, MIGRATION_1111);
  await applyMigrationForTest(db.sql, MIGRATION_1111);
  // Evidence tables (edges + bindings + the retraction columns the carry filters on).
  await applyMigrationForTest(db.sql, MIGRATION_855);
  await applyMigrationForTest(db.sql, MIGRATION_1174);
  await applyMigrationForTest(db.sql, MIGRATION_1175);
  await applyMigrationForTest(db.sql, MIGRATION_1176);
  await applyMigrationForTest(db.sql, sqlMigration('1445-spec-evidence-independent-verification.sql'));
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE
    harness_shared.plan_spec_clause_revisions,
    harness_shared.plan_spec_clauses,
    harness_shared.harness_plan_assertions,
    harness_shared.plan_items,
    harness_shared.harness_plans CASCADE`;
  await db.sql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
    VALUES (${WORKSPACE}, ${HARNESS}, 'reconnect-plan')`;
  await db.sql`
    INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id)
    VALUES (${WORKSPACE}, ${HARNESS}, 'reconnect-plan', 'P-003'),
           (${WORKSPACE}, ${HARNESS}, 'reconnect-plan', 'P-004')`;
});

describe('first-class plan spec clauses', () => {
  it('replays the historical current set after revision and identity additions without using live pointers', async () => {
    await store.setSpecClause(clause());
    const [cutoff] = await db.sql<{ at: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;
    await store.setSpecClause(clause({ expectedRevision: 1, behavior: 'Revised behavior' }));
    await store.setSpecClause(clause({ specId: 'SPEC-004-01', sourceValId: 'VAL-004-01', planItemId: 'P-004' }));
    const selected = await store.listSpecClauses({ harnessSlug: HARNESS, planSlug: 'reconnect-plan', asOf: cutoff!.at });
    expect(selected.map((row) => [row.specId, row.revision, row.currentRevision, row.behavior])).toEqual([
      ['SPEC-003-01', 1, 1, clause().behavior],
    ]);
    const live = await store.listSpecClauses({ harnessSlug: HARNESS, planSlug: 'reconnect-plan' });
    expect(live.map((row) => [row.specId, row.revision])).toEqual([['SPEC-003-01', 2], ['SPEC-004-01', 1]]);
    const tool = await getSpecsTool.handler(getSpecsTool.args.parse({ harness: HARNESS, slug: 'reconnect-plan', asOf: cutoff!.at }), CTX);
    expect(tool).toMatchObject({ data: { mode: 'snapshot', count: 1, specs: [{ revision: 1, currentRevision: 1 }] } });
    await expect(store.listSpecClauses({ harnessSlug: HARNESS, planSlug: 'reconnect-plan', asOf: cutoff!.at, revision: 1 })).rejects.toThrow('spec_snapshot_selector_invalid');
    expect(getSpecsTool.args.safeParse({ slug: 'reconnect-plan', asOf: cutoff!.at, includeHistory: true }).success).toBe(false);
  });

  it('does not expose an accepted revision before its acceptance timestamp in an as-of read', async () => {
    await store.setSpecClause(clause({ lifecycleStatus: 'draft', acceptanceRef: null }));
    const [cutoff] = await db.sql<{ at: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;
    await db.sql`
      INSERT INTO harness_shared.plan_spec_clause_revisions (
        workspace_id, harness_slug, plan_slug, spec_id, revision, plan_item_id,
        behavior, behavior_class, lifecycle_status, content_hash, created_by, created_at,
        accepted_by, accepted_at, acceptance_ref
      ) VALUES (
        ${WORKSPACE}, ${HARNESS}, 'reconnect-plan', 'SPEC-003-01', 2, 'P-003',
        'Accepted revision whose acceptance occurs after the replay cutoff.', 'concurrency',
        'active', ${'f'.repeat(64)}, 'reviewer',
        ${cutoff!.at}::timestamptz - INTERVAL '1 millisecond',
        'reviewer', ${cutoff!.at}::timestamptz + INTERVAL '1 millisecond', 'D-003'
      )`;
    await db.sql`
      UPDATE harness_shared.plan_spec_clauses SET current_revision = 2
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01'`;

    const selected = await store.listSpecClauses({ harnessSlug: HARNESS, planSlug: 'reconnect-plan', asOf: cutoff!.at });
    expect(selected).toMatchObject([{
      specId: 'SPEC-003-01',
      revision: 1,
      lifecycleStatus: 'draft',
      acceptedAt: null,
    }]);
  });

  it('reads a bounded current clause from the shared ad-hoc scope through plans:get-specs', async () => {
    const specId = 'WI-10007428:quota-recovery-operation-diagnostics';
    const planItemId = 'P-10007428';
    const behavior = 'The ad-hoc work item clause is returned by its exact current read.';
    await store.setSpecClause(clause({
      planSlug: undefined,
      specId,
      sourceValId: null,
      planItemId,
      behavior,
    }));

    const result = (await getSpecsTool.handler(
      getSpecsTool.args.parse({
        harness: HARNESS,
        slug: 'adhoc-work-item-specs',
        specIds: [specId],
        planItemIds: [planItemId],
      }),
      CTX,
    )) as { data: { count: number; mode: string; specs: SpecClauseRevision[] } };

    expect(result.data).toMatchObject({
      count: 1,
      mode: 'current',
      specs: [{ planSlug: 'adhoc-work-item-specs', specId, planItemId, revision: 1, behavior }],
    });
  });

  it('resolves an immutable plan snapshot by exact body hash within the requested scope', async () => {
    await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.plan_revisions (
      id bigserial, workspace_id text, harness_slug text, plan_slug text,
      seq integer, content_hash text, content_snapshot text
    )`;
    const { hashPlanContent } = await import('./content-hash');
    const { getPlanRevisionSnapshot } = await import('./revisions');
    const body = '---\ntitle: Historical fixture\n---\n## Items\n- **P-003** `todo` Contract';
    const hash = hashPlanContent(body);
    await db.sql`DELETE FROM harness_shared.plan_revisions`;
    await db.sql`INSERT INTO harness_shared.plan_revisions (
        workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot, author_kind, author_id, created_at
      ) VALUES (${WORKSPACE}, ${HARNESS}, 'reconnect-plan', 7, ${hash}, ${body}, 'test', 'fixture', 0),
               (${WORKSPACE}, 'other', 'reconnect-plan', 9, ${hash}, 'wrong scope', 'test', 'fixture', 0)`;
    expect(await getPlanRevisionSnapshot('reconnect-plan', hash, { harnessSlug: HARNESS })).toMatchObject({ seq: 7, contentSnapshot: body, contentSnapshotHash: hash });
    expect(await getPlanRevisionSnapshot('reconnect-plan', 'f'.repeat(64), { harnessSlug: HARNESS })).toBeNull();
    expect(await getPlanRevisionSnapshot('reconnect-plan', 7, { harnessSlug: HARNESS })).toMatchObject({ contentSnapshot: body });
  });

  it('finds the exact body behind newer same-hash receipts without changing enriched revision reads', async () => {
    const { hashPlanContent } = await import('./content-hash');
    const { getPlanRevisionSnapshot } = await import('./revisions');
    const body = '---\ntitle: Exact quality body\n---\n## Items\n- **P-003** `todo` Contract';
    const hash = hashPlanContent(body);
    const receipt = JSON.stringify({ body, execution: { started: true } });
    await db.sql`DELETE FROM harness_shared.plan_revisions`;
    await db.sql`INSERT INTO harness_shared.plan_revisions (
        workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot, author_kind, author_id, created_at
      ) VALUES (${WORKSPACE}, ${HARNESS}, 'reconnect-plan', 7, ${hash}, ${body}, 'test', 'fixture', 0),
               (${WORKSPACE}, ${HARNESS}, 'reconnect-plan', 8, ${hash}, ${receipt}, 'test', 'fixture', 0),
               (${WORKSPACE}, 'other', 'reconnect-plan', 9, ${hash}, ${body}, 'test', 'fixture', 0)`;

    expect(await getPlanRevisionSnapshot('reconnect-plan', hash, { harnessSlug: HARNESS }))
      .toMatchObject({ seq: 8, contentSnapshot: receipt });
    expect(await getPlanRevisionSnapshot('reconnect-plan', 8, { harnessSlug: HARNESS }))
      .toMatchObject({ seq: 8, contentSnapshot: receipt });
    expect(await getPlanRevisionSnapshot('reconnect-plan', hash, { harnessSlug: HARNESS, exactBody: true }))
      .toMatchObject({ seq: 7, contentSnapshot: body, contentSnapshotHash: hash });
    expect(await getPlanRevisionSnapshot('reconnect-plan', 8, { harnessSlug: HARNESS, exactBody: true })).toBeNull();

    await db.sql`DELETE FROM harness_shared.plan_revisions WHERE harness_slug = ${HARNESS} AND seq = 7`;
    expect(await getPlanRevisionSnapshot('reconnect-plan', hash, { harnessSlug: HARNESS, exactBody: true })).toBeNull();
  });

  it('exposes create/current/history through the structured tools and never writes the retired VAL store (P-003)', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_plan_assertions (
        workspace_id, harness_slug, val_id, plan_slug, item_id,
        verify_text, evidence_text, status, requires_test
      ) VALUES (${WORKSPACE}, ${HARNESS}, 'VAL-003-01', 'reconnect-plan', 'P-003',
                'old behavior', 'old evidence', 'passed', true)`;

    const set = (await setSpecsTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        spec: {
          specId: 'SPEC-003-01',
          expectedRevision: 0,
          sourceValId: 'VAL-003-01',
          planItemId: 'P-003',
          behavior: 'Acknowledged event 42 is not replayed after reconnect.',
          behaviorClass: 'concurrency',
          requiredEvidence: ['boundary counterexample', 'integration replay trace'],
          requiredTestLayers: ['integration'],
          mutationRequired: true,
          lifecycleStatus: 'active',
          acceptanceRef: 'D-003',
        },
      } as never,
      CTX,
    )) as { data: { results: Array<Record<string, unknown>> } };
    expect(set.data.results[0]).toMatchObject({ ok: true, status: 'created', revision: 1 });

    const get = (await getSpecsTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        includeHistory: true,
      } as never,
      CTX,
    )) as { data: { specs: SpecClauseRevision[] } };
    expect(get.data.specs).toHaveLength(1);
    expect(get.data.specs[0]).toMatchObject({
      specId: 'SPEC-003-01',
      sourceValId: 'VAL-003-01',
      revision: 1,
      currentRevision: 1,
      acceptedBy: 'su-spec-integration',
    });
    const legacy = await db.sql<{ status: string; verify_text: string }[]>`
      SELECT status, verify_text FROM harness_shared.harness_plan_assertions
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND val_id = 'VAL-003-01'`;
    // The retired store is neither mirrored nor overwritten: the legacy row is untouched.
    expect(legacy[0]).toEqual({
      status: 'passed',
      verify_text: 'old behavior',
    });
  });

  it('promotes an AUTO-BAR draft without dropping its acceptance provenance pin', async () => {
    const sourceBar = {
      barKey: 'R-1',
      barHash: 'a'.repeat(64),
      barSetHash: 'b'.repeat(64),
      rubricSlug: 'acceptance-reconnect-plan',
      rubricRevision: 4,
      evidencePlane: 'tree' as const,
    };
    const acceptanceRef = 'acceptance-reconnect-plan@4:R-1';
    expect(await store.setSpecClause(clause({ lifecycleStatus: 'draft', acceptanceRef, sourceBar }))).toMatchObject({
      status: 'created',
      revision: 1,
    });

    const parsed = setSpecsTool.args.parse({
      harness: HARNESS,
      slug: 'reconnect-plan',
      spec: {
        specId: 'SPEC-003-01',
        expectedRevision: 1,
        sourceValId: 'VAL-003-01',
        planItemId: 'P-003',
        behavior: 'Acknowledged event 42 is not replayed after reconnect.',
        behaviorClass: 'concurrency',
        requiredEvidence: ['integration replay trace', 'boundary counterexample'],
        requiredTestLayers: ['integration'],
        mutationRequired: true,
        lifecycleStatus: 'active',
        acceptanceRef,
        sourceBar,
      },
    });
    const promoted = (await setSpecsTool.handler(parsed as never, CTX)) as {
      data: { results: Array<Record<string, unknown>> };
    };
    expect(promoted.data.results[0]).toMatchObject({ ok: true, status: 'revised', revision: 2 });

    const [current] = await store.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specIds: ['SPEC-003-01'],
    });
    expect(current).toMatchObject({
      revision: 2,
      currentRevision: 2,
      lifecycleStatus: 'active',
      acceptedBy: 'su-spec-integration',
      acceptanceRef,
      sourceBar,
    });
  });

  it('refuses direct behavior edits to a sourceBar-pinned clause and names the canonical rubric edit point', async () => {
    const specId = 'AUTO-BAR-R-1-P-003';
    const acceptanceRef = `acceptance-reconnect-plan@${BAR_PIN.rubricRevision}:${BAR_PIN.barKey}`;
    const originalBehavior = 'Acknowledged event 42 is not replayed after reconnect.';
    expect(
      await store.setSpecClause(
        clause({ specId, behavior: originalBehavior, lifecycleStatus: 'active', acceptanceRef, sourceBar: BAR_PIN }),
      ),
    ).toMatchObject({ status: 'created', revision: 1 });

    const refused = (await setSpecsTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        spec: {
          specId,
          expectedRevision: 1,
          sourceValId: 'VAL-003-01',
          planItemId: 'P-003',
          behavior: 'The direct clause repair must not survive a rubric re-projection.',
          behaviorClass: 'concurrency',
          requiredEvidence: ['integration replay trace', 'boundary counterexample'],
          requiredTestLayers: ['integration'],
          mutationRequired: true,
          lifecycleStatus: 'active',
          acceptanceRef,
        },
      } as never,
      CTX,
    )) as { data: { results: Array<Record<string, unknown>> } };

    expect(refused.data.results[0]).toMatchObject({
      ok: false,
      error: 'projected_behavior_readonly',
      reason: expect.stringContaining('rubrics:amend'),
    });
    expect(refused.data.results[0]?.reason).toContain('criterion.model');
    expect(refused.data.results[0]?.reason).toContain('AUTO-BAR-R-1-P-003');

    const [current] = await store.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specIds: [specId],
    });
    expect(current).toMatchObject({ revision: 1, behavior: originalBehavior, sourceBar: BAR_PIN });
  });

  it('carries a prior BAR pin forward when a later revision omits sourceBar', async () => {
    expect(
      await store.setSpecClause(
        clause({ lifecycleStatus: 'draft', acceptanceRef: BAR_ACCEPTANCE_REF, sourceBar: BAR_PIN }),
      ),
    ).toMatchObject({ status: 'created', revision: 1 });

    // The regression: `sourceBar` is immutable provenance, so OMITTING it must ride the
    // prior pin forward. Landing NULL here is silent lineage loss — `acceptanceRef`
    // survives (the caller passes it), so the clause still READS as bar-linked while
    // `source_bar_key`, the column acceptance-bar amendment joins on, is gone.
    expect(
      await store.setSpecClause(
        clause({ expectedRevision: 1, lifecycleStatus: 'active', acceptanceRef: BAR_ACCEPTANCE_REF }),
      ),
    ).toMatchObject({ status: 'revised', revision: 2 });

    const [current] = await store.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specIds: ['SPEC-003-01'],
    });
    expect(current).toMatchObject({ revision: 2, lifecycleStatus: 'active', sourceBar: BAR_PIN });
    expect(await barKeyAt('SPEC-003-01', 2)).toBe('R-1');
  });

  it('refuses to unlink an AUTO-BAR projection with an explicit null pin', async () => {
    const specId = 'AUTO-BAR-R-1-P-003';
    expect(
      await store.setSpecClause(
        clause({ specId, lifecycleStatus: 'draft', acceptanceRef: BAR_ACCEPTANCE_REF, sourceBar: BAR_PIN }),
      ),
    ).toMatchObject({ status: 'created', revision: 1 });

    expect(
      await store.setSpecClause(
        clause({
          specId,
          expectedRevision: 1,
          lifecycleStatus: 'active',
          acceptanceRef: BAR_ACCEPTANCE_REF,
          sourceBar: null,
        }),
      ),
    ).toMatchObject({ status: 'bar_pin_invalid', reason: 'bar_pin_unlink_forbidden' });

    // The refusal must leave revision 1 intact rather than half-applying the unlink.
    expect(await barKeyAt(specId, 1)).toBe('R-1');
  });

  it('allows an explicit null pin when the AUTO-BAR projection is superseded', async () => {
    const specId = 'AUTO-BAR-R-1-P-003';
    expect(
      await store.setSpecClause(
        clause({ specId, lifecycleStatus: 'draft', acceptanceRef: BAR_ACCEPTANCE_REF, sourceBar: BAR_PIN }),
      ),
    ).toMatchObject({ status: 'created', revision: 1 });

    expect(
      await store.setSpecClause(
        clause({
          specId,
          expectedRevision: 1,
          lifecycleStatus: 'superseded',
          acceptanceRef: BAR_ACCEPTANCE_REF,
          sourceBar: null,
        }),
      ),
    ).toMatchObject({ status: 'revised', revision: 2 });

    expect(await barKeyAt(specId, 2)).toBeNull();
  });

  it('normalizes production-shaped Postgres text timestamps at the spec-store boundary', async () => {
    const priorSql = h.sql;
    const fakeTx = vi.fn(async () => [
      {
        plan_slug: 'reconnect-plan',
        spec_id: 'SPEC-003-01',
        source_val_id: 'VAL-003-01',
        current_revision: 1,
        revision: 1,
        plan_item_id: 'P-003',
        behavior: 'Acknowledged event 42 is not replayed after reconnect.',
        behavior_class: 'concurrency',
        required_evidence: ['integration replay trace'],
        required_test_layers: ['integration'],
        mutation_required: true,
        lifecycle_status: 'active',
        supersedes_spec_id: null,
        supersedes_revision: null,
        exemption: null,
        content_hash: 'sha256:spec-v1',
        created_by: 'su-spec-integration',
        created_at: '2026-08-20 11:59:00.123456-04',
        accepted_by: 'su-spec-integration',
        accepted_at: '2026-08-20 12:00:00-04',
        acceptance_ref: 'D-003',
      },
    ]) as unknown as postgres.Sql;
    h.sql = {
      begin: async <T>(fn: (tx: postgres.Sql) => Promise<T>) => fn(fakeTx),
    } as unknown as postgres.Sql;

    try {
      const rows = await store.listSpecClauses({
        harnessSlug: HARNESS,
        planSlug: 'reconnect-plan',
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.createdAt).toBe('2026-08-20T15:59:00.123Z');
      expect(rows[0]?.acceptedAt).toBe('2026-08-20T16:00:00.000Z');
    } finally {
      h.sql = priorSql;
    }
  });

  it('supports deterministic no-op, revision append, exact reads, and one-winner concurrent CAS', async () => {
    const first = clause();
    expect(await store.setSpecClause(first)).toMatchObject({ status: 'created', revision: 1 });
    expect(await store.setSpecClause({ ...first, expectedRevision: 1 })).toMatchObject({
      status: 'unchanged',
      revision: 1,
    });

    // Pin both competing transactions to the private fixture. Concurrent dynamic
    // module resolution must never send either write through the live registry.
    const race = await Promise.all(['Variant A', 'Variant B'].map(behavior =>
      db.sql.begin(tx => store.setSpecClause({ ...first, expectedRevision: 1, behavior }, {
        workspaceId: WORKSPACE, harnessSlug: HARNESS,
        executor: tx as unknown as SpecClauseSql,
      })),
    ));
    expect(race.filter((r) => r.status === 'revised')).toHaveLength(1);
    expect(race.filter((r) => r.status === 'conflict')).toHaveLength(1);

    const history = await store.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      includeHistory: true,
    });
    expect(history.map((r) => r.revision)).toEqual([1, 2]);
    const exact = await store.listSpecClauses({ harnessSlug: HARNESS, planSlug: 'reconnect-plan', revision: 1 });
    expect(exact).toHaveLength(1);
    expect(exact[0]?.behavior).toBe(first.behavior);
  });

  it('returns structured ownership, supersession, alias, and immutable-alias conflicts', async () => {
    expect(await store.setSpecClause(clause({ planSlug: 'missing-plan' }))).toMatchObject({ status: 'plan_not_found' });
    expect(await store.setSpecClause(clause({ planItemId: 'P-999' }))).toMatchObject({ status: 'plan_item_not_found' });
    expect(await store.setSpecClause(clause({ supersedes: { specId: 'SPEC-missing', revision: 1 } }))).toMatchObject({
      status: 'supersedes_not_found',
    });

    expect(await store.setSpecClause(clause())).toMatchObject({ status: 'created' });
    expect(await store.setSpecClause(clause({ specId: 'SPEC-003-02', sourceValId: 'VAL-003-01' }))).toMatchObject({
      status: 'source_alias_conflict',
      conflictingSpecId: 'SPEC-003-01',
    });
    expect(await store.setSpecClause(clause({ expectedRevision: 1, sourceValId: 'VAL-other' }))).toMatchObject({
      status: 'source_alias_immutable',
      sourceValId: 'VAL-003-01',
    });
  });

  it('persists exemption/acceptance provenance and rejects revision mutation or a dangling current pointer', async () => {
    expect(
      await store.setSpecClause(
        clause({
          specId: 'SPEC-003-EX',
          sourceValId: null,
          lifecycleStatus: 'exempt',
          exemption: { authority: 'D-004', rationale: 'manual copy review', scope: ['copy'] },
          acceptanceRef: 'D-004',
        }),
      ),
    ).toMatchObject({ status: 'created' });
    const [exempt] = await store.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specIds: ['SPEC-003-EX'],
    });
    expect(exempt).toMatchObject({
      lifecycleStatus: 'exempt',
      acceptedBy: null,
      exemption: { authority: 'D-004', rationale: 'manual copy review', scope: ['copy'] },
    });

    await expect(db.sql`
      UPDATE harness_shared.plan_spec_clause_revisions SET behavior = 'mutated'
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-EX' AND revision = 1`).rejects.toThrow(/immutable/);
    await expect(db.sql`
      DELETE FROM harness_shared.plan_spec_clause_revisions
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-EX' AND revision = 1`).rejects.toThrow(/immutable/);
    await expect(db.sql`
      UPDATE harness_shared.plan_spec_clauses SET current_revision = 99
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-EX'`).rejects.toThrow(/foreign key/);
  });

  it('has the fully validated integrity constraints after an idempotent migration replay', async () => {
    const constraints = await db.sql<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated
        FROM pg_constraint
       WHERE conname IN (
         'plan_spec_clauses_plan_fk',
         'plan_spec_clauses_current_revision_fk',
         'plan_spec_clause_revisions_supersedes_fk',
         'plan_spec_clause_revisions_exemption_exact',
         'plan_spec_clause_revisions_acceptance_exact'
       ) ORDER BY conname`;
    expect(constraints).toHaveLength(5);
    expect(constraints.every((c) => c.convalidated)).toBe(true);
  });
});

/**
 * D-016 (migration 929): every contract clause declares what would FALSIFY it.
 *
 * The load-bearing design choices under test, each stated as the property that
 * would break if the choice were reverted:
 *  - the falsifier is COVERED by content_hash, so revising one appends a new
 *    immutable revision instead of mutating a standing promise in place;
 *  - an UNDECLARED falsifier is absent from the canonical form, not `null`, so
 *    adding the field did not re-hash every clause written before D-016;
 *  - a MALFORMED declaration is refused structurally rather than silently
 *    dropped — a caller must never believe they declared what the row does not say.
 */
describe('WI-6554700010017412 recorded layer declarations', () => {
  it.each(['concurrency', 'performance', 'failure-injection', 'recovery', 'rendered', 'user-journey'])(
    'refuses %s at the common writer, including the existing-transaction route',
    async (layer) => {
      const input = clause({ requiredTestLayers: ['integration', layer] });
      const executor = vi.fn(() => { throw new Error('invalid declaration reached SQL'); });
      const refusal = { status: 'test_layers_invalid', specId: input.specId, invalidTestLayers: [layer] };
      expect(await store.setSpecClause(input)).toEqual(refusal);
      expect(await store.setSpecClause(input, { executor, workspaceId: WORKSPACE, harnessSlug: HARNESS })).toEqual(refusal);
      expect(executor).not.toHaveBeenCalled();
      expect(await store.listSpecClauses({ harnessSlug: HARNESS, planSlug: 'reconnect-plan' })).toEqual([]);
    },
  );

  it('round-trips all recordable layers through the public reader and writer without losing proof obligations', async () => {
    const input = clause({
      requiredTestLayers: [...RECORDED_TEST_LAYERS],
      falsifier: { observation: 'An acknowledged event is delivered twice.', requiredScenarios: ['concurrent-reconnect', 'cancellation'] },
    });
    expect(await store.setSpecClause(input)).toMatchObject({ status: 'created', revision: 1 });
    const get = await getSpecsTool.handler(
      getSpecsTool.args.parse({ harness: HARNESS, slug: 'reconnect-plan', specIds: [input.specId] }), CTX,
    ) as { data: { specs: SpecClauseRevision[] } };
    const [row] = get.data.specs;
    const write = setSpecsTool.args.parse({ harness: HARNESS, slug: 'reconnect-plan', spec: {
      specId: row.specId, expectedRevision: row.revision, sourceValId: row.sourceValId,
      planItemId: row.planItemId, behavior: row.behavior, behaviorClass: row.behaviorClass,
      requiredEvidence: row.requiredEvidence, requiredTestLayers: row.requiredTestLayers,
      mutationRequired: row.mutationRequired, lifecycleStatus: row.lifecycleStatus,
      supersedes: row.supersedes, exemption: row.exemption, falsifier: row.falsifier,
      acceptanceRef: row.acceptanceRef, sourceBar: row.sourceBar,
    } });
    const set = await setSpecsTool.handler(write, CTX) as { data: { results: Array<Record<string, unknown>> } };
    expect(set.data.results[0]).toMatchObject({ ok: true, status: 'unchanged', revision: 1 });
    expect(row.requiredTestLayers).toEqual([...RECORDED_TEST_LAYERS].sort());
    expect(row.falsifier?.requiredScenarios).toEqual(['cancellation', 'concurrent-reconnect']);
    expect(row.requiredEvidence).toEqual([...input.requiredEvidence!].sort());
    expect(row.mutationRequired).toBe(true);
  });
});

describe('D-016 clause falsifier', () => {
  const withFalsifier = (over: Partial<SpecClauseWrite> = {}) =>
    clause({
      specId: 'SPEC-003-F',
      sourceValId: null,
      falsifier: {
        observation: 'Event 42 appears a second time in the post-reconnect replay trace.',
        probeMethod: 'Reconnect after acking 42 and diff the delivered ids against the acked set.',
        requiredScenarios: ['wrong-subject-exclusion', 'stale-vs-decision'],
        causalPairing: 'one-to-one',
      },
      ...over,
    });

  it('round-trips a declared falsifier through the store and the plans:get-specs read', async () => {
    expect(await store.setSpecClause(withFalsifier())).toMatchObject({ status: 'created', revision: 1 });

    const [row] = await store.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specIds: ['SPEC-003-F'],
    });
    expect(row.falsifier).toEqual({
      observation: 'Event 42 appears a second time in the post-reconnect replay trace.',
      probeMethod: 'Reconnect after acking 42 and diff the delivered ids against the acked set.',
      requiredScenarios: ['stale-vs-decision', 'wrong-subject-exclusion'],
      causalPairing: 'one-to-one',
    });

    // The read tool surfaces it too — a field only the store can see is not a contract.
    const get = (await getSpecsTool.handler(
      { harness: HARNESS, slug: 'reconnect-plan', specIds: ['SPEC-003-F'] } as never,
      CTX,
    )) as { data: { specs: SpecClauseRevision[] } };
    expect(get.data.specs[0]?.falsifier?.observation).toContain('appears a second time');
  });

  it('accepts a falsifier through plans:set-specs — the write tool, not just the store', async () => {
    const set = (await setSpecsTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        spec: {
          specId: 'SPEC-003-TOOL',
          expectedRevision: 0,
          planItemId: 'P-003',
          behavior: 'A lapsed lease is reclaimable by a second holder.',
          behaviorClass: 'concurrency',
          lifecycleStatus: 'active',
          falsifier: {
            observation: 'A second acquire on a lapsed lease returns conflict.',
            requiredScenarios: ['lease-expiry-reclaim'],
            causalPairing: 'one-to-one',
          },
        },
      } as never,
      CTX,
    )) as { data: { results: Array<Record<string, unknown>> } };
    expect(set.data.results[0]).toMatchObject({ ok: true, status: 'created', revision: 1 });

    const [row] = await store.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specIds: ['SPEC-003-TOOL'],
    });
    // probeMethod omitted, not stored as an empty string: undeclared must read as undeclared.
    expect(row.falsifier).toEqual({
      observation: 'A second acquire on a lapsed lease returns conflict.',
      requiredScenarios: ['lease-expiry-reclaim'],
      causalPairing: 'one-to-one',
    });
  });

  it('appends a NEW revision when only the falsifier changes, and reports unchanged when it does not', async () => {
    expect(await store.setSpecClause(withFalsifier())).toMatchObject({ status: 'created', revision: 1 });

    const first = await store.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specIds: ['SPEC-003-F'],
    });

    // Byte-identical re-write: still one revision.
    expect(await store.setSpecClause(withFalsifier({ expectedRevision: 1 }))).toMatchObject({
      status: 'unchanged',
      revision: 1,
    });

    // Only the falsifier moves — this MUST append, or a standing promise could be
    // rewritten under an unchanged content_hash.
    const revised = await store.setSpecClause(
      withFalsifier({
        expectedRevision: 1,
        falsifier: { observation: 'Event 42 is redelivered with a lower sequence number than the ack.' },
      }),
    );
    expect(revised).toMatchObject({ status: 'revised', revision: 2 });
    expect((revised as { contentHash: string }).contentHash).not.toBe(first[0].contentHash);

    const history = await store.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specIds: ['SPEC-003-F'],
      includeHistory: true,
    });
    expect(history.map((r) => r.revision)).toEqual([1, 2]);
    expect(history[0].falsifier?.observation).toContain('appears a second time');
    expect(history[1].falsifier?.observation).toContain('lower sequence number');
  });

  it('leaves a clause that declares no falsifier hash-identical to its pre-D-016 form', async () => {
    // Absent and explicit-null are the SAME canonical form. If they ever diverge — or
    // if either starts differing from the pre-D-016 hash — every clause in the corpus
    // silently re-hashes and its first no-op re-write appends a spurious revision.
    const bare = clause({ specId: 'SPEC-003-BARE', sourceValId: null });
    expect(store.specClauseContentHash({ ...bare, falsifier: null })).toBe(store.specClauseContentHash(bare));
    expect(store.specClauseContentHash({ ...bare, falsifier: undefined })).toBe(store.specClauseContentHash(bare));
    expect(store.specClauseContentHash({ ...bare, falsifier: { observation: 'x happens' } })).not.toBe(
      store.specClauseContentHash(bare),
    );

    expect(await store.setSpecClause(bare)).toMatchObject({ status: 'created', revision: 1 });
    const [row] = await store.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specIds: ['SPEC-003-BARE'],
    });
    expect(row.falsifier).toBeNull();
    // The back-compat property that actually bites: an existing writer that has never
    // heard of `falsifier` re-writes its clause and gets `unchanged`, not a new revision.
    expect(await store.setSpecClause({ ...bare, expectedRevision: 1 })).toMatchObject({
      status: 'unchanged',
      revision: 1,
    });
  });

  it('refuses a malformed declaration structurally instead of silently dropping it', async () => {
    expect(await store.setSpecClause(withFalsifier({ falsifier: { observation: '   ' } }))).toMatchObject({
      status: 'falsifier_invalid',
      reason: 'observation_blank',
    });

    expect(
      await store.setSpecClause(withFalsifier({ falsifier: { observation: 'real', probeMethod: '  ' } })),
    ).toMatchObject({ status: 'falsifier_invalid', reason: 'probe_method_blank' });

    expect(await store.setSpecClause(withFalsifier({ falsifier: 'not an object' as never }))).toMatchObject({
      status: 'falsifier_invalid',
      reason: 'not_an_object',
    });

    // A refusal must not have written anything.
    expect(
      await store.listSpecClauses({ harnessSlug: HARNESS, planSlug: 'reconnect-plan', specIds: ['SPEC-003-F'] }),
    ).toHaveLength(0);
  });

  it('enforces the falsifier shape in Postgres, not only in the store', async () => {
    // The store refuses these before they reach SQL, so the DB rail can only be proven by
    // writing PAST the store. Without this the CHECK could be silently dropped and every
    // app-level test above would still pass.
    //
    // It has to be an INSERT, not an UPDATE: 851 installs an immutability trigger that
    // rejects any UPDATE before a column CHECK is ever evaluated — so an UPDATE probe
    // proves the immutability rail, not this one. Each attempt clones the committed
    // revision and moves only `revision`, `content_hash` and `falsifier`, so a rejection
    // can only be attributable to the falsifier.
    await store.setSpecClause(withFalsifier());
    let nextRevision = 100;
    const bad = (falsifier: string) => {
      const revision = ++nextRevision;
      return db.sql.unsafe(`
        INSERT INTO harness_shared.plan_spec_clause_revisions (
          workspace_id, harness_slug, plan_slug, spec_id, revision, plan_item_id,
          behavior, behavior_class, required_evidence, required_test_layers,
          mutation_required, lifecycle_status, exemption, falsifier, content_hash,
          created_by, accepted_by, accepted_at, acceptance_ref
        )
        SELECT workspace_id, harness_slug, plan_slug, spec_id, ${revision}, plan_item_id,
               behavior, behavior_class, required_evidence, required_test_layers,
               mutation_required, lifecycle_status, exemption, ${falsifier},
               lpad('${revision}', 64, '0'),
               created_by, accepted_by, accepted_at, acceptance_ref
          FROM harness_shared.plan_spec_clause_revisions
         WHERE workspace_id = '${WORKSPACE}' AND harness_slug = '${HARNESS}'
           AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-F' AND revision = 1`);
    };

    await expect(bad(`'{"observation": "   "}'::jsonb`)).rejects.toThrow(/falsifier_shape/);
    // THE 929 REGRESSION, and the reason 930 exists. A falsifier that says only how to
    // probe and never what would be OBSERVED used to be ACCEPTED: with the key absent,
    // `jsonb_typeof(falsifier->'observation')` is NULL, `NULL = 'string'` is NULL, and a
    // CHECK rejects only on FALSE — so it passed. A blank observation was caught ('' is a
    // string); only the MISSING one slipped, and the two are indistinguishable downstream.
    await expect(bad(`'{"probeMethod": "how"}'::jsonb`)).rejects.toThrow(/falsifier_shape/);
    await expect(bad(`'{"observation": 42}'::jsonb`)).rejects.toThrow(/falsifier_shape/);
    await expect(bad(`'"a bare string"'::jsonb`)).rejects.toThrow(/falsifier_shape/);
    await expect(bad(`'{"observation": "ok", "probeMethod": ""}'::jsonb`)).rejects.toThrow(/falsifier_shape/);
    // JSON `null` is NOT SQL NULL, and must not sneak through as "undeclared": it is a
    // declared value of the wrong type, which is exactly the decorative case 929 blocks.
    await expect(bad(`'null'::jsonb`)).rejects.toThrow(/falsifier_shape/);

    // POSITIVE CONTROL. Without this the test is unfalsifiable: a probe rejected for some
    // unrelated reason (a typo'd column, a violated sibling CHECK) would read as the
    // falsifier guard working. A well-formed clone must be ACCEPTED by the same statement.
    await expect(bad(`'{"observation": "well formed"}'::jsonb`)).resolves.toBeDefined();
    // And SQL NULL stays legal: undeclared is a gradeable gap, not a constraint violation.
    await expect(bad('NULL')).resolves.toBeDefined();
  });
});
