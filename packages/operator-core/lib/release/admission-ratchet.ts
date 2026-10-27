/**
 * PURE — the ADMISSION RATCHET (green-main-ratchet-convergence-2026-10-17 P-006, R-5; D-007 R4).
 *
 * A frozen repair lineage converges only if no admission adds a failure. This module is the
 * single decision for that rule: given the verdicts at the PREVIOUS repair head and the
 * verdicts at the built (unpublished) admission commit, both measured over the admission's
 * radius, it rejects any admission that makes a test fail which did not fail at the previous
 * head. "Did not fail" covers both shapes the owner named:
 *
 *   - a test that PASSED at the previous head and fails after the admission (the S3 shape: a
 *     fix for one red turns a green test red), and
 *   - a test that was ABSENT at the previous head and fails after the admission (the admission
 *     adds a new test that fails).
 *
 * A test that was already failing at the previous head and still fails is not new: the ratchet
 * never blames an admission for a red the lineage already carried. A measurement that cannot be
 * read (an unmeasured post-admission verdict, or an unmeasured previous verdict for a test that
 * now fails) is INCONCLUSIVE — it never counts as passing, and it never publishes. A rejection
 * names every attributed test and routes the refusal to the admitting actor.
 *
 * The ratchet does not decide whether an admission FIXES anything; the pre-check's separate
 * `admission-does-not-fix` precondition owns that. An admission that adds no failure is never
 * rejected BY THE RATCHET.
 */

export type RatchetVerdict = 'pass' | 'fail' | 'unmeasured';

/** Test id → verdict at one head. A test with no entry was ABSENT at that head. */
export type RatchetVerdictSet = Readonly<Record<string, RatchetVerdict>>;

export interface AdmissionRatchetInput {
  /** The admission being judged: who admitted it (the refusal is routed here) and what it changed. */
  admission: { actor: string | null; paths?: readonly string[]; commit?: string };
  /** Every test the admission's radius selects. Tests outside it are carried, never judged here. */
  radius: readonly string[];
  /** Verdicts at the previous repair head. */
  previousHead: RatchetVerdictSet;
  /** Verdicts at the built admission commit. */
  postAdmission: RatchetVerdictSet;
}

export interface RatchetNewFailure {
  test: string;
  /** What the test was at the previous head: `pass` (turned red) or `absent` (new failing test). */
  before: 'pass' | 'absent';
}

export type AdmissionRatchetDecision =
  | {
      verdict: 'accept';
      /** Radius tests failing before and after — carried, not attributed. */
      carriedFailures: string[];
      /** Radius tests failing before and passing after. */
      fixed: string[];
    }
  | {
      verdict: 'reject';
      code: 'admission-adds-failure';
      newFailures: RatchetNewFailure[];
      /** The refusal goes to whoever admitted; null actor is reported, never silently dropped. */
      routeTo: { actor: string | null; unattributed: boolean };
      /** Radius tests the ratchet also could not read; the rejection stands regardless. */
      inconclusive: string[];
      message: string;
    }
  | {
      verdict: 'inconclusive';
      /** Radius tests whose verdict could not establish the rule either way. */
      inconclusive: string[];
      message: string;
    };

