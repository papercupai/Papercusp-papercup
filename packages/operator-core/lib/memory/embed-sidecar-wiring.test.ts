/**
 * P-004 (shared-embedding-sidecar-and-enrichment-2026-07-10): the one wiring
 * seam between the embedder cascade and the sidecar. Contracts:
 *  - explicit PAPERCUSP_EMBED_SIDECAR_URL wins and never triggers a spawn;
 *  - no URL + opt-in ensure() supplies the URL (lazy spawn/adopt);
 *  - a RESOLVED sidecar is REQUIRED — a dead one throws, no in-process
 *    failover (WI-4021, D-003 retired);
 *  - neither ⇒ pure in-process engine (no sidecar I/O).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  _resetSidecarSkewReportForTests,
  buildSidecarAwareEmbedder,
  buildSidecarAwareReranker,
  resolveProcessSidecarUrl,
} from './embed-sidecar-wiring';
import {
  EMBED_SIDECAR_CAP_EMBED,
  EMBED_SIDECAR_CAP_RERANK,
} from './embed-sidecar-server';

/** Health payload of a CURRENT sidecar — advertises what it serves. */
const CURRENT_HEALTH = {
  ok: true,
  capabilities: ['GET /healthz', EMBED_SIDECAR_CAP_EMBED, EMBED_SIDECAR_CAP_RERANK],
};
/** Health payload of the 16-day-old bundle measured live in
 *  EI-19314150478401738 — 200 OK, warm models, and NO capabilities key. */
const STALE_HEALTH = {
  ok: true,
  pid: 2034810,
  uptimeMs: 1_401_886_441,
  models: { 'gemma:document': 'warm' },
};

const SIDECAR_VECTOR = [0.1, 0.2, 0.3];

