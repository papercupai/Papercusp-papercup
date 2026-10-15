/**
 * rubric-staleness-watchdog.test.ts — EI-12149: a release-gating rubric that goes
 * ungraded must PAGE, not silently sit. Pure decider in all three states + the
 * sweep's orchestration (gating filter, debounce, fail-soft) via injected deps —
 * no PG (the DISCRIMINATION bar: a watchdog never shown to report a stale
 * observation window is a green light with extra steps).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  evaluateRubricProposalDwell,
  evaluateRubricStaleness,
  retiredTierCriteria,
  rubricProposalDwellSweep,
  rubricProposalDwellThresholdSec,
  rubricStalenessSweep,
  rubricStalenessThresholdSec,
  RETIRED_TIER_INSTRUMENT_KEYS,
} from './rubric-staleness-watchdog';
import type { Rubric } from './rubrics';
import type { ScorecardFreshness } from './scorecard-freshness';

const SIX_H = 6 * 3_600_000;
const DAY = 24 * 3_600_000;

describe('rubric watchdog condition lifecycle (P-014)', () => {
  afterEach(() => vi.restoreAllMocks());

  const rubric = { rubricId: 'fixture-rubric', releaseGating: true, status: 'active',
    updatedAt: '2026-07-13T00:00:00.000Z', proposedBy: 'su-proposer' } as unknown as Rubric;
  const alarm = () => ({ broadcast: vi.fn(async () => true), resolve: vi.fn(async () => true) });
  const legacy = () => ({ recordFire: vi.fn(async () => undefined), openEscalation: vi.fn(async () => ({}) as never) });

  it('refreshes a stale condition during legacy debounce, preserves unknown reads, then resolves measured recovery', async () => {
    const sink = alarm();
    let state: ScorecardFreshness = freshness();
    const deps = { ...legacy(), alarm: sink, listRubrics: async () => [rubric],
      recentWatchdogFires: async () => 1, checkScorecardFreshness: async () => state };
    await rubricStalenessSweep({ workspaceId: 'fixture-ws', installSlug: 'fixture-pot' }, deps);
    expect(sink.broadcast).toHaveBeenCalledWith(expect.objectContaining({
      conditionKey: 'alarm:rubric-staleness:fixture-ws:fixture-pot:fixture-rubric', oneShot: true,
    }));
    expect(deps.openEscalation).not.toHaveBeenCalled();
    state = freshness({ status: 'unknown-rubric', rubricKnown: false });
    await rubricStalenessSweep({ workspaceId: 'fixture-ws', installSlug: 'fixture-pot' }, deps);
    expect(sink.resolve).not.toHaveBeenCalled();
    deps.checkScorecardFreshness = async () => { throw new Error('read unavailable'); };
    await rubricStalenessSweep({ workspaceId: 'fixture-ws', installSlug: 'fixture-pot' }, deps);
    expect(sink.resolve).not.toHaveBeenCalled();
    deps.checkScorecardFreshness = async () => freshness({ status: 'fresh', complete: true });
    await rubricStalenessSweep({ workspaceId: 'fixture-ws', installSlug: 'fixture-pot' }, deps);
    expect(sink.resolve).toHaveBeenCalledWith(expect.objectContaining({
      conditionKey: 'alarm:rubric-staleness:fixture-ws:fixture-pot:fixture-rubric',
    }));
  });

  it('keeps condition delivery independent of the fires ledger and legacy escalation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = alarm();
    const deps: Parameters<typeof rubricStalenessSweep>[1] = { ...legacy(), alarm: sink, listRubrics: async () => [rubric],
      recentWatchdogFires: async () => { throw new Error('ledger unavailable'); },
      checkScorecardFreshness: async () => freshness() };
    await rubricStalenessSweep({}, deps);
    expect(sink.broadcast).toHaveBeenCalledTimes(1);
    sink.broadcast.mockRejectedValueOnce(new Error('condition transport unavailable'));
    deps.recentWatchdogFires = async () => 0;
    await rubricStalenessSweep({}, deps);
    expect(deps.openEscalation).toHaveBeenCalledTimes(1);
  });

  it('visits a proposal past the first page and resolves it when ratified or revised', async () => {
    const sink = alarm();
    let proposal = { ...rubric, status: 'proposed' } as Rubric;
    const pages = vi.fn(async ({ offset }: { offset?: number } = {}) => offset === 0
      ? { rubrics: [{ ...rubric, rubricId: 'other-rubric' }], hasMore: true, nextOffset: 100 }
      : { rubrics: [proposal], hasMore: false, nextOffset: null });
    const deps = { ...legacy(), alarm: sink, listRubricsPage: pages,
      recentWatchdogFires: async () => 1, now: Date.parse('2026-07-15T00:00:00.000Z') };
    await rubricProposalDwellSweep({ workspaceId: 'fixture-ws', installSlug: 'fixture-pot' }, deps);
    expect(pages.mock.calls.map(([filter]) => filter?.offset)).toEqual([0, 100]);
    expect(sink.broadcast).toHaveBeenCalledWith(expect.objectContaining({
      conditionKey: 'alarm:rubric-proposal-dwell:fixture-ws:fixture-pot:fixture-rubric',
    }));
    expect(deps.openEscalation).not.toHaveBeenCalled();
    sink.resolve.mockClear();
    proposal = { ...proposal, status: 'active' };
    await rubricProposalDwellSweep({ workspaceId: 'fixture-ws', installSlug: 'fixture-pot' }, deps);
    expect(sink.resolve).toHaveBeenCalledWith(expect.objectContaining({
      conditionKey: 'alarm:rubric-proposal-dwell:fixture-ws:fixture-pot:fixture-rubric',
    }));
    sink.broadcast.mockClear();
    proposal = { ...proposal, status: 'proposed', updatedAt: '2026-07-14T23:00:00.000Z' };
    await rubricProposalDwellSweep({}, deps);
    expect(sink.broadcast).not.toHaveBeenCalled();
  });

  it('fails an incomplete non-advancing page read without clearing any condition', async () => {
    const sink = alarm();
    const results = await rubricStalenessSweep({}, { alarm: sink,
      listRubricsPage: async () => ({ rubrics: [rubric], hasMore: true, nextOffset: 0 }) });
    expect(results).toEqual([{ rubricRef: '*', outcome: 'error', reason: 'rubric page did not advance' }]);
    expect(sink.broadcast).not.toHaveBeenCalled();
    expect(sink.resolve).not.toHaveBeenCalled();
  });

  it('recovers existing durable conditions after restart with one fold read and no quiet-rubric broadcasts', async () => {
    const conditions = await import('./agent-tools/coordination/tools/conditions');
    const severe = await import('./severe-event-broadcast');
    const key = 'alarm:rubric-staleness:fixture-ws:fixture-pot:fixture-rubric';
    const read = vi.spyOn(conditions, 'readConditionEnvelopes').mockResolvedValue([
      { ts: '2026-07-14T00:00:00.000Z', condition_key: key, from: 'system-watchdog' },
    ]);
    const resolve = vi.spyOn(severe, 'broadcastSevereEventResolved').mockResolvedValue(true);
    const broadcast = vi.spyOn(severe, 'broadcastSevereEvent').mockResolvedValue(true);
    await rubricStalenessSweep({ workspaceId: 'fixture-ws', installSlug: 'fixture-pot' }, {
      listRubrics: async () => [rubric, { ...rubric, rubricId: 'quiet-rubric' }],
      checkScorecardFreshness: async () => freshness({ status: 'fresh', complete: true }),
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: key }));
    expect(broadcast).not.toHaveBeenCalled();
  });
});

const freshness = (over: Partial<ScorecardFreshness> = {}): ScorecardFreshness => ({
  rubricRef: 'blender-release-readiness',
  since: '2026-07-14T12:00:00.000Z',
  status: 'stale',
  rubricKnown: true,
  emitted: false,
  complete: false,
  count: 0,
  partialCount: 0,
  lastEmittedAt: null,
  lastCompleteAt: null,
  latestMissingKeys: [],
  latestExtraKeys: [],
  ...over,
});

describe('evaluateRubricStaleness — the pure decider', () => {
  const rubric = { rubricId: 'blender-release-readiness' };

  it('HEALTHY when a complete scorecard landed in-window', () => {
    const v = evaluateRubricStaleness(
      rubric,
      freshness({ status: 'fresh', complete: true, count: 2, lastCompleteAt: '2026-07-14T17:00:00.000Z' }),
      SIX_H,
    );
    expect(v.stale).toBe(false);
    expect(v.reason).toContain('2026-07-14T17:00:00.000Z');
  });

  it('STALE on an empty window — reports absence without inferring cause or history', () => {
    const v = evaluateRubricStaleness(rubric, freshness(), SIX_H);
    expect(v.stale).toBe(true);
    expect(v.reason).toContain('NO scorecard in the last 6h');
    expect(v.reason).toContain('blender-release-readiness');
    expect(v.reason).toContain('cause unknown');
    expect(v.reason).toContain('older verdict exists');
    expect(v.reason).not.toContain('dead grader');
    expect(v.reason).not.toContain('predates');
    expect(v.reason).not.toContain('newest verdict');
  });

  it('STALE on partial-only — reports incomplete cards without inferring cause or history', () => {
    const v = evaluateRubricStaleness(
      rubric,
      freshness({ status: 'partial-only', emitted: true, count: 3, partialCount: 3, lastEmittedAt: '2026-07-14T17:30:00.000Z' }),
      SIX_H,
    );
    expect(v.stale).toBe(true);
    expect(v.reason).toContain('NONE complete');
    expect(v.reason).toContain('Newest in-window emission: 2026-07-14T17:30:00.000Z');
    expect(v.reason).toContain('Cause of incompleteness is unknown');
    expect(v.reason).not.toContain('silent truncation');
    expect(v.reason).not.toContain('predates');
    expect(v.reason).not.toContain('dead grader');
  });

  it('UNKNOWN-RUBRIC is healthy/non-actionable rather than a stale grader alert', () => {
    const v = evaluateRubricStaleness(
      rubric,
      freshness({ status: 'unknown-rubric', rubricKnown: false }),
      SIX_H,
    );
    expect(v.stale).toBe(false);
    expect(v.reason).toContain('not registered');
    expect(v.reason).not.toContain('dead grader loop');
  });

  it('kill switch (thresholdMs <= 0) is never stale', () => {
    expect(evaluateRubricStaleness(rubric, freshness(), 0).stale).toBe(false);
    expect(evaluateRubricStaleness(rubric, freshness(), -1).stale).toBe(false);
  });

  /**
   * WI-2145252 — the third failure mode. `autoloop-release-readiness` alerted here every
   * ~3h for ~27 days blaming "a dead grader loop" while three of its eight criteria
   * measured the Mug/Cup/Kettle tier retired 2026-08-09: no amount of grading could ever
   * have produced the COMPLETE scorecard the alert demanded. The alert was correct that
   * it was stale and wrong about why, which is what made it unactionable.
   */
  const criterion = (key: string, instrumentKey: string) =>
    ({ key, instrumentKey }) as unknown as Rubric['criteria'][number];

  it('names a RETIRED-TIER criterion as ungradeable-by-construction, not a dead grader', () => {
    const v = evaluateRubricStaleness(
      {
        rubricId: 'autoloop-release-readiness',
        criteria: [
          criterion('placement-throughput', 'pot-throughput-ticks'),
          criterion('blender-leg-health', 'blender-leg-scorecard'),
        ],
      },
      freshness(),
      SIX_H,
    );
    expect(v.stale).toBe(true);
    expect(v.reason).toContain('UNGRADEABLE BY CONSTRUCTION');
    expect(v.reason).toContain('placement-throughput');
    expect(v.reason).toContain('pot-throughput-ticks');
    expect(v.reason).toContain('rubrics:propose');
    // The LIVE criterion must not be blamed — a diagnosis that indicts everything is noise.
    expect(v.reason).not.toContain('blender-leg-scorecard');
  });

  it('adds NO ungradeable diagnosis when every criterion measures a live subsystem', () => {
    const v = evaluateRubricStaleness(
      {
        rubricId: 'autoloop-release-readiness',
        criteria: [
          criterion('blender-leg-health', 'blender-leg-scorecard'),
          criterion('capacity-admission', 'accounts-capacity'),
          criterion('owner-controls', 'owner-controls-probe'),
          criterion('release-parity', 'release-generation-parity'),
        ],
      },
      freshness(),
      SIX_H,
    );
    expect(v.stale).toBe(true);
    expect(v.reason).toContain('cause unknown');
    expect(v.reason).not.toContain('UNGRADEABLE BY CONSTRUCTION');
  });

  it('leaves a criteria-less caller byte-identical (no stranded call sites)', () => {
    const without = evaluateRubricStaleness(rubric, freshness(), SIX_H).reason;
    const withLive = evaluateRubricStaleness(
      { ...rubric, criteria: [criterion('blender-leg-health', 'blender-leg-scorecard')] },
      freshness(),
      SIX_H,
    ).reason;
    expect(withLive).toBe(without);
  });
});

