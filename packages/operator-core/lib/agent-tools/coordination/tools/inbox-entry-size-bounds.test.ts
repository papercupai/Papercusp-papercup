import { describe, expect, it } from "vitest";

import {
  boundInboxEntries,
  boundInboxEntrySize,
  INBOX_ENTRY_FIXED_OVERHEAD_CHARS,
} from "./inbox";

describe("boundInboxEntrySize — structured metadata", () => {
  it("bounds each serialized row to max_body_chars plus fixed overhead and points to the full message", () => {
    const maxBodyChars = 1_500;
    const entry = {
      msg_id: "coord-send-large",
      ts: "2026-11-02T00:00:00.000Z",
      kind: "message",
      from: "sender",
      to: ["recipient"],
      expects: "answer",
      summary: "A concise summary",
      body: `Actionable tail. ${"context ".repeat(250)}`,
      sections: [{
        text: "context",
        premises: Array.from({ length: 24 }, (_, i) => `plan#D-${String(i).padStart(3, "0")} ${"p".repeat(160)}`),
        forYouBecause: { relation: "owns", ref: "work-item:WI-123", note: "n".repeat(1_200) },
        youMayNotKnow: [{ ref: "plan:P-001", provenance: "authored", note: "y".repeat(1_200) }],
      }],
      fieldProvenance: Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [`field-${i}`, { source: "coord", detail: "f".repeat(180) }]),
      ),
      premisesClassified: Array.from({ length: 20 }, (_, i) => ({
        ref: `plan#D-${i}`,
        status: "current",
        explanation: "c".repeat(140),
      })),
      premiseStamps: Array.from({ length: 20 }, (_, i) => ({
        ref: `plan#D-${i}`,
        source: "decision",
        stamp: "s".repeat(120),
      })),
      basedOn: Array.from({ length: 20 }, (_, i) => ({
        ref: `work-item:WI-${i}`,
        via: "work_items:get",
        readAt: "2026-11-02T00:00:00.000Z",
        versionAtSend: "blocked@1",
      })),
      authored: "premises · forYouBecause · youMayNotKnow",
    };

    const textBound = boundInboxEntries([entry], maxBodyChars)[0]!;
    const maxSerializedChars = maxBodyChars + INBOX_ENTRY_FIXED_OVERHEAD_CHARS;
    // Negative control: bounding prose alone leaves the reported structured-field
    // overflow intact, so this regression pin would fail without the subject.
    expect(JSON.stringify(textBound).length).toBeGreaterThan(maxSerializedChars);

    const bounded = boundInboxEntrySize(textBound, maxBodyChars);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(maxSerializedChars);
    expect(bounded.body).toBe(textBound.body);
    expect(bounded.authored).toBe(entry.authored);
    expect(bounded.details_truncated).toBe(true);
    expect(bounded.details_full_chars).toBe(JSON.stringify(textBound).length);
    expect(bounded.details_read).toEqual({
      tool: "coord:read",
      args: { msg_id: entry.msg_id },
    });
    expect(bounded.fieldProvenance).toBeUndefined();
  });

  it("leaves an already-small row unchanged", () => {
    const entry = { msg_id: "small", kind: "message", body: "short" };
    expect(boundInboxEntrySize(entry, 100)).toBe(entry);
  });

  it("does not introduce a size cap when max_body_chars is zero", () => {
    const entry = { msg_id: "full", body: "b".repeat(2_000), fieldProvenance: { source: "s".repeat(2_000) } };
    expect(boundInboxEntrySize(entry, 0)).toBe(entry);
  });
});
