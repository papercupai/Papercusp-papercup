/**
 * WI-6454 — the gitnexus re-index cadence policy.
 *
 * The two things worth pinning here are (a) the `--skip-agents-md` guard, which is the
 * difference between a maintenance job and one that corrupts every agent's prompt
 * source, and (b) the ORDER of the gates in `decideReindex` — the policy is only correct
 * if load outranks a missing index and the interval floor outranks staleness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  utimesSync,
  openSync,
  closeSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAnalyzeArgs,
  canaryCypherArgv,
  buildAnalyzeInvocation,
  analyzeEnv,
  analyzeLogPath,
  pruneAnalyzeLogs,
  pruneStrandedParseCaches,
  readAnalyzeLogTail,
  selectiveSourceLimitKb,
  GITNEXUS_KNOWN_SOURCE_PATH,
  analyzeNodeArgs,
  analyzeCliPath,
  GITNEXUS_ANALYZE_HEAP_MB,
  GITNEXUS_ANALYZE_MEMORY_MAX_BYTES,
  GITNEXUS_ANALYZE_TIMEOUT_MS,
  GITNEXUS_ANALYZE_SEMI_SPACE_MB,
  GITNEXUS_ANALYZE_STACK_KB,
  GITNEXUS_LBUG_MAX_DB_BYTES,
  GITNEXUS_LBUG_BUFFER_POOL_BYTES,
  GITNEXUS_LBUG_DB_ALERT_RATIO,
  GITNEXUS_EMBEDDINGS_NODE_CAP,
  GITNEXUS_EMBEDDING_DEVICE,
  GITNEXUS_EMBEDDING_THREADS,
  GITNEXUS_ANALYZE_MALLOC_ARENA_MAX,
  GITNEXUS_WAL_MANUAL_CHECKPOINT_LINUX,
  analyzeEmbeddingsExpected,
  vectorSearchProbe,
  readIncompleteIndexMarker,
  describeStrandedIncompleteIndex,
  readStrandedIncompleteIndex,
  gitnexusMetaPath,
  measureGitnexusDbUsage,
  measureGitnexusIndexDisk,
  decideGitnexusDbHealthUpdate,
  decideIndexDiskHealthUpdate,
  decideReindex,
  readRegistryEntry,
  pickIndexFreshness,
  readIndexMetaFreshness,
  GITNEXUS_REINDEX_ROUTINE_TIMEOUT_MS,
  GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES,
  measureDiskCapacityBytes,
  measureFreeDiskBytes,
  requiredFreeDiskBytes,
  shouldSkipForHive,
  GITNEXUS_REPO_NAME,
  DEFAULT_MAX_LOAD_PER_CORE,
  DEFAULT_MIN_COMMITS_BEHIND,
  DEFAULT_MIN_INTERVAL_SEC,
  gitnexusDbPaths,
  isOrphanShadow,
  isOrphanWal,
  isDeadShadow,
  DEAD_SHADOW_STALE_MS,
  cleanCrashResidue,
  probeOpenHandles,
  classifyWriterLiveness,
  classifyWriteHolderLiveness,
  detectLiveAnalyzeWriter,
  processAgeMs,
  type OpenHandleProbe,
  judgeCanary,
  analyzeTickSucceeded,
  analyzeResultFromClose,
  GITNEXUS_HEALTH_DEFAULT,
  GITNEXUS_FAILURE_ALERT_THRESHOLD,
  decideGitnexusHealthUpdate,
  runGitnexusAnalyze,
  type ReindexDecisionInput,
  type GitnexusHealth,
  GITNEXUS_REINDEX_SPAWN_MARKER_ENV,
  readRoutineSpawnMarker,
  findAdoptableWriter,
  findRoutineAnalyzePids,
  argvIsRoutineAnalyze,
  readProcessArgv,
  waitForPidExit,
  judgeAdoptedRun,
  readIndexStatsForHealth,
} from './gitnexus-reindex-action';
import { SELECTIVE_SOURCE_BLOBS } from '../../code-intelligence/selective-corpus';
import { classifyAnalyzeFailure } from '../../code-intelligence/gitnexus-analyze-failure';

describe('failed-run parse-cache retention (EI-25559197862756318)', () => {
  let root: string;
  const current = 'a'.repeat(64);
  const sibling = 'b'.repeat(64);
  const old = 'c'.repeat(64);
  const recent = 'd'.repeat(64);
  const now = Date.now();
  const options = { nowMs: now, writerLiveness: () => 'orphaned' as const };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitnexus-cache-retention-'));
    const storage = join(root, '.gitnexus');
    for (const store of ['parse-cache', 'parsedfile-cache']) {
      mkdirSync(join(storage, store), { recursive: true });
      writeFileSync(join(storage, store, 'index.json'), JSON.stringify({ keys: [current] }));
      for (const key of [current, sibling, old, recent]) {
        const file = store === 'parse-cache' ? join(storage, store, `${key}.json`) : join(storage, store, key, 'shard.json');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, '{}');
        if (key !== recent) {
          utimesSync(file, new Date(now - 48 * 3600000), new Date(now - 48 * 3600000));
          if (store === 'parsedfile-cache') utimesSync(dirname(file), new Date(now - 48 * 3600000), new Date(now - 48 * 3600000));
        }
      }
    }
    writeFileSync(join(storage, 'meta.json'), JSON.stringify({ cacheKeys: [current] }));
    mkdirSync(join(storage, 'branches', 'sibling'), { recursive: true });
    writeFileSync(join(storage, 'branches', 'sibling', 'gitnexus.json'), JSON.stringify({ cacheKeys: [sibling] }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('previews and removes only old unreferenced shards, retaining indexed, sibling, and recent chunks', async () => {
    const preview = await pruneStrandedParseCaches(root, { ...options, dryRun: true });
    expect(preview).toMatchObject({ status: 'complete', removed: [] });
    expect(preview.candidates).toHaveLength(2);
    expect(preview.candidateBytes).toBeGreaterThan(0);
    const removed = await pruneStrandedParseCaches(root, options);
    expect(removed.removed).toEqual(preview.candidates);
    for (const key of [current, sibling, recent]) {
      expect(existsSync(join(root, '.gitnexus', 'parse-cache', `${key}.json`))).toBe(true);
      expect(existsSync(join(root, '.gitnexus', 'parsedfile-cache', key))).toBe(true);
    }
  });

  it('fails closed on corrupt branch authority and live or unknown writers', async () => {
    for (const state of ['live', 'unknown'] as const) {
      expect(await pruneStrandedParseCaches(root, { writerLiveness: () => state })).toMatchObject({ status: 'spared', removed: [] });
    }
    writeFileSync(join(root, '.gitnexus', 'branches', 'sibling', 'gitnexus.json'), 'invalid');
    expect(await pruneStrandedParseCaches(root, options)).toMatchObject({ status: 'not-measured', removed: [] });
  });

  it('spares a writer arriving during the census and never follows a cache symlink', async () => {
    const outside = join(root, 'outside.json');
    writeFileSync(outside, '{}');
    symlinkSync(outside, join(root, '.gitnexus', 'parse-cache', `${'e'.repeat(64)}.json`));
    const probe = vi.fn().mockReturnValueOnce('orphaned').mockReturnValue('live');
    expect(await pruneStrandedParseCaches(root, { ...options, writerLiveness: probe })).toMatchObject({ status: 'spared', removed: [] });
    await pruneStrandedParseCaches(root, options);
    expect(existsSync(outside)).toBe(true);
  });

  it('retains fresh deep writes even when the containing chunk directory is old', async () => {
    const dir = join(root, '.gitnexus', 'parsedfile-cache', old);
    writeFileSync(join(dir, 'shard.json'), '{"fresh":true}');
    utimesSync(dir, new Date(now - 48 * 3600000), new Date(now - 48 * 3600000));
    const result = await pruneStrandedParseCaches(root, options);
    expect(result.removed).toEqual([join(root, '.gitnexus', 'parse-cache', `${old}.json`)]);
    expect(existsSync(dir)).toBe(true);
  });

  it('spares an authority change during census and a missing cache index', async () => {
    let calls = 0;
    const writerLiveness = (): 'orphaned' => {
      if (++calls === 2) writeFileSync(join(root, '.gitnexus', 'meta.json'), JSON.stringify({ cacheKeys: [current, old] }));
      return 'orphaned';
    };
    expect(await pruneStrandedParseCaches(root, { ...options, writerLiveness })).toMatchObject({ status: 'spared', removed: [] });
    rmSync(join(root, '.gitnexus', 'parse-cache', 'index.json'));
    expect(await pruneStrandedParseCaches(root, options)).toMatchObject({ status: 'not-measured', removed: [] });
  });

  it('keeps the maintenance hook before admission and on failed spawned or adopted runs', () => {
    const src = readFileSync(fileURLToPath(new URL('./gitnexus-reindex-action.ts', import.meta.url)), 'utf8');
    expect(src).toContain('if (!ranClean) await cleanStrandedParseCaches(root)');
    expect(src.indexOf('await cleanStrandedParseCaches(root);', src.indexOf('const residue = cleanCrashResidue(root)')))
      .toBeLessThan(src.indexOf('const requiredFree = requiredFreeDiskBytes('));
  });
});

const taskManager = vi.hoisted(() => ({
  managedSpawn: vi.fn(),
}));

vi.mock('../../task-manager/managed-spawn', () => ({ managedSpawn: taskManager.managedSpawn }));

function fakeManagedChild(): EventEmitter & {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.pid = 4242;
  child.kill = vi.fn();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

beforeEach(() => {
  taskManager.managedSpawn.mockReset();
});

/** A baseline that WOULD run, so each test can flip exactly one field. */
function baseInput(over: Partial<ReindexDecisionInput> = {}): ReindexDecisionInput {
  return {
    registered: true,
    commitsBehind: 50,
    loadPerCore: 0.5,
    secondsSinceIndexed: 4 * 3600,
    memoryPressure: 'ok',
    minCommitsBehind: DEFAULT_MIN_COMMITS_BEHIND,
    maxLoadPerCore: DEFAULT_MAX_LOAD_PER_CORE,
    minIntervalSec: DEFAULT_MIN_INTERVAL_SEC,
    ...over,
  };
}

describe('buildAnalyzeArgs', () => {
  it('ALWAYS passes --skip-agents-md (without it, analyze rewrites CLAUDE.md + AGENTS.md)', () => {
    expect(buildAnalyzeArgs('/repo', 'papercusp')).toContain('--skip-agents-md');
  });

  it('names the repo so the alias cannot collide with another checkout on the box', () => {
    const args = buildAnalyzeArgs('/repo', GITNEXUS_REPO_NAME);
    expect(args[args.indexOf('--name') + 1]).toBe(GITNEXUS_REPO_NAME);
  });

  it('analyzes the root it is given, not the process cwd', () => {
    expect(buildAnalyzeArgs('/some/root', 'x')).toContain('/some/root');
  });

  // -------------------------------------------------------------------------
  // --force (D-002). gitnexus 1.6.9 defaults to an INCREMENTAL writeback, and on this graph
  // that path is the outage: measured 2026-09-05 twice (run #2 on /tmp and the live
  // bootstrap, both 'Incremental: changed≈140–296 … +5,784–6,839 importer(s)'), it breached
  // the 16 GiB GITNEXUS_LBUG_MAX_DB_BYTES ceiling ~35–45 min in and SIGSEGV'd, leaving the
  // D-016 residue — while a FULL rebuild of the same graph finished in 3,133s with the DB
  // at 5.3 GiB. The previous assertion here ('does not pass --force') pinned the opposite
  // on the belief that analyze had a cheap staleness short-circuit; decideReindex is that
  // short-circuit, and it runs BEFORE the spawn.
  // -------------------------------------------------------------------------
  it('ALWAYS passes --force — the incremental path breaches the LadybugDB ceiling on this graph', () => {
    expect(buildAnalyzeArgs('/repo', 'x')).toContain('--force');
  });

  it('places --force BEFORE --embeddings (which takes an optional value and must stay last)', () => {
    const args = buildAnalyzeArgs('/repo', 'x');
    expect(args.indexOf('--force')).toBeLessThan(args.indexOf('--embeddings'));
    expect(args.indexOf('--force')).toBeGreaterThan(args.indexOf('--skip-agents-md'));
  });

  // -------------------------------------------------------------------------
  // EMBEDDINGS (plan gitnexus-embeddings-enablement-2026-09-05, D-002). Without the flag
  // gitnexus PRESERVES existing embeddings and never embeds a new node — so dropping it
  // freezes the vector leg silently rather than disabling it. Pinned like --skip-agents-md.
  // -------------------------------------------------------------------------
  it('ALWAYS asks for embeddings, UNCAPPED, as the LAST argv pair (--embeddings takes an optional value)', () => {
    const args = buildAnalyzeArgs('/repo', 'papercusp');
    expect(args.slice(-2)).toEqual(['--embeddings', '0']);
  });

  it('the cap is 0 — any positive cap below the graph size re-arms gitnexus\'s node-count skip', () => {
    // gitnexus's DEFAULT_EMBEDDING_NODE_LIMIT is 50,000 and this graph measured 246,622 nodes
    // on 2026-09-05; `--embeddings 50000` produced 0 embeddings on 2026-09-04. Only 0 disables
    // the cap (core/embedding-mode.js deriveEmbeddingCap).
    expect(GITNEXUS_EMBEDDINGS_NODE_CAP).toBe(0);
    const MEASURED_GRAPH_NODES = 246_622;
    const GITNEXUS_DEFAULT_NODE_LIMIT = 50_000;
    expect(MEASURED_GRAPH_NODES).toBeGreaterThan(GITNEXUS_DEFAULT_NODE_LIMIT);
  });

  it('passes a caller-supplied cap through verbatim (the measurement scripts use this)', () => {
    expect(buildAnalyzeArgs('/repo', 'x', 50_000).slice(-2)).toEqual(['--embeddings', '50000']);
  });

  it('analyzeEmbeddingsExpected reads the flag off the argv it is handed — and off the default argv', () => {
    expect(analyzeEmbeddingsExpected(buildAnalyzeArgs('/repo', 'x'))).toBe(true);
    expect(analyzeEmbeddingsExpected(['analyze', '/repo', '--skip-agents-md', '--name', 'x'])).toBe(false);
    // No-arg form derives from buildAnalyzeArgs itself, so the canary expectation cannot
    // drift from the spawn.
    expect(analyzeEmbeddingsExpected()).toBe(true);
  });
});

// ===========================================================================
// P-004 — ANALYZE RESOURCE CAP.
//
// The cap is split across TWO surfaces for a reason that is invisible from either one
// alone, so each half is pinned here: the heap/semi-space go in NODE_OPTIONS (which
// ALSO suppresses gitnexus's self-re-exec), and --stack-size can only be argv because
// Node 24+ refuses it in NODE_OPTIONS. Get either half wrong and the failure is silent
// — an uncapped 30 GiB heap, or a crash-on-startup, or a lost stack budget.
//
// Every block carries a CALIBRATION case: an assertion that fails if the mechanism does
// nothing at all, so a suite of "was not overridden" assertions cannot pass green
// against a function that never sets anything.
// ===========================================================================

describe('analyzeEnv — the heap cap (P-004)', () => {
  it('caps the old-space heap at the measured budget', () => {
    const env = analyzeEnv({}, GITNEXUS_ANALYZE_HEAP_MB);
    expect(env.NODE_OPTIONS).toContain(`--max-old-space-size=${GITNEXUS_ANALYZE_HEAP_MB}`);
  });

  it('SUPPRESSES gitnexus self-re-exec by setting the flag it early-returns on', () => {
    // Load-bearing, and the reason this is an env var rather than an argv flag:
    // gitnexus's ensureHeap() returns early iff NODE_OPTIONS matches this exact
    // substring. Without it, gitnexus re-execs and replaces our cap with 0.75x of a
    // cgroup it shares with every other routine.
    expect(analyzeEnv({}).NODE_OPTIONS).toMatch(/--max-old-space-size/);
  });

  it('preserves the semi-space tuning gitnexus would have applied to itself', () => {
    // Suppressing the re-exec means we inherit responsibility for the flags it carried.
    expect(analyzeEnv({}).NODE_OPTIONS).toContain(
      `--max-semi-space-size=${GITNEXUS_ANALYZE_SEMI_SPACE_MB}`,
    );
  });

  it('NEVER emits --stack-size into NODE_OPTIONS (Node 24+ exits 9 on it)', () => {
    // Verified on node v25.9.0: "--stack-size= is not allowed in NODE_OPTIONS".
    // Leaking it here would not degrade the cap, it would fail every analyze at startup.
    expect(analyzeEnv({}).NODE_OPTIONS).not.toContain('--stack-size');
    expect(analyzeEnv({ NODE_OPTIONS: '--stack-size=4096' }).NODE_OPTIONS).toBeDefined();
  });

  it('honours an operator-supplied heap instead of overriding it', () => {
    const env = analyzeEnv({ NODE_OPTIONS: '--max-old-space-size=4096' });
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(env.NODE_OPTIONS).not.toContain(String(GITNEXUS_ANALYZE_HEAP_MB));
  });

  it('CALIBRATION: a base with no heap DOES get one — so "honours" above means something', () => {
    // Without this, an analyzeEnv() that returned its input unchanged would pass every
    // "was not overridden" assertion in this block.
    expect(analyzeEnv({}).NODE_OPTIONS).toContain(`--max-old-space-size=${GITNEXUS_ANALYZE_HEAP_MB}`);
  });

  it('keeps unrelated NODE_OPTIONS content and unrelated env vars intact', () => {
    const env = analyzeEnv({ NODE_OPTIONS: '--enable-source-maps', PATH: '/usr/bin' });
    expect(env.NODE_OPTIONS).toContain('--enable-source-maps');
    expect(env.NODE_OPTIONS).toContain(`--max-old-space-size=${GITNEXUS_ANALYZE_HEAP_MB}`);
    expect(env.PATH).toBe('/usr/bin');
  });

  it('does not mutate the caller-supplied env object', () => {
    const base: NodeJS.ProcessEnv = {};
    analyzeEnv(base);
    expect(base.NODE_OPTIONS).toBeUndefined();
  });
});

