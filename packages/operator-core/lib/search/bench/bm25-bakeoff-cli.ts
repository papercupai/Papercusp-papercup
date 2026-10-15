/**
 * bm25-bakeoff-cli.ts — runs the BM25 engine bake-off (WI-10008294; plan
 * bm25-lexical-search-evoke-adoption-2026-10-10 P-001, decision D-001). The roster,
 * metrics, paired statistics and the D-001 rule live in `bm25-bakeoff.ts`; the SQL
 * lives in `bm25-bakeoff/`. This file only drives a throwaway container.
 *
 *   npx tsx packages/operator-core/lib/search/bench/bm25-bakeoff-cli.ts \
 *     [--out bm25-bakeoff.json] [--data-dir /tmp/bm25-bakeoff] [--corpus-csv wi.csv] \
 *     [--corpus work-items|session-turns|documents] \
 *     [--methods tsv_and,pgts,...] [--keep] [--keep-data] [--skip-build]
 *
 * WHAT IT TOUCHES
 * - Reads the work-item corpus from the operator database with ONE read-only COPY
 *   (`sudo -n -u postgres psql -d papercusp`, host context) unless --corpus-csv is given.
 *   Nothing is installed in or written to the live database.
 * - Builds `bm25-bakeoff/Dockerfile` (Evoke base + pg_textsearch + pg_search) and runs ONE
 *   container with every engine preloaded; each engine family gets its own database.
 * - Engines are evaluated ONE AT A TIME (latency is distorted by concurrency), with a
 *   discarded warm-up pass, in committed chunks of 100 queries.
 * - Removes the container and the corpus copy at the end unless --keep / --keep-data.
 *
 * An arm whose RECORDED probe chunk has an in-database median above --slow-cap-ms
 * (default 300) is capped to --slow-cap-n queries (default 200) per form; the JSON records
 * the cap. Queries run in a stable hash order (common.sql), so a capped prefix is a fair
 * sample, and the D-001 verdict is computed on the queries every compared arm answered.
 *
 * Exit 0: every requested arm produced a reading (the JSON + .md hold the results and
 * the D-001 verdict). Exit 2: the run failed; nothing is reported as a result.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyD001Rule,
  BAKEOFF_VARIANTS,
  BASELINE_METHOD,
  BM25_BAKEOFF_ENGINES,
  bakeoffDatabases,
  comparePaired,
  countCsvRecords,
  createDatabaseSql,
  decideCap,
  INHERITED_EXTENSIONS_SQL,
  parseCsv,
  parseEvalRows,
  rankAgreement,
  renderSummaryTable,
  resolveBakeoffCorpus,
  restrictToCommonQueries,
  summarize,
  type BakeoffCorpus,
  type BakeoffEngine,
  type D001Verdict,
  type EvalRow,
  type PairedResult,
} from './bm25-bakeoff';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'bm25-bakeoff');

/** Yields a file's bytes in fixed-size chunks (each chunk is a fresh copy). */
function* readFileChunks(filePath: string, chunkBytes = 1 << 20): Generator<Uint8Array> {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkBytes);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkBytes, null);
      if (n === 0) return;
      yield buf.subarray(0, n);
    }
  } finally {
    fs.closeSync(fd);
  }
}


const SERVER_SETTINGS = [
  'shared_preload_libraries=evoke,pg_textsearch,pg_search',
  'evoke.shared_runtime_size=2GB',
  'shared_buffers=4GB',
  'maintenance_work_mem=2GB',
  'max_wal_size=8GB',
  'checkpoint_timeout=30min',
];

