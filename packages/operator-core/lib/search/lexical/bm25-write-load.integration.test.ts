/**
 * BM25 under sustained concurrent writes (plan bm25-lexical-search-evoke-adoption-2026-10-10,
 * item P-008; requirements R-6 and R-7; decision D-010).
 *
 * WRITERS insert and update work items continuously, the way the fleet does. Meanwhile:
 *  - R-6: a probe commits one item carrying a word no other row has (alternately an INSERT and
 *    a title UPDATE) and searches that word through the lexical seam until the item comes back.
 *    Every probe must be found within 5 s of its commit.
 *  - the real maintenance body (`runBm25Maintenance`, the DBOS tick's body) runs every second.
 * When the writers stop, maintenance runs until it has nothing left to do, then R-7: every BM25
 * index in harness_shared must be at most 1.5x the size of its own REINDEX.
 *
 * The load is sized from a measurement (pg_textsearch 1.5.1): distinct-token rows spill the
 * memtable about every 3,000 rows, and 20,000 of them make a ~7 MB index, so 30,000 inserts plus
 * updates take the work_items index past the 8 MiB reclaim floor. The test asserts it did, so
 * the R-7 check cannot pass by never exercising the reclaim path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import postgres, { type Sql } from 'postgres';
import { BM25_RECLAIM_MIN_BYTES, runBm25Maintenance, type Bm25Reclaim } from './bm25-maintenance';
import { readBm25Indexes, resetBm25Availability } from './rank';
import { rankWorkItemIds, seedBm25Corpus, startBm25TestDb, type Bm25TestDb } from './test-pg/bm25-test-db';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, recordIsolatedIntegrationProof }
  from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const filePath = 'packages/operator-core/lib/search/lexical/bm25-write-load.integration.test.ts';
const workerGroupSuffix = ':bm25-write-load-worker';
const isWorker = process.env.PAPERCUSP_TEST_RUN_GROUP?.endsWith(workerGroupSuffix);

if (isWorker) {

const VISIBILITY_BOUND_MS = 5_000;
const SIZE_BOUND = 1.5;
const WRITERS = 4;
const BATCHES_PER_WRITER = 30;
const MAX_BATCHES_PER_WRITER = 120;
const MIN_PROBES = 20;
const BATCH_ROWS = 250;
const UPDATES_PER_BATCH = 100;
const WRITER_ID_BASE = 1_000_000;
const PROBE_ID_BASE = 900_000_000;
const SEED_ROWS = 400;

let db: Bm25TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await startBm25TestDb({ max: 10 });
  sql = db.sql;
  await seedBm25Corpus(sql);
  resetBm25Availability();
}, 600_000);

afterAll(async () => {
  if (!db) return;
  await db.close();
  const admin = postgres({ ...db.connection, user: 'postgres', database: 'postgres', max: 1 });
  try {
    expect(await admin`SELECT datname FROM pg_database WHERE datname = ${db.runTag}`,
      'write-load database survived teardown').toEqual([]);
  } finally { await admin.end({ timeout: 5 }); }
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A word no seeded or loaded row contains: letters only, fixed affixes the stemmer leaves alone. */
function probeWord(n: number): string {
  const body = [...n.toString(26)].map(c => String.fromCharCode(97 + parseInt(c, 26))).join('');
  return `xq${body}vz`;
}

/**
 * Writes BATCHES_PER_WRITER batches, then keeps going while `more()` holds (up to
 * MAX_BATCHES_PER_WRITER), so every probe runs under load however fast the host is.
 * Returns the number of batches written.
 */
async function writer(w: number, more: () => boolean): Promise<number> {
  const base = WRITER_ID_BASE * (w + 1);
  let b = 0;
  for (; b < BATCHES_PER_WRITER || (more() && b < MAX_BATCHES_PER_WRITER); b++) {
    const from = base + b * BATCH_ROWS;
    const to = from + BATCH_ROWS - 1;
    await sql`
      INSERT INTO harness_shared.work_items (id, ws, title, summary)
      SELECT g, 'w' || (g % 2), 'load item ' || g || ' ' || md5(g::text), 'load summary ' || md5((g * 7)::text)
        FROM generate_series(${from}::int, ${to}::int) g`;
    if (b > 0) {
      // Rewrite rows this writer inserted earlier, so the index also takes dead postings.
      const lo = base + (b - 1) * BATCH_ROWS;
      await sql`
        UPDATE harness_shared.work_items SET summary = 'revised summary ' || md5(id::text || ${String(b)})
         WHERE id BETWEEN ${lo}::int AND ${lo + UPDATES_PER_BATCH - 1}::int`;
    }
  }
  return b;
}

