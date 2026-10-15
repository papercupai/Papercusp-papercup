/** P-013 workload A fixture: the canonical direct create path and the public
 * blueprint operation admission path in one migrated throwaway org database.
 * This is the admission/invariant smoke, not a latency grade. The D-016 paired
 * matrix is run separately once the terminal and event probes are wired. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { startDedicatedNativePg, startDedicatedTestPg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getResourceProfile } from '../resource-profile';
import {
  assertNoLocalModelLoaded,
  installDeterministicEmbedder,
  type InstalledDeterministicEmbedder,
  type LocalModelLoadEvidence,
} from '../../test/_deterministic-embedder';
import { runPairedBenchmark, type BenchmarkArm } from '../../test/_paired-operation-benchmark';
import { projectBlueprintToPg } from './project-to-pg';
import { createTextCollector } from '../child-output';
import { P013_HARNESS, P013_WORKSPACE, attributeDispatchSteps, runP013WorkloadA,
  type P013Arm, type P013Sample, type WarmDispatchStepRow } from './operation-performance-driver';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('../workspace-registry', async () => ({
  ...(await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry')),
  activeWorkspaceId: () => 'p013-benchmark',
}));
vi.mock('../harness-core', async () => ({
  ...(await vi.importActual<typeof import('../harness-core')>('../harness-core')),
  resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }),
}));
vi.mock('../hive-federation', async () => ({
  ...(await vi.importActual<typeof import('../hive-federation')>('../hive-federation')),
  potHomeSlugForHarness: async (_workspace: string, slug: string) => slug,
}));

const { default: createWorkItemTool } = await import('../agent-tools/work_items/create');
const { default: claimWorkItemTool } = await import('../agent-tools/work_items/claim');
const { default: completeWorkItemTool } = await import('../agent-tools/work_items/complete');
const { default: getWorkItemTool } = await import('../agent-tools/work_items/get');
const { default: submitOperationTool } = await import('../agent-tools/blueprint/submit-operation');
const { default: operationEventsTool } = await import('../agent-tools/blueprint/events-operation');
const { default: operationResultTool } = await import('../agent-tools/blueprint/result-operation');
const warmTools = {
  createWorkItemTool, claimWorkItemTool, completeWorkItemTool, getWorkItemTool,
  submitOperationTool, operationEventsTool, operationResultTool,
};
const WS = P013_WORKSPACE;
const HARNESS = P013_HARNESS;
type Arm = P013Arm;
const SOURCE = {
  id: 'p013-workload-a', workItem: { kind: 'feature' },
  roles: [{ id: 'worker' }],
  spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'P-013' } }] },
  operations: [{
    id: 'direct', version: '1', target: { kind: 'work-item', itemKind: 'feature' },
    execution: { kind: 'agent', role: 'worker' },
    inputSchema: { type: 'object', required: ['value'],
      properties: { value: { type: 'string' } }, additionalProperties: false },
    acceptance: { resultSchema: { type: 'object', required: ['value'],
      properties: { value: { type: 'string' } }, additionalProperties: false } },
  }],
};

/** D-022(c): per-sample persistence counters. xact_commit is scoped to the
 * throwaway database; the WAL counters are CLUSTER-wide, so they attribute
 * cleanly only on a dedicated cluster (P013_DEDICATED_PG=1|native). PG18 moved WAL
 * write/fsync counts from pg_stat_wal to pg_stat_io (object 'wal'). */
interface PgCounters {
  xactCommit: number; walRecords: number; walBytes: number;
  walWrites: number; walFsyncs: number; walFsyncMs: number;
}
async function readPgCounters(sql: Sql): Promise<PgCounters> {
  const [row] = await sql<Array<PgCounters>>`
    SELECT
      (SELECT xact_commit FROM pg_stat_database WHERE datname = current_database())::float8 AS "xactCommit",
      (SELECT wal_records FROM pg_stat_wal)::float8 AS "walRecords",
      (SELECT wal_bytes FROM pg_stat_wal)::float8 AS "walBytes",
      (SELECT coalesce(sum(writes), 0) FROM pg_stat_io WHERE object = 'wal')::float8 AS "walWrites",
      (SELECT coalesce(sum(fsyncs), 0) FROM pg_stat_io WHERE object = 'wal')::float8 AS "walFsyncs",
      (SELECT coalesce(sum(fsync_time), 0) FROM pg_stat_io WHERE object = 'wal')::float8 AS "walFsyncMs"`;
  return row;
}

