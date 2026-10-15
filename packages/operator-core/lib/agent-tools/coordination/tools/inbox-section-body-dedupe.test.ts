/**
 * coord:inbox — P-006 (oversized-tool-results-reduction-2026-10-12): a bounded read
 * keeps ONE copy of a sectioned message's prose.
 *
 * WHY THIS EXISTS. `body` is the flattened projection of `sections[].text`
 * (message-fields.ts joins the texts with a blank line), and `boundInboxEntries`
 * caps `body` and the combined section text separately. A sectioned message, the
 * normal shape since coord:send refuses a plain-string body, therefore spent the
 * per-entry budget twice on identical prose. Measured on 67 real coord:inbox
 * spills: 46 of the 63 entries carrying both fields had duplicated text.
 *
 * FALSIFIABILITY. `noDedupe` below is the pre-fix behaviour (identity). The
 * `control` block asserts the single-copy pin FAILS against it, so a refactor that
 * silently stops deduplicating cannot keep every test here green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  readInbox: vi.fn(async () => [] as unknown[]),
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
vi.mock("../../../coord-schema", () => ({ renderInjection: () => "" }));
vi.mock("../../../cache", () => ({
  cachedRead: async (_ctx: unknown, _key: unknown, fn: () => Promise<unknown>) => fn(),
}));

import { renderSevereEventEmitter } from "../../../severe-event-emitter";
import { authoredFieldsMarker } from "../message-fields";
import tool, {
  boundInboxEntries,
  dropSectionTextDuplicatedInBody,
  fitInboxWindowToChars,
  inboxDefaultWindowChars,
  severeEventEmitterNote,
  stripSevereEventEmitterTrailer,
} from "./inbox";

type Row = Record<string, unknown>;

const sectioned = (texts: string[], structure: Array<Row | undefined> = []): Row => ({
  msg_id: "m-1",
  ts: "2026-10-13T05:00:00.000Z",
  from: "peer",
  to: ["owner-a"],
  kind: "message",
  summary: "short summary",
  body: texts.join("\n\n"),
  sections: texts.map((text, i) => ({ text, ...(structure[i] ?? {}) })),
});

/** Characters of message prose a row carries across `body` and `sections[].text`. */
const proseChars = (row: Row): number => {
  const body = typeof row["body"] === "string" ? (row["body"] as string).length : 0;
  const sections = Array.isArray(row["sections"]) ? (row["sections"] as Row[]) : [];
  return body + sections.reduce((n, s) => n + (typeof s["text"] === "string" ? (s["text"] as string).length : 0), 0);
};

/** The single-copy pin, shared by the subject and the control. */
const expectSingleCopy = (dedupe: (rows: Row[]) => Row[]) => {
  const texts = ["context ".repeat(30), "Please take the next step."];
  const [row] = boundInboxEntries(dedupe([sectioned(texts, [undefined, { forYouBecause: { relation: "owns" } }])]), 120);
  expect(proseChars(row!)).toBeLessThanOrEqual(120);
};

const noDedupe = (rows: Row[]): Row[] => rows;

describe("dropSectionTextDuplicatedInBody", () => {
  it("keeps body, strips duplicated section text, and preserves structural keys", () => {
    const fyb = { relation: "owns", ref: "EI-1" };
    const premises = ["session_turn:x:1"];
    const entry = sectioned(["first part", "the ask"], [{ premises }, { forYouBecause: fyb }]);
    const [row] = dropSectionTextDuplicatedInBody([entry]);
    expect(row!["body"]).toBe("first part\n\nthe ask");
    expect(row!["sections"]).toEqual([{ premises }, { forYouBecause: fyb }]);
    expect(row!["sections_text_in_body"]).toBe(true);
    expect(row!["summary"]).toBe("short summary");
  });

  it("keeps an empty placeholder so a kept array stays index-aligned with the body paragraphs", () => {
    const [row] = dropSectionTextDuplicatedInBody([sectioned(["a", "b", "c"], [undefined, { premises: ["p"] }])]);
    expect(row!["sections"]).toEqual([{}, { premises: ["p"] }, {}]);
  });

  it("drops the sections array when no section carries anything beyond its text", () => {
    const [row] = dropSectionTextDuplicatedInBody([sectioned(["only text", "more text"])]);
    expect(row).not.toHaveProperty("sections");
    expect(row).not.toHaveProperty("sections_text_in_body");
    expect(row!["body"]).toBe("only text\n\nmore text");
  });

  it("leaves an entry untouched when body is not exactly the joined section text", () => {
    const entry = { ...sectioned(["a", "b"]), body: "a\nb" };
    const [row] = dropSectionTextDuplicatedInBody([entry]);
    expect(row).toBe(entry);
  });

  it("leaves malformed or absent sections untouched", () => {
    const nonString = { body: "x", sections: [{ text: 42 }] };
    const nonObject = { body: "x", sections: ["x"] };
    const none = { body: "x" };
    const noBody = { sections: [{ text: "x" }] };
    const empty = { body: "", sections: [] };
    const rows = [nonString, nonObject, none, noBody, empty];
    const out = dropSectionTextDuplicatedInBody(rows);
    out.forEach((row, i) => expect(row).toBe(rows[i]));
  });

  it("does not change the authored marker", () => {
    const entry = sectioned(
      ["claim", "ask"],
      [{ premises: ["session_turn:x:1"], couldNotDetermine: [{ what: "y" }] }, { forYouBecause: { relation: "owns" } }],
    );
    const [row] = dropSectionTextDuplicatedInBody([entry]);
    expect(authoredFieldsMarker(row)).toBe(authoredFieldsMarker(entry));
    expect(authoredFieldsMarker(row)).toBeTruthy();
  });

  it("halves the bounded prose of a duplicated message", () => {
    expectSingleCopy(dropSectionTextDuplicatedInBody);
  });
});

