/**
 * leader-brief.test.ts — fleet-reliability-verification-2026-07-10 P-007.
 *
 * projectMember is the PURE per-member reshape (fleet:assignments'
 * decoration output → the leader-lean brief row) — unit-tested directly, no
 * PG/DI ceremony (mirrors deriveMemberVerdict/deriveContextPressure).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildFleetUnderStaffedBriefAlert,
  buildLeaderBlockerStallBriefView,
  buildLeaderDependencyBottleneckView,
  computeBenchSuggestion,
  computeClaimabilitySupervision,
  computeParkedMemberCapacity,
  readParkedMemberAdmission,
  computeDarkFleetAlert,
  computeDormantAlert,
  computeFleetBlockVerdict,
  computeFleetExecutionCollapseAlert,
  computeFleetHeadcountVsExecutableFrontierAlert,
  computeFloorStarvedFleetAlert,
  computeIdleWithClaimableAlert,
  computeIntentAttention,
  computeSpecStarvedFleetAlert,
  computeSpecAuthorshipAlert,
  computeDeclaredPlanSpecDivergenceAlert,
  computeSpinningAlert,
  computeStrandedFleetAlert,
  compactLaunchWorkerAttestation,
  compactLeaderBriefBenchSuggestions,
  compactLeaderBriefIntentAttention,
  compactLeaderBriefRepeatedRecovery,
  compactLeaderBriefMemberVerdicts,
  decorateComposedParkedOn,
  exactPositiveSinglePlanSlugFromFilter,
  FALSIFIER_FORBIDDEN_TOOLS,
  fleetCapacityProviderForMembers,
  LEADER_BRIEF_FLEET_CAMPAIGN_TIMEOUT_MS,
  LEADER_BRIEF_FLEET_METRICS_TIMEOUT_MS,
  LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS,
  LEADER_BRIEF_OPTIONAL_READ_TIMEOUT_MS,
  LEADER_BRIEF_READ_CONCURRENCY,
  LEADER_BRIEF_TOTAL_TIMEOUT_MS,
  leaderBriefLaneHealthUnavailable,
  leaderBriefRosterDegradation,
  projectMember,
  projectLeaderBriefOwnerDirectives,
  projectFleetAdmissionBlockRead,
  projectLeaderBriefFleetPause,
  prioritizeActionableMembers,
  prioritizeBenchSuggestedMembers,
  readLeaderMonitoringBlindAdvisory,
  recoverFleetRecordForLeaderControl,
  boundedLeaderBriefFleetMetricsRead,
  boundedLeaderBriefFleetCampaignRead,
  projectFleetCampaignInvocationDiagnostics,
  recordFleetCampaignInvocationDiagnostics,
  readLeaderBriefFleetMetrics,
  startLeaderBriefFleetMetricsRead,
  leaderBriefFleetMetricsUnavailable,
  readLeaderBriefLaneHealth,
  readLeaderAnnouncedGates,
  reconcilePsuHostLiveness,
  resolveComposedParkedOn,
  runBoundedLeaderBriefReads,
  runLeaderBriefWithinDeadline,
  bindLeaderBriefResult,
  createLeaderBriefMetadataRecorder,
  runLeaderBriefReads,
  resolveLeaderBriefFleet,
  selectLeaderBriefMembers,
  shouldRefreshLeaderControlForBrief,
  silentMembersSummary,
  topExcludedFloors,
  selectLeaderBriefObligationFields,
  leaderBriefObligationFields,
  type ComposedParkEntry,
  type DecoratedAgent,
} from './leader-brief';
import leaderBriefTool from './leader-brief';
import { VERDICT_SPEAKING_FRESH_MS } from './assignments';
import {
  computeStalledItemRotation,
  isInstrumentedLongTestTool,
  materialAdvanceAnchor,
  STALLED_ITEM_REQUIRED_ACTION,
  STALLED_ITEM_ROTATION_THRESHOLD_MS,
} from './stalled-item-rotation';
import type { AgentClaim } from '../../fleet/assignments';
import type { FleetHeadcountState } from '../../agent-fleets-store';
import { computeMemberIdleVerdict } from '../../fleet-member-idle-verdict';
import type { DependencyBottleneckResult } from '../../dependency-traversal';
import type { FleetAdmissionBlock } from '../coordination/fleet-scope-admission-blocks';
import type { AgentObligationAgenda } from '../../agent-obligations';
import { withBoundedTimeout } from '../../bounded-timeout';
import * as fallbackObservations from '../../degradation/fallback-observations';
import type { FleetLaneHealth } from '../../fleet/lane-health';
import type { ClaimConcurrencyVerdict } from '../../scheduler/claim-spec-store';
import { buildClaimableNowAggregate } from './leader-brief-aggregate';
import { shapeLeaderBrief } from './leader-brief-shape';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');

describe('parked member capacity beside a partially working fleet', () => {
  const member: Parameters<typeof computeParkedMemberCapacity>[0]['member'] = { sessionState: 'parked', wakeable: true, fleetRole: 'member', contextPressure: null, parkedOn: ['work-item:claimable'] };
  const concurrency: ClaimConcurrencyVerdict = { blocked: false, activeClaims: 0, maxConcurrentClaims: 2, heldIds: [], blockerParkedIds: ['WI-blocked'] };
  const evidence = { concurrency, claimable: 3, specRef: 'member-override@4' };
  const assess = (m = member, e: typeof evidence | null = evidence, paused: boolean | null = false) => computeParkedMemberCapacity({ member: m, evidence: e, fleetPaused: paused });

  it('finds an eligible parked seat while distinguishing working, capped, restricted and unread seats', () => {
    const mixed = [
      assess(),
      assess({ ...member, sessionState: 'live' }),
      assess(member, { ...evidence, concurrency: { ...concurrency, blocked: true, activeClaims: 2, heldIds: ['WI-1', 'WI-2'] } }),
      assess(member, { ...evidence, claimable: 0 }),
      assess(member, null),
    ];
    expect(mixed.map((m) => m.status)).toEqual(['eligible', 'protected', 'at-capacity', 'no-work', 'unknown']);
    expect(mixed[0]).toMatchObject({ activeClaims: 0, maxConcurrentClaims: 2, blockerParkedIds: ['WI-blocked'], specRef: 'member-override@4' });
    expect(mixed[2].heldIds).toEqual(['WI-1', 'WI-2']);
    expect(mixed[4].claimable).toBeNull();
  });

  it('retains genuine and owner gates, fleet pauses, context recovery, and historical holders', () => {
    expect(assess({ ...member, parkedOn: ['fleet:alpha:owner-only'] }).status).toBe('protected');
    expect(assess({ ...member, parkedOn: ['work-item:claimable', 'composed-root:42'] }).status).toBe('protected');
    expect(assess(member, evidence, true).status).toBe('protected');
    expect(assess(member, evidence, null).status).toBe('unknown');
    expect(assess({ ...member, wakeable: false }).status).toBe('protected');
    expect(assess({ ...member, contextPressure: 'critical' }).status).toBe('protected');
    expect(assess({ ...member, parkedOn: ['work-item:done:WI-blocked'] }).status).toBe('eligible');
    expect(assess({ ...member, parkedOn: ['work-item:done:WI-untyped'] }).status).toBe('protected');
    expect(assess({ ...member, intent: 'Resume only held WI-blocked; do not pull new work.', parkedOn: ['work-item:done:WI-blocked'] }).status).toBe('protected');
    expect(assess({ ...member, intent: 'Owner-only approval is pending.' }).status).toBe('protected');
  });

  it('uses the member override and assignee in the shared floor reader, including its own cap', async () => {
    const record = { source: 'cup', harnessSlug: 'fixture', revision: 4, spec: { specId: 'restricted', limits: { maxConcurrentClaims: 1 }, view: { filter: { field: 'kind', op: 'eq', value: 'bug' } } } } as any;
    const getSpec = vi.fn().mockResolvedValue(record);
    const capacity = vi.fn().mockResolvedValue({ ...concurrency, maxConcurrentClaims: 1 });
    const lane = vi.fn().mockResolvedValue({ laneHealth: { effective: { claimable: 0 }, spec: { ref: 'restricted@4' } }, unavailable: null });
    const input = { member: 'member-owner', fleet: 'alpha', workspaceId: 'workspace' };
    const result = await readParkedMemberAdmission(input, { getSpec, concurrency: capacity, lane });
    expect(getSpec).toHaveBeenCalledWith('member-owner');
    expect(capacity).toHaveBeenCalledWith(1);
    expect(lane).toHaveBeenCalledWith(expect.objectContaining({ spec: record.spec, record, assignee: 'member-owner', harness: 'fixture', issueFamilyTotalBudgetMs: 12000 }));
    expect(result.claimable).toBe(0);
    capacity.mockResolvedValueOnce({ ...concurrency, blocked: true, activeClaims: 1, maxConcurrentClaims: 1 });
    lane.mockClear();
    expect((await readParkedMemberAdmission(input, { getSpec, concurrency: capacity, lane })).concurrency.blocked).toBe(true);
    expect(lane).not.toHaveBeenCalled();
  });
});

describe('claimability supervision when idle alerts cannot be evaluated', () => {
  const unavailable = () => buildClaimableNowAggregate({
    fleet: 'alpha',
    requestedHarness: 'papercusp',
    laneHealth: null,
    unavailable: leaderBriefLaneHealthUnavailable({ fleet: 'alpha', harness: 'papercusp' }).unavailable,
    fleetPaused: false,
  });

  it('reports degraded supervision and a scoped recovery read instead of a healthy zero', () => {
    const result = computeClaimabilitySupervision(unavailable());
    expect(result).toMatchObject({ status: 'degraded', fleet: 'alpha', harness: 'papercusp', value: null });
    expect(result.reason).toBeTruthy();
    expect(result.recoverVia).toContain('work_items:claimable');
    expect(result.recoverVia).toContain('alpha');
  });

  it('distinguishes a measured empty lane from an unread lane', () => {
    const input = unavailable();
    input.value = 0;
    input.interpretation.exactness = { status: 'exact', reason: 'the complete lane is empty' };
    delete input.unknown;
    expect(computeClaimabilitySupervision(input)).toMatchObject({ status: 'measured', value: 0, recoverVia: null });
  });

  it('keeps a positive partial measurement degraded until the scope is fully measured', () => {
    const input = unavailable();
    input.value = 4;
    input.interpretation.exactness = { status: 'partial', reason: 'one family was unavailable' };
    expect(computeClaimabilitySupervision(input)).toMatchObject({ status: 'degraded', value: 4 });
  });
});

describe('P-004 identity binding at the existing fleet brief sink', () => {
  it('uses the one producer result unchanged and records its compiled contribution in existing metadata', async () => {
    const data = { ok: true, summary: { fleet: 'alpha', members: 2 } };
    const producer = vi.fn(async () => ({ data }));
    const metadata = vi.fn();
    const recordMetadata = createLeaderBriefMetadataRecorder(metadata);
    const metricTiming = {
      schemaVersion: 'fleet-metric-read-timing-v1',
      phases: { readFleetMetricSource: { status: 'failed', elapsedMs: 5001 } },
    };
    recordMetadata({ fleetMetricReadTiming: metricTiming });
    const binder = vi.fn(async () => ({ identityId: 'su.fleet-leader', status: 'bound',
      specificationRevision: 'a'.repeat(64) })) as never;
    const produced = await runLeaderBriefWithinDeadline(producer, { data: {
      ok: false, summary: { fleet: 'alpha', members: 0 },
    } });
    const delivered = await bindLeaderBriefResult(produced, { fleet: 'alpha', workspace: 'ws' }, recordMetadata, binder);
    expect(producer).toHaveBeenCalledTimes(1);
    expect(delivered).toBe(produced);
    expect(delivered.data).toBe(data);
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(metadata).toHaveBeenLastCalledWith({
      fleetMetricReadTiming: metricTiming,
      identityContribution: expect.objectContaining({ status: 'bound' }),
    });
  });
});

describe('P-026 owner-directive leader projection', () => {
  it('keeps owner directives distinct from member actuation and exposes recoveryRef, never targetRef', () => {
    const obligation = {
      id: 'obl:owner-directive:1',
      ruleId: 'owner-directive-disposition',
      ruleRevision: 'owner-directive-disposition-v1',
      family: 'owner-directive' as const,
      title: 'Owner directive #27: "finish the review"',
      scope: { workspaceId: 'ws', ownerId: 'leader' },
      responsibleOwnerId: 'leader',
      episode: 'open:27',
      status: 'due' as const,
      authority: { kind: 'owner-candidate' as const, sourceRef: 'owner-directive:27', turnOrigin: 'unknown' as const },
      reason: 'finish the review',
      priority: 'critical' as const,
      causalRank: 0,
      applicableDemand: 1,
      sourceGeneration: 'gen-1',
      evidence: [],
      action: {
        kind: 'repair' as const,
        summary: 'carry out, then close: orders:disposition',
        tool: 'orders:disposition',
        args: { id: 27 },
        targetRef: 'orders:get #27',
        recoveryRef: 'orders:get #27',
      },
      clearsWhen: { id: 'owner-directive-dispositioned:27', summary: 'close it', evidenceKind: 'state' as const, sourceRef: 'owner-directive:27' },
    };
    const agenda: AgentObligationAgenda = {
      schemaVersion: 'agent-obligations-v1',
      evaluatedAt: '2026-09-21T20:00:00.000Z',
      sourceGeneration: 'agenda-1',
      evaluations: [obligation],
      primary: [obligation],
      conflicts: [],
    };
    const projected = projectLeaderBriefOwnerDirectives({
      agenda,
      projection: {
        text: '- [DUE] Owner directive #27: "finish the review" — carry out, then close: orders:disposition; full: orders:get #27',
        entries: [obligation],
        receipt: {
          sink: 'fleet:leader-brief:owner-directives', mode: 'truncate', entriesAvailable: 1,
          entriesDelivered: 1, entriesOmitted: 0, bodyDeliveredChars: 120, estimatedTokens: 30,
          bodyTruncated: false, refused: false,
        },
      },
      read: { elapsedMs: 4, degradedSources: [] },
    });
    expect(projected.directives[0]).toMatchObject({
      id: obligation.id,
      action: { tool: 'orders:disposition', recoveryRef: 'orders:get #27' },
    });
    expect(projected.directives[0]!.action).not.toHaveProperty('targetRef');
    expect(projected.projection.text).toContain('orders:get #27');
  });

  // The projection above was the only guarded half of P-026. Nothing drove the
  // ASSEMBLY, so two mutation probes against it — hard-nulling the selection off
  // the obligation read, and deleting the spread that puts the field on the
  // returned brief — each left this suite GREEN while a leader's brief silently
  // lost every owner directive (WI-10002415). The two hops are now exported and
  // driven here, with a real projection rather than a hand-shaped stand-in.
  function realOwnerDirectives() {
    const obligation = {
      id: 'obl:owner-directive:31',
      ruleId: 'owner-directive-disposition',
      ruleRevision: 'owner-directive-disposition-v1',
      family: 'owner-directive' as const,
      title: 'Owner directive #31: "ship the plan"',
      scope: { workspaceId: 'ws', ownerId: 'leader' },
      responsibleOwnerId: 'leader',
      episode: 'open:31',
      status: 'due' as const,
      authority: { kind: 'owner' as const, sourceRef: 'owner-directive:31', turnOrigin: 'owner-typed' as const },
      reason: 'ship the plan',
      priority: 'critical' as const,
      causalRank: 0,
      applicableDemand: 1,
      sourceGeneration: 'agenda-31',
      evidence: [],
      action: {
        kind: 'repair' as const,
        summary: 'carry out, then close: orders:disposition',
        tool: 'orders:disposition',
        args: { id: 31 },
        targetRef: 'orders:get #31',
        recoveryRef: 'orders:get #31',
      },
      clearsWhen: {
        id: 'owner-directive-dispositioned:31', summary: 'close it',
        evidenceKind: 'state' as const, sourceRef: 'owner-directive:31',
      },
    };
    const agenda: AgentObligationAgenda = {
      schemaVersion: 'agent-obligations-v1',
      evaluatedAt: '2026-09-22T20:00:00.000Z',
      sourceGeneration: 'agenda-31',
      evaluations: [obligation],
      primary: [obligation],
      conflicts: [],
    };
    return projectLeaderBriefOwnerDirectives({
      agenda,
      projection: {
        text: '- [DUE] Owner directive #31: "ship the plan" — carry out, then close: orders:disposition; full: orders:get #31',
        entries: [obligation],
        receipt: {
          sink: 'fleet:leader-brief:owner-directives', mode: 'truncate', entriesAvailable: 1,
          entriesDelivered: 1, entriesOmitted: 0, bodyDeliveredChars: 110, estimatedTokens: 28,
          bodyTruncated: false, refused: false,
        },
      },
      read: { elapsedMs: 4, degradedSources: [] },
    });
  }

  it('carries the projected owner directives from the obligation read onto the brief', () => {
    const ownerDirectives = realOwnerDirectives();
    const selected = selectLeaderBriefObligationFields({ agentObligations: null, ownerDirectives });

    expect(selected.ownerDirectives).toBe(ownerDirectives);
    expect(leaderBriefObligationFields(selected)).toEqual({ ownerDirectives });
    expect(leaderBriefObligationFields(selected).ownerDirectives?.directives[0]).toMatchObject({
      id: 'obl:owner-directive:31',
    });
  });

  it('CONTROL: an absent obligation read leaves the field OFF the brief, not rendered as null', () => {
    // Without this the assertion above would pass against a wiring that always
    // emits the key, and "the brief has ownerDirectives" would stop meaning
    // "the leader has owner directives".
    expect(selectLeaderBriefObligationFields(null)).toEqual({ agentObligations: null, ownerDirectives: null });
    expect(selectLeaderBriefObligationFields(undefined)).toEqual({ agentObligations: null, ownerDirectives: null });
    expect(leaderBriefObligationFields({ agentObligations: null, ownerDirectives: null })).toEqual({});
    expect(leaderBriefObligationFields({ agentObligations: null, ownerDirectives: null })).not.toHaveProperty(
      'ownerDirectives',
    );
  });

  it('keeps owner directives a field of their own beside agent obligations, in that order (D-016)', () => {
    const agentObligations = { text: 'agent obligations', read: { elapsedMs: 1, degradedSources: [] } };
    const fields = leaderBriefObligationFields({ agentObligations, ownerDirectives: realOwnerDirectives() });

    expect(Object.keys(fields)).toEqual(['agentObligations', 'ownerDirectives']);
    expect(fields.agentObligations).toBe(agentObligations);
  });
});

describe('leaderBriefRosterDegradation (EI-22734316557524020)', () => {
  it('qualifies degraded roster legs so an empty fallback cannot read as a healthy fleet', () => {
    expect(leaderBriefRosterDegradation(['presence', 'assignments'])).toEqual({
      degraded: true,
      degradedLegs: ['roster.presence', 'roster.assignments'],
    });
  });

  it('omits degradation markers for a fully measured roster', () => {
    expect(leaderBriefRosterDegradation([])).toEqual({});
  });
});

describe('resolveLeaderBriefFleet — durable leadership is the omitted-fleet authority (EI-22022804992915961)', () => {
  const agent = {
    presenceFleet: null as string | null,
    ledFleets: [] as string[],
    resolveCallerMembership: true,
  };

  it('uses the sole durable led fleet even when presence points at another fleet', () => {
    expect(
      resolveLeaderBriefFleet({
        ...agent,
        presenceFleet: 'latest-joined',
        ledFleets: ['actually-led'],
      }),
    ).toEqual({ kind: 'led', fleet: 'actually-led' });
  });

  it('fails closed when the agent leads several fleets, even if presence matches one', () => {
    expect(
      resolveLeaderBriefFleet({
        ...agent,
        presenceFleet: 'fleet-b',
        ledFleets: ['fleet-a', 'fleet-b'],
      }),
    ).toEqual({ kind: 'ambiguous', fleets: ['fleet-a', 'fleet-b'] });
  });

  it('fails closed when several led fleets have no matching presence target', () => {
    expect(
      resolveLeaderBriefFleet({
        ...agent,
        presenceFleet: 'not-led',
        ledFleets: ['fleet-a', 'fleet-b'],
      }),
    ).toEqual({ kind: 'ambiguous', fleets: ['fleet-a', 'fleet-b'] });
    expect(resolveLeaderBriefFleet({ ...agent, ledFleets: ['fleet-a', 'fleet-b'] })).toEqual({
      kind: 'ambiguous',
      fleets: ['fleet-a', 'fleet-b'],
    });
  });

  it('preserves explicit fleet selection and read-only viewer no-target behavior', () => {
    expect(
      resolveLeaderBriefFleet({
        ...agent,
        explicitFleet: 'explicit-fleet',
        presenceFleet: 'presence-fleet',
        ledFleets: ['led-fleet'],
      }),
    ).toEqual({ kind: 'explicit', fleet: 'explicit-fleet' });
    expect(
      resolveLeaderBriefFleet({
        ...agent,
        resolveCallerMembership: false,
        presenceFleet: 'presence-fleet',
        ledFleets: ['led-fleet'],
      }),
    ).toEqual({ kind: 'none' });
  });

  it('retains presence fallback when no durable leadership exists', () => {
    expect(resolveLeaderBriefFleet({ ...agent, presenceFleet: 'member-fleet' })).toEqual({
      kind: 'presence',
      fleet: 'member-fleet',
    });
    expect(resolveLeaderBriefFleet(agent)).toEqual({ kind: 'none' });
  });
});

describe('fleet:leader-brief canonical fleet metrics hydration (P-005)', () => {
  it('reuses the resolver, observation-inclusive source, occurrence writer, and builder', async () => {
    const resolution = {
      ok: true,
      scope: { window: { startAt: '2026-08-21T00:00:00.000Z' } },
    } as never;
    const items = [{ id: 'WI-1' }] as never;
    const unavailable = {
      ok: false,
      schemaVersion: 'fleet-metrics-v1',
      error: 'fleet_metrics_unavailable',
      reason: 'fixture result',
      recoverVia: 'fixture:recover',
      requested: {
        fleet: 'fleet-a',
        harness: 'papercusp',
        flowMode: 'current-spec',
        window: 'fleet-lifetime',
      },
    } as const;
    const resolveScope = vi.fn(async () => resolution);
    const listItems = vi.fn(async () => items);
    const readOccurrences = vi.fn(async () => ({
      canonicalClusters: 1,
      rawOccurrences: 2,
      duplicateOccurrences: 1,
      units: {
        canonicalClusters: 'distinct canonical work-item ids with occurrences' as const,
        rawOccurrences: 'append-only report rows' as const,
        duplicateOccurrences: 'report rows not creating a canonical item' as const,
      },
      writer: 'harness_shared.work_item_occurrences' as const,
    }));
    const build = vi.fn(async () => unavailable);

    await expect(
      readLeaderBriefFleetMetrics(
        { workspaceId: 'ws', fleet: 'fleet-a', harness: 'papercusp', assignee: 'su-leader' },
        { resolveScope, listItems, readOccurrences, build },
      ),
    ).resolves.toEqual(unavailable);
    expect(resolveScope).toHaveBeenCalledWith({
      workspaceId: 'ws',
      fleet: 'fleet-a',
      harness: 'papercusp',
      flowMode: 'current-spec',
    });
    expect(listItems).toHaveBeenCalledWith({ harness: 'papercusp', includeObservations: true, resolution });
    expect(readOccurrences).toHaveBeenCalledWith({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      since: '2026-08-21T00:00:00.000Z',
    });
    expect(build).toHaveBeenCalledWith(
      resolution,
      items,
      // P-001: the workspace scope reaches the builder, else feature/paused reads go unknown.
      expect.objectContaining({ sourceCapExhausted: false, assignee: 'su-leader', workspaceId: 'ws' }),
    );
  });

  it('starts the bounded queue metrics read immediately when its harness is available', async () => {
    const fallback = leaderBriefFleetMetricsUnavailable({
      fleet: 'fleet-a',
      harness: 'papercusp',
      reason: 'canonical fleet metric read exceeded the leader-brief leg budget',
      recoverVia: "work_items:burn_down { harness: 'papercusp', fleet: 'fleet-a', window: 'fleet-lifetime' }",
    });
    let releaseRead: ((value: typeof fallback) => void) | undefined;
    const read = vi.fn(() => new Promise<typeof fallback>((resolve) => { releaseRead = resolve; }));
    const pending = startLeaderBriefFleetMetricsRead({
      workspaceId: 'ws',
      fleet: 'fleet-a',
      harness: 'papercusp',
      assignee: 'su-leader',
    }, read);

    await vi.waitFor(() => expect(read).toHaveBeenCalledWith({
      workspaceId: 'ws',
      fleet: 'fleet-a',
      harness: 'papercusp',
      assignee: 'su-leader',
    }));
    releaseRead?.(fallback);
    await expect(pending).resolves.toBe(fallback);
  });

  it('fixes scope before hydrating selected items and overlaps the occurrence census', async () => {
    const resolution = {
      ok: true,
      scope: { window: { startAt: '2026-08-21T00:00:00.000Z' } },
    } as never;
    const items = [{ id: 'WI-1' }] as never;
    const unavailable = {
      ok: false,
      schemaVersion: 'fleet-metrics-v1',
      error: 'fleet_metrics_unavailable',
      reason: 'fixture result',
      recoverVia: 'fixture:recover',
      requested: {
        fleet: 'fleet-a',
        harness: 'papercusp',
        flowMode: 'current-spec',
        window: 'fleet-lifetime',
      },
    } as const;
    let scopeStarted = false;
    let itemsStarted = false;
    let releaseScope: (() => void) | undefined;
    let releaseItems: (() => void) | undefined;
    const resolveScope = vi.fn(async () => {
      scopeStarted = true;
      await new Promise<void>((resolve) => {
        releaseScope = resolve;
      });
      return resolution;
    });
    const listItems = vi.fn(async () => {
      itemsStarted = true;
      await new Promise<void>((resolve) => {
        releaseItems = resolve;
      });
      return items;
    });
    const occurrenceCounts = new Map([['WI-1', 2]]);
    const occurrencePromise = Promise.resolve(occurrenceCounts);
    const readOccurrences = vi.fn(() => occurrencePromise);
    const build = vi.fn(async (_resolution, _items, opts) => {
      await expect(opts.issueOccurrences).resolves.toBe(occurrenceCounts);
      return unavailable;
    });

    const resultPromise = readLeaderBriefFleetMetrics(
      { workspaceId: 'ws', fleet: 'fleet-a', harness: 'papercusp' },
      { resolveScope, listItems, readOccurrences, build },
    );
    await vi.waitFor(() => expect(scopeStarted).toBe(true));
    const itemsStartedBeforeScope = itemsStarted;
    releaseScope?.();
    await vi.waitFor(() => {
      expect(itemsStarted).toBe(true);
      expect(readOccurrences).toHaveBeenCalledTimes(1);
    });
    const occurrenceStartedBeforeItemsReleased = readOccurrences.mock.calls.length === 1;
    releaseItems?.();

    await expect(resultPromise).resolves.toEqual(unavailable);
    expect(scopeStarted).toBe(true);
    expect(itemsStartedBeforeScope).toBe(false);
    expect(occurrenceStartedBeforeItemsReleased).toBe(true);
    expect(readOccurrences).toHaveBeenCalledWith({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      since: '2026-08-21T00:00:00.000Z',
    });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('returns a typed unavailable envelope when the canonical leg fails', async () => {
    const result = await readLeaderBriefFleetMetrics(
      { workspaceId: 'ws', fleet: 'fleet-a', harness: 'papercusp' },
      {
        resolveScope: async () => {
          throw new Error('scope store offline');
        },
        listItems: vi.fn(),
        readOccurrences: vi.fn(),
        build: vi.fn(),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'canonical fleet metric read failed: scope store offline',
      recoverVia: expect.stringContaining('work_items:burn_down'),
    });
  });
});

describe('fleet:leader-brief bounded read fan-out (EI-21577690778811728)', () => {
  it('keeps tuple order while limiting independent reads to the configured width', async () => {
    let active = 0;
    let peak = 0;
    const delays = [25, 5, 15, 1, 10] as const;

    const result = await runLeaderBriefReads(
      delays.map((delay, index) => async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, delay));
        active -= 1;
        return `read-${index}`;
      }) as never,
      2,
    );

    expect(result).toEqual(['read-0', 'read-1', 'read-2', 'read-3', 'read-4']);
    expect(peak).toBe(2);
    expect(LEADER_BRIEF_READ_CONCURRENCY).toBe(4);
  });

  it('degrades a hung optional leg to its fallback within the per-leg deadline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const startedAt = Date.now();
    try {
      const result = await runBoundedLeaderBriefReads(
        [() => new Promise<string>(() => {}), async () => 'read-1'] as const,
        ['fallback-0', 'fallback-1'],
        'test',
        2,
        20,
      );

      expect(result).toEqual(['fallback-0', 'read-1']);
      expect(Date.now() - startedAt).toBeLessThan(250);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[bounded-timeout] leader-brief:test:0 exceeded'));
    } finally {
      warn.mockRestore();
    }
  });

  it('lets the measured 3,272.388ms metrics cohort finish and returns a typed fallback after 5s', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback = leaderBriefFleetMetricsUnavailable({
      fleet: 'fleet-a',
      harness: 'papercusp',
      reason: 'canonical fleet metric read exceeded the leader-brief leg budget',
      recoverVia: "work_items:burn_down { harness: 'papercusp', fleet: 'fleet-a', window: 'fleet-lifetime' }",
    });
    try {
      const measuredDurationMs = 3_272.388;
      const measuredTimerMs = Math.ceil(measuredDurationMs);
      expect(LEADER_BRIEF_FLEET_METRICS_TIMEOUT_MS).toBe(5_000);
      expect(LEADER_BRIEF_FLEET_METRICS_TIMEOUT_MS).toBeGreaterThan(measuredDurationMs);

      const measuredRead = boundedLeaderBriefFleetMetricsRead(
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, elapsedMs: measuredDurationMs }), measuredTimerMs)),
        fallback,
      );
      await vi.advanceTimersByTimeAsync(measuredTimerMs);
      await expect(measuredRead).resolves.toEqual({ ok: true, elapsedMs: measuredDurationMs });

      const slowRead = boundedLeaderBriefFleetMetricsRead(
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), LEADER_BRIEF_FLEET_METRICS_TIMEOUT_MS + 1)),
        fallback,
      );
      await vi.advanceTimersByTimeAsync(LEADER_BRIEF_FLEET_METRICS_TIMEOUT_MS);
      await expect(slowRead).resolves.toEqual(fallback);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('leader-brief:fleet-metrics exceeded 5000ms'),
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('gives the campaign leg a multi-second bound so its sequential writer reads are not always timed out', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback = { campaign: null };
    try {
      const measuredDurationMs = 3_272.388;
      const measuredTimerMs = Math.ceil(measuredDurationMs);
      expect(LEADER_BRIEF_FLEET_CAMPAIGN_TIMEOUT_MS).toBe(5_000);
      expect(LEADER_BRIEF_FLEET_CAMPAIGN_TIMEOUT_MS).toBeGreaterThan(measuredDurationMs);

      const measuredRead = boundedLeaderBriefFleetCampaignRead(
        () => new Promise((resolve) => setTimeout(() => resolve({ campaign: 'measured' }), measuredTimerMs)),
        fallback,
      );
      await vi.advanceTimersByTimeAsync(measuredTimerMs);
      await expect(measuredRead).resolves.toEqual({ campaign: 'measured' });

      const slowRead = boundedLeaderBriefFleetCampaignRead(
        () => new Promise((resolve) => setTimeout(() => resolve({ campaign: 'late' }), LEADER_BRIEF_FLEET_CAMPAIGN_TIMEOUT_MS + 1)),
        fallback,
      );
      await vi.advanceTimersByTimeAsync(LEADER_BRIEF_FLEET_CAMPAIGN_TIMEOUT_MS);
      await expect(slowRead).resolves.toEqual(fallback);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('leader-brief:fleet-campaign exceeded 5000ms'),
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('correlates a timed-out campaign leg with its diagnostic read', async () => {
    vi.useFakeTimers();
    const observe = vi.spyOn(fallbackObservations, 'observeFallback').mockReturnValue(true);
    const correlationId = '8dd90cee-69ac-4fd3-b747-00f8fc7f3b3b';
    const fallback = { campaign: null as string | null };
    const metadata = vi.fn();
    const read = vi.fn((_correlationId: string) => new Promise<typeof fallback>(() => {}));
    try {
      // The adjacent timeout test owns console.warn coverage. Silence it here so
      // this test isolates the correlation contract under vitest-fail-on-console.
      const startedAtByAxis = new Map([['claims' as const, Date.now() - 100]]);
      const elapsedByAxis = new Map([['membership' as const, 80]]);
      const pending = boundedLeaderBriefFleetCampaignRead(read, fallback, correlationId, {
        warn: false,
        onResult: (result) => recordFleetCampaignInvocationDiagnostics(metadata,
          projectFleetCampaignInvocationDiagnostics({
            correlationId,
            elapsedMs: result.elapsedMs,
            degraded: result.degraded,
            reason: result.reason,
            nowMs: Date.now(),
            startedAtByAxis,
            elapsedByAxis,
          })),
      });
      await vi.advanceTimersByTimeAsync(LEADER_BRIEF_FLEET_CAMPAIGN_TIMEOUT_MS);
      await expect(pending).resolves.toBe(fallback);
      expect(read).toHaveBeenCalledWith(correlationId, expect.any(AbortSignal));
      expect(observe).toHaveBeenCalledWith(
        'bounded-operation',
        { eligible: 1, applied: 0, reason: 'timeout', scope: 'leader-brief:fleet-campaign' },
        expect.objectContaining({ correlationId }),
      );
      expect(metadata).toHaveBeenCalledWith({
        fleetCampaignRead: expect.objectContaining({
          correlationId,
          status: 'timed-out',
          elapsedMs: LEADER_BRIEF_FLEET_CAMPAIGN_TIMEOUT_MS,
          completedAxisTimingsMs: { membership: 80 },
          pendingAxisTimingsMs: { claims: LEADER_BRIEF_FLEET_CAMPAIGN_TIMEOUT_MS + 100 },
          notStartedAxes: expect.arrayContaining(['corrections']),
        }),
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      observe.mockRestore();
    }
  });

  it('keeps the cumulative server budget below the 30s MCP client deadline', async () => {
    expect(LEADER_BRIEF_HEADCOUNT_TIMEOUT_MS).toBe(3_000);
    expect(LEADER_BRIEF_OPTIONAL_READ_TIMEOUT_MS).toBe(750);
    expect(LEADER_BRIEF_FLEET_METRICS_TIMEOUT_MS).toBe(5_000);
    expect(LEADER_BRIEF_FLEET_CAMPAIGN_TIMEOUT_MS).toBe(5_000);
    expect(LEADER_BRIEF_TOTAL_TIMEOUT_MS).toBe(25_000);
    expect(LEADER_BRIEF_TOTAL_TIMEOUT_MS).toBeLessThan(30_000);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const startedAt = Date.now();
    try {
      await expect(
        runLeaderBriefWithinDeadline(
          () => new Promise<never>(() => {}),
          { data: { ok: false, error: 'leader_brief_deadline' } },
          20,
        ),
      ).resolves.toEqual({ data: { ok: false, error: 'leader_brief_deadline' } });
      expect(Date.now() - startedAt).toBeLessThan(250);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('fleet:leader-brief:total exceeded 20ms'));
    } finally {
      warn.mockRestore();
    }
  });

  it('gives required lane health the existing diagnostic budget and keeps a typed recovery fallback', async () => {
    const read = vi.fn(async () => ({ laneHealth: null, unavailable: null }));

    await readLeaderBriefLaneHealth(
      { fleet: 'fleet-a', harness: 'papercusp', workspaceId: 'ws-a' },
      read as never,
    );

    expect(read).toHaveBeenCalledWith({
      fleet: 'fleet-a',
      harness: 'papercusp',
      workspaceId: 'ws-a',
      issueFamilyTotalBudgetMs: 12_000,
    });
    expect(leaderBriefLaneHealthUnavailable({ fleet: 'fleet-a', harness: 'papercusp' })).toMatchObject({
      laneHealth: null,
      unavailable: {
        code: 'leader-brief-budget-exceeded',
        stage: 'leader-brief',
        recoverVia: expect.stringContaining('work_items:claimable'),
      },
    });
  });
});

describe('fleet:leader-brief admission-block availability (EI-22054599451266989)', () => {
  it('projects an unavailable read as null, never as a numeric zero', () => {
    expect(
      projectFleetAdmissionBlockRead({
        available: false,
        blocks: null,
        reason: 'optional read failed',
      }),
    ).toEqual({ blocks: [], count: null });
  });

  it('keeps a measured empty result as a real zero', () => {
    expect(projectFleetAdmissionBlockRead({ available: true, blocks: [] })).toEqual({ blocks: [], count: 0 });
    const blocks = [{ dependencyEscape: null }] as FleetAdmissionBlock[];
    expect(projectFleetAdmissionBlockRead({ available: true, blocks })).toEqual({ blocks, count: 1 });
  });
});

describe('fleet:leader-brief launch worker attestation projection (P-003)', () => {
  it('projects stage status and failures from the durable transaction without re-deriving them', () => {
    const projected = compactLaunchWorkerAttestation({
      version: 1,
      transactionId: 'tx-worker-1',
      state: 'partial',
      requestedAt: 1,
      updatedAt: 2,
      requestedMemberIds: ['su-ready', 'su-no-wake'],
      openedMemberIds: ['su-ready', 'su-no-wake'],
      verifiedMemberIds: ['su-ready', 'su-no-wake'],
      workerReadyMemberIds: ['su-ready'],
      governor: {
        version: 1,
        probeOwnerIds: ['su-no-wake'],
        attestationAttempts: { 'su-no-wake': 2 },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: {
          version: 1,
          outcome: 'unverified',
          decidedAt: 3,
          target: 2,
          productiveCapacityFloor: 1,
          liveMemberIds: ['su-ready', 'su-no-wake'],
          workerReadyMemberIds: ['su-ready'],
          unreadyMemberIds: ['su-no-wake'],
          unverifiedMemberIds: [],
          action: 'retry',
          reason: 'worker stages remain non-ready',
        },
      },
      workerAttestations: [
        {
          version: 1,
          ownerId: 'su-ready',
          ready: true,
          stages: {
            agentCall: { status: 'satisfied', successfulCalls: 2 },
            durableWake: { status: 'satisfied', wakeSource: 'loop' },
            schedulerPull: { status: 'satisfied', calls: 1, successfulCalls: 1 },
            disposition: { status: 'satisfied', kind: 'claimed', workItemId: 'WI-1' },
          },
          failures: [],
        },
        {
          version: 1,
          ownerId: 'su-no-wake',
          ready: false,
          stages: {
            agentCall: { status: 'satisfied', successfulCalls: 1 },
            durableWake: { status: 'missing', wakeSource: null },
            schedulerPull: { status: 'satisfied', calls: 1, successfulCalls: 1 },
            disposition: { status: 'satisfied', kind: 'no-claim', reason: 'lane_drained' },
          },
          failures: [
            {
              stage: 'durableWake',
              code: 'durable-wake-missing',
              detail: 'No durable wake.',
            },
          ],
        },
      ],
      failed: [],
      waves: [],
      recovery: { retryOwnerIds: [], nextAction: 'none' },
      requestedMembers: [],
    } as never);

    expect(projected).toEqual({
      transactionId: 'tx-worker-1',
      state: 'partial',
      requested: 2,
      observed: 2,
      ready: 1,
      workerReadyMemberIds: ['su-ready'],
      governorVerdict: {
        outcome: 'unverified',
        action: 'retry',
        decidedAt: 3,
        target: 2,
        productiveCapacityFloor: 1,
        reason: 'worker stages remain non-ready',
      },
      members: [
        {
          ownerId: 'su-ready',
          ready: true,
          stages: {
            agentCall: 'satisfied',
            durableWake: 'satisfied',
            schedulerPull: 'satisfied',
            disposition: 'satisfied',
          },
          failures: [],
        },
        {
          ownerId: 'su-no-wake',
          ready: false,
          stages: {
            agentCall: 'satisfied',
            durableWake: 'missing',
            schedulerPull: 'satisfied',
            disposition: 'satisfied',
          },
          failures: ['durable-wake-missing'],
        },
      ],
    });
  });

  it('omits the block for legacy transactions that predate worker attestation', () => {
    expect(
      compactLaunchWorkerAttestation({
        transactionId: 'legacy',
        requestedMemberIds: [],
      } as never),
    ).toBeUndefined();
  });

  it('surfaces a governor-only terminal verdict without inventing worker stages', () => {
    const projected = compactLaunchWorkerAttestation({
      transactionId: 'governor-observation',
      state: 'partial',
      requestedMemberIds: ['su-legacy'],
      governor: {
        terminalVerdict: {
          outcome: 'unverified',
          action: 'wait',
          decidedAt: 4,
          target: 1,
          productiveCapacityFloor: 1,
          reason: 'legacy member has no typed attestation',
        },
      },
    } as never);

    expect(projected).toMatchObject({
      requested: 1,
      observed: 0,
      ready: 0,
      members: [],
      governorVerdict: {
        outcome: 'unverified',
        action: 'wait',
        reason: 'legacy member has no typed attestation',
      },
    });
  });
});

describe('fleet:leader-brief announced gate projection (P-027)', () => {
  const announcement = (overrides: Record<string, unknown> = {}) =>
    ({
      eventKey: 'fleet:alpha:ready',
      note: 'ready gate',
      scopeKind: 'fleet',
      scopeRef: 'alpha',
      subscriberId: 'su-leader',
      firedAt: null,
      firedReason: null,
      ...overrides,
    }) as never;

  it('keeps only visible gates, includes fired latches, and joins live awaiters', async () => {
    const out = await readLeaderAnnouncedGates(
      { fleetSlug: 'alpha', planSlug: 'plan-a', harnessSlug: 'papercusp' },
      {
        listAnnouncements: async () => [
          announcement(),
          announcement({
            eventKey: 'plan:plan-a:shipped',
            scopeKind: 'plan',
            scopeRef: 'plan-a',
            firedAt: '2026-08-26T20:00:00.000Z',
            firedReason: 'event',
          }),
          announcement({ eventKey: 'fleet:other:hidden', scopeRef: 'other' }),
        ],
        listAwaits: async (key) => Array.from({ length: key.includes('shipped') ? 2 : 1 }, () => ({}) as never),
      },
    );

    expect(out).toEqual([
      {
        event: 'fleet:alpha:ready',
        note: 'ready gate',
        scope: 'fleet:alpha',
        announcedBy: 'su-leader',
        fired: false,
        firedAt: null,
        awaiters: 1,
      },
      {
        event: 'plan:plan-a:shipped',
        note: 'ready gate',
        scope: 'plan:plan-a',
        announcedBy: 'su-leader',
        fired: true,
        firedAt: '2026-08-26T20:00:00.000Z',
        awaiters: 2,
      },
    ]);
  });

  it('distinguishes measured-empty from an unavailable read', async () => {
    await expect(
      readLeaderAnnouncedGates(
        { fleetSlug: 'alpha' },
        { listAnnouncements: async () => [], listAwaits: async () => [] },
      ),
    ).resolves.toEqual([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        readLeaderAnnouncedGates(
          { fleetSlug: 'alpha' },
          {
            listAnnouncements: async () => {
              throw new Error('store unavailable');
            },
            listAwaits: async () => [],
          },
        ),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        '[bounded-timeout] leader-brief:announced-gates failed: store unavailable — degrading to fallback',
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('leader-brief leadership refresh boundary (EI-21355781180893454)', () => {
  const activeLeader = {
    disposition: { kind: 'is-leader' as const },
    allowLeadershipWrites: true,
    hasFleetRecord: true,
    ownerId: 'leader-1',
  };

  it('does not repair a winding-down leader after loop:end', () => {
    expect(shouldRefreshLeaderControlForBrief({ ...activeLeader, controlState: 'active' })).toBe(true);
    expect(shouldRefreshLeaderControlForBrief({ ...activeLeader, controlState: 'winding-down' })).toBe(false);
  });

  it('keeps the write disabled for read-only viewers and missing fleet records', () => {
    expect(
      shouldRefreshLeaderControlForBrief({
        ...activeLeader,
        allowLeadershipWrites: false,
        controlState: 'active',
      }),
    ).toBe(false);
    expect(
      shouldRefreshLeaderControlForBrief({
        ...activeLeader,
        hasFleetRecord: false,
        controlState: 'active',
      }),
    ).toBe(false);
  });
});

describe('leader-brief degraded fleet-record control recovery (EI-22668285442179217)', () => {
  const selfLedRecord = {
    fleetSlug: 'alpha',
    leaderOwnerId: 'leader-1',
    controlState: 'active',
  };

  it('recovers positive self-leadership from the independent led-fleets read', async () => {
    const listLedFleets = vi.fn(async () => [selfLedRecord]);

    await expect(
      recoverFleetRecordForLeaderControl({
        workspaceId: 'ws-1',
        fleetSlug: 'alpha',
        ownerId: 'leader-1',
        allowLeadershipWrites: true,
        fleetRecordResult: { value: undefined, degraded: true },
        listLedFleets: listLedFleets as never,
      }),
    ).resolves.toBe(selfLedRecord);
    expect(listLedFleets).toHaveBeenCalledWith('ws-1', 'leader-1');
  });

  it('does not turn degraded absence into takeover authority', async () => {
    const listLedFleets = vi.fn(async () => [{ ...selfLedRecord, leaderOwnerId: 'another-leader' }]);

    await expect(
      recoverFleetRecordForLeaderControl({
        workspaceId: 'ws-1',
        fleetSlug: 'alpha',
        ownerId: 'leader-1',
        allowLeadershipWrites: true,
        fleetRecordResult: { value: undefined, degraded: true },
        listLedFleets: listLedFleets as never,
      }),
    ).resolves.toBeNull();
  });

  it('does not perform corroboration or writes for viewers or a measured empty read', async () => {
    const listLedFleets = vi.fn(async () => [selfLedRecord]);

    await expect(
      recoverFleetRecordForLeaderControl({
        workspaceId: 'ws-1',
        fleetSlug: 'alpha',
        ownerId: 'leader-1',
        allowLeadershipWrites: false,
        fleetRecordResult: { value: undefined, degraded: true },
        listLedFleets: listLedFleets as never,
      }),
    ).resolves.toBeNull();
    await expect(
      recoverFleetRecordForLeaderControl({
        workspaceId: 'ws-1',
        fleetSlug: 'alpha',
        ownerId: 'leader-1',
        allowLeadershipWrites: true,
        fleetRecordResult: { value: null, degraded: false },
        listLedFleets: listLedFleets as never,
      }),
    ).resolves.toBeNull();
    expect(listLedFleets).not.toHaveBeenCalled();
  });
});

describe('EI-25630740795866119: bounded fleet pause evidence', () => {
  const laneHealth: FleetLaneHealth = {
    claimable: 2, matchedByFilter: 2, excluded: {},
    issueFamily: { claimable: 2, matchedByFilter: 2, excluded: {} },
    featureFamily: { claimable: 0, matchedByFilter: 0, excluded: {} },
    effective: { claimable: 2, matchedByFilter: 2, excluded: {}, basis: 'issue+feature-family' },
    familyReachability: { issue: true, feature: true },
    spec: { ref: 'alpha@4', specId: 'alpha', revision: 4, matchedBy: 'fleet',
      harness: 'papercusp', assigneeScoped: null, planScoped: false },
  };

  it.each(['rejected', 'timed out', 'missing'] as const)(
    'keeps a %s record unknown through claimability and transport', async (failure) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const read = vi.fn(() => {
          if (failure === 'rejected') return Promise.reject(new Error('registry unavailable'));
          if (failure === 'timed out') return new Promise<null>(() => {});
          return Promise.resolve(null);
        });
        const pending = withBoundedTimeout(read, {
          fallback: undefined, timeoutMs: 20, label: 'leader-brief:fleetRecord',
        });
        await vi.advanceTimersByTimeAsync(20);
        const result = await pending;
        expect(result.degraded).toBe(failure !== 'missing');
        expect(result.reason).toBe(failure === 'rejected' ? 'error' : failure === 'timed out' ? 'timeout' : undefined);
        expect(read).toHaveBeenCalledTimes(1);
        if (failure === 'missing') expect(warn).not.toHaveBeenCalled();
        else expect(warn).toHaveBeenCalledWith(expect.stringContaining('leader-brief:fleetRecord'));
        const pause = projectLeaderBriefFleetPause(result.value);
        expect(pause).toEqual({ paused: null, reason: null });
        const aggregate = buildClaimableNowAggregate({ fleet: 'alpha', laneHealth, fleetPaused: pause.paused });
        expect(aggregate).toMatchObject({ value: 2, interpretation: {
          state: 'unknown', exactness: { status: 'unknown', reason: expect.stringContaining('pause state') },
          evidence: { fleetPaused: null },
        } });
        for (const tier of ['standard', 'trimmed'] as const) {
          expect(shapeLeaderBrief({ ok: true, summary: {
            fleet: 'alpha', members: 0, fleet_paused: pause.paused, claimable_now: aggregate,
          } }, tier)).toMatchObject({ summary: {
            fleet_paused: null, claimable_now: { value: 2, interpretation: { state: 'unknown', evidence: { fleetPaused: null } } },
          } });
        }
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { controlState: 'active' as const, paused: false, interpretation: 'claimable', reason: null },
    { controlState: 'winding-down' as const, paused: true, interpretation: 'paused', reason: 'owner pause' },
  ])('preserves measured $controlState control and its reason', ({ controlState, paused, interpretation, reason }) => {
    const pause = projectLeaderBriefFleetPause({ controlState, controlReason: 'owner pause' });
    expect(pause).toEqual({ paused, reason });
    expect(buildClaimableNowAggregate({ fleet: 'alpha', laneHealth, fleetPaused: pause.paused }))
      .toMatchObject({ value: 2, interpretation: { state: interpretation, exactness: { status: 'exact' }, evidence: { fleetPaused: paused } } });
  });

  it('uses positive recovered paused authority without manufacturing an active fallback', async () => {
    const recovered = await recoverFleetRecordForLeaderControl({
      workspaceId: 'ws-1', fleetSlug: 'alpha', ownerId: 'leader-1', allowLeadershipWrites: true,
      fleetRecordResult: { value: undefined, degraded: true },
      listLedFleets: vi.fn(async () => [{ fleetSlug: 'alpha', leaderOwnerId: 'leader-1',
        controlState: 'winding-down', controlReason: 'owner pause' }]) as never,
    });
    expect(projectLeaderBriefFleetPause(recovered)).toEqual({ paused: true, reason: 'owner pause' });
  });
});

describe('fleet:leader-brief — ambient workspace transaction safety (EI-20192040030675541)', () => {
  it('opts out because the supervision read never uses ctx.tx', () => {
    expect((leaderBriefTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('computeFleetHeadcountVsExecutableFrontierAlert (WI-41173 / P-011)', () => {
  it('uses min(readyWidth, claimable) and fires only above that width', () => {
    const out = computeFleetHeadcountVsExecutableFrontierAlert({
      planSlug: 'one-plan',
      liveNonLeaderWorkers: 5,
      readyWidth: 2,
      claimable: 7,
      fleet: 'frontier-fleet',
      harness: 'papercusp',
    });
    expect(out).toMatchObject({
      alert: true,
      executableWidth: 2,
      excessWorkers: 3,
      liveNonLeaderWorkers: 5,
    });
    expect(out?.reason).toMatch(/5 live non-leader worker.*executableWidth=2.*by 3/i);
    expect(out?.falsifier).toMatchObject({
      tool: 'fleet:leader-brief',
      check: "fleet:leader-brief { fleet: 'frontier-fleet', harness: 'papercusp' }",
    });
    expect(
      computeFleetHeadcountVsExecutableFrontierAlert({
        planSlug: 'one-plan',
        liveNonLeaderWorkers: 4,
        readyWidth: 8,
        claimable: 3,
      }),
    ).toMatchObject({ alert: true, executableWidth: 3, excessWorkers: 1 });
  });

  it('returns measured false at the frontier and suppresses paused/unknown inputs', () => {
    const base = { planSlug: 'one-plan', liveNonLeaderWorkers: 3, readyWidth: 8, claimable: 3 };
    expect(computeFleetHeadcountVsExecutableFrontierAlert(base)).toMatchObject({
      alert: false,
      executableWidth: 3,
      excessWorkers: 0,
    });
    expect(computeFleetHeadcountVsExecutableFrontierAlert({ ...base, fleetPaused: true })).toBeUndefined();
    expect(computeFleetHeadcountVsExecutableFrontierAlert({ ...base, readyWidth: null })).toBeUndefined();
    expect(computeFleetHeadcountVsExecutableFrontierAlert({ ...base, claimable: null })).toBeUndefined();
  });
});

describe('exactPositiveSinglePlanSlugFromFilter (WI-41173 / P-011)', () => {
  it('accepts exact AND lanes and ORs only when every branch requires the same plan', () => {
    expect(
      exactPositiveSinglePlanSlugFromFilter({
        all: [
          { field: 'plan', op: '=', value: 'one-plan' },
          { field: 'kind', op: 'in', value: ['bug', 'change'] },
        ],
      }),
    ).toBe('one-plan');
    expect(
      exactPositiveSinglePlanSlugFromFilter({
        any: [
          {
            all: [
              { field: 'plan', op: '=', value: 'one-plan' },
              { field: 'kind', op: '=', value: 'bug' },
            ],
          },
          {
            all: [
              { field: 'plan', op: '=', value: 'one-plan' },
              { field: 'kind', op: '=', value: 'change' },
            ],
          },
        ],
      }),
    ).toBe('one-plan');
  });

  it('rejects broad OR, multi-plan, negative, and missing-plan scopes', () => {
    for (const filter of [
      {
        any: [
          { field: 'plan', op: '=', value: 'one-plan' },
          { field: 'kind', op: '=', value: 'bug' },
        ],
      },
      { field: 'plan', op: 'in', value: ['one-plan', 'another-plan'] },
      { not: { field: 'plan', op: '=', value: 'one-plan' } },
      { field: 'kind', op: '=', value: 'bug' },
    ])
      expect(exactPositiveSinglePlanSlugFromFilter(filter as never)).toBeNull();
  });
});

describe('buildLeaderDependencyBottleneckView (WI-41168 / P-006)', () => {
  it('joins canonical work-item identities to reconciled holders and derives age only from progress', () => {
    const result: DependencyBottleneckResult = {
      population: {
        kind: 'exact-plan-open-roots',
        planSlug: 'one-plan',
        harnessSlug: 'papercusp',
        basis: 'unified-dependency-graph',
        openRoots: 6,
        candidates: 2,
        shown: 2,
        limit: 8,
        truncated: false,
        depthLimited: false,
        maxDepth: 64,
      },
      rows: [
        {
          key: 'work_item:WI-41117',
          kind: 'work_item',
          ref: 'WI-41117',
          status: 'open',
          title: 'Shared dependency',
          workItemRefs: ['WI-41117'],
          lastProgressAt: '2026-08-22T04:59:00.000Z',
          openBlockedCount: 5,
        },
        {
          key: 'plan_item:one-plan#P-001',
          kind: 'plan_item',
          ref: 'P-001',
          status: 'todo',
          title: 'Unowned prerequisite',
          workItemRefs: [],
          lastProgressAt: null,
          openBlockedCount: 1,
        },
      ],
    };
    const holders = [
      baseAgent({
        agentId: 'su-holder',
        label: 'holder',
        alive: false,
        sessionState: 'ended',
        verdict: 'dead',
        claims: [
          {
            type: 'work-item',
            harnessSlug: 'papercusp',
            planSlug: 'one-plan',
            id: 'wi-41117',
            itemKind: 'bug',
            detail: 'Shared dependency',
            status: 'open',
            acquiredTs: null,
            expiresTs: null,
            active: true,
            orphaned: false,
            stalled: false,
            lastProgressAt: '2099-01-01T00:00:00.000Z',
            activity: 'dead',
            rank: null,
            rankWriter: null,
          },
        ],
      }),
    ];

    const view = buildLeaderDependencyBottleneckView(result, holders, Date.parse('2026-08-24T05:00:00.000Z'));

    expect(view).toMatchObject({
      status: 'measured',
      population: {
        progressBasis: 'harness_shared.work_items.last_progress_at',
        holderBasis: 'reconciled-fleet-assignment-claims',
      },
      rows: [
        {
          rank: 1,
          ref: 'WI-41117',
          hoursSinceProgress: 48,
          holder: {
            state: 'held',
            count: 1,
            agents: [{ agentId: 'su-holder', alive: false, sessionState: 'ended', verdict: 'dead' }],
          },
        },
        {
          rank: 2,
          ref: 'P-001',
          hoursSinceProgress: null,
          holder: { state: 'unowned', count: 0, agents: [] },
        },
      ],
    });
  });

  it('adds Mermaid only when the same query result includes the opt-in graph rows (WI-41170 / P-008)', () => {
    const result: DependencyBottleneckResult = {
      population: {
        kind: 'exact-plan-open-roots',
        planSlug: 'one-plan',
        harnessSlug: 'papercusp',
        basis: 'unified-dependency-graph',
        openRoots: 1,
        candidates: 1,
        shown: 1,
        limit: 8,
        truncated: false,
        depthLimited: false,
        maxDepth: 64,
      },
      rows: [],
      graph: {
        nodes: [
          { key: 'plan_item:one-plan#P-001', kind: 'plan_item', ref: 'P-001', status: 'todo', title: 'Blocked lane' },
          { key: 'work_item:WI-41117', kind: 'work_item', ref: 'WI-41117', status: 'open', title: 'Shared blocker' },
        ],
        edges: [
          {
            key: 'edge-1',
            subjectKey: 'plan_item:one-plan#P-001',
            dependencyKey: 'work_item:WI-41117',
            relation: 'work-item-blocks',
            externalRef: null,
          },
        ],
      },
    };

    const rendered = buildLeaderDependencyBottleneckView(result, []);
    expect(rendered).toMatchObject({
      status: 'measured',
      mermaid: expect.stringContaining('n0 -->|blocked by| n1'),
    });

    const withoutGraph = buildLeaderDependencyBottleneckView({ ...result, graph: undefined }, []);
    expect(withoutGraph).not.toHaveProperty('mermaid');
  });
});

describe('buildLeaderBlockerStallBriefView (WI-41171 / P-009)', () => {
  it('derives the alarm from the already-measured P-006 row and carries its falsifier', () => {
    const view = buildLeaderBlockerStallBriefView(
      {
        status: 'measured',
        population: {
          kind: 'exact-plan-open-roots',
          planSlug: 'one-plan',
          harnessSlug: 'papercusp',
          basis: 'unified-dependency-graph',
          openRoots: 2,
          candidates: 1,
          shown: 1,
          limit: 8,
          truncated: false,
          depthLimited: false,
          maxDepth: 64,
          progressBasis: 'harness_shared.work_items.last_progress_at',
          holderBasis: 'reconciled-fleet-assignment-claims',
        },
        rows: [
          {
            rank: 1,
            key: 'work_item:WI-40086',
            kind: 'work_item',
            ref: 'WI-40086',
            status: 'open',
            title: 'Critical blocker',
            workItemRefs: ['WI-40086'],
            openBlockedCount: 2,
            lastProgressAt: '2026-08-24T00:00:00.000Z',
            hoursSinceProgress: 5,
            holder: { state: 'unowned', count: 0, agents: [], truncated: false },
          },
        ],
      },
      'one-fleet',
    );

    expect(view).toMatchObject({
      status: 'alert',
      alert: true,
      row: { rank: 1, itemRef: 'WI-40086' },
      falsifier: {
        tool: 'fleet:assignments',
        check: expect.stringContaining("fleet: 'one-fleet'"),
      },
    });
  });

  it('keeps an unread dependency view unknown instead of calling an empty row set clear', () => {
    expect(
      buildLeaderBlockerStallBriefView({
        status: 'unknown',
        reason: 'read-failed',
        planSlug: 'one-plan',
        harnessSlug: 'papercusp',
      }),
    ).toEqual({
      status: 'unknown',
      alert: null,
      thresholdHours: 4,
      checkedRows: 0,
      reason: 'leader-blocker stall state is UNKNOWN: dependency bottlenecks were not measured (read-failed).',
      unknown: { code: 'dependency-bottlenecks-unmeasured', sourceReason: 'read-failed' },
    });
  });
});

describe('computeDarkFleetAlert (WI-41172 / P-010)', () => {
  it('fires for at least three registered members with zero genuine activity in 30 minutes', () => {
    const out = computeDarkFleetAlert({
      fleet: 'dark-fleet',
      presenceDegraded: false,
      roster: [{ lastActiveSecAgo: null }, { lastActiveSecAgo: 30 * 60 }, { lastActiveSecAgo: 4 * 60 * 60 }],
    });

    expect(out.alert).toBe(true);
    if (out.alert !== true) throw new Error('expected dark-fleet alert to fire');
    expect(out.reason).toMatch(/ZERO genuine activity.*30 minutes/i);
    expect(out.falsifier).toMatchObject({
      tool: 'fleet:assignments',
      check: "fleet:assignments { fleet: 'dark-fleet', include_stale: true }",
    });
    expect(out.falsifier.measurement).toMatch(/independent of.*lastActiveSecAgo/i);
    expect(out.falsifier.kills).toMatch(/tool call within the last 30 minutes|progressing claim/i);
  });

  it('stays false below the population floor or when any member took a recent turn', () => {
    expect(
      computeDarkFleetAlert({
        presenceDegraded: false,
        roster: [{ lastActiveSecAgo: null }, { lastActiveSecAgo: null }],
      }).alert,
    ).toBe(false);
    expect(
      computeDarkFleetAlert({
        presenceDegraded: false,
        roster: [{ lastActiveSecAgo: null }, { lastActiveSecAgo: 29 * 60 + 59 }, { lastActiveSecAgo: 10 * 60 * 60 }],
      }).alert,
    ).toBe(false);
  });

  it('returns in-band unknown when presence degraded, never a false clean or dark verdict', () => {
    const out = computeDarkFleetAlert({
      presenceDegraded: true,
      roster: Array.from({ length: 5 }, () => ({ lastActiveSecAgo: null })),
    });

    expect(out).toMatchObject({ alert: null, reason: expect.stringMatching(/UNKNOWN.*presence/i) });
    expect(out.falsifier).toBeUndefined();
  });
});

describe('computeFleetExecutionCollapseAlert (WI-583276)', () => {
  const roster = [
    { agentId: 'su-a', claims: [{ active: true, status: 'wip' }] },
    { agentId: 'su-b', claims: [{ active: true, status: 'wip' }] },
    { agentId: 'su-c', claims: [] },
  ];

  it('fires only when held claims coexist with zero exact agent-origin members', () => {
    const out = computeFleetExecutionCollapseAlert({
      fleet: 'mute-fleet',
      roster,
      agentOriginOwnerIds: new Set(),
    });
    expect(out.alert).toBe(true);
    expect(out.evidence).toMatchObject({
      rosterMembers: 3,
      agentOriginMembers: 0,
      heldClaimMembers: 2,
      heldClaims: 2,
      silentHeldClaimMembers: 2,
    });
    expect(out.reason).toMatch(/ZERO registered members.*agent-origin/i);
    expect(out.falsifier).toMatchObject({ tool: 'fleet:assignments' });
  });

  it('stays clean when the fleet is working or has no held claims', () => {
    expect(computeFleetExecutionCollapseAlert({ roster, agentOriginOwnerIds: new Set(['su-a']) }).alert).toBe(false);
    expect(
      computeFleetExecutionCollapseAlert({
        roster: roster.map(({ agentId }) => ({ agentId, claims: [] })),
        agentOriginOwnerIds: new Set(),
      }).alert,
    ).toBe(false);
  });

  it('returns in-band unknown when exact telemetry or the canonical roster is degraded', () => {
    const telemetry = computeFleetExecutionCollapseAlert({ roster, agentOriginOwnerIds: null });
    expect(telemetry).toMatchObject({ alert: null, evidence: { agentOriginMembers: null } });
    expect(telemetry.reason).toMatch(/UNKNOWN/i);
    const presence = computeFleetExecutionCollapseAlert({
      roster,
      agentOriginOwnerIds: new Set(),
      presenceDegraded: true,
    });
    expect(presence.alert).toBeNull();
  });
});

describe('fleet:leader-brief — unowned critical age filter (EI-20228488170965112)', () => {
  it('accepts zero as the immediate-triage age threshold', () => {
    expect(leaderBriefTool.args.safeParse({ fleet: 'alpha', unowned_critical_age_hours: 0 }).success).toBe(true);
  });

  it('still rejects negative thresholds', () => {
    expect(leaderBriefTool.args.safeParse({ fleet: 'alpha', unowned_critical_age_hours: -1 }).success).toBe(false);
  });
});

describe('fleet:leader-brief — profile-derived zero-awaiters advisory (P-015)', () => {
  const expectedKeys = [
    'fleet:member-dead:alpha',
    'fleet:member-left:alpha',
    'fleet:drained:alpha',
    'fleet:context-critical:alpha',
    'fleet:claim-released:alpha',
    'fleet:admission-blocked:alpha',
    'fleet:launch-failed:alpha',
  ];

  it('reads the exact seven standard profile keys and stays absent when every key has a live awaiter', async () => {
    const seen: string[] = [];
    const advisory = await readLeaderMonitoringBlindAdvisory('alpha', async (eventKey) => {
      seen.push(eventKey);
      return [{}];
    });

    expect(seen).toEqual(expectedKeys);
    expect(advisory).toBeUndefined();
  });

  it('warns when any required key has zero awaiters and carries one actionable fleet arm handle', async () => {
    const advisory = await readLeaderMonitoringBlindAdvisory('alpha', async (eventKey) =>
      eventKey === 'fleet:drained:alpha' ? [] : [{}],
    );

    expect(advisory).toMatchObject({
      line: expect.stringMatching(/monitoring blind.*1\/7.*live_awaiters:0/i),
      missingEventKeys: ['fleet:drained:alpha'],
      arm: {
        tool: 'events:await',
        args: { event: '@fleet:alpha', note: expect.stringContaining('leader control') },
      },
    });
  });

  it('fails soft by omitting the advisory when the live-awaiter read cannot be established', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        readLeaderMonitoringBlindAdvisory('alpha', async () => {
          throw new Error('await store unavailable');
        }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(expectedKeys.length);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          '[bounded-timeout] leader-brief:monitoring-blind-awaiters failed: await store unavailable',
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('fleetCapacityProviderForMembers (EI-20243921934115652)', () => {
  it('scopes an all-Codex fleet to the Codex pool', () => {
    expect(
      fleetCapacityProviderForMembers([
        { model: 'gpt-5.6-luna', alive: true },
        { model: 'gpt-5.6-sol', alive: true },
      ]),
    ).toBe('codex');
  });

  it('keeps an all-Claude fleet on the Claude pool', () => {
    expect(
      fleetCapacityProviderForMembers([
        { model: 'claude-sonnet-4-5', alive: true },
        { model: 'opus', alive: true },
      ]),
    ).toBe('claude');
  });

  it('ignores dead historical identities when the live fleet is uniform', () => {
    expect(
      fleetCapacityProviderForMembers([
        { model: 'gpt-5.6-luna', alive: true },
        { model: 'claude-sonnet-4-5', alive: false, verdict: 'dead' },
      ]),
    ).toBe('codex');
  });

  it('uses the authoritative adv-session backend for visible PSU members without model tiers', () => {
    expect(
      fleetCapacityProviderForMembers(
        [
          { agentId: 'su-codex-1', model: null, alive: true },
          { agentId: 'su-codex-2', model: null, alive: true },
        ],
        new Map([
          ['su-codex-1', 'codex'],
          ['su-codex-2', 'codex'],
        ]),
      ),
    ).toBe('codex');
  });

  it('ignores a dead historical Claude backend beside live visible Codex members', () => {
    expect(
      fleetCapacityProviderForMembers(
        [
          { agentId: 'su-codex', model: null, alive: true },
          { agentId: 'su-claude-old', model: null, alive: false, verdict: 'dead' },
        ],
        new Map([
          ['su-codex', 'codex'],
          ['su-claude-old', 'claude'],
        ]),
      ),
    ).toBe('codex');
  });

  it('keeps live visible mixed backends unknown', () => {
    expect(
      fleetCapacityProviderForMembers(
        [
          { agentId: 'su-codex', model: null, alive: true },
          { agentId: 'su-claude', model: null, alive: true },
        ],
        new Map([
          ['su-codex', 'codex'],
          ['su-claude', 'claude'],
        ]),
      ),
    ).toBeNull();
  });

  // WI-41005: the leader OBSERVES this pool, it does not pull from it. Counting its row made
  // every cross-backend-led fleet read as mixed, so poolCapacity stayed null and blockedAt told
  // the leader the pool "could NOT be read" no matter how often it probed.
  it('ignores a Claude leader supervising a Codex worker fleet', () => {
    expect(
      fleetCapacityProviderForMembers(
        [
          { agentId: 'su-leader', model: null, alive: true, fleetRole: 'leader' },
          { agentId: 'su-worker-1', model: null, alive: true, fleetRole: 'member' },
          { agentId: 'su-worker-2', model: null, alive: true, fleetRole: 'member' },
        ],
        new Map([
          ['su-leader', 'claude'],
          ['su-worker-1', 'codex'],
          ['su-worker-2', 'codex'],
        ]),
      ),
    ).toBe('codex');
  });

  // The leader exclusion must not swallow a REAL mixed-worker fleet: that ambiguity is
  // load-bearing, because no single pool reading can describe those members.
  it('still reports unknown when the WORKERS themselves span providers', () => {
    expect(
      fleetCapacityProviderForMembers(
        [
          { agentId: 'su-leader', model: null, alive: true, fleetRole: 'leader' },
          { agentId: 'su-worker-codex', model: null, alive: true, fleetRole: 'member' },
          { agentId: 'su-worker-claude', model: null, alive: true, fleetRole: 'member' },
        ],
        new Map([
          ['su-leader', 'codex'],
          ['su-worker-codex', 'codex'],
          ['su-worker-claude', 'claude'],
        ]),
      ),
    ).toBeNull();
  });

  it('does not infer a provider from OMP without a model', () => {
    expect(
      fleetCapacityProviderForMembers([{ agentId: 'su-omp', model: null, alive: true }], new Map([['su-omp', 'omp']])),
    ).toBeNull();
    expect(
      fleetCapacityProviderForMembers(
        [{ agentId: 'su-omp', model: 'gpt-5.6-luna', alive: true }],
        new Map([['su-omp', 'omp']]),
      ),
    ).toBe('codex');
  });

  it('returns unknown for live-mixed or unmeasured fleets instead of borrowing a provider', () => {
    expect(
      fleetCapacityProviderForMembers([
        { model: 'gpt-5.6-luna', alive: true },
        { model: 'claude-sonnet-4-5', alive: true },
      ]),
    ).toBeNull();
    expect(fleetCapacityProviderForMembers([{ model: null }, {}])).toBeNull();
  });
});

/** decorateComposedParkedOn mutates its input in place, adding an optional
 *  `parkedOnResolved` — test fixtures declare it explicitly so the mutated
 *  field is visible to tsc after the call, not just at runtime. */
