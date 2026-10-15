/**
 * service_health.test.ts — the dev:service_health HANDLER (probeAll mocked). Thin, but
 * pins that the on-demand probe result is surfaced under { ok:true, services }. A
 * regression that drops the services payload is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/dev/service_health.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../service-health", () => ({
  probeAll: vi.fn(),
  probeMcpHandshake: vi.fn(),
  supervisedProcesses: vi.fn(() => []),
  // reconcileBgHostTicker (EI-19934795546523351) reads this literal — mirror the
  // real service-health.ts constant rather than importOriginal (avoids pulling in
  // that module's own DB/coord-transitive imports at test time).
  PORTLESS_PROBE_NAMES: {
    desktop: "desktop",
    bgHostTicker: "bg-host-ticker",
    bgHostCode: "bg-host-code",
    substrateSidecar: "substrate-sidecar",
    embedSidecar: "embed-sidecar",
  },
}));
// EI-13221: probeServiceStart shells out to `systemctl`/`ps` — stub it so the
// handler tests never touch the real OS; default "not determinable" (ok:false)
// means the new restart-recency overlay is a no-op unless a test opts in.
vi.mock("./systemd-service-probe", () => ({
  probeServiceStart: vi.fn(async () => ({ ok: false })),
  probeUnitStates: vi.fn(),
}));
vi.mock("../../projected-tool-deps", () => ({
  getTelemetryHealth: vi.fn(() => ({
    droppedRows: 2,
    insertErrorCount: 1,
    lastInsertErrorAt: "2026-07-05T15:00:00.000Z",
  })),
}));
// WI-6149: PARTIAL mock. `supervisionSnapshot` is stubbed (it reads the
// reconciler's module singleton), but `isActiveStateDown` must be the REAL
// implementation — it is the shared down-or-not oracle the overlay now calls, and
// stubbing it would let the tool and the reconciler drift apart again, which is
// the precise defect that oracle was extracted to prevent.
vi.mock("../../supervision/unit-reconciler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../supervision/unit-reconciler")>()),
  // EI-20093902925801178: `flapObserved` distinguishes "these counters measured
  // something" from "these counters are zero-defaults". mcp-proxy is modelled as
  // OBSERVED (a process that runs the reconciler), so its zeros are real and no
  // caveat note is expected. The two node-child sidecars are legitimately
  // un-observed by this reconciler — their real respawn state arrives via
  // `overlayNodeChildSupervision` — which is exactly the case the note must NOT
  // fire for, or the flag becomes noise readers learn to ignore.
  supervisionSnapshot: vi.fn(() => [
    { name: "mcp-proxy", layer: "systemd-user", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok", flapObserved: true },
    { name: "substrate-sidecar", layer: "node-child", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok", flapObserved: false },
    { name: "spawner-sidecar", layer: "node-child", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok", flapObserved: false },
  ]),
}));
vi.mock("../../sync/hyperbee/substrate-sidecar-spawn", () => ({
  substrateSidecarSupervisionStatus: vi.fn(() => ({ running: true, respawnAttemptsInWindow: 2, gaveUp: false, lastRespawnScheduledAt: 1000 })),
}));
vi.mock("../../fleet/spawner-sidecar-spawn", () => ({
  spawnerSidecarSupervisionStatus: vi.fn(() => ({ running: false, respawnAttemptsInWindow: 5, gaveUp: true, lastRespawnScheduledAt: 2000 })),
}));
// WI-10005995: the isolated-DHT probe reads systemd, /proc and the lock store — stubbed here
// (its own logic is pinned in dht-universe-probe.test.ts); this suite pins how the handler
// SURFACES its verdict. Default null = systemd unreadable, the no-verdict case.
vi.mock("./dht-universe-probe", () => ({
  probeProductHostDhtUniverse: vi.fn(async () => null),
  dhtUniverseNextVerb: vi.fn((unit: string) => `fix-dht:${unit}`),
}));

import { probeAll, probeMcpHandshake } from "../../service-health";
import { mockResolvedOnceTyped, mockResolvedTyped } from "../../testing/typed-mock";
import { getTelemetryHealth } from "../../projected-tool-deps";
import { supervisionSnapshot } from "../../supervision/unit-reconciler";
import { substrateSidecarSupervisionStatus } from "../../sync/hyperbee/substrate-sidecar-spawn";
import { spawnerSidecarSupervisionStatus } from "../../fleet/spawner-sidecar-spawn";
import { probeUnitStates } from "./systemd-service-probe";
import { probeProductHostDhtUniverse } from "./dht-universe-probe";
import {
  buildMcpProxyTransportBlock,
  buildServiceHealthDiagnostic,
  overlayNodeChildSupervision,
  overlaySystemdRestartRecency,
  reconcileBootingHttpServices,
  reconcileBgHostTicker,
  BG_HOST_BOOT_GRACE_SEC,
  bgHostWatchdogOwnership,
  BG_HOST_WATCHDOG_UNIT,
  type SupervisionStatusEntryWithRecency,
} from "./service_health";

/** Fixed clock for the transport-block tests — the summarizer windows on it. */
const NOW_MS = Date.parse("2026-08-02T12:00:00.000Z");
const probeM = vi.mocked(probeAll);
const unitM = vi.mocked(probeUnitStates);
const dhtM = vi.mocked(probeProductHostDhtUniverse);
const mcpHandshakeM = vi.mocked(probeMcpHandshake);
const supervisionM = vi.mocked(supervisionSnapshot);
const substrateM = vi.mocked(substrateSidecarSupervisionStatus);
const spawnerM = vi.mocked(spawnerSidecarSupervisionStatus);
const tool = (await import("./service_health")).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  // The fleet test lane inherits the bg-host's opt-in environment. Pin this
  // handler suite to its request-only default; pure overlay tests pass the
  // environment they intend explicitly below.
  vi.stubEnv("PAPERCUSP_SPAWNER_SIDECAR", "0");
  vi.stubEnv("PAPERCUSP_SPAWNER_SIDECAR_MODE", "0");
  dhtM.mockResolvedValue(null);
  mcpHandshakeM.mockResolvedValue({
    ok: true,
    latencyMs: 3,
    status: 200,
    protocolVersion: "2025-06-18",
    url: "http://127.0.0.1:3070/api/mcp?client=mcp-health",
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("dev:service_health handler", () => {
  it("starts fixed and supervision probes while a requested unit read is still pending", async () => {
    let resolveUnits!: (value: Awaited<ReturnType<typeof probeUnitStates>>) => void;
    unitM.mockReturnValueOnce(new Promise((resolve) => { resolveUnits = resolve; }));
    probeM.mockResolvedValue([{ name: "operator", up: true, latencyMs: 1, status: 200 }]);

    const response = tool.handler({ units: ["papercusp-staging-api"], scope: "user" } as never, {} as never);
    expect(probeM).toHaveBeenCalledTimes(1);
    expect(mcpHandshakeM).toHaveBeenCalledTimes(1);
    resolveUnits({ states: [], unitsUnknown: ["papercusp-staging-api.service"], scopesUnavailable: [] });
    const result = body((await response) as Out);
    expect(result.unitsUnknown).toEqual(["papercusp-staging-api.service"]);
  });

  it("unitsOnly returns requested unit state without waiting for unrelated snapshot probes", async () => {
    unitM.mockResolvedValueOnce({
      states: [],
      unitsUnknown: ["papercup-staging-sync.service"],
      scopesUnavailable: [],
    });

    const result = body((await tool.handler({
      units: ["papercup-staging-sync"],
      scope: "user",
      unitsOnly: true,
    } as never, {} as never)) as Out);

    expect(result).toMatchObject({
      ok: true,
      snapshotMode: "units-only",
      unitStates: [],
      unitsUnknown: ["papercup-staging-sync.service"],
      healthPhaseTimingsMs: { requestedUnitStates: expect.any(Number) },
    });
    expect(unitM).toHaveBeenCalledWith(["papercup-staging-sync"], "user");
    expect(probeM).not.toHaveBeenCalled();
    expect(mcpHandshakeM).not.toHaveBeenCalled();
    expect(supervisionM).not.toHaveBeenCalled();
    expect(dhtM).not.toHaveBeenCalled();
    expect(getTelemetryHealth).not.toHaveBeenCalled();
  });

  it("requires at least one systemd unit for unitsOnly", () => {
    const args = (tool as unknown as { args: { safeParse(value: unknown): { success: boolean } } }).args;
    expect(args.safeParse({ unitsOnly: true }).success).toBe(false);
  });

  it("opts out of the ambient workspace transaction because health probes are DB-independent", () => {
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it("declares the optional systemd query fields in its machine-readable result schema", () => {
    const shape = (tool as unknown as { result: { shape: Record<string, unknown> } }).result.shape;
    expect(shape).toHaveProperty("unitStates");
    expect(shape).toHaveProperty("unitsUnknown");
    expect(shape).toHaveProperty("scopesUnavailable");
  });

  it("keeps ptool JSON responses parseable when the service snapshot exceeds the result door", () => {
    expect((tool as { skipResultDoor?: string }).skipResultDoor).toBe("programmatic-caller");
  });

  it("documents the canonical staging unit read after dev:restart", () => {
    const when = (tool as { guidance?: { when?: string } }).guidance?.when ?? "";
    expect(when).toContain('dev:restart { target:"staging" }');
    expect(when).toContain('dev:service_health { units:["papercusp-staging-api"], scope:"user", unitsOnly:true }');
  });

  it("surfaces the probe snapshot under { ok, services }", async () => {
    probeM.mockResolvedValue([
      { name: "operator", up: true, latencyMs: 12 },
      { name: "desktop", present: false },
    ] as never);
    const b = body((await tool.handler({} as never, {} as never)) as Out);
    expect(b).toMatchObject({
      ok: true,
      mcpHandshake: {
        ok: true,
        latencyMs: 3,
        status: 200,
        protocolVersion: "2025-06-18",
      },
      services: [
        { name: "operator", up: true, latencyMs: 12 },
        { name: "desktop", present: false },
      ],
      telemetry: {
        droppedRows: 2,
        insertErrorCount: 1,
        lastInsertErrorAt: "2026-07-05T15:00:00.000Z",
      },
      supervision: [
        { name: "mcp-proxy", layer: "systemd-user", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" },
        // P-006: the node-child entries get OVERLAID with the sidecars' own respawn
        // status (mocked above) instead of the reconciler's all-zero defaults.
        { name: "substrate-sidecar", layer: "node-child", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: 1000, restartsLast10m: 2, flapState: "damping" },
        { name: "spawner-sidecar", layer: "node-child", autoRestart: true, criticality: "important", consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" },
      ],
      configured: {
        services: ["operator", "desktop"],
        supervised: ["mcp-proxy", "substrate-sidecar", "spawner-sidecar"],
      },
      effective: { up: 1, down: 0, absent: 1, supervisionUnhealthy: 1 },
      rootCause: { component: "substrate-sidecar", reason: "supervisor state damping" },
      nextVerb: "dev:processes",
    });
    expect(getTelemetryHealth).toHaveBeenCalledTimes(1);
  });

  it("reports monotonic timings for each handler phase that ran", async () => {
    probeM.mockResolvedValue([{ name: "operator", up: true, latencyMs: 5 }] as never);
    unitM.mockResolvedValue({ states: [], unitsUnknown: [], scopesUnavailable: [] });

    const b = body((await tool.handler({ units: ["papercusp-staging-api"], scope: "user" } as never, {} as never)) as Out);

    expect(b.healthPhaseTimingsMs).toEqual(expect.objectContaining({
      requestedUnitStates: expect.any(Number),
      probeAll: expect.any(Number),
      mcpHandshake: expect.any(Number),
      supervision: expect.any(Number),
      dhtUniverse: expect.any(Number),
    }));
    expect(Object.values(b.healthPhaseTimingsMs).every((duration) => typeof duration === "number" && Number.isFinite(duration) && duration >= 0)).toBe(true);
  });

  it("P-004: folds the additive supervision block without disturbing the pre-existing { ok, services, telemetry } shape", async () => {
    probeM.mockResolvedValue([{ name: "operator", up: true, latencyMs: 5 }] as never);
    const b = body((await tool.handler({} as never, {} as never)) as Out);
    // Old shape (pre-P-004 consumers) still parses unchanged.
    expect(b.ok).toBe(true);
    expect(b.services).toEqual([{ name: "operator", up: true, latencyMs: 5 }]);
    expect(b.telemetry).toBeDefined();
    // New, additive field.
    expect(supervisionM).toHaveBeenCalledTimes(1);
    expect(substrateM).toHaveBeenCalledTimes(1);
    expect(spawnerM).toHaveBeenCalledTimes(1);
    expect(b.supervision).toHaveLength(3);
  });

  it("surfaces a failed MCP initialize verdict even when the ordinary operator probe is green", async () => {
    probeM.mockResolvedValue([{ name: "operator", up: true, latencyMs: 2 }] as never);
    mcpHandshakeM.mockResolvedValue({
      ok: false,
      latencyMs: 2000,
      url: "http://127.0.0.1:3070/api/mcp?client=mcp-health",
      note: "MCP initialize timed out after 2000ms",
    });

    const b = body((await tool.handler({} as never, {} as never)) as Out);

    expect(b.services).toEqual([{ name: "operator", up: true, latencyMs: 2 }]);
    expect(b.mcpHandshake).toMatchObject({ ok: false, latencyMs: 2000 });
    expect(b.mcpHandshake.note).toMatch(/timed out/);
  });

  it("does not report a stale local spawner give-up on a request-only host without the sidecar opt-in", async () => {
    mockResolvedTyped(probeM, [{ name: "operator", up: true, status: 200, latencyMs: 5 }]);
    const b = body((await tool.handler({} as never, {} as never)) as Out);

    expect(b.supervision.find((entry: { name: string }) => entry.name === "spawner-sidecar")).toMatchObject({
      flapState: "ok",
      restartsLast10m: 0,
      lastRestartAt: null,
    });
    expect(b.effective.supervisionUnhealthy).toBe(1);
    expect(b.evidence.unhealthySupervision.map((entry: { name: string }) => entry.name)).toEqual(["substrate-sidecar"]);
  });

  it("does not recommend restarting staging while its ExecStartPre is still activating", async () => {
    probeM.mockResolvedValue([
      {
        name: "staging-api",
        up: false,
        status: null,
        latencyMs: 3000,
        url: "http://127.0.0.1:3170/api/desktop/version",
        note: "connection refused",
      },
    ]);
    const activatingSupervision: SupervisionStatusEntryWithRecency = {
        name: "staging-api",
        layer: "systemd-user",
        autoRestart: true,
        criticality: "important",
        consecutiveProbeFailures: 0,
        lastRestartAt: null,
        restartsLast10m: 0,
        flapState: "ok",
        flapObserved: true,
        activeState: "activating",
        healthy: true,
    };
    supervisionM.mockReturnValueOnce([activatingSupervision]);

    const b = body((await tool.handler({} as never, {} as never)) as Out);

    expect(b.services).toMatchObject([{ name: "staging-api", up: true, present: false }]);
    expect(b.rootCause).toBeNull();
    expect(b.nextVerb).toBeNull();
    expect(b.effective).toMatchObject({ down: 0 });
  });
});

describe("WI-10005995: isolated-DHT alarm in dev:service_health", () => {
  const BG = "papercusp-bg-host.service";
  const WARNING = `${BG} is off the PUBLIC DHT outside a drill: the running process resolves ISOLATED (PAPERCUSP_DHT_BOOTSTRAP = 172.31.44.1:49838), and no drill holds the hive-git-physical-rig lock.`;
  const isolated = { mode: "isolated" as const, source: "env" as const, bootstrap: "172.31.44.1:49838" };

  it("surfaces the probe block and names an isolated host as the root cause when nothing else is wrong", async () => {
    mockResolvedTyped(probeM, [{ name: "operator", up: true, status: 200, latencyMs: 1 }]);
    supervisionM.mockReturnValueOnce([]);
    mockResolvedOnceTyped(dhtM, {
      rigLockHeld: false,
      hosts: [{ unit: BG, mainPid: 42, running: isolated, configured: isolated, warning: WARNING }],
      warnings: [{ unit: BG, warning: WARNING }],
    });
    const b = body((await tool.handler({} as never, {} as never)) as Out);
    expect(b.dhtUniverse.warnings).toEqual([{ unit: BG, warning: WARNING }]);
    expect(b.rootCause).toEqual({ component: BG, reason: WARNING });
    expect(b.nextVerb).toBe(`fix-dht:${BG}`);
  });

  it("a drill holding the rig lock produces no root cause, while the block still reports the universe", async () => {
    mockResolvedTyped(probeM, [{ name: "operator", up: true, status: 200, latencyMs: 1 }]);
    supervisionM.mockReturnValueOnce([]);
    mockResolvedOnceTyped(dhtM, {
      rigLockHeld: true,
      hosts: [{ unit: BG, mainPid: 42, running: isolated, configured: isolated }],
      warnings: [],
    });
    const b = body((await tool.handler({} as never, {} as never)) as Out);
    expect(b.dhtUniverse).toMatchObject({ rigLockHeld: true, warnings: [] });
    expect(b.rootCause).toBeNull();
    expect(b.nextVerb).toBeNull();
  });

  it("no verdict (systemd unreadable) adds no key and no root cause", async () => {
    mockResolvedTyped(probeM, [{ name: "operator", up: true, status: 200, latencyMs: 1 }]);
    supervisionM.mockReturnValueOnce([]);
    const b = body((await tool.handler({} as never, {} as never)) as Out);
    expect(b).not.toHaveProperty("dhtUniverse");
    expect(b.rootCause).toBeNull();
  });

  it("a probe that throws does not take the rest of the snapshot down", async () => {
    mockResolvedTyped(probeM, [{ name: "operator", up: true, status: 200, latencyMs: 1 }]);
    dhtM.mockRejectedValueOnce(new Error("systemd bus gone"));
    const b = body((await tool.handler({} as never, {} as never)) as Out);
    expect(b.ok).toBe(true);
    expect(b).not.toHaveProperty("dhtUniverse");
  });

  it("a DOWN service outranks the DHT warning as the root cause", () => {
    const out = buildServiceHealthDiagnostic(
      [{ name: "operator", up: false, status: null, latencyMs: 1, note: "connection refused" }] as never,
      [],
      undefined,
      [{ unit: BG, warning: WARNING }],
    );
    expect(out.rootCause).toMatchObject({ component: "operator" });
    expect(out.nextVerb).not.toContain("fix-dht");
  });

  it("passes the probed watchdog liveness through to a bg-host verb (it used to be dropped -> always 'unknown')", async () => {
    mockResolvedTyped(probeM, [{ name: "bg-host-ticker", up: false, status: null, latencyMs: 2, note: "frozen" }]);
    mockResolvedOnceTyped(unitM, {
      states: [{
        unit: `${BG_HOST_WATCHDOG_UNIT}.service`,
        scope: "user",
        known: true,
        loadState: "loaded",
        activeState: "active",
        active: true,
        failed: false,
      }],
      unitsUnknown: [],
      scopesUnavailable: [],
    });
    const b = body((await tool.handler({} as never, {} as never)) as Out);
    expect(b.nextVerb).toMatch(/is RUNNING and OWNS this restart/);
    expect(b.nextVerb).not.toMatch(/could NOT determine/);
  });
});

describe("buildMcpProxyTransportBlock (D-005, pure given an injected reader)", () => {
  const at = (kind: string, extra: Record<string, unknown> = {}) => ({
    ts: new Date(NOW_MS - 60_000).toISOString(),
    kind,
    listenPort: 9071,
    ...extra,
  });

  it("OMITS the key entirely when nothing is notable — a reassuring zero would train the reader to skip it", () => {
    expect(buildMcpProxyTransportBlock(() => [], NOW_MS)).toEqual({});
  });

  it("stays silent on an UNREADABLE ledger rather than asserting a false all-clear", () => {
    expect(buildMcpProxyTransportBlock(() => null, NOW_MS)).toEqual({});
  });

  it("does NOT surface on `recovered` alone — an absorbed deploy blip is the resilience working", () => {
    expect(buildMcpProxyTransportBlock(() => [at("recovered", { status: 200 })], NOW_MS)).toEqual({});
  });

  it("surfaces a handshake stall with a note that refuses the benign reading (WI-6740)", () => {
    const out = buildMcpProxyTransportBlock(() => [at("handshake_timeout_retry")], NOW_MS) as {
      mcpProxyTransport: { handshakeStalls: number; note: string };
    };
    expect(out.mcpProxyTransport.handshakeStalls).toBe(1);
    // The whole point: a survived stall must not read as health.
    expect(out.mcpProxyTransport.note).toMatch(/Not benign/);
    expect(out.mcpProxyTransport.note).toMatch(/tool-dark/);
  });

  it("surfaces hard failures", () => {
    const out = buildMcpProxyTransportBlock(
      () => [at("exhausted_refused", { status: 503 })],
      NOW_MS,
    ) as { mcpProxyTransport: { hardFailures: number } };
    expect(out.mcpProxyTransport.hardFailures).toBe(1);
  });

  it("surfaces only sustained critical-continuation waits to the affected agent", () => {
    expect(
      buildMcpProxyTransportBlock(
        () => [at("critical_continuation_queue_wait", { traceId: "checkpoint-short", waitedMs: 61_800 })],
        NOW_MS,
      ),
    ).toEqual({});
    const out = buildMcpProxyTransportBlock(
      () => [at("critical_continuation_queue_wait", { traceId: "checkpoint-stalled", waitedMs: 701_000 })],
      NOW_MS,
    ) as {
      mcpProxyTransport: {
        criticalContinuationQueueStalls: number;
        criticalContinuationQueueMaxWaitMs: number;
        note: string;
      };
    };
    expect(out.mcpProxyTransport).toMatchObject({
      criticalContinuationQueueStalls: 1,
      criticalContinuationQueueMaxWaitMs: 701_000,
    });
    expect(out.mcpProxyTransport.note).toMatch(/last hour/);
    expect(out.mcpProxyTransport.note).toMatch(/does not establish whether a request remains queued/);
  });

  it("inherits the listenPort:0 exclusion from the shared summarizer — test/sidecar noise never surfaces", () => {
    // ~18% of live ledger records are written by test/sidecar proxies (EI-19388683897769817).
    // This block must not re-implement the filter; it must inherit it by delegating.
    const out = buildMcpProxyTransportBlock(
      () => [
        { ts: new Date(NOW_MS - 60_000).toISOString(), kind: "exhausted_refused", status: 503, listenPort: 0 },
        { ts: new Date(NOW_MS - 60_000).toISOString(), kind: "handshake_timeout_retry", listenPort: 0 },
      ],
      NOW_MS,
    );
    expect(out).toEqual({});
  });
});

describe("buildServiceHealthDiagnostic", () => {
  it("names the first down service and the exact sanctioned recovery verb", () => {
    const out = buildServiceHealthDiagnostic(
      [{ name: "bg-host-ticker", up: false, status: null, latencyMs: 2, note: "routine engine stale" }],
      [],
    );
    expect(out.rootCause).toEqual({ component: "bg-host-ticker", reason: "routine engine stale" });
    // This assertion was `toBe('dev:restart { target:"bg-host" }')` until EI-20065717746825416
    // appended the watchdog-ownership disclosure to every bg-host verb. Its ORIGINAL intent —
    // the verb names the SANCTIONED target (the bg-host, never the :3070 operator) — is what
    // matters and is asserted more strictly than before: it must LEAD with that verb, and must
    // not name the operator restart at all. (The disclosure's own content is guarded by the
    // bgHostWatchdogOwnership suite; duplicating it here would just make this test brittle.)
    expect(out.nextVerb?.startsWith('dev:restart { target:"bg-host" }')).toBe(true);
    expect(out.nextVerb).not.toContain('target:"dev"');
    expect(out.evidence.failures).toHaveLength(1);
  });

  it("treats an intentionally absent desktop as absent, not down", () => {
    const out = buildServiceHealthDiagnostic(
      [{ name: "desktop", up: false, status: null, latencyMs: 1, present: false }],
      [],
    );
    expect(out.effective).toMatchObject({ up: 0, down: 0, absent: 1 });
    expect(out.rootCause).toBeNull();
    expect(out.nextVerb).toBeNull();
  });

  // EI-19465075959589134 — a WEDGED service (listening, not accepting) and a DOWN
  // one need opposite responses, and until now they rendered identically here.
  it("promotes a WEDGE over an ordinary down probe, and counts it separately", () => {
    const out = buildServiceHealthDiagnostic(
      [
        { name: "operator", up: false, status: null, latencyMs: 3, note: "connection refused" },
        {
          name: "staging-api",
          up: false,
          status: null,
          latencyMs: 3000,
          wedged: true,
          acceptQueue: { pending: 97, backlog: 511 },
          note: "WEDGED, not down: 97 connection(s) queued unaccepted",
        },
      ],
      [],
    );
    // Ordering: `operator` failed first, but the wedge is the finding that no other
    // signal on the box will report, so it leads.
    expect(out.rootCause?.component).toBe("staging-api");
    // `down` stays the whole failure count so an existing reader keeps its
    // meaning; `wedged` is the sharper subset.
    expect(out.effective).toMatchObject({ down: 2, wedged: 1 });
    // The restart is still offered — it does recover the service — but it must
    // not read as the fix, because it also destroys the evidence.
    expect(out.nextVerb).toContain('dev:restart { target:"staging" }');
    expect(out.nextVerb).toContain("WEDGE");
    expect(out.nextVerb).toMatch(/logs:read/);
  });

  it("leaves the plain-down verb EXACTLY as it was when nothing is wedged", () => {
    // The wedge branch must not leak prose into the ordinary path — an agent
    // pattern-matching the verb string still gets a clean, runnable verb.
    const out = buildServiceHealthDiagnostic(
      [{ name: "staging-api", up: false, status: null, latencyMs: 2, note: "connection refused" }],
      [],
    );
    expect(out.nextVerb).toBe('dev:restart { target:"staging" }');
    expect(out.effective).toMatchObject({ down: 1, wedged: 0 });
  });

  it("counts an explicit unhealthy systemd verdict even when flapState is an operator-side zero-default", () => {
    const supervision = [
      {
        name: "live-federation-gate",
        layer: "systemd-user" as const,
        autoRestart: false,
        criticality: "important" as const,
        consecutiveProbeFailures: 0,
        lastRestartAt: null,
        restartsLast10m: 0,
        flapState: "ok" as const,
        flapObserved: false,
        active: false,
        activeState: "failed",
        healthy: false,
      },
    ];
    const out = buildServiceHealthDiagnostic([{ name: "operator", up: true, status: null, latencyMs: 1 }], supervision);

    expect(out.effective.supervisionUnhealthy).toBe(1);
    expect(out.evidence.unhealthySupervision).toEqual(supervision);
    expect(out.rootCause).toEqual({ component: "live-federation-gate", reason: "systemd state failed" });
  });
});

describe("reconcileBgHostTicker (EI-19934795546523351, pure)", () => {
  const downTicker = (note = "⚠ no routine has fired in 17m — looks FROZEN") =>
    [{ name: "bg-host-ticker", up: false, status: null, latencyMs: 2, note }];

  it("REPRODUCES THE BUG unfixed: leaves a down ticker alone when there is no supervision entry to reconcile against", () => {
    // Negative control — proves the function does nothing without evidence, rather
    // than always forcing tickerUp:true (which would just be a different lie).
    expect(reconcileBgHostTicker(downTicker(), [])).toEqual(downTicker());
  });

  it("suppresses a DOWN verdict when bg-host restarted inside the boot grace", () => {
    const out = reconcileBgHostTicker(downTicker(), [
      { name: "bg-host", layer: "systemd-user", secondsSinceStart: 7 } as never,
    ]);
    expect(out[0]?.up).toBe(true);
    expect(out[0]?.present).toBe(false); // liveness UNKNOWN, not a fabricated healthy answer
    expect(out[0]?.note).toMatch(/restarted 7s ago/);
    expect(out[0]?.note).toMatch(/booting/i);
  });

  it("does NOT suppress once the restart is older than the boot grace — a real freeze stays reported", () => {
    const out = reconcileBgHostTicker(downTicker(), [
      { name: "bg-host", layer: "systemd-user", secondsSinceStart: BG_HOST_BOOT_GRACE_SEC } as never,
    ]);
    expect(out[0]?.up).toBe(false);
    expect(out[0]?.note).toBe(downTicker()[0]?.note);
  });

  it("is a no-op when the ticker already reports up — nothing to reconcile", () => {
    const upTicker = [{ name: "bg-host-ticker", up: true, status: null, latencyMs: 1 }];
    expect(
      reconcileBgHostTicker(upTicker, [{ name: "bg-host", layer: "systemd-user", secondsSinceStart: 3 } as never]),
    ).toBe(upTicker); // same reference — genuinely untouched
  });

  it("is a no-op when the supervision entry has no secondsSinceStart (probe couldn't determine it)", () => {
    const input = downTicker();
    expect(reconcileBgHostTicker(input, [{ name: "bg-host", layer: "systemd-user" } as never])).toEqual(input);
  });

  // ── THE LIVE INCIDENT, END TO END ─────────────────────────────────────────────
  // The exact contradictory payload measured 2026-08-09 00:50-00:52Z: reconciling
  // must ALSO fix buildServiceHealthDiagnostic's rootCause/nextVerb, since those are
  // computed from the (now-reconciled) services array, not recomputed separately.
  it("once reconciled, buildServiceHealthDiagnostic no longer recommends dev:restart for a booting bg-host", () => {
    const supervision = [{ name: "bg-host", layer: "systemd-user", secondsSinceStart: 7, flapState: "ok" } as never];
    const services = reconcileBgHostTicker(downTicker(), supervision);
    const out = buildServiceHealthDiagnostic(services, supervision);
    expect(out.rootCause).toBeNull();
    expect(out.nextVerb).toBeNull();
    expect(out.effective.down).toBe(0);
  });
});

describe("reconcileBootingHttpServices (EI-22636386056120623, pure)", () => {
  const downStaging = {
    name: "staging-api",
    up: false,
    status: null,
    latencyMs: 3,
    url: "http://127.0.0.1:3170/api/desktop/version",
    note: "connection refused",
  };

  it("treats a refused listener as unknown while its supervised unit is still activating", () => {
    const services = reconcileBootingHttpServices([downStaging], [
      {
        name: "staging-api",
        layer: "systemd-user",
        activeState: "activating",
        healthy: true,
      } as never,
    ]);

    expect(services[0]).toMatchObject({ up: true, present: false });
    expect(services[0]?.note).toMatch(/UNKNOWN/);
    expect(services[0]?.note).toMatch(/activating/);
    expect(buildServiceHealthDiagnostic(services, [])).toMatchObject({
      rootCause: null,
      nextVerb: null,
      effective: { down: 0 },
    });
  });

  it.each(["reloading", "deactivating"] as const)(
    "also suppresses the HTTP outage during a healthy %s transition",
    (activeState) => {
      const [service] = reconcileBootingHttpServices([downStaging], [
        { name: "staging-api", layer: "systemd-user", activeState, healthy: true } as never,
      ]);
      expect(service).toMatchObject({ up: true, present: false });
    },
  );

  it("stops suppressing once systemd is active, so a missing listener remains a real failure", () => {
    const services = reconcileBootingHttpServices([downStaging], [
      { name: "staging-api", layer: "systemd-user", activeState: "active", healthy: true } as never,
    ]);
    expect(services).toEqual([downStaging]);
    expect(buildServiceHealthDiagnostic(services, [])).toMatchObject({
      rootCause: { component: "staging-api" },
      nextVerb: 'dev:restart { target:"staging" }',
      effective: { down: 1 },
    });
  });

  it("does not suppress a terminal systemd failure or a probe without an HTTP URL", () => {
    const failed = reconcileBootingHttpServices([downStaging], [
      { name: "staging-api", layer: "systemd-user", activeState: "failed", healthy: false } as never,
    ]);
    expect(failed).toEqual([downStaging]);

    const portless = reconcileBootingHttpServices(
      [{ ...downStaging, url: undefined }],
      [{ name: "staging-api", layer: "systemd-user", activeState: "activating", healthy: true } as never],
    );
    expect(portless[0]).toEqual({ ...downStaging, url: undefined });
  });
});

/**
 * EI-20065717746825416: `dev:service_health` prescribed `dev:restart{bg-host}` while an
 * out-of-process watchdog already owned that decision — so an agent following the tool's own
 * nextVerb raced a live supervisor, got a phantom-coalesced no-op (EI-11137), and credited
 * itself with the watchdog's recovery. The guard is that a bg-host restart verb can never
 * again be emitted WITHOUT naming its owner.
 */
describe("bgHostWatchdogOwnership (EI-20065717746825416, pure)", () => {
  const downTicker = (note = "⚠ no routine has fired in 21m — looks FROZEN") =>
    [{ name: "bg-host-ticker", up: false, status: null, latencyMs: 2, note }];

  it("names the watchdog as the RUNNING owner and warns off a first-move hand restart", () => {
    const out = bgHostWatchdogOwnership(true);
    expect(out).toContain(BG_HOST_WATCHDOG_UNIT);
    expect(out).toMatch(/OWNS this restart/);
    expect(out).toMatch(/DO NOT restart by hand/i);
  });

  it("discloses the two readings that INVERT — suppression, and un-attributable outcome verification", () => {
    // These are the whole point: both look like the opposite of the truth. A frozen bg-host
    // reads as "no watchdog" when the watchdog is deliberately holding off, and a hand restart
    // reads as "I fixed it" when the watchdog's restart produced the same outcome.
    const out = bgHostWatchdogOwnership(true);
    expect(out).toMatch(/SUPPRESS/i);
    expect(out).toMatch(/NOT evidence/i);
    expect(out).toMatch(/PHANTOM-COALESCE/i);
  });

  it("reports an ABSENT watchdog as a finding in its own right, and then does prescribe the hand restart", () => {
    const out = bgHostWatchdogOwnership(false);
    expect(out).toMatch(/NOT ACTIVE/);
    expect(out).toMatch(/NO automatic recovery/i);
    expect(out).toMatch(/systemctl --user start/);
    // It must NOT tell the agent to stand down when nothing is going to act for it.
    expect(out).not.toMatch(/DO NOT restart by hand/i);
  });

  it("an UNKNOWN liveness discloses ownership WITHOUT asserting the watchdog is up or absent", () => {
    // An unreadable probe must never read as an absence (nor as a live owner) — the same
    // in-band-unknown convention as isActiveStateDown / the portless probes.
    const out = bgHostWatchdogOwnership(undefined);
    expect(out).toContain(BG_HOST_WATCHDOG_UNIT);
    expect(out).toMatch(/could NOT determine/i);
    expect(out).not.toMatch(/is RUNNING and OWNS/);
    expect(out).not.toMatch(/NOT ACTIVE/);
  });

  // ── THE RECURRENCE GUARD ────────────────────────────────────────────────────
  it("REPRODUCES THE BUG unfixed: a frozen ticker's nextVerb never again prescribes a bare restart", () => {
    const out = buildServiceHealthDiagnostic(downTicker(), [], true);
    expect(out.rootCause?.component).toBe("bg-host-ticker");
    // Pre-fix this was exactly 'dev:restart { target:"bg-host" }' and nothing else.
    expect(out.nextVerb).toContain('dev:restart { target:"bg-host" }');
    expect(out.nextVerb).toContain(BG_HOST_WATCHDOG_UNIT);
  });

  it("carries the disclosure with the VERB, not with one probe name — every bg-host component gets it", () => {
    // restartVerbForService routes any name containing 'bg-host' to the bg-host restart, so the
    // caveat has to follow the same predicate; a name that earns the verb but not the caveat is
    // precisely how this gap comes back.
    const out = buildServiceHealthDiagnostic(
      [{ name: "bg-host-code", up: false, status: null, latencyMs: 1, note: "code drift" }],
      [],
      true,
    );
    expect(out.nextVerb).toContain(BG_HOST_WATCHDOG_UNIT);
  });

  it("does NOT leak the bg-host caveat onto an unrelated service's nextVerb", () => {
    const out = buildServiceHealthDiagnostic(
      [{ name: "operator", up: false, status: 500, latencyMs: 3, note: "probe failed" }],
      [],
      true,
    );
    expect(out.nextVerb).toBe('dev:restart { target:"dev" }');
  });

  it("omitting the liveness argument still discloses ownership (unknown), never silence", () => {
    // The old two-arg call shape must not silently reproduce the original bug.
    const out = buildServiceHealthDiagnostic(downTicker(), []);
    expect(out.nextVerb).toContain(BG_HOST_WATCHDOG_UNIT);
  });
});

describe("overlayNodeChildSupervision (P-006, pure)", () => {
  const base = [
    // EI-20093902925801178: mcp-proxy carries REAL reconciler data here (it is
    // damping with a nonzero count), so flapObserved:true. The node-child and
    // desktop-shell rows are legitimately un-tracked by the systemd reconciler —
    // their respawn state is what this overlay is about to supply.
    { name: "mcp-proxy", layer: "systemd-user" as const, autoRestart: true, criticality: "important" as const, consecutiveProbeFailures: 1, lastRestartAt: 999, restartsLast10m: 1, flapState: "damping" as const, flapObserved: true },
    { name: "substrate-sidecar", layer: "node-child" as const, autoRestart: true, criticality: "important" as const, consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" as const, flapObserved: false },
    { name: "spawner-sidecar", layer: "node-child" as const, autoRestart: true, criticality: "important" as const, consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" as const, flapObserved: false },
    { name: "desktop-shell", layer: "desktop-shell" as const, autoRestart: true, criticality: "critical" as const, consecutiveProbeFailures: 0, lastRestartAt: null, restartsLast10m: 0, flapState: "ok" as const, flapObserved: false },
  ];

  it("leaves non-sidecar entries (systemd-user, desktop-shell) completely untouched", () => {
    const out = overlayNodeChildSupervision(
      base,
      { running: true, respawnAttemptsInWindow: 0, gaveUp: false, lastRespawnScheduledAt: null },
      { running: true, respawnAttemptsInWindow: 0, gaveUp: false, lastRespawnScheduledAt: null },
    );
    expect(out[0]).toEqual(base[0]); // mcp-proxy (systemd-user)
    expect(out[3]).toEqual(base[3]); // desktop-shell
  });

  it("overlays substrate-sidecar and spawner-sidecar from their own respawn status", () => {
    const out = overlayNodeChildSupervision(
      base,
      { running: true, respawnAttemptsInWindow: 3, gaveUp: false, lastRespawnScheduledAt: 5000 },
      { running: false, respawnAttemptsInWindow: 6, gaveUp: true, lastRespawnScheduledAt: 9000 },
      { PAPERCUSP_SPAWNER_SIDECAR: "1" },
    );
    expect(out[1]).toEqual({ ...base[1], consecutiveProbeFailures: 0, lastRestartAt: 5000, restartsLast10m: 3, flapState: "damping" });
    expect(out[2]).toEqual({ ...base[2], consecutiveProbeFailures: 0, lastRestartAt: 9000, restartsLast10m: 6, flapState: "gave-up" });
  });

  it("does not project a local gave-up latch when the per-host spawner sidecar is not configured", () => {
    const out = overlayNodeChildSupervision(
      base,
      { running: true, respawnAttemptsInWindow: 3, gaveUp: false, lastRespawnScheduledAt: 5000 },
      { running: false, respawnAttemptsInWindow: 6, gaveUp: true, lastRespawnScheduledAt: 9000 },
      { PAPERCUSP_BACKGROUND_WORKERS: "0" },
    );

    expect(out[2]).toEqual(base[2]);
    const diagnostic = buildServiceHealthDiagnostic([{ name: "operator", up: true, status: null, latencyMs: 1 }], out);
    // The fixture's already-damping mcp-proxy is a real finding; the guard's
    // contract is that the stale spawner latch is absent from this evidence.
    expect(diagnostic.effective.supervisionUnhealthy).toBe(2);
    expect(diagnostic.evidence.unhealthySupervision.map((entry) => entry.name)).toEqual([
      "mcp-proxy",
      "substrate-sidecar",
    ]);
  });

  it("derives flapState 'ok' when running with zero attempts, 'gave-up' takes priority over a nonzero attempt count", () => {
    const out = overlayNodeChildSupervision(
      [base[1]],
      { running: true, respawnAttemptsInWindow: 4, gaveUp: true, lastRespawnScheduledAt: 1 },
      { running: true, respawnAttemptsInWindow: 0, gaveUp: false, lastRespawnScheduledAt: null },
    );
    expect(out[0].flapState).toBe("gave-up");
  });
});

describe("overlaySystemdRestartRecency (EI-13221, pure given injected probeFn/registry)", () => {
  const stagingEntry = {
    name: "staging-api",
    layer: "systemd-user" as const,
    autoRestart: true,
    criticality: "important" as const,
    consecutiveProbeFailures: 0,
    lastRestartAt: null,
    restartsLast10m: 0,
    flapState: "ok" as const,
    // EI-20093902925801178: OBSERVED, so these zeros are real measurements and
    // no caveat note is expected. The un-observed case — where the identical
    // zeros mean "measured nothing" — is covered by its own test below.
    flapObserved: true,
  };
  const registry = [{ name: "staging-api", unit: "papercusp-staging-api" }];

  it("attaches secondsSinceStart + a recentRestartNote when the unit came up inside the window", async () => {
    const probeFn = vi.fn(async () => ({ ok: true, mainPid: 123, secondsSinceStart: 5, activeState: "active" }));
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(probeFn).toHaveBeenCalledWith("papercusp-staging-api");
    expect(out[0]?.secondsSinceStart).toBe(5);
    expect(out[0]?.recentRestartNote).toMatch(/restarted 5s ago/);
    expect(out[0]?.active).toBe(true);
  });

  it("attaches secondsSinceStart WITHOUT a note once outside the recent-restart window", async () => {
    const probeFn = vi.fn(async () => ({ ok: true, mainPid: 123, secondsSinceStart: 600, activeState: "active" }));
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(out[0]?.secondsSinceStart).toBe(600);
    expect(out[0]?.recentRestartNote).toBeUndefined();
    expect(out[0]?.active).toBe(true);
  });

  /**
   * EI-20093902925801178 — THE false-GREEN guard.
   *
   * `flapObserved:false` means the counters beside it measured NOTHING: they are
   * zero-defaults produced in a process that never runs the reconciler (it runs
   * inside papercusp-bg-host; this tool reads the Map in the operator). Rendering
   * that as `flapState:'ok'` with no caveat is exactly how a real 4-restart
   * crash-loop of papercusp-staging-api read as perfectly healthy on 2026-08-10.
   */
  it("flags an UNOBSERVED systemd-user entry so its zero counters cannot read as measured-healthy", async () => {
    const unobserved = { ...stagingEntry, flapObserved: false };
    const probeFn = vi.fn(async () => ({ ok: true, mainPid: 123, secondsSinceStart: 114, activeState: "active", nRestarts: 4 }));
    const out = await overlaySystemdRestartRecency([unobserved], probeFn, registry);
    expect(out[0]?.flapCountersNote, "an un-observed entry must say its counters measured nothing").toMatch(
      /measured NOTHING/,
    );
    // ...and the number that IS trustworthy is surfaced right beside it. These
    // are the real captured values: systemd said 4 while restartsLast10m said 0.
    expect(out[0]?.nRestarts).toBe(4);
    expect(out[0]?.restartsLast10m).toBe(0);
  });

  it("does NOT flag an observed entry — the note has to stay rare enough to mean something", async () => {
    const probeFn = vi.fn(async () => ({ ok: true, mainPid: 123, secondsSinceStart: 600, activeState: "active", nRestarts: 4 }));
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(out[0]?.flapCountersNote).toBeUndefined();
    expect(out[0]?.nRestarts).toBe(4);
  });

  it("omits nRestarts when systemd did not report it — absent must never render as zero restarts", async () => {
    const probeFn = vi.fn(async () => ({ ok: true, mainPid: 123, secondsSinceStart: 600, activeState: "active" }));
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(out[0]?.nRestarts).toBeUndefined();
    expect(out[0]).not.toHaveProperty("nRestarts");
  });

  it("leaves the entry untouched when the probe can't determine anything (fail-soft) — honest 'unknown', never active:false", async () => {
    const probeFn = vi.fn(async () => ({ ok: false }));
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(out[0]).toEqual(stagingEntry);
    expect(out[0]?.active).toBeUndefined();
  });

  it("leaves a not-found unit untouched — ActiveState=inactive is systemd's absent-unit default, not a down verdict", async () => {
    const probeFn = vi.fn(async () => ({
      ok: true,
      loadState: "not-found",
      known: false,
      activeState: "inactive",
      mainPid: 0,
    }));
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(out[0]).toEqual(stagingEntry);
    expect(out[0]?.active).toBeUndefined();
    expect(out[0]?.healthy).toBeUndefined();
  });

  it("leaves the entry untouched when the probe throws", async () => {
    const probeFn = vi.fn(async () => {
      throw new Error("systemctl not found");
    });
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(out[0]).toEqual(stagingEntry);
    expect(out[0]?.active).toBeUndefined();
  });

  it("leaves the entry untouched when ok:true but ActiveState itself couldn't be read (defensive edge case)", async () => {
    const probeFn = vi.fn(async () => ({ ok: true, mainPid: 123, secondsSinceStart: 5 }));
    const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
    expect(out[0]).toEqual(stagingEntry);
    expect(out[0]?.active).toBeUndefined();
  });

  it("skips non-systemd-user entries and units missing from the registry", async () => {
    const probeFn = vi.fn(async () => ({ ok: true, mainPid: 1, secondsSinceStart: 1, activeState: "active" }));
    const nodeChild = { ...stagingEntry, name: "substrate-sidecar", layer: "node-child" as const };
    const unregistered = { ...stagingEntry, name: "not-in-registry" };
    const out = await overlaySystemdRestartRecency([nodeChild, unregistered], probeFn, registry);
    expect(probeFn).not.toHaveBeenCalled();
    expect(out).toEqual([nodeChild, unregistered]);
  });

  // EI-18700974567040702: ActiveState (not MainPID) is systemd's DETERMINATE liveness
  // signal — it must be reported explicitly, not dropped alongside a genuine probe failure
  // (previously a stopped unit and "couldn't check" left the entry byte-identical).
  describe("ActiveState reports a determinate up/down, distinct from a probe failure (EI-18700974567040702)", () => {
    it("activeState: 'failed' sets active:false and carries no secondsSinceStart/recentRestartNote", async () => {
      const probeFn = vi.fn(async () => ({ ok: true, mainPid: 0, activeState: "failed" }));
      const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
      expect(out[0]?.active).toBe(false);
      expect(out[0]?.secondsSinceStart).toBeUndefined();
      expect(out[0]?.recentRestartNote).toBeUndefined();
    });

    /**
     * ⚠ RENAMED by WI-6149. This test was called "down is down, regardless of
     * WHY" — and that claim is exactly what item 4 disproved. Conflating
     * `inactive`, `activating` and `failed` into one boolean is what made a
     * healthy hourly oneshot read as "confirmed DOWN" through this very overlay.
     *
     * The raw `active` boolean is UNCHANGED (it still means "ActiveState is
     * literally 'active'"); what is new is that the WHY is now recoverable from
     * `activeState`, and the verdict from `healthy`. For a PERSISTENT unit like
     * staging-api the verdict is still unhealthy — the semantics did not soften,
     * they got a name. (The episodic case is in service-health-unit-coverage.test.ts,
     * where a registry row can carry `episodic`.)
     */
    it("activeState: 'inactive' on a persistent unit is unhealthy, and the WHY is now readable", async () => {
      const probeFn = vi.fn(async () => ({ ok: true, mainPid: 0, activeState: "inactive" }));
      const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
      expect(out[0]?.active).toBe(false);
      expect(out[0]?.activeState).toBe("inactive");
      expect(out[0]?.healthy).toBe(false);
      // and it is DISTINGUISHABLE from the other two states that share active:false
      const [failed] = await overlaySystemdRestartRecency(
        [stagingEntry],
        vi.fn(async () => ({ ok: true, mainPid: 0, activeState: "failed" })),
        registry,
      );
      const [starting] = await overlaySystemdRestartRecency(
        [stagingEntry],
        vi.fn(async () => ({ ok: true, mainPid: 0, activeState: "activating" })),
        registry,
      );
      expect(failed?.activeState).toBe("failed");
      expect(starting?.activeState).toBe("activating");
      // mid-start is NOT a fault — this is where the overlay used to disagree with
      // the reconciler's own isUnitDown.
      expect(starting?.healthy).toBe(true);
      expect(failed?.healthy).toBe(false);
    });

    it("DOWN (activeState:'failed') is distinguishable from a probe failure (ok:false) — different `active` values", async () => {
      const downProbe = vi.fn(async () => ({ ok: true, mainPid: 0, activeState: "failed" }));
      const failedProbe = vi.fn(async () => ({ ok: false }));
      const [down] = await overlaySystemdRestartRecency([stagingEntry], downProbe, registry);
      const [unknown] = await overlaySystemdRestartRecency([stagingEntry], failedProbe, registry);
      expect(down?.active).toBe(false);
      expect(unknown?.active).toBeUndefined();
      expect(down?.active).not.toBe(unknown?.active);
    });

    it("a live mainPid with no measurable secondsSinceStart still reports active:true (up, just couldn't time it)", async () => {
      const probeFn = vi.fn(async () => ({ ok: true, mainPid: 456, activeState: "active" }));
      const out = await overlaySystemdRestartRecency([stagingEntry], probeFn, registry);
      expect(out[0]?.active).toBe(true);
      expect(out[0]?.secondsSinceStart).toBeUndefined();
    });

    // The concrete bug this fix kills: a `.timer` unit has NO MainPID concept at all, so a
    // MainPID-keyed liveness read (the old code) would call a healthy, running timer "down".
    it("a .timer unit (no MainPID at all) reports active:true from ActiveState alone — the exact case that motivated this fix", async () => {
      const timerEntry = { ...stagingEntry, name: "live-federation-gate-timer" };
      const timerRegistry = [{ name: "live-federation-gate-timer", unit: "papercup-live-federation-gate.timer" }];
      const probeFn = vi.fn(async () => ({ ok: true, activeState: "active" })); // mainPid omitted — a real .timer probe result
      const out = await overlaySystemdRestartRecency([timerEntry], probeFn, timerRegistry);
      expect(out[0]?.active).toBe(true);
      expect(out[0]?.secondsSinceStart).toBeUndefined();
    });

    it("a .timer unit reports active:false when its ActiveState is genuinely not 'active'", async () => {
      const timerEntry = { ...stagingEntry, name: "live-federation-gate-timer" };
      const timerRegistry = [{ name: "live-federation-gate-timer", unit: "papercup-live-federation-gate.timer" }];
      const probeFn = vi.fn(async () => ({ ok: true, activeState: "inactive" }));
      const out = await overlaySystemdRestartRecency([timerEntry], probeFn, timerRegistry);
      expect(out[0]?.active).toBe(false);
      expect(out[0]?.healthy).toBe(false);
    });

    it("a disabled .timer stays unhealthy while exposing its pause state", async () => {
      const timerEntry = { ...stagingEntry, name: "live-federation-gate-timer" };
      const timerRegistry = [{ name: "live-federation-gate-timer", unit: "papercup-live-federation-gate.timer" }];
      const probeFn = vi.fn(async () => ({ ok: true, activeState: "inactive", unitFileState: "disabled" }));
      const out = await overlaySystemdRestartRecency([timerEntry], probeFn, timerRegistry);
      expect(out[0]).toMatchObject({
        active: false,
        activeState: "inactive",
        healthy: false,
        unitFileState: "disabled",
        administrativelyPaused: true,
      });
      expect(out[0]?.episodic).toBeUndefined();
    });
  });
});
