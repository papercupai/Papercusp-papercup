import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectVerifierInputClosure, qualifySyncLintProofInputs, syncLintProofRoots } from '../../../../scripts/qualify-sync-lint-proof.mjs';
import * as sourcePreview from '../../../../scripts/source-preview.mjs';
import { validateVerifierInputs } from '../../../../scripts/source-preview.mjs';
import { git, makeSuperproject, write } from '../source-preview.fixture';

const owned: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});
const testPath = 'packages/core/proof.test.ts';
const runtimePath = 'libs/papercusp/runtime.mjs';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'p037-source-admission-')); owned.push(dir);
  const { repo } = makeSuperproject(dir);
  const sub = join(repo, 'libs/papercusp');
  write(sub, 'package.json', JSON.stringify({ name: '@papercusp/core', type: 'module',
    exports: { '.': { types: './index.d.ts', import: './import.mjs', require: './index.mjs', default: './index.mjs' } } }));
  write(sub, 'index.d.ts', 'export declare const value: number;\n');
  write(sub, 'index.mjs', "export { value } from './runtime.mjs';\n");
  write(sub, 'import.mjs', "export { value } from './runtime.mjs'; import './import-only.mjs';\n");
  write(sub, 'import-only.mjs', 'export const importOnly = true;\n');
  write(sub, 'runtime.mjs', "export const value = 1; import('./cycle.mjs');\n");
  write(sub, 'cycle.mjs', "import './runtime.mjs';\n");
  git(sub, ['add', '.']); git(sub, ['commit', '-qm', 'runtime entry and transitive cycle']);
  write(repo, testPath, "import './entry';\n");
  write(repo, 'packages/core/entry.ts', "export { value } from '@papercusp/core';\n");
  write(repo, 'node_modules/@papercusp/.keep', '');
  symlinkSync(sub, join(repo, 'node_modules/@papercusp/core'), 'dir');
  git(repo, ['add', testPath, 'packages/core/entry.ts', 'libs/papercusp']);
  git(repo, ['commit', '-qm', 'proof and pinned runtime']);
  return { repo, sub };
}

