/**
 * plan-reuse-and-library-declarations-2026-10-20 R-6 (D-013 #4): the completion
 * ship check. Decision cases run against fixture files with an injected import
 * search; one case runs the provisioned ast-grep binary over the same fixtures so
 * the pattern list itself is pinned against the real grammar.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAstGrepArgs, parseAstGrepMatches, resolveAstGrepBin } from '../../code-intelligence/ast-grep-facade';
import type { LibrariesDeclaration, ReuseDeclaration } from './plan-declarations';
import { indexDeclaredPackages, readWorkspaceManifests } from '../../workspace-manifests';
import {
  classifySpecifier,
  dependencyBaselineFrom,
  importLanguageFor,
  readJsImports,
  runLibraryShipCheck,
  specifierFromImportText,
  type ImportSearch,
} from './plan-library-ship-check';

const FIXTURE_TS = [
  "import a from 'pkg-default';",
  "import { b } from '@scope/named/sub';",
  "import * as fs from 'node:fs';",
  "import 'side-effect';",
  "import type { T } from 'type-only';",
  "export { d } from 'reexport';",
  'export * from "star-export";',
  "export * as ns from 'star-ns';",
  "export type { U } from 'type-re';",
  "const r = require('cjs-req');",
  "const m = await import('dyn-imp');",
  "const s = \"import x from 'in-string'\";",
  "// import y from 'in-comment'",
  "import local from './local';",
  "import { shared } from '@papercusp/shared-lib';",
  '',
].join('\n');

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ship-check-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/all-forms.ts'), FIXTURE_TS);
  writeFileSync(join(root, 'src/uses-yaml.ts'), "import { parse } from 'yaml';\nexport const gate = parse('a: 1');\n");
  writeFileSync(join(root, 'src/uses-left-pad.ts'), "import pad from 'left-pad';\nexport const padded = pad('x', 3);\n");
  writeFileSync(join(root, 'src/readme.md'), '# readme\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A search that answers from a fixed site table, so the decision logic is measured alone. */
function fixedSearch(sites: Record<string, Array<{ path: string; line1: number; detail: string }>>): ImportSearch {
  return async ({ pattern, paths }) => ({
    sites: (sites[pattern] ?? []).filter((site) => paths.includes(site.path)).map((site) => ({ ...site, kind: 'match' })),
    error: null,
    truncation: { truncated: false, totalAvailable: null, continuation: null },
  });
}

const IMPORT = 'import $$$ from $S';

const libraries = (packages: string[]): LibrariesDeclaration => ({
  needs: packages.map((pkg) => ({ need: `use ${pkg}`, decision: 'already-in-project' as const, package: pkg, existingUse: 'elsewhere' })),
  notApplicable: null,
}) as LibrariesDeclaration;

const baseline = (packages: string[]) => ({ packages, manifests: 1, capturedAt: '2026-10-20T00:00:00.000Z' });

describe('R-3 native library evidence', () => {
  it('never executes dependency workloads', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'native-library-readonly-'));
    try {
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { 'fixture-dep': '1' },
        scripts: { prepare: 'node -e "require(\'fs\').writeFileSync(\'native-workload-started\',\'bad\')"' } }));
      writeFileSync(join(fixture, 'gradlew'), '#!/bin/sh\n: > native-workload-started\n', { mode: 0o755 });
      writeFileSync(join(fixture, 'build.rs'), 'fn main() { std::fs::write("native-workload-started", b"bad").unwrap(); }');
      const manifests = await readWorkspaceManifests(fixture);
      expect(indexDeclaredPackages(manifests).isDependency('fixture-dep')).toBe(true);
      expect(existsSync(join(fixture, 'native-workload-started'))).toBe(false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});

