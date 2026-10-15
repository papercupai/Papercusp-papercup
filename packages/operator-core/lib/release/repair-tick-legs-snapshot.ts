/**
 * The read-side snapshot of a repair-tick's cheap non-test GATE LEG measurement
 * (`gate_health.repairTickLegs`, written by green-checkpoint.ts's
 * `augmentWithRepairTickLegs` — see `apps/operator/lib/release/green-checkpoint.ts`'s
 * `RepairTickLegs` / `RepairTickLegRecord`).
 *
 * WI-2143253: `gate.greenCheckpoint.candidateFailures` collapsed EVERY non-test leg
 * (lint / perf / desktop / delta) into ONE tri-state boolean (`postSuiteMeasured`) — it
 * could not name WHICH leg was failing, and observably went `false`/`none-failing` while
 * two lint legs (`lint:design-primitives`, `lint:plane-integrity`) were red on the very
 * candidate blocking `main`. The per-leg measurement already exists — an `awaiting-fixer`
 * hold tick takes it and persists it, precisely so non-test legs stay MEASURED (not
 * `failingTestsMeasured:false`) during repair — it was simply never read back into any
 * state cell. This module is the missing read/parse half.
 *
 * Mirrors `./in-flight-candidate.ts`'s pattern on purpose: a `packages/operator-core`-owned
 * parser for a JSONB blob the apps-layer `green-checkpoint.ts` writes, so this library layer
 * never imports the apps-layer type (apps depends on packages, never the reverse).
 *
 * ── WHAT THIS DELIBERATELY IS NOT ────────────────────────────────────────────────
 * The LATEST repair-tick measurement only — a point-in-time marker, like
 * `inFlightCandidate`, not a per-round shrink series. Giving non-test legs the same
 * shrink-over-time tracking test files get via `frozen-candidate-repair-queue.ts`'s
 * `convergenceRounds` would need a persisted, capped round history keyed by signature — a
 * write-path change to the LIVE frozen repair queue, which is out of scope for this pass
 * (a real repair was in flight, owned by another agent, when this was filed). Read-side
 * visibility into the CURRENT set of failing legs is the gap actually blocking triage
 * ("is the gate red about a lint leg, and which one") and is what this closes; the
 * shrink-history half is named as deferred scope on the work-item this module fixes, not
 * silently dropped.
 */

export interface RepairTickLegSnapshot {
  /** The NON_TEST_GATE_SCRIPTS registry id (e.g. `lint:design-primitives`) — a correlation
   *  key that is NEVER a repo path (a fixer edits scripts/config under it, not a file named
   *  after the leg), unlike `distinctFailingFiles[].path` on the sibling test-file cell. */
  id: string;
  status: 'pass' | 'fail' | 'errored';
  /** Null when the writer omitted it (legacy row) or it did not parse as a number. */
  durationMs: number | null;
}

/** The persisted shape of one repair-tick's cheap-legs measurement. */
export interface StoredRepairTickLegs {
  /**
   * The repairHead these legs were actually measured AT, SHORT (the writer persists
   * `head.slice(0, 12)` — release-actions.ts — never the full sha). May differ from the
   * live repairHead: fixes land ON TOP of the frozen candidate and the legs re-run at the
   * advancing head, same as the file-based failures on the sibling cell. Compare with
   * `repairHeadSha.startsWith(head)`, never `===`.
   */
  head: string;
  atMs: number;
  /** True when every measured leg passed. */
  ok: boolean;
  /** Registry ids of every leg that did not pass at `head` — complete, not a first-failure
   *  floor (bounded to 20 by the writer). */
  failingSignatures: string[];
  /** Bounded to 32 by the writer. */
  legs: RepairTickLegSnapshot[];
}

/**
 * PURE: interpret the raw `gate_health.repairTickLegs` value. Returns null for anything
 * unreadable — missing or malformed.
 *
 * Deliberately NO age bound (unlike `parseInFlightCandidate`'s 3h liveness window): this is
 * a durable RESULT of a completed measurement, not a liveness marker for a run that might
 * have died. An old measurement is still the most recent one taken and stays meaningful
 * until superseded — the caller judges currency by comparing `head` against the LIVE
 * repairHead, not by age.
 */
