import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import { PLATFORM_POT_SLUG } from '../pot-membership';
import {
  readScoutSnapshot,
  normalizeScoutTick,
  isUndefinedTable,
  evaluateIdeasDriftMarkers,
  type ScoutTickEconomics,
  type ScoutRoutedItem,
} from './learning-scout-read';

/**
 * learning-scout-read — the Learning tab Scout reader (learning-system-audit
 * P-042). The PG seam is an injected Sql, so the tests stub the tagged-template
 * call and pin the two contracts that matter:
 *   - rail aggregation (count-by-rail + total) over scout_routed_ideas;
 *   - the tick half is BEST-EFFORT: scout_ticks may not exist yet (P-034 lands
 *     it separately) — undefined-table silently omits it, any other error warns
 *     + omits, and a present row is normalized across plausible column names.
 */

type Handler = () => Promise<Array<Record<string, unknown>>>;

function fakeSql(opts: {
  rails?: Handler;
  items?: Handler;
  ticks?: Handler;
  weights?: Handler;
  /** The P-002 per-cycle lens join (GROUP BY cycle_id over scout_routed_ideas). */
  lensJoin?: Handler;
  /** The P-003 newest-N origin='scout' lens sample (query tagged newest-lens-sample). */
  lensSample?: Handler;
  /** The P-004 wi:-ref title lookup over engineer_issues (query tagged grounding-titles). */
  groundingTitles?: Handler;
  /** The WI-5417 browseable digest-history read over scout_digest_snapshots. */
  digestSnapshots?: Handler;
}): Sql {
  const fn = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const text = strings.join(' ');
    // Both ledger reads hit scout_routed_ideas — the aggregate groups by rail,
    // the per-item read selects idea_id. The lens-weight half (C-1c) reads
    // scout_lens_weights through routed-ledger's readScoutLensWeights with
    // THIS injected sql. The P-002 economics leg adds the per-cycle lens join
    // (GROUP BY cycle_id). NOTE: readScoutSnapshot also calls sql(cycleIds) as
    // the postgres list helper — that lands here with a plain string[] whose
    // join matches nothing, so it falls through to the empty default (a value
    // fragment, never awaited).
    if (text.includes('GROUP BY rail')) return (opts.rails ?? (async () => []))();
    if (text.includes('GROUP BY cycle_id')) return (opts.lensJoin ?? (async () => []))();
    if (text.includes('newest-lens-sample')) return (opts.lensSample ?? (async () => []))();
    if (text.includes('grounding-titles')) return (opts.groundingTitles ?? (async () => []))();
    if (text.includes('scout_lens_weights')) return (opts.weights ?? (async () => []))();
    if (text.includes('scout_digest_snapshots')) return (opts.digestSnapshots ?? (async () => []))();
    if (text.includes('idea_id')) return (opts.items ?? (async () => []))();
    if (text.includes('scout_ticks')) return (opts.ticks ?? (async () => []))();
    return Promise.resolve([]);
  };
  return fn as unknown as Sql;
}

afterEach(() => vi.restoreAllMocks());

