/**
 * Scout signal accumulator (blender-self-learning-2026-07-12 P-001 / WI-4317).
 * Pure tests for the watermark derivation (last-run vs the bounded lookback
 * floor), the weighted new-signal score the P-002 cadence gate consumes
 * (score 0 = no fire; clamping of corrupt counts), the in-process sweep
 * throttle, and the env tunables / kill switches. The IO deps are mocked only
 * so importing the module has no load-time side effects (mirrors
 * ungraded-filings-watchdog.test.ts).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// A hoisted spy, so the P-006 tests can count statements; by default every
// statement resolves to no rows (importing the module has no IO side effects).
const pg = vi.hoisted(() => ({
  sql: vi.fn((..._args: unknown[]): Promise<unknown[]> => Promise.resolve([])),
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: pg.sql }) }));
vi.mock('../pot/started', () => ({
  listBlenderMaintenanceScopes: vi.fn(async () => []),
  listBlenderMaintenanceWorkspaceIds: vi.fn(() => []),
}));
vi.mock('./tick-ledger', () => ({ readLastRanTickAtMs: vi.fn(async () => null) }));

import {
  SIGNAL_LANES,
  DEFAULT_LANE_WEIGHTS,
  effectiveWatermarkMs,
  weightedSignalScore,
  shouldSweepNow,
  signalAccumulatorLookbackSec,
  signalAccumulatorSweepSec,
  scoutSignalAccumulatorSweep,
  strongerLaneCount,
  groupScopesByWorkspace,
  __resetSweepThrottleForTests,
  type LaneCount,
} from './signal-accumulator';

const NOW = Date.parse('2026-07-12T12:00:00Z');
const DAY = 86_400_000;

afterEach(() => {
  vi.unstubAllEnvs();
  __resetSweepThrottleForTests();
});

describe('effectiveWatermarkMs — the recount baseline', () => {
  it('uses the last successful run when it is inside the lookback window', () => {
    const lastRan = NOW - 2 * 3_600_000; // 2h ago, lookback 7d
    expect(effectiveWatermarkMs(lastRan, NOW, 604_800)).toBe(lastRan);
  });

  it('floors a never-ran scope at now - lookback (never scans from epoch)', () => {
    expect(effectiveWatermarkMs(null, NOW, 604_800)).toBe(NOW - 7 * DAY);
  });

  it('floors an ANCIENT last-run the same way (bounded scan)', () => {
    expect(effectiveWatermarkMs(NOW - 90 * DAY, NOW, 604_800)).toBe(NOW - 7 * DAY);
  });

  it('treats a non-finite last-run as never-ran', () => {
    expect(effectiveWatermarkMs(Number.NaN, NOW, 604_800)).toBe(NOW - 7 * DAY);
  });
});

describe('weightedSignalScore — what the cadence gate consumes', () => {
  it('scores zero on an empty / all-zero accumulator (score 0 never fires)', () => {
    expect(weightedSignalScore({})).toBe(0);
    expect(
      weightedSignalScore(Object.fromEntries(SIGNAL_LANES.map((l) => [l, 0]))),
    ).toBe(0);
  });

  it('applies the approved per-lane weights', () => {
    expect(weightedSignalScore({ 'scorecard-rating-changes': 2 })).toBe(6); // 3×
    expect(weightedSignalScore({ observations: 3 })).toBe(6); // 2×
    expect(weightedSignalScore({ captures: 4 })).toBe(4); // 1×
    expect(weightedSignalScore({ reverts: 1 })).toBe(3); // 3×
    expect(weightedSignalScore({ deferrals: 2 })).toBe(2); // 1×
    expect(weightedSignalScore({ completions: 4 })).toBe(2); // 0.5×
  });

  it('sums across lanes', () => {
    expect(weightedSignalScore({ observations: 1, reverts: 1, completions: 2 })).toBe(2 + 3 + 1);
  });

  it('ignores unknown lanes and clamps corrupt (negative / non-finite) counts', () => {
    expect(weightedSignalScore({ bogus: 100 } as never)).toBe(0);
    expect(weightedSignalScore({ observations: -5, captures: Number.NaN })).toBe(0);
    // A negative count in one lane must not mask real signal in another.
    expect(weightedSignalScore({ observations: -5, captures: 2 })).toBe(2);
  });

  it('accepts override weights (the per-routine cadence payload knob)', () => {
    const flat = Object.fromEntries(SIGNAL_LANES.map((l) => [l, 1])) as Record<
      (typeof SIGNAL_LANES)[number],
      number
    >;
    expect(weightedSignalScore({ 'scorecard-rating-changes': 2, completions: 2 }, flat)).toBe(4);
  });

  it('every declared lane carries a default weight', () => {
    for (const lane of SIGNAL_LANES) {
      expect(DEFAULT_LANE_WEIGHTS[lane]).toBeGreaterThan(0);
    }
  });
});

describe('shouldSweepNow — the in-process throttle', () => {
  it('always sweeps on a fresh process (null last-sweep)', () => {
    expect(shouldSweepNow(null, NOW, 120)).toBe(true);
  });

  it('withholds inside the window, allows at/after it', () => {
    expect(shouldSweepNow(NOW - 119_000, NOW, 120)).toBe(false);
    expect(shouldSweepNow(NOW - 120_000, NOW, 120)).toBe(true);
    expect(shouldSweepNow(NOW - 121_000, NOW, 120)).toBe(true);
  });
});

describe('env tunables', () => {
  it('lookback defaults to 7d and reads the env override', () => {
    expect(signalAccumulatorLookbackSec()).toBe(604_800);
    vi.stubEnv('PAPERCUSP_SIGNAL_ACCUM_LOOKBACK_SEC', '3600');
    expect(signalAccumulatorLookbackSec()).toBe(3600);
    vi.stubEnv('PAPERCUSP_SIGNAL_ACCUM_LOOKBACK_SEC', 'not-a-number');
    expect(signalAccumulatorLookbackSec()).toBe(604_800);
  });

  it('sweep throttle defaults to 120s and rejects negatives', () => {
    expect(signalAccumulatorSweepSec()).toBe(120);
    vi.stubEnv('PAPERCUSP_SIGNAL_ACCUM_SWEEP_SEC', '30');
    expect(signalAccumulatorSweepSec()).toBe(30);
    vi.stubEnv('PAPERCUSP_SIGNAL_ACCUM_SWEEP_SEC', '-1');
    expect(signalAccumulatorSweepSec()).toBe(120);
  });
});

describe('scoutSignalAccumulatorSweep — fail-soft shell', () => {
  it('kill switch (lookback <= 0) selects nothing and touches no IO', async () => {
    vi.stubEnv('PAPERCUSP_SIGNAL_ACCUM_LOOKBACK_SEC', '0');
    const { listBlenderMaintenanceScopes } = await import('../pot/started');
    await expect(scoutSignalAccumulatorSweep({ now: NOW })).resolves.toEqual([]);
    expect(vi.mocked(listBlenderMaintenanceScopes)).not.toHaveBeenCalled();
  });

  it('no registered Blender scopes and no eligible signal ⇒ quiet, and the throttle withholds the next tick', async () => {
    const { listBlenderMaintenanceScopes } = await import('../pot/started');
    vi.mocked(listBlenderMaintenanceScopes).mockResolvedValue([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(scoutSignalAccumulatorSweep({ now: NOW })).resolves.toEqual([]);
    expect(vi.mocked(listBlenderMaintenanceScopes)).toHaveBeenCalledTimes(1);
    // 30s later (a routinesTick) the throttle withholds — no second scope listing.
    await expect(scoutSignalAccumulatorSweep({ now: NOW + 30_000 })).resolves.toEqual([]);
    expect(vi.mocked(listBlenderMaintenanceScopes)).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never throws when the pot listing fails (fail-soft)', async () => {
    // The fail-soft path deliberately console.warns instead of throwing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { listBlenderMaintenanceScopes } = await import('../pot/started');
      vi.mocked(listBlenderMaintenanceScopes).mockRejectedValue(new Error('pg down'));
      await expect(scoutSignalAccumulatorSweep({ now: NOW })).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sweep failed'));
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * One recount per WORKSPACE (papercusp-performance-audit-2026-10-12 P-006).
 * Every lane count and the watermark are workspace-wide, yet the sweep used to
 * run the seven count statements once per install scope: 42 scopes in the live
 * workspace meant 42 identical recounts per sweep (measured 2026-10-12:
 * ~2.6 s of statement time and ~2.86 M shared buffers per recount).
 */
