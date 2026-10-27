/**
 * coord:inbox — EI-6144 ambient/broadcast coalescing (read-time ×N fold).
 * Pure fold (coalesceRepeatedBroadcasts) + handler-level pins with mocked deps
 * (same seam layout as coord-inbox-cache.test.ts; cachedRead pass-through).
 * Pins:
 *   • identical (from, kind, category, summary) broadcasts to '*' collapse to
 *     ONE row — the NEWEST — annotated repeat_count + first_seen_ts;
 *   • direct messages and uncategorized broadcasts NEVER coalesce (a peer
 *     legitimately repeating itself is not a firehose);
 *   • no duplicates ⇒ the input array is returned as-is (no churn);
 *   • handler: the fold runs BEFORE the `limit` slice, so repetition no longer
 *     crowds distinct signal out of the window; summary.coalesced_dupes counts
 *     the folded rows;
 *   • composition with WI-1444: a coalesced stale alarm still gets the
 *     resolved:true annotation (fold first, annotate the representative).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/inbox-coalesce.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  readInbox: vi.fn(async () => [] as unknown[]),
  renderInjection: vi.fn((_entries: unknown[], _options?: unknown) => ''),
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
}));
vi.mock("../presence", () => ({
  heartbeatPresence: vi.fn(async () => {}),
  getPresence: vi.fn(async () => null),
}));
vi.mock("../watermarks", () => ({
  readWatermark: vi.fn(async () => ({ messages_shown_ts: "" })),
  writeWatermark: vi.fn(async () => {}),
}));
vi.mock("@papercusp/coordination/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@papercusp/coordination/core")>()),
  emptyWatermark: () => ({ messages_shown_ts: "" }),
  COORD_EXECUTABLE_KINDS: ["yield", "handoff", "ack"],
  COORD_CONVERSATIONAL_KINDS: ["message", "notify"],
}));
vi.mock("../presence-snapshot", () => ({
  resolvePresenceScope: async () => ({}),
  assemblePresenceSnapshot: async () => ({}),
  renderPresenceRebootstrapBlock: () => "",
  consumePresenceRebootstrap: async () => null,
}));
vi.mock("../../../coord-schema", () => ({ renderInjection: M.renderInjection }));
vi.mock("../../../cache", () => ({
  cachedRead: async (
    _ctx: unknown,
    _key: unknown,
    fn: () => Promise<unknown>,
  ) => fn(),
}));

import tool, {
  coalesceRepeatedBroadcasts,
  inboxDefaultWindowChars,
  inboxPriorityBucket,
  prioritizedInboxWindow,
} from "./inbox";

type InboxContextOverrides = {
  contextTier?: "trimmed" | "standard" | "full";
  payloadTierOverride?: "trimmed" | "standard" | "full";
};
const ctx = (ownerId = "owner-a", over: InboxContextOverrides = {}): never =>
  ({ ownerId, workspaceId: "ws", metadata: vi.fn(), log: vi.fn(), progress: vi.fn(), ...over }) as never;

type InboxOut = {
  entries: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
  __systemNoticeState?: Record<string, string>;
  system_notices_suppressed?: number;
};
const callInbox = async (
  args: Record<string, unknown> = {},
  over: InboxContextOverrides = {},
): Promise<InboxOut> => {
  const res = (await tool.handler(args as never, ctx("owner-a", over))) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0]!.text) as InboxOut;
};

/** ts helper: minute `m` on a fixed day, zero-padded. */
const at = (m: number) =>
  `2026-07-01T10:${String(m).padStart(2, "0")}:00.000Z`;

const broadcast = (
  m: number,
  summary: string,
  over: Record<string, unknown> = {},
) => ({
  ts: at(m),
  msg_id: `m-${m}`,
  from: "system-watchdog",
  to: ["*"],
  kind: "message",
  category: "doc-drift",
  summary,
  ...over,
});
const direct = (m: number, summary: string) => ({
  ts: at(m),
  msg_id: `d-${m}`,
  from: "peer",
  to: ["owner-a"],
  kind: "message",
  category: "doc-drift",
  summary,
});

beforeEach(() => {
  vi.clearAllMocks();
  M.readInbox.mockImplementation(async () => []);
});

