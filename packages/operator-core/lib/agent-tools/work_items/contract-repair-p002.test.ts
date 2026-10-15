/**
 * P-002 (tool-contract-repair-2026-09-05) — work_items:get argument contract.
 *
 * Lane evidence, grouped by REJECTED KEY from `payload->'toolFailureProbation'`
 * rather than by prose (54 filed work-items plus 101 observations name this tool
 * for this class; the plan's "5 filings" was a bounded census):
 *
 *   threadLimit cap  50  12/20/40/50/100 passed, all rejected  -> CLAMP + SAY
 *   full-read switch 46  includeComments/includeCheckpoints/
 *                        include/full/lifecycle/priorAttempts…  -> BETTER-ERROR
 *   id given array    8  id:[…] instead of ids:[…]              -> BETTER-ERROR
 *   limit             1  meant threadLimit                      -> BETTER-ERROR
 *
 * These tests pin DISPOSITIONS and the one structural property that is easy to
 * get wrong by accident, not the prose — a reworded note stays green, a dropped
 * redirect or a silently-reinstated hard cap goes red.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/work_items/contract-repair-p002.test.ts
 */
import { describe, expect, it } from "vitest";
import { splitLocalSchemaTarget } from "@papercusp/tooldef";
import getTool, { THREAD_WINDOW_MAX } from "./get";
import { shapeWorkItemsGet } from "./get-shape";

type Redirect = string | { tool: string; args: Record<string, unknown>; note?: string };

function redirects(): Record<string, Redirect> {
  return (getTool.guidance as { argRedirects?: Record<string, Redirect> } | undefined)
    ?.argRedirects ?? {};
}

function declaredKeys(): string[] {
  // The schema is a ZodEffects (`.refine`) wrapping the object, so reach through
  // to the inner shape rather than assuming `.shape` sits on the top-level node.
  const node = getTool.args as unknown as {
    shape?: Record<string, unknown>;
    _def?: { schema?: { shape?: Record<string, unknown> } };
  };
  const shape = node.shape ?? node._def?.schema?.shape;
  return shape ? Object.keys(shape) : [];
}

function parse(args: Record<string, unknown>) {
  return (getTool.args as unknown as { safeParse(v: unknown): { success: boolean } }).safeParse(args);
}

