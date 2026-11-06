import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { WorkItem } from '../../work-items';

vi.mock('../../work-items', async (importOriginal) => ({
  // EI-18672701535825889: keep the real readWorkItemClaimHoldProvenance (+ its readers) —
  // burn_down's claim-hold reason enrichment depends on it, and a bare-object mock silently
  // leaves it `undefined`, TypeErroring on the very row this fix is about.
  ...(await importOriginal<object>()),
  listWorkItems: vi.fn(),
  listAllWorkItemsForFileExport: vi.fn(),
  countWorkItems: vi.fn(),
  countWorkItemsByState: vi.fn(),
  getWorkItem: vi.fn(),
  explainIssueClaimFloors: vi.fn(),
}));

vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listPresence: vi.fn(),
  PRESENCE_STALE_MS: 60_000,
}));

vi.mock('../../modes/store', () => ({ getModes: vi.fn() }));
vi.mock('./drain-flow', () => ({ readDrainFlow: vi.fn() }));
vi.mock('../../issue-occurrence-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../issue-occurrence-ledger')>()),
  readIssueOccurrenceCounts: vi.fn(),
}));
vi.mock('../fleet/fleet-metrics-scope', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveFleetMetricScope: vi.fn(),
  readFleetMetricSource: vi.fn(),
  withFleetMetricReadSql: async (read: (sql: undefined) => Promise<unknown>) => read(undefined),
}));

import {
  countWorkItems,
  countWorkItemsByState,
  explainIssueClaimFloors,
  getWorkItem,
  listWorkItems,
  listAllWorkItemsForFileExport,
  WORK_ITEMS_MAX_LIMIT,
} from '../../work-items';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { listPresence } from '../coordination/presence';
import { getModes } from '../../modes/store';
import { readDrainFlow, type DrainFlowReport } from './drain-flow';
import { readIssueOccurrenceCounts, type IssueOccurrenceCounts } from '../../issue-occurrence-ledger';
import {
  buildFleetMetricsResult,
  buildBurnDownResult,
  buildCohortAudit,
  liveOwnersFromPresence,
  applyLaneFence,
  NON_TERMINAL_CENSUS_CEILING,
} from './burn_down';
import { shapeBurnDown } from './burn_down-shape';
import { compactLeaderBriefForResultDoor, shapeLeaderBrief } from '../fleet/leader-brief-shape';
import { computeAgentReviewService } from '../../harness/improvements/flow-metrics';
import { updateExternalBlockerHistory } from '../../external-blockers';
import { P2P_LANE_EXCLUSION_TERMS, P2P_LANE_REJECTED_ANTI_TERMS } from '../../scheduler/p2p-lane-fence';
import { DEFAULT_CLAIM_SPEC, type ClaimSpec } from '../../scheduler/claim-spec';
import {
  FLEET_METRIC_COMPARISON_RULE,
  FLEET_METRIC_POPULATIONS,
  FLEET_METRICS_SCHEMA_VERSION,
  fleetMetricsResultSchema,
} from '../fleet/fleet-metrics-contract';
import {
  resolveFleetMetricScope,
  readFleetMetricSource,
  type FleetMetricFlowMode,
  type ResolvedFleetMetricScope,
} from '../fleet/fleet-metrics-scope';
import { buildFleetPopulationLifecycle } from '../fleet/fleet-population';
import { compareCountEvidence, materializeCountEvidence } from '../../count-evidence-contract';

const mockListWorkItems = vi.mocked(listWorkItems);
const mockListAllWorkItems = vi.mocked(listAllWorkItemsForFileExport);
const mockCountWorkItems = vi.mocked(countWorkItems);
const mockCountWorkItemsByState = vi.mocked(countWorkItemsByState);

/**
 * WI-6554700010008464 — the live census no longer issues one capped listWorkItems. It reads
 * the open rows, a terminal-history slice and two aggregates. Answer all four from one row
 * set, the way the database would, so each test states its population once.
 */
function stubCensus(rows: WorkItem[]): void {
  const terminal = new Set<string>(ANY_FAMILY_TERMINAL_STATES);
  const open = rows.filter((r) => !terminal.has(r.state));
  mockListWorkItems.mockImplementation(async (filter = {}) => {
    const states = filter.states;
    const pool = states ? rows.filter((r) => states.includes(r.state)) : filter.notTerminal ? open : rows;
    return pool.slice(0, filter.limit ?? pool.length);
  });
  mockListAllWorkItems.mockImplementation(async (filter = {}) => (filter.notTerminal ? open : rows));
  mockCountWorkItems.mockImplementation(async (filter = {}) => (filter.notTerminal ? open.length : rows.length));
  mockCountWorkItemsByState.mockImplementation(async () => {
    const byState: Record<string, number> = {};
    for (const r of rows) byState[r.state] = (byState[r.state] ?? 0) + 1;
    return byState;
  });
}
const mockGetWorkItem = vi.mocked(getWorkItem);
const mockExplainIssueClaimFloors = vi.mocked(explainIssueClaimFloors);
const mockListPresence = vi.mocked(listPresence);
const mockGetModes = vi.mocked(getModes);
const mockReadDrainFlow = vi.mocked(readDrainFlow);
const mockReadIssueOccurrenceCounts = vi.mocked(readIssueOccurrenceCounts);
const mockResolveFleetMetricScope = vi.mocked(resolveFleetMetricScope);
const mockReadFleetMetricSource = vi.mocked(readFleetMetricSource);
const tool = (await import('./burn_down')).default;

const FLEET_START = '2026-08-20T12:00:00.000Z';
const FLEET_REVISION_AT = '2026-08-21T00:00:00.000Z';
const FLEET_END = '2026-08-21T12:00:00.000Z';

const drainFlowReport: DrainFlowReport = {
  exact: true,
  windowStart: '2026-08-13T08:00:00.000Z',
  workspaceId: 'ws-test',
  harness: 'papercusp',
  ownerId: 'su-drainer',
  totals: { opened: 4, terminaled: 3, net: 1 },
  bySeverity: {
    critical: { opened: 1, terminaled: 0, net: 1 },
    major: { opened: 1, terminaled: 2, net: -1 },
    minor: { opened: 2, terminaled: 1, net: 1 },
    nit: { opened: 0, terminaled: 0, net: 0 },
  },
  breaker: {
    tripped: true,
    blocksNewBugs: true,
    rule: 'after the first admitted bug, block while opened >= terminaled',
    reason: '4 opened vs 3 terminaled',
  },
};

const issueOccurrenceCounts: IssueOccurrenceCounts = {
  canonicalClusters: 2,
  rawOccurrences: 5,
  duplicateOccurrences: 3,
  units: {
    canonicalClusters: 'distinct canonical work-item ids with occurrences',
    rawOccurrences: 'append-only report rows',
    duplicateOccurrences: 'report rows not creating a canonical item',
  },
  writer: 'harness_shared.work_item_occurrences',
};

function item(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: 'WI-1',
    kind: 'task',
    family: 'issue',
    harness: 'papercusp',
    title: 'title',
    summary: 'summary',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    createdBy: null,
    severity: 'minor',
    parent: null,
    payload: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    completionAuthority: null,
    createdAt: '2026-07-05T20:00:00.000Z',
    updatedAt: '2026-07-05T20:00:00.000Z',
    closedAt: null,
    goalId: null,
    ...overrides,
  };
}

function fleetSpec(revision: number, ids: string[]): ClaimSpec {
  return {
    ...DEFAULT_CLAIM_SPEC,
    specId: 'fleet-lane',
    revision,
    view: {
      ...DEFAULT_CLAIM_SPEC.view,
      filter: { field: 'id', op: 'in', value: ids },
    },
  };
}

function fleetResolution(flowMode: FleetMetricFlowMode): ResolvedFleetMetricScope {
  const current = fleetSpec(2, ['WI-new', 'WI-remaining', 'OBS-new']);
  const currentSegment = {
    revision: 2,
    spec: current,
    startAt: FLEET_REVISION_AT,
    endAt: FLEET_END,
    source: 'current' as const,
    cause: 'current' as const,
  };
  return {
    ok: true,
    schemaVersion: FLEET_METRICS_SCHEMA_VERSION,
    generatedAt: FLEET_END,
    scope: {
      fleet: 'fleet-a',
      harness: 'papercusp',
      window: {
        kind: 'fleet-lifetime',
        startAt: FLEET_START,
        endAt: FLEET_END,
        startInclusive: true,
        endExclusive: true,
        startSource: 'fleet-created-at',
        endSource: 'snapshot-generated-at',
      },
      stock: {
        mode: 'current-spec',
        specId: 'fleet-lane',
        revision: 2,
        source: 'fleet',
        appliedTo: 'all-counted-items',
      },
      flow:
        flowMode === 'current-spec'
          ? {
              mode: 'current-spec',
              specId: 'fleet-lane',
              revision: 2,
              source: 'fleet',
              appliedTo: 'all-counted-items',
            }
          : {
              mode: 'at-event-spec',
              specId: 'fleet-lane',
              currentRevision: 2,
              revision: 'effective-at-event',
              historyWriter: 'harness_shared.cup_claim_spec_revisions',
              appliedTo: 'each-event-at-its-event-time',
              missingRevision: 'unavailable-never-current-fallback',
            },
      attribution: {
        membership: FLEET_METRIC_POPULATIONS.everMembers,
        writer: 'harness_shared.fleet_membership_events',
        memberCount: 2,
        rule: 'actor owner id is in the fleet append-only ever-member cohort',
      },
      population: {
        currentRunnableRoster: FLEET_METRIC_POPULATIONS.currentRunnableRoster,
        relevantRoster: FLEET_METRIC_POPULATIONS.relevantRoster,
        attribution: FLEET_METRIC_POPULATIONS.everMembers,
        stock: FLEET_METRIC_POPULATIONS.currentSpecWorkItems,
        flow:
          flowMode === 'current-spec'
            ? FLEET_METRIC_POPULATIONS.currentSpecWorkItems
            : FLEET_METRIC_POPULATIONS.atEventSpecWorkItemEvents,
        canonicalBugs: FLEET_METRIC_POPULATIONS.canonicalBugs,
        observations: FLEET_METRIC_POPULATIONS.observations,
        occurrences: FLEET_METRIC_POPULATIONS.occurrences,
        terminalAuthority: FLEET_METRIC_POPULATIONS.terminalAuthority,
        comparisonRule: FLEET_METRIC_COMPARISON_RULE,
      },
    },
    quality: {
      exactness: { status: 'exact', sourceCap: null },
      freshness: { status: 'fresh', measuredAt: FLEET_END, staleAfterMs: 60_000 },
    },
    claimSpec: {
      current,
      segments:
        flowMode === 'current-spec'
          ? [currentSegment]
          : [
              {
                revision: 1,
                spec: fleetSpec(1, ['WI-old']),
                startAt: FLEET_START,
                endAt: FLEET_REVISION_AT,
                source: 'history',
                cause: 'update',
              },
              currentSegment,
            ],
      historyReturned: flowMode === 'current-spec' ? 0 : 1,
      historyMore: false,
    },
    currentRoster: { ownerIds: ['member-live'], writer: 'fleet-roster' },
    everMemberIds: ['member-dead', 'member-live'],
    populationLifecycle: buildFleetPopulationLifecycle({
      fleet: 'fleet-a',
      candidates: [{ agentId: 'member-live', alive: true, sessionState: 'live' as const, claims: [] }],
      everMemberIds: ['member-dead', 'member-live'],
      fleetStartedAtMs: Date.parse(FLEET_START),
      observedAtMs: Date.parse(FLEET_END),
    }).snapshot,
  };
}