describe('native notice delivery versus public inbox VIEW', () => {
  it('passes committed notice state to injection filtering while the public VIEW stays repeatable', async () => {
    const row = broadcast(1, 'Compaction over-limit: other', {
      auto: true, category: 'severe-event', condition_key: 'compaction:other',
    });
    M.readInbox.mockResolvedValue([row]);
    const first = await callInbox({ __systemNoticeState: {} });
    expect(M.renderInjection.mock.calls.at(-1)?.[0]).toEqual([row]);
    expect(first.__systemNoticeState).toBeDefined();
    const repeated = await callInbox({ __systemNoticeState: first.__systemNoticeState });
    expect(M.renderInjection.mock.calls.at(-1)?.[0]).toEqual([]);
    expect(repeated.system_notices_suppressed).toBe(1);
    const view = await callInbox();
    expect(M.renderInjection.mock.calls.at(-1)?.[0]).toEqual([row]);
    expect(view.__systemNoticeState).toBeUndefined();
    expect(view.entries).toHaveLength(1);
  });
});

describe("coalesceRepeatedBroadcasts (pure)", () => {
  it("collapses identical categorized broadcasts to the newest row with repeat_count + first_seen_ts", () => {
    const rows = [
      broadcast(1, "docs drifted"),
      broadcast(2, "something else"),
      broadcast(3, "docs drifted"),
      broadcast(5, "docs drifted"),
    ];
    const out = coalesceRepeatedBroadcasts(rows);
    expect(out.map((e) => e.msg_id)).toEqual(["m-2", "m-5"]);
    expect(out[1]).toMatchObject({
      repeat_count: 3,
      first_seen_ts: at(1),
      ts: at(5),
    });
    // the singleton is untouched (no repeat_count noise)
    expect(out[0]!.repeat_count).toBeUndefined();
  });

  it("direct messages never coalesce, even when verbatim-identical", () => {
    const rows = [direct(1, "same"), direct(2, "same"), direct(3, "same")];
    expect(coalesceRepeatedBroadcasts(rows)).toHaveLength(3);
  });

  it("uncategorized broadcasts never coalesce", () => {
    const rows = [
      broadcast(1, "same", { category: undefined }),
      broadcast(2, "same", { category: undefined }),
    ];
    expect(coalesceRepeatedBroadcasts(rows)).toHaveLength(2);
  });

  it("different senders / categories / kinds stay distinct", () => {
    const rows = [
      broadcast(1, "same"),
      broadcast(2, "same", { from: "other-sender" }),
      broadcast(3, "same", { category: "severe-event" }),
      broadcast(4, "same", { kind: "notify" }),
    ];
    expect(coalesceRepeatedBroadcasts(rows)).toHaveLength(4);
  });

  it("no duplicates ⇒ the input array is returned as-is (no churn)", () => {
    const rows = [broadcast(1, "a"), broadcast(2, "b")];
    expect(coalesceRepeatedBroadcasts(rows)).toBe(rows);
  });

  // EI-6144 residual: the item asked to key on a NORMALIZED summary; the original
  // landed keying on the verbatim one, so any broadcast templating a live instant
  // into its text never coalesced. Measured on 24h of live ambient traffic
  // (2026-08-03): 111 rows across 4 groups, all rate-limit pauses — the single
  // worst was 60 rows for ONE ongoing condition.
  it("an embedded ISO-8601 instant does not split a group (the rate-limit pause case)", () => {
    const rows = [
      broadcast(1, '⏳ rate-limit — bucket "haiku" paused until 2026-08-03T17:04:11Z'),
      broadcast(2, '⏳ rate-limit — bucket "haiku" paused until 2026-08-03T17:09:48Z'),
      broadcast(3, '⏳ rate-limit — bucket "haiku" paused until 2026-08-03T17:15:02.317Z'),
    ];
    const out = coalesceRepeatedBroadcasts(rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ repeat_count: 3, first_seen_ts: at(1) });
    // the SURVIVING row keeps its own verbatim summary — the newest instant, not
    // a placeholder — so the reader still learns when the pause actually lifts.
    expect(out[0]!.summary).toBe(
      '⏳ rate-limit — bucket "haiku" paused until 2026-08-03T17:15:02.317Z',
    );
  });

  // The narrowness is the point, and it is the property most likely to be
  // "improved" away later: blanking every digit scored higher (161 rows vs 111)
  // by folding messages that genuinely differ. A count is signal; an instant is
  // noise. If this test starts failing, the normalisation got too aggressive.
  it("bare integers are PRESERVED — differing counts stay distinct rows", () => {
    const rows = [
      broadcast(1, "deploy stale: the release pin is 3 commits behind tip"),
      broadcast(2, "deploy stale: the release pin is 40 commits behind tip"),
    ];
    expect(coalesceRepeatedBroadcasts(rows)).toHaveLength(2);
  });

  it("a differing instant still cannot merge across sender/category/kind", () => {
    const rows = [
      broadcast(1, "paused until 2026-08-03T17:04:11Z"),
      broadcast(2, "paused until 2026-08-03T17:09:48Z", { from: "other-sender" }),
    ];
    expect(coalesceRepeatedBroadcasts(rows)).toHaveLength(2);
  });
});

