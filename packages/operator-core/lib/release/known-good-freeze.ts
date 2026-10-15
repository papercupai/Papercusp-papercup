/**
 * Freeze from known-good points (green-main-cycle-time-2026-10-08 P-012).
 *
 * The gate's FRESH cut (no live frozen queue, no explicit candidate) used to judge the bare
 * staging tip (stepped back only by the quiet cut). P-012: judge the newest staging commit whose
 * per-sync batch check PASSED instead — the commit the sync-batch-delta-check routine records as
 * `metadata.sync_delta.lastPassed` (see `SyncDeltaCursor.lastPassed`). A known-good cut starts
 * the round from a commit whose own radius already typechecked and tested green, so the first
 * round's reds are the ones that check cannot see, not ones it already reported.
 *
 * "Passed" is the per-sync check's verdict, with its limits: it judged the BATCH RADIUS of the
 * commits since its previous cursor, against the shared working tree at the time it ran. It is
 * evidence the commit is not known-broken, never proof that the full suite is green.
 *
 * The rules never starve the gate:
 *   - a known-good commit that is NOT on the tip's lineage is ignored (history rewrite, a
 *     cursor from another branch);
 *   - a known-good commit that is not STRICTLY AHEAD of the current green pin is ignored — it
 *     can only re-judge or regress `main`. When the per-sync check lags, the gate promotes to
 *     the known-good point, the pin catches up with it, and the next cut falls back to the tip.
 *
 * Pure: git reachability is injected (`isAncestor`), so every branch is unit-testable.
 */

/** A staging commit the per-sync batch check judged green (`SyncDeltaCursor.lastPassed`). */
export interface KnownGoodPoint {
  sha: string;
  /** Epoch ms of the per-sync run that judged it. */
  atMs: number;
}

/** Where the gate's fresh cut came from. */
export type FreezeCutSource = 'known-good' | 'staging-tip';

export type FreezeCutReason =
  /** The known-good commit is the judged candidate. */
  | 'known-good-selected'
  /** The per-sync check has no passed commit on record (or no reader is wired). */
  | 'no-known-good'
  /** The known-good record could not be read; the tip is judged. */
  | 'known-good-unreadable'
  /** The known-good commit is not an ancestor of the tip. */
  | 'known-good-not-on-tip-lineage'
  /** The known-good commit is the green pin or behind it. */
  | 'known-good-not-ahead-of-green'
  /** P-010: the cut had to advance to the staging tip to carry a retired queue's fixes. */
  | 'carry-advanced-to-tip';

/** The freeze cut record stamped on the verdict of every fresh-cut run. */
export interface FreezeCutRecord {
  source: FreezeCutSource;
  reason: FreezeCutReason;
  /** The commit this run judges. */
  candidate: string;
  /** The staging tip when the cut was made (before the quiet cut). */
  tip: string;
  /** The per-sync check's newest passed commit, when one was offered. */
  knownGood: string | null;
}

/** The legs that were red on a candidate's FIRST round (R1). */
export interface RedLegsAtR1 {
  candidate: string;
  source: FreezeCutSource;
  /** Red leg ids, in a stable order. Empty = R1 was green. */
  legs: string[];
}

export interface FreezeCutInput {
  /** The staging tip before any step-back. */
  tip: string;
  /** The candidate the cut would judge without P-012 (the quiet-cut pick, or the tip). */
  candidate: string;
  /** The current green pin, or null on a first promotion. */
  lastReady: string | null;
  /** The per-sync check's newest passed commit, or null. */
  knownGood: string | null;
  /** True when reading the known-good record failed. */
  knownGoodUnreadable?: boolean;
  /** `git merge-base --is-ancestor a b` (true when a === b). */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

/**
 * Decide the fresh cut. Never throws: a reachability probe that fails reads as "not usable",
 * so the gate judges the candidate it would have judged without P-012.
 */
export async function decideKnownGoodFreezeCut(input: FreezeCutInput): Promise<FreezeCutRecord> {
  const { tip, candidate, lastReady, knownGood } = input;
  const keep = (reason: FreezeCutReason): FreezeCutRecord => ({
    source: 'staging-tip',
    reason,
    candidate,
    tip,
    knownGood,
  });
  if (!knownGood) return keep(input.knownGoodUnreadable ? 'known-good-unreadable' : 'no-known-good');
  const reachable = async (a: string, b: string): Promise<boolean> => {
    try {
      return await input.isAncestor(a, b);
    } catch {
      return false;
    }
  };
  if (!(await reachable(knownGood, tip))) return keep('known-good-not-on-tip-lineage');
  if (lastReady && (knownGood === lastReady || !(await reachable(lastReady, knownGood)))) {
    return keep('known-good-not-ahead-of-green');
  }
  return { source: 'known-good', reason: 'known-good-selected', candidate: knownGood, tip, knownGood };
}

/** One post-suite leg's outcome, as the gate records it. */
export interface R1LegOutcome {
  id: string;
  status: 'passed' | 'failed' | 'skipped';
}

/** Leg id for the candidate suite itself (the affected/full test run). */
export const R1_SUITE_LEG = 'suite';
/** Leg id for a red with no attributable leg (the suite failed but named no file, no leg failed). */
export const R1_UNATTRIBUTED_LEG = 'unattributed';

/**
 * The red legs of a measured round. `green === null` means the round produced no verdict, so
 * there is nothing to record: the caller must not stamp R1 for an unmeasured round.
 */
export function redLegsOfRound(input: {
  green: boolean | null;
  /** The suite's workspace-mapped failing files (the gate's `FailingFile` records). Only the
   *  count is read: any named file makes the suite leg red. */
  failingFiles: readonly unknown[];
  postSuiteLegs?: readonly R1LegOutcome[];
}): string[] | null {
  if (input.green === null) return null;
  const legs: string[] = [];
  if (input.failingFiles.length > 0) legs.push(R1_SUITE_LEG);
  for (const leg of input.postSuiteLegs ?? []) {
    if (leg.status === 'failed' && !legs.includes(leg.id)) legs.push(leg.id);
  }
  if (input.green === false && legs.length === 0) legs.push(R1_UNATTRIBUTED_LEG);
  return input.green === true ? [] : legs;
}

/** The R1 record for a fresh-cut round, or null when the round produced no verdict. */
export function buildRedLegsAtR1(
  cut: FreezeCutRecord,
  round: Parameters<typeof redLegsOfRound>[0],
): RedLegsAtR1 | null {
  const legs = redLegsOfRound(round);
  if (legs === null) return null;
  return { candidate: cut.candidate, source: cut.source, legs };
}

/** One log line, greppable as `GATE_FREEZE_CUT`. */
export function formatFreezeCutLine(cut: FreezeCutRecord): string {
  return (
    `GATE_FREEZE_CUT source=${cut.source} reason=${cut.reason} candidate=${cut.candidate.slice(0, 12)} ` +
    `tip=${cut.tip.slice(0, 12)} knownGood=${cut.knownGood ? cut.knownGood.slice(0, 12) : 'none'}`
  );
}
