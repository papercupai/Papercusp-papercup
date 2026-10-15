/**
 * WI-10005290 — gen:declarations must report an importer's `@ts-expect-error` that a published
 * declaration made stale (TS2578), instead of leaving it to surface at the next typecheck.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { staleSuppressionsIn } from '../../../scripts/gen-declarations.ts';
import { importerSources, staleDeclarationSuppressions } from '../../../scripts/lib/stale-declaration-suppressions.ts';

const MODULE = 'scripts/lib/fx.mjs';
const sources = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe('staleDeclarationSuppressions', () => {
  it('reports an @ts-expect-error directly above an import of a declared module', () => {
    const found = staleDeclarationSuppressions(
      [MODULE],
      sources({
        'packages/a/x.ts': [
          "import { readFileSync } from 'node:fs';",
          '// @ts-expect-error -- plain-JS module, no declaration file',
          "import { f } from '../../scripts/lib/fx.mjs';",
        ].join('\n'),
      }),
    );
    expect(found).toEqual([
      {
        file: 'packages/a/x.ts',
        line: 2,
        module: MODULE,
        directive: '// @ts-expect-error -- plain-JS module, no declaration file',
      },
    ]);
  });

  it('covers the specifier line of a multi-line import and a dynamic import', () => {
    const found = staleDeclarationSuppressions(
      [MODULE],
      sources({
        'scripts/b.mts': [
          'import {',
          '  f,',
          '  // @ts-expect-error -- no declaration',
          "} from './lib/fx.mjs';",
          '// @ts-expect-error -- no declaration',
          "const m = await import('./lib/fx.mjs');",
        ].join('\n'),
      }),
    );
    expect(found.map((problem) => problem.line)).toEqual([3, 5]);
  });

  it('ignores @ts-ignore, undeclared modules, same-basename modules elsewhere, gaps, and declaration files', () => {
    const found = staleDeclarationSuppressions(
      [MODULE],
      sources({
        'packages/a/ignore.ts': "// @ts-ignore -- not checked for use\nimport { f } from '../../scripts/lib/fx.mjs';",
        'packages/a/other.ts': "// @ts-expect-error -- still undeclared\nimport { g } from '../../scripts/lib/other.mjs';",
        'packages/a/elsewhere.ts': "// @ts-expect-error -- different fx\nimport { f } from '../../tools/fx.mjs';",
        'packages/a/gap.ts': "// @ts-expect-error -- not adjacent\n\nimport { f } from '../../scripts/lib/fx.mjs';",
        'scripts/lib/fx.d.mts': "// @ts-expect-error -- declarations import nothing\nexport * from './fx.mjs';",
        'docs/readme.md': "// @ts-expect-error\nimport { f } from '../scripts/lib/fx.mjs';",
      }),
    );
    expect(found).toEqual([]);
  });
});

describe('importerSources', () => {
  it('lists tracked importers through git grep, and says null (not measured) outside a git checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-stale-suppressions-'));
    try {
      expect(importerSources(root, [MODULE])).toBeNull();

      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write(MODULE, 'export const f = 1;\n');
      write('packages/a/x.ts', "// @ts-expect-error -- no declaration\nimport { f } from '../../scripts/lib/fx.mjs';\n");
      write('packages/a/unrelated.ts', 'export const y = 2;\n');
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-C', root, 'add', '-A']);

      const listed = importerSources(root, [MODULE]);
      expect([...(listed?.keys() ?? [])]).toEqual(['packages/a/x.ts']);
      expect(staleSuppressionsIn(root, [MODULE])).toEqual([
        expect.objectContaining({ file: 'packages/a/x.ts', line: 1, module: MODULE }),
      ]);
      // A real "no importer" answer is an empty list, distinguishable from null.
      expect(importerSources(root, ['scripts/lib/nobody-imports-me.mjs'])).toEqual(new Map());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the real tree', () => {
  it('has no @ts-expect-error guarding an import of a module enrolled in gen:declarations', () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const config = readFileSync(join(repoRoot, 'tsconfig.declarations.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const modules = (JSON.parse(config) as { files: string[] }).files;
    expect(modules.length).toBeGreaterThan(0);
    const stale = staleSuppressionsIn(repoRoot, modules);
    expect(stale, 'importers could not be listed — the scan did not run').not.toBeNull();
    expect(stale).toEqual([]);
  });
});