export function parseRepairTickLegs(raw: unknown): StoredRepairTickLegs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const head = typeof r.head === 'string' && r.head ? r.head : null;
  const atMs = typeof r.atMs === 'number' ? r.atMs : null;
  if (!head || atMs == null) return null;

  const rawLegs = Array.isArray(r.legs) ? r.legs : [];
  const legs: RepairTickLegSnapshot[] = [];
  for (const entry of rawLegs) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) continue;
    if (e.status !== 'pass' && e.status !== 'fail' && e.status !== 'errored') continue;
    legs.push({
      id: e.id,
      status: e.status,
      durationMs: typeof e.durationMs === 'number' ? e.durationMs : null,
    });
  }

  const failingSignatures = Array.isArray(r.failingSignatures)
    ? r.failingSignatures.filter((v): v is string => typeof v === 'string')
    : [];

  return {
    head,
    atMs,
    ok: r.ok === true,
    failingSignatures,
    legs,
  };
}

/**
 * Is this measurement CURRENT for the live repairHead, or from an earlier head the queue
 * has since moved past? `null` when currency cannot be judged (no live repairHead to
 * compare against) — distinct from `false`, which is a measured mismatch.
 */
export function repairTickLegsCurrent(
  snapshot: Pick<StoredRepairTickLegs, 'head'>,
  liveRepairHeadSha: string | null,
): boolean | null {
  if (!liveRepairHeadSha) return null;
  return liveRepairHeadSha.startsWith(snapshot.head);
}

/**
 * PURE: did the latest repair tick RE-RUN every signature the frozen queue is red on, at the
 * queue's CURRENT repairHead, and see each one pass?
 *
 * That is a red the gate itself could not reproduce at the same head. It deadlocks exactly
 * like an unmeasured red (WI-10003213): the hold tick persists a candidate snapshot with an
 * empty failing set, so `candidateSnapshotMatchesDispatch` never matches the queue's own
 * signature and the fixer dispatch is skipped every tick, while nothing else runs a suite.
 * Measured 2026-09-29 on queue 5ec99902 / head aa948759: the verify reported
 * `@papercusp/operator-core :: test:lane-stateful` FAIL with no failing test file recorded,
 * and the repair tick at the same head passed that leg (1159s).
 *
 * Every queue signature must appear among the tick's PASSING legs — a signature the tick did
 * not re-run is not evidence of anything, so a queue red on a test FILE (never a tick leg)
 * stays on the fixer path.
 */
export function repairTickClearedQueueSignature(
  snapshot: StoredRepairTickLegs | null,
  queue: { repairHead: string; failingTests?: readonly string[] | null },
): boolean {
  if (!snapshot || !snapshot.ok) return false;
  const { contradicted, actionable } = partitionSameHeadContradictions(queue.failingTests, snapshot, queue.repairHead);
  return actionable.length === 0 && contradicted.length > 0;
}

/** The result of {@link partitionSameHeadContradictions}. Both lists keep input order. */
export interface SameHeadContradictionPartition {
  /** Queue entries the latest repair tick re-ran AT the queue's current repairHead and saw
   *  pass. A fixer handed one of these is asked to fix something its own head passes. */
  contradicted: string[];
  /** Every other entry: still a red nothing at this head has contradicted. */
  actionable: string[];
}

/**
 * PURE (WI-10007494): split a frozen queue's failing signature into the entries the latest
 * repair tick CONTRADICTED at the same head and the entries that remain actionable.
 *
 * An entry is contradicted only when all of these hold:
 *   - the tick was measured at the queue's current repairHead (a tick from an earlier head
 *     is evidence about different code, so it contradicts nothing);
 *   - the tick recorded a leg with exactly that id, and every such leg passed;
 *   - the tick's own `failingSignatures` does not name it.
 * A test FILE entry is never a tick leg id, so it always stays actionable.
 *
 * This only narrows what a fixer is TOLD to fix. The queue signature keeps every entry
 * (`retireRepairSignatureOnLegPass` deliberately leaves same-head contradictions in it), so
 * the verification after the fixer's admission still re-measures the contradicted legs.
 */
