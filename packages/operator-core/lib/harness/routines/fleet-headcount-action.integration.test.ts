import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetLaunchTransaction } from '../../agent-fleets-store';

const mocks = vi.hoisted(() => ({
  getFlag: vi.fn(),
  claimAttempt: vi.fn(),
  claimSlot: vi.fn(),
  getFleet: vi.fn(),
  listTargets: vi.fn(),
  recordAttempt: vi.fn(),
  releaseSlot: vi.fn(),
  setTransaction: vi.fn(),
  liveMemberIds: vi.fn(),
  readFleetRoster: vi.fn(),
  readFleetLaneHealth: vi.fn(),
  executingOwnersSince: vi.fn(),
  buildEnvelope: vi.fn(),
  spawnHeadless: vi.fn(),
  spawnConsole: vi.fn(),
  verify: vi.fn(),
  kill: vi.fn(),
  resolveGoalLaunch: vi.fn(),
  resolveGoalContext: vi.fn(),
  capacity: vi.fn(),
  emitEvent: vi.fn(),
  setHeadcountTarget: vi.fn(),
  listExpiredRules: vi.fn(),
  lapseRule: vi.fn(),
  orgSql: vi.fn(),
  getModes: vi.fn(),
  recoverInterruptions: vi.fn(),
  loopStatuses: vi.fn(),
  events: [] as string[],
  headcountEvents: [] as Record<string, unknown>[],
}));

// The stand-down guard (EI-23259368987233359) scans for a workspace-wide loop stand-down
// through the SAME org sql handle these fixtures stub for plan-status lookups. Answer that
// one query at the seam with "no stand-down active" so `mocks.orgSql` keeps counting ONLY
// plan-status calls — otherwise every `expect(mocks.orgSql).not.toHaveBeenCalled()` below
// measures the guard instead of the grant logic it is about, and the fail-open fixtures
// (whose sql throws on purpose) trip the guard's deliberate fail-closed path.
// The guard's own behaviour — including fail-closed — is asserted in
// ./loop-standdown-governor-guard.test.ts; stubbing it here isolates, it does not weaken.
const isStanddownScan = (args: unknown[]): boolean => {
  const strings = args[0];
  return Array.isArray(strings) && strings.join('').includes("metadata->'pause'");
};

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: (...args: unknown[]) => (isStanddownScan(args) ? Promise.resolve([]) : mocks.orgSql(...args)),
  }),
}));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: (...args: unknown[]) => mocks.getFlag(...args),
}));
vi.mock('@papercusp/flags', () => ({
  FLAGS: { FLEET_HEADCOUNT_GOVERNOR: 'fleet-headcount-governor' },
}));
vi.mock('../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-fleets-store')>()),
  claimFleetHeadcountAttempt: (...args: unknown[]) => mocks.claimAttempt(...args),
  claimFleetLaunchSlot: (...args: unknown[]) => mocks.claimSlot(...args),
  getFleet: (...args: unknown[]) => mocks.getFleet(...args),
  lapseFleetTopUpRule: (...args: unknown[]) => mocks.lapseRule(...args),
  listExpiredFleetTopUpRules: (...args: unknown[]) => mocks.listExpiredRules(...args),
  listFleetHeadcountTargets: (...args: unknown[]) => mocks.listTargets(...args),
  recordFleetHeadcountAttempt: (...args: unknown[]) => mocks.recordAttempt(...args),
  releaseFleetLaunchSlot: (...args: unknown[]) => mocks.releaseSlot(...args),
  setFleetHeadcountTarget: (...args: unknown[]) => mocks.setHeadcountTarget(...args),
  setFleetLaunchTransaction: (...args: unknown[]) => mocks.setTransaction(...args),
}));
vi.mock('../../console-launcher', () => ({
  buildConsoleEnvelope: (...args: unknown[]) => mocks.buildEnvelope(...args),
}));
vi.mock('../../console-spawn', () => ({
  spawnHeadless: (...args: unknown[]) => mocks.spawnHeadless(...args),
  spawnConsole: (...args: unknown[]) => mocks.spawnConsole(...args),
}));
vi.mock('../../fleet/fleet-roster', () => ({
  liveFleetMemberIds: (...args: unknown[]) => mocks.liveMemberIds(...args),
  listFleetRosterDiagnosed: (...args: unknown[]) => mocks.readFleetRoster(...args),
}));
vi.mock('../../fleet/lane-health', () => ({
  readFleetLaneHealthDiagnosed: (...args: unknown[]) => mocks.readFleetLaneHealth(...args),
}));
vi.mock('../../fleet/assignments', () => ({
  executingOwnersSince: (...args: unknown[]) => mocks.executingOwnersSince(...args),
}));
vi.mock('../../agent-launch-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-launch-core')>()),
  verifyFreshLaunchStarted: (...args: unknown[]) => mocks.verify(...args),
}));
vi.mock('../../agent-tools/fleet/kill', () => ({
  default: { handler: (...args: unknown[]) => mocks.kill(...args) },
}));
vi.mock('../../goal-launch-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../goal-launch-settings')>()),
  resolveGoalLaunch: (...args: unknown[]) => mocks.resolveGoalLaunch(...args),
}));
// The launcher-mode read (WI-6554700010029298) is stubbed at its own seam so it never
// lands on `mocks.orgSql`, whose call count the plan-status cases assert on.
vi.mock('../../modes/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modes/store')>()),
  getModes: (...args: unknown[]) => mocks.getModes(...args),
}));
vi.mock('../../modes/goal-context', () => ({
  resolveGoalContext: (...args: unknown[]) => mocks.resolveGoalContext(...args),
}));
vi.mock('../../agent-tools/fleet/capacity', () => ({
  default: { handler: (...args: unknown[]) => mocks.capacity(...args) },
}));
vi.mock('../../events/await/engine', () => ({
  emitAwaitedEvent: (...args: unknown[]) => mocks.emitEvent(...args),
}));
vi.mock('../../mcp-base-url', () => ({
  resolveSpawnHostOperatorBaseUrl: () => 'http://127.0.0.1:3070',
}));
vi.mock('../../papercusp-root', () => ({
  papercuspPathForWorkspace: () => '/tmp/fleet-headcount-action-test',
}));
vi.mock('./system-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./system-actions')>()),
  registerSystemAction: vi.fn(),
}));
vi.mock('./session-interruption-runtime', () => ({
  sweepSessionInterruptions: (...args: unknown[]) => mocks.recoverInterruptions(...args),
}));
vi.mock('./loop', () => ({
  getLoopStatuses: (...args: unknown[]) => mocks.loopStatuses(...args),
}));

import { FLEET_HEADCOUNT_BOOT_FAILURE_HOLD_MS, runFleetHeadcountGovernor } from './fleet-headcount-action';

const readyAttestation = (ownerId: string, ready: boolean) => ({
  version: 1 as const,
  ownerId,
  ready,
  stages: {
    agentCall: { status: 'satisfied' as const, successfulCalls: 1 },
    durableWake: ready
      ? { status: 'satisfied' as const, wakeSource: 'loop' }
      : { status: 'missing' as const, wakeSource: null },
    schedulerPull: ready
      ? { status: 'satisfied' as const, calls: 1, successfulCalls: 1 }
      : { status: 'missing' as const, calls: 0, successfulCalls: 0 },
    disposition: ready
      ? { status: 'satisfied' as const, kind: 'no-claim' as const, reason: 'lane_drained' }
      : { status: 'missing' as const, kind: 'missing' as const },
  },
  failures: ready ? [] : [{
    stage: 'durableWake' as const,
    code: 'durable-wake-missing' as const,
    detail: 'No durable wake.',
  }],
});

