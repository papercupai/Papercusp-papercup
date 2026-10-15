/**
 * P-532b (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10005630). Measured on GCP
 * cap-p532 / cap-p532b: service-health's functional embed-sidecar probe (a POST /embed every
 * minute, a cache-bypassing one every 5 minutes) kept every packaged Server's per-tenant
 * sidecar from ever reaching its 5-minute idle exit, so the ~2.3 GB model never left memory.
 *
 * These tests pin both halves of the fix END TO END (the real probe against the real sidecar
 * server, with an injected embedder so no model loads): the probe marks its request, the
 * sidecar leaves its idle clock alone for a marked request, and a sidecar that exits idle
 * while a probe runs reads "not running" while a crash still reads DOWN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnState = vi.hoisted(() => ({ url: null as string | null, idle: [false] as boolean[] }));

vi.mock('./memory/embed-sidecar-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./memory/embed-sidecar-spawn')>();
  return {
    ...actual,
    embedSidecarEnabled: () => true,
    embedSidecarLocalUrl: () => spawnState.url,
    // Successive answers, the last one repeating: lets a test flip the sidecar to
    // "exited idle" between the probe's pre-check and its failure path.
    embedSidecarIdleByDesign: () => (spawnState.idle.length > 1 ? spawnState.idle.shift()! : spawnState.idle[0]!),
  };
});

import { probeEmbedSidecar } from './service-health';
import { createEmbedSidecarServer, type EmbedSidecarHandle } from './memory/embed-sidecar-server';

describe('probeEmbedSidecar vs the per-tenant sidecar idle exit (P-532b)', () => {
  const savedUrl = process.env.PAPERCUSP_EMBED_SIDECAR_URL;
  let handle: EmbedSidecarHandle | null = null;

  beforeEach(() => {
    delete process.env.PAPERCUSP_EMBED_SIDECAR_URL;
    spawnState.url = null;
    spawnState.idle = [false];
  });
  afterEach(async () => {
    await handle?.close();
    handle = null;
    if (savedUrl === undefined) delete process.env.PAPERCUSP_EMBED_SIDECAR_URL;
    else process.env.PAPERCUSP_EMBED_SIDECAR_URL = savedUrl;
    vi.restoreAllMocks();
  });

  async function bootSidecar(): Promise<void> {
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      concurrency: 1,
      builders: { gemma: async () => async () => [1, ...Array(767).fill(0)] },
      embedDevice: { load: async () => ({ setting: null, changed: false, readError: null }) },
    });
    spawnState.url = `http://127.0.0.1:${await handle.listening}`;
  }

  for (const exercise of [false, true]) {
    it(`a real sidecar answers the ${exercise ? 'cache-bypassing' : 'cached'} probe without refreshing its idle clock`, async () => {
      await bootSidecar();
      const before = handle!.activity();
      await new Promise((r) => setTimeout(r, 20));
      const r = await probeEmbedSidecar(5_000, { exercise });
      expect(r.up, r.note).toBe(true);
      expect(r).not.toHaveProperty('present', false);
      const after = handle!.activity();
      expect(after.inFlight).toBe(0);
      expect(after.lastActivityAt).toBe(before.lastActivityAt);
    });
  }

  it('control: a real embed through the same server DOES refresh the idle clock', async () => {
    await bootSidecar();
    const before = handle!.activity();
    await new Promise((r) => setTimeout(r, 20));
    const res = await fetch(`${spawnState.url}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma', kind: 'query', texts: ['real work'] }),
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 20));
    expect(handle!.activity().lastActivityAt).toBeGreaterThan(before.lastActivityAt);
  });

  it('reports a sidecar that exits idle while the probe runs as not running, not DOWN', async () => {
    spawnState.url = 'http://127.0.0.1:1'; // refuses: the child is gone
    spawnState.idle = [false, true]; // live at the pre-check, idle by the failure
    const r = await probeEmbedSidecar(1_000, { exercise: false });
    expect(r).toMatchObject({ up: true, present: false });
    expect(String(r.note)).toContain('exited idle');
  });

  it('still reports a sidecar that died without an idle exit as DOWN', async () => {
    spawnState.url = 'http://127.0.0.1:1';
    spawnState.idle = [false];
    const r = await probeEmbedSidecar(1_000, { exercise: false });
    expect(r.up).toBe(false);
    expect(String(r.note)).toContain('DOWN');
  });

  it('does not probe at all while the sidecar is idle by design', async () => {
    spawnState.url = 'http://127.0.0.1:1';
    spawnState.idle = [true];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await probeEmbedSidecar(1_000, { exercise: false });
    expect(r).toMatchObject({ up: true, present: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
