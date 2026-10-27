/**
 * coord:inbox — EI-2042 read-receipt cursor write-through.
 *
 * `coord:inbox` advances the CALLER's `messages_shown_ts` watermark to the
 * newest entry just SHOWN to them (summary.newest_ts), deterministically in
 * tool code at the moment the `[coord+N]` block is assembled — NOT at
 * turn-end (that's `messages_since_ts`, written by coord:watermark-set). A
 * sender then reads a PEER's `messages_shown_ts` (via coord:watermark
 * `{ agent, sent_ts }`) as a read-receipt: `>= sent_ts` means the peer's
 * `[coord+N]` injection already showed it.
 *
 * Pins:
 *   • a read that surfaces entries advances the watermark to summary.newest_ts;
 *   • the monotonic guard: writeWatermark is skipped when newest_ts is not
 *     STRICTLY newer than the already-stored messages_shown_ts (never moves
 *     the read-receipt cursor backward — you can't un-see a message);
 *   • an empty read (no entries, no newest_ts) never calls writeWatermark;
 *   • the write is best-effort — a writeWatermark rejection never breaks the
 *     inbox read itself.
 *
 * Same mocked-deps seam as the sibling inbox-*.test.ts files in this dir.
 *
 * Run: cd packages/operator-core && npx vitest run \
 *   lib/agent-tools/coordination/tools/inbox-read-receipt.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  readInbox: vi.fn(async () => [] as unknown[]),
  readWatermark: vi.fn(async () => ({ messages_shown_ts: "" })),
  writeWatermark: vi.fn(async () => ({})),
  emitAwaitedEvent: vi.fn(async () => ({})),
  sendMessage: vi.fn(async () => ({})),
  machineFingerprint: vi.fn(() => "test-machine"),
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
  readInbox: M.readInbox,
  drainAndDeliverUserMailbox: vi.fn(async () => {}),
  sendMessage: M.sendMessage,
}));
vi.mock("../presence", () => ({
  heartbeatPresence: vi.fn(async () => {}),
  getPresence: vi.fn(async () => null),
}));
vi.mock("../watermarks", () => ({
  readWatermark: M.readWatermark,
  writeWatermark: M.writeWatermark,
}));
vi.mock("@papercusp/coordination/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@papercusp/coordination/core")>()),
  emptyWatermark: () => ({ messages_shown_ts: "" }),
}));
vi.mock("../../../events/await/engine", () => ({
  emitAwaitedEvent: M.emitAwaitedEvent,
}));
vi.mock("../../../identity/device-keychain-id", () => ({
  machineFingerprint: M.machineFingerprint,
}));
vi.mock("../presence-snapshot", () => ({
  resolvePresenceScope: async () => ({}),
  assemblePresenceSnapshot: async () => ({}),
  renderPresenceRebootstrapBlock: () => "",
  consumePresenceRebootstrap: async () => null,
}));
vi.mock("../../../coord-schema", () => ({ renderInjection: () => "" }));
vi.mock("../../../cache", () => ({
  cachedRead: async (
    _ctx: unknown,
    _key: unknown,
    fn: () => Promise<unknown>,
  ) => fn(),
}));

import tool, { receiptSafeShownTs } from "./inbox";

const ctx = (ownerId = "owner-a"): never =>
  ({ ownerId, workspaceId: "ws", metadata: vi.fn(), log: vi.fn(), progress: vi.fn() }) as never;

const callInbox = async (
  args: Record<string, unknown> = {},
  owner = "owner-a",
): Promise<Record<string, unknown>> => {
  const res = (await tool.handler(args as never, ctx(owner))) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

const msg = (ts: string, id: string) => ({
  ts,
  msg_id: id,
  from: "peer-b",
  to: ["owner-a"],
  kind: "message",
  summary: `hello ${id}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  M.readInbox.mockImplementation(async () => []);
  M.readWatermark.mockImplementation(async () => ({ messages_shown_ts: "" }));
  M.writeWatermark.mockImplementation(async () => ({}));
  M.emitAwaitedEvent.mockImplementation(async () => ({}));
  M.sendMessage.mockImplementation(async () => ({}));
  M.machineFingerprint.mockImplementation(() => "test-machine");
});

describe("coord:inbox EI-2042 read-receipt write-through", () => {
  it("records an FYI as read without replying or hiding it from a later VIEW", async () => {
    const fyi = { ...msg("2026-07-18T10:00:00.000Z", "fyi-1"), expects: "none" };
    M.readInbox.mockImplementation(async () => [fyi]);

    const first = await callInbox();
    expect(first.entries).toEqual([expect.objectContaining({ msg_id: "fyi-1", expects: "none" })]);
    expect(M.writeWatermark).toHaveBeenCalledWith("owner-a", { messages_shown_ts: fyi.ts });
    expect(M.sendMessage).not.toHaveBeenCalled();

    M.readWatermark.mockImplementation(async () => ({ messages_shown_ts: fyi.ts }));
    const second = await callInbox();
    expect(second.entries).toEqual([expect.objectContaining({ msg_id: "fyi-1" })]);
    expect(M.sendMessage).not.toHaveBeenCalled();
  });

  it("advances messages_shown_ts to the newest shown entry's ts", async () => {
    const a = msg("2026-07-18T10:00:00.000Z", "m1");
    const b = msg("2026-07-18T10:05:00.000Z", "m2");
    M.readInbox.mockImplementation(async () => [a, b]);
    const out = await callInbox();
    expect(out.summary).toMatchObject({ newest_ts: b.ts });
    expect(M.writeWatermark).toHaveBeenCalledTimes(1);
    expect(M.writeWatermark).toHaveBeenCalledWith("owner-a", {
      messages_shown_ts: b.ts,
    });
  });

  it("monotonic guard: does NOT move the cursor backward or write when already caught up", async () => {
    const a = msg("2026-07-18T09:00:00.000Z", "m-old");
    M.readInbox.mockImplementation(async () => [a]);
    // Already shown something newer than this read's newest entry.
    M.readWatermark.mockImplementation(async () => ({
      messages_shown_ts: "2026-07-18T09:30:00.000Z",
    }));
    await callInbox();
    expect(M.writeWatermark).not.toHaveBeenCalled();
  });

  it("an empty read (no entries) never calls writeWatermark", async () => {
    M.readInbox.mockImplementation(async () => []);
    const out = await callInbox();
    expect(out.summary).toMatchObject({ newest_ts: null });
    expect(M.writeWatermark).not.toHaveBeenCalled();
  });

  it("is best-effort: a writeWatermark rejection never breaks the inbox read", async () => {
    const a = msg("2026-07-18T10:00:00.000Z", "m1");
    M.readInbox.mockImplementation(async () => [a]);
    M.writeWatermark.mockImplementation(async () => {
      throw new Error("boom");
    });
    const out = await callInbox();
    expect(out.summary).toMatchObject({ newest_ts: a.ts });
    expect(out.entries).toHaveLength(1);
  });

  it("scopes the write to the CALLING owner's watermark", async () => {
    const a = msg("2026-07-18T10:00:00.000Z", "m1");
    M.readInbox.mockImplementation(async () => [a]);
    await callInbox({}, "owner-z");
    expect(M.writeWatermark).toHaveBeenCalledWith(
      "owner-z",
      expect.objectContaining({ messages_shown_ts: a.ts }),
    );
  });

  it("emits a stable receipt for a newly shown directed message before advancing the cursor", async () => {
    const a = {
      ...msg("2026-07-18T10:00:00.000Z", "receipt-1"),
      receipt: true,
      harness_slug: "harness-a",
    };
    M.readInbox.mockImplementation(async () => [a]);

    await callInbox();

    expect(M.emitAwaitedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "coord:receipt:receipt-1",
        payload: expect.objectContaining({ msg_id: "receipt-1", read: true }),
      }),
    );
    expect(M.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "fed-receipt" }),
      expect.objectContaining({
        msgId: "coord:receipt:receipt-1",
        extra: expect.objectContaining({
          fed_event: expect.objectContaining({ key: "coord:receipt:receipt-1" }),
        }),
      }),
    );
    expect(M.writeWatermark).toHaveBeenCalledWith("owner-a", {
      messages_shown_ts: a.ts,
    });
  });

  it("leaves the cursor unchanged when receipt emission fails so a later VIEW retries", async () => {
    const a = {
      ...msg("2026-07-18T10:00:00.000Z", "receipt-retry"),
      receipt: true,
      harness_slug: "harness-a",
    };
    M.readInbox.mockImplementation(async () => [a]);
    M.sendMessage.mockRejectedValueOnce(new Error("fed outbox unavailable"));

    await callInbox();
    expect(M.writeWatermark).not.toHaveBeenCalled();

    await callInbox();
    expect(M.sendMessage).toHaveBeenCalledTimes(2);
    expect(M.writeWatermark).toHaveBeenCalledWith("owner-a", {
      messages_shown_ts: a.ts,
    });
  });

  it("does not re-emit a receipt after the read watermark already covers the message", async () => {
    const a = {
      ...msg("2026-07-18T10:00:00.000Z", "receipt-once"),
      receipt: true,
      harness_slug: "harness-a",
    };
    M.readInbox.mockImplementation(async () => [a]);
    M.readWatermark
      .mockImplementationOnce(async () => ({ messages_shown_ts: "" }))
      .mockImplementationOnce(async () => ({ messages_shown_ts: a.ts }));

    await callInbox();
    await callInbox();

    expect(M.emitAwaitedEvent).toHaveBeenCalledTimes(1);
    expect(M.sendMessage).toHaveBeenCalledTimes(1);
    expect(M.writeWatermark).toHaveBeenCalledTimes(1);
  });
});

/**
 * EI-21949790802251298 — the read-receipt cursor must never claim an UNSHOWN
 * message was seen.
 *
 * `prioritizedInboxWindow` selects by P-009 priority bucket BEFORE ts, so a
 * bounded read can keep a NEWER actionable ask while dropping an OLDER status
 * message. `summary.newest_ts` is the max over that window, so it can sit ABOVE
 * an entry the window skipped. Writing it into `messages_shown_ts` would tell
 * the skipped message's sender it was seen — and coord:watermark documents
 * `seen:true` to the sender as "ping them, don't re-route", so the message is
 * silently dropped and the sender cannot detect it.
 */
