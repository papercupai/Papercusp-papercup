import { describe, expect, it } from 'vitest';
import type { AgentFleetRecord } from '../../agent-fleets-store';
import type { WorkItem } from '../../work-items';
import { DEFAULT_CLAIM_SPEC, type ClaimSpec } from '../../scheduler/claim-spec';
import type { ResolvedFleetClaimSpec } from '../../scheduler/claim-spec-store';
import type { FleetMetricScopeDeps } from './fleet-metrics-scope';
import {
  fleetMetricClaimFiltersUseSummary,
  resolveFleetMetricScope,
  selectFleetMetricCurrentItems,
  selectFleetMetricFlowEvents,
} from './fleet-metrics-scope';

const START = '2026-08-20T12:00:00.000Z';
const REVISION_AT = '2026-08-21T00:00:00.000Z';
const END = '2026-08-21T12:00:00.000Z';

function spec(revision: number, ids: string[]): ClaimSpec {
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

function item(id: string): WorkItem {
  return { id, title: id, kind: 'bug' } as WorkItem;
}

function resolved(current = spec(2, ['WI-new'])): ResolvedFleetClaimSpec {
  return {
    fleetSlug: 'fleet-a',
    matchedBy: 'fleet-slug',
    record: {
      source: 'fleet',
      spec: current,
      revision: current.revision,
      updatedBy: 'leader',
      updatedAt: REVISION_AT,
      fleetSlug: 'fleet-a',
    },
  };
}

function deps(overrides: Partial<FleetMetricScopeDeps> = {}): FleetMetricScopeDeps {
  return {
    getFleet: async () => ({ fleetSlug: 'fleet-a', createdAt: Date.parse(START) }) as AgentFleetRecord,
    resolveFleetClaimSpec: async () => resolved(),
    readClaimSpecRevisions: async () => ({
      subject: 'fleet:fleet-a',
      revisions: [],
      returned: 0,
      more: false,
    }),
    listFleetRosterDiagnosed: async () => ({
      entries: [{ agentId: 'member-live' }] as never[],
      degradedLegs: [],
    }),
    fleetEverMembers: async () => new Set(['member-dead', 'member-live']),
    now: () => Date.parse(END),
    ...overrides,
  };
}

describe('fleet metric scope resolver and query kernel', () => {
  it('retains summaries when any current or historical claim predicate uses summary', () => {
    const summary = { field: 'summary', op: 'word', value: 'relay' } as const;
    expect(fleetMetricClaimFiltersUseSummary([{ field: 'id', op: '=', value: 'WI-1' }])).toBe(false);
    expect(fleetMetricClaimFiltersUseSummary([{ not: { any: [{ all: [summary] }] } }])).toBe(true);
    expect(fleetMetricClaimFiltersUseSummary([undefined])).toBe(false);
  });

  it('resolves one current-spec fleet scope with canonical roster and membership writers', async () => {
    const result = await resolveFleetMetricScope(
      { workspaceId: 'ws', harness: 'papercusp', fleet: 'fleet-a', flowMode: 'current-spec' },
      deps(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope.stock).toMatchObject({ specId: 'fleet-lane', revision: 2, source: 'fleet' });
    expect(result.scope.flow).toMatchObject({ mode: 'current-spec', revision: 2 });
    expect(result.scope.attribution).toMatchObject({ memberCount: 2, membership: 'ever-members' });
    expect(result.currentRoster.ownerIds).toEqual(['member-live']);
    expect(result.everMemberIds).toEqual(['member-dead', 'member-live']);
    expect(result.populationLifecycle).toMatchObject({
      schemaVersion: 'fleet-population-lifecycle-v1',
      fleet: 'fleet-a',
      window: { startAt: START, endAt: END },
      currentRunnableRoster: {
        census: { population: 'current-runnable-roster', counted: 1 },
        ownerIds: ['member-live'],
      },
      relevantRoster: {
        census: { population: 'relevant-roster', counted: 1 },
        ownerIds: ['member-live'],
      },
      everMembers: { counted: 2, ownerIds: ['member-dead', 'member-live'] },
      claimFlow: { status: 'unknown', values: null },
    });
    expect(selectFleetMetricCurrentItems(result, [item('WI-old'), item('WI-new')]).map((row) => row.id)).toEqual([
      'WI-new',
    ]);
  });

  it('evaluates at-event flow through the revision effective at each event', async () => {
    const result = await resolveFleetMetricScope(
      { workspaceId: 'ws', harness: 'papercusp', fleet: 'fleet-a', flowMode: 'at-event-spec' },
      deps({
        readClaimSpecRevisions: async () => ({
          subject: 'fleet:fleet-a',
          revisions: [
            {
              revision: 1,
              spec: spec(1, ['WI-old']),
              cause: 'update',
              supersededAt: REVISION_AT,
              updatedBy: 'leader',
              harnessSlug: null,
              idOnly: false,
            },
          ],
          returned: 1,
          more: false,
        }),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selected = selectFleetMetricFlowEvents(result, [
      { item: item('WI-old'), at: '2026-08-20T18:00:00.000Z', value: 'old' },
      { item: item('WI-new'), at: '2026-08-21T06:00:00.000Z', value: 'new' },
      { item: item('WI-old'), at: '2026-08-21T06:00:00.000Z', value: 'wrong-revision' },
    ]);
    expect(selected.ok).toBe(true);
    if (selected.ok) expect(selected.events.map((event) => event.value)).toEqual(['old', 'new']);
  });

  it('marks a bounded history read as truncated and never falls back for an uncovered event', async () => {
    const result = await resolveFleetMetricScope(
      {
        workspaceId: 'ws',
        harness: 'papercusp',
        fleet: 'fleet-a',
        flowMode: 'at-event-spec',
        historyLimit: 1,
      },
      deps({
        readClaimSpecRevisions: async () => ({
          subject: 'fleet:fleet-a',
          revisions: [
            {
              revision: 1,
              spec: spec(1, ['WI-old']),
              cause: 'update',
              supersededAt: REVISION_AT,
              updatedBy: 'leader',
              harnessSlug: null,
              idOnly: false,
            },
          ],
          returned: 1,
          more: true,
        }),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quality.exactness).toMatchObject({ status: 'truncated', sourceCap: 1, fetched: 1 });
    const selected = selectFleetMetricFlowEvents(result, [
      { item: item('WI-old'), at: '2026-08-20T18:00:00.000Z', value: null },
    ]);
    expect(selected).toMatchObject({ ok: false, error: 'fleet_metrics_unavailable' });
  });

  it('returns unavailable instead of resolving an absent lane to the default claim spec', async () => {
    const result = await resolveFleetMetricScope(
      { workspaceId: 'ws', harness: 'papercusp', fleet: 'fleet-a', flowMode: 'current-spec' },
      deps({ resolveFleetClaimSpec: async () => null }),
    );
    expect(result).toMatchObject({ ok: false, error: 'fleet_metrics_unavailable' });
  });

  it('returns unavailable when a canonical roster leg degraded', async () => {
    const result = await resolveFleetMetricScope(
      { workspaceId: 'ws', harness: 'papercusp', fleet: 'fleet-a', flowMode: 'current-spec' },
      deps({
        listFleetRosterDiagnosed: async () => ({ entries: [], degradedLegs: ['presence'] }),
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('presence') });
  });

  it('preserves explicit unavailable behavior when psu-host discovery degrades', async () => {
    const result = await resolveFleetMetricScope(
      { workspaceId: 'ws', harness: 'papercusp', fleet: 'fleet-a', flowMode: 'current-spec' },
      deps({
        listFleetRosterDiagnosed: async () => ({ entries: [], degradedLegs: ['psuHosts'] }),
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'fleet_metrics_unavailable',
      reason: 'current roster read degraded: psuHosts',
      recoverVia: 'fleet:status { fleet }',
    });
  });

  it('turns a datastore exception into an explicit unavailable envelope', async () => {
    const result = await resolveFleetMetricScope(
      { workspaceId: 'ws', harness: 'papercusp', fleet: 'fleet-a', flowMode: 'current-spec' },
      deps({
        getFleet: async () => {
          throw new Error('registry offline');
        },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'fleet_metrics_unavailable',
      reason: expect.stringContaining('registry offline'),
    });
  });
});
