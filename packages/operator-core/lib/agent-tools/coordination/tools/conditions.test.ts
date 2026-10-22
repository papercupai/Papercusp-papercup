/**
 * coord:conditions — folding condition-keyed severe-event broadcasts into live
 * open/resolved STATE (EI-6138; the WI-1444 lifecycle reader). Pure fold +
 * handler pins with the coord log seam mocked (non-PG path). Pins:
 *   • an un-resolved alarm is OPEN; alarm+later-resolution is RESOLVED;
 *   • a re-alarm AFTER the latest resolution re-OPENS the key;
 *   • repeated alarms fold: alarm_count, first_seen, last_seen, latest summary;
 *   • a resolution for a never-seen key records as resolved, never open;
 *   • ordering: open first, then most-recently-active;
 *   • handler: open/resolved split, include_resolved:false, resolved_limit.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conditions.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  readLines: vi.fn(async () => [] as unknown[]),
  pgFastPath: false,
  pgQuery: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  workspaceId: "ws-test",
  pgHandle: null as ((...args: unknown[]) => Promise<unknown[]>) | null,
}));

vi.mock("../log", () => ({
  coordLog: { readLines: M.readLines },
  coordSql: () => M.pgHandle ?? M.pgQuery,
  coordWorkspaceId: () => M.workspaceId,
  coordHasPgFastPath: () => M.pgFastPath,
}));

import tool, {
  CONDITIONS_FAST_PATH_ROW_CAP,
  computeConditionStates,
  readConditionEnvelopes,
  readConditionEnvelopesForKey,
  readConditionEnvelopesForPrefix,
  readLatestConditionEnvelope,
} from "./conditions";

const ctx = (): never =>
  ({ ownerId: "owner-a", workspaceId: "ws-test", metadata: vi.fn(), log: vi.fn(), progress: vi.fn() }) as never;

type Out = {
  open_count: number;
  open: Array<Record<string, unknown>>;
  resolved_count: number;
  resolved: Array<Record<string, unknown>>;
  condition_key?: string;
  condition_found?: boolean;
};
const call = async (args: Record<string, unknown> = {}): Promise<Out> => {
  const res = (await tool.handler(args as never, ctx())) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0]!.text) as Out;
};

const at = (m: number) => `2026-07-01T10:${String(m).padStart(2, "0")}:00.000Z`;
const alarm = (m: number, key: string, summary = `alarm ${key}`) => ({
  ts: at(m),
  msg_id: `a-${key}-${m}`,
  from: "system-watchdog",
  to: ["*"],
  kind: "message",
  category: "severe-event",
  summary,
  condition_key: key,
});
const resolution = (m: number, key: string, summary = `recovered ${key}`) => ({
  ts: at(m),
  msg_id: `r-${key}-${m}`,
  from: "system-watchdog",
  to: ["*"],
  kind: "message",
  category: "severe-event-resolved",
  summary,
  condition_key: key,
  resolves_condition: key,
});
/** EI-9030b batched resolution — broadcastSevereEventResolvedMany's shape:
 *  `resolves_conditions` (plural array) naming every key it supersedes, PLUS the
 *  singular `resolves_condition`/`condition_key` stamped to the first key only
 *  (byte-compat for a reader that only knows the singular shape). */
const resolutionMany = (m: number, keys: string[], summary = `RECOVERED (${keys.join(", ")})`) => ({
  ts: at(m),
  msg_id: `rm-${m}`,
  from: "system-watchdog",
  to: ["*"],
  kind: "message",
  category: "severe-event-resolved",
  summary,
  resolves_conditions: keys,
  resolves_condition: keys[0],
  condition_key: keys[0],
});
const heartbeat = (m: number, key: string, summary = `alarm ${key}`) => ({
  ...alarm(m, key, summary),
  to: [],
  condition_heartbeat: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  M.readLines.mockImplementation(async () => []);
  M.pgFastPath = false;
  M.pgQuery.mockImplementation(async (..._args: unknown[]) => []);
  M.workspaceId = "ws-test";
  M.pgHandle = null;
});

