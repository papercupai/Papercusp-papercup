/** Actual production skip branches on the maintained disposable background route. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import postgres from 'postgres';
import { makeDreamCycleAction } from '../lib/dream/dream-cycle-action';
import { DREAM_ACTION_DECISION_PREFIX } from '../lib/dream/dream-config';
import { runGymCycleInline } from '../lib/harness/routines/gym-actions';
import { GYM_ADMISSION_DECISION_PREFIX } from '../lib/gym/autoloop-tick';
import { assessDreamAdmission, assessDreamControlObservationCurrentness, readDreamControlObservations } from '../lib/dream/dream-control-observations';
import { getServingHostIdentity } from '../lib/serving-host-identity';

const ws = process.env.PAPERCUSP_WORKSPACE_ID!;
assert.ok(ws.startsWith('test-runtime-'));
assert.ok(process.env.HOME!.includes('papercusp-test-runtime-'));
assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
assert.equal(process.env.PAPERCUSP_CLUSTER, '0');
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'])
  assert.equal(process.env[key], undefined, key + ' must remain stripped');
const pot = 'dream-admission-private';
process.env.PAPERCUSP_POT_HOME_SLUG = pot;
process.env.PAPERCUSP_FLAG_PAPERCUSP_DREAM_CYCLE = '1';
process.env.PAPERCUSP_FLAG_PAPERCUSP_LEARNING_GOVERNOR = '1';
const sql = postgres(process.env.HARNESS_ADMIN_DATABASE_URL!, { max: 4, prepare: false, onnotice: () => {} });
const lines: string[] = [];
const originalLog = console.log;
console.log = (...args) => { const line = args.map(String).join(' '); lines.push(line); originalLog(...args); };
try {
  const [server] = await sql`SELECT inet_server_port() AS port, current_database() AS database`;
  assert.equal(String(server.port), process.env.PAPERCUSP_PG_PORT);
  assert.notEqual(String(server.port), '5432');
  const requiredSettings = await sql`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'harness_shared' AND table_name = 'pot_settings'
      AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER'`;
  const settingsInputs = ['workspace_id', 'harness_slug', 'setting_key', 'value', 'created_at', 'updated_at'];
  assert.deepEqual(requiredSettings.map(row => row.column_name).filter(name => !settingsInputs.includes(name)), [],
    'fixture must supply every required current-schema setting input before executing production');
  await sql`INSERT INTO harness_shared.pot_settings (workspace_id, harness_slug, setting_key, value, created_at, updated_at)
    VALUES (${ws}, ${pot}, 'owner-steering:idle-activities', ${JSON.stringify({ dream: false, gym: false })}, ${Date.now()}, ${Date.now()})`;
  const [jsonBinding] = await sql`SELECT jsonb_typeof(${JSON.stringify({ mode: 'manual' })}::jsonb) AS legacy_type,
    jsonb_typeof(${sql.json({ mode: 'manual' })}::jsonb) AS typed_type`;
  assert.equal(jsonBinding.typed_type, 'object', 'typed JSON fixture binding must store an object');
  console.log('DREAM_ADMISSION_BACKGROUND_JSON_BINDING ' + JSON.stringify(jsonBinding));
  for (const mode of ['manual', 'auto']) await sql`INSERT INTO harness_shared.routines
    (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template,
      concurrency, catchup, active, next_fire_at)
    VALUES (${`admission-${mode}`}, ${ws}, ${pot}, ${`dream-cycle-${mode}`}, 'cron', '{"cron":"0 */17 * * * *"}'::jsonb,
      'system:dream-cycle', ${sql.json({ mode })}::jsonb, 'skip', 'skip-old', false, now())`;
  const routinePreflight = await sql`SELECT name, active, payload_template FROM harness_shared.routines
    WHERE workspace_id = ${ws} AND install_slug = ${pot} ORDER BY name`;
  assert.deepEqual(routinePreflight.map(row => ({ name: row.name, active: row.active, payload: row.payload_template })),
    ['auto', 'manual'].map(mode => ({ name: `dream-cycle-${mode}`, active: false, payload: { mode } })),
    'stored fixture controls must match the production reader contract before actions');
  await sql`INSERT INTO harness_shared.gym_autoloop_config
    (workspace_id, harness_slug, enabled, budget_usd, spent_usd, status, updated_at)
    VALUES (${ws}, ${pot}, true, NULL, 0, 'idle', ${Date.now()})`;
  for (const prefix of ['dream', 'gym', 'blender']) await sql`INSERT INTO harness_shared.learning_governor_loops
    (workspace_id, loop_id, pot_slug, display_name, budget_kind, budget_usd, spent_usd, enabled, enforcement)
    VALUES (${ws}, ${`${prefix}:${pot}`}, ${pot}, 'private admission verification', 'per-cycle', 1, 0, true, 'native')`;
  const since = new Date(Date.now() - 1000).toISOString();
  // Both calls use the production dependencies. Explicit owner policy refuses
  // BEFORE any model/run path; no paid-call stub is injected.
  await makeDreamCycleAction()({ workspaceId: ws, installSlug: pot, triggerConfig: {}, payloadTemplate: { mode: 'auto' } });
  await runGymCycleInline(ws);
  const dreamLine = lines.find(line => line.includes(DREAM_ACTION_DECISION_PREFIX));
  const gymLine = lines.find(line => line.startsWith(GYM_ADMISSION_DECISION_PREFIX));
  assert.ok(dreamLine && gymLine, 'both actual action records must exist');
  const dream = JSON.parse(dreamLine.slice(dreamLine.indexOf(DREAM_ACTION_DECISION_PREFIX) + DREAM_ACTION_DECISION_PREFIX.length));
  const gym = JSON.parse(gymLine.slice(GYM_ADMISSION_DECISION_PREFIX.length));
  assert.equal(dream.reason, 'owner-idle-disabled');
  assert.equal(dream.paidCalls, 0);
  assert.equal(assessDreamAdmission(dream).status, 'observed');
  assert.equal(gym.gate, 'owner-idle');
  assert.equal(gym.status, 'refused');
  assert.equal(gym.inputs.allowed, false);
  const runtime = getServingHostIdentity();
  assert.ok(runtime.buildSha && runtime.processId);
  assert.deepEqual(dream.runtime, runtime);
  assert.deepEqual(gym.runtime, runtime);
  const scope = { workspaceId: ws, potSlug: pot, since, until: new Date().toISOString(),
    expectedRuntime: { host: runtime.host, buildSha: runtime.buildSha, processId: runtime.processId } };
  const raw = await sql.begin('READ ONLY', tx => readDreamControlObservations(tx as unknown as import('postgres').Sql, scope));
  const consumedAt = new Date().toISOString();
  // Retain the full original read BEFORE asserting: UNKNOWN must identify the
  // failed component even after the disposable DB and HOME are cleaned.
  console.log('DREAM_ADMISSION_BACKGROUND_OBSERVATION ' + JSON.stringify({ raw, consumedAt }));
  assert.equal(raw.status, 'observed', JSON.stringify({ reason: raw.reason,
    components: Object.fromEntries(Object.entries(raw.observations ?? {}).map(([key, value]) => [key, { status: value.status,
      ...('reason' in value ? { reason: value.reason } : {}) }])) }));
  assert.deepEqual(assessDreamControlObservationCurrentness(raw, scope, Date.parse(consumedAt)), { current: true, reason: null });
  // Captured stdout is real action evidence, but is not a system journal read.
  // Keep that boundary explicit rather than fabricating JournalReadResult.
  assert.equal(raw.productionAdmission?.status, 'unknown');
  const [runs] = await sql`SELECT COUNT(*)::int AS count FROM harness_shared.dream_runs WHERE workspace_id = ${ws}`;
  assert.equal(runs.count, 0);
  const [control] = await sql`SELECT spent_usd, status FROM harness_shared.gym_autoloop_config WHERE workspace_id = ${ws} AND harness_slug = ${pot}`;
  assert.equal(Number(control.spent_usd), 0);
  assert.equal(control.status, 'idle');
  const root = resolve(import.meta.dirname, '../../..');
  const sourcePaths = JSON.parse(process.env.DREAM_ADMISSION_SOURCE_PATHS!) as string[];
  const sourceFiles = Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
  console.log('DREAM_ADMISSION_BACKGROUND_RECEIPT ' + JSON.stringify({ schemaVersion: 1, workspace: ws,
    runtimeRoot: dirname(process.env.HOME!), runtime, consumedAt, sourceFiles, privateDatabase: server.database,
    dream, gym, raw, noPaidAttempts: true, scope: 'isolated-production-policy-skip-and-read-only-observations',
    journalBoundary: 'stdout-capture-only; shared-runtime journal acceptance remains unverified' }));
} finally {
  console.log = originalLog;
  await sql.end({ timeout: 1 });
}
