/** P-005 real-Postgres coverage for exact spec evidence edges, tools, and currentness. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import type { SpecClauseWrite } from './spec-clauses-store';
import { carryUnchangedBarEvidenceBindings } from '../../acceptance-bar-amendment';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { configureRuntimeVintageStore, resetRuntimeVintageStore, InMemoryRuntimeVintageStore,
  reportRuntimeVintage, listRuntimeVintage, measureRuntimeVintageEnvironment } from '../../runtime-vintage';
import { configureRemoteRuntimeDescribe, measureRuntimeEnvironment, resetRemoteRuntimeDescribe }
  from '../../remote-runtime-identity';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, repoRoot: '', siblingRoot: '' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: postgres.Sql) => Promise<T>) =>
      h.sql.begin(async (tx) => fn(tx as unknown as postgres.Sql)),
  };
});
vi.mock('../../harness-registry', async (importOriginal) => ({
  // Real tool imports also use registry exports through the P2P sync graph.
  // Override fixture routing while preserving that production module contract.
  ...(await importOriginal<typeof import('../../harness-registry')>()),
  loadHarnessRegistry: async () => ({
    projects: [
      { slug: 'web', path: h.repoRoot },
      { slug: 'portal', path: h.siblingRoot },
    ],
  }),
  resolveHarnessContentPath: (registry: { projects: Array<{ slug: string; path: string }> }, slug: string) =>
    registry.projects.find((project) => project.slug === slug)?.path,
}));

const WORKSPACE = 'ws-spec-evidence';
const OTHER_WORKSPACE = 'ws-spec-evidence-other';
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

const specs = await import('./spec-clauses-store');
const evidenceStore = await import('./spec-evidence-store');
const bindTool = (await import('./bind-spec-evidence')).default;
const getTool = (await import('./get-spec-evidence')).default;

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = (name: string) => path.resolve(here, `../../../../../libs/papercusp/libs/db/sql/${name}`);
const MIGRATION_851 = migration('851-first-class-plan-spec-clauses.sql');
const MIGRATION_852 = migration('852-plan-spec-clause-integrity.sql');
const MIGRATION_855 = migration('855-work-item-spec-evidence-bindings.sql');
const MIGRATION_1111 = migration('1111-acceptance-bar-contract-seed.sql');
const MIGRATION_1150 = migration('1150-test-runs-execution-details.sql');
// 929/930 add plan_spec_clause_revisions.falsifier and its shape CHECK. Required here
// even though this suite is about EVIDENCE: it seeds clauses through setSpecClause, which
// writes the column. A sibling fixture silently falling one column behind a harness_shared
// table is a known recurring break (EI-21270668928342264) — this suite hit it.
const MIGRATION_929 = migration('929-spec-clause-falsifier.sql');
const MIGRATION_930 = migration('930-spec-clause-falsifier-null-safe.sql');
// 1174 adds the recorded-retraction path (WI-10001850 / D-011): the three stamp columns,
// the all-or-nothing CHECK, and the bindings-only guard that replaces the shared
// append-only trigger with a strict superset of it. Applied LAST so the guards below
// exercise the trigger this migration installs, not the one 855 installed.
const MIGRATION_1174 = migration('1174-spec-evidence-binding-retraction.sql');
const MIGRATION_1445 = migration('1445-spec-evidence-independent-verification.sql');
// 1175 scopes the dedup index to live rows so a retracted binding releases its
// slot for an identical corrected binding (WI-10001850 / D-011).
const MIGRATION_1175 = migration('1175-spec-evidence-dedup-partial-on-live.sql');
// 1176 completes the expand/contract sequence after the predicate-aware writer is
// deployed by dropping the obsolete total index (WI-10001850 / EI-23634085867209303).
const MIGRATION_1176 = migration('1176-spec-evidence-drop-total-dedup-contract-phase.sql');
const MIGRATION_1378 = migration('1378-preserve-spec-bound-test-runs.sql');
// 1478 adds the per-case results ledger (test-rubric-unification P-002): the bind path
// resolves declared testCases against it when the run recorded its cases.
const MIGRATION_1478 = migration('1478-test-case-runs.sql');
const MIGRATION_1536 = migration('1536-plan-verification-profile-columns.sql');
const CTX = {
  isSuperuser: true,
  uiClientId: 'su-spec-evidence-integration',
  workspaceId: WORKSPACE,
  harnessSlug: HARNESS,
  metadata: () => undefined,
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
    requiredEvidence: ['integration replay trace'],
    requiredTestLayers: ['integration'],
    mutationRequired: true,
    lifecycleStatus: 'active',
    acceptanceRef: 'D-003',
    actorId: 'su-spec-evidence-integration',
    ...over,
  };
}

async function seedExternalEvidence(runFilePath: string | null = null) {
  const [surface] = await db.sql<{ id: number }[]>`
    INSERT INTO harness_shared.testing_surfaces (workspace_id, harness_slug)
    VALUES (${WORKSPACE}, ${HARNESS}) RETURNING id`;
  const [coverage] = await db.sql<{ id: number }[]>`
    INSERT INTO harness_shared.coverage_evidence (surface_ref)
    VALUES (${surface.id}) RETURNING id`;
  const [run] = await db.sql<{ id: number }[]>`
    INSERT INTO harness_shared.test_runs (workspace_id, harness_slug, file_path)
    VALUES (${WORKSPACE}, ${HARNESS}, ${runFilePath}) RETURNING id`;
  return { surfaceId: Number(surface.id), coverageEvidenceRef: Number(coverage.id), testRunId: Number(run.id) };
}

beforeAll(async () => {
  h.repoRoot = await mkdtemp(path.join(tmpdir(), 'spec-evidence-integration-'));
  h.siblingRoot = await mkdtemp(path.join(tmpdir(), 'spec-evidence-sibling-integration-'));
  await Promise.all([
    mkdir(path.join(h.repoRoot, 'src'), { recursive: true }),
    mkdir(path.join(h.repoRoot, 'test'), { recursive: true }),
    mkdir(path.join(h.siblingRoot, 'src'), { recursive: true }),
    mkdir(path.join(h.siblingRoot, 'test'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(h.repoRoot, 'src', 'reconnect.ts'), 'export const reconnect = true;\n'),
    writeFile(path.join(h.repoRoot, 'test', 'reconnect.test.ts'), 'expect(reconnect).toBe(true);\n'),
    writeFile(path.join(h.siblingRoot, 'src', 'portal.ts'), 'export const rendererTrust = true;\n'),
    writeFile(path.join(h.siblingRoot, 'test', 'portal.test.ts'), 'expect(rendererTrust).toBe(true);\n'),
  ]);
  db = await createFreshPgDb('plan-spec-evidence');
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
      template text,
      -- P-022: the ad-hoc spec scope is materialised WITH a self-explaining body, so this
      -- fixture needs the column the real table has. Same class of drift the MIGRATION_929
      -- note above records (EI-21270668928342264): a hand-rolled fixture silently falling
      -- one column behind a harness_shared table.
      content text NOT NULL DEFAULT '',
      -- resolveSpecScopeSlug writes this alongside content when it lazily creates the
      -- ad-hoc scope; keep the hand-built table aligned with the live harness_plans shape.
      content_hash text NOT NULL DEFAULT '',
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    -- The same first-use path appends a system revision in this ledger. The production
    -- writer names every column below; omitting the table here makes the omitted-slug
    -- behavior fail before it can return its intended spec_not_found result.
    CREATE TABLE harness_shared.plan_revisions (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
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
      -- Real table: NOT NULL with NO default, which is why the ad-hoc item insert computes it.
      seq integer NOT NULL,
      owner_gate_marker text,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id)
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
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      status text,
      taken_by text,
      origin text NOT NULL DEFAULT 'local',
      item_kind text NOT NULL DEFAULT 'bug',
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_ts bigint NOT NULL DEFAULT ((extract(epoch FROM now()) * 1000)::bigint),
      source_plan_slug text,
      source_plan_item_ids text[],
      admission text, admitted_at timestamptz, admitted_by text,
      PRIMARY KEY (harness_slug, feature_id)
    );
    CREATE TABLE harness_shared.carry_notes (
      workspace_id text NOT NULL, scope text NOT NULL, note text,
      journal jsonb NOT NULL DEFAULT '[]'::jsonb, updated_ts bigint NOT NULL,
      deps jsonb, body_ts bigint, attested_count integer NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, scope)
    );
    CREATE TABLE harness_shared.test_runs (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text,
      harness_slug text,
      file_path text,
      status text,
      -- bind-from-test-run also reads the run's measurement lower bound.
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      output_tail text,
      run_group_id text,
      commit_sha text,
      worktree_dirty boolean NOT NULL DEFAULT false,
      -- P-044: bind-from-test-run reads the writer origin (real table: NOT NULL DEFAULT 'local').
      source text NOT NULL DEFAULT 'local',
      -- bind-from-test-run reads the recording framework to route cargo rows (real table:
      -- framework TEXT NOT NULL, no default). WI-10006905: omitting it failed every fromTestRun case.
      framework text NOT NULL DEFAULT 'vitest'
    );
    CREATE TABLE harness_shared.testing_surfaces (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL
    );
    CREATE TABLE harness_shared.coverage_evidence (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      surface_ref bigint NOT NULL REFERENCES harness_shared.testing_surfaces(id) ON DELETE CASCADE
    );
  `);
  await applyMigrationForTest(db.sql, MIGRATION_1150);
  await applyMigrationForTest(db.sql, MIGRATION_1150); // additive and replay-safe
  await applyMigrationForTest(db.sql, MIGRATION_851);
  await applyMigrationForTest(db.sql, MIGRATION_852);
  await applyMigrationForTest(db.sql, MIGRATION_1111);
  await applyMigrationForTest(db.sql, MIGRATION_855);
  await applyMigrationForTest(db.sql, MIGRATION_855);
  await applyMigrationForTest(db.sql, MIGRATION_929);
  await applyMigrationForTest(db.sql, MIGRATION_930);
  await applyMigrationForTest(db.sql, MIGRATION_1174);
  await applyMigrationForTest(db.sql, MIGRATION_1174); // idempotent and replay-safe
  await applyMigrationForTest(db.sql, MIGRATION_1175);
  await applyMigrationForTest(db.sql, MIGRATION_1175); // idempotent and replay-safe
  await applyMigrationForTest(db.sql, MIGRATION_1176);
  await applyMigrationForTest(db.sql, MIGRATION_1176); // idempotent and replay-safe
  await applyMigrationForTest(db.sql, MIGRATION_1378);
  await applyMigrationForTest(db.sql, MIGRATION_1378); // idempotent and replay-safe
  await applyMigrationForTest(db.sql, MIGRATION_1445);
  await applyMigrationForTest(db.sql, MIGRATION_1478);
  // Lazy ad-hoc scopes stamp the same verification profile as plans:new.
  await applyMigrationForTest(db.sql, MIGRATION_1536);
  const [{ present }] = await db.sql<{ present: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'harness_shared'
      AND table_name = 'spec_evidence_bindings' AND column_name = 'verifies_binding_id'
  ) AS present`;
  expect(present, 'the fixture must support the current evidence writer before compiler scenarios run').toBe(true);
}, 90_000);

afterAll(async () => {
  await Promise.all([
    db?.cleanup(),
    rm(h.repoRoot, { recursive: true, force: true }),
    rm(h.siblingRoot, { recursive: true, force: true }),
  ]);
}, 30_000);

beforeEach(async () => {
  await writeFile(path.join(h.repoRoot, 'src', 'reconnect.ts'), 'export const reconnect = true;\n');
  await db.sql`TRUNCATE
    harness_shared.carry_notes,
    harness_shared.plan_revisions,
    harness_shared.spec_evidence_bindings,
    harness_shared.work_item_spec_revision_edges,
    harness_shared.plan_spec_clause_revisions,
    harness_shared.plan_spec_clauses,
    harness_shared.harness_plan_assertions,
    harness_shared.plan_items,
    harness_shared.harness_plans,
    harness_shared.coverage_evidence,
    harness_shared.testing_surfaces,
    harness_shared.test_runs,
    harness_shared.work_items RESTART IDENTITY CASCADE`;
  await db.sql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
    VALUES (${WORKSPACE}, ${HARNESS}, 'reconnect-plan')`;
  await db.sql`
    INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq)
    VALUES (${WORKSPACE}, ${HARNESS}, 'reconnect-plan', 'P-003', 1),
           (${WORKSPACE}, ${HARNESS}, 'reconnect-plan', 'P-004', 2)`;
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, source_plan_slug, source_plan_item_ids)
    VALUES (${WORKSPACE}, ${HARNESS}, 'WI-101', 'reconnect-plan', ARRAY['P-003', 'P-004']::text[]),
           (${WORKSPACE}, ${HARNESS}, 'WI-102', 'reconnect-plan', ARRAY['P-003', 'P-004']::text[])`;
});

describe('promotion carry-forward of current spec evidence', () => {
  it('copies exact proof from a dropped predecessor to the canonical item and remaps its verification citation', async () => {
    const observedAt = '2026-10-20T01:02:03.000Z';
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
    const runId = '20261025T000000Z-257';
    const receipts = [{ runId, resultSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64),
      lifecycleSha256: 'c'.repeat(64) }];
    const execution = { schemaVersion: 1, root: h.repoRoot, filePath: 'test/reconnect.test.ts',
      runGroupId: null, workspaceId: WORKSPACE, harnessSlug: HARNESS, testNamePattern: null,
      testLayer: 'integration', passed: 1, failed: 0, skipped: 0, collectionFailed: false,
      mutationPhase: null, commitSha: null, worktreeDirty: true, isolatedRuntimeReceipts: receipts };
    await db.sql`UPDATE harness_shared.test_runs SET execution_details = ${JSON.stringify(execution)}::text::jsonb
      WHERE id = ${testRunId}`;
    const currentMeasurement = { schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/reconnect.ts'],
      runtimeUnits: [`isolated-integration:${runId}`] };
    const testRun = { id: testRunId, filePath: 'test/reconnect.test.ts' };
    const sourceBinding = await evidenceStore.bindSpecEvidence({
      workItemId: 'WI-101', specId: 'SPEC-003-01', harnessSlug: HARNESS, planSlug: 'reconnect-plan',
      actorId: 'su-original-implementer', evidenceKind: 'test', evidenceRef: 'test/reconnect.test.ts',
      testRunId, sourceFingerprint: 'source-v1', observedAt,
      details: { evidencePlane: 'live', testRun, currentMeasurement },
    });
    expect(sourceBinding).toMatchObject({ status: 'created' });
    const sourceBindingId = (sourceBinding as { id: number }).id;
    const sourceVerification = await evidenceStore.bindSpecEvidence({
      workItemId: 'WI-101', specId: 'SPEC-003-01', harnessSlug: HARNESS, planSlug: 'reconnect-plan',
      actorId: 'su-original-reviewer', evidenceKind: 'independent-verification',
      verifiesBindingId: sourceBindingId, evidenceRef: 'test/reconnect.test.ts', sourceFingerprint: 'source-v1',
      environmentFingerprint: 'reviewer-supplied-runtime', observedAt: '2026-10-20T01:03:04.000Z',
      details: { note: 'independent re-observation', currentMeasurement },
    });
    expect(sourceVerification).toMatchObject({ status: 'created' });

    // Plan reopen retires the old canonical row before promoting its replacement.
    await db.sql`UPDATE harness_shared.work_items SET status = 'dropped', updated_ts = 1000
      WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND feature_id = 'WI-101'`;
    await db.sql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, status, payload, source_plan_slug, source_plan_item_ids)
      VALUES (${WORKSPACE}, ${HARNESS}, 'WI-103', 'open',
        ${JSON.stringify({ plan_item: { plan_slug: 'reconnect-plan', item_id: 'P-003' } })}::text::jsonb,
        'reconnect-plan', ARRAY['P-003']::text[])`;
    await evidenceStore.ensureWorkItemSpecRevisionEdges({
      workspaceId: WORKSPACE, harnessSlug: HARNESS, planSlug: 'reconnect-plan',
      planItemIds: ['P-003'], workItemId: 'WI-103', actorId: 'su-promoter',
    });

    const transferInput = {
      workspaceId: WORKSPACE, harnessSlug: HARNESS, planSlug: 'reconnect-plan',
      planItemId: 'P-003', workItemId: 'WI-103', actorId: 'su-promoter',
    };
    const transferred = await evidenceStore.carryForwardCurrentSpecEvidence(transferInput);
    expect(transferred.sourceWorkItemId).toBe('WI-101');
    expect(transferred.copiedBindingIds).toHaveLength(2);

    const rows = await db.sql<{
      id: number | string;
      work_item_id: string;
      evidence_kind: string;
      created_by: string;
      observed_at: Date | string;
      test_run_id: number | string | null;
      verifies_binding_id: number | string | null;
    }[]>`SELECT id, work_item_id, evidence_kind, created_by, observed_at, test_run_id, verifies_binding_id
          FROM harness_shared.spec_evidence_bindings
         WHERE work_item_id IN ('WI-101', 'WI-103') ORDER BY id`;
    const originalRows = rows.filter((row) => row.work_item_id === 'WI-101');
    const copiedRows = rows.filter((row) => row.work_item_id === 'WI-103');
    expect(originalRows).toHaveLength(2);
    expect(copiedRows).toHaveLength(2);
    const originalTest = originalRows.find((row) => row.evidence_kind === 'test')!;
    const copiedTest = copiedRows.find((row) => row.evidence_kind === 'test')!;
    const copiedVerification = copiedRows.find((row) => row.evidence_kind === 'independent-verification')!;
    expect(copiedTest.created_by).toBe('su-original-implementer');
    expect(new Date(copiedTest.observed_at).toISOString()).toBe(observedAt);
    expect(Number(copiedTest.test_run_id)).toBe(testRunId);
    expect(Number(copiedVerification.verifies_binding_id)).toBe(Number(copiedTest.id));
    expect(Number(copiedVerification.verifies_binding_id)).not.toBe(Number(originalTest.id));

    expect(await evidenceStore.carryForwardCurrentSpecEvidence(transferInput)).toEqual(transferred);
    const [targetCount] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM harness_shared.spec_evidence_bindings WHERE work_item_id = 'WI-103'`;
    expect(targetCount.count).toBe(2);
  });
});

describe('test execution carries mappings into the real evidence ledger', () => {
  it('recovers detached measured outcomes from the exact scoped PG row after a timeout', async () => {
    const { prepareTestEvidence, finishTestEvidence, recoverTestEvidence } = await import('../testing/evidence');
    const { readHarnessTestRunEvidence, countUnattributedTestRunRows } = await import('../../testing-run-store');
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const origin = '0b2a4763-5332-455f-a876-c056e9b1cdb1';
    const detached = '9a08bdac-4a37-4d16-80d5-ebd22d531e8d';
    const testPath = 'test/reconnect.test.ts';
    const scope = { workspaceId: WORKSPACE, harnessSlug: HARNESS, actorId: 'su-test', root: h.repoRoot };
    const deps = { bind: evidenceStore.bindSpecEvidence, measure: evidenceStore.measureRepoFilesEvidenceAtRoot,
      list: evidenceStore.listSpecEvidence,
      ledger: (args: Parameters<typeof readHarnessTestRunEvidence>[0]) => readHarnessTestRunEvidence({
        ...args, sql: h.sql as unknown as NonNullable<Parameters<typeof readHarnessTestRunEvidence>[0]['sql']>,
      }),
      unattributed: countUnattributedTestRunRows };
    const prepared = await prepareTestEvidence({ workItemId: 'WI-101', planSlug: 'reconnect-plan',
      bindings: [{ specId: 'SPEC-003-01', specRevision: 1, testPath, sourcePaths: ['src/reconnect.ts'],
        testLayer: 'integration' }] }, origin, [testPath], scope, deps);
    await finishTestEvidence(prepared, origin, detached, scope,
      { ok: false, runId: origin, root: h.repoRoot, error: 'timeout' }, deps);
    const recovery = { workItemId: 'WI-101', planSlug: 'reconnect-plan', originRunId: origin, runId: detached };
    const commitSha = 'fixture-commit';
    const details = { schemaVersion: 1, root: h.repoRoot, filePath: testPath,
      workspaceId: WORKSPACE, harnessSlug: HARNESS, runGroupId: detached, testNamePattern: null,
      passed: 3, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
      commitSha, worktreeDirty: false };
    // A same-run, same-file row from another tenant must not settle this proof.
    await db.sql`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,status,finished_at,run_group_id,commit_sha,worktree_dirty,execution_details)
      VALUES (${OTHER_WORKSPACE},${HARNESS},${testPath},'pass',now(),${detached},${commitSha},false,${JSON.stringify(details)}::text::jsonb)`;
    expect((await recoverTestEvidence(recovery, scope, deps)).rows[0])
      .toMatchObject({ phase: 'pending', outcome: 'unknown' });
    const [row] = await db.sql<{ id: number }[]>`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,status,finished_at,run_group_id,commit_sha,worktree_dirty,execution_details)
      VALUES (${WORKSPACE},${HARNESS},${testPath},'pass',now(),${detached},${commitSha},false,${JSON.stringify(details)}::text::jsonb)
      RETURNING id`;
    const exact = await deps.ledger({ workspaceId: WORKSPACE, harnessSlug: HARNESS, runGroupId: detached });
    expect(exact).toHaveLength(1);
    expect(exact![0].execution_details).toEqual(details);
    const recovered = await recoverTestEvidence(recovery, scope, deps);
    expect(recovered.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass', testRunId: Number(row.id) });
    expect(recovered).toHaveProperty('verificationFingerprint', expect.any(String));
    // Two matching receipts are ambiguous, even when both say pass.
    await db.sql`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,status,finished_at,run_group_id,commit_sha,worktree_dirty,execution_details)
      VALUES (${WORKSPACE},${HARNESS},${testPath},'pass',now(),${detached},${commitSha},false,${JSON.stringify(details)}::text::jsonb)`;
    expect((await recoverTestEvidence(recovery, scope, deps)).rows[0])
      .toMatchObject({ phase: 'pending', outcome: 'unknown', testRunId: null });
  });

  it('persists pending links, attaches the exact scoped run, and preserves stale source after a change', async () => {
    const { prepareTestEvidence, finishTestEvidence, recoverTestEvidence } = await import('../testing/evidence');
    const { readHarnessTestRunEvidence, countUnattributedTestRunRows } = await import('../../testing-run-store');
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const runId = '65878e5c-0326-4899-9fa4-6e387d30fef4';
    const testPath = 'test/reconnect.test.ts';
    const request = { workItemId: 'WI-101', planSlug: 'reconnect-plan', bindings: [{ specId: 'SPEC-003-01',
      specRevision: 1, testPath, sourcePaths: ['src/reconnect.ts'], testLayer: 'integration' as const,
      causalPairId: 'original-reconnect' }] };
    const scope = { workspaceId: WORKSPACE, harnessSlug: HARNESS, actorId: 'su-test', root: h.repoRoot };
    const deps = { bind: evidenceStore.bindSpecEvidence, measure: evidenceStore.measureRepoFilesEvidenceAtRoot,
      list: evidenceStore.listSpecEvidence,
      ledger: (args: Parameters<typeof readHarnessTestRunEvidence>[0]) => readHarnessTestRunEvidence({
        ...args, sql: h.sql as unknown as NonNullable<Parameters<typeof readHarnessTestRunEvidence>[0]['sql']>,
      }),
      unattributed: countUnattributedTestRunRows };
    const prepared = await prepareTestEvidence(request, runId, [testPath], scope, deps);
    const pending = await evidenceStore.listSpecEvidence({ harnessSlug: HARNESS, planSlugs: ['reconnect-plan'], workItemIds: ['WI-101'] });
    expect(pending).toHaveLength(1);
    expect(pending[0].details.adequacy).toMatchObject({ outcome: 'pending', executed: false, causalPairIds: ['original-reconnect'] });
    const executionDetails = {
      schemaVersion: 1,
      root: h.repoRoot,
      filePath: testPath,
      runGroupId: runId,
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      testNamePattern: null,
      passed: 1,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha: 'fixture-commit',
      worktreeDirty: false,
    };
    const [run] = await db.sql<{ id: number }[]>`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,status,finished_at,run_group_id,commit_sha,worktree_dirty,execution_details)
      VALUES (${WORKSPACE},${HARNESS},${testPath},'pass',now(),${runId},'fixture-commit',false,
        ${JSON.stringify(executionDetails)}::text::jsonb) RETURNING id`;
    await db.sql`INSERT INTO harness_shared.test_runs (workspace_id,harness_slug,file_path,status,finished_at,run_group_id)
      VALUES (${OTHER_WORKSPACE},${HARNESS},${testPath},'fail',now(),${runId})`;
    const result = { ok: true, runId, root: h.repoRoot, passed: 1, failed: 0, skipped: 0, files: 1,
      failures: [], failuresTruncated: false, durationMs: 1,
      byFile: { [testPath]: { passed: 1, failed: 0, skipped: 0, collectionFailed: false } } };
    const bundle = await finishTestEvidence(prepared, runId, runId, scope, result, deps);
    expect(bundle.rows[0]).toMatchObject({ testRunId: Number(run.id), phase: 'settled', outcome: 'pass' });
    await db.sql`UPDATE harness_shared.test_runs SET worktree_dirty = true WHERE id = ${run.id}`;
    const [bound] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS, planSlugs: ['reconnect-plan'], workItemIds: ['WI-101'],
    });
    expect(bound.testRunProvenance).toMatchObject({
      filePath: testPath, commitSha: 'fixture-commit', worktreeDirty: true,
    });
    expect(bound.testRunExecution).toEqual({
      status: 'pass',
      passed: 1, failed: 0, skipped: 0, collectionFailed: false,
      passedCaseTitlesIncomplete: true,
      filePath: testPath,
    });
    await db.sql`UPDATE harness_shared.test_runs SET worktree_dirty = false WHERE id = ${run.id}`;
    // Integrated continuation: persist once, cross the reader boundary, and use
    // the exact automatically recorded run without opening a transcript/history.
    const { setWorkItemCheckpoint, getWorkItemCheckpointWithMeta } = await import('../../work-item-checkpoint');
    const { renderCarryNote } = await import('../../carry-note');
    const { readWorkItemResume } = await import('../work_items/resume');
    const { shapeWorkItemsGet } = await import('../work_items/get-shape');
    const next = 'Review the saved reconnect evidence, then continue the plan.';
    await setWorkItemCheckpoint({ workspaceId: WORKSPACE, harness: HARNESS, workItemId: 'WI-101' },
      renderCarryNote({ did: 'Historical investigation '.repeat(500), next }));
    const resume = await readWorkItemResume({ id: 'WI-101', harness: HARNESS, assignee: 'successor', state: 'open',
      payload: { plan_item: { plan_slug: 'reconnect-plan', item_id: 'P-003' } } }, {
      checkpoint: ref => getWorkItemCheckpointWithMeta({ ...ref, workspaceId: WORKSPACE }),
      freshness: async () => undefined, evidence: evidenceStore.listSpecEvidence,
    });
    const packet = shapeWorkItemsGet({ ok: true, __resumeOnly: true,
      results: [{ ok: true, id: 'WI-101', resume }], counts: { ok: 1, failed: 0 } }, 'trimmed') as any;
    expect(packet.results[0].resume.nextAction.text).toBe(next);
    expect(packet.results[0].resume.evidence.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ testRunId: Number(run.id), specId: 'SPEC-003-01', outcome: 'pass' }),
    ]));
    expect(JSON.stringify(packet).length).toBeLessThan(6_000);
    const { observeFailureLoop, takePendingFailureLoopHint } = await import('../../failure-loop-circuit-breaker');
    const { buildFailureLoopHintText } = await import('../../failure-loop-hints');
    const ownerId = 'integration-efficiency-successor';
    for (let i = 0; i < 3; i++) observeFailureLoop({ ownerId, toolName: 'testing:run', args: { files: [testPath] },
      result: { ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ ...result, evidenceBundle: bundle }) }] } }, now: i + 1 });
    const hint = takePendingFailureLoopHint(ownerId, 4);
    expect(hint).toMatchObject({ kind: 'repetition', category: 'test' });
    expect(await buildFailureLoopHintText(hint!)).toContain('Reuse the saved evidence');
    const recovered = await recoverTestEvidence({ workItemId: 'WI-101', planSlug: 'reconnect-plan', originRunId: runId, runId }, scope, deps);
    expect(recovered.rows[0]).toMatchObject({ testRunId: Number(run.id), phase: 'settled', outcome: 'pass', bindingStatus: 'unchanged' });
    // The next recovery check models a synthetic failed legacy row; clear the
    // successful counters used above to verify the listSpecEvidence projection.
    await db.sql`UPDATE harness_shared.test_runs SET execution_details = NULL WHERE id = ${run.id}`;
    await db.sql`UPDATE harness_shared.test_runs SET status = 'fail' WHERE id = ${run.id}`;
    const revised = await recoverTestEvidence({ workItemId: 'WI-101', planSlug: 'reconnect-plan', originRunId: runId, runId }, scope, deps);
    expect(revised.rows[0]).toMatchObject({ testRunId: Number(run.id), phase: 'review-required', outcome: 'unknown' });
    await writeFile(path.join(h.repoRoot, 'src/reconnect.ts'), 'export const reconnect = "changed after execution";\n');
    await finishTestEvidence(prepared, runId, runId, scope, result, deps);
    const changed = await evidenceStore.listSpecEvidence({ harnessSlug: HARNESS, planSlugs: ['reconnect-plan'], workItemIds: ['WI-101'] });
    expect(changed.every(row => row.currentness.overall === 'stale')).toBe(true);
  });
});

describe('native P015 compiler dependency evidence', () => {
  it('first-touch source links join canonical evidence and docs without leaking another source or tenant', async () => {
    const { readPushSourceLinks } = await import('../../code-intelligence/push-channel');
    await applyMigrationForTest(db.sql, migration('172-harness-docs.sql'));
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
    const args = bindTool.args.parse({ harness: HARNESS, slug: 'reconnect-plan',
      binding: { workItemId: 'WI-101', specId: 'SPEC-003-01', specRevision: 1,
        evidenceKind: 'test', evidenceRef: 'test/reconnect.test.ts', testRunId,
        measurement: { schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/reconnect.ts'] } } });
    const bound = await bindTool.handler(args as never, CTX) as { data: { results: Array<{ ok: boolean }> } };
    expect(bound.data.results[0]?.ok, JSON.stringify(bound.data.results)).toBe(true);
    await specs.setSpecClause(clause({ specId: 'SPEC-003-02', sourceValId: 'VAL-003-02', mutationRequired: false }));
    const foreign = await evidenceStore.bindSpecEvidence({ harnessSlug: HARNESS, planSlug: 'reconnect-plan',
      workItemId: 'WI-101', specId: 'SPEC-003-02', specRevision: 1, evidenceKind: 'manual', evidenceRef: 'foreign-root-proof',
      sourceFingerprint: 'foreign-root-fixture', actorId: 'su-test', details: {
        currentMeasurement: { schemaVersion: 1, kind: 'repo-files', rootHarnessSlug: 'portal', sourcePaths: ['src/reconnect.ts'] },
        measurementPin: { schemaVersion: 1, repos: [], files: [{ path: 'src/reconnect.ts', dimension: 'source',
          sha256: 'b'.repeat(64), gitBlob: 'c'.repeat(40), repo: '.', headBlob: null, clean: null }] },
      } });
    expect(foreign.status).toBe('created');
    await db.sql`INSERT INTO harness_shared.harness_docs (workspace_id,harness_slug,doc_id,source,anchor_paths)
      VALUES (${WORKSPACE},${HARNESS},'guides/reconnect.md','manual',${['src/reconnect.ts']}::text[]),
             (${OTHER_WORKSPACE},${HARNESS},'guides/foreign.md','manual',${['src/reconnect.ts']}::text[])`;
    const input = { workspace: WORKSPACE, harness: HARNESS, owner: 'first-touch-test', calls: [] };
    const links = await readPushSourceLinks(input, ['src/reconnect.ts', 'src/another.ts'], db.sql);
    expect(links.byPath?.['src/reconnect.ts']).toEqual({ docs: ['guides/reconnect.md'], specs: ['reconnect-plan#SPEC-003-01@1'] });
    expect(links.byPath?.['src/another.ts']).toEqual({ docs: [], specs: [] });
    const other = await readPushSourceLinks({ ...input, workspace: OTHER_WORKSPACE }, ['src/reconnect.ts'], db.sql);
    expect(other.byPath?.['src/reconnect.ts']).toEqual({ docs: ['guides/foreign.md'], specs: [] });
    const missingHarness = await readPushSourceLinks({ ...input, harness: 'foreign' }, ['src/reconnect.ts'], db.sql);
    expect(missingHarness.byPath?.['src/reconnect.ts']).toEqual({ docs: [], specs: [] });
  });

  it('marks persisted proof stale after a dependency changes without revising the requirement or test run', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    await writeFile(path.join(h.repoRoot, 'src/reconnect.ts'),
      'import { dependency } from "./reconnect-dependency";\nexport function reconnect() { return dependency(); }\n');
    await writeFile(path.join(h.repoRoot, 'src/reconnect-dependency.ts'), 'export function dependency() { return 1; }\n');
    const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
    const args = bindTool.args.parse({ harness: HARNESS, slug: 'reconnect-plan',
      dependencies: [{ name: 'reconnect', file: 'src/reconnect.ts', paths: ['src'] }],
      binding: { workItemId: 'WI-101', specId: 'SPEC-003-01', specRevision: 1,
        evidenceKind: 'test', evidenceRef: 'test/reconnect.test.ts', testRunId,
        measurement: { schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/reconnect.ts'] } } });
    const bound = await bindTool.handler(args as never, CTX) as { data: { results: Array<{ ok: boolean }> } };
    expect(bound.data.results[0]?.ok, JSON.stringify(bound.data.results)).toBe(true);
    const read = () => evidenceStore.listSpecEvidence({ harnessSlug: HARNESS, planSlugs: ['reconnect-plan'], workItemIds: ['WI-101'] });
    const [before] = await read();
    expect(before!.currentness.overall).toBe('current');
    expect(before!.details.currentMeasurement).toMatchObject({
      sourcePaths: ['src/reconnect-dependency.ts', 'src/reconnect.ts'],
    });
    expect(before!.details.codeDependencies).toMatchObject({ schemaVersion: 1, sources: expect.arrayContaining([
      expect.objectContaining({ path: 'src/reconnect-dependency.ts', representation: 'full-source' }),
    ]) });
    await writeFile(path.join(h.repoRoot, 'src/reconnect-dependency.ts'), 'export function dependency() { return 2; }\n');
    const [after] = await read();
    expect(after!.currentness.overall).toBe('stale');
    expect(after!.currentness.dimensions.source).toBe('stale');
    expect(after!.id).toBe(before!.id);
    expect(after!.specRevision).toBe(1);
    expect(after!.testRunId).toBe(testRunId);
    expect(after!.fingerprints).toEqual(before!.fingerprints);
  }, 120_000);
});

describe('ad-hoc work-items carry spec evidence with no plan (P-022 / D-018)', () => {
  const ADHOC = 'adhoc-work-item-specs';

  beforeEach(async () => {
    // A work-item with NO source_plan_slug — the 99.2% ad-hoc regime layer A governs.
    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, source_plan_slug)
      VALUES (${WORKSPACE}, ${HARNESS}, 'WI-900', NULL)`;
  });

  it('materialises the shared scope lazily, then authors and binds against it', async () => {
    const before = await db.sql`
      SELECT plan_slug FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC}`;
    expect(before, 'the scope must not exist until something needs it').toHaveLength(0);

    // No planSlug anywhere in this flow — that is the whole point of the item.
    const authored = await specs.setSpecClause(
      clause({
        planSlug: undefined,
        planItemId: 'P-900',
        specId: 'WI-900:S-001',
        sourceValId: null,
        behavior: 'The ad-hoc close names each requirement it disposed of.',
      }),
    );
    expect(authored).toMatchObject({ status: 'created', revision: 1 });

    const bound = await evidenceStore.bindSpecEvidence({
      workItemId: 'WI-900',
      specId: 'WI-900:S-001',
      evidenceKind: 'test',
      evidenceRef: 'lib/adhoc.test.ts#disposition',
      sourceFingerprint: 'git:adhoc1',
      harnessSlug: HARNESS,
      actorId: 'su-test',
    });
    expect(bound).toMatchObject({ status: 'created', planSlug: ADHOC, workItemId: 'WI-900' });

    // The edge row is what makes the evidence findable per work-item, and it carries the
    // resolved scope rather than a NULL — plan_slug is a PK column and can never be null.
    const edges = await db.sql<{ plan_slug: string; work_item_id: string }[]>`
      SELECT plan_slug, work_item_id FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}`;
    expect(edges).toEqual([{ plan_slug: ADHOC, work_item_id: 'WI-900' }]);

    const scope = await db.sql<{ content: string }[]>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC}`;
    expect(scope).toHaveLength(1);
    expect(scope[0]!.content, 'the row must explain itself to whoever finds it').toContain(
      'Ad-hoc work-item spec scope',
    );
  });

  it('is idempotent across work-items — one scope row, one item row each', async () => {
    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, source_plan_slug)
      VALUES (${WORKSPACE}, ${HARNESS}, 'WI-901', NULL)`;
    for (const wi of ['WI-900', 'WI-901', 'WI-900']) {
      await specs.setSpecClause(
        clause({
          planSlug: undefined,
          // A `P-NNN` label, not the work-item id: the revisions CHECK enforces that shape.
          // Per-item identity rides on `spec_id` and the edge row's `work_item_id`.
          planItemId: `P-${wi.slice(-3)}`,
          specId: `${wi}:S-001`,
          sourceValId: null,
        }),
      );
    }
    const plans = await db.sql`
      SELECT plan_slug FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC}`;
    expect(plans, 'one scope row per harness, never one per work-item').toHaveLength(1);
    const items = await db.sql<{ item_id: string; seq: number }[]>`
      SELECT item_id, seq FROM harness_shared.plan_items
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC}
       ORDER BY item_id`;
    expect(items.map((r) => r.item_id)).toEqual(['P-900', 'P-901']);
    expect(new Set(items.map((r) => Number(r.seq))).size, 'seq must stay distinct').toBe(2);
  });

  it('explains an omitted slug when a real-plan clause is absent from the default ad-hoc scope', async () => {
    await specs.setSpecClause(clause());
    const binding = {
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'test' as const,
      evidenceRef: 'test/reconnect.integration.ts#missing-slug',
      sourceFingerprint: 'git:missing-slug',
    };
    const refused = (await bindTool.handler({ binding, harness: HARNESS }, CTX)) as {
      data: { results: Array<{ message: string }> };
    };
    expect(refused.data).toMatchObject({
      ok: false,
      results: [
        {
          status: 'spec_not_found',
          slug: ADHOC,
          specId: binding.specId,
          message: expect.stringContaining('no slug supplied'),
        },
      ],
    });
    const row = refused.data.results[0]!;
    expect(row.message).toContain(ADHOC);
    expect(row.message).toContain('pass slug');
    const [scope] = await db.sql<{ content: string; content_hash: string }[]>`
      SELECT content, content_hash FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC}`;
    expect(scope).toBeDefined();
    expect(scope!.content).toContain(`# Ad-hoc work-item spec scope`);
    expect(scope!.content_hash).toBe(hashPlanContent(scope!.content));
    const [revision] = await db.sql<{
      seq: number | string; content_hash: string; content_snapshot: string; author_kind: string; author_id: string;
    }[]>`
      SELECT seq, content_hash, content_snapshot, author_kind, author_id
        FROM harness_shared.plan_revisions
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC}`;
    expect(revision).toMatchObject({
      content_hash: scope!.content_hash,
      content_snapshot: scope!.content,
      author_kind: 'system',
      author_id: 'plan-spec:adhoc-scope',
    });
    expect(Number(revision!.seq)).toBe(1);
    const edges = await db.sql`
      SELECT id FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}`;
    expect(edges, 'a refusal must not write a binding').toHaveLength(0);

    const rebound = await bindTool.handler({ binding, harness: HARNESS, slug: 'reconnect-plan' }, CTX);
    expect(rebound).toMatchObject({
      data: {
        ok: true,
        results: [{ status: 'created', slug: 'reconnect-plan', specId: binding.specId }],
      },
    });
  });

  it('does not blame an explicit plan miss on an omitted slug', async () => {
    const refused = (await bindTool.handler(
      {
        slug: 'reconnect-plan',
        harness: HARNESS,
        binding: {
          workItemId: 'WI-101',
          specId: 'ABSENT-SPEC',
          evidenceKind: 'test',
          evidenceRef: 'test/reconnect.integration.ts#absent-spec',
          sourceFingerprint: 'git:explicit-miss',
        },
      },
      CTX,
    )) as { data: { results: Array<Record<string, unknown>> } };
    expect(refused.data).toMatchObject({
      ok: false,
      results: [{ status: 'spec_not_found', slug: 'reconnect-plan', specId: 'ABSENT-SPEC' }],
    });
    expect(refused.data.results[0]).not.toHaveProperty('message');
  });

  it('still honours an explicit plan slug — the ad-hoc path is a fallback, not a takeover', async () => {
    await specs.setSpecClause(clause());
    const bound = await evidenceStore.bindSpecEvidence({
      workItemId: 'WI-101',
      sourceValId: 'VAL-003-01',
      evidenceKind: 'test',
      evidenceRef: 'test/reconnect.integration.ts#explicit',
      sourceFingerprint: 'git:explicit',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
    });
    expect(bound).toMatchObject({ status: 'created', planSlug: 'reconnect-plan' });
    const adhoc = await db.sql`
      SELECT plan_slug FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC}`;
    expect(adhoc, 'a plan-bound write must not materialise the ad-hoc scope').toHaveLength(0);
  });
});

describe('exact spec evidence bindings', () => {
  it.each([
    ['integration', true, false], ['e2e', true, false], ['unit', true, false],
    ['e2e', false, false], ['e2e', true, true],
  ] as const)('pins original isolated lifetime hashes (layer=%s receipts=%s wrong-unit=%s)',
    async (testLayer, hasReceipts, wrongUnit) => {
      await specs.setSpecClause(clause({ mutationRequired: false }));
      const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
      const runId = '20261008T000000Z-100';
      const receipts = [{ runId, resultSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64),
        lifecycleSha256: 'c'.repeat(64) }];
      const execution = { schemaVersion: 1, root: h.repoRoot, filePath: 'test/reconnect.test.ts',
        runGroupId: null, workspaceId: WORKSPACE, harnessSlug: HARNESS, testNamePattern: null,
        testLayer, passed: 1, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
        commitSha: null, worktreeDirty: true, ...(hasReceipts ? { isolatedRuntimeReceipts: receipts } : {}) };
      await db.sql`UPDATE harness_shared.test_runs SET execution_details = ${JSON.stringify(execution)}::text::jsonb
        WHERE id = ${testRunId}`;
      const result = await evidenceStore.bindSpecEvidence({
        workItemId: 'WI-101', specId: 'SPEC-003-01', harnessSlug: HARNESS,
        planSlug: 'reconnect-plan', actorId: 'su-test', evidenceKind: 'test',
        evidenceRef: 'test/reconnect.test.ts', testRunId, sourceFingerprint: 'source',
        environmentFingerprint: 'caller-cannot-create-a-receipt', details: { evidencePlane: 'live', currentMeasurement: {
          schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/reconnect.ts'],
          runtimeUnits: [wrongUnit ? 'bg-host' : `isolated-integration:${runId}`],
        } },
      });
      expect(result).toMatchObject({ status: 'created' });
      const [stored] = await db.sql`SELECT environment_fingerprint FROM harness_shared.spec_evidence_bindings`;
      const expected = testLayer !== 'unit' && hasReceipts && !wrongUnit
        ? createHash('sha256').update(JSON.stringify(receipts)).digest('hex') : null;
      expect(stored.environment_fingerprint).toBe(expected);
    });

  it('refuses isolated source paths absent from a retained source receipt at bind time', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
    const runId = '20261016T000000Z-900';
    const receipts = [{ runId, resultSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64),
      lifecycleSha256: 'c'.repeat(64) }];
    const execution = { schemaVersion: 1, root: h.repoRoot, filePath: 'test/reconnect.test.ts',
      runGroupId: null, workspaceId: WORKSPACE, harnessSlug: HARNESS, testNamePattern: null,
      testLayer: 'integration', passed: 1, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
      commitSha: null, worktreeDirty: true, isolatedRuntimeReceipts: receipts };
    await db.sql`UPDATE harness_shared.test_runs SET execution_details = ${JSON.stringify(execution)}::text::jsonb
      WHERE id = ${testRunId}`;

    const evidenceRootBase = await mkdtemp(path.join(tmpdir(), 'isolated-source-receipt-'));
    const previousEvidenceRoot = process.env.VH_EVIDENCE_ROOT_BASE;
    process.env.VH_EVIDENCE_ROOT_BASE = evidenceRootBase;
    try {
      const receiptDir = path.join(evidenceRootBase, 'isolated-integration', runId, 'phases', 'prepare');
      await mkdir(receiptDir, { recursive: true });
      await writeFile(path.join(receiptDir, 'source.json'), JSON.stringify({
        schemaVersion: 1,
        runId,
        sourceCommit: 'fixture-commit',
        repoRoot: h.repoRoot,
        filePath: 'test/reconnect.test.ts',
        files: [{ path: 'test/reconnect.test.ts', sha256: 'a'.repeat(64) }],
      }));

      const result = await evidenceStore.bindSpecEvidence({
        workItemId: 'WI-101', specId: 'SPEC-003-01', harnessSlug: HARNESS,
        planSlug: 'reconnect-plan', actorId: 'su-test', evidenceKind: 'test',
        evidenceRef: 'test/reconnect.test.ts#receipt-gap', testRunId, sourceFingerprint: 'source',
        environmentFingerprint: 'caller-cannot-create-a-receipt', details: { evidencePlane: 'live', currentMeasurement: {
          schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/reconnect.ts'],
          runtimeUnits: [`isolated-integration:${runId}`],
          completedRuntime: { kind: 'isolated-integration', runIds: [runId] },
        } },
      });
      expect(result).toMatchObject({
        status: 'completed_runtime_source_not_in_receipt',
        gaps: [{ runId, missingSourcePaths: ['src/reconnect.ts'] }],
      });
      expect((result as { message: string }).message).toContain('src/reconnect.ts');
      const rows = await db.sql`SELECT id FROM harness_shared.spec_evidence_bindings`;
      expect(rows, 'a receipt-coverage refusal must not write a binding').toHaveLength(0);
    } finally {
      if (previousEvidenceRoot === undefined) delete process.env.VH_EVIDENCE_ROOT_BASE;
      else process.env.VH_EVIDENCE_ROOT_BASE = previousEvidenceRoot;
      await rm(evidenceRootBase, { recursive: true, force: true });
    }
  });

  // EI-25847620673275477: a judge following the brief re-observes an isolated-integration
  // proof with the cited measurement and no testRunId. Before the fix the store pinned the
  // caller's environment (no run → no receipts), refused independent_fingerprint_mismatch,
  // and a row that did name the run still lacked the plane the read side certifies.
  it('adopts the cited test run, plane and run identity for an independent re-observation of an isolated run', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
    const runId = '20261013T000000Z-200';
    const receipts = [{ runId, resultSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64),
      lifecycleSha256: 'c'.repeat(64) }];
    const execution = { schemaVersion: 1, root: h.repoRoot, filePath: 'test/reconnect.test.ts',
      runGroupId: null, workspaceId: WORKSPACE, harnessSlug: HARNESS, testNamePattern: null,
      testLayer: 'integration', passed: 1, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
      commitSha: null, worktreeDirty: true, isolatedRuntimeReceipts: receipts };
    await db.sql`UPDATE harness_shared.test_runs SET execution_details = ${JSON.stringify(execution)}::text::jsonb
      WHERE id = ${testRunId}`;
    const currentMeasurement = { schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/reconnect.ts'],
      runtimeUnits: [`isolated-integration:${runId}`] };
    const testRun = { id: testRunId, filePath: 'test/reconnect.test.ts' };
    const implementer = await evidenceStore.bindSpecEvidence({
      workItemId: 'WI-101', specId: 'SPEC-003-01', harnessSlug: HARNESS, planSlug: 'reconnect-plan',
      actorId: 'su-implementer', evidenceKind: 'test', evidenceRef: 'test/reconnect.test.ts', testRunId,
      sourceFingerprint: 'source', details: { evidencePlane: 'live', testRun, currentMeasurement },
    });
    expect(implementer).toMatchObject({ status: 'created' });
    const citedId = (implementer as { id: number }).id;
    const judge = {
      workItemId: 'WI-101', specId: 'SPEC-003-01', harnessSlug: HARNESS, planSlug: 'reconnect-plan',
      actorId: 'su-judge', evidenceKind: 'independent-verification' as const, verifiesBindingId: citedId,
      evidenceRef: 'test/reconnect.test.ts', sourceFingerprint: 'source',
      environmentFingerprint: 'judge-supplied-runtime', details: { note: 'receipts re-read', currentMeasurement },
    };

    // A run other than the cited one cannot match, and the refusal names the run to use.
    const { testRunId: otherRun } = await seedExternalEvidence('test/reconnect.test.ts');
    const wrongRun = await evidenceStore.bindSpecEvidence({ ...judge, testRunId: otherRun });
    expect(wrongRun).toMatchObject({ status: 'independent_fingerprint_mismatch', mismatched: ['environment'],
      citedTestRunId: testRunId });
    expect((wrongRun as { message: string }).message).toContain(`test-run ${testRunId}`);

    const adopted = await evidenceStore.bindSpecEvidence(judge);
    expect(adopted).toMatchObject({ status: 'created' });
    const [row] = await db.sql<{ test_run_id: string; environment_fingerprint: string; details: Record<string, unknown> }[]>`
      SELECT test_run_id, environment_fingerprint, details FROM harness_shared.spec_evidence_bindings
       WHERE id = ${(adopted as { id: number }).id}`;
    expect(Number(row.test_run_id)).toBe(testRunId);
    expect(row.environment_fingerprint).toBe(createHash('sha256').update(JSON.stringify(receipts)).digest('hex'));
    expect(row.details).toMatchObject({ note: 'receipts re-read', evidencePlane: 'live', testRun });
  });

  // WI-6554700010018061: resolveFixtureAbsenceVerifications pairs a fixture-free review with its
  // cited binding on author, spec revision, test run, test fingerprint and reviewed cases, but bind
  // checked only source and environment. A review differing on any other key bound 'created' and
  // then silently never certified fixture absence. Bind now refuses it, naming each key.
  it('refuses a fixture-free independent review that fixture-absence certification would skip', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const runId = '20261020T000000Z-061';
    const receipts = [{ runId, resultSha256: 'd'.repeat(64), sourceSha256: 'e'.repeat(64),
      lifecycleSha256: 'f'.repeat(64) }];
    const execution = { schemaVersion: 1, root: h.repoRoot, filePath: 'test/reconnect.test.ts',
      runGroupId: null, workspaceId: WORKSPACE, harnessSlug: HARNESS, testNamePattern: null,
      testLayer: 'integration', passed: 1, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
      commitSha: null, worktreeDirty: true, isolatedRuntimeReceipts: receipts };
    const seedRun = async () => {
      const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
      await db.sql`UPDATE harness_shared.test_runs SET execution_details = ${JSON.stringify(execution)}::text::jsonb
        WHERE id = ${testRunId}`;
      return testRunId;
    };
    const testRunId = await seedRun();
    const currentMeasurement = { schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/reconnect.ts'],
      runtimeUnits: [`isolated-integration:${runId}`] };
    const adequacy = { fixtureFree: true, testCases: ['does not replay acknowledged event 42'] };
    const implementer = await evidenceStore.bindSpecEvidence({
      workItemId: 'WI-101', specId: 'SPEC-003-01', harnessSlug: HARNESS, planSlug: 'reconnect-plan',
      actorId: 'su-implementer', evidenceKind: 'test', evidenceRef: 'test/reconnect.test.ts', testRunId,
      sourceFingerprint: 'source', testFingerprint: 'test-file',
      details: { evidencePlane: 'live', testRun: { id: testRunId, filePath: 'test/reconnect.test.ts' },
        currentMeasurement, adequacy },
    });
    expect(implementer).toMatchObject({ status: 'created' });
    const citedId = (implementer as { id: number }).id;
    const judge = {
      workItemId: 'WI-101', specId: 'SPEC-003-01', harnessSlug: HARNESS, planSlug: 'reconnect-plan',
      actorId: 'su-judge', evidenceKind: 'independent-verification' as const, verifiesBindingId: citedId,
      evidenceRef: 'test/reconnect.test.ts', sourceFingerprint: 'source', testFingerprint: 'test-file',
      details: { note: 'fixture absence re-observed', currentMeasurement, adequacy },
    };
    const refusedWith = async (over: Partial<typeof judge> & { testRunId?: number; specRevision?: number }) => {
      const result = await evidenceStore.bindSpecEvidence({ ...judge, ...over });
      return result.status === 'fixture_absence_pairing_mismatch'
        ? (result as { mismatched: string[] }).mismatched
        : result.status;
    };

    // A different run whose receipts yield the SAME environment passes the source+environment check.
    const sameEnvironmentRun = await seedRun();
    expect(await refusedWith({ testRunId: sameEnvironmentRun })).toEqual(['test-run']);
    expect(await refusedWith({ testFingerprint: 'another-test-file' })).toEqual(['test-fingerprint']);
    expect(await refusedWith({ actorId: 'su-implementer' })).toEqual(['author']);
    expect(await refusedWith({
      details: { ...judge.details, adequacy: { fixtureFree: true, testCases: ['some other case'] } },
    })).toEqual(['test-cases']);
    const refusal = await evidenceStore.bindSpecEvidence({ ...judge, testFingerprint: 'another-test-file' });
    expect(refusal).toMatchObject({ status: 'fixture_absence_pairing_mismatch', verifiesBindingId: citedId,
      mismatched: ['test-fingerprint'] });
    expect((refusal as { message: string }).message).toContain('test-fingerprint');
    expect((refusal as { message: string }).message).toContain('details.adequacy.fixtureFree');
    expect(await db.sql`SELECT id FROM harness_shared.spec_evidence_bindings
      WHERE evidence_kind = 'independent-verification'`, 'a refused review writes nothing').toHaveLength(0);

    // Positive control: the exact re-observation still binds, adopting the cited run.
    expect(await evidenceStore.bindSpecEvidence(judge)).toMatchObject({ status: 'created' });
    // A review that makes no fixture-absence claim (the live-bar door) keeps the old checks only:
    // the same differing run the fixture-free review was refused for binds here.
    expect(await evidenceStore.bindSpecEvidence({ ...judge, testRunId: sameEnvironmentRun,
      details: { note: 'live outcome re-observed', currentMeasurement } })).toMatchObject({ status: 'created' });

    // The clause moved on: a review at the new revision cannot pair with the revision-1 proof.
    await specs.setSpecClause(clause({ mutationRequired: false, expectedRevision: 1,
      behavior: 'Acknowledged events 42 and 43 are not replayed after reconnect.' }));
    expect(await refusedWith({})).toEqual(['spec-revision']);
  });

  it('pins only matching execution-time ledger witnesses and never a binding-time caller runtime', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
    const witness = { schemaVersion: 1, units: ['bg-host'], fingerprint: 'a'.repeat(64),
      observedAt: '2026-10-07T00:00:00Z' };
    const execution = { schemaVersion: 1, root: h.repoRoot, filePath: 'test/reconnect.test.ts',
      runGroupId: null, workspaceId: WORKSPACE, harnessSlug: HARNESS, testNamePattern: null,
      passed: 1, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
      commitSha: null, worktreeDirty: true, runtimeEnvironmentBefore: witness,
      runtimeEnvironmentAfter: { ...witness, observedAt: '2026-10-07T00:01:00Z' } };
    await db.sql`UPDATE harness_shared.test_runs SET execution_details = ${JSON.stringify(execution)}::text::jsonb
      WHERE id = ${testRunId}`;
    const input = { workItemId: 'WI-101', specId: 'SPEC-003-01', harnessSlug: HARNESS,
      planSlug: 'reconnect-plan', actorId: 'su-test', evidenceKind: 'test' as const,
      evidenceRef: 'test/reconnect.test.ts', testRunId, sourceFingerprint: 'source',
      environmentFingerprint: 'caller-current-runtime', details: { evidencePlane: 'live', currentMeasurement: {
        schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/reconnect.ts'], runtimeUnits: ['bg-host'] } } };
    const first = await evidenceStore.bindSpecEvidence(input);
    expect(first).toMatchObject({ status: 'created' });
    expect(first, 'a witnessed live row carries no unproven warning').not.toHaveProperty('environmentUnproven');
    const [pinned] = await db.sql`SELECT environment_fingerprint FROM harness_shared.spec_evidence_bindings`;
    expect(pinned.environment_fingerprint).toBe(witness.fingerprint);
    execution.runtimeEnvironmentAfter.fingerprint = 'b'.repeat(64);
    await db.sql`UPDATE harness_shared.test_runs SET execution_details = ${JSON.stringify(execution)}::text::jsonb
      WHERE id = ${testRunId}`;
    const drift = await evidenceStore.bindSpecEvidence({ ...input, evidenceRef: 'test/reconnect.test.ts#drift' });
    // EI-27081440896857039: still stored (unproven by design), but the binder says so now.
    expect(drift).toMatchObject({ status: 'created', environmentUnproven: {
      reason: 'test_run_runtime_witness_missing', testRunId, runtimeUnits: ['bg-host'], evidencePlane: 'live' } });
    const [unproven] = await db.sql`SELECT environment_fingerprint FROM harness_shared.spec_evidence_bindings
      WHERE evidence_ref = 'test/reconnect.test.ts#drift'`;
    expect(unproven.environment_fingerprint).toBeNull();
    await db.sql`UPDATE harness_shared.test_runs SET execution_details = NULL WHERE id = ${testRunId}`;
    expect(await evidenceStore.bindSpecEvidence({ ...input, evidenceRef: 'test/reconnect.test.ts#historical' }))
      .toMatchObject({ status: 'created', environmentUnproven: { reason: 'test_run_runtime_witness_missing' } });
    const [historical] = await db.sql`SELECT environment_fingerprint FROM harness_shared.spec_evidence_bindings
      WHERE evidence_ref = 'test/reconnect.test.ts#historical'`;
    expect(historical.environment_fingerprint).toBeNull();
  });

  it('keeps the first test-run measurement when the same evidence is rebound to a later spec revision', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
    const measurement = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/reconnect.ts'],
      testPaths: ['test/reconnect.test.ts'],
    };
    const firstMeasurement = await evidenceStore.measureAndPinRepoFilesEvidenceAtRoot(h.repoRoot, measurement);
    const binding = {
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'test' as const,
      evidenceRef: 'test/reconnect.test.ts#same-run',
      testRunId,
      actorId: 'su-test',
    };
    const first = await evidenceStore.bindSpecEvidence({
      ...binding,
      specRevision: 1,
      sourceFingerprint: firstMeasurement.sourceFingerprint,
      testFingerprint: firstMeasurement.testFingerprint,
      details: { currentMeasurement: measurement, measurementPin: firstMeasurement.pin },
    });
    expect(first).toMatchObject({ status: 'created', specRevision: 1 });

    await writeFile(path.join(h.repoRoot, 'src', 'reconnect.ts'), 'export const reconnect = false;\n');
    const revised = await specs.setSpecClause(clause({
      expectedRevision: 1,
      mutationRequired: false,
      behavior: 'A later revision still requires evidence from its original execution state.',
    }));
    expect(revised).toMatchObject({ status: 'revised', revision: 2 });
    const reboundMeasurement = await evidenceStore.measureAndPinRepoFilesEvidenceAtRoot(h.repoRoot, measurement);
    expect(reboundMeasurement.sourceFingerprint).not.toBe(firstMeasurement.sourceFingerprint);

    const rebound = await evidenceStore.bindSpecEvidence({
      ...binding,
      specRevision: 2,
      sourceFingerprint: reboundMeasurement.sourceFingerprint,
      testFingerprint: reboundMeasurement.testFingerprint,
      details: { currentMeasurement: measurement, measurementPin: reboundMeasurement.pin },
    });
    expect(rebound).toMatchObject({ status: 'created', specRevision: 2 });

    const rows = await db.sql<Array<{
      spec_revision: number;
      source_fingerprint: string;
      details: Record<string, unknown>;
    }>>`
      SELECT spec_revision, source_fingerprint, details
        FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${WORKSPACE}
         AND harness_slug = ${HARNESS}
         AND work_item_id = 'WI-101'
         AND plan_slug = 'reconnect-plan'
         AND spec_id = 'SPEC-003-01'
         AND evidence_ref = 'test/reconnect.test.ts#same-run'
         AND test_run_id = ${testRunId}
       ORDER BY spec_revision`;
    expect(rows).toHaveLength(2);
    expect(rows[1]!.source_fingerprint).toBe(firstMeasurement.sourceFingerprint);
    expect(rows[1]!.details.measurementPin).toEqual(firstMeasurement.pin);

    const evidence = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-101'],
      specIds: ['SPEC-003-01'],
    });
    const revisionTwo = evidence.find((row) => row.specRevision === 2);
    expect(revisionTwo?.currentness).toMatchObject({
      dimensions: { source: 'stale' },
      staleReasons: expect.arrayContaining(['source-stale']),
    });
  });

  it('advises when changed binding details create a second live row for one test run', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
    const binding = {
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
      evidenceKind: 'test' as const,
      evidenceRef: 'test/reconnect.test.ts#duplicate-live',
      testRunId,
      sourceFingerprint: 'source',
      testFingerprint: 'test',
    };
    const first = await evidenceStore.bindSpecEvidence({
      ...binding,
      details: { evidencePlane: 'live', adequacy: { fixtureFree: false } },
    });
    expect(first).toMatchObject({ status: 'created' });
    const firstId = (first as { id: number }).id;
    expect(first).not.toHaveProperty('advisory');

    const rebound = await evidenceStore.bindSpecEvidence({
      ...binding,
      details: { evidencePlane: 'live', adequacy: { fixtureFree: true } },
    });
    expect(rebound).toMatchObject({
      status: 'created',
      advisory: {
        code: 'duplicate_live_test_run_bindings',
        testRunId,
        bindingIds: [firstId],
      },
    });
    const advisory = (rebound as { advisory: { message: string } }).advisory;
    expect(advisory.message).toContain('supersedeAtRevision:true');
    expect(advisory.message).toContain('plans:bind-spec-evidence retract');

    const rows = await db.sql<{ id: number }[]>`
      SELECT id
        FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${WORKSPACE}
         AND harness_slug = ${HARNESS}
         AND work_item_id = 'WI-101'
         AND plan_slug = 'reconnect-plan'
         AND spec_id = 'SPEC-003-01'
         AND spec_revision = 1
         AND evidence_kind = 'test'
         AND evidence_ref = 'test/reconnect.test.ts#duplicate-live'
         AND test_run_id = ${testRunId}
         AND retracted_at IS NULL
       ORDER BY id`;
    expect(rows.map((row) => Number(row.id))).toEqual([firstId, (rebound as { id: number }).id]);
  });

  it('refuses a same-run rebind when its measurement recipe changes', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
    const measurement = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/reconnect.ts'],
      testPaths: ['test/reconnect.test.ts'],
    };
    const firstMeasurement = await evidenceStore.measureAndPinRepoFilesEvidenceAtRoot(h.repoRoot, measurement);
    const binding = {
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'test' as const,
      evidenceRef: 'test/reconnect.test.ts#recipe-change',
      testRunId,
      actorId: 'su-test',
    };
    expect(await evidenceStore.bindSpecEvidence({
      ...binding,
      specRevision: 1,
      sourceFingerprint: firstMeasurement.sourceFingerprint,
      testFingerprint: firstMeasurement.testFingerprint,
      details: { currentMeasurement: measurement, measurementPin: firstMeasurement.pin },
    })).toMatchObject({ status: 'created' });

    const revised = await specs.setSpecClause(clause({
      expectedRevision: 1,
      mutationRequired: false,
      behavior: 'The new revision requires source that the original test did not measure.',
    }));
    expect(revised).toMatchObject({ status: 'revised', revision: 2 });
    await writeFile(path.join(h.repoRoot, 'src', 'other.ts'), 'export const other = true;\n');
    const changedMeasurement = {
      ...measurement,
      sourcePaths: ['src/other.ts', 'src/reconnect.ts'],
    };
    const changed = await evidenceStore.measureAndPinRepoFilesEvidenceAtRoot(h.repoRoot, changedMeasurement);
    const refused = await evidenceStore.bindSpecEvidence({
      ...binding,
      specRevision: 2,
      sourceFingerprint: changed.sourceFingerprint,
      testFingerprint: changed.testFingerprint,
      details: { currentMeasurement: changedMeasurement, measurementPin: changed.pin },
    });

    expect(refused).toMatchObject({
      status: 'test_run_measurement_recipe_changed',
      testRunId,
      previousSpecRevision: 1,
      specRevision: 2,
    });
    const rows = await db.sql<Array<{ spec_revision: number }>>`
      SELECT spec_revision
        FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${WORKSPACE}
         AND harness_slug = ${HARNESS}
         AND work_item_id = 'WI-101'
         AND plan_slug = 'reconnect-plan'
         AND spec_id = 'SPEC-003-01'
         AND evidence_ref = 'test/reconnect.test.ts#recipe-change'
         AND test_run_id = ${testRunId}`;
    expect(rows.map((row) => row.spec_revision)).toEqual([1]);
  });

  it('binds and remeasures a work-items live runtime from the server witness', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
    configureRuntimeVintageStore(new InMemoryRuntimeVintageStore());
    try {
      await reportRuntimeVintage({ workspaceId: WORKSPACE, unit: 'bg-host',
        treeSha: 'a'.repeat(40), pid: process.pid });
      const runtimeRows = await listRuntimeVintage(WORKSPACE);
      const fingerprint = measureRuntimeVintageEnvironment(runtimeRows, ['bg-host']);
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);

      const witness = { schemaVersion: 1, units: ['bg-host'], fingerprint: fingerprint!,
        observedAt: '2026-10-07T00:00:00Z' };
      const execution = { schemaVersion: 1, root: h.repoRoot, filePath: 'test/reconnect.test.ts',
        runGroupId: null, workspaceId: WORKSPACE, harnessSlug: HARNESS, testNamePattern: null,
        passed: 1, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
        commitSha: null, worktreeDirty: true, runtimeEnvironmentBefore: witness,
        runtimeEnvironmentAfter: { ...witness, observedAt: '2026-10-07T00:01:00Z' } };
      await db.sql`UPDATE harness_shared.test_runs SET execution_details = ${JSON.stringify(execution)}::text::jsonb
        WHERE id = ${testRunId}`;

      const measurement = { schemaVersion: 1 as const, kind: 'work-items' as const,
        workItemIds: ['WI-101'], runtimeUnits: ['bg-host'] };
      const input = { workItemId: 'WI-101', specId: 'SPEC-003-01', harnessSlug: HARNESS,
        planSlug: 'reconnect-plan', actorId: 'su-test', evidenceKind: 'test' as const,
        evidenceRef: 'test/reconnect-work-items.test.ts', testRunId, sourceFingerprint: 'source',
        environmentFingerprint: 'caller-current-runtime', details: { evidencePlane: 'live', currentMeasurement: measurement } };
      expect(await evidenceStore.bindSpecEvidence(input)).toMatchObject({ status: 'created' });

      const [pinned] = await db.sql`SELECT environment_fingerprint FROM harness_shared.spec_evidence_bindings
        WHERE evidence_ref = 'test/reconnect-work-items.test.ts'`;
      expect(pinned.environment_fingerprint).toBe(fingerprint);
      const measured = await evidenceStore.measureWorkItemsEvidenceForScope(WORKSPACE, HARNESS, measurement, runtimeRows);
      expect(measured.environmentFingerprint).toBe(fingerprint);
      const absent = await evidenceStore.measureWorkItemsEvidenceForScope(WORKSPACE, HARNESS,
        { ...measurement, runtimeUnits: ['missing-runtime'] }, runtimeRows);
      expect(absent.environmentFingerprint).toBeNull();
    } finally {
      resetRuntimeVintageStore();
    }
  });
  // WI-6554700010008521: the repo-files basis once measured runtimeUnits only at READ time, so a
  // live probe pinned to source files stored a NULL environment and could never read as current.
  it.each([
    ['manual', 'work-items'], ['operational', 'work-items'],
    ['manual', 'repo-files'], ['operational', 'repo-files'],
  ] as const)(
    'preserves the server-measured runtime for live %s proof on a %s basis without a test run', async (evidenceKind, basis) => {
      await specs.setSpecClause(clause({ mutationRequired: false }));
      configureRuntimeVintageStore(new InMemoryRuntimeVintageStore());
      try {
        await reportRuntimeVintage({ workspaceId: WORKSPACE, unit: 'bg-host',
          treeSha: 'a'.repeat(40), pid: process.pid });
        const fingerprint = measureRuntimeVintageEnvironment(await listRuntimeVintage(WORKSPACE), ['bg-host']);
        expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
        const measurement = basis === 'work-items'
          ? { schemaVersion: 1 as const, kind: 'work-items' as const, workItemIds: ['WI-101'], runtimeUnits: ['bg-host'] }
          : { schemaVersion: 1 as const, kind: 'repo-files' as const, sourcePaths: ['src/reconnect.ts'],
              runtimeUnits: ['bg-host'] };
        const binding = {
          workItemId: 'WI-101', specId: 'SPEC-003-01', evidenceKind,
          evidenceRef: `live-${evidenceKind}-${basis}-probe`, measurement, details: { evidencePlane: 'live' },
        };
        // The live-runtime fixture uses only the binder's built-in server measurements.
        // An omitted declaration must still fail closed before any binding is written.
        const undeclared = await bindTool.handler!({ harness: HARNESS, slug: 'reconnect-plan', binding }, CTX);
        expect(undeclared).toMatchObject({ data: { ok: false, results: [
          { ok: false, error: 'instrument_undeclared', instrument: null },
        ] } });
        expect(await db.sql`SELECT id FROM harness_shared.spec_evidence_bindings
          WHERE evidence_ref = ${binding.evidenceRef}`).toHaveLength(0);
        const result = await bindTool.handler!({ harness: HARNESS, slug: 'reconnect-plan', binding: {
          ...binding, details: { ...binding.details, instrument: {
            none: true, reason: 'Only the binder built-in work-item and runtime-vintage measurements are used; no external probe is run.',
          } },
        } }, CTX);
        expect(result).toMatchObject({ data: { ok: true, results: [{ ok: true, status: 'created' }] } });
        const [stored] = await db.sql`SELECT test_run_id, environment_fingerprint
          FROM harness_shared.spec_evidence_bindings WHERE evidence_ref = ${binding.evidenceRef}`;
        expect(stored.test_run_id).toBeNull();
        expect(stored.environment_fingerprint).toBe(fingerprint);
        const [proof] = await evidenceStore.listSpecEvidence({ harnessSlug: HARNESS,
          planSlugs: ['reconnect-plan'], evidenceRefs: [binding.evidenceRef] });
        expect(proof.currentness).toMatchObject({ overall: 'current', provenance: 'server-measured',
          dimensions: { environment: 'current', testRun: 'not-applicable' } });
      } finally {
        resetRuntimeVintageStore();
      }
    },
  );

  // WI-6554700010011907: a live probe against a REMOTE managed resource has no local
  // runtime-vintage row, so its environment stayed NULL and the proof could never read as
  // current. A remote unit is read from the provider's control plane at bind time and again,
  // independently, at read time; a settings change makes it stale and a failed read is unknown.
  it('stores and re-measures a remote managed-resource runtime for live manual proof', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const unit = 'gcp-cloudsql:papercusp-cloud-prod/pc-cloud-prod-pg';
    let settingsVersion: string | null = '8';
    configureRemoteRuntimeDescribe(async () => settingsVersion === null ? null : JSON.stringify({
      name: 'pc-cloud-prod-pg', project: 'papercusp-cloud-prod', createTime: '2026-10-14T03:25:36.604Z',
      databaseVersion: 'POSTGRES_18', state: 'RUNNABLE', settings: { settingsVersion },
    }));
    configureRuntimeVintageStore(new InMemoryRuntimeVintageStore());
    try {
      const fingerprint = await measureRuntimeEnvironment([], [unit]);
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
      const binding = {
        workItemId: 'WI-101', specId: 'SPEC-003-01', evidenceKind: 'manual' as const,
        evidenceRef: 'live-remote-cloudsql-probe',
        measurement: { schemaVersion: 1 as const, kind: 'repo-files' as const, sourcePaths: ['src/reconnect.ts'],
          runtimeUnits: [unit] },
        details: { evidencePlane: 'live', instrument: {
          none: true as const,
          reason: 'Only the binder built-in remote-runtime control-plane read is used; no external probe is run.',
        } },
      };
      const result = await bindTool.handler!({ harness: HARNESS, slug: 'reconnect-plan', binding }, CTX);
      const [first] = (result as { data: { results: Array<{ ok: boolean; status?: string; error?: string; message?: string }> } })
        .data.results;
      expect({ ok: first!.ok, status: first!.status, error: first!.error, message: first!.message })
        .toEqual({ ok: true, status: 'created', error: undefined, message: undefined });
      const [stored] = await db.sql`SELECT environment_fingerprint
        FROM harness_shared.spec_evidence_bindings WHERE evidence_ref = ${binding.evidenceRef}`;
      expect(stored.environment_fingerprint).toBe(fingerprint);
      const read = async () => (await evidenceStore.listSpecEvidence({ harnessSlug: HARNESS,
        planSlugs: ['reconnect-plan'], evidenceRefs: [binding.evidenceRef] }))[0]!.currentness;
      expect(await read()).toMatchObject({ overall: 'current', dimensions: { environment: 'current' } });
      settingsVersion = '9';
      expect(await read()).toMatchObject({ dimensions: { environment: 'stale' } });
      settingsVersion = null;
      expect((await read()).dimensions.environment).not.toBe('current');
    } finally {
      resetRemoteRuntimeDescribe();
      resetRuntimeVintageStore();
    }
  });

  it('keeps one shared proof reference for distinct spec clauses', async () => {
    await specs.setSpecClause(clause());
    await specs.setSpecClause(
      clause({
        specId: 'SPEC-004-01',
        sourceValId: null,
        planItemId: 'P-004',
        behavior: 'The stream closes after the terminal acknowledgement.',
      }),
    );

    const shared = {
      workItemId: 'WI-101',
      evidenceKind: 'test' as const,
      evidenceRef: 'test/reconnect.integration.ts#shared-run',
      sourceFingerprint: 'git:abc123',
      testFingerprint: 'sha256:test-v1',
    };
    const first = await evidenceStore.bindSpecEvidence({
      ...shared,
      sourceValId: 'VAL-003-01',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
    });
    const second = await evidenceStore.bindSpecEvidence({
      ...shared,
      specId: 'SPEC-004-01',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
    });

    expect(first).toMatchObject({ status: 'created', specId: 'SPEC-003-01' });
    expect(second).toMatchObject({ status: 'created', specId: 'SPEC-004-01' });
    if (!('id' in first) || !('id' in second)) {
      throw new Error('expected successful spec evidence bindings to include ids');
    }
    expect(second).not.toMatchObject({ id: first.id });

    const rows = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-101'],
      evidenceRefs: [shared.evidenceRef],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.specId).sort()).toEqual(['SPEC-003-01', 'SPEC-004-01']);
  });

  it('preserves executable details when a same-binding replay omits details', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const binding = {
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'test' as const,
      evidenceRef: 'test/reconnect.integration.ts#adequacy-replay',
      sourceFingerprint: 'git:adequacy-v1',
      testFingerprint: 'sha256:test-adequacy-v1',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
    };
    const executableDetails = {
      testExecution: {
        schemaVersion: 1,
        phase: 'settled',
        runId: 'run-adequacy-1',
        binding: { testPath: 'test/reconnect.integration.ts', testLayer: 'integration' },
      },
      adequacy: {
        outcome: 'pass',
        executed: true,
        pathReachable: true,
        oracleIndependent: true,
        testLayer: 'integration',
      },
    };
    const first = await evidenceStore.bindSpecEvidence({ ...binding, details: executableDetails });
    expect(first).toMatchObject({ status: 'created', specRevision: 1 });

    const replay = await evidenceStore.bindSpecEvidence(binding);
    expect(replay).toMatchObject({ status: 'unchanged', id: ('id' in first ? first.id : undefined) });

    const rows = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-101'],
      evidenceRefs: [binding.evidenceRef],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toEqual(executableDetails);
  });

  it('resolves legacy coversVALs, writes many-to-many exact edges, and deduplicates canonical proof', async () => {
    await specs.setSpecClause(clause());
    await specs.setSpecClause(
      clause({
        specId: 'SPEC-004-01',
        sourceValId: null,
        planItemId: 'P-004',
        behavior: 'The stream closes after the terminal acknowledgement.',
      }),
    );
    const external = await seedExternalEvidence();
    const binding = {
      workItemId: 'WI-101',
      sourceValId: 'VAL-003-01',
      evidenceKind: 'test' as const,
      evidenceRef: 'test/reconnect.integration.ts#no-replay',
      sourceFingerprint: 'git:abc123',
      testFingerprint: 'sha256:test-v1',
      fixtureFingerprint: 'sha256:fixture-v1',
      rubricFingerprint: 'sha256:adequacy-v1',
      environmentFingerprint: 'node:24-postgres:17',
      coverageEvidenceRef: external.coverageEvidenceRef,
      testRunId: external.testRunId,
      details: { z: 2, a: { y: 2, x: 1 } },
    };

    const created = (await bindTool.handler({ harness: HARNESS, slug: 'reconnect-plan', binding }, CTX)) as {
      data: { results: Array<Record<string, unknown>> };
    };
    expect(created.data.results[0]).toMatchObject({
      ok: true,
      status: 'created',
      specId: 'SPEC-003-01',
      sourceValId: 'VAL-003-01',
      specRevision: 1,
    });

    const replay = await evidenceStore.bindSpecEvidence({
      ...binding,
      details: { a: { x: 1, y: 2 }, z: 2 },
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'second-actor',
    });
    expect(replay).toMatchObject({ status: 'unchanged', id: created.data.results[0]?.id });

    await evidenceStore.bindSpecEvidence({
      ...binding,
      sourceValId: undefined,
      specId: 'SPEC-004-01',
      evidenceRef: 'test/reconnect.integration.ts#terminal-close',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
    });
    await evidenceStore.bindSpecEvidence({
      ...binding,
      workItemId: 'WI-102',
      evidenceRef: 'test/reconnect.e2e.ts#no-replay',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
    });

    const edgeCounts = await db.sql<{ edges: string; specs: string; items: string }[]>`
      SELECT count(*)::text AS edges,
             count(DISTINCT spec_id)::text AS specs,
             count(DISTINCT work_item_id)::text AS items
        FROM harness_shared.work_item_spec_revision_edges`;
    expect(edgeCounts[0]).toEqual({ edges: '3', specs: '2', items: '2' });

    const read = (await getTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        // P-007 made the default read detail:'summary', which omits sourceValId,
        // currentRevision and currentness.provenance — the very fields asserted below.
        detail: 'full',
        evidenceRefs: [binding.evidenceRef],
        current: [
          {
            evidenceKind: 'test',
            evidenceRef: binding.evidenceRef,
            sourceFingerprint: binding.sourceFingerprint,
            testFingerprint: binding.testFingerprint,
            fixtureFingerprint: binding.fixtureFingerprint,
            rubricFingerprint: binding.rubricFingerprint,
            environmentFingerprint: binding.environmentFingerprint,
          },
        ],
      } as never,
      CTX,
    )) as { data: { evidence: Array<Record<string, any>>; currentness: Record<string, number> } };
    expect(read.data.evidence[0]).toMatchObject({
      sourceValId: 'VAL-003-01',
      specRevision: 1,
      currentRevision: 1,
      currentness: {
        overall: 'unknown',
        provenance: 'attested-current',
        staleReasons: [],
        unknownReasons: ['current-fingerprints-attested-not-independently-measured'],
      },
    });
    expect(read.data.currentness).toEqual({ current: 0, stale: 0, unknown: 1 });
  });

  it('binds repository measurement recipes and recomputes currentness server-side', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const measurement = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/reconnect.ts'],
      testPaths: ['test/reconnect.test.ts'],
    };
    const created = (await bindTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        binding: {
          workItemId: 'WI-101',
          specId: 'SPEC-003-01',
          evidenceKind: 'test',
          evidenceRef: 'test/reconnect.test.ts#server-measured',
          measurement,
          testRunId: external.testRunId,
          details: { adequacy: { executed: true, skipped: false, collected: true, outcome: 'passed' } },
        },
      } as never,
      CTX,
    )) as { data: { results: Array<Record<string, unknown>> } };
    expect(created.data.results[0]).toMatchObject({ ok: true, status: 'created' });

    const [current] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: ['test/reconnect.test.ts#server-measured'],
    });
    expect(current).toMatchObject({
      details: { currentMeasurement: measurement },
      serverMeasurement: { status: 'measured' },
      currentness: {
        overall: 'current',
        provenance: 'server-measured',
        dimensions: { source: 'current', test: 'current', testRun: 'current' },
      },
    });

    await writeFile(path.join(h.repoRoot, 'src', 'reconnect.ts'), 'export const reconnect = false;\n');
    const [stale] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: ['test/reconnect.test.ts#server-measured'],
    });
    expect(stale.currentness).toMatchObject({
      overall: 'stale',
      provenance: 'server-measured',
      staleReasons: ['source-stale'],
    });
  });

  it('recomputes a registered sibling checkout recipe without widening to an arbitrary path', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const measurement = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      rootHarnessSlug: 'portal',
      sourcePaths: ['src/portal.ts'],
      testPaths: ['test/portal.test.ts'],
    };
    const created = (await bindTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        binding: {
          workItemId: 'WI-101',
          specId: 'SPEC-003-01',
          evidenceKind: 'test',
          evidenceRef: 'test/portal.test.ts#registered-sibling',
          measurement,
          testRunId: external.testRunId,
          details: { adequacy: { executed: true, skipped: false, collected: true, outcome: 'passed' } },
        },
      } as never,
      CTX,
    )) as { data: { results: Array<Record<string, unknown>> } };
    expect(created.data.results[0]).toMatchObject({ ok: true, status: 'created' });

    const [current] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: ['test/portal.test.ts#registered-sibling'],
    });
    expect(current).toMatchObject({
      details: { currentMeasurement: measurement },
      serverMeasurement: { status: 'measured' },
      currentness: { overall: 'current', provenance: 'server-measured' },
    });

    await writeFile(path.join(h.siblingRoot, 'src', 'portal.ts'), 'export const rendererTrust = false;\n');
    const [stale] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: ['test/portal.test.ts#registered-sibling'],
    });
    expect(stale.currentness).toMatchObject({
      overall: 'stale',
      provenance: 'server-measured',
      staleReasons: ['source-stale'],
    });
  });

  it('refuses a sibling measurement root that is not registered in this workspace', async () => {
    await expect(
      evidenceStore.measureRepoFilesEvidence(WORKSPACE, HARNESS, {
        schemaVersion: 1,
        kind: 'repo-files',
        rootHarnessSlug: 'not-registered',
        sourcePaths: ['src/portal.ts'],
      }),
    ).rejects.toThrow('repo_measurement_harness_root_unavailable:not-registered');
  });

  it('keeps legacy mixed repo and opaque fingerprints partially measured instead of promoting them', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const measurement = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/reconnect.ts'],
      testPaths: ['test/reconnect.test.ts'],
    };
    const measured = await evidenceStore.measureRepoFilesEvidenceAtRoot(h.repoRoot, measurement);
    await evidenceStore.bindSpecEvidence({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'test',
      evidenceRef: 'test/reconnect.test.ts#legacy-mixed-measurement',
      ...measured,
      environmentFingerprint: 'node:24-postgres:17',
      testRunId: external.testRunId,
      details: { currentMeasurement: measurement },
      actorId: 'su-legacy-fixture',
    });

    const [mixed] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: ['test/reconnect.test.ts#legacy-mixed-measurement'],
      current: [
        {
          evidenceKind: 'test',
          evidenceRef: 'test/reconnect.test.ts#legacy-mixed-measurement',
          sourceFingerprint: measured.sourceFingerprint,
          testFingerprint: measured.testFingerprint,
          environmentFingerprint: 'node:24-postgres:17',
        },
      ],
    });
    expect(mixed).toMatchObject({
      serverMeasurement: {
        status: 'measured',
        measuredDimensions: ['source', 'test'],
        attestedDimensions: ['environment'],
      },
      currentness: {
        overall: 'unknown',
        provenance: 'partially-server-measured',
        dimensions: { source: 'current', test: 'current', environment: 'current' },
        unknownReasons: [
          'current-fingerprints-partially-attested-not-independently-measured:environment',
        ],
      },
    });
  });

  it('keeps historical proof while spec and supplied fingerprints make staleness explicit', async () => {
    await specs.setSpecClause(clause());
    await evidenceStore.bindSpecEvidence({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'counterexample',
      evidenceRef: 'counterexample:duplicate-ack',
      sourceFingerprint: 'git:before',
      testFingerprint: 'sha256:test-before',
      actorId: 'su-test',
    });

    await specs.setSpecClause(clause({ expectedRevision: 1, behavior: 'Variant with a new observable boundary.' }));
    const [row] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      current: [
        {
          evidenceKind: 'counterexample',
          evidenceRef: 'counterexample:duplicate-ack',
          sourceFingerprint: 'git:after',
          testFingerprint: 'sha256:test-before',
        },
      ],
    });
    expect(row).toMatchObject({
      specRevision: 1,
      currentRevision: 2,
      currentness: {
        overall: 'stale',
        dimensions: { spec: 'stale', source: 'stale', test: 'current', fixture: 'not-applicable' },
        staleReasons: ['spec-stale', 'source-stale'],
      },
    });

    const [unknown] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: ['counterexample:duplicate-ack'],
    });
    expect(unknown.currentness.overall).toBe('stale');
    expect(unknown.currentness.unknownReasons).toEqual([
      'source-current-fingerprint-not-supplied',
      'test-current-fingerprint-not-supplied',
    ]);
  });

  // WI-10002338. The test-run lookup is tenant-scoped, so a real row in another
  // tenancy and a fabricated id both surfaced as a bare `test_run_not_found`.
  // That reads as "you invented that id" and sends the caller hunting for the
  // wrong bug — measured: it cost a full detour before the cause (harness_slug
  // NULL, because the run was started without a harness stamp) was found by
  // hand-diffing ledger rows. The diagnostic must name the discriminator.
  it('tells an unbindable out-of-scope test-run apart from a fabricated id', async () => {
    await specs.setSpecClause(clause());
    const bindArgs = {
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'test' as const,
      sourceFingerprint: 'git:abc123',
      actorId: 'su-test',
    };

    // (1) A run recorded with NO harness — what a runner started without a
    // harness stamp writes. The row is REAL and permanently unbindable.
    const [nullHarness] = await db.sql<{ id: number }[]>`
      INSERT INTO harness_shared.test_runs (workspace_id, harness_slug)
      VALUES (${WORKSPACE}, NULL) RETURNING id`;
    const nullResult = await evidenceStore.bindSpecEvidence({
      ...bindArgs,
      evidenceRef: 'test:null-harness-run',
      testRunId: Number(nullHarness.id),
    });
    expect(nullResult).toMatchObject({
      status: 'test_run_not_found',
      scopeMismatch: { foundOutsideScope: true, rowHarnessSlug: null, expectedHarnessSlug: HARNESS },
    });
    const nullHint = (nullResult as { scopeMismatch: { hint: string } }).scopeMismatch.hint;
    // The hint must name the repair, not merely restate the failure.
    expect(nullHint).toMatch(/harness_slug is NULL/);
    expect(nullHint).toContain(HARNESS);

    // (2) A run owned by a DIFFERENT harness takes the other hint branch.
    const [otherHarness] = await db.sql<{ id: number }[]>`
      INSERT INTO harness_shared.test_runs (workspace_id, harness_slug)
      VALUES (${WORKSPACE}, 'some-other-harness') RETURNING id`;
    const otherResult = await evidenceStore.bindSpecEvidence({
      ...bindArgs,
      evidenceRef: 'test:other-harness-run',
      testRunId: Number(otherHarness.id),
    });
    expect(otherResult).toMatchObject({
      status: 'test_run_not_found',
      scopeMismatch: { foundOutsideScope: true, rowHarnessSlug: 'some-other-harness' },
    });

    // (3) POSITIVE CONTROL — a genuinely absent id must NOT claim a scope
    // mismatch. Without this the diagnostic would be indistinguishable from the
    // very ambiguity it exists to remove.
    const absent = await evidenceStore.bindSpecEvidence({
      ...bindArgs,
      evidenceRef: 'test:fabricated-run',
      testRunId: 999_000_111,
    });
    expect(absent).toMatchObject({ status: 'test_run_not_found' });
    expect(absent).not.toHaveProperty('scopeMismatch');
  });

  it('preserves spec-bound test runs while detecting missing coverage and forbidding history mutation', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const [otherSurface] = await db.sql<{ id: number }[]>`
      INSERT INTO harness_shared.testing_surfaces (workspace_id, harness_slug)
      VALUES (${OTHER_WORKSPACE}, ${HARNESS}) RETURNING id`;
    const [otherCoverage] = await db.sql<{ id: number }[]>`
      INSERT INTO harness_shared.coverage_evidence (surface_ref)
      VALUES (${otherSurface.id}) RETURNING id`;

    await expect(
      evidenceStore.bindSpecEvidence({
        harnessSlug: HARNESS,
        planSlug: 'reconnect-plan',
        workItemId: 'WI-101',
        specId: 'SPEC-003-01',
        evidenceKind: 'coverage-census',
        evidenceRef: 'surface:POST /events',
        sourceFingerprint: 'git:abc123',
        coverageEvidenceRef: Number(otherCoverage.id),
        actorId: 'su-test',
      }),
    ).resolves.toMatchObject({ status: 'coverage_evidence_not_found' });

    const bound = await evidenceStore.bindSpecEvidence({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'coverage-census',
      evidenceRef: 'surface:POST /events',
      sourceFingerprint: 'git:abc123',
      coverageEvidenceRef: external.coverageEvidenceRef,
      testRunId: external.testRunId,
      actorId: 'su-test',
    });
    expect(bound.status).toBe('created');

    // NARROWED, not loosened, by migration 1174 (WI-10001850 / D-011). Forging a
    // fingerprint is still rejected — but the table is no longer refusing EVERY update,
    // so a bare /append-only/ would now also be satisfied by the re-retraction and
    // alters-another-column errors and could no longer tell this case apart. Pin the
    // specific non-retraction message instead; the retraction cases are asserted in
    // their own describe block below.
    await expect(db.sql`
      UPDATE harness_shared.spec_evidence_bindings SET source_fingerprint = 'forged'
       WHERE id = ${(bound as { id: number }).id}`)
      .rejects.toThrow(/append-only; the only permitted update is a complete retraction stamp/);
    await expect(db.sql`
      DELETE FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND work_item_id = 'WI-101'`).rejects.toThrow(/append-only/);

    await db.sql`DELETE FROM harness_shared.coverage_evidence WHERE id = ${external.coverageEvidenceRef}`;
    const [unboundRun] = await db.sql<{ id: number }[]>`
      INSERT INTO harness_shared.test_runs (workspace_id, harness_slug)
      VALUES (${WORKSPACE}, ${HARNESS}) RETURNING id`;
    const deletedRuns = await db.sql<{ id: number }[]>`
      DELETE FROM harness_shared.test_runs
       WHERE id IN (${external.testRunId}, ${unboundRun.id})
       RETURNING id`;
    expect(deletedRuns.map(({ id }) => Number(id))).toEqual([Number(unboundRun.id)]);
    const [retainedRun] = await db.sql<{ id: number }[]>`
      SELECT id FROM harness_shared.test_runs WHERE id = ${external.testRunId}`;
    expect(Number(retainedRun.id)).toBe(external.testRunId);
    const [historical] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      current: [
        {
          evidenceKind: 'coverage-census',
          evidenceRef: 'surface:POST /events',
          sourceFingerprint: 'git:abc123',
        },
      ],
    });
    expect(historical).toMatchObject({
      coverageEvidenceRef: external.coverageEvidenceRef,
      testRunId: external.testRunId,
      currentness: {
        overall: 'stale',
        staleReasons: ['coverageEvidence-stale'],
      },
    });
  });
});

/**
 * D-013: plan_slug is the clause's GROUPING namespace, not a scope boundary on
 * applicability — a work item may link to clauses in any namespace regardless of its
 * own provenance. `listWorkItemSpecRevisionEdges` therefore grew an OPTIONAL planSlug.
 *
 * The resolver's own unit tests inject readers, so they cannot see this SQL branch at
 * all; without the cases below the unscoped read is exercised by nothing against real
 * Postgres. Both directions are asserted together on purpose: "returns rows from both
 * namespaces" is only meaningful next to "the scoped read still returns exactly one".
 */
