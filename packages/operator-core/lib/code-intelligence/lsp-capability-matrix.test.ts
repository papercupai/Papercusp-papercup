import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  initializeCapabilityObservations, lspServerIdentity, requestWithLspCapability,
  type LspCapabilityKey, type LspCapabilityObservation, type LspCapabilityStore,
} from './lsp-capability-matrix';

const key: LspCapabilityKey = { language: 'typescript', intent: 'references', serverIdentity: 'a'.repeat(64) };
function fixture() {
  let observation: LspCapabilityObservation | null = null;
  const store: LspCapabilityStore = {
    get: vi.fn(async () => observation),
    observe: vi.fn(async value => { observation = value; }),
  };
  return { store, read: () => observation };
}

describe('LSP capability declarations and pin identity', () => {
  it('recognizes booleans and provider options, and declines absent/false request providers', () => {
    const observations = initializeCapabilityObservations('typescript', key.serverIdentity, {
      definitionProvider: true, referencesProvider: {}, implementationProvider: false, renameProvider: null,
    });
    expect(Object.fromEntries(observations.map(o => [o.intent, o.supported]))).toEqual({
      definition: true, references: true, implementations: false, 'rename-preview': false, 'symbol-search': false,
    });
    expect(observations.some(o => o.intent === 'diagnostics')).toBe(false);
  });

  it('does not turn an unreadable initialize response into unsupported evidence', () => {
    for (const value of [null, undefined, false, []]) expect(initializeCapabilityObservations('rust', key.serverIdentity, value)).toEqual([]);
  });

  it('changes identity for a new binary, reported version or TypeScript semantic server', () => {
    const root = mkdtempSync(join(tmpdir(), 'lsp-capability-pin-'));
    try {
      const bin = join(root, 'server'), semantic = join(root, 'tsserver');
      writeFileSync(bin, 'version1'); writeFileSync(semantic, 'semantic1');
      const first = lspServerIdentity(bin, { name: 'test', version: '1' }, [semantic]);
      expect(lspServerIdentity(bin, { name: 'test', version: '1' }, [semantic])).toBe(first);
      expect(lspServerIdentity(bin, { name: 'test', version: '2' }, [semantic])).not.toBe(first);
      writeFileSync(semantic, 'semantic2');
      expect(lspServerIdentity(bin, { name: 'test', version: '1' }, [semantic])).not.toBe(first);
      writeFileSync(bin, 'version2');
      expect(lspServerIdentity(bin, { name: 'test', version: '1' })).not.toBe(lspServerIdentity(semantic, { name: 'test', version: '1' }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('observed protocol capability', () => {
  it('learns an exact MethodNotFound and refuses the next caller before executing', async () => {
    const f = fixture();
    const request = vi.fn(async () => { throw { code: -32601, message: 'not found' }; });
    await expect(requestWithLspCapability(f.store, key, 'textDocument/references', request)).rejects.toThrow(/does not support.*references/);
    expect(f.read()).toMatchObject({ supported: false, source: 'method-not-found' });
    await expect(requestWithLspCapability(f.store, key, 'textDocument/references', request)).rejects.toThrow(/refusing to report no results/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('timeout'), { code: -32603 }, { code: '-32601' }, new Error('MethodNotFound')])(
    'does not infer unsupported from generic or malformed errors (%j)', async error => {
      const f = fixture();
      await expect(requestWithLspCapability(f.store, key, 'textDocument/references', async () => { throw error; })).rejects.toEqual(error);
      expect(f.store.observe).not.toHaveBeenCalled();
    },
  );

  it('learns support from a legitimate empty method result without interpreting completeness', async () => {
    const f = fixture();
    await expect(requestWithLspCapability(f.store, key, 'textDocument/references', async () => [])).resolves.toEqual([]);
    expect(f.read()).toMatchObject({ supported: true, source: 'request-success' });
  });

  it('refuses when the shared lookup fails and preserves failed observation writes', async () => {
    const f = fixture(), request = vi.fn(async () => []);
    vi.mocked(f.store.get).mockRejectedValueOnce(new Error('PG read failed'));
    await expect(requestWithLspCapability(f.store, key, 'textDocument/references', request)).rejects.toThrow('PG read failed');
    expect(request).not.toHaveBeenCalled();
    vi.mocked(f.store.observe).mockRejectedValueOnce(new Error('PG write failed'));
    await expect(requestWithLspCapability(f.store, key, 'textDocument/references', request)).rejects.toThrow('PG write failed');
  });
});
