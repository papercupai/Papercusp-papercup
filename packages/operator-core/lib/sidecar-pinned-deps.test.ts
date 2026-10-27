/**
 * EI-21832562420831737, part three — a release-audited sidecar cut may not read its
 * dependencies out of a tree other agents are writing.
 *
 * Parts one and two guarded SOURCE (one repo root; refuse a tree that was dirty at the phase
 * boundary). This suite guards the other half of what the build reads: node_modules.
 *
 * The shape being refused is not hypothetical. The cut that shipped r15 overlay-mounted 86
 * dependency trees whose lower layer was the LIVE shared checkout, and r14 — the same shape,
 * with dependency generation still on to notice — died on a torn cache hit when a concurrent
 * live build rewrote that lower layer mid-comparison (D-187). D-186 then switched dependency
 * generation off for cost, so the hazard outlived its only detector.
 *
 * WHY THIS FILE CAN BE RUN AT ALL, which is the part that took the design work: the coupling
 * it exists to refuse needs root to create, so the honest options were a source grep (a guard
 * nobody can falsify) or an injectable mount table. `papercusp_assert_pinned_deps_decoupled`
 * therefore takes the mountinfo path as a POSITIONAL PARAMETER — never an environment
 * variable, which would let an ambient `=/dev/null` blind a release gate — and the producer is
 * guard-tested below to pass exactly two arguments.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  statSync,
  lstatSync,
  chmodSync,
  linkSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/build-desktop-sidecar.sh above this test)',
  );
}

const ROOT = repoRoot();

/** Subject paths, overridable so a mutation probe can aim this suite at a COPY. */
const HELPER_PATH =
  process.env.PAPERCUSP_PINNED_DEPS_HELPER_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'pinned-deps.sh');
const PRODUCER_PATH =
  process.env.PAPERCUSP_PINNED_DEPS_PRODUCER_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');

/** Comments never count — a rule that a comment can satisfy is not a rule. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Drive the library through its script dispatcher, the way the locked snapshot path
 * re-invokes it. spawnSync rather than execFileSync because a REFUSAL is the expected
 * outcome in most cases here, and the exit code plus the operator-facing message are both
 * part of the contract.
 *
 * WI-41180: a sync spawn blocks the worker's event loop, so vitest cannot time it out, and
 * the pure lane shares one fork across thousands of files — an unbounded hang here wedges
 * all of them until the batch watchdog fires.
 */
