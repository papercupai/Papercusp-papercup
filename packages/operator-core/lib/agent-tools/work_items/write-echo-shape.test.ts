/**
 * write-echo-shape.test.ts — the P-025 write-echo diet for the bulk
 * work_items:claim / work_items:complete envelopes (context-trimming-tiers-
 * 2026-07-01). Outcome fields pass through verbatim; the echoed WorkItem row
 * compacts; trimmed drops caller-authored echoes with a loud envelope note.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/write-echo-shape.test.ts
 */
import { describe, expect, it } from "vitest";
import { COMPLETION_DIGEST_SUMMARY_CAP, shapeWorkItemWriteEcho } from "./write-echo-shape";

const fullRow = {
  id: "WI-9",
  kind: "task",
  family: "issue",
  harness: "papercusp",
  title: "A work item title that is long enough to be clipped by the trimmed ninety character cap for sure yes",
  summary: "s".repeat(5_000),
  state: "open",
  assignee: "su-1",
  payload: { plan_item: { plan_slug: "p", item_id: "P-1" }, big: "x".repeat(20_000) },
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
};

describe("shapeWorkItemWriteEcho (P-025)", () => {
  it("compacts the echoed workItem; outcome fields pass through verbatim", () => {
    const env = {
      ok: true,
      results: [
        { ok: true, id: "WI-9", workItem: fullRow, reflect: "reflect-step", stateWarning: "w" },
        { ok: false, id: "WI-10", error: "claim_conflict", holder: "su-2", hint: "coordinate", workItem: fullRow },
      ],
      counts: { ok: 1, failed: 1 },
    };
    const out = shapeWorkItemWriteEcho(env, "trimmed") as {
      results: Record<string, unknown>[];
      counts: unknown;
    };
    const w = out.results[0].workItem as Record<string, unknown>;
    expect(w).not.toHaveProperty("payload");
    expect(w).not.toHaveProperty("summary");
    expect(w.state).toBe("open");
    expect(String(w.title).length).toBeLessThanOrEqual(90);
    expect(out.results[0].reflect).toBe("reflect-step");
    expect(out.results[0].stateWarning).toBe("w");
    expect(out.results[1].error).toBe("claim_conflict");
    expect(out.results[1].holder).toBe("su-2");
    expect(out.results[1].hint).toBe("coordinate");
    expect(out.counts).toEqual({ ok: 1, failed: 1 });
    expect(JSON.stringify(out).length).toBeLessThan(2_000); // the 25KB+ echo is gone
  });

  it("trimmed drops completion/outputPayload echoes; standard digests them; each with ONE loud envelope note", () => {
    const completion = {
      summary: "did the thing ".repeat(40),
      status: "done",
      workItem: "WI-9",
      agent: "su · su-1",
      whatLanded: ["a.ts"],
      testResult: "r".repeat(3_000),
    };
    const env = {
      ok: true,
      results: [
        {
          ok: true,
          id: "WI-9",
          workItem: fullRow,
          completion,
          outputPayload: { huge: "h".repeat(2_000) },
          outputPayloadReadPath: "work_items:get results[].workItem.payload.out",
        },
      ],
      counts: { ok: 1, failed: 0 },
    };
    const trimmed = shapeWorkItemWriteEcho(env, "trimmed") as Record<string, unknown>;
    const row = (trimmed.results as Record<string, unknown>[])[0];
    expect(row).not.toHaveProperty("completion");
    expect(row).not.toHaveProperty("outputPayload");
    expect(row.outputPayloadReadPath).toBe("work_items:get results[].workItem.payload.out");
    expect(String(trimmed.echo_note)).toContain('payloadTier:"full"');

    // oversized-tool-results-reduction-2026-10-12 D-003: standard keeps a DIGEST, not the replay.
    const std = shapeWorkItemWriteEcho(env, "standard") as Record<string, unknown>;
    const stdRow = (std.results as Record<string, unknown>[])[0];
    const digest = stdRow.completion as Record<string, unknown>;
    expect(digest.status).toBe("done");
    expect(digest.workItem).toBe("WI-9");
    expect(digest.agent).toBe("su · su-1");
    expect(String(digest.summary).length).toBeLessThanOrEqual(COMPLETION_DIGEST_SUMMARY_CAP);
    expect(digest.fields).toEqual(Object.keys(completion));
    expect(digest.chars).toBe(JSON.stringify(completion).length);
    expect(digest).not.toHaveProperty("testResult");
    expect(stdRow.outputPayload).toEqual({ fields: ["huge"], chars: JSON.stringify(env.results[0].outputPayload).length });
    expect(stdRow.outputPayloadReadPath).toBe("work_items:get results[].workItem.payload.out");
    expect(String(std.echo_note)).toContain('payloadTier:"full"');
    expect(String(std.echo_note)).toContain("standard");
    expect(JSON.stringify(stdRow).length).toBeLessThan(1_000); // the ~5.5KB authored echo is gone
  });

  it("standard leaves rows without authored echoes untouched and adds no note", () => {
    const env = { ok: true, results: [{ ok: true, id: "WI-9", reflect: "r" }], counts: { ok: 1, failed: 0 } };
    const std = shapeWorkItemWriteEcho(env, "standard") as Record<string, unknown>;
    expect((std.results as Record<string, unknown>[])[0]).toEqual({ ok: true, id: "WI-9", reflect: "r" });
    expect(std).not.toHaveProperty("echo_note");
  });

  it("non-conforming data passes through", () => {
    const weird = { ok: false, error: "x" };
    expect(shapeWorkItemWriteEcho(weird, "trimmed")).toBe(weird);
  });
});
