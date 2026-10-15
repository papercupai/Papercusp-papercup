/**
 * WI-2971: work_items:claim_next must not bypass an active scheduler claim-spec.
 *
 * Fleet members are steered through scheduler:set_claim_spec, but some launch briefs and
 * older habits still call work_items:claim_next. The wrapper must route through the same
 * getNextForBee selector while SCHEDULER_SPEC_CLAIM is on, so a member cannot pull an
 * out-of-lane item from the raw oldest-first claim path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'su-me', workspaceId: 'ws-1' }));
const flag = vi.hoisted(() => ({ schedulerSpecClaim: true }));
const fleet = vi.hoisted(() => ({
  scope: null as any,
  quarantinedIds: [] as string[],
  windingDown: false,
  pauseReason: null as string | null,
}));
// EI-15777: the paused-miss branch cancels the caller's own standing
// `work-item:claimable` await(s) — mock the store call so these unit tests never
// touch real PG, and so tests below can assert it was invoked (self-scoped, by assignee).
const cancelClaimableAwaitsM = vi.hoisted(() => vi.fn(async () => 0));
const premisePort = vi.hoisted(() => ({ get: vi.fn() }));
const explicitAssigneeM = vi.hoisted(() => ({
  resolve: vi.fn(async (raw: string, callerOwnerId: string, _workspaceId?: string | null) =>
    ({ ok: true as const, ownerId: raw.trim() === 'self' ? callerOwnerId : raw.trim() }) as
      | { ok: true; ownerId: string }
      | { ok: false; code: string; message: string; candidates?: string[] },
  ),
}));

vi.mock('../../events/await/store', () => ({
  cancelClaimableAwaits: cancelClaimableAwaitsM,
}));

vi.mock('@papercusp/flags', () => ({
  FLAGS: { SCHEDULER_SPEC_CLAIM: 'scheduler.spec.claim' },
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: vi.fn(async () => flag.schedulerSpecClaim),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => identity,
  resolveSelfLiteral: (value: string | undefined, callerOwnerId: string) => (value === 'self' ? callerOwnerId : value),
}));

vi.mock('../coordination/recipient-resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/recipient-resolve')>()),
  resolveExplicitAgentOwnerId: explicitAssigneeM.resolve,
}));

vi.mock('../../work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: vi.fn(() => false),
  leaseClaimedWorkItem: vi.fn(),
}));

vi.mock('../../work-item-redundancy', () => ({
  workItemRedundancyEnabled: vi.fn(() => false),
}));

vi.mock('../../fleet/swarm-identity', () => ({
  localSwarmId: vi.fn(() => 'swarm-1'),
}));

vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-1'),
}));

vi.mock('../../scheduler/claim-spec-store', () => ({
  getNextForBee: vi.fn(),
  resolveClaimSpecWorkspace: vi.fn((ws: string | null | undefined) => ws ?? undefined),
}));

vi.mock('../../scheduler/fleet-scope-admission', () => ({
  reconcileFleetScopeClaims: vi.fn(async () => ({ scope: fleet.scope, quarantinedIds: fleet.quarantinedIds })),
  readFleetPauseState: vi.fn(async () => ({ windingDown: fleet.windingDown, reason: fleet.pauseReason })),
  // EI-13520: real fn returns null (no cooldown-diagnosis signal) by default — these tests
  // don't exercise the cooldown-attribution path, only fleetScopedMiss's existing shapes.
  diagnoseFleetScopeCooldownMiss: vi.fn(async () => null),
  fleetScopedMiss: (
    scope: any,
    quarantinedIds: string[],
    opts?: {
      pausedReason?: string | null;
      cooldownDiag?: { cooldownExcluded: number; earliestExpiryMs: number | null } | null;
      claimableAwaitsCancelled?: number;
    },
  ) => ({
    ok: false,
    error:
      opts?.pausedReason !== undefined
        ? `paused: ${opts.pausedReason ?? ''}`
        : opts?.cooldownDiag
          ? `cooldown-only miss; ${opts.cooldownDiag.cooldownExcluded} excluded`
          : 'scoped miss',
    fleetScope: { fleet: scope.fleetSlug, specId: scope.record.spec.specId, revision: scope.record.spec.revision },
    quarantinedIds,
    windDown: true,
    ...(opts?.pausedReason !== undefined ? { paused: true } : {}),
    ...(opts?.pausedReason !== undefined ? { claimableAwaitsCancelled: opts?.claimableAwaitsCancelled ?? 0 } : {}),
    ...(opts?.cooldownDiag ? { cooldownOnly: true } : {}),
  }),
}));

// `isSettledWorkItemState` is passed through REAL, not stubbed: it is a pure predicate,
// and claim_next reaches it TRANSITIVELY (claim_next -> ./retraction-advisory -> work-items).
// A whole-module factory that omits a transitively-imported export fails the suite at import
// time with "No X export is defined on the mock" — which is what happened here. Stubbing it
// as vi.fn() would be worse than the crash: it would return undefined, making every
// "is this settled?" check silently falsy. Same reasoning, and same fix, as comment.test.ts.
vi.mock('../../work-items', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../work-items')>();
  return {
    CLAIM_STATES_ALLOWLIST: ['open', 'failing'],
    claimNextWorkItem: vi.fn(),
    releaseWorkItem: vi.fn(),
    diagnoseClaimNextMiss: vi.fn(),
    isSettledWorkItemState: actual.isSettledWorkItemState,
  };
});
// Claim-time recall port (P-008) — mock so this handler test stays a hermetic
// unit (the recall itself is pinned in memory/claim-port.test.ts).
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));
vi.mock('../../premises-claim-port', () => ({ getClaimTimePremises: premisePort.get }));

import { getNextForBee } from '../../scheduler/claim-spec-store';
import { claimNextWorkItem, diagnoseClaimNextMiss } from '../../work-items';

const getNextForBeeM = vi.mocked(getNextForBee);
const claimNextM = vi.mocked(claimNextWorkItem);
const diagnoseM = vi.mocked(diagnoseClaimNextMiss);
const tool = (await import('./claim_next')).default;

async function body(args: unknown) {
  const out = (await tool.handler(args as never, {} as never)) as { content: Array<{ text: string }> };
  return JSON.parse(out.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  explicitAssigneeM.resolve.mockImplementation(async (raw, callerOwnerId) => ({
    ok: true,
    ownerId: raw.trim() === 'self' ? callerOwnerId : raw.trim(),
  }));
  identity.ownerId = 'su-me';
  identity.workspaceId = 'ws-1';
  flag.schedulerSpecClaim = true;
  fleet.scope = null;
  fleet.quarantinedIds = [];
  fleet.windingDown = false;
  fleet.pauseReason = null;
  getNextForBeeM.mockResolvedValue({
    workItem: { id: 'WI-lane', assignee: 'su-me' } as never,
    claimedUnder: { specId: 'fleet-bugs', revision: 3 },
    specSource: 'fleet',
  });
  claimNextM.mockResolvedValue({ id: 'WI-raw', assignee: 'su-me' } as never);
  diagnoseM.mockResolvedValue({ drained: true, pendingUnclaimed: 0, readyUnclaimed: 0, flagReadError: null });
  premisePort.get.mockResolvedValue(null);
});

describe('work_items:claim_next claim-spec bridge (WI-2971)', () => {
  it('uses getNextForBee while the scheduler claim-spec flag is on', async () => {
    const b = await body({ harness: 'papercusp', states: ['open'] });

    expect(b).toMatchObject({
      ok: true,
      workItem: { id: 'WI-lane' },
      claimedUnder: { specId: 'fleet-bugs', revision: 3 },
    });
    expect(getNextForBeeM).toHaveBeenCalledWith({
      cupId: 'su-me',
      workspaceId: 'ws-1',
      harness: 'papercusp',
      states: ['open'],
      swarmId: undefined,
      excludeRedundant: false,
      rigAvailable: undefined,
    });
    expect(claimNextM).not.toHaveBeenCalled();
  });

  it('uses the explicit assignee as the scheduler bee id', async () => {
    await body({ harness: 'papercusp', assignee: 'su-other' });

    expect(getNextForBeeM).toHaveBeenCalledWith(expect.objectContaining({ cupId: 'su-other' }));
    expect(claimNextM).not.toHaveBeenCalled();
  });

  it('refuses an unknown explicit assignee before selecting or claiming work', async () => {
    explicitAssigneeM.resolve.mockResolvedValue({
      ok: false,
      code: 'assignee_unknown',
      message: 'No known owner matches noop-do-not-use.',
    });

    const b = await body({ harness: 'papercusp', assignee: 'noop-do-not-use' });

    expect(explicitAssigneeM.resolve).toHaveBeenCalledWith('noop-do-not-use', 'su-me', 'ws-1');
    expect(b).toMatchObject({ ok: false, error: 'assignee_unknown' });
    expect(getNextForBeeM).not.toHaveBeenCalled();
    expect(claimNextM).not.toHaveBeenCalled();
  });

  // EI-9274: a literal `'self'` assignee must resolve to the caller ownerId, not be
  // passed through verbatim as the scheduler bee id (which would produce an
  // unmatchable, permanently orphaned claim — WI-3881).
  it('EI-9274: resolves assignee:"self" to the caller ownerId as the scheduler bee id', async () => {
    await body({ harness: 'papercusp', assignee: 'self' });

    expect(getNextForBeeM).toHaveBeenCalledWith(expect.objectContaining({ cupId: 'su-me' }));
    expect(claimNextM).not.toHaveBeenCalled();
  });

  it('does not fall back to the raw claim path on a spec miss', async () => {
    getNextForBeeM.mockResolvedValue(null);

    const b = await body({ harness: 'papercusp' });

    expect(b).toMatchObject({
      ok: false,
      drained: true,
      pendingUnclaimed: 0,
      readyUnclaimed: 0,
    });
    expect(claimNextM).not.toHaveBeenCalled();
  });

  it('keeps the legacy raw claim path when SCHEDULER_SPEC_CLAIM is off', async () => {
    flag.schedulerSpecClaim = false;

    const b = await body({ harness: 'papercusp' });

    expect(b).toMatchObject({ ok: true, workItem: { id: 'WI-raw' } });
    expect(claimNextM).toHaveBeenCalledWith({
      harness: 'papercusp',
      assignee: 'su-me',
      kind: undefined,
      states: undefined,
      swarmId: undefined,
      excludeRedundant: false,
      rigAvailable: undefined,
    });
    expect(getNextForBeeM).not.toHaveBeenCalled();
  });

  it('surfaces premise revalidation on a single claim and passes the claimed id', async () => {
    getNextForBeeM.mockResolvedValue({
      workItem: {
        id: 'EI-aged',
        title: 'Build a replacement gate',
        summary: 'Depends on WI-4329.',
        payload: { source: 'ideation' },
        harness: 'papercusp',
        assignee: 'su-me',
      } as never,
      claimedUnder: { specId: 'fleet-bugs', revision: 3 },
      specSource: 'fleet',
    });
    premisePort.get.mockResolvedValue({
      rendered: ['- ? WI-4329 terminal evidence says the premise was invalid'],
      note: 'Re-check the invalidated premise before building.',
    });

    const b = await body({ harness: 'papercusp' });

    expect(b).toMatchObject({
      workItem: { id: 'EI-aged' },
      premises: ['- ? WI-4329 terminal evidence says the premise was invalid'],
      premisesNote: 'Re-check the invalidated premise before building.',
    });
    expect(premisePort.get).toHaveBeenCalledWith({
      workItem: {
        id: 'EI-aged',
        title: 'Build a replacement gate',
        summary: 'Depends on WI-4329.',
        payload: { source: 'ideation' },
      },
      harness: 'papercusp',
      workspaceId: 'ws-1',
    });
  });

  it('surfaces premise revalidation independently on every item in a batch claim', async () => {
    getNextForBeeM
      .mockResolvedValueOnce({
        workItem: { id: 'EI-one', title: 'One', summary: 'Cites WI-1001.', payload: {} } as never,
        claimedUnder: { specId: 'fleet-bugs', revision: 3 },
        specSource: 'fleet',
      })
      .mockResolvedValueOnce({
        workItem: { id: 'EI-two', title: 'Two', summary: 'Cites WI-1002.', payload: {} } as never,
        claimedUnder: { specId: 'fleet-bugs', revision: 3 },
        specSource: 'fleet',
      });
    premisePort.get.mockImplementation(async ({ workItem }: { workItem: { id?: string } }) => ({
      rendered: [`- ? ${workItem.id} requires premise revalidation`],
      note: `Re-check ${workItem.id}`,
    }));

    const b = await body({ harness: 'papercusp', count: 2 });

    expect(premisePort.get).toHaveBeenCalledTimes(2);
    expect(premisePort.get).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ workItem: expect.objectContaining({ id: 'EI-one' }) }),
    );
    expect(premisePort.get).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workItem: expect.objectContaining({ id: 'EI-two' }) }),
    );
    expect(b.claimed).toHaveLength(2);
    expect(b.claimed[0]).toMatchObject({
      workItem: { id: 'EI-one' },
      premises: ['- ? EI-one requires premise revalidation'],
      premisesNote: 'Re-check EI-one',
    });
    expect(b.claimed[1]).toMatchObject({
      workItem: { id: 'EI-two' },
      premises: ['- ? EI-two requires premise revalidation'],
      premisesNote: 'Re-check EI-two',
    });
  });

  it('P-016 keeps a fleet member on its spec when the scheduler flag is off and winds down on a scoped miss', async () => {
    flag.schedulerSpecClaim = false;
    fleet.scope = {
      ownerId: 'su-me',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    fleet.quarantinedIds = ['WI-out'];
    getNextForBeeM.mockResolvedValue(null);

    const b = await body({ harness: 'papercusp' });
    expect(b).toMatchObject({ ok: false, windDown: true, quarantinedIds: ['WI-out'] });
    expect(getNextForBeeM).toHaveBeenCalledOnce();
    expect(claimNextM).not.toHaveBeenCalled();
  });

  // EI-12832: a member woken during a fleet pause (control_state='winding-down')
  // must stand down — self-select floors BEFORE any claim, whatever the spec matches.
  it('EI-12832: a winding-down fleet floors self-select — paused miss, no pull', async () => {
    fleet.scope = {
      ownerId: 'su-me',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    fleet.windingDown = true;
    fleet.pauseReason = 'owner pause';

    const b = await body({ harness: 'papercusp' });
    expect(b).toMatchObject({ ok: false, windDown: true, paused: true });
    expect(getNextForBeeM).not.toHaveBeenCalled();
    expect(claimNextM).not.toHaveBeenCalled();
    // EI-15777: same paused-miss branch must cancel the caller's OWN standing
    // work-item:claimable await(s) (self-scoped by assignee/ownerId) so a compliant
    // peer stand-down doesn't keep re-waking this member on a pull it can't make.
    expect(cancelClaimableAwaitsM).toHaveBeenCalledWith('su-me', { includeStanding: true });
  });
});