describe('cross-namespace spec revision edges (D-013)', () => {
  /** Insert one edge, taking spec_fingerprint from the revision it points at. */
  const seedEdge = (workItemId: string, planSlug: string, specId: string) => db.sql`
    INSERT INTO harness_shared.work_item_spec_revision_edges
      (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint, created_by)
    SELECT workspace_id, harness_slug, ${workItemId}, plan_slug, spec_id, revision, content_hash, 'su-test'
      FROM harness_shared.plan_spec_clause_revisions
     WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
       AND plan_slug = ${planSlug} AND spec_id = ${specId} AND revision = 1`;

  beforeEach(async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
      VALUES (${WORKSPACE}, ${HARNESS}, 'other-plan')`;
    await db.sql`
      INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq)
      VALUES (${WORKSPACE}, ${HARNESS}, 'other-plan', 'P-009', 1)`;
  });

  it('reads edges across every plan namespace when planSlug is omitted, and only one when it is not', async () => {
    await specs.setSpecClause(clause());
    await specs.setSpecClause(
      clause({
        planSlug: 'other-plan',
        specId: 'SPEC-009-01',
        sourceValId: null,
        planItemId: 'P-009',
        behavior: 'A lapsed lease is reclaimable exactly once.',
      }),
    );
    // One work item, two namespaces — the shape a standalone bug takes on once it links
    // impact outside whatever plan happened to mint it.
    // spec_fingerprint is FK-tied to the revision's content_hash (855 puts it in a unique
    // key so the edge's fingerprint is DATABASE-verified), so it must be sourced, not invented.
    await seedEdge('WI-101', 'reconnect-plan', 'SPEC-003-01');
    await seedEdge('WI-101', 'other-plan', 'SPEC-009-01');

    const all = await evidenceStore.listWorkItemSpecRevisionEdges({ harnessSlug: HARNESS, workItemId: 'WI-101' });
    expect(all.map((e) => [e.planSlug, e.specId])).toEqual([
      ['other-plan', 'SPEC-009-01'],
      ['reconnect-plan', 'SPEC-003-01'],
    ]);

    // POSITIVE CONTROL for the scoped branch: the old behaviour must be unchanged, or the
    // widening silently became "planSlug is ignored" — which no unscoped assertion can catch.
    const scoped = await evidenceStore.listWorkItemSpecRevisionEdges({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
    });
    expect(scoped.map((e) => e.specId)).toEqual(['SPEC-003-01']);
  });

  it('still scopes by work item — an unscoped plan read is not an unscoped item read', async () => {
    await specs.setSpecClause(clause());
    await seedEdge('WI-102', 'reconnect-plan', 'SPEC-003-01');

    expect(await evidenceStore.listWorkItemSpecRevisionEdges({ harnessSlug: HARNESS, workItemId: 'WI-101' })).toEqual([]);
    expect(
      await evidenceStore.listWorkItemSpecRevisionEdges({ harnessSlug: HARNESS, workItemId: 'WI-102' }),
    ).toHaveLength(1);
  });
});

describe('promotion contract join (P-006)', () => {
  it('attaches a promoted work-item to each current clause revision and is idempotent', async () => {
    const authored = await specs.setSpecClause(clause());
    expect(authored).toMatchObject({ status: 'created', revision: 1 });

    const first = await evidenceStore.ensureWorkItemSpecRevisionEdges({
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      planItemIds: ['P-003'],
      workItemId: 'WI-101',
      actorId: 'su-test',
    });
    expect(first).toEqual([
      {
        workItemId: 'WI-101',
        planSlug: 'reconnect-plan',
        specId: 'SPEC-003-01',
        specRevision: 1,
        specFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);

    const replay = await evidenceStore.ensureWorkItemSpecRevisionEdges({
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      planItemIds: ['P-003'],
      workItemId: 'WI-101',
      actorId: 'su-test',
    });
    expect(replay).toEqual(first);
    expect(
      await evidenceStore.listWorkItemSpecRevisionEdges({ harnessSlug: HARNESS, workItemId: 'WI-101' }),
    ).toEqual(first);
  });
});

/**
 * SPEC-P006-FAILED-SCENARIO-RERUN@1, integration layer (requiredTestLayers: integration + unit).
 *
 * The unit control for this guard hands `deps.list` a hand-built prior row, so it proves the
 * DECISION and nothing about the READ. The step it cannot reach is the one that actually has
 * to work here: `readSiblingEvidence` has to find the previous run's settled row through the
 * REAL `listSpecEvidence` query, against real Postgres, with fingerprints really measured off
 * disk — scoped by harness, plan, work item, spec, kind, and pinned to the same spec REVISION.
 *
 * That read failing is INVISIBLE to the falsifier arm on its own: `listSpecEvidence` throwing,
 * or simply matching nothing, resolves to `no-sibling-evidence`, which is ALSO `full-matrix`
 * and ALSO lands phase `stale-sibling-evidence`. A broken query and a correctly-detected stale
 * carry are indistinguishable at the phase. So the currency arm below is not decoration: it is
 * the only assertion that can tell "the guard fired because the row was stale" apart from "the
 * guard fired because the row was never found", and it must pass BEFORE and AFTER the fix.
 */
describe('narrowed reruns carry sibling scenarios only from a CURRENT ledger row (SPEC-P006-FAILED-SCENARIO-RERUN)', () => {
  const testPath = 'test/matrix.test.ts';
  const sourcePath = 'src/matrix.ts';
  const SCENARIOS = ['boot', 'retry', 'teardown', 'recover'];
  const PRIOR_RUN = 'aa4c9d0e-6d41-4a7e-9a1f-2b7d1c5e8f30';
  const RERUN = 'bb51e7c2-90d3-4f28-8c6a-3e9f0a4d7b11';

  beforeEach(async () => {
    await writeFile(path.join(h.repoRoot, sourcePath), 'export const matrix = true;\n');
    await writeFile(path.join(h.repoRoot, testPath), 'expect(matrix).toBe(true);\n');
    await specs.setSpecClause(clause({ mutationRequired: false }));
  });

  async function harness() {
    const { prepareTestEvidence, finishTestEvidence } = await import('../testing/evidence');
    const { readHarnessTestRunEvidence, countUnattributedTestRunRows } = await import('../../testing-run-store');
    const scope = { workspaceId: WORKSPACE, harnessSlug: HARNESS, actorId: 'su-test', root: h.repoRoot };
    const deps = {
      bind: evidenceStore.bindSpecEvidence,
      measure: evidenceStore.measureRepoFilesEvidenceAtRoot,
      // The REAL query — the whole point of exercising this at the integration layer.
      list: evidenceStore.listSpecEvidence,
      ledger: (args: Parameters<typeof readHarnessTestRunEvidence>[0]) => readHarnessTestRunEvidence({
        ...args, sql: h.sql as unknown as NonNullable<Parameters<typeof readHarnessTestRunEvidence>[0]['sql']>,
      }),
      unattributed: countUnattributedTestRunRows,
    };
    /** One run of the matrix file. `pattern` undefined = the unfiltered whole-file run. */
    const run = async (opts: { runId: string; pattern?: string; scenarioIds?: string[] }) => {
      const ids = opts.scenarioIds ?? SCENARIOS;
      const executed = opts.pattern ? 1 : ids.length;
      const prepared = await prepareTestEvidence({
        workItemId: 'WI-101', planSlug: 'reconnect-plan',
        bindings: [{ specId: 'SPEC-003-01', specRevision: 1, testPath, sourcePaths: [sourcePath],
          testLayer: 'integration' as const, scenarioIds: ids }],
      }, opts.runId, [testPath], scope, deps);
      await db.sql`INSERT INTO harness_shared.test_runs
        (workspace_id,harness_slug,file_path,status,finished_at,run_group_id)
        VALUES (${WORKSPACE},${HARNESS},${testPath},'pass',now(),${opts.runId})`;
      const result = {
        ok: true as const, runId: opts.runId, root: h.repoRoot, files: 1,
        passed: executed, failed: 0, skipped: ids.length - executed,
        failures: [], failuresTruncated: false, durationMs: 1,
        byFile: { [testPath]: { passed: executed, failed: 0, skipped: ids.length - executed, collectionFailed: false } },
        ...(opts.pattern ? { testNamePattern: opts.pattern } : {}),
      };
      return finishTestEvidence(prepared, opts.runId, opts.runId, scope, result, deps);
    };
    /**
     * The persisted row the guard has to re-read, as the REAL store returns it.
     *
     * The store types `details` as opaque `Record<string, unknown>` — it is jsonb, and it is
     * not this module's job to know what a caller put there. The shape THIS spec asserts on is
     * therefore named once, at the single point the opaque value is read back, rather than
     * re-asserted at each call site: four separate casts would let the recorded shape drift
     * while four assertions kept passing against four independent descriptions of it.
     */
    type PersistedDetails = {
      testExecution: {
        phase?: string; testNamePattern?: string; sourceStable?: boolean; siblingEvidenceRef?: string;
        rerunScope?: { scope?: string; reason?: string; carried?: string[]; stale?: string[] };
      };
      adequacy: { outcome?: string; executed?: boolean; scenarioIds?: string[] };
    };
    const persisted = async (runId: string) => {
      const rows = await evidenceStore.listSpecEvidence({
        harnessSlug: HARNESS, planSlugs: ['reconnect-plan'], workItemIds: ['WI-101'],
        specIds: ['SPEC-003-01'], evidenceKinds: ['test'], limit: 50,
      });
      const row = rows.find(candidate => String(candidate.evidenceRef).includes(runId));
      return row && { ...row, details: row.details as PersistedDetails };
    };
    return { run, persisted };
  }

  /** Edit the source AFTER the prior run settled: its recorded fingerprint now trails disk. */
  const editSourceAfterPriorRun = () =>
    writeFile(path.join(h.repoRoot, sourcePath), 'export const matrix = "edited after the matrix run";\n');

  // CURRENCY ARM / CALIBRATION. Must pass before AND after the fix. It is the only assertion
  // that proves the real query RESOLVED the sibling row — without it, a query that silently
  // matches nothing makes the falsifier arm below green for entirely the wrong reason.
  it('settles a narrowed rerun and names the real prior row it carried', async () => {
    const { run, persisted } = await harness();
    const prior = await run({ runId: PRIOR_RUN });
    expect(prior.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass' });

    const bundle = await run({ runId: RERUN, pattern: 'recover' });
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass' });
    expect(bundle).toHaveProperty('verificationFingerprint', expect.any(String));

    const settled = await persisted(RERUN);
    const priorRow = await persisted(PRIOR_RUN);
    expect(settled!.details.testExecution).toMatchObject({
      testNamePattern: 'recover',
      rerunScope: { scope: 'failed-scenario', reason: 'sibling-evidence-current', carried: SCENARIOS, stale: [] },
      // Read back through the store, so this is the ROW the query found — not a fake.
      siblingEvidenceRef: priorRow!.evidenceRef,
    });
  });

  // FALSIFIER ARM. The identical rerun with ONE variable moved: the source on disk changed
  // after the prior run recorded its proof, so the sibling scenarios' evidence no longer
  // describes the code under test and may not be carried.
  it('refuses to carry the remaining matrix once the prior row trails disk', async () => {
    const { run, persisted } = await harness();
    expect((await run({ runId: PRIOR_RUN })).rows[0]).toMatchObject({ phase: 'settled' });
    await editSourceAfterPriorRun();

    const bundle = await run({ runId: RERUN, pattern: 'recover' });
    expect(bundle.rows[0]).toMatchObject({ phase: 'stale-sibling-evidence', outcome: 'unknown' });
    expect(bundle).toHaveProperty('verificationFingerprint', null);

    const refused = await persisted(RERUN);
    expect(refused!.details.adequacy).toMatchObject({ outcome: 'unknown', executed: false });
    // `reason` and `stale` are load-bearing: a query that found NOTHING would report
    // `no-sibling-evidence` with an empty `stale`, at this very same phase.
    expect(refused!.details.testExecution.rerunScope).toMatchObject({
      scope: 'full-matrix', reason: 'stale-sibling-evidence', stale: ['source'], carried: [],
    });
    // The pre-existing prepare-vs-finish check cannot cover this case and must not be
    // credited with it: both measurements happen AFTER the edit, so the source looks stable.
    expect(refused!.details.testExecution.sourceStable).toBe(true);
  });

  // CALIBRATION. The guard must fire on the NARROWING, not on a stale prior row alone. An
  // unfiltered run re-measures the whole matrix itself, so it carries nothing and must still
  // settle against the very same stale row. Without this, an implementation that simply
  // refused any stale prior row would pass both arms above while taxing every ordinary rerun —
  // which is precisely the saving this plan exists to produce.
  it('still settles an UNFILTERED rerun against that same stale prior row', async () => {
    const { run, persisted } = await harness();
    expect((await run({ runId: PRIOR_RUN })).rows[0]).toMatchObject({ phase: 'settled' });
    await editSourceAfterPriorRun();

    const bundle = await run({ runId: RERUN });
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass' });
    expect(bundle).toHaveProperty('verificationFingerprint', expect.any(String));
    expect((await persisted(RERUN))!.details.testExecution.rerunScope).toBeUndefined();
  });

  // CALIBRATION. A binding claiming ONE scenario has no remaining matrix to carry, so the
  // narrowed run measured everything it claims and settles against the same stale row.
  it('still settles a single-scenario narrowed rerun against that same stale prior row', async () => {
    const { run, persisted } = await harness();
    expect((await run({ runId: PRIOR_RUN })).rows[0]).toMatchObject({ phase: 'settled' });
    await editSourceAfterPriorRun();

    const bundle = await run({ runId: RERUN, pattern: 'recover', scenarioIds: ['recover'] });
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass' });
    expect(bundle).toHaveProperty('verificationFingerprint', expect.any(String));
    expect((await persisted(RERUN))!.details.testExecution.rerunScope).toBeUndefined();
  });
});

/**
 * Migration 1174 / WI-10001850 / decision D-011.
 *
 * The adequacy evaluator scans EVERY bound row for a (spec, revision) cohort and fails
 * the clause if ANY row names an uncollected/unexecuted run or has gone stale. Bindings
 * are append-only with no DISTINCT ON in the loader, so appending a corrected row cannot
 * outrank a bad one, and spec_revision is the only partitioning dimension — which left
 * bumping a clause revision purely to shed failing evidence as the only escape. D-011
 * forbids that as gate evasion. A recorded retraction is the sanctioned repair, so these
 * cases pin BOTH halves: the one mutation now permitted, and every mutation still refused.
 */
describe('recorded retraction is the one sanctioned repair for a malformed binding (D-011)', () => {
  const RETRACTOR = 'su-retraction-integration';

  async function bindOne(): Promise<number> {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const bound = await evidenceStore.bindSpecEvidence({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'coverage-census',
      evidenceRef: 'surface:POST /events',
      sourceFingerprint: 'git:abc123',
      coverageEvidenceRef: external.coverageEvidenceRef,
      testRunId: external.testRunId,
      actorId: 'su-test',
    });
    expect(bound.status).toBe('created');
    return Number((bound as { id: number }).id);
  }

  const visibleIds = async (includeRetracted?: boolean): Promise<number[]> =>
    (
      await evidenceStore.listSpecEvidence({
        harnessSlug: HARNESS,
        planSlugs: ['reconnect-plan'],
        workItemIds: ['WI-101'],
        ...(includeRetracted === undefined ? {} : { includeRetracted }),
      })
    ).map((r) => Number((r as { id: number }).id));

  /**
   * THE REPAIR MUST ACTUALLY REPAIR. Retracting a malformed binding is only half of D-011's
   * sanctioned path; the other half is binding the corrected evidence afterwards. Migration
   * 1174 left spec_evidence_bindings_dedup a TOTAL unique index, so a retracted row kept its
   * dedup slot: the re-bind's `INSERT ... ON CONFLICT DO NOTHING` returned nothing, the
   * writer's fallback lookup matched that one retracted row (the index is unique over exactly
   * those columns, so it can match nothing else), and the call answered 'unchanged' naming it.
   * The caller was told the evidence was bound while every default reader excluded it — silent
   * success with zero live evidence, which is the undiagnosable state D-011 exists to end.
   *
   * Migration 1175 scopes the index to `retracted_at IS NULL` so a withdrawn row releases its
   * slot, and the writer's fallback lookup gained the matching filter. Binding the SAME payload
   * twice is the whole point of this test: a fresh testRunId would produce a different
   * binding_fingerprint and never reach the dedup path at all, which is why `bindOne` above
   * (it re-seeds external evidence per call) cannot be reused here.
   */
  it('lets identical evidence be re-bound after a retraction instead of deduping onto the withdrawn row', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const identical = {
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'coverage-census' as const,
      evidenceRef: 'surface:POST /events',
      sourceFingerprint: 'git:abc123',
      coverageEvidenceRef: external.coverageEvidenceRef,
      testRunId: external.testRunId,
      actorId: 'su-test',
    };

    const first = await evidenceStore.bindSpecEvidence(identical);
    expect(first.status).toBe('created');
    const firstId = Number((first as { id: number }).id);

    // Positive control for the dedup path itself. While the row is LIVE the same payload must
    // still dedup onto it — otherwise the re-bind below would be proving only that two
    // different payloads insert twice, which says nothing about retraction.
    const replay = await evidenceStore.bindSpecEvidence(identical);
    expect(replay.status).toBe('unchanged');
    expect(Number((replay as { id: number }).id)).toBe(firstId);

    const withdrawn = await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS,
      bindingId: firstId,
      reason: 'bound run was never collected or executed',
      actorId: RETRACTOR,
    });
    expect(withdrawn.status).toBe('retracted');

    const rebound = await evidenceStore.bindSpecEvidence(identical);
    expect(rebound.status).toBe('created');
    const reboundId = Number((rebound as { id: number }).id);
    expect(reboundId).not.toBe(firstId);

    // The decisive assertion: the default read carries LIVE proof again. Before 1175 this read
    // was empty for this binding while the call above reported success.
    const live = await visibleIds();
    expect(live).toContain(reboundId);
    expect(live).not.toContain(firstId);
    // The withdrawal itself stays auditable — the repair adds a row, it never erases one.
    expect(await visibleIds(true)).toContain(firstId);
  });

  it('repairs an incomplete automatic fixture recipe only after attributable withdrawal, retaining the original receipt and history', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const { testRunId } = await seedExternalEvidence('test/reconnect.test.ts');
    const originalRecipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/reconnect.ts'],
      testPaths: ['test/reconnect.test.ts'],
    };
    const original = await evidenceStore.measureAndPinRepoFilesEvidenceAtRoot(h.repoRoot, originalRecipe);
    const identity = {
      harnessSlug: HARNESS, planSlug: 'reconnect-plan', workItemId: 'WI-101',
      specId: 'SPEC-003-01', specRevision: 1, evidenceKind: 'test' as const,
      evidenceRef: 'test/reconnect.test.ts', testRunId,
    };
    const first = await evidenceStore.bindSpecEvidence({
      ...identity,
      sourceFingerprint: original.sourceFingerprint,
      testFingerprint: original.testFingerprint,
      details: { currentMeasurement: originalRecipe, measurementPin: original.pin },
      actorId: 'system:spec-evidence-autobind',
    });
    expect(first).toMatchObject({ status: 'created' });
    const firstId = Number((first as { id: number }).id);
    const correctedRecipe = { ...originalRecipe, fixturePaths: ['test/reconnect.test.ts'] };
    const corrected = await evidenceStore.measureAndPinRepoFilesEvidenceAtRoot(h.repoRoot, correctedRecipe);
    expect(corrected.sourceFingerprint).toBe(original.sourceFingerprint);
    expect(corrected.testFingerprint).toBe(original.testFingerprint);
    expect(corrected.fixtureFingerprint).toBeTruthy();
    const replacement = {
      ...identity,
      sourceFingerprint: corrected.sourceFingerprint,
      testFingerprint: corrected.testFingerprint,
      fixtureFingerprint: corrected.fixtureFingerprint,
      details: { currentMeasurement: correctedRecipe, measurementPin: corrected.pin },
      actorId: RETRACTOR,
    };

    // The ordinary immutable-recipe guard must keep refusing this live-row update.
    expect(await evidenceStore.bindSpecEvidence(replacement)).toMatchObject({
      status: 'test_run_measurement_recipe_changed', testRunId,
    });
    expect(await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS, bindingId: firstId, actorId: RETRACTOR,
      reason: 'automatic first binding omitted the authored inline fixture measurement',
    })).toMatchObject({ status: 'retracted', bindingId: firstId });
    const rebound = await evidenceStore.bindSpecEvidence(replacement);
    expect(rebound).toMatchObject({ status: 'created' });
    const reboundId = Number((rebound as { id: number }).id);
    expect(await visibleIds()).toEqual([reboundId]);
    expect(await visibleIds(true)).toEqual(expect.arrayContaining([firstId, reboundId]));

    const rows = await db.sql`
      SELECT id, test_run_id, source_fingerprint, test_fingerprint, fixture_fingerprint,
             details, created_by, retracted_by, retraction_reason
        FROM harness_shared.spec_evidence_bindings
       WHERE id IN (${firstId}, ${reboundId}) ORDER BY id`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: firstId, test_run_id: testRunId,
      source_fingerprint: original.sourceFingerprint, test_fingerprint: original.testFingerprint,
      fixture_fingerprint: null, created_by: 'system:spec-evidence-autobind',
      retracted_by: RETRACTOR,
      retraction_reason: 'automatic first binding omitted the authored inline fixture measurement',
      details: { currentMeasurement: originalRecipe },
    });
    expect(rows[1]).toMatchObject({
      id: reboundId, test_run_id: testRunId,
      source_fingerprint: original.sourceFingerprint, test_fingerprint: original.testFingerprint,
      fixture_fingerprint: corrected.fixtureFingerprint, retracted_by: null,
      details: { currentMeasurement: correctedRecipe },
    });
  });

  it('accepts one complete stamp, then hides the row from default reads but not from an audit read', async () => {
    const id = await bindOne();
    expect(await visibleIds()).toContain(id);

    const result = await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS,
      bindingId: id,
      reason: 'bound run was never collected or executed',
      actorId: RETRACTOR,
    });
    expect(result.status).toBe('retracted');
    // "Returns it in full" is the point of the audit read — a retraction must never be an
    // unattributable disappearance, so assert the recorded author and cause, not just the id.
    expect(result.binding).toMatchObject({
      retracted_by: RETRACTOR,
      retraction_reason: 'bound run was never collected or executed',
    });
    expect(result.binding?.retracted_at).toBeTruthy();

    // The default read is what the evaluator consumes: the bad row must stop counting.
    expect(await visibleIds()).not.toContain(id);
    expect(await visibleIds(false)).not.toContain(id);
    expect(await visibleIds(true)).toContain(id);

    // The row is hidden, never deleted — the withdrawn claim stays auditable.
    const [row] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.spec_evidence_bindings WHERE id = ${id}`;
    expect(row.n).toBe(1);
  });

  it('routes a private retraction through MCP and a refused fresh connection never dispatches', async () => {
    // getOrgPg is mocked to this disposable database for this suite. The MCP server below
    // calls the maintained handler imported from the current checkout; it never contacts
    // the shared :3170 operator or its workspace data.
    expect(h.sql).toBe(db.sql);
    const retractedId = await bindOne();
    const protectedExternal = await seedExternalEvidence();
    const protectedBinding = await evidenceStore.bindSpecEvidence({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'coverage-census',
      evidenceRef: 'surface:private-control',
      sourceFingerprint: 'git:private-control',
      coverageEvidenceRef: protectedExternal.coverageEvidenceRef,
      testRunId: protectedExternal.testRunId,
      actorId: 'su-test',
    });
    expect(protectedBinding.status).toBe('created');
    const protectedId = Number((protectedBinding as { id: number }).id);
    expect(protectedId).not.toBe(retractedId);
    expect(await visibleIds()).toEqual(expect.arrayContaining([retractedId, protectedId]));

    const hosts: Array<{ host: McpServer; transport: StreamableHTTPServerTransport }> = [];
    const toolDispatches: string[] = [];
    const serverErrors: unknown[] = [];
    const http = createHttpServer(async (request, response) => {
      if (request.headers.authorization !== 'Bearer private-spec-evidence-fixture') {
        response.writeHead(401).end();
        return;
      }
      const host = new McpServer(
        { name: 'private-spec-evidence-retraction', version: '1' },
        { capabilities: { tools: {} } },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      hosts.push({ host, transport });
      host.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{
          name: bindTool.name,
          description: 'Private isolated retraction fixture',
          inputSchema: {
            type: 'object',
            properties: {
              harness: { type: 'string' },
              slug: { type: 'string' },
              retract: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { bindingId: { type: 'number' }, reason: { type: 'string' } },
                  required: ['bindingId', 'reason'],
                },
              },
            },
            required: ['harness', 'retract'],
          },
        }],
      }));
      host.server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name !== bindTool.name) throw new Error('unexpected_fixture_tool');
        toolDispatches.push(request.params.name);
        const result = await bindTool.handler!(request.params.arguments as never, CTX);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      });
      try {
        await host.connect(transport);
        await transport.handleRequest(request, response);
      } catch (error) {
        serverErrors.push(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing_private_mcp_port');
    const url = new URL('/api/mcp', `http://127.0.0.1:${address.port}`);
    const closeHttp = async () => {
      await Promise.allSettled(hosts.map(async ({ host, transport }) => {
        await host.close();
        await transport.close();
      }));
      http.closeAllConnections();
      if (http.listening) {
        await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
      }
    };
    const client = new Client({ name: 'private-spec-evidence-retraction', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: 'Bearer private-spec-evidence-fixture' } },
      }));
      const result = await client.callTool({
        name: bindTool.name,
        arguments: {
          harness: HARNESS,
          slug: 'reconnect-plan',
          retract: [{ bindingId: retractedId, reason: 'private MCP transport fixture retraction' }],
        },
      });
      expect(result.isError).not.toBe(true);
      expect(toolDispatches).toEqual([bindTool.name]);
      expect(await visibleIds()).not.toContain(retractedId);
      expect(await visibleIds()).toContain(protectedId);
    } finally {
      await Promise.allSettled([client.close()]);
      await closeHttp();
    }

    const refusedClient = new Client({ name: 'private-spec-evidence-refused-client', version: '1.0.0' });
    try {
      await expect(refusedClient.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: 'Bearer private-spec-evidence-fixture' } },
      }))).rejects.toThrow();
    } finally {
      await Promise.allSettled([refusedClient.close()]);
    }
    expect(toolDispatches).toEqual([bindTool.name]);
    expect(await visibleIds()).toContain(protectedId);
    expect(await visibleIds(true)).toContain(retractedId);
    expect(serverErrors).toEqual([]);
  }, 30_000);

  it('refuses a second retraction, so the recorded author and reason are final', async () => {
    const id = await bindOne();
    await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS, bindingId: id, reason: 'first and only withdrawal', actorId: RETRACTOR,
    });

    // The store reports the benign replay as a status rather than surfacing an opaque 55000.
    const replay = await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS, bindingId: id, reason: 'rewriting history', actorId: 'su-someone-else',
    });
    expect(replay.status).toBe('already_retracted');
    expect(replay.binding).toMatchObject({
      retracted_by: RETRACTOR,
      retraction_reason: 'first and only withdrawal',
    });

    // …and the trigger refuses it underneath, so a raw writer cannot rewrite it either.
    await expect(db.sql`
      UPDATE harness_shared.spec_evidence_bindings
         SET retracted_at = now(), retracted_by = 'su-forger', retraction_reason = 'rewritten'
       WHERE id = ${id}`).rejects.toThrow(/already retracted; a retraction is one-way/);
  });

  it('refuses a retraction that alters any other column, and still refuses DELETE', async () => {
    const id = await bindOne();

    await expect(db.sql`
      UPDATE harness_shared.spec_evidence_bindings
         SET retracted_at = now(), retracted_by = ${RETRACTOR},
             retraction_reason = 'smuggling a fingerprint rewrite',
             source_fingerprint = 'forged'
       WHERE id = ${id}`).rejects.toThrow(/may not alter any other column/);

    await expect(db.sql`
      DELETE FROM harness_shared.spec_evidence_bindings WHERE id = ${id}`)
      .rejects.toThrow(/append-only; append a new exact evidence binding/);

    // Neither refusal left a mark: the row is untouched and still live proof.
    const [row] = await db.sql<{ source_fingerprint: string; retracted_at: Date | null }[]>`
      SELECT source_fingerprint, retracted_at
        FROM harness_shared.spec_evidence_bindings WHERE id = ${id}`;
    expect(row).toMatchObject({ source_fingerprint: 'git:abc123', retracted_at: null });
  });

  it('refuses a half-written stamp at BOTH rails — the trigger, and the CHECK beneath it', async () => {
    const id = await bindOne();

    // Rail 1, the trigger, which is what a real writer meets first.
    await expect(db.sql`
      UPDATE harness_shared.spec_evidence_bindings SET retracted_at = now()
       WHERE id = ${id}`).rejects.toThrow(/only permitted update is a complete retraction stamp/);

    // Rail 2, the CHECK. The trigger SHADOWS it for every update, so without disabling the
    // trigger this constraint is asserted by nothing and its absence would be invisible —
    // exactly the untested defence-in-depth claim this suite exists to keep honest.
    await db.sql.unsafe(
      'ALTER TABLE harness_shared.spec_evidence_bindings DISABLE TRIGGER spec_evidence_bindings_immutable',
    );
    try {
      await expect(db.sql`
        UPDATE harness_shared.spec_evidence_bindings SET retracted_at = now()
         WHERE id = ${id}`).rejects.toThrow(/spec_evidence_bindings_retraction_complete/);
      // A blank author or reason is half-written too, not a complete stamp.
      await expect(db.sql`
        UPDATE harness_shared.spec_evidence_bindings
           SET retracted_at = now(), retracted_by = '  ', retraction_reason = 'stated cause'
         WHERE id = ${id}`).rejects.toThrow(/spec_evidence_bindings_retraction_complete/);
    } finally {
      await db.sql.unsafe(
        'ALTER TABLE harness_shared.spec_evidence_bindings ENABLE TRIGGER spec_evidence_bindings_immutable',
      );
    }

    expect(await visibleIds()).toContain(id);
  });

  it('reports an unknown binding rather than silently succeeding', async () => {
    const missing = await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS, bindingId: 2_147_000_001, reason: 'no such row', actorId: RETRACTOR,
    });
    expect(missing).toMatchObject({ status: 'not_found', binding: null });
  });

  /* Hiding a retraction from READS is only half the repair. `carryUnchangedBarEvidenceBindings`
   * is the one reader outside this store that does not merely READ the table — it re-INSERTS
   * prior-revision rows under the next revision on every bar amendment. Unfiltered, it would
   * therefore RESURRECT a retracted binding as a fresh, un-retracted row, silently undoing the
   * repair at a later revision bump that nobody would connect to the retraction. That is worse
   * than never retracting: the clause goes green in between, and a green verdict is exactly what
   * stops anyone looking. D-011 makes recorded retraction the ONLY sanctioned repair, so a carry
   * that reverses one defeats the whole path. */
  it('does not resurrect a retracted binding when a bar amendment carries proof forward', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const bind = async (evidenceRef: string): Promise<number> => {
      const bound = await evidenceStore.bindSpecEvidence({
        harnessSlug: HARNESS,
        planSlug: 'reconnect-plan',
        workItemId: 'WI-101',
        specId: 'SPEC-003-01',
        evidenceKind: 'coverage-census',
        evidenceRef,
        sourceFingerprint: 'git:abc123',
        coverageEvidenceRef: external.coverageEvidenceRef,
        testRunId: external.testRunId,
        actorId: 'su-test',
      });
      expect(bound.status).toBe('created');
      return Number((bound as { id: number }).id);
    };

    const poisoned = await bind('surface:POST /events');
    // POSITIVE CONTROL, and it is load-bearing: a carry of 0 is ambiguous on its own, because
    // "the retraction filter worked" and "the carry matched nothing at all" (a mis-seeded edge,
    // the wrong prior revision, a broken join) produce an identical reading. The surviving row
    // proves the carry ran, saw this cohort, and rejected only the retracted member.
    await bind('surface:GET /events');

    const withdrawn = await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS,
      bindingId: poisoned,
      reason: 'bound run was never collected or executed',
      actorId: RETRACTOR,
    });
    expect(withdrawn.status).toBe('retracted');

    // Amend the clause (revision 1 -> 2) and attach the work-item to the NEW revision: that
    // edge is what the carry joins through, so without it nothing is eligible to carry.
    const amended = await specs.setSpecClause(
      clause({
        expectedRevision: 1,
        behavior: 'Acknowledged event 42 is not replayed after reconnect, even across a restart.',
      }),
    );
    expect(amended.status).not.toBe('conflict');
    const [next] = await db.sql<{ revision: number; content_hash: string }[]>`
      SELECT revision, content_hash FROM harness_shared.plan_spec_clause_revisions
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01'
       ORDER BY revision DESC LIMIT 1`;
    expect(Number(next.revision)).toBe(2);
    await db.sql`
      INSERT INTO harness_shared.work_item_spec_revision_edges
        (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision,
         spec_fingerprint, created_by)
      VALUES (${WORKSPACE}, ${HARNESS}, 'WI-101', 'reconnect-plan', 'SPEC-003-01',
              ${next.revision}, ${next.content_hash}, 'su-test')
      ON CONFLICT DO NOTHING`;

    const carried = await carryUnchangedBarEvidenceBindings(db.sql, {
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specId: 'SPEC-003-01',
      priorRevision: 1,
      nextRevision: Number(next.revision),
      nextSpecFingerprint: next.content_hash,
    });
    expect(carried).toBe(1);

    const landed = (
      await db.sql<{ evidence_ref: string }[]>`
        SELECT evidence_ref FROM harness_shared.spec_evidence_bindings
         WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
           AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01'
           AND spec_revision = ${next.revision}
         ORDER BY evidence_ref`
    ).map((row) => row.evidence_ref);
    expect(landed).toEqual(['surface:GET /events']);
    expect(landed).not.toContain('surface:POST /events');

    // And the withdrawal itself is still the only record of that proof: the retracted row stays
    // retracted at its own revision rather than being joined by an un-retracted twin.
    const [{ count }] = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01'
         AND evidence_ref = 'surface:POST /events' AND retracted_at IS NULL`;
    expect(Number(count)).toBe(0);
  });
});

/**
 * P-019 (review-system-rework-reduction-2026-09-23, RSR-P-019-A). The adequacy evaluator grades
 * every live row at a clause revision, so fresh sufficient proof could not rescue a clause while an
 * older failing row stood beside it (R-11: 13 rows retracted by hand). `supersedeAtRevision:true`
 * withdraws the same-kind siblings in one statement — and only when the new row is itself proof.
 */
describe('supersedeAtRevision withdraws same-kind siblings at the clause revision (P-019)', () => {
  const PASSED = { collected: true, skipped: false, executed: true, outcome: 'passed', testLayer: 'integration' };

  async function bindViaTool(binding: Record<string, unknown>, supersedeAtRevision?: boolean) {
    const out = (await bindTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        binding: { workItemId: 'WI-101', specId: 'SPEC-003-01', sourceFingerprint: 'git:abc123', ...binding },
        ...(supersedeAtRevision === undefined ? {} : { supersedeAtRevision }),
      } as never,
      CTX,
    )) as { data: { results: Array<{ ok: boolean; id?: number }>; supersession?: unknown[] } };
    expect(out.data.results[0]?.ok).toBe(true);
    return { id: Number(out.data.results[0]!.id), supersession: out.data.supersession };
  }

  async function liveIds(): Promise<number[]> {
    return (
      await evidenceStore.listSpecEvidence({
        harnessSlug: HARNESS,
        planSlugs: ['reconnect-plan'],
        workItemIds: ['WI-101'],
      })
    ).map((row) => Number((row as { id: number }).id));
  }

  const REPLAY_TEST = 'test/reconnect.integration.test.ts';
  const REPLAY_UNIT_TEST = 'test/reconnect.test.ts';

  async function markRunAsPassing(
    testRunId: number,
    filePath: string,
    caseTitle: string,
    testLayer: 'unit' | 'integration' = 'integration',
  ) {
    const executionDetails = {
      schemaVersion: 1,
      root: h.repoRoot,
      filePath,
      runGroupId: null,
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      testNamePattern: null,
      passed: 1,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha: 'c0ffee1234567890',
      worktreeDirty: false,
      testLayer,
      passedCaseTitles: [caseTitle],
    };
    await db.sql`UPDATE harness_shared.test_runs
      SET status = 'pass', finished_at = now(), execution_details = ${db.sql.json(executionDetails)}
      WHERE id = ${testRunId}`;
  }

  it.each([
    { scenario: 'exact self-target', oldTarget: 'SPEC-003-01', freshTarget: 'SPEC-003-01', requiredScenarios: [], replaced: true },
    { scenario: 'lowercase self-target alias', oldTarget: 'SPEC-003-01', freshTarget: 'spec-003-01', requiredScenarios: [], replaced: true },
    { scenario: 'canonical self-target alias', oldTarget: 'spec-003-01', freshTarget: 'SPEC-003-01', requiredScenarios: [], replaced: true },
    { scenario: 'case-sensitive scenario targets', oldTarget: 'SPEC-003-01', freshTarget: 'spec-003-01', requiredScenarios: ['spec-003-01'], replaced: false },
    { scenario: 'different scenario targets', oldTarget: 'scenario-a', freshTarget: 'scenario-b', requiredScenarios: ['scenario-a', 'scenario-b'], replaced: false },
  ])('uses the accepted target policy for $scenario during supersession', async ({ oldTarget, freshTarget, requiredScenarios, replaced }) => {
    const created = await specs.setSpecClause(clause({
      falsifier: requiredScenarios.length ? { observation: 'A selected reconnect scenario fails.', requiredScenarios } : null,
    }));
    expect(created).toMatchObject({ status: 'created', specId: 'SPEC-003-01', revision: 1 });
    const oldRun = await seedExternalEvidence(REPLAY_TEST);
    const freshRun = await seedExternalEvidence(REPLAY_TEST);
    await markRunAsPassing(freshRun.testRunId, REPLAY_TEST, 'fresh selected target');
    const old = await bindViaTool({
      evidenceKind: 'test', evidenceRef: 'test-run:old-target', testRunId: oldRun.testRunId,
      details: { adequacy: { ...PASSED, targeted: oldTarget } },
    });
    const fresh = await bindViaTool({
      evidenceKind: 'test', evidenceRef: 'test-run:fresh-target', testRunId: freshRun.testRunId,
      details: { adequacy: { ...PASSED, targeted: freshTarget } },
    }, true);
    const [outcome] = fresh.supersession as Array<{
      retracted: Array<{ bindingId: number }>;
      kept: Array<{ bindingId: number; reason: string }>;
    }>;
    expect(outcome!.retracted.map(row => row.bindingId)).toEqual(replaced ? [old.id] : []);
    expect(outcome!.kept).toEqual(replaced ? [] : [expect.objectContaining({ bindingId: old.id, reason: 'different-target' })]);
    const live = await liveIds();
    expect(live).toContain(fresh.id);
    expect(live.includes(old.id)).toBe(!replaced);
  });

  it('retracts the older same-kind row, keeps the mutation proof, and names the superseding binding', async () => {
    await specs.setSpecClause(clause());
    // Two attempts of ONE test file: the fresh run replaces the failed one.
    const [oldRun, mutationRun, freshRun] = [
      await seedExternalEvidence(REPLAY_TEST),
      await seedExternalEvidence(REPLAY_TEST),
      await seedExternalEvidence(REPLAY_TEST),
    ];
    await markRunAsPassing(freshRun.testRunId, REPLAY_TEST, 'fresh integration attempt');
    const old = await bindViaTool({
      evidenceKind: 'test',
      evidenceRef: 'test-run:old-attempt',
      testRunId: oldRun.testRunId,
      details: { adequacy: { ...PASSED, outcome: 'failed' } },
    });
    const mutation = await bindViaTool({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:guard-removed',
      testRunId: mutationRun.testRunId,
      // P-043: bind refuses a mutation whose target the evaluator would reject. This clause
      // declares no falsifier.requiredScenarios, so its own specId is the accepted target.
      details: { adequacy: { ...PASSED, outcome: 'killed', targeted: 'spec-003-01' } },
    });
    // Positive control: without the flag nothing is withdrawn, so the assertion below is about
    // supersedeAtRevision and not about some other path hiding the old row.
    expect(await liveIds()).toEqual(expect.arrayContaining([old.id, mutation.id]));

    const fresh = await bindViaTool(
      {
        evidenceKind: 'test',
        evidenceRef: 'test-run:fresh-attempt',
        testRunId: freshRun.testRunId,
        details: { adequacy: PASSED },
      },
      true,
    );

    expect(fresh.supersession).toEqual([
      {
        bindingId: fresh.id,
        status: 'superseded',
        clause: 'SPEC-003-01@1',
        evidenceKind: 'test',
        retracted: [{ bindingId: old.id, workItemId: 'WI-101', evidenceRef: 'test-run:old-attempt' }],
        kept: [],
      },
    ]);
    const live = await liveIds();
    expect(live).toContain(fresh.id);
    // A fresh TEST row must never withdraw the clause's mutation proof — a different obligation.
    expect(live).toContain(mutation.id);
    expect(live).not.toContain(old.id);
    const [stamp] = await db.sql<{ retracted_by: string | null; retraction_reason: string | null }[]>`
      SELECT retracted_by, retraction_reason FROM harness_shared.spec_evidence_bindings WHERE id = ${old.id}`;
    expect(stamp?.retraction_reason).toBe(
      `superseded by binding ${fresh.id} (plans:bind-spec-evidence supersedeAtRevision)`,
    );
    expect(stamp?.retracted_by).toBeTruthy();
  });

  it.each([
    { scenario: 'passing selected cases', declared: ['scope > selected'], superseded: true },
    { scenario: 'a skipped selected case', declared: ['scope > selected', 'scope > skipped'], superseded: false },
    { scenario: 'a partial selected title', declared: ['scope > select'], superseded: false },
  ])('checks $scenario against the persisted ledger before scoped supersession', async ({ declared, superseded }) => {
    await specs.setSpecClause(clause());
    const [oldRun, freshRun] = [
      await seedExternalEvidence(REPLAY_TEST),
      await seedExternalEvidence(REPLAY_TEST),
    ];
    await markRunAsPassing(freshRun.testRunId, REPLAY_TEST, 'outer > scope > selected');
    // The aggregate skip count includes cases outside the selected scope. The
    // production store must retain that count and corroborate each declared case.
    await db.sql`UPDATE harness_shared.test_runs
      SET execution_details = jsonb_set(execution_details, '{skipped}', '95'::jsonb)
      WHERE id = ${freshRun.testRunId}`;
    const old = await bindViaTool({
      evidenceKind: 'test', evidenceRef: 'test-run:old-scoped-attempt',
      testRunId: oldRun.testRunId,
      details: { adequacy: { ...PASSED, outcome: 'failed' } },
    });
    const fresh = await bindViaTool({
      evidenceKind: 'test', evidenceRef: 'test-run:fresh-scoped-attempt',
      testRunId: freshRun.testRunId,
      details: { adequacy: { ...PASSED, testCases: declared } },
    }, true);

    expect(fresh.supersession).toEqual([expect.objectContaining({
      bindingId: fresh.id, status: superseded ? 'superseded' : 'refused',
    })]);
    const live = await liveIds();
    expect(live).toContain(fresh.id);
    expect(live.includes(old.id)).toBe(!superseded);
    const [measured] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS, planSlugs: ['reconnect-plan'], bindingIds: [fresh.id],
    });
    expect(measured?.testRunExecution).toMatchObject({
      passed: 1, failed: 0, skipped: 95, passedCaseTitles: ['outer > scope > selected'],
    });
  });

  it('supersedes an earlier mutation using measured failed identities from the real ledger', async () => {
    await specs.setSpecClause(clause());
    const [oldRun, freshRun] = [
      await seedExternalEvidence(REPLAY_TEST),
      await seedExternalEvidence(REPLAY_TEST),
    ];
    const failedCase = 'owner selection > rejects the forbidden assignment';
    const execution = {
      schemaVersion: 1, root: h.repoRoot, filePath: REPLAY_TEST,
      runGroupId: null, workspaceId: WORKSPACE, harnessSlug: HARNESS,
      testNamePattern: null, passed: 23, failed: 1, skipped: 0,
      collectionFailed: false, mutationPhase: 'mutant',
      commitSha: 'c0ffee1234567890', worktreeDirty: false,
      testLayer: 'integration', failedCaseTitles: [failedCase],
    };
    await db.sql`UPDATE harness_shared.test_runs
      SET source = 'mutation-probe', status = 'fail', finished_at = now(),
          output_tail = NULL, execution_details = ${db.sql.json(execution)}
      WHERE id = ${freshRun.testRunId}`;
    const adequacy = { ...PASSED, outcome: 'killed', targeted: 'spec-003-01', testCases: [failedCase] };
    const old = await bindViaTool({
      evidenceKind: 'mutation', evidenceRef: 'mutation-probe:old-attempt',
      testRunId: oldRun.testRunId, details: { adequacy },
    });
    const freshBinding = {
      evidenceKind: 'mutation', evidenceRef: 'mutation-probe:fresh-attempt',
      testRunId: freshRun.testRunId, details: { adequacy },
    };
    const fresh = await bindViaTool(freshBinding);
    // A normal bind preserves both rows; only verified supersession may withdraw old proof.
    expect(await liveIds()).toEqual(expect.arrayContaining([old.id, fresh.id]));
    const superseded = await bindViaTool(freshBinding, true);
    expect(superseded.supersession).toEqual([{
      bindingId: fresh.id, status: 'superseded', clause: 'SPEC-003-01@1', evidenceKind: 'mutation',
      retracted: [{ bindingId: old.id, workItemId: 'WI-101', evidenceRef: 'mutation-probe:old-attempt' }],
      kept: [],
    }]);
    const [measured] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS, planSlugs: ['reconnect-plan'], bindingIds: [fresh.id],
    });
    expect(measured?.testRunProvenance?.mutationFailedCaseTitles).toEqual([failedCase]);
    expect(await liveIds()).toContain(fresh.id);
    expect(await liveIds()).not.toContain(old.id);
  });

  it('binds a row that is not sufficient on its own but supersedes nothing, and says why', async () => {
    await specs.setSpecClause(clause());
    const oldRun = await seedExternalEvidence();
    const old = await bindViaTool({
      evidenceKind: 'test',
      evidenceRef: 'test-run:ledger-backed',
      testRunId: oldRun.testRunId,
      details: { adequacy: PASSED },
    });
    // No testRunId: author-attested booleans only. Letting this withdraw ledger-backed proof
    // would be the evidence-shedding D-011 forbids.
    const weak = await bindViaTool(
      { evidenceKind: 'test', evidenceRef: 'test-run:attested-only', details: { adequacy: PASSED } },
      true,
    );

    expect(weak.supersession).toEqual([
      expect.objectContaining({
        bindingId: weak.id,
        status: 'refused',
        reason: expect.stringContaining('no testRunId/coverageEvidenceRef ledger reference'),
      }),
    ]);
    expect(await liveIds()).toEqual(expect.arrayContaining([old.id, weak.id]));
  });

  // EI-25220306060165214: a clause proven by a unit AND an integration file lost its current
  // unit proof when a fresh integration run superseded the stale integration row.
  it("keeps a different test file's current proof and reports it in kept", async () => {
    await specs.setSpecClause(clause());
    const [unitRun, staleRun, freshRun] = [
      await seedExternalEvidence(REPLAY_UNIT_TEST),
      await seedExternalEvidence(REPLAY_TEST),
      await seedExternalEvidence(REPLAY_TEST),
    ];
    await Promise.all([
      markRunAsPassing(unitRun.testRunId, REPLAY_UNIT_TEST, 'unit proof remains current', 'unit'),
      markRunAsPassing(freshRun.testRunId, REPLAY_TEST, 'fresh integration attempt'),
    ]);
    const unit = await bindViaTool({
      evidenceKind: 'test',
      evidenceRef: REPLAY_UNIT_TEST,
      testRunId: unitRun.testRunId,
      details: { adequacy: { ...PASSED, testLayer: 'unit' } },
    });
    const stale = await bindViaTool({
      evidenceKind: 'test',
      evidenceRef: REPLAY_TEST,
      testRunId: staleRun.testRunId,
      details: { adequacy: { ...PASSED, outcome: 'failed' } },
    });

    const fresh = await bindViaTool(
      { evidenceKind: 'test', evidenceRef: REPLAY_TEST, testRunId: freshRun.testRunId, details: { adequacy: PASSED } },
      true,
    );

    expect(fresh.supersession).toEqual([
      expect.objectContaining({
        status: 'superseded',
        retracted: [{ bindingId: stale.id, workItemId: 'WI-101', evidenceRef: REPLAY_TEST }],
        kept: [{ bindingId: unit.id, workItemId: 'WI-101', evidenceRef: REPLAY_UNIT_TEST, reason: 'different-subject' }],
      }),
    ]);
    const live = await liveIds();
    expect(live).toEqual(expect.arrayContaining([unit.id, fresh.id]));
    expect(live).not.toContain(stale.id);
  });

  // EI-24400631485940769: one fresh run of a multi-seam clause wiped every other seam's
  // current proof. A row is replaced only when the fresh row claims everything it claimed.
  it('keeps rows claiming another causal pair or target, and retracts only what the fresh row covers', async () => {
    await specs.setSpecClause(clause());
    const runs = await Promise.all([1, 2, 3, 4, 5].map(() => seedExternalEvidence(REPLAY_TEST)));
    await markRunAsPassing(runs[4]!.testRunId, REPLAY_TEST, 'fresh causal-pair case');
    const bindTest = (index: number, adequacy: Record<string, unknown>) =>
      bindViaTool({
        evidenceKind: 'test',
        evidenceRef: `test-run:${index}`,
        testRunId: runs[index]!.testRunId,
        details: { adequacy: { ...PASSED, ...adequacy } },
      });
    const sameSeamOld = await bindTest(0, { causalPairIds: ['pair-a'], targeted: 'scenario-a' });
    const untaggedOld = await bindTest(1, {});
    const otherSeam = await bindTest(2, { causalPairIds: ['pair-b'], targeted: 'scenario-a' });
    const otherTarget = await bindTest(3, { causalPairIds: ['pair-a'], targeted: 'scenario-b' });

    const fresh = await bindViaTool(
      {
        evidenceKind: 'test',
        evidenceRef: 'test-run:4',
        testRunId: runs[4]!.testRunId,
        details: { adequacy: { ...PASSED, causalPairIds: ['pair-a'], targeted: 'scenario-a' } },
      },
      true,
    );

    const [outcome] = fresh.supersession as Array<{
      retracted: Array<{ bindingId: number }>;
      kept: Array<{ bindingId: number; reason: string }>;
    }>;
    expect(outcome!.retracted.map((row) => row.bindingId).sort()).toEqual([sameSeamOld.id, untaggedOld.id].sort());
    expect(outcome!.kept).toEqual([
      expect.objectContaining({ bindingId: otherSeam.id, reason: 'different-causal-pairs' }),
      expect.objectContaining({ bindingId: otherTarget.id, reason: 'different-target' }),
    ]);
    const live = await liveIds();
    expect(live).toEqual(expect.arrayContaining([otherSeam.id, otherTarget.id, fresh.id]));
    expect(live).not.toContain(sameSeamOld.id);
    expect(live).not.toContain(untaggedOld.id);
  });
});

describe('plans:bind-spec-evidence { fromTestRun } derives the binding from a recorded run (P-044 / RSR-P-044-A)', () => {
  const DERIVE_TEST = 'test/derive.test.ts';
  const EXPECTED_SOURCES = ['src/lazy.ts', 'src/reconnect.ts'];

  beforeEach(async () => {
    // A subject reached statically, one reached by a literal dynamic import (how a vitest suite
    // loads its subject after vi.mock), and a sibling TEST file, which is not a subject.
    await writeFile(path.join(h.repoRoot, 'src', 'lazy.ts'), 'export const lazy = 1;\n');
    await writeFile(
      path.join(h.repoRoot, DERIVE_TEST),
      [
        "import { reconnect } from '../src/reconnect';",
        "import './reconnect.test';",
        "const { lazy } = await import('../src/lazy');",
        'expect(reconnect && lazy).toBeTruthy();',
        '',
      ].join('\n'),
    );
  });

  async function recordRun(
    over: { workspaceId?: string | null; harnessSlug?: string | null; status?: string; source?: string } = {},
  ) {
    const [row] = await db.sql<{ id: number }[]>`
      INSERT INTO harness_shared.test_runs
        (workspace_id, harness_slug, file_path, status, finished_at, commit_sha, worktree_dirty, source, execution_details)
      VALUES (
        ${over.workspaceId === undefined ? WORKSPACE : over.workspaceId},
        ${over.harnessSlug === undefined ? HARNESS : over.harnessSlug},
        ${DERIVE_TEST}, ${over.status ?? 'pass'}, now(), 'c0ffee1234567890', false,
        ${over.source ?? 'local'}, ${db.sql.json({ collectionFailed: false, runStartedAt: new Date().toISOString() })})
      RETURNING id`;
    return Number(row.id);
  }

  async function setRunExecutionDetails(runId: number, details: Record<string, unknown>) {
    const candidate = details.runStartedAt;
    const runStartedAt = typeof candidate === 'string' && Number.isFinite(Date.parse(candidate))
      ? candidate
      : new Date().toISOString();
    await db.sql`UPDATE harness_shared.test_runs
      SET execution_details = ${db.sql.json({ ...details, runStartedAt })}
      WHERE id = ${runId}`;
  }

  async function bindFromRun(
    fromTestRun: number,
    workItemId = 'WI-101',
    details?: Record<string, unknown>,
    supersedeAtRevision = false,
  ) {
    const out = (await bindTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        ...(supersedeAtRevision ? { supersedeAtRevision: true } : {}),
        binding: { workItemId, specId: 'SPEC-003-01', fromTestRun, ...(details ? { details } : {}) },
      } as never,
      CTX,
    )) as { data: { results: Array<Record<string, unknown>>; supersession?: unknown[] } };
    return supersedeAtRevision
      ? { ...out.data.results[0], supersession: out.data.supersession }
      : out.data.results[0];
  }

  it('produces the same stored measurement as the hand-built binding of the same run', async () => {
    await specs.setSpecClause(clause());
    const runId = await recordRun();

    const derived = await bindFromRun(runId);
    expect(derived).toMatchObject({
      ok: true,
      status: 'created',
      derivedFromTestRun: {
        testRunId: runId,
        evidenceKind: 'test',
        evidenceRef: DERIVE_TEST,
        harnessAttribution: 'run',
        measurement: { kind: 'repo-files', sourcePaths: EXPECTED_SOURCES, testPaths: [DERIVE_TEST] },
      },
    });

    const handBuilt = (await bindTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        binding: {
          workItemId: 'WI-102',
          specId: 'SPEC-003-01',
          evidenceKind: 'test',
          evidenceRef: DERIVE_TEST,
          testRunId: runId,
          measurement: { schemaVersion: 1, kind: 'repo-files', sourcePaths: EXPECTED_SOURCES, testPaths: [DERIVE_TEST] },
          details: { adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed' } },
        },
      } as never,
      CTX,
    )) as { data: { results: Array<Record<string, unknown>> } };
    expect(handBuilt.data.results[0]).toMatchObject({ ok: true, status: 'created' });

    const rows = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: [DERIVE_TEST],
    });
    const byItem = new Map(rows.map((row) => [row.workItemId, row]));
    const fromRun = byItem.get('WI-101')!;
    const byHand = byItem.get('WI-102')!;
    expect(fromRun.fingerprints).toEqual(byHand.fingerprints);
    expect((fromRun.details as Record<string, unknown>).currentMeasurement).toEqual(
      (byHand.details as Record<string, unknown>).currentMeasurement,
    );
    expect(fromRun.testRunId).toBe(runId);
    expect(fromRun.details).toMatchObject({
      adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed' },
      testRun: { id: runId, commitSha: 'c0ffee1234567890', worktreeDirty: false, harnessAttribution: 'run' },
    });
    expect(fromRun.currentness).toMatchObject({
      overall: 'current',
      dimensions: { source: 'current', test: 'current', testRun: 'current' },
    });
  });

  it('projects canonical passedCaseTitles through the evidence store into the adequacy evaluator', async () => {
    const exactTitle = 'derive suite > exact integration case';
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const [clauseRevision] = await specs.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specIds: ['SPEC-003-01'],
    });
    expect(clauseRevision).toBeDefined();

    const runId = await recordRun();
    const executionDetails = {
      schemaVersion: 1,
      root: h.repoRoot,
      filePath: DERIVE_TEST,
      runGroupId: null,
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      testNamePattern: null,
      passed: 1,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha: 'c0ffee1234567890',
      worktreeDirty: false,
      testLayer: 'integration',
      passedCaseTitles: [exactTitle],
    };
    await setRunExecutionDetails(runId, executionDetails);

    const bound = await bindFromRun(runId, 'WI-101', {
      adequacy: {
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        targeted: 'SPEC-003-01',
        testLayer: 'integration',
        pathReachable: true,
        testCases: [exactTitle],
      },
    }, true);
    expect(bound).toMatchObject({
      ok: true,
      status: 'created',
      derivedFromTestRun: { testRunId: runId },
      supersession: [expect.objectContaining({ status: 'superseded', evidenceKind: 'test' })],
    });

    const projected = (await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-101'],
      evidenceRefs: [DERIVE_TEST],
    })).find((row) => row.testRunId === runId);
    expect(projected).toBeDefined();
    expect(projected!.testRunExecution).toMatchObject({
      status: 'pass',
      passed: 1,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      testLayer: 'integration',
      passedCaseTitles: [exactTitle],
    });

    const { evaluateSpecTestAdequacy } = await import('./spec-test-adequacy');
    const evaluate = (evidenceRows: NonNullable<typeof projected>[]) => evaluateSpecTestAdequacy({
      clause: clauseRevision!,
      evidence: evidenceRows,
      classRef: 'plan-class-feature-ship',
    });
    const accepted = evaluate([projected!]);
    expect(accepted.ratings['correct-layer'].rating).toBe('pass');
    expect(accepted.ratings['correct-layer'].evidence).toContain(`testRunId=${runId}`);

    const details = projected!.details as Record<string, unknown>;
    const adequacy = details.adequacy as Record<string, unknown>;
    const differentTitle = {
      ...projected!,
      details: { ...details, adequacy: { ...adequacy, testCases: ['different passing case'] } },
    };
    const rejected = evaluate([differentTitle]);
    expect(rejected.ratings['correct-layer'].rating).toBe('unknown');
    expect(rejected.ratings['correct-layer'].suggestion).toContain('exact passedCaseTitles');
  });

  it('refuses a test binding whose declared cases have zero overlap with a complete passing title ledger', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const runId = await recordRun();
    const executionDetails = {
      schemaVersion: 1,
      root: h.repoRoot,
      filePath: DERIVE_TEST,
      runGroupId: null,
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      testNamePattern: null,
      passed: 1,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha: 'c0ffee1234567890',
      worktreeDirty: false,
      testLayer: 'integration',
      passedCaseTitles: ['outer > suite > selected case'],
    };
    await setRunExecutionDetails(runId, executionDetails);

    const accepted = await bindFromRun(runId, 'WI-101', {
      adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed', testCases: ['selected case'] },
    });
    expect(accepted).toMatchObject({ ok: true, status: 'created' });
    const acceptedEvidence = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-101'],
      evidenceRefs: [DERIVE_TEST],
    });
    const acceptedBinding = acceptedEvidence.find((row) => row.testRunId === runId);
    expect(acceptedBinding).toBeDefined();
    const storedTestCases = (acceptedBinding!.details as { adequacy: { testCases: string[] } }).adequacy.testCases;
    expect(storedTestCases).toEqual(['outer > suite > selected case']);
    const { mutationMeasuredFailedCase } = await import('./spec-test-adequacy');
    const measuredMutation = {
      testRunProvenance: { mutationFailedCaseTitles: ['outer > suite > selected case'] },
    } as never;
    expect(mutationMeasuredFailedCase(measuredMutation, storedTestCases[0])).toBe(true);
    expect(mutationMeasuredFailedCase(measuredMutation, 'selected case')).toBe(false);

    const rejected = await bindFromRun(runId, 'WI-102', {
      adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed', testCases: ['case from another file'] },
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: 'test_cases_not_in_run',
      status: 'test_cases_not_in_run',
      testRunId: runId,
      declaredCaseCount: 1,
      passedCaseTitleCount: 1,
    });
    const persisted = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-102'],
      evidenceRefs: [DERIVE_TEST],
    });
    expect(persisted).toEqual([]);

    const incompleteRunId = await recordRun();
    const incompleteDetails = {
      ...executionDetails,
      passed: 65,
      passedCaseTitles: Array.from({ length: 64 }, (_, index) => 'outer > recorded case ' + index),
      passedCaseTitlesTruncated: true,
    };
    await setRunExecutionDetails(incompleteRunId, incompleteDetails);
    const incomplete = await bindFromRun(incompleteRunId, 'WI-102', {
      adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed', testCases: ['case omitted from title cap'] },
    });
    expect(incomplete).toMatchObject({ ok: true, status: 'created' });
    const incompleteEvidence = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-102'],
      evidenceRefs: [DERIVE_TEST],
    });
    expect(incompleteEvidence).toHaveLength(1);
    expect(incompleteEvidence[0]?.testRunExecution).toMatchObject({
      passed: 65,
      passedCaseTitlesIncomplete: true,
    });
    expect(incompleteEvidence[0]?.testRunExecution?.passedCaseTitles).toHaveLength(64);
    expect((incompleteEvidence[0]?.details as { adequacy: { testCases: string[] } }).adequacy.testCases)
      .toEqual(['case omitted from title cap']);
  });

  it('resolves declared cases against the per-case ledger, closing the title-cap bypass (P-002 / R-2)', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    // The same capped-title shape the previous case binds successfully: 65 passed, 64
    // titles recorded, so the declared case is invisible to the title list. Here the run
    // ALSO recorded every case in the ledger, which is the authority when present.
    const runId = await recordRun();
    await setRunExecutionDetails(runId, {
        schemaVersion: 1, root: h.repoRoot, filePath: DERIVE_TEST, runGroupId: null,
        workspaceId: WORKSPACE, harnessSlug: HARNESS, testNamePattern: null,
        passed: 65, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
        commitSha: 'c0ffee1234567890', worktreeDirty: false, testLayer: 'integration',
        passedCaseTitles: Array.from({ length: 64 }, (_, index) => 'outer > recorded case ' + index),
        passedCaseTitlesTruncated: true,
      });
    const keys = [
      ...Array.from({ length: 64 }, (_, index) => 'outer > recorded case ' + index),
      'outer > case beyond the title cap',
    ];
    for (const [index, caseKey] of keys.entries()) {
      await db.sql`INSERT INTO harness_shared.test_case_runs (test_run_id, case_index, case_key, status, duration_ms)
        VALUES (${runId}, ${index}, ${caseKey}, 'pass', 3)`;
    }

    // A case the title list could not show but the ledger recorded binds.
    const beyondCap = await bindFromRun(runId, 'WI-101', {
      adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed', testCases: ['case beyond the title cap'] },
    });
    expect(beyondCap).toMatchObject({ ok: true, status: 'created' });
    const beyondCapEvidence = (await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-101'],
      evidenceRefs: [DERIVE_TEST],
    })).find((row) => row.testRunId === runId);
    expect((beyondCapEvidence?.details as { adequacy: { testCases: string[] } }).adequacy.testCases)
      .toEqual(['outer > case beyond the title cap']);

    // A declared case the run never executed is refused, even though the capped title list
    // could not have proved it absent — and even beside a declared case that DID match.
    const rejected = await bindFromRun(runId, 'WI-102', {
      adequacy: {
        collected: true, skipped: false, executed: true, outcome: 'passed',
        testCases: ['recorded case 3', 'case omitted from title cap'],
      },
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: 'test_cases_not_in_run',
      status: 'test_cases_not_in_run',
      testRunId: runId,
      declaredCaseCount: 2,
      passedCaseTitleCount: 65,
      source: 'case-ledger',
      unmatchedTestCases: ['case omitted from title cap'],
    });
    expect(
      await evidenceStore.listSpecEvidence({
        harnessSlug: HARNESS,
        planSlugs: ['reconnect-plan'],
        workItemIds: ['WI-102'],
        evidenceRefs: [DERIVE_TEST],
      }),
    ).toEqual([]);
  });

  it('refuses ambiguous suffixes from authoritative title sources while preferring exact identities', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const exactTitle = 'outer > suite alpha > selected case';
    const nestedTitle = `legacy > ${exactTitle}`;
    const titles = [exactTitle, nestedTitle];
    const runId = await recordRun();
    await setRunExecutionDetails(runId, {
      schemaVersion: 1,
      root: h.repoRoot,
      filePath: DERIVE_TEST,
      runGroupId: null,
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      testNamePattern: null,
      passed: titles.length,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha: 'c0ffee1234567890',
      worktreeDirty: false,
      testLayer: 'integration',
      passedCaseTitles: titles,
    });

    const exact = await bindFromRun(runId, 'WI-101', {
      adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed', testCases: [exactTitle] },
    });
    expect(exact).toMatchObject({ ok: true, status: 'created' });
    const exactEvidence = (await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-101'],
      evidenceRefs: [DERIVE_TEST],
    })).find((row) => row.testRunId === runId);
    expect((exactEvidence?.details as { adequacy: { testCases: string[] } }).adequacy.testCases).toEqual([exactTitle]);

    const ambiguousTitleList = await bindFromRun(runId, 'WI-102', {
      adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed', testCases: ['selected case'] },
    });
    expect(ambiguousTitleList).toMatchObject({
      ok: false,
      error: 'test_cases_ambiguous_in_run',
      status: 'test_cases_ambiguous_in_run',
      testRunId: runId,
      declaredCaseCount: 1,
      source: 'passed-case-titles',
      ambiguousTestCases: [{ testCase: 'selected case', matchingCaseTitles: titles }],
    });
    expect(await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-102'],
      evidenceRefs: [DERIVE_TEST],
    })).toEqual([]);

    const ledgerRunId = await recordRun();
    await setRunExecutionDetails(ledgerRunId, {
      schemaVersion: 1,
      root: h.repoRoot,
      filePath: DERIVE_TEST,
      runGroupId: null,
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      testNamePattern: null,
      passed: titles.length,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha: 'c0ffee1234567890',
      worktreeDirty: false,
      testLayer: 'integration',
      passedCaseTitles: titles,
    });
    for (const [index, caseKey] of titles.entries()) {
      await db.sql`INSERT INTO harness_shared.test_case_runs (test_run_id, case_index, case_key, status, duration_ms)
        VALUES (${ledgerRunId}, ${index}, ${caseKey}, 'pass', 3)`;
    }
    const ambiguousLedger = await bindFromRun(ledgerRunId, 'WI-101', {
      adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed', testCases: ['selected case'] },
    });
    expect(ambiguousLedger).toMatchObject({
      ok: false,
      error: 'test_cases_ambiguous_in_run',
      status: 'test_cases_ambiguous_in_run',
      testRunId: ledgerRunId,
      declaredCaseCount: 1,
      source: 'case-ledger',
      ambiguousTestCases: [{ testCase: 'selected case', matchingCaseTitles: titles }],
    });
    const ledgerEvidence = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-101'],
      evidenceRefs: [DERIVE_TEST],
    });
    expect(ledgerEvidence.filter((row) => row.testRunId === ledgerRunId)).toEqual([]);
  });

  it('refuses mutation adequacy cases that contradict the measured failed mutant case', async () => {
    await specs.setSpecClause(clause());
    const runId = await recordRun({ status: 'fail', source: 'mutation-probe' });
    const failedCaseTitle =
      'R-10: a probe that is not provably read-only is refused without being dispatched > reports a write-capable tool probe as could-not-run (not_read_only) and never calls the dispatcher';
    const unrelatedPassingTitle =
      'R-1 / R-25: changed and could-not-run probes get a line; matching probes print nothing > renders nothing for probes that still match their expect value';
    await setRunExecutionDetails(runId, {
        schemaVersion: 1,
        root: h.repoRoot,
        filePath: DERIVE_TEST,
        runGroupId: null,
        workspaceId: WORKSPACE,
        harnessSlug: HARNESS,
        testNamePattern: null,
        passed: 10,
        failed: 1,
        skipped: 0,
        collectionFailed: false,
        mutationPhase: 'mutant',
        commitSha: 'c0ffee1234567890',
        worktreeDirty: false,
        testLayer: 'unit',
        runStartedAt: new Date().toISOString(),
        failedCaseTitles: [failedCaseTitle],
      });

    const accepted = await bindFromRun(runId, 'WI-101', {
      adequacy: { targeted: 'SPEC-003-01', testCases: [failedCaseTitle] },
    });
    expect(accepted).toMatchObject({ ok: true, status: 'created' });

    const rejected = await bindFromRun(runId, 'WI-102', {
      adequacy: { targeted: 'SPEC-003-01', testCases: [failedCaseTitle, unrelatedPassingTitle] },
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: 'test_cases_not_in_run',
      status: 'test_cases_not_in_run',
      testRunId: runId,
      declaredCaseCount: 2,
      failedCaseTitleCount: 1,
      source: 'mutation-failed-case-titles',
      unmatchedTestCases: [unrelatedPassingTitle],
    });
    expect(await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-102'],
    })).toEqual([]);
  });

  it('refuses caught-case prose overclaims through both fromTestRun and hand-built bindings', async () => {
    await specs.setSpecClause(clause());
    const runId = await recordRun({ status: 'fail', source: 'mutation-probe' });
    const failedCaseTitle = 'suite > rejects the invalid request';
    const extraClaimedCase = 'suite > accepts the valid request';
    await setRunExecutionDetails(runId, {
      schemaVersion: 1,
      root: h.repoRoot,
      filePath: DERIVE_TEST,
      runGroupId: null,
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      testNamePattern: null,
      passed: 1,
      failed: 1,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: 'mutant',
      commitSha: 'c0ffee1234567890',
      worktreeDirty: false,
      testLayer: 'unit',
      failedCaseTitles: [failedCaseTitle],
    });
    const overclaimed = `The mutant was caught by: ${failedCaseTitle} | ${extraClaimedCase}`;
    const details = {
      observations: { scope: overclaimed },
      adequacy: { targeted: 'SPEC-003-01', testCases: [failedCaseTitle] },
    };

    const fromTestRun = await bindFromRun(runId, 'WI-101', details);
    expect(fromTestRun).toMatchObject({
      ok: false,
      error: 'mutation_caught_case_claim_mismatch',
      fromTestRun: runId,
    });

    const handBuilt = (await bindTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        binding: {
          workItemId: 'WI-102',
          specId: 'SPEC-003-01',
          evidenceKind: 'mutation',
          evidenceRef: 'mutation-probe:hand-built-overclaim',
          testRunId: runId,
          measurement: {
            schemaVersion: 1,
            kind: 'repo-files',
            sourcePaths: EXPECTED_SOURCES,
            testPaths: [DERIVE_TEST],
          },
          details,
        },
      } as never,
      CTX,
    )) as { data: { results: Array<Record<string, unknown>> } };
    expect(handBuilt.data.results[0]).toMatchObject({
      ok: false,
      error: 'mutation_caught_case_claim_mismatch',
      status: 'mutation_caught_case_claim_mismatch',
      testRunId: runId,
      field: 'observations',
    });
    expect(await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-101', 'WI-102'],
    })).toEqual([]);
  });

  it('binds a mutation-probe copy-out row using its JSON execution root and canonical test path', async () => {
    await specs.setSpecClause(clause());
    const mirror = '/tmp/mutation-probe-removed/mirror';
    const [row] = await db.sql<{ id: number }[]>`
      INSERT INTO harness_shared.test_runs
        (workspace_id, harness_slug, file_path, status, finished_at, commit_sha, worktree_dirty, source, execution_details)
      VALUES (
        ${WORKSPACE}, ${HARNESS}, ${DERIVE_TEST}, 'fail', now(), 'c0ffee1234567890', false,
        'mutation-probe', ${db.sql.json({
          root: mirror,
          mutationPhase: 'mutant',
          collectionFailed: false,
          runStartedAt: new Date().toISOString(),
        })})
      RETURNING id`;
    const out = (await bindTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        binding: {
          workItemId: 'WI-101', specId: 'SPEC-003-01', fromTestRun: Number(row.id),
          canonicalTestPath: DERIVE_TEST, details: { adequacy: { targeted: 'spec-003-01' } },
        },
      } as never,
      CTX,
    )) as { data: { results: Array<Record<string, unknown>> } };
    if (!out.data.results[0]?.ok) throw new Error(JSON.stringify(out.data.results[0]));
    expect(out.data.results[0]).toMatchObject({
      ok: true,
      derivedFromTestRun: {
        testRunId: Number(row.id),
        evidenceKind: 'mutation',
        measurement: { sourcePaths: EXPECTED_SOURCES, testPaths: [DERIVE_TEST] },
      },
    });
  });

  it('binds a run recorded with no harness under the caller harness instead of refusing it', async () => {
    await specs.setSpecClause(clause());
    const runId = await recordRun({ workspaceId: null, harnessSlug: null, source: 'mutation-probe' });

    const bound = await bindFromRun(runId);
    expect(bound).toMatchObject({
      ok: true,
      status: 'created',
      derivedFromTestRun: { testRunId: runId, harnessAttribution: 'adopted-caller-harness' },
    });
    const [row] = await db.sql<{ harness_slug: string | null; workspace_id: string | null }[]>`
      SELECT harness_slug, workspace_id FROM harness_shared.test_runs WHERE id = ${runId}`;
    expect(row).toEqual({ harness_slug: HARNESS, workspace_id: WORKSPACE });
    // Adoption is what keeps the ledger link live: the store re-checks it on every read.
    const [evidence] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: [DERIVE_TEST],
    });
    expect(evidence.currentness).toMatchObject({ dimensions: { testRun: 'current' } });

    // CONTROL: the store's own door still refuses the same shape of row when bound by hand,
    // so the success above is the derivation's doing, not a loosened store.
    const unadopted = await recordRun({ workspaceId: null, harnessSlug: null });
    const byHand = await evidenceStore.bindSpecEvidence({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-102',
      specId: 'SPEC-003-01',
      evidenceKind: 'test',
      evidenceRef: 'test:hand-built-null-harness',
      sourceFingerprint: 'git:abc123',
      testRunId: unadopted,
      actorId: 'su-test',
    });
    expect(byHand).toMatchObject({ status: 'test_run_not_found', scopeMismatch: { rowHarnessSlug: null } });
  });

  it('links a bound mutant to its same-invocation calibration row left harness-NULL, never a foreign one (EI-26696103067780835)', async () => {
    await specs.setSpecClause(clause());
    const failedCase = 'guard > catches the mutant';
    const descriptor = {
      schemaVersion: 1, probeInvocationId: 'probe-null-harness-calibration-0001', mode: 'copy-out',
      // A subject the fixture checkout really contains: the bind fingerprints it as a source path.
      subjectPath: 'src/reconnect.ts', mutateExpression: 's/true/false/', againstCommit: null,
      subjectBeforeSha256: 'b'.repeat(64), subjectAfterSha256: 'c'.repeat(64),
      mutantDiff: '-verified\n+true\n', mutantDiffTruncated: false,
      testCommandSha256: 'd'.repeat(64), testFileSha256: 'a'.repeat(64),
    };
    const execution = (leg: string, failed: number) => ({
      schemaVersion: 1, root: h.repoRoot, filePath: DERIVE_TEST, runGroupId: null,
      workspaceId: WORKSPACE, harnessSlug: null, testNamePattern: null,
      passed: 10, failed, skipped: 0, collectionFailed: false, mutationPhase: leg,
      commitSha: 'c0ffee1234567890', worktreeDirty: false, testLayer: 'unit',
      ...(failed > 0 ? { failedCaseTitles: [failedCase] } : {}),
      mutation: { ...descriptor, leg },
    });
    // The probe records every leg with harness NULL (it is env-stamped).
    const calibration = await recordRun({ harnessSlug: null, source: 'mutation-probe' });
    await setRunExecutionDetails(calibration, execution('copy-baseline', 0));
    // A HIGHER-id row with the same invocation identity already attributed to another
    // harness: the reader picks newest-first, so only the harness rule keeps it out.
    const foreign = await recordRun({ harnessSlug: 'some-other-harness', source: 'mutation-probe' });
    await setRunExecutionDetails(foreign, execution('copy-baseline', 0));
    const mutant = await recordRun({ harnessSlug: null, source: 'mutation-probe', status: 'fail' });
    await setRunExecutionDetails(mutant, execution('mutant', 1));

    // Bound WITHOUT causalControls: only the mutant row is adopted into the plan harness.
    const bound = await bindFromRun(mutant, 'WI-101', {
      adequacy: { targeted: 'SPEC-003-01', testCases: [failedCase] },
    });
    if (!bound?.ok) throw new Error(JSON.stringify(bound));
    expect(bound).toMatchObject({ ok: true, status: 'created' });
    const harnesses = await db.sql<{ id: number; harness_slug: string | null }[]>`
      SELECT id, harness_slug FROM harness_shared.test_runs
       WHERE id IN (${calibration}, ${foreign}, ${mutant}) ORDER BY id`;
    expect(harnesses.map((r) => [Number(r.id), r.harness_slug])).toEqual([
      [calibration, null], [foreign, 'some-other-harness'], [mutant, HARNESS],
    ]);

    const [evidence] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS, planSlugs: ['reconnect-plan'], workItemIds: ['WI-101'],
    });
    expect(evidence?.testRunId).toBe(mutant);
    expect(evidence?.testRunProvenance?.mutationBaseline).toMatchObject({
      testRunId: calibration, status: 'pass',
      mutation: { leg: 'copy-baseline', probeInvocationId: descriptor.probeInvocationId },
    });
  });

  it('refuses CI rows, foreign-harness rows, and adequacy the run contradicts', async () => {
    await specs.setSpecClause(clause());
    const ciRun = await recordRun({ workspaceId: null, harnessSlug: null, source: 'ci' });
    expect(await bindFromRun(ciRun)).toMatchObject({ ok: false, error: 'test_run_not_adoptable', fromTestRun: ciRun });
    const [ciRow] = await db.sql<{ harness_slug: string | null }[]>`
      SELECT harness_slug FROM harness_shared.test_runs WHERE id = ${ciRun}`;
    expect(ciRow.harness_slug).toBeNull();

    const foreign = await recordRun({ harnessSlug: 'some-other-harness' });
    expect(await bindFromRun(foreign)).toMatchObject({ ok: false, error: 'test_run_out_of_scope' });

    const failed = await recordRun({ status: 'fail' });
    const contradicted = await bindFromRun(failed, 'WI-101', { adequacy: { outcome: 'passed' } });
    expect(contradicted).toMatchObject({ ok: false, error: 'run_contradicts_declared_adequacy' });
    expect(String(contradicted.message)).toContain('outcome="failed"');

    const listed = await evidenceStore.listSpecEvidence({ harnessSlug: HARNESS, planSlugs: ['reconnect-plan'] });
    expect(listed).toHaveLength(0);
  });
});

/**
 * WI-10002889 / R-1 (review-system-rework-reduction-2026-09-23). A draft->active promotion that
 * leaves behavior, falsifier, layers and BAR pin byte-identical still appends a revision (the
 * lifecycle is part of the content hash, so the promotion stays auditable). Before the fix that
 * revision stranded EVERY binding at the draft revision: observed on this plan, where D-019's
 * activation audit promoted 31 AUTO-BAR clauses and all of their proof had to be re-run.
 */
describe('a lifecycle-only revision carries proof forward (WI-10002889)', () => {
  async function bindAtCurrent(evidenceRef: string, testRunId: number, coverageEvidenceRef: number) {
    const bound = await evidenceStore.bindSpecEvidence({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'coverage-census',
      evidenceRef,
      sourceFingerprint: 'git:abc123',
      coverageEvidenceRef,
      testRunId,
      actorId: 'su-test',
    });
    expect(bound.status).toBe('created');
    return Number((bound as { id: number }).id);
  }

  async function liveRefsAt(revision: number): Promise<string[]> {
    return (
      await db.sql<{ evidence_ref: string }[]>`
        SELECT evidence_ref FROM harness_shared.spec_evidence_bindings
         WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
           AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01'
           AND spec_revision = ${revision} AND retracted_at IS NULL
         ORDER BY evidence_ref`
    ).map((row) => row.evidence_ref);
  }

  it('re-attaches the work-item and carries live (not retracted) bindings onto the promoted revision', async () => {
    await specs.setSpecClause(clause({ lifecycleStatus: 'draft' }));
    const external = await seedExternalEvidence();
    await bindAtCurrent('surface:GET /events', external.testRunId, external.coverageEvidenceRef);
    const withdrawn = await bindAtCurrent('surface:POST /events', external.testRunId, external.coverageEvidenceRef);
    expect(
      (await evidenceStore.retractSpecEvidence({
        harnessSlug: HARNESS, bindingId: withdrawn, reason: 'bound run was never executed', actorId: 'su-retractor-wi2889',
      })).status,
    ).toBe('retracted');

    const promoted = await specs.setSpecClause(clause({ expectedRevision: 1, lifecycleStatus: 'active' }));
    // A promotion is still a new immutable revision, not an in-place mutation.
    expect(promoted).toMatchObject({ status: 'revised', revision: 2, evidenceCarriedForward: 1 });

    expect(await liveRefsAt(2)).toEqual(['surface:GET /events']);
    const [edge] = await db.sql<{ spec_fingerprint: string }[]>`
      SELECT spec_fingerprint FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND work_item_id = 'WI-101'
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01' AND spec_revision = 2`;
    expect(edge?.spec_fingerprint).toBe((promoted as { contentHash: string }).contentHash);
  });

  it('keeps a dirty test-run binding unknown through promotion and the get-spec-evidence reader', async () => {
    await specs.setSpecClause(clause({ lifecycleStatus: 'draft' }));
    const external = await seedExternalEvidence('test/reconnect.test.ts');
    await db.sql`
      UPDATE harness_shared.test_runs
         SET worktree_dirty = true
       WHERE id = ${external.testRunId}`;
    await bindAtCurrent('surface:GET /events', external.testRunId, external.coverageEvidenceRef);

    const promoted = await specs.setSpecClause(clause({ expectedRevision: 1, lifecycleStatus: 'active' }));
    expect(promoted).toMatchObject({ status: 'revised', revision: 2, evidenceCarriedForward: 1 });

    const [carried] = await db.sql<{ id: number; test_run_id: string | number | null }[]>`
      SELECT id, test_run_id
        FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01'
         AND spec_revision = 2 AND evidence_ref = 'surface:GET /events'`;
    // The copy path must preserve the exact run identity. If it dropped the id, the reader
    // would report testRun not-applicable instead of exposing the dirty-run uncertainty.
    expect(Number(carried?.test_run_id)).toBe(external.testRunId);

    const read = (await getTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        detail: 'summary',
        bindingIds: [Number(carried?.id)],
      } as never,
      CTX,
    )) as { data: { evidence: Array<Record<string, any>>; currentness: Record<string, number> } };
    expect(read.data.currentness).toEqual({ current: 0, stale: 0, unknown: 1 });
    expect(read.data.evidence[0]).toMatchObject({
      testRunId: external.testRunId,
      currentness: {
        overall: 'unknown',
        unknownReasons: expect.arrayContaining(['test-run-worktree-not-clean']),
      },
    });
  });

  it.each(['accepted', 'active'] as const)('carries manual proof when an exempt clause becomes %s and clears required lifecycle metadata', async (lifecycleStatus) => {
    const exemption = { justification: 'Manually inspect the final signed package.', provenance: 'D-003' };
    const manual = clause({
      lifecycleStatus: 'exempt', behaviorClass: 'non-automated', requiredTestLayers: [],
      mutationRequired: false, requiredEvidence: ['deployed'], exemption,
    });
    await specs.setSpecClause(manual);
    const external = await seedExternalEvidence();
    expect(await evidenceStore.bindSpecEvidence({
      harnessSlug: HARNESS, planSlug: 'reconnect-plan', workItemId: 'WI-101',
      specId: 'SPEC-003-01', evidenceKind: 'manual', evidenceRef: 'package:final-signed',
      sourceFingerprint: 'git:abc123', testRunId: external.testRunId, actorId: 'su-test',
    })).toMatchObject({ status: 'created' });

    const promoted = await specs.setSpecClause({
      ...manual, expectedRevision: 1, lifecycleStatus, exemption: null,
    });
    expect(promoted).toMatchObject({ status: 'revised', revision: 2, evidenceCarriedForward: 1 });
    expect(await liveRefsAt(2)).toEqual(['package:final-signed']);
    const [current] = await specs.listSpecClauses({
      harnessSlug: HARNESS, planSlug: 'reconnect-plan', specIds: ['SPEC-003-01'],
    });
    expect(current).toMatchObject({ lifecycleStatus, exemption: null, behaviorClass: 'non-automated' });
    const [prior] = await specs.listSpecClauses({
      harnessSlug: HARNESS, planSlug: 'reconnect-plan', specIds: ['SPEC-003-01'], revision: 1,
    });
    expect(prior).toMatchObject({ lifecycleStatus: 'exempt', exemption });
    const [carried] = await db.sql<{ test_run_id: string | number; evidence_kind: string }[]>`
      SELECT test_run_id, evidence_kind FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01' AND spec_revision = 2`;
    expect(Number(carried?.test_run_id)).toBe(external.testRunId);
    expect(carried?.evidence_kind).toBe('manual');
  });

  it('does not treat changed manual proof obligations as exemption-only provenance', () => {
    const exemption = { justification: 'Manual signed package inspection.', provenance: 'D-003' };
    const manual = clause({
      lifecycleStatus: 'exempt', behaviorClass: 'non-automated', requiredTestLayers: [],
      mutationRequired: false, requiredEvidence: ['deployed'], exemption,
    });
    const prior = { lifecycleStatus: 'exempt' as const, acceptanceRef: 'D-003', exemption };
    const hash = specs.specClauseContentHash(manual);
    const promoted = { ...manual, lifecycleStatus: 'active' as const, exemption: null };
    expect(specs.differsOnlyInAcceptanceProvenance(promoted, prior, null, hash)).toBe(true);
    for (const changed of [
      { ...promoted, behavior: 'A different package outcome.' },
      { ...promoted, requiredEvidence: ['live'] },
      { ...promoted, requiredTestLayers: ['unit'] },
      { ...promoted, mutationRequired: true },
      { ...promoted, behaviorClass: 'happy-path' },
    ] as typeof promoted[]) {
      expect(specs.differsOnlyInAcceptanceProvenance(changed, prior, null, hash)).toBe(false);
    }
  });

  it('does NOT carry proof across a substantive edit, even one that also changes lifecycle', async () => {
    await specs.setSpecClause(clause({ lifecycleStatus: 'draft' }));
    const external = await seedExternalEvidence();
    await bindAtCurrent('surface:GET /events', external.testRunId, external.coverageEvidenceRef);

    const edited = await specs.setSpecClause(clause({
      expectedRevision: 1,
      lifecycleStatus: 'active',
      behavior: 'Acknowledged event 42 is not replayed after reconnect, even across a restart.',
    }));
    expect(edited).toMatchObject({ status: 'revised', revision: 2 });
    expect(edited).not.toHaveProperty('evidenceCarriedForward');
    expect(await liveRefsAt(2)).toEqual([]);
    // The prior proof is kept at its own revision, not deleted.
    expect(await liveRefsAt(1)).toEqual(['surface:GET /events']);
  });

  it('does not carry onto a non-enforceable lifecycle (active -> superseded)', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    await bindAtCurrent('surface:GET /events', external.testRunId, external.coverageEvidenceRef);

    const retired = await specs.setSpecClause(clause({ expectedRevision: 1, lifecycleStatus: 'superseded' }));
    expect(retired).toMatchObject({ status: 'revised', revision: 2 });
    expect(await liveRefsAt(2)).toEqual([]);
  });

  // WI-10003763: plans:set-specs promotions that OMITTED acceptanceRef landed it as NULL. That
  // stripped the ref spec-quality requires on every active clause, and it hashed the promotion as
  // a real edit, so this carry never fired and all 57 promoted clauses of a live plan went stale.
  it('rides an omitted acceptanceRef forward, so an omitting promotion still carries proof', async () => {
    await specs.setSpecClause(clause({ lifecycleStatus: 'draft', acceptanceRef: 'acceptance-reconnect@1:R-1' }));
    const external = await seedExternalEvidence();
    await bindAtCurrent('surface:GET /events', external.testRunId, external.coverageEvidenceRef);

    const promoted = await specs.setSpecClause(
      clause({ expectedRevision: 1, lifecycleStatus: 'active', acceptanceRef: undefined }),
    );
    expect(promoted).toMatchObject({ status: 'revised', revision: 2, evidenceCarriedForward: 1 });
    expect(await liveRefsAt(2)).toEqual(['surface:GET /events']);
    const [row] = await db.sql<{ acceptance_ref: string | null }[]>`
      SELECT acceptance_ref FROM harness_shared.plan_spec_clause_revisions
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01' AND revision = 2`;
    expect(row?.acceptance_ref).toBe('acceptance-reconnect@1:R-1');

    // The stored hash describes the stored row: re-sending the same omitting write is a no-op.
    expect(
      await specs.setSpecClause(clause({ expectedRevision: 2, lifecycleStatus: 'active', acceptanceRef: undefined })),
    ).toMatchObject({ status: 'unchanged', revision: 2 });
  });

  it('carries proof across an acceptanceRef-only revision (clearing it, then restoring it)', async () => {
    await specs.setSpecClause(clause({ lifecycleStatus: 'active', acceptanceRef: 'D-003' }));
    const external = await seedExternalEvidence();
    await bindAtCurrent('surface:GET /events', external.testRunId, external.coverageEvidenceRef);

    // An EXPLICIT null still clears the ref (only omission rides forward) ...
    const cleared = await specs.setSpecClause(clause({ expectedRevision: 1, acceptanceRef: null }));
    expect(cleared).toMatchObject({ status: 'revised', revision: 2, evidenceCarriedForward: 1 });
    // ... and restoring it is the repair for a clause that lost it, without re-proving anything.
    const restored = await specs.setSpecClause(clause({ expectedRevision: 2, acceptanceRef: 'D-003' }));
    expect(restored).toMatchObject({ status: 'revised', revision: 3, evidenceCarriedForward: 1 });
    expect(await liveRefsAt(3)).toEqual(['surface:GET /events']);
  });

  it('carries proof when only the pinned rubric revision and acceptanceRef advance', async () => {
    const priorBar = {
      barKey: 'R-1',
      barHash: 'a'.repeat(64),
      barSetHash: 'b'.repeat(64),
      rubricSlug: 'acceptance-reconnect-plan',
      rubricRevision: 2,
      evidencePlane: 'tree' as const,
    };
    const nextBar = { ...priorBar, rubricRevision: 3 };
    const acceptanceRef = (revision: number) => `acceptance-reconnect-plan@${revision}:R-1`;

    await specs.setSpecClause(clause({
      lifecycleStatus: 'active',
      acceptanceRef: acceptanceRef(2),
      sourceBar: priorBar,
    }));
    const external = await seedExternalEvidence();
    await bindAtCurrent('surface:GET /events', external.testRunId, external.coverageEvidenceRef);

    const advanced = await specs.setSpecClause(clause({
      expectedRevision: 1,
      lifecycleStatus: 'active',
      acceptanceRef: acceptanceRef(3),
      sourceBar: nextBar,
    }));
    expect(advanced).toMatchObject({ status: 'revised', revision: 2, evidenceCarriedForward: 1 });
    expect(await liveRefsAt(2)).toEqual(['surface:GET /events']);

    const [stored] = await db.sql<{
      acceptance_ref: string;
      source_bar_key: string;
      source_bar_hash: string;
      source_bar_set_hash: string;
      source_rubric_slug: string;
      source_rubric_revision: number;
      evidence_plane: string;
    }[]>`
      SELECT acceptance_ref, source_bar_key, source_bar_hash, source_bar_set_hash,
             source_rubric_slug, source_rubric_revision, evidence_plane
        FROM harness_shared.plan_spec_clause_revisions
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01' AND revision = 2`;
    expect(stored).toEqual({
      acceptance_ref: acceptanceRef(3),
      source_bar_key: 'R-1',
      source_bar_hash: 'a'.repeat(64),
      source_bar_set_hash: 'b'.repeat(64),
      source_rubric_slug: 'acceptance-reconnect-plan',
      source_rubric_revision: 3,
      evidence_plane: 'tree',
    });

    const changedBarIdentity = {
      ...nextBar,
      barHash: 'c'.repeat(64),
      barSetHash: 'd'.repeat(64),
      rubricRevision: 4,
    };
    const identityChanged = await specs.setSpecClause(clause({
      expectedRevision: 2,
      lifecycleStatus: 'active',
      acceptanceRef: acceptanceRef(4),
      sourceBar: changedBarIdentity,
    }));
    expect(identityChanged).toMatchObject({ status: 'revised', revision: 3 });
    expect(identityChanged).not.toHaveProperty('evidenceCarriedForward');
    expect(await liveRefsAt(3)).toEqual([]);
    expect(await liveRefsAt(2)).toEqual(['surface:GET /events']);
  });

  it('differsOnlyInAcceptanceProvenance answers false for any other change', () => {
    const draft = clause({ lifecycleStatus: 'draft' });
    const draftHash = specs.specClauseContentHash(draft);
    const prior = { lifecycleStatus: 'draft' as const, acceptanceRef: 'D-003' };
    expect(specs.differsOnlyInAcceptanceProvenance(clause({ lifecycleStatus: 'active' }), prior, null, draftHash)).toBe(true);
    expect(
      specs.differsOnlyInAcceptanceProvenance(
        clause({ lifecycleStatus: 'active', acceptanceRef: 'D-999' }), prior, null, draftHash,
      ),
    ).toBe(true);
    expect(
      specs.differsOnlyInAcceptanceProvenance(
        clause({ lifecycleStatus: 'active', requiredTestLayers: ['unit'] }), prior, null, draftHash,
      ),
    ).toBe(false);
    expect(
      specs.differsOnlyInAcceptanceProvenance(clause({ lifecycleStatus: 'active', mutationRequired: false }), prior, null, draftHash),
    ).toBe(false);
  });
});
