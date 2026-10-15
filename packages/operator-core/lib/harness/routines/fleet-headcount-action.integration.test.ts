import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('./system-actions', () => ({
  registerSystemAction: vi.fn(),
}));

import { runFleetHeadcountGovernor } from './fleet-headcount-action';

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
    mocks.orgSql.mockResolvedValue([{ status }]);
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

  // CALIBRATION. Without this, every assertion above would also pass if the guard simply
  // disarmed everything unconditionally.
  it('still tops up a fleet whose plan is active', async () => {
    mocks.listTargets.mockResolvedValue(targetWithPlan);
    mocks.orgSql.mockResolvedValue([{ status: 'active' }]);

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

  it('settles a late verified probe while preserving an unrelated legacy non-ready wait', async () => {
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
      expect.objectContaining({
        succeeded: false,
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
        nextAction: 'non-ready evidence lacks a verified-start or terminal-failure proof; prune is unsafe',
      },
      waves: [{ state: 'verified', verifiedOwnerIds: ['su-late'] }],
      governor: {
        terminalVerdict: {
          outcome: 'unverified',
          action: 'wait',
          unreadyMemberIds: ['su-legacy-unready'],
        },
      },
    });
  });

  it('kills the exact repeatedly non-working identity before spawning its pre-pinned replacement', async () => {
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

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

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
  });

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
