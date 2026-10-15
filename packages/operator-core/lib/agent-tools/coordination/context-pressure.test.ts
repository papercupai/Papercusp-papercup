/**
 * context-pressure.test.ts — the coarse per-member context-pressure bucket
 * (fleet-deltas-leader-primitives-2026-07-10 P-007).
 */
import { describe, it, expect, vi } from 'vitest';
const { sqlMock, fleetMock, measuredWindowMock, modelSpecMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  fleetMock: vi.fn(),
  measuredWindowMock: vi.fn(),
  modelSpecMock: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));
vi.mock('./presence-fleet', () => ({ fetchPresenceFleet: fleetMock }));
vi.mock('../../compaction-usage', () => ({
  estimateContextWindowForOwner: measuredWindowMock,
  resolveModelSpecForOwner: modelSpecMock,
}));
import {
  deriveContextPressure,
  deriveContextPressureAgeSec,
  fetchContextPressure,
  fetchContextPressureReadings,
  resolveContextPressureHeadroom,
  CONTEXT_ESTIMATE_STALE_MS,
  type ContextPressureBucket,
} from './context-pressure';
import { CONTEXT_GAUGE_LOUD_PCT, CONTEXT_GAUGE_CRITICAL_PCT } from './tools/inbox-context-usage';

describe('deriveContextPressure (pure)', () => {
  it('null when usage cannot be computed (no limit / no estimate)', () => {
    expect(deriveContextPressure(null, null)).toBeNull();
    expect(deriveContextPressure(1000, null)).toBeNull();
    expect(deriveContextPressure(null, 100_000)).toBeNull();
    expect(deriveContextPressure(1000, 0)).toBeNull(); // a zero limit is meaningless, not 0%
  });

  it("'ok' below the LOUD band — the common, comfortably-under-limit case", () => {
    expect(deriveContextPressure(0, 100_000)).toBe('ok');
    expect(deriveContextPressure(50_000, 100_000)).toBe('ok'); // 50%
    // Just under LOUD (79%) is still 'ok' — matches contextGaugeBand's 'quiet' band.
    expect(deriveContextPressure((CONTEXT_GAUGE_LOUD_PCT - 1) * 1000, 100_000)).toBe('ok');
  });

  it("'high' at/above LOUD, below CRITICAL", () => {
    expect(deriveContextPressure(CONTEXT_GAUGE_LOUD_PCT * 1000, 100_000)).toBe('high');
    expect(deriveContextPressure((CONTEXT_GAUGE_CRITICAL_PCT - 1) * 1000, 100_000)).toBe('high');
  });

  it("'critical' at/above CRITICAL", () => {
    expect(deriveContextPressure(CONTEXT_GAUGE_CRITICAL_PCT * 1000, 100_000)).toBe('critical');
    expect(deriveContextPressure(130_000, 100_000)).toBe('critical'); // over 100% (force-compact band)
  });

  it('the bucket is always one of exactly three strings, or null — never coerced/mixed', () => {
    const cases: Array<[number | null, number | null]> = [
      [0, 100_000],
      [80_000, 100_000],
      [95_000, 100_000],
      [null, null],
    ];
    for (const [tokens, limit] of cases) {
      const b = deriveContextPressure(tokens, limit);
      expect(b === null || b === 'ok' || b === 'high' || b === 'critical').toBe(true);
    }
  });
});

