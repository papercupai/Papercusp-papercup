import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  computeWorkOnEverythingRollup,
  evaluateScorecardInstrumentContract,
  validateWorkOnEverythingEvidenceEnvelope,
  validateRubricRatingContracts,
  GOAL_BEHAVIOR_GRADING_RUBRIC,
  WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC,
  resolveScorecardInstrumentSnapshots,
  type ScorecardRow,
} from './scorecards';
import { asStructuredObservation, type ObservationRatingEntry, type ObservationRatings } from './harness/improvements/observation-types';
import type { Rubric } from './rubrics';

const rating = (overrides: Partial<ObservationRatingEntry> = {}): ObservationRatingEntry => ({
  rating: 'pass',
  evidence: 'Measured by the named probe.',
  evidenceRef: 'tool:scorecards:test',
  evidenceKind: 'tool',
  attribution: 'subject',
  ...overrides,
});

describe('Work on everything scorecard contract', () => {
  it('grades the active rubric population rather than a frozen runbook count', () => {
    const runbook = readFileSync(new URL(
      '../../../apps/operator-docs/src/content/docs/agent-insights/work-on-everything-stewardship-health-grading-runbook.mdx',
      import.meta.url,
    ), 'utf8');
    const contract = runbook.split('## Scorecard contract')[1]?.split('\n## ')[0];
    expect(contract).toContain('every criterion key returned by `rubrics:get` for the active revision');
    expect(contract).not.toMatch(/File all \d+ criterion keys/);
    expect(contract).toContain('absent evidence must remain explicitly unknown');
  });

  it.each(['rubric-coverage-stewardship', 'rubric-quality-stewardship', 'grading-correction-closure'])(
    'keeps omitted %s unassessable even when the other stewardship duties pass', key => {
      const keys = ['rubric-coverage-stewardship', 'rubric-quality-stewardship', 'grading-correction-closure'];
      const passing = Object.fromEntries(keys.map(k => [k, rating()])) as ObservationRatings;
      expect(computeWorkOnEverythingRollup(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, passing, keys))
        .toMatchObject({ verdict: 'pass', coverage: { sufficient: true } });
      const omitted = { ...passing };
      delete omitted[key];
      expect(computeWorkOnEverythingRollup(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, omitted, keys))
        .toMatchObject({ verdict: 'unassessable', criticalUnknowns: [key], coverage: { sufficient: false } });
    },
  );

  it.each(['rubric-coverage-stewardship', 'rubric-quality-stewardship', 'grading-correction-closure'])(
    'cannot average away absent or failed %s stewardship', key => {
      expect(computeWorkOnEverythingRollup(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC,
        { [key]: rating({ rating: 'fail' }) }, [key]))
        .toMatchObject({ verdict: 'fail', criticalFailures: [key] });
      expect(computeWorkOnEverythingRollup(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC,
        { [key]: rating({ rating: 'unknown' }) }, [key]))
        .toMatchObject({ verdict: 'unassessable', criticalUnknowns: [key] });
    },
  );
  it('requires replayable evidence and explicit attribution', () => {
    expect(() =>
      validateWorkOnEverythingEvidenceEnvelope(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, {
        'goal-mode-foundation': {
          rating: 'pass',
          evidence: 'narrative only',
        },
      }),
    ).toThrow(/evidenceRef/);
  });

  it('requires a positive control for explicit absence claims', () => {
    expect(() =>
      validateWorkOnEverythingEvidenceEnvelope(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, {
        'plan-fleet-materialization': rating({ absenceClaim: true }),
      }),
    ).toThrow(/positiveControlRef/);
  });

  it('keeps unknown measurement gaps from becoming subject failures', () => {
    expect(() =>
      validateWorkOnEverythingEvidenceEnvelope(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, {
        'goal-mode-foundation': rating({
          rating: 'unknown',
          attribution: 'system',
          unknownReason: 'retention-gap',
          nextEvidenceAction: 'Re-run after the retention window is extended.',
        }),
      }),
    ).not.toThrow();
  });

  it('rolls up critical failure before partial or pass ratings', () => {
    const keys = [
      'goal-mode-foundation',
      'frontier-scope-sovereignty',
      'delegated-execution-and-drain-health',
      'claim-flow-and-completion-integrity',
      'retired-tier-nonresurrection',
      'plan-fleet-materialization',
      'owner-steering-and-reporting',
    ];
    const ratings: ObservationRatings = Object.fromEntries(keys.map((key) => [key, rating()]));
    ratings['frontier-scope-sovereignty'] = rating({ rating: 'fail' });
    expect(
      computeWorkOnEverythingRollup(
        WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC,
        ratings,
        keys,
      ),
    ).toMatchObject({
      verdict: 'fail',
      criticalFailures: ['frontier-scope-sovereignty'],
      coverage: { sufficient: true },
    });
  });

  it('cannot hide an eligible plan with no materialized fleet behind passing stewardship criteria', () => {
    const keys = [
      'goal-mode-foundation',
      'frontier-scope-sovereignty',
      'delegated-execution-and-drain-health',
      'claim-flow-and-completion-integrity',
      'retired-tier-nonresurrection',
      'plan-fleet-materialization',
      'owner-steering-and-reporting',
    ];
    const passing = Object.fromEntries(keys.map((key) => [key, rating()])) as ObservationRatings;
    expect(computeWorkOnEverythingRollup(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, passing, keys))
      .toMatchObject({ verdict: 'pass', criticalFailures: [], coverage: { sufficient: true } });

    const eligibleButUnplaced: ObservationRatings = {
      ...passing,
      'plan-fleet-materialization': rating({
        rating: 'fail',
        evidence: 'An eligible non-idle worklist head had no plan fleet, blocker, or terminal disposition.',
      }),
    };
    expect(computeWorkOnEverythingRollup(
      WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC,
      eligibleButUnplaced,
      keys,
    )).toMatchObject({
      verdict: 'fail',
      criticalFailures: ['plan-fleet-materialization'],
      coverage: { sufficient: true },
    });
  });

  it('reports insufficient critical coverage as unassessable', () => {
    const ratings = {
      'goal-mode-foundation': rating(),
      'frontier-scope-sovereignty': rating({
        rating: 'unknown',
        attribution: 'instrument',
        unknownReason: 'instrument-unavailable',
        nextEvidenceAction: 'Run the registered frontier probe.',
      }),
    };
    const rollup = computeWorkOnEverythingRollup(
      WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC,
      ratings,
      [
        'goal-mode-foundation',
        'frontier-scope-sovereignty',
        'delegated-execution-and-drain-health',
      ],
    );
    expect(rollup?.verdict).toBe('unassessable');
    expect(rollup?.coverage.sufficient).toBe(false);
  });

  it.each(['rolling-budget-circuit-and-capacity', 'owner-steering-and-reporting'])(
    '%s is critical rather than averaged away',
    (key) => {
      expect(computeWorkOnEverythingRollup(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, {
        [key]: rating({ rating: 'unknown' }),
      }, [key])?.verdict).toBe('unassessable');
    },
  );

  it.each(['steering-through-claim-rails', 'frontier-scope-sovereignty'])(
    'retains a severe %s violation despite passing stewardship criteria', key => {
      const keys = ['goal-mode-foundation', 'frontier-scope-sovereignty',
        'steering-through-claim-rails', 'delegated-execution-and-drain-health',
        'claim-flow-and-completion-integrity', 'retired-tier-nonresurrection',
        'plan-fleet-materialization', 'owner-steering-and-reporting'];
      const passing = Object.fromEntries(keys.map(k => [k, rating()])) as ObservationRatings;
      expect(computeWorkOnEverythingRollup(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, passing, keys)?.verdict)
        .toBe('pass');
      const breached = { ...passing, [key]: rating({ rating: 'severe' }) };
      expect(computeWorkOnEverythingRollup(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, breached, keys)?.verdict)
        .toBe('severe');
    },
  );

  it('does not pass an empty population or average away a non-critical severe violation', () => {
    expect(computeWorkOnEverythingRollup(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, {}, [])?.verdict)
      .toBe('unassessable');
    expect(computeWorkOnEverythingRollup(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, {
      'blender-feedback-and-disposition': rating({ rating: 'severe' }),
    }, ['blender-feedback-and-disposition'])?.verdict).toBe('severe');
  });

  it.each(['instrument', 'environment'] as const)('rejects a subject downgrade from %s limitations', (attribution) => {
    expect(() => validateWorkOnEverythingEvidenceEnvelope(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, {
      key: rating({ rating: 'partial', attribution }),
    })).toThrow(/measurement limitation/);
  });

  // P-002: a deployed-generation mismatch is a measurement limit of the environment,
  // not subject conduct. It must be recordable as an unknown gap, keep its enumerated
  // reason through the canonical reader, and never be accepted as a downgrade.
  it('keeps a generation mismatch an unknown environment gap, never a subject downgrade', () => {
    const gap = rating({
      rating: 'unknown',
      attribution: 'environment',
      unknownReason: 'generation-mismatch',
      nextEvidenceAction: 'Re-grade after the running operator serves the graded generation.',
    });
    expect(() =>
      validateWorkOnEverythingEvidenceEnvelope(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, { key: gap }),
    ).not.toThrow();
    expect(
      asStructuredObservation({ rubricRef: WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, ratings: { key: gap } })
        ?.ratings?.key?.unknownReason,
    ).toBe('generation-mismatch');
    expect(() =>
      validateWorkOnEverythingEvidenceEnvelope(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, {
        key: rating({ rating: 'fail', attribution: 'environment', evidence: 'deployed generation differs from the tree' }),
      }),
    ).toThrow(/measurement limitation/);
  });

  it('preserves evidence metadata through the canonical observation reader', () => {
    const ratings = { key: rating({
      rating: 'unknown',
      attribution: 'instrument',
      unknownReason: 'retention-gap',
      nextEvidenceAction: 'Read the archived source record.',
      absenceClaim: true,
      positiveControlRef: 'test-run:positive',
    }) };
    expect(asStructuredObservation({ rubricRef: WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, ratings })?.ratings)
      .toEqual(ratings);
    expect(asStructuredObservation({ rubricRef: 'legacy', ratings: { key: { rating: 'pass', evidence: 'old' } } })?.ratings)
      .toEqual({ key: { rating: 'pass', evidence: 'old' } });
  });
});

