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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessIdentity } from '@papercusp/operator-core/lib/process-identity';
import { createTextCollector } from "@papercusp/operator-core/lib/child-output";
import {
  applyMcpBuildSelector,
  currentBuildDefaultTool,
  CURRENT_BUILD_DEFAULT_TOOLS,
  isStagingTarget,
  MCP_BUILD_META_KEY,
  normalizeMcpBuild,
  selectTargetsForBuild,
  applyMcpWorkerSelector,
  selectWorkerForTarget,
} from "./build-routing";
import { createMcpProxy, staticMcpProxyTargets, readMcpWorkerTargets, type McpProxyTarget } from "./proxy";

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
function post(p: number, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: p, method: "POST", path: "/api/mcp", headers: { "content-type": "application/json", ...headers } },
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

function toolListOperator(
  label: string,
  seen: Array<{ label: string; body: string }>,
  tools: Array<Record<string, unknown>>,
  contentType: "application/json" | "text/event-stream" = "application/json",
): http.Server {
  return track(http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ label, body });
      const request = JSON.parse(body) as { id?: unknown };
      const response = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools } });
      res.writeHead(200, { "content-type": contentType });
      res.end(contentType === "text/event-stream" ? `event: message\ndata: ${response}\n\n` : response);
    });
  }));
}

function parseToolListResponse(
  body: string,
  contentType: string | string[] | undefined,
): { id: unknown; result: { tools: Array<Record<string, unknown>> } } {
  const text = Array.isArray(contentType) ? contentType.join(",") : contentType ?? "";
  if (/text\/event-stream/i.test(text)) {
    const data = body.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!data) throw new Error("tools/list SSE response had no data event");
    return JSON.parse(data.slice(5).trim()) as { id: unknown; result: { tools: Array<Record<string, unknown>> } };
  }
  return JSON.parse(body) as { id: unknown; result: { tools: Array<Record<string, unknown>> } };
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