function fleetMetricItems(): WorkItem[] {
  return [
    item({
      id: 'WI-old',
      kind: 'bug',
      state: 'done',
      createdBy: 'member-dead',
      terminalOwner: 'member-dead',
      completionAuthority: null,
      createdAt: '2026-08-20T18:00:00.000Z',
      updatedAt: '2026-08-20T20:00:00.000Z',
      closedAt: '2026-08-20T20:00:00.000Z',
    }),
    item({
      id: 'WI-new',
      kind: 'bug',
      state: 'done',
      createdBy: 'member-live',
      terminalOwner: 'member-live',
      completionAuthority: 'committed',
      createdAt: '2026-08-21T06:00:00.000Z',
      updatedAt: '2026-08-21T08:00:00.000Z',
      closedAt: '2026-08-21T08:00:00.000Z',
    }),
    item({
      id: 'WI-remaining',
      kind: 'bug',
      assignee: 'su-other',
      createdBy: 'su-other',
      createdAt: '2026-08-21T07:00:00.000Z',
      updatedAt: '2026-08-21T07:00:00.000Z',
    }),
    item({
      id: 'OBS-new',
      kind: 'bug',
      payload: { lane: 'observation' },
      createdBy: 'member-live',
      createdAt: '2026-08-21T07:30:00.000Z',
      updatedAt: '2026-08-21T07:30:00.000Z',
    }),
  ];
}

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    tool as unknown as { handler: (a: unknown, c: unknown) => Promise<{ data: unknown }> }
  ).handler(args, ctx);
}

