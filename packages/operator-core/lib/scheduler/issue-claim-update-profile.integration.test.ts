/**
 * Focused performance reproduction for the Luna Max fleet's rev-23 issue claim.
 *
 * Uses the real migration chain so the candidate selector, payload indexes, and
 * work-item update triggers match production. It reports candidate-selection
 * EXPLAIN timings separately from the claim UPDATE's index and trigger timings.
 *
 * Run with: PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/scheduler/issue-claim-update-profile.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import postgres from 'postgres';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { FLAGS, FLAG_DEFAULTS, type FlagKey } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { validateClaimSpec, type ClaimSpec } from './claim-spec';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);
const FLEET = 'nonp2p-bug-drain-luna-max-0930';
const HARNESS = 'papercusp';
const WORKSPACE = 'papercusp-workspace';
const CANDIDATE_ID = 'EI-CLAIM-PROFILE-CANDIDATE';
const NOISE_ROWS = 20_000;
// These inserts run with USER triggers disabled, so use one shared column list and
// provide the nature/audience values normally stamped by nature_stamp_from_registry_trg.
const WORK_ITEM_FIXTURE_COLUMNS = [
  'workspace_id', 'harness_slug', 'feature_id', 'item_kind', 'status', 'title', 'summary',
  'created_ts', 'updated_ts', 'origin', 'admission', 'payload', 'nature', 'audience',
] as const;
const WORK_ITEM_FIXTURE_COLUMNS_SQL = WORK_ITEM_FIXTURE_COLUMNS.join(', ');
const TRIGGER_DERIVED_COLUMNS = ['nature', 'audience'] as const;

const state = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  issuesClaimable: true,
}));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: state.sql }) };
});

vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WORKSPACE };
});

vi.mock('@papercusp/flags/server', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return {
    ...(await orig<typeof import('@papercusp/flags/server')>()),
    ...actual,
    getFlag: async (key: FlagKey) =>
      key === FLAGS.SCHEDULER_ISSUES_CLAIMABLE ? state.issuesClaimable : (FLAG_DEFAULTS[key] ?? false),
  };
});

const getNextApi = await import('./get-next');
const {
  ALL_ISSUE_CLAIM_FLOORS_PASS,
  compileFilter,
  compileRank,
  getNextWorkItem,
  issueClaimCandidateSubquery,
} = getNextApi;
const requiredGetNextFunctions: Array<[string, unknown]> = [
  ['compileFilter', compileFilter],
  ['compileRank', compileRank],
  ['getNextWorkItem', getNextWorkItem],
  ['issueClaimCandidateSubquery', issueClaimCandidateSubquery],
];
const missingGetNextFunctions = requiredGetNextFunctions
  .filter(([, value]) => typeof value !== 'function')
  .map(([name]) => name);
if (missingGetNextFunctions.length || typeof ALL_ISSUE_CLAIM_FLOORS_PASS !== 'string') {
  throw new Error(`issue-claim profile test has invalid get-next exports: ${missingGetNextFunctions.join(', ') || 'ALL_ISSUE_CLAIM_FLOORS_PASS'}`);
}
const { releaseCooldownSec } = await import('../work-items');

const p2pTerms = [
  'p2p', 'shared-hive', 'federation', 'federated', 'federate', 'federates', 'federating',
  'holepunch', 'steering lease', 'replication', 'swarm', 'hyperswarm', 'hyperdht',
  'hyperbee', 'dht', 'udx', 'relay', 'pot-git', 'ref-announce', 'duplex', 'hypercore',
  'hyperblobs', 'hyperdrive', 'autobase',
];
const excludedIds = [
  'EI-25515264361669386', 'EI-26974790589462880', 'EI-26977687586838127',
  'EI-26979455957616528', 'EI-26986816374418138', 'EI-26998742170340278',
  'EI-27003614601744414', 'EI-27008220970145814', 'EI-27010581342204673',
  'EI-27011842371516437', 'EI-27014956940540299', 'EI-27042103335718168',
  'EI-27072885052499278', 'EI-27075802791778412', 'WI-10006055',
  'WI-6554700010019833',
];
const specFilter = {
  all: [
    {
      all: [{
        any: [{
          all: [
            { op: 'in', field: 'kind', value: ['bug'] },
            { not: { any: p2pTerms.flatMap((value) =>
              (['title', 'summary', 'plan'] as const).map((field) => ({ op: 'word', field, value }))) } },
          ],
        }],
      }],
    },
    {
      not: {
        any: [
          { op: 'in', field: 'plan', value: [
            'mobile-agent-sessions-2026-10-12',
            'parked-agent-census-resumption-and-root-cause-2026-10-09',
            'get-feedback-reliability-usefulness-adoption-2026-10-03',
          ] },
          { op: 'contains', field: 'title', value: 'Spec drift: mobile-agent-sessions-2026-10-12 ' },
          { op: 'contains', field: 'title', value: 'Spec drift: parked-agent-census-resumption-and-root-cause-2026-10-09 ' },
          { op: 'contains', field: 'title', value: 'Spec drift: get-feedback-reliability-usefulness-adoption-2026-10-03 ' },
        ],
      },
    },
    { not: { op: 'in', field: 'id', value: excludedIds } },
    { not: { op: 'contains', field: 'title', value: '[frozen-repair-leg:' } },
  ],
};

const LIVE_SPEC: ClaimSpec = {
  specVersion: '1.0',
  specId: 'fleet-launch-nonp2p-bug-drain-luna-max-0930-kinds',
  revision: 23,
  view: { filter: specFilter },
  rank: {
    mode: 'lexicographic',
    terms: [
      { expr: 'affinity(bee.held_paths,item.paths)', dir: 'desc' },
      { expr: 'severity_rank', dir: 'desc' },
      { expr: 'priority', dir: 'desc' },
      { expr: 'age', dir: 'asc' },
    ],
  },
  limits: { maxConcurrentClaims: 2 },
  states: ['open'],
};

const BEE = { assignee: 'claim-profile-bee', heldPaths: [] as string[], contendedPaths: [] as string[] };
const BOOT_PREREQUISITES = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

let db: MigratedTestDb;
let sql: postgres.Sql;

function assertMigrationPaths(): void {
  const missing = [SQL_DIR, MIGRATION_RUNNER].filter((path) => !existsSync(path));
  if (missing.length) {
    throw new Error(`issue-claim profile test migration paths do not exist: ${missing.join(', ')}`);
  }
}

async function assertFixtureSchema(): Promise<void> {
  const required = await sql<{ column_name: string }[]>`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name = 'work_items'
       AND is_nullable = 'NO'
       AND column_default IS NULL
       AND is_identity = 'NO'
       AND is_generated = 'NEVER'
     ORDER BY ordinal_position`;
  const requiredColumns = new Set(required.map(({ column_name }) => column_name));
  for (const column of TRIGGER_DERIVED_COLUMNS) requiredColumns.add(column);
  const fixtureColumns = new Set<string>(WORK_ITEM_FIXTURE_COLUMNS);
  const missing = [...requiredColumns].filter((column) => !fixtureColumns.has(column));
  if (missing.length) {
    throw new Error(`issue-claim profile fixture omits required or disabled-trigger columns: ${missing.join(', ')}`);
  }
}

beforeAll(async () => {
  assertMigrationPaths();
  db = await createFreshTestDb({
    prefix: 'issueclaimprofile',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
      };
      const client = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await client.unsafe(BOOT_PREREQUISITES);
        await applyPendingMigrations({ client, sqlDir: SQL_DIR });
      } finally {
        await client.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 8, onnotice: () => {}, prepare: false });
  state.sql = sql;
}, 240_000);

afterAll(async () => {
  setFlagOverridesForTest(null);
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

function explainPayload(row: { 'QUERY PLAN': Array<Record<string, unknown>> }) {
  return row['QUERY PLAN'][0] as {
    Plan: Record<string, unknown>;
    'Planning Time'?: number;
    'Execution Time'?: number;
    Triggers?: Array<{ 'Trigger Name': string; Time: number; Calls: number }>;
    WAL?: Record<string, number>;
  };
}

describe('scheduler issue-claim revision 23 selector vs update profile', () => {
  it('measures current-spec candidate floors separately from payload/index/trigger update work', async () => {
    const validation = validateClaimSpec(LIVE_SPEC);
    expect(validation.ok, validation.errors.join('; ')).toBe(true);
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    state.issuesClaimable = true;

    // Keep bulk fixture construction from producing 20,000 federation and notify writes.
    // The real triggers are re-enabled before any measured UPDATE below.
    await assertFixtureSchema();
    await sql.unsafe('ALTER TABLE harness_shared.work_items DISABLE TRIGGER USER');
    await sql`
      INSERT INTO harness_shared.work_items
        (${sql.unsafe(WORK_ITEM_FIXTURE_COLUMNS_SQL)})
      SELECT ${WORKSPACE}, ${HARNESS}, 'EI-CLAIM-PROFILE-NOISE-' || lpad(n::text, 6, '0'),
             'bug', 'open', 'p2p synthetic excluded row ' || n,
             'shared-hive synthetic excluded body ' || n, n, n, 'local', 'pending',
             jsonb_build_object('_ei', jsonb_build_object('severity', 'critical')), 'work', 'agent'
        FROM generate_series(1, ${NOISE_ROWS}) AS n`;
    await sql`
      INSERT INTO harness_shared.work_items
        (${sql.unsafe(WORK_ITEM_FIXTURE_COLUMNS_SQL)})
      VALUES (${WORKSPACE}, ${HARNESS}, ${CANDIDATE_ID}, 'bug', 'open',
              'scheduler issue claim profile candidate', 'routine bug drain reproduction',
              ${NOISE_ROWS + 1}, ${NOISE_ROWS + 1}, 'local', NULL,
              jsonb_build_object('_ei', jsonb_build_object('severity', 'major'),
                                 'profileBody', repeat('x', 12000)), 'work', 'agent')`;
    await sql`
      INSERT INTO harness_shared.work_items
        (${sql.unsafe(WORK_ITEM_FIXTURE_COLUMNS_SQL)})
      VALUES (${WORKSPACE}, ${HARNESS}, 'EI-26974790589462880', 'bug', 'open',
              'safe title but id excluded by rev23', 'routine summary',
              ${NOISE_ROWS + 2}, ${NOISE_ROWS + 2}, 'local', NULL,
              jsonb_build_object('_ei', jsonb_build_object('severity', 'critical')), 'work', 'agent'),
             (${WORKSPACE}, ${HARNESS}, 'EI-CLAIM-PROFILE-FROZEN', 'bug', 'open',
              '[frozen-repair-leg: fixture]', 'routine summary',
              ${NOISE_ROWS + 3}, ${NOISE_ROWS + 3}, 'local', NULL,
              jsonb_build_object('_ei', jsonb_build_object('severity', 'critical')), 'work', 'agent')`;
    await sql.unsafe('ALTER TABLE harness_shared.work_items ENABLE TRIGGER USER');
    await sql.unsafe('ANALYZE harness_shared.work_items');

    const compiled = compileFilter(sql as never, LIVE_SPEC.view.filter);
    const candidateSource = issueClaimCandidateSubquery(sql as never, {
      compiled,
      filterPushdown: compiled,
      projection: 'claimability-snapshot',
      assignee: BEE.assignee,
      cooldown: releaseCooldownSec(),
      harness: HARNESS,
      states: LIVE_SPEC.states ?? ['open'],
      issueWs: WORKSPACE,
      operatorScopeSlug: `operator:${WORKSPACE}`,
      rigAvailable: false,
      claimantFleetSlug: FLEET,
      claimSpecReferencesFleet: false,
      claimSpecReferencesGoal: false,
    });
    const candidatePlanRows = await sql`
      EXPLAIN (ANALYZE, BUFFERS, WAL, TIMING OFF, FORMAT JSON)
      SELECT candidate.feature_id
        FROM (${candidateSource}) AS candidate
       WHERE candidate.spec_match AND ${sql.unsafe(ALL_ISSUE_CLAIM_FLOORS_PASS)}
       ORDER BY ${compileRank(sql as never, LIVE_SPEC, BEE)}
       LIMIT 1`;
    const candidatePlan = explainPayload(candidatePlanRows[0] as never);
    const candidateRows = await sql`
      SELECT candidate.feature_id
        FROM (${candidateSource}) AS candidate
       WHERE candidate.spec_match AND ${sql.unsafe(ALL_ISSUE_CLAIM_FLOORS_PASS)}
       ORDER BY ${compileRank(sql as never, LIVE_SPEC, BEE)}
       LIMIT 1`;
    expect(candidateRows[0]?.feature_id).toBe(CANDIDATE_ID);

    // EXPLAIN ANALYZE executes the UPDATE. The test-only transaction rollback keeps the
    // measured target claimable for the real getNextWorkItem call immediately below.
    const rollback = new Error('rollback issue-claim update profile');
    let updatePlan: ReturnType<typeof explainPayload> | undefined;
    try {
      await sql.begin(async (tx) => {
        const rows = await tx`
          EXPLAIN (ANALYZE, BUFFERS, WAL, TIMING OFF, FORMAT JSON)
          UPDATE harness_shared.work_items AS target
             SET payload = jsonb_set(
                   COALESCE(target.payload, '{}'::jsonb),
                   '{claim_history_post_id}',
                   to_jsonb(COALESCE((
                     SELECT max(post.id)
                       FROM harness_shared.coord_thread_posts post
                      WHERE post.workspace_id = ${WORKSPACE}
                   ), 0)),
                   true
                 ),
                 taken_by = ${BEE.assignee}, taken_at = now(), last_progress_at = NULL, updated_ts = ${Date.now()}
           WHERE target.workspace_id = ${WORKSPACE}
             AND target.harness_slug = ${HARNESS}
             AND target.feature_id = ${CANDIDATE_ID}
          RETURNING target.feature_id`;
        updatePlan = explainPayload(rows[0] as never);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    expect(updatePlan).toBeDefined();
    expect(updatePlan?.Triggers?.some((trigger) => trigger['Trigger Name'] === 'capture_work_items_issue_upd_trg')).toBe(true);

    const phases: Array<{ step: string; ms: number }> = [];
    const claimed = await getNextWorkItem(LIVE_SPEC, BEE, {
      harness: HARNESS,
      workspaceId: WORKSPACE,
      fleetSlug: FLEET,
      client: sql as never,
      onResolutionStep: (step, event) => {
        if (event.phase === 'end' && (step === 'candidate-issue-claim-update' || step === 'candidate-issue-post-claim-reread')) {
          phases.push({ step, ms: event.elapsedMs });
        }
      },
    });
    expect(claimed?.workItem.id).toBe(CANDIDATE_ID);

    console.info('ISSUE_CLAIM_PROFILE ' + JSON.stringify({
      spec: `${LIVE_SPEC.specId}@${LIVE_SPEC.revision}`,
      noiseRows: NOISE_ROWS,
      candidate: {
        planningMs: candidatePlan['Planning Time'],
        executionMs: candidatePlan['Execution Time'],
        buffers: {
          hit: candidatePlan.Plan['Shared Hit Blocks'],
          read: candidatePlan.Plan['Shared Read Blocks'],
          dirtied: candidatePlan.Plan['Shared Dirtied Blocks'],
        },
      },
      update: {
        planningMs: updatePlan?.['Planning Time'],
        executionMs: updatePlan?.['Execution Time'],
        wal: updatePlan?.WAL,
        triggers: updatePlan?.Triggers,
      },
      productionClaimPhases: phases,
    }));
  }, 240_000);
});
