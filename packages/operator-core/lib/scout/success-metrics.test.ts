/**
 * success-metrics.test.ts — the P-015 program done-check.
 *
 * The point of these tests is DISCRIMINATION, not coverage: every bar is exercised in all
 * three states (pass / fail / unknown) on hand-built ledger snapshots, because a gate that
 * cannot be shown to fail on bad data is not a gate — it is a green light with extra steps
 * (agent-insights/prove-it-discriminates-before-it-acts).
 */
import { describe, expect, it } from 'vitest';

import {
  evaluateProgramSuccess,
  CYCLE_ERROR_WINDOW_MS,
  LEDGER_RECONCILE_EPOCH_MS,
  LENS_DIVERSITY_SAMPLE,
  MIN_ERROR_RATE_DENOMINATOR,
  STRICT_ERROR_RATE_DENOMINATOR,
  oneSidedBinomialUpperBound,
  programSuccessReadScopes,
  SCOUT_TICK_INSTALL_SLUG,
  type ProgramSuccessReport,
  type ProgramSuccessInputs,
} from './success-metrics';
import type { ScoutQualityInputs } from './quality-metrics';
import { isCapacityError } from './scheduler';
import { hasForcedDiversity } from './invariants';
import type { ScoutTickRecord } from './tick-ledger';
import type { RoutedIdeaProvenance, LensOutcomeReport } from './outcome-feedback';
import { SU_IDEATION_LENSES, type SuIdeationLens, type CreativeLens } from './types';

const emptyOutcomes = (): LensOutcomeReport<SuIdeationLens> => ({
  total: 0,
  ranked: [],
  byLens: Object.fromEntries(
    SU_IDEATION_LENSES.map((l) => [l, { won: 0, lost: 0, pending: 0, winRate: null, weight: 1 }]),
  ) as LensOutcomeReport<SuIdeationLens>['byLens'],
});

const ranTick = (over: Partial<ScoutTickRecord> = {}): ScoutTickRecord => ({
  status: 'ran',
  ideasGenerated: 3,
  ideasRouted: 0,
  detail: { cycleId: 'c1', reason: 'signal-volume' },
  ...over,
});

const idea = (over: Partial<RoutedIdeaProvenance> = {}): RoutedIdeaProvenance => ({
  ideaId: 'i1',
  lens: 'risk-first' as unknown as RoutedIdeaProvenance['lens'],
  rail: 'plan' as RoutedIdeaProvenance['rail'],
  routedRef: 'plan:some-plan',
  cycleId: 'c1',
  ...over,
});

/**
 * The two-partition shape: cadence bars read the SCOUT tick partition, idea bars read every
 * routed idea. The fixtures pass the same ideas as both the cadence partition's ledger (so
 * the per-cycle reconcile join has rows) and the union — which is what production does for
 * a scout-origin idea.
 */
const inputs = (
  ticks: ScoutTickRecord[],
  routedIdeas: RoutedIdeaProvenance[],
  gymCorpus?: ProgramSuccessInputs['gymCorpus'],
): ProgramSuccessInputs => ({
  cadence: { ticks, routedIdeas, lensOutcomes: emptyOutcomes() } as unknown as ScoutQualityInputs<CreativeLens>,
  ideas: routedIdeas,
  ...(gymCorpus ? { gymCorpus } : {}),
});

/**
 * The all-real corpus a FULLY-GREEN gate now requires (P-011). Most fixtures omit it
 * on purpose: `fitness-signal-is-real` then rates `unknown`, which is the honest
 * reading of a fixture that never stated its benchmark's provenance — and is why the
 * verdict roll-up tests below assert 'incomplete' rather than 'pass'.
 */
const REAL_CORPUS: ProgramSuccessInputs['gymCorpus'] = {
  realCount: 3,
  syntheticCount: 0,
  // A real corpus only counts once it has been RUN: labels alone rate `unknown`.
  realScoredRuns: 9,
  harnessSlug: 'papercusp',
};

const bar = (r: ProgramSuccessReport, key: string) => r.criteria.find((c) => c.key === key)!;

describe('evaluateProgramSuccess — rubric-grounded ideas', () => {
  it('PASSES when a routed idea is grounded in the rubric lane', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 1 })],
        [idea({ addressesPatternRefs: ['rubric:su-agent-behavior/tool-discipline'] })],
      ),
    );
    expect(bar(r, 'rubric-grounded-ideas').status).toBe('pass');
    expect(bar(r, 'rubric-grounded-ideas').observed).toContain('1 of 1');
  });

  it('FAILS when ideas route but NONE are rubric-grounded — the founding defect (lane silently at zero)', () => {
    const r = evaluateProgramSuccess(
      inputs([ranTick({ ideasRouted: 2 })], [idea({ addressesPatternRefs: ['corpus:x'] }), idea({ ideaId: 'i2' })]),
    );
    expect(bar(r, 'rubric-grounded-ideas').status).toBe('fail');
    expect(r.verdict).toBe('fail');
  });

  it('is UNKNOWN (never pass) on an empty ledger — an empty window cannot certify the program', () => {
    const r = evaluateProgramSuccess(inputs([], []));
    expect(bar(r, 'rubric-grounded-ideas').status).toBe('unknown');
    expect(r.verdict).toBe('incomplete');
    expect(r.passed).toBe(0);
  });
});

describe('evaluateProgramSuccess — zero-signal cycles', () => {
  it('PASSES when every scored cycle fired on real signal, and counts the quiet-period vetoes', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [
          ranTick({ detail: { cycleId: 'c1', signalScore: 42 } }),
          { status: 'gated', gate: 'no-signal' },
          { status: 'gated', gate: 'no-signal' },
        ],
        [],
      ),
    );
    expect(bar(r, 'zero-signal-cycles').status).toBe('pass');
    expect(bar(r, 'zero-signal-cycles').observed).toContain('2 quiet ticks vetoed');
  });

  it('FAILS when a cycle fired at score 0 — pure wasted spend', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ detail: { cycleId: 'c1', signalScore: 0 } })], []));
    expect(bar(r, 'zero-signal-cycles').status).toBe('fail');
  });

  it('an ABSENT score is UNKNOWN, not a 0 — legacy ticks must not fail the bar on history', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ detail: { cycleId: 'c1' } })], []));
    expect(bar(r, 'zero-signal-cycles').status).toBe('unknown');
  });
});