/** Commits one probe item and returns how long after the commit a search first found it. */
interface ProbeObservation {
  n: number;
  id: number;
  term: string;
  kind: 'insert' | 'update';
  committedAt: string;
  firstVisibleAt: string | null;
  ms: number;
  attempts: Array<{ startedAt: string; completedAt: string; elapsedMs: number; found: boolean }>;
}

async function probe(n: number): Promise<ProbeObservation> {
  const word = probeWord(n);
  let id: number;
  let kind: 'insert' | 'update';
  if (n % 2 === 0) {
    kind = 'insert';
    id = PROBE_ID_BASE + n;
    await sql`INSERT INTO harness_shared.work_items (id, ws, title, summary)
              VALUES (${id}, 'w0', ${`probe ${word}`}, 'probe summary')`;
  } else {
    kind = 'update';
    id = 9 + (n % (SEED_ROWS - 9));
    await sql`UPDATE harness_shared.work_items SET title = ${`item ${id} ${word}`} WHERE id = ${id}`;
  }
  const committed = performance.now();
  const committedAt = new Date().toISOString();
  const observation = { n, id, term: word, kind, committedAt };
  const attempts: ProbeObservation['attempts'] = [];
  for (;;) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const ids = await rankWorkItemIds(sql, word);
    const completedAt = new Date().toISOString();
    const found = ids.includes(id);
    attempts.push({ startedAt, completedAt, elapsedMs: performance.now() - started, found });
    const ms = performance.now() - committed;
    if (found) return { ...observation, firstVisibleAt: completedAt, ms, attempts };
    if (ms > VISIBILITY_BOUND_MS) return { ...observation, firstVisibleAt: null, ms: Number.POSITIVE_INFINITY, attempts };
    await sleep(25);
  }
}

async function indexBytes(qualified: string): Promise<number> {
  const [{ bytes }] = await sql<{ bytes: string }[]>`SELECT pg_relation_size(${qualified}::regclass) AS bytes`;
  return Number(bytes);
}

interface WriteLoadRun {
  probes: ProbeObservation[];
  reclaims: Bm25Reclaim[];
  maintenanceErrors: string[];
  maxWorkItemsBytes: number;
  sizes: Array<{ index: string; before: number; after: number; ratio: number }>;
  report: {
    probeRows: Array<Omit<ProbeObservation, 'ms'> & { delayMs: number | null }>;
  };
}

/**
 * One load run feeds both bars, so each bar is its own case and a red names the bar it fails:
 * R-6 rates the probes, R-7 rates the index sizes. Maintenance (compaction + D-010 reclaim)
 * runs DURING the load, so R-7's REINDEX comparison measures what maintenance left behind.
 */
