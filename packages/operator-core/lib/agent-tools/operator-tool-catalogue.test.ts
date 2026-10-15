import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readPinnedModuleState } from '@papercusp/module-singleton';
import { loadOperatorToolCatalogue, markOperatorToolCatalogueLoaded } from './operator-tool-catalogue';

beforeEach(() => {
  const state = readPinnedModuleState<{ loaded: boolean; loading: Promise<void> | null }>(
    '@papercusp/operator-core.operator-tool-catalogue',
  )!;
  state.loaded = false;
  state.loading = null;
});

describe('operator catalogue registration across HTTP/native module records', () => {
  it('does not re-import the catalogue after static HTTP registration completes', async () => {
    markOperatorToolCatalogueLoaded();
    const nativeLoad = vi.fn(async () => { throw new Error('redundant catalogue import'); });
    // A second evaluated helper must observe the first record's completion.
    vi.resetModules();
    const native = await import('./operator-tool-catalogue');
    await expect(native.loadOperatorToolCatalogue(nativeLoad)).resolves.toBeUndefined();
    expect(nativeLoad).not.toHaveBeenCalled();
  });

  it('coalesces concurrent lazy requests and waits for the complete catalogue', async () => {
    let finish!: () => void;
    const load = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const http = loadOperatorToolCatalogue(load);
    vi.resetModules();
    const native = await import('./operator-tool-catalogue');
    const redundant = vi.fn(async () => {});
    const uds = native.loadOperatorToolCatalogue(redundant);
    expect(uds).toBe(http);
    let ready = false;
    void uds.then(() => { ready = true; });
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    expect(redundant).not.toHaveBeenCalled();
    expect(ready).toBe(false);
    finish();
    await http;
    await expect(native.loadOperatorToolCatalogue(redundant)).resolves.toBeUndefined();
    expect(redundant).not.toHaveBeenCalled();
  });

  it('does not treat a failed registration as complete and retries the next request', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('catalogue registration failed'))
      .mockResolvedValueOnce(undefined);
    await expect(loadOperatorToolCatalogue(load)).rejects.toThrow('catalogue registration failed');
    await expect(loadOperatorToolCatalogue(load)).resolves.toBeUndefined();
    await loadOperatorToolCatalogue(load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('records static completion only at the end of the full catalogue barrel', () => {
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(index.trim().endsWith('markOperatorToolCatalogueLoaded();')).toBe(true);
    expect(index.match(/markOperatorToolCatalogueLoaded\(\);/g)).toHaveLength(1);
    const host = readFileSync(new URL('../endpoint-route/routes/transport/_mcp-host.ts', import.meta.url), 'utf8');
    expect(host).toContain("return loadOperatorToolCatalogue(() => import('../../../agent-tools/index'));");
    expect(host).not.toContain('let operatorToolsLoad:');
  });
});