describe('scoutSignalAccumulatorSweep — one recount per workspace (P-006)', () => {
  const statementText = (call: unknown[]): string =>
    Array.isArray(call[0]) ? (call[0] as readonly string[]).join('?') : '';
  const isCount = (call: unknown[]) => /count\(\*\)/.test(statementText(call));
  const isUpsert = (call: unknown[]) => /INSERT INTO harness_shared\.scout_signal_accumulator/.test(statementText(call));
  const PER_WORKSPACE = { 'ws-a': 3, 'ws-b': 7 } as const;
  const HW = '2026-07-12T11:00:00.000Z';

  afterEach(() => {
    pg.sql.mockReset();
    pg.sql.mockImplementation(() => Promise.resolve([]));
  });

  async function sweepFourScopes() {
    const { listBlenderMaintenanceScopes } = await import('../pot/started');
    vi.mocked(listBlenderMaintenanceScopes).mockResolvedValue([
      { workspaceId: 'ws-a', installSlug: 'a1' },
      { workspaceId: 'ws-b', installSlug: 'b1' },
      { workspaceId: 'ws-a', installSlug: 'a2' },
      { workspaceId: 'ws-a', installSlug: 'a3' },
    ] as Awaited<ReturnType<typeof listBlenderMaintenanceScopes>>);
    // Every count statement interpolates the workspace id first; answer with a
    // per-workspace count so a cross-workspace mix-up is visible.
    pg.sql.mockImplementation((...call: unknown[]) => {
      if (!isCount(call)) return Promise.resolve([]);
      const ws = call[1] as keyof typeof PER_WORKSPACE;
      return Promise.resolve([{ c: PER_WORKSPACE[ws], hw: HW }]);
    });
    return scoutSignalAccumulatorSweep({ now: NOW });
  }

  it('runs each lane count statement once per workspace, not once per install scope', async () => {
    await sweepFourScopes();
    const counts = pg.sql.mock.calls.filter(isCount);
    // readLaneCounts issues 7 count statements (observations has two legs).
    expect(counts).toHaveLength(7 * 2);
    expect(counts.filter((c) => c[1] === 'ws-a')).toHaveLength(7);
    expect(counts.filter((c) => c[1] === 'ws-b')).toHaveLength(7);
  });

  it('writes the workspace recount to every scope of that workspace in one upsert', async () => {
    await sweepFourScopes();
    const upserts = pg.sql.mock.calls.filter(isUpsert);
    expect(upserts).toHaveLength(2);
    const byWorkspace = new Map(upserts.map((c) => [c[1] as string, c]));
    // Interpolation order: workspace, watermark, install slugs, lanes, counts, high-waters.
    expect(byWorkspace.get('ws-a')?.[3]).toEqual(['a1', 'a2', 'a3']);
    expect(byWorkspace.get('ws-b')?.[3]).toEqual(['b1']);
    expect(byWorkspace.get('ws-a')?.[4]).toEqual([...SIGNAL_LANES]);
    expect(byWorkspace.get('ws-a')?.[5]).toEqual(SIGNAL_LANES.map(() => 3));
    expect(byWorkspace.get('ws-b')?.[5]).toEqual(SIGNAL_LANES.map(() => 7));
    expect(byWorkspace.get('ws-a')?.[6]).toEqual(SIGNAL_LANES.map(() => HW));
  });

  it('reports one swept result per scope, carrying its own workspace counts', async () => {
    const results = await sweepFourScopes();
    expect(results.map((r) => `${r.workspaceId}/${r.installSlug}`)).toEqual(['ws-a/a1', 'ws-a/a2', 'ws-a/a3', 'ws-b/b1']);
    for (const r of results) {
      expect(r.outcome).toBe('swept');
      expect(r.evaluatedWorkspaceCount).toBe(2);
      expect(r.evaluatedScopeCount).toBe(4);
      const n = PER_WORKSPACE[r.workspaceId as keyof typeof PER_WORKSPACE];
      expect(r.eligibleBacklogCount).toBe(n * SIGNAL_LANES.length);
      expect(r.score).toBe(weightedSignalScore(Object.fromEntries(SIGNAL_LANES.map((l) => [l, n]))));
    }
  });

  it('marks every scope of a workspace as error when its recount fails, and still sweeps the others', async () => {
    const { listBlenderMaintenanceScopes } = await import('../pot/started');
    vi.mocked(listBlenderMaintenanceScopes).mockResolvedValue([
      { workspaceId: 'ws-a', installSlug: 'a1' },
      { workspaceId: 'ws-a', installSlug: 'a2' },
      { workspaceId: 'ws-b', installSlug: 'b1' },
    ] as Awaited<ReturnType<typeof listBlenderMaintenanceScopes>>);
    pg.sql.mockImplementation((...call: unknown[]) => {
      if (isCount(call) && call[1] === 'ws-a') return Promise.reject(new Error('statement timeout'));
      if (isCount(call)) return Promise.resolve([{ c: 1, hw: HW }]);
      return Promise.resolve([]);
    });
    const results = await scoutSignalAccumulatorSweep({ now: NOW });
    expect(results.map((r) => [r.installSlug, r.outcome, r.reason])).toEqual([
      ['a1', 'error', 'statement timeout'],
      ['a2', 'error', 'statement timeout'],
      ['b1', 'swept', SIGNAL_LANES.map((l) => `${l}=1`).join(' ')],
    ]);
    expect(pg.sql.mock.calls.filter(isUpsert).map((c) => c[1])).toEqual(['ws-b']);
  });
});