async function runWriteLoad(): Promise<WriteLoadRun> {
  expect([...(await readBm25Indexes(sql))]).toContain('work_items_bm25');
  const [identity] = await sql`SELECT current_database() AS database,
    pg_postmaster_start_time() AS server_started_at,
    current_setting('pg_textsearch.library_version', true) AS library_version`;
  expect(identity!.library_version).toBe('1.5.1');

  let loading = true;
  const probes: ProbeObservation[] = [];
  const reclaims: Bm25Reclaim[] = [];
  const maintenanceErrors: string[] = [];
  let maxWorkItemsBytes = 0;
  // Observe the actual database independently of the busy writer pool. Keep
  // bounded samples for a slow rank call, rather than diagnosing it from load.
  const observer = postgres({ ...db.connection, user: 'postgres', database: db.runTag, max: 1 });
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const waitSamples: Array<{ at: string; pid: number; waitType: string | null;
    wait: string | null; queryMs: number; blockers: number[] }> = [];
  const observerErrors: string[] = [];
  let omittedWaitSamples = 0;
  const observerLoop = (async () => {
    while (loading) {
      try {
        const rows = await observer<{ pid: number; waitType: string | null;
          wait: string | null; queryMs: number; blockers: number[] }[]>`
          SELECT pid, wait_event_type AS "waitType", wait_event AS wait,
                 (extract(epoch FROM clock_timestamp() - query_start) * 1000)::float8 AS "queryMs",
                 pg_blocking_pids(pid) AS blockers
            FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
             AND state = 'active' AND query LIKE '%SELECT w.id%'
           ORDER BY pid`;
        for (const row of rows) {
          if (waitSamples.length === 2_000) { waitSamples.shift(); omittedWaitSamples++; }
          waitSamples.push({ at: new Date().toISOString(), ...row });
        }
      } catch (error) { observerErrors.push(String(error)); }
      await sleep(25);
    }
  })();

  const probeLoop = (async () => {
    for (let n = 0; loading; n++) {
      probes.push(await probe(n));
      await sleep(100);
    }
  })();
  const maintenanceLoop = (async () => {
    while (loading) {
      const r = await runBm25Maintenance(sql);
      maintenanceErrors.push(...r.errors);
      if (r.reclaimed) {
        reclaims.push(r.reclaimed);
        // A successful reclaim can shrink the index before the size poll below.
        // Its pre-reclaim measurement is the witness that the load crossed the floor.
        if (r.reclaimed.index === 'harness_shared.work_items_bm25') {
          maxWorkItemsBytes = Math.max(maxWorkItemsBytes, r.reclaimed.beforeBytes);
        }
      }
      maxWorkItemsBytes = Math.max(maxWorkItemsBytes, await indexBytes('harness_shared.work_items_bm25'));
      await sleep(1_000);
    }
  })();

  const started = performance.now();
  let batches = 0;
  try {
    const done = await Promise.all(Array.from({ length: WRITERS }, (_, w) => writer(w, () => probes.length < MIN_PROBES)));
    batches = done.reduce((a, b) => a + b, 0);
  } finally {
    loading = false;
    try { await Promise.all([probeLoop, maintenanceLoop, observerLoop]); }
    finally { loopDelay.disable(); await observer.end({ timeout: 5 }); }
  }
  const loadMs = performance.now() - started;

  // Settle: run maintenance until a run neither compacts, reclaims, nor leaves work pending.
  for (let i = 0; i < 10; i++) {
    maxWorkItemsBytes = Math.max(maxWorkItemsBytes, await indexBytes('harness_shared.work_items_bm25'));
    const r = await runBm25Maintenance(sql);
    maintenanceErrors.push(...r.errors);
    if (r.reclaimed) {
      reclaims.push(r.reclaimed);
      if (r.reclaimed.index === 'harness_shared.work_items_bm25') {
        maxWorkItemsBytes = Math.max(maxWorkItemsBytes, r.reclaimed.beforeBytes);
      }
    }
    const busy = r.reclaimed || r.pendingReclaims.length > 0 || r.compacted.some(c => c.stillNeeds || c.steps > 0);
    if (!busy) break;
  }

  // R-7: each index against its own REINDEX.
  const sizes: Array<{ index: string; before: number; after: number; ratio: number }> = [];
  for (const name of [...(await readBm25Indexes(sql))].sort()) {
    const qualified = `harness_shared.${name}`;
    const before = await indexBytes(qualified);
    await sql.unsafe(`REINDEX INDEX ${qualified}`);
    const after = await indexBytes(qualified);
    sizes.push({ index: qualified, before, after, ratio: before / after });
  }

  const found = probes.filter(p => Number.isFinite(p.ms)).map(p => p.ms).sort((a, b) => a - b);
  const report = {
    p008: 'bm25-write-load',
    loadMs: Math.round(loadMs),
    inserts: batches * BATCH_ROWS,
    probes: probes.length,
    // Keep the measured rows, not just quantiles: an omitted probe must remain detectable.
    // A timed-out probe is explicit null, never Infinity silently serialized as null.
    probeRows: probes.map(({ ms, ...observation }) => ({
      ...observation, delayMs: Number.isFinite(ms) ? ms : null,
    })),
    probeP50Ms: found.length ? Math.round(found[Math.floor(found.length / 2)]!) : null,
    probeMaxMs: found.length ? Math.round(found[found.length - 1]!) : null,
    maxWorkItemsBytes,
    reclaims,
    sizes,
    databaseIdentity: identity,
    diagnostics: { waitSamples, omittedWaitSamples, observerErrors,
      loopDelayP95Ms: loopDelay.percentile(95) / 1e6, loopDelayMaxMs: loopDelay.max / 1e6 },
  };
  console.info(JSON.stringify(report));

  return { probes, reclaims, maintenanceErrors, maxWorkItemsBytes, sizes, report };
}

