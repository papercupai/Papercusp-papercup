/**
 * P-001 (tool-contract-repair-2026-09-05) — coord:inbox argument contract.
 *
 * The lane's evidence: 511 `toolFailureProbation` filings name coord:inbox, and
 * grouping them by REJECTED KEY (not by prose) gives a small, very lopsided
 * population. `argRedirects.since` had already proved the repair mechanism —
 * `since` filings ran ~20/day until it landed 2026-08-24 and ~3/day after — so
 * this item applied the same mechanism to the clusters it did not cover:
 *
 *   read/unread   64  unreadOnly 21, includeRead 21, unread 8, unread_only 7,
 *                     include_read 6, includeHandled 1        -> BETTER-ERROR
 *   transport     23  harness 21, workspace 1, scope 1        -> BETTER-ERROR
 *   unanswered    16  unanswered                              -> ALIAS
 *   body          15  includeBody 6, includeBodies 4,
 *                     include_body 3, bodyChars, truncateChars -> BETTER-ERROR
 *   time (other)   7  since_ts 6, after 1                     -> redirect to feed
 *   directed       2  directed                                -> NEW CAPABILITY
 *
 * These tests pin the DISPOSITIONS, not the prose, so a reworded note stays green
 * while a silently DROPPED redirect goes red. That distinction is the point: the
 * failure this guards against is a future edit deleting a redirect to reclaim
 * prompt weight, which would look harmless because argRedirects is invisible in
 * the projected tool text and is paid only on the failure path.
 */
import { describe, expect, it } from "vitest";
import inboxTool from "./inbox";
import { isDirectedDelivery } from "../inbox-visibility";
import { BUDGET, promptWeight } from "../../tool-guidance-budget";

type Redirect = string | { tool: string; args: Record<string, unknown>; note?: string };

function redirects(): Record<string, Redirect> {
  return (inboxTool.guidance as { argRedirects?: Record<string, Redirect> } | undefined)
    ?.argRedirects ?? {};
}

/** WI-6554700010029664: args is a preprocess pipe (alias fold); `out` is the declared object. */
function declaredShape(): Record<string, { description?: string }> {
  const args = inboxTool.args as unknown as { out?: { shape?: Record<string, { description?: string }> } };
  const shape = args.out?.shape;
  if (!shape) throw new Error("could not read coord:inbox's declared object shape");
  return shape;
}

function declaredKeys(): string[] {
  return Object.keys(declaredShape());
}

