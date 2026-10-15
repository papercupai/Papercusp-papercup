/**
 * WI-10005688 — the MCP proxy refuses a loopback caller of another uid before anything is
 * forwarded, exactly as the inference gateway does (WI-10003621). The proxy injects the
 * superuser bearer, so on a host where loopback is shared with another account (a hosted
 * workspace host, a vm-release Server, several tenants' Servers on one Linux box) forwarding a
 * foreign caller would act as this Server's service account.
 *
 * The real-resolver cases drive the gate through `foreignLoopbackPeerForSocket` against the live
 * `/proc/net/tcp{,6}` of this machine, with the policy forced on and a `serviceUid` that differs
 * from the test process's uid: the client end of the connection IS owned by another uid from the
 * proxy's point of view, which is the two-tenant situation without needing a second account.
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { existsSync } from "node:fs";
import {
  foreignLoopbackPeerForSocket,
  loopbackPeerUidPolicyActive,
} from "@papercusp/operator-core/lib/auth/loopback-peer-trust";
import { createMcpProxy } from "./proxy";
import { MCP_PROXY_LOCAL_HEALTH_PATH } from "./budgets.mjs";

const servers: http.Server[] = [];
function track(s: http.Server): http.Server {
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
});

function port(s: http.Server): number {
  return (s.address() as { port: number }).port;
}
function listen(s: http.Server): Promise<http.Server> {
  return new Promise((res) => s.listen(0, "127.0.0.1", () => res(s)));
}
function send(
  p: number,
  method: "GET" | "POST",
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: p, method, path, agent: false }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

/** An upstream that counts what reached it, so a refusal can be proven to forward nothing. */
async function countingUpstream(): Promise<{ server: http.Server; hits: () => number }> {
  let hits = 0;
  const server = track(
    http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    }),
  );
  await listen(server);
  return { server, hits: () => hits };
}

async function proxyWith(
  upstreamPort: number,
  loopbackPeerGate?: Parameters<typeof createMcpProxy>[0]["loopbackPeerGate"],
): Promise<{ proxy: http.Server; logs: string[] }> {
  const logs: string[] = [];
  const proxy = track(
    createMcpProxy({
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: upstreamPort,
      retryWindowMs: 2_000,
      retryBackoffMs: 50,
      log: (s) => logs.push(s),
      ...(loopbackPeerGate ? { loopbackPeerGate } : {}),
    }),
  );
  await listen(proxy);
  return { proxy, logs };
}

const RPC = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
const HAS_PROC_NET_TCP = process.platform === "linux" && existsSync("/proc/net/tcp");
const OWN_UID = typeof process.getuid === "function" ? process.getuid() : -1;
const FORCED_POLICY = { PAPERCUSP_LOOPBACK_PEER_UID_POLICY: "service-only" } as NodeJS.ProcessEnv;

describe("MCP proxy loopback peer-uid gate (WI-10005688)", () => {
  it("refuses a foreign peer with 403 and forwards nothing upstream", async () => {
    const up = await countingUpstream();
    const { proxy, logs } = await proxyWith(port(up.server), () => ({ uid: 4242, reason: "uid-mismatch" }));

    const r = await send(port(proxy), "POST", "/api/mcp", RPC);

    expect(r.status).toBe(403);
    const body = JSON.parse(r.body);
    expect(body.mcpProxy).toBe(true);
    expect(body.reason).toBe("uid-mismatch");
    expect(body.error.code).toBe(-32001);
    expect(up.hits()).toBe(0);
    expect(logs.some((l) => l.includes("refused loopback peer uid=4242"))).toBe(true);
  });

  it("gates the local health path too, so a foreign uid cannot even probe the proxy", async () => {
    const up = await countingUpstream();
    const { proxy } = await proxyWith(port(up.server), () => ({ uid: null, reason: "unresolved" }));

    const r = await send(port(proxy), "GET", MCP_PROXY_LOCAL_HEALTH_PATH);

    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).reason).toBe("unresolved");
  });

  it("forwards when the gate returns null (the service uid, or the policy inactive)", async () => {
    const up = await countingUpstream();
    const { proxy } = await proxyWith(port(up.server), () => null);

    const r = await send(port(proxy), "POST", "/api/mcp", RPC);

    expect(r.status).toBe(200);
    expect(up.hits()).toBe(1);
  });

  it.skipIf(!HAS_PROC_NET_TCP || OWN_UID < 0)(
    "real /proc resolution: a caller whose uid is not the service uid is refused",
    async () => {
      const up = await countingUpstream();
      // The client socket is owned by OWN_UID; the proxy claims OWN_UID + 1 as its service uid.
      const { proxy } = await proxyWith(port(up.server), (socket) =>
        foreignLoopbackPeerForSocket(socket, { env: FORCED_POLICY, serviceUid: OWN_UID + 1 }),
      );

      const r = await send(port(proxy), "POST", "/api/mcp", RPC);

      expect(r.status).toBe(403);
      const body = JSON.parse(r.body);
      // uid-mismatch, not unresolved: the resolver found the client row and read its uid.
      expect(body.reason).toBe("uid-mismatch");
      expect(up.hits()).toBe(0);
    },
  );

  it.skipIf(!HAS_PROC_NET_TCP || OWN_UID < 0)(
    "real /proc resolution: a caller of the service uid is forwarded",
    async () => {
      const up = await countingUpstream();
      const { proxy } = await proxyWith(port(up.server), (socket) =>
        foreignLoopbackPeerForSocket(socket, { env: FORCED_POLICY, serviceUid: OWN_UID }),
      );

      const r = await send(port(proxy), "POST", "/api/mcp", RPC);

      expect(r.status).toBe(200);
      expect(up.hits()).toBe(1);
    },
  );

  it.skipIf(loopbackPeerUidPolicyActive())(
    "the default gate is a no-op on a single-user host (policy inactive): requests are forwarded",
    async () => {
      const up = await countingUpstream();
      const { proxy } = await proxyWith(port(up.server));

      const r = await send(port(proxy), "POST", "/api/mcp", RPC);

      expect(r.status).toBe(200);
      expect(up.hits()).toBe(1);
    },
  );
});
