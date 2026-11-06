/** Private worker for measurement-replay-background.integration.test.ts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { getOrgPg } from '@papercusp/db-org';
import { rescoreRubric } from './harness/routines/rubric-rescore-action';
import { readLatestRubricCheckResults } from './check-results-ledger';
import { replayRetainedProbe, replayRetainedSqlProbe, continuityProbeRevision } from './continuity-probes';
import { replayRetainedInstrument, runInstrument } from './rubric-instrument-registry';
import { pgReadQuery } from './pg-read-query';
import type { CheckedCriterion } from './rubrics-criterion-checks';
import pgQuery from './agent-tools/dev/pg_query';
import { flushPendingTelemetry } from './projected-tool-deps';
import { retainedReplaySourceIdentity } from './retained-replay-identity';
import { compileLibraryFixture } from '../test/compiled-library-fixture';

const root = process.env.MEASUREMENT_REPLAY_SOURCE_ROOT ?? resolve(import.meta.dirname, '../../..');
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
const query = `WITH samples AS (SELECT duration_ms FROM harness_shared.measurement_replay_source
  WHERE workspace_id='${workspaceId}' AND measured_at > now()-interval '1 hour'),
  measurement AS (SELECT avg(duration_ms)::float8 budget_pct FROM samples)
  SELECT * FROM measurement`;
const scopedQuery = `WITH original AS (${query}) SELECT budget_pct,repeat('advisory ',60) advisory FROM original`;
const criterion = (key: string, query: string): CheckedCriterion => ({ key, check: { kind: 'probe', unit: '%',
  probe: { kind: 'sql', sql: query, maxRows: 50, schemaRevision: continuityProbeRevision('dev:pg_query')!,
    expect: { path: '$.rows[0].budget_pct', op: 'lte', value: 100 } } } });
const criteria: CheckedCriterion[] = [
  { key: 'command', check: { kind: 'instrument', instrumentKey: 'host:loop-profile-budget-pct',
    expect: { op: 'lte', value: 100 } } },
  criterion('sql', query), criterion('scoped', scopedQuery),
];

async function measure(rubricRef: string) {
  const outcome = await rescoreRubric({ rubricRef, workspaceId, harnessSlug: null }, {
    getRubric: async () => ({ rubricId: rubricRef, workspaceId, kind: 'standard', criteria }),
  });
  assert.equal(outcome.probeError, undefined);
  assert.equal(outcome.executed, 3);
  assert.equal(outcome.testRunIds.length, 3);
  const latest = await readLatestRubricCheckResults({ rubricRef, workspaceId });
  const checks = Object.fromEntries([...latest.values()].map(row => [row.check.criterionKey, row]));
  const inputs = Object.fromEntries(Object.entries(checks).map(([key, row]) => [key, {
    value: row.check.value!, unit: row.check.unit ?? null, provenance: row.check.provenance,
  }]));
  return { outcome, checks, inputs };
}
type Inputs = Awaited<ReturnType<typeof measure>>['inputs'];
async function replay(inputs: Inputs) {
  return { identity: retainedReplaySourceIdentity(),
    command: replayRetainedInstrument(inputs.command!),
    sql: await replayRetainedSqlProbe(inputs.sql!),
    scoped: replayRetainedProbe(inputs.scoped!) };
}

async function main() {
try {
  // The compiled child runs without tsx. Both directions use the real writer,
  // ledger reader, parser and private PostgreSQL; no recorded value is injected.
  const mode = process.env.MEASUREMENT_REPLAY_RUNTIME_MODE;
  if (mode) {
    const inputs = mode === 'write' ? (await measure('private-measurement-replay-compiled')).inputs
      : JSON.parse(readFileSync(process.env.MEASUREMENT_REPLAY_INPUT!, 'utf8')) as Inputs;
    const result = mode === 'write' ? { identity: retainedReplaySourceIdentity(), inputs }
      : await replay(inputs);
    await writeFile(process.env.MEASUREMENT_REPLAY_OUTPUT!, JSON.stringify(result));
  } else {
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
  // Only rubric definition is a fixture. Execution, parser, ledger writer and
  // reader are the current production implementations, with no injected values.
  const { outcome, checks, inputs } = await measure('private-measurement-replay');
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
  const compiledDir = join(process.env.PAPERCUSP_HOME!, 'retained-replay-compiled');
  await mkdir(compiledDir);
  await symlink(join(root, 'node_modules'), join(compiledDir, 'node_modules'), 'dir');
  const bundle = join(compiledDir, 'consumer.mjs');
  const run = promisify(execFile);
  await compileLibraryFixture(root,
    join(root, 'packages/operator-core/lib/measurement-replay-background.fixture.ts'), bundle);
  const inputFile = join(compiledDir, 'source-inputs.json');
  await writeFile(inputFile, JSON.stringify(inputs));
  const child = async (mode: string, home = process.env.PAPERCUSP_HOME!) => {
    const output = join(compiledDir, `${mode}-${home === process.env.PAPERCUSP_HOME ? 'same' : 'changed'}.json`);
    await run(process.execPath, [bundle], { cwd: root, timeout: 120_000, maxBuffer: 16_000_000,
      env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_HOME: home,
        MEASUREMENT_REPLAY_SOURCE_ROOT: root, MEASUREMENT_REPLAY_RUNTIME_MODE: mode,
        MEASUREMENT_REPLAY_INPUT: inputFile, MEASUREMENT_REPLAY_OUTPUT: output } });
    return JSON.parse(readFileSync(output, 'utf8'));
  };
  const sourceToCompiled = await child('read');
  const compiledWrite = await child('write');
  const compiledToSource = await replay(compiledWrite.inputs);
  const changedArgv = await child('read', join(process.env.PAPERCUSP_HOME!, 'changed-config'));
  assert.equal(sourceToCompiled.identity, retainedReplaySourceIdentity());
  assert.equal(compiledWrite.identity, retainedReplaySourceIdentity());
  for (const [result, values] of [[sourceToCompiled, [120, 20, 20]],
    [compiledToSource, [0, 500, 500]]] as const) {
    for (const [i, key] of ['command', 'sql', 'scoped'].entries()) {
      assert.equal(result[key].status, 'reproduced', `${key}: ${result[key].reason}`);
      assert.equal(result[key].value, values[i]);
    }
  }
  assert.equal(changedArgv.identity, retainedReplaySourceIdentity());
  assert.equal(changedArgv.command.status, 'unavailable', 'changed configured command argv must refuse replay');
  assert.equal(changedArgv.sql.status, 'reproduced', 'the argv control must not invalidate unchanged SQL');
  console.log('MEASUREMENT_REPLAY_RECEIPT ' + JSON.stringify({ sourceHashes, workspaceId,
    pgPort: server!.port, recorded: outcome.testRunIds.length,
    command: { value: command.value, replay: commandReplay.value },
    sql: { value: originalSql.value, replay: sqlReplay.value },
    scoped: { value: scoped.value, replay: scopedReplay!.value, sqlReplay: scopedSqlReplay.status },
    liveAfterMutation: { command: liveCommand.value, sql: liveSql.rows[0]!.budget_pct },
    crossRuntime: { sourceToCompiled, compiledToSource, changedArgv,
      bundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex') } }));
  }
} finally {
  await flushPendingTelemetry();
  await sql.end({ timeout: 2 });
}
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
