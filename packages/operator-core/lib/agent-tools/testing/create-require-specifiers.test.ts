import { describe, expect, it } from 'vitest';
import { createRequireSpecifiers, unfollowableImportCall } from './create-require-specifiers';

describe('unfollowableImportCall', () => {
  it.each([
    ["import(/* c */ 'pkg'); require(`./x`); __require('y');", null],
    ["const s = 'import(name) and require(x)'; // import(y)\n", null],
    ['export const f = (n: string) => import(n);', 'non-literal import() (line 1)'],
    ['export const f = (n: string) => import(`./${n}.ts`);', 'non-literal import() (line 1)'],
    ['\nexport const f = (n: string) => require(n);', 'non-literal require() (line 2)'],
  ])('%s → %s', (text, expected) => {
    expect(unfollowableImportCall('mod.ts', text)).toBe(expected);
  });
});

const IMPORT = "import { createRequire } from 'node:module';\n";
const analyse = (body: string, file = 'mod.ts') => createRequireSpecifiers(file, IMPORT + body);

describe('createRequireSpecifiers (EI-24556278753778650)', () => {
  it('returns null for a file with no createRequire at all', () => {
    expect(createRequireSpecifiers('mod.ts', "export const x = require('y');\n")).toBeNull();
  });

  it('follows the lazy nodeRequire wrapper idiom used by libs/db connection.ts', () => {
    const result = analyse([
      'let _nodeRequire: ReturnType<typeof createRequire> | undefined;',
      'const nodeRequire = (id: string): unknown =>',
      '  (_nodeRequire ??= createRequire(import.meta.url))(id);',
      "export const fs = () => nodeRequire('node:fs') as typeof import('node:fs');",
      "export const os = () => nodeRequire('node:os');",
    ].join('\n'));
    expect(result).toEqual({ status: 'ok', specifiers: ['node:fs', 'node:os'] });
  });

  it('follows direct, bound, .resolve and aliased-import loaders', () => {
    expect(analyse("const { DateTime } = createRequire(import.meta.url)('luxon');\n"))
      .toEqual({ status: 'ok', specifiers: ['luxon'] });
    expect(analyse("const req = createRequire(import.meta.url);\nexport const a = req('./a');\nexport const b = req.resolve(`./b`);\n"))
      .toEqual({ status: 'ok', specifiers: ['./a', './b'] });
    expect(createRequireSpecifiers('mod.mjs', "import { createRequire as cr } from 'node:module';\nconst r = cr(import.meta.url);\nr('./c.cjs');\n"))
      .toEqual({ status: 'ok', specifiers: ['./c.cjs'] });
    expect(createRequireSpecifiers('mod.mjs', "import * as m from 'node:module';\nm.createRequire(import.meta.url)('./d');\n"))
      .toEqual({ status: 'ok', specifiers: ['./d'] });
  });

  it('ignores a runtime typeof feature check and follows its guarded loader without treating cache reads as loads', () => {
    const result = analyse([
      "const require = (typeof createRequire === 'function'",
      '  ? createRequire(import.meta.url)',
      '  : undefined) as NodeRequire;',
      "require('node:fs');",
      'Object.keys(require.cache);',
    ].join('\n'));
    expect(result).toEqual({ status: 'ok', specifiers: ['node:fs'] });
  });

  it('ignores createRequire mentioned only in comments and strings', () => {
    expect(createRequireSpecifiers('mod.ts', "// deliberately not `createRequire(import.meta.url)(…)`\nexport const s = 'createRequire(x)(y)';\n"))
      .toEqual({ status: 'ok', specifiers: [] });
  });

  it.each([
    ['a non-literal direct call', 'export const load = (name: string) => createRequire(import.meta.url)(name + ".js");\n'],
    ['a bound loader called with a variable', 'const req = createRequire(import.meta.url);\nexport const load = (n: string) => req(n);\n'],
    ['an exported wrapper (outside callers are invisible)', "export const load = (id: string) => createRequire(import.meta.url)(id);\nload('node:fs');\n"],
    ['a wrapper called with a non-literal', "const load = (id: string) => createRequire(import.meta.url)(id);\nexport const f = (n: string) => load(n);\n"],
    ['a wrapper that escapes as a value', "const load = (id: string) => createRequire(import.meta.url)(id);\nexport const table = { load };\n"],
    ['a reassigned wrapper parameter', "const load = (id: string) => { id = './' + id; return createRequire(import.meta.url)(id); };\nload('x');\n"],
    ['an exported loader', 'export const req = createRequire(import.meta.url);\n'],
    ['a loader passed as a value', 'const req = createRequire(import.meta.url);\nexport const use = (f: unknown) => f;\nuse(req);\n'],
    ['the factory referenced as a value', 'export const factory = createRequire;\n'],
    ['a loader rebound to something else', "let req = createRequire(import.meta.url);\nreq = (x: string) => x as never;\nreq('a');\n"],
  ])('is unfollowable for %s', (_label, body) => {
    expect(analyse(body)).toMatchObject({ status: 'unfollowable' });
  });
});
