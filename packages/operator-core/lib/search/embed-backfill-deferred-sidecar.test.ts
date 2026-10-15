/**
 * D-050 (P-532c): the 5-min embed backfill sweep must not bring the embed sidecar
 * up just to discover it has nothing to embed.
 *
 * Measured on cap-p532c (3 tenants, 2 h): once the backfill drained, each tenant's
 * sidecar still came back about every 10 min with zero real embeds. Each sweep
 * resolved its embedder AND its batch embedder eagerly, and resolving the sidecar
 * URL ensures (spawns) the sidecar. These cases pin both seams: resolving touches
 * no sidecar; only an actual batch does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const wiring = vi.hoisted(() => ({
  resolveProcessSidecarUrl: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
  processSidecarConfigured: vi.fn<() => boolean>(),
  buildDeferredSidecarAwareEmbedder: vi.fn(),
}));

vi.mock('../memory/embed-sidecar-wiring', async (importActual) => ({
  ...(await importActual<typeof import('../memory/embed-sidecar-wiring')>()),
  ...wiring,
}));
vi.mock('../memory/configure', async (importActual) => ({
  ...(await importActual<typeof import('../memory/configure')>()),
  readEmbedderPreference: async () => 'gemma',
  localAvailable: async () => true,
}));
vi.mock('../credentials', () => ({
  readCredentials: async () => ({}),
}));

import { __sweepStateForTest, proseBackfillSweeperConfig } from './embed-backfill';

beforeEach(() => {
  wiring.resolveProcessSidecarUrl.mockReset().mockResolvedValue(null);
  wiring.processSidecarConfigured.mockReset().mockReturnValue(true);
  wiring.buildDeferredSidecarAwareEmbedder.mockReset().mockImplementation(() => async () => [0.1, 0.2]);
});

describe('embed backfill sweep resolution never ensures the embed sidecar (D-050)', () => {
  it('resolves its embedder through the DEFERRED builder and never resolves the sidecar URL', async () => {
    const cfg = proseBackfillSweeperConfig(__sweepStateForTest());
    const resolved = await cfg.resolveEmbedder();
    expect(['gemma', 'local', 'harrier']).toContain(resolved.mode);
    expect(wiring.buildDeferredSidecarAwareEmbedder).toHaveBeenCalledWith(resolved.mode, 'document');
    expect(wiring.resolveProcessSidecarUrl).not.toHaveBeenCalled();
  });

  it('resolves a batch embedder without touching the sidecar; only a batch call does', async () => {
    const cfg = proseBackfillSweeperConfig(__sweepStateForTest());
    const embedMany = await cfg.resolveBatchEmbed!('gemma');
    expect(embedMany).toBeTypeOf('function');
    expect(wiring.resolveProcessSidecarUrl).not.toHaveBeenCalled();

    // No sidecar at batch time: the batch throws, and the drain's existing
    // batch-failure handling falls back to the per-row path.
    await expect(embedMany!(['a', 'b'])).rejects.toThrow(/no embed sidecar/);
    expect(wiring.resolveProcessSidecarUrl).toHaveBeenCalledTimes(1);
  });

  it('returns no batch embedder, and resolves nothing, when this process has no sidecar story', async () => {
    wiring.processSidecarConfigured.mockReturnValue(false);
    const cfg = proseBackfillSweeperConfig(__sweepStateForTest());
    expect(await cfg.resolveBatchEmbed!('gemma')).toBeNull();
    expect(wiring.resolveProcessSidecarUrl).not.toHaveBeenCalled();
  });

  it('never batches the OpenAI leg', async () => {
    const cfg = proseBackfillSweeperConfig(__sweepStateForTest());
    expect(await cfg.resolveBatchEmbed!('openai')).toBeNull();
    expect(wiring.processSidecarConfigured).not.toHaveBeenCalled();
  });
});
