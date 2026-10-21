import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SnapshotSymbol } from './push-snapshot';
import { PACKAGE_NAME_PROOF_DIGEST, packageNameProofSha256 } from './proof-digest';

const state = vi.hoisted(() => ({ root: '', registeredRoot: '', file: '', workspace: 'fixture-workspace', stalled: false }));
vi.mock('@papercusp/module-singleton', () => ({ pinModuleState: (_key: string, init: () => unknown) => init() }));
vi.mock('./dependency-snapshot-path', () => ({ dependencySnapshotPath: () => state.file }));
vi.mock('../harness-registry', () => ({ loadHarnessRegistry: async () => state.stalled
  ? await new Promise<never>(() => {}) : { projects: [{ slug: 'home', path: state.registeredRoot }] } }));
vi.mock('../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'home' }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => state.workspace }));
vi.mock('../degradation/fallback-observations', () => ({ observeFallback: () => {} }));

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const files = {
  'lib/target.ts': 'export function target() {}\n',
  'lib/barrel.ts': "export { target as forwarded } from './target';\n",
  'app/use.ts': "import { forwarded as alias } from '../lib/barrel';\nalias(); // target()\n",
  'other/use.ts': "import { target } from '../lib/target';\ntarget();\n",
};
let symbols: SnapshotSymbol[];
let module: typeof import('./push-snapshot');
async function load(rows = symbols, generatedAt = new Date().toISOString()) {
  await writeFile(state.file, JSON.stringify({ schema: 'graph-dependency-snapshot-v1', generatedAt,
    index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) },
    edges: [{ importer: 'app/use.ts', imported: 'lib/barrel.ts', importerSha256: hash(files['app/use.ts']) }],
    symbols: { schema: 'code-intel-symbol-snapshot-v1', knowledge: 'syntax-bound', symbols: rows } }));
  expect(module.peekPushSnapshot('papercusp')).toBeNull();
  await vi.waitFor(() => expect(module.peekPushSnapshot('papercusp')).not.toBeNull());
}
const query = (over: Partial<Parameters<typeof module.queryPushSnapshot>[0]> = {}) => module.queryPushSnapshot({
  op: 'callers', root: state.root, workspaceId: state.workspace, name: 'target', ...over,
});

beforeEach(async () => {
  vi.resetModules();
  state.root = await mkdtemp(join(tmpdir(), 'snapshot-query-'));
  state.registeredRoot = state.root;
  state.stalled = false;
  state.file = join(state.root, 'snapshot.json');
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(state.root, path.split('/')[0]!), { recursive: true });
    await writeFile(join(state.root, path), text);
  }
  symbols = [{ id: 'target', name: 'target', path: 'lib/target.ts', line: 1, column: 17,
    sha256: hash(files['lib/target.ts']), signature: 'function target()', aliases: ['forwarded', 'alias'],
    sources: Object.entries(files).map(([path, text]) => ({ path, sha256: hash(text) })),
    callers: ['app/use.ts', 'other/use.ts'].map(path => ({ path, line: 2, column: 1,
      sha256: hash(files[path as keyof typeof files]), spelling: path.startsWith('app/') ? 'alias' : 'target' })) }];
  module = await import('./push-snapshot');
});
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });

