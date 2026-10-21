import { describe, expect, it } from 'vitest';
import { judgeR17, parseR17Row, R17_MIN_SLOTS } from './sync-batch-coverage-accounting-oracle.mjs';

const live = '2|291|0.044673539518900345|0|0|1';

describe('R-17 slot-accounting oracle (green-main-ratchet-convergence-2026-10-17)', () => {
  it('parses the six-field psql -At row', () => {
    expect(parseR17Row(live)).toEqual({
      routines: 2,
      min_slots: 291,
      min_ratio: 0.044673539518900345,
      unaccounted_slots: 0,
      low_without_current_alarm: 0,
      accounted: 1,
    });
  });

  it('refuses a malformed row instead of judging it', () => {
    expect(() => parseR17Row('')).toThrow(/6 fields/);
    expect(() => parseR17Row('2|291|0.04|0|0')).toThrow(/6 fields/);
    expect(() => parseR17Row('2|291|x|0|0|1')).toThrow(/min_ratio is not numeric/);
  });

  it('passes low coverage when every slot is accounted and a fresh alarm is open', () => {
    const v = judgeR17(parseR17Row(live));
    expect(v.passed).toBe(true);
    expect(v.assertions.every((a: { passed: boolean }) => a.passed)).toBe(true);
  });

  it('fails when a recorded slot has no cause', () => {
    const v = judgeR17(parseR17Row('2|291|0.04|102|0|0'));
    expect(v.passed).toBe(false);
    expect(v.assertions.find((a: { id: string }) => a.id === 'every-slot-accounted')?.passed).toBe(false);
  });

  it('fails when coverage is low and no fresh alarm is open', () => {
    const v = judgeR17(parseR17Row('2|291|0.04|0|1|0'));
    expect(v.passed).toBe(false);
    expect(v.assertions.find((a: { id: string }) => a.id === 'low-coverage-has-fresh-alarm')?.passed).toBe(false);
  });

  it('fails when a routine stopped recording (below the slot floor)', () => {
    const v = judgeR17(parseR17Row(`2|${R17_MIN_SLOTS - 1}|0.04|0|0|0`));
    expect(v.passed).toBe(false);
    expect(v.assertions.find((a: { id: string }) => a.id === 'slot-floor')?.passed).toBe(false);
  });

  it('fails when a routine row is missing', () => {
    expect(judgeR17(parseR17Row('1|291|0.04|0|0|0'))?.passed).toBe(false);
  });

  it('fails when the probe verdict disagrees with the recomputation, in either direction', () => {
    const optimistic = judgeR17(parseR17Row('2|291|0.04|5|0|1'));
    expect(optimistic.passed).toBe(false);
    expect(optimistic.assertions.find((a: { id: string }) => a.id === 'probe-verdict-agrees')?.passed).toBe(false);
    const pessimistic = judgeR17(parseR17Row('2|291|0.04|0|0|0'));
    expect(pessimistic.passed).toBe(false);
    expect(pessimistic.assertions.find((a: { id: string }) => a.id === 'probe-verdict-agrees')?.passed).toBe(false);
  });
});