// gate-repair-plane-on-current-build-2026-10-15 D-016 G-5: the full repair plane uses
// current-build defaults, including the final release:test-downgrade rung.
describe("current-build defaults for release repair-plane tools", () => {
  it("enumerates the full repair-plane set", () => {
    expect(CURRENT_BUILD_DEFAULT_TOOLS).toEqual(["release:repair-queue", "release:test-downgrade"]);
  });

  it.each(["application/json", "text/event-stream"] as const)(
    "substitutes current-build default definitions in %s tools/list responses",
    async (contentType) => {
      const seen: Array<{ label: string; body: string }> = [];
      const main = await listen(toolListOperator("main", seen, [
        {
          name: "release:repair-queue",
          description: "release guidance",
          inputSchema: { type: "object", properties: { oldField: { type: "boolean" } } },
          _meta: { build: "main" },
        },
        {
          name: "release:test-downgrade",
          description: "release downgrade guidance",
          inputSchema: { type: "object", properties: { oldReason: { type: "string" } } },
        },
        { name: "coord:presence", description: "main-only guidance" },
      ], contentType));
      const staging = await listen(toolListOperator("staging", seen, [
        {
          name: "release:repair-queue",
          description: "current-build guidance",
          inputSchema: { type: "object", properties: { patchCommits: { type: "array" } } },
          _meta: { build: "staging" },
        },
        {
          name: "release:test-downgrade",
          description: "current-build downgrade guidance",
          inputSchema: { type: "object", properties: { reason: { type: "string" } } },
        },
        { name: "coord:presence", description: "staging-only guidance" },
      ], contentType));
      const p = await proxyFor(() => staticMcpProxyTargets("127.0.0.1", port(main), port(staging)));

      const r = await post(p, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }));
      expect(r.status).toBe(200);
      const response = parseToolListResponse(r.body, contentType);
      const listed = response.result.tools;
      expect(response.id).toBe(7);
      expect(listed.find((tool) => tool.name === "release:repair-queue")).toMatchObject({
        description: "current-build guidance",
        inputSchema: { properties: { patchCommits: { type: "array" } } },
        _meta: { build: "staging" },
      });
      expect(listed.find((tool) => tool.name === "release:test-downgrade")).toMatchObject({
        description: "current-build downgrade guidance",
        inputSchema: { properties: { reason: { type: "string" } } },
      });
      expect(listed.find((tool) => tool.name === "coord:presence")?.description).toBe("main-only guidance");
      expect(seen.map((entry) => entry.label)).toEqual(["main", "staging"]);
      expect(JSON.parse(seen[0]!.body)).toEqual(JSON.parse(seen[1]!.body));
    },
  );

  it("fails closed when staging cannot supply a definition currently advertised by main", async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const main = await listen(toolListOperator("main", seen, [{
      name: "release:repair-queue",
      description: "stale release guidance",
      inputSchema: { type: "object", properties: { oldField: { type: "boolean" } } },
    }]));
    const stagingDown = await freePort();
    const p = await proxyFor(() => staticMcpProxyTargets("127.0.0.1", port(main), stagingDown), 200);

    const r = await post(p, JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }));
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toMatchObject({
      jsonrpc: "2.0",
      id: 8,
      error: { code: -32603, message: "Current-build tool definitions are unavailable" },
    });
    expect(r.body).not.toContain("stale release guidance");
    expect(seen.map((entry) => entry.label)).toEqual(["main"]);
  });

  it("recognizes test-downgrade as a current-build default", () => {
    expect(currentBuildDefaultTool({ name: "release:test-downgrade", arguments: { op: "list" } })).not.toBeNull();
  });

  it("routes selector-less test-downgrade calls to staging, directly or wrapped in tools:invoke", () => {
    const forms = [
      call("release:test-downgrade", { op: "list" }),
      call("release_test-downgrade", { op: "list" }),
      call("tools:invoke", { name: "release:test-downgrade", args: { op: "list" } }),
      call("tools_invoke", JSON.stringify({ name: "release_test_downgrade", args: { op: "list" } })),
    ];
    for (const form of forms) {
      const r = applyMcpBuildSelector(buf(form), { defaultToCurrentBuild: true });
      expect(r.kind, JSON.stringify(form)).toBe("routed");
      if (r.kind !== "routed") continue;
      expect(r.build).toBe("staging");
      expect(r.defaultedTools).toEqual([expect.stringMatching(/^release:test:?downgrade$/)]);
      expect(JSON.parse(r.body.toString("utf8")).params._meta[MCP_BUILD_META_KEY]).toBe("staging");
    }
  });

  it("routes selector-less code:run scripts naming test-downgrade to staging", () => {
    const forms = [
      call("code:run", { script: "return await tools.release.testDowngrade({ op: 'list' });" }),
      call("code_run", { script: "return await tools.release['test-downgrade']({ op: 'list' });" }),
      call("tools:invoke", {
        name: "code:run",
        args: { script: "await tools.release.test_downgrade({ op: 'list' });" },
      }),
    ];
    for (const form of forms) {
      const r = applyMcpBuildSelector(buf(form), { defaultToCurrentBuild: true });
      expect(r.kind, JSON.stringify(form)).toBe("routed");
      if (r.kind !== "routed") continue;
      expect(r.build).toBe("staging");
      expect(r.defaultedTools).toEqual([expect.stringMatching(/^release:test:?downgrade$/)]);
    }
  });

  it("routes a selector-less repair-queue call to staging, directly or wrapped in tools:invoke", () => {
    const forms = [
      call("release:repair-queue", { op: "admit", paths: ["a.ts"] }),
      call("release_repair-queue", { op: "status" }),
      call("tools:invoke", { name: "release:repair-queue", args: { op: "admit" } }),
      call("tools_invoke", JSON.stringify({ name: "release_repair_queue", args: {} })),
    ];
    for (const form of forms) {
      const r = applyMcpBuildSelector(buf(form), { defaultToCurrentBuild: true });
      expect(r.kind).toBe("routed");
      if (r.kind !== "routed") continue;
      expect(r.build).toBe("staging");
      expect(r.defaultedTools).toEqual([expect.stringMatching(/^release:repair:?queue$/)]);
      expect(JSON.parse(r.body.toString("utf8")).params._meta[MCP_BUILD_META_KEY]).toBe("staging");
    }
  });

  it("routes a selector-less code:run whose script names the verb — nested calls run in-process on the code:run host", () => {
    const forms = [
      call("code:run", { script: "return await tools.release.repairQueue({ op: 'status' });" }),
      call("code_run", { script: "return await tools.release['repair-queue']({ op: 'admit', paths: ['a.ts'] });" }),
      call("tools:invoke", { name: "code:run", args: { script: "await tools.release.repair_queue({op:'status'})" } }),
      call("code:run", JSON.stringify({ script: "const q = await tools.release.repairQueue({}); return q;" })),
    ];
    for (const form of forms) {
      const r = applyMcpBuildSelector(buf(form), { defaultToCurrentBuild: true });
      expect(r.kind).toBe("routed");
      if (r.kind !== "routed") continue;
      expect(r.build).toBe("staging");
      expect(r.defaultedTools).toEqual([expect.stringMatching(/^release:repair:?queue$/)]);
    }
  });

  it("leaves a code:run that never names a default verb unrouted, and honours an explicit selector on it", () => {
    const plain = call("code:run", { script: "return await tools.work_items.get({ id: 'WI-1' });" });
    expect(applyMcpBuildSelector(buf(plain), { defaultToCurrentBuild: true }).kind).toBe("none");
    expect(applyMcpBuildSelector(buf(call("code:run", {})), { defaultToCurrentBuild: true }).kind).toBe("none");
    const explicit = call("code:run", { script: "await tools.release.repairQueue({})", build: "main" });
    const r = applyMcpBuildSelector(buf(explicit), { defaultToCurrentBuild: true });
    expect(r).toMatchObject({ kind: "routed", build: "main" });
    expect(r.kind === "routed" && r.defaultedTools).toBeFalsy();
  });

  it("never overrides an explicit selector", () => {
    const r = applyMcpBuildSelector(buf(call("release:repair-queue", { op: "admit", build: "main" })), {
      defaultToCurrentBuild: true,
    });
    expect(r).toMatchObject({ kind: "routed", build: "main" });
    expect(r.kind === "routed" && r.defaultedTools).toBeFalsy();
  });

  it("leaves repair-queue unrouted when the default is off, and other tools unrouted when it is on", () => {
    expect(applyMcpBuildSelector(buf(call("release:repair-queue", { op: "admit" }))).kind).toBe("none");
    expect(applyMcpBuildSelector(buf(call("release:cut", { repair: true })), { defaultToCurrentBuild: true }).kind).toBe("none");
    expect(
      applyMcpBuildSelector(buf(call("tools:invoke", { name: "release:deploy", args: { why: "repair" } })), {
        defaultToCurrentBuild: true,
      }).kind,
    ).toBe("none");
  });

  it("treats a defaulted call in a batch with an explicit main call as a conflict", () => {
    const r = applyMcpBuildSelector(
      buf([call("release:repair-queue", { op: "admit" }, undefined, 1), call("c:d", { build: "main" }, undefined, 2)]),
      { defaultToCurrentBuild: true },
    );
    expect(r).toMatchObject({ kind: "conflict", builds: ["main", "staging"] });
  });

  it("end to end: a repair-queue call through the :9071-shaped proxy runs on staging, never main", async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const main = await listen(stubOperator("main", seen));
    const staging = await listen(stubOperator("staging", seen));
    const p = await proxyFor(() => staticMcpProxyTargets("127.0.0.1", port(main), port(staging)));

    const direct = await post(p, JSON.stringify(call("release:repair-queue", { op: "admit", paths: ["x.ts"] })));
    const wrapped = await post(p, JSON.stringify(call("tools:invoke", { name: "release:repair-queue", args: {} }, undefined, 2)));
    const other = await post(p, JSON.stringify(call("coord:presence", {}, undefined, 3)));
    expect([direct.status, wrapped.status, other.status]).toEqual([200, 200, 200]);
    expect(JSON.parse(direct.body).result.servedBy).toBe("staging");
    expect(JSON.parse(wrapped.body).result.servedBy).toBe("staging");
    expect(JSON.parse(other.body).result.servedBy).toBe("main");
    expect(seen.map((s) => s.label)).toEqual(["staging", "staging", "main"]);
    expect(JSON.parse(seen[0]!.body).params._meta[MCP_BUILD_META_KEY]).toBe("staging");
  });

  it("end to end: build:'main' is the explicit opt-out", async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const main = await listen(stubOperator("main", seen));
    const staging = await listen(stubOperator("staging", seen));
    const p = await proxyFor(() => staticMcpProxyTargets("127.0.0.1", port(main), port(staging)));

    const r = await post(p, JSON.stringify(call("release:repair-queue", { op: "status", build: "main" })));
    expect(r.status).toBe(200);
    expect(seen.map((s) => s.label)).toEqual(["main"]);
  });

  it("end to end: a proxy with no staging target (bg-host shape) keeps today's routing", async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const bgHost = await listen(stubOperator("bg-host", seen));
    const p = await proxyFor(() => [{ host: "127.0.0.1", port: port(bgHost), source: "static" }]);

    const r = await post(p, JSON.stringify(call("release:repair-queue", { op: "admit" })));
    expect(r.status).toBe(200);
    expect(seen.map((s) => s.label)).toEqual(["bg-host"]);
    const forwarded = JSON.parse(seen[0]!.body);
    expect(forwarded.params._meta?.[MCP_BUILD_META_KEY]).toBeUndefined();
  });

  it("end to end: staging down answers staging_unavailable naming the default and never runs on main", async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const main = await listen(stubOperator("main", seen));
    const stagingDown = await freePort();
    const p = await proxyFor(() => staticMcpProxyTargets("127.0.0.1", port(main), stagingDown), 200);

    const r = await post(p, JSON.stringify(call("release:repair-queue", { op: "admit", paths: ["y.ts"] })));
    expect(r.status).toBe(503);
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({ error: "staging_unavailable", reason: "refused", forwardingResult: "not_applied" });
    expect(body.defaultedBy.decision).toBe("gate-repair-plane-on-current-build-2026-10-15#D-004");
    expect(body.defaultedBy.override).toContain("build:'main'");
    expect(seen).toEqual([]);
  });
});