describe('evaluateProgramSuccess — cycle error rate', () => {
  it('computes exact one-sided binomial upper bounds, including nonzero failures', () => {
    // Clopper–Pearson calibration points: the first is the exact zero-error
    // special case, while the second is the regression that the old n>=60
    // heuristic incorrectly called a literal <5% release claim.
    expect(oneSidedBinomialUpperBound(0, 60)).toBeCloseTo(0.0487029133100975, 12);
    expect(oneSidedBinomialUpperBound(2, 60)).toBeCloseTo(0.1012358949241616, 12);
  });

  it('validates exact-bound inputs instead of silently manufacturing a denominator', () => {
    expect(() => oneSidedBinomialUpperBound(0, 0)).toThrow('trials');
    expect(() => oneSidedBinomialUpperBound(2, 1)).toThrow('errors');
    expect(() => oneSidedBinomialUpperBound(1, 2, 1)).toThrow('confidence');
  });

  it('PASSES under the 5% bar', () => {
    const ticks = [...Array(20)].map((_, i) => ranTick({ detail: { cycleId: `c${i}`, signalScore: 5 } }));
    expect(bar(evaluateProgramSuccess(inputs(ticks, [])), 'cycle-error-rate').status).toBe('pass');
  });

  it('FAILS at the historical ~30% error rate the program set out to fix', () => {
    const ticks: ScoutTickRecord[] = [
      ...[...Array(7)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } })),
      ...[...Array(3)].map((): ScoutTickRecord => ({ status: 'error' })),
    ];
    const r = evaluateProgramSuccess(inputs(ticks, []));
    expect(bar(r, 'cycle-error-rate').status).toBe('fail');
    expect(bar(r, 'cycle-error-rate').observed).toContain('30.0%');
  });

  // WI-5397 denominator guard (design ask su-b37b0389 2026-07-19): the bar emitted
  // status:'pass' on the LIVE 0-errors/1-cycle window after a bg-host restart — a green
  // its own data could not support. A thin clean window is now 'unknown', never 'pass'.
  it('REFUSES to pass on a thin clean window — the live 0-errors/1-cycle false green', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ detail: { cycleId: 'c1' } })], []));
    const b = bar(r, 'cycle-error-rate');
    expect(b.status).toBe('unknown');
    expect(b.status).not.toBe('pass');
    expect(b.unknownReason?.code).toBe('insufficient-data');
    expect(b.unknownReason?.detail).toContain('denominator too small: n=1');
    // The measurement is still reported — the refusal is about the CLAIM, not the data.
    expect(b.observed).toContain('0 error ticks / 1 cycle ticks');
  });

  it('still refuses one short of the minimum, and passes AT it', () => {
    const clean = (n: number) => [...Array(n)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } }));
    expect(bar(evaluateProgramSuccess(inputs(clean(MIN_ERROR_RATE_DENOMINATOR - 1), [])), 'cycle-error-rate').status).toBe(
      'unknown',
    );
    expect(bar(evaluateProgramSuccess(inputs(clean(MIN_ERROR_RATE_DENOMINATOR), [])), 'cycle-error-rate').status).toBe(
      'pass',
    );
  });

  it('labels a pass between the minimum and strict denominators as the WEAKER claim', () => {
    const ticks = [...Array(MIN_ERROR_RATE_DENOMINATOR)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } }));
    const b = bar(evaluateProgramSuccess(inputs(ticks, [])), 'cycle-error-rate');
    expect(b.status).toBe('pass');
    expect(b.observed).toContain('rejects the ~30% baseline');
    expect(b.observed).toContain('literal 5.0% release bound NOT established');
  });

  it('claims the literal bound when the exact upper confidence bound clears it', () => {
    const ticks = [...Array(STRICT_ERROR_RATE_DENOMINATOR)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } }));
    const b = bar(evaluateProgramSuccess(inputs(ticks, [])), 'cycle-error-rate');
    expect(b.status).toBe('pass');
    expect(b.observed).toContain('bound supported at 95%');
    expect(b.observed).toContain('upper bound 4.9%');
  });

  it('keeps the historical-baseline pass but refuses a literal release claim for 2/60 errors', () => {
    const ticks: ScoutTickRecord[] = [
      ...[...Array(58)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } })),
      { status: 'error', detail: { cycleId: 'err-1' } },
      { status: 'error', detail: { cycleId: 'err-2' } },
    ];
    const b = bar(evaluateProgramSuccess(inputs(ticks, [])), 'cycle-error-rate');
    expect(b.status).toBe('pass');
    expect(b.observed).toContain('rejects the ~30% baseline');
    expect(b.observed).toContain('literal 5.0% release bound NOT established at 95%');
    expect(b.observed).toContain('upper bound 10.1%');
    expect(b.observed).not.toContain('release bound supported at 95%');
  });

  it('can clear the literal target before the legacy 60-cycle heuristic', () => {
    const ticks = [...Array(59)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } }));
    const b = bar(evaluateProgramSuccess(inputs(ticks, [])), 'cycle-error-rate');
    expect(b.status).toBe('pass');
    expect(oneSidedBinomialUpperBound(0, 59)).toBeLessThan(0.05);
    expect(b.observed).toContain('literal 5.0% release bound supported at 95%');
  });

  // The guard is ASYMMETRIC on purpose: an observed error is positive evidence of
  // breakage, so a FAIL fires at any n — only the green needs the denominator.
  it('FAILS on a thin window with an error — the guard gates pass only', () => {
    const r = evaluateProgramSuccess(inputs([{ status: 'error' }] as ScoutTickRecord[], []));
    expect(bar(r, 'cycle-error-rate').status).toBe('fail');
  });

  it('is exclusive at the bar — exactly 5% FAILS (< , not <=)', () => {
    const ticks: ScoutTickRecord[] = [
      ...[...Array(19)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } })),
      { status: 'error' },
    ];
    expect(bar(evaluateProgramSuccess(inputs(ticks, [])), 'cycle-error-rate').status).toBe('fail');
  });

  it('counts the live EI-11417 downstream-wait timeout as a genuine error', () => {
    const ticks: ScoutTickRecord[] = [
      ...[...Array(12)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } })),
      {
        status: 'error',
        detail: {
          cycleId: 'scout-1783958405158',
          error:
            'Scout ideator analogical did not receive an upstream response before the cycle deadline (left the local governor but remained queued/stalled downstream; not generation)',
        },
      },
    ];
    const r = evaluateProgramSuccess(inputs(ticks, []));
    expect(bar(r, 'cycle-error-rate').status).toBe('fail');
    expect(bar(r, 'cycle-error-rate').observed).toContain('1 error ticks / 13 cycle ticks');
  });

  it('EXCLUDES gated self-veto ticks from the denominator — the rate is over CYCLES, not all ticks (EI-11418)', () => {
    // The live false-pass: 1 genuine error among 13 CYCLE ticks is 7.7% (>5% => FAIL), but a quiet
    // window padded with gated self-vetoes (min-interval/no-trigger/no-signal/circuit/no-capacity)
    // dilutes 1/33 to 3.0% and FALSE-PASSES. A gated tick is a decision NOT to run a cycle — it is
    // not a cycle and must not be in the error-rate denominator. Red on the buggy /totalTicks math,
    // green on the fixed /cycleTicks math.
    const ticks: ScoutTickRecord[] = [
      ...[...Array(12)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } })),
      {
        status: 'error',
        detail: { cycleId: 'scout-err', error: 'Scout cycle timed out after 600000ms during phase ideate' },
      },
      ...[...Array(20)].map((): ScoutTickRecord => ({ status: 'gated', gate: 'min-interval' })),
    ];
    const r = evaluateProgramSuccess(inputs(ticks, []));
    expect(bar(r, 'cycle-error-rate').status).toBe('fail');
    // Denominator is the 13 CYCLE ticks (12 ran + 1 errored), not the 33 total ticks in the window.
    expect(bar(r, 'cycle-error-rate').observed).toContain('1 error ticks / 13 cycle ticks');
    expect(r.window.ticks).toBe(33);
  });

  it('a window of ONLY gated ticks is UNKNOWN — no cycle got a fair shot, so no error-rate denominator', () => {
    const ticks: ScoutTickRecord[] = [...Array(15)].map((): ScoutTickRecord => ({ status: 'gated', gate: 'no-capacity' }));
    const r = evaluateProgramSuccess(inputs(ticks, []));
    expect(bar(r, 'cycle-error-rate').status).toBe('unknown');
    // The old /totalTicks math would have read 0/15 = 0% and PASSED — a false green on zero cycles.
  });
});