describe("work_items:get argument contract (P-002)", () => {
  it("exposes a schema shape these tests can actually read", () => {
    // Positive control. Every assertion below is of the form "key is/is not in
    // declaredKeys()", so an empty shape would make ALL of them pass vacuously —
    // the false-green this repo keeps paying for. Fail loudly instead.
    expect(declaredKeys()).toEqual(
      expect.arrayContaining(["id", "ids", "harness", "detail", "threadLimit"]),
    );
  });

  describe("the threadLimit cap: clamp, do not reject", () => {
    it("accepts a threadLimit above the effective window", () => {
      // The whole 50-filing cluster. Each of these was an `invalid_args` that the
      // caller retried with 10 and got an answer to, i.e. a pure round-trip.
      for (const threadLimit of [12, 20, 40, 50, 100]) {
        expect(parse({ id: "WI-1", threadLimit }).success, `threadLimit:${threadLimit}`).toBe(true);
      }
    });

    it("still accepts 0 and still rejects a negative", () => {
      // 0 is the explicit suppress-thread-work form. Three filings claimed it was
      // rejected; it is not, and this pins that so the clamp change cannot make
      // those stale reports retroactively true.
      expect(parse({ id: "WI-1", threadLimit: 0 }).success).toBe(true);
      expect(parse({ id: "WI-1", threadLimit: -1 }).success).toBe(false);
    });

    it("keeps a declared bound, so a real typo is still caught", () => {
      // Clamping is not "accept anything": an absurd value is still a mistake
      // worth refusing, and a bound that accepted it would make the schema
      // unfalsifiable.
      expect(parse({ id: "WI-1", threadLimit: 100_000 }).success).toBe(false);
    });

    it("leaves the declared bound ABOVE the effective window, so the clamp is reachable", () => {
      // If a later edit lowered the schema bound back to THREAD_WINDOW_MAX, the
      // clamp would become dead code and the 50-filing cluster would silently
      // return — while every other test here still passed. This is the assertion
      // that catches that regression.
      const atCap = parse({ id: "WI-1", threadLimit: THREAD_WINDOW_MAX + 1 });
      expect(atCap.success, "a value just above the effective window must still parse").toBe(true);
    });
  });

  describe("the clamp is disclosed, which is what makes clamping safe", () => {
    // Clamping is only defensible because a short window cannot be misread as a
    // total. Two things carry that: `threadWindow.total`, and this marker. If the
    // shaper drops the marker under budget the guarantee is gone, so pin it at
    // the tightest tier rather than the roomiest.
    const withClamp = {
      ok: true,
      results: [
        {
          ok: true,
          id: "WI-1",
          workItem: { id: "WI-1", title: "t" },
          threadLimitClamped: { requested: 20, applied: THREAD_WINDOW_MAX },
          threadWindow: { posts: [], total: 37, topics: [], createdAt: null },
        },
      ],
      counts: { ok: 1, failed: 0 },
    };

    for (const tier of ["standard", "trimmed"] as const) {
      it(`survives the ${tier} payload tier`, () => {
        const shaped = shapeWorkItemsGet(withClamp, tier) as {
          results: Array<Record<string, unknown>>;
        };
        expect(shaped.results[0]?.threadLimitClamped).toEqual({
          requested: 20,
          applied: THREAD_WINDOW_MAX,
        });
      });
    }

    it("is absent when nothing was clamped, so its presence is a real signal", () => {
      const shaped = shapeWorkItemsGet(
        {
          ok: true,
          results: [{ ok: true, id: "WI-1", workItem: { id: "WI-1", title: "t" } }],
          counts: { ok: 1, failed: 0 },
        },
        "standard",
      ) as { results: Array<Record<string, unknown>> };
      expect(shaped.results[0]).not.toHaveProperty("threadLimitClamped");
    });
  });

  describe("the full-read switch: redirect the 46-filing cluster to `detail`", () => {
    const measured = [
      "includeComments",
      "include_comments",
      "includeCheckpoints",
      "include_checkpoints",
      "includeThread",
      "includeEvidence",
      "includeCompletion",
      "includePlan",
      "includeChecks",
      "includeHistory",
      "include",
      "full",
      "lifecycle",
      "priorAttempts",
    ];

    it.each(measured)("redirects `%s`", (key) => {
      expect(redirects()[key]).toBeDefined();
    });

    it("redirects only keys the schema actually REJECTS", () => {
      // unknownArgHint fires only for unrecognized keys, so a redirect naming a
      // DECLARED key is dead text that can never render. `lifecycle` and
      // `priorAttempts` are the trap: they are real RESULT fields, so it is easy
      // to assume they are also accepted arguments.
      const declared = declaredKeys();
      for (const key of Object.keys(redirects())) {
        expect(declared, `redirect for declared key \`${key}\` can never render`).not.toContain(key);
      }
    });
  });

  describe("`limit` is refused rather than aliased", () => {
    it("is refused unless checkpointOnly is paging the checkpoint, never aliased", () => {
      // The plan's worked ALIAS-vs-BETTER-ERROR example: aliasing `limit` to
      // `threadLimit` would answer "how many comment posts" to a caller who may
      // well have asked "how many work-items". Since the checkpointOnly page read
      // (get.checkpoint.test.ts) `limit` is a DECLARED key with exactly one
      // narrow meaning, the checkpoint page size, so the refusal is pinned on
      // BEHAVIOUR: every other use of `limit` must still fail to parse.
      expect(parse({ id: "WI-1", limit: 5 }).success).toBe(false);
      expect(parse({ id: "WI-1", threadLimit: 5, limit: 5 }).success).toBe(false);
      expect(parse({ ids: ["WI-1", "WI-2"], limit: 5 }).success).toBe(false);
      expect(parse({ id: "WI-1", checkpointOnly: true, limit: 5 }).success).toBe(true);
    });

    it("names BOTH destinations, so the rejection is not a dead end", () => {
      // The refusal is the schema refine's message (a redirect for a declared
      // key never renders), so read the parse issue the caller actually gets.
      const result = parse({ id: "WI-1", limit: 5 }) as {
        success: boolean;
        error?: { issues: Array<{ message: string }> };
      };
      const message = (result.error?.issues ?? []).map((issue) => issue.message).join("\n");
      expect(message).toContain("ids");
      expect(message).toContain("threadLimit");
    });
  });

  it("renders every authored redirect as a SAME-TOOL relocation", () => {
    // The trap this pins, caught before shipping: the renderer classifies a
    // redirect by asking whether its target names a path on THIS tool. A target
    // carrying explanation used to fail that test wholesale and render
    // "`includeComments` is not an arg of this tool — it is written by detail:true
    // — the single full-record switch…", telling the caller some OTHER tool owns
    // their data. Every target here must resolve to a declared local key.
    const declared = declaredKeys();
    expect(declared.length).toBeGreaterThan(0);
    for (const [key, target] of Object.entries(redirects())) {
      expect(typeof target, `${key} target should be a string`).toBe("string");
      const split = splitLocalSchemaTarget(target as string, declared);
      expect(split, `redirect for \`${key}\` must name a declared key`).not.toBeNull();
      expect(declared).toContain(split!.path.split(/[.[]/)[0]);
      expect(split!.note.length, `redirect for \`${key}\` should explain itself`).toBeGreaterThan(0);
    }
  });
});
