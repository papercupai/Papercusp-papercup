/**
 * WI-41691 — agent-review.ts's header must not promise of the TOOL what is only true
 * of the FUNCTION.
 *
 * THE CLAIM THIS PINS. `reconcileAgentReviewGrade` is genuinely convergent: it re-reads
 * the standing ledger grade, recomputes the target status, and dedupes its own side
 * effects. The header comment generalised that into "every write is retryable", which is
 * false through the supported surface: `blender:grade-idea` refuses with
 * `agent-review-not-pending` BEFORE the ledger write and before reconcile as soon as the
 * payload has left 'pending' — which is precisely the state a partial write leaves it in.
 * Verified live 2026-08-25T20:37Z on EI-21432462460558068: an identical regrade returned
 * `applied:false` rather than converging.
 *
 * WHY A GUARD RATHER THAN A CAREFUL EDIT. This is a load-bearing comment on a recovery
 * path, read exactly when something has already gone wrong. A reader who follows it
 * retries, gets a refusal that looks like a different fault, and concludes the row is
 * corrupt — it cost that detour once already, during WI-41687's diagnosis. It is also
 * the hand-maintained-metadata class CLAUDE.md's derived-truth ladder names: prose
 * describing code behaviour, with nothing failing when the code moves underneath it.
 *
 * FAILS ON DRIFT IN BOTH DIRECTIONS. If the pending guard is relaxed to admit a
 * converging regrade — fix (i) on WI-41691, still open as a product question on
 * WI-41689 — the guard assertion below fails and forces the header to be re-stated in
 * the same change, instead of leaving a now-understated comment to rot the other way.
 *
 * ABSENCE ASSERTIONS ARE PAIRED WITH POSITIVE CONTROLS over the same bytes: a moved
 * file, a renamed anchor or an empty read is otherwise indistinguishable from a genuine
 * absence, and would report this guard as passing while measuring nothing.
 *
 * SCOPE. Both subjects are SOURCE files, not projected doc parts, so this pin is not
 * exposed to the budget-eviction failure of pins that assert against CLAUDE.md text
 * (EI-21439532113892507).
 *
 * FALSIFIABILITY. Subject paths are overridable, so the pre-fix source replays from git
 * history without mutating the shared tree:
 *   scripts/mutation-probe.sh \
 *     --file packages/operator-core/lib/harness/improvements/agent-review.ts \
 *     --against-last-without 'WHAT IS AND IS NOT RETRYABLE' \
 *     --positive-control 'reconcileAgentReviewGrade' \
 *     --calibration "grep -q 'reconcileAgentReviewGrade' {}" \
 *     --test 'DOC_CLAIM_AGENT_REVIEW_PATH={} npm run test:file -- packages/operator-core/lib/doc-claims/agent-review-retry-convergence.test.ts'
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const AGENT_REVIEW = process.env.DOC_CLAIM_AGENT_REVIEW_PATH
  ? resolve(process.env.DOC_CLAIM_AGENT_REVIEW_PATH)
  : join(ROOT, 'packages/operator-core/lib/harness/improvements/agent-review.ts');

const GRADE_IDEA = process.env.DOC_CLAIM_GRADE_IDEA_PATH
  ? resolve(process.env.DOC_CLAIM_GRADE_IDEA_PATH)
  : join(ROOT, 'packages/operator-core/lib/agent-tools/scout/grade-idea.ts');

/** Shortest body that could plausibly contain either subject. */
const MIN_JUDGEABLE_CHARS = 400;

function readSubject(path: string, label: string): string {
  const source = readFileSync(path, 'utf8');
  if (source.length < MIN_JUDGEABLE_CHARS) {
    throw new Error(
      `Refusing to judge a ${source.length}-char ${label}: too short to contain the claim. ` +
        'A failed or moved read must not read as a clean verdict.',
    );
  }
  return source;
}

/**
 * The leading file-level block comment, sliced off before the first import. Scanning the
 * whole file would sweep up the in-function comments, which legitimately narrate the old
 * behaviour as history (see reconcileAgentReviewGrade's WI-41687 note).
 */
function agentReviewHeader(): string {
  const source = readSubject(AGENT_REVIEW, 'agent-review.ts');
  const end = source.indexOf('\nimport ');
  expect(end, 'anchor `import` not found in agent-review.ts — instrument is broken').toBeGreaterThan(0);
  const header = source.slice(0, end);
  // Positive control over the same bytes: this is the header, and it is the right file.
  expect(header, 'sliced region is not the agent-review header — instrument is broken').toMatch(
    /Agent-review lifecycle/,
  );
  return header;
}

