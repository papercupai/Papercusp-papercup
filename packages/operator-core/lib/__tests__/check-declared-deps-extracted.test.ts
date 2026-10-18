/**
 * check-declared-deps-extracted.test.ts — the un-extracted-dependency detector
 * (EI-18666853411437489).
 *
 * The bug: under concurrent `npm install` runs on the shared tree, npm's reify
 * bookkeeping can believe a declared dependency is resolved (it IS in
 * package-lock.json, and node_modules/.package-lock.json is newer) while the tarball
 * was never extracted. npm prints "up to date", exits 0, and the first symptom is a
 * confusing "cannot find module" / Rolldown "failed to resolve" in an unrelated build
 * or gate, 10+ minutes later. `scripts/npm-install-safe.mjs` serializes installs so
 * NEW corruption is not created; it could not DETECT existing corruption — that is
 * what `scripts/check-declared-deps-extracted.mjs` adds, and what this locks.
 *
 * Running the checker over the real tree proves the no-FALSE-POSITIVE direction on a
 * healthy corpus. This locks what a healthy-tree run cannot prove:
 *   1. it FLAGS a declared dependency that is absent from every node_modules on the
 *      resolution path — the exact shape observed (8 mem0ai peers declared + locked
 *      but missing on disk);
 *   2. it does NOT false-positive on the ways a dep legitimately resolves — hoisted
 *      to the repo root, or via an ANCESTOR node_modules for a nested workspace;
 *   3. absent devDependencies / peerDependencies are deliberately OUT of the direct
 *      declaration leg (`npm ls`'s unmet-peer noise under --legacy-peer-deps is the
 *      false-positive that once blocked a build for a dependency it never needed),
 *      while an EXISTING package-local dev-tool directory with no readable manifest
 *      is still flagged as a partial extraction;
 *   4. the retry absorbs a filesystem-sync race (a miss that CLEARS on a later
 *      attempt is not reported) but still reports a PERSISTENT miss;
 *   5. install:safe's post-install verification repairs once, then fails loudly —
 *      it never returns success while deps are still missing, and never masks a
 *      failing npm run with a dep verdict.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its detector only.
import { RUNTIME_CONTENT_PROBES, declaredVersionRange, findIncompleteWorkspacePackages, findIncompleteWorkspacePackagesWithRetry, findInvalidWorkspacePackageVersions, findInvalidWorkspacePackageVersionsWithRetry, findUnextractedDeps, findUnextractedDepsWithRetry, findUnsatisfiedDeclaredDepRanges, findUnsatisfiedDeclaredDepRangesWithRetry, findUnusableRuntimeDeps, findUnusableRuntimeDepsWithRetry, isDirectCliInvocation, resolveRuntimeContentProbes, resolveWorkspaceDirs, resolvesOnDisk } from '../../../../scripts/check-declared-deps-extracted.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — same, for the post-install verification wired into install:safe.
import { normalizeNpmArgs, packageLocalRepairTargets, parseCliArgs, removePackageLocalRepairLockEntries, repoLockName, runCommandUnderInstallMutex, verifyDepsExtracted } from '../../../../scripts/npm-install-safe.mjs';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';

type RuntimeProbeFailure = { specifier: string; detail: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The verification prints its (deliberate) diagnosis to the console; this suite fails on console output. */
function silenceConsole() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
}

/** Retain npm's phase evidence before afterEach removes an offline fixture. */
function fixtureNpm(root: string, args: string[], env = process.env) {
  const logsDir = join(root, '.npm-fixture-logs');
  try {
    return execFileSync('npm', args, { cwd: root, timeout: 30_000, stdio: 'pipe',
      env: { ...env, npm_config_logs_dir: logsDir } });
  } catch (error) {
    const failure = error as Error & { stdout?: Buffer; stderr?: Buffer };
    const logs = existsSync(logsDir) ? readdirSync(logsDir).sort().slice(-2)
      .map(name => readFileSync(join(logsDir, name), 'utf8').split('\n').slice(-25).join('\n')).join('\n') : 'no npm log written';
    throw new Error(`Offline fixture npm ${args.join(' ')} failed: ${failure.message}\n`
      + `stdout=${String(failure.stdout ?? '').slice(-2000)}\nstderr=${String(failure.stderr ?? '').slice(-2000)}\n${logs}`, { cause: error });
  }
}

/** A miniature npm-workspaces tree: workspaces + declared deps + which packages actually landed. */
function fixture(opts: {
  workspaces?: string[];
  packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
  /** node_modules dirs that exist, relative to the repo root ('' = root node_modules). */
  extracted: Record<string, string[]>;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'declared-deps-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: opts.workspaces ?? Object.keys(opts.packages) }));
  for (const [rel, pkg] of Object.entries(opts.packages)) {
    mkdirSync(join(root, rel), { recursive: true });
    writeFileSync(join(root, rel, 'package.json'), JSON.stringify(pkg));
  }
  for (const [at, names] of Object.entries(opts.extracted)) {
    for (const name of names) mkdirSync(join(root, at, 'node_modules', name), { recursive: true });
  }
  return root;
}

describe('check-declared-deps-extracted detector (EI-18666853411437489)', () => {
  it('FLAGS a declared dependency that never got extracted to disk', () => {
    // The observed shape: declared (and in package-lock.json) but absent from node_modules.
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { 'groq-sdk': '^1', cloudflare: '^4', mem0ai: '^3' } } },
      extracted: { '': ['mem0ai'] },
    });
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([
      { dep: 'groq-sdk', workspace: 'apps/operator' },
      { dep: 'cloudflare', workspace: 'apps/operator' },
    ]);
  });

  it('does NOT flag a dependency hoisted to the ROOT node_modules', () => {
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { hoisted: '^1' } } },
      extracted: { '': ['hoisted'] },
    });
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
  });

  it('does NOT flag a dependency in the workspace-LOCAL node_modules', () => {
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { local: '^1' } } },
      extracted: { 'apps/operator': ['local'] },
    });
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
  });

  it('resolves through an ANCESTOR node_modules for a nested workspace (npm hoisting)', () => {
    // libs/papercusp/libs/db is a real nested workspace in this repo — its deps hoist upward.
    const root = fixture({
      workspaces: ['libs/papercusp/libs/db'],
      packages: { 'libs/papercusp/libs/db': { dependencies: { pg: '^8' } } },
      extracted: { 'libs/papercusp': ['pg'] },
    });
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
    expect(resolvesOnDisk(root, join(root, 'libs/papercusp/libs/db'), 'pg')).toBe(true);
    expect(resolvesOnDisk(root, join(root, 'libs/papercusp/libs/db'), 'not-installed')).toBe(false);
  });

  it('never escapes the repo root when resolving (no host-level node_modules)', () => {
    const root = fixture({ packages: { 'apps/a': { dependencies: {} } }, extracted: {} });
    expect(resolvesOnDisk(root, join(root, 'apps/a'), 'anything')).toBe(false);
  });

  it('ignores devDependencies and peerDependencies (the npm-ls false-positive class)', () => {
    const root = fixture({
      packages: {
        'apps/operator': {
          dependencies: { present: '^1' },
          devDependencies: { 'only-a-dev-dep': '^1' },
        },
      },
      extracted: { '': ['present'] },
    });
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
  });

  it('expands "apps/*"-style workspace globs and skips dirs without a package.json', () => {
    const root = fixture({
      workspaces: ['apps/*'],
      packages: { 'apps/operator': { dependencies: {} }, 'apps/operator-vite': { dependencies: {} } },
      extracted: {},
    });
    mkdirSync(join(root, 'apps', 'not-a-workspace'), { recursive: true });
    expect(resolveWorkspaceDirs(root)).toEqual(['apps/operator', 'apps/operator-vite']);
  });

  it('does not diagnose or repair dependencies of a negatively excluded workspace', async () => {
    const root = fixture({
      workspaces: ['apps/*', '!apps/*-checkpoint'],
      packages: {
        'apps/operator': { dependencies: { present: '^1' } },
        'apps/drill-checkpoint': { dependencies: { 'excluded-missing': '^1' } },
      },
      extracted: { '': ['present'] },
    });
    expect(resolveWorkspaceDirs(root)).toEqual(['apps/operator']);
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
    const runNpm = vi.fn(() => 1);
    expect(await verifyDepsExtracted({ repoRoot: root, probeSpecifiers: [], runNpm })).toBe(0);
    expect(runNpm).not.toHaveBeenCalled();
  });
});

describe('retry absorbs a filesystem-sync race but not a real miss (WI-5769 retry8)', () => {
  it('reports NOTHING when the miss clears on a later attempt', async () => {
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { racy: '^1' } } },
      extracted: {},
    });
    let attempt = 0;
    const result = await findUnextractedDepsWithRetry({
      repoRoot: root,
      attempts: 3,
      delayMs: 0,
      deps: {
        sleep: async () => {
          // the "filesystem settles" moment between attempts
          mkdirSync(join(root, 'node_modules', 'racy'), { recursive: true });
        },
        existsSync: (p: string) => {
          attempt += 1;
          // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
          return require('node:fs').existsSync(p);
        },
      },
    });
    expect(result.missing).toEqual([]);
    expect(result.attempts).toBe(2);
    expect(attempt).toBeGreaterThan(0);
  });

  it('reports a PERSISTENT miss after every attempt', async () => {
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { 'really-missing': '^1' } } },
      extracted: {},
    });
    const result = await findUnextractedDepsWithRetry({ repoRoot: root, attempts: 3, delayMs: 0, deps: { sleep: async () => {} } });
    expect(result.attempts).toBe(3);
    expect(result.missing).toEqual([{ dep: 'really-missing', workspace: 'apps/operator' }]);
  });
});

