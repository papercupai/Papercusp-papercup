import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { INVENTORY_GROUPS, inventorySources, readCommittedSources } from './lib/runtime-compatibility-census.mjs';
const require = createRequire(import.meta.url);
const { collectImports } = require('../papercusp-desktop/bin/lib/runtime-import-census.cjs');
const source = (path: string, text: string) => ({ path, bytes: Buffer.from(text), repository: '.', commit: 'a'.repeat(40), blobOid: 'b'.repeat(40) });
const snapshot = (sources: ReturnType<typeof source>[]) => ({ sources, repositories: [{ path: '.', commit: 'a'.repeat(40) }], unresolved: [] as object[] });

describe('committed runtime migration inventory discovery', () => {
  it('decodes exact Git blob bytes with binary input/output rather than an encoding named buffer', () => {
    const bytes = Buffer.from('export const x = "😀";'), oid = 'b'.repeat(40), root = process.cwd();
    const runGit = (_root: string, args: string[], options?: { encoding: unknown; input: Buffer }) => {
      if (args.includes('--show-toplevel')) return root;
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      if (args[0] === 'ls-tree') return `100644 blob ${oid} ${bytes.length}\tmain.ts\0`;
      expect(options?.encoding).toBeNull(); expect(Buffer.isBuffer(options?.input)).toBe(true);
      return Buffer.concat([Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from('\n')]);
    };
    const result = readCommittedSources(root, 'HEAD', { runGit });
    expect(result.sources[0].bytes).toEqual(bytes); expect(result.unresolved).toEqual([]);
  });
  it('retains an oversized source as a pinned gap without reading its blob', () => {
    const root = process.cwd(), oid = 'b'.repeat(40);
    const runGit = (_root: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return root;
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      expect(args[0]).toBe('ls-tree'); return `100644 blob ${oid} 999999999\tlarge.js\0`;
    };
    const result = readCommittedSources(root, 'HEAD', { runGit });
    expect(result.sources).toEqual([]);
    expect(result.unresolved[0]).toMatchObject({ path: 'large.js', blobOid: oid, reason: 'nonregular-or-over-budget-source' });
  });
  it('does not reuse a fingerprint across changed unavailable repository pins', () => {
    const input = snapshot([]); input.unresolved.push({ repository: 'missing', revision: 'old', reason: 'unavailable' });
    const first = inventorySources(input).sourceFingerprint;
    input.unresolved[0] = { repository: 'missing', revision: 'new', reason: 'unavailable' };
    expect(inventorySources(input).sourceFingerprint).not.toBe(first);
  });
  it('parses pinned bytes without a corresponding working-tree file', () => {
    expect(collectImports('/nonexistent/pinned.ts', Buffer.from('import addon from "some-native-addon";')).imports[0].specifier).toBe('some-native-addon');
  });
  it('includes arbitrary value imports without restricting discovery to native addon seeds', () => {
    const result = inventorySources(snapshot([source('apps/main.ts', 'import x from "new-capability"; export const run = () => x();')]));
    expect(result.groups.capabilities.map((row) => row.id)).toEqual(['apps/main.ts']);
    expect(result.closureAccepted).toBe(false);
  });
  it('retains dynamic imports and unavailable gitlinks as unresolved', () => {
    const input = snapshot([source('packages/host.ts', 'export const run = (name) => import(name);')]);
    input.unresolved.push({ repository: 'libs/missing', reason: 'pinned-repository-unavailable' });
    expect(inventorySources(input).unresolved.map((row) => row.reason)).toEqual(['pinned-repository-unavailable', 'dynamic-or-generated-module']);
  });
  it('does not turn a comment into a launch boundary', () => {
    const result = inventorySources(snapshot([source('packages/types.ts', '// spawn("node")\nimport type { X } from "not-executed";')]));
    expect(result.groups.launchers).toEqual([]);
    // Syntax signals can overapproximate type declarations; the import record
    // itself must preserve typeOnly so review cannot treat it as execution.
    expect(result.files[0].imports[0].typeOnly).toBe(true);
  });
  it('keeps test/fixture source visible without declaring it unreachable', () => {
    const result = inventorySources(snapshot([source('packages/__tests__/host.test.ts', 'import { fork } from "node:child_process"; fork("child.js");')]));
    expect(result.files[0].sourceKind).toBe('test-or-fixture');
    expect(result.groups.launchers[0].classification).toBe('unreviewed');
  });
  it('changes the fingerprint for changed bytes or a changed repository revision', () => {
    const input = snapshot([source('apps/main.ts', 'export const n = 1;')]), first = inventorySources(input).sourceFingerprint;
    input.sources[0].bytes = Buffer.from('export const n = 2;'); expect(inventorySources(input).sourceFingerprint).not.toBe(first);
    input.sources[0].bytes = Buffer.from('export const n = 1;'); input.sources[0].commit = 'c'.repeat(40);
    expect(inventorySources(input).sourceFingerprint).not.toBe(first);
  });
  it('keeps distinct platform signals without claiming they define a matrix', () => {
    const result = inventorySources(snapshot([source('release.config.ts', 'export const targets = ["linux-arm64", "macos-universal", "windows-x86_64"];')]));
    expect(Object.keys(result.groups)).toEqual(INVENTORY_GROUPS);
    expect(result.groups.platforms[0].signals).toHaveLength(3);
    expect(result.closureAccepted).toBe(false);
  });
  it('recognizes platform strings after interpolated templates without swallowing source text', () => {
    const text = 'export const message = `echo ${value}`; export const targets = ["windows-x86_64", "macos-universal"];';
    const result = inventorySources(snapshot([source('release.config.ts', text)]));
    expect(result.groups.platforms[0].signals.map((signal) => signal.value)).toEqual(['windows-x86_64', 'macos-universal']);
  });
});