type ComposedTestAgent = { agentId: string; parkedOn: string[]; parkedOnResolved?: Array<string | ComposedParkEntry> };

function baseAgent(overrides: Partial<DecoratedAgent> = {}): DecoratedAgent {
  return {
    agentId: 'su-1',
    label: null,
    name: null,
    present: true,
    alive: true,
    heartbeatAt: new Date(NOW).toISOString(),
    intent: '',
    declaredPlanSlug: null,
    fleetSlug: 'p2p-git',
    fleetRole: 'member',
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
    ...overrides,
  };
}

describe('reconcilePsuHostLiveness (WI-4755)', () => {
  it('marks a parked visible member ended when its psu host is gone', () => {
    const agent = baseAgent({ sessionState: 'parked', tty: '/dev/pts/11' });
    reconcilePsuHostLiveness([agent], new Map([['su-1', 'su']]), () => null);
    expect(agent.sessionState).toBe('ended');
    expect(agent.alive).toBe(false);
  });

  it('does not let a stale directed-wake activity row keep a hostless member live', () => {
    const agent = baseAgent({ sessionState: 'live', tty: '/dev/pts/12' });
    reconcilePsuHostLiveness([agent], new Map([['su-1', 'su']]), () => null);
    expect(agent.sessionState).toBe('ended');
    expect(agent.alive).toBe(false);
  });

  it('preserves a headless su member without a psu host', () => {
    const agent = baseAgent({
      sessionState: 'live',
      tty: null,
      lastToolCallAt: new Date(NOW - 1_645).toISOString(),
    });
    reconcilePsuHostLiveness([agent], new Map([['su-1', 'su']]), () => null);
    expect(agent.sessionState).toBe('live');
    expect(agent.alive).toBe(true);
  });

  it('preserves nursery cups without a psu host', () => {
    const agent = baseAgent({ sessionState: 'parked' });
    reconcilePsuHostLiveness([agent], new Map([['su-1', 'cup']]), () => null);
    expect(agent.sessionState).toBe('parked');
    expect(agent.alive).toBe(true);
  });

  it('keeps a no-host ghost out of the leader census after reconciliation', () => {
    const agent = baseAgent({ agentId: 'su-ghost', sessionState: 'live', tty: '/dev/pts/13' });
    reconcilePsuHostLiveness([agent], new Map([['su-ghost', 'su']]), () => null);
    const { rows, census } = selectLeaderBriefMembers([agent], 'p2p-git');
    expect(rows).toEqual([]);
    expect(census).toMatchObject({ candidates: 1, counted: 0, withheld: 1 });
  });
});

