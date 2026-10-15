import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';
import type * as Implementation from './hosted-auth-runtime';
import type * as Contract from './hosted-auth-runtime.types';

const packageRoot = resolve(__dirname, '../..');
const declaration = resolve(__dirname, 'hosted-auth-runtime.types.d.ts');
const implementation = resolve(__dirname, 'hosted-auth-runtime.ts');

describe('hosted auth prebundle compiler boundary', () => {
  it('typechecks the hosted voice progress read for both curriculum versions', () => {
    const route = resolve(__dirname, 'routes/hosted-tutorial-progress.ts');
    const program = ts.createProgram([route], {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
      skipLibCheck: true, esModuleInterop: true, resolveJsonModule: true,
      allowImportingTsExtensions: true, noEmit: true, types: ['node'],
    });
    const source = program.getSourceFile(route);
    expect(source).toBeDefined();
    const diagnostics = program.getSemanticDiagnostics(source);
    expect(diagnostics.map(diagnostic => ({ code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') }))).toEqual([]);
  });

  it('keeps the public implementation and declaration types equal', () => {
    // This assertion is also checked by the maintained operator-core typecheck.
    // Runtime tests exercise the implementation; a cast cannot conceal drift.
    expectTypeOf<typeof Implementation>().toEqualTypeOf<typeof Contract>();
    expectTypeOf<Implementation.HostedAuthRuntime>().toEqualTypeOf<Contract.HostedAuthRuntime>();
    expectTypeOf<Implementation.HostedAuthRuntimeDependencies>().toEqualTypeOf<Contract.HostedAuthRuntimeDependencies>();
    expectTypeOf<Implementation.HostedAuthRuntimeConfiguration>().toEqualTypeOf<Contract.HostedAuthRuntimeConfiguration>();
  });

  it.each(['', '.ts'])('resolves %s to declarations for compilers and real source for server bundlers', suffix => {
    const specifier = `@papercusp/operator-core/lib/endpoint-route/hosted-auth-runtime${suffix}`;
    const consumer = resolve(packageRoot, 'compiler-boundary-consumer.ts');
    const result = ts.resolveModuleName(specifier, consumer, {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      resolvePackageJsonExports: true,
    }, ts.sys);
    expect(result.resolvedModule?.resolvedFileName).toBe(declaration);
    expect(createRequire(consumer).resolve(specifier)).toBe(implementation);
  });

  it('does not reopen the tutorial execution graph through a declaration import', () => {
    const source = ts.createSourceFile(declaration, readFileSync(declaration, 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = source.statements.flatMap(statement => {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        return [statement.moduleSpecifier.text];
      }
      return [];
    });
    expect(imports).not.toContain('./hosted-auth-runtime');
    expect(imports.some(specifier => /assistance-runtime|agent-tools|agent-mcp/.test(specifier))).toBe(false);
  });

  it('keeps transitive declaration imports out of the operator execution and evidence graph', () => {
    const options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      resolvePackageJsonExports: true };
    const cache = ts.createModuleResolutionCache(packageRoot, path => path, options);
    const parents = new Map<string, string | null>([[declaration, null]]);
    const queue = [declaration];
    const forbidden = /\/(?:agent-tools\/|scorecards\.ts$|rubrics\.ts$|testing-run-store\.ts$|operator-state-pg\.ts$)/;
    for (let index = 0; index < queue.length; index++) {
      const file = queue[index];
      for (const imported of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
        const result = ts.resolveModuleName(imported.fileName, file, options, ts.sys, cache).resolvedModule;
        if (!result || result.resolvedFileName.includes('/node_modules/') || parents.has(result.resolvedFileName)) continue;
        parents.set(result.resolvedFileName, file);
        queue.push(result.resolvedFileName);
      }
    }
    const offenders = queue.filter(file => forbidden.test(file)).map(file => `${file} via ${parents.get(file)}`);
    expect(offenders).toEqual([]);
    expect(queue.some(file => file.endsWith('/hosted-billing-runtime.ts'))).toBe(true);
  });
});