describe("concurrent PG condition readers", () => {
  it("shares one bounded query across a watchdog burst without losing the fold", async () => {
    M.pgFastPath = true;
    let release!: (rows: unknown[]) => void;
    const pending = new Promise<unknown[]>((resolve) => { release = resolve; });
    M.pgQuery.mockImplementation(() => pending);
    const reads = Array.from({ length: 40 }, () => call());
    const queriesWhilePending = M.pgQuery.mock.calls.length;
    release([{ body: JSON.stringify(resolution(2, "shared")) }, { body: alarm(1, "shared") }]);
    const results = await Promise.all(reads);

    expect(queriesWhilePending).toBe(1);
    expect(M.pgQuery).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.open_count).toBe(0);
      expect(result.resolved[0]).toMatchObject({ condition_key: "shared", resolved_at: at(2) });
    }
  });

  it("reads fresh state immediately after settlement instead of caching a resolved alarm", async () => {
    M.pgFastPath = true;
    M.pgQuery.mockResolvedValueOnce([{ body: alarm(1, "fresh") }]);
    M.pgQuery.mockResolvedValueOnce([{ body: resolution(2, "fresh") }, { body: alarm(1, "fresh") }]);

    expect((await call()).open_count).toBe(1);
    expect((await call()).open_count).toBe(0);
    expect(M.pgQuery).toHaveBeenCalledTimes(2);
  });

  it("propagates a shared query failure and lets the next read retry without a seam fallback", async () => {
    M.pgFastPath = true;
    let fail!: (error: Error) => void;
    M.pgQuery.mockImplementation(() => new Promise<unknown[]>((_resolve, reject) => { fail = reject; }));
    const reads = [readConditionEnvelopes(), readConditionEnvelopes()];
    fail(new Error("condition PG unavailable"));
    const results = await Promise.allSettled(reads);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(M.pgQuery).toHaveBeenCalledTimes(1);
    expect(M.readLines).not.toHaveBeenCalled();

    M.pgQuery.mockResolvedValue([{ body: alarm(3, "retry") }]);
    expect((await call()).open[0]?.condition_key).toBe("retry");
    expect(M.pgQuery).toHaveBeenCalledTimes(2);
  });

  it("keeps simultaneous workspace reads separate and captures each workspace before awaiting", async () => {
    M.pgFastPath = true;
    const releases: Array<(rows: unknown[]) => void> = [];
    M.pgQuery.mockImplementation(() => new Promise<unknown[]>((resolve) => { releases.push(resolve); }));
    M.workspaceId = "workspace-a";
    const a = readConditionEnvelopes();
    M.workspaceId = "workspace-b";
    const b = readConditionEnvelopes();
    releases[0]!([{ body: alarm(1, "a") }]);
    releases[1]!([{ body: alarm(1, "b") }]);

    expect((await a)[0]?.condition_key).toBe("a");
    expect((await b)[0]?.condition_key).toBe("b");
    expect(M.pgQuery.mock.calls[0]?.[1]).toBe("workspace-a");
    expect(M.pgQuery.mock.calls[1]?.[1]).toBe("workspace-b");
  });

  it("does not share an in-flight read across a replacement PG backend in the same workspace", async () => {
    M.pgFastPath = true;
    let release!: (rows: unknown[]) => void;
    M.pgQuery.mockImplementation(() => new Promise<unknown[]>((resolve) => { release = resolve; }));
    const original = readConditionEnvelopes();
    const replacement = vi.fn(async () => [{ body: alarm(2, "replacement") }]);
    M.pgHandle = replacement;
    const changed = readConditionEnvelopes();
    release([{ body: alarm(1, "original") }]);

    expect((await original)[0]?.condition_key).toBe("original");
    expect((await changed)[0]?.condition_key).toBe("replacement");
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it("gives readers independent envelope arrays and fold fields", async () => {
    M.pgFastPath = true;
    let release!: (rows: unknown[]) => void;
    M.pgQuery.mockImplementation(() => new Promise<unknown[]>((resolve) => { release = resolve; }));
    const a = readConditionEnvelopes();
    const b = readConditionEnvelopes();
    release([{ body: alarm(1, "independent") }]);
    const [first, second] = await Promise.all([a, b]);
    first[0]!.condition_key = "changed by caller";
    first.pop();
    expect(second).toHaveLength(1);
    expect(second[0]?.condition_key).toBe("independent");
  });
});