export function partitionSameHeadContradictions(
  failingTests: readonly string[] | null | undefined,
  snapshot: StoredRepairTickLegs | null,
  repairHead: string | null,
): SameHeadContradictionPartition {
  const failing = failingTests ?? [];
  if (!snapshot || repairTickLegsCurrent(snapshot, repairHead) !== true) {
    return { contradicted: [], actionable: [...failing] };
  }
  const passed = new Set<string>();
  const notPassed = new Set<string>(snapshot.failingSignatures);
  for (const leg of snapshot.legs) {
    if (leg.status === 'pass') passed.add(leg.id);
    else notPassed.add(leg.id);
  }
  const contradicted: string[] = [];
  const actionable: string[] = [];
  for (const id of failing) {
    if (passed.has(id) && !notPassed.has(id)) contradicted.push(id);
    else actionable.push(id);
  }
  return { contradicted, actionable };
}

/**
 * PURE (WI-10007494): what a frozen-repair fixer should be told to fix.
 *
 * Narrows ONLY the mixed case: some entries contradicted at the same head AND at least one
 * real red left. Then the fixer gets the real reds, and the contradicted entries come back
 * separately so the brief can name them as do-not-fix.
 *
 * Every other case returns the input unchanged. An all-contradicted signature belongs to the
 * retest path (`repairTickClearedQueueSignature` → `frozenRepairRedIsUnmeasured`), not to a
 * fixer with an empty target list. No contradiction means there is nothing to narrow.
 */
export function releaseFixerTargetsAfterSameHeadContradictions(
  failingTests: readonly string[] | null | undefined,
  snapshot: StoredRepairTickLegs | null,
  repairHead: string | null,
): { targets: string[]; sameHeadContradicted: string[] } {
  const { contradicted, actionable } = partitionSameHeadContradictions(failingTests, snapshot, repairHead);
  if (contradicted.length > 0 && actionable.length > 0) {
    return { targets: actionable, sameHeadContradicted: contradicted };
  }
  return { targets: [...(failingTests ?? [])], sameHeadContradicted: [] };
}

/** What `release:repair-queue { op:'get' }` reports about same-head contradictions. */
export interface SameHeadContradictionAnnotation {
  status: 'contradicted';
  /** Signature entries the latest repair tick re-ran at this exact repairHead and saw pass. */
  entries: string[];
  /** True when no signature entry is left that the tick did not contradict. */
  allContradicted: boolean;
  /** The short head the tick measured at (a prefix of the live repairHead). */
  measuredAtHead: string;
  measuredAtMs: number;
  note: string;
}

/**
 * PURE (WI-10007509): the read-side twin of the fixer narrowing. A fixer reads its targets
 * from `release:repair-queue get`, which lists the full signature, so that read has to mark
 * the entries the latest repair tick contradicted at the same head. Otherwise a reader of
 * the queue sees the contradicted leg as a red to fix while the kickoff says not to.
 *
 * Unlike {@link releaseFixerTargetsAfterSameHeadContradictions} this also reports the
 * all-contradicted case: a reader should learn that the queue needs a re-verification, not
 * an edit. Returns null when nothing at the live head was contradicted.
 */
export function sameHeadContradictionAnnotation(
  failingTests: readonly string[] | null | undefined,
  snapshot: StoredRepairTickLegs | null,
  repairHead: string | null,
): SameHeadContradictionAnnotation | null {
  const { contradicted, actionable } = partitionSameHeadContradictions(failingTests, snapshot, repairHead);
  if (!snapshot || contradicted.length === 0) return null;
  const allContradicted = actionable.length === 0;
  return {
    status: 'contradicted',
    entries: contradicted,
    allContradicted,
    measuredAtHead: snapshot.head,
    measuredAtMs: snapshot.atMs,
    note:
      'The latest repair tick re-ran these entries at this repairHead and they passed. ' +
      'They stay in the signature and the next verification re-measures them; do not edit code to fix them' +
      (allContradicted
        ? '. No other entry is left, so this queue needs a re-verification, not a fix.'
        : '; fix the remaining entries.'),
  };
}
