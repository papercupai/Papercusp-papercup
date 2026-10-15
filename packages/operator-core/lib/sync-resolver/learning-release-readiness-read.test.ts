/**
 * learning.releaseReadiness read (learning-tab-alignment-2026-07-13 P-001).
 *
 * The contract under test: (a) the snapshot is assembled from the SAME readers the MCP
 * tools serve (D-001 — the mocks stand in for buildProgramSuccessReport / getRubric /
 * listScorecards, and nothing else is consulted); (b) every leg is fail-soft — a broken
 * ledger read must not blank the rubric line, a broken scorecard read must not hide the
 * rubric's governance state, and nothing throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildProgramSuccessReport = vi.fn();
vi.mock('../scout/success-metrics', () => ({
  buildProgramSuccessReport: (...a: unknown[]) => buildProgramSuccessReport(...a),
}));
const getRubric = vi.fn();
vi.mock('../rubrics', () => ({
  getRubric: (...a: unknown[]) => getRubric(...a),
}));
const listScorecardPage = vi.fn();
vi.mock('../scorecards', () => ({
  listScorecardPage: (...a: unknown[]) => listScorecardPage(...a),
}));
// NOTE: `../harness/improvements/observation-types` is deliberately NOT mocked. The
// admission policy under test is the REAL one (EI-21949865560276745) — the point of the
// fix is that this reader inherits the trend's policy rather than re-deriving it, and a
// stubbed predicate would prove the opposite: the guards below would pass just as well
// against a local copy that had already drifted. It is a pure predicate in a leaf
// module, so using the real one costs nothing.

import {
  deriveReleaseReadinessPassConfidence,
  readReleaseReadiness,
  RELEASE_READINESS_PASS_CONFIDENCE_POLICY,
  RELEASE_READINESS_RUBRIC_ID,
} from './learning-release-readiness-read';

const sampleReport = {
  criteria: [
    { key: 'lens-diversity', bar: '>=2 lenses', status: 'pass', observed: '2 lenses' },
    { key: 'cycle-error-rate', bar: '<5%', status: 'fail', observed: '13.8%' },
  ],
  passed: 1,
  failed: 1,
  unknown: 0,
  verdict: 'fail',
  window: { ticks: 500, ranCycles: 351, routedIdeas: 167, ledgerTruncated: false },
};

const sampleRubric = {
  rubricId: RELEASE_READINESS_RUBRIC_ID,
  workspaceId: 'w',
  characteristic: 'release-readiness',
  title: 'Blender release readiness',
  description: 'the gate',
  criteria: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
  ratingScale: ['pass', 'at-risk', 'fail', 'unknown'],
  methodRef: null,
  status: 'proposed',
  createdBy: 'su-x',
  proposedBy: 'su-f69a7',
  ratifiedBy: null,
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T02:00:00.000Z',
};

describe('readReleaseReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildProgramSuccessReport.mockResolvedValue(sampleReport);
    getRubric.mockResolvedValue(sampleRubric);
    listScorecardPage.mockResolvedValue({
      rows: [
        { createdAt: '2026-07-12T10:00:00.000Z', score10: 4 },
        { createdAt: '2026-07-13T01:00:00.000Z', score10: 7 }, // newest — wins latest*
      ],
      hasMore: false,
    });
  });

  it('assembles the report + rubric governance from the tool readers (D-001)', async () => {
    const snap = await readReleaseReadiness();
    expect(snap.report).toEqual(sampleReport);
    expect(snap.rubric).toMatchObject({
      rubricId: RELEASE_READINESS_RUBRIC_ID,
      status: 'proposed',
      criteriaCount: 3,
      proposedBy: 'su-f69a7',
      ratifiedBy: null,
      scorecardCount: 2,
      latestScorecardAt: '2026-07-13T01:00:00.000Z',
      latestScore10: 7,
    });
    expect(snap.errors).toBeUndefined();
    expect(getRubric).toHaveBeenCalledWith(RELEASE_READINESS_RUBRIC_ID);
    expect(listScorecardPage).toHaveBeenCalledWith({ rubricRef: RELEASE_READINESS_RUBRIC_ID, limit: 100 });
  });

  it('a broken ledger read does not blank the rubric line (fail-soft per leg)', async () => {
    buildProgramSuccessReport.mockRejectedValue(new Error('pg down'));
    const snap = await readReleaseReadiness();
    expect(snap.report).toBeNull();
    expect(snap.rubric?.rubricId).toBe(RELEASE_READINESS_RUBRIC_ID);
    expect(snap.errors?.some((e) => e.includes('success-metrics') && e.includes('pg down'))).toBe(true);
  });

  it('no rubric proposed yet → rubric null, NOT an error (an honest missing state)', async () => {
    getRubric.mockResolvedValue(null);
    const snap = await readReleaseReadiness();
    expect(snap.rubric).toBeNull();
    expect(snap.report).toEqual(sampleReport);
    expect(snap.errors).toBeUndefined();
  });

  it('a broken scorecard read degrades to governance-only — the rubric status must not vanish', async () => {
    listScorecardPage.mockRejectedValue(new Error('scorecards table sad'));
    const snap = await readReleaseReadiness();
    expect(snap.rubric).toMatchObject({
      status: 'proposed',
      scorecardCount: 0,
      latestScorecardAt: null,
      latestScore10: null,
      // null EVIDENCE, not a zeroed-out evidence block: "we could not read the
      // history" and "we read it and there is none" are different answers, and a
      // fabricated `sampleCount: 0` would render as the latter.
      scoreEvidence: null,
    });
  });

  it('never throws even when every leg fails', async () => {
    buildProgramSuccessReport.mockRejectedValue(new Error('a'));
    getRubric.mockRejectedValue(new Error('b'));
    const snap = await readReleaseReadiness();
    expect(snap.report).toBeNull();
    expect(snap.rubric).toBeNull();
    expect(snap.errors).toHaveLength(2);
    expect(snap.readAt).toBeTruthy();
  });

  /**
   * EI-20801200386596605 (sibling of WI-39813) — fail-soft covered a leg that
   * THROWS and nothing at all for a leg that HANGS. `Promise.all` waits for the
   * slowest, so one wedged reader blew the ~10s resolver timeout and 500'd the
   * whole strip — which could not then show the degraded state the `.catch`es
   * above so carefully computed, because the response itself never shipped.
   */
  describe('a hung leg degrades instead of hanging the strip (EI-20801200386596605)', () => {
    /** Never settles — a wedged reader, not a failing one. */
    const hang = () => new Promise<never>(() => {});

    it('a hanging ledger read degrades that leg while the rubric line still serves', async () => {
      buildProgramSuccessReport.mockImplementation(hang);
      const snap = await readReleaseReadiness({ budgetMs: 40 });

      expect(snap.report).toBeNull();
      // The whole point: the strip still SERVES. Before the budget this returned
      // nothing at all — the hung leg took the entire read down with it.
      expect(snap.rubric?.rubricId).toBe(RELEASE_READINESS_RUBRIC_ID);
      expect(snap.errors?.some((e) => e.includes('success-metrics'))).toBe(true);
    });

    // Without this control the guard above would pass just as happily against a
    // read that degrades unconditionally — "always degraded" satisfies every
    // assertion that only ever inspects the failing case.
    it('a healthy read under the SAME budget degrades nothing — the guard discriminates on the hang, not on the budget', async () => {
      const snap = await readReleaseReadiness({ budgetMs: 40 });

      expect(snap.errors).toBeUndefined();
      expect(snap.report).toEqual(sampleReport);
      expect(snap.rubric?.rubricId).toBe(RELEASE_READINESS_RUBRIC_ID);
    });

    /**
     * FALSIFIABILITY CONTROL for the two guards above. The read builds its
     * deadline internally, so the lever is the one knob it exposes: a budget
     * outside the test's patience is observationally identical to no bound at
     * all, and under it the SAME hang takes the whole strip down — the defect
     * reproduced on demand instead of asserted. "Never settles" is the
     * condition under test, so it has to be an assertable outcome rather than
     * a test timeout.
     */
    const PENDING = Symbol('still-pending');
    const settledWithin = <T>(p: Promise<T>, ms: number): Promise<T | typeof PENDING> =>
      Promise.race([
        p,
        new Promise<typeof PENDING>((resolve) => {
          const t = setTimeout(() => resolve(PENDING), ms);
          (t as unknown as { unref?: () => void }).unref?.();
        }),
      ]);

    it('CONTROL: with a budget that cannot fire, the same hang takes the whole strip down — so the guards above are falsifiable', async () => {
      buildProgramSuccessReport.mockImplementation(hang);

      expect(await settledWithin(readReleaseReadiness({ budgetMs: 10 * 60_000 }), 150)).toBe(PENDING);

      // Calibration: the identical call under a REAL budget settles, degraded.
      const bounded = await settledWithin(readReleaseReadiness({ budgetMs: 40 }), 2000);
      expect(bounded).not.toBe(PENDING);
      expect(bounded !== PENDING && bounded.report).toBeNull();
    });
  });

  /**
   * EI-21949865560276745 — the strip rendered `N scorecards · latest X/10`, and both
   * halves overstated confidence in the same silent direction.
   *
   * The score was simply the newest row `listScorecards` returned. That list includes
   * the two classes the TREND refuses to count as settled evidence — PROVISIONAL
   * working notes (P-008) and audit-PENDING gradings (P-013) — so a mid-run working
   * note could BE the release score. Nothing on the strip distinguished it: a
   * one-sample score and a hundred-sample score render identically, which is exactly
   * how "a lucky pass becomes permanent evidence".
   *
   * The fix is disclosure, not a new judgement — the strip still shows the score, and
   * now shows the population, window, freshness and truncation behind it.
   */
  describe('the score rests on ADMISSIBLE evidence only (EI-21949865560276745)', () => {
    const settled = (createdAt: string, score10: number) => ({ createdAt, score10 });
    const provisional = (createdAt: string, score10: number) => ({
      createdAt,
      score10,
      provisional: { violatableKeys: ['never-implements'], stampedAt: createdAt },
    });
    const auditPending = (createdAt: string, score10: number) => ({
      createdAt,
      score10,
      gradingAudit: { state: 'pending' },
    });

    it('a PROVISIONAL newest card does not become the release score', async () => {
      listScorecardPage.mockResolvedValue({
        rows: [provisional('2026-07-14T00:00:00.000Z', 10), settled('2026-07-13T01:00:00.000Z', 7)],
        hasMore: false,
      });

      const snap = await readReleaseReadiness();

      // 10 is the working note. 7 is the last settled grading.
      expect(snap.rubric?.latestScore10).toBe(7);
      expect(snap.rubric?.latestScorecardAt).toBe('2026-07-13T01:00:00.000Z');
      expect(snap.rubric?.scorecardCount).toBe(1);
      expect(snap.rubric?.scoreEvidence).toMatchObject({
        sampleCount: 1,
        excluded: { provisional: 1, gradingAuditPending: 0 },
      });
    });

    it('an audit-PENDING newest card does not become the release score', async () => {
      listScorecardPage.mockResolvedValue({
        rows: [auditPending('2026-07-14T00:00:00.000Z', 10), settled('2026-07-13T01:00:00.000Z', 7)],
        hasMore: false,
      });

      const snap = await readReleaseReadiness();

      expect(snap.rubric?.latestScore10).toBe(7);
      expect(snap.rubric?.scoreEvidence).toMatchObject({
        sampleCount: 1,
        excluded: { provisional: 0, gradingAuditPending: 1 },
      });
    });

    it('a card excluded on BOTH counts is counted once — the figures never sum past what was excluded', async () => {
      listScorecardPage.mockResolvedValue({
        rows: [
          { ...provisional('2026-07-14T00:00:00.000Z', 10), gradingAudit: { state: 'pending' } },
          settled('2026-07-13T01:00:00.000Z', 7),
        ],
        hasMore: false,
      });

      const snap = await readReleaseReadiness();
      const ev = snap.rubric?.scoreEvidence;

      expect(ev?.excluded).toEqual({ provisional: 1, gradingAuditPending: 0 });
      // The invariant the one-bucket rule exists for: excluded + admitted == the page.
      expect((ev?.excluded.provisional ?? 0) + (ev?.excluded.gradingAuditPending ?? 0) + (ev?.sampleCount ?? 0)).toBe(
        2,
      );
    });

    /**
     * Without this the three guards above would pass just as happily against a reader
     * that ignored the newest card unconditionally — "never take the newest" satisfies
     * every assertion that only ever inspects an inadmissible one. The discriminator is
     * admissibility, not recency.
     */
    it('CONTROL: on an all-settled page nothing is excluded and the NEWEST card does win', async () => {
      listScorecardPage.mockResolvedValue({
        rows: [settled('2026-07-14T00:00:00.000Z', 10), settled('2026-07-13T01:00:00.000Z', 7)],
        hasMore: false,
      });

      const snap = await readReleaseReadiness();

      expect(snap.rubric?.latestScore10).toBe(10);
      expect(snap.rubric?.scorecardCount).toBe(2);
      expect(snap.rubric?.scoreEvidence).toMatchObject({
        sampleCount: 2,
        excluded: { provisional: 0, gradingAuditPending: 0 },
      });
    });

    it('discloses the window the sample spans, over the ADMISSIBLE cards only', async () => {
      listScorecardPage.mockResolvedValue({
        rows: [
          provisional('2026-07-20T00:00:00.000Z', 10), // outside the settled window
          settled('2026-07-14T00:00:00.000Z', 9),
          settled('2026-07-11T00:00:00.000Z', 5),
        ],
        hasMore: false,
      });

      const snap = await readReleaseReadiness();

      expect(snap.rubric?.scoreEvidence).toMatchObject({
        sampleCount: 2,
        windowStart: '2026-07-11T00:00:00.000Z',
        windowEnd: '2026-07-14T00:00:00.000Z',
      });
      expect(snap.rubric?.scoreEvidence?.latestAgeMs).toBeGreaterThan(0);
    });

    /**
     * A count taken over a capped page is a FLOOR. Rendering it as a total is this
     * repo's own named failure — "a bounded measurement is indistinguishable from a
     * real zero" — and `hasMore` is authoritative where `rows.length === limit` cannot
     * tell a full page from an exactly-full one.
     */
    it('a full page marks every count a floor, so the cap is never read as a total', async () => {
      listScorecardPage.mockResolvedValue({
        rows: [settled('2026-07-14T00:00:00.000Z', 9)],
        hasMore: true,
      });

      const snap = await readReleaseReadiness();
      expect(snap.rubric?.scoreEvidence?.countTruncated).toBe(true);
    });

    it('CONTROL: a short page is NOT marked truncated', async () => {
      const snap = await readReleaseReadiness();
      expect(snap.rubric?.scoreEvidence?.countTruncated).toBe(false);
    });

    /**
     * The generation half of the same defect. A card carries a read-time verdict on
     * whether the generation it graded has since ENDED; the strip dropped it, which is
     * the 2026-07-17 shape — a 4.5h soak and a 6/6 verdict voided by a restart three
     * minutes after emit, with nothing downstream any the wiser.
     */
    it('surfaces the newest admissible card’s generation freshness', async () => {
      listScorecardPage.mockResolvedValue({
        rows: [
          {
            ...settled('2026-07-14T00:00:00.000Z', 10),
            generationFreshness: {
              status: 'stale',
              gradedHostStartedAt: '2026-07-13T00:00:00.000Z',
              liveHostStartedAt: '2026-07-14T00:03:00.000Z',
              reason: 'bg-host restarted',
            },
          },
        ],
        hasMore: false,
      });

      const snap = await readReleaseReadiness();
      expect(snap.rubric?.scoreEvidence?.latestGenerationFreshness).toBe('stale');
    });

    it('preserves an explicit not-applicable generation verdict for tree-only evidence', async () => {
      listScorecardPage.mockResolvedValue({
        rows: [
          {
            ...settled('2026-07-14T00:00:00.000Z', 10),
            generationFreshness: {
              status: 'not-applicable',
              reason: 'complete matched replay recipe has no runtime-environment fingerprints',
            },
          },
        ],
        hasMore: false,
      });

      const snap = await readReleaseReadiness();
      expect(snap.rubric?.scoreEvidence?.latestGenerationFreshness).toBe('not-applicable');
    });

    it('an unstamped card reports null freshness — absence is not-recorded, never "fresh"', async () => {
      const snap = await readReleaseReadiness();
      expect(snap.rubric?.scoreEvidence?.latestGenerationFreshness).toBeNull();
    });

    it('an empty history is an honest zero, not a missing read', async () => {
      listScorecardPage.mockResolvedValue({ rows: [], hasMore: false });

      const snap = await readReleaseReadiness();

      expect(snap.rubric?.latestScore10).toBeNull();
      expect(snap.rubric?.scoreEvidence).toMatchObject({
        sampleCount: 0,
        windowStart: null,
        windowEnd: null,
        latestAgeMs: null,
        latestGenerationFreshness: null,
      });
    });
  });

  describe('pass confidence spans repeated, distinct generations (EI-18770861086528737)', () => {
    const card = (id: number, rating: string, generation?: { code: string; startedAt: string }) => ({
      createdAt: `2026-07-${String(id).padStart(2, '0')}T00:00:00.000Z`,
      ratings: { 'cycle-error-rate': { rating } },
      ...(generation
        ? {
            gradedGeneration: {
              bootHeadSha: generation.code,
              hostStartedAt: generation.startedAt,
            },
          }
        : {}),
    });

    it('keeps a single positive observation machine-readable as provisional-pass', () => {
      const result = deriveReleaseReadinessPassConfidence([
        card(3, 'pass', { code: 'aaaaaaa', startedAt: '2026-07-03T00:00:00.000Z' }),
      ]);

      expect(result.policy).toEqual(RELEASE_READINESS_PASS_CONFIDENCE_POLICY);
      expect(result.criteria['cycle-error-rate']).toMatchObject({
        latestRating: 'pass',
        verdict: 'provisional-pass',
        consecutivePassObservations: 1,
        distinctGenerationCount: 1,
        unwatermarkedPassObservations: 0,
      });
    });

    it('promotes only three consecutive positives spanning at least two generation identities', () => {
      const result = deriveReleaseReadinessPassConfidence([
        card(5, 'pass', { code: 'bbbbbbb', startedAt: '2026-07-05T00:00:00.000Z' }),
        card(4, 'pass', { code: 'bbbbbbb', startedAt: '2026-07-05T00:00:00.000Z' }),
        card(3, 'pass', { code: 'aaaaaaa', startedAt: '2026-07-03T00:00:00.000Z' }),
      ]);

      expect(result.criteria['cycle-error-rate']).toMatchObject({
        verdict: 'pass',
        consecutivePassObservations: 3,
        distinctGenerationCount: 2,
        oldestSupportingObservationAt: '2026-07-03T00:00:00.000Z',
      });
    });

    it('does not let repeated ticks from one generation masquerade as cross-generation confidence', () => {
      const generation = { code: 'aaaaaaa', startedAt: '2026-07-03T00:00:00.000Z' };
      const result = deriveReleaseReadinessPassConfidence([
        card(5, 'pass', generation),
        card(4, 'pass', generation),
        card(3, 'pass', generation),
      ]);

      expect(result.criteria['cycle-error-rate']).toMatchObject({
        verdict: 'provisional-pass',
        consecutivePassObservations: 3,
        distinctGenerationCount: 1,
      });
    });

    it('resets the proof when the newest settled rating is no longer positive', () => {
      const result = deriveReleaseReadinessPassConfidence([
        card(6, 'at-risk', { code: 'ccccccc', startedAt: '2026-07-06T00:00:00.000Z' }),
        card(5, 'pass', { code: 'bbbbbbb', startedAt: '2026-07-05T00:00:00.000Z' }),
        card(4, 'pass', { code: 'bbbbbbb', startedAt: '2026-07-05T00:00:00.000Z' }),
        card(3, 'pass', { code: 'aaaaaaa', startedAt: '2026-07-03T00:00:00.000Z' }),
      ]);

      expect(result.criteria['cycle-error-rate']).toMatchObject({
        latestRating: 'at-risk',
        verdict: 'not-passing',
        consecutivePassObservations: 0,
        distinctGenerationCount: 0,
      });
    });

    it('surfaces unstamped positive observations but never counts them as distinct generations', async () => {
      listScorecardPage.mockResolvedValue({
        rows: [card(5, 'pass'), card(4, 'pass'), card(3, 'pass')],
        hasMore: false,
      });

      const snap = await readReleaseReadiness();

      expect(snap.rubric?.scoreEvidence?.passConfidence.criteria['cycle-error-rate']).toMatchObject({
        verdict: 'provisional-pass',
        consecutivePassObservations: 3,
        distinctGenerationCount: 0,
        unwatermarkedPassObservations: 3,
      });
    });
  });
});