describe('package-local manifest guard catches partial dev-tool installs (EI-20863794002653922)', () => {
  it('FLAGS an unscoped package directory whose package.json is missing', () => {
    const root = fixture({
      packages: {
        'libs/generic/sse': { devDependencies: { vitest: '^3.0.0' } },
      },
      extracted: { 'libs/generic/sse': ['vitest'] },
    });

    expect(findIncompleteWorkspacePackages({ repoRoot: root })).toEqual([
      { package: 'vitest', workspace: 'libs/generic/sse' },
    ]);
  });

  it('FLAGS a scoped package with a malformed manifest and ignores metadata dirs', () => {
    const root = fixture({
      packages: { 'apps/operator': { devDependencies: {} } },
      extracted: { 'apps/operator': ['@vitest/runner', '.cache'] },
    });
    writeFileSync(
      join(root, 'apps/operator/node_modules/@vitest/runner/package.json'),
      '{not-json',
    );

    expect(findIncompleteWorkspacePackages({ repoRoot: root })).toEqual([
      { package: '@vitest/runner', workspace: 'apps/operator' },
    ]);
  });

  it('accepts a package-local directory with a readable object manifest', () => {
    const root = fixture({
      packages: { 'libs/generic/sse': { devDependencies: { vitest: '^4.1.4' } } },
      extracted: { 'libs/generic/sse': ['vitest'] },
    });
    writeFileSync(
      join(root, 'libs/generic/sse/node_modules/vitest/package.json'),
      JSON.stringify({ name: 'vitest', version: '4.1.8' }),
    );

    expect(findIncompleteWorkspacePackages({ repoRoot: root })).toEqual([]);
  });

  it('retries a package-local manifest so a filesystem-settle race does not become a false red', async () => {
    const root = fixture({
      packages: { 'libs/generic/sse': { devDependencies: { vitest: '^4.1.4' } } },
      extracted: { 'libs/generic/sse': ['vitest'] },
    });
    const manifestPath = join(
      root,
      'libs/generic/sse/node_modules/vitest/package.json',
    );
    const result = await findIncompleteWorkspacePackagesWithRetry({
      repoRoot: root,
      attempts: 3,
      delayMs: 0,
      deps: {
        sleep: async () => {
          writeFileSync(
            manifestPath,
            JSON.stringify({ name: 'vitest', version: '4.1.8' }),
          );
        },
      },
    });

    expect(result).toEqual({ incomplete: [], attempts: 2 });
  });
});

describe('bundle-safe CLI entry detection', () => {
  it('runs only for the named script, never when esbuild imports it into the Hono host', () => {
    expect(isDirectCliInvocation('/repo/scripts/check-declared-deps-extracted.mjs')).toBe(true);
    expect(isDirectCliInvocation('C:\\repo\\scripts\\check-declared-deps-extracted.mjs')).toBe(true);
    expect(isDirectCliInvocation('/repo/apps/operator/dist-host/hono-host.mjs')).toBe(false);
    expect(isDirectCliInvocation(undefined)).toBe(false);
  });
});

describe('package-local version guard catches readable stale dev tools (EI-20863794002653922)', () => {
  it.each([
    ['4.1.8', {}, '4.1.8'],
    ['$vitest', { vitest: '4.1.8' }, '4.1.8'],
    [{ '.': '$vitest' }, { vitest: '4.1.8' }, '4.1.8'],
  ])('checks an installed dev tool against the root override %j', (override, hostDeps, effective) => {
    const root = fixture({
      packages: { 'libs/downloader': { devDependencies: { vitest: '^4.1.9' } } },
      extracted: { 'libs/downloader': ['vitest'] },
    });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      workspaces: ['libs/downloader'], devDependencies: hostDeps,
      overrides: { vitest: override },
    }));
    const installedPath = join(root, 'libs/downloader/node_modules/vitest/package.json');
    writeFileSync(installedPath, JSON.stringify({ name: 'vitest', version: '4.1.10' }));
    expect(findInvalidWorkspacePackageVersions({ repoRoot: root })).toEqual([
      { package: 'vitest', workspace: 'libs/downloader', declared: effective, installed: '4.1.10' },
    ]);
    writeFileSync(installedPath, JSON.stringify({ name: 'vitest', version: '4.1.8' }));
    expect(findInvalidWorkspacePackageVersions({ repoRoot: root })).toEqual([]);
  });

  it('honors a direct root override for hoisted runtime dependencies without leaking child rules', () => {
    const root = fixture({
      packages: { 'libs/image': { dependencies: { sharp: '^0.34.0', undici: '^6.0.0' } } },
      extracted: { '': ['sharp', 'undici'] },
    });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      workspaces: ['libs/image'],
      overrides: { sharp: '^0.35.0', other: { undici: '^7.0.0' } },
    }));
    writeFileSync(join(root, 'node_modules/sharp/package.json'), JSON.stringify({ version: '0.35.0' }));
    writeFileSync(join(root, 'node_modules/undici/package.json'), JSON.stringify({ version: '6.28.1' }));
    expect(findUnsatisfiedDeclaredDepRanges({ repoRoot: root })).toEqual([]);
    writeFileSync(join(root, 'node_modules/sharp/package.json'), JSON.stringify({ version: '0.34.5' }));
    expect(findUnsatisfiedDeclaredDepRanges({ repoRoot: root })).toEqual([
      { dep: 'sharp', workspace: 'libs/image', declared: '^0.35.0', installed: '0.34.5' },
    ]);
  });

  it('FLAGS Vitest 3 retained under an SSE declaration that now requires Vitest 4', () => {
    const root = fixture({
      packages: {
        'libs/generic/sse': { devDependencies: { vitest: '^4.1.4' } },
      },
      extracted: { 'libs/generic/sse': ['vitest', 'std-env'] },
    });
    writeFileSync(
      join(root, 'libs/generic/sse/node_modules/vitest/package.json'),
      JSON.stringify({ name: 'vitest', version: '3.2.6' }),
    );
    writeFileSync(
      join(root, 'libs/generic/sse/node_modules/std-env/package.json'),
      JSON.stringify({ name: 'std-env', version: '3.10.0' }),
    );

    expect(findInvalidWorkspacePackageVersions({ repoRoot: root })).toEqual([
      {
        package: 'vitest',
        workspace: 'libs/generic/sse',
        declared: '^4.1.4',
        installed: '3.2.6',
      },
    ]);
  });

  it('accepts a satisfying version, supports npm aliases, and ignores transitive local packages', () => {
    const root = fixture({
      packages: {
        'libs/generic/sse': {
          devDependencies: {
            typescript: 'npm:@typescript/typescript6@6.0.2',
            vitest: '^4.1.4',
          },
        },
      },
      extracted: { 'libs/generic/sse': ['typescript', 'vitest', 'std-env'] },
    });
    for (const [name, version] of [
      ['typescript', '6.0.2'],
      ['vitest', '4.1.8'],
      ['std-env', '3.10.0'],
    ]) {
      writeFileSync(
        join(root, 'libs/generic/sse/node_modules', name, 'package.json'),
        JSON.stringify({ name, version }),
      );
    }

    expect(declaredVersionRange('npm:@typescript/typescript6@6.0.2')).toBe('6.0.2');
    expect(findInvalidWorkspacePackageVersions({ repoRoot: root })).toEqual([]);
  });

  it('retries so a local version transition that settles is not a false red', async () => {
    const root = fixture({
      packages: {
        'libs/generic/sse': { devDependencies: { vitest: '^4.1.4' } },
      },
      extracted: { 'libs/generic/sse': ['vitest'] },
    });
    const manifestPath = join(
      root,
      'libs/generic/sse/node_modules/vitest/package.json',
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({ name: 'vitest', version: '3.2.6' }),
    );

    const result = await findInvalidWorkspacePackageVersionsWithRetry({
      repoRoot: root,
      attempts: 3,
      delayMs: 0,
      deps: {
        sleep: async () => {
          writeFileSync(
            manifestPath,
            JSON.stringify({ name: 'vitest', version: '4.1.8' }),
          );
        },
      },
    });

    expect(result).toEqual({ invalid: [], attempts: 2 });
  });
});