async function startStub(): Promise<{ url: string; hits: number[]; close: () => Promise<void> }> {
  const hits: number[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push(1);
      const texts = (JSON.parse(raw) as { texts: string[] }).texts;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ vectors: texts.map(() => SIDECAR_VECTOR), dims: 3, runtime: 'stub', modelRev: 'stub' }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(() => r())) };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('resolveProcessSidecarUrl', () => {
  it('explicit URL wins without calling ensure (no spawn side effect)', async () => {
    let ensured = 0;
    const url = await resolveProcessSidecarUrl({
      resolveUrl: () => 'http://127.0.0.1:9999',
      ensure: async () => {
        ensured++;
        return null;
      },
      probeHealth: async () => CURRENT_HEALTH,
    });
    expect(url).toBe('http://127.0.0.1:9999');
    expect(ensured).toBe(0);
  });

  it('falls through to ensure() when no explicit URL', async () => {
    expect(
      await resolveProcessSidecarUrl({
        resolveUrl: () => null,
        ensure: async () => 'http://127.0.0.1:3384',
        probeHealth: async () => CURRENT_HEALTH,
      }),
    ).toBe('http://127.0.0.1:3384');
    expect(
      await resolveProcessSidecarUrl({
        resolveUrl: () => null,
        ensure: async () => null,
        probeHealth: async () => CURRENT_HEALTH,
      }),
    ).toBeNull();
  });

  it('an UNREACHABLE explicit sidecar still resolves to its URL — an outage must not silently reinstate in-process failover (WI-4021)', async () => {
    // The WHOLE point of D-003's retirement: a configured-but-down sidecar is
    // the client's problem to throw about, NOT a cue to quietly embed
    // in-process. Returning null here would be a worse bug than the skew this
    // file otherwise guards.
    expect(
      await resolveProcessSidecarUrl(
        { resolveUrl: () => 'http://127.0.0.1:9999', ensure: async () => null, probeHealth: async () => null },
        [EMBED_SIDECAR_CAP_EMBED],
      ),
    ).toBe('http://127.0.0.1:9999');
  });

  describe('capability verification on the EXPLICIT-URL path (EI-19314150478401738)', () => {
    // This is the path the live box actually uses
    // (PAPERCUSP_EMBED_SIDECAR_URL is set in papercup-dev-api.service), and
    // before this fix it did NO check at all — not even liveness.
    afterEach(() => _resetSidecarSkewReportForTests());

    it('a pre-capability STALE sidecar is still used for /embed (no embedding regression)', async () => {
      // The 16-day-old bundle serves /embed perfectly well. Refusing the whole
      // sidecar because it cannot do /rerank would break embedding fleet-wide.
      expect(
        await resolveProcessSidecarUrl(
          {
            resolveUrl: () => 'http://127.0.0.1:3384',
            ensure: async () => null,
            probeHealth: async () => STALE_HEALTH,
          },
          [EMBED_SIDECAR_CAP_EMBED],
        ),
      ).toBe('http://127.0.0.1:3384');
    });

    it('a pre-capability STALE sidecar is REFUSED for /rerank instead of 404ing forever', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(
          await resolveProcessSidecarUrl(
            {
              resolveUrl: () => 'http://127.0.0.1:3384',
              ensure: async () => null,
              probeHealth: async () => STALE_HEALTH,
            },
            [EMBED_SIDECAR_CAP_RERANK],
          ),
        ).toBeNull();
        // Loud + actionable, and the remedy must be a REAL command. The unit's
        // ExecStartPre re-bundles the entry, so restarting it IS the fix —
        // an earlier draft of this message invented `npm run
        // build:embed-sidecar`, which does not exist in any package.json.
        const msg = errSpy.mock.calls.flat().join(' ');
        expect(msg).toMatch(/VERSION SKEW/);
        expect(msg).toMatch(/POST \/rerank/);
        expect(msg).toMatch(/systemctl --user restart papercup-embed-sidecar\.service/);
        expect(msg).not.toMatch(/npm run build:embed-sidecar/);
      } finally {
        errSpy.mockRestore();
      }
    });

    it('a CURRENT sidecar that advertises /rerank is used', async () => {
      expect(
        await resolveProcessSidecarUrl(
          {
            resolveUrl: () => 'http://127.0.0.1:3384',
            ensure: async () => null,
            probeHealth: async () => CURRENT_HEALTH,
          },
          [EMBED_SIDECAR_CAP_RERANK],
        ),
      ).toBe('http://127.0.0.1:3384');
    });

    it('a sidecar that advertises a list WITHOUT the needed route is refused', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(
          await resolveProcessSidecarUrl(
            {
              resolveUrl: () => 'http://127.0.0.1:3384',
              ensure: async () => null,
              probeHealth: async () => ({ ok: true, capabilities: ['GET /healthz', EMBED_SIDECAR_CAP_EMBED] }),
            },
            [EMBED_SIDECAR_CAP_RERANK],
          ),
        ).toBeNull();
      } finally {
        errSpy.mockRestore();
      }
    });

    it('logs the skew ONCE per condition, not per call', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const deps = {
          resolveUrl: () => 'http://127.0.0.1:3384',
          ensure: async () => null,
          probeHealth: async () => STALE_HEALTH,
        };
        for (let i = 0; i < 5; i++) await resolveProcessSidecarUrl(deps, [EMBED_SIDECAR_CAP_RERANK]);
        expect(errSpy).toHaveBeenCalledTimes(1);
      } finally {
        errSpy.mockRestore();
      }
    });

    it('the reranker seam requires /rerank — so a stale sidecar degrades it to the in-process cross-encoder, not to nothing', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        let requested: readonly string[] | null = null;
        await buildSidecarAwareReranker('rerank', {
          resolveUrl: () => 'http://127.0.0.1:3384',
          ensure: async () => null,
          probeHealth: async () => {
            requested = [EMBED_SIDECAR_CAP_RERANK];
            return STALE_HEALTH;
          },
        });
        // It probed, and it asked about the rerank route specifically.
        expect(requested).toEqual([EMBED_SIDECAR_CAP_RERANK]);
      } finally {
        errSpy.mockRestore();
      }
    });
  });
});

