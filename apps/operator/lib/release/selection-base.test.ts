/**
 * selection-base.test.ts — P-011 / D-009 (gate-verdict-liveness-and-repair-reliability-2026-08-31).
 *
 * Guards the gate-side selection-base resolver. The whole feature is a fail-safe, and
 * the safe answer (`lastReady`) is ALSO what a completely broken implementation returns —
 * so every negative case here asserts the `reason` too (the P-047 test doctrine: `reason`
 * is what makes "refused because the anchor is behind main" and "refused because the
 * function does nothing" distinguishable at all).
 *
 * The subject is a pure function over an injected git runner, so these run with no git
 * fixture, no temp repo, and no mutation of the shared checkout.
 *
 * CONSTANT-SYNC GUARD: the ref + kill-switch names are a deliberate pair with
 * scripts/lib/test-certified-base.mjs (one switch, one semantic — D-009). A hand-copied
 * pair is exactly the drift the derived-truth ladder warns about, so this file imports
 * BOTH modules and compares — the same guard style P-047 uses for SCOPE_FLAGS.
 */
import { describe, expect, it } from "vitest";

import {
  DISABLE_ENV as MJS_DISABLE_ENV,
  TEST_CERTIFIED_REF as MJS_TEST_CERTIFIED_REF,
} from "../../../../scripts/lib/test-certified-base.mjs";

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GATE_UPSTREAM_REF_ENV as CORE_GATE_UPSTREAM_REF_ENV,
  potUpstreamTrackingRef,
} from "@papercusp/operator-core/lib/harness/git-sync/pot-integration-mode";

import {
  GATE_UPSTREAM_REF_ENV,
  SELECTION_BASE_DISABLE_ENV,
  TEST_CERTIFIED_REF,
  resolveSelectionBase,
  selectionBaseGitFor,
  selectionBaseLine,
  type SelectionBaseResult,
} from "./selection-base";

const LAST_READY = "a".repeat(40);
const HEAD = "b".repeat(40);
const WATERMARK = "c".repeat(40);
const FROZEN = "d".repeat(40);

const REV_PARSE = `rev-parse --verify --quiet ${TEST_CERTIFIED_REF}^{commit}`;
const anchorAncestorOfHead = (anchor: string) =>
  `merge-base --is-ancestor ${anchor} ${HEAD}`;
const lastReadyAncestorOf = (anchor: string) =>
  `merge-base --is-ancestor ${LAST_READY} ${anchor}`;

/**
 * A git runner that answers only what it is told to and records what it was asked.
 *
 * `merge-base --is-ancestor` answers through its EXIT STATUS and prints nothing, so the
 * real runner returns `''` for a verified true and `null` for false-or-could-not-tell.
 * Reproducing that here is load-bearing: an implementation that tested truthiness
 * instead of `!== null` would read every verified ancestry as a failure, and the healthy
 * cases below would catch it (they are this suite's calibration control).
 */
function fakeGit(responses: Record<string, string | null>) {
  const calls: string[][] = [];
  const git = async (argv: string[]): Promise<string | null> => {
    calls.push(argv);
    const key = argv.join(" ");
    return key in responses ? responses[key] : null;
  };
  return { git, calls };
}

/** A watermark that exists, is on the judged history, and is at-or-ahead of lastReady. */
const HEALTHY_WATERMARK: Record<string, string | null> = {
  [REV_PARSE]: WATERMARK,
  [anchorAncestorOfHead(WATERMARK)]: "",
  [lastReadyAncestorOf(WATERMARK)]: "",
};

const HEALTHY_FROZEN: Record<string, string | null> = {
  [anchorAncestorOfHead(FROZEN)]: "",
  [lastReadyAncestorOf(FROZEN)]: "",
};

function base(overrides: Record<string, unknown> = {}) {
  return {
    lastReady: LAST_READY,
    judgedHead: HEAD,
    env: {},
    ...overrides,
  };
}

