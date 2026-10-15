import { describe, expect, it } from 'vitest';
import {
  ANCHOR_TOKEN_WINDOW,
  MAX_MEASUREMENTS_PER_TEXT,
  extractMeasurements,
  measurementOverlap,
  measurementsMatch,
  sharedMeasurements,
} from './measurement-tuples';
import {
  FIRST_FILED_EI_22393887492211068 as FIRST,
  SECOND_FILED_WI_2145269 as SECOND,
  searchableText,
} from './measurement-tuples.fixture';

const GIB = 2 ** 30;
const GB = 1e9;

describe('extractMeasurements — R-2 parsing', () => {
  it.each([
    ['session_archive_files 21.6 GiB', 'session_archive_files', 21.6 * GIB],
    ['session_archive_files (22GB)', 'session_archive_files', 22 * GB],
    ['session_archive_files   22 GB', 'session_archive_files', 22 * GB],
    ['tool_invocations regressed to 14.6 GiB', 'tool_invocations', 14.6 * GIB],
    ['tool_invocations        15 GB', 'tool_invocations', 15 * GB],
    ['gateway_payload_blobs    3.7 GiB', 'gateway_payload_blobs', 3.7 * GIB],
    ['gateway_payload_blobs  3.8 GB', 'gateway_payload_blobs', 3.8 * GB],
  ])('%s -> %s', (text, anchor, bytes) => {
    const out = extractMeasurements(text);
    expect(out).toHaveLength(1);
    expect(out[0].anchor).toBe(anchor);
    expect(out[0].bytes).toBeCloseTo(bytes, 0);
  });

  it('parses every byte unit, case-insensitively, with or without a space', () => {
    const cases: Array<[string, number]> = [
      ['a_b 7 B', 7],
      ['a_b 7kb', 7e3],
      ['a_b 7 MB', 7e6],
      ['a_b 7gb', 7e9],
      ['a_b 7 TB', 7e12],
      ['a_b 7KiB', 7 * 2 ** 10],
      ['a_b 7 mib', 7 * 2 ** 20],
      ['a_b 7 GIB', 7 * 2 ** 30],
      ['a_b 7tib', 7 * 2 ** 40],
    ];
    for (const [text, bytes] of cases) {
      expect(extractMeasurements(text).map((m) => m.bytes), text).toEqual([bytes]);
    }
  });

  it('ignores non-byte quantities and unit look-alikes', () => {
    expect(extractMeasurements('a_b 8M rows, a_b 5 GBit link, a_b v1.2GB, a_b 42 files')).toEqual([]);
  });

  it('confines the anchor to text after the previous quantity on the same line', () => {
    const out = extractMeasurements('tool_invocations        15 GB   <-- WI-844 recorded 5.6 GB; has REGRESSED');
    expect(out.map((m) => [m.anchor, m.raw])).toEqual([
      ['tool_invocations', '15 GB'],
      ['wi-844', '5.6 GB'],
    ]);
  });

  it('never carries an anchor across a line break', () => {
    expect(extractMeasurements('session_turns\n10 GB')).toEqual([]);
  });

  it(`drops a quantity whose nearest identifier is more than ${ANCHOR_TOKEN_WINDOW} tokens back`, () => {
    expect(extractMeasurements('work_items one two three four five six 2 GB')).toEqual([]);
    expect(extractMeasurements('work_items one two three four five 2 GB')).toHaveLength(1);
  });

  it('keeps the anchor across a unitless number and an arrow (route_invocations fell 9.2 -> 3.0 GiB)', () => {
    const out = extractMeasurements('route_invocations fell 9.2 -> 3.0 GiB, so that retention works.');
    expect(out.map((m) => [m.anchor, m.raw])).toEqual([['route_invocations', '3.0 GiB']]);
  });
});