describe('groupScopesByWorkspace', () => {
  it('groups by workspace in first-seen order and drops a repeated install slug', () => {
    expect(
      groupScopesByWorkspace([
        { workspaceId: 'w2', installSlug: 'x' },
        { workspaceId: 'w1', installSlug: 'y' },
        { workspaceId: 'w2', installSlug: 'z' },
        { workspaceId: 'w2', installSlug: 'x' },
      ]),
    ).toEqual([
      { workspaceId: 'w2', installSlugs: ['x', 'z'] },
      { workspaceId: 'w1', installSlugs: ['y'] },
    ]);
  });

  it('returns no groups for no scopes', () => {
    expect(groupScopesByWorkspace([])).toEqual([]);
  });
});

/**
 * strongerLaneCount — the observations lane's two-leg ratchet
 * (learning-loop-identity-and-consumption-2026-08-08 D-043).
 *
 * P-013 lets an agent's observation FOLD onto an existing row instead of
 * minting one. The filing lands either way, but a row-based count cannot see a
 * fold, so counting rows would have reported a signal collapse that never
 * happened and made the Scout fire less — silencing agents by measurement.
 * The lane therefore reads two legs (rows minted, filings recorded) and takes
 * the stronger. These tests fix the property that makes that safe: the
 * combined count is never below EITHER leg, so no failure of either one can
 * push the lane below the basis it replaced.
 */
