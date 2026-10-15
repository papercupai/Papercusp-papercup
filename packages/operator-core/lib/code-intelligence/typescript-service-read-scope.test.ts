/** P019: real compiler reads stay inside the authorized repository cohort. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openScopedTsTree, type ScopedTsTree } from './typescript-service';

const roots: string[] = [];
const trees: ScopedTsTree[] = [];
afterEach(() => {
  trees.splice(0).forEach(tree => tree.service.dispose());
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'compiler-read-scope-')); roots.push(root);
  const client = join(root, 'client'); const foreign = join(root, 'foreign');
  mkdirSync(client); mkdirSync(foreign);
  const source = join(client, 'client.ts'); const dependency = join(foreign, 'secret.ts');
  writeFileSync(source, "import { value } from '../foreign/secret';\nexport const client: typeof value = 123;\n");
  writeFileSync(dependency, "export const value = 'PRIVATE_SCOPE_LITERAL' as const;\n");
  const reads = vi.spyOn(ts.sys, 'readFile');
  const open = (readRoots: string[]) => {
    const tree = openScopedTsTree(ts, client, [source], (_ts, _file, text) => text, readRoots);
    trees.push(tree);
    const program = tree.service.getProgram()!;
    const diagnostics = program.getSemanticDiagnostics().map(row => ts.flattenDiagnosticMessageText(row.messageText, '\n'));
    return { program, diagnostics };
  };
  return { client, foreign, source, dependency, reads, open };
}

describe('compiler authorized read roots', () => {
  it('does not read an unauthorized imported source or expose its literal in diagnostics', () => {
    const f = fixture(); const result = f.open([f.client]);
    expect(result.program.getSourceFile(f.dependency)).toBeUndefined();
    expect(f.reads.mock.calls.some(([path]) => path === f.dependency)).toBe(false);
    expect(result.diagnostics.join('\n')).not.toContain('PRIVATE_SCOPE_LITERAL');
    expect(result.diagnostics.join('\n')).toContain('Cannot find module');
    expect(result.program.getSourceFile(ts.getDefaultLibFilePath(result.program.getCompilerOptions()))).toBeDefined();
  }, 20_000);

  it('checks an imported contract when both repository roots are authorized', () => {
    const f = fixture(); const result = f.open([f.client, f.foreign]);
    expect(result.program.getSourceFile(f.dependency)).toBeDefined();
    expect(f.reads.mock.calls.some(([path]) => path === f.dependency)).toBe(true);
    expect(result.diagnostics.join('\n')).toContain('PRIVATE_SCOPE_LITERAL');
  }, 20_000);

  it('does not admit a symlink that escapes an authorized repository', () => {
    const f = fixture();
    symlinkSync(f.foreign, join(f.client, 'escape'), 'dir');
    writeFileSync(f.source, "import { value } from './escape/secret';\nexport const client: typeof value = 123;\n");
    const result = f.open([f.client]);
    expect(result.program.getSourceFiles().some(file => file.fileName.endsWith('/secret.ts'))).toBe(false);
    expect(f.reads.mock.calls.some(([path]) => path.endsWith('/secret.ts'))).toBe(false);
    expect(result.diagnostics.join('\n')).not.toContain('PRIVATE_SCOPE_LITERAL');
  }, 20_000);

  it('does not read an unauthorized extended compiler configuration', () => {
    const f = fixture(); const foreignConfig = join(f.foreign, 'tsconfig.json');
    writeFileSync(foreignConfig, JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(f.client, 'tsconfig.json'), JSON.stringify({ extends: '../foreign/tsconfig.json' }));
    f.open([f.client]);
    expect(f.reads.mock.calls.some(([path]) => path === foreignConfig)).toBe(false);
  }, 20_000);
});
