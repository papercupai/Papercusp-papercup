/**
 * Every worker script that resolves its own path NEXT TO the executing module
 * must be staged beside the entry by EVERY bundler that produces one.
 *
 * WHY THIS GUARD EXISTS. This failure has now happened FOUR times, each time to
 * a different worker or a different bundler, and every time silently:
 *
 *  - WI-4196 — `local-embedder-worker.script.mjs` missing from the host bundle,
 *    so every embed fell back to inline main-thread ONNX (~6s vs ~36ms).
 *  - EI-19465075959589134 — `cpu-task-worker.script.mjs`, same class, labelled
 *    in bundle-host.sh itself as "SAME CLASS AS WI-4196 ABOVE, missed for this
 *    worker". :3170 ran at p95 1920ms, 87.5% GC, for an unknown period.
 *  - WI-37555 — `local-reranker-worker.script.mjs`, added with this test.
 *  - WI-37555 again, and this is the one that motivates the SECOND bundler
 *    below: the DESKTOP sidecar build (`build-desktop-sidecar.sh`) copied NONE
 *    of them. Measured on the 2026-08-09 06:06 build, `serve.mjs` referenced
 *    `local-embedder-worker.script.mjs` while no `*.script.mjs` existed beside
 *    it at all — so WI-4196's fix had never reached a packaged desktop install,
 *    the actual shipping target.
 *
 * The shape is always identical and is why hand-memory keeps losing to it:
 * `new Worker(resolve(dirname(here), '…script.mjs'))` works perfectly in the dev
 * tree (the script IS next to the module) and fails only in a BUNDLE, where
 * esbuild emits no sibling non-JS assets. Every one of these workers has a
 * deliberate inline fallback, so the failure never throws, never logs by
 * default, and reads as "working, just slow".
 *
 * The invariant is anchored to the PROPERTY that defines membership — a
 * `*.script.mjs` living in a source tree, checked against every bundler — not to
 * a hand-kept list of known workers, which is the form-blind mistake that let
 * instances two and four through.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { join, relative, resolve } from 'node:path';
import { testImportClosures } from './agent-tools/testing/mutation-probe-fence';
import { localEsbuildNpxPath } from './test-fixtures/local-esbuild-npx';

const REPO_ROOT = resolve(__dirname, '../../..');

/** Overridable so falsifiability can be proven against a COPY outside the tree
 *  (`scripts/mutation-probe.sh`) instead of mutating the shared checkout, where
 *  git-sync would commit the mutant mid-probe. */
const BUNDLERS: { label: string; path: string }[] = [
  {
    label: 'apps/operator/bin/bundle-host.sh (host + operator sidecar bundles)',
    path: process.env.PROBE_BUNDLE_SCRIPT ?? join(REPO_ROOT, 'apps/operator/bin/bundle-host.sh'),
  },
  {
    label: 'papercusp-desktop/bin/build-desktop-sidecar.sh (packaged desktop app)',
    path:
      process.env.PROBE_DESKTOP_SCRIPT ??
      join(REPO_ROOT, 'papercusp-desktop/bin/build-desktop-sidecar.sh'),
  },
  {
    label: 'papercusp-desktop/bin/vm-rig/compose-rig-sidecar-current.sh (current-build rig)',
    path: join(REPO_ROOT, 'papercusp-desktop/bin/vm-rig/compose-rig-sidecar-current.sh'),
  },
];

/** Worker entries whose source is TypeScript and whose bundlers must run an
 * esbuild pass instead of copying a sibling `.script.mjs` asset. */
