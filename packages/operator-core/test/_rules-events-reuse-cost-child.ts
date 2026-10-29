/** P001 measurement child. Run only through with-test-pg --isolated-runtime. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const routine = process.argv[2];
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
const database = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
assert.ok(workspace.startsWith('test-runtime-'), 'a private runtime workspace is mandatory');
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname));
assert.equal(database.port, process.env.PAPERCUSP_PG_PORT);
assert.notEqual(database.port, '5432');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0', 'ambient scheduled work must be disabled');

const { getOrgPg } = await import('@papercusp/db-org');
const { sql } = getOrgPg();
const ctx = { workspaceId: workspace, installSlug: workspace, triggerConfig: {}, payloadTemplate: null };
let action: () => Promise<unknown>;
let prepare: (index: number) => Promise<void>;
let changed: () => Promise<boolean>;
let observe: () => Promise<string>;
let sources: string[];

// The controls use real, bounded maintenance work: stale outbox settlement,
// terminal-fleet disarm, and terminal archive cleanup. They never launch agents,
// call a provider, or stand in for a successful user-job latency measurement.
if (routine === 'external-trigger-dispatch') {
  const { runExternalTriggerDispatch } = await import('../lib/harness/routines/external-trigger-dispatch-action');
  const [source] = await sql`INSERT INTO harness_shared.data_sources (workspace_id, kind, status)
    VALUES (${workspace}, 'gmail', 'connected') RETURNING id`;
  const [binding] = await sql`INSERT INTO harness_shared.trigger_bindings
    (workspace_id, source_id, event_pattern, event_filter, action, armed, storm_policy)
    VALUES (${workspace}, ${source.id}, 'ext:gmail:message.*', '{}'::jsonb,
      '{"type":"create-work-item"}'::jsonb, true, '{"maxAgeSeconds":1}'::jsonb) RETURNING id`;
  let runId = '';
  prepare = async (index) => {
    const [delivery] = await sql`INSERT INTO harness_shared.trigger_deliveries
      (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload, sink_kind, sink_ref, outcome)
      VALUES (${workspace}, ${source.id}, ${`baseline-${index}`}, 'email-message',
        'ext:gmail:message.received', '{}'::jsonb, 'event-bus', 'workspace', 'delivered') RETURNING id`;
    const [run] = await sql`INSERT INTO harness_shared.trigger_runs
      (workspace_id, binding_id, delivery_id, dedupe_key, status, args, triggered_at)
      VALUES (${workspace}, ${binding.id}, ${delivery.id}, ${`baseline-${index}`}, 'pending',
        '{}'::jsonb, now() - interval '1 hour') RETURNING id`;
    runId = run.id;
  };
  action = () => runExternalTriggerDispatch(ctx);
  changed = async () => {
    const [row] = await sql`SELECT status FROM harness_shared.trigger_runs WHERE id = ${runId}`;
    return row?.status === 'skipped';
  };
  observe = async () => JSON.stringify(await sql`SELECT id, status, attempts, error
    FROM harness_shared.trigger_runs WHERE workspace_id = ${workspace} ORDER BY id`);
  sources = ['packages/operator-core/lib/harness/routines/external-trigger-dispatch-action.ts',
    'packages/operator-core/lib/external-triggers/binding-engine.ts'];
} else if (routine === 'fleet-headcount-governor') {
  const { FLAGS, flagEnvVarName } = await import('@papercusp/flags');
  const { getFlagAttestation } = await import('@papercusp/flags/server');
  process.env[flagEnvVarName(FLAGS.FLEET_HEADCOUNT_GOVERNOR)] = '1';
  const flag = await getFlagAttestation(FLAGS.FLEET_HEADCOUNT_GOVERNOR, 'system');
  assert.equal(flag.source, 'env-override', 'the private control must explicitly enable the real governor flag');
  assert.equal(flag.resolvedValue, true, 'a disabled action cannot provide measurement evidence');
  const { runFleetHeadcountGovernor } = await import('../lib/harness/routines/fleet-headcount-action');
  const { createFleetIfAbsent, setFleetHeadcountTarget } = await import('../lib/agent-fleets-store');
  const plan = 'measurement-terminal-plan';
  const fleet = 'measurement-terminal-fleet';
  await sql`INSERT INTO harness_shared.harness_plans
    (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
    VALUES (${workspace}, 'papercusp', ${plan}, 'Measurement terminal plan', 'shipped',
      '# Terminal fixture', 'measurement-v1', '[]'::jsonb)`;
  const [terminalPlan] = await sql`SELECT status FROM harness_shared.harness_plans
    WHERE workspace_id = ${workspace} AND harness_slug = 'papercusp' AND plan_slug = ${plan}`;
  assert.equal(terminalPlan?.status, 'shipped', 'the control requires a canonical terminal plan');
  await createFleetIfAbsent({ workspaceId: workspace, fleetSlug: fleet, owner: 'measurement',
    leaderOwnerId: 'measurement', colorScheme: 'amber' });
  prepare = async () => setFleetHeadcountTarget({ workspaceId: workspace, fleetSlug: fleet, target: 1,
    config: { plan, harness: 'papercusp', agent: 'codex', model: 'gpt-6.1-sol', effort: 'high',
      account: 'default', headless: true, carry: 'warm', supervise: true } });
  action = () => runFleetHeadcountGovernor(ctx);
  changed = async () => {
    const [row] = await sql`SELECT headcount_target FROM harness_shared.agent_fleets
      WHERE workspace_id = ${workspace} AND fleet_slug = ${fleet}`;
    return row?.headcount_target === null;
  };
  observe = async () => JSON.stringify(await sql`SELECT fleet_slug, headcount_target, headcount_config
    FROM harness_shared.agent_fleets WHERE workspace_id = ${workspace} ORDER BY fleet_slug`);
  sources = ['packages/operator-core/lib/harness/routines/fleet-headcount-action.ts',
    'packages/operator-core/lib/agent-fleets-store.ts'];
} else if (routine === 'personal-vault-import') {
  const { runPersonalVaultImportAction } = await import('../lib/harness/routines/personal-vault-import-action');
  const { personalVaultImportStorageDir } = await import('../lib/personal-vault/import-jobs');
  const [user] = await sql`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`measurement-${randomUUID()}`}, 'Measurement fixture') RETURNING id`;
  const root = personalVaultImportStorageDir(workspace);
  await mkdir(root, { recursive: true });
  let jobId = '';
  prepare = async (index) => {
    const path = join(root, `${randomUUID()}.archive`);
    await writeFile(path, 'terminal private fixture');
    const [job] = await sql`INSERT INTO harness_shared.personal_vault_import_jobs
      (workspace_id, user_id, filename, storage_path, content_sha256, idempotency_key, size_bytes, status)
      VALUES (${workspace}, ${user.id}, 'terminal.zip', ${path}, ${'a'.repeat(64)},
        ${createHash('sha256').update(String(index)).digest('hex')}, 24, 'completed') RETURNING id`;
    jobId = job.id;
  };
  action = () => runPersonalVaultImportAction(ctx);
  changed = async () => {
    const [row] = await sql`SELECT storage_path FROM harness_shared.personal_vault_import_jobs
      WHERE workspace_id = ${workspace} AND id = ${jobId}`;
    return row?.storage_path === null;
  };
  observe = async () => JSON.stringify(await sql`SELECT id, status, storage_path, attempt_count,
    documents_imported, last_error FROM harness_shared.personal_vault_import_jobs
    WHERE workspace_id = ${workspace} ORDER BY id`);
  sources = ['packages/operator-core/lib/harness/routines/personal-vault-import-action.ts',
    'packages/operator-core/lib/personal-vault/import-jobs.ts'];
} else {
  throw new Error(`unsupported measurement routine: ${routine}`);
}

type Sample = { fireId: string; kind: 'idle' | 'known-work'; cpuMicros: number; elapsedMs: number;
  statements: number; transactionCommands: number; stateChanged: boolean; queryHashes: Record<string, number> };
const samples: Sample[] = [];
let active: Sample | null = null;
const previousDebug = sql.options.debug;
sql.options.debug = (_connection: number, query: string) => {
  if (!active) return;
  if (/^\s*(?:begin|commit|rollback)(?:\s|$)/i.test(query)) active.transactionCommands++;
  else active.statements++;
  const hash = createHash('sha256').update(query).digest('hex');
  active.queryHashes[hash] = (active.queryHashes[hash] ?? 0) + 1;
};

function estimate(values: number[]) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const halfWidth = 2.045 * Math.sqrt(variance / values.length); // two-sided t(29), 95%
  return { n: values.length, mean, confidence95: [Math.max(0, mean - halfWidth), mean + halfWidth] };
}

try {
  await action(); // warm imports, lazy pools and prepared metadata outside the window
  await prepare(-1);
  await action();
  assert.equal(await changed(), true, 'the known-work control must change real private state');
  const windowStartedAt = new Date().toISOString();
  const windowStart = performance.now();
  for (const kind of ['idle', 'known-work'] as const) {
    for (let index = 0; index < 30; index++) {
      if (kind === 'known-work') await prepare(index);
      // Verification and fixture construction do not enter the action CPU/query window.
      const before = kind === 'known-work' ? await changed() : null;
      if (kind === 'known-work') assert.equal(before, false, 'control work must still be pending');
      const stateBefore = await observe();
      const sample: Sample = { fireId: `${routine}:${kind}:${index}`, kind, cpuMicros: 0,
        elapsedMs: 0, statements: 0, transactionCommands: 0, stateChanged: false, queryHashes: {} };
      const cpu = process.cpuUsage();
      const started = performance.now();
      active = sample;
      await action();
      active = null;
      const used = process.cpuUsage(cpu);
      sample.cpuMicros = used.user + used.system;
      sample.elapsedMs = performance.now() - started;
      sample.stateChanged = stateBefore !== await observe();
      if (kind === 'known-work') assert.equal(await changed(), true, 'the intended state transition must complete');
      assert.ok(sample.statements > 0, 'a disconnected or boot-only profile is not action evidence');
      assert.equal(sample.stateChanged, kind === 'known-work');
      samples.push(sample);
    }
  }
  const baseline = JSON.parse(readFileSync('docs/evidence/rules-events-reuse-2026-10-28-routines-before.json', 'utf8'));
  const rate = baseline.rows.find((row: { routine_name: string }) => row.routine_name === routine);
  assert.ok(rate && rate.actual_started_fires > 0);
  const idle = samples.filter(sample => sample.kind === 'idle');
  const instrument = 'packages/operator-core/test/_rules-events-reuse-cost-child.ts';
  const proof = { schemaVersion: 1, routine, workspace, processId: process.pid,
    runtimeRoot: dirname(process.env.HOME!), pgPort: Number(database.port),
    buildSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries([...sources, instrument].map(path =>
      [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
    windowStartedAt, windowEndedAt: new Date().toISOString(), elapsedWindowMs: performance.now() - windowStart,
    attribution: 'One isolated action process and real private PostgreSQL; setup and validation excluded from each fire.',
    queryDefinition: 'SQL statements on the production admin client; transaction commands counted separately; hashes exclude parameter values.',
    idleCpuMicrosPerFire: estimate(idle.map(sample => sample.cpuMicros)),
    idleStatementsPerFire: estimate(idle.map(sample => sample.statements)),
    observedProductionRate: { windowStart: baseline.windowStart, windowEnd: baseline.windowEnd,
      querySha256: baseline.querySha256, actualStartedFires: rate.actual_started_fires },
    samples, productionNoOpShare: { status: 'unknown', reason: 'Retained live action outputs have no counters.' },
    latencyComparison: { status: 'not-measured', reason: 'Maintenance controls do not measure user-job dispatch latency.' },
    r4Decision: 'non-passing: actual production no-op share and paired latency comparison remain required',
    limitations: ['CPU is action-process CPU; PostgreSQL server CPU is unavailable.',
      'Isolated idle samples do not establish the preceding production window no-op share.',
      'Known-work controls cover maintenance state transitions, not successful user-job dispatch.'] };
  console.log('RULES_EVENTS_COST_PROOF=' + JSON.stringify(proof));
} finally {
  sql.options.debug = previousDebug;
  await sql.end({ timeout: 2 });
}
process.exit(0);
