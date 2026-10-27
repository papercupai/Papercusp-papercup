/**
 * coord:inbox — server-side cursor custody, and the DELETION of the agent-facing
 * `since_ts` parameter (plan fleet-deltas-leader-primitives-2026-07-10, D-002
 * rollout item 3; decision D-013).
 *
 * WHAT THIS PINS, and why each one is a thing that can regress SILENTLY:
 *
 *  • D-013 R2 — `since_ts` is gone from the args schema. A re-add is the exact
 *    regression the plan exists to prevent (WI-1600: a caller that seeds a
 *    tail-poll to wall-clock `now` makes every earlier message invisible to
 *    every later poll, permanently). Nothing else fails if it comes back — the
 *    tool keeps working, agents just quietly get a footgun again.
 *
 *  • The WI-1600 CAUTION is gone from the description. That paragraph exists
 *    ONLY to police the parameter; leaving it after the parameter is deleted
 *    teaches agents to reach for an argument that no longer exists, which reads
 *    to them as a broken tool.
 *
 *  • D-013 R1 — the description states the VIEW contract. A cursor-derived floor
 *    would turn a second same-turn read into an empty result, which an agent
 *    reads as "my inbox is empty" — the same message-loss class this plan closes
 *    at the delivery layer (EI-20190140825808810). The sentence is the only
 *    place that promise is written down for the caller.
 *
 * These are deliberately CONTRACT assertions on the exported tool rather than
 * handler runs: the handler's behaviour is already covered by the sibling
 * inbox-*.test.ts files, and the property at risk here is the shape of the
 * agent-facing surface, not the read.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/inbox-cursor-custody.test.ts
 */
import { describe, expect, it } from "vitest";

import tool from "./inbox";
import { INBOX_CURSOR_SURFACE } from "../../activity/hook-bundle";
import { BUDGET, promptWeight } from "../../tool-guidance-budget";

