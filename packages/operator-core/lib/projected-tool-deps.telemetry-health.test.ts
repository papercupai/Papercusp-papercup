/**
 * EI-7431 — telemetry flush failures must be visible outside the console.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@papercusp/flags/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFlag: vi.fn(async () => false),
}));
vi.mock("@papercusp/testing-shell/llm", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOverride: vi.fn(() => undefined),
}));
vi.mock("./decision-ledger/emit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordDecisionLedger: vi.fn(),
}));
vi.mock("./agent-tools/coordination/dispatch-heartbeat", () => ({
  maybeBeatPresenceOnDispatch: vi.fn(),
}));
vi.mock("./sync-sse", () => ({
  notifySyncInvalidate: vi.fn(async () => {}),
}));

const failingBegin = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(async () => {
    throw new Error("telemetry insert exploded");
  }),
);

vi.mock("@papercusp/db-org", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({
    sql: {
      begin: failingBegin,
    },
    db: {
      insert: () => ({
        values: vi.fn(async () => {}),
      }),
    },
  }),
}));

import {
  __resetTelemetryHealthForTests,
  flushPendingTelemetry,
  getTelemetryHealth,
  PROJECTED_DEPS,
} from "./projected-tool-deps";
import {
  __resetSessionSurfaces,
  getSessionSurface,
  getSessionUsedTools,
  restoreSessionTools,
  sessionToolSurfaceKey,
} from "./endpoint-route/routes/transport/tool-allowlist";

const ctx = (overrides: Record<string, unknown> = {}) =>
  ({
    workspaceId: "ws-test",
    harnessSlug: "papercusp",
    role: "worker",
    spawnId: "s-test",
    log: vi.fn(),
    ...overrides,
  }) as never;

function record(toolName: string, context = ctx()): Promise<void> | void {
  return PROJECTED_DEPS.recordInvocation!({
    toolName,
    pluginName: "agent-mcp",
    ctx: context,
    windowKey: "w1",
    durationMs: 3,
    status: "ok",
    args: { a: 1 },
  } as never);
}

describe("telemetry health counters (EI-7431)", () => {
  beforeEach(() => {
    __resetTelemetryHealthForTests();
    __resetSessionSurfaces();
    failingBegin.mockReset().mockRejectedValue(new Error("telemetry insert exploded"));
  });

  afterEach(async () => {
    await flushPendingTelemetry().catch(() => {});
    __resetTelemetryHealthForTests();
  });

  it("counts swallowed telemetry insert failures and stamps the last failure time", async () => {
    // WI-2995: the flush path intentionally console.warns on a swallowed
    // insert failure (that's what this test exercises) — spy it so the
    // expected warning doesn't trip vitest's fail-on-console.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getTelemetryHealth()).toEqual({
      droppedRows: 0,
      insertErrorCount: 0,
      lastInsertErrorAt: null,
      frictionSkippedCount: 0,
      frictionErrorCount: 0,
    });

    await record("x:one");
    await flushPendingTelemetry();

    const health = getTelemetryHealth();
    expect(failingBegin).toHaveBeenCalledTimes(1);
    expect(health.droppedRows).toBe(0);
    expect(health.insertErrorCount).toBe(1);
    expect(Date.parse(health.lastInsertErrorAt ?? "")).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
  });

  it("retains nested settled tool use while an unrelated telemetry transaction is stalled", async () => {
    const seed = new Set(["tools:invoke"]);
    const owner = "su-telemetry-stall";
    const key = sessionToolSurfaceKey(owner, "ws-test")!;
    const otherOwner = sessionToolSurfaceKey("su-other", "ws-test")!;
    const otherWorkspace = sessionToolSurfaceKey(owner, "ws-other")!;
    for (const surface of [key, otherOwner, otherWorkspace]) getSessionSurface(surface, seed);
    const restore = () => restoreSessionTools({ sessionKey: key, seed, ownerId: owner,
      workspaceId: "ws-test", readUsedTools: async () => [] });
    await expect(restore()).resolves.toBe(false);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    failingBegin.mockImplementation(async () => { entered(); await blocked; });
    await record("unrelated:tool");
    const flushing = flushPendingTelemetry();
    await started;
    try {
      await record("plans:get", ctx({ uiClientId: owner, isSuperuser: true }));
      await expect(restore()).resolves.toBe(true);
      await expect(restore()).resolves.toBe(false);
      expect(getSessionSurface(key, seed)).toEqual(new Set(["tools:invoke", "plans:get"]));
      expect(getSessionUsedTools(key)).toEqual(new Set(["plans:get"]));
      expect(getSessionUsedTools(otherOwner)?.size).toBe(0);
      expect(getSessionUsedTools(otherWorkspace)?.size).toBe(0);
      expect(getSessionSurface(otherOwner, seed)?.has("plans:get")).toBe(false);
      expect(getSessionSurface(otherWorkspace, seed)?.has("plans:get")).toBe(false);
      expect(failingBegin).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await flushing;
    }
  });
});