describe('selectLeaderBriefMembers (EI-11840)', () => {
  it('keeps every live presence-backed member, including an idle member with no claims', () => {
    const { rows: members } = selectLeaderBriefMembers(
      [
        baseAgent({ agentId: 'su-live-working', claims: [{ type: 'work-item', id: 'WI-1' }] as never }),
        baseAgent({ agentId: 'su-live-idle', claims: [], alive: true }),
        baseAgent({ agentId: 'su-other-fleet', fleetSlug: 'other-fleet', alive: true }),
        baseAgent({ agentId: 'su-stale', alive: false, claims: [] }),
      ],
      'p2p-git',
    );

    expect(members.map((member) => member.agentId)).toEqual(['su-live-working', 'su-live-idle']);
  });

  it('keeps all recently active respawned members with current work claims', () => {
    const ids = [
      'su-respawn-63bfff47ddf3583f5111e499fb21db10',
      'su-respawn-a0591f4fa7c5fb461e434592f28b4d7d',
      'su-respawn-ebb0fbe43e480e827420268a317e294b',
    ];
    const entries = ids.map((agentId, index) => baseAgent({
      agentId,
      sessionState: 'live',
      alive: true,
      lastActiveAt: new Date(NOW - (15_000 + index * 12_000)).toISOString(),
      claims: [{ type: 'work-item', id: `WI-${index + 1}` }] as never,
    }));

    const { rows, census } = selectLeaderBriefMembers(entries, 'p2p-git');

    expect(rows.map((member) => member.agentId)).toEqual(ids);
    expect(census).toMatchObject({ candidates: 3, counted: 3, withheld: 0 });
  });

  it('includes stale canonical roster entries only when explicitly requested', () => {
    const stale = baseAgent({ agentId: 'su-stale', alive: false, claims: [] });
    expect(selectLeaderBriefMembers([stale], 'p2p-git').rows).toEqual([]);
    expect(selectLeaderBriefMembers([stale], 'p2p-git', true).rows).toEqual([stale]);
  });

  // P-010 (fleet-lead-instrumentation-audit-2026-08-09): the same fleet read 11 /
  // 11 / 14 / 8 / 9 across leader-brief and fleet:assignments within minutes, each
  // number defensible and none reconciled. The census makes every count say what
  // it counted and what it hid.
  it('names the population and reports what the stale-idle cut withheld, with the lever to reveal it', () => {
    const entries = [
      baseAgent({ agentId: 'su-live-working', claims: [{ type: 'work-item', id: 'WI-1' }] as never }),
      baseAgent({ agentId: 'su-live-idle', claims: [], alive: true }),
      baseAgent({ agentId: 'su-stale-1', alive: false, claims: [] }),
      baseAgent({ agentId: 'su-stale-2', alive: false, claims: [] }),
    ];
    const { rows, census } = selectLeaderBriefMembers(entries, 'p2p-git');
    expect(census.counted).toBe(rows.length);
    expect(census.candidates).toBe(4);
    expect(census.withheld).toBe(2);
    expect(census.reveal).toBe(
      'coord:presence { owner: "<agentId>" } (targeted stale-row lookup; broad stale-roster reads are unsupported)',
    );
    // The operative warning: this default hides members exactly when they die.
    expect(census.withheldReason).toContain('stale-idle');

    const revealed = selectLeaderBriefMembers(entries, 'p2p-git', true);
    expect(revealed.census.counted).toBe(4);
    expect(revealed.census.withheld).toBe(0);
    expect(revealed.census.withheldReason).toBeNull();
  });

  // Members of ANOTHER fleet were never candidates for this number. Counting them
  // as `withheld` would make the field grow with unrelated fleets and read as mass
  // concealment — the opposite of the reconciliation this exists to provide.
  it('does NOT count other fleets as withheld — roster membership is not a discretionary filter', () => {
    const { census } = selectLeaderBriefMembers(
      [
        baseAgent({ agentId: 'su-live', alive: true, claims: [] }),
        baseAgent({ agentId: 'su-other-1', fleetSlug: 'other-fleet', alive: true }),
        baseAgent({ agentId: 'su-other-2', fleetSlug: 'other-fleet', alive: false, claims: [] }),
      ],
      'p2p-git',
    );
    expect(census.candidates).toBe(1);
    expect(census.counted).toBe(1);
    expect(census.withheld).toBe(0);
    expect(census.population).toContain('p2p-git');
  });
});

