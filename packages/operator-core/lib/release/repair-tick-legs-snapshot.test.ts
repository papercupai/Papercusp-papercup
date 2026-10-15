/**
 * WI-2143253 — `parseRepairTickLegs` / `repairTickLegsCurrent`.
 *
 * These are the read-side half of the gap: `gate_health.repairTickLegs` (release-actions.ts
 * writes it on every awaiting-fixer hold tick) carried real per-leg lint/perf/desktop/delta
 * status all along; nothing ever parsed it back out. Malformed input must degrade to `null`
 * (or a filtered leg list), never throw — this parses an externally-controlled JSONB blob.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRepairTickLegs,
  partitionSameHeadContradictions,
  releaseFixerTargetsAfterSameHeadContradictions,
  repairTickClearedQueueSignature,
  repairTickLegsCurrent,
  type StoredRepairTickLegs,
} from './repair-tick-legs-snapshot';

describe('parseRepairTickLegs', () => {
  it('parses a well-formed measurement, including a mix of pass/fail/errored legs', () => {
    const parsed = parseRepairTickLegs({
      head: 'abc123def456',
      atMs: 1_000,
      ok: false,
      failingSignatures: ['lint:design-primitives', 'lint:plane-integrity'],
      legs: [
        { id: 'lint:design-primitives', status: 'fail', durationMs: 420 },
        { id: 'lint:plane-integrity', status: 'errored', durationMs: 10 },
        { id: 'lint:tsc', status: 'pass', durationMs: 5000 },
      ],
    });
    expect(parsed).toEqual({
      head: 'abc123def456',
      atMs: 1_000,
      ok: false,
      failingSignatures: ['lint:design-primitives', 'lint:plane-integrity'],
      legs: [
        { id: 'lint:design-primitives', status: 'fail', durationMs: 420 },
        { id: 'lint:plane-integrity', status: 'errored', durationMs: 10 },
        { id: 'lint:tsc', status: 'pass', durationMs: 5000 },
      ],
    });
  });

  it('returns null for a missing/blank head — the field the currency check depends on', () => {
    expect(parseRepairTickLegs({ atMs: 1, ok: true, failingSignatures: [], legs: [] })).toBeNull();
    expect(parseRepairTickLegs({ head: '', atMs: 1, ok: true, failingSignatures: [], legs: [] })).toBeNull();
  });

  it('returns null for a missing/non-numeric atMs', () => {
    expect(parseRepairTickLegs({ head: 'abc', ok: true, failingSignatures: [], legs: [] })).toBeNull();
    expect(parseRepairTickLegs({ head: 'abc', atMs: 'nope', ok: true, failingSignatures: [], legs: [] })).toBeNull();
  });

  it('returns null for non-object / null / array input, never throws', () => {
    expect(parseRepairTickLegs(null)).toBeNull();
    expect(parseRepairTickLegs(undefined)).toBeNull();
    expect(parseRepairTickLegs('a string')).toBeNull();
    expect(parseRepairTickLegs(42)).toBeNull();
    expect(parseRepairTickLegs([])).toBeNull();
  });

  it('drops individual malformed leg entries rather than failing the whole parse', () => {
    const parsed = parseRepairTickLegs({
      head: 'abc123def456',
      atMs: 1_000,
      ok: false,
      failingSignatures: ['lint:tsc'],
      legs: [
        { id: 'lint:tsc', status: 'fail', durationMs: 12 }, // valid
        { id: '', status: 'fail', durationMs: 1 }, // blank id — dropped
        { status: 'fail', durationMs: 1 }, // missing id — dropped
        { id: 'lint:x', status: 'unknown-status', durationMs: 1 }, // bad status enum — dropped
        'not-an-object', // dropped
        null, // dropped
      ],
    });
    expect(parsed?.legs).toEqual([{ id: 'lint:tsc', status: 'fail', durationMs: 12 }]);
  });

  it('defaults durationMs to null when absent or non-numeric, without dropping the leg', () => {
    const parsed = parseRepairTickLegs({
      head: 'abc123def456',
      atMs: 1_000,
      ok: true,
      failingSignatures: [],
      legs: [{ id: 'lint:tsc', status: 'pass' }],
    });
    expect(parsed?.legs).toEqual([{ id: 'lint:tsc', status: 'pass', durationMs: null }]);
  });

  it('filters non-string entries out of failingSignatures and tolerates a non-array value', () => {
    const parsed = parseRepairTickLegs({
      head: 'abc123def456',
      atMs: 1_000,
      ok: false,
      failingSignatures: ['lint:tsc', 42, null, 'lint:x'],
      legs: [],
    });
    expect(parsed?.failingSignatures).toEqual(['lint:tsc', 'lint:x']);

    const parsedNoSigs = parseRepairTickLegs({ head: 'abc', atMs: 1, ok: true, legs: [] });
    expect(parsedNoSigs?.failingSignatures).toEqual([]);
  });

  it('normalizes ok to a strict boolean rather than passing through a truthy value', () => {
    const parsed = parseRepairTickLegs({ head: 'abc', atMs: 1, ok: 'yes', failingSignatures: [], legs: [] });
    expect(parsed?.ok).toBe(false);
  });
});

describe('repairTickLegsCurrent', () => {
  it('is true when the live repairHead sha starts with the (short, persisted) leg-measurement head', () => {
    expect(
      repairTickLegsCurrent({ head: 'abc123def456' }, 'abc123def4567890000000000000000000000000'),
    ).toBe(true);
  });

  it('is false when the live repairHead has moved past the measured head', () => {
    expect(repairTickLegsCurrent({ head: 'abc123def456' }, 'fff000000000000000000000000000000000000')).toBe(false);
  });

  it('is null (unknown, not false) when there is no live repairHead to compare against', () => {
    expect(repairTickLegsCurrent({ head: 'abc123def456' }, null)).toBeNull();
  });
});

describe('repairTickClearedQueueSignature', () => {
  const HEAD = 'aa9487596d5406cc49d424a4162d99634b214cdf';
  const LANE = '@papercusp/operator-core :: test:lane-stateful';
  const tick = (over: Partial<StoredRepairTickLegs> = {}): StoredRepairTickLegs => ({
    head: HEAD.slice(0, 12),
    atMs: 1_000,
    ok: true,
    failingSignatures: [],
    legs: [
      { id: 'lint:tsc', status: 'pass', durationMs: 1 },
      { id: LANE, status: 'pass', durationMs: 1_159_339 },
    ],
    ...over,
  });

  it('is true when the tick at the current head re-ran and passed every queue signature', () => {
    expect(repairTickClearedQueueSignature(tick(), { repairHead: HEAD, failingTests: [LANE] })).toBe(true);
  });

  it('is false when the tick measured an earlier head', () => {
    expect(
      repairTickClearedQueueSignature(tick({ head: 'fff000000000' }), { repairHead: HEAD, failingTests: [LANE] }),
    ).toBe(false);
  });

  it('is false when any tick leg failed', () => {
    expect(
      repairTickClearedQueueSignature(tick({ ok: false, failingSignatures: ['lint:tsc'] }), {
        repairHead: HEAD,
        failingTests: [LANE],
      }),
    ).toBe(false);
  });

  it('is false when a queue signature was never re-run by the tick (a test file, not a leg)', () => {
    expect(
      repairTickClearedQueueSignature(tick(), {
        repairHead: HEAD,
        failingTests: [LANE, 'lib/agent-tools/plans/arm-schedule.test.ts'],
      }),
    ).toBe(false);
  });

  it('is false with no measurement or an empty queue failing set', () => {
    expect(repairTickClearedQueueSignature(null, { repairHead: HEAD, failingTests: [LANE] })).toBe(false);
    expect(repairTickClearedQueueSignature(tick(), { repairHead: HEAD, failingTests: [] })).toBe(false);
  });
});

// WI-10007494: a same-head contradiction mixed with a real red. Before this, nothing removed
// the contradicted entry, so the fixer was told to fix a leg its own head had passed.
describe('partitionSameHeadContradictions / releaseFixerTargetsAfterSameHeadContradictions', () => {
  const HEAD = 'aa9487596d5406cc49d424a4162d99634b214cdf';
  const LANE = '@papercusp/operator-core :: test:lane-stateful';
  const FILE = 'packages/operator-core/lib/agent-tools/plans/arm-schedule.test.ts';
  const LINT = 'lint:design-primitives';
  const tick = (over: Partial<StoredRepairTickLegs> = {}): StoredRepairTickLegs => ({
    head: HEAD.slice(0, 12),
    atMs: 1_000,
    ok: false,
    failingSignatures: [LINT],
    legs: [
      { id: LANE, status: 'pass', durationMs: 1_159_339 },
      { id: LINT, status: 'fail', durationMs: 4_000 },
    ],
    ...over,
  });

  it('splits a passed same-head leg from a real red and a test file, keeping input order', () => {
    expect(partitionSameHeadContradictions([FILE, LANE, LINT], tick(), HEAD)).toEqual({
      contradicted: [LANE],
      actionable: [FILE, LINT],
    });
  });

  it('contradicts nothing when the tick measured an earlier head', () => {
    expect(partitionSameHeadContradictions([LANE, LINT], tick({ head: 'fff000000000' }), HEAD)).toEqual({
      contradicted: [],
      actionable: [LANE, LINT],
    });
  });

  it('contradicts nothing when currency cannot be judged (no repairHead) or there is no tick', () => {
    expect(partitionSameHeadContradictions([LANE], tick(), null).contradicted).toEqual([]);
    expect(partitionSameHeadContradictions([LANE], null, HEAD)).toEqual({ contradicted: [], actionable: [LANE] });
  });

  it('keeps an id actionable when the same tick also recorded it failing or errored', () => {
    const dup = tick({
      failingSignatures: [],
      legs: [
        { id: LANE, status: 'pass', durationMs: 1 },
        { id: LANE, status: 'errored', durationMs: 2 },
      ],
    });
    expect(partitionSameHeadContradictions([LANE], dup, HEAD).contradicted).toEqual([]);
    const named = tick({ failingSignatures: [LANE], legs: [{ id: LANE, status: 'pass', durationMs: 1 }] });
    expect(partitionSameHeadContradictions([LANE], named, HEAD).contradicted).toEqual([]);
  });

  it('never contradicts a test-file entry, which is not a tick leg id', () => {
    expect(partitionSameHeadContradictions([FILE], tick(), HEAD)).toEqual({ contradicted: [], actionable: [FILE] });
  });

  it('hands the fixer only the real red in the mixed case and names the contradicted entry', () => {
    expect(releaseFixerTargetsAfterSameHeadContradictions([LANE, LINT], tick(), HEAD)).toEqual({
      targets: [LINT],
      sameHeadContradicted: [LANE],
    });
  });

  it('leaves an all-contradicted signature to the retest path rather than emptying the target list', () => {
    const allPassed = tick({ ok: true, failingSignatures: [], legs: [{ id: LANE, status: 'pass', durationMs: 1 }] });
    expect(releaseFixerTargetsAfterSameHeadContradictions([LANE], allPassed, HEAD)).toEqual({
      targets: [LANE],
      sameHeadContradicted: [],
    });
    expect(repairTickClearedQueueSignature(allPassed, { repairHead: HEAD, failingTests: [LANE] })).toBe(true);
  });

  it('returns the input unchanged when nothing is contradicted', () => {
    expect(releaseFixerTargetsAfterSameHeadContradictions([FILE, LINT], tick(), HEAD)).toEqual({
      targets: [FILE, LINT],
      sameHeadContradicted: [],
    });
    expect(releaseFixerTargetsAfterSameHeadContradictions(undefined, tick(), HEAD)).toEqual({
      targets: [],
      sameHeadContradicted: [],
    });
  });
});