describe("coord:inbox handler (fold before the limit window)", () => {
  it("repetition no longer crowds distinct signal out of a small window", async () => {
    const rows: Array<Record<string, unknown>> = [];
    // 3 distinct old messages, then 30 identical watchdog repeats on top.
    rows.push(direct(1, "distinct one"));
    rows.push(direct(2, "distinct two"));
    rows.push(direct(3, "distinct three"));
    for (let m = 10; m < 40; m++) rows.push(broadcast(m, "git-sync STALLED on x"));
    M.readInbox.mockImplementation(async () => rows);

    // The direct()/broadcast() helpers carry category "doc-drift", which is now
    // AMBIENT-excluded by default (EI-2871); this test exercises the coalesce+window
    // fold, so opt the ambient rows back in so they reach the fold.
    const out = await callInbox({ limit: 5, include_ambient: true });
    // 33 raw rows → 4 coalesced (3 distinct + 1 ×30 representative); all fit.
    expect(out.summary).toMatchObject({
      total: 33,
      coalesced_dupes: 29,
      returned: 4,
      truncated: 0,
    });
    const rep = out.entries.find((e) => e.repeat_count !== undefined)!;
    expect(rep).toMatchObject({
      msg_id: "m-39",
      repeat_count: 30,
      first_seen_ts: at(10),
    });
    expect(out.entries.map((e) => e.summary)).toContain("distinct one");
  });

  it("composes with WI-1444: a coalesced stale alarm carries resolved:true", async () => {
    const rows: Array<Record<string, unknown>> = [
      broadcast(1, "git-sync STALLED on x", {
        category: "severe-event",
        condition_key: "git-sync-stall:x",
      }),
      broadcast(2, "git-sync STALLED on x", {
        category: "severe-event",
        condition_key: "git-sync-stall:x",
      }),
      broadcast(9, "git-sync RECOVERED on x", {
        category: "severe-event-resolved",
        condition_key: "git-sync-stall:x",
        resolves_condition: "git-sync-stall:x",
      }),
    ];
    M.readInbox.mockImplementation(async () => rows);
    const out = await callInbox();
    const rep = out.entries.find((e) => e.repeat_count !== undefined)!;
    expect(rep).toMatchObject({
      msg_id: "m-2",
      repeat_count: 2,
      resolved: true,
      resolved_at: at(9),
    });
  });
});

