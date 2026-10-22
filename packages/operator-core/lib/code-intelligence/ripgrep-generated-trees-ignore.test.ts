/**
 * EI-25828526343827983 and EI-21268880111402550 — generated trees stay out of ripgrep/fd walks
 * from every search root an agent commonly uses.
 *
 * ripgrep (measured 14.1.0 and 14.1.1) applies an anchored ignore pattern from a file
 * ABOVE the search root only to that root's immediate children. The root `.gitignore`
 * entry `apps/operator-docs/dist/` was therefore honored from the repo root but skipped
 * from `apps`, and `rg -n -F <identifier> apps packages libs` returned ~600 MB of
 * minified HTML (operator-docs/dist plus the tracked apps/operator/public/internal/docs).
 * The fix puts a `.ignore` beside each generated tree.
 *
 * This test copies the COMMITTED ignore files into a fixture with the same layout, so it
 * checks their content against real ripgrep regardless of whether the generated trees
 * exist in this checkout (dist is gitignored and absent in a clean clone).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** The committed ignore files, at their repo-relative paths. */
const IGNORE_FILES = ['.ignore', 'apps/operator/.ignore', 'apps/operator-docs/.ignore'];

/** Generated files that must never appear in a default walk. */
const GENERATED = [
  'apps/operator-docs/dist/agent-insights/index.html',
  'apps/operator/public/internal/docs/system/repo-conventions/index.html',
  'libs/generic/papergrid/grid-core/storybook-static/index.json',
];

/** Source files beside them that must still be found (positive control). */
const SOURCE = [
  'apps/operator-docs/src/content/docs/index.mdx',
  'apps/operator/public/favicon.svg',
  'apps/operator/lib/example.ts',
  'libs/generic/papergrid/grid-core/src/index.ts',
];

const ROOTS = [
  '.',
  'apps',
  'apps/operator',
  'apps/operator-docs',
  'libs',
  'libs/generic/papergrid',
  'libs/generic/papergrid/grid-core',
];

const rgAvailable = spawnSync('rg', ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!rgAvailable)('ripgrep skips generated trees from every search root (EI-25828526343827983)', () => {
  let fixture = '';

  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), 'rg-generated-trees-'));
    for (const rel of IGNORE_FILES) {
      const dest = join(fixture, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(REPO_ROOT, rel), dest);
    }
    for (const rel of [...GENERATED, ...SOURCE]) {
      const dest = join(fixture, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, 'session_turn_parts\n');
    }
  });

  afterAll(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  function rgFiles(target: string): string[] {
    const result = spawnSync('rg', ['--no-config', '--files', target], { cwd: fixture, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((path) => path.replace(/^\.\//, ''));
  }

  it.each(ROOTS)('root %s lists no generated output file', (root) => {
    expect(rgFiles(root).filter((path) => GENERATED.includes(path))).toEqual([]);
  });

  it.each(ROOTS)('root %s still lists the source files under it', (root) => {
    const expected = SOURCE.filter((path) => root === '.' || path.startsWith(`${root}/`));
    expect(expected.length).toBeGreaterThan(0);
    expect(rgFiles(root)).toEqual(expect.arrayContaining(expected));
  });

  it('still searches a generated file that is named explicitly', () => {
    for (const path of GENERATED) expect(rgFiles(path)).toEqual([path]);
  });
});