describe('edge-satisfaction guard catches a stale HOISTED placement (EI-21927402678532138)', () => {
  it('FLAGS a hoisted dep two workspaces declare when its resolved version does not satisfy either range', () => {
    // The observed shape: two workspaces both declare `sharp: ^0.35.0`, the
    // only reachable placement is the root-hoisted node_modules/sharp, and it
    // resolved to 0.34.5 — present, readable, and INVISIBLE to
    // findUnextractedDeps (it exists) and findInvalidWorkspacePackageVersions
    // (it is not workspace-LOCAL).
    const root = fixture({
      packages: {
        'apps/operator-docs': { dependencies: { sharp: '^0.35.0' } },
        'apps/papercusp-docs': { dependencies: { sharp: '^0.35.0' } },
      },
      extracted: { '': ['sharp'] },
    });
    writeFileSync(
      join(root, 'node_modules/sharp/package.json'),
      JSON.stringify({ name: 'sharp', version: '0.34.5' }),
    );

    // Neither existing leg sees it.
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
    expect(findInvalidWorkspacePackageVersions({ repoRoot: root })).toEqual([]);

    expect(findUnsatisfiedDeclaredDepRanges({ repoRoot: root })).toEqual([
      { dep: 'sharp', workspace: 'apps/operator-docs', declared: '^0.35.0', installed: '0.34.5' },
      { dep: 'sharp', workspace: 'apps/papercusp-docs', declared: '^0.35.0', installed: '0.34.5' },
    ]);
  });

  it('accepts a hoisted placement that satisfies the declared range', () => {
    const root = fixture({
      packages: { 'apps/operator-docs': { dependencies: { sharp: '^0.35.0' } } },
      extracted: { '': ['sharp'] },
    });
    writeFileSync(
      join(root, 'node_modules/sharp/package.json'),
      JSON.stringify({ name: 'sharp', version: '0.35.4' }),
    );

    expect(findUnsatisfiedDeclaredDepRanges({ repoRoot: root })).toEqual([]);
  });

  it('leaves a dep missing entirely to the unextracted-dep leg (does not double-report)', () => {
    const root = fixture({
      packages: { 'apps/operator-docs': { dependencies: { sharp: '^0.35.0' } } },
      extracted: {},
    });

    expect(findUnsatisfiedDeclaredDepRanges({ repoRoot: root })).toEqual([]);
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([
      { dep: 'sharp', workspace: 'apps/operator-docs' },
    ]);
  });

  it('ignores an unsupported range grammar rather than false-reddening it', () => {
    const root = fixture({
      packages: { 'apps/operator-docs': { dependencies: { odd: 'file:../local-odd' } } },
      extracted: { '': ['odd'] },
    });
    writeFileSync(
      join(root, 'node_modules/odd/package.json'),
      JSON.stringify({ name: 'odd', version: '0.0.0' }),
    );

    expect(findUnsatisfiedDeclaredDepRanges({ repoRoot: root })).toEqual([]);
  });

  it('retries so a version bump that lands mid-check is not a false red', async () => {
    const root = fixture({
      packages: { 'apps/operator-docs': { dependencies: { sharp: '^0.35.0' } } },
      extracted: { '': ['sharp'] },
    });
    const manifestPath = join(root, 'node_modules/sharp/package.json');
    writeFileSync(manifestPath, JSON.stringify({ name: 'sharp', version: '0.34.5' }));

    const result = await findUnsatisfiedDeclaredDepRangesWithRetry({
      repoRoot: root,
      attempts: 3,
      delayMs: 0,
      deps: {
        sleep: async () => {
          writeFileSync(manifestPath, JSON.stringify({ name: 'sharp', version: '0.35.4' }));
        },
      },
    });

    expect(result).toEqual({ invalid: [], attempts: 2 });
  });

  it('reports a PERSISTENT hoisted mismatch after every attempt', async () => {
    const root = fixture({
      packages: { 'apps/operator-docs': { dependencies: { sharp: '^0.35.0' } } },
      extracted: { '': ['sharp'] },
    });
    writeFileSync(
      join(root, 'node_modules/sharp/package.json'),
      JSON.stringify({ name: 'sharp', version: '0.34.5' }),
    );

    const result = await findUnsatisfiedDeclaredDepRangesWithRetry({
      repoRoot: root,
      attempts: 3,
      delayMs: 0,
      deps: { sleep: async () => {} },
    });
    expect(result.attempts).toBe(3);
    expect(result.invalid).toEqual([
      { dep: 'sharp', workspace: 'apps/operator-docs', declared: '^0.35.0', installed: '0.34.5' },
    ]);
  });
});