// WI-5397: the soak-method fix — the cycle-error-rate bar's denominator/numerator swap
// to the CODE-HASH-scoped tick union (unbounded by time) when the caller supplies one,
// instead of the time-windowed `cadence.ticks` — because a rolling window resets its
// tick history to near-zero on every bg-host restart (fact
// alpha-011-soak-unreachable-as-planned). This is the exact branch that manufactured
// bg-host-restart-zeroing false UNKNOWNs/FAILs before this fix.
describe('evaluateProgramSuccess — cadenceByCodeHash soak-method fix (WI-5397)', () => {
  it('judges the error-rate bar over the code-hash union, NOT the (much thinner) time-windowed cadence.ticks', () => {
    // Time-windowed cadence.ticks: a lone genuine error among too few cycles to discriminate.
    const windowedTicks: ScoutTickRecord[] = [
      ranTick({ detail: { cycleId: 'w1' } }),
      { status: 'error', detail: { cycleId: 'w-err' } },
    ];
    // The code-hash union: a much larger, restart-spanning history of the SAME code that is
    // healthy overall (1 error / 21 cycles = 4.8% < 5%).
    const codeHashTicks: ScoutTickRecord[] = [
      ...[...Array(20)].map((_, i) => ranTick({ detail: { cycleId: `u${i}` } })),
      { status: 'error', detail: { cycleId: 'u-err' } },
    ];
    const r = evaluateProgramSuccess({
      ...inputs(windowedTicks, []),
      cadenceByCodeHash: { ticks: codeHashTicks, codeHash: 'hash-abc123' },
    });
    // The windowed-only math would read 1/2 = 50% and FAIL; the code-hash union reads
    // 1/21 = 4.8% and PASSES — proof the bar actually switched denominators.
    expect(bar(r, 'cycle-error-rate').status).toBe('pass');
    expect(bar(r, 'cycle-error-rate').observed).toContain('1 error ticks / 21 cycle ticks');
    expect(bar(r, 'cycle-error-rate').observed).toContain('soak: code-identical union across restarts, hash hash-abc123');
  });

  it('stamps window.codeHash + window.codeHashTicks for audit provenance when a union was used', () => {
    const codeHashTicks = [ranTick({ detail: { cycleId: 'u1' } }), ranTick({ detail: { cycleId: 'u2' } })];
    const r = evaluateProgramSuccess({
      ...inputs([], []),
      cadenceByCodeHash: { ticks: codeHashTicks, codeHash: 'hash-xyz' },
    });
    expect(r.window.codeHash).toBe('hash-xyz');
    expect(r.window.codeHashTicks).toBe(2);
  });

  it('FALLS BACK to the time-windowed cadence.ticks when cadenceByCodeHash.codeHash is null (unresolved)', () => {
    const windowedTicks: ScoutTickRecord[] = [
      ...[...Array(19)].map((_, i) => ranTick({ detail: { cycleId: `w${i}` } })),
      { status: 'error', detail: { cycleId: 'w-err' } },
    ];
    const r = evaluateProgramSuccess({
      ...inputs(windowedTicks, []),
      // codeHash: null — e.g. the process's scout source files were unreadable at hash
      // time. Must judge the SAME window as if cadenceByCodeHash were absent entirely,
      // never silently substitute a different (in this case empty) union.
      cadenceByCodeHash: { ticks: [], codeHash: null },
    });
    expect(bar(r, 'cycle-error-rate').observed).toContain('1 error ticks / 20 cycle ticks');
    // cadenceByCodeHash was SUPPLIED (just unresolved) — window.codeHash still reports the
    // null provenance rather than omitting the key entirely (that omission is reserved for
    // "cadenceByCodeHash wasn't passed at all", the next test below).
    expect(r.window.codeHash).toBeNull();
  });

  it('FALLS BACK to the time-windowed read when cadenceByCodeHash is entirely absent (pre-WI-5397 fixture, byte-compatible)', () => {
    const windowedTicks = [...Array(20)].map((_, i) => ranTick({ detail: { cycleId: `c${i}`, signalScore: 5 } }));
    const r = evaluateProgramSuccess(inputs(windowedTicks, []));
    expect(bar(r, 'cycle-error-rate').status).toBe('pass');
    expect(r.window.codeHash).toBeUndefined();
    expect(r.window.codeHashTicks).toBeUndefined();
  });
});