describe("EI-20224626485772812 — direct coord:inbox argument naming", () => {
  it("teaches direct callers to use limit, while reserving inboxLimit for coord:orient", () => {
    const keys = Object.keys(tool.args.out.shape);
    expect(keys).toContain("limit");
    expect(keys).not.toContain("inboxLimit");
    expect(tool.description).toMatch(/direct bound is `limit`/i);
    expect(tool.description).toMatch(/coord:orient\.inboxLimit.*maps/i);
    // The mapping is single-sourced in the description. Keep the recurrence
    // guard on the writer-backed budget instead of requiring removed duplicate
    // guidance wording.
    expect(promptWeight(tool as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });

  it("enumerates the supported direct filters and rejects the stale includeRead key", () => {
    const keys = Object.keys(tool.args.out.shape);
    for (const accepted of [
      "kinds",
      "from",
      "limit",
      "include_ambient",
      "include_intents",
      "max_body_chars",
      "unanswered_only",
    ]) {
      expect(keys).toContain(accepted);
    }
    // WI-6554700010029664: the camelCase spellings are folded before parse, not declared.
    expect(tool.args.safeParse({ includeAmbient: true, unansweredOnly: true }).data).toMatchObject({
      include_ambient: true,
      unanswered_only: true,
    });
    expect(keys).not.toContain("includeRead");
    expect(tool.args.safeParse({ includeRead: false }).success).toBe(false);
    // The compact guidance intentionally omits the stale key; the strict args
    // schema above remains the enforcement surface for rejecting it.
    //
    // NARROWED 2026-09-05 (tool-contract-repair-2026-09-05 P-001). This used to ban
    // the substring /includeRead/i anywhere in the guidance blob. That ban could not
    // tell two opposite things apart: ADVERTISING the stale key (what it guards) and
    // REDIRECTING a caller who already sent it (what P-001 added — `includeRead` was
    // the joint-largest rejected key in this tool's 511 probation filings, 21 of them).
    // An argRedirects entry is keyed BY the rejected name, so it necessarily contains
    // it, and is paid only on the failure path. The guard is therefore re-pinned to the
    // intent rather than the substring — and this is a TIGHTENING, not a loosening: the
    // prose surfaces a caller actually reads are now checked individually, and the
    // redirect is additionally required to point AWAY from the stale key.
    const guidance = tool.guidance as
      | {
          when?: string;
          notWhen?: string;
          chaining?: string;
          argRedirects?: Record<string, unknown>;
        }
      | undefined;
    for (const prose of [tool.description, guidance?.when, guidance?.notWhen, guidance?.chaining]) {
      expect(prose ?? "").not.toMatch(/includeRead/i);
    }
    const includeReadRedirect = guidance?.argRedirects?.["includeRead"] as
      | { tool?: string; args?: Record<string, unknown>; note?: string }
      | string
      | undefined;
    if (includeReadRedirect !== undefined) {
      // It may exist ONLY as a correction, and it must name the real capability
      // instead of merely refusing the key (the bare-rejection failure shape).
      const rendered =
        typeof includeReadRedirect === "string"
          ? includeReadRedirect
          : `${includeReadRedirect.tool ?? ""} ${JSON.stringify(includeReadRedirect.args ?? {})} ${includeReadRedirect.note ?? ""}`;
      expect(rendered).toMatch(/unanswered_only|directed/);
      // And it must not resurrect the key as something the caller should send.
      expect(rendered).not.toMatch(/pass\s+includeRead|use\s+includeRead/i);
    }
  });

  it("documents that free-text q belongs to coord:feed, not coord:inbox", () => {
    // RE-PINNED 2026-08-31 (test-suite-recovery-2026-08-27 D-026). This used to require
    // the sentence "Free-text `q` and time bounds (`since`) are not inbox arguments — use
    // `coord:feed` for either" in the DESCRIPTION. That sentence was deliberately deleted
    // at c4b1629d63 (2026-08-30T20:00Z) because this tool's prompt weight had crossed the
    // hard cap and turned the gate RED — the same BUDGET this file asserts at line ~48.
    // The teaching was not dropped, it MOVED: guidance.argRedirects.q now carries the
    // identical redirect at zero prompt weight, paid only on the failure path. So the pin
    // moves with it. Asking for the description sentence back would re-break the weight
    // gate, which is why this guard must never do that again.
    expect(Object.keys(tool.args.out.shape)).not.toContain("q");

    const redirects = (
      tool.guidance as
        | { argRedirects?: Record<string, { tool?: string; args?: Record<string, unknown>; note?: string }> }
        | undefined
    )?.argRedirects;
    const q = redirects?.q;
    expect(q, "coord:inbox must still redirect a free-text `q` somewhere").toBeTruthy();
    // The redirect has to name the DESTINATION, not merely refuse the key: a bare
    // rejection is the failure shape EI-21901625037175266 was filed for.
    expect(q!.tool).toBe("coord:feed");
    expect(Object.keys(q!.args ?? {})).toContain("q");
    expect(q!.note).toMatch(/coord:feed/);
    // And it has to say WHY, or the next trim reads it as duplicated prose and cuts it:
    // coord:inbox is a bounded VIEW, not a query surface.
    expect(q!.note).toMatch(/no free-text search|not a query surface/i);
  });
});

describe("coord:inbox — agent-facing since_ts is deleted (D-013 R2)", () => {
  it("does not declare a `since_ts` argument", () => {
    expect(Object.keys(tool.args.out.shape)).not.toContain("since_ts");
  });

  it("keeps the filters that are genuinely the caller's to choose", () => {
    // The deletion is scoped to the cursor. Narrowing filters are not cursors and
    // must survive it — removing them too would be a silent capability loss.
    const keys = Object.keys(tool.args.out.shape);
    for (const kept of ["kinds", "from", "limit", "unanswered_only"]) {
      expect(keys).toContain(kept);
    }
  });

  it("no longer carries the WI-1600 since_ts CAUTION in its description", () => {
    expect(tool.description).not.toMatch(/WI-1600/);
    expect(tool.description).not.toMatch(/since_ts/);
  });

  it("does not steer callers to a since_ts poll in its guidance", () => {
    // NARROWED 2026-09-05 (tool-contract-repair-2026-09-05 P-001), same reasoning as the
    // includeRead guard above: `since_ts` was one of 7 time-bound filings that the
    // exact-key `since` redirect could not reach, so it now exists as an argRedirects
    // KEY — a correction for a caller who already sent it, pointing at coord:feed. The
    // banned thing is STEERING (offering it as a poll knob on this tool), which is what
    // these assertions now check directly rather than inferring from a substring.
    const guidance = tool.guidance as
      | { when?: string; notWhen?: string; chaining?: string; argRedirects?: Record<string, unknown> }
      | undefined;
    for (const prose of [tool.description, guidance?.when, guidance?.notWhen, guidance?.chaining]) {
      expect(prose ?? "").not.toMatch(/since_ts/);
    }
    const redirect = guidance?.argRedirects?.["since_ts"] as
      | { tool?: string; args?: Record<string, unknown>; note?: string }
      | string
      | undefined;
    if (redirect !== undefined) {
      expect(typeof redirect === "string" ? "" : redirect.tool).toBe("coord:feed");
      const note = typeof redirect === "string" ? redirect : (redirect.note ?? "");
      // It must send the caller AWAY, and must not re-offer a cursor on this tool.
      expect(note).toMatch(/no time filter/i);
      expect(Object.keys(typeof redirect === "string" ? {} : (redirect.args ?? {}))).not.toContain(
        "since_ts",
      );
    }
    // Whatever else guidance says, the argument itself stays deleted.
    expect(Object.keys(tool.args.out.shape)).not.toContain("since_ts");
  });
});

describe("coord:inbox — the VIEW contract is stated to the caller (D-013 R1)", () => {
  it("tells the caller a re-read re-shows the window rather than emptying out", () => {
    // Cheap-but-load-bearing: this is the promise that makes a same-turn second
    // read safe to interpret. Assert the PROMISE, not the prose, so the sentence
    // can be rewritten without failing here.
    expect(tool.description).toMatch(/VIEW/);
    expect(tool.description).toMatch(/not a delta/i);
  });
});

describe("coord:inbox — machine-readable result contract (EI-20243434212359053)", () => {
  it("skips the generic result door for programmatic inbox consumers", () => {
    expect((tool as { skipResultDoor?: string }).skipResultDoor).toBe("programmatic-caller");
  });
});

describe("read-cursor custody stays with the delivery path (D-013 R2/R3)", () => {
  it("the delivery surface is a single named constant, not a literal per call site", () => {
    // Two writers on one (owner, surface) two-phase cursor would promote a
    // pending floor the other never delivered against — at-least-once becomes
    // at-most-once, i.e. dropped mail. A shared constant is what keeps the
    // delivery path the sole custodian of this surface.
    expect(INBOX_CURSOR_SURFACE).toBe("inbox");
  });
});
