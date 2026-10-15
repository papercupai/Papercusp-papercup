import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeIntelAnswer } from './contracts';

const adapter = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => true }));
vi.mock('./lsp-adapter.ts', () => ({
  languageForFile: () => 'typescript',
  lspQuery: adapter.query,
  lspDiagnostics: adapter.query,
  lspRenamePreview: adapter.query,
  lspWorkspaceSymbols: adapter.query,
  lspClientInventory: () => [],
  resolveServerBin: () => null,
}));
import { lspDaemonFacade as lspFacade } from './lsp-daemon-facade';

const args = { file: '/fixture/spec-evidence-store.ts', line1: 98, character: 25, rootPath: '/fixture' };
function answer(health: 'healthy' | 'degraded', count: number): CodeIntelAnswer {
  return {
    backend: 'lsp-adapter', intent: 'references', query: 'measureRepoFilesEvidenceAtRoot',
    sites: Array.from({ length: count }, (_, i) => ({ path: 'spec-evidence-store.ts', line1: i + 1, kind: 'reference' })),
    freshness: { health, indexedCommit: null, indexedAt: null, staleVsDisk: false },
    truncation: { truncated: false, totalAvailable: count, continuation: null },
    error: null, latencyMs: 1,
  };
}

beforeEach(() => adapter.query.mockReset());
describe('compiler result coverage is independent from readiness and output budget', () => {
  it('labels degraded same-file references as potentially missing external consumers', async () => {
    // Recorded failure shape: declaration and local uses arrive, design acceptance
    // is absent, health is degraded and error is null.
    adapter.query.mockResolvedValue(answer('degraded', 3));
    const result = await lspFacade('references', args);
    expect(result.sites).toHaveLength(3);
    expect(result.sites.some(site => site.path.includes('design-compare'))).toBe(false);
    expect(result.coverage).toMatchObject({ basis: 'compiler-project', sourceCompleteness: 'unverified' });
    expect(result.coverage?.limitations.join(' ')).toContain('may omit real consumers');
    expect(result.freshness.health).toBe('degraded');
  });

  it('does not certify source absence from a healthy empty response', async () => {
    adapter.query.mockResolvedValue(answer('healthy', 0));
    const result = await lspFacade('references', args);
    expect(result.error).toBeNull();
    expect(result.sites).toEqual([]);
    expect(result.freshness.health).toBe('healthy');
    expect(result.coverage?.sourceCompleteness).toBe('unverified');
    expect(result.coverage?.limitations.join(' ')).toContain('external projects');
  });

  it('retains coverage limits when output is capped', async () => {
    adapter.query.mockResolvedValue(answer('healthy', 3));
    const result = await lspFacade('references', { ...args, limit: 1 });
    expect(result.sites).toHaveLength(1);
    expect(result.truncation).toMatchObject({ truncated: true, totalAvailable: 3 });
    expect(result.coverage?.sourceCompleteness).toBe('unverified');
  });
});
