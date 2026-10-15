/**
 * D-050 (P-532c): a deferred sidecar-aware embedder must not ensure (spawn) the
 * embed sidecar when it is BUILT, only when it EMBEDS.
 *
 * Measured on cap-p532c (3 tenants, 2 h): after the backfill drained, each tenant's
 * ~2 GB sidecar still came back about every 10 min with zero real embeds, because
 * the 5-min backfill sweep rebuilt its embedder every tick and the eager builder
 * resolves the sidecar URL, which ensures the sidecar.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildDeferredSidecarAwareEmbedder, processSidecarConfigured } from './embed-sidecar-wiring';

const SIDECAR_VECTOR = [0.4, 0.5, 0.6];

async function startStub(): Promise<{ url: string; hits: number[]; close: () => Promise<void> }> {
  const hits: number[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push(1);
      const texts = (JSON.parse(raw) as { texts: string[] }).texts;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ vectors: texts.map(() => SIDECAR_VECTOR), dims: 3, runtime: 'stub', modelRev: 'stub' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildDeferredSidecarAwareEmbedder (D-050)', () => {
  it('does not ensure the sidecar when built; the first embed does', async () => {
    const stub = await startStub();
    try {
      const ensure = vi.fn(async () => stub.url);
      const embed = buildDeferredSidecarAwareEmbedder('gemma', 'document', {
        resolveUrl: () => null,
        ensure,
        probeHealth: async () => null,
      });
      // Let any build-time microtasks run: an eager builder would have ensured by now.
      await new Promise((r) => setTimeout(r, 20));
      expect(ensure).not.toHaveBeenCalled();
      expect(stub.hits).toHaveLength(0);

      expect(await embed('hello')).toEqual(SIDECAR_VECTOR);
      expect(ensure).toHaveBeenCalled();
      expect(stub.hits).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  it('does not cache a failed first build: the next embed retries it', async () => {
    const stub = await startStub();
    try {
      let calls = 0;
      const ensure = vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('spawn failed');
        return stub.url;
      });
      const embed = buildDeferredSidecarAwareEmbedder('gemma', 'document', {
        resolveUrl: () => null,
        ensure,
        probeHealth: async () => null,
      });
      await expect(embed('first')).rejects.toThrow(/spawn failed/);
      expect(await embed('second')).toEqual(SIDECAR_VECTOR);
      expect(stub.hits).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  it('an already-aborted call rejects without building', async () => {
    const ensure = vi.fn(async () => 'http://127.0.0.1:9');
    const embed = buildDeferredSidecarAwareEmbedder('gemma', 'document', {
      resolveUrl: () => null,
      ensure,
      probeHealth: async () => null,
    });
    const ac = new AbortController();
    ac.abort();
    await expect(embed('x', ac.signal)).rejects.toThrow();
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe('processSidecarConfigured (D-050)', () => {
  it('is true for an explicit sidecar URL', () => {
    vi.stubEnv('PAPERCUSP_EMBED_SIDECAR', '0');
    expect(processSidecarConfigured({ resolveUrl: () => 'http://127.0.0.1:9' })).toBe(true);
  });

  it('is true when the spawn-locally opt-in is on, with no URL', () => {
    vi.stubEnv('PAPERCUSP_EMBED_SIDECAR', '1');
    expect(processSidecarConfigured({ resolveUrl: () => null })).toBe(true);
  });

  it('is false with no URL and the opt-in explicitly off', () => {
    vi.stubEnv('PAPERCUSP_EMBED_SIDECAR', '0');
    expect(processSidecarConfigured({ resolveUrl: () => null })).toBe(false);
  });
});