describe('programSuccessReadScopes — release window and singleton host', () => {
  it('reads Scout ticks and routed ideas from @singleton while keeping su-ideate harness-scoped', () => {
    const nowMs = Date.parse('2026-07-13T16:30:00Z');
    const scopes = programSuccessReadScopes({ harnessSlug: 'papercusp', nowMs });
    expect(scopes.cadence.harnessSlug).toBe(SCOUT_TICK_INSTALL_SLUG);
    expect(scopes.cadence.tickInstallSlug).toBe(SCOUT_TICK_INSTALL_SLUG);
    expect(scopes.cadence.tickSinceMs).toBe(nowMs - CYCLE_ERROR_WINDOW_MS);
    expect(scopes.cadence.tickLimit).toBeUndefined();
    // su-ideate is a per-harness partition; it must not inherit the singleton tick host.
    expect(scopes.suIdeate.harnessSlug).toBe('papercusp');
    expect(scopes.suIdeate.tickInstallSlug).toBeUndefined();
  });

  it('still scopes the cadence ledger to @singleton when no member harness is supplied', () => {
    const scopes = programSuccessReadScopes({ nowMs: Date.parse('2026-07-13T16:30:00Z') });
    expect(scopes.cadence.harnessSlug).toBe(SCOUT_TICK_INSTALL_SLUG);
    expect(scopes.suIdeate.harnessSlug).toBeUndefined();
  });

  it('an ABSOLUTE sinceMs floors the tick window at the generation boundary (EI-12148)', () => {
    // The motivating defect: a fix ships, the bg-host restarts, and the rolling 48h box
    // keeps judging PRE-fix errors for up to 48h (reported 9.0% while the true post-restart
    // rate was 0/8). sinceMs = the restart instant judges only the RUNNING generation.
    const nowMs = Date.parse('2026-07-14T22:00:00Z');
    const restartMs = Date.parse('2026-07-14T18:08:24Z');
    const scopes = programSuccessReadScopes({ nowMs, sinceMs: restartMs });
    expect(scopes.cadence.tickSinceMs).toBe(restartMs);
    expect(scopes.tickSinceMs).toBe(restartMs);
    // The derived window length is provenance, not a second knob.
    expect(scopes.tickWindowMs).toBe(nowMs - restartMs);
  });

  it('sinceMs OVERRIDES cycleWindowMs; omitted, the rolling default is byte-identical (no behavior change)', () => {
    const nowMs = Date.parse('2026-07-14T22:00:00Z');
    const floor = nowMs - 60_000;
    const withBoth = programSuccessReadScopes({ nowMs, sinceMs: floor, cycleWindowMs: 1_000_000 });
    expect(withBoth.cadence.tickSinceMs).toBe(floor);
    // Omitted args must reproduce the pre-EI-12148 read exactly — existing callers see zero diff.
    const defaulted = programSuccessReadScopes({ nowMs });
    expect(defaulted.tickWindowMs).toBe(CYCLE_ERROR_WINDOW_MS);
    expect(defaulted.cadence.tickSinceMs).toBe(nowMs - CYCLE_ERROR_WINDOW_MS);
  });
});

describe('evaluateProgramSuccess — ledger reconciliation', () => {
  it('PASSES when each cycle’s routed count matches its ledger rows', () => {
    const r = evaluateProgramSuccess(
      inputs([ranTick({ ideasRouted: 2, detail: { cycleId: 'c1' } })], [idea(), idea({ ideaId: 'i2' })]),
    );
    expect(bar(r, 'ledger-reconciles').status).toBe('pass');
  });

  it('FAILS on per-cycle drift — a tick claiming routes with no ledger rows behind it', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 3, detail: { cycleId: 'c1' } })], []));
    expect(bar(r, 'ledger-reconciles').status).toBe('fail');
    expect(bar(r, 'ledger-reconciles').observed).toContain('tick claims 3, ledger has 0');
  });

  it('does NOT let opposite per-cycle drifts cancel out (a window SUM would certify this as healthy)', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [
          ranTick({ ideasRouted: 3, detail: { cycleId: 'c1' } }), // ledger has 1 → -2
          ranTick({ ideasRouted: 1, detail: { cycleId: 'c2' } }), // ledger has 3 → +2
        ],
        [
          idea({ cycleId: 'c1' }),
          idea({ ideaId: 'i2', cycleId: 'c2' }),
          idea({ ideaId: 'i3', cycleId: 'c2' }),
          idea({ ideaId: 'i4', cycleId: 'c2' }),
        ],
      ),
    );
    expect(bar(r, 'ledger-reconciles').status).toBe('fail');
  });

  it('EXCLUDES pre-fix cycles — their rows were destroyed by the pre-P-003 overwrite bug, so judging them would red-pin the bar on unrepairable history forever', () => {
    const preFix = `scout-${LEDGER_RECONCILE_EPOCH_MS - 60_000}`;
    const postFix = `scout-${LEDGER_RECONCILE_EPOCH_MS + 60_000}`;
    const r = evaluateProgramSuccess(
      inputs(
        [
          ranTick({ ideasRouted: 3, detail: { cycleId: preFix } }), // destroyed history — must NOT count
          ranTick({ ideasRouted: 1, detail: { cycleId: postFix } }), // the fix governs this one
        ],
        [idea({ cycleId: postFix })],
      ),
    );
    expect(bar(r, 'ledger-reconciles').status).toBe('pass');
    expect(bar(r, 'ledger-reconciles').observed).toContain('1 pre-fix cycle(s) excluded');
  });

  it('still FAILS on post-fix drift — the epoch floor excuses history, never a live regression', () => {
    const postFix = `scout-${LEDGER_RECONCILE_EPOCH_MS + 60_000}`;
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 3, detail: { cycleId: postFix } })], []));
    expect(bar(r, 'ledger-reconciles').status).toBe('fail');
  });

  it('reconcileEpochMs:0 re-opens all of history — the escape hatch for measuring the pre-fix damage', () => {
    const preFix = `scout-${LEDGER_RECONCILE_EPOCH_MS - 60_000}`;
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 3, detail: { cycleId: preFix } })], []), {
      reconcileEpochMs: 0,
    });
    expect(bar(r, 'ledger-reconciles').status).toBe('fail');
  });

  it('a TRUNCATED ledger read is UNKNOWN, never fail — it must not manufacture phantom drift', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 3, detail: { cycleId: 'c1' } })], []), {
      ledgerTruncated: true,
    });
    expect(bar(r, 'ledger-reconciles').status).toBe('unknown');
    expect(r.failed).toBe(0);
    expect(r.window.ledgerTruncated).toBe(true);
  });

  it('EI-19899928839197448: FAILS (not unknown) when cycles ran but the ledger holds ZERO scout-routed ideas at all — a dead pipeline, not "nothing to reconcile"', () => {
    // Every cycle claims 0 routed and the ledger has 0 rows — the 0=0 "trivially consistent"
    // shape a totally dead routing pipeline produces for 6 days straight (the live incident).
    const r = evaluateProgramSuccess(
      inputs(
        [...Array(5)].map((_, i) => ranTick({ ideasRouted: 0, detail: { cycleId: `c-${i}` } })),
        [],
      ),
    );
    const b = bar(r, 'ledger-reconciles');
    expect(b.status).toBe('fail');
    expect(b.observed).toContain('5 cycle(s) ran');
    expect(b.observed).toContain('ZERO scout-routed ideas');
  });

  it('a genuinely EMPTY window (no cycles ran either) stays UNKNOWN — the liveness override only fires once cycles had a chance to route', () => {
    const r = evaluateProgramSuccess(inputs([], []));
    expect(bar(r, 'ledger-reconciles').status).toBe('unknown');
  });
});