describe("control: the pre-fix behaviour fails the single-copy pin", () => {
  it("keeping both copies spends the cap twice", () => {
    expect(() => expectSingleCopy(noDedupe)).toThrow();
  });
});

describe("coord:inbox handler wiring", () => {
  const ctx = (): never =>
    ({ ownerId: "owner-a", workspaceId: "ws", metadata: vi.fn(), log: vi.fn(), progress: vi.fn() }) as never;
  const callInbox = async (args: Row = {}) => {
    const res = (await tool.handler(args as never, ctx())) as { content: Array<{ text: string }> };
    return JSON.parse(res.content[0]!.text) as { entries: Row[] };
  };

  beforeEach(() => {
    M.readInbox.mockReset();
    M.readInbox.mockResolvedValue([
      sectioned(["background", "the ask"], [undefined, { forYouBecause: { relation: "owns" } }]),
    ]);
  });

  it("a bounded read returns one copy of the prose", async () => {
    const out = await callInbox({ max_body_chars: 300 });
    const row = out.entries.find((e) => e["msg_id"] === "m-1")!;
    expect(row["body"]).toBe("background\n\nthe ask");
    expect(row["sections"]).toEqual([{}, { forYouBecause: { relation: "owns" } }]);
    expect(row["sections_text_in_body"]).toBe(true);
  });

  it("an unbounded read (max_body_chars: 0) keeps the sections whole", async () => {
    const out = await callInbox({ max_body_chars: 0 });
    const row = out.entries.find((e) => e["msg_id"] === "m-1")!;
    expect((row["sections"] as Row[]).map((s) => s["text"])).toEqual(["background", "the ask"]);
    expect(row).not.toHaveProperty("sections_text_in_body");
  });
});

const emitter = { pid: 4242, startedAt: "2026-10-13T04:45:05.048Z", uptimeSec: 3720, cwd: "/repo/apps/operator" };
const alarm = (text: string, over: Row = {}): Row => ({
  msg_id: "a-1",
  ts: "2026-10-13T05:00:00.000Z",
  from: "system",
  to: ["*"],
  kind: "message",
  category: "severe-event",
  summary: "Grading is behind",
  body: text + renderSevereEventEmitter(emitter),
  emitter,
  ...over,
});

describe("stripSevereEventEmitterTrailer", () => {
  it("pins the trailer bytes the writer appends (moving the renderer must not change them)", () => {
    expect(renderSevereEventEmitter(emitter)).toBe(
      "\n\n— emitted by pid 4242, process started 2026-10-13T04:45:05.048Z (up 1h02m), cwd /repo/apps/operator. " +
        "If that start time PREDATES the fix you are checking, this process never loaded it " +
        "(no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.",
    );
  });

  it("strips the trailer that exactly matches the entry's own emitter and keeps the emitter field", () => {
    const { entries, stripped } = stripSevereEventEmitterTrailer([alarm("89 of 105 holder hours are ungraded.")]);
    expect(stripped).toBe(1);
    expect(entries[0]!["body"]).toBe("89 of 105 holder hours are ungraded.");
    expect(entries[0]!["emitter"]).toEqual(emitter);
  });

  it("leaves the body alone when the trailer does not match the emitter field", () => {
    const entry = alarm("text", { emitter: { ...emitter, pid: 1 } });
    const { entries, stripped } = stripSevereEventEmitterTrailer([entry]);
    expect(stripped).toBe(0);
    expect(entries[0]).toBe(entry);
  });

  it("leaves entries without a well-formed emitter alone", () => {
    const rows: Row[] = [{ body: "x" }, { body: "x", emitter: { pid: "1" } }, { emitter }];
    const { entries, stripped } = stripSevereEventEmitterTrailer(rows);
    expect(stripped).toBe(0);
    entries.forEach((row, i) => expect(row).toBe(rows[i]));
  });

  it("states the interpretation rule once, with the count", () => {
    expect(severeEventEmitterNote(1)).toMatch(/^1 alarm body omits its emitter trailer; /);
    expect(severeEventEmitterNote(3)).toMatch(/^3 alarm bodies omit their emitter trailer; /);
    expect(severeEventEmitterNote(3)).toContain("restart that host instead of re-investigating the alarm.");
  });

  it("a clipped alarm keeps its own text instead of only the trailer", () => {
    const text = "Workspace papercusp-workspace. 89 of 105 active holder hours are ungraded (limit 6).";
    const pre = boundInboxEntries([alarm(text)], 150)[0]!;
    expect(String(pre["body"])).not.toContain("89 of 105");
    const post = boundInboxEntries(stripSevereEventEmitterTrailer([alarm(text)]).entries, 150)[0]!;
    expect(String(post["body"])).toContain("89 of 105");
  });
});

