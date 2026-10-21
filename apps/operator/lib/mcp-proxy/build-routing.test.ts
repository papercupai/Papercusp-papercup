/**
 * Per-call build routing (plan staging-build-tool-routing-2026-10-21, R-1 / P-001).
 *
 * A tools/call naming `build:'staging'` (argument or `_meta["papercusp/build"]`) must reach
 * ONLY the staging target, with `build` stripped from the forwarded arguments and `_meta`
 * stamped; a call with no selector keeps today's routing; a staging-routed call that cannot
 * reach staging is answered `staging_unavailable` and never runs on main.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createTextCollector } from "@papercusp/operator-core/lib/child-output";
import {
  applyMcpBuildSelector,
  isStagingTarget,
  MCP_BUILD_META_KEY,
  normalizeMcpBuild,
  selectTargetsForBuild,
} from "./build-routing";
import { createMcpProxy, staticMcpProxyTargets, type McpProxyTarget } from "./proxy";

const call = (
  name: string,
  args: unknown,
  meta?: Record<string, unknown>,
  id = 1,
): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
});

const buf = (v: unknown): Buffer => Buffer.from(JSON.stringify(v), "utf8");

describe("normalizeMcpBuild", () => {
  it("accepts main and staging in any case, rejects everything else", () => {
    expect(normalizeMcpBuild("staging")).toBe("staging");
    expect(normalizeMcpBuild(" Main ")).toBe("main");
    expect(normalizeMcpBuild("prod")).toBeNull();
    expect(normalizeMcpBuild(3170)).toBeNull();
    expect(normalizeMcpBuild(undefined)).toBeNull();
  });
});

describe("applyMcpBuildSelector", () => {
  it("leaves a call without a selector untouched (same bytes)", () => {
    const raw = buf(call("coord:presence", { scope: "hive" }));
    const r = applyMcpBuildSelector(raw);
    expect(r).toEqual({ kind: "none" });
  });

  it("strips arguments.build and stamps _meta papercusp/build", () => {
    const raw = buf(call("tools:invoke", { name: "foo:bar", args: { x: 1 }, build: "staging" }));
    const r = applyMcpBuildSelector(raw);
    expect(r.kind).toBe("routed");
    if (r.kind !== "routed") return;
    expect(r.build).toBe("staging");
    expect(r.rewritten).toBe(true);
    const out = JSON.parse(r.body.toString("utf8"));
    expect(out.params.arguments).toEqual({ name: "foo:bar", args: { x: 1 } });
    expect(out.params._meta[MCP_BUILD_META_KEY]).toBe("staging");
  });

  it("routes on _meta alone and keeps an already-stamped body byte-identical", () => {
    const raw = buf(call("tools:find", { query: "foo" }, { [MCP_BUILD_META_KEY]: "staging" }));
    const r = applyMcpBuildSelector(raw);
    expect(r).toMatchObject({ kind: "routed", build: "staging", rewritten: false });
    if (r.kind === "routed") expect(r.body).toBe(raw);
  });

  it("keeps existing _meta keys (idempotencyKey) when stamping", () => {
    const raw = buf(call("coord:send", { build: "main" }, { idempotencyKey: "k-1" }));
    const r = applyMcpBuildSelector(raw);
    expect(r.kind).toBe("routed");
    if (r.kind !== "routed") return;
    const out = JSON.parse(r.body.toString("utf8"));
    expect(out.params._meta).toEqual({ idempotencyKey: "k-1", [MCP_BUILD_META_KEY]: "main" });
    expect(out.params.arguments).toEqual({});
  });

  it("decodes, edits and re-encodes stringified arguments to the same depth", () => {
    const inner = { name: "foo:bar", build: "staging" };
    const once = buf(call("tools:invoke", JSON.stringify(inner)));
    const r1 = applyMcpBuildSelector(once);
    expect(r1.kind).toBe("routed");
    if (r1.kind === "routed") {
      const args = JSON.parse(r1.body.toString("utf8")).params.arguments;
      expect(typeof args).toBe("string");
      expect(JSON.parse(args)).toEqual({ name: "foo:bar" });
    }
    const twice = buf(call("tools:invoke", JSON.stringify(JSON.stringify(inner))));
    const r2 = applyMcpBuildSelector(twice);
    expect(r2.kind).toBe("routed");
    if (r2.kind === "routed") {
      const args = JSON.parse(r2.body.toString("utf8")).params.arguments;
      expect(JSON.parse(JSON.parse(args))).toEqual({ name: "foo:bar" });
    }
  });

  it("ignores a build value that is not main or staging", () => {
    const raw = buf(call("some:tool", { build: "prod" }));
    expect(applyMcpBuildSelector(raw)).toEqual({ kind: "none" });
  });

  it("refuses a batch that names two builds, and an argument that disagrees with _meta", () => {
    const batch = buf([
      call("a:b", { build: "staging" }, undefined, 1),
      call("c:d", { build: "main" }, undefined, 2),
    ]);
    expect(applyMcpBuildSelector(batch)).toEqual({ kind: "conflict", builds: ["main", "staging"] });
    const split = buf(call("a:b", { build: "staging" }, { [MCP_BUILD_META_KEY]: "main" }));
    expect(applyMcpBuildSelector(split).kind).toBe("conflict");
  });

  it("does not treat non-tools/call messages or non-JSON as selectors", () => {
    expect(applyMcpBuildSelector(buf({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { build: "staging" } })))
      .toEqual({ kind: "none" });
    expect(applyMcpBuildSelector(Buffer.from("build=staging"))).toEqual({ kind: "none" });
  });
});

describe("selectTargetsForBuild", () => {
  const targets: McpProxyTarget[] = [
    { host: "127.0.0.1", port: 3070, source: "static" },
    { host: "127.0.0.1", port: 3170, source: "static-fallback" },
  ];
  it("returns the ordered list unchanged without a selector", () => {
    expect(selectTargetsForBuild(targets, null, 3170)).toEqual(targets);
  });
  it("narrows to one build and never includes the other", () => {
    expect(selectTargetsForBuild(targets, "staging", 3170)).toEqual([targets[1]]);
    expect(selectTargetsForBuild(targets, "main", 3170)).toEqual([targets[0]]);
  });
  it("finds no staging target on a proxy without the dev fallback", () => {
    expect(selectTargetsForBuild([targets[0]!], "staging", 3170)).toEqual([]);
  });
  it("identifies staging by the fallback source or the staging port", () => {
    expect(isStagingTarget({ port: 41234, source: "static-fallback" }, 3170)).toBe(true);
    expect(isStagingTarget({ port: 3170, source: "static" }, 3170)).toBe(true);
    expect(isStagingTarget({ port: 3070, source: "static" }, 3170)).toBe(false);
  });
});

// ── End-to-end through the real proxy against stub upstreams ──────────────────────────

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers.length = 0;
});
function track<T extends http.Server>(s: T): T {
  servers.push(s);
  return s;
}
function port(s: http.Server): number {
  return (s.address() as { port: number }).port;
}
function listen(s: http.Server): Promise<http.Server> {
  return new Promise((res) => s.listen(0, "127.0.0.1", () => res(s)));
}
function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = port(s);
      s.close(() => res(p));
    });
  });
}
function post(p: number, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: p, method: "POST", path: "/api/mcp", headers: { "content-type": "application/json" } },
      (res) => {
        const b = createTextCollector(res);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b.text() }));
      },
    );
    r.on("error", reject);
    r.end(body);
  });
}

/** A stub operator that records each request body it receives. */
function stubOperator(label: string, seen: Array<{ label: string; body: string }>): http.Server {
  return track(
    http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ label, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { servedBy: label } }));
      });
    }),
  );
}