describe("selection base: constant sync with scripts/lib/test-certified-base.mjs (D-009)", () => {
  it("uses the exact P-047 watermark ref", () => {
    expect(TEST_CERTIFIED_REF).toBe(MJS_TEST_CERTIFIED_REF);
  });
  it("uses the exact P-047 kill-switch env var — one switch, one semantic", () => {
    expect(SELECTION_BASE_DISABLE_ENV).toBe(MJS_DISABLE_ENV);
  });
});

describe("selection base: fresh cuts (watermark anchor)", () => {
  it("advances to a healthy watermark", async () => {
    const { git } = fakeGit(HEALTHY_WATERMARK);
    const r = await resolveSelectionBase(base({ git }));
    expect(r).toEqual({ base: WATERMARK, source: "watermark", reason: "watermark" });
  });

  it("falls back when no watermark ref exists", async () => {
    const { git } = fakeGit({});
    const r = await resolveSelectionBase(base({ git }));
    expect(r.base).toBe(LAST_READY);
    expect(r.source).toBe("last-ready");
    expect(r.reason).toBe("no-watermark");
  });

  it("falls back when the watermark is not an ancestor of the judged head", async () => {
    const { git } = fakeGit({ ...HEALTHY_WATERMARK, [anchorAncestorOfHead(WATERMARK)]: null });
    const r = await resolveSelectionBase(base({ git }));
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("watermark-not-ancestor-of-head");
    expect(r.rejectedAnchor).toBe(WATERMARK);
  });

  it("falls back when the watermark is behind lastReady (anchor may only SHRINK the radius)", async () => {
    const { git } = fakeGit({ ...HEALTHY_WATERMARK, [lastReadyAncestorOf(WATERMARK)]: null });
    const r = await resolveSelectionBase(base({ git }));
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("watermark-behind-last-ready");
    expect(r.rejectedAnchor).toBe(WATERMARK);
  });

  it("falls back with a distinct reason when the watermark IS lastReady (no gain, mechanism alive)", async () => {
    const { git } = fakeGit({ [REV_PARSE]: LAST_READY });
    const r = await resolveSelectionBase(base({ git }));
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("anchor-at-last-ready");
  });
});

describe("selection base: repair runs (frozen-verdict anchor)", () => {
  it("advances to a healthy frozen candidate and never consults the watermark", async () => {
    const { git, calls } = fakeGit(HEALTHY_FROZEN);
    const r = await resolveSelectionBase(base({ git, frozenCandidate: FROZEN }));
    expect(r).toEqual({ base: FROZEN, source: "frozen-verdict", reason: "frozen-verdict" });
    // The red-verdict anchor outranks the watermark: a repair run must diff against the
    // sha whose failures the queue is tracking, not a possibly-newer green watermark.
    expect(calls.map((c) => c.join(" "))).not.toContain(REV_PARSE);
  });

  it("falls back when the frozen candidate is not an ancestor of the judged head", async () => {
    const { git } = fakeGit({ ...HEALTHY_FROZEN, [anchorAncestorOfHead(FROZEN)]: null });
    const r = await resolveSelectionBase(base({ git, frozenCandidate: FROZEN }));
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("frozen-verdict-not-ancestor-of-head");
    expect(r.rejectedAnchor).toBe(FROZEN);
  });

  it("falls back when the frozen candidate is behind lastReady", async () => {
    const { git } = fakeGit({ ...HEALTHY_FROZEN, [lastReadyAncestorOf(FROZEN)]: null });
    const r = await resolveSelectionBase(base({ git, frozenCandidate: FROZEN }));
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("frozen-verdict-behind-last-ready");
  });

  it("reports anchor-at-last-ready when the frozen candidate IS lastReady", async () => {
    const { git } = fakeGit({});
    const r = await resolveSelectionBase(base({ git, frozenCandidate: LAST_READY }));
    expect(r.reason).toBe("anchor-at-last-ready");
  });
});