describe('readScoutSnapshot', () => {
  it('aggregates rail counts + total and normalizes the newest tick (migration-208 shape)', async () => {
    const sql = fakeSql({
      rails: async () => [
        { rail: 'plan', count: 3 },
        { rail: 'gym', count: 1 },
      ],
      ticks: async () => [
        { tick_at: new Date('2026-06-09T08:00:00Z'), status: 'gated', gate: 'min-interval', detail: null },
      ],
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.totalRouted).toBe(4);
    expect(snap.railCounts).toEqual([
      { rail: 'plan', count: 3 },
      { rail: 'gym', count: 1 },
    ]);
    expect(snap.lastTick).toEqual({
      at: '2026-06-09T08:00:00.000Z',
      outcome: 'gated',
      detail: 'min-interval',
    });
  });

  it('maps the recent routed-idea rows into the UI shape (epoch-ms routed_at, null-safe optionals, grade fields)', async () => {
    const sql = fakeSql({
      rails: async () => [{ rail: 'plan', count: 1 }],
      items: async () => [
        {
          idea_id: 'scout-idea-reframing-1-0',
          lens: 'reframing',
          rail: 'plan',
          routed_ref: 'plan:scout-something-2026-06-11',
          title: 'A reframed idea',
          routed_at: '1781210000000', // bigint arrives as a string
          outcome: null,
          // ungraded row: grade columns NULL (or absent pre-migration-234)
          human_grade: null,
          human_feedback: null,
          graded_by: null,
        },
        {
          idea_id: 'scout-idea-analogical-1-0',
          lens: 'analogical',
          rail: 'improvement',
          routed_ref: 'wi:EI-340',
          title: null,
          routed_at: null,
          outcome: 'won',
          human_grade: 4,
          human_feedback: 'sharp framing, do more of these',
          graded_by: 'auto-grader',
          origin: 'scout',
          cycle_id: 'scout-42',
          addresses_pattern_refs: ['wi:EI-100', 'fact:workspace:some-standing-fact', 42], // non-strings filtered
        },
      ],
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.recent).toEqual([
      {
        ideaId: 'scout-idea-reframing-1-0',
        lens: 'reframing',
        rail: 'plan',
        routedRef: 'plan:scout-something-2026-06-11',
        title: 'A reframed idea',
        routedAt: new Date(1781210000000).toISOString(),
        outcome: null,
        humanGrade: null,
        humanFeedback: null,
        gradedBy: null,
        origin: null,
        cycleId: null,
        addressesPatternRefs: [],
        harnessSlug: null,
      },
      {
        ideaId: 'scout-idea-analogical-1-0',
        lens: 'analogical',
        rail: 'improvement',
        routedRef: 'wi:EI-340',
        title: null,
        routedAt: null,
        outcome: 'won',
        humanGrade: 4,
        humanFeedback: 'sharp framing, do more of these',
        gradedBy: 'auto-grader',
        origin: 'scout',
        cycleId: 'scout-42',
        addressesPatternRefs: ['wi:EI-100', 'fact:workspace:some-standing-fact'],
        harnessSlug: null,
      },
    ]);
  });

  it('omits the tick half silently when scout_ticks does not exist yet (42P01)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({
      rails: async () => [],
      ticks: async () => {
        throw Object.assign(new Error('relation "harness_shared.scout_ticks" does not exist'), { code: '42P01' });
      },
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    // This test's contract is the TICK half: on 42P01 it is omitted SILENTLY
    // (lastTick null / ticks empty, no warn). Assert that plus the empty-state
    // ledger halves — but with toMatchObject, NOT a closed-world toEqual: the
    // snapshot grows additive best-effort legs over time (cadence P-001, drafts
    // P-005, …), each landing as a new default-valued field, and an exact-match
    // here would re-red the green gate on every such addition without testing
    // anything this case is about. Extra additive fields are fine; the values
    // below are still pinned exactly.
    expect(snap).toMatchObject({
      totalRouted: 0,
      railCounts: [],
      recent: [],
      lastTick: null,
      ticks: [],
      health: { status: 'neutral', markers: [] },
      lensWeights: null,
      groundingTitles: {},
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns + omits the tick half on any other tick-read error (column drift etc.)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({
      rails: async () => [{ rail: 'wi', count: 2 }],
      ticks: async () => {
        throw Object.assign(new Error('column "tick_at" does not exist'), { code: '42703' });
      },
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.railCounts).toEqual([{ rail: 'wi', count: 2 }]); // rail half survives
    expect(snap.lastTick).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('surfaces the persisted lens weights (C-1c), filtered to known lenses', async () => {
    const sql = fakeSql({
      weights: async () => [
        { lens: 'scout.lens-analogical', weight: '0.4' }, // numeric arrives as a string
        { lens: 'scout.lens-reframing', weight: 0.35 },
        { lens: 'not-a-lens', weight: 0.25 }, // unknown lens ids are ignored
        { lens: 'analogical', weight: 0.5 }, // a pre-R-8 bare lens-name key is ignored (P-011)
      ],
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.lensWeights).toEqual({ 'scout.lens-analogical': 0.4, 'scout.lens-reframing': 0.35 });
  });

  it('lensWeights is null when no weight rows are recorded yet', async () => {
    const snap = await readScoutSnapshot(fakeSql({}), 'ws-1');
    expect(snap.lensWeights).toBeNull();
  });

  it('lensWeights degrades to null (warn, never a crash) when the weight read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({
      rails: async () => [{ rail: 'plan', count: 1 }],
      weights: async () => {
        throw Object.assign(new Error('permission denied'), { code: '42501' });
      },
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.lensWeights).toBeNull();
    expect(snap.totalRouted).toBe(1); // the routed half survives
    expect(warn).toHaveBeenCalled();
  });
});

describe('grounding titles (learning-tab-alignment P-004 pipeline trace)', () => {
  const itemsWithRefs: Handler = async () => [
    {
      idea_id: 'i-1',
      lens: 'analogical',
      rail: 'improvement',
      routed_ref: 'wi:EI-500',
      addresses_pattern_refs: ['wi:EI-100', 'wi:EI-101', 'fact:workspace:readable-slug'],
      routed_at: '1781210000000',
    },
    {
      idea_id: 'i-2',
      lens: 'first-principles',
      rail: 'gym',
      routed_ref: 'gym:SP-001',
      addresses_pattern_refs: ['wi:EI-100', 'watchdog:papercusp-governor-starvation'], // EI-100 deduped across rows
      routed_at: '1781209000000',
    },
  ];

  it('resolves the wi: grounding refs to titles, keyed by the FULL ref (non-wi refs not looked up)', async () => {
    const sql = fakeSql({
      items: itemsWithRefs,
      groundingTitles: async () => [
        { issue_id: 'EI-100', title: 'coord invariant: wake-queue depth growth' },
        { issue_id: 'EI-101', title: null }, // titleless row — no entry
      ],
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.groundingTitles).toEqual({ 'wi:EI-100': 'coord invariant: wake-queue depth growth' });
    // and the refs themselves ride the recent rows for the trace UI
    expect(snap.recent[0].addressesPatternRefs).toEqual(['wi:EI-100', 'wi:EI-101', 'fact:workspace:readable-slug']);
  });

  it('skips the lookup entirely when no recent row carries a wi: ref', async () => {
    let lookups = 0;
    const sql = fakeSql({
      items: async () => [
        { idea_id: 'i-1', lens: 'analogical', rail: 'gym', routed_ref: 'gym:SP-1', addresses_pattern_refs: ['fact:workspace:x'] },
      ],
      groundingTitles: async () => {
        lookups += 1;
        return [];
      },
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(lookups).toBe(0);
    expect(snap.groundingTitles).toEqual({});
  });

  it('degrades to {} (warn, never a crash) when the title read fails — the trace falls back to raw refs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({
      items: itemsWithRefs,
      groundingTitles: async () => {
        throw Object.assign(new Error('permission denied'), { code: '42501' });
      },
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.groundingTitles).toEqual({});
    expect(snap.recent).toHaveLength(2); // the routed half survives
    expect(warn).toHaveBeenCalled();
  });
});

describe('tick economics (learning-tab-alignment P-002)', () => {
  it('maps the newest ticks into economics rows — stop from detail.stop / gate / error, spend numeric-string safe, funnel counts', async () => {
    const sql = fakeSql({
      ticks: async () => [
        {
          tick_at: new Date('2026-07-13T04:00:00Z'),
          status: 'ran',
          gate: null,
          ideas_generated: 8,
          ideas_routed: 3,
          ideas_deduped: 2,
          budget_used_usd: '1.673', // numeric arrives as a string
          detail: { stop: 'completed', cycleId: 'scout-100' },
        },
        {
          tick_at: new Date('2026-07-13T03:30:00Z'),
          status: 'ran',
          gate: null,
          ideas_generated: 32,
          ideas_routed: 0,
          ideas_deduped: 0,
          budget_used_usd: 3.603,
          detail: { stop: 'budget-exhausted', cycleId: 'scout-99' },
        },
        {
          tick_at: new Date('2026-07-13T03:00:00Z'),
          status: 'gated',
          gate: 'min-interval',
          ideas_generated: 0,
          ideas_routed: 0,
          ideas_deduped: 0,
          budget_used_usd: null,
          detail: null,
        },
        {
          tick_at: new Date('2026-07-13T02:30:00Z'),
          status: 'error',
          gate: null,
          ideas_generated: 0,
          ideas_routed: 0,
          ideas_deduped: 0,
          budget_used_usd: null,
          detail: { error: 'cycle threw: rate-limit pause exceeds maxWait' },
        },
      ],
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.ticks).toEqual([
      {
        at: '2026-07-13T04:00:00.000Z',
        status: 'ran',
        stop: 'completed',
        generated: 8,
        routed: 3,
        deduped: 2,
        spendUsd: 1.673,
        cycleId: 'scout-100',
        lenses: {},
        groundingLanes: {},
      },
      {
        at: '2026-07-13T03:30:00.000Z',
        status: 'ran',
        stop: 'budget-exhausted',
        generated: 32,
        routed: 0,
        deduped: 0,
        spendUsd: 3.603,
        cycleId: 'scout-99',
        lenses: {},
        groundingLanes: {},
      },
      {
        at: '2026-07-13T03:00:00.000Z',
        status: 'gated',
        stop: 'min-interval',
        generated: 0,
        routed: 0,
        deduped: 0,
        spendUsd: null,
        cycleId: null,
        lenses: {},
        groundingLanes: {},
      },
      {
        at: '2026-07-13T02:30:00.000Z',
        status: 'error',
        stop: 'cycle threw: rate-limit pause exceeds maxWait',
        generated: 0,
        routed: 0,
        deduped: 0,
        spendUsd: null,
        cycleId: null,
        lenses: {},
        groundingLanes: {},
      },
    ]);
    // lastTick stays derived from row 0 (back-compat with the pre-P-002 shape).
    expect(snap.lastTick).toEqual({ at: '2026-07-13T04:00:00.000Z', outcome: 'ran', detail: 'completed' });
  });

  it('joins per-cycle lens counts onto the ticks that have a cycleId', async () => {
    const sql = fakeSql({
      ticks: async () => [
        {
          tick_at: new Date('2026-07-13T04:00:00Z'),
          status: 'ran',
          ideas_generated: 8,
          ideas_routed: 3,
          ideas_deduped: 2,
          budget_used_usd: 1.5,
          detail: { stop: 'completed', cycleId: 'scout-100' },
        },
        {
          tick_at: new Date('2026-07-13T03:00:00Z'),
          status: 'gated',
          gate: 'no-trigger',
          detail: null,
        },
      ],
      lensJoin: async () => [
        { cycle_id: 'scout-100', lens: 'first-principles', count: 2 },
        { cycle_id: 'scout-100', lens: 'analogical', count: 1 },
        { cycle_id: 'scout-999', lens: 'reframing', count: 4 }, // not one of our ticks — ignored
      ],
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.ticks[0].lenses).toEqual({ 'first-principles': 2, analogical: 1 });
    expect(snap.ticks[1].lenses).toEqual({});
  });

  it('economics degrade to [] with lastTick when the tick read fails (never fails the routed half)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({
      rails: async () => [{ rail: 'plan', count: 2 }],
      ticks: async () => {
        throw Object.assign(new Error('column drift'), { code: '42703' });
      },
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.ticks).toEqual([]);
    expect(snap.totalRouted).toBe(2);
    expect(warn).toHaveBeenCalled();
  });
});

// ── P-003: the drift-marker evaluator (the rubric's driftMarkers as code) ──────

const mkTick = (over: Partial<ScoutTickEconomics>): ScoutTickEconomics => ({
  at: '2026-07-13T04:00:00.000Z',
  status: 'ran',
  stop: 'completed',
  generated: 8,
  routed: 3,
  deduped: 2,
  spendUsd: 1.5,
  cycleId: 'scout-1',
  lenses: {},
  groundingLanes: {},
  ...over,
});

const mkIdea = (over: Partial<ScoutRoutedItem>): ScoutRoutedItem => ({
  ideaId: 'i-1',
  lens: 'analogical',
  rail: 'improvement',
  routedRef: 'wi:EI-1',
  title: null,
  routedAt: null,
  outcome: null,
  humanGrade: null,
  humanFeedback: null,
  gradedBy: null,
  origin: 'scout',
  cycleId: null,
  harnessSlug: null,
  addressesPatternRefs: [],
  ...over,
});

describe('evaluateIdeasDriftMarkers (P-003 — the rubric driftMarkers as the health spec)', () => {
  it('fires single-lens-collapse at >=90% dominance (warn) and 100% (bad) — multi-lens-routing criterion', () => {
    const warn90 = evaluateIdeasDriftMarkers({
      ticks: [],
      recent: [],
      scoutLensSample: [...Array(19).fill('analogical'), 'first-principles'],
    });
    expect(warn90.markers).toEqual([
      expect.objectContaining({ key: 'single-lens-collapse', severity: 'warn', rubricCriterion: 'multi-lens-routing' }),
    ]);
    expect(warn90.status).toBe('warn');

    const bad100 = evaluateIdeasDriftMarkers({
      ticks: [],
      recent: [],
      scoutLensSample: Array(20).fill('analogical'),
    });
    expect(bad100.markers[0]).toMatchObject({ key: 'single-lens-collapse', severity: 'bad' });
    expect(bad100.status).toBe('bad');
  });

  it('does NOT fire collapse on a healthy mix or a tiny sample', () => {
    const healthy = evaluateIdeasDriftMarkers({
      ticks: [],
      recent: [],
      scoutLensSample: [...Array(15).fill('analogical'), ...Array(5).fill('first-principles')],
    });
    expect(healthy.markers).toEqual([]);
    // 3 rows of one lens is a fresh install, not a collapse (LENS_SAMPLE_MIN).
    const tiny = evaluateIdeasDriftMarkers({ ticks: [], recent: [], scoutLensSample: Array(3).fill('analogical') });
    expect(tiny.markers).toEqual([]);
  });

  it('fires budget-exhausted-streak on 2+ leading spend-no-yield ran-ticks (bad at 4+), gated ticks not breaking the streak', () => {
    const starved = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        mkTick({ stop: 'budget-exhausted', routed: 0, generated: 30, cycleId: `scout-${i}` }),
      );
    const two = evaluateIdeasDriftMarkers({
      ticks: [starved(1)[0], mkTick({ status: 'gated', stop: 'min-interval', generated: 0, routed: 0, cycleId: null }), starved(1)[0], mkTick({})],
      recent: [],
      scoutLensSample: [],
    });
    expect(two.markers).toEqual([
      expect.objectContaining({ key: 'budget-exhausted-streak', severity: 'warn', rubricCriterion: 'multi-lens-routing' }),
    ]);

    const four = evaluateIdeasDriftMarkers({ ticks: starved(4), recent: [], scoutLensSample: [] });
    expect(four.markers[0]).toMatchObject({ key: 'budget-exhausted-streak', severity: 'bad' });
  });

  it('does NOT fire the streak when the newest ran-tick routed something', () => {
    const h = evaluateIdeasDriftMarkers({
      ticks: [mkTick({}), mkTick({ stop: 'budget-exhausted', routed: 0 }), mkTick({ stop: 'budget-exhausted', routed: 0 })],
      recent: [],
      scoutLensSample: [],
    });
    expect(h.markers).toEqual([]);
    expect(h.status).toBe('good');
  });

  it('fires grading-starvation when 10+ filings sit fully ungraded — grading-loop-closure criterion', () => {
    const starving = evaluateIdeasDriftMarkers({
      ticks: [],
      recent: Array.from({ length: 12 }, (_, i) => mkIdea({ ideaId: `i-${i}` })),
      scoutLensSample: [],
    });
    expect(starving.markers).toEqual([
      expect.objectContaining({ key: 'grading-starvation', severity: 'warn', rubricCriterion: 'grading-loop-closure' }),
    ]);

    const oneGraded = evaluateIdeasDriftMarkers({
      ticks: [],
      recent: [mkIdea({ humanGrade: 4 }), ...Array.from({ length: 11 }, (_, i) => mkIdea({ ideaId: `i-${i}` }))],
      scoutLensSample: [],
    });
    expect(oneGraded.markers).toEqual([]);
  });

  it('status: neutral with no data at all; good with data and no fired markers', () => {
    expect(evaluateIdeasDriftMarkers({ ticks: [], recent: [], scoutLensSample: [] }).status).toBe('neutral');
    expect(evaluateIdeasDriftMarkers({ ticks: [mkTick({})], recent: [], scoutLensSample: [] }).status).toBe('good');
  });

  it('readScoutSnapshot wires the sample through: a fully-collapsed newest-20 yields health bad', async () => {
    const sql = fakeSql({
      lensSample: async () => Array.from({ length: 20 }, () => ({ lens: 'analogical' })),
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.health.status).toBe('bad');
    expect(snap.health.markers[0]).toMatchObject({ key: 'single-lens-collapse' });
  });
});

// ── WI-5417: browseable digest history (newest ~10 snapshots, one selected) ──

/** A minimal valid CorpusDigest row shape as the raw jsonb the PG read returns. */
const mkDigestRow = (opts: {
  cycleId: string;
  createdAt: Date;
  refs: string[];
  previousCycleRefs?: string[];
}): Record<string, unknown> => ({
  cycle_id: opts.cycleId,
  watermark_at: opts.createdAt,
  created_at: opts.createdAt,
  digest: {
    recurringFriction: opts.refs.map((ref, i) => ({ summary: `pattern ${ref}`, ref, weight: 1 - i * 0.05 })),
    timeTokenSinks: [],
    chronicDeferrals: [],
    capabilityGaps: [],
    previousCycleRefs: opts.previousCycleRefs ?? [],
  },
});

describe('digest history (WI-5417 browseable per-cycle digest)', () => {
  // Newest-first, as the read's ORDER BY created_at DESC delivers them.
  const row3 = mkDigestRow({
    cycleId: 'scout-3',
    createdAt: new Date('2026-07-18T03:00:00Z'),
    refs: ['wi:EI-3', 'wi:EI-4'],
    previousCycleRefs: ['wi:EI-1', 'wi:EI-2'], // both refs are new vs previous
  });
  const row2 = mkDigestRow({
    cycleId: 'scout-2',
    createdAt: new Date('2026-07-18T02:00:00Z'),
    refs: ['wi:EI-1', 'wi:EI-2'],
    previousCycleRefs: ['wi:EI-1'], // EI-2 new, EI-1 standing
  });
  const row1 = mkDigestRow({
    cycleId: 'scout-1',
    createdAt: new Date('2026-07-18T01:00:00Z'),
    refs: ['wi:EI-1'],
    previousCycleRefs: [], // first-ever snapshot: nothing is provably new
  });

  it('summarizes the newest rows into digestHistory (newest first) and defaults `digest` to the newest row', async () => {
    const sql = fakeSql({ digestSnapshots: async () => [row3, row2, row1] });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.digestHistory).toEqual([
      { cycleId: 'scout-3', at: '2026-07-18T03:00:00.000Z', totalEntries: 2, newCount: 2, standingCount: 0 },
      { cycleId: 'scout-2', at: '2026-07-18T02:00:00.000Z', totalEntries: 2, newCount: 1, standingCount: 1 },
      { cycleId: 'scout-1', at: '2026-07-18T01:00:00.000Z', totalEntries: 1, newCount: 0, standingCount: 1 },
    ]);
    expect(snap.digest?.cycleId).toBe('scout-3');
    expect(snap.digest?.newEntries.map((e) => e.ref)).toEqual(['wi:EI-3', 'wi:EI-4']);
    expect(snap.digest?.standingEntries).toEqual([]);
  });

  it("selects the caller-requested cycle's full entries while digestHistory still lists every row read", async () => {
    const sql = fakeSql({ digestSnapshots: async () => [row3, row2, row1] });
    const snap = await readScoutSnapshot(sql, 'ws-1', { selectedCycleId: 'scout-2' });
    expect(snap.digest?.cycleId).toBe('scout-2');
    expect(snap.digest?.newEntries.map((e) => e.ref)).toEqual(['wi:EI-2']);
    expect(snap.digest?.standingEntries.map((e) => e.ref)).toEqual(['wi:EI-1']);
    // The selection only narrows `digest` — digestHistory is the full read set,
    // unaffected, so the UI's history strip never loses entries on selection.
    expect(snap.digestHistory.map((h) => h.cycleId)).toEqual(['scout-3', 'scout-2', 'scout-1']);
  });

  it('falls back to the newest cycle when the requested cycleId is not among the rows read (stale/expired selection)', async () => {
    const sql = fakeSql({ digestSnapshots: async () => [row3, row2, row1] });
    const snap = await readScoutSnapshot(sql, 'ws-1', { selectedCycleId: 'scout-does-not-exist' });
    expect(snap.digest?.cycleId).toBe('scout-3');
  });

  it('LEGACY-ROW HEAL (owner-reported 2026-07-19): a stamp-less row with an older sibling derives its delta from the sibling instead of reading all-standing', async () => {
    // Pre-fix persisted rows carry NO previousCycleRefs (the writer stamped AFTER
    // persisting) — the symptom was EVERY cycle showing "the delta leg was empty".
    const legacyNewest = mkDigestRow({
      cycleId: 'scout-legacy-2',
      createdAt: new Date('2026-07-18T05:00:00Z'),
      refs: ['wi:EI-1', 'wi:EI-9'], // EI-9 new vs the sibling below
      previousCycleRefs: [],
    });
    const legacyOlder = mkDigestRow({
      cycleId: 'scout-legacy-1',
      createdAt: new Date('2026-07-18T04:00:00Z'),
      refs: ['wi:EI-1'],
      previousCycleRefs: [],
    });
    const sql = fakeSql({ digestSnapshots: async () => [legacyNewest, legacyOlder] });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.digest?.cycleId).toBe('scout-legacy-2');
    expect(snap.digest?.newEntries.map((e) => e.ref)).toEqual(['wi:EI-9']);
    expect(snap.digest?.standingEntries.map((e) => e.ref)).toEqual(['wi:EI-1']);
    expect(snap.digestHistory[0]).toMatchObject({ cycleId: 'scout-legacy-2', newCount: 1, standingCount: 1 });
    // The oldest-fetched row has no sibling — keeps the all-standing rule.
    expect(snap.digestHistory[1]).toMatchObject({ cycleId: 'scout-legacy-1', newCount: 0, standingCount: 1 });
    // A row's OWN stamped baseline always wins over sibling derivation (row2's
    // stamp says EI-1 standing even though a sibling-derivation would agree here;
    // the mixed fixture set above — row3/row2/row1 — pins the stamped path).
  });

  it('the first-ever snapshot (no previousCycleRefs) reads entirely as standing, never mislabeled new', async () => {
    const sql = fakeSql({ digestSnapshots: async () => [row1] });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.digest?.newEntries).toEqual([]);
    expect(snap.digest?.standingEntries.map((e) => e.ref)).toEqual(['wi:EI-1']);
    expect(snap.digestHistory).toEqual([
      { cycleId: 'scout-1', at: '2026-07-18T01:00:00.000Z', totalEntries: 1, newCount: 0, standingCount: 1 },
    ]);
  });

  it('digest and digestHistory both stay empty/null when no snapshot rows exist', async () => {
    const snap = await readScoutSnapshot(fakeSql({}), 'ws-1');
    expect(snap.digest).toBeNull();
    expect(snap.digestHistory).toEqual([]);
  });

  it('digest/digestHistory degrade to null/[] (warn, never a crash) when the snapshot read fails — other legs survive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({
      rails: async () => [{ rail: 'plan', count: 1 }],
      digestSnapshots: async () => {
        throw Object.assign(new Error('column drift'), { code: '42703' });
      },
    });
    const snap = await readScoutSnapshot(sql, 'ws-1');
    expect(snap.digest).toBeNull();
    expect(snap.digestHistory).toEqual([]);
    expect(snap.totalRouted).toBe(1);
    expect(warn).toHaveBeenCalled();
  });
});

