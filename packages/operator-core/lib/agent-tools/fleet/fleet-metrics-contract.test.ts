import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compactLeaderBriefForResultDoor } from './leader-brief-shape';
import { applyResultDoor, measureResultContextBytes, RESULT_DOOR_TOKENS, type DoorableResult } from '../../result-door';
import { CHARS_PER_TOKEN_ESTIMATE } from '../../context-doors';
import { parseScratchReference } from '../../scratch-reference';

vi.mock('../../context-doors-config', async () => {
  const { BAKED_DOOR_CONSTANTS: constants } = await import('../../context-doors');
  return { getDoorConstantsSync: () => constants };
});
import {
  FLEET_METRIC_ADMISSION_PARITY,
  FLEET_METRIC_COMPARISON_RULE,
  FLEET_METRIC_POPULATIONS,
  FLEET_METRIC_REMAINING_PRECEDENCE,
  FLEET_METRIC_UNITS,
  FLEET_METRIC_WRITERS,
  FLEET_METRICS_SCHEMA_VERSION,
  FLEET_METRIC_FEATURE_INHERITED_CLAIM_TO_CLOSE_MAX_MS,
  fleetFeatureOutcomesSchema,
  fleetMetricsResultSchema,
  fleetPausedTimeSchema,
  type FleetMetricsResult,
} from './fleet-metrics-contract';
import type { WorkItem } from '../../work-items';
import {
  buildFleetFeatureOutcomes,
  classifyFeatureCloseOrigin,
  computeFleetPausedTime,
  parseFleetMetricClaimHistory,
} from '../work_items/burn_down';

function currentSpecExample(): FleetMetricsResult {
  return {
    ok: true,
    snapshot: {
      schemaVersion: FLEET_METRICS_SCHEMA_VERSION,
      generatedAt: '2026-08-21T14:00:00.000Z',
      scope: {
        fleet: 'nonp2p-bug-drain',
        harness: 'papercusp',
        window: {
          kind: 'fleet-lifetime',
          startAt: '2026-08-20T12:00:00.000Z',
          endAt: '2026-08-21T14:00:00.000Z',
          startInclusive: true,
          endExclusive: true,
          startSource: 'fleet-created-at',
          endSource: 'snapshot-generated-at',
        },
        stock: {
          mode: 'current-spec',
          specId: 'nonp2p-bugs',
          revision: 25,
          source: 'fleet',
          appliedTo: 'all-counted-items',
        },
        flow: {
          mode: 'current-spec',
          specId: 'nonp2p-bugs',
          revision: 25,
          source: 'fleet',
          appliedTo: 'all-counted-items',
        },
        attribution: {
          membership: 'ever-members',
          writer: FLEET_METRIC_WRITERS.membership,
          memberCount: 31,
          rule: 'actor owner id is in the fleet append-only ever-member cohort',
        },
        population: {
          currentRunnableRoster: FLEET_METRIC_POPULATIONS.currentRunnableRoster,
          relevantRoster: FLEET_METRIC_POPULATIONS.relevantRoster,
          attribution: FLEET_METRIC_POPULATIONS.everMembers,
          stock: FLEET_METRIC_POPULATIONS.currentSpecWorkItems,
          flow: FLEET_METRIC_POPULATIONS.currentSpecWorkItems,
          canonicalBugs: FLEET_METRIC_POPULATIONS.canonicalBugs,
          observations: FLEET_METRIC_POPULATIONS.observations,
          occurrences: FLEET_METRIC_POPULATIONS.occurrences,
          terminalAuthority: FLEET_METRIC_POPULATIONS.terminalAuthority,
          comparisonRule: FLEET_METRIC_COMPARISON_RULE,
        },
      },
      quality: {
        exactness: { status: 'exact', sourceCap: null },
        freshness: {
          status: 'fresh',
          measuredAt: '2026-08-21T14:00:00.000Z',
          staleAfterMs: 60_000,
        },
      },
      flow: {
        opened: 12,
        terminalLifecycle: 10,
        terminalCounted: 8,
        netLifecycle: 2,
        netCounted: 4,
        unit: FLEET_METRIC_UNITS.workItems,
        openedBy: {
          fleet: 7,
          otherAgents: 2,
          system: 2,
          unattributed: 1,
          partitions: true,
          membershipBasis: 'ever-members',
        },
        terminalBy: {
          fleet: 6,
          otherAgents: 2,
          system: 1,
          unattributed: 1,
          partitions: true,
          membershipBasis: 'ever-members',
        },
      },
      remaining: {
        total: 15,
        unit: FLEET_METRIC_UNITS.workItems,
        buckets: {
          needsHuman: 1,
          blocked: 2,
          claimHeld: 1,
          inFlight: 4,
          claimable: 5,
          otherUnclaimable: 2,
        },
        mutuallyExclusive: true,
        precedence: [...FLEET_METRIC_REMAINING_PRECEDENCE],
      },
      authority: {
        lifecycleTerminal: 10,
        counted: 8,
        committed: 5,
        validated: 1,
        proposed: 1,
        pendingHuman: 1,
        invalid: 0,
        legacy: 2,
        partitionsLifecycleTerminal: true,
        countedRule: 'committed + validated + legacy',
      },
      issueUnits: {
        canonicalBugs: 9,
        observations: 22,
        occurrences: 30,
        duplicateOccurrences: 21,
        separateUnits: true,
        units: {
          canonicalBugs: FLEET_METRIC_UNITS.canonicalBugs,
          observations: FLEET_METRIC_UNITS.observations,
          occurrences: FLEET_METRIC_UNITS.occurrences,
          duplicateOccurrences: FLEET_METRIC_UNITS.duplicateOccurrences,
        },
        writers: {
          canonicalBugs: FLEET_METRIC_WRITERS.workItems,
          observations: FLEET_METRIC_WRITERS.workItems,
          occurrences: FLEET_METRIC_WRITERS.occurrences,
        },
      },
      admissionParity: FLEET_METRIC_ADMISSION_PARITY,
    },
  };
}