const ESBUILD_WORKERS: { source: string; output: string }[] = [
  {
    source: 'packages/operator-core/lib/event-loop-sentinel.worker.ts',
    output: 'event-loop-sentinel.worker.mjs',
  },
  {
    source: 'packages/operator-core/lib/sync/hyperbee/snapshot-fold.worker.ts',
    output: 'snapshot-fold.worker.mjs',
  },
  {
    source: 'packages/operator-core/lib/agent-tools/testing/mutation-probe-closure.worker.ts',
    output: 'mutation-probe-closure.worker.mjs',
  },
  {
    // WI-10005223: frozen-repair admission git off the operator main thread.
    source: 'packages/operator-core/lib/release/admission-jobs.worker.ts',
    output: 'admission-jobs.worker.mjs',
  },
  {
    source: 'packages/operator-core/lib/memory/bench/precision-bench-worker.ts',
    output: 'precision-bench-worker.mjs',
  },
  {
    // WI-10006543: graph:query callers, one forked process per question.
    source: 'packages/operator-core/lib/code-intelligence/first-party-callers.worker.ts',
    output: 'first-party-callers.worker.mjs',
  },
  {
    // WI-10005186: keep Codex-home filesystem materialization off request loops.
    source: 'packages/operator-core/lib/role-codex-home.worker.ts',
    output: 'role-codex-home.worker.mjs',
  },
  {
    // WI-6554700010030353: the resident full-window co-change index, one child per repository.
    source: 'packages/operator-core/lib/code-intelligence/warm-cochange-index.worker.ts',
    output: 'warm-cochange-index.worker.mjs',
  },
];

/**
 * Required sibling runtime assets that do not use the `*.script.mjs` worker
 * naming convention and therefore cannot be discovered by findWorkerScripts.
 *
 * EI-21306004866205635: systemd-scope.ts resolves this file with
 * `new URL('./systemd-scope-env-runner.mjs', import.meta.url)`.  That works in
 * the source tree and fails only after esbuild collapses operator-core into a
 * different directory.  The release host then accepted systemd units whose
 * payloads immediately failed MODULE_NOT_FOUND; every cluster worker retried
 * its spawner sidecar and the MCP proxy repeatedly exhausted its 8s upstream
 * header budget.  Both bundlers must publish the asset beside their entry.
 */
const BUNDLE_HOST_COMMON = join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh');

/**
 * DERIVED from the shared recipe's HOST_RUNTIME_SIBLING_SOURCES, not a second
 * hand-kept copy: this list used to name only the systemd runner, so a builder
 * that dropped git-ext-bridge.mjs stayed green while every same-box hive-git
 * fetch died "Cannot find module" (WI-10003976). The positive-control test
 * below keeps a broken parse from making every assertion vacuous.
 */
function runtimeSiblingAssets(): { source: string; output: string }[] {
  const text = readFileSync(BUNDLE_HOST_COMMON, 'utf8');
  const block = /^HOST_RUNTIME_SIBLING_SOURCES=\(([\s\S]*?)^\)/m.exec(text)?.[1] ?? '';
  return block
    .split(/\s+/)
    .filter((token) => token && !token.startsWith('#'))
    .map((source) => ({ source, output: source.slice(source.lastIndexOf('/') + 1) }));
}
const REQUIRED_RUNTIME_SIBLING_ASSETS = runtimeSiblingAssets();

/** Directories holding BUILD OUTPUT or vendored code, where a `*.script.mjs` is
 *  a COPY produced by the very step under test — counting those would let this
 *  guard pass by observing its own output. */
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-host',
  'dist-sidecar',
  '.next',
  'build',
  'out',
  'target',
  '_retired',
  'sidecar',
  'env-sidecars',
  'coverage',
  // Gitignored agent state: scratch probes and isolation worktrees, never this
  // tree's sources. Measured 2026-10-01: a peer's
  // .papercusp/scratch/wi5070-worker-unload.script.mjs turned all three
  // "stages every source *.script.mjs" cases red in the shared tree only.
  '.papercusp',
]);

function findWorkerScripts(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) findWorkerScripts(full, found);
    else if (entry.endsWith('.script.mjs')) found.push(full);
  }
  return found;
}

/**
 * Lines that actually DO something — comments stripped.
 *
 * A bare `includes(basename)` over the whole file is satisfied by a comment
 * MENTIONING the worker, so it would pass for a script that is documented but
 * never copied. Verified under mutation-probe: deleting the rerank `cp` left the
 * basename sitting in its own explanatory comment, and a whole-file check did
 * NOT go red. Stripping comments is what makes the check mean "is staged"
 * rather than "is discussed" — while still accepting BOTH staging forms in use
 * (a literal `cp … "$OUTDIR/<name>"`, and a loop over a list of source paths).
 */
