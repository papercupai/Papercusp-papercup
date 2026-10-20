// WI-6554700010018130 — recurrence guard for the quadratic superseder anti-join.
//
// Every correlated "is this card superseded?" probe in scorecards.ts joins a
// `superseder` row back to the outer `scorecard` row on rubricRef. Written as a
// bare `superseder.rubricRef = scorecard.rubricRef`, that equality joins the
// planner's equivalence class with the outer `scorecard.rubricRef = <const>`
// filter, so Postgres derives `superseder.rubricRef = <const>` and BitmapAnds the
// ENTIRE rubricRef index into every per-row probe. Measured on live PG for
// rubricRef='grading-integrity' (7.5k cards): 7,500 loops x 7,743-entry bitmap,
// 6,018 ms for the anti-join alone, which surfaced as pg 57014 statement_timeout
// on scorecards:list / scorecards:emit (EI-26502753767803422).
//
// `(a = b) IS TRUE` has identical WHERE semantics (NULL -> not matched) but is not
// an equivalence-class or indexable qual, so the probe stays on the selective
// supersedes index (6,018 ms -> 474 ms). A plan-shape assertion against a test DB
// would depend on table statistics, so this guard pins the SQL shape instead.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// SCORECARDS_SOURCE_OVERRIDE lets scripts/mutation-probe.sh (copy-out mode) point
// this guard at a mutated COPY, so proving it falsifiable never dirties the tree.
const SOURCE_PATH =
  process.env.SCORECARDS_SOURCE_OVERRIDE || fileURLToPath(new URL('./scorecards.ts', import.meta.url));

/** Every SQL line that correlates a superseder's rubricRef to the outer scorecard's. */
function correlatedRubricRefLines(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  source.split('\n').forEach((text, idx) => {
    if (/superseder\.payload\s*->\s*'observation'\s*->>\s*'rubricRef'\s*=\s*scorecard\./.test(text)) {
      out.push({ line: idx + 1, text: text.trim() });
    }
  });
  return out;
}

describe('scorecards superseder probe SQL shape (WI-6554700010018130)', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const sites = correlatedRubricRefLines(source);

  it('finds the correlated superseder probes it is meant to guard (positive control)', () => {
    // listScorecardsAtLimit (anti-join + superseded_by), countScorecardsByRubric
    // anti-join, and the single-card superseded_by read. If this drops to zero the
    // regex no longer matches the source and the guard below would pass vacuously.
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it('wraps every correlated rubricRef equality in IS TRUE so the planner cannot derive a constant', () => {
    const bare = sites.filter(
      (s) => !/\(\s*superseder\.payload\s*->\s*'observation'\s*->>\s*'rubricRef'\s*=\s*scorecard\.payload\s*->\s*'observation'\s*->>\s*'rubricRef'\s*\)\s*IS TRUE/.test(s.text),
    );
    expect(bare, `bare correlated rubricRef equality at scorecards.ts:${bare.map((b) => b.line).join(',')}`).toEqual([]);
  });
});