describe("coord:inbox EI-21949790802251298 receipt-safe cursor", () => {
  const ask = (ts: string, id: string) => ({ ...msg(ts, id), expects: "action" });

  it("does NOT advance the cursor past an older entry the priority window skipped", async () => {
    // bucket 0 (expects:'action') and NEWER — survives limit:1.
    const keptAsk = ask("2026-07-18T10:00:00.000Z", "ask-kept");
    // bucket 2 and OLDER than the kept ask — dropped, and the old code's
    // newest_ts (10:00) would have claimed this 09:00 message was seen.
    const skippedOlder = msg("2026-07-18T09:00:00.000Z", "status-skipped");
    M.readInbox.mockImplementation(async () => [skippedOlder, keptAsk]);

    const out = await callInbox({ limit: 1 });

    expect(out.entries).toHaveLength(1);
    expect((out.entries as Array<{ msg_id: string }>)[0]!.msg_id).toBe("ask-kept");
    // The regression: the cursor must never be written at the window max here.
    expect(M.writeWatermark).not.toHaveBeenCalledWith(
      "owner-a",
      expect.objectContaining({ messages_shown_ts: keptAsk.ts }),
    );
    // Nothing below the oldest unshown entry qualifies, so it must not move.
    expect(M.writeWatermark).not.toHaveBeenCalled();
  });

  it("marks newest_ts as window-scoped and reports the full-set newest when truncated", async () => {
    const keptAsk = ask("2026-07-18T10:00:00.000Z", "ask-kept");
    const skippedOlder = msg("2026-07-18T09:00:00.000Z", "status-old");
    const skippedNewer = msg("2026-07-18T11:00:00.000Z", "status-new");
    M.readInbox.mockImplementation(async () => [skippedOlder, keptAsk, skippedNewer]);

    const out = await callInbox({ limit: 1 });
    const summary = out.summary as Record<string, unknown>;

    expect(summary.truncated).toBe(2);
    // The window max — unchanged, so the injection cursor keeps its meaning.
    expect(summary.newest_ts).toBe(keptAsk.ts);
    // ...but it is now explicitly labelled as a bounded reading, with the
    // real newest of the filtered set beside it.
    expect(summary.newest_ts_scope).toBe("returned-window");
    expect(summary.newest_ts_total).toBe(skippedNewer.ts);
  });

  it("still advances normally when the window shows everything (no gap)", async () => {
    const a = msg("2026-07-18T10:00:00.000Z", "m1");
    const b = msg("2026-07-18T10:05:00.000Z", "m2");
    M.readInbox.mockImplementation(async () => [a, b]);

    const out = await callInbox({ limit: 50 });
    const summary = out.summary as Record<string, unknown>;

    expect(summary.truncated).toBe(0);
    // No truncation ⇒ no scope markers, and the cursor advances as before.
    expect(summary.newest_ts_scope).toBeUndefined();
    expect(summary.newest_ts_total).toBeUndefined();
    expect(M.writeWatermark).toHaveBeenCalledWith("owner-a", {
      messages_shown_ts: b.ts,
    });
  });
});