describe('strongerLaneCount — the observations lane cannot report less signal than before', () => {
  const at = (iso: string | null): Date | null => (iso === null ? null : new Date(iso));
  const lane = (newCount: number, hw: string | null): LaneCount => ({
    lane: 'observations',
    newCount,
    highWaterAt: at(hw),
  });

  it('takes the greater count — folding raises the filings leg above the rows leg', () => {
    // The post-P-013 steady state: fewer rows minted than filings received.
    const rows = lane(40, '2026-07-12T11:00:00Z');
    const filings = lane(140, '2026-07-12T11:30:00Z');
    expect(strongerLaneCount(rows, filings).newCount).toBe(140);
  });

  it('is symmetric — argument order cannot change the answer', () => {
    const rows = lane(40, '2026-07-12T11:00:00Z');
    const filings = lane(140, '2026-07-12T11:30:00Z');
    expect(strongerLaneCount(filings, rows).newCount).toBe(strongerLaneCount(rows, filings).newCount);
  });

  it('THE RATCHET: a dead filings leg falls back to the row count, never to zero', () => {
    // If the occurrence ledger stops being written, the filings leg reads 0.
    // Taking the max means the lane degrades to exactly today's behaviour
    // rather than reporting silence.
    const rows = lane(37, '2026-07-12T11:00:00Z');
    const ledgerDown = lane(0, null);
    expect(strongerLaneCount(rows, ledgerDown).newCount).toBe(37);
  });

  it('THE RATCHET, other direction: a fold-suppressed row leg falls back to the filings count', () => {
    const allFolded = lane(0, null);
    const filings = lane(212, '2026-07-12T11:30:00Z');
    expect(strongerLaneCount(allFolded, filings).newCount).toBe(212);
  });

  it('both legs silent is genuinely 0 — a quiet pot must still be able to NOT fire', () => {
    // The ratchet must not manufacture signal: "score 0 never fires" is the
    // whole point of the accumulator, so a real quiet window has to survive it.
    const combined = strongerLaneCount(lane(0, null), lane(0, null));
    expect(combined.newCount).toBe(0);
    expect(combined.highWaterAt).toBeNull();
  });

  it('advances the high-water mark to whichever leg saw signal LATEST, independent of which counted more', () => {
    // Deliberately crossed: the smaller count carries the later timestamp.
    const rows = lane(500, '2026-07-12T11:00:00Z');
    const filings = lane(3, '2026-07-12T11:45:00Z');
    expect(strongerLaneCount(rows, filings).highWaterAt?.toISOString()).toBe('2026-07-12T11:45:00.000Z');
  });

  it('a null high-water mark never beats a real one', () => {
    expect(strongerLaneCount(lane(5, '2026-07-12T11:00:00Z'), lane(9, null)).highWaterAt?.toISOString()).toBe(
      '2026-07-12T11:00:00.000Z',
    );
  });

  it('preserves the lane label', () => {
    expect(strongerLaneCount(lane(1, null), lane(2, null)).lane).toBe('observations');
  });

  /**
   * P-014 falsifiability control (tier-2 / module route — a permanent
   * wrong-implementation kept IN the test file, never an in-tree mutation of
   * the shared checkout).
   *
   * The risk with a max() ratchet is that a plausible-looking alternative —
   * "just use the new filings leg" — passes most of the tests above while
   * quietly reintroducing the silencing this exists to prevent. These two
   * cases prove the suite can TELL THEM APART: the wrong impls fail exactly
   * where the real one holds, so a green run is evidence about behaviour and
   * not merely that the tests ran.
   */
  describe('CONTROLS: the assertions above actually discriminate', () => {
    const takeFilingsLeg = (_rows: LaneCount, filings: LaneCount): LaneCount => filings;
    const takeRowsLeg = (rows: LaneCount, _filings: LaneCount): LaneCount => rows;

    it('"just use the filings leg" is caught by the dead-ledger case', () => {
      const rows = lane(37, '2026-07-12T11:00:00Z');
      const ledgerDown = lane(0, null);
      expect(takeFilingsLeg(rows, ledgerDown).newCount).toBe(0); // the wrong answer…
      expect(strongerLaneCount(rows, ledgerDown).newCount).toBe(37); // …vs the real one
    });

    it('"keep counting rows" is caught by the folding case — this is the D-043 silencing itself', () => {
      const allFolded = lane(0, null);
      const filings = lane(212, '2026-07-12T11:30:00Z');
      expect(takeRowsLeg(allFolded, filings).newCount).toBe(0); // Scout goes quiet…
      expect(strongerLaneCount(allFolded, filings).newCount).toBe(212); // …and this is why it must not
    });

    it('CALIBRATION: both wrong impls agree with the real one when the legs match, so the controls above are not vacuous', () => {
      const a = lane(50, '2026-07-12T11:00:00Z');
      const b = lane(50, '2026-07-12T11:00:00Z');
      expect(takeFilingsLeg(a, b).newCount).toBe(strongerLaneCount(a, b).newCount);
      expect(takeRowsLeg(a, b).newCount).toBe(strongerLaneCount(a, b).newCount);
    });
  });
});