describe('P-001 complete queue comparison and same-snapshot recovery', () => {
  function oversizedBrief() {
    const metrics = currentSpecExample();
    if (!metrics.ok) throw new Error('fixture must be available');
    metrics.snapshot.remaining.total = 2143;
    metrics.snapshot.remaining.buckets = {
      needsHuman: 146, blocked: 440, claimHeld: 279,
      inFlight: 496, claimable: 9, otherUnclaimable: 773,
    };
    metrics.snapshot.intakeStages = {
      population: 2143, unit: 'work-item rows', remainingBugs: 605, verifiedCompletions: 20,
      mutuallyExclusive: true, writer: 'deriveWorkItemPresentationStage',
      scope: 'current-spec issue-family rows including observation evidence', window: 'current stock at generatedAt',
      counts: {
        observation: 1000, unknown: 200, candidate: 300, 'accepted-ready': 9,
        'accepted-active': 496, 'accepted-blocked': 100, 'verified-completion': 20, 'terminal-other': 18,
      },
    };
    const itemIds = Array.from({ length: 2143 }, (_, index) => `WI-census-${index}`);
    return {
      ok: true,
      summary: {
        fleet: 'nonp2p-bug-drain', members: 31,
        claimable_now: { value: 9, population: { scope: metrics.snapshot.scope, itemIds } },
      },
      fleetMetrics: metrics,
      exceptionalActions: itemIds.map((id) => ({ id, next: 'Verify current condition — 確認 '.repeat(15) })),
    };
  }

  it('preserves the complete atomic comparison contract instead of sampling its totals', () => {
    const source = oversizedBrief();
    const preview = compactLeaderBriefForResultDoor(source);
    expect(preview?.fleetMetrics).toMatchObject({
      ok: true,
      snapshot: {
        schemaVersion: source.fleetMetrics.snapshot.schemaVersion,
        generatedAt: source.fleetMetrics.snapshot.generatedAt,
        scope: source.fleetMetrics.snapshot.scope,
        quality: source.fleetMetrics.snapshot.quality,
        flow: source.fleetMetrics.snapshot.flow,
        remaining: source.fleetMetrics.snapshot.remaining,
        authority: source.fleetMetrics.snapshot.authority,
        issueUnits: source.fleetMetrics.snapshot.issueUnits,
        intakeStages: source.fleetMetrics.snapshot.intakeStages,
        admissionParity: source.fleetMetrics.snapshot.admissionParity,
      },
    });
    expect(preview?.summary).toMatchObject({ claimable_now: { value: 9 } });
    expect(preview?.leaderBriefProjection).toMatchObject({ completeIndexesInCursor: true });
    expect(preview).not.toHaveProperty('exceptionalActions');
    expect(source.exceptionalActions).toHaveLength(2143);
  });

  it('preserves unknown metrics and the unread claim-floor reason instead of inventing zero', () => {
    const unavailable = {
      ok: false as const, schemaVersion: FLEET_METRICS_SCHEMA_VERSION,
      error: 'fleet_metrics_unavailable' as const,
      reason: 'historical-spec-unreadable', recoverVia: 'fleet:metrics',
      requested: { fleet: 'nonp2p-bug-drain', harness: 'papercusp', flowMode: 'current-spec' as const, window: 'fleet-lifetime' as const },
    };
    const source = {
      ok: true, fleetMetrics: unavailable,
      summary: { claimable_now: { value: null, unknown: { code: 'oracle-unavailable', detail: 'Read failed' } } },
    };
    const preview = compactLeaderBriefForResultDoor(source);
    expect(preview?.fleetMetrics).toEqual(unavailable);
    expect(preview?.summary).toMatchObject({
      claimable_now: { value: null, unknown: { code: 'oracle-unavailable', detail: 'Read failed' } },
    });
    expect(compactLeaderBriefForResultDoor({ ...source, fleetMetrics: { ok: true, snapshot: { remaining: { total: 0 } } } })).toBeNull();
  });

  it.each([
    { toolName: 'fleet:leader-brief' },
    { toolName: 'tools:invoke', nestedTargetToolName: 'fleet:leader-brief' },
  ])('keeps the complete numeric preview and recovers every original UTF-8 byte through $toolName', (route) => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-metrics-door-'));
    const previousRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    const previousOff = process.env.PAPERCUSP_RESULT_DOOR_OFF;
    process.env.PAPERCUSP_SCRATCH_ROOT = directory;
    delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
    try {
      const source = oversizedBrief();
      const original = JSON.stringify(source);
      const input: DoorableResult = { content: [{ type: 'text', text: original }] };
      const result = applyResultDoor(input, {
        ...route, workspaceId: 'fleet-core-test', runId: '11111111-2222-4333-8444-555555555555',
      });
      const body = JSON.parse((result.content.find((part) => part.type === 'text') as { text: string }).text);
      expect(body.fleetMetrics.snapshot.remaining).toEqual(source.fleetMetrics.snapshot.remaining);
      expect(body.fleetMetrics.snapshot.scope).toEqual(source.fleetMetrics.snapshot.scope);
      expect(body.summary.claimable_now.value).toBe(9);
      expect(measureResultContextBytes(result)).toBeLessThanOrEqual(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
      expect(body._projection.cursor).toMatchObject({ kind: 'scratch-page', tool: 'capability:read' });
      const spillPath = (result._meta?.resultDoor as { spillPath: string }).spillPath;
      const reference = parseScratchReference(readFileSync(spillPath));
      expect(reference).not.toBeNull();
      const recovered = reference!.payload.subarray(body._projection.cursor.bodyOffsetInPayload).toString('utf8');
      expect(recovered).toBe(original);
      const complete = JSON.parse(recovered);
      expect(complete.exceptionalActions).toHaveLength(2143);
      expect(complete.summary.claimable_now.population.itemIds).toEqual(source.summary.claimable_now.population.itemIds);
      expect(complete.fleetMetrics.snapshot.generatedAt).toBe(source.fleetMetrics.snapshot.generatedAt);
      expect(complete.fleetMetrics.snapshot.intakeStages).toEqual(source.fleetMetrics.snapshot.intakeStages);
    } finally {
      if (previousRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousRoot;
      if (previousOff === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
      else process.env.PAPERCUSP_RESULT_DOOR_OFF = previousOff;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('fleet metrics v1 contract', () => {
  it('preserves the scoped intake partition on the parsed fleet wire response and rejects inflated delivery', () => {
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be available');
    example.snapshot.intakeStages = {
      population: 5, unit: 'work-item rows', remainingBugs: 1, verifiedCompletions: 1,
      mutuallyExclusive: true, writer: 'deriveWorkItemPresentationStage',
      scope: 'current-spec issue-family rows including observation evidence', window: 'current stock at generatedAt',
      counts: {
        observation: 1, unknown: 0, candidate: 1, 'accepted-ready': 1,
        'accepted-active': 0, 'accepted-blocked': 0, 'verified-completion': 1, 'terminal-other': 1,
      },
    };
    const parsed = fleetMetricsResultSchema.parse(example);
    expect(parsed).toEqual(example);
    example.snapshot.intakeStages.verifiedCompletions = 2;
    expect(fleetMetricsResultSchema.safeParse(example).success).toBe(false);
    example.snapshot.intakeStages.verifiedCompletions = 1;
    example.snapshot.intakeStages.population = 6;
    expect(fleetMetricsResultSchema.safeParse(example).success).toBe(false);
  });

  it('accepts a current-spec fleet-lifetime snapshot with explicit units and provenance', () => {
    const parsed = fleetMetricsResultSchema.parse(currentSpecExample());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.scope.stock.mode).toBe('current-spec');
    expect(parsed.snapshot.scope.flow.mode).toBe('current-spec');
    expect(parsed.snapshot.scope.attribution.membership).toBe('ever-members');
    expect(parsed.snapshot.issueUnits.separateUnits).toBe(true);
    expect(parsed.snapshot.admissionParity.oracle).toBe('scheduler:get_next');
    expect(parsed.snapshot.admissionParity.rankAffectsPopulation).toBe(false);
  });

  it('represents at-event history without pretending one current revision governed the past', () => {
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be available');
    example.snapshot.scope.flow = {
      mode: 'at-event-spec',
      specId: 'nonp2p-bugs',
      currentRevision: 25,
      revision: 'effective-at-event',
      historyWriter: FLEET_METRIC_WRITERS.claimSpecHistory,
      appliedTo: 'each-event-at-its-event-time',
      missingRevision: 'unavailable-never-current-fallback',
    };
    example.snapshot.scope.population.flow = FLEET_METRIC_POPULATIONS.atEventSpecWorkItemEvents;

    const parsed = fleetMetricsResultSchema.parse(example);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.scope.stock.mode).toBe('current-spec');
    expect(parsed.snapshot.scope.flow).toMatchObject({
      mode: 'at-event-spec',
      revision: 'effective-at-event',
      missingRevision: 'unavailable-never-current-fallback',
    });
  });

  it('requires stock and flow to share one stored spec identity', () => {
    const current = currentSpecExample();
    if (!current.ok) throw new Error('fixture must be available');
    if (current.snapshot.scope.flow.mode !== 'current-spec') throw new Error('fixture must use current spec');
    current.snapshot.scope.flow.revision += 1;
    expect(fleetMetricsResultSchema.safeParse(current).success).toBe(false);

    const historical = currentSpecExample();
    if (!historical.ok) throw new Error('fixture must be available');
    historical.snapshot.scope.flow = {
      mode: 'at-event-spec',
      specId: historical.snapshot.scope.stock.specId,
      currentRevision: historical.snapshot.scope.stock.revision + 1,
      revision: 'effective-at-event',
      historyWriter: FLEET_METRIC_WRITERS.claimSpecHistory,
      appliedTo: 'each-event-at-its-event-time',
      missingRevision: 'unavailable-never-current-fallback',
    };
    historical.snapshot.scope.population.flow = FLEET_METRIC_POPULATIONS.atEventSpecWorkItemEvents;
    expect(fleetMetricsResultSchema.safeParse(historical).success).toBe(false);
  });

  it('binds population metadata to the selected flow mode', () => {
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be available');
    example.snapshot.scope.population.flow = FLEET_METRIC_POPULATIONS.atEventSpecWorkItemEvents;
    expect(fleetMetricsResultSchema.safeParse(example).success).toBe(false);
  });

  it('rejects overlapping/omitted remaining dispositions disguised as a partition', () => {
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be available');
    example.snapshot.remaining.buckets.blocked += 1;
    expect(fleetMetricsResultSchema.safeParse(example).success).toBe(false);
  });

  it('keeps lifecycle terminality separate from completion authority', () => {
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be available');
    example.snapshot.authority.counted += 1;
    example.snapshot.flow.terminalCounted += 1;
    example.snapshot.flow.netCounted -= 1;
    expect(fleetMetricsResultSchema.safeParse(example).success).toBe(false);
  });

  it('requires opened/terminal attribution and net flow to reconcile', () => {
    const badAttribution = currentSpecExample();
    if (!badAttribution.ok) throw new Error('fixture must be available');
    badAttribution.snapshot.flow.openedBy.fleet += 1;
    expect(fleetMetricsResultSchema.safeParse(badAttribution).success).toBe(false);

    const badNet = currentSpecExample();
    if (!badNet.ok) throw new Error('fixture must be available');
    badNet.snapshot.flow.netLifecycle = 99;
    expect(fleetMetricsResultSchema.safeParse(badNet).success).toBe(false);
  });

  it('marks truncation and staleness explicitly, including the recovery read', () => {
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be available');
    example.snapshot.quality = {
      exactness: {
        status: 'truncated',
        sourceCap: 2_000,
        fetched: 2_000,
        reason: 'source cap exhausted before post-filter aggregation',
        recoverVia: 'fleet:leader-brief { payloadTier: "full" }',
      },
      freshness: {
        status: 'stale',
        measuredAt: '2026-08-21T13:00:00.000Z',
        staleAfterMs: 60_000,
        reason: 'snapshot older than the declared freshness bound',
        recoverVia: 'fleet:leader-brief',
      },
    };
    expect(fleetMetricsResultSchema.parse(example)).toEqual(example);
  });

  it('uses an unavailable envelope instead of manufacturing a zero on a missing history revision', () => {
    const unavailable: FleetMetricsResult = {
      ok: false,
      schemaVersion: FLEET_METRICS_SCHEMA_VERSION,
      error: 'fleet_metrics_unavailable',
      reason: 'claim-spec revision effective at an event could not be resolved',
      recoverVia: 'scheduler:get_claim_spec { fleet, history: 20 }',
      requested: {
        fleet: 'nonp2p-bug-drain',
        harness: 'papercusp',
        flowMode: 'at-event-spec',
        window: 'fleet-lifetime',
      },
    };
    expect(fleetMetricsResultSchema.parse(unavailable)).toEqual(unavailable);
  });

  it('never adds canonical bugs, observations, and occurrences as though they shared a unit', () => {
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be available');
    const units = example.snapshot.issueUnits;
    expect(new Set(Object.values(units.units)).size).toBe(4);
    expect(units.canonicalBugs).toBe(9);
    expect(units.observations).toBe(22);
    expect(units.occurrences).toBe(30);
    expect(units).not.toHaveProperty('total');
  });

  it('CONTROL: a current-spec flow revision cannot masquerade as at-event history', () => {
    const example = currentSpecExample() as unknown as Record<string, unknown>;
    const snapshot = example.snapshot as Record<string, unknown>;
    const scope = snapshot.scope as Record<string, unknown>;
    scope.flow = {
      mode: 'at-event-spec',
      specId: 'nonp2p-bugs',
      revision: 25,
      source: 'fleet',
      appliedTo: 'all-counted-items',
    };
    expect(fleetMetricsResultSchema.safeParse(example).success).toBe(false);
  });
});

describe('P-001 feature-fleet outcomes and paused time (R-1, R-11..R-14)', () => {
  const MEMBER = 'su-member-a';
  const OUTSIDER = 'su-prior-fleet';
  const HOUR = 60 * 60 * 1000;
  const members = new Set([MEMBER]);
  const window = { startAt: '2026-10-01T10:00:00.000Z', endAt: '2026-10-01T14:00:00.000Z' };
  const closedAt = '2026-10-01T12:00:00.000Z';
  const closedMs = Date.parse(closedAt);
  const iso = (ms: number) => new Date(ms).toISOString();
  const history = (...entries: Array<[string, string]>) => entries.map(([owner, at]) => ({ owner, at }));
  const noHistory = async () => new Map<string, unknown>();

  function item(overrides: Partial<WorkItem> & { id: string }): WorkItem {
    return {
      kind: 'feature',
      family: 'feature',
      state: 'done',
      closedAt,
      terminalOwner: MEMBER,
      completionAuthority: 'committed',
      ...overrides,
    } as unknown as WorkItem;
  }

  it('R-1 wrong-family CONTROL: task and bug closes are supporting, never feature outcomes', async () => {
    const outcomes = await buildFleetFeatureOutcomes({
      featureCloses: [item({ id: 'WI-1' })],
      supportingCloses: [
        item({ id: 'EI-2', kind: 'task', family: 'issue' }),
        item({ id: 'EI-3', kind: 'bug', family: 'issue' }),
      ],
      members,
      workspaceId: 'ws',
      harness: 'papercusp',
      readHistory: async () => new Map([['WI-1', history([MEMBER, iso(closedMs - 5 * HOUR)])]]),
    });
    if (outcomes.status !== 'measured') throw new Error(`expected measured, got ${outcomes.status}`);
    expect(outcomes.closes.lifecycleTerminal).toBe(1);
    expect(outcomes.supporting).toMatchObject({ tasks: 1, bugs: 1, other: 0, total: 2, countedInFeatureOutcomes: false });
    expect(fleetFeatureOutcomesSchema.safeParse(outcomes).success).toBe(true);
    const folded = { ...outcomes, supporting: { ...outcomes.supporting, countedInFeatureOutcomes: true } };
    expect(fleetFeatureOutcomesSchema.safeParse(folded).success).toBe(false);
  });

  it('R-11 inherited finish: prior outsider work plus a short claim-to-close is inherited', async () => {
    const shortFinish = parseFleetMetricClaimHistory(
      history([OUTSIDER, iso(closedMs - 20 * HOUR)], [MEMBER, iso(closedMs - 30 * 60 * 1000)]),
    );
    expect(classifyFeatureCloseOrigin({ closedAt, terminalOwner: MEMBER }, shortFinish, members)).toBe('inherited');
    // CONTROL: same prior outsider, but the fleet worked it past the threshold => fleet-done.
    const longRun = parseFleetMetricClaimHistory(
      history(
        [OUTSIDER, iso(closedMs - 20 * HOUR)],
        [MEMBER, iso(closedMs - FLEET_METRIC_FEATURE_INHERITED_CLAIM_TO_CLOSE_MAX_MS - 60_000)],
      ),
    );
    expect(classifyFeatureCloseOrigin({ closedAt, terminalOwner: MEMBER }, longRun, members)).toBe('fleetDone');
    // CONTROL: no outsider ever claimed => fleet-done even on a short finish.
    const ownWork = parseFleetMetricClaimHistory(history([MEMBER, iso(closedMs - 10 * 60 * 1000)]));
    expect(classifyFeatureCloseOrigin({ closedAt, terminalOwner: MEMBER }, ownWork, members)).toBe('fleetDone');
    // Live shape (WI-10004936-style rows): the closer never claimed before the close and the
    // completion path re-stamps taken_by ~2ms AFTER closedAt. Every pre-close worker is an
    // outsider, so the closer's claim is the close itself => inherited, never fleet-done.
    const unclaimedFinish = parseFleetMetricClaimHistory(
      history([OUTSIDER, iso(closedMs - 20 * HOUR)], [MEMBER, iso(closedMs + 2)]),
    );
    expect(classifyFeatureCloseOrigin({ closedAt, terminalOwner: MEMBER }, unclaimedFinish, members)).toBe('inherited');
    // CONTROL: the same outsider-only history with no recorded closer => unknown, not guessed.
    expect(classifyFeatureCloseOrigin({ closedAt, terminalOwner: null }, unclaimedFinish, members)).toBe('unknown');
    // CONTROL: only the post-close completion stamp => no pre-close work recorded => unknown.
    const stampOnly = parseFleetMetricClaimHistory(history([MEMBER, iso(closedMs + 2)]));
    expect(classifyFeatureCloseOrigin({ closedAt, terminalOwner: MEMBER }, stampOnly, members)).toBe('unknown');
    // Untimed legacy history is unusable => unknown, never fleet-done.
    expect(parseFleetMetricClaimHistory(['su-legacy-bare-string'])).toBeNull();
    expect(classifyFeatureCloseOrigin({ closedAt, terminalOwner: MEMBER }, null, members)).toBe('unknown');

    const outcomes = await buildFleetFeatureOutcomes({
      featureCloses: [item({ id: 'WI-1' }), item({ id: 'WI-2' })],
      supportingCloses: [],
      members,
      workspaceId: 'ws',
      harness: 'papercusp',
      readHistory: async () =>
        new Map([['WI-1', history([OUTSIDER, iso(closedMs - 20 * HOUR)], [MEMBER, iso(closedMs - 30 * 60 * 1000)])]]),
    });
    expect(outcomes).toMatchObject({ status: 'measured', origin: { fleetDone: 0, inherited: 1, unknown: 1 } });
  });

  it('R-13 genuine zero is a measured zero; unreadable history and shipped are unknown', async () => {
    const zero = await buildFleetFeatureOutcomes({
      featureCloses: [],
      supportingCloses: [],
      members,
      workspaceId: null,
      harness: 'papercusp',
      readHistory: async () => {
        throw new Error('must not read history for an empty cohort');
      },
    });
    expect(zero).toMatchObject({ status: 'measured', closes: { lifecycleTerminal: 0, counted: 0 } });
    expect(zero.status === 'measured' && zero.shipped.status).toBe('unknown');
    const noWorkspace = await buildFleetFeatureOutcomes({
      featureCloses: [item({ id: 'WI-1' })],
      supportingCloses: [],
      members,
      workspaceId: null,
      harness: 'papercusp',
      readHistory: noHistory,
    });
    expect(noWorkspace.status).toBe('unknown');
    const failedRead = await buildFleetFeatureOutcomes({
      featureCloses: [item({ id: 'WI-1' })],
      supportingCloses: [],
      members,
      workspaceId: 'ws',
      harness: 'papercusp',
      readHistory: async () => {
        throw new Error('pool exhausted');
      },
    });
    expect(failedRead).toMatchObject({ status: 'unknown', reason: expect.stringContaining('pool exhausted') });
    expect(fleetFeatureOutcomesSchema.safeParse(failedRead).success).toBe(true);
  });

  it('R-14 proposed-versus-committed: a proposed close is counted apart from committed closes', async () => {
    const outcomes = await buildFleetFeatureOutcomes({
      featureCloses: [
        item({ id: 'WI-1', completionAuthority: 'committed' }),
        item({ id: 'WI-2', completionAuthority: 'proposed' }),
        item({ id: 'WI-3', completionAuthority: 'pending_human' }),
      ],
      supportingCloses: [],
      members,
      workspaceId: 'ws',
      harness: 'papercusp',
      readHistory: noHistory,
    });
    expect(outcomes).toMatchObject({
      status: 'measured',
      closes: { lifecycleTerminal: 3, committed: 1, proposed: 1, pendingHuman: 1, counted: 1 },
    });
  });

  it('R-12 paused interval: working time excludes recorded pauses, clipped to the window', () => {
    const paused = computeFleetPausedTime(
      {
        events: [
          { tool: 'fleet:wind-down', at: '2026-10-01T09:30:00.000Z' },
          { tool: 'fleet:resume', at: '2026-10-01T10:30:00.000Z' },
          { tool: 'fleet:pause', at: '2026-10-01T11:00:00.000Z' },
          { tool: 'fleet:resume', at: '2026-10-01T12:00:00.000Z' },
        ],
        current: { controlState: 'active', controlAt: null },
      },
      window,
    );
    expect(paused).toMatchObject({
      status: 'measured',
      windowMs: 4 * HOUR,
      pausedMs: 1.5 * HOUR,
      workingMs: 2.5 * HOUR,
      intervalCount: 2,
      openAtGeneratedAt: false,
    });
    expect(fleetPausedTimeSchema.safeParse(paused).success).toBe(true);
    // CONTROL: working time that swallows the pause fails the contract.
    if (paused.status !== 'measured') throw new Error('expected measured');
    expect(fleetPausedTimeSchema.safeParse({ ...paused, workingMs: paused.windowMs }).success).toBe(false);
    // Still paused at generation time: the open interval runs to the window end.
    const open = computeFleetPausedTime(
      { events: [], current: { controlState: 'paused', controlAt: '2026-10-01T13:00:00.000Z' } },
      window,
    );
    expect(open).toMatchObject({ status: 'measured', pausedMs: HOUR, workingMs: 3 * HOUR, openAtGeneratedAt: true });
  });

  it('R-13 an unpaired resume inside the window is unknown, never zero paused time', () => {
    const unpaired = computeFleetPausedTime(
      { events: [{ tool: 'fleet:resume', at: '2026-10-01T12:00:00.000Z' }], current: { controlState: 'active', controlAt: null } },
      window,
    );
    expect(unpaired.status).toBe('unknown');
    expect(fleetPausedTimeSchema.safeParse(unpaired).success).toBe(true);
    // A resume before the window opens hides nothing inside it.
    const early = computeFleetPausedTime({ events: [{ tool: 'fleet:resume', at: '2026-10-01T09:00:00.000Z' }], current: null }, window);
    expect(early).toMatchObject({ status: 'measured', pausedMs: 0 });
  });

  it('R-12 a pause closed by the registry (refused resume) ends at control_at, not the window end', () => {
    // Live shape (p004-behavior-feedback, 2026-10-01): pause ok, fleet:resume REFUSED, flag active.
    const closedByFlag = computeFleetPausedTime(
      {
        events: [{ tool: 'fleet:pause', at: '2026-10-01T11:00:00.000Z' }],
        current: { controlState: 'active', controlAt: '2026-10-01T11:15:00.000Z' },
      },
      window,
    );
    expect(closedByFlag).toMatchObject({ status: 'measured', pausedMs: 15 * 60 * 1000, openAtGeneratedAt: false });
    // CONTROL: active with no usable closing time is unknown, never "paused to the end".
    const noCloseTime = computeFleetPausedTime(
      { events: [{ tool: 'fleet:pause', at: '2026-10-01T11:00:00.000Z' }], current: { controlState: 'active', controlAt: null } },
      window,
    );
    expect(noCloseTime.status).toBe('unknown');
  });

  it('the snapshot carries both blocks and rejects an origin that does not partition the closes', async () => {
    const outcomes = await buildFleetFeatureOutcomes({
      featureCloses: [item({ id: 'WI-1' })],
      supportingCloses: [],
      members,
      workspaceId: 'ws',
      harness: 'papercusp',
      readHistory: noHistory,
    });
    const example = currentSpecExample();
    if (!example.ok) throw new Error('fixture must be a snapshot');
    const withBlocks = {
      ...example,
      snapshot: {
        ...example.snapshot,
        featureOutcomes: outcomes,
        pausedTime: computeFleetPausedTime({ events: [], current: null }, example.snapshot.scope.window),
      },
    };
    expect(fleetMetricsResultSchema.safeParse(withBlocks).success).toBe(true);
    if (outcomes.status !== 'measured') throw new Error('expected measured');
    const broken = { ...outcomes, origin: { ...outcomes.origin, fleetDone: outcomes.origin.fleetDone + 1 } };
    expect(fleetFeatureOutcomesSchema.safeParse(broken).success).toBe(false);
  });
});