let db: OrgTestDb;
let dedicatedPg: StartedPostgreSqlContainer | DedicatedNativePg | undefined;
let fixtureEmbedder: InstalledDeterministicEmbedder | undefined;
const priorAdminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
// P013_DEDICATED_PG=1 → a dedicated Docker container; =native → a dedicated
// cluster from the host's own PG binaries (no Docker), as workload D does.
// `native` exists because Docker container create on this host hung 2–30 min in
// overlay umount (WI-10003403), killing rig repetitions in beforeAll.
const dedicatedPgMode = process.env.P013_DEDICATED_PG === 'native'
  ? 'native' : process.env.P013_DEDICATED_PG === '1' ? 'container' : null;
const dedicatedPgRequested = dedicatedPgMode !== null;
// Diagnostic-only extra server settings, e.g. statement logging for per-statement
// attribution of a step (WI-10004402). Graded matrices leave P013_PG_EXTRA_SETTINGS unset;
// setup echoes a set value so a run log always shows it was not a graded configuration.
const DEDICATED_PG_EXTRA_SETTINGS = parseExtraPgSettings(process.env.P013_PG_EXTRA_SETTINGS);
const DEDICATED_PG_SETTINGS: Record<string, string> = {
  max_connections: '200', dynamic_shared_memory_type: 'mmap', ...DEDICATED_PG_EXTRA_SETTINGS,
};
// D-024: both arms reach getOrgPg() through fixture.sql, so its pool must be sized
// like the production admin pool (resource-profile pgPoolMax; 52 on the server
// host class) — at the fixture default of 2 the WI-10003586 headroom cap admits
// ONE keyed submission at a time and the rig, not the code, sets c8 throughput.
// P013_ORG_POOL_MAX=<n> pins a size for a deliberate pool-sensitivity A/B.
const P013_ORG_POOL_MAX = (() => {
  const pinned = Number(process.env.P013_ORG_POOL_MAX);
  return Number.isInteger(pinned) && pinned > 0 ? pinned : getResourceProfile().pgPoolMax;
})();
beforeAll(async () => {
  // Stamp each setup step so a hook timeout names the slow step (pilot 11
  // timed out at 120 s with no attribution between container start, the
  // fresh-cluster template build and the fixture install).
  const setupStartedAt = Date.now();
  const stamp = (step: string) => console.error(
    `P013_SETUP step=${step} elapsedMs=${Date.now() - setupStartedAt}`);
  // F4 (WI-10004402): under VITEST the harness pool's connect_timeout defaults
  // to 5 s (libs/papercusp/libs/db/src/connection.ts, EI-2582), a bound meant to
  // fail unmocked unit tests fast. The cold children inherit VITEST, and an a2
  // rep lost 30 minutes when one fresh connect to the dedicated cluster under
  // host load hit it (CONNECT_TIMEOUT -> goal_holder_authority_unreadable, the
  // correct fail-closed refusal). A benchmark measures a slow connect instead of
  // aborting the rep, so this run uses postgres.js's own 30 s default. Set
  // before any pool is built and before any child is forked (children inherit
  // process.env); an explicit operator value still wins.
  process.env.PAPERCUSP_DB_CONNECT_TIMEOUT ??= '30';
  // D-022(c): a cluster owned by THIS run, so cluster-wide WAL counters and
  // fsync waits belong to the measured arms alone rather than to whatever
  // else shares the reused test container. Durability stays at the server
  // defaults (D-022(b): no fsync=off / synchronous_commit=off / tmpfs); the
  // two settings mirror the shared container's non-durability settings. Routed
  // through getTestPg's existing PAPERCUSP_TEST_PG_ADMIN_URL seam, set before
  // this process's first createFreshTestDb call.
  if (dedicatedPgMode === 'native') {
    // P013_PG_BASE_DIR moves the cluster's data dir (default: os.tmpdir()), e.g. onto tmpfs
    // to separate host-IO noise from the measured code path (WI-10004402). Echoed when set.
    const baseDir = process.env.P013_PG_BASE_DIR || undefined;
    const nativePg = await startDedicatedNativePg({ settings: DEDICATED_PG_SETTINGS, baseDir });
    dedicatedPg = nativePg;
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = nativePg.getConnectionUri();
    stamp('dedicated-native-pg-started');
    if (Object.keys(DEDICATED_PG_EXTRA_SETTINGS).length > 0) {
      console.error(`P013_SETUP diagnostic-pg-settings=${JSON.stringify(DEDICATED_PG_EXTRA_SETTINGS)} (not a graded configuration)`);
    }
    if (baseDir) console.error(`P013_SETUP pg-base-dir=${baseDir} dataDir=${nativePg.dataDir}`);
  } else if (dedicatedPgMode === 'container') {
    // startDedicatedTestPg: the stock pg_isready healthcheck crash-restarted
    // this cluster mid-run under load (2026-09-27 warm smoke, see the helper).
    dedicatedPg = await startDedicatedTestPg({
      command: ['postgres', ...Object.entries(DEDICATED_PG_SETTINGS).flatMap(([k, v]) => ['-c', `${k}=${v}`])],
    });
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = dedicatedPg.getConnectionUri();
    stamp('dedicated-pg-started');
  }
  // D-022(a): in-process arms (warmups, warm samples) embed with the fixture too.
  if (process.env.P013_FIXTURE_EMBEDDER === '1') {
    fixtureEmbedder = await installDeterministicEmbedder();
    stamp('fixture-embedder-installed');
  }
  db = await createOrgTestDb({ adminPoolMax: P013_ORG_POOL_MAX });
  stamp('org-test-db-ready');
  fixture.sql = db.adminSql;
  await db.adminSql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${HARNESS}, ${Buffer.from([13])}, 'kc-p013-benchmark', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
  await projectBlueprintToPg(db.adminSql, {
    workspaceId: WS, harnessSlug: HARNESS,
    blueprint: BlueprintSchema.parse(SOURCE),
    specification: compileAgentSpecification({ source: SOURCE }),
  });
  stamp('blueprint-projected');
  // A dedicated cluster builds the migrated template from scratch inside this
  // hook (global setup built it on the shared container), so it needs a
  // larger budget than the shared-container path.
}, dedicatedPgRequested ? 420_000 : 120_000);
afterAll(async () => {
  // Pilot 12 passed its test, then this hook hung past 60 s with no
  // attribution; stamp each step so the slow one is named.
  const teardownStartedAt = Date.now();
  const stamp = (step: string) => console.error(
    `P013_TEARDOWN step=${step} elapsedMs=${Date.now() - teardownStartedAt}`);
  await db?.cleanup();
  stamp('org-test-db-cleaned');
  if (dedicatedPg && 'logs' in dedicatedPg) {
    // WI-10002948: the 12:26Z 5-repetition matrix lost its connection to this
    // cluster mid-run (CONNECTION_CLOSED), and stop() below removed the
    // container, taking with it the server log, the one record that separates
    // a backend crash / crash-restart from a terminated session. Keep the log
    // tail first. testcontainers' logs() follows the stream, so read it for a
    // bounded window and then destroy it. (A native cluster is a plain child
    // process with no container healthcheck to crash-restart it.)
    const container = dedicatedPg;
    try {
      const stream = await container.logs({ tail: 2_000 });
      const text = await new Promise<string>((resolve) => {
        const out = createTextCollector(stream);
        const finish = () => { stream.destroy(); resolve(out.text()); };
        stream.once('end', finish);
        stream.once('error', finish);
        setTimeout(finish, 3_000);
      });
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const dir = process.env.P013_COLD_PROFILE_DIR ?? '/tmp/pcv';
      mkdirSync(dir, { recursive: true });
      const logPath = `${dir}/p013-dedicated-pg-${Date.now()}.log`;
      writeFileSync(logPath, text);
      const notable = text.split('\n')
        .filter((line) => /FATAL|PANIC|terminat|was terminated|shut ?down|server process|out of memory|killed|recovery/i.test(line))
        .slice(-20);
      console.error(`P013_TEARDOWN dedicated-pg-log=${logPath} bytes=${text.length} notable=${notable.length}` +
        (notable.length ? `\n${notable.join('\n')}` : ''));
    } catch (error) {
      console.error(`P013_TEARDOWN dedicated-pg-log-failed ${String(error)}`);
    }
    stamp('dedicated-pg-log-captured');
  }
  await dedicatedPg?.stop({ timeout: 10_000 });
  if (dedicatedPg) stamp('dedicated-pg-stopped');
  if (dedicatedPg) {
    if (priorAdminUrl === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
    else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = priorAdminUrl;
  }
}, dedicatedPgRequested ? 180_000 : 60_000);

describe('P-013 workload A fixture', () => {
  it('creates and completes matching 1 KiB direct items; blueprint arm leaves zero plan rows', async () => {
    const runArm = (arm: Arm, index: number) => runP013WorkloadA(db.adminSql, warmTools, arm, index);
    let sequence = 0;
    if (matrixRequested()) {
      // Each cold sample owns a fresh Node process, module graph and PG client.
      // The parent retains the migrated database and checks all terminal rows.
      // Warm samples run in this process against the same database, so ONE code
      // path serves the whole D-016 matrix (P013_MODES x P013_CONCURRENCIES).
      const matrix = matrixShape();
      let coldStarts = 0;
      let childrenInFlight = 0;
      const counterRows: Array<{
        arm: Arm; sequence: number; embedderCalls: number | null; eventRecovery: P013Sample['eventRecovery'];
        /** Children already running when this one spawned. >0 means the per-sample
         * counter delta overlaps a sibling's (concurrency 8): only trial totals are exact. */
        overlappingChildren: number;
      } & PgCounters> = [];
      // D-047: every warm sample's accepted→dispatched step split, in completion order.
      // runPairedBenchmark awaits each (concurrency, repetition, mode) block before the next;
      // inside a block the arms alternate in D-050 ABBA chunks, so these rows split into
      // consecutive per-block runs, then by arm (see attributeDispatchSteps).
      const warmDispatchSteps: WarmDispatchStepRow[] = [];
      const benchmarkArm = (arm: Arm): BenchmarkArm => ({
        warmup: async () => { await runArm(arm, sequence++); },
        run: async () => {
          const sample = await runArm(arm, sequence++);
          warmDispatchSteps.push({ arm, steps: sample.dispatchStepsMs });
          return sample.marks;
        },
        coldStart: async () => {
          const childSequence = sequence++;
          // D-022(c): snapshot BEFORE the child exists. This read's own
          // transaction commits after it reads, so the delta includes it (-1).
          const countersBefore = await readPgCounters(db.adminSql);
          let embedderCalls: number | null = null;
          // Attribution probe (WI-10002948): the child's CPU profile shows its
          // accept phase is almost all (idle), so sample the database side on
          // the wall clock to see whether those waits are backend waits.
          const profileDir = process.env.P013_COLD_PROFILE_DIR;
          let sampling = Boolean(profileDir);
          const pgSamples: unknown[] = [];
          const sampler = (async () => {
            while (sampling) {
              const rows = await db.adminSql`
                SELECT pid, state, wait_event_type, wait_event, application_name,
                       left(query, 200) AS query,
                       -- Epoch-ms stamps split a run of 'active' samples into ONE long
                       -- statement (same query_start) vs many short ones (it moves).
                       (extract(epoch FROM query_start) * 1000)::bigint AS query_start_ms,
                       (extract(epoch FROM state_change) * 1000)::bigint AS state_change_ms,
                       (extract(epoch FROM xact_start) * 1000)::bigint AS xact_start_ms
                  FROM pg_stat_activity
                 WHERE datname = current_database() AND pid <> pg_backend_pid()`;
              pgSamples.push({ at: Date.now(), rows });
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          })();
          const child = spawn(process.execPath, [
            '--import', 'tsx', fileURLToPath(new URL('./operation-performance-child.ts', import.meta.url)),
          ], {
            cwd: process.cwd(),
            env: { ...process.env, P013_COLD_DSN: db.adminDsn, P013_COLD_ARM: arm,
              P013_COLD_SEQUENCE: String(childSequence), PAPERCUSP_WORKSPACE_ID: WS,
              HARNESS_ADMIN_DATABASE_URL: db.adminDsn, HARNESS_DATABASE_URL: db.appDsn },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            signal: AbortSignal.timeout(90_000),
          });
          coldStarts++;
          const overlappingChildren = childrenInFlight++;
          const stderr = createTextCollector(child.stderr, { maxChars: 4_000 });
          let stage = 'spawned';
          // stdio[2] is 'pipe', so stderr exists; fail loudly rather than lose diagnostics.
          if (!child.stderr) throw new Error('P-013 cold child spawned without a stderr pipe');
          let sample: P013Sample | undefined;
          const exit = new Promise<void>((resolve, reject) => {
            child.once('error', (error) => reject(new Error(
              `P-013 cold child ${stage}: ${error.message}; stderr: ${stderr.peek()}`)));
            // The child SIGKILLs itself after flushing to skip native env
            // teardown (EI-10702); that exit is clean only once a sample arrived.
            // 'close', not 'exit': under load 'exit' can fire before the already-sent
            // p013-sample IPC message is dispatched, so a successful sample read as a
            // failed child. 'close' waits for the IPC channel to drain.
            child.once('close', (code, signal) => code === 0 || (signal === 'SIGKILL' && sample)
              ? resolve()
              : reject(new Error(`P-013 cold child ${stage} exited ${code}/${signal} ` +
                `(${sample ? 'sample received' : 'no sample'}): ${stderr.peek()}`)));
          });
          let childLocalModel: LocalModelLoadEvidence | null = null;
          child.on('message', (message: {
            kind?: string; stage?: string; sample?: P013Sample; calls?: number; localModel?: LocalModelLoadEvidence;
          }) => {
            if (message?.kind === 'p013-stage') stage = message.stage ?? stage;
            if (message?.kind === 'p013-embedder') {
              embedderCalls = message.calls ?? null;
              childLocalModel = message.localModel ?? null;
            }
            if (message?.kind === 'p013-sample') sample = message.sample;
          });
          const stopSampler = async () => {
            if (!profileDir || !sampling) return;
            sampling = false;
            await sampler;
            const { mkdirSync, writeFileSync } = await import('node:fs');
            mkdirSync(profileDir, { recursive: true });
            writeFileSync(`${profileDir}/p013-${arm}-${childSequence}.pgsamples.json`,
              JSON.stringify(pgSamples));
          };
          const settled = () => { childrenInFlight--; };
          void exit.then(settled, settled);
          void exit.then(stopSampler, stopSampler);
          return {
            run: async () => {
              await exit;
              await stopSampler();
              expect(sample?.arm).toBe(arm);
              // Positive control for D-022(a): the fixture must have served the
              // claim-time recall, or this sample re-measured the provider.
              if (fixtureEmbedder) {
                // F3 (WI-10004402): a zero-call sample was seen once and its cause
                // is unproven (a recall skipped by an expired memory deadline is
                // one candidate), so the failure carries the child's stderr.
                expect(embedderCalls, `P-013 A ${arm} child ${childSequence} made no fixture embed call; ` +
                  `child stderr tail: ${stderr.peek().slice(-2000)}`).toBeGreaterThan(0);
                // Negative control (EI-24688584300743328): neither the child
                // nor this parent may have loaded a real local model while the
                // fixture is installed.
                expect(childLocalModel).toEqual({
                  pipelines: {}, workerAlive: false, onnxruntimeMappings: [], onnxruntimeLoadStack: null,
                });
                assertNoLocalModelLoaded(`P-013 A parent after ${arm} child ${childSequence}`);
              }
              const after = await readPgCounters(db.adminSql);
              const delta = Object.fromEntries(Object.entries(after).map(([key, value]) =>
                [key, value - countersBefore[key as keyof PgCounters]])) as unknown as PgCounters;
              // Exclude this fixture's own read-only commits: the BEFORE snapshot
              // and every pg_stat_activity sampler poll.
              delta.xactCommit -= 1 + pgSamples.length;
              counterRows.push({
                arm, sequence: childSequence, embedderCalls, eventRecovery: sample!.eventRecovery,
                overlappingChildren, ...delta,
              });
              return sample!.marks;
            },
            close: async () => { if (!child.killed && child.exitCode === null) child.kill(); await exit; },
          };
        },
      });
      // One code path for the pilot (1x1) and the D-016 matrix (P013_PROTOCOL's
      // 5 repetitions x 200 warm + 50 cold at concurrency 1 and 8): the paired
      // runner interleaves the arms; P013_REPETITION_OFFSET keeps that order when
      // each repetition runs as its own process.
      const { repetitions, coldSamples, warmSamples, warmups, repetitionOffset, modes, concurrencies } = matrix;
      // Claim-time recall outcomes are attribution for the claim step (WI-10004402): its
      // deadline warn is silent under vitest, so count outcomes over the matrix only.
      const claimRecall = await import('../memory/claim-port');
      claimRecall._resetClaimRecallOutcomeStatsForTests();
      const trials = await runPairedBenchmark({ control: benchmarkArm('control'),
        candidate: benchmarkArm('candidate') }, {
        warmups, repetitions, warmSamples, coldSamples, concurrencies, modes, repetitionOffset,
      });
      expect(coldStarts).toBe(modes.includes('cold') ? 2 * repetitions * coldSamples * concurrencies.length : 0);
      expect(trials).toHaveLength(2 * repetitions * modes.length * concurrencies.length);
      expect(counterRows).toHaveLength(coldStarts);
      // Negative control over the whole matrix, including in-process warm arms
      // that ran after the last cold child (EI-24688584300743328).
      if (fixtureEmbedder) {
        console.info('P-013 workload A local-model evidence',
          JSON.stringify(assertNoLocalModelLoaded('P-013 A parent after the matrix')));
      }
      // A sample whose normal done-fire missed P013_NORMAL_FIRE_BUDGET_MS was
      // completed by production's reconciler; its business-event mark is the
      // repair, not the normal emit. Count them per arm so the report carries them.
      console.info('P-013 workload A business-event recovery', JSON.stringify(
        (['control', 'candidate'] as const).map((arm) => ({
          arm,
          normal: counterRows.filter((row) => row.arm === arm && row.eventRecovery === 'normal').length,
          reconciler: counterRows.filter((row) => row.arm === arm && row.eventRecovery === 'reconciler').length,
        }))));
      console.info('P-013 workload A per-sample persistence counters', JSON.stringify({
        cluster: dedicatedPg ? 'dedicated' : 'shared', clusterSubstrate: dedicatedPgMode ?? 'shared-container', fixtureEmbedder: Boolean(fixtureEmbedder), orgPoolMax: P013_ORG_POOL_MAX,
        rows: counterRows }));
      // The complete trial rows (every percentile, per repetition, wall time and
      // throughput) so separate per-repetition runs aggregate without re-running.
      // A cold-only run keeps the historical 'P-013 workload A cold trials' label.
      console.info(`P-013 workload A ${modes.join('+')} trials`, JSON.stringify({
        repetitions, repetitionOffset, coldSamples, warmSamples, warmups, modes, concurrencies,
        cluster: dedicatedPg ? 'dedicated' : 'shared', clusterSubstrate: dedicatedPgMode ?? 'shared-container', fixtureEmbedder: Boolean(fixtureEmbedder), orgPoolMax: P013_ORG_POOL_MAX, trials }));
      // D-047: which serial step inside acceptedToDispatch carries any arm difference.
      // Attribution only; gradePairedBenchmark never reads it.
      console.info('P-013 workload A dispatch-step attribution (D-047; no grade)',
        JSON.stringify(attributeDispatchSteps(trials, warmDispatchSteps)));
      // In-process warm arms only; a cold child's recall runs in its own process.
      console.info('P-013 workload A claim-recall outcomes (no grade)',
        JSON.stringify(claimRecall.readClaimRecallOutcomeStats()));
      // Per-phase split, not just the total: the cold cost must be attributed to a
      // D-016 phase (accept / dispatch / terminal / business event) before any
      // fixture decision is taken on it (WI-10002948).
      console.info('P-013 workload A process-isolated cold-boundary pilot; no D-016 grade',
        JSON.stringify(trials.map((trial) => ({ arm: trial.arm, mode: trial.mode,
          phasesP50Ms: Object.fromEntries(Object.entries(trial.phasesMs)
            .map(([phase, dist]) => [phase, +dist.p50.toFixed(2)])) }))));
    } else if (process.env.P013_PAIRED_SMOKE === '1') {
      const benchmarkArm = (arm: Arm): BenchmarkArm => ({
        warmup: async () => { await runArm(arm, sequence++); },
        run: async () => (await runArm(arm, sequence++)).marks,
      });
      const trials = await runPairedBenchmark({ control: benchmarkArm('control'),
        candidate: benchmarkArm('candidate') }, {
        warmups: 0, repetitions: 1, warmSamples: 1, coldSamples: 1, concurrencies: [1], modes: ['warm'],
      });
      expect(trials).toHaveLength(2);
      expect(trials.every((trial) => trial.persistence.dbRoundTrips === null &&
        trial.persistence.dbBytes === null && trial.persistence.durableSteps === null)).toBe(true);
      console.info('P-013 workload A warm-only paired-runner instrumentation smoke; no grade',
        JSON.stringify(trials.map((trial) => ({ arm: trial.arm, mode: trial.mode,
          totalMs: +trial.phasesMs.total.p50.toFixed(2) }))));
    } else {
      const pilot = process.env.P013_PILOT === '1';
      const order: Arm[] = pilot
        ? ['control', 'candidate', 'candidate', 'control']
        : ['control', 'candidate'];
      const samples: P013Sample[] = [];
      for (const arm of order) samples.push(await runArm(arm, sequence++));
      if (pilot) {
        console.info('P-013 workload A non-grading API-phase pilot (promoter excluded)', JSON.stringify({
          phases: ['create-or-submit', 'claim', 'complete', 'observe-terminal'],
          samples: samples.map(({ arm, phasesMs, eventLagMs }) => ({
            arm, ms: phasesMs.map((ms) => +ms.toFixed(2)), eventLagMs: +eventLagMs.toFixed(2),
          })),
        }));
      }
    }
    const [{ items, plans, runs }] = await db.adminSql<Array<{ items: number; plans: number; runs: number }>>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.work_items
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS items,
        (SELECT count(*)::int FROM harness_shared.harness_plans
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS plans,
        (SELECT count(*)::int FROM harness_shared.plan_runs
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS runs
    `;
    expect({ items, plans, runs }).toEqual({ items: sequence, plans: 0, runs: 0 });
  }, coldMatrixBudgetMs());
});

/** P013_PG_EXTRA_SETTINGS: a JSON object of string server settings, appended after the
 * fixed ones (a later `-c` wins). Unset or empty means none. */
function parseExtraPgSettings(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.values(parsed).some((value) => typeof value !== 'string')) {
    throw new Error('P-013 P013_PG_EXTRA_SETTINGS must be a JSON object of string values');
  }
  return parsed as Record<string, string>;
}

/** P013_MATRIX=1 (or the historical P013_COLD_PILOT=1) selects the paired D-016 matrix. */
function matrixRequested(): boolean {
  return process.env.P013_MATRIX === '1' || process.env.P013_COLD_PILOT === '1';
}

/** The matrix shape from env. Defaults reproduce the historical cold-only
 * concurrency-1 pilot, so an existing P013_COLD_PILOT invocation is unchanged. */
function matrixShape() {
  const count = (name: string, fallback: number, min: number) => {
    const value = Number(process.env[name] ?? String(fallback));
    if (!Number.isInteger(value) || value < min) throw new Error(`P-013 ${name} must be an integer >= ${min}`);
    return value;
  };
  const list = <T extends string>(name: string, fallback: string, allowed: readonly T[]): T[] => {
    const values = (process.env[name] ?? fallback).split(',').map((value) => value.trim()).filter(Boolean);
    if (values.length === 0 || values.some((value) => !allowed.includes(value as T))) {
      throw new Error(`P-013 ${name} must be a comma list of ${allowed.join('|')}`);
    }
    return values as T[];
  };
  return {
    repetitions: count('P013_REPETITIONS', 1, 1),
    repetitionOffset: count('P013_REPETITION_OFFSET', 0, 0),
    coldSamples: count('P013_COLD_SAMPLES', 1, 1),
    warmSamples: count('P013_WARM_SAMPLES', 1, 1),
    warmups: count('P013_WARMUPS', 0, 0),
    modes: list('P013_MODES', 'cold', ['warm', 'cold'] as const),
    concurrencies: list('P013_CONCURRENCIES', '1', ['1', '8'] as const).map(Number) as Array<1 | 8>,
  };
}

/** A cold sample spawns one child (90 s spawn ceiling); a warm sample or warmup
 * runs in-process and may wait up to P013_NORMAL_FIRE_BUDGET_MS for its business
 * event, so budget each warm call generously. Capped under the router's
 * 120-minute maximum; the non-matrix smoke keeps 180 s. */
function coldMatrixBudgetMs(): number {
  if (!matrixRequested()) return 180_000;
  const m = matrixShape();
  const perConcurrency = (m.modes.includes('cold') ? m.repetitions * m.coldSamples * 90_000 : 0) +
    (m.modes.includes('warm') ? m.repetitions * m.warmSamples * 10_000 : 0) + m.warmups * 10_000;
  return Math.min(115 * 60_000, Math.max(180_000, 2 * m.concurrencies.length * perConcurrency + 120_000));
}
