/**
 * Resilient MCP proxy tests (P-005). Pins the load-bearing safety invariant
 * (retry ONLY a refused/pre-connect upstream — never replay a call that may have
 * reached :3070, so a non-idempotent tools/call is never double-applied) plus the
 * passthrough + refused-then-recovers behavior against in-process stub upstreams.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { createTextCollector } from "@papercusp/operator-core/lib/child-output";
import {
  shouldRetry,
  createMcpProxy,
  prepareForward,
  forwardingResultForUpstreamFailure,
  MCP_PROXY_FORWARDING_RESULTS,
  upstreamDeathSseErrorEvents,
  endsOnSseEventBoundary,
  MAX_UPSTREAM_DEATH_ERROR_EVENTS,
  UPSTREAM_DIED_MID_STREAM_RPC_CODE,
  postConnectRetryable,
  READ_ONLY_TOOLS,
  MAX_POST_CONNECT_RETRIES,
  isBackpressureStatus,
  backpressureRetryable,
  retryAfterMs,
  retryAfterSecForDrainRate,
  MAX_BACKPRESSURE_RETRIES,
  MIN_SHED_RETRY_AFTER_SEC,
  MAX_SHED_RETRY_AFTER_SEC,
  handshakeTimeoutRetryable,
  MAX_HANDSHAKE_TIMEOUT_RETRIES,
  isCheapRepeatingBeat,
  effectiveRetryWindowMs,
  CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS,
  shouldShedForInFlight,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_CONTROL_PLANE_RESERVE,
  DEFAULT_MAX_HANDSHAKES_IN_FLIGHT,
  DEFAULT_MAX_HANDSHAKE_QUEUE,
  DEFAULT_MAX_ORDINARY_QUEUE,
  DEFAULT_MAX_CRITICAL_CONTINUATION_QUEUE,
  DEFAULT_CRITICAL_CONTINUATION_QUEUE_WAIT_MS,
  DEFAULT_COORD_SEND_QUEUE_WAIT_MS,
  DEFAULT_IMPROVEMENTS_CAPTURE_QUEUE_WAIT_MS,
  DEFAULT_MAX_IMPROVEMENTS_CAPTURE_QUEUE,
  isMcpSessionHandshakeCall,
  isMcpProxyWatchdogProbePath,
  isCoordSendContinuationCall,
  coordSendToolNames,
  isImprovementsCaptureContinuationCall,
  improvementsCaptureToolNames,
  isCriticalContinuationCall,
  criticalContinuationToolNames,
  isReservedControlPlaneCall,
  isReservedControlPlanePath,
  shouldSkipDefaultFailureLog,
  shouldRotateFailureLog,
  injectCurrentSuperuserBearer,
  stripClientConnectionHeader,
  MCP_PROXY_TRACE_HEADER,
  MAX_MCP_PROXY_TRACE_ID_CHARS,
  MAX_MCP_ADMISSION_REASON_BODY_BYTES,
  MCP_PROXY_DATA_PLANE_DEGRADED_AT_HEADER,
  DEFAULT_DATA_PLANE_WARNING_WINDOW_MS,
  withDataPlaneDegradedHeader,
  DEFAULT_MCP_PROXY_TARGET_PORT,
  DEFAULT_MCP_PROXY_DEV_FALLBACK_PORT,
  staticMcpProxyTargets,
  resolveDefaultMcpProxyTargets,
  describeMcpProxyTarget,
  mcpProxyGenerationAffinityKey,
  isGenerationBoundMcpRequest,
  startMcpProxy,
  type McpProxyTarget,
} from "./proxy";
import { MCP_PROXY_LOCAL_HEALTH_PATH } from "./budgets.mjs";
import { DEFAULT_KEEPALIVE_TIMEOUT_MS } from "../../bin/host-request-deadline";

describe("shouldRetry — refused-only + in-window (no double-execution)", () => {
  it("retries when NOT connected and within the window", () => {
    expect(shouldRetry(false, 1_000, 45_000)).toBe(true);
  });
  it("does NOT retry once connected (the request may already be processed at :3070)", () => {
    expect(shouldRetry(true, 1_000, 45_000)).toBe(false);
  });
  it("does NOT retry past the window even if still refused", () => {
    expect(shouldRetry(false, 46_000, 45_000)).toBe(false);
  });
});

describe("MCP proxy startup log target (WI-10004334)", () => {
  it("names the pinned PAPERCUSP_MCP_PROXY_TARGET_PORT, not undefined", async () => {
    const lines: string[] = [];
    const server = startMcpProxy({
      listenPort: 0,
      resolveTargets: () =>
        resolveDefaultMcpProxyTargets({ PAPERCUSP_MCP_PROXY_TARGET_PORT: "3170" }),
      retryWindowMs: 90_000,
      log: (s) => lines.push(s),
    });
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const listening = lines.find((l) => l.startsWith("listening on"));
      expect(listening).toMatch(/ → 127\.0\.0\.1:3170 \(retry-on-refused window 90000ms\)$/);
      expect(listening).not.toContain("undefined");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("names the dev fallback candidate for the unpinned topology", () => {
    expect(
      describeMcpProxyTarget({
        listenPort: 9071,
        resolveTargets: () => resolveDefaultMcpProxyTargets({}),
        retryWindowMs: 1,
      }),
    ).toBe(
      `127.0.0.1:${DEFAULT_MCP_PROXY_TARGET_PORT} (fallback 127.0.0.1:${DEFAULT_MCP_PROXY_DEV_FALLBACK_PORT})`,
    );
  });

  it("keeps the static targetPort and dynamic operator.json forms", () => {
    expect(
      describeMcpProxyTarget({ listenPort: 9071, targetPort: 3070, retryWindowMs: 1 }),
    ).toBe("127.0.0.1:3070");
    expect(
      describeMcpProxyTarget({
        listenPort: 9071,
        resolveTarget: () => ({ host: "127.0.0.1", port: 1 }),
        retryWindowMs: 1,
      }),
    ).toBe("dynamic operator.json target");
  });
});

describe("MCP proxy target topology — dev fallback and fail-closed pins", () => {
  it("resolves the unpinned dev topology in canonical-then-staging order", () => {
    expect(resolveDefaultMcpProxyTargets({})).toEqual([
      {
        host: "127.0.0.1",
        port: DEFAULT_MCP_PROXY_TARGET_PORT,
        source: "static",
      },
      {
        host: "127.0.0.1",
        port: DEFAULT_MCP_PROXY_DEV_FALLBACK_PORT,
        source: "static-fallback",
      },
    ]);
  });

  it("keeps explicit target and inherited Hono pins single-candidate", () => {
    expect(
      resolveDefaultMcpProxyTargets({
        PAPERCUSP_MCP_PROXY_TARGET_PORT: "3199",
        PAPERCUSP_MCP_PROXY_DEV_FALLBACK_PORT: "3170",
      }),
    ).toEqual([
      { host: "127.0.0.1", port: 3199, source: "static" },
    ]);
    expect(
      resolveDefaultMcpProxyTargets({
        PAPERCUSP_HONO_PORT: "3198",
        PAPERCUSP_MCP_PROXY_DEV_FALLBACK_PORT: "3170",
      }),
    ).toEqual([
      { host: "127.0.0.1", port: 3198, source: "static" },
    ]);
  });

  it("omits an invalid or duplicate fallback rather than inventing a target", () => {
    expect(staticMcpProxyTargets("127.0.0.1", 3197, 3197)).toEqual([
      { host: "127.0.0.1", port: 3197, source: "static" },
    ]);
    expect(staticMcpProxyTargets("127.0.0.1", 3197, 0)).toEqual([
      { host: "127.0.0.1", port: 3197, source: "static" },
    ]);
  });
});

describe("withDataPlaneDegradedHeader — short-lived proxy-owned warning signal", () => {
  it("stamps only a recent proxy timestamp and removes a caller-supplied marker otherwise", () => {
    const now = 100_000;
    const recent = now - DEFAULT_DATA_PLANE_WARNING_WINDOW_MS;
    expect(
      withDataPlaneDegradedHeader(
        {
          [MCP_PROXY_DATA_PLANE_DEGRADED_AT_HEADER]: "caller-value",
          keep: "yes",
        },
        recent,
        now,
      ),
    ).toEqual({
      [MCP_PROXY_DATA_PLANE_DEGRADED_AT_HEADER]: String(recent),
      keep: "yes",
    });
    expect(
      withDataPlaneDegradedHeader(
        {
          [MCP_PROXY_DATA_PLANE_DEGRADED_AT_HEADER]: "caller-value",
          keep: "yes",
        },
        recent - 1,
        now,
      ),
    ).toEqual({ keep: "yes" });
  });
});

describe("forwarding result vocabulary — explicit mutation outcome semantics", () => {
  it("pins the four MCP proxy result states", () => {
    expect(MCP_PROXY_FORWARDING_RESULTS).toEqual({
      notForwarded: "not_forwarded",
      queued: "queued",
      applied: "applied",
      outcomeUnknown: "outcome_unknown",
    });
  });

  it("classifies refused/pre-connect failures as not_forwarded and post-connect failures as outcome_unknown", () => {
    expect(forwardingResultForUpstreamFailure(false)).toBe("not_forwarded");
    expect(forwardingResultForUpstreamFailure(true)).toBe("outcome_unknown");
  });
});

// EI-19388683897769817: a test that never sets PAPERCUSP_MCP_PROXY_FAILURE_LOG must never
// silently fall through to the real production ledger (~18% of a live 13,189-record sample
// was test/sidecar noise from exactly this gap). recordProxyFailure() consults this pure
// predicate before ever touching fs — tested directly (inputs, not env/fs) so the guard's
// LOGIC is pinned without depending on real environment state or touching disk.
describe("shouldSkipDefaultFailureLog — the write-site guard against test pollution of the shared prod ledger", () => {
  it("SKIPS under vitest with no explicit override — the exact gap that let 18% test noise into the ledger", () => {
    expect(shouldSkipDefaultFailureLog(true, false)).toBe(true);
  });
  it("WRITES under vitest when an explicit override IS set — a test that wants to assert on ledger content still can", () => {
    expect(shouldSkipDefaultFailureLog(true, true)).toBe(false);
  });
  it("WRITES outside vitest (real production/dev process) regardless of override — never silently drops real telemetry", () => {
    expect(shouldSkipDefaultFailureLog(false, false)).toBe(false);
    expect(shouldSkipDefaultFailureLog(false, true)).toBe(false);
  });
});

describe("failure ledger rotation — bounded diagnostic-path storage", () => {
  it("rotates at the configured byte ceiling and leaves smaller files in place", () => {
    expect(shouldRotateFailureLog(10, 10)).toBe(true);
    expect(shouldRotateFailureLog(9, 10)).toBe(false);
  });
});

// P-005: classify the forward + inject a per-request idempotencyKey on a tools/call so a
// post-connect retry is write-safe (:3070 replays instead of double-applying).
describe("prepareForward — classify + inject idempotencyKey", () => {
  const gen = () => "KEY123";
  it('injects a key into a tools/call → klass "keyed", content-length fixed', () => {
    const body = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{}}}',
    );
    const r = prepareForward(
      "POST",
      { "content-length": String(body.length) },
      body,
      { keyingEnabled: true, genKey: gen },
    );
    expect(r.klass).toBe("keyed");
    expect(JSON.parse(r.body.toString()).params._meta.idempotencyKey).toBe(
      "KEY123",
    );
    expect(r.headers["content-length"]).toBe(String(r.body.length));
  });
  it("RESPECTS a valid client-supplied key (body unchanged)", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "x",
          arguments: {},
          _meta: { idempotencyKey: "client-key" },
        },
      }),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("keyed");
    expect(r.body).toBe(body); // not mutated
    expect(JSON.parse(r.body.toString()).params._meta.idempotencyKey).toBe(
      "client-key",
    );
  });
  it('an INVALID client key (server would ignore it) drops to "opaque"', () => {
    const body = Buffer.from(
      JSON.stringify({
        method: "tools/call",
        params: { name: "x", _meta: { idempotencyKey: "z".repeat(201) } },
      }),
    );
    expect(
      prepareForward("POST", {}, body, { keyingEnabled: true, genKey: gen })
        .klass,
    ).toBe("opaque");
  });
  it('keying kill-switch off → tools/call is "opaque" (refused-only, pre-P-005 behavior)', () => {
    const body = Buffer.from('{"method":"tools/call","params":{"name":"x"}}');
    expect(
      prepareForward("POST", {}, body, { keyingEnabled: false, genKey: gen })
        .klass,
    ).toBe("opaque");
  });
  it('an idempotent method (tools/list) → "idempotent", body untouched', () => {
    const body = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("idempotent");
    expect(r.rpcMethods).toEqual(["tools/list"]);
    expect(r.body).toBe(body);
  });
  it('keeps bootstrap REST mutations opaque even when they carry an idempotency key', () => {
    const body = Buffer.from(JSON.stringify({ bootstrap_idempotency_key: 'fleet-member-1' }));
    for (const requestPath of [
      '/api/agent-mcp/console/bootstrap-su?client=psu',
      '/api/agent-mcp/console/bootstrap-role?client=psu',
    ]) {
      const r = prepareForward('POST', {}, body, {
        keyingEnabled: true,
        genKey: gen,
        requestPath,
      });
      expect(r.klass).toBe('opaque');
      expect(r.body).toBe(body);
      for (const key of [undefined, '', 'x'.repeat(201)]) {
        const unkeyed = prepareForward('POST', {}, Buffer.from(JSON.stringify({ bootstrap_idempotency_key: key })), {
          keyingEnabled: true,
          genKey: gen,
          requestPath,
        });
        expect(unkeyed.klass).toBe('opaque');
      }
    }
  });
  it("a batch [tools/call, tools/list] → keyed, key injected only into the call", () => {
    const body = Buffer.from(
      JSON.stringify([
        { method: "tools/call", params: { name: "a" } },
        { method: "tools/list" },
      ]),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: () => "BK",
    });
    expect(r.klass).toBe("keyed");
    expect(r.rpcMethods).toEqual(["tools/call", "tools/list"]);
    const arr = JSON.parse(r.body.toString());
    expect(arr[0].params._meta.idempotencyKey).toBe("BK");
    expect(arr[1].method).toBe("tools/list");
    expect(arr[1].params).toBeUndefined();
  });
  it.each([
    { portId: "22222222-2222-4222-8222-222222222222", targetAdvSessionId: 99, status: "delivered" },
    { session_id: "native-target", status: "ended" },
    { method: "unknown/mutation" },
    { jsonrpc: "2.0", method: "unknown/mutation" },
    [],
    null,
    [{ method: "tools/list" }, { status: "delivered" }],
    [{ method: "tools/call", params: { name: "coord:read" } }, { status: "delivered" }],
  ])("EI-259750: does not infer replay safety from absent tools/call: %j", (payload) => {
    const body = Buffer.from(JSON.stringify(payload));
    const prepared = prepareForward("POST", {}, body, { keyingEnabled: true, genKey: gen });
    expect(prepared.klass).toBe("opaque");
    expect(prepared.body).toBe(body);
  });
  it('non-JSON body → "opaque"', () => {
    expect(
      prepareForward("POST", {}, Buffer.from("not json"), {
        keyingEnabled: true,
        genKey: gen,
      }).klass,
    ).toBe("opaque");
  });
  it('GET / empty body → "opaque"', () => {
    expect(
      prepareForward("GET", {}, Buffer.alloc(0), {
        keyingEnabled: true,
        genKey: gen,
      }).klass,
    ).toBe("opaque");
  });
  it('an oversized tools/call is NOT rewritten (blocking guard) → "opaque"', () => {
    const body = Buffer.from(
      JSON.stringify({
        method: "tools/call",
        params: { name: "x", arguments: { big: "y".repeat(300 * 1024) } },
      }),
    );
    expect(
      prepareForward("POST", {}, body, { keyingEnabled: true, genKey: gen })
        .klass,
    ).toBe("opaque");
  });
  // EI-21268234394605529: a provably read-only tools/call replays safely without key machinery.
  it('every call naming a READ_ONLY_TOOLS verb → "readonly", body untouched', () => {
    const body = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"build:typecheck","arguments":{}}}',
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("readonly");
    expect(r.body).toBe(body); // no idempotencyKey injection — replay re-executes the read
    expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
  });
  it("EI-25897333491653710: only loop:checkpoint read:true is readonly", () => {
    const bodies = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "loop:checkpoint", arguments: { read: true } },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: { name: "loop:checkpoint", args: { read: true } },
        },
      }),
    ];
    for (const value of bodies) {
      const body = Buffer.from(value);
      const prepared = prepareForward("POST", {}, body, {
        keyingEnabled: true,
        genKey: gen,
      });
      expect(prepared.klass).toBe("readonly");
      expect(prepared.body).toBe(body);
    }

    for (const arguments_ of [{}, { read: false }, { read: "true" }]) {
      const prepared = prepareForward(
        "POST",
        {},
        Buffer.from(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "loop:checkpoint", arguments: arguments_ },
        })),
        { keyingEnabled: true, genKey: gen },
      );
      expect(prepared.klass).toBe("keyed");
    }
  });
  it('recipes:search is readonly and keeps the request body untouched', () => {
    const body = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recipes:search","arguments":{"query":"find a recovery recipe","semantic":false,"limit":5}}}',
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("readonly");
    expect(r.body).toBe(body);
    expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
  });
  it('coord:read is a pure single-message lookup → "readonly", body untouched', () => {
    const body = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"coord:read","arguments":{"msg_id":"msg-123"}}}',
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("readonly");
    expect(r.body).toBe(body);
    expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
  });
  it.each(["scorecards:get", "scorecards:list", "scorecards:evaluate"])(
    "%s stays replay-safe through deferred tools:invoke",
    (toolName) => {
      const body = Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: { name: toolName, args: { issueId: "EI-scorecard", rubricRef: "test-rubric" } },
        },
      }));
      const prepared = prepareForward("POST", {}, body, {
        keyingEnabled: true,
        genKey: () => "00000000-0000-4000-8000-000000000000",
      });
      expect(prepared.klass).toBe("readonly");
      expect(prepared.body).toBe(body);
    },
  );
  it.each([
    ["canonical", "conversations:list"],
    ["mcp__-mangled", "mcp__papercusp-su__conversations_list"],
  ])(
    "conversations:list %s is readonly and keeps the request body untouched",
    (_label, name) => {
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      );
      const r = prepareForward("POST", {}, body, {
        keyingEnabled: true,
        genKey: gen,
      });
      expect(r.klass).toBe("readonly");
      expect(r.body).toBe(body);
      expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
    },
  );
  it("consult:get_feedback remains keyed because it writes consult/conversation state", () => {
    const body = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"consult:get_feedback","arguments":{}}}',
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("keyed");
    expect(JSON.parse(r.body.toString()).params._meta.idempotencyKey).toBe(
      "KEY123",
    );
  });
  it.each(["loop:status", "events:status"])(
    "%s is a pure status snapshot → readonly",
    (name) => {
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      );
      const r = prepareForward("POST", {}, body, {
        keyingEnabled: true,
        genKey: gen,
      });
      expect(r.klass).toBe("readonly");
      expect(r.body).toBe(body);
      expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
    },
  );
  it("tools:invoke wrapping events:status is classified readonly", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: { name: "events:status", args: {} },
        },
      }),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("readonly");
    expect(r.body).toBe(body);
    expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
  });
  it("tools:invoke wrapping plans:get-spec-evidence is replay-safe", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "plans:get-spec-evidence",
            args: { harness: "papercusp", slug: "example-plan", detail: "full" },
          },
        },
      }),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("readonly");
    expect(r.body).toBe(body);
    expect(postConnectRetryable(r.klass, 0, 1, 100, 5_000)).toBe(true);
  });
  it.each([
    ["direct", { name: "release:cut", arguments: { op: "status" } }],
    [
      "tools:invoke with object args",
      {
        name: "tools:invoke",
        arguments: { name: "release:cut", args: { op: "status" } },
      },
    ],
    [
      "tools:invoke with ptool-stringified args",
      {
        name: "tools:invoke",
        arguments: {
          name: "release:cut",
          args: JSON.stringify({ op: "status" }),
        },
      },
    ],
  ])("%s release:cut status is readonly", (_label, params) => {
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("readonly");
    expect(r.body).toBe(body);
    expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
  });
  it.each(["run", "prepare-tag", "handoff", "run-leg", "abort-leg"])(
    "tools:invoke wrapping release:cut %s remains keyed",
    (op) => {
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "tools:invoke",
            arguments: { name: "release:cut", args: { op } },
          },
        }),
      );
      const r = prepareForward("POST", {}, body, {
        keyingEnabled: true,
        genKey: gen,
      });
      expect(r.klass).toBe("keyed");
      expect(JSON.parse(r.body.toString()).params._meta.idempotencyKey).toBe(
        "KEY123",
      );
    },
  );
  it("tools:invoke wrapping coord:whoami is classified readonly", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: { name: "coord:whoami", args: {} },
        },
      }),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("readonly");
    expect(r.body).toBe(body);
    expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
  });
  it("tools:invoke wrapping capability:read is classified readonly", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "capability:read",
            args: { file_path: "papercusp://scratch/ws/tools:invoke/run/result.md" },
          },
        },
      }),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("readonly");
    expect(r.body).toBe(body);
    expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
  });
  it.each([
    [
      "direct",
      {
        name: "scheduler:get_claim_spec",
        arguments: { fleet: "nonp2p-bug-drain-luna-max-0930" },
      },
    ],
    [
      "tools:invoke wrapper",
      {
        name: "tools:invoke",
        arguments: {
          name: "scheduler:get_claim_spec",
          args: { fleet: "nonp2p-bug-drain-luna-max-0930" },
        },
      },
    ],
  ])("scheduler:get_claim_spec %s is replay-safe", (_label, params) => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params,
      }),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("readonly");
    expect(r.body).toBe(body);
    expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
    expect(postConnectRetryable(r.klass, 0, 2, 1, 90_000)).toBe(true);
  });
  it.each([
    [
      "direct",
      {
        name: "capability:bash",
        arguments: { command: "rg -n -F needle packages/operator-core/lib" },
      },
    ],
    [
      "tools:invoke with object args",
      {
        name: "tools:invoke",
        arguments: {
          name: "capability:bash",
          args: { command: "rg -n -F needle packages/operator-core/lib" },
        },
      },
    ],
    [
      "tools:invoke with ptool-stringified args",
      {
        name: "tools:invoke",
        arguments: {
          name: "capability:bash",
          args: JSON.stringify({
            command: "rg -n -F needle packages/operator-core/lib",
          }),
        },
      },
    ],
  ])(
    "EI-21660633304527755: %s read-only capability:bash is replay-safe",
    (_label, params) => {
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params,
        }),
      );
      const r = prepareForward("POST", {}, body, {
        keyingEnabled: true,
        genKey: gen,
      });
      expect(r.klass).toBe("readonly");
      expect(r.body).toBe(body);
      expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
    },
  );
  it("EI-21660633304527755: a mutating capability:bash remains keyed", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "capability:bash",
            args: JSON.stringify({ command: "printf x > /tmp/proxy-write" }),
          },
        },
      }),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("keyed");
    expect(JSON.parse(r.body.toString()).params._meta.idempotencyKey).toBe(
      "KEY123",
    );
  });
  it.each([
    [
      "direct",
      {
        name: "capability:bash_output",
        arguments: { task_id: "task-1", peek: true },
      },
    ],
    [
      "tools:invoke with object args",
      {
        name: "tools:invoke",
        arguments: {
          name: "capability:bash_output",
          args: { task_id: "task-1", peek: true },
        },
      },
    ],
    [
      "tools:invoke with ptool-stringified args",
      {
        name: "tools:invoke",
        arguments: {
          name: "capability:bash_output",
          args: JSON.stringify({ task_id: "task-1", peek: true }),
        },
      },
    ],
  ])(
    "EI-25459298107511969: %s cursor-preserving capability:bash_output read is replay-safe",
    (_label, params) => {
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params,
        }),
      );
      const r = prepareForward("POST", {}, body, {
        keyingEnabled: true,
        genKey: gen,
      });
      expect(r.klass).toBe("readonly");
      expect(r.body).toBe(body);
      expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
    },
  );
  it("EI-25459298107511969: a consuming capability:bash_output poll remains keyed", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "capability:bash_output",
            args: { task_id: "task-1" },
          },
        },
      }),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("keyed");
    expect(JSON.parse(r.body.toString()).params._meta.idempotencyKey).toBe(
      "KEY123",
    );
  });
  it("tools:invoke wrapping a mutator remains keyed", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: { name: "work_items:complete", args: {} },
        },
      }),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("keyed");
    expect(JSON.parse(r.body.toString()).params._meta.idempotencyKey).toBe(
      "KEY123",
    );
  });
  it("code:run remains keyed but records that its nested effects are opaque to the proxy", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "code:run",
          arguments: {
            script: "return await tools.work_items.get({ id: 'EI-1' });",
          },
        },
      }),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    // code:run can invoke writes, so it must not enter the readonly replay class. The proxy
    // still records the wrapper shape so a terminal error can avoid calling a read-only script
    // a write without weakening replay safety.
    expect(r.klass).toBe("keyed");
    expect(r.hasCodeRunWrapper).toBe(true);
    expect(JSON.parse(r.body.toString()).params._meta.idempotencyKey).toBe("KEY123");
  });
  it.each([
    ["underscore alias", "docs_search"],
    ["fully mangled alias", "mcp__papercusp-su__docs_search"],
  ])("normalizes the %s before checking the read-only set", (_label, name) => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { query: "compaction critical-continuation queue" } },
      }),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("readonly");
    expect(r.body).toBe(body);
    expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
  });
  it('a batch mixing a read-only call with an unknown tool degrades to "keyed" (conservative)', () => {
    const body = Buffer.from(
      JSON.stringify([
        { method: "tools/call", params: { name: "build:typecheck" } },
        { method: "tools/call", params: { name: "work_items:create" } },
      ]),
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: gen,
    });
    expect(r.klass).toBe("keyed");
    expect(JSON.parse(r.body.toString())[1].params._meta.idempotencyKey).toBe(
      "KEY123",
    );
  });
  it("a malformed tools/call with no name is NOT readonly", () => {
    const body = Buffer.from(
      JSON.stringify({ method: "tools/call", params: {} }),
    );
    expect(
      prepareForward("POST", {}, body, { keyingEnabled: true, genKey: gen })
        .klass,
    ).toBe("keyed");
  });
  it("readonlyRetryEnabled:false falls back to the keyed path (kill-switch honored)", () => {
    const body = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"build:typecheck"}}',
    );
    const r = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      readonlyRetryEnabled: false,
      genKey: gen,
    });
    expect(r.klass).toBe("keyed");
  });
});

describe("WI-41045 — refresh the superuser bearer at the proxy boundary", () => {
  it("overrides a stale bearer only for superuser MCP requests and uses the injected reader", () => {
    let reads = 0;
    const headers = {
      authorization: "Bearer stale-client-token",
      accept: "application/json",
    };
    const refreshed = injectCurrentSuperuserBearer(
      "/api/mcp?superuser=1",
      headers,
      {
        tokenPath: "/tmp/test-superuser-token",
        readToken: (path) => {
          expect(path).toBe("/tmp/test-superuser-token");
          reads++;
          return "fresh-token";
        },
      },
    );

    expect(refreshed).toEqual({
      authorization: "Bearer fresh-token",
      accept: "application/json",
    });
    expect(reads).toBe(1);
    expect(
      injectCurrentSuperuserBearer("/api/mcp", headers, {
        tokenPath: "/tmp/test-superuser-token",
        readToken: () => "must-not-be-read",
      }),
    ).toBe(headers);
  });
});

describe("upstream hop-by-hop headers", () => {
  it("strips the client Connection header without mutating the client headers", () => {
    const headers = { connection: "close", accept: "application/json" };
    const forwarded = stripClientConnectionHeader(headers);

    expect(forwarded).toEqual({ accept: "application/json" });
    expect(headers.connection).toBe("close");
  });
});

describe("postConnectRetryable — write-free requests only", () => {
  it("opaque never replays (write-safety invariant)", () => {
    expect(postConnectRetryable("opaque", 0, 1, 100, 5_000)).toBe(false);
  });
  it("replays idempotent requests but never a keyed tools/call that may still be running", () => {
    expect(postConnectRetryable("idempotent", 0, 1, 100, 5_000)).toBe(true);
    expect(postConnectRetryable("keyed", 0, 1, 100, 5_000)).toBe(false);
  });
  it("is bounded by maxRetries (no unbounded post-connect replay)", () => {
    expect(postConnectRetryable("idempotent", 1, 1, 100, 5_000)).toBe(false);
    expect(MAX_POST_CONNECT_RETRIES).toBe(1);
  });
  it("does not replay past the window", () => {
    expect(postConnectRetryable("idempotent", 0, 1, 6_000, 5_000)).toBe(false);
  });
  it("EI-21268234394605529: readonly replays like idempotent — bounded, in-window", () => {
    expect(postConnectRetryable("readonly", 0, 1, 100, 5_000)).toBe(true);
    expect(postConnectRetryable("readonly", 1, 1, 100, 5_000)).toBe(false);
    expect(postConnectRetryable("readonly", 0, 1, 6_000, 5_000)).toBe(false);
  });
});

// EI-21268234394605529 guard: the curated allowlist must NEVER contain a mutating verb —
// a write wrongly listed here would be silently double-applied on a post-connect replay.
describe("READ_ONLY_TOOLS — writer-exclusion guard", () => {
  it("EI-25753161998628343: replays work_items:observe after a post-connect reset", () => {
    const args = { id: "WI-1", harness: "papercusp" };
    const calls = [
      { name: "work_items:observe", arguments: args },
      { name: "mcp__papercusp-su__work_items_observe", arguments: args },
      { name: "tools:invoke", arguments: { name: "work_items:observe", args } },
    ];

    expect(READ_ONLY_TOOLS).toContain("work_items:observe");
    for (const [index, params] of calls.entries()) {
      const body = Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/call",
        params,
      }));
      const prepared = prepareForward("POST", {}, body, {
        keyingEnabled: true,
        genKey: () => "00000000-0000-4000-8000-000000000000",
      });

      expect(prepared.klass).toBe("readonly");
      expect(prepared.body).toBe(body);
      expect(
        postConnectRetryable(
          prepared.klass,
          0,
          MAX_POST_CONNECT_RETRIES,
          100,
          5_000,
        ),
      ).toBe(true);
    }
  });

  it("keeps sessions:search out of pure-read retries because live refresh writes", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "sessions:search", arguments: { query: "needle" } },
      }),
    );

    const prepared = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: () => "00000000-0000-4000-8000-000000000000",
    });
    expect(READ_ONLY_TOOLS).not.toContain("sessions:search");
    expect(prepared.klass).toBe("keyed");
    expect(postConnectRetryable(prepared.klass, 0, 1, 100, 5_000)).toBe(false);
  });

  it("keeps sessions:timeline out of the free-replay class because live refresh writes", () => {
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "tools:invoke",
        arguments: { name: "sessions:timeline", args: { owner: "self" } },
      },
    }));

    const prepared = prepareForward("POST", {}, body, {
      keyingEnabled: true,
      genKey: () => "00000000-0000-4000-8000-000000000000",
    });
    expect(READ_ONLY_TOOLS).not.toContain("sessions:timeline");
    expect(prepared.klass).toBe("keyed");
    expect(postConnectRetryable(prepared.klass, 0, 1, 100, 5_000)).toBe(false);
  });

  it("EI-23074896897999125: classifies plans:get-specs as replay-safe", () => {
    for (const name of [
      "plans:get-specs",
      "mcp__papercusp-su__plans_get-specs",
    ]) {
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { slug: "example-plan" } },
        }),
      );

      expect(
        prepareForward("POST", {}, body, {
          keyingEnabled: true,
          genKey: () => "00000000-0000-4000-8000-000000000000",
        }).klass,
      ).toBe("readonly");
    }
  });

  it("never lists a known-mutating tool", () => {
    const writers = [
      "capability:bash",
      "capability:edit",
      "capability:git",
      "capability:write",
      "chat:ask_choice",
      "coord:ack",
      "coord:ask-owner",
      "coord:declare-intent",
      "coord:dispatch",
      "coord:orient",
      "coord:send",
      "consult:get_feedback",
      "db:migrate",
      "dev:restart",
      "events:await",
      "events:emit",
      "flags:set",
      "improvements:capture",
      "loop:arm",
      "loop:end",
      "loop:checkpoint",
      "memory:forget",
      "memory:remember",
      "plans:add-decision",
      "plans:add-item",
      "plans:new",
      "plans:set-now",
      "plans:set-status",
      "processes:freeze",
      "processes:kill",
      "processes:limit",
      "release:checkpoint-run",
      "release:deploy",
      "scheduler:get_next",
      "scheduler:set_claim_spec",
      "session:request-compaction",
      "tools:invoke",
      "watch:create",
      "work_items:checkpoint",
      "work_items:claim",
      "work_items:claim_next",
      "work_items:comment",
      "work_items:complete",
      "work_items:create",
      "work_items:release",
      "work_items:set_state",
      "work_items:update",
    ];
    for (const w of writers) expect([...READ_ONLY_TOOLS]).not.toContain(w);
  });

  it.each([
    ["coord:presence", { owner: "su-target" }],
    ["coord:presence", { ownerIds: ["su-target"] }],
    ["coord:roster", { owner: "su-target" }],
    ["coord:roster", { view: "members", owner: "su-target", project: "liveness" }],
  ])("classifies targeted %s as replay-safe", (name, arguments_) => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      }),
    );

    expect(
      prepareForward("POST", {}, body, {
        keyingEnabled: true,
        genKey: () => "00000000-0000-4000-8000-000000000000",
      }).klass,
    ).toBe("readonly");
  });
  it("entries are lowercase namespaced verbs", () => {
    for (const t of READ_ONLY_TOOLS)
      expect(t).toMatch(/^[a-z0-9_-]+:[a-z0-9_-]+$/);
  });

  // EI-21677017866028949 — EVERY entry must survive the normalized lookup. The classifier
  // normalizes the incoming name (normalizeMcpName folds `[:_.-]+` to ':'), so an entry
  // whose curated form carries an underscore used to normalize to a key absent from the
  // set and could never match: work_items:get did not match itself, and 9 of 38 entries
  // were silently unreachable, classifying 'keyed' and never replaying on a post-connect
  // reset. It survived because the guard above validates the STORED form (its regex even
  // allows `_`) while every classification test names an underscore-free verb.
  //
  // This iterates the WHOLE set in both forms a client actually sends, so a new entry that
  // is unreachable — or a change to normalizeMcpName that strands existing ones — fails here.
  it.each([...READ_ONLY_TOOLS])(
    "%s classifies readonly in both canonical and mcp__-mangled form",
    (verb) => {
      for (const name of [verb, `mcp__papercusp-su__${verb.replace(/:/g, "_")}`]) {
        const body = Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: {} },
          }),
        );
        expect(
          prepareForward("POST", {}, body, {
            keyingEnabled: true,
            genKey: () => "00000000-0000-4000-8000-000000000000",
          }).klass,
        ).toBe("readonly");
      }
    },
  );
});

// P-010: absorb an admission-control 429 (loop critically saturated → shed) by retrying.
describe("backpressure (429) absorption — pure decisions", () => {
  it("only 429 is treated as absorbable backpressure", () => {
    expect(isBackpressureStatus(429)).toBe(true);
    expect(isBackpressureStatus(503)).toBe(false); // proxy emits 503 itself; not absorbed
    expect(isBackpressureStatus(500)).toBe(false);
    expect(isBackpressureStatus(200)).toBe(false);
  });
  it("retries while under both the max count and the window", () => {
    expect(backpressureRetryable(0, MAX_BACKPRESSURE_RETRIES, 100, 5_000)).toBe(
      true,
    );
    expect(
      backpressureRetryable(
        MAX_BACKPRESSURE_RETRIES,
        MAX_BACKPRESSURE_RETRIES,
        100,
        5_000,
      ),
    ).toBe(false);
    expect(
      backpressureRetryable(0, MAX_BACKPRESSURE_RETRIES, 6_000, 5_000),
    ).toBe(false);
  });
  it("parses Retry-After delta-seconds, clamps, and falls back when absent/invalid", () => {
    expect(retryAfterMs("1", 500, 3_000)).toBe(1_000);
    expect(retryAfterMs(["2", "9"], 500, 3_000)).toBe(2_000); // first element
    expect(retryAfterMs("99", 500, 3_000)).toBe(3_000); // clamped to max
    expect(retryAfterMs(undefined, 500, 3_000)).toBe(500); // fallback
    expect(retryAfterMs("", 500, 3_000)).toBe(500); // empty → fallback
    expect(retryAfterMs("garbage", 500, 3_000)).toBe(500); // invalid → fallback
    expect(retryAfterMs("-4", 500, 3_000)).toBe(500); // negative → fallback
  });
});

describe("retryAfterSecForDrainRate — bounded completion-derived shed hint", () => {
  const nowMs = 60_000;

  it("uses the conservative upper bound when no recent drain is observed", () => {
    expect(retryAfterSecForDrainRate(200, 192, [], nowMs)).toBe(
      MAX_SHED_RETRY_AFTER_SEC,
    );
    expect(retryAfterSecForDrainRate(200, 192, [nowMs - 60_000], nowMs)).toBe(
      MAX_SHED_RETRY_AFTER_SEC,
    );
  });

  it("estimates the completions needed from the observed completion cadence", () => {
    const completions = [nowMs - 9_000, nowMs - 6_000, nowMs - 3_000]; // one completion every 3s
    expect(retryAfterSecForDrainRate(192, 192, completions, nowMs)).toBe(3);
    expect(retryAfterSecForDrainRate(194, 192, completions, nowMs)).toBe(9);
  });

  it("clamps a very fast or stalled estimate to the configured bounds", () => {
    expect(
      retryAfterSecForDrainRate(192, 192, [nowMs - 2, nowMs - 1], nowMs),
    ).toBe(MIN_SHED_RETRY_AFTER_SEC);
    expect(
      retryAfterSecForDrainRate(500, 1, [nowMs - 9_000, nowMs - 3_000], nowMs),
    ).toBe(MAX_SHED_RETRY_AFTER_SEC);
  });
});

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
function listen(s: http.Server, p = 0): Promise<http.Server> {
  return new Promise((res) => s.listen(p, "127.0.0.1", () => res(s)));
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
function request(
  p: number,
  body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  path = "/api/mcp",
  headers: http.OutgoingHttpHeaders = {},
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: p, method: "POST", path, headers },
      (res) => {
        const b = createTextCollector(res);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: b.text(),
            headers: res.headers,
          }),
        );
      },
    );
    r.on("error", reject);
    r.end(body);
  });
}

function get(
  p: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: p, method: "GET", path },
      (res) => {
        const b = createTextCollector(res);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b.text() }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("createMcpProxy — client-facing keep-alive policy (EI-21275891049298859)", () => {
  it("applies the shared WI-1711 timeout instead of Node's racy 5s default", async () => {
    const previousKeepAlive = process.env.PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS;
    const previousHeaders = process.env.PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS;
    delete process.env.PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS;
    delete process.env.PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS;
    try {
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: 1,
          retryWindowMs: 100,
          log: () => {},
        }),
      );
      await listen(proxy);

      expect(proxy.keepAliveTimeout).toBe(DEFAULT_KEEPALIVE_TIMEOUT_MS);
      expect(proxy.keepAliveTimeout).toBeGreaterThan(5_000);
      expect(proxy.headersTimeout).toBeGreaterThan(proxy.keepAliveTimeout);
    } finally {
      if (previousKeepAlive === undefined)
        delete process.env.PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS;
      else process.env.PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS = previousKeepAlive;
      if (previousHeaders === undefined)
        delete process.env.PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS;
      else process.env.PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS = previousHeaders;
    }
  });
});

describe("WI-41257: inbound refusal and accept-pressure telemetry", () => {
  it("records clientError/socket-reset and drop events, and exposes bounded counters locally", async () => {
    const logs: string[] = [];
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: 1,
        retryWindowMs: 100,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const socket = new net.Socket();
    const reset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    proxy.emit("clientError", reset, socket);
    proxy.emit("drop", {
      remoteAddress: "127.0.0.1",
      remotePort: 4567,
      remoteFamily: "IPv4",
    });

    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inbound).toMatchObject({
      clientErrors: 1,
      socketResets: 1,
      drops: 1,
    });
    expect(health.inFlight).toMatchObject({
      total: 0,
      ordinary: 0,
      reservedControlPlane: 0,
      watchdog: 0,
      criticalContinuation: 0,
    });
    expect(socket.destroyed).toBe(true);
    expect(logs.some((line) => line.includes("inbound client error"))).toBe(
      true,
    );
    expect(
      logs.some((line) => line.includes("inbound connection dropped")),
    ).toBe(true);
  });
});

/**
 * WI-6743 regression. The watchdog's liveness probe used to poll `/api/health`, which this
 * proxy FORWARDS. That is unanswerable precisely when retry-on-refused is doing its job, so
 * every :3070 deploy restart was recorded as a proxy outage: 272 false `unreachable` incidents
 * between 2026-07-10 and 2026-08-02, which also buried the genuine-wedge signal the watchdog
 * exists to raise (a real wedge produced a byte-identical log line).
 *
 * The invariant: while the upstream is down and the proxy is holding a forwarded request, the
 * proxy-local health path must STILL answer — that is what makes it a sound liveness probe.
 */