describe('evaluateProgramSuccess — grader feedback revised', () => {
  const gradedAt = '2026-07-13T12:00:00.000Z';

  it('PASSES with an attributed typed revision created after the grade, including a successor session', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 1 })],
        [
          idea({
            humanGrade: 3,
            humanFeedback: 'tighten the scope',
            gradedBy: 'owner',
            gradedAt,
            createdBy: 'su-originator',
            feedbackRevisions: [
              { revisionRef: 'EI-2', createdBy: 'su-successor', revisedAt: '2026-07-13T12:01:00.000Z' },
            ],
          }),
        ],
      ),
    );
    const b = bar(r, 'grader-feedback-revised');
    expect(b.status).toBe('pass');
    expect(b.observed).toContain('1 routed idea(s) have a causally valid typed feedback revision');
  });

  it('FAILS closed on no edge, a pre-grade edge, and an unattributed edge', () => {
    const base = {
      humanGrade: 2,
      humanFeedback: 'revise it',
      gradedBy: 'owner' as const,
      gradedAt,
      createdBy: 'su-originator',
    };
    const cases: RoutedIdeaProvenance[] = [
      idea(base),
      idea({
        ...base,
        ideaId: 'i2',
        feedbackRevisions: [{ revisionRef: 'EI-2', createdBy: 'su-originator', revisedAt: '2026-07-13T11:59:00.000Z' }],
      }),
      idea({
        ...base,
        ideaId: 'i3',
        feedbackRevisions: [{ revisionRef: 'EI-3', revisedAt: '2026-07-13T12:01:00.000Z' }],
      }),
    ];
    for (const candidate of cases) {
      const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 1 })], [candidate]));
      expect(bar(r, 'grader-feedback-revised').status).toBe('fail');
    }
  });

  it('is UNKNOWN when nothing is graded yet — the channel has produced no input', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 1 })], [idea()]));
    expect(bar(r, 'grader-feedback-revised').status).toBe('unknown');
  });
});