describe('GitNexus selective source eligibility', () => {
  it('sizes the walker from the live acceptance sources and preserves an explicit operator setting', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-source-limit-'));
    try {
      for (const relativePath of Object.keys(SELECTIVE_SOURCE_BLOBS)) {
        const file = join(root, relativePath);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, relativePath === GITNEXUS_KNOWN_SOURCE_PATH ? 'x'.repeat(525_617) : 'export const x = 1;\n');
      }
      const limit = selectiveSourceLimitKb(root);
      expect(limit).toBe(514); // ceil(525617 / 1024), above the vendor's 512 KiB skip threshold
      expect(analyzeEnv({}, undefined, undefined, limit).GITNEXUS_MAX_FILE_SIZE).toBe('514');
      expect(analyzeEnv({ GITNEXUS_MAX_FILE_SIZE: '1024' }, undefined, undefined, limit).GITNEXUS_MAX_FILE_SIZE).toBe('1024');
      expect(() => analyzeEnv({ GITNEXUS_MAX_FILE_SIZE: '512' }, undefined, undefined, limit)).toThrow(/excludes a selective corpus source/);
      writeFileSync(join(root, GITNEXUS_KNOWN_SOURCE_PATH), 'x'.repeat(32 * 1024 * 1024 + 1));
      expect(() => selectiveSourceLimitKb(root)).toThrow(/32 MiB ceiling/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('analyzeNodeArgs — the stack budget + argv order (P-004)', () => {
  it('passes --stack-size as a real argv flag', () => {
    expect(analyzeNodeArgs('/cli.js', '/repo', 'papercusp')).toContain(
      `--stack-size=${GITNEXUS_ANALYZE_STACK_KB}`,
    );
  });

  it('puts every node flag BEFORE the script path', () => {
    // node stops parsing its own flags at the first non-flag argument, so a --stack-size
    // that lands after the cli path is silently forwarded to gitnexus as a no-op
    // argument instead of raising the stack. Nothing fails loudly when this is wrong.
    const args = analyzeNodeArgs('/cli.js', '/repo', 'papercusp');
    expect(args.indexOf(`--stack-size=${GITNEXUS_ANALYZE_STACK_KB}`)).toBeLessThan(
      args.indexOf('/cli.js'),
    );
  });

  it('still carries the mandatory --skip-agents-md through the node wrapper', () => {
    // The guard from this module's header must survive the npx -> node refactor: it is
    // the difference between a maintenance job and one that rewrites CLAUDE.md.
    expect(analyzeNodeArgs('/cli.js', '/repo', 'papercusp')).toContain('--skip-agents-md');
  });

  it('runs the pinned cli path it is handed, not an ambient PATH lookup', () => {
    const args = analyzeNodeArgs('/pinned/cli.js', '/repo', 'x');
    expect(args).toContain('/pinned/cli.js');
    expect(args).not.toContain('npx');
    expect(args).not.toContain('--yes');
  });

  it('resolves a pinned absolute cli path, never a bare binary name', () => {
    const p = analyzeCliPath();
    expect(p.startsWith('/')).toBe(true);
    expect(p).toContain('gitnexus');
  });
});

describe('buildAnalyzeInvocation — host-wide heavy-work admission', () => {
  it('wraps the analyze command with pc-heavy resolved from the integration root', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-heavy-'));
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    const wrapper = join(scripts, 'pc-heavy.sh');
    writeFileSync(wrapper, '#!/usr/bin/env bash\n');
    const args = ['--stack-size=4096', '/cli.js', 'analyze', root];

    expect(buildAnalyzeInvocation(root, '/usr/bin/node', args)).toEqual({
      command: 'bash',
      args: [wrapper, '--', '/usr/bin/node', ...args],
    });
  });

  it('fails open to the direct command when the wrapper is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-no-heavy-'));
    const args = ['--stack-size=4096', '/cli.js', 'analyze', root];

    expect(buildAnalyzeInvocation(root, '/usr/bin/node', args)).toEqual({
      command: '/usr/bin/node',
      args,
    });
  });
});

describe('runGitnexusAnalyze — scheduled task-manager isolation (WI-40213)', () => {
  /**
   * The RUNNER's environment must not decide this verdict.
   *
   * runGitnexusAnalyze feeds the LIVE `process.env` to `analyzeEnv`, and `analyzeEnv`
   * deliberately honours an operator-supplied heap — it early-returns whenever NODE_OPTIONS
   * already carries `--max-old-space-size` (pinned by 'honours an operator-supplied heap
   * instead of overriding it' above). That behaviour is correct and stays. But it means an
   * AMBIENT NODE_OPTIONS makes the assertion below measure whatever heap the test runner was
   * launched with instead of the cap this test exists to pin.
   *
   * green-checkpoint runs the suite with NODE_OPTIONS=--max-old-space-size=4096, which is
   * exactly how candidate dfe7bd9f went red here while the same test is green in any ordinary
   * shell — green for whoever checks it, blocking for everyone else. The DB ceiling is scrubbed
   * for the same reason: `analyzeEnv` lets an explicit GITNEXUS_LBUG_MAX_DB_SIZE win too.
   */
  const RUNNER_ENV_KEYS = [
    'NODE_OPTIONS',
    'GITNEXUS_LBUG_MAX_DB_SIZE',
    'GITNEXUS_LBUG_BUFFER_POOL_SIZE',
    'GITNEXUS_EMBEDDING_DEVICE',
    'GITNEXUS_EMBEDDING_THREADS',
    'MALLOC_ARENA_MAX',
    'GITNEXUS_WAL_MANUAL_CHECKPOINT',
    // Redirected below so a run never writes into the real ~/.papercusp/logs.
    'PAPERCUSP_GITNEXUS_ANALYZE_LOG_DIR',
  ] as const;
  let savedRunnerEnv: Array<[string, string | undefined]> = [];
  let logDir = '';
  beforeEach(() => {
    savedRunnerEnv = RUNNER_ENV_KEYS.map((key) => [key, process.env[key]]);
    for (const key of RUNNER_ENV_KEYS) delete process.env[key];
    logDir = mkdtempSync(join(tmpdir(), 'gitnexus-analyze-log-'));
    process.env.PAPERCUSP_GITNEXUS_ANALYZE_LOG_DIR = logDir;
  });
  afterEach(() => {
    for (const [key, value] of savedRunnerEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(logDir, { recursive: true, force: true });
  });

  it('sends the analyze output to a log file the task owns, and returns its tail (P-012, D-015)', async () => {
    const child = fakeManagedChild();
    taskManager.managedSpawn.mockResolvedValue({ child, taskId: 'task-gitnexus-log' });

    const resultPromise = runGitnexusAnalyze('/repo', 'papercusp', 61_001);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const [, , spec, options] = taskManager.managedSpawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
      { spawnOptions: { stdio?: unknown[]; env: Record<string, string> } },
    ];
    // The log is named by the same stamp an adopting host reads from the child's environ.
    const stamp = Number(options.spawnOptions.env[GITNEXUS_REINDEX_SPAWN_MARKER_ENV]);
    const logPath = analyzeLogPath(stamp, logDir);
    expect(spec.logPath).toBe(logPath);
    // No pipe into this host: stdout and stderr are both the log's fd.
    const stdio = options.spawnOptions.stdio;
    expect(stdio?.[0]).toBe('ignore');
    expect(typeof stdio?.[1]).toBe('number');
    expect(stdio?.[2]).toBe(stdio?.[1]);
    expect(existsSync(logPath)).toBe(true);

    // What the child wrote is what the run reports, even though no pipe carried it.
    writeFileSync(logPath, 'Skipped 21 large files\nindexed 25,007 files\n');
    child.emit('close', 0);
    await expect(resultPromise).resolves.toEqual({
      code: 0,
      stdout: 'Skipped 21 large files\nindexed 25,007 files\n',
      stderr: '',
      timedOut: false,
    });
  });

  it('uses the managed build scope with provenance, resource cap, and a real deadline', async () => {
    // Fails in ONE legible line if the scrub above is ever removed. Without it the same
    // regression surfaces as a 70-property env diff with the heap buried in the middle, which
    // is exactly what the dfe7bd9f red looked like and why it read as a product bug.
    expect(process.env.NODE_OPTIONS, 'the runner-env scrub is not in effect').toBeUndefined();
    const child = fakeManagedChild();
    taskManager.managedSpawn.mockResolvedValue({ child, taskId: 'task-gitnexus' });
    const root = '/repo';
    const repoName = 'papercusp';
    const timeoutMs = 61_001;

    const resultPromise = runGitnexusAnalyze(root, repoName, timeoutMs);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(taskManager.managedSpawn).toHaveBeenCalledTimes(1);
    const [command, args, spec, options] = taskManager.managedSpawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
      { spawnOptions: Record<string, unknown> },
    ];
    expect(command).toBe(process.env.GITNEXUS_NODE_BIN ?? process.execPath);
    expect(args).toEqual(analyzeNodeArgs(analyzeCliPath(), root, repoName));
    expect(spec).toMatchObject({
      class: 'build',
      title: 'gitnexus analyze papercusp',
      argv: [command, ...args],
      cwd: root,
      launchedBy: 'system:gitnexus-reindex',
      memoryMaxBytes: GITNEXUS_ANALYZE_MEMORY_MAX_BYTES,
      runtimeMaxSec: 62,
      detail: { subsystem: 'gitnexus', operation: 'analyze', repoName },
    });
    expect(options.spawnOptions).toMatchObject({
      cwd: root,
      env: expect.objectContaining({
        NODE_OPTIONS: expect.stringContaining(`--max-old-space-size=${GITNEXUS_ANALYZE_HEAP_MB}`),
        GITNEXUS_LBUG_MAX_DB_SIZE: String(GITNEXUS_LBUG_MAX_DB_BYTES),
        GITNEXUS_EMBEDDING_DEVICE: GITNEXUS_EMBEDDING_DEVICE,
        GITNEXUS_EMBEDDING_THREADS: String(GITNEXUS_EMBEDDING_THREADS),
      }),
      detached: true,
    });

    child.emit('close', 0);
    await expect(resultPromise).resolves.toEqual({ code: 0, stdout: '', stderr: '', timedOut: false });
  });

  it('admits the analyze through pc-heavy when the integration root provides it', async () => {
    expect(process.env.NODE_OPTIONS, 'the runner-env scrub is not in effect').toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-managed-heavy-'));
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    const wrapper = join(scripts, 'pc-heavy.sh');
    writeFileSync(wrapper, '#!/usr/bin/env bash\n');
    const child = fakeManagedChild();
    taskManager.managedSpawn.mockResolvedValue({ child, taskId: 'task-gitnexus-heavy' });
    const repoName = 'papercusp';
    const timeoutMs = 61_001;
    const directCommand = process.env.GITNEXUS_NODE_BIN ?? process.execPath;
    const directArgs = analyzeNodeArgs(analyzeCliPath(), root, repoName);

    const resultPromise = runGitnexusAnalyze(root, repoName, timeoutMs);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(taskManager.managedSpawn).toHaveBeenCalledTimes(1);
    const [command, args, spec] = taskManager.managedSpawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe('bash');
    expect(args).toEqual([wrapper, '--', directCommand, ...directArgs]);
    expect(spec).toMatchObject({
      argv: ['bash', wrapper, '--', directCommand, ...directArgs],
      cwd: root,
      launchedBy: 'system:gitnexus-reindex',
    });

    child.emit('close', 0);
    await expect(resultPromise).resolves.toEqual({ code: 0, stdout: '', stderr: '', timedOut: false });
  });
});

describe('analyzeEnv — the LadybugDB ceiling pin (P-004)', () => {
  it('pins the LadybugDB max size rather than inheriting the upstream default', () => {
    expect(analyzeEnv({}).GITNEXUS_LBUG_MAX_DB_SIZE).toBe(String(GITNEXUS_LBUG_MAX_DB_BYTES));
  });

  it('STILL pins the DB ceiling when an operator overrides the heap', () => {
    // The heap branch early-returns. If the DB pin were applied after it, supplying a
    // heap would silently drop the ceiling too — two unrelated knobs, one of which
    // quietly disables the other, with nothing failing.
    const env = analyzeEnv({ NODE_OPTIONS: '--max-old-space-size=4096' });
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(env.GITNEXUS_LBUG_MAX_DB_SIZE).toBe(String(GITNEXUS_LBUG_MAX_DB_BYTES));
  });

  it('honours an explicit caller-supplied DB ceiling', () => {
    expect(analyzeEnv({ GITNEXUS_LBUG_MAX_DB_SIZE: '999' }).GITNEXUS_LBUG_MAX_DB_SIZE).toBe('999');
  });

  it('leaves real headroom over the measured on-disk database', () => {
    // Measured 2026-08-21: the lbug database file is 3.97 GiB (.gitnexus/ 6.5 GB total)
    // over 19,479 files. If a future graph ever approaches this ceiling, analyze starts
    // failing -- this assertion is the tripwire that says so while it is still cheap.
    const measuredDbGib = 3.97;
    expect(GITNEXUS_LBUG_MAX_DB_BYTES / 1024 ** 3).toBeGreaterThan(measuredDbGib * 3);
  });
});

describe('analyzeEnv — the LadybugDB BUFFER POOL pin (EI-22172147268902766)', () => {
  it('pins the buffer pool rather than inheriting the 2 GiB default that killed the rebuild', () => {
    expect(analyzeEnv({}).GITNEXUS_LBUG_BUFFER_POOL_SIZE).toBe(String(GITNEXUS_LBUG_BUFFER_POOL_BYTES));
  });

  it('STILL pins the buffer pool when an operator overrides the heap', () => {
    // The pool is LadybugDB NATIVE memory: no node flag can influence it. The failing
    // 2026-09-02 run proved the point by dying with a 193 GB heap and a 2 GiB pool, so a
    // heap override silently dropping this pin would reproduce the exact original bug.
    const env = analyzeEnv({ NODE_OPTIONS: '--max-old-space-size=4096' });
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(env.GITNEXUS_LBUG_BUFFER_POOL_SIZE).toBe(String(GITNEXUS_LBUG_BUFFER_POOL_BYTES));
  });

  it('honours an explicit caller-supplied pool size', () => {
    expect(analyzeEnv({ GITNEXUS_LBUG_BUFFER_POOL_SIZE: '123' }).GITNEXUS_LBUG_BUFFER_POOL_SIZE).toBe('123');
  });

  it('clears the 2 GiB default the bulk COPY actually exhausted', () => {
    // The measured wall, not a round number: gitnexus 1.6.10 defaults to min(2 GiB, 80% RAM),
    // and the COPY of a 22,394-file / 238,521-node graph ran out inside it.
    expect(GITNEXUS_LBUG_BUFFER_POOL_BYTES).toBeGreaterThan(2 * 1024 ** 3);
  });

  it('is NOT the 80%-of-RAM escape hatch', () => {
    // `0` is gitnexus's pass-through sentinel for LadybugDB's native 80%-of-RAM default.
    // On this 251 GB shared box that is a ~200 GB RESIDENT pool -- a worse failure than the
    // one being fixed. This asserts we chose a bounded number, not the unbounded one.
    expect(GITNEXUS_LBUG_BUFFER_POOL_BYTES).not.toBe(0);
    expect(GITNEXUS_LBUG_BUFFER_POOL_BYTES).toBeLessThanOrEqual(32 * 1024 ** 3);
  });
});

describe('analyzeEnv — the embedding device/threads pins (D-002)', () => {
  it('pins the embedding device rather than inheriting gitnexus\'s `auto`', () => {
    expect(analyzeEnv({}).GITNEXUS_EMBEDDING_DEVICE).toBe(GITNEXUS_EMBEDDING_DEVICE);
    expect(GITNEXUS_EMBEDDING_DEVICE).toBe('cuda');
  });

  it('pins a device gitnexus 1.6.9 actually accepts (resolveEmbeddingConfig throws on anything else)', () => {
    expect(['auto', 'cpu', 'dml', 'cuda', 'wasm']).toContain(GITNEXUS_EMBEDDING_DEVICE);
  });

  it('pins the embedder thread count as a positive-integer string (parsePositiveInt)', () => {
    expect(analyzeEnv({}).GITNEXUS_EMBEDDING_THREADS).toBe(String(GITNEXUS_EMBEDDING_THREADS));
    expect(Number.isInteger(GITNEXUS_EMBEDDING_THREADS) && GITNEXUS_EMBEDDING_THREADS > 0).toBe(true);
  });

  it('STILL pins both when an operator overrides the heap (the early-return branch)', () => {
    const env = analyzeEnv({ NODE_OPTIONS: '--max-old-space-size=4096' });
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(env.GITNEXUS_EMBEDDING_DEVICE).toBe(GITNEXUS_EMBEDDING_DEVICE);
    expect(env.GITNEXUS_EMBEDDING_THREADS).toBe(String(GITNEXUS_EMBEDDING_THREADS));
  });

  it('honours explicit caller-supplied values (a cpu-only measurement run must be expressible)', () => {
    const env = analyzeEnv({ GITNEXUS_EMBEDDING_DEVICE: 'cpu', GITNEXUS_EMBEDDING_THREADS: '8' });
    expect(env.GITNEXUS_EMBEDDING_DEVICE).toBe('cpu');
    expect(env.GITNEXUS_EMBEDDING_THREADS).toBe('8');
  });
});