describe("createMcpProxy — proxy-local health path stays truthful during an upstream outage (WI-6743)", () => {
  it("answers the local health path while the upstream is dead", async () => {
    const dead = await freePort(); // nothing listening => ECONNREFUSED on every forward
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: dead,
        retryWindowMs: 5_000,
        retryBackoffMs: 20,
        log: () => {},
      }),
    );
    await listen(proxy);

    const started = Date.now();
    const res = await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    // Must return immediately — NOT after the retry window. This is the whole point.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("THE BUG: a FORWARDED path cannot answer during the same outage", async () => {
    // Demonstrates why polling `/api/health` (forwarded) made the watchdog lie. The old probe
    // aborted at 5s and logged `unreachable`; here we shorten the window so the hold is visible
    // without the test waiting on it.
    const dead = await freePort();
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: dead,
        retryWindowMs: 700,
        retryBackoffMs: 20,
        log: () => {},
      }),
    );
    await listen(proxy);

    const started = Date.now();
    const res = await request(port(proxy), '{"jsonrpc":"2.0"}', "/api/mcp");
    const elapsed = Date.now() - started;

    expect(res.status).toBe(503); // held for the whole window, then gave up
    expect(elapsed).toBeGreaterThanOrEqual(600);
  });
});

describe("MCP proxy serving-generation affinity", () => {
  it("derives a bounded key from native session identity before client fallback", () => {
    const queryKey = mcpProxyGenerationAffinityKey(
      "/api/mcp?native_session=query-secret&client=client-a",
    );
    const headerKey = mcpProxyGenerationAffinityKey(
      "/api/mcp?native_session=query-secret&client=client-a",
      { "x-papercusp-native-session": "header-secret" },
    );
    expect(queryKey).toMatch(/^mcp-affinity:[0-9a-f]{32}$/);
    expect(headerKey).toMatch(/^mcp-affinity:[0-9a-f]{32}$/);
    expect(headerKey).not.toBe(queryKey);
    expect(mcpProxyGenerationAffinityKey("/api/other?client=client-a")).toBeNull();
  });

  it("recognizes handshake and generation-bound tools:invoke requests", () => {
    const path = "/api/mcp?client=client-a";
    expect(
      isGenerationBoundMcpRequest(
        Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'),
        path,
      ),
    ).toBe(true);
    expect(
      isGenerationBoundMcpRequest(
        Buffer.from(
          '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tools:invoke","arguments":{"name":"scorecards:get","servingGeneration":"serving-generation-v1:test"}}}',
        ),
        path,
      ),
    ).toBe(true);
    expect(
      isGenerationBoundMcpRequest(
        Buffer.from('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"scorecards:get","arguments":{}}}'),
        path,
      ),
    ).toBe(false);
  });

  it("reuses one upstream socket for a generation-bound client while preserving fresh sockets for unbound calls", async () => {
    let connections = 0;
    const upstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200, {
          "content-type": "application/json",
          connection: "keep-alive",
        });
        res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      }),
    );
    upstream.on("connection", () => {
      connections++;
    });
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        log: () => {},
      }),
    );
    await listen(proxy);

    const listBody = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const invokeBody =
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tools:invoke","arguments":{"name":"scorecards:get","servingGeneration":"serving-generation-v1:test"}}}';
    const sessionPath = "/api/mcp?client=affinity-client";
    expect((await request(port(proxy), listBody, sessionPath)).status).toBe(200);
    expect((await request(port(proxy), invokeBody, sessionPath)).status).toBe(200);
    expect(connections).toBe(1);

    expect((await request(port(proxy), listBody)).status).toBe(200);
    expect((await request(port(proxy), listBody)).status).toBe(200);
    expect(connections).toBe(3);
  });
});

