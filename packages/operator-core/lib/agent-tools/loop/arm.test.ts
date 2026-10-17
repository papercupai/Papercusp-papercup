/**
 * arm.test.ts — the loop:arm handler, focused on the WI-1471 owner-override fix:
 * an explicit `ownerId` arg should be honored (mirroring loop:end/loop:status),
 * instead of always binding to resolveAgentIdentity(ctx)'s resolved identity —
 * which, for a client-less caller (e.g. a ptool/curl bridge over the superuser
 * transport with no per-session id), silently falls back to the non-wake-reachable
 * `su-loopback` fixed identity.
 *
 * Everything downstream of identity resolution is mocked so the assertions are
 * purely about WHICH ownerId every downstream call receives.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/loop/arm.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';

// `onFlagChange` is required even though this suite never exercises it: importing
// locks/configure.ts pulls in txn-timeouts-config.ts, which calls onFlagChange() at
// MODULE SCOPE (D-010 event-driven refresh). A mock omitting it fails the whole file
// at COLLECTION with `No "onFlagChange" export is defined`, i.e. 0 tests run.
vi.mock('@papercusp/flags/server', () => ({
  getFlag: vi.fn(async () => true),
  onFlagChange: vi.fn(),
}));
vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    LOOPS: 'papercusp-loops',
    SCOPED_SUPERUSER_CLAMP: 'papercusp-scoped-superuser-clamp',
    SCHEDULER_SPEC_CLAIM: 'papercusp-scheduler-spec-claim',
  },
}));
// EI-19966210024116714: arm.ts reaches harness-core ONLY via a dynamic import inside the
// cross-workspace guard, which is itself gated on a CLAMPED superuser ctx — so this mock is
// never touched by any test that does not opt in with ctx.isSuperuser.
vi.mock('../../harness-core', () => ({ resolveWorkspaceForHarnessSlugIn: vi.fn(async () => null) }));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/wake-mode', () => ({
  resolveWakeMode: vi.fn(async () => 'auto'),
}));
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
vi.mock('../../acceptance-runtime-wait-guard', () => ({
  acceptancePlaneAdvisoryForWait: vi.fn(async () => null),
  mainWaitAdvisoryForWait: vi.fn(async () => null),
  mainWaitPlanReviewForWait: vi.fn(async () => null),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: vi.fn(() => 'papercusp') }));
vi.mock('../../pot/wake', () => ({ resolvePotHomeSlug: vi.fn(() => 'papercusp') }));
vi.mock('../pot/_resolve', () => ({ resolveHomePotSlug: vi.fn(async () => 'papercusp') }));
vi.mock('../../session-brief', () => ({ getSessionBrief: vi.fn(async () => null) }));
// WI-10005199: the control-anchor projection arm.ts attests. Default (see beforeEach) is a
// FAITHFUL anchor — the projection reflects what materializeLoop was asked to persist — so
// every pre-existing test sees an agreeing read and no `controlConsumerView`; the
// diverging fixtures below override it per-test.
const controlAnchorH = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('../coordination/control-anchor', () => ({
  refreshControlAnchorAfterMutation: controlAnchorH.refresh,
}));
// EI-21542193720279374 part (b): the cold-no-carry-note check. Defaults to an EXISTING
// note (readFailed:false) so every pre-existing test — most of which never anticipate
// this check — sees no unexpected coldNoCarryNoteWarning; per-test override simulates the
// absent-note case to exercise the warning path.
vi.mock('../../carry-note', () => ({
  getLoopCarryNoteWithMeta: vi.fn(async () => ({
    note: 'existing carry-note',
    updatedAtMs: 1000,
    readFailed: false,
  })),
}));
// EI-24899961156406639: the cold-carry host check. Defaults to an AVAILABLE host so every
// pre-existing cold-carry test sees no unexpected coldCarryNoHostWarning; per-test override
// simulates a hostless session. importOriginal keeps psu-pty-discovery's other exports intact.
vi.mock('../../events/await/psu-pty-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../events/await/psu-pty-discovery')>();
  return {
    ...actual,
    selfCompactionAvailabilityAsync: vi.fn(async () => ({ available: true, reason: null, host: {} as never })),
  };
});
vi.mock('../../harness/routines/loop', () => ({
  LOOP_INTERVAL_FLOOR_SEC: 60,
  buildLoopWakePrompt: vi.fn(() => 'kickoff-prompt'),
  materializeLoop: vi.fn(async () => ({ name: 'loop-x', nextFireAt: new Date('2026-01-01T00:00:00Z') })),
  // WI-2429 fix A: goal auto-detect of the driven work-item (cold-only). Default null
  // (no id) so the WI-1471 identity tests below are unaffected; per-test override sets it.
  detectDrivenWorkItemId: vi.fn(() => null),
  // EI-18221784742583615: the arm-time overwrite-guard read of the prior loop. Default null
  // (no prior loop) so every existing test is unaffected; per-test override sets a prior.
  readActiveLoopFacts: vi.fn(async () => null),
}));
vi.mock('../../harness/routines/monitor-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness/routines/monitor-policy')>();
  return {
    ...actual,
    admitMonitorArm: vi.fn(async ({ monitor }: { monitor: unknown }) => actual.prepareMonitorConfig(monitor)),
  };
});
// WI-2429 fix A: the arm-time auto-claim of the loop's driven work-item.
vi.mock('../../work-items', () => ({
  claimWorkItem: vi.fn(async () => null),
  classifyClaimFailure: vi.fn(() => ({ reason: 'gated', holder: null })),
  getWorkItem: vi.fn(async () => null),
  isClaimHoldParked: vi.fn((payload: unknown) => {
    if (!payload || typeof payload !== 'object') return false;
    return String((payload as Record<string, unknown>)._claimHold) === 'true';
  }),
  // EI-20304485841686120: the blocked-pin guard asks whether the row is ALREADY ours.
  // This mock factory replaces the whole module, so an omitted export is `undefined` and
  // calling it throws INSIDE the auto-claim try/catch — which surfaces as a generic
  // claim-refused reason rather than a missing-export error, i.e. every blocked-guard
  // assertion fails for a reason that looks like the guard misbehaving.
  isSelfOwnerRecord: vi.fn(
    (recorded: string | null | undefined, caller: string) =>
      !!recorded && String(recorded).trim() === String(caller ?? '').trim(),
  ),
}));
// EI-20123870155538062: loop:arm shares the by-id fleet-scope admission seam with
// work_items:claim. Keep the arm tests DB-free while pinning the ordering contract.
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitWorkItemForFleetTarget: vi.fn(async () => ({ allowed: true, scoped: false })),
  admitWorkItemForLoopTarget: vi.fn(async () => ({ allowed: true, scoped: false })),
}));
vi.mock('../../events/await/inbox-wake-arm', () => ({ armInboxWake: vi.fn(async () => undefined) }));
// EI-19447204017443244: the arm-time live-wake-await lookup behind the cap message.
// Defaults to EMPTY so every pre-existing handler test keeps its exact prior wording.
vi.mock('../../events/await/store', () => ({
  listWakeAwaitsForSubscriber: vi.fn(async () => ({ totalCount: 0, sample: [] })),
  hasLiveExactAwaitForSubscriberKey: vi.fn(async () => false),
}));
vi.mock('../../events/await/wake-reachability', () => ({
  probeWakeReachability: vi.fn(async () => ({
    reachable: true,
    channel: 'psu-socket',
    durableWhileAlive: true,
    summary: 'ok',
    awaitRepairable: false,
    wouldBeChannel: null,
  })),
}));
vi.mock('../../external-condition-reachability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../external-condition-reachability')>();
  return {
    ...actual,
    readEventConditionReachability: vi.fn(async () => ({
      verdict: 'reachable',
      basis: 'live-resolver',
      authoritative: true,
      evidence: 'test event is reachable',
      checkedAt: '2026-09-04T00:00:00.000Z',
    })),
  };
});
// EI-6878: @papercusp/db-org is a big package (transitively required by other
// bootstrap code in this import graph via @papercusp/agent-mcp) — partial-mock it
// via importOriginal so only isParkedNextFire is overridden and everything else
// (incl. `generated`) stays real. Same getTime()-equality contract the real
// isParkedNextFire uses, just against a locally-defined sentinel so this test
// doesn't depend on the exact NEXT_FIRE_PARKED value staying byte-identical.
const NEXT_FIRE_PARKED_FOR_TEST = new Date(8_640_000_000_000_000);
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isParkedNextFire: (d: Date | null) => d instanceof Date && d.getTime() === NEXT_FIRE_PARKED_FOR_TEST.getTime(),
  };
});

import {
  materializeLoop,
  buildLoopWakePrompt,
  detectDrivenWorkItemId,
  readActiveLoopFacts,
  type PriorLoopFacts,
} from '../../harness/routines/loop';
import { claimWorkItem, classifyClaimFailure, getWorkItem, type WorkItem } from '../../work-items';
import { admitWorkItemForFleetTarget, admitWorkItemForLoopTarget } from '../../scheduler/fleet-scope-admission';
import { armInboxWake } from '../../events/await/inbox-wake-arm';
import { probeWakeReachability } from '../../events/await/wake-reachability';
import { readEventConditionReachability, type ExternalConditionReachability } from '../../external-condition-reachability';
import { resolveHomePotSlug } from '../pot/_resolve';
import {
  admitMonitorArm,
  prepareMonitorConfig,
  type PersistedMonitorConfig,
} from '../../harness/routines/monitor-policy';
import { computeLoopOverwriteNote, resolveBlockedBackoff } from './arm';
import { mainWaitPlanReviewForWait } from '../../acceptance-runtime-wait-guard';
import { getLoopCarryNoteWithMeta } from '../../carry-note';
import { selfCompactionAvailabilityAsync } from '../../events/await/psu-pty-discovery';
import {
  mockRejectedTyped,
  mockResolvedOnceTyped,
  mockResolvedTyped,
  mockReturnOnceTyped,
  mockReturnTyped,
} from '../../testing/typed-mock';

const materializeM = vi.mocked(materializeLoop);
const buildPromptM = vi.mocked(buildLoopWakePrompt);
const detectM = vi.mocked(detectDrivenWorkItemId);
const priorLoopM = vi.mocked(readActiveLoopFacts);
const claimM = vi.mocked(claimWorkItem);
const classifyM = vi.mocked(classifyClaimFailure);
const getWiM = vi.mocked(getWorkItem);
const admitM = vi.mocked(admitWorkItemForFleetTarget);
const admitLoopM = vi.mocked(admitWorkItemForLoopTarget);
const armWakeM = vi.mocked(armInboxWake);
const probeM = vi.mocked(probeWakeReachability);
const homePotM = vi.mocked(resolveHomePotSlug);
const operatorHomeM = vi.mocked(operatorHomeHarnessSlug);
const monitorAdmissionM = vi.mocked(admitMonitorArm);
const briefM = vi.mocked((await import('../../session-brief')).getSessionBrief);
const potHomeM = vi.mocked((await import('../../pot/wake')).resolvePotHomeSlug);
const wakeAwaitsM = vi.mocked((await import('../../events/await/store')).listWakeAwaitsForSubscriber);
const exactAwaitM = vi.mocked((await import('../../events/await/store')).hasLiveExactAwaitForSubscriberKey);
const eventReachabilityM = vi.mocked(readEventConditionReachability);
// EI-19966210024116714: hoisted to module scope — `await import` is illegal inside a
// (non-async) describe callback, and this file's describes are synchronous.
const resolveWsM = vi.mocked((await import('../../harness-core')).resolveWorkspaceForHarnessSlugIn);
const carryNoteM = vi.mocked(getLoopCarryNoteWithMeta);
const selfCompactionM = vi.mocked(selfCompactionAvailabilityAsync);
const wakeModeM = vi.mocked((await import('../coordination/wake-mode')).resolveWakeMode);
const tool = (await import('./arm')).default;

describe('loop:arm — ambient workspace transaction safety (EI-20224334803038640)', () => {
  it('opts out because the handler owns its independent DB scopes', () => {
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>, context: Record<string, unknown> = {}) =>
  tool.handler(
    { intervalSec: 120, goal: 'g', ...args } as never,
    { harnessSlug: 'papercusp', ...context } as never,
  ) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

describe('loop:arm — awaited helper timings', () => {
  it('emits a cumulative named timing snapshot through ctx.metadata', async () => {
    const metadata = vi.fn();
    selfCompactionM.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { available: true, reason: null, host: {} as never };
    });
    const out = body(await call({ carry: 'cold' }, { metadata }));

    expect(out.ok).toBe(true);
    expect(metadata).toHaveBeenCalled();
    const recorded = metadata.mock.calls.at(-1)?.[0] as {
      loopArmStages?: {
        schemaVersion: string;
        unit: string;
        stages: Array<{ name: string; durationMs: number; elapsedMs: number }>;
      };
    };
    expect(recorded.loopArmStages).toMatchObject({
      schemaVersion: 'loop-arm-stage-timings-v1',
      unit: 'ms',
    });
    const stages = recorded.loopArmStages!.stages;
    const names = stages.map((stage) => stage.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'feature_flag',
        'resolve_wake_mode',
        'read_active_loop_facts',
        'main_wait_plan_review',
        'cold_carry_note_read',
        'cold_carry_host_discovery',
        'materialize_loop',
        'refresh_loop_control_anchor',
        'arm_inbox_wake',
        'probe_wake_reachability',
        'acceptance_plane_advisory',
      ]),
    );
    expect(stages.length).toBe(metadata.mock.calls.length);
    for (const stage of stages) {
      expect(Number.isFinite(stage.durationMs)).toBe(true);
      expect(stage.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(stage.elapsedMs)).toBe(true);
    }
    expect(stages.find((stage) => stage.name === 'cold_carry_host_discovery')?.durationMs).toBeGreaterThanOrEqual(20);
    expect(stages.indexOf(stages.find((stage) => stage.name === 'materialize_loop')!)).toBeLessThan(
      stages.indexOf(stages.find((stage) => stage.name === 'refresh_loop_control_anchor')!),
    );
  });
});

describe('loop:arm — materialization contention (EI-26021032500885630)', () => {
  it('returns a retryable unknown-state result for a raw PostgreSQL lock timeout', async () => {
    mockRejectedTyped(
      materializeM,
      Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    );

    const b = body(await call({ carry: 'cold' }));

    expect(b).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      pgCode: '55P03',
      timeoutSource: 'pg',
      ownerId: 'su-caller-own-id',
      state: 'unknown',
    });
    expect(b.message).toContain('routine mutation was not confirmed');
    expect(controlAnchorH.refresh).not.toHaveBeenCalled();
    expect(armWakeM).not.toHaveBeenCalled();
  });
});

describe('loop:arm — owner-directed pause guard (EI-24188436415268799)', () => {
  it('refuses to rearm a target whose effective wake mode is manual', async () => {
    wakeModeM.mockResolvedValueOnce('manual');
    const out = body(await call({ ownerId: 'su-paused-owner' }));

    expect(wakeModeM).toHaveBeenCalledWith('su-paused-owner');
    expect(out).toMatchObject({ ok: false, error: 'wake_mode_manual', ownerId: 'su-paused-owner' });
    expect(materializeM).not.toHaveBeenCalled();
    expect(armWakeM).not.toHaveBeenCalled();
  });

  it('fails closed when effective wake mode cannot be read', async () => {
    wakeModeM.mockRejectedValueOnce(new Error('settings unavailable'));
    const out = body(await call({ ownerId: 'su-paused-owner' }));

    expect(out).toMatchObject({ ok: false, error: 'wake_mode_unavailable', ownerId: 'su-paused-owner' });
    expect(materializeM).not.toHaveBeenCalled();
    expect(armWakeM).not.toHaveBeenCalled();
  });
});

describe('loop:arm — plan progress before a main wait', () => {
  it('refuses to arm before any durable loop is written when staging work is ready', async () => {
    vi.mocked(mainWaitPlanReviewForWait).mockResolvedValueOnce({
      plan: 'plan-a', allowWait: false, code: 'plan_main_wait_review_required',
      readyItems: ['P-002'], downstreamItems: [], waitRoots: ['P-001'], reasonAccepted: false,
      message: 'Continue P-002 on staging',
    });
    const out = body(await call({ goal: 'wait for green main before continuing plan-a' }));
    expect(out).toMatchObject({ ok: false, error: 'plan_main_wait_review_required', readyItems: ['P-002'] });
    expect(materializeM).not.toHaveBeenCalled();
  });
});

describe('loop:arm — consumerView on the control-anchor projection (WI-10005199)', () => {
  it('stays silent when the projected loop agrees with what was persisted', async () => {
    const b = body(await call({ intervalSec: 240 }));
    expect(b.ok).toBe(true);
    expect(b).not.toHaveProperty('controlConsumerView');
  });

  it('DIVERGES — and says so on the payload — when the fail-soft refresh returned null', async () => {
    controlAnchorH.refresh.mockResolvedValueOnce(null);
    const b = body(await call({ intervalSec: 240 }));
    // The arm itself still succeeded; the exception-only field is what tells the caller the
    // consumer's read (control_state->loop) cannot be shown to reflect it.
    expect(b.ok).toBe(true);
    expect(b.loop.controlGeneration).toBeNull();
    expect(b.controlConsumerView).toMatchObject({
      readPath: 'harness_shared.session_briefs.control_state->loop',
      value: { active: null, intervalSec: null },
      divergedFromWrite: true,
    });
  });

  it('DIVERGES when the projection still shows the loop inactive', async () => {
    controlAnchorH.refresh.mockResolvedValueOnce({ generation: 5, state: { loop: { active: false, intervalSec: null } } });
    const b = body(await call({ intervalSec: 240 }));
    expect(b.controlConsumerView).toMatchObject({ value: { active: false, intervalSec: null }, divergedFromWrite: true });
  });

  it('DIVERGES when the projection carries a stale interval', async () => {
    controlAnchorH.refresh.mockResolvedValueOnce({ generation: 6, state: { loop: { active: true, intervalSec: 900 } } });
    const b = body(await call({ intervalSec: 240 }));
    expect(b.controlConsumerView).toMatchObject({ value: { active: true, intervalSec: 900 }, divergedFromWrite: true });
  });

  it('compares against the interval materializeLoop PERSISTED, not the requested one', async () => {
    // If materializeLoop normalised the interval, the projection reads the stored value.
    mockResolvedOnceTyped(materializeM, {
      id: 'loop-x',
      name: 'loop-x',
      nextFireAt: new Date('2026-01-01T00:00:00Z'),
      targetRole: 'operator',
      intervalSec: 300,
      changed: true,
    });
    controlAnchorH.refresh.mockResolvedValueOnce({ generation: 7, state: { loop: { active: true, intervalSec: 300 } } });
    const b = body(await call({ intervalSec: 240 }));
    expect(b).not.toHaveProperty('controlConsumerView');
  });
});

const monitorConfig = (overrides: Record<string, unknown> = {}) => ({
  predicateKey: 'release:green:papercusp',
  stopCondition: 'the exact green verdict is recorded',
  authority: { kind: 'work-item', workItem: 'WI-42' },
  ...overrides,
});
const persistedMonitorConfig = (): PersistedMonitorConfig => ({
  predicateKey: 'release:green:papercusp',
  stopCondition: 'the exact green verdict is recorded',
  noDeltaBudget: 3,
  remainingNoDeltaBudget: 2,
  authority: { kind: 'work-item', workItem: 'WI-42' },
});

const asWorkItem = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  id: 'WI-TEST',
  kind: 'bug',
  family: 'issue',
  harness: 'papercusp',
  title: 'test work item',
  summary: '',
  state: 'open',
  assignee: null,
  takenAt: null,
  lastProgressAt: null,
  assignedBy: null,
  createdBy: null,
  severity: null,
  goalId: null,
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
  createdAt: '',
  updatedAt: '',
  closedAt: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  wakeModeM.mockResolvedValue('auto');
  materializeM.mockResolvedValue({ name: 'loop-x', nextFireAt: new Date('2026-01-01T00:00:00Z') } as never);
  mockResolvedTyped(probeM, {
    reachable: true,
    channel: 'psu-socket',
    durableWhileAlive: true,
    summary: 'ok',
    awaitRepairable: false,
    wouldBeChannel: null,
  });
  // WI-2429 defaults: no goal-detected id, claim returns null (unheld → re-read path).
  mockReturnTyped(detectM, null);
  claimM.mockResolvedValue(null as never);
  classifyM.mockReturnValue({ reason: 'gated', holder: null } as never);
  getWiM.mockResolvedValue(null as never);
  mockResolvedTyped(admitM, { allowed: true, scoped: false });
  mockResolvedTyped(admitLoopM, { allowed: true, scoped: false });
  exactAwaitM.mockResolvedValue(false);
  // EI-18221784742583615: default no prior loop ⇒ no overwrite note (every existing test).
  priorLoopM.mockResolvedValue(null as never);
  // EI-19447204017443244: default no live wake-awaits (the 'none' rendering).
  wakeAwaitsM.mockResolvedValue({ totalCount: 0, sample: [] } as never);
  eventReachabilityM.mockResolvedValue({
    verdict: 'reachable',
    basis: 'live-resolver',
    authoritative: true,
    evidence: 'test event is reachable',
    checkedAt: '2026-09-04T00:00:00.000Z',
  } as ExternalConditionReachability);
  homePotM.mockResolvedValue('papercusp');
  briefM.mockResolvedValue(null);
  potHomeM.mockReturnValue('papercusp');
  monitorAdmissionM.mockImplementation(async ({ monitor }) => prepareMonitorConfig(monitor));
  controlAnchorH.refresh.mockImplementation(async () => ({
    generation: 1,
    state: { loop: { active: true, intervalSec: materializeM.mock.calls.at(-1)?.[0]?.intervalSec ?? null } },
  }));
});

describe('loop:arm — WI-1471 ownerId override', () => {
  it("defaults to the caller's own resolved identity when ownerId is omitted", async () => {
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: true, loop: { ownerId: 'su-caller-own-id', ownerLabel: 'su · caller' } });
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-caller-own-id' }));
    expect(armWakeM).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-caller-own-id' }));
    expect(probeM).toHaveBeenCalledWith('su-caller-own-id');
  });

  it("resolves ownerId:'self' to the caller instead of creating an unreachable literal-self loop", async () => {
    const b = body(await call({ ownerId: 'self' }));
    expect(b).toMatchObject({ ok: true, loop: { ownerId: 'su-caller-own-id', ownerLabel: 'su · caller' } });
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-caller-own-id' }));
    expect(armWakeM).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-caller-own-id' }));
    expect(probeM).toHaveBeenCalledWith('su-caller-own-id');
  });

  it('honors an explicit ownerId — arms the loop FOR that owner, not the caller', async () => {
    const b = body(await call({ ownerId: 'su-target-other-session' }));
    expect(b).toMatchObject({ ok: true, loop: { ownerId: 'su-target-other-session' } });
    // shortOwnerLabel truncates a non-'pus-' id to 8 chars (cosmetic-only, per its docstring).
    expect(b.loop.ownerLabel).toBe('su · su-targe');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-target-other-session' }));
    expect(armWakeM).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-target-other-session' }));
    expect(probeM).toHaveBeenCalledWith('su-target-other-session');
  });

  it('never binds to su-loopback when an explicit ownerId is given — the WI-1471 regression case', async () => {
    // resolveAgentIdentity mock always returns 'su-caller-own-id' here, but a
    // client-less bridge would resolve SUPERUSER_FALLBACK_CLIENT_ID ('su-loopback')
    // instead — the override must win regardless of what identity resolved to.
    const b = body(await call({ ownerId: 'su-real-target' }));
    expect(b.loop.ownerId).not.toBe('su-loopback');
    expect(b.loop.ownerId).toBe('su-real-target');
  });

  it('the kickoff prompt is built for the OVERRIDDEN owner, not the caller', async () => {
    const { buildLoopWakePrompt } = await import('../../harness/routines/loop');
    await call({ ownerId: 'su-target-other-session' });
    expect(vi.mocked(buildLoopWakePrompt)).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-target-other-session' }),
    );
  });
});

describe('loop:arm — dispatch harness scope authority', () => {
  it('uses the verified request-origin harness when operator ctx is wildcard-scoped', async () => {
    homePotM.mockResolvedValue('sb-devboard-hive');
    potHomeM.mockImplementation((value) => value ?? null);

    const out = (await tool.handler(
      { intervalSec: 120, goal: 'g' } as never,
      {
        harnessSlug: '*',
        workspaceId: 'ws-1',
        requestOrigin: { transport: 'mcp', query: { harness: 'papercusp' } },
      } as never,
    )) as Out;
    const b = body(out);

    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp' } });
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'papercusp' }));
    expect(homePotM).not.toHaveBeenCalled();
  });

  it('rejects an inner harness that conflicts with the verified dispatch scope', async () => {
    const out = (await tool.handler(
      { intervalSec: 120, goal: 'g', harness: 'other-harness' } as never,
      {
        harnessSlug: '*',
        workspaceId: 'ws-1',
        requestOrigin: { transport: 'mcp', query: { harness: 'papercusp' } },
      } as never,
    )) as Out;
    const b = body(out);

    expect(b).toMatchObject({
      ok: false,
      error: 'harness_scope_mismatch',
      dispatchHarness: 'papercusp',
      requestedHarness: 'other-harness',
    });
    expect(materializeM).not.toHaveBeenCalled();
  });
});

describe('loop:arm — WI-5345: mode reaches materializeLoop + the response (previously only threaded into the wake-prompt template, never persisted/observable)', () => {
  it("defaults to mode:'work' when omitted", async () => {
    const b = body(await call({}));
    expect(b.loop.mode).toBe('work');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ mode: 'work' }));
  });

  it("an explicit mode:'monitor' reaches materializeLoop AND is echoed in the response", async () => {
    const b = body(await call({ mode: 'monitor', monitor: monitorConfig() }));
    expect(b.loop.mode).toBe('monitor');
    expect(b.loop.monitor).toMatchObject({
      predicateKey: 'release:green:papercusp',
      noDeltaBudget: 1,
      remainingNoDeltaBudget: 1,
    });
    expect(materializeM).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'monitor',
        monitor: expect.objectContaining({ predicateKey: 'release:green:papercusp' }),
      }),
    );
  });

  it('inherits an active monitor mode and policy when a cadence/carry retune omits mode and monitor', async () => {
    const monitor = persistedMonitorConfig();
    mockResolvedOnceTyped(
      priorLoopM,
      priorLoop({
        mode: 'monitor',
        monitor,
        carry: 'warm',
      }),
    );

    const b = body(await call({ carry: 'cold' }));

    expect(b).toMatchObject({
      ok: true,
      loop: {
        mode: 'monitor',
        carry: 'cold',
        monitor,
        workItem: 'WI-42',
      },
    });
    expect(monitorAdmissionM).not.toHaveBeenCalled();
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ mode: 'monitor', monitor }));
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ mode: 'monitor' }));
  });

  it("keeps explicit mode:'work' authoritative over an active monitor and drops its policy", async () => {
    const monitor = persistedMonitorConfig();
    mockResolvedOnceTyped(
      priorLoopM,
      priorLoop({
        mode: 'monitor',
        monitor,
      }),
    );

    const b = body(await call({ mode: 'work' }));

    expect(b).toMatchObject({ ok: true, loop: { mode: 'work' } });
    expect(b.loop).not.toHaveProperty('monitor');
    expect(monitorAdmissionM).not.toHaveBeenCalled();
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ mode: 'work' }));
    expect(materializeM.mock.calls.at(-1)![0]).not.toHaveProperty('monitor');
  });
});

describe('loop:arm — anti-babysitting P-003 typed monitor admission', () => {
  it('refuses a monitor with no typed config before claim or routine mutation', async () => {
    const b = body(await call({ mode: 'monitor' }));
    expect(b).toMatchObject({ ok: false, error: 'monitor_config_required' });
    expect(monitorAdmissionM).not.toHaveBeenCalled();
    expect(claimM).not.toHaveBeenCalled();
    expect(materializeM).not.toHaveBeenCalled();
    expect(armWakeM).not.toHaveBeenCalled();
  });

  it('propagates an authority refusal before claim, materialization, or wake registration', async () => {
    monitorAdmissionM.mockResolvedValueOnce({
      allowed: false,
      code: 'monitor_peer_owned_progress',
      message: 'WI-42 is already progressing under su-peer',
      details: { holder: 'su-peer' },
    });
    const b = body(await call({ mode: 'monitor', monitor: monitorConfig() }));
    expect(b).toMatchObject({ ok: false, error: 'monitor_peer_owned_progress' });
    expect(claimM).not.toHaveBeenCalled();
    expect(materializeM).not.toHaveBeenCalled();
    expect(armWakeM).not.toHaveBeenCalled();
  });

  it('uses an already-held work-item authority without re-running the claim mutation', async () => {
    const b = body(await call({ mode: 'monitor', monitor: monitorConfig(), workItem: 'wi-42' }));
    expect(b).toMatchObject({
      ok: true,
      loop: {
        workItem: 'WI-42',
        monitor: { authority: { kind: 'work-item', workItem: 'WI-42' } },
      },
    });
    expect(claimM).not.toHaveBeenCalled();
    expect(materializeM).toHaveBeenCalledTimes(1);
  });

  it('explains that fleet-leader monitors must omit a separate held workItem', async () => {
    const b = body(await call({
      mode: 'monitor',
      monitor: monitorConfig({ authority: { kind: 'fleet-leader', fleet: 'alpha' } }),
      workItem: 'WI-42',
    }));
    expect(b).toMatchObject({ ok: false, error: 'monitor_work_item_authority_mismatch' });
    expect(b.message).toContain('Omit top-level workItem WI-42');
    expect(b.message).toContain('fleet-leader');
    expect(claimM).not.toHaveBeenCalled();
    expect(materializeM).not.toHaveBeenCalled();
    expect(armWakeM).not.toHaveBeenCalled();
  });

  it('refuses a monitor when the owner already has the same exact await, before mutation', async () => {
    exactAwaitM.mockResolvedValueOnce(true);
    const b = body(await call({ mode: 'monitor', monitor: monitorConfig() }));
    expect(b).toMatchObject({
      ok: false,
      error: 'monitor_exact_await_duplicate',
      details: {
        predicateKey: 'release:green:papercusp',
        conflictingKind: 'exact-await',
      },
    });
    expect(claimM).not.toHaveBeenCalled();
    expect(materializeM).not.toHaveBeenCalled();
    expect(armWakeM).not.toHaveBeenCalled();
  });

  it('keeps ordinary work loops byte-compatible and never invokes monitor admission', async () => {
    const b = body(await call({ mode: 'work' }));
    expect(b.loop).toMatchObject({ mode: 'work' });
    expect(b.loop).not.toHaveProperty('monitor');
    expect(monitorAdmissionM).not.toHaveBeenCalled();
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ mode: 'work' }));
    expect(materializeM.mock.calls[0]![0]).not.toHaveProperty('monitor');
  });
});

describe('loop:arm — EI-20034001963934568: reject unverified bracketed owner tags in replayed goals', () => {
  it('refuses a bare [owner:…] goal tag before claiming or materializing the loop', async () => {
    const b = body(await call({ goal: '[owner:Jane 2026-08-10] continue the drain' }));

    expect(b).toMatchObject({ ok: false, error: 'unverified_goal_provenance' });
    expect(b.message).toContain('[turn:<session>@<timestamp>]');
    expect(materializeM).not.toHaveBeenCalled();
    expect(claimM).not.toHaveBeenCalled();
  });

  it('allows ordinary ownership/directive prose without a bracketed owner tag', async () => {
    const b = body(
      await call({ goal: 'A live gate ownership check and owner directive prose should be allowed' }),
    );

    expect(b.ok).toBe(true);
    expect(b).not.toHaveProperty('error', 'unverified_goal_provenance');
    expect(materializeM).toHaveBeenCalled();
  });

  it('allows the documented placeholder form, which describes the tag syntax rather than asserting attribution', async () => {
    const b = body(await call({ goal: '[owner:<name> <date>] continue the drain' }));

    expect(b.ok).toBe(true);
    expect(materializeM).toHaveBeenCalled();
  });

  it('allows a same-line [turn:…] anchor for a real owner tag', async () => {
    const b = body(
      await call({ goal: '[turn:abc123@2026-08-10T03:27:00Z] [owner:Jane 2026-08-10] continue the drain' }),
    );

    expect(b.ok).toBe(true);
    expect(materializeM).toHaveBeenCalled();
  });

  it('allows a loop goal that executes a recorded owner directive order', async () => {
    const b = body(await call({ goal: 'Execute owner directive order 10' }));

    expect(b.ok).toBe(true);
    expect(b).not.toHaveProperty('error', 'unverified_goal_provenance');
    expect(materializeM).toHaveBeenCalled();
  });

  it('allows carry prose that honors an open numbered owner directive', async () => {
    const b = body(await call({ goal: 'honoring open owner directive #10' }));

    expect(b.ok).toBe(true);
    expect(b).not.toHaveProperty('error', 'unverified_goal_provenance');
    expect(materializeM).toHaveBeenCalled();
  });
});

describe('loop:arm — WI-2429 fix A: auto-claim the driven work-item at arm time', () => {
  const claimedRow = asWorkItem({ id: 'X', assignee: 'su-caller-own-id' });

  it("EI-21302411209364135: infers an explicit item's harness before workspace-home fallback", async () => {
    // A workspace-scoped SU session carries the wildcard harness sentinel. Its home
    // pot is deliberately unrelated; the unscoped item lookup is the only valid scope
    // hint for this explicit cross-harness pin.
    homePotM.mockResolvedValue('sb-devboard-hive');
    potHomeM.mockImplementation((value) => (value === 'papercusp' ? 'papercusp' : null));
    getWiM.mockResolvedValue({
      id: 'WI-41214',
      state: 'open',
      harness: 'papercusp',
      assignee: 'su-caller-own-id',
    } as never);
    claimM.mockResolvedValue(claimedRow as never);

    const out = (await tool.handler(
      { intervalSec: 120, goal: 'g', workItem: 'wi-41214' } as never,
      { harnessSlug: '*', workspaceId: 'ws-1' } as never,
    )) as Out;
    const b = body(out);

    expect(getWiM).toHaveBeenCalledWith('WI-41214');
    expect(claimM).toHaveBeenCalledWith('WI-41214', 'su-caller-own-id', { harness: 'papercusp' });
    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp', workItem: 'WI-41214' } });
  });

  it("EI-21448192328031315: explicit workItem scope beats a stale concrete ctx harness when args.harness is omitted", async () => {
    const id = 'WI-41252';
    // This mirrors the reported call: the session context still names an unrelated
    // harness, while the canonical work-item belongs to Papercusp.
    potHomeM.mockImplementation((value) => value ?? null);
    getWiM.mockResolvedValue({ id, state: 'open', harness: 'papercusp', assignee: null } as never);
    claimM.mockResolvedValue(claimedRow as never);

    const b = body(
      (await tool.handler(
        { intervalSec: 120, goal: 'continue WI-41252', workItem: id } as never,
        { harnessSlug: 'sb-devboard-hive', workspaceId: 'ws-1' } as never,
      )) as Out,
    );

    expect(getWiM).toHaveBeenCalledWith(id);
    expect(claimM).toHaveBeenCalledWith(id, 'su-caller-own-id', { harness: 'papercusp' });
    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp', workItem: id } });
    expect(b.loop.harness).not.toBe('sb-devboard-hive');
  });

  it("EI-21358731971685285: infers an auto-detected cold goal item's harness before workspace-home fallback", async () => {
    const id = 'EI-21358731971685285';
    homePotM.mockResolvedValue('sb-devboard-hive');
    potHomeM.mockImplementation((value) => value ?? null);
    detectM.mockReturnValue(id as never);
    getWiM.mockImplementation(
      async (_id, harness) =>
        (harness === 'sb-devboard-hive' ? null : { id, state: 'open', harness: 'papercusp', assignee: null }) as never,
    );
    claimM.mockImplementation(
      async (_id, _owner, options) =>
        ((options as { harness?: string }).harness === 'papercusp' ? claimedRow : null) as never,
    );
    classifyM.mockReturnValue({ reason: 'not_found', holder: null } as never);

    const b = body(
      (await tool.handler(
        { intervalSec: 120, goal: `continue ${id}`, carry: 'cold' } as never,
        { harnessSlug: '*', workspaceId: 'ws-1' } as never,
      )) as Out,
    );

    expect(b).toMatchObject({
      ok: true,
      loop: { harness: 'papercusp', workItem: id },
      workItemClaim: { id, claimed: true },
    });
    expect(claimM).toHaveBeenCalledWith('EI-21358731971685285', 'su-caller-own-id', { harness: 'papercusp' });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ harness: 'papercusp', workItem: id }));
  });

  it('EI-20123870155538062: refuses an out-of-spec auto-claim before mutation, but still arms the loop', async () => {
    mockResolvedTyped(admitLoopM, {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: "work-item WI-OUT does not match fleet spec 'fleet-x@rev7'",
      refusal: { observed: {}, liftsWhen: 'the work-item matches the fleet claim spec', whoCanMakeItTrue: ['another-agent'] },
      scope: {
        ownerId: 'su-caller-own-id',
        fleetSlug: 'fleet-x',
        fleetRole: 'member',
        workspaceId: 'ws-1',
        record: {
          source: 'fleet',
          spec: {
            specVersion: '1.0',
            specId: 'fleet-x',
            revision: 7,
            view: { filter: { field: 'id', op: 'in', value: ['WI-OUT'] } },
            rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
          },
          revision: 7,
          updatedBy: null,
          updatedAt: null,
          fleetSlug: 'fleet-x',
        },
      },
    });

    const b = body(await call({ workItem: 'WI-OUT' }));

    expect(admitLoopM).toHaveBeenCalledWith({
      target: 'su-caller-own-id',
      workItemId: 'WI-OUT',
      harness: 'papercusp',
      workspaceId: 'ws-1',
      enforceSchedulerSpec: false,
    });
    expect(claimM).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      loop: { workItem: null },
      workItemClaim: {
        id: 'WI-OUT',
        claimed: false,
        reason: 'fleet_scope_violation',
        hint: "work-item WI-OUT does not match fleet spec 'fleet-x@rev7'",
      },
    });
    expect(b.note).toContain('fleet admission gate refused');
  });

  it('EI-21659493450381888: refuses a cold goal candidate excluded by a solo scheduler spec before mutation', async () => {
    detectM.mockReturnValue('WI-1774');
    mockResolvedTyped(admitLoopM, {
      allowed: false,
      scoped: false,
      code: 'scheduler_spec_violation',
      specId: 'only-pui-su-session-runtime-correction',
      revision: 3,
      reason:
        'work-item WI-1774 does not match active scheduler spec only-pui-su-session-runtime-correction@3 for su-caller-own-id; the loop auto-claim was refused before mutation',
      refusal: { observed: {}, liftsWhen: 'the work-item matches the active scheduler spec', whoCanMakeItTrue: ['self', 'owner'] },
    });

    const b = body(await call({ carry: 'cold', goal: 'continue the scoped plan; ignore WI-1774' }));

    expect(admitLoopM).toHaveBeenCalledWith({
      target: 'su-caller-own-id',
      workItemId: 'WI-1774',
      harness: 'papercusp',
      workspaceId: 'ws-1',
      enforceSchedulerSpec: true,
    });
    expect(claimM).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      loop: { workItem: null },
      workItemClaim: {
        id: 'WI-1774',
        claimed: false,
        reason: 'scheduler_spec_violation',
      },
    });
    expect(b.note).toContain('scheduler_spec_violation');
  });

  it('claims an EXPLICIT workItem for the loop owner (any carry) and names it in the wake prompt', async () => {
    getWiM.mockResolvedValue({ id: 'WI-42', state: 'open', assignee: null } as never);
    claimM.mockResolvedValue(claimedRow as never);
    const b = body(await call({ workItem: 'WI-42' }));
    expect(claimM).toHaveBeenCalledWith('WI-42', 'su-caller-own-id', { harness: 'papercusp' });
    expect(b).toMatchObject({ ok: true, loop: { workItem: 'WI-42' }, workItemClaim: { id: 'WI-42', claimed: true } });
    expect(b.note).toContain('Auto-claimed work-item WI-42');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ workItem: 'WI-42' }));
    // the held id is passed to the wake-prompt builder so the mandate is concrete
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: 'WI-42' }));
  });

  it('normalizes an explicit lower-case id to the canonical upper-case before claiming', async () => {
    getWiM.mockResolvedValue({ id: 'WI-42', state: 'open', assignee: null } as never);
    claimM.mockResolvedValue(claimedRow as never);
    await call({ workItem: 'wi-42' });
    expect(claimM).toHaveBeenCalledWith('WI-42', 'su-caller-own-id', { harness: 'papercusp' });
  });

  it('on a COLD loop with no explicit workItem, auto-detects + claims the id from the goal', async () => {
    detectM.mockReturnValue('WI-7' as never);
    claimM.mockResolvedValue(claimedRow as never);
    const b = body(await call({ carry: 'cold', goal: 'root-cause WI-7' }));
    expect(detectM).toHaveBeenCalledWith('root-cause WI-7');
    expect(claimM).toHaveBeenCalledWith('WI-7', 'su-caller-own-id', { harness: 'papercusp' });
    expect(b.loop.workItem).toBe('WI-7');
  });

  it('EI-22679872218957064: a WARM goal never auto-detects or binds prohibited IDs', async () => {
    detectM.mockReturnValue('WI-10000659' as never);
    const b = body(
      await call({
        carry: 'warm',
        goal: 'WI-10000659 is DONE and RELEASED. Do NOT re-grade, re-emit, re-claim, or re-read it; continue the next lane.',
      }),
    );

    expect(detectM).not.toHaveBeenCalled();
    expect(claimM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, loop: { workItem: null }, workItemClaim: null });
  });

  it('detects the full cold-loop id from a goal before the soft 4000-character clamp', async () => {
    const id = 'EI-21402283154473718';
    const goal = `${'x'.repeat(3995)}${id}`;
    detectM.mockReturnValue(id as never);
    claimM.mockResolvedValue(claimedRow as never);

    const b = body(await call({ carry: 'cold', goal }));

    // The raw goal is the structural source; the bounded copy is only for persistence
    // and prompt rendering. This catches a partial `EI-214022` candidate at the cap.
    expect(detectM).toHaveBeenCalledWith(goal);
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ goal: goal.slice(0, 4000) }));
    expect(claimM).toHaveBeenCalledWith(id, 'su-caller-own-id', { harness: 'papercusp' });
    expect(b.loop.workItem).toBe(id);
  });

  it('refuses a terminal workItem pin without claiming or binding it to the wake prompt', async () => {
    getWiM.mockResolvedValue({ id: 'EI-DONE', state: 'done', assignee: null } as never);
    const b = body(await call({ workItem: 'EI-DONE' }));
    expect(claimM).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      loop: { workItem: null },
      workItemClaim: { id: 'EI-DONE', claimed: false, reason: 'terminal' },
    });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
  });

  it('refuses a terminal workItem discovered from a COLD goal without claiming or binding it to the wake prompt', async () => {
    detectM.mockReturnValue('EI-DONE');
    getWiM.mockResolvedValue({ id: 'EI-DONE', state: 'done', assignee: null } as never);
    const b = body(await call({ carry: 'cold', goal: 'EI-DONE is CLOSED; do not re-litigate it.' }));

    expect(detectM).toHaveBeenCalledWith('EI-DONE is CLOSED; do not re-litigate it.');
    expect(claimM).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      loop: { workItem: null },
      workItemClaim: { id: 'EI-DONE', claimed: false, reason: 'terminal' },
    });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
  });

  it('EI-21681983105634595: refuses an explicit claim-held item without touching its governor lease', async () => {
    mockResolvedTyped(getWiM, asWorkItem({
      id: 'WI-333195',
      state: 'open',
      assignee: null,
      payload: {
        _claimHold: true,
        claim_hold_by: 'system:resource-governor',
        claim_hold_reason: 'durable resource-governor queue; only governor lease transitions may select',
      },
    }));
    mockResolvedTyped(claimM, claimedRow);

    const b = body(await call({ workItem: 'WI-333195' }));

    expect(claimM).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      loop: { workItem: null },
      workItemClaim: {
        id: 'WI-333195',
        claimed: false,
        reason: 'claim_hold',
      },
    });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
  });

  it('EI-21681983105634595: refuses a claim-held item auto-detected from a COLD goal', async () => {
    detectM.mockReturnValue('WI-333195');
    mockResolvedTyped(getWiM, asWorkItem({
      id: 'WI-333195',
      state: 'open',
      assignee: null,
      payload: { _claimHold: 'true', claim_hold_by: 'system:resource-governor' },
    }));
    mockResolvedTyped(claimM, claimedRow);

    const b = body(await call({ carry: 'cold', goal: 'retune the loop for WI-333195' }));

    expect(claimM).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      loop: { workItem: null },
      workItemClaim: { id: 'WI-333195', claimed: false, reason: 'claim_hold' },
    });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
  });

  // EI-20304485841686120 — the THIRD member of the terminal / claim_hold guard chain.
  // `blocked` is a resolver-owned floor: scheduler:get_next will not re-offer it (it is not
  // a requestable `states` value), yet it is non-terminal so it counts against
  // maxConcurrentClaims. Auto-binding one under the default cap of 1 starves the member from
  // ALL work, and the resulting refusal fires before lane evaluation (EI-12095) so it reads
  // as a bare "claim cap reached" with nothing pointing back at the binding that caused it.
  it('EI-20304485841686120: refuses an explicit BLOCKED pin so it cannot consume the sole claim slot', async () => {
    mockResolvedTyped(getWiM, asWorkItem({ id: 'WI-3746', state: 'blocked', assignee: null }));
    mockResolvedTyped(claimM, claimedRow);

    const b = body(await call({ workItem: 'WI-3746' }));

    expect(claimM).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      // The loop still ARMS; only the optional death-resilience binding is skipped.
      loop: { workItem: null },
      workItemClaim: { id: 'WI-3746', claimed: false, reason: 'blocked' },
    });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
  });

  it('EI-20304485841686120: refuses a BLOCKED item auto-detected from a COLD goal', async () => {
    detectM.mockReturnValue('WI-3746');
    mockResolvedTyped(getWiM, asWorkItem({ id: 'WI-3746', state: 'blocked', assignee: null }));
    mockResolvedTyped(claimM, claimedRow);

    const b = body(await call({ carry: 'cold', goal: 'drive WI-3746 to a close' }));

    expect(claimM).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      loop: { workItem: null },
      workItemClaim: { id: 'WI-3746', claimed: false, reason: 'blocked' },
    });
  });

  // NEGATIVE CONTROL — the load-bearing half. A guard that only ever refuses would pass
  // every assertion above while breaking the legitimate case, and this is the one the
  // narrow scoping exists for: when the member ALREADY holds the blocked item its slot is
  // spent either way, so skipping would gratuitously drop the death-resilience anchor of
  // someone looping precisely to UNBLOCK it. Binding must still happen here.
  it('EI-20304485841686120: still binds a BLOCKED item the caller ALREADY holds (guard must not over-fire)', async () => {
    mockResolvedTyped(
      getWiM,
      asWorkItem({ id: 'WI-3746', state: 'blocked', assignee: 'su-caller-own-id' }),
    );
    mockResolvedTyped(claimM, claimedRow);

    const b = body(await call({ workItem: 'WI-3746' }));

    expect(claimM).toHaveBeenCalledWith('WI-3746', 'su-caller-own-id', { harness: 'papercusp' });
    expect(b).toMatchObject({
      ok: true,
      loop: { workItem: 'WI-3746' },
      workItemClaim: { id: 'WI-3746', claimed: true },
    });
  });

  it('does NOT auto-detect from the goal on a WARM loop — warm behaviour stays byte-identical', async () => {
    detectM.mockReturnValue('WI-7' as never);
    const b = body(await call({ carry: 'warm', goal: 'root-cause WI-7' }));
    expect(detectM).not.toHaveBeenCalled();
    expect(claimM).not.toHaveBeenCalled();
    expect(b.loop.workItem).toBeNull();
    expect(b.workItemClaim).toBeNull();
  });

  it('a claim_conflict is NON-FATAL: the loop still arms, the prompt is NOT told "you hold it", and the holder is surfaced', async () => {
    claimM.mockResolvedValue(null as never); // compare-and-claim lost
    getWiM.mockResolvedValue({ id: 'WI-HELD', assignee: 'peer' } as never);
    classifyM.mockReturnValue({ reason: 'conflict', holder: 'peer' } as never);
    const b = body(await call({ workItem: 'WI-HELD' }));
    expect(b.ok).toBe(true); // armed regardless
    expect(b.loop.workItem).toBeNull(); // we do NOT hold it
    expect(b.workItemClaim).toMatchObject({ id: 'WI-HELD', claimed: false, reason: 'claim_conflict', holder: 'peer' });
    expect(b.note).toContain('already held by peer');
    // a conflicted candidate must NOT be named as held in the wake prompt
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
  });

  it('a claim throwing is swallowed — arming never fails on the best-effort claim leg', async () => {
    claimM.mockRejectedValue(new Error('db down') as never);
    const b = body(await call({ workItem: 'WI-99' }));
    expect(b.ok).toBe(true);
    expect(b.loop.workItem).toBeNull();
    expect(b.workItemClaim).toMatchObject({ id: 'WI-99', claimed: false });
    expect(b.workItemClaim.reason).toContain('db down');
  });
});

describe('loop:arm — flag gate + harness resolution (unaffected by the ownerId change)', () => {
  it('returns loops_disabled when the feature flag is off', async () => {
    const { getFlag } = await import('@papercusp/flags/server');
    vi.mocked(getFlag).mockResolvedValueOnce(false as never);
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: false, error: 'loops_disabled' });
    expect(materializeM).not.toHaveBeenCalled();
  });

  it('fails loud with no_harness when neither args.harness nor ctx.harnessSlug nor a home hive resolves', async () => {
    const { resolvePotHomeSlug } = await import('../../pot/wake');
    // The home pointer always names a slug; here it names no registered pot.
    operatorHomeM.mockReturnValueOnce('unregistered-home');
    vi.mocked(resolvePotHomeSlug)
      .mockReturnValueOnce(null as never)
      .mockReturnValueOnce(null as never);
    const out = (await tool.handler({ intervalSec: 120, goal: 'g' } as never, {} as never)) as Out;
    const b = body(out);
    expect(b).toMatchObject({ ok: false, error: 'no_harness' });
    expect(operatorHomeM).toHaveBeenCalledOnce();
  });

  it('EI-21355404648960524: treats an explicitly empty harness as omitted and resolves the operator home', async () => {
    operatorHomeM.mockReturnValueOnce('workspace-home');
    mockReturnOnceTyped(potHomeM, 'workspace-home');
    const out = (await tool.handler(
      { intervalSec: 120, goal: 'g', harness: '' } as never,
      { harnessSlug: '*', workspaceId: 'ws-1' } as never,
    )) as Out;
    const b = body(out);

    expect(b).toMatchObject({ ok: true, loop: { harness: 'workspace-home' } });
    expect(operatorHomeM).toHaveBeenCalledOnce();
    expect(homePotM).not.toHaveBeenCalled();
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'workspace-home' }));
    expect(briefM).not.toHaveBeenCalled();
  });

  it('EI-20185529721601434: resolves a workspace-scoped wildcard session to the canonical operator home', async () => {
    operatorHomeM.mockReturnValueOnce('workspace-home');
    mockReturnOnceTyped(potHomeM, 'workspace-home');
    const out = (await tool.handler(
      { intervalSec: 120, goal: 'g' } as never,
      { harnessSlug: '*', workspaceId: 'ws-1' } as never,
    )) as Out;
    const b = body(out);
    expect(operatorHomeM).toHaveBeenCalledOnce();
    expect(homePotM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, loop: { harness: 'workspace-home' } });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ harness: 'workspace-home' }));
  });

  it('EI-20211399000978706: reuses the concrete harness persisted by coord:orient before workspace-home fallback', async () => {
    mockResolvedOnceTyped(briefM, {
      ownerId: 'su-caller-own-id',
      workspaceId: 'ws-1',
      ownerLabel: 'su · caller',
      source: 'test',
      intent: '',
      currentPlanSlug: null,
      currentFiles: [],
      ambientExcludedRefs: null,
      harnessSlug: 'oriented-harness',
      potSlug: null,
      goalId: null,
      nativeSessionId: null,
      lifecycle: null,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    // When the operator-home pointer names no registered pot, retain the durable coord:orient scope.
    operatorHomeM.mockReturnValueOnce('unregistered-home');
    potHomeM.mockReturnValueOnce(null as never).mockReturnValueOnce('oriented-harness');
    const out = (await tool.handler(
      { intervalSec: 120, goal: 'g' } as never,
      { harnessSlug: '*', workspaceId: 'ws-1' } as never,
    )) as Out;
    const b = body(out);
    expect(briefM).toHaveBeenCalledWith({ ownerId: 'su-caller-own-id' });
    expect(operatorHomeM).toHaveBeenCalledOnce();
    expect(homePotM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, loop: { harness: 'oriented-harness' } });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ harness: 'oriented-harness' }));
  });

  it('EI-21545786648324241: an active oriented plan scope beats a stale concrete dispatch context', async () => {
    briefM.mockResolvedValueOnce({
      ownerId: 'su-caller-own-id',
      workspaceId: 'ws-1',
      ownerLabel: 'su · caller',
      source: 'active-plan',
      intent: 'continue papercusp P-007 / WI-42196',
      currentPlanSlug: 'papercusp-plan',
      currentFiles: [],
      ambientExcludedRefs: null,
      harnessSlug: 'papercusp',
      potSlug: null,
      goalId: null,
      nativeSessionId: null,
      lifecycle: null,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    potHomeM.mockImplementation((explicit, ctxSlug) => explicit ?? ctxSlug ?? null);

    const out = (await tool.handler(
      { intervalSec: 120, goal: 'continue the papercusp plan' } as never,
      { harnessSlug: 'sb-devboard-hive', workspaceId: 'ws-1' } as never,
    )) as Out;
    const b = body(out);

    expect(briefM).toHaveBeenCalledWith({ ownerId: 'su-caller-own-id' });
    expect(homePotM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp' } });
    expect(b.loop.harness).not.toBe('sb-devboard-hive');
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ harness: 'papercusp' }));
  });

  it('EI-21588980031874016: an active oriented plan scope beats a stale concrete request origin on a fresh arm', async () => {
    briefM.mockResolvedValueOnce({
      ownerId: 'su-caller-own-id',
      workspaceId: 'ws-1',
      ownerLabel: 'su · caller',
      source: 'active-plan',
      intent: 'continue papercusp P-007 / EI-21588980031874016',
      currentPlanSlug: 'papercusp-plan',
      currentFiles: [],
      ambientExcludedRefs: null,
      harnessSlug: 'papercusp',
      potSlug: null,
      goalId: null,
      nativeSessionId: null,
      lifecycle: null,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    // The outer tools:invoke request can retain the old harness even after the
    // session has oriented onto this active plan. A fresh arm must not install
    // the loop under that stale concrete request-origin scope.
    potHomeM.mockImplementation((explicit, ctxSlug) => explicit ?? ctxSlug ?? null);

    const out = (await tool.handler(
      { intervalSec: 120, goal: 'continue the papercusp plan' } as never,
      {
        harnessSlug: 'sb-devboard-hive',
        workspaceId: 'ws-1',
        requestOrigin: { transport: 'mcp', query: { harness: 'sb-devboard-hive' } },
      } as never,
    )) as Out;
    const b = body(out);

    expect(briefM).toHaveBeenCalledWith({ ownerId: 'su-caller-own-id' });
    expect(homePotM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp' } });
    expect(b.loop.harness).not.toBe('sb-devboard-hive');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'papercusp' }));
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ harness: 'papercusp' }));
  });

  it('EI-21545786648324241: a historical brief with no active plan does not override a concrete context', async () => {
    briefM.mockResolvedValueOnce({
      ownerId: 'su-caller-own-id',
      workspaceId: 'ws-1',
      ownerLabel: 'su · caller',
      source: 'historical',
      intent: 'old papercusp work',
      currentPlanSlug: null,
      currentFiles: [],
      ambientExcludedRefs: null,
      harnessSlug: 'papercusp',
      potSlug: null,
      goalId: null,
      nativeSessionId: null,
      lifecycle: null,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    potHomeM.mockImplementation((explicit, ctxSlug) => explicit ?? ctxSlug ?? null);

    const out = (await tool.handler(
      { intervalSec: 120, goal: 'start unrelated work' } as never,
      { harnessSlug: 'sb-devboard-hive', workspaceId: 'ws-1' } as never,
    )) as Out;

    expect(body(out)).toMatchObject({ ok: true, loop: { harness: 'sb-devboard-hive' } });
  });

  it('EI-24748685399658874: operator home beats an unrelated first Pot for a wildcard operator session', async () => {
    briefM.mockResolvedValue({
      ownerId: 'su-caller-own-id',
      workspaceId: 'ws-1',
      ownerLabel: 'su · caller',
      source: 'stale-session',
      intent: 'previous devboard work',
      currentPlanSlug: null,
      currentFiles: [],
      ambientExcludedRefs: null,
      harnessSlug: 'sb-devboard-hive',
      potSlug: null,
      goalId: null,
      nativeSessionId: null,
      lifecycle: null,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    // The Pot resolver falls back to the first formal Pot, which may be an
    // unrelated hive. Operator-scoped work has its own canonical home resolver.
    homePotM.mockResolvedValueOnce('sb-devboard-hive');
    operatorHomeM.mockReturnValueOnce('papercusp');
    mockReturnOnceTyped(potHomeM, 'papercusp');

    const out = (await tool.handler(
      { intervalSec: 120, goal: 'continue the papercusp fleet lane' } as never,
      { harnessSlug: '*', workspaceId: 'ws-1' } as never,
    )) as Out;
    const b = body(out);

    expect(homePotM).not.toHaveBeenCalled();
    expect(operatorHomeM).toHaveBeenCalledOnce();
    expect(briefM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp' } });
    expect(b.loop.harness).not.toBe('sb-devboard-hive');
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ harness: 'papercusp' }));
  });

  it('EI-20245033088778955: reuses an existing routine install scope through a wildcard tools:invoke context', async () => {
    // A tools:invoke re-dispatch can rebuild the target ctx with harnessSlug='*'.
    // When this is a re-arm of an existing routine, its install_slug is the
    // authoritative scope and must beat the missing workspace-home fallback.
    mockPriorLoopOnce({ harnessSlug: 'papercusp' });
    briefM.mockResolvedValueOnce(null);
    homePotM.mockResolvedValueOnce(null);
    potHomeM.mockReturnValueOnce('papercusp').mockReturnValue(null as never);

    const out = (await tool.handler(
      { intervalSec: 120, goal: 're-arm the existing loop' } as never,
      { harnessSlug: '*', workspaceId: 'ws-1' } as never,
    )) as Out;
    const b = body(out);

    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp' } });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ harness: 'papercusp' }));
    expect(homePotM).not.toHaveBeenCalled();
  });

  it('EI-21481296218316052: omitted harness preserves an active routine scope despite a different concrete ctx', async () => {
    // The session can be dispatched through a concrete project harness that differs
    // from the loop it is retuning. Omitting args.harness is not an authorization to
    // migrate the durable routine (and strand its cold carry-note) into that transient
    // context; only an explicit harness request may change the installed scope.
    mockPriorLoopOnce({ harnessSlug: 'sb-devboard-hive' });
    potHomeM.mockImplementation((explicit, ctxSlug) => explicit ?? ctxSlug ?? 'home-hive');

    const out = (await tool.handler(
      { intervalSec: 120, goal: 're-arm the existing cold loop' } as never,
      { harnessSlug: 'papercusp', workspaceId: 'ws-1' } as never,
    )) as Out;
    const b = body(out);

    expect(b).toMatchObject({ ok: true, loop: { harness: 'sb-devboard-hive', carry: 'cold' } });
    expect(materializeM).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: 'sb-devboard-hive', carry: 'cold' }),
    );
  });

  it('EI-21550331830461260: omitted harness preserves an active routine scope despite a different dispatch-origin harness', async () => {
    // tools:invoke preserves the outer MCP request origin. That dispatch scope is
    // authoritative for a fresh arm, but it is not an explicit request to migrate
    // an already-active owner loop when the INNER loop:arm args omit `harness`.
    mockPriorLoopOnce({ harnessSlug: 'papercusp', goal: 'continue the papercusp loop' });
    potHomeM.mockImplementation((explicit, ctxSlug) => explicit ?? ctxSlug ?? 'home-hive');

    const out = (await tool.handler(
      { carry: 'cold' } as never,
      {
        harnessSlug: 'sb-devboard-hive',
        workspaceId: 'ws-1',
        requestOrigin: { transport: 'mcp', query: { harness: 'sb-devboard-hive' } },
      } as never,
    )) as Out;
    const b = body(out);

    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp', carry: 'cold' } });
    expect(materializeM).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: 'papercusp', carry: 'cold' }),
    );
  });

  it('EI-21481296218316052: an explicit harness still overrides the active routine scope', async () => {
    mockPriorLoopOnce({ harnessSlug: 'sb-devboard-hive' });

    const b = body(await call({ harness: 'papercusp', goal: 'explicitly migrate the loop' }));

    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp', carry: 'cold' } });
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'papercusp' }));
  });

  it('EI-24357920053367503: explicit harness beats an active plan brief during a cold re-arm', async () => {
    mockPriorLoopOnce({ harnessSlug: 'papercusp', goal: 'continue the loop' });
    briefM.mockResolvedValue({
      ownerId: 'su-caller-own-id',
      workspaceId: 'ws-1',
      ownerLabel: 'su · caller',
      source: 'active-plan',
      intent: 'continue the papercusp plan',
      currentPlanSlug: 'papercusp-plan',
      currentFiles: [],
      ambientExcludedRefs: null,
      harnessSlug: 'papercusp',
      potSlug: null,
      goalId: null,
      nativeSessionId: null,
      lifecycle: null,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    potHomeM.mockImplementation((explicit, ctxSlug) => explicit ?? ctxSlug ?? null);

    const out = (await tool.handler(
      { harness: 'sb-devboard-hive', carry: 'cold', goal: 'continue the loop' } as never,
      { harnessSlug: 'papercusp', workspaceId: 'ws-1' } as never,
    )) as Out;
    const b = body(out);

    expect(b).toMatchObject({ ok: true, loop: { harness: 'sb-devboard-hive', carry: 'cold' } });
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'sb-devboard-hive' }));
    expect(briefM).not.toHaveBeenCalled();
  });

  it('EI-21542193720279374 part (a): the resolved harness is now WIRED into computeLoopOverwriteNote — an explicit harness move, goal preserved, surfaces priorLoopOverwrite.harnessChanged through the handler', async () => {
    mockPriorLoopOnce({ harnessSlug: 'sb-devboard-hive' });

    // This goal is verbatim-contained in priorLoop()'s default kickoff, so — unlike the
    // test above — nothing but the harness move can trigger the note here.
    const b = body(
      await call({ harness: 'papercusp', goal: 'watch WI-5672 for the next live-fed-gate fire' }),
    );

    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp' } });
    expect(b.priorLoopOverwrite).not.toBeNull();
    expect(b.priorLoopOverwrite.harnessChanged).toBe(true);
    expect(b.note).toContain("harness 'sb-devboard-hive' → 'papercusp'");
    expect(b.note).not.toContain('whose goal DIFFERS');
  });

  // EI-7734 regression: every superuser/operator-scope session sets ctx.harnessSlug='*'
  // (the wildcard sentinel, _harness-scope.ts). A raw `args.harness ?? ctx.harnessSlug ?? …`
  // chain would let that truthy '*' win outright — bypassing resolvePotHomeSlug's own
  // '*'-skip logic entirely — and the wildcard would then get interpolated verbatim into
  // the wake prompt's self-task example (`work_items:create { harness:'*', … }`), which
  // work_items:create's harness resolution rejects (harnessScope throws on the wildcard).
  // The fix routes BOTH args.harness and ctx.harnessSlug THROUGH resolvePotHomeSlug
  // (which skips '*' at each level) rather than `??`-chaining ctx.harnessSlug in first.
  it("EI-7734: routes ctx.harnessSlug through resolvePotHomeSlug's '*'-skip instead of short-circuiting a raw ?? chain on it", async () => {
    const { resolvePotHomeSlug } = await import('../../pot/wake');
    // Exercise the synchronous fallback after the operator-home pointer resolves to no registered pot.
    operatorHomeM.mockReturnValueOnce('unregistered-home');
    potHomeM.mockReturnValueOnce(null as never).mockReturnValueOnce('papercusp');
    const out = (await tool.handler({ intervalSec: 120, goal: 'g' } as never, { harnessSlug: '*' } as never)) as Out;
    const b = body(out);
    // resolvePotHomeSlug must be CALLED with the raw '*' so its own skip logic runs —
    // a pre-fix raw `??` chain would never call it at all (ctx.harnessSlug='*' wins first).
    expect(vi.mocked(resolvePotHomeSlug)).toHaveBeenCalledWith(undefined, '*');
    // The resolved (non-wildcard) harness is what actually arms + what the wake prompt sees —
    // never the raw '*'.
    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp' } });
    expect(b.loop.harness).not.toBe('*');
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ harness: 'papercusp' }));
  });
});

// EI-19966210024116714 — a loop armed against a harness the OWNING SESSION cannot address
// is doomed from `armedAt` and fails SILENTLY: every harness-scoped call its wake contract
// prescribes is refused by the dispatch clamp with `harness_forbidden`, so the agent wakes on
// cadence, errors on every pull, and produces nothing — until the stalled-loops guard disarms
// it (WI-6639) and the claim reaper releases its held items as `reaper:dead`. Observed live
// 2026-08-08/09 across four fleet members who armed on harness 'papercusp' from sessions
// scoped to workspace 'default'; one burned 44 wakes over ~8h and lost a held item to the
// reaper mid-diagnosis. The mismatch is fully determinable at arm time, so refuse there.
describe('loop:arm — EI-19966210024116714: refuse a cross-workspace arm the session could never service', () => {
  const scopedCtx = { harnessSlug: 'papercusp', isSuperuser: true, workspaceId: 'ws-1' };
  const callAs = (ctx: Record<string, unknown>, args: Record<string, unknown> = {}) =>
    tool.handler({ intervalSec: 120, goal: 'g', ...args } as never, ctx as never) as Promise<Out>;

  it('REFUSES when the harness belongs to a different workspace — and arms nothing', async () => {
    resolveWsM.mockResolvedValueOnce('papercusp-workspace' as never);
    const b = body(await callAs(scopedCtx));
    expect(b).toMatchObject({
      ok: false,
      error: 'harness_workspace_mismatch',
      harness: 'papercusp',
      harnessWorkspace: 'papercusp-workspace',
      sessionWorkspace: 'ws-1',
    });
    // The whole point: no durable routine row, so no wake can fire into a doomed loop.
    expect(materializeM).not.toHaveBeenCalled();
  });

  it('the refusal names the concrete consequence, not just the mismatch', async () => {
    resolveWsM.mockResolvedValueOnce('papercusp-workspace' as never);
    const b = body(await callAs(scopedCtx));
    expect(b.message).toContain('harness_forbidden');
    expect(b.message).toContain('reaped as dead');
  });

  it("ARMS NORMALLY when the harness resolves to the session's own workspace", async () => {
    resolveWsM.mockResolvedValueOnce('ws-1' as never);
    const b = body(await callAs(scopedCtx));
    expect(b).toMatchObject({ ok: true });
    expect(materializeM).toHaveBeenCalled();
  });

  it('fails OPEN on a resolver THROW — an unreadable registry never blocks a legitimate arm', async () => {
    resolveWsM.mockRejectedValueOnce(new Error('ambiguous cross-workspace collision') as never);
    const b = body(await callAs(scopedCtx));
    expect(b).toMatchObject({ ok: true });
    expect(materializeM).toHaveBeenCalled();
  });

  it('fails OPEN when the harness resolves to NOTHING — absence is not a confirmed foreign resolution', async () => {
    resolveWsM.mockResolvedValueOnce(null as never);
    const b = body(await callAs(scopedCtx));
    expect(b).toMatchObject({ ok: true });
    expect(materializeM).toHaveBeenCalled();
  });

  it("does NOT check an UNSCOPED ('*') superuser — spanning workspaces is legitimate there", async () => {
    const b = body(await callAs({ harnessSlug: 'papercusp', isSuperuser: true, workspaceId: '*' }));
    expect(b).toMatchObject({ ok: true });
    expect(resolveWsM).not.toHaveBeenCalled();
  });

  it('does NOT check a NON-superuser session — the clamp that produces the failure does not apply', async () => {
    const b = body(await callAs({ harnessSlug: 'papercusp', workspaceId: 'ws-1' }));
    expect(b).toMatchObject({ ok: true });
    expect(resolveWsM).not.toHaveBeenCalled();
  });
});

describe('loop:arm — EI-6878: firstFireAt must not leak the raw parked-loop sentinel', () => {
  it('a normal (unparked) nextFireAt renders as its real ISO timestamp', async () => {
    materializeM.mockResolvedValue({ name: 'loop-x', nextFireAt: new Date('2026-01-01T00:00:00Z') } as never);
    const b = body(await call({}));
    expect(b.loop.firstFireAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a re-arm mid-turn returns the loop row PARKED at the infinity sentinel — renders as the literal string, never the raw +275760 date', async () => {
    materializeM.mockResolvedValue({ name: 'loop-x', nextFireAt: NEXT_FIRE_PARKED_FOR_TEST } as never);
    const b = body(await call({}));
    expect(b.loop.firstFireAt).toBe('after-turn-settle');
    expect(b.loop.firstFireAt).not.toContain('275760');
  });

  it('no nextFireAt at all still renders null (unchanged behavior)', async () => {
    materializeM.mockResolvedValue({ name: 'loop-x', nextFireAt: null } as never);
    const b = body(await call({}));
    expect(b.loop.firstFireAt).toBeNull();
  });
});

describe('loop:arm — WI-5557 TIER 1: unbounded warm-carry WORK loop warning (additive, no behavior change)', () => {
  it('warm + work + no maxFires/maxDurationSec (the default arm shape) → warning present in both the note and the structured field', async () => {
    const b = body(await call({}));
    expect(b.ok).toBe(true); // purely additive — arming still succeeds
    expect(b.unboundedWarmLoopWarning).toContain('WI-5557');
    expect(b.unboundedWarmLoopWarning).toMatch(/maxFires|maxDurationSec/);
    expect(b.note).toContain('unattended warm-carry WORK loop');
  });

  it("warm + mode:'monitor' → no warning (a monitor loop is actively watched each wake by contract)", async () => {
    const b = body(await call({ mode: 'monitor', monitor: monitorConfig() }));
    expect(b.unboundedWarmLoopWarning).toBeNull();
    expect(b.note).not.toContain('unattended warm-carry WORK loop');
  });

  it("carry:'cold' → no warning (cold resets to the carry-note each fire, so context never grows unbounded)", async () => {
    const b = body(await call({ carry: 'cold' }));
    expect(b.unboundedWarmLoopWarning).toBeNull();
    expect(b.note).not.toContain('unattended warm-carry WORK loop');
  });

  it('either dead-man guard set (maxFires) suppresses the warning', async () => {
    const b = body(await call({ maxFires: 20 }));
    expect(b.unboundedWarmLoopWarning).toBeNull();
  });

  it('either dead-man guard set (maxDurationSec) suppresses the warning', async () => {
    const b = body(await call({ maxDurationSec: 3600 }));
    expect(b.unboundedWarmLoopWarning).toBeNull();
  });

  it('publishes the no-duration-ceiling form as omission, never zero', () => {
    const schema = z.toJSONSchema(tool.args as never) as {
      properties?: { maxDurationSec?: { description?: string; exclusiveMinimum?: number } };
    };
    const field = schema.properties?.maxDurationSec;
    expect(field?.exclusiveMinimum).toBe(0);
    expect(field?.description).toContain('OMIT');
    expect(field?.description).toContain('maxDurationSec: 0');
    expect(field?.description).toContain('invalid');
  });
});

describe('loop:arm — EI-21542193720279374 part (b): cold-with-no-carry-note warning (additive, no behavior change)', () => {
  it('carry cold + no existing carry-note ⇒ warning present in both the note and the structured field', async () => {
    carryNoteM.mockResolvedValueOnce({ note: null, updatedAtMs: null, readFailed: false });
    const b = body(await call({ carry: 'cold' }));
    expect(b.ok).toBe(true); // purely additive — arming still succeeds
    expect(b.coldNoCarryNoteWarning).toContain('COLD');
    expect(b.coldNoCarryNoteWarning).toContain('BLIND');
    expect(b.note).toContain('armed COLD with no existing carry-note');
    expect(carryNoteM).toHaveBeenCalledWith({ harness: 'papercusp', ownerId: 'su-caller-own-id' });
  });

  it('carry cold + an EXISTING carry-note ⇒ no warning', async () => {
    carryNoteM.mockResolvedValueOnce({ note: 'prior state', updatedAtMs: 1000, readFailed: false });
    const b = body(await call({ carry: 'cold' }));
    expect(b.coldNoCarryNoteWarning).toBeNull();
    expect(b.note).not.toContain('armed COLD with no existing carry-note');
  });

  it('carry warm ⇒ the carry-note store is never even consulted (the check is cold-only)', async () => {
    const b = body(await call({ carry: 'warm' }));
    expect(b.coldNoCarryNoteWarning).toBeNull();
    expect(carryNoteM).not.toHaveBeenCalled();
  });

  it('a read failure (readFailed:true) is NOT treated as "no note" — no false-positive warning off a transient store error', async () => {
    carryNoteM.mockResolvedValueOnce({ note: null, updatedAtMs: null, readFailed: true });
    const b = body(await call({ carry: 'cold' }));
    expect(b.coldNoCarryNoteWarning).toBeNull();
  });

  it('a throw from the carry-note lookup is fail-soft — the loop still arms with no warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    carryNoteM.mockRejectedValueOnce(new Error('pg down'));
    const b = body(await call({ carry: 'cold' }));
    expect(b.ok).toBe(true);
    expect(b.coldNoCarryNoteWarning).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[loop:arm] cold-carry-note check failed'));
  });
});

describe('loop:arm — EI-24899961156406639: cold carry on a session with no carry-respawn host warns (additive, no refusal)', () => {
  it('carry cold + NO live psu-pty host ⇒ warning in the note AND the structured field, reason named, loop still arms', async () => {
    selfCompactionM.mockResolvedValueOnce({ available: false, reason: 'no_live_pty_host', host: null });
    const b = body(await call({ carry: 'cold' }));
    expect(b.ok).toBe(true); // warn-only — headless fleet members arm cold by design
    expect(b.coldCarryNoHostWarning).toContain('no live psu-pty host');
    expect(b.coldCarryNoHostWarning).toContain('no_live_pty_host');
    expect(b.coldCarryNoHostWarning).toContain('NOT guaranteed to start on a fresh context');
    expect(b.note).toContain('no live psu-pty host able to carry-respawn');
    expect(selfCompactionM).toHaveBeenCalledWith('su-caller-own-id');
  });

  it('a live host that PREDATES carry-respawn is the same hole — the warning names that reason', async () => {
    selfCompactionM.mockResolvedValueOnce({ available: false, reason: 'host_predates_carry_respawn', host: {} as never });
    const b = body(await call({ carry: 'cold' }));
    expect(b.coldCarryNoHostWarning).toContain('host_predates_carry_respawn');
  });

  it('POSITIVE CONTROL: carry cold + a carry-respawn-capable host ⇒ no warning', async () => {
    const b = body(await call({ carry: 'cold' }));
    expect(b.coldCarryNoHostWarning).toBeNull();
    expect(b.note).not.toContain('no live psu-pty host able to carry-respawn');
    expect(selfCompactionM).toHaveBeenCalledTimes(1);
  });

  it('carry warm ⇒ the host predicate is never consulted (the check is cold-only)', async () => {
    const b = body(await call({ carry: 'warm' }));
    expect(b.coldCarryNoHostWarning).toBeNull();
    expect(selfCompactionM).not.toHaveBeenCalled();
  });

  it('a throw from the host predicate is fail-soft — the loop still arms with no warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    selfCompactionM.mockRejectedValueOnce(new Error('psu-pty dir unreadable'));
    const b = body(await call({ carry: 'cold' }));
    expect(b.ok).toBe(true);
    expect(b.coldCarryNoHostWarning).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[loop:arm] cold-carry host check failed'));
  });
});

describe('loop:arm fresh carry default (EI-21424742792137469)', () => {
  it('a fresh caller with no explicit carry materializes the loop WARM', async () => {
    const b = body(await call({}));
    expect(b.loop.carry).toBe('warm');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ carry: 'warm' }));
    expect(b.note).not.toContain('Defaulted to COLD carry');
    expect(b.unboundedWarmLoopWarning).toContain('unattended warm-carry WORK loop');
  });

  it('an EXPLICIT carry:"warm" remains warm', async () => {
    const b = body(await call({ carry: 'warm' }));
    expect(b.loop.carry).toBe('warm');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ carry: 'warm' }));
  });

  it('an EXPLICIT carry:"cold" still opts into the cold lifecycle', async () => {
    const b = body(await call({ carry: 'cold' }));
    expect(b.loop.carry).toBe('cold');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ carry: 'cold' }));
    expect(b.unboundedWarmLoopWarning).toBeNull();
  });
});

// EI-18221784742583615 — arm-time overwrite guard: a stale/replayed fleet-kickoff turn
// silently clobbered an active specialized loop's config. loop:arm now surfaces the prior
// loop when the re-arm materially changes an ACTIVE loop's goal.
const priorLoop = (over: Partial<Parameters<typeof computeLoopOverwriteNote>[0] & object> = {}) => ({
  active: true,
  intervalSec: 1200,
  harnessSlug: null,
  kickoff: 'You are continuing your OWN warm session toward: watch WI-5672 for the next live-fed-gate fire',
  fireCount: 48,
  carry: 'cold' as const,
  continuation: 'settle' as const,
  mode: 'work' as const,
  armedAt: '2026-07-20T00:00:00.000Z',
  ...over,
});

// One typed seam for the readActiveLoopFacts mock, via the shared typed-mock helper — the
// fixture is checked against the real signature instead of each call site spelling an
// unchecked `as never`, so a new required field on that signature fails here at compile
// time rather than silently going stale and erroring at runtime somewhere else.
const mockPriorLoopOnce = (over: Parameters<typeof priorLoop>[0] = {}) =>
  mockResolvedOnceTyped(priorLoopM, priorLoop(over));

describe('computeLoopOverwriteNote (pure EI-18221784742583615 decision)', () => {
  const next = { goal: 'drain the generic bug backlog', intervalSec: 120, kickoff: 'new-generic-kickoff' };

  it('null / inactive prior ⇒ no note (a fresh start or re-arm over an ended loop is fine)', () => {
    expect(computeLoopOverwriteNote(null, next)).toBeNull();
    expect(computeLoopOverwriteNote(priorLoop({ active: false }), next)).toBeNull();
  });

  it('identical re-arm (same built kickoff) ⇒ no note, even with an unrelated goal string', () => {
    const prior = priorLoop({ kickoff: 'same-kickoff-text' });
    expect(computeLoopOverwriteNote(prior, { ...next, kickoff: 'same-kickoff-text' })).toBeNull();
    // whitespace/case-insensitive
    expect(computeLoopOverwriteNote(prior, { ...next, kickoff: '  SAME-kickoff-TEXT  ' })).toBeNull();
  });

  it('goal PRESERVED (new goal appears verbatim in the prior kickoff) ⇒ no note — an interval-only retune', () => {
    const prior = priorLoop({ kickoff: 'toward: watch WI-5672 for the next fire', intervalSec: 1200 });
    // same goal, only the interval changed → deliberate retune, not a goal swap
    const note = computeLoopOverwriteNote(prior, {
      goal: 'watch WI-5672 for the next fire',
      intervalSec: 300,
      kickoff: 'toward: watch WI-5672 for the next fire (300s)',
    });
    expect(note).toBeNull();
  });

  it('goal SWAP over an active long-running loop ⇒ a note surfacing the prior config', () => {
    const note = computeLoopOverwriteNote(priorLoop(), next);
    expect(note).not.toBeNull();
    expect(note!.priorIntervalSec).toBe(1200);
    expect(note!.priorFireCount).toBe(48);
    expect(note!.intervalChanged).toBe(true); // 1200s → 120s
    expect(note!.message).toContain('OVERWRITES an already-ACTIVE loop');
    expect(note!.message).toContain('fired 48×');
    expect(note!.message).toContain('1200s → 120s');
    expect(note!.message).toContain('loop:end');
    // the prior kickoff is quoted so the agent can compare goals
    expect(note!.priorKickoffExcerpt).toContain('WI-5672');
  });

  it('interval unchanged but goal swapped ⇒ note with intervalChanged=false and no interval delta text', () => {
    const note = computeLoopOverwriteNote(priorLoop({ intervalSec: 120 }), next);
    expect(note).not.toBeNull();
    expect(note!.intervalChanged).toBe(false);
    expect(note!.message).not.toContain('→');
  });

  // EI-21542193720279374 part (a): a same-goal harness MOVE used to pass both the
  // identical-kickoff and goal-preserved shortcuts and skip the note entirely, because
  // kickoff text never encodes harness. It must now surface a note of its own.
  it('harness CHANGED with the goal PRESERVED ⇒ a note now fires (previously silently skipped)', () => {
    const prior = priorLoop({
      harnessSlug: 'papercusp',
      kickoff: 'toward: watch WI-5672 for the next fire',
      intervalSec: 1200,
    });
    const note = computeLoopOverwriteNote(prior, {
      goal: 'watch WI-5672 for the next fire',
      intervalSec: 1200,
      kickoff: 'toward: watch WI-5672 for the next fire',
      harnessSlug: 'sb-devboard-hive',
    });
    expect(note).not.toBeNull();
    expect(note!.harnessChanged).toBe(true);
    expect(note!.intervalChanged).toBe(false); // interval unchanged — isolate the harness clause
    expect(note!.message).toContain("harness 'papercusp' → 'sb-devboard-hive'");
    expect(note!.message).toContain('carry-note is');
    expect(note!.message).toContain('resets BLIND');
    // a preserved goal means no goal-differs clause, so the harness clause is legible alone
    expect(note!.message).not.toContain('whose goal DIFFERS');
  });

  it('harness UNCHANGED (both concrete, identical) with the goal preserved ⇒ still no note', () => {
    const prior = priorLoop({
      harnessSlug: 'papercusp',
      kickoff: 'toward: watch WI-5672 for the next fire',
      intervalSec: 1200,
    });
    const note = computeLoopOverwriteNote(prior, {
      goal: 'watch WI-5672 for the next fire',
      intervalSec: 1200,
      kickoff: 'toward: watch WI-5672 for the next fire',
      harnessSlug: 'papercusp',
    });
    expect(note).toBeNull();
  });

  it('a `next` that omits harnessSlug (every pre-existing call shape) never reads as a harness change', () => {
    const prior = priorLoop({ harnessSlug: 'papercusp', kickoff: 'same-kickoff-text' });
    const note = computeLoopOverwriteNote(prior, { ...next, kickoff: 'same-kickoff-text' });
    expect(note).toBeNull();
  });

  it("priorLoop()'s default harnessSlug:null is never concrete, so it never counts as a change even against a concrete next.harnessSlug", () => {
    const prior = priorLoop(); // harnessSlug: null
    const note = computeLoopOverwriteNote(prior, {
      goal: 'watch WI-5672 for the next live-fed-gate fire',
      intervalSec: 1200,
      kickoff: prior.kickoff,
      harnessSlug: 'papercusp',
    });
    expect(note).toBeNull();
  });

  it("the wildcard sentinel '*' on either side is never concrete, so it never counts as a harness change", () => {
    const prior = priorLoop({
      harnessSlug: '*',
      kickoff: 'toward: watch WI-5672 for the next fire',
    });
    const note = computeLoopOverwriteNote(prior, {
      goal: 'watch WI-5672 for the next fire',
      intervalSec: prior.intervalSec ?? 1200,
      kickoff: prior.kickoff,
      harnessSlug: 'papercusp',
    });
    expect(note).toBeNull();
  });
});

describe('loop:arm — EI-18221784742583615 overwrite guard (through the handler)', () => {
  it('preserves an active marked custom kickoff when wakePrompt is omitted', async () => {
    const customKickoff = 'custom mission-specific wake instruction';
    priorLoopM.mockResolvedValue(priorLoop({ goal: 'g', kickoff: customKickoff, customWakePrompt: true }) as never);

    const b = body(await call({}));

    expect(b.ok).toBe(true);
    expect(b.loop.customWakePrompt).toBe(true);
    expect(materializeM).toHaveBeenCalledWith(
      expect.objectContaining({ kickoff: customKickoff, customWakePrompt: true }),
    );
  });

  it('rebuilds the default kickoff for a legacy row without the marker', async () => {
    const legacyKickoff = 'legacy custom-looking kickoff';
    priorLoopM.mockResolvedValue(priorLoop({ goal: 'g', kickoff: legacyKickoff }) as never);

    const b = body(await call({}));

    expect(b.ok).toBe(true);
    expect(materializeM).toHaveBeenCalledWith(
      expect.objectContaining({ kickoff: 'kickoff-prompt', customWakePrompt: false }),
    );
    expect(b.loop.customWakePrompt).toBe(false);
  });

  it('marks an explicit wakePrompt custom and passes the marker to materializeLoop', async () => {
    const b = body(await call({ wakePrompt: 'new custom wake instruction' }));

    expect(b.ok).toBe(true);
    expect(b.loop.customWakePrompt).toBe(true);
    expect(materializeM).toHaveBeenCalledWith(
      expect.objectContaining({ kickoff: 'new custom wake instruction', customWakePrompt: true }),
    );
  });

  it('re-arming over an active loop with a DIFFERENT goal surfaces priorLoopOverwrite + a note; the loop still arms', async () => {
    priorLoopM.mockResolvedValue(priorLoop() as never);
    // buildLoopWakePrompt is mocked to 'kickoff-prompt', which the prior kickoff does not
    // contain, and the goal below is not in the prior kickoff → materially different.
    const b = body(await call({ intervalSec: 120, goal: 'drain the generic bug backlog' }));
    expect(b.ok).toBe(true); // purely advisory — arming still succeeds
    expect(materializeM).toHaveBeenCalled(); // the loop was (re-)armed regardless
    expect(b.priorLoopOverwrite).not.toBeNull();
    expect(b.priorLoopOverwrite.priorFireCount).toBe(48);
    expect(b.note).toContain('OVERWRITES an already-ACTIVE loop');
    expect(priorLoopM).toHaveBeenCalledWith('su-caller-own-id');
  });

  it('re-arming with the SAME goal (goal present in the prior kickoff) ⇒ no overwrite note', async () => {
    priorLoopM.mockResolvedValue(priorLoop({ kickoff: 'toward: drain the generic bug backlog now' }) as never);
    const b = body(await call({ intervalSec: 120, goal: 'drain the generic bug backlog' }));
    expect(b.priorLoopOverwrite).toBeNull();
    expect(b.note).not.toContain('OVERWRITES an already-ACTIVE loop');
  });

  it('EI-22079408866636029: preserves an active work-item anchor when a retune omits workItem', async () => {
    priorLoopM.mockResolvedValue(
      priorLoop({
        goal: 'continue WI-42',
        kickoff: 'kickoff-prompt',
        workItem: 'WI-42',
      }) as never,
    );

    const b = body(await call({ intervalSec: 600, goal: 'continue WI-42', maxDurationSec: 900 }));

    expect(b).toMatchObject({ ok: true, loop: { workItem: 'WI-42' } });
    expect(claimM).not.toHaveBeenCalled();
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: 'WI-42' }));
    expect(materializeM).toHaveBeenCalledWith(
      expect.objectContaining({ workItem: 'WI-42', maxDurationSec: 900 }),
    );
  });

  it('EI-23156379126419084: clears a terminal active anchor when a retune omits workItem', async () => {
    priorLoopM.mockResolvedValue(
      priorLoop({
        goal: 'continue WI-DONE',
        kickoff: 'kickoff-prompt',
        workItem: 'WI-DONE',
      }) as never,
    );
    getWiM.mockResolvedValue({ id: 'WI-DONE', state: 'done', assignee: null } as never);

    const b = body(await call({ intervalSec: 600, goal: 'continue the next active lane', maxDurationSec: 900 }));

    expect(getWiM).toHaveBeenCalledWith('WI-DONE', 'papercusp');
    expect(b).toMatchObject({
      ok: true,
      loop: { workItem: null },
      workItemClaim: { id: 'WI-DONE', claimed: false, reason: 'terminal' },
    });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
  });

  it('EI-22656186904542038: explicit workItem:null clears an active prior anchor', async () => {
    priorLoopM.mockResolvedValue(
      priorLoop({
        goal: 'continue EI-DONE',
        kickoff: 'kickoff-prompt',
        workItem: 'EI-DONE',
      }) as never,
    );

    const b = body(await call({ intervalSec: 600, goal: 'continue the next lane', workItem: null }));

    expect(b).toMatchObject({ ok: true, loop: { workItem: null }, workItemClaim: null });
    expect(claimM).not.toHaveBeenCalled();
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
  });

  it('no prior loop ⇒ priorLoopOverwrite null (the default arm shape, unaffected)', async () => {
    const b = body(await call({}));
    expect(b.priorLoopOverwrite).toBeNull();
  });

  it('the overwrite-guard read throwing is swallowed — arming never fails on the advisory leg', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    priorLoopM.mockRejectedValue(new Error('db down') as never);
    const b = body(await call({ goal: 'anything' }));
    expect(b.ok).toBe(true);
    expect(b.priorLoopOverwrite).toBeNull();
    // the failure is logged (best-effort), not surfaced as an error
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('prior-loop read failed'));
    warnSpy.mockRestore();
  });
});

// EI-18792078711601844 — a re-arm with `carry` omitted must PRESERVE the loop's prior
// carry (when one is active) instead of silently recomputing a fresh headless/interactive
// default that can legitimately differ (host-discovery flakiness, a flag flip mid-run).
// The playbook's own prescribed remedy for a blocked loop — "re-loop:arm with a larger
// intervalSec" — passes only intervalSec, so this is exactly the call the bug's repro hit.
describe('loop:arm — EI-18792078711601844 carry preserved on re-arm', () => {
  it('an active prior loop with carry cold + carry omitted ⇒ re-arm PRESERVES cold (not the fresh warm default)', async () => {
    priorLoopM.mockResolvedValue(priorLoop({ carry: 'cold' }) as never);
    const b = body(await call({ intervalSec: 1200, goal: 'watch WI-5672 for the next fire' }));
    expect(b.ok).toBe(true);
    expect(b.loop.carry).toBe('cold');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ carry: 'cold' }));
    expect(b.note).toContain("carry 'cold' PRESERVED from the loop's prior config");
    // this is the preservation path, not the headless-default path — no "Defaulted to COLD" text
    expect(b.note).not.toContain('Defaulted to COLD carry');
  });

  it('an active prior loop with carry warm + carry omitted ⇒ re-arm PRESERVES warm', async () => {
    priorLoopM.mockResolvedValue(priorLoop({ carry: 'warm' }) as never);
    const b = body(await call({ intervalSec: 1200, goal: 'watch WI-5672 for the next fire' }));
    expect(b.loop.carry).toBe('warm');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ carry: 'warm' }));
    expect(b.note).toContain("carry 'warm' PRESERVED from the loop's prior config");
  });

  it('an EXPLICIT carry always overrides preservation, even over an active cold prior', async () => {
    priorLoopM.mockResolvedValue(priorLoop({ carry: 'cold' }) as never);
    const b = body(await call({ carry: 'warm', goal: 'watch WI-5672 for the next fire' }));
    expect(b.loop.carry).toBe('warm');
    expect(b.note).not.toContain('PRESERVED from the');
  });

  it('an INACTIVE prior loop (ended) ⇒ NOT preserved — falls through to the fresh default (warm, no live host)', async () => {
    priorLoopM.mockResolvedValue(priorLoop({ carry: 'cold', active: false }) as never);
    const b = body(await call({}));
    expect(b.loop.carry).toBe('warm');
    expect(b.note).not.toContain('PRESERVED from the');
  });

  it('no prior loop at all ⇒ NOT preserved — falls through to the fresh warm default', async () => {
    priorLoopM.mockResolvedValue(null as never);
    const b = body(await call({}));
    expect(b.loop.carry).toBe('warm');
    expect(b.note).not.toContain('Defaulted to COLD carry');
    expect(b.note).not.toContain('PRESERVED from the');
  });

  it('the prior-loop read throwing falls back to fresh-default resolution (fail-soft, arming never fails)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    priorLoopM.mockRejectedValue(new Error('db down') as never);
    const b = body(await call({}));
    expect(b.ok).toBe(true);
    expect(b.loop.carry).toBe('warm'); // fresh-default path, no live host
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('prior-loop read failed'));
    warnSpy.mockRestore();
  });
});

describe('loop:arm — EI-19395290807657827: the self-sealing backoff', () => {
  describe('resolveBlockedBackoff (pure)', () => {
    it('changes NO BEHAVIOUR when blockedOn is absent — every existing call site is unchanged', () => {
      // P-006/D-098 narrowed this contract deliberately: a wide undeclared interval now
      // returns an advisory `note`. The BEHAVIOURAL half is what the call sites depend on
      // and it is asserted here field-by-field — interval untouched, never clamped, no
      // wake premise injected.
      const r = resolveBlockedBackoff(7200, null);
      expect(r.intervalSec).toBe(7200);
      expect(r.clamped).toBe(false);
      expect(r.wakePremise).toBeNull();
    });

    it('stays fully silent for an ordinary short interval — the nudge must not nag a 60s loop', () => {
      expect(resolveBlockedBackoff(60, null)).toEqual({
        intervalSec: 60,
        clamped: false,
        eventReachability: null,
        note: null,
        wakePremise: null,
      });
    });

    // ── P-006 / D-098: surface `blockedOn` where it is actionable ──────────────
    // Measured 0 uses in 294 arm calls across 91 agents (14d) — built, better than a
    // prose-matching auto-attach, and never asked for.
    it('NUDGES an undeclared WIDE interval toward blockedOn, advisory only', () => {
      const r = resolveBlockedBackoff(1800, null);
      expect(r.intervalSec).toBe(1800); // advisory: never caps an undeclared loop
      expect(r.clamped).toBe(false);
      expect(r.wakePremise).toBeNull();
      expect(r.note).toContain('blockedOn');
      expect(r.note).toContain('events:catalog');
    });

    it('warns the await must be IN ADDITION to the loop, never instead of it (WI-6595)', () => {
      // The whole reason P-006's original "await INSTEAD of the poll" was refused: a
      // parked await suppresses loop fires, so an await on an event that cannot fire
      // deletes the agent's only backstop.
      const r = resolveBlockedBackoff(1800, null);
      expect(r.note).toMatch(/never instead of it/i);
      expect(r.note).toContain('WI-6595');
    });

    it('fires exactly at the cap boundary — one threshold, not a second constant', () => {
      expect(resolveBlockedBackoff(899, null).note).toBeNull();
      expect(resolveBlockedBackoff(900, null).note).toContain('blockedOn');
    });

    it('a DECLARED blocker never gets the undeclared-nudge — it gets the real backoff note', () => {
      const r = resolveBlockedBackoff(1800, { reason: 'gate red' });
      expect(r.note).toContain('Backoff recorded');
      expect(r.note).not.toMatch(/If you widened it because/i);
    });

    it('THE REGRESSION CASE: a 2h backoff with no clearing event is capped to 15min', () => {
      // The measured incident: five members re-armed at 7200s inside a 32s window and slept
      // ~2h past a blocker that had already cleared.
      const r = resolveBlockedBackoff(7200, { reason: 'green gate red 8h, blocking every deploy' });
      expect(r.intervalSec).toBe(900);
      expect(r.clamped).toBe(true);
      expect(r.note).toContain('CAPPED 7200s → 900s');
    });

    it('does not inflate an interval already below the cap', () => {
      const r = resolveBlockedBackoff(300, { reason: 'waiting on a peer' });
      expect(r.intervalSec).toBe(300);
      expect(r.clamped).toBe(false);
    });

    it('treats the cap boundary itself as un-clamped', () => {
      const r = resolveBlockedBackoff(900, { reason: 'boundary' });
      expect(r.intervalSec).toBe(900);
      expect(r.clamped).toBe(false);
    });

    it('CAPS a named event when reachability was not measured — a plausible key is not proof', () => {
      const r = resolveBlockedBackoff(7200, { reason: 'gate red', event: 'invented:key' });
      expect(r.intervalSec).toBe(900);
      expect(r.clamped).toBe(true);
      expect(r.eventReachability).toMatchObject({
        verdict: 'unknown',
        basis: 'unmeasured',
        authoritative: false,
      });
      expect(r.note).toContain('not proven reachable');
      expect(r.wakePremise).toContain('invented:key');
    });

    it('CAPS a named event when the authority proves it unreachable', () => {
      const r = resolveBlockedBackoff(
        7200,
        { reason: 'gate red', event: 'cancelled:key' },
        { status: 'unknown' },
        {
          verdict: 'impossible',
          basis: 'cancelled-registration',
          authoritative: true,
          evidence: 'the producer registration was cancelled',
          checkedAt: '2026-09-04T00:00:00.000Z',
        },
      );
      expect(r.intervalSec).toBe(900);
      expect(r.clamped).toBe(true);
      expect(r.eventReachability).toMatchObject({
        verdict: 'impossible',
        basis: 'cancelled-registration',
        authoritative: true,
      });
      expect(r.note).toContain('proven unreachable');
    });

    it('HONOURS a long interval when a clearing event is named — the push channel makes it safe', () => {
      const r = resolveBlockedBackoff(
        7200,
        { reason: 'gate red', event: 'green-gate-verdict' },
        { status: 'unknown' },
        {
          verdict: 'reachable',
          basis: 'live-resolver',
          authoritative: true,
          evidence: 'catalogued producer is live',
          checkedAt: '2026-09-04T00:00:00.000Z',
        },
      );
      expect(r.intervalSec).toBe(7200);
      expect(r.clamped).toBe(false);
      expect(r.eventReachability).toMatchObject({
        verdict: 'reachable',
        basis: 'live-resolver',
        authoritative: true,
      });
    });

    it('warns that naming an event is NOT the same as parking on it', () => {
      const r = resolveBlockedBackoff(
        7200,
        { reason: 'gate red', event: 'green-gate-verdict' },
        { status: 'unknown' },
        {
          verdict: 'reachable',
          basis: 'live-resolver',
          authoritative: true,
          evidence: 'catalogued producer is live',
          checkedAt: '2026-09-04T00:00:00.000Z',
        },
      );
      expect(r.note).toContain('events:await');
      expect(r.note).toMatch(/does NOT register the await/i);
    });

    it('always emits a wake premise instructing a re-check, in BOTH branches', () => {
      const withEvent = resolveBlockedBackoff(7200, { reason: 'gate red', event: 'green-gate-verdict' });
      const without = resolveBlockedBackoff(7200, { reason: 'gate red' });
      for (const r of [withEvent, without]) {
        expect(r.wakePremise).toContain('gate red');
        expect(r.wakePremise).toMatch(/RE-CHECK THAT PREMISE FIRST/);
        expect(r.wakePremise).toMatch(/RESTORE your normal cadence/);
      }
      // Only the event-less branch can claim nothing will push a wake.
      expect(without.wakePremise).toMatch(/NOTHING will push you a wake/);
      expect(withEvent.wakePremise).toContain('green-gate-verdict');
    });

    // EI-19447204017443244 — the cap used to assert "nothing can push you a wake" as
    // FACT while consulting only blockedOn.event. These four cases pin the three honest
    // renderings apart; each pair differs in exactly ONE input, so deleting the wiring
    // collapses them together and the suite fails by construction.
    describe('the live-push-channel claim (EI-19447204017443244)', () => {
      const blocked = { reason: 'waiting on a deploy' };

      it('NEVER states the caller has no push channel as an unqualified fact', () => {
        // The regression itself. The old text read "...you named no clearing event, so
        // nothing can push you a wake" — a claim about the caller's WHOLE wake surface,
        // which this function had never looked at. The scoped form is true by
        // construction, so it survives regardless of what the lookup found.
        for (const lp of [
          { status: 'unknown' } as const,
          { status: 'none' } as const,
          { status: 'found', count: 1, sample: ['predicate:abc'] } as const,
        ]) {
          const r = resolveBlockedBackoff(7200, blocked, lp);
          expect(r.note).toContain('no clearing event for this loop');
          expect(r.note).not.toMatch(/so nothing can push you a wake and the timer/);
        }
      });

      it('FOUND: names the live awaits instead of denying they exist — and still caps', () => {
        const r = resolveBlockedBackoff(7200, blocked, {
          status: 'found',
          count: 2,
          sample: ['predicate:44071', 'release:green:papercusp'],
        });
        expect(r.note).toContain('predicate:44071');
        expect(r.note).toMatch(/cannot tell whether any of them fires on THIS blocker/);
        // Item's option (b): the guard's behaviour is unchanged — only its claim is.
        expect(r.intervalSec).toBe(900);
        expect(r.clamped).toBe(true);
      });

      it('NONE: earns the negative claim by labelling it as MEASURED', () => {
        const r = resolveBlockedBackoff(7200, blocked, { status: 'none' });
        expect(r.note).toMatch(/measured, not assumed/);
        expect(r.note).not.toMatch(/you DO hold/);
      });

      it('UNKNOWN: a failed/absent lookup claims NEITHER — no fabricated measurement', () => {
        // The trap this guards: degrading "I could not look" into "I looked and found
        // nothing" would print a measurement that was never taken — the same defect
        // class, reintroduced through the error path.
        const r = resolveBlockedBackoff(7200, blocked, { status: 'unknown' });
        expect(r.note).not.toMatch(/measured, not assumed/);
        expect(r.note).not.toMatch(/you DO hold/);
      });

      it('defaults to UNKNOWN when the caller supplies no observation', () => {
        // Pins the back-compat contract: every pre-existing 2-arg caller is unaffected.
        expect(resolveBlockedBackoff(7200, blocked).note).toBe(
          resolveBlockedBackoff(7200, blocked, { status: 'unknown' }).note,
        );
      });

      it('the WAKE PREMISE names no specific await — it is re-injected on every wake', () => {
        // A once-await fires and is gone, so "you hold watch #44071" would be a fresh
        // false claim of this same class, merely time-shifted. The premise must stay
        // durable: scoped to the loop, naming nothing that can expire under it.
        const r = resolveBlockedBackoff(7200, blocked, {
          status: 'found',
          count: 1,
          sample: ['predicate:44071'],
        });
        expect(r.wakePremise).not.toContain('predicate:44071');
        expect(r.wakePremise).toContain('No clearing event was named for this loop');
      });
    });
  });

  describe('handler wiring', () => {
    it('arms the CAPPED interval, not the requested one', async () => {
      const b = body(await call({ intervalSec: 7200, blockedOn: { reason: 'gate red 8h' } }));
      expect(b.loop.intervalSec).toBe(900);
      expect(b.loop.requestedIntervalSec).toBe(7200);
      expect(b.loop.blockedOn).toEqual({ reason: 'gate red 8h', event: null, intervalCapped: true });
      expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ intervalSec: 900 }));
    });

    // EI-19447204017443244 — END-TO-END: the pure resolver above can be perfect and the
    // message still lie, if the handler never runs the lookup or drops its result. Each
    // case below differs from the default (empty ⇒ 'none') in exactly ONE input.
    describe('live wake-await lookup wiring (EI-19447204017443244)', () => {
      it('QUERIES the caller and threads a HIT into the cap message', async () => {
        mockResolvedTyped(wakeAwaitsM, {
          totalCount: 1,
          sample: [{ eventKey: 'predicate:44071', expiresTs: null, rootId: null }],
        });
        const b = body(await call({ intervalSec: 7200, blockedOn: { reason: 'waiting on a deploy' } }));
        // Queried for the ARMING owner — a lookup against anyone else answers the wrong question.
        expect(wakeAwaitsM).toHaveBeenCalledWith('su-caller-own-id');
        expect(b.note).toContain('predicate:44071');
        expect(b.note).not.toMatch(/measured, not assumed/);
      });

      it('BASELINE: the same arm with no live awaits makes the measured-negative claim', async () => {
        // The differential partner of the case above: identical call, lookup empty.
        // Delete the handler wiring and these two converge, so neither can pass vacuously.
        const b = body(await call({ intervalSec: 7200, blockedOn: { reason: 'waiting on a deploy' } }));
        expect(b.note).toMatch(/measured, not assumed/);
        expect(b.note).not.toContain('predicate:');
      });

      it('does NOT query when a clearing event IS named — that branch never speaks about awaits', async () => {
        await call({
          intervalSec: 7200,
          blockedOn: { reason: 'gate red', event: 'release:green:papercusp' },
        });
        expect(wakeAwaitsM).not.toHaveBeenCalled();
      });

      it('does NOT query on an ordinary arm with no declared blocker', async () => {
        await call({ intervalSec: 7200 });
        expect(wakeAwaitsM).not.toHaveBeenCalled();
      });

      it('CAPS an unknown named event and surfaces the failed reachability premise', async () => {
        eventReachabilityM.mockResolvedValue({
          verdict: 'unknown',
          basis: 'missing-registration',
          authoritative: false,
          evidence: 'no producer registration or catalogued resolver was found',
          checkedAt: '2026-09-04T00:00:00.000Z',
        });
        const b = body(
          await call({
            intervalSec: 7200,
            blockedOn: { reason: 'waiting on a deploy', event: 'invented:key' },
          }),
        );
        expect(b.loop.intervalSec).toBe(900);
        expect(b.loop.requestedIntervalSec).toBe(7200);
        expect(b.loop.blockedOn).toMatchObject({
          reason: 'waiting on a deploy',
          event: 'invented:key',
          intervalCapped: true,
          eventReachability: {
            verdict: 'unknown',
            basis: 'missing-registration',
            authoritative: false,
          },
        });
        expect(b.note).toContain('not proven reachable');
      });

      it('a FAILED lookup still arms, and claims NEITHER way', async () => {
        // Best-effort contract: advisory reads must not fail the arm, and must not
        // degrade into a fabricated "I checked and found nothing".
        mockRejectedTyped(wakeAwaitsM, new Error('statement timeout'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const b = body(await call({ intervalSec: 7200, blockedOn: { reason: 'waiting on a deploy' } }));
        // The failure is SWALLOWED for the caller but must not be silent for the operator.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('live wake-await lookup failed'));
        warn.mockRestore();
        expect(b.ok).not.toBe(false);
        expect(b.loop.intervalSec).toBe(900);
        expect(b.note).not.toMatch(/measured, not assumed/);
        expect(b.note).not.toMatch(/you DO hold/);
      });
    });

    it('PREPENDS the premise to the kickoff — the mechanism that actually re-checks it each wake', async () => {
      await call({ intervalSec: 7200, blockedOn: { reason: 'gate red 8h' } });
      const kickoff = (materializeM.mock.calls.at(-1)![0] as { kickoff: string }).kickoff;
      expect(kickoff).toMatch(/^⏸ BACKOFF PREMISE/);
      expect(kickoff).toContain('gate red 8h');
      // The original wake prompt must still be there — the premise prepends, never replaces.
      expect(kickoff).toContain('kickoff-prompt');
    });

    it('leaves the kickoff and the response untouched when no backoff is declared', async () => {
      const b = body(await call({ intervalSec: 7200 }));
      expect(b.loop.intervalSec).toBe(7200);
      expect(b.loop.blockedOn).toBeNull();
      expect(b.loop.requestedIntervalSec).toBeUndefined();
      expect((materializeM.mock.calls.at(-1)![0] as { kickoff: string }).kickoff).toBe('kickoff-prompt');
    });

    it('honours the long interval end-to-end when a clearing event is named', async () => {
      const b = body(await call({ intervalSec: 7200, blockedOn: { reason: 'gate red', event: 'green-gate-verdict' } }));
      expect(b.loop.intervalSec).toBe(7200);
      expect(b.loop.blockedOn).toEqual({
        reason: 'gate red',
        event: 'green-gate-verdict',
        intervalCapped: false,
        eventReachability: {
          verdict: 'reachable',
          basis: 'live-resolver',
          authoritative: true,
          evidence: 'test event is reachable',
          checkedAt: '2026-09-04T00:00:00.000Z',
        },
      });
      expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ intervalSec: 7200 }));
    });

    it('does not tell a monitor caller to register an exact await for its same predicate', async () => {
      const b = body(await call({
        intervalSec: 7200,
        mode: 'monitor',
        monitor: monitorConfig(),
        blockedOn: { reason: 'gate red', event: 'RELEASE:GREEN:PAPERCUSP' },
      }));

      expect(b.ok).toBe(true);
      expect(b.loop.monitor).toMatchObject({ predicateKey: 'release:green:papercusp' });
      expect(b.note).toContain('monitor_exact_await_duplicate');
      expect(b.note).toContain('do not stack both');
      expect(b.note).not.toContain('NOW ACTUALLY PARK ON IT');
      expect(b.note).not.toContain("events:await { event: 'RELEASE:GREEN:PAPERCUSP'");
    });
  });
});
describe('loop:arm — carry-only retune inherits interval/goal (EI-21476896242465605)', () => {
  // Typed, not `as never`: the cast used to hide that this fixture had gone STALE —
  // PriorLoopFacts gained required `continuation` and `mode`, and nothing failed until
  // mockResolvedTyped checked it against readActiveLoopFacts' real return type. Values
  // are the ordinary active work loop this test describes (the arm-time defaults).
  const ACTIVE_PRIOR: PriorLoopFacts = {
    active: true,
    goal: 'drain the lane',
    intervalSec: 300,
    carry: 'warm',
    continuation: 'settle',
    mode: 'work',
    harnessSlug: 'papercusp',
    kickoff: 'kickoff-prompt',
    fireCount: 3,
    armedAt: '2026-08-26T00:00:00Z',
  };
  const rawCall = (args: Record<string, unknown>) =>
    tool.handler(args as never, { harnessSlug: 'papercusp' } as never) as Promise<Out>;

  it('inherits intervalSec and goal from the active loop on a carry-only retune', async () => {
    mockResolvedTyped(priorLoopM, ACTIVE_PRIOR);
    const b = body(await rawCall({ carry: 'cold' }));
    expect(b.ok).toBe(true);
    expect(materializeM).toHaveBeenCalledWith(
      expect.objectContaining({ intervalSec: 300, goal: 'drain the lane', carry: 'cold' }),
    );
  });

  it('a FRESH arm missing interval/goal fails invalid_args naming both, before materialize', async () => {
    priorLoopM.mockResolvedValue(null);
    const out = await rawCall({ carry: 'warm' });
    const b = body(out);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('invalid_args');
    expect(b.missing).toEqual(['intervalSec', 'goal']);
    expect(materializeM).not.toHaveBeenCalled();
  });
});