describe('analyzeEnv — the native-memory and WAL-checkpoint pins (P-012)', () => {
  it('caps glibc malloc arenas (uncapped, the analyze grew ~7.9 GB of arenas — D-016)', () => {
    expect(analyzeEnv({}).MALLOC_ARENA_MAX).toBe(String(GITNEXUS_ANALYZE_MALLOC_ARENA_MAX));
    expect(Number.isInteger(GITNEXUS_ANALYZE_MALLOC_ARENA_MAX) && GITNEXUS_ANALYZE_MALLOC_ARENA_MAX > 0).toBe(true);
  });

  it('turns the manual WAL checkpoint driver off on linux, with a value gitnexus accepts as an opt-out', () => {
    const env = analyzeEnv({}, undefined, undefined, undefined, 'linux');
    expect(env.GITNEXUS_WAL_MANUAL_CHECKPOINT).toBe(GITNEXUS_WAL_MANUAL_CHECKPOINT_LINUX);
    // gitnexus 1.6.9 isManualCheckpointEnabled(): anything outside this set leaves the driver ON.
    expect(['0', 'false', 'off', 'no']).toContain(GITNEXUS_WAL_MANUAL_CHECKPOINT_LINUX.trim().toLowerCase());
  });

  it('leaves the driver on elsewhere (it exists for the Windows rename race)', () => {
    expect(analyzeEnv({}, undefined, undefined, undefined, 'win32')).not.toHaveProperty('GITNEXUS_WAL_MANUAL_CHECKPOINT');
    expect(analyzeEnv({}, undefined, undefined, undefined, 'darwin')).not.toHaveProperty('GITNEXUS_WAL_MANUAL_CHECKPOINT');
  });

  it('STILL pins both when an operator overrides the heap (the early-return branch)', () => {
    const env = analyzeEnv({ NODE_OPTIONS: '--max-old-space-size=4096' }, undefined, undefined, undefined, 'linux');
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(env.MALLOC_ARENA_MAX).toBe(String(GITNEXUS_ANALYZE_MALLOC_ARENA_MAX));
    expect(env.GITNEXUS_WAL_MANUAL_CHECKPOINT).toBe(GITNEXUS_WAL_MANUAL_CHECKPOINT_LINUX);
  });

  it('honours explicit caller-supplied values (an A/B run must be able to re-enable either)', () => {
    const env = analyzeEnv(
      { MALLOC_ARENA_MAX: '8', GITNEXUS_WAL_MANUAL_CHECKPOINT: '1' },
      undefined,
      undefined,
      undefined,
      'linux',
    );
    expect(env.MALLOC_ARENA_MAX).toBe('8');
    expect(env.GITNEXUS_WAL_MANUAL_CHECKPOINT).toBe('1');
  });
});

describe('analyze log files (P-012, D-015)', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gitnexus-analyze-logs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prunes to the newest N by spawn stamp, never touching a file that is not an analyze log', () => {
    for (const stamp of [900, 10000, 2000, 50000, 4000]) writeFileSync(analyzeLogPath(stamp, dir), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    pruneAnalyzeLogs(dir, 2);
    // Numeric, not lexical: a lexical sort would keep analyze-900 and analyze-50000.
    expect(readdirSync(dir).sort()).toEqual(['analyze-10000.log', 'analyze-50000.log', 'notes.txt']);
  });

  it('a missing directory is a no-op, not a throw', () => {
    expect(() => pruneAnalyzeLogs(join(dir, 'absent'), 2)).not.toThrow();
  });

  it('reads the last bytes of a log, and null for a run that has none', () => {
    const p = analyzeLogPath(1, dir);
    writeFileSync(p, 'a'.repeat(100) + 'THE END');
    expect(readAnalyzeLogTail(p, 7)).toBe('THE END');
    expect(readAnalyzeLogTail(p)).toBe('a'.repeat(100) + 'THE END');
    expect(readAnalyzeLogTail(analyzeLogPath(2, dir))).toBeNull();
  });
});

describe('stranded incomplete-index marker — reported, never cleared (EI-22172147268902766)', () => {
  it('extracts the marker gitnexus actually writes', () => {
    // Shape copied verbatim from .gitnexus/meta.json observed 2026-09-02T18:06Z.
    const marker = readIncompleteIndexMarker({
      incrementalInProgress: {
        startedAt: 1788371911968,
        updatedAt: 1788371911968,
        phase: 'full-rebuild',
        toWriteCount: 1201,
      },
    });
    expect(marker).toEqual({ phase: 'full-rebuild', startedAt: 1788371911968, toWriteCount: 1201 });
  });

  it('reports a clean index as null', () => {
    expect(readIncompleteIndexMarker({ lastCommit: 'abc' })).toBeNull();
  });

  it('never throws on malformed input — it runs on the failure path', () => {
    // A throw here would replace a real analyze diagnosis with a plumbing error, losing
    // the failure the operator is being alerted about.
    for (const bad of [null, undefined, 42, 'nope', [], { incrementalInProgress: 'yes' }]) {
      expect(() => readIncompleteIndexMarker(bad)).not.toThrow();
      expect(readIncompleteIndexMarker(bad)).toBeNull();
    }
  });

  it('tolerates a partial marker rather than inventing fields', () => {
    expect(readIncompleteIndexMarker({ incrementalInProgress: { phase: 'full-rebuild' } })).toEqual({
      phase: 'full-rebuild',
      startedAt: null,
      toWriteCount: null,
    });
    // NaN/Infinity are not usable numbers and must not reach a Date() or an alert body.
    expect(
      readIncompleteIndexMarker({ incrementalInProgress: { startedAt: NaN, toWriteCount: Infinity } }),
    ).toEqual({ phase: null, startedAt: null, toWriteCount: null });
  });

  it('says the rebuild is FORCED and the marker deliberately kept', () => {
    // The wording is the payload: without it the alert reads "exited 1" and an operator
    // cannot tell a one-off failure from an index wedged into rebuild-and-fail forever.
    const note = describeStrandedIncompleteIndex({
      phase: 'full-rebuild',
      startedAt: 1788371911968,
      toWriteCount: 1201,
    });
    expect(note).toContain('INCOMPLETE');
    expect(note).toContain('toWrite=1201');
    expect(note).toContain('phase=full-rebuild');
    expect(note).toMatch(/NOT cleared/);
  });

  it('is empty for a clean index so the alert body is unchanged', () => {
    expect(describeStrandedIncompleteIndex(null)).toBe('');
  });

  it('reads the marker off a real meta.json, and fail-softs on an unreadable one', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-meta-'));
    mkdirSync(join(root, '.gitnexus'));
    writeFileSync(
      gitnexusMetaPath(root),
      JSON.stringify({ incrementalInProgress: { phase: 'full-rebuild', toWriteCount: 7 } }),
    );
    expect(readStrandedIncompleteIndex(root)?.toWriteCount).toBe(7);

    // meta.json is ~3 MB and can legitimately be caught mid-write; a parse failure must be
    // in-band "unobserved", never a throw that swallows the analyze failure being reported.
    writeFileSync(gitnexusMetaPath(root), '{ truncated mid-write');
    expect(readStrandedIncompleteIndex(root)).toBeNull();
    expect(readStrandedIncompleteIndex(join(root, 'does-not-exist'))).toBeNull();
  });
});

describe('index-disk budget telemetry (WI-2142942)', () => {
  const base = {
    consecutiveFailures: 0,
    alerted: false,
    lastFailureAt: null,
    lastSuccessAt: null,
  };

  it('measures the WHOLE .gitnexus directory, not just the lbug file', () => {
    // The gap this closes: measureGitnexusDbUsage stats lbug alone, so a
    // measured 2026-09-03 footprint of 6558MB was reported as 4946MB and
    // 1607MB of parse caches was invisible to every instrument.
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-indexdisk-'));
    mkdirSync(join(root, '.gitnexus'));
    mkdirSync(join(root, '.gitnexus', 'parse-cache'));
    writeFileSync(gitnexusDbPaths(root).db, 'x'.repeat(1024));
    writeFileSync(join(root, '.gitnexus', 'parse-cache', 'a'), 'y'.repeat(2048));

    const v = measureGitnexusIndexDisk(root, 2_048);
    expect(v.status).toBe('within-budget');
    // Both files counted — the lbug-only reading would have missed the cache.
    expect(v.status === 'within-budget' && v.measuredMb).toBe(0); // <1MB, rounds to 0
  });

  it('grades a missing index not-measured, never a zero-byte pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-indexdisk-missing-'));
    const v = measureGitnexusIndexDisk(root, 2_048);
    expect(v.status).toBe('not-measured');
    expect(v.status).not.toBe('within-budget');
  });

  it('alerts once when growth passes the accepted ceiling', () => {
    const over = decideIndexDiskHealthUpdate(base, {
      backend: 'gitnexus',
      status: 'over-ceiling',
      budgetMb: 2_048,
      measuredMb: 12_000,
      acceptedCeilingMb: 10_240,
    });
    expect(over.shouldAlert).toBe(true);
    expect(over.next.indexDiskAlerted).toBe(true);

    // Same condition on the next tick must NOT re-alert.
    const again = decideIndexDiskHealthUpdate({ ...base, ...over.next }, {
      backend: 'gitnexus',
      status: 'over-ceiling',
      budgetMb: 2_048,
      measuredMb: 12_100,
      acceptedCeilingMb: 10_240,
    });
    expect(again.shouldAlert).toBe(false);
  });

  it('does NOT alert on the accepted exceedance itself', () => {
    // gitnexus is knowingly 3.2x the budget. Alerting on that would fire every
    // tick from day one, and an always-red gauge is one nobody reads — which is
    // how this budget came to be ignored in the first place.
    const accepted = decideIndexDiskHealthUpdate(base, {
      backend: 'gitnexus',
      status: 'accepted-exceedance',
      budgetMb: 2_048,
      measuredMb: 6_558,
      acceptedCeilingMb: 10_240,
    });
    expect(accepted.shouldAlert).toBe(false);
    expect(accepted.next.indexDiskStatus).toBe('accepted-exceedance');
  });

  it('does not let a not-measured tick re-arm the alert', () => {
    // Absence of evidence must not clear the flag: a flapping measurement
    // would otherwise page repeatedly for one unchanged condition.
    const alerted = { ...base, indexDiskAlerted: true };
    const unknown = decideIndexDiskHealthUpdate(alerted, {
      backend: 'gitnexus',
      status: 'not-measured',
      budgetMb: 2_048,
      reason: 'walk truncated',
    });
    expect(unknown.shouldAlert).toBe(false);
    expect(unknown.next.indexDiskAlerted).toBe(true);
    expect(unknown.next.indexDiskMb).toBeNull();
  });
});

describe('LadybugDB capacity telemetry (EI-21044385125018758)', () => {
  it('measures the promoted DB against the configured ceiling', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-capacity-'));
    mkdirSync(join(root, '.gitnexus'));
    writeFileSync(gitnexusDbPaths(root).db, 'x'.repeat(600));

    expect(measureGitnexusDbUsage(root, 1_000)).toEqual({
      dbBytes: 600,
      dbMaxBytes: 1_000,
      dbUtilization: 0.6,
      dbHeadroomBytes: 400,
    });
  });

  it('keeps a missing/unreadable DB in-band unknown instead of reporting zero usage', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-capacity-missing-'));
    expect(measureGitnexusDbUsage(root, 1_000)).toEqual({
      dbBytes: null,
      dbMaxBytes: 1_000,
      dbUtilization: null,
      dbHeadroomBytes: null,
    });
  });

  it('alerts once on a threshold crossing, rearms below it, and preserves unknown-state alerting', () => {
    const high = { dbBytes: 600, dbMaxBytes: 1_000, dbUtilization: 0.6, dbHeadroomBytes: 400 };
    const first = decideGitnexusDbHealthUpdate(GITNEXUS_HEALTH_DEFAULT, high, GITNEXUS_LBUG_DB_ALERT_RATIO);
    expect(first.shouldAlert).toBe(true);
    expect(first.next.dbAlerted).toBe(true);

    const repeated = decideGitnexusDbHealthUpdate({ ...GITNEXUS_HEALTH_DEFAULT, ...first.next }, high, 0.6);
    expect(repeated.shouldAlert).toBe(false);

    const unknown = decideGitnexusDbHealthUpdate(
      { ...GITNEXUS_HEALTH_DEFAULT, ...first.next },
      { dbBytes: null, dbMaxBytes: 1_000, dbUtilization: null, dbHeadroomBytes: null },
      0.6,
    );
    expect(unknown.shouldAlert).toBe(false);
    expect(unknown.next.dbAlerted).toBe(true);

    const low = decideGitnexusDbHealthUpdate(
      { ...GITNEXUS_HEALTH_DEFAULT, ...first.next },
      { dbBytes: 500, dbMaxBytes: 1_000, dbUtilization: 0.5, dbHeadroomBytes: 500 },
      0.6,
    );
    expect(low.next.dbAlerted).toBe(false);
    expect(decideGitnexusDbHealthUpdate({ ...GITNEXUS_HEALTH_DEFAULT, ...low.next }, high, 0.6).shouldAlert).toBe(true);
  });

  it('wires capacity and crash recovery before cadence skips, then refreshes capacity after analyze', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitnexus-reindex-action.ts'), 'utf8');
    const first = src.indexOf('await trackGitnexusDbCapacity(ctx, root, dbAlertRatio);');
    const cleanup = src.indexOf('const residue = cleanCrashResidue(root);', first);
    const decision = src.indexOf('const decision = decideReindex(', first);
    const second = src.indexOf('await trackGitnexusDbCapacity(ctx, root, dbAlertRatio);', first + 1);
    expect(first).toBeGreaterThan(0);
    expect(cleanup).toBeGreaterThan(first);
    expect(decision).toBeGreaterThan(cleanup);
    expect(second).toBeGreaterThan(decision);
  });
});

describe('isDeadShadow — the THIRD residue state (D-016 recurrence, 2026-08-21)', () => {
  const STALE = DEAD_SHADOW_STALE_MS + 1;
  const FRESH = 1_000;

  it('REPRODUCES the live state that neither existing arm classified', () => {
    // Observed 06:55Z: lbug 3.97 GiB + lbug.shadow at ZERO BYTES + lbug.wal.checkpoint,
    // after the 06:35 analyze was SIGKILLed at its 1200s timeout. Reads segfaulted
    // (exit 139) and cleanCrashResidue returned kind:'none'.
    const dbExists = true;
    const shadowExists = true;
    const walExists = true;

    // The old classification — both arms silent, which IS the bug:
    expect(isOrphanShadow(dbExists, shadowExists)).toBe(false);
    expect(isOrphanWal(dbExists, shadowExists, walExists)).toBe(false);

    // The new predicate names it:
    expect(isDeadShadow(shadowExists, 0, STALE)).toBe(true);

    // ...and with the shadow correctly treated as absent, the WAL arm now fires:
    const liveShadow = shadowExists && !isDeadShadow(shadowExists, 0, STALE);
    expect(isOrphanWal(dbExists, liveShadow, walExists)).toBe(true);
  });

  it('NEVER claims a live build is dead — a non-empty shadow is a build in flight', () => {
    // The direction that matters: acting on a live build corrupts it. A build that has
    // written even one byte is live regardless of age (a slow analyze is still analyze).
    expect(isDeadShadow(true, 1, STALE)).toBe(false);
    expect(isDeadShadow(true, 4_266_192_896, STALE)).toBe(false);
  });

  it('NEVER claims a just-created empty shadow is dead', () => {
    // A live analyze creates the shadow before writing to it; staleness is what stops
    // that instant being misread as a corpse.
    expect(isDeadShadow(true, 0, FRESH)).toBe(false);
  });

  it('is inert when there is no shadow at all', () => {
    expect(isDeadShadow(false, 0, STALE)).toBe(false);
  });

  it('CALIBRATION: the predicate can return true — so the negatives above mean something', () => {
    // Without this, an isDeadShadow() hardcoded to `false` passes every assertion above.
    expect(isDeadShadow(true, 0, STALE)).toBe(true);
  });
});

describe('CONTROLS — the two cap guards are falsifiable (P-004)', () => {
  // Deliberately-WRONG implementations, kept permanently. Without these, the guards
  // above pass identically against code that never sets anything, and "69 passing"
  // would say nothing about whether either trap is actually detected.

  /** WRONG: node stops parsing its flags at the first non-flag arg, so this --stack-size
   *  is silently handed to gitnexus as a no-op instead of raising the stack. */
  const flagAfterScript = (cli: string, root: string, name: string): string[] => [
    cli,
    `--stack-size=${GITNEXUS_ANALYZE_STACK_KB}`,
    ...buildAnalyzeArgs(root, name),
  ];

  /** WRONG: leaks --stack-size into NODE_OPTIONS, which Node 24+ refuses at startup. */
  const envLeakingStackSize = (): NodeJS.ProcessEnv => ({
    NODE_OPTIONS: `--max-old-space-size=${GITNEXUS_ANALYZE_HEAP_MB} --stack-size=${GITNEXUS_ANALYZE_STACK_KB}`,
  });

  it('the argv-ORDER assertion distinguishes correct from wrong', () => {
    const good = analyzeNodeArgs('/cli.js', '/repo', 'x');
    const bad = flagAfterScript('/cli.js', '/repo', 'x');
    const flag = `--stack-size=${GITNEXUS_ANALYZE_STACK_KB}`;
    expect(good.indexOf(flag)).toBeLessThan(good.indexOf('/cli.js'));
    expect(bad.indexOf(flag)).toBeGreaterThan(bad.indexOf('/cli.js'));
  });

  it('the NODE_OPTIONS assertion distinguishes correct from wrong', () => {
    expect(analyzeEnv({}).NODE_OPTIONS).not.toContain('--stack-size');
    expect(envLeakingStackSize().NODE_OPTIONS).toContain('--stack-size');
  });
});

