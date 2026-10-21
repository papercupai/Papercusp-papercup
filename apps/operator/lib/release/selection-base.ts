/**
 * selection-base.ts — P-011 / D-009 (gate-verdict-liveness-and-repair-reliability-2026-08-31).
 *
 * Resolves the affected-test SELECTION base for a gate suite run. Historically the gate
 * pinned AFFECTED_BASE to `lastReady` (the green pin), so across a long red the selection
 * radius `affected(main..candidate)` grew with the AGE of the outage (~6,653 files by day
 * 11 of the 2026-08 streak) — recovery cost coupled to outage age is why it never
 * self-healed. The last COMPLETED verdict's candidate is a sound, closer base, and the
 * two kinds of completed verdict already have durable anchors carrying exactly the
 * bookkeeping their soundness needs:
 *
 *   - test-leg-GREEN completed verdicts → the P-047 test-certified watermark
 *     (`refs/papercusp/test-certified`, scripts/lib/test-certified-base.mjs): it advances
 *     exactly when every file in that run's radius holds a PASS verdict at that sha
 *     (`decideWatermarkAdvance` refuses scoped / failed / undetermined / timed-out runs).
 *   - test-leg-RED completed verdicts → the frozen repair queue's candidate
 *     (freeze-and-converge): the freeze-time run was a full-radius completed verdict; its
 *     failures live ON the queue (failingTests / stillBroken), its passes are inheritable.
 *
 * PROMOTION STAYS FULL-CANDIDATE — ASSEMBLED, NOT RE-EXECUTED. Green ⇔ the delta
 * (anchor..head) suite is green ∧ (on queue runs) stillBroken is empty. Coverage of
 * lastReady..anchor is inherited through the chain of completed verdicts, each rendered
 * against its predecessor anchor, grounding at lastReady. Non-test gate legs (lint:tsc,
 * perf, desktop, delta) never read AFFECTED_BASE — this narrows TEST SELECTION only.
 *
 * FAIL-SAFE IN ONE DIRECTION ONLY (the P-047 doctrine): every branch that cannot be
 * positively verified falls back to `lastReady` — the historical behaviour. A silently
 * NARROWED run would under-test; that outcome must remain impossible here. The result's
 * `reason` names the branch taken so a test can tell a working guard from a resolver
 * that merely always returns `lastReady`.
 */

import { git as runGit } from "./git-ops";

/** Must equal `TEST_CERTIFIED_REF` in scripts/lib/test-certified-base.mjs — a hand-copied
 *  pair is exactly the drift the derived-truth ladder warns about, so selection-base.test.ts
 *  imports BOTH and compares (the same guard style P-047 uses for SCOPE_FLAGS). */
export const TEST_CERTIFIED_REF = "refs/papercusp/test-certified";

/** Same kill-switch as P-047, same value semantics ("0" disables): one switch, one
 *  semantic — the operator turning the watermark off turns off BOTH read sites.
 *  Equality with the mjs is guarded by selection-base.test.ts. */
export const SELECTION_BASE_DISABLE_ENV = "AFFECTED_TEST_CERTIFIED_BASE";

/**
 * WI-6554700010019329 / slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 D-064: the
 * env var naming the UPSTREAM tracking ref (e.g. `refs/remotes/origin/staging`) of a
 * working-copy (fork) pot. Set only for `review`-mode pots, by hive-release-env.ts.
 * Must equal `GATE_UPSTREAM_REF_ENV` in
 * packages/operator-core/lib/harness/git-sync/pot-integration-mode.ts. operator-core cannot
 * import apps/operator, so this is a pinned pair, and selection-base.test.ts imports BOTH
 * and compares them, the same guard style as TEST_CERTIFIED_REF above.
 */
export const GATE_UPSTREAM_REF_ENV = "PAPERCUSP_GATE_UPSTREAM_REF";

/** Only a remote-tracking ref can name "the upstream's history". A local branch of the
 *  fork (its own staging) would anchor the fork onto itself. */
