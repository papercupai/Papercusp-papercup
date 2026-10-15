/**
 * WI-6554700010010541 — a persisted spec-test-adequacy rerun recipe must pin an
 * evidence-row limit its own exact replay can satisfy.
 *
 * The evaluator refuses with `evidence_selection_hit_limit` once loaded rows reach
 * the limit. A fixed 25 made every clause with 25+ bindings permanently
 * uncertifiable (green-main-cycle-time-2026-10-08#AUTO-BAR-R-11-P-007@3, 31
 * bindings, refused on every certify). Small cohorts keep the critical-pressure
 * budget; larger ones pin graded+1.
 */
import { describe, expect, it } from 'vitest';
import { SPEC_TEST_ADEQUACY_REPLAY_LIMIT, specTestAdequacyReplayLimit } from './spec-test-adequacy';

describe('specTestAdequacyReplayLimit', () => {
  it('keeps the critical-pressure budget of 25 while the graded cohort fits under it', () => {
    expect(SPEC_TEST_ADEQUACY_REPLAY_LIMIT).toBe(25);
    for (const rows of [0, 1, 3, 24]) {
      expect(specTestAdequacyReplayLimit(rows)).toBe(25);
    }
  });

  it('pins one row above a cohort that would otherwise reach the limit, so the replay is never refused', () => {
    // The evaluator refuses when loaded >= limit. 25 rows at limit 25 is the
    // boundary case that used to refuse.
    expect(specTestAdequacyReplayLimit(25)).toBe(26);
    expect(specTestAdequacyReplayLimit(31)).toBe(32);
    for (const rows of [25, 31, 120, 999]) {
      const limit = specTestAdequacyReplayLimit(rows);
      expect(rows >= limit, `rows=${rows} limit=${limit} would hit evidence_selection_hit_limit`).toBe(false);
    }
  });

  it('treats a non-count input as an empty cohort instead of producing a non-integer limit', () => {
    for (const bad of [Number.NaN, -3, 2.5, Number.POSITIVE_INFINITY]) {
      expect(specTestAdequacyReplayLimit(bad)).toBe(25);
    }
  });
});