const verifierResult = (ownerId: string, ready: boolean) => ({
  agentStarted: true as boolean | null,
  workerReady: ready,
  waitedMs: 1,
  sessions: [{
    advSessionId: 1,
    ownerId,
    successfulCalls: 1,
    msSinceLastSignal: 1,
    hasPresence: true,
    attestationDiffs: [],
    workerAttestation: readyAttestation(ownerId, ready),
  }],
  note: ready ? 'worker ready' : 'agent started; worker stages incomplete',
});

const baseConfig = {
  plan: 'plan-a',
  harness: 'papercusp',
  agent: 'codex' as const,
  model: 'gpt-5.6-sol',
  effort: 'high',
  account: 'default',
  headless: true,
  carry: 'warm' as const,
  productiveCapacityFloor: 1,
  // R5: the per-fleet GRANT. Every fixture below models a fleet that opted in;
  // the R5 describe at the bottom covers the ungranted shapes.
  supervise: true,
};

/** The enabled governor row shape `listFleetHeadcountTargets` returns for a granting fleet.
 * `null` (NOT undefined — that would take the default) models a legacy row with no config. */
const grantedTarget = (config: Record<string, unknown> | null = baseConfig) => ({
  workspaceId: 'ws',
  fleetSlug: 'fleet-a',
  enabled: true,
  target: 1,
  ...(config ? { config } : {}),
  nextAttemptAt: null,
  backoffMs: 0,
  lastError: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recoverInterruptions.mockResolvedValue({ protectedOwnerIds: [] });
  mocks.loopStatuses.mockResolvedValue(new Map());
  mocks.events.length = 0;
  mocks.headcountEvents.length = 0;
  mocks.getFlag.mockResolvedValue(true);
  mocks.listTargets.mockResolvedValue([grantedTarget()]);
  mocks.listExpiredRules.mockResolvedValue([]);
  mocks.lapseRule.mockResolvedValue(true);
  mocks.claimAttempt.mockResolvedValue({
    workspaceId: 'ws',
    fleetSlug: 'fleet-a',
    target: 1,
    config: baseConfig,
    nextAttemptAt: null,
    backoffMs: 0,
    lastError: null,
    claimedAt: 1,
  });
  mocks.claimSlot.mockResolvedValue({ won: true, at: 10 });
  mocks.recordAttempt.mockResolvedValue(undefined);
  mocks.releaseSlot.mockResolvedValue(undefined);
  mocks.setTransaction.mockResolvedValue(undefined);
  mocks.buildEnvelope.mockResolvedValue({ cwd: '/tmp/fleet', env: {} });
  mocks.spawnHeadless.mockImplementation(async () => {
    mocks.events.push('spawn');
    return { status: 'ok', terminal: 'headless', pid: 123 };
  });
  mocks.spawnConsole.mockResolvedValue({ status: 'ok', terminal: 'xterm', pid: 123 });
  mocks.kill.mockImplementation(async () => {
    mocks.events.push('kill');
    return { data: { ok: true, counts: { ok: 1, failed: 0 }, results: [{ ok: true }] } };
  });
  mocks.resolveGoalLaunch.mockResolvedValue({ effective: {}, refusal: null });
  mocks.resolveGoalContext.mockResolvedValue(null);
  // The integration verifier fixtures model a successful first turn for every
  // live member. Keep the independent P-007 execution signal deterministic too;
  // otherwise the real assignments query returns an empty set and turns a
  // verified late boot into a synthetic refill deficit.
  mocks.executingOwnersSince.mockImplementation(async (ownerIds: string[]) => new Set(ownerIds));
  mocks.readFleetRoster.mockImplementation(async (args: { leaderOwnerId?: string | null }) => ({
    entries: [],
    degradedLegs: [],
    leaderLiveness: args.leaderOwnerId
      ? {
          ownerId: args.leaderOwnerId,
          presenceRow: true,
          recordedLive: false,
          sessionState: 'live',
          complete: true,
        }
      : undefined,
  }));
  mocks.readFleetLaneHealth.mockResolvedValue({
    laneHealth: {
      effective: { claimable: 1 },
      spec: { specId: 'current-test-spec', revision: 1 },
    },
    unavailable: null,
  });
  mocks.capacity.mockImplementation(async (args: { headroom?: number }) => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: true,
        reachable: true,
        verdict: 'measured',
        provider: 'codex',
        recommendedHeadroom: args.headroom ?? 0,
        advice: 'fleet provider capacity measured',
      }),
    }],
  }));
  mocks.emitEvent.mockImplementation(async (args: { payload?: Record<string, unknown> }) => {
    mocks.headcountEvents.push(args.payload ?? {});
  });
  mocks.setHeadcountTarget.mockResolvedValue(undefined);
  mocks.orgSql.mockResolvedValue([]);
  mocks.getModes.mockResolvedValue([]);
});

