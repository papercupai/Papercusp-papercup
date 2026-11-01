/**
 * coord:inbox — WI-1444 severe-event condition lifecycle (resolution supersede).
 * Pure annotation (annotateResolvedConditions) + handler-level pin with mocked
 * deps (same seam layout as coord-inbox-cache.test.ts; cachedRead pass-through).
 * Pins:
 *   • an alarm whose condition_key has a STRICTLY-LATER resolves_condition is
 *     annotated resolved:true + resolved_at;
 *   • the resolution row itself is NOT self-annotated (rts > ts is strict);
 *   • a re-alarm AFTER the latest resolution stays un-annotated (still live);
 *   • unrelated keys/entries pass through untouched (and no allocation churn
 *     when no resolutions exist);
 *   • handler end-to-end: readInbox → entries carry the annotation, and the
 *     resolution scan runs over the FULL read (alarm annotated even when the
 *     resolution row is pushed out of the `limit` window... resolution being
 *     newest it stays in-window; the alarm-outside-window case is the one the
 *     full-`all` scan protects).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/inbox-condition-lifecycle.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  readInbox: vi.fn(async () => [] as unknown[]),
  getPresence: vi.fn(async (): Promise<unknown> => null),
  claims: vi.fn(async (): Promise<Array<{ workItemId: string }>> => []),
  fleets: vi.fn(async () => new Map<string, { fleetSlug: string }>()),
  latestConditionEnvelope: vi.fn(async (_key: string) => null as Record<string, unknown> | null),
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
vi.mock("./conditions", () => ({ readLatestConditionEnvelope: M.latestConditionEnvelope }));
vi.mock("../presence", () => ({
  heartbeatPresence: vi.fn(async () => {}),
  getPresence: M.getPresence,
}));
vi.mock('../../../work-item-claims', () => ({ listActiveClaimFreshnessForOwner: M.claims }));
vi.mock('../presence-fleet', () => ({ fetchPresenceFleet: M.fleets }));
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
vi.mock("../../../coord-schema", () => ({
  renderInjection: (rows: Array<Record<string, unknown>>) => rows.map(row => row.summary).join('\n'),
}));
vi.mock("../../../cache", () => ({
  cachedRead: async (
    _ctx: unknown,
    _key: unknown,
    fn: () => Promise<unknown>,
  ) => fn(),
}));

import tool, { annotateResolvedConditions } from "./inbox";

const ctx = (ownerId = "owner-a"): never =>
  ({ ownerId, workspaceId: "ws", metadata: vi.fn(), log: vi.fn(), progress: vi.fn() }) as never;

type InboxOut = {
  entries: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
  injection: string;
  system_notices_irrelevant?: number;
};
const callInbox = async (args: Record<string, unknown> = {}): Promise<InboxOut> => {
  const res = (await tool.handler(args as never, ctx())) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0]!.text) as InboxOut;
};

const alarm = (ts: string, key: string, extra: Record<string, unknown> = {}) => ({
  ts,
  msg_id: `m-${ts}`,
  from: "system-watchdog",
  to: ["*"],
  kind: "message",
  category: "severe-event",
  summary: `alarm ${key}`,
  condition_key: key,
  ...extra,
});
const resolution = (ts: string, key: string) => ({
  ts,
  msg_id: `r-${ts}`,
  from: "system-watchdog",
  to: ["*"],
  kind: "message",
  category: "severe-event-resolved",
  summary: `recovered ${key}`,
  condition_key: key,
  resolves_condition: key,
});

beforeEach(() => {
  vi.clearAllMocks();
  M.readInbox.mockImplementation(async () => []);
  M.getPresence.mockImplementation(async () => null);
  M.claims.mockImplementation(async () => []);
  M.fleets.mockImplementation(async () => new Map());
  M.latestConditionEnvelope.mockImplementation(async () => null);
});

describe('native notice scope preserves the public inbox view', () => {
  it('filters unrelated injections using live claims while retaining VIEW entries', async () => {
    const rows = [alarm('2026-10-13T00:00:00Z', 'compaction:other', { auto: true }),
      alarm('2026-10-13T00:01:00Z', 'work-item:WI-123', { auto: true }),
      alarm('2026-10-13T00:02:00Z', 'compaction:other-directed', { auto: true, to: ['owner-a'] })];
    M.readInbox.mockResolvedValue(rows);
    M.getPresence.mockResolvedValue({ currentPlanSlug: 'my-plan', currentFiles: [], contextTokens: null });
    M.claims.mockResolvedValue([{ workItemId: 'WI-123' }]);
    const native = await callInbox({ __systemNoticeState: {} });
    expect(native.injection.split('\n')).not.toContain('alarm compaction:other');
    expect(native.injection).toContain('alarm work-item:WI-123');
    expect(native.injection).toContain('alarm compaction:other-directed');
    expect(native.system_notices_irrelevant).toBe(1);
    expect(native.entries).toHaveLength(3);
    expect(M.getPresence).toHaveBeenCalledTimes(1);
    const view = await callInbox();
    expect(view.injection.split('\n')).toContain('alarm compaction:other');
    expect(view.system_notices_irrelevant).toBeUndefined();
    expect(view.entries).toHaveLength(3);
  });

  it('keeps native notices when the held-claim scope read fails', async () => {
    M.readInbox.mockResolvedValue([alarm('2026-10-13T00:00:00Z', 'other', { auto: true })]);
    M.getPresence.mockResolvedValue({ currentPlanSlug: 'my-plan', currentFiles: [] });
    M.claims.mockRejectedValue(new Error('claim read unavailable'));
    expect((await callInbox({ __systemNoticeState: {} })).injection).toContain('alarm other');
  });

  it('finds an older relevant notice beyond an unrelated priority window', async () => {
    M.readInbox.mockResolvedValue([
      alarm('2026-10-13T00:00:00Z', 'work-item:WI-123', { auto: true }),
      alarm('2026-10-13T00:01:00Z', 'other-newer', { auto: true }),
    ]);
    M.getPresence.mockResolvedValue({ currentPlanSlug: 'my-plan', currentFiles: [] });
    M.claims.mockResolvedValue([{ workItemId: 'WI-123' }]);
    const native = await callInbox({ __systemNoticeState: {}, limit: 1 });
    expect(native.injection.split('\n')).toContain('alarm work-item:WI-123');
    expect(native.injection).not.toContain('alarm other-newer');
  });

  it('uses the authoritative fleet membership reader once for relevance and control cues', async () => {
    M.readInbox.mockResolvedValue([alarm('2026-10-13T00:00:00Z', 'fleet:my-fleet', { auto: true })]);
    M.getPresence.mockResolvedValue({ currentPlanSlug: null, currentFiles: [] });
    M.fleets.mockResolvedValue(new Map([['owner-a', { fleetSlug: 'my-fleet' }]]));
    expect((await callInbox({ __systemNoticeState: {} })).injection).toContain('alarm fleet:my-fleet');
    expect(M.fleets).toHaveBeenCalledTimes(1);
  });
});

describe("annotateResolvedConditions (pure)", () => {
  it("annotates an alarm with a strictly-later resolution", () => {
    const a = alarm("2026-07-01T10:00:00.000Z", "git-sync-stall:x");
    const r = resolution("2026-07-01T12:00:00.000Z", "git-sync-stall:x");
    const out = annotateResolvedConditions([a, r], [a, r]);
    expect(out[0]).toMatchObject({ resolved: true, resolved_at: r.ts });
    // the resolution row is not self-annotated (strict >)
    expect(out[1]!.resolved).toBeUndefined();
  });

  it("a re-alarm AFTER the latest resolution stays live (un-annotated)", () => {
    const a1 = alarm("2026-07-01T10:00:00.000Z", "k");
    const r = resolution("2026-07-01T11:00:00.000Z", "k");
    const a2 = alarm("2026-07-01T12:00:00.000Z", "k");
    const out = annotateResolvedConditions([a1, r, a2], [a1, r, a2]);
    expect(out[0]!.resolved).toBe(true);
    expect(out[2]!.resolved).toBeUndefined();
  });

  it("unrelated keys and keyless entries pass through untouched", () => {
    const a = alarm("2026-07-01T10:00:00.000Z", "k-a");
    const r = resolution("2026-07-01T12:00:00.000Z", "k-b");
    const plain = { ts: "2026-07-01T11:00:00.000Z", msg_id: "p", kind: "message" };
    const out = annotateResolvedConditions([a, plain, r], [a, plain, r]);
    expect(out[0]!.resolved).toBeUndefined();
    expect(out[1]).toBe(plain); // identity — untouched
  });

  it("no resolutions ⇒ the input array is returned as-is (no churn)", () => {
    const a = alarm("2026-07-01T10:00:00.000Z", "k");
    const entries = [a];
    expect(annotateResolvedConditions(entries, entries)).toBe(entries);
  });

  it("EI-9030b: ONE coalesced resolution (resolves_conditions[]) supersedes EVERY listed alarm", () => {
    const aX = alarm("2026-07-01T10:00:00.000Z", "git-sync-stall:x");
    const aY = alarm("2026-07-01T10:05:00.000Z", "git-sync-stall:y");
    const aZ = alarm("2026-07-01T10:07:00.000Z", "git-sync-stall:z");
    const many = {
      ts: "2026-07-01T12:00:00.000Z",
      msg_id: "r-many",
      from: "system-watchdog",
      to: ["*"],
      kind: "message",
      category: "severe-event-resolved",
      summary: "git-sync RECOVERED on 3 harnesses",
      // the plural array + the singular first-key stamp broadcastSevereEventResolvedMany emits
      resolves_conditions: ["git-sync-stall:x", "git-sync-stall:y", "git-sync-stall:z"],
      resolves_condition: "git-sync-stall:x",
      condition_key: "git-sync-stall:x",
    };
    const all = [aX, aY, aZ, many];
    const out = annotateResolvedConditions(all, all);
    expect(out[0]).toMatchObject({ resolved: true, resolved_at: many.ts }); // x
    expect(out[1]).toMatchObject({ resolved: true, resolved_at: many.ts }); // y (plural-only)
    expect(out[2]).toMatchObject({ resolved: true, resolved_at: many.ts }); // z (plural-only)
  });
});

describe("coord:inbox handler (end-to-end annotation)", () => {
  it("returns the stale alarm annotated resolved:true", async () => {
    const a = alarm("2026-07-01T10:00:00.000Z", "git-sync-stall:papercusp");
    const r = resolution("2026-07-01T12:00:00.000Z", "git-sync-stall:papercusp");
    M.readInbox.mockImplementation(async () => [a, r]);
    const out = await callInbox();
    const gotAlarm = out.entries.find((e) => e.msg_id === a.msg_id)!;
    const gotRes = out.entries.find((e) => e.msg_id === r.msg_id)!;
    expect(gotAlarm).toMatchObject({ resolved: true, resolved_at: r.ts });
    expect(gotRes.resolved).toBeUndefined();
    expect(M.latestConditionEnvelope).not.toHaveBeenCalled();
  });

  it("annotates a historical alarm when its topic-only resolution was not delivered to this reader", async () => {
    const key = "git-sync-stall:legacy-reader";
    const a = alarm("2026-07-01T10:00:00.000Z", key, { to: ["owner-a"], audience: ["*"] });
    const topicResolution = {
      ...resolution("2026-07-01T12:00:00.000Z", key),
      to: ["topic-subscriber"],
      audience: ["@topic:severe-events"],
    };
    M.readInbox.mockResolvedValue([a]);
    M.latestConditionEnvelope.mockResolvedValue(topicResolution);

    const out = await callInbox();

    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({ resolved: true, resolved_at: topicResolution.ts });
    expect(M.latestConditionEnvelope).toHaveBeenCalledTimes(1);
    expect(M.latestConditionEnvelope).toHaveBeenCalledWith(key);
  });

  it("keeps serving the inbox if the exact-key lifecycle lookup fails", async () => {
    const a = alarm("2026-07-01T10:00:00.000Z", "git-sync-stall:lookup-failure", { to: ["owner-a"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    M.readInbox.mockResolvedValue([a]);
    M.latestConditionEnvelope.mockRejectedValueOnce(new Error("pg unavailable"));
    try {
      const out = await callInbox();
      expect(out.entries[0]).toMatchObject({ msg_id: a.msg_id });
      expect(out.entries[0]!.resolved).toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("scans resolutions over the FULL read: alarm outside the limit window is not the annotated one, but an in-window alarm resolves against an in-window resolution with limit=1 keeping only the newest", async () => {
    const a = alarm("2026-07-01T10:00:00.000Z", "k");
    const r = resolution("2026-07-01T12:00:00.000Z", "k");
    M.readInbox.mockImplementation(async () => [a, r]);
    // limit=1 keeps only the newest entry (the resolution). The alarm is out of
    // the window; the resolution itself must not be self-annotated.
    const out = await callInbox({ limit: 1 });
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]!.msg_id).toBe(r.msg_id);
    expect(out.entries[0]!.resolved).toBeUndefined();
  });

  it("live (unresolved) alarms stay un-annotated end-to-end", async () => {
    const a = alarm("2026-07-01T10:00:00.000Z", "k-live");
    M.readInbox.mockImplementation(async () => [a]);
    const out = await callInbox();
    expect(out.entries[0]!.resolved).toBeUndefined();
  });
});
