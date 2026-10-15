/**
 * coord:inbox — presence heartbeat throttle wiring (EI-6797).
 *
 * Regression: `coord:inbox` (and `coord:orient`, which wraps it) used to fire
 * the HEAVY `coord_presence` `INSERT ... ON CONFLICT ... DO UPDATE` upsert on
 * EVERY call — the dominant PG lock-manager contention source when a busy
 * fleet loops orient on a wake cadence, stalling all write-side MCP tools
 * fleet-wide. The inbox liveness heartbeat is now coalesced to ≤1 upsert per
 * window per owner via the shared presence-beat throttle.
 *
 * These pins use the REAL throttle (not mocked). The throttle is a module
 * singleton shared across `it` blocks in this file, so each case uses a
 * DISTINCT owner id to start from a fresh window.
 *
 * Run: cd packages/operator-core && npx vitest run \
 *   lib/agent-tools/coordination/tools/inbox-heartbeat-throttle.test.ts
 */
import { describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  heartbeatPresence: vi.fn(async () => {}),
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
  heartbeatPresence: M.heartbeatPresence,
  getPresence: vi.fn(async () => null),
}));
vi.mock("../watermarks", () => ({
  readWatermark: vi.fn(async () => ({ messages_shown_ts: "" })),
  writeWatermark: vi.fn(async () => {}),
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
  cachedRead: async (_ctx: unknown, _key: unknown, fn: () => Promise<unknown>) =>
    fn(),
}));

import tool from "./inbox";

const ctx = (ownerId: string): never =>
  ({
    ownerId,
    workspaceId: "ws",
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

const inbox = (owner: string): Promise<unknown> =>
  tool.handler({} as never, ctx(owner));

describe("coord:inbox heartbeat throttle (EI-6797)", () => {
  it("opts out of the ambient workspace transaction", () => {
    // The handler uses dedicated coordination/admin accessors and never reads
    // ctx.tx. Keeping an app-role transaction for its whole await-heavy read
    // starves the same coordination lane this tool is meant to serve.
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it("coalesces the heavy heartbeat upsert across rapid same-owner calls", async () => {
    M.heartbeatPresence.mockClear();
    // Three back-to-back inbox reads for one owner (a fleet worker looping
    // orient) — well within the 45s window.
    await inbox("thr-owner-1");
    await inbox("thr-owner-1");
    await inbox("thr-owner-1");
    // Only the FIRST beats; the rest are coalesced (was 3 before the fix).
    expect(M.heartbeatPresence).toHaveBeenCalledTimes(1);
  });

  it("still beats (mints/refreshes) on the first call for a fresh owner", async () => {
    M.heartbeatPresence.mockClear();
    await inbox("thr-owner-2");
    expect(M.heartbeatPresence).toHaveBeenCalledTimes(1);
  });

  it("throttles owners independently — one owner's beat never suppresses another's", async () => {
    M.heartbeatPresence.mockClear();
    await inbox("thr-owner-3");
    await inbox("thr-owner-4");
    // Both fresh owners beat despite firing in the same window.
    expect(M.heartbeatPresence).toHaveBeenCalledTimes(2);
  });
});