describe('deliberate loop-end is a headcount repair admission fence', () => {
  const owner = 'su-stopped';
  const stopped = () => new Map([[owner, { active: false, explicitlyEnded: true }]]);
  const run = () => runFleetHeadcountGovernor({
    installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
  });
  const setup = (live = true): FleetLaunchTransaction => {
    const transaction: FleetLaunchTransaction = {
      version: 1, transactionId: 'tx-stale-assignment', launcherOwnerId: 'su-reaped-leader',
      state: 'partial', requestedAt: 1, updatedAt: 1,
      requestedMemberIds: [owner], openedMemberIds: [owner], verifiedMemberIds: [owner],
      workerReadyMemberIds: [], workerAttestations: [readyAttestation(owner, false)],
      failed: [], waves: [], recovery: { retryOwnerIds: [owner], nextAction: 'observe' },
      governor: {
        version: 1, probeOwnerIds: [owner], attestationAttempts: { [owner]: 2 },
        retiredMemberIds: [], history: [], terminalVerdict: null,
      },
    };
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a', leaderOwnerId: 'su-reaped-leader', lastLaunchTransaction: transaction,
    });
    mocks.liveMemberIds.mockResolvedValue(live ? [owner] : []);
    mocks.executingOwnersSince.mockResolvedValue(new Set());
    mocks.verify.mockImplementation(async (args: { expectedOwnerIds: string[] }) =>
      verifierResult(args.expectedOwnerIds[0]!, args.expectedOwnerIds[0] !== owner));
    return transaction;
  };

  it('does not prune or respawn when registered leader liveness is unknown', async () => {
    const transaction = setup(true);
    mocks.readFleetRoster.mockResolvedValue({
      entries: [],
      degradedLegs: ['presence'],
      leaderLiveness: {
        ownerId: 'su-reaped-leader',
        presenceRow: false,
        recordedLive: null,
        sessionState: null,
        complete: false,
      },
    });

    await run();

    expect(mocks.readFleetLaneHealth).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    expect(transaction.governor?.terminalVerdict).toMatchObject({
      action: 'wait',
      outcome: 'unverified',
      reason: expect.stringContaining('leader liveness is unknown'),
    });
  });

  it('disarms without a pull or replacement when complete evidence shows the leader was reaped', async () => {
    const transaction = setup(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.readFleetRoster.mockResolvedValue({
      entries: [],
      degradedLegs: [],
      leaderLiveness: {
        ownerId: 'su-reaped-leader',
        presenceRow: false,
        recordedLive: true,
        sessionState: 'recorded',
        complete: true,
      },
    });

    await run();

    expect(mocks.readFleetLaneHealth).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    expect(mocks.setHeadcountTarget).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws', fleetSlug: 'fleet-a', target: null }),
    );
    expect(mocks.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      succeeded: false,
      error: expect.stringContaining('leader is not positively live'),
    }));
    expect(transaction.governor?.terminalVerdict).toMatchObject({
      action: 'none',
      outcome: 'unverified',
      reason: expect.stringContaining('leader is not positively live'),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leader is not positively live'));
    warn.mockRestore();
  });

  it('rechecks leader liveness after preflight and refuses a replacement if the leader was reaped', async () => {
    setup(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.orgSql.mockResolvedValue([{ status: 'active', archived: false }]);
    mocks.readFleetRoster
      .mockResolvedValueOnce({
        entries: [],
        degradedLegs: [],
        leaderLiveness: {
          ownerId: 'su-reaped-leader',
          presenceRow: true,
          recordedLive: true,
          sessionState: 'live',
          complete: true,
        },
      })
      .mockResolvedValueOnce({
        entries: [],
        degradedLegs: [],
        leaderLiveness: {
          ownerId: 'su-reaped-leader',
          presenceRow: false,
          recordedLive: true,
          sessionState: 'recorded',
          complete: true,
        },
      });

    await run();

    expect(mocks.readFleetRoster).toHaveBeenCalledTimes(2);
    expect(mocks.readFleetLaneHealth).toHaveBeenCalledTimes(1);
    expect(mocks.claimSlot).toHaveBeenCalledTimes(1);
    expect(mocks.releaseSlot).toHaveBeenCalledWith({ workspaceId: 'ws', fleetSlug: 'fleet-a', at: 10 });
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    expect(mocks.setHeadcountTarget).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws', fleetSlug: 'fleet-a', target: null }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leader is not positively live'));
    warn.mockRestore();
  });

  it('does not prune or respawn into an exactly measured empty fleet lane', async () => {
    const transaction = setup(true);
    mocks.readFleetLaneHealth.mockResolvedValue({
      laneHealth: {
        effective: { claimable: 0 },
        spec: { specId: 'stale-byoc-lane', revision: 46 },
      },
      unavailable: null,
    });

    await run();

    expect(mocks.readFleetLaneHealth).toHaveBeenCalledTimes(1);
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    expect(transaction.governor?.terminalVerdict).toMatchObject({
      action: 'wait',
      outcome: 'unverified',
      reason: expect.stringContaining('has no currently claimable work'),
    });
  });

  it('does not prune or respawn when the measured lane count is negative', async () => {
    const transaction = setup(true);
    mocks.readFleetLaneHealth.mockResolvedValue({
      laneHealth: {
        effective: { claimable: -1 },
        spec: { specId: 'invalid-byoc-lane', revision: 46 },
      },
      unavailable: null,
    });

    await run();

    expect(mocks.readFleetLaneHealth).toHaveBeenCalledTimes(1);
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    expect(transaction.governor?.terminalVerdict).toMatchObject({
      action: 'wait',
      outcome: 'unverified',
      reason: expect.stringContaining('has no currently claimable work'),
    });
  });

  it.each([true, false])('preserves a settled no-assignment disposition across ticks (member live: %s)', async (live) => {
    const transaction = setup(live);
    mocks.loopStatuses.mockResolvedValue(stopped());

    await run();
    await run();

    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.claimSlot).not.toHaveBeenCalled();
    expect(transaction.workerAttestations?.[0].ready).toBe(false);
    expect(transaction.governor?.attestationAttempts[owner]).toBe(2);
    expect(transaction.governor?.terminalVerdict).toMatchObject({
      action: 'wait', outcome: 'unverified', reason: expect.stringContaining('explicit loop:end'),
    });
    expect(transaction.recovery.nextAction).toContain(owner);
    expect(transaction.recovery.nextAction).toContain('loop:arm');
    expect(mocks.setHeadcountTarget).not.toHaveBeenCalled();
  });

  it.each([true, false])('rechecks a stop during asynchronous launch preflight (prune: %s)', async (live) => {
    setup(live);
    mocks.loopStatuses.mockResolvedValueOnce(new Map()).mockResolvedValue(stopped());

    await run();

    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    expect(mocks.releaseSlot).toHaveBeenCalledWith({ workspaceId: 'ws', fleetSlug: 'fleet-a', at: 10 });
    expect(mocks.recordAttempt).toHaveBeenLastCalledWith(expect.objectContaining({
      succeeded: false, error: expect.stringContaining('explicit loop:end'),
    }));
  });

  it('fails closed when the deliberate-stop read is unavailable', async () => {
    const transaction = setup();
    mocks.loopStatuses.mockRejectedValue(new Error('loop store unavailable'));

    await run();

    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(transaction.governor?.terminalVerdict).toMatchObject({
      action: 'wait', outcome: 'unverified', reason: expect.stringContaining('loop store unavailable'),
    });
  });

  it('retains the original stopped cohort when the stop arrives after replacement reservation', async () => {
    setup(false);
    mocks.loopStatuses
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map())
      .mockImplementation(async (owners: string[]) => new Map(
        owners.filter(id => id === owner).map(id => [id, { active: false, explicitlyEnded: true }]),
      ));

    await run();

    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.releaseSlot).toHaveBeenCalledWith({ workspaceId: 'ws', fleetSlug: 'fleet-a', at: 10 });
    const held = mocks.setTransaction.mock.calls.at(-1)?.[0].transaction;
    expect(held).toMatchObject({
      transactionId: 'tx-stale-assignment', requestedMemberIds: [owner],
      governor: { terminalVerdict: { action: 'wait', outcome: 'unverified' } },
    });
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a', leaderOwnerId: 'su-reaped-leader', lastLaunchTransaction: held,
    });
    await run();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
  });

  it('resumes ordinary repair after an explicit rearm', async () => {
    setup();
    mocks.loopStatuses.mockResolvedValue(stopped());
    await run();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();

    mocks.loopStatuses.mockResolvedValue(new Map([[owner, { active: true, explicitlyEnded: false }]]));
    await run();

    expect(mocks.kill).toHaveBeenCalledTimes(1);
    expect(mocks.spawnHeadless).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary system-paused workers eligible for repair', async () => {
    setup();
    mocks.loopStatuses.mockResolvedValue(new Map([[owner, { active: false, explicitlyEnded: false }]]));

    await run();

    expect(mocks.kill).toHaveBeenCalledTimes(1);
    expect(mocks.spawnHeadless).toHaveBeenCalledTimes(1);
  });

  it('does not revive a stop from a member already retired by a previous repair', async () => {
    const transaction = setup(false);
    transaction.governor!.retiredMemberIds = [owner];
    mocks.loopStatuses.mockResolvedValue(stopped());

    await run();

    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).toHaveBeenCalledTimes(1);
  });
});

describe('interrupted original members precede refill', () => {
  it('defers a replacement while the original continuation is not yet in the execution census', async () => {
    mocks.recoverInterruptions.mockResolvedValue({ protectedOwnerIds: ['original-member'] });
    mocks.liveMemberIds.mockResolvedValue([]);
    await runFleetHeadcountGovernor({ installSlug: 'papercusp', workspaceId: 'ws',
      triggerConfig: {}, payloadTemplate: null });
    expect(mocks.recoverInterruptions).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws' }),
      false, { fleetSlug: 'fleet-a' });
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    expect(mocks.claimSlot).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('original-member'),
    }));
  });
});