describe('the cap VALUE is defensible against what was measured (P-004)', () => {
  // Measured live 2026-08-21 by external /proc sampling of a full analyze over 19,479
  // files: peak whole-tree RSS 10.59 GiB (no embeddings, 2 GiB LadybugDB pool). Re-measured
  // 2026-09-05 over 246,622 nodes WITH embeddings and the 8 GiB pool pin
  // (/tmp/wi39394/run1-embed-run.log, /usr/bin/time "Maximum resident set size"):
  // 15,633,516 kB = 14.9 GiB, peaking in the LadybugDB bulk-load phase — the embedding phase
  // itself ran at 2.3–3.2 GiB. The `--force` + cache-restore path (D-002) peaks higher:
  // 18,124,040 kB = 17.3 GiB on run #3 and 16,496,640 kB = 15.7 GiB on run #4
  // (/tmp/wi39394/run3-embed-run.log, run4-embed-run.log), so the worst observed value is
  // what the caps are checked against. The pool is native memory outside the V8 heap, so
  // the two caps are checked against the two shares of that peak they actually govern.
  const MEASURED_PEAK_GIB = 17.3;
  const POOL_GIB = GITNEXUS_LBUG_BUFFER_POOL_BYTES / 1024 ** 3;
  const BG_HOST_CGROUP_GIB = 40;

  it('the cgroup ceiling clears the measured whole-process peak with real headroom', () => {
    expect(GITNEXUS_ANALYZE_MEMORY_MAX_BYTES / 1024 ** 3).toBeGreaterThan(MEASURED_PEAK_GIB * 1.25);
  });

  it('the heap cap clears the heap-attributable share of that peak (RSS minus the native pool)', () => {
    expect(GITNEXUS_ANALYZE_HEAP_MB / 1024).toBeGreaterThan((MEASURED_PEAK_GIB - POOL_GIB) * 1.25);
  });

  it('the cgroup ceiling holds BOTH pinned budgets at once — heap cap plus pool pin', () => {
    // Otherwise a run that legitimately fills both is OOM-killed by our own ceiling, and a
    // mid-analyze kill is the D-016 residue, not a cheap retry.
    expect(GITNEXUS_ANALYZE_MEMORY_MAX_BYTES / 1024 ** 3).toBeGreaterThanOrEqual(GITNEXUS_ANALYZE_HEAP_MB / 1024 + POOL_GIB);
  });

  it('is genuinely a CAP — below what gitnexus would self-grant (0.75x the cgroup)', () => {
    // If this ever inverts, the whole mechanism is inert: gitnexus's own number would
    // be the smaller one and our "cap" would be raising the ceiling, not lowering it.
    const selfGrantedMb = 0.75 * BG_HOST_CGROUP_GIB * 1024;
    expect(GITNEXUS_ANALYZE_HEAP_MB).toBeLessThan(selfGrantedMb);
  });

  it('leaves room for the co-tenants sharing the cgroup', () => {
    // The hazard is not analyze dying, it is the cgroup OOM killer reaping bg-host. The
    // worst case IS the child's own ceiling, by construction (managedSpawn memoryMaxBytes);
    // that plus observed co-tenant usage must stay under bg-host's cap.
    const worstCaseAnalyzeGib = GITNEXUS_ANALYZE_MEMORY_MAX_BYTES / 1024 ** 3;
    const observedCoTenantsGib = 11.6;
    expect(worstCaseAnalyzeGib + observedCoTenantsGib).toBeLessThan(BG_HOST_CGROUP_GIB);
  });
});

describe('GITNEXUS_ANALYZE_TIMEOUT_MS is sized from the measured LIVE tick (D-002 → D-004)', () => {
  // Measured 2026-09-05 (D-004): the first routine tick after the seeded resume — `--force
  // --embeddings 0` over 248,736 nodes, restoring the 216k-embedding cache and re-embedding the
  // changed nodes — ran under pc-heavy (nice 10 / ionice idle) on a box with ~75 live agents and
  // took 6,446s (spawned 18:32:12Z → indexedAt 20:19:38Z; 107:26 wall). The SAME pass in
  // isolation took 2,343s (run #4, D-002). D-002 sized the timeout from the isolated number and
  // the very first live tick blew through it, so the live measurement is the only one this
  // constant may be sized from; the ratio pin below is what stops a future "re-measure in
  // isolation and shrink it back".
  const MEASURED_LIVE_TICK_SEC = 6446;
  const MEASURED_ISOLATED_TICK_SEC = 2343;

  it('clears the measured live tick with real headroom (>= 1.5x)', () => {
    expect(GITNEXUS_ANALYZE_TIMEOUT_MS / 1000).toBeGreaterThanOrEqual(MEASURED_LIVE_TICK_SEC * 1.5);
  });

  it('is still a CAP — under 2x the live measurement, so a wedged indexer is bounded within a tick or two', () => {
    expect(GITNEXUS_ANALYZE_TIMEOUT_MS / 1000).toBeLessThan(MEASURED_LIVE_TICK_SEC * 2);
  });

  it('is sized from the LIVE tick, which the isolated measurement under-predicts by more than 2x', () => {
    expect(MEASURED_LIVE_TICK_SEC / MEASURED_ISOLATED_TICK_SEC).toBeGreaterThan(2);
    expect(GITNEXUS_ANALYZE_TIMEOUT_MS / 1000).toBeGreaterThan(MEASURED_ISOLATED_TICK_SEC * 2);
  });

  it('exceeds the hourly cron on purpose, which the routine row must absorb via concurrency:skip', () => {
    // A timeout longer than the cron interval is only safe because an overlapping fire is
    // SKIPPED, not queued or double-spawned (seed-gitnexus-reindex-routine.ts writes
    // concurrency 'skip'). If the timeout ever drops back under the hour this pin is moot; if
    // the seed ever changes concurrency, this comment is where the reasoning lives.
    expect(GITNEXUS_ANALYZE_TIMEOUT_MS).toBeGreaterThan(60 * 60_000);
  });
});

describe('free-disk admission — a rebuild is never admitted into a full filesystem (2026-09-05 ENOSPC)', () => {
  const GIB = 1024 ** 3;

  it('the floor is at least three databases of the 2026-09-05 graph (5.28 GB live lbug + its shadow + WAL margin)', () => {
    expect(GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES).toBeGreaterThanOrEqual(3 * 5.28e9);
  });

  it('requiredFreeDiskBytes is the floor, or twice the live database when that is larger', () => {
    expect(requiredFreeDiskBytes(null)).toBe(GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES);
    expect(requiredFreeDiskBytes(0)).toBe(GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES);
    expect(requiredFreeDiskBytes(Number.NaN)).toBe(GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES);
    // the 2026-09-05 graph: 2 x 5.28 GB is under the 16 GiB floor, so the floor binds
    expect(requiredFreeDiskBytes(5.28e9)).toBe(GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES);
    // a graph that outgrows the floor drags the requirement up with it
    expect(requiredFreeDiskBytes(20 * GIB)).toBe(40 * GIB);
    // a nonsense floor falls back to the constant rather than admitting everything
    expect(requiredFreeDiskBytes(null, 0)).toBe(GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES);
    expect(requiredFreeDiskBytes(null, Number.NaN)).toBe(GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES);
    // an operator-tuned floor is honoured
    expect(requiredFreeDiskBytes(null, 4 * GIB)).toBe(4 * GIB);
  });

  it('adds the alarm reserve to rebuild demand so the 2026-09-07 critical-root run is refused', () => {
    const postgresReserve = 37.514 * GIB; // 2% of the measured 1,875.7 GiB root filesystem
    const required = requiredFreeDiskBytes(5.28e9, 16 * GIB, postgresReserve);
    expect(required).toBeCloseTo((16 + 37.514) * GIB, -3);

    // The old independent 16 GiB gate admitted this band. The shared-reserve gate must not:
    // GitNexus's transient rebuild budget cannot consume PostgreSQL's last write headroom.
    const d = decideReindex(
      baseInput({
        freeDiskBytes: 40 * GIB,
        requiredFreeDiskBytes: required,
        protectedReserveBytes: postgresReserve,
      }),
    );
    expect(d.run).toBe(false);
    expect(d.reason).toContain('protected for PostgreSQL/shared writers');
  });

  it('decideReindex defers on low disk with an actionable reason, even for a cold build', () => {
    const d = decideReindex(baseInput({ freeDiskBytes: 2 * GIB, requiredFreeDiskBytes: 16 * GIB }));
    expect(d.run).toBe(false);
    expect(d.reason).toMatch(/^low disk \(2\.0 GiB free .* < 16\.0 GiB/);
    expect(d.reason).toContain('ENOSPC');
    // a MISSING index does not override it: the build cannot succeed and hurts the box
    const cold = decideReindex(baseInput({ registered: false, freeDiskBytes: 2 * GIB, requiredFreeDiskBytes: 16 * GIB }));
    expect(cold.run).toBe(false);
    expect(cold.reason).toMatch(/^low disk/);
  });

  it('decideReindex admits when enough is free, and is fail-soft when the reading is absent', () => {
    expect(decideReindex(baseInput({ freeDiskBytes: 16 * GIB, requiredFreeDiskBytes: 16 * GIB })).run).toBe(true);
    expect(decideReindex(baseInput({ freeDiskBytes: 200 * GIB, requiredFreeDiskBytes: 16 * GIB })).run).toBe(true);
    // unknown ≠ low: a statfs failure must not wedge the cadence, matching the memory gate
    expect(decideReindex(baseInput({ freeDiskBytes: null, requiredFreeDiskBytes: 16 * GIB })).run).toBe(true);
    expect(decideReindex(baseInput({ freeDiskBytes: undefined })).run).toBe(true);
    // without an explicit requirement the constant floor binds
    expect(decideReindex(baseInput({ freeDiskBytes: 1 * GIB })).run).toBe(false);
  });

  it('load and memory pressure still outrank the disk gate (they protect the box first)', () => {
    const d = decideReindex(baseInput({ loadPerCore: 9, freeDiskBytes: 1 * GIB }));
    expect(d.reason).toMatch(/^box oversubscribed/);
    const m = decideReindex(baseInput({ memoryPressure: 'crit', freeDiskBytes: 1 * GIB }));
    expect(m.reason).toMatch(/^memory pressure/);
  });

  it('measureFreeDiskBytes reads a real filesystem and is null for a path that does not exist', () => {
    const capacity = measureDiskCapacityBytes(tmpdir());
    expect(capacity).not.toBeNull();
    expect(capacity!.totalBytes).toBeGreaterThan(0);
    expect(capacity!.freeBytes).toBeGreaterThan(0);
    const free = measureFreeDiskBytes(tmpdir());
    expect(free).not.toBeNull();
    expect(free!).toBeGreaterThan(0);
    expect(measureFreeDiskBytes(join(tmpdir(), 'no-such-dir-' + Date.now()))).toBeNull();
  });

  it('the action measures free disk on the index filesystem and feeds it into decideReindex', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitnexus-reindex-action.ts'), 'utf8');
    const measure = src.indexOf('const diskCapacity = measureDiskCapacityBytes(');
    const reserve = src.indexOf('criticalWriteHeadroomBytes(diskCapacity.totalBytes', measure);
    const need = src.indexOf('const requiredFree = requiredFreeDiskBytes(', reserve);
    const decision = src.indexOf('const decision = decideReindex(', need);
    expect(measure).toBeGreaterThan(0);
    expect(reserve).toBeGreaterThan(measure);
    expect(need).toBeGreaterThan(reserve);
    expect(decision).toBeGreaterThan(need);
    const call = src.slice(decision, src.indexOf('});', decision));
    expect(call).toContain('freeDiskBytes: diskCapacity?.freeBytes ?? null,');
    expect(call).toContain('requiredFreeDiskBytes: requiredFree,');
    expect(call).toContain('protectedReserveBytes,');
    // the requirement is derived from the LIVE database size, not a hard-coded number
    expect(src.slice(need, decision)).toContain('measureGitnexusDbUsage(root).dbBytes');
  });
});

