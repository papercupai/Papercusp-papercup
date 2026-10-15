/**
 * coord:inbox cache integration (cache-expensive-tool-reads-2026-06-22 P-008).
 * Only the pure readInbox() derive is cached; every side effect (heartbeat,
 * watermark, mailbox drain) must STILL run on a cache hit. REAL cache + mocked deps.
 * Pins: hit-on-repeat (derive runs once); side effects run every call; per-OWNER
 * key (no cross-principal leak); coord_event_log bump invalidates; CACHE_LAYER bypass.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => ({
  readInbox: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  heartbeatPresence: vi.fn(async () => {}),
  drain: vi.fn(async () => {}),
  readDirectedInbox: vi.fn(async () => [] as unknown[]),
  readWatermark: vi.fn(async () => ({
    messages_shown_ts: "9999-01-01T00:00:00Z",
    snapshot_rebootstrap_pending: false,
  })),
  unanswered: vi.fn(async (recipientIds: string[] = []) => new Map(
    recipientIds.map((recipientId) => [recipientId, { newest: [{ msgId: "ask" }] }] as const),
  )),
  assemblePresenceSnapshot: vi.fn(async (
    _resolved: unknown,
    _opts?: {
      includeDesktopEnrichment?: boolean;
      onDiagnostic?: (diagnostic: {
        phase: string;
        name: string;
        elapsedMs: number;
        status: "ok" | "error";
      }) => void;
    },
  ) => ({})),
  consumePresenceRebootstrap: vi.fn(async (
    _ownerId: unknown,
    wm: { snapshot_rebootstrap_pending?: boolean },
    build: () => Promise<string>,
  ) => wm.snapshot_rebootstrap_pending ? build() : null),
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
vi.mock("../messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../messages")>()),
  readInbox: M.readInbox,
  readDirectedInbox: M.readDirectedInbox,
  drainAndDeliverUserMailbox: M.drain,
}));
vi.mock("../unanswered-directed", () => ({ fetchUnansweredDirected: M.unanswered }));
vi.mock("../recipient-resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../recipient-resolve")>()),
  knownOwnerIdSet: async () => new Set(["peer-a", "peer-b"]),
}));
vi.mock("../presence", () => ({ heartbeatPresence: M.heartbeatPresence }));
// This suite pins CACHE behavior — the heartbeat throttle (EI-6797) is a
// separate concern, so disable it here (always-beat) so "side effects run on a
// cache hit" is tested independently of coalescing. The throttle itself is
// covered by presence-beat-throttle.test.ts + inbox-heartbeat-throttle.test.ts.
//
// ⚠ The `importOriginal` spread is LOAD-BEARING — do not "simplify" it back to a
// bare factory. This suite only wants to stub createPresenceBeatThrottle, but a
// bare `() => ({ createPresenceBeatThrottle })` factory makes every OTHER export
// of the module undefined. dispatch-heartbeat.ts imports PRESENCE_BEAT_INTERVAL_MS
// and evaluates it at MODULE SCOPE (`export const DISPATCH_BEAT_INTERVAL_MS =
// PRESENCE_BEAT_INTERVAL_MS`), reached from here via projected-tool-deps.ts — so a
// missing export throws at import time and the whole suite fails to COLLECT, with
// no failing assertion to point at. That red froze `main` fleet-wide as part of the
// green-checkpoint RED-23 streak (WI-40270). Spreading the real module keeps this
// mock partial, so adding a new export to presence-beat-throttle can never strand
// it again.
vi.mock("../presence-beat-throttle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../presence-beat-throttle")>()),
  createPresenceBeatThrottle: () => ({
    shouldBeat: () => true,
    reset: () => {},
    size: () => 0,
  }),
}));
vi.mock("../watermarks", () => ({
  readWatermark: M.readWatermark,
  writeWatermark: vi.fn(async () => {}),
}));
vi.mock("@papercusp/coordination/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@papercusp/coordination/core")>()),
  emptyWatermark: () => ({ messages_shown_ts: "" }),
}));
vi.mock("../presence-snapshot", () => ({
  resolvePresenceScope: async () => ({}),
  assemblePresenceSnapshot: M.assemblePresenceSnapshot,
  renderPresenceRebootstrapBlock: () => "",
  consumePresenceRebootstrap: M.consumePresenceRebootstrap,
}));
vi.mock("../../../coord-schema", () => ({ renderInjection: () => "" }));

import tool from "./inbox";
import {
  getOperatorCache,
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
} from "../../../cache";
import { _refreshCacheLayerForTests } from "../../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";
const ctx = (
  ownerId: string,
  workspaceId = "ws-inbox",
  metadata: ReturnType<typeof vi.fn> = vi.fn(),
  indirectDispatch = false,
  identityContext: {
    principal?: { slug: string; authMethod?: string; trust?: string };
    uiClientId?: string;
  } = {},
): never =>
  ({
    ...identityContext,
    ownerId,
    workspaceId,
    metadata,
    indirectDispatch,
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

const inbox = (
  owner: string,
  args: Record<string, unknown> = {},
  metadata: ReturnType<typeof vi.fn> = vi.fn(),
  indirectDispatch = false,
): Promise<unknown> => tool.handler(args as never, ctx(owner, "ws-inbox", metadata, indirectDispatch));

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.readInbox.mockReset().mockResolvedValue([]);
  M.readDirectedInbox.mockReset().mockResolvedValue([]);
  M.heartbeatPresence.mockClear();
  M.drain.mockClear();
  M.readWatermark.mockClear();
  M.unanswered.mockReset().mockImplementation(async (recipientIds: string[] = []) => new Map(
    recipientIds.map((recipientId) => [recipientId, { newest: [{ msgId: "ask" }] }] as const),
  ));
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  __setCachedReadEnabledForTests(false);
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

describe("coord:inbox — cache the derive, keep side effects", () => {
  it("records every phase for a default read when diagnostic tracing is enabled", async () => {
    const previousTraceFlag = process.env.PAPERCUSP_COORD_INBOX_TRACE_PHASES;
    process.env.PAPERCUSP_COORD_INBOX_TRACE_PHASES = "1";
    try {
      const metadata = vi.fn();
      await inbox("owner-a", {}, metadata);

      const traces = metadata.mock.calls
        .map(([value]) => (value as { coordInboxRead?: {
          request: { hasFrom: boolean; directed: boolean; unansweredOnly: boolean };
          phases: Array<{ name: string; status: string; elapsedMs: number | null }>;
      } }).coordInboxRead)
        .filter((trace): trace is NonNullable<typeof trace> => trace !== undefined);
      const settled = traces.at(-1);
      expect(settled?.request).toEqual({ hasFrom: false, directed: false, unansweredOnly: false });
      expect(settled?.phases.find(({ name }) => name === "readInbox-derive")?.status).toBe("fulfilled");
      expect(settled?.phases.map(({ name }) => name)).toEqual(expect.arrayContaining([
        "resolve-actor-identity",
        "drain-user-mailbox",
      ]));
      expect(settled?.phases.every(({ status }) => status !== "running")).toBe(true);
    } finally {
      if (previousTraceFlag === undefined) delete process.env.PAPERCUSP_COORD_INBOX_TRACE_PHASES;
      else process.env.PAPERCUSP_COORD_INBOX_TRACE_PHASES = previousTraceFlag;
    }
  });

  it("records default-read phases on indirect dispatch without the diagnostic env flag", async () => {
    const previousTraceFlag = process.env.PAPERCUSP_COORD_INBOX_TRACE_PHASES;
    delete process.env.PAPERCUSP_COORD_INBOX_TRACE_PHASES;
    try {
      const metadata = vi.fn();
      await inbox("owner-a", {}, metadata, true);

      const traces = metadata.mock.calls
        .map(([value]) => (value as { coordInboxRead?: {
          request: { hasFrom: boolean; directed: boolean; unansweredOnly: boolean };
          phases: Array<{ name: string; status: string; elapsedMs: number | null }>;
        } }).coordInboxRead)
        .filter((trace): trace is NonNullable<typeof trace> => trace !== undefined);
      const settled = traces.at(-1);
      expect(settled?.request).toEqual({ hasFrom: false, directed: false, unansweredOnly: false });
      expect(settled?.phases.map(({ name }) => name)).toEqual(expect.arrayContaining([
        "resolve-actor-identity",
        "drain-user-mailbox",
        "readInbox-derive",
      ]));
      expect(settled?.phases.every(({ status }) => status !== "running")).toBe(true);
    } finally {
      if (previousTraceFlag === undefined) delete process.env.PAPERCUSP_COORD_INBOX_TRACE_PHASES;
      else process.env.PAPERCUSP_COORD_INBOX_TRACE_PHASES = previousTraceFlag;
    }
  });

  it("records inner presence snapshot timings on a pending rebootstrap, even for a full inbox read", async () => {
    M.readWatermark.mockImplementationOnce(async () => ({
      messages_shown_ts: "9999-01-01T00:00:00Z",
      snapshot_rebootstrap_pending: true,
    }));
    M.assemblePresenceSnapshot.mockImplementationOnce(async (_resolved, opts) => {
      opts?.onDiagnostic?.({
        phase: "source",
        name: "listPresence",
        elapsedMs: 392_058,
        status: "ok",
      });
      return {};
    });

    const metadata = vi.fn();
    await inbox("owner-a", { kinds: ["message"], limit: 50 }, metadata);

    expect(M.assemblePresenceSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeDesktopEnrichment: false }),
    );

    const traces = metadata.mock.calls
      .map(([value]) => (value as { coordInboxRead?: {
        request: { unansweredOnly: boolean };
        phases: Array<{ name: string; status: string; elapsedMs: number | null }>;
      } }).coordInboxRead)
      .filter((trace): trace is NonNullable<typeof trace> => trace !== undefined);
    const settled = traces.at(-1);
    expect(settled?.request.unansweredOnly).toBe(false);
    expect(settled?.phases).toContainEqual(expect.objectContaining({
      name: "rebootstrap-presence-snapshot:source:listPresence",
      status: "fulfilled",
      elapsedMs: 392_058,
    }));
  });

  it("retains the active selective await phase in overwrite-only invocation metadata", async () => {
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const waitingForRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    M.readInbox.mockImplementation(async () => {
      markReadStarted();
      await waitingForRead;
      return rawRows();
    });

    const metadata = vi.fn();
    const pending = inbox("owner-a", { directed: true, limit: 2 }, metadata);
    await readStarted;

    const inFlight = metadata.mock.lastCall?.[0]?.coordInboxRead as {
      activePhases: string[];
      phases: Array<{ name: string; status: string; startedAt: string; elapsedMs: number | null }>;
    };
    expect(inFlight.activePhases).toContain("readInbox-derive");
    expect(inFlight.phases).toContainEqual(expect.objectContaining({
      name: "readInbox-derive",
      status: "running",
      startedAt: expect.any(String),
      elapsedMs: null,
    }));

    releaseRead();
    await pending;

    const settled = metadata.mock.lastCall?.[0]?.coordInboxRead as typeof inFlight;
    expect(settled.activePhases).toEqual([]);
    expect(settled.phases.find((phase) => phase.name === "readInbox-derive"))
      .toEqual(expect.objectContaining({ status: "fulfilled", elapsedMs: expect.any(Number) }));
  });

  it("a repeat read HITS the derive (readInbox runs once)", async () => {
    await inbox("owner-a");
    await inbox("owner-a");
    expect(M.readInbox).toHaveBeenCalledTimes(1);
  });

  it("side effects (heartbeat) STILL run on every call, even a cache hit", async () => {
    await inbox("owner-a"); // miss → derive + heartbeat
    await inbox("owner-a"); // hit → heartbeat STILL runs (it is outside the cache)
    expect(M.readInbox).toHaveBeenCalledTimes(1); // derive cached
    expect(M.heartbeatPresence).toHaveBeenCalledTimes(2); // liveness never dropped
  });

  it("NO cross-principal leak: a different owner gets its OWN derive (separate entry)", async () => {
    await inbox("owner-a");
    await inbox("owner-b");
    expect(M.readInbox).toHaveBeenCalledTimes(2);
    await inbox("owner-a"); // cached
    await inbox("owner-b"); // cached
    expect(M.readInbox).toHaveBeenCalledTimes(2);
  });

  it("a coord_event_log bump invalidates the derive (rebuild on next read)", async () => {
    await inbox("owner-a");
    expect(M.readInbox).toHaveBeenCalledTimes(1);
    getOperatorCache().invalidateByTags("ws-inbox", ["coord_event_log"]);
    await inbox("owner-a");
    expect(M.readInbox).toHaveBeenCalledTimes(2);
  });

  it("CACHE_LAYER OFF ⇒ bypass: the derive runs every call", async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await inbox("owner-a");
    await inbox("owner-a");
    expect(M.readInbox).toHaveBeenCalledTimes(2);
  });
});

// Same owner/floor/kinds, different post-read filters. Each real DB read would
// decode a separate object graph; the factory deliberately clones on every call.
// Keep large authored content intact: sharing must not become payload trimming.
const rawRows = () => [
  { msg_id: "ask", kind: "message", from: "peer-a", to: ["owner-a"],
    ts: "2026-10-01T00:00:00Z", summary: "question", body: "useful context ".repeat(8192) },
  { msg_id: "reply", kind: "message", from: "peer-b", to: ["owner-a"],
    ts: "2026-10-01T00:00:01Z", summary: "answer" },
  { msg_id: "broadcast", kind: "message", from: "peer-a", to: ["*"],
    ts: "2026-10-01T00:00:02Z", summary: "shared update" },
];

async function read(args: Record<string, unknown>, owner = "owner-a", workspace = "ws-inbox") {
  const result = await tool.handler(args as never, ctx(owner, workspace)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(result.content[0].text) as {
    entries: Array<{ msg_id: string; body?: string }>;
    summary: { total: number; returned: number };
  };
}

describe("coord:inbox — share only equivalent full derives (P-011)", () => {
  it("uses a verified bare session alias for directed and unanswered filters", async () => {
    const bareSessionId = "su-judge-session";
    const namespacedOwnerId = `system:judge/${bareSessionId}`;
    const ask = {
      msg_id: "alias-ask",
      kind: "message",
      from: "peer-a",
      to: [bareSessionId],
      ts: "2026-10-01T00:00:00Z",
      summary: "question addressed to the signed session id",
    };
    M.readDirectedInbox.mockResolvedValue([ask]);
    M.unanswered.mockImplementation(async (recipientIds: string[] = []) => new Map(
      recipientIds.map((recipientId) => [recipientId, {
        newest: recipientId === bareSessionId ? [{ msgId: ask.msg_id }] : [],
      }]),
    ));

    const response = await tool.handler({
      directed: true,
      unanswered_only: true,
      limit: 20,
      include_ambient: true,
      include_intents: true,
      max_body_chars: 0,
    } as never, ctx(namespacedOwnerId, "ws-inbox", vi.fn(), false, {
      principal: { slug: "system:judge", authMethod: "spawn-url", trust: "trusted" },
      uiClientId: bareSessionId,
    })) as { content: Array<{ text: string }> };
    const result = JSON.parse(response.content[0]!.text) as {
      entries: Array<{ msg_id: string }>;
      summary: { total: number };
    };

    expect(M.readDirectedInbox).toHaveBeenCalledWith(bareSessionId, expect.anything());
    expect(M.unanswered).toHaveBeenCalledWith(
      [namespacedOwnerId, bareSessionId],
      expect.objectContaining({ perRecipientCap: expect.any(Number) }),
    );
    expect(result.entries.map(({ msg_id }) => msg_id)).toEqual([ask.msg_id]);
    expect(result.summary.total).toBe(1);
  });

  it("directed=true keeps mixed delivery only when it names the current reader", async () => {
    M.readInbox.mockImplementation(async () => [
      { msg_id: "for-owner", kind: "message", from: "peer-a", to: ["*", "owner-a"],
        ts: "2026-10-01T00:00:00Z", summary: "directed to this reader" },
      { msg_id: "wildcard-only", kind: "message", from: "peer-a", to: ["*"],
        ts: "2026-10-01T00:00:01Z", summary: "broadcast" },
      { msg_id: "human-and-wildcard", kind: "message", from: "peer-a", to: ["human", "*"],
        ts: "2026-10-01T00:00:02Z", summary: "broadcast to human and everyone" },
      { msg_id: "other-and-wildcard", kind: "message", from: "peer-a", to: ["owner-b", "*"],
        ts: "2026-10-01T00:00:03Z", summary: "broadcast to another owner and everyone" },
    ]);

    const result = await read({
      directed: true,
      limit: 10,
      include_ambient: true,
      include_intents: true,
    });

    expect(result.entries.map((entry) => entry.msg_id)).toEqual(["for-owner"]);
    expect(result.summary.total).toBe(1);
    expect(result.summary.returned).toBe(1);
  });

  it("shares a nonempty full derive across sender, directed and unanswered filters without losing content", async () => {
    const decoded: unknown[][] = [];
    M.readInbox.mockImplementation(async () => {
      const rows = rawRows();
      decoded.push(rows);
      return rows;
    });
    const sender = await read({ from: "peer-a", limit: 1, max_body_chars: 0 });
    const directed = await read({ directed: true, limit: 20, include_ambient: true,
      include_intents: true, max_body_chars: 0 });
    const unanswered = await read({ unanswered_only: true, limit: 500, max_body_chars: 0 });
    expect(sender.entries.map(e => e.msg_id)).toEqual(["broadcast"]);
    expect(sender.summary.total).toBe(2);
    expect(directed.entries.map(e => e.msg_id)).toEqual(["reply", "ask"]);
    expect(unanswered.entries.map(e => e.msg_id)).toEqual(["ask"]);
    expect(unanswered.entries[0].body).toBe(rawRows()[0].body);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(rawRows()); // annotations/limits never mutate the cached graph
    expect(M.readInbox.mock.calls[0][2]).toBeUndefined(); // actual full-read branch
    expect(M.heartbeatPresence).toHaveBeenCalledTimes(3);
    expect(M.drain).toHaveBeenCalledTimes(3);
    expect(M.readWatermark).toHaveBeenCalledTimes(3);
    expect(M.unanswered).toHaveBeenCalledTimes(1);
    getOperatorCache().invalidateByTags("ws-inbox", ["coord_event_log"]);
    await read({ directed: true, limit: 2 });
    expect(decoded).toHaveLength(2);
  });

  it("keeps owner, workspace, delivery floor and kinds isolated for full reads", async () => {
    M.readInbox.mockImplementation(async () => rawRows());
    const full = { directed: true };
    await read(full);
    await read(full, "owner-b");
    await read(full, "owner-a", "other-workspace");
    await read({ ...full, __deliveryFloorTs: "2026-10-01T00:00:00Z" });
    await read({ ...full, kinds: ["message"] });
    expect(M.readInbox).toHaveBeenCalledTimes(5);
    await read({ ...full, limit: 499, include_intents: true });
    expect(M.readInbox).toHaveBeenCalledTimes(5);
  });

  it("keeps bounded stopping rules distinct from each other and from full reads", async () => {
    await read({ limit: 1 });
    await read({ limit: 2 });
    await read({ limit: 2, include_ambient: true });
    await read({ limit: 2, include_intents: true });
    await read({ limit: 2, directed: true });
    expect(M.readInbox).toHaveBeenCalledTimes(5);
    expect(M.readInbox.mock.calls.slice(0, 4).every(call =>
      typeof (call[2] as { enough?: unknown })?.enough === "function")).toBe(true);
    expect(M.readInbox.mock.calls[4][2]).toBeUndefined();
  });

  it("single-flights concurrent full reads while each caller keeps its own content and side effects", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    M.readInbox.mockImplementation(async () => { entered(); await waiting; return rawRows(); });
    const reads = Array.from({ length: 8 }, (_, i) => read({
      directed: true, limit: i + 2, include_ambient: i % 2 === 0,
      include_intents: i % 3 === 0, max_body_chars: 0,
    }));
    await started;
    release();
    const results = await Promise.all(reads);
    expect(M.readInbox).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.entries.map(e => e.msg_id)).toEqual(["reply", "ask"]);
      expect(result.entries.find(e => e.msg_id === "ask")?.body).toBe(rawRows()[0].body);
    }
    expect(M.heartbeatPresence).toHaveBeenCalledTimes(8);
    expect(M.drain).toHaveBeenCalledTimes(8);
    expect(M.readWatermark).toHaveBeenCalledTimes(8);
  });
});

// EI-18667514339699744: coord:inbox returns its rows under `entries`; coord:orient
// folds the SAME rows under `recent`. A caller reading the wrong key for the surface
// it's actually on got a silent [] (indistinguishable from "no mail") instead of an
// error. Pin that coord:inbox's own result exposes BOTH key names for the same rows.
//
// EI-21902920583326819: `recent` used to be a byte-for-byte SECOND full copy of
// `entries` (doubling every inbox read's wire cost for a key nothing in this
// codebase reads as full rows). It is now a cheap `msg_id`-only pointer into
// `entries` — still present under both names (no silent []), just not
// re-serialized twice.
describe("coord:inbox — `recent` alias (EI-18667514339699744, EI-21902920583326819)", () => {
  it("exposes the same rows under `entries` and their `msg_id`s under `recent`", async () => {
    M.readInbox.mockResolvedValueOnce([
      { msg_id: "m1", kind: "message", from: "peer", ts: "2026-07-26T00:00:00Z", summary: "hi" },
    ] as unknown[]);
    const result = (await inbox("owner-a")) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text) as {
      entries: Array<{ msg_id: string }>;
      recent: string[];
    };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.recent).toEqual(parsed.entries.map((e) => e.msg_id));
  });
});