describe('runtime-content probes catch partial packages that directory checks cannot (EI-21252116452570853)', () => {
  it('checks declaration-only probes without importing browser packages or broadening the critical package population', () => {
    const root = fixture({
      packages: { 'apps/ui': { dependencies: { 'browser-sdk': '*', 'unused-types': '*' }, devDependencies: { 'ui-types': '*' } } },
      extracted: { '': ['browser-sdk', 'ui-types', 'unused-types'] },
    });
    writeFileSync(join(root, 'node_modules/unused-types/package.json'), JSON.stringify({ types: './unpublished.d.ts' }));
    for (const [name, field] of [['browser-sdk', 'types'], ['ui-types', 'typings']]) {
      const dir = join(root, 'node_modules', name);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', [field]: './index.d.ts' }));
      writeFileSync(join(dir, 'index.js'), 'throw new Error("browser-only package must not be imported");');
    }
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
    const probeSpecifiers = ['browser-sdk', 'ui-types'].map(specifier => ({ specifier, declarationsOnly: true }));
    expect(findUnusableRuntimeDeps({ repoRoot: root, probeSpecifiers })).toEqual([
      { specifier: 'browser-sdk', code: 'ERR_MODULE_NOT_FOUND',
        missingPath: join(root, 'node_modules/browser-sdk/index.d.ts'), detail: expect.stringContaining('declared type entrypoint is missing') },
      { specifier: 'ui-types', code: 'ERR_MODULE_NOT_FOUND',
        missingPath: join(root, 'node_modules/ui-types/index.d.ts'), detail: expect.stringContaining('declared type entrypoint is missing') },
    ]);
    for (const name of ['browser-sdk', 'ui-types'])
      writeFileSync(join(root, 'node_modules', name, 'index.d.ts'), 'export {};');
    expect(findUnusableRuntimeDeps({ repoRoot: root, probeSpecifiers })).toEqual([]);
  });

  it('checks the types paired with the resolved export without requiring an unused root export', () => {
    const root = fixture({ packages: { 'apps/ui': { dependencies: { 'fixture-sdk': '*' } } }, extracted: { '': ['fixture-sdk'] } });
    const dir = join(root, 'node_modules/fixture-sdk');
    mkdirSync(join(dir, 'dist/client'), { recursive: true });
    mkdirSync(join(dir, 'types'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-sdk', type: 'module', exports: {
      '.': { types: './unused-root.d.ts', import: './unused-root.js' },
      './client': { types: './types/client.d.ts', import: './dist/client/index.js' },
      './*': { types: './types/*.d.ts', import: './dist/*' },
    } }));
    writeFileSync(join(dir, 'dist/client/index.js'), 'export const Client = {};');
    const options = { repoRoot: root, probeSpecifiers: ['fixture-sdk/client/index.js'] };
    expect(findUnusableRuntimeDeps(options)).toEqual([
      { specifier: 'fixture-sdk/client/index.js', code: 'ERR_MODULE_NOT_FOUND',
        missingPath: join(dir, 'types/client.d.ts'), detail: expect.stringContaining('declared type entrypoint is missing') },
    ]);
    writeFileSync(join(dir, 'types/client.d.ts'), 'export declare const Client: {};');
    expect(findUnusableRuntimeDeps(options)).toEqual([]);
  });

  it('accepts extensionless declaration entries that TypeScript resolves', () => {
    const root = fixture({ packages: { 'apps/ui': { dependencies: { 'browser-sdk': '*' } } }, extracted: { '': ['browser-sdk'] } });
    const dir = join(root, 'node_modules/browser-sdk');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'browser-sdk', types: './main' }));
    writeFileSync(join(dir, 'main.d.ts'), 'export {};');
    const probeSpecifiers = [{ specifier: 'browser-sdk', declarationsOnly: true }];
    expect(findUnusableRuntimeDeps({ repoRoot: root, probeSpecifiers })).toEqual([]);
    rmSync(join(dir, 'main.d.ts'));
    expect(findUnusableRuntimeDeps({ repoRoot: root, probeSpecifiers })).toEqual([
      expect.objectContaining({ specifier: 'browser-sdk', code: 'ERR_MODULE_NOT_FOUND' }),
    ]);
  });

  it('substitutes the matched runtime export wildcard into its types path', () => {
    const root = fixture({ packages: { 'apps/ui': { dependencies: { 'fixture-sdk': '*' } } }, extracted: { '': ['fixture-sdk'] } });
    const dir = join(root, 'node_modules/fixture-sdk');
    mkdirSync(join(dir, 'dist'));
    mkdirSync(join(dir, 'types'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-sdk', type: 'module', exports: {
      './*': { types: './types/*.d.ts', import: './dist/*.js' },
    } }));
    writeFileSync(join(dir, 'dist/client.js'), 'export {};');
    const options = { repoRoot: root, probeSpecifiers: ['fixture-sdk/client'] };
    expect(findUnusableRuntimeDeps(options)).toEqual([
      { specifier: 'fixture-sdk/client', code: 'ERR_MODULE_NOT_FOUND',
        missingPath: join(dir, 'types/client.d.ts'), detail: expect.stringContaining('declared type entrypoint is missing') },
    ]);
    writeFileSync(join(dir, 'types/client.d.ts'), 'export {};');
    expect(findUnusableRuntimeDeps(options)).toEqual([]);
  });

  it('selects probes from the locked graph and flags missing entrypoint/transitive/native content', () => {
    const root = fixture({
      packages: {
        'apps/operator': {
          dependencies: { '@modelcontextprotocol/sdk': '^1', hono: '^4' },
        },
      },
      extracted: {
        '': ['@modelcontextprotocol/sdk', 'zod-to-json-schema', 'hono', '@lydell/node-pty', 'rocksdb-native', 'onnxruntime-web', 'mermaid', 'react-icons'],
      },
    });
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({
        packages: Object.fromEntries(
          ['@modelcontextprotocol/sdk', 'zod-to-json-schema', 'hono', '@lydell/node-pty', 'rocksdb-native', 'onnxruntime-web', 'mermaid', 'react-icons', 'lucide-react'].map(
            (name) => [`node_modules/${name}`, {}],
          ),
        ),
      }),
    );

    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]); // old directory-only verdict
    const runtimeProbes = RUNTIME_CONTENT_PROBES.filter((probe: string | { specifier: string; declarationsOnly: boolean }) => typeof probe === 'string');
    expect(resolveRuntimeContentProbes(root)).toEqual(runtimeProbes);

    const writePackage = (name: string, pkg: object, files: Record<string, string> = {}) => {
      const dir = join(root, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), content);
      }
    };

    // Every package DIRECTORY exists. Their real entrypoint/import graph is what is
    // truncated: SDK -> missing zod entry, hono/rocksdb -> missing dist/binding,
    // and node-pty -> missing selected platform payload.
    writePackage(
      '@modelcontextprotocol/sdk',
      { type: 'module', exports: { './client/index.js': './dist/client.js' } },
      { 'dist/client.js': "import 'zod-to-json-schema'; export const Client = {};" },
    );
    writePackage('zod-to-json-schema', { type: 'module', exports: './dist/esm/index.js' });
    writePackage('hono', { type: 'module', exports: './dist/cjs/index.js' });
    writePackage(
      '@lydell/node-pty',
      { type: 'module', exports: './index.js' },
      { 'index.js': "import '@lydell/node-pty-linux-x64'; export const fork = () => {};" },
    );
    writePackage('rocksdb-native', { type: 'module', exports: './binding.js' });
    writePackage('onnxruntime-web', { type: 'module', exports: './dist/ort.node.min.mjs' });
    writePackage('mermaid', {
      name: 'mermaid', version: '11.14.0', type: 'module',
      module: './dist/mermaid.core.mjs',
      exports: { '.': { types: './dist/mermaid.d.ts', import: './dist/mermaid.core.mjs', default: './dist/mermaid.core.mjs' }, './*': './*' },
    });
    writePackage('react-icons', { exports: { './ai': './ai/index.mjs' } }, {
      'ai/index.mjs': "export { IconBase } from '../lib/index.mjs';",
    });
    writePackage('lucide-react', {
      type: 'module',
      exports: './dist/index.mjs',
      typings: './dist/lucide-react.d.ts',
    }, {
      'dist/index.mjs': 'export const Check = {};',
    });

    const failures = findUnusableRuntimeDeps({ repoRoot: root }) as RuntimeProbeFailure[];
    expect(failures.map((failure) => failure.specifier)).toEqual(runtimeProbes);
    for (const failure of failures) {
      if (failure.specifier === 'lucide-react') {
        expect(failure.detail).toContain('declared type entrypoint is missing:');
        expect(failure).toMatchObject({
          code: 'ERR_MODULE_NOT_FOUND',
          missingPath: join(root, 'node_modules/lucide-react/dist/lucide-react.d.ts'),
        });
      } else {
        expect(failure.detail).toMatch(/(?:ERR_MODULE_NOT_FOUND|Cannot find package)/);
      }
    }
    expect(failures.find((failure) => failure.specifier === 'mermaid')).toMatchObject({
      code: 'ERR_MODULE_NOT_FOUND',
      missingPath: join(root, 'node_modules/mermaid/dist/mermaid.core.mjs'),
    });
    writeFileSync(join(root, 'node_modules/lucide-react/dist/lucide-react.d.ts'), 'export declare const Check: {};');
    expect(findUnusableRuntimeDeps({ repoRoot: root, probeSpecifiers: ['lucide-react'] })).toEqual([]);
  });

  it('rejects ONNX with working CommonJS but missing ESM content, and accepts the restored entrypoint', () => {
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { 'onnxruntime-web': '*' } } },
      extracted: { '': ['onnxruntime-web'] },
    });
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/onnxruntime-web': { version: '1.24.1' } },
    }));
    const dir = join(root, 'node_modules/onnxruntime-web');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'onnxruntime-web', version: '1.24.1',
      exports: { '.': { node: { import: './dist/ort.node.min.mjs', require: './dist/ort.node.min.js' } } },
    }));
    writeFileSync(join(dir, 'dist/ort.node.min.js'), 'module.exports = {};');
    execFileSync(process.execPath, ['-e', "require('onnxruntime-web')"], { cwd: root });
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
    expect(resolveRuntimeContentProbes(root)).toEqual(['onnxruntime-web']);
    expect(findUnusableRuntimeDeps({ repoRoot: root })).toEqual([
      { specifier: 'onnxruntime-web', detail: expect.stringMatching(/ERR_MODULE_NOT_FOUND.*ort\.node\.min\.mjs/),
        code: 'ERR_MODULE_NOT_FOUND', missingPath: join(dir, 'dist/ort.node.min.mjs') },
    ]);

    writeFileSync(join(dir, 'dist/ort.node.min.mjs'), 'export const env = {};');
    expect(findUnusableRuntimeDeps({ repoRoot: root })).toEqual([]);
  });

  it('detects a missing shared icon ESM payload despite a working CommonJS icon set', () => {
    const root = fixture({
      packages: { 'apps/ui': { dependencies: { 'react-icons': '*' } } },
      extracted: { '': ['react-icons'] },
    });
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/react-icons': { version: '5.6.0' } },
    }));
    const dir = join(root, 'node_modules/react-icons');
    mkdirSync(join(dir, 'ai'));
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'react-icons', version: '5.6.0',
      exports: { './ai': { import: './ai/index.mjs', require: './ai/index.js' } },
    }));
    writeFileSync(join(dir, 'ai/index.js'), 'module.exports = {};');
    writeFileSync(join(dir, 'ai/index.mjs'), "export { IconBase } from '../lib/index.mjs';");
    execFileSync(process.execPath, ['-e', "require('react-icons/ai')"], { cwd: root });
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
    expect(resolveRuntimeContentProbes(root)).toEqual(['react-icons/ai']);
    expect(findUnusableRuntimeDeps({ repoRoot: root })).toEqual([
      { specifier: 'react-icons/ai', detail: expect.stringMatching(/ERR_MODULE_NOT_FOUND.*lib\/index\.mjs/),
        code: 'ERR_MODULE_NOT_FOUND', missingPath: join(dir, 'lib/index.mjs') },
    ]);
    writeFileSync(join(dir, 'lib/index.mjs'), 'export const IconBase = {};');
    expect(findUnusableRuntimeDeps({ repoRoot: root })).toEqual([]);
  });

  it('retries a real import so a filesystem-settle race does not become a false failure', async () => {
    let calls = 0;
    const result = await findUnusableRuntimeDepsWithRetry({
      repoRoot: '/fixture',
      probeSpecifiers: ['hono'],
      attempts: 3,
      delayMs: 0,
      deps: {
        sleep: async () => {},
        probeRuntimeImport: () => (++calls === 1 ? { ok: false, detail: 'dist entry settling' } : { ok: true }),
      },
    });
    expect(result).toEqual({ failures: [], attempts: 2 });
    expect(calls).toBe(2);
  });
});