describe('source-corroborated snapshot queries', () => {
  it('returns scoped, bounded positive callers with syntax evidence and stable source identities', async () => {
    await load();
    const answer = await query({ paths: ['app'], name: 'forwarded', limit: 1 });
    expect(answer).toMatchObject({ backend: 'first-party-snapshot', intent: 'callers', error: null,
      sites: [{ path: 'app/use.ts', line1: 2, name: 'alias' }],
      coverage: { basis: 'syntax', sourceCompleteness: 'unverified' },
      truncation: { truncated: false, totalAvailable: null }, freshness: { staleVsDisk: null } });
    expect(answer!.evidence!.languageCapabilities.every(row => row.status === 'syntax-only')).toBe(true);
    expect(answer!.evidence!.siteIdentities[0]!.versionedSymbolId).toContain(hash(files['app/use.ts']));
    expect(answer!.evidence!.relationships[0]).toMatchObject({ origin: 'syntax', knowledge: 'inferred', runtimeExecution: 'unknown',
      target: { contentHash: hash(files['lib/target.ts']), site: { path: 'lib/target.ts', name: 'target' } } });
    const limited = await query({ limit: 1 });
    expect(limited!.sites).toHaveLength(1);
    expect(limited!.truncation).toMatchObject({ truncated: true, totalAvailable: null });
  });

  it('resolves an alias call and a declaration only at their captured token spans', async () => {
    await load();
    for (const [file, line1, character] of [['app/use.ts', 2, 2], ['lib/target.ts', 1, 18]] as const) {
      expect(await query({ op: 'definition', file, line1, character })).toMatchObject({
        intent: 'definition', sites: [{ path: 'lib/target.ts', line1: 1, name: 'target' }],
      });
    }
    expect(await query({ op: 'definition', file: join(state.root, 'app/use.ts'), line1: 2, character: 0 })).not.toBeNull();
    // Closing punctuation, a comment with the same name and an import token are not captured call sites.
    for (const [line1, character] of [[2, 5], [2, 12], [1, 22]])
      expect(await query({ op: 'definition', file: 'app/use.ts', line1, character })).toBeNull();
  });

  it('resolves a unique name-only definition without a cursor and falls through otherwise (P-040)', async () => {
    await load();
    for (const name of ['target', 'forwarded']) {
      expect(await query({ op: 'definition', name })).toMatchObject({
        backend: 'first-party-snapshot', intent: 'definition', error: null, query: name,
        sites: [{ path: 'lib/target.ts', line1: 1, name: 'target', detail: 'function target()' }],
        evidence: { sourceScope: { paths: ['lib/target.ts'] } },
      });
    }
    expect(await query({ op: 'definition', name: 'target', paths: ['lib'] })).not.toBeNull();
    // Absent and out-of-scope names never become a negative answer.
    expect(await query({ op: 'definition', name: 'missing' })).toBeNull();
    expect(await query({ op: 'definition', name: 'target', paths: ['app'] })).toBeNull();
    // Declaration drift still falls through to the compiler.
    await writeFile(join(state.root, 'lib/target.ts'), files['lib/target.ts'] + '// changed\n');
    expect(await query({ op: 'definition', name: 'target' })).toBeNull();
    await writeFile(join(state.root, 'lib/target.ts'), files['lib/target.ts']);
    vi.resetModules(); module = await import('./push-snapshot');
    await load([...symbols, { ...symbols[0]!, id: 'homonym' }]);
    expect(await query({ op: 'definition', name: 'target' })).toBeNull();
  });

  it('serves a declaration-name definition despite caller or forwarding drift, never an alias match (P-040)', async () => {
    await load();
    for (const path of ['lib/barrel.ts', 'app/use.ts', 'other/use.ts'] as const) {
      await writeFile(join(state.root, path), files[path] + '// changed\n');
      expect(await query({ op: 'definition', name: 'target' })).toMatchObject({
        backend: 'first-party-snapshot', sites: [{ path: 'lib/target.ts', line1: 1, name: 'target' }],
        evidence: { sourceScope: { supportingFiles: [{ path: 'lib/target.ts', contentHash: hash(files['lib/target.ts']) }] } },
      });
      // An alias resolves through the forwarding chain, so its drift still goes to the compiler.
      expect(await query({ op: 'definition', name: 'forwarded' })).toBeNull();
      expect(await query()).toBeNull();
      await writeFile(join(state.root, path), files[path]);
    }
    // A caller population past the bounded proof no longer blocks the declaration-name answer.
    vi.resetModules(); module = await import('./push-snapshot');
    await load([{ ...symbols[0]!, sources: [...symbols[0]!.sources!, ...Array.from({ length: 80 }, (_, i) => ({
      path: `extra/proof${i}.ts`, sha256: 'a'.repeat(64),
    }))] }]);
    expect((await query({ op: 'definition', name: 'target' }))!.coverage!.limitations.join(' ')).toContain('were not checked');
    expect(await query({ op: 'definition', name: 'forwarded' })).toBeNull();
    expect(await query()).toBeNull();
  });

  it('falls through when forwarding, declaration or caller bytes drift', async () => {
    await load();
    for (const path of ['lib/barrel.ts', 'lib/target.ts', 'app/use.ts'] as const) {
      await writeFile(join(state.root, path), files[path] + '// changed\n');
      expect(await query()).toBeNull();
      expect(await query({ op: 'definition', file: 'app/use.ts', line1: 2, character: 0 })).toBeNull();
      await writeFile(join(state.root, path), files[path]);
    }
  });

  it('does not turn cold, missing, empty-scope or invalid requests into negative answers', async () => {
    expect(await query()).toBeNull();
    // Reset after the intentionally absent-file cold read; it has a refresh interval.
    vi.resetModules(); module = await import('./push-snapshot');
    await load();
    expect(await query({ name: 'missing' })).toBeNull();
    expect(await query({ paths: ['missing'] })).toBeNull();
    expect(await query({ paths: ['../app'] })).toBeNull();
    expect(await query({ op: 'definition', file: '../app/use.ts', line1: 2, character: 0 })).toBeNull();
  });

  it('refuses foreign workspace/root and ambiguous symbol or cursor targets', async () => {
    await load([...symbols, { ...symbols[0]!, id: 'homonym' }]);
    expect(await query()).toBeNull();
    expect(await query({ op: 'definition', file: 'app/use.ts', line1: 2, character: 0 })).toBeNull();
    expect(await query({ workspaceId: 'another-workspace' })).toBeNull();
    state.registeredRoot = tmpdir();
    expect(await query()).toBeNull();
  });

  it('answers past a manifest edit that keeps its name and reports the manifest content it read (P-001)', async () => {
    const manifest = (extra: object) => JSON.stringify({ name: '@fx/lib', ...extra });
    await writeFile(join(state.root, 'lib/package.json'), manifest({ version: '1.0.0' }));
    await load([{ ...symbols[0]!, sources: [...symbols[0]!.sources!,
      { path: 'lib/package.json', sha256: packageNameProofSha256(manifest({}))!, digest: PACKAGE_NAME_PROOF_DIGEST }] }]);
    const edited = manifest({ version: '2.0.0', scripts: { test: 'vitest' } });
    await writeFile(join(state.root, 'lib/package.json'), edited);
    const answer = await query();
    expect(answer?.error).toBeNull();
    // supportingFiles promises a full-source hash, never the narrower name digest.
    expect(answer!.evidence!.sourceScope.supportingFiles).toContainEqual(expect.objectContaining({
      path: 'lib/package.json', contentHash: hash(edited), representation: 'full-source' }));
    await writeFile(join(state.root, 'lib/package.json'), JSON.stringify({ name: '@fx/renamed' }));
    expect(await query()).toBeNull();
  });

  it('refuses missing forwarding proofs and conflicting source versions', async () => {
    await load([{ ...symbols[0]!, sources: undefined }]);
    expect(await query()).toBeNull();
    vi.resetModules(); module = await import('./push-snapshot');
    await load([{ ...symbols[0]!, sources: [{ path: 'lib/target.ts', sha256: 'b'.repeat(64) }] }]);
    expect(await query()).toBeNull();
  });

  it('bounds a stalled registry lookup and answers warm scoped requests below the one-second p50 target', async () => {
    await load();
    const latencies: number[] = [];
    for (let i = 0; i < 11; i++) {
      const start = performance.now();
      expect(await query()).not.toBeNull();
      latencies.push(performance.now() - start);
    }
    expect(latencies.sort((a, b) => a - b)[5]).toBeLessThan(1000);
    state.stalled = true;
    const start = performance.now();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await query()).toBeNull();
      expect(performance.now() - start).toBeLessThan(1000);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('falls back rather than verifying an unbounded source proof', async () => {
    await load([{ ...symbols[0]!, sources: Array.from({ length: module.QUERY_PROOF_MAX_SOURCES + 1 }, (_, i) => ({
      path: `extra/proof${i}.ts`, sha256: 'a'.repeat(64),
    })) }]);
    expect(await query()).toBeNull();
  });

  it('verifies a widely used symbol past the hook-path cap within the query bound (P-040)', async () => {
    const extra = Array.from({ length: 100 }, (_, i) => [`wide/use${i}.ts`, `import { target } from '../lib/target';\ntarget();\n// ${i}\n`] as const);
    await mkdir(join(state.root, 'wide'), { recursive: true });
    for (const [path, text] of extra) await writeFile(join(state.root, path), text);
    const wide = extra.map(([path, text]) => ({ path, line: 2, column: 1, sha256: hash(text), spelling: 'target' }));
    await load([{ ...symbols[0]!, sources: [...symbols[0]!.sources!, ...wide.map(({ path, sha256 }) => ({ path, sha256 }))],
      callers: [...symbols[0]!.callers, ...wide] }]);
    expect(module.PUSH_PROOF_MAX_SOURCES).toBeLessThan(wide.length);
    const answer = await query({ paths: ['wide'], limit: 500 });
    expect(answer).toMatchObject({ backend: 'first-party-snapshot', truncation: { truncated: false } });
    expect(answer!.sites).toHaveLength(100);
    // The hook path keeps its own tighter bound.
    const proof = wide.map(({ path, sha256 }) => ({ path, sha256 }));
    expect(await module.corroboratePushSources(state.root, proof, AbortSignal.timeout(5_000))).toBe(false);
    expect(await module.corroboratePushSources(state.root, proof, AbortSignal.timeout(5_000), module.QUERY_PROOF_MAX_SOURCES)).toBe(true);
  });
});
