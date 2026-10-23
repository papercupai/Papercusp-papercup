/**
 * Runtime-worker bundle guard (WI-10004975 follow-up).
 *
 * `bundle-host-common.sh` esbuild-bundles each runtime `*.worker.ts` on EVERY bg-host start
 * (the unit's ExecStartPre). If a worker's import graph reaches a heavy host module — even
 * through a lazy literal `import()`, which esbuild inlines — the bundle fails on an optional
 * require (`@opentelemetry/*` under `@dbos-inc/dbos-sdk`) and bg-host cannot start at all.
 * On 2026-10-01 a keychain.ts `await import('../fleet/git-via-sidecar')` grew
 * snapshot-fold.worker.ts's graph from 16 inputs to ~11,900, and nothing failed until the
 * next restart left bg-host down.
 *
 * The worker list is DERIVED from the bundler script (never hand-listed) and each worker is
 * built with the bundler's own flags, so this fails exactly when that restart would.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions, type Metafile } from 'esbuild';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const BUNDLER = join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh');
const HOST_BUNDLER = join(REPO_ROOT, 'apps/operator/bin/bundle-host.sh');
/** General budget; the precision worker has a separately measured healthy graph. */
const MAX_INPUTS = 300;
/** Production externals bring the precision worker's measured graph to 353 inputs. */
const WORKER_INPUT_LIMITS: Record<string, number> = {
  'packages/operator-core/lib/memory/bench/precision-bench-worker.ts': 500,
};
/** Host-only packages whose presence means the worker swallowed the host graph. */
const FORBIDDEN = /node_modules\/(?:@dbos-inc\/|@?testcontainers\/|ssh2\/)/;

/** Read the exact host external list used by bundle_host_workers, including its appended flags. */
function runtimeWorkerExternals(): string[] {
  const host = readFileSync(HOST_BUNDLER, 'utf8');
  const start = host.indexOf('\nHOST_EXTERNALS=(') + 1;
  const end = host.indexOf('\nif ! VIEM_ALIAS_OUTPUT=', start);
  if (start < 1 || end < 0) throw new Error('bundle-host.sh HOST_EXTERNALS boundary could not be read');
  const setup = host.slice(start, end);
  const script = [
    'set -euo pipefail',
    'source "$1"',
    setup,
    'node -e "console.log(JSON.stringify(process.argv.slice(1)))" -- "${HOST_EXTERNALS[@]}"',
  ].join('\n');
  const raw = execFileSync('bash', ['-c', script, 'runtime-worker-externals', BUNDLER], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const fromHost = (JSON.parse(raw) as string[]).map((value) => value.replace(/^--external:/, ''));
  return [...new Set([...fromHost, 'sodium-native', 'esbuild'])];
}

/** Mirrors bundle_host_workers' esbuild invocation. */
const BUNDLER_FLAGS: BuildOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: runtimeWorkerExternals(),
  absWorkingDir: REPO_ROOT,
  write: false,
  metafile: true,
  logLevel: 'silent',
};

function bundledWorkerSources(): string[] {
  const text = readFileSync(BUNDLER, 'utf8');
  return [...text.matchAll(/"\$repo_root\/([^"]+(?:\.worker|precision-bench-worker)\.ts)"/g)].map((m) => m[1]!);
}

const firstLines = (err: unknown, n = 6): string => String((err as Error)?.message ?? err).split('\n').slice(0, n).join('\n');

function isForbiddenPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return FORBIDDEN.test(normalized) || FORBIDDEN.test(`node_modules/${normalized}`);
}

/** Shortest import chain from `entryKey` to the first input matching FORBIDDEN. */
function chainToForbidden(meta: Metafile, entryKey: string): string {
  const parents = new Map<string, string>();
  const queue = [entryKey];
  const seen = new Set(queue);
  while (queue.length) {
    const cur = queue.shift()!;
    if (isForbiddenPath(cur)) {
      const chain = [cur];
      for (let p = parents.get(cur); p; p = parents.get(p)) chain.unshift(p);
      return chain.join('\n  -> ');
    }
    for (const imp of meta.inputs[cur]?.imports ?? []) {
      if (!imp.path) continue;
      if (isForbiddenPath(imp.path)) {
        const chain = [cur];
        for (let p = parents.get(cur); p; p = parents.get(p)) chain.unshift(p);
        chain.push(`${imp.external ? '[external] ' : ''}${imp.path}`);
        return chain.join('\n  -> ');
      }
      if (imp.external || seen.has(imp.path)) continue;
      seen.add(imp.path);
      parents.set(imp.path, cur);
      queue.push(imp.path);
    }
  }
  return '(no forbidden package reached)';
}

type Verdict = { flagged: false; inputs: number } | { flagged: true; why: string };

function maxInputsFor(entryAbs: string): number {
  const repoPath = relative(REPO_ROOT, entryAbs).replaceAll('\\', '/');
  return WORKER_INPUT_LIMITS[repoPath] ?? MAX_INPUTS;
}