describe('evaluateProgramSuccess — lens diversity (D-004, WI-4482)', () => {
  const scoutIdea = (lens: string, n: number): RoutedIdeaProvenance =>
    idea({ ideaId: `i-${lens}-${n}`, lens: lens as unknown as RoutedIdeaProvenance['lens'] });

  it('PASSES when the roster spans >=2 lenses', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 4 })],
        [
          scoutIdea('analogical', 1),
          scoutIdea('reframing', 2),
          scoutIdea('first-principles', 3),
          scoutIdea('constraint-removal', 4),
        ],
      ),
    );
    const b = bar(r, 'lens-diversity');
    expect(b.status).toBe('pass');
    expect(b.observed).toContain('4 distinct lenses');
  });

  it('FAILS when the roster has collapsed to a single lens — the live WI-4482 regression', () => {
    // maxIdeators:1 ⇒ rosterForBudget slices to the FIRST lens ⇒ every idea is analogical.
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 5 })],
        [1, 2, 3, 4, 5].map((n) => scoutIdea('analogical', n)),
      ),
    );
    const b = bar(r, 'lens-diversity');
    expect(b.status).toBe('fail');
    expect(b.observed).toContain('ROSTER COLLAPSED');
    expect(b.observed).toContain('maxIdeators');
  });

  it('a single idea is UNKNOWN, never a PASS — hasForcedDiversity() alone would false-pass here', () => {
    // The D-004 invariant returns true for <=1 idea ("a single idea cannot collapse"), which is
    // right as an invariant and WRONG as a health bar: it would green precisely when a roster
    // is so broken it emits one idea. The bar must refuse to certify on an empty denominator.
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 1 })], [scoutIdea('analogical', 1)]));
    expect(bar(r, 'lens-diversity').status).toBe('unknown');
    // ...and prove the underlying invariant really would have said "fine" — i.e. this guard is
    // load-bearing, not decorative.
    expect(hasForcedDiversity([{ lens: 'analogical' as CreativeLens }], 2)).toBe(true);
  });

  it('is UNKNOWN on an empty scout partition', () => {
    expect(bar(evaluateProgramSuccess(inputs([], [])), 'lens-diversity').status).toBe('unknown');
  });

  it('judges the NEWEST sample only — stale multi-lens history must not mask a collapsed roster', () => {
    // The live trap: the ledger still holds 4-lens rows from 2026-06-11, but the roster
    // collapsed on 06-25. A lifetime distinct(lens) count reports 4 and PASSES a broken bar.
    // readRoutedIdeas returns newest-first, so the recent sample must dominate.
    const recentCollapsed = Array.from({ length: LENS_DIVERSITY_SAMPLE }, (_, n) => scoutIdea('analogical', n));
    const staleDiverse = [scoutIdea('reframing', 100), scoutIdea('first-principles', 101)];
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 1 })], [...recentCollapsed, ...staleDiverse]));
    expect(bar(r, 'lens-diversity').status).toBe('fail');
  });

  /** A tick carrying EI-13119's per-ideator-slot detail, live regardless of routing outcome. */
  const ideatorTick = (lenses: string[], over: Partial<ScoutTickRecord> = {}): ScoutTickRecord =>
    ranTick({
      detail: {
        cycleId: `c-${Math.random()}`,
        ideators: lenses.map((lens) => ({ lens, ok: true, raw: 1, produced: 1 })),
      },
      ...over,
    });

  it('EI-19899928839197448: sources diversity from LIVE tick detail — routing going silent must not let STALE routed rows mask a live roster collapse', () => {
    // The ledger still holds a diverse 20-row sample from BEFORE routing stopped (routing
    // itself is dead, so these rows never age out of the newest-20 read). Meanwhile the
    // ideators actually running right now have collapsed to a single lens. A sample drawn
    // only from routed rows reports a healthy "4 distinct lenses" here — the live bug.
    const staleDiverseIdeas = [
      scoutIdea('analogical', 1),
      scoutIdea('reframing', 2),
      scoutIdea('first-principles', 3),
      scoutIdea('constraint-removal', 4),
    ];
    const liveCollapsedTicks = [...Array(3)].map(() => ideatorTick(['analogical']));
    const r = evaluateProgramSuccess(inputs(liveCollapsedTicks, staleDiverseIdeas));
    const b = bar(r, 'lens-diversity');
    expect(b.status).toBe('fail');
    expect(b.observed).toContain('ROSTER COLLAPSED');
    // Proves it did NOT fall back to the stale idea sample: no "4 distinct" in the message.
    expect(b.observed).not.toContain('4 distinct');
    expect(b.observed).toContain('live per-ideator tick detail');
  });

  it('the live-tick source still PASSES when the ideators themselves are diverse, even with zero routed ideas this window', () => {
    // Routing produced nothing (every idea got filtered before persisting), but the
    // ideators that actually fired this window span >=2 lenses — that is real, current
    // evidence of health the routed-idea sample alone cannot see.
    const r = evaluateProgramSuccess(inputs([ideatorTick(['analogical', 'reframing'])], []));
    const b = bar(r, 'lens-diversity');
    expect(b.status).toBe('pass');
    expect(b.observed).toContain('live per-ideator tick detail');
  });

  it('EI-19899928839197448: with ZERO routed ideas AND no live tick detail to fall back on, FAILS (not unknown) — a silent pipeline is a broken one', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 0, detail: { cycleId: 'c1' } })], []));
    const b = bar(r, 'lens-diversity');
    expect(b.status).toBe('fail');
    expect(b.observed).toContain('no live per-ideator');
  });
});