describe('normalizeScoutTick', () => {
  it('returns null for a missing row', () => {
    expect(normalizeScoutTick(null)).toBeNull();
    expect(normalizeScoutTick(undefined)).toBeNull();
  });

  it('tolerates alternate column spellings (created_at / gate_outcome / reason)', () => {
    expect(
      normalizeScoutTick({ created_at: '2026-06-09T07:00:00.000Z', gate_outcome: 'ran', reason: 'idle gate open' }),
    ).toEqual({ at: '2026-06-09T07:00:00.000Z', outcome: 'ran', detail: 'idle gate open' });
  });

  it('falls back to the detail jsonb (reason/error) when no gate column is set', () => {
    expect(
      normalizeScoutTick({ tick_at: '2026-06-09T07:30:00.000Z', status: 'error', gate: null, detail: { error: 'cycle threw' } }),
    ).toEqual({ at: '2026-06-09T07:30:00.000Z', outcome: 'error', detail: 'cycle threw' });
  });

  it('yields nulls (not a crash) for a row with none of the expected columns', () => {
    expect(normalizeScoutTick({ something_else: 1 })).toEqual({ at: null, outcome: null, detail: null });
  });
});

describe('isUndefinedTable', () => {
  it('matches only SQLSTATE 42P01', () => {
    expect(isUndefinedTable(Object.assign(new Error('x'), { code: '42P01' }))).toBe(true);
    expect(isUndefinedTable(Object.assign(new Error('x'), { code: '42703' }))).toBe(false);
    expect(isUndefinedTable(new Error('x'))).toBe(false);
    expect(isUndefinedTable(null)).toBe(false);
  });
});

