/** Private worker for measurement-replay-background.integration.test.ts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { rescoreRubric } from './harness/routines/rubric-rescore-action';
import { readLatestRubricCheckResults } from './check-results-ledger';
import { replayRetainedProbe, replayRetainedSqlProbe, continuityProbeRevision } from './continuity-probes';
import { replayRetainedInstrument, runInstrument } from './rubric-instrument-registry';
import { pgReadQuery } from './pg-read-query';
import type { CheckedCriterion } from './rubrics-criterion-checks';
import pgQuery from './agent-tools/dev/pg_query';
import { flushPendingTelemetry } from './projected-tool-deps';

const root = resolve(import.meta.dirname, '../../..');
const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID!;
assert.match(workspaceId, /^test-runtime-/);
assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
assert.equal(pgQuery.name, 'dev:pg_query');
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'])
  assert.equal(process.env[key], undefined, key + ' must not enter the private runtime');
const expectedHashes = JSON.parse(process.env.MEASUREMENT_REPLAY_SOURCE_HASHES!) as Record<string, string>;
const sourceHashes = Object.fromEntries(Object.entries(expectedHashes).map(([path, expected]) => {
  const actual = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  assert.equal(actual, expected, 'source changed before private worker import: ' + path);
  return [path, actual];
}));
const profileDir = join(process.env.PAPERCUSP_HOME!, 'loop-profiles');
const sql = getOrgPg().sql;

try {
  const [server] = await sql`SELECT inet_server_port() AS port`;
  assert.equal(String(server!.port), process.env.PAPERCUSP_PG_PORT);
  assert.equal(new URL(process.env.HARNESS_ADMIN_DATABASE_URL!).port, String(server!.port));
  await mkdir(profileDir, { recursive: true });
  // Six real private filenames produce >256 bytes of ls input. Their 120%
  // synthetic budget is a rejection control, never an application-speed claim.
  await Promise.all(Array.from({ length: 6 }, (_, i) => writeFile(join(profileDir,
    `loop-saturation-${Date.now() - i}-pid${i + 1}-p95_100ms.cpuprofile`), '{}')));
  await sql`CREATE TABLE harness_shared.measurement_replay_source
    (workspace_id text, id bigint, duration_ms float8, measured_at timestamptz,
     PRIMARY KEY (workspace_id,id))`;
  // The migrated private runtime publishes tables for replication. Verify the
  // fixture's update identity before spending a measurement run on mutation.
  const [identity] = await sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_index
    WHERE indrelid='harness_shared.measurement_replay_source'::regclass AND indisprimary) AS ready`;
  assert.equal(identity!.ready, true, 'mutable private fixture requires replica identity');
  await sql`INSERT INTO harness_shared.measurement_replay_source VALUES
    (${workspaceId},9007199254740993,10,now()),(${workspaceId},9007199254740994,30,now())`;
  const query = `SELECT avg(duration_ms)::float8 budget_pct FROM harness_shared.measurement_replay_source
    WHERE workspace_id='${workspaceId}' AND measured_at > now()-interval '1 hour'`;
  const scopedQuery = `WITH original AS (${query}) SELECT budget_pct,repeat('advisory ',60) advisory FROM original`;
  const criterion = (key: string, query: string): CheckedCriterion => ({ key, check: { kind: 'probe', unit: '%',
    probe: { kind: 'sql', sql: query, maxRows: 50, schemaRevision: continuityProbeRevision('dev:pg_query')!,
      expect: { path: '$.rows[0].budget_pct', op: 'lte', value: 100 } } } });
  const criteria: CheckedCriterion[] = [
    { key: 'command', check: { kind: 'instrument', instrumentKey: 'host:loop-profile-budget-pct',
      expect: { op: 'lte', value: 100 } } },
    criterion('sql', query), criterion('scoped', scopedQuery),
  ];
  const rubricRef = 'private-measurement-replay';
  // Only rubric definition is a fixture. Execution, parser, ledger writer and
  // reader are the current production implementations, with no injected values.
  const outcome = await rescoreRubric({ rubricRef, workspaceId, harnessSlug: null }, {
    getRubric: async () => ({ rubricId: rubricRef, workspaceId, kind: 'standard', criteria }),
  });
  assert.equal(outcome.probeError, undefined);
  assert.equal(outcome.executed, 3);
  assert.equal(outcome.testRunIds.length, 3);
  const latest = await readLatestRubricCheckResults({ rubricRef, workspaceId });
  const checks = Object.fromEntries([...latest.values()].map(row => [row.check.criterionKey, row]));
  assert.equal(checks.command!.status, 'fail');
  assert.equal(checks.sql!.status, 'pass');
  assert.equal(checks.scoped!.status, 'pass');
  const input = (key: string) => {
    const check = checks[key]!.check;
    return { value: check.value!, unit: check.unit ?? null, provenance: check.provenance };
  };
  const command = input('command'), originalSql = input('sql'), scoped = input('scoped');
  assert.deepEqual(command.provenance!.gaps, []);
  assert.ok(command.provenance!.diagnostics.filter(d => d.path.includes('stdout')).length > 1);
  assert.deepEqual(originalSql.provenance!.gaps, ['diagnostics-truncated']);
  assert.equal(JSON.parse(originalSql.provenance!.procedure.snapshot).sqlInputs.truncated, false);
  assert.ok(scoped.provenance!.gaps.includes('diagnostics-truncated'));
  assert.equal(scoped.provenance!.predicateInput?.value, 20);
  await sql`UPDATE harness_shared.measurement_replay_source SET duration_ms=500`;
  await rm(profileDir, { recursive: true });
  await mkdir(profileDir);
  const commandReplay = replayRetainedInstrument(command);
  const sqlReplay = await replayRetainedSqlProbe(originalSql);
  const scopedReplay = replayRetainedProbe(scoped);
  const scopedSqlReplay = await replayRetainedSqlProbe(scoped);
  assert.equal(commandReplay.status, 'reproduced');
  assert.equal(commandReplay.value, 120);
  assert.equal(sqlReplay.status, 'reproduced');
  assert.equal(sqlReplay.value, 20);
  assert.equal(scopedReplay?.status, 'reproduced');
  assert.equal(scopedReplay?.scope, 'probe-predicate');
  assert.equal(scopedReplay?.value, 20);
  assert.equal(scopedSqlReplay.status, 'unavailable');
  assert.equal(scopedSqlReplay.value, null);
  const liveCommand = await runInstrument('host:loop-profile-budget-pct');
  const liveSql = await pgReadQuery(query);
  assert.equal(liveCommand.value, 0);
  assert.equal(liveSql.rows[0]!.budget_pct, 500);
  console.log('MEASUREMENT_REPLAY_RECEIPT ' + JSON.stringify({ sourceHashes, workspaceId,
    pgPort: server!.port, recorded: outcome.testRunIds.length,
    command: { value: command.value, replay: commandReplay.value },
    sql: { value: originalSql.value, replay: sqlReplay.value },
    scoped: { value: scoped.value, replay: scopedReplay!.value, sqlReplay: scopedSqlReplay.status },
    liveAfterMutation: { command: liveCommand.value, sql: liveSql.rows[0]!.budget_pct } }));
} finally {
  await flushPendingTelemetry();
  await sql.end({ timeout: 2 });
}