describe("coord:inbox handler wiring: emitter trailer", () => {
  const ctx = (): never =>
    ({ ownerId: "owner-a", workspaceId: "ws", metadata: vi.fn(), log: vi.fn(), progress: vi.fn() }) as never;
  const callInbox = async (args: Row = {}) => {
    const res = (await tool.handler(args as never, ctx())) as { content: Array<{ text: string }> };
    return JSON.parse(res.content[0]!.text) as { entries: Row[]; emitter_note?: string };
  };
  const alarmBodies = (out: { entries: Row[] }) =>
    out.entries.filter((e) => String(e["msg_id"]).startsWith("a-")).map((e) => String(e["body"]));

  beforeEach(() => {
    M.readInbox.mockReset();
    M.readInbox.mockResolvedValue([
      alarm("first alarm text"),
      alarm("second alarm text", { msg_id: "a-2", summary: "Another alarm" }),
    ]);
  });

  it("a bounded read strips each trailer and adds one emitter_note", async () => {
    const out = await callInbox({ max_body_chars: 300, include_ambient: true });
    const bodies = alarmBodies(out);
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toContain("emitted by pid");
    expect(out.emitter_note).toMatch(/emitter trailer/);
  });

  it("an unbounded read (max_body_chars: 0) keeps the trailers and adds no note", async () => {
    const out = await callInbox({ max_body_chars: 0, include_ambient: true });
    const bodies = alarmBodies(out);
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).toContain("emitted by pid 4242");
    expect(out).not.toHaveProperty("emitter_note");
  });
});

describe("P-006 D-002: the default window fits one result", () => {
  const msg = (i: number): Row => ({
    msg_id: `d-${String(i).padStart(2, "0")}`,
    ts: `2026-10-13T05:${String(i).padStart(2, "0")}:00.000Z`,
    from: "peer",
    to: ["owner-a"],
    kind: "message",
    summary: `message ${i}`,
    body: "x".repeat(400),
  });

  it("keeps a priority prefix within the budget, and always at least one entry", () => {
    const rows = [msg(1), msg(2), msg(3), msg(4)];
    const one = JSON.stringify(boundInboxEntries([rows[0]!], 300)[0]).length + 1;
    const fit = fitInboxWindowToChars(rows, 300, one * 2 + 5);
    expect(fit.kept).toEqual([rows[0], rows[1]]);
    expect(fit.omitted).toBe(2);
    expect(fitInboxWindowToChars(rows, 300, 1).kept).toEqual([rows[0]]);
  });

  it("derives its budget from the result door", () => {
    const chars = inboxDefaultWindowChars();
    expect(chars).toBeGreaterThan(1000);
    expect(chars).toBeLessThan(6000);
  });

  describe("handler", () => {
    const prevDoorsOff = process.env.PAPERCUSP_DOORS_CONFIG_OFF;
    const ctx = (): never =>
      ({ ownerId: "owner-a", workspaceId: "ws", metadata: vi.fn(), log: vi.fn(), progress: vi.fn() }) as never;
    const callInbox = async (args: Row = {}) => {
      const res = (await tool.handler(args as never, ctx())) as { content: Array<{ text: string }> };
      return JSON.parse(res.content[0]!.text) as { entries: Row[]; summary: Row };
    };

    beforeEach(() => {
      process.env.PAPERCUSP_DOORS_CONFIG_OFF = "1";
      M.readInbox.mockReset();
      M.readInbox.mockResolvedValue(Array.from({ length: 40 }, (_, i) => msg(i + 1)));
    });
    afterEach(() => {
      if (prevDoorsOff === undefined) delete process.env.PAPERCUSP_DOORS_CONFIG_OFF;
      else process.env.PAPERCUSP_DOORS_CONFIG_OFF = prevDoorsOff;
    });

    it("a no-args read returns only what fits, and says how many it omitted", async () => {
      const out = await callInbox();
      expect(out.entries.length).toBeGreaterThan(0);
      expect(out.entries.length).toBeLessThan(40);
      expect(out.summary["returned"]).toBe(out.entries.length);
      const fitted = out.summary["fitted_to_result"] as Row;
      expect(fitted["omitted"]).toBe(40 - out.entries.length);
      expect(JSON.stringify(out.entries).length).toBeLessThanOrEqual(inboxDefaultWindowChars() + 2000);
    });

    it("an explicit limit is honoured exactly and is not fitted", async () => {
      const out = await callInbox({ limit: 40 });
      expect(out.entries.length).toBe(40);
      expect(out.summary).not.toHaveProperty("fitted_to_result");
    });

    it("an explicit max_body_chars is not fitted either", async () => {
      const out = await callInbox({ max_body_chars: 100 });
      expect(out.summary).not.toHaveProperty("fitted_to_result");
    });
  });
});
