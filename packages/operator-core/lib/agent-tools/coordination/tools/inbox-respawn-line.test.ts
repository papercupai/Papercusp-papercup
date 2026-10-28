/**
 * coord:inbox — EI-19326331501849713 dropped-carry-respawn ambient line WIRING.
 *
 * The pure renderer (`lostRespawnAmbientLine`) and its file reader are pinned
 * by `lib/carry-respawn-outcome.test.ts`. THIS file pins the thing that file
 * cannot: that the renderer is actually WIRED into the per-turn coord injection
 * — the handler reads the outcome, gates it on the quiet band, and places the
 * line FIRST in the `injection` block agents actually consume.
 *
 * Why it needs its own suite: the sibling gated line (`inbox-flush-gate.test.ts`)
 * tests only its pure renderer, so nothing in this directory exercised the
 * assembly at `inbox.ts:935`. A wiring regression — a dropped import, a gate
 * flipped to the wrong constant, the line appended last instead of first —
 * leaves every pure test green while the agent is never told its respawn died.
 *
 * Deliberately mocks ONLY `readPriorRespawnOutcome` (the IO leg) and keeps the
 * REAL `lostRespawnAmbientLine`, so the asserted text is the genuine
 * production string rather than a fixture's idea of it.
 *
 * Same mocked-deps seam as the sibling inbox-*.test.ts files in this dir.
 *
 * Run: cd packages/operator-core && npx vitest run \
 *   lib/agent-tools/coordination/tools/inbox-respawn-line.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_GAUGE_QUIET_PCT } from "./inbox-context-usage";
import type { PriorRespawn } from "../../../carry-respawn-outcome";

const LIMIT = 100_000;
// 70% sits ABOVE the respawn/gauge quiet gate (65) and BELOW the flush gate (75)
// and the loud gauge (80), so these cases exercise the respawn line in isolation
// — a failure here cannot be a flush-gate or banded-gauge side effect.
const ABOVE_GATE_TOKENS = 70_000;
const BELOW_GATE_TOKENS = 60_000;

const M = vi.hoisted(() => ({
  readPriorRespawnOutcome: vi.fn(async () => ({ outcome: "none" }) as unknown),
  getPresence: vi.fn(async () => null as unknown),
  currentContextUsageForOwner: vi.fn(async () => ({
    backend: "codex",
    nativeSessionId: "native-current",
    sessionStartedAtMs: Date.now() - 60_000,
    reading: null,
    unavailableReason: "active Codex rollout is unavailable",
  }) as unknown),
  selfCompactionAvailability: vi.fn((_ownerId?: string) => ({ available: false })),
  readFleetWindDownLoopEndAuthorization: vi.fn(async () => null as boolean | null),
}));

vi.mock("../identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../identity")>()),
  resolveAgentIdentity: (ctx: { ownerId?: string }) => ({
    ownerId: ctx?.ownerId ?? "owner-a",
  }),
}));
vi.mock("../actor-identity", () => ({
  resolveActorIdentity: async (ctx: { ownerId?: string }) => ({
    ownerId: ctx?.ownerId ?? "owner-a",
  }),
  actorMailboxKeys: () => [] as string[],
}));
vi.mock("../messages", () => ({
  readInbox: vi.fn(async () => [] as unknown[]),
  drainAndDeliverUserMailbox: vi.fn(async () => {}),
}));
vi.mock("../presence", () => ({
  heartbeatPresence: vi.fn(async () => {}),
  getPresence: M.getPresence,
}));
vi.mock("../watermarks", () => ({
  readWatermark: vi.fn(async () => ({ messages_shown_ts: "" })),
  writeWatermark: vi.fn(async () => ({})),
}));
vi.mock("@papercusp/coordination/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@papercusp/coordination/core")>()),
  emptyWatermark: () => ({ messages_shown_ts: "" }),
}));
vi.mock("../presence-snapshot", () => ({
  resolvePresenceScope: async () => ({}),
  assemblePresenceSnapshot: async () => ({}),
  renderPresenceRebootstrapBlock: () => "",
  consumePresenceRebootstrap: async () => null,
}));
vi.mock("../../../coord-schema", () => ({ renderInjection: () => "" }));
vi.mock("../../../cache", () => ({
  cachedRead: async (_ctx: unknown, _key: unknown, fn: () => Promise<unknown>) => fn(),
}));
// Current usage carries its native-session provenance; presence values below are
// deliberately only an unbound-cache control for the unknown-reading case.
vi.mock("../../../compaction-usage", () => ({
  currentContextUsageForOwner: M.currentContextUsageForOwner,
}));
vi.mock("../../../events/await/psu-pty-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../events/await/psu-pty-discovery")>();
  // The handler reads availability through the async variant (WI-10005186); route
  // it to the same mock so both entry points stay pinned.
  return {
    ...actual,
    selfCompactionAvailability: M.selfCompactionAvailability,
    selfCompactionAvailabilityAsync: async (ownerId: string) => M.selfCompactionAvailability(ownerId),
  };
});
vi.mock("./continuation-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./continuation-gate")>();
  return { ...actual, readFleetWindDownLoopEndAuthorization: M.readFleetWindDownLoopEndAuthorization };
});
// PARTIAL mock: only the IO leg is stubbed. `lostRespawnAmbientLine` stays
// REAL so the assertions below pin the production wording, not a fixture.
vi.mock("../../../carry-respawn-outcome", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../carry-respawn-outcome")>();
  return { ...actual, readPriorRespawnOutcome: M.readPriorRespawnOutcome };
});

import tool from "./inbox";

const ctx = (ownerId = "owner-a"): never =>
  ({ ownerId, workspaceId: "ws", metadata: vi.fn(), log: vi.fn(), progress: vi.fn() }) as never;

const callInbox = async (owner = "owner-a"): Promise<Record<string, unknown>> => {
  const res = (await tool.handler({} as never, ctx(owner))) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

const atPct = (tokens: number) => {
  M.getPresence.mockImplementation(
    async () => ({ contextTokens: tokens, compactionLimit: LIMIT }) as unknown,
  );
  M.currentContextUsageForOwner.mockResolvedValue({
    backend: "codex",
    nativeSessionId: "native-current",
    sessionStartedAtMs: Date.now() - 60_000,
    reading: { tokens, observedAtMs: Date.now(), source: "codex-last-token-usage" },
    unavailableReason: null,
  } as unknown);
};
const prior = (p: PriorRespawn) => {
  M.readPriorRespawnOutcome.mockImplementation(async () => p as unknown);
};

const DROPPED_2H: PriorRespawn = {
  outcome: "dropped",
  reason: "carry-stale",
  ts: "2026-08-09T07:00:00.000Z",
  ageMs: 2 * 60 * 60 * 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
  atPct(ABOVE_GATE_TOKENS);
  prior({ outcome: "none" });
  M.selfCompactionAvailability.mockReturnValue({ available: false });
  M.readFleetWindDownLoopEndAuthorization.mockResolvedValue(null);
});

describe("coord:inbox — dropped carry-respawn ambient line (EI-19326331501849713)", () => {
  it("surfaces the dropped-respawn warning in the injection at/above the quiet gate", async () => {
    prior(DROPPED_2H);
    const out = await callInbox();
    const injection = String(out.injection ?? "");
    expect(injection).toContain("carry-respawn DROPPED 2h ago");
    expect(injection).toContain("(reason: carry-stale)");
    expect(injection).toContain("continuation was not delivered");
    expect(injection).not.toContain("NEVER CUT");
    expect(injection).toContain("session:request-compaction");
    expect(M.readPriorRespawnOutcome).toHaveBeenCalledWith("owner-a", {
      incarnation: {
        nativeSessionId: "native-current",
        startedAtMs: expect.any(Number),
      },
    });
  });

  it("runtime wiring: critical no-PTY authorization reaches both coord:inbox renderers", async () => {
    atPct(95_000);
    M.readFleetWindDownLoopEndAuthorization.mockResolvedValue(true);

    const out = await callInbox();
    const injection = String(out.injection ?? "");
    const gauge = String(out.context_gauge ?? "");

    expect(M.selfCompactionAvailability).toHaveBeenCalledWith("owner-a");
    expect(M.readFleetWindDownLoopEndAuthorization).toHaveBeenCalledWith({
      ownerId: "owner-a",
      workspaceId: "ws",
    });
    expect(injection).toContain("typed fleet wind-down authorizes loop:end");
    expect(injection).toContain("do not call session:end or respawn");
    expect(gauge).toContain("call loop:end under the typed fleet wind-down authorization");
    expect(gauge).toContain("do not call session:end or respawn");
  });

  it("places the warning FIRST — it reframes every line below it", async () => {
    prior(DROPPED_2H);
    const out = await callInbox();
    const injection = String(out.injection ?? "");
    // Not merely "present somewhere": the whole point is that it leads the block,
    // ahead of the context-usage percent it explains.
    expect(injection.split("\n")[0]).toContain("carry-respawn DROPPED");
    expect(injection.length).toBeGreaterThan(0);
  });

  it("stays silent BELOW the quiet gate, and does not even pay for the read", async () => {
    atPct(BELOW_GATE_TOKENS);
    prior(DROPPED_2H);
    const out = await callInbox();
    expect(String(out.injection ?? "")).not.toContain("carry-respawn DROPPED");
    // The gate is a cost property as well as a correctness one: a low-% turn
    // must not pay for the event-log read at all.
    expect(M.readPriorRespawnOutcome).not.toHaveBeenCalled();
  });

  it("stays silent for a DELIVERED respawn even though the read ran", async () => {
    prior({ outcome: "delivered", ts: "2026-08-09T07:00:00.000Z", ageMs: 60_000 });
    const out = await callInbox();
    expect(M.readPriorRespawnOutcome).toHaveBeenCalled();
    expect(String(out.injection ?? "")).not.toContain("carry-respawn DROPPED");
  });

  it("stays silent for a drop older than the 6h window", async () => {
    prior({ ...DROPPED_2H, ageMs: 7 * 60 * 60 * 1000 });
    const out = await callInbox();
    expect(String(out.injection ?? "")).not.toContain("carry-respawn DROPPED");
  });

  it("withholds a cached percentage when the current Codex rollout sample is unavailable", async () => {
    atPct(95_000);
    M.currentContextUsageForOwner.mockResolvedValue({
      backend: "codex",
      nativeSessionId: "native-current",
      sessionStartedAtMs: Date.now() - 60_000,
      reading: null,
      unavailableReason: "active Codex token_count sample is stale",
    } as unknown);
    const out = await callInbox();
    const injection = String(out.injection ?? "");
    expect(injection).toContain("context: unknown — active Codex token_count sample is stale");
    expect(injection).toContain("watchdog cache is not bound to the current native session");
    expect(injection).not.toContain("95000/100000");
    expect(injection).not.toContain("request-compaction");
    expect(String(out.context_gauge ?? "")).toContain("context: unknown");
  });

  it("a failing event-log read never breaks the inbox (own try/catch)", async () => {
    M.readPriorRespawnOutcome.mockImplementation(async () => {
      throw new Error("event log unreadable");
    });
    const out = await callInbox();
    // The read is isolated: the inbox still answers, and the sibling usage line
    // (computed BEFORE the respawn read) survives — proving the throw did not
    // unwind the enclosing presence/usage block.
    expect(out.ok).not.toBe(false);
    expect(String(out.injection ?? "")).not.toContain("carry-respawn DROPPED");
  });

  // P-009 (fleet-lead-instrumentation-audit-2026-08-09): the pre-empted attempt.
  // It never gets a verdict row, so it reads `pending` forever — and this whole
  // surface used to be gated on `dropped`, which is why the acked-but-never-cut
  // case with NO host evidence was also the one case nothing ever said.
  it("surfaces delayed pending delivery without inferring that its controller died", async () => {
    prior({
      outcome: "pending",
      reason: "busy-gate-expired",
      ts: "2026-08-09T07:00:00.000Z",
      ageMs: 20 * 60 * 1000,
      capMs: 360_000,
    });
    const injection = String((await callInbox()).injection ?? "");
    expect(injection).toContain("carry-respawn DELAYED");
    expect(injection).toContain("no recorded terminal outcome");
    expect(injection.split("\n")[0]).toContain("carry-respawn DELAYED");
    expect(injection).not.toContain("ORPHANED");
  });

  it("stays silent for a pending respawn still INSIDE its re-poll window", async () => {
    prior({
      outcome: "pending",
      reason: "busy-gate-expired",
      ts: "2026-08-09T07:00:00.000Z",
      ageMs: 30_000,
      capMs: 360_000,
    });
    const injection = String((await callInbox()).injection ?? "");
    expect(M.readPriorRespawnOutcome).toHaveBeenCalled();
    expect(injection).not.toContain("carry-respawn ORPHANED");
  });

  it("CONTROL: a gate-blind wiring would fail these cases (calibration)", async () => {
    // Calibration: the exact same prior that renders above the gate must be the
    // one that stays silent below it. If this pair ever agrees, the gate is not
    // being consulted and the cases above are passing for the wrong reason.
    prior(DROPPED_2H);
    atPct(ABOVE_GATE_TOKENS);
    const shown = String((await callInbox()).injection ?? "");
    atPct(BELOW_GATE_TOKENS);
    const hidden = String((await callInbox()).injection ?? "");
    expect(shown).toContain("carry-respawn DROPPED");
    expect(hidden).not.toContain("carry-respawn DROPPED");
    expect(CONTEXT_GAUGE_QUIET_PCT).toBe(65);
  });
});
