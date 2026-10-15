import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Exercise the installed upstream implementation rather than copying its
// predicate. Committed-tree tests share dependency bytes outside their root.
const packageRoot = dirname(createRequire(import.meta.url).resolve('vitest/package.json'));
const chunk = readdirSync(join(packageRoot, 'dist/chunks')).find(name => /^startVitestModuleRunner\..*\.js$/.test(name));
if (!chunk) throw Error('Installed Vitest module runner chunk is absent');
const source = readFileSync(join(packageRoot, 'dist/chunks', chunk), 'utf8');
const implementation = source.match(/function getCachedVitestImport\(id, state\) \{[\s\S]*?\n\}/)?.[0];
if (!implementation) throw Error('Installed Vitest cached-import implementation changed; review its patch');

function cachedImport(distDir: string, root: string, id: string, code = implementation!) {
  const resolveImport = new Function('distDir', 'normalizedDistDir', 'relativeIds', 'externalizeMap',
    'bareVitestRegexp', 'pathToFileURL', 'join', code + '\nreturn getCachedVitestImport;')(
    distDir, distDir, {}, new Map(), /^(?:vitest|@vitest\/)/, pathToFileURL, join);
  return resolveImport(id, () => ({ config: { root } }));
}

describe('Vitest shared dependency root resolution', () => {
  const shared = '/build/shared/node_modules/vitest/dist';
  // A distinct root of this length used to produce the unrelated suffix /dist.
  const clone = '/tmp/clone-'.padEnd(shared.lastIndexOf('/dist'), 'x');

  it('does not externalize dist-prefixed project sources when Vitest is outside the root', () => {
    expect(shared.slice(clone.length)).toBe('/dist');
    for (const id of ['/dist-atomic-writes', '/dist-wipe-guard', '/dist/project-source'])
      expect(cachedImport(shared, clone, id), id).toBeNull();
  });

  it('requires an ancestor directory boundary rather than a shared text prefix', () => {
    expect(cachedImport('/tmp/project-other/node_modules/vitest/dist', '/tmp/project',
      '-other/node_modules/vitest/dist/index.js')).toBeNull();
  });

  it('still externalizes real Vitest imports while rejecting neighboring project module prefixes', () => {
    const root = '/work/project';
    const dist = root + '/node_modules/vitest/dist';
    expect(cachedImport(dist, root, '/node_modules/vitest/dist/index.js')?.externalize)
      .toBe(pathToFileURL(dist + '/index.js').href);
    expect(cachedImport(dist, root, '/node_modules/vitest/dist-example')).toBeNull();
    expect(cachedImport(shared, clone, shared + '/index.js')?.externalize)
      .toBe(pathToFileURL(shared + '/index.js').href);
    expect(cachedImport(shared, clone, 'vitest')?.externalize).toBe('vitest');
  });

  it('the original unchecked root slice reproduces the exact clone failure', () => {
    const original = implementation!.replace(
      'normalizedDistDir.startsWith(root + "/") ? normalizedDistDir.slice(root.length) : ""',
      'normalizedDistDir.slice(root.length)',
    ).replace('id.startsWith(relativeRoot + "/")', 'id.startsWith(relativeRoot)');
    expect(cachedImport(shared, clone, '/dist-wipe-guard', original)?.externalize)
      .toBe(pathToFileURL(join(clone, '/dist-wipe-guard')).href);
  });
});
