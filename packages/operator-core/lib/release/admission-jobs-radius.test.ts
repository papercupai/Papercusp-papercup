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
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMISSION_RADIUS_CAP, admissionRadiusEdgeCache, executeAdmissionJob, ordinaryAdmissionRadius } from './admission-jobs';
import { edgeCacheKey } from '../../../../scripts/lib/related-tests.mjs';
import { evaluateFixPrecheck } from './admission-fix-precheck';

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
  put(component, {
    'package.json': JSON.stringify({ name: '@t/c' }),
    'src/api.ts': 'export const api = 1;\n',
    'src/api.test.ts': "import { api } from './api';\nexport const t = api;\n",
  });
  git(component, 'add', '.');
  git(component, 'commit', '-q', '-m', 'component');
  const pin = git(component, 'rev-parse', 'HEAD');
  put(root, {
    'package.json': JSON.stringify({ name: '@t/root', private: true }),
    'pkg-a/package.json': JSON.stringify({ name: '@t/a' }),
    // Comments + a trailing comma: the pinned blob goes through the shared tsconfig parser.
    'pkg-a/tsconfig.json': '{\n  // aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"], }, },\n}\n',
    'pkg-a/playwright.config.ts': "export default { testDir: './e2e', testMatch: /.*\\.spec\\.ts$/ };\n",
    'pkg-a/lib/core.ts': 'export const core = 1;\n',
    'pkg-a/lib/core.test.ts': "import { core } from './core';\nexport const t = core;\n",
    'pkg-a/lib/alias.test.ts': "import { core } from '@/lib/core';\nexport const t = core;\n",
    'pkg-a/lib/other.ts': 'export const other = 2;\n',
    // Imports through the alias but NOT core: selected only if the alias seam failed.
    'pkg-a/lib/other.test.ts': "import { other } from '@/lib/other';\nexport const t = other;\n",
    'pkg-a/e2e/flow.spec.ts': "import { core } from '../lib/core';\nexport const t = core;\n",
    // Every Vitest config excludes _retired/** (baseExclude): no suite could measure it, so it
    // would refuse every admission as unmeasured. Measured live at HEAD 99f63686ca before the fix.
    'pkg-a/_retired/old.test.ts': "import { core } from '../lib/core';\nexport const t = core;\n",
    'pkg-b/package.json': JSON.stringify({ name: '@t/b' }),
    'pkg-b/src/util.ts': 'export const util = 3;\n',
    'pkg-b/src/util.test.ts': "import { util } from './util';\nexport const t = util;\n",
    'pkg-b/src/lonely.ts': 'export const lonely = 4;\n',
    // Cross-workspace dependent: out of the admission radius by design (#D-037 point 2).
    'pkg-b/src/uses-a.test.ts': "import { core } from '../../pkg-a/lib/core';\nexport const t = core;\n",
  });
  git(root, 'add', '.');
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${pin},component`);
  git(root, 'commit', '-q', '-m', 'frozen tree');
  commit = git(root, 'rev-parse', 'HEAD');
  // The shared working tree drifts after the commit; none of this may reach the radius.
  unlinkSync(join(root, 'pkg-a/tsconfig.json'));
  put(root, { 'pkg-a/lib/ambient.test.ts': "import { core } from './core';\n" });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('ordinaryAdmissionRadius (P-007)', () => {
  it('selects same-workspace importers, alias importers included, from the pinned tree only', () => {
    const radius = radiusFor(['pkg-a/lib/core.ts']);
    expect(radius).toMatchObject({ status: 'measured', reason: 'ok' });
    // other.test.ts imports '@/lib/other': resolved through the pinned tsconfig, so NOT selected.
    // flow.spec.ts is Playwright's; uses-a.test.ts is another workspace; ambient.test.ts is uncommitted.
    expect(radius.guarded).toEqual(['pkg-a/lib/alias.test.ts', 'pkg-a/lib/core.test.ts']);
    expect(radius.reportOnly).toEqual([]);
    expect(radius.legs).toEqual({ 'pkg-a/lib/alias.test.ts': '@t/a', 'pkg-a/lib/core.test.ts': '@t/a' });
    expect(radius.detail).toContain('playwright-excluded=1');
  });

  it("a radius file in a workspace whose leg the signature already names red is report-only", () => {
    const radius = radiusFor(['pkg-a/lib/core.ts'], { signature: [{ kind: 'workspace-task', id: '@t/a :: test', workspace: '@t/a' }] });
    expect(radius.guarded).toEqual([]);
    expect(radius.reportOnly).toEqual(['pkg-a/lib/alias.test.ts', 'pkg-a/lib/core.test.ts']);
    // The leg is also read from the task id when the entry carries no workspace.
    expect(radiusFor(['pkg-a/lib/core.ts'], { signature: [{ kind: 'workspace-task', id: '@t/a :: test' }] }).guarded).toEqual([]);
    // A red leg elsewhere leaves this workspace's files guarded.
    expect(radiusFor(['pkg-a/lib/core.ts'], { signature: [{ kind: 'workspace-task', id: '@t/b :: test' }] }).guarded)
      .toEqual(['pkg-a/lib/alias.test.ts', 'pkg-a/lib/core.test.ts']);
  });

  it('never re-lists a signature or admitted test file as radius', () => {
    const radius = radiusFor(['pkg-a/lib/core.ts', 'pkg-a/lib/core.test.ts'], { signature: [{ kind: 'test-file', id: 'pkg-a/lib/alias.test.ts' }] });
    expect(radius).toMatchObject({ status: 'measured', guarded: [], reportOnly: [] });
    expect(radius.legs).toEqual({ 'pkg-a/lib/core.test.ts': '@t/a' });
  });

  it('groups per owning workspace, including one inside a pinned submodule', () => {
    const radius = radiusFor(['pkg-b/src/util.ts', 'component/src/api.ts']);
    expect(radius).toMatchObject({ status: 'measured', reason: 'ok', detail: expect.stringContaining('2 workspace(s)') });
    expect(radius.guarded).toEqual(['component/src/api.test.ts', 'pkg-b/src/util.test.ts']);
    expect(radius.legs).toEqual({ 'component/src/api.test.ts': '@t/c', 'pkg-b/src/util.test.ts': '@t/b' });
  });

  it('a radius wider than the cap is skipped with the count, never run partially', () => {
    expect(ADMISSION_RADIUS_CAP).toBe(40);
    expect(radiusFor(['pkg-a/lib/core.ts'], { cap: 1 })).toMatchObject({ status: 'skipped', reason: 'over-cap(2/1)', guarded: [], reportOnly: [] });
  });

  it('a source no test reaches is skipped loudly, not silently measured as empty', () => {
    expect(radiusFor(['pkg-b/src/lonely.ts'])).toMatchObject({ status: 'skipped', reason: 'selection-full:empty-selection', guarded: [] });
  });

  it('an admission of test files only is not-applicable but still names each leg', () => {
    expect(radiusFor(['pkg-b/src/util.test.ts', 'README.md'])).toEqual({
      status: 'not-applicable', reason: 'no-source-paths', guarded: [], reportOnly: [], legs: { 'pkg-b/src/util.test.ts': '@t/b' },
    });
  });

  it('an unreadable pinned submodule store is radius-unavailable, never a refusal', () => {
    const radius = ordinaryAdmissionRadius({
      root, commit, signature: [], admittedPaths: ['missing/x.ts'],
      top: [{ mode: '160000', type: 'commit', sha: 'a'.repeat(40), file: 'missing' }],
    });
    expect(radius).toMatchObject({ status: 'skipped', reason: 'radius-unavailable', detail: expect.stringContaining('object store unavailable') });
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
    expect(radiusFor(['pkg-a/lib/core.ts']).guarded).toEqual(['pkg-a/lib/core.test.ts']);
    cache.clear();
    expect(radiusFor(['pkg-a/lib/core.ts'])).toEqual(first);
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
    expect(population.files).toEqual(['pkg-b/src/util.test.ts', 'pkg-a/lib/alias.test.ts', 'pkg-a/lib/core.test.ts']);
    const verdict = evaluateFixPrecheck(population, { ran: true, commit, results: population.files.map((path) => ({
      path, status: path === 'pkg-a/lib/core.test.ts' ? 'fail' : 'pass',
    })) });
    expect(verdict).toMatchObject({ ok: false, code: 'admission-imports-red', importedRed: ['pkg-a/lib/core.test.ts'], newlyRedLegs: ['@t/a'] });
  });
});