describe('install:safe post-install verification (the half the mutex cannot cover)', () => {
  it('repairs missing published font assets through the default CSS-content probe', async () => {
    silenceConsole();
    const root = fixture({ packages: { 'apps/ui': {} }, extracted: { '': ['@blocknote/core'] } });
    const target = join(root, 'node_modules/@blocknote/core');
    const manifest = { name: '@blocknote/core', version: '1.0.0',
      exports: { './fonts/inter.css': './src/fonts/inter.css' } };
    const css = '@font-face { src: url("./inter.woff2?v=1#font") format("woff2"); }';
    const restore = (withFont: boolean) => {
      mkdirSync(join(target, 'src/fonts'), { recursive: true });
      writeFileSync(join(target, 'package.json'), JSON.stringify(manifest));
      writeFileSync(join(target, 'src/fonts/inter.css'), css);
      if (withFont) writeFileSync(join(target, 'src/fonts/inter.woff2'), 'font payload');
    };
    restore(false);
    const lock = JSON.stringify({ packages: { 'node_modules/@blocknote/core': { version: '1.0.0' } } });
    writeFileSync(join(root, 'package-lock.json'), lock);
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
    expect(findUnusableRuntimeDeps({ repoRoot: root })).toEqual([
      expect.objectContaining({ specifier: '@blocknote/core/fonts/inter.css',
        missingPath: join(target, 'src/fonts/inter.woff2') }),
    ]);
    let repairs = 0;
    const status = await verifyDepsExtracted({ repoRoot: root, deps: { sleep: async () => {} },
      runNpm: () => { repairs++; expect(existsSync(target)).toBe(false); restore(true); return 0; },
    });
    expect(status).toBe(0);
    expect(repairs).toBe(1);
    expect(findUnusableRuntimeDeps({ repoRoot: root })).toEqual([]);
    expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toBe(lock);
  });

  it('repairs missing transitive assistant-ui declarations through the default probes', async () => {
    silenceConsole();
    const root = fixture({
      packages: { 'apps/ui': { dependencies: { '@assistant-ui/react': '*' } } },
      extracted: { '': ['@assistant-ui/react', '@assistant-ui/core'] },
    });
    const parent = join(root, 'node_modules/@assistant-ui/react');
    const target = join(root, 'node_modules/@assistant-ui/core');
    const manifest = { name: '@assistant-ui/core', version: '1.0.0', types: './index.d.ts' };
    writeFileSync(join(parent, 'package.json'), JSON.stringify({
      name: '@assistant-ui/react', version: '1.0.0', types: './index.d.ts',
      dependencies: { '@assistant-ui/core': '*' },
    }));
    writeFileSync(join(parent, 'index.d.ts'), "export * from '@assistant-ui/core';");
    writeFileSync(join(target, 'package.json'), JSON.stringify(manifest));
    const lock = JSON.stringify({ packages: {
      'node_modules/@assistant-ui/react': { version: '1.0.0' },
      'node_modules/@assistant-ui/core': { version: '1.0.0' },
    } });
    writeFileSync(join(root, 'package-lock.json'), lock);
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
    expect(findUnusableRuntimeDeps({ repoRoot: root })).toEqual([
      expect.objectContaining({ specifier: '@assistant-ui/core', missingPath: join(target, 'index.d.ts') }),
    ]);
    let repairs = 0;
    const status = await verifyDepsExtracted({ repoRoot: root, deps: { sleep: async () => {} },
      runNpm: () => {
        repairs++;
        expect(existsSync(target)).toBe(false);
        expect(existsSync(join(parent, 'index.d.ts'))).toBe(true);
        mkdirSync(target);
        writeFileSync(join(target, 'package.json'), JSON.stringify(manifest));
        writeFileSync(join(target, 'index.js'), 'module.exports = {};');
        writeFileSync(join(target, 'index.d.ts'), 'export {};');
        return 0;
      },
    });
    expect(status).toBe(0);
    expect(repairs).toBe(1);
    expect(findUnusableRuntimeDeps({ repoRoot: root })).toEqual([]);
    expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toBe(lock);
  });

  it('re-extracts missing declared types through the existing locked package-content repair', async () => {
    silenceConsole();
    const root = fixture({ packages: { 'apps/ui': { dependencies: { 'browser-sdk': '*' } } }, extracted: { '': ['browser-sdk'] } });
    const dir = join(root, 'node_modules/browser-sdk');
    const manifest = { name: 'browser-sdk', version: '1.0.0', types: './index.d.ts' };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'index.js'), 'module.exports = {};');
    const lock = JSON.stringify({ packages: { 'node_modules/browser-sdk': { version: '1.0.0' } } });
    writeFileSync(join(root, 'package-lock.json'), lock);
    let repairs = 0;
    const status = await verifyDepsExtracted({ repoRoot: root, probeSpecifiers: [{ specifier: 'browser-sdk', declarationsOnly: true }], deps: { sleep: async () => {} },
      runNpm: () => {
        repairs++;
        expect(existsSync(dir)).toBe(false);
        mkdirSync(dir);
        writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
        writeFileSync(join(dir, 'index.js'), 'module.exports = {};');
        writeFileSync(join(dir, 'index.d.ts'), 'export {};');
        return 0;
      },
    });
    expect(status).toBe(0);
    expect(repairs).toBe(1);
    expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toBe(lock);
  });

  it('repairs a locked transitive mermaid payload through the default runtime probes', async () => {
    silenceConsole();
    const root = fixture({ packages: { 'apps/ui': {} }, extracted: { '': ['mermaid'] } });
    const target = join(root, 'node_modules/mermaid');
    const manifest = {
      name: 'mermaid', version: '11.14.0', type: 'module',
      module: './dist/mermaid.core.mjs',
      exports: { '.': { import: './dist/mermaid.core.mjs', default: './dist/mermaid.core.mjs' } },
    };
    writeFileSync(join(target, 'package.json'), JSON.stringify(manifest));
    const lock = JSON.stringify({ packages: { 'node_modules/mermaid': { version: '11.14.0' } } });
    writeFileSync(join(root, 'package-lock.json'), lock);
    // No workspace declares Mermaid directly: Excalidraw brings it transitively.
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
    expect(resolveRuntimeContentProbes(root)).toEqual(['mermaid']);
    let repairs = 0;
    const status = await verifyDepsExtracted({ repoRoot: root,
      deps: { sleep: async () => {} }, runNpm: (args: string[]) => {
        repairs++;
        expect(args).toEqual(['install', '--legacy-peer-deps']);
        expect(existsSync(target)).toBe(false);
        expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toBe(lock);
        mkdirSync(join(target, 'dist'), { recursive: true });
        writeFileSync(join(target, 'package.json'), JSON.stringify(manifest));
        writeFileSync(join(target, 'dist/mermaid.core.mjs'), 'export default {};');
        return 0;
      } });
    expect(status).toBe(0);
    expect(repairs).toBe(1);
    expect(findUnusableRuntimeDeps({ repoRoot: root })).toEqual([]);
    expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toBe(lock);
  });

  it('re-extracts a broken hoisted runtime from its locked tarball when plain npm leaves it up to date', async () => {
    silenceConsole();
    const root = fixture({ packages: { 'apps/selected': {} }, extracted: {} });
    const source = join(root, 'vendor/runtime');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: 'fixture-runtime', version: '1.0.0',
      exports: { '.': { import: './dist/index.mjs', require: './dist/index.cjs' } },
    }));
    writeFileSync(join(source, 'dist/index.mjs'), 'export const loaded = true;');
    writeFileSync(join(source, 'dist/index.cjs'), 'module.exports = {};');
    const env = { ...process.env, PAPERCUSP_INSTALL_SAFE_ACTIVE: '1',
      npm_config_prefix: undefined, NPM_CONFIG_PREFIX: undefined,
      npm_config_package_lock_only: undefined, NPM_CONFIG_PACKAGE_LOCK_ONLY: undefined };
    const npm = (args: string[]) => fixtureNpm(root, args, env);
    npm(['pack', source, '--ignore-scripts', '--pack-destination', root]);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    pkg.dependencies = { 'fixture-runtime': 'file:fixture-runtime-1.0.0.tgz' };
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    const install = () => npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps']);
    install();
    const target = join(root, 'node_modules/fixture-runtime');
    const entrypoint = join(target, 'dist/index.mjs');
    rmSync(entrypoint);
    execFileSync(process.execPath, ['-e', "require('fixture-runtime')"], { cwd: root });
    install();
    expect(existsSync(entrypoint)).toBe(false); // the measured npm no-op
    const lock = readFileSync(join(root, 'package-lock.json'), 'utf8');
    let repairs = 0;
    const status = await verifyDepsExtracted({ repoRoot: root,
      npmArgs: ['install', '--workspace=apps/selected'], probeSpecifiers: ['fixture-runtime'],
      deps: { sleep: async () => {} }, runNpm: (args: string[]) => {
        repairs++;
        expect(args).toEqual(['install', '--legacy-peer-deps']);
        expect(existsSync(target)).toBe(false);
        expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toBe(lock);
        install();
        return 0;
      } });
    expect(status).toBe(0);
    expect(repairs).toBe(1);
    expect(findUnusableRuntimeDeps({ repoRoot: root, probeSpecifiers: ['fixture-runtime'] })).toEqual([]);
  }, 45_000);

  it.each(['generic-error', 'external', 'symlink', 'workspace-link', 'already-present'])('does not evict a runtime package for %s evidence', async (kind) => {
    silenceConsole();
    const root = fixture({ packages: { 'apps/operator': {} }, extracted: { '': ['hono'] } });
    const target = join(root, 'node_modules/hono');
    const manifest = { name: 'hono', version: '4.0.0', type: 'module', exports: './missing.mjs' };
    writeFileSync(join(target, 'package.json'), JSON.stringify(manifest));
    const external = fixture({ packages: {}, extracted: {} });
    writeFileSync(join(external, 'package.json'), JSON.stringify(manifest));
    if (kind === 'symlink') { rmSync(target, { recursive: true }); symlinkSync(external, target); }
    if (kind === 'already-present') writeFileSync(join(target, 'missing.mjs'), 'throw new Error("bad configuration");');
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {
      'node_modules/hono': { version: '4.0.0', ...(kind === 'workspace-link' ? { link: true } : {}) },
    } }));
    const before = readFileSync(join(target, 'package.json'), 'utf8');
    let repairs = 0;
    const status = await verifyDepsExtracted({ repoRoot: root, probeSpecifiers: ['hono'],
      deps: { sleep: async () => {}, probeRuntimeImport: () => ({ ok: false, detail: 'failed',
        ...(kind === 'generic-error' ? {} : { code: 'ERR_MODULE_NOT_FOUND',
          missingPath: join(kind === 'external' ? external : target, 'missing.mjs') }) }) },
      runNpm: () => { repairs++; expect(readFileSync(join(target, 'package.json'), 'utf8')).toBe(before); return 0; } });
    expect(status).toBe(1);
    expect(repairs).toBe(1);
    expect(readFileSync(join(target, 'package.json'), 'utf8')).toBe(before);
  });

  it('retains a local executable that becomes healthy during asynchronous runtime verification', async () => {
    const root = fixture({ packages: { 'libs/tooling': {} }, extracted: { 'libs/tooling': ['tool'] } });
    const nm = join(root, 'libs/tooling/node_modules');
    writeFileSync(join(nm, 'tool/package.json'), JSON.stringify({ name: 'tool', version: '1.0.0' }));
    mkdirSync(join(nm, '.bin'));
    symlinkSync('../tool/cli.js', join(nm, '.bin/tool'));
    const repair = vi.fn(() => 0);
    const status = await verifyDepsExtracted({ repoRoot: root, probeSpecifiers: ['hono'], runNpm: repair, deps: {
      sleep: async () => {},
      probeRuntimeImport: () => {
        writeFileSync(join(nm, 'tool/cli.js'), 'settled');
        return { ok: true };
      },
    } });
    expect(status).toBe(0);
    expect(repair).not.toHaveBeenCalled();
    expect(readFileSync(join(nm, '.bin/tool'), 'utf8')).toBe('settled');
  });

  it('refuses an external .bin directory before changing its dangling link', async () => {
    silenceConsole();
    const root = fixture({ packages: { 'libs/tooling': {} }, extracted: {} });
    const external = fixture({ packages: {}, extracted: {} });
    const bin = join(external, 'bins');
    mkdirSync(bin);
    symlinkSync('../missing/cli.js', join(bin, 'tool'));
    const nm = join(root, 'libs/tooling/node_modules');
    mkdirSync(nm, { recursive: true });
    symlinkSync(bin, join(nm, '.bin'));
    const repair = vi.fn(() => 0);
    await expect(verifyDepsExtracted({ repoRoot: root, probeSpecifiers: [], runNpm: repair, deps: { sleep: async () => {} } }))
      .rejects.toThrow(/executable-link repair outside repo root/);
    expect(() => symlinkSync('../missing/cli.js', join(bin, 'tool'))).toThrow();
    expect(repair).not.toHaveBeenCalled();
  });

  it('refuses a scoped package whose physical parent is outside the repo before any unlink or removal', async () => {
    silenceConsole();
    const root = fixture({ packages: { 'libs/tooling': {} }, extracted: {} });
    const external = fixture({ packages: {}, extracted: { '': ['tool'] } });
    writeFileSync(join(external, 'node_modules/tool/package.json'), JSON.stringify({ name: 'tool', version: '1.0.0' }));
    const nm = join(root, 'libs/tooling/node_modules');
    mkdirSync(join(nm, '.bin'), { recursive: true });
    symlinkSync(join(external, 'node_modules'), join(nm, '@scope'));
    symlinkSync('../@scope/tool/cli.js', join(nm, '.bin/tool'));
    const repair = vi.fn(() => 0);
    await expect(verifyDepsExtracted({ repoRoot: root, probeSpecifiers: [], runNpm: repair, deps: { sleep: async () => {} } }))
      .rejects.toThrow(/executable-package repair outside repo root/);
    expect(existsSync(join(external, 'node_modules/tool/package.json'))).toBe(true);
    expect(() => symlinkSync('../@scope/tool/cli.js', join(nm, '.bin/tool'))).toThrow();
    expect(repair).not.toHaveBeenCalled();
  });

  it('repairs an orphan workspace bin that a real offline hoisted npm install leaves untouched', async () => {
    silenceConsole();
    const root = fixture({ packages: { 'libs/tooling': {} }, extracted: {} });
    const vendor = join(root, 'vendor/tool');
    mkdirSync(vendor, { recursive: true });
    writeFileSync(join(vendor, 'package.json'), JSON.stringify({ name: 'fixture-tool', version: '1.0.0', bin: { 'fixture-tool': 'cli.js' } }));
    writeFileSync(join(vendor, 'cli.js'), '#!/usr/bin/env node\nprocess.exit(0)\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['libs/tooling'], dependencies: { 'fixture-tool': 'file:vendor/tool' } }));
    writeFileSync(join(root, 'libs/tooling/package.json'), JSON.stringify({ name: 'tooling', version: '1.0.0', devDependencies: { 'fixture-tool': 'file:../../vendor/tool' } }));
    const install = () => fixtureNpm(root, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
    install();
    const bin = join(root, 'libs/tooling/node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    const orphan = join(bin, 'fixture-tool');
    symlinkSync('../fixture-tool/cli.js', orphan);
    install();
    expect(readFileSync(join(root, 'node_modules/fixture-tool/cli.js'), 'utf8')).toContain('process.exit(0)');
    expect(() => readFileSync(orphan)).toThrow();
    // A plain reify left the orphan behind; the wrapper's post-install check
    // must detect it, perform one repair and retain the usable hoisted binary.
    let repairs = 0;
    const status = await verifyDepsExtracted({ repoRoot: root, probeSpecifiers: [], runNpm: () => { repairs++; install(); return 0; }, deps: { sleep: async () => {} } });
    expect(status).toBe(0);
    expect(repairs).toBe(1);
    expect(() => symlinkSync('../fixture-tool/cli.js', orphan)).not.toThrow();
    expect(existsSync(join(root, 'node_modules/.bin/fixture-tool'))).toBe(true);
  }, 45_000);

  it('removes the damaged local package before repairing its missing executable content', async () => {
    silenceConsole();
    const root = fixture({ packages: { 'libs/tooling': {} }, extracted: { 'libs/tooling': ['tool'] } });
    const nm = join(root, 'libs/tooling/node_modules');
    writeFileSync(join(nm, 'tool/package.json'), JSON.stringify({ name: 'tool', version: '1.0.0', bin: { tool: 'cli.js' } }));
    mkdirSync(join(nm, '.bin'));
    symlinkSync('../tool/cli.js', join(nm, '.bin/tool'));
    let repairs = 0;
    const status = await verifyDepsExtracted({ repoRoot: root, probeSpecifiers: [], runNpm: () => {
      repairs++;
      expect(existsSync(join(nm, 'tool'))).toBe(false);
      mkdirSync(join(nm, 'tool'));
      writeFileSync(join(nm, 'tool/package.json'), JSON.stringify({ name: 'tool', version: '1.0.0' }));
      writeFileSync(join(nm, 'tool/cli.js'), 'ok');
      symlinkSync('../tool/cli.js', join(nm, '.bin/tool'));
      return 0;
    }, deps: { sleep: async () => {} } });
    expect(status).toBe(0);
    expect(repairs).toBe(1);
    expect(existsSync(join(nm, '.bin/tool'))).toBe(true);
  });

  it('refuses success when a repair recreates the dangling link', async () => {
    silenceConsole();
    const root = fixture({ packages: { 'libs/tooling': {} }, extracted: {} });
    const bin = join(root, 'libs/tooling/node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync('../tool/cli.js', join(bin, 'tool'));
    let repairs = 0;
    const status = await verifyDepsExtracted({ repoRoot: root, probeSpecifiers: [], runNpm: () => { repairs++; symlinkSync('../tool/cli.js', join(bin, 'tool')); return 0; }, deps: { sleep: async () => {} } });
    expect(status).toBe(1);
    expect(repairs).toBe(1);
  });

  it('keeps broken bins in unselected workspaces out of a workspace-scoped repair', async () => {
    const root = fixture({ packages: { 'libs/tooling': {}, 'libs/other': {} }, extracted: {} });
    const bin = join(root, 'libs/other/node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync('../tool/cli.js', join(bin, 'tool'));
    const calls: string[][] = [];
    const status = await verifyDepsExtracted({ repoRoot: root, npmArgs: ['install', '--workspace=libs/tooling'], probeSpecifiers: [], runNpm: (args: string[]) => { calls.push(args); return 0; }, deps: { sleep: async () => {} } });
    expect(status).toBe(0);
    expect(calls).toEqual([]);
  });

  it('refuses every pre-repair target outside the repo or workspace node_modules boundary', () => {
    expect(
      packageLocalRepairTargets({
        repoRoot: '/repo',
        findings: [{ workspace: 'libs/testing-shell', package: '@vitest/runner' }],
      }),
    ).toEqual(['/repo/libs/testing-shell/node_modules/@vitest/runner']);
    expect(() =>
      packageLocalRepairTargets({
        repoRoot: '/repo',
        findings: [{ workspace: '../outside', package: 'vitest' }],
      }),
    ).toThrow(/outside repo root/);
    expect(() =>
      packageLocalRepairTargets({
        repoRoot: '/repo',
        findings: [{ workspace: 'libs/testing-shell', package: '../../outside' }],
      }),
    ).toThrow(/outside workspace node_modules/);
  });

  it('returns 0 without repairing when every declared dep resolves', async () => {
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { ok: '^1' } } },
      extracted: { '': ['ok'] },
    });
    const calls: string[][] = [];
    const status = await verifyDepsExtracted({
      repoRoot: root,
      runNpm: (args: string[]) => {
        calls.push(args);
        return 0;
      },
      deps: { sleep: async () => {} },
    });
    expect(status).toBe(0);
    expect(calls).toEqual([]); // no repair install on a healthy tree
  });

  it('REPAIRS once when a dep is un-extracted, then returns 0', async () => {
    silenceConsole();
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { 'was-missing': '^1' } } },
      extracted: {},
    });
    const calls: string[][] = [];
    const status = await verifyDepsExtracted({
      repoRoot: root,
      runNpm: (args: string[]) => {
        calls.push(args);
        mkdirSync(join(root, 'node_modules', 'was-missing'), { recursive: true }); // the repair install lands it
        return 0;
      },
      deps: { sleep: async () => {} },
    });
    expect(status).toBe(0);
    expect(calls).toEqual([['install', '--legacy-peer-deps']]);
  });

  it('FAILS (1) — never silently succeeds — when the repair does not land the dep', async () => {
    silenceConsole();
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { 'still-missing': '^1' } } },
      extracted: {},
    });
    const calls: string[][] = [];
    const status = await verifyDepsExtracted({
      repoRoot: root,
      runNpm: (args: string[]) => {
        calls.push(args);
        return 0; // npm "succeeds" but leaves it un-extracted — the exact bug
      },
      deps: { sleep: async () => {} },
    });
    expect(status).toBe(1);
    expect(calls).toHaveLength(1); // ONE bounded repair, not a loop
  });

  it('REPAIRS once when a hoisted dep resolves to a version outside the declared range', async () => {
    silenceConsole();
    const root = fixture({
      packages: { 'apps/operator-docs': { dependencies: { sharp: '^0.35.0' } } },
      extracted: { '': ['sharp'] },
    });
    const manifestPath = join(root, 'node_modules/sharp/package.json');
    writeFileSync(manifestPath, JSON.stringify({ name: 'sharp', version: '0.34.5' }));
    const calls: string[][] = [];
    const status = await verifyDepsExtracted({
      repoRoot: root,
      runNpm: (args: string[]) => {
        calls.push(args);
        writeFileSync(manifestPath, JSON.stringify({ name: 'sharp', version: '0.35.4' })); // the repair install re-resolves it
        return 0;
      },
      deps: { sleep: async () => {} },
    });
    expect(status).toBe(0);
    expect(calls).toEqual([['install', '--legacy-peer-deps']]);
  });

  it('FAILS (1) when a hoisted range mismatch survives the repair — never publishes an invalid tree as healthy', async () => {
    silenceConsole();
    const root = fixture({
      packages: { 'apps/operator-docs': { dependencies: { sharp: '^0.35.0' } } },
      extracted: { '': ['sharp'] },
    });
    writeFileSync(
      join(root, 'node_modules/sharp/package.json'),
      JSON.stringify({ name: 'sharp', version: '0.34.5' }),
    );
    const calls: string[][] = [];
    const status = await verifyDepsExtracted({
      repoRoot: root,
      runNpm: (args: string[]) => {
        calls.push(args);
        return 0; // npm "succeeds" but the hoisted placement still does not satisfy the range
      },
      deps: { sleep: async () => {} },
    });
    expect(status).toBe(1);
    expect(calls).toHaveLength(1); // ONE bounded repair, not a loop
  });

  it('repairs when package directories exist but a critical runtime import is incomplete', async () => {
    silenceConsole();
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { hono: '^4' } } },
      extracted: { '': ['hono'] },
    });
    let runtimeHealthy = false;
    const calls: string[][] = [];
    const status = await verifyDepsExtracted({
      repoRoot: root,
      probeSpecifiers: ['hono'],
      runNpm: (args: string[]) => {
        calls.push(args);
        runtimeHealthy = true;
        return 0;
      },
      deps: {
        sleep: async () => {},
        probeRuntimeImport: () =>
          runtimeHealthy ? { ok: true } : { ok: false, detail: 'MODULE_NOT_FOUND: hono/dist/cjs/index.js' },
      },
    });
    expect(status).toBe(0);
    expect(calls).toEqual([['install', '--legacy-peer-deps']]);
  });

  it('repairs a package-local dev tool whose directory exists without a manifest', async () => {
    silenceConsole();
    const root = fixture({
      packages: {
        'libs/generic/sse': { devDependencies: { vitest: '^4.1.4' } },
      },
      extracted: { 'libs/generic/sse': ['vitest'] },
    });
    const packageDir = join(root, 'libs/generic/sse/node_modules/vitest');
    const calls: string[][] = [];
    const status = await verifyDepsExtracted({
      repoRoot: root,
      runNpm: (args: string[]) => {
        calls.push(args);
        expect(existsSync(packageDir)).toBe(false);
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(
          join(packageDir, 'package.json'),
          JSON.stringify({ name: 'vitest', version: '4.1.8' }),
        );
        return 0;
      },
      deps: { sleep: async () => {} },
    });

    expect(status).toBe(0);
    expect(calls).toEqual([['install', '--legacy-peer-deps']]);
  });

  it('removes a stale package-local dev tool before repair even when npm does not rewrite it', async () => {
    silenceConsole();
    const root = fixture({
      packages: {
        'libs/generic/sse': { devDependencies: { vitest: '^4.1.4' } },
      },
      extracted: { 'libs/generic/sse': ['vitest'] },
    });
    const manifestPath = join(
      root,
      'libs/generic/sse/node_modules/vitest/package.json',
    );
    const packageDir = join(root, 'libs/generic/sse/node_modules/vitest');
    writeFileSync(
      manifestPath,
      JSON.stringify({ name: 'vitest', version: '3.2.6' }),
    );
    const calls: string[][] = [];
    const status = await verifyDepsExtracted({
      repoRoot: root,
      runNpm: (args: string[]) => {
        calls.push(args);
        expect(existsSync(packageDir)).toBe(false);
        return 0;
      },
      deps: { sleep: async () => {} },
    });

    expect(status).toBe(0);
    expect(calls).toEqual([['install', '--legacy-peer-deps']]);
    expect(existsSync(packageDir)).toBe(false);
  });

  it('removes the matching stale lock entry before npm can recreate the package-local node', async () => {
    silenceConsole();
    const root = fixture({
      packages: {
        'libs/testing-shell': { devDependencies: { vitest: '^4.1.4' } },
      },
      extracted: { 'libs/testing-shell': ['vitest'] },
    });
    const packageDir = join(root, 'libs/testing-shell/node_modules/vitest');
    const manifestPath = join(packageDir, 'package.json');
    const lockPath = join(root, 'package-lock.json');
    const staleLockKey = 'libs/testing-shell/node_modules/vitest';
    writeFileSync(
      manifestPath,
      JSON.stringify({ name: 'vitest', version: '3.2.4' }),
    );
    writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'libs/testing-shell': {
            devDependencies: { vitest: '^4.1.4' },
          },
          [staleLockKey]: { version: '3.2.4', dev: true },
        },
      }),
    );

    const calls: string[][] = [];
    const status = await verifyDepsExtracted({
      repoRoot: root,
      runNpm: (args: string[]) => {
        calls.push(args);
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (lock.packages[staleLockKey]) {
          mkdirSync(packageDir, { recursive: true });
          writeFileSync(
            manifestPath,
            JSON.stringify({ name: 'vitest', version: '3.2.4' }),
          );
        }
        return 0;
      },
      deps: { sleep: async () => {} },
    });

    expect(status).toBe(0);
    expect(calls).toEqual([['install', '--legacy-peer-deps']]);
    expect(existsSync(packageDir)).toBe(false);
    expect(
      JSON.parse(readFileSync(lockPath, 'utf8')).packages[staleLockKey],
    ).toBeUndefined();
  });

  it('does not delete a lock entry that no longer matches the stale installed version', () => {
    const root = fixture({
      packages: {
        'libs/testing-shell': { devDependencies: { vitest: '^4.1.4' } },
      },
      extracted: {},
    });
    const lockPath = join(root, 'package-lock.json');
    const key = 'libs/testing-shell/node_modules/vitest';
    writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 3,
        packages: { [key]: { version: '4.1.8', dev: true } },
      }),
    );

    expect(
      removePackageLocalRepairLockEntries({
        repoRoot: root,
        findings: [
          {
            package: 'vitest',
            workspace: 'libs/testing-shell',
            declared: '^4.1.4',
            installed: '3.2.4',
          },
        ],
      }),
    ).toEqual([]);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).packages[key].version).toBe(
      '4.1.8',
    );
  });

  it('repairs an orphaned dangling workspace link without npm recreating its old target', async () => {
    silenceConsole();
    const root = fixture({
      packages: { 'apps/operator': {}, 'libs/maintained/widget': {} },
      extracted: {},
    });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'dangling-workspace-fixture', private: true,
      workspaces: ['apps/operator', 'libs/maintained/widget'],
    }));
    writeFileSync(join(root, 'apps/operator/package.json'), JSON.stringify({
      name: '@fixture/operator', version: '1.0.0',
      dependencies: { '@fixture/widget': 'file:../../libs/maintained/widget' },
    }));
    writeFileSync(join(root, 'libs/maintained/widget/package.json'), JSON.stringify({
      name: '@fixture/widget', version: '1.0.0',
    }));
    const install = () => fixtureNpm(root, [
      'install', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', '--offline',
    ], {
      ...process.env, PAPERCUSP_INSTALL_SAFE_ACTIVE: '1',
      npm_config_prefix: undefined, NPM_CONFIG_PREFIX: undefined,
      npm_config_package_lock_only: undefined, NPM_CONFIG_PACKAGE_LOCK_ONLY: undefined,
    });
    install();
    const staleKey = 'apps/operator/node_modules/@fixture/widget';
    const target = join(root, staleKey);
    const lockPath = join(root, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages[staleKey] = { resolved: 'libs/obsolete/widget', link: true };
    lock.packages['libs/obsolete/widget'] = {};
    writeFileSync(lockPath, JSON.stringify(lock));
    const hiddenLockPath = join(root, 'node_modules/.package-lock.json');
    const hiddenLock = JSON.parse(readFileSync(hiddenLockPath, 'utf8'));
    hiddenLock.packages[staleKey] = lock.packages[staleKey];
    hiddenLock.packages['libs/obsolete/widget'] = {};
    writeFileSync(hiddenLockPath, JSON.stringify(hiddenLock));
    mkdirSync(join(root, 'apps/operator/node_modules/@fixture'), { recursive: true });
    symlinkSync('../../../../libs/obsolete/widget', target);
    expect(findIncompleteWorkspacePackages({ repoRoot: root })).toEqual([
      { package: '@fixture/widget', workspace: 'apps/operator' },
    ]);
    let repairs = 0;
    const status = await verifyDepsExtracted({
      repoRoot: root, probeSpecifiers: [], deps: { sleep: async () => {} },
      runNpm: () => { repairs++; install(); return 0; },
    });
    expect(repairs).toBe(1);
    expect(status).toBe(0);
    expect(findIncompleteWorkspacePackages({ repoRoot: root })).toEqual([]);
    const repaired = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(repaired.packages[staleKey]).toBeUndefined();
    expect(repaired.packages['node_modules/@fixture/widget']).toEqual({
      resolved: 'libs/maintained/widget', link: true,
    });
  }, 60_000);

  it.each([
    { name: 'healthy link', dangling: false, lockedTarget: 'libs/maintained/widget' },
    { name: 'changed lock target', dangling: true, lockedTarget: 'libs/maintained/widget' },
  ])('preserves a $name while cleaning a detector finding', ({ dangling, lockedTarget }) => {
    const root = fixture({ packages: { 'apps/operator': {}, 'libs/maintained/widget': {} }, extracted: {} });
    const key = 'apps/operator/node_modules/@fixture/widget';
    mkdirSync(join(root, 'apps/operator/node_modules/@fixture'), { recursive: true });
    symlinkSync(`../../../../libs/${dangling ? 'obsolete' : 'maintained'}/widget`, join(root, key));
    const lockPath = join(root, 'package-lock.json');
    const original = JSON.stringify({ lockfileVersion: 3, packages: { [key]: { resolved: lockedTarget, link: true } } });
    writeFileSync(lockPath, original);
    expect(removePackageLocalRepairLockEntries({
      repoRoot: root, findings: [{ workspace: 'apps/operator', package: '@fixture/widget' }],
    })).toEqual([]);
    expect(readFileSync(lockPath, 'utf8')).toBe(original);
  });

  it('fails immediately when the bounded repair exits nonzero, even if later spot probes could pass', async () => {
    silenceConsole();
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { hono: '^4' } } },
      extracted: { '': ['hono'] },
    });
    let calls = 0;
    const status = await verifyDepsExtracted({
      repoRoot: root,
      probeSpecifiers: ['hono'],
      runNpm: () => {
        calls += 1;
        return 217; // observed ENOTEMPTY terminal
      },
      deps: {
        sleep: async () => {},
        probeRuntimeImport: () => ({ ok: false, detail: 'partial package content' }),
      },
    });
    expect(status).toBe(1);
    expect(calls).toBe(1);
  });
});