// WI-1457060. The governor reasoned only about member headcount and readiness, never
// about whether the WORK still existed, so a fleet whose plan had SHIPPED kept having
// replacements opened forever — `pui-remediation-ship-2026-08-28` at target 4 with
// headless:false meant four desktop windows reopening in perpetuity. Sibling of
// WI-1454201, which closed the case where a fleet was explicitly wound down; this is the
// case where nobody ever said "stop" because the work simply ran out.
describe('headcount governor disarms a fleet whose plan is finished (WI-1457060)', () => {
  const targetWithPlan = [{
    workspaceId: 'ws',
    fleetSlug: 'fleet-a',
    target: 1,
    config: baseConfig,
    nextAttemptAt: null,
    backoffMs: 0,
    lastError: null,
  }];
  const run = () => runFleetHeadcountGovernor({
    installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
  });

  it.each(['shipped', 'superseded'])('disarms instead of topping up when the plan is %s', async (status) => {
    mocks.listTargets.mockResolvedValue(targetWithPlan);
    mocks.orgSql.mockResolvedValue([{ status, archived: false }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await run();

    expect(mocks.setHeadcountTarget).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws', fleetSlug: 'fleet-a', target: null }),
    );
    // The whole point: no replacement member is opened.
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    expect(mocks.claimAttempt).not.toHaveBeenCalled();
    // A silent disarm is indistinguishable from a deleted fleet, so the reason is
    // part of the contract, not decoration.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`disarmed fleet-a: plan plan-a is ${status}`),
    );
    warn.mockRestore();
  });

  it('disarms an archived plan even when its stored status still reads active', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.listTargets.mockResolvedValue(targetWithPlan);
    mocks.orgSql.mockResolvedValue([{ status: 'active', archived: true }]);

    await run();

    expect(mocks.setHeadcountTarget).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws', fleetSlug: 'fleet-a', target: null }),
    );
    expect(mocks.claimAttempt).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      succeeded: false,
      error: expect.stringContaining('plan plan-a is archived'),
    }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plan plan-a is archived'));
    warn.mockRestore();
  });

  // CALIBRATION. Without this, every assertion above would also pass if the guard simply
  // disarmed everything unconditionally.
  it('still tops up a fleet whose plan is active', async () => {
    mocks.listTargets.mockResolvedValue(targetWithPlan);
    mocks.orgSql.mockResolvedValue([{ status: 'active', archived: false }]);

    await run();

    expect(mocks.setHeadcountTarget).not.toHaveBeenCalled();
    expect(mocks.claimAttempt).toHaveBeenCalled();
  });

  // FAIL OPEN. A fleet doing real work must never be disarmed because a status lookup
  // broke. Only a POSITIVE terminal reading may disarm.
  it.each([
    ['the plan row is missing', async () => [] as unknown[]],
    ['the status query throws', async () => { throw new Error('pg down'); }],
  ])('keeps topping up when %s', async (_label, sqlImpl) => {
    mocks.listTargets.mockResolvedValue(targetWithPlan);
    mocks.orgSql.mockImplementation(sqlImpl as () => Promise<unknown[]>);

    await run();

    expect(mocks.setHeadcountTarget).not.toHaveBeenCalled();
    expect(mocks.claimAttempt).toHaveBeenCalled();
  });

  it('does not consult plan status at all when the granted config names no plan', async () => {
    // A planless (legacy) recipe that DID grant supervision: still topped up, never
    // status-checked. (Before R5 this fixture was a config-less row; a config-less
    // row can no longer be granted at all — see the R5 describe below.)
    const { plan: _plan, ...planless } = baseConfig;
    // The claimed attempt is the config the governor actually executes. Keep it
    // consistent with the granted target instead of inheriting the default plan-a.
    mocks.claimAttempt.mockResolvedValue({
      workspaceId: 'ws',
      fleetSlug: 'fleet-a',
      target: 1,
      config: planless,
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
      claimedAt: 1,
    });
    mocks.listTargets.mockResolvedValue([grantedTarget(planless)]);
    mocks.orgSql.mockResolvedValue([{ status: 'shipped' }]);

    await run();

    expect(mocks.orgSql).not.toHaveBeenCalled();
    expect(mocks.setHeadcountTarget).not.toHaveBeenCalled();
    expect(mocks.claimAttempt).toHaveBeenCalled();
  });
});

