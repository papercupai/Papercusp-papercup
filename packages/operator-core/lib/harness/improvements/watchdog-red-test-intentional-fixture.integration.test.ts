/**
 * watchdog-red-test-intentional-fixture.integration.test.ts — EI-25174072255667325.
 *
 * run-failure-fixture.test.ts is intentionally red when enabled by the
 * testing:run assertion-detail integration test. The nested run is supposed
 * to fail so the outer test can verify that actual/expected assertion values
 * survive distillation; the normal test-run reporter still records that
 * expected red in test_runs. Three such outer runs therefore used to satisfy
 * the watchdog's repeated-red query.
 *
 * Exercise the SQL against real Postgres. The first case prevents expected-red
 * fixture runs from filing watchdog work-items. The control keeps a real,
 * repeated regression visible.
 *
 * Run through the registered test router:
 * PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/harness/improvements/watchdog-red-test-intentional-fixture.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { resolveTestRunSource, type TestRunSource } from '../../testing-run-source';
import { fetchRedTestRows } from './watchdog';

let db: FreshPgDb;

const INTENTIONAL_RED_FIXTURE =
  'packages/operator-core/lib/agent-tools/testing/__tests__/run-failure-fixture.test.ts';
const CONTROLLED_PLACEMENT_FIXTURE =
  'packages/operator-core/lib/goal-plan-placement-exclusion-proof.test.ts';
const CONTROLLED_PLACEMENT_CLAIM_FIXTURE =
  'packages/operator-core/lib/goal-plan-placement-claim-proof.test.ts';
const CONTROLLED_GOAL_RESPAWN_FIXTURE =
  'packages/operator-core/lib/system-health/goal-liveness-watchdog.test.ts';
const CONTROLLED_FIXTURE_ONLY = 'packages/operator-core/lib/controlled-fixture-only.test.ts';
const REAL_REGRESSION = 'packages/operator-core/lib/real-regression.test.ts';
const controlledGoalRespawnSource = resolveTestRunSource(
  { PAPERCUSP_GOAL_RESPAWN_CONTROL: 'elected-loss-recovery' },
  CONTROLLED_GOAL_RESPAWN_FIXTURE,
);
const controlledPlacementClaimSource = resolveTestRunSource(
  { PAPERCUSP_PLACEMENT_CLAIM_CONTROL: 'member-claim-and-lease' },
  CONTROLLED_PLACEMENT_CLAIM_FIXTURE,
);
const controlledPlacementLifecycleSource = resolveTestRunSource(
  { PAPERCUSP_PLACEMENT_LIFECYCLE_CONTROL: 'satisfied-closure' },
  CONTROLLED_PLACEMENT_CLAIM_FIXTURE,
);

beforeAll(async () => {
  db = await createFreshPgDb('redtest-intentional-fixture');

  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.test_runs (
      id bigint generated always as identity primary key,
      file_path text NOT NULL,
      framework text,
      status text NOT NULL,
      duration_ms bigint,
      started_at timestamptz,
      finished_at timestamptz,
      output_tail text,
      run_group_id text,
      source text,
      branch text,
      commit_sha text,
      created_at timestamptz NOT NULL DEFAULT now(),
      harness_slug text,
      workspace_id text,
      is_scratch_config boolean NOT NULL DEFAULT false
    )
  `);

  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
  const rows: Array<{ filePath: string; status: string; startedAt: Date; source?: TestRunSource }> = [
    { filePath: INTENTIONAL_RED_FIXTURE, status: 'fail', startedAt: at(30) },
    { filePath: INTENTIONAL_RED_FIXTURE, status: 'fail', startedAt: at(20) },
    { filePath: INTENTIONAL_RED_FIXTURE, status: 'fail', startedAt: at(5) },
    { filePath: CONTROLLED_PLACEMENT_FIXTURE, status: 'pass', startedAt: at(50), source: 'local' },
    { filePath: CONTROLLED_PLACEMENT_FIXTURE, status: 'pass', startedAt: at(40), source: 'local' },
    { filePath: CONTROLLED_PLACEMENT_FIXTURE, status: 'fail', startedAt: at(30), source: 'mutation-probe' },
    { filePath: CONTROLLED_PLACEMENT_FIXTURE, status: 'fail', startedAt: at(20), source: 'mutation-probe' },
    { filePath: CONTROLLED_PLACEMENT_FIXTURE, status: 'fail', startedAt: at(5), source: 'mutation-probe' },
    { filePath: CONTROLLED_GOAL_RESPAWN_FIXTURE, status: 'pass', startedAt: at(50), source: 'local' },
    { filePath: CONTROLLED_GOAL_RESPAWN_FIXTURE, status: 'pass', startedAt: at(40), source: 'local' },
    { filePath: CONTROLLED_GOAL_RESPAWN_FIXTURE, status: 'fail', startedAt: at(30), source: controlledGoalRespawnSource },
    { filePath: CONTROLLED_GOAL_RESPAWN_FIXTURE, status: 'fail', startedAt: at(20), source: controlledGoalRespawnSource },
    { filePath: CONTROLLED_GOAL_RESPAWN_FIXTURE, status: 'fail', startedAt: at(5), source: controlledGoalRespawnSource },
    { filePath: CONTROLLED_PLACEMENT_CLAIM_FIXTURE, status: 'pass', startedAt: at(50), source: 'local' },
    { filePath: CONTROLLED_PLACEMENT_CLAIM_FIXTURE, status: 'fail', startedAt: at(30), source: controlledPlacementClaimSource },
    { filePath: CONTROLLED_PLACEMENT_CLAIM_FIXTURE, status: 'fail', startedAt: at(20), source: controlledPlacementClaimSource },
    { filePath: CONTROLLED_PLACEMENT_CLAIM_FIXTURE, status: 'fail', startedAt: at(5), source: controlledPlacementLifecycleSource },
    { filePath: CONTROLLED_FIXTURE_ONLY, status: 'fail', startedAt: at(25), source: 'mutation-probe' },
    { filePath: CONTROLLED_FIXTURE_ONLY, status: 'fail', startedAt: at(15), source: 'mutation-probe' },
    { filePath: CONTROLLED_FIXTURE_ONLY, status: 'fail', startedAt: at(5), source: 'mutation-probe' },
    { filePath: REAL_REGRESSION, status: 'fail', startedAt: at(30) },
    { filePath: REAL_REGRESSION, status: 'fail', startedAt: at(20) },
    { filePath: REAL_REGRESSION, status: 'fail', startedAt: at(5) },
  ];

  for (const row of rows) {
    await db.sql`
      INSERT INTO harness_shared.test_runs
        (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, source, is_scratch_config)
      VALUES
        (${row.filePath}, 'vitest', ${row.status}, 100, ${row.startedAt}, ${row.startedAt}, 'assertion mismatch', ${row.source ?? 'local'}, false)
    `;
  }
});

afterAll(async () => {
  await db?.cleanup();
});

describe('fetchRedTestRows excludes intentionally red assertion fixtures', () => {
  it('does not treat nested expected failures as a repository regression', async () => {
    const rows = await fetchRedTestRows(
      db.sql as unknown as Parameters<typeof fetchRedTestRows>[0],
      { redTestWindowHours: 6, redTestMinFails: 3 },
    );

    expect(rows.map((row) => row.file_path)).not.toContain(INTENTIONAL_RED_FIXTURE);
  });

  it('still surfaces an ordinary repeated red regression', async () => {
    const rows = await fetchRedTestRows(
      db.sql as unknown as Parameters<typeof fetchRedTestRows>[0],
      { redTestWindowHours: 6, redTestMinFails: 3 },
    );
    const row = rows.find((candidate) => candidate.file_path === REAL_REGRESSION);

    expect(row).toBeDefined();
    expect(row?.fails).toBe(3);
  });

  it('excludes controlled fixture probes from fail counts and latest-run freshness', async () => {
    const rows = await fetchRedTestRows(
      db.sql as unknown as Parameters<typeof fetchRedTestRows>[0],
      { redTestWindowHours: 6, redTestMinFails: 3 },
    );

    const paths = rows.map((row) => row.file_path);
    expect(paths).not.toContain(CONTROLLED_PLACEMENT_FIXTURE);
    expect(paths).not.toContain(CONTROLLED_PLACEMENT_CLAIM_FIXTURE);
    expect(paths).not.toContain(CONTROLLED_GOAL_RESPAWN_FIXTURE);
    expect(paths).not.toContain(CONTROLLED_FIXTURE_ONLY);
  });

  it('surfacesWithoutTheFix: the fixture qualifies under the prior query', async () => {
    const rows = await db.sql<Array<{ file_path: string }>>`
      WITH recent AS (
        SELECT file_path, status,
               row_number() OVER (PARTITION BY file_path ORDER BY started_at DESC) AS rn
          FROM harness_shared.test_runs
         WHERE started_at > now() - make_interval(hours => 6)
           AND status IN ('pass', 'fail', 'error')
           AND source <> 'mutation-probe'
           AND file_path LIKE '%/%'
           AND is_scratch_config = false
           AND NOT (
             status IN ('fail', 'error')
             AND duration_ms = 0
             AND output_tail LIKE '%ENOENT: no such file or directory, open ''/tmp/%'
           )
      )
      SELECT file_path
        FROM recent
       GROUP BY file_path
      HAVING count(*) FILTER (WHERE status IN ('fail', 'error')) >= 3
         AND max(CASE WHEN rn = 1 THEN status END) IN ('fail', 'error')
    `;

    expect(rows.map((row) => row.file_path)).toContain(INTENTIONAL_RED_FIXTURE);
  });
});