describe('retiredTierCriteria — the pin on the WI-5379 removal', () => {
  it('flags exactly the four Mug/Cup/Kettle instrument bindings dropped from the composite', () => {
    const flagged = retiredTierCriteria([
      { key: 'placement-throughput', instrumentKey: 'pot-throughput-ticks' },
      { key: 'cup-execution-health', instrumentKey: 'mug-dispatched-cup-spawns' },
      { key: 'kettle-supervision-health', instrumentKey: 'kettle-autoloop-state' },
      { key: 'e2e-loop-closure', instrumentKey: 'e2e-traversal-trace' },
      { key: 'capacity-admission', instrumentKey: 'accounts-capacity' },
      { key: 'release-parity', instrumentKey: 'release-generation-parity' },
    ]);
    expect(flagged.map((f) => f.key)).toEqual([
      'placement-throughput',
      'cup-execution-health',
      'kettle-supervision-health',
      'e2e-loop-closure',
    ]);
    expect(Object.keys(RETIRED_TIER_INSTRUMENT_KEYS).sort()).toEqual([
      'e2e-traversal-trace',
      'kettle-autoloop-state',
      'mug-dispatched-cup-spawns',
      'pot-throughput-ticks',
    ]);
  });

  it('is empty for undefined / no-instrument criteria rather than throwing', () => {
    expect(retiredTierCriteria(undefined)).toEqual([]);
    expect(retiredTierCriteria([{ key: 'x' }, { key: 'y', instrumentKey: null }])).toEqual([]);
  });
});