async function proxyFor(targets: () => McpProxyTarget[], windowMs = 300): Promise<number> {
  const proxy = track(
    createMcpProxy({
      listenPort: 0,
      resolveTargets: targets,
      retryWindowMs: windowMs,
      retryBackoffMs: 20,
      log: () => {},
    }),
  );
  await listen(proxy);
  return port(proxy);
}

describe("MCP proxy build routing (end to end)", () => {
  it("forwards a build:'staging' call only to staging, stripped and stamped", async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const main = await listen(stubOperator("main", seen));
    const staging = await listen(stubOperator("staging", seen));
    const p = await proxyFor(() => staticMcpProxyTargets("127.0.0.1", port(main), port(staging)));

    const r = await post(p, JSON.stringify(call("tools:invoke", { name: "foo:bar", args: {}, build: "staging" })));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).result.servedBy).toBe("staging");
    expect(seen.map((s) => s.label)).toEqual(["staging"]);
    const forwarded = JSON.parse(seen[0]!.body);
    expect(forwarded.params.arguments).toEqual({ name: "foo:bar", args: {} });
    expect("build" in forwarded.params.arguments).toBe(false);
    expect(forwarded.params._meta[MCP_BUILD_META_KEY]).toBe("staging");
  });

  it("routes a call without a selector to main exactly as before", async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const main = await listen(stubOperator("main", seen));
    const staging = await listen(stubOperator("staging", seen));
    const p = await proxyFor(() => staticMcpProxyTargets("127.0.0.1", port(main), port(staging)));

    const r = await post(p, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(r.status).toBe(200);
    expect(seen.map((s) => s.label)).toEqual(["main"]);
    expect(JSON.parse(seen[0]!.body)).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  });

  it("answers staging_unavailable when staging refuses, and never reaches main", async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const main = await listen(stubOperator("main", seen));
    const stagingDown = await freePort();
    const p = await proxyFor(() => staticMcpProxyTargets("127.0.0.1", port(main), stagingDown), 200);

    const r = await post(p, JSON.stringify(call("coord:presence", { build: "staging" })));
    expect(r.status).toBe(503);
    const body = JSON.parse(r.body);
    expect(body.error).toBe("staging_unavailable");
    expect(body.build).toBe("staging");
    expect(body.reason).toBe("refused");
    expect(body.forwardingResult).toBe("not_applied");
    expect(seen).toEqual([]);
  });

  it("answers staging_unavailable at once when the proxy has no staging target", async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const main = await listen(stubOperator("main", seen));
    const p = await proxyFor(() => [{ host: "127.0.0.1", port: port(main), source: "static" }]);

    const r = await post(p, JSON.stringify(call("tools:find", { query: "x", build: "staging" })));
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toMatchObject({ error: "staging_unavailable", reason: "no-target" });
    expect(seen).toEqual([]);
  });

  it("keeps a build:'main' call off the staging fallback when main refuses", async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const mainDown = await freePort();
    const staging = await listen(stubOperator("staging", seen));
    const p = await proxyFor(() => staticMcpProxyTargets("127.0.0.1", mainDown, port(staging)), 200);

    const r = await post(p, JSON.stringify(call("coord:presence", { build: "main" })));
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).error).toBe("main_unavailable");
    expect(seen).toEqual([]);
  });

  it("refuses a batch that mixes builds without forwarding anything", async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const main = await listen(stubOperator("main", seen));
    const staging = await listen(stubOperator("staging", seen));
    const p = await proxyFor(() => staticMcpProxyTargets("127.0.0.1", port(main), port(staging)));

    const r = await post(
      p,
      JSON.stringify([call("a:b", { build: "staging" }, undefined, 1), call("c:d", { build: "main" }, undefined, 2)]),
    );
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toBe("build_selector_conflict");
    expect(seen).toEqual([]);
  });
});