describe('measurement overlap on the VERBATIM measured pair (R-2)', () => {
  const first = searchableText(FIRST);
  const second = searchableText(SECOND);

  it('uses the stored corpus, not a paraphrase', () => {
    expect(FIRST.id).toBe('EI-22393887492211068');
    expect(SECOND.id).toBe('WI-2145269');
    expect(SECOND.createdTs - FIRST.createdTs).toBe(56_189);
    // The wording genuinely differs: the duplicate signal must not be coming from shared prose.
    expect(FIRST.title).not.toContain('stale and incomplete');
  });

  it('finds 9 one-to-one anchored pairs over 8 distinct anchors, all within 9.5%', () => {
    const overlap = measurementOverlap(first, second);
    expect(overlap.pairs).toHaveLength(9);
    expect(overlap.anchors).toEqual([
      'gateway_payload_blobs',
      'route_invocations',
      'session_archive_files',
      'session_turn_chunks',
      'session_turn_parts',
      'session_turns',
      'tool_invocations',
      'work_items',
    ]);
    for (const p of overlap.pairs) expect(p.relDiff).toBeLessThanOrEqual(0.0953);
    expect(overlap.match).toBe(true);
  });

  it('counts session_archive_files 21.6 GiB vs 22 GB as shared', () => {
    const pair = sharedMeasurements(first, second).find(
      (p) => p.anchor === 'session_archive_files' && p.b.raw === '22 GB',
    );
    expect(pair?.a.raw).toBe('21.6 GiB');
    expect(pair?.relDiff).toBeCloseTo(0.0542, 3);
  });

  it('is symmetric and title-order independent', () => {
    expect(measurementsMatch(first, second)).toBe(true);
    expect(measurementsMatch(second, first)).toBe(true);
    expect(sharedMeasurements(second, first)).toHaveLength(9);
  });

  it('does not pair the mis-anchored WI-844 baselines with the live tool_invocations figure', () => {
    const anchoredToTicket = extractMeasurements(second).filter((m) => m.anchor === 'wi-844');
    expect(anchoredToTicket.map((m) => m.raw)).toEqual(['15GB', '5.6 GB', '9.2 GB']);
    expect(sharedMeasurements(first, second).some((p) => p.anchor === 'wi-844')).toBe(false);
  });

  it('honours the tolerance option (the 9.5% session_turns pair drops at 5%)', () => {
    const tight = measurementOverlap(first, second, { tolerance: 0.05 });
    expect(tight.anchors).not.toContain('session_turns');
    expect(tight.anchors).not.toContain('session_turn_chunks');
  });
});

describe('R-3 — no false pairing on shared numbers alone', () => {
  it('shared bare quantities with no anchor never match', () => {
    const a = 'The hourly dump is 5 GB and the floor is 120 GiB.';
    const b = 'We freed 5 GB of scratch; the floor is 120 GiB.';
    expect(sharedMeasurements(a, b)).toEqual([]);
    expect(measurementsMatch(a, b)).toBe(false);
  });

  it('a single shared anchored measurement is not a match', () => {
    expect(measurementsMatch('tool_invocations 15 GB', 'tool_invocations is at 14.6 GiB')).toBe(false);
  });

  it('one measurement repeated in title and summary on both sides is still ONE anchor', () => {
    const a = 'session_archive_files (21.6 GiB) is the largest\nsession_archive_files 21.6 GiB';
    const b = 'session_archive_files (22GB) never scoped\nsession_archive_files 22 GB';
    const overlap = measurementOverlap(a, b);
    expect(overlap.pairs).toHaveLength(2);
    expect(overlap.anchors).toEqual(['session_archive_files']);
    expect(overlap.match).toBe(false);
  });

  it('same anchors with values outside tolerance do not match', () => {
    expect(measurementsMatch('work_items 2 GB\nsession_turns 10 GB', 'work_items 4 GB\nsession_turns 20 GB')).toBe(false);
  });

  it('identical values under different anchors do not match', () => {
    expect(measurementsMatch('work_items 2 GB\nsession_turns 10 GB', 'audit_log 2 GB\nagent_activity 10 GB')).toBe(false);
  });

  it('two distinct shared anchors within tolerance do match', () => {
    expect(measurementsMatch('work_items 2 GB\nsession_turns 10 GB', 'work_items 2.1 GB\nsession_turns 10.4 GB')).toBe(true);
  });
});

// Isolation runs take tens of ms; gate-load inflation measured 2219ms against the old 1500ms
// budget (verify 4988081a, d740fc38). The bound only has to catch runaway backtracking.
const BOUNDED_BUDGET_MS = 15_000;

describe('R-5 — fail-open and bounded', () => {
  it('empty and non-string input yields no measurements and no match', () => {
    expect(extractMeasurements('')).toEqual([]);
    expect(extractMeasurements(undefined as unknown as string)).toEqual([]);
    expect(extractMeasurements(42 as unknown as string)).toEqual([]);
    expect(measurementsMatch('', searchableText(FIRST))).toBe(false);
  });

  it('a >=100 KB multi-line text extracts within the leg budget and caps its tuples', () => {
    const line = 'session_archive_files 21.6 GiB and tool_invocations 14.6 GiB\n';
    const big = line.repeat(Math.ceil(100_000 / line.length));
    expect(big.length).toBeGreaterThanOrEqual(100_000);
    const t0 = performance.now();
    const out = extractMeasurements(big);
    const overlap = measurementOverlap(big, big);
    const elapsed = performance.now() - t0;
    expect(out.length).toBe(MAX_MEASUREMENTS_PER_TEXT);
    expect(overlap.match).toBe(true);
    expect(elapsed).toBeLessThan(BOUNDED_BUDGET_MS);
  });

  it('a >=100 KB single line of number/unit soup and separator noise stays bounded', () => {
    const soup = '1.1.1.1 GB -_-/./ 9999999999999999999999 GiB '.repeat(2_500);
    expect(soup.length).toBeGreaterThanOrEqual(100_000);
    const t0 = performance.now();
    expect(() => extractMeasurements(soup)).not.toThrow();
    expect(() => measurementOverlap(soup, soup)).not.toThrow();
    expect(performance.now() - t0).toBeLessThan(BOUNDED_BUDGET_MS);
  });
});