describe('evaluateProgramSuccess — verdict roll-up', () => {
  it('only a fully-passing gate closes the program', () => {
    // Two ideas spanning two lenses: a fully-green gate must ALSO satisfy the D-004
    // lens-diversity bar (WI-4482), which a single-lens fixture cannot.
    // WI-5397: and it must now carry a real error-rate DENOMINATOR — one clean cycle
    // can no longer close the gate (that was the manufactured green this guard ends),
    // so the fixture runs MIN_ERROR_RATE_DENOMINATOR clean cycles. The extra cycles
    // route nothing, which keeps the per-cycle reconciliation bar honest (0 claimed,
    // 0 ledger rows) while supplying the denominator.
    const r = evaluateProgramSuccess(
      inputs(
        [
          ranTick({ ideasRouted: 2, detail: { cycleId: 'c1', signalScore: 30 } }),
          ...[...Array(MIN_ERROR_RATE_DENOMINATOR - 1)].map((_, i) =>
            ranTick({ detail: { cycleId: `c-denominator-${i}`, signalScore: 30 } }),
          ),
        ],
        [
          idea({
            ideaId: 'i-analogical',
            lens: 'analogical' as unknown as RoutedIdeaProvenance['lens'],
            addressesPatternRefs: ['rubric:su-agent-behavior/tool-discipline'],
            humanGrade: 5,
            humanFeedback: 'ship it',
            gradedBy: 'owner',
            gradedAt: '2026-07-13T12:00:00.000Z',
            createdBy: 'su-green',
            feedbackRevisions: [
              { revisionRef: 'EI-green-2', createdBy: 'su-green', revisedAt: '2026-07-13T12:01:00.000Z' },
            ],
          }),
          idea({
            ideaId: 'i-reframing',
            lens: 'reframing' as unknown as RoutedIdeaProvenance['lens'],
            addressesPatternRefs: ['rubric:su-agent-behavior/tool-discipline'],
            humanGrade: 4,
            humanFeedback: 'also good',
            gradedBy: 'owner',
            gradedAt: '2026-07-13T12:00:00.000Z',
            createdBy: 'su-green-2',
            feedbackRevisions: [
              { revisionRef: 'EI-green-3', createdBy: 'su-green-2', revisedAt: '2026-07-13T12:01:00.000Z' },
            ],
          }),
        ],
        // P-011: a fully-green gate must ALSO prove the fitness signal is real.
        // Before this bar, this fixture reached 'pass' with a synthetic benchmark —
        // exactly how six live scorecards certified a toy corpus. A green program
        // verdict is now unreachable without a real corpus.
        REAL_CORPUS,
      ),
    );
    expect(r.verdict).toBe('pass');
    expect(r.passed).toBe(7);
    expect(r.failed + r.unknown).toBe(0);
    expect(bar(r, 'fitness-signal-is-real').status).toBe('pass');
  });

  it('CANNOT close the program on a synthetic corpus, however green everything else is', () => {
    // The same otherwise-perfect fixture as above, with the one difference that the gym
    // is optimizing against generated stubs. This is the exact state the stack was in
    // for six consecutive green scorecards.
    const green = () =>
      inputs(
        [
          ranTick({ ideasRouted: 2, detail: { cycleId: 'c1', signalScore: 30 } }),
          ...[...Array(MIN_ERROR_RATE_DENOMINATOR - 1)].map((_, i) =>
            ranTick({ detail: { cycleId: `c-denominator-${i}`, signalScore: 30 } }),
          ),
        ],
        [
          idea({
            ideaId: 'i-analogical',
            lens: 'analogical' as unknown as RoutedIdeaProvenance['lens'],
            addressesPatternRefs: ['rubric:su-agent-behavior/tool-discipline'],
            humanGrade: 5,
            humanFeedback: 'ship it',
            gradedBy: 'owner',
            gradedAt: '2026-07-13T12:00:00.000Z',
            createdBy: 'su-green',
            feedbackRevisions: [
              { revisionRef: 'EI-green-2', createdBy: 'su-green', revisedAt: '2026-07-13T12:01:00.000Z' },
            ],
          }),
          idea({
            ideaId: 'i-reframing',
            lens: 'reframing' as unknown as RoutedIdeaProvenance['lens'],
            addressesPatternRefs: ['rubric:su-agent-behavior/tool-discipline'],
            humanGrade: 4,
            humanFeedback: 'also good',
            gradedBy: 'owner',
            gradedAt: '2026-07-13T12:00:00.000Z',
            createdBy: 'su-green-2',
            feedbackRevisions: [
              { revisionRef: 'EI-green-3', createdBy: 'su-green-2', revisedAt: '2026-07-13T12:01:00.000Z' },
            ],
          }),
        ],
      );

    // All three toy tasks → hard FAIL, and the whole program verdict follows.
    const synthetic = evaluateProgramSuccess({
      ...green(),
      gymCorpus: { realCount: 0, syntheticCount: 3, harnessSlug: 'papercusp' },
    });
    expect(bar(synthetic, 'fitness-signal-is-real').status).toBe('fail');
    expect(bar(synthetic, 'fitness-signal-is-real').observed).toContain('SYNTHETIC FITNESS SIGNAL');
    expect(synthetic.verdict).toBe('fail');

    // Even ONE stub among real tasks fails — a partly-toy corpus cannot be laundered.
    const mixed = evaluateProgramSuccess({
      ...green(),
      gymCorpus: { realCount: 5, syntheticCount: 1, harnessSlug: 'papercusp' },
    });
    expect(bar(mixed, 'fitness-signal-is-real').status).toBe('fail');
    expect(mixed.verdict).toBe('fail');

    // The loader supplies only the active durable generation. Historical task
    // rows remain queryable for old run/score joins but are excluded before this
    // pure evaluator receives its counts.

    // An UNREAD corpus is unknown, never a silent pass.
    const unread = evaluateProgramSuccess(green());
    expect(bar(unread, 'fitness-signal-is-real').status).toBe('unknown');
    expect(unread.verdict).toBe('incomplete');

    // An EMPTY corpus is reported, not graded — nothing is being optimized.
    const empty = evaluateProgramSuccess({
      ...green(),
      gymCorpus: { realCount: 0, syntheticCount: 0, harnessSlug: 'papercusp' },
    });
    expect(bar(empty, 'fitness-signal-is-real').status).toBe('unknown');

    // THE LABEL LOOPHOLE: an all-real corpus that has never been RUN must not pass.
    // Inserting `corpus='real'` rows the runner cannot execute would otherwise green
    // the gate while the gym still learns nothing — the same "certify the description,
    // not the behaviour" mistake one level up.
    const labelledOnly = evaluateProgramSuccess({
      ...green(),
      gymCorpus: { realCount: 4, syntheticCount: 0, realScoredRuns: 0, harnessSlug: 'papercusp' },
    });
    expect(bar(labelledOnly, 'fitness-signal-is-real').status).toBe('unknown');
    expect(bar(labelledOnly, 'fitness-signal-is-real').observed).toContain('declared, not exercised');
    expect(labelledOnly.verdict).toBe('incomplete');

    // Omitting the count entirely is the same as zero — never an implicit pass.
    const noRunField = evaluateProgramSuccess({
      ...green(),
      gymCorpus: { realCount: 4, syntheticCount: 0, harnessSlug: 'papercusp' },
    });
    expect(bar(noRunField, 'fitness-signal-is-real').status).toBe('unknown');

    // Only labels + observed scores together pass.
    const exercised = evaluateProgramSuccess({
      ...green(),
      gymCorpus: { realCount: 4, syntheticCount: 0, realScoredRuns: 12, harnessSlug: 'papercusp' },
    });
    expect(bar(exercised, 'fitness-signal-is-real').status).toBe('pass');
    expect(bar(exercised, 'fitness-signal-is-real').observed).toContain('12 scored run(s)');
  });

  it('a single FAIL dominates any number of passes', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 1, detail: { cycleId: 'c1', signalScore: 0 } })], // score-0 fire → fail
        [
          idea({
            addressesPatternRefs: ['rubric:x/y'],
            humanGrade: 5,
            humanFeedback: 'ok',
            gradedBy: 'owner',
            gradedAt: '2026-07-13T12:00:00.000Z',
            createdBy: 'su-green',
            feedbackRevisions: [
              { revisionRef: 'EI-green-2', createdBy: 'su-green', revisedAt: '2026-07-13T12:01:00.000Z' },
            ],
          }),
        ],
      ),
    );
    expect(r.verdict).toBe('fail');
    expect(r.failed).toBe(1);
  });

  it('unknowns alone are INCOMPLETE — never a silent pass', () => {
    const r = evaluateProgramSuccess(inputs([], []));
    expect(r.verdict).toBe('incomplete');
    expect(r.failed).toBe(0);
    // Every bar is unknown on an empty window — nothing certifies. That now includes
    // fitness-signal-is-real (P-011): an unread corpus is unproven, not fine.
    expect(r.unknown).toBe(7);
    expect(bar(r, 'fitness-signal-is-real').status).toBe('unknown');
  });
});