describe('evaluateRubricProposalDwell — the independent-ratifier decider', () => {
  const rubric = {
    rubricId: 'search-retrieval-quality',
    status: 'proposed' as const,
    updatedAt: '2026-07-13T00:00:00.000Z',
    proposedBy: 'su-proposer',
  };
  const now = Date.parse('2026-07-15T00:00:00.000Z');

  it('STALE after the dwell window and names the missing independent ratifier', () => {
    const v = evaluateRubricProposalDwell(rubric, DAY, now);
    expect(v.stale).toBe(true);
    expect(v.ageMs).toBe(2 * DAY);
    expect(v.reason).toContain('no independent ratifier');
    expect(v.reason).toContain('search-retrieval-quality');
  });

  it('HEALTHY while recent, and non-proposed rubrics are outside this detector', () => {
    expect(evaluateRubricProposalDwell({ ...rubric, updatedAt: '2026-07-14T12:00:00.000Z' }, DAY, now).stale).toBe(
      false,
    );
    expect(evaluateRubricProposalDwell({ ...rubric, status: 'active' }, DAY, now).stale).toBe(false);
  });

  it('invalid timestamps are stale because the watchdog cannot establish progress', () => {
    const v = evaluateRubricProposalDwell({ ...rubric, updatedAt: 'not-a-date' }, DAY, now);
    expect(v.stale).toBe(true);
    expect(v.ageMs).toBeNull();
    expect(v.reason).toContain('invalid updatedAt');
  });

  it('kill switch is never stale', () => {
    expect(evaluateRubricProposalDwell(rubric, 0, now)).toMatchObject({ stale: false, ageMs: 0 });
  });
});

