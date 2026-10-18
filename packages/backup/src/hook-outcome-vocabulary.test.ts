/**
 * Pins the terminal-outcome vocabulary the pre-snapshot hook can emit.
 *
 * WHY THIS EXISTS (WI-1547678). The freshness probe in
 * `apps/operator/scripts/papercup-backup-health-check.sh` decides whether a stale
 * workspace dump is a real failure by reading the LATEST `hook done (...)` line in
 * the companion hook.log. It used to select that line with a hand-typed alternation,
 * `hook done \((ok|degraded)\)`, which could not see this module's third outcome —
 * `hook done (skipped: host-covered)`, added with the host-coverage stand-down
 * (EI-21874492117996483). Under that stand-down the workspace dump is deliberately
 * frozen forever, so the enumeration kept returning a `degraded` line from BEFORE
 * the stand-down and the probe filed a CRITICAL data-safety alarm about an artifact
 * that was superseded on purpose. It re-filed the byte-identical 2580223915B dump
 * that an earlier item had already closed 13h before, and seven agents each burned a
 * claim on it while the host dump was demonstrably fresh the whole time.
 *
 * The probe now matches the outcome SHAPE (`hook done (`) instead of enumerating
 * members, so it can never again mistake an older line for the latest one. That fix
 * makes an UNRECOGNISED future outcome read as benign, which is the safe direction
 * for the false alarm but the unsafe one for a genuinely new FAILURE outcome. This
 * test closes that gap: it DERIVES the outcome vocabulary from the emitter and fails
 * the build when it drifts, forcing whoever adds an outcome to classify it.
 *
 * This is the derived-truth ladder rung 2 (derive the population, pin it) applied to
 * the exact defect class the enumeration belonged to — a hand-maintained list that
 * silently omits a real member.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Overridable so falsifiability can be proven against a MUTATED COPY outside the
 * tree (scripts/mutation-probe.sh tier 2) instead of mutating the shared checkout,
 * where the git-sync sweep can commit the mutant mid-probe. Defaults to the real
 * emitter, so ordinary runs are unaffected.
 */
const HOOK_SOURCE = process.env.BACKUP_HOOK_SOURCE_PATH
  ? resolve(process.env.BACKUP_HOOK_SOURCE_PATH)
  : resolve(__dirname, 'hook.ts');

/**
 * Every outcome this module can emit, and whether the freshness probe must treat it
 * as a live failure.
 *
 * ADDING AN OUTCOME? This test will fail until you add it here, and that failure is
 * the point — it is asking you a question, not asking to be silenced. Answer it in
 * BOTH places:
 *   1. `optional_artifact_latest_hook_degraded()` in
 *      apps/operator/scripts/papercup-backup-health-check.sh — it alarms only on
 *      `degraded`; any other outcome is benign there.
 *   2. a `check_optional` case in that script's `--self-test`, so the classification
 *      is proven behaviourally and not merely asserted here.
 */
const OUTCOME_CLASSIFICATION: Readonly<Record<string, 'alarming' | 'benign'>> = {
  degraded: 'alarming',
  ok: 'benign',
  'skipped: host-covered': 'benign',
  // A verified live host writer defers this hook; it has not failed a dump.
  'degraded: host-backup-in-progress': 'benign',
};

/**
 * Extract the outcome tokens from the emitter's source.
 *
 * Handles both shapes present today: a plain literal (`'hook done (degraded)'`) and
 * a template whose expression enumerates its branches
 * (`` `hook done (${result.ok ? 'ok' : 'degraded'})` ``).
 */
function deriveEmittedOutcomes(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/hook done \(([^)]*)\)/g)) {
    const body = match[1];
    if (body.includes('${')) {
      // A template expression: every quoted literal inside it is a reachable branch.
      for (const literal of body.matchAll(/'([^']*)'/g)) found.add(literal[1]);
    } else {
      found.add(body);
    }
  }
  if (found.size === 0) {
    // A census that can pass by measuring nothing is worse than no census: it reads
    // exactly like a clean result. The emitter cannot have stopped emitting outcomes,
    // so an empty population means the extractor broke — repair the extractor here,
    // never the assertion below.
    throw new Error(
      `Derived ZERO 'hook done (...)' outcomes from ${HOOK_SOURCE}. The extractor is ` +
        'broken (or the emitter moved); a vacuous pass would silently un-guard the ' +
        'vocabulary this test exists to pin.',
    );
  }
  return [...found].sort();
}

describe('pre-snapshot hook outcome vocabulary', () => {
  const emitted = deriveEmittedOutcomes(readFileSync(HOOK_SOURCE, 'utf8'));

  it('derives a non-empty population from the emitter (the anti-vacuous control)', () => {
    // Guards the guard: if this ever reads 0, every assertion below passes for free.
    expect(emitted.length).toBeGreaterThanOrEqual(3);
    expect(emitted).toContain('degraded');
  });

  it('every emitted outcome is classified for the freshness probe', () => {
    const unclassified = emitted.filter((o) => !(o in OUTCOME_CLASSIFICATION));
    expect(
      unclassified,
      `The pre-snapshot hook emits ${JSON.stringify(unclassified)}, which the backup ` +
        'freshness probe has never been told how to treat. An unclassified outcome is ' +
        'read as benign, so a new FAILURE outcome would go undetected exactly like ' +
        "WI-1547678's stand-down went misdetected. Classify it in OUTCOME_CLASSIFICATION " +
        'and add a check_optional case in papercup-backup-health-check.sh --self-test.',
    ).toEqual([]);
  });

  it('every classified outcome is still emitted (no stale entries)', () => {
    // The other drift direction: a classification kept for an outcome nobody emits
    // makes the pin look more complete than it is.
    const orphaned = Object.keys(OUTCOME_CLASSIFICATION).filter((o) => !emitted.includes(o));
    expect(orphaned).toEqual([]);
  });

  it('exactly one outcome is alarming — the probe alarms only on degraded', () => {
    const alarming = Object.entries(OUTCOME_CLASSIFICATION)
      .filter(([, kind]) => kind === 'alarming')
      .map(([outcome]) => outcome);
    expect(alarming).toEqual(['degraded']);
  });

  it('the stand-down outcome is benign — a frozen dump is superseded, not stale', () => {
    // The specific live regression: this outcome means the host backup already covers
    // this database, so the workspace artifact can never advance again and its age
    // carries no information about data safety.
    expect(OUTCOME_CLASSIFICATION['skipped: host-covered']).toBe('benign');
  });

  it('an active host backup defers the workspace dump without reporting a failed attempt', () => {
    expect(OUTCOME_CLASSIFICATION['degraded: host-backup-in-progress']).toBe('benign');
  });
});
