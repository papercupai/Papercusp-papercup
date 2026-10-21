import { describe, expect, it } from 'vitest';
import { judgeR10, parseR10Row, R10_MAX_TICK_AGE_S } from './stranded-blocked-live-oracle.mjs';

// all_cleared_blocked|reblocked_after_clear|other_hold|stranded|cleared_since_tick|missing_times|tick_age_s|repair_audit_rows
const healthy = '19|6|13|0|0|0|70|6';

const failing = (line: string) => {
  const v = judgeR10(parseR10Row(line));
  return { passed: v.passed, failed: v.assertions.filter((a: { passed: boolean }) => !a.passed).map((a: { id: string }) => a.id) };
};

describe('R-10 stranded-blocked live oracle (event-wait-settlement-2026-10-20 AUTO-BAR-R-10-P-005@3)', () => {
  it('parses the eight-field psql -At row', () => {
    expect(parseR10Row(healthy)).toEqual({
      all_cleared_blocked: 19,
      reblocked_after_clear: 6,
      other_hold: 13,
      stranded: 0,
      cleared_since_tick: 0,
      missing_times: 0,
      tick_age_s: 70,
      repair_audit_rows: 6,
    });
  });

  it('refuses a malformed row instead of judging it', () => {
    expect(() => parseR10Row('')).toThrow(/8 fields/);
    expect(() => parseR10Row('19|6|13|0|0|0|70')).toThrow(/8 fields/);
    expect(() => parseR10Row('19|6|13|x|0|0|70|6')).toThrow(/stranded is not an integer/);
    expect(() => parseR10Row('19|6|13|0|0|0|70.5|6')).toThrow(/tick_age_s is not an integer/);
  });

  it('passes a fully classified population with nothing stranded on a live sweep', () => {
    expect(failing(healthy)).toEqual({ passed: true, failed: [] });
  });

  it('passes an empty population when the sweep is live and the repair path has acted', () => {
    expect(failing('0|0|0|0|0|0|30|1')).toEqual({ passed: true, failed: [] });
  });

  it('fails when an item is stranded (the clause falsifier)', () => {
    expect(failing('20|6|13|1|0|0|70|6')).toEqual({ passed: false, failed: ['no-stranded-item'] });
  });

  it('fails when a candidate falls into no bucket (the NULL-hold-flag hole)', () => {
    // 20 candidates, 19 classified: the row a NULL owner_reserved flag dropped from every FILTER.
    expect(failing('20|6|13|0|0|0|70|6')).toEqual({ passed: false, failed: ['every-candidate-classified-once'] });
  });

  it('fails when a candidate has no state or clear time', () => {
    expect(failing('20|6|13|0|0|1|70|6')).toEqual({ passed: false, failed: ['no-unknown-times'] });
  });

  it('fails when the sweep has stopped or its routine row is missing', () => {
    expect(failing(`19|6|13|0|0|0|${R10_MAX_TICK_AGE_S + 1}|6`)).toEqual({ passed: false, failed: ['sweep-is-live'] });
    expect(failing('19|6|13|0|0|0|-1|6')).toEqual({ passed: false, failed: ['sweep-is-live'] });
  });

  it('accepts a tick exactly at the age limit', () => {
    expect(failing(`19|6|13|0|0|0|${R10_MAX_TICK_AGE_S}|6`).passed).toBe(true);
  });

  it('fails when the repair path has never acted (running build may lack P-005)', () => {
    expect(failing('19|6|13|0|0|0|70|0')).toEqual({ passed: false, failed: ['repair-path-observed'] });
  });

  it('treats items cleared after the last completed tick as not yet due, not stranded', () => {
    expect(failing('21|6|13|0|2|0|70|6')).toEqual({ passed: true, failed: [] });
  });
});