const UPSTREAM_REF_PREFIX = "refs/remotes/";

export type SelectionBaseSource =
  | "last-ready"
  | "frozen-verdict"
  | "watermark"
  | "upstream-integration";

export interface SelectionBaseResult {
  /** What to pass to runGreen as the AFFECTED_BASE. `null` only when lastReady is null. */
  base: string | null;
  source: SelectionBaseSource;
  /** Names the branch taken. Load-bearing for tests: "refused because the anchor is
   *  behind main" and "refused because the function does nothing" must be
   *  distinguishable, or every negative case passes against total breakage. */
  reason: string;
  /** The anchor a guard REJECTED, when one was considered and turned down. */
  rejectedAnchor?: string;
  /** The configured upstream tracking ref, when this is a fork pot's run (D-064). */
  upstreamRef?: string;
  /** Why the upstream-integration anchor was NOT used, when an upstream ref was
   *  configured. The run then fell through to the frozen-verdict / watermark chain. */
  upstreamReason?: string;
}

/** Read-only git runner in the checkout the suite runs in. MUST return `null` for ANY
 *  failure (non-zero exit, missing binary, wrong dir) — every `null` falls back.
 *  `merge-base --is-ancestor` answers via exit status and prints nothing, so `''` means
 *  a VERIFIED true and `null` means "not an ancestor OR could not tell" — both of which
 *  are unverified, and unverified means fall back. */
export type SelectionBaseGit = (argv: string[]) => Promise<string | null>;

export interface SelectionBaseInput {
  /** The green pin sha (releaseRef) — the historical base and the universal fallback. */
  lastReady: string | null;
  /** The sha the suite is about to judge (the candidate; repairHead on a repair run). */
  judgedHead: string | null;
  /** The frozen repair queue's immutable candidate on a repair-verification run —
   *  the red-verdict anchor. Pass null on fresh cuts. */
  frozenCandidate?: string | null;
  env?: Record<string, string | undefined>;
  git?: SelectionBaseGit;
}

/** A SelectionBaseGit over the real git binary in `repo`; every failure becomes null. */
export function selectionBaseGitFor(repo: string): SelectionBaseGit {
  return async (argv) => {
    try {
      return await runGit(repo, argv);
    } catch {
      return null;
    }
  };
}