interface Args {
  out: string;
  dataDir: string;
  corpusCsv: string | null;
  corpus: BakeoffCorpus;
  methods: string[] | null;
  image: string;
  container: string;
  keep: boolean;
  keepData: boolean;
  skipBuild: boolean;
  chunk: number;
  warmup: number;
  slowCapMs: number;
  slowCapN: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (flag: string, d: number) => {
    const v = get(flag);
    const n = v === undefined ? d : Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
    return n;
  };
  return {
    out: path.resolve(get('--out') ?? 'bm25-bakeoff.json'),
    dataDir: path.resolve(get('--data-dir') ?? path.join(os.tmpdir(), `bm25-bakeoff-${process.pid}`)),
    corpusCsv: get('--corpus-csv') ? path.resolve(get('--corpus-csv')!) : null,
    corpus: resolveBakeoffCorpus(get('--corpus')),
    methods: get('--methods')?.split(',').map(s => s.trim()).filter(Boolean) ?? null,
    image: get('--image') ?? 'papercusp-bm25-bakeoff:local',
    container: get('--container') ?? `bm25-bakeoff-${process.pid}`,
    keep: argv.includes('--keep'),
    keepData: argv.includes('--keep-data'),
    skipBuild: argv.includes('--skip-build'),
    chunk: num('--chunk', 100),
    warmup: num('--warmup', 50),
    slowCapMs: num('--slow-cap-ms', 300),
    slowCapN: num('--slow-cap-n', 200),
  };
}