describe('rubricProposalDwellSweep — orchestration (injected deps, no PG)', () => {
  const proposedRubric = {
    rubricId: 'search-retrieval-quality',
    status: 'proposed',
    updatedAt: '2026-07-13T00:00:00.000Z',
    proposedBy: 'su-proposer',
  } as unknown as Rubric;

  const deps = (over: Parameters<typeof rubricProposalDwellSweep>[1] = {}) => ({
    listRubrics: vi.fn(async () => [proposedRubric]),
    recentWatchdogFires: vi.fn(async () => 0),
    recordFire: vi.fn(async () => undefined),
    openEscalation: vi.fn(async () => ({}) as never),
    alarm: { broadcast: vi.fn(async () => true), resolve: vi.fn(async () => false) },
    ...over,
  });

  const withThreshold = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = process.env.PAPERCUSP_RUBRIC_PROPOSAL_DWELL_THRESHOLD_SEC;
    process.env.PAPERCUSP_RUBRIC_PROPOSAL_DWELL_THRESHOLD_SEC = String(DAY / 1_000);
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_RUBRIC_PROPOSAL_DWELL_THRESHOLD_SEC;
      else process.env.PAPERCUSP_RUBRIC_PROPOSAL_DWELL_THRESHOLD_SEC = previous;
    }
  };

  it('alerts with a fires row and escalation when a proposal outlives the review window', async () => {
    await withThreshold(async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const d = deps();
      const results = await rubricProposalDwellSweep({}, { ...d, now: Date.parse('2026-07-15T00:00:00.000Z') });
      warn.mockRestore();
      expect(results[0]).toMatchObject({ rubricRef: 'search-retrieval-quality', outcome: 'alerted' });
      expect(d.recordFire).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'rubric-proposal-dwell', reason: expect.stringContaining('independent ratifier') }),
      );
      expect(d.openEscalation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          summary: expect.stringContaining('search-retrieval-quality'),
          body: expect.stringContaining('must not self-ratify'),
        }),
      );
    });
  });

  it('debounces an already-alerted proposal and does not duplicate either output', async () => {
    await withThreshold(async () => {
      const d = deps({ recentWatchdogFires: vi.fn(async () => 1) });
      const results = await rubricProposalDwellSweep({}, { ...d, now: Date.parse('2026-07-15T00:00:00.000Z') });
      expect(results[0]).toMatchObject({ rubricRef: 'search-retrieval-quality', outcome: 'debounced' });
      expect(d.recordFire).not.toHaveBeenCalled();
      expect(d.openEscalation).not.toHaveBeenCalled();
    });
  });

  it('is fail-soft when listing proposed rubrics fails', async () => {
    await withThreshold(async () => {
      const d = deps({ listRubrics: vi.fn(async () => { throw new Error('plans store unavailable'); }) });
      await expect(rubricProposalDwellSweep({}, { ...d, now: Date.parse('2026-07-15T00:00:00.000Z') })).resolves.toEqual([
        { rubricRef: '*', outcome: 'error', reason: 'plans store unavailable' },
      ]);
    });
  });

  it('uses the documented 24h default when no override is set', () => {
    expect(rubricProposalDwellThresholdSec()).toBe(86_400);
  });
});