describe('ship check — import parsing (R-6)', () => {
  it('extracts the specifier from every JS/TS import form and ignores non-literal calls', () => {
    expect(specifierFromImportText("import a from 'pkg-default';")).toBe('pkg-default');
    expect(specifierFromImportText("import { b, c } from '@scope/named/sub';")).toBe('@scope/named/sub');
    expect(specifierFromImportText("import 'side-effect';")).toBe('side-effect');
    expect(specifierFromImportText('export * from "star-export";')).toBe('star-export');
    expect(specifierFromImportText("import data from 'cfg' with { type: 'json' };")).toBe('cfg');
    expect(specifierFromImportText("require('cjs-req')")).toBe('cjs-req');
    expect(specifierFromImportText("import('dyn-imp')")).toBe('dyn-imp');
    expect(specifierFromImportText('import(name)')).toBeNull();
    expect(specifierFromImportText('require(`${dir}/x`)')).toBeNull();
  });

  it('classifies relative, builtin, alias, workspace and third-party specifiers, normalising subpaths', () => {
    const workspace = new Set(['@papercusp/shared-lib']);
    expect(classifySpecifier('./local', workspace).kind).toBe('relative');
    expect(classifySpecifier('node:fs', workspace).kind).toBe('builtin');
    expect(classifySpecifier('fs/promises', workspace).kind).toBe('builtin');
    expect(classifySpecifier('@/components/x', workspace).kind).toBe('alias');
    expect(classifySpecifier('virtual:pwa', workspace).kind).toBe('alias');
    expect(classifySpecifier('@papercusp/shared-lib/sub', workspace)).toEqual({ kind: 'workspace', package: '@papercusp/shared-lib' });
    expect(classifySpecifier('lodash/fp', workspace)).toEqual({ kind: 'third-party', package: 'lodash' });
    expect(classifySpecifier('@scope/pkg/sub', workspace)).toEqual({ kind: 'third-party', package: '@scope/pkg' });
  });

  it('maps JS/TS extensions to grammars and nothing else', () => {
    expect(importLanguageFor('a/b.ts')).toBe('ts');
    expect(importLanguageFor('a/b.d.ts')).toBe('ts');
    expect(importLanguageFor('a/b.tsx')).toBe('tsx');
    expect(importLanguageFor('a/b.mjs')).toBe('js');
    expect(importLanguageFor('a/b.rs')).toBeNull();
    expect(importLanguageFor('a/README.md')).toBeNull();
  });

  it('reads a baseline only from an activation payload that recorded one', () => {
    expect(dependencyBaselineFrom(null)).toBeNull();
    expect(dependencyBaselineFrom({ declarationsCheck: { enforced: true } })).toBeNull();
    expect(dependencyBaselineFrom({ declarationsCheck: { dependencyBaseline: baseline(['yaml']) } })?.packages).toEqual(['yaml']);
  });
});

