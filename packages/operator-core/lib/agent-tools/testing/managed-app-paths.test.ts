import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInRequestScope, runWithWorkspace } from '../../workspace-als';
import { validateCriterionCheckPaths } from '../../rubrics-criterion-checks';
import {
  checkoutRootForPath, groupTestFilesByCheckout, normalizeTestFilePaths, registeredHarnessSlugForRoot, sameRealPath,
} from './run';

describe('registeredHarnessSlugForRoot (EI-25203154942838341)', () => {
  // Paths that do not exist exercise the resolve() fallback; real symlinks are covered below.
  const app = '/nonexistent-ei25203154/apps/phone-app';
  const registry = (projects: Array<Record<string, unknown>>) =>
    vi.fn(async (_workspaceId?: string) => ({ projects }) as never);

  it('names the registered project whose checkout IS the root, and nothing for an unregistered root', async () => {
    const load = registry([
      { slug: 'papercusp', path: '/nonexistent-ei25203154/papercusp', harness_kind: 'coding' },
      { slug: 'phone-app', path: app, harness_kind: 'coding' },
    ]);
    await expect(registeredHarnessSlugForRoot(`${app}/`, 'ws-1', load)).resolves.toBe('phone-app');
    expect(load).toHaveBeenCalledWith('ws-1');
    await expect(registeredHarnessSlugForRoot('/nonexistent-ei25203154/elsewhere', 'ws-1', load)).resolves.toBeUndefined();
  });

  it('prefers the member project over a repo-less hive that borrows the same checkout', async () => {
    // The hive is listed FIRST so a naive matches[0] would name it.
    const load = registry([
      { slug: 'phone-hive', harness_kind: 'hive' },
      { slug: 'phone-app', path: app, harness_kind: 'coding', hive_slug: 'phone-hive' },
    ]);
    await expect(registeredHarnessSlugForRoot(app, 'ws-1', load)).resolves.toBe('phone-app');
  });

  it('compares real paths, so a symlinked checkout still matches its registration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'same-real-path-'));
    try {
      mkdirSync(join(dir, 'real'));
      symlinkSync(join(dir, 'real'), join(dir, 'link'));
      expect(sameRealPath(join(dir, 'link'), join(dir, 'real'))).toBe(true);
      expect(sameRealPath(join(dir, 'real'), dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('portable managed app test evidence', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'managed-app-tests-'));
  const workspaces = join(fixture, 'workspaces');
  const ambient = join(fixture, 'operator');
  const app = join(workspaces, 'one', '.papercusp', 'apps', 'phone-app');
  const testFile = join(app, 'tests', 'call.test.ts');
  const portable = '.papercusp/apps/phone-app/tests/call.test.ts';
  const previousRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;

  beforeAll(() => {
    process.env.PAPERCUSP_WORKSPACES_ROOT = workspaces;
    for (const root of [ambient, app]) {
      mkdirSync(join(root, '.git'), { recursive: true });
      mkdirSync(join(root, 'tests'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: [] }));
    }
    writeFileSync(testFile, 'export {};\n');
    writeFileSync(join(ambient, 'tests', 'operator.test.ts'), 'export {};\n');
    const decoy = join(ambient, '.papercusp', 'apps', 'phone-app', 'tests');
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, 'call.test.ts'), 'export {};\n');
    const outside = join(fixture, 'outside.test.ts');
    writeFileSync(outside, 'export {};\n');
    symlinkSync(outside, join(app, 'tests', 'escape.test.ts'));
    symlinkSync(ambient, join(workspaces, 'one', '.papercusp', 'apps', 'escape-app'), 'dir');
    const pointer = join(workspaces, 'one', '.papercusp', 'apps', 'phone-checkpoint');
    mkdirSync(join(pointer, 'tests'), { recursive: true });
    writeFileSync(join(pointer, '.git'), 'gitdir: /tmp/checkpoint\n');
    writeFileSync(join(pointer, 'package.json'), JSON.stringify({ workspaces: [] }));
    writeFileSync(join(pointer, 'tests', 'call.test.ts'), 'export {};\n');
  });

  afterAll(() => {
    if (previousRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
    else process.env.PAPERCUSP_WORKSPACES_ROOT = previousRoot;
    rmSync(fixture, { recursive: true, force: true });
  });

  it('resolves the portable citation to its managed app checkout', () => {
    expect(runWithWorkspace('one', () => normalizeTestFilePaths([portable], ambient)))
      .toEqual({ ok: true, files: [testFile] });
    expect(checkoutRootForPath(testFile)).toBe(app);
  });

  it('retains separate operator and app execution roots in a mixed request', () => {
    const result = runWithWorkspace('one', () =>
      normalizeTestFilePaths(['tests/operator.test.ts', portable], ambient));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected ambiguity');
    expect(groupTestFilesByCheckout(result.files, ambient)).toEqual([
      { root: ambient, files: ['tests/operator.test.ts'] },
      { root: app, files: [testFile] },
    ]);
  });

  it('makes a portable structured rubric check gradeable', () => {
    const result = runWithWorkspace('one', () => validateCriterionCheckPaths([
      { key: 'call', check: { kind: 'tests', files: [portable] } },
    ], { root: ambient }));
    expect(result.ok).toBe(true);
    expect(result.normalizedByKey.call).toEqual([testFile]);
  });

  it('keeps absolute paths forbidden in persistent rubric checks', () => {
    expect(runWithWorkspace('one', () => validateCriterionCheckPaths([
      { key: 'call', check: { kind: 'tests', files: [testFile] } },
    ], { root: ambient })).ok).toBe(false);
  });

  it('cannot resolve another workspace through the process-global registry', () => {
    expect(runWithWorkspace('two', () => normalizeTestFilePaths([portable], ambient)))
      .toMatchObject({ ok: false, path: portable, matches: [] });
    expect(runInRequestScope(() => normalizeTestFilePaths([portable], ambient)))
      .toMatchObject({ ok: false, path: portable, matches: [] });
  });

  it('cannot admit a missing or foreign app file as planned operator evidence', () => {
    for (const [workspace, file] of [
      ['one', '.papercusp/apps/phone-app/tests/missing.test.ts'],
      ['two', portable],
    ]) {
      const result = runWithWorkspace(workspace!, () => validateCriterionCheckPaths([
        { key: 'call', check: { kind: 'tests', files: [file!] } },
      ], { root: ambient, allowPlannedPaths: true }));
      expect(result.ok).toBe(false);
      expect(result.planned).toEqual([]);
      expect(result.failures[0]?.reason).toContain('current request workspace');
    }
  });

  it.each([
    '.papercusp/apps/phone-app/../phone-app/tests/call.test.ts',
    '.papercusp/apps/phone-app/tests/escape.test.ts',
    '.papercusp/apps/escape-app/tests/operator.test.ts',
    '.papercusp/apps/phone-checkpoint/tests/call.test.ts',
  ])('refuses unsafe or noncanonical app evidence %s', (path) => {
    expect(runWithWorkspace('one', () => normalizeTestFilePaths([path], ambient)))
      .toMatchObject({ ok: false, path, matches: [] });
    expect(runWithWorkspace('one', () => validateCriterionCheckPaths([
      { key: 'call', check: { kind: 'tests', files: [path] } },
    ], { root: ambient })).ok).toBe(false);
  });
});