describe('rubricStalenessSweep — orchestration (injected deps, no PG)', () => {
  const gatingRubric = { rubricId: 'blender-release-readiness', releaseGating: true, status: 'active' } as unknown as Rubric;
  const plainRubric = { rubricId: 'pot-coordination-health', status: 'active' } as unknown as Rubric;

  const deps = (over: Parameters<typeof rubricStalenessSweep>[1] = {}) => ({
    listRubrics: vi.fn(async () => [gatingRubric, plainRubric]),
    checkScorecardFreshness: vi.fn(async () => freshness()),
    recentWatchdogFires: vi.fn(async () => 0),
    recordFire: vi.fn(async () => undefined),
    openEscalation: vi.fn(async () => ({}) as never),
    alarm: { broadcast: vi.fn(async () => true), resolve: vi.fn(async () => false) },
    ...over,
  });

  it('sweeps only WATCHED rubrics — one carrying neither flag is never paged on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps();
    const results = await rubricStalenessSweep({}, d);
    expect(warn).toHaveBeenCalledOnce(); // the loud ALERT line is part of the contract
    warn.mockRestore();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ rubricRef: 'blender-release-readiness', outcome: 'alerted' });
    expect(d.checkScorecardFreshness).toHaveBeenCalledTimes(1);
    // The alert fired BOTH channels: the countable fires row + the coord escalation.
    expect(d.recordFire).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.recordFire).mock.calls[0]![0]).toMatchObject({ source: 'rubric-staleness' });
    expect(d.openEscalation).toHaveBeenCalledTimes(1);
    const esc = vi.mocked(d.openEscalation).mock.calls[0]![1] as { summary: string; body?: string };
    expect(esc.summary).toContain('blender-release-readiness');
    expect(esc.body).toContain('improvements:capture'); // the re-grade recipe rides the page
  });

  /**
   * P-011. Before this, "watched" and "release-gating" were ONE flag, so an ongoing health
   * rubric could only be watched by claiming to gate releases — which would both block ships
   * it has no business blocking and impose the machine-instrument contract a judgement-based
   * rubric cannot satisfy. So none of them claimed it, and a dead health loop was
   * indistinguishable from a healthy one: the exact silence this watchdog exists to break.
   */
  it('P-011: a stalenessWatched rubric is paged on even though it does NOT gate a release', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const healthRubric = {
      rubricId: 'su-ideation-health',
      stalenessWatched: true,
      status: 'active',
    } as unknown as Rubric;
    const d = deps({ listRubrics: vi.fn(async () => [healthRubric, plainRubric]) });
    const results = await rubricStalenessSweep({}, d);
    warn.mockRestore();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ rubricRef: 'su-ideation-health', outcome: 'alerted' });
    expect(d.openEscalation).toHaveBeenCalledTimes(1);
    // Explicitly assert it was NOT reclassified as a release gate to earn the watch —
    // that mislabel is the workaround this flag exists to make unnecessary.
    expect((healthRubric as { releaseGating?: boolean }).releaseGating).toBeUndefined();
  });

  it('P-011: the two flags are independent — a rubric carrying BOTH is swept exactly once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const both = {
      rubricId: 'blender-release-readiness',
      releaseGating: true,
      stalenessWatched: true,
      status: 'active',
    } as unknown as Rubric;
    const d = deps({ listRubrics: vi.fn(async () => [both]) });
    const results = await rubricStalenessSweep({}, d);
    warn.mockRestore();
    // A filter written as two passes instead of one predicate would double-page here.
    expect(results).toHaveLength(1);
    expect(d.openEscalation).toHaveBeenCalledTimes(1);
  });

  it('healthy when the gating rubric has a complete in-window scorecard — no fire, no escalation', async () => {
    const d = deps({
      checkScorecardFreshness: vi.fn(async () => freshness({ status: 'fresh', complete: true, count: 1 })),
    });
    const results = await rubricStalenessSweep({}, d);
    expect(results[0]!.outcome).toBe('healthy');
    expect(d.recordFire).not.toHaveBeenCalled();
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  it('debounces via the fires ledger — a recent fire suppresses the re-page', async () => {
    const d = deps({ recentWatchdogFires: vi.fn(async () => 1) });
    const results = await rubricStalenessSweep({}, d);
    expect(results[0]!.outcome).toBe('debounced');
    expect(d.recordFire).not.toHaveBeenCalled();
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  it('passes the rubricId as scopeKey to recentWatchdogFires — the per-rubric debounce dimension (EI-16071)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps();
    await rubricStalenessSweep({}, d);
    warn.mockRestore();
    expect(d.recentWatchdogFires).toHaveBeenCalledWith(
      'papercusp-workspace',
      'papercusp',
      expect.any(Number),
      'rubric-staleness',
      'blender-release-readiness',
    );
  });

  it('EI-16071: TWO simultaneously-stale gating rubrics BOTH alert — the source-only debounce key no longer lets the first rubric silently suppress the second', async () => {
    const rubricA = { rubricId: 'blender-release-readiness', releaseGating: true, status: 'active' } as unknown as Rubric;
    const rubricB = { rubricId: 'autoloop-release-readiness', releaseGating: true, status: 'active' } as unknown as Rubric;
    // A tiny in-memory ledger that mirrors the REAL SQL semantics being fixed:
    // recentWatchdogFires counts fires matching `source` AND (scopeKey ⇒ reason
    // includes it) — same contract as the `reason LIKE '%scopeKey%'` filter added
    // to watchdog.ts. This is what makes the test actually exercise the fix: with
    // the OLD (pre-fix) sweep, which never passed a scopeKey, rubricB's check
    // would see rubricA's just-recorded fire (same source, no scope) and debounce.
    const ledger: Array<{ source: string; reason: string }> = [];
    const recentWatchdogFires = vi.fn(
      async (
        _ws: string,
        _slug: string,
        _windowHours?: number,
        source?: string,
        scopeKey?: string,
      ) =>
        ledger.filter((f) => (!source || f.source === source) && (!scopeKey || f.reason.includes(scopeKey))).length,
    );
    const recordFire = vi.fn(async (opts: { source: string; reason: string }) => {
      ledger.push({ source: opts.source, reason: opts.reason });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps({
      listRubrics: vi.fn(async () => [rubricA, rubricB]),
      recentWatchdogFires,
      recordFire,
    });
    const results = await rubricStalenessSweep({}, d);
    warn.mockRestore();
    expect(results).toEqual([
      { rubricRef: 'blender-release-readiness', outcome: 'alerted', reason: expect.any(String) },
      { rubricRef: 'autoloop-release-readiness', outcome: 'alerted', reason: expect.any(String) },
    ]);
    expect(d.recordFire).toHaveBeenCalledTimes(2);
    expect(d.openEscalation).toHaveBeenCalledTimes(2);
  });

  it('is fail-soft per rubric — a freshness read error is recorded, never thrown', async () => {
    const d = deps({
      checkScorecardFreshness: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    const results = await rubricStalenessSweep({}, d);
    expect(results[0]).toMatchObject({ rubricRef: 'blender-release-readiness', outcome: 'error' });
    expect(results[0]!.reason).toContain('pg down');
  });

  it('is fail-soft overall — a rubric-list error yields one error result, never a throw', async () => {
    const d = deps({
      listRubrics: vi.fn(async () => {
        throw new Error('plans store unavailable');
      }),
    });
    const results = await rubricStalenessSweep({}, d);
    expect(results).toEqual([{ rubricRef: '*', outcome: 'error', reason: 'plans store unavailable' }]);
  });

  it('the env kill switch skips the whole sweep', async () => {
    const prev = process.env.PAPERCUSP_RUBRIC_STALENESS_THRESHOLD_SEC;
    process.env.PAPERCUSP_RUBRIC_STALENESS_THRESHOLD_SEC = '0';
    try {
      expect(rubricStalenessThresholdSec()).toBe(0);
      const d = deps();
      const results = await rubricStalenessSweep({}, d);
      expect(results).toEqual([{ rubricRef: '*', outcome: 'skipped', reason: 'kill switch' }]);
      expect(d.listRubrics).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_RUBRIC_STALENESS_THRESHOLD_SEC;
      else process.env.PAPERCUSP_RUBRIC_STALENESS_THRESHOLD_SEC = prev;
    }
  });
});
