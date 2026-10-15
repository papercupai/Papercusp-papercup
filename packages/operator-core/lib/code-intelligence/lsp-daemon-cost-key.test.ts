import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureLspDaemonInputs, lspDaemonCostKey } from './lsp-daemon-cost-key.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('daemon cost observation identity', () => {
  it('bounds external-reference candidate detection across streamed chunk boundaries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lsp-cost-reference-')); roots.push(root);
    writeFileSync(join(root, 'source.ts'), ' '.repeat(64 * 1024 - 1) + '/// <reference lib="dom" />');
    const snapshot = await captureLspDaemonInputs(root);
    expect(snapshot.measured).toBe(true);
    if (snapshot.measured) expect(snapshot.externalReferenceCandidates).toEqual(['source.ts']);
  });
  it('distinguishes cursor, operation and actual document contents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lsp-cost-key-'));
    roots.push(root);
    const file = join(root, 'example.ts');
    writeFileSync(file, 'const name = 1;\n');
    const args = { file, rootPath: root, line1: 1, character: 6 };
    const first = await lspDaemonCostKey('references', args);
    expect(first).toBeTruthy();
    expect(await lspDaemonCostKey('references', args)).toBe(first);
    expect(await lspDaemonCostKey('references', { ...args, character: 7 })).not.toBe(first);
    expect(await lspDaemonCostKey('symbol', args)).not.toBe(first);
    writeFileSync(file, 'const name = 2;\n');
    expect(await lspDaemonCostKey('references', args)).not.toBe(first);
  });

  it('does not reuse a cost without a readable document revision', async () => {
    expect(await lspDaemonCostKey('workspace_symbols', { name: 'Symbol' })).toBeUndefined();
    expect(await lspDaemonCostKey('references', { file: '/missing/lsp-cost-key.ts' })).toBeUndefined();
  });

  it('invalidates unchanged-cursor observations for dependency edits, config changes and deletes without events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lsp-cost-project-'));
    roots.push(root);
    const file = join(root, 'example.ts');
    const dependency = join(root, 'dependency.ts');
    writeFileSync(file, 'import { value } from "./dependency"; value();\n');
    writeFileSync(dependency, 'export function value() {}\n');
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    const args = { file, rootPath: root, line1: 1, character: 37 };
    const first = await lspDaemonCostKey('references', args);
    expect(first).toBeTruthy();
    const stamp = statSync(dependency);
    writeFileSync(dependency, 'export function other() {}\n');
    utimesSync(dependency, stamp.atime, stamp.mtime);
    const edited = await lspDaemonCostKey('references', args);
    expect(edited).toBeTruthy();
    expect(edited).not.toBe(first);
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":false}}');
    const configured = await lspDaemonCostKey('references', args);
    expect(configured).toBeTruthy();
    expect(configured).not.toBe(edited);
    rmSync(dependency);
    expect(await lspDaemonCostKey('references', args)).not.toBe(configured);
  });

  it('reconciles manifests, hidden aliases, new files and nested source bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lsp-cost-reconcile-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    let previous = await captureLspDaemonInputs(root);
    expect(previous.measured).toBe(true);
    for (const [path, text] of [['package.json', '{"type":"commonjs"}'], ['.aliases', 'alias=other'],
      ['nested/dependency.ts', 'export const value = 1;']]) {
      mkdirSync(join(root, 'nested'), { recursive: true });
      writeFileSync(join(root, path!), text!);
      const next = await captureLspDaemonInputs(root);
      expect(next.measured).toBe(true);
      if (previous.measured && next.measured) expect(next.fingerprint).not.toBe(previous.fingerprint);
      previous = next;
    }
    expect(await captureLspDaemonInputs(root)).toEqual(previous);
  });

  it('never substitutes a partial census for oversized, linked or external submodule metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lsp-cost-bounds-'));
    roots.push(root);
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;');
    expect(await captureLspDaemonInputs(root, { maxEntries: 1, maxBytes: 1 }))
      .toMatchObject({ measured: false, reason: 'project-input byte bound exceeded' });
    writeFileSync(join(root, 'other.ts'), '');
    expect(await captureLspDaemonInputs(root, { maxEntries: 1, maxBytes: 1_000 }))
      .toMatchObject({ measured: false, reason: 'project-input entry bound exceeded' });
    symlinkSync(join(root, 'source.ts'), join(root, 'linked.ts'));
    expect(await captureLspDaemonInputs(root)).toMatchObject({ measured: false, reason: expect.stringContaining('linked') });
    rmSync(join(root, 'linked.ts'));
    writeFileSync(join(root, '.git'), 'gitdir: ../repo/.git/modules/nested\n');
    expect(await captureLspDaemonInputs(root)).toMatchObject({ measured: false,
      reason: expect.stringContaining('external repository metadata') });
    expect(await lspDaemonCostKey('references', { file: join(root, 'source.ts'), rootPath: root })).toBeUndefined();
  });

  it('isolates equal source bytes across physical project roots and refuses an outside document', async () => {
    const a = mkdtempSync(join(tmpdir(), 'lsp-cost-isolation-a-'));
    const b = mkdtempSync(join(tmpdir(), 'lsp-cost-isolation-b-'));
    roots.push(a, b);
    for (const root of [a, b]) writeFileSync(join(root, 'source.ts'), 'export const value = 1;');
    const first = await captureLspDaemonInputs(a);
    const second = await captureLspDaemonInputs(b);
    expect(first.measured).toBe(true);
    expect(second.measured).toBe(true);
    if (first.measured && second.measured) expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(await lspDaemonCostKey('references', { file: join(b, 'source.ts'), rootPath: a })).toBeUndefined();
  });
});
