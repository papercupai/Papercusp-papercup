/**
 * WI-6554700010010634 — how a TS source reachable from a `.mjs` declarations input may import a
 * sibling that plain `node` must also load.
 *
 * `tsconfig.declarations.json` compiles the repo's `.mjs` inputs, and their import graphs reach
 * operator-core TS sources. Some of those sources also run under plain `node` (native type
 * stripping — e.g. `verifier-source.ts` via `scripts/source-preview.mjs`), where an extensionless
 * RELATIVE import does not resolve. On 2026-10-13 such a file gained `from './process-identity.ts'`:
 * correct for node, but TS5097 in the declarations program, and git-sync's declaration repair runs
 * that program — so every superproject commit was blocked until the import changed.
 *
 * Turning on `allowImportingTsExtensions` (or `rewriteRelativeImportExtensions`) in the declarations
 * config is NOT the remedy: measured the same day, either flag rewrites emitted specifiers such as
 * `import("./related-tests.mjs")` to `import("./related-tests.d.mts")`. The remedy is a package
 * self-reference (`@papercusp/operator-core/lib/<file>`), which resolves through the package's
 * `./lib/*` → `./lib/*.ts` exports map under both node and TypeScript.
 *
 * Both halves are pinned against the REAL compiler options read from the config.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TS_EXTENSION_IMPORT = 5097;

function declarationsCompilerOptions(): ts.CompilerOptions {
  const read = ts.readConfigFile(join(ROOT, 'tsconfig.declarations.json'), ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const converted = ts.convertCompilerOptionsFromJson(read.config.compilerOptions, ROOT);
  if (converted.errors.length > 0) {
    throw new Error(converted.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
  }
  return converted.options;
}

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

/** A package whose `.mjs` entry reaches `lib/mid.ts`, which imports `lib/leaf.ts` via `specifier`. */
function fixturePackage(specifier: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gen-decl-ts-ext-'));
  fixtures.push(dir);
  mkdirSync(join(dir, 'lib'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fx-pkg', type: 'module', exports: { './lib/*': './lib/*.ts' } }),
  );
  writeFileSync(join(dir, 'lib/leaf.ts'), 'export const leaf = 1;\n');
  writeFileSync(join(dir, 'lib/mid.ts'), `import { leaf } from '${specifier}';\nexport const mid = leaf;\n`);
  writeFileSync(join(dir, 'entry.mjs'), "export { mid } from './lib/mid.js';\n");
  return dir;
}

function diagnosticsFor(dir: string): ts.Diagnostic[] {
  const program = ts.createProgram([join(dir, 'entry.mjs')], {
    ...declarationsCompilerOptions(),
    rootDir: dir,
    outDir: join(dir, 'out'),
    // The fixture lives outside the repo, so point @types resolution back at it.
    typeRoots: [join(ROOT, 'node_modules/@types')],
  });
  return [...ts.getPreEmitDiagnostics(program)];
}

function programForInput(input: string): ts.Program {
  return ts.createProgram([join(ROOT, input)], declarationsCompilerOptions());
}

describe('tsconfig.declarations.json — imports in an input graph', () => {
  it('rejects a .ts-suffixed relative import (TS5097), so a source must not use one', () => {
    expect(declarationsCompilerOptions().allowImportingTsExtensions).toBeUndefined();
    const codes = diagnosticsFor(fixturePackage('./leaf.ts')).map((d) => d.code);
    expect(codes).toContain(TS_EXTENSION_IMPORT);
  });

  it('accepts the remedy: a package self-reference resolving through the exports map', () => {
    const messages = diagnosticsFor(fixturePackage('fx-pkg/lib/leaf')).map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    );
    expect(messages).toEqual([]);
  });

  it('keeps source-preview’s production declaration graph free of TS5097', () => {
    const program = programForInput('scripts/source-preview.mjs');
    expect(program.getSourceFiles().some((file) =>
      resolve(file.fileName) === resolve(ROOT, 'packages/operator-core/lib/verifier-source.ts'),
    )).toBe(true);
    const extensionImportDiagnostics = ts.getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.code === TS_EXTENSION_IMPORT);
    expect(extensionImportDiagnostics).toEqual([]);
  });

  it('keeps process-group-lifetime in the declaration graph free of TS5097', () => {
    const input = 'packages/operator-core/lib/fleet/process-group-lifetime.ts';
    const program = programForInput(input);
    const source = program.getSourceFile(resolve(ROOT, input));
    expect(source?.text).toContain("from '@papercusp/operator-core/lib/process-identity'");
    expect(program.getSourceFiles().some((file) =>
      resolve(file.fileName) === resolve(ROOT, 'packages/operator-core/lib/process-identity.ts'),
    )).toBe(true);
    const extensionImportDiagnostics = ts.getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.code === TS_EXTENSION_IMPORT);
    expect(extensionImportDiagnostics).toEqual([]);
  });
});