describe('BM25 under sustained concurrent writes (P-008)', () => {
  let run: WriteLoadRun;

  beforeAll(async () => {
    run = await runWriteLoad();
  }, 900_000);

  it('R-6: finds every committed item, inserted or updated, within 5 s of its commit', () => {
    const { probes } = run;
    expect(probes.length).toBeGreaterThanOrEqual(MIN_PROBES);
    expect(probes.filter(p => p.kind === 'update').length).toBeGreaterThanOrEqual(10);
    expect(probes.filter(p => !Number.isFinite(p.ms) || p.ms > VISIBILITY_BOUND_MS)).toEqual([]);
  });

  it('R-7: with maintenance running during the load, every index ends within 1.5x of a fresh rebuild', () => {
    const { maintenanceErrors, maxWorkItemsBytes, reclaims, sizes } = run;
    expect(maintenanceErrors).toEqual([]);
    // The load really took work_items past the reclaim floor, and maintenance reclaimed it,
    // so the size bar cannot pass by never exercising the reclaim path.
    expect(maxWorkItemsBytes).toBeGreaterThanOrEqual(BM25_RECLAIM_MIN_BYTES);
    expect(reclaims.some(r => r.index === 'harness_shared.work_items_bm25')).toBe(true);
    // Regression: keep the growth witness even when every post-reclaim poll is smaller.
    for (const reclaimed of reclaims.filter(r => r.index === 'harness_shared.work_items_bm25')) {
      expect(maxWorkItemsBytes).toBeGreaterThanOrEqual(reclaimed.beforeBytes);
    }
    expect(sizes.map(s => s.index)).toContain('harness_shared.work_items_bm25');
    expect(sizes.filter(s => s.ratio > SIZE_BOUND)).toEqual([]);
  });

  it('SPEC-P-008: reports the measured commit-to-searchable delay for every probe row', () => {
    // Check the emitted JSON against the independently retained measurements. This fails
    // if the reporter drops a row, substitutes a quantile, or loses its commit identity.
    const reported = JSON.parse(JSON.stringify(run.report)).probeRows;
    expect(reported).toHaveLength(run.probes.length);
    expect(new Set(reported.map((p: ProbeObservation) => p.n)).size).toBe(run.probes.length);
    for (const measured of run.probes) {
      const row = reported.find((p: ProbeObservation) => p.n === measured.n);
      expect(row).toMatchObject({
        n: measured.n, id: measured.id, term: measured.term, kind: measured.kind,
        committedAt: measured.committedAt, firstVisibleAt: measured.firstVisibleAt,
        delayMs: measured.ms, attempts: measured.attempts,
      });
      expect(Number.isFinite(row.delayMs)).toBe(true);
      expect(row.delayMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(Date.parse(row.committedAt))).toBe(true);
      expect(Number.isFinite(Date.parse(row.firstVisibleAt))).toBe(true);
    }
  });
});
} else {
  const workerOptions = isolatedTestFileWorkerOptions(process.env, 1);
  it('retains all three write-load bars and their original isolated execution (P-008)', async context => {
    const runId = await recordIsolatedIntegrationProof({
      root, filePath,
      sourcePaths: [
        'packages/operator-core/lib/search/lexical/bm25-maintenance.ts',
        'packages/operator-core/lib/search/lexical/rank.ts',
        'packages/operator-core/lib/search/lexical/corpora.ts',
        'packages/operator-core/lib/search/lexical/test-pg/bm25-test-db.ts',
        'packages/operator-core/lib/search/lexical/test-pg/Dockerfile',
        'libs/papercusp/libs/db/sql/1447-bm25-pg-textsearch-indexes.sql',
        'packages/operator-core/test/isolated-integration-proof.ts',
        'packages/operator-core/lib/process-identity.ts',
        'scripts/with-test-pg.mjs', 'scripts/test-files.mjs',
      ],
      retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/write-load-report.json'],
      execute: async (observe, evidenceDir) => {
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          PAPERCUSP_TEST_RUN_GROUP: (process.env.PAPERCUSP_TEST_RUN_GROUP ?? '') + workerGroupSuffix };
        for (const key of ['PC_EXECUTED_SOURCE_MAP_OUT', 'PC_EXECUTED_SOURCE_MAP_RESULT',
          'PC_EXECUTED_SOURCE_MAP_WORKSPACE', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
          'PAPERCUSP_TEST_RUNS_DB_URL', 'PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
          '--isolated-runtime', '--', process.execPath,
          '--import', './scripts/lib/committed-source-loader.mjs', 'scripts/test-files.mjs', filePath,
        ], { cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
        const reportLine = result.output.split('\n').find(line => line.startsWith('{"p008":"bm25-write-load"'));
        // Preserve the failing measurement too, before asserting the worker verdict.
        if (reportLine) await writeFile(join(evidenceDir, 'write-load-report.json'), reportLine + '\n', { flag: 'wx' });
        expect(result, result.output.slice(-8000)).toMatchObject({
          code: 0, signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false,
        });
        expect(result.output).toContain('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');
        expect(result.output).toContain('skippedTests=0');
        expect(result.output).toMatch(/Tests\s+3 passed \(3\)/);
        expect(reportLine, 'the original measured probe report is required').toBeDefined();
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ISOLATED_BM25_WRITE_LOAD_PROOF_RUN ' + runId);
  }, workerOptions.testTimeoutMs);
}
