/**
 * P-530 (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10005523): a Server
 * with PAPERCUSP_EMBED_SIDECAR=1 and no explicit port spawns its sidecar on
 * demand, on an ephemeral port. When none is running (never started, or it
 * exited idle under P-531), there is no address to probe. The health probe
 * must report that as "not present", not as an outage, and must not probe
 * the old shared port 3384, which may belong to another tenant.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeEmbedSidecar } from './service-health';

describe('probeEmbedSidecar with an on-demand sidecar that is not running (P-530)', () => {
  const keys = ['PAPERCUSP_EMBED_SIDECAR', 'PAPERCUSP_EMBED_SIDECAR_URL', 'PAPERCUSP_EMBED_SIDECAR_PORT', 'PAPERCUSP_HOME'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'p530-health-'));
    process.env.PAPERCUSP_EMBED_SIDECAR = '1';
    delete process.env.PAPERCUSP_EMBED_SIDECAR_URL;
    delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
    process.env.PAPERCUSP_HOME = home; // empty data dir: no sidecar record
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports not-present and probes nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await probeEmbedSidecar(500, { exercise: false });
    expect(r).toMatchObject({ up: true, present: false });
    expect(String((r as { note?: string }).note)).toContain('spawned on demand');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