describe('install:safe managed-repo targeting (EI-20412068513394843)', () => {
  it('targets an explicit managed hive root without consuming npm arguments', () => {
    expect(
      parseCliArgs(
        ['--repo-root', '../sidestage', '--', 'install', '--no-save', 'verdict-cli'],
        { cwd: '/managed/papercusp' },
      ),
    ).toEqual({
      repoRoot: '/managed/sidestage',
      npmArgs: ['install', '--no-save', 'verdict-cli'],
    });
  });

  it('keeps the documented flags-only form faithful by inserting install', () => {
    expect(normalizeNpmArgs([])).toEqual(['install']);
    expect(normalizeNpmArgs(['--legacy-peer-deps'])).toEqual(['install', '--legacy-peer-deps']);
    expect(normalizeNpmArgs(['ci', '--ignore-scripts'])).toEqual(['ci', '--ignore-scripts']);
  });

  it('routes a dependency reader through the repo mutex without treating it as npm argv', () => {
    expect(
      parseCliArgs(['--repo-root', '../sidestage', '--exec-under-lock', '--', 'bash', 'bin/bundle-host.sh'], {
        cwd: '/managed/papercusp',
      }),
    ).toEqual({
      repoRoot: '/managed/sidestage',
      commandArgs: ['bash', 'bin/bundle-host.sh'],
    });
  });

  it('installs the ptool shim as a direct recovery transport', () => {
    const installer = readFileSync(
      join(process.cwd(), '../../apps/operator/scripts/install-standalone-mcp.sh'),
      'utf8',
    );
    const ptoolStart = installer.indexOf('# 4h. Install the `ptool` command');
    const ptoolEnd = installer.indexOf('# 5. Verify the endpoint accepts the token.', ptoolStart);
    const ptoolBlock = installer.slice(ptoolStart, ptoolEnd);

    expect(ptoolStart).toBeGreaterThan(-1);
    expect(ptoolEnd).toBeGreaterThan(ptoolStart);
    expect(ptoolBlock).toContain('node "${PTOOL_LAUNCHER}" "\\$@"');
    expect(ptoolBlock).not.toContain('npm-install-safe.mjs');
    expect(ptoolBlock).not.toContain('--exec-under-lock');
  });

  it('marks a guarded reader child and preserves the selected repo cwd', async () => {
    silenceConsole();
    const root = fixture({ packages: { 'apps/operator': { dependencies: {} } }, extracted: {} });
    type GuardedCommandOptions = { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv };
    const calls: Array<{ command: string; args: string[]; options: GuardedCommandOptions }> = [];

    await expect(
      runCommandUnderInstallMutex({
        repoRoot: root,
        commandArgs: ['bash', 'bin/bundle-host.sh', 'entry.ts'],
        runCommand: (command: string, args: string[], options: GuardedCommandOptions) => {
          calls.push({ command, args, options });
          return { status: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'bash',
      args: ['bin/bundle-host.sh', 'entry.ts'],
      options: { cwd: root },
    });
    expect(calls[0].options.env.PAPERCUSP_INSTALL_MUTEX_HELD?.split(',')).toContain(repoLockName(root));
  });

  it('routes guarded-reader diagnostics to stderr so stdout stays JSON-safe', async () => {
    const root = fixture({ packages: { 'apps/operator': { dependencies: {} } }, extracted: {} });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runCommandUnderInstallMutex({
        repoRoot: root,
        commandArgs: ['node', '-e', 'process.stdout.write(\'{"ok":true}\\n\')'],
        runCommand: () => ({ status: 0 }),
      }),
    ).resolves.toBe(0);

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('NPM_INSTALL_SAFE guarding reader: node -e'));
  });

  it.each(['scoped', 'legacy'])('waits for another repo writer with an inherited %s reader marker', async (marker) => {
    silenceConsole();
    const first = fixture({ packages: {}, extracted: {} });
    const second = fixture({ packages: {}, extracted: {} });
    let inherited: NodeJS.ProcessEnv = {};
    await runCommandUnderInstallMutex({
      repoRoot: first,
      commandArgs: ['first-reader'],
      env: {},
      runCommand: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        inherited = options.env;
        return { status: 0 };
      },
    });
    if (marker === 'legacy') inherited = { ...inherited, PAPERCUSP_INSTALL_MUTEX_HELD: '1' };

    let releaseWriter = () => {};
    let writerEntered = () => {};
    const writerReady = new Promise<void>((resolve) => { writerEntered = resolve; });
    const writer = withFsMutex(repoLockName(second), async () => {
      writerEntered();
      await new Promise<void>((resolve) => { releaseWriter = resolve; });
    }, { retryMs: 5 });
    await writerReady;
    let readerRan = false;
    const reader = runCommandUnderInstallMutex({
      repoRoot: second,
      commandArgs: ['second-reader'],
      env: inherited,
      runCommand: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        readerRan = true;
        const names = options.env.PAPERCUSP_INSTALL_MUTEX_HELD?.split(',');
        expect(names).toContain(repoLockName(second));
        if (marker === 'scoped') expect(names).toContain(repoLockName(first));
        else expect(names).not.toContain('1');
        return { status: 0 };
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(readerRan).toBe(false);
    } finally {
      releaseWriter();
      await writer;
      await expect(reader).resolves.toBe(0);
    }
    expect(readerRan).toBe(true);
  });

  it('keys the mutex by the selected root realpath, including symlink aliases', () => {
    const parent = mkdtempSync(join(tmpdir(), 'install-safe-root-'));
    made.push(parent);
    const target = join(parent, 'target');
    const alias = join(parent, 'alias');
    const other = join(parent, 'other');
    mkdirSync(target);
    mkdirSync(other);
    symlinkSync(target, alias);

    expect(repoLockName(alias)).toBe(repoLockName(target));
    expect(repoLockName(other)).not.toBe(repoLockName(target));
  });
});
