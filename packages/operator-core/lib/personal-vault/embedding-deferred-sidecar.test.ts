/**
 * WI-10005962 (P-532d): the personal-vault embed backfill must not ensure (spawn) the
 * embed sidecar unless a document actually needs embedding.
 *
 * Measured on cap-p532d (3 tenants, .deb with the D-050 deferred prose sweep): after
 * the backfill drained, each tenant's ~2 GB sidecar still came back about every
 * 10 min with zero real embeds. Every respawn started ~100 ms after the prose sweep's
 * `drain: … drained 14/14` line, which is where runEmbedBackfillOnce calls
 * runPersonalVaultEmbedBackfillOnce. That pass built its document embedder eagerly,
 * and the eager builder resolves the sidecar URL, which ensures the sidecar.
 *
 * The calibration case (one pending document) proves this harness can see an ensure
 * call, so the zero-row case cannot pass vacuously.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const h = vi.hoisted(() => ({
  ensure: vi.fn(async (_caps: readonly string[]): Promise<string | null> => null),
  pendingRows: 0,
  embedded: [] as number[][],
}));

vi.mock('../memory/embed-sidecar-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../memory/embed-sidecar-spawn')>();
  return {
    ...actual,
    // The spawn-locally opt-in is ON (a packaged Server): resolving the sidecar means ensuring it.
    embedSidecarEnabled: () => true,
    ensureEmbedSidecar: h.ensure,
    probeSidecarHealth: async () => null,
  };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    // The only direct query is the documents column probe.
    sql: async () => [{ column_name: 'embedding' }, { column_name: 'embedding_mode' }],
  }),
}));

vi.mock('../search/embed-backfill', () => ({
  // Stands in for the real row scan: embeds one text per pending row, nothing when drained.
  backfillTable: vi.fn(async (_sql: unknown, target: { table: string }, opts: { embed: (t: string) => Promise<number[]> }) => {
    for (let i = 0; i < h.pendingRows; i += 1) h.embedded.push(await opts.embed(`doc ${i}`));
    return { table: target.table, scanned: h.pendingRows, embedded: h.pendingRows, errors: 0, durationMs: 0 };
  }),
}));

import { runPersonalVaultEmbedBackfillOnce } from './embedding';

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

beforeEach(() => {
  // No explicit sidecar URL: the only route to a sidecar is ensuring (spawning) one.
  vi.stubEnv('PAPERCUSP_EMBED_SIDECAR_URL', '');
  h.ensure.mockReset();
  h.pendingRows = 0;
  h.embedded = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runPersonalVaultEmbedBackfillOnce sidecar laziness (WI-10005962)', () => {
  it('does not ensure the embed sidecar on a tick with no pending documents', async () => {
    h.ensure.mockImplementation(async () => 'http://127.0.0.1:9');
    const r = await runPersonalVaultEmbedBackfillOnce();
    expect(r).toMatchObject({ scanned: 0, embedded: 0 });
    // Let any build-time microtasks settle: an eager builder would have ensured by now.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('calibration: a pending document does ensure the sidecar and embeds through it', async () => {
    const stub = await startStub();
    try {
      h.ensure.mockImplementation(async () => stub.url);
      h.pendingRows = 1;
      const r = await runPersonalVaultEmbedBackfillOnce();
      expect(r).toMatchObject({ scanned: 1, embedded: 1 });
      expect(h.ensure).toHaveBeenCalled();
      expect(stub.hits.length).toBeGreaterThanOrEqual(1);
      expect(h.embedded).toEqual([SIDECAR_VECTOR]);
    } finally {
      await stub.close();
    }
  });
});