describe('compactLeaderBriefMemberVerdicts (EI-20226510994156306)', () => {
  it('keeps every member id and verdict available for a large-fleet recovery read', () => {
    const members = Array.from({ length: 50 }, (_, i) => ({
      agentId: `su-${i}`,
      verdict: i % 2 === 0 ? ('monitoring' as const) : ('speaking' as const),
      idleVerdict: { cause: i % 2 === 0 ? ('genuinely-idle' as const) : ('working' as const) },
    }));

    const index = compactLeaderBriefMemberVerdicts(members);

    expect(index).toHaveLength(50);
    expect(index[0]).toEqual({ agentId: 'su-0', verdict: 'monitoring', idleCause: 'genuinely-idle' });
    expect(index[49]).toEqual({ agentId: 'su-49', verdict: 'speaking', idleCause: 'working' });
    expect(new Set(index.map((row) => row.agentId)).size).toBe(50);
  });
});

describe('bench target identity index (EI-21242929839064139)', () => {
  it('keeps every suggested member and puts suggested rows first in bounded detail', () => {
    const members = [
      { agentId: 'ordinary-a' },
      { agentId: 'bench-a', benchSuggestion: { kind: 'laneless-idle' as const } },
      { agentId: 'ordinary-b' },
      { agentId: 'bench-b', benchSuggestion: { kind: 'stalled-no-mcp' as const } },
    ];

    expect(compactLeaderBriefBenchSuggestions(members)).toEqual([
      { agentId: 'bench-a', kind: 'laneless-idle' },
      { agentId: 'bench-b', kind: 'stalled-no-mcp' },
    ]);
    expect(prioritizeBenchSuggestedMembers(members).map((member) => member.agentId)).toEqual([
      'bench-a',
      'bench-b',
      'ordinary-a',
      'ordinary-b',
    ]);
  });
});

describe('intent attention actionability (WI-41174 / P-012)', () => {
  it('maps stale ownership evidence to verification and lets staleness dominate divergence', () => {
    expect(
      computeIntentAttention({
        agentId: 'su-stale',
        sessionState: 'parked',
        intentAgeSec: 3_600,
        intentStale: true,
        intentDivergent: true,
      }),
    ).toMatchObject({
      kind: 'intent-stale',
      action: 'verify-ownership-before-reclaim',
      reason: expect.stringMatching(/assignments.*checkpoint.*before reclaiming/i),
    });
  });

  it('maps active intent drift to a concrete declaration refresh and stays absent for false/unknown', () => {
    expect(
      computeIntentAttention({
        agentId: 'su-active',
        sessionState: 'live',
        intentAgeSec: 1_901,
        intentStale: false,
        intentDivergent: true,
      }),
    ).toMatchObject({
      kind: 'intent-divergent',
      action: 'request-intent-refresh',
      reason: expect.stringContaining('coord:declare-intent'),
    });
    expect(computeIntentAttention({ agentId: 'su-unknown', intentStale: null, intentDivergent: null })).toBeUndefined();
    expect(computeIntentAttention({ agentId: 'su-clean', intentStale: false, intentDivergent: false })).toBeUndefined();
  });

  it('keeps every target+action in the compact index and prioritizes actionable detail rows', () => {
    const members = [
      { agentId: 'ordinary' },
      {
        agentId: 'stale',
        intentAttention: {
          kind: 'intent-stale' as const,
          action: 'verify-ownership-before-reclaim' as const,
          reason: 'verify first',
        },
      },
      {
        agentId: 'divergent',
        intentAttention: {
          kind: 'intent-divergent' as const,
          action: 'request-intent-refresh' as const,
          reason: 'refresh now',
        },
      },
    ];

    expect(compactLeaderBriefIntentAttention(members)).toEqual([
      { agentId: 'stale', kind: 'intent-stale', action: 'verify-ownership-before-reclaim' },
      { agentId: 'divergent', kind: 'intent-divergent', action: 'request-intent-refresh' },
    ]);
    expect(prioritizeActionableMembers(members).map((member) => member.agentId)).toEqual([
      'stale',
      'divergent',
      'ordinary',
    ]);
  });
});

describe('projectMember recovery annotation (P-009)', () => {
  // A stranded member is the case where every OTHER signal on the row reads as benign: its
  // processes are frozen, so it makes no tool calls and emits no heartbeat, which is
  // observationally identical to a member that finished cleanly and went quiet. These
  // assertions are what keep the containment reason attached to the row a leader triages.
  const recovery = {
    disposition: 'stranded' as const,
    reason: 'kill_failed: scope release unverified',
    taskId: 'task-abc',
    strandedAt: '2026-09-05T01:00:00.000Z',
  };

  it('carries the containment disposition and reason onto the member row', () => {
    const m = projectMember(baseAgent({}), NOW, null, null, null, null, null, null, recovery);
    expect(m.recovery).toEqual(recovery);
  });

  it('carries a reconciler reap reason too — disposition alone must not imply a respawn attempt', () => {
    // Measured on this box: the MAJORITY of stranded closes are the task reconciler's reap
    // (`process identity …`), not P-009 containment. Both are surfaced deliberately, so the
    // reason is the only thing that distinguishes them — a leader that read `disposition`
    // alone would conclude a recovery attempt ran when none did.
    const reaped = {
      disposition: 'stranded' as const,
      reason: 'process identity linux:b6a537ff-4a0e-440b-99c1-4764f002dda9 absent from scan',
      taskId: 'task-reaped',
      strandedAt: '2026-09-01T12:11:52.415Z',
    };
    const m = projectMember(baseAgent({}), NOW, null, null, null, null, null, null, reaped);
    expect(m.recovery?.reason).toContain('process identity');
    expect(m.recovery?.disposition).toBe('stranded');
  });

  it('omits the block entirely when the member was never stranded', () => {
    // Absent must mean "nothing surfaced", never a fabricated all-clear.
    const m = projectMember(baseAgent({}), NOW, null, null, null, null, null, null, null);
    expect(m.recovery).toBeUndefined();
    expect('recovery' in m).toBe(false);
  });

  it('does not synthesize a recovery block when the leg was simply not read', () => {
    const m = projectMember(baseAgent({}), NOW);
    expect(m.recovery).toBeUndefined();
  });
});

describe('projectMember repeated-recovery diagnostic (D-007)', () => {
  const repeatedRecovery = {
    consecutiveRecoveryOnlyCycles: 2,
    action: 'diagnose' as const,
    takeoverAuthorized: false as const,
    guidance: 'Inspect the real blocker; no takeover is authorized.',
  };

  it('carries the diagnostic-only authority and builds a complete compact identity index', () => {
    const member = projectMember(baseAgent({}), NOW, null, null, null, null, null, null, null, repeatedRecovery);
    expect(member.repeatedRecovery).toEqual(repeatedRecovery);
    expect(compactLeaderBriefRepeatedRecovery([member])).toEqual([
      {
        agentId: member.agentId,
        consecutiveRecoveryOnlyCycles: 2,
        action: 'diagnose',
        takeoverAuthorized: false,
      },
    ]);
  });

  it('omits the exception when no threshold state was measured', () => {
    const member = projectMember(baseAgent({}), NOW);
    expect(member.repeatedRecovery).toBeUndefined();
    expect(compactLeaderBriefRepeatedRecovery([member])).toEqual([]);
  });
});

describe('projectMember (pure)', () => {
  it('projects canonical intent signals with their resolving attention block', () => {
    const m = projectMember(
      baseAgent({
        sessionState: 'live',
        intentAgeSec: 1_901,
        intentStale: false,
        intentDivergent: true,
      }),
      NOW,
    );
    expect(m).toMatchObject({
      intentAgeSec: 1_901,
      intentStale: false,
      intentDivergent: true,
      intentAttention: {
        kind: 'intent-divergent',
        action: 'request-intent-refresh',
      },
    });
  });

  it('keeps unknown intent measurements in-band without fabricating attention', () => {
    const m = projectMember(baseAgent({}), NOW);
    expect(m).toMatchObject({ intentAgeSec: null, intentStale: null, intentDivergent: null });
    expect(m.intentAttention).toBeUndefined();
  });

  it('keeps authoritative verified-wait evidence and its owner/takeover remedy beside the member', () => {
    const alert = {
      subscriberId: 'su-worker',
      eventKey: 'release:green:papercusp',
      firedAt: '2026-08-13T12:00:00.000Z',
      classification: 'absent' as const,
      nextAction: 'wake-owner-or-takeover' as const,
      producer: { kind: 'green-checkpoint', id: 'run-42' },
      owner: { ownerId: 'su-producer', workItemId: 'WI-42' },
      checkedAtMs: 42,
      verificationDeadlineMs: 40,
      lastProgressAtMs: null,
      lastFireAtMs: null,
      remedy: 'Wake the owner of WI-42; if it does not resume promptly, claim/take over WI-42.',
    };
    const m = projectMember(baseAgent({ verifiedWaitTakeovers: [alert] }), NOW);
    expect(m.verifiedWaitTakeovers).toEqual([alert]);
  });

  it('computes lastToolCallAgeMs from the ISO timestamp', () => {
    const agent = baseAgent({ lastToolCallAt: new Date(NOW - 5_000).toISOString() });
    const m = projectMember(agent, NOW);
    expect(m.lastToolCallAgeMs).toBe(5_000);
  });

  it('null lastToolCallAgeMs when the member has never taken a turn', () => {
    const agent = baseAgent({ lastToolCallAt: null });
    const m = projectMember(agent, NOW);
    expect(m.lastToolCallAgeMs).toBeNull();
  });

  // EI-19931924184335892 (recurrence guard): a leader force-released a LIVE claim
  // on the basis of a leader-brief row reading sessionState:'recorded' + stalled:true
  // beside a lastToolCallAgeMs of ~53s — the holder closed the item, with a
  // committed evidenced fix, 8 minutes later. `stalled` is a claim-progress-checkpoint
  // signal (no last_progress_at/taken_at movement in >10min), NOT a liveness signal,
  // and must never read `true` beside a lastToolCallAgeMs that itself proves the
  // member is speaking right now.
  it('never reports stalled:true when lastToolCallAgeMs proves the member is speaking now (EI-19931924184335892)', () => {
    const agent = baseAgent({
      sessionState: 'recorded',
      stalled: true,
      lastToolCallAt: new Date(NOW - 53_000).toISOString(),
    });
    const m = projectMember(agent, NOW);
    expect(m.lastToolCallAgeMs).toBe(53_000);
    expect(m.stalled).toBe(false);
  });

  it('still reports stalled:true when the member is NOT demonstrably speaking (no fresh tool call)', () => {
    const agent = baseAgent({
      sessionState: 'recorded',
      stalled: true,
      lastToolCallAt: new Date(NOW - VERDICT_SPEAKING_FRESH_MS - 1_000).toISOString(),
    });
    const m = projectMember(agent, NOW);
    expect(m.stalled).toBe(true);
  });

  it('leaves stalled:false untouched when the member is speaking and not actually claim-stalled', () => {
    const agent = baseAgent({
      stalled: false,
      lastToolCallAt: new Date(NOW - 1_000).toISOString(),
    });
    const m = projectMember(agent, NOW);
    expect(m.stalled).toBe(false);
  });

  it('collapses claims to queuedCount/load and bounded work-item ids, never the full claim records', () => {
    const agent = baseAgent({
      claims: [
        { type: 'work-item', id: 'WI-1' },
        { type: 'plan-item', id: 'P-1' },
        { type: 'work-item', id: 'WI-2' },
      ] as never,
      queued: [{ id: 'WI-1' }, { id: 'WI-2' }] as never,
      load: 3,
    });
    const m = projectMember(agent, NOW);
    expect(m.queuedCount).toBe(2);
    expect(m.load).toBe(3);
    expect(m.workItemIds).toEqual(['WI-1', 'WI-2']);
    expect('claims' in m).toBe(false);
  });

  it('omits `unanswered` when absent — never a bare zero/empty stub', () => {
    const m = projectMember(baseAgent({}), NOW);
    expect('unanswered' in m).toBe(false);
  });

  it('carries `unanswered` verbatim when the decoration stamped one', () => {
    const unanswered = {
      count: 2,
      oldestAgeMs: 90_000,
      newest: [{ msgId: 'm1', from: 'su-2', ageMs: 1000 }],
      staleCount: 0,
      staleOldestAgeMs: 0,
      senders: [{ from: 'su-2', count: 2, oldestAgeMs: 90_000 }],
    };
    const m = projectMember(baseAgent({ unanswered }), NOW);
    expect(m.unanswered).toEqual(unanswered);
  });

  it('omits `parkedOn` when empty/absent, carries it when non-empty (bench state)', () => {
    expect('parkedOn' in projectMember(baseAgent({ parkedOn: [] }), NOW)).toBe(false);
    const m = projectMember(baseAgent({ parkedOn: ['p2p-git:phase3-open'] }), NOW);
    expect(m.parkedOn).toEqual(['p2p-git:phase3-open']);
  });

  it('carries verdict/sessionState/wakeMode/contextPressure through as null when unstamped', () => {
    const m = projectMember(baseAgent({}), NOW);
    expect(m.verdict).toBeNull();
    expect(m.sessionState).toBeNull();
    expect(m.wakeable).toBeNull();
    expect(m.wakeMode).toBeNull();
    expect(m.monitorState).toBeNull();
    expect(m.nextFireAt).toBeNull();
    expect(m.contextPressure).toBeNull();
    expect(m.contextPressureAgeSec).toBeNull();
    expect(m.loopMode).toBeNull();
  });

  it('carries the context-pressure estimate age beside its bucket', () => {
    const m = projectMember(baseAgent({ contextPressure: 'critical', contextPressureAgeSec: 840 }), NOW);
    expect(m.contextPressure).toBe('critical');
    expect(m.contextPressureAgeSec).toBe(840);
  });

  it('EI-21125380796386851: projects suspect+wakeable distinctly from terminal dead', () => {
    const recoverable = projectMember(baseAgent({ sessionState: 'suspect', wakeable: true, verdict: 'suspect' }), NOW);
    expect(recoverable).toMatchObject({ sessionState: 'suspect', wakeable: true, verdict: 'suspect' });

    const terminal = projectMember(baseAgent({ sessionState: 'suspect', wakeable: false, verdict: 'dead' }), NOW);
    expect(terminal).toMatchObject({ sessionState: 'suspect', wakeable: false, verdict: 'dead' });
  });

  it('carries healthy loop lifecycle and next fire through verbatim', () => {
    const m = projectMember(baseAgent({ monitorState: 'waiting', nextFireAt: '2026-07-10T12:01:00.000Z' }), NOW);
    expect(m.monitorState).toBe('waiting');
    expect(m.nextFireAt).toBe('2026-07-10T12:01:00.000Z');
  });

  it("WI-5345: surfaces the member's armed loop mode inline (work vs monitor), independent of monitorState", () => {
    const wedgedMonitor = projectMember(
      baseAgent({ monitorState: 'monitoring', doing: null, loopMode: 'monitor' }),
      NOW,
    );
    expect(wedgedMonitor.monitorState).toBe('monitoring');
    expect(wedgedMonitor.doing).toBeNull();
    expect(wedgedMonitor.loopMode).toBe('monitor');

    const healthyBetweenItems = projectMember(
      baseAgent({ monitorState: 'monitoring', doing: null, loopMode: 'work' }),
      NOW,
    );
    // Same monitorState:'monitoring' + doing:null shape as the wedged case above — the
    // exact ambiguity WI-5345 reports — but loopMode now distinguishes them without a
    // separate loop:status{ownerId} call.
    expect(healthyBetweenItems.monitorState).toBe('monitoring');
    expect(healthyBetweenItems.doing).toBeNull();
    expect(healthyBetweenItems.loopMode).toBe('work');
  });

  // EI-19381528967421062: a member whose loop backed off from a provider wall reads
  // active:true/sessionState:parked identically to a healthy between-wakes member on
  // every OTHER field here — `throttled` is the ONE signal that tells them apart.
  it('omits `throttled` when the loop is healthy (no lifecycleBackoff stamped)', () => {
    const m = projectMember(baseAgent({ monitorState: 'waiting', nextFireAt: '2026-07-10T12:01:00.000Z' }), NOW);
    expect('throttled' in m).toBe(false);
  });

  it('carries `throttled` verbatim when the loop backed off from a provider wall', () => {
    const lifecycleBackoff = { reason: 'rate_limited', until: '2026-08-02T23:58:00.000Z', resumesInMs: 5_940_000 };
    const m = projectMember(baseAgent({ nextFireAt: '2026-08-02T23:58:00.000Z', lifecycleBackoff }), NOW);
    expect(m.throttled).toEqual(lifecycleBackoff);
    // nextFireAt alone (per the earlier tests) is indistinguishable from a healthy wait —
    // throttled is what makes THIS row legible as "silenced until X", not "next tick soon".
    expect(m.nextFireAt).toBe('2026-08-02T23:58:00.000Z');
  });
});

