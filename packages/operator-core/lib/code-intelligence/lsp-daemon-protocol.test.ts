import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLspDaemonDispatchContext, type LspDaemonRequest } from './lsp-daemon-protocol.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-lsp-daemon-protocol-'));
  roots.push(root);
  return root;
}

function resolve(request: LspDaemonRequest) {
  return resolveLspDaemonDispatchContext(request, new AbortController().signal);
}

describe('LSP daemon dispatch identity', () => {
  it('keys position queries by language and the adapter\'s actual project root', () => {
    const root = fixture();
    const rustRoot = join(root, 'crates', 'one');
    mkdirSync(rustRoot, { recursive: true });
    writeFileSync(join(rustRoot, 'Cargo.toml'), '[package]\nname="one"\nversion="0.1.0"\n');
    const rust = resolve({ op: 'references', args: { rootPath: root, file: join(rustRoot, 'src', 'lib.rs') }, actorId: 'agent-1', priority: 2, deadlineAtMs: 123 });
    expect(rust).toMatchObject({ op: 'references', language: 'rust', projectRoot: rustRoot, actorId: 'agent-1', priority: 2, deadlineAtMs: 123 });

    const ts = resolve({ op: 'symbol', args: { rootPath: root, file: join(root, 'pkg', 'index.ts') } });
    expect(ts).toMatchObject({ language: 'typescript', projectRoot: root });
  });

  it('uses the anchored TypeScript project for workspace symbols', () => {
    const root = fixture();
    const tsRoot = join(root, 'pkg');
    mkdirSync(tsRoot);
    writeFileSync(join(tsRoot, 'tsconfig.json'), '{}');
    const context = resolve({ op: 'workspace_symbols', args: { rootPath: root, file: join(tsRoot, 'index.ts'), name: 'Example' } });
    expect(context).toMatchObject({ language: 'typescript', projectRoot: tsRoot });
    expect(resolve({ op: 'workspace_symbols', args: { rootPath: root, name: 'Example' } })).toBeNull();
  });

  it('leaves unsupported and incomplete requests to the facade\'s existing loud refusal', () => {
    const root = fixture();
    expect(resolve({ op: 'health', args: { rootPath: root } })).toBeNull();
    expect(resolve({ op: 'diagnostics', args: { rootPath: root, file: join(root, 'x.cpp') } })).toBeNull();
    expect(resolve({ op: 'references', args: { rootPath: root } })).toBeNull();
    expect(resolve({ op: 'references', args: { rootPath: root, file: join(root, 'x.rs') } })).toBeNull();
  });
});