describe('target-preserving worker routing', () => {
  const target = { environment: 'staging' as const, buildSha: 'a'.repeat(40), installRoot: '/selected/install' };
  const worker = (p: number): McpProxyTarget => ({ host: '127.0.0.1', port: p,
    processRole: 'bg-host', executionTarget: target });
  const request = (extra = {}) => JSON.stringify(call('git-sync:run', { installSlug: 'selected', target, ...extra },
    { threadId: 'session-one', workspace: 'workspace-one' }));
  async function routed(workers: McpProxyTarget[]) {
    const proxy = track(createMcpProxy({ listenPort: 0, targetPort: 1, resolveWorkerTargets: () => workers,
      retryWindowMs: 40, retryBackoffMs: 5, log: () => {} }));
    await listen(proxy);
    return port(proxy);
  }

  it('requires private live discovery with a matching process identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-worker-discovery-'));
    const path = join(directory, 'endpoint-ipc.3271.json');
    const descriptor = { port: 3271, pid: process.pid, processRole: 'bg-host', executionTarget: target,
      executionProcessId: readProcessIdentity(process.pid) };
    const write = (value: unknown, mode = 0o600) => { rmSync(path, { force: true }); writeFileSync(path, JSON.stringify(value), { mode }); };
    try {
      write(descriptor);
      expect(readMcpWorkerTargets(directory)).toMatchObject([{ port: 3271, executionTarget: target }]);
      write({ ...descriptor, executionProcessId: 'replaced-process' });
      expect(readMcpWorkerTargets(directory)).toEqual([]);
      write(descriptor, 0o644);
      expect(readMcpWorkerTargets(directory)).toEqual([]);
      write({ ...descriptor, processRole: 'operator' });
      expect(readMcpWorkerTargets(directory)).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves the explicit environment, build and install at the selected worker', async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const selected = await listen(stubOperator('selected', seen));
    const p = await routed([worker(port(selected)), { ...worker(1), executionTarget: { ...target, environment: 'main' } }]);
    const response = await post(p, request());
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    const forwarded = JSON.parse(seen[0]!.body);
    expect(forwarded.params.arguments).toMatchObject({ installSlug: 'selected', target });
    expect(forwarded.params._meta).toMatchObject({ threadId: 'session-one', workspace: 'workspace-one', 'papercusp/build': 'staging' });
  });

  it('refuses ambiguous or unavailable targets without substitution', async () => {
    for (const workers of [[], [worker(1), worker(2)],
      [{ ...worker(1), executionTarget: { ...target, buildSha: 'b'.repeat(40) } }],
      [{ ...worker(1), executionTarget: { ...target, installRoot: '/another' } }],
      [{ ...worker(1), processRole: 'operator' }]]) {
      const response = await post(await routed(workers), request());
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({ forwardingResult: 'not_applied' });
    }
    expect(applyMcpWorkerSelector(buf(call('git-sync:run', { target: { ...target, buildSha: undefined } }))))
      .toMatchObject({ kind: 'refused' });
  });

  it('preserves authentication and attribution without forwarding host-local principals', async () => {
    let authorization: string | undefined;
    let dispatched = 0;
    const upstream = track(http.createServer((req, res) => {
      authorization = req.headers.authorization;
      dispatched++;
      req.resume();
      res.writeHead(401); res.end('authentication required');
    }));
    await listen(upstream);
    const p = await routed([worker(port(upstream))]);
    expect((await post(p, request(), { authorization: 'Bearer original-test-credential' })).status).toBe(401);
    expect(authorization).toBe('Bearer original-test-credential');
    expect(dispatched).toBe(1);
    const refused = await post(p, request({ authenticatedPrincipal: { capabilities: ['all'] } }));
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body).forwardingResult).toBe('not_applied');
    expect(dispatched).toBe(1);
  });

  it('refuses host-local principals throughout direct and deferred envelopes before dispatch', async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const upstream = await listen(stubOperator('must-not-receive-principal', seen));
    const p = await routed([worker(port(upstream))]);
    for (const deferred of [false, true]) {
      for (const location of ['message', 'params', 'messageMeta', 'paramsMeta', 'outer', 'outerMeta', 'inner', 'innerMeta']) {
        const inner = { target };
        const outer = deferred ? { name: 'git-sync:run', args: inner } : inner;
        const message = call(deferred ? 'tools:invoke' : 'git-sync:run', outer) as any;
        const envelopes: Record<string, any> = { message, params: message.params,
          messageMeta: message._meta = {}, paramsMeta: message.params._meta = {}, outer,
          outerMeta: (outer as any)._meta ??= {}, inner, innerMeta: (inner as any)._meta ??= {} };
        envelopes[location].authenticatedPrincipal = { capabilities: ['all'] };
        const response = await post(p, JSON.stringify(message));
        expect(response.status, `${deferred}:${location}`).toBe(400);
        expect(JSON.parse(response.body)).toMatchObject({ forwardingResult: 'not_applied' });
        expect(seen).toHaveLength(0);
      }
    }
  });

  it('distinguishes no-dispatch, unknown and authenticated completion without replay', async () => {
    const seen: Array<{ label: string; body: string }> = [];
    const upstream = await listen(stubOperator('worker-result', seen));
    const p = await routed([worker(port(upstream))]);
    const completed = await post(p, request());
    expect(JSON.parse(completed.body)).toMatchObject({ result: { servedBy: 'worker-result' } });
    expect(seen).toHaveLength(1);
    const unavailable = await post(await routed([]), request());
    expect(JSON.parse(unavailable.body).forwardingResult).toBe('not_applied');
    // A preview remains on the existing request-only handler; zero worker dispatch.
    expect(applyMcpWorkerSelector(Buffer.from(request({ dryRun: true })))).toEqual({ kind: 'none' });
    expect(seen).toHaveLength(1);
  });

  it('reports connection loss before dispatch as no-dispatch', async () => {
    const response = await post(await routed([worker(await freePort())]), request());
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({ forwardingResult: 'not_forwarded' });
  });

  it('reports connection loss after possible dispatch as unknown without retry', async () => {
    let dispatched = 0;
    const upstream = track(http.createServer((req) => {
      req.on('data', () => {});
      req.on('end', () => { dispatched++; req.socket.destroy(); });
    }));
    await listen(upstream);
    const response = await post(await routed([worker(port(upstream))]), request());
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toMatchObject({ forwardingResult: 'outcome_unknown' });
    expect(dispatched).toBe(1);
  });
});
