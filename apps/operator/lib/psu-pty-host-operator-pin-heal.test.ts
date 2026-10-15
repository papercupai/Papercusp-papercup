/**
 * healDeadOperatorPin — the in-place-respawn heal for a dead operator pin
 * (EI-24091823697677465).
 *
 * Measured 2026-09-23: a session launched from a staging console inherited
 * PAPERCUSP_OPERATOR_URL=http://localhost:3170 and carried it through every in-place
 * carry-respawn, because nothing re-checked the pin between respawns. Each staging
 * restart then took the session's MCP tools and its owner-directive capture down.
 *
 * The rule under test is deliberately narrow, and both halves matter:
 *   - a managed pin that REFUSES the connection is replaced by a healthy local proxy;
 *   - an explicit pin stays authoritative even when it refuses connections;
 *   - a pin that answers at all — even with an error, even slowly — is ALIVE and stays
 *     authoritative, so a live staging session is never silently moved to green.
 *
 * The cases use real loopback sockets for the pin, so the refusal is recognised from
 * the error shape Node's fetch actually produces, not from a hand-built stand-in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { healDeadOperatorPin } from '../scripts/psu-pty-host.mjs';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      // The "slow" stub never answers; drop its held socket so close() can finish.
      s.closeAllConnections();
      return new Promise<void>((r) => s.close(() => r()));
    }),
  );
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

const healthyProxy = () =>
  serve((req, res) => {
    const status = req.url === '/api/health' ? 200 : req.url === '/api/mcp' ? 405 : 404;
    res.writeHead(status);
    res.end('ok');
  });

/** A loopback port with nothing listening: bind an ephemeral port, then free it. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('healDeadOperatorPin (EI-24091823697677465)', () => {
  it('a managed pin that REFUSES the connection is replaced by the healthy proxy', async () => {
    const proxyPort = await healthyProxy();
    const pinned = `http://localhost:${await deadPort()}`;
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: pinned,
      PAPERCUSP_MCP_PROXY_PORT: String(proxyPort),
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    };

    const healed = await healDeadOperatorPin(env);

    expect(healed).toEqual({ from: pinned, to: `http://127.0.0.1:${proxyPort}` });
    expect(env.PAPERCUSP_OPERATOR_URL).toBe(`http://127.0.0.1:${proxyPort}`);
    // Now a launcher decision, so a later wake may rediscover instead of treating it
    // as the caller's fixed pin.
    expect(env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBe('psu-launcher');
  });

  it('heals a launcher-managed URL that is healthy HTTP but has no MCP route', async () => {
    const proxyPort = await healthyProxy();
    const pinPort = await serve((req, res) => {
      res.writeHead(req.url === '/api/health' ? 200 : 404);
      res.end('ok');
    });
    const pinned = `http://127.0.0.1:${pinPort}`;
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: pinned,
      PAPERCUSP_MCP_PROXY_PORT: String(proxyPort),
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    };

    const healed = await healDeadOperatorPin(env);

    expect(healed).toEqual({
      from: pinned,
      to: `http://127.0.0.1:${proxyPort}`,
      route: 'mcp-route-missing',
    });
    expect(env.PAPERCUSP_OPERATOR_URL).toBe(`http://127.0.0.1:${proxyPort}`);
  });

  it('keeps a healthy MCP endpoint and refuses a proxy without the MCP route', async () => {
    const healthyPinPort = await serve((req, res) => {
      res.writeHead(req.url === '/api/health' ? 200 : req.url === '/api/mcp' ? 405 : 404);
      res.end('ok');
    });
    const healthyPin = `http://127.0.0.1:${healthyPinPort}`;
    const healthyPinEnv: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: healthyPin,
      PAPERCUSP_MCP_PROXY_PORT: String(await healthyProxy()),
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    };
    expect(await healDeadOperatorPin(healthyPinEnv)).toBeNull();
    expect(healthyPinEnv.PAPERCUSP_OPERATOR_URL).toBe(healthyPin);

    const proxyPort = await serve((req, res) => {
      res.writeHead(req.url === '/api/health' ? 200 : 404);
      res.end('ok');
    });
    const pinPort = await serve((req, res) => {
      res.writeHead(req.url === '/api/health' ? 200 : 404);
      res.end('ok');
    });
    const pinned = `http://127.0.0.1:${pinPort}`;
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: pinned,
      PAPERCUSP_MCP_PROXY_PORT: String(proxyPort),
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    };

    expect(await healDeadOperatorPin(env)).toBeNull();
    expect(env.PAPERCUSP_OPERATOR_URL).toBe(pinned);
  });

  it.each([undefined, 'unknown'])('preserves a refused explicit pin with provenance %s', async (provenance) => {
    const proxyPort = await healthyProxy();
    const pinned = `http://127.0.0.1:${await deadPort()}`;
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: pinned,
      PAPERCUSP_MCP_PROXY_PORT: String(proxyPort),
      ...(provenance ? { PAPERCUSP_OPERATOR_URL_PROVENANCE: provenance } : {}),
    };
    const before = { ...env };
    expect(await healDeadOperatorPin(env)).toBeNull();
    expect(env).toEqual(before);
  });

  it('a pin that ANSWERS with an error is alive and stays', async () => {
    const proxyPort = await healthyProxy();
    const pinPort = await serve((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${pinPort}`,
      PAPERCUSP_MCP_PROXY_PORT: String(proxyPort),
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    };

    expect(await healDeadOperatorPin(env)).toBeNull();
    expect(env.PAPERCUSP_OPERATOR_URL).toBe(`http://127.0.0.1:${pinPort}`);
    expect(env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBe('psu-launcher');
  });

  it('a pin that is merely SLOW (times out) is alive and stays', async () => {
    const proxyPort = await healthyProxy();
    const pinPort = await serve(() => {
      /* never answers */
    });
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${pinPort}`,
      PAPERCUSP_MCP_PROXY_PORT: String(proxyPort),
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    };

    expect(await healDeadOperatorPin(env, { timeoutMs: 200 })).toBeNull();
    expect(env.PAPERCUSP_OPERATOR_URL).toBe(`http://127.0.0.1:${pinPort}`);
  });

  it('a dead pin stays when the proxy is ALSO dead — never swap to an unverified address', async () => {
    const pinned = `http://127.0.0.1:${await deadPort()}`;
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: pinned,
      PAPERCUSP_MCP_PROXY_PORT: String(await deadPort()),
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    };

    expect(await healDeadOperatorPin(env)).toBeNull();
    expect(env.PAPERCUSP_OPERATOR_URL).toBe(pinned);
  });

  it('never probes a pin to ANOTHER host, a pin that already IS the proxy, an opted-out proxy, or no pin', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'));
    const cases: Array<Record<string, string>> = [
      { PAPERCUSP_OPERATOR_URL: 'http://operator.example:3170' },
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071' },
      { PAPERCUSP_OPERATOR_URL: 'http://localhost:3170', PAPERCUSP_MCP_PROXY: '0' },
      {},
    ];
    for (const env of cases) {
      env.PAPERCUSP_OPERATOR_URL_PROVENANCE = 'psu-launcher';
      const before = { ...env };
      expect(await healDeadOperatorPin(env, { fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
      expect(env).toEqual(before);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/**
 * WI-10004511: the staging route. A direct :3170 pin rides the same-build staging
 * proxy. The proxy forwards `/api/health` to :3170, so during a staging restart that
 * path fails while the proxy itself is up. Measured 2026-10-01: :9171/__mcp_proxy_health
 * 200, :9171/api/health 000, and a respawned session launched straight into a refused
 * :3170. The heal must judge the PROXY's liveness, as the launcher's probe does.
 */
describe('healDeadOperatorPin staging route (WI-10004511)', () => {
  const STAGING_PIN = 'http://127.0.0.1:3170';

  /** A staging proxy whose upstream (:3170) is down: own liveness 200, forwarded routes 502. */
  const proxyWithUpstreamDown = () =>
    serve((req, res) => {
      res.writeHead(req.url === '/__mcp_proxy_health' ? 200 : 502);
      res.end();
    });

  it('reroutes a direct :3170 pin while the proxy is up and its upstream is restarting', async () => {
    const stagingProxyPort = await proxyWithUpstreamDown();
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: STAGING_PIN,
      PAPERCUSP_MCP_STAGING_PROXY_PORT: String(stagingProxyPort),
    };

    const healed = await healDeadOperatorPin(env);

    expect(healed).toEqual({
      from: STAGING_PIN,
      to: `http://127.0.0.1:${stagingProxyPort}`,
      route: 'staging-proxy',
    });
    expect(env.PAPERCUSP_OPERATOR_URL).toBe(`http://127.0.0.1:${stagingProxyPort}`);
    expect(env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBeUndefined();
  });

  it('still reroutes through a proxy that only answers /api/health (no liveness route)', async () => {
    const stagingProxyPort = await healthyProxy();
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: STAGING_PIN,
      PAPERCUSP_MCP_STAGING_PROXY_PORT: String(stagingProxyPort),
    };

    expect((await healDeadOperatorPin(env))?.to).toBe(`http://127.0.0.1:${stagingProxyPort}`);
  });

  it('keeps the direct pin when the staging proxy is dead or answers neither route', async () => {
    const deadProxy = await deadPort();
    const refusingProxy = await serve((_req, res) => {
      res.writeHead(502);
      res.end();
    });
    for (const port of [deadProxy, refusingProxy]) {
      const env: Record<string, string> = {
        PAPERCUSP_OPERATOR_URL: STAGING_PIN,
        PAPERCUSP_MCP_STAGING_PROXY_PORT: String(port),
      };
      expect(await healDeadOperatorPin(env, { timeoutMs: 500 })).toBeNull();
      expect(env.PAPERCUSP_OPERATOR_URL).toBe(STAGING_PIN);
    }
  });

  it('honours PAPERCUSP_MCP_STAGING_PROXY=0', async () => {
    const stagingProxyPort = await proxyWithUpstreamDown();
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL: STAGING_PIN,
      PAPERCUSP_MCP_STAGING_PROXY_PORT: String(stagingProxyPort),
      PAPERCUSP_MCP_STAGING_PROXY: '0',
    };
    expect(await healDeadOperatorPin(env)).toBeNull();
    expect(env.PAPERCUSP_OPERATOR_URL).toBe(STAGING_PIN);
  });
});