describe('work_items:burn_down', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubCensus([]);
    mockGetWorkItem.mockResolvedValue(null);
    mockExplainIssueClaimFloors.mockResolvedValue([]);
    mockGetModes.mockResolvedValue([]);
    mockReadDrainFlow.mockResolvedValue(drainFlowReport);
    mockReadIssueOccurrenceCounts.mockResolvedValue(issueOccurrenceCounts);
  });

  it('carries reservation, progress, real waits and unknown attestation independently through the tool shaper', () => {
    const generatedAt = '2026-10-10T04:00:00.000Z';
    const result = buildBurnDownResult([
      item({ id: 'WI-reserved', assignee: 'su-worker', takenAt: '2026-10-10T03:50:00.000Z' }),
      item({ id: 'WI-progress', assignee: 'su-worker', takenAt: '2026-10-10T03:50:00.000Z',
        lastProgressAt: '2026-10-10T03:59:00.000Z' }),
      item({ id: 'WI-wait', assignee: 'su-worker', payload: { externalBlockers:
        updateExternalBlockerHistory(null, { kind: 'event', ref: 'fixture:ready',
          summary: 'Await the fixture', capability: 'live-dependency' }, 'su-worker', generatedAt).blockers } }),
      item({ id: 'WI-park', assignee: 'su-worker', payload: { _claimHold: true } }),
    ], new Set(['su-worker']), { harness: 'papercusp', generatedAt });
    const rows = [...result.inFlight, ...result.parked];
    expect(rows.find(r => r.id === 'WI-reserved')?.workEvidence).toMatchObject({
      reservation: { owner: 'su-worker' }, recentItemWork: { status: 'unknown' }, nativeAttestation: { status: 'unknown' },
    });
    expect(rows.find(r => r.id === 'WI-progress')?.workEvidence.recentItemWork.status).toBe('recent');
    expect(rows.find(r => r.id === 'WI-wait')?.workEvidence.waiting).toEqual({ status: 'registered', refs: ['event:fixture:ready'] });
    expect(rows.find(r => r.id === 'WI-park')?.workEvidence.waiting.status).toBe('unknown');
    const shaped = shapeBurnDown(result, 'trimmed');
    expect(shaped).toMatchObject({ inFlight: [
      expect.objectContaining({ workEvidence: expect.objectContaining({ nativeAttestation: { status: 'unknown',
        reason: 'Owner-bound native execution was not attested by this item read' } }) }),
      expect.objectContaining({ workEvidence: expect.objectContaining({ recentItemWork: expect.objectContaining({ status: 'recent' }) }) }),
    ] });
  });

  it('classifies terminal, in-flight, parked, and unclaimed rows', () => {
    const result = buildBurnDownResult(
      [
        // EI-18820653360383242: the delta is driven by closedAt, NOT updatedAt.
        item({ id: 'WI-done', state: 'done', updatedAt: '2026-07-05T20:10:00.000Z', closedAt: '2026-07-05T20:10:00.000Z' }),
        item({ id: 'EI-resolved', state: 'resolved', updatedAt: '2026-07-05T20:20:00.000Z', closedAt: '2026-07-05T20:20:00.000Z' }),
        item({ id: 'WI-live', assignee: 'su-live', takenAt: '2026-07-05T20:01:00.000Z' }),
        item({ id: 'WI-dead', assignee: 'su-dead' }),
        item({ id: 'WI-blocked', state: 'blocked' }),
        item({ id: 'WI-held', payload: { _claimHold: true } }),
        item({ id: 'WI-open' }),
      ],
      new Set(['su-live']),
      {
        harness: 'papercusp',
        generatedAt: '2026-07-05T20:30:00.000Z',
        since: '2026-07-05T20:15:00.000Z',
      },
    );

    expect(result.terminal).toMatchObject({
      total: 2,
      done: 1,
      resolved: 1,
      delta: 1,
    });
    expect(result.inFlight.map((r) => [r.id, r.assigneeLive])).toEqual([
      ['WI-live', true],
      ['WI-dead', false],
    ]);
    expect(result.parked.map((r) => [r.id, r.mechanism, r.aliasedState])).toEqual([
      ['WI-blocked', 'blocked', undefined],
      ['WI-held', 'claimHold', 'open'],
    ]);
    expect(result.unclaimed.map((r) => r.id)).toEqual(['WI-open']);
    expect(result.counts).toEqual({
      total: 7,
      terminal: 2,
      inFlight: 2,
      parked: 2,
      unclaimed: 1,
    });
  });

  it('EI-18672701535825889: claim-hold reason surfaces BOTH provenance conventions, and flags a genuine unattributed hold distinctly', () => {
    const result = buildBurnDownResult(
      [
        item({ id: 'WI-lease', payload: { _claimHold: true, held_open_by: 'su-alice', held_open_reason: 'verifying evidence' } }),
        item({ id: 'WI-park', payload: { _claimHold: true, claim_hold_by: 'su-bob', claim_hold_reason: 'D-003 policy-tier gate' } }),
        item({
          id: 'WI-both',
          payload: {
            _claimHold: true,
            held_open_by: 'su-carol',
            held_open_reason: 'active work',
            claim_hold_by: 'su-dan',
            claim_hold_reason: 'also parked earlier',
          },
        }),
        item({ id: 'WI-unattributed', payload: { _claimHold: true } }),
      ],
      new Set(),
      { harness: 'papercusp' },
    );

    const byId = new Map(result.parked.map((r) => [r.id, r.reason]));
    expect(byId.get('WI-lease')).toBe('held open by su-alice: verifying evidence');
    expect(byId.get('WI-park')).toBe('durably parked by su-bob: D-003 policy-tier gate');
    expect(byId.get('WI-both')).toBe(
      'held open by su-carol: active work; durably parked by su-dan: also parked earlier',
    );
    // The near-miss this item documents: a row with NEITHER field is the only genuine
    // "unattributed, safe to triage" case — everything else must say who + why.
    expect(byId.get('WI-unattributed')).toMatch(/UNATTRIBUTED/);
  });

  it('P-018: projects overlapping queue controls, fail-loud ages/UNPARK state, review-only parks, and retains them through shaping', () => {
    const result = buildBurnDownResult(
      [
        item({
          id: 'WI-overlap',
          assignee: 'su-active',
          takenAt: '2026-08-26T11:00:00.000Z',
          payload: {
            _claimHold: true,
            held_open_by: 'su-lease',
            held_open_reason: 'verifying evidence',
            held_open_at: '2026-08-26T12:00:00.000Z',
            claim_hold_by: 'su-park',
            claim_hold_reason: 'release once P-003 lands',
            claim_hold_at: 'not-a-timestamp',
            claim_hold_release: {
              condition: 'P-003 lands',
              owner: 'su-owner',
              trigger: 'plan-item:done:P-003',
              reachability: 'reachable',
              evidence: 'work-queue-admission-and-bulk-dedup#P-003',
            },
            agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-idea', round: 2 },
          },
        }),
        item({
          id: 'WI-review-only',
          payload: {
            agentReview: { status: 'revision-requested', submittedBy: 'su-author', ledgerIdeaId: 'WI-revise', round: 1 },
          },
        }),
        item({ id: 'WI-unattributed', payload: { _claimHold: true } }),
      ],
      new Set(['su-active']),
      { harness: 'papercusp', generatedAt: '2026-08-27T12:00:00.000Z' },
    );

    const overlap = result.parked.find((row) => row.id === 'WI-overlap');
    expect(overlap).toMatchObject({ mechanism: 'claimHold' });
    expect(overlap?.queueControl).toMatchObject({
      activeClaim: { owner: 'su-active', claimedAt: '2026-08-26T11:00:00.000Z' },
      holdOpenLease: {
        holder: 'su-lease',
        age: { status: 'known', bucket: '1-7d' },
      },
      durablePark: {
        parker: 'su-park',
        age: { status: 'invalid', ageMs: null, bucket: 'unknown' },
        unparkCondition: { status: 'stated', text: 'release once P-003 lands' },
        releaseLiveness: {
          status: 'tracked',
          contractPresent: true,
          condition: 'P-003 lands',
          owner: 'su-owner',
          trigger: 'plan-item:done:P-003',
          reachability: 'reachable',
          evidence: 'work-queue-admission-and-bulk-dedup#P-003',
          findings: [],
        },
      },
      agentReview: { status: 'pending', submittedBy: 'su-filer', round: 2 },
      unattributedClaimHold: false,
    });

    expect(result.parked.find((row) => row.id === 'WI-review-only')).toMatchObject({
      mechanism: 'agent-review',
      queueControl: { agentReview: { status: 'revision-requested', submittedBy: 'su-author' } },
    });
    expect(result.parked.find((row) => row.id === 'WI-unattributed')).toMatchObject({
      queueControl: {
        durablePark: {
          parker: null,
          age: { status: 'missing', ageMs: null, bucket: 'unknown' },
          unparkCondition: { status: 'missing', text: null },
          releaseLiveness: {
            status: 'unverified',
            contractPresent: false,
            condition: null,
            evidence: null,
          },
        },
        unattributedClaimHold: true,
      },
    });

    const shaped = shapeBurnDown(result, 'trimmed') as { parked: Array<Record<string, unknown>> };
    expect(shaped.parked.find((row) => row.id === 'WI-overlap')).toMatchObject({
      queueControl: {
        durablePark: {
          age: { status: 'invalid', bucket: 'unknown' },
          unparkCondition: { status: 'stated' },
          releaseLiveness: {
            status: 'tracked',
            contractPresent: true,
            condition: 'P-003 lands',
            owner: 'su-owner',
            trigger: 'plan-item:done:P-003',
            reachability: 'reachable',
            evidence: 'work-queue-admission-and-bulk-dedup#P-003',
            findings: [],
          },
        },
      },
    });
    const resultSchema = (tool as unknown as { result: { safeParse: (value: unknown) => { success: boolean } } }).result;
    expect(resultSchema.safeParse(result).success).toBe(true);
    expect(resultSchema.safeParse(shaped).success).toBe(true);
  });

  it('parks needs-human and actively blocked rows instead of counting them unclaimed (WI-4759)', () => {
    const result = buildBurnDownResult(
      [
        item({ id: 'EI-needs-human', payload: { needsHuman: true } }),
        item({
          id: 'EI-external-blocker',
          payload: {
            externalBlockers: [{
              kind: 'runtime',
              capability: 'live-dependency',
              capabilitySource: 'explicit',
              ref: 'runtime:test',
              summary: 'test runtime is unavailable',
              status: 'active',
              createdAt: '2026-07-05T20:00:00.000Z',
              createdBy: 'su-test',
              updatedAt: '2026-07-05T20:00:00.000Z',
            }],
          },
        }),
        item({ id: 'EI-unclaimed' }),
      ],
      new Set(),
      { harness: 'papercusp' },
    );

    expect(result.parked.map((row) => [row.id, row.mechanism])).toEqual([
      ['EI-needs-human', 'needs-human'],
      ['EI-external-blocker', 'external-blocker'],
    ]);
    expect(result.unclaimed.map((row) => row.id)).toEqual(['EI-unclaimed']);
    expect(result.counts).toMatchObject({ parked: 2, unclaimed: 1 });
  });

  it('omits closedSince/openedSince when `since` is not passed', () => {
    const result = buildBurnDownResult(
      [item({ id: 'WI-done', state: 'done', updatedAt: '2026-07-05T20:10:00.000Z' })],
      new Set(),
      { harness: 'papercusp' },
    );
    expect(result.closedSince).toBeUndefined();
    expect(result.openedSince).toBeUndefined();
  });

  it('itemizes closedSince (terminal, closedAt>since) and openedSince (createdAt>since), newest first', () => {
    const result = buildBurnDownResult(
      [
        item({
          id: 'WI-closed-old',
          state: 'done',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-05T20:05:00.000Z',
          closedAt: '2026-07-05T20:05:00.000Z', // before since — not in closedSince
        }),
        item({
          id: 'WI-closed-new',
          state: 'resolved',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-05T20:20:00.000Z',
          closedAt: '2026-07-05T20:20:00.000Z',
        }),
        item({
          id: 'WI-closed-newer',
          state: 'dropped',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-05T20:25:00.000Z',
          closedAt: '2026-07-05T20:25:00.000Z',
        }),
        item({
          id: 'WI-opened-new',
          state: 'open',
          createdAt: '2026-07-05T20:22:00.000Z',
          updatedAt: '2026-07-05T20:22:00.000Z',
        }),
        item({
          id: 'WI-opened-old',
          state: 'open',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        }),
      ],
      new Set(),
      { harness: 'papercusp', since: '2026-07-05T20:15:00.000Z' },
    );
    expect(result.closedSince?.rows.map((r) => r.id)).toEqual(['WI-closed-newer', 'WI-closed-new']);
    expect(result.closedSince?.total).toBe(2);
    expect(result.closedSince?.truncated).toBe(false);
    expect(result.openedSince?.rows.map((r) => r.id)).toEqual(['WI-opened-new']);
    expect(result.openedSince?.total).toBe(1);
  });

  it('caps closedSince/openedSince at DELTA_ROW_CAP and reports truncated + true total', () => {
    const items = Array.from({ length: 35 }, (_, i) =>
      item({
        id: `WI-closed-${i}`,
        state: 'done',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: new Date(Date.parse('2026-07-05T20:15:01.000Z') + i * 1000).toISOString(),
        closedAt: new Date(Date.parse('2026-07-05T20:15:01.000Z') + i * 1000).toISOString(),
      }),
    );
    const result = buildBurnDownResult(items, new Set(), {
      harness: 'papercusp',
      since: '2026-07-05T20:15:00.000Z',
    });
    expect(result.closedSince?.rows).toHaveLength(30);
    expect(result.closedSince?.total).toBe(35);
    expect(result.closedSince?.truncated).toBe(true);
    // newest first: the last-created row (i=34) should be first.
    expect(result.closedSince?.rows[0]?.id).toBe('WI-closed-34');
  });

  // ---------------------------------------------------------------------------
  // EI-18820653360383242 — the regression guard for the defect this column exists
  // to end. A bulk write (a retag, a payload backfill, a sweep) moves updatedAt on
  // rows that closed weeks ago. Read that way, burn-down once reported 3,833 items
  // "closed in one hour" with terminal_owner NULL — indistinguishable from a real
  // fleet-scale mass unattributed close, and it cost two investigation cycles.
  //
  // A recent updatedAt must therefore NOT put a row in closedSince. And a row whose
  // close time is genuinely unknown (closed before migration 698) must be COUNTED
  // as undated rather than guessed at, so a reader can tell "nothing closed in this
  // window" apart from "this window predates the close stamp".
  // ---------------------------------------------------------------------------
  it('excludes a bulk-touched row with a recent updatedAt but no closedAt, and reports it as undated', () => {
    const result = buildBurnDownResult(
      [
        item({
          id: 'WI-bulk-touched',
          state: 'done',
          createdAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-07-05T20:29:00.000Z', // a sweep touched it just now
          closedAt: null, //                        but it actually closed long ago, time unknown
        }),
        item({
          id: 'WI-really-closed',
          state: 'done',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-05T20:20:00.000Z',
          closedAt: '2026-07-05T20:20:00.000Z',
        }),
      ],
      new Set(),
      { harness: 'papercusp', since: '2026-07-05T20:15:00.000Z' },
    );

    expect(result.closedSince?.rows.map((r) => r.id)).toEqual(['WI-really-closed']);
    expect(result.terminal.delta).toBe(1);
    // The undated row is neither counted nor silently dropped.
    expect(result.terminal.deltaClosedUndated).toBe(1);
  });

  it('derives live owners from non-stale fresh presence rows', () => {
    const live = liveOwnersFromPresence(
      [
        { ownerId: 'fresh', heartbeatAt: '2026-07-05T20:00:59.000Z' },
        { ownerId: 'old', heartbeatAt: '2026-07-05T19:59:00.000Z' },
        { ownerId: 'flagged-stale', heartbeatAt: '2026-07-05T20:00:59.000Z', stale: true },
        { ownerId: 'bad-date', heartbeatAt: 'not-a-date' },
      ],
      Date.parse('2026-07-05T20:01:00.000Z'),
    );
    expect([...live]).toEqual(['fresh']);
  });

  it('audits every fixed-cohort id with evidence verdict and reopen recommendation', () => {
    const verified = item({
      id: 'WI-verified',
      state: 'done',
      terminalOwner: 'su-1',
      terminalCompletionRef: 'sha:abc',
      terminalCompletionEvidence: {
        verifiedHow: 'unit',
        testsRun: 'npm test',
        testResult: '4/4 green',
      },
    });
    const committedWithoutRef = item({
      id: 'WI-committed-without-ref',
      state: 'done',
      terminalOwner: 'su-1',
      terminalCompletionRef: null,
      completionAuthority: 'committed',
      terminalCompletionEvidence: {
        verifiedHow: 'integration',
        testsRun: 'npm test',
        testResult: '8/8 green',
      },
    });
    const bare = item({
      id: 'WI-bare',
      state: 'resolved',
      terminalOwner: 'su-2',
      terminalCompletionRef: 'done assertion only',
      terminalCompletionEvidence: null,
    });
    const open = item({ id: 'WI-open', state: 'open', assignee: 'su-3' });
    const audit = buildCohortAudit(
      ['WI-verified', 'WI-committed-without-ref', 'WI-bare', 'WI-open', 'WI-missing'],
      [verified, committedWithoutRef, bare, open],
    );
    expect(audit).toMatchObject({ requested: 5, found: 4, missing: 1, reopenRecommended: 1 });
    expect(audit.rows).toEqual([
      expect.objectContaining({
        id: 'WI-verified', bucket: 'terminal', closureKind: 'done',
        evidenceVerdict: 'verified', completionRef: 'sha:abc', reopenRecommended: false,
      }),
      expect.objectContaining({
        id: 'WI-committed-without-ref', bucket: 'terminal', closureKind: 'done',
        evidenceVerdict: 'verified', completionRef: null, reopenRecommended: false,
      }),
      expect.objectContaining({
        id: 'WI-bare', bucket: 'terminal', closureKind: 'resolved',
        evidenceVerdict: 'missing', reopenRecommended: true,
      }),
      expect.objectContaining({
        id: 'WI-open', bucket: 'in-flight', closureKind: null,
        evidenceVerdict: 'not-applicable', reopenRecommended: false,
      }),
      expect.objectContaining({
        id: 'WI-missing', bucket: 'missing', title: null,
        evidenceVerdict: 'not-applicable', reopenRecommended: false,
      }),
    ]);
  });

  it('judges abandonment closes on their recorded disposition, not on verification evidence (WI-6554700010008454)', () => {
    const droppedWithReason = item({
      id: 'WI-dropped-reason',
      state: 'dropped',
      terminalOwner: 'su-1',
      completionAuthority: 'proposed',
      terminalCompletionRef: 'Obsolete on the current build: the subject path was removed',
      terminalCompletionEvidence: null,
    });
    const closedTriageReject = item({
      id: 'EI-closed-reject',
      state: 'closed',
      terminalOwner: 'Queen',
      completionAuthority: 'proposed',
      terminalCompletionRef: 'Triage decision: reject — replay succeeded on the serving build',
      terminalCompletionEvidence: null,
    });
    const droppedSilently = item({
      id: 'EI-dropped-silent',
      state: 'dropped',
      terminalOwner: 'system:work-item-admission-promoter',
      completionAuthority: null,
      terminalCompletionRef: '   ',
      terminalCompletionEvidence: null,
    });
    const resolvedAssertionOnly = item({
      id: 'WI-resolved-bare',
      state: 'resolved',
      terminalOwner: 'su-2',
      completionAuthority: 'proposed',
      terminalCompletionRef: 'fixed it',
      terminalCompletionEvidence: null,
    });
    const audit = buildCohortAudit(
      ['WI-dropped-reason', 'EI-closed-reject', 'EI-dropped-silent', 'WI-resolved-bare'],
      [droppedWithReason, closedTriageReject, droppedSilently, resolvedAssertionOnly],
    );
    expect(audit).toMatchObject({ requested: 4, found: 4, missing: 0, reopenRecommended: 2 });
    expect(audit.rows).toEqual([
      expect.objectContaining({
        id: 'WI-dropped-reason', closureKind: 'dropped', evidenceVerdict: 'disposition-recorded',
        reopenRecommended: false, recommendation: null,
      }),
      expect.objectContaining({
        id: 'EI-closed-reject', closureKind: 'closed', evidenceVerdict: 'disposition-recorded',
        reopenRecommended: false, recommendation: null,
      }),
      // A whitespace-only ref is not a disposition: the drop still has to say why.
      expect.objectContaining({
        id: 'EI-dropped-silent', closureKind: 'dropped', evidenceVerdict: 'missing',
        reopenRecommended: true,
        recommendation: expect.stringContaining('record the disposition'),
      }),
      // A resolved close claims a fix, so it still owes structured verification evidence.
      expect.objectContaining({
        id: 'WI-resolved-bare', closureKind: 'resolved', evidenceVerdict: 'missing',
        reopenRecommended: true,
        recommendation: expect.stringContaining('structured verification evidence'),
      }),
    ]);
  });

  it('wires the tool to list work-items and workspace-scoped presence', async () => {
    stubCensus([item({ id: 'WI-live', assignee: 'su-live' })]);
    mockListPresence.mockResolvedValue([
      {
        ownerId: 'su-live',
        ownerLabel: 'su live',
        heartbeatAt: new Date().toISOString(),
      } as never,
    ]);

    const res = await callTool({ harness: 'papercusp', includeChildren: true }, { workspaceId: 'ws-test' });

    // WI-6554700010008464: open rows are read uncapped and counted exactly; terminal rows
    // only as a bounded newest-first history slice.
    const selector = { harness: 'papercusp', kind: undefined, includeChildren: true };
    expect(mockCountWorkItems).toHaveBeenCalledWith({ ...selector, notTerminal: true });
    expect(mockListAllWorkItems).toHaveBeenCalledWith({ ...selector, notTerminal: true });
    expect(mockListWorkItems).toHaveBeenCalledWith({
      ...selector,
      states: [...ANY_FAMILY_TERMINAL_STATES],
      limit: 2000,
    });
    expect(mockCountWorkItemsByState).toHaveBeenCalledWith(selector);
    expect(mockListPresence).toHaveBeenCalledWith({ workspaceId: 'ws-test' });
    expect(res.data).toMatchObject({
      ok: true,
      harness: 'papercusp',
      counts: { total: 1, terminal: 0, inFlight: 1, parked: 0, unclaimed: 0 },
    });
  });

  it('attaches exact canonical drain flow for a since-bounded read by an active DRAIN caller', async () => {
    stubCensus([]);
    mockListPresence.mockResolvedValue([]);
    mockGetModes.mockResolvedValue([
      {
        workspaceId: 'ws-test',
        ownerId: 'su-drainer',
        axisKey: 'mission',
        mode: 'drain',
        reason: 'drain the queue',
        setBy: 'su-drainer',
        ownerDirected: true,
        setAt: '2026-08-13T08:00:00.000Z',
        subject: null,
        impliedBy: null,
      },
    ]);

    const res = await callTool(
      { harness: 'papercusp', since: '2026-08-13T09:00:00.000Z' },
      { workspaceId: 'ws-test', isSuperuser: true, uiClientId: 'su-drainer' },
    );

    expect(mockGetModes).toHaveBeenCalledWith('ws-test', 'su-drainer');
    expect(mockReadDrainFlow).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      harness: 'papercusp',
      ownerId: 'su-drainer',
      drainStartedAt: '2026-08-13T08:00:00.000Z',
    });
    expect(mockReadIssueOccurrenceCounts).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      since: '2026-08-13T09:00:00.000Z',
    });
    expect(res.data).toMatchObject({
      drainFlow: drainFlowReport,
      issueOccurrences: issueOccurrenceCounts,
    });
    expect((tool as unknown as { result: { safeParse: (value: unknown) => { success: boolean } } })
      .result.safeParse(res.data).success).toBe(true);
    expect(shapeBurnDown(res.data, 'trimmed')).toMatchObject({
      drainFlow: drainFlowReport,
      issueOccurrences: issueOccurrenceCounts,
    });
  });

  it('omits drain flow outside an active since-bounded DRAIN read', async () => {
    stubCensus([]);
    mockListPresence.mockResolvedValue([]);
    const ctx = { workspaceId: 'ws-test', isSuperuser: true, uiClientId: 'su-drainer' };

    const unbounded = await callTool({ harness: 'papercusp' }, ctx);
    expect((unbounded.data as { drainFlow?: unknown }).drainFlow).toBeUndefined();
    expect(mockGetModes).not.toHaveBeenCalled();

    const inactive = await callTool(
      { harness: 'papercusp', since: '2026-08-13T09:00:00.000Z' },
      ctx,
    );
    expect((inactive.data as { drainFlow?: unknown }).drainFlow).toBeUndefined();
    expect(mockGetModes).toHaveBeenCalledWith('ws-test', 'su-drainer');
    expect(mockReadDrainFlow).not.toHaveBeenCalled();
  });

  it('payload-tier shaping keeps a large census schema-valid and never inserts a string into row arrays', () => {
    const result = buildBurnDownResult(
      Array.from({ length: 2000 }, (_, index) =>
        item({
          id: `WI-live-${index}`,
          title: `long title ${'x'.repeat(240)}`,
          assignee: `su-${index}`,
          takenAt: '2026-08-11T20:00:00.000Z',
          updatedAt: '2026-08-11T20:00:00.000Z',
        }),
      ),
      new Set(),
      { harness: 'papercusp', since: '2026-08-11T18:48:00.000Z', rowLimit: 2000 },
    );
    const shaped = shapeBurnDown(result, 'trimmed', { limit: 2000 }) as Record<string, unknown>;
    const parsed = (tool as unknown as {
      result: { safeParse: (value: unknown) => { success: boolean; error?: unknown } };
    }).result.safeParse(shaped);

    expect(parsed.success).toBe(true);
    expect(JSON.stringify(shaped).length).toBeLessThan(30_000);
    expect(shaped.counts).toEqual(expect.objectContaining({ inFlight: 2000 }));
    expect(shaped.inFlight).toHaveLength(10);
    expect((shaped.inFlight as unknown[]).every((row) => row && typeof row === 'object')).toBe(true);
    expect((shaped.inFlight as unknown[]).some((row) => typeof row === 'string')).toBe(false);
    expect(shaped.textTruncated).toBe(true);
    expect((shaped.inFlight as Array<{ title: string }>)[0]?.title).toContain('[TRUNCATED');
    expect(shaped.presentation).toEqual(expect.objectContaining({
      tier: 'trimmed',
      rowCap: 10,
      rows: expect.objectContaining({
        inFlight: { shown: 10, total: 2000, truncated: true },
      }),
    }));
  });

  it('reports complete status partitions and overlapping scheduler causes through default and emergency transport', async () => {
    const resolution = fleetResolution('current-spec');
    resolution.claimSpec.current.view.filter = { field: 'kind', op: '=', value: 'bug' };
    const rows = Array.from({ length: 2001 }, (_, n) => item({ id: `WI-ready-${n}`, kind: 'bug', assignee: null }));
    rows.push(
      item({ id: 'WI-blocked', kind: 'bug', state: 'blocked', assignee: null, payload: {
        externalBlockers: [{ kind: 'event', status: 'active', ref: 'real-dependency', summary: 'Await dependency' }],
      } }),
      item({ id: 'WI-stale-human', kind: 'bug', state: 'needs-human', assignee: null, payload: { needsOwnerAction: true } }),
      item({ id: 'WI-review', kind: 'bug', assignee: null, payload: { agentReview: { status: 'pending' } } }),
      item({ id: 'WI-admission', kind: 'bug', assignee: null }),
      item({ id: 'WI-unknown', kind: 'bug', assignee: null }),
      item({ id: 'WI-overlap', kind: 'bug', assignee: null, payload: { _claimHold: true,
        agentReview: { status: 'revision-requested' } } }),
    );
    const reasons: Record<string, string[]> = {
      'WI-blocked': ['not-claimable-status', 'external-blocker'],
      'WI-stale-human': ['not-claimable-status', 'needs-owner-action'],
      'WI-review': ['agent-review'], 'WI-admission': ['admission-pending'],
      'WI-overlap': ['admission-pending', 'agent-review', 'claim-hold'],
    };
    const result = await buildFleetMetricsResult(resolution, rows, {
      sourceCapExhausted: false, issueOccurrences: issueOccurrenceCounts,
      explainFloors: async (_h, ids, options) => {
        expect(options?.includeAllFloors).toBe(true);
        expect(ids).toHaveLength(2007);
        return ids.filter(id => id !== 'WI-unknown').map(id => ({ id,
          admissible: !reasons[id], refusedBy: reasons[id]?.[0] ?? null,
          failedFloors: reasons[id] ?? [], detail: null,
        }));
      },
    });
    expect(result.ok).toBe(true); if (!result.ok) return;
    const categories = result.snapshot.remaining.categorization!;
    expect(result.snapshot.remaining.total).toBe(2007);
    expect(categories.stateCounts).toEqual({ open: 2005, blocked: 1, 'needs-human': 1 });
    expect(categories.primaryReasons).toEqual({ claimable: 2001, 'not-claimable-status': 2,
      'agent-review': 1, 'admission-pending': 2, unknown: 1 });
    expect(categories.exclusionCounts).toMatchObject({ 'agent-review': 2, 'admission-pending': 2,
      'claim-hold': 1, 'external-blocker': 1, 'needs-owner-action': 1 });
    expect(categories.exclusionsOverlap).toBe(true);
    expect(categories.floorCoverage).toEqual({ measured: 2006, unknown: 1 });
    expect(categories.exclusionCoverage).toEqual({ complete: 2006, firstReasonOnly: 0, unknown: 1 });
    expect(categories.evidenceGaps).toEqual({ humanWithoutStrictAsk: 1, blockedWithoutRecordedGate: 0 });
    expect(categories.explanation).toContain('2007 remaining; 2001 scheduler-claimable');
    expect(categories.explanation).toContain('2 agent review, 2 admission pending');
    const source = { ok: true, fleetMetrics: result };
    for (const shaped of [shapeLeaderBrief(source, 'trimmed'), shapeBurnDown(source, 'trimmed'),
      compactLeaderBriefForResultDoor(source)]) {
      expect(shaped).toMatchObject({ fleetMetrics: { snapshot: { remaining: { categorization: categories } } } });
    }
    const corrupt = (patch: object) => fleetMetricsResultSchema.safeParse({ ...result,
      snapshot: { ...result.snapshot, remaining: { ...result.snapshot.remaining,
        categorization: { ...categories, ...patch } } } }).success;
    expect(corrupt({ stateCounts: { open: 2007, blocked: 1 } })).toBe(false);
    expect(corrupt({ primaryReasons: { claimable: 2007, unknown: 1 } })).toBe(false);
    expect(corrupt({ floorCoverage: { measured: 2006, unknown: 0 } })).toBe(false);
    expect(corrupt({ exclusionCounts: { 'agent-review': 2008 } })).toBe(false);
  });

  it('keeps full-population stage waits, overlapping controls and release actions through leader shaping', async () => {
    const resolution = fleetResolution('current-spec');
    resolution.claimSpec.current.view.filter = { field: 'kind', op: '=', value: 'bug' };
    const rows = Array.from({ length: 2002 }, (_, n) => item({ id: `WI-health-${n}`, kind: 'bug',
      assignee: 'member-live', createdAt: FLEET_START, payload: {
        _claimHold: true, claim_hold_by: 'su-parker', claim_hold_reason: 'until key supplied', claim_hold_at: FLEET_START,
        held_open_by: 'member-live', held_open_at: FLEET_START,
        agentReview: { status: 'pending', submittedBy: 'su-author', ledgerIdeaId: `idea-${n}`, round: 2,
          timing: { round: 2, enteredAt: FLEET_REVISION_AT } },
      } }));
    // A late, legacy row makes the oldest review wait unknown even after 2000 valid rows.
    (rows[2001].payload as Record<string, unknown>).agentReview = {
      status: 'pending', submittedBy: 'su-author', ledgerIdeaId: 'legacy', round: 1 };
    const result = await buildFleetMetricsResult(resolution, rows, {
      sourceCapExhausted: false, issueOccurrences: issueOccurrenceCounts,
      explainFloors: async (_h, ids) => ids.map(id => ({ id, admissible: false, refusedBy: 'claim-hold', detail: null })),
    });
    expect(result.ok).toBe(true); if (!result.ok) return;
    const health = result.snapshot.queueHealth!;
    expect(health.population).toBe(2002);
    expect(health.waiting.reviewWait).toMatchObject({ population: 2002, known: 2001, unknown: 1, oldestMs: null,
      oldestKnownMs: Date.parse(FLEET_END) - Date.parse(FLEET_REVISION_AT) });
    expect(health.controls).toMatchObject({ activeClaims: 2002, durableParks: 2002, holdOpenLeases: 2002 });
    expect(health.controlsOverlap).toBe(true);
    expect(health.releaseConditions.flagged).toBe(2002);
    expect(health.releaseConditions.nextAction).toBeTruthy();
    expect(health.releaseConditions.examples).toMatchObject({ total: 2002, omitted: 1992 });
    expect(health.releaseConditions.examples.rows).toHaveLength(10);
    expect(health.releaseConditions.examples.rows[0]).toMatchObject({
      parker: 'su-parker', clearer: null, trigger: null, ageSource: 'payload.claim_hold_at',
      recheck: expect.stringContaining('No recheck trigger recorded'),
    });
    const shaped = shapeLeaderBrief({ ok: true, fleetMetrics: result }, 'trimmed') as { fleetMetrics: typeof result };
    expect(shaped.fleetMetrics.snapshot.queueHealth).toEqual(health);
    expect(Object.values(result.snapshot.remaining.buckets).reduce((a, b) => a + b, 0)).toBe(2002);
    expect(fleetMetricsResultSchema.safeParse({ ...result, snapshot: { ...result.snapshot,
      queueHealth: { ...health, population: 2000 } } }).success).toBe(false);
    expect(fleetMetricsResultSchema.safeParse({ ...result, snapshot: { ...result.snapshot,
      queueHealth: { ...health, waiting: { ...health.waiting,
        reviewWait: { ...health.waiting.reviewWait, oldestMs: 0 } } } } }).success).toBe(false);
    expect(fleetMetricsResultSchema.safeParse({ ...result, snapshot: { ...result.snapshot,
      queueHealth: { ...health, releaseConditions: { ...health.releaseConditions,
        examples: { ...health.releaseConditions.examples, omitted: 0 } } } } }).success).toBe(false);
  });

  // SPEC-BQL-P-004-CLEARER: every durable park in the census carries an accountable next action
  // and a recheck. That includes the broad-trigger 'satisfied' stamp the WAKE guard downgrades:
  // it must route to contract repair, never to "reconcile now".
  it('SPEC-BQL-P-004-CLEARER: routes missing, unreachable, broad-satisfied, specific-satisfied and tracked parks to distinct owned actions', async () => {
    const resolution = fleetResolution('current-spec');
    resolution.claimSpec.current.view.filter = { field: 'kind', op: '=', value: 'bug' };
    const park = (id: string, release?: Record<string, unknown>) => item({ id, kind: 'bug',
      assignee: 'member-live', createdAt: FLEET_START, payload: {
        _claimHold: true, claim_hold_by: 'su-parker', claim_hold_reason: 'parked pending condition',
        claim_hold_at: FLEET_START, ...(release ? { claim_hold_release: release } : {}),
      } });
    const contract = { condition: 'the dependency reaches a terminal state', owner: 'su-clearer',
      evidence: 'resolver evidence' };
    const rows = [
      park('WI-clear-missing'),
      park('WI-clear-unreachable', { ...contract, trigger: 'work-item:done:WI-dep', reachability: 'unreachable' }),
      park('WI-clear-broad', { ...contract, trigger: 'coord:inbox-wake:su-parker', reachability: 'satisfied' }),
      park('WI-clear-specific', { ...contract, trigger: 'work-item:done:WI-dep', reachability: 'satisfied' }),
      park('WI-clear-tracked', { ...contract, trigger: 'work-item:done:WI-dep', reachability: 'reachable' }),
      // A park released only by its own completion is a reservation, never a reachable release.
      park('WI-clear-self', { ...contract, trigger: 'work-item:done:WI-clear-self', reachability: 'reachable' }),
    ];
    const result = await buildFleetMetricsResult(resolution, rows, {
      sourceCapExhausted: false, issueOccurrences: issueOccurrenceCounts,
      explainFloors: async (_h, ids) => ids.map(id => ({ id, admissible: false, refusedBy: 'claim-hold', detail: null })),
    });
    expect(result.ok).toBe(true); if (!result.ok) return;
    const examples = result.snapshot.queueHealth!.releaseConditions.examples;
    expect(examples).toMatchObject({ total: 6, omitted: 0 });
    const byId = new Map(examples.rows.map(row => [row.id, row]));
    expect(byId.get('WI-clear-missing')).toMatchObject({ clearer: null, trigger: null,
      nextAction: expect.stringContaining('Repair the missing or unverified release contract'),
      recheck: expect.stringContaining('No recheck trigger recorded') });
    expect(byId.get('WI-clear-unreachable')).toMatchObject({ clearer: 'su-clearer', reachability: 'unreachable',
      nextAction: expect.stringContaining('Escalate or reframe'),
      recheck: expect.stringContaining('work-item:done:WI-dep') });
    // The WAKE downgrade: a generic inbox wake is not condition proof, so this park is repair work.
    const broad = byId.get('WI-clear-broad')!;
    expect(broad).toMatchObject({ clearer: 'su-clearer', reachability: 'blocked',
      nextAction: expect.stringContaining('Repair the missing or unverified release contract') });
    expect(broad.findings).toContain('reachability-unverified');
    expect(broad.nextAction).not.toContain('Reconcile');
    expect(byId.get('WI-clear-specific')).toMatchObject({ clearer: 'su-clearer', reachability: 'satisfied',
      nextAction: expect.stringContaining('Reconcile this park with condition evidence') });
    expect(byId.get('WI-clear-tracked')).toMatchObject({ clearer: 'su-clearer', reachability: 'reachable',
      nextAction: expect.stringContaining('Retain the park') });
    expect(byId.get('WI-clear-self')).toMatchObject({ clearer: 'su-clearer', reachability: 'blocked',
      nextAction: expect.stringContaining('Repair the missing or unverified release contract') });
    for (const row of examples.rows) {
      expect(row.nextAction.length).toBeGreaterThan(0);
      expect(row.recheck.length).toBeGreaterThan(0);
    }
  });

  it('names only a runnable independent verifier as the clearer of an overdue round', async () => {
    const resolution = fleetResolution('current-spec');
    resolution.claimSpec.current.lane = 'verification';
    resolution.claimSpec.current.view.filter = { field: 'kind', op: '=', value: 'bug' };
    const rows = ['su-author', 'member-live'].map((submittedBy, n) => item({
      id: `WI-review-action-${n}`, kind: 'bug', assignee: 'member-live', payload: {
        agentReview: { status: 'pending', submittedBy, ledgerIdeaId: `idea-${n}`, round: 1,
          timing: { round: 1, enteredAt: FLEET_START } },
      },
    }));
    const result = await buildFleetMetricsResult(resolution, rows, {
      sourceCapExhausted: false, issueOccurrences: issueOccurrenceCounts,
      explainFloors: async (_h, ids) => ids.map(id => ({ id, admissible: false, refusedBy: 'agent-review', detail: null })),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.snapshot.queueHealth?.overdueReview.examples).toMatchObject({ total: 2, omitted: 0,
      rows: [
        { id: rows[0].id, clearer: 'member-live', nextAction: expect.stringContaining('record a review outcome') },
        { id: rows[1].id, clearer: null, nextAction: expect.stringContaining('author cannot approve') },
      ],
    });
  });

  it('applies report precedence to concurrent floors beyond the primary claim refusal', async () => {
    const resolution = fleetResolution('current-spec');
    resolution.claimSpec.current.view.filter = { field: 'kind', op: '=', value: 'bug' };
    const rows = [
      item({ id: 'WI-mixed-dependency', kind: 'bug', payload: { _claimHold: true } }),
      item({ id: 'WI-mixed-owner', kind: 'bug', assignee: 'member-live' }),
      item({ id: 'WI-mixed-review', kind: 'bug', payload: { _claimHold: true } }),
    ];
    const explainFloors = vi.fn(async () => [
      { id: rows[0].id, admissible: false, refusedBy: 'claim-hold', detail: null,
        failedFloors: ['claim-hold', 'blocked-dep'] },
      { id: rows[1].id, admissible: false, refusedBy: 'already-taken', detail: null,
        failedFloors: ['already-taken', 'needs-owner-action'] },
      { id: rows[2].id, admissible: false, refusedBy: 'agent-review', detail: null,
        failedFloors: ['agent-review', 'claim-hold'] },
    ]);
    const result = await buildFleetMetricsResult(resolution, rows, {
      sourceCapExhausted: false, issueOccurrences: issueOccurrenceCounts, explainFloors,
    });
    expect(explainFloors).toHaveBeenCalledWith('papercusp', rows.map(row => row.id),
      { assignee: undefined, includeAllFloors: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.snapshot.remaining.buckets).toEqual({
      needsHuman: 1, blocked: 1, claimHeld: 1, inFlight: 0, claimable: 0, otherUnclaimable: 0,
    });
  });

  it('reads review service with the same current spec, runnable workers, window and complete selected ids', async () => {
    const resolution = fleetResolution('current-spec'); resolution.claimSpec.current.lane = 'verification';
    const reader = vi.fn(async (scope) => ({ status: 'known' as const, ...computeAgentReviewService(scope, [], []) }));
    const result = await buildFleetMetricsResult(resolution, fleetMetricItems(), {
      sourceCapExhausted: false, issueOccurrences: issueOccurrenceCounts, workspaceId: 'ws-test',
      explainFloors: async () => [], readReviewService: reader,
    });
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-test', harnessSlug: 'papercusp',
      verifierIds: ['member-live'], sinceMs: Date.parse(FLEET_START), nowMs: Date.parse(FLEET_END),
      verificationSpecs: [{ specId: 'fleet-lane', revision: 2 }] }), { itemIds: ['WI-new', 'WI-remaining'] });
    expect(result.ok && result.snapshot.queueHealth?.verificationService).toMatchObject({ status: 'known', workers: 1 });
    reader.mockRejectedValueOnce(new Error('service ledger unavailable'));
    const unknown = await buildFleetMetricsResult(resolution, fleetMetricItems(), {
      sourceCapExhausted: false, issueOccurrences: issueOccurrenceCounts, workspaceId: 'ws-test',
      explainFloors: async () => [], readReviewService: reader,
    });
    expect(unknown.ok && unknown.snapshot.queueHealth?.verificationService).toEqual({ status: 'unknown',
      reason: 'service ledger unavailable', recoverVia: expect.any(String) });
  });

  it('builds an exact current-spec fleet snapshot and keeps observations, occurrences, and canonical bugs separate', async () => {
    const result = await buildFleetMetricsResult(fleetResolution('current-spec'), fleetMetricItems(), {
      issueOccurrences: issueOccurrenceCounts,
      sourceCapExhausted: false,
      explainFloors: async (_harness, ids) =>
        ids.map((id) => ({ id, admissible: true, refusedBy: null, detail: null })),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.scope.flow).toMatchObject({ mode: 'current-spec', revision: 2 });
    expect(result.snapshot.populationLifecycle).toMatchObject({
      schemaVersion: 'fleet-population-lifecycle-v1',
      fleet: 'fleet-a',
      currentRunnableRoster: { ownerIds: ['member-live'] },
      everMembers: { counted: 2, ownerIds: ['member-dead', 'member-live'] },
    });
    expect(result.snapshot.quality.exactness).toEqual({ status: 'exact', sourceCap: null });
    expect(result.snapshot.flow).toMatchObject({
      opened: 2,
      terminalLifecycle: 1,
      terminalCounted: 1,
      netLifecycle: 1,
      netCounted: 1,
      openedBy: { fleet: 1, otherAgents: 1, system: 0, unattributed: 0 },
      terminalBy: { fleet: 1, otherAgents: 0, system: 0, unattributed: 0 },
    });
    expect(result.snapshot.remaining).toMatchObject({
      total: 1,
      buckets: { needsHuman: 0, blocked: 0, claimHeld: 0, inFlight: 1, claimable: 0, otherUnclaimable: 0 },
    });
    expect(result.snapshot.authority).toMatchObject({
      lifecycleTerminal: 1,
      counted: 1,
      committed: 1,
      legacy: 0,
    });
    expect(result.snapshot.issueUnits).toMatchObject({
      canonicalBugs: 2,
      observations: 1,
      occurrences: 5,
      duplicateOccurrences: 3,
      separateUnits: true,
    });
    // R-32/R-33: legacy terminal claims remain lifecycle metrics, not verified
    // accepted delivery, and observation/occurrence units cannot inflate bugs.
    expect(result.snapshot.intakeStages).toMatchObject({
      population: 3, remainingBugs: 0, verifiedCompletions: 0,
      scope: 'current-spec issue-family rows including observation evidence',
      window: 'current stock at generatedAt', unit: 'work-item rows',
      counts: { observation: 1, unknown: 1, 'terminal-other': 1 },
    });
  });

  it('overlaps claim-floor attribution with a pending occurrence census', async () => {
    let occurrenceResolved = false;
    let resolveOccurrences!: (value: IssueOccurrenceCounts) => void;
    const occurrencePromise = new Promise<IssueOccurrenceCounts>((resolve) => {
      resolveOccurrences = (value) => {
        occurrenceResolved = true;
        resolve(value);
      };
    });
    let floorsStarted = false;
    let releaseFloors!: () => void;
    const explainFloors = vi.fn(async (_harness: string, ids: readonly string[]) => {
      floorsStarted = true;
      await new Promise<void>((resolve) => {
        releaseFloors = resolve;
      });
      return ids.map((id) => ({ id, admissible: true, refusedBy: null, detail: null }));
    });

    const resultPromise = buildFleetMetricsResult(fleetResolution('current-spec'), fleetMetricItems(), {
      issueOccurrences: occurrencePromise,
      sourceCapExhausted: false,
      explainFloors,
    });

    await Promise.resolve();
    expect(floorsStarted).toBe(true);
    expect(occurrenceResolved).toBe(false);
    resolveOccurrences(issueOccurrenceCounts);
    releaseFloors();

    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.issueUnits).toMatchObject({ occurrences: 5, duplicateOccurrences: 3 });
  });

  it('builds exact at-event-spec flow from the revision effective at each lifecycle event while stock stays current-spec', async () => {
    const result = await buildFleetMetricsResult(fleetResolution('at-event-spec'), fleetMetricItems(), {
      issueOccurrences: issueOccurrenceCounts,
      sourceCapExhausted: false,
      explainFloors: async (_harness, ids) =>
        ids.map((id) => ({ id, admissible: true, refusedBy: null, detail: null })),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.scope.flow).toMatchObject({
      mode: 'at-event-spec',
      revision: 'effective-at-event',
      missingRevision: 'unavailable-never-current-fallback',
    });
    expect(result.snapshot.flow).toMatchObject({
      opened: 3,
      terminalLifecycle: 2,
      terminalCounted: 2,
      netLifecycle: 1,
      netCounted: 1,
      openedBy: { fleet: 2, otherAgents: 1, system: 0, unattributed: 0 },
      terminalBy: { fleet: 2, otherAgents: 0, system: 0, unattributed: 0 },
    });
    expect(result.snapshot.remaining).toMatchObject({ total: 1, buckets: { inFlight: 1 } });
    expect(result.snapshot.authority).toMatchObject({
      lifecycleTerminal: 2,
      counted: 2,
      committed: 1,
      legacy: 1,
    });
    expect(result.snapshot.issueUnits).toMatchObject({ canonicalBugs: 2, observations: 1 });
  });

  it('reads the complete fleet census before filtering and keeps a matching row beyond 2000', async () => {
    const sourceRows = [
      ...Array.from({ length: WORK_ITEMS_MAX_LIMIT + 1 }, (_, index) =>
        item({
          id: `WI-excluded-${index}`,
          kind: 'bug',
          createdAt: '2026-08-21T06:00:00.000Z',
          updatedAt: '2026-08-21T06:00:00.000Z',
        }),
      ),
      item({
        id: 'WI-new',
        kind: 'bug',
        state: 'done',
        createdBy: 'member-live',
        terminalOwner: 'member-live',
        completionAuthority: 'committed',
        createdAt: '2026-08-21T06:00:00.000Z',
        updatedAt: '2026-08-21T08:00:00.000Z',
        closedAt: '2026-08-21T08:00:00.000Z',
      }),
    ];
    // The ordinary display census cannot see the last matching row. Fleet metrics
    // must still include it through the uncapped internal reader.
    stubCensus(sourceRows.slice(0, WORK_ITEMS_MAX_LIMIT));
    // WI-6554700010008464: the display census reads the OPEN partition (notTerminal) through
    // this reader; whole-harness hydration for fleet metrics stays forbidden.
    const openCensus = mockListAllWorkItems.getMockImplementation()!;
    mockListAllWorkItems.mockImplementation(async (filter = {}) => {
      if (!filter.notTerminal) throw new Error('whole-harness metric hydration is forbidden');
      return openCensus(filter);
    });
    mockReadFleetMetricSource.mockResolvedValue({ items: sourceRows, terminalContributions: Promise.resolve([]) });
    mockListPresence.mockResolvedValue([]);
    mockResolveFleetMetricScope.mockResolvedValue(fleetResolution('current-spec'));

    const res = await callTool(
      { harness: 'papercusp', fleet: 'fleet-a', window: 'fleet-lifetime' },
      { workspaceId: 'ws-test', isSuperuser: true, uiClientId: 'su-leader' },
    );
    const data = res.data as {
      fleetMetrics: Awaited<ReturnType<typeof buildFleetMetricsResult>>;
    };

    expect(mockResolveFleetMetricScope).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      harness: 'papercusp',
      fleet: 'fleet-a',
      flowMode: 'current-spec',
    });
    expect(mockReadFleetMetricSource).toHaveBeenCalledWith(fleetResolution('current-spec'));
    expect(data.fleetMetrics.ok).toBe(true);
    if (!data.fleetMetrics.ok) return;
    expect(data.fleetMetrics.snapshot.flow).toMatchObject({ opened: 1, terminalLifecycle: 1 });
    expect(data.fleetMetrics.snapshot.quality.exactness).toEqual({ status: 'exact', sourceCap: null });
    expect(shapeBurnDown(res.data, 'trimmed')).toMatchObject({
      fleetMetrics: {
        ok: true,
        snapshot: {
          quality: { exactness: { status: 'exact' } },
          intakeStages: data.fleetMetrics.snapshot.intakeStages,
        },
      },
    });
  });

  it('returns an explicit unavailable metric block without hydrating an unresolved population', async () => {
    stubCensus([]);
    mockListPresence.mockResolvedValue([]);
    mockResolveFleetMetricScope.mockResolvedValue({
      ok: false,
      schemaVersion: FLEET_METRICS_SCHEMA_VERSION,
      error: 'fleet_metrics_unavailable',
      reason: 'claim-spec history unavailable',
      recoverVia: 'restore the canonical historical revision',
      requested: { fleet: 'fleet-a', harness: 'papercusp', flowMode: 'current-spec', window: 'fleet-lifetime' },
    });
    const res = await callTool(
      { harness: 'papercusp', fleet: 'fleet-a', window: 'fleet-lifetime' },
      { workspaceId: 'ws-test', isSuperuser: true, uiClientId: 'su-leader' },
    );
    expect(res.data).toMatchObject({ fleetMetrics: {
      ok: false, error: 'fleet_metrics_unavailable', reason: 'claim-spec history unavailable',
    } });
    expect(mockReadFleetMetricSource).not.toHaveBeenCalled();
    // The open-partition census read (notTerminal) is not metric hydration.
    expect(mockListAllWorkItems.mock.calls.filter(([filter]) => !filter?.notTerminal)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // WI-37381 — the recurrence guard for the defect this fix ends: `limit` used to
  // bound the FETCH that terminal.*/counts.* were computed from, so a small `limit`
  // (e.g. 5) could report terminal.total 0 / deltaBy.fleet 0 for a queue with 1693
  // real terminal rows. `limit` must bound only the returned row lists.
  // ---------------------------------------------------------------------------
  it('WI-37381: `limit` never bounds the aggregate fetch — the census always uses WORK_ITEMS_MAX_LIMIT', async () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => item({ id: `WI-done-${i}`, state: 'done' })),
      ...Array.from({ length: 4 }, (_, i) => item({ id: `WI-live-${i}`, assignee: `su-${i}` })),
    ];
    stubCensus(items);
    mockListPresence.mockResolvedValue([]);

    const res = await callTool({ harness: 'papercusp', limit: 2 });

    // The underlying fetch is NEVER bounded by the caller's `limit` — always the hard cap.
    expect(mockListWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ limit: WORK_ITEMS_MAX_LIMIT }),
    );

    const data = res.data as {
      terminal: { total: number; truncatedByLimit: boolean; censusLimit: number };
      counts: { total: number; terminal: number; inFlight: number };
      inFlight: unknown[];
    };
    // Aggregate counts reflect the TRUE bucket sizes — a limit:2 request must not zero
    // (or otherwise shrink) terminal.total / counts.*, the exact bug this guards.
    expect(data.terminal.total).toBe(6);
    expect(data.counts).toMatchObject({ total: 10, terminal: 6, inFlight: 4 });
    expect(data.terminal.truncatedByLimit).toBe(false);
    // WI-6554700010008464: the census limit is now the open-partition read ceiling; either
    // way it is never the caller's `limit`.
    expect(data.terminal.censusLimit).toBe(NON_TERMINAL_CENSUS_CEILING);
    expect(mockListAllWorkItems).toHaveBeenCalledWith(expect.not.objectContaining({ limit: 2 }));
    // `limit` DOES bound the returned row list (display only).
    expect(data.inFlight).toHaveLength(2);
  });

  it('WI-37381: buildBurnDownResult — rowLimit caps only inFlight/parked/unclaimed row arrays, never their counts', () => {
    const result = buildBurnDownResult(
      [
        item({ id: 'WI-1', assignee: 'su-1' }),
        item({ id: 'WI-2', assignee: 'su-2' }),
        item({ id: 'WI-3', assignee: 'su-3' }),
      ],
      new Set(),
      { harness: 'papercusp', rowLimit: 1 },
    );
    expect(result.inFlight).toHaveLength(1);
    expect(result.counts.inFlight).toBe(3);
  });

  it('WI-37381: buildBurnDownResult — censusLimit/truncatedByLimit are decoupled from rowLimit and reflect the real fetch size', () => {
    const untruncated = buildBurnDownResult([item({ id: 'WI-done', state: 'done' })], new Set(), {
      harness: 'papercusp',
      censusLimit: 2000,
    });
    expect(untruncated.terminal).toMatchObject({ censusLimit: 2000, truncatedByLimit: false });

    // items.length (1) >= censusLimit (1) — the fetch itself hit its cap, so the
    // aggregate may still be an undercount even though the caller passed no `limit`.
    const truncated = buildBurnDownResult([item({ id: 'WI-done', state: 'done' })], new Set(), {
      harness: 'papercusp',
      censusLimit: 1,
    });
    expect(truncated.terminal).toMatchObject({ censusLimit: 1, truncatedByLimit: true });

    // No censusLimit passed (the fixed `ids`-cohort path) — never reported as truncated.
    const cohort = buildBurnDownResult([item({ id: 'WI-done', state: 'done' })], new Set(), {
      harness: 'papercusp',
    });
    expect(cohort.terminal.truncatedByLimit).toBe(false);
  });

  it('loads an exact ID cohort and returns one audit row per requested ID', async () => {
    mockGetWorkItem.mockImplementation(async (id) =>
      id === 'WI-found'
        ? item({
            id,
            state: 'closed',
            terminalCompletionRef: 'ref',
            terminalOwner: 'su-1',
            terminalCompletionEvidence: { verifiedHow: 'manual', testsRun: 'probe', testResult: 'ok' },
          })
        : null,
    );
    mockListPresence.mockResolvedValue([]);

    const res = await callTool({ harness: 'papercusp', ids: ['WI-found', 'WI-missing', 'WI-found'] });

    expect(mockListWorkItems).not.toHaveBeenCalled();
    expect(mockGetWorkItem).toHaveBeenCalledTimes(2);
    expect(mockGetWorkItem).toHaveBeenCalledWith('WI-found', 'papercusp');
    expect(res.data).toMatchObject({
      counts: { total: 1, terminal: 1 },
      cohortAudit: { requested: 2, found: 1, missing: 1, reopenRecommended: 0 },
    });
  });

  it('keeps fixed-cohort completion distinct from live-census emptiness and refuses their cutoff mismatch', async () => {
    mockGetWorkItem.mockImplementation(async (id) =>
      item({
        id,
        state: 'done',
        terminalCompletionRef: `ref:${id}`,
        terminalOwner: 'su-1',
        terminalCompletionEvidence: { verifiedHow: 'unit', testsRun: 'vitest', testResult: 'green' },
      }),
    );
    mockListPresence.mockResolvedValue([]);
    const fixed = await callTool({
      harness: 'papercusp',
      ids: ['WI-a', 'WI-b'],
      cohortCutoff: {
        field: 'createdAt',
        operator: '<',
        value: '2026-08-30T00:00:00.000Z',
      },
    });

    stubCensus([]);
    const live = await callTool({ harness: 'papercusp' });
    const fixedData = fixed.data as Record<string, any>;
    const liveData = live.data as Record<string, any>;
    const fixedNonTerminal = materializeCountEvidence(fixedData.countEvidence, 'nonTerminal');
    const liveNonTerminal = materializeCountEvidence(liveData.countEvidence, 'nonTerminal');

    expect(fixedData.countEvidence.populationState).toEqual(expect.objectContaining({
      kind: 'fixed-cohort',
      fixedCohortComplete: true,
      liveOpenPopulationEmpty: null,
      missingIds: 0,
    }));
    expect(liveData.countEvidence.populationState).toEqual(expect.objectContaining({
      kind: 'live-census',
      fixedCohortComplete: null,
      liveOpenPopulationEmpty: true,
      missingIds: null,
    }));
    expect(fixedNonTerminal).toMatchObject({
      value: 0,
      contract: {
        population: { id: 'fixed-work-item-id-cohort' },
        cutoff: { kind: 'predicate', field: 'createdAt', operator: '<' },
      },
    });
    expect(liveNonTerminal).toMatchObject({
      value: 0,
      contract: {
        population: { id: 'current-harness-work-item-census' },
        cutoff: { kind: 'none' },
      },
    });
    const comparison = compareCountEvidence(fixedNonTerminal, liveNonTerminal);
    expect(comparison).toMatchObject({ comparable: false, delta: null });
    expect(comparison.mismatches.map((mismatch) => mismatch.path)).toEqual(
      expect.arrayContaining(['population.id', 'cutoff.kind', 'scope.populationMode']),
    );
    expect(shapeBurnDown(fixed.data, 'trimmed')).toMatchObject({
      countEvidence: { populationState: { kind: 'fixed-cohort', fixedCohortComplete: true } },
    });
  });

  it('rejects cohortCutoff without exact cohort ids instead of filtering a live census implicitly', () => {
    const parsed = (tool as unknown as { args: { safeParse: (value: unknown) => { success: boolean } } })
      .args.safeParse({
        harness: 'papercusp',
        cohortCutoff: { field: 'createdAt', operator: '<', value: '2026-08-30T00:00:00.000Z' },
      });
    expect(parsed.success).toBe(false);
  });

  // EI-19313376980892266 fix B — PROVENANCE ON A DERIVED NUMBER.
  // `terminal.delta` is harness-WIDE. Read as one fleet's output it over-reports by
  // whatever the rest of the harness closed; that misread put ~30 closes/hour in front
  // of an owner when the reporting fleet's real figure was ~6.6.
  describe('terminal.deltaBy — attribution of the burn-down delta', () => {
    const since = '2026-07-05T20:00:00.000Z';
    const closedAt = '2026-07-05T20:30:00.000Z';
    const fleetScope = {
      slug: 'my-fleet',
      members: new Set(['su-mine-alive', 'su-mine-DEAD']),
      source: 'arg' as const,
    };
    const mixedCohort = [
      item({ id: 'WI-1', state: 'done', closedAt, terminalOwner: 'su-mine-alive' }),
      // The member that has since DIED. A live-presence basis drops exactly this row —
      // the 55%-under-report measured on a real fleet (708 ever vs 318 live).
      item({ id: 'WI-2', state: 'done', closedAt, terminalOwner: 'su-mine-DEAD' }),
      item({ id: 'WI-3', state: 'resolved', closedAt, terminalOwner: 'su-someone-else' }),
      item({ id: 'WI-4', state: 'done', closedAt, terminalOwner: 'system:plan-item-reconcile' }),
      // No `system:` prefix and no constant anywhere — a membership-only classifier
      // misfiles this as an agent (42 such closes in 30 days, measured).
      item({ id: 'WI-5', state: 'resolved', closedAt, terminalOwner: 'watchdog-green-resolve' }),
      item({ id: 'WI-6', state: 'done', closedAt, terminalOwner: null }),
    ];

    it('splits the delta by fleet / other agents / system / unattributed', () => {
      const r = buildBurnDownResult(mixedCohort, new Set(['su-mine-alive']), {
        harness: 'papercusp',
        since,
        fleet: fleetScope,
      });

      expect(r.terminal.delta).toBe(6);
      expect(r.terminal.deltaBy).toMatchObject({
        fleet: 2,
        otherAgents: 1,
        system: 2,
        unattributed: 1,
      });
    });

    it('counts a fleet member that is DEAD — attribution is ever-members, not live presence', () => {
      // The whole point of the ledger basis: `liveOwners` deliberately contains only the
      // one live member, yet BOTH members' closes must be credited to the fleet.
      const r = buildBurnDownResult(mixedCohort, new Set(['su-mine-alive']), {
        harness: 'papercusp',
        since,
        fleet: fleetScope,
      });
      expect(r.terminal.deltaBy?.fleet).toBe(2);
      expect(r.terminal.deltaBy?.basis.membership).toBe('ever-members');
    });

    it('classifies un-prefixed watchdog identities as system, not as an agent', () => {
      const r = buildBurnDownResult(
        [item({ id: 'WI-w', state: 'done', closedAt, terminalOwner: 'watchdog-green-resolve' })],
        new Set(),
        { harness: 'papercusp', since, fleet: fleetScope },
      );
      expect(r.terminal.deltaBy).toMatchObject({ system: 1, otherAgents: 0 });
    });

    it('keeps unattributed closes OUT of system — they are different facts', () => {
      // Folding a null terminal_owner into `system` would hide the mass-unattributed-close
      // signature EI-18820653360383242 exists to keep visible.
      const r = buildBurnDownResult(
        [item({ id: 'WI-n', state: 'done', closedAt, terminalOwner: null })],
        new Set(),
        { harness: 'papercusp', since, fleet: fleetScope },
      );
      expect(r.terminal.deltaBy).toMatchObject({ unattributed: 1, system: 0 });
    });

    // THE FALSIFIER for the whole field: if these four ever stop summing to `delta`,
    // the split is silently lying about a total it claims to partition.
    it('PARTITIONS delta exactly — the four buckets always sum to it', () => {
      for (const fleet of [fleetScope, null]) {
        const r = buildBurnDownResult(mixedCohort, new Set(), {
          harness: 'papercusp',
          since,
          fleet,
        });
        const d = r.terminal.deltaBy!;
        expect((d.fleet ?? 0) + d.otherAgents + d.system + d.unattributed).toBe(r.terminal.delta);
        expect(r.terminal.deltaByPartitions).toBe(true);
      }
    });

    it('reports fleet as NULL (never 0) when no fleet is in scope', () => {
      // 0 asserts "the fleet closed nothing" — a fabricated verdict from a failed or
      // absent lookup. null says "no fleet was resolved", which is the actual fact.
      const r = buildBurnDownResult(mixedCohort, new Set(), {
        harness: 'papercusp',
        since,
        fleet: null,
      });
      expect(r.terminal.deltaBy?.fleet).toBeNull();
      expect(r.terminal.deltaBy?.basis.fleet).toBeNull();
      expect(r.terminal.deltaBy?.basis.note).toMatch(/no fleet in scope/i);
      // With no fleet, every agent close lands in otherAgents rather than vanishing.
      expect(r.terminal.deltaBy?.otherAgents).toBe(3);
    });

    it('is absent without `since` — there is no delta to attribute', () => {
      const r = buildBurnDownResult(mixedCohort, new Set(), { harness: 'papercusp' });
      expect(r.terminal.deltaBy).toBeUndefined();
      expect(r.terminal.deltaByPartitions).toBeUndefined();
    });

    it('names the scoping that produced the split', () => {
      const r = buildBurnDownResult(mixedCohort, new Set(), {
        harness: 'papercusp',
        since,
        fleet: fleetScope,
      });
      expect(r.terminal.deltaBy?.basis).toMatchObject({
        fleet: 'my-fleet',
        fleetSource: 'arg',
        membership: 'ever-members',
        memberCount: 2,
      });
    });
  });
});

