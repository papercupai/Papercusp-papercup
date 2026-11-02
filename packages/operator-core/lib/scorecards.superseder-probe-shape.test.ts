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
    const match = text.match(/\b([A-Za-z_]\w*)\.payload\s*->\s*'observation'\s*->>\s*'rubricRef'\s*=\s*scorecard\./);
    if (match) {
      // Normalize the captured SQL alias for the guard below. Matching only the
      // suffix of explicit_superseder previously reported a wrapped probe as bare.
      out.push({ line: idx + 1, text: text.trim().replace(`${match[1]}.payload`, 'superseder.payload') });
    }
  });
  return out;
}

describe('correlated rubric probe aliases', () => {
  it.each(['superseder', 'explicit_superseder', 'renamed_card'])('normalizes %s without hiding a bare comparison', (alias) => {
    const comparison = `${alias}.payload -> 'observation' ->> 'rubricRef' = scorecard.payload -> 'observation' ->> 'rubricRef'`;
    const normalized = "superseder.payload -> 'observation' ->> 'rubricRef' = scorecard.payload -> 'observation' ->> 'rubricRef'";
    expect(correlatedRubricRefLines(`AND (${comparison}) IS TRUE`)).toEqual([
      { line: 1, text: `AND (${normalized}) IS TRUE` },
    ]);
    expect(correlatedRubricRefLines(`AND ${comparison}`)).toEqual([
      { line: 1, text: `AND ${normalized}` },
    ]);
  });
});

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

  // EI-27666228016040017: a removable LIMIT lets EXISTS flatten this helper
  // into an anti-join. Its outer rubric guard then becomes a Join Filter,
  // after the inner timestamp scan, even for an unrelated rubric. OFFSET 0
  // retains the correlated subplan and its early One-Time Filter. Pin this
  // planner barrier rather than making the guard depend on test DB statistics.
  const specQualityProbe = source.match(/function specQualitySupersederSql\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1];
  const preservesOuterGuard = (probe: string) => /LIMIT\s+1\s+OFFSET\s+0\s*`/.test(probe);

  it('finds the spec-quality probe and its outer-rubric guard (positive control)', () => {
    expect(specQualityProbe).toBeDefined();
    expect(specQualityProbe).toContain("scorecard.payload -> 'observation' ->> 'rubricRef'");
    expect(specQualityProbe).toContain('SPEC_QUALITY_RUBRIC_REF');
  });

  it('keeps spec-quality supersession correlated so unrelated rubric reads skip its inner scan', () => {
    expect(preservesOuterGuard(specQualityProbe ?? '')).toBe(true);
  });

  it('detects removal of the optimizer barrier', () => {
    expect(preservesOuterGuard((specQualityProbe ?? '').replace(/OFFSET\s+0/, ''))).toBe(false);
  });

  // The inner constant is an index qual; the correlated rubric guards above
  // must still avoid joining the planner's equivalence class.
  const preservesInnerRubricIndex = (probe: string) =>
    /^\s*AND\s+spec_superseder\.payload\s*->\s*'observation'\s*->>\s*'rubricRef'\s*=\s*\$\{SPEC_QUALITY_RUBRIC_REF\}\s*$/m.test(probe);

  it('keeps the inner spec-quality constant usable by the rubric index', () => {
    expect(preservesInnerRubricIndex(specQualityProbe ?? '')).toBe(true);
  });

  it('detects hiding the inner rubric equality from the planner', () => {
    const mutant = (specQualityProbe ?? '').replace(
      /AND (spec_superseder\.payload -> 'observation' ->> 'rubricRef' = \$\{SPEC_QUALITY_RUBRIC_REF\})/,
      'AND ($1) IS TRUE',
    );
    expect(mutant).not.toBe(specQualityProbe);
    expect(preservesInnerRubricIndex(mutant)).toBe(false);
  });
});