describe("computeConditionStates (pure)", () => {
  it("an un-resolved alarm is OPEN with fold fields", () => {
    const [s] = computeConditionStates([
      alarm(1, "k", "first"),
      alarm(5, "k", "latest"),
      alarm(3, "k", "middle"),
    ]);
    expect(s).toMatchObject({
      condition_key: "k",
      open: true,
      alarm_count: 3,
      first_seen: at(1),
      // never-resolved ⇒ the current episode began at the first alarm.
      open_since: at(1),
      last_seen: at(5),
      latest_summary: "latest",
      resolved_at: null,
    });
  });

  it("preserves the latest emitter process identity for one-shot reconciliation", () => {
    const emitter = {
      pid: 4242,
      startedAt: "2026-07-01T09:00:00.000Z",
      uptimeSec: 60,
      cwd: "/repo",
      host: "host-a",
      processIdentity: "linux:boot:4242",
    };
    const [s] = computeConditionStates([
      { ...alarm(1, "origin-freshness:papercusp"), one_shot: true, emitter },
    ]);
    expect(s).toMatchObject({
      condition_key: "origin-freshness:papercusp",
      one_shot: true,
      latest_emitter: emitter,
    });
  });

  it("alarm + later resolution ⇒ RESOLVED; re-alarm after ⇒ re-OPEN", () => {
    const resolved = computeConditionStates([alarm(1, "k"), resolution(2, "k")]);
    // resolved ⇒ no current open episode.
    expect(resolved[0]).toMatchObject({ open: false, resolved_at: at(2), open_since: null });

    const reopened = computeConditionStates([
      alarm(1, "k"),
      resolution(2, "k"),
      alarm(3, "k"),
    ]);
    // EI-10653: the re-alarm opens a FRESH episode — open_since tracks the reopen
    // (at 3), not the first-ever alarm (at 1) which first_seen still pins.
    expect(reopened[0]).toMatchObject({
      open: true,
      alarm_count: 2,
      first_seen: at(1),
      open_since: at(3),
      last_seen: at(3),
    });
  });

  it("EI-14072: a batched resolution naming N keys (resolves_conditions) closes EVERY named key, not just the first", () => {
    const states = computeConditionStates([
      alarm(1, "panel:workItems"),
      alarm(1, "dead-routines"),
      alarm(1, "infra-liveness:panel:overwatch"),
      resolutionMany(5, ["panel:workItems", "dead-routines", "infra-liveness:panel:overwatch"]),
    ]);
    const byKey = new Map(states.map((s) => [s.condition_key, s]));
    for (const key of ["panel:workItems", "dead-routines", "infra-liveness:panel:overwatch"]) {
      expect(byKey.get(key)).toMatchObject({ open: false, resolved_at: at(5), open_since: null });
    }
  });

  it("EI-14072: a batched resolution for keys never seen still records each resolved, never open", () => {
    const states = computeConditionStates([resolutionMany(2, ["ghost-a", "ghost-b"])]);
    expect(states).toHaveLength(2);
    for (const st of states) {
      expect(st).toMatchObject({ open: false, resolved_at: at(2) });
    }
  });

  it("a resolution for a never-seen key records resolved, never open", () => {
    const [s] = computeConditionStates([resolution(2, "ghost")]);
    expect(s).toMatchObject({
      condition_key: "ghost",
      open: false,
      alarm_count: 0,
      resolved_at: at(2),
    });
  });

  it("orders open first, then most-recently-active", () => {
    const states = computeConditionStates([
      alarm(1, "resolved-new"),
      resolution(8, "resolved-new"),
      alarm(2, "open-old"),
      alarm(9, "open-new"),
    ]);
    expect(states.map((s) => s.condition_key)).toEqual([
      "open-new",
      "open-old",
      "resolved-new",
    ]);
  });

  it("WI-6228: folds the emitter's one_shot declaration onto the state", () => {
    const [s] = computeConditionStates([
      { ...alarm(1, "origin-freshness:papercusp"), one_shot: true },
    ]);
    expect(s!.one_shot).toBe(true);
  });

  it("WI-6228: an undeclared alarm folds to one_shot false (legacy emitters unchanged)", () => {
    const [s] = computeConditionStates([alarm(1, "git-sync-stall:pot")]);
    expect(s!.one_shot).toBe(false);
  });

  it("WI-6228: the LATEST alarm decides one_shot — a re-alarm that drops the flag clears it", () => {
    // An emitter converted from one-shot to level-triggered must stop being
    // exempt from absence-resolution; the newest alarm describes it.
    const [s] = computeConditionStates([
      { ...alarm(1, "green-stall:pot"), one_shot: true },
      alarm(5, "green-stall:pot"),
    ]);
    expect(s!.one_shot).toBe(false);
    expect(s!.last_seen).toBe(at(5));
  });

  it("condition_heartbeat refreshes last_seen without becoming a second alarm or replacing alarm metadata", () => {
    const emitter = {
      pid: 4242,
      startedAt: "2026-07-01T09:00:00.000Z",
      uptimeSec: 60,
      cwd: "/repo",
      host: "host-a",
      processIdentity: "linux:boot:4242",
    };
    const [s] = computeConditionStates([
      {
        ...alarm(1, "level-triggered:k", "original summary"),
        body: "original evidence",
        one_shot: true,
        emitter,
      },
      {
        ...heartbeat(5, "level-triggered:k", "heartbeat summary"),
        body: "heartbeat marker",
        one_shot: false,
        emitter: { ...emitter, pid: 9999 },
      },
    ]);

    expect(s).toMatchObject({
      condition_key: "level-triggered:k",
      open: true,
      alarm_count: 1,
      first_seen: at(1),
      open_since: at(1),
      last_seen: at(5),
      latest_summary: "original summary",
      latest_body: "original evidence",
      latest_emitter: emitter,
      one_shot: true,
    });
  });

  it("ignores an orphan heartbeat and does not re-open a condition after recovery", () => {
    expect(computeConditionStates([heartbeat(1, "orphan:k")])).toEqual([]);

    const [s] = computeConditionStates([
      alarm(1, "closed:k"),
      resolution(3, "closed:k"),
      heartbeat(5, "closed:k"),
    ]);
    expect(s).toMatchObject({
      condition_key: "closed:k",
      open: false,
      alarm_count: 1,
      last_seen: at(5),
      latest_summary: "alarm closed:k",
      resolved_at: at(3),
    });
  });

  // ── P-007 (converge-frozen-candidate-by-fix-only-admission-2026-08-27) ──────────
  // The fold is what carries an emitter's `body` — "evidence + the recommended first
  // step" — onto the work-item the condition bridge mints. Folding only `summary`
  // discarded it for every condition family; measured live 2026-08-29, real bodies of
  // 543–1097 chars were being dropped on the floor.
  describe("latest_body — the emitter's fuller body survives the fold", () => {
    it("folds the alarm body alongside its summary", () => {
      const [s] = computeConditionStates([
        { ...alarm(1, "gate-red-streak:papercusp"), body: "WHERE TO FIX IT: the repair worktree" },
      ]);
      expect(s!.latest_body).toBe("WHERE TO FIX IT: the repair worktree");
      // Control: without the fold this field is undefined, not merely empty — so a
      // regression that removed it fails here rather than reading as "no body sent".
      expect(s!.latest_body).not.toBeUndefined();
    });

    it("is null when the emitter sent no body (most watchdogs)", () => {
      const [s] = computeConditionStates([alarm(1, "gate-red-streak:papercusp")]);
      expect(s!.latest_body).toBeNull();
    });

    it("CLEARS on a body-less re-alarm rather than carrying stale evidence forward", () => {
      // latest_body and latest_summary must always describe the SAME alarm. Carrying a
      // previous episode's evidence onto a fresh failure is worse than carrying none:
      // the claimant would act on a recommended first step for a different incident.
      const [s] = computeConditionStates([
        { ...alarm(1, "gate-red-streak:papercusp"), body: "old evidence" },
        alarm(5, "gate-red-streak:papercusp", "a fresh red"),
      ]);
      expect(s!.latest_summary).toBe("a fresh red");
      expect(s!.latest_body).toBeNull();
    });

    it("keeps the OLDER body when an out-of-order envelope is not the latest", () => {
      // The fold guards latest_* on `ts >= last_seen`; body must ride that same guard.
      const [s] = computeConditionStates([
        { ...alarm(5, "gate-red-streak:papercusp"), body: "current evidence" },
        { ...alarm(1, "gate-red-streak:papercusp"), body: "stale evidence" },
      ]);
      expect(s!.latest_body).toBe("current evidence");
    });
  });
});