function runLib(args: string[], env?: NodeJS.ProcessEnv, cwd?: string): { code: number; out: string; err: string } {
  const r = spawnSync('bash', [HELPER_PATH, ...args], {
    encoding: 'utf8',
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { code: r.status ?? -1, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pinned-deps-'));
  scratch.push(dir);
  return dir;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/**
 * A synthetic /proc/self/mountinfo line. Field order is the kernel's:
 *   id parent maj:min ROOT MOUNTPOINT OPTIONS [tags...] - FSTYPE SOURCE SUPEROPTS
 * For an overlay the per-superblock `lowerdir=` lives in SUPEROPTS; for a bind mount the
 * source path is ROOT, because these filesystems are mounted at /.
 */
function overlayLine(mountpoint: string, lowerdir: string): string {
  return `900 25 0:99 / ${mountpoint} rw,relatime - overlay overlay-fixture rw,lowerdir=${lowerdir},upperdir=/tmp/u,workdir=/tmp/w`;
}
function bindLine(mountpoint: string, source: string): string {
  return `901 25 259:2 ${source} ${mountpoint} rw,relatime - ext4 /dev/fixture rw`;
}

describe('EI-21832562420831737 — a pinned cut owns its dependencies', () => {
  beforeAll(() => {
    if (!existsSync(HELPER_PATH)) {
      throw new Error(`pinned-deps helper missing at ${HELPER_PATH}`);
    }
  });

  describe('papercusp_pinned_deps_trees — what the build will actually read', () => {
    it('finds dependency trees at the depths a workspace install reaches', () => {
      const t = fixture();
      mkdirSync(join(t, 'node_modules'), { recursive: true });
      mkdirSync(join(t, 'apps', 'operator', 'node_modules'), { recursive: true });
      const trees = runLib(['trees', t]).out.trim().split('\n').filter(Boolean);
      expect(trees).toContain('node_modules');
      expect(trees).toContain('apps/operator/node_modules');
    });

    it('EXCLUDES the generated sidecar output dir — D-187, which cost a release', () => {
      const t = fixture();
      mkdirSync(join(t, 'papercusp-desktop', 'src-tauri', 'sidecar', 'node_modules'), {
        recursive: true,
      });
      const trees = runLib(['trees', t]).out.trim().split('\n').filter(Boolean);
      expect(trees).not.toContain('papercusp-desktop/src-tauri/sidecar/node_modules');
    });

    it('EXCLUDES nested trees under a node_modules — they are reached through the parent', () => {
      const t = fixture();
      mkdirSync(join(t, 'node_modules', 'pkg', 'node_modules'), { recursive: true });
      const trees = runLib(['trees', t]).out.trim().split('\n').filter(Boolean);
      expect(trees).toEqual(['node_modules']);
    });

    it('EXCLUDES agent scratch under .papercusp — it is not build input', () => {
      const t = fixture();
      mkdirSync(join(t, '.papercusp', 'scratch', 'node_modules'), { recursive: true });
      const trees = runLib(['trees', t]).out.trim().split('\n').filter(Boolean);
      expect(trees).toEqual([]);
    });

    it('a fresh worktree with no dependencies is an ANSWER, not an error', () => {
      const r = runLib(['trees', fixture()]);
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe('');
    });

    it('WI-41095 shares the full-depth tracked-repository boundary', () => {
      const t = fixture();
      const git = (args: string[]) => {
        const r = spawnSync('git', ['-C', t, ...args], { encoding: 'utf8', timeout: 10_000 });
        expect(r.status, r.stderr).toBe(0);
      };
      git(['init', '-q']);
      for (const path of ['apps/foreign', 'libs/tracked']) {
        mkdirSync(join(t, path), { recursive: true });
        git(['init', '-q', path]);
        write(join(t, path, 'node_modules/p/index.js'), 'package');
      }
      git(['update-index', '--add', '--cacheinfo', '160000', '1'.repeat(40), 'libs/tracked']);
      write(join(t, 'packages/deep/one/two/three/node_modules/p/index.js'), 'deep');
      const r = runLib(['trees', t]);
      expect(r.code, r.err).toBe(0);
      expect(r.out.trim().split('\n').sort()).toEqual([
        'libs/tracked/node_modules', 'packages/deep/one/two/three/node_modules',
      ]);
    });
  });

  describe('WI-41095 donor and planned source closure preflight', () => {
    it.each(['hardlink', 'copy'])('excludes exact npm-retired executable shims from a %s snapshot without changing the donor', mode => {
      const t = fixture(); const donor = join(t, 'donor'); const out = join(t, 'snapshot');
      const modules = join(donor, 'node_modules/@fixture/glob/node_modules');
      // Include rsync metacharacters: exclusion must identify this exact entry.
      const name = 'glob[old]*'; const bin = join(modules, '.bin', name);
      const hash = createHash('sha1').update(bin).digest('base64').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8);
      const retiredName = `.${name}-${hash}`;
      const retired = join(modules, '.bin', retiredName);
      write(join(modules, 'glob/bin.js'), 'healthy executable');
      mkdirSync(dirname(bin)); symlinkSync('../glob/bin.js', bin);
      symlinkSync('../.glob-retired/bin.js', retired);
      const retiredOutput = join(out, 'node_modules/@fixture/glob/node_modules/.bin', retiredName);
      const r = runLib(['snapshot', donor, out, mode]);
      expect(r.code, r.err).toBe(0);
      expect(readFileSync(join(out, 'node_modules/@fixture/glob/node_modules/.bin', name), 'utf8')).toBe('healthy executable');
      expect(lstatSync(retiredOutput, { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(retired).isSymbolicLink()).toBe(true);
      // A resumed/reused destination must lose old excluded entries as well.
      symlinkSync('../.glob-retired/bin.js', retiredOutput);
      const resumed = runLib(['snapshot', donor, out, mode]);
      expect(resumed.code, resumed.err).toBe(0);
      expect(lstatSync(retiredOutput, { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(retired).isSymbolicLink()).toBe(true);
    });
    it('still rejects broken active executables beside an exact npm-retired shim', () => {
      const t = fixture(); const donor = join(t, 'donor'); const out = join(t, 'snapshot');
      const bin = join(donor, 'node_modules/.bin/glob');
      const hash = createHash('sha1').update(bin).digest('base64').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8);
      mkdirSync(dirname(bin), { recursive: true });
      symlinkSync('../missing/bin.js', join(dirname(bin), `.glob-${hash}`));
      symlinkSync('../missing/bin.js', bin);
      const r = runLib(['snapshot', donor, out]);
      expect(r.code).toBe(1); expect(r.err).toContain('dangling-pinned-dependency-link:node_modules/.bin/glob');
      expect(existsSync(out)).toBe(false);
    });
    it('does not classify a retirement-shaped name with the wrong npm hash as disposable', () => {
      const t = fixture(); const donor = join(t, 'donor'); const out = join(t, 'snapshot');
      mkdirSync(join(donor, 'node_modules/.bin'), { recursive: true });
      symlinkSync('../missing/bin.js', join(donor, 'node_modules/.bin/.glob-00000000'));
      const r = runLib(['snapshot', donor, out]);
      expect(r.code).toBe(1); expect(r.err).toContain('dangling-pinned-dependency-link:node_modules/.bin/.glob-00000000');
      expect(existsSync(out)).toBe(false);
    });
    it('refuses dangling .bin links before allocating a snapshot', () => {
      const t = fixture(); const donor = join(t, 'donor'); const out = join(t, 'snapshot');
      mkdirSync(join(donor, 'node_modules/.bin'), { recursive: true });
      symlinkSync('../vitest/vitest.mjs', join(donor, 'node_modules/.bin/vitest'));
      const r = runLib(['snapshot', donor, out]);
      expect(r.code).toBe(1); expect(r.err).toContain('dangling-pinned-dependency-link:node_modules/.bin/vitest');
      expect(existsSync(out)).toBe(false);
    });
    it.each(['absolute', 'escape'])('refuses %s dependency links before allocation', kind => {
      const t = fixture(); const donor = join(t, 'donor'); const out = join(t, 'snapshot');
      write(join(donor, 'node_modules/p/index.js'), 'valid'); write(join(t, 'external'), 'outside');
      symlinkSync(kind === 'absolute' ? join(donor, 'node_modules/p/index.js') : '../../external',
        join(donor, 'node_modules/link'));
      const r = runLib(['snapshot', donor, out]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(kind === 'absolute' ? 'absolute-pinned-dependency-link' : 'escaping-pinned-dependency-link');
      expect(existsSync(out)).toBe(false);
    });
    it('refuses the donor self-link created by relinking a prepared host output', () => {
      const t = fixture(); const donor = join(t, 'donor'); const out = join(t, 'snapshot');
      const modules = join(donor, 'node_modules');
      const hostModules = join(t, 'host', 'node_modules');
      write(join(modules, 'p/index.js'), 'preserved package');
      mkdirSync(dirname(hostModules), { recursive: true });
      symlinkSync(modules, hostModules);
      // Legacy caller sequence: bundle-host has prepared host/node_modules;
      // an unconditional ln follows that directory symlink into the donor.
      const relink = spawnSync('ln', ['-s', modules, hostModules], { encoding: 'utf8', timeout: 5_000 });
      expect(relink.status, relink.stderr).toBe(0);
      expect(readFileSync(join(modules, 'p/index.js'), 'utf8')).toBe('preserved package');
      const r = runLib(['snapshot', donor, out]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('absolute-pinned-dependency-link:node_modules/node_modules');
      expect(existsSync(out)).toBe(false);
    });
    it('requires workspace link targets in the declared source population', () => {
      const t = fixture(); const donor = join(t, 'donor');
      write(join(donor, 'libs/workspace/index.js'), 'workspace'); mkdirSync(join(donor, 'node_modules'));
      symlinkSync('../libs/workspace', join(donor, 'node_modules/workspace'));
      const population = join(t, 'population.json'); write(population, JSON.stringify([]));
      expect(runLib(['preflight', donor, population]).err).toContain('unplanned-pinned-dependency-target');
      write(population, JSON.stringify(['libs/workspace/index.js']));
      const r = runLib(['preflight', donor, population]);
      expect(r.code, r.err).toBe(0);
    });
    it('rechecks the donor after entering its install mutex', () => {
      const t = fixture(); const donor = join(t, 'donor'); const out = join(t, 'snapshot');
      write(join(donor, 'node_modules/vitest/vitest.mjs'), 'healthy');
      mkdirSync(join(donor, 'node_modules/.bin')); symlinkSync('../vitest/vitest.mjs', join(donor, 'node_modules/.bin/vitest'));
      write(join(donor, 'scripts/npm-install-safe.mjs'), `import { unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
unlinkSync(${JSON.stringify(join(donor, 'node_modules/vitest/vitest.mjs'))});
const args = process.argv.slice(process.argv.indexOf('--') + 1);
const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit' });
process.exit(result.status ?? 1);`);
      const r = runLib(['snapshot-locked', donor, out]);
      expect(r.code).toBe(1); expect(r.err).toContain('dangling-pinned-dependency-link');
      expect(existsSync(out)).toBe(false);
    });
  });

  describe('papercusp_pinned_deps_snapshot — the floor the overlay stands on', () => {
    it.each(['hardlink', 'copy'])('preserves workspace executable closure in a complete %s verifier and a nested snapshot', mode => {
      const t = fixture(); const donor = join(t, 'donor');
      const manifest = JSON.stringify({ name: '@fixture/cli', bin: { cli: './dist/cli.js' } });
      write(join(donor, 'packages/cli/package.json'), manifest);
      write(join(donor, 'packages/cli/dist/cli.js'), 'import "./support.js";');
      write(join(donor, 'packages/cli/dist/support.js'), 'export const frozen = true;');
      mkdirSync(join(donor, 'node_modules/@fixture'), { recursive: true });
      mkdirSync(join(donor, 'node_modules/.bin'));
      symlinkSync('../../packages/cli', join(donor, 'node_modules/@fixture/cli'));
      symlinkSync('../@fixture/cli/dist/cli.js', join(donor, 'node_modules/.bin/cli'));
      const prepare = (root: string) => {
        write(join(root, 'packages/cli/package.json'), manifest);
        write(join(root, '.verifier-source.json'), JSON.stringify({ files: [{ path: 'packages/cli/package.json' }] }));
      };
      const snapshot = join(t, 'snapshot'); prepare(snapshot);
      const first = runLib(['snapshot', donor, snapshot, mode]);
      expect(first.code, first.err).toBe(0);
      expect(readFileSync(join(snapshot, 'node_modules/.bin/cli'), 'utf8')).toContain('./support.js');
      expect(readFileSync(join(snapshot, 'packages/cli/dist/support.js'), 'utf8')).toContain('frozen');
      const nested = join(t, 'nested'); prepare(nested);
      const second = runLib(['snapshot', snapshot, nested, mode]);
      expect(second.code, second.err).toBe(0);
      rmSync(join(donor, 'packages/cli/dist'), { recursive: true });
      expect(readFileSync(join(nested, 'node_modules/.bin/cli'), 'utf8')).toContain('./support.js');
      expect(statSync(join(nested, 'packages/cli/dist/cli.js')).ino === statSync(join(snapshot, 'packages/cli/dist/cli.js')).ino)
        .toBe(mode === 'hardlink');
      expect(runLib(['preflight', nested]).code).toBe(0);
    });

    it('refuses an incomplete copied workspace closure instead of stamping donor validity', () => {
      const t = fixture(); const donor = join(t, 'donor'); const snapshot = join(t, 'snapshot');
      write(join(donor, 'packages/cli/package.json'), JSON.stringify({ name: 'cli' }));
      write(join(donor, 'packages/cli/source.js'), 'source');
      mkdirSync(join(donor, 'node_modules/.bin'), { recursive: true });
      symlinkSync('../../packages/cli/source.js', join(donor, 'node_modules/.bin/cli'));
      write(join(snapshot, '.verifier-source.json'), JSON.stringify({ files: [] }));
      const r = runLib(['snapshot', donor, snapshot]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('dangling-pinned-dependency-link:node_modules/.bin/cli');
      expect(existsSync(join(snapshot, '.papercusp-pinned-deps'))).toBe(false);
    });

    it('refuses workspace output when the frozen manifest differs from its donor', () => {
      const t = fixture(); const donor = join(t, 'donor'); const snapshot = join(t, 'snapshot');
      write(join(donor, 'packages/cli/package.json'), JSON.stringify({ name: 'cli', version: '2', bin: './dist/cli.js' }));
      write(join(donor, 'packages/cli/dist/cli.js'), 'donor');
      write(join(donor, 'node_modules/dep/index.js'), 'dep');
      write(join(snapshot, 'packages/cli/package.json'), JSON.stringify({ name: 'cli', version: '1', bin: './dist/cli.js' }));
      write(join(snapshot, '.verifier-source.json'), JSON.stringify({ files: [{ path: 'packages/cli/package.json' }] }));
      const r = runLib(['snapshot', donor, snapshot]);
      expect(r.code).toBe(1); expect(r.err).toContain('workspace-bin-manifest-mismatch');
      expect(existsSync(join(snapshot, '.papercusp-pinned-deps'))).toBe(false);
      expect(existsSync(join(snapshot, 'packages/cli/dist'))).toBe(false);
    });

    it('preserves hardlink identity when the donor is given as a relative path', () => {
      const t = fixture(); const donor = join(t, 'donor'); const snapshot = join(t, 'snap');
      const source = join(donor, 'node_modules/dep/index.js');
      write(source, 'package');
      const r = runLib(['snapshot', 'donor', snapshot], undefined, t);
      expect(r.code, r.err).toBe(0);
      expect(statSync(join(snapshot, 'node_modules/dep/index.js')).ino).toBe(statSync(source).ino);
    });

    it('refuses an actual hardlink failure before copying even when device numbers agree', () => {
      const t = fixture(); const donor = join(t, 'donor'); const snapshot = join(t, 'snap');
      write(join(donor, 'node_modules/dep/index.js'), 'package');
      write(join(snapshot, '.papercusp-pinned-deps'), 'stale success');
      expect(statSync(donor).dev).toBe(statSync(snapshot).dev);
      const bin = join(t, 'bin'); const copied = join(t, 'rsync-called');
      // Reproduce link(2)'s same-device, different-mount refusal without a
      // privileged mount or a dependency on this host's /tmp layout.
      write(join(bin, 'ln'), '#!/usr/bin/env bash\necho "Invalid cross-device link" >&2\nexit 1\n');
      write(join(bin, 'rsync'), '#!/usr/bin/env bash\ntouch "$PINNED_DEPS_TEST_RSYNC_CALLED"\nexit 0\n');
      chmodSync(join(bin, 'ln'), 0o755); chmodSync(join(bin, 'rsync'), 0o755);
      const r = runLib(['snapshot', donor, snapshot], { PATH: `${bin}:${process.env.PATH}`,
        PINNED_DEPS_TEST_RSYNC_CALLED: copied });
      expect(r.code).toBe(1);
      expect(r.err).toContain('hardlink admission failed');
      expect(r.err).toContain('Invalid cross-device link');
      expect(existsSync(copied)).toBe(false);
      expect(existsSync(join(snapshot, '.papercusp-pinned-deps'))).toBe(false);
      expect(readFileSync(join(donor, 'node_modules/dep/index.js'), 'utf8')).toBe('package');
    });

    it.each(['completed', 'staging'])('removes disposable caches from a retained %s copy', retained => {
      const t = fixture(); const donor = join(t, 'donor'); const snapshot = join(t, 'snap');
      write(join(donor, 'node_modules/dep/index.js'), 'package');
      expect(runLib(['snapshot', donor, snapshot, 'copy']).code).toBe(0);
      const retainedTree = join(snapshot, retained === 'completed' ? 'node_modules' : 'node_modules.pinned-deps-tmp');
      if (retained === 'staging') {
        write(join(retainedTree, 'dep/index.js'), 'package');
        write(join(donor, 'node_modules/dep/index.js'), 'updated package');
      }
      const directories = [retainedTree, join(retainedTree, 'dep')];
      const originalTimes = directories.map(path => statSync(path));
      for (const cache of ['.cache', '.bun-cache', '.astro', '.vite', '.vite-temp', '.verdict-data']) {
        write(join(retainedTree, cache, 'stale.js'), 'stale cache');
        write(join(retainedTree, 'dep', cache, 'stale.js'), 'stale cache');
      }
      // A completed copy must reject cache-only residue even when ordinary
      // package metadata matches; directory timestamp drift must not mask it.
      directories.forEach((path, index) => utimesSync(path, originalTimes[index].atime, originalTimes[index].mtime));
      const r = runLib(['snapshot', donor, snapshot, 'copy']);
      expect(r.code, r.err).toBe(0);
      for (const cache of ['.cache', '.bun-cache', '.astro', '.vite', '.vite-temp', '.verdict-data']) {
        expect(existsSync(join(snapshot, 'node_modules', cache))).toBe(false);
        expect(existsSync(join(snapshot, 'node_modules/dep', cache))).toBe(false);
      }
      expect(readFileSync(join(snapshot, 'node_modules/dep/index.js'), 'utf8')).toBe(
        retained === 'staging' ? 'updated package' : 'package',
      );
    });

    it.each(['hardlink', 'copy'])('excludes mutable tool caches from %s snapshots', mode => {
      const t = fixture(); const donor = join(t, 'donor'); const snapshot = join(t, 'snap');
      write(join(donor, 'node_modules/dep/index.js'), 'package');
      write(join(donor, 'node_modules/vite/index.js'), 'real package');
      const caches = ['.cache', '.bun-cache', '.astro', '.vite', '.vite-temp', '.verdict-data'];
      for (const cache of caches) {
        write(join(donor, 'node_modules', cache, 'changing.js'), 'temporary');
        write(join(donor, 'node_modules/dep', cache, 'changing.js'), 'temporary');
      }
      const r = runLib(['snapshot', donor, snapshot, mode]);
      expect(r.code, r.err).toBe(0);
      expect(readFileSync(join(snapshot, 'node_modules/dep/index.js'), 'utf8')).toBe('package');
      expect(readFileSync(join(snapshot, 'node_modules/vite/index.js'), 'utf8')).toBe('real package');
      for (const cache of caches) {
        expect(existsSync(join(snapshot, 'node_modules', cache))).toBe(false);
        expect(existsSync(join(snapshot, 'node_modules/dep', cache))).toBe(false);
      }
    });

    it.each(['hardlink', 'copy'])('excludes absolute cache entry symlinks from %s snapshots', mode => {
      const t = fixture(); const donor = join(t, 'donor'); const snapshot = join(t, 'snap');
      const external = join(t, 'external-cache');
      write(join(external, 'changing.js'), 'external cache');
      write(join(donor, 'node_modules/dep/index.js'), 'package');
      const caches = ['.cache', '.bun-cache', '.astro', '.vite', '.vite-temp', '.verdict-data'];
      for (const cache of caches) {
        symlinkSync(external, join(donor, 'node_modules', cache));
        symlinkSync(join(t, 'absent-cache'), join(donor, 'node_modules/dep', cache));
      }
      const r = runLib(['snapshot', donor, snapshot, mode]);
      expect(r.code, r.err).toBe(0);
      expect(readFileSync(join(snapshot, 'node_modules/dep/index.js'), 'utf8')).toBe('package');
      for (const cache of caches) {
        expect(existsSync(join(snapshot, 'node_modules', cache))).toBe(false);
        expect(existsSync(join(snapshot, 'node_modules/dep', cache))).toBe(false);
      }
      expect(readFileSync(join(external, 'changing.js'), 'utf8')).toBe('external cache');
    });

    it.each(['hardlink', 'copy'])('excludes Bun cache index links from %s snapshots without changing installed packages', mode => {
      const t = fixture(); const donor = join(t, 'donor'); const snapshot = join(t, 'snap');
      const modules = join(donor, 'node_modules');
      const cachedPackage = join(modules, '.bun-cache/@emnapi/runtime@1.11.3@@@1');
      const cacheIndex = join(modules, '.bun-cache/@emnapi/runtime/1.11.3@@@1');
      write(join(cachedPackage, 'index.js'), 'cached package');
      mkdirSync(dirname(cacheIndex), { recursive: true });
      symlinkSync(cachedPackage, cacheIndex);
      write(join(modules, '@emnapi/runtime/index.js'), 'installed package');
      const r = runLib(['snapshot', donor, snapshot, mode]);
      expect(r.code, r.err).toBe(0);
      expect(lstatSync(join(snapshot, 'node_modules/.bun-cache'), { throwIfNoEntry: false })).toBeUndefined();
      expect(readFileSync(join(snapshot, 'node_modules/@emnapi/runtime/index.js'), 'utf8')).toBe('installed package');
      expect(readFileSync(join(cachedPackage, 'index.js'), 'utf8')).toBe('cached package');
      expect(lstatSync(cacheIndex).isSymbolicLink()).toBe(true);
    });

    it.each(['0', '1'])('keeps Bun cache churn outside dependency generation identity (portable=%s)', portable => {
      const t = fixture(); const modules = join(t, 'node_modules');
      write(join(modules, '@emnapi/runtime/index.js'), 'installed package');
      const cachedPackage = join(modules, '.bun-cache/@emnapi/runtime@1.11.3@@@1');
      const cacheIndex = join(modules, '.bun-cache/@emnapi/runtime/1.11.3@@@1');
      write(join(cachedPackage, 'index.js'), 'cached package');
      mkdirSync(dirname(cacheIndex), { recursive: true });
      symlinkSync(cachedPackage, cacheIndex);
      const result = spawnSync('bash', ['-c', `
set -e
source "$1/apps/operator/bin/release/dependency-generation.sh"
before=$(dependency_generation_tree_fingerprint "$2")
dependency_generation_source_records "$2" "$3/before"
printf 'cache churn' > "$2/.bun-cache/@emnapi/runtime@1.11.3@@@1/index.js"
after=$(dependency_generation_tree_fingerprint "$2")
test "$before" = "$after"
dependency_generation_source_records "$2" "$3/after"
cmp "$3/before" "$3/after"
dependency_generation_prune_ephemeral "$2"
test ! -e "$2/.bun-cache"
test -f "$2/@emnapi/runtime/index.js"
printf 'real package change' > "$2/@emnapi/runtime/index.js"
changed=$(dependency_generation_tree_fingerprint "$2")
test "$after" != "$changed"
`, 'bun-cache-policy', ROOT, modules, t], {
        encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
        env: { ...process.env, DEPENDENCY_GENERATION_FORCE_PORTABLE_STAT: portable },
      });
      expect(result.status, result.stderr).toBe(0);
    });

    it('does not validate disposable cache links as package dependencies', () => {
      const t = fixture(); const donor = join(t, 'donor'); const snapshot = join(t, 'snap');
      write(join(donor, 'node_modules/dep/index.js'), 'package');
      mkdirSync(join(donor, 'node_modules/.vite-temp'));
      symlinkSync('already-removed.mjs', join(donor, 'node_modules/.vite-temp/module.mjs'));
      const r = runLib(['snapshot', donor, snapshot]);
      expect(r.code, r.err).toBe(0);
      expect(existsSync(join(snapshot, 'node_modules/.vite-temp'))).toBe(false);
    });

    it.each(['hardlink', 'copy'])('reports completed small trees for %s publication and verified reuse', mode => {
      const t = fixture(); const donor = join(t, 'donor'); const snapshot = join(t, 'snap');
      const trees = ['node_modules', 'apps/web/node_modules'];
      for (const tree of trees) write(join(donor, tree, 'dep/index.js'), tree);
      const check = (result: ReturnType<typeof runLib>) => {
        expect(result.code, result.err).toBe(0);
        const rows = result.out.split('\n').filter(line => line.startsWith('snapshot progress:'));
        expect(rows.map(line => Number(/completed=(\d+)/.exec(line)?.[1]))).toEqual([1, 2]);
        expect(rows.map(line => line.split(' tree=')[1]).sort()).toEqual([...trees].sort());
        for (const tree of trees)
          expect(readFileSync(join(snapshot, tree, 'dep/index.js'), 'utf8')).toBe(tree);
      };
      check(runLib(['snapshot', donor, snapshot, mode]));
      if (mode === 'copy') {
        const reused = runLib(['snapshot', donor, snapshot, mode]);
        check(reused);
        for (const tree of trees) expect(reused.out).toContain('reused verified completed snapshot ' + tree);
      }
    });

    it('preserves the failed copy diagnostic and refuses both fresh and stale success receipts', () => {
      const t = fixture();
      const donor = join(t, 'donor');
      const snapshot = join(t, 'snapshot');
      write(join(donor, 'node_modules', 'dep', 'index.js'), 'donor');
      write(join(snapshot, '.papercusp-pinned-deps'), 'stale success');
      const shim = join(t, 'bin', 'rsync');
      write(shim, '#!/usr/bin/env bash\necho "rsync: fixture hardlink path: Permission denied" >&2\nexit 17\n');
      chmodSync(shim, 0o755);
      const result = runLib(['snapshot', donor, snapshot], { PATH: `${dirname(shim)}:${process.env.PATH}` });
      expect(result.code).toBe(1);
      expect(result.err).toContain('rsync: fixture hardlink path: Permission denied');
      expect(result.err).toContain('FAILED to snapshot node_modules (exit=17)');
      expect(result.out).not.toContain('snapshot progress:');
      expect(existsSync(join(snapshot, '.papercusp-pinned-deps'))).toBe(false);
      expect(existsSync(join(snapshot, 'node_modules'))).toBe(false);
    });

    it('survives an npm-style REPLACE of a donor package (the r14 killer)', () => {
      const t = fixture();
      write(join(t, 'donor', 'node_modules', 'left', 'index.js'), 'v1');
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]).code).toBe(0);

      // Exactly what npm does: unlink the directory entry, extract a new tree in its place.
      rmSync(join(t, 'donor', 'node_modules', 'left'), { recursive: true, force: true });
      write(join(t, 'donor', 'node_modules', 'left', 'index.js'), 'v2');

      expect(readFileSync(join(t, 'snap', 'node_modules', 'left', 'index.js'), 'utf8')).toBe('v1');
    });

    it('survives the donor DELETING a package outright', () => {
      const t = fixture();
      write(join(t, 'donor', 'apps', 'web', 'node_modules', 'dep', 'i.js'), 'kept');
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]).code).toBe(0);
      rmSync(join(t, 'donor', 'apps', 'web', 'node_modules', 'dep'), {
        recursive: true,
        force: true,
      });
      expect(
        readFileSync(join(t, 'snap', 'apps', 'web', 'node_modules', 'dep', 'i.js'), 'utf8'),
      ).toBe('kept');
    });

    it('is a HARDLINK farm, not a copy — the whole cost argument rests on this', () => {
      const t = fixture();
      write(join(t, 'donor', 'node_modules', 'p', 'i.js'), 'shared');
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]).code).toBe(0);
      const a = statSync(join(t, 'donor', 'node_modules', 'p', 'i.js'));
      const b = statSync(join(t, 'snap', 'node_modules', 'p', 'i.js'));
      expect(b.ino).toBe(a.ino);
      expect(b.nlink).toBeGreaterThanOrEqual(2);
    });

    it('preserves relative symlink TEXT, so workspace packages resolve at the MOUNTPOINT', () => {
      const t = fixture();
      mkdirSync(join(t, 'donor', 'node_modules', '@papercusp'), { recursive: true });
      write(join(t, 'donor', 'libs/generic/x/index.js'), 'workspace');
      symlinkSync('../../libs/generic/x', join(t, 'donor', 'node_modules', '@papercusp', 'x'));
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]).code).toBe(0);
      const r = spawnSync('readlink', [join(t, 'snap', 'node_modules', '@papercusp', 'x')], {
        encoding: 'utf8',
        // WI-41180: bounded like the helper call above — a sync spawn blocks the pure
        // lane's shared worker, which vitest cannot time out.
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      expect(String(r.stdout).trim()).toBe('../../libs/generic/x');
    });

    it('copy mode survives in-place writes on both sides with independent inodes', () => {
      const t = fixture();
      const donor = join(t, 'donor', 'node_modules', 'p', 'i.js');
      const copied = join(t, 'snap', 'node_modules', 'p', 'i.js');
      write(donor, 'original');
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap'), 'copy']).code).toBe(0);
      expect(statSync(copied).ino).not.toBe(statSync(donor).ino);
      writeFileSync(donor, 'donor changed in place');
      expect(readFileSync(copied, 'utf8')).toBe('original');
      writeFileSync(copied, 'snapshot changed in place');
      expect(readFileSync(donor, 'utf8')).toBe('donor changed in place');
      expect(readFileSync(join(t, 'snap', '.papercusp-pinned-deps'), 'utf8')).toContain('mode=copy');
    });

    it('refuses an unaffordable independent copy before touching retained progress, then releases its lease', () => {
      const t = fixture();
      const donor = join(t, 'donor');
      const snap = join(t, 'snap');
      const retained = join(snap, 'node_modules.pinned-deps-tmp/p/kept.js');
      const lock = join(t, 'copy.lock');
      write(join(donor, 'node_modules/p/index.js'), 'new source bytes');
      write(retained, 'forensic progress');
      write(join(snap, '.papercusp-pinned-deps'), 'stale receipt');
      const env = { DEPENDENCY_GENERATION_COPY_LOCK_FILE: lock,
        DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '0', DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC: '0',
        DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '0', DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: '0',
        DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES: '1048576', DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: '1' };
      const refused = runLib(['snapshot', donor, snap, 'copy'], env);
      expect(refused.code).toBe(77);
      expect(refused.err).toContain('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT');
      expect(refused.err).toContain('size=measured');
      expect(readFileSync(retained, 'utf8')).toBe('forensic progress');
      expect(existsSync(join(snap, 'node_modules'))).toBe(false);
      expect(existsSync(join(snap, '.papercusp-pinned-deps'))).toBe(false);
      const admitted = runLib(['snapshot', donor, snap, 'copy'], {
        ...env, DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: '1048576',
      });
      expect(admitted.code, admitted.err).toBe(0);
      expect(readFileSync(join(snap, 'node_modules/p/index.js'), 'utf8')).toBe('new source bytes');
      expect(existsSync(join(snap, '.papercusp-pinned-deps'))).toBe(true);
    });

    it.runIf(process.platform === 'linux')('independent snapshots honor the shared physical-copy lease', () => {
      const t = fixture();
      const donor = join(t, 'donor');
      const snap = join(t, 'snap');
      const lock = join(t, 'copy.lock');
      write(join(donor, 'node_modules/p/index.js'), 'source');
      const r = spawnSync('flock', [lock, 'bash', HELPER_PATH, 'snapshot', donor, snap, 'copy'], {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, DEPENDENCY_GENERATION_COPY_LOCK_FILE: lock,
          DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '0', DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC: '0' },
      });
      expect(r.status, r.stderr).toBe(76);
      expect(r.stderr).toContain('DEPENDENCY_GENERATION_LOCK_TIMEOUT');
      expect(existsSync(snap)).toBe(false);
      expect(runLib(['snapshot', donor, snap, 'copy'], {
        DEPENDENCY_GENERATION_COPY_LOCK_FILE: lock,
        DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '0', DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC: '0',
      }).code).toBe(0);
    });

    it('refuses unmeasured destination capacity while preserving forensic staging', () => {
      const t = fixture();
      const donor = join(t, 'donor');
      const snap = join(t, 'snap');
      const retained = join(snap, 'node_modules.pinned-deps-tmp/p/kept.js');
      write(join(donor, 'node_modules/p/index.js'), 'source');
      write(retained, 'forensic progress');
      const shim = join(t, 'bin/stat');
      write(shim, '#!/usr/bin/env bash\nexit 1\n');
      chmodSync(shim, 0o755);
      const refused = runLib(['snapshot', donor, snap, 'copy'], {
        PATH: `${dirname(shim)}:${process.env.PATH}`,
        DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: '', DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES: '',
      });
      expect(refused.code).toBe(77);
      expect(refused.err).toContain('DEPENDENCY_GENERATION_HEADROOM_UNMEASURED');
      expect(readFileSync(retained, 'utf8')).toBe('forensic progress');
      expect(existsSync(join(snap, '.papercusp-pinned-deps'))).toBe(false);
    });

    it('retains an interrupted copy, invalidates the old stamp and reuses verified completed files', () => {
      const t = fixture();
      const donor = join(t, 'donor');
      const snap = join(t, 'snap');
      write(join(donor, 'node_modules/p/kept.js'), 'completed file');
      write(join(donor, 'node_modules/p/large.js'), 'complete new file');
      expect(runLib(['snapshot', donor, snap, 'copy']).code).toBe(0);
      writeFileSync(join(donor, 'node_modules/p/large.js'), 'changed new file');
      const shim = join(t, 'shim');
      // Fault injection at the storage boundary: one completed independent file
      // and one incomplete file, followed by rsync's partial-transfer failure.
      write(join(shim, 'rsync'), [
        '#!/usr/bin/env bash',
        'case " $* " in *" --dry-run "*) printf changed; exit 0 ;; esac',
        'mkdir -p "$SNAP/node_modules.pinned-deps-tmp/p"',
        'cp -a "$DONOR/node_modules/p/kept.js" "$SNAP/node_modules.pinned-deps-tmp/p/kept.js"',
        'printf partial > "$SNAP/node_modules.pinned-deps-tmp/p/large.js"',
        'exit 23',
      ].join('\n'));
      chmodSync(join(shim, 'rsync'), 0o755);
      const failed = runLib(['snapshot', donor, snap, 'copy'], {
        PATH: `${shim}:${process.env.PATH}`, DONOR: donor, SNAP: snap,
      });
      expect(failed.code).not.toBe(0);
      expect(failed.err).toContain('retained resumable staging tree');
      expect(existsSync(join(snap, '.papercusp-pinned-deps'))).toBe(false);
      expect(readFileSync(join(snap, 'node_modules/p/large.js'), 'utf8')).toBe('complete new file');
      const completedInode = statSync(join(snap, 'node_modules.pinned-deps-tmp/p/kept.js')).ino;
      expect(runLib(['snapshot', donor, snap, 'copy']).code).toBe(0);
      expect(statSync(join(snap, 'node_modules/p/kept.js')).ino).toBe(completedInode);
      expect(readFileSync(join(snap, 'node_modules/p/large.js'), 'utf8')).toBe('changed new file');
      expect(existsSync(join(snap, 'node_modules.pinned-deps-tmp'))).toBe(false);
      expect(readFileSync(join(snap, '.papercusp-pinned-deps'), 'utf8')).toContain('trees=1');
      const completedSnapshotInode = statSync(join(snap, 'node_modules/p/kept.js')).ino;
      const repeated = runLib(['snapshot', donor, snap, 'copy']);
      expect(repeated.code).toBe(0);
      expect(repeated.out).toContain('reused verified completed snapshot node_modules');
      expect(statSync(join(snap, 'node_modules/p/kept.js')).ino).toBe(completedSnapshotInode);
    });

    it('checksum-verifies legacy partials despite equal size/mtime and removes stale paths and links', () => {
      const t = fixture();
      const donor = join(t, 'donor');
      const snap = join(t, 'snap');
      const sourceFile = join(donor, 'node_modules/p/index.js');
      const legacy = join(snap, 'node_modules.pinned-deps-tmp.12345');
      write(sourceFile, 'NEW BYTES');
      write(join(legacy, 'p/index.js'), 'OLD BYTES');
      const sourceStat = statSync(sourceFile);
      utimesSync(join(legacy, 'p/index.js'), sourceStat.atime, sourceStat.mtime);
      write(join(legacy, 'p/removed.js'), 'stale');
      symlinkSync('wrong.js', join(legacy, 'p/link.js'));
      symlinkSync('index.js', join(donor, 'node_modules/p/link.js'));
      expect(runLib(['snapshot', donor, snap, 'copy']).code).toBe(0);
      expect(readFileSync(join(snap, 'node_modules/p/index.js'), 'utf8')).toBe('NEW BYTES');
      expect(readFileSync(join(snap, 'node_modules/p/link.js'), 'utf8')).toBe('NEW BYTES');
      expect(existsSync(join(snap, 'node_modules/p/removed.js'))).toBe(false);
      expect(existsSync(legacy)).toBe(false);
    });

    it('breaks retained donor hardlinks before applying metadata and preserves independent hardlink groups', () => {
      const t = fixture();
      const donor = join(t, 'donor');
      const snap = join(t, 'snap');
      const sourceFile = join(donor, 'node_modules/p/index.js');
      write(sourceFile, 'independent');
      linkSync(sourceFile, join(donor, 'node_modules/p/twin.js'));
      const retained = join(snap, 'node_modules.pinned-deps-tmp/p/index.js');
      mkdirSync(dirname(retained), { recursive: true });
      linkSync(sourceFile, retained);
      expect(runLib(['snapshot', donor, snap, 'copy']).code).toBe(0);
      const copied = join(snap, 'node_modules/p/index.js');
      expect(statSync(copied).ino).not.toBe(statSync(sourceFile).ino);
      expect(statSync(copied).ino).toBe(statSync(join(snap, 'node_modules/p/twin.js')).ino);
      writeFileSync(copied, 'changed');
      expect(readFileSync(sourceFile, 'utf8')).toBe('independent');
    });

    it('refuses ambiguous or symlinked staging without deleting retained progress or stamping success', () => {
      for (const unsafe of ['ambiguous', 'symlink']) {
        const t = fixture();
        write(join(t, 'donor/node_modules/p/index.js'), 'source');
        const snap = join(t, 'snap');
        mkdirSync(snap);
        if (unsafe === 'ambiguous') {
          write(join(snap, 'node_modules.pinned-deps-tmp.1/p/index.js'), 'first');
          write(join(snap, 'node_modules.pinned-deps-tmp.2/p/index.js'), 'second');
        } else {
          symlinkSync(join(t, 'donor/node_modules'), join(snap, 'node_modules.pinned-deps-tmp'));
        }
        const result = runLib(['snapshot', join(t, 'donor'), snap, 'copy']);
        expect(result.code).not.toBe(0);
        expect(result.err).toMatch(/REFUSING (ambiguous|unsafe)/);
        expect(existsSync(join(snap, '.papercusp-pinned-deps'))).toBe(false);
        if (unsafe === 'ambiguous') {
          expect(readFileSync(join(snap, 'node_modules.pinned-deps-tmp.1/p/index.js'), 'utf8')).toBe('first');
          expect(readFileSync(join(snap, 'node_modules.pinned-deps-tmp.2/p/index.js'), 'utf8')).toBe('second');
        }
      }
    });

    it('refuses an unknown snapshot mode before producing a dependency stamp', () => {
      const t = fixture();
      write(join(t, 'donor', 'node_modules', 'p', 'i.js'), 'original');
      const r = runLib(['snapshot', join(t, 'donor'), join(t, 'snap'), 'unknown']);
      expect(r.code).toBe(2);
      expect(r.err).toContain('snapshot mode must be hardlink or copy');
      expect(existsSync(join(t, 'snap', '.papercusp-pinned-deps'))).toBe(false);
    });

    it('mirrors the donor layout rather than flattening it, so a lowerdir is prefix-checkable', () => {
      const t = fixture();
      write(join(t, 'donor', 'apps', 'operator', 'node_modules', 'p', 'i.js'), 'x');
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]).code).toBe(0);
      expect(existsSync(join(t, 'snap', 'apps', 'operator', 'node_modules', 'p', 'i.js'))).toBe(
        true,
      );
    });

    it('stamps the snapshot with its donor, tree count and time', () => {
      const t = fixture();
      write(join(t, 'donor', 'node_modules', 'p', 'i.js'), 'x');
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]).code).toBe(0);
      const stamp = readFileSync(join(t, 'snap', '.papercusp-pinned-deps'), 'utf8');
      expect(stamp).toContain(`donor=${join(t, 'donor')}`);
      expect(stamp).toMatch(/^trees=1$/m);
      expect(stamp).toMatch(/^takenAtUtc=\d{4}-\d{2}-\d{2}T/m);
    });

    it('keeps snapshot metadata clean without hiding untracked source from the real provenance producer', () => {
      const t = fixture();
      const snapshot = join(t, 'snap');
      write(join(t, 'donor', 'node_modules', 'p', 'i.js'), 'dependency');
      expect(runLib(['snapshot', join(t, 'donor'), snapshot, 'copy']).code).toBe(0);
      const initialized = spawnSync('git', ['init', '-q', snapshot], {
        encoding: 'utf8', timeout: 10_000,
      });
      expect(initialized.status).toBe(0);
      // Use the product's actual ignore policy without committing fixture source.
      write(join(snapshot, '.git', 'info', 'exclude'), readFileSync(join(ROOT, '.gitignore'), 'utf8'));
      const capture = () => {
        const result = spawnSync('bash', [
          join(ROOT, 'papercusp-desktop', 'bin', 'emit-build-provenance.sh'),
          '--capture-source', snapshot,
        ], { encoding: 'utf8', timeout: 10_000 });
        expect(result.status, String(result.stderr)).toBe(0);
        return String(result.stdout).trim().split('\n').at(-1);
      };
      expect(existsSync(join(snapshot, '.papercusp-pinned-deps'))).toBe(true);
      expect(capture()).toBe('false');
      write(join(snapshot, 'node_modules.pinned-deps-tmp.123/p/partial.js'), 'partial output');
      expect(capture()).toBe('false');
      write(join(snapshot, 'untracked-source.ts'), 'export const pending = true;');
      expect(capture()).toBe('true');
    });

    it('REFUSES to snapshot THROUGH a symlinked tree — cp -al would reproduce the link', () => {
      const t = fixture();
      mkdirSync(join(t, 'donor', 'apps', 'web'), { recursive: true });
      mkdirSync(join(t, 'elsewhere', 'node_modules'), { recursive: true });
      symlinkSync(join(t, 'elsewhere', 'node_modules'), join(t, 'donor', 'apps', 'web', 'node_modules'));
      const r = runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/symlinked dependency tree/);
      expect(existsSync(join(t, 'snap', '.papercusp-pinned-deps'))).toBe(false);
    });

    it('refuses a donor that is not a directory rather than stamping an empty snapshot', () => {
      const t = fixture();
      const r = runLib(['snapshot', join(t, 'nope'), join(t, 'snap')]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/donor is not a directory/);
      expect(existsSync(join(t, 'snap', '.papercusp-pinned-deps'))).toBe(false);
    });
  });

  describe('papercusp_pinned_deps_snapshot_locked — prevention, not detection', () => {
    it.runIf(process.platform === 'linux')('queues for physical copy capacity before entering the donor install reader', () => {
      const t = fixture(); const donor = join(t, 'donor'); const snap = join(t, 'snap');
      const lock = join(t, 'copy.lock'); const entered = join(t, 'reader-entered');
      write(join(donor, 'node_modules/p/index.js'), 'original');
      write(join(donor, 'scripts/npm-install-safe.mjs'), `import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
writeFileSync(${JSON.stringify(entered)}, 'entered');
// A reader can queue behind an install writer. Holding copy capacity here
// would cycle with a generation publisher already holding an install reader.
if (spawnSync('flock', ['-n', process.env.DEPENDENCY_GENERATION_COPY_LOCK_FILE, 'true']).status !== 0) process.exit(91);
const args = process.argv.slice(process.argv.indexOf('--') + 1);
process.exit(spawnSync(args[0], args.slice(1), { stdio: 'inherit' }).status ?? 1);`);
      const env = { ...process.env, DEPENDENCY_GENERATION_COPY_LOCK_FILE: lock,
        DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '0', DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC: '0' };
      const queued = spawnSync('flock', [lock, 'bash', HELPER_PATH, 'snapshot-locked', donor, snap, 'copy'], {
        encoding: 'utf8', timeout: 10_000, env,
      });
      expect(queued.status, queued.stderr).toBe(76);
      expect(existsSync(entered), 'a queued physical copy must not retain an install reader').toBe(false);
      expect(existsSync(snap)).toBe(false);
      const copied = runLib(['snapshot-locked', donor, snap, 'copy'], env);
      expect(copied.code, copied.err).toBe(0);
      expect(readFileSync(join(snap, 'node_modules/p/index.js'), 'utf8')).toBe('original');
      expect(existsSync(entered)).toBe(true);
      expect(spawnSync('flock', ['-n', lock, 'true']).status, 'copy slot must release on completion').toBe(0);
    });

    it.runIf(process.platform === 'linux')('rejects an invalid copy admission mode without publishing a snapshot', () => {
      const t = fixture(); const donor = join(t, 'donor'); const snap = join(t, 'snap');
      write(join(donor, 'node_modules/p/index.js'), 'original');
      const result = runLib(['snapshot', donor, snap, 'copy', '', 'invalid-holder'], {
        DEPENDENCY_GENERATION_COPY_LOCK_FILE: join(t, 'copy.lock'),
      });
      expect(result.code, result.err).toBe(76);
      expect(result.err).toContain('invalid copy admission mode');
      expect(existsSync(join(snap, '.papercusp-pinned-deps'))).toBe(false);
    });

    it.runIf(process.platform === 'linux')('drops the reader and bounds retries when a copy wins the admission race', () => {
      const t = fixture(); const donor = join(t, 'donor'); const snap = join(t, 'snap');
      const lock = join(t, 'copy.lock'); const entries = join(t, 'reader-entries');
      write(join(donor, 'node_modules/p/index.js'), 'original');
      write(join(donor, 'scripts/npm-install-safe.mjs'), `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
appendFileSync(${JSON.stringify(entries)}, 'entered\\n');
const args = process.argv.slice(process.argv.indexOf('--') + 1);
// Another physical copy takes the slot after the outer capacity probe.
process.exit(spawnSync('flock', [process.env.DEPENDENCY_GENERATION_COPY_LOCK_FILE, ...args], { stdio: 'inherit' }).status ?? 1);`);
      const result = runLib(['snapshot-locked', donor, snap, 'copy'], {
        DEPENDENCY_GENERATION_COPY_LOCK_FILE: lock,
        DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '0', DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC: '0',
      });
      expect(result.code, result.err).toBe(76);
      expect(readFileSync(entries, 'utf8').trim().split('\n')).toHaveLength(3);
      expect(result.err).toContain('donor reader released (attempt 3 of 3)');
      expect(existsSync(join(snap, '.papercusp-pinned-deps'))).toBe(false);
      expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(0);
    });

    it('REFUSES when the donor install mutex is unreachable; never snapshots unlocked', () => {
      const t = fixture();
      mkdirSync(join(t, 'donor', 'node_modules'), { recursive: true });
      const r = runLib(['snapshot-locked', join(t, 'donor'), join(t, 'snap')]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/install mutex/);
      // The point of the refusal: no artifact is produced that a later reader could mistake
      // for a locked snapshot. A torn snapshot is indistinguishable from a good one.
      expect(existsSync(join(t, 'snap', '.papercusp-pinned-deps'))).toBe(false);
    });

    it('takes the lock through npm-install-safe --exec-under-lock, not a second implementation', () => {
      const helper = codeOnly(readFileSync(HELPER_PATH, 'utf8'));
      expect(helper).toMatch(/npm-install-safe\.mjs/);
      expect(helper).toMatch(/--exec-under-lock/);
      // fs-mutex is the primitive npm-install-safe already owns. Reaching past it into the
      // mkdir-lock algorithm would be a second implementation of one contract.
      expect(helper).not.toMatch(/withFsMutex|fs-mutex/);
    });

    it('does NOT fall back to an unlocked snapshot on any path', () => {
      const helper = codeOnly(readFileSync(HELPER_PATH, 'utf8'));
      const locked = helper.slice(helper.indexOf('papercusp_pinned_deps_snapshot_locked()'));
      const body = locked.slice(0, locked.indexOf('\n}'));
      expect(body).not.toMatch(/\|\|\s*papercusp_pinned_deps_snapshot\b/);
    });
  });

  describe('papercusp_assert_pinned_deps_decoupled — the gate', () => {
    it('PASSES a tree that owns its dependencies (satisfiable by construction)', () => {
      const t = fixture();
      write(join(t, 'node_modules', 'p', 'i.js'), 'x');
      const r = runLib(['assert', t, '', join(t, 'empty-mountinfo')]);
      expect(r.code).toBe(0);
    });

    it('PASSES a tree with no dependencies at all', () => {
      expect(runLib(['assert', fixture()]).code).toBe(0);
    });

    it('REFUSES an overlay whose lower layer is a foreign tree — the r14 shape', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned', 'node_modules'), { recursive: true });
      const mi = join(t, 'mountinfo');
      writeFileSync(
        mi,
        overlayLine(join(t, 'pinned', 'node_modules'), '/somewhere/else/node_modules') + '\n',
      );
      const r = runLib(['assert', join(t, 'pinned'), '', mi]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('/somewhere/else/node_modules');
      expect(r.err).toMatch(/OUTSIDE the pinned tree/);
    });

    it('ACCEPTS an overlay whose lower layer is the DECLARED snapshot root', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned', 'node_modules'), { recursive: true });
      mkdirSync(join(t, 'snap', 'node_modules'), { recursive: true });
      const mi = join(t, 'mountinfo');
      writeFileSync(
        mi,
        overlayLine(join(t, 'pinned', 'node_modules'), join(t, 'snap', 'node_modules')) + '\n',
      );
      expect(runLib(['assert', join(t, 'pinned'), join(t, 'snap'), mi]).code).toBe(0);
    });

    it('checks EVERY lowerdir in a stacked overlay, not just the first', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned', 'node_modules'), { recursive: true });
      mkdirSync(join(t, 'snap', 'node_modules'), { recursive: true });
      const mi = join(t, 'mountinfo');
      writeFileSync(
        mi,
        overlayLine(
          join(t, 'pinned', 'node_modules'),
          `${join(t, 'snap', 'node_modules')}:/live/node_modules`,
        ) + '\n',
      );
      const r = runLib(['assert', join(t, 'pinned'), join(t, 'snap'), mi]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('/live/node_modules');
    });

    it('REFUSES a bind mount from a foreign tree, caught by the same pass', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned', 'node_modules'), { recursive: true });
      const mi = join(t, 'mountinfo');
      writeFileSync(mi, bindLine(join(t, 'pinned', 'node_modules'), '/live/node_modules') + '\n');
      const r = runLib(['assert', join(t, 'pinned'), '', mi]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('/live/node_modules');
    });

    it('IGNORES mounts outside the tree and mounts that are not dependency trees', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned'), { recursive: true });
      const mi = join(t, 'mountinfo');
      writeFileSync(
        mi,
        [
          overlayLine('/elsewhere/node_modules', '/live/node_modules'),
          overlayLine(join(t, 'pinned', 'target'), '/live/target'),
        ].join('\n') + '\n',
      );
      expect(runLib(['assert', join(t, 'pinned'), '', mi]).code).toBe(0);
    });

    it('REFUSES a node_modules that is a SYMLINK out of the tree', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned'), { recursive: true });
      mkdirSync(join(t, 'live', 'node_modules'), { recursive: true });
      symlinkSync(join(t, 'live', 'node_modules'), join(t, 'pinned', 'node_modules'));
      const r = runLib(['assert', join(t, 'pinned'), '', join(t, 'no-mountinfo')]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/SYMLINK to dependencies outside the pinned tree/);
    });

    it('ACCEPTS a symlink into the declared snapshot root', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned'), { recursive: true });
      mkdirSync(join(t, 'snap', 'node_modules'), { recursive: true });
      symlinkSync(join(t, 'snap', 'node_modules'), join(t, 'pinned', 'node_modules'));
      expect(runLib(['assert', join(t, 'pinned'), join(t, 'snap'), join(t, 'none')]).code).toBe(0);
    });

    it('says what to do about it — a refusal with no repair gets bypassed, not obeyed', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned', 'node_modules'), { recursive: true });
      const mi = join(t, 'mountinfo');
      writeFileSync(mi, overlayLine(join(t, 'pinned', 'node_modules'), '/live/node_modules') + '\n');
      const { err } = runLib(['assert', join(t, 'pinned'), '', mi]);
      expect(err).toMatch(/papercusp_pinned_deps_snapshot_locked/);
    });

    it('reports the mount axis as skipped rather than silently passing it', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned', 'node_modules'), { recursive: true });
      const { err, code } = runLib(['assert', join(t, 'pinned'), '', join(t, 'absent')]);
      expect(code).toBe(0);
      expect(err).toMatch(/skipping the mount check/);
    });
  });

  describe('WIRING — the producer actually runs it', () => {
    let producer = '';
    beforeAll(() => {
      producer = codeOnly(readFileSync(PRODUCER_PATH, 'utf8'));
    });

    it('sources lib/pinned-deps.sh', () => {
      expect(producer).toMatch(/source\s+"\$HERE\/lib\/pinned-deps\.sh"/);
    });

    it('calls the assertion under vm-release', () => {
      expect(producer).toMatch(/papercusp_assert_pinned_deps_decoupled\s+"\$REPO_ROOT"/);
    });

    it('a refusal EXITS, rather than being logged and ignored', () => {
      const call = producer.slice(producer.indexOf('papercusp_assert_pinned_deps_decoupled'));
      expect(call.slice(0, 400)).toMatch(/exit 2/);
    });

    it('passes exactly the repo root and the declared snapshot root — never a mountinfo override', () => {
      const m = producer.match(/papercusp_assert_pinned_deps_decoupled[^\n]*/);
      expect(m).toBeTruthy();
      const call = String(m?.[0]);
      expect(call).toMatch(/PAPERCUSP_PINNED_DEPS_SNAPSHOT_ROOT/);
      // A third argument here would let a caller aim the gate at a table of its choosing.
      expect(call).not.toMatch(/mountinfo/i);
    });

    it('runs AFTER the source-clean gate — both are entry gates, before any toolchain work', () => {
      const clean = producer.indexOf('papercusp_assert_release_source_clean');
      const deps = producer.indexOf('papercusp_assert_pinned_deps_decoupled');
      const node = producer.indexOf('PAPERCUSP_REQUIRED_NODE_MAJOR');
      expect(clean).toBeGreaterThan(-1);
      expect(deps).toBeGreaterThan(clean);
      expect(node).toBeGreaterThan(deps);
    });
  });

  describe('REUSE INVARIANTS — the mistakes this design is one edit away from', () => {
    it('does not re-implement the dependency-generation fingerprint', () => {
      const helper = codeOnly(readFileSync(HELPER_PATH, 'utf8'));
      expect(helper).not.toMatch(/dependency_generation_tree_fingerprint|sha256sum/);
    });

    it('builds beside the destination and swaps, never mutating a live lower layer in place', () => {
      const helper = codeOnly(readFileSync(HELPER_PATH, 'utf8'));
      expect(helper).toMatch(/pinned-deps-tmp/);
      // `rm -rf "$dest"` followed by a slow repopulate is the outage shape
      // sync_one_node_modules was rewritten to remove; it must not reappear here.
      expect(helper).not.toMatch(/rm -rf "\$_dst"/);
    });
  });
});