describe('computeBenchSuggestion (pure, EI-9943)', () => {
  const doing = {
    id: 'WI-1',
    itemKind: 'bug',
    title: 'stuck thing',
    status: 'open',
    rank: 0,
    rankWriter: null,
    activity: 'stalled' as const,
  };

  it('flags a speaking member whose claim is stalled and not already benched', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: [], doing });
    expect(s).toBeDefined();
    expect(s?.item).toBe('WI-1');
    expect(s?.itemTitle).toBe('stuck thing');
  });

  it('also flags first-turn-done (not just speaking) — the between-wakes window', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'first-turn-done', parkedOn: [], doing });
    expect(s).toBeDefined();
  });

  it('surfaces per-work-item claimHealth so a leader sees the recovery verdict', () => {
    const health = {
      status: 'waiting' as const,
      reasons: ['holder is parked on exact dependency wait(s)'],
      expected_cadence_ms: 600_000,
      evidence: [{ writer: 'events_await', signal: 'exact_dependency_waits', value: ['gate:ready'] }],
    };
    const m = projectMember(
      baseAgent({
        claims: [{ type: 'work-item', id: 'WI-claim', claimHealth: health }] as never,
      }),
      NOW,
    );
    expect(m.workItemIds).toEqual(['WI-claim']);
    expect(m.claimHealth?.['WI-claim']).toEqual(health);
  });

  it('does not produce a reclaim/bench suggestion when claimHealth says the holder is waiting/recoverable/contested/healthy', () => {
    for (const status of ['healthy', 'waiting', 'recoverable', 'contested'] as const) {
      const s = computeBenchSuggestion({
        stalled: true,
        verdict: 'speaking',
        parkedOn: [],
        doing,
        claimHealth: [{ status, reasons: [status], expected_cadence_ms: 600_000, evidence: [] }],
      });
      expect(s).toBeUndefined();
    }
  });

  it('still produces the stalled recovery suggestion for suspect claimHealth', () => {
    const s = computeBenchSuggestion({
      stalled: true,
      verdict: 'speaking',
      parkedOn: [],
      doing,
      claimHealth: [{ status: 'suspect', reasons: ['no progress'], expected_cadence_ms: 600_000, evidence: [] }],
    });
    expect(s?.kind).toBe('stalled-no-mcp');
  });

  it('does NOT flag an already-benched member (parkedOn non-empty) — avoid re-nudging', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: ['some:event'], doing });
    expect(s).toBeUndefined();
  });

  it('does NOT flag a member that is not stalled', () => {
    const s = computeBenchSuggestion({ stalled: false, verdict: 'speaking', parkedOn: [], doing: null });
    expect(s).toBeUndefined();
  });

  it('does NOT flag a dead/booted/joined member — not burning turns, relaunch is the right lever', () => {
    for (const verdict of ['dead', 'booted', 'joined', 'stalled', null] as const) {
      expect(computeBenchSuggestion({ stalled: true, verdict, parkedOn: [], doing })).toBeUndefined();
    }
  });

  it('projectMember surfaces benchSuggestion only when computeBenchSuggestion fires', () => {
    const flagged = projectMember(baseAgent({ stalled: true, verdict: 'speaking', parkedOn: [], doing }), NOW);
    expect(flagged.benchSuggestion).toBeDefined();
    const benched = projectMember(baseAgent({ stalled: true, verdict: 'speaking', parkedOn: ['k'], doing }), NOW);
    expect('benchSuggestion' in benched).toBe(false);
  });

  // EI-18679536216711688 (recurrence guard): `stalled` is derived purely from MCP
  // tool-call recency, which is indistinguishable from a member mid a long
  // foreground exec (a test run) that emits no MCP calls until it returns — this
  // is exactly that fixture. The suggestion must NOT assert a specific wrong
  // cause (a fabricated diagnosis reading as fact invites a destructive
  // coord:send { endTurn: true } on a productively-working member); it must
  // hedge honestly and point at sessions:timeline as the disambiguation step
  // before any escalation.
  it('does NOT assert a confident wrong cause for a stalled+speaking member — hedges instead (foreground-exec false-positive)', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: [], doing });
    expect(s).toBeDefined();
    expect(s?.reason.toLowerCase()).not.toContain('live-loop-polling');
    expect(s?.reason.toLowerCase()).toContain('may be genuinely wedged');
    expect(s?.reason.toLowerCase()).toContain('foreground exec');
    expect(s?.reason.toLowerCase()).toContain('sessions:timeline');
  });
});

describe('computeBenchSuggestion — LANELESS-IDLE (EI-13846)', () => {
  it('flags a speaking member with zero claims/queued and not parked', () => {
    const s = computeBenchSuggestion({
      stalled: false,
      verdict: 'speaking',
      parkedOn: [],
      doing: null,
      load: 0,
      queued: [],
    });
    expect(s).toBeDefined();
    expect(s?.item).toBeNull();
    expect(s?.reason).toMatch(/idle-cycling/);
  });

  it("flags a LOOP-DRIVEN member ('monitoring'/'waiting' verdict) — the case `stalled`-gated speaking/first-turn-done could never catch", () => {
    for (const verdict of ['monitoring', 'waiting'] as const) {
      const s = computeBenchSuggestion({ stalled: false, verdict, parkedOn: [], doing: null, load: 0, queued: [] });
      expect(s).toBeDefined();
    }
  });

  it('does NOT flag a claimable waiter when the queue count is missing', () => {
    const s = computeBenchSuggestion({
      stalled: false,
      verdict: 'parked-awaiting-capability',
      parkedOn: ['work-item:claimable'],
      doing: null,
      load: 0,
      queued: [],
    });
    expect(s).toBeUndefined();
  });

  it('flags a member parked solely on the claimable event when supply predates the await', () => {
    const s = computeBenchSuggestion(
      {
        stalled: false,
        verdict: 'parked-awaiting-capability',
        parkedOn: ['work-item:claimable'],
        doing: null,
        load: 0,
        queued: [],
      },
      2,
    );
    expect(s?.kind).toBe('idle-with-claimable');
  });

  it('keeps other and compound event waits suppressed even when work is claimable', () => {
    for (const parkedOn of [['some:event'], ['work-item:claimable', 'some:event']]) {
      expect(
        computeBenchSuggestion(
          {
            stalled: false,
            verdict: 'parked-awaiting-capability',
            parkedOn,
            doing: null,
            load: 0,
            queued: [],
          },
          2,
        ),
      ).toBeUndefined();
    }
  });

  it('does NOT flag a member holding a real claim (load>0) or with queued work', () => {
    const holding = {
      id: 'WI-1',
      itemKind: 'bug',
      title: 'in progress',
      status: 'open',
      rank: 0,
      rankWriter: null,
      activity: 'alive' as const,
    };
    expect(
      computeBenchSuggestion({
        stalled: false,
        verdict: 'monitoring',
        parkedOn: [],
        doing: holding,
        load: 1,
        queued: [],
      }),
    ).toBeUndefined();
    expect(
      computeBenchSuggestion({
        stalled: false,
        verdict: 'monitoring',
        parkedOn: [],
        doing: null,
        load: 0,
        queued: [{ id: 'WI-9' }] as never,
      }),
    ).toBeUndefined();
  });

  it('does NOT flag dead/booted/joined — a fresh boot or a dead session is not "idle-cycling"', () => {
    for (const verdict of ['dead', 'booted', 'joined'] as const) {
      expect(
        computeBenchSuggestion({ stalled: false, verdict, parkedOn: [], doing: null, load: 0, queued: [] }),
      ).toBeUndefined();
    }
  });

  it('suppresses non-wakeable recorded rows without suppressing live or parked controls (EI-21578801728078768)', () => {
    const recorded = projectMember(
      baseAgent({
        sessionState: 'recorded',
        wakeable: false,
        verdict: 'waiting',
      }),
      NOW,
      5,
    );
    expect(recorded.benchSuggestion).toBeUndefined();

    for (const sessionState of ['live', 'parked'] as const) {
      const control = projectMember(
        baseAgent({
          sessionState,
          wakeable: true,
          verdict: 'waiting',
        }),
        NOW,
        5,
      );
      expect(control.benchSuggestion?.kind).toBe('idle-with-claimable');
    }
  });

  it('load/queued omitted (pre-EI-13846 call sites) never falsely triggers — undefined reads as "not laneless"', () => {
    expect(
      computeBenchSuggestion({ stalled: false, verdict: 'monitoring', parkedOn: [], doing: null }),
    ).toBeUndefined();
  });

  it('suppresses an explicitly loopless member — dormant owns the no-self-wake signal', () => {
    expect(
      computeBenchSuggestion({
        stalled: false,
        verdict: 'first-turn-done',
        loopMode: null,
        parkedOn: [],
        doing: null,
        load: 0,
        queued: [],
      }),
    ).toBeUndefined();
  });

  it('projectMember surfaces the laneless-idle suggestion end-to-end', () => {
    const m = projectMember(baseAgent({ verdict: 'waiting', monitorState: 'waiting' }), NOW);
    expect(m.benchSuggestion).toBeDefined();
    expect(m.benchSuggestion?.reason).toMatch(/idle-cycling/);
  });
});

// EI-18730414627683753: a member with NO self-wake mechanism at all (no loop, no park,
// no claim) is a DISTINCT, more severe state than "laneless-idle" (which assumes a healthy
// armed loop will re-cycle it) — the live incident this closes had `bench_suggested`/
// `laneless_idle` fire for both dormant members, indistinguishable from a merely-idle
// loop-armed one, so the leader had to hand-inspect loopMode/nextFireAt per row to notice.
describe('computeDormantAlert (EI-18730414627683753)', () => {
  it('flags a first-turn-done member with no loop, not parked, no claim', () => {
    expect(
      computeDormantAlert({
        verdict: 'first-turn-done',
        loopMode: null,
        parkedOn: [],
        doing: null,
        load: 0,
        queued: [],
      }),
    ).toBe(true);
  });

  it('flags a speaking member in the same shape', () => {
    expect(
      computeDormantAlert({ verdict: 'speaking', loopMode: null, parkedOn: [], doing: null, load: 0, queued: [] }),
    ).toBe(true);
  });

  it('does NOT flag a member with an active loop (work or monitor) — it will re-cycle on its own', () => {
    for (const loopMode of ['work', 'monitor'] as const) {
      expect(
        computeDormantAlert({ verdict: 'first-turn-done', loopMode, parkedOn: [], doing: null, load: 0, queued: [] }),
      ).toBe(false);
    }
  });

  it('does NOT flag a member parked on an event — it has a wake mechanism', () => {
    expect(
      computeDormantAlert({
        verdict: 'first-turn-done',
        loopMode: null,
        parkedOn: ['work-item:status:WI-1'],
        doing: null,
        load: 0,
        queued: [],
      }),
    ).toBe(false);
  });

  it('does NOT flag a member holding a claim or with queued work', () => {
    const holding = {
      id: 'WI-1',
      itemKind: 'bug',
      title: 'in progress',
      status: 'open',
      rank: 0,
      rankWriter: null,
      activity: 'alive' as const,
    };
    expect(
      computeDormantAlert({
        verdict: 'first-turn-done',
        loopMode: null,
        parkedOn: [],
        doing: holding,
        load: 1,
        queued: [],
      }),
    ).toBe(false);
    expect(
      computeDormantAlert({
        verdict: 'first-turn-done',
        loopMode: null,
        parkedOn: [],
        doing: null,
        load: 0,
        queued: [{ id: 'WI-9' }] as never,
      }),
    ).toBe(false);
  });

  it('does NOT flag dead/booted/joined/monitoring/waiting — only speaking/first-turn-done are dormant-eligible', () => {
    for (const verdict of ['dead', 'booted', 'joined', 'monitoring', 'waiting'] as const) {
      expect(computeDormantAlert({ verdict, loopMode: null, parkedOn: [], doing: null, load: 0, queued: [] })).toBe(
        false,
      );
    }
  });

  it('is suppressed for a paused (winding-down) fleet, matching every sibling alert', () => {
    expect(
      computeDormantAlert(
        { verdict: 'first-turn-done', loopMode: null, parkedOn: [], doing: null, load: 0, queued: [] },
        true,
      ),
    ).toBe(false);
  });

  it('projectMember surfaces `dormant:true` end-to-end, distinct from benchSuggestion', () => {
    const m = projectMember(baseAgent({ verdict: 'first-turn-done', loopMode: null }), NOW);
    expect(m.dormant).toBe(true);
    // An explicit loopless oracle makes this a dormant member, not a laneless-idle
    // loop-armed member; do not prescribe fleet:bench for a member with no wake source.
    expect(m.benchSuggestion).toBeUndefined();
  });

  it('projectMember does NOT set `dormant` for a healthy loop-armed idle member', () => {
    const m = projectMember(baseAgent({ verdict: 'waiting', monitorState: 'waiting', loopMode: 'monitor' }), NOW);
    expect(m.dormant).toBeUndefined();
  });
});

// EI-19307414464301772: a member reading HEALTHY on every existing surface (live,
// verdict:monitoring, lastToolCallAgeMs fresh, not stalled) while its last 14 tool
// calls were entirely per-turn housekeeping (coord:glance/activity:report/journal:
// record-turn/flags:get/sessions:ingest-gate-event), holding zero claims, for ~8h,
// with 3 directed messages left unanswered the whole time.
describe('computeSpinningAlert (EI-19307414464301772)', () => {
  const BUDGET = 30 * 60_000;

  it('flags a member ticking fresh but whose last PRODUCTIVE call is stale past budget', () => {
    expect(
      computeSpinningAlert({
        verdict: 'monitoring',
        parkedOn: [],
        lastToolCallAgeMs: 20_000,
        productiveToolCallAgeMs: BUDGET + 60_000,
      }),
    ).toBe(true);
  });

  it('does NOT flag when there is no productive call on record at all (null) — absence of data is not evidence of spinning', () => {
    expect(
      computeSpinningAlert({
        verdict: 'monitoring',
        parkedOn: [],
        lastToolCallAgeMs: 20_000,
        productiveToolCallAgeMs: null,
      }),
    ).toBe(false);
  });

  it('does NOT flag a healthy member whose last call was itself productive (fresh productiveToolCallAgeMs)', () => {
    expect(
      computeSpinningAlert({
        verdict: 'monitoring',
        parkedOn: [],
        lastToolCallAgeMs: 20_000,
        productiveToolCallAgeMs: 20_000,
      }),
    ).toBe(false);
  });

  it('does NOT flag a member that is not visibly ticking (lastToolCallAgeMs stale/absent) — that is stalled/dead territory', () => {
    expect(
      computeSpinningAlert({
        verdict: 'monitoring',
        parkedOn: [],
        lastToolCallAgeMs: BUDGET + 60_000,
        productiveToolCallAgeMs: BUDGET + 60_000,
      }),
    ).toBe(false);
    expect(
      computeSpinningAlert({
        verdict: 'monitoring',
        parkedOn: [],
        lastToolCallAgeMs: null,
        productiveToolCallAgeMs: BUDGET + 60_000,
      }),
    ).toBe(false);
  });

  it('does NOT flag dead/booted/joined — never took a turn yet, or confirmed gone', () => {
    for (const verdict of ['dead', 'booted', 'joined'] as const) {
      expect(
        computeSpinningAlert({
          verdict,
          parkedOn: [],
          lastToolCallAgeMs: 20_000,
          productiveToolCallAgeMs: BUDGET + 60_000,
        }),
      ).toBe(false);
    }
  });

  it('does NOT flag a member deliberately parked on an event — it is already benched', () => {
    expect(
      computeSpinningAlert({
        verdict: 'monitoring',
        parkedOn: ['some:event'],
        lastToolCallAgeMs: 20_000,
        productiveToolCallAgeMs: BUDGET + 60_000,
      }),
    ).toBe(false);
  });

  it('is suppressed for a paused (winding-down) fleet, matching every sibling alert', () => {
    expect(
      computeSpinningAlert(
        { verdict: 'monitoring', parkedOn: [], lastToolCallAgeMs: 20_000, productiveToolCallAgeMs: BUDGET + 60_000 },
        true,
      ),
    ).toBe(false);
  });

  it('respects a custom budget', () => {
    const tight = 5 * 60_000;
    expect(
      computeSpinningAlert(
        { verdict: 'monitoring', parkedOn: [], lastToolCallAgeMs: 60_000, productiveToolCallAgeMs: 6 * 60_000 },
        false,
        tight,
      ),
    ).toBe(true);
    expect(
      computeSpinningAlert(
        { verdict: 'monitoring', parkedOn: [], lastToolCallAgeMs: 60_000, productiveToolCallAgeMs: 4 * 60_000 },
        false,
        tight,
      ),
    ).toBe(false);
  });

  it('does NOT require load===0 — a member spinning WHILE holding a claim is the more dangerous case, not a suppressed one', () => {
    // Deliberately does not accept load/doing/queued at all — unlike computeDormantAlert
    // and computeBenchSuggestion's laneless-idle branch, this alert is independent of claim
    // state by construction (see the doc comment on computeSpinningAlert).
    expect(
      computeSpinningAlert({
        verdict: 'speaking',
        parkedOn: [],
        lastToolCallAgeMs: 20_000,
        productiveToolCallAgeMs: BUDGET + 60_000,
      }),
    ).toBe(true);
  });

  it('projectMember computes productiveToolCallAgeMs from the ISO timestamp, and surfaces `spinning:true` end-to-end', () => {
    const agent = baseAgent({
      verdict: 'monitoring',
      lastToolCallAt: new Date(NOW - 20_000).toISOString(),
      productiveToolCallAt: new Date(NOW - (BUDGET + 60_000)).toISOString(),
    });
    const m = projectMember(agent, NOW);
    expect(m.productiveToolCallAgeMs).toBe(BUDGET + 60_000);
    expect(m.spinning).toBe(true);
  });

  it('uses the productive-call age as the held-claim idle signal, even when the generic stall flag is clear', () => {
    const agent = baseAgent({
      verdict: 'monitoring',
      load: 1,
      stalled: false,
      lastToolCallAt: new Date(NOW - 31 * 60_000).toISOString(),
      productiveToolCallAt: new Date(NOW - 31 * 60_000).toISOString(),
    });
    const member = projectMember(agent, NOW);
    expect(member.productiveToolCallAgeMs).toBe(31 * 60_000);
    // The handler passes this already-projected field into computeMemberIdleVerdict below;
    // assert the oracle's exact result here to keep the incident's wiring contract explicit.
    expect(
      computeMemberIdleVerdict(
        {
          load: member.load,
          stalled: member.stalled,
          lastToolCallAgeMs: member.lastToolCallAgeMs,
          productiveToolCallAgeMs: member.productiveToolCallAgeMs,
          sessionState: member.sessionState,
          contextPressure: member.contextPressure,
          loopMode: member.loopMode,
          nextFireAt: member.nextFireAt,
          parkedOn: member.parkedOn,
        },
        { blockedAtLayer: null, midTurnFreshnessMs: VERDICT_SPEAKING_FRESH_MS },
      ).cause,
    ).toBe('stalled-holder');
  });

  it('projectMember: null productiveToolCallAgeMs when no productive call is on record', () => {
    const m = projectMember(baseAgent({ productiveToolCallAt: null }), NOW);
    expect(m.productiveToolCallAgeMs).toBeNull();
    expect(m.spinning).toBeUndefined();
  });

  it('projectMember does NOT set `spinning` for a healthy member whose last call was productive', () => {
    const agent = baseAgent({
      verdict: 'monitoring',
      lastToolCallAt: new Date(NOW - 20_000).toISOString(),
      productiveToolCallAt: new Date(NOW - 20_000).toISOString(),
    });
    const m = projectMember(agent, NOW);
    expect(m.spinning).toBeUndefined();
  });
});