const log = (msg: string) => process.stderr.write(`[bm25-bakeoff ${new Date().toISOString()}] ${msg}\n`);

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const tail = String(r.stderr ?? '').slice(-2000) || String(r.stdout ?? '').slice(-2000);
    throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} … exited ${r.status}: ${tail}`);
  }
  return String(r.stdout ?? '');
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class Container {
  constructor(readonly name: string) {}
  psql(db: string, sqlOrFile: { sql: string } | { file: string }): string {
    const target = 'sql' in sqlOrFile ? ['-c', sqlOrFile.sql] : ['-f', `/harness/${sqlOrFile.file}`];
    return run('docker', ['exec', '-i', this.name, 'psql', '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, ...target]);
  }
  async waitReady(timeoutMs = 600_000): Promise<void> {
    const t0 = Date.now();
    // The entrypoint initialises with a temporary socket-only server, then restarts;
    // probing before "init process complete" would talk to the temporary server.
    while (Date.now() - t0 < timeoutMs) {
      const logs = spawnSync('docker', ['logs', this.name], { encoding: 'utf8' });
      const text = `${logs.stdout ?? ''}${logs.stderr ?? ''}`;
      const initDone = /PostgreSQL init process complete|Skipping initialization/.test(text);
      if (initDone) {
        const probe = spawnSync('docker', ['exec', this.name, 'psql', '-U', 'postgres', '-X', '-At', '-c', 'SHOW shared_preload_libraries'], { encoding: 'utf8' });
        if (probe.status === 0 && String(probe.stdout).includes('evoke')) return;
      }
      await sleep(3000);
    }
    throw new Error(`container ${this.name} not ready after ${timeoutMs} ms`);
  }
}

/**
 * warmupMeanMs is wall-clock over the discarded warm-up (cold first touches, psql startup):
 * diagnostic only. probeMedianMs is the in-database median of the first recorded chunk and
 * is what decides the cap (decideCap).
 */
interface ArmRun { method: string; queries: number; capped: boolean; warmupMeanMs: number; probeMedianMs: number }

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const engines: BakeoffEngine[] = BM25_BAKEOFF_ENGINES.filter(e => !args.methods || args.methods.includes(e.method));
  if (args.methods && !engines.some(e => e.method === BASELINE_METHOD)) {
    engines.unshift(BM25_BAKEOFF_ENGINES.find(e => e.method === BASELINE_METHOD)!);
  }
  // Fail before the (multi-minute) corpus export/copy, not at `docker run`, which would
  // otherwise try to pull a local-only tag from Docker Hub.
  if (args.skipBuild && spawnSync('docker', ['image', 'inspect', args.image], { stdio: 'ignore' }).status !== 0) {
    throw new Error(`--skip-build: image ${args.image} is not present locally — drop --skip-build to build it, or pass --image <existing tag>`);
  }
  const loadStart = os.loadavg();
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: HERE }).stdout.trim() || null;

  fs.mkdirSync(args.dataDir, { recursive: true });
  fs.chmodSync(args.dataDir, 0o777); // the container's postgres user writes q.csv here
  const corpusPath = path.join(args.dataDir, 'wi.csv');
  if (args.corpusCsv) {
    fs.copyFileSync(args.corpusCsv, corpusPath);
  } else {
    log('exporting the corpus (read-only COPY from the operator database)');
    const fd = fs.openSync(corpusPath, 'w');
    try {
      run('sudo', ['-n', '-u', 'postgres', 'psql', '-d', 'papercusp', '-X', '-At', '-c', args.corpus.exportSql], { stdio: ['ignore', fd, 'pipe'] });
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.chmodSync(corpusPath, 0o644);
  // Streamed: the documents export (572 MB) exceeds V8's max string length.
  const corpusRows = countCsvRecords(readFileChunks(corpusPath));
  log(`corpus: ${corpusRows} rows`);

  if (!args.skipBuild) {
    log(`building ${args.image}`);
    run('docker', ['build', '-t', args.image, '-f', path.join(HARNESS, 'Dockerfile'), HARNESS]);
  }

  const c = new Container(args.container);
  log(`starting container ${c.name}`);
  run('docker', [
    'run', '-d', '--name', c.name, '--shm-size', '8g',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    '-v', `${args.dataDir}:/data`, '-v', `${HARNESS}:/harness:ro`,
    args.image, 'postgres', ...SERVER_SETTINGS.flatMap(s => ['-c', s]),
  ]);
  try {
    await c.waitReady();
    const databases = bakeoffDatabases(engines);
    for (const [i, { database, setupFiles }] of databases.entries()) {
      log(`setting up ${database}`);
      c.psql('postgres', { sql: createDatabaseSql(database) });
      const inherited = c.psql(database, { sql: INHERITED_EXTENSIONS_SQL }).trim();
      if (inherited) throw new Error(`${database} was created holding extensions [${inherited}]; engine isolation is broken`);
      c.psql(database, { file: 'common.sql' });
      c.psql(database, { file: i === 0 ? 'queries.sql' : 'load-queries.sql' });
      for (const file of setupFiles) c.psql(database, { file });
    }
    // Evoke's preload worker publishes resident images for auto_preload indexes at
    // startup; restart so every index starts from its production (preloaded) state.
    if (engines.some(e => e.database === 'bake_evoke')) {
      log('restarting so Evoke preloads its indexes');
      run('docker', ['restart', c.name]);
      await c.waitReady();
      await sleep(45_000);
    }
    const evokeStatus = engines.some(e => e.database === 'bake_evoke')
      ? c.psql('bake_evoke', { sql: "SELECT json_build_object('evoke', evoke_index_status('docs_body_evoke'::regclass)::text, 'evoke_stem', evoke_index_status('docs_body_evoke_stem'::regclass)::text)::text" }).trim()
      : null;

    const nQueries = Number(c.psql(databases[0].database, { sql: 'SELECT count(*) FROM q' }).trim());
    const arms: ArmRun[] = [];
    const probeN = Math.min(args.chunk, args.slowCapN, nQueries);
    for (const e of engines) {
      let warmupMeanMs = 0;
      for (const v of BAKEOFF_VARIANTS) {
        const t0 = Date.now();
        c.psql(e.database, { sql: `SELECT run_eval_chunk('${e.method}', '${v}', ${args.warmup}, 0, false)` });
        warmupMeanMs = Math.max(warmupMeanMs, (Date.now() - t0) / args.warmup);
      }
      // Recorded probe chunk: its in-database per-query median decides the cap.
      let probeMedianMs = 0;
      for (const v of BAKEOFF_VARIANTS) {
        c.psql(e.database, { sql: `SELECT run_eval_chunk('${e.method}', '${v}', ${probeN}, 0, true)` });
        const median = Number(c.psql(e.database, {
          sql: `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FROM res WHERE method = '${e.method}' AND variant = '${v}' AND NOT err`,
        }).trim());
        if (Number.isFinite(median)) probeMedianMs = Math.max(probeMedianMs, median);
      }
      const { capped, limit } = decideCap(probeMedianMs, { slowCapMs: args.slowCapMs, slowCapN: args.slowCapN, nQueries, probeN });
      log(`${e.method}: warm-up wall mean ${warmupMeanMs.toFixed(1)} ms/query, probe median ${probeMedianMs.toFixed(1)} ms/query${capped ? `, CAPPED to ${limit} queries per form` : ''}`);
      for (const v of BAKEOFF_VARIANTS) {
        for (let off = probeN; off < limit; off += args.chunk) {
          c.psql(e.database, { sql: `SELECT run_eval_chunk('${e.method}', '${v}', ${Math.min(args.chunk, limit - off)}, ${off}, true)` });
        }
      }
      arms.push({ method: e.method, queries: limit, capped, warmupMeanMs, probeMedianMs });
    }

    const rows: EvalRow[] = [];
    const builds: Record<string, Record<string, number>> = {};
    const sizes: Record<string, Record<string, number>> = {};
    const versions: Record<string, string> = {};
    for (const { database } of databases) {
      rows.push(...parseEvalRows(c.psql(database, { sql: 'COPY (SELECT method, variant, target, rank, ms, err, errmsg FROM res ORDER BY 1, 2, 3) TO STDOUT WITH (FORMAT csv)' })));
      builds[database] = Object.fromEntries(parseCsv(c.psql(database, { sql: 'COPY timings TO STDOUT WITH (FORMAT csv)' })).map(([k, v]) => [k!, Number(v)]));
      sizes[database] = Object.fromEntries(parseCsv(c.psql(database, { sql: 'COPY sizes TO STDOUT WITH (FORMAT csv)' })).map(([k, v]) => [k!, Number(v)]));
      versions[database] = c.psql(database, { sql: "SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension WHERE extname <> 'plpgsql'" }).trim();
    }
    const serverVersion = c.psql('postgres', { sql: 'SHOW server_version' }).trim();

    const summaries = summarize(rows);
    const paired: PairedResult[] = [];
    for (const e of engines) {
      if (e.method === BASELINE_METHOD) continue;
      for (const v of BAKEOFF_VARIANTS) {
        const p = comparePaired(rows, BASELINE_METHOD, e.method, v);
        if (p) paired.push(p);
      }
    }
    let verdict: D001Verdict | null = null;
    if (['evoke', 'evoke_stem', 'pgts'].some(m => engines.some(e => e.method === m))) {
      try {
        // D-001 compares arms on the SAME queries: a capped arm must not be set against a
        // full-sample one (run 2's printed verdict did exactly that and was reversed).
        verdict = applyD001Rule(summarize(restrictToCommonQueries(rows, ['evoke', 'evoke_stem', 'pgts'])));
        for (const v of BAKEOFF_VARIANTS) {
          const p = comparePaired(rows, verdict.evokeMethod, 'pgts', v);
          if (p) paired.push(p);
        }
      } catch (err) {
        log(`D-001 not evaluated: ${(err as Error).message}`);
      }
    }
    const agreement = Object.fromEntries(BAKEOFF_VARIANTS.map(v => [v, rankAgreement(rows, 'sqlbm25_tsv', 'sqlbm25_post', v)]));

    const result = {
      kind: 'bm25-bakeoff', workItem: 'WI-10008294', plan: 'bm25-lexical-search-evoke-adoption-2026-10-10',
      generatedAt: new Date().toISOString(), commit, serverVersion, versions,
      corpus: { key: args.corpus.key, queryForm: args.corpus.queryForm, rows: corpusRows, source: args.corpusCsv ? 'csv' : 'operator-db-copy' },
      queries: nQueries, serverSettings: SERVER_SETTINGS,
      loadavg: { start: loadStart, end: os.loadavg(), cores: os.cpus().length },
      engines, arms, builds, sizes, evokeStatus, summaries, paired, sqlBm25Agreement: agreement, verdict,
    };
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
    const md = [
      `# BM25 bake-off (${result.generatedAt})`, '',
      `Corpus: ${corpusRows} ${args.corpus.label} · query = ${args.corpus.queryForm} · ${nQueries} known-item queries per form · ${serverVersion}`, '',
      renderSummaryTable(summaries, engines), '',
      verdict ? `**D-001 verdict:** ${verdict.choice} (compared against ${verdict.evokeMethod}). ${verdict.reasons.join('; ')}` : '**D-001 verdict:** not evaluated',
    ].join('\n');
    fs.writeFileSync(args.out.replace(/\.json$/, '') + '.md', md + '\n');
    log(`wrote ${args.out}`);
    process.stdout.write(md + '\n');
    return 0;
  } finally {
    if (!args.keep) spawnSync('docker', ['rm', '-f', c.name], { encoding: 'utf8' });
    if (!args.keepData) fs.rmSync(args.dataDir, { recursive: true, force: true });
  }
}

main().then(code => process.exit(code), err => {
  log(`FAILED: ${(err as Error).stack ?? String(err)}`);
  process.exit(2);
});
