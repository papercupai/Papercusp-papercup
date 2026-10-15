/**
 * Fingerprint-coverage detector — WI-7469 (plan
 * semantic-search-fingerprint-coverage-2026-08-03, P-008 / P-027 / P-006).
 *
 * The load-bearing tests here are the ones that pin the two ways this detector could be
 * built such that it LOOKS correct and reports confident numbers while being useless:
 *
 *   1. Measuring coverage over ALL rows instead of ELIGIBLE rows (P-027). That makes the
 *      alarm unsatisfiable for session_turns, so it sits red forever and gets muted.
 *   2. Restating the eligibility/staleness predicates instead of importing the sweep's,
 *      so the detector silently goes on measuring an old definition after a bodySql edit.
 *
 * Both are asserted structurally, against every real target, not just a fixture.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  TARGETS,
  eligiblePredicateSql,
  modeColOf,
  recentPredicateSql,
  settledPredicateSql,
  stalePredicateSql,
  type BackfillTarget,
} from './embed-backfill';
import {
  BACKLOG_GROWTH_SAMPLES,
  MIN_BACKLOG_FOR_ALARM,
  MIN_RECENT_SAMPLE,
  RECENT_COVERAGE_FLOOR,
  SETTLED_GRACE_MINUTES,
  SETTLED_WINDOW_HOURS,
  TOTAL_COVERAGE_FLOOR,
  buildCoverageQuery,
  coverageTargets,
  computeDrain,
  consecutiveBacklogGrowth,
  consecutiveBacklogStuck,
  BACKLOG_STUCK_SAMPLES,
  MIN_BACKLOG_FOR_STUCK_ALARM,
  detectCoverageBreaches,
  formatCoverageToast,
  runEmbedCoverageAlarmOnce,
  surfaceKey,
  toSurfaceCoverage,
  type CoverageSample,
  type SurfaceCoverage,
} from './embed-coverage';

const sessionTurns = TARGETS.find((t) => t.table === 'harness_shared.session_turns')!;

describe('shared chunk coverage populations', () => {
  it('measures each reader collection independently of its healthy siblings', () => {
    const targets = coverageTargets();
    const report = targets.find(t => surfaceKey(t) === 'harness_shared.text_chunks.embedding:report')!;
    const plan = targets.find(t => surfaceKey(t) === 'harness_shared.text_chunks.embedding:plans')!;
    expect(report).toBeDefined();
    expect(plan).toBeDefined();
    expect(buildCoverageQuery(report,true,'gemma').sql).toContain("WHERE surface = 'report'");
    expect(buildCoverageQuery(plan,true,'gemma').sql).toContain("WHERE surface = 'plans'");
  });
});

function sample(over: Partial<CoverageSample> & { observedAt: Date }): CoverageSample {
  return {
    surface: 'harness_shared.session_turns.text_embedding',
    totalRows: 1000,
    eligibleRows: 800,
    embeddedRows: 800,
    recentEligible: null,
    recentEmbedded: null,
    ...over,
  };
}

// ── P-027: eligibility, and the anti-drift guarantee ────────────────────────

describe('eligibility is the sweep’s own predicate, not a restatement', () => {
  it('every target’s coverage query embeds `length(<its own bodySql>) > 0` verbatim', () => {
    for (const t of TARGETS) {
      const q = buildCoverageQuery(t, true, 'gemma');
      const expected = `length(${t.bodySql}) > 0`;
      expect(eligiblePredicateSql(t)).toBe(expected);
      expect(q.sql).toContain(expected);
    }
  });

  it('the coverage query reuses stalePredicateSql, so "covered" means the ACTIVE space', () => {
    // Measuring `embedCol IS NOT NULL` would report ~100% the moment the embedder mode
    // changed under it — blindest during exactly the incident it exists to catch.
    const q = buildCoverageQuery(sessionTurns, true, 'gemma');
    expect(q.sql).toContain(modeColOf(sessionTurns));
    expect(q.sql).toContain(`NOT (${stalePredicateSql(sessionTurns, true, '$1')})`);
  });

  it('binds the same TEXT-RECIPE version the sweep enforces, not merely the same predicate', () => {
    // P-026 / D-087. Sharing the builder is not sufficient when the bound VALUE can differ,
    // and this surface fails in the direction that misattributes blame: bind nothing here
    // while the sweep enforces recipe 2, and every correctly re-embedded row still counts as
    // stale — coverage reads 0% and the alarm accuses a sweep that is working perfectly.
    const v2: BackfillTarget = { ...sessionTurns, recipeVersion: 2 };
    const q0 = (t: BackfillTarget, recipeColPresent: boolean) =>
      buildCoverageQuery(t, true, 'gemma', undefined, recipeColPresent);
    const q = buildCoverageQuery(v2, true, 'gemma', undefined, true);
    expect(q.sql).toContain(`coalesce(${v2.embedCol}_recipe, 1) IS DISTINCT FROM $2`);
    expect(q.params[1]).toBe(2);
    expect(q.sql).toContain(`NOT (${stalePredicateSql(v2, true, '$1', '$2')})`);

    // FALSIFIABILITY CONTROL: same target, column not yet migrated here. The recipe term
    // must vanish AND leave no unused bind behind — otherwise the assertions above would
    // pass against a builder that emits the term unconditionally.
    const unmigrated = buildCoverageQuery(v2, true, 'gemma', undefined, false);
    expect(unmigrated.sql).not.toContain('_recipe');
    // It must bind exactly what a target that never opted in binds — no version left over.
    expect(unmigrated.params).toEqual(
      buildCoverageQuery(sessionTurns, true, 'gemma', undefined, true).params,
    );

    // And the property Postgres actually enforces, on every variant: the highest $n the SQL
    // REFERENCES equals the number of params supplied. A bind that is one too many is
    // rejected outright ("could not determine data type of parameter $n") — on exactly the
    // surfaces whose optional terms are absent, i.e. never on the one you tested by hand.
    for (const q of [q0(v2, true), q0(v2, false), q0(sessionTurns, true)]) {
      const highest = Math.max(...[...q.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      expect(highest).toBe(q.params.length);
    }
  });

  it('a target that has not opted in keeps the pre-777 coverage query even where the column exists', () => {
    // Introducing migration 777 must not change what coverage MEASURES, or the detector
    // would report a cliff on deploy day that no data movement explains.
    const q = buildCoverageQuery(sessionTurns, true, 'gemma', undefined, true);
    expect(q.sql).not.toContain('_recipe');
    expect(q.sql).toContain(`NOT (${stalePredicateSql(sessionTurns, true, '$1')})`);
  });

  it('falls back to the NULL-only predicate when the mode column is absent', () => {
    const q = buildCoverageQuery(sessionTurns, false, 'gemma');
    expect(q.sql).toContain(`${sessionTurns.embedCol} IS NULL`);
    expect(q.sql).not.toContain(modeColOf(sessionTurns));
  });

  it('session_turns really does exclude rows by design — the premise P-027 rests on', () => {
    // If this ever stops being true the unsatisfiable-alarm hazard is gone and this
    // whole eligibility apparatus is dead weight. Pin the premise, not just the fix.
    expect(sessionTurns.bodySql).toContain('length(text) >= 80');
  });

  it('coverage over ELIGIBLE rows is 100% where coverage over ALL rows would breach', () => {
    // The exact regression: 18.4% of session_turns can never be embedded. Judged on raw
    // rows this surface reads 81.6% — below the 95% floor — forever, no matter what the
    // sweep does. Judged on eligible rows it is correctly, achievably green.
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 1000,
      eligibleRows: 816,
      embeddedRows: 816,
      recentEligible: null,
      recentEmbedded: null,
    });
    expect(c.eligibleCoverage).toBe(1);
    expect(c.ineligibleRows).toBe(184);
    expect(816 / 1000).toBeLessThan(TOTAL_COVERAGE_FLOOR); // the alarm that could never clear
    expect(detectCoverageBreaches([{ coverage: c, history: [] }])).toEqual([]);
  });

  it('an empty surface is fully covered, not 0% covered', () => {
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 0, eligibleRows: 0, embeddedRows: 0, recentEligible: null, recentEmbedded: null,
    });
    expect(c.eligibleCoverage).toBe(1);
  });
});

// ── Parameter binding ───────────────────────────────────────────────────────

describe('parameter binding never supplies an unused placeholder', () => {
  // Postgres derives the parameter COUNT from the highest $n REFERENCED and rejects a
  // Bind supplying one the statement never uses. A fixed [mode, hours] array would fail
  // only on surfaces lacking a mode or recency column — i.e. it would pass every test
  // written against the common case, and break in production on two specific tables.
  const highestPlaceholder = (sql: string): number =>
    [...sql.matchAll(/\$(\d+)/g)].reduce((m, x) => Math.max(m, Number(x[1])), 0);

  it('binds exactly what each real target references', () => {
    for (const t of TARGETS) {
      for (const spaceAware of [true, false]) {
        const q = buildCoverageQuery(t, spaceAware, 'gemma');
        expect(highestPlaceholder(q.sql)).toBe(q.params.length);
      }
    }
  });

  it('a target with neither a mode nor a recency column binds nothing', () => {
    const bare: BackfillTarget = {
      table: 'harness_shared.harness_decisions',
      embedCol: 'body_embedding',
      bodySql: `left(COALESCE(verb, ''), 10)`,
      keyCols: ['harness_slug'],
    };
    const q = buildCoverageQuery(bare, false, 'gemma');
    expect(q.params).toEqual([]);
    expect(q.hasRecent).toBe(false);
    expect(q.sql).not.toContain('recent_eligible');
  });

  it('a target with a recency column emits both windows and binds each bound', () => {
    const q = buildCoverageQuery(sessionTurns, true, 'gemma', 24);
    expect(q.hasRecent).toBe(true);
    expect(q.sql).toContain('recent_eligible');
    expect(q.sql).toContain('settled_eligible');
    expect(q.sql).toContain('settled_embedded');
    expect(q.params).toEqual(['gemma', 24, SETTLED_GRACE_MINUTES, SETTLED_WINDOW_HOURS]);
  });

  it('the settled window is bounded at BOTH ends', () => {
    // Young bound: a row written 30s ago is legitimately unembedded (5-min sweep tick).
    // Old bound: without it the window slides back over a draining backlog, which is the
    // exact defect the 24h aggregate had.
    const sql = settledPredicateSql(sessionTurns, '$1', '$2')!;
    expect(sql).toContain('<=');
    expect(sql).toContain('>=');
    expect(sql).toContain('mins =>');
    expect(sql).toContain('hours =>');
  });
});

describe('recency columns', () => {
  it('uses epoch-ms arithmetic for bigint columns and interval arithmetic for timestamptz', () => {
    // Verified against the live schema by measuring max() on each column, not by reading
    // a declared type: the wrong scale yields a well-formed, plausible, WRONG answer.
    const ms = TARGETS.find((t) => t.table === 'harness_shared.work_items')!;
    expect(ms.recencyColKind).toBe('epochMs');
    expect(recentPredicateSql(ms, '$1')).toContain('extract(epoch from now()) * 1000');

    expect(sessionTurns.recencyColKind).toBe('timestamptz');
    expect(recentPredicateSql(sessionTurns, '$1')).toContain('make_interval');
  });

  it('work_items measures CREATION, not the column it orders by', () => {
    // updated_ts is the cheapest freshest-first index scan, but edit churn on old items
    // would let a real regression on new rows hide behind it.
    const wi = TARGETS.find((t) => t.table === 'harness_shared.work_items')!;
    expect(wi.orderBySql).toContain('updated_ts');
    expect(wi.recencyCol).toBe('created_ts');
  });

  it('a surface with no write-time column reports absent, never zero', () => {
    const bare: BackfillTarget = {
      table: 'harness_shared.harness_decisions',
      embedCol: 'body_embedding',
      bodySql: `left(COALESCE(verb, ''), 10)`,
      keyCols: ['harness_slug'],
    };
    expect(recentPredicateSql(bare, '$1')).toBeNull();
    const c = toSurfaceCoverage(bare, {
      totalRows: 10, eligibleRows: 10, embeddedRows: 0, recentEligible: null, recentEmbedded: null,
    });
    expect(c.recentCoverage).toBeNull();
    // …and an absent signal can never breach.
    expect(detectCoverageBreaches([{ coverage: c, history: [] }]).some((b) => b.kind === 'recent-coverage'))
      .toBe(false);
  });
});

// ── P-006: the drain > write invariant ──────────────────────────────────────

describe('P-006 drain rate vs write rate', () => {
  const t0 = new Date('2026-08-03T00:00:00Z');
  const t30 = new Date('2026-08-03T00:30:00Z');

  it('decomposes the backlog delta exactly into writes minus drains', () => {
    const d = computeDrain([
      sample({ observedAt: t30, eligibleRows: 1100, embeddedRows: 700 }),
      sample({ observedAt: t0, eligibleRows: 1000, embeddedRows: 500 }),
    ])!;
    expect(d.writtenEligible).toBe(100);
    expect(d.drainedRows).toBe(200);
    expect(d.backlogPrev).toBe(500);
    expect(d.backlogCur).toBe(400);
    // The identity the whole design rests on.
    expect(d.backlogDelta).toBe(d.writtenEligible - d.drainedRows);
    expect(d.holds).toBe(true);
    expect(d.drainPerMin).toBeCloseTo(200 / 30);
    expect(d.writePerMin).toBeCloseTo(100 / 30);
  });

  it('reports the invariant as violated when writes outrun drains', () => {
    const d = computeDrain([
      sample({ observedAt: t30, eligibleRows: 1300, embeddedRows: 600 }),
      sample({ observedAt: t0, eligibleRows: 1000, embeddedRows: 500 }),
    ])!;
    expect(d.holds).toBe(false);
    expect(d.backlogDelta).toBeGreaterThan(0);
  });

  it('is ABSENT, not zero, when unmeasurable', () => {
    // "No data" must never be indistinguishable from "the sweep did nothing".
    expect(computeDrain([])).toBeNull();
    expect(computeDrain([sample({ observedAt: t0 })])).toBeNull();
    // Clock skew / a duplicate sample: non-positive interval.
    expect(computeDrain([sample({ observedAt: t0 }), sample({ observedAt: t30 })])).toBeNull();
  });

  it('counts only CONSECUTIVE growth, stopping at the first shrink', () => {
    const mk = (mins: number, backlog: number) =>
      sample({ observedAt: new Date(t0.getTime() + mins * 60_000), eligibleRows: 1000 + backlog, embeddedRows: 1000 });
    // newest-first: 400, 300, 200, 250  → grew, grew, then shrank
    expect(consecutiveBacklogGrowth([mk(90, 400), mk(60, 300), mk(30, 200), mk(0, 250)])).toBe(2);
    expect(consecutiveBacklogGrowth([mk(30, 100), mk(0, 200)])).toBe(0);
  });
});

// ── Breach rules ────────────────────────────────────────────────────────────

describe('recent-row coverage — the recurrence catcher', () => {
  it('breaches when new writes are not being indexed', () => {
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 10_000, eligibleRows: 9000, embeddedRows: 9000,
      recentEligible: 500, recentEmbedded: 400,
      settledEligible: 500, settledEmbedded: 400,
    });
    const b = detectCoverageBreaches([{ coverage: c, history: [] }]);
    expect(b).toHaveLength(1);
    expect(b[0]!.kind).toBe('recent-coverage');
    expect(b[0]!.observed).toBeLessThan(RECENT_COVERAGE_FLOOR);
  });

  it('fires with NO history at all — it must not depend on a prior sample', () => {
    // The corpus-coverage rule withholds without history; if this one did too, a cold
    // start would be fully blind, which is when a regression is most likely to land.
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 100, eligibleRows: 100, embeddedRows: 100,
      recentEligible: 100, recentEmbedded: 0, settledEligible: 100, settledEmbedded: 0,
    });
    expect(detectCoverageBreaches([{ coverage: c, history: [] }])[0]!.kind).toBe('recent-coverage');
  });

  it('stays quiet on a sample too small to mean anything', () => {
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 100, eligibleRows: 100, embeddedRows: 100,
      recentEligible: MIN_RECENT_SAMPLE - 1, recentEmbedded: 0,
      settledEligible: MIN_RECENT_SAMPLE - 1, settledEmbedded: 0,
    });
    expect(detectCoverageBreaches([{ coverage: c, history: [] }])).toEqual([]);
  });

  it('stays quiet at full coverage', () => {
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 100, eligibleRows: 100, embeddedRows: 100,
      recentEligible: 100, recentEmbedded: 100, settledEligible: 100, settledEmbedded: 100,
    });
    expect(detectCoverageBreaches([{ coverage: c, history: [] }])).toEqual([]);
  });

  it('REGRESSION: a healthy write path behind a draining backlog does NOT breach', () => {
    // The exact live shape at 2026-08-03T08:45Z, which the first cut got WRONG.
    // session_turns: 13 straight hours at 100% (the write path) sitting in front of a
    // starved band at ~7% (the backlog). The 24h aggregate averaged them to 67.5% and
    // announced "new writes are NOT being indexed" — flatly false.
    //
    // The settled window sees only the healthy part, which is the whole point.
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 423_022, eligibleRows: 345_141, embeddedRows: 35_986,
      recentEligible: 21_569, recentEmbedded: 14_557,   // 67.5% over 24h
      settledEligible: 4_500, settledEmbedded: 4_500,   // 100% over the settled window
    });
    expect(c.recentCoverage!).toBeLessThan(RECENT_COVERAGE_FLOOR); // the misleading figure
    expect(c.settledCoverage).toBe(1);
    expect(detectCoverageBreaches([{ coverage: c, history: [] }])
      .some((b) => b.kind === 'recent-coverage')).toBe(false);
  });

  it('a genuine write-path break DOES breach even while a backlog drains behind it', () => {
    // The converse, and the reason the settled window is not just "suppress during drain":
    // the backlog is still draining, but the freshest settled rows have stopped being
    // indexed. That is a real regression and must still fire.
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 423_022, eligibleRows: 345_141, embeddedRows: 35_986,
      recentEligible: 21_569, recentEmbedded: 14_557,
      settledEligible: 4_500, settledEmbedded: 12,
    });
    const b = detectCoverageBreaches([{ coverage: c, history: [] }]);
    expect(b.some((x) => x.kind === 'recent-coverage')).toBe(true);
    // …and the message carries the 24h figure as CONTEXT, flagged as backlog-inclusive,
    // so a reader cannot mistake it for a second independent confirmation.
    expect(b.find((x) => x.kind === 'recent-coverage')!.detail).toContain('24h context');
  });
});

describe('corpus coverage is suppressed while genuinely converging', () => {
  const t0 = new Date('2026-08-03T00:00:00Z');
  const t30 = new Date('2026-08-03T00:30:00Z');
  const low = toSurfaceCoverage(sessionTurns, {
    totalRows: 400_000, eligibleRows: 340_000, embeddedRows: 30_000,
    recentEligible: 1000, recentEmbedded: 1000, settledEligible: 1000, settledEmbedded: 1000,
  });

  it('does NOT fire during a draining backfill', () => {
    // 8.8% coverage — far below the floor — but the backlog is shrinking. This is the
    // expected state for hours during P-007. An alarm here would be muted long before
    // it meant anything, which is the same failure P-027 describes by another route.
    const history = [
      sample({ observedAt: t30, eligibleRows: 340_000, embeddedRows: 30_000 }),
      sample({ observedAt: t0, eligibleRows: 339_000, embeddedRows: 20_000 }),
    ];
    expect(low.eligibleCoverage).toBeLessThan(TOTAL_COVERAGE_FLOOR);
    expect(detectCoverageBreaches([{ coverage: low, history }])
      .some((b) => b.kind === 'total-coverage')).toBe(false);
  });

  it('DOES fire when coverage is low and the backlog is not shrinking', () => {
    const history = [
      sample({ observedAt: t30, eligibleRows: 340_000, embeddedRows: 30_000 }),
      sample({ observedAt: t0, eligibleRows: 339_000, embeddedRows: 30_000 }),
    ];
    const b = detectCoverageBreaches([{ coverage: low, history }]);
    expect(b.some((x) => x.kind === 'total-coverage')).toBe(true);
  });

  it('withholds rather than guesses when convergence is unknowable', () => {
    // One sample cannot answer "is this converging?", and the honest response to an
    // unknowable precondition is silence — the recent-row signal covers the gap.
    const b = detectCoverageBreaches([{ coverage: low, history: [sample({ observedAt: t30 })] }]);
    expect(b.some((x) => x.kind === 'total-coverage')).toBe(false);
  });
});

describe('backlog-growing (P-006 violated)', () => {
  const t = (mins: number) => new Date(new Date('2026-08-03T00:00:00Z').getTime() + mins * 60_000);
  const growing = (n: number): CoverageSample[] =>
    Array.from({ length: n }, (_, i) =>
      sample({
        observedAt: t((n - 1 - i) * 30),
        eligibleRows: 100_000,
        // newest-first: backlog shrinks as i grows ⇒ it GREW over time
        embeddedRows: 10_000 + i * 1000,
      }),
    );

  it('needs sustained growth, not one burst', () => {
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 120_000, eligibleRows: 100_000, embeddedRows: 10_000,
      recentEligible: 100, recentEmbedded: 100, settledEligible: 100, settledEmbedded: 100,
    });
    const twoIntervals = detectCoverageBreaches([{ coverage: c, history: growing(BACKLOG_GROWTH_SAMPLES) }]);
    expect(twoIntervals.some((b) => b.kind === 'backlog-growing')).toBe(false);

    const enough = detectCoverageBreaches([{ coverage: c, history: growing(BACKLOG_GROWTH_SAMPLES + 1) }]);
    expect(enough.some((b) => b.kind === 'backlog-growing')).toBe(true);
  });

  it('ignores a tiny backlog on a small table', () => {
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 100, eligibleRows: 100, embeddedRows: 100 - (MIN_BACKLOG_FOR_ALARM - 1),
      recentEligible: null, recentEmbedded: null,
    });
    const history = Array.from({ length: BACKLOG_GROWTH_SAMPLES + 1 }, (_, i) =>
      sample({ observedAt: t((BACKLOG_GROWTH_SAMPLES - i) * 30), eligibleRows: 100, embeddedRows: 90 + i }),
    );
    expect(detectCoverageBreaches([{ coverage: c, history }])
      .some((b) => b.kind === 'backlog-growing')).toBe(false);
  });
});

describe('backlog-stuck (EI-19478208736094798)', () => {
  const t = (mins: number) => new Date(new Date('2026-08-03T00:00:00Z').getTime() + mins * 60_000);

  /** n samples, newest-first, where NOTHING was ever embedded — the stranded residue. */
  const stranded = (n: number, eligible: number, embedded: number): CoverageSample[] =>
    Array.from({ length: n }, (_, i) =>
      sample({ observedAt: t((n - 1 - i) * 30), eligibleRows: eligible, embeddedRows: embedded }),
    );

  // The MEASURED incident, replayed with its real numbers (2026-08-03 23:53Z):
  // 359,665 eligible on session_turns, 3,441 stranded ⇒ 99.043% coverage.
  const ELIGIBLE = 359_665;
  const STRANDED = 3_441;
  const incidentCoverage = toSurfaceCoverage(sessionTurns, {
    totalRows: 416_429,
    eligibleRows: ELIGIBLE,
    embeddedRows: ELIGIBLE - STRANDED,
    // bg-host ran fresh code the whole time, so the settled window was perfectly healthy.
    recentEligible: 500, recentEmbedded: 500, settledEligible: 500, settledEmbedded: 500,
  });

  it('CATCHES the measured incident that all three prior legs missed', () => {
    const history = stranded(BACKLOG_STUCK_SAMPLES + 1, ELIGIBLE, ELIGIBLE - STRANDED);
    const b = detectCoverageBreaches([{ coverage: incidentCoverage, history }]);
    expect(b.some((x) => x.kind === 'backlog-stuck')).toBe(true);
    const detail = b.find((x) => x.kind === 'backlog-stuck')!.detail;
    expect(detail).toContain('papercusp-bg-host');
    expect(detail).not.toContain('papercup-bg-host');
  });

  it('CALIBRATION: the three prior legs are genuinely blind to it', () => {
    // If any of these ever start firing, the new leg is redundant rather than load-bearing
    // — and this expectation, not a comment, is what would tell us.
    const history = stranded(BACKLOG_STUCK_SAMPLES + 1, ELIGIBLE, ELIGIBLE - STRANDED);
    const kinds = detectCoverageBreaches([{ coverage: incidentCoverage, history }]).map((x) => x.kind);
    expect(kinds).not.toContain('total-coverage'); // 99.043% clears the 95% floor
    expect(kinds).not.toContain('recent-coverage'); // settled window was 100%
    expect(kinds).not.toContain('backlog-growing'); // frozen backlog has delta 0
    // …and the coverage really is above the floor, so the first assertion is not vacuous.
    expect(incidentCoverage.eligibleCoverage).toBeGreaterThan(TOTAL_COVERAGE_FLOOR);
    expect(incidentCoverage.eligibleCoverage).toBeCloseTo(0.99043, 5);
  });

  it('stays SILENT during a legitimate multi-hour backfill that is draining', () => {
    // The false alarm that would get this muted: a real refill has a huge, old backlog
    // too — the only thing separating it from a wedge is that rows keep clearing.
    const draining = Array.from({ length: BACKLOG_STUCK_SAMPLES + 1 }, (_, i) =>
      sample({
        observedAt: t((BACKLOG_STUCK_SAMPLES - i) * 30),
        eligibleRows: ELIGIBLE,
        embeddedRows: 200_000 + (BACKLOG_STUCK_SAMPLES - i) * 20_000, // newest-first ⇒ climbing
      }),
    );
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 416_429, eligibleRows: ELIGIBLE, embeddedRows: 260_000,
      recentEligible: null, recentEmbedded: null,
    });
    expect(detectCoverageBreaches([{ coverage: c, history: draining }])
      .some((x) => x.kind === 'backlog-stuck')).toBe(false);
  });

  it('counts rows CLEARED, not backlog delta — healthy churn is not stuck', () => {
    // The subtle control. Each interval embeds 500 rows while 500 new eligible rows
    // arrive: backlogDelta is 0 at every step, but the index is being written the whole
    // time. A delta-based rule would call this stuck; a drained-based one must not.
    const churn = Array.from({ length: BACKLOG_STUCK_SAMPLES + 1 }, (_, i) => {
      const step = BACKLOG_STUCK_SAMPLES - i; // newest-first
      return sample({
        observedAt: t(step * 30),
        eligibleRows: ELIGIBLE + step * 500,
        embeddedRows: ELIGIBLE - STRANDED + step * 500,
      });
    });
    expect(consecutiveBacklogStuck(churn)).toBe(0);
    expect(detectCoverageBreaches([{ coverage: incidentCoverage, history: churn }])
      .some((x) => x.kind === 'backlog-stuck')).toBe(false);
  });

  it('needs sustained stuckness, not one starved interval', () => {
    // One interval clearing nothing is ordinary per-target fairness-cap starvation.
    const short = stranded(BACKLOG_STUCK_SAMPLES, ELIGIBLE, ELIGIBLE - STRANDED);
    expect(detectCoverageBreaches([{ coverage: incidentCoverage, history: short }])
      .some((x) => x.kind === 'backlog-stuck')).toBe(false);

    const enough = stranded(BACKLOG_STUCK_SAMPLES + 1, ELIGIBLE, ELIGIBLE - STRANDED);
    expect(detectCoverageBreaches([{ coverage: incidentCoverage, history: enough }])
      .some((x) => x.kind === 'backlog-stuck')).toBe(true);
  });

  it('ignores a residue below the floor', () => {
    const tiny = MIN_BACKLOG_FOR_STUCK_ALARM - 1;
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 10_000, eligibleRows: 10_000, embeddedRows: 10_000 - tiny,
      recentEligible: null, recentEmbedded: null,
    });
    const history = stranded(BACKLOG_STUCK_SAMPLES + 1, 10_000, 10_000 - tiny);
    expect(detectCoverageBreaches([{ coverage: c, history }])
      .some((x) => x.kind === 'backlog-stuck')).toBe(false);
  });

  it('says nothing when the backlog is fully drained', () => {
    const c = toSurfaceCoverage(sessionTurns, {
      totalRows: 10_000, eligibleRows: 10_000, embeddedRows: 10_000,
      recentEligible: null, recentEmbedded: null,
    });
    const history = stranded(BACKLOG_STUCK_SAMPLES + 1, 10_000, 10_000);
    expect(consecutiveBacklogStuck(history)).toBe(0);
    expect(detectCoverageBreaches([{ coverage: c, history }])).toEqual([]);
  });
});