describe("coord:conditions handler", () => {
  it("declares condition_key in the public argument schema", () => {
    const conditionKey = "loop-dead-man:papercusp";
    expect(Object.keys(tool.args.shape)).toContain("condition_key");
    expect(tool.args.parse({ condition_key: conditionKey })).toMatchObject({ condition_key: conditionKey });
  });

  it("condition_key performs an exact keyed lifecycle read instead of the aggregate scan", async () => {
    M.pgFastPath = true;
    M.pgQuery.mockImplementation(async (..._args: unknown[]) => [
      { body: resolution(4, "target") },
      { body: alarm(2, "target") },
    ]);

    const out = await call({ condition_key: "target" });

    expect(out).toMatchObject({
      condition_key: "target",
      condition_found: true,
      open_count: 0,
      resolved_count: 1,
    });
    expect(out.resolved[0]).toMatchObject({
      condition_key: "target",
      resolved_at: at(4),
    });
    const [template, ...params] = M.pgQuery.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const text = template.join("?");
    expect(text).toContain("body->>'condition_key' =");
    expect(text).toContain("body->>'resolves_condition' =");
    expect(text).toContain("body->'resolves_conditions' ?");
    expect(params).toContain("target");
  });

  it("condition_key filters the non-PG seam and reports an unmatched key", async () => {
    M.readLines.mockImplementation(async () => [alarm(1, "target"), alarm(2, "other")]);

    const found = await call({ condition_key: "target" });
    expect(found).toMatchObject({ condition_key: "target", condition_found: true, open_count: 1 });
    expect(found.open.map((state) => state.condition_key)).toEqual(["target"]);

    const missing = await call({ condition_key: "missing" });
    expect(missing).toMatchObject({ condition_key: "missing", condition_found: false, open_count: 0, resolved_count: 0 });
    expect(missing.open).toEqual([]);
    expect(missing.resolved).toEqual([]);
  });

  it("readConditionEnvelopesForKey includes plural resolutions in the exact lookup", async () => {
    M.readLines.mockImplementation(async () => [
      alarm(1, "target"),
      resolutionMany(2, ["target", "other"]),
      alarm(3, "other"),
    ]);

    const envelopes = await readConditionEnvelopesForKey("target");
    expect(envelopes).toHaveLength(2);
    expect(envelopes.map((envelope) => envelope["resolves_condition"] ?? envelope["condition_key"])).toEqual([
      "target",
      "target",
    ]);
  });

  it("reads prefix-matched alarms and singular or plural resolutions on the non-PG seam", async () => {
    const prefix = "alarm:carry-delivery:host:";
    const other = "alarm:other:host:key";
    M.readLines.mockImplementation(async () => [
      alarm(1, `${prefix}orphan:one`),
      resolution(2, `${prefix}orphan:one`),
      resolutionMany(3, [other, `${prefix}orphan:two`]),
      alarm(4, other),
    ]);

    const envelopes = await readConditionEnvelopesForPrefix(prefix);

    expect(envelopes).toHaveLength(3);
    expect(envelopes.some((envelope) => envelope["resolves_conditions"])).toBe(true);
    expect(envelopes.every((envelope) =>
      envelope["condition_key"] === other || envelope["resolves_condition"] === other
        ? Array.isArray(envelope["resolves_conditions"]) && envelope["resolves_conditions"].some(
            (key) => typeof key === "string" && key.startsWith(prefix),
          )
        : true,
    )).toBe(true);
  });

  it("pages a prefix history beyond the aggregate condition-row cap", async () => {
    const prefix = "alarm:carry-delivery:host:orphan:";
    const firstPage = Array.from({ length: CONDITIONS_FAST_PATH_ROW_CAP }, (_, index) => ({
      id: String(index + 1),
      body: alarm(1, `${prefix}attempt-${index}`),
    }));
    const oldKey = `${prefix}attempt-before-window`;
    M.pgFastPath = true;
    M.pgQuery
      .mockImplementationOnce(async () => firstPage)
      .mockImplementationOnce(async () => [{ id: String(CONDITIONS_FAST_PATH_ROW_CAP + 1), body: alarm(2, oldKey) }]);

    const envelopes = await readConditionEnvelopesForPrefix(prefix);

    expect(M.pgQuery).toHaveBeenCalledTimes(2);
    expect(envelopes).toHaveLength(CONDITIONS_FAST_PATH_ROW_CAP + 1);
    expect(envelopes.at(-1)).toMatchObject({ condition_key: oldKey });
    const [template, ...params] = M.pgQuery.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(template.join("?")).toContain("body->>'condition_key' LIKE ? ESCAPE '!'");
    expect(template.join("?")).toContain("id > ?::bigint");
    expect(params).toContain(`${prefix}%`);
    const [, ...nextParams] = M.pgQuery.mock.calls[1] as [TemplateStringsArray, ...unknown[]];
    expect(nextParams).toContain(String(CONDITIONS_FAST_PATH_ROW_CAP));
  });

  it("keeps recent PG resolutions inside the capped window and folds it chronologically", async () => {
    const key = "bounded-condition";
    M.pgFastPath = true;
    M.pgQuery.mockImplementation(async (..._args: unknown[]) => [
      { body: resolution(2, key) },
      { body: alarm(1, key) },
    ]);

    const out = await call();

    const template = M.pgQuery.mock.calls[0]?.[0] as TemplateStringsArray | undefined;
    expect(template?.join(" ")).toContain("ORDER BY id DESC");
    expect(out.open_count).toBe(0);
    expect(out.resolved[0]).toMatchObject({
      condition_key: key,
      first_seen: at(1),
      last_seen: at(1),
      latest_summary: "alarm " + key,
      resolved_at: at(2),
    });
  });

  it("splits open vs resolved over the seam read", async () => {
    M.readLines.mockImplementation(async () => [
      alarm(1, "git-sync-stall:papercusp"),
      resolution(2, "git-sync-stall:papercusp"),
      alarm(3, "green-stall:papercusp"),
      { ts: at(4), msg_id: "noise", from: "peer", to: ["*"], kind: "message", summary: "unrelated" },
    ]);
    const out = await call();
    expect(out.open_count).toBe(1);
    expect(out.open[0]).toMatchObject({
      condition_key: "green-stall:papercusp",
      open: true,
    });
    expect(out.resolved_count).toBe(1);
    expect(out.resolved[0]).toMatchObject({
      condition_key: "git-sync-stall:papercusp",
      resolved_at: at(2),
    });
  });

  it("include_resolved:false returns open only; resolved_limit caps the list", async () => {
    M.readLines.mockImplementation(async () => [
      alarm(1, "a"),
      resolution(2, "a"),
      alarm(3, "b"),
      resolution(4, "b"),
      alarm(5, "c"),
      resolution(6, "c"),
    ]);
    const openOnly = await call({ include_resolved: false });
    expect(openOnly.resolved).toEqual([]);
    expect(openOnly.resolved_count).toBe(3);

    const capped = await call({ resolved_limit: 2 });
    expect(capped.resolved).toHaveLength(2);
    // most recent first
    expect(capped.resolved.map((s) => s.condition_key)).toEqual(["c", "b"]);
  });

  // WI-6554700010011878: a fold over a FULL window is a floor, not the census.
  it("marks window_saturated when the PG window came back full, and omits it otherwise", async () => {
    M.pgFastPath = true;
    const full = Array.from({ length: CONDITIONS_FAST_PATH_ROW_CAP }, (_, i) => ({ body: alarm(i % 60, `k${i % 7}`) }));
    M.pgQuery.mockImplementation(async (..._args: unknown[]) => full);
    const saturated = (await call()) as Out & { window_saturated?: Record<string, unknown> };
    expect(saturated.window_saturated).toMatchObject({
      rows: CONDITIONS_FAST_PATH_ROW_CAP,
      cap: CONDITIONS_FAST_PATH_ROW_CAP,
    });

    M.pgQuery.mockImplementation(async (..._args: unknown[]) => full.slice(1));
    const partial = (await call()) as Out & { window_saturated?: unknown };
    expect(partial.window_saturated).toBeUndefined();
  });
});