// P-005 / D-030: a no-top-up rule SUSPENDS holding until its `until`. The governor
// ends expired rules before it lists granting targets, so a fleet whose rule
// lapsed (and whose target/supervise grant was restored) is held on the SAME tick.
describe('headcount governor lapses expired no-top-up rules first (P-005 / D-030)', () => {
  const expiredRule = {
    kind: 'target-disabled' as const,
    ratifiedBy: 'su-old-leader',
    ratifiedAt: 1_000,
    reason: 'D-001: no waves or top-ups',
    until: 2_000,
    suspendedTarget: 3,
    suspendedSupervise: true,
  };
  const expired = [{ workspaceId: 'ws', fleetSlug: 'fleet-a', rule: expiredRule, config: baseConfig }];
  const run = () => runFleetHeadcountGovernor({
    installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
  });

  it('restores an expired rule on an active plan before listing granting targets', async () => {
    mocks.listExpiredRules.mockImplementation(async () => {
      mocks.events.push('list-expired');
      return expired;
    });
    mocks.lapseRule.mockImplementation(async () => {
      mocks.events.push('lapse');
      return true;
    });
    mocks.listTargets.mockImplementation(async () => {
      mocks.events.push('list-targets');
      return [];
    });
    mocks.orgSql.mockResolvedValue([{ status: 'active' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await run();

    expect(mocks.lapseRule).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws', fleetSlug: 'fleet-a', expectedUntil: 2_000, restore: true }),
    );
    expect(mocks.events.slice(0, 3)).toEqual(['list-expired', 'lapse', 'list-targets']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no-top-up rule on fleet-a expired (ratified by su-old-leader'),
    );
    warn.mockRestore();
  });

  it.each(['shipped', 'superseded'])('clears without restoring when the plan is %s', async (status) => {
    mocks.listExpiredRules.mockResolvedValue(expired);
    mocks.listTargets.mockResolvedValue([]);
    mocks.orgSql.mockResolvedValue([{ status }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await run();

    expect(mocks.lapseRule).toHaveBeenCalledWith(expect.objectContaining({ fleetSlug: 'fleet-a', restore: false }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`plan is ${status}; rule cleared without restoring`));
    warn.mockRestore();
  });

  it('reports nothing for a rule a concurrent re-ratification already moved', async () => {
    mocks.listExpiredRules.mockResolvedValue(expired);
    mocks.lapseRule.mockResolvedValue(false);
    mocks.listTargets.mockResolvedValue([]);
    mocks.orgSql.mockResolvedValue([{ status: 'active' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await run();

    expect(mocks.lapseRule).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('no-top-up rule on fleet-a expired'));
    warn.mockRestore();
  });

  it('keeps governing when the lapse sweep itself fails', async () => {
    mocks.listExpiredRules.mockRejectedValue(new Error('pg down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await run();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('top-up rule lapse sweep failed: pg down'));
    expect(mocks.listTargets).toHaveBeenCalled();
    expect(mocks.lapseRule).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// R5 (interrupted-member-recovery-hardening-2026-09-01): FLEET_HEADCOUNT_GOVERNOR is the
// MASTER gate; a per-fleet `supervise: true` on the persisted recipe is the GRANT. A
// recipe persisted for reuse/respawn alone (D-008/WI-41145 — every fresh homogeneous
// plan fleet gets one) is not consent, so with the flag ON the governor still touches
// only granting fleets — and "touches" includes the terminal-plan disarm above: an
// ungranted armed row is inert by construction, because this sweep is topUpOneFleet's
// only caller.
describe('headcount governor acts only on granting fleets (R5 per-fleet supervise grant)', () => {
  const run = () => runFleetHeadcountGovernor({
    installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
  });
  const { supervise: _granted, ...recipeWithoutGrant } = baseConfig;

  it.each([
    ['a legacy row with no config at all', null],
    ['a recipe that never mentions supervise', recipeWithoutGrant],
    ['a recipe with supervise:false (revoked)', { ...recipeWithoutGrant, supervise: false }],
  ])('opens nothing and consults nothing for %s, even with the flag ON', async (_label, config) => {
    mocks.listTargets.mockResolvedValue([grantedTarget(config)]);
    mocks.orgSql.mockResolvedValue([{ status: 'shipped' }]);

    await run();

    expect(mocks.claimAttempt).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    // Not even the terminal-plan disarm: the grant filter runs before any action.
    expect(mocks.orgSql).not.toHaveBeenCalled();
    expect(mocks.setHeadcountTarget).not.toHaveBeenCalled();
  });

  // CALIBRATION. The identical recipe WITH the grant is acted on, so the assertions
  // above cannot pass by the governor simply doing nothing at all.
  it('still tops up the identical recipe once it carries supervise:true', async () => {
    mocks.listTargets.mockResolvedValue([grantedTarget({ ...recipeWithoutGrant, supervise: true })]);
    mocks.orgSql.mockResolvedValue([{ status: 'active' }]);

    await run();

    expect(mocks.claimAttempt).toHaveBeenCalled();
  });

  it('is a no-op everywhere while the master flag is OFF — a grant cannot override it', async () => {
    mocks.getFlag.mockResolvedValue(false);
    mocks.listTargets.mockResolvedValue([grantedTarget({ ...recipeWithoutGrant, supervise: true })]);

    await run();

    expect(mocks.listTargets).not.toHaveBeenCalled();
    expect(mocks.claimAttempt).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
  });
});

describe('fleet headcount governor I/O ordering (P-004)', () => {
  it('clamps a measured bulk refill before opening terminals and persists the residual wall', async () => {
    mocks.claimAttempt.mockResolvedValue({
      workspaceId: 'ws',
      fleetSlug: 'fleet-a',
      target: 5,
      config: { ...baseConfig, productiveCapacityFloor: 1 },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
      claimedAt: 1,
    });
    const transaction = {
      version: 1 as const,
      transactionId: 'tx-ready',
      launcherOwnerId: 'su-leader',
      state: 'verified' as const,
      requestedAt: 1,
      updatedAt: 1,
      requestedMemberIds: ['su-a', 'su-b'],
      openedMemberIds: ['su-a', 'su-b'],
      verifiedMemberIds: ['su-a', 'su-b'],
      unconfirmedMemberIds: [],
      workerReadyMemberIds: ['su-a', 'su-b'],
      workerAttestations: [readyAttestation('su-a', true), readyAttestation('su-b', true)],
      failed: [],
      waves: [{ index: 0, ownerIds: ['su-a', 'su-b'], state: 'verified' as const }],
      recovery: { retryOwnerIds: [], nextAction: 'observe' },
      governor: {
        version: 1 as const,
        probeOwnerIds: ['su-a', 'su-b'],
        attestationAttempts: {},
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    };
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: transaction,
    });
    mocks.capacity.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          reachable: true,
          verdict: 'measured',
          provider: 'codex',
          recommendedHeadroom: 1,
          advice: 'provider has one spare slot',
        }),
      }],
    });
    let rosterRead = 0;
    mocks.liveMemberIds.mockImplementation(async () => {
      rosterRead += 1;
      if (rosterRead === 1) return ['su-a', 'su-b'];
      const replacement = mocks.spawnHeadless.mock.calls[0]?.[0]?.coordOwnerId;
      return replacement ? ['su-a', 'su-b', replacement] : ['su-a', 'su-b'];
    });
    mocks.verify.mockImplementation(async (args: { expectedOwnerIds: string[] }) =>
      verifierResult(args.expectedOwnerIds[0]!, true));

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.capacity).toHaveBeenCalledWith(
      expect.objectContaining({ fleet: 'fleet-a', headroom: 3 }),
      expect.anything(),
    );
    expect(mocks.spawnHeadless).toHaveBeenCalledTimes(1);
    expect(mocks.claimSlot).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1 }),
    );
    const persisted = mocks.setTransaction.mock.calls.at(-1)?.[0].transaction;
    expect(persisted.governor.capacity).toMatchObject({
      provider: 'codex', requested: 3, allowance: 1, residualShortfall: 2,
      measured: true, wall: 'provider has one spare slot',
    });
    expect(mocks.headcountEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'refill-clamped', requested: 3, allowance: 1, residualShortfall: 2,
      }),
    ]));
  });

  // WI-6554700010029299: a deterministic psu boot refusal made every replacement die
  // at boot, and the 15-minute backoff cap let the governor mint dead members forever.
  describe('deterministic boot-failure hold (WI-6554700010029299)', () => {
    const FP = 'psu: su launch account route differs from its resolved bootstrap';
    const bootDeath = 'headless member launched but its agent command died at boot (exit 1) — log tail: '
      + 'psu: fleet — joined fleet fleet-a as member.\npsu: SU launch account route differs from its resolved bootstrap\n'
      + '[papercusp] initial terminal command exited with status 1; headless launch exiting.';
    const priorWithBootFailures = (count: number) => ({
      version: 1 as const,
      transactionId: 'tx-boot',
      launcherOwnerId: 'su-leader',
      state: 'verified' as const,
      requestedAt: 1,
      updatedAt: 1,
      requestedMemberIds: ['su-a'],
      openedMemberIds: ['su-a'],
      verifiedMemberIds: ['su-a'],
      unconfirmedMemberIds: [],
      workerReadyMemberIds: ['su-a'],
      workerAttestations: [readyAttestation('su-a', true)],
      failed: [],
      waves: [{ index: 0, ownerIds: ['su-a'], state: 'verified' as const }],
      recovery: { retryOwnerIds: [], nextAction: 'observe' },
      governor: {
        version: 1 as const,
        probeOwnerIds: ['su-a'],
        attestationAttempts: {},
        retiredMemberIds: [],
        history: Array.from({ length: count }, (_, i) => ({ at: 100 + i, action: 'boot-failure' as const, reason: FP })),
        terminalVerdict: null,
      },
    });
    const runWithPrior = async (priorBootFailures: number) => {
      mocks.claimAttempt.mockResolvedValue({
        workspaceId: 'ws', fleetSlug: 'fleet-a', target: 2,
        config: { ...baseConfig, productiveCapacityFloor: 1 },
        nextAttemptAt: null, backoffMs: 900_000, lastError: null, claimedAt: 1,
      });
      mocks.getFleet.mockResolvedValue({
        fleetSlug: 'fleet-a', leaderOwnerId: 'su-leader', lastLaunchTransaction: priorWithBootFailures(priorBootFailures),
      });
      mocks.liveMemberIds.mockResolvedValue(['su-a']);
      mocks.spawnHeadless.mockImplementation(async () => ({ status: 'error', error: bootDeath }));
      await runFleetHeadcountGovernor({
        installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
      });
    };

    it('the third identical all-dead wave holds relaunch for hours and says why', async () => {
      await runWithPrior(2);
      expect(mocks.spawnHeadless).toHaveBeenCalled();
      expect(mocks.recordAttempt).toHaveBeenLastCalledWith(expect.objectContaining({
        succeeded: false,
        holdMs: FLEET_HEADCOUNT_BOOT_FAILURE_HOLD_MS,
        error: expect.stringContaining(FP),
      }));
      const persisted = mocks.setTransaction.mock.calls.at(-1)?.[0].transaction;
      expect(persisted.governor.history.filter((e: { action: string }) => e.action === 'boot-failure')).toHaveLength(3);
      expect(mocks.headcountEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'refusal', reason: 'boot-failure-hold', fingerprint: FP, consecutiveWaves: 3 }),
      ]));
    });

    it('control: a second identical wave stays on the ordinary backoff', async () => {
      await runWithPrior(1);
      expect(mocks.spawnHeadless).toHaveBeenCalled();
      const last = mocks.recordAttempt.mock.calls.at(-1)?.[0];
      expect(last).toMatchObject({ succeeded: false });
      expect(last.holdMs).toBeUndefined();
      expect(mocks.headcountEvents).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'boot-failure-hold' }),
      ]));
    });
  });

  it('refuses a zero-capacity refill before claiming a launch slot or pruning', async () => {
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: null,
    });
    mocks.liveMemberIds.mockResolvedValue([]);
    mocks.capacity.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          reachable: true,
          verdict: 'measured',
          provider: 'codex',
          recommendedHeadroom: 0,
          advice: 'provider is exhausted until its reset window',
        }),
      }],
    });

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.claimSlot).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
    const persisted = mocks.setTransaction.mock.calls.at(-1)?.[0].transaction;
    expect(persisted.governor.capacity).toMatchObject({
      provider: 'codex', requested: 1, allowance: 0, residualShortfall: 1,
      measured: true, wall: 'provider is exhausted until its reset window',
    });
    expect(persisted.governor.terminalVerdict).toMatchObject({
      outcome: 'failed', action: 'wait',
      reason: expect.stringContaining('provider capacity refused'),
    });
    expect(mocks.headcountEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'refusal', requested: 1, allowance: 0, residualShortfall: 1 }),
    ]));
  });

  it('holds an automatic Codex top-up when the pool is exhausted even though the tier-one floor is positive', async () => {
    mocks.claimAttempt.mockResolvedValue({
      workspaceId: 'ws', fleetSlug: 'fleet-a', target: 1,
      config: { ...baseConfig, account: 'auto' },
      nextAttemptAt: null, backoffMs: 0, lastError: null, claimedAt: 1,
    });
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: null,
    });
    mocks.liveMemberIds.mockResolvedValue([]);
    mocks.capacity.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          reachable: true,
          verdict: 'measured',
          provider: 'codex',
          poolExhausted: true,
          dispatchBudget: 51,
          recommendedHeadroom: 2,
          advice: 'pool EXHAUSTED: zero routable Codex accounts',
        }),
      }],
    });

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.resolveGoalLaunch).toHaveBeenCalled();
    expect(mocks.claimSlot).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
    const persisted = mocks.setTransaction.mock.calls.at(-1)?.[0].transaction;
    expect(persisted.governor.capacity).toMatchObject({
      provider: 'codex', requested: 1, allowance: 0, residualShortfall: 1,
      measured: true,
      wall: expect.stringContaining('pool is exhausted'),
    });
    expect(mocks.headcountEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'refusal', requested: 1, allowance: 0, residualShortfall: 1 }),
    ]));
  });

  it('does not apply the exhausted gateway-pool gate to a direct system-credential top-up', async () => {
    mocks.claimAttempt.mockResolvedValue({
      workspaceId: 'ws', fleetSlug: 'fleet-a', target: 1,
      config: { ...baseConfig, account: 'default' },
      nextAttemptAt: null, backoffMs: 0, lastError: null, claimedAt: 1,
    });
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: null,
    });
    mocks.liveMemberIds.mockResolvedValue([]);
    mocks.capacity.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          reachable: true,
          verdict: 'measured',
          provider: 'codex',
          poolExhausted: true,
          dispatchBudget: 51,
          recommendedHeadroom: 2,
          advice: 'pool EXHAUSTED: zero routable Codex accounts',
        }),
      }],
    });

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.spawnHeadless).toHaveBeenCalledTimes(1);
    expect(mocks.claimSlot).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
  });

  it('refreshes a late boot to productive and performs no duplicate launch', async () => {
    const transaction = {
      version: 1 as const,
      transactionId: 'tx-slow',
      launcherOwnerId: 'su-leader',
      state: 'partial' as const,
      requestedAt: 1,
      updatedAt: 1,
      requestedMemberIds: ['su-slow'],
      openedMemberIds: ['su-slow'],
      verifiedMemberIds: [],
      unconfirmedMemberIds: ['su-slow'],
      failed: [],
      waves: [{ index: 0, ownerIds: ['su-slow'], state: 'partial' as const }],
      recovery: { retryOwnerIds: ['su-slow'], nextAction: 'wait' },
    };
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: transaction,
    });
    mocks.liveMemberIds.mockResolvedValue(['su-slow']);
    mocks.verify.mockResolvedValue(verifierResult('su-slow', true));

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.verify).toHaveBeenCalledWith(
      expect.objectContaining({ launcherOwnerId: 'su-leader', expectedOwnerIds: ['su-slow'] }),
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ succeeded: true }),
    );
    const persisted = mocks.setTransaction.mock.calls.at(-1)?.[0].transaction;
    expect(persisted.governor.terminalVerdict).toMatchObject({
      outcome: 'productive', action: 'none', workerReadyMemberIds: ['su-slow'],
    });
    expect(persisted).toMatchObject({
      state: 'verified',
      verifiedMemberIds: ['su-slow'],
      unconfirmedMemberIds: [],
      recovery: { retryOwnerIds: [] },
      waves: [{ state: 'verified', verifiedOwnerIds: ['su-slow'] }],
    });
  });

  // WI-6554700010029353: the legacy member's ready:false is a frozen snapshot outside the
  // probe cohort. It is reported as unready but no longer holds a `wait`. At target 1
  // with su-late productive, the fleet is simply satisfied.
  it('settles a late verified probe; an unrelated frozen legacy non-ready member holds no wait', async () => {
    const transaction = {
      version: 1 as const,
      transactionId: 'tx-late-with-legacy-seat',
      launcherOwnerId: 'su-leader',
      state: 'partial' as const,
      requestedAt: 1,
      updatedAt: 1,
      requestedMemberIds: ['su-legacy-unready', 'su-late'],
      openedMemberIds: ['su-late'],
      verifiedMemberIds: ['su-legacy-unready'],
      unconfirmedMemberIds: ['su-late'],
      workerReadyMemberIds: [],
      workerAttestations: [readyAttestation('su-legacy-unready', false)],
      failed: [],
      waves: [{ index: 0, ownerIds: ['su-late'], state: 'partial' as const }],
      recovery: { retryOwnerIds: ['su-late'], nextAction: 'retry late member' },
      governor: {
        version: 1 as const,
        probeOwnerIds: ['su-late'],
        attestationAttempts: { 'su-late': 1 },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    };
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: transaction,
    });
    mocks.liveMemberIds.mockResolvedValue(['su-legacy-unready', 'su-late']);
    mocks.executingOwnersSince.mockResolvedValue(new Set(['su-late']));
    mocks.verify.mockResolvedValue(verifierResult('su-late', true));

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ succeeded: true }),
    );
    expect(mocks.recordAttempt).not.toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'non-ready evidence lacks a verified-start or terminal-failure proof; prune is unsafe',
      }),
    );
    const persisted = mocks.setTransaction.mock.calls.at(-1)?.[0].transaction;
    expect(persisted).toMatchObject({
      state: 'verified',
      verifiedMemberIds: ['su-legacy-unready', 'su-late'],
      unconfirmedMemberIds: [],
      recovery: {
        retryOwnerIds: [],
        nextAction: 'target and productive-capacity floor are both satisfied',
      },
      waves: [{ state: 'verified', verifiedOwnerIds: ['su-late'] }],
      governor: {
        terminalVerdict: {
          outcome: 'productive',
          action: 'none',
          unreadyMemberIds: ['su-legacy-unready'],
        },
      },
    });
  });

  // WI-6554700010029353 — the Luna Max shape end to end: a verified member with a
  // frozen ready:false attestation, outside probeOwnerIds and silent (not executing),
  // beside a deficit. Before the fix the governor returned `wait: prune is unsafe` on
  // every tick and never spawned. Now it refills the deficit and still never kills
  // the frozen member.
  it('refills a deficit past a frozen non-executing unready member and never prunes it', async () => {
    const config = { ...baseConfig };
    const transaction = {
      version: 1 as const,
      transactionId: 'tx-frozen-unready',
      launcherOwnerId: 'su-leader',
      state: 'verified' as const,
      requestedAt: 1,
      updatedAt: 1,
      requestedMemberIds: ['su-frozen-unready', 'su-b'],
      openedMemberIds: [],
      verifiedMemberIds: ['su-frozen-unready', 'su-b'],
      unconfirmedMemberIds: [],
      workerReadyMemberIds: ['su-b'],
      workerAttestations: [
        readyAttestation('su-frozen-unready', false),
        readyAttestation('su-b', true),
      ],
      failed: [],
      waves: [],
      recovery: { retryOwnerIds: [], nextAction: 'none' },
      governor: {
        version: 1 as const,
        probeOwnerIds: [],
        attestationAttempts: {},
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    };
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: transaction,
    });
    mocks.listTargets.mockResolvedValue([{ ...grantedTarget(config), target: 2 }]);
    mocks.claimAttempt.mockResolvedValue({
      workspaceId: 'ws',
      fleetSlug: 'fleet-a',
      target: 2,
      config,
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
      claimedAt: 1,
    });
    mocks.orgSql.mockResolvedValue([{ status: 'active' }]);
    mocks.liveMemberIds.mockResolvedValue(['su-frozen-unready', 'su-b']);
    mocks.executingOwnersSince.mockResolvedValue(new Set(['su-b']));
    mocks.verify.mockImplementation(async (args: { expectedOwnerIds: string[] }) =>
      verifierResult(args.expectedOwnerIds[0]!, true));

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.spawnHeadless).toHaveBeenCalledTimes(1);
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).not.toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'non-ready evidence lacks a verified-start or terminal-failure proof; prune is unsafe',
      }),
    );
  });

  it.each(['silent', 'executing', 'unknown'] as const)(
    'rechecks a prune candidate before killing it when current execution is %s', async (execution) => {
    const transaction = {
      version: 1 as const,
      transactionId: 'tx-dark',
      launcherOwnerId: 'su-leader',
      state: 'verified' as const,
      requestedAt: 1,
      updatedAt: 1,
      requestedMemberIds: ['su-dark'],
      openedMemberIds: ['su-dark'],
      verifiedMemberIds: ['su-dark'],
      unconfirmedMemberIds: [],
      workerReadyMemberIds: [],
      workerAttestations: [readyAttestation('su-dark', false)],
      failed: [],
      waves: [{ index: 0, ownerIds: ['su-dark'], state: 'verified' as const }],
      recovery: { retryOwnerIds: [], nextAction: 'retry' },
      governor: {
        version: 1 as const,
        probeOwnerIds: ['su-dark'],
        attestationAttempts: { 'su-dark': 2 },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    };
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: transaction,
    });
    let rosterRead = 0;
    mocks.liveMemberIds.mockImplementation(async () => {
      rosterRead += 1;
      if (rosterRead === 1) return ['su-dark'];
      const replacement = mocks.spawnHeadless.mock.calls[0]?.[0]?.coordOwnerId;
      return replacement ? [replacement] : [];
    });
    mocks.verify.mockImplementation(async (args: { expectedOwnerIds: string[] }) => {
      const ownerId = args.expectedOwnerIds[0];
      return verifierResult(ownerId, ownerId !== 'su-dark');
    });
    mocks.executingOwnersSince
      .mockResolvedValueOnce(new Set<string>())
      .mockResolvedValueOnce(execution === 'unknown' ? null : new Set(execution === 'executing' ? ['su-dark'] : []));

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    if (execution !== 'silent') {
      expect(mocks.kill).not.toHaveBeenCalled();
      expect(mocks.spawnHeadless).not.toHaveBeenCalled();
      expect(mocks.releaseSlot).toHaveBeenCalledWith({ workspaceId: 'ws', fleetSlug: 'fleet-a', at: 10 });
      expect(mocks.recordAttempt).toHaveBeenLastCalledWith(expect.objectContaining({
        succeeded: false,
        error: expect.stringContaining('prune deferred:'),
      }));
      return;
    }

    expect(mocks.events).toEqual(['kill', 'spawn']);
    expect(mocks.kill).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'su-dark' }),
      expect.anything(),
    );
    const spawnArgs = mocks.spawnHeadless.mock.calls[0][0];
    expect(spawnArgs.coordOwnerId).toMatch(/^su-/);
    expect(spawnArgs.envelope.greetingCmd).toContain('--launched-by=su-leader');
    expect(spawnArgs.envelope.greetingCmd).toContain(`--owner-id=${spawnArgs.coordOwnerId}`);

    const persisted = mocks.setTransaction.mock.calls.at(-1)?.[0].transaction;
    expect(persisted.previousTransactionId).toBe('tx-dark');
    expect(persisted.governor.retiredMemberIds).toContain('su-dark');
    expect(persisted.governor.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'prune', ownerId: 'su-dark', replacementOwnerId: spawnArgs.coordOwnerId }),
      expect.objectContaining({ action: 'respawn', ownerId: 'su-dark', replacementOwnerId: spawnArgs.coordOwnerId }),
    ]));
    expect(persisted.governor.terminalVerdict).toMatchObject({ outcome: 'productive', action: 'none' });
    },
  );

  it('releases its launch slot and opens nothing when a concurrent transaction wins the CAS', async () => {
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: null,
    });
    mocks.liveMemberIds.mockResolvedValue([]);
    mocks.setTransaction.mockResolvedValue(false);

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.setTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: null }),
    );
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    expect(mocks.releaseSlot).toHaveBeenCalledWith({ workspaceId: 'ws', fleetSlug: 'fleet-a', at: 10 });
    expect(mocks.recordAttempt).toHaveBeenLastCalledWith(expect.objectContaining({
      succeeded: false,
      error: expect.stringContaining('changed concurrently'),
    }));
  });

  it('attributes an attestation mismatch only to the mismatched member and bounds retained history', async () => {
    mocks.claimAttempt.mockResolvedValue({
      workspaceId: 'ws',
      fleetSlug: 'fleet-a',
      target: 2,
      config: { ...baseConfig, productiveCapacityFloor: 1 },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
      claimedAt: 1,
    });
    const transaction = {
      version: 1 as const,
      transactionId: 'tx-mismatch',
      launcherOwnerId: 'su-leader',
      state: 'partial' as const,
      requestedAt: 1,
      updatedAt: 1,
      requestedMemberIds: ['su-mismatch', 'su-waiting'],
      openedMemberIds: ['su-mismatch', 'su-waiting'],
      verifiedMemberIds: [],
      unconfirmedMemberIds: ['su-mismatch', 'su-waiting'],
      workerReadyMemberIds: [],
      workerAttestations: [
        readyAttestation('su-mismatch', false),
        readyAttestation('su-waiting', false),
      ],
      failed: [],
      waves: [{
        index: 0,
        ownerIds: ['su-mismatch', 'su-waiting'],
        state: 'partial' as const,
      }],
      recovery: { retryOwnerIds: ['su-mismatch', 'su-waiting'], nextAction: 'retry' },
      governor: {
        version: 1 as const,
        probeOwnerIds: ['su-mismatch', 'su-waiting'],
        attestationAttempts: {},
        retiredMemberIds: [],
        history: Array.from({ length: 40 }, (_value, index) => ({
          at: index,
          action: 'observe' as const,
          reason: `prior event ${index}`,
        })),
        terminalVerdict: null,
      },
    };
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: transaction,
    });
    mocks.liveMemberIds.mockResolvedValue(['su-mismatch', 'su-waiting']);
    mocks.verify.mockResolvedValue({
      agentStarted: false,
      workerReady: false,
      waitedMs: 1,
      sessions: [
        {
          ...verifierResult('su-mismatch', false).sessions[0],
          attestationDiffs: [{ field: 'model', requested: 'gpt-a', actual: 'gpt-b' }],
        },
        verifierResult('su-waiting', false).sessions[0],
      ],
      note: '✗ ATTESTATION MISMATCH — su-mismatch.model differs',
    });

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    const persistedCall = mocks.setTransaction.mock.calls.at(-1)?.[0];
    expect(persistedCall.expectedRevision).toEqual({ transactionId: 'tx-mismatch', updatedAt: 1 });
    expect(persistedCall.transaction.failed).toEqual([
      expect.objectContaining({ ownerId: 'su-mismatch', phase: 'attestation' }),
    ]);
    expect(persistedCall.transaction.governor.history).toHaveLength(32);
    expect(persistedCall.transaction.governor.terminalVerdict).toMatchObject({
      outcome: 'unverified',
      action: 'retry',
    });
  });

  it('does not forward the persisted plan to a governor refill member', async () => {
    const config = {
      ...baseConfig,
      brief: 'Use only the fleet claim spec.',
    };
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: null,
    });
    mocks.liveMemberIds.mockResolvedValue([]);
    mocks.listTargets.mockResolvedValue([grantedTarget(config)]);
    mocks.claimAttempt.mockResolvedValue({
      workspaceId: 'ws',
      fleetSlug: 'fleet-a',
      target: 1,
      config,
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
      claimedAt: 1,
    });
    mocks.orgSql.mockResolvedValue([{ status: 'active' }]);
    mocks.verify.mockImplementation(async (args: {
      expectedOwnerIds: string[];
      expectedAttestations?: Array<{ planSlug: string | null }>;
    }) => {
      expect(args.expectedAttestations).toEqual([
        expect.objectContaining({ planSlug: null }),
      ]);
      return verifierResult(args.expectedOwnerIds[0]!, true);
    });

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    const spawnArgs = mocks.spawnHeadless.mock.calls[0]?.[0];
    expect(spawnArgs).toBeDefined();
    expect(spawnArgs.envelope.greetingCmd).not.toContain('--plan=');
    const launchContext = readFileSync(
      '/tmp/fleet-headcount-action-test/launch-context/fleet-fleet-a-headcount-context.md',
      'utf8',
    );
    expect(launchContext).toContain('draining your fleet claim-lane backlog');
    expect(launchContext).not.toContain('working plan `plan-a`');
  });
});