/**
 * P-011 (fleet-lead-instrumentation-audit-2026-08-09) — the drain leader measured
 * burn-down by hand-rolling SQL with a hand-maintained p2p title regex re-typed
 * into every query, because the real metric (terminal transitions) lived here and
 * this tool could not express a LANE. The property under test is that the fence
 * applied here is the CLAIM PATH's fence, not a second copy of it.
 */
describe('applyLaneFence (P-011) — burn-down scoped to the lane the fleet may claim from', () => {
  it('excludes p2p work and keeps local work, counting what it removed', () => {
    const items = [
      item({ id: 'WI-p1', title: 'hypercore session leaks a handle' }),
      item({ id: 'WI-p2', title: 'autobase view rebuild is quadratic' }),
      item({ id: 'WI-l1', title: 'operator restart drops the pending cut' }),
      item({ id: 'WI-l2', title: 'plans:get returns a stale contentHash' }),
    ];
    const { rows, report } = applyLaneFence(items, 'p2p-lane');
    expect(rows.map((r) => r.id)).toEqual(['WI-l1', 'WI-l2']);
    expect(report).toMatchObject({ lane: 'p2p-lane', candidates: 4, counted: 2, excluded: 2 });
  });

  // D-007: the substrate vocabulary leads a second life naming ordinary single-box
  // release-engineering work here (this repo BUNDLES a corestore seed into the
  // desktop release), and 'peer' routinely means ANOTHER AGENT. Those terms were
  // REJECTED from the fence for that reason. Pinning it through this path too,
  // because a burn-down that quietly dropped them would hide from the fleet exactly
  // the local work it can act on.
  it('does NOT exclude the D-007 anti-terms — substrate vocabulary is not p2p work here', () => {
    const items = [
      item({ id: 'WI-a1', title: 'corestore seed bloats the desktop bundle' }),
      item({ id: 'WI-a2', title: 'peer agent wedges the shared tree lock' }),
      item({ id: 'WI-a3', title: 'cannot replicate the floor set locally' }),
    ];
    const { rows, report } = applyLaneFence(items, 'p2p-lane');
    expect(rows.map((r) => r.id)).toEqual(['WI-a1', 'WI-a2', 'WI-a3']);
    expect(report.excluded).toBe(0);
    // Guard the premise, not just the outcome: if one of these terms is ever added
    // to the fence, this test should fail HERE with a clear reason rather than as a
    // mysterious row-count change above.
    for (const term of ['corestore', 'peer', 'replicate']) {
      expect(P2P_LANE_EXCLUSION_TERMS as readonly string[]).not.toContain(term);
      expect(P2P_LANE_REJECTED_ANTI_TERMS as readonly string[]).toContain(term);
    }
  });

  // CONTROL (falsifiability): the fence must be the SHARED macro, evaluated by the
  // claim path's own matcher — not a local regex that happens to agree today. Drive
  // every real exclusion term through it; a hand-rolled copy drifts from this list
  // the moment the module changes, which is the failure P-011 is about.
  it('CONTROL: every term in the shared fence actually excludes, via the claim-path matcher', () => {
    const items = P2P_LANE_EXCLUSION_TERMS.map((term, i) =>
      item({ id: `WI-${i}`, title: `${term} regression in the swarm` }),
    );
    const { rows, report } = applyLaneFence(items, 'p2p-lane');
    expect(report.candidates).toBe(P2P_LANE_EXCLUSION_TERMS.length);
    expect(rows).toEqual([]);
    expect(report.excluded).toBe(P2P_LANE_EXCLUSION_TERMS.length);
  });

  it('is a no-op report on an empty census rather than inventing a scope', () => {
    const { rows, report } = applyLaneFence([], 'p2p-lane');
    expect(rows).toEqual([]);
    expect(report).toMatchObject({ candidates: 0, counted: 0, excluded: 0 });
  });
});