describe("createMcpProxy — forwarding + restart recovery", () => {
  it("passes a request through to the upstream and returns its response", async () => {
    const upstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"ok"}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 50,
        log: () => {},
      }),
    );
    await listen(proxy);

    const r = await request(port(proxy));
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"ok"}');
  });

  it("does not forward a client Connection: close to the capped control-plane agent", async () => {
    const seenConnections: Array<string | undefined> = [];
    const upstream = track(
      http.createServer((req, res) => {
        seenConnections.push(req.headers.connection);
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"ok"}');
      }),
    );
    await listen(upstream);
    const controlPlaneAgent = new http.Agent({
      keepAlive: false,
      maxSockets: 1,
    });
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        controlPlaneAgent,
        log: () => {},
      }),
    );
    await listen(proxy);

    try {
      const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
      const headers = {
        connection: "close",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      };
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(port(proxy), body, "/api/mcp?superuser=1", headers),
        ),
      );

      expect(results.every((result) => result.status === 200)).toBe(true);
      expect(seenConnections).toHaveLength(4);
      expect(
        seenConnections.every((connection) => connection !== "close"),
      ).toBe(true);
    } finally {
      controlPlaneAgent.destroy();
    }
  });

  it("does not accumulate connect listeners when a keep-alive upstream socket is reused", async () => {
    const upstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"ok"}');
      }),
    );
    await listen(upstream);

    const clientSockets: net.Socket[] = [];
    const upstreamAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 1,
    });
    const baseCreateConnection = upstreamAgent.createConnection;
    upstreamAgent.createConnection = (options, callback) => {
      const socket = baseCreateConnection.call(
        upstreamAgent,
        options,
        callback,
      );
      clientSockets.push(socket as net.Socket);
      return socket;
    };
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        upstreamAgent,
        log: () => {},
      }),
    );
    await listen(proxy);

    try {
      const ordinaryCall = '{"method":"tools/call","params":{"name":"unit:hold"}}';
      expect((await request(port(proxy), ordinaryCall)).status).toBe(200);
      expect(clientSockets).toHaveLength(1);
      const listenerCountAfterConnect =
        clientSockets[0].listenerCount("connect");

      // Before the `s.connecting === false` guard, each reuse added a `once('connect')`
      // listener to this already-connected socket. Twelve calls crossed Node's default
      // warning threshold in the incident; the count must remain stable after reuse.
      for (let i = 0; i < 12; i++) {
        expect((await request(port(proxy), ordinaryCall)).status).toBe(200);
      }
      expect(clientSockets).toHaveLength(1);
      expect(clientSockets[0].listenerCount("connect")).toBe(
        listenerCountAfterConnect,
      );
      expect(clientSockets[0].listenerCount("connect")).toBe(0);
    } finally {
      upstreamAgent.destroy();
    }
  });

  it("P-010: ABSORBS an upstream 429 (admission shed) and returns the eventual 200 — saturation invisible", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const logFile = path.join(
      os.tmpdir(),
      `mcp-proxy-absorb-429-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const previousLogFile = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    let calls = 0;
    const degradedHeaders: Array<string | undefined> = [];
    const upstreamTraceIds: string[] = [];
    const admissionBodies = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32000,
          message: "operator MCP admission is saturated",
          data: { retryable: true, reason: "loop_pressure_critical" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: -32000,
          message: "operator MCP admission is saturated",
          data: { retryable: true, reason: "operator_admission_capacity" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        error: {
          code: -32000,
          message: "operator MCP admission is saturated",
          data: { retryable: true, reason: "untrusted-admission-secret" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        error: {
          code: -32000,
          message: "operator MCP admission is saturated",
          data: { retryable: true, reason: "loop_pressure_critical" },
        },
        padding: "x".repeat(MAX_MCP_ADMISSION_REASON_BODY_BYTES + 1),
      }),
    ];
    try {
      process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
      const upstream = track(
        http.createServer((req, res) => {
          calls++;
          upstreamTraceIds.push(
            String(req.headers[MCP_PROXY_TRACE_HEADER] ?? ""),
          );
          degradedHeaders.push(
            req.headers[MCP_PROXY_DATA_PLANE_DEGRADED_AT_HEADER] as
              | string
              | undefined,
          );
          if (calls <= admissionBodies.length) {
            // Admission reasons stay private to the allowlist; oversized envelopes are not parsed.
            res.writeHead(429, {
              "content-type": "application/json",
              "retry-after": "0",
            });
            res.end(admissionBodies[calls - 1]);
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":"admitted"}');
        }),
      );
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          retryBackoffMs: 20,
          log: () => {},
        }),
      );
      await listen(proxy);

      const r = await request(port(proxy));
      expect(r.status).toBe(200);
      expect(r.body).toBe('{"result":"admitted"}');
      expect(calls).toBe(5); // four 429s absorbed, fifth admitted — the agent never saw a 429
      expect(degradedHeaders[0]).toBeUndefined();
      expect(degradedHeaders[1]).toMatch(/^\d+$/);
      expect(Number(degradedHeaders[2])).toBeGreaterThanOrEqual(
        Number(degradedHeaders[1]),
      );
      expect(Number(degradedHeaders[3])).toBeGreaterThanOrEqual(
        Number(degradedHeaders[2]),
      );
      expect(Number(degradedHeaders[4])).toBeGreaterThanOrEqual(
        Number(degradedHeaders[3]),
      );

      const logText = fs.readFileSync(logFile, "utf8");
      const absorbed = logText
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.kind === "absorb_429");
      expect(absorbed).toHaveLength(4);
      expect(absorbed.map((entry) => entry.traceId)).toEqual(
        upstreamTraceIds.slice(0, 4),
      );
      expect(absorbed.map((entry) => entry.reason ?? null)).toEqual([
        "loop_pressure_critical",
        "operator_admission_capacity",
        null,
        null,
      ]);
      expect(logText).not.toContain("untrusted-admission-secret");

      const followup = await request(port(proxy));
      expect(followup.status).toBe(200);
      expect(degradedHeaders[5]).toBe(degradedHeaders[4]);
    } finally {
      fs.rmSync(logFile, { force: true });
      if (previousLogFile === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = previousLogFile;
    }
  });

  it("EI-16883: ABSORBS a boot-window 405 (route table not yet mounted) and returns the eventual 200", async () => {
    let calls = 0;
    const upstream = track(
      http.createServer((_req, res) => {
        calls++;
        if (calls <= 2) {
          // Mid-restart: socket accepts but /api/mcp is not mounted yet → Hono answers 405.
          res.writeHead(405, { "content-type": "text/plain" });
          res.end("Method Not Allowed");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"mounted"}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 20,
        log: () => {},
      }),
    );
    await listen(proxy);

    const r = await request(port(proxy));
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"mounted"}');
    expect(calls).toBe(3); // two boot-window 405s absorbed — the client never saw them
  });

  it("keeps a non-MCP boot-route 404 from marking later MCP requests degraded", async () => {
    let restrictedRouteCalls = 0;
    const forwarded: Array<{ path: string; degradedAt: string | undefined }> = [];
    const upstream = track(
      http.createServer((req, res) => {
        forwarded.push({
          path: req.url ?? "",
          degradedAt: req.headers[MCP_PROXY_DATA_PLANE_DEGRADED_AT_HEADER] as
            | string
            | undefined,
        });
        if (
          req.url === "/api/agent-mcp/restricted-egress-check" &&
          restrictedRouteCalls++ === 0
        ) {
          res.writeHead(404, { "content-type": "text/plain", "retry-after": "0" });
          res.end("route not mounted");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"ok"}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 20,
        log: () => {},
      }),
    );
    await listen(proxy);

    const restricted = await request(
      port(proxy),
      '{"probe":true}',
      "/api/agent-mcp/restricted-egress-check",
    );
    expect(restricted.status).toBe(200);
    expect(restrictedRouteCalls).toBe(2); // the initial boot-window 404 was absorbed

    const mcp = await request(port(proxy), '{"jsonrpc":"2.0"}', "/api/mcp");
    expect(mcp.status).toBe(200);

    const restrictedAttempts = forwarded.filter(
      ({ path }) => path === "/api/agent-mcp/restricted-egress-check",
    );
    expect(restrictedAttempts.map(({ degradedAt }) => degradedAt)).toEqual([
      undefined,
      undefined,
    ]);
    expect(
      forwarded.find(({ path }) => path === "/api/mcp")?.degradedAt,
    ).toBeUndefined();
  });

  it("keeps a non-MCP upstream reset from marking later MCP requests degraded", async () => {
    const restPath = "/api/agent-mcp/transport-probe";
    let mcpDegradedAt: string | undefined;
    const upstream = track(
      http.createServer((req, res) => {
        if (req.url === restPath) {
          req.socket.destroy(); // a post-connect transport failure on the REST route
          return;
        }
        if (req.url === "/api/mcp") {
          mcpDegradedAt = req.headers[
            MCP_PROXY_DATA_PLANE_DEGRADED_AT_HEADER
          ] as string | undefined;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"ok"}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 20,
        log: () => {},
      }),
    );
    await listen(proxy);

    const rest = await request(port(proxy), '{"probe":true}', restPath);
    expect(rest.status).toBe(502);

    const mcp = await request(port(proxy), '{"jsonrpc":"2.0"}', "/api/mcp");
    expect(mcp.status).toBe(200);
    expect(mcpDegradedAt).toBeUndefined();
  });

  it("EI-16883: kill-switch (PAPERCUSP_MCP_PROXY_ABSORB_BOOT=0) surfaces the 405 instead of absorbing it", async () => {
    const prev = process.env.PAPERCUSP_MCP_PROXY_ABSORB_BOOT;
    process.env.PAPERCUSP_MCP_PROXY_ABSORB_BOOT = "0";
    try {
      const upstream = track(
        http.createServer((_req, res) => {
          res.writeHead(405, { "content-type": "text/plain" });
          res.end("Method Not Allowed");
        }),
      );
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 2_000,
          retryBackoffMs: 20,
          log: () => {},
        }),
      );
      await listen(proxy);

      const r = await request(port(proxy));
      expect(r.status).toBe(405);
    } finally {
      if (prev === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_ABSORB_BOOT;
      else process.env.PAPERCUSP_MCP_PROXY_ABSORB_BOOT = prev;
    }
  });

  it("P-010: kill-switch (PAPERCUSP_MCP_PROXY_ABSORB_429=0) surfaces the 429 instead of absorbing it", async () => {
    const prev = process.env.PAPERCUSP_MCP_PROXY_ABSORB_429;
    process.env.PAPERCUSP_MCP_PROXY_ABSORB_429 = "0";
    try {
      const upstream = track(
        http.createServer((_req, res) => {
          res.writeHead(429, {
            "content-type": "application/json",
            "retry-after": "1",
          });
          res.end('{"error":"shed"}');
        }),
      );
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          retryBackoffMs: 20,
          log: () => {},
        }),
      );
      await listen(proxy);
      const r = await request(port(proxy));
      expect(r.status).toBe(429); // forwarded straight through, no absorption
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MCP_PROXY_ABSORB_429;
      else process.env.PAPERCUSP_MCP_PROXY_ABSORB_429 = prev;
    }
  });

  it("RETRIES a refused upstream and recovers when :3070 comes back (restart invisible)", async () => {
    const targetPort = await freePort(); // nothing listening yet → connection refused
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort,
        retryWindowMs: 5_000,
        retryBackoffMs: 100,
        log: () => {},
      }),
    );
    await listen(proxy);

    // Fire the request while the upstream is DOWN; bring it up ~300ms later.
    const pending = request(port(proxy));
    setTimeout(() => {
      const upstream = track(
        http.createServer((_req, res) => {
          res.writeHead(200);
          res.end('{"result":"recovered"}');
        }),
      );
      void listen(upstream, targetPort);
    }, 300);

    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"recovered"}');
  });

  it("WI-3247: re-resolves a dynamic target between refused retries (packaged operator port changed)", async () => {
    const oldPort = await freePort(); // stale operator.json port: stays down
    const newUpstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200);
        res.end('{"result":"new-port"}');
      }),
    );
    await listen(newUpstream);
    let target: McpProxyTarget = {
      host: "127.0.0.1",
      port: oldPort,
      source: "operator.json",
    };
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        resolveTarget: () => target,
        retryWindowMs: 5_000,
        retryBackoffMs: 100,
        log: () => {},
      }),
    );
    await listen(proxy);

    const pending = request(port(proxy));
    setTimeout(() => {
      target = {
        host: "127.0.0.1",
        port: port(newUpstream),
        source: "operator.json",
      };
    }, 300);

    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"new-port"}');
  });

  it("uses an ordered dev fallback only after the primary refuses pre-connect", async () => {
    const primaryPort = await freePort(); // the canonical target is down
    const hits: string[] = [];
    const fallback = track(
      http.createServer((_req, res) => {
        hits.push("fallback");
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"staging-fallback"}');
      }),
    );
    await listen(fallback);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        resolveTargets: () =>
          staticMcpProxyTargets("127.0.0.1", primaryPort, port(fallback)),
        retryWindowMs: 1_000,
        retryBackoffMs: 20,
        log: () => {},
      }),
    );
    await listen(proxy);

    const r = await request(port(proxy));
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"staging-fallback"}');
    expect(hits).toEqual(["fallback"]);
  });

  it("keeps a dynamic packaged/operator.json resolver single-candidate", async () => {
    const operatorPort = await freePort(); // the packaged target is down
    let devFallbackHits = 0;
    const devFallback = track(
      http.createServer((_req, res) => {
        devFallbackHits++;
        res.writeHead(200);
        res.end('{"result":"must-not-be-used"}');
      }),
    );
    await listen(devFallback);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        // This static target stands in for the dev fallback. The dynamic resolver
        // must win and must not be augmented with an implicit second candidate.
        targetHost: "127.0.0.1",
        targetPort: port(devFallback),
        resolveTarget: () => ({
          host: "127.0.0.1",
          port: operatorPort,
          source: "operator.json",
        }),
        retryWindowMs: 160,
        retryBackoffMs: 20,
        log: () => {},
      }),
    );
    await listen(proxy);

    const r = await request(port(proxy));
    expect(r.status).toBe(503);
    expect(r.body).toContain("mcp_proxy_upstream_unavailable");
    expect(devFallbackHits).toBe(0);
  });

  it("exposes proxy-local health without touching the upstream", async () => {
    const targetPort = await freePort(); // down; health should still be proxy-local
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort,
        retryWindowMs: 400,
        retryBackoffMs: 100,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: port(proxy),
            method: "GET",
            path: "/__mcp_proxy_health",
          },
          (res) => {
            const b = createTextCollector(res);
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: b.text() }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(r.status).toBe(200);
    expect(r.body).toContain('"ok":true');
  });

  it("503s (not a hang, not a replay) when the upstream is refused for the whole window", async () => {
    const targetPort = await freePort(); // stays down
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort,
        retryWindowMs: 400,
        retryBackoffMs: 100,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(port(proxy));
    expect(r.status).toBe(503);
    expect(r.body).toContain("mcp_proxy_upstream_unavailable");
    expect(JSON.parse(r.body).note).toContain("upstream target refused connections");
    expect(JSON.parse(r.body).note).not.toContain(":3070");
  });

  it("does NOT reuse upstream sockets — a FRESH connection per forward (W1.3 stale-socket-400 guard)", async () => {
    // backend-reliability-100pct-2026-07-03 W1.3: reusing a pooled keep-alive socket to the :3070
    // cluster races the server/worker closing it → a forwarded request lands on a half-closed
    // socket → :3070 returns a spurious `400 Bad Request` the proxy forwards as a tool error
    // (~13% measured). The fix (UPSTREAM_AGENT keepAlive:false) opens a fresh socket per forward.
    // GUARD: sequential requests (where a pooled socket WOULD be reused) must each open a NEW
    // upstream connection — connections === requests. Pre-fix (global keepAlive agent) this is < N.
    let connections = 0;
    const upstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"ok"}');
      }),
    );
    upstream.on("connection", () => {
      connections++;
    });
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 50,
        log: () => {},
      }),
    );
    await listen(proxy);

    const N = 4;
    for (let i = 0; i < N; i++) {
      const r = await request(port(proxy)); // sequential — a pooled keep-alive socket would be reused here
      expect(r.status).toBe(200);
    }
    expect(connections).toBe(N);
  });

  it("RECORDS forwarded failures to the durable JSONL sink (W8 visibility — kills the under-counting)", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const logFile = path.join(
      os.tmpdir(),
      `mcp-proxy-fail-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const prev = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    try {
      const targetPort = await freePort(); // nothing listening → refused for the whole window → 503 exhaustion
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort,
          retryWindowMs: 250,
          retryBackoffMs: 60,
          log: () => {},
        }),
      );
      await listen(proxy);
      const r = await request(port(proxy));
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).forwardingResult).toBe("not_forwarded");
      // The exhaustion (previously invisible in tool_invocations) must be durably recorded.
      const recs = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const rec = recs.find((x) => x.kind === "exhausted_refused");
      expect(rec).toBeTruthy();
      expect(rec.status).toBe(503);
      expect(rec.forwardingResult).toBe("not_forwarded");
      expect(typeof rec.ts).toBe("string");
      expect(rec.attempts).toBeGreaterThanOrEqual(1);
      fs.rmSync(logFile, { force: true });
    } finally {
      if (prev === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = prev;
    }
  });

  it("rotates the durable failure sink before it exceeds the configured ceiling", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const logFile = path.join(
      os.tmpdir(),
      `mcp-proxy-rotate-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const prevPath = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    const prevMax = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG_MAX_BYTES;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG_MAX_BYTES = "32";
    try {
      fs.writeFileSync(logFile, "x".repeat(64));
      const targetPort = await freePort();
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort,
          retryWindowMs: 120,
          retryBackoffMs: 20,
          log: () => {},
        }),
      );
      await listen(proxy);
      expect((await request(port(proxy))).status).toBe(503);
      expect(fs.existsSync(`${logFile}.1`)).toBe(true);
      expect(fs.readFileSync(`${logFile}.1`, "utf8")).toBe("x".repeat(64));
      expect(fs.readFileSync(logFile, "utf8")).toContain(
        '"kind":"exhausted_refused"',
      );
    } finally {
      fs.rmSync(logFile, { force: true });
      fs.rmSync(`${logFile}.1`, { force: true });
      if (prevPath === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = prevPath;
      if (prevMax === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG_MAX_BYTES;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG_MAX_BYTES = prevMax;
    }
  });

  // P-005: an upstream that RESETS the first connection post-connect, then serves.
  function resetOnceUpstream(bodyOut: string): http.Server {
    let hits = 0;
    const s = track(
      http.createServer((req, res) => {
        hits++;
        if (hits === 1) {
          req.socket.destroy(); // post-connect reset (worker-recycle-mid-request class)
          return;
        }
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(bodyOut);
        });
      }),
    );
    (s as http.Server & { hits: () => number }).hits = () => hits;
    return s;
  }

  // Simulates a keyed call whose side effect lands before the upstream loses its response.
  // This distinguishes a post-apply connection reset from a pre-connect refusal.
  function applyThenResetUpstream(): http.Server & {
    hits: () => number;
    appliedEffects: () => number;
    receivedKeys: () => string[];
  } {
    let hits = 0;
    const receivedKeys: string[] = [];
    const appliedKeys = new Set<string>();
    const storedResponses = new Map<string, string>();
    const server = track(
      http.createServer((req, res) => {
        hits++;
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            params?: { _meta?: { idempotencyKey?: unknown } };
          };
          const rawKey = envelope.params?._meta?.idempotencyKey;
          const key = typeof rawKey === "string" ? rawKey : "";
          receivedKeys.push(key);
          const stored = storedResponses.get(key);
          if (stored) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(stored);
            return;
          }
          if (key) appliedKeys.add(key);
          if (key) storedResponses.set(key, '{"result":{"receipt":"applied-once"}}');
          req.socket.destroy();
        });
      }),
    );
    return Object.assign(server, {
      hits: () => hits,
      appliedEffects: () => appliedKeys.size,
      receivedKeys: () => [...receivedKeys],
    });
  }

  const TOOLS_CALL =
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{}}}';

  function withKeyedRetry(
    v: string | undefined,
    fn: () => Promise<void>,
  ): () => Promise<void> {
    return async () => {
      const prev = process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY;
      if (v === undefined) delete process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY;
      else process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY = v;
      try {
        await fn();
      } finally {
        if (prev === undefined)
          delete process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY;
        else process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY = prev;
      }
    };
  }

  it(
    "does not fail over to a second candidate after a connected tools/call reset",
    withKeyedRetry("1", async () => {
      const primary = resetOnceUpstream(
        '{"result":"must-not-replay"}',
      ) as http.Server & { hits: () => number };
      await listen(primary);
      let fallbackHits = 0;
      const fallback = track(
        http.createServer((_req, res) => {
          fallbackHits++;
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":"unsafe-fallback"}');
        }),
      );
      await listen(fallback);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          resolveTargets: () =>
            staticMcpProxyTargets("127.0.0.1", port(primary), port(fallback)),
          retryWindowMs: 2_000,
          retryBackoffMs: 40,
          log: () => {},
        }),
      );
      await listen(proxy);

      const r = await request(port(proxy), TOOLS_CALL);
      expect(r.status).toBe(502);
      expect(r.body).toContain("mcp_proxy_upstream_error");
      expect(primary.hits()).toBe(1);
      expect(fallbackHits).toBe(0);
    }),
  );

  it(
    "a KEYED tools/call does not replay after a post-connect reset while the first execution may still be running",
    withKeyedRetry("1", async () => {
      const upstream = resetOnceUpstream(
        '{"result":"keyed-recovered"}',
      ) as http.Server & { hits: () => number };
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          retryBackoffMs: 40,
          log: () => {},
        }),
      );
      await listen(proxy);
      const r = await request(port(proxy), TOOLS_CALL);
      expect(r.status).toBe(502);
      expect(r.body).toContain("mcp_proxy_upstream_error");
      expect(upstream.hits()).toBe(1);
    }),
  );

  it(
    "code:run failure guidance names the nested outcome without asserting that it was a write",
    withKeyedRetry("1", async () => {
      const upstream = resetOnceUpstream(
        '{"result":"should-not-reach"}',
      ) as http.Server & { hits: () => number };
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 2_000,
          retryBackoffMs: 40,
          log: () => {},
        }),
      );
      await listen(proxy);
      const r = await request(
        port(proxy),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "code:run",
            arguments: {
              script: "return await tools.work_items.get({ id: 'EI-1' });",
            },
          },
        }),
      );
      expect(r.status).toBe(502);
      const payload = JSON.parse(r.body) as { note?: string };
      expect(payload.note).toContain("outer code:run wrapper's nested outcome is unknown");
      expect(payload.note).toContain("may have performed reads or writes");
      expect(payload.note).not.toContain("the write's outcome is unknown");
      expect(upstream.hits()).toBe(1); // keyed safety remains unchanged
    }),
  );

  it(
    "records outcome_unknown when code:run applies before a post-connect reset",
    withKeyedRetry("1", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const logFile = path.join(
        os.tmpdir(),
        `mcp-proxy-code-run-reset-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
      );
      const previousLogFile = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
      const traceInfo = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const upstream = applyThenResetUpstream();
        await listen(upstream);
        const proxy = track(
          createMcpProxy({
            listenPort: 0,
            targetHost: "127.0.0.1",
            targetPort: port(upstream),
            retryWindowMs: 2_000,
            retryBackoffMs: 40,
            log: () => {},
          }),
        );
        await listen(proxy);

        const r = await request(
          port(proxy),
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "code:run",
              arguments: { script: "return 'controlled apply-then-reset';" },
            },
          }),
        );
        expect(r.status).toBe(502);
        const payload = JSON.parse(r.body) as {
          traceId?: string;
          forwardingResult?: string;
          attempts?: number;
          note?: string;
          recovery?: {
            idempotencyKeys?: Array<{
              requestId: string | number;
              toolName: string;
              key: string;
            }>;
            truncated?: boolean;
            instructions?: string;
          };
        };
        expect(payload.forwardingResult).toBe("outcome_unknown");
        expect(payload.attempts).toBe(1);
        expect(payload.note).toContain(
          "outer code:run wrapper's nested outcome is unknown",
        );
        expect(upstream.hits()).toBe(1);
        expect(upstream.appliedEffects()).toBe(1);
        expect(upstream.receivedKeys()).toHaveLength(1);
        expect(upstream.receivedKeys()[0]).toBeTruthy();
        expect(payload.recovery).toMatchObject({
          idempotencyKeys: [{ requestId: 1, toolName: "code:run" }],
          truncated: false,
        });
        expect(payload.recovery?.idempotencyKeys?.[0]?.key).toBe(
          upstream.receivedKeys()[0],
        );
        expect(payload.recovery?.instructions).toContain("--idempotency-key <key>");
        expect(payload.note).toContain("recovery.idempotencyKeys");

        // The first attempt may have committed but lost its response. Reconcile state,
        // then replay the same logical call with the receipt key to retrieve the stored result.
        const recoveryKey = payload.recovery!.idempotencyKeys![0]!.key;
        const replayCall = {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "code:run",
            arguments: { script: "return 'controlled apply-then-reset';" },
            _meta: { idempotencyKey: recoveryKey },
          },
        };
        const replayed = await request(port(proxy), JSON.stringify(replayCall));
        expect(replayed.status).toBe(200);
        expect(replayed.body).toBe('{"result":{"receipt":"applied-once"}}');
        expect(upstream.hits()).toBe(2);
        expect(upstream.appliedEffects()).toBe(1);
        expect(upstream.receivedKeys()).toEqual([recoveryKey, recoveryKey]);

        const entries = fs
          .readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const failure = entries.find((entry) => entry.kind === "upstream_error");
        expect(failure).toMatchObject({
          status: 502,
          attempts: 1,
          postConnectRetries: 0,
          klass: "keyed",
          connected: true,
          forwardingResult: "outcome_unknown",
          rpcMethods: ["tools/call"],
        });
        expect(typeof failure?.traceId).toBe("string");
        expect(String(failure?.traceId)).not.toBe("");
        expect(payload.traceId).toBe(failure?.traceId);

        const traceLine = traceInfo.mock.calls
          .map(([line]) => String(line))
          .find((line) => line.includes('"stage":"proxy_response_finished"'));
        expect(traceLine).toBeDefined();
        if (!traceLine) throw new Error("proxy failure response trace was not emitted");
        const traceEvent = JSON.parse(
          traceLine.slice("[mcp-request-trace] ".length),
        ) as Record<string, unknown>;
        expect(traceEvent).toMatchObject({
          traceId: payload.traceId,
          toolName: "tools/call",
          stage: "proxy_response_finished",
          outcome: "rejected",
          httpStatus: 502,
        });
      } finally {
        traceInfo.mockRestore();
        fs.rmSync(logFile, { force: true });
        if (previousLogFile === undefined)
          delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
        else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = previousLogFile;
      }
    }),
  );

  it(
    "EI-25709337570583795: tools:invoke-wrapped events:emit reset exposes a replay receipt",
    withKeyedRetry("1", async () => {
      const upstream = applyThenResetUpstream();
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 2_000,
          retryBackoffMs: 40,
          log: () => {},
        }),
      );
      await listen(proxy);

      const call = {
        jsonrpc: "2.0",
        id: "announce-1",
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "events:emit",
            args: {
              event: "gate:control:ready",
              announce: true,
              announceScope: "global",
            },
          },
        },
      };
      const first = await request(port(proxy), JSON.stringify(call));
      expect(first.status).toBe(502);
      const failure = JSON.parse(first.body) as {
        forwardingResult?: string;
        recovery?: {
          idempotencyKeys?: Array<{
            requestId: string | number;
            toolName: string;
            key: string;
          }>;
        };
      };
      expect(failure.forwardingResult).toBe("outcome_unknown");
      expect(failure.recovery?.idempotencyKeys).toMatchObject([
        { requestId: "announce-1", toolName: "tools:invoke" },
      ]);
      const recoveryKey = failure.recovery?.idempotencyKeys?.[0]?.key;
      expect(recoveryKey).toBeTruthy();
      expect(upstream.receivedKeys()).toEqual([recoveryKey]);
      expect(upstream.appliedEffects()).toBe(1);

      const replayed = await request(
        port(proxy),
        JSON.stringify({
          ...call,
          params: { ...call.params, _meta: { idempotencyKey: recoveryKey } },
        }),
      );
      expect(replayed.status).toBe(200);
      expect(replayed.body).toBe('{"result":{"receipt":"applied-once"}}');
      expect(upstream.receivedKeys()).toEqual([recoveryKey, recoveryKey]);
      expect(upstream.appliedEffects()).toBe(1);
    }),
  );

  it(
    "P-005: an idempotent method (tools/list) retries post-connect EVEN with keying disabled — the toolless-session fix",
    withKeyedRetry("0", async () => {
      const upstream = resetOnceUpstream(
        '{"result":{"tools":[]}}',
      ) as http.Server & { hits: () => number };
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          retryBackoffMs: 40,
          log: () => {},
        }),
      );
      await listen(proxy);
      const r = await request(
        port(proxy),
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      );
      expect(r.status).toBe(200);
      expect(upstream.hits()).toBe(2);
    }),
  );

  it("EI-223511: conversations:list retries once after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"conversations":[]}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);

    const r = await request(
      port(proxy),
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"conversations:list","arguments":{}}}',
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":{"conversations":[]}}');
    expect(upstream.hits()).toBe(2);
  });

  it("conversations:get retries once after a post-connect reset", async () => {
    const responseBody = '{"result":{"ok":true,"results":[{"ok":true,"id":"conv-1","conversation":{"id":"conv-1"}}],"counts":{"ok":1,"failed":0}}}';
    const upstream = resetOnceUpstream(responseBody) as http.Server & {
      hits: () => number;
    };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);

    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "conversations:get", arguments: { id: "conv-1" } },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe(responseBody);
    expect(upstream.hits()).toBe(2);
  });

  it(
    "P-005: with keying DISABLED a tools/call does NOT retry post-connect → 502 (write-safety preserved)",
    withKeyedRetry("0", async () => {
      const upstream = resetOnceUpstream(
        '{"result":"should-not-reach"}',
      ) as http.Server & { hits: () => number };
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 2_000,
          retryBackoffMs: 40,
          log: () => {},
        }),
      );
      await listen(proxy);
      const r = await request(port(proxy), TOOLS_CALL);
      expect(r.status).toBe(502);
      expect(r.body).toContain("mcp_proxy_upstream_error");
      expect(JSON.parse(r.body).recovery).toBeUndefined();
      expect(upstream.hits()).toBe(1); // opaque → not replayed
    }),
  );

  // EI-21268234394605529: the reported failure — build:typecheck (read-only) died with
  // "read ECONNRESET after connecting; attempts=1, retries=0". A read-only tools/call must
  // now absorb ONE post-connect reset and succeed instead of surfacing a 502.
  it("EI-21268234394605529: a READ-ONLY tools/call retries once after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":"readonly-recovered"}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"build:typecheck","arguments":{}}}',
    );
    expect(r.status).toBe(200);
    expect(upstream.hits()).toBe(2);
  });

  it("EI-25993505156348444: tools:invoke-wrapped audit:list retries once after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":"audit-recovered"}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: { name: "audit:list", args: { detail: "summary", limit: 10 } },
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"audit-recovered"}');
    expect(upstream.hits()).toBe(2);
  });

  it("EI-25897333491653710: loop:checkpoint read:true retries after an upstream reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"read":true,"note":"recovered"}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"loop:checkpoint","arguments":{"read":true}}}',
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":{"read":true,"note":"recovered"}}');
    expect(upstream.hits()).toBe(2);
  });

  it("EI-21398388520825280: sessions:search does not replay a post-connect reset while live refresh writes", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"total_hits":0,"results":[]}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sessions:search","arguments":{"query":"needle"}}}',
    );
    expect(r.status).toBe(502);
    expect(r.body).toContain("mcp_proxy_upstream_error");
    expect(upstream.hits()).toBe(1);
  });

  it("EI-25977433632794127: tools:invoke-wrapped sessions:read does not replay a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"ok":true,"turns":[]}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: { name: "sessions:read", args: { session: "self", tail: 8 } },
        },
      }),
    );
    expect(r.status).toBe(502);
    expect(r.body).toContain("mcp_proxy_upstream_error");
    expect(JSON.parse(r.body)).toMatchObject({
      forwardingResult: "outcome_unknown",
      attempts: 1,
    });
    expect(upstream.hits()).toBe(1);
  });

  it("EI-23082732693236516: work_items:search retries once after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"total":0,"results":[]}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"work_items:search","arguments":{"query":"transport reset"}}}',
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":{"total":0,"results":[]}}');
    expect(upstream.hits()).toBe(2);
  });

  it("EI-22583902856092839: tools:invoke-wrapped coord:whoami retries after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"ownerId":"su-test"}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: { name: "coord:whoami", args: {} },
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":{"ownerId":"su-test"}}');
    expect(upstream.hits()).toBe(2);
  });

  it("EI-21660633304527755: tools:invoke-wrapped read-only capability:bash retries after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"output":"needle"}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "capability:bash",
            args: JSON.stringify({ command: "rg -n -F needle README.md" }),
          },
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":{"output":"needle"}}');
    expect(upstream.hits()).toBe(2);
  });

  it("EI-25459298107511969: tools:invoke-wrapped bash_output peek retries after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"output":"still available"}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "capability:bash_output",
            args: { task_id: "task-1", peek: true },
          },
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":{"output":"still available"}}');
    expect(upstream.hits()).toBe(2);
  });

  it("EI-24734741850141953: tools:invoke-wrapped logs:read retries after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"entries":[{"unit":"papercup-staging-sync.service","message":"sync completed"}],"matched":1}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "logs:read",
            args: JSON.stringify({
              unit: "papercup-staging-sync.service",
              since: "-30 min",
              grep: "restart|sync",
              limit: 20,
            }),
          },
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toContain("sync completed");
    expect(upstream.hits()).toBe(2);
  });

  it("EI-26054464973454475: tools:invoke-wrapped plans:evaluate-spec-test-adequacy retries after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"ok":true,"rows":[],"count":0}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "plans:evaluate-spec-test-adequacy",
            args: {
              scorecardId: "EI-26004169159232210",
              slug: "grading-replay-fixture",
              replaySnapshot: true,
            },
          },
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":{"ok":true,"rows":[],"count":0}}');
    expect(upstream.hits()).toBe(2);
  });

  it("EI-25664976151101287: tools:invoke-wrapped lsp:query retries after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"sites":[]}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "lsp:query",
            args: {
              op: "workspace_symbols",
              name: "prepareForward",
              language: "typescript",
            },
          },
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":{"sites":[]}}');
    expect(upstream.hits()).toBe(2);
  });

  it("EI-25758615329816479: tools:invoke-wrapped processes:list retries after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"ok":true,"counts":{"total":0,"byState":{},"byClass":{}},"tasks":[]}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: { name: "processes:list", args: { live: true, limit: 20 } },
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe(
      '{"result":{"ok":true,"counts":{"total":0,"byState":{},"byClass":{}},"tasks":[]}}',
    );
    expect(upstream.hits()).toBe(2);
  });

  it("EI-24736474511290409: tools:invoke-wrapped release:cut status retries after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"ok":true,"op":"status","state":"running"}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "release:cut",
            args: JSON.stringify({ op: "status" }),
          },
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toContain('"state":"running"');
    expect(upstream.hits()).toBe(2);
  });

  it("EI-26107428212758754: tools:invoke-wrapped dry-run release:cut reclaim is replay-safe", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"ok":true,"op":"reclaim","dryRun":true}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "release:cut",
            args: JSON.stringify({ op: "reclaim", minIdleHours: 24 }),
          },
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toContain('"dryRun":true');
    expect(upstream.hits()).toBe(2);
  });

  it("EI-21568697005575627: tools:invoke-wrapped release:trace retries after a post-connect reset", async () => {
    const upstream = resetOnceUpstream(
      '{"result":{"ok":true,"summary":"recovered"}}',
    ) as http.Server & { hits: () => number };
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 40,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "release:trace",
            args: { sha: "bb1128e2d8c28c185e6c1f83723bad539bcaf645" },
          },
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":{"ok":true,"summary":"recovered"}}');
    expect(upstream.hits()).toBe(2);
  });

  it("EI-21268234394605529: PAPERCUSP_MCP_PROXY_READONLY_RETRY=0 restores 502 surfacing (kill-switch)", async () => {
    const prev = process.env.PAPERCUSP_MCP_PROXY_READONLY_RETRY;
    process.env.PAPERCUSP_MCP_PROXY_READONLY_RETRY = "0";
    try {
      const upstream = resetOnceUpstream(
        '{"result":"should-not-reach"}',
      ) as http.Server & { hits: () => number };
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 2_000,
          retryBackoffMs: 40,
          log: () => {},
        }),
      );
      await listen(proxy);
      const r = await request(
        port(proxy),
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"build:typecheck","arguments":{}}}',
      );
      expect(r.status).toBe(502);
      expect(r.body).toContain("mcp_proxy_upstream_error");
      expect(upstream.hits()).toBe(1);
    } finally {
      if (prev === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_READONLY_RETRY;
      else process.env.PAPERCUSP_MCP_PROXY_READONLY_RETRY = prev;
    }
  });

  it("WI-41045: rereads the rotated bearer before a post-connect retry", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tokenPath = path.join(
      os.tmpdir(),
      `mcp-proxy-token-rotate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.writeFileSync(tokenPath, "token-one\n");
    let hits = 0;
    const upstream = track(
      http.createServer((req, res) => {
        hits++;
        if (hits === 1) {
          expect(req.headers.authorization).toBe("Bearer token-one");
          // Rotate after the first attempt has authenticated, before its retry.
          fs.writeFileSync(tokenPath, "token-two\n");
          req.socket.destroy();
          return;
        }
        expect(req.headers.authorization).toBe("Bearer token-two");
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":"fresh-token"}');
        });
      }),
    );
    try {
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          retryBackoffMs: 20,
          superuserTokenPath: tokenPath,
          log: () => {},
        }),
      );
      await listen(proxy);

      const r = await request(
        port(proxy),
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        "/api/mcp?superuser=1",
        { authorization: "Bearer stale-client-token" },
      );
      expect(r.status).toBe(200);
      expect(r.body).toBe('{"result":"fresh-token"}');
      expect(hits).toBe(2);
    } finally {
      fs.rmSync(tokenPath, { force: true });
    }
  });
});

/**
 * WI-6740 — upstream SILENCE.
 *
 * The suite above pins every way upstream can FAIL: refused, socket reset, 429, boot
 * status. None of them covers upstream going QUIET, and that gap is precisely why the
 * bug shipped: with no timeout on the forward, a stalled :3070 produced no error, so no
 * retry path ran, the proxy waited forever, and the CLIENT timed out — permanently
 * tool-dark for the rest of that session (269 occurrences 2026-07-10 → 2026-08-01).
 */
describe("WI-6740: upstream silence — bounded + replayed for the handshake, never for a tools/call", () => {
  const A_TOOLS_CALL =
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{}}}';

  it("EI-259750: waits for a delayed REST session-port delivery without aborting or replaying it", async () => {
    let hits = 0;
    const delivery = { portId: "22222222-2222-4222-8222-222222222222", targetAdvSessionId: 99, status: "delivered" };
    const upstream = track(http.createServer((req, res) => {
      hits++;
      const collected = createTextCollector(req);
      req.on("end", () => {
        expect(JSON.parse(collected.text())).toEqual(delivery);
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, status: "delivered" }));
        }, 180);
      });
    }));
    await listen(upstream);
    const proxy = track(createMcpProxy({ listenPort: 0, targetHost: "127.0.0.1", targetPort: port(upstream), retryWindowMs: 5_000, handshakeTimeoutMs: 40, retryBackoffMs: 5, log: () => {} }));
    await listen(proxy);
    const response = await request(port(proxy), JSON.stringify(delivery), "/api/adv/sessions/port/delivery");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, status: "delivered" });
    expect(hits).toBe(1);
  });

  it("EI-259750: a post-connect REST delivery reset is outcome_unknown with one upstream mutation", async () => {
    let hits = 0;
    const upstream = track(http.createServer((req) => { hits++; req.socket.destroy(); }));
    await listen(upstream);
    // A real retry window, so hits===1 proves the post-connect reset is NOT replayed
    // (an absent window would pass vacuously — nothing would ever retry).
    const proxy = track(createMcpProxy({ listenPort: 0, targetHost: "127.0.0.1", targetPort: port(upstream), retryWindowMs: 5_000, retryBackoffMs: 5, log: () => {} }));
    await listen(proxy);
    const response = await request(port(proxy), JSON.stringify({ status: "delivered", targetAdvSessionId: 99 }), "/api/adv/sessions/port/delivery");
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body).forwardingResult).toBe("outcome_unknown");
    expect(hits).toBe(1);
  });

  it("replays a STALLED handshake and returns the eventual 200 (a client would have gone dark)", async () => {
    let calls = 0;
    const upstream = track(
      http.createServer((_req, res) => {
        calls++;
        // First forward: accept the connection and then say NOTHING — the exact shape of
        // the ~10s :3070 stalls. No error is ever emitted, so only a timeout can catch it.
        if (calls === 1) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"catalog"}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 20,
        handshakeTimeoutMs: 150,
        log: () => {},
      }),
    );
    await listen(proxy);

    // Default body carries no tools/call → 'idempotent', i.e. the initialize/tools/list class.
    const r = await request(port(proxy));
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"catalog"}');
    expect(calls).toBe(2); // stalled once, replayed once
  });

  it("does NOT bound a tools/call — a slow long-running tool still succeeds", async () => {
    // The anti-regression for the fix itself: build:typecheck legitimately runs ~160s and
    // capability:bash ~120s on this box, so applying the handshake timeout to a real tool
    // call would convert working long tools into hard failures.
    const upstream = track(
      http.createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":"slow-but-fine"}');
        }, 300); // 2× the handshake timeout below
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 20,
        handshakeTimeoutMs: 150,
        log: () => {},
      }),
    );
    await listen(proxy);

    const r = await request(port(proxy), A_TOOLS_CALL);
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"slow-but-fine"}');
  });

  it("surfaces honestly (502) without falling through to post-connect replay when the stall outlives the replay budget", async () => {
    let calls = 0;
    const upstream = track(
      http.createServer(() => {
        calls++;
        /* silent forever */
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 10,
        handshakeTimeoutMs: 60,
        log: () => {},
      }),
    );
    await listen(proxy);

    const r = await request(port(proxy));
    expect(r.status).toBe(502); // bounded: an error the client can act on, not an infinite wait
    // Two dedicated timeout retries produce three total attempts. The exhausted timeout must
    // not fall through to postConnectRetryable and create a fourth attempt.
    expect(calls).toBe(MAX_HANDSHAKE_TIMEOUT_RETRIES + 1);
    expect(JSON.parse(r.body).attempts).toBe(MAX_HANDSHAKE_TIMEOUT_RETRIES + 1);
  });

  it("WI-41042: timeout telemetry names tools/list instead of only the broad idempotent class", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const logFile = path.join(
      os.tmpdir(),
      `mcp-proxy-method-attribution-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const previous = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    try {
      const upstream = track(
        http.createServer(() => {
          /* silent forever — force the retry and terminal records */
        }),
      );
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          retryBackoffMs: 10,
          handshakeTimeoutMs: 40,
          log: () => {},
        }),
      );
      await listen(proxy);

      const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
      expect((await request(port(proxy), body)).status).toBe(502);

      const records = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              kind?: string;
              klass?: string;
              rpcMethods?: string[];
            },
        );
      const relevant = records.filter(
        (record) =>
          record.kind === "handshake_timeout_retry" ||
          record.kind === "upstream_error",
      );
      expect(relevant.length).toBeGreaterThanOrEqual(2);
      expect(relevant.every((record) => record.klass === "idempotent")).toBe(
        true,
      );
      expect(
        relevant.every(
          (record) => JSON.stringify(record.rpcMethods) === '["tools/list"]',
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(logFile, { force: true });
      if (previous === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = previous;
    }
  });

  it("WI-41042: correlates initialize across the upstream hop and records only bounded stage telemetry", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const logFile = path.join(
      os.tmpdir(),
      `mcp-proxy-initialize-trace-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const previous = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    const upstreamTraceIds: string[] = [];
    let calls = 0;
    try {
      const upstream = track(
        http.createServer((req, res) => {
          calls++;
          upstreamTraceIds.push(
            String(req.headers[MCP_PROXY_TRACE_HEADER] ?? ""),
          );
          if (calls === 1) return; // one no-header timeout, then a deliberately slow recovery
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
          }, 20);
        }),
      );
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          retryBackoffMs: 5,
          handshakeTimeoutMs: 40,
          initializeSlowMs: 1,
          log: () => {},
        }),
      );
      await listen(proxy);

      const body =
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"must-not-log"}}}';
      expect((await request(port(proxy), body)).status).toBe(200);
      expect(upstreamTraceIds).toHaveLength(2);
      expect(upstreamTraceIds[0]).toBe(upstreamTraceIds[1]);
      expect(upstreamTraceIds[0]).toMatch(/^[0-9a-f-]+$/);
      expect(upstreamTraceIds[0]!.length).toBeLessThanOrEqual(
        MAX_MCP_PROXY_TRACE_ID_CHARS,
      );

      const records = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const stageRecords = records.filter(
        (record) => record.kind === "initialize_stage",
      );
      expect(stageRecords.map((record) => record.outcome)).toEqual([
        "timeout_retry",
        "slow_response",
        "success",
      ]);
      for (const record of stageRecords) {
        expect(record.traceId).toBe(upstreamTraceIds[0]);
        expect(record.pid).toBe(process.pid);
        expect(record.stages).toEqual({
          bodyReadMs: expect.any(Number),
          admissionWaitMs: expect.any(Number),
          upstreamMs: expect.any(Number),
          totalMs: expect.any(Number),
        });
        for (const forbidden of [
          "method",
          "path",
          "rpcMethods",
          "detail",
          "body",
          "args",
          "tool",
          "toolName",
        ]) {
          expect(record).not.toHaveProperty(forbidden);
        }
        expect(JSON.stringify(record)).not.toContain("must-not-log");
      }
    } finally {
      fs.rmSync(logFile, { force: true });
      if (previous === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = previous;
    }
  });

  it("records one successful initialize with bounded timings and pseudonymous native-session attribution", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const crypto = await import("node:crypto");
    const logFile = path.join(
      os.tmpdir(),
      "mcp-proxy-initialize-success-" + Date.now() + ".jsonl",
    );
    const previous = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    const nativeSessionId = "0123abcd-1234-5678-9abc-def012345678";
    const requestSecret = "initialize-request-secret";
    const responseSecret = "initialize-response-secret";
    const requestBody =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"' +
      requestSecret +
      '"}}}';
    const responseBody =
      '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"' +
      responseSecret +
      '"}}}';
    let upstreamTraceId = "";
    try {
      const upstream = track(
        http.createServer((req, res) => {
          upstreamTraceId = String(req.headers[MCP_PROXY_TRACE_HEADER] ?? "");
          res.writeHead(200, {
            "content-type": "application/json",
            "x-upstream-fixture": "preserved",
          });
          res.end(responseBody);
        }),
      );
      await listen(upstream);
      const proxyPort = await freePort();
      const proxy = track(
        createMcpProxy({
          listenPort: proxyPort,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          log: () => {},
        }),
      );
      await listen(proxy, proxyPort);

      const response = await request(
        proxyPort,
        requestBody,
        "/api/mcp?native_session=query-native-session-secret",
        {
          "content-type": "application/json",
          "x-papercusp-native-session": nativeSessionId,
        },
      );
      expect(response.status).toBe(200);
      expect(response.body).toBe(responseBody);
      expect(response.headers["content-type"]).toBe("application/json");
      expect(response.headers["x-upstream-fixture"]).toBe("preserved");
      expect(upstreamTraceId).toMatch(/^[0-9a-f-]+$/);
      await waitFor(
        () =>
          fs.existsSync(logFile) &&
          fs.readFileSync(logFile, "utf8").trim().length > 0,
      );

      const records = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const successes = records.filter(
        (record) =>
          record.kind === "initialize_stage" && record.outcome === "success",
      );
      expect(successes).toHaveLength(1);
      const success = successes[0]!;
      expect(success.traceId).toBe(upstreamTraceId);
      expect(success.pid).toBe(process.pid);
      expect(success.listenPort).toBe(proxyPort);
      expect(success.target).toBe("127.0.0.1:" + port(upstream));
      expect(success).not.toHaveProperty("path");
      expect(success.stages).toEqual({
        bodyReadMs: expect.any(Number),
        admissionWaitMs: expect.any(Number),
        upstreamMs: expect.any(Number),
        totalMs: expect.any(Number),
      });
      for (const stageMs of Object.values(
        success.stages as Record<string, number>,
      )) {
        expect(stageMs).toBeGreaterThanOrEqual(0);
        expect(stageMs).toBeLessThanOrEqual(600_000);
      }
      expect(success.nativeSession).toEqual({
        pseudonym: crypto
          .createHash("sha256")
          .update(nativeSessionId)
          .digest("hex")
          .slice(0, 24),
        source: "header:x-papercusp-native-session",
        trust: "unverified-client-assertion",
      });
      const serialized = JSON.stringify(success);
      for (const secret of [
        nativeSessionId,
        requestSecret,
        responseSecret,
        "query-native-session-secret",
      ])
        expect(serialized).not.toContain(secret);
    } finally {
      fs.rmSync(logFile, { force: true });
      if (previous === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = previous;
    }
  });

  it("records exact tools/list counts and only a sanitized, capped name sample for JSON and SSE", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const logFile = path.join(
      os.tmpdir(),
      "mcp-proxy-tools-list-success-" + Date.now() + ".jsonl",
    );
    const previous = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    const smallTools = [
      { name: " git\nstatus ", description: "description-secret" },
      {
        name: "tool-two",
        inputSchema: { type: "object", properties: { secret: { type: "string" } } },
      },
    ];
    const smallJson = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: smallTools },
    });
    const smallSse = "event: message\ndata: " + smallJson + "\n\n";
    const manyTools = Array.from({ length: 70 }, (_unused, index) => ({
      name:
        index === 0
          ? " first\nname "
          : index === 1
            ? "long-" + "x".repeat(200)
            : "tool-" + index,
      description: "description-secret-" + index,
      inputSchema: { type: "object", properties: { secret: { type: "string" } } },
    }));
    const largeJson = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: manyTools },
    });
    const fixtures = [
      {
        type: "text/event-stream",
        body: smallSse,
      },
      { type: "application/json", body: largeJson },
    ];
    const traceIds: string[] = [];
    try {
      const upstream = track(
        http.createServer((_req, res) => {
          const fixture = fixtures.shift();
          if (!fixture) {
            res.writeHead(500);
            res.end("unexpected request");
            return;
          }
          traceIds.push(String(_req.headers[MCP_PROXY_TRACE_HEADER] ?? ""));
          res.writeHead(200, {
            "content-type": fixture.type,
            "x-upstream-fixture": "preserved",
          });
          res.end(fixture.body);
        }),
      );
      await listen(upstream);
      const proxyPort = await freePort();
      const proxy = track(
        createMcpProxy({
          listenPort: proxyPort,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          log: () => {},
        }),
      );
      await listen(proxy, proxyPort);

      const smallResponse = await request(
        proxyPort,
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        "/api/mcp?tracking=query-secret",
      );
      const largeResponse = await request(
        proxyPort,
        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
        "/api/mcp?tracking=query-secret",
        { "x-papercusp-native-session": "tools-list-native-session-secret" },
      );
      expect(smallResponse.body).toBe(smallSse);
      expect(smallResponse.status).toBe(200);
      expect(smallResponse.headers["content-type"]).toBe("text/event-stream");
      expect(smallResponse.headers["x-upstream-fixture"]).toBe("preserved");
      expect(largeResponse.status).toBe(200);
      expect(largeResponse.headers["content-type"]).toBe("application/json");
      expect(largeResponse.headers["x-upstream-fixture"]).toBe("preserved");
      await waitFor(
        () =>
          fs.existsSync(logFile) &&
          fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
            .length >= 2,
      );

      const records = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const successes = records.filter(
        (record) =>
          record.kind === "tools_list_stage" && record.outcome === "success",
      );
      expect(successes).toHaveLength(2);
      expect(successes[0]!.traceId).toBe(traceIds[0]);
      expect(successes[0]!.toolCount).toBe(2);
      expect(successes[0]!.toolNames).toEqual(["gitstatus", "tool-two"]);
      expect(successes[0]!.nativeSession).toEqual({
        pseudonym: null,
        source: "absent",
        trust: "unavailable",
      });
      expect(successes[1]!.traceId).toBe(traceIds[1]);
      expect(successes[1]!.toolCount).toBe(70);
      const sampledNames = successes[1]!.toolNames as string[];
      expect(sampledNames).toHaveLength(64);
      expect(sampledNames[0]).toBe("firstname");
      expect(sampledNames[1]).toHaveLength(128);
      expect(sampledNames[63]).toBe("tool-63");
      expect(sampledNames.every((name) => name.length <= 128)).toBe(true);
      expect(
        (successes[1]!.nativeSession as { trust: string }).trust,
      ).toBe("unverified-client-assertion");
      const serialized = JSON.stringify(successes);
      for (const secret of [
        "tools-list-native-session-secret",
        "query-secret",
        "description-secret",
        "inputSchema",
        "properties",
      ])
        expect(serialized).not.toContain(secret);
    } finally {
      fs.rmSync(logFile, { force: true });
      if (previous === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = previous;
    }
  });

  it("logs proxy response finish for tools/call without recording request data", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const result = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "ok" }] },
    });
    let upstreamTraceId = "";
    try {
      const upstream = track(
        http.createServer((req, res) => {
          upstreamTraceId = String(req.headers[MCP_PROXY_TRACE_HEADER] ?? "");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(result);
        }),
      );
      await listen(upstream);
      const proxyPort = await freePort();
      const proxy = track(
        createMcpProxy({
          listenPort: proxyPort,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          log: () => {},
        }),
      );
      await listen(proxy, proxyPort);

      const response = await request(
        proxyPort,
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"coord:feed","arguments":{"q":"private-query"}}}',
      );
      expect(response.status).toBe(200);
      expect(response.body).toBe(result);

      const eventLine = info.mock.calls
        .map(([line]) => String(line))
        .find((line) => line.includes('"stage":"proxy_response_finished"'));
      expect(eventLine).toBeDefined();
      if (!eventLine) throw new Error("proxy response-finish trace was not emitted");
      const event = JSON.parse(
        eventLine.slice("[mcp-request-trace] ".length),
      ) as Record<string, unknown>;
      expect(event).toMatchObject({
        traceId: upstreamTraceId,
        toolName: "tools/call",
        stage: "proxy_response_finished",
        outcome: "success",
        httpStatus: 200,
      });
      expect(event.elapsedMs).toEqual(expect.any(Number));
      expect(eventLine).not.toContain("coord:feed");
      expect(eventLine).not.toContain("private-query");
    } finally {
      info.mockRestore();
    }
  });

  it("forwards streamed initialize bytes unchanged when the observer or telemetry logger fails", async () => {
    const previous = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG =
      "/dev/null/mcp-proxy-telemetry.jsonl";
    const prefix = '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":';
    const suffix = '{"name":"streamed"}}}';
    const fullBody = prefix + suffix;
    const malformed = '{"jsonrpc":"2.0","id":1,"result":';
    let releaseUpstream: () => void = () => {};
    const upstreamGate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    let upstreamEnded = false;
    let calls = 0;
    try {
      const upstream = track(
        http.createServer((_req, res) => {
          calls++;
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": String(
              calls === 1 ? fullBody.length : malformed.length,
            ),
            "x-upstream-fixture": "preserved",
          });
          if (calls === 1) {
            res.write(prefix);
            void upstreamGate.then(() => {
              upstreamEnded = true;
              res.end(suffix);
            });
          } else {
            res.end(malformed);
          }
        }),
      );
      await listen(upstream);
      const proxyPort = await freePort();
      const proxy = track(
        createMcpProxy({
          listenPort: proxyPort,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          log: () => {},
        }),
      );
      await listen(proxy, proxyPort);

      let signalFirstChunk: () => void = () => {};
      const firstChunk = new Promise<void>((resolve) => {
        signalFirstChunk = resolve;
      });
      let resolveResponse: (value: {
        status: number;
        body: string;
        headers: http.IncomingHttpHeaders;
      }) => void = () => {};
      let rejectResponse: (error: Error) => void = () => {};
      const streamedResponse = new Promise<{
        status: number;
        body: string;
        headers: http.IncomingHttpHeaders;
      }>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
      const client = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "POST",
          path: "/api/mcp",
          headers: { "content-type": "application/json" },
        },
        (res) => {
          const body = createTextCollector(res);
          res.once("data", signalFirstChunk);
          res.on("end", () =>
            resolveResponse({
              status: res.statusCode ?? 0,
              body: body.text(),
              headers: res.headers,
            }),
          );
        },
      );
      client.on("error", rejectResponse);
      client.end('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
      let firstChunkTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          firstChunk,
          new Promise<never>((_resolve, reject) => {
            firstChunkTimer = setTimeout(
              () => reject(new Error("proxy buffered the upstream stream")),
              1_000,
            );
          }),
        ]);
      } finally {
        if (firstChunkTimer) clearTimeout(firstChunkTimer);
      }
      expect(upstreamEnded).toBe(false);
      releaseUpstream();
      const streamed = await streamedResponse;
      expect(streamed.status).toBe(200);
      expect(streamed.body).toBe(fullBody);
      expect(streamed.headers["content-type"]).toBe("application/json");
      expect(streamed.headers["x-upstream-fixture"]).toBe("preserved");

      const observerFailureResponse = await request(
        proxyPort,
        '{"jsonrpc":"2.0","id":2,"method":"initialize"}',
      );
      expect(calls).toBe(2);
      expect(observerFailureResponse.status).toBe(200);
      expect(observerFailureResponse.body).toBe(malformed);
      expect(observerFailureResponse.headers["x-upstream-fixture"]).toBe(
        "preserved",
      );
    } finally {
      releaseUpstream();
      if (previous === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = previous;
    }
  });

  it("handshakeTimeoutRetryable — idempotent only, bounded, in-window (pure)", () => {
    expect(
      handshakeTimeoutRetryable(
        "idempotent",
        0,
        MAX_HANDSHAKE_TIMEOUT_RETRIES,
        0,
        5_000,
      ),
    ).toBe(true);
    // A batch carrying a tools/call may ALREADY have applied its side effect upstream —
    // silence tells us nothing about whether it ran, so it must never be replayed.
    expect(
      handshakeTimeoutRetryable(
        "opaque",
        0,
        MAX_HANDSHAKE_TIMEOUT_RETRIES,
        0,
        5_000,
      ),
    ).toBe(false);
    expect(
      handshakeTimeoutRetryable(
        "keyed",
        0,
        MAX_HANDSHAKE_TIMEOUT_RETRIES,
        0,
        5_000,
      ),
    ).toBe(false);
    // EI-21268234394605529: 'readonly' is deliberately NOT handshake-timeout-retryable —
    // its members legitimately run minutes (~160s typecheck), so they ride maxHoldMs and
    // must never inherit this 8s control-plane bound.
    expect(
      handshakeTimeoutRetryable(
        "readonly",
        0,
        MAX_HANDSHAKE_TIMEOUT_RETRIES,
        0,
        5_000,
      ),
    ).toBe(false);
    expect(
      handshakeTimeoutRetryable(
        "idempotent",
        MAX_HANDSHAKE_TIMEOUT_RETRIES,
        MAX_HANDSHAKE_TIMEOUT_RETRIES,
        0,
        5_000,
      ),
    ).toBe(false);
    expect(
      handshakeTimeoutRetryable(
        "idempotent",
        0,
        MAX_HANDSHAKE_TIMEOUT_RETRIES,
        6_000,
        5_000,
      ),
    ).toBe(false);
    // EI-21554095087170158: under proxy event-loop pressure the nominal 8s response-header
    // timer fired after 22.7s. The old elapsed-only check started another 8s attempt because
    // 22.7s was technically below the 30s retry window, guaranteeing the observed 37.7s
    // terminal handshake. Do not start an attempt that cannot fit in the remaining window.
    expect(
      handshakeTimeoutRetryable(
        "idempotent",
        0,
        MAX_HANDSHAKE_TIMEOUT_RETRIES,
        22_761,
        30_000,
        8_040,
      ),
    ).toBe(false);
    expect(
      handshakeTimeoutRetryable(
        "idempotent",
        0,
        MAX_HANDSHAKE_TIMEOUT_RETRIES,
        20_000,
        30_000,
        8_040,
      ),
    ).toBe(true);
  });
});

// EI-19294517824914302: a cheap repeating beat must NOT inherit the restart-sized retry
// window. Measured on the dev box: 13,330 of 13,754 proxy failures in 90 minutes were the
// bootstrap-su heartbeat alone, with SUCCESSES recording attempts:30 / elapsedMs:42361 —
// ~30x amplification on the highest-frequency path in the system.
describe("EI-19294517824914302: cheap repeating beats fail fast instead of amplifying", () => {
  it("classifies the liveness beats, and only those (pure)", () => {
    expect(
      isCheapRepeatingBeat("/api/agent-mcp/console/bootstrap-su/heartbeat"),
    ).toBe(true);
    expect(isCheapRepeatingBeat("/api/admin/owner-presence/touch")).toBe(true);
    // WI-35737 — the per-turn memory-injection pair joined the set. This assertion USED to
    // pin `turn-start-memory` as false; that was not a deliberate exclusion, it was simply
    // the roster as first seeded, and encoding it as "and only those" made a membership
    // GAP look like a settled decision. See the classifier's doc comment: membership is the
    // PROPERTY (high-frequency + soft failure + replacement already scheduled), not a fixed
    // list, and mid-turn-context met it while sitting outside the roster for weeks.
    expect(isCheapRepeatingBeat("/api/agent-mcp/mid-turn-context")).toBe(true);
    expect(isCheapRepeatingBeat("/api/agent-mcp/turn-start-memory")).toBe(true);
    // The MCP control plane keeps the long window — a client fetches the catalog ONCE per
    // session, so losing that single request is session-fatal (WI-6740). Opposite tradeoff.
    // This is the load-bearing NEGATIVE control: it must stay false, or the cheap-beat cap
    // has silently swallowed the one path whose replay is genuinely worth a restart-sized
    // window, and every test above would still pass.
    expect(isCheapRepeatingBeat("/api/mcp")).toBe(false);
    expect(
      isCheapRepeatingBeat("/api/agent-mcp/console/bootstrap-su/options"),
    ).toBe(false);
  });

  it("tolerates a query string and a trailing slash (pure)", () => {
    expect(
      isCheapRepeatingBeat(
        "/api/agent-mcp/console/bootstrap-su/heartbeat?client=abc",
      ),
    ).toBe(true);
    expect(
      isCheapRepeatingBeat("/api/agent-mcp/console/bootstrap-su/heartbeat/"),
    ).toBe(true);
  });

  it("caps the beat window but never LENGTHENS a window shorter than the cap (pure)", () => {
    expect(
      effectiveRetryWindowMs(
        "/api/agent-mcp/console/bootstrap-su/heartbeat",
        45_000,
      ),
    ).toBe(CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS);
    expect(effectiveRetryWindowMs("/api/mcp", 45_000)).toBe(45_000);
    // A caller configuring a window TIGHTER than the cap must keep its tighter value.
    expect(
      effectiveRetryWindowMs(
        "/api/agent-mcp/console/bootstrap-su/heartbeat",
        500,
      ),
    ).toBe(500);
  });

  it("caps fail-closed egress preflight retries without marking them as soft beats", () => {
    const path = "/api/agent-mcp/restricted-egress-check";

    // The hook refuses the native tool when this check is unavailable, so a missing route
    // must surface quickly instead of spending the restart-sized proxy window. Its failures
    // remain hard in the health ledger because this is not a soft, scheduled heartbeat.
    expect(isCheapRepeatingBeat(path)).toBe(false);
    expect(effectiveRetryWindowMs(path, 45_000)).toBe(
      CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS,
    );
    expect(effectiveRetryWindowMs(`${path}?status=true`, 45_000)).toBe(
      CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS,
    );
  });

  it("end-to-end: gives up on a refused upstream in ~2s instead of burning a 30s window", async () => {
    // Bind a port, then close it so connections are REFUSED — the exact shape that produced
    // the observed attempts:30 storm (kind:"upstream_error"/"exhausted_refused").
    const dead = track(http.createServer(() => {}));
    await listen(dead);
    const deadPort = port(dead);
    await new Promise<void>((r) => dead.close(() => r()));

    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: deadPort,
        retryWindowMs: 30_000, // restart-sized, as in production
        retryBackoffMs: 20,
        log: () => {},
      }),
    );
    await listen(proxy);

    const started = Date.now();
    const r = await request(
      port(proxy),
      '{"ownerId":"su-test"}',
      "/api/agent-mcp/console/bootstrap-su/heartbeat",
    );
    const elapsed = Date.now() - started;

    expect(r.status).toBe(503); // still an honest failure — the beat is just not amplified
    // The whole point: it must abandon the beat rather than retry across the full window.
    expect(elapsed).toBeLessThan(8_000);
    expect(JSON.parse(r.body).windowMs).toBe(
      CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS,
    );
  }, 20_000);

  /**
   * WI-35737 — the SAME storm, on a path the original fix's roster never covered.
   * `mid-turn-context` is the per-tool-batch memory-injection search: the most expensive
   * endpoint on the box AND one of the highest-frequency. Measured 2026-08-08 16:00-18:12Z
   * while :3070's data plane was stalling, it was 385 of 540 handshake-timeout retries (71%)
   * and 175 of 245 post-connect retries (71%) — i.e. the proxy was spending its scarcest
   * capacity replaying the single most expensive call against the dependency that was failing.
   */
  it("WI-35737: mid-turn-context takes the beat window, not the restart-sized one", async () => {
    const dead = track(http.createServer(() => {}));
    await listen(dead);
    const deadPort = port(dead);
    await new Promise<void>((r) => dead.close(() => r()));

    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: deadPort,
        retryWindowMs: 30_000,
        retryBackoffMs: 20,
        log: () => {},
      }),
    );
    await listen(proxy);

    const started = Date.now();
    const r = await request(
      port(proxy),
      '{"owner":"su-test"}',
      "/api/agent-mcp/mid-turn-context",
    );
    const elapsed = Date.now() - started;

    expect(r.status).toBe(503);
    expect(elapsed).toBeLessThan(8_000);
    expect(JSON.parse(r.body).windowMs).toBe(
      CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS,
    );
  }, 20_000);
});

/**
 * WI-35737 — CLIENT-DISCONNECT. The proxy had no client-side liveness signal at all, so once a
 * client gave up (its own timeout, a dead agent session, a watchdog restart) the retry loop kept
 * replaying upstream for a response with nowhere to go — spending capacity on the dead during
 * exactly the upstream-stall windows when capacity is scarcest.
 *
 * ⚠ This is NOT a slot leak; an earlier diagnosis on this item said so and was withdrawn
 * (comment 56302). The in-flight slot is already released at response-header time. What these
 * tests pin is the AMPLIFICATION cut, which is why the CONTROL below is load-bearing: without
 * it, "no replays happened" is equally consistent with "this upstream never replays at all",
 * and the subject test would pass against a proxy that had no disconnect handling whatsoever.
 */
describe("WI-35737: a departed client stops the retry loop", () => {
  /** A silent upstream — accepts the connection, never answers. The measured shape
   *  (`upstream silent for 8000ms (no response headers)`), which is what drives the replays. */
  function silentUpstream(onHit: () => void): http.Server {
    return track(http.createServer(() => onHit()));
  }

  function fireAndForget(
    p: number,
    path: string,
    body: string,
  ): http.ClientRequest {
    const r = http.request({
      host: "127.0.0.1",
      port: p,
      method: "POST",
      path,
    });
    r.on("error", () => {}); // a deliberate destroy() surfaces here; not a failure
    r.end(body);
    return r;
  }

  it("CONTROL: while the client stays connected, a silent upstream IS replayed", async () => {
    let hits = 0;
    const upstream = silentUpstream(() => {
      hits++;
    });
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 30_000,
        retryBackoffMs: 10,
        handshakeTimeoutMs: 120, // drive the replay loop fast instead of sleeping 8s
        log: () => {},
      }),
    );
    await listen(proxy);

    // tools/list — no tools/call, so klass 'idempotent': the class that replays on silence.
    const req = fireAndForget(
      port(proxy),
      "/api/mcp",
      '{"jsonrpc":"2.0","method":"tools/list"}',
    );
    await new Promise((r) => setTimeout(r, 900));
    req.destroy();

    // The replay machinery is real and observable — this is what the subject test suppresses.
    expect(hits).toBeGreaterThanOrEqual(3);
  }, 20_000);

  it("SUBJECT: once the client hangs up, no further upstream attempt is started", async () => {
    let hits = 0;
    const upstream = silentUpstream(() => {
      hits++;
    });
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 30_000,
        retryBackoffMs: 10,
        handshakeTimeoutMs: 120,
        log: () => {},
      }),
    );
    await listen(proxy);

    const req = fireAndForget(
      port(proxy),
      "/api/mcp",
      '{"jsonrpc":"2.0","method":"tools/list"}',
    );
    await new Promise((r) => setTimeout(r, 300)); // let 1-2 attempts start
    const hitsAtHangup = hits;
    req.destroy(); // the client gives up — exactly what an agent's MCP client timeout does

    // Well past several more handshake windows: under the old behaviour the loop would have
    // kept replaying for the rest of the 30s window.
    await new Promise((r) => setTimeout(r, 900));
    // +1 tolerance for an attempt already in flight at the instant of the hangup; the point is
    // that the loop STOPS, not that it stops with sub-millisecond precision.
    expect(hits).toBeLessThanOrEqual(hitsAtHangup + 1);
  }, 20_000);
});

/**
 * WI-10006908 — UPSTREAM-DISCONNECT, the mirror of WI-35737. :3070 flushes SSE headers the
 * instant a tools/call opens, so a worker that dies mid-call (memory-watchdog recycle,
 * event-loop-sentinel SIGKILL, deploy restart) used to leave the client response open: `pipe`
 * never ends the destination when the source aborts. Measured before the fix with the real
 * createMcpProxy: complete → END in 46ms; die-after-sse-headers → STILL OPEN after 6001ms; live,
 * a tools/call hung to Claude's 300s idle timeout.
 *
 * The CONTROL keeps the subject honest: a normal completion must still deliver the upstream's
 * own result and record no upstream death, so "the client got an error event" cannot pass by
 * the proxy erroring every SSE response.
 */
describe("WI-10006908: an upstream SSE closure after headers ends the client response", () => {
  type UpstreamMode = "complete" | "die-at-boundary" | "die-mid-event";
  function toolCall(toolName = "testing:run"): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: toolName, arguments: {} },
    });
  }

  function sseUpstream(mode: UpstreamMode): http.Server {
    return track(
      http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(":stream-open\n\n"); // what primeSseResponse() flushes at call open
          if (mode === "complete") {
            res.end(
              'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"content":[]}}\n\n',
            );
            return;
          }
          if (mode === "die-mid-event")
            res.write('event: message\ndata: {"jsonrpc":"2.0","id":7,"res');
          // The worker is SIGKILLed mid-tool: the socket just goes away.
          setTimeout(() => req.socket.destroy(), 150);
        });
      }),
    );
  }

  /** Resolves with how the client response ENDED; never with "still open" unless the budget lapses. */
  function callTool(
    p: number,
    budgetMs: number,
    toolName = "testing:run",
  ): Promise<{ outcome: "end" | "aborted" | "error" | "still-open"; body: string; ms: number }> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let body = "";
      let settled = false;
      const settle = (outcome: "end" | "aborted" | "error" | "still-open") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ outcome, body, ms: Date.now() - t0 });
      };
      const timer = setTimeout(() => {
        settle("still-open");
        r.destroy();
      }, budgetMs);
      const r = http.request(
        {
          host: "127.0.0.1",
          port: p,
          method: "POST",
          path: "/api/mcp",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
        },
        (res) => {
          const responseBody = createTextCollector(res);
          res.on("data", () => {
            body = responseBody.peek();
          });
          res.on("end", () => settle("end"));
          res.on("aborted", () => settle("aborted"));
          res.on("error", () => settle("error"));
        },
      );
      r.on("error", () => settle("error"));
      r.end(toolCall(toolName));
    });
  }

  async function withLedger<T>(
    fn: (readRecords: () => Array<Record<string, unknown>>) => Promise<T>,
  ): Promise<T> {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const logFile = path.join(
      os.tmpdir(),
      `mcp-proxy-upstream-death-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const prev = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    try {
      return await fn(() =>
        fs.existsSync(logFile)
          ? fs
              .readFileSync(logFile, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l) as Record<string, unknown>)
          : [],
      );
    } finally {
      fs.rmSync(logFile, { force: true });
      if (prev === undefined) delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = prev;
    }
  }

  async function proxyFor(upstream: http.Server): Promise<http.Server> {
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 2_000,
        log: () => {},
      }),
    );
    await listen(proxy);
    return proxy;
  }

  it("CONTROL: a completed SSE response is delivered unchanged and records no upstream death", async () => {
    await withLedger(async (readRecords) => {
      const proxy = await proxyFor(sseUpstream("complete"));
      const r = await callTool(port(proxy), 3_000);
      expect(r.outcome).toBe("end");
      expect(r.body).toContain('"result":{"content":[]}');
      expect(r.body).not.toContain(String(UPSTREAM_DIED_MID_STREAM_RPC_CODE));
      expect(readRecords().some((x) => x.kind === "upstream_died_mid_stream")).toBe(false);
    });
  }, 10_000);

  it("SUBJECT: upstream SSE closure at an event boundary answers the pending id with a JSON-RPC error, records rejection, and ends promptly", async () => {
    const traceInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await withLedger(async (readRecords) => {
        const proxy = await proxyFor(sseUpstream("die-at-boundary"));
        // Before the fix this stayed open for the whole budget.
        const r = await callTool(port(proxy), 1_500);
        expect(r.outcome).toBe("end");
        const events = r.body
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => JSON.parse(l.slice("data: ".length)));
        expect(events).toHaveLength(1);
        expect(events[0].error.message).toContain(
          "upstream connection for this tools/call closed before the response completed",
        );
        expect(events[0].error.message).not.toContain("operator process");
        expect(events[0].error.message).toContain(
          "effects are UNKNOWN: check state before retrying a write.",
        );
        expect(events[0]).toMatchObject({
          jsonrpc: "2.0",
          id: 7,
          error: {
            code: UPSTREAM_DIED_MID_STREAM_RPC_CODE,
            data: {
              kind: "upstream_died_mid_stream",
              forwardingResult: MCP_PROXY_FORWARDING_RESULTS.outcomeUnknown,
            },
          },
        });
        const rec = readRecords().find((x) => x.kind === "upstream_died_mid_stream");
        expect(rec).toMatchObject({
          status: 200,
          clientResolution: "jsonrpc_error_events",
          forwardingResult: MCP_PROXY_FORWARDING_RESULTS.outcomeUnknown,
          upstreamResponseLifecycle: {
            responseComplete: false,
            responseAborted: true,
            responseDestroyed: true,
            socketDestroyed: true,
          },
        });
        const lifecycle = rec?.upstreamResponseLifecycle as Record<string, unknown> | undefined;
        expect(lifecycle).toHaveProperty("responseErrorCode");
        expect(lifecycle).toHaveProperty("socketErrorCode");
        expect(rec?.traceId).toBe(events[0].error.data.traceId);

        const traceLine = traceInfo.mock.calls
          .map(([line]) => String(line))
          .find((line) => line.includes('"stage":"proxy_response_finished"'));
        expect(traceLine).toBeDefined();
        if (!traceLine) throw new Error("proxy response-finish trace was not emitted");
        const traceEvent = JSON.parse(
          traceLine.slice("[mcp-request-trace] ".length),
        ) as Record<string, unknown>;
        expect(traceEvent).toMatchObject({
          traceId: events[0].error.data.traceId,
          toolName: "tools/call",
          stage: "proxy_response_finished",
          outcome: "rejected",
          httpStatus: 200,
          upstreamResponseLifecycle: {
            responseComplete: false,
            responseAborted: true,
            responseDestroyed: true,
            socketDestroyed: true,
          },
        });
      });
    } finally {
      traceInfo.mockRestore();
    }
  }, 10_000);

  it("SUBJECT: read-only tools/call gets safe retry guidance after upstream SSE closure", async () => {
    const proxy = await proxyFor(sseUpstream("die-at-boundary"));
    const r = await callTool(port(proxy), 1_500, "plans:get");
    expect(r.outcome).toBe("end");
    const events = r.body
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice("data: ".length)));
    expect(events).toHaveLength(1);
    expect(events[0].error.message).toContain(
      "The read was dispatched, but its result is unknown. Retrying this read is safe.",
    );
    expect(events[0].error.message).not.toContain("effects are UNKNOWN");
    expect(events[0].error.data.forwardingResult).toBe(
      MCP_PROXY_FORWARDING_RESULTS.outcomeUnknown,
    );
  }, 10_000);

  it("SUBJECT: upstream SSE closure mid-event cannot append a parseable event, so the client response is destroyed promptly", async () => {
    await withLedger(async (readRecords) => {
      const proxy = await proxyFor(sseUpstream("die-mid-event"));
      const r = await callTool(port(proxy), 1_500);
      expect(r.outcome).not.toBe("still-open");
      expect(r.outcome).not.toBe("end"); // a clean end would read as a complete stream
      expect(r.body).not.toContain(String(UPSTREAM_DIED_MID_STREAM_RPC_CODE));
      expect(readRecords().find((x) => x.kind === "upstream_died_mid_stream")).toMatchObject({
        clientResolution: "destroyed",
      });
    });
  }, 10_000);

  it("error events answer request ids only — notifications, responses and non-JSON yield nothing", () => {
    const batch = Buffer.from(
      JSON.stringify([
        { jsonrpc: "2.0", id: "a", method: "tools/call" },
        { jsonrpc: "2.0", method: "notifications/initialized" }, // notification: no id
        { jsonrpc: "2.0", id: 3, result: {} }, // a response: no method
        { jsonrpc: "2.0", id: 4, method: "ping" },
      ]),
    );
    const sse = upstreamDeathSseErrorEvents(batch, "trace-1");
    const ids = (sse ?? "")
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)).id);
    expect(ids).toEqual(["a", 4]);
    expect(
      upstreamDeathSseErrorEvents(
        Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}'),
        "t",
      ),
    ).toBeNull();
    expect(upstreamDeathSseErrorEvents(Buffer.from("not json"), "t")).toBeNull();
    const huge = Buffer.from(
      JSON.stringify(
        Array.from({ length: MAX_UPSTREAM_DEATH_ERROR_EVENTS + 10 }, (_, i) => ({
          jsonrpc: "2.0",
          id: i,
          method: "ping",
        })),
      ),
    );
    expect(
      (upstreamDeathSseErrorEvents(huge, "t") ?? "").split("event: message").length - 1,
    ).toBe(MAX_UPSTREAM_DEATH_ERROR_EVENTS);
  });

  it("event-boundary detection: only a completed event (or nothing) is a safe append point", () => {
    expect(endsOnSseEventBoundary("")).toBe(true);
    expect(endsOnSseEventBoundary("n\n\n")).toBe(true);
    expect(endsOnSseEventBoundary("\r\n\r\n")).toBe(true);
    expect(endsOnSseEventBoundary("x\r\r")).toBe(true);
    expect(endsOnSseEventBoundary('"res')).toBe(false);
    expect(endsOnSseEventBoundary("}\n")).toBe(false);
  });
});