describe("selection base: the unconditional fallbacks", () => {
  it("honors the shared kill-switch value '0'", async () => {
    const { git, calls } = fakeGit(HEALTHY_WATERMARK);
    const r = await resolveSelectionBase(
      base({ git, env: { [SELECTION_BASE_DISABLE_ENV]: "0" } }),
    );
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  it("does NOT disable on other env values", async () => {
    const { git } = fakeGit(HEALTHY_WATERMARK);
    const r = await resolveSelectionBase(
      base({ git, env: { [SELECTION_BASE_DISABLE_ENV]: "1" } }),
    );
    expect(r.source).toBe("watermark");
  });

  it("falls back when lastReady is null (no shrink-only guard is provable)", async () => {
    const { git } = fakeGit(HEALTHY_WATERMARK);
    const r = await resolveSelectionBase(base({ git, lastReady: null }));
    expect(r).toMatchObject({ base: null, source: "last-ready", reason: "no-last-ready" });
  });

  it("falls back when judgedHead is null", async () => {
    const { git } = fakeGit(HEALTHY_WATERMARK);
    const r = await resolveSelectionBase(base({ git, judgedHead: null }));
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("no-judged-head");
  });

  it("falls back when no git runner is supplied", async () => {
    const r = await resolveSelectionBase(base());
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("no-git-runner");
  });
});

describe("selectionBaseGitFor", () => {
  it("returns null for ANY failure (nonexistent repo) instead of throwing", async () => {
    const git = selectionBaseGitFor("/nonexistent/selection-base-test-dir");
    await expect(git(["rev-parse", "HEAD"])).resolves.toBeNull();
  });
});

describe("selectionBaseLine (provenance is never silent)", () => {
  const shortOf = (s: string) => s.slice(0, 12);

  it("names source, base, and the advanced-from sha on an advanced resolution", () => {
    const r: SelectionBaseResult = { base: WATERMARK, source: "watermark", reason: "watermark" };
    const line = selectionBaseLine(r, LAST_READY);
    expect(line).toContain("SELECTION_BASE source=watermark");
    expect(line).toContain(`base=${shortOf(WATERMARK)}`);
    expect(line).toContain(`advancedFrom=${shortOf(LAST_READY)}`);
    expect(line).toContain(`${SELECTION_BASE_DISABLE_ENV}=0`);
  });

  it("names the refusal reason and the rejected anchor on a fallback", () => {
    const r: SelectionBaseResult = {
      base: LAST_READY,
      source: "last-ready",
      reason: "watermark-behind-last-ready",
      rejectedAnchor: WATERMARK,
    };
    const line = selectionBaseLine(r, LAST_READY);
    expect(line).toContain("source=last-ready");
    expect(line).toContain("reason=watermark-behind-last-ready");
    expect(line).toContain(`rejected=${shortOf(WATERMARK)}`);
  });

  it("names the upstream ref and says coverage is delegated on a fork pot's anchor (D-064)", () => {
    const r: SelectionBaseResult = {
      base: MERGE_BASE,
      source: "upstream-integration",
      reason: "upstream-integration",
      upstreamRef: UPSTREAM_REF,
    };
    const line = selectionBaseLine(r, LAST_READY);
    expect(line).toContain("SELECTION_BASE source=upstream-integration");
    expect(line).toContain(`base=${shortOf(MERGE_BASE)}`);
    expect(line).toContain(`upstreamRef=${UPSTREAM_REF}`);
    expect(line).toContain("judged by the upstream's own gate");
  });

  it("says why a configured upstream anchor was not used when the run fell through", () => {
    const r: SelectionBaseResult = {
      base: LAST_READY,
      source: "last-ready",
      reason: "no-watermark",
      upstreamRef: UPSTREAM_REF,
      upstreamReason: "upstream-ref-missing",
    };
    const line = selectionBaseLine(r, LAST_READY);
    expect(line).toContain("upstreamReason=upstream-ref-missing");
    expect(line).toContain("reason=no-watermark");
  });
});

// ── D-064 (WI-6554700010019329): working-copy (fork) pots ──────────────────────────

const UPSTREAM_REF = "refs/remotes/origin/staging";
const UPSTREAM_TIP = "e".repeat(40);
const MERGE_BASE = "f".repeat(40);
const UPSTREAM_REV_PARSE = `rev-parse --verify --quiet ${UPSTREAM_REF}^{commit}`;
const UPSTREAM_MERGE_BASE = `merge-base ${HEAD} ${UPSTREAM_TIP}`;
const HEALTHY_UPSTREAM: Record<string, string | null> = {
  [UPSTREAM_REV_PARSE]: UPSTREAM_TIP,
  [UPSTREAM_MERGE_BASE]: MERGE_BASE,
};
const forkEnv = (ref = UPSTREAM_REF) => ({ [GATE_UPSTREAM_REF_ENV]: ref });

describe("selection base: fork pots anchor at the upstream merge-base (D-064)", () => {
  it("pins the env var name to operator-core's, which hive-release-env sets", () => {
    expect(GATE_UPSTREAM_REF_ENV).toBe(CORE_GATE_UPSTREAM_REF_ENV);
  });

  it("derives the upstream tracking ref from the pot's upstream branch", () => {
    expect(potUpstreamTrackingRef({ upstreamBranch: "staging" })).toBe("refs/remotes/origin/staging");
    expect(potUpstreamTrackingRef(undefined)).toBe("refs/remotes/origin/main");
  });

  it("anchors at merge-base(head, upstream tip) without the lastReady-ancestor check", async () => {
    const { git, calls } = fakeGit(HEALTHY_UPSTREAM);
    const r = await resolveSelectionBase(base({ git, env: forkEnv() }));
    expect(r).toEqual({
      base: MERGE_BASE,
      source: "upstream-integration",
      reason: "upstream-integration",
      upstreamRef: UPSTREAM_REF,
    });
    // A fork's lastReady is a fork-only commit, never an ancestor of upstream history,
    // so applying the P-047 pair here would refuse every fork run (the measured bug).
    expect(calls.map((c) => c.join(" "))).not.toContain(lastReadyAncestorOf(MERGE_BASE));
    // The verdict chain is not consulted once the upstream anchor resolves.
    expect(calls.map((c) => c.join(" "))).not.toContain(REV_PARSE);
  });

  it("takes precedence over a frozen candidate on a fork repair run", async () => {
    const { git } = fakeGit({ ...HEALTHY_UPSTREAM, ...HEALTHY_FROZEN });
    const r = await resolveSelectionBase(base({ git, env: forkEnv(), frozenCandidate: FROZEN }));
    expect(r.source).toBe("upstream-integration");
    expect(r.base).toBe(MERGE_BASE);
  });

  it("falls through to the watermark when the upstream ref does not resolve", async () => {
    const { git } = fakeGit(HEALTHY_WATERMARK);
    const r = await resolveSelectionBase(base({ git, env: forkEnv() }));
    expect(r.source).toBe("watermark");
    expect(r.base).toBe(WATERMARK);
    expect(r.upstreamRef).toBe(UPSTREAM_REF);
    expect(r.upstreamReason).toBe("upstream-ref-missing");
  });

  it("refuses a ref that is not remote-tracking without asking git about it", async () => {
    const { git, calls } = fakeGit({ ...HEALTHY_UPSTREAM, "rev-parse --verify --quiet refs/heads/staging^{commit}": HEAD });
    const r = await resolveSelectionBase(base({ git, env: forkEnv("refs/heads/staging") }));
    expect(r.source).toBe("last-ready");
    expect(r.upstreamReason).toBe("upstream-ref-not-remote-tracking");
    expect(calls.map((c) => c.join(" "))).not.toContain("rev-parse --verify --quiet refs/heads/staging^{commit}");
  });

  it("does not narrow to an empty radius when the head IS an upstream commit", async () => {
    const { git } = fakeGit({ [UPSTREAM_REV_PARSE]: UPSTREAM_TIP, [UPSTREAM_MERGE_BASE]: HEAD });
    const r = await resolveSelectionBase(base({ git, env: forkEnv() }));
    expect(r.base).toBe(LAST_READY);
    expect(r.upstreamReason).toBe("upstream-integration-at-head");
  });

  it("falls back when the head shares no history with the upstream", async () => {
    const { git } = fakeGit({ [UPSTREAM_REV_PARSE]: UPSTREAM_TIP });
    const r = await resolveSelectionBase(base({ git, env: forkEnv() }));
    expect(r.base).toBe(LAST_READY);
    expect(r.upstreamReason).toBe("upstream-no-merge-base");
  });

  it("is disabled by the shared kill-switch like every other anchor", async () => {
    const { git, calls } = fakeGit(HEALTHY_UPSTREAM);
    const r = await resolveSelectionBase(
      base({ git, env: { ...forkEnv(), [SELECTION_BASE_DISABLE_ENV]: "0" } }),
    );
    expect(r).toMatchObject({ base: LAST_READY, reason: "disabled" });
    expect(calls).toEqual([]);
  });

  it("an ordinary (direct) pot never consults an upstream", async () => {
    const { git, calls } = fakeGit({ ...HEALTHY_UPSTREAM, ...HEALTHY_WATERMARK });
    const r = await resolveSelectionBase(base({ git }));
    expect(r.source).toBe("watermark");
    expect(r.upstreamRef).toBeUndefined();
    expect(calls.map((c) => c.join(" "))).not.toContain(UPSTREAM_REV_PARSE);
  });
});

describe("selection base: a real fork history selects only the fork's own delta (D-064)", () => {
  // The measured shape (WI-6554700010019329): the fork's lastReady is a fork-only commit on
  // an old upstream; staging absorbed newer upstream work by a sync-back merge; then the
  // fork's own fix landed; meanwhile the upstream tracking ref moved on again.
  it("diff(base, head) is the fork's files, not the upstream's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "selection-base-fork-"));
    const g = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
        cwd: dir,
        encoding: "utf8",
      }).trim();
    const commit = (file: string, msg: string) => {
      writeFileSync(join(dir, file), msg);
      g("add", file);
      g("commit", "-q", "-m", msg);
      return g("rev-parse", "HEAD");
    };
    try {
      g("init", "-q", "-b", "upstream");
      commit("u1.txt", "u1");
      g("checkout", "-q", "-b", "fork");
      const forkLastReady = commit("fork0.txt", "fork0");
      g("checkout", "-q", "upstream");
      const u2 = commit("u2.txt", "u2");
      g("checkout", "-q", "fork");
      g("merge", "-q", "--no-edit", "upstream");
      const head = commit("fix.ts", "fix");
      g("checkout", "-q", "upstream");
      const u3 = commit("u3.txt", "u3");
      g("update-ref", UPSTREAM_REF, u3);
      g("checkout", "-q", "fork");

      const r = await resolveSelectionBase({
        lastReady: forkLastReady,
        judgedHead: head,
        env: forkEnv(),
        git: selectionBaseGitFor(dir),
      });
      expect(r.source).toBe("upstream-integration");
      expect(r.base).toBe(u2);
      const radius = g("diff", "--name-only", r.base as string, head).split("\n").sort();
      expect(radius).toEqual(["fix.ts", "fork0.txt"]);
      // Calibration: the historical last-ready radius also re-judges the upstream's file.
      expect(g("diff", "--name-only", forkLastReady, head).split("\n").sort()).toEqual(["fix.ts", "u2.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
