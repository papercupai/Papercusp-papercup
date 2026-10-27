import { beforeEach, expect, it, vi } from 'vitest';
import type { PresenceRecord } from './agent-tools/coordination/presence';

const state = vi.hoisted(() => ({
  listPresence: vi.fn(), resolveSessionStates: vi.fn(),
  fetchPresenceFleet: vi.fn(), getFleetScheme: vi.fn(), getFleetSchemes: vi.fn(),
}));
vi.mock('./agent-tools/coordination/presence', async (original) => ({
  ...await original<typeof import('./agent-tools/coordination/presence')>(),
  listPresence: state.listPresence,
}));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: vi.fn(),
}));
vi.mock('@papercusp/flags/server', async (original) => ({
  ...await original<typeof import('@papercusp/flags/server')>(),
  getFlag: vi.fn(async () => false),
}));
vi.mock('./agent-tools/coordination/wake-mode', async (original) => ({
  ...await original<typeof import('./agent-tools/coordination/wake-mode')>(),
  getDefaultWakeMode: vi.fn(async () => 'auto'),
  getWakeModeOverridesFor: vi.fn(async () => new Map()),
}));
vi.mock('./agent-tools/coordination/pending-wakes', async (original) => ({
  ...await original<typeof import('./agent-tools/coordination/pending-wakes')>(),
  countAllPendingWakes: vi.fn(async () => new Map()),
}));
vi.mock('./fleet/assignments', async (original) => ({
  ...await original<typeof import('./fleet/assignments')>(),
  listFleetAssignments: vi.fn(async () => []),
}));
vi.mock('./deployment/account-owner-pins', async (original) => ({
  ...await original<typeof import('./deployment/account-owner-pins')>(),
  getOwnerPinsMap: vi.fn(async () => new Map()),
}));
vi.mock('./agent-tools/coordination/liveness-oracle', async (original) => ({
  ...await original<typeof import('./agent-tools/coordination/liveness-oracle')>(),
  resolveSessionStates: state.resolveSessionStates,
}));
vi.mock('./agent-tools/coordination/presence-fleet', async (original) => ({
  ...await original<typeof import('./agent-tools/coordination/presence-fleet')>(),
  fetchPresenceFleet: state.fetchPresenceFleet,
}));
vi.mock('./agent-fleets-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agent-fleets-store')>(),
  getFleetScheme: state.getFleetScheme,
  getFleetSchemes: state.getFleetSchemes,
}));

import { getOrgPg } from '@papercusp/db-org';
import { mergeRosterWithAssignments } from './adv-roster';
import { mockOrgPgSql } from './testing/mock-org-pg';

type Timing = Parameters<NonNullable<NonNullable<Parameters<typeof mergeRosterWithAssignments>[0]>['onTiming']>>[0];

beforeEach(() => {
  vi.clearAllMocks();
  state.listPresence.mockResolvedValue([]);
  state.resolveSessionStates.mockResolvedValue(new Map());
  state.fetchPresenceFleet.mockReset().mockResolvedValue(new Map());
  state.getFleetScheme.mockReset().mockResolvedValue(null);
  state.getFleetSchemes.mockReset().mockResolvedValue(new Map());
  mockOrgPgSql(vi.mocked(getOrgPg), vi.fn(async () => []));
});

