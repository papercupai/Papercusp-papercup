// Unit-level handler wiring proof: backend boundaries are mocked. Database,
// daemon and deployed behavior retain their separate integration obligations.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ compiler: vi.fn(), indexed: vi.fn(), daemon: vi.fn(), packer: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn().mockResolvedValue(true) }));
vi.mock('./lsp-daemon-client', () => ({ queryLspDaemon: calls.daemon }));
vi.mock('./packer-facade', async importOriginal => ({
  ...await importOriginal<typeof import('./packer-facade')>(), packerFacade: calls.packer,
}));
vi.mock('./first-party-callers-offthread', () => ({ firstPartyCallersOffthread: calls.compiler }));
vi.mock('./gitnexus-facade', async importOriginal => ({
  ...await importOriginal<typeof import('./gitnexus-facade')>(), gitnexusFacade: calls.indexed,
}));
import graphQuery from '../agent-tools/gitnexus/query';
import lspQuery from '../agent-tools/lsp/query';
import codePack from '../agent-tools/lsp/pack';
import { versionedSymbolIdentity } from './contracts';

const baselinePath = fileURLToPath(new URL('../../../../docs/evidence/native-code-intelligence-baseline-2026-10-09.json', import.meta.url));
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
  routes: Array<{ tool: string; operations: string[]; backend?: string }>;
};
const graphRows = baseline.routes.filter(row => row.tool === 'graph:query');
const graphOperations = graphRows.flatMap(row => row.operations.map(op => ({ op, backend: row.backend })));

beforeEach(() => {
  vi.clearAllMocks();
  calls.compiler.mockResolvedValue({ backend: 'typescript-service', sites: [], error: null });
  calls.indexed.mockResolvedValue({ backend: 'gitnexus', sites: [], error: null });
  calls.daemon.mockResolvedValue({ backend: 'lsp-adapter', sites: [], error: null });
  calls.packer.mockImplementation(async (op: string) => ({
    answer: { backend: op === 'pack' ? 'repomix' : 'code2prompt', sites: [], error: null },
  }));
});

describe('native baseline exposed semantic and packing handlers', () => {
  const semantic = baseline.routes.filter(row => row.tool === 'lsp:query')
    .flatMap(row => row.operations.map(op => ({ op, backend: row.backend })));
  it.each(semantic)('LSP $op selects the recorded $backend daemon route', async ({ op, backend }) => {
    const result = await lspQuery.handler(lspQuery.args.parse({ op, file: 'src/target.ts',
      line1: 1, character: 17, name: 'baselineTarget', newName: 'renamed' }),
    { projectDir: '/baseline-repo', workspaceId: 'baseline-workspace' } as never) as { data: { backend: string } };
    expect(result.data.backend).toBe(backend);
    expect(calls.daemon).toHaveBeenCalledWith(expect.objectContaining({ op, workspaceId: 'baseline-workspace',
      args: expect.objectContaining({ rootPath: '/baseline-repo', file: '/baseline-repo/src/target.ts' }) }));
  });

  const packing = baseline.routes.filter(row => row.tool === 'code:pack')
    .flatMap(row => row.operations.map(op => ({ op, backend: row.backend })));
  it.each(packing)('pack $op selects the recorded $backend engine', async ({ op, backend }) => {
    const result = await codePack.handler(codePack.args.parse({ op, include: ['src/**'] }),
      { projectDir: '/baseline-repo' } as never) as { data: { answer: { backend: string } } };
    expect(result.data.answer.backend).toBe(backend);
    expect(calls.packer).toHaveBeenCalledWith(op, expect.objectContaining({ rootPath: '/baseline-repo', include: ['src/**'] }));
  });

  it('enumerates every admitted exposed operation even if the inventory omits one', () => {
    // The frozen baseline stays historical; successor routes extend the current census.
    expect([...graphQuery.args.shape.op.options].sort()).toEqual([
      'callers', 'callees', 'clones', 'cochange', 'communities', 'concept-search', 'context', 'contracts', 'diagnostics', 'evidence', 'flows', 'health', 'impact', 'implementations', 'provenance', 'references',
      'rename-preview', 'similar', 'sql-lineage', 'structural-search', 'symbol', 'symbol-search', 'text-search', 'trace',
    ].sort());
    expect(graphOperations.map(row => row.op).sort()).toEqual(['callers', 'callees', 'health', 'impact', 'symbol'].sort());
    expect(semantic.map(row => row.op).sort()).toEqual([...lspQuery.args.shape.op.options].sort());
    expect(packing.map(row => row.op).sort()).toEqual([...codePack.args.shape.op.options].sort());
  });
});