/** The ONE detector, shared by the real cases and the control/calibration fixtures. */
async function workerVerdict(entryAbs: string): Promise<Verdict> {
  let metafile: Metafile;
  try {
    ({ metafile } = (await build({ ...BUNDLER_FLAGS, entryPoints: [entryAbs] })) as { metafile: Metafile });
  } catch (err) {
    return { flagged: true, why: `does not bundle — bg-host's ExecStartPre would fail:\n${firstLines(err)}` };
  }
  const inputs = Object.keys(metafile.inputs);
  const forbidden = chainToForbidden(metafile, relative(REPO_ROOT, entryAbs));
  if (forbidden !== '(no forbidden package reached)') {
    return { flagged: true, why: `reaches host-only packages:\n  ${forbidden}` };
  }
  const maxInputs = maxInputsFor(entryAbs);
  if (inputs.length > maxInputs) return { flagged: true, why: `graph grew to ${inputs.length} inputs (max ${maxInputs})` };
  return { flagged: false, inputs: inputs.length };
}

/** Failure-message aid: a tolerant build (native/otel requires stubbed) that names the chain. */
async function diagnose(entryAbs: string): Promise<string> {
  try {
    const { metafile } = (await build({
      ...BUNDLER_FLAGS,
      entryPoints: [entryAbs],
      external: [...(BUNDLER_FLAGS.external ?? []), '@opentelemetry/*'],
      loader: { '.node': 'empty' },
    })) as { metafile: Metafile };
    return `${Object.keys(metafile.inputs).length} inputs; chain:\n  ${chainToForbidden(metafile, relative(REPO_ROOT, entryAbs))}`;
  } catch (err) {
    return `tolerant rebuild also failed: ${firstLines(err, 2)}`;
  }
}

function withFixture<T>(source: string, fn: (entryAbs: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'pc-worker-graph-'));
  const entry = join(dir, 'fixture.worker.ts');
  writeFileSync(entry, source);
  return fn(entry).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const importOf = (repoRel: string): string => JSON.stringify(join(REPO_ROOT, repoRel));

describe('bg-host runtime worker bundles stay small and buildable', () => {
  const workers = bundledWorkerSources();

  it('derives the esbuild-bundled worker list from bundle-host-common.sh', () => {
    // Positive control: a parser that matched nothing would make every case below vacuous.
    expect(workers).toContain('packages/operator-core/lib/sync/hyperbee/snapshot-fold.worker.ts');
    expect(workers).toContain('packages/operator-core/lib/memory/bench/precision-bench-worker.ts');
    expect(workers).toContain('packages/operator-core/lib/role-codex-home.worker.ts');
    expect(workers.length).toBeGreaterThanOrEqual(2);
    expect(BUNDLER_FLAGS.external).toContain('@opentelemetry/exporter-logs-otlp-proto');
    expect(BUNDLER_FLAGS.external).toContain('@dbos-inc/dbos-sdk');
    expect(BUNDLER_FLAGS.external).toContain('ssh2');
  });

  it('keeps the tracing SDK on its runtime boundary and boots the generated ESM', async () => {
    const consumerRoot = join(REPO_ROOT, 'packages/operator-core');
    const result = await build({
      ...BUNDLER_FLAGS,
      stdin: {
        contents: `import { TracerProvider } from '@opentelemetry/sdk-trace';
          const tracer = new TracerProvider().getTracer('host-boundary-regression');
          console.log('host-otel-ready', typeof tracer.startSpan);`,
        resolveDir: consumerRoot,
        sourcefile: 'host-otel-boundary.fixture.ts',
        loader: 'ts',
      },
    });
    const imports = Object.values(result.metafile!.outputs).flatMap((output) => output.imports);
    expect(imports).toContainEqual(expect.objectContaining({ path: '@opentelemetry/sdk-trace', external: true }));
    expect(Object.keys(result.metafile!.inputs).some((path) => path.includes('node_modules/@opentelemetry/sdk-trace/'))).toBe(false);
    const output = execFileSync(process.execPath, ['--input-type=module'], {
      cwd: consumerRoot,
      input: result.outputFiles![0]!.text,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(output.trim()).toBe('host-otel-ready function');
  }, 30_000);

  it('calibration: a worker importing a small leaf module is NOT flagged', async () => {
    const v = await withFixture(
      `export * from ${importOf('packages/operator-core/lib/sync/hyperbee/hive-epoch-aead.ts')};\n`,
      workerVerdict,
    );
    expect(v).toMatchObject({ flagged: false });
  }, 120_000);

  it('control: a LAZY import() of the host sidecar module IS flagged (esbuild inlines it)', async () => {
    // The exact 2026-10-01 regression shape, kept permanently so the detector cannot pass vacuously.
    const v = await withFixture(
      `export async function f() { return import(${importOf('packages/operator-core/lib/fleet/git-via-sidecar.ts')}); }\n`,
      workerVerdict,
    );
    expect(v.flagged).toBe(true);
  }, 120_000);

  it.each(workers)('%s bundles with the bundler flags and without the host graph', async (rel) => {
    const abs = join(REPO_ROOT, rel);
    const v = await workerVerdict(abs);
    if (v.flagged) {
      throw new Error(
        `${rel} ${v.why}\nTolerant rebuild: ${await diagnose(abs)}\n` +
          'Break the edge with an injected seam; a lazy literal import() is still inlined by esbuild.',
      );
    }
    expect(v.inputs).toBeLessThanOrEqual(maxInputsFor(abs));
  }, 120_000);
});