describe("readLatestConditionEnvelope (WI-6554700010011878)", () => {
  it("returns null without a PG fast path and issues no query", async () => {
    await expect(readLatestConditionEnvelope("k")).resolves.toBeNull();
    expect(M.pgQuery).not.toHaveBeenCalled();
  });

  it("seeks the newest envelope naming the key in any of the three fields, outside the fold window", async () => {
    M.pgFastPath = true;
    M.pgQuery.mockImplementation(async (..._args: unknown[]) => [{ body: JSON.stringify(alarm(3, "k")) }]);
    await expect(readLatestConditionEnvelope("k")).resolves.toMatchObject({ condition_key: "k", summary: "alarm k" });

    const [template, ...params] = M.pgQuery.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const text = template.join("?param?");
    expect(text).toContain("body->>'condition_key' =");
    expect(text).toContain("body->>'resolves_condition' =");
    expect(text).toContain("body->'resolves_conditions' ?");
    expect(text).toMatch(/ORDER BY id DESC\s+LIMIT 1/);
    expect(params).toContain("k");
    expect(params).toContain("ws-test");
    // Not the bounded fold read: a key older than the 25k window must still be found.
    expect(params).not.toContain(CONDITIONS_FAST_PATH_ROW_CAP);
  });

  it("returns null when no envelope names the key", async () => {
    M.pgFastPath = true;
    await expect(readLatestConditionEnvelope("absent")).resolves.toBeNull();
  });
});