describe("coord:inbox argument contract (P-001)", () => {
  it("explains unread FYI receipts without conflating reading with answering, within the prompt budget", () => {
    expect(inboxTool.description).toContain('clears the unread-mail reminder');
    expect(inboxTool.description).toContain('FYIs (expects:none) need no reply');
    expect(inboxTool.description).toContain('Reading does not fulfill ack/answer/action requests');
    expect(inboxTool.description).toContain('re-reading does not empty it');
    expect(promptWeight(inboxTool as unknown as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });

  it("documents that the limit uses priority ranking rather than newest-first overall", () => {
    const description = declaredShape().limit?.description ?? "";
    expect(description).toMatch(/priority-ranked/i);
    expect(description).toMatch(/newest-first overall is not guaranteed/i);
    expect(description).not.toMatch(/most-recent kept/i);
  });

  // The alias half. `unanswered` is a genuine, unambiguous synonym for
  // `unanswered_only` — the plan's ALIAS rule — so it is ACCEPTED rather than
  // redirected, and the caller's first call succeeds instead of round-tripping.
  it("accepts `unanswered` as an alias (folded before parse), not a redirect", () => {
    // WI-6554700010029664: accepted via the schema's preprocess fold, not declared.
    expect(inboxTool.args.safeParse({ unanswered: true }).data).toMatchObject({ unanswered_only: true });
    // A key cannot be both accepted and redirected: unknownArgHint only fires for
    // keys the schema REJECTS, so a redirect here would be dead text.
    expect(redirects().unanswered).toBeUndefined();
  });

  it("keeps the canonical snake_case key and still accepts its camelCase alias", () => {
    expect(declaredKeys()).toContain("unanswered_only");
    expect(inboxTool.args.safeParse({ unansweredOnly: true }).data).toMatchObject({ unanswered_only: true });
    // The canonical key wins when several spellings are supplied.
    expect(inboxTool.args.safeParse({ unanswered_only: false, unansweredOnly: true }).data).toMatchObject({
      unanswered_only: false,
    });
  });

  it("declares `directed` as a real filter (the capability the item asked for)", () => {
    // The plan item flagged `directed` as "worth ADDING rather than aliasing,
    // since 'messages actually addressed to me' is the question the tool exists
    // to answer". It is a new arg, not a redirect.
    expect(declaredKeys()).toContain("directed");
    expect(redirects().directed).toBeUndefined();
  });

  // The BETTER-ERROR half. Each of these names a real capability AND its semantic
  // difference, because accepting them as aliases would fuse two meanings.
  const mustRedirect: Array<[key: string, mustMention: RegExp]> = [
    ["unreadOnly", /unanswered_only/],
    ["unread_only", /unanswered_only/],
    ["unread", /unanswered_only/],
    ["includeRead", /unanswered_only|directed/],
    ["include_read", /unanswered_only|directed/],
    ["includeHandled", /unanswered_only/],
    ["harness", /coord:feed|scoped to YOU|transport/i],
    ["workspace", /scoped to YOU|transport/i],
    ["scope", /limit|kinds|directed/],
    ["includeBody", /max_body_chars/],
    ["includeBodies", /max_body_chars/],
    ["include_body", /max_body_chars/],
    ["bodyChars", /max_body_chars/],
    ["truncateChars", /max_body_chars/],
    ["since_ts", /coord:feed/],
    ["after", /coord:feed/],
    ["owner", /coord:feed/],
    ["sender", /from/],
    ["include_notify", /include_ambient/],
    // Pre-existing entries this item must not regress.
    ["since", /coord:feed/],
    ["q", /coord:feed/],
    ["include_retracted", /coord:feed/],
  ];

  it.each(mustRedirect)("redirects `%s` with an actionable remedy", (key, mustMention) => {
    const redirect = redirects()[key];
    expect(redirect, `argRedirects.${key} is missing`).toBeDefined();
    const rendered =
      typeof redirect === "string"
        ? redirect
        : `${redirect!.tool} ${JSON.stringify(redirect!.args)} ${redirect!.note ?? ""}`;
    expect(rendered).toMatch(mustMention);
  });

  it("never redirects a key the schema actually accepts", () => {
    // A redirect for an accepted key is unreachable: the validator only rejects
    // undeclared keys, so such an entry is dead text that reads like live guidance.
    const accepted = new Set(declaredKeys());
    for (const key of Object.keys(redirects())) {
      expect(accepted.has(key), `argRedirects.${key} shadows an accepted arg`).toBe(false);
    }
  });

  it("points every same-tool redirect at an arg that really exists", () => {
    // Guards the failure mode a redirect is supposed to PREVENT: sending the caller
    // to a second rejection. coord:presence hit exactly this when a string-distance
    // guess proposed `scope`, whose enum then failed the retry.
    const accepted = new Set(declaredKeys());
    for (const [key, redirect] of Object.entries(redirects())) {
      if (typeof redirect === "string") {
        expect(accepted.has(redirect), `argRedirects.${key} -> unknown arg ${redirect}`).toBe(true);
        continue;
      }
      if (redirect.tool !== "coord:inbox") continue;
      for (const argName of Object.keys(redirect.args)) {
        expect(accepted.has(argName), `argRedirects.${key} -> unknown arg ${argName}`).toBe(true);
      }
    }
  });
});

describe("isDirectedDelivery (P-001)", () => {
  it("treats wildcard-only and mixed broadcasts for other recipients as NOT directed", () => {
    expect(isDirectedDelivery({ to: ["*"] }, "su-me")).toBe(false);
    expect(isDirectedDelivery({ to: ["*", "*"] }, "su-me")).toBe(false);
    expect(isDirectedDelivery({ to: ["human", "*"] }, "su-me")).toBe(false);
    expect(isDirectedDelivery({ to: ["su-other", "*"] }, "su-me")).toBe(false);
  });

  it("treats an entry naming this reader as directed", () => {
    expect(isDirectedDelivery({ to: ["su-me"] }, "su-me")).toBe(true);
    expect(isDirectedDelivery({ to: ["su-other"] }, "su-me")).toBe(false);
  });

  it("treats MIXED ['*', owner] delivery as directed only for the named owner", () => {
    expect(isDirectedDelivery({ to: ["*", "su-me"] }, "su-me")).toBe(true);
    expect(isDirectedDelivery({ to: ["*", "su-other"] }, "su-me")).toBe(false);
  });

  it("fails OPEN for an unusable `to`, never hiding a delivered message", () => {
    // An inbox filter may under-filter; it must not silently drop a message that
    // genuinely reached this reader.
    expect(isDirectedDelivery({}, "su-me")).toBe(true);
    expect(isDirectedDelivery({ to: [] }, "su-me")).toBe(true);
    expect(isDirectedDelivery({ to: "su-me" }, "su-me")).toBe(true);
  });
});