// WI-5973: a fleet leader running its monitor loop is SUPPOSED to hold zero
// claims — that IS the documented leader contract (monitor each wake: burn-down
// delta, member liveness, completion-integrity audit, reclaim orphans). Before
// this fix, the leader's OWN row (fleetRole:'leader', loopMode:'monitor',
// verdict:'monitoring', isSelf:true) still tripped the EI-13846 laneless-idle
// heuristic written for MEMBERS pulling from a claim spec — and its paired
// remedy (fleet:bench the leader onto a scoped event) is the exact failure the
// leader contract exists to prevent: the one agent watching for member death
// goes to sleep. Observed live 2026-07-26 on nonp2p-bug-drain-0725 (twice).
describe("computeBenchSuggestion — the LEADER's own monitor row is never idle-cycling (WI-5973)", () => {
  it('does NOT flag a leader with fleetRole:"leader" + loopMode:"monitor", zero claims, not parked', () => {
    const s = computeBenchSuggestion({
      stalled: false,
      verdict: 'monitoring',
      parkedOn: [],
      doing: null,
      load: 0,
      queued: [],
      fleetRole: 'leader',
      loopMode: 'monitor',
    });
    expect(s).toBeUndefined();
  });

  it('does NOT flag the leader even when claimable work exists (the idle-with-claimable branch is ALSO leader-exempt)', () => {
    const s = computeBenchSuggestion(
      {
        stalled: false,
        verdict: 'monitoring',
        parkedOn: [],
        doing: null,
        load: 0,
        queued: [],
        fleetRole: 'leader',
        loopMode: 'monitor',
      },
      5, // claimableCount > 0 — would fire 'idle-with-claimable' for an ordinary member
    );
    expect(s).toBeUndefined();
  });

  it('STILL flags a member with fleetRole:"leader" but loopMode:"work" (a leader that also pulls work is not exempt)', () => {
    const s = computeBenchSuggestion({
      stalled: false,
      verdict: 'monitoring',
      parkedOn: [],
      doing: null,
      load: 0,
      queued: [],
      fleetRole: 'leader',
      loopMode: 'work',
    });
    expect(s).toBeDefined();
  });

  it('STILL flags an ordinary member ("member"/null fleetRole) with loopMode:"monitor" — the exemption is leader-specific', () => {
    for (const fleetRole of ['member', null, undefined] as const) {
      const s = computeBenchSuggestion({
        stalled: false,
        verdict: 'monitoring',
        parkedOn: [],
        doing: null,
        load: 0,
        queued: [],
        fleetRole,
        loopMode: 'monitor',
      });
      expect(s).toBeDefined();
    }
  });

  it('does NOT suppress the stalled-no-mcp branch for a leader that DID take on work and looks wedged — still a genuine fault', () => {
    const held = {
      id: 'WI-1',
      itemKind: 'bug',
      title: 'in progress',
      status: 'open',
      rank: 0,
      rankWriter: null,
      activity: 'alive' as const,
    };
    const s = computeBenchSuggestion({
      stalled: true,
      verdict: 'speaking',
      parkedOn: [],
      doing: held,
      load: 1,
      queued: [],
      fleetRole: 'leader',
      loopMode: 'monitor',
    });
    expect(s?.kind).toBe('stalled-no-mcp');
  });

  it("projectMember never surfaces benchSuggestion for the leader's own monitoring row end-to-end", () => {
    const m = projectMember(
      baseAgent({ fleetRole: 'leader', loopMode: 'monitor', verdict: 'monitoring', monitorState: 'monitoring' }),
      NOW,
    );
    expect(m.benchSuggestion).toBeUndefined();
  });
});

// EI-18681259560385029 — the live incident: five members carried the laneless-idle line
// ("likely idle-cycling a drained or scoped-out lane") while claimableCount was 2, and the
// leader read it, concluded the lane was drained, and stood the fleet down. The wording
// asserted a fact it never checked; the remedy it named (fleet:bench) was backwards.
describe('computeBenchSuggestion — idle beside a NONEMPTY queue (EI-18681259560385029)', () => {
  const idle = { stalled: false, verdict: 'waiting' as const, parkedOn: [], doing: null, load: 0, queued: [] };

  it('does NOT claim the lane is drained when work IS claimable — and says so explicitly', () => {
    const s = computeBenchSuggestion(idle, 2);
    expect(s?.kind).toBe('idle-with-claimable');
    expect(s?.reason).toMatch(/2 item\(s\) ARE claimable/);
    expect(s?.reason).toMatch(/lane is NOT drained/);
    // The regression in one line: it must never assert the queue is empty when it is not.
    expect(s?.reason).not.toMatch(/drained or scoped-out/);
  });

  it('does NOT recommend benching when the queue is nonempty — benching sleeps a member beside real work', () => {
    const s = computeBenchSuggestion(idle, 2);
    expect(s?.reason).toMatch(/DO NOT fleet:bench/);
    expect(s?.reason).toMatch(/wake/i);
  });

  // EI-19412077774087262 — the live inversion: su-70390c8c sat at contextPressure
  // 'critical' with NO claim while this suggestion told the leader it "should be taking
  // work". A member at critical context that claims runs out mid-item and dies HOLDING the
  // claim, so the standard remedy converts an idle member into an orphaned work-item.
  describe('CRITICAL context inverts the remedy', () => {
    const critical = { ...idle, contextPressure: 'critical' as const };

    it('still reports the lane is NOT drained (the claimable fact is unchanged)', () => {
      const s = computeBenchSuggestion(critical, 2);
      expect(s?.kind).toBe('idle-with-claimable');
      expect(s?.reason).toMatch(/2 item\(s\) ARE claimable/);
    });

    it('does NOT tell the leader to wake it to claim — that orphans the claim', () => {
      const s = computeBenchSuggestion(critical, 2);
      expect(s?.reason).toMatch(/DO NOT wake it to claim/);
      expect(s?.reason).toMatch(/orphans the claim/);
      // and must not fall back to the other wrong remedy either
      expect(s?.reason).toMatch(/DO NOT fleet:bench/);
    });

    it('prescribes the ORDERING that makes claiming safe (flush -> self-compact -> pull)', () => {
      const s = computeBenchSuggestion(critical, 2);
      expect(s?.reason).toMatch(/checkpoint/);
      expect(s?.reason).toMatch(/self-compact/);
      expect(s?.reason).toMatch(/idle CORRECTLY/);
    });

    it('leaves NON-critical pressure on the ordinary wake-it path', () => {
      // The guard must be scoped to 'critical' only — 'high' and 'ok' members are genuinely
      // startable, and suppressing their dispatch would starve the lane for the opposite reason.
      for (const p of ['ok', 'high', null, undefined] as const) {
        const s = computeBenchSuggestion({ ...idle, contextPressure: p }, 2);
        expect(s?.kind).toBe('idle-with-claimable');
        expect(s?.reason).toMatch(/Wake it to re-run scheduler:get_next/);
        expect(s?.reason).not.toMatch(/DO NOT wake it to claim/);
      }
    });
  });

  // WI-37161 — the live incident: `throttled: 0` fleet-wide while fleet:capacity reported
  // `degraded:true, factor:0` — the old reason text told the leader to wake idle members and,
  // if they still took nothing, blamed a claim floor. The real cause was gateway queue
  // congestion, and the prescribed remedy (wake more members) fed MORE requests into the same
  // congested queue.
  describe('a CONGESTED shared inference pool inverts the remedy (WI-37161)', () => {
    const degradedPool = {
      poolExhausted: false,
      degraded: true,
      factor: 0,
      queueDepth: 28,
      usableAccounts: 1,
      availableAccounts: 2,
    };
    const exhaustedPool = {
      poolExhausted: true,
      degraded: false,
      factor: 0,
      queueDepth: 5,
      usableAccounts: 0,
      availableAccounts: 0,
    };

    it('still reports the lane is NOT drained (the claimable fact is unchanged)', () => {
      const s = computeBenchSuggestion(idle, 2, null, false, null, degradedPool);
      expect(s?.kind).toBe('idle-with-claimable');
      expect(s?.reason).toMatch(/2 item\(s\) ARE claimable/);
    });

    it('does NOT tell the leader to wake it — that queues MORE requests behind the congestion', () => {
      const s = computeBenchSuggestion(idle, 2, null, false, null, degradedPool);
      expect(s?.reason).toMatch(/DO NOT wake it/);
      expect(s?.reason).not.toMatch(/Wake it to re-run scheduler:get_next/);
      expect(s?.reason).toMatch(/DO NOT fleet:bench/);
      expect(s?.reason).toMatch(/QUEUED FOR INFERENCE/);
    });

    it('names DEGRADED vs EXHAUSTED correctly and surfaces factor/queueDepth', () => {
      const degraded = computeBenchSuggestion(idle, 2, null, false, null, degradedPool);
      expect(degraded?.reason).toMatch(/DEGRADED/);
      expect(degraded?.reason).not.toMatch(/EXHAUSTED/);
      expect(degraded?.reason).toMatch(/factor 0\.00/);
      expect(degraded?.reason).toMatch(/28 request\(s\)/);

      const exhausted = computeBenchSuggestion(idle, 2, null, false, null, exhaustedPool);
      expect(exhausted?.reason).toMatch(/EXHAUSTED/);
    });

    it('does NOT fire when the pool is degraded but the gateway queue is EMPTY — nothing is actually backed up', () => {
      const s = computeBenchSuggestion(idle, 2, null, false, null, { ...degradedPool, queueDepth: 0 });
      expect(s?.reason).toMatch(/Wake it to re-run scheduler:get_next/);
    });

    it('does NOT fire when the pool read is healthy (degraded:false, poolExhausted:false)', () => {
      const s = computeBenchSuggestion(idle, 2, null, false, null, {
        poolExhausted: false,
        degraded: false,
        factor: 1,
        queueDepth: 0,
        usableAccounts: 4,
        availableAccounts: 4,
      });
      expect(s?.reason).toMatch(/Wake it to re-run scheduler:get_next/);
    });

    it('an UNREAD pool state (null/undefined) never suppresses or alters the existing remedy', () => {
      expect(computeBenchSuggestion(idle, 2, null, false, null, null)?.reason).toMatch(
        /Wake it to re-run scheduler:get_next/,
      );
      expect(computeBenchSuggestion(idle, 2)?.reason).toMatch(/Wake it to re-run scheduler:get_next/);
    });

    it('projectMember threads poolCapacity through end-to-end', () => {
      const m = projectMember(
        baseAgent({ verdict: 'waiting', monitorState: 'waiting' }),
        NOW,
        3,
        null,
        false,
        null,
        degradedPool,
      );
      expect(m.benchSuggestion?.kind).toBe('idle-with-claimable');
      expect(m.benchSuggestion?.reason).toMatch(/QUEUED FOR INFERENCE/);
    });
  });

  it('keeps the historical bench advice when the lane is VERIFIED drained (0 claimable AND 0 matching)', () => {
    // EI-18689489507862177 TIGHTENED THIS TEST'S PREMISE. It used to pass `claimableCount: 0`
    // with no gating read and assert "VERIFIED drained" — but an empty queue alone cannot
    // establish drainage: a lane whose every matching row sits behind a claim floor reads 0
    // here too (measured live: 108 matched / 0 claimable). Verification now requires the
    // pre-floor match count as well, so the second argument below is what makes the claim
    // true. The test's INTENT is unchanged: a genuinely drained lane keeps the bench advice.
    const s = computeBenchSuggestion(idle, 0, { matchedByFilter: 0, excluded: {} });
    expect(s?.kind).toBe('laneless-idle');
    expect(s?.reason).toMatch(/VERIFIED drained/);
    expect(s?.reason).toMatch(/fleet:bench/);
  });

  it('does not emit a bench suggestion when the queue read is UNKNOWN (EI-22063840424661947)', () => {
    // The brief's lane read can time out while fleet:bench's later member-scoped
    // recheck sees real work (the live incident saw 1,490 claimable rows). Unknown
    // is not evidence that this member can safely be benched.
    expect(computeBenchSuggestion(idle, null)).toBeUndefined();
  });

  it('keeps a member-scoped nonempty lane out of the laneless-idle branch', () => {
    const s = computeBenchSuggestion(idle, 1_490);
    expect(s?.kind).toBe('idle-with-claimable');
    expect(s?.kind).not.toBe('laneless-idle');
  });

  it('tags the stalled branch with its own kind so a leader can tell the two remedies apart', () => {
    const held = {
      id: 'WI-1',
      itemKind: 'bug',
      title: 'in progress',
      status: 'open',
      rank: 0,
      rankWriter: null,
      activity: 'alive' as const,
    };
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: [], doing: held }, 5);
    expect(s?.kind).toBe('stalled-no-mcp');
  });

  it('projectMember threads the claimable count through end-to-end', () => {
    const m = projectMember(baseAgent({ verdict: 'waiting', monitorState: 'waiting' }), NOW, 3);
    expect(m.benchSuggestion?.kind).toBe('idle-with-claimable');
    expect(m.benchSuggestion?.reason).toMatch(/3 item\(s\) ARE claimable/);
  });

  it('does NOT flag an idle-shaped member whose recent tool call proves it is between claims (EI-18833129079136289)', () => {
    const m = projectMember(
      baseAgent({
        verdict: 'waiting',
        monitorState: 'waiting',
        lastToolCallAt: new Date(NOW - VERDICT_SPEAKING_FRESH_MS + 1_000).toISOString(),
      }),
      NOW,
      3,
    );
    expect(m.lastToolCallAgeMs).toBe(VERDICT_SPEAKING_FRESH_MS - 1_000);
    expect(m.benchSuggestion).toBeUndefined();
  });

  it('still flags an idle-shaped member whose last tool call is stale (EI-18833129079136289)', () => {
    const m = projectMember(
      baseAgent({
        verdict: 'waiting',
        monitorState: 'waiting',
        lastToolCallAt: new Date(NOW - VERDICT_SPEAKING_FRESH_MS - 1_000).toISOString(),
      }),
      NOW,
      3,
    );
    expect(m.lastToolCallAgeMs).toBe(VERDICT_SPEAKING_FRESH_MS + 1_000);
    expect(m.benchSuggestion?.kind).toBe('idle-with-claimable');
  });
});

describe('computeIdleWithClaimableAlert (EI-18681259560385029 — the summary-level alert)', () => {
  it('fires on the exact incident shape: 5 idle members, 2 claimable', () => {
    const alert = computeIdleWithClaimableAlert({ claimableCount: 2, idleMemberCount: 5 });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/5 member\(s\)/);
    expect(alert?.reason).toMatch(/2 item\(s\) are claimable/);
    expect(alert?.reason).toMatch(/wake/i);
  });

  it('does not fire when the queue is genuinely empty — idle beside nothing is correct', () => {
    expect(computeIdleWithClaimableAlert({ claimableCount: 0, idleMemberCount: 5 })).toBeUndefined();
  });

  it('does not fire when every member is working, however full the queue', () => {
    expect(computeIdleWithClaimableAlert({ claimableCount: 40, idleMemberCount: 0 })).toBeUndefined();
  });

  it('does NOT fire on an unreadable count — unknown is not evidence of a full queue either', () => {
    expect(computeIdleWithClaimableAlert({ claimableCount: null, idleMemberCount: 5 })).toBeUndefined();
  });

  // WI-37161 — the summary-level twin of the per-member fix: a leader reading only the
  // summary alert must not be told to wake a fleet that is actually inference-queued.
  describe('a CONGESTED shared inference pool inverts the remedy (WI-37161)', () => {
    const degradedPool = {
      poolExhausted: false,
      degraded: true,
      factor: 0,
      queueDepth: 28,
      usableAccounts: 1,
      availableAccounts: 2,
    };

    it('still fires (the lane is not drained) but does NOT tell the leader to wake them', () => {
      const alert = computeIdleWithClaimableAlert({
        claimableCount: 2,
        idleMemberCount: 6,
        poolCapacity: degradedPool,
      });
      expect(alert).toBeDefined();
      expect(alert?.reason).toMatch(/QUEUED FOR INFERENCE/);
      expect(alert?.reason).not.toMatch(/coord:send \{ wake: "required" \} those members so they re-run/);
      expect(alert?.reason).toMatch(/DO NOT wake/);
    });

    it('falsifier calls fleet:capacity, not the member-holdings check', () => {
      const alert = computeIdleWithClaimableAlert({
        claimableCount: 2,
        idleMemberCount: 6,
        poolCapacity: degradedPool,
      });
      expect(alert?.falsifier.tool).toBe('fleet:capacity');
    });

    it('falls back to the ordinary wake-them remedy once the pool read is healthy', () => {
      const alert = computeIdleWithClaimableAlert({
        claimableCount: 2,
        idleMemberCount: 6,
        poolCapacity: {
          poolExhausted: false,
          degraded: false,
          factor: 1,
          queueDepth: 0,
          usableAccounts: 4,
          availableAccounts: 4,
        },
      });
      expect(alert?.reason).toMatch(/wake/i);
      expect(alert?.falsifier.tool).toBe('work_items:list');
    });

    it('an unread pool state (undefined) never changes the existing remedy', () => {
      const alert = computeIdleWithClaimableAlert({ claimableCount: 2, idleMemberCount: 6 });
      expect(alert?.falsifier.tool).toBe('work_items:list');
    });
  });

  it('fires even while OTHER members are busy — partial starvation is still starvation', () => {
    // Deliberately unlike computeStrandedFleetAlert/computeSpecStarvedFleetAlert, which both
    // require fleet-wide zero wip and so miss a fleet that is half-working, half-starving.
    expect(computeIdleWithClaimableAlert({ claimableCount: 1, idleMemberCount: 1 })).toBeDefined();
  });
});

// EI-18703234178947959 — the live incident (2026-07-26, fleet bug-drain-200k, 19 members):
// leader-brief reported `claimable_now: 2` + `idleWithClaimableAlert` and told the leader to
// wake all 19 members to "re-run scheduler:get_next", while THAT VERY ORACLE returned
// `windDown:true` for the same fleet (owner pause standing since 2026-07-21). The 2 rows were
// real backlog — real backlog OUTSIDE the paused fleet's scope. Idle members were COMPLYING
// with the stand-down; the brief diagnosed compliance as starvation, once per polling tick.
describe('a PAUSED (winding-down) fleet never gets a wake/bench suggestion (EI-18703234178947959)', () => {
  const idle = {
    stalled: false,
    verdict: 'waiting' as const,
    parkedOn: [],
    doing: null,
    load: 0,
    queued: [],
  };

  it('THE REGRESSION: idle + 2 claimable + fleet paused ⇒ no "wake it" suggestion at all', () => {
    // Unpaused, this is the EI-18681259560385029 shape and MUST still fire (guard against
    // over-suppression: the pause is the only thing that may silence it).
    expect(computeBenchSuggestion(idle, 2)?.kind).toBe('idle-with-claimable');
    expect(computeBenchSuggestion(idle, 2, null, true)).toBeUndefined();
  });

  it('suppresses the laneless-idle branches too — bench/widen-the-spec are equally moot while paused', () => {
    // Verified-drained, gated, and unknown-queue all reach the same idle branch.
    expect(computeBenchSuggestion(idle, 0, { matchedByFilter: 0, excluded: {} }, true)).toBeUndefined();
    expect(
      computeBenchSuggestion(idle, 0, { matchedByFilter: 108, excluded: { claimHold: 38 } }, true),
    ).toBeUndefined();
    expect(computeBenchSuggestion(idle, null, null, true)).toBeUndefined();
  });

  it('still reports a member that HOLDS a claim and looks wedged — that blocks the stand-down', () => {
    const held = {
      id: 'WI-1',
      itemKind: 'bug',
      title: 'in progress',
      status: 'open',
      rank: 0,
      rankWriter: null,
      activity: 'alive' as const,
    };
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: [], doing: held }, 2, null, true);
    expect(s?.kind).toBe('stalled-no-mcp');
  });

  it('preserves legacy omitted and measured active control states', () => {
    for (const notPaused of [undefined, false]) {
      expect(computeBenchSuggestion(idle, 2, null, notPaused)?.kind).toBe('idle-with-claimable');
    }
  });

  it('EI-25630740795866119: unknown pause never advises waking or benching idle members', () => {
    expect(computeBenchSuggestion(idle, 2, null, null)).toBeUndefined();
    expect(computeBenchSuggestion(idle, 0, { matchedByFilter: 0 }, null)).toBeUndefined();
    expect(computeDormantAlert({ ...idle, verdict: 'speaking', loopMode: null }, null)).toBe(false);
    expect(computeIdleWithClaimableAlert({ claimableCount: 2, idleMemberCount: 19, fleetPaused: null })).toBeUndefined();
    expect(computeFloorStarvedFleetAlert({ claimable: 0, matchedByFilter: 108, idleMemberCount: 5, fleetPaused: null })).toBeUndefined();
    expect(computeFleetBlockVerdict({
      fleetPaused: null, claimable: 2, matchedByFilter: 2, idleMemberCount: 19, lanelessIdleCount: 0,
    })).toBeUndefined();
  });

  it('EI-25630740795866119: unknown pause retains diagnostics for held stalled work', () => {
    expect(computeBenchSuggestion({
      stalled: true, verdict: 'speaking', parkedOn: [],
      doing: { id: 'WI-1', itemKind: 'bug', title: 'held', status: 'open', rank: 0, rankWriter: null, activity: 'alive' },
    }, 2, null, null)?.kind).toBe('stalled-no-mcp');
  });

  it('projectMember threads the pause through end-to-end', () => {
    const agent = baseAgent({ verdict: 'waiting', monitorState: 'waiting' });
    expect(projectMember(agent, NOW, 2).benchSuggestion?.kind).toBe('idle-with-claimable');
    expect(projectMember(agent, NOW, 2, null, true).benchSuggestion).toBeUndefined();
  });

  it('suppresses BOTH summary alerts while paused — defence-in-depth behind the member gate', () => {
    // The exact numbers from the incident (2 claimable, idle members) — must stay silent.
    expect(
      computeIdleWithClaimableAlert({ claimableCount: 2, idleMemberCount: 19, fleetPaused: true }),
    ).toBeUndefined();
    expect(
      computeFloorStarvedFleetAlert({
        claimable: 0,
        matchedByFilter: 108,
        idleMemberCount: 5,
        fleetPaused: true,
      }),
    ).toBeUndefined();
    // …and both still fire on the same inputs when the fleet is ACTIVE.
    expect(computeIdleWithClaimableAlert({ claimableCount: 2, idleMemberCount: 19, fleetPaused: false })).toBeDefined();
    expect(computeFloorStarvedFleetAlert({ claimable: 0, matchedByFilter: 108, idleMemberCount: 5 })).toBeDefined();
  });
});

describe('computeStrandedFleetAlert (EI-15055 — the whole-fleet-asleep-on-available-supply shape)', () => {
  it('fires on the exact incident shape: zero fleet-wide load, ≥1 parked member, ≥1 unowned critical', () => {
    const alert = computeStrandedFleetAlert({ totalLoad: 0, parkedCount: 7, unownedCriticalCount: 8 });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/fleet-wide wip is 0/);
    expect(alert?.reason).toMatch(/7 member/);
    expect(alert?.reason).toMatch(/8 unowned critical/);
  });

  it('does NOT fire when the fleet still holds live work (totalLoad > 0)', () => {
    expect(computeStrandedFleetAlert({ totalLoad: 1, parkedCount: 7, unownedCriticalCount: 8 })).toBeUndefined();
  });

  it('does NOT fire when nobody is parked (parkedCount 0) even if criticals sit unowned', () => {
    expect(computeStrandedFleetAlert({ totalLoad: 0, parkedCount: 0, unownedCriticalCount: 8 })).toBeUndefined();
  });

  it('does NOT fire when there is no known unowned-critical supply (a genuinely drained fleet resting is fine)', () => {
    expect(computeStrandedFleetAlert({ totalLoad: 0, parkedCount: 7, unownedCriticalCount: 0 })).toBeUndefined();
  });
});