// WI-6554700010029298. A governor top-up composed its psu command with no mode, so a
// drain fleet's replacements all booted AUTO-only: Luna Max had 721 joiners in 7 days
// and none held DRAIN, because DRAIN lived only on the founding leader's identity and
// three later leaders never held it.
describe('governor top-up launches the fleet mode (WI-6554700010029298)', () => {
  const runTopUp = async (config: Record<string, unknown>) => {
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: null,
    });
    mocks.liveMemberIds.mockResolvedValue([]);
    mocks.listTargets.mockResolvedValue([grantedTarget(config)]);
    mocks.claimAttempt.mockResolvedValue({
      workspaceId: 'ws',
      fleetSlug: 'fleet-a',
      target: 1,
      config,
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
      claimedAt: 1,
    });
    mocks.orgSql.mockResolvedValue([{ status: 'active' }]);
    mocks.verify.mockImplementation(async (args: { expectedOwnerIds: string[] }) =>
      verifierResult(args.expectedOwnerIds[0]!, true));
    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });
    const spawnArgs = mocks.spawnHeadless.mock.calls[0]?.[0];
    expect(spawnArgs).toBeDefined();
    return String(spawnArgs.envelope.greetingCmd);
  };

  it('launches --mode=drain from the recipe even when the current leader holds no DRAIN', async () => {
    mocks.getModes.mockResolvedValue([{ mode: 'auto' }]);
    const command = await runTopUp({ ...baseConfig, mode: 'drain' });
    expect(command).toContain('--mode=drain');
    // Member-shaped: the founding caller's subject and owner provenance never ride along.
    expect(command).not.toContain('--mode-owner-directed');
    expect(command).not.toContain('--mode-subject=');
    expect(mocks.getModes).not.toHaveBeenCalled();
  });

  it('falls back to the launching leader\'s live DRAIN row for a legacy recipe without a mode', async () => {
    mocks.getModes.mockResolvedValue([{ mode: 'auto' }, { mode: 'drain', subject: 'leader mission', ownerDirected: true }]);
    const command = await runTopUp({ ...baseConfig });
    expect(mocks.getModes).toHaveBeenCalledWith('ws', 'su-leader');
    expect(command).toContain('--mode=drain');
    expect(command).not.toContain('--mode-owner-directed');
    expect(command).not.toContain('leader mission');
  });

  it('launches no mode when neither the recipe nor the leader declares one', async () => {
    mocks.getModes.mockResolvedValue([{ mode: 'auto' }]);
    const command = await runTopUp({ ...baseConfig });
    expect(command).not.toContain('--mode=');
  });

  it('still tops up, without a mode, when the leader mode read fails', async () => {
    mocks.getModes.mockRejectedValue(new Error('pg down'));
    const command = await runTopUp({ ...baseConfig });
    expect(command).not.toContain('--mode=');
  });
});