describe('agent-review.ts header states the retry guarantee the tool actually offers', () => {
  /**
   * Any unqualified promise that a retry converges. Matched on the operative pair
   * (universal quantifier + retryable/converging write) rather than exact wording, so a
   * reflow cannot smuggle it back.
   */
  const UNQUALIFIED_RETRY =
    /\b(every|all|any)\s+(write|grade|transition)s?\s+(is|are)\s+retryable|\bretr(y|ies)\s+(always|will)\s+converge/i;

  it('does not claim universal retryability', () => {
    const header = agentReviewHeader();
    const offending = header
      .split('\n')
      .map((line, i) => ({ line: line.trim(), lineNo: i + 1 }))
      .filter((entry) => UNQUALIFIED_RETRY.test(entry.line));

    expect(
      offending,
      'agent-review.ts\'s header promises retry convergence without qualification. It is ' +
        'unreachable through blender:grade-idea, which refuses a non-pending payload with ' +
        '`agent-review-not-pending` before reconcile ever runs (WI-41691). State the ' +
        'boundary, or relax the guard and re-state this comment.',
    ).toEqual([]);
  });

  it('names the refusal that bounds the guarantee', () => {
    const header = agentReviewHeader();
    expect(
      header,
      'the header must name `agent-review-not-pending` — the refusal a reader hits when ' +
        'they follow this comment into a retry. Without it the boundary is not findable ' +
        'from the recovery path where it matters (WI-41691).',
    ).toMatch(/agent-review-not-pending/);
    expect(
      header,
      'the header must point at `reconcileAgentReviewGrade` as the one surface that IS ' +
        'convergent, or the correction removes the false promise without leaving the true one.',
    ).toMatch(/reconcileAgentReviewGrade/);
  });
});

describe('the pending guard the header describes is still where the header says it is', () => {
  it('refuses a non-pending regrade before both the ledger write and reconcile', () => {
    const source = readSubject(GRADE_IDEA, 'grade-idea.ts');

    const preflight = source.indexOf('preflightAgentReviewGrade({');
    const refusalReturn = source.indexOf('if (agentReviewPreflight.refusal) {');
    // Argument style can use a named input object; pin the callee ordering instead.
    const ledgerWrite = source.indexOf('deps.gradeRoutedIdea(');
    const reconcile = source.indexOf('deps.reconcileAgentReviewGrade(');

    // Positive controls: every anchor must exist, or an absent one would silently
    // satisfy the ordering assertions below at -1.
    expect(preflight, 'anchor `preflightAgentReviewGrade({` missing — instrument is broken').toBeGreaterThan(-1);
    expect(refusalReturn, 'anchor `if (agentReviewPreflight.refusal) {` missing — instrument is broken').toBeGreaterThan(-1);
    expect(ledgerWrite, 'anchor `deps.gradeRoutedIdea(` missing — instrument is broken').toBeGreaterThan(-1);
    expect(reconcile, 'anchor `deps.reconcileAgentReviewGrade(` missing — instrument is broken').toBeGreaterThan(-1);

    expect(
      refusalReturn,
      'the preflight refusal no longer short-circuits before the ledger write. If the ' +
        'guard was deliberately relaxed to admit a converging regrade (fix (i) on ' +
        'WI-41691 / the product fork on WI-41689), agent-review.ts\'s header is now ' +
        'UNDERSTATED and must be re-stated in this same change.',
    ).toBeLessThan(ledgerWrite);

    expect(
      refusalReturn,
      'the preflight refusal no longer short-circuits before reconcileAgentReviewGrade. ' +
        'agent-review.ts\'s header describes that ordering; correct it in this same change.',
    ).toBeLessThan(reconcile);
  });

  it('still refuses on the non-pending status, not merely on missing feedback', () => {
    const source = readSubject(AGENT_REVIEW, 'agent-review.ts');
    const preflight = source.indexOf('export async function preflightAgentReviewGrade');
    expect(preflight, 'anchor `preflightAgentReviewGrade` declaration missing — instrument is broken').toBeGreaterThan(-1);

    const body = source.slice(preflight, preflight + 1200);
    expect(
      body,
      'preflightAgentReviewGrade no longer refuses a non-pending payload. That refusal is ' +
        'what makes the header\'s boundary true — re-state the header in this same change.',
    ).toMatch(/status\s*!==\s*'pending'[\s\S]{0,200}agent-review-not-pending/);
  });
});