export async function resolveSelectionBase(
  input: SelectionBaseInput,
): Promise<SelectionBaseResult> {
  const { lastReady, judgedHead, frozenCandidate = null, env = {}, git } = input;
  const fallback = (reason: string, rejectedAnchor?: string): SelectionBaseResult => ({
    base: lastReady,
    source: "last-ready",
    reason,
    ...(rejectedAnchor ? { rejectedAnchor } : {}),
  });

  if (env[SELECTION_BASE_DISABLE_ENV] === "0") return fallback("disabled");
  if (!lastReady) return fallback("no-last-ready");
  if (!judgedHead) return fallback("no-judged-head");
  if (typeof git !== "function") return fallback("no-git-runner");

  // D-064 (WI-6554700010019329): a working-copy (fork) pot. Its integration branch absorbs
  // the upstream's integration branch on every sync-back, so its gate would otherwise
  // re-judge the whole upstream tree from the fork's stale main pin (measured: 16,563 files,
  // 197 tasks, killed at the 3h ceiling twice). Commits that are ALREADY on the upstream's
  // integration branch are judged by the upstream's own gate before they reach its main, so
  // the fork's gate judges only the fork's own delta: base = merge-base(head, upstream tip).
  // This is coverage DELEGATED to the upstream gate, not inherited from a verdict chain, so
  // it is taken only when the env var is set (review-mode pots only), and every unverifiable
  // step falls through to the frozen-verdict / watermark chain below, never narrower.
  const upstreamRef = env[GATE_UPSTREAM_REF_ENV]?.trim() || undefined;
  let upstreamReason: string | undefined;
  if (upstreamRef) {
    const up = await resolveUpstreamIntegrationAnchor(git, upstreamRef, judgedHead);
    if ("anchor" in up) {
      return { base: up.anchor, source: "upstream-integration", reason: "upstream-integration", upstreamRef };
    }
    upstreamReason = up.reason;
  }
  // Every result below carries the upstream provenance, so a fork run that fell through
  // says WHY in its SELECTION_BASE line instead of reading like an ordinary pot's run.
  const withUpstream = (r: SelectionBaseResult): SelectionBaseResult =>
    upstreamRef ? { ...r, upstreamRef, ...(upstreamReason ? { upstreamReason } : {}) } : r;
  const fall = (reason: string, rejectedAnchor?: string) =>
    withUpstream(fallback(reason, rejectedAnchor));

  let anchor: string;
  let source: SelectionBaseSource;
  if (frozenCandidate) {
    anchor = frozenCandidate;
    source = "frozen-verdict";
  } else {
    const sha = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `${TEST_CERTIFIED_REF}^{commit}`,
    ]);
    if (!sha) return fall("no-watermark");
    anchor = sha;
    source = "watermark";
  }

  // No gain, and lets a caller distinguish "anchor mechanism dead" from "anchor simply
  // hasn't moved past the green pin yet" — the two read identically at the env level.
  if (anchor === lastReady) return fall("anchor-at-last-ready");

  // Both ancestry checks are load-bearing (the P-047 pair):
  //  - the anchor must be an ANCESTOR OF THE JUDGED HEAD, or its diff describes a history
  //    this run is not judging (a rebase, a foreign ref, a salvage prefix behind it);
  //  - lastReady must be an ancestor of the ANCHOR, i.e. the anchor is at-or-ahead of the
  //    green pin. This makes the anchor only ever able to SHRINK the radius, never grow it.
  if ((await git(["merge-base", "--is-ancestor", anchor, judgedHead])) === null) {
    return fall(`${source}-not-ancestor-of-head`, anchor);
  }
  if ((await git(["merge-base", "--is-ancestor", lastReady, anchor])) === null) {
    return fall(`${source}-behind-last-ready`, anchor);
  }

  return withUpstream({ base: anchor, source, reason: source });
}

/**
 * D-064: the fork pot's anchor — the newest commit of the upstream's integration branch
 * that the judged head already contains. Returns a `reason` (and no anchor) for every case
 * that cannot be positively verified; the caller then falls through to the verdict chain.
 *
 *  - the ref must be a remote-tracking ref, or it is not "the upstream's history";
 *  - it must resolve to a commit in this checkout;
 *  - the merge-base must exist (a fork with unrelated history has none);
 *  - the merge-base must not BE the head: then the head is a pure upstream commit and the
 *    fork has no delta of its own, so an empty radius would read as a green verdict about
 *    nothing. That case is left to the verdict chain.
 *
 * merge-base(head, tip) is an ancestor of head by definition, so the frozen-verdict pair's
 * first check holds by construction. The second (lastReady ancestor of the anchor) is
 * deliberately NOT applied: a fork's lastReady is a fork-only commit, which is never an
 * ancestor of an upstream commit. Any fork-only commit behind the anchor is still in
 * diff(anchor, head), because the anchor is upstream-only history.
 */
export async function resolveUpstreamIntegrationAnchor(
  git: SelectionBaseGit,
  upstreamRef: string,
  judgedHead: string,
): Promise<{ anchor: string } | { reason: string }> {
  if (!upstreamRef.startsWith(UPSTREAM_REF_PREFIX)) return { reason: "upstream-ref-not-remote-tracking" };
  const tip = await git(["rev-parse", "--verify", "--quiet", `${upstreamRef}^{commit}`]);
  if (!tip) return { reason: "upstream-ref-missing" };
  const mergeBase = await git(["merge-base", judgedHead, tip]);
  if (!mergeBase) return { reason: "upstream-no-merge-base" };
  if (mergeBase === judgedHead) return { reason: "upstream-integration-at-head" };
  return { anchor: mergeBase };
}

