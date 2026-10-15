/** Private background IO journey for P-028; no shared checkout writes or gate fire. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { buildSyncLintGuardDeps, SYNC_LINT_GUARDS_ROUTINE_NAME } from '../lib/release/sync-batch-lint-guards-deps';
import { runBoundedArgv } from '../lib/release/sync-batch-delta-check-deps';
import { runSyncLintGuardTick } from '../lib/release/sync-batch-lint-guards';
import { inboxWakeKey } from '../lib/agent-tools/coordination/inbox-wake';
import { recordAdvSession } from '../lib/adv-sessions';
import { listRecentDeliveries, upsertInboxWakeAwait } from '../lib/events/await/store';
import { setAutoPumpEnabledForTests } from '../lib/events/await/engine';

export interface SyncLintPrivateReceipt {
  build: { sourceHashes: Record<string, string> };
  runtime: { workspaceId: string; runtimeRoot: string; pgPort: string };
  filing: { id: string; assignee: string; conditionKey: string };
  elapsedMs: number;
  guard: string;
  wake: { eventKey: string; deliveryId: number; queued: true; pickupConfirmed: false };
}

async function main() {
  const root = resolve(import.meta.dirname, '../../..');
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID!;
  const dsn = process.env.HARNESS_ADMIN_DATABASE_URL!;
  const pgPort = process.env.PAPERCUSP_PG_PORT!;
  const runtimeRoot = dirname(process.env.HOME!);
  assert.match(workspaceId, /^test-runtime-/);
  assert.equal(new URL(dsn).port, pgPort);
  assert.notEqual(pgPort, '5432');
  assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN']) {
    assert.equal(process.env[key], undefined, key);
  }
  const expected = JSON.parse(process.env.SYNC_LINT_EXPECTED_SOURCE_HASHES!) as Record<string, string>;
  const sourceHashes: Record<string, string> = {};
  for (const [path, hash] of Object.entries(expected)) {
    const actual = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
    assert.equal(actual, hash, 'changed source: ' + path);
    sourceHashes[path] = actual;
  }

  const sql = postgres(dsn, { max: 2, prepare: false });
  const harness = 'sync-lint-private';
  const author = 'su-11111111-2222-4333-8444-555555555555';
  const fixtureRoot = join(runtimeRoot, 'guard-fixture');
  const offender = 'src/timer.ts';
  let head = 'a'.repeat(40);
  // Exercise the real event matcher and durable delivery queue. Its detached
  // execution pump is disabled: this disposable target must never launch a model.
  const previousPump = setAutoPumpEnabledForTests(false);
  try {
    const [server] = await sql`SELECT inet_server_port() AS port`;
    assert.equal(String(server!.port), pgPort);
    await mkdir(join(fixtureRoot, 'src'), { recursive: true });
    await writeFile(join(fixtureRoot, offender), 'export const value = 1;\n');
    // Use the actual guard's detector in a real npm subprocess. Git history and
    // capacity are controlled prerequisites; state, editor lookup and filing are real IO.
    await writeFile(join(fixtureRoot, 'guard.mjs'),
      `import { readFileSync } from 'node:fs';\n` +
      `import { usesRawSetInterval } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/check-no-raw-setinterval.mjs')).href)};\n` +
      `const bad = usesRawSetInterval(readFileSync('src/timer.ts', 'utf8'), 'src/timer.ts');\n` +
      `console.log(bad ? 'NEW raw timer: src/timer.ts' : 'clean'); process.exitCode = bad ? 1 : 0;\n`);
    await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({ scripts: {
      'lint:no-raw-setinterval': 'node guard.mjs',
    } }));
    await sql`INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
      VALUES (${workspaceId}, ${harness}, ${Buffer.from('private-p028')}, 'private-p028', 0)`;
    await sql`INSERT INTO harness_shared.harness_registry (workspace_id, payload)
      VALUES (${workspaceId}, ${JSON.stringify({ projects: [{ slug: harness, path: fixtureRoot, harness_kind: 'hive' }] })}::text::jsonb)
      ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload`;
    await sql`INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role, concurrency, catchup, active, metadata)
      VALUES ('rt_p028_private', ${harness}, ${workspaceId}, ${SYNC_LINT_GUARDS_ROUTINE_NAME},
      'cron', '{"cron":"0 4/5 * * * *"}'::jsonb, 'system:sync-batch-lint-guards', 'skip', 'skip-old', false, '{"sibling":"preserved"}'::jsonb)`;
    const deps = buildSyncLintGuardDeps({ installSlug: harness, workspaceId, root: fixtureRoot, branch: 'staging',
      exec: async (cmd, args, opts) => {
        if (cmd === 'git') return { status: 0, stdout: args.includes('rev-parse') ? head : '', stderr: '' };
        return runBoundedArgv(cmd, args, opts);
      },
    });
    deps.hostLoad = () => ({ load1: 1, cores: 4 });
    deps.greenCheckpointRunning = async () => false;
    const options = { scripts: ['lint:no-raw-setinterval'] as const };
    const baseline = await runSyncLintGuardTick(deps, options);
    assert.equal(baseline.status, 'bootstrapped');
    assert.equal(baseline.verdicts['lint:no-raw-setinterval'], 'pass');
    assert.equal(baseline.filed.length, 0);
    await recordAdvSession({ workspaceId, mode: 'console', agent: 'codex', coordOwnerId: author });
    await upsertInboxWakeAwait({ subscriberId: author, eventKey: inboxWakeKey(author), minSleepSec: 0,
      note: 'P028 private targeted wake proof' });
    const startedAt = Date.now();
    await writeFile(join(fixtureRoot, offender), 'setInterval(() => {}, 1000);\n');
    await sql`INSERT INTO harness_shared.edit_attribution_ledger
      (workspace_id, repo_root, file, agent_id, intent)
      VALUES (${workspaceId}, ${fixtureRoot}, ${offender}, ${author}, 'P028 seeded private violation')`;
    head = 'b'.repeat(40);
    const result = await runSyncLintGuardTick(deps, options);
    assert.equal(result.verdicts['lint:no-raw-setinterval'], 'fail');
    assert.equal(result.filed.length, 1, JSON.stringify(result));
    assert.equal(result.filed[0]!.error, undefined, JSON.stringify(result));
    assert.equal(result.filed[0]!.notificationError, undefined, JSON.stringify(result));
    assert.equal(result.filed[0]!.assignee, author);
    assert.equal(result.filed[0]!.authorSource, 'edit-ledger:failing-file');
    const id = result.filed[0]!.id;
    assert.ok(id);
    const [item] = await sql`SELECT issue_id, assignee FROM harness_shared.engineer_issues WHERE issue_id = ${id}`;
    assert.equal(item!.assignee, author);
    const [condition] = await sql`SELECT condition_key FROM harness_shared.work_items
      WHERE feature_id = ${id} AND workspace_id = ${workspaceId}`;
    assert.equal(condition!.condition_key, 'sync-delta-guard:lint:no-raw-setinterval:src/timer.ts');
    const deliveries = await listRecentDeliveries(author);
    assert.equal(deliveries.length, 1);
    const delivery = deliveries[0]!;
    assert.equal(delivery.eventKey, inboxWakeKey(author));
    assert.ok(delivery.payload && typeof delivery.payload === 'object');
    assert.equal(Reflect.get(delivery.payload, 'workItemId'), id);
    const [routine] = await sql`SELECT metadata FROM harness_shared.routines WHERE id = 'rt_p028_private'`;
    assert.equal(routine!.metadata.sibling, 'preserved');
    assert.equal(routine!.metadata.sync_lint_guards.guards['lint:no-raw-setinterval'].status, 'fail');
    assert.equal((await runSyncLintGuardTick(deps, options)).status, 'up-to-date');
    assert.equal((await listRecentDeliveries(author)).length, 1, 'unchanged head must not wake twice');
    assert.ok(Date.now() - startedAt < 15 * 60_000);
    const receipt: SyncLintPrivateReceipt = { build: { sourceHashes },
      runtime: { workspaceId, runtimeRoot, pgPort }, filing: { id, assignee: author, conditionKey: condition!.condition_key },
      elapsedMs: Date.now() - startedAt, guard: 'real detector and npm child',
      wake: { eventKey: delivery.eventKey, deliveryId: delivery.id, queued: true, pickupConfirmed: false } };
    console.log('SYNC_LINT_PRIVATE_RECEIPT ' + JSON.stringify(receipt));
  } finally {
    setAutoPumpEnabledForTests(previousPump);
    await sql.end({ timeout: 5 });
    await getOrgPg().sql.end({ timeout: 5 });
  }
}

// Filing can load the native embedder. Forced exit interrupts its teardown and
// aborts after a successful receipt; let its pending work and cleanup finish.
main().catch(error => {
  console.error('SYNC_LINT_PRIVATE_FAILURE ' + error.stack);
  process.exitCode = 1;
});
