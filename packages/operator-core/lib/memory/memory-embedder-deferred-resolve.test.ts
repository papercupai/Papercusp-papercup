/**
 * P-532f (extends D-050): RESOLVING the memory embedder must not start the embed
 * sidecar; only a real embed may.
 *
 * Measured on cap-p532f (2026-10-06): after the backfill drained, every tenant's
 * sidecar idle-exited and then came back at each 10-minute embed-backfill tick with
 * zero real embeds. The tick's canonical-memory leg calls activeVecTable() only to
 * NAME the active vec table, which resolves the memory host's embedder, and that
 * resolver's local/gemma/harrier builders were the eager sidecar-aware builder:
 * building it resolved the sidecar URL, which ensures (spawns) the sidecar.
 *
 * This drives the real production path (configure.ts registers the memory host on
 * import; activeVecTable is the real @papercusp/memory export). Only the spawn layer
 * is replaced, so every ensure the wiring makes is observed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => ({
  ensureEmbedSidecar: vi.fn<(caps?: readonly string[]) => Promise<string | null>>(),
}));

vi.mock('./embed-sidecar-spawn', async (importActual) => ({
  ...(await importActual<typeof import('./embed-sidecar-spawn')>()),
  ensureEmbedSidecar: spawn.ensureEmbedSidecar,
  // A packaged Server: the spawn-locally opt-in is on and no explicit URL is set,
  // which is exactly the case where resolving the URL ensures the sidecar.
  embedSidecarEnabled: () => true,
}));

import { activeVecTable, memoryHost, resolveEmbedSidecarUrl } from '@papercusp/memory';
import './configure';
import { setLocalEmbedEngineOverride } from './embed-sidecar-wiring';

beforeEach(() => {
  spawn.ensureEmbedSidecar.mockReset();
  spawn.ensureEmbedSidecar.mockResolvedValue(null);
  vi.stubEnv('PAPERCUSP_MEMORY_EMBEDDER', 'gemma');
  vi.stubEnv('PAPERCUSP_EMBED_SIDECAR_URL', '');
  // Report the local engine as installed without importing transformers. The
  // override returns null, so the sidecar-aware builder still takes its normal
  // URL-resolution path (an override that returned an EmbedFn would skip it).
  setLocalEmbedEngineOverride(() => null);
});

afterEach(() => {
  setLocalEmbedEngineOverride(null);
  vi.unstubAllEnvs();
});

describe('memory host embedder resolution does not start the sidecar (P-532f)', () => {
  it('runs with no explicit sidecar URL, so any URL resolution would ensure', () => {
    expect(resolveEmbedSidecarUrl()).toBeNull();
  });

  it('activeVecTable() names the gemma table without ensuring the sidecar', async () => {
    const active = await activeVecTable();
    // Non-vacuous: the call really resolved an embedder and a table.
    expect(active?.mode).toBe('gemma');
    expect(active?.table).toBeTruthy();
    expect(spawn.ensureEmbedSidecar).not.toHaveBeenCalled();
  });

  it('memoryHost().resolveEmbedder() builds without ensuring the sidecar', async () => {
    const resolved = await memoryHost().resolveEmbedder();
    expect(resolved.mode).toBe('gemma');
    expect(spawn.ensureEmbedSidecar).not.toHaveBeenCalled();
  });

  it('the first real embed is what ensures the sidecar (positive control)', async () => {
    const resolved = await memoryHost().resolveEmbedder();
    if (resolved.mode === 'disabled') throw new Error('expected an enabled embedder');
    spawn.ensureEmbedSidecar.mockRejectedValueOnce(new Error('ensure reached'));
    await expect(resolved.embed('a real document')).rejects.toThrow('ensure reached');
    expect(spawn.ensureEmbedSidecar).toHaveBeenCalledTimes(1);
  });
});