describe('P037 maintained source admission', () => {
  it('walks transitive workspace runtime exports, declarations, dynamic literals and cycles', async () => {
    const { repo } = fixture();
    const receipt = await qualifySyncLintProofInputs({ repo, roots: [testPath] });
    expect(receipt).toMatchObject({ qualification: 'qualified', unresolved: [], workingDrift: [], refusal: null });
    expect(receipt).toMatchObject({ validationRefusal: null, stabilityRefusal: null,
      workingHashMismatches: [], finalWorkingHashes: receipt.workingHashes, finalReadErrors: {} });
    expect(receipt.paths).toEqual(expect.arrayContaining([testPath, 'packages/core/entry.ts',
      'libs/papercusp/index.d.ts', runtimePath, 'libs/papercusp/cycle.mjs',
      'libs/papercusp/import.mjs', 'libs/papercusp/import-only.mjs',
      'libs/papercusp/package.json', 'package-lock.json']));
    expect(receipt.paths).not.toContain('libs/papercusp/index.mjs');
    expect(new Set(receipt.paths).size).toBe(receipt.paths.length);
  });

  it.each([
    { name: 'changed bytes after successful validation', dirty: false, remove: false },
    { name: 'changed bytes after refused validation', dirty: true, remove: false },
    { name: 'unreadable input after refused validation', dirty: true, remove: true },
  ])('retains distinct final evidence for $name', async ({ dirty, remove }) => {
    const { repo, sub } = fixture();
    const initial = dirty ? 'export const value = 2;\n' : "export const value = 1; import('./cycle.mjs');\n";
    const final = 'export const value = 3;\n';
    if (dirty) write(sub, 'runtime.mjs', initial);
    const validate = sourcePreview.validateVerifierInputs;
    // Run the real validator, then change the fixture at its awaited boundary.
    // This reproduces both original causes without racing a background writer.
    const validation = vi.spyOn(sourcePreview, 'validateVerifierInputs').mockImplementationOnce(async args => {
      try { return await validate(args); }
      finally {
        if (remove) rmSync(join(repo, runtimePath));
        else write(sub, 'runtime.mjs', final);
      }
    });
    const receipt = await qualifySyncLintProofInputs({ repo, roots: [testPath] });
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(validation).toHaveBeenCalledOnce();
    expect(receipt.headAfter).toBe(receipt.headStart);
    expect(receipt).toMatchObject({ qualification: 'refused', workingDrift: [runtimePath],
      refusal: 'source changed during qualification', stabilityRefusal: 'source changed during qualification',
      validationRefusal: dirty ? expect.stringContaining('dirty tested-input mismatch: ' + runtimePath) : null });
    expect(receipt.workingHashes[runtimePath]).toBe(digest(initial));
    expect(Object.keys(receipt.finalWorkingHashes).sort()).toEqual(receipt.paths);
    expect(receipt.finalWorkingHashes[runtimePath]).toBe(remove ? null : digest(final));
    expect(receipt.workingHashMismatches).toEqual(remove ? [] : [runtimePath]);
    if (remove) {
      expect(Object.keys(receipt.finalReadErrors)).toEqual([runtimePath]);
      expect(receipt.finalReadErrors[runtimePath]).toMatchObject({ name: 'Error', code: 'ENOENT',
        message: expect.stringContaining(join(repo, runtimePath)) });
    } else expect(receipt.finalReadErrors).toEqual({});
  });

  it('does not admit inactive generated require/default exports but refuses them when require is active', async () => {
    const { repo, sub } = fixture();
    write(sub, 'package.json', JSON.stringify({ name: '@papercusp/core', type: 'module', exports: {
      '.': { types: './index.d.ts', import: './import.mjs', require: './dist/index.cjs', default: './dist/index.cjs' },
      './types-only': { types: './index.d.ts', import: './dist/types-only.mjs' },
      './nested': { node: { require: './dist/index.cjs' }, import: './import.mjs' },
    } }));
    git(sub, ['add', 'package.json']); git(sub, ['commit', '-qm', 'conditional runtime exports']);
    write(repo, testPath, "import './entry'; import '@papercusp/core/nested'; import type { value } from '@papercusp/core/types-only';\n");
    git(repo, ['add', testPath, 'libs/papercusp']); git(repo, ['commit', '-qm', 'pin conditional exports']);
    write(sub, 'dist/index.cjs', 'exports.value = 99;\n');
    write(sub, 'dist/types-only.mjs', 'export const value = 99;\n');
    write(sub, 'index.js', 'export const value = 99;\n');
    const imported = await qualifySyncLintProofInputs({ repo, roots: [testPath] });
    expect(imported).toMatchObject({ qualification: 'qualified', unresolved: [] });
    expect(imported.paths.some(path => path.includes('/dist/'))).toBe(false);
    expect(imported.paths).not.toContain('libs/papercusp/index.js');
    expect(imported.imports).toContainEqual(expect.objectContaining({
      spec: '@papercusp/core/types-only', mode: 'types', path: 'libs/papercusp/index.d.ts',
    }));

    write(repo, testPath, "import './entry'; const runtime = require('@papercusp/core');\n");
    git(repo, ['add', testPath]); git(repo, ['commit', '-qm', 'activate require runtime']);
    const required = await qualifySyncLintProofInputs({ repo, roots: [testPath] });
    expect(required.paths).toContain('libs/papercusp/dist/index.cjs');
    expect(required).toMatchObject({ qualification: 'refused',
      refusal: expect.stringContaining('tested input is not a regular committed file: dist/index.cjs') });
  });

  it('resolves workspace subpaths without an exports map and retains CommonJS static-import runtime', async () => {
    const { repo, sub } = fixture();
    write(sub, 'package.json', JSON.stringify({ name: '@papercusp/core', type: 'module',
      main: './index.mjs', types: './index.d.ts' }));
    write(sub, 'legacy.d.ts', 'export declare const value: number;\n');
    write(sub, 'legacy.js', 'export const value = 1;\n');
    write(repo, testPath, "import { value } from '@papercusp/core/legacy.js';\n");
    git(sub, ['add', 'package.json', 'legacy.d.ts', 'legacy.js']); git(sub, ['commit', '-qm', 'legacy package entrypoints']);
    git(repo, ['add', testPath, 'libs/papercusp']); git(repo, ['commit', '-qm', 'legacy package subpath']);
    expect(await qualifySyncLintProofInputs({ repo, roots: [testPath] })).toMatchObject({
      qualification: 'qualified', unresolved: [] });
    write(sub, 'legacy.js', 'export const value = 2;\n');
    expect(await qualifySyncLintProofInputs({ repo, roots: [testPath] })).toMatchObject({
      qualification: 'refused', refusal: expect.stringContaining('dirty tested-input mismatch: libs/papercusp/legacy.js') });

    write(sub, 'package.json', JSON.stringify({ name: '@papercusp/core', exports: {
      '.': { types: './index.d.ts', import: './import.mjs', require: './dist/index.cjs' },
    } }));
    write(sub, 'dist/index.cjs', 'exports.value = 99;\n');
    write(repo, 'packages/core/proof.cts', "import runtime from '@papercusp/core';\n");
    git(sub, ['add', 'package.json']); git(sub, ['commit', '-qm', 'conditional CJS entry']);
    git(repo, ['add', 'packages/core/proof.cts', 'libs/papercusp']); git(repo, ['commit', '-qm', 'CJS static import']);
    expect(await qualifySyncLintProofInputs({ repo, roots: ['packages/core/proof.cts'] })).toMatchObject({
      qualification: 'refused', refusal: expect.stringContaining('dist/index.cjs') });
  });

  it('refuses dirty runtime even when the named test is clean and rejects nested HEAD beyond the parent pin', async () => {
    const { repo, sub } = fixture();
    write(sub, 'runtime.mjs', 'export const value = 2;\n');
    const head = git(repo, ['rev-parse', 'HEAD']);
    await expect(validateVerifierInputs({ repo, ref: head, inputs: [testPath] })).resolves.toMatchObject({ sha: head });
    expect(await qualifySyncLintProofInputs({ repo, roots: [testPath] })).toMatchObject({
      qualification: 'refused', refusal: expect.stringContaining('dirty tested-input mismatch: ' + runtimePath) });
    git(sub, ['add', 'runtime.mjs']); git(sub, ['commit', '-qm', 'nested runtime advances without parent pin']);
    expect(await qualifySyncLintProofInputs({ repo, roots: [testPath] })).toMatchObject({
      qualification: 'refused', refusal: expect.stringContaining('dirty tested-input mismatch: ' + runtimePath) });
  });

  it('refuses an unresolved local edge instead of qualifying an incomplete population', async () => {
    const { repo } = fixture();
    write(repo, 'packages/core/entry.ts', "import './missing-runtime';\n");
    git(repo, ['add', 'packages/core/entry.ts']); git(repo, ['commit', '-qm', 'unresolvable input']);
    expect(await qualifySyncLintProofInputs({ repo, roots: [testPath] })).toMatchObject({
      qualification: 'refused', unresolved: [{ from: 'packages/core/entry.ts', spec: './missing-runtime' }],
      refusal: expect.stringContaining('unresolved local imports') });
  });

  it('includes the observed tooldef runtime and the real Vitest setup boundary from maintained roots', () => {
    const repo = resolve(import.meta.dirname, '../../../..');
    const roots = syncLintProofRoots(repo);
    const boundaryRoots = ['libs/generic/tooldef/src/code-orchestration/run-script.ts',
      'packages/operator-core/vitest.config.ts', 'scripts/lib/task-cgroup-limits.mjs',
      'scripts/lib/task-cgroup-limits.d.mts'];
    expect(roots).toEqual(expect.arrayContaining(boundaryRoots));
    // The full maintained census is an admission command, not a unit-test
    // dependency on every module in a changing monorepo. Exercise its observed
    // runtime/config boundary here; fixtures above exercise traversal rules.
    const closure = collectVerifierInputClosure(repo, boundaryRoots);
    expect(closure.paths).toEqual(expect.arrayContaining([
      'libs/generic/tooldef/src/code-orchestration/run-script.ts',
      'libs/generic/tooldef/src/code-orchestration/tool-facade.ts',
      'libs/generic/tooldef/package.json',
      'packages/operator-core/lib/detached-imports/setup-vitest.ts',
      'scripts/lib/task-cgroup-limits.mjs', 'scripts/lib/task-cgroup-limits.d.mts',
    ]));
    expect(closure.unresolved).toEqual([]);
  }, 30_000);
});