describe('toast', () => {
  it('renders a stuck breach as rows, not as a percentage', () => {
    // Regression: the formatter branched on 'backlog-growing' alone, so a row-count
    // breach of any other kind rendered 3441 as "344100.0%".
    const t = formatCoverageToast([
      { surface: 's.a.emb', kind: 'backlog-stuck', observed: 3441, floor: 50, detail: 'd' },
    ]);
    expect(t.description).toContain('3441 rows');
    expect(t.description).not.toContain('%,');
    expect(t.description).not.toContain('344100.0%');
  });

  it('renders a rate breach as rows and a coverage breach as a percentage', () => {
    const t = formatCoverageToast([
      { surface: 's.a.emb', kind: 'recent-coverage', observed: 0.5, floor: 0.99, detail: 'd1' },
      { surface: 's.b.emb', kind: 'backlog-growing', observed: 1234, floor: 500, detail: 'd2' },
    ]);
    expect(t.level).toBe('warning');
    expect(t.description).toContain('50.0%');
    expect(t.description).toContain('1234 rows');
    // The muting hazard is named in the toast itself, so a reader knows the denominator.
    expect(t.description).toContain('ELIGIBLE');
  });
});

// ── The tick ────────────────────────────────────────────────────────────────

describe('runEmbedCoverageAlarmOnce', () => {
  const ok = (over: Partial<SurfaceCoverage> = {}): SurfaceCoverage => ({
    ...toSurfaceCoverage(sessionTurns, {
      totalRows: 100, eligibleRows: 100, embeddedRows: 100, recentEligible: 50, recentEmbedded: 50,
      settledEligible: 50, settledEmbedded: 50,
    }),
    ...over,
  });

  it('never throws when measurement fails — it cannot affect what it watches', async () => {
    // Assert the warning too: a monitor that swallows its own failure SILENTLY is the
    // same defect class this whole detector exists to fix, one level up.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runEmbedCoverageAlarmOnce({
      measure: async () => { throw new Error('pg down'); },
    });
    expect(r).toEqual({ surfaces: [], drains: [], breaches: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pg down'));
    warn.mockRestore();
  });

  it('persists a sample and stays silent when everything is healthy', async () => {
    const persisted: CoverageSample[][] = [];
    const emit = vi.fn();
    const r = await runEmbedCoverageAlarmOnce({
      measure: async () => [ok()],
      loadHistory: async () => new Map(),
      persist: async (s) => { persisted.push(s); },
      emitToast: emit,
    });
    expect(r.breaches).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    expect(persisted[0]).toHaveLength(1);
    expect(persisted[0]![0]!.surface).toBe(surfaceKey(sessionTurns));
  });

  it('toasts on a breach', async () => {
    const emit = vi.fn();
    const r = await runEmbedCoverageAlarmOnce({
      measure: async () => [ok({ settledEligible: 100, settledEmbedded: 0, settledCoverage: 0 })],
      loadHistory: async () => new Map(),
      persist: async () => {},
      emitToast: emit,
    });
    expect(r.breaches.map((b) => b.kind)).toContain('recent-coverage');
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('still evaluates when the history read fails — history enhances, it is not required', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn();
    const r = await runEmbedCoverageAlarmOnce({
      measure: async () => [ok({ settledEligible: 100, settledEmbedded: 0, settledCoverage: 0 })],
      loadHistory: async () => { throw new Error('no table yet'); },
      persist: async () => {},
      emitToast: emit,
    });
    expect(r.breaches.map((b) => b.kind)).toContain('recent-coverage');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('history read failed'));
    warn.mockRestore();
  });

  it('still returns its analysis when persistence fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runEmbedCoverageAlarmOnce({
      measure: async () => [ok()],
      loadHistory: async () => new Map(),
      persist: async () => { throw new Error('disk full'); },
      emitToast: async () => {},
    });
    expect(r.surfaces).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('persist failed'));
    warn.mockRestore();
  });

  it('computes a drain observation from the loaded history', async () => {
    const prior = new Map<string, CoverageSample[]>([
      [surfaceKey(sessionTurns), [sample({
        surface: surfaceKey(sessionTurns),
        observedAt: new Date(Date.now() - 30 * 60_000),
        eligibleRows: 100, embeddedRows: 60,
      })]],
    ]);
    const r = await runEmbedCoverageAlarmOnce({
      measure: async () => [ok()],
      loadHistory: async () => prior,
      persist: async () => {},
      emitToast: async () => {},
    });
    expect(r.drains).toHaveLength(1);
    expect(r.drains[0]!.drainedRows).toBe(40);
    expect(r.drains[0]!.holds).toBe(true);
  });
});
