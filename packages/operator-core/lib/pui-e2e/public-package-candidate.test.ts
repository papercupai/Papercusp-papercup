import { afterEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { assertPackageBuildDependencies, loadPinnedPackageCandidate, readPackageBuildLock } from './public-package-candidate';

const SOURCE = 'a'.repeat(40);
const TARGET = 'linux-x86_64';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(overrides: object = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pui-candidate-pin-test-'));
  roots.push(root);
  const name = `pui-0.1.0-${TARGET}`;
  const unit = path.join(root, name);
  mkdirSync(unit);
  writeFileSync(path.join(unit, 'PROVENANCE.json'), JSON.stringify({
    version: '0.1.0', target: TARGET, source: { commit: SOURCE }, runtime: { glibcFloor: '2.31' }, ...overrides,
  }));
  const archive = path.join(root, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', root, name]);
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  return { root, archive, digest, snapshot: path.join(root, 'snapshot'), env: {
    PUI_PUBLIC_PACKAGE_ARCHIVE: archive, PUI_PUBLIC_PACKAGE_SOURCE_SHA: SOURCE, PUI_PUBLIC_PACKAGE_ARCHIVE_SHA256: digest,
  } };
}

describe('public package candidate identity preflight', () => {
  test('reads the actual committed monorepo lockfile beyond the subprocess output buffer', () => {
    const root = path.resolve(__dirname, '../../../..');
    // This repository's committed lock is over 1 MiB; the old buffered git read
    // failed ENOBUFS before the dependency check could run.
    const packages = readPackageBuildLock(root, 'HEAD');
    expect(packages['node_modules/@lydell/node-pty']?.version).toBeTruthy();
    expect(Object.keys(packages).length).toBeGreaterThan(0);
  });

  function dependencyFixture() {
    const f = fixture();
    const packages = Object.fromEntries(['esbuild', '@lydell/node-pty'].map((name) => {
      const key = `node_modules/${name}`;
      mkdirSync(path.join(f.root, key), { recursive: true });
      writeFileSync(path.join(f.root, key, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
      return [key, { version: '1.0.0' }];
    }));
    return { ...f, packages };
  }

  test('admits the bundler inputs at their committed lock paths', () => {
    const f = dependencyFixture();
    expect(() => assertPackageBuildDependencies(f.root, f.packages)).not.toThrow();
  });

  test('refuses an exposed dependency absent from the lock before native compilation', () => {
    const f = dependencyFixture();
    delete f.packages['node_modules/esbuild'];
    expect(() => assertPackageBuildDependencies(f.root, f.packages)).toThrow('not reachable through a locked install path');
  });

  test('refuses the wrong installed dependency version before native compilation', () => {
    const f = dependencyFixture();
    f.packages['node_modules/esbuild'] = { version: '2.0.0' };
    expect(() => assertPackageBuildDependencies(f.root, f.packages)).toThrow('disagrees with committed');
  });

  test('unset inputs preserve the existing HEAD and mutation build route', () => {
    expect(loadPinnedPackageCandidate({ PUI_PUBLIC_PACKAGE_SUBJECT: '/mutant' }, '/unused', TARGET)).toBeUndefined();
  });

  test.each(['PUI_PUBLIC_PACKAGE_ARCHIVE', 'PUI_PUBLIC_PACKAGE_SOURCE_SHA', 'PUI_PUBLIC_PACKAGE_ARCHIVE_SHA256'])(
    'refuses an incomplete pin containing only %s before reading an archive', (key) => {
      expect(() => loadPinnedPackageCandidate({ [key]: 'unreadable' }, '/unused', TARGET)).toThrow('requires all');
    });

  test('uses the pinned source independently of harness HEAD and freezes the accepted bytes', () => {
    const f = fixture();
    const result = loadPinnedPackageCandidate(f.env, f.snapshot, TARGET)!;
    expect(result).toMatchObject({ sourceSha: SOURCE, sha256: f.digest, target: TARGET, version: '0.1.0', glibcFloor: '2.31' });
    const accepted = readFileSync(f.archive);
    writeFileSync(f.archive, 'a later generation');
    expect(readFileSync(result.archive)).toEqual(accepted);
    expect(readFileSync(path.join(f.snapshot, 'SHA256SUMS'), 'utf8')).toBe(`${f.digest}  ${path.basename(result.archive)}\n`);
  });

  test('refuses a changed archive before tar or any package build can run', () => {
    const f = fixture();
    writeFileSync(f.archive, 'not even a tarball');
    expect(() => loadPinnedPackageCandidate(f.env, f.snapshot, TARGET)).toThrow('archive digest mismatch');
    expect(existsSync(f.snapshot)).toBe(false);
  });

  test.each([
    ['source', { source: { commit: 'b'.repeat(40) } }, 'source SHA mismatch'],
    ['target', { target: 'macos-aarch64' }, 'target mismatch'],
    ['version', { version: '../escape' }, 'valid version'],
  ])('refuses %s provenance from another candidate', (_label, overrides, message) => {
    const f = fixture(overrides);
    expect(() => loadPinnedPackageCandidate(f.env, f.snapshot, TARGET)).toThrow(message);
  });

  test('refuses mutation inputs instead of silently ignoring a requested mutation', () => {
    const f = fixture();
    expect(() => loadPinnedPackageCandidate({ ...f.env, PUI_PUBLIC_PACKAGE_SUBJECT: '/mutant' }, f.snapshot, TARGET))
      .toThrow('cannot be combined');
    expect(existsSync(f.snapshot)).toBe(false);
  });

  test.each([
    ['PUI_PUBLIC_PACKAGE_SOURCE_SHA', 'HEAD', 'full committed SHA'],
    ['PUI_PUBLIC_PACKAGE_ARCHIVE_SHA256', 'short-digest', 'full SHA-256'],
  ])('refuses an ambiguous %s pin', (key, value, message) => {
    const f = fixture();
    expect(() => loadPinnedPackageCandidate({ ...f.env, [key]: value }, f.snapshot, TARGET)).toThrow(message);
    expect(existsSync(f.snapshot)).toBe(false);
  });
});