function executableText(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function bundlerExecutable(file: string): string {
  const source = executableText(readFileSync(file, 'utf8'));
  // A shared recipe counts only when the caller actually sources and invokes it.
  if (/^source .*bundle-host-common\.sh/m.test(source) && /^bundle_host_workers /m.test(source)) {
    return source + '\n' + executableText(readFileSync(join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh'), 'utf8'));
  }
  return source;
}

/** The sibling stager counts only when this builder sources AND invokes it —
 *  bundle_host_workers alone must not lend a builder the sibling names. */
function siblingExecutable(file: string): string {
  const source = executableText(readFileSync(file, 'utf8'));
  if (/^source .*bundle-host-common\.sh/m.test(source) && /^bundle_host_runtime_siblings /m.test(source)) {
    return source + '\n' + executableText(readFileSync(BUNDLE_HOST_COMMON, 'utf8'));
  }
  return source;
}

describe('shared worker recipe executes in the bundled plain-node runtime', () => {
  let output: string;
  let gateMeta: string;
  let compilerPath: string;
  let buildOutput: string;
  const recipe = join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh');
  const build = (extraEnv: NodeJS.ProcessEnv = {}, subject = recipe, destination = output) => spawnSync('bash', [
    '-c', 'set -euo pipefail; source "$1"; bundle_host_workers "$2" "$3" "${PAPERCUSP_EMBED_WORKER_SCRIPT:-}"', 'worker-recipe-test', subject, REPO_ROOT, destination,
  ], {
    cwd: REPO_ROOT,
    // The pinned fixture resolves once before this build. Exercise the recipe's
    // lease calls in a private domain, so real maintenance cannot delay it.
    env: { ...process.env, PATH: compilerPath, PAPERCUSP_FS_MUTEX_LOCK_DIR: join(output, 'package-cache-locks'),
      PAPERCUSP_EMBED_WORKER_SCRIPT: '', BUNDLE_HOST_GATE_META_DIR: join(destination, 'missing-gate-meta'), ...extraEnv },
    encoding: 'utf8',
    timeout: 30_000,
  });

  beforeAll(() => {
    output = mkdtempSync(join(tmpdir(), 'bundled-workers-'));
    compilerPath = localEsbuildNpxPath(join(output, 'local-compiler'), REPO_ROOT);
    // EI-24917607035361603: the real staging caller set this path without
    // creating it. Exercise that boundary in the same real worker build.
    gateMeta = join(output, 'missing-gate-meta');
    expect(existsSync(gateMeta)).toBe(false);
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(output, 'node_modules'), 'dir');
    const result = build();
    expect(result.error, `worker fixture signal=${result.signal}; ${result.stdout + result.stderr}`).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    buildOutput = result.stdout + result.stderr;
  }, 40_000);

  afterAll(() => {
    if (output) rmSync(output, { recursive: true, force: true });
  });

  // WI-6554700010020817 made cpu-task-worker.script.mjs an esbuild compile (its own branch in
  // bundle_host_workers), so a `.script.mjs` source can be compiled too. Derive those from the
  // recipe rather than hand-count them: a hand count went stale the day that branch landed.
  const esbuiltScriptWorkers = () => [...readFileSync(recipe, 'utf8')
    .matchAll(/if \[ "\$output" = "([^"]+\.script\.mjs)" \]; then\n(?:.*\n){0,6}?.*bundle_host_esbuild "\$repo_root" "\$source"/g)]
    .map(match => match[1]!);

  it('holds the shared package-cache reader for every actual worker compiler invocation', () => {
    expect(esbuiltScriptWorkers()).toEqual(['cpu-task-worker.script.mjs']);
    expect((buildOutput.match(/NPM_INSTALL_SAFE guarding package-cache reader:/g) ?? []).length)
      .toBe(ESBUILD_WORKERS.length + esbuiltScriptWorkers().length + 1); // one pin resolution, then every compile
  });

  it('control: successful compilation without the package-cache lease is detected', () => {
    const original = readFileSync(recipe, 'utf8');
    const guarded = 'bundle_host_esbuild "$repo_root" "$source"';
    // One guarded call for the TypeScript loop, one per esbuilt `.script.mjs` branch.
    expect(original.split(guarded)).toHaveLength(2 + esbuiltScriptWorkers().length);
    const subject = join(output, 'recipe-without-cache-lease.sh');
    writeFileSync(subject, original.replaceAll(guarded, 'npx --yes esbuild@0.25.0 "$source"'));
    const result = build({}, subject, join(output, 'cache-lease-control'));
    expect(result.error, `worker control signal=${result.signal}; ${result.stdout + result.stderr}`).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    // A build result alone used to hide the unprotected cache read. The same
    // receipt assertion as the positive case distinguishes the regression.
    expect((result.stdout + result.stderr).match(/NPM_INSTALL_SAFE guarding package-cache reader:/g) ?? [])
      .toHaveLength(0);
  });

  it('creates missing gate metadata and records every copied and bundled worker input', () => {
    const common = readFileSync(recipe, 'utf8');
    const copied = [...common.matchAll(/\$repo_root\/([^"\s}]+\.script\.mjs)/g)]
      .map(match => join(REPO_ROOT, match[1]!));
    const bundled = [...common.matchAll(/"\$repo_root\/([^"]+(?:\.worker|precision-bench-worker)\.ts)"/g)]
      .map(match => join(REPO_ROOT, match[1]!));
    expect(copied.length).toBeGreaterThan(0);
    expect(bundled.length).toBeGreaterThan(0);
    expect(readFileSync(join(gateMeta, 'copied-sources.txt'), 'utf8').trim().split('\n')).toEqual(copied);
    const metafiles = readdirSync(gateMeta).filter(name => name.endsWith('.meta.json'));
    // Every esbuild compile writes a metafile: the TypeScript workers and the esbuilt scripts.
    expect(metafiles.sort()).toEqual([...ESBUILD_WORKERS.map(worker => worker.output), ...esbuiltScriptWorkers()]
      .map(name => `${name}.meta.json`).sort());
    expect(bundled.map(source => relative(REPO_ROOT, source)).sort()).toEqual(ESBUILD_WORKERS.map(worker => worker.source).sort());
    const inputs = metafiles.flatMap(name => Object.keys(JSON.parse(readFileSync(join(gateMeta, name), 'utf8')).inputs))
      .map(path => resolve(REPO_ROOT, path));
    for (const source of bundled) expect(inputs).toContain(source);
  });

  it('stages precision benchmark data fixtures beside the worker entry', () => {
    const sourceDir = join(REPO_ROOT, 'packages/operator-core/lib/memory/bench/fixtures');
    const outputDir = join(output, 'fixtures');
    for (const fixture of ['corpus.v1.json', 'gold-set.v1.json']) {
      expect(readFileSync(join(outputDir, fixture), 'utf8'), fixture)
        .toBe(readFileSync(join(sourceDir, fixture), 'utf8'));
    }
  });

  it('starts the admission worker without executing imported CLI entrypoints', async () => {
    const worker = new Worker(join(output, 'admission-jobs.worker.mjs'), {
      execArgv: [], stdout: true, stderr: true,
    });
    let stdout = '', stderr = '';
    worker.stdout.on('data', (chunk) => { stdout += chunk; });
    worker.stderr.on('data', (chunk) => { stderr += chunk; });
    const message = () => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`admission worker did not respond: ${stdout}${stderr}`)); }, 5_000);
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', received);
        worker.off('error', failed);
        worker.off('exit', exited);
      };
      const received = (value: Record<string, unknown>) => { cleanup(); resolve(value); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const exited = (code: number) => { cleanup(); reject(new Error(`admission worker exited before its response: ${code}; ${stdout}${stderr}`)); };
      worker.once('message', received);
      worker.once('error', failed);
      worker.once('exit', exited);
    });
    try {
      expect(await message()).toEqual({ type: 'ready' });
      const result = message();
      worker.postMessage({ id: 1, job: { kind: 'git', argv: ['rev-parse', '--show-toplevel'], cwd: REPO_ROOT } });
      expect(await result).toMatchObject({ type: 'result', id: 1, ok: true,
        value: { status: 0, stdout: `${REPO_ROOT}\n` } });
    } finally {
      await worker.terminate();
    }
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  }, 15_000);

  it('names a gate metadata directory that cannot be created before publishing workers', () => {
    const blocked = join(output, 'gate-meta-blocked-by-file');
    writeFileSync(blocked, 'not a directory');
    const result = build({ BUNDLE_HOST_GATE_META_DIR: join(blocked, 'meta') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`FATAL: cannot create the restricted-hold gate meta dir ${join(blocked, 'meta')}`);
  });

  it('names the copied source when gate bookkeeping cannot be written', () => {
    const blocked = join(output, 'gate-meta-append-blocked');
    mkdirSync(join(blocked, 'copied-sources.txt'), { recursive: true });
    const result = build({ BUNDLE_HOST_GATE_META_DIR: blocked });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`FATAL: cannot record ${join(REPO_ROOT, 'libs/generic/memory/src/local-embedder-worker.script.mjs')}`);
    expect(result.stderr).toContain(`${join(blocked, 'copied-sources.txt')} for the restricted-hold gate`);
  });

  it('control: omitting only metadata directory creation reproduces the first-worker failure', () => {
    const original = readFileSync(recipe, 'utf8');
    const mkdir = '! mkdir -p "$BUNDLE_HOST_GATE_META_DIR"';
    expect(original.split(mkdir)).toHaveLength(2);
    const subject = join(output, 'recipe-without-gate-mkdir.sh');
    writeFileSync(subject, original.replace(mkdir, '! true'));
    const destination = join(output, 'first-worker-control');
    const meta = join(output, 'absent-control-meta');
    const result = build({ BUNDLE_HOST_GATE_META_DIR: meta }, subject, destination);
    expect(result.status).toBe(1);
    expect(existsSync(join(destination, 'local-embedder-worker.script.mjs'))).toBe(true);
    expect(existsSync(join(destination, 'cpu-task-worker.script.mjs'))).toBe(false);
    expect(result.stderr).toContain(`FATAL: cannot record ${join(REPO_ROOT, 'libs/generic/memory/src/local-embedder-worker.script.mjs')}`);
    expect(existsSync(meta)).toBe(false);
  });

  it('runs snapshot compaction in the emitted worker without a TypeScript loader', async () => {
    const worker = new Worker(join(output, 'snapshot-fold.worker.mjs'), { execArgv: [] });
    const request = (message: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('bundled worker response timed out')); }, 5000);
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
      };
      const onMessage = (response: Record<string, unknown>) => { cleanup(); resolve(response); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      worker.once('message', onMessage);
      worker.once('error', onError);
      worker.postMessage(message);
    });
    try {
      expect(await request({ kind: 'init', id: 1, excludeTables: [] })).toEqual({ kind: 'ok', id: 1 });
      const block = new TextEncoder().encode(JSON.stringify({
        type: 'put', table: 'test', hbKey: 'row', value: { answer: 42 },
        ts: 1, schema_version: 1, author_pubkey: 'test',
      }));
      expect(await request({ kind: 'fold', id: 2, buf: block.buffer.slice(0), lengths: [block.byteLength] }))
        .toMatchObject({ kind: 'folded', decodedOps: 1, keyCount: 1 });
      // P-006 index fold: the scan keeps only positions, so the caller re-reads the
      // winning blocks and hands them back before `finish` can serialize rows.
      expect(await request({ kind: 'pending', id: 3 })).toEqual({ kind: 'pending', id: 3, indexes: [0] });
      expect(await request({
        kind: 'materialize', id: 4, buf: block.buffer.slice(0), lengths: [block.byteLength], indexes: [0], now: 2,
      })).toMatchObject({ kind: 'materialized', remaining: 0 });
      const result = await request({
        kind: 'finish', id: 5, now: 2, coversUpTo: 1, author_pubkey: 'test',
        ts: 2, schema_version: 1, excludeTables: [],
      });
      expect(result).toMatchObject({ kind: 'finished', rowCount: 1 });
      expect(new TextDecoder().decode(result.buf as ArrayBuffer)).toContain('"answer":42');
    } finally {
      await worker.terminate();
    }
  }, 15_000);

  it('runs the emitted closure compiler in plain Node and preserves its import graph', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundled-closure-'));
    writeFileSync(join(dir, 'entry.ts'), 'export { value } from "./subject.ts";');
    writeFileSync(join(dir, 'subject.ts'), 'export const value = 1;');
    try {
      // Exercise the production fork/advanced-IPC door, including its awaited
      // owned-tree cleanup. A thread-only check misses process-entry failures.
      const result = await testImportClosures(dir, [join(dir, 'entry.ts')], {
        workerPath: join(output, 'mutation-probe-closure.worker.mjs'),
      });
      expect(result.status).toBe('complete');
      if (result.status === 'complete') expect(result.files.get(join(dir, 'entry.ts'))).toContain(join(dir, 'subject.ts'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 10_000);

  it('refuses an unavailable required source even when an older bundle exists', () => {
    const before = readFileSync(join(output, 'local-embedder-worker.script.mjs'), 'utf8');
    const result = build({ PAPERCUSP_EMBED_WORKER_SCRIPT: join(output, 'does-not-exist.mjs') });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FATAL: missing runtime worker');
    expect(readFileSync(join(output, 'local-embedder-worker.script.mjs'), 'utf8')).toBe(before);
  });
});

describe('worker scripts are staged beside every bundled entry', () => {
  const scripts = findWorkerScripts(REPO_ROOT);

  it('derived the known runtime-sibling population from the shared recipe', () => {
    expect(REQUIRED_RUNTIME_SIBLING_ASSETS.map(({ output }) => output)).toEqual(
      expect.arrayContaining(['systemd-scope-env-runner.mjs', 'git-ext-bridge.mjs']),
    );
  });

  it('found every explicitly required sibling runtime asset', () => {
    const missingSources = REQUIRED_RUNTIME_SIBLING_ASSETS.filter(
      ({ source }) => !existsSync(resolve(REPO_ROOT, source)),
    );

    expect(
      missingSources,
      'The sibling-asset guard must not go green because a required source disappeared.',
    ).toEqual([]);
  });

  it('found the known esbuild-worker population', () => {
    const missingSources = ESBUILD_WORKERS.filter(({ source }) => !existsSync(resolve(REPO_ROOT, source)));

    expect(
      missingSources,
      'The esbuild-worker guard must not go green because its source population disappeared.',
    ).toEqual([]);
  });

  it('found the known worker-script population', () => {
    // A zero-length scan would make every assertion below vacuously true — the
    // same zero-work false-green this repo has paid for repeatedly (a tsc run
    // checking no files, an affected-tests run selecting no suites).
    expect(scripts.length).toBeGreaterThanOrEqual(3);
  });

  for (const bundler of BUNDLERS) {
    it(`stages every source *.script.mjs — ${bundler.label}`, () => {
      const executable = bundlerExecutable(bundler.path);

      const missing = scripts
        .map((s) => relative(REPO_ROOT, s))
        .filter((rel) => !executable.includes(rel.slice(rel.lastIndexOf('/') + 1)));

      expect(
        missing,
        `These worker scripts are not staged by ${bundler.label}. In the dev tree they resolve ` +
          `fine (the script sits next to its module), so this ONLY breaks in the bundle — and ` +
          `every such worker has an inline fallback, so it degrades SILENTLY to main-thread ` +
          `work instead of failing. Add a copy step next to the existing ones in ` +
          `${relative(REPO_ROOT, bundler.path)}.`,
      ).toEqual([]);
    });

    it(`stages every source esbuild worker — ${bundler.label}`, () => {
      const executable = bundlerExecutable(bundler.path);

      const missing = ESBUILD_WORKERS.filter(({ output }) => !executable.includes(output));

      expect(
        missing.map(({ source, output }) => `${source} → ${output}`),
        `These TypeScript workers are not esbuild-staged by ${bundler.label}. ` +
          'They cannot load in the packaged plain-node runtime when copied as .ts.',
      ).toEqual([]);
    });

    it(`stages every required sibling runtime asset — ${bundler.label}`, () => {
      const executable = siblingExecutable(bundler.path);
      const missing = REQUIRED_RUNTIME_SIBLING_ASSETS.filter(
        ({ output }) => !executable.includes(output),
      );

      expect(
        missing.map(({ source, output }) => `${source} → ${output}`),
        `These runtime assets resolve beside the executing module and therefore must be ` +
          `staged beside ${bundler.label}'s bundled entry.`,
      ).toEqual([]);
    });
  }
});