describe('ship check — decision (R-6)', () => {
  it('refuses a third-party package that is neither declared nor a dependency at activation', async () => {
    const report = await runLibraryShipCheck({
      files: ['src/uses-left-pad.ts', 'src/uses-yaml.ts'],
      repoRoot: root,
      libraries: libraries([]),
      reuse: null,
      baseline: baseline(['yaml']),
      workspacePackages: new Set(),
      search: fixedSearch({ [IMPORT]: [
        { path: 'src/uses-left-pad.ts', line1: 1, detail: "import pad from 'left-pad';" },
        { path: 'src/uses-yaml.ts', line1: 1, detail: "import { parse } from 'yaml';" },
      ] }),
    });
    expect(report.status).toBe('refuse');
    expect(report.blockers).toEqual([{ code: 'undeclared_third_party_package', package: 'left-pad', files: ['src/uses-left-pad.ts'] }]);
    expect(report.packages).toEqual(expect.arrayContaining([
      { package: 'yaml', admittedBy: 'activation-baseline', files: ['src/uses-yaml.ts'] },
    ]));
  });

  it('admits a package declared in the libraries section, matching by normalised name', async () => {
    const report = await runLibraryShipCheck({
      files: ['src/uses-left-pad.ts'],
      repoRoot: root,
      libraries: libraries(['left-pad']),
      reuse: null,
      baseline: baseline([]),
      workspacePackages: new Set(),
      search: fixedSearch({ [IMPORT]: [{ path: 'src/uses-left-pad.ts', line1: 1, detail: "import pad from 'left-pad/sub';" }] }),
    });
    expect(report).toMatchObject({ status: 'pass', blockers: [] });
    expect(report.packages).toEqual([{ package: 'left-pad', admittedBy: 'libraries-section', files: ['src/uses-left-pad.ts'] }]);
  });

  it('reports unverified, never refuses, when the activation recorded no baseline', async () => {
    const report = await runLibraryShipCheck({
      files: ['src/uses-left-pad.ts'],
      repoRoot: root,
      libraries: null,
      reuse: null,
      baseline: null,
      workspacePackages: new Set(),
      search: fixedSearch({ [IMPORT]: [{ path: 'src/uses-left-pad.ts', line1: 1, detail: "import pad from 'left-pad';" }] }),
    });
    expect(report.status).toBe('unverified');
    expect(report.blockers).toEqual([]);
    expect(report.unverified[0]).toContain('left-pad');
  });

  it('says which files were not inspected and why', async () => {
    const report = await runLibraryShipCheck({
      files: ['src/uses-yaml.ts', 'src/readme.md', 'src/gone.ts'],
      repoRoot: root,
      libraries: libraries([]),
      reuse: null,
      baseline: baseline(['yaml']),
      workspacePackages: new Set(),
      search: fixedSearch({}),
    });
    expect(report.inspected).toEqual(['src/uses-yaml.ts']);
    expect(report.notInspected).toEqual(expect.arrayContaining([
      { path: 'src/gone.ts', reason: 'not present in the tree' },
      { path: 'src/readme.md', reason: 'not JavaScript/TypeScript (imports not read)' },
    ]));
    expect(report.scope).toContain('other files are not');
  });

  it('turns a failed or truncated import read into unverified files, never an empty pass', async () => {
    const failing: ImportSearch = async () => ({ sites: [], error: 'structural search is disabled', truncation: { truncated: false, totalAvailable: null, continuation: null } });
    const report = await runLibraryShipCheck({
      files: ['src/uses-left-pad.ts'], repoRoot: root, libraries: libraries([]), reuse: null,
      baseline: baseline([]), workspacePackages: new Set(), search: failing,
    });
    expect(report.status).toBe('unverified');
    expect(report.inspected).toEqual([]);
    expect(report.notInspected[0]).toMatchObject({ path: 'src/uses-left-pad.ts', reason: expect.stringContaining('disabled') });
  });

  /** A search that truncates whenever the requested paths hold more sites than `cap`, like the facade. */
  function cappedSearch(cap: number, sitesPerFile: Record<string, number>): ImportSearch {
    return async ({ pattern, paths }) => {
      const sites = pattern !== IMPORT ? [] : paths.flatMap((path) =>
        Array.from({ length: sitesPerFile[path] ?? 0 }, (_, index) => ({ path, line1: index + 1, kind: 'match', detail: `import x${index} from 'pkg-${index}';` })));
      const truncated = sites.length > cap;
      return { sites: truncated ? sites.slice(0, cap) : sites, error: null, truncation: { truncated, totalAvailable: sites.length, continuation: null } };
    };
  }

  it('splits a batch the site cap truncated until every file is read (a real plan overflows one call)', async () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
    const { imports, unread } = await readJsImports({
      files, repoRoot: root, search: cappedSearch(3, Object.fromEntries(files.map((file) => [file, 2]))),
    });
    expect(unread).toEqual([]);
    expect(imports).toHaveLength(10);
    expect(new Set(imports.map((site) => site.path))).toEqual(new Set(files));
  });

  it('reports only the one file whose own imports exceed the cap as unread, and still reads the rest', async () => {
    const { imports, unread } = await readJsImports({
      files: ['src/huge.ts', 'src/small.ts'], repoRoot: root, search: cappedSearch(3, { 'src/huge.ts': 5, 'src/small.ts': 1 }),
    });
    expect(unread).toEqual([{ path: 'src/huge.ts', reason: expect.stringContaining('import read truncated') }]);
    expect(imports).toEqual([{ path: 'src/small.ts', line1: 1, specifier: 'pkg-0' }]);
  });

  it('uses the bounded TypeScript fallback when one file exceeds the simulated facade site cap', async () => {
    const file = 'src/over-cap.ts';
    const staticImports = Array.from({ length: 4 }, (_, index) => `pkg-${index}`);
    const specifiers = [...staticImports, 'pkg-export', 'pkg-require', 'pkg-dynamic'];
    writeFileSync(join(root, file), [
      ...staticImports.map((pkg, index) => `import x${index} from '${pkg}';`),
      "export { exported } from 'pkg-export';",
      "const required = require('pkg-require');",
      "const dynamic = import('pkg-dynamic');",
    ].join('\n'));

    const { imports, unread } = await readJsImports({
      files: [file], repoRoot: root, search: cappedSearch(3, { [file]: staticImports.length }),
    });

    expect(unread).toEqual([]);
    expect(imports.map((site) => site.specifier)).toEqual(specifiers);
    expect(imports.every((site) => site.path === file)).toBe(true);
  });

  it('keeps a truncated file unread when the bounded fallback cannot read, fit, or parse it', async () => {
    const alwaysTruncated: ImportSearch = async () => ({
      sites: [], error: null, truncation: { truncated: true, totalAvailable: 1, continuation: null },
    });
    const missing = await readJsImports({ files: ['src/missing.ts'], repoRoot: root, search: alwaysTruncated });
    expect(missing.imports).toEqual([]);
    expect(missing.unread[0]).toMatchObject({ path: 'src/missing.ts', reason: expect.stringContaining('read failed') });

    const oversizedPath = 'src/oversized.ts';
    writeFileSync(join(root, oversizedPath), Buffer.alloc(1024 * 1024 + 1, 0x20));
    const oversized = await readJsImports({ files: [oversizedPath], repoRoot: root, search: alwaysTruncated });
    expect(oversized.imports).toEqual([]);
    expect(oversized.unread[0]).toMatchObject({ path: oversizedPath, reason: expect.stringContaining('exceeds') });

    const malformedPath = 'src/malformed.ts';
    writeFileSync(join(root, malformedPath), "import x from 'pkg';\nconst = ;\n");
    const malformed = await readJsImports({ files: [malformedPath], repoRoot: root, search: alwaysTruncated });
    expect(malformed.imports).toEqual([]);
    expect(malformed.unread[0]).toMatchObject({ path: malformedPath, reason: expect.stringContaining('parse failed') });
  });

  it('warns, without refusing, about a declared reuse entry no inspected file references', async () => {
    const reuse = {
      searched: [{ where: 'src', how: 'grep' }],
      reused: [
        { ref: 'src/uses-yaml.ts', kind: 'file', provides: 'the yaml gate' },
        { ref: 'plans:audit', kind: 'tool', provides: 'never mentioned' },
      ],
      newSurfaces: [],
      notApplicable: null,
    } as unknown as ReuseDeclaration;
    const report = await runLibraryShipCheck({
      files: ['src/uses-yaml.ts'], repoRoot: root, libraries: libraries([]), reuse,
      baseline: baseline(['yaml']), workspacePackages: new Set(), search: fixedSearch({}),
    });
    expect(report.status).toBe('pass');
    expect(report.warnings).toEqual([{ ref: 'plans:audit', kind: 'tool', detail: 'declared as reused, but no inspected file references it' }]);
  });
});

const astGrepBin = resolveAstGrepBin();

describe.skipIf(!astGrepBin)('ship check — real ast-grep grammar (R-6)', () => {
  it('reads every import form from a fixture file and skips strings and comments', async () => {
    const run = promisify(execFile);
    const search: ImportSearch = async (input) => {
      const { stdout } = await run(astGrepBin!, buildAstGrepArgs({ ...input }, 'search'), { cwd: input.rootPath })
        .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
      return { sites: parseAstGrepMatches(stdout, input.rootPath), error: null, truncation: { truncated: false, totalAvailable: null, continuation: null } };
    };
    const { imports, unread } = await readJsImports({ files: ['src/all-forms.ts'], repoRoot: root, search });
    expect(unread).toEqual([]);
    expect(new Set(imports.map((site) => site.specifier))).toEqual(new Set([
      'pkg-default', '@scope/named/sub', 'node:fs', 'side-effect', 'type-only', 'reexport', 'star-export',
      'star-ns', 'type-re', 'cjs-req', 'dyn-imp', './local', '@papercusp/shared-lib',
    ]));
  });
});