describe('computeSpecStarvedFleetAlert (EI-18655873409999215 — the spec-matches-zero blind spot computeStrandedFleetAlert cannot see)', () => {
  it('fires on the exact incident shape: zero fleet-wide load, spec matches 0 of a nonempty pool', () => {
    const alert = computeSpecStarvedFleetAlert({ totalLoad: 0, specMatched: 0, poolSize: 1224 });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/fleet-wide wip is 0/);
    expect(alert?.reason).toMatch(/0 of 1224 claimable/);
  });

  it('does NOT fire when the fleet still holds live work (totalLoad > 0) — a per-bee override spec may still be pulling', () => {
    expect(computeSpecStarvedFleetAlert({ totalLoad: 1, specMatched: 0, poolSize: 1224 })).toBeUndefined();
  });

  it('does NOT fire when the pool itself is empty — a genuinely drained harness is fine, not a spec bug', () => {
    expect(computeSpecStarvedFleetAlert({ totalLoad: 0, specMatched: 0, poolSize: 0 })).toBeUndefined();
  });

  it('does NOT fire when the spec matches at least one row — this is not the starved-spec shape', () => {
    expect(computeSpecStarvedFleetAlert({ totalLoad: 0, specMatched: 3, poolSize: 1224 })).toBeUndefined();
  });
});

describe('computeSpecAuthorshipAlert (P-005 — a fleet spec rewritten under the leader, silently)', () => {
  /** The wake-8 incident on nonp2p-bug-drain, verbatim: a cup took the spec to rev4. */
  const INCIDENT = {
    readerId: 'su-b8422496',
    updatedBy: 's-1786236383559',
    revision: 4,
    updatedAt: '2026-08-09T01:12:00.000Z',
    harness: 'papercusp',
    fleet: 'nonp2p-bug-drain',
  };

  it('fires on the exact incident shape: the last write belongs to another actor', () => {
    const alert = computeSpecAuthorshipAlert(INCIDENT);
    expect(alert).toBeDefined();
    // The three facts a leader needs to act: who, which revision, and that it was not them.
    expect(alert?.reason).toMatch(/s-1786236383559/);
    expect(alert?.reason).toMatch(/revision 4/);
    expect(alert?.reason).toMatch(/not by you/);
  });

  it('does NOT fire when the reader authored the spec themselves — the silent case is the common one', () => {
    expect(computeSpecAuthorshipAlert({ ...INCIDENT, updatedBy: INCIDENT.readerId })).toBeUndefined();
  });

  it('fires on an UNATTRIBUTED write — a row with no author is no more verified than a foreign one', () => {
    const alert = computeSpecAuthorshipAlert({ ...INCIDENT, updatedBy: null });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/UNATTRIBUTED/);
  });

  it('stays SILENT when the reader is unresolvable — an unattributable reader cannot be a wronged author', () => {
    // The cry-wolf guard. An su session whose identity does not resolve reads this brief
    // routinely; firing there would train the alert away before it ever caught a real one.
    expect(computeSpecAuthorshipAlert({ ...INCIDENT, readerId: null })).toBeUndefined();
  });

  it('degrades to a still-runnable falsifier when fleet/harness are unresolved', () => {
    // Same fail-soft contract the rest of the family holds: never paste `harness: null`
    // into a leader's terminal.
    const alert = computeSpecAuthorshipAlert({ ...INCIDENT, harness: null, fleet: null });
    expect(alert?.falsifier.check).not.toContain('null');
    expect(alert?.falsifier.check).toContain('work_items:claimable');
  });

  it('renders a missing revision without leaking a literal null into the reason', () => {
    const alert = computeSpecAuthorshipAlert({ ...INCIDENT, revision: null, updatedAt: null });
    expect(alert?.reason).toMatch(/revision unknown/);
    expect(alert?.reason).not.toContain('null');
  });
});

describe('computeDeclaredPlanSpecDivergenceAlert (EI-21165759529778617)', () => {
  const members = [
    { agentId: 'su-a', alive: true, declaredPlanSlug: 'plan-a' },
    { agentId: 'su-b', alive: true, declaredPlanSlug: 'plan-b' },
    { agentId: 'su-dead', alive: false, declaredPlanSlug: 'plan-b' },
    { agentId: 'su-unknown', alive: true, declaredPlanSlug: null },
  ];

  it('fires only for live members whose declared plan is outside an exact positive scope', () => {
    const alert = computeDeclaredPlanSpecDivergenceAlert({
      members,
      specFilter: { field: 'plan', op: '=', value: 'plan-a' },
      fleet: 'fleet-a',
      harness: 'papercusp',
    });
    expect(alert?.positivePlanSlugs).toEqual(['plan-a']);
    expect(alert?.divergentMembers).toEqual([{ agentId: 'su-b', declaredPlanSlug: 'plan-b' }]);
    expect(alert?.reason).toMatch(/su-b=plan-b/);
    expect(alert?.reason).not.toContain('claimedItems');
    expect(alert?.falsifier.tool).toBe('fleet:assignments');
  });

  it('supports an exact positive in-list and does not flag an admitted member', () => {
    const alert = computeDeclaredPlanSpecDivergenceAlert({
      members: [members[0], members[1]],
      specFilter: { field: 'plan', op: 'in', value: ['plan-a', 'plan-b'] },
    });
    expect(alert).toBeUndefined();
  });

  it('handles boolean positive scopes conservatively and fails open on ambiguous branches', () => {
    expect(
      computeDeclaredPlanSpecDivergenceAlert({
        members: [members[1]],
        specFilter: {
          all: [
            { field: 'plan', op: '=', value: 'plan-a' },
            { field: 'kind', op: '=', value: 'bug' },
          ],
        },
      })?.divergentMembers,
    ).toEqual([{ agentId: 'su-b', declaredPlanSlug: 'plan-b' }]);

    expect(
      computeDeclaredPlanSpecDivergenceAlert({
        members: [members[1]],
        specFilter: {
          any: [
            { field: 'plan', op: '=', value: 'plan-a' },
            { field: 'kind', op: '=', value: 'bug' },
          ],
        },
      }),
    ).toBeUndefined();
  });

  it('ignores negative, missing, malformed, and not-nested plan evidence', () => {
    for (const specFilter of [
      { field: 'plan', op: '!=', value: 'plan-a' },
      { not: { field: 'plan', op: '=', value: 'plan-a' } },
      undefined,
      { field: 'plan', op: '=', value: 42 },
    ] as const) {
      expect(
        computeDeclaredPlanSpecDivergenceAlert({ members: [members[1]], specFilter: specFilter as never }),
      ).toBeUndefined();
    }
  });
});

/** The live nonp2p-bug-drain-0725 reading at 2026-07-26T07:00Z, used verbatim below so the
 *  tests assert the ACTUAL measured incident rather than an invented shape. */
const LIVE_GATED_LANE = {
  claimable: 0,
  matchedByFilter: 108,
  excluded: {
    federationDetector: 50,
    claimHold: 38,
    needsHuman: 11,
    taken: 8,
    observationLane: 1,
    externalBlocker: 1,
    planLaneReserved: 0,
    loopNoise: 0,
  },
};

describe('topExcludedFloors (EI-18689489507862177)', () => {
  it('ranks floors largest-first and drops the zero buckets', () => {
    expect(topExcludedFloors(LIVE_GATED_LANE.excluded)).toEqual([
      ['federationDetector', 50],
      ['claimHold', 38],
      ['needsHuman', 11],
    ]);
  });

  it('is empty (never throws) for an absent breakdown', () => {
    expect(topExcludedFloors(null)).toEqual([]);
    expect(topExcludedFloors(undefined)).toEqual([]);
  });
});

describe('computeFloorStarvedFleetAlert (EI-18689489507862177 — the GATED lane every sibling alert is blind to)', () => {
  it('fires on the exact live shape: 108 matched, 0 claimable, members idle', () => {
    const alert = computeFloorStarvedFleetAlert({ ...LIVE_GATED_LANE, idleMemberCount: 5 });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/5 member/);
    expect(alert?.reason).toMatch(/108 row/);
    expect(alert?.reason).toMatch(/ZERO survive the claim floors/);
  });

  it('names the dominant floors so the leader knows WHAT to clear, not just that something is wrong', () => {
    const alert = computeFloorStarvedFleetAlert({ ...LIVE_GATED_LANE, idleMemberCount: 5 });
    expect(alert?.reason).toMatch(/federationDetector=50/);
    expect(alert?.reason).toMatch(/claimHold=38/);
  });

  it('tells the leader NOT to bench — benching is the harmful remedy this alert exists to prevent', () => {
    const alert = computeFloorStarvedFleetAlert({ ...LIVE_GATED_LANE, idleMemberCount: 5 });
    expect(alert?.reason).toMatch(/Do NOT fleet:bench/);
    expect(alert?.reason).toMatch(/wind-down/);
  });

  it('does NOT fire when the spec matches nothing — that is computeSpecStarvedFleetAlert, not a floor problem', () => {
    expect(computeFloorStarvedFleetAlert({ claimable: 0, matchedByFilter: 0, idleMemberCount: 5 })).toBeUndefined();
  });

  it('does NOT fire when work IS claimable — that is computeIdleWithClaimableAlert', () => {
    expect(computeFloorStarvedFleetAlert({ claimable: 4, matchedByFilter: 108, idleMemberCount: 5 })).toBeUndefined();
  });

  it('does NOT fire when nobody is idle — a fully-busy fleet is not starving', () => {
    expect(computeFloorStarvedFleetAlert({ ...LIVE_GATED_LANE, idleMemberCount: 0 })).toBeUndefined();
  });

  it('does NOT fire on an unreadable claimable count — unknown is not evidence of a gated lane', () => {
    expect(
      computeFloorStarvedFleetAlert({ claimable: null, matchedByFilter: 108, idleMemberCount: 5 }),
    ).toBeUndefined();
  });

  it('does NOT fire on an unreadable match count — the gated verdict requires BOTH halves', () => {
    expect(computeFloorStarvedFleetAlert({ claimable: 0, matchedByFilter: null, idleMemberCount: 5 })).toBeUndefined();
  });

  it('still fires without a breakdown, just without naming floors (the count alone is the alert)', () => {
    const alert = computeFloorStarvedFleetAlert({
      claimable: 0,
      matchedByFilter: 108,
      idleMemberCount: 5,
    });
    expect(alert).toBeDefined();
    expect(alert?.reason).not.toMatch(/buckets overlap/);
  });
});

describe('computeBenchSuggestion — GATED vs DRAINED (EI-18689489507862177)', () => {
  const idleMember = { verdict: 'monitoring' as const, load: 0, queued: [], doing: null, stalled: false };

  it('calls a gated lane GATED and withholds the bench advice', () => {
    const s = computeBenchSuggestion(idleMember, 0, LIVE_GATED_LANE);
    expect(s?.kind).toBe('laneless-idle');
    expect(s?.reason).toMatch(/GATED, not drained/);
    expect(s?.reason).toMatch(/108 row/);
    expect(s?.reason).toMatch(/DO NOT fleet:bench/);
  });

  it('surfaces the dominant floor on the member row, so the leader sees the cause in place', () => {
    const s = computeBenchSuggestion(idleMember, 0, LIVE_GATED_LANE);
    expect(s?.reason).toMatch(/federationDetector=50/);
  });

  it('still reports a VERIFIED drained lane (0 claimable AND 0 matching) and keeps the bench advice', () => {
    const s = computeBenchSuggestion(idleMember, 0, { matchedByFilter: 0, excluded: {} });
    expect(s?.reason).toMatch(/VERIFIED drained/);
    expect(s?.reason).toMatch(/fleet:bench it onto a scoped event/);
    expect(s?.reason).not.toMatch(/GATED/);
  });

  it('REFUSES to call the lane drained when the gating was not read — the unchecked assertion this item fixes', () => {
    // The regression guard: claimableCount===0 alone must never reproduce "VERIFIED drained".
    const s = computeBenchSuggestion(idleMember, 0, null);
    expect(s?.reason).not.toMatch(/VERIFIED drained/);
    expect(s?.reason).toMatch(/NOT read on this brief/);
    expect(s?.reason).toMatch(/excludedBreakdown/);
  });

  it('leaves the claimable>0 branch (EI-18681259560385029) untouched', () => {
    const s = computeBenchSuggestion(idleMember, 3, LIVE_GATED_LANE);
    expect(s?.kind).toBe('idle-with-claimable');
  });
});

describe('resolveComposedParkedOn (pure, EI-18732218464905145 — the false-deadlock rendering fix)', () => {
  it('collapses a composed root + its own leaf siblings into ONE entry, never as flat peers', () => {
    const trees = new Map([
      [
        96,
        {
          required: 1,
          leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'],
          expiresTs: '2026-07-26T18:36:37Z',
          onTimeout: 'wake' as const,
        },
      ],
    ]);
    const out = resolveComposedParkedOn(
      ['work-item:status:WI-6088', 'work-item:status:WI-6095', 'composed-root:96'],
      trees,
    );
    expect(out).toEqual([
      {
        kind: 'composed',
        rootId: 96,
        mode: 'any',
        required: 1,
        of: 2,
        leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'],
        expiresTs: '2026-07-26T18:36:37Z',
        onTimeout: 'wake',
      },
    ]);
  });

  it('derives mode: all (required === leaf count), any (required 1), k-of-n (in between)', () => {
    const of3 = (required: number) =>
      resolveComposedParkedOn(
        ['composed-root:1'],
        new Map([[1, { required, leaves: ['a', 'b', 'c'], expiresTs: null, onTimeout: 'wake' as const }]]),
      )[0] as { mode: string };
    expect(of3(3).mode).toBe('all');
    expect(of3(1).mode).toBe('any');
    expect(of3(2).mode).toBe('k-of-n');
  });

  it('a plain (non-composed) parked key passes through unchanged, alongside a composed entry', () => {
    const trees = new Map([[1, { required: 1, leaves: ['x'], expiresTs: null, onTimeout: 'wake' as const }]]);
    const out = resolveComposedParkedOn(['lock:grant:t1', 'x', 'composed-root:1'], trees);
    expect(out).toContain('lock:grant:t1');
    expect(out).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'composed', rootId: 1 })]));
    // 'x' is a leaf of root 1 — consumed into the composed entry, not duplicated as a flat string.
    expect(out.filter((e) => e === 'x')).toHaveLength(0);
  });

  it('fails OPEN on an unresolved composed-root sentinel (no matching tree) — keeps the raw key visible', () => {
    const out = resolveComposedParkedOn(['composed-root:404'], new Map());
    expect(out).toEqual(['composed-root:404']);
  });

  it('empty input returns empty output', () => {
    expect(resolveComposedParkedOn([], new Map())).toEqual([]);
  });
});

describe('decorateComposedParkedOn (EI-18732218464905145)', () => {
  const node = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 96,
    rootId: 96,
    parentId: null,
    subscriberId: 'su-1',
    requiredCount: 1,
    firedCount: 0,
    firedAt: null,
    spec: null,
    wakeHandle: null,
    note: null,
    expiresTs: '2026-07-26T18:36:37Z',
    timeoutBehavior: 'wake' as const,
    cancelledAt: null,
    ...over,
  });
  const leaf = (eventKey: string, id: number) => ({
    id,
    eventKey,
    nodeId: 97,
    rootId: 96,
    memberFiredAt: null,
    memberPayload: null,
    firedAt: null,
    cancelledAt: null,
  });

  it('resolves parkedOnResolved for an agent whose parkedOn holds a composed-root sentinel', async () => {
    const listActiveComposedRoots = vi.fn(async () => [node()]);
    const loadTreeLeaves = vi.fn(async () => [
      leaf('work-item:status:WI-6088', 1),
      leaf('work-item:status:WI-6095', 2),
    ]);
    const agents: ComposedTestAgent[] = [
      { agentId: 'su-1', parkedOn: ['work-item:status:WI-6088', 'work-item:status:WI-6095', 'composed-root:96'] },
    ];
    await decorateComposedParkedOn(agents, {
      listActiveComposedRoots: listActiveComposedRoots as never,
      loadTreeLeaves: loadTreeLeaves as never,
    });
    expect(listActiveComposedRoots).toHaveBeenCalledWith('su-1');
    expect(loadTreeLeaves).toHaveBeenCalledWith(96);
    expect(agents[0].parkedOnResolved).toEqual([
      {
        kind: 'composed',
        rootId: 96,
        mode: 'any',
        required: 1,
        of: 2,
        leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'],
        expiresTs: '2026-07-26T18:36:37Z',
        onTimeout: 'wake',
      },
    ]);
  });

  it('skips the read entirely for an agent with no composed sentinel (no extra cost on the common case)', async () => {
    const listActiveComposedRoots = vi.fn(async () => [node()]);
    const agents: ComposedTestAgent[] = [
      { agentId: 'su-1', parkedOn: ['lock:grant:t1'] },
      { agentId: 'su-2', parkedOn: [] },
    ];
    await decorateComposedParkedOn(agents, {
      listActiveComposedRoots: listActiveComposedRoots as never,
      loadTreeLeaves: vi.fn() as never,
    });
    expect(listActiveComposedRoots).not.toHaveBeenCalled();
    expect(agents[0].parkedOnResolved).toBeUndefined();
  });

  it('a roots-read failure fails soft (via the shared withBoundedTimeout degrade) — never throws, keeps the raw sentinel visible', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listActiveComposedRoots = vi.fn(async () => {
      throw new Error('pg down');
    });
    const agents: ComposedTestAgent[] = [{ agentId: 'su-1', parkedOn: ['composed-root:96'] }];
    await expect(
      decorateComposedParkedOn(agents, {
        listActiveComposedRoots: listActiveComposedRoots as never,
        loadTreeLeaves: vi.fn() as never,
      }),
    ).resolves.toBeDefined();
    // withBoundedTimeout degrades the failed read to its [] fallback rather than throwing, so
    // resolution proceeds with an empty tree map — resolveComposedParkedOn's own fail-open path
    // (asserted in isolation above) then keeps the unresolved sentinel visible, same as a genuine
    // 1.5s timeout would. Never silently drops the raw signal a leader could otherwise have seen.
    expect(agents[0].parkedOnResolved).toEqual(['composed-root:96']);
  });

  it('projectMember prefers parkedOnResolved over the raw flat parkedOn end-to-end', () => {
    const agent = baseAgent({
      parkedOn: ['work-item:status:WI-6088', 'composed-root:96'],
      parkedOnResolved: [
        {
          kind: 'composed',
          rootId: 96,
          mode: 'any',
          required: 1,
          of: 2,
          leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'],
          expiresTs: '2026-07-26T18:36:37Z',
          onTimeout: 'wake',
        },
      ],
    });
    const m = projectMember(agent, NOW);
    expect(m.parkedOn).toEqual([
      {
        kind: 'composed',
        rootId: 96,
        mode: 'any',
        required: 1,
        of: 2,
        leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'],
        expiresTs: '2026-07-26T18:36:37Z',
        onTimeout: 'wake',
      },
    ]);
  });

  it('projectMember falls back to the raw flat parkedOn when nothing was resolved (unchanged pre-fix behavior)', () => {
    const m = projectMember(baseAgent({ parkedOn: ['p2p-git:phase3-open'] }), NOW);
    expect(m.parkedOn).toEqual(['p2p-git:phase3-open']);
  });
});

describe('EI-19313376980892266 — the brief must not call an AT-CAPACITY member idle-with-claimable', () => {
  // The live failure: a PARKED item retains `taken_by`, so it counts against the
  // scheduler's maxConcurrentClaims while contributing nothing to the presence layer's
  // `load`. `load === 0 && activeClaims >= 1` is therefore reachable, and in it the brief
  // reported five members `idle_with_claimable` — the leader broadcast twice and woke all
  // five (woken:1 verified) demanding work the scheduler was structurally refusing.
  const idleShape = {
    stalled: false,
    verdict: 'monitoring' as const,
    parkedOn: [],
    doing: null,
    load: 0,
    queued: [],
  };

  it('suppresses idle-with-claimable when the shared oracle says the member is concurrency-blocked', () => {
    const s = computeBenchSuggestion(idleShape, 5, null, false, {
      blocked: true,
      activeClaims: 1,
      heldIds: ['WI-1'],
    });
    expect(s).toBeUndefined();
  });

  it('STILL flags idle-with-claimable when the member is genuinely free (the alert must not be neutered)', () => {
    const s = computeBenchSuggestion(idleShape, 5, null, false, {
      blocked: false,
      activeClaims: 0,
      heldIds: [],
    });
    expect(s?.kind).toBe('idle-with-claimable');
  });

  it('counts a claimable-event waiter in the summary alert when eligible supply predates its await', () => {
    const parked = computeBenchSuggestion(
      { ...idleShape, verdict: 'parked-awaiting-capability', parkedOn: ['work-item:claimable'] },
      2,
      null,
      false,
      { blocked: false, activeClaims: 0, heldIds: [] },
    );
    const idleWithClaimable = [parked].filter((s) => s?.kind === 'idle-with-claimable');
    const alert = computeIdleWithClaimableAlert({
      claimableCount: 2,
      idleMemberCount: idleWithClaimable.length,
      idleMemberIds: ['su-parked'],
    });
    expect(idleWithClaimable).toHaveLength(1);
    expect(alert?.reason).toMatch(/1 member\(s\)/);
  });

  it('fails OPEN when no verdict was read — an unread oracle must not silence a real starvation signal', () => {
    // Absent/null both read as "not read on this call", never as "not blocked".
    expect(computeBenchSuggestion(idleShape, 5, null, false, null)?.kind).toBe('idle-with-claimable');
    expect(computeBenchSuggestion(idleShape, 5, null, false)?.kind).toBe('idle-with-claimable');
  });

  it('does not count a suppressed member in idle_with_claimable, which is what the leader acts on', () => {
    // summary.idle_with_claimable filters on benchSuggestion?.kind === 'idle-with-claimable',
    // so suppression at the source is what removes it from the count the leader reads.
    const blocked = computeBenchSuggestion(idleShape, 5, null, false, {
      blocked: true,
      activeClaims: 2,
      heldIds: ['WI-1', 'WI-2'],
    });
    const free = computeBenchSuggestion(idleShape, 5, null, false, {
      blocked: false,
      activeClaims: 0,
      heldIds: [],
    });
    const idleWithClaimable = [blocked, free].filter((s) => s?.kind === 'idle-with-claimable');
    expect(idleWithClaimable).toHaveLength(1);
  });
});