describe("coord:inbox handler (doc-drift ambient exclusion — EI-2871)", () => {
  // A `system:doc-freshness` RE-VERIFY digest, broadcast to '*' every git-sync tick.
  const docDrift = (m: number, summary: string) => ({
    ts: at(m),
    msg_id: `dd-${m}`,
    from: "system:doc-freshness",
    to: ["*"],
    kind: "message",
    category: "doc-drift",
    summary,
  });
  // A DIRECTED peer message. Even if it carries an ambient category, delivery
  // to a concrete owner makes it actionable and it must remain visible.
  const peerPing = (m: number, summary: string, category?: string) => ({
    ts: at(m),
    msg_id: `p-${m}`,
    from: "peer",
    to: ["owner-a"],
    kind: "message",
    summary,
    ...(category ? { category } : {}),
  });

  it("excludes doc-drift digests from the default read (unburying directed messages); include_ambient opts back in", async () => {
    // The exact EI-2826 harm: a directed 'details inside' build-blocker drowned by
    // a doc-drift flood. Distinct summaries so the two digests do NOT coalesce.
    const rows = [
      peerPing(1, "tree-dep build blocker, details inside"),
      docDrift(2, "📄 papercusp: 3 doc(s) drifted — A"),
      docDrift(3, "📄 papercusp: 5 doc(s) drifted — B"),
    ];
    M.readInbox.mockImplementation(async () => rows);

    // DEFAULT: both doc-drift digests are excluded; only the directed message survives.
    const def = await callInbox();
    expect(def.summary).toMatchObject({ ambient_excluded: 2, total: 1 });
    expect(def.entries).toHaveLength(1);
    expect(def.entries[0]!.summary).toBe("tree-dep build blocker, details inside");
    expect(def.entries.some((e) => e.category === "doc-drift")).toBe(false);

    // OPT-IN: include_ambient surfaces the digests again (nothing is lost, just hidden).
    const inc = await callInbox({ include_ambient: true });
    expect(inc.summary).toMatchObject({ ambient_excluded: 0, total: 3 });
    expect(inc.entries.filter((e) => e.category === "doc-drift")).toHaveLength(2);
  });

  it("never suppresses an ambient-labelled message addressed to an agent", async () => {
    const rows = [
      peerPing(1, "your service needs attention", "service-health"),
      peerPing(2, "this document is assigned to you", "doc-drift"),
      { ...peerPing(3, "mixed broadcast and direct", "agent-governor"), to: ["*", "owner-a"] },
    ];
    M.readInbox.mockImplementation(async () => rows);

    const out = await callInbox();
    expect(out.summary).toMatchObject({ ambient_excluded: 0, total: 3 });
    // P-009: same-priority rows render newest-first in the default inbox window.
    expect(out.entries.map((entry) => entry.msg_id)).toEqual(["p-3", "p-2", "p-1"]);
  });
});

describe("coord:inbox P-009 priority and ambient broadcast defaults", () => {
  it("default-excludes deploy/perf/migration/task-manager broadcasts but preserves direct messages", async () => {
    const rows = [
      broadcast(1, "deploy status", { category: "deploy" }),
      broadcast(2, "release deploy status", { category: "release-deploy" }),
      broadcast(3, "perf status", { category: "perf" }),
      broadcast(4, "migration status", { category: "migration" }),
      broadcast(5, "task manager status", { category: "task-manager" }),
      direct(5, "deploy action for you"),
    ];
    M.readInbox.mockImplementation(async () => rows);

    const out = await callInbox();
    expect(out.summary).toMatchObject({ ambient_excluded: 5, total: 1 });
    expect(out.entries.map((e) => e.msg_id)).toEqual(["d-5"]);

    const inc = await callInbox({ include_ambient: true });
    expect(inc.summary).toMatchObject({ ambient_excluded: 0, total: 6 });
  });

  it("orders action/answer asks before claim/dependency/same-fleet traffic, then ordinary rows", async () => {
    const rows = [
      direct(1, "ordinary-old"),
      { ...direct(2, "same fleet"), audience: ["@fleet:goal-drain-work-on-everything-070565"] },
      { ...direct(3, "claim"), lifecycle: "claim" },
      { ...direct(4, "answer me"), expects: "answer" },
      direct(5, "ordinary-new"),
      { ...direct(6, "act on this"), expects: "action" },
    ];
    M.readInbox.mockImplementation(async () => rows);

    const out = await callInbox({ limit: 4 });
    expect(out.entries.map((e) => e.summary)).toEqual([
      "act on this",
      "answer me",
      "claim",
      "same fleet",
    ]);
    expect(out.summary).toMatchObject({ total: 6, returned: 4, truncated: 2 });
    expect(out.summary.newest_ts).toBe(at(6));
    expect(out.summary.oldest_returned_ts).toBe(at(2));
  });

  it("pure priority helpers bucket and window rows before a display limit", () => {
    expect(inboxPriorityBucket({ expects: "action" })).toBe(0);
    expect(inboxPriorityBucket({ expectsReply: true })).toBe(0);
    expect(inboxPriorityBucket({ lifecycle: "dependency" })).toBe(1);
    expect(inboxPriorityBucket({ audience: "@fleet:x" })).toBe(1);
    expect(inboxPriorityBucket({ summary: "plain" })).toBe(2);

    const rows = [
      { msg_id: "plain", ts: at(9), summary: "plain" },
      { msg_id: "ask", ts: at(1), summary: "ask", expects: "answer" },
    ];
    expect(prioritizedInboxWindow(rows, 1).map((e) => e.msg_id)).toEqual(["ask"]);
  });
});