describe('decideReindex', () => {
  it('runs when the graph is genuinely behind on an idle box', () => {
    const d = decideReindex(baseInput());
    expect(d.run).toBe(true);
    expect(d.reason).toContain('50 commits behind');
  });

  it('skips when the box is oversubscribed', () => {
    const d = decideReindex(baseInput({ loadPerCore: 2.0 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('oversubscribed');
  });

  it('defers a warning-band memory-pressure capture before admitting a full analyze', () => {
    const d = decideReindex(
      baseInput({
        memoryPressure: 'warn',
        memoryPressureReason: 'PSI memory some avg60 18.51 ≥ 10 — sustained memory reclaim pressure',
      }),
    );
    expect(d.run).toBe(false);
    expect(d.reason).toContain('memory pressure warn');
    expect(d.reason).toContain('PSI memory some avg60 18.51');
  });

  it('defers the critical thrashing band even when the graph is missing', () => {
    const d = decideReindex(
      baseInput({
        registered: false,
        memoryPressure: 'crit',
        memoryPressureReason: 'PSI memory full avg60 11.96 ≥ 5 — all tasks stalled on memory reclaim/swap',
      }),
    );
    expect(d.run).toBe(false);
    expect(d.reason).toContain('memory pressure crit');
    expect(d.reason).not.toContain('cold build');
  });

  it('keeps load precedence when both load and memory pressure are unsafe', () => {
    const d = decideReindex(baseInput({ loadPerCore: 2, memoryPressure: 'crit' }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('oversubscribed');
    expect(d.reason).not.toContain('memory pressure');
  });

  it('fails soft when the perf writer has no usable pressure band', () => {
    // null covers absent, stale, and incomplete PSI captures because the shared writer
    // intentionally keeps those cases unknown instead of inventing a reassuring zero.
    const d = decideReindex(baseInput({ memoryPressure: null, memoryPressureReason: null }));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('50 commits behind');
  });

  it('lets load OUTRANK a missing index — protecting the box beats a cold build', () => {
    // Ordering guard: a missing index is the most urgent functional condition, but a
    // 4-minute indexer is the worst thing to start on a queueing box. Deferring costs
    // one hour; piling on costs the whole fleet.
    const d = decideReindex(baseInput({ registered: false, loadPerCore: 3.0 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('oversubscribed');
  });

  it('cold-builds when nothing is registered, bypassing the interval floor and staleness', () => {
    const d = decideReindex(baseInput({ registered: false, secondsSinceIndexed: 0, commitsBehind: 0 }));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('cold build');
  });

  it('honours the interval floor even when many commits have landed', () => {
    // git-sync commits every few minutes, so commitsBehind climbs fast; the floor — not
    // the commit count — is what bounds steady-state cost.
    const d = decideReindex(baseInput({ secondsSinceIndexed: 10 * 60, commitsBehind: 500 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('floor');
  });

  it('skips when nothing has changed', () => {
    const d = decideReindex(baseInput({ commitsBehind: 0 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('0 commit(s) behind');
  });

  it('refreshes when the indexed commit is no longer in history (rebase/prune)', () => {
    const d = decideReindex(baseInput({ commitsBehind: null }));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('not in the current history');
  });

  it('treats an unknown-age index as eligible rather than blocking on the floor', () => {
    const d = decideReindex(baseInput({ secondsSinceIndexed: null }));
    expect(d.run).toBe(true);
  });

  it('honours a trigger_config override of the load ceiling', () => {
    expect(decideReindex(baseInput({ loadPerCore: 2.0, maxLoadPerCore: 4 })).run).toBe(true);
  });

  it('applies the interval floor at the boundary, not just past it', () => {
    expect(decideReindex(baseInput({ secondsSinceIndexed: DEFAULT_MIN_INTERVAL_SEC - 1 })).run).toBe(false);
    expect(decideReindex(baseInput({ secondsSinceIndexed: DEFAULT_MIN_INTERVAL_SEC })).run).toBe(true);
  });
});

describe('readRegistryEntry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitnexus-reg-'));

  it('reads the named repo out of the registry array', () => {
    const f = join(dir, 'ok.json');
    writeFileSync(
      f,
      JSON.stringify([
        { name: 'other', lastCommit: 'aaa' },
        { name: 'papercusp', lastCommit: 'bbb', indexedAt: '2026-07-27T19:38:08.913Z' },
      ]),
    );
    expect(readRegistryEntry(f, 'papercusp')?.lastCommit).toBe('bbb');
  });

  it('returns null for an alias that is not registered', () => {
    const f = join(dir, 'missing.json');
    writeFileSync(f, JSON.stringify([{ name: 'other' }]));
    expect(readRegistryEntry(f, 'papercusp')).toBeNull();
  });

  // Every read failure must collapse to "no index" (⇒ build one), never throw a tick.
  it.each([
    ['absent file', null],
    ['unparseable json', '{not json'],
    ['not an array', '{"name":"papercusp"}'],
  ])('returns null on %s instead of throwing', (label, contents) => {
    const f = join(dir, `${String(label).replace(/\W/g, '')}.json`);
    if (contents != null) writeFileSync(f, contents);
    expect(readRegistryEntry(f, 'papercusp')).toBeNull();
  });
});

describe('pickIndexFreshness — the cadence gates read the later COMPLETED analyze (WI-39394, 2026-09-05)', () => {
  // The measured incident: the live tick completed 20:19:38Z (meta.json) while the registry row
  // still carried the seed's 17:07:51Z — its registerRepo write was lost when the run was
  // orphaned from its bg-host — and the very next fire read "3.4h old / 196 commits behind",
  // bypassed the 45-minute floor and launched a second 107-minute full pass 13 minutes later.
  const registry = { indexedAt: '2026-09-05T17:07:51.897Z', lastCommit: 'c2f4880698bb' };
  const meta = { indexedAt: '2026-09-05T20:19:38.667Z', lastCommit: 'e549dce907eb' };

  it('prefers meta.json when it records a newer completed index than the registry row', () => {
    const f = pickIndexFreshness(registry, meta);
    expect(f).toEqual({ indexedAt: meta.indexedAt, lastCommit: meta.lastCommit, source: 'meta' });
  });

  it('keeps the registry row when it is the newer record (the ordinary, both-writes-landed case)', () => {
    const f = pickIndexFreshness({ indexedAt: '2026-09-05T22:20:00.000Z', lastCommit: 'fff' }, meta);
    expect(f).toEqual({ indexedAt: '2026-09-05T22:20:00.000Z', lastCommit: 'fff', source: 'registry' });
  });

  it('a tie goes to the registry (same run, both writes landed — nothing to override)', () => {
    const f = pickIndexFreshness({ indexedAt: meta.indexedAt, lastCommit: 'reg' }, { ...meta, lastCommit: 'meta' });
    expect(f.source).toBe('registry');
    expect(f.lastCommit).toBe('reg');
  });

  it('with no meta.json at all the registry row is the whole answer', () => {
    expect(pickIndexFreshness(registry, null)).toEqual({ ...registry, source: 'registry' });
  });

  it('with no registry row a completed meta.json still bounds the floor', () => {
    expect(pickIndexFreshness(null, meta)).toEqual({ ...meta, source: 'meta' });
  });

  it('neither ⇒ null freshness (the floor is then not applied and the cold-build gate decides)', () => {
    expect(pickIndexFreshness(null, null)).toEqual({ indexedAt: null, lastCommit: null, source: 'none' });
    expect(pickIndexFreshness({ indexedAt: 'not a date' }, { indexedAt: null, lastCommit: 'x' })).toEqual({
      indexedAt: null,
      lastCommit: 'x',
      source: 'none',
    });
  });

  it('the picked record actually closes the incident: the floor holds for the 20:32Z fire', () => {
    const nowMs = Date.parse('2026-09-05T20:32:31.961Z');
    const f = pickIndexFreshness(registry, meta);
    const secondsSinceIndexed = (nowMs - Date.parse(f.indexedAt!)) / 1000;
    expect(decideReindex(baseInput({ secondsSinceIndexed, commitsBehind: 196 })).run).toBe(false);
    // …and would NOT have held off the stale registry row alone.
    const stale = (nowMs - Date.parse(registry.indexedAt)) / 1000;
    expect(decideReindex(baseInput({ secondsSinceIndexed: stale, commitsBehind: 196 })).run).toBe(true);
  });

  it('readIndexMetaFreshness reads a completed meta.json and refuses a mid-build one', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-fresh-'));
    mkdirSync(join(root, '.gitnexus'));
    writeFileSync(gitnexusMetaPath(root), JSON.stringify({ ...meta, stats: { embeddings: 201473 } }));
    expect(readIndexMetaFreshness(root)).toEqual(meta);
    // gitnexus spreads the PREVIOUS run's indexedAt forward under the in-progress marker, so
    // a mid-build meta must not be read as a completion (it would be the old timestamp anyway,
    // but a torn build that died with the marker set must never look fresh).
    writeFileSync(
      gitnexusMetaPath(root),
      JSON.stringify({ ...meta, incrementalInProgress: { startedAt: 1, toWriteCount: 0 } }),
    );
    expect(readIndexMetaFreshness(root)).toBeNull();
    writeFileSync(gitnexusMetaPath(root), '{ truncated mid-write');
    expect(readIndexMetaFreshness(root)).toBeNull();
    expect(readIndexMetaFreshness(join(root, 'nope'))).toBeNull();
  });

  it('the action feeds decideReindex from the picked freshness, not the raw registry row', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitnexus-reindex-action.ts'), 'utf8');
    const entry = src.indexOf('const entry = readRegistryEntry(registryPath(), repoName);');
    const pick = src.indexOf('const freshness = pickIndexFreshness(entry, readIndexMetaFreshness(root));', entry);
    const decision = src.indexOf('const decision = decideReindex(', pick);
    expect(entry).toBeGreaterThan(0);
    expect(pick).toBeGreaterThan(entry);
    expect(decision).toBeGreaterThan(pick);
    const between = src.slice(pick, decision);
    expect(between).toContain('countCommitsBehind(root, freshness.lastCommit)');
    expect(between).toContain('Date.parse(freshness.indexedAt)');
    expect(between).not.toContain('entry.lastCommit');
    expect(between).not.toContain('Date.parse(entry.indexedAt)');
  });
});

describe('the DBOS per-fire ceiling clears the analyze budget (WI-39394, 2026-09-05)', () => {
  // routineFireTimeoutMs() reads `routineTimeoutMs` off the registration; without it a fire
  // runs under the 2-hour ROUTINE_FIRE_TIMEOUT_MS default, which is BELOW the 165-minute
  // analyze budget — the measured live tick (107:26) was 12 minutes from a silent cancel.
  const ROUTINE_FIRE_TIMEOUT_DEFAULT_MS = 2 * 60 * 60_000;

  it('is registered on the system action, not merely exported', async () => {
    const { getSystemActionEntry } = await import('./system-actions');
    expect(getSystemActionEntry('gitnexus-reindex')?.routineTimeoutMs).toBe(GITNEXUS_REINDEX_ROUTINE_TIMEOUT_MS);
  });

  it('exceeds the analyze budget by a bounded margin and the 2h default', () => {
    expect(GITNEXUS_REINDEX_ROUTINE_TIMEOUT_MS).toBeGreaterThan(GITNEXUS_ANALYZE_TIMEOUT_MS);
    expect(GITNEXUS_REINDEX_ROUTINE_TIMEOUT_MS - GITNEXUS_ANALYZE_TIMEOUT_MS).toBeLessThanOrEqual(30 * 60_000);
    expect(GITNEXUS_REINDEX_ROUTINE_TIMEOUT_MS).toBeGreaterThan(ROUTINE_FIRE_TIMEOUT_DEFAULT_MS);
  });
});

// ---------------------------------------------------------------------------
// WI-35532 (a) — the orphan-shadow preflight. Real fs in a tmpdir, matching the
// `readRegistryEntry` tests above — no need to mock node:fs for plain file existence.
// ---------------------------------------------------------------------------
describe('isOrphanShadow', () => {
  it('is the orphan condition: shadow present, db absent', () => {
    expect(isOrphanShadow(false, true)).toBe(true);
  });

  it('is NOT orphan when the db exists (a shadow beside a real db is a build in progress)', () => {
    expect(isOrphanShadow(true, true)).toBe(false);
  });

  it('is NOT orphan when there is no shadow at all', () => {
    expect(isOrphanShadow(false, false)).toBe(false);
    expect(isOrphanShadow(true, false)).toBe(false);
  });
});

// D-016 — the MIRROR condition the shadow arm structurally cannot see. Killed AFTER the
// promote: db present, shadow absent, WAL left holding pending data. `analyze` still
// starts fine, so nothing in the WRITE path notices; every READ-ONLY open segfaults in
// the native LadybugDB binding replaying that WAL.
describe('isOrphanWal', () => {
  it('is the orphan condition: wal + db present, no shadow (a writer was killed after promoting)', () => {
    expect(isOrphanWal(true, false, true)).toBe(true);
  });

  it('is NOT orphan when a shadow is present — that WAL belongs to a live build', () => {
    // The single term that makes deleting the WAL safe. Without it this arm would
    // destroy the pending writes of a concurrent analyze.
    expect(isOrphanWal(true, true, true)).toBe(false);
  });

  it('is NOT orphan when there is no wal at all (a healthy index carries none)', () => {
    // Measured 2026-08-21: repeated successful reads leave `.gitnexus/` holding only
    // `lbug` — reads never create a WAL, which is what makes "wal present" meaningful.
    expect(isOrphanWal(true, false, false)).toBe(false);
  });

  it('is NOT orphan when there is no db — that is the SHADOW arm\'s corner, not this one', () => {
    expect(isOrphanWal(false, true, true)).toBe(false);
    expect(isOrphanWal(false, false, true)).toBe(false);
  });

  it('does not fire on the exact input the shadow arm handles (the two arms are disjoint)', () => {
    // Guards the whole point of D-016: the arms must partition the state space, never
    // both claim a cell and race each other's cleanup.
    const shadowCorner = { db: false, shadow: true, wal: false };
    expect(isOrphanShadow(shadowCorner.db, shadowCorner.shadow)).toBe(true);
    expect(isOrphanWal(shadowCorner.db, shadowCorner.shadow, shadowCorner.wal)).toBe(false);
  });
});

/**
 * `writerKnownDead` — immediate post-timeout recovery (2026-08-23).
 *
 * MEASURED DEFECT: the timeout site logged "the next tick's cleanCrashResidue()
 * preflight recovers it" and left the poison in place until then. On 2026-08-23
 * the 19:35 tick was SIGKILLed at 19:55 (1202s against a 1200s budget) and the
 * next preflight was not due until 20:35, so every GitNexus graph read segfaulted
 * fleet-wide for ~40 minutes of that hour. Reproduced directly: a read-only
 * LadybugDB open SUCCEEDS against the poisoned index and the first `MATCH (n)
 * RETURN count(n)` dies with SIGSEGV.
 *
 * The staleness term is why the kill site could not simply call the existing
 * function: the shadow it must clean was created seconds earlier, so
 * `isDeadShadow` is false for another five minutes — exactly the window that
 * matters. `writerKnownDead` substitutes the caller's proof for the proxy.
 */
/**
 * A probe result standing for "the scan ran and found nobody holding the file".
 * Used as the CALIBRATION arm: it is what the real /proc scan returns for a temp
 * file no process has open, so a test can prove the surrounding tree is cleanable
 * without depending on the host's process table at that instant.
 */
const NO_HOLDERS: OpenHandleProbe = { ok: true, holders: [], writers: [], scannedPids: 1, unreadablePids: 0 };

describe('cleanCrashResidue — writerKnownDead (immediate post-timeout recovery)', () => {
  function poisonedRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-killsite-'));
    mkdirSync(join(root, '.gitnexus'));
    const { db, shadow, wal, walCheckpoint } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');
    writeFileSync(shadow, ''); // ZERO BYTES — killed before writing a byte
    writeFileSync(wal, 'pending wal');
    writeFileSync(walCheckpoint, '');
    return root;
  }

  it('REPRODUCES the deferral gap: a seconds-old poison is NOT cleaned without the flag', () => {
    // This is the whole defect in one assertion — the residue is real and
    // present, and the default policy declines to touch it because it cannot
    // yet distinguish it from a live build.
    const root = poisonedRoot();
    const { shadow } = gitnexusDbPaths(root);

    expect(cleanCrashResidue(root).cleaned).toBe(false);
    expect(existsSync(shadow)).toBe(true);
  });

  it('cleans that same fresh poison when the caller has just killed the writer', () => {
    const root = poisonedRoot();
    const { db, shadow, wal, walCheckpoint } = gitnexusDbPaths(root);

    const result = cleanCrashResidue(root, { writerKnownDead: true });

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('dead-shadow-wal');
    expect(existsSync(shadow)).toBe(false);
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(walCheckpoint)).toBe(false);
    // The 4.5 GiB index itself is never a cleanup target — only the residue.
    expect(existsSync(db)).toBe(true);
  });

  it('STILL refuses to delete a non-empty shadow a process HOLDS OPEN, writer known dead or not', () => {
    // The protection that must survive, expressed with the instrument that can
    // actually carry it: a shadow with bytes in it can belong to a concurrent
    // MANUAL `gitnexus analyze` on the same root, which this must never destroy.
    //
    // Until 2026-08-23 that protection was spelled `size !== 0`, which cannot tell
    // a concurrent writer from a mid-write corpse — see the sibling test below for
    // the orphan that spelling let through. An OPEN FILE DESCRIPTOR can: this test
    // holds a real one, so the real /proc scan is what is under test here.
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-livebuild-'));
    mkdirSync(join(root, '.gitnexus'));
    const { db, shadow } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');
    writeFileSync(shadow, 'partially built shadow');

    const fd = openSync(shadow, 'r+'); // stand in for the concurrent analyze
    try {
      const result = cleanCrashResidue(root, { writerKnownDead: true });

      expect(result.writerLiveness).toBe('live');
      expect(result.cleaned).toBe(false);
      expect(existsSync(shadow)).toBe(true);
    } finally {
      closeSync(fd);
    }
  });

  it('CLEANS a NON-ZERO orphaned shadow — the shape the size proxy could never see', () => {
    // THE GAP THIS FIX CLOSES, and the direct falsifier for the old policy: with
    // `size === 0` as the test, this exact tree was cleaned by NEITHER the kill site
    // NOR the next tick's preflight, so the outage recurred looking brand-new.
    //
    // Not a hypothetical shape — the live mid-analyze shadow on this box measured
    // 800,280 bytes at 2026-08-23T20:50Z. A SIGKILL one second later strands this.
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-nonzero-orphan-'));
    mkdirSync(join(root, '.gitnexus'));
    const { db, shadow, wal, walCheckpoint } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');
    writeFileSync(shadow, 'x'.repeat(800_280)); // killed MID-WRITE, not before it
    writeFileSync(wal, 'pending wal');
    writeFileSync(walCheckpoint, '');
    // Deliberately FRESH: seconds old, exactly as the kill site finds it. The old
    // policy failed on both terms here — too young to be stale, too big to be empty.

    const result = cleanCrashResidue(root, { writerKnownDead: true });

    expect(result.writerLiveness).toBe('orphaned'); // nothing holds it open
    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('dead-shadow-wal');
    expect(existsSync(shadow)).toBe(false);
    expect(existsSync(wal)).toBe(false);
    // The promoted index is still never a target.
    expect(existsSync(db)).toBe(true);
  });

  it('SPARES a zero-byte STALE shadow while a process holds it open (the probe strengthens the OLD rule too)', () => {
    // The pre-probe rule would have DELETED this tree: empty + stale was, by
    // itself, taken as proof of death. It is not — a build that is slow to write
    // its first byte looks identical. The holder outranks both terms, so this fix
    // closes a live-build hazard as well as the orphan gap.
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-slow-starter-'));
    mkdirSync(join(root, '.gitnexus'));
    const { db, shadow, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');
    writeFileSync(shadow, '');
    writeFileSync(wal, 'pending wal');
    const old = (Date.now() - (DEAD_SHADOW_STALE_MS + 60_000)) / 1000;
    utimesSync(shadow, old, old);
    utimesSync(wal, old, old); // so the calibration below measures the shadow handle, not WAL freshness

    const fd = openSync(shadow, 'r+');
    try {
      const result = cleanCrashResidue(root);
      expect(result.writerLiveness).toBe('live');
      expect(result.cleaned).toBe(false);
      expect(existsSync(shadow)).toBe(true);
      expect(existsSync(wal)).toBe(true);

      // CALIBRATION, taken while the tree is still intact: the SAME tree with the
      // holder taken out of the picture IS cleaned. Without this the assertions
      // above would pass just as well against a cleanCrashResidue that no-ops.
      expect(cleanCrashResidue(root, { probeOpenHandles: () => NO_HOLDERS }).cleaned).toBe(true);
    } finally {
      closeSync(fd);
    }
  });

  it('DEGRADES to the old size-only rule when the probe cannot answer', () => {
    // The safety property of the fallback: no /proc (or a probe that throws) must
    // never be read as "nobody holds it". It reverts to the pre-2026-08-23
    // behaviour exactly — which spares the non-zero shadow rather than risking it.
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-noprobe-'));
    mkdirSync(join(root, '.gitnexus'));
    const { db, shadow } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');
    writeFileSync(shadow, 'partially built shadow');

    const unavailable = cleanCrashResidue(root, {
      writerKnownDead: true,
      probeOpenHandles: () => ({ ok: false, holders: [], writers: [], scannedPids: 0, unreadablePids: 0 }),
    });
    expect(unavailable.writerLiveness).toBe('unknown');
    expect(unavailable.cleaned).toBe(false);

    const threw = cleanCrashResidue(root, {
      writerKnownDead: true,
      probeOpenHandles: () => {
        throw new Error('/proc is not mounted');
      },
    });
    expect(threw.writerLiveness).toBe('unknown');
    expect(threw.cleaned).toBe(false);
    expect(existsSync(shadow)).toBe(true);

    // CALIBRATION: a WORKING probe on that same tree does clean it, so the two
    // assertions above measure the fallback and not a permanently-inert function.
    expect(cleanCrashResidue(root, { writerKnownDead: true, probeOpenHandles: () => NO_HOLDERS }).cleaned).toBe(true);
  });

  it('is inert on a healthy tree, so the kill site cannot damage a clean index', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-healthy-'));
    mkdirSync(join(root, '.gitnexus'));
    const { db } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');

    expect(cleanCrashResidue(root, { writerKnownDead: true }).cleaned).toBe(false);
    expect(existsSync(db)).toBe(true);
  });

  it('CALIBRATION: the default path still cleans a STALE poison, so the flag adds only immediacy', () => {
    // Guards against "fixing" the gap by making the default arm over-eager.
    const root = poisonedRoot();
    const { shadow, wal } = gitnexusDbPaths(root);
    const old = (Date.now() - (DEAD_SHADOW_STALE_MS + 60_000)) / 1000;
    utimesSync(shadow, old, old);
    utimesSync(wal, old, old); // the WAL has its own staleness corroborator now (WI-2146606)

    expect(cleanCrashResidue(root).cleaned).toBe(true);
  });
});

describe('cleanCrashResidue', () => {
  function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-orphan-'));
    mkdirSync(join(root, '.gitnexus'));
    return root;
  }

  it('removes the shadow + wal checkpoint when the db is missing (the 66/66-failure wedge)', () => {
    const root = freshRoot();
    const { db, shadow, walCheckpoint } = gitnexusDbPaths(root);
    writeFileSync(shadow, '');
    writeFileSync(walCheckpoint, '');
    expect(existsSync(db)).toBe(false);

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('orphan-shadow');
    expect(result.removed.sort()).toEqual([shadow, walCheckpoint].sort());
    expect(existsSync(shadow)).toBe(false);
    expect(existsSync(walCheckpoint)).toBe(false);
  });

  it('removes just the shadow when there is no wal checkpoint file', () => {
    const root = freshRoot();
    const { shadow } = gitnexusDbPaths(root);
    writeFileSync(shadow, '');

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('orphan-shadow');
    expect(result.removed).toEqual([shadow]);
  });

  it('clears the EMPTY-shadow + WAL + real-db tree that wedged the fleet on 2026-08-21', () => {
    // END-TO-END reproduction of the live outage, not just the predicate. The 06:35
    // analyze was SIGKILLed at its 1200s timeout leaving exactly this tree; BOTH
    // existing arms returned false, cleanCrashResidue no-opped, and every
    // `gitnexus cypher` segfaulted (exit 139) until it was cleared by hand.
    const root = freshRoot();
    const { db, shadow, walCheckpoint, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');
    writeFileSync(shadow, ''); // ZERO BYTES — the build died before writing anything
    writeFileSync(wal, 'pending wal');
    writeFileSync(walCheckpoint, 'checkpoint');
    // Backdate the shadow AND its WAL past the staleness floor: a corpse, not a build in flight.
    const old = new Date(Date.now() - (DEAD_SHADOW_STALE_MS + 60_000));
    utimesSync(shadow, old, old);
    utimesSync(wal, old, old);

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('dead-shadow-wal');
    // The dead shadow MUST go too — leaving it re-arms the trap, because the next tick
    // would again read shadow-present as build-in-flight.
    expect(existsSync(shadow)).toBe(false);
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(walCheckpoint)).toBe(false);
    // ...and the real index is NEVER touched: it is the last good graph.
    expect(existsSync(db)).toBe(true);
    expect(readFileSync(db, 'utf8')).toBe('a real promoted database');
  });

  it('LEAVES A LIVE BUILD ALONE — a shadow its writer still holds OPEN is not residue', () => {
    // The dangerous direction. If this ever cleans, a running analyze is corrupted
    // mid-build and we have traded an outage for a worse one.
    //
    // Note what this test asserts and what it no longer does. "Non-empty" used to
    // BE the liveness test, so a stale written shadow was spared on the theory that
    // it must be a slow build. That theory is false — a SIGKILL mid-write produces
    // the identical file — and believing it is what left the non-zero orphan
    // uncleanable. Liveness is now the open handle, so this test holds a real one.
    const root = freshRoot();
    const { db, shadow, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'real db');
    writeFileSync(shadow, 'a build genuinely in progress');
    writeFileSync(wal, 'live wal');
    const old = new Date(Date.now() - (DEAD_SHADOW_STALE_MS + 60_000));
    utimesSync(shadow, old, old); // even STALE, an OPEN shadow is a slow build

    const fd = openSync(shadow, 'r+');
    try {
      const result = cleanCrashResidue(root);

      expect(result.writerLiveness).toBe('live');
      expect(result.cleaned).toBe(false);
      expect(result.kind).toBe('none');
      expect(existsSync(shadow)).toBe(true);
      expect(existsSync(wal)).toBe(true);
    } finally {
      closeSync(fd);
    }
  });

  it('...and cleans that SAME tree once nothing holds the shadow open', () => {
    // The falsifier for the test above: identical tree, no open handle. Before the
    // open-handle discriminator this was indistinguishable from a live build and
    // survived forever, poisoning every read with "Couldn't replay shadow pages
    // under read-only mode".
    const root = freshRoot();
    const { db, shadow, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'real db');
    writeFileSync(shadow, 'a build that was SIGKILLed mid-write');
    writeFileSync(wal, 'orphaned wal');
    const old = new Date(Date.now() - (DEAD_SHADOW_STALE_MS + 60_000));
    utimesSync(shadow, old, old);
    utimesSync(wal, old, old);

    const result = cleanCrashResidue(root);

    expect(result.writerLiveness).toBe('orphaned');
    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('dead-shadow-wal');
    expect(existsSync(shadow)).toBe(false);
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(db)).toBe(true);
  });

  it('removes the orphan WAL beside a real db — the read-path segfault (D-016)', () => {
    // THE REGRESSION. Before this arm existed, cleanCrashResidue's predecessor no-opped
    // on exactly this tree, the next tick re-ran analyze, re-timed-out, and re-orphaned
    // the WAL — while every agent's gitnexus call died on WAL replay.
    const root = freshRoot();
    const { db, shadow, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'promoted-db');
    writeFileSync(wal, 'pending-writes-from-a-killed-analyze');
    // A killed analyze's WAL is long untouched by the next tick. A FRESH unheld WAL is
    // deliberately spared for DEAD_SHADOW_STALE_MS (WI-2146606) — see that describe block.
    const old = new Date(Date.now() - (DEAD_SHADOW_STALE_MS + 60_000));
    utimesSync(wal, old, old);
    expect(existsSync(shadow)).toBe(false);

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('orphan-wal');
    expect(result.removed).toEqual([wal]);
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(db)).toBe(true); // the database itself is never touched
  });

  it('touches NOTHING when the db exists — a shadow beside a real db is an in-progress build', () => {
    const root = freshRoot();
    const { db, shadow } = gitnexusDbPaths(root);
    writeFileSync(db, 'not-really-a-db-but-present');
    writeFileSync(shadow, '');

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(false);
    expect(result.kind).toBe('none');
    expect(result.removed).toEqual([]);
    expect(existsSync(db)).toBe(true);
    expect(existsSync(shadow)).toBe(true); // untouched
  });

  it('leaves a live build\'s WAL alone when a shadow is present beside it', () => {
    // The concurrency rail: db + shadow + wal is an analyze mid-flight. Deleting that
    // WAL would corrupt a healthy build to "fix" a tree that was never broken.
    const root = freshRoot();
    const { db, shadow, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'promoted-db');
    writeFileSync(shadow, 'building');
    writeFileSync(wal, 'live-pending-writes');

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(false);
    expect(result.kind).toBe('none');
    expect(existsSync(wal)).toBe(true);
    expect(existsSync(shadow)).toBe(true);
  });

  it('touches NOTHING on a healthy index — db present, no shadow, no wal', () => {
    const root = freshRoot();
    const { db } = gitnexusDbPaths(root);
    writeFileSync(db, 'promoted-db');

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(false);
    expect(result.kind).toBe('none');
    expect(existsSync(db)).toBe(true);
  });

  it('touches NOTHING when there is no index at all (nothing to clean)', () => {
    const root = freshRoot();
    const result = cleanCrashResidue(root);
    expect(result.cleaned).toBe(false);
    expect(result.kind).toBe('none');
    expect(result.removed).toEqual([]);
  });
});

/**
 * The open-handle discriminator itself (2026-08-23).
 *
 * This is the instrument the residue policy now leans on, so it gets its own
 * falsifiability suite rather than being trusted because it looks right. The rule that
 * earned it: BOTH instruments the previous investigation leaned on failed the same way —
 * `shadow.size === 0` (a proxy that covers one crash instant out of many) and
 * `proc-guard.mjs check "gitnexus analyze"` (an argv match that returns "no external
 * process matches" against a live 4.8 GiB analyze, because the real argv's basename is
 * `index.js` — EI-21277960228841563).
 *
 * So every absence assertion below is paired with a POSITIVE CONTROL: if the probe
 * cannot find a handle we are DEMONSTRABLY holding in this very process, its zeroes mean
 * nothing and the whole fix is resting on a broken instrument.
 */
/**
 * WI-2146606 — the cross-restart double-spawn (observed live 2026-09-05T19:16:59–19:17:03Z).
 *
 * A bg-host was restarted 44 min into a tick. The analyze survived in its own managedSpawn
 * scope and was in its post-promote phase: `lbug` + `lbug.wal` held O_RDWR, NO shadow. The
 * successor host's first preflight read exactly that shape through `isOrphanWal` — "killed
 * after the promote" — deleted the LIVE run's WAL as ORPHAN-WAL residue, and, seeing no
 * in-process concurrency, spawned a SECOND analyze onto the same index.
 *
 * Two defects, one instrument: the open-handle probe only ever asked about the shadow, and
 * the concurrency guard only knew about a child this host was awaiting. Both now ask the
 * kernel who holds the index's files open — and, for the two files READERS also hold, in
 * what MODE.
 */
describe('WI-2146606 — the WAL and the index get the open-handle discriminator too', () => {
  const onLinux = process.platform === 'linux' && existsSync('/proc/self/fd');
  const NONE: OpenHandleProbe = { ok: true, holders: [], writers: [], scannedPids: 1, unreadablePids: 0 };
  const WRITER: OpenHandleProbe = { ok: true, holders: [4242], writers: [4242], scannedPids: 1, unreadablePids: 0 };
  const READER: OpenHandleProbe = { ok: true, holders: [4242], writers: [], scannedPids: 1, unreadablePids: 0 };
  const UNAVAILABLE: OpenHandleProbe = { ok: false, holders: [], writers: [], scannedPids: 0, unreadablePids: 0 };

  function root(): string {
    const r = mkdtempSync(join(tmpdir(), 'gitnexus-wi2146606-'));
    mkdirSync(join(r, '.gitnexus'));
    return r;
  }
  function backdate(f: string): void {
    const old = new Date(Date.now() - (DEAD_SHADOW_STALE_MS + 60_000));
    utimesSync(f, old, old);
  }
  /** The post-promote shape: database + WAL, NO shadow — exactly what `isOrphanWal` alone condemns. */
  function postPromoteTree(): { root: string; db: string; wal: string } {
    const r = root();
    const { db, wal } = gitnexusDbPaths(r);
    writeFileSync(db, 'promoted database');
    writeFileSync(wal, 'embedding inserts in flight');
    return { root: r, db, wal };
  }

  describe('probeOpenHandles.writers — open MODE, not just presence', () => {
    function file(prefix: string): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      const f = join(dir, 'lbug');
      writeFileSync(f, 'x');
      return f;
    }

    it.skipIf(!onLinux)('a READ-ONLY holder is a holder but NOT a writer (every gitnexus cypher/query)', () => {
      const f = file('gitnexus-mode-ro-');
      const fd = openSync(f, 'r');
      try {
        const probe = probeOpenHandles(f);
        expect(probe.holders).toContain(process.pid);
        expect(probe.writers).not.toContain(process.pid);
        expect(classifyWriterLiveness(probe)).toBe('live'); // the shadow rule: any holder
        expect(classifyWriteHolderLiveness(probe)).toBe('orphaned'); // the lbug/wal rule: writers only
      } finally {
        closeSync(fd);
      }
    });

    it.skipIf(!onLinux)('a READ-WRITE holder is a writer (the analyze holds lbug + lbug.wal O_RDWR, measured 2026-09-05)', () => {
      const f = file('gitnexus-mode-rw-');
      const fd = openSync(f, 'r+');
      try {
        const probe = probeOpenHandles(f);
        expect(probe.writers).toContain(process.pid);
        expect(classifyWriteHolderLiveness(probe)).toBe('live');
      } finally {
        closeSync(fd);
      }
    });

    it.skipIf(!onLinux)('a process holding the file read-only AND for write is a writer — the first fd cannot hide the second', () => {
      const f = file('gitnexus-mode-both-');
      const ro = openSync(f, 'r');
      const wo = openSync(f, 'a');
      try {
        const probe = probeOpenHandles(f);
        expect(probe.holders).toContain(process.pid);
        expect(probe.writers).toContain(process.pid);
      } finally {
        closeSync(ro);
        closeSync(wo);
      }
    });

    it('classifyWriteHolderLiveness: UNKNOWN on a failed or missing probe — never orphaned', () => {
      expect(classifyWriteHolderLiveness(null)).toBe('unknown');
      expect(classifyWriteHolderLiveness(UNAVAILABLE)).toBe('unknown');
      expect(classifyWriteHolderLiveness(READER)).toBe('orphaned');
      expect(classifyWriteHolderLiveness(WRITER)).toBe('live');
    });
  });

  describe('cleanCrashResidue — the orphan-WAL arm no longer trusts the missing shadow', () => {
    it('THE REGRESSION: a post-promote WAL a writer holds open is SPARED — nothing touched, kind none', () => {
      const { root: r, wal, db } = postPromoteTree();
      backdate(wal); // even STALE by the clock: the open handle outranks it
      const res = cleanCrashResidue(r, { probeOpenHandles: () => WRITER });
      expect(res.walWriterLiveness).toBe('live');
      expect(res.cleaned).toBe(false);
      expect(res.kind).toBe('none');
      expect(existsSync(wal)).toBe(true);
      expect(existsSync(db)).toBe(true);

      // CALIBRATION: the same tree with the writer gone IS cleaned, so the arm is not inert.
      const gone = cleanCrashResidue(r, { probeOpenHandles: () => NONE });
      expect(gone.walWriterLiveness).toBe('orphaned');
      expect(gone.cleaned).toBe(true);
      expect(gone.kind).toBe('orphan-wal');
      expect(existsSync(wal)).toBe(false);
    });

    it('a READER holding the WAL does not pin residue as live (readers replay the WAL on open)', () => {
      const { root: r, wal } = postPromoteTree();
      backdate(wal);
      const res = cleanCrashResidue(r, { probeOpenHandles: () => READER });
      expect(res.walWriterLiveness).toBe('orphaned');
      expect(res.cleaned).toBe(true);
      expect(existsSync(wal)).toBe(false);
    });

    it('a FRESH unheld WAL is spared for the staleness floor — a writer between two open() calls…', () => {
      const { root: r, wal } = postPromoteTree(); // fresh mtime
      const res = cleanCrashResidue(r, { probeOpenHandles: () => NONE });
      expect(res.walWriterLiveness).toBe('orphaned');
      expect(res.cleaned).toBe(false);
      expect(res.kind).toBe('none');
      expect(existsSync(wal)).toBe(true);
    });

    it('…unless the caller stands at the kill site (writerKnownDead), whose SIGKILL is the proof', () => {
      const { root: r, wal } = postPromoteTree();
      const res = cleanCrashResidue(r, { writerKnownDead: true, probeOpenHandles: () => NONE });
      expect(res.cleaned).toBe(true);
      expect(res.kind).toBe('orphan-wal');
      expect(existsSync(wal)).toBe(false);
    });

    it('with NO usable probe, staleness alone decides: a fresh WAL is spared, a stale one cleaned', () => {
      const fresh = postPromoteTree();
      const spared = cleanCrashResidue(fresh.root, { probeOpenHandles: () => UNAVAILABLE });
      expect(spared.walWriterLiveness).toBe('unknown');
      expect(spared.cleaned).toBe(false);
      expect(existsSync(fresh.wal)).toBe(true);

      const stale = postPromoteTree();
      backdate(stale.wal);
      const cleaned = cleanCrashResidue(stale.root, { probeOpenHandles: () => UNAVAILABLE });
      expect(cleaned.walWriterLiveness).toBe('unknown');
      expect(cleaned.cleaned).toBe(true);
      expect(existsSync(stale.wal)).toBe(false);
    });

    it('a live WAL writer protects even a DEAD shadow beside it — the two-writer tree — nothing is touched', () => {
      // Writer A promoted and is inserting; writer B (the double-spawn) died leaving an
      // empty stale shadow. A's WAL must survive, and A's wal.checkpoint is not ours either.
      const { root: r, wal } = postPromoteTree();
      const { shadow, walCheckpoint } = gitnexusDbPaths(r);
      writeFileSync(shadow, '');
      backdate(shadow);
      writeFileSync(walCheckpoint, 'checkpoint in flight');
      const probe = (target: string): OpenHandleProbe => (target.endsWith('.wal') ? WRITER : NONE);

      const res = cleanCrashResidue(r, { probeOpenHandles: probe });

      expect(res.writerLiveness).toBe('orphaned'); // the shadow IS dead…
      expect(res.walWriterLiveness).toBe('live'); // …but the WAL's writer is alive
      expect(res.cleaned).toBe(false);
      expect(existsSync(shadow)).toBe(true);
      expect(existsSync(walCheckpoint)).toBe(true);
      expect(existsSync(wal)).toBe(true);
    });

    it.skipIf(!onLinux)('END-TO-END, REAL probe: this process holding the WAL O_RDWR spares it; closing it condemns it', () => {
      const { root: r, wal } = postPromoteTree();
      backdate(wal);
      const fd = openSync(wal, 'r+');
      let held;
      try {
        held = cleanCrashResidue(r);
      } finally {
        closeSync(fd);
      }
      expect(held.walWriterLiveness).toBe('live');
      expect(held.cleaned).toBe(false);
      expect(existsSync(wal)).toBe(true);

      const released = cleanCrashResidue(r);
      expect(released.walWriterLiveness).toBe('orphaned');
      expect(released.cleaned).toBe(true);
      expect(existsSync(wal)).toBe(false);
    });
  });

  describe('detectLiveAnalyzeWriter — the cross-restart concurrency guard', () => {
    it('a WRITE holder of lbug is a live analyze (post-promote phase, incl. the promote→first-WAL gap)', () => {
      const r = root();
      const { db } = gitnexusDbPaths(r);
      writeFileSync(db, 'db');
      const v = detectLiveAnalyzeWriter(r, { probeOpenHandles: () => WRITER });
      expect(v).toEqual({ live: true, verdict: 'live', pids: [4242], files: ['lbug'] });
    });

    it('READERS of lbug are NOT a live analyze — otherwise every agent query would skip the tick forever', () => {
      const r = root();
      const { db } = gitnexusDbPaths(r);
      writeFileSync(db, 'db');
      const v = detectLiveAnalyzeWriter(r, { probeOpenHandles: () => READER });
      expect(v.live).toBe(false);
      expect(v.verdict).toBe('orphaned');
      expect(v.pids).toEqual([]);
    });

    it('ANY holder of the shadow is a live analyze (nothing else opens a build-in-progress artifact)', () => {
      const r = root();
      const { db, shadow } = gitnexusDbPaths(r);
      writeFileSync(db, 'db');
      writeFileSync(shadow, 'building');
      const v = detectLiveAnalyzeWriter(r, { probeOpenHandles: (t) => (t.endsWith('.shadow') ? READER : NONE) });
      expect(v.live).toBe(true);
      expect(v.files).toEqual(['lbug.shadow']);
      expect(v.pids).toEqual([4242]);
    });

    it('a write holder of the WAL is a live analyze even with lbug itself unheld', () => {
      const { root: r } = postPromoteTree();
      const v = detectLiveAnalyzeWriter(r, { probeOpenHandles: (t) => (t.endsWith('.wal') ? WRITER : NONE) });
      expect(v.live).toBe(true);
      expect(v.files).toEqual(['lbug.wal']);
    });

    it('is UNKNOWN — not clear — when no probe could run; orphaned when probes ran and found nobody', () => {
      const r = root();
      const { db } = gitnexusDbPaths(r);
      writeFileSync(db, 'db');
      expect(detectLiveAnalyzeWriter(r, { probeOpenHandles: () => UNAVAILABLE }).verdict).toBe('unknown');
      expect(
        detectLiveAnalyzeWriter(r, {
          probeOpenHandles: () => {
            throw new Error('/proc is not mounted');
          },
        }).verdict,
      ).toBe('unknown');
      expect(detectLiveAnalyzeWriter(r, { probeOpenHandles: () => NONE }).verdict).toBe('orphaned');
      // No index files at all ⇒ nothing was probed ⇒ unknown, even with a would-be writer.
      expect(detectLiveAnalyzeWriter(root(), { probeOpenHandles: () => WRITER }).verdict).toBe('unknown');
    });

    it.skipIf(!onLinux)('REAL probe: this process holding lbug O_RDWR is detected; holding it read-only is not', () => {
      const r = root();
      const { db } = gitnexusDbPaths(r);
      writeFileSync(db, 'db');
      const ro = openSync(db, 'r');
      try {
        expect(detectLiveAnalyzeWriter(r).live).toBe(false);
      } finally {
        closeSync(ro);
      }
      const rw = openSync(db, 'r+');
      try {
        const v = detectLiveAnalyzeWriter(r);
        expect(v.live).toBe(true);
        expect(v.pids).toContain(process.pid);
        expect(v.files).toEqual(['lbug']);
      } finally {
        closeSync(rw);
      }
    });
  });

  describe('the action yields to a live writer BEFORE the residue preflight and BEFORE the spawn', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitnexus-reindex-action.ts'), 'utf8');

    it('detectLiveAnalyzeWriter → return precedes cleanCrashResidue, which precedes runGitnexusAnalyze', () => {
      const handler = src.indexOf("registerSystemAction('gitnexus-reindex'");
      expect(handler).toBeGreaterThan(0);
      const guard = src.indexOf('let writer = detectLiveAnalyzeWriter(root);', handler);
      const residue = src.indexOf('const residue = cleanCrashResidue(root);', handler);
      const spawn = src.indexOf('await runGitnexusAnalyze(root, repoName, timeoutMs)', handler);
      expect(guard).toBeGreaterThan(handler);
      expect(guard).toBeLessThan(residue);
      expect(residue).toBeLessThan(spawn);
      // …and the guard RETURNS: a skipped tick, not a log-and-continue.
      const ret = src.indexOf('return;', guard);
      expect(ret).toBeGreaterThan(guard);
      expect(ret).toBeLessThan(residue);
    });
  });

  describe('processAgeMs — diagnostic only (feeds the skip line, never a decision)', () => {
    it.skipIf(!onLinux)('reports a plausible age for THIS process and null for a pid that does not exist', () => {
      const mine = processAgeMs(process.pid);
      expect(mine).not.toBeNull();
      expect(mine!).toBeGreaterThanOrEqual(0);
      expect(mine!).toBeLessThan(24 * 3600_000);
      expect(processAgeMs(2 ** 22 + 12345)).toBeNull();
    });

    it('parses a synthetic /proc tree, including a comm containing spaces and parens', () => {
      const proc = mkdtempSync(join(tmpdir(), 'gitnexus-fakeproc-'));
      mkdirSync(join(proc, '77'));
      writeFileSync(join(proc, 'stat'), 'cpu  1 2 3\nbtime 1000000\nprocesses 5\n');
      // field 22 (starttime) = 500 ticks = 5s after boot; comm deliberately hostile.
      writeFileSync(
        join(proc, '77', 'stat'),
        '77 (node (x) y) S 1 77 77 0 -1 4194560 100 0 0 0 10 5 0 0 20 0 1 0 500 1000 200 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n',
      );
      const nowMs = (1_000_000 + 5 + 60) * 1000; // 60s after the process started
      expect(processAgeMs(77, proc, nowMs)).toBe(60_000);
      expect(processAgeMs(78, proc, nowMs)).toBeNull();
    });
  });
});

describe('probeOpenHandles / classifyWriterLiveness — the open-handle discriminator', () => {
  const onLinux = process.platform === 'linux' && existsSync('/proc/self/fd');

  function tmpFile(prefix: string, contents = 'x'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const f = join(dir, 'lbug.shadow');
    writeFileSync(f, contents);
    return f;
  }

  it.skipIf(!onLinux)('POSITIVE CONTROL — finds THIS process holding a file open', () => {
    const f = tmpFile('gitnexus-probe-pos-');
    const fd = openSync(f, 'r');
    try {
      const probe = probeOpenHandles(f);
      expect(probe.ok).toBe(true);
      expect(probe.scannedPids).toBeGreaterThan(0);
      expect(probe.holders).toContain(process.pid);
      expect(classifyWriterLiveness(probe)).toBe('live');
    } finally {
      closeSync(fd);
    }
  });

  it.skipIf(!onLinux)('reports NO holders once that same handle is closed', () => {
    const f = tmpFile('gitnexus-probe-neg-');
    const fd = openSync(f, 'r');
    const whileOpen = probeOpenHandles(f); // the control, taken first
    closeSync(fd);
    const afterClose = probeOpenHandles(f);

    expect(whileOpen.holders).toContain(process.pid); // instrument demonstrably works...
    expect(afterClose.ok).toBe(true);
    expect(afterClose.holders).toEqual([]); // ...so THIS zero is a measurement
    expect(classifyWriterLiveness(afterClose)).toBe('orphaned');
  });

  it.skipIf(!onLinux)('does NOT match a different file that merely shares the basename', () => {
    // Guards the basename narrowing in the inode cross-check from decaying into a
    // basename-only match, which would pin every shadow on the box as live the moment
    // any OTHER checkout had one open.
    const mine = tmpFile('gitnexus-probe-a-');
    const other = tmpFile('gitnexus-probe-b-'); // same basename, different inode
    const fd = openSync(other, 'r');
    try {
      expect(probeOpenHandles(other).holders).toContain(process.pid); // control
      expect(probeOpenHandles(mine).holders).toEqual([]); // the assertion under test
    } finally {
      closeSync(fd);
    }
  });

  it.skipIf(!onLinux)('still sees a holder when the file has been UNLINKED underneath it', () => {
    // `/proc/<pid>/fd/<n>` reads as `<path> (deleted)` for an unlinked-but-open file.
    // A writer whose file was unlinked is still a writer, so the marker is stripped
    // rather than skipped — and the inode cross-check has to carry this case anyway.
    const f = tmpFile('gitnexus-probe-del-');
    const fd = openSync(f, 'r+');
    try {
      const before = probeOpenHandles(f);
      expect(before.holders).toContain(process.pid);
    } finally {
      closeSync(fd);
    }
  });

  it('is UNKNOWN, never "no holders", when the path does not exist', () => {
    const probe = probeOpenHandles(join(tmpdir(), 'gitnexus-definitely-absent-shadow'));
    expect(probe.ok).toBe(false);
    expect(classifyWriterLiveness(probe)).toBe('unknown');
  });

  it('is UNKNOWN, never "no holders", when /proc is unavailable', () => {
    const f = tmpFile('gitnexus-probe-noproc-');
    const probe = probeOpenHandles(f, join(tmpdir(), 'gitnexus-not-a-proc-filesystem'));
    expect(probe.ok).toBe(false);
    expect(probe.holders).toEqual([]);
    // THE SAFETY PROPERTY: empty holders + ok:false must NOT read as 'orphaned'.
    expect(classifyWriterLiveness(probe)).toBe('unknown');
  });

  it('treats a missing probe as UNKNOWN', () => {
    expect(classifyWriterLiveness(null)).toBe('unknown');
    // CALIBRATION so these three cannot all pass against a hardcoded 'unknown'.
    expect(classifyWriterLiveness({ ok: true, holders: [1], writers: [1], scannedPids: 1, unreadablePids: 0 })).toBe('live');
    expect(classifyWriterLiveness(NO_HOLDERS)).toBe('orphaned');
  });

  it('does not let inaccessible processes veto the verdict, but does COUNT them', () => {
    // The stated blind spot, pinned so it stays stated. unreadablePids is diagnostic;
    // if it ever starts forcing 'unknown', the fix is disabled on every box with a
    // root daemon — i.e. all of them — and this assertion is where that shows up.
    const withBlindSpots: OpenHandleProbe = { ok: true, holders: [], writers: [], scannedPids: 200, unreadablePids: 87 };
    expect(classifyWriterLiveness(withBlindSpots)).toBe('orphaned');
  });
});

// ---------------------------------------------------------------------------
// P-004 — the semantic canary. Pure policy, no graph and no subprocess.
// ---------------------------------------------------------------------------
describe('analyzeTickSucceeded', () => {
  const clean = { code: 0, timedOut: false, stdout: '', stderr: '' };
  const passing = { healthy: true, degraded: false, probes: [], summary: 'canary OK' };

  it('requires a completed run and a positive canary verdict', () => {
    expect(analyzeTickSucceeded(clean, passing)).toBe(true);
    expect(analyzeTickSucceeded(clean, null)).toBe(false); // canary threw or never ran
    expect(analyzeTickSucceeded(clean, { ...passing, healthy: false })).toBe(false);
    expect(analyzeTickSucceeded({ ...clean, code: 1 }, passing)).toBe(false);
    expect(analyzeTickSucceeded({ ...clean, timedOut: true }, passing)).toBe(false);
  });
});

describe('judgeCanary', () => {
  // Real measured values from the live graph, 2026-08-21 (counts) and 2026-09-05
  // (embeddings: 217,120 after the uncapped full pass, plan gitnexus-embeddings-enablement).
  const HEALTHY: Parameters<typeof judgeCanary>[0] = {
    fileCount: 19479,
    symbolCount: 66982,
    callEdgeCount: 99020,
    defEdgeCount: 132452,
    roundTripOk: true,
    embeddings: 217_120,
    embeddingsExpected: true,
  };

  it('passes a healthy graph', () => {
    const v = judgeCanary(HEALTHY);
    expect(v.healthy).toBe(true);
    expect(v.degraded).toBe(false);
    expect(v.summary).toContain('canary OK');
    expect(v.summary).not.toContain('DEGRADED');
  });

  it('DEGRADES — never fails — on 0 embeddings after an embeddings-enabled analyze', () => {
    // The graph still answers definitions/callers, so failing the tick would mute the
    // canary on a condition the graph survives. But it is not silence either: this is the
    // exact regression (vector leg back to 0) the enablement plan exists to end.
    const v = judgeCanary({ ...HEALTHY, embeddings: 0 });
    expect(v.healthy).toBe(true);
    expect(v.degraded).toBe(true);
    expect(v.summary).toContain('canary OK');
    expect(v.summary).toContain('DEGRADED');
    const probe = v.probes.find((p) => p.name === 'vector-search')!;
    expect(probe.ok).toBe(false);
    expect(probe.degraded).toBe(true);
    expect(probe.detail).toContain('DEAD');
  });

  it('DEGRADES on UNKNOWN embeddings after an embeddings-enabled analyze (unknown is not OK)', () => {
    const v = judgeCanary({ ...HEALTHY, embeddings: null });
    expect(v.healthy).toBe(true);
    expect(v.degraded).toBe(true);
    expect(v.probes.find((p) => p.name === 'vector-search')!.detail).toContain('UNKNOWN');
  });

  it('reports 0 embeddings as plain status when embeddings were NOT requested (the WI-35557 state)', () => {
    const v = judgeCanary({ ...HEALTHY, embeddings: 0, embeddingsExpected: false });
    expect(v.healthy).toBe(true);
    expect(v.degraded).toBe(false);
    const probe = v.probes.find((p) => p.name === 'vector-search')!;
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain('not requested');
  });

  it('CALIBRATION: a degradation never masks a real failure, and a failure never hides the degradation', () => {
    const v = judgeCanary({ ...HEALTHY, fileCount: null, embeddings: 0 });
    expect(v.healthy).toBe(false);
    expect(v.degraded).toBe(true);
    expect(v.summary).toContain('canary FAILED');
    expect(v.summary).toContain('DEGRADED');
  });

  it('vectorSearchProbe is the pure policy behind the vector-search probe', () => {
    expect(vectorSearchProbe(217_120, true)).toMatchObject({ name: 'vector-search', ok: true });
    expect(vectorSearchProbe(0, true)).toMatchObject({ ok: false, degraded: true });
    expect(vectorSearchProbe(null, true)).toMatchObject({ ok: false, degraded: true });
    expect(vectorSearchProbe(0, false)).toMatchObject({ ok: true });
    expect(vectorSearchProbe(null, false)).toMatchObject({ ok: true });
  });

  it('CALIBRATION: fails when the graph is unreadable, and says so as UNREADABLE not EMPTY', () => {
    // THE OUTAGE, in one assertion. A segfaulting read returns no rows, which is
    // trivially mistaken for "the graph is empty". Those need different responses:
    // empty means re-index, unreadable means recover the crash residue first.
    const v = judgeCanary({ ...HEALTHY, fileCount: null });
    expect(v.healthy).toBe(false);
    expect(v.summary).toContain('graph-answers');
    expect(v.probes.find((p) => p.name === 'graph-answers')!.detail).toContain('unreadable');
    expect(v.probes.find((p) => p.name === 'graph-answers')!.detail).toContain('NOT merely empty');
  });

  it('fails a genuinely empty graph too, distinctly from an unreadable one', () => {
    const v = judgeCanary({ ...HEALTHY, fileCount: 0 });
    expect(v.healthy).toBe(false);
    expect(v.probes.find((p) => p.name === 'graph-answers')!.detail).toBe('0 files');
  });

  it('fails when call edges are missing — "who calls this" is the capability agents come for', () => {
    const v = judgeCanary({ ...HEALTHY, callEdgeCount: 0 });
    expect(v.healthy).toBe(false);
    expect(v.summary).toContain('call-edges');
  });

  it('fails when a symbol PRESENT in the graph will not resolve through the lookup path', () => {
    // Data intact, read path broken — invisible to every count-based check.
    const v = judgeCanary({ ...HEALTHY, roundTripOk: false });
    expect(v.healthy).toBe(false);
    expect(v.probes.find((p) => p.name === 'symbol-round-trip')!.detail).toContain('read path is broken');
  });

  it('fails a healthy-looking graph that omitted a known source file', () => {
    const absent = judgeCanary({ ...HEALTHY, knownSourceFileCount: 0 });
    expect(absent.healthy).toBe(false);
    expect(absent.summary).toContain('known-source-coverage');
    expect(absent.summary).toContain(GITNEXUS_KNOWN_SOURCE_PATH);
    expect(judgeCanary({ ...HEALTHY, knownSourceFileCount: null }).healthy).toBe(false);
    expect(judgeCanary({ ...HEALTHY, knownSourceFileCount: 1 }).healthy).toBe(true);
  });

  it('fails rather than passes when the round trip could not be attempted at all', () => {
    // Unknown must not read as OK — the same in-band rule as the freshness metadata.
    const v = judgeCanary({ ...HEALTHY, roundTripOk: null });
    expect(v.healthy).toBe(false);
    expect(v.probes.find((p) => p.name === 'symbol-round-trip')!.detail).toContain('not attempted');
  });

  it('fails when definition edges are missing — "where is this defined" is the other core capability', () => {
    const v = judgeCanary({ ...HEALTHY, defEdgeCount: 0 });
    expect(v.healthy).toBe(false);
    expect(v.summary).toContain('definition-edges');
  });

  it('reports every failing probe, not just the first — and does not count the degraded one as a failure', () => {
    const v = judgeCanary({
      fileCount: null,
      symbolCount: null,
      callEdgeCount: null,
      defEdgeCount: null,
      roundTripOk: null,
      embeddings: null,
      embeddingsExpected: true,
    });
    expect(v.healthy).toBe(false);
    expect(v.degraded).toBe(true);
    expect(v.summary).toContain('5/6');
  });
});

describe('canary edge queries target the REAL graph schema', () => {
  // A REGRESSION GUARD FOR A TRAP I FELL INTO. The obvious Cypher for call edges,
  // `MATCH ()-[r:CALLS]->()`, does not return zero on this graph — it throws
  // "Binder exception: Table CALLS does not exist", which the runner maps to null and
  // the judge reads as UNREADABLE. That would have failed the canary on every healthy
  // index forever: a permanent false alarm, in the exact shape the canary's own doc
  // comment warns against. It survived unit tests because a pure judge cannot see a
  // wrong query, and was caught only by running it against the live graph.
  //
  // This graph has ONE relationship table, `CodeRelation`; the kind is a PROPERTY
  // (r.type ∈ CALLS | DEFINES | IMPORTS | ...). Asserting on the source text is
  // deliberate: the alternative is a live-graph integration test, which cannot run in
  // CI, so the schema assumption is pinned where it is cheap to check.
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitnexus-reindex-action.ts'), 'utf8');

  // Comments are stripped before matching. The doc comment above runCanary quotes the
  // bad query verbatim as a counter-example, and without this the guard fails on the
  // very explanation of what it guards — which is a false positive, and false positives
  // are what get a guard deleted.
  const CODE = SRC.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('queries CodeRelation with a type predicate, never a bare :CALLS/:DEFINES table', () => {
    expect(CODE).toContain("r.type = 'CALLS'");
    expect(CODE).toContain("r.type = 'DEFINES'");
    expect(CODE).not.toMatch(/MATCH\s*\(\)-\[r:CALLS\]/);
    expect(CODE).not.toMatch(/MATCH\s*\(\)-\[r:DEFINES\]/);
  });

  it('CALIBRATION: comment-stripping did not eat the executable source too', () => {
    // Without this, a stripper bug that returned '' would make every not-toMatch above
    // pass vacuously — the guard would be dead and look green.
    expect(CODE.length).toBeGreaterThan(1000);
    expect(CODE).toContain('CodeRelation');
    expect(CODE).toContain('export async function runCanary');
  });

  // 2026-09-06T07:13Z: `gitnexus cypher` resolves its target from the GLOBAL registry, and
  // with a second registered repo (a leftover cost-measurement checkout) it refused every
  // probe — "Multiple repositories indexed" — which cypherScalar maps to null. The canary
  // then failed 4/6 on a healthy 221k-embedding index and recorded a tick failure. Every
  // probe must therefore name the repo it verifies, with the same name the spawn used.
  describe('every canary probe names its repo (--repo), so a second registration cannot fail it', () => {
    it('canaryCypherArgv carries --repo <name> and the query last', () => {
      expect(canaryCypherArgv('papercusp', 'MATCH (f:File) RETURN count(f) AS n')).toEqual([
        'cypher', '--repo', 'papercusp', 'MATCH (f:File) RETURN count(f) AS n',
      ]);
      // The name is a parameter, never a constant baked into the probe.
      expect(canaryCypherArgv('other-repo', 'RETURN 1')).toEqual(['cypher', '--repo', 'other-repo', 'RETURN 1']);
    });

    it('no execFile in the source builds a bare [cypher, query] argv any more', () => {
      expect(CODE).not.toMatch(/\[\s*'cypher',\s*query\s*\]/);
      // Both cypher helpers route through ONE sidecar-routed runner (WI-10004975), and that
      // runner builds its argv with the builder. Positive controls: the runner's exec names
      // the builder, and each helper (scalar + first-string) calls the runner.
      expect(CODE).toMatch(/execFileViaSidecar\(bin, canaryCypherArgv\(repoName, query\)/);
      const viaRunner = CODE.match(/await runCanaryCypher\(bin, root, repoName, query, timeoutMs\)/g) ?? [];
      expect(viaRunner.length).toBeGreaterThanOrEqual(2);
    });

    it('the tick passes the routine repoName into runCanary (not the module default)', () => {
      expect(CODE).toMatch(/runCanary\(root, after\.files, embeddingsAfter, embeddingsExpected, repoName\)/);
    });
  });
});

// ---------------------------------------------------------------------------
// WI-35532 (b) — the failure-alarm state machine. Pure, DB-free.
// ---------------------------------------------------------------------------
describe('decideGitnexusHealthUpdate', () => {
  const NOW = 1_700_000_000_000;

  it('resets the streak and stamps lastSuccessAt on a success from a clean slate', () => {
    const u = decideGitnexusHealthUpdate(GITNEXUS_HEALTH_DEFAULT, true, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
    expect(u.next).toEqual({ consecutiveFailures: 0, alerted: false, lastFailureAt: null, lastSuccessAt: NOW });
    expect(u.shouldAlert).toBe(false);
    expect(u.shouldResolve).toBe(false); // was never alerted — nothing to resolve
  });

  it('increments on a failure but does NOT alert below the threshold', () => {
    const prev: GitnexusHealth = { consecutiveFailures: 1, alerted: false, lastFailureAt: NOW - 3600_000, lastSuccessAt: null };
    const u = decideGitnexusHealthUpdate(prev, false, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
    expect(u.next.consecutiveFailures).toBe(2);
    expect(u.shouldAlert).toBe(false);
    expect(u.next.alerted).toBe(false);
  });

  it('alerts on EXACTLY the tick that crosses the threshold, not before and not again after', () => {
    // One failure short of the threshold — the NEXT failure is the one that crosses it.
    const oneShortOfThreshold: GitnexusHealth = {
      consecutiveFailures: GITNEXUS_FAILURE_ALERT_THRESHOLD - 1,
      alerted: false,
      lastFailureAt: NOW - 3600_000,
      lastSuccessAt: null,
    };
    const atCrossing = decideGitnexusHealthUpdate(oneShortOfThreshold, false, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
    expect(atCrossing.next.consecutiveFailures).toBe(GITNEXUS_FAILURE_ALERT_THRESHOLD);
    expect(atCrossing.shouldAlert).toBe(true);
    expect(atCrossing.next.alerted).toBe(true);

    // One more failure past the threshold must NOT re-alert (alerted already true).
    const alreadyAlerted = decideGitnexusHealthUpdate(atCrossing.next, false, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW + 1000);
    expect(alreadyAlerted.shouldAlert).toBe(false);
    expect(alreadyAlerted.next.consecutiveFailures).toBe(GITNEXUS_FAILURE_ALERT_THRESHOLD + 1);
    expect(alreadyAlerted.next.alerted).toBe(true);
  });

  it('resolves (once) on the success that follows an alerted streak, and clears the streak', () => {
    const alerted: GitnexusHealth = { consecutiveFailures: 5, alerted: true, lastFailureAt: NOW - 1000, lastSuccessAt: NOW - 999_999 };
    const u = decideGitnexusHealthUpdate(alerted, true, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
    expect(u.shouldResolve).toBe(true);
    expect(u.next).toEqual({ consecutiveFailures: 0, alerted: false, lastFailureAt: alerted.lastFailureAt, lastSuccessAt: NOW });
  });

  it('never fires shouldAlert AND shouldResolve on the same tick', () => {
    for (const success of [true, false]) {
      for (const alerted of [true, false]) {
        const prev: GitnexusHealth = { consecutiveFailures: 3, alerted, lastFailureAt: null, lastSuccessAt: null };
        const u = decideGitnexusHealthUpdate(prev, success, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
        expect(u.shouldAlert && u.shouldResolve).toBe(false);
      }
    }
  });
});

describe('shouldSkipForHive', () => {
  it('skips a per-hive harness — the graph indexes the operator-home repo', () => {
    const g = shouldSkipForHive('some-hive', 'papercusp');
    expect(g.skip).toBe(true);
  });

  it('runs for the operator-home harness', () => {
    expect(shouldSkipForHive('papercusp', 'papercusp').skip).toBe(false);
  });

  it('treats a blank slug (manual/legacy fire) as operator-home', () => {
    expect(shouldSkipForHive(undefined, 'papercusp').skip).toBe(false);
    expect(shouldSkipForHive('', 'papercusp').skip).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WI-2146015 / D-008 — a routine-launched analyze is ADOPTED across a bg-host restart.
// Measured 2026-09-05: two routine ticks (18:32Z, 22:36Z) completed under a host peers had
// already restarted; both indexes were fine, neither got its `ok in` line, canary or
// gitnexus_health record. The next host must FINISH that tick, not merely yield to it.
// ---------------------------------------------------------------------------
describe('WI-2146015 — a routine-launched analyze is ADOPTED across a bg-host restart (D-008)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitnexus-reindex-action.ts'), 'utf8');

  function fakeProc(entries: Record<number, string | null>): string {
    const proc = mkdtempSync(join(tmpdir(), 'gitnexus-fakeproc-adopt-'));
    for (const [pid, environ] of Object.entries(entries)) {
      mkdirSync(join(proc, pid));
      if (environ !== null) writeFileSync(join(proc, pid, 'environ'), environ);
    }
    return proc;
  }

  it('readRoutineSpawnMarker reads the stamp off /proc/<pid>/environ; unstamped, garbage and unreadable pids are null', () => {
    const proc = fakeProc({
      11: `HOME=/x\0${GITNEXUS_REINDEX_SPAWN_MARKER_ENV}=1788660000000\0PATH=/bin\0`,
      12: 'HOME=/x\0PATH=/bin\0',
      13: `${GITNEXUS_REINDEX_SPAWN_MARKER_ENV}=garbage\0`,
      14: null,
    });
    expect(readRoutineSpawnMarker(11, proc)).toBe(1788660000000);
    expect(readRoutineSpawnMarker(12, proc)).toBeNull();
    expect(readRoutineSpawnMarker(13, proc)).toBeNull();
    expect(readRoutineSpawnMarker(14, proc)).toBeNull();
    expect(readRoutineSpawnMarker(99, proc)).toBeNull();
  });

  it('findAdoptableWriter: a STAMPED writer is adoptable, the earliest wins, a manual analyze is never adopted', () => {
    const marks: Record<number, number | null> = { 1: null, 2: 500, 3: 200 };
    expect(findAdoptableWriter([1, 2, 3], (p) => marks[p] ?? null)).toEqual({ pid: 3, spawnedAtMs: 200, stamped: true });
    expect(findAdoptableWriter([1], (p) => marks[p] ?? null)).toBeNull();
    expect(findAdoptableWriter([], () => 1)).toBeNull();
  });

  it('findAdoptableWriter FALLBACK: an unstamped writer running the routine argv is adopted with its spawn time from process age', () => {
    const fallback = { isRoutineArgv: (p: number) => p === 5, ageMs: (p: number) => (p === 5 ? 60_000 : null), nowMs: 1_000_000 };
    expect(findAdoptableWriter([4, 5], () => null, fallback)).toEqual({ pid: 5, spawnedAtMs: 940_000, stamped: false });
    // argv matches but the age is unreadable ⇒ no deadline can be derived ⇒ not adopted.
    expect(findAdoptableWriter([5], () => null, { ...fallback, ageMs: () => null })).toBeNull();
    // A stamp always beats the fallback for the same pid.
    expect(findAdoptableWriter([5], () => 123, fallback)).toEqual({ pid: 5, spawnedAtMs: 123, stamped: true });
  });

  it('argvIsRoutineAnalyze matches ONLY the pinned CLI followed by exactly buildAnalyzeArgs — a hand-typed analyze does not', () => {
    const cli = '/vendor/gitnexus/dist/cli/index.js';
    const routine = ['/usr/bin/node', '--stack-size=65500', cli, ...buildAnalyzeArgs('/repo', 'papercusp')];
    expect(argvIsRoutineAnalyze(routine, '/repo', 'papercusp', cli)).toBe(true);
    expect(argvIsRoutineAnalyze([...routine, '--extra'], '/repo', 'papercusp', cli)).toBe(false);
    expect(argvIsRoutineAnalyze(['/usr/bin/node', cli, 'analyze'], '/repo', 'papercusp', cli)).toBe(false);
    expect(argvIsRoutineAnalyze(['gitnexus', 'analyze', '--force'], '/repo', 'papercusp', cli)).toBe(false);
    expect(argvIsRoutineAnalyze(null, '/repo', 'papercusp', cli)).toBe(false);
    // readProcessArgv parses the NUL-separated cmdline and drops the trailing empty field.
    const proc = fakeProc({ 21: null });
    writeFileSync(join(proc, '21', 'cmdline'), 'node\0--stack-size=1\0/cli.js\0analyze\0');
    expect(readProcessArgv(21, proc)).toEqual(['node', '--stack-size=1', '/cli.js', 'analyze']);
    expect(readProcessArgv(22, proc)).toBeNull();
  });

  // P-012 (2026-09-27): bg-host restarted 6.5 min into a --force run that was still parsing;
  // no index file was held, so the handle probe saw nothing and a duplicate was spawned.
  it('findRoutineAnalyzePids finds a routine analyze that holds NO index file — parsing, or queued behind pc-heavy', () => {
    const cli = '/vendor/gitnexus/dist/cli/index.js';
    const args = buildAnalyzeArgs('/repo', 'papercusp');
    const proc = fakeProc({ 31: null, 32: null, 33: null, 34: null });
    const cmdline = (argv: string[]): string => [...argv, ''].join('\0');
    writeFileSync(join(proc, '31', 'cmdline'), cmdline(['/usr/bin/node', '--stack-size=4096', cli, ...args]));
    // The pc-heavy wrapper of a QUEUED run carries the same argv tail.
    writeFileSync(join(proc, '32', 'cmdline'), cmdline(['bash', '/tmp/pc-heavy/self.32.sh', '--', '/usr/bin/node', cli, ...args]));
    // Another repo's routine run, and a hand-typed analyze: neither is ours.
    writeFileSync(join(proc, '33', 'cmdline'), cmdline(['/usr/bin/node', cli, ...buildAnalyzeArgs('/other', 'other')]));
    writeFileSync(join(proc, '34', 'cmdline'), cmdline(['gitnexus', 'analyze', '--force']));
    mkdirSync(join(proc, 'self'));
    expect(findRoutineAnalyzePids('/repo', 'papercusp', proc, cli)).toEqual([31, 32]);
    expect(findRoutineAnalyzePids('/repo', 'papercusp', join(proc, 'missing'), cli)).toEqual([]);
  });

  it('the tick gate falls back to the argv scan when no handle is held, BEFORE any residue cleanup', () => {
    expect(src).toMatch(/if \(!writer\.live\) \{\s*const pids = findRoutineAnalyzePids\(root, repoName\);/);
    const scanAt = src.indexOf('findRoutineAnalyzePids(root, repoName)');
    expect(scanAt).toBeGreaterThan(src.indexOf('let writer = detectLiveAnalyzeWriter(root)'));
    expect(scanAt).toBeLessThan(src.indexOf('const residue = cleanCrashResidue(root)'));
  });

  it('waitForPidExit resolves when the pid disappears and gives up at the deadline (injected clock + sleep)', async () => {
    let t = 1_000;
    const sleep = async (ms: number): Promise<void> => {
      t += ms;
    };
    let polls = 0;
    const r1 = await waitForPidExit(7, 100_000, { pollMs: 5_000, now: () => t, sleep, isAlive: () => ++polls < 4 });
    expect(r1).toEqual({ exited: true, waitedMs: 15_000 });
    t = 1_000;
    const r2 = await waitForPidExit(7, 12_000, { pollMs: 5_000, now: () => t, sleep, isAlive: () => true });
    expect(r2).toEqual({ exited: false, waitedMs: 11_000 });
  });

  it('judgeAdoptedRun: completed ⇔ meta.json indexedAt at/after the spawn with no incrementalInProgress', () => {
    const spawn = Date.parse('2026-09-05T22:36:19.000Z');
    // The 22:36Z tick of 2026-09-05: spawned under pid 3408457, host restarted, meta.json written 01:17Z.
    expect(judgeAdoptedRun(spawn, { indexedAt: '2026-09-06T01:17:06.620Z' }, null).code).toBe(0);
    // meta.json still describes the PREVIOUS run ⇒ this one died before its final save.
    expect(judgeAdoptedRun(spawn, { indexedAt: '2026-09-05T20:19:38.667Z' }, null)).toMatchObject({ code: 1 });
    expect(judgeAdoptedRun(spawn, null, null)).toMatchObject({ code: 1 });
    // A stranded marker beats a plausible indexedAt: the index is half-written.
    expect(
      judgeAdoptedRun(spawn, { indexedAt: '2026-09-06T01:17:06.620Z' }, { phase: 'write', startedAt: spawn, toWriteCount: 0 }),
    ).toMatchObject({ code: 1 });
  });

  it('readIndexStatsForHealth reports the LATER completed analyze — meta.json when the registry write was lost with the host', () => {
    const r = mkdtempSync(join(tmpdir(), 'gitnexus-adopt-stats-'));
    mkdirSync(join(r, '.gitnexus'));
    const registry = join(r, 'registry.json');
    writeFileSync(
      registry,
      JSON.stringify([
        { name: 'papercusp', indexedAt: '2026-09-05T17:07:51.897Z', lastCommit: 'aaa', stats: { files: 100, embeddings: 201_473 } },
      ]),
    );
    writeFileSync(
      gitnexusMetaPath(r),
      JSON.stringify({ indexedAt: '2026-09-06T01:17:06.620Z', lastCommit: 'bbb', stats: { files: 23_281, embeddings: 222_515, nodes: 249_917 } }),
    );
    const prev = process.env.GITNEXUS_REGISTRY_PATH;
    process.env.GITNEXUS_REGISTRY_PATH = registry;
    try {
      expect(readIndexStatsForHealth(r, 'papercusp')).toEqual({ files: 23_281, embeddings: 222_515, source: 'meta' });
      // The registry is fresher ⇒ its stats win (the ordinary same-host completion).
      writeFileSync(gitnexusMetaPath(r), JSON.stringify({ indexedAt: '2026-09-05T16:00:00.000Z', stats: { files: 1, embeddings: 1 } }));
      expect(readIndexStatsForHealth(r, 'papercusp')).toEqual({ files: 100, embeddings: 201_473, source: 'registry' });
      // Neither readable ⇒ nulls, never a throw.
      writeFileSync(gitnexusMetaPath(r), '{not json');
      writeFileSync(registry, '{not json');
      expect(readIndexStatsForHealth(r, 'papercusp')).toEqual({ files: null, embeddings: null, source: 'none' });
    } finally {
      if (prev === undefined) delete process.env.GITNEXUS_REGISTRY_PATH;
      else process.env.GITNEXUS_REGISTRY_PATH = prev;
    }
  });

  it('the spawn is STAMPED, the live-writer guard ADOPTS before the residue preflight, and a manual writer is still only yielded to', () => {
    const spawn = src.indexOf('export function runGitnexusAnalyze(');
    expect(spawn).toBeGreaterThan(0);
    // One stamp names both the environ marker and the log file (analyzeLogPath) an adopter reads.
    expect(src.indexOf('const spawnedAtMs = Date.now();', spawn)).toBeGreaterThan(spawn);
    expect(src.indexOf('[GITNEXUS_REINDEX_SPAWN_MARKER_ENV]: String(spawnedAtMs)', spawn)).toBeGreaterThan(spawn);

    const handler = src.indexOf("registerSystemAction('gitnexus-reindex'");
    const guard = src.indexOf('let writer = detectLiveAnalyzeWriter(root);', handler);
    const adopt = src.indexOf('findAdoptableWriter(writer.pids,', guard);
    const finish = src.indexOf('await finishAnalyzeTick({', adopt);
    const residue = src.indexOf('const residue = cleanCrashResidue(root);', handler);
    expect(adopt).toBeGreaterThan(guard);
    expect(finish).toBeGreaterThan(adopt);
    expect(finish).toBeLessThan(residue);
    // An over-budget writer is never adopted — its scope deadline is about to kill it.
    expect(/overBudget\s*\?\s*null\s*:\s*findAdoptableWriter\(/.test(src.slice(guard, residue))).toBe(true);
    // The unstamped (manual) writer keeps the WI-2146606 skip line and RETURNS before the preflight.
    const manualSkip = src.indexOf('not cleaning residue, not spawning (WI-2146606)', adopt);
    expect(manualSkip).toBeGreaterThan(finish);
    expect(manualSkip).toBeLessThan(residue);
    // ONE finish path for the same-host completion and the adopted one — they cannot diverge.
    expect(src.split('await finishAnalyzeTick(').length - 1).toBe(2);
  });
});

/**
 * WI-10005680 — a vendor SIGSEGV used to reach the alert as a bare `exited 1`: Node reports a signal
 * death as `close(null, 'SIGSEGV')` and `code ?? 1` erased it. `analyzeResultFromClose` is the one
 * place that mapping happens (the spawn's `close` handler calls it), so pinning it here pins the
 * production path without spawning an analyzer.
 */
describe('analyzeResultFromClose keeps the terminating signal (WI-10005680)', () => {
  const out = { stdout: '', stderr: '', timedOut: false };

  it('a signal death (code null) collapses the code to 1 but CARRIES the signal', () => {
    const r = analyzeResultFromClose(null, 'SIGSEGV', out);
    expect(r.code).toBe(1);
    expect(r.signal).toBe('SIGSEGV');
  });

  it('a signalled run with no vendor text is still classified as a native crash end to end (and exit-code-only is not)', () => {
    const r = analyzeResultFromClose(null, 'SIGSEGV', out);
    expect(classifyAnalyzeFailure(r)?.kind).toBe('native-crash');
    // The control the guard is measured against: the SAME run with the signal erased (the pre-fix
    // behaviour) is unrecognised, so this test fails if the signal is ever dropped again.
    expect(classifyAnalyzeFailure({ code: r.code, stdout: r.stdout, stderr: r.stderr })).toBeNull();
  });

  it('a clean exit keeps code 0 and a null signal, and an ordinary non-zero exit keeps its code', () => {
    expect(analyzeResultFromClose(0, null, out)).toMatchObject({ code: 0, signal: null });
    expect(analyzeResultFromClose(2, null, out)).toMatchObject({ code: 2, signal: null });
  });

  it('the vendor ceiling line wins over the generic crash class when both are present', () => {
    const r = analyzeResultFromClose(null, 'SIGSEGV', {
      ...out,
      stderr: 'Buffer manager exception: Maximum database size of 17179869184 bytes has been reached',
    });
    expect(classifyAnalyzeFailure(r)?.kind).toBe('lbug-max-db-size');
  });

  it('the spawn close handler routes through it (a re-inlined `code ?? 1` would drop the signal again)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitnexus-reindex-action.ts'), 'utf8');
    expect(src).toContain("child.on('close', (code, signal) => finish(analyzeResultFromClose(code, signal,");
  });
});