describe('buildSidecarAwareEmbedder', () => {
  it.each([undefined, 120_000])('retains the foreground bound and forwards an accepted inference budget: %s', async timeoutMs => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const embed = await buildSidecarAwareEmbedder('gemma', 'query', {
        resolveUrl: () => 'http://127.0.0.1:3384', ensure: async () => null,
        probeHealth: async () => CURRENT_HEALTH,
      }, { timeoutMs });
      const pending = embed('  exact query text  ');
      const rejected = expect(pending).rejects.toThrow('sidecar_required_unavailable');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(signal!.aborted).toBe(timeoutMs === undefined);
      if (timeoutMs !== undefined) await vi.advanceTimersByTimeAsync(105_000);
      await rejected;
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
        model: 'gemma', kind: 'query', texts: ['  exact query text  '],
      });
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('embeds through the sidecar when a URL resolves', async () => {
    const stub = await startStub();
    closers.push(stub.close);
    const embed = await buildSidecarAwareEmbedder('gemma', 'query', {
      resolveUrl: () => stub.url,
      ensure: async () => null,
      probeHealth: async () => CURRENT_HEALTH,
    });
    expect(await embed('hello')).toEqual(SIDECAR_VECTOR);
    expect(stub.hits.length).toBe(1);
  });

  it('dead sidecar URL ⇒ THROWS sidecar_required_unavailable — never loads an in-process model (WI-4021)', async () => {
    // EI-20006179456846006: the transition is reported on console.LOG under a
    // test runner, so this spy is belt-and-braces rather than the subject; the
    // dedicated case below pins the channel itself.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const stub = await startStub();
      await stub.close(); // now a dead port
      const embed = await buildSidecarAwareEmbedder('gemma', 'document', {
        resolveUrl: () => null,
        ensure: async () => stub.url,
        probeHealth: async () => CURRENT_HEALTH,
      });
      // A resolved-but-dead sidecar must reject loudly (D-003 retired): if this
      // ever silently falls back to a real in-process gemma load again, this
      // rejects-assertion fails instead of a 384-dim vector appearing.
      await expect(embed('x')).rejects.toThrow(/sidecar_required_unavailable/);
      // The transition IS still reported — just not on a channel that fails builds.
      expect(logSpy.mock.calls.map((c) => String(c[0] ?? '')).some((m) => m.includes('[sidecar-embedder]'))).toBe(
        true,
      );
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  }, 30_000);

  // EI-20006179456846006. A sidecar availability TRANSITION is INFRASTRUCTURE
  // state, not a statement about whatever test happens to be executing when it
  // flips. Reported through the generic lib's DEFAULT onTransition it lands on
  // console.warn, and `vitest-fail-on-console` then reds an arbitrary victim —
  // measured killing a RANKING diagnostic in owner-query-relevance.integration
  // .test.ts when the :3384 sidecar recovered mid-run. Two properties make that
  // maximally expensive: the victim is unrelated to the subject (so a triager
  // hunts a ranking regression), and it cannot reproduce on re-run (so it gets
  // dismissed as flaky and comes back at a worse hour).
  //
  // The fix is a CHANNEL change at THIS seam — the host, not the shared lib,
  // decides how its own environment reports infrastructure state. It is asserted
  // by driving a REAL transition through the real wiring (a dead port), not by
  // inspecting the injected callback: a fix that lands only on a seam production
  // does not take is the failure mode this file is most exposed to.
  it('reports a sidecar transition on console.LOG, never console.warn, under a test runner', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const stub = await startStub();
      await stub.close(); // dead port ⇒ a genuine down-transition
      const embed = await buildSidecarAwareEmbedder('gemma', 'document', {
        resolveUrl: () => null,
        ensure: async () => stub.url,
        probeHealth: async () => CURRENT_HEALTH,
      });
      await expect(embed('x')).rejects.toThrow(/sidecar_required_unavailable/);

      const warned = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
      const logged = logSpy.mock.calls.map((c) => String(c[0] ?? ''));

      // CALIBRATION first: prove the transition was actually reported, so the
      // console.warn assertion below cannot pass merely because nothing happened.
      expect(logged.filter((m) => m.includes('[sidecar-embedder]'))).not.toHaveLength(0);
      expect(warned.filter((m) => m.includes('[sidecar-embedder]'))).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  }, 30_000);
});