describe("coord:inbox includeAmbient compatibility alias (EI-20224620909324295)", () => {
  const ambient = {
    ts: at(1),
    msg_id: "ambient-1",
    from: "system:doc-freshness",
    to: ["*"],
    kind: "message",
    category: "doc-drift",
    summary: "ambient digest",
  };

  it("accepts the camelCase alias while retaining strict unknown-key rejection", () => {
    expect(tool.args.safeParse({ include_ambient: true }).success).toBe(true);
    expect(tool.args.safeParse({ includeAmbient: true }).success).toBe(true);
    expect(tool.args.safeParse({ includeAmbien: true }).success).toBe(false);
  });

  it("maps the alias to the canonical ambient filter and gives snake_case precedence", async () => {
    M.readInbox.mockImplementation(async () => [ambient]);

    // WI-6554700010029664: the alias folds in the schema's preprocess, so dispatch-parse first.
    const alias = await callInbox(tool.args.parse({ includeAmbient: true }) as never);
    expect(alias.summary).toMatchObject({ ambient_excluded: 0, total: 1 });

    const canonicalWins = await callInbox(tool.args.parse({ include_ambient: false, includeAmbient: true }) as never);
    expect(canonicalWins.summary).toMatchObject({ ambient_excluded: 1, total: 0 });
  });
});

describe("coord:inbox handler (default raw-entry budget)", () => {
  const longPeerPing = (m: number) => ({
    ts: at(m),
    msg_id: `lp-${m}`,
    from: "peer",
    to: ["owner-a"],
    kind: "message",
    summary: `message ${m} ${"x".repeat(1000)}`,
  });

  it("keeps a 50-row read tight while honoring explicit max_body_chars", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => longPeerPing(i));
    M.readInbox.mockImplementation(async () => rows);

    // An explicit limit is not door-fitted (P-006 D-002), so all 50 rows come back
    // at the per-entry share of INBOX_ENTRY_BUDGET.
    const wide = await callInbox({ limit: 50 });
    expect(wide.entries).toHaveLength(50);
    expect(wide.entries[0]!.summary_truncated).toBe(true);
    expect(String(wide.entries[0]!.summary).length).toBe(300);
    expect(wide.summary).not.toHaveProperty("fitted_to_result");

    // A no-args read is fitted to the caller's result door at that same cap, and says so.
    const def = await callInbox();
    expect(def.entries.length).toBeGreaterThan(0);
    expect(def.entries.length).toBeLessThan(50);
    expect(String(def.entries[0]!.summary).length).toBe(300);
    expect(JSON.stringify(def.entries).length).toBeLessThanOrEqual(inboxDefaultWindowChars("owner-a"));
    expect(def.summary["fitted_to_result"]).toMatchObject({ omitted: 50 - def.entries.length });

    const explicit = await callInbox({ max_body_chars: 800 });
    expect(explicit.entries).toHaveLength(50);
    expect(explicit.entries[0]!.summary_truncated).toBe(true);
    expect(String(explicit.entries[0]!.summary).length).toBe(800);
  });

  it("honors an explicit full payload tier for raw entry content", async () => {
    const body = `operative constraint ${"x".repeat(1400)}`;
    M.readInbox.mockImplementation(async () => [
      {
        ts: at(1),
        msg_id: "full-1",
        from: "peer",
        to: ["owner-a"],
        kind: "message",
        summary: "short summary",
        body,
      },
    ]);

    const ambientTrimmed = await callInbox({}, { contextTier: "trimmed" });
    expect(String(ambientTrimmed.entries[0]!.body).length).toBe(250);
    expect(ambientTrimmed.entries[0]!.body_truncated).toBe(true);

    const explicitFull = await callInbox({}, {
      contextTier: "trimmed",
      payloadTierOverride: "full",
    });
    expect(explicitFull.entries[0]!.body).toBe(body);
    expect(explicitFull.entries[0]!.body_truncated).toBeUndefined();
  });
});