function norm(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeSet(set: RatchetVerdictSet): Map<string, RatchetVerdict> {
  const out = new Map<string, RatchetVerdict>();
  for (const [k, v] of Object.entries(set)) {
    const key = norm(k);
    if (!key) continue;
    // A test seen twice keeps its WORST reading: fail beats unmeasured beats pass.
    const prev = out.get(key);
    if (prev === 'fail' || (prev === 'unmeasured' && v === 'pass')) continue;
    out.set(key, v);
  }
  return out;
}

/**
 * The ratchet. Reject wins over inconclusive: a proven new failure is a rejection even when
 * other radius tests went unmeasured, because publishing would add that failure regardless.
 */
export function evaluateAdmissionRatchet(input: AdmissionRatchetInput): AdmissionRatchetDecision {
  const before = normalizeSet(input.previousHead);
  const after = normalizeSet(input.postAdmission);
  const radius = [...new Set(input.radius.map(norm).filter(Boolean))];

  const newFailures: RatchetNewFailure[] = [];
  const inconclusive: string[] = [];
  const carriedFailures: string[] = [];
  const fixed: string[] = [];

  for (const test of radius) {
    const post = after.get(test);
    const pre = before.get(test);
    if (post === undefined || post === 'unmeasured') {
      inconclusive.push(test);
      continue;
    }
    if (post === 'fail') {
      if (pre === 'fail') carriedFailures.push(test);
      else if (pre === 'unmeasured') inconclusive.push(test);
      else newFailures.push({ test, before: pre === 'pass' ? 'pass' : 'absent' });
      continue;
    }
    if (pre === 'fail') fixed.push(test);
  }

  if (newFailures.length > 0) {
    const actor = input.admission.actor;
    const list = newFailures
      .map((f) => `${f.test} (${f.before === 'pass' ? 'passed at the previous head' : 'new test'})`)
      .join(', ');
    return {
      verdict: 'reject',
      code: 'admission-adds-failure',
      newFailures,
      routeTo: { actor, unattributed: !actor },
      inconclusive,
      message:
        `admission ratchet: ${newFailures.length} test(s) fail after this admission that did not fail at the ` +
        `previous repair head: ${list}. The repair head does not advance; fix these at the built commit and ` +
        `re-admit${actor ? ` (routed to ${actor})` : ' (the admitting actor is unknown)'}.`,
    };
  }
  if (inconclusive.length > 0) {
    return {
      verdict: 'inconclusive',
      inconclusive,
      message:
        `admission ratchet: ${inconclusive.length} radius test(s) could not be read (${inconclusive.join(', ')}); ` +
        'an unmeasured verdict never counts as passing, so nothing publishes until they are measured.',
    };
  }
  return { verdict: 'accept', carriedFailures, fixed };
}

/**
 * The previous-head verdict set the ratchet compares against
 * (measured-wide-repair-admission-2026-10-24#D-004 ruling 1: the evaluator must not imply green).
 *
 *  - Signature test files were red at the previous head by definition (they ARE the frozen red).
 *  - A guarded radius file carries ONLY its MEASURED previous-head verdict: the paired baseline,
 *    run by the same per-file runner and env at the previous head. Without one it is
 *    `unmeasured` — never `pass`. The gate never judged most of a wide guarded population, so
 *    assuming green there blamed the admission for reds the lineage already carried.
 *  - An admitted test file outside the signature and radius has no entry: ABSENT (a failure
 *    there is a new failing test).
 *
 * A measured entry for a path outside `guardedRadius` is ignored: the baseline answers only for
 * the guarded population, and signature membership always wins.
 */
export function previousHeadVerdicts(input: {
  signatureTestFiles: readonly string[];
  guardedRadius: readonly string[];
  measured?: Readonly<Record<string, RatchetVerdict>>;
}): Record<string, RatchetVerdict> {
  const measured = normalizeSet(input.measured ?? {});
  const out: Record<string, RatchetVerdict> = {};
  for (const p of input.guardedRadius) {
    const key = norm(p);
    if (key) out[key] = measured.get(key) ?? 'unmeasured';
  }
  for (const p of input.signatureTestFiles) {
    const key = norm(p);
    if (key) out[key] = 'fail';
  }
  return out;
}

/**
 * The door's publication rule under the ratchet: only a MEASURED, non-refusing pre-check (or one
 * with nothing to run) may publish. A deferred pre-check (the checkpoint tree was busy) is not a
 * measurement, so it is retried when the tree frees instead of publishing unmeasured. The single
 * deliberate exception is the reasoned, ledgered `skipPrecheck` override, which the door handles
 * before it ever reaches this rule.
 */
export function ratchetAllowsPublication(precheck: { ok: boolean; ran: boolean; reason?: string }): boolean {
  if (!precheck.ok) return false;
  if (precheck.ran) return true;
  return precheck.reason === 'nothing-to-run';
}
