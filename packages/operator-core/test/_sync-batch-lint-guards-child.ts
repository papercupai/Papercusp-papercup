/** Private background IO journey for P-028; no shared checkout writes or gate fire. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { configureScheduledRegistry, getManaged } from '@papercusp/scheduled-registry';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { buildSyncLintGuardDeps, SYNC_LINT_GUARDS_ROUTINE_NAME } from '../lib/release/sync-batch-lint-guards-deps';
import { buildSyncBatchDeltaDeps, runBoundedArgv, SYNC_DELTA_ROUTINE_NAME } from '../lib/release/sync-batch-delta-check-deps';
import { evaluateRadius, runSyncBatchDeltaCheck } from '../lib/release/sync-batch-delta-check';
import { runSyncLintGuardTick } from '../lib/release/sync-batch-lint-guards';
import { inboxWakeKey } from '../lib/agent-tools/coordination/inbox-wake';
import { getMessageById } from '../lib/agent-tools/coordination/messages';
import { recordAdvSession } from '../lib/adv-sessions';
import { listRecentDeliveries, upsertInboxWakeAwait } from '../lib/events/await/store';
import { setAutoPumpEnabledForTests } from '../lib/events/await/engine';
import { drainDetached, pendingDetachedCount } from '../lib/detached-imports';
import { fallbackObservationCounters, flushFallbackObservations } from '../lib/degradation/fallback-observations';
import { INTEREST_SWEEP_TICK_MS, registerInterestWatch, startInterestWatchSweeper, stopInterestWatchSweeper } from '../lib/events/await/interest-watch';
import { resolveProseProfileSelection } from '../lib/search/prose-vector-dims';
import { prepareSyncLintPrivateCompiler, SYNC_LINT_TYPE_ERROR_FILE } from './sync-lint-private-compiler';

export const SYNC_LINT_EXPECTED_BODY_FAILURE = 'EI260629 deliberate body assertion while interest sweep is blocked';

const progressFile = process.env.SYNC_LINT_EVIDENCE_DIR
  ? join(process.env.SYNC_LINT_EVIDENCE_DIR, 'worker-progress.ndjson') : null;
function progress(stage: string, evidence: Record<string, unknown> = {}) {
  if (!progressFile) return;
  mkdirSync(dirname(progressFile), { recursive: true });
  appendFileSync(progressFile, JSON.stringify({ stage, observedAt: new Date().toISOString(), ...evidence }) + '\n');
}

async function step<T>(stage: string, action: () => Promise<T>): Promise<T> {
  const started = Date.now();
  progress(stage + '-start');
  try {
    const value = await action();
    progress(stage + '-complete', { elapsedMs: Date.now() - started });
    return value;
  } catch (error) {
    progress(stage + '-failed', { elapsedMs: Date.now() - started, error: String(error) });
    throw error;
  }
}

export interface SyncLintPrivateReceipt {
  build: { sourceHashes: Record<string, string> };
  runtime: { workspaceId: string; runtimeRoot: string; pgPort: string };
  filing: { id: string; assignee: string; conditionKey: string };
  elapsedMs: number;
  guard: string;
  wake: { eventKey: string; deliveryId: number; queued: true; pickupConfirmed: false };
  typecheck: {
    id: string; assignee: string; conditionKey: string; messageId: string; deliveryId: number;
    firstNotificationError: string; tscRuns: number; affectedRuns: number;
    cursorLeg: string; confirmations: number; gitHead: string;
  };
  lifecycle: {
    detachedRemaining: number;
    fallbackFailed: number;
    interestWatchStopRequested: true;
    interestWatchTimerStopped: boolean;
    stopWaitedForSweep: boolean;
    sweepPersisted: boolean;
    order: string[];
  };
}

async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await nextTurn();
  }
}

async function main() {
  progress('worker-start', { phase: 'execute' });
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

  const deltaFile = SYNC_LINT_TYPE_ERROR_FILE;
  // The affected pass is controlled, but its probe must select an actual task:
  // a workspace name alone intentionally means nothing-selected in production.
  const deltaProbe = { workspaces: ['private-typecheck'], guards: [],
    taskCommands: [{ workspace: 'private-typecheck', command: 'node --test' }], derivation: null };
  assert.equal(evaluateRadius({ probe: deltaProbe,
    union: { paths: [deltaFile], totalPaths: 1, truncated: false }, batchCount: 1 }).run, true,
  'P037 fixture must select a task before allocating fixture state');

  const sql = postgres(dsn, { max: 2, prepare: false });
  const harness = 'sync-lint-private';
  const author = 'su-11111111-2222-4333-8444-555555555555';
  const fixtureRoot = join(runtimeRoot, 'guard-fixture');
  const offender = 'src/timer.ts';
  let head = 'a'.repeat(40);
  // Exercise the real event matcher and durable delivery queue. Its detached
  // execution pump is disabled: this disposable target must never launch a model.
  const previousPump = setAutoPumpEnabledForTests(false);
  let receipt: Omit<SyncLintPrivateReceipt, 'lifecycle'> | undefined;
  let lifecycle: SyncLintPrivateReceipt['lifecycle'] | undefined;
  const order: string[] = [];
  let releaseSweep: (() => void) | undefined;
  let lockedSweep: Promise<unknown> | undefined;
  let sweepEntry: ReturnType<typeof getManaged>;
  let watchId: string | undefined;
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
    await until(async () => (await listRecentDeliveries(author)).length > 0, 'guard wake persisted');
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

    // P037 reuses this runtime, real PG bindings and lifecycle owner. Git/radius
    // are controlled; the compiler, attribution, cursor, filing and wake are real.
    const deltaRoot = join(runtimeRoot, 'typecheck-fixture');
    const deltaAuthor = 'su-22222222-3333-4444-8555-666666666666';
    let deltaHead = 'c'.repeat(40);
    let tscRuns = 0;
    let affectedRuns = 0;
    await prepareSyncLintPrivateCompiler(root, deltaRoot);
    await sql`INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role, concurrency, catchup, active, metadata)
      VALUES ('rt_p037_private', ${harness}, ${workspaceId}, ${SYNC_DELTA_ROUTINE_NAME},
      'cron', '{"cron":"0 4/5 * * * *"}'::jsonb, 'system:sync-batch-delta-check', 'skip', 'skip-old', false, '{"sibling":"preserved"}'::jsonb)`;
    await recordAdvSession({ workspaceId, mode: 'console', agent: 'codex', coordOwnerId: deltaAuthor });
    await sql`INSERT INTO harness_shared.edit_attribution_ledger
      (workspace_id, repo_root, file, agent_id, intent)
      VALUES (${workspaceId}, ${deltaRoot}, ${deltaFile}, ${deltaAuthor}, 'P037 seeded private type error')`;
    const makeDeltaDeps = () => {
      const delta = buildSyncBatchDeltaDeps({ installSlug: harness, workspaceId, root: deltaRoot, branch: 'staging',
        exec: async (cmd, args, opts) => {
          assert.ok(args.includes(join(deltaRoot, 'scripts/lint-tsc.mjs')), 'only the real tsc leg may execute');
          tscRuns += 1;
          return step('compiler-process', async () => {
            const result = await runBoundedArgv(cmd, args, opts);
            progress('compiler-result', { status: result?.status ?? null, durationMs: result?.durationMs ?? null,
              failureKind: result?.failureKind ?? null, output: `${result?.stdout ?? ''}${result?.stderr ?? ''}`.slice(-2000) });
            return result;
          });
        },
      });
      delta.hostLoad = () => ({ load1: 1, cores: 4 });
      delta.greenCheckpointRunning = async () => false;
      delta.headSha = async () => deltaHead;
      delta.listBatches = async () => [{ sha: deltaHead, committedAtMs: Date.now(), agent: null, paths: [deltaFile] }];
      delta.probeRadius = async () => deltaProbe;
      delta.runAffected = async () => { affectedRuns += 1; return { ok: true, failing: [] }; };
      delta.confirmOne = async () => { throw new Error('typecheck retry must never invoke a test confirmation'); };
      // Persist semantic boundaries outside disposable private state. A timeout
      // must distinguish compilation, attribution, cursor IO and filing/wake.
      const { readCursor, writeCursor, lookupEditors, fileRed, runTsc } = delta;
      delta.readCursor = () => step('cursor-read', readCursor);
      delta.writeCursor = cursor => step('cursor-write', () => writeCursor(cursor));
      delta.lookupEditors = (files, since) => step('editor-lookup', () => lookupEditors!(files, since));
      delta.fileRed = finding => step('filing-and-wake', () => fileRed(finding));
      delta.runTsc = files => step('typecheck-leg', () => runTsc(files));
      return delta;
    };
    const initialDelta = makeDeltaDeps();
    progress('delta-bootstrap-start');
    assert.equal((await runSyncBatchDeltaCheck(initialDelta)).status, 'bootstrapped');
    progress('delta-bootstrap-complete');
    deltaHead = 'd'.repeat(40);
    // No wake await exists yet: filing and the stable message must survive this miss.
    progress('delta-red-start');
    const firstDelta = await runSyncBatchDeltaCheck(initialDelta);
    progress('delta-red-complete', { status: firstDelta.status });
    assert.equal(firstDelta.status, 'red', JSON.stringify(firstDelta));
    assert.equal(firstDelta.filed.length, 1, JSON.stringify(firstDelta));
    const firstFiling = firstDelta.filed[0]!;
    assert.ok(firstFiling.id, JSON.stringify(firstDelta));
    assert.match(firstFiling.notificationError ?? '', /wake not queued/);
    assert.equal(firstFiling.conditionKey, `sync-delta-red:${deltaFile}`);
    assert.equal((await listRecentDeliveries(deltaAuthor)).length, 0);
    const deltaMessageId = `sync-delta-red:${workspaceId}:${firstFiling.id}`;
    const originalMessage = await getMessageById(deltaMessageId);
    assert.ok(originalMessage);
    assert.deepEqual(originalMessage.to, [deltaAuthor]);
    // Recreate production deps so tick 2 can only recover state from PG JSONB.
    const reloadedDelta = makeDeltaDeps();
    const persistedDelta = await reloadedDelta.readCursor();
    assert.equal(persistedDelta?.sha, deltaHead);
    assert.deepEqual(persistedDelta?.openReds?.map(red => [red.path, red.leg, red.assignee]),
      [[deltaFile, 'lint-tsc', deltaAuthor]]);
    await upsertInboxWakeAwait({ subscriberId: deltaAuthor, eventKey: inboxWakeKey(deltaAuthor), minSleepSec: 0,
      note: 'P037 private same-HEAD retry proof' });
    progress('delta-retry-start');
    const secondDelta = await runSyncBatchDeltaCheck(reloadedDelta);
    progress('delta-retry-complete', { status: secondDelta.status });
    assert.equal(secondDelta.status, 'up-to-date', JSON.stringify(secondDelta));
    assert.equal(secondDelta.filed.length, 1);
    assert.equal(secondDelta.filed[0]!.id, firstFiling.id);
    assert.equal(secondDelta.filed[0]!.conditionKey, firstFiling.conditionKey);
    assert.equal(secondDelta.filed[0]!.notificationError, undefined);
    assert.equal(secondDelta.filed[0]!.error, undefined);
    const [deltaItem] = await sql`SELECT assignee FROM harness_shared.engineer_issues WHERE issue_id = ${firstFiling.id}`;
    assert.equal(deltaItem!.assignee, deltaAuthor);
    assert.deepEqual(await getMessageById(deltaMessageId), originalMessage, 'retry must reuse the persisted message');
    await until(async () => (await listRecentDeliveries(deltaAuthor)).length > 0, 'typecheck wake persisted');
    const deltaDeliveries = await listRecentDeliveries(deltaAuthor);
    assert.equal(deltaDeliveries.length, 1);
    assert.equal(Reflect.get(deltaDeliveries[0]!.payload as object, 'workItemId'), firstFiling.id);
    const finalDelta = await reloadedDelta.readCursor();
    assert.equal(finalDelta?.openReds?.[0]?.confirmations, 2);
    assert.equal(tscRuns, 2, 'retry must run the typecheck leg');
    assert.equal(affectedRuns, 1, 'same-HEAD retry must preserve the unrelated affected pass');
    const typecheck: SyncLintPrivateReceipt['typecheck'] = {
      id: firstFiling.id, assignee: deltaAuthor, conditionKey: firstFiling.conditionKey,
      messageId: deltaMessageId, deliveryId: deltaDeliveries[0]!.id,
      firstNotificationError: firstFiling.notificationError!, tscRuns, affectedRuns,
      cursorLeg: finalDelta!.openReds![0]!.leg!, confirmations: finalDelta!.openReds![0]!.confirmations,
      gitHead: deltaHead,
    };
    receipt = { build: { sourceHashes },
      runtime: { workspaceId, runtimeRoot, pgPort }, filing: { id, assignee: author, conditionKey: condition!.condition_key },
      elapsedMs: Date.now() - startedAt, guard: 'real detector and npm child',
      wake: { eventKey: delivery.eventKey, deliveryId: delivery.id, queued: true, pickupConfirmed: false }, typecheck };

    // Keep ONE P028/P037 baseline, then fail its body with the actual host
    // sweep in flight. Only time is controlled: the managed callback, sweep,
    // HNSW probe and persistence all use their production private-PG bindings.
    progress('lifecycle-start');
    await stopInterestWatchSweeper();
    watchId = randomUUID();
    await upsertInboxWakeAwait({ subscriberId: author, eventKey: `interest:${watchId}`, minSleepSec: 0 });
    const profile = resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma)!;
    await registerInterestWatch(sql, { id: watchId, workspaceId, ownerId: author,
      eventKey: `interest:${watchId}`, interest: 'private teardown guard',
      embedding: [1, ...new Array<number>(767).fill(0)], embeddingMode: 'gemma', embeddingProfile: profile,
      now: new Date(Date.now() - 60_000) });
    let tick: (() => void) | undefined;
    configureScheduledRegistry({
      setIntervalImpl: (callback, ms) => {
        assert.equal(ms, INTEREST_SWEEP_TICK_MS);
        tick = callback;
        return {};
      },
      clearIntervalImpl: () => { order.push('timer-stopped'); },
    });
    let lockReady!: (pid: number) => void;
    const ready = new Promise<number>(resolve => { lockReady = resolve; });
    const blocked = new Promise<void>(resolve => { releaseSweep = resolve; });
    lockedSweep = sql.begin(async tx => {
      await tx`LOCK TABLE harness_shared.interest_watches IN ACCESS EXCLUSIVE MODE`;
      const [row] = await tx`SELECT pg_backend_pid() AS pid`;
      lockReady(Number(row!.pid));
      await blocked;
    });
    const blockerPid = await Promise.race([ready, lockedSweep.then(() => { throw new Error('sweep lock exited before ready'); })]);
    await startInterestWatchSweeper();
    assert.ok(tick, 'production start must register the managed callback');
    tick();
    sweepEntry = getManaged('interest-watch-sweeper');
    assert.equal(sweepEntry?.running, true, 'registry must retain the async callback');
    await until(async () => {
      const rows = await sql`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))
          AND query LIKE '%interest_watches%'`;
      return rows.length > 0;
    }, 'real interest sweep blocked in private PG');
    order.push('sweep-blocked', 'body-failed');
    assert.fail(SYNC_LINT_EXPECTED_BODY_FAILURE);
  } finally {
    try {
      // Filing starts tracked event work and buffers fallback observations. Own
      // all host-owned lifetimes before closing PG; beforeExit is too late for
      // that IO. The interest-watch interval is a lazy host boot loop and can
      // otherwise start a final HNSW probe while this disposable PG is closing.
      order.push('stop-requested');
      let stopSettled = false;
      const stopping = stopInterestWatchSweeper().then(stopped => { stopSettled = true; return stopped; });
      let stopWaitedForSweep = false;
      try {
        if (sweepEntry) {
          await until(async () => getManaged('interest-watch-sweeper') === undefined, 'timer stopped');
          await nextTurn();
          stopWaitedForSweep = !stopSettled && sweepEntry.running;
          assert.equal(stopWaitedForSweep, true, 'stop must wait while the real SQL is blocked');
        }
      } finally {
        releaseSweep?.();
        if (sweepEntry) order.push('sweep-released');
      }
      await lockedSweep;
      const interestWatchTimerStopped = await stopping;
      order.push('stop-completed');
      let sweepPersisted = false;
      if (watchId) {
        const [watch] = await sql`SELECT last_swept_at, last_match_count, last_error
          FROM harness_shared.interest_watches WHERE id = ${watchId}`;
        assert.ok(watch!.last_swept_at, 'real sweep claimed the watch');
        assert.equal(watch!.last_error, null, 'HNSW sweep must finish without a DB error');
        assert.equal(watch!.last_match_count, 0);
        sweepPersisted = true;
        order.push('sweep-persisted');
      }
      await drainDetached();
      order.push('detached-drained');
      const flush = await flushFallbackObservations({ sql });
      order.push('fallback-flushed');
      lifecycle = {
        detachedRemaining: pendingDetachedCount(),
        fallbackFailed: fallbackObservationCounters().failed,
        interestWatchStopRequested: true,
        interestWatchTimerStopped,
        stopWaitedForSweep,
        sweepPersisted,
        order,
      };
      assert.equal(flush.failed, 0, 'P028 fallback drain must persist before PG closes');
      assert.equal(lifecycle.detachedRemaining, 0, 'P028 detached work must settle before PG closes');
      assert.equal(lifecycle.fallbackFailed, 0, 'P028 must not lose buffered observations');
      // Retain the actual loaded addons before teardown. A native abort alone
      // does not identify the embedder as its cause (WI-6554700010013376).
      const report = process.report.getReport() as { sharedObjects?: string[] };
      console.log('SYNC_LINT_PRIVATE_DIAGNOSTICS ' + JSON.stringify({ lifecycle,
        nativeModules: (report.sharedObjects ?? []).filter(path => path.endsWith('.node')) }));
    } finally {
      setAutoPumpEnabledForTests(previousPump);
      try { await sql.end({ timeout: 5 }); }
      finally { await getOrgPg().sql.end({ timeout: 5 }); }
      order.push('pools-closed');
      if (receipt && lifecycle) console.log('SYNC_LINT_PRIVATE_RECEIPT ' + JSON.stringify({ ...receipt, lifecycle }));
      progress('lifecycle-complete');
    }
  }
  assert.ok(receipt && lifecycle);
}

// Preserve natural process teardown so native lifecycle failures remain visible.
main().catch(error => {
  console.error('SYNC_LINT_PRIVATE_FAILURE ' + error.stack);
  process.exitCode = 1;
});