// EI-18729596985129261: a cached (contextTokens, compactionLimit) reading can be
// arbitrarily older than the watchdog's own 2-minute sweep cadence under host
// load (a delayed/skipped sweep) — asserting a bucket from a badly-stale
// snapshot is worse than reporting no signal at all, since a caller (a leader
// benching a member, an agent's own self-compaction judgment) may act on it.
describe('deriveContextPressure — staleness (EI-18729596985129261)', () => {
  const NOW = 1_800_000_000_000; // fixed instant for deterministic tests

  it('no estimatedAt provided ⇒ unchanged behavior (no staleness check at all)', () => {
    // A caller that never threads the timestamp through gets today's behavior —
    // the whole point of the param being optional.
    expect(deriveContextPressure(CONTEXT_GAUGE_CRITICAL_PCT * 1000, 100_000)).toBe('critical');
  });

  it('a FRESH estimate (well within the staleness window) still asserts its real bucket', () => {
    const estimatedAt = NOW - 30_000; // 30s old
    expect(deriveContextPressure(CONTEXT_GAUGE_CRITICAL_PCT * 1000, 100_000, estimatedAt, NOW)).toBe('critical');
    expect(deriveContextPressure(50_000, 100_000, new Date(estimatedAt), NOW)).toBe('ok');
  });

  it('an estimate right at the staleness boundary still counts as fresh (strictly greater-than expires it)', () => {
    const estimatedAt = NOW - CONTEXT_ESTIMATE_STALE_MS;
    expect(deriveContextPressure(CONTEXT_GAUGE_CRITICAL_PCT * 1000, 100_000, estimatedAt, NOW)).toBe('critical');
  });

  it('a STALE estimate (older than CONTEXT_ESTIMATE_STALE_MS) degrades to null — even a "critical" reading', () => {
    const estimatedAt = NOW - CONTEXT_ESTIMATE_STALE_MS - 1;
    // This is the exact live symptom: usage genuinely low (or unknowable), but a
    // stale cached snapshot would otherwise report "critical" with full confidence.
    expect(deriveContextPressure(CONTEXT_GAUGE_CRITICAL_PCT * 1000, 100_000, estimatedAt, NOW)).toBeNull();
    expect(deriveContextPressure(50_000, 100_000, estimatedAt, NOW)).toBeNull(); // even an 'ok'-shaped stale reading is discarded
  });

  it('an unparseable estimatedAt is treated as untrustworthy, not silently ignored', () => {
    expect(deriveContextPressure(CONTEXT_GAUGE_CRITICAL_PCT * 1000, 100_000, 'not-a-date', NOW)).toBeNull();
  });

  it('staleness never overrides the existing "no data at all" null (contextTokens/compactionLimit missing)', () => {
    const estimatedAt = NOW - 30_000; // fresh, but there is nothing to derive a pct from
    expect(deriveContextPressure(null, null, estimatedAt, NOW)).toBeNull();
    expect(deriveContextPressure(1000, null, estimatedAt, NOW)).toBeNull();
  });
});

describe('deriveContextPressureAgeSec — provenance (EI-21187441696630861)', () => {
  const NOW = 1_800_000_000_000;

  it('distinguishes a 10-second-old estimate from a 14-minute-old estimate', () => {
    expect(deriveContextPressureAgeSec(NOW - 10_000, NOW)).toBe(10);
    expect(deriveContextPressureAgeSec(NOW - 14 * 60_000, NOW)).toBe(14 * 60);
  });

  it('reports null for missing/unparseable provenance and clamps future clocks to zero', () => {
    expect(deriveContextPressureAgeSec(null, NOW)).toBeNull();
    expect(deriveContextPressureAgeSec('not-a-date', NOW)).toBeNull();
    expect(deriveContextPressureAgeSec(NOW + 10_000, NOW)).toBe(0);
  });
});

describe('fetchContextPressure (IO seam)', () => {
  it('empty ownerIds is a no-op that never calls sql', async () => {
    const out = await fetchContextPressure([]);
    expect(out).toEqual(new Map());
    expect(await fetchContextPressureReadings([])).toEqual(new Map());
  });

  it('returns the estimate timestamp and age alongside the derived bucket', async () => {
    const now = 1_800_000_000_000;
    const estimatedAt = new Date(now - 90_000).toISOString();
    sqlMock.mockResolvedValueOnce([{
      owner_id: 'owner',
      context_tokens: 95_000,
      compaction_limit: 100_000,
      context_estimated_at: estimatedAt,
    }]);

    const readings = await fetchContextPressureReadings(['owner'], now);

    expect(readings.get('owner')).toEqual({ bucket: 'critical', estimatedAt, ageSec: 90 });
  });
});

describe('resolveContextPressureHeadroom (fleet-role aware)', () => {
  it('uses the fleet-member self-set ceiling instead of suggesting a rejected limit', async () => {
    sqlMock.mockResolvedValueOnce([{ context_tokens: 538_377, compaction_limit: 250_000 }]);
    fleetMock.mockResolvedValueOnce(new Map([['owner', { fleetSlug: 'fleet-a', fleetRole: 'member' }]]));
    measuredWindowMock.mockResolvedValueOnce(1_000_000);

    await expect(resolveContextPressureHeadroom('owner')).resolves.toEqual({
      contextTokens: 538_377,
      softLimit: 250_000,
      selfSetCeiling: 250_000,
    });
  });

  it('keeps the un-capped self-set ceiling for a solo or leader session', async () => {
    sqlMock.mockResolvedValueOnce([{ context_tokens: 362_523, compaction_limit: 250_000 }]);
    fleetMock.mockResolvedValueOnce(new Map([['owner', { fleetSlug: 'fleet-a', fleetRole: 'leader' }]]));
    measuredWindowMock.mockResolvedValueOnce(1_000_000);

    await expect(resolveContextPressureHeadroom('owner')).resolves.toEqual({
      contextTokens: 362_523,
      softLimit: 250_000,
      selfSetCeiling: 825_000,
    });
  });
});

describe('ContextPressureBucket type surface', () => {
  it('accepts the three literal buckets', () => {
    const buckets: ContextPressureBucket[] = ['ok', 'high', 'critical'];
    expect(buckets).toHaveLength(3);
  });
});