describe('native baseline against the exposed graph handler', () => {
  it.each([false, true])('retains complete, conservative coverage for ignored selectors (producer coverage: %s)', async supplied => {
    calls.compiler.mockResolvedValue({ backend: 'typescript-service', intent: 'callers', sites: [], error: 'compiler unavailable',
      ...(supplied ? { coverage: { basis: 'compiler-project', sourceCompleteness: 'unverified', limitations: ['producer limitation'] } } : {}) });
    const out = await graphQuery.handler(graphQuery.args.parse({ op: 'callers', name: 'target', repo: 'ignored', paths: ['src'] }),
      { projectDir: '/baseline-repo' } as never) as { data: import('./contracts').CodeIntelAnswer };
    expect(out.data.coverage).toEqual({ basis: 'compiler-project', sourceCompleteness: 'unverified',
      limitations: [...(supplied ? ['producer limitation'] : []), 'callers ignores repo: it answers for every symbol with this name in the workspace.'] });
    expect(out.data.error).toBe('compiler unavailable');
    expect(out.data.evidence!.sourceScope.sourceFingerprint).toBeNull();
    expect(calls.compiler).toHaveBeenCalledWith(expect.objectContaining({ root: '/baseline-repo', name: 'target', paths: ['src'] }));
    expect(calls.indexed).not.toHaveBeenCalled();
  });

  it('refuses compiler edges with unknown versions instead of assigning current-source identities', async () => {
    calls.compiler.mockResolvedValue({ backend: 'typescript-service', intent: 'impact', sites: [{ path: 'src/old.ts', line1: 2, kind: 'function' }],
      error: null, freshness: { health: 'healthy', indexedAt: null, indexedCommit: 'older-index', staleVsDisk: true } });
    const out = await graphQuery.handler(graphQuery.args.parse({ op: 'impact', name: 'target' }),
      { projectDir: '/baseline-repo' } as never) as { data: import('./contracts').CodeIntelAnswer };
    expect(out.data.evidence!.sourceScope).toMatchObject({ repositoryId: null, identityKind: 'unknown', sourceFingerprint: null, supportingFiles: [] });
    expect(out.data.sites).toEqual([]);
    expect(out.data.evidence!.siteIdentities).toEqual([]);
    expect(out.data.evidence!.relationships).toEqual([]);
    expect(out.data.error).toContain('source versions are unavailable');
    expect(out.data.freshness.health).toBe('unknown');
    expect(out.data.freshness.indexedCommit).toBe('older-index');
  });

  it('labels LSP source versions as unknown when the daemon supplies no snapshots', async () => {
    const out = await lspQuery.handler(lspQuery.args.parse({ op: 'references', file: 'src/target.ts', line1: 1, character: 0 }),
      { projectDir: '/baseline-repo' } as never) as { data: import('./contracts').CodeIntelAnswer };
    expect(out.data.evidence!.sourceScope.sourceFingerprint).toBeNull();
    expect(out.data.evidence!.siteIdentities.every(site => site.contentHash === null && site.versionedSymbolId === null)).toBe(true);
    expect(out.data.evidence!.graphScope.sourceCompleteness).toBe('unverified');
  });

  it.each(graphOperations)('$op selects the current admitted backend', async ({ op, backend }) => {
    const args = graphQuery.args.parse({ op, name: 'baselineTarget' });
    const out = await graphQuery.handler(args, { projectDir: '/baseline-repo' } as never) as {
      data: { backend: string };
    };
    const native = ['callers', 'symbol', 'callees', 'impact'].includes(op);
    expect(out.data.backend).toBe(native ? 'typescript-service' : backend);
    expect(calls.compiler).toHaveBeenCalledTimes(native ? 1 : 0);
    expect(calls.indexed).toHaveBeenCalledTimes(native ? 0 : 1);
  });

  it('routes context and defining-file disambiguation to the existing compiler worker', async () => {
    await graphQuery.handler(graphQuery.args.parse({ op: 'context', name: 'target', file_path: 'src/a.ts', line1: 3 }),
      { projectDir: '/baseline-repo' } as never);
    expect(calls.compiler).toHaveBeenCalledWith(expect.objectContaining({ op: 'context', name: 'target', filePath: 'src/a.ts', line1: 3 }));
    expect(calls.indexed).not.toHaveBeenCalled();
  });

  it('rejects incomplete compiler evidence while allowing a measured site and target from the producer snapshot', async () => {
    const hash = 'a'.repeat(64);
    const source = { path: 'src/a.ts', contentHash: hash, language: 'typescript', representation: 'full-source' as const };
    const site = { path: source.path, line1: 1, kind: 'class' };
    const answer = { backend: 'typescript-service', intent: 'definition', sites: [{ path: source.path, line1: 1, kind: 'class' }], error: null,
      freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false },
      evidence: { schemaVersion: 1, sourceScope: { repositoryId: 'fixture', identityKind: 'registry', sourceFingerprint: hash, paths: ['src'], supportingFiles: [source] },
        graphScope: { basis: 'compiler-project', sourceCompleteness: 'unverified', limitations: [] }, languageCapabilities: [],
        siteIdentities: [{ siteIndex: 0, sourcePath: source.path, contentHash: hash, versionedSymbolId: versionedSymbolIdentity('fixture', site, source) }],
        relationships: [{ siteIndex: 0, kind: 'definition', origin: 'compiler', knowledge: 'observed', runtimeExecution: 'unknown' }] } };
    const run = async () => (await graphQuery.handler(graphQuery.args.parse({ op: 'context', name: 'target' }),
      { projectDir: '/baseline-repo' } as never) as { data: import('./contracts').CodeIntelAnswer }).data;
    calls.compiler.mockResolvedValue(answer);
    expect((await run()).sites).toEqual(answer.sites);
    for (const corrupt of [
      { ...answer, evidence: undefined },
      { ...answer, evidence: { ...answer.evidence, siteIdentities: [] } },
      { ...answer, evidence: { ...answer.evidence, siteIdentities: [{ ...answer.evidence.siteIdentities[0], versionedSymbolId: 'unbound-site-v1' }] } },
      { ...answer, evidence: { ...answer.evidence, sourceScope: { ...answer.evidence.sourceScope, supportingFiles: [] } } },
      { ...answer, evidence: { ...answer.evidence, relationships: [{ ...answer.evidence.relationships[0], target: {
        site: { path: 'unmeasured.ts', line1: 1, kind: 'class' }, contentHash: hash, versionedSymbolId: 'target-v1',
      } }] } },
    ]) {
      calls.compiler.mockResolvedValue(corrupt);
      const refused = await run();
      expect(refused.sites).toEqual([]);
      expect(refused.error).toContain('source versions are unavailable');
    }
  });

  it('refuses unsupported index selectors on native operations before either backend runs', async () => {
    const out = await graphQuery.handler(graphQuery.args.parse({ op: 'context', name: 'target', uid: 'Function:old' }),
      { projectDir: '/baseline-repo' } as never) as { data: import('./contracts').CodeIntelAnswer };
    expect(out.data.error).toContain('selectors are unsupported');
    expect(out.data.evidence!.graphScope.basis).toBe('compiler-project');
    expect(out.data.evidence!.sourceScope.sourceFingerprint).toBeNull();
    expect(calls.compiler).not.toHaveBeenCalled();
    expect(calls.indexed).not.toHaveBeenCalled();
  });

  it('validates path direction, continuity, limits and source endpoints before exposing compiler traversal', async () => {
    const contentHash = 'b'.repeat(64);
    const source = { path: 'src/path.ts', contentHash, language: 'typescript', representation: 'full-source' as const };
    const startSite = { path: source.path, line1: 1, kind: 'function', name: 'origin' };
    const targetSite = { path: source.path, line1: 3, kind: 'function', name: 'target' };
    const callSite = { path: source.path, line1: 2, kind: 'call', name: 'target' };
    const endpoint = (site: typeof startSite) => ({ site, contentHash, versionedSymbolId: versionedSymbolIdentity('fixture', site, source) });
    const start = endpoint(startSite);
    const target = endpoint(targetSite);
    const answer = { backend: 'typescript-service', intent: 'trace', query: 'origin', error: null, sites: [callSite],
      freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false },
      traversal: { direction: 'forward', maxDepth: 1, maxPaths: 1, start, target, paths: [{ siteIndices: [0], walk: 'forward' }], truncationReasons: [], outcome: 'found' },
      evidence: { schemaVersion: 1, sourceScope: { repositoryId: 'fixture', identityKind: 'registry', sourceFingerprint: contentHash, paths: ['src'], supportingFiles: [source] },
        graphScope: { basis: 'compiler-project', sourceCompleteness: 'unverified', limitations: [] }, languageCapabilities: [],
        siteIdentities: [{ siteIndex: 0, sourcePath: source.path, contentHash, versionedSymbolId: versionedSymbolIdentity('fixture', callSite, source) }],
        relationships: [{ siteIndex: 0, kind: 'callees', origin: 'compiler', knowledge: 'observed', runtimeExecution: 'unknown', source: start, target }] } };
    const run = async () => (await graphQuery.handler(graphQuery.args.parse({ op: 'trace', name: 'origin', target: 'target', max_depth: 1, max_paths: 1 }),
      { projectDir: '/baseline-repo' } as never) as { data: import('./contracts').CodeIntelAnswer }).data;
    calls.compiler.mockResolvedValue(answer);
    expect((await run()).traversal!.paths).toHaveLength(1);
    for (const traversal of [
      { ...answer.traversal, start: { ...start, contentHash: 'c'.repeat(64) } },
      { ...answer.traversal, paths: [{ siteIndices: [1], walk: 'forward' }] },
      { ...answer.traversal, paths: [{ siteIndices: [0], walk: 'reverse' }] },
      { ...answer.traversal, paths: [{ siteIndices: [0, 0], walk: 'forward' }] },
      { ...answer.traversal, paths: [{ siteIndices: [], walk: 'forward' }] },
    ]) {
      calls.compiler.mockResolvedValue({ ...answer, traversal });
      const refused = await run();
      expect(refused.error).toContain('source versions are unavailable');
      expect(refused.sites).toEqual([]);
      expect(refused.traversal).toBeUndefined();
    }
    calls.compiler.mockResolvedValue({ ...answer, evidence: { ...answer.evidence,
      relationships: [{ ...answer.evidence.relationships[0], source: target, target: start }] } });
    expect((await run()).traversal).toBeUndefined();
  });

  it('reports a compiler failure through the same first-party route without substituting indexed evidence', async () => {
    calls.compiler.mockResolvedValue({ backend: 'typescript-service', sites: [], error: 'compiler unavailable',
      freshness: { health: 'unhealthy', indexedAt: null, indexedCommit: null, staleVsDisk: null } });
    const out = await graphQuery.handler(graphQuery.args.parse({ op: 'callers', name: 'baselineTarget' }),
      { projectDir: '/baseline-repo' } as never) as { data: { error: string; freshness: { health: string } } };
    expect(out.data.error).toBe('compiler unavailable');
    expect(out.data.freshness.health).toBe('unhealthy');
    expect(calls.indexed).not.toHaveBeenCalled();
  });

  it('keeps refused semantic intents outside both topology backends', async () => {
    const out = await graphQuery.handler(graphQuery.args.parse({ op: 'references', name: 'baselineTarget' }),
      { projectDir: '/baseline-repo' } as never) as { data: { error: string } };
    expect(out.data.error).toMatch(/does not answer/);
    expect(calls.compiler).not.toHaveBeenCalled();
    expect(calls.indexed).not.toHaveBeenCalled();
  });
});