describe('pot lens (pot-scope-all-learnings P-005)', () => {
  /** Wrap fakeSql to record every tagged-template text — the hive predicates
   *  arrive as their own fragment invocations, not inside the outer query. */
  function recordingSql(texts: string[]): Sql {
    const base = fakeSql({});
    const fn = (strings: TemplateStringsArray | string[], ...vals: unknown[]) => {
      if (Array.isArray(strings)) texts.push((strings as readonly string[]).join('¦'));
      return (base as unknown as (s: unknown, ...v: unknown[]) => unknown)(strings, ...vals);
    };
    return fn as unknown as Sql;
  }

  it('threads the lens: tick leg filters pot_slug, routed legs filter member harnesses — and a non-platform pot gets NO null-harness escape hatch', async () => {
    const texts: string[] = [];
    await readScoutSnapshot(recordingSql(texts), 'ws-1', {
      hive: 'oddsmith',
      hiveMemberSlugs: ['oddsmith', 'odds-web'],
    });
    expect(texts.some((t) => t.includes('pot_slug ='))).toBe(true);
    expect(texts.some((t) => t.includes('harness_slug IN'))).toBe(true);
    expect(texts.some((t) => t.includes('harness_slug IS NULL'))).toBe(false);
  });

  it('the PLATFORM pot lens additionally includes NULL-harness routed rows (write-side resolveLearningPotSlug step-3 mirror)', async () => {
    const texts: string[] = [];
    await readScoutSnapshot(recordingSql(texts), 'ws-1', { hive: PLATFORM_POT_SLUG });
    expect(texts.some((t) => t.includes('harness_slug IS NULL'))).toBe(true);
  });

  it('no hive ⇒ no pot predicates anywhere (workspace-wide read unchanged)', async () => {
    const texts: string[] = [];
    await readScoutSnapshot(recordingSql(texts), 'ws-1');
    expect(texts.some((t) => t.includes('pot_slug ='))).toBe(false);
    expect(texts.some((t) => t.includes('harness_slug IN'))).toBe(false);
  });

  // RECURRENCE GUARD for the improve-funnel scope split, found live in the Tauri
  // shell on 2026-07-27: the funnel rendered "156 ideas → 605 approved" — a
  // funnel that GREW — because stage 1 (totalRouted) was pot-scoped while
  // filed/claimed/done/dropped came from a query carrying no pot predicate at
  // all. Same class as EI-18792873324746237: funnel stages computed over
  // different populations, rendering a number that reads as broken.
  //
  // ⚠ Asserting on SQL TEXT cannot catch this class. The pot predicate is built
  // ONCE and interpolated, so it appears in the recorded text exactly once no
  // matter how many legs actually use it — the text-based tests above would stay
  // green with the funnel completely unscoped. This pins REFERENCE identity
  // instead: every leg over scout_routed_ideas must interpolate the SAME
  // fragment object.
  it('applies the SAME pot filter to every scout_routed_ideas leg — funnel included', async () => {
    const calls: Array<{ text: string; vals: unknown[]; ret: unknown }> = [];
    const base = fakeSql({});
    const rec = (strings: TemplateStringsArray | string[], ...vals: unknown[]) => {
      const ret = (base as unknown as (s: unknown, ...v: unknown[]) => unknown)(
        strings,
        ...vals,
      );
      if (Array.isArray(strings))
        calls.push({ text: (strings as readonly string[]).join(' '), vals, ret });
      return ret;
    };
    await readScoutSnapshot(rec as unknown as Sql, 'ws-1', {
      hive: 'oddsmith',
      hiveMemberSlugs: ['oddsmith', 'odds-web'],
    });

    const filter = calls.find((c) => c.text.includes('sri.harness_slug IN'));
    expect(filter, 'the pot filter fragment was never built').toBeTruthy();

    for (const [leg, marker] of [
      ['rail counts', 'GROUP BY rail'],
      ['recent items', 'idea_id'],
      ['improve funnel', "sri.rail = 'improvement'"],
    ] as const) {
      const q = calls.find((c) => c.text.includes(marker));
      expect(q, `no query matched the ${leg} leg`).toBeTruthy();
      expect(
        q!.vals.includes(filter!.ret),
        `the ${leg} leg does not interpolate the pot filter — it will read workspace-wide while its siblings are pot-scoped, which is what made the funnel grow`,
      ).toBe(true);
    }

    // NEGATIVE CONTROL — without this the check above could pass vacuously (an
    // `includes` that is somehow always true proves nothing). The tick leg is
    // scoped by `pot_slug`, NOT by this fragment, so it must NOT carry it.
    const ticks = calls.find((c) => c.text.includes('scout_ticks'));
    expect(ticks, 'no query matched the ticks leg').toBeTruthy();
    expect(ticks!.vals.includes(filter!.ret)).toBe(false);
  });
});
