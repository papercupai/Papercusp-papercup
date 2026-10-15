/**
 * bundle-psu.mjs (pui-first-party-public-release D-031 / P-018): the psu that
 * ships in the public PUI archive is built from the COMMITTED generation, never
 * from the working tree.
 *
 * Each case commits a variant of HEAD into a throwaway object store that borrows
 * this repository's objects (the shared checkout is never written) and runs the
 * real bundler against that commit with GIT_DIR pointing at the store — the same
 * technique the P-011 compatibility-claim regression uses. The oracles are
 * independent of the bundler: the bytes we committed, the working-tree file, and
 * the lock entry we altered.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BUNDLER = path.join(REPO_ROOT, 'apps/tui/scripts/bundle-psu.mjs');
const NATIVE_BUILDS = path.join(REPO_ROOT, 'packages/omp-plugin/build-native.mjs');
const ENTRY = 'apps/operator/scripts/psu-launcher.mjs';

const git = (...args: string[]) => execFileSync('git', ['-C', REPO_ROOT, ...args], {
  encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
}).trim();
const output = (run: SpawnSyncReturns<string>) => `status=${run.status}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`;

let WORK = '';
let STORE = '';
let HEAD = '';
let HOST_BANNER = '';

/** Commit HEAD's tree with `changes` applied into the throwaway store; returns the commit id. */
function variant(changes: Record<string, string>): string {
  const index = path.join(STORE, 'variant-index');
  const scratchGit = (args: string[], input?: string) => execFileSync('git', ['--git-dir', STORE, ...args], {
    encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env, GIT_INDEX_FILE: index,
      GIT_AUTHOR_NAME: 'p018', GIT_AUTHOR_EMAIL: 'p018@invalid', GIT_COMMITTER_NAME: 'p018', GIT_COMMITTER_EMAIL: 'p018@invalid',
    },
  }).trim();
  rmSync(index, { force: true });
  scratchGit(['read-tree', HEAD]);
  // Child source loaders judge this fixture's HEAD as well as the requested sha.
  // Commit the bundler under test so local fixes are exercised before git-sync.
  const fixtureChanges = { 'apps/tui/scripts/bundle-psu.mjs': readFileSync(BUNDLER, 'utf8'), ...changes };
  for (const [file, content] of Object.entries(fixtureChanges)) {
    const blob = scratchGit(['hash-object', '-w', '--stdin'], content);
    scratchGit(['update-index', '--cacheinfo', `100644,${blob},${file}`]);
  }
  const sha = scratchGit(['commit-tree', scratchGit(['write-tree']), '-p', HEAD, '-m', 'p018 variant']);
  scratchGit(['update-ref', 'HEAD', sha]);
  return sha;
}

function bundle(sha: string, label: string, options: { target?: string; cache?: string } = {}) {
  const out = path.join(WORK, label);
  const run = spawnSync('node', [
    BUNDLER, '--root', REPO_ROOT, '--sha', sha, '--target', options.target ?? 'linux-x86_64',
    '--out', path.join(out, 'lib', 'psu'), '--summary', path.join(out, 'summary.json'),
    '--native-builds', NATIVE_BUILDS, '--cache', options.cache ?? path.join(WORK, 'cache'),
  ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000, env: { ...process.env, GIT_DIR: STORE, HOST_BANNER } });
  return { run, out };
}

beforeAll(() => {
  WORK = mkdtempSync(path.join(tmpdir(), 'pui-bundle-psu-'));
  STORE = path.join(WORK, 'variants.git');
  execFileSync('git', ['init', '--bare', '--quiet', STORE]);
  writeFileSync(path.join(STORE, 'objects', 'info', 'alternates'), `${path.resolve(REPO_ROOT, git('rev-parse', '--git-path', 'objects'))}\n`);
  HEAD = git('rev-parse', 'HEAD');
  HOST_BANNER = execFileSync('bash', ['-c', 'source apps/operator/bin/bundle-host-common.sh && printf %s "$HOST_BANNER"'], {
    cwd: REPO_ROOT, encoding: 'utf8',
  });
  expect(HOST_BANNER).toContain('createRequire');
});

afterAll(() => {
  if (WORK) rmSync(WORK, { recursive: true, force: true });
});