// AUTO-BAR-R-3 (goal-agent-behavior-feedback-2026-09-06): the emit and evaluate doors share
// validateRubricRatingContracts, so these cases pin what both refuse.
describe('GOAL behavior-grading unknown disclosure contract', () => {
  it.each(['unknown', 'idle', ' Unknown '])('refuses a %s rating whose reason is only prose', (value) => {
    expect(() =>
      validateRubricRatingContracts(GOAL_BEHAVIOR_GRADING_RUBRIC, {
        'kickoff-portfolio-read': { rating: value, evidence: 'Not exercised in this window.' },
      }),
    ).toThrow(/'kickoff-portfolio-read'.*require unknownReason \(idle \| not-exercised/);
  });

  it('names every undisclosed criterion in one refusal and ignores conduct ratings', () => {
    expect(() =>
      validateRubricRatingContracts(GOAL_BEHAVIOR_GRADING_RUBRIC, {
        a: { rating: 'unknown', evidence: 'x', unknownReason: '  ' as never },
        b: { rating: 'idle', evidence: 'y' },
        c: { rating: 'pass', evidence: 'observed at turn 4' },
      }),
    ).toThrow(/'a', 'b' require/);
  });

  it('accepts a structured reason, and leaves other rubrics to their own contracts', () => {
    expect(() =>
      validateRubricRatingContracts(GOAL_BEHAVIOR_GRADING_RUBRIC, {
        a: { rating: 'unknown', evidence: 'No fleet shipped.', unknownReason: 'not-exercised' },
        b: { rating: 'pass', evidence: 'observed at turn 4' },
      }),
    ).not.toThrow();
    expect(() =>
      validateRubricRatingContracts('some-other-rubric', { a: { rating: 'unknown', evidence: 'prose' } }),
    ).not.toThrow();
  });

  it('still runs the Work on everything envelope through the shared entry point', () => {
    expect(() =>
      validateRubricRatingContracts(WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC, {
        'goal-mode-foundation': { rating: 'pass', evidence: 'narrative only' },
      }),
    ).toThrow(/evidenceRef/);
  });
});

describe('registered scorecard instrument provenance', () => {
  const subject = {
    kind: 'agent-run' as const, ref: 'su-subject',
    windowStart: '2026-09-19T00:00:00Z', windowEnd: '2026-09-20T00:00:00Z',
  };
  const rubric = {
    rubricId: WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC,
    criteria: [{ key: 'goal-mode-foundation', instrumentKey: 'woe.goal-mode-base-scorecard' }],
  } as Rubric;
  const base = { rubricId: 'goal-mode-e2e', criteriaHash: 'base-hash' } as Rubric;
  const card: ScorecardRow = {
    issueId: 'EI-base', subject, rubricResolved: true, criteriaHash: 'base-hash',
    createdAt: '2026-09-20T00:30:00Z', createdBy: 'independent-grader', rubricRef: 'goal-mode-e2e',
    nKeys: 1, score10: 8, linkedItems: [],
    missingKeys: [], extraKeys: [], ratings: { alpha: rating() }, rubricRevision: 42,
    gradingAudit: { state: 'passed', metaRubricRef: 'grading-integrity', stampedAt: subject.windowEnd },
    synthesized: false,
  };
  const now = () => Date.parse('2026-09-20T01:00:00Z');
  const read = (cards: ScorecardRow[]) => ({
    list: vi.fn(async () => ({ rows: cards, hasMore: false })),
    rubric: vi.fn(async () => base),
    now,
  });

  it('overwrites a forged snapshot using the independently read exact base card', async () => {
    const deps = read([card]);
    const snapshots = await resolveScorecardInstrumentSnapshots({
      rubric, subject,
      supplied: { 'woe.goal-mode-base-scorecard': { verdict: 'fail', measuredAt: 'bad', provenance: 'platform-computed' } },
    }, deps);
    expect(deps.list).toHaveBeenCalledWith(expect.objectContaining({ subjectRef: 'su-subject' }));
    expect(snapshots?.['woe.goal-mode-base-scorecard']).toMatchObject({
      verdict: 'pass', provenance: 'platform-computed', evidenceRef: 'EI-base',
      value: { baseCard: 'EI-base', rubricRevision: 42, ratings: card.ratings },
    });
  });

  // P-006 / R-8: a stored platform-computed snapshot must say WHICH resolver produced
  // it, so a later reader can tell resolver output from a caller assertion.
  it('stamps the resolver identity on every platform-computed snapshot', async () => {
    const measured = await resolveScorecardInstrumentSnapshots({ rubric, subject }, read([card]));
    expect(measured?.['woe.goal-mode-base-scorecard']).toMatchObject({
      provenance: 'platform-computed',
      value: { resolver: 'woe.goal-mode-base-scorecard', resolverVersion: 2 },
    });
    const unknown = await resolveScorecardInstrumentSnapshots({ rubric, subject }, read([]));
    expect(unknown?.['woe.goal-mode-base-scorecard']).toMatchObject({
      verdict: 'unknown',
      provenance: 'platform-computed',
      value: { resolver: 'woe.goal-mode-base-scorecard', resolverVersion: 2 },
    });
  });

  it.each([
    { subject: { ...subject, ref: 'other' } },
    { subject: { ...subject, windowEnd: '2026-09-19T23:00:00Z' } },
    { criteriaHash: 'obsolete-hash' },
    { missingKeys: ['alpha'] },
    { provisional: { violatableKeys: ['alpha'], stampedAt: subject.windowEnd } },
    { gradingAudit: { state: 'pending' } },
  ])('rejects a wrong-scope, stale, incomplete or unsettled base card (%j)', async (override) => {
    const snapshots = await resolveScorecardInstrumentSnapshots(
      { rubric, subject }, read([{ ...card, ...override } as unknown as ScorecardRow]),
    );
    expect(snapshots?.['woe.goal-mode-base-scorecard'].verdict).toBe('unknown');
  });

  // v2 (EI-24770558745369103): behavior that did not occur in the window must not block a
  // passing foundation, but nothing else may be waved through.
  it.each([
    {
      name: 'passes with not-exercised and idle unknowns beside exercised passes',
      ratings: {
        alpha: rating(),
        beta: rating({ rating: 'unknown', unknownReason: 'not-exercised' }),
        gamma: rating({ rating: 'unknown', unknownReason: 'idle' }),
      },
      verdict: 'pass',
    },
    {
      name: 'stays unknown for a reasonless (legacy) unknown',
      ratings: { alpha: rating(), beta: rating({ rating: 'unknown' }) },
      verdict: 'unknown',
    },
    {
      name: 'stays unknown when the unknown was an unavailable instrument',
      ratings: { alpha: rating(), beta: rating({ rating: 'unknown', unknownReason: 'instrument-unavailable' }) },
      verdict: 'unknown',
    },
    {
      name: 'stays unknown for a partial base rating',
      ratings: { alpha: rating(), beta: rating({ rating: 'partial' }) },
      verdict: 'unknown',
    },
    {
      name: 'stays unknown when nothing was exercised',
      ratings: { beta: rating({ rating: 'unknown', unknownReason: 'not-exercised' }) },
      verdict: 'unknown',
    },
    {
      name: 'fails on any failing base rating even beside not-exercised unknowns',
      ratings: {
        alpha: rating({ rating: 'fail' }),
        beta: rating({ rating: 'unknown', unknownReason: 'not-exercised' }),
      },
      verdict: 'fail',
    },
  ])('v2 base verdict: $name', async ({ ratings, verdict }) => {
    const snapshots = await resolveScorecardInstrumentSnapshots(
      { rubric, subject }, read([{ ...card, ratings } as ScorecardRow]),
    );
    expect(snapshots?.['woe.goal-mode-base-scorecard'].verdict).toBe(verdict);
  });

  it('does not misreport an unavailable instrument as a subject failure', async () => {
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject }, {
      ...read([]), list: vi.fn(async () => { throw new Error('source unavailable'); }),
    });
    expect(snapshots?.['woe.goal-mode-base-scorecard']).toMatchObject({
      verdict: 'unknown', value: { reason: expect.stringContaining('source unavailable') },
    });
  });

  it('cannot mint platform provenance for an unregistered caller snapshot', async () => {
    const snapshots = await resolveScorecardInstrumentSnapshots({
      rubric: { ...rubric, criteria: [] },
      supplied: { custom: { verdict: 'pass', measuredAt: subject.windowEnd, provenance: 'platform-computed' } },
    }, read([]));
    expect(snapshots?.custom.provenance).toBe('self-reported');
  });

  // WI-10005422: WOE rev 39 fails goal-mode-foundation when a critical unknown is left
  // unowned, even with no failing base rating. The resolver cannot see ownership, so it
  // reads 'unknown'. An instrument that cannot decide must not refuse that rubric-faithful
  // fail, while a claimed pass still needs the measurement.
  it.each([
    { claimed: 'fail', measured: 'unknown', mismatch: false },
    { claimed: 'severe', measured: 'unknown', mismatch: false },
    { claimed: 'fail', measured: 'fail', mismatch: false },
    { claimed: 'pass', measured: 'unknown', mismatch: true },
    { claimed: 'exemplary', measured: 'unknown', mismatch: true },
    { claimed: 'fail', measured: 'pass', mismatch: true },
    { claimed: 'pass', measured: 'fail', mismatch: true },
  ] as const)('claimed $claimed against a measured $measured is a mismatch: $mismatch', ({ claimed, measured, mismatch }) => {
    const out = evaluateScorecardInstrumentContract({
      rubric,
      ratings: { 'goal-mode-foundation': rating({ rating: claimed }) },
      instrumentSnapshots: {
        'woe.goal-mode-base-scorecard': {
          verdict: measured, measuredAt: '2026-09-20T00:59:00Z', provenance: 'platform-computed',
        },
      },
      nowMs: now(),
    });
    expect(out.verdictMismatches).toEqual(mismatch ? ['woe.goal-mode-base-scorecard'] : []);
  });
});
