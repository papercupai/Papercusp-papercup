import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS build guard, imported for its scanner predicate.
import { findBundledCliEntryGuards, findBundledTopLevelAwaits } from '../../../scripts/check-bundled-cli-entry-guards.mjs';

const TEST_FILE = fileURLToPath(import.meta.url);

function repositoryRoot(): string {
  // Resolve from this module rather than process.cwd(): root-level Vitest
  // invocations run with the repository itself as cwd, while package-scoped
  // invocations run from apps/operator.
  return resolve(dirname(TEST_FILE), '../../..');
}

describe('check-bundled-cli-entry-guards', () => {
  it('resolves the repository root when Vitest is launched from the repository root', () => {
    const originalCwd = process.cwd();
    const root = repositoryRoot();
    try {
      process.chdir(root);
      expect(repositoryRoot()).toBe(root);
      expect(resolve(process.cwd(), '../..')).not.toBe(root);
      expect(readFileSync(join(root, 'apps/operator/bin/bundle-host.sh'), 'utf8')).toContain(
        'check-bundled-cli-entry-guards.mjs',
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('rejects a raw guard in an esbuild input and ignores non-repo inputs', () => {
    // The production scanner deliberately ignores files outside the repository.
    // Keep the synthetic repo-owned inputs under an allowed source root while
    // retaining a real system-temp file to exercise that boundary.
    const repoRoot = repositoryRoot();
    const root = mkdtempSync(join(repoRoot, 'apps', '.bundled-cli-entry-guard-'));
    try {
      const apps = join(root, 'operator');
      const scripts = join(root, 'scripts');
      const bad = join(scripts, 'bad.mjs');
      const badWrapped = join(scripts, 'bad-wrapped.mjs');
      const good = join(scripts, 'good.mjs');
      const outsideRoot = mkdtempSync(join(tmpdir(), 'bundled-cli-entry-guard-outside-'));
      const outside = join(outsideRoot, 'foreign.mjs');
      mkdirSync(scripts, { recursive: true });
      // The helper resolves input keys relative to apps/operator, mirroring bundle-host.sh.
      writeFileSync(bad, 'if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(1);\n');
      writeFileSync(
        badWrapped,
        'const direct = resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)); if (direct) main();\n',
      );
      writeFileSync(good, 'if (isCliEntry(import.meta.url)) main();\n');
      writeFileSync(outside, 'if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(1);\n');
      const metafile = join(root, 'bundle.meta.json');
      writeFileSync(
        metafile,
        JSON.stringify({
          inputs: {
            [relative(apps, bad)]: {},
            [relative(apps, badWrapped)]: {},
            [relative(apps, good)]: {},
            [outside]: {},
          },
        }),
      );

      const findings = findBundledCliEntryGuards({ metafilePath: metafile, baseDir: apps });
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: relative(repoRoot, bad).replaceAll('\\', '/'),
            kind: 'path-to-file-url',
            line: 1,
          }),
          expect.objectContaining({
            file: relative(repoRoot, badWrapped).replaceAll('\\', '/'),
            kind: 'file-url-to-path',
            line: 1,
          }),
        ]),
      );
      expect(findings).toHaveLength(2);
      rmSync(outsideRoot, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WI-55467 recurrence guard. papercup-staging-api (:3170) crash-looped six times and
  // systemd gave up on it. The visible failure was a raw Node traceback out of this
  // scanner —
  //   Error: ENOENT ... open 'dist-host/hono-host.mjs.tmp.1710681.meta.json'
  //     at bundledInputPaths (scripts/check-bundled-cli-entry-guards.mjs:38:31)
  // — immediately followed by bundle-host.sh announcing "bundling FAILED — the esbuild
  // error is above". Both statements sent a reader hunting an esbuild error that was not
  // there: the metafile was absent precisely BECAUSE the esbuild step had already failed,
  // and Bash disables errexit inside the `if ! ( … )` the bundle runs in, so nothing
  // stopped execution from reaching this scanner with no metafile to read.
  it('reports a missing metafile as an upstream bundle failure, not as a guard finding', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-cli-entry-guard-missing-meta-'));
    try {
      const absent = join(root, 'never-written.meta.json');
      let caught: unknown;
      try {
        findBundledCliEntryGuards({ metafilePath: absent, baseDir: root });
      } catch (error) {
        caught = error;
      }
      // A bare ENOENT would satisfy "it threw", so assert the SHAPE that makes the
      // failure legible, not merely that something was thrown.
      expect(caught).toBeInstanceOf(Error);
      const err = caught as Error & { code?: string; metafilePath?: string };
      expect(err.name).toBe('MissingMetafileError');
      expect(err.code).toBe('METAFILE_UNREADABLE');
      expect(err.metafilePath).toBe(absent);
      // The message must say which of the two failures this is, and must not be
      // mistakable for a CLI-entry guard finding.
      expect(err.message).toContain('This check did NOT fail');
      expect(err.message).toContain(absent);
      // The real ENOENT is preserved for anyone who wants it, never discarded.
      expect((err.cause as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unparseable metafile JSON the same legible way', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-cli-entry-guard-bad-meta-'));
    try {
      const truncated = join(root, 'truncated.meta.json');
      // A bundler killed mid-write leaves a partial file: readable, not parseable.
      writeFileSync(truncated, '{"inputs": {"scripts/a.mjs"');
      expect(() => findBundledCliEntryGuards({ metafilePath: truncated, baseDir: root })).toThrow(
        /This check did NOT fail/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The scanner can only be reached with a missing metafile if the esbuild call before it
  // did not abort the subshell. bundle-host.sh runs that call inside `if ! ( … )`, where
  // Bash disables errexit — so the abort has to be written out explicitly. This pins that
  // it still is. Source-level by necessity: running the real 47MB bundle in a unit test is
  // not viable, and the defect lives in the shell control flow, not in any JS module.
  it('bundle-host.sh aborts on an esbuild failure before running this scanner', () => {
    const repoRoot = repositoryRoot();
    // Subject path is overridable so falsifiability can be proved against a COPY or a
    // historical snapshot (scripts/mutation-probe.sh) instead of mutating the shared tree —
    // the sweep commits the whole tree every few minutes, so an in-tree mutation probe can
    // commit its own mutant even when nothing goes wrong.
    const subject = process.env.PROBE_BUNDLE_HOST_SH || join(repoRoot, 'apps/operator/bin/bundle-host.sh');
    const script = readFileSync(subject, 'utf8');
    const esbuildIdx = script.indexOf('bundle_host_esbuild');
    const scannerIdx = script.indexOf('check-bundled-cli-entry-guards.mjs');
    expect(esbuildIdx).toBeGreaterThan(-1);
    expect(scannerIdx).toBeGreaterThan(esbuildIdx);
    // The esbuild invocation itself must be failure-checked.
    expect(script).toMatch(/bundle_host_run_step host-compile bundle_host_esbuild/);
    expect(script).toMatch(/\|\| compiler_rc=\$\?\s+if \(\( compiler_rc != 0 \)\); then[\s\S]*?exit "\$compiler_rc"/);
    // And it must exit between esbuild and the scanner, so the scanner never runs on a
    // metafile esbuild did not write.
    const between = script.slice(esbuildIdx, scannerIdx);
    expect(between).toContain('exit "$compiler_rc"');
    // The fallback banner must not assert a cause it cannot know: the bundle step is
    // esbuild + this scanner + ascii-escape + the atomic swap, and any of them can fail.
    expect(script).not.toMatch(/FAILED — the esbuild error is above/);
  });

  // WI-10004497: a top-level await in a bundled repo input made esbuild compile it and
  // its importers into async inits that deadlocked across an import cycle, so the host
  // never listened (:3170 and every verify-tauri-headless rig, 2026-10-01).
  it('reports a repo-owned bundled input that uses top-level await, and only those', async () => {
    const repoRoot = repositoryRoot();
    const root = mkdtempSync(join(repoRoot, 'apps', '.bundled-tla-guard-'));
    try {
      const apps = join(root, 'operator');
      const src = join(root, 'src');
      mkdirSync(src, { recursive: true });
      const guardedMain = join(src, 'guarded-main.mjs'); // the exact pre-fix spelling
      const nested = join(src, 'nested-block.ts'); // top-level await inside a top-level block
      const asyncFn = join(src, 'async-fn.ts'); // await only inside a function: fine
      const noAwait = join(src, 'no-await.mjs');
      writeFileSync(guardedMain, 'async function main() {}\nif (isCliEntry(import.meta.url)) await main();\n');
      writeFileSync(nested, 'export const x: number = 1;\nfor (const a of [] as Promise<void>[]) {\n  await a;\n}\n');
      writeFileSync(asyncFn, 'export async function f(): Promise<number> {\n  return await Promise.resolve(1);\n}\n');
      writeFileSync(noAwait, 'export const y = 2;\n');
      const outsideRoot = mkdtempSync(join(tmpdir(), 'bundled-tla-guard-outside-'));
      const outside = join(outsideRoot, 'foreign.mjs');
      writeFileSync(outside, 'await Promise.resolve();\n');
      const metafile = join(root, 'bundle.meta.json');
      writeFileSync(
        metafile,
        JSON.stringify({
          inputs: Object.fromEntries(
            [guardedMain, nested, asyncFn, noAwait].map((f) => [relative(apps, f), {}]).concat([[outside, {}]]),
          ),
        }),
      );

      const findings = await findBundledTopLevelAwaits({ metafilePath: metafile, baseDir: apps });
      expect(findings).toEqual([
        { file: relative(repoRoot, guardedMain).replaceAll('\\', '/'), line: 2, kind: 'top-level-await' },
        { file: relative(repoRoot, nested).replaceAll('\\', '/'), line: 3, kind: 'top-level-await' },
      ]);
      rmSync(outsideRoot, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the real scripts/next-migration.mjs is not reported', async () => {
    const repoRoot = repositoryRoot();
    const root = mkdtempSync(join(tmpdir(), 'bundled-tla-guard-real-'));
    try {
      const apps = join(repoRoot, 'apps', 'operator');
      const metafile = join(root, 'bundle.meta.json');
      writeFileSync(
        metafile,
        JSON.stringify({ inputs: { [relative(apps, join(repoRoot, 'scripts/next-migration.mjs'))]: {} } }),
      );
      expect(await findBundledTopLevelAwaits({ metafilePath: metafile, baseDir: apps })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps imported test-router helpers safe in the actual host bundle input graph', async () => {
    const repoRoot = repositoryRoot();
    const root = mkdtempSync(join(tmpdir(), 'bundled-test-router-entry-'));
    try {
      const apps = join(repoRoot, 'apps', 'operator');
      const metafile = join(root, 'bundle.meta.json');
      writeFileSync(metafile, JSON.stringify({ inputs: Object.fromEntries([
        'scripts/check-vitest-config-enrollment.mjs', 'scripts/workspace-test.mjs',
      ].map((p) => [relative(apps, join(repoRoot, p)), {}])) }));
      expect(findBundledCliEntryGuards({ metafilePath: metafile, baseDir: apps })).toEqual([]);
      expect(await findBundledTopLevelAwaits({ metafilePath: metafile, baseDir: apps })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