describe('isCapacityError — the no-capacity classifier (scheduler)', () => {
  it('classifies ATTESTED admission denials as capacity, not failure (WI-5391: via stamp required)', () => {
    expect(isCapacityError({ admissionDenial: { reason: 'rate-limit-blocked', via: 'governor' } })).toBe(true);
    expect(isCapacityError({ admissionDenial: { reason: 'provider-429', via: 'http-429' } })).toBe(true);
    expect(isCapacityError({ admissionDenial: { reason: 'no-free-slot', via: 'governor', freeSlots: 0 } })).toBe(false);
    // An UNATTESTED denial (no via) is evidence-free and fails closed — stays an error.
    expect(isCapacityError({ admissionDenial: { reason: 'provider-429' } })).toBe(false);
    // Provider prose alone is intentionally not authoritative.
    expect(isCapacityError('rate-limit pause exceeds maxWait')).toBe(false);
  });

  it('does NOT swallow genuine failures — the whole point of keeping it narrow', () => {
    // A timeout is PLAUSIBLY capacity-induced, but that link is unproven: mis-filing a real
    // hang as "pool busy" would hide a defect, which is this classification's own failure mode.
    expect(isCapacityError('Scout ideator analogical timed out after 180000ms')).toBe(false);
    expect(isCapacityError('Scout cycle timed out after 600000ms during phase critique')).toBe(false);
    expect(isCapacityError('401 unauthorized: token expired')).toBe(false);
    expect(isCapacityError('ECONNREFUSED 127.0.0.1:8788')).toBe(false);
    expect(isCapacityError('TypeError: cannot read property of undefined')).toBe(false);
  });

  it('a starved-but-healthy loop reads as PASS on the error bar, with the pressure still visible', () => {
    const ticks: ScoutTickRecord[] = [
      ...[...Array(10)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } })),
      ...[...Array(9)].map((): ScoutTickRecord => ({ status: 'gated', gate: 'no-capacity' })),
    ];
    const r = evaluateProgramSuccess(inputs(ticks, []));
    const errBar = bar(r, 'cycle-error-rate');
    // Pre-fix these 9 were status:'error' => 9/19 = 47% => FAIL. They are a starved pool, not breakage.
    expect(errBar.status).toBe('pass');
    // ...but the starvation must NOT vanish — it is reported, and actionable.
    expect(errBar.observed).toContain('9 cycle(s) withheld by the no-capacity gate');
  });
});

describe('evaluateProgramSuccess — outcome tally excludes paused-rail ideas from win-rate denominators (scout-su-ideate-pipeline-gaps-2026-10-08 P-002 / R-3)', () => {
  const routed = [
    idea({ ideaId: 'w', rail: 'improvement', routedRef: 'wi:1', outcome: 'won' }),
    idea({ ideaId: 'l', rail: 'improvement', routedRef: 'wi:2', outcome: 'lost' }),
    idea({ ideaId: 'g-pending', rail: 'gym', routedRef: 'gym:SP-x-1', outcome: 'pending' }),
    idea({ ideaId: 'g-legacy', rail: 'gym', routedRef: 'gym:SP-001', outcome: 'unresolvable' }),
  ];

  it('a gym-rail idea is NOT counted in the win-rate denominator while the gym is paused', () => {
    const r = evaluateProgramSuccess({ ...inputs([], routed), pausedRails: ['gym'] });
    expect(r.outcomes.pausedRails).toEqual(['gym']);
    expect(r.outcomes.scout).toEqual({ routed: 2, won: 1, lost: 1, pending: 0, unresolvable: 2, decided: 2, winRate: 0.5 });
    expect(r.outcomes.all.routed).toBe(2);
  });

  it('CONTROL: with no paused rail, the undecided gym idea is pending (cached unresolvable stays excluded)', () => {
    const r = evaluateProgramSuccess(inputs([], routed));
    expect(r.outcomes.scout).toEqual({ routed: 3, won: 1, lost: 1, pending: 1, unresolvable: 1, decided: 2, winRate: 0.5 });
  });
});

describe('evaluateProgramSuccess — agent-review is reported in its own bucket, never as ideation (scout-su-ideate-pipeline-gaps-2026-10-08 P-008 / R-18)', () => {
  const ideation = [
    idea({ ideaId: 'w', rail: 'improvement', routedRef: 'wi:1', outcome: 'won', origin: 'scout' }),
    idea({ ideaId: 'l', rail: 'improvement', routedRef: 'wi:2', outcome: 'lost', origin: 'su-ideate' }),
  ];
  const review = [
    idea({ ideaId: 'ar-won', rail: 'improvement', routedRef: 'wi:3', outcome: 'won', origin: 'agent-review', humanGrade: 5, gradedBy: 'su-x' }),
    idea({ ideaId: 'ar-won-2', rail: 'improvement', routedRef: 'wi:4', outcome: 'won', origin: 'agent-review' }),
    idea({ ideaId: 'ar-null', rail: 'improvement', routedRef: 'wi:5', origin: 'agent-review', humanGrade: 2, gradedBy: 'su-x' }),
  ];

  it('agent-review rows land in outcomes.agentReview and leave the ideation tally untouched', () => {
    const r = evaluateProgramSuccess({ ...inputs([], ideation), agentReviewIdeas: review });
    expect(r.outcomes.all).toEqual({ routed: 2, won: 1, lost: 1, pending: 0, unresolvable: 0, decided: 2, winRate: 0.5 });
    expect(r.outcomes.agentReview).toEqual({ routed: 3, won: 2, lost: 0, pending: 1, unresolvable: 0, decided: 2, winRate: 1, graded: 2 });
    expect(r.window.routedIdeas).toBe(2);
  });

  it('an agent-review row that leaks into `ideas` is moved to its bucket, not counted as ideation (falsifier)', () => {
    const r = evaluateProgramSuccess({ ...inputs([], ideation), ideas: [...ideation, ...review] });
    // Without the partition, the two agent-review wins would lift the ideation win rate to 0.75.
    expect(r.outcomes.all.winRate).toBe(0.5);
    expect(r.outcomes.all.routed).toBe(2);
    expect(r.outcomes.agentReview.routed).toBe(3);
    expect(r.window.routedIdeas).toBe(2);
    // The ideation grader bar must not count agent-review grades as ideation grading.
    expect(bar(r, 'grader-feedback-revised').observed).toContain('0 of 2 routed ideas are graded');
  });

  it('CONTROL: no agent-review input ⇒ an empty agent-review bucket; origin-less (in-memory) provenance stays ideation', () => {
    const r = evaluateProgramSuccess(inputs([], [idea({ ideaId: 'mem', rail: 'improvement', routedRef: 'wi:9', outcome: 'won' })]));
    expect(r.outcomes.all.routed).toBe(1);
    expect(r.outcomes.agentReview).toEqual({ routed: 0, won: 0, lost: 0, pending: 0, unresolvable: 0, decided: 0, winRate: null, graded: 0 });
  });
});