describe('computeFleetBlockVerdict (P-019/P-012 — which LAYER is blocking the fleet)', () => {
  const congestedPool = {
    poolExhausted: true,
    degraded: true,
    factor: 0,
    queueDepth: 28,
    usableAccounts: 0,
    availableAccounts: 0,
  };
  const healthyPool = {
    poolExhausted: false,
    degraded: false,
    factor: 0.9,
    queueDepth: 0,
    usableAccounts: 4,
    availableAccounts: 4,
  };
  /** A fleet whose members are ALL working — nothing idle, nothing paused. */
  const working = {
    claimable: 40,
    matchedByFilter: 120,
    idleMemberCount: 0,
    lanelessIdleCount: 0,
    poolCapacity: healthyPool,
  };

  it('returns undefined when no member is idle and the fleet is not paused', () => {
    expect(computeFleetBlockVerdict(working)).toBeUndefined();
  });

  it('does NOT emit a reassuring "nothing wrong" row — absence is the signal', () => {
    // Guards the shape choice: a `layer: 'none'` verdict would be one more field to read
    // on every healthy brief, which is what the flat-alert problem already suffers from.
    expect(computeFleetBlockVerdict(working)).toBeUndefined();
  });

  describe('precedence — the layers dominate in physical dependency order', () => {
    it('fleet-paused outranks EVERY other layer', () => {
      const v = computeFleetBlockVerdict({
        ...working,
        fleetPaused: true,
        poolCapacity: congestedPool,
        claimable: 0,
        matchedByFilter: 0,
        idleMemberCount: 6,
        lanelessIdleCount: 3,
      });
      expect(v?.layer).toBe('fleet-paused');
      expect(v?.remedy).toContain('fleet:resume');
    });

    /**
     * THE INVERSION THIS ITEM EXISTS FOR. Measured live 2026-08-09T02:31Z: pool at factor 0
     * with 28 queued, 6 members idle beside a NONEMPTY claimable queue. Read flat, that is
     * `idleWithClaimableAlert` and the remedy is "wake them" — which adds six more requests
     * behind the same congestion. The pool layer must win.
     */
    it('inference-pool outranks members even when the queue is full and members are idle', () => {
      const v = computeFleetBlockVerdict({
        claimable: 293,
        matchedByFilter: 457,
        idleMemberCount: 6,
        lanelessIdleCount: 0,
        poolCapacity: congestedPool,
      });
      expect(v?.layer).toBe('inference-pool');
      expect(v?.remedy).toMatch(/do NOT coord:send wake/i);
      // and it must NAME the alert it is overruling, so the leader does not act on it next
      expect(v?.subordinate).toContain('idleWithClaimableAlert');
    });

    it('inference-pool outranks claim-floors', () => {
      const v = computeFleetBlockVerdict({
        claimable: 0,
        matchedByFilter: 108,
        idleMemberCount: 0,
        lanelessIdleCount: 5,
        poolCapacity: congestedPool,
      });
      expect(v?.layer).toBe('inference-pool');
      expect(v?.subordinate).toContain('floorStarvedAlert');
    });

    it('spec-scope wins over claim-floors when the spec matches nothing', () => {
      const v = computeFleetBlockVerdict({
        claimable: 0,
        matchedByFilter: 0,
        idleMemberCount: 0,
        lanelessIdleCount: 4,
        poolCapacity: healthyPool,
      });
      expect(v?.layer).toBe('spec-scope');
      expect(v?.remedy).toContain('scheduler:set_claim_spec');
    });

    it('claim-floors when the spec matches plenty and every row is withheld', () => {
      const v = computeFleetBlockVerdict({
        claimable: 0,
        matchedByFilter: 108,
        idleMemberCount: 0,
        lanelessIdleCount: 5,
        poolCapacity: healthyPool,
      });
      expect(v?.layer).toBe('claim-floors');
      expect(v?.remedy).toMatch(/do NOT bench/i);
    });

    it('members ONLY when every upstream layer is read and clear', () => {
      const v = computeFleetBlockVerdict({
        claimable: 293,
        matchedByFilter: 457,
        idleMemberCount: 6,
        lanelessIdleCount: 0,
        poolCapacity: healthyPool,
      });
      expect(v?.layer).toBe('members');
      expect(v?.remedy).toContain('coord:send');
      expect(v?.reason).toContain('pool read and healthy');
    });
  });

  describe('a degraded pool with an EMPTY queue is not currently starving anyone', () => {
    it('falls through to the members layer', () => {
      const v = computeFleetBlockVerdict({
        claimable: 293,
        matchedByFilter: 457,
        idleMemberCount: 6,
        lanelessIdleCount: 0,
        poolCapacity: { ...congestedPool, poolExhausted: false, queueDepth: 0 },
      });
      expect(v?.layer).toBe('members');
    });
  });

  describe('an exhausted pool remains blocking even with an EMPTY gateway queue', () => {
    it('lets poolExhausted outrank members when no provider accounts are usable', () => {
      const v = computeFleetBlockVerdict({
        claimable: 293,
        matchedByFilter: 457,
        idleMemberCount: 6,
        lanelessIdleCount: 0,
        poolCapacity: {
          ...congestedPool,
          degraded: false,
          queueDepth: 0,
          usableAccounts: 0,
          availableAccounts: 0,
        },
      });
      expect(v?.layer).toBe('inference-pool');
      expect(v?.remedy).toMatch(/do NOT coord:send wake/i);
    });
  });

  describe('fail-soft direction — an UNREAD pool never silently promotes the wake remedy', () => {
    it('states that layer 2 was not ruled out, and sends the leader to check it first', () => {
      const v = computeFleetBlockVerdict({
        claimable: 293,
        matchedByFilter: 457,
        idleMemberCount: 6,
        lanelessIdleCount: 0,
        poolCapacity: null,
      });
      expect(v?.layer).toBe('members');
      expect(v?.reason).toMatch(/no single inference pool could be RESOLVED/i);
      expect(v?.reason).toMatch(/layer 2\s+was not ruled out/i);
      // WI-41005: it must NOT assert an I/O failure. A null pool is also what a fleet spanning
      // providers looks like, and a leader told "could not be READ" re-probes forever — the
      // probe succeeds every time and the verdict never changes, because reading was never
      // the problem. The message has to leave that second cause reachable.
      expect(v?.reason).toMatch(/more than one provider/i);
      expect(v?.reason).not.toMatch(/could NOT be read/i);
      expect(v?.remedy).toMatch(/falsifier FIRST/i);
      // the falsifier must point at the layer that was NOT ruled out, not at the queue
      expect(v?.falsifier.tool).toBe('fleet:capacity');
      expect(v?.falsifier.kills).toMatch(/inference-pool/);
    });

    it('an unread pool cannot itself manufacture an inference-pool verdict', () => {
      const v = computeFleetBlockVerdict({
        claimable: 0,
        matchedByFilter: 108,
        idleMemberCount: 0,
        lanelessIdleCount: 5,
        poolCapacity: null,
      });
      expect(v?.layer).toBe('claim-floors');
    });
  });

  /**
   * The pool verdict is computed from a cached projection that has now false-positived
   * TWICE in one session (fleet:capacity reporting poolExhausted/usableAccounts:0 while a
   * live probe found 3 of 4 accounts answering 200). Its falsifier must therefore be the
   * LIVE probe, not a re-read of the same projection — and must say plainly that the
   * projection alone is not grounds to escalate to the owner.
   */
  describe('the inference-pool falsifier is the live probe, not the projection', () => {
    const v = computeFleetBlockVerdict({
      claimable: 293,
      matchedByFilter: 457,
      idleMemberCount: 6,
      lanelessIdleCount: 0,
      poolCapacity: congestedPool,
    });

    it('calls accounts:probe-capacity', () => {
      expect(v?.falsifier.tool).toBe('accounts:probe-capacity');
      expect(v?.falsifier.check).toContain('accounts:probe-capacity');
    });

    it('measures something INDEPENDENT of the input it fired on', () => {
      expect(v?.falsifier.measurement).toMatch(/live/i);
      expect(v?.falsifier.measurement).toMatch(/independent of the cached/i);
    });

    it('warns against escalating a pool fault on the projection alone', () => {
      expect(v?.falsifier.kills).toMatch(/NEVER escalate/i);
      expect(v?.falsifier.kills).toMatch(/probe first/i);
    });
  });

  /**
   * FALSIFIABILITY CONTROL (CLAUDE.md "proving a guard is falsifiable" — module tier: a
   * deliberately-wrong implementation kept PERMANENTLY in the test file, never a mutation
   * of the shared tree).
   *
   * `naiveFlatVerdict` is the behaviour that existed BEFORE this item: the alerts read in
   * field order, members-first, with no precedence. If someone reorders the real function's
   * branches — or deletes the pool check — it degenerates to exactly this. The control
   * proves the precedence assertions above can actually FAIL, and the calibration case
   * proves they are not passing for a trivial reason (e.g. both returning undefined).
   */
  describe('control: the pre-fix flat reading, kept so the precedence tests can fail', () => {
    type Input = Parameters<typeof computeFleetBlockVerdict>[0];
    const naiveFlatVerdict = (input: Input): string | undefined => {
      if ((input.claimable ?? 0) > 0 && input.idleMemberCount > 0) return 'members';
      if (input.claimable === 0 && (input.matchedByFilter ?? 0) > 0) return 'claim-floors';
      if (input.matchedByFilter === 0) return 'spec-scope';
      return undefined;
    };
    // The exact live 2026-08-09T02:31Z shape: starved pool, full queue, six idle members.
    const inversion = {
      claimable: 293,
      matchedByFilter: 457,
      idleMemberCount: 6,
      lanelessIdleCount: 0,
      poolCapacity: congestedPool,
    };

    it('the naive reading gets the inversion WRONG (this is what regressing looks like)', () => {
      expect(naiveFlatVerdict(inversion)).toBe('members');
    });

    it('the real function gets it RIGHT — so the precedence test is not vacuous', () => {
      expect(computeFleetBlockVerdict(inversion)?.layer).toBe('inference-pool');
      expect(computeFleetBlockVerdict(inversion)?.layer).not.toBe(naiveFlatVerdict(inversion));
    });

    it('CALIBRATION: the two agree wherever precedence is not in play', () => {
      // Without this, "they differ" could be satisfied by a real function that is simply
      // broken everywhere rather than one that is correctly ordered.
      const noPrecedenceConflict = {
        claimable: 0,
        matchedByFilter: 108,
        idleMemberCount: 0,
        lanelessIdleCount: 5,
        poolCapacity: healthyPool,
      };
      expect(computeFleetBlockVerdict(noPrecedenceConflict)?.layer).toBe(naiveFlatVerdict(noPrecedenceConflict));
    });
  });

  it('every layer ships a falsifier that is read-only', () => {
    const inputs = [
      { ...working, fleetPaused: true },
      { ...working, idleMemberCount: 6, poolCapacity: congestedPool },
      { ...working, idleMemberCount: 0, lanelessIdleCount: 4, matchedByFilter: 0, claimable: 0 },
      { ...working, idleMemberCount: 0, lanelessIdleCount: 5, claimable: 0 },
      { ...working, idleMemberCount: 6 },
      { ...working, idleMemberCount: 6, poolCapacity: null },
    ];
    const layers = new Set<string>();
    for (const input of inputs) {
      const v = computeFleetBlockVerdict(input);
      expect(v).toBeDefined();
      layers.add(v!.layer);
      expect(FALSIFIER_FORBIDDEN_TOOLS).not.toContain(v!.falsifier.tool);
      expect(v!.falsifier.check.length).toBeGreaterThan(0);
      expect(v!.falsifier.kills.length).toBeGreaterThan(0);
      expect(v!.remedy.length).toBeGreaterThan(0);
    }
    // calibration: the six inputs must actually exercise all five layers, or the
    // read-only assertion above is passing on a set that never reached most of them
    expect(layers).toEqual(new Set(['fleet-paused', 'inference-pool', 'spec-scope', 'claim-floors', 'members']));
  });
});

describe('P-004 / R-4 — stalled-item rotation names the held ITEM that has not advanced, not the worker', () => {
  // feature-drain-delivery-readiness-and-outcome-accounting-2026-10-01. The 0930 incident:
  // live, BUSY workers sat on week-old items while closeable items waited. Every existing
  // signal keys on worker activity, so a fresh tool call (status reads, orient, get_next
  // probes) read them as healthy. These fixtures therefore pair a FRESH tool call with an
  // item whose own progress clock has not moved.
  const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

  function wiClaim(overrides: Partial<AgentClaim> = {}): AgentClaim {
    return {
      type: 'work-item',
      harnessSlug: 'papercusp',
      planSlug: null,
      id: 'WI-77',
      itemKind: 'change',
      detail: 'week-old item',
      status: 'wip',
      acquiredTs: minAgo(45),
      expiresTs: null,
      active: true,
      orphaned: false,
      stalled: false,
      lastProgressAt: null,
      activity: 'alive' as AgentClaim['activity'],
      rank: null,
      rankWriter: null,
      ...overrides,
    };
  }

  const busyMember = (claims: AgentClaim[], extra: Partial<DecoratedAgent> = {}) =>
    baseAgent({
      agentId: 'su-busy',
      sessionState: 'live',
      lastToolCallAt: minAgo(0.5), // busy worker: a tool call 30s ago
      load: claims.length,
      claims,
      ...extra,
    });

  it('NAMES the item: held 45 min, never checkpointed, worker busy, ready work waiting', () => {
    const m = projectMember(busyMember([wiClaim()]), NOW, 2, null, false);
    expect(m.stalledItem).toEqual({
      item: 'WI-77',
      itemTitle: 'week-old item',
      noAdvanceMin: 45,
      advancedAt: minAgo(45),
      advanceSignal: 'claim_acquired_at',
      readyWaiting: 2,
      requiredAction: STALLED_ITEM_REQUIRED_ACTION,
    });
    // the required action offers all four accountable outcomes
    for (const verb of ['work_items:complete', 'work_items:create', 'work_items:set_blocker', 'work_items:release']) {
      expect(STALLED_ITEM_REQUIRED_ACTION).toContain(verb);
    }
  });

  it('measures from the last authored checkpoint when one exists, and names the OLDEST stalled item', () => {
    const r = computeStalledItemRotation(
      {
        agentId: 'su-busy',
        sessionState: 'live',
        claims: [
          wiClaim({ id: 'WI-A', acquiredTs: minAgo(300), lastProgressAt: minAgo(40) }),
          wiClaim({ id: 'WI-B', acquiredTs: minAgo(300), lastProgressAt: minAgo(200) }),
        ],
      },
      NOW,
      3,
      false,
    );
    expect(r?.item).toBe('WI-B');
    expect(r?.advanceSignal).toBe('last_progress_at');
    expect(r?.noAdvanceMin).toBe(200);
  });

  it('does NOT name an item that advanced inside the threshold (checkpoint 10 min ago)', () => {
    const m = projectMember(
      busyMember([wiClaim({ acquiredTs: minAgo(300), lastProgressAt: minAgo(10) })]),
      NOW,
      2,
      null,
      false,
    );
    expect(m.stalledItem).toBeUndefined();
  });

  it('ignores a MECHANICAL (system-written) checkpoint as advancement', () => {
    const claim = wiClaim({
      acquiredTs: minAgo(120),
      lastProgressAt: minAgo(5),
      claimHealth: {
        status: 'stale',
        reasons: [],
        expected_cadence_ms: 1_800_000,
        evidence: [{ writer: 'work_items_checkpoint', signal: 'checkpoint_kind', value: 'mechanical' }],
      } as unknown as AgentClaim['claimHealth'],
    });
    expect(materialAdvanceAnchor(claim)?.signal).toBe('claim_acquired_at');
    const r = computeStalledItemRotation({ agentId: 'su-busy', claims: [claim] }, NOW, 1, false);
    expect(r?.noAdvanceMin).toBe(120);
  });

  it('exempts a PAUSED fleet — a quiet member is the compliant response to a stand-down', () => {
    expect(projectMember(busyMember([wiClaim()]), NOW, 2, null, true).stalledItem).toBeUndefined();
  });

  // WI-10005110: R-4's third exclusion, measured at the projection the brief actually
  // renders (projectMember), not only at computeStalledItemRotation. The same member is
  // named without the in-flight test (control) and is NOT named while one runs; a non-test
  // long call (a status read) still names it, so the exemption cannot widen silently.
  it('AUTO-BAR-R-4-P-004: a member past the stall threshold with ready items waiting is not named while an instrumented long test is in flight (control: named without it)', () => {
    const member = busyMember([wiClaim()]);
    const control = projectMember(member, NOW, 2, null, false);
    expect(control.stalledItem?.item).toBe('WI-77');
    expect(control.stalledItem?.readyWaiting).toBe(2);
    expect(control.stalledItem?.noAdvanceMin).toBeGreaterThanOrEqual(STALLED_ITEM_ROTATION_THRESHOLD_MS / 60_000);

    for (const tool of ['testing:run', 'capability:bash', 'build:typecheck', 'release:checkpoint-run']) {
      const inFlight = { tool, ageSec: 1200 };
      const m = projectMember(member, NOW, 2, null, false, null, null, inFlight);
      expect(m.stalledItem).toBeUndefined();
      expect(m.benchSuggestion).toBeUndefined();
      expect(m.dormant).toBeUndefined();
      expect(m.longCallInFlight).toEqual(inFlight);
    }

    const statusRead = projectMember(member, NOW, 2, null, false, null, null, { tool: 'work_items:get', ageSec: 1200 });
    expect(statusRead.stalledItem?.item).toBe('WI-77');
  });

  it('exempts an INSTRUMENTED LONG TEST in flight', () => {
    for (const tool of ['testing:run', 'capability:bash', 'build:typecheck', 'release:checkpoint-run']) {
      expect(isInstrumentedLongTestTool(tool)).toBe(true);
      const r = computeStalledItemRotation(
        { agentId: 'su-busy', claims: [wiClaim()], longCallInFlight: { tool, ageSec: 600 } },
        NOW,
        2,
        false,
      );
      expect(r).toBeUndefined();
    }
    // calibration: a non-test long call (a status read) does NOT exempt it
    expect(isInstrumentedLongTestTool('work_items:get')).toBe(false);
    expect(
      computeStalledItemRotation(
        { agentId: 'su-busy', claims: [wiClaim()], longCallInFlight: { tool: 'work_items:get', ageSec: 600 } },
        NOW,
        2,
        false,
      )?.item,
    ).toBe('WI-77');
  });

  it('names no one when NO ready work waits (claimable 0) or the count was not read (null)', () => {
    expect(projectMember(busyMember([wiClaim()]), NOW, 0, null, false).stalledItem).toBeUndefined();
    expect(projectMember(busyMember([wiClaim()]), NOW, null, null, false).stalledItem).toBeUndefined();
  });

  it('skips items whose accountable action was already taken (blocked / needs-human) and ended sessions', () => {
    expect(
      computeStalledItemRotation({ agentId: 'x', claims: [wiClaim({ status: 'blocked' })] }, NOW, 2, false),
    ).toBeUndefined();
    expect(
      computeStalledItemRotation({ agentId: 'x', claims: [wiClaim({ status: 'needs-human' })] }, NOW, 2, false),
    ).toBeUndefined();
    expect(
      computeStalledItemRotation({ agentId: 'x', sessionState: 'ended', claims: [wiClaim()] }, NOW, 2, false),
    ).toBeUndefined();
    expect(
      computeStalledItemRotation({ agentId: 'x', claims: [wiClaim({ orphaned: true })] }, NOW, 2, false),
    ).toBeUndefined();
  });

  it('the threshold boundary is 30 minutes (D-007)', () => {
    expect(STALLED_ITEM_ROTATION_THRESHOLD_MS).toBe(30 * 60_000);
    const at = (m: number) =>
      computeStalledItemRotation({ agentId: 'x', claims: [wiClaim({ acquiredTs: minAgo(m) })] }, NOW, 1, false);
    expect(at(29)).toBeUndefined();
    expect(at(30)?.noAdvanceMin).toBe(30);
  });
});

// P-007 / R-17: the leader brief names the members the silence rule left out of
// `headcount.current`, and never renders an unreadable leg as "nobody is silent".
describe('silentMembersSummary (P-007 / R-17)', () => {
  it('names the silent members with the threshold and pause flag', () => {
    expect(
      silentMembersSummary(['busy', 'quiet'], {
        counted: ['busy'],
        silent: ['quiet'],
        paused: false,
        thresholdMs: 1_200_000,
      }),
    ).toEqual({ status: 'measured', ownerIds: ['quiet'], thresholdMs: 1_200_000, paused: false });
  });

  it('reports a measured empty list only when the partition was actually read', () => {
    expect(
      silentMembersSummary(['busy'], { counted: ['busy'], silent: [], paused: true, thresholdMs: 1_200_000 }),
    ).toEqual({ status: 'measured', ownerIds: [], thresholdMs: 1_200_000, paused: true });
  });

  it('answers unknown with a reason when the roster or a silence leg is unreadable', () => {
    expect(silentMembersSummary(null, null)).toEqual({ status: 'unknown', reason: 'live roster unreadable' });
    expect(silentMembersSummary(['busy'], null)).toEqual({
      status: 'unknown',
      reason: 'execution or await leg unreadable',
    });
  });
});

// P-005 / D-030 step 5: the brief's UNDER-staff alert view. The handler passes a
// null control state when the fleet record was not read, so that leg must stay
// unknown; a fired alert must carry its reason and a read-only falsifier.
describe('buildFleetUnderStaffedBriefAlert (P-005 / D-030)', () => {
  const headcount = (over: Partial<FleetHeadcountState> = {}): FleetHeadcountState => ({
    enabled: true,
    target: 3,
    current: 1,
    shortfall: 2,
    underStrength: true,
    verdict: 'under-strength',
    held: false,
    notHeldBecause: 'supervise-not-granted',
    topUpRule: { status: 'none', kind: null, inherited: null, ratifiedBy: null, reason: null, until: null },
    basis: {
      kind: 'agent-origin-execution-attested',
      liveRosterMembers: 1,
      executingMembers: 1,
      transactionWorkerReadyMembers: null,
    },
    countEvidence: { productive: null, liveRoster: null, transactionWorkerReady: null, note: '' },
    ...over,
  });

  it('fires below target with its reason and a fleet:assignments falsifier for this fleet', () => {
    const out = buildFleetUnderStaffedBriefAlert({
      fleet: 'short-fleet',
      headcount: headcount(),
      controlState: 'active',
      fleetPaused: false,
    });
    expect(out).toMatchObject({ alert: true, current: 1, target: 3, shortfall: 2 });
    expect(out?.reason).toContain('1 of 3 target worker(s) are productive');
    expect(out?.falsifier).toMatchObject({
      tool: 'fleet:assignments',
      check: "fleet:assignments { fleet: 'short-fleet' }",
    });
    expect(out?.falsifier?.kills).toContain('3 or more members are live');
    expect(FALSIFIER_FORBIDDEN_TOOLS).not.toContain(out!.falsifier!.tool);
  });

  it('names the empty-fleet kill condition when no target is set', () => {
    const out = buildFleetUnderStaffedBriefAlert({
      fleet: 'empty-fleet',
      headcount: headcount({ target: null, current: 0, notHeldBecause: 'no-target' }),
      controlState: 'active',
    });
    expect(out?.alert).toBe(true);
    expect(out?.falsifier?.kills).toContain('at least one live member holds a claim');
  });

  it('reports a measured no-alert at target, with no falsifier attached', () => {
    const out = buildFleetUnderStaffedBriefAlert({
      fleet: 'full-fleet',
      headcount: headcount({ current: 3 }),
      controlState: 'active',
    });
    expect(out).toMatchObject({ alert: false, current: 3, target: 3 });
    expect(out?.falsifier).toBeUndefined();
  });

  it('stays unknown when the fleet record was not read, and fires once it is (positive control)', () => {
    const unread = { fleet: 'f', headcount: headcount(), controlState: null };
    expect(buildFleetUnderStaffedBriefAlert(unread)).toBeUndefined();
    expect(buildFleetUnderStaffedBriefAlert({ ...unread, controlState: 'active' })?.alert).toBe(true);
  });

  it('stays quiet for a paused or winding-down fleet', () => {
    const base = { fleet: 'f', headcount: headcount(), controlState: 'active' };
    expect(buildFleetUnderStaffedBriefAlert({ ...base, fleetPaused: true })).toBeUndefined();
    expect(buildFleetUnderStaffedBriefAlert({ ...base, controlState: 'winding-down' })).toBeUndefined();
  });
});
