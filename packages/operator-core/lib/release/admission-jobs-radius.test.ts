/**
 * P-007 (green-main-cycle-time-2026-10-08#D-036, #D-037): an ORDINARY admission's related-test
 * radius, selected at the built commit from pinned Git trees.
 *
 * The fixture is a real Git repository with two npm workspaces, a tsconfig `@/` alias, a
 * Playwright-owned spec, a cross-workspace importer and a pinned submodule workspace. Every
 * assertion reads the COMMITTED tree: the working tree is mutated after the commit to prove the
 * radius never consults it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as admissionBlobs from './admission-import-completeness';
import { ADMISSION_RADIUS_CAP, admissionRadiusEdgeCache, executeAdmissionJob, ordinaryAdmissionRadius } from './admission-jobs';
import { edgeCacheKey } from '../../../../scripts/lib/related-tests.mjs';
import * as relatedTests from '../../../../scripts/lib/related-tests.mjs';
import { evaluateFixPrecheck } from './admission-fix-precheck';
import { expandWorkspaces } from '../../../../scripts/assert-workspace-links.mjs';
import { pinnedNonWorkspacePathRoutes } from '../../../../scripts/lib/affected-path-routes.mjs';

let root: string;
let commit: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const init = (cwd: string) => {
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'user.name', 'test');
};
const put = (base: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, file)), { recursive: true });
    writeFileSync(join(base, file), text);
  }
};

function topTree(): Array<{ mode: string; type: string; sha: string; file: string }> {
  return git(root, 'ls-tree', '-r', '--full-tree', commit).split('\n').filter(Boolean).map((row) => {
    const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/.exec(row)!;
    return { mode: match[1]!, type: match[2]!, sha: match[3]!, file: match[4]! };
  });
}

const radiusFor = (admittedPaths: string[], extra: { signature?: Parameters<typeof ordinaryAdmissionRadius>[0]['signature']; cap?: number } = {}) =>
  ordinaryAdmissionRadius({ root, commit, top: topTree(), signature: extra.signature ?? [], admittedPaths, ...(extra.cap ? { cap: extra.cap } : {}) });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'admission-radius-'));
  init(root);
  // A pinned submodule that is its own workspace.
  const component = join(root, 'component');
  mkdirSync(component);
  init(component);
  const nested = join(component, 'addon');
  mkdirSync(nested);
  init(nested);
  put(nested, {
    'package.json': JSON.stringify({ name: '@t/nested' }),
    'vitest.config.ts': 'export default {test:{include:["src/**/*.test.ts"]}};\n',
    'src/api.ts': 'export const api = 1;\n',
    'src/api.test.ts': "import { api } from './api';\nexport const t = api;\n",
  });
  git(nested, 'add', '.');
  git(nested, 'commit', '-q', '-m', 'nested');
  const nestedPin = git(nested, 'rev-parse', 'HEAD');
  put(component, {
    'package.json': JSON.stringify({ name: '@t/c' }),
    'vitest.config.ts': 'export default {};\n',
    'src/api.ts': 'export const api = 1;\n',
    'src/api.test.ts': "import { api } from './api';\nexport const t = api;\n",
  });
  git(component, 'add', '.');
  git(component, 'update-index', '--add', '--cacheinfo', `160000,${nestedPin},addon`);
  git(component, 'commit', '-q', '-m', 'component');
  const pin = git(component, 'rev-parse', 'HEAD');
  put(root, {
    'package.json': JSON.stringify({ name: '@t/root', private: true, workspaces: ['pkg-*', 'packages/*', 'component', 'wide', '!pkg-excluded'] }),
    'scripts/affected-tests.mjs': readFileSync(resolve(import.meta.dirname, '../../../../scripts/affected-tests.mjs'), 'utf8'),
    'scripts/bootstrap.mjs': 'export const bootstrap = 1;\n',
    'pkg-a/package.json': JSON.stringify({ name: '@t/a' }),
    'pkg-a/vitest.config.ts': 'export default {};\n',
    // Comments + a trailing comma: the pinned blob goes through the shared tsconfig parser.
    'pkg-a/tsconfig.json': '{\n  // aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"], }, },\n}\n',
    'pkg-a/playwright.config.ts': "export default { testDir: './e2e', testMatch: /.*\\.spec\\.ts$/ };\n",
    'pkg-a/lib/core.ts': 'export const core = 1;\n',
    'pkg-a/lib/core.test.ts': "import { core } from './core';\nexport const t = core;\n",
    'pkg-a/lib/alias.test.ts': "import { core } from '@/lib/core';\nexport const t = core;\n",
    'pkg-a/lib/other.ts': 'export const other = 2;\n',
    // Imports through the alias but NOT core: selected only if the alias seam failed.
    'pkg-a/lib/other.test.ts': "import { other } from '@/lib/other';\nexport const t = other;\n",
    'pkg-a/fixtures/invalid/package.json': 'DELIBERATELY INVALID TEST DATA',
    'pkg-a/e2e/flow.spec.ts': "import { core } from '../lib/core';\nexport const t = core;\n",
    // Every Vitest config excludes _retired/** (baseExclude): no suite could measure it, so it
    // would refuse every admission as unmeasured. Measured live at HEAD 99f63686ca before the fix.
    'pkg-a/_retired/old.test.ts': "import { core } from '../lib/core';\nexport const t = core;\n",
    'pkg-b/package.json': JSON.stringify({ name: '@t/b', dependencies: { '@t/a': '*' } }),
    'pkg-b/vitest.config.ts': 'export default {};\n',
    'pkg-b/src/util.ts': 'export const util = 3;\n',
    'pkg-b/src/util.test.ts': "import { util } from './util';\nexport const t = util;\n",
    'pkg-b/src/lonely.ts': 'export const lonely = 4;\n',
    // The pinned dependency graph now includes this consumer's importing test.
    'pkg-b/src/uses-a.test.ts': "import { core } from '../../pkg-a/lib/core';\nexport const t = core;\n",
    'packages/operator-core/package.json': JSON.stringify({ name: '@papercusp/operator-core' }),
    'packages/operator-core/vitest.config.ts': 'export default {test:{include:["lib/**/*.test.ts"]}};\n',
    'packages/operator-core/lib/bootstrap.test.ts': "import { bootstrap } from '../../../scripts/bootstrap.mjs';\nexport const t = bootstrap;\n",
    'packages/operator-core/lib/other.test.ts': 'export const other = 1;\n',
    'pkg-consumer/package.json': JSON.stringify({ name: '@t/consumer', dependencies: { '@papercusp/operator-core': '*' } }),
    'pkg-consumer/vitest.config.ts': 'export default {test:{include:["lib/**/*.test.ts"]}};\n',
    'pkg-consumer/lib/consumer.test.ts': 'export const consumer = 1;\n',
    'pkg-excluded/package.json': JSON.stringify({ name: '@t/excluded' }),
    'pkg-excluded/src/ignored.test.ts': "import { core } from '../../pkg-a/lib/core';\n",
    'wide/package.json': JSON.stringify({ name: '@t/wide' }),
    'wide/vitest.config.ts': 'export default {test:{include:["src/**/*.test.ts"]}};\n',
    'wide/src/core.ts': 'export const core = 1;\n',
    ...Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`wide/src/fan-${String(i).padStart(2, '0')}.test.ts`, "import { core } from './core';\nexport const t = core;\n"])),
  });
  git(root, 'add', '.');
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${pin},component`);
  git(root, 'commit', '-q', '-m', 'frozen tree');
  commit = git(root, 'rev-parse', 'HEAD');
  // The shared working tree drifts after the commit; none of this may reach the radius.
  unlinkSync(join(root, 'pkg-a/tsconfig.json'));
  put(root, { 'pkg-a/lib/ambient.test.ts': "import { core } from './core';\n" });
  put(root, {
    'scripts/affected-tests.mjs': 'const NON_WORKSPACE_PATH_ROUTES = [];\n',
    'component/src/api.test.ts': 'BROKEN UNCOMMITTED SOURCE',
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('ordinaryAdmissionRadius (P-007)', () => {
  it('selects pinned local and cross-workspace importers with each workspace alias', () => {
    const radius = radiusFor(['pkg-a/lib/core.ts']);
    expect(radius).toMatchObject({ status: 'measured', reason: 'ok' });
    // other.test.ts imports '@/lib/other': resolved through the pinned tsconfig, so NOT selected.
    // flow.spec.ts is Playwright's; ambient.test.ts is uncommitted; pkg-excluded is not a workspace.
    expect(radius.guarded).toEqual(['pkg-a/lib/alias.test.ts', 'pkg-a/lib/core.test.ts', 'pkg-b/src/uses-a.test.ts']);
    expect(radius.reportOnly).toEqual([]);
    expect(radius.legs).toEqual({ 'pkg-a/lib/alias.test.ts': '@t/a', 'pkg-a/lib/core.test.ts': '@t/a', 'pkg-b/src/uses-a.test.ts': '@t/b' });
    expect(radius.detail).toContain('playwright-excluded=1');
  });

  it("a radius file in a workspace whose leg the signature already names red is report-only", () => {
    const radius = radiusFor(['pkg-a/lib/core.ts'], { signature: [{ kind: 'workspace-task', id: '@t/a :: test', workspace: '@t/a' }] });
    expect(radius.guarded).toEqual(['pkg-b/src/uses-a.test.ts']);
    expect(radius.reportOnly).toEqual(['pkg-a/lib/alias.test.ts', 'pkg-a/lib/core.test.ts']);
    // The leg is also read from the task id when the entry carries no workspace.
    expect(radiusFor(['pkg-a/lib/core.ts'], { signature: [{ kind: 'workspace-task', id: '@t/a :: test' }] }).guarded).toEqual(['pkg-b/src/uses-a.test.ts']);
    // A red leg elsewhere leaves this workspace's files guarded.
    expect(radiusFor(['pkg-a/lib/core.ts'], { signature: [{ kind: 'workspace-task', id: '@t/b :: test' }] }).guarded)
      .toEqual(['pkg-a/lib/alias.test.ts', 'pkg-a/lib/core.test.ts']);
  });

  it('never re-lists a signature or admitted test file as radius', () => {
    const radius = radiusFor(['pkg-a/lib/core.ts', 'pkg-a/lib/core.test.ts'], { signature: [{ kind: 'test-file', id: 'pkg-a/lib/alias.test.ts' }] });
    expect(radius).toMatchObject({ status: 'measured', guarded: ['pkg-b/src/uses-a.test.ts'], reportOnly: [] });
    expect(radius.legs).toEqual({ 'pkg-a/lib/core.test.ts': '@t/a', 'pkg-b/src/uses-a.test.ts': '@t/b' });
  });

  it('bounds repository-prefix probes during dependency candidate lookup', () => {
    const startsWith = String.prototype.startsWith;
    const prefix = join(root, 'component') + '/';
    const buildIndex = relatedTests.buildIndex;
    let membershipMatches = true;
    const index = vi.spyOn(relatedTests, 'buildIndex').mockImplementation(options => {
      // Dependency resolution repeatedly probes the same existing and missing
      // extension candidates; exercise the actual immutable filesystem adapter.
      for (let i = 0; i < 1_000; i += 1) {
        membershipMatches = options!.fs!.exists(join(root, 'component/addon/src/api.ts')) && membershipMatches;
        membershipMatches = !options!.fs!.exists(join(root, 'component/addon/src/missing.ts')) && membershipMatches;
      }
      return buildIndex(options);
    });
    let probes = 0;
    const probe = vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (this: string, search, position) {
      if (search === prefix) probes += 1;
      return startsWith.call(this, search, position);
    });
    let radius: ReturnType<typeof radiusFor>;
    try {
      radius = radiusFor(['pkg-a/lib/core.ts', 'component/src/api.ts']);
    } finally {
      probe.mockRestore();
      index.mockRestore();
    }
    expect(membershipMatches).toBe(true);
    expect(radius!.guarded).toEqual(['component/src/api.test.ts', 'pkg-a/lib/alias.test.ts', 'pkg-a/lib/core.test.ts', 'pkg-b/src/uses-a.test.ts']);
    // Candidate extension probes must not each traverse the pinned repository tree.
    expect(probes).toBeLessThan(100);
  });

  it('groups per owning workspace, including one inside a pinned submodule', () => {
    const radius = radiusFor(['pkg-b/src/util.ts', 'component/src/api.ts']);
    expect(radius).toMatchObject({ status: 'measured', reason: 'ok', detail: expect.stringContaining('2 workspace(s)') });
    expect(radius.guarded).toEqual(['component/src/api.test.ts', 'pkg-b/src/util.test.ts']);
    expect(radius.legs).toEqual({ 'component/src/api.test.ts': '@t/c', 'pkg-b/src/util.test.ts': '@t/b' });
  });

  it('a 41-file radius retains every file beyond the unchanged group cap', () => {
    expect(ADMISSION_RADIUS_CAP).toBe(40);
    const expected = Array.from({ length: 41 }, (_, i) => `wide/src/fan-${String(i).padStart(2, '0')}.test.ts`);
    const radius = radiusFor(['wide/src/core.ts']);
    expect(radius).toMatchObject({ status: 'measured', reason: 'ok', detail: expect.stringContaining('execution-groups=2') });
    expect(radius.guarded).toEqual(expected);
    expect(radius.reportOnly).toEqual([]);
    expect(radius.legs).toEqual(Object.fromEntries(expected.map(file => [file, '@t/wide'])));
    expect(radiusFor(['wide/src/core.ts'], { cap: 1 }).guarded).toEqual(expected);
  });

  it('retains related tests when independent pinned workspaces share a package name', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'admission-duplicate-workspace-'));
    try {
      init(fixture);
      put(fixture, {
        'package.json': JSON.stringify({ private: true, workspaces: ['left', 'right', 'consumer', 'empty'] }),
        ...Object.fromEntries(['left', 'right'].flatMap(dir => [
          [`${dir}/package.json`, JSON.stringify({ name: '@t/duplicate', exports: './core.ts' })],
          [`${dir}/vitest.config.ts`, 'export default {};'],
          [`${dir}/core.ts`, 'export const core = 1;'],
          [`${dir}/core.test.ts`, "import './core';"],
        ])),
        'consumer/package.json': JSON.stringify({ name: '@t/consumer', dependencies: { '@t/duplicate': '*' } }),
        'consumer/vitest.config.ts': 'export default {};',
        'consumer/uses.test.ts': "import '@t/duplicate';",
        'empty/package.json': JSON.stringify({ name: '@t/empty', dependencies: { '@t/duplicate': '*' } }),
        'empty/vitest.config.ts': 'export default {};',
        'empty/core.ts': 'export const core = 1;',
      });
      git(fixture, 'add', '.');
      git(fixture, 'commit', '-q', '-m', 'same-name pinned workspaces');
      const pinned = git(fixture, 'rev-parse', 'HEAD');
      for (const dir of ['left', 'right']) {
        const result = await executeAdmissionJob({ kind: 'precheck-population', input: {
          root: fixture, commit: pinned, signature: [], admittedPaths: [`${dir}/core.ts`],
        } });
        // The production discovery job must preserve both the local test and its bare importer.
        expect(result).toMatchObject({ ok: true, population: { radius: {
          status: 'measured', guarded: ['consumer/uses.test.ts', `${dir}/core.test.ts`],
          detail: expect.stringContaining('full=@t/empty:no-test-files'),
        } } });
      }
      // The same empty workspace is still unmeasured when it owns the changed source.
      expect(await executeAdmissionJob({ kind: 'precheck-population', input: {
        root: fixture, commit: pinned, signature: [], admittedPaths: ['empty/core.ts'],
      } })).toMatchObject({ ok: true, population: { radius: {
        status: 'skipped', reason: 'selection-full:no-test-files',
      } } });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('a source no test reaches is skipped loudly, not silently measured as empty', () => {
    expect(radiusFor(['pkg-b/src/lonely.ts'])).toMatchObject({ status: 'skipped', reason: 'selection-full:empty-selection', guarded: [] });
  });

  it('an admission of test files only is not-applicable but still names each leg', () => {
    expect(radiusFor(['pkg-b/src/util.test.ts', 'README.md'])).toEqual({
      status: 'not-applicable', reason: 'no-source-paths', guarded: [], reportOnly: [], legs: { 'pkg-b/src/util.test.ts': '@t/b' },
    });
  });

  it('a source absent from the built commit is radius-unavailable', () => {
    const radius = ordinaryAdmissionRadius({
      root, commit, signature: [], admittedPaths: ['missing/x.ts'],
      top: topTree(),
    });
    expect(radius).toMatchObject({ status: 'skipped', reason: 'radius-unavailable', detail: expect.stringContaining('source absent from built commit') });
  });

  it('follows a nested pinned submodule without consulting either working tree', () => {
    put(root, { 'component/addon/src/api.test.ts': 'BROKEN UNCOMMITTED NESTED SOURCE' });
    expect(radiusFor(['component/addon/src/api.ts'])).toMatchObject({
      status: 'measured', reason: 'ok', guarded: ['component/addon/src/api.test.ts'],
      legs: { 'component/addon/src/api.test.ts': '@t/nested' },
    });
  });

  it('an unavailable pinned submodule store cannot produce a measured empty population', () => {
    const marker = join(root, 'component/addon/.git');
    renameSync(marker, marker + '.held');
    try {
      expect(radiusFor(['component/addon/src/api.ts']))
        .toMatchObject({ status: 'skipped', reason: 'radius-unavailable', guarded: [], detail: expect.stringContaining('object store unavailable') });
    } finally { renameSync(marker + '.held', marker); }
  });

  it('reuses parsed import edges by (path, blob sha) across admissions, and the reuse is real', () => {
    const cache = admissionRadiusEdgeCache();
    cache.clear();
    const first = radiusFor(['pkg-a/lib/core.ts']);
    const key = edgeCacheKey(join(root, 'pkg-a/lib/alias.test.ts'), git(root, 'rev-parse', `${commit}:pkg-a/lib/alias.test.ts`));
    expect(cache.get(key)).toEqual({ specifiers: ['@/lib/core'], runtimePaths: [] });
    expect(radiusFor(['pkg-a/lib/core.ts'])).toEqual(first);
    // Poison the cached parse: a radius that honours it proves the blob was neither re-read nor re-parsed.
    cache.set(key, { specifiers: [], runtimePaths: [] });
    expect(radiusFor(['pkg-a/lib/core.ts']).guarded).toEqual(['pkg-a/lib/core.test.ts', 'pkg-b/src/uses-a.test.ts']);
    cache.clear();
    expect(radiusFor(['pkg-a/lib/core.ts'])).toEqual(first);
  });

  it.each(['p-a/src', 'scripts/shared'])('batches a reached external import chain in %s', (sourceRoot) => {
    const fixture = mkdtempSync(join(tmpdir(), 'admission-radius-external-'));
    const chainLength = 24;
    const batchRead = vi.spyOn(admissionBlobs, 'readAdmissionBlobBatch');
    try {
      init(fixture);
      put(fixture, {
        'package.json': JSON.stringify({ private: true, workspaces: ['p-*'] }),
        'p-a/package.json': JSON.stringify({ name: '@t/provider' }),
        'p-b/package.json': JSON.stringify({ name: '@t/consumer' }),
        'p-b/vitest.config.ts': 'export default {};\n',
        'p-b/src/core.ts': 'export const core = 1;\n',
        'p-b/src/core.test.ts': `import { core } from './core';\nimport '../../${sourceRoot}/dependency-0';\nexport const t = core;\n`,
        ...Object.fromEntries(Array.from({ length: chainLength }, (_, i) => [
          `${sourceRoot}/dependency-${i}.ts`,
          `${i + 1 < chainLength ? `import './dependency-${i + 1}';\n` : ''}export const value = ${i};\n`,
        ])),
      });
      git(fixture, 'add', '.');
      git(fixture, 'commit', '-q', '-m', 'pinned external import chain');
      const frozen = git(fixture, 'rev-parse', 'HEAD');
      const top = git(fixture, 'ls-tree', '-r', '--full-tree', frozen).split('\n').map((row) => {
        const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/.exec(row)!;
        return { mode: match[1]!, type: match[2]!, sha: match[3]!, file: match[4]! };
      });
      // Reached modules must still come from the pinned object store.
      rmSync(join(fixture, sourceRoot), { recursive: true });
      const radius = ordinaryAdmissionRadius({ root: fixture, commit: frozen, top,
        signature: [], admittedPaths: ['p-b/src/core.ts'] });
      expect(radius).toMatchObject({ status: 'measured', reason: 'ok', guarded: ['p-b/src/core.test.ts'], reportOnly: [] });
      expect(batchRead.mock.calls.some(([, ids]) => ids.length >= chainLength)).toBe(true);
      expect(batchRead.mock.calls.filter(([, ids]) => ids.length === 1)).toHaveLength(3);
    } finally {
      batchRead.mockRestore();
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('root-bootstrap routes use pinned policy and conservatively retain each affected workspace census', () => {
    const radius = radiusFor(['scripts/bootstrap.mjs']);
    const expected = ['packages/operator-core/lib/bootstrap.test.ts', 'packages/operator-core/lib/other.test.ts', 'pkg-consumer/lib/consumer.test.ts'];
    expect(radius).toMatchObject({ status: 'measured', reason: 'ok', reportOnly: [] });
    expect(radius.guarded).toEqual(expected);
    expect(radius.legs).toEqual({ [expected[0]!]: '@papercusp/operator-core', [expected[1]!]: '@papercusp/operator-core', [expected[2]!]: '@t/consumer' });
    expect(radius.detail).toContain('full=@papercusp/operator-core:cross-root-unrelatable-change');
    expect(radius.detail).toContain('full=@t/consumer:cross-root-unrelatable-change');
  });

  it('native Vitest discovery independently agrees with full root-bootstrap and 41-file populations', () => {
    const census = (dir: string): string[] => {
      const output = execFileSync(process.execPath, [resolve(import.meta.dirname, '../../../../node_modules/vitest/vitest.mjs'),
        'list', '--root', join(root, dir), '--config', join(root, dir, 'vitest.config.ts'), '--filesOnly'],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_OPTIONS: '', PC_TEST_FILTER_LIST: '' } });
      return output.split('\n').map(line => line.trim()).filter(line => line.endsWith('.test.ts'))
        .map(file => `${dir}/${file.replace(join(root, dir) + '/', '')}`).sort();
    };
    expect(radiusFor(['scripts/bootstrap.mjs']).guarded).toEqual([...census('packages/operator-core'), ...census('pkg-consumer')]);
    expect(radiusFor(['wide/src/core.ts']).guarded).toEqual(census('wide'));
  }, 60_000);

  it('assigns nested pinned workspace ownership without rescanning every gitlink for every repository', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'admission-radius-owners-'));
    const count = 8;
    const prefixes = new Set(Array.from({ length: count }, (_, i) => join(fixture, `component-${i}`) + '/'));
    let ownerProbes = 0;
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      init(fixture);
      put(fixture, {
        'package.json': JSON.stringify({ private: true, workspaces: ['pkg-a', 'component-*/inner'] }),
        'pkg-a/package.json': JSON.stringify({ name: '@t/provider' }),
        'pkg-a/vitest.config.ts': 'export default {};\n',
        'pkg-a/src/core.ts': 'export const core = 1;\n',
        'pkg-a/src/core.test.ts': "import { core } from './core';\nexport const t = core;\n",
      });
      for (let i = 0; i < count; i += 1) {
        const child = join(fixture, `component-${i}`);
        mkdirSync(child);
        init(child);
        put(child, {
          'package.json': JSON.stringify({ private: true, workspaces: ['inner'] }),
          'inner/package.json': JSON.stringify({ name: `@t/nested-${i}`, dependencies: { '@t/provider': '*' } }),
          'inner/vitest.config.ts': 'export default {};\n',
          'inner/src/uses.test.ts': "import { core } from '../../../pkg-a/src/core';\nexport const t = core;\n",
        });
        git(child, 'add', '.');
        git(child, 'commit', '-q', '-m', 'pinned nested consumer');
        git(fixture, 'update-index', '--add', '--cacheinfo', `160000,${git(child, 'rev-parse', 'HEAD')},component-${i}`);
        put(child, { 'inner/src/uses.test.ts': 'BROKEN UNCOMMITTED CONSUMER' });
      }
      git(fixture, 'add', 'package.json', 'pkg-a');
      git(fixture, 'commit', '-q', '-m', 'pinned workspace owners');
      const frozen = git(fixture, 'rev-parse', 'HEAD');
      const top = git(fixture, 'ls-tree', '-r', '--full-tree', frozen).split('\n').map((row) => {
        const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/.exec(row)!;
        return { mode: match[1]!, type: match[2]!, sha: match[3]!, file: match[4]! };
      });
      const original = String.prototype.startsWith;
      spy = vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (this: string, prefix: string, position?: number) {
        if (this.endsWith('/package.json') && prefixes.has(prefix)) ownerProbes += 1;
        return original.call(this, prefix, position);
      });
      const radius = ordinaryAdmissionRadius({ root: fixture, commit: frozen, top, signature: [], admittedPaths: ['pkg-a/src/core.ts'] });
      spy.mockRestore();
      spy = undefined;
      expect(radius).toMatchObject({ status: 'measured', reason: 'ok' });
      expect(radius.guarded).toEqual([
        ...Array.from({ length: count }, (_, i) => `component-${i}/inner/src/uses.test.ts`),
        'pkg-a/src/core.test.ts',
      ]);
      for (let i = 0; i < count; i += 1)
        expect(radius.legs[`component-${i}/inner/src/uses.test.ts`]).toBe(`@t/nested-${i}`);
      expect(ownerProbes).toBeLessThan(160);
    } finally {
      spy?.mockRestore();
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects a supplied tree from a different source identity instead of measuring it', () => {
    const top = topTree().map(entry => entry.file === 'pkg-a/lib/core.ts' ? { ...entry, sha: '0'.repeat(40) } : entry);
    expect(ordinaryAdmissionRadius({ root, commit, top, signature: [], admittedPaths: ['pkg-a/lib/core.ts'] }))
      .toMatchObject({ status: 'skipped', reason: 'radius-unavailable', detail: expect.stringContaining('source tree does not match') });
  });

  it('keeps the local orphan refusal even when other affected workspaces have tests', () => {
    expect(radiusFor(['pkg-b/src/lonely.ts', 'wide/src/core.ts']))
      .toMatchObject({ status: 'skipped', reason: 'selection-full:empty-selection', guarded: [], reportOnly: [] });
    expect(radiusFor(['pkg-b/src/lonely.ts', 'pkg-b/src/util.ts']))
      .toMatchObject({ status: 'skipped', reason: 'selection-full:empty-selection', guarded: [], reportOnly: [] });
  });

  it('pinned route parsing fails closed on missing, dynamic or malformed policy', () => {
    for (const text of ['', 'const NON_WORKSPACE_PATH_ROUTES = getRoutes();', 'const NON_WORKSPACE_PATH_ROUTES = [\n{prefix: 1, workspace: "x"}\n];'])
      expect(() => pinnedNonWorkspacePathRoutes(text)).toThrow();
  });

  it('the immutable workspace census uses the same positive and exclusion globs as native expansion', () => {
    const patterns = ['pkg-*', 'packages/*', '!pkg-excluded'];
    const directories = ['pkg-a', 'pkg-b', 'pkg-consumer', 'pkg-excluded', 'packages/operator-core'];
    expect(expandWorkspaces(patterns, root, { directories }).sort()).toEqual(expandWorkspaces(patterns, root).sort());
  });
});

describe('immutablePrecheckPopulation with an ordinary admission (P-007)', () => {
  it('adds the measured radius to the R6 population and refuses a newly red guarded file by leg', async () => {
    const result = await executeAdmissionJob({ kind: 'precheck-population', input: {
      root, commit, signature: [{ kind: 'test-file', id: 'pkg-b/src/util.test.ts' }], admittedPaths: ['pkg-a/lib/core.ts'],
    } });
    if (!result.ok) throw new Error(result.detail);
    const { population } = result;
    expect(population.admittedTestFiles).toEqual([]);
    expect(population.files).toEqual(['pkg-b/src/util.test.ts', 'pkg-a/lib/alias.test.ts', 'pkg-a/lib/core.test.ts', 'pkg-b/src/uses-a.test.ts']);
    const run = { ran: true as const, commit, results: population.files.map((path) => ({
      path, status: (path === 'pkg-a/lib/core.test.ts' ? 'fail' : 'pass') as 'pass' | 'fail',
    })) };
    // measured-wide-repair-admission-2026-10-24#D-004 ruling 1: "newly" red needs a MEASURED green
    // at the previous head; without the paired baseline the guarded red is unpaired, never blamed.
    const previousHead = { commit: 'b'.repeat(40), results: [{ path: 'pkg-a/lib/core.test.ts', status: 'pass' as const }] };
    expect(evaluateFixPrecheck(population, run, { previousHead }))
      .toMatchObject({ ok: false, code: 'admission-imports-red', importedRed: ['pkg-a/lib/core.test.ts'], newlyRedLegs: ['@t/a'] });
    expect(evaluateFixPrecheck(population, run))
      .toMatchObject({ ok: false, code: 'admission-precheck-unavailable', importedRed: [], baselineMissing: ['pkg-a/lib/core.test.ts'] });
  });
});