describe.sequential('bundle-psu.mjs builds psu from the committed generation', () => {
  test.skipIf(process.platform !== 'linux' || !existsSync('/dev/shm')
    || statSync('/dev/shm').dev === statSync(tmpdir()).dev)(
    'extracts a locked Mac native addon when the cache and temporary directory use different filesystems',
    { timeout: 240_000 }, () => {
      const cache = mkdtempSync('/dev/shm/pui-bundle-cache-');
      try {
        expect(statSync(cache).dev).not.toBe(statSync(tmpdir()).dev);
        const platformKey = 'node_modules/@lydell/node-pty-darwin-x64';
        expect(existsSync(path.join(REPO_ROOT, platformKey, 'package.json'))).toBe(false);
        const lock = JSON.parse(git('show', `${HEAD}:package-lock.json`)) as {
          packages: Record<string, { version: string; resolved?: string; integrity?: string }>;
        };
        const version = lock.packages[platformKey].version;
        const packageDir = path.join(WORK, 'mac-addon-tarball', 'package');
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
          name: '@lydell/node-pty-darwin-x64', version, license: 'MIT',
        }));
        const addonBytes = Buffer.from('cross-filesystem native addon fixture');
        writeFileSync(path.join(packageDir, 'pty.node'), addonBytes);
        const tarball = path.join(WORK, 'mac-addon.tgz');
        execFileSync('tar', ['-czf', tarball, '-C', path.dirname(packageDir), 'package']);
        const bytes = readFileSync(tarball);
        lock.packages[platformKey] = {
          ...lock.packages[platformKey],
          resolved: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        };
        const sha = variant({ 'package-lock.json': `${JSON.stringify(lock, null, 2)}\n` });
        const { run, out } = bundle(sha, 'cross-filesystem-mac-addon', { target: 'macos-x86_64', cache });
        expect(run.status, output(run)).toBe(0);
        const addon = path.join(out, 'lib', 'psu', 'node_modules', '@lydell', 'node-pty-darwin-x64');
        expect(readFileSync(path.join(addon, 'pty.node'))).toEqual(addonBytes);
        expect(JSON.parse(readFileSync(path.join(addon, 'package.json'), 'utf8')).version).toBe(version);
        expect(readdirSync(cache).some((entry) => entry.startsWith('bundle-psu-pty-'))).toBe(false);
        const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
        expect(summary.npmPackages).toContainEqual(expect.objectContaining({
          name: '@lydell/node-pty-darwin-x64', version, lockKey: platformKey,
        }));
      } finally {
        rmSync(cache, { recursive: true, force: true });
      }
    },
  );

  test('AUTO-BAR-R-11-P-018: committed bytes reach psu.mjs; the working tree does not', { timeout: 240_000 }, () => {
    const marker = `P018-COMMITTED-ONLY-${randomBytes(8).toString('hex')}`;
    // Commit the launcher under test into the fixture store so local launcher
    // fixes are exercised before git-sync; the marker still exists only there.
    const committedEntry = `${readFileSync(path.join(REPO_ROOT, ENTRY), 'utf8')}\nglobalThis.__p018CommittedMarker = ${JSON.stringify(marker)};\n`;
    // Positive control: the marker exists only in the commit, never on disk.
    expect(readFileSync(path.join(REPO_ROOT, ENTRY), 'utf8')).not.toContain(marker);
    const sha = variant({ [ENTRY]: committedEntry });

    const { run, out } = bundle(sha, 'committed');
    expect(run.status, output(run)).toBe(0);
    const psu = readFileSync(path.join(out, 'lib', 'psu', 'psu.mjs'), 'utf8');
    expect(psu).toContain(marker);
    // esbuild keeps the entry's hashbang first; the shared host banner follows it.
    expect(psu.split('\n', 2)[1]).toBe(HOST_BANNER);
    for (const hostPath of [REPO_ROOT, homedir()]) expect(psu.includes(hostPath), hostPath).toBe(false);
    for (const native of ['native-client.cjs', 'native-extension.mjs']) {
      expect(existsSync(path.join(out, 'lib', 'psu', native)), native).toBe(true);
    }
    expect(existsSync(path.join(out, 'lib', 'psu', 'node_modules', '@lydell', 'node-pty', 'package.json'))).toBe(true);
    expect(existsSync(path.join(out, 'lib', 'psu', 'node_modules', '@lydell', 'node-pty-linux-x64', 'package.json'))).toBe(true);

    // A downloaded bundle has neither the source package.json nor a build-id
    // environment. Its version must still come from this committed generation.
    const releaseVersion = git('show', `${HEAD}:apps/tui/Cargo.toml`)
      .match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (!releaseVersion) throw new Error('committed apps/tui/Cargo.toml has no PUI release version');
    const version = spawnSync(process.execPath, [path.join(out, 'lib', 'psu', 'psu.mjs'), '--version'], {
      cwd: WORK, env: { HOME: WORK, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5_000,
    });
    expect(version.status, output(version)).toBe(0);
    expect(version.stdout).toBe(`psu ${releaseVersion}\n`);

    const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8')) as {
      sourcePins: Record<string, string>;
      firstPartyInputs: number;
      npmPackages: { name: string; version: string; license: string | null; lockKey: string }[];
    };
    expect(summary.sourcePins['.']).toBe(sha);
    // Each submodule the superproject pins directly was read at exactly that gitlink.
    const repos = Object.keys(summary.sourcePins).filter((repo) => repo !== '.');
    for (const repo of repos.filter((r) => !repos.some((parent) => r.startsWith(`${parent}/`)))) {
      expect(summary.sourcePins[repo], repo).toBe(git('rev-parse', `${HEAD}:${repo}`));
    }
    expect(repos.length).toBeGreaterThan(0);
    expect(summary.firstPartyInputs).toBeGreaterThan(10);
    const lock = JSON.parse(git('show', `${HEAD}:package-lock.json`)) as { packages: Record<string, { version: string }> };
    for (const pkg of summary.npmPackages) {
      expect(pkg.license, pkg.name).toBeTruthy();
      expect(lock.packages[pkg.lockKey]?.version, pkg.lockKey).toBe(pkg.version);
    }
  });

  test('AUTO-BAR-R-11-P-018: unrelated package scripts do not prevent a committed-generation build', { timeout: 240_000 }, () => {
    const manifest = 'packages/operator-core/package.json';
    const committed = JSON.parse(git('show', `${HEAD}:${manifest}`)) as Record<string, unknown>;
    const marker = `P018-COMMITTED-SCRIPTS-${randomBytes(8).toString('hex')}`;
    const sha = variant({
      [manifest]: `${JSON.stringify({ ...committed, scripts: { 'probe:must-not-run': 'exit 99' } }, null, 2)}\n`,
      [ENTRY]: `${git('show', `${HEAD}:${ENTRY}`)}\nglobalThis.__p018ScriptMetadata = ${JSON.stringify(marker)};\n`,
    });
    const { run, out } = bundle(sha, 'script-metadata');
    expect(run.status, output(run)).toBe(0);
    expect(readFileSync(path.join(out, 'lib', 'psu', 'psu.mjs'), 'utf8')).toContain(marker);
    expect(JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8')).sourcePins['.']).toBe(sha);
    expect(readFileSync(path.join(REPO_ROOT, ENTRY), 'utf8')).not.toContain(marker);
  });

  test('AUTO-BAR-R-11-P-018: a module-resolution file that differs from the commit is refused', { timeout: 240_000 }, () => {
    const manifest = 'apps/operator/package.json';
    const committed = JSON.parse(git('show', `${HEAD}:${manifest}`)) as Record<string, unknown>;
    const sha = variant({ [manifest]: `${JSON.stringify({ ...committed, p018Probe: true }, null, 2)}\n` });
    const { run, out } = bundle(sha, 'drifted');
    expect(run.status, output(run)).not.toBe(0);
    expect(run.stderr).toContain('module resolution read files that differ');
    expect(run.stderr).toContain(manifest);
    expect(existsSync(path.join(out, 'summary.json'))).toBe(false);
  });

  test('AUTO-BAR-R-11-P-018: an installed npm package that is not the locked version is refused', { timeout: 240_000 }, () => {
    const lock = JSON.parse(git('show', `${HEAD}:package-lock.json`)) as { packages: Record<string, { version: string }> };
    const key = 'node_modules/@inquirer/prompts';
    expect(lock.packages[key]?.version).toBeTruthy();
    lock.packages[key] = { ...lock.packages[key], version: '0.0.0-p018' };
    const sha = variant({ 'package-lock.json': `${JSON.stringify(lock, null, 2)}\n` });
    const { run, out } = bundle(sha, 'unlocked');
    expect(run.status, output(run)).not.toBe(0);
    expect(run.stderr).toContain(key);
    expect(run.stderr).toContain('pins 0.0.0-p018');
    expect(existsSync(path.join(out, 'summary.json'))).toBe(false);
  });
});
