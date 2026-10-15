/**
 * loop:end — the P-002 wind-down disposition gate (goal-mode-design-intent-
 * hardening-2026-08-16).
 *
 * The acceptance criterion, verbatim from the plan item: loop:end WITHOUT a
 * disposition on a still-active goal REFUSES, naming the missing arg and the
 * three legal values — and the refusal happens BEFORE deactivateLoop, so a
 * refused loop keeps firing. With a disposition, the loop ends, the goal row is
 * stamped, and the owner report (carry-note + reason folded in) is delivered.
 *
 * The gate's IO legs are mocked; the refusal/report BUILDERS run real
 * (importOriginal spread), so the wording asserted here is the wording the
 * production refusal actually carries.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/loop/end.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFleetWindDownLoopEndAuthorizationMock = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => null as boolean | null),
);
const readFleetWindDownLoopEndRequirementMock = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => null as boolean | null),
);

vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({
    ownerId: 'su-caller-own-id',
    ownerLabel: 'su · caller',
    source: 'omp-hook-session',
    workspaceId: 'ws-1',
    userId: null,
  })),
  resolveSelfLiteral: vi.fn((value: string | undefined, callerOwnerId: string) =>
    value === 'self' ? callerOwnerId : value,
  ),
}));
vi.mock('../../harness/routines/loop', () => ({
  deactivateLoop: vi.fn(async () => true),
  getLoopStatus: vi.fn(async () => ({ harnessSlug: 'papercusp', ownerId: 'su-caller-own-id', active: true })),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
// WI-10005199: the control-anchor projection loop:end attests. Default (see beforeEach) is a
// FAITHFUL anchor — the stop projected `loop.active:false` — so every pre-existing test sees an
// agreeing read and no `controlConsumerView`; the diverging fixtures below override it per-test.
const controlAnchorH = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('../coordination/control-anchor', () => ({
  refreshControlAnchorAfterMutation: controlAnchorH.refresh,
}));
vi.mock('../orders/open-directives-guard', () => ({
  checkOpenDirectivesGuard: vi.fn(async () => null),
}));
vi.mock('../../carry-note', () => ({ getLoopCarryNote: vi.fn(async () => null) }));
// EI-21349668185386229: the surviving-awaits read. Mocked (the real one queries
// PG); the KEY PREFIX stays the real constant's value so the filter under test
// is the production filter.
vi.mock('../../events/await/store', () => ({
  listActiveAwaits: vi.fn(async () => []),
  listParkedAwaitsForSubscribers: vi.fn(async () => []),
  hasPendingDeliberateWakeDelivery: vi.fn(async () => false),
  INBOX_WAKE_KEY_PREFIX: 'coord:inbox-wake:',
}));
vi.mock('../../events/await/compose-store', () => ({
  listActiveComposedRoots: vi.fn(async () => []),
}));
// P-009: the shared wake-source predicate runs REAL; only its two PG readers are mocked.
const predicateH = vi.hoisted(() => ({
  readHeldWorkItems: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  readWorkItemAwaitTargets: vi.fn(async (..._a: unknown[]) => new Map()),
}));
vi.mock('../../events/await/wake-source-predicate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/await/wake-source-predicate')>()),
  readHeldWorkItems: (...a: unknown[]) => predicateH.readHeldWorkItems(...a),
  readWorkItemAwaitTargets: (...a: unknown[]) => predicateH.readWorkItemAwaitTargets(...a),
}));
const getOwnerDirectiveMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => null as unknown));
vi.mock('../../owner-directives', () => ({ getOwnerDirective: (...a: unknown[]) => getOwnerDirectiveMock(...a) }));
// Keep the module graph light: these are transitive imports of the REAL
// wind-down-disposition module loaded via importOriginal below.
vi.mock('../../modes/store', () => ({
  getModeSubject: vi.fn(),
  getModes: vi.fn(async () => []),
}));
vi.mock('../coordination/tools/continuation-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coordination/tools/continuation-gate')>();
  return {
    ...actual,
    readFleetWindDownLoopEndRequirement: (...a: unknown[]) => readFleetWindDownLoopEndRequirementMock(...a),
    readFleetWindDownLoopEndAuthorization: (...a: unknown[]) =>
      readFleetWindDownLoopEndAuthorizationMock(...a),
  };
});
vi.mock('../coordination/escalations', () => ({ openEscalation: vi.fn(async () => ({})) }));
vi.mock('../../goals/wind-down-disposition', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../goals/wind-down-disposition')>();
  return {
    ...real,
    activeGoalForOwner: vi.fn(async () => null),
    applyGoalDisposition: vi.fn(async () => {}),
    deliverGoalWindDownReport: vi.fn(async () => {}),
    windDownDispositionGateEnabled: vi.fn(async () => true),
    // P-009 acceptance gate (consult-min-max-and-rubric-vetting-2026-08-17 D-004 §2).
    // MUST be mocked: the real one resolves its deps via `await import('../rubrics')` /
    // `('../scorecards')` and queries Postgres. Left real, this unit test's verdict flips
    // with PG REACHABILITY — the gate is positive-finding-only (`catch → satisfied:true`),
    // so it PASSES on a box with no PG and REFUSES on one with PG, where the fake goal
    // naturally has no acceptance rubric. That is what made this file "fail repeatedly"
    // (EI-20714629197442202) while reading green wherever PG was down. The gate's own
    // behavior is covered by its own tests; here we assert only that loop:end CONSULTS it
    // and honors BOTH verdicts.
    evaluateGoalAcceptanceGate: vi.fn(async () => ({ satisfied: true })),
  };
});

import { deactivateLoop, getLoopStatus } from '../../harness/routines/loop';
import { getLoopCarryNote } from '../../carry-note';
import {
  listActiveAwaits,
  listParkedAwaitsForSubscribers,
  hasPendingDeliberateWakeDelivery,
} from '../../events/await/store';
import { listActiveComposedRoots } from '../../events/await/compose-store';
import { applyRootDeadlines } from '../../events/await/effective-deadline';
import { getModes } from '../../modes/store';
import { checkOpenDirectivesGuard } from '../orders/open-directives-guard';
import {
  GOAL_DISPOSITIONS,
  activeGoalForOwner,
  applyGoalDisposition,
  deliverGoalWindDownReport,
  windDownDispositionGateEnabled,
  evaluateGoalAcceptanceGate,
} from '../../goals/wind-down-disposition';
import endTool, { isKeepaliveInboxWake, survivingAwaitsNote } from './end';

const deactivateLoopMock = deactivateLoop as unknown as ReturnType<typeof vi.fn>;
const getLoopStatusMock = getLoopStatus as unknown as ReturnType<typeof vi.fn>;
const getLoopCarryNoteMock = getLoopCarryNote as unknown as ReturnType<typeof vi.fn>;
const activeGoalForOwnerMock = activeGoalForOwner as unknown as ReturnType<typeof vi.fn>;
const applyGoalDispositionMock = applyGoalDisposition as unknown as ReturnType<typeof vi.fn>;
const deliverReportMock = deliverGoalWindDownReport as unknown as ReturnType<typeof vi.fn>;
const gateEnabledMock = windDownDispositionGateEnabled as unknown as ReturnType<typeof vi.fn>;
const acceptanceGateMock = evaluateGoalAcceptanceGate as unknown as ReturnType<typeof vi.fn>;
const listActiveAwaitsMock = listActiveAwaits as unknown as ReturnType<typeof vi.fn>;
const listActiveComposedRootsMock = listActiveComposedRoots as unknown as ReturnType<typeof vi.fn>;
const listParkedAwaitsMock = listParkedAwaitsForSubscribers as unknown as ReturnType<typeof vi.fn>;
const pendingDeliberateWakeMock = hasPendingDeliberateWakeDelivery as unknown as ReturnType<typeof vi.fn>;
const getModesMock = getModes as unknown as ReturnType<typeof vi.fn>;
const checkOpenDirectivesGuardMock = checkOpenDirectivesGuard as unknown as ReturnType<typeof vi.fn>;

const ACTIVE_GOAL = {
  goalId: 'ship-paid-app-3f9a1c',
  title: 'Ship the paid app',
  installSlug: 'papercusp',
  recordedDisposition: null,
};

const run = (args: Record<string, unknown> = {}) =>
  (
    endTool as unknown as {
      handler: (a: unknown, ctx: unknown) => Promise<{ content: [{ type: 'text'; text: string }]; isError?: boolean }>;
    }
  )
    .handler(args, {})
    .then((r) => ({ ...JSON.parse(r.content[0].text), isError: r.isError === true }));

beforeEach(() => {
  controlAnchorH.refresh.mockReset();
  controlAnchorH.refresh.mockResolvedValue({ generation: 8, state: { loop: { active: false, intervalSec: null } } });
  deactivateLoopMock.mockClear();
  deactivateLoopMock.mockResolvedValue(true);
  getLoopStatusMock.mockClear();
  getLoopStatusMock.mockResolvedValue({
    harnessSlug: 'papercusp',
    ownerId: 'su-caller-own-id',
    active: true,
  });
  getLoopCarryNoteMock.mockClear();
  getLoopCarryNoteMock.mockResolvedValue(null);
  activeGoalForOwnerMock.mockReset();
  activeGoalForOwnerMock.mockResolvedValue(null);
  applyGoalDispositionMock.mockReset();
  applyGoalDispositionMock.mockResolvedValue(undefined);
  deliverReportMock.mockReset();
  deliverReportMock.mockResolvedValue(undefined);
  gateEnabledMock.mockReset();
  gateEnabledMock.mockResolvedValue(true);
  acceptanceGateMock.mockReset();
  acceptanceGateMock.mockResolvedValue({ satisfied: true });
  listActiveAwaitsMock.mockReset();
  listActiveAwaitsMock.mockResolvedValue([]);
  listActiveComposedRootsMock.mockReset();
  listActiveComposedRootsMock.mockResolvedValue([]);
  listParkedAwaitsMock.mockReset();
  listParkedAwaitsMock.mockResolvedValue([]);
  pendingDeliberateWakeMock.mockReset();
  pendingDeliberateWakeMock.mockResolvedValue(false);
  getModesMock.mockReset();
  getModesMock.mockResolvedValue([]);
  readFleetWindDownLoopEndAuthorizationMock.mockReset();
  readFleetWindDownLoopEndAuthorizationMock.mockResolvedValue(null);
  readFleetWindDownLoopEndRequirementMock.mockReset();
  readFleetWindDownLoopEndRequirementMock.mockResolvedValue(null);
  checkOpenDirectivesGuardMock.mockReset();
  checkOpenDirectivesGuardMock.mockResolvedValue(null);
  predicateH.readHeldWorkItems.mockReset();
  predicateH.readHeldWorkItems.mockResolvedValue([]);
  predicateH.readWorkItemAwaitTargets.mockReset();
  predicateH.readWorkItemAwaitTargets.mockResolvedValue(new Map());
  getOwnerDirectiveMock.mockReset();
  getOwnerDirectiveMock.mockResolvedValue(null);
});

describe('the P-012 wake-less autonomy guard', () => {
  const mode = (id: string) => ({ mode: id });
  const parkedAwait = {
    subscriberId: 'su-caller-own-id',
    eventKey: 'release:green',
    note: 'resume when green',
    expiresTs: null,
    createdAt: '2026-08-25T00:00:00.000Z',
    rootId: null,
  };

  it('refuses BEFORE deactivation when AUTO remains active and no deliberate event park survives', async () => {
    getModesMock.mockResolvedValue([mode('auto')]);

    const got = await run({ reason: 'done for now' });

    expect(got).toMatchObject({
      isError: true,
      ok: false,
      error: 'wake_less_autonomy_refused',
      ownerId: 'su-caller-own-id',
      autonomyModes: ['auto'],
      requiredAcknowledgement: 'acknowledgeWakeLessAutonomy',
    });
    expect(String(got.message)).toContain('events:await');
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('returns an executable retry preserving every original loop:end argument', async () => {
    getModesMock.mockResolvedValue([mode('auto')]);
    const originalArgs = {
      ownerId: 'su-target',
      reason: 'leader wind-down',
      disposition: 'handoff',
      handoffTo: 'su-successor',
      outputs: { checkpoint: 'saved' },
      acknowledgeOpenDirectives: true,
      acknowledgeWakeLessAutonomy: false,
    };

    const got = await run(originalArgs);

    expect(got).toMatchObject({
      isError: true,
      error: 'wake_less_autonomy_refused',
      recovery: {
        action: 'retry',
        tool: 'loop:end',
        args: {
          ...originalArgs,
          acknowledgeWakeLessAutonomy: true,
        },
      },
    });
    expect(String(got.message)).toContain('Action required:');
    expect(String(got.message)).toContain('recovery.args');
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('derives autonomous overlays from the registry and checks the TARGET owner, not only the caller', async () => {
    getModesMock.mockResolvedValue([mode('drain')]);

    const got = await run({ ownerId: 'su-target', reason: 'leader wind-down' });

    expect(got).toMatchObject({
      isError: true,
      error: 'wake_less_autonomy_refused',
      ownerId: 'su-target',
      autonomyModes: ['drain'],
    });
    expect(getModesMock).toHaveBeenCalledWith('ws-1', 'su-target');
    expect(listParkedAwaitsMock).toHaveBeenCalledWith(['su-target']);
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('preserves an event-backed AUTO ending when a deliberate parked await survives', async () => {
    getModesMock.mockResolvedValue([mode('auto')]);
    listParkedAwaitsMock.mockResolvedValue([parkedAwait]);

    const got = await run({ reason: 'parked on release' });

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
  });

  it('allows a fired deliberate await whose wake delivery is still outstanding', async () => {
    getModesMock.mockResolvedValue([mode('auto')]);
    pendingDeliberateWakeMock.mockResolvedValue(true);

    const got = await run({ reason: 'event fired while this turn was still running' });

    expect(got).toMatchObject({ isError: false, ok: true, ended: true });
    expect(pendingDeliberateWakeMock).toHaveBeenCalledWith('su-caller-own-id');
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
  });

  it('recognizes a deliberate bounded coord:inbox-wake await from the parked-await read', async () => {
    getModesMock.mockResolvedValue([mode('auto')]);
    listParkedAwaitsMock.mockResolvedValue([
      {
        subscriberId: 'su-caller-own-id',
        eventKey: 'coord:inbox-wake:su-caller-own-id',
        expiresTs: '2026-09-14T03:30:00.000Z',
        note: 'explicit bounded inbox-wake park',
      },
    ]);

    const got = await run({ reason: 'parked on explicit inbox wake timeout' });

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
  });

  it('allows a claimless typed fleet wind-down cue to authorize ending without a parked await', async () => {
    getModesMock.mockResolvedValue([mode('drain')]);
    readFleetWindDownLoopEndAuthorizationMock.mockResolvedValue(true);

    const got = await run({ reason: 'typed fleet stand-down' });

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
    expect(readFleetWindDownLoopEndAuthorizationMock).toHaveBeenCalledWith({
      ownerId: 'su-caller-own-id',
      workspaceId: 'ws-1',
    });
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the wake-less guard fail-closed when typed fleet wind-down authorization is denied', async () => {
    getModesMock.mockResolvedValue([mode('drain')]);
    readFleetWindDownLoopEndAuthorizationMock.mockResolvedValue(false);

    const got = await run({ reason: 'untyped stand-down' });

    expect(got).toMatchObject({ isError: true, ok: false, error: 'wake_less_autonomy_refused' });
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('refuses a non-autonomous fleet member with no deliberate await unless terminal drainage is proven', async () => {
    readFleetWindDownLoopEndRequirementMock.mockResolvedValue(true);
    readFleetWindDownLoopEndAuthorizationMock.mockResolvedValue(false);

    const got = await run({ reason: 'scheduler reported spec_exhausted' });

    expect(got).toMatchObject({
      isError: true,
      ok: false,
      error: 'wake_less_autonomy_refused',
      autonomyModes: [],
    });
    expect(String(got.message)).toContain('fleet member');
    expect(readFleetWindDownLoopEndRequirementMock).toHaveBeenCalledWith({
      ownerId: 'su-caller-own-id',
      workspaceId: 'ws-1',
    });
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('lets a non-autonomous fleet member end when the typed terminal lane authorization is proven', async () => {
    readFleetWindDownLoopEndRequirementMock.mockResolvedValue(true);
    readFleetWindDownLoopEndAuthorizationMock.mockResolvedValue(true);

    const got = await run({ reason: 'typed terminal fleet stand-down' });

    expect(got).toMatchObject({ isError: false, ok: true, ended: true });
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the deliberate-await path for a non-autonomous fleet member', async () => {
    readFleetWindDownLoopEndRequirementMock.mockResolvedValue(true);
    listParkedAwaitsMock.mockResolvedValue([parkedAwait]);

    const got = await run({ reason: 'parked on leader gate' });

    expect(got).toMatchObject({ isError: false, ok: true, ended: true });
    expect(readFleetWindDownLoopEndRequirementMock).not.toHaveBeenCalled();
    expect(readFleetWindDownLoopEndAuthorizationMock).not.toHaveBeenCalled();
  });

  it('does not mistake a platform-armed claim-release interest for a deliberate event park', async () => {
    getModesMock.mockResolvedValue([mode('auto')]);
    // listActiveAwaits is the broad receipt read and can see this platform
    // interest. The guard deliberately uses listParkedAwaitsForSubscribers,
    // whose store predicate excludes bound_to.kind=work-item-claim.
    listActiveAwaitsMock.mockResolvedValue([{ id: 87786, eventKey: 'claim:released:WI-41467', expiresTs: null }]);

    const got = await run({});

    expect(got.error).toBe('wake_less_autonomy_refused');
    expect(listActiveAwaitsMock).not.toHaveBeenCalled();
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('allows a conscious wake-less ending with the explicit acknowledgement', async () => {
    getModesMock.mockResolvedValue([mode('cold-auto')]);

    const got = await run({ acknowledgeWakeLessAutonomy: true });

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary non-autonomous endings unchanged', async () => {
    getModesMock.mockResolvedValue([mode('ideate')]);

    const got = await run({});

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
  });

  it('leaves an already-inactive autonomous loop as the ordinary no-op instead of demanding an acknowledgement', async () => {
    getLoopStatusMock.mockResolvedValue({
      harnessSlug: 'papercusp',
      ownerId: 'su-caller-own-id',
      active: false,
    });
    deactivateLoopMock.mockResolvedValue(false);
    getModesMock.mockResolvedValue([mode('auto')]);

    const got = await run({});

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(false);
    expect(String(got.note)).toMatch(/No active loop found/);
    expect(getModesMock).not.toHaveBeenCalled();
  });

  it('does not apply the open-directives guard to a confirmed inactive no-op', async () => {
    getLoopStatusMock.mockResolvedValue({
      harnessSlug: 'papercusp',
      ownerId: 'su-caller-own-id',
      active: false,
    });
    deactivateLoopMock.mockResolvedValue(false);
    checkOpenDirectivesGuardMock.mockResolvedValue({
      ok: false,
      error: 'open_owner_directives',
      openCount: 1,
      directives: ['#10 open'],
      note: 'acknowledgement required',
    });

    const got = await run({});

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(false);
    expect(String(got.note)).toMatch(/No active loop found/);
    expect(checkOpenDirectivesGuardMock).not.toHaveBeenCalled();
  });

  it('still applies the open-directives guard while an active loop would be stopped', async () => {
    checkOpenDirectivesGuardMock.mockResolvedValue({
      ok: false,
      error: 'open_owner_directives',
      openCount: 1,
      directives: ['#10 open'],
      note: 'acknowledgement required',
    });

    const got = await run({});

    expect(got).toMatchObject({ isError: true, ok: false, error: 'open_owner_directives' });
    expect(checkOpenDirectivesGuardMock).toHaveBeenCalledTimes(1);
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('does not let an unrelated directive block successor cleanup of a predecessor handoff loop', async () => {
    getLoopStatusMock.mockResolvedValue({
      harnessSlug: 'papercusp',
      ownerId: 'su-predecessor',
      active: true,
    });
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    checkOpenDirectivesGuardMock.mockResolvedValue({
      ok: false,
      error: 'open_owner_directives',
      openCount: 1,
      directives: ['#10 open'],
      note: 'acknowledgement required',
    });

    const got = await run({
      ownerId: 'su-predecessor',
      disposition: 'handoff',
      handoffTo: 'su-successor',
      reason: 'demoted after leadership transfer',
    });

    expect(got).toMatchObject({ ok: true, ended: true, disposition: 'handoff', dispositionApplied: true });
    expect(checkOpenDirectivesGuardMock).not.toHaveBeenCalled();
    expect(deactivateLoopMock).toHaveBeenCalledWith('su-predecessor', {
      reason: 'demoted after leadership transfer',
    });
    expect(applyGoalDispositionMock).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'handoff', handoffTo: 'su-successor' }),
    );
  });

  it('fails open when the classification read is unavailable, preserving the always-stoppable contract', async () => {
    getModesMock.mockRejectedValue(new Error('pg down'));

    const got = await run({});

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
  });
});

// parked-agent-census-resumption-and-root-cause-2026-10-09 P-008: the guidance used to list
// "you are blocked on something external" as a stop reason and told AUTO sessions to pass
// acknowledgeWakeLessAutonomy on the FIRST call. The guard below refuses both for a claim holder.
describe('loop:end guidance (P-008)', () => {
  it('names blocked as NOT a stop and scopes the acknowledgement to a claimless stop', () => {
    const when = String((endTool as unknown as { guidance: { when: string } }).guidance.when);
    expect(when).not.toContain('blocked on something external');
    expect(when).not.toContain('first call');
    expect(when).toContain('Blocked is NOT a stop');
    expect(when).toContain('work_items:set_blocker');
    expect(when).toContain('no claims? Pass `acknowledgeWakeLessAutonomy:true`');
    expect(when).toContain('ownerStopDirectiveId');
  });
});

describe('the P-009 claim-holder guard (D-008 (1), D-009)', () => {
  const ME = 'su-caller-own-id';
  const held = (over: Record<string, unknown> = {}) => ({
    id: 'WI-1',
    harness: 'papercusp',
    status: 'wip',
    eventBlockers: [],
    ...over,
  });
  const park = (over: Record<string, unknown> = {}) => ({
    subscriberId: ME,
    eventKey: 'release:green',
    note: null,
    expiresTs: null,
    createdAt: '2026-10-11T00:00:00.000Z',
    rootId: null,
    ...over,
  });
  beforeEach(() => {
    getModesMock.mockResolvedValue([{ mode: 'auto' }]);
    predicateH.readHeldWorkItems.mockResolvedValue([held()]);
  });

  it('refuses an AUTO claim holder with no wake source EVEN with acknowledgeWakeLessAutonomy, before deactivation', async () => {
    const got = await run({ reason: 'stopping', acknowledgeWakeLessAutonomy: true });

    expect(got).toMatchObject({
      isError: true,
      ok: false,
      error: 'wake_less_claim_holder_refused',
      heldWorkItems: ['WI-1'],
      autonomyModes: ['auto'],
    });
    expect(deactivateLoopMock).not.toHaveBeenCalled();
    expect(predicateH.readHeldWorkItems).toHaveBeenCalledWith(ME, 'ws-1');
  });

  it('with no stated blocker, recovers by checkpoint + release, then the claimless retry', async () => {
    const got = await run({ reason: 'stopping' });

    expect(got.recovery.action).toBe('release-claims-then-retry');
    expect(got.recovery.steps.map((s: { tool: string }) => s.tool)).toEqual([
      'work_items:checkpoint',
      'work_items:release',
      'loop:end',
    ]);
    expect(got.recovery.steps[1].args).toEqual({ ids: ['WI-1'] });
    expect(got.recovery.steps[2].args).toEqual({ reason: 'stopping', acknowledgeWakeLessAutonomy: true });
  });

  it("offers a bounded events:await keyed to a blocked item's own unblocked event, never the acknowledgement", async () => {
    predicateH.readHeldWorkItems.mockResolvedValue([held({ status: 'blocked' })]);

    const got = await run({ reason: 'stopping', acknowledgeWakeLessAutonomy: true });

    expect(got.recovery.action).toBe('register-bounded-await-then-retry');
    expect(got.recovery.steps[0]).toEqual({
      tool: 'events:await',
      args: expect.objectContaining({ event: 'work-item:unblocked:WI-1', timeout_sec: 3600, on_timeout: 'wake' }),
    });
    expect(got.recovery.steps[1]).toEqual({ tool: 'loop:end', args: { reason: 'stopping' } });
    expect(JSON.stringify(got.recovery)).not.toContain('acknowledgeWakeLessAutonomy');
  });

  it('does not count an UNTIMED live await for a claim holder, and names it', async () => {
    listParkedAwaitsMock.mockResolvedValue([park({ eventKey: 'conversation:answered:conv-1' })]);

    const got = await run({});

    expect(got.error).toBe('wake_less_claim_holder_refused');
    expect(got.untimedWakeSources).toEqual(['conversation:answered:conv-1']);
  });

  it('lets a claim holder end with a BOUNDED wake-on-timeout await surviving', async () => {
    listParkedAwaitsMock.mockResolvedValue([park({ expiresTs: '2026-10-11T03:00:00.000Z' })]);

    const got = await run({});

    expect(got).toMatchObject({ isError: false, ok: true, ended: true });
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
  });

  it.each(['wake', 'expire'])('honors the composed audit root %s timeout policy for a claim holder', async (timeoutBehavior) => {
    // The composed writer keeps the delivery anchor unbounded/expire; its root
    // node owns the tree deadline AND policy. Exercise the shared read fold and
    // the real claim-holder predicate, rather than mocking a ready-made guarantee.
    const deadline = new Date(Date.now() + 900_000).toISOString();
    listParkedAwaitsMock.mockResolvedValue(applyRootDeadlines([
      park({ eventKey: 'composed-root:438', rootId: 438, timeoutBehavior: 'expire' }),
    ], new Map([[438, { expiresTs: deadline, timeoutBehavior }]])));

    const got = await run({});

    if (timeoutBehavior === 'wake') {
      expect(got).toMatchObject({ isError: false, ok: true, ended: true });
      expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
    } else {
      expect(got.error).toBe('wake_less_claim_holder_refused');
      expect(got.untimedWakeSources).toEqual(['composed-root:438']);
      expect(deactivateLoopMock).not.toHaveBeenCalled();
    }
  });

  it("does not count a bounded on_timeout:'expire' park as a guarantee: it lapses without waking anyone", async () => {
    // The parked-await read now carries timeout_behavior; before, a missing value defaulted to
    // 'wake' and this park read as the guarantee it is not.
    listParkedAwaitsMock.mockResolvedValue([
      park({ expiresTs: '2026-10-11T03:00:00.000Z', timeoutBehavior: 'expire' }),
    ]);

    const got = await run({});

    expect(got.error).toBe('wake_less_claim_holder_refused');
    expect(got.untimedWakeSources).toEqual(['release:green']);
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('lets a claim holder end while a deliberate wake delivery is still pending', async () => {
    pendingDeliberateWakeMock.mockResolvedValue(true);

    const got = await run({});

    expect(got).toMatchObject({ isError: false, ended: true });
  });

  it('does not count a bounded done-await on an item the session itself holds (self-deadlock)', async () => {
    listParkedAwaitsMock.mockResolvedValue([
      park({ eventKey: 'work-item:done:WI-1', expiresTs: '2026-10-11T03:00:00.000Z' }),
    ]);
    predicateH.readWorkItemAwaitTargets.mockResolvedValue(new Map([['WI-1', [{ status: 'wip', takenBy: ME }]]]));

    const got = await run({});

    expect(got.error).toBe('wake_less_claim_holder_refused');
    expect(got.deadAwaits).toEqual([{ eventKey: 'work-item:done:WI-1', reason: 'self-held-done' }]);
  });

  it('honors a verified owner stop directive without demanding the acknowledgement', async () => {
    getOwnerDirectiveMock.mockResolvedValue({ id: 77, workspaceId: 'ws-1', ownerId: ME, capturedByHook: true });

    const got = await run({ ownerStopDirectiveId: 77 });

    expect(got).toMatchObject({ isError: false, ok: true, ended: true, ownerStopDirectiveId: 77 });
    expect(getOwnerDirectiveMock).toHaveBeenCalledWith(77);
  });

  it.each([
    ['another session', { id: 77, workspaceId: 'ws-1', ownerId: 'su-someone-else', capturedByHook: true }, /belongs to/],
    ['an agent-recorded row', { id: 77, workspaceId: 'ws-1', ownerId: ME, capturedByHook: false }, /agent-recorded/],
    ['a missing row', null, /not found/],
  ])('rejects an owner stop directive from %s', async (_label, row, why) => {
    getOwnerDirectiveMock.mockResolvedValue(row);

    const got = await run({ ownerStopDirectiveId: 77 });

    expect(got.error).toBe('wake_less_claim_holder_refused');
    expect(String(got.ownerStopDirectiveRejected)).toMatch(why);
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it("passes an 'achieved' goal through (the acceptance gate already ran)", async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);

    const got = await run({ disposition: 'achieved', acknowledgeWakeLessAutonomy: true });

    expect(got).toMatchObject({ ok: true, ended: true, disposition: 'achieved' });
  });

  it('passes a typed fleet wind-down cue through', async () => {
    readFleetWindDownLoopEndAuthorizationMock.mockResolvedValue(true);

    const got = await run({});

    expect(got).toMatchObject({ ok: true, ended: true });
  });

  it('leaves a non-autonomous claim holder unaffected', async () => {
    getModesMock.mockResolvedValue([{ mode: 'ideate' }]);

    const got = await run({});

    expect(got).toMatchObject({ ok: true, ended: true });
    expect(predicateH.readHeldWorkItems).not.toHaveBeenCalled();
  });

  it('fails open when the hold read fails (always-stoppable): only the P-012 acknowledgement remains', async () => {
    predicateH.readHeldWorkItems.mockRejectedValue(new Error('pg down'));

    const got = await run({ acknowledgeWakeLessAutonomy: true });

    expect(got).toMatchObject({ ok: true, ended: true });
  });

  it('D-008 (1): a dead park no longer satisfies the claimless P-012 guard either', async () => {
    predicateH.readHeldWorkItems.mockResolvedValue([]);
    listParkedAwaitsMock.mockResolvedValue([park({ eventKey: 'work-item:done:WI-9' })]);
    predicateH.readWorkItemAwaitTargets.mockResolvedValue(new Map([['WI-9', [{ status: 'done', takenBy: null }]]]));

    const got = await run({});

    expect(got.error).toBe('wake_less_autonomy_refused');
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });
});

describe('the P-002 disposition gate (acceptance)', () => {
  it('REFUSES a goal-mode wind-down without a disposition — naming the arg and all three values — and does NOT end the loop', async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    const got = await run({});
    expect(got.isError).toBe(true);
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/\bdisposition\b/);
    for (const d of GOAL_DISPOSITIONS) expect(got.error).toContain(`'${d}'`);
    expect(got.goalId).toBe(ACTIVE_GOAL.goalId);
    // The refusal must land BEFORE deactivation: a refused loop keeps firing.
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  // P-009 (consult-min-max-and-rubric-vetting-2026-08-17 D-004 §2). These pin the SEAM,
  // not the gate's internals: that loop:end consults the acceptance gate for 'achieved'
  // ONLY, honors a refusal BEFORE deactivation, and does not consult it for the
  // dispositions that carry no acceptance claim.
  it("P-009: an UNSATISFIED acceptance gate refuses 'achieved' — and refuses BEFORE deactivation, so the loop keeps firing", async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    acceptanceGateMock.mockResolvedValue({
      satisfied: false,
      code: 'goal_acceptance_rubric_missing',
      message: 'REFUSED — no acceptance rubric names this goal.',
      rubricId: undefined,
    });
    const got = await run({ disposition: 'achieved', reason: 'I say it is done' });
    expect(got.isError).toBe(true);
    expect(got.ok).toBe(false);
    expect(got.error).toBe('goal_acceptance_rubric_missing');
    expect(got.goalId).toBe(ACTIVE_GOAL.goalId);
    // The whole point of the ordering: a refused claim must not leave the loop stopped.
    expect(deactivateLoopMock).not.toHaveBeenCalled();
    expect(applyGoalDispositionMock).not.toHaveBeenCalled();
    expect(deliverReportMock).not.toHaveBeenCalled();
  });

  it("P-009: 'killed' and 'handoff' never consult the acceptance gate — they carry no acceptance claim", async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    // Armed to REFUSE: if either disposition consulted it, the wind-down would fail here.
    acceptanceGateMock.mockResolvedValue({ satisfied: false, code: 'goal_acceptance_ungraded', message: 'x' });
    const killed = await run({ disposition: 'killed', reason: 'not worth finishing' });
    expect(killed.ok).toBe(true);
    expect(killed.ended).toBe(true);
    const handoff = await run({ disposition: 'handoff', handoffTo: 'su-peer', reason: 'passing it on' });
    expect(handoff.ok).toBe(true);
    expect(acceptanceGateMock).not.toHaveBeenCalled();
  });

  it('with a disposition: ends the loop, stamps the goal, and delivers the owner report with reason + carry-note folded in', async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    getLoopCarryNoteMock.mockResolvedValue('## Did\nplatform evidence lives here');
    const got = await run({ disposition: 'achieved', reason: 'all items shipped' });
    expect(got.isError).toBe(false);
    expect(got.ok).toBe(true);
    expect(got.ended).toBe(true);
    expect(got.disposition).toBe('achieved');
    expect(got.dispositionApplied).toBe(true);
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
    expect(applyGoalDispositionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        goalId: ACTIVE_GOAL.goalId,
        disposition: 'achieved',
        dispositionBy: 'su-caller-own-id',
      }),
    );
    // The report carries the evidence the agent already wrote.
    expect(deliverReportMock).toHaveBeenCalledTimes(1);
    const [, delivered] = deliverReportMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(String(delivered.body)).toContain('all items shipped');
    expect(String(delivered.body)).toContain('platform evidence lives here');
    // The carry-note was read via the harness the routine row named.
    expect(getLoopCarryNoteMock).toHaveBeenCalledWith({
      harness: 'papercusp',
      ownerId: 'su-caller-own-id',
    });
  });

  it('handoff flows through to the stamp and the report', async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    const got = await run({ disposition: 'handoff', handoffTo: 'su-next' });
    expect(got.ok).toBe(true);
    expect(applyGoalDispositionMock).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'handoff', handoffTo: 'su-next' }),
    );
    const [, delivered] = deliverReportMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(String(delivered.summary)).toContain('su-next');
  });

  it('a non-goal owner is unaffected — plain end, no goal reads beyond the gate probe', async () => {
    const got = await run({ reason: 'done here' });
    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
    expect(applyGoalDispositionMock).not.toHaveBeenCalled();
    expect(deliverReportMock).not.toHaveBeenCalled();
  });

  it('flag OFF disables the gate entirely: a goal owner without a disposition still stops', async () => {
    gateEnabledMock.mockResolvedValue(false);
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    const got = await run({});
    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
    // Gate off means the goal is never even consulted.
    expect(activeGoalForOwnerMock).not.toHaveBeenCalled();
  });

  it('a historical disposition cannot authorize ending a currently active GOAL loop', async () => {
    activeGoalForOwnerMock.mockResolvedValue({ ...ACTIVE_GOAL, recordedDisposition: 'handoff' });

    const got = await run({});
    expect(got.isError).toBe(true);
    expect(got.error).toContain('disposition');
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('an already-recorded disposition still covers a repeated inactive-loop cleanup', async () => {
    getLoopStatusMock.mockResolvedValue({
      harnessSlug: 'papercusp',
      ownerId: 'su-caller-own-id',
      active: false,
    });
    activeGoalForOwnerMock.mockResolvedValue({ ...ACTIVE_GOAL, recordedDisposition: 'handoff' });
    const got = await run({});
    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
  });

  it('FAIL-SOFT: a report failure downgrades to a warning — the loop stays ended', async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    applyGoalDispositionMock.mockRejectedValue(new Error('goals table unreachable'));
    const got = await run({ disposition: 'killed' });
    expect(got.isError).toBe(false);
    expect(got.ok).toBe(true);
    expect(got.ended).toBe(true);
    expect(got.dispositionApplied).toBe(false);
    expect(String(got.warning)).toMatch(/goals:update/);
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
  });

  it('a goal-resolution error passes the gate (positive-finding-only), never wedging the stop', async () => {
    activeGoalForOwnerMock.mockRejectedValue(new Error('pg down'));
    const got = await run({});
    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
  });
});

describe('argument schema', () => {
  it('accepts the three dispositions and rejects anything else', () => {
    const schema = (endTool as unknown as { args: { safeParse: (v: unknown) => { success: boolean } } }).args;
    for (const d of GOAL_DISPOSITIONS) expect(schema.safeParse({ disposition: d }).success).toBe(true);
    expect(schema.safeParse({ disposition: 'paused' }).success).toBe(false);
    expect(schema.safeParse({ disposition: 'handoff', handoffTo: 'su-next' }).success).toBe(true);
    expect(schema.safeParse({ acknowledgeWakeLessAutonomy: true }).success).toBe(true);
    expect(schema.safeParse({ acknowledgeWakeLessAutonomy: 'yes' }).success).toBe(false);
  });
});

describe('ownerId self selector (EI-23143537656999647)', () => {
  it('resolves self to the caller before reading and ending the loop', async () => {
    const got = await run({ ownerId: 'self', reason: 'finished' });

    expect(got).toMatchObject({ ok: true, ended: true, ownerId: 'su-caller-own-id' });
    expect(getLoopStatusMock).toHaveBeenCalledWith('su-caller-own-id');
    expect(deactivateLoopMock).toHaveBeenCalledWith('su-caller-own-id', { reason: 'finished' });
  });
});

// EI-21769332722376884 made `harness` an accepted-and-ignored arg here; this
// pins that so it cannot be silently reverted. The sibling read `loop:status`
// deliberately REJECTS `harness` and has a test asserting so
// (EI-20232692935534790), so a later consistency sweep across the loop tools
// could reasonably "correct" this one back to rejecting and re-open
// EI-21938191079973393. The two tools genuinely disagree; whichever way that is
// eventually reconciled, it should be a deliberate decision that has to delete a
// test, not a silent edit.
describe('the habitual `harness` argument (EI-21769332722376884)', () => {
  it('is accepted rather than rejected as invalid_args', () => {
    const schema = (endTool as unknown as { args: { safeParse: (v: unknown) => { success: boolean } } }).args;
    expect(schema.safeParse({ harness: 'papercusp' }).success).toBe(true);
    // Negative control: an undeclared arg still fails, so the assertion above is
    // a statement about `harness` specifically and not about a permissive schema
    // that would accept anything.
    expect(schema.safeParse({ notARealArgument: 'x' }).success).toBe(false);
  });

  it('is IGNORED — the caller’s own loop is ended, never one redirected by harness', async () => {
    const got = await run({ harness: 'some-other-harness' });

    expect(got).toMatchObject({ ok: true, ended: true });
    // Guarded behaviourally, not by field name: a schema-only assertion would
    // still pass if `harness` ever began redirecting the write somewhere else.
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
    expect(deactivateLoopMock.mock.calls[0][0]).toBe('su-caller-own-id');
  });
});

describe('loop:end — consumerView on the control-anchor projection (WI-10005199)', () => {
  it('stays silent when the projected loop agrees the stop landed', async () => {
    const got = await run({});
    expect(got.ended).toBe(true);
    expect(got.controlGeneration).toBe(8);
    expect(got).not.toHaveProperty('controlConsumerView');
  });

  it('DIVERGES — and says so on the payload — when the fail-soft refresh returned null', async () => {
    controlAnchorH.refresh.mockResolvedValueOnce(null);
    const got = await run({});
    // The stop itself still succeeded; the exception-only field tells the caller the consumer's
    // read (control_state->loop) cannot be shown to reflect it.
    expect(got.ended).toBe(true);
    expect(got.controlGeneration).toBeNull();
    expect(got.controlConsumerView).toMatchObject({
      readPath: 'harness_shared.session_briefs.control_state->loop',
      value: { active: null, intervalSec: null },
      divergedFromWrite: true,
    });
  });

  it('DIVERGES when the projection still shows the loop ACTIVE (the stale wake-source direction)', async () => {
    controlAnchorH.refresh.mockResolvedValueOnce({ generation: 5, state: { loop: { active: true, intervalSec: 300 } } });
    const got = await run({});
    expect(got.controlConsumerView).toMatchObject({ value: { active: true, intervalSec: 300 }, divergedFromWrite: true });
  });

  it('does not attest (and does not refresh) when no active loop was ended', async () => {
    deactivateLoopMock.mockResolvedValue(false);
    const got = await run({});
    expect(got.ended).toBe(false);
    expect(got).not.toHaveProperty('controlConsumerView');
    expect(controlAnchorH.refresh).not.toHaveBeenCalled();
  });
});

describe('the surviving-awaits receipt (EI-21349668185386229)', () => {
  // The disproven claim this fix retires. The new wordings ("no further LOOP
  // wakes") deliberately do not contain this substring, so the assertion
  // cannot pass by accident.
  const BLANKET_CLAIM = 'no further wakes will fire';

  it('with no surviving awaits: says so explicitly and never restates the blanket claim', async () => {
    const got = await run({});
    expect(got.ended).toBe(true);
    expect(got.survivingAwaits).toEqual([]);
    expect(String(got.note)).toMatch(/no independent event awaits remain/);
    expect(String(got.note)).not.toContain(BLANKET_CLAIM);
  });

  it('enumerates surviving awaits, filters the always-armed inbox-wake plumbing, and scopes the claim to LOOP wakes', async () => {
    listActiveAwaitsMock.mockResolvedValue([
      { id: 88515, eventKey: 'green-checkpoint:inconclusive', expiresTs: null },
      { id: 87786, eventKey: 'claim:released:EI-123', expiresTs: '2026-08-25T00:00:00Z' },
      // Liveness plumbing every live agent holds — must NOT render as a bench.
      { id: 90000, eventKey: 'coord:inbox-wake:su-caller-own-id', expiresTs: null },
    ]);
    const got = await run({});
    expect(got.ended).toBe(true);
    expect(got.survivingAwaits).toEqual([
      { await_id: 88515, event_key: 'green-checkpoint:inconclusive', expires_ts: null },
      { await_id: 87786, event_key: 'claim:released:EI-123', expires_ts: '2026-08-25T00:00:00Z' },
    ]);
    const note = String(got.note);
    expect(note).toMatch(/no further LOOP wakes will fire/);
    expect(note).toMatch(/2 independent event await\(s\) remain active/);
    expect(note).toContain('#88515 green-checkpoint:inconclusive');
    expect(note).toMatch(/events:cancel \{ await_ids \}/);
    expect(note).not.toContain(BLANKET_CLAIM);
  });

  it('excludes a fired composed-root anchor and its leaves even while their await rows remain unfired', async () => {
    listActiveAwaitsMock.mockResolvedValue([
      { id: 187540, eventKey: 'composed-root:406', expiresTs: '2026-09-19T14:20:35.167Z', rootId: 406, nodeId: null },
      { id: 187541, eventKey: 'member:ready', expiresTs: null, rootId: 406, nodeId: 901 },
    ]);
    // listActiveComposedRoots returns only roots whose node state is still active.
    // Root 406 has already fired, although its anchor await row remains unfired.
    listActiveComposedRootsMock.mockResolvedValue([]);

    const got = await run({});

    expect(got.survivingAwaits).toEqual([]);
    expect(String(got.note)).toMatch(/no independent event awaits remain active/);
  });

  it('reports one active composed root, omits its member leaves, and recommends root_ids for cancellation', async () => {
    listActiveAwaitsMock.mockResolvedValue([
      { id: 187550, eventKey: 'composed-root:407', expiresTs: '2026-09-19T14:20:35.167Z', rootId: 407, nodeId: null },
      { id: 187551, eventKey: 'member:ready', expiresTs: null, rootId: 407, nodeId: 902 },
      { id: 187552, eventKey: 'ordinary:ready', expiresTs: '2026-09-20T14:20:35.167Z', rootId: null, nodeId: null },
    ]);
    listActiveComposedRootsMock.mockResolvedValue([{ id: 407 }]);

    const got = await run({});

    expect(got.survivingAwaits).toEqual([
      { await_id: 187550, event_key: 'composed-root:407', expires_ts: '2026-09-19T14:20:35.167Z', root_id: 407 },
      { await_id: 187552, event_key: 'ordinary:ready', expires_ts: '2026-09-20T14:20:35.167Z' },
    ]);
    expect(String(got.note)).toContain('root #407 composed-root:407');
    expect(String(got.note)).toMatch(/events:cancel \{ await_ids \}/);
    expect(String(got.note)).toMatch(/events:cancel \{ root_ids \}/);
  });

  it('FAIL-SOFT: a read failure never blocks the stop — the note degrades to the scoped claim, survivingAwaits is omitted', async () => {
    listActiveAwaitsMock.mockRejectedValue(new Error('pg down'));
    const got = await run({});
    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
    expect(got.survivingAwaits).toBeUndefined();
    expect(String(got.note)).toMatch(/no further LOOP wakes will fire/);
    expect(String(got.note)).toMatch(/events:status to inspect/);
    expect(String(got.note)).not.toContain(BLANKET_CLAIM);
  });

  it('a no-op end (no active loop) does not read awaits at all', async () => {
    deactivateLoopMock.mockResolvedValue(false);
    const got = await run({});
    expect(got.ended).toBe(false);
    expect(got.survivingAwaits).toBeUndefined();
    expect(listActiveAwaitsMock).not.toHaveBeenCalled();
  });

  it('survivingAwaitsNote caps the enumeration at 10 while the count stays exact', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      await_id: 1000 + i,
      event_key: `key-${i}`,
    }));
    const note = survivingAwaitsNote(rows);
    expect(note).toMatch(/12 independent event await\(s\)/);
    expect(note).toContain('#1009 key-9');
    expect(note).not.toContain('#1010 key-10');
    expect(note).toContain('+2 more');
  });
});

describe('the keepalive exclusion is by SHAPE, not key prefix (WI-2146110 / EI-22395297051930111)', () => {
  // The reported defect: loop:end excluded EVERY `coord:inbox-wake:` await by key
  // prefix, so an await the caller had DELIBERATELY registered on that key
  // (timeout_sec 3600, on_timeout:'wake') was filtered out — and the receipt then
  // claimed "no independent event awaits remain active for this owner" while it was
  // live. It woke the session ~16s later.
  const INBOX_KEY = 'coord:inbox-wake:su-c2e1f693-ebc1-4fa9-bc0d-3efd769127d9';

  it('classifies the always-armed keepalive (unbounded + expires) as plumbing', () => {
    // Measured 2026-09-05: all 83 then-active coord:inbox-wake:* rows had exactly
    // this shape — timeout_behavior='expire', expires_ts IS NULL.
    expect(isKeepaliveInboxWake({ eventKey: INBOX_KEY, expiresTs: null, timeoutBehavior: 'expire' })).toBe(true);
  });

  it('does NOT classify a DELIBERATE bounded wake-on-timeout await on the same key as plumbing', () => {
    expect(
      isKeepaliveInboxWake({ eventKey: INBOX_KEY, expiresTs: '2026-09-05T05:42:26.895Z', timeoutBehavior: 'wake' }),
    ).toBe(false);
  });

  it('leaves an ordinary non-inbox-wake key alone whatever its shape', () => {
    expect(isKeepaliveInboxWake({ eventKey: 'claim:released:EI-123', expiresTs: null, timeoutBehavior: 'expire' })).toBe(
      false,
    );
  });

  it('still excludes an UNBOUNDED await on the keepalive key (indistinguishable by shape, and guarantees no wake)', () => {
    expect(isKeepaliveInboxWake({ eventKey: INBOX_KEY, expiresTs: null, timeoutBehavior: 'wake' })).toBe(true);
  });

  it('treats a missing timeoutBehavior as the store default of wake', () => {
    expect(isKeepaliveInboxWake({ eventKey: INBOX_KEY, expiresTs: '2026-09-05T05:42:26.895Z' })).toBe(false);
  });

  it('END-TO-END: the deliberate await SURFACES in survivingAwaits and the receipt stops claiming none remain', async () => {
    listActiveAwaitsMock.mockResolvedValue([
      // The keepalive — still filtered.
      { id: 90000, eventKey: INBOX_KEY, expiresTs: null, timeoutBehavior: 'expire' },
      // The reporter's actual await (#150975) — MUST be reported.
      { id: 150975, eventKey: INBOX_KEY, expiresTs: '2026-09-05T05:42:26.895Z', timeoutBehavior: 'wake' },
    ]);
    const got = await run({});
    expect(got.ended).toBe(true);
    expect(got.survivingAwaits).toEqual([
      { await_id: 150975, event_key: INBOX_KEY, expires_ts: '2026-09-05T05:42:26.895Z' },
    ]);
    const note = String(got.note);
    // The precise false statement the filing observed must no longer be emitted.
    expect(note).not.toMatch(/no independent event awaits remain/);
    expect(note).toMatch(/1 independent event await\(s\) remain active/);
    expect(note).toContain('#150975');
  });
});