/** The provenance line for every resolution — a non-default radius must never be a
 *  silent difference to whoever reads the checkpoint transcript later (the
 *  AFFECTED_BASE_SOURCE doctrine from P-047). Emitted on EVERY resolution, fallback
 *  included, so a transcript always answers "which base did this run select against". */
export function selectionBaseLine(
  r: SelectionBaseResult,
  lastReady: string | null,
): string {
  const short = (s: string | null) => (s ? s.slice(0, 12) : "null");
  // D-064: a fork pot's run names its upstream ref, and why that anchor was not used.
  const upstream = r.upstreamRef
    ? ` upstreamRef=${r.upstreamRef}` + (r.upstreamReason ? ` upstreamReason=${r.upstreamReason}` : "")
    : "";
  if (r.source === "upstream-integration") {
    return (
      `SELECTION_BASE source=upstream-integration base=${short(r.base)} advancedFrom=${short(lastReady)}${upstream} ` +
      `(D-064: fork pot — commits already on the upstream integration branch are judged by the ` +
      `upstream's own gate; this run judges the fork's own delta. Set ${SELECTION_BASE_DISABLE_ENV}=0 to disable)`
    );
  }
  if (r.source === "last-ready") {
    return (
      `SELECTION_BASE source=last-ready base=${short(r.base)} reason=${r.reason}` +
      (r.rejectedAnchor ? ` rejected=${short(r.rejectedAnchor)}` : "") +
      upstream +
      ` (P-011/D-009: no usable completed-verdict anchor — full last-green radius)`
    );
  }
  return (
    `SELECTION_BASE source=${r.source} base=${short(r.base)} advancedFrom=${short(lastReady)}${upstream} ` +
    `(P-011/D-009: coverage of the gap is inherited from the completed verdict at the anchor; ` +
    `set ${SELECTION_BASE_DISABLE_ENV}=0 to disable)`
  );
}

export interface EarlyTypecheckBaseResult {
  base: string | null;
  source: "repair-candidate" | "upstream-integration" | "last-ready";
  /** Why the upstream anchor was not used (last-ready only). */
  reason?: string;
}

/**
 * D-064 (WI-6554700010019329): the diff base for the early changed-file typecheck preflight.
 *
 * A frozen repair round keeps its frozen-candidate base (P-035). A fork-mode pot
 * (`PAPERCUSP_GATE_UPSTREAM_REF` set) anchors at merge-base(candidate, upstream) — the same
 * anchor its suite selection uses — so the preflight checks the fork's own delta, not the
 * upstream history between the fork's last green and the candidate. Measured on
 * papercusp-pr-drill-20261014 run a9992c54 before this: 12,235 files, 1,346s. The unscoped
 * post-suite typechecks still judge the whole head, so nothing goes unchecked.
 *
 * Every other case — not a fork pot, no prior green pin, the selection base disabled, an anchor
 * miss, a git fault — keeps `lastReady`, so the preflight is never narrower than its historical
 * radius except through the one D-064 anchor.
 */
export async function resolveEarlyTypecheckBase(input: {
  lastReady: string | null;
  candidate: string;
  repairBase: string | null;
  env: Record<string, string | undefined>;
  git: SelectionBaseGit;
}): Promise<EarlyTypecheckBaseResult> {
  if (input.repairBase) return { base: input.repairBase, source: "repair-candidate" };
  const keep = (reason: string): EarlyTypecheckBaseResult => ({
    base: input.lastReady,
    source: "last-ready",
    reason,
  });
  if (!input.lastReady) return keep("no-last-ready");
  if (input.env[SELECTION_BASE_DISABLE_ENV] === "0") return keep("disabled");
  const upstreamRef = input.env[GATE_UPSTREAM_REF_ENV]?.trim();
  if (!upstreamRef) return keep("not-a-fork-pot");
  try {
    const up = await resolveUpstreamIntegrationAnchor(input.git, upstreamRef, input.candidate);
    return "anchor" in up
      ? { base: up.anchor, source: "upstream-integration" }
      : keep(up.reason);
  } catch (e) {
    return keep(`resolver-error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