describe("receiptSafeShownTs", () => {
  const e = (ts: string, id: string) => ({ ts, msg_id: id });

  it("returns the window max when every population entry was shown", () => {
    const shown = [e("2026-07-18T10:00:00.000Z", "a"), e("2026-07-18T11:00:00.000Z", "b")];
    expect(receiptSafeShownTs(shown, shown)).toBe("2026-07-18T11:00:00.000Z");
  });

  it("stops below the oldest UNSHOWN entry rather than claiming it was seen", () => {
    const shown = [e("2026-07-18T09:00:00.000Z", "a"), e("2026-07-18T12:00:00.000Z", "c")];
    const population = [...shown, e("2026-07-18T11:00:00.000Z", "b-unshown")];
    // 12:00 would claim the unshown 11:00 was seen; 09:00 is the newest safe ts.
    expect(receiptSafeShownTs(shown, population)).toBe("2026-07-18T09:00:00.000Z");
  });

  it("returns null when no shown ts is below the oldest unshown entry", () => {
    const shown = [e("2026-07-18T12:00:00.000Z", "c")];
    const population = [...shown, e("2026-07-18T09:00:00.000Z", "a-unshown")];
    expect(receiptSafeShownTs(shown, population)).toBeNull();
  });

  it("treats an entry with no usable msg_id/ts as UNSHOWN (fails toward not-seen)", () => {
    const shown = [e("2026-07-18T12:00:00.000Z", "c")];
    const population = [...shown, { ts: "2026-07-18T10:00:00.000Z" }];
    expect(receiptSafeShownTs(shown, population)).toBeNull();
  });

  it("is unaffected by population order", () => {
    const shown = [e("2026-07-18T09:00:00.000Z", "a")];
    const population = [e("2026-07-18T11:00:00.000Z", "z-unshown"), ...shown];
    expect(receiptSafeShownTs(shown, population)).toBe("2026-07-18T09:00:00.000Z");
  });
});