it('batches fleet scheme reads by workspace while preserving roles and missing colors', async () => {
  const presence = (ownerId: string, workspaceId: string): PresenceRecord => {
    const now = new Date().toISOString();
    return {
      ownerId, workspaceId, ownerLabel: ownerId, source: 'test', intent: '',
      currentPlanSlug: null, currentFiles: [], host: '', pid: null, tty: null,
      startedAt: now, heartbeatAt: now, lastActiveAt: now, intentDeclaredAt: now,
      agentRole: null, potSlug: null, capabilityTags: [], stale: false,
      userId: null, revoked: false,
    };
  };
  state.listPresence.mockResolvedValue([
    presence('leader', 'ws-a'), presence('member', 'ws-a'),
    presence('other', 'ws-b'), presence('deleted', 'ws-a'), presence('solo', 'ws-a'),
  ]);
  state.fetchPresenceFleet.mockResolvedValue(new Map([
    ['leader', { fleetSlug: 'shared', fleetRole: 'leader' }],
    ['member', { fleetSlug: 'shared', fleetRole: 'member' }],
    ['other', { fleetSlug: 'shared', fleetRole: 'member' }],
    ['deleted', { fleetSlug: 'gone', fleetRole: 'member' }],
  ]));
  state.getFleetSchemes.mockImplementation(async (workspaceId: string) =>
    new Map([['shared', { cursor: workspaceId === 'ws-a' ? '#112233' : '#445566' }]]));

  const result = await mergeRosterWithAssignments();

  expect(state.getFleetSchemes).toHaveBeenCalledTimes(2);
  expect(state.getFleetSchemes).toHaveBeenCalledWith('ws-a', ['shared', 'gone']);
  expect(state.getFleetSchemes).toHaveBeenCalledWith('ws-b', ['shared']);
  expect(state.getFleetScheme).not.toHaveBeenCalled();
  expect(result.active.map(({ ownerId, fleetSlug, fleetRole, fleetColor }) =>
    ({ ownerId, fleetSlug, fleetRole, fleetColor }))).toEqual([
    { ownerId: 'leader', fleetSlug: 'shared', fleetRole: 'leader', fleetColor: '#112233' },
    { ownerId: 'member', fleetSlug: 'shared', fleetRole: 'member', fleetColor: '#112233' },
    { ownerId: 'other', fleetSlug: 'shared', fleetRole: 'member', fleetColor: '#445566' },
    { ownerId: 'deleted', fleetSlug: 'gone', fleetRole: 'member', fleetColor: null },
    { ownerId: 'solo', fleetSlug: null, fleetRole: null, fleetColor: null },
  ]);
});

it('reports a pending source while its independent siblings run and retains the normal result', async () => {
  let release!: (rows: []) => void;
  state.listPresence.mockReturnValueOnce(new Promise<[]>(resolve => { release = resolve; }));
  const events: Timing[] = [];
  const pending = mergeRosterWithAssignments({ workspaceId: 'test-roster-timing', onTiming: event => events.push(event) });
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
    phase: 'initial.spawn-runs', state: 'completed',
  })));
  expect(events).toContainEqual(expect.objectContaining({ phase: 'initial.presence', state: 'started' }));
  expect(events).not.toContainEqual(expect.objectContaining({ phase: 'initial-sources', state: 'completed' }));
  release([]);
  expect(await pending).toEqual({ active: [], orphanedClaims: [] });
  for (const phase of ['initial-sources', 'federation', 'owner-enrichment', 'transcript-freshness']) {
    expect(events).toContainEqual(expect.objectContaining({ phase, state: 'completed', elapsedMs: expect.any(Number) }));
  }
  expect(events.every(event => event.elapsedMs >= 0)).toBe(true);
});

it('preserves a primary-source error and reports which phase failed', async () => {
  const failure = new Error('presence unavailable');
  state.listPresence.mockRejectedValueOnce(failure);
  const events: Timing[] = [];
  await expect(mergeRosterWithAssignments({ onTiming: event => events.push(event) })).rejects.toBe(failure);
  expect(events).toContainEqual(expect.objectContaining({ phase: 'initial.presence', state: 'failed' }));
  expect(events).toContainEqual(expect.objectContaining({ phase: 'initial-sources', state: 'failed' }));
  expect(events).not.toContainEqual(expect.objectContaining({ phase: 'owner-enrichment', state: 'started' }));
});

it('keeps an observer exception from changing roster availability', async () => {
  expect(await mergeRosterWithAssignments({ onTiming: () => { throw new Error('diagnostic sink failed'); } }))
    .toEqual({ active: [], orphanedClaims: [] });
});

it('forwards the oracle\'s existing read-leg timings without changing their meaning', async () => {
  state.resolveSessionStates.mockImplementationOnce(async (_subjects, options) => {
    options.onTiming('fetchWakeability', 42, 'ok');
    options.onTiming('recordedLiveOwnerIds', 7, 'error');
    return new Map();
  });
  const events: Timing[] = [];
  expect(await mergeRosterWithAssignments({ onTiming: event => events.push(event) }))
    .toEqual({ active: [], orphanedClaims: [] });
  expect(events).toContainEqual({ phase: 'owners.liveness.fetchWakeability', state: 'completed', elapsedMs: 42 });
  expect(events).toContainEqual({ phase: 'owners.liveness.recordedLiveOwnerIds', state: 'failed', elapsedMs: 7 });
});