/**
 * EI-21908521835344903 — a bare client-side timeout ("The operation timed out.") gives an
 * agent zero information about whether the write it triggered actually committed. That exact
 * text appears nowhere in this proxy (confirmed by grep — it is the calling MCP client's own
 * generic timeout, independent of what this proxy eventually does upstream), so this proxy
 * cannot rewrite what the client displays. What it CAN do — and previously did not — is record
 * what actually happened once the client is gone: for a 'keyed'/'opaque' class the forward is
 * never aborted on disconnect (only 'idempotent' gets an AbortController), so the write may
 * land anyway, and `outcome` already holds that answer at the exact point the old `client_gone`
 * record discarded it.
 */
describe("EI-21908521835344903: client_gone records the write's actual outcome", () => {
  it("a keyed write that lands AFTER the client disconnects is recorded, not discarded", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const logFile = path.join(
      os.tmpdir(),
      `mcp-proxy-client-gone-outcome-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const previous = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    try {
      const upstreamTraceIds: string[] = [];
      const upstream = track(
        http.createServer((_req, res) => {
          upstreamTraceIds.push(String(_req.headers[MCP_PROXY_TRACE_HEADER] ?? ""));
          // The write lands only AFTER the client has already disconnected — the exact
          // reported race (step 2: the write committed while the calling agent's own
          // MCP client had already given up on a bare "operation timed out").
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"ok":true}');
          }, 150);
        }),
      );
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          retryBackoffMs: 10,
          log: () => {},
        }),
      );
      await listen(proxy);

      // A real tools/call for a non-read-only tool -> klass 'keyed' -> NOT aborted on
      // disconnect (only 'idempotent' gets an AbortController; see `attemptAbort`).
      const body =
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"loop:checkpoint","arguments":{}}}';
      const r = http.request({
        host: "127.0.0.1",
        port: port(proxy),
        method: "POST",
        path: "/api/mcp",
      });
      r.on("error", () => {}); // the destroy() below surfaces here; not a failure
      r.end(body);
      await new Promise((resolve) => setTimeout(resolve, 30)); // let the forward start
      r.destroy(); // the agent's own MCP client gives up — exactly the reported race

      // Give the upstream time to answer (150ms) plus the proxy time to record it.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const records = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              kind?: string;
              klass?: string;
              upstreamStatus?: number;
              connected?: boolean;
              timedOut?: boolean;
              upstreamErr?: string;
              traceId?: string;
              rpcMethods?: string[];
            },
        );
      const gone = records.filter((rec) => rec.kind === "client_gone");
      expect(gone.length).toBeGreaterThanOrEqual(1);
      expect(gone[0].klass).toBe("keyed");
      expect(gone[0].traceId).toBe(upstreamTraceIds[0]);
      expect(gone[0].rpcMethods).toEqual(["tools/call"]);
      // The write LANDED (upstream answered 200) even though the client was already
      // gone — this is the exact fact the old record discarded.
      expect(gone[0].upstreamStatus).toBe(200);
      expect(gone[0].connected).toBe(true);
    } finally {
      fs.rmSync(logFile, { force: true });
      if (previous === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = previous;
    }
  }, 10_000);
});

/**
 * EI-19305299022434394 — mcp-proxy had no in-flight concurrency bound (`maxSockets:Infinity`)
 * and went completely SILENT under a stalling upstream: 3,450 requests held simultaneously,
 * 106 minutes with zero log lines during the measured outage. Three coupled fixes:
 *  (1) admission control — shed a NEW request with 429 once `maxInFlight` forwards are already
 *      outstanding, BEFORE opening any upstream socket (stops the congestion-collapse loop);
 *  (2) a periodic heartbeat while at least one forward is held open (kills the silence);
 *  (3) `maxHoldMs` — an absolute (generous) ceiling on how long a real tools/call may hold its
 *      socket, so a stalled-but-connected upstream can no longer silently park a socket for
 *      32-89 minutes.
 */
describe("EI-19305299022434394: admission control — shed with 429 before opening an upstream socket", () => {
  it("recognizes the MCP session handshake plus fleet bootstrap, direct coordination, continuation checkpoints, scheduler claims, deferred discovery, bounded diagnostics, detached test recovery, event-wait registration/cancellation, file-lock inspection/cancellation/release, checkpoint writes, work-item inspection/release, and work-item completion as reserved control-plane traffic", () => {
    const call = (name: string) =>
      Buffer.from(JSON.stringify({ method: "tools/call", params: { name } }));
    const targetedCall = (name: string, args: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ method: "tools/call", params: { name, arguments: args } }));
    expect(
      isReservedControlPlaneCall(
        Buffer.from(JSON.stringify({ method: "initialize", params: {} })),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(JSON.stringify({ method: "ping", params: {} })),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(JSON.stringify({ method: "tools/list", params: {} })),
      ),
    ).toBe(true);
    expect(isReservedControlPlaneCall(call("scheduler:get_next"))).toBe(true);
    expect(isReservedControlPlaneCall(call("coord:orient"))).toBe(true);
    expect(isReservedControlPlaneCall(call("coord:declare-intent"))).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: {
                name: "mcp__papercusp_su__coord_declare_intent",
                args: { intent: "claim and advance the selected fleet item" },
              },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(isReservedControlPlaneCall(call("coord:send"))).toBe(true);
    expect(isReservedControlPlaneCall(call("coord:glance"))).toBe(true);
    expect(isReservedControlPlaneCall(targetedCall("coord:presence", { owner: "su-target" }))).toBe(true);
    expect(isReservedControlPlaneCall(targetedCall("coord:roster", { owner: "su-target" }))).toBe(true);
    expect(isReservedControlPlaneCall(targetedCall("coord:roster", { view: "members", owner: "su-target" }))).toBe(true);
    expect(isReservedControlPlaneCall(call("coord:presence"))).toBe(false);
    expect(isReservedControlPlaneCall(call("coord:roster"))).toBe(false);
    expect(isReservedControlPlaneCall(targetedCall("coord:roster", { view: "claims", owner: "su-target" }))).toBe(false);
    expect(isReservedControlPlaneCall(call("state:read"))).toBe(true);
    expect(isReservedControlPlaneCall(call("coord:inbox"))).toBe(true);
    expect(isReservedControlPlaneCall(call("coord:thread"))).toBe(true);
    expect(
      isReservedControlPlaneCall(
        targetedCall("coord:feed", {
          owner: "su-target",
          since: "2026-10-17T06:00:00.000Z",
          limit: 20,
        }),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: {
                name: "mcp__papercusp_su__coord_feed",
                args: {
                  from: "su-target",
                  since_ts: "2026-10-17T06:00:00.000Z",
                  limit: 20,
                },
              },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(isReservedControlPlaneCall(call("coord:feed"))).toBe(false);
    expect(
      isReservedControlPlaneCall(targetedCall("coord:feed", { limit: 20 })),
    ).toBe(false);
    expect(
      isReservedControlPlaneCall(
        targetedCall("coord:feed", {
          owner: "su-target",
          since: "2026-10-17T06:00:00.000Z",
          include_retracted: true,
        }),
      ),
    ).toBe(false);
    expect(isReservedControlPlaneCall(call("fleet:assignments"))).toBe(true);
    expect(isReservedControlPlaneCall(call("fleet:leader-brief"))).toBe(true);
    expect(isReservedControlPlaneCall(call("loop:checkpoint"))).toBe(true);
    expect(isReservedControlPlaneCall(call("loop:end"))).toBe(true);
    expect(isReservedControlPlaneCall(call("session:request-compaction"))).toBe(
      true,
    );
    expect(isReservedControlPlaneCall(call("tools:find"))).toBe(true);
    expect(isReservedControlPlaneCall(call("dev:service_health"))).toBe(true);
    expect(isReservedControlPlaneCall(call("dev:pg_query"))).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: { name: "dev:telemetry", arguments: { hours: 24, limit: 50 } },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: {
                name: "mcp__papercusp_su__dev_telemetry",
                args: { hours: 24, limit: 50 },
              },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: { name: "dev:telemetry", arguments: { hours: 24, limit: 51 } },
          }),
        ),
      ),
    ).toBe(false);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: {
                name: "mcp__papercusp_su__coord_roster",
                args: { view: "members", owner: "su-target" },
              },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: {
                name: "mcp__papercusp_su__coord_presence",
                args: {},
              },
            },
          }),
        ),
      ),
    ).toBe(false);
    expect(isReservedControlPlaneCall(call("loop:arm"))).toBe(true);
    expect(isReservedControlPlaneCall(call("plans:get"))).toBe(true);
    expect(isReservedControlPlaneCall(call("improvements:capture"))).toBe(true);
    expect(isReservedControlPlaneCall(targetedCall("testing:run-status", { runId: "run-1" }))).toBe(true);
    expect(isReservedControlPlaneCall(targetedCall("testing:run-status", { runId: "run-1", extra: true }))).toBe(false);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: {
                name: "mcp__papercusp_su__testing_run_status",
                args: { runId: "run-1" },
              },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(isReservedControlPlaneCall(call("locks:acquire"))).toBe(true);
    expect(isReservedControlPlaneCall(call("locks:queue"))).toBe(true);
    expect(isReservedControlPlaneCall(call("locks:cancel_wait"))).toBe(true);
    expect(isReservedControlPlaneCall(call("locks:release"))).toBe(true);
    expect(isReservedControlPlaneCall(call("events:await"))).toBe(true);
    expect(isReservedControlPlaneCall(call("events:cancel"))).toBe(true);
    expect(isReservedControlPlaneCall(call("events:status"))).toBe(true);
    expect(isReservedControlPlaneCall(call("facts:list"))).toBe(true);
    expect(isReservedControlPlaneCall(call("loop:status"))).toBe(true);
    expect(isReservedControlPlaneCall(call("work_items:checkpoint"))).toBe(
      true,
    );
    expect(isReservedControlPlaneCall(call("work_items:claimable"))).toBe(true);
    expect(isReservedControlPlaneCall(call("work_items:release"))).toBe(true);
    expect(isReservedControlPlaneCall(call("work_items:complete"))).toBe(true);
    expect(isReservedControlPlaneCall(call("work_items:get"))).toBe(true);
    expect(isReservedControlPlaneCall(call("work_items:search"))).toBe(true);
    expect(isReservedControlPlaneCall(call("work_items:set_state"))).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: { name: "tools:find", args: {} },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: { name: "plans:get", args: {} },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: { name: "work_items:search", args: {} },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: { name: "state:read", args: { cell: "gate.greenCheckpoint.ownership" } },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: { name: "work_items:list", args: {} },
            },
          }),
        ),
      ),
    ).toBe(false);
    expect(isReservedControlPlaneCall(Buffer.from("{bad json"))).toBe(false);
  });

  it.each([
    ["events:status", { event: "unit:liveness" }],
    ["facts:list", { scope: "workspace" }],
    ["loop:status", {}],
    // Recording a typed external blocker parks the claim and frees a scheduler slot.
    ["work_items:set_blocker", { id: "WI-1", kind: "event", ref: "event:unit" }],
  ])(
    "keeps tools:invoke %s available while ordinary admission is saturated",
    async (reservedTool, reservedArgs) => {
      let releaseOrdinary: () => void = () => {};
      const ordinaryGate = new Promise<void>((resolve) => {
        releaseOrdinary = resolve;
      });
      let ordinaryStarted: () => void = () => {};
      const ordinaryStartedGate = new Promise<void>((resolve) => {
        ordinaryStarted = resolve;
      });
      let upstreamRequests = 0;
      const upstream = track(
        http.createServer((_req, res) => {
          upstreamRequests += 1;
          if (upstreamRequests === 1) {
            ordinaryStarted();
            void ordinaryGate.then(() => {
              res.writeHead(200, { "content-type": "application/json" });
              res.end('{"result":"ordinary"}');
            });
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(`{"result":"${reservedTool}"}`);
        }),
      );
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 1_000,
          maxInFlight: 2,
          controlPlaneReserve: 1,
          log: () => {},
        }),
      );
      await listen(proxy);

      const heldOrdinary = request(
        port(proxy),
        JSON.stringify({ method: "tools/call", params: { name: "unit:ordinary" } }),
      );
      await ordinaryStartedGate;

      const eventsStatus = await request(
        port(proxy),
        JSON.stringify({
          method: "tools/call",
          params: {
            name: "tools:invoke",
            arguments: {
              name: `mcp__papercusp_su__${reservedTool.replace(":", "_")}`,
              args: reservedArgs,
            },
          },
        }),
      );
      expect(eventsStatus.status).toBe(200);
      expect(upstreamRequests).toBe(2);

      releaseOrdinary();
      await expect(heldOrdinary).resolves.toMatchObject({ status: 200 });
    },
  );

  it("reserves only the bounded lexical-only recipes:search recovery form", () => {
    const direct = (args: Record<string, unknown>) =>
      Buffer.from(
        JSON.stringify({
          method: "tools/call",
          params: { name: "recipes:search", arguments: args },
        }),
      );
    const bounded = { query: "find a recovery recipe", semantic: false, limit: 5 };
    expect(isReservedControlPlaneCall(direct(bounded))).toBe(true);
    expect(isReservedControlPlaneCall(direct({ query: bounded.query, limit: 5 }))).toBe(false);
    expect(isReservedControlPlaneCall(direct({ ...bounded, semantic: true }))).toBe(false);
    expect(isReservedControlPlaneCall(direct({ ...bounded, context: { fleet: "live-fleet" } }))).toBe(false);

    const deferred = Buffer.from(
      JSON.stringify({
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "mcp__papercusp_su__recipes_search",
            args: bounded,
          },
        },
      }),
    );
    expect(isReservedControlPlaneCall(deferred)).toBe(true);
  });

  it("reserves only bounded activity:tool-log recovery reads, including deferred tools:invoke", () => {
    const bounded = {
      owner: "self",
      since: "2026-09-14T07:00:00Z",
      until: "2026-09-14T08:00:00Z",
      max_lines: 40,
      top_k: 8,
    };
    const direct = Buffer.from(
      JSON.stringify({
        method: "tools/call",
        params: { name: "activity:tool-log", arguments: bounded },
      }),
    );
    expect(isReservedControlPlaneCall(direct)).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: {
                name: "mcp__papercusp_su__activity_tool_log",
                args: bounded,
              },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "activity:tool-log",
              arguments: { owner: "self", max_lines: 41 },
            },
          }),
        ),
      ),
    ).toBe(false);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: { name: "activity:tool-log", arguments: {} },
          }),
        ),
      ),
    ).toBe(false);
  });

  it("classifies only an all-handshake JSON-RPC batch for the reconnect bulkhead", () => {
    const body = (value: unknown) => Buffer.from(JSON.stringify(value));
    expect(
      isMcpSessionHandshakeCall(body({ method: "initialize", params: {} })),
    ).toBe(true);
    expect(
      isMcpSessionHandshakeCall(body({ method: "ping", params: {} })),
    ).toBe(true);
    expect(
      isMcpSessionHandshakeCall(body({ method: "tools/list", params: {} })),
    ).toBe(true);
    expect(
      isMcpSessionHandshakeCall(
        body([
          { method: "initialize", params: {} },
          { method: "tools/list", params: {} },
        ]),
      ),
    ).toBe(true);
    expect(
      isMcpSessionHandshakeCall(body({ method: "resources/list", params: {} })),
    ).toBe(false);
    expect(
      isMcpSessionHandshakeCall(
        body([
          { method: "tools/list", params: {} },
          { method: "tools/call", params: { name: "facts:list" } },
        ]),
      ),
    ).toBe(false);
    expect(isMcpSessionHandshakeCall(Buffer.from("{bad json"))).toBe(false);
  });

  it("recognizes only the exact watchdog MCP client path for the diagnostic exemption", () => {
    expect(
      isMcpProxyWatchdogProbePath("/api/mcp?client=mcp-proxy-watchdog"),
    ).toBe(true);
    expect(
      isMcpProxyWatchdogProbePath(
        "/api/mcp?tools=coord%3Aorient&client=mcp-proxy-watchdog&superuser=1",
      ),
    ).toBe(true);
    expect(
      isMcpProxyWatchdogProbePath("/api/mcp?client=mcp-proxy-watchdog-db"),
    ).toBe(false);
    expect(
      isMcpProxyWatchdogProbePath("/api/health?client=mcp-proxy-watchdog"),
    ).toBe(false);
    expect(isMcpProxyWatchdogProbePath(undefined)).toBe(false);
  });

  it("recognizes dedicated capture batches separately from shared continuation batches", () => {
    const call = (name: string) =>
      Buffer.from(JSON.stringify({ method: "tools/call", params: { name } }));
    expect(isCriticalContinuationCall(call("coord:send"))).toBe(false);
    expect(criticalContinuationToolNames(call("coord:send"))).toEqual([]);
    expect(isCoordSendContinuationCall(call("coord:send"))).toBe(true);
    expect(coordSendToolNames(call("coord:send"))).toEqual([
      "coord:send",
    ]);
    expect(isCriticalContinuationCall(call("improvements:capture"))).toBe(false);
    expect(criticalContinuationToolNames(call("improvements:capture"))).toEqual(
      [],
    );
    expect(isImprovementsCaptureContinuationCall(call("improvements:capture"))).toBe(
      true,
    );
    expect(improvementsCaptureToolNames(call("improvements:capture"))).toEqual([
      "improvements:capture",
    ]);
    expect(isCriticalContinuationCall(call("loop:checkpoint"))).toBe(true);
    expect(criticalContinuationToolNames(call("loop:checkpoint"))).toEqual([
      "loop:checkpoint",
    ]);
    expect(isCriticalContinuationCall(call("loop:end"))).toBe(true);
    expect(isCriticalContinuationCall(call("session:request-compaction"))).toBe(
      true,
    );
    expect(isCriticalContinuationCall(call("work_items:checkpoint"))).toBe(
      true,
    );
    expect(isCriticalContinuationCall(call("work_items:complete"))).toBe(true);
    expect(
      isCriticalContinuationCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: { name: "loop:checkpoint", args: {} },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      criticalContinuationToolNames(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: { name: "loop:checkpoint", args: {} },
            },
          }),
        ),
      ),
    ).toEqual(["loop:checkpoint"]);
    const deferredCoordSend = Buffer.from(
      JSON.stringify({
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: { name: "coord:send", args: {} },
        },
      }),
    );
    expect(isCoordSendContinuationCall(deferredCoordSend)).toBe(true);
    expect(coordSendToolNames(deferredCoordSend)).toEqual(["coord:send"]);
    const deferredCapture = Buffer.from(
      JSON.stringify({
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: { name: "improvements:capture", args: {} },
        },
      }),
    );
    expect(isImprovementsCaptureContinuationCall(deferredCapture)).toBe(true);
    expect(improvementsCaptureToolNames(deferredCapture)).toEqual([
      "improvements:capture",
    ]);
    expect(
      isImprovementsCaptureContinuationCall(
        Buffer.from(
          JSON.stringify([
            JSON.parse(call("improvements:capture").toString()),
            JSON.parse(deferredCapture.toString()),
          ]),
        ),
      ),
    ).toBe(true);
    expect(
      isImprovementsCaptureContinuationCall(
        Buffer.from(
          JSON.stringify([
            JSON.parse(call("improvements:capture").toString()),
            JSON.parse(call("loop:end").toString()),
          ]),
        ),
      ),
    ).toBe(false);
    expect(
      isCoordSendContinuationCall(
        Buffer.from(
          JSON.stringify([
            JSON.parse(call("coord:send").toString()),
            JSON.parse(deferredCoordSend.toString()),
          ]),
        ),
      ),
    ).toBe(true);
    expect(
      isCoordSendContinuationCall(
        Buffer.from(
          JSON.stringify([
            JSON.parse(call("coord:send").toString()),
            JSON.parse(call("loop:end").toString()),
          ]),
        ),
      ),
    ).toBe(false);
    expect(
      isCriticalContinuationCall(
        Buffer.from(
          JSON.stringify([
            JSON.parse(call("coord:send").toString()),
            JSON.parse(call("loop:end").toString()),
          ]),
        ),
      ),
    ).toBe(true);
    expect(
      isCriticalContinuationCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "tools:invoke",
              arguments: { name: "loop:end", args: {} },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isCriticalContinuationCall(
        Buffer.from(
          JSON.stringify([
            { method: "tools/call", params: { name: "loop:checkpoint" } },
            { method: "tools/call", params: { name: "work_items:complete" } },
          ]),
        ),
      ),
    ).toBe(true);
    expect(
      isCriticalContinuationCall(
        Buffer.from(
          JSON.stringify([
            { method: "tools/call", params: { name: "loop:checkpoint" } },
            { method: "tools/call", params: { name: "coord:orient" } },
          ]),
        ),
      ),
    ).toBe(false);
    expect(isCriticalContinuationCall(call("work_items:get"))).toBe(false);
    expect(isCriticalContinuationCall(Buffer.from("{bad json"))).toBe(false);
  });

  it("EI-21564741982937381 — loop:checkpoint's read:true snapshot skips the critical lane but stays reserved", () => {
    const directRead = Buffer.from(
      JSON.stringify({
        method: "tools/call",
        params: { name: "loop:checkpoint", arguments: { read: true } },
      }),
    );
    expect(isCriticalContinuationCall(directRead)).toBe(false);
    expect(criticalContinuationToolNames(directRead)).toEqual([]);
    // The read is excluded from the scarce one-socket critical lane but must not fall all the
    // way to unreserved ordinary traffic: loop:checkpoint is also RESERVED_CONTROL_PLANE_TOOLS.
    expect(isReservedControlPlaneCall(directRead)).toBe(true);

    const invokedRead = Buffer.from(
      JSON.stringify({
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: { name: "loop:checkpoint", args: { read: true } },
        },
      }),
    );
    expect(isCriticalContinuationCall(invokedRead)).toBe(false);
    expect(criticalContinuationToolNames(invokedRead)).toEqual([]);
    expect(isReservedControlPlaneCall(invokedRead)).toBe(true);

    // Exact-shape only: a non-boolean read value, a plain write, and a bare (implicitly
    // mutating) call must all keep the critical lane unchanged.
    expect(
      isCriticalContinuationCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: { name: "loop:checkpoint", arguments: { read: "true" } },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isCriticalContinuationCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "loop:checkpoint",
              arguments: { checkpoint: "did/left/insight/next" },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isCriticalContinuationCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: { name: "loop:checkpoint" },
          }),
        ),
      ),
    ).toBe(true);
  });

  it("recognizes PUI identity and psu lifecycle REST paths while leaving the repeating heartbeat unreserved", () => {
    const ordinaryBody = Buffer.from(JSON.stringify({ ownerId: "su-test" }));
    expect(isReservedControlPlanePath("/api/adv/sessions/resumable")).toBe(
      true,
    );
    expect(
      isReservedControlPlanePath("/api/adv/sessions/resumable?limit=30"),
    ).toBe(true);
    expect(
      isReservedControlPlanePath("/api/agent-mcp/console/bootstrap-su/options"),
    ).toBe(true);
    expect(
      isReservedControlPlanePath("/api/agent-mcp/console/bootstrap-su/"),
    ).toBe(true);
    for (const path of [
      "/api/adv/sessions/ensure-codex-home",
      "/api/agent-mcp/console/bootstrap-su/session-ended",
      "/api/agent-mcp/console/bootstrap-su/session-resumed",
      "/api/agent-mcp/console/bootstrap-su/session-resume-finalized",
      "/api/agent-mcp/console/bootstrap-su/session-resume-released",
      "/api/agent-mcp/console/bootstrap-su/session-respawned",
      "/api/adv/sessions/port/delivery",
      "/api/adv/sessions/port/status",
    ]) {
      expect(isReservedControlPlanePath(path)).toBe(true);
      expect(isCriticalContinuationCall(ordinaryBody, path)).toBe(true);
      expect(criticalContinuationToolNames(ordinaryBody, path)).toEqual([
        `rest:${path}`,
      ]);
    }
    expect(isReservedControlPlanePath("/api/tui/identity")).toBe(true);
    expect(isReservedControlPlanePath("/api/tui/identity/")).toBe(true);
    expect(isReservedControlPlanePath("/api/tui/identity?probe=startup")).toBe(
      true,
    );
    expect(
      isReservedControlPlanePath(
        "/api/agent-mcp/console/bootstrap-su/heartbeat",
      ),
    ).toBe(false);
    expect(
      isReservedControlPlaneCall(ordinaryBody, "/api/adv/sessions/resumable"),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        ordinaryBody,
        "/api/agent-mcp/console/bootstrap-su/options",
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        ordinaryBody,
        "/api/agent-mcp/console/bootstrap-su",
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(Buffer.alloc(0), "/api/tui/identity"),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        ordinaryBody,
        "/api/agent-mcp/console/bootstrap-su/heartbeat",
      ),
    ).toBe(false);
    expect(
      isCriticalContinuationCall(
        ordinaryBody,
        "/api/agent-mcp/console/bootstrap-su/heartbeat",
      ),
    ).toBe(false);
  });

  it("admits a lifecycle write from the reserved slot while ordinary traffic sheds", async () => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = track(
      http.createServer(
        (_req, res) => void gate.then(() => res.end('{"ok":true}')),
      ),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        maxInFlight: 2,
        controlPlaneReserve: 1,
        // This fixture exercises immediate shedding; the default FIFO has its own cases.
        maxOrdinaryQueue: 0,
        log: () => {},
      }),
    );
    await listen(proxy);

    const ordinary = request(
      port(proxy),
      JSON.stringify({
        method: "tools/call",
        params: { name: "work_items:list" },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(
      (
        await request(
          port(proxy),
          JSON.stringify({
            method: "tools/call",
            params: { name: "work_items:list" },
          }),
        )
      ).status,
    ).toBe(429);

    const lifecycle = request(
      port(proxy),
      JSON.stringify({ advSessionId: 42, resumeClaimKey: "attempt-1" }),
      "/api/agent-mcp/console/bootstrap-su/session-resumed",
    );
    await new Promise((r) => setTimeout(r, 30));
    releaseUpstream();
    expect((await ordinary).status).toBe(200);
    expect((await lifecycle).status).toBe(200);
  });

  it.each([
    ["canonical colon-form", "scheduler:get_next"],
    ["canonical loop-end form", "loop:end"],
    ["underscore loop-end form", "loop_end"],
    ["Claude MCP-advertised loop-end form", "mcp__papercusp-su__loop_end"],
    [
      "MCP-advertised loop-end form with underscore server slug",
      "mcp__papercusp_su__loop_end",
    ],
    ["canonical glance form", "coord:glance"],
    ["underscore glance form", "coord_glance"],
    ["Claude MCP-advertised glance form", "mcp__papercusp-su__coord_glance"],
    [
      "MCP-advertised glance form with underscore server slug",
      "mcp__papercusp_su__coord_glance",
    ],
    ["underscore group/verb form", "scheduler_get_next"],
    ["Claude MCP-advertised form", "mcp__papercusp-su__scheduler_get_next"],
    [
      "MCP-advertised form with underscore server slug",
      "mcp__papercusp_su__scheduler_get_next",
    ],
    ["canonical locks:queue form", "locks:queue"],
    ["canonical bounded PG diagnostic form", "dev:pg_query"],
    ["underscore bounded PG diagnostic form", "dev_pg_query"],
    [
      "Claude MCP-advertised bounded PG diagnostic form",
      "mcp__papercusp-su__dev_pg_query",
    ],
    [
      "MCP-advertised bounded PG diagnostic form with underscore server slug",
      "mcp__papercusp_su__dev_pg_query",
    ],
    ["canonical plan inspection form", "plans:get"],
    ["underscore plan inspection form", "plans_get"],
    [
      "Claude MCP-advertised plan inspection form",
      "mcp__papercusp-su__plans_get",
    ],
    [
      "MCP-advertised plan inspection form with underscore server slug",
      "mcp__papercusp_su__plans_get",
    ],
    ["canonical locks:acquire form", "locks:acquire"],
    ["underscore locks:acquire form", "locks_acquire"],
    [
      "Claude MCP-advertised locks:acquire form",
      "mcp__papercusp-su__locks_acquire",
    ],
    [
      "MCP-advertised locks:acquire form with underscore server slug",
      "mcp__papercusp_su__locks_acquire",
    ],
    ["underscore locks:queue form", "locks_queue"],
    [
      "Claude MCP-advertised locks:queue form",
      "mcp__papercusp-su__locks_queue",
    ],
    [
      "MCP-advertised locks:queue form with underscore server slug",
      "mcp__papercusp_su__locks_queue",
    ],
    ["canonical locks:cancel_wait form", "locks:cancel_wait"],
    ["underscore locks:cancel_wait form", "locks_cancel_wait"],
    [
      "Claude MCP-advertised locks:cancel_wait form",
      "mcp__papercusp-su__locks_cancel_wait",
    ],
    [
      "MCP-advertised locks:cancel_wait form with underscore server slug",
      "mcp__papercusp_su__locks_cancel_wait",
    ],
    ["canonical events:cancel form", "events:cancel"],
    ["underscore events:cancel form", "events_cancel"],
    [
      "Claude MCP-advertised events:cancel form",
      "mcp__papercusp-su__events_cancel",
    ],
    [
      "MCP-advertised events:cancel form with underscore server slug",
      "mcp__papercusp_su__events_cancel",
    ],
    ["canonical checkpoint form", "work_items:checkpoint"],
    ["underscore checkpoint form", "work_items_checkpoint"],
    [
      "Claude MCP-advertised checkpoint form",
      "mcp__papercusp-su__work_items_checkpoint",
    ],
    [
      "MCP-advertised checkpoint form with underscore server slug",
      "mcp__papercusp_su__work_items_checkpoint",
    ],
    ["canonical release form", "work_items:release"],
    ["underscore release form", "work_items_release"],
    [
      "Claude MCP-advertised release form",
      "mcp__papercusp-su__work_items_release",
    ],
    [
      "MCP-advertised release form with underscore server slug",
      "mcp__papercusp_su__work_items_release",
    ],
    ["canonical completion form", "work_items:complete"],
    ["underscore completion form", "work_items_complete"],
    [
      "Claude MCP-advertised completion form",
      "mcp__papercusp-su__work_items_complete",
    ],
    [
      "MCP-advertised completion form with underscore server slug",
      "mcp__papercusp_su__work_items_complete",
    ],
    ["canonical work-item inspection form", "work_items:get"],
    ["underscore work-item inspection form", "work_items_get"],
    [
      "Claude MCP-advertised work-item inspection form",
      "mcp__papercusp-su__work_items_get",
    ],
    [
      "MCP-advertised work-item inspection form with underscore server slug",
      "mcp__papercusp_su__work_items_get",
    ],
    ["canonical work-item search form", "work_items:search"],
    ["underscore work-item search form", "work_items_search"],
    [
      "Claude MCP-advertised work-item search form",
      "mcp__papercusp-su__work_items_search",
    ],
    [
      "MCP-advertised work-item search form with underscore server slug",
      "mcp__papercusp_su__work_items_search",
    ],
  ])("normalizes %s before checking the reserved set", (_label, name) => {
    expect(
      isReservedControlPlaneCall(
        Buffer.from(JSON.stringify({ method: "tools/call", params: { name } })),
      ),
    ).toBe(true);
  });

  it("does not reserve a similarly named non-control-plane call after normalization", () => {
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: { name: "mcp__papercusp-su__work_items_list" },
          }),
        ),
      ),
    ).toBe(false);
  });

  it("reserves only an exact scorecard audit read, including deferred tools:invoke", () => {
    const args = { rubricRef: "grading-integrity", subjectRef: "EI-22581128473264750", limit: 1 };
    expect(
      isReservedControlPlaneCall(
        Buffer.from(JSON.stringify({ method: "tools/call", params: { name: "scorecards:list", arguments: args } })),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: { name: "tools:invoke", arguments: { name: "scorecards_list", args } },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(JSON.stringify({ method: "tools/call", params: { name: "scorecards:list", arguments: {} } })),
      ),
    ).toBe(false);
  });

  it("reserves a skeleton scorecards:evaluate read for general callers, including deferred tools:invoke", () => {
    const args = { rubricRef: "spec-test-adequacy" };
    expect(
      isReservedControlPlaneCall(
        Buffer.from(JSON.stringify({ method: "tools/call", params: { name: "scorecards:evaluate", arguments: args } })),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: { name: "tools:invoke", arguments: { name: "scorecards_evaluate", args } },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify({
            method: "tools/call",
            params: {
              name: "scorecards:evaluate",
              arguments: { rubricRef: "spec-test-adequacy", ratings: { criterion: { rating: "pass" } } },
            },
          }),
        ),
      ),
    ).toBe(false);
  });

  it("reserves a bounded complete scorecards:evaluate only for the judge role", () => {
    const args = {
      rubricRef: "grading-integrity",
      sourceHive: "papercusp",
      ratings: { criteria: { rating: "pass", evidence: "bounded grading evidence" } },
    };
    const direct = Buffer.from(
      JSON.stringify({ method: "tools/call", params: { name: "scorecards:evaluate", arguments: args } }),
    );
    expect(isReservedControlPlaneCall(direct, "/api/mcp?role=judge")).toBe(true);
    expect(isReservedControlPlaneCall(direct, "/api/mcp?role=worker")).toBe(false);

    const deferred = Buffer.from(
      JSON.stringify({
        method: "tools/call",
        params: { name: "tools:invoke", arguments: { name: "scorecards_evaluate", args } },
      }),
    );
    expect(isReservedControlPlaneCall(deferred, "/api/mcp?role=judge")).toBe(true);
  });

  it("recognizes a JSON-RPC batch when any member is a reserved control-plane call", () => {
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify([
            {
              jsonrpc: "2.0",
              id: 1,
              method: "resources/read",
              params: { uri: "test://ordinary" },
            },
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
          ]),
        ),
      ),
    ).toBe(true);
  });

  it("does not reserve a JSON-RPC batch with no control-plane calls", () => {
    expect(
      isReservedControlPlaneCall(
        Buffer.from(
          JSON.stringify([
            {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "work_items:list" },
            },
            {
              jsonrpc: "2.0",
              id: 2,
              method: "resources/read",
              params: { uri: "test://ordinary" },
            },
          ]),
        ),
      ),
    ).toBe(false);
  });

  it.each([
    "scheduler:get_next",
    "coord:orient",
    "coord:send",
    "coord:glance",
    "coord:inbox",
    "fleet:assignments",
    "fleet:leader-brief",
    "loop:checkpoint",
    "loop:end",
    "session:request-compaction",
    "tools:find",
    "tools:invoke → tools:find",
    "dev:service_health",
    "dev:pg_query",
    "loop:arm",
    "plans:get",
    "plans:get-spec-evidence",
    "conversations:get",
    "tools:invoke → plans:get-spec-evidence",
    "tools:invoke → conversations:get",
    "improvements:capture",
    "locks:acquire",
    "locks:queue",
    "locks:cancel_wait",
    "locks:release",
    "events:await",
    "events:cancel",
    "work_items:checkpoint",
    "work_items:claimable",
    "work_items:get",
    "scorecards:list",
    "scorecards:evaluate",
    "work_items:search",
    "work_items:release",
    "work_items:complete",
    "work_items:set_state",
  ])(
    "admits %s from the reserve while ordinary calls shed",
    async (controlPlaneTool) => {
      let releaseUpstream: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseUpstream = resolve;
      });
      const upstream = track(
        http.createServer(
          (_req, res) => void gate.then(() => res.end('{"result":"ok"}')),
        ),
      );
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          maxInFlight: 2,
          controlPlaneReserve: 1,
          maxOrdinaryQueue: 0,
          log: () => {},
        }),
      );
      await listen(proxy);

      const ordinaryBody = JSON.stringify({
        method: "tools/call",
        params: { name: "work_items:list", arguments: {} },
      });
      const heldOrdinary = request(port(proxy), ordinaryBody);
      await new Promise((r) => setTimeout(r, 40));
      expect((await request(port(proxy), ordinaryBody)).status).toBe(429);

      const invokedTool = controlPlaneTool.startsWith("tools:invoke → ")
        ? controlPlaneTool.slice("tools:invoke → ".length)
        : null;
      const controlPlaneBody = JSON.stringify({
        method: "tools/call",
        params: invokedTool !== null
          ? {
              name: "tools:invoke",
              arguments: { name: invokedTool, args: {} },
            }
          : {
              name: controlPlaneTool,
              arguments:
                controlPlaneTool === "scorecards:list"
                  ? { rubricRef: "grading-integrity", subjectRef: "EI-22581128473264750", limit: 1 }
                  : controlPlaneTool === "scorecards:evaluate"
                    ? { rubricRef: "spec-test-adequacy" }
                  : {},
            },
      });
      const heldControlPlane = request(port(proxy), controlPlaneBody);
      await new Promise((r) => setTimeout(r, 40));
      releaseUpstream();
      expect((await heldOrdinary).status).toBe(200);
      expect((await heldControlPlane).status).toBe(200);
    },
  );

  it.each([
    "/api/adv/sessions/resumable",
    "/api/agent-mcp/console/bootstrap-su/options",
    "/api/agent-mcp/console/bootstrap-su",
    "/api/tui/identity",
  ])(
    "admits REST control-plane path %s from the reserve while ordinary traffic sheds",
    async (path) => {
      let releaseUpstream: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseUpstream = resolve;
      });
      const upstream = track(
        http.createServer(
          (_req, res) => void gate.then(() => res.end('{"result":"ok"}')),
        ),
      );
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          maxInFlight: 2,
          controlPlaneReserve: 1,
          maxOrdinaryQueue: 0,
          log: () => {},
        }),
      );
      await listen(proxy);

      const ordinaryBody = JSON.stringify({
        method: "tools/call",
        params: { name: "work_items:list", arguments: {} },
      });
      const heldOrdinary = request(port(proxy), ordinaryBody);
      await new Promise((r) => setTimeout(r, 40));
      expect((await request(port(proxy), ordinaryBody)).status).toBe(429);

      const heldPreflight = request(port(proxy), "{}", path);
      await new Promise((r) => setTimeout(r, 40));
      releaseUpstream();
      expect((await heldOrdinary).status).toBe(200);
      expect((await heldPreflight).status).toBe(200);
    },
  );

  it('returns one late bootstrap result without replaying it as a handshake', async () => {
    let hits = 0;
    const upstream = track(http.createServer((_req, res) => {
      hits += 1;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
      }, 120);
    }));
    await listen(upstream);
    const proxy = track(createMcpProxy({
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: port(upstream),
      retryWindowMs: 500,
      handshakeTimeoutMs: 40,
      log: () => {},
    }));
    await listen(proxy);

    const result = await request(
      port(proxy),
      JSON.stringify({ bootstrap_idempotency_key: 'fleet-member-1' }),
      '/api/agent-mcp/console/bootstrap-su',
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: 'ok' });
    expect(hits).toBe(1);
  });

  it("keeps the full reserved pool available when ordinary traffic reaches its ceiling, then enforces the hard ceiling", async () => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = track(
      http.createServer(
        (_req, res) => void gate.then(() => res.end('{"result":"ok"}')),
      ),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        maxInFlight: 4,
        controlPlaneReserve: 2,
        maxOrdinaryQueue: 0,
        log: () => {},
      }),
    );
    await listen(proxy);

    const ordinaryBody = JSON.stringify({
      method: "tools/call",
      params: { name: "work_items:list", arguments: {} },
    });
    const heldOrdinary = [
      request(port(proxy), ordinaryBody),
      request(port(proxy), ordinaryBody),
    ];
    await new Promise((r) => setTimeout(r, 40));
    expect((await request(port(proxy), ordinaryBody)).status).toBe(429);

    const controlPlaneBody = JSON.stringify({
      method: "tools/call",
      params: { name: "locks:acquire", arguments: {} },
    });
    const heldControlPlane = [
      request(port(proxy), controlPlaneBody),
      request(port(proxy), controlPlaneBody),
    ];
    await new Promise((r) => setTimeout(r, 40));
    expect((await request(port(proxy), controlPlaneBody)).status).toBe(429);

    releaseUpstream();
    const results = await Promise.all([...heldOrdinary, ...heldControlPlane]);
    expect(results.every((result) => result.status === 200)).toBe(true);
  });

  it("routes coord:thread and direct/deferred coord:declare-intent around a saturated ordinary class", async () => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = track(
      http.createServer(
        (_req, res) => void gate.then(() => res.end('{"result":"ok"}')),
      ),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        maxInFlight: 5,
        controlPlaneReserve: 3,
        maxOrdinaryQueue: 0,
        log: () => {},
      }),
    );
    await listen(proxy);

    const ordinaryBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "test://ordinary" },
    });
    const heldOrdinary = [
      request(port(proxy), ordinaryBody),
      request(port(proxy), ordinaryBody),
    ];
    await new Promise((r) => setTimeout(r, 40));
    expect((await request(port(proxy), ordinaryBody)).status).toBe(429);

    const directIntent = request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "coord:declare-intent",
          arguments: { intent: "claim and advance the selected fleet item" },
        },
      }),
    );
    const deferredIntent = request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "mcp__papercusp_su__coord_declare_intent",
            args: { intent: "claim and advance the selected fleet item" },
          },
        },
      }),
    );
    const threadRead = request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "coord:thread",
          arguments: { root_msg_id: "coord-message-fixture" },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 40));

    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight).toMatchObject({
      ordinary: 2,
      reservedControlPlane: 3,
      maxInFlight: 5,
    });

    releaseUpstream();
    const results = await Promise.all([
      ...heldOrdinary,
      directIntent,
      deferredIntent,
      threadRead,
    ]);
    expect(results.every((result) => result.status === 200)).toBe(true);
  });

  it("routes a bounded coord:feed read around a saturated ordinary class", async () => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = track(
      http.createServer(
        (_req, res) => void gate.then(() => res.end('{"result":"ok"}')),
      ),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        maxInFlight: 2,
        controlPlaneReserve: 1,
        maxOrdinaryQueue: 0,
        log: () => {},
      }),
    );
    await listen(proxy);

    const ordinaryBody = JSON.stringify({
      method: "tools/call",
      params: { name: "work_items:list", arguments: {} },
    });
    const heldOrdinary = request(port(proxy), ordinaryBody);
    await new Promise((r) => setTimeout(r, 40));
    expect((await request(port(proxy), ordinaryBody)).status).toBe(429);

    const boundedFeed = request(
      port(proxy),
      JSON.stringify({
        method: "tools/call",
        params: {
          name: "coord:feed",
          arguments: {
            owner: "su-target",
            since: "2026-10-17T06:00:00.000Z",
            limit: 20,
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 40));
    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight).toMatchObject({
      ordinary: 1,
      reservedControlPlane: 1,
      maxInFlight: 2,
    });

    releaseUpstream();
    const [ordinaryResult, feedResult] = await Promise.all([
      heldOrdinary,
      boundedFeed,
    ]);
    expect(ordinaryResult.status).toBe(200);
    expect(feedResult.status).toBe(200);
  });

  it("EI-21548622458694037: reserved traffic cannot consume ordinary capacity when the reserved class fills first", async () => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = track(
      http.createServer(
        (_req, res) => void gate.then(() => res.end('{"result":"ok"}')),
      ),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        maxInFlight: 4,
        controlPlaneReserve: 2,
        maxOrdinaryQueue: 0,
        log: () => {},
      }),
    );
    await listen(proxy);

    const controlPlaneBody = JSON.stringify({
      method: "tools/call",
      params: { name: "fleet:leader-brief", arguments: {} },
    });
    const heldControlPlane = [
      request(port(proxy), controlPlaneBody),
      request(port(proxy), controlPlaneBody),
    ];
    await new Promise((r) => setTimeout(r, 40));
    expect((await request(port(proxy), controlPlaneBody)).status).toBe(429);

    // The old one-way reserve compared ordinary admission against TOTAL in-flight traffic, so
    // the two reserved calls above consumed the ordinary class before it had sent one request.
    const ordinaryBody = JSON.stringify({
      method: "tools/call",
      params: { name: "work_items:list", arguments: {} },
    });
    const heldOrdinary = [
      request(port(proxy), ordinaryBody),
      request(port(proxy), ordinaryBody),
    ];
    await new Promise((r) => setTimeout(r, 40));
    expect((await request(port(proxy), ordinaryBody)).status).toBe(429);

    releaseUpstream();
    const results = await Promise.all([...heldControlPlane, ...heldOrdinary]);
    expect(results.every((result) => result.status === 200)).toBe(true);
  });

  it("EI-21553301566833091: reserved traffic borrows idle capacity while preserving an ordinary floor and the global cap", async () => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const hits: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        hits.push(
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "unknown",
        );
        void gate.then(() => res.end('{"result":"ok"}'));
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        maxInFlight: 6,
        controlPlaneReserve: 2,
        maxOrdinaryQueue: 0,
        log: () => {},
      }),
    );
    await listen(proxy);

    const controlPlaneBody = JSON.stringify({
      method: "tools/call",
      params: { name: "fleet:leader-brief", arguments: {} },
    });
    const heldControlPlane = Array.from({ length: 4 }, (_, index) =>
      request(
        port(proxy),
        controlPlaneBody,
        `/api/mcp?client=reserved-${index}`,
      ),
    );
    await waitFor(
      () => hits.filter((value) => value.startsWith("reserved-")).length === 4,
    );
    expect(
      (
        await request(
          port(proxy),
          controlPlaneBody,
          "/api/mcp?client=reserved-overflow",
        )
      ).status,
    ).toBe(429);

    const ordinaryBody = JSON.stringify({
      method: "tools/call",
      params: { name: "work_items:list", arguments: {} },
    });
    const heldOrdinary = Array.from({ length: 2 }, (_, index) =>
      request(port(proxy), ordinaryBody, `/api/mcp?client=ordinary-${index}`),
    );
    await waitFor(
      () => hits.filter((value) => value.startsWith("ordinary-")).length === 2,
    );
    expect(
      (
        await request(
          port(proxy),
          ordinaryBody,
          "/api/mcp?client=ordinary-overflow",
        )
      ).status,
    ).toBe(429);

    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight).toMatchObject({
      total: 6,
      ordinary: 2,
      reservedControlPlane: 4,
      maxInFlight: 6,
      ordinaryCeiling: 4,
      ordinaryGuaranteedFloor: 2,
      reservedControlPlaneGuaranteedFloor: 2,
      reservedControlPlaneCeiling: 4,
    });
    expect(health.inFlight.oldestAgeMs.ordinary).toBeGreaterThanOrEqual(0);
    expect(
      health.inFlight.oldestAgeMs.reservedControlPlane,
    ).toBeGreaterThanOrEqual(0);

    releaseUpstream();
    const results = await Promise.all([...heldControlPlane, ...heldOrdinary]);
    expect(results.every((result) => result.status === 200)).toBe(true);
  });

  it("EI-21548622458694037 / EI-21564913101064885: watchdog and every checkpoint wire form survive a full normal partition", async () => {
    let releaseNormal: () => void = () => {};
    const normalGate = new Promise<void>((resolve) => {
      releaseNormal = resolve;
    });
    const upstream = track(
      http.createServer((req, res) => {
        const client = new URL(
          req.url ?? "/",
          "http://127.0.0.1",
        ).searchParams.get("client");
        if (
          client?.startsWith("critical-continuation") ||
          client === "mcp-proxy-watchdog"
        ) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            client === "mcp-proxy-watchdog"
              ? '{"result":{"tools":[{"name":"coord:orient"}]}}'
              : '{"result":{"checkpoint":true}}',
          );
          return;
        }
        void normalGate.then(() => res.end('{"result":"normal-released"}'));
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        handshakeTimeoutMs: 250,
        maxInFlight: 2,
        controlPlaneReserve: 1,
        log: () => {},
      }),
    );
    await listen(proxy);

    const heldOrdinary = request(
      port(proxy),
      JSON.stringify({
        method: "tools/call",
        params: { name: "work_items:list", arguments: {} },
      }),
      "/api/mcp?client=ordinary",
    );
    const heldReserved = request(
      port(proxy),
      JSON.stringify({
        method: "tools/call",
        params: { name: "coord:orient", arguments: {} },
      }),
      "/api/mcp?client=reserved",
    );
    await new Promise((r) => setTimeout(r, 40));

    const checkpointArgs = { id: "EI-test", checkpoint: "fixture" };
    const checkpointForms = [
      { name: "work_items:checkpoint", arguments: checkpointArgs },
      { name: "work_items_checkpoint", arguments: checkpointArgs },
      {
        name: "mcp__papercusp-su__work_items_checkpoint",
        arguments: checkpointArgs,
      },
      {
        name: "tools:invoke",
        arguments: { name: "work_items:checkpoint", args: checkpointArgs },
      },
    ];
    const critical = await Promise.all(
      checkpointForms.map((params, index) =>
        request(
          port(proxy),
          JSON.stringify({
            jsonrpc: "2.0",
            id: index + 2,
            method: "tools/call",
            params: {
              ...params,
              _meta: { idempotencyKey: `checkpoint-fixture-${index}` },
            },
          }),
          `/api/mcp?client=critical-continuation-${index}`,
        ),
      ),
    );
    const watchdog = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      "/api/mcp?superuser=1&client=mcp-proxy-watchdog&tools=coord%3Aorient",
    );

    expect(critical.map((result) => result.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(watchdog.status).toBe(200);
    releaseNormal();
    expect((await heldOrdinary).status).toBe(200);
    expect((await heldReserved).status).toBe(200);
  });

  it("EI-21266423740643882: tools/list bypasses a saturated ordinary upstream socket queue", async () => {
    let releaseFirstUpstream: () => void = () => {};
    const firstUpstreamGate = new Promise<void>((resolve) => {
      releaseFirstUpstream = resolve;
    });
    let upstreamHits = 0;
    const upstream = track(
      http.createServer((_req, res) => {
        upstreamHits++;
        if (upstreamHits === 1) {
          void firstUpstreamGate.then(() =>
            res.end('{"result":"ordinary-released"}'),
          );
          return;
        }
        res.end('{"result":{"tools":[{"name":"coord:orient"}]}}');
      }),
    );
    await listen(upstream);

    // One ordinary socket is deliberately held. The second ordinary forward is admitted but
    // queues inside that one-socket agent — the scaled-down shape of 192 admitted / 64 sockets.
    const ordinaryAgent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    const controlPlaneAgent = new http.Agent({
      keepAlive: false,
      maxSockets: 1,
    });
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 800,
        retryBackoffMs: 20,
        handshakeTimeoutMs: 80,
        maxInFlight: 3,
        controlPlaneReserve: 1,
        upstreamAgent: ordinaryAgent,
        controlPlaneAgent,
        log: () => {},
      }),
    );
    await listen(proxy);

    const ordinaryBody = JSON.stringify({
      method: "tools/call",
      params: { name: "work_items:list", arguments: {} },
    });
    const heldOrdinary = [
      request(port(proxy), ordinaryBody),
      request(port(proxy), ordinaryBody),
    ];
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Without the dedicated pool, this probe sits behind the held ordinary socket, burns its
    // handshake timeouts, and returns 502. With end-to-end reservation it reaches upstream now.
    const probe = await request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    );

    releaseFirstUpstream();
    const ordinaryResults = await Promise.all(heldOrdinary);
    ordinaryAgent.destroy();
    controlPlaneAgent.destroy();

    expect(probe.status).toBe(200);
    expect(JSON.parse(probe.body).result.tools).toHaveLength(1);
    expect(ordinaryResults.every((result) => result.status === 200)).toBe(true);
  });

  it("EI-21391963810159383: a fresh-proxy reconnect herd is class-bounded and leaves the watchdog a diagnostic socket", async () => {
    const reconnects = 60;
    const handshakeLimit = 3;
    let releaseSilentUpstream: () => void = () => {};
    const silentUpstreamGate = new Promise<void>((resolve) => {
      releaseSilentUpstream = resolve;
    });
    let ordinaryHits = 0;
    let ordinaryActive = 0;
    let maxOrdinaryActive = 0;
    let ordinaryHitsAtWatchdog = -1;

    const upstream = track(
      http.createServer((req, res) => {
        const client = new URL(
          req.url ?? "/",
          "http://127.0.0.1",
        ).searchParams.get("client");
        if (client === "mcp-proxy-watchdog") {
          ordinaryHitsAtWatchdog = ordinaryHits;
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":{"tools":[{"name":"coord:orient"}]}}');
          return;
        }

        ordinaryHits++;
        ordinaryActive++;
        maxOrdinaryActive = Math.max(maxOrdinaryActive, ordinaryActive);
        res.once("close", () => {
          ordinaryActive--;
        });
        void silentUpstreamGate.then(() => {
          if (res.destroyed) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":{"tools":[{"name":"coord:orient"}]}}');
        });
      }),
    );
    await listen(upstream);

    const controlPlaneAgent = new http.Agent({
      keepAlive: false,
      maxSockets: handshakeLimit + 1,
    });
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 10_000,
        retryBackoffMs: 10,
        // Keep the first admitted class silent long enough for all 57 surplus loopback
        // clients to reach admission before any slot can recycle.
        handshakeTimeoutMs: 1_500,
        maxInFlight: 100,
        controlPlaneReserve: handshakeLimit + 1,
        controlPlaneAgent,
        // Scaled-down production policy: reserve one diagnostic socket outside the class cap.
        maxHandshakeInFlight: handshakeLimit,
        // Preserve the immediate-shed contract in this legacy bulkhead test; queue-on behavior
        // is covered by the focused FIFO tests below.
        maxHandshakeQueue: 0,
        log: () => {},
      }),
    );
    await listen(proxy);

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const completedBeforeRelease: Array<{ status: number; body: string }> = [];
    const herd = Array.from({ length: reconnects }, (_, i) =>
      request(port(proxy), body, `/api/mcp?client=reconnect-${i}`).then(
        (result) => {
          completedBeforeRelease.push(result);
          return result;
        },
      ),
    );
    const arrivalDeadline = Date.now() + 1_000;
    while (
      completedBeforeRelease.filter((result) => result.status === 429).length <
        reconnects - handshakeLimit &&
      Date.now() < arrivalDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const shedBeforeRelease = completedBeforeRelease.filter(
      (result) => result.status === 429,
    ).length;

    // The proxy's own route stays responsive while the upstream-facing class is saturated.
    expect((await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).status).toBe(
      200,
    );

    // The watchdog's specifically named probe bypasses only the class cap and uses the one
    // socket deliberately left outside it. It must reach upstream before a fourth reconnect.
    const watchdog = await request(
      port(proxy),
      body,
      "/api/mcp?superuser=1&client=mcp-proxy-watchdog&tools=coord%3Aorient",
    );
    expect(watchdog.status).toBe(200);
    expect(ordinaryHitsAtWatchdog).toBe(handshakeLimit);

    releaseSilentUpstream();
    const results = await Promise.all(herd);
    controlPlaneAgent.destroy();

    const shed = results.filter((result) => result.status === 429);
    const admitted = results.filter((result) => result.status === 200);
    expect(shedBeforeRelease).toBe(reconnects - handshakeLimit);
    expect(shed).toHaveLength(reconnects - handshakeLimit);
    expect(admitted).toHaveLength(handshakeLimit);
    expect(
      shed.every(
        (result) =>
          JSON.parse(result.body).error === "mcp_proxy_handshake_overloaded",
      ),
    ).toBe(true);
    expect(maxOrdinaryActive).toBeLessThanOrEqual(handshakeLimit);
    expect(ordinaryHits).toBeLessThanOrEqual(
      handshakeLimit * (MAX_HANDSHAKE_TIMEOUT_RETRIES + 1),
    );

    const afterDrain = await request(
      port(proxy),
      body,
      "/api/mcp?client=reconnect-after-drain",
    );
    expect(afterDrain.status).toBe(200);
  }, 10_000);

  it("EI-21391953229965975: watchdog probe bypasses ordinary reserved tools/call socket starvation", async () => {
    let releaseOrdinary: () => void = () => {};
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    let ordinaryStarted: () => void = () => {};
    const ordinaryStartedGate = new Promise<void>((resolve) => {
      ordinaryStarted = resolve;
    });
    const upstream = track(
      http.createServer((req, res) => {
        const client = new URL(
          req.url ?? "/",
          "http://127.0.0.1",
        ).searchParams.get("client");
        if (client === "mcp-proxy-watchdog") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":{"tools":[{"name":"coord:orient"}]}}');
          return;
        }
        ordinaryStarted();
        void ordinaryGate.then(() => {
          if (res.destroyed) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":{"ok":true}}');
        });
      }),
    );
    await listen(upstream);

    const controlPlaneAgent = new http.Agent({
      keepAlive: false,
      maxSockets: 1,
    });
    const watchdogAgent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        retryBackoffMs: 10,
        handshakeTimeoutMs: 100,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        controlPlaneAgent,
        watchdogAgent,
        log: () => {},
      }),
    );
    await listen(proxy);

    const ordinary = request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "coord:orient", arguments: {} },
      }),
      "/api/mcp?client=ordinary-control-plane",
    );
    await ordinaryStartedGate;

    const watchdog = request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
      "/api/mcp?superuser=1&client=mcp-proxy-watchdog&tools=coord%3Aorient",
    );
    const watchdogBeforeOrdinaryRelease = await Promise.race([
      watchdog,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);

    expect(watchdogBeforeOrdinaryRelease?.status).toBe(200);
    releaseOrdinary();
    expect((await ordinary).status).toBe(200);
    watchdogAgent.destroy();
    controlPlaneAgent.destroy();
  });

  it("EI-21329733885767129: critical continuation writes bypass a saturated reserved socket pool", async () => {
    let releaseOrdinary: () => void = () => {};
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    let ordinaryStarted: () => void = () => {};
    const ordinaryStartedGate = new Promise<void>((resolve) => {
      ordinaryStarted = resolve;
    });
    const upstream = track(
      http.createServer((req, res) => {
        const client = new URL(
          req.url ?? "/",
          "http://127.0.0.1",
        ).searchParams.get("client");
        if (client === "critical-continuation") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":{"critical":true}}');
          return;
        }
        ordinaryStarted();
        void ordinaryGate.then(() => {
          if (res.destroyed) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":{"ordinary":true}}');
        });
      }),
    );
    await listen(upstream);

    const controlPlaneAgent = new http.Agent({
      keepAlive: false,
      maxSockets: 1,
    });
    const criticalContinuationAgent = new http.Agent({
      keepAlive: false,
      maxSockets: 1,
    });
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        retryBackoffMs: 10,
        handshakeTimeoutMs: 100,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        controlPlaneAgent,
        criticalContinuationAgent,
        log: () => {},
      }),
    );
    await listen(proxy);

    const ordinary = request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "coord:orient", arguments: {} },
      }),
      "/api/mcp?client=ordinary-control-plane",
    );
    await ordinaryStartedGate;

    for (const [index, name] of [
      "loop:checkpoint",
      "coord:send",
      "improvements:capture",
    ].entries()) {
      const critical = request(
        port(proxy),
        JSON.stringify({
          jsonrpc: "2.0",
          id: index + 2,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
        "/api/mcp?client=critical-continuation",
      );
      const criticalBeforeOrdinaryRelease = await Promise.race([
        critical,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
      expect(criticalBeforeOrdinaryRelease?.status).toBe(200);
    }
    releaseOrdinary();
    expect((await ordinary).status).toBe(200);
    criticalContinuationAgent.destroy();
    controlPlaneAgent.destroy();
  });

  it.each(["connected", "before-headers", "after-headers"])("holds same-item continuation until the streamed response ends (client disconnected: %s)", async (disconnect) => {
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let releaseHeaders = () => {};
    const headersGate = new Promise<void>((resolve) => { releaseHeaders = resolve; });
    let firstReached = () => {};
    const firstStarted = new Promise<void>((resolve) => { firstReached = resolve; });
    let receivedFrame = () => {};
    const firstFrame = new Promise<void>((resolve) => { receivedFrame = resolve; });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(http.createServer((req, res) => {
      const client = new URL(req.url ?? "/", "http://localhost").searchParams.get("client")!;
      hits.push(client);
      if (client === "first") {
        firstReached();
        void (async () => {
          if (disconnect === "before-headers") await headersGate;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(": tool still running\n\n");
          await firstGate;
          res.end('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
        })();
      } else {
        res.end('{"result":{}}');
      }
    }));
    await listen(upstream);
    const proxy = track(createMcpProxy({
      listenPort: 0, targetHost: "127.0.0.1", targetPort: port(upstream),
      retryWindowMs: 1_000, maxInFlight: 10, controlPlaneReserve: 2,
      criticalContinuationQueueWaitLogMs: 0, log: (line) => logs.push(line),
    }));
    await listen(proxy);
    const body = (id: string) => JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "tools/call", params: { name: "work_items:checkpoint", arguments: { id } } });
    let clientRequest: http.ClientRequest;
    const first = new Promise<number>((resolve) => {
      clientRequest = http.request({ host: "127.0.0.1", port: port(proxy), method: "POST",
        path: "/api/mcp?client=first" }, (res) => {
        res.on("data", receivedFrame);
        res.once("end", () => resolve(res.statusCode ?? 0));
        res.once("aborted", () => resolve(res.statusCode ?? 0));
      });
      clientRequest.once("error", () => resolve(0));
      clientRequest.end(body("WI-1"));
    });
    let second: ReturnType<typeof request> | undefined;
    try {
      if (disconnect === "before-headers") {
        await firstStarted;
        clientRequest!.destroy();
        releaseHeaders();
      } else {
        await firstFrame;
        if (disconnect === "after-headers") clientRequest!.destroy();
      }
      second = request(port(proxy), body("WI-1"), "/api/mcp?client=second");
      await waitFor(() => hits.includes("second") || logs.some((line) =>
        line.includes("queued critical-continuation request")));
      expect(hits).toEqual(["first"]);
      expect((await request(port(proxy), body("WI-2"), "/api/mcp?client=unrelated")).status).toBe(200);
      expect(hits).toEqual(["first", "unrelated"]);
      releaseFirst();
      expect((await second).status).toBe(200);
      expect(hits).toEqual(["first", "unrelated", "second"]);
    } finally {
      releaseHeaders();
      releaseFirst();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });

  it("EI-21552316713302755 / EI-21556422206126497: queues loop:end and compaction behind a continuation write", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "critical-first") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"first":true}}'));
          return;
        }
        res.end('{"result":{"queued":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 2,
        maxCriticalContinuationQueueWaitMs: 1_000,
        criticalContinuationQueueWaitLogMs: 50,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const continuationBody = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      continuationBody(1, "loop:checkpoint"),
      "/api/mcp?client=critical-first",
    );
    await firstStarted;

    let secondSettled = false;
    const second = request(
      port(proxy),
      continuationBody(2, "loop:end"),
      "/api/mcp?client=critical-second",
    ).then((result) => {
      secondSettled = true;
      return result;
    });
    let compactionSettled = false;
    const compaction = request(
      port(proxy),
      continuationBody(3, "session:request-compaction"),
      "/api/mcp?client=critical-compaction",
    ).then((result) => {
      compactionSettled = true;
      return result;
    });
    await waitFor(() =>
      logs.some((line) =>
        line.includes("queued critical-continuation request"),
      ),
    );
    expect(secondSettled).toBe(false);
    expect(compactionSettled).toBe(false);
    expect(hits).toEqual(["critical-first"]);

    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationRequests).toEqual([
      expect.objectContaining({
        traceId: expect.any(String),
        tools: ["loop:checkpoint"],
      }),
    ]);
    expect(health.inFlight.criticalContinuationQueue).toMatchObject({
      waiting: 2,
      max: 2,
      maxWaitMs: 1_000,
      requests: expect.arrayContaining([
        expect.objectContaining({
          traceId: expect.any(String),
          tools: ["loop:end"],
        }),
        expect.objectContaining({
          traceId: expect.any(String),
          tools: ["session:request-compaction"],
        }),
      ]),
    });

    const overflow = await request(
      port(proxy),
      continuationBody(4, "loop:end"),
      "/api/mcp?client=critical-overflow",
    );
    expect(overflow.status).toBe(429);
    expect(JSON.parse(overflow.body).error).toBe(
      "mcp_proxy_critical_continuation_queue_full",
    );
    expect(hits).toEqual(["critical-first"]);

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await compaction).status).toBe(200);
    expect(hits).toEqual([
      "critical-first",
      "critical-compaction",
      "critical-second",
    ]);
  });

  it("EI-21558462806716442: queues a concurrent work_items:complete instead of shedding it", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "complete-first") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"first":true}}'));
          return;
        }
        res.end('{"result":{"second":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxCriticalContinuationQueueWaitMs: 1_000,
        criticalContinuationQueueWaitLogMs: 50,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const completionBody = (id: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "work_items:complete",
          arguments: {
            id: `EI-test-${id}`,
            state: "done",
            assumptions: "none",
            completion: {
              summary: "proxy completion regression",
              testsRun: ["focused proxy test"],
              testResult: "passed",
              verifiedHow: "in-process upstream fixture",
              filesChanged: [],
            },
          },
        },
      });
    const first = request(
      port(proxy),
      completionBody(1),
      "/api/mcp?client=complete-first",
    );
    await firstStarted;

    let secondSettled = false;
    const second = request(
      port(proxy),
      completionBody(2),
      "/api/mcp?client=complete-second",
    ).then((result) => {
      secondSettled = true;
      return result;
    });
    await waitFor(() =>
      logs.some((line) =>
        line.includes("queued critical-continuation request"),
      ),
    );
    expect(secondSettled).toBe(false);
    expect(hits).toEqual(["complete-first"]);

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(hits).toEqual(["complete-first", "complete-second"]);
  });

  it("EI-21656921370271015: admits five concurrent checkpoints beyond an aged continuation FIFO", async () => {
    const maxInFlight = 200;
    const agedWaiterCount = 16;
    const checkpointCount = 5;
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-completion") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"complete":true}}'));
          return;
        }
        res.end('{"result":{"ok":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        retryBackoffMs: 5,
        // Exercise the production default relationship without explicitly pinning the
        // continuation queue: a stale runtime's old fixed 16-slot default sheds four of the
        // five checkpoint calls below, while the durable default follows this admission cap.
        maxInFlight,
        controlPlaneReserve: 0,
        criticalContinuationQueueWaitLogMs: 0,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=held-completion",
    );
    await firstStarted;

    const aged = Array.from({ length: agedWaiterCount }, (_, index) =>
      request(
        port(proxy),
        body(index + 2, "loop:end"),
        `/api/mcp?client=aged-${index}`,
      ),
    );
    await waitFor(
      () =>
        logs.filter((line) =>
          line.includes("queued critical-continuation request"),
        ).length >= agedWaiterCount,
    );

    const healthBeforeCheckpoints = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(healthBeforeCheckpoints.inFlight.criticalContinuationQueue).toMatchObject(
      {
        waiting: agedWaiterCount,
        max: maxInFlight,
      },
    );

    const checkpointSettled = Array.from({ length: checkpointCount }, () => false);
    const checkpoints = Array.from({ length: checkpointCount }, (_, index) =>
      request(
        port(proxy),
        body(agedWaiterCount + index + 2, "work_items:checkpoint"),
        `/api/mcp?client=checkpoint-${index}`,
      ).then((result) => {
        checkpointSettled[index] = true;
        return result;
      }),
    );
    await waitFor(
      () =>
        logs.filter((line) =>
          line.includes("queued critical-continuation request"),
        ).length >= agedWaiterCount + checkpointCount,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    // None of the five mutations may be shed or forwarded while the held completion owns the
    // single continuation socket; all five must remain queued with a durable outcome.
    expect(checkpointSettled).toEqual(
      Array.from({ length: checkpointCount }, () => false),
    );
    expect(hits).toEqual(["held-completion"]);
    const healthWithCheckpoints = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(healthWithCheckpoints.inFlight.criticalContinuationQueue).toMatchObject(
      {
        waiting: agedWaiterCount + checkpointCount,
        max: maxInFlight,
      },
    );

    releaseFirst();
    const results = await Promise.all([first, ...aged, ...checkpoints]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(hits).toHaveLength(1 + agedWaiterCount + checkpointCount);
    for (let index = 0; index < agedWaiterCount; index++) {
      expect(hits).toContain(`aged-${index}`);
    }
    for (let index = 0; index < checkpointCount; index++) {
      expect(hits).toContain(`checkpoint-${index}`);
    }
  }, 10_000);

  it("EI-21568137857973279: reserves one priority waiter for compaction when the continuation FIFO is full", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-checkpoint") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"queued":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxCriticalContinuationQueueWaitMs: 1_000,
        criticalContinuationQueueWaitLogMs: 20,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:checkpoint"),
      "/api/mcp?client=held-checkpoint",
    );
    await firstStarted;

    const ordinary = request(
      port(proxy),
      body(2, "work_items:complete"),
      "/api/mcp?client=queued-ordinary",
    );
    await waitFor(() =>
      logs.some((line) => line.includes("queued critical-continuation request")),
    );

    let compactionSettled = false;
    const compaction = request(
      port(proxy),
      body(3, "session:request-compaction"),
      "/api/mcp?client=priority-compaction",
    ).then((result) => {
      compactionSettled = true;
      return result;
    });
    await waitFor(() =>
      logs.filter((line) => line.includes("queued critical-continuation request"))
        .length >= 2,
    );
    expect(compactionSettled).toBe(false);
    expect(hits).toEqual(["held-checkpoint"]);

    const secondCompaction = await request(
      port(proxy),
      body(4, "session:request-compaction"),
      "/api/mcp?client=second-compaction",
    );
    expect(secondCompaction.status).toBe(429);
    expect(JSON.parse(secondCompaction.body).error).toBe(
      "mcp_proxy_critical_continuation_queue_full",
    );

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await compaction).status).toBe(200);
    expect((await ordinary).status).toBe(200);
    expect(hits).toEqual([
      "held-checkpoint",
      "priority-compaction",
      "queued-ordinary",
    ]);
  });

  it("EI-21567991637671620: reserves one priority waiter for loop:checkpoint when the continuation FIFO is full", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const forwardedBodies = new Map<string, string>();
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          forwardedBodies.set(client, Buffer.concat(chunks).toString("utf8"));
          hits.push(client);
          if (client === "held-completion") {
            noteFirstStarted();
            void firstGate.then(() => res.end('{"result":{"held":true}}'));
            return;
          }
          res.end('{"result":{"queued":true}}');
        });
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxCriticalContinuationQueueWaitMs: 1_000,
        criticalContinuationQueueWaitLogMs: 20,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string, idempotencyKey?: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: {},
          ...(idempotencyKey
            ? { _meta: { idempotencyKey } }
            : {}),
        },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=held-completion",
    );
    await firstStarted;

    const ordinary = request(
      port(proxy),
      body(2, "loop:end"),
      "/api/mcp?client=queued-ordinary",
    );
    await waitFor(() =>
      logs.some((line) => line.includes("queued critical-continuation request")),
    );

    let checkpointSettled = false;
    const checkpoint = request(
      port(proxy),
      body(3, "loop:checkpoint", "original-checkpoint-key"),
      "/api/mcp?client=priority-checkpoint",
    ).then((result) => {
      checkpointSettled = true;
      return result;
    });
    await waitFor(() =>
      logs.filter((line) => line.includes("queued critical-continuation request"))
        .length >= 2,
    );
    expect(checkpointSettled).toBe(false);
    expect(hits).toEqual(["held-completion"]);

    const secondCheckpoint = await request(
      port(proxy),
      body(4, "loop:checkpoint", "second-checkpoint-key"),
      "/api/mcp?client=second-checkpoint",
    );
    expect(secondCheckpoint.status).toBe(429);
    expect(JSON.parse(secondCheckpoint.body).error).toBe(
      "mcp_proxy_critical_continuation_queue_full",
    );

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await checkpoint).status).toBe(200);
    expect((await ordinary).status).toBe(200);
    expect(hits).toEqual([
      "held-completion",
      "priority-checkpoint",
      "queued-ordinary",
    ]);
    expect(
      JSON.parse(forwardedBodies.get("priority-checkpoint") ?? "{}").params
        ._meta.idempotencyKey,
    ).toBe("original-checkpoint-key");
  });

  it("EI-21598413057126541: reserves work_items:checkpoint separately from loop:checkpoint when the continuation FIFO is full", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-completion") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"queued":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxCriticalContinuationQueueWaitMs: 1_000,
        criticalContinuationQueueWaitLogMs: 20,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=held-completion",
    );
    await firstStarted;

    const loopCheckpoint = request(
      port(proxy),
      body(2, "loop:checkpoint"),
      "/api/mcp?client=loop-checkpoint",
    );
    await waitFor(() =>
      logs.some((line) => line.includes("queued critical-continuation request")),
    );

    let fallbackSettled = false;
    const fallbackCheckpoint = request(
      port(proxy),
      body(3, "work_items:checkpoint"),
      "/api/mcp?client=work-item-checkpoint",
    ).then((result) => {
      fallbackSettled = true;
      return result;
    });
    await waitFor(
      () =>
        logs.filter((line) =>
          line.includes("queued critical-continuation request"),
        ).length >= 2,
    );
    expect(fallbackSettled).toBe(false);
    expect(hits).toEqual(["held-completion"]);

    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationQueue).toMatchObject({
      waiting: 2,
      max: 1,
      requests: expect.arrayContaining([
        expect.objectContaining({ tools: ["loop:checkpoint"] }),
        expect.objectContaining({ tools: ["work_items:checkpoint"] }),
      ]),
    });

    const secondFallback = await request(
      port(proxy),
      body(4, "work_items:checkpoint"),
      "/api/mcp?client=second-work-item-checkpoint",
    );
    expect(secondFallback.status).toBe(429);
    expect(JSON.parse(secondFallback.body).error).toBe(
      "mcp_proxy_critical_continuation_queue_full",
    );

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await fallbackCheckpoint).status).toBe(200);
    expect((await loopCheckpoint).status).toBe(200);
    expect(hits).toEqual([
      "held-completion",
      "work-item-checkpoint",
      "loop-checkpoint",
    ]);
  });

  it("EI-21598494085262519: admits the fallback checkpoint when a full FIFO already contains loop:checkpoint", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-completion") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"queued":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 16,
        maxCriticalContinuationQueueWaitMs: 5_000,
        criticalContinuationQueueWaitLogMs: 20,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=held-completion",
    );
    await firstStarted;

    const ordinary = Array.from({ length: 15 }, (_, index) =>
      request(
        port(proxy),
        body(index + 2, "loop:end"),
        `/api/mcp?client=ordinary-${index + 1}`,
      ),
    );
    await waitFor(
      () =>
        logs.filter((line) =>
          line.includes("queued critical-continuation request"),
        ).length >= 15,
    );

    const loopCheckpoint = request(
      port(proxy),
      body(17, "loop:checkpoint"),
      "/api/mcp?client=loop-checkpoint",
    );
    await waitFor(
      () =>
        logs.filter((line) =>
          line.includes("queued critical-continuation request"),
        ).length >= 16,
    );

    let fallbackSettled = false;
    const fallbackCheckpoint = request(
      port(proxy),
      body(18, "work_items:checkpoint"),
      "/api/mcp?client=work-item-checkpoint",
    ).then((result) => {
      fallbackSettled = true;
      return result;
    });
    await waitFor(
      () =>
        logs.filter((line) =>
          line.includes("queued critical-continuation request"),
        ).length >= 17,
    );

    expect(fallbackSettled).toBe(false);
    expect(hits).toEqual(["held-completion"]);
    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationQueue).toMatchObject({
      waiting: 17,
      max: 16,
      requests: expect.arrayContaining([
        expect.objectContaining({ tools: ["loop:checkpoint"] }),
        expect.objectContaining({ tools: ["work_items:checkpoint"] }),
      ]),
    });

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await fallbackCheckpoint).status).toBe(200);
    expect((await loopCheckpoint).status).toBe(200);
    expect((await Promise.all(ordinary)).every(({ status }) => status === 200)).toBe(
      true,
    );
    expect(hits.slice(0, 3)).toEqual([
      "held-completion",
      "work-item-checkpoint",
      "loop-checkpoint",
    ]);
    expect(hits).toHaveLength(18);
  });

  it("EI-21567905826837255: reserves one priority waiter for work_items:complete when the continuation FIFO is full", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-completion") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"queued":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxCriticalContinuationQueueWaitMs: 1_000,
        criticalContinuationQueueWaitLogMs: 20,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=held-completion",
    );
    await firstStarted;

    const ordinary = request(
      port(proxy),
      body(2, "loop:end"),
      "/api/mcp?client=queued-ordinary",
    );
    await waitFor(() =>
      logs.some((line) => line.includes("queued critical-continuation request")),
    );

    let priorityCompletionSettled = false;
    const priorityCompletion = request(
      port(proxy),
      body(3, "work_items:complete"),
      "/api/mcp?client=priority-completion",
    ).then((result) => {
      priorityCompletionSettled = true;
      return result;
    });
    await waitFor(() =>
      logs.filter((line) => line.includes("queued critical-continuation request"))
        .length >= 2,
    );
    expect(priorityCompletionSettled).toBe(false);
    expect(hits).toEqual(["held-completion"]);

    const secondCompletion = await request(
      port(proxy),
      body(4, "work_items:complete"),
      "/api/mcp?client=second-completion",
    );
    expect(secondCompletion.status).toBe(429);
    expect(JSON.parse(secondCompletion.body).error).toBe(
      "mcp_proxy_critical_continuation_queue_full",
    );

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await priorityCompletion).status).toBe(200);
    expect((await ordinary).status).toBe(200);
    expect(hits).toEqual([
      "held-completion",
      "priority-completion",
      "queued-ordinary",
    ]);
  });

  it("EI-21598483081476321: admits the first terminal completion beyond a full 16-waiter continuation FIFO", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-completion") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"queued":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 16,
        maxCriticalContinuationQueueWaitMs: 5_000,
        criticalContinuationQueueWaitLogMs: 20,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=held-completion",
    );
    await firstStarted;

    const ordinary = Array.from({ length: 16 }, (_, index) =>
      request(
        port(proxy),
        body(index + 2, "loop:end"),
        `/api/mcp?client=ordinary-${index + 1}`,
      ),
    );
    await waitFor(
      () =>
        logs.filter((line) =>
          line.includes("queued critical-continuation request"),
        ).length >= 16,
    );

    let terminalSettled = false;
    const terminal = request(
      port(proxy),
      body(18, "work_items:complete"),
      "/api/mcp?client=terminal-completion",
    ).then((result) => {
      terminalSettled = true;
      return result;
    });
    await waitFor(
      () =>
        logs.filter((line) =>
          line.includes("queued critical-continuation request"),
        ).length >= 17,
    );

    expect(terminalSettled).toBe(false);
    expect(hits).toEqual(["held-completion"]);
    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationQueue).toMatchObject({
      waiting: 17,
      max: 16,
      requests: expect.arrayContaining([
        expect.objectContaining({ tools: ["work_items:complete"] }),
      ]),
    });

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await terminal).status).toBe(200);
    expect((await Promise.all(ordinary)).every(({ status }) => status === 200)).toBe(
      true,
    );
    expect(hits.slice(0, 2)).toEqual([
      "held-completion",
      "terminal-completion",
    ]);
    expect(hits).toHaveLength(18);
  });

  it("EI-21669304707115602: pure coord:send bypasses a full shared continuation FIFO", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-completion") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"queued":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 16,
        maxCriticalContinuationQueueWaitMs: 5_000,
        criticalContinuationQueueWaitLogMs: 20,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=held-completion",
    );
    await firstStarted;

    const ordinary = Array.from({ length: 16 }, (_, index) =>
      request(
        port(proxy),
        body(index + 2, "loop:end"),
        `/api/mcp?client=ordinary-${index + 1}`,
      ),
    );
    await waitFor(
      () =>
        logs.filter((line) =>
          line.includes("queued critical-continuation request"),
        ).length >= 16,
    );

    let sendSettled = false;
    const send = request(
      port(proxy),
      body(18, "coord:send"),
      "/api/mcp?client=priority-send",
    ).then((result) => {
      sendSettled = true;
      return result;
    });
    await waitFor(() => sendSettled);

    expect(sendSettled).toBe(true);
    expect(await send).toMatchObject({ status: 200 });
    expect(hits).toEqual(["held-completion", "priority-send"]);
    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationQueue).toMatchObject({
      waiting: 16,
      max: 16,
      requests: expect.not.arrayContaining([
        expect.objectContaining({ tools: ["coord:send"] }),
      ]),
    });
    expect(health.inFlight.coordSendQueue).toMatchObject({
      waiting: 0,
      max: 16,
    });

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await Promise.all(ordinary)).every(({ status }) => status === 200)).toBe(
      true,
    );
    expect(hits.slice(0, 2)).toEqual([
      "held-completion",
      "priority-send",
    ]);
    expect(hits).toHaveLength(18);
  });

  it("EI-22690386207028024: coord:send uses the reserved budget for concurrent handoffs", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    let noteSecondStarted: () => void = () => {};
    const secondStarted = new Promise<void>((resolve) => {
      noteSecondStarted = resolve;
    });
    const hits: string[] = [];
    let active = 0;
    let maxActive = 0;
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        active++;
        maxActive = Math.max(maxActive, active);
        res.once("close", () => {
          active = Math.max(0, active - 1);
        });
        if (client === "held-send") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        noteSecondStarted();
        res.end('{"result":{"sent":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 2,
        maxCoordSendQueue: 1,
        coordSendQueueWaitMs: 250,
        log: () => {},
      }),
    );
    await listen(proxy);

    const body = (id: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "coord:send", arguments: {} },
      });
    let first: ReturnType<typeof request> | undefined;
    let second: ReturnType<typeof request> | undefined;
    try {
      first = request(port(proxy), body(1), "/api/mcp?client=held-send");
      await firstStarted;
      second = request(port(proxy), body(2), "/api/mcp?client=parallel-send");
      const secondReached = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 500);
        void secondStarted.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      expect(secondReached).toBe(true);
      expect(maxActive).toBe(2);
      const health = JSON.parse(
        (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
      );
      expect(health.inFlight.coordSendMax).toBe(2);
      expect((await second).status).toBe(200);
    } finally {
      releaseFirst();
      if (first) await first;
      if (second) await second;
    }
    expect(hits).toEqual(["held-send", "parallel-send"]);
  });

  it("EI-21653510279635866: expires a queued dedicated coord:send before the client deadline", async () => {
    expect(DEFAULT_CRITICAL_CONTINUATION_QUEUE_WAIT_MS).toBe(0);
    expect(DEFAULT_COORD_SEND_QUEUE_WAIT_MS).toBeLessThan(60_000);

    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-send") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"sent":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxCoordSendQueue: 1,
        coordSendQueueWaitMs: 25,
        criticalContinuationQueueWaitLogMs: 10,
        log: () => {},
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "coord:send"),
      "/api/mcp?client=held-send",
    );
    await firstStarted;

    const send = await request(
      port(proxy),
      body(2, "coord:send"),
      "/api/mcp?client=queued-send",
    );
    expect(send.status).toBe(429);
    expect(JSON.parse(send.body)).toMatchObject({
      error: "mcp_proxy_coord_send_queue_dwell",
      forwardingResult: "not_forwarded",
    });
    expect(hits).toEqual(["held-send"]);

    releaseFirst();
    expect((await first).status).toBe(200);
  });

  it("EI-22052756477768229: does not expire a queued loop:checkpoint behind a finite generic dwell", async () => {
    expect(DEFAULT_CRITICAL_CONTINUATION_QUEUE_WAIT_MS).toBe(0);

    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-completion") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"checkpoint":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxCriticalContinuationQueueWaitMs: 25,
        criticalContinuationQueueWaitLogMs: 10,
        log: () => {},
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=held-completion",
    );
    await firstStarted;

    let checkpointSettled = false;
    const checkpoint = request(
      port(proxy),
      body(2, "loop:checkpoint"),
      "/api/mcp?client=queued-loop-checkpoint",
    ).then((result) => {
      checkpointSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(checkpointSettled).toBe(false);
    expect(hits).toEqual(["held-completion"]);

    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationQueue).toMatchObject({
      waiting: 1,
      max: 1,
      maxWaitMs: 25,
      requests: [
        expect.objectContaining({
          tools: ["loop:checkpoint"],
          maxWaitMs: 0,
        }),
      ],
    });

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await checkpoint).status).toBe(200);
    expect(hits).toEqual(["held-completion", "queued-loop-checkpoint"]);
  });

  it("EI-22728723476698098: pure improvements:capture bypasses a held shared continuation lane", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-completion") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"captured":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxImprovementsCaptureQueue: 1,
        criticalContinuationQueueWaitLogMs: 20,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=held-completion",
    );
    await firstStarted;

    const capture = await request(
      port(proxy),
      body(2, "improvements:capture"),
      "/api/mcp?client=priority-capture",
    );
    expect(capture.status).toBe(200);
    expect(hits).toEqual(["held-completion", "priority-capture"]);
    // The capture must reach the upstream while the shared continuation write is still held.
    // This is the regression that the old priority waiter could not satisfy.
    expect(capture.body).toContain("captured");
    expect(
      logs.some((line) => line.includes("queued critical-continuation request")),
    ).toBe(false);

    releaseFirst();
    expect((await first).status).toBe(200);
    expect(hits).toEqual([
      "held-completion",
      "priority-capture",
    ]);
  });

  it("keeps independent improvements:capture forwards concurrent within the reserved control-plane budget", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-capture") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"captured":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 2,
        maxCriticalContinuationQueue: 1,
        maxImprovementsCaptureQueue: 1,
        improvementsCaptureQueueWaitMs: 100,
      }),
    );
    await listen(proxy);

    const body = (id: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "improvements:capture", arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1),
      "/api/mcp?client=held-capture",
    );
    try {
      await firstStarted;
      const second = request(
        port(proxy),
        body(2),
        "/api/mcp?client=parallel-capture",
      );

      // With the former hard-coded one-socket cap, the second capture waited in the
      // FIFO and could not reach the upstream until the first completed.
      await waitFor(() => hits.includes("parallel-capture"));
      expect(hits).toEqual(["held-capture", "parallel-capture"]);
      const health = JSON.parse(
        (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
      ) as { inFlight?: { improvementsCaptureMax?: number } };
      expect(health.inFlight?.improvementsCaptureMax).toBe(2);

      releaseFirst();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
    } finally {
      releaseFirst();
      await first.catch(() => undefined);
    }
  });

  it("routes read-only improvements:capture duplicate checks through reserved control-plane capacity", async () => {
    let releaseCapture: () => void = () => {};
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let noteCaptureStarted: () => void = () => {};
    const captureStarted = new Promise<void>((resolve) => {
      noteCaptureStarted = resolve;
    });
    const hits: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-capture") {
          noteCaptureStarted();
          void captureGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"checked":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxImprovementsCaptureQueue: 1,
        improvementsCaptureQueueWaitMs: 100,
      }),
    );
    await listen(proxy);

    const directCheck = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "improvements:capture",
        arguments: {
          title: "duplicate probe",
          kind: "bug",
          checkDuplicatesOnly: true,
        },
      },
    });
    const invokedCheck = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "tools:invoke",
        arguments: {
          name: "improvements:capture",
          args: {
            title: "duplicate probe via invoke",
            kind: "bug",
            checkDuplicatesOnly: true,
          },
        },
      },
    });
    const heldCapture = request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "improvements:capture",
          arguments: { title: "slow persisted capture", kind: "bug" },
        },
      }),
      "/api/mcp?client=held-capture",
    );
    const pendingChecks: Array<Promise<unknown>> = [];
    try {
      await captureStarted;
      const direct = request(
        port(proxy),
        directCheck,
        "/api/mcp?client=direct-dedup-check",
      );
      const invoked = request(
        port(proxy),
        invokedCheck,
        "/api/mcp?client=invoke-dedup-check",
      );
      pendingChecks.push(direct, invoked);

      await waitFor(
        () =>
          hits.includes("direct-dedup-check") &&
          hits.includes("invoke-dedup-check"),
      );
      expect(hits).toEqual([
        "held-capture",
        "direct-dedup-check",
        "invoke-dedup-check",
      ]);
      expect((await direct).status).toBe(200);
      expect((await invoked).status).toBe(200);
    } finally {
      releaseCapture();
      await Promise.allSettled([heldCapture, ...pendingChecks]);
    }
    expect((await heldCapture).status).toBe(200);
  });

  it("WI-950869: gives the dedicated improvements:capture queue a finite default dwell", async () => {
    expect(DEFAULT_CRITICAL_CONTINUATION_QUEUE_WAIT_MS).toBe(0);
    expect(DEFAULT_IMPROVEMENTS_CAPTURE_QUEUE_WAIT_MS).toBe(20_000);
    expect(DEFAULT_IMPROVEMENTS_CAPTURE_QUEUE_WAIT_MS).toBeLessThan(60_000);

    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-capture") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"captured":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxImprovementsCaptureQueue: 1,
        criticalContinuationQueueWaitLogMs: 20,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "improvements:capture"),
      "/api/mcp?client=held-capture",
    );
    await firstStarted;

    const capture = request(
      port(proxy),
      body(2, "improvements:capture"),
      "/api/mcp?client=default-capture",
    );
    await waitFor(() =>
      logs.some((line) =>
        line.includes("queued improvements:capture request"),
      ),
    );

    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationQueue.waiting).toBe(0);
    expect(health.inFlight.improvementsCaptureQueue).toMatchObject({
      waiting: 1,
      max: 1,
      maxWaitMs: DEFAULT_IMPROVEMENTS_CAPTURE_QUEUE_WAIT_MS,
      requests: [
        expect.objectContaining({
          tools: ["improvements:capture"],
          maxWaitMs: DEFAULT_IMPROVEMENTS_CAPTURE_QUEUE_WAIT_MS,
        }),
      ],
    });

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await capture).status).toBe(200);
    expect(hits).toEqual(["held-capture", "default-capture"]);
  });

  it("EI-25799962570390054: toolFailure captures bypass ordinary saturation with bounded waiters", async () => {
    let releaseNormal: () => void = () => {};
    const normalGate = new Promise<void>((resolve) => {
      releaseNormal = resolve;
    });
    let releaseFailure: () => void = () => {};
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let noteNormalStarted: () => void = () => {};
    const normalStarted = new Promise<void>((resolve) => {
      noteNormalStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-normal") {
          noteNormalStarted();
          void normalGate.then(() => res.end('{"result":{"captured":true}}'));
          return;
        }
        if (client === "held-tool-failure") {
          void failureGate.then(() => res.end('{"result":{"captured":true}}'));
          return;
        }
        res.end('{"result":{"captured":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxImprovementsCaptureQueue: 1,
        improvementsCaptureQueueWaitMs: 100,
        criticalContinuationQueueWaitLogMs: 10,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, args: Record<string, unknown>) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "improvements:capture", arguments: args },
      });
    const deferredToolFailureBody = (id: number, stringifyArgs = false) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "tools:invoke",
          arguments: {
            name: "improvements:capture",
            args: stringifyArgs
              ? JSON.stringify({
                  toolFailure: {
                    toolName: "storage:usage",
                    message: "The read exceeded its request deadline.",
                  },
                })
              : {
                  toolFailure: {
                    toolName: "storage:usage",
                    message: "The read exceeded its request deadline.",
                  },
                },
          },
        },
      });
    let normal: ReturnType<typeof request> | null = null;
    let failure: ReturnType<typeof request> | null = null;
    let queuedFailure: ReturnType<typeof request> | null = null;
    let queuedFailureSecond: ReturnType<typeof request> | null = null;
    try {
      normal = request(
        port(proxy),
        body(1, { title: "ordinary capture" }),
        "/api/mcp?client=held-normal",
      );
      await normalStarted;

      failure = request(
        port(proxy),
        // ptool's tools:invoke transport stringifies the nested args object;
        // this must still enter the dedicated toolFailure lane.
        deferredToolFailureBody(2, true),
        "/api/mcp?client=held-tool-failure",
      );
      await waitFor(() => hits.includes("held-tool-failure"));

      let queuedFailureSettled = false;
      queuedFailure = request(
        port(proxy),
        body(3, {
          toolFailure: {
            toolName: "work_items:get",
            message: "A second failure needs a durable record.",
          },
        }),
        "/api/mcp?client=queued-tool-failure",
      ).then((result) => {
        queuedFailureSettled = true;
        return result;
      });
      let queuedFailureSecondSettled = false;
      queuedFailureSecond = request(
        port(proxy),
        body(5, {
          toolFailure: {
            toolName: "coord:inbox",
            message: "A third failure needs a durable record.",
          },
        }),
        "/api/mcp?client=queued-tool-failure-second",
      ).then((result) => {
        queuedFailureSecondSettled = true;
        return result;
      });
      await waitFor(
        () =>
          logs.filter((line) =>
            line.includes("queued improvements:capture request"),
          ).length >= 2,
      );

      const health = JSON.parse(
        (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
      ) as {
        inFlight: {
          improvementsCaptureToolFailureMax: number;
          improvementsCaptureQueue: {
            waiting: number;
            toolFailureMax: number;
            waiterCapacity: number;
            requests: Array<{ maxWaitMs: number; toolFailureCapture?: boolean }>;
          };
        };
      };
      expect(health.inFlight.improvementsCaptureQueue).toMatchObject({
        waiting: 2,
        toolFailureMax: 2,
        waiterCapacity: 3,
        requests: [
          expect.objectContaining({ maxWaitMs: 45_000, toolFailureCapture: true }),
          expect.objectContaining({ maxWaitMs: 45_000, toolFailureCapture: true }),
        ],
      });
      expect(health.inFlight.improvementsCaptureToolFailureMax).toBe(1);

      const overflowFailure = await request(
        port(proxy),
        body(4, {
          toolFailure: {
            toolName: "dev:pg_query",
            message: "Another native-session-verifier auth failure needs a record.",
          },
        }),
        "/api/mcp?client=overflow-tool-failure",
      );
      expect(overflowFailure.status).toBe(429);
      const overflowBody = JSON.parse(overflowFailure.body) as {
        error: string;
        detail: string;
        forwardingResult: string;
      };
      expect(overflowBody).toMatchObject({
        error: "mcp_proxy_improvements_capture_queue_full",
        forwardingResult: "not_forwarded",
      });
      expect(overflowBody.detail).toContain(
        "tool-failure FIFO already has 2 waiter(s) (queue max 2)",
      );
      expect(hits).toEqual(["held-normal", "held-tool-failure"]);

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(queuedFailureSettled).toBe(false);
      expect(queuedFailureSecondSettled).toBe(false);

      releaseFailure();
      await waitFor(() => hits.includes("queued-tool-failure"));
      expect((await queuedFailure).status).toBe(200);
      await waitFor(() => hits.includes("queued-tool-failure-second"));
      expect((await queuedFailureSecond).status).toBe(200);
      releaseNormal();
      expect((await failure).status).toBe(200);
      expect((await normal).status).toBe(200);
    } finally {
      releaseFailure();
      releaseNormal();
      await Promise.all(
        [normal, failure, queuedFailure, queuedFailureSecond]
          .filter((pending): pending is ReturnType<typeof request> => pending !== null)
          .map((pending) => pending.catch(() => undefined)),
      );
    }
  });

  it("WI-950869: expires the dedicated improvements:capture queue at its configured finite dwell", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const logFile = path.join(
      os.tmpdir(),
      `mcp-proxy-capture-queue-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const previousLogFile = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    let releaseFirst: () => void = () => {};
    let first: ReturnType<typeof request> | null = null;
    try {
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let noteFirstStarted: () => void = () => {};
      const firstStarted = new Promise<void>((resolve) => {
        noteFirstStarted = resolve;
      });
      const hits: string[] = [];
      const logs: string[] = [];
      const holderTraceIds: string[] = [];
      const upstream = track(
        http.createServer((req, res) => {
          const client =
            new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
              "client",
            ) ?? "";
          hits.push(client);
          if (client === "held-capture") {
            holderTraceIds.push(
              String(req.headers[MCP_PROXY_TRACE_HEADER] ?? ""),
            );
            noteFirstStarted();
            void firstGate.then(() => res.end('{"result":{"held":true}}'));
            return;
          }
          res.end('{"result":{"captured":true}}');
        }),
      );
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 1_000,
          maxInFlight: 10,
          controlPlaneReserve: 1,
          maxCriticalContinuationQueue: 1,
          maxImprovementsCaptureQueue: 1,
          improvementsCaptureQueueWaitMs: 100,
          criticalContinuationQueueWaitLogMs: 10,
          log: (line) => logs.push(line),
        }),
      );
      await listen(proxy);

      const body = (id: number, name: string) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: {} },
        });
      first = request(
        port(proxy),
        body(1, "improvements:capture"),
        "/api/mcp?client=held-capture",
      );
      await firstStarted;

      const capture = request(
        port(proxy),
        body(2, "improvements:capture"),
        "/api/mcp?client=short-capture",
      );
      await waitFor(() => logs.some((line) => line.includes("still queued")));

      const expired = await capture;
      expect(expired.status).toBe(429);
      const shed = JSON.parse(expired.body) as {
        error: string;
        retryAfterSec: number;
        forwardingResult: string;
        blockedBy?: { tools: string[]; ageMs: number; traceId: string };
      };
      expect(shed).toMatchObject({
        error: "mcp_proxy_improvements_capture_queue_dwell",
        retryAfterSec: 2,
        forwardingResult: "not_forwarded",
        blockedBy: {
          tools: ["improvements:capture"],
          traceId: holderTraceIds[0],
        },
      });
      expect(expired.headers["retry-after"]).toBe(String(shed.retryAfterSec));
      expect(shed.blockedBy?.ageMs).toBeGreaterThanOrEqual(0);
      expect(hits).toEqual(["held-capture"]);

      releaseFirst();
      expect((await first).status).toBe(200);

      const retry = await request(
        port(proxy),
        body(3, "improvements:capture"),
        "/api/mcp?client=retry-after-release",
      );
      expect(retry.status).toBe(200);
      expect(hits).toEqual(["held-capture", "retry-after-release"]);

      const records = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              kind?: string;
              blockedBy?: { tools: string[]; ageMs: number; traceId: string };
            },
        );
      const waitRecord = records.find(
        (record) => record.kind === "improvements_capture_queue_wait",
      );
      const shedRecord = records.find(
        (record) => record.kind === "shed_improvements_capture_queue_dwell",
      );
      const expectedBlocker = {
        tools: ["improvements:capture"],
        traceId: holderTraceIds[0],
      };
      expect(waitRecord?.blockedBy).toMatchObject(expectedBlocker);
      expect(waitRecord?.blockedBy?.ageMs).toBeGreaterThanOrEqual(0);
      expect(shedRecord?.blockedBy).toMatchObject(expectedBlocker);
      expect(shedRecord?.blockedBy?.ageMs).toBeGreaterThanOrEqual(0);
    } finally {
      releaseFirst();
      if (first) await first.catch(() => undefined);
      fs.rmSync(logFile, { force: true });
      if (previousLogFile === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = previousLogFile;
    }
  });

  it("EI-22090638969690024: names the holder that head-of-line blocks a critical dwell shed", async () => {
    let releaseHolder: () => void = () => {};
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let noteHolderStarted: () => void = () => {};
    const holderStarted = new Promise<void>((resolve) => {
      noteHolderStarted = resolve;
    });
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        if (client === "slow-loop-end") {
          noteHolderStarted();
          void holderGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"captured":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 4,
        maxCriticalContinuationQueueWaitMs: 25,
        criticalContinuationQueueWaitLogMs: 10,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    // `loop:end` is non-expiring, so it holds the single durability socket until it answers.
    const holder = request(
      port(proxy),
      body(1, "loop:end"),
      "/api/mcp?client=slow-loop-end",
    );
    await holderStarted;

    // The lifecycle REST write carries a finite generic dwell, so its shed must attribute itself
    // to the holder, not to queue depth. `work_items:checkpoint` is intentionally non-expiring;
    // pure `improvements:capture` uses its dedicated lane.
    const lifecycle = request(
      port(proxy),
      body(2, "work_items:checkpoint"),
      "/api/agent-mcp/console/bootstrap-su/session-ended?client=blocked-lifecycle",
    );
    await waitFor(() =>
      logs.some((line) => line.includes("queued critical-continuation request")),
    );

    const expired = await lifecycle;
    expect(expired.status).toBe(429);
    const shed = JSON.parse(expired.body) as {
      error: string;
      detail: string;
      blockedBy?: { tools: string[]; ageMs: number; traceId: string };
    };
    expect(shed.error).toBe("mcp_proxy_critical_continuation_queue_dwell");
    // The FIFO was empty behind this waiter: without the holder identity the shed would read
    // as "nothing was in the way", which is what made this class look like a broken transport.
    expect(shed.detail).toContain("0 other waiter(s)");
    expect(shed.blockedBy?.tools).toEqual(["loop:end"]);
    expect(shed.blockedBy?.ageMs).toBeGreaterThanOrEqual(0);
    expect(typeof shed.blockedBy?.traceId).toBe("string");
    expect(shed.detail).toContain("head-of-line blocked by loop:end");

    releaseHolder();
    expect((await holder).status).toBe(200);
  });

  it("WI-950869: honors an explicit zero improvements:capture dwell override", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-capture") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"captured":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxImprovementsCaptureQueue: 1,
        maxCriticalContinuationQueueWaitMs: 25,
        improvementsCaptureQueueWaitMs: 0,
        criticalContinuationQueueWaitLogMs: 10,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "improvements:capture"),
      "/api/mcp?client=held-capture",
    );
    await firstStarted;

    let captureSettled = false;
    const capture = request(
      port(proxy),
      body(2, "improvements:capture"),
      "/api/mcp?client=zero-capture",
    ).then((result) => {
      captureSettled = true;
      return result;
    });
    await waitFor(() =>
      logs.some((line) => line.includes("queued improvements:capture request")),
    );
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(captureSettled).toBe(false);
    expect(hits).toEqual(["held-capture"]);
    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationQueue.waiting).toBe(0);
    expect(health.inFlight.improvementsCaptureQueue).toMatchObject({
      waiting: 1,
      max: 1,
      maxWaitMs: 0,
      requests: [
        expect.objectContaining({
          tools: ["improvements:capture"],
          maxWaitMs: 0,
        }),
      ],
    });

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await capture).status).toBe(200);
    expect(hits).toEqual(["held-capture", "zero-capture"]);
  });

  it("EI-21598376721192513: does not expire queued work_items:complete at a finite continuation dwell boundary", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-completion") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"completed":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxCriticalContinuationQueueWaitMs: 25,
        criticalContinuationQueueWaitLogMs: 10,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "work_items:complete", arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1),
      "/api/mcp?client=held-completion",
    );
    await firstStarted;

    let completionSettled = false;
    const queuedCompletion = request(
      port(proxy),
      body(2),
      "/api/mcp?client=queued-completion",
    ).then((result) => {
      completionSettled = true;
      return result;
    });
    await waitFor(() =>
      logs.some((line) =>
        line.includes("queued critical-continuation request"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(completionSettled).toBe(false);
    expect(hits).toEqual(["held-completion"]);
    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationQueue).toMatchObject({
      waiting: 1,
      max: 1,
      maxWaitMs: 25,
      requests: [expect.objectContaining({ tools: ["work_items:complete"] })],
    });

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await queuedCompletion).status).toBe(200);
    expect(hits).toEqual(["held-completion", "queued-completion"]);
  });

  it("EI-21567903270684307: does not expire queued loop:end at a finite continuation dwell boundary", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-continuation") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"loopEnded":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxCriticalContinuationQueueWaitMs: 25,
        criticalContinuationQueueWaitLogMs: 10,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=held-continuation",
    );
    await firstStarted;

    let loopEndSettled = false;
    const loopEnd = request(
      port(proxy),
      body(2, "loop:end"),
      "/api/mcp?client=queued-loop-end",
    ).then((result) => {
      loopEndSettled = true;
      return result;
    });
    await waitFor(() =>
      logs.some((line) =>
        line.includes("queued critical-continuation request"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(loopEndSettled).toBe(false);
    expect(hits).toEqual(["held-continuation"]);
    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationQueue).toMatchObject({
      waiting: 1,
      max: 1,
      maxWaitMs: 25,
      requests: [expect.objectContaining({ tools: ["loop:end"] })],
    });

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await loopEnd).status).toBe(200);
    expect(hits).toEqual(["held-continuation", "queued-loop-end"]);
  });

  it("EI-21582773337412658: does not expire queued session:request-compaction at a finite continuation dwell boundary", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-continuation") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"compacted":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxCriticalContinuationQueueWaitMs: 25,
        criticalContinuationQueueWaitLogMs: 10,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=held-continuation",
    );
    await firstStarted;

    let compactionSettled = false;
    const compaction = request(
      port(proxy),
      body(2, "session:request-compaction"),
      "/api/mcp?client=queued-compaction",
    ).then((result) => {
      compactionSettled = true;
      return result;
    });
    await waitFor(() =>
      logs.some((line) =>
        line.includes("queued critical-continuation request"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(compactionSettled).toBe(false);
    expect(hits).toEqual(["held-continuation"]);
    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationQueue).toMatchObject({
      waiting: 1,
      max: 1,
      maxWaitMs: 25,
      requests: [
        expect.objectContaining({ tools: ["session:request-compaction"] }),
      ],
    });

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await compaction).status).toBe(200);
    expect(hits).toEqual(["held-continuation", "queued-compaction"]);
  });

  it("EI-21565454839253843: does not expire a checkpoint behind a long completion by default", async () => {
    // A real work_items:complete held the single critical slot for 61.8s while the old
    // 30s dwell shed a queued checkpoint. The queue itself is hard-bounded, so a client
    // disconnect is the safe cancellation boundary and a default dwell expiry is not.
    expect(DEFAULT_CRITICAL_CONTINUATION_QUEUE_WAIT_MS).toBe(0);

    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "long-completion") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"complete":true}}'));
          return;
        }
        res.end('{"result":{"checkpoint":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        criticalContinuationQueueWaitLogMs: 20,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=long-completion",
    );
    await firstStarted;

    let checkpointSettled = false;
    const checkpoint = request(
      port(proxy),
      body(2, "work_items:checkpoint"),
      "/api/mcp?client=queued-checkpoint",
    ).then((result) => {
      checkpointSettled = true;
      return result;
    });
    await waitFor(() =>
      logs.some((line) =>
        line.includes("queued critical-continuation request"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(checkpointSettled).toBe(false);
    expect(hits).toEqual(["long-completion"]);

    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationQueue).toMatchObject({
      waiting: 1,
      max: 1,
      maxWaitMs: 0,
      requests: [expect.objectContaining({ tools: ["work_items:checkpoint"] })],
    });

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await checkpoint).status).toBe(200);
    expect(hits).toEqual(["long-completion", "queued-checkpoint"]);
  });

  it("EI-22476972244692928: does not expire queued work_items:checkpoint at a finite continuation dwell boundary", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "held-checkpoint") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"held":true}}'));
          return;
        }
        res.end('{"result":{"checkpoint":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxCriticalContinuationQueueWaitMs: 25,
        criticalContinuationQueueWaitLogMs: 10,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=held-checkpoint",
    );
    await firstStarted;

    let checkpointSettled = false;
    const checkpoint = request(
      port(proxy),
      body(2, "work_items:checkpoint"),
      "/api/mcp?client=queued-checkpoint",
    ).then((result) => {
      checkpointSettled = true;
      return result;
    });
    await waitFor(() =>
      logs.some((line) =>
        line.includes("queued critical-continuation request"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(checkpointSettled).toBe(false);
    expect(hits).toEqual(["held-checkpoint"]);
    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.criticalContinuationQueue).toMatchObject({
      waiting: 1,
      max: 1,
      maxWaitMs: 25,
      requests: [
        expect.objectContaining({
          tools: ["work_items:checkpoint"],
          maxWaitMs: 0,
        }),
      ],
    });

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await checkpoint).status).toBe(200);
    expect(hits).toEqual(["held-checkpoint", "queued-checkpoint"]);
  });

  it("BYOC P-004: disjoint work-item continuations bypass a slow completion while same-item writes stay ordered", async () => {
    let releaseItemA: () => void = () => {};
    const itemAGate = new Promise<void>((resolve) => {
      releaseItemA = resolve;
    });
    let noteItemAStarted: () => void = () => {};
    const itemAStarted = new Promise<void>((resolve) => {
      noteItemAStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "item-a-completion") {
          noteItemAStarted();
          void itemAGate.then(() => res.end('{"result":{"complete":true}}'));
          return;
        }
        res.end('{"result":{"ok":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        // The existing reserve is the disjoint-continuation budget: two keys may run,
        // without adding or widening a P-004-specific static cap.
        controlPlaneReserve: 2,
        maxCriticalContinuationQueue: 1,
        maxCriticalContinuationQueueWaitMs: 1_000,
        criticalContinuationQueueWaitLogMs: 10,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string, args: object) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
    const itemACompletion = request(
      port(proxy),
      body(1, "work_items:complete", {
        id: "WI-A",
        completion: { summary: "held" },
      }),
      "/api/mcp?client=item-a-completion",
    );
    await itemAStarted;

    // A queued same-item request that disconnects never reaches the upstream.
    const cancelledItemA = http.request({
      host: "127.0.0.1",
      port: port(proxy),
      method: "POST",
      path: "/api/mcp?client=item-a-cancelled",
    });
    const cancelledOutcome = new Promise<"response" | "error" | "closed">(
      (resolve) => {
        cancelledItemA.once("response", (response) => {
          response.resume();
          resolve("response");
        });
        cancelledItemA.once("error", () => resolve("error"));
        cancelledItemA.once("close", () => resolve("closed"));
      },
    );
    cancelledItemA.end(
      body(2, "work_items:checkpoint", {
        id: "WI-A",
        checkpoint: "cancel me before forwarding",
      }),
    );
    await waitFor(() =>
      logs.some((line) =>
        line.includes("queued critical-continuation request"),
      ),
    );
    cancelledItemA.destroy();
    expect(await cancelledOutcome).not.toBe("response");
    await new Promise((resolve) => setTimeout(resolve, 25));

    let sameItemSettled = false;
    const queuedItemA = request(
      port(proxy),
      body(3, "work_items:checkpoint", {
        id: "WI-A",
        checkpoint: "must follow completion",
      }),
      "/api/mcp?client=item-a-queued",
    ).then((result) => {
      sameItemSettled = true;
      return result;
    });
    await waitFor(
      () =>
        logs.filter((line) =>
          line.includes("queued critical-continuation request"),
        ).length >= 2,
    );

    // The bounded same-key queue tells the caller this later mutation was not forwarded.
    const overflow = await request(
      port(proxy),
      body(4, "work_items:checkpoint", {
        id: "WI-A",
        checkpoint: "must not enter a full same-key queue",
      }),
      "/api/mcp?client=item-a-overflow",
    );
    expect(overflow.status).toBe(429);
    expect(JSON.parse(overflow.body)).toMatchObject({
      error: "mcp_proxy_critical_continuation_queue_full",
      forwardingResult: "not_forwarded",
    });

    // A different work-item key uses spare capacity immediately; the ordinary claim path
    // remains responsive on its existing reserved-control-plane route too.
    const unrelatedCheckpoint = await Promise.race([
      request(
        port(proxy),
        body(5, "work_items:checkpoint", {
          id: "WI-B",
          checkpoint: "unrelated continuation",
        }),
        "/api/mcp?client=item-b-checkpoint",
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    expect(unrelatedCheckpoint?.status).toBe(200);
    const unrelatedClaim = await Promise.race([
      request(
        port(proxy),
        body(6, "work_items:claim", { row: "WI-B,self" }),
        "/api/mcp?client=item-b-claim",
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    expect(unrelatedClaim?.status).toBe(200);
    expect(sameItemSettled).toBe(false);
    expect(hits).toEqual([
      "item-a-completion",
      "item-b-checkpoint",
      "item-b-claim",
    ]);

    releaseItemA();
    expect((await itemACompletion).status).toBe(200);
    expect((await queuedItemA).status).toBe(200);
    expect(hits).toEqual([
      "item-a-completion",
      "item-b-checkpoint",
      "item-b-claim",
      "item-a-queued",
    ]);
    expect(hits).not.toContain("item-a-cancelled");
    expect(hits).not.toContain("item-a-overflow");
  }, 10_000);

  it("EI-21568557856490825: reconciliation reads bypass a saturated continuation FIFO", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let noteFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      noteFirstStarted = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "critical-first") {
          noteFirstStarted();
          void firstGate.then(() => res.end('{"result":{"complete":true}}'));
          return;
        }
        res.end('{"result":{"read":true}}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        maxCriticalContinuationQueue: 1,
        maxCriticalContinuationQueueWaitMs: 1_000,
        criticalContinuationQueueWaitLogMs: 20,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = (id: number, name: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    const first = request(
      port(proxy),
      body(1, "work_items:complete"),
      "/api/mcp?client=critical-first",
    );
    await firstStarted;
    const queued = request(
      port(proxy),
      body(2, "work_items:checkpoint"),
      "/api/mcp?client=queued-checkpoint",
    );
    await waitFor(() =>
      logs.some((line) =>
        line.includes("queued critical-continuation request"),
      ),
    );

    const reconciliationRead = await Promise.race([
      request(
        port(proxy),
        body(3, "work_items:get"),
        "/api/mcp?client=reconciliation-read",
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    expect(reconciliationRead?.status).toBe(200);
    expect(hits).toEqual(["critical-first", "reconciliation-read"]);

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await queued).status).toBe(200);
    expect(hits).toEqual([
      "critical-first",
      "reconciliation-read",
      "queued-checkpoint",
    ]);
  });

  it("EI-21395173692390816: admits a bounded FIFO handshake queue and sheds only once it is full", async () => {
    const handshakeLimit = 2;
    const queueLimit = 2;
    let releaseInitial: () => void = () => {};
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const hits: number[] = [];
    const logs: string[] = [];
    let initialStarted: () => void = () => {};
    const initialStartedGate = new Promise<void>((resolve) => {
      initialStarted = resolve;
    });
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        const id = Number(client.replace("handshake-", ""));
        hits.push(id);
        if (hits.length === handshakeLimit) initialStarted();
        if (hits.length <= handshakeLimit) {
          void initialGate.then(() =>
            res.end(JSON.stringify({ result: { id } })),
          );
          return;
        }
        res.end(JSON.stringify({ result: { id } }));
      }),
    );
    await listen(upstream);

    const controlPlaneAgent = new http.Agent({
      keepAlive: false,
      maxSockets: handshakeLimit,
    });
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 2_000,
        retryBackoffMs: 5,
        handshakeTimeoutMs: 5_000,
        maxInFlight: 20,
        controlPlaneReserve: handshakeLimit,
        controlPlaneAgent,
        maxHandshakeInFlight: handshakeLimit,
        maxHandshakeQueue: queueLimit,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const initial = [
      request(port(proxy), body, "/api/mcp?client=handshake-1"),
      request(port(proxy), body, "/api/mcp?client=handshake-2"),
    ];
    await initialStartedGate;

    const queued = [
      request(port(proxy), body, "/api/mcp?client=handshake-3"),
      request(port(proxy), body, "/api/mcp?client=handshake-4"),
    ];
    await waitFor(
      () =>
        logs.filter((line) => line.includes("queued session handshake"))
          .length >= queueLimit,
    );

    const overflow = await request(
      port(proxy),
      body,
      "/api/mcp?client=handshake-5",
    );
    expect(overflow.status).toBe(429);
    expect(JSON.parse(overflow.body).error).toBe(
      "mcp_proxy_handshake_overloaded",
    );
    expect(hits).toHaveLength(handshakeLimit);

    releaseInitial();
    const results = await Promise.all([...initial, ...queued]);
    controlPlaneAgent.destroy();

    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(hits.slice(handshakeLimit)).toEqual([3, 4]);
  }, 10_000);

  it("EI-21395173692390816: cancels a queued handshake when its client disconnects", async () => {
    let releaseInitial: () => void = () => {};
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "handshake-1") {
          void initialGate.then(() => res.end('{"result":"first"}'));
          return;
        }
        res.end('{"result":"unexpected"}');
      }),
    );
    await listen(upstream);

    const controlPlaneAgent = new http.Agent({
      keepAlive: false,
      maxSockets: 1,
    });
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 2_000,
        retryBackoffMs: 5,
        handshakeTimeoutMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        controlPlaneAgent,
        maxHandshakeInFlight: 1,
        maxHandshakeQueue: 1,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const first = request(port(proxy), body, "/api/mcp?client=handshake-1");
    await waitFor(() => hits.length === 1);

    const queuedClient = http.request({
      host: "127.0.0.1",
      port: port(proxy),
      method: "POST",
      path: "/api/mcp?client=handshake-2",
    });
    const queuedOutcome = new Promise<"response" | "error" | "closed">(
      (resolve) => {
        queuedClient.once("response", (response) => {
          response.resume();
          resolve("response");
        });
        queuedClient.once("error", () => resolve("error"));
        queuedClient.once("close", () => resolve("closed"));
      },
    );
    queuedClient.end(body);
    await waitFor(() =>
      logs.some((line) => line.includes("queued session handshake")),
    );
    queuedClient.destroy();
    expect(await queuedOutcome).not.toBe("response");

    releaseInitial();
    expect((await first).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controlPlaneAgent.destroy();

    expect(hits).toEqual(["handshake-1"]);
  }, 10_000);

  it("EI-21504897841052086: sheds a queued handshake with 429 once its queue dwell expires", async () => {
    let releaseInitial: () => void = () => {};
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "handshake-1") {
          void initialGate.then(() => res.end('{"result":"first"}'));
          return;
        }
        res.end('{"result":"unexpected"}');
      }),
    );
    await listen(upstream);

    const controlPlaneAgent = new http.Agent({
      keepAlive: false,
      maxSockets: 1,
    });
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 2_000,
        retryBackoffMs: 5,
        handshakeTimeoutMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        controlPlaneAgent,
        maxHandshakeInFlight: 1,
        maxHandshakeQueue: 1,
        maxHandshakeQueueWaitMs: 150,
        handshakeQueueWaitLogMs: 40,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const first = request(port(proxy), body, "/api/mcp?client=handshake-1");
    await waitFor(() => hits.length === 1);

    const queued = request(port(proxy), body, "/api/mcp?client=handshake-2");
    await waitFor(() =>
      logs.some((line) => line.includes("queued session handshake")),
    );

    const expired = await queued;
    expect(expired.status).toBe(429);
    expect(JSON.parse(expired.body).error).toBe(
      "mcp_proxy_handshake_queue_dwell",
    );
    expect(logs.some((line) => line.includes(`exceeded ${150}ms`))).toBe(true);

    releaseInitial();
    expect((await first).status === 200).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controlPlaneAgent.destroy();

    // The expired waiter never reached upstream, and expiring it freed the FIFO slot.
    expect(hits).toEqual(["handshake-1"]);
  }, 10_000);

  it("EI-21504897841052086: a still-queued handshake emits periodic dwell telemetry while it waits", async () => {
    let releaseInitial: () => void = () => {};
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        if (client === "handshake-1") {
          void initialGate.then(() => res.end('{"result":"first"}'));
          return;
        }
        res.end('{"result":"unexpected"}');
      }),
    );
    await listen(upstream);

    const controlPlaneAgent = new http.Agent({
      keepAlive: false,
      maxSockets: 1,
    });
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 2_000,
        retryBackoffMs: 5,
        handshakeTimeoutMs: 1_000,
        maxInFlight: 10,
        controlPlaneReserve: 1,
        controlPlaneAgent,
        maxHandshakeInFlight: 1,
        maxHandshakeQueue: 1,
        maxHandshakeQueueWaitMs: 0, // expiry disabled — telemetry only
        handshakeQueueWaitLogMs: 30,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const first = request(port(proxy), body, "/api/mcp?client=handshake-1");
    await waitFor(() => hits.length === 1);

    const queued = request(port(proxy), body, "/api/mcp?client=handshake-2");
    await waitFor(
      () => logs.filter((line) => line.includes("still queued")).length >= 2,
    );

    releaseInitial();
    expect((await queued).status).toBe(200);
    expect((await first).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controlPlaneAgent.destroy();

    expect(hits).toEqual(["handshake-1", "handshake-2"]);
  }, 10_000);

  it("EI-21395173692390816: queued grants preserve the global hard cap while ordinary traffic is held", async () => {
    let releaseHandshake: () => void = () => {};
    let releaseOrdinary: () => void = () => {};
    const handshakeGate = new Promise<void>((resolve) => {
      releaseHandshake = resolve;
    });
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    const hits: string[] = [];
    const logs: string[] = [];
    let active = 0;
    let maxActive = 0;
    let firstHandshakeStarted: () => void = () => {};
    const firstHandshakeGate = new Promise<void>((resolve) => {
      firstHandshakeStarted = resolve;
    });
    let secondHandshakeStarted: () => void = () => {};
    const secondHandshakeGate = new Promise<void>((resolve) => {
      secondHandshakeStarted = resolve;
    });
    const upstream = track(
      http.createServer((req, res) => {
        const client =
          new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(
            "client",
          ) ?? "";
        hits.push(client);
        active++;
        maxActive = Math.max(maxActive, active);
        res.once("close", () => {
          active = Math.max(0, active - 1);
        });
        if (client === "handshake-1") {
          firstHandshakeStarted();
          void handshakeGate.then(() => res.end('{"result":"handshake-1"}'));
        } else if (client === "handshake-2") {
          secondHandshakeStarted();
          res.end('{"result":"handshake-2"}');
        } else if (client.startsWith("ordinary-")) {
          void ordinaryGate.then(() => res.end('{"result":"ordinary"}'));
        } else {
          res.end('{"result":"unexpected"}');
        }
      }),
    );
    await listen(upstream);

    const controlPlaneAgent = new http.Agent({
      keepAlive: false,
      maxSockets: 1,
    });
    // Let the fixture reach the proxy's global ceiling (one held handshake + two ordinary
    // forwards). The proxy's maxInFlight:3, rather than the test agent, is the hard cap under test.
    const upstreamAgent = new http.Agent({ keepAlive: false, maxSockets: 3 });
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 10_000,
        retryBackoffMs: 5,
        handshakeTimeoutMs: 5_000,
        maxInFlight: 3,
        controlPlaneReserve: 0,
        controlPlaneAgent,
        upstreamAgent,
        maxHandshakeInFlight: 1,
        maxHandshakeQueue: 1,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const handshakeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    // Keep the competing traffic genuinely ordinary. `work_items:list` is a reserved
    // control-plane tool and would share the one-socket controlPlaneAgent with handshake-1,
    // making it impossible for both ordinary hits to reach the upstream before release.
    const ordinaryBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: "test://ordinary" },
    });
    expect(isReservedControlPlaneCall(Buffer.from(ordinaryBody))).toBe(false);
    const firstHandshake = request(
      port(proxy),
      handshakeBody,
      "/api/mcp?client=handshake-1",
    );
    await firstHandshakeGate;
    const secondHandshake = request(
      port(proxy),
      handshakeBody,
      "/api/mcp?client=handshake-2",
    );
    await waitFor(() =>
      logs.some((line) => line.includes("queued session handshake")),
    );

    const ordinary = [
      request(port(proxy), ordinaryBody, "/api/mcp?client=ordinary-1"),
      request(port(proxy), ordinaryBody, "/api/mcp?client=ordinary-2"),
    ];
    await waitFor(
      () => hits.includes("ordinary-1") && hits.includes("ordinary-2"),
    );
    expect(active).toBe(3);

    releaseHandshake();
    await secondHandshakeGate;
    expect(maxActive).toBeLessThanOrEqual(3);

    releaseOrdinary();
    const results = await Promise.all([
      firstHandshake,
      secondHandshake,
      ...ordinary,
    ]);
    controlPlaneAgent.destroy();
    upstreamAgent.destroy();

    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(3);
  }, 10_000);

  it("shouldShedForInFlight — sheds at the ceiling, never before it (pure)", () => {
    expect(shouldShedForInFlight(4, 5)).toBe(false);
    expect(shouldShedForInFlight(5, 5)).toBe(true);
    expect(shouldShedForInFlight(500, 5)).toBe(true);
  });

  it("shouldShedForInFlight — maxInFlight <= 0 disables shedding entirely (explicit opt-out)", () => {
    expect(shouldShedForInFlight(1_000_000, 0)).toBe(false);
    expect(shouldShedForInFlight(1_000_000, -1)).toBe(false);
  });

  it("has a bounded, non-Infinity default so shedding is not opt-in by accident", () => {
    expect(DEFAULT_MAX_IN_FLIGHT).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_IN_FLIGHT)).toBe(true);
    expect(DEFAULT_MAX_HANDSHAKES_IN_FLIGHT).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_HANDSHAKES_IN_FLIGHT)).toBe(true);
    expect(DEFAULT_MAX_HANDSHAKE_QUEUE).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_HANDSHAKE_QUEUE)).toBe(true);
    expect(DEFAULT_MAX_ORDINARY_QUEUE).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_ORDINARY_QUEUE)).toBe(true);
  });

  it("EI-21656350947178031: default durability FIFO covers the proxy admission population", () => {
    expect(DEFAULT_MAX_CRITICAL_CONTINUATION_QUEUE).toBeGreaterThanOrEqual(
      DEFAULT_MAX_IN_FLIGHT,
    );
  });

  it("EI-21395174573687098: uses the full reserved pool because the watchdog has a separate agent", () => {
    expect(DEFAULT_MAX_HANDSHAKES_IN_FLIGHT).toBe(
      Math.max(1, DEFAULT_CONTROL_PLANE_RESERVE),
    );
  });

  it("sheds an EXCESS request with 429 the instant maxInFlight is reached, and admits the rest once slots free up", async () => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = track(
      http.createServer((_req, res) => {
        void gate.then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":"held-then-ok"}');
        });
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        // This case isolates the hard maxInFlight ceiling. The production default
        // reserves control-plane slots, which would intentionally lower the ordinary
        // admission ceiling below 2 and make the second filler request shed instead.
        retryWindowMs: 5_000,
        retryBackoffMs: 20,
        maxInFlight: 2,
        controlPlaneReserve: 0,
        maxOrdinaryQueue: 0,
        log: () => {},
      }),
    );
    await listen(proxy);

    // Fill the 2-slot budget with requests the (gated) upstream will not answer yet.
    const ordinaryCall = '{"method":"tools/call","params":{"name":"unit:hold"}}';
    const held1 = request(port(proxy), ordinaryCall);
    const held2 = request(port(proxy), ordinaryCall);
    await new Promise((r) => setTimeout(r, 80)); // let both register as in-flight

    const shed = await request(port(proxy), ordinaryCall);
    expect(shed.status).toBe(429);
    const shedBody = JSON.parse(shed.body);
    expect(shedBody).toMatchObject({
      ok: false,
      error: "mcp_proxy_overloaded",
      retryable: true,
    });
    expect(shedBody.retryAfterSec).toBe(MAX_SHED_RETRY_AFTER_SEC);
    expect(shed.headers["retry-after"]).toBe(String(shedBody.retryAfterSec));

    releaseUpstream();
    const [r1, r2] = await Promise.all([held1, held2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // The slots freed on completion — a NEW request now succeeds instead of shedding.
    const after = await request(port(proxy), '{"jsonrpc":"2.0"}');
    // upstream still answers 200 immediately post-gate-release for any further hits.
    expect([200, 429]).toContain(after.status);
  });

  it("EI-25792330557867199: queues an ordinary request FIFO and forwards it after a slot opens", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted: () => void = () => {};
    const firstStartedGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const logs: string[] = [];
    const hits: number[] = [];
    const upstream = track(
      http.createServer((_req, res) => {
        hits.push(hits.length + 1);
        if (hits.length === 1) {
          firstStarted();
          void firstGate.then(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"result":"first"}');
          });
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"queued"}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 2_000,
        retryBackoffMs: 5,
        maxInFlight: 1,
        controlPlaneReserve: 0,
        maxOrdinaryQueue: 1,
        maxOrdinaryQueueWaitMs: 2_000,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const ordinaryCall =
      '{"method":"tools/call","params":{"name":"unit:ordinary"}}';
    const first = request(port(proxy), ordinaryCall);
    await firstStartedGate;
    const queued = request(port(proxy), ordinaryCall);
    await waitFor(() =>
      logs.some((line) => line.includes("queued ordinary request")),
    );

    releaseFirst();
    const [firstResult, queuedResult] = await Promise.all([first, queued]);
    expect(firstResult.status).toBe(200);
    expect(queuedResult.status).toBe(200);
    expect(hits).toEqual([1, 2]);
  }, 10_000);

  it("EI-25792330557867199: hard-bounds the ordinary FIFO and reports local overload as not forwarded", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted: () => void = () => {};
    const firstStartedGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const logs: string[] = [];
    let hits = 0;
    const upstream = track(
      http.createServer((_req, res) => {
        hits++;
        if (hits === 1) {
          firstStarted();
          void firstGate.then(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"result":"first"}');
          });
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"queued"}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 2_000,
        retryBackoffMs: 5,
        maxInFlight: 1,
        controlPlaneReserve: 0,
        maxOrdinaryQueue: 1,
        maxOrdinaryQueueWaitMs: 2_000,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const ordinaryCall =
      '{"method":"tools/call","params":{"name":"unit:ordinary"}}';
    const first = request(port(proxy), ordinaryCall);
    await firstStartedGate;
    const queued = request(port(proxy), ordinaryCall);
    await waitFor(() =>
      logs.some((line) => line.includes("queued ordinary request")),
    );

    const overflow = await request(port(proxy), ordinaryCall);
    expect(overflow.status).toBe(429);
    expect(JSON.parse(overflow.body)).toMatchObject({
      error: "mcp_proxy_overloaded",
      retryable: true,
      forwardingResult: "not_forwarded",
    });
    expect(overflow.headers["retry-after"]).toBeTruthy();
    expect(hits).toBe(1);

    releaseFirst();
    const [firstResult, queuedResult] = await Promise.all([first, queued]);
    expect(firstResult.status).toBe(200);
    expect(queuedResult.status).toBe(200);
    expect(hits).toBe(2);
  }, 10_000);

  it("EI-25792330557867199: exposes ordinary FIFO size and waiter age in local health", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted: () => void = () => {};
    const firstStartedGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const logs: string[] = [];
    const upstream = track(
      http.createServer((_req, res) => {
        firstStarted();
        void firstGate.then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":"ok"}');
        });
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 2_000,
        retryBackoffMs: 5,
        maxInFlight: 1,
        controlPlaneReserve: 0,
        maxOrdinaryQueue: 2,
        maxOrdinaryQueueWaitMs: 2_000,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const ordinaryCall =
      '{"method":"tools/call","params":{"name":"unit:ordinary"}}';
    const first = request(port(proxy), ordinaryCall);
    await firstStartedGate;
    const queued = request(port(proxy), ordinaryCall);
    await waitFor(() =>
      logs.some((line) => line.includes("queued ordinary request")),
    );

    const health = JSON.parse(
      (await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body,
    );
    expect(health.inFlight.ordinaryQueue).toMatchObject({
      waiting: 1,
      max: 2,
      maxWaitMs: 2_000,
      grantReservations: 0,
    });
    expect(health.inFlight.ordinaryQueue.oldestAgeMs).toEqual(
      expect.any(Number),
    );
    expect(health.inFlight.ordinaryQueue.requests).toHaveLength(1);
    expect(health.inFlight.ordinaryQueue.requests[0]).toMatchObject({
      maxWaitMs: 2_000,
      ageMs: expect.any(Number),
    });

    releaseFirst();
    const [firstResult, queuedResult] = await Promise.all([first, queued]);
    expect(firstResult.status).toBe(200);
    expect(queuedResult.status).toBe(200);
  }, 10_000);

  it("maxInFlight:0 (explicit) never sheds, even with many concurrent holds", async () => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = track(
      http.createServer((_req, res) => {
        void gate.then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":"ok"}');
        });
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 20,
        maxInFlight: 0,
        log: () => {},
      }),
    );
    await listen(proxy);

    const pending = [
      request(port(proxy)),
      request(port(proxy)),
      request(port(proxy)),
      request(port(proxy)),
    ];
    await new Promise((r) => setTimeout(r, 80));
    releaseUpstream();
    const results = await Promise.all(pending);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe("EI-19305299022434394: heartbeat — logs while a forward is held open (kills the silence)", () => {
  it("emits a heartbeat log line + durable record while a forward is outstanding, none once it completes", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const logFile = path.join(
      os.tmpdir(),
      `mcp-proxy-heartbeat-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const prev = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    try {
      let releaseUpstream: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseUpstream = resolve;
      });
      const upstream = track(
        http.createServer((_req, res) => {
          void gate.then(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"result":"ok"}');
          });
        }),
      );
      await listen(upstream);
      const logs: string[] = [];
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 30_000,
          retryBackoffMs: 20,
          heartbeatIntervalMs: 30,
          log: (s) => logs.push(s),
        }),
      );
      await listen(proxy);

      const pending = request(port(proxy));
      await new Promise((r) => setTimeout(r, 140)); // several 30ms heartbeat ticks while held open
      releaseUpstream();
      const r = await pending;
      expect(r.status).toBe(200);

      expect(
        logs.some((l) => l.includes("heartbeat") && l.includes("in flight")),
      ).toBe(true);
      const recs = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const beat = recs.find((x) => x.kind === "heartbeat");
      expect(beat).toBeTruthy();
      expect(beat.inFlight).toBeGreaterThanOrEqual(1);
      expect(typeof beat.oldestAgeMs).toBe("number");
      fs.rmSync(logFile, { force: true });
    } finally {
      if (prev === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = prev;
    }
  });

  it("EI-19388661789704364: a burst of many FAST (short-lived) overlapping requests never beats — only a genuinely long-held one does", async () => {
    // Reproduces the measured production defect: zero `heartbeat` records across a 30h+/27MB
    // ledger despite `shed_max_in_flight` proving real concurrency spikes occurred. A sampled
    // periodic tick can miss every one of many short overlapping holds by bad luck; the
    // per-request threshold timer must not — it fires only for a request that outlives the
    // interval, regardless of how many fast neighbors it had.
    const upstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"ok"}');
      }),
    );
    await listen(upstream);
    const logs: string[] = [];
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 20,
        heartbeatIntervalMs: 500,
        log: (s) => logs.push(s),
      }),
    );
    await listen(proxy);

    // A burst of fast requests, each completing well under the 500ms heartbeat threshold
    // (generous headroom for a loaded CI/fleet box) — none of these should ever produce a
    // heartbeat, however many overlap at once.
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([
        request(port(proxy)),
        request(port(proxy)),
        request(port(proxy)),
      ]);
    }
    expect(logs.some((l) => l.includes("heartbeat"))).toBe(false);
  });

  it("heartbeatIntervalMs:0 disables the beat entirely (opt-out, no timer leak)", async () => {
    const upstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"ok"}');
      }),
    );
    await listen(upstream);
    const logs: string[] = [];
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 20,
        heartbeatIntervalMs: 0,
        log: (s) => logs.push(s),
      }),
    );
    await listen(proxy);
    const r = await request(port(proxy));
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 50));
    expect(logs.some((l) => l.includes("heartbeat"))).toBe(false);
  });
});

describe("EI-19305299022434394: maxHoldMs — a real tools/call is no longer literally unbounded", () => {
  const A_TOOLS_CALL =
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{}}}';

  it("an OPAQUE tools/call that stalls past maxHoldMs surfaces honestly (502) instead of hanging forever", async () => {
    const upstream = track(
      http.createServer(() => {
        /* accept + say nothing, forever */
      }),
    );
    await listen(upstream);
    const prevKeying = process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY;
    process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY = "0"; // force 'opaque' so the ceiling is isolated from the retry
    try {
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: "127.0.0.1",
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          retryBackoffMs: 10,
          maxHoldMs: 60,
          log: () => {},
        }),
      );
      await listen(proxy);

      const started = Date.now();
      const r = await request(port(proxy), A_TOOLS_CALL);
      const elapsed = Date.now() - started;
      expect(r.status).toBe(502); // bounded: an honest error the caller can act on
      // The whole point: the ceiling actually cut the hold short, well under the retry window.
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      if (prevKeying === undefined)
        delete process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY;
      else process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY = prevKeying;
    }
  });

  it("a KEYED tools/call that hits the hold ceiling surfaces 502 without overlapping the still-running write", async () => {
    let hits = 0;
    const upstream = track(
      http.createServer((req, res) => {
        hits++;
        if (hits === 1) return; // first attempt: silent until maxHoldMs fires
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":"recovered-after-hold-ceiling"}');
        });
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 10,
        maxHoldMs: 60,
        log: () => {},
      }),
    );
    await listen(proxy);

    const r = await request(port(proxy), A_TOOLS_CALL);
    expect(r.status).toBe(502);
    expect(r.body).toContain("mcp_proxy_upstream_error");
    expect(hits).toBe(1); // never overlaps the first still-running tools/call
  });

  it("does NOT bound a tools/call by DEFAULT — the generous default ceiling leaves a normal slow tool untouched", async () => {
    // Anti-regression companion to the WI-6740 default-unbounded test: confirm the new ceiling
    // (default ~10 min) does not shrink the effective budget for an ordinary slow call.
    const upstream = track(
      http.createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":"slow-but-fine"}');
        }, 300);
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 20,
        log: () => {}, // maxHoldMs unset → generous default
      }),
    );
    await listen(proxy);
    const r = await request(port(proxy), A_TOOLS_CALL);
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"slow-but-fine"}');
  });

  it("maxHoldMs:0 (explicit) restores literally-unbounded behavior for a tools/call", async () => {
    const upstream = track(
      http.createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"result":"still-fine"}');
        }, 120);
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        retryBackoffMs: 20,
        maxHoldMs: 0,
        log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(port(proxy), A_TOOLS_CALL);
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"still-fine"}');
  });
});
