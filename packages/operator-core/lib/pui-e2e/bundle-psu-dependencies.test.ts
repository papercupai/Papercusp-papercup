import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JavaScript helper has no declaration; this test asserts its runtime behavior.
import { lockedPackageKeyResolver, releaseMinification } from '../../../../apps/tui/scripts/bundle-psu-dependencies.mjs';

const temporary: string[] = [];
const fixture = () => {
  const work = mkdtempSync(path.join(tmpdir(), 'pui-dependency-keys-'));
  temporary.push(work);
  const root = path.join(work, 'snapshot');
  const installed = path.join(work, 'dependency-generation');
  mkdirSync(root);
  mkdirSync(installed);
  const link = (key: string, target: string) => {
    const at = path.join(root, key);
    mkdirSync(path.dirname(at), { recursive: true });
    symlinkSync(target, at, 'dir');
  };
  return { root, installed, link };
};

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('PUI bundler locked dependency identity', () => {
  test('release bundles omit external module labels while preserving runtime function and class names', async () => {
    const { root, installed, link } = fixture();
    const library = path.join(installed, 'library');
    mkdirSync(library);
    writeFileSync(path.join(library, 'index.js'),
      "function registeredStep() { return 'ok'; } class Worker {} module.exports = { registeredStep, Worker };\n");
    link('node_modules/library', library);
    const options = {
      stdin: { contents: "module.exports = require('library');", resolveDir: root },
      absWorkingDir: root, platform: 'node' as const, format: 'cjs' as const,
      bundle: true, write: false,
    };
    const result = await build({ ...options, ...releaseMinification });
    const code = result.outputFiles![0]!.text;
    expect(code).not.toContain(installed);
    expect(code).not.toContain(path.relative(root, installed));
    const module = { exports: {} as { registeredStep: () => string; Worker: { name: string } } };
    runInNewContext(code, { module, exports: module.exports });
    expect(module.exports.registeredStep.name).toBe('registeredStep');
    expect(module.exports.Worker.name).toBe('Worker');
    expect(module.exports.registeredStep()).toBe('ok');
    // Control: the old minification retains the physical dependency label.
    const prior = await build({ ...options, ...releaseMinification, minifyIdentifiers: false });
    expect(prior.outputFiles![0]!.text).toContain(path.relative(root, installed));
  });

  test('resolves an installed package inside the source tree', () => {
    const { root } = fixture();
    const key = 'node_modules/esbuild';
    mkdirSync(path.join(root, key), { recursive: true });
    expect(lockedPackageKeyResolver(root, { [key]: { version: '1.0.0' } })(path.join(root, key))).toBe(key);
  });

  test('resolves external scoped and nested packages through their locked snapshot links', () => {
    const { root, installed, link } = fixture();
    const scoped = path.join(installed, 'pty');
    const nested = path.join(installed, 'vitest', 'node_modules', 'vite');
    mkdirSync(scoped);
    mkdirSync(nested, { recursive: true });
    link('node_modules/@lydell/node-pty', scoped);
    link('node_modules/vitest', path.join(installed, 'vitest'));
    const keys = ['node_modules/@lydell/node-pty', 'node_modules/vitest/node_modules/vite'];
    const resolve = lockedPackageKeyResolver(root, Object.fromEntries(keys.map((key) => [key, { version: '1.0.0' }])));
    expect(resolve(scoped)).toBe(keys[0]);
    expect(resolve(nested)).toBe(keys[1]);
  });

  test('refuses an outside package with no locked install link, even when its basename matches', () => {
    const { root, installed, link } = fixture();
    const locked = path.join(installed, 'locked', 'esbuild');
    const unrelated = path.join(installed, 'unrelated', 'esbuild');
    mkdirSync(locked, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    link('node_modules/esbuild', locked);
    const resolve = lockedPackageKeyResolver(root, { 'node_modules/esbuild': { version: '1.0.0' } });
    expect(() => resolve(unrelated)).toThrow('not reachable through a locked install path');
  });

  test('refuses unregistered and dangling install links', () => {
    const { root, installed, link } = fixture();
    link('node_modules/unregistered', installed);
    link('node_modules/missing', path.join(installed, 'missing'));
    const resolve = lockedPackageKeyResolver(root, { 'node_modules/missing': { version: '1.0.0' } });
    expect(() => resolve(installed)).toThrow('not reachable through a locked install path');
  });

  test('refuses workspace links and ambiguous aliases instead of choosing a version pin', () => {
    const { root, installed, link } = fixture();
    link('node_modules/workspace', installed);
    expect(() => lockedPackageKeyResolver(root, { 'node_modules/workspace': { link: true } })(installed))
      .toThrow('not reachable through a locked install path');
    link('node_modules/first', installed);
    link('node_modules/second', installed);
    expect(() => lockedPackageKeyResolver(root, {
      'node_modules/first': { version: '1.0.0' }, 'node_modules/second': { version: '2.0.0' },
    })(installed)).toThrow('ambiguous lock paths');
  });
});
