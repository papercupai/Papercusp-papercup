/**
 * wake-executor.test.ts — the liveness ladder, pure (injected deps, no PG)
 * (await-event-primitive-2026-06-05 P-006, D-003/D-009).
 */
const NEVER_EMIT_MARKER = 'never-emit-me';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexHomeForAdvSession,
  codexWakeGatewayInputs,
  executeWake,
  findCodexRolloutSessionId,
  injectOmpWakeTurnWhenReady,
  hiveInstallSlugFromLabel,
  ompResumePtyLooksReady,
  resumeCommandFor,
  wakeTurnText,
  degradeToInboxOrDrop,
  rehydrateLoopWakeText,
  applyInjectionDoor,
  defaultSpawnDetached,
  quotaRecoveryPickupConfirmed,
  quotaRecoveryReceiptForDelivery,
  withClaudeResumeEffortClamp,
  type ExecuteWakeDeps,
} from './wake-executor';
import {
  decideQuotaWakeRecovery,
  recentAuthRecoveryCount,
  AUTH_RECOVERY_MAX_PER_WINDOW,
  AUTH_RECOVERY_WINDOW_MS,
} from './host-recovery-eligibility';
import { readClaudeLaunchSettings as realReadClaudeLaunchSettings } from '../../model-context-budget.mjs';
import { CRASH_RESUME_ADVISORY_MARKER } from './crash-resume-advisory';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { getDoorConstantsSync } from '../../context-doors-config';
import { wakeAccountRouteFromArgv } from '../../inference-gateway/spawn-env';
import { LOOP_FIRE_PROVENANCE_TTL_MS } from '../../turn-provenance/turn-provenance';
// EI-20489286325396940: `wakeSummaryHeadline` (with `payloadIsTimeout`) lives in
// timeout-fallback.ts, not wake-executor.ts — it is imported BY wake-executor and
// by engine.ts, so hosting it here would close a wake-executor↔engine import cycle.
import { wakeSummaryHeadline } from './timeout-fallback';
import { AWAIT_CANCEL_REASONS } from './cancel-reasons';
import { turnEndRewakeKey } from './turn-end-rewake';
import { PtyError } from '../../pty-bridge';
import type { CarryBrief } from '../../carry-brief';
import { renderColdWakeInjection } from '../../su-cold-loop';
import type { DeliveryWork, WakeHandle } from './types';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { getLoopStatus } from '../../harness/routines/loop';
import {
  codexFreshDefaultAuthPreflight,
  rehealResumeCodexAuth,
} from '../../../../../apps/operator/scripts/psu-launcher.mjs';
import { resolvePtoolInvocationCandidates } from '../../../../../apps/operator/scripts/ptool.mjs';

// A per-session codex home (session-42) with two rollouts; the newer UUID wins.
const ROLLOUT_UUID = '019ea541-e6ed-71c2-bc67-aa25b5164ec5';
let CODEX_HOMES_DIR = '';
let prevCodexHomesEnv: string | undefined;

beforeAll(() => {
  CODEX_HOMES_DIR = mkdtempSync(join(tmpdir(), 'wake-codex-'));
  const sessionsDir = join(CODEX_HOMES_DIR, 'session-42', 'sessions', '2026', '06', '07');
  mkdirSync(sessionsDir, { recursive: true });
  const oldRollout = join(sessionsDir, 'rollout-2026-06-07T10-00-00-00000000-0000-0000-0000-000000000000.jsonl');
  const newRollout = join(sessionsDir, `rollout-2026-06-07T23-23-40-${ROLLOUT_UUID}.jsonl`);
  writeFileSync(oldRollout, '{}');
  writeFileSync(newRollout, '{}');
  utimesSync(oldRollout, new Date('2026-06-01'), new Date('2026-06-01'));
  utimesSync(newRollout, new Date('2026-06-07'), new Date('2026-06-07'));
  prevCodexHomesEnv = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
  process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = CODEX_HOMES_DIR;
});

describe('bounded codex auth recovery (parked-agent-census P-004)', () => {
  const host: Parameters<typeof decideQuotaWakeRecovery>[0]['host'] = {
    ownerId: 'su-auth',
    bridgeTty: false,
    authBlocked: true,
    launchedBy: 'su-leader',
    caps: ['quota-recovery', 'auth-recovery'],
  };
  const decide = (h: typeof host, extra: { accountMode?: string; priorAuthRecoveries?: number } = {}) =>
    decideQuotaWakeRecovery({ host: h, subscriberId: 'su-auth', deliveryId: '77', ...extra });

  it('recycles a dead codex login on ANY account route, tagged cause auth', () => {
    for (const accountMode of ['auto', 'pin', 'default', undefined]) {
      expect(decide(host, { accountMode })).toEqual({
        eligible: true, reason: 'eligible', cause: 'auth', operationId: '77',
      });
    }
  });

  it('fails closed on every other gate, and auth outranks a stale quota reading', () => {
    expect(decide({ ...host, bridgeTty: true })).toMatchObject({ eligible: false, reason: 'not-headless', cause: 'auth' });
    expect(decide({ ...host, launchedBy: null })).toMatchObject({ eligible: false, reason: 'not-agent-launched' });
    // An old host advertises quota-recovery only: it would not reset authBlocked.
    expect(decide({ ...host, caps: ['quota-recovery'] })).toMatchObject({ eligible: false, reason: 'host-capability-missing' });
    expect(decide({ ...host, ownerId: 'su-other' })).toMatchObject({ eligible: false, reason: 'wrong-owner' });
    expect(decide({ ...host, quotaBlocked: true }, { accountMode: 'pin' })).toMatchObject({ eligible: true, cause: 'auth' });
    expect(decide({ ...host, authBlocked: false }, { accountMode: 'pin' })).toMatchObject({ eligible: false, reason: 'not-quota-blocked' });
  });

  it('stops recycling once the per-owner bound is reached', () => {
    expect(decide(host, { priorAuthRecoveries: AUTH_RECOVERY_MAX_PER_WINDOW - 1 })).toMatchObject({ eligible: true });
    expect(decide(host, { priorAuthRecoveries: AUTH_RECOVERY_MAX_PER_WINDOW })).toMatchObject({
      eligible: false, reason: 'auth-recovery-exhausted', cause: 'auth',
    });
  });

  it('counts only this owner\'s auth recoveries inside the window', () => {
    const now = 10 * AUTH_RECOVERY_WINDOW_MS;
    const events = [
      { kind: 'quota-recovery-started', recoveryOwnerId: 'su-auth', cause: 'auth', startedAtMs: now - 1000 },
      { kind: 'quota-recovery-started', recoveryOwnerId: 'su-auth', cause: 'auth', startedAtMs: now - AUTH_RECOVERY_WINDOW_MS + 1 },
      { kind: 'quota-recovery-started', recoveryOwnerId: 'su-auth', cause: 'auth', startedAtMs: now - AUTH_RECOVERY_WINDOW_MS - 1 },
      { kind: 'quota-recovery-started', recoveryOwnerId: 'su-auth', cause: 'quota', startedAtMs: now - 1000 },
      { kind: 'quota-recovery-started', recoveryOwnerId: 'su-auth', startedAtMs: now - 1000 },
      { kind: 'quota-recovery-started', recoveryOwnerId: 'su-other', cause: 'auth', startedAtMs: now - 1000 },
      { kind: 'quota-recovery-ready', recoveryOwnerId: 'su-auth', cause: 'auth', startedAtMs: now - 1000 },
    ] as unknown as Parameters<typeof recentAuthRecoveryCount>[0];
    expect(recentAuthRecoveryCount(events, 'su-auth', now)).toBe(2);
    expect(recentAuthRecoveryCount([], 'su-auth', now)).toBe(0);
  });
});

describe('bounded quota recovery contract (measured-agent-productivity P-004)', () => {
  const host: Parameters<typeof decideQuotaWakeRecovery>[0]['host'] = {
    ownerId: 'su-quota',
    bridgeTty: false,
    quotaBlocked: true,
    launchedBy: 'su-leader',
    caps: ['quota-recovery'],
  };

  it('admits a guarded conversation-preserving interactive auto host, including a human launch', () => {
    const interactive = { ...host, bridgeTty: true, launchedBy: null,
      caps: ['quota-recovery', 'quota-recovery-resume'] };
    expect(decideQuotaWakeRecovery({ host: interactive, subscriberId: 'su-quota',
      deliveryId: '901', accountMode: 'auto' })).toMatchObject({ eligible: true });
    for (const accountMode of ['default', 'pin']) {
      expect(decideQuotaWakeRecovery({ host: interactive, subscriberId: 'su-quota',
        deliveryId: '901', accountMode })).toMatchObject({ eligible: false, reason: 'route-not-auto' });
    }
    expect(decideQuotaWakeRecovery({ host: { ...interactive, caps: ['quota-recovery'] },
      subscriberId: 'su-quota', deliveryId: '901', accountMode: 'auto' }))
      .toMatchObject({ eligible: false, reason: 'not-headless' });
  });

  it('admits only the same-owner, headless, agent-launched auto route on a capable blocked host', () => {
    expect(decideQuotaWakeRecovery({
      host,
      subscriberId: 'su-quota',
      deliveryId: '901',
      accountMode: 'auto',
    })).toEqual({ eligible: true, reason: 'eligible', cause: 'quota', operationId: '901' });

    const mutations: Array<[typeof host, ReturnType<typeof decideQuotaWakeRecovery>['reason']]> = [
      [{ ...host, ownerId: 'su-other' }, 'wrong-owner'],
      [{ ...host, quotaBlocked: false }, 'not-quota-blocked'],
      [{ ...host, bridgeTty: true }, 'not-headless'],
      [{ ...host, launchedBy: null }, 'not-agent-launched'],
      [{ ...host, caps: [] }, 'host-capability-missing'],
    ] as const;
    for (const [mutatedHost, reason] of mutations) {
      expect(decideQuotaWakeRecovery({
        host: mutatedHost,
        subscriberId: 'su-quota',
        deliveryId: '901',
        accountMode: 'auto',
      })).toMatchObject({ eligible: false, reason, operationId: '901' });
    }
    expect(decideQuotaWakeRecovery({
      host,
      subscriberId: 'su-quota',
      deliveryId: '901',
      accountMode: 'pin',
    })).toMatchObject({ eligible: false, reason: 'route-not-auto' });
  });

  it('binds a terminal receipt and pickup to the exact operation, owner, and post-start tool timestamp', () => {
    const events = [
      { kind: 'quota-recovery-ready', operationId: '901', recoveryOwnerId: 'su-other', startedAtMs: 1000 },
      { kind: 'quota-recovery-ready', operationId: '900', recoveryOwnerId: 'su-quota', startedAtMs: 1000 },
      {
        kind: 'quota-recovery-ready',
        operationId: '901',
        recoveryOwnerId: 'su-quota',
        startedAtMs: 2000,
        reason: 'turn-start-verified',
      },
    ];
    const receipt = quotaRecoveryReceiptForDelivery(events, 'su-quota', '901');
    expect(receipt).toEqual({
      status: 'ready',
      operationId: '901',
      ownerId: 'su-quota',
      startedAtMs: 2000,
      reason: 'turn-start-verified',
    });
    expect(quotaRecoveryPickupConfirmed(receipt!, new Date(2001).toISOString())).toBe(true);
    expect(quotaRecoveryPickupConfirmed(receipt!, new Date(2000).toISOString())).toBe(false);
    expect(quotaRecoveryPickupConfirmed(receipt!, new Date(1999).toISOString())).toBe(false);
    expect(quotaRecoveryReceiptForDelivery(events, 'su-quota', 'mutated')).toBeNull();
  });

  it('keeps the durable delivery parked until the recovered same owner makes a productive tool call', async () => {
    const ownerId = 'su-quota-live';
    const delivery = work({
      id: 901,
      subscriberId: ownerId,
      wakeHandle: advHandle({ advSessionId: 901, agent: 'codex', pid: 1234 }),
    });
    const confirming = vi.fn<NonNullable<ExecuteWakeDeps['injectPsuHostWithConfirmation']>>(async () => ({
      ok: true,
      confirmation: 'acked' as const,
      reason: 'duplicate-delivery-id',
    }));
    const latest = vi.fn(async () => new Map<string, string>());
    const common = deps({
      getSession: vi.fn(async () => session({
        id: 901,
        agent: 'codex',
        coordOwnerId: ownerId,
        launchArgv: ['psu', '--no-picker', '--agent=codex', '--account=auto'],
      })) as never,
      findPsuHost: vi.fn(() => ({
        sock: '/tmp/quota-live.sock',
        ownerId,
        bridgeTty: false,
        quotaBlocked: true,
        launchedBy: 'su-leader',
        caps: ['quota-recovery'],
      })) as never,
      injectPsuHostWithConfirmation: confirming as never,
      readPsuHostEventTail: vi.fn(() => [{
        kind: 'quota-recovery-ready',
        operationId: '901',
        recoveryOwnerId: ownerId,
        startedAtMs: 2_000,
        reason: 'turn-start-verified',
      }]) as never,
      lastProductiveToolCallAtByOwner: latest,
    });

    expect(await executeWake(delivery, common)).toMatchObject({
      kind: 'park',
      reason: expect.stringContaining('pickup is unconfirmed'),
    });
    const sent = confirming.mock.calls[0]?.[1];
    expect(sent).toMatchObject({
      mode: 'recycle',
      deliveryId: '901',
      ownerId,
      quotaRecovery: { operationId: '901', ownerId },
    });

    latest.mockResolvedValueOnce(new Map([[ownerId, new Date(2_001).toISOString()]]));
    // The productive same-owner call IS the pickup proof, so the delivery is booked
    // host-attested rather than left awaiting the pump's sweep (P-006/D-004).
    expect(await executeWake(delivery, common)).toEqual({
      kind: 'delivered',
      channel: 'psu-socket-recycle',
      turnProof: 'host-attested',
    });
    expect(latest).toHaveBeenLastCalledWith([ownerId]);
  });
});

describe('live Codex quota gateway repair', () => {
  const ownerId = 'su-quota-gateway';
  const sessionId = 9901;
  const fixture = (account = 'auto', launchedBy: string | null = 'su-leader') => {
    const order: string[] = [];
    const record = session({
      id: sessionId, agent: 'codex', coordOwnerId: ownerId,
      launchArgv: ['psu', '--agent=codex', `--account=${account}`, '--headless'],
    });
    const repair = vi.fn<NonNullable<ExecuteWakeDeps['ensureCodexHomeForWake']>>(async () => {
      order.push('repair');
      return { ok: true, repaired: true };
    });
    const inject = vi.fn<NonNullable<ExecuteWakeDeps['injectPsuHostWithConfirmation']>>(async () => {
      order.push('inject');
      return { ok: true, confirmation: 'acked', reason: 'delivered' };
    });
    const common = deps({
      getSession: vi.fn(async () => record) as never,
      findPsuHost: vi.fn(() => ({
        sock: '/tmp/quota-gateway.sock', ownerId, bridgeTty: false,
        quotaBlocked: true, launchedBy, caps: ['quota-recovery'],
      })) as never,
      ensureCodexHomeForWake: repair,
      injectPsuHostWithConfirmation: inject,
    });
    const delivery = work({
      id: sessionId, subscriberId: ownerId,
      wakeHandle: advHandle({ advSessionId: sessionId, agent: 'codex', pid: 1234 }),
    });
    return { order, record, repair, inject, common, delivery };
  };

  it('repairs the persisted auto gateway route before recycling the live quota-blocked native session', async () => {
    const f = fixture();
    expect(await executeWake(f.delivery, f.common)).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle' });
    expect(f.order).toEqual(['repair', 'inject']);
    expect(f.repair).toHaveBeenCalledWith({
      advSessionId: sessionId, owner: ownerId, codexHome: codexHomeForAdvSession(sessionId),
      headless: true, sessionRow: f.record, requireGatewayProvider: true, codexGatewayAccountId: null,
    });
  });

  it.each([
    { ok: false, reason: 'home-unreadable' },
    { ok: true, repaired: false, reason: 'no-launch-spec' },
  ])('parks rather than recycling into an unverified gateway route: $reason', async (result) => {
    const f = fixture();
    f.repair.mockResolvedValueOnce(result);
    expect(await executeWake(f.delivery, f.common)).toMatchObject({
      kind: 'park', reason: expect.stringContaining('Codex quota gateway repair'),
    });
    expect(f.inject).not.toHaveBeenCalled();
  });

  it('redacts rejected Codex home repair diagnostics before parking quota recovery', async () => {
    const f = fixture();
    const bearer = 'opaque-test-bearer-value-for-quota-repair';
    f.repair.mockRejectedValueOnce(new Error(`Invalid character at row 102\nAuthorization = "Bearer ${bearer}"`));
    const out = await executeWake(f.delivery, f.common);
    expect(out).toMatchObject({ kind: 'park', reason: expect.stringContaining('Invalid character at row 102') });
    expect(out).toMatchObject({ reason: expect.stringContaining('Authorization = "Bearer [redacted]"') });
    expect(JSON.stringify(out)).not.toContain(bearer);
    expect(f.inject).not.toHaveBeenCalled();
  });

  it('leaves an explicitly default account route unchanged', async () => {
    const f = fixture('default');
    await executeWake(f.delivery, f.common);
    expect(f.repair).not.toHaveBeenCalled();
    expect(f.inject.mock.calls[0]?.[1]).toMatchObject({ mode: 'turn' });
  });

  it('restores auto routing without weakening the missing-launch-provenance recycle fence', async () => {
    const f = fixture('auto', null);
    await executeWake(f.delivery, f.common);
    expect(f.order).toEqual(['repair', 'inject']);
    expect(f.inject.mock.calls[0]?.[1]).toMatchObject({ mode: 'turn' });
  });
});

afterAll(() => {
  if (prevCodexHomesEnv === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
  else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = prevCodexHomesEnv;
  try {
    rmSync(CODEX_HOMES_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function work(overrides: Partial<DeliveryWork> = {}): DeliveryWork {
  return {
    id: 7,
    workspaceId: 'ws',
    awaitId: 3,
    subscriberId: 'su-abc',
    eventKey: 'lock:grant:t-1',
    payload: null,
    summary: 'your lock on foo.ts was granted',
    status: 'delivering',
    channel: null,
    attempts: 1,
    lastError: null,
    nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    urgent: false,
    minSleepSec: null,
    coalescedCount: 1,
    source: null,
    turnProof: null,
    turnStartedAt: null,
    pickupDeadlineAt: null,
    wakeHandle: null,
    note: 'waiting to edit foo.ts',
    ...overrides,
  };
}

const advHandle = (over: Partial<Extract<WakeHandle, { kind: 'adv-session' }>> = {}): WakeHandle => ({
  kind: 'adv-session',
  advSessionId: 42,
  agent: 'claude',
  sessionId: '11111111-2222-3333-4444-555555555555',
  ompThreadId: null,
  cwd: '/repo',
  pid: 9999,
  ...over,
});

const session = (over: Record<string, unknown> = {}) => ({
  id: 42,
  workspaceId: 'ws',
  planSlug: null,
  agent: 'claude',
  role: null,
  feature: null,
  mode: 'console' as const,
  terminalBin: null,
  pid: 9999,
  windowId: null,
  ompThreadId: null,
  label: null,
  cwd: '/repo',
  coordOwnerId: 'su-abc',
  sessionId: '11111111-2222-3333-4444-555555555555',
  startedAt: new Date().toISOString(),
  endedAt: null,
  exitCode: null,
  ...over,
});

const livePresence = { stale: false, revoked: false };
const stalePresence = { stale: true, revoked: false };
const parkedMemberLiveness = (ownerId = 'su-abc') =>
  vi.fn(async () => new Map([
    [ownerId, {
      ownerId,
      sessionState: 'parked',
      wakeable: false,
      liveTurn: false,
      confirmLiveness: null,
      heartbeatFresh: true,
    } as never],
  ]));
const testPtyAccessScope = {
  tenantId: 'ws',
  workspaceId: 'ws',
  harnessSlug: 'h',
  hostId: 'host',
  principalId: 'su-abc',
};

function fakeOmpPty(id = 'pty-omp') {
  return {
    id,
    accessScope: testPtyAccessScope,
    onData: new Set<(chunk: Buffer) => void>(),
    onExit: new Set<(code: number, signal: number) => void>(),
    history: [] as Buffer[],
    killed: false,
    exitCode: null as number | null,
  };
}

function deps(over: Partial<ExecuteWakeDeps> = {}): ExecuteWakeDeps {
  const getSessionFn: NonNullable<ExecuteWakeDeps['getSession']> =
    over.getSession ?? (vi.fn(async () => session()) as never);
  return {
    getSession: getSessionFn,
    getLatestSessionForOwner: vi.fn(async () => getSessionFn(42)) as never,
    findPty: vi.fn(() => null) as never,
    write: vi.fn(() => true) as never,
    spawnManagedPty: vi.fn(() => ({ id: 'pty-1' })) as never,
    spawnDetached: vi.fn(() => 1234),
    // WI-10005900: hermetic by default — the production reader opens the
    // settings.json the resumed claude would read, which falls back to the
    // runner's real ~/.claude. No settings ⇒ the resume argv is unchanged.
    readClaudeLaunchSettings: vi.fn(() => null),
    presence: vi.fn(async () => livePresence) as never,
    // EI-24940177665447430: keep the delivery-time effective-mode read hermetic;
    // only the dedicated fence cases below override this auto-mode default.
    resolveWakeModeFn: vi.fn(async () => 'auto') as never,
    stageManualWakeFn: vi.fn(async () => undefined) as never,
    getSessionLifecycle: vi.fn(async () => null),
    // EI-22449230917085417: keep ordinary wake tests hermetic; the production
    // default reads the live SU-lock table at the delivery boundary.
    readLockGrantOwnership: vi.fn(async () => true),
    observeFallback: vi.fn(),
    getCurrentWorkItem: vi.fn(async () => null) as never,
    // Keep the Channel 2 grading-audit checks hermetic by default. Only their
    // focused freshness tests should provide task/scorecard rows; the production
    // readers open the live org database.
    readGradingAuditTasks: vi.fn(async () => []) as never,
    readGradingAuditTarget: vi.fn(async () => null) as never,
    cancelGradingAuditAwait: vi.fn(async () => undefined) as never,
    // WI-6554700010018677: delivery-time tenant resolution reads adv_sessions for a
    // 'default'-namespace delivery. Hermetic by default (null = unknown tenant, the same
    // fail-soft answer the production reader gives without a database); the tenant cases
    // override it.
    workspaceForCoordOwnerFn: vi.fn(async () => null) as never,
    // WI-6554700010018536: hermetic by default — the production reader queries the
    // recipient's held work-items, modes and loop. Only the dedicated seam cases override.
    prepareInboxWakeHeldWorkReminder: vi.fn(async () => ''),
    alive: vi.fn(() => true),
    isLoopArmed: vi.fn(async () => false),
    // WI-6860: hermetic by default — the real getLoopStatus opens a live PG
    // connection (getOrgPg), which a unit test must never touch. Model the
    // ordinary loop-delivery case as a live, long-armed row; tests covering
    // loop:end, missing rows, re-arm, or read failure override this explicitly.
    getLoopStatusFn: vi.fn(async () => ({
      active: true,
      armedAt: '1970-01-01T00:00:00.000Z',
    })) as never,
    // Hermetic by default: the production carry-note metadata reader opens a
    // live PG connection. Tests that exercise delivery-time or cold-note
    // metadata explicitly inject their fixture; every other wake must model
    // an unavailable/empty note instead of reaching the real store.
    getLoopCarryNoteWithMetaFn: vi.fn(async () => ({ note: null, updatedAtMs: null })) as never,
    // Hermetic by default: the production evidence counter reads live tool
    // invocation rows. `null` means evidence unavailable, preserving the
    // strong-banner fallback without allowing host data to affect unit tests.
    countAgentToolCallsFn: vi.fn(async () => null) as never,
    forceResume: vi.fn(async () => false),
    claimResume: vi.fn(async () => true),
    // Hermetic by default: a real re-arm reads/writes coordination PG state.
    ensureInboxWakeArmedForActiveSession: vi.fn(async () => false),
    // WI-10002854 — hermetic by default. The real accountant writes a task-ledger
    // row and the adv-session pid to PG, and the real oracle reads the host's
    // /proc. Tests of the fence inject their own.
    accountHeadlessResumeTurn: vi.fn(() => ({ pidRecorded: Promise.resolve(), finish: vi.fn() })),
    isHeadlessResumeTurn: vi.fn(() => false),
    // Hermetic by default: the cold no-host limbo guard's real binding READS+WRITES
    // PG (routines metadata / pause / escalation). null = "not tracked" — the park
    // behaves exactly as before the guard existed (EI-21431587306904888).
    recordColdNoHostPark: vi.fn(async () => null),
    // Hermetic by default: the P-013 cold-park inbox-wake fallback's real binding fires
    // a live wake key. queued:0 = "nobody watches the key", so the cold no-host branch
    // parks exactly as before the fallback existed.
    launchColdFreshSuccessor: vi.fn(async () => false),
    // Hermetic by default: the P-013 wake re-home decision's real binding reads the
    // account-pool projection from PG. `keep` = resume exactly as before re-homing existed.
    resolveWakeRehome: vi.fn(async () => ({ action: 'keep' as const, reason: 'test default' })),
    rehomeWakeOnBackend: vi.fn(async () => ({ ok: false, detail: 'test default' })),
    resumePlanRun: vi.fn(async () => ({ ok: true as const })),
    // Hermetic by default: no live psu-pty host (don't read the real ~/.papercusp).
    findPsuHost: vi.fn(async () => null) as never,
    injectPsuHost: vi.fn(async () => true) as never,
    // Hermetic by default: the hive-fresh-wake fire is stubbed so a hive-labelled
    // session never reaches the real default (which lazy-imports + touches PG).
    fireHiveWake: vi.fn(async () => true) as never,
    // Hermetic by default: the degrade-to-inbox send is stubbed so a dead-waiter
    // drop path never reaches the real sendMessage (which touches PG/coordLog).
    sendCoordMessage: vi.fn(async () => ({}) as never) as never,
    // Hermetic by default (P-008 rematerialize-on-miss): the resume leg calls these
    // before `--resume`. Their real bindings READ PG, and an unsettled PG read HANGS
    // past the surrounding try/catch rather than throwing — un-stubbed, every resume
    // test blocks until the suite timeout. collectSessionFiles returns a non-empty
    // list = the "transcript already on disk" fast path, so rematerialize never fires.
    collectSessionFiles: vi.fn(async () => [{}]) as never,
    rematerializeSession: vi.fn(async () => ({ ok: true, written: 0 })) as never,
    findArchivedSessionIdForAdv: vi.fn(async () => null) as never,
    // Hermetic by default: the production repair helper rebuilds its launch
    // spec through PG. Dedicated Codex archive tests inject the ordering seam.
    ensureCodexHomeForWake: vi.fn(async () => ({ ok: true, repaired: false })) as never,
    // Hermetic by default: tests of unrelated wake behavior do not depend on
    // the runner's actual ~/.codex login.
    prepareDirectCodexWakeAuth: vi.fn(() => ({ checked: true, ready: true, reason: 'test-ready' })),
    // Hermetic by default (turn-provenance P-002): the real tagger writes ledger
    // rows under ~/.papercusp/turn-provenance — stub it to a passthrough so the
    // long-standing exact-text assertions stay byte-identical. The dedicated
    // provenance-tagging describe below injects a REAL-shaped tagger instead.
    tagTurn: ((args: { text: string; origin: string }) => ({
      taggedText: args.text,
      envelope: '',
      nonce: 'stub',
      origin: args.origin,
      ledgerWritten: true,
    })) as never,
    ...over,
  };
}

describe('executeWake — obsolete turn-end fallback delivery (EI-26908413306331308)', () => {
  it('suppresses a pure fallback when a newer guaranteed dependency await is active', async () => {
    const ownerId = 'su-rewake-superseded';
    const classify = vi.fn(async () => ({ kind: 'obsolete' as const, reason: 'a current bounded wake is already guaranteed' }));
    const delivery = work({
      id: 301,
      subscriberId: ownerId,
      eventKey: turnEndRewakeKey(ownerId),
      payload: { timeout: true, guidance: 'stale fallback' },
      note: 'nothing set to wake you',
      wakeHandle: advHandle(),
    });
    const d = deps({ classifyTurnEndRewakeDelivery: classify });

    await expect(executeWake(delivery, d)).resolves.toEqual({
      kind: 'delivered',
      channel: 'suppressed-redundant',
    });
    expect(classify).toHaveBeenCalledWith({ ownerId, excludeDeliveryIds: [delivery.id] });
    expect(d.findPsuHost).not.toHaveBeenCalled();
    expect(d.spawnDetached).not.toHaveBeenCalled();
  });

  it('removes only fallback components and retains a coalesced dependency timeout', async () => {
    const { coalesceDeliveries } = await import('./engine');
    const ownerId = 'su-rewake-mixed';
    const fallback = work({
      id: 302,
      subscriberId: ownerId,
      eventKey: turnEndRewakeKey(ownerId),
      payload: { timeout: true, guidance: 'stale fallback' },
      summary: 'old turn-end fallback',
      note: 'nothing set to wake you',
      createdAt: new Date(1_000).toISOString(),
    });
    const dependency = work({
      id: 303,
      subscriberId: ownerId,
      eventKey: 'work-item:done:WI-9',
      payload: { timeout: true, guidance: 'current dependency timeout' },
      summary: 'dependency deadline expired',
      note: null,
      createdAt: new Date(2_000).toISOString(),
    });
    const delivery = {
      ...coalesceDeliveries([fallback, dependency]),
      wakeHandle: { kind: 'plan-run' as const, runId: 93 },
    };
    let wakeText = '';
    const classify = vi.fn(async () => ({ kind: 'obsolete' as const, reason: 'unused for mixed delivery' }));
    const d = deps({
      classifyTurnEndRewakeDelivery: classify,
      resumePlanRun: vi.fn(async ({ wakeText: text }) => {
        wakeText = text;
        return { ok: true as const };
      }),
    });

    await expect(executeWake(delivery, d)).resolves.toEqual({ kind: 'delivered', channel: 'plan-run-resume' });
    expect(classify).not.toHaveBeenCalled();
    expect(wakeText).toContain('work-item:done:WI-9');
    expect(wakeText).toContain('dependency deadline expired');
    expect(wakeText).not.toContain('turn-end:rewake:');
    expect(wakeText).not.toContain('nothing set to wake you');
  });
});

describe('executeWake — delivery-time current wake-mode fence (EI-24940177665447430)', () => {
  const ownerId = 'su-paused-at-delivery';
  const inboxKey = `coord:inbox-wake:${ownerId}`;
  const ownerRelayPayload = (quote: string) => ({
    messageId: `owner-msg-${quote.length}`,
    relayProvenance: {
      tier: 'owner-verified-turn',
      quote,
      origin: 'owner',
    },
  });
  const planHandle = { kind: 'plan-run' as const, runId: 92 };

  it('stages an ordinary queued delivery when the recipient is manual before any continuation runs', async () => {
    const resolveWakeModeFn = vi.fn(async () => 'manual' as const);
    const stageManualWakeFn = vi.fn(async () => undefined);
    const resumePlanRun = vi.fn(async () => ({ ok: true as const }));
    const d = deps({ resolveWakeModeFn: resolveWakeModeFn as never, stageManualWakeFn: stageManualWakeFn as never, resumePlanRun });
    const delivery = work({
      subscriberId: ownerId,
      eventKey: 'work-item:claimable',
      payload: { workItemId: 'WI-42' },
      source: 'su-peer',
      wakeHandle: planHandle,
    });

    await expect(executeWake(delivery, d)).resolves.toEqual({
      kind: 'drop',
      reason: 'effective wake mode is manual at delivery time; queued wake staged for owner review',
    });
    expect(resolveWakeModeFn).toHaveBeenCalledWith(ownerId);
    expect(stageManualWakeFn).toHaveBeenCalledWith({
      ownerId,
      summary: delivery.summary,
      payload: delivery.payload,
      source: delivery.source,
      workspaceId: delivery.workspaceId,
    });
    expect(resumePlanRun).not.toHaveBeenCalled();
    expect(d.findPsuHost).not.toHaveBeenCalled();
    expect(d.spawnDetached).not.toHaveBeenCalled();
    expect(d.write).not.toHaveBeenCalled();
  });

  it('keeps an explicit wake-queue release deliverable while manual mode is active', async () => {
    const stageManualWakeFn = vi.fn(async () => undefined);
    const resumePlanRun = vi.fn(async () => ({ ok: true as const }));
    const d = deps({
      resolveWakeModeFn: vi.fn(async () => 'manual') as never,
      stageManualWakeFn: stageManualWakeFn as never,
      resumePlanRun,
    });
    const delivery = work({
      subscriberId: ownerId,
      eventKey: inboxKey,
      payload: { value: 'owner-reviewed release' },
      source: 'coord:wake-queue-release:su-peer',
      wakeHandle: planHandle,
    });

    await expect(executeWake(delivery, d)).resolves.toEqual({
      kind: 'delivered',
      channel: 'plan-run-resume',
    });
    expect(stageManualWakeFn).not.toHaveBeenCalled();
    expect(resumePlanRun).toHaveBeenCalledWith(expect.objectContaining({ runId: planHandle.runId }));
  });

  it('keeps an owner-verified relay on the recipient inbox-wake deliverable in manual mode', async () => {
    const stageManualWakeFn = vi.fn(async () => undefined);
    const resumePlanRun = vi.fn(async () => ({ ok: true as const }));
    const d = deps({
      resolveWakeModeFn: vi.fn(async () => 'manual') as never,
      stageManualWakeFn: stageManualWakeFn as never,
      resumePlanRun,
    });
    const delivery = work({
      subscriberId: ownerId,
      eventKey: inboxKey,
      payload: ownerRelayPayload('resume this agent'),
      source: 'su-relaying-agent',
      wakeHandle: planHandle,
    });

    await expect(executeWake(delivery, d)).resolves.toEqual({
      kind: 'delivered',
      channel: 'plan-run-resume',
    });
    expect(stageManualWakeFn).not.toHaveBeenCalled();
    expect(resumePlanRun).toHaveBeenCalledTimes(1);
  });

  it('accepts coalesced owner relays only when every component is an owner-verified inbox wake', async () => {
    const { coalesceDeliveries } = await import('./engine');
    const stageManualWakeFn = vi.fn(async () => undefined);
    const resumePlanRun = vi.fn(async () => ({ ok: true as const }));
    const d = deps({
      resolveWakeModeFn: vi.fn(async () => 'manual') as never,
      stageManualWakeFn: stageManualWakeFn as never,
      resumePlanRun,
    });
    const first = work({
      id: 93,
      subscriberId: ownerId,
      eventKey: inboxKey,
      payload: ownerRelayPayload('resume agent one'),
      source: 'su-relaying-agent',
      createdAt: new Date(1_000).toISOString(),
    });
    const second = work({
      id: 94,
      subscriberId: ownerId,
      eventKey: inboxKey,
      payload: ownerRelayPayload('resume agent two'),
      source: 'su-relaying-agent',
      createdAt: new Date(2_000).toISOString(),
    });
    const delivery = { ...coalesceDeliveries([first, second]), wakeHandle: planHandle };

    await expect(executeWake(delivery, d)).resolves.toEqual({
      kind: 'delivered',
      channel: 'plan-run-resume',
    });
    expect(stageManualWakeFn).not.toHaveBeenCalled();
    expect(resumePlanRun).toHaveBeenCalledTimes(1);
  });

  it('does not let a verified relay authorize an unrelated coalesced sibling or another event key', async () => {
    const { coalesceDeliveries } = await import('./engine');
    const stageManualWakeFn = vi.fn(async () => undefined);
    const resumePlanRun = vi.fn(async () => ({ ok: true as const }));
    const d = deps({
      resolveWakeModeFn: vi.fn(async () => 'manual') as never,
      stageManualWakeFn: stageManualWakeFn as never,
      resumePlanRun,
    });
    const ordinary = work({
      id: 95,
      subscriberId: ownerId,
      eventKey: 'work-item:claimable',
      payload: { workItemId: 'WI-43' },
      source: 'su-peer',
      createdAt: new Date(1_000).toISOString(),
    });
    const ownerRelay = work({
      id: 96,
      subscriberId: ownerId,
      eventKey: inboxKey,
      payload: ownerRelayPayload('resume this agent'),
      source: 'su-relaying-agent',
      createdAt: new Date(2_000).toISOString(),
    });
    const mixedDelivery = { ...coalesceDeliveries([ordinary, ownerRelay]), wakeHandle: planHandle };

    await expect(executeWake(mixedDelivery, d)).resolves.toMatchObject({ kind: 'drop' });
    expect(stageManualWakeFn).toHaveBeenCalledTimes(1);
    expect(resumePlanRun).not.toHaveBeenCalled();

    const forgedKeyDelivery = work({
      subscriberId: ownerId,
      eventKey: 'work-item:claimable',
      payload: ownerRelayPayload('resume this agent'),
      source: 'su-relaying-agent',
      wakeHandle: planHandle,
    });
    await expect(executeWake(forgedKeyDelivery, d)).resolves.toMatchObject({ kind: 'drop' });
    expect(stageManualWakeFn).toHaveBeenCalledTimes(2);
    expect(resumePlanRun).not.toHaveBeenCalled();
  });
});

describe('executeWake — managed shutdown replay fence (EI-25270078901082313)', () => {
  // The archived receipt proves one delivery, two attempts, and a hostless
  // resume after accepted shutdown. Its intermediate retry state is UNKNOWN.
  // This distinguishing fixture shows accepted-host retry is sufficient even
  // when no detached turn or failed-turn exit/reopen callback ever occurred.
  const ownerId = 'su-7afe5ac1-8a88-4476-bff8-104ca4a195dd';
  const nativeId = '01a1132f-8539-7d42-be10-9a3fee60765f';
  const shutdown = { at: '2026-10-06T22:07:55.842Z', by: ownerId };
  const replay = (over: Partial<DeliveryWork> = {}) => work({
    id: 460479,
    subscriberId: ownerId,
    eventKey: `coord:inbox-wake:${ownerId}`,
    payload: { msg_id: 'coord-send-041fbf6037af2ab2888028dc35d009ad271e6eb8ce9caa589a0c95ab44b2c94d' },
    createdAt: '2026-10-06T22:07:15.733Z',
    wakeHandle: advHandle({ sessionId: nativeId }),
    ...over,
  });
  const endedSession = () => session({
    coordOwnerId: ownerId,
    sessionId: nativeId,
    startedAt: '2026-10-06T22:00:00.000Z',
    endedAt: '2026-10-06T22:07:56.001Z',
  });

  it('settles the same accepted-host delivery after shutdown without a failed-turn callback or hostless resume', async () => {
    let stopped = false;
    const onResumeTurnExit = vi.fn();
    const d = deps({
      getSession: vi.fn(async () => stopped ? endedSession() : { ...endedSession(), endedAt: null }) as never,
      getSessionLifecycle: vi.fn(async () => stopped ? { shutdown } : null) as never,
      findPsuHost: vi.fn(() => stopped ? null : { sock: '/tmp/managed-shutdown.sock' }) as never,
      injectPsuHost: undefined,
      injectPsuHostWithConfirmation: vi.fn(async () => ({ ok: true, confirmation: 'acked', reason: 'accepted' })) as never,
      recoverToolReferenceDeath: vi.fn(async () => 'not-dead' as const),
      onResumeTurnExit,
    });
    expect(await executeWake(replay(), d)).toMatchObject({ kind: 'park', hostCommitPending: true });
    expect(d.spawnDetached).not.toHaveBeenCalled();
    expect(onResumeTurnExit).not.toHaveBeenCalled();

    stopped = true;
    const outcome = await executeWake(replay({
      attempts: 2,
      lastError: 'psu-host accepted: delivery accepted before turn-start proof; retry remains durable',
    }), d);
    expect(outcome).toMatchObject({ kind: 'drop', reason: expect.stringContaining('managed shutdown') });
    expect(d.spawnDetached).not.toHaveBeenCalled();
    expect(d.claimResume).not.toHaveBeenCalled();
    expect(onResumeTurnExit).not.toHaveBeenCalled();
  });

  it.each([null, 'resume-turn-death:process-exit'])('also fences an old delivery with retry history %s', async (lastError) => {
    const d = deps({
      getSession: vi.fn(async () => endedSession()) as never,
      getSessionLifecycle: vi.fn(async () => ({ shutdown })) as never,
      alive: vi.fn(() => false),
      recoverToolReferenceDeath: vi.fn(async () => 'not-dead' as const),
    });
    expect(await executeWake(replay({ attempts: 2, lastError }), d)).toMatchObject({ kind: 'drop' });
    expect(d.spawnDetached).not.toHaveBeenCalled();
    expect(d.claimResume).not.toHaveBeenCalled();
  });

  it('keeps a genuinely newer wake durable until a managed host is available, then injects once', async () => {
    let hostAvailable = false;
    const d = deps({
      getSession: vi.fn(async () => endedSession()) as never,
      getSessionLifecycle: vi.fn(async () => ({ shutdown })) as never,
      findPsuHost: vi.fn(() => hostAvailable ? { sock: '/tmp/restored-managed-host.sock' } : null) as never,
      alive: vi.fn(() => false),
      recoverToolReferenceDeath: vi.fn(async () => 'not-dead' as const),
    });
    const freshWake = replay({ id: 460480, createdAt: '2026-10-06T22:08:07.000Z', attempts: 1 });
    expect(await executeWake(freshWake, d)).toMatchObject({
      kind: 'park', reason: expect.stringContaining('managed psu host'),
    });
    expect(d.spawnDetached).not.toHaveBeenCalled();
    expect(d.claimResume).not.toHaveBeenCalled();
    hostAvailable = true;
    expect(await executeWake(freshWake, d)).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(d.injectPsuHost).toHaveBeenCalledTimes(1);
    expect(d.injectPsuHost).toHaveBeenCalledWith('/tmp/restored-managed-host.sock', expect.objectContaining({ deliveryId: '460480' }));
    expect(d.spawnDetached).not.toHaveBeenCalled();
  });

  it('does not replay pre-shutdown wakes even after a managed successor becomes available', async () => {
    const d = deps({
      getSessionLifecycle: vi.fn(async () => ({ shutdown })) as never,
      findPsuHost: vi.fn(() => ({ sock: '/tmp/new-managed-host.sock' })) as never,
    });
    for (const wakeHandle of [null, advHandle({ sessionId: nativeId }), { kind: 'plan-run' as const, runId: 12 }]) {
      expect(await executeWake(replay({ wakeHandle }), d)).toMatchObject({ kind: 'drop' });
    }
    expect(d.findPsuHost).not.toHaveBeenCalled();
    expect(d.injectPsuHost).not.toHaveBeenCalled();
    expect(d.resumePlanRun).not.toHaveBeenCalled();
  });

  it('does not spawn headlessly if the restored host disappears during injection', async () => {
    const d = deps({
      getSession: vi.fn(async () => endedSession()) as never,
      getSessionLifecycle: vi.fn(async () => ({ shutdown })) as never,
      findPsuHost: vi.fn().mockReturnValueOnce({ sock: '/tmp/disappearing-host.sock' }).mockReturnValue(null),
      injectPsuHost: vi.fn(async () => false),
      alive: vi.fn(() => false),
      recoverToolReferenceDeath: vi.fn(async () => 'not-dead' as const),
    });
    const outcome = await executeWake(replay({ id: 460480, createdAt: '2026-10-06T22:08:07.000Z' }), d);
    expect(outcome).toMatchObject({ kind: 'park' });
    expect(d.spawnDetached).not.toHaveBeenCalled();
    expect(d.claimResume).not.toHaveBeenCalled();
  });

  it('removes a pre-shutdown replay folded behind a genuinely newer headline', async () => {
    const d = deps({
      getSessionLifecycle: vi.fn(async () => ({ shutdown })) as never,
      findPsuHost: vi.fn(() => ({ sock: '/tmp/reattached-host.sock' })) as never,
    });
    const fresh = replay({ id: 460480, wakeHandle: null, createdAt: '2026-10-06T22:08:07.000Z', summary: 'NEW-MANAGED-WORK' });
    const events = [replay({ summary: 'OLD-HANDLED-WORK' }), fresh].map((event) => ({
      event: event.eventKey, summary: event.summary, payload: event.payload, delivery_id: event.id, createdAt: event.createdAt,
    }));
    const outcome = await executeWake({ ...fresh, payload: { coalesced: true, events, latest: events[1] } }, d);
    expect(outcome).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    const text = vi.mocked(d.injectPsuHost!).mock.calls[0][1].data;
    expect(text).toContain('NEW-MANAGED-WORK');
    expect(text).not.toContain('OLD-HANDLED-WORK');
    expect(text).not.toContain('460479');
  });
});

describe('executeWake — durable fleet release latch (EI-203843)', () => {
  it('drops every wake shape before any injection or resume side effect', async () => {
    const lifecycle = {
      released: { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' },
    };
    const cases = [
      work({ wakeHandle: null }),
      work({ wakeHandle: { kind: 'plan-run', runId: 12 } }),
      work({ wakeHandle: advHandle() }),
    ];
    for (const delivery of cases) {
      const d = deps({ getSessionLifecycle: vi.fn(async () => lifecycle) });
      const out = await executeWake(delivery, d);
      expect(out).toMatchObject({ kind: 'drop' });
      expect((out as { reason: string }).reason).toContain('released');
      expect((out as { reason: string }).reason).toContain('end now');
      expect(d.findPsuHost).not.toHaveBeenCalled();
      expect(d.spawnDetached).not.toHaveBeenCalled();
      expect(d.resumePlanRun).not.toHaveBeenCalled();
      expect(d.write).not.toHaveBeenCalled();
    }
  });

  it('continues the normal ladder when no release marker is present', async () => {
    const d = deps({
      getSessionLifecycle: vi.fn(async () => null),
      presence: vi.fn(async () => stalePresence) as never,
    });
    await expect(executeWake(work({ wakeHandle: null }), d)).resolves.toMatchObject({
      kind: 'delivered',
      channel: 'inbox',
    });
  });
});

describe('executeWake — delivery-time stale lock-grant ownership (EI-22449230917085417)', () => {
  const grantedWork = (overrides: Partial<DeliveryWork> = {}): DeliveryWork =>
    work({
      payload: { granted: true, lock_id: 'lock-grant-1', ticket_id: 'ticket-1', paths: ['foo.ts'] },
      wakeHandle: advHandle(),
      ...overrides,
    });

  it('downgrades a grant fired before the owner released the lock, before any wake side effect', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-stale-grant' }));
    const write = vi.fn(() => true);
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const readLockGrantOwnership = vi.fn(async () => false);
    const d = deps({
      findPty: findPty as never,
      write: write as never,
      sendCoordMessage: sendCoordMessage as never,
      readLockGrantOwnership,
    });

    const out = await executeWake(grantedWork(), d);

    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(readLockGrantOwnership).toHaveBeenCalledWith('su-abc', 'lock-grant-1');
    expect(sendCoordMessage).toHaveBeenCalledTimes(1);
    const [, opts] = sendCoordMessage.mock.calls[0] as unknown as [unknown, { summary: string; body: string }];
    expect(opts.summary).toContain('STALE');
    expect(opts.summary).toContain('RETRACTED');
    expect(opts.body).toContain('STALE');
    expect(findPty).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps a currently held grant on the normal wake ladder', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-current-grant' }));
    const write = vi.fn(() => true);
    const readLockGrantOwnership = vi.fn(async () => true);
    const d = deps({ findPty: findPty as never, write: write as never, readLockGrantOwnership });

    await expect(executeWake(grantedWork(), d)).resolves.toEqual({
      kind: 'delivered',
      channel: 'pty-inject',
    });
    expect(readLockGrantOwnership).toHaveBeenCalledWith('su-abc', 'lock-grant-1');
    expect(write).toHaveBeenCalled();
  });
});

describe('executeWake — delivery-time fleet claim-release freshness (EI-21555327100993502)', () => {
  const claimReleasedWork = (overrides: Partial<DeliveryWork> = {}): DeliveryWork =>
    work({
      eventKey: 'fleet:claim-released:pui-cockpit',
      payload: { id: 'WI-42197', harness: 'papercusp' },
      wakeHandle: advHandle(),
      ...overrides,
    });

  it('fresh unclaimed item still follows the normal wake ladder', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-fresh' }));
    const write = vi.fn<NonNullable<ExecuteWakeDeps['write']>>(() => true);
    const getCurrentWorkItem = vi.fn(async () => ({ id: 'WI-42197', assignee: null })) as never;
    const d = deps({ findPty: findPty as never, write: write as never, getCurrentWorkItem });

    const out = await executeWake(claimReleasedWork(), d);

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(getCurrentWorkItem).toHaveBeenCalledWith('WI-42197', 'papercusp');
    expect(findPty).toHaveBeenCalledWith(9999, 'su-abc');
    expect(write).toHaveBeenCalled();
    expect(d.sendCoordMessage).not.toHaveBeenCalled();
  });

  it('re-claimed item is downgraded to the coord inbox before any wake side effect', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-reclaimed' }));
    const write = vi.fn(() => true);
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const getCurrentWorkItem = vi.fn(async () => ({ id: 'WI-42197', assignee: 'su-worker' })) as never;
    const d = deps({
      findPty: findPty as never,
      write: write as never,
      sendCoordMessage: sendCoordMessage as never,
      getCurrentWorkItem,
    });

    const out = await executeWake(claimReleasedWork(), d);

    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(getCurrentWorkItem).toHaveBeenCalledWith('WI-42197', 'papercusp');
    expect(sendCoordMessage).toHaveBeenCalledTimes(1);
    const [, opts] = sendCoordMessage.mock.calls[0] as unknown as [unknown, { summary: string; body: string }];
    expect(opts.summary).toContain('already claimed by su-worker');
    expect(opts.body).toContain('fleet:claim-released:pui-cockpit');
    expect(findPty).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(d.spawnDetached).not.toHaveBeenCalled();
    expect(d.resumePlanRun).not.toHaveBeenCalled();
  });

  it('missing or unreadable current item fails open and preserves the normal wake', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookups = [
      vi.fn(async () => null),
      vi.fn(async () => {
        throw new Error('work-item store unavailable');
      }),
    ];

    for (const getCurrentWorkItem of lookups) {
      const findPty = vi.fn(() => ({ id: 'pty-fail-open' }));
      const write = vi.fn(() => true);
      const d = deps({ findPty: findPty as never, write: write as never, getCurrentWorkItem: getCurrentWorkItem as never });

      await expect(executeWake(claimReleasedWork(), d)).resolves.toEqual({
        kind: 'delivered',
        channel: 'pty-inject',
      });
      expect(findPty).toHaveBeenCalled();
      expect(write).toHaveBeenCalled();
      expect(d.sendCoordMessage).not.toHaveBeenCalled();
    }

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('work-item store unavailable'));
  });

  it('malformed fleet claim-release payload skips the lookup and preserves the normal wake', async () => {
    const getCurrentWorkItem = vi.fn(async () => ({ id: 'WI-42197', assignee: 'su-worker' })) as never;
    const findPty = vi.fn(() => ({ id: 'pty-malformed' }));
    const write = vi.fn(() => true);
    const d = deps({
      findPty: findPty as never,
      write: write as never,
      getCurrentWorkItem,
    });

    const out = await executeWake(
      claimReleasedWork({ payload: { id: 'WI-42197', harness: 42 } }),
      d,
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(getCurrentWorkItem).not.toHaveBeenCalled();
    expect(findPty).toHaveBeenCalled();
    expect(write).toHaveBeenCalled();
  });
});

describe('executeWake — delivery-time fleet member-dead liveness re-check (EI-21901188813309549)', () => {
  const memberDeadWork = (overrides: Partial<DeliveryWork> = {}): DeliveryWork =>
    work({
      eventKey: 'fleet:member-dead:pui-cockpit',
      payload: { fleetSlug: 'pui-cockpit', agentId: 'su-worker', transition: 'member-dead', from: 'live', to: 'ended' },
      wakeHandle: advHandle(),
      ...overrides,
    });

  const verdictMap = (sessionState: string | null) =>
    vi.fn(async () => new Map([['su-worker', { ownerId: 'su-worker', sessionState, wakeable: false, liveTurn: false, confirmLiveness: null, heartbeatFresh: false } as never]]));

  it('still-ended member still delivers the normal wake', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-still-dead' }));
    const write = vi.fn(() => true);
    const resolveMemberLiveness = verdictMap('ended');
    const d = deps({ findPty: findPty as never, write: write as never, resolveMemberLiveness: resolveMemberLiveness as never });

    const out = await executeWake(memberDeadWork(), d);

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(resolveMemberLiveness).toHaveBeenCalledWith([{ ownerId: 'su-worker' }], { hydratePerId: true });
    expect(findPty).toHaveBeenCalled();
    expect(write).toHaveBeenCalled();
    expect(d.sendCoordMessage).not.toHaveBeenCalled();
  });

  it('a member confirmed no longer ended is downgraded to the coord inbox before any wake side effect', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-recovered' }));
    const write = vi.fn(() => true);
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const resolveMemberLiveness = verdictMap('live');
    const d = deps({
      findPty: findPty as never,
      write: write as never,
      sendCoordMessage: sendCoordMessage as never,
      resolveMemberLiveness: resolveMemberLiveness as never,
    });

    const out = await executeWake(memberDeadWork(), d);

    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(sendCoordMessage).toHaveBeenCalledTimes(1);
    const [, opts] = sendCoordMessage.mock.calls[0] as unknown as [unknown, { summary: string; body: string }];
    expect(opts.summary).toContain("currently 'live', not 'ended'");
    expect(opts.body).toContain('fleet:member-dead:pui-cockpit');
    expect(findPty).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('a draining member is downgraded to a corrected inbox notice before any wake side effect', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-draining' }));
    const write = vi.fn(() => true);
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const resolveMemberLiveness = verdictMap('draining');
    const d = deps({
      findPty: findPty as never,
      write: write as never,
      sendCoordMessage: sendCoordMessage as never,
      resolveMemberLiveness: resolveMemberLiveness as never,
    });

    const out = await executeWake(memberDeadWork(), d);

    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(resolveMemberLiveness).toHaveBeenCalledWith([{ ownerId: 'su-worker' }], { hydratePerId: true });
    const [, opts] = sendCoordMessage.mock.calls[0] as unknown as [unknown, { summary: string; body: string }];
    expect(opts.summary).toContain("currently 'draining', not 'ended'");
    expect(opts.body).toContain('⚠ STALE');
    expect(opts.body).toContain('RETRACTED');
    expect(findPty).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  // EI-22068041747784942: the REAL emit-time payload (emitFleetTransitionEdge)
  // asserts "fleet X: member Y is DEAD (...)" as `d.summary`. The downgrade
  // message used to APPEND the correction AFTER that assertion, so a reader
  // skimming only the leading clause could still be misled into believing the
  // member is dead (the exact risk a leader could act on destructively, even
  // though — per the tests above and below — executeWake itself never resumes/
  // PTY-injects on a confirmed-stale delivery). The corrected reading must now be
  // the FIRST thing stated, and the original claim must be explicitly labeled as
  // retracted rather than repeated as a fresh assertion. Uses the REAL production
  // summary shape (not the generic `work()` default) so this test actually
  // exercises the misleading-headline risk the bug describes.
  it('the downgraded summary leads with the correction and marks the original DEAD claim as retracted, never re-asserting it', async () => {
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const resolveMemberLiveness = verdictMap('live');
    const d = deps({ sendCoordMessage: sendCoordMessage as never, resolveMemberLiveness: resolveMemberLiveness as never });
    const productionSummary = 'fleet pui-cockpit: member su-worker is DEAD (live → ended)';

    await executeWake(memberDeadWork({ summary: productionSummary }), d);

    expect(sendCoordMessage).toHaveBeenCalledTimes(1);
    const [, opts] = sendCoordMessage.mock.calls[0] as unknown as [unknown, { summary: string; body: string }];
    // `opts.summary` is built from the `reason` string, independent of `d.summary` —
    // it must ALSO say the wake is stale/retracted, never just "currently 'live'"
    // with no corrective framing.
    expect(opts.summary).toContain("currently 'live', not 'ended'");
    expect(opts.summary).toContain('STALE');
    expect(opts.summary).toContain('RETRACTED');
    // `d.summary` (the original "is DEAD" assertion, PLUS our correction) flows
    // into the injected turn TEXT via wakeTurnText → opts.body. The leading
    // clause there must be the CORRECTED truth, not the stale "is DEAD" claim.
    expect(opts.body.indexOf('STALE')).toBeGreaterThanOrEqual(0);
    expect(opts.body.indexOf('is DEAD')).toBeGreaterThan(opts.body.indexOf('STALE'));
    expect(opts.body).toContain('⚠ STALE');
    // The original claim survives (for audit trail) but is explicitly labeled
    // RETRACTED — never left to read as a live/current assertion.
    expect(opts.body).toContain('RETRACTED');
    expect(opts.body).toContain(productionSummary);
    expect(opts.body).toContain('Do NOT treat this as a live death signal');
  });

  it('unknown/missing/erroring liveness read fails open and preserves the normal wake', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolvers = [
      vi.fn(async () => new Map()), // unmatched ownerId
      vi.fn(async () => new Map([['su-worker', { ownerId: 'su-worker', sessionState: null } as never]])), // unknown state
      vi.fn(async () => {
        throw new Error('liveness oracle unavailable');
      }),
    ];

    for (const resolveMemberLiveness of resolvers) {
      const findPty = vi.fn(() => ({ id: 'pty-fail-open' }));
      const write = vi.fn(() => true);
      const d = deps({ findPty: findPty as never, write: write as never, resolveMemberLiveness: resolveMemberLiveness as never });

      await expect(executeWake(memberDeadWork(), d)).resolves.toEqual({ kind: 'delivered', channel: 'pty-inject' });
      expect(findPty).toHaveBeenCalled();
      expect(write).toHaveBeenCalled();
      expect(d.sendCoordMessage).not.toHaveBeenCalled();
    }
  });

  it('malformed member-dead payload skips the liveness lookup and preserves the normal wake', async () => {
    const resolveMemberLiveness = verdictMap('live');
    const findPty = vi.fn(() => ({ id: 'pty-malformed' }));
    const write = vi.fn(() => true);
    const d = deps({ findPty: findPty as never, write: write as never, resolveMemberLiveness: resolveMemberLiveness as never });

    const out = await executeWake(memberDeadWork({ payload: { fleetSlug: 'pui-cockpit', transition: 'member-dead' } }), d);

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(resolveMemberLiveness).not.toHaveBeenCalled();
    expect(findPty).toHaveBeenCalled();
    expect(write).toHaveBeenCalled();
  });

  it('a non-member-dead event key is unaffected by the liveness check', async () => {
    const resolveMemberLiveness = verdictMap('live');
    const findPty = vi.fn(() => ({ id: 'pty-unrelated' }));
    const write = vi.fn(() => true);
    const d = deps({ findPty: findPty as never, write: write as never, resolveMemberLiveness: resolveMemberLiveness as never });

    const out = await executeWake(work({ eventKey: 'lock:grant:t-1', wakeHandle: advHandle() }), d);

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(resolveMemberLiveness).not.toHaveBeenCalled();
  });
});

describe('executeWake — delivery-time fleet context-critical member actionability (EI-26207385902174159)', () => {
  const contextCriticalWork = (overrides: Partial<DeliveryWork> = {}): DeliveryWork =>
    work({
      eventKey: 'fleet:context-critical:pui-cockpit',
      payload: {
        fleetSlug: 'pui-cockpit',
        agentId: 'su-worker',
        transition: 'context-critical',
        contextEpoch: 18,
      },
      wakeHandle: advHandle(),
      ...overrides,
    });

  const liveness = (sessionState: string | null, wakeable = false) =>
    vi.fn(async () => new Map([
      ['su-worker', { ownerId: 'su-worker', sessionState, wakeable, liveTurn: false } as never],
    ]));

  const presenceRow = { source: 'presence' } as never;

  it('downgrades an absent fleet target before any wake side effect', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-should-not-run' }));
    const write = vi.fn(() => true);
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const getCurrentFleetContextAssignments = vi.fn(async () => []);
    const resolveMemberLiveness = liveness(null);
    const d = deps({
      findPty: findPty as never,
      write: write as never,
      sendCoordMessage: sendCoordMessage as never,
      getCurrentFleetContextAssignments: getCurrentFleetContextAssignments as never,
      resolveMemberLiveness: resolveMemberLiveness as never,
      getCurrentContextPressure: vi.fn(async () => 'critical') as never,
      getCurrentContextEpoch: vi.fn(async () => 18),
    });

    const out = await executeWake(contextCriticalWork(), d);

    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(getCurrentFleetContextAssignments).toHaveBeenCalledWith({
      workspaceId: 'ws', fleet: 'pui-cockpit', agent: 'su-worker',
    });
    expect(resolveMemberLiveness).toHaveBeenCalledWith([{ ownerId: 'su-worker' }], { hydratePerId: true });
    expect(sendCoordMessage).toHaveBeenCalledTimes(1);
    const [, opts] = sendCoordMessage.mock.calls[0] as unknown as [unknown, { summary: string; body: string }];
    expect(opts.summary).toContain('no current fleet presence or active claim');
    expect(opts.summary).toContain('STALE');
    expect(findPty).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('downgrades a target that ended after emit even while its presence row remains', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-should-not-run' }));
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const d = deps({
      findPty: findPty as never,
      sendCoordMessage: sendCoordMessage as never,
      getCurrentFleetContextAssignments: vi.fn(async () => [presenceRow]) as never,
      resolveMemberLiveness: liveness('ended') as never,
      getCurrentContextPressure: vi.fn(async () => 'critical') as never,
      getCurrentContextEpoch: vi.fn(async () => 18),
    });

    const out = await executeWake(contextCriticalWork(), d);

    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    const [, opts] = sendCoordMessage.mock.calls[0] as unknown as [unknown, { summary: string }];
    expect(opts.summary).toContain("target session is currently 'ended'");
    expect(findPty).not.toHaveBeenCalled();
  });

  it('preserves a current target wake when the roster read is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const findPty = vi.fn(() => ({ id: 'pty-current' }));
    const write = vi.fn(() => true);
    try {
      const d = deps({
        findPty: findPty as never,
        write: write as never,
        getCurrentFleetContextAssignments: vi.fn(async () => { throw new Error('roster unavailable'); }) as never,
        resolveMemberLiveness: liveness('live', true) as never,
        getCurrentContextPressure: vi.fn(async () => 'critical') as never,
        getCurrentContextEpoch: vi.fn(async () => 18),
      });

      const out = await executeWake(contextCriticalWork(), d);

      expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
      expect(findPty).toHaveBeenCalled();
      expect(write).toHaveBeenCalled();
      expect(d.sendCoordMessage).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('fleet context-critical roster/su-worker failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves a current target that still has fleet presence and a critical context', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-current' }));
    const write = vi.fn(() => true);
    const d = deps({
      findPty: findPty as never,
      write: write as never,
      getCurrentFleetContextAssignments: vi.fn(async () => [presenceRow]) as never,
      resolveMemberLiveness: liveness('live', true) as never,
      getCurrentContextPressure: vi.fn(async () => 'critical') as never,
      getCurrentContextEpoch: vi.fn(async () => 18),
    });

    const out = await executeWake(contextCriticalWork(), d);

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(findPty).toHaveBeenCalled();
    expect(write).toHaveBeenCalled();
  });

  // WI-6554700010018677: real delivery rows are pinned to DEFAULT_COORD_WORKSPACE, while the
  // roster is keyed by the member's tenant. Reading it under the delivery workspace returned
  // no rows, so a live member was retracted as "no current fleet presence".
  it('reads the roster under the member tenant when the delivery is in the coordination namespace', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-current' }));
    const write = vi.fn(() => true);
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const getCurrentFleetContextAssignments = vi.fn(async (opts: { workspaceId?: string }) =>
      opts.workspaceId === 'tenant-ws' ? [presenceRow] : [],
    );
    const workspaceForCoordOwnerFn = vi.fn(async () => 'tenant-ws');
    const d = deps({
      findPty: findPty as never,
      write: write as never,
      sendCoordMessage: sendCoordMessage as never,
      getCurrentFleetContextAssignments: getCurrentFleetContextAssignments as never,
      workspaceForCoordOwnerFn: workspaceForCoordOwnerFn as never,
      resolveMemberLiveness: liveness('live', true) as never,
      getCurrentContextPressure: vi.fn(async () => 'critical') as never,
      getCurrentContextEpoch: vi.fn(async () => 18),
    });

    const out = await executeWake(contextCriticalWork({ workspaceId: DEFAULT_COORD_WORKSPACE }), d);

    expect(workspaceForCoordOwnerFn).toHaveBeenCalledWith('su-worker');
    expect(getCurrentFleetContextAssignments).toHaveBeenCalledWith({
      workspaceId: 'tenant-ws', fleet: 'pui-cockpit', agent: 'su-worker',
    });
    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(write).toHaveBeenCalled();
    for (const call of sendCoordMessage.mock.calls as unknown as Array<[unknown, { summary?: string }]>) {
      expect(call[1]?.summary ?? '').not.toContain('no current fleet presence or active claim');
    }
  });

  it('treats an unresolvable member tenant as an unknown roster and preserves the wake', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-current' }));
    const write = vi.fn(() => true);
    const getCurrentFleetContextAssignments = vi.fn(async () => []);
    const d = deps({
      findPty: findPty as never,
      write: write as never,
      getCurrentFleetContextAssignments: getCurrentFleetContextAssignments as never,
      workspaceForCoordOwnerFn: vi.fn(async () => null) as never,
      resolveMemberLiveness: liveness('live', true) as never,
      getCurrentContextPressure: vi.fn(async () => 'critical') as never,
      getCurrentContextEpoch: vi.fn(async () => 18),
    });

    const out = await executeWake(contextCriticalWork({ workspaceId: DEFAULT_COORD_WORKSPACE }), d);

    expect(getCurrentFleetContextAssignments).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
  });
});

describe('executeWake — delivery-time canonical claimable freshness (EI-21584263523911583)', () => {
  const claimableWork = (overrides: Partial<DeliveryWork> = {}): DeliveryWork =>
    work({
      eventKey: 'work-item:claimable',
      payload: {
        id: 'WI-42419',
        kind: 'bug',
        harness: 'papercusp',
        state: 'open',
        reason: 'requeued',
      },
      wakeHandle: advHandle(),
      ...overrides,
    });

  it('downgrades a confirmed terminal claimable payload before any wake side effect', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-stale' }));
    const write = vi.fn(() => true);
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const getCurrentWorkItem = vi.fn(async () => ({ id: 'WI-42419', state: 'done', assignee: null, payload: null })) as never;
    const d = deps({
      findPty: findPty as never,
      write: write as never,
      sendCoordMessage: sendCoordMessage as never,
      getCurrentWorkItem,
    });

    const out = await executeWake(claimableWork(), d);

    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(getCurrentWorkItem).toHaveBeenCalledWith('WI-42419', 'papercusp');
    expect(sendCoordMessage).toHaveBeenCalledTimes(1);
    const [, opts] = sendCoordMessage.mock.calls[0] as unknown as [unknown, { summary: string; body: string }];
    expect(opts.summary).toContain('revalidated stale item(s): WI-42419');
    expect(opts.body).toContain('no longer claimable');
    expect(findPty).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('cancels an accepted native delivery before downgrading its now-stale claimable retry', async () => {
    const ownerId = 'su-stale-claimable';
    const sock = '/tmp/stale-claimable.sock';
    const pendingHostWrites = new Map<string, string>();
    let itemState = 'open';
    let cancellationAttempts = 0;
    const injectPsuHostWithConfirmation = vi.fn<NonNullable<ExecuteWakeDeps['injectPsuHostWithConfirmation']>>(
      async (_sock, message) => {
        const deliveryId = String(message.deliveryId ?? '');
        if (message.mode === 'delivery-cancel') {
          cancellationAttempts += 1;
          if (cancellationAttempts === 1) {
            return { ok: true, confirmation: 'acked' as const, reason: 'cancel-requested' };
          }
          if (cancellationAttempts === 2) {
            return { ok: false, confirmation: 'acked' as const, reason: 'delivery-already-writing' };
          }
          const cancelled = pendingHostWrites.delete(deliveryId);
          return {
            ok: true,
            confirmation: 'acked' as const,
            reason: cancelled ? 'cancelled-before-write' : 'delivery-unknown',
          };
        }
        if (message.mode === 'turn') {
          if (!pendingHostWrites.has(deliveryId)) pendingHostWrites.set(deliveryId, message.data);
          return {
            ok: true,
            confirmation: 'acked' as const,
            reason: pendingHostWrites.size === 1 ? 'accepted' : 'pending-delivery-id',
          };
        }
        return { ok: false, confirmation: 'acked' as const, reason: 'unexpected-mode' };
      },
    );
    const getCurrentWorkItem = vi.fn(async () => ({
      id: 'WI-42419', state: itemState, assignee: null, payload: null,
    })) as never;
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const delivery = claimableWork({ id: 782698, subscriberId: ownerId, wakeHandle: null });
    const d = deps({
      findPsuHost: vi.fn(() => ({ sock, ownerId, caps: ['delivery-cancel'] })) as never,
      injectPsuHost: undefined,
      injectPsuHostWithConfirmation: injectPsuHostWithConfirmation as never,
      getCurrentWorkItem,
      sendCoordMessage: sendCoordMessage as never,
    });

    await expect(executeWake(delivery, d)).resolves.toMatchObject({
      kind: 'park', hostCommitPending: true, reason: expect.stringContaining('accepted'),
    });
    expect(pendingHostWrites.has('782698')).toBe(true);

    itemState = 'done';
    const staleRetry = {
      ...delivery,
      attempts: 2,
      lastError: 'psu-host accepted: delivery accepted before turn-start proof; retry remains durable',
    };
    const requestOnly = await executeWake(staleRetry, d);
    expect(requestOnly).toMatchObject({
      kind: 'park', hostCommitPending: true, reason: expect.stringContaining('cancel-requested'),
    });
    expect(pendingHostWrites.has('782698')).toBe(true);
    expect(sendCoordMessage).not.toHaveBeenCalled();

    const writingRetry = {
      ...staleRetry,
      lastError: requestOnly.kind === 'park' ? requestOnly.reason : staleRetry.lastError,
    };
    const writing = await executeWake(writingRetry, d);
    expect(writing).toMatchObject({
      kind: 'park', hostCommitPending: true, reason: expect.stringContaining('delivery-already-writing'),
    });
    expect(pendingHostWrites.has('782698')).toBe(true);
    expect(sendCoordMessage).not.toHaveBeenCalled();

    const receiptRetry = {
      ...writingRetry,
      lastError: writing.kind === 'park' ? writing.reason : writingRetry.lastError,
    };
    await expect(executeWake(receiptRetry, d)).resolves.toEqual({ kind: 'delivered', channel: 'inbox' });

    expect(injectPsuHostWithConfirmation.mock.calls.map((call) => call[1].mode)).toEqual([
      'turn', 'delivery-cancel', 'delivery-cancel', 'delivery-cancel',
    ]);
    expect(injectPsuHostWithConfirmation.mock.calls[1]?.[1]).toMatchObject({
      mode: 'delivery-cancel', ownerId, deliveryId: '782698',
    });
    expect(injectPsuHostWithConfirmation.mock.calls[2]?.[1]).toMatchObject({
      mode: 'delivery-cancel', ownerId, deliveryId: '782698',
    });
    expect(pendingHostWrites.has('782698')).toBe(false);
    expect(sendCoordMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a current unclaimed claimable item on the normal wake ladder', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-current' }));
    const write = vi.fn(() => true);
    const getCurrentWorkItem = vi.fn(async () => ({ id: 'WI-42419', state: 'open', assignee: null, payload: null })) as never;
    const d = deps({ findPty: findPty as never, write: write as never, getCurrentWorkItem });

    await expect(executeWake(claimableWork(), d)).resolves.toEqual({
      kind: 'delivered',
      channel: 'pty-inject',
    });
    expect(getCurrentWorkItem).toHaveBeenCalledWith('WI-42419', 'papercusp');
    expect(write).toHaveBeenCalled();
  });

  it('fails open on a missing or unreadable claimable lookup', async () => {
    const lookups = [
      vi.fn(async () => null),
      vi.fn(async () => {
        throw new Error('work-item store unavailable');
      }),
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (const getCurrentWorkItem of lookups) {
      const findPty = vi.fn(() => ({ id: 'pty-fail-open' }));
      const write = vi.fn(() => true);
      const d = deps({ findPty: findPty as never, write: write as never, getCurrentWorkItem: getCurrentWorkItem as never });

      await expect(executeWake(claimableWork(), d)).resolves.toEqual({
        kind: 'delivered',
        channel: 'pty-inject',
      });
      expect(findPty).toHaveBeenCalled();
      expect(write).toHaveBeenCalled();
      expect(d.sendCoordMessage).not.toHaveBeenCalled();
    }

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('work-item store unavailable'));
  });

  it('removes only stale claimable components from a coalesced wake', async () => {
    const { coalesceDeliveries } = await import('./engine');
    const stale = claimableWork({ id: 70, createdAt: new Date(1000).toISOString() });
    const live = work({
      id: 71,
      eventKey: 'lock:grant:t-1',
      summary: 'the lock is still actionable',
      payload: { ok: true },
      createdAt: new Date(2000).toISOString(),
      wakeHandle: advHandle(),
    });
    const findPty = vi.fn(() => ({ id: 'pty-coalesced' }));
    const write = vi.fn<NonNullable<ExecuteWakeDeps['write']>>(() => true);
    const getCurrentWorkItem = vi.fn(async () => ({ id: 'WI-42419', state: 'done', assignee: null, payload: null })) as never;
    const d = deps({ findPty: findPty as never, write: write as never, getCurrentWorkItem });

    const out = await executeWake({ ...coalesceDeliveries([stale, live]), wakeHandle: advHandle() }, d);

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(getCurrentWorkItem).toHaveBeenCalledWith('WI-42419', 'papercusp');
    expect(write).toHaveBeenCalled();
    const injected = String((write.mock.calls[0]?.[1] as Buffer | undefined)?.toString('utf8') ?? '');
    expect(injected).toContain('lock:grant:t-1');
    expect(injected).toContain('the lock is still actionable');
    expect(injected).not.toContain('WI-42419');
    expect(injected).not.toContain('requeued');
  });
});

describe('executeWake — terminal blocked-item lifecycle binding freshness (EI-24119981583160918)', () => {
  const blockedHolderWork = (overrides: Partial<DeliveryWork> = {}): DeliveryWork =>
    work({
      eventKey: 'work-item:done:WI-10002513',
      payload: {
        id: 'WI-10002513',
        bound_to: { kind: 'work-item-blocked', ref: 'WI-10002520' },
        armed_because: 'blocked-item-holder auto-arm for WI-10002520',
      },
      wakeHandle: advHandle(),
      ...overrides,
    });

  it('drops a queued blocked-holder wake when its bound item is already terminal', async () => {
    const findPty = vi.fn();
    const write = vi.fn();
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const getCurrentWorkItem = vi.fn(async (id: string) => ({ id, state: 'done' })) as never;
    const d = deps({
      findPty: findPty as never,
      write: write as never,
      sendCoordMessage: sendCoordMessage as never,
      getCurrentWorkItem,
    });

    await expect(executeWake(blockedHolderWork(), d)).resolves.toEqual({
      kind: 'drop',
      reason: expect.stringContaining('WI-10002520 are terminal'),
    });
    expect(getCurrentWorkItem).toHaveBeenCalledWith('WI-10002520');
    expect(findPty).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(sendCoordMessage).not.toHaveBeenCalled();
  });

  it('keeps a live bound item on the normal wake ladder', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-live-bound' }));
    const write = vi.fn(() => true);
    const getCurrentWorkItem = vi.fn(async (id: string) => ({ id, state: 'open' })) as never;
    const d = deps({ findPty: findPty as never, write: write as never, getCurrentWorkItem });

    await expect(executeWake(blockedHolderWork(), d)).resolves.toEqual({
      kind: 'delivered',
      channel: 'pty-inject',
    });
    expect(getCurrentWorkItem).toHaveBeenCalledWith('WI-10002520');
    expect(write).toHaveBeenCalled();
  });

  it('removes only terminal-bound components from a coalesced wake', async () => {
    const { coalesceDeliveries } = await import('./engine');
    const stale = blockedHolderWork({ id: 70, createdAt: new Date(1000).toISOString() });
    const live = work({
      id: 71,
      eventKey: 'lock:grant:t-1',
      summary: 'the lock is still actionable',
      payload: { ok: true },
      createdAt: new Date(2000).toISOString(),
      wakeHandle: advHandle(),
    });
    const findPty = vi.fn(() => ({ id: 'pty-coalesced-bound' }));
    const write = vi.fn<NonNullable<ExecuteWakeDeps['write']>>(() => true);
    const getCurrentWorkItem = vi.fn(async (id: string) => ({ id, state: 'done' })) as never;
    const d = deps({ findPty: findPty as never, write: write as never, getCurrentWorkItem });

    const out = await executeWake({ ...coalesceDeliveries([stale, live]), wakeHandle: advHandle() }, d);

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(getCurrentWorkItem).toHaveBeenCalledWith('WI-10002520');
    const injected = String((write.mock.calls[0]?.[1] as Buffer | undefined)?.toString('utf8') ?? '');
    expect(injected).toContain('lock:grant:t-1');
    expect(injected).toContain('the lock is still actionable');
    expect(injected).not.toContain('WI-10002520');
  });

  it('fails open when the bound target cannot be read', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-fail-open' }));
    const write = vi.fn(() => true);
    const getCurrentWorkItem = vi.fn(async () => null) as never;
    const d = deps({ findPty: findPty as never, write: write as never, getCurrentWorkItem });

    await expect(executeWake(blockedHolderWork(), d)).resolves.toEqual({
      kind: 'delivered',
      channel: 'pty-inject',
    });
    expect(findPty).toHaveBeenCalled();
    expect(write).toHaveBeenCalled();
  });
});

describe('executeWake ambient-push seam (P-003, DEFAULT-OFF)', () => {
  const OLD_FLAG = process.env.PAPERCUSP_AMBIENT_CURSOR;
  afterEach(() => {
    if (OLD_FLAG === undefined) delete process.env.PAPERCUSP_AMBIENT_CURSOR;
    else process.env.PAPERCUSP_AMBIENT_CURSOR = OLD_FLAG;
  });

  // Handle-less path with no psu host + stale presence → degrade-to-inbox; the
  // ambient prep runs at the top of executeWake regardless of the outcome path.
  it('invokes prepareAmbientPushBlock (keyed by ownerId) when the flag is ON', async () => {
    process.env.PAPERCUSP_AMBIENT_CURSOR = '1';
    const prep = vi.fn(async () => '⟦ambient⟧ ‼ x — pull: session:su-y');
    await executeWake(
      work({ wakeHandle: null }),
      deps({ prepareAmbientPushBlock: prep, presence: vi.fn(async () => stalePresence) as never }),
    );
    expect(prep).toHaveBeenCalledWith({ ownerId: 'su-abc' });
  });

  it('does NOT invoke prepareAmbientPushBlock when the flag is OFF (DEFAULT-OFF)', async () => {
    delete process.env.PAPERCUSP_AMBIENT_CURSOR;
    const prep = vi.fn(async () => 'x');
    await executeWake(
      work({ wakeHandle: null }),
      deps({ prepareAmbientPushBlock: prep, presence: vi.fn(async () => stalePresence) as never }),
    );
    expect(prep).not.toHaveBeenCalled();
  });

  it('an ambient-prep throw never breaks the wake (fail-soft)', async () => {
    process.env.PAPERCUSP_AMBIENT_CURSOR = '1';
    const prep = vi.fn(async () => {
      throw new Error('store down');
    });
    // stale presence + no psu host → the wake still degrades to inbox, not a throw.
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({ prepareAmbientPushBlock: prep, presence: vi.fn(async () => stalePresence) as never }),
    );
    expect(prep).toHaveBeenCalled();
    expect(out.kind).not.toBe('error');
  });
});

describe('executeWake inbox-wake held-work reminder seam (WI-6554700010018536)', () => {
  const REMINDER =
    "REMINDER (work list snapshot): a recent read found 2 unfinished work-item(s) [WI-1, WI-2]. " +
    "This snapshot may be stale by the time you act; recheck each item's current state and assignee with work_items:get before continuing. " +
    'Answering or reconciling this message does not finish any still-open items.';
  // The pty write receives the injected text as a Buffer: decode every write.
  const written = (write: { mock: { calls: unknown[][] } }): string =>
    write.mock.calls.map((c) => Buffer.from(c[1] as Uint8Array).toString('utf8')).join('');

  it('reads the reminder for an inbox-wake key at delivery time and carries it into the injected text', async () => {
    const prep = vi.fn(async () => REMINDER);
    const findPty = vi.fn(() => ({ id: 'pty-inbox' }));
    const write = vi.fn((..._args: unknown[]) => true);
    const d = work({ eventKey: 'coord:inbox-wake:su-abc', wakeHandle: advHandle() });
    const out = await executeWake(
      d,
      deps({ prepareInboxWakeHeldWorkReminder: prep, findPty: findPty as never, write: write as never }),
    );
    // WI-6554700010018671: the delivery workspace is passed as the coordination namespace it is,
    // never as the recipient's tenant — the helper resolves the tenant itself.
    expect(prep).toHaveBeenCalledWith({ ownerId: 'su-abc', deliveryWorkspaceId: d.workspaceId });
    expect(out.kind === 'delivered' ? 'delivered' : JSON.stringify(out)).toBe('delivered');
    const text = written(write);
    expect(text).toContain('NOTE (inbox-wake)');
    expect(text).toContain(REMINDER);
  });

  it('labels the read as a snapshot when a work item completes before the wake is injected', async () => {
    let currentState = 'open';
    const prep = vi.fn(async () => {
      const snapshot = REMINDER;
      // Model a completion in the read-to-injection gap.
      currentState = 'done';
      return snapshot;
    });
    const write = vi.fn((..._args: unknown[]) => {
      expect(currentState).toBe('done');
      return true;
    });
    const out = await executeWake(
      work({ eventKey: 'coord:inbox-wake:su-abc', wakeHandle: advHandle() }),
      deps({
        prepareInboxWakeHeldWorkReminder: prep,
        findPty: vi.fn(() => ({ id: 'pty-inbox' })) as never,
        write: write as never,
      }),
    );

    expect(out.kind).toBe('delivered');
    const text = written(write);
    expect(text).toContain('work list snapshot');
    expect(text).toContain("recheck each item's current state and assignee with work_items:get");
    expect(text).not.toContain('you still hold');
  });

  it('does NOT read the reminder for a non-inbox-wake key', async () => {
    const prep = vi.fn(async () => REMINDER);
    const write = vi.fn((..._args: unknown[]) => true);
    await executeWake(
      work({ eventKey: 'work-item:done:WI-9', wakeHandle: advHandle() }),
      deps({
        prepareInboxWakeHeldWorkReminder: prep,
        findPty: vi.fn(() => ({ id: 'pty-x' })) as never,
        write: write as never,
      }),
    );
    expect(prep).not.toHaveBeenCalled();
    const text = written(write);
    expect(text).toContain('work-item:done:WI-9'); // positive control: the wake WAS written
    expect(text).not.toContain('REMINDER (held work)');
  });

  it('a reminder-prep throw never breaks the wake (fail-soft)', async () => {
    const prep = vi.fn(async () => {
      throw new Error('pg down');
    });
    const out = await executeWake(
      work({ eventKey: 'coord:inbox-wake:su-abc', wakeHandle: advHandle() }),
      deps({
        prepareInboxWakeHeldWorkReminder: prep,
        findPty: vi.fn(() => ({ id: 'pty-y' })) as never,
        write: vi.fn(() => true) as never,
      }),
    );
    expect(prep).toHaveBeenCalled();
    expect(out.kind).toBe('delivered');
  });
});

describe('wakeTurnText', () => {
  it('carries the key, summary, note and a bounded payload on one line', () => {
    const t = wakeTurnText(work({ payload: { x: 'y'.repeat(1000) } }));
    expect(t).toContain('lock:grant:t-1');
    expect(t).toContain('your lock on foo.ts was granted');
    expect(t).toContain('waiting to edit foo.ts');
    expect(t).not.toContain('\n');
    expect(t.length).toBeLessThan(700);
  });

  /**
   * WI-5867: a carry-respawn can lose the transcript turn that registered an
   * await. The delivered turn must therefore identify the registration as the
   * recipient's own and carry the note joined from that exact await row. Without
   * both, a legitimate post-compaction wake can look like foreign work merely
   * because the note names a work item assigned to a peer.
   */
  it("identifies a post-compaction wake as this session's own await registration", () => {
    const t = wakeTurnText(
      work({
        id: 29_878,
        awaitId: 89,
        note: 'Post-compaction re-registration; waiting on the gate for WI-5827',
      }),
    );

    expect(t).toContain('you registered this with events:await');
    expect(t).toContain('your note: Post-compaction re-registration; waiting on the gate for WI-5827');
    expect(t).toContain('event-wake delivery #29878');
  });

  /**
   * EI-20130618357432548 — the owner's chat-pane message is delivered AS the turn.
   * Everything the wrapper adds (event key, delivery id, inbox-wake reconcile note)
   * is correct for an agent/system wake and wrong here: the chat pane renders this
   * transcript back to the OWNER, so the wrapper is what they read instead of their
   * own message, and its text is what defeated the pane's echo absorption.
   */
  it('delivers an OWNER CHAT-PANE message as the turn itself — no [await-event] wrapper', () => {
    const t = wakeTurnText(
      work({
        eventKey: 'coord:inbox-wake:su-abc',
        summary: 'hi',
        payload: { msg_id: 'm1', ownerChatTurn: true, ownerChatText: 'hi' },
      }),
    );
    expect(t.startsWith('hi\n\n')).toBe(true);
    expect(t).not.toContain('[await-event]');
    expect(t).not.toContain('delivery #');
    expect(t).not.toContain('NOTE (inbox-wake)');
    // …and it tells the agent where its answer is actually read, which is what
    // stopped the doomed coord reply + `human` hedge (EI-20130675657060052).
    expect(t).toContain('⟦owner-chat⟧');
  });

  /**
   * P-022 / D-007 — the prepared cell fold is RENDERED. The block is built in the async
   * delivery path (cell-wake-fold.ts, covered in its own suite); this pins the other
   * half of the seam, which is the half that silently does nothing if it regresses.
   */
  it('renders the P-022 cell fold, and puts it BEFORE the ambient block', () => {
    const t = wakeTurnText(work({ cellWakeFoldBlock: '[cell] gate.x = green', ambientPushBlock: '[ambient] …' }));
    expect(t).toContain('[cell] gate.x = green');
    // Next to the `payload` value it corrects, not below unrelated ambient material.
    expect(t.indexOf('[cell]')).toBeLessThan(t.indexOf('[ambient]'));
    expect(t).toContain('[await-event]');
  });

  it('is byte-identical when no cell fold was prepared — the default path', () => {
    const base = work({ payload: { x: 1 } });
    expect(wakeTurnText(base)).toBe(wakeTurnText({ ...base, cellWakeFoldBlock: undefined }));
  });

  it('carries a LONG owner message in full — the wake summary is truncated, the payload is not', () => {
    const long = 'please '.repeat(40).trim();
    const t = wakeTurnText(
      work({ summary: `${long.slice(0, 77)}…`, payload: { ownerChatTurn: true, ownerChatText: long } }),
    );
    expect(t.startsWith(long)).toBe(true);
    expect(t).not.toContain('…');
  });

  it('leaves every ordinary wake BYTE-IDENTICAL — the owner path is opt-in via the marker', () => {
    const plain = work({ payload: { msg_id: 'm1' } });
    expect(wakeTurnText(plain)).toContain('[await-event]');
    // A malformed marker must fall through to the ordinary wrapper, never produce
    // an empty turn.
    expect(wakeTurnText(work({ payload: { ownerChatTurn: true } }))).toContain('[await-event]');
    expect(wakeTurnText(work({ payload: { ownerChatTurn: true, ownerChatText: '  ' } }))).toContain('[await-event]');
  });

  it('marks a timeout wake loudly', () => {
    const t = wakeTurnText(work({ payload: { timeout: true } }));
    expect(t).toContain('TIMEOUT');
    expect(t).toContain('not observed by your deadline');
    expect(t).toContain('may have fired since');
    expect(t).toContain('events:status');
    expect(t).toContain('event_inspection.waiters');
    expect(t).toContain('state "registered"');
    expect(t).toContain('active_awaits only for generic or await_id status reads');
    expect(t).not.toContain('awaited source did NOT complete');
    // EI-20489286325396940: name the authoritative column so the reader never has
    // to open events:status to learn WHY the wake fired.
    expect(t).toContain('fired_reason: timeout');
  });

  /**
   * EI-20489286325396940 — a timed-out await must never render as its source
   * COMPLETING. Verified live 2026-08-15: `work-item:done:WI-39195 fired` was
   * injected while WI-39195 stayed open and blocked; the authoritative row was
   * `fired_reason='timeout'` at `expires_ts` and no completion was ever emitted.
   * The wake BODY already carried `[TIMEOUT …]`; the coord-message SUMMARY — which
   * is what the injected `[coord+N]` block actually renders — did not.
   */
  describe('wakeSummaryHeadline (EI-20489286325396940)', () => {
    const DONE_KEY = 'work-item:done:WI-39195';

    it('renders a timeout as TIMED OUT with fired_reason — never as "fired"', () => {
      const s = wakeSummaryHeadline(DONE_KEY, { timeout: true });
      expect(s).toContain('TIMED OUT');
      expect(s).toContain('fired_reason: timeout');
      // The whole defect: the completion inference. `<key> fired` must not appear.
      expect(s).not.toContain(`${DONE_KEY} fired`);
      expect(s).toContain('not observed by its deadline');
      expect(s).toContain('may have fired since');
      expect(s).toContain('events:status');
      expect(s).not.toContain('did NOT complete');
    });

    it('leaves a genuine event fire byte-identical', () => {
      expect(wakeSummaryHeadline(DONE_KEY, { workItemId: 'WI-39195' })).toBe(`[await-event] ${DONE_KEY} fired`);
      expect(wakeSummaryHeadline(DONE_KEY, null)).toBe(`[await-event] ${DONE_KEY} fired`);
    });

    // A coalesced wake replaces the headline payload with {coalesced,…}, hiding the
    // raw `timeout` flag behind `latest`/`events` — the marker must survive both.
    it('sees through a coalesced payload', () => {
      expect(wakeSummaryHeadline(DONE_KEY, { coalesced: true, latest: { payload: { timeout: true } } })).toContain(
        'TIMED OUT',
      );
      expect(wakeSummaryHeadline(DONE_KEY, { coalesced: true, events: [{ payload: { timeout: true } }] })).toContain(
        'TIMED OUT',
      );
    });

    it('degradeToInboxOrDrop sends a timeout summary that cannot read as completion', async () => {
      const sent: { summary?: string; body?: string }[] = [];
      const send = (async (_identity: unknown, opts: { summary?: string; body?: string }) => {
        sent.push(opts);
        return {} as never;
      }) as unknown as Parameters<typeof degradeToInboxOrDrop>[2];

      const outcome = await degradeToInboxOrDrop(
        work({ eventKey: DONE_KEY, payload: { timeout: true }, summary: null }),
        'no live pty',
        send,
      );

      expect(outcome).toEqual({ kind: 'delivered', channel: 'inbox' });
      expect(sent).toHaveLength(1);
      expect(sent[0].summary).toContain('TIMED OUT');
      expect(sent[0].summary).toContain('fired_reason: timeout');
      expect(sent[0].summary).not.toContain(`${DONE_KEY} fired`);
      // The delivery-mechanism reason is still carried alongside it.
      expect(sent[0].summary).toContain('no live pty');
    });

    it('degradeToInboxOrDrop still says "fired" for a real event', async () => {
      const sent: { summary?: string }[] = [];
      const send = (async (_identity: unknown, opts: { summary?: string }) => {
        sent.push(opts);
        return {} as never;
      }) as unknown as Parameters<typeof degradeToInboxOrDrop>[2];

      await degradeToInboxOrDrop(work({ eventKey: DONE_KEY, payload: null }), 'no live pty', send);
      expect(sent[0].summary).toBe(`[await-event] ${DONE_KEY} fired — delivered to your coord inbox (no live pty)`);
    });

    it('uses one stable message id when the same delivery retries its inbox fallback', async () => {
      const sent: { msgId?: string; summary?: string }[] = [];
      const send = (async (_identity: unknown, opts: { msgId?: string; summary?: string }) => {
        sent.push(opts);
        return {} as never;
      }) as unknown as Parameters<typeof degradeToInboxOrDrop>[2];
      const delivery = work({ id: 764769, eventKey: 'work-item:claimable', payload: null });

      await degradeToInboxOrDrop(delivery, 'first attempt', send);
      await degradeToInboxOrDrop(delivery, 'retry after outcome-unknown append', send);

      expect(sent).toHaveLength(2);
      expect(sent[0].msgId).toBe('event-wake-inbox-764769');
      expect(sent[1].msgId).toBe(sent[0].msgId);
    });

    it('does not report a loop fire as delivered when only an inbox notice was written', async () => {
      const sent: { summary?: string; body?: string }[] = [];
      const send = (async (_identity: unknown, opts: { summary?: string; body?: string }) => {
        sent.push(opts);
        return {} as never;
      }) as unknown as Parameters<typeof degradeToInboxOrDrop>[2];

      const outcome = await degradeToInboxOrDrop(
        work({
          eventKey: 'coord:inbox-wake:su-loop',
          source: 'loop:rt-loop',
          payload: { carry: 'warm', wakeCount: 6, harness: 'papercusp', routineId: 'rt-loop' },
        }),
        'no live pty',
        send,
      );

      expect(outcome).toMatchObject({
        kind: 'drop',
        reason: expect.stringContaining('loop turn delivery cannot fall back to inbox'),
      });
      expect(sent).toHaveLength(0);
    });

    it('allows a mixed wake to use inbox after its stale loop component is stripped', async () => {
      const sent: { summary?: string; body?: string }[] = [];
      const send = (async (_identity: unknown, opts: { summary?: string; body?: string }) => {
        sent.push(opts);
        return {} as never;
      }) as unknown as Parameters<typeof degradeToInboxOrDrop>[2];

      const outcome = await degradeToInboxOrDrop(
        work({
          eventKey: DONE_KEY,
          payload: {
            coalesced: true,
            events: [{ event: DONE_KEY, payload: { msg_id: 'm-1' } }],
            latest: { event: DONE_KEY, payload: { msg_id: 'm-1' } },
          },
        }),
        'stale loop component stripped',
        send,
      );

      expect(outcome).toEqual({ kind: 'delivered', channel: 'inbox' });
      expect(sent).toHaveLength(1);
    });

    it('labels a positive lock grant as a snapshot when it is deferred to the inbox', async () => {
      const sent: { summary?: string; body?: string }[] = [];
      const send = (async (_identity: unknown, opts: { summary?: string; body?: string }) => {
        sent.push(opts);
        return {} as never;
      }) as unknown as Parameters<typeof degradeToInboxOrDrop>[2];
      const original = 'file lock GRANTED — you now hold src/example.ts';

      await degradeToInboxOrDrop(
        work({
          eventKey: 'lock:grant:ticket-1',
          payload: { granted: true, lock_id: 'lock-1', ticket_id: 'ticket-1' },
          summary: original,
        }),
        'no live pty',
        send,
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].body).toContain('INBOX SNAPSHOT');
      expect(sent[0].body).toContain('Re-check current ownership with locks:queue before acting');
      expect(sent[0].body).toContain('Original grant notification (snapshot only)');
      expect(sent[0].body!.indexOf('INBOX SNAPSHOT')).toBeLessThan(sent[0].body!.indexOf(original));
    });
  });

  // ambient-semantic-push P-003 seam: a prepared ambient push block rides the wake
  // injection when present (appended after the base line-collapse, keeping its own
  // formatting), and the default path is byte-identical.
  it('appends the ambient push block when present, on its own lines', () => {
    const block = '⟦ambient⟧\n‼ peer converging — pull: session:su-x [foo, bar]';
    const t = wakeTurnText(work({ ambientPushBlock: block }));
    expect(t).toContain('lock:grant:t-1'); // base wake still present
    expect(t).toContain('⟦ambient⟧');
    expect(t).toContain('pull: session:su-x');
    expect(t.endsWith(block)).toBe(true); // block is the tail, un-collapsed
  });

  it('is byte-identical to the base wake when no ambient block is set (DEFAULT-OFF)', () => {
    const base = wakeTurnText(work());
    const withUndef = wakeTurnText(work({ ambientPushBlock: undefined }));
    expect(withUndef).toBe(base);
    expect(base).not.toContain('⟦ambient⟧');
  });

  // EI-16648: an always-armed inbox-wake (`coord:inbox-wake:<owner>`) can be
  // CONSUMED late — a continuously-busy recipient's OWN periodic coord:inbox
  // polling may already have surfaced + handled the quoted message before the
  // injected wake turn is drained. So an inbox-wake key gets a self-identifying
  // reconciliation NOTE telling the woken agent to reconcile against the
  // cursor-free coord:inbox VIEW before re-doing possibly-already-handled mail;
  // every OTHER key is untouched. D-013 keeps the agent-facing cursor out of
  // coord:inbox, so this note must never reintroduce a since_ts call shape.
  // WI-6554700010018536: the held-work reminder follows the reconcile NOTE on an
  // inbox-wake key, stays on the one collapsed line, and is ignored on any other key.
  it('WI-6554700010018536: an inbox-wake key appends the held-work reminder after the NOTE', () => {
    const reminder = 'REMINDER (held work): you still hold 1 unfinished work-item(s) [WI-7].';
    const t = wakeTurnText(work({ eventKey: 'coord:inbox-wake:su-abc', inboxWakeHeldWorkReminder: reminder }));
    expect(t.indexOf('NOTE (inbox-wake)')).toBeGreaterThan(-1);
    expect(t.indexOf(reminder)).toBeGreaterThan(t.indexOf('NOTE (inbox-wake)'));
    expect(t).not.toContain('\n');
  });

  it('WI-6554700010018536: the reminder is ignored on a non-inbox-wake key and absent ⇒ byte-identical', () => {
    const reminder = 'REMINDER (held work): you still hold 1 unfinished work-item(s) [WI-7].';
    const other = wakeTurnText(work({ eventKey: 'work-item:done:WI-9', inboxWakeHeldWorkReminder: reminder }));
    expect(other).not.toContain('REMINDER (held work)');
    expect(other).toBe(wakeTurnText(work({ eventKey: 'work-item:done:WI-9' })));
    const inboxBase = wakeTurnText(work({ eventKey: 'coord:inbox-wake:su-abc' }));
    expect(wakeTurnText(work({ eventKey: 'coord:inbox-wake:su-abc', inboxWakeHeldWorkReminder: undefined }))).toBe(
      inboxBase,
    );
  });

  it('EI-16648/D-013: an inbox-wake key stamps the cursor-free coord:inbox note', () => {
    const t = wakeTurnText(work({ eventKey: 'coord:inbox-wake:su-abc' }));
    expect(t).toContain('coord:inbox-wake:su-abc'); // base wake still present
    expect(t).toContain('NOTE (inbox-wake)');
    expect(t).toContain('reconcile against coord:inbox');
    expect(t).toContain("coord:inbox's cursor-free VIEW");
    expect(t).not.toContain('since_ts');
    expect(t).toContain('do NOT re-do handled mail');
    expect(t).not.toContain('\n'); // still a single collapsed line
  });

  it('EI-16648: a non-inbox-wake key is byte-identical — NO reconcile note', () => {
    const t = wakeTurnText(work()); // default eventKey 'lock:grant:t-1'
    expect(t).not.toContain('NOTE (inbox-wake)');
    expect(t).not.toContain('reconcile against coord:inbox');
  });

  // GAP 1 (likely bug): a timeout-fire payload `{timeout:true}` coalesced with a
  // sibling has its headline payload replaced by `{coalesced,count,events,latest}`
  // (coalesceDeliveries) — the top-level `timeout` marker is GONE. wakeTurnText
  // must still surface [TIMEOUT] by looking inside the union, or the woken agent is
  // told the event FIRED when it actually TIMED OUT.
  it('coalesced timeout wake STILL emits [TIMEOUT] (GAP 1: the marker survives coalescing)', async () => {
    const { coalesceDeliveries } = await import('./engine');
    // The newest (headline) delivery is the timeout fire; an earlier sibling is a
    // normal event fire — exactly the engine.ts sweeper + pump interleaving.
    const sibling = work({
      id: 30,
      eventKey: 'lock:grant:t-1',
      payload: null,
      createdAt: new Date(1000).toISOString(),
    });
    const timeoutHeadline = work({
      id: 31,
      eventKey: 'plan-run:finished:9',
      payload: { timeout: true },
      summary: 'await deadline passed without the event firing',
      createdAt: new Date(2000).toISOString(),
    });
    const coalesced = coalesceDeliveries([sibling, timeoutHeadline]);
    // The headline payload IS the union now — proves the raw `.timeout` is buried.
    expect((coalesced.payload as { coalesced?: boolean }).coalesced).toBe(true);
    expect((coalesced.payload as { timeout?: boolean }).timeout).toBeUndefined();
    // ...yet the wake turn still warns the agent the event TIMED OUT.
    const t = wakeTurnText(coalesced);
    expect(t).toMatch(/TIMEOUT/);
    expect(t).toContain('not observed by your deadline');
    expect(t).toContain('may have fired since');
  });

  it('coalesced timeout in a FOLDED sibling (not the headline) also surfaces [TIMEOUT]', async () => {
    const { coalesceDeliveries } = await import('./engine');
    // The timeout is the OLDER fire; the newest is a normal event → the marker
    // lives only in `events[]`, not in `latest`. Still must surface.
    const timeoutSibling = work({ id: 40, payload: { timeout: true }, createdAt: new Date(1000).toISOString() });
    const eventHeadline = work({ id: 41, payload: { ok: true }, createdAt: new Date(2000).toISOString() });
    const t = wakeTurnText(coalesceDeliveries([timeoutSibling, eventHeadline]));
    expect(t).toMatch(/TIMEOUT/);
  });

  it('a coalesced group with NO timeout does not emit a spurious [TIMEOUT]', async () => {
    const { coalesceDeliveries } = await import('./engine');
    const a = work({ id: 50, payload: { ok: true }, createdAt: new Date(1000).toISOString() });
    const b = work({ id: 51, payload: { ok: true }, createdAt: new Date(2000).toISOString() });
    const t = wakeTurnText(coalesceDeliveries([a, b]));
    expect(t).not.toContain('TIMEOUT');
  });

  it('single-delivery timeout path still works (no coalescing)', async () => {
    const { coalesceDeliveries } = await import('./engine');
    // group.length === 1 → coalesceDeliveries returns the headline unchanged, so
    // the plain `{timeout:true}` path is untouched by the GAP 1 fix.
    const single = coalesceDeliveries([work({ id: 60, payload: { timeout: true } })]);
    expect((single.payload as { timeout?: boolean }).timeout).toBe(true);
    expect(wakeTurnText(single)).toMatch(/TIMEOUT/);
  });
});

describe('executeWake — queued loop-fire lifecycle gate (EI-21157954408185498)', () => {
  const loopPayload = {
    harness: 'papercusp',
    wakeCount: 7,
    routineId: 'rt_papercusp_loop_su_abc',
  };

  it('drops an ended loop delivery before any injection, plan resume, or process resume side effect', async () => {
    const cases = [
      work({ payload: loopPayload, wakeHandle: null }),
      work({ payload: loopPayload, wakeHandle: { kind: 'plan-run', runId: 12 } }),
      work({ payload: loopPayload, wakeHandle: advHandle() }),
    ];

    for (const delivery of cases) {
      const d = deps({ getLoopStatusFn: vi.fn(async () => null) as never });
      const out = await executeWake(delivery, d);
      expect(out).toMatchObject({ kind: 'drop' });
      expect((out as { reason: string }).reason).toContain('queued loop delivery');
      expect((out as { reason: string }).reason).toContain('no current active row');
      expect(d.findPsuHost).not.toHaveBeenCalled();
      expect(d.injectPsuHost).not.toHaveBeenCalled();
      expect(d.resumePlanRun).not.toHaveBeenCalled();
      expect(d.getSession).not.toHaveBeenCalled();
      expect(d.spawnDetached).not.toHaveBeenCalled();
      expect(d.write).not.toHaveBeenCalled();
    }
  });

  // EI-21393930883750326: the drop verdict is composition-aware. An ended loop
  // fire folded beside a NON-loop sibling (the await → loop:end parking
  // incident: await 93491's work-item:claimable fire rode in delivery #166616
  // with a stale loop fire and the whole attempt was dropped, silently
  // stranding the parked member) must be DELIVERED, not suppressed — the stale
  // loop imperative is neutralized by the rehydration banner instead.
  it('delivers a coalesced wake whose ended loop fire rides beside a non-loop await-event sibling (EI-21393930883750326)', async () => {
    const { coalesceDeliveries } = await import('./engine');
    const oldLoop = work({
      id: 20,
      payload: loopPayload,
      summary: 'STALE LOOP CHECKPOINT: release candidate 08:47 must be retried',
      note: 'STALE LOOP NOTE: resume the ended loop mission',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const awaitFire = work({
      id: 21,
      eventKey: 'work-item:claimable',
      summary: 'WI-41477 is claimable; run scheduler:get_next',
      // A real await-event payload: `harness` alone is event metadata, NOT a
      // loop marker (readColdLoopMarker's pairing rule).
      payload: { id: 'WI-41477', kind: 'bug', state: 'open', harness: 'papercusp' },
      createdAt: new Date().toISOString(),
    });
    const coalesced = coalesceDeliveries([oldLoop, awaitFire]);
    const findPty = vi.fn(() => ({ id: 'pty-loop' }));
    const write = vi.fn((..._args: unknown[]) => true);
    const d = deps({
      findPty: findPty as never,
      write: write as never,
      // The loop is ended (loop:end won the race) — exactly the incident state.
      getLoopStatusFn: vi.fn(async () => null) as never,
      // Hermetic: the rehydration banner path reads the carry-note store.
      getLoopCarryNoteWithMetaFn: vi.fn(async () => ({ note: null, updatedAtMs: null })) as never,
    });

    const out = await executeWake({ ...coalesced, wakeHandle: advHandle() }, d);

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(d.getLoopStatusFn).toHaveBeenCalledWith('su-abc');
    expect(write).toHaveBeenCalled();
    const injected = String((write.mock.calls[0]?.[1] as Buffer | undefined)?.toString('utf8') ?? '');
    expect(injected).toContain('WI-41477 is claimable');
    expect(injected).toContain('1 superseded loop component was removed at delivery');
    expect(injected).not.toContain('STALE LOOP CHECKPOINT');
    expect(injected).not.toContain('STALE LOOP NOTE');
    expect(injected).not.toContain('wakeCount');
    expect(d.getLoopCarryNoteWithMetaFn).not.toHaveBeenCalled();
  });

  it('rebuilds the event wake when the superseded loop fire was the coalesced headline', async () => {
    const { coalesceDeliveries } = await import('./engine');
    const awaitFire = work({
      id: 40,
      eventKey: 'candidate:ready',
      summary: 'candidate 74027d is ready for the parked waiter',
      payload: { candidate: '74027d', state: 'ready' },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const endedLoopHeadline = work({
      id: 41,
      eventKey: 'coord:inbox-wake:su-abc',
      payload: loopPayload,
      summary: 'STALE HEADLINE CHECKPOINT: retry candidate 08:47',
      note: 'STALE HEADLINE NOTE: continue the ended loop',
      createdAt: new Date().toISOString(),
    });
    const coalesced = coalesceDeliveries([awaitFire, endedLoopHeadline]);
    const write = vi.fn((..._args: unknown[]) => true);
    const tagTurn = vi.fn((args: { text: string; origin: string }) => ({
      taggedText: `ORIGIN:${args.origin}\n${args.text}`,
      envelope: '',
      nonce: 'mixed-headline',
      origin: args.origin,
      ledgerWritten: true,
    }));
    const d = deps({
      findPty: vi.fn(() => ({ id: 'pty-loop-headline' })) as never,
      write: write as never,
      tagTurn: tagTurn as never,
      getLoopStatusFn: vi.fn(async () => null) as never,
      getLoopCarryNoteWithMetaFn: vi.fn(async () => ({ note: null, updatedAtMs: null })) as never,
    });

    const out = await executeWake({ ...coalesced, wakeHandle: advHandle() }, d);

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    const injected = String((write.mock.calls[0]?.[1] as Buffer | undefined)?.toString('utf8') ?? '');
    expect(injected).toContain('candidate:ready');
    expect(injected).toContain('candidate 74027d is ready');
    expect(injected).toContain('ORIGIN:wake-pump');
    expect(injected).not.toContain('STALE HEADLINE CHECKPOINT');
    expect(injected).not.toContain('STALE HEADLINE NOTE');
    expect(injected).not.toContain('ORIGIN:loop-fire');
    expect(d.getLoopCarryNoteWithMetaFn).not.toHaveBeenCalled();
  });

  it('uses the surviving event and await IDs for inbox replay after removing a stale loop headline', async () => {
    const { coalesceDeliveries } = await import('./engine');
    const awaitFire = work({
      id: 40,
      awaitId: 901,
      eventKey: 'work-item:done:WI-10006055',
      summary: 'the work item has not completed',
      payload: { timeout: true },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const endedLoopHeadline = work({
      id: 41,
      awaitId: 373602,
      eventKey: 'coord:inbox-wake:su-abc',
      source: 'loop:rt-loop',
      payload: loopPayload,
      summary: 'STALE LOOP CHECKPOINT: continue the ended loop',
      createdAt: new Date().toISOString(),
    });
    const coalesced = coalesceDeliveries([awaitFire, endedLoopHeadline]);
    const sent: Array<{ msgId?: string; body?: string; extra?: Record<string, unknown> }> = [];
    const sendCoordMessage = vi.fn(async (
      _identity: unknown,
      message: { msgId?: string; body?: string; extra?: Record<string, unknown> },
    ) => {
      sent.push(message);
      return {} as never;
    });
    const d = deps({
      getLoopStatusFn: vi.fn(async () => null) as never,
      presence: vi.fn(async () => stalePresence) as never,
      sendCoordMessage: sendCoordMessage as never,
    });

    const out = await executeWake(coalesced, d);

    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      msgId: 'event-wake-inbox-40',
      extra: { event_key: 'work-item:done:WI-10006055', wake_delivery_id: 40 },
    });
    expect(sent[0]?.body).toContain('event-wake delivery #40');
    expect(sent[0]?.body).toContain('work-item:done:WI-10006055');
    expect(sent[0]?.body).toContain('await_id: 901');
    expect(sent[0]?.body).not.toContain('await_id: 373602');
    expect(sent[0]?.body).not.toContain('STALE LOOP CHECKPOINT');
  });

  it('still drops a coalesced attempt whose every folded component is a loop fire', async () => {
    const { coalesceDeliveries } = await import('./engine');
    const olderLoop = work({
      id: 30,
      payload: loopPayload,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const newerLoop = work({
      id: 31,
      payload: { ...loopPayload, wakeCount: 8 },
      createdAt: new Date().toISOString(),
    });
    const coalesced = coalesceDeliveries([olderLoop, newerLoop]);
    const d = deps({ getLoopStatusFn: vi.fn(async () => null) as never });

    const out = await executeWake({ ...coalesced, wakeHandle: advHandle() }, d);

    expect(out).toMatchObject({ kind: 'drop' });
    expect((out as { reason: string }).reason).toContain('queued loop delivery');
    expect((out as { reason: string }).reason).toContain('no current active row');
    expect(d.getLoopStatusFn).toHaveBeenCalledWith('su-abc');
    expect(d.findPsuHost).not.toHaveBeenCalled();
    expect(d.injectPsuHost).not.toHaveBeenCalled();
    expect(d.resumePlanRun).not.toHaveBeenCalled();
    expect(d.spawnDetached).not.toHaveBeenCalled();
  });

  it('drops a delivery from the prior arm when the current loop was re-armed after it was queued', async () => {
    const d = deps({
      getLoopStatusFn: vi.fn(async () => ({
        active: true,
        armedAt: new Date(Date.now() - 5_000).toISOString(),
      })) as never,
      alive: vi.fn(() => false),
    });
    const out = await executeWake(
      work({
        payload: loopPayload,
        wakeHandle: advHandle(),
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      d,
    );

    expect(out).toMatchObject({ kind: 'drop' });
    expect((out as { reason: string }).reason).toContain('re-armed after this delivery was created');
    expect(d.findPsuHost).not.toHaveBeenCalled();
    expect(d.spawnDetached).not.toHaveBeenCalled();
  });

  it('drops a lineage-mismatched loop wake instead of marking an inbox notice as its turn', async () => {
    const d = deps({
      getLoopStatusFn: vi.fn(async () => ({
        active: true,
        harnessSlug: 'current-loop-harness',
        armedAt: '1970-01-01T00:00:00.000Z',
      })) as never,
    });
    const out = await executeWake(
      work({
        payload: { harness: 'stale-loop-harness', wakeCount: 4 },
        wakeHandle: advHandle(),
      }),
      d,
    );

    expect(out).toMatchObject({ kind: 'drop', reason: expect.stringContaining('queued loop delivery') });
    expect((out as { reason: string }).reason).toContain('stale-loop-harness');
    expect((out as { reason: string }).reason).toContain('current-loop-harness');
    expect(d.sendCoordMessage).not.toHaveBeenCalled();
    expect(d.findPsuHost).not.toHaveBeenCalled();
    expect(d.injectPsuHost).not.toHaveBeenCalled();
    expect(d.resumePlanRun).not.toHaveBeenCalled();
    expect(d.spawnDetached).not.toHaveBeenCalled();
  });

  it('fails open when the lifecycle read errors, preserving a valid loop delivery', async () => {
    const findPty = vi.fn(() => ({ id: 'pty-loop' }));
    const write = vi.fn(() => true);
    const getLoopStatusFn = vi.fn(async () => {
      throw new Error('pg unavailable');
    });
    const out = await executeWake(
      work({ payload: loopPayload, wakeHandle: advHandle() }),
      deps({ findPty: findPty as never, write: write as never, getLoopStatusFn: getLoopStatusFn as never }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(getLoopStatusFn).toHaveBeenCalledWith('su-abc');
    expect(write).toHaveBeenCalled();
  });
});

describe('rehydrateLoopWakeText (EI-10935: delivery-time carry-note re-check)', () => {
  const STALE_TEXT =
    'Loop fired.\n\n⛔ OPEN WALLS — owner-gated / pending decisions:\n  • LIVE entity re-link backfill — irreversible, awaiting go/no-go';

  it('a NON-loop wake (no marker on payload) is byte-identical — no carry-note read at all', async () => {
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({ note: null, updatedAtMs: null }));
    const d = work({ payload: null });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, { getLoopCarryNoteWithMetaFn });
    expect(out).toBe(STALE_TEXT);
    expect(getLoopCarryNoteWithMetaFn).not.toHaveBeenCalled();
  });

  it('a LOOP wake whose FRESH carry-note now has NO open walls explicitly says so — supersedes a stale OPEN WALLS block above (the exact EI-10935 regression)', async () => {
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({
      note: '## Did\nCleared the wall after the owner go-ahead; candidate 29e97a6761 is current.\n\n## Left\nNothing.\n\n## Next action\nRe-check 29e97a6761.',
      updatedAtMs: Date.now() - 5_000,
    }));
    const d = work({ payload: { harness: 'papercusp', wakeCount: 5 }, subscriberId: 'su-loop-1' });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, { getLoopCarryNoteWithMetaFn });
    expect(getLoopCarryNoteWithMetaFn).toHaveBeenCalledWith({
      harness: 'papercusp',
      ownerId: 'su-loop-1',
      workspaceId: d.workspaceId,
    });
    // The stale text is still present (never mutated/removed)...
    expect(out).toContain(STALE_TEXT);
    // ...but a live re-check block is prepended, EXPLICITLY stating no walls are
    // open now — the delivery-time state leads the stale snapshot and cannot be
    // lost to the injection door's head-keep cap.
    expect(out).toMatch(/LIVE RE-CHECK/);
    expect(out).toContain('candidate 29e97a6761 is current');
    expect(out).toMatch(/none open — any wall shown OPEN above has been CLEARED since/);
    expect(out).toMatch(/TRUST THIS BLOCK/);
    // The delivery-time block leads the fire-time snapshot so the injection door's
    // head-keep behavior cannot spill the only state that was read at delivery.
    expect(out.indexOf('LIVE RE-CHECK')).toBeLessThan(out.indexOf(STALE_TEXT));
    expect(out).toMatch(/contentHash=[0-9a-f]{12}/);
    expect(out).toMatch(/writtenAt=\d{4}-\d{2}-\d{2}T/);
  });

  it('does not call a note current when its committed write timestamp is unavailable', async () => {
    const d = work({ payload: { harness: 'papercusp', wakeCount: 5 }, subscriberId: 'su-loop-unproven' });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, {
      getLoopCarryNoteWithMetaFn: vi.fn(async () => ({
        note: '## Next action\nDo not repeat the completed write.',
        updatedAtMs: null,
      })),
    });

    expect(out).toContain('UNPROVEN delivery-time loop:checkpoint');
    expect(out).toContain('latest committed checkpoint could not be established');
    expect(out).not.toContain('Current verified loop:checkpoint');
    expect(out).toContain('Do not repeat the completed write.');
  });

  it('a LOOP wake whose FRESH carry-note STILL has an open wall renders it in the re-check block', async () => {
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({
      note: '## Did\nStill mid-way.\n\n## Walls\n- a genuinely still-open irreversible action',
      updatedAtMs: Date.now() - 1_000,
    }));
    const d = work({ payload: { harness: 'papercusp', wakeCount: 2 }, subscriberId: 'su-loop-2' });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, { getLoopCarryNoteWithMetaFn });
    expect(out).toMatch(/LIVE RE-CHECK/);
    expect(out).toContain('a genuinely still-open irreversible action');
  });

  it('fails soft to the original text when the fresh carry-note read throws', async () => {
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => {
      throw new Error('pg unreachable');
    });
    const d = work({ payload: { harness: 'papercusp', wakeCount: 1 } });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, { getLoopCarryNoteWithMetaFn });
    expect(out).toContain(STALE_TEXT);
    expect(out).toMatch(/LOOP CHECKPOINT RE-CHECK FAILED/);
  });

  it('surfaces a resolved read-failure sentinel instead of claiming no checkpoint exists', async () => {
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({
      note: null,
      updatedAtMs: null,
      readFailed: true,
    }));
    const d = work({ payload: { harness: 'papercusp', wakeCount: 1 }, subscriberId: 'su-loop-read-failed' });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, { getLoopCarryNoteWithMetaFn });

    expect(out).toContain('LOOP CHECKPOINT RE-CHECK FAILED');
    expect(out).toContain('carry-note store read failed');
    expect(out).not.toContain('NO delivery-time loop:checkpoint was found');
    expect(out).toContain(STALE_TEXT);
  });

  // EI-21969383091076581: the absence banner was filed as a false negative because it
  // stated no read time. Measured, both reads were correct and 56s apart — the delivery
  // read found nothing, the banner told the agent to write the first checkpoint, the agent
  // did, and the later loop:status returned the note the banner had just caused to exist.
  // Without a readAt there is no way to ORDER the two observations, so a correct banner and
  // a correct status read look like a contradiction.
  it('stamps the absence banner with the delivery READ time so a later loop:status cannot read as a contradiction', async () => {
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({ note: null, updatedAtMs: null }));
    const before = Date.now();
    const d = work({ payload: { harness: 'papercusp', wakeCount: 3 }, subscriberId: 'su-loop-absent-readat' });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, { getLoopCarryNoteWithMetaFn });

    expect(out).toContain('NO delivery-time loop:checkpoint was found');

    // The timestamp must be real and current, not a placeholder.
    const stamped = out.match(/as of readAt=(\S+?)\s/)?.[1];
    expect(stamped).toBeTruthy();
    const stampedMs = Date.parse(stamped!);
    expect(Number.isFinite(stampedMs)).toBe(true);
    expect(stampedMs).toBeGreaterThanOrEqual(before - 1_000);
    expect(stampedMs).toBeLessThanOrEqual(Date.now() + 1_000);

    // And it must scope the claim to that instant rather than to the whole turn — the
    // sentence that stops the next agent re-filing this.
    expect(out).toContain('NOT about the whole turn');
  });

  it('stamps a PROVEN checkpoint with both writtenAt and readAt, so the two are orderable', async () => {
    const writtenAtMs = Date.now() - 5_000;
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({
      note: '## Did\nA real note.\n\n## Next action\nCarry on.',
      updatedAtMs: writtenAtMs,
    }));
    const d = work({ payload: { harness: 'papercusp', wakeCount: 4 }, subscriberId: 'su-loop-proven-readat' });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, { getLoopCarryNoteWithMetaFn });

    expect(out).toContain('Current verified loop:checkpoint');
    expect(out).toContain(`writtenAt=${new Date(writtenAtMs).toISOString()}`);
    expect(out).toMatch(/readAt=\S+/);
  });

  it('EI-21988107654213811: scopes the trust directive to readAt so a newer checkpoint requires re-reading', async () => {
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({
      note: '## Did\nThe delivery snapshot is valid for its read instant.\n\n## Next action\nReconcile before acting.',
      updatedAtMs: Date.now() - 5_000,
    }));
    const getLoopStatusFn = vi.fn(async () => ({ active: true, harnessSlug: 'papercusp' })) as never;
    const d = work({ payload: { harness: 'papercusp', wakeCount: 5 }, subscriberId: 'su-loop-read-boundary' });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, {
      getLoopCarryNoteWithMetaFn,
      getLoopStatusFn,
    });

    expect(out).toMatch(/TRUST THIS BLOCK AS OF readAt=\S+/);
    expect(out).toContain('it is NOT a promise that the carry-note stayed unchanged afterward');
    expect(out).toContain(
      'If you write a checkpoint, receive a newer status, or otherwise observe progress after readAt, re-read loop:status / loop:checkpoint before acting',
    );
    expect(out).toContain('not listed in this snapshot');
  });

  it('keeps the delivery-time narrative checkpoint ahead of the injection-door spill (EI-20230529647745311)', async () => {
    const d = work({
      id: 990_002,
      subscriberId: 'su-loop-door-regression',
      payload: { harness: 'papercusp', wakeCount: 2 },
    });
    const current = await rehydrateLoopWakeText(
      d,
      `STALE-CANDIDATE-7e0e5011\n${'old fire-time snapshot '.repeat(2_000)}`,
      {
        getLoopCarryNoteWithMetaFn: vi.fn(async () => ({
          note: '## Did\nVerified candidate 29e97a6761 after loop:checkpoint write.\n\n## Next action\nWait for its verdict.',
          updatedAtMs: Date.now() - 1_000,
        })),
      },
    );
    const delivered = applyInjectionDoor(d, current);
    try {
      expect(delivered).toContain('candidate 29e97a6761');
      // The live re-check still leads. P-024 clause D: the oversized stale snapshot is
      // now left out WHOLE (absent, or only named in the footer after the re-check).
      const staleAt = delivered.indexOf('STALE-CANDIDATE-7e0e5011');
      expect(delivered.indexOf('LIVE RE-CHECK')).toBeGreaterThanOrEqual(0);
      expect(staleAt === -1 || staleAt > delivered.indexOf('LIVE RE-CHECK')).toBe(true);
      expect(delivered).not.toContain('old fire-time snapshot old fire-time snapshot');
      expect(delivered).toMatch(/injection-door: \d+ section\(s\) did not fit/);
      expect(delivered).not.toMatch(/was truncated/);
    } finally {
      const m = delivered.match(/in full at (\S+) \(see its section index\)/);
      if (m) rmSync(m[1], { force: true });
    }
  });

  // P-001 (carry-recheck-and-governed-memory-2026-10-14, R-1): the LIVE RE-CHECK block RUNS the
  // carried probes it prints, instead of only printing them.
  it('runs the delivery-time carried probes and places their result inside the live re-check block', async () => {
    const { renderCarryNote } = await import('../../carry-note');
    const probe = {
      kind: 'state-cell',
      cell: 'gate.greenCheckpoint.verdict',
      schemaRevision: 'rev-test',
      expect: { path: '$.value', op: 'eq', value: 'green' },
    } as const;
    const note = renderCarryNote({
      did: 'Shipped the fix.',
      checks: [
        { claim: 'gate is green', recheck: 'state:read gate', probe: probe as never },
        { claim: 'prose-only claim', recheck: 'look at it' },
      ],
    });
    const carriedProbeBlockFn = vi.fn(async (_input: unknown) => '🧪 CARRIED PROBES re-run at delivery — 0 hold · 1 changed · 0 could not run:\n  ✗ CHANGED — gate is green [loop check 1]: observed "red"');
    const d = work({ payload: { harness: 'papercusp', wakeCount: 3 }, subscriberId: 'su-probe', workspaceId: 'delivery-workspace' });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, {
      getLoopCarryNoteWithMetaFn: vi.fn(async () => ({ note, updatedAtMs: Date.now() - 1_000 })),
      carriedProbeBlockFn,
    });
    expect(carriedProbeBlockFn).toHaveBeenCalledTimes(1);
    const arg = carriedProbeBlockFn.mock.calls[0]![0] as { ownerId: string; harness: string; workspaceId: string; readAtIso: string; checks: Array<{ claim: string }> };
    expect(arg.ownerId).toBe('su-probe');
    expect(arg.harness).toBe('papercusp');
    expect(arg.workspaceId).toBe('delivery-workspace');
    expect(arg.readAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // every carried check reaches the runner; it skips the probe-less one itself
    expect(arg.checks.map((c) => c.claim)).toEqual(['gate is green', 'prose-only claim']);
    expect(out).toContain('✗ CHANGED — gate is green [loop check 1]: observed "red"');
    const block = out.slice(0, out.indexOf(STALE_TEXT));
    expect(block.indexOf('CARRIED PROBES')).toBeGreaterThan(block.indexOf('LIVE RE-CHECK'));
    expect(block.indexOf('CARRIED PROBES')).toBeLessThan(block.indexOf('TRUST THIS BLOCK'));
  });

  it.each([
    ['su-tenant-a', 'workspace-a'],
    ['su-tenant-b', 'workspace-b'],
  ])('resolves coordination-namespace checks and references in subscriber %s workspace', async (ownerId, workspaceId) => {
    const { renderCarryNote } = await import('../../carry-note');
    const note = renderCarryNote({
      did: 'Waiting on WI-1234.',
      checks: [{
        claim: 'control is green', recheck: 'read control',
        probe: { kind: 'state-cell', cell: 'control', schemaRevision: 'rev-test', expect: { path: '$.value', op: 'eq', value: 'green' } } as never,
      }],
    });
    const workspaceForCoordOwnerFn = vi.fn(async () => workspaceId);
    const carriedProbeBlockFn = vi.fn(async (input: { workspaceId: string }) =>
      input.workspaceId === workspaceId ? 'CHANGED — control is red' : 'COULD NOT RUN — harness_not_found',
    );
    const carryRefBlockFn = vi.fn(async (input: { workspaceId: string | null | undefined }) =>
      input.workspaceId === workspaceId ? 'CHANGED — WI-1234 is wip' : 'GONE — wrong namespace',
    );
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({ note, updatedAtMs: Date.now() }));
    const out = await rehydrateLoopWakeText(
      work({ subscriberId: ownerId, workspaceId: 'default', payload: { harness: 'papercusp', wakeCount: 3 } }),
      STALE_TEXT,
      { getLoopCarryNoteWithMetaFn, carriedProbeBlockFn, carryRefBlockFn, ...{ workspaceForCoordOwnerFn } },
    );
    expect(workspaceForCoordOwnerFn).toHaveBeenCalledWith(ownerId);
    expect(getLoopCarryNoteWithMetaFn).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'default' }));
    expect(carriedProbeBlockFn).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, ownerId }));
    expect(carryRefBlockFn).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, ownerId }));
    expect(out).toContain('CHANGED — control is red');
    expect(out).toContain('CHANGED — WI-1234 is wip');
    expect(out).not.toContain('harness_not_found');
    expect(out).not.toContain('GONE — wrong namespace');
  });

  it('reports unavailable subscriber scope without dispatching checks or references in the host namespace', async () => {
    const { renderCarryNote } = await import('../../carry-note');
    const note = renderCarryNote({
      did: 'Waiting on WI-1234.',
      checks: [{
        claim: 'control is green', recheck: 'read control',
        probe: { kind: 'state-cell', cell: 'control', schemaRevision: 'rev-test', expect: { path: '$.value', op: 'eq', value: 'green' } } as never,
      }],
    });
    const carriedProbeBlockFn = vi.fn(async () => 'control holds');
    const carryRefBlockFn = vi.fn(async () => null);
    const out = await rehydrateLoopWakeText(
      work({ workspaceId: 'default', payload: { harness: 'papercusp', wakeCount: 3 } }),
      STALE_TEXT,
      {
        getLoopCarryNoteWithMetaFn: vi.fn(async () => ({ note, updatedAtMs: Date.now() })),
        carriedProbeBlockFn, carryRefBlockFn,
        ...{ workspaceForCoordOwnerFn: vi.fn(async () => null) },
      },
    );
    expect(carriedProbeBlockFn).not.toHaveBeenCalled();
    expect(carryRefBlockFn).not.toHaveBeenCalled();
    expect(out).toContain('CARRIED PROBES — COULD NOT RUN');
    expect(out).toContain('CARRIED REFERENCES — COULD NOT RE-CHECK');
    expect(out).toContain('subscriber workspace');
    expect(out).toContain(STALE_TEXT);
  });

  // P-002 (carry-recheck-and-governed-memory-2026-10-14, R-2 / R-12 / R-21): the LIVE RE-CHECK block
  // carries the delivered note's moved references, and nothing when none moved.
  it('places the delivery-time carried-reference changes inside the live re-check block', async () => {
    const note = 'Did: shipped WI-1234 and decided plan-x#D-002.';
    const carryRefBlockFn = vi.fn(async (_input: unknown) =>
      '🔗 CARRIED REFERENCES re-checked at wake delivery — 1 reference has moved since the checkpoint was written:\n  ✗ GONE — work-item:WI-1234 [loop note]: stamped open@1',
    );
    const d = work({ payload: { harness: 'papercusp', wakeCount: 3 }, subscriberId: 'su-refs', workspaceId: 'ws-refs' });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, {
      getLoopCarryNoteWithMetaFn: vi.fn(async () => ({ note, updatedAtMs: Date.now() - 1_000 })),
      carryRefBlockFn,
    });
    expect(carryRefBlockFn).toHaveBeenCalledTimes(1);
    const arg = carryRefBlockFn.mock.calls[0]![0] as {
      ownerId: string;
      harness: string;
      workspaceId: string;
      deliveredNote: string;
      readAtIso: string;
    };
    expect(arg).toMatchObject({ ownerId: 'su-refs', harness: 'papercusp', workspaceId: 'ws-refs', deliveredNote: note });
    expect(arg.readAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const block = out.slice(0, out.indexOf(STALE_TEXT));
    expect(block).toContain('✗ GONE — work-item:WI-1234 [loop note]');
    expect(block.indexOf('CARRIED REFERENCES')).toBeGreaterThan(block.indexOf('LIVE RE-CHECK'));
    expect(block.indexOf('CARRIED REFERENCES')).toBeLessThan(block.indexOf('TRUST THIS BLOCK'));
  });

  it('prints no carried-reference line when nothing moved, and skips the re-check on a failed note read', async () => {
    const carryRefBlockFn = vi.fn(async () => null);
    const d = work({ payload: { harness: 'papercusp', wakeCount: 3 }, subscriberId: 'su-refs' });
    const unchanged = await rehydrateLoopWakeText(d, STALE_TEXT, {
      getLoopCarryNoteWithMetaFn: vi.fn(async () => ({ note: 'Did: WI-1234', updatedAtMs: Date.now() - 1_000 })),
      carryRefBlockFn,
    });
    expect(carryRefBlockFn).toHaveBeenCalledTimes(1);
    expect(unchanged).not.toContain('CARRIED REFERENCES');
    const failedRead = vi.fn(async () => 'SHOULD NOT APPEAR');
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, {
      getLoopCarryNoteWithMetaFn: vi.fn(async () => ({ note: 'Did: WI-1234', updatedAtMs: null, readFailed: true })),
      carryRefBlockFn: failedRead,
    });
    expect(failedRead).not.toHaveBeenCalled();
    expect(out).not.toContain('SHOULD NOT APPEAR');
  });

  it('keeps carried probe and reference deltas visible when a long checkpoint fills the injection door', async () => {
    const { renderCarryNote } = await import('../../carry-note');
    const note = renderCarryNote({
      did: 'Verified WI-1234. ' + 'Earlier verification detail. '.repeat(180),
      insight: 'Historical context. '.repeat(140),
      checks: [{ claim: 'status is green', recheck: 'read status', probe: {
        kind: 'state-cell', cell: 'gate.greenCheckpoint.verdict', schemaRevision: 'rev-test',
        expect: { path: '$.value', op: 'eq', value: 'green' },
      } as never }],
    });
    const probeDelta = '  ✗ CHANGED — status is green [loop #status]: observed "red"';
    const refDelta = '  ↻ CHANGED — work-item:WI-1234 [loop note]: open → done';
    const d = work({ payload: { harness: 'papercusp', wakeCount: 3 }, subscriberId: 'su-carry-budget' });
    const composed = await rehydrateLoopWakeText(d, STALE_TEXT.repeat(100), {
      getLoopCarryNoteWithMetaFn: async () => ({ note, updatedAtMs: Date.now() - 1_000 }),
      getLoopStatusFn: async () => null,
      carriedProbeBlockFn: async () => `🧪 CARRIED PROBES — 1 changed:\n${probeDelta}`,
      carryRefBlockFn: async () => `🔗 CARRIED REFERENCES — 1 changed:\n${refDelta}`,
    });
    const delivered = applyInjectionDoor(d, composed);
    try {
      expect(composed.indexOf(probeDelta)).toBeLessThan(composed.indexOf('Current verified loop:checkpoint'));
      expect(delivered).toContain(probeDelta);
      expect(delivered).toContain(refDelta);
      expect(delivered).toContain('[injection-door:');
    } finally {
      const spill = delivered.match(/in full at (\S+) \(see its section index\)/);
      if (spill) rmSync(spill[1], { force: true });
    }
  });

  it('does not run the probe runner when no carried check has a probe', async () => {
    const { renderCarryNote } = await import('../../carry-note');
    const note = renderCarryNote({ did: 'x', checks: [{ claim: 'prose-only claim', recheck: 'look' }] });
    const carriedProbeBlockFn = vi.fn(async () => 'SHOULD NOT APPEAR');
    const d = work({ payload: { harness: 'papercusp', wakeCount: 3 }, subscriberId: 'su-probe' });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, {
      getLoopCarryNoteWithMetaFn: vi.fn(async () => ({ note, updatedAtMs: Date.now() - 1_000 })),
      carriedProbeBlockFn,
    });
    expect(carriedProbeBlockFn).not.toHaveBeenCalled();
    expect(out).not.toContain('SHOULD NOT APPEAR');
    expect(out).not.toContain('CARRIED PROBES');
  });

  it('the default probe block renders nothing when there is nothing to run', async () => {
    const { defaultCarriedProbeBlock } = await import('./wake-executor');
    const out = await defaultCarriedProbeBlock({
      ownerId: 'su-probe',
      checks: [],
      harness: 'papercusp',
      workspaceId: 'ws',
      readAtIso: '2026-10-14T09:00:00.000Z',
    });
    // no checks → nothing to run → no block at all (never a false "all hold")
    expect(out).toBeNull();
  });
});

// EI-21971731335245747: the wake reader selects the carry-note by the wake MARKER's
// harness; loop:status selects it by the LIVE routine's install slug — and
// agent-tools/loop/status.ts asserts that slug is authoritative "just as it is for the
// cold wake reader", an agreement this reader does not honour. A PROVEN divergence is
// already caught as a lineage-mismatch, but only when the status read succeeded and
// named a harness. Otherwise the divergence degrades into a SILENT FALSE ABSENCE — and
// absence is the one answer that invites an overwrite, because the banner's own remedy
// is "write loop:checkpoint before ending this turn".
describe('rehydrateLoopWakeText — EI-21971731335245747 (an unverified reader scope never renders as a clean absence)', () => {
  const STALE = 'Loop wake. Fire-time snapshot.';
  const absentNote = () => vi.fn(async () => ({ note: null, updatedAtMs: null }));

  it('QUALIFIES the absence when the status read THREW — scope agreement was never established', async () => {
    const getLoopCarryNoteWithMetaFn = absentNote();
    const getLoopStatusFn = vi.fn<typeof getLoopStatus>(async () => {
      throw new Error('pg unavailable');
    });
    const d = work({ payload: { harness: 'marker-harness', wakeCount: 2 }, subscriberId: 'su-scope-throw' });

    const out = await rehydrateLoopWakeText(d, STALE, { getLoopCarryNoteWithMetaFn, getLoopStatusFn });

    expect(out).toContain('THE SCOPE OF THAT READ IS UNVERIFIED');
    expect(out).toContain('the live loop status could not be read at delivery time');
    expect(out).toContain('WRONG-SCOPE read');
    // The actual hazard: an unqualified absence reads as licence to overwrite the very
    // checkpoint the reader failed to see, under the other scope.
    expect(out).toContain('do NOT let it justify an overwrite');
    // And it must route the reader to the authority that CAN settle the scope.
    expect(out).toContain('call loop:status');
  });

  it('QUALIFIES the absence when the status read SUCCEEDED but named no harness to compare against', async () => {
    const getLoopCarryNoteWithMetaFn = absentNote();
    const getLoopStatusFn = vi.fn(async () => ({ active: true, harnessSlug: '   ' })) as never;
    const d = work({ payload: { harness: 'marker-harness', wakeCount: 3 }, subscriberId: 'su-scope-blank' });

    const out = await rehydrateLoopWakeText(d, STALE, { getLoopCarryNoteWithMetaFn, getLoopStatusFn });

    expect(out).toContain('THE SCOPE OF THAT READ IS UNVERIFIED');
    expect(out).toContain('the live loop status named no harness to compare against');
  });

  // CALIBRATION — without this the three assertions above would also pass if the banner
  // were unconditionally qualified, which would make every clean absence unreadable.
  it('leaves a CONFIRMED-scope absence exactly as it was — the qualification is conditional, not blanket', async () => {
    const getLoopCarryNoteWithMetaFn = absentNote();
    const getLoopStatusFn = vi.fn(async () => ({ active: true, harnessSlug: 'papercusp' })) as never;
    const d = work({ payload: { harness: 'papercusp', wakeCount: 4 }, subscriberId: 'su-scope-agreed' });

    const out = await rehydrateLoopWakeText(d, STALE, { getLoopCarryNoteWithMetaFn, getLoopStatusFn });

    expect(out).toContain('NO delivery-time loop:checkpoint was found');
    expect(out).not.toContain('THE SCOPE OF THAT READ IS UNVERIFIED');
    // The EI-21969383091076581 ordering guidance must survive on the clean branch.
    expect(out).toContain('NOT about the whole turn');
  });

  it('does NOT downgrade a PROVEN divergence — a readable status that disagrees still takes the louder lineage-mismatch branch', async () => {
    const getLoopCarryNoteWithMetaFn = absentNote();
    const getLoopStatusFn = vi.fn(async () => ({ active: true, harnessSlug: 'current-harness' })) as never;
    const d = work({ payload: { harness: 'stale-harness', wakeCount: 5 }, subscriberId: 'su-scope-proven' });

    const out = await rehydrateLoopWakeText(d, STALE, { getLoopCarryNoteWithMetaFn, getLoopStatusFn });

    expect(out).toContain('LOOP DELIVERY LINEAGE MISMATCH');
    expect(out).not.toContain('THE SCOPE OF THAT READ IS UNVERIFIED');
    // A proven mismatch must not read the marker-scoped row at all.
    expect(getLoopCarryNoteWithMetaFn).not.toHaveBeenCalled();
  });

  it('a FOUND note is unaffected by an unverified scope — the row existing is its own evidence', async () => {
    const writtenAtMs = Date.now() - 3_000;
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({
      note: '## Did\nReal work.\n\n## Next action\nCarry on.',
      updatedAtMs: writtenAtMs,
    }));
    const getLoopStatusFn = vi.fn<typeof getLoopStatus>(async () => {
      throw new Error('pg unavailable');
    });
    const d = work({ payload: { harness: 'marker-harness', wakeCount: 6 }, subscriberId: 'su-scope-found' });

    const out = await rehydrateLoopWakeText(d, STALE, { getLoopCarryNoteWithMetaFn, getLoopStatusFn });

    expect(out).toContain('Current verified loop:checkpoint');
    expect(out).not.toContain('THE SCOPE OF THAT READ IS UNVERIFIED');
  });
});

describe('rehydrateLoopWakeText — EI-18825117783927950 (loop:end / re-arm does not drain an already-queued fire)', () => {
  const FROZEN_TEXT =
    'Loop wake. Continue working plan foo. Current loop:checkpoint — this is the authority for what to do this wake.';
  const noWalls = async () => ({ note: null, updatedAtMs: Date.now() - 2_000 });

  function loopStatus(over: Partial<import('../../harness/routines/loop').LoopStatus> = {}) {
    return {
      name: 'loop_su-loop',
      ownerId: 'su-loop-1',
      harnessSlug: 'papercusp',
      active: true,
      intervalSec: 60,
      carry: 'warm' as const,
      continuation: 'settle' as const,
      mode: 'work' as const,
      monitor: null,
      monitorStanddown: null,
      standdown: null,
      goal: null,
      fireCount: 3,
      firesSinceArm: 3,
      expectedFiresSinceArm: null,
      effectiveIntervalSec: null,
      cadenceRatio: null,
      longestObservedGapSec: null,
      cadenceDrift: false,
      parked: false,
      parkedForSec: null,
      nextFireAt: null,
      lastFiredAt: null,
      armedAt: new Date(Date.now() - 100_000).toISOString(),
      costCapCents: null,
      maxFires: null,
      maxDurationSec: null,
      fireStarved: false,
      stalled: false,
      stalledSinceMs: null,
      lastDeliveryOutcome: null,
      consecutiveErrors: 0,
      lastWakeChannel: null,
      lastWakeStatus: null,
      lastWakeAt: null,
      lastWakeError: null,
      lastTurnAt: null,
      lastRealTurnAt: null,
      turnsStalled: false,
      lifecycleBackoff: null,
      ...over,
    };
  }

  it('a fire queued while active, delivered after loop:end (active:false), is banner-flagged as SUPERSEDED', async () => {
    const getLoopStatusFn = vi.fn<typeof getLoopStatus>(async (_ownerId) => loopStatus({ active: false }));
    const d = work({
      payload: { harness: 'papercusp', wakeCount: 12 },
      subscriberId: 'su-loop-1',
      createdAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const out = await rehydrateLoopWakeText(d, FROZEN_TEXT, {
      getLoopCarryNoteWithMetaFn: noWalls,
      getLoopStatusFn,
    });
    expect(getLoopStatusFn).toHaveBeenCalledWith('su-loop-1');
    // The frozen text is preserved, never mutated/removed...
    expect(out).toContain(FROZEN_TEXT);
    // ...but a loud, unmissable banner tells the receiving agent it is stale.
    expect(out).toMatch(/THIS LOOP WAS ENDED/);
    expect(out).toMatch(/NOT authoritative/);
    expect(out).toMatch(/do not resume, re-open, or re-do work/);
  });

  it('no loop routine row at all for this owner (status null) is ALSO treated as ended/superseded', async () => {
    const getLoopStatusFn = vi.fn<typeof getLoopStatus>(async (_ownerId) => null);
    const d = work({ payload: { harness: 'papercusp', wakeCount: 1 }, subscriberId: 'su-loop-1' });
    const out = await rehydrateLoopWakeText(d, FROZEN_TEXT, {
      getLoopCarryNoteWithMetaFn: noWalls,
      getLoopStatusFn,
    });
    expect(out).toMatch(/THIS LOOP WAS ENDED/);
  });

  it("a fire queued before a RE-ARM (armedAt newer than the delivery's createdAt) is banner-flagged as superseded, even though active is still true", async () => {
    const getLoopStatusFn = vi.fn<typeof getLoopStatus>(async (_ownerId) =>
      loopStatus({ active: true, armedAt: new Date(Date.now() - 5_000).toISOString() }),
    );
    const d = work({
      payload: { harness: 'papercusp', wakeCount: 4 },
      subscriberId: 'su-loop-1',
      createdAt: new Date(Date.now() - 600_000).toISOString(), // long before the re-arm above
    });
    const out = await rehydrateLoopWakeText(d, FROZEN_TEXT, {
      getLoopCarryNoteWithMetaFn: noWalls,
      getLoopStatusFn,
    });
    expect(out).toMatch(/THIS LOOP WAS RE-ARMED/);
    expect(out).toMatch(/PRIOR arm/);
  });

  it('does not read a marker-scoped carry note when the active loop has a different harness lineage', async () => {
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({
      note: '## Next action\nDo not use this stale prior-lineage candidate.',
      updatedAtMs: Date.now() - 1_000,
    }));
    const getLoopStatusFn = vi.fn<typeof getLoopStatus>(async (_ownerId) =>
      loopStatus({
        active: true,
        harnessSlug: 'current-loop-harness',
        armedAt: new Date(Date.now() - 600_000).toISOString(),
      }),
    );
    const out = await rehydrateLoopWakeText(
      work({
        payload: { harness: 'stale-loop-harness', wakeCount: 4 },
        subscriberId: 'su-loop-1',
      }),
      FROZEN_TEXT,
      { getLoopCarryNoteWithMetaFn, getLoopStatusFn },
    );

    expect(getLoopCarryNoteWithMetaFn).not.toHaveBeenCalled();
    expect(out).toContain('LOOP DELIVERY LINEAGE MISMATCH');
    expect(out).toContain('stale-loop-harness');
    expect(out).toContain('current-loop-harness');
    expect(out).not.toContain('Current verified loop:checkpoint');
    expect(out).toContain(FROZEN_TEXT);
  });

  it('a fire queued AFTER the current arm (the normal case) carries NO superseded banner', async () => {
    const armedAtMs = Date.now() - 600_000;
    const getLoopStatusFn = vi.fn<typeof getLoopStatus>(async (_ownerId) =>
      loopStatus({ active: true, armedAt: new Date(armedAtMs).toISOString() }),
    );
    const d = work({
      payload: { harness: 'papercusp', wakeCount: 4 },
      subscriberId: 'su-loop-1',
      createdAt: new Date(armedAtMs + 60_000).toISOString(), // created well after the arm
    });
    const out = await rehydrateLoopWakeText(d, FROZEN_TEXT, {
      getLoopCarryNoteWithMetaFn: noWalls,
      getLoopStatusFn,
    });
    expect(out).not.toMatch(/THIS LOOP WAS ENDED/);
    expect(out).not.toMatch(/THIS LOOP WAS RE-ARMED/);
  });

  it('fails soft — a getLoopStatusFn throw degrades only the superseded banner, never the walls/checks rehydration', async () => {
    const getLoopStatusFn = vi.fn<typeof getLoopStatus>(async (_ownerId) => {
      throw new Error('pg unreachable');
    });
    const d = work({ payload: { harness: 'papercusp', wakeCount: 1 }, subscriberId: 'su-loop-1' });
    const out = await rehydrateLoopWakeText(d, FROZEN_TEXT, {
      getLoopCarryNoteWithMetaFn: noWalls,
      getLoopStatusFn,
    });
    // Still gets the base EI-10935 live re-check block...
    expect(out).toMatch(/LIVE RE-CHECK/);
    // ...but no superseded banner (the status read failed, so it says nothing rather
    // than guessing).
    expect(out).not.toMatch(/THIS LOOP WAS ENDED/);
    expect(out).not.toMatch(/THIS LOOP WAS RE-ARMED/);
  });

  it('a NON-loop wake never calls getLoopStatusFn at all (no marker ⇒ early return, byte-identical)', async () => {
    const getLoopStatusFn = vi.fn<typeof getLoopStatus>(async (_ownerId) => loopStatus({ active: false }));
    const d = work({ payload: null });
    const out = await rehydrateLoopWakeText(d, FROZEN_TEXT, { getLoopStatusFn });
    expect(out).toBe(FROZEN_TEXT);
    expect(getLoopStatusFn).not.toHaveBeenCalled();
  });
});

/**
 * WI-41297 — the WIRING guard for WI-41266.
 *
 * WI-41266: wake-delivered turns egressed through the inference gateway (:8788)
 * regardless of the session's `--account=default` choice, because the wake path
 * re-armed every OTHER non-persisting flag (scheduler deny, subagent deny,
 * --mcp-config) but never the ACCOUNT ROUTE, and spawned with a raw
 * `{...process.env}` that inherited the operator's own gateway base URL.
 *
 * The fix's helpers (wakeAccountRouteFromArgv / sanitizeInheritedWakeEnv) are
 * thoroughly unit-tested in inference-gateway/spawn-env.test.ts. What was NOT
 * covered is that the wake path actually CALLS them — measured 2026-08-24, zero
 * assertions in this file touched the route, so each of the three wiring lines
 * could be deleted with all 167 tests still green and the bug class would return
 * silently. The helpers being correct is not the property we care about.
 *
 * These tests fail if that wiring is removed. Keep them behavioural (assert the
 * ROUTE reaches the child), never a grep for a symbol name.
 */
describe('wake account route reaches the resumed child (WI-41266 wiring)', () => {
  const DEFAULT_ARGV = ['psu', '--no-picker', '--agent=claude', '--account=default'];
  const AUTO_ARGV = ['psu', '--no-picker', '--agent=claude', '--account=auto'];

  it("a --account=default session's resume argv carries the highest-precedence --settings overlay", () => {
    const route = wakeAccountRouteFromArgv(DEFAULT_ARGV, 'su-default');
    expect(route).not.toBeNull();
    expect(route!.mode).toBe('default');

    const r = resumeCommandFor({ agent: 'claude', sessionId: 'sid-d', ompThreadId: null }, 'WAKE', route);
    expect(r).not.toBeNull();

    // `claude --resume` is a NEW CLI process and does not retain the original
    // launch flags, so the overlay must ride every wake. It outranks
    // project/user settings, which is what stops a stale apiKeyHelper or an
    // ambient gateway URL winning over the chosen system login.
    const settingsIdx = r!.args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThan(-1);
    const overlay = JSON.parse(r!.args[settingsIdx + 1]);
    // Default route = the machine's own login: every credential selector blanked.
    expect(overlay.env.ANTHROPIC_BASE_URL).toBe('');
    expect(overlay.env.ANTHROPIC_AUTH_TOKEN).toBe('');
    expect(overlay.apiKeyHelper).toBe('');
    // Global options must precede the positional prompt.
    expect(settingsIdx).toBeLessThan(r!.args.length - 1);
    expect(r!.args[r!.args.length - 1]).toBe('WAKE');
  });

  it('a --account=auto session KEEPS its gateway route across the wake (the fix must not blanket-strip)', () => {
    const route = wakeAccountRouteFromArgv(AUTO_ARGV, 'su-auto');
    expect(route!.mode).toBe('auto');
    // The whole point is honoring the CHOSEN route, not forcing everyone direct.
    expect(route!.env.ANTHROPIC_BASE_URL).toContain('127.0.0.1');
    expect(route!.env.ANTHROPIC_AUTH_TOKEN).toBeTruthy();

    const r = resumeCommandFor({ agent: 'claude', sessionId: 'sid-a', ompThreadId: null }, 'WAKE', route);
    const settingsIdx = r!.args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThan(-1);
    const overlay = JSON.parse(r!.args[settingsIdx + 1]);
    expect(overlay.env.ANTHROPIC_BASE_URL).toBe(route!.env.ANTHROPIC_BASE_URL);
    expect(overlay.env.ANTHROPIC_AUTH_TOKEN).toBe(route!.env.ANTHROPIC_AUTH_TOKEN);
  });

  it('a session with NO recorded --account gets no invented overlay (old rows stay byte-identical)', () => {
    // An old adv row has no trustworthy route; inventing one would be a silent
    // re-route, which is the same class of bug in the other direction.
    expect(wakeAccountRouteFromArgv(['psu', '--no-picker'], 'su-old')).toBeNull();
    const r = resumeCommandFor({ agent: 'claude', sessionId: 'sid-o', ompThreadId: null }, 'WAKE', null);
    expect(r!.args).not.toContain('--settings');
    expect(r!.args[r!.args.length - 1]).toBe('WAKE');
  });

  it("the spawn boundary strips the OPERATOR's own gateway env so it cannot reach the child", async () => {
    // The operator host legitimately carries ANTHROPIC_BASE_URL=:8788 for its
    // in-process SDK calls. Before the fix that leaked into every detached wake
    // child via `{...process.env}` — this is the leg that made a default-account
    // session's autonomous turns egress through the gateway.
    const dir = mkdtempSync(join(tmpdir(), 'wake-route-'));
    const out = join(dir, 'child-env.txt');
    const prevBase = process.env.ANTHROPIC_BASE_URL;
    const prevTok = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8788';
    process.env.ANTHROPIC_AUTH_TOKEN = 'papercusp-gateway';
    try {
      defaultSpawnDetached(
        process.execPath,
        [
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({` +
            `base: process.env.ANTHROPIC_BASE_URL ?? null,` +
            `tok: process.env.ANTHROPIC_AUTH_TOKEN ?? null,` +
            `marker: process.env.WAKE_ROUTE_PROBE ?? null }))`,
        ],
        { cwd: dir, env: { WAKE_ROUTE_PROBE: 'ok' } },
      );
      const deadline = Date.now() + 10_000;
      while (!existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(existsSync(out)).toBe(true);
      const seen = JSON.parse(readFileSync(out, 'utf8'));
      // Positive control: the explicit per-wake env DID reach the child, so a
      // null base URL below is real stripping and not a dead probe.
      expect(seen.marker).toBe('ok');
      expect(seen.base).toBeNull();
      expect(seen.tok).toBeNull();

      // FALSIFIABILITY CONTROL (kept permanently, per the repo's mutation
      // discipline for module subjects — never mutate the shared tree to prove
      // a guard can fail). Same probe, spawned the way the pre-fix code did:
      // a raw `{...process.env}`. It MUST see the operator's gateway route.
      // If this control ever goes null, the ambient pollution this test guards
      // against has stopped being reproducible and the assertions above have
      // silently become vacuous — fix the control, do not delete it.
      const ctlOut = join(dir, 'control-env.txt');
      const { spawn: rawSpawn } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        const c = rawSpawn(
          process.execPath,
          [
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(ctlOut)}, JSON.stringify({` +
              `base: process.env.ANTHROPIC_BASE_URL ?? null }))`,
          ],
          { cwd: dir, env: { ...process.env } },
        );
        c.on('error', reject);
        c.on('exit', () => resolve());
      });
      expect(JSON.parse(readFileSync(ctlOut, 'utf8')).base).toBe('http://127.0.0.1:8788');
    } finally {
      if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prevBase;
      if (prevTok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = prevTok;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * P-013 part A (review-system-rework-reduction-2026-09-23, RSR-P-013-A rev 2): a wake
 * addressed to a DEAD session revives it, and when its account is walled it is RE-HOMED
 * onto another account or backend instead of resumed into the wall. The decision itself
 * is unit-tested in wake-rehome.test.ts; these tests pin the WIRING — that the dispatcher
 * acts on each verdict — with a dead target (alive:false) and a walled pinned account.
 */
describe('dead-session wake re-home on a walled account (P-013 part A)', () => {
  const PINNED_ARGV = ['psu', '--no-picker', '--agent=claude', '--account=acct-walled'];
  const overlayEnv = (args: string[]): Record<string, string> => {
    const i = args.indexOf('--settings');
    expect(i).toBeGreaterThan(-1);
    return JSON.parse(args[i + 1]).env as Record<string, string>;
  };

  it('keep → the dead pinned session resumes on its persisted hard pin (positive control)', async () => {
    const spawnDetached = vi.fn((_bin: string, _args: string[], _opts: { env: Record<string, string> }) => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ launchArgv: PINNED_ARGV })) as never,
        spawnDetached: spawnDetached as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    const [, args, opts] = spawnDetached.mock.calls[0]!;
    // Without a re-home the child routes to the walled pin — the property below must differ.
    expect(opts.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('pin');
    expect(overlayEnv(args).ANTHROPIC_CUSTOM_HEADERS).toContain('x-papercusp-account: acct-walled');
  });

  it('rehome-account → the dead session is revived on the gateway AUTO route, never the walled pin', async () => {
    const spawnDetached = vi.fn((_bin: string, _args: string[], _opts: { env: Record<string, string> }) => 4321);
    const resolveWakeRehome = vi.fn(async () => ({
      action: 'rehome-account' as const,
      fromAccountId: 'acct-walled',
      reason: 'pinned account walled; another has headroom',
    }));
    const claimResume = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ launchArgv: PINNED_ARGV })) as never,
        spawnDetached: spawnDetached as never,
        resolveWakeRehome,
        claimResume,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    // The decision was asked about the PERSISTED route (the walled pin).
    expect(resolveWakeRehome).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws', route: expect.objectContaining({ mode: 'pin', accountId: 'acct-walled' }) }),
    );
    expect(claimResume).toHaveBeenCalledWith(42, null, undefined, 'su-abc');
    const [, args, opts] = spawnDetached.mock.calls[0]!;
    expect(opts.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('auto');
    expect(opts.env.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
    const headers = overlayEnv(args).ANTHROPIC_CUSTOM_HEADERS ?? '';
    expect(headers).not.toContain('acct-walled');
    expect(headers).not.toContain('x-papercusp-account-pin');
    // Still gateway-routed, so the gateway picks the account with headroom.
    expect(overlayEnv(args).ANTHROPIC_BASE_URL).toContain('127.0.0.1');
  });

  it('rehome-backend → the dead session is ported to codex BEFORE any claim, and no claude resume spawns', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const claimResume = vi.fn(async () => true);
    const rehomeWakeOnBackend = vi.fn(async () => ({ ok: true, detail: 'ported' }));
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ launchArgv: PINNED_ARGV })) as never,
        spawnDetached,
        claimResume,
        resolveWakeRehome: vi.fn(async () => ({
          action: 'rehome-backend' as const,
          backend: 'codex' as const,
          reason: 'every claude account walled',
        })),
        rehomeWakeOnBackend,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-rehome-backend' });
    expect(rehomeWakeOnBackend).toHaveBeenCalledTimes(1);
    const [input] = rehomeWakeOnBackend.mock.calls[0] as unknown as [
      { subscriberId: string; backend: string; wakeText: string; cwd: string | null },
    ];
    expect(input).toMatchObject({ subscriberId: 'su-abc', backend: 'codex', cwd: '/repo' });
    // The ported session's first turn IS the wake.
    expect(input.wakeText).toContain('lock:grant:t-1');
    // psu's own resume claims the ended row — a pre-claim would make it refuse.
    expect(claimResume).not.toHaveBeenCalled();
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('rehome-backend that cannot launch → falls through to the claude resume (the wake is never dropped)', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ launchArgv: PINNED_ARGV })) as never,
        spawnDetached,
        resolveWakeRehome: vi.fn(async () => ({
          action: 'rehome-backend' as const,
          backend: 'codex' as const,
          reason: 'every claude account walled',
        })),
        rehomeWakeOnBackend: vi.fn(async () => ({ ok: false, detail: 'no codex model allowed' })),
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    // The failed port is reported, never silent.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no codex model allowed'));
    warn.mockRestore();
  });

  it('a non-claude dead session never consults the re-home decision (ports are claude-source-only)', async () => {
    const resolveWakeRehome = vi.fn(async () => ({ action: 'keep' as const, reason: 'x' }));
    await executeWake(
      work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: null }) }),
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null })) as never,
        resolveWakeRehome,
      }),
    );
    expect(resolveWakeRehome).not.toHaveBeenCalled();
  });
});

describe('withClaudeResumeEffortClamp (WI-10005900)', () => {
  const base = ['--settings', '{}', '--resume', 'sid-1', '-p', '--dangerously-skip-permissions', 'WAKE'];

  it('inserts the clamped --effort before --resume when the inherited Opus 5 effort is xhigh', () => {
    const out = withClaudeResumeEffortClamp(base, { model: 'opus[1m]', effortLevel: 'xhigh' });
    expect(out).toEqual(['--settings', '{}', '--effort', 'max', '--resume', 'sid-1', '-p', '--dangerously-skip-permissions', 'WAKE']);
    expect(base).not.toContain('--effort'); // input untouched
  });

  it('clamps a full Opus 5 model id too', () => {
    expect(withClaudeResumeEffortClamp(base, { model: 'claude-opus-5-5', effortLevel: 'XHIGH' })).toContain('max');
  });

  it('returns the SAME array when there is nothing to clamp', () => {
    for (const settings of [
      null,
      { model: 'opus[1m]', effortLevel: 'high' },
      { model: 'opus', effortLevel: 'max' },
      { model: 'claude-sonnet-4-5', effortLevel: 'xhigh' },
      // Known limitation: no model anywhere ⇒ the CLI default is unknown ⇒ no clamp.
      { effortLevel: 'xhigh' },
      { model: 'opus', effortLevel: 7 },
    ]) {
      expect(withClaudeResumeEffortClamp(base, settings)).toBe(base);
    }
  });

  it('leaves an argv that already names an effort, or has no --resume, alone', () => {
    const settings = { model: 'opus', effortLevel: 'xhigh' };
    const named = ['--effort', 'high', '--resume', 'sid', 'WAKE'];
    expect(withClaudeResumeEffortClamp(named, settings)).toBe(named);
    const namedEq = ['--effort=high', '--resume', 'sid', 'WAKE'];
    expect(withClaudeResumeEffortClamp(namedEq, settings)).toBe(namedEq);
    const fresh = ['-p', 'WAKE'];
    expect(withClaudeResumeEffortClamp(fresh, settings)).toBe(fresh);
  });

  it('judges the argv --model over the settings model', () => {
    const opusArgv = ['--model', 'opus', '--resume', 'sid', 'WAKE'];
    expect(withClaudeResumeEffortClamp(opusArgv, { model: 'claude-sonnet-4-5', effortLevel: 'xhigh' })).toEqual([
      '--model',
      'opus',
      '--effort',
      'max',
      '--resume',
      'sid',
      'WAKE',
    ]);
    const sonnetArgv = ['--model', 'claude-sonnet-4-5', '--resume', 'sid', 'WAKE'];
    expect(withClaudeResumeEffortClamp(sonnetArgv, { model: 'opus', effortLevel: 'xhigh' })).toBe(sonnetArgv);
  });
});

describe('resumeCommandFor', () => {
  it('reapplies an admitted OMP removal on both headless and PTY wake routes', () => {
    const policy = {
      clientVersions: { omp: '18.0.3' },
      ompNativeTools: ['read', 'bash'],
      readiness: [{ family: 'shell-ssh-interpreters' as const, cutoverReady: true, openGapIds: [] }],
      cutoverStaging: { 'shell-ssh-interpreters': 'full' as const },
      adoption: [{ client: 'omp' as const, family: 'shell-ssh-interpreters' as const,
        managedPathProven: true, nativeBypassRefused: true, atClientVersion: '18.0.3' }],
      matrix: [{ client: 'omp' as const, family: 'shell-ssh-interpreters' as const,
        allScenariosPassed: true, declaredScenarioCount: 7, unmet: [] }],
    };
    const prior = process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
    try {
      for (const pty of ['0', '1']) {
        process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = pty;
        const handle = { agent: 'omp', sessionId: null, ompThreadId: 'exact-thread' };
        const result = resumeCommandFor(handle, 'WAKE', null, policy)!;
        expect(result.promptViaPty).toBe(pty === '1');
        expect(result.args.slice(0, 2)).toEqual(['-r', 'exact-thread']);
        const selection = result.args[result.args.indexOf('--tools') + 1].split(',');
        expect(selection).toContain('read');
        expect(selection).not.toContain('bash');
        expect(resumeCommandFor(handle, 'WAKE', null)!.args).not.toContain('--tools');
      }
    } finally {
      if (prior === undefined) delete process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
      else process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = prior;
    }
  });

  it('claude: exact-session resume with the prompt as positional arg', () => {
    const r = resumeCommandFor({ agent: 'claude', sessionId: 'sid-1', ompThreadId: null }, 'WAKE');
    expect(r).not.toBeNull();
    expect(r!.bin).toBe('claude');
    expect(r!.args).toContain('--resume');
    expect(r!.args).toContain('sid-1');
    expect(r!.args[r!.args.length - 1]).toBe('WAKE');
    expect(r!.promptViaPty).toBe(false);
  });

  it('claude: re-arms the native-scheduler lockout on every wake as ONE `=` token before the positional prompt', () => {
    const r = resumeCommandFor({ agent: 'claude', sessionId: 'sid-1', ompThreadId: null }, 'WAKE');
    // The policy emits ONE `--disallowedTools=` token PER restriction and claude
    // unions them, so the scheduler lockout must be located by CONTENT. A
    // positional `findIndex` silently retargets onto whichever restriction the
    // policy happens to order FIRST: when managed-capability-policy centralised
    // the set (2026-09-18) `no-subagent-fanout` landed ahead of
    // `no-native-scheduler`, so this asserted against `Task,Agent,Workflow` and
    // reported a missing lockout that was in fact fully armed.
    const denyIdx = r!.args.findIndex(
      (a) => a.startsWith('--disallowedTools=') && a.includes('ScheduleWakeup'),
    );
    expect(denyIdx).toBeGreaterThan(-1);
    // The single-token form is load-bearing: the variadic space form would
    // consume the trailing wake text as deny rules (D-002,
    // native-scheduler-lockout-2026-06-09). That holds for EVERY emitted deny
    // token, not just the scheduler one — any space form would eat the prompt.
    expect(r!.args[denyIdx]).toContain('ScheduleWakeup');
    expect(r!.args[denyIdx]).toContain('CronCreate');
    for (const denyToken of r!.args.filter((a) => a.startsWith('--disallowedTools='))) {
      expect(/\s/.test(denyToken)).toBe(false);
    }
    expect(denyIdx).toBeLessThan(r!.args.length - 1); // wake text still trails
    expect(r!.args[r!.args.length - 1]).toBe('WAKE');
  });

  it('claude: re-arms the subagent-fanout deny on every wake (owner mandate 2026-07-02) — a woken bee never regains Task/Agent', () => {
    const r = resumeCommandFor({ agent: 'claude', sessionId: 'sid-1', ompThreadId: null }, 'WAKE');
    // Spawn-time --disallowedTools doesn't persist into a resume, so it must be
    // re-armed every wake — same persistence gap the scheduler deny addresses. Carried
    // as its own single `=` token alongside the scheduler one (claude unions them).
    const subagentDeny = r!.args.find(
      (a) => a.startsWith('--disallowedTools=') && a.includes('Task') && a.includes('Agent'),
    );
    expect(subagentDeny).toBeDefined();
    expect(/\s/.test(subagentDeny!)).toBe(false);
    expect(r!.args[r!.args.length - 1]).toBe('WAKE'); // wake text still trails
  });

  it('claude WITHOUT a native session id is NOT resumable (no --continue on a shared cwd)', () => {
    expect(resumeCommandFor({ agent: 'claude', sessionId: null, ompThreadId: null }, 'WAKE')).toBeNull();
  });

  it('claude tracked-hive resume remounts the persistent signed MCP config (D-010 resume leg)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'session-mcp-'));
    const prev = process.env.PAPERCUSP_SESSION_MCP_DIR;
    process.env.PAPERCUSP_SESSION_MCP_DIR = root;
    try {
      mkdirSync(join(root, 's-123-queen'), { recursive: true });
      writeFileSync(join(root, 's-123-queen', '.mcp.json'), '{"mcpServers":{}}');

      const r = resumeCommandFor(
        { agent: 'claude', sessionId: 'sid-q', ompThreadId: null, coordOwnerId: 's-123-queen' },
        'WAKE',
      );
      expect(r!.args).toContain('--mcp-config');
      expect(r!.args).toContain(join(root, 's-123-queen', '.mcp.json'));
      expect(r!.args).toContain('--strict-mcp-config');
      // Prompt stays the trailing positional arg.
      expect(r!.args[r!.args.length - 1]).toBe('WAKE');

      // No config on disk for this owner → resume still works, just no remount.
      const bare = resumeCommandFor(
        { agent: 'claude', sessionId: 'sid-q', ompThreadId: null, coordOwnerId: 's-nope' },
        'WAKE',
      );
      expect(bare!.args).not.toContain('--mcp-config');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_SESSION_MCP_DIR;
      else process.env.PAPERCUSP_SESSION_MCP_DIR = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omp: thread resume defaults to headless one-turn with the wake prompt', () => {
    const r = resumeCommandFor({ agent: 'omp', sessionId: null, ompThreadId: 'th-9' }, 'WAKE');
    expect(r!.bin).toBe('omp');
    expect(r!.args).toEqual(['-r', 'th-9', '--approval-mode', 'yolo', '-p', 'WAKE']);
    expect(r!.promptViaPty).toBe(false);
  });

  it('omp: can fall back to PTY injection for older builds', () => {
    const prev = process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
    process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = '1';
    try {
      const r = resumeCommandFor({ agent: 'omp', sessionId: null, ompThreadId: 'th-9' }, 'WAKE');
      expect(r!.bin).toBe('omp');
      expect(r!.args).toEqual(['-r', 'th-9', '--approval-mode', 'yolo']);
      expect(r!.promptViaPty).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
      else process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = prev;
    }
  });

  it('omp readiness detector recognizes prompt-like resume screens', () => {
    expect(ompResumePtyLooksReady('OMP ready\n> ')).toBe(true);
    expect(ompResumePtyLooksReady('Type a message to continue')).toBe(true);
    expect(ompResumePtyLooksReady('booting provider adapters...')).toBe(false);
  });

  it('codex: headless `exec resume <uuid> <prompt>` when the conversation id is known', () => {
    const r = resumeCommandFor({ agent: 'codex', sessionId: ROLLOUT_UUID, ompThreadId: null }, 'WAKE');
    expect(r!.bin).toBe('codex');
    expect(r!.args).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
      ROLLOUT_UUID,
      'WAKE',
    ]);
    expect(r!.promptViaPty).toBe(false);
  });

  it('codex: null without a conversation id (executeWake recovers it; null → park)', () => {
    expect(resumeCommandFor({ agent: 'codex', sessionId: null, ompThreadId: null }, 'WAKE')).toBeNull();
  });

  it('unknown client: null', () => {
    expect(resumeCommandFor({ agent: null, sessionId: 'sid', ompThreadId: null }, 'WAKE')).toBeNull();
  });
});

describe('executeWake — the liveness ladder', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('no handle + live presence → park (inbox-only reachability)', async () => {
    const out = await executeWake(work({ wakeHandle: null }), deps());
    expect(out).toMatchObject({ kind: 'park' });
  });

  it('no handle + stale presence (headless waiter) → DEGRADES to a coord inbox notification, not a drop (P-001)', async () => {
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({ presence: vi.fn(async () => stalePresence) as never, sendCoordMessage: sendCoordMessage as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(sendCoordMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = sendCoordMessage.mock.calls[0] as unknown as [
      { workspaceId: string },
      { to: string[]; summary: string; body: string },
    ];
    expect(identity.workspaceId).toBe('ws');
    expect(opts.to).toEqual(['su-abc']);
    expect(opts.summary).toContain('dead waiter');
    expect(opts.body).toContain('lock:grant:t-1');
  });

  it('no handle + stale presence, but even the inbox send FAILS → still drops, visibly (no resolvable owner)', async () => {
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({
        presence: vi.fn(async () => stalePresence) as never,
        sendCoordMessage: vi.fn(async () => {
          throw new Error('no such owner');
        }) as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'drop' });
    expect((out as { reason: string }).reason).toContain('dead waiter');
    expect((out as { reason: string }).reason).toContain('no such owner');
  });

  it('live waiter still gets a pty wake (the inbox degrade never shadows a live inject)', async () => {
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const write = vi.fn(() => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPty: vi.fn(() => ({ id: 'pty-7' })) as never,
        write: write as never,
        sendCoordMessage: sendCoordMessage as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(sendCoordMessage).not.toHaveBeenCalled();
  });

  it('parks behind an already-running headless resume without authorizing inbox fallback', async () => {
    const isHeadlessResumeTurn = vi.fn(() => true);
    const d = deps({ isHeadlessResumeTurn: isHeadlessResumeTurn as never });
    const out = await executeWake(
      work({ wakeHandle: advHandle({ pid: 9999 }) }),
      d,
    );

    expect(out).toEqual({
      kind: 'park',
      reason: 'headless resume turn pid 9999 is still running for this session; parked until it exits',
      hostCommitPending: true,
    });
    expect(isHeadlessResumeTurn).toHaveBeenCalledWith(9999, '11111111-2222-3333-4444-555555555555');
    expect(d.sendCoordMessage).not.toHaveBeenCalled();
  });

  it('delivers a cross-harness work-item completion wake instead of treating its harness as loop lineage', async () => {
    const write = vi.fn(() => true);
    const getLoopStatusFn = vi.fn(async () => ({
      active: true,
      harnessSlug: 'sb-devboard-hive',
      armedAt: '1970-01-01T00:00:00.000Z',
    })) as never;
    const d = deps({
      findPty: vi.fn(() => ({ id: 'pty-7' })) as never,
      write: write as never,
      getLoopStatusFn,
    });
    const out = await executeWake(
      work({
        eventKey: 'work-item:done:WI-41390',
        payload: {
          id: 'WI-41390',
          state: 'closed',
          kind: 'task',
          harness: 'papercusp',
          title: 'settled child work item',
        },
        wakeHandle: advHandle(),
      }),
      d,
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(write).toHaveBeenCalled();
    expect(getLoopStatusFn).not.toHaveBeenCalled();
  });

  it('delivers the exact cross-harness work-item claim payload from EI-21388471167237888', async () => {
    const write = vi.fn(() => true);
    const getLoopStatusFn = vi.fn(async () => ({
      active: true,
      harnessSlug: 'sb-devboard-hive',
      armedAt: '1970-01-01T00:00:00.000Z',
    })) as never;
    const d = deps({
      findPty: vi.fn(() => ({ id: 'pty-7' })) as never,
      write: write as never,
      getLoopStatusFn,
    });
    const out = await executeWake(
      work({
        eventKey: 'work-item:claimed:WI-41252',
        payload: {
          id: 'WI-41252',
          state: 'open',
          kind: 'feature',
          harness: 'papercusp',
          assignee: 'su-worker',
        },
        wakeHandle: advHandle(),
      }),
      d,
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(write).toHaveBeenCalled();
    expect(getLoopStatusFn).not.toHaveBeenCalled();
  });

  it('session ended, not resumable, presence gone → DEGRADES to a coord inbox notification, not a drop (P-001)', async () => {
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const out = await executeWake(
      work({ wakeHandle: advHandle({ sessionId: null, ompThreadId: null }), payload: null }),
      deps({
        getSession: vi.fn(async () =>
          session({ endedAt: new Date().toISOString(), pid: null, sessionId: null, ompThreadId: null }),
        ) as never,
        presence: vi.fn(async () => stalePresence) as never,
        sendCoordMessage: sendCoordMessage as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(sendCoordMessage).toHaveBeenCalledTimes(1);
  });

  it('no handle BUT a live psu-host socket → inject via the socket, not park (EI-152)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({ findPsuHost: vi.fn(() => ({ sock: '/tmp/x.sock' })) as never, injectPsuHost: injectPsuHost as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(injectPsuHost).toHaveBeenCalledWith('/tmp/x.sock', expect.objectContaining({ mode: 'turn' }));
  });

  it('early accepted ACK with no turn-start proof parks for retry instead of booking clean delivery', async () => {
    const injectPsuHostWithConfirmation = vi.fn(async () => ({
      ok: true,
      confirmation: 'acked' as const,
      reason: 'accepted',
    }));
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/x.sock' })) as never,
        injectPsuHost: undefined,
        injectPsuHostWithConfirmation: injectPsuHostWithConfirmation as never,
      }),
    );
    expect(out).toEqual({ kind: 'park', reason: expect.stringContaining('accepted'), hostCommitPending: true });
    expect(injectPsuHostWithConfirmation).toHaveBeenCalledWith(
      '/tmp/x.sock',
      expect.objectContaining({ mode: 'turn', deliveryId: String(work({ wakeHandle: null }).id) }),
    );
  });

  it('keeps native-turn-start-unverified host-owned because late proof can still arrive', async () => {
    const injectPsuHostWithConfirmation = vi.fn(async () => ({
      ok: false,
      confirmation: 'acked' as const,
      reason: 'native-turn-start-unverified',
    }));
    const host = { sock: '/tmp/x.sock', ownerId: 'su-a', caps: ['native-turn-start'] };
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({
        findPsuHost: vi.fn(() => host) as never,
        injectPsuHost: undefined,
        injectPsuHostWithConfirmation: injectPsuHostWithConfirmation as never,
      }),
    );

    expect(out).toMatchObject({
      kind: 'park',
      reason: expect.stringContaining('psu-host accepted: native-turn-start-unverified'),
      hostCommitPending: true,
    });
    expect(injectPsuHostWithConfirmation).toHaveBeenCalledTimes(1);
  });

  it('keeps a deferred loop-fire retry host-owned and preserves exact delivery identity and turn proof', async () => {
    const ownerId = 'su-loop-deferral';
    const delivery = work({
      id: 7331,
      subscriberId: ownerId,
      attempts: 8,
      payload: { carry: 'warm', wakeCount: 8, harness: 'papercusp', routineId: 'routine-loop-deferral' },
    });
    const tagOrigins: string[] = [];
    const tag = ((args: { sid: string; origin: string; text: string }) => {
      tagOrigins.push(args.origin);
      return {
        taggedText: '⟦tagged:' + args.origin + '⟧\n' + args.text,
        envelope: '⟦tagged:' + args.origin + '⟧',
        nonce: 'loop-deferral-test',
        origin: args.origin,
        ledgerWritten: true,
      };
    }) as never;
    const results = [
      { ok: false, confirmation: 'acked' as const, reason: 'deferred-busy-gate' },
      { ok: true, confirmation: 'acked' as const, reason: 'delivered' },
    ];
    const injectPsuHostWithConfirmation = vi.fn(async () => results.shift() as (typeof results)[number]);
    const host = { sock: '/tmp/psu-pty/loop-deferral.sock', ownerId, caps: ['native-turn-start'] };
    const wakeDeps = deps({
      findPsuHost: vi.fn(() => host) as never,
      injectPsuHost: undefined,
      injectPsuHostWithConfirmation: injectPsuHostWithConfirmation as never,
      tagTurn: tag,
    });

    const first = await executeWake(delivery, wakeDeps);
    expect(first).toMatchObject({
      kind: 'park',
      reason: expect.stringContaining('deferred-busy-gate'),
      hostCommitPending: true,
    });

    const retry = await executeWake({
      ...delivery,
      attempts: 9,
      lastError: first.kind === 'park' ? first.reason : null,
    }, wakeDeps);
    expect(retry).toEqual({
      kind: 'delivered',
      channel: 'psu-socket-inject',
      turnProof: 'host-attested',
    });
    expect(tagOrigins).toEqual(['loop-fire', 'loop-fire']);
    for (const attempt of [1, 2]) {
      expect(injectPsuHostWithConfirmation).toHaveBeenNthCalledWith(
        attempt,
        host.sock,
        expect.objectContaining({
          deliveryId: String(delivery.id),
          data: expect.stringMatching(/^⟦tagged:loop-fire⟧\n/),
          requireNativeTurnStart: true,
        }),
      );
    }
  });

  it('releases only the exact current-host accepted delivery after a host-ending terminal drop', async () => {
    const ownerId = 'su-host-ending-drop';
    const deliveryId = '782698';
    const startedAt = Date.parse('2026-10-15T10:00:00.000Z');
    const terminal = (id: string, ts: string) => ({
      kind: 'wake-rearm-dropped',
      mode: 'turn',
      reason: 'host-ending',
      deliveryIds: [id],
      ts,
    });
    const ledgerReads = [
      [terminal('another-delivery', '2026-10-15T10:01:00.000Z')],
      [terminal(deliveryId, '2026-10-15T09:59:59.999Z')],
      [terminal(deliveryId, '2026-10-15T10:01:00.000Z')],
    ];
    const readPsuHostEventTailAsync = vi.fn(async () => ledgerReads.shift() ?? []);
    const injectPsuHostWithConfirmation = vi.fn(async () => ({
      ok: true,
      confirmation: 'acked' as const,
      reason: 'accepted',
    }));
    const d = deps({
      findPsuHost: vi.fn(async () => ({ sock: '/tmp/host-ending-drop.sock', ownerId, startedAt })) as never,
      injectPsuHost: undefined,
      injectPsuHostWithConfirmation: injectPsuHostWithConfirmation as never,
      readPsuHostEventTailAsync,
    });
    const delivery = work({ id: Number(deliveryId), subscriberId: ownerId, wakeHandle: null });

    const first = await executeWake(delivery, d);
    expect(first).toMatchObject({ kind: 'park', hostCommitPending: true });

    const wrongId = await executeWake({ ...delivery, attempts: 8, lastError: first.kind === 'park' ? first.reason : null }, d);
    expect(wrongId).toMatchObject({ kind: 'park', hostCommitPending: true });

    const oldHost = await executeWake({ ...delivery, attempts: 8, lastError: wrongId.kind === 'park' ? wrongId.reason : null }, d);
    expect(oldHost).toMatchObject({ kind: 'park', hostCommitPending: true });

    const ended = await executeWake({ ...delivery, attempts: 8, lastError: oldHost.kind === 'park' ? oldHost.reason : null }, d);
    expect(ended).toMatchObject({
      kind: 'park',
      reason: expect.stringContaining('terminal host-ending drop confirmed'),
    });
    expect(ended.kind === 'park' && ended.hostCommitPending).toBeFalsy();
    expect(injectPsuHostWithConfirmation).toHaveBeenCalledTimes(3);
    expect(readPsuHostEventTailAsync).toHaveBeenCalledTimes(3);
  });

  it.each([
    'psu-host deferred-busy-gate: delivery accepted before turn-start proof; retry remains durable',
    'psu-host accepted the cancellation request; waiting for its exact pre-write receipt',
    'psu-host still owns the accepted delivery; cancellation is unsupported and the retry remains durable',
    'psu-host accepted the fail-open wake retry; waiting for its delivery outcome',
    'psu-host coalesced-into-pending-turn: delivery accepted before turn-start proof; retry remains durable',
  ])('recovers a terminal host-ending receipt after incumbent park reason %s', async (lastError) => {
    const ownerId = 'su-host-ending-cancellation';
    const startedAt = Date.parse('2026-10-15T10:00:00.000Z');
    const injectPsuHostWithConfirmation = vi.fn();
    const outcome = await executeWake(work({ id: 904, subscriberId: ownerId, wakeHandle: null, lastError }), deps({
      findPsuHost: vi.fn(async () => ({ sock: '/tmp/host-ending-cancellation.sock', ownerId, startedAt })) as never,
      injectPsuHost: undefined,
      injectPsuHostWithConfirmation,
      readPsuHostEventTailAsync: vi.fn(async () => [{
        kind: 'wake-rearm-dropped', mode: 'turn', reason: 'host-ending',
        deliveryIds: ['904'], ts: '2026-10-15T10:01:00.000Z',
      }]),
    }));
    expect(outcome).toMatchObject({ kind: 'park', reason: expect.stringContaining('terminal host-ending drop confirmed') });
    expect(outcome.kind === 'park' && outcome.hostCommitPending).toBeFalsy();
    expect(injectPsuHostWithConfirmation).not.toHaveBeenCalled();
  });

  describe('turn-start proof on the confirming psu path (P-006/D-004)', () => {
    const confirmingDeps = (caps: string[] | undefined, reason: string) => {
      const injectPsuHostWithConfirmation = vi.fn(async () => ({ ok: true, confirmation: 'acked' as const, reason }));
      return {
        injectPsuHostWithConfirmation,
        deps: deps({
          findPsuHost: vi.fn(() => ({ sock: '/tmp/x.sock', ...(caps ? { caps } : {}) })) as never,
          injectPsuHost: undefined,
          injectPsuHostWithConfirmation: injectPsuHostWithConfirmation as never,
        }),
      };
    };

    it('books host-attested when the host confirmed a native turn start it was asked to prove', async () => {
      const { injectPsuHostWithConfirmation, deps: d } = confirmingDeps(['native-turn-start'], 'delivered');
      const out = await executeWake(work({ wakeHandle: null }), d);
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject', turnProof: 'host-attested' });
      expect(injectPsuHostWithConfirmation).toHaveBeenCalledWith(
        '/tmp/x.sock',
        expect.objectContaining({ requireNativeTurnStart: true }),
      );
    });

    it('books host-attested when the host finds a durable exact-ID native-turn-start receipt', async () => {
      const { injectPsuHostWithConfirmation, deps: d } = confirmingDeps(undefined, 'delivery-already-started');
      const out = await executeWake(work({ wakeHandle: null }), d);
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject', turnProof: 'host-attested' });
      expect(injectPsuHostWithConfirmation).toHaveBeenCalledWith(
        '/tmp/x.sock',
        expect.not.objectContaining({ requireNativeTurnStart: true }),
      );
    });

    it('does not attest a turn on a host that was never asked to prove one', async () => {
      // An older host (no native-turn-start capability) replies 'delivered' once the bytes are
      // written; that is persistence, not a turn start, so the pump must still observe it.
      const { injectPsuHostWithConfirmation, deps: d } = confirmingDeps(undefined, 'delivered');
      const out = await executeWake(work({ wakeHandle: null }), d);
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
      expect(injectPsuHostWithConfirmation).toHaveBeenCalledWith(
        '/tmp/x.sock',
        expect.not.objectContaining({ requireNativeTurnStart: true }),
      );
    });

    it('does not attest a turn on a duplicate-delivery-id reply', async () => {
      const { deps: d } = confirmingDeps(['native-turn-start'], 'duplicate-delivery-id');
      const out = await executeWake(work({ wakeHandle: null }), d);
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    });
  });

  it.each([
    ['cancel-requested', 'psu-host accepted: cancellation request accepted; waiting for its exact pre-write receipt'],
    ['pending-delivery-id', 'psu-host accepted: cancellation is unsupported; the accepted delivery remains host-owned and retryable'],
    ['accepted', 'psu-host accepted: fail-open wake retry; waiting for its delivery outcome'],
  ])('keeps cancellation host-owned after %s and waits for the exact pre-write receipt', async (reason, parkReason) => {
    const ownerId = 'su-inbox-cancel';
    const sock = '/tmp/inbox-cancel.sock';
    const injectPsuHostWithConfirmation = vi.fn(async () => ({
      ok: true,
      confirmation: 'acked' as const,
      reason,
    }));
    const delivery = work({
      id: 903,
      subscriberId: ownerId,
      eventKey: `coord:inbox-wake:${ownerId}`,
      wakeHandle: null,
      hostCancellation: { deliveryIds: ['901', '902'], handledMsgIds: ['m-a', 'm-b'] },
    });

    const wakeDeps = deps({
      findPsuHost: vi.fn(() => ({ sock, ownerId })) as never,
      injectPsuHostWithConfirmation: injectPsuHostWithConfirmation as never,
    });
    const parked = await executeWake(delivery, wakeDeps);
    expect(parked).toMatchObject({
      kind: 'park',
      hostCommitPending: true,
      reason: parkReason,
    });
    expect(injectPsuHostWithConfirmation).toHaveBeenCalledTimes(1);
    expect(injectPsuHostWithConfirmation).toHaveBeenCalledWith(sock, expect.objectContaining({
      mode: 'turn',
      ownerId,
      deliveryId: '901',
      cancelDeliveryIds: ['901', '902'],
      handledMsgIds: ['m-a', 'm-b'],
    }));
    injectPsuHostWithConfirmation.mockResolvedValueOnce({
      ok: true, confirmation: 'acked', reason: 'cancelled-before-write',
    });
    await expect(executeWake({ ...delivery, attempts: 2, lastError: parkReason }, wakeDeps)).resolves.toEqual({
      kind: 'delivered', channel: 'suppressed-redundant',
    });
    expect(injectPsuHostWithConfirmation).toHaveBeenCalledTimes(2);
  });

  it('settles a handled inbox wake only after the host confirms cancellation before any write', async () => {
    const ownerId = 'su-inbox-cancel';
    const injectPsuHostWithConfirmation = vi.fn(async () => ({
      ok: true,
      confirmation: 'acked' as const,
      reason: 'cancelled-before-write',
    }));
    const delivery = work({
      id: 904,
      subscriberId: ownerId,
      eventKey: `coord:inbox-wake:${ownerId}`,
      wakeHandle: null,
      hostCancellation: { deliveryIds: ['904'], handledMsgIds: ['m-fyi'] },
    });

    await expect(executeWake(delivery, deps({
      findPsuHost: vi.fn(() => ({ sock: '/tmp/inbox-cancel.sock', ownerId })) as never,
      injectPsuHostWithConfirmation: injectPsuHostWithConfirmation as never,
    }))).resolves.toEqual({ kind: 'delivered', channel: 'suppressed-redundant' });
    expect(injectPsuHostWithConfirmation).toHaveBeenCalledTimes(1);
  });

  it('keeps an accepted host delivery nonterminal while pending, then recognizes its late completion', async () => {
    const results = [
      { ok: true, confirmation: 'acked' as const, reason: 'accepted' },
      { ok: true, confirmation: 'acked' as const, reason: 'pending-delivery-id' },
      { ok: true, confirmation: 'acked' as const, reason: 'coalesced-into-pending-turn' },
      { ok: true, confirmation: 'acked' as const, reason: 'duplicate-delivery-id' },
    ];
    const injectPsuHostWithConfirmation = vi.fn<NonNullable<ExecuteWakeDeps['injectPsuHostWithConfirmation']>>(
      async () => results.shift()!,
    );
    const delivery = work({ wakeHandle: null, id: 901 });
    const wakeDeps = deps({
      findPsuHost: vi.fn(() => ({ sock: '/tmp/pending-host.sock' })) as never,
      injectPsuHost: undefined,
      injectPsuHostWithConfirmation: injectPsuHostWithConfirmation as never,
    });

    expect(await executeWake(delivery, wakeDeps)).toMatchObject({
      kind: 'park',
      hostCommitPending: true,
      reason: expect.stringContaining('accepted'),
    });
    expect(await executeWake(delivery, wakeDeps)).toMatchObject({
      kind: 'park',
      hostCommitPending: true,
      reason: expect.stringContaining('pending-delivery-id'),
    });
    expect(await executeWake(delivery, wakeDeps)).toMatchObject({
      kind: 'park',
      hostCommitPending: true,
      reason: expect.stringContaining('coalesced-into-pending-turn'),
    });
    expect(await executeWake(delivery, wakeDeps)).toEqual({
      kind: 'delivered',
      channel: 'psu-socket-inject',
    });
    expect(injectPsuHostWithConfirmation).toHaveBeenCalledTimes(4);
    expect(injectPsuHostWithConfirmation.mock.calls.map((call) => call[1].deliveryId)).toEqual([
      '901',
      '901',
      '901',
      '901',
    ]);
  });

  it("threads this delivery's own id onto the envelope as deliveryId (EI-19311270129974785 — host-side retry dedup)", async () => {
    const injectPsuHost = vi.fn(async () => true);
    await executeWake(
      work({ wakeHandle: null, id: 35092 }),
      deps({ findPsuHost: vi.fn(() => ({ sock: '/tmp/x.sock' })) as never, injectPsuHost: injectPsuHost as never }),
    );
    expect(injectPsuHost).toHaveBeenCalledWith('/tmp/x.sock', expect.objectContaining({ deliveryId: '35092' }));
  });

  it('no handle + live socket but inject FAILS → falls through to park (live presence)', async () => {
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/x.sock' })) as never,
        injectPsuHost: vi.fn(async () => false) as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
  });

  it('plan-run handle → resumed via the plans:resume path', async () => {
    const resumePlanRun = vi.fn(async () => ({ ok: true as const }));
    const out = await executeWake(work({ wakeHandle: { kind: 'plan-run', runId: 12 } }), deps({ resumePlanRun }));
    expect(out).toEqual({ kind: 'delivered', channel: 'plan-run-resume' });
    expect(resumePlanRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 12 }));
    const planArg = (resumePlanRun.mock.calls[0] as unknown as [{ wakeText: string }])[0];
    expect(planArg.wakeText).toContain('lock:grant:t-1');
  });

  it('alive + managed pty pid-match → inject the turn TEXT now, the submit CR as a SEPARATE keystroke', async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(() => true);
      const forceResume = vi.fn(async () => true);
      const out = await executeWake(
        work({ wakeHandle: advHandle() }),
        deps({
          findPty: vi.fn(() => ({ id: 'pty-7' })) as never,
          write: write as never,
          isLoopArmed: vi.fn(async () => true),
          forceResume,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
      expect(forceResume).not.toHaveBeenCalled();
      // First write = the turn TEXT, with NO trailing CR. A one-shot text+CR burst
      // is swallowed by the claude TUI's paste detector (CR → literal newline), so
      // the CR must arrive as its own keystroke.
      const [id, buf] = write.mock.calls[0] as unknown as [string, Buffer];
      expect(id).toBe('pty-7');
      expect(buf.toString()).toContain('lock:grant:t-1');
      expect(buf.toString()).not.toMatch(/\r$/);
      expect(write).toHaveBeenCalledTimes(1);
      // The submit CR lands as a SEPARATE write after the settle delay.
      await vi.advanceTimersByTimeAsync(200);
      expect(write).toHaveBeenCalledTimes(2);
      expect((write.mock.calls[1] as unknown as [string, Buffer])[1].toString()).toBe('\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('alive in a terminal we do not own → park (never inject keystrokes elsewhere)', async () => {
    const out = await executeWake(work({ wakeHandle: advHandle() }), deps());
    expect(out).toMatchObject({ kind: 'park' });
    expect((out as { reason: string }).reason).toContain('alive');
  });

  it('WI-666: active resumable loop owner gets bounded force-resume, then the normal headless resume', async () => {
    const forceResume = vi.fn(async () => true);
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        isLoopArmed: vi.fn(async () => true),
        forceResume,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(forceResume).toHaveBeenCalledWith(9999);
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });

  describe('grading-audit Channel 2 freshness guard', () => {
    const nativeSessionId = 'native-grading-auditor-session';
    const issueId = 'EI-grading-audit-resume';
    const reservation = { key: `grading-audit:${issueId}`, reservedAt: '2026-10-14T17:27:26.871Z' };

    function fixture(gradingAudit: Record<string, unknown> = {
      state: 'pending', dispatchReservation: reservation,
    }) {
      const order: string[] = [];
      const task = {
        workspaceId: 'ws', taskId: 'grading-auditor-task', class: 'agent-session',
        sessionId: nativeSessionId,
        detail: {
          coordOwnerId: 'su-abc',
          gradingAudit: { issueId, evidenceFingerprint: 'evidence-v1', reservation },
        },
      };
      const readGradingAuditTasks = vi.fn(async () => {
        order.push('tasks');
        return [task];
      });
      const readGradingAuditTarget = vi.fn(async () => {
        order.push('target');
        return { issueId, evidenceFingerprint: 'evidence-v1', gradingAudit };
      });
      const cancelGradingAuditAwait = vi.fn(async () => undefined);
      const claimResume = vi.fn(async () => {
        order.push('claim');
        return true;
      });
      const spawnDetached = vi.fn(() => {
        order.push('spawn');
        return 4321;
      });
      const delivery = work({ awaitId: 515, wakeHandle: advHandle({ sessionId: nativeSessionId }) });
      const common = deps({
        getSession: vi.fn(async () => session({ sessionId: nativeSessionId })) as never,
        alive: vi.fn(() => false),
        readGradingAuditTasks: readGradingAuditTasks as never,
        readGradingAuditTarget: readGradingAuditTarget as never,
        cancelGradingAuditAwait: cancelGradingAuditAwait as never,
        claimResume,
        spawnDetached,
      });
      return { order, task, delivery, common, readGradingAuditTasks, readGradingAuditTarget,
        cancelGradingAuditAwait, claimResume, spawnDetached };
    }

    it('allows the exact pending reservation and validates it before the resume claim', async () => {
      const f = fixture();
      const out = await executeWake(f.delivery, f.common);
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      expect(f.order.slice(0, 4)).toEqual(['tasks', 'target', 'claim', 'spawn']);
      expect(f.readGradingAuditTasks).toHaveBeenCalledWith({
        workspaceId: 'ws', subscriberId: 'su-abc', sessionId: nativeSessionId,
      });
      expect(f.claimResume).toHaveBeenCalledTimes(1);
      expect(f.cancelGradingAuditAwait).not.toHaveBeenCalled();
    });

    // WI-6554700010018677: delivery rows sit in the coordination namespace ('default',
    // WI-3575) while task_ledger rows and issues are keyed by the tenant. Reading under the
    // delivery workspace found no binding, so the guard proceeded on every real delivery.
    it("reads the binding and target under the subscriber's TENANT when the delivery is in the coordination namespace", async () => {
      const f = fixture({ state: 'passed' });
      f.task.workspaceId = 'tenant-ws';
      const workspaceForCoordOwnerFn = vi.fn(async () => 'tenant-ws');
      const out = await executeWake(
        { ...f.delivery, workspaceId: 'default' },
        { ...f.common, workspaceForCoordOwnerFn: workspaceForCoordOwnerFn as never },
      );
      expect(workspaceForCoordOwnerFn).toHaveBeenCalledWith('su-abc');
      expect(f.readGradingAuditTasks).toHaveBeenCalledWith({
        workspaceId: 'tenant-ws', subscriberId: 'su-abc', sessionId: nativeSessionId,
      });
      expect(f.readGradingAuditTarget).toHaveBeenCalledWith({ workspaceId: 'tenant-ws', issueId });
      expect(out).toMatchObject({ kind: 'drop', reason: expect.stringContaining('settled (passed)') });
      expect(f.claimResume).not.toHaveBeenCalled();
    });

    it('an unresolvable tenant keeps the fail-open contract and reads nothing', async () => {
      const f = fixture({ state: 'passed' });
      const out = await executeWake(
        { ...f.delivery, workspaceId: 'default' },
        { ...f.common, workspaceForCoordOwnerFn: vi.fn(async () => null) as never },
      );
      expect(f.readGradingAuditTasks).not.toHaveBeenCalled();
      expect(f.readGradingAuditTarget).not.toHaveBeenCalled();
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    });

    it('drops a settled target and cancels only this delivery await before claiming resume', async () => {
      const f = fixture({ state: 'passed' });
      const out = await executeWake(f.delivery, f.common);
      expect(out).toMatchObject({ kind: 'drop', reason: expect.stringContaining('settled (passed)') });
      expect(f.cancelGradingAuditAwait).toHaveBeenCalledTimes(1);
      expect(f.cancelGradingAuditAwait).toHaveBeenCalledWith({
        awaitId: 515,
        subscriberId: 'su-abc',
        reason: AWAIT_CANCEL_REASONS.gradingAuditNoLongerCurrent,
      });
      expect(f.claimResume).not.toHaveBeenCalled();
      expect(f.spawnDetached).not.toHaveBeenCalled();
    });

    it('drops a replaced reservation and cancels only this delivery await', async () => {
      const f = fixture({
        state: 'pending',
        dispatchReservation: { key: reservation.key, reservedAt: '2026-10-14T17:35:00.000Z' },
      });
      const out = await executeWake(f.delivery, f.common);
      expect(out).toMatchObject({ kind: 'drop', reason: expect.stringContaining('newer dispatch reservation') });
      expect(f.cancelGradingAuditAwait).toHaveBeenCalledTimes(1);
      expect(f.cancelGradingAuditAwait).toHaveBeenCalledWith({
        awaitId: 515,
        subscriberId: 'su-abc',
        reason: AWAIT_CANCEL_REASONS.gradingAuditNoLongerCurrent,
      });
      expect(f.claimResume).not.toHaveBeenCalled();
      expect(f.spawnDetached).not.toHaveBeenCalled();
    });

    it('drops changed evidence before the resume claim', async () => {
      const f = fixture();
      f.readGradingAuditTarget.mockResolvedValue({
        issueId,
        evidenceFingerprint: 'evidence-v2',
        gradingAudit: { state: 'pending', dispatchReservation: reservation },
      });
      const out = await executeWake(f.delivery, f.common);
      expect(out).toMatchObject({ kind: 'drop', reason: expect.stringContaining('changed evidence fingerprint') });
      expect(f.cancelGradingAuditAwait).toHaveBeenCalledWith({
        awaitId: 515,
        subscriberId: 'su-abc',
        reason: AWAIT_CANCEL_REASONS.gradingAuditNoLongerCurrent,
      });
      expect(f.claimResume).not.toHaveBeenCalled();
      expect(f.spawnDetached).not.toHaveBeenCalled();
    });

    it('fails open when the pending target has no current reservation', async () => {
      const f = fixture({ state: 'pending' });
      const out = await executeWake(f.delivery, f.common);
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      expect(f.claimResume).toHaveBeenCalledTimes(1);
      expect(f.cancelGradingAuditAwait).not.toHaveBeenCalled();
    });

    it('fails open when the scorecard target is absent', async () => {
      const f = fixture();
      const readGradingAuditTarget = vi.fn(async () => null);
      const common = deps({
        getSession: vi.fn(async () => session({ sessionId: nativeSessionId })) as never,
        alive: vi.fn(() => false),
        readGradingAuditTasks: f.readGradingAuditTasks as never,
        readGradingAuditTarget: readGradingAuditTarget as never,
        cancelGradingAuditAwait: f.cancelGradingAuditAwait as never,
        claimResume: f.claimResume,
        spawnDetached: f.spawnDetached,
      });
      const out = await executeWake(f.delivery, common);
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      expect(readGradingAuditTarget).toHaveBeenCalledTimes(1);
      expect(f.claimResume).toHaveBeenCalledTimes(1);
      expect(f.cancelGradingAuditAwait).not.toHaveBeenCalled();
    });

    it('fails open when the scorecard lookup is unavailable', async () => {
      const f = fixture();
      const readGradingAuditTarget = vi.fn(async () => { throw new Error('scorecard store unavailable'); });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const common = deps({
        getSession: vi.fn(async () => session({ sessionId: nativeSessionId })) as never,
        alive: vi.fn(() => false),
        readGradingAuditTasks: f.readGradingAuditTasks as never,
        readGradingAuditTarget: readGradingAuditTarget as never,
        cancelGradingAuditAwait: f.cancelGradingAuditAwait as never,
        claimResume: f.claimResume,
        spawnDetached: f.spawnDetached,
      });
      try {
        const out = await executeWake(f.delivery, common);
        expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
        expect(readGradingAuditTarget).toHaveBeenCalledTimes(1);
        expect(f.claimResume).toHaveBeenCalledTimes(1);
        expect(f.cancelGradingAuditAwait).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(
          `grading-audit target/${issueId} failed: scorecard store unavailable`,
        ));
      } finally {
        warn.mockRestore();
      }
    });

    it('fails open when the task lookup is unavailable', async () => {
      const f = fixture();
      const readGradingAuditTasks = vi.fn(async () => { throw new Error('task ledger unavailable'); });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const common = deps({
        getSession: vi.fn(async () => session({ sessionId: nativeSessionId })) as never,
        alive: vi.fn(() => false),
        readGradingAuditTasks: readGradingAuditTasks as never,
        claimResume: f.claimResume,
        spawnDetached: f.spawnDetached,
      });
      try {
        const out = await executeWake(f.delivery, common);
        expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
        expect(readGradingAuditTasks).toHaveBeenCalledTimes(1);
        expect(f.claimResume).toHaveBeenCalledTimes(1);
        expect(f.cancelGradingAuditAwait).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(
          'grading-audit task binding/su-abc failed: task ledger unavailable',
        ));
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('Channel 2 lost resume claim → parks before spawning an exact-session writer', async () => {
    const claimResume = vi.fn(async () => false);
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ alive: vi.fn(() => false), claimResume, spawnDetached }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect((out as { reason: string }).reason).toContain('resume claim');
    expect(claimResume).toHaveBeenCalledWith(42, null, undefined, 'su-abc');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('rechecks the standing inbox-wake after the successful claim and before the headless resume spawn', async () => {
    const order: string[] = [];
    const claimResume = vi.fn(async () => {
      order.push('claim');
      return true;
    });
    const ensureInboxWakeArmedForActiveSession = vi.fn(async (input: {
      ownerId: string;
      forceRecheck?: boolean;
    }) => {
      order.push('rearm');
      // false can mean the owner explicitly opted out during this incarnation;
      // it must not prevent delivery of the already-claimed wake.
      expect(input).toEqual({ ownerId: 'su-abc', forceRecheck: true });
      return false;
    });
    const spawnDetached = vi.fn(() => {
      order.push('spawn');
      return 4321;
    });

    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        alive: vi.fn(() => false),
        claimResume,
        ensureInboxWakeArmedForActiveSession,
        spawnDetached,
      }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(order).toEqual(['claim', 'rearm', 'spawn']);
  });

  it('WI-666: force-resume timeout keeps the alive loop owner safely parked', async () => {
    const forceResume = vi.fn(async () => false);
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        isLoopArmed: vi.fn(async () => true),
        forceResume,
        spawnDetached,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect((out as { reason: string }).reason).toContain('bounded force-resume');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('live psu-pty host → inject the wake turn into its control socket (channel psu-socket-inject)', async () => {
    // turn-lifecycle-control Phase 3 P-014: a live interactive psu session the
    // operator can't see via findPty (its pty is in the psu process) is woken in
    // place via its discovered control socket — NOT parked, NOT a concurrent resume.
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/su-abc.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        // even if findPty would match, the psu host is checked FIRST (it's the
        // authoritative live-injectable signal).
        findPty: vi.fn(() => ({ id: 'pty-7' })) as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    const [sock, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { mode: string; data: string }];
    expect(sock).toBe('/tmp/psu-pty/su-abc.sock');
    expect(msg.mode).toBe('turn');
    expect(msg.data).toContain('lock:grant:t-1');
  });

  it('psu host present but the socket inject FAILS → falls through to the normal channels (park)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/dead.sock' })) as never,
        injectPsuHost: vi.fn(async () => false) as never, // socket died mid-attempt
      }),
    );
    // findPty defaults to null + alive → "alive but not an injectable managed pty" park.
    expect(out).toMatchObject({ kind: 'park' });
  });

  it('re-verifies the owner host after a socket miss and retries a rebound socket', async () => {
    const findPsuHost = vi
      .fn()
      .mockReturnValueOnce({ sock: '/tmp/psu-pty/stale.sock' })
      .mockReturnValueOnce({ sock: '/tmp/psu-pty/rebound.sock' });
    const injectPsuHost = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: findPsuHost as never,
        injectPsuHost: injectPsuHost as never,
      }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(findPsuHost).toHaveBeenCalledTimes(2);
    expect(injectPsuHost).toHaveBeenNthCalledWith(
      1,
      '/tmp/psu-pty/stale.sock',
      expect.objectContaining({ mode: 'turn' }),
    );
    expect(injectPsuHost).toHaveBeenNthCalledWith(
      2,
      '/tmp/psu-pty/rebound.sock',
      expect.objectContaining({ mode: 'turn' }),
    );
  });

  it('exited claude with a native id → DETACHED headless `-p` turn (never a pty — a TTY stdin makes `-p` hang)', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const spawnManagedPty = vi.fn(() => ({ id: 'pty-new' }));
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ alive: vi.fn(() => false), spawnDetached, spawnManagedPty: spawnManagedPty as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    // claude resume runs detached, NOT in the pty (the Stage-B hang fix).
    expect(spawnManagedPty).not.toHaveBeenCalled();
    const [bin, args, o] = spawnDetached.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(bin).toBe('claude');
    expect(args).toContain('--resume');
    expect(args).toContain('-p'); // headless one-turn
    expect(o.cwd).toBe('/repo');
    expect(o.env.PAPERCUSP_SID).toBe('su-abc');
    // WI-3082: a resume IS a coord/events:await-wake-triggered fresh spawn —
    // stamp the turn-trigger so agent_usage_samples.turn_trigger isn't NULL for
    // every persistent-agent (queen/overwatch/doc-steward) resume.
    expect(o.env.PAPERCUSP_TURN_TRIGGER).toBe('coord-wake');
  });

  it('uses the persisted adv-session scope when the event delivery is pinned to the flat coord workspace', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ workspaceId: 'default', wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () =>
          session({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' }),
        ) as never,
        alive: vi.fn(() => false),
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    const [, , o] = spawnDetached.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(o.env.PAPERCUSP_WORKSPACE).toBe('papercusp-workspace');
    expect(o.env.PAPERCUSP_HARNESS_SLUG).toBe('papercusp');
  });

  it('falls back to the loop wake marker when the adv-session launch scope is absent', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ payload: { wakeCount: 1, harness: 'marker-harness' }, wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () => session({ harnessSlug: null })) as never,
        alive: vi.fn(() => false),
        isLoopArmed: vi.fn(async () => true),
        resolveMemberLiveness: parkedMemberLiveness() as never,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    const [, , o] = spawnDetached.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(o.env.PAPERCUSP_HARNESS_SLUG).toBe('marker-harness');
  });

  it('falls back to the current loop routine scope when the wake marker has no harness', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ payload: { carry: 'cold', wakeCount: 1 }, wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () => session({ harnessSlug: null })) as never,
        getLoopStatusFn: vi.fn(async () => ({ harnessSlug: 'current-loop-harness' })) as never,
        alive: vi.fn(() => false),
        isLoopArmed: vi.fn(async () => true),
        resolveMemberLiveness: parkedMemberLiveness() as never,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    const [, , o] = spawnDetached.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(o.env.PAPERCUSP_HARNESS_SLUG).toBe('current-loop-harness');
  });

  it('exited codex → DETACHED `exec resume <uuid>` with CODEX_HOME, uuid recovered from the rollout (P-009)', async () => {
    let onExit:
      | ((exit: { exitCode: number | null; signal: string | null; stdoutTail: string; stderrTail: string }) => void)
      | undefined;
    let observedExit: unknown;
    const spawnDetached = vi.fn((_bin, _args, _options, exitHandler) => {
      onExit = exitHandler;
      return 5555;
    });
    const delivery = work({ wakeHandle: advHandle({ agent: 'codex', sessionId: null }) });
    const out = await executeWake(
      // codex carries no native id on the row — executeWake recovers it from the home.
      delivery,
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ agent: 'codex', sessionId: null })) as never,
        spawnDetached,
        onResumeTurnExit: (_d, exit) => {
          observedExit = exit;
        },
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    const [bin, args, o] = spawnDetached.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(bin).toBe('codex');
    expect(args.slice(0, 5)).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
    ]);
    expect(args[5]).toBe(ROLLOUT_UUID); // recovered from the newest rollout
    expect(args[6]).toContain('lock:grant:t-1'); // the wake turn text
    expect(o.env.CODEX_HOME).toBe(join(CODEX_HOMES_DIR, 'session-42'));
    expect(onExit).toBeTypeOf('function');
    onExit!({
      exitCode: 0,
      signal: null,
      stdoutTail: '{"type":"turn.completed","usage":{}}',
      stderrTail: '',
    });
    // Every Codex exit now awaits the rollout overflow analyzer before reporting
    // (WI-6554700010008894), so the outcome handler fires asynchronously.
    await vi.waitFor(() =>
      expect(observedExit).toEqual({
        exitCode: 0,
        signal: null,
        stdoutTail: '{"type":"turn.completed","usage":{}}',
        stderrTail: '',
        outputProtocol: 'codex-jsonl',
      }),
    );
  });

  it('exited codex with NO recoverable home → park, never a bare --last (P-009)', async () => {
    const out = await executeWake(
      // adv-session 999 has no codex home on disk → no uuid → not resumable.
      work({ wakeHandle: advHandle({ agent: 'codex', sessionId: null, advSessionId: 999 }) }),
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ agent: 'codex', sessionId: null, id: 999 })) as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
  });

  it('exited codex with a stale row session id but no rollout in its derived home → park', async () => {
    const advSessionId = 999;
    const home = codexHomeForAdvSession(advSessionId);
    const spawnDetached = vi.fn(() => 4321);
    mkdirSync(home, { recursive: true });
    try {
      const out = await executeWake(
        work({
          wakeHandle: advHandle({ agent: 'codex', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', advSessionId }),
        }),
        deps({
          alive: vi.fn(() => false),
          getSession: vi.fn(async () =>
            session({
              id: advSessionId,
              agent: 'codex',
              sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            }),
          ) as never,
          spawnDetached,
          // The rematerialization attempt did not restore the missing rollout.
          rematerializeSession: vi.fn(async () => ({ ok: true, written: 0 })) as never,
        }),
      );
      expect(out).toMatchObject({ kind: 'park' });
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('exited codex resumes with the rollout restored by rematerialization, not the stale row id', async () => {
    const advSessionId = 1000;
    const home = codexHomeForAdvSession(advSessionId);
    const restoredSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const spawnDetached = vi.fn(() => 4321);
    mkdirSync(home, { recursive: true });
    try {
      const out = await executeWake(
        work({
          wakeHandle: advHandle({ agent: 'codex', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', advSessionId }),
        }),
        deps({
          alive: vi.fn(() => false),
          getSession: vi.fn(async () =>
            session({
              id: advSessionId,
              agent: 'codex',
              sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            }),
          ) as never,
          spawnDetached,
          rematerializeSession: vi.fn(async () => {
            const sessionsDir = join(home, 'sessions', '2026', '08', '22');
            mkdirSync(sessionsDir, { recursive: true });
            writeFileSync(join(sessionsDir, `rollout-2026-08-22T17-00-00-${restoredSessionId}.jsonl`), '{}');
            return { ok: true, written: 1 };
          }) as never,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      const [, args] = spawnDetached.mock.calls[0] as unknown as [string, string[]];
      expect(args[5]).toBe(restoredSessionId);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('repairs a missing Codex config after archived rollout restore and before exact UUID resume', async () => {
    const advSessionId = 1001;
    const home = codexHomeForAdvSession(advSessionId);
    const restoredSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const spawnDetached = vi.fn(() => 4321);
    const repair = vi.fn(async ({ codexHome }: { codexHome: string }) => {
      expect(existsSync(codexHome)).toBe(true);
      expect(existsSync(join(codexHome, 'config.toml'))).toBe(false);
      writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.papercusp-su]\n');
      return { ok: true, repaired: true };
    });
    rmSync(home, { recursive: true, force: true });
    try {
      const out = await executeWake(
        work({ subscriberId: 'su-archive-repair', wakeHandle: advHandle({ agent: 'codex', sessionId: null, advSessionId }) }),
        deps({
          alive: vi.fn(() => false),
          getSession: vi.fn(async () =>
            session({
              id: advSessionId,
              agent: 'codex',
              sessionId: null,
              coordOwnerId: 'su-archive-repair',
            }),
          ) as never,
          findArchivedSessionIdForAdv: vi.fn(async () => restoredSessionId) as never,
          rematerializeSession: vi.fn(async () => {
            const sessionsDir = join(home, 'sessions', '2026', '08', '23');
            mkdirSync(sessionsDir, { recursive: true });
            writeFileSync(
              join(sessionsDir, `rollout-2026-08-23T17-00-00-${restoredSessionId}.jsonl`),
              '{"type":"session_meta","payload":{"model_provider":"papercusp-codex-gateway"}}\n',
            );
            return { ok: true, written: 1 };
          }) as never,
          ensureCodexHomeForWake: repair as never,
          spawnDetached,
        }),
      );

      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      expect(repair).toHaveBeenCalledWith(
        expect.objectContaining({
          advSessionId,
          owner: 'su-archive-repair',
          codexHome: home,
          headless: true,
        }),
      );
      const [, args] = spawnDetached.mock.calls[0] as unknown as [string, string[]];
      expect(args[5]).toBe(restoredSessionId);
      expect(args).not.toContain('--last');
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('[mcp_servers.papercusp-su]');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // WI-10006825: every Channel-2 codex wake rewrote config.toml WITHOUT the
  // gateway provider because the repair seam was never told the persisted
  // `--account` route, so `--account=auto` fleet members resumed on the shared
  // ChatGPT login, hit its usage wall, and died ~60s later (respawn churn).
  it.each([
    {
      argv: ['psu', '--no-picker', '--agent=codex', '--headless', '--account=auto'],
      expected: { requireGatewayProvider: true, codexGatewayAccountId: null },
      expectedEnv: { PAPERCUSP_CODEX_GATEWAY: '1' },
    },
    {
      argv: ['psu', '--no-picker', '--agent=codex', '--headless', '--account=acct-codex-pin'],
      expected: { requireGatewayProvider: false, codexGatewayAccountId: 'acct-codex-pin' },
      expectedEnv: { PAPERCUSP_CODEX_GATEWAY: '1', PAPERCUSP_ACCOUNT_ID: 'acct-codex-pin' },
    },
    {
      argv: ['psu', '--no-picker', '--agent=codex', '--headless', '--account=default'],
      expected: { requireGatewayProvider: false, codexGatewayAccountId: null },
      expectedEnv: {},
    },
    {
      argv: null,
      expected: { requireGatewayProvider: false, codexGatewayAccountId: null },
      expectedEnv: {},
    },
  ])('codex wake repair and child env carry the persisted route (argv $argv)', async ({ argv, expected, expectedEnv }) => {
    const advSessionId = 1002;
    const home = codexHomeForAdvSession(advSessionId);
    const nativeId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const spawnDetached = vi.fn(() => 4321);
    const repair = vi.fn(async () => ({ ok: true, repaired: true }));
    rmSync(home, { recursive: true, force: true });
    const sessionsDir = join(home, 'sessions', '2026', '10', '06');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `rollout-2026-10-06T18-00-00-${nativeId}.jsonl`), '{}');
    try {
      const out = await executeWake(
        work({ subscriberId: 'su-codex-route', wakeHandle: advHandle({ agent: 'codex', sessionId: nativeId, advSessionId }) }),
        deps({
          alive: vi.fn(() => false),
          getSession: vi.fn(async () =>
            session({
              id: advSessionId,
              agent: 'codex',
              sessionId: nativeId,
              coordOwnerId: 'su-codex-route',
              launchArgv: argv,
            }),
          ) as never,
          ensureCodexHomeForWake: repair as never,
          spawnDetached,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      expect(repair).toHaveBeenCalledTimes(1);
      const [, , spawnOptions] = spawnDetached.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      expect(spawnOptions.env.PAPERCUSP_SID).toBe('su-codex-route');
      expect(spawnOptions.env.PAPERCUSP_CODEX_GATEWAY).toBe(expectedEnv.PAPERCUSP_CODEX_GATEWAY);
      expect(spawnOptions.env.PAPERCUSP_ACCOUNT_ID).toBe(expectedEnv.PAPERCUSP_ACCOUNT_ID);
      expect(spawnOptions.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
      expect(repair).toHaveBeenCalledWith(
        expect.objectContaining({ advSessionId, owner: 'su-codex-route', codexHome: home, ...expected }),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('marks a managed Codex wake URL so ptool can recover the current catalog', async () => {
    const envKeys = [
      'PAPERCUSP_OPERATOR_URL',
      'PAPERCUSP_OPERATOR_URL_PROVENANCE',
      'PAPERCUSP_OPERATOR_BASE',
      'PAPERCUSP_HONO_PORT',
      'PAPERCUSP_MCP_STAGING_PROXY_PORT',
      'PAPERCUSP_MCP_PROXY_TARGET_PORT',
      'PAPERCUSP_MCP_PROXY',
      'PAPERCUSP_MCP_STAGING_PROXY',
    ] as const;
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const advSessionId = 1014;
    const home = codexHomeForAdvSession(advSessionId);
    const nativeId = '11111111-1111-4111-8111-111111111111';
    const spawnDetached = vi.fn(() => 4321);
    const repair = vi.fn(async () => ({ ok: true, repaired: true }));
    rmSync(home, { recursive: true, force: true });
    const sessionsDir = join(home, 'sessions', '2026', '10', '28');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `rollout-2026-10-28T18-00-00-${nativeId}.jsonl`), '{}');

    try {
      process.env.PAPERCUSP_OPERATOR_URL = 'http://127.0.0.1:9071';
      process.env.PAPERCUSP_HONO_PORT = '0';
      process.env.PAPERCUSP_MCP_STAGING_PROXY_PORT = '9171';
      process.env.PAPERCUSP_MCP_PROXY = '1';
      process.env.PAPERCUSP_MCP_STAGING_PROXY = '1';
      delete process.env.PAPERCUSP_OPERATOR_URL_PROVENANCE;
      delete process.env.PAPERCUSP_OPERATOR_BASE;
      delete process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT;

      const out = await executeWake(
        work({
          subscriberId: 'su-managed-route',
          wakeHandle: advHandle({ agent: 'codex', sessionId: nativeId, advSessionId }),
        }),
        deps({
          alive: vi.fn(() => false),
          getSession: vi.fn(async () => session({
            id: advSessionId,
            agent: 'codex',
            sessionId: nativeId,
            coordOwnerId: 'su-managed-route',
          })) as never,
          ensureCodexHomeForWake: repair as never,
          spawnDetached,
        }),
      );

      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      const [, , spawnOptions] = spawnDetached.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      expect(spawnOptions.env.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9071');
      expect(spawnOptions.env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBe('psu-launcher');
      expect(resolvePtoolInvocationCandidates({ tool: 'coord:orient' }, spawnOptions.env)).toEqual([
        'http://127.0.0.1:9071',
        'http://127.0.0.1:9171',
      ]);
    } finally {
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('parks a direct/default Codex wake before spawn when system auth is unavailable', async () => {
    const advSessionId = 1003;
    const home = codexHomeForAdvSession(advSessionId);
    const nativeId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const spawnDetached = vi.fn(() => 4321);
    const prepareDirectCodexWakeAuth = vi.fn(() => ({
      checked: true,
      ready: false,
      reason: 'missing-auth-json',
    }));
    rmSync(home, { recursive: true, force: true });
    const sessionsDir = join(home, 'sessions', '2026', '10', '07');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `rollout-2026-10-07T18-00-00-${nativeId}.jsonl`), '{}');
    try {
      const out = await executeWake(
        work({ subscriberId: 'su-codex-default-auth', wakeHandle: advHandle({ agent: 'codex', sessionId: nativeId, advSessionId }) }),
        deps({
          alive: vi.fn(() => false),
          getSession: vi.fn(async () =>
            session({
              id: advSessionId,
              agent: 'codex',
              sessionId: nativeId,
              coordOwnerId: 'su-codex-default-auth',
              launchArgv: ['psu', '--no-picker', '--agent=codex', '--headless', '--account=default'],
            }),
          ) as never,
          ensureCodexHomeForWake: vi.fn(async () => ({ ok: true, repaired: false })) as never,
          prepareDirectCodexWakeAuth,
          spawnDetached,
        }),
      );

      expect(out).toEqual({
        kind: 'park',
        reason: 'Codex default-account auth unavailable (missing-auth-json); parked before provider request',
      });
      expect(prepareDirectCodexWakeAuth).toHaveBeenCalledWith(home);
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('restores native auth into the managed home before a direct/default Codex wake', async () => {
    const advSessionId = 1004;
    const home = codexHomeForAdvSession(advSessionId);
    const nativeId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const globalHome = mkdtempSync(join(tmpdir(), 'wake-codex-native-auth-'));
    const nativeAuthPath = join(globalHome, '.codex', 'auth.json');
    const spawnDetached = vi.fn(() => 4321);
    const prepareDirectCodexWakeAuth = vi.fn((codexHome: string) => {
      rehealResumeCodexAuth(codexHome, { home: globalHome });
      return codexFreshDefaultAuthPreflight({
        agent: 'codex',
        headless: true,
        account: 'default',
        codexHome,
      });
    });
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(globalHome, '.codex'), { recursive: true });
    writeFileSync(nativeAuthPath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: NEVER_EMIT_MARKER,
        refresh_token: NEVER_EMIT_MARKER,
        id_token: NEVER_EMIT_MARKER,
      },
    }), { mode: 0o600 });
    const sessionsDir = join(home, 'sessions', '2026', '10', '07');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'rollout-2026-10-07T19-00-00-' + nativeId + '.jsonl'), '{}');
    try {
      const out = await executeWake(
        work({ subscriberId: 'su-codex-default-auth', wakeHandle: advHandle({ agent: 'codex', sessionId: nativeId, advSessionId }) }),
        deps({
          alive: vi.fn(() => false),
          getSession: vi.fn(async () =>
            session({
              id: advSessionId,
              agent: 'codex',
              sessionId: nativeId,
              coordOwnerId: 'su-codex-default-auth',
              launchArgv: ['psu', '--no-picker', '--agent=codex', '--headless', '--account=default'],
            }),
          ) as never,
          ensureCodexHomeForWake: vi.fn(async () => ({ ok: true, repaired: false })) as never,
          prepareDirectCodexWakeAuth,
          spawnDetached,
        }),
      );

      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      expect(prepareDirectCodexWakeAuth).toHaveBeenCalledWith(home);
      expect(readlinkSync(join(home, 'auth.json'))).toBe(nativeAuthPath);
      expect(spawnDetached).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(globalHome, { recursive: true, force: true });
    }
  });

  it.each([
    { repairResult: { ok: false, reason: 'repair-failed' }, reason: 'repair-failed', error: null },
    { repairResult: { ok: true, repaired: false, reason: 'no-launch-spec' }, reason: 'no-launch-spec', error: null },
    { repairResult: { ok: false, reason: 'unused' },
      error: 'Invalid character at row 102\nAuthorization = "Bearer opaque-test-bearer-value-for-resume-repair"',
      reason: 'Invalid character at row 102\nAuthorization = "Bearer [redacted]"' },
  ].flatMap(row => ['default', 'auto', 'pin'].map(route => ({ ...row, route }))))(
    'parks a Codex $route resume when home repair is incomplete ($reason)',
    async ({ repairResult, reason, error, route }) => {
      const advSessionId = 1002;
      const home = codexHomeForAdvSession(advSessionId);
      const nativeId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const spawnDetached = vi.fn(() => 4321);
      const claimResume = vi.fn(async () => true);
      const repair = vi.fn(async () => {
        if (error) throw new Error(error);
        return repairResult;
      });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      rmSync(home, { recursive: true, force: true });
      const sessionsDir = join(home, 'sessions', '2026', '10', '06');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, `rollout-2026-10-06T18-00-00-${nativeId}.jsonl`), '{}');
      try {
        const out = await executeWake(
          work({
            subscriberId: 'su-codex-route',
            wakeHandle: advHandle({ agent: 'codex', sessionId: nativeId, advSessionId }),
          }),
          deps({
            alive: vi.fn(() => false),
            getSession: vi.fn(async () =>
              session({
                id: advSessionId,
                agent: 'codex',
                sessionId: nativeId,
                coordOwnerId: 'su-codex-route',
                launchArgv: ['psu', '--no-picker', '--agent=codex', '--headless',
                  `--account=${route === 'pin' ? 'original-account' : route}`],
              }),
            ) as never,
            claimResume,
            ensureCodexHomeForWake: repair as never,
            spawnDetached,
          }),
        );

        expect(out).toEqual({
          kind: 'park',
          reason: expect.stringContaining(`Codex ${route} home repair did not complete (${reason})`),
        });
        expect(repair).toHaveBeenCalledWith(
          expect.objectContaining({
            advSessionId,
            owner: 'su-codex-route',
            codexHome: home,
            headless: true,
            requireGatewayProvider: route === 'auto',
            codexGatewayAccountId: route === 'pin' ? 'original-account' : null,
          }),
        );
        expect(claimResume).not.toHaveBeenCalled();
        expect(spawnDetached).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it('codexWakeGatewayInputs maps every account mode like the psu launcher route', () => {
    expect(codexWakeGatewayInputs(wakeAccountRouteFromArgv(['--account=auto'], 'su-x'))).toEqual({
      requireGatewayProvider: true,
      codexGatewayAccountId: null,
    });
    expect(codexWakeGatewayInputs(wakeAccountRouteFromArgv(['--account=gateway'], 'su-x'))).toEqual({
      requireGatewayProvider: true,
      codexGatewayAccountId: null,
    });
    expect(codexWakeGatewayInputs(wakeAccountRouteFromArgv(['--account=acct-1'], 'su-x'))).toEqual({
      requireGatewayProvider: false,
      codexGatewayAccountId: 'acct-1',
    });
    expect(codexWakeGatewayInputs(wakeAccountRouteFromArgv(['--account=system'], 'su-x'))).toEqual({
      requireGatewayProvider: false,
      codexGatewayAccountId: null,
    });
    expect(codexWakeGatewayInputs(null)).toEqual({ requireGatewayProvider: false, codexGatewayAccountId: null });
  });

  it('a session row marked ended is exited even if the recorded pid is reused-alive', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () => session({ endedAt: new Date().toISOString() })) as never,
        alive: vi.fn(() => true), // pid reused by some other process
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
  });

  it('exited claude WITHOUT a native id + live presence → park, never --continue', async () => {
    const spawnManagedPty = vi.fn(() => ({ id: 'x' }));
    const out = await executeWake(
      work({ wakeHandle: advHandle({ sessionId: null }) }),
      deps({
        getSession: vi.fn(async () => session({ sessionId: null })) as never,
        alive: vi.fn(() => false),
        spawnManagedPty: spawnManagedPty as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect(spawnManagedPty).not.toHaveBeenCalled();
  });

  it('exited omp → detached headless one-turn resume with prompt (no PTY)', async () => {
    const spawnDetached = vi.fn(() => 2468);
    const spawnManagedPty = vi.fn(() => fakeOmpPty());
    const out = await executeWake(
      work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' }) }),
      deps({
        getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' })) as never,
        alive: vi.fn(() => false),
        spawnManagedPty: spawnManagedPty as never,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(spawnManagedPty).not.toHaveBeenCalled();
    const [bin, args, o] = spawnDetached.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(bin).toBe('omp');
    expect(args.slice(0, 4)).toEqual(['-r', 'th-1', '--approval-mode', 'yolo']);
    expect(args).toContain('-p');
    expect(args[args.length - 1]).toContain('lock:grant:t-1');
    expect(o.env.PAPERCUSP_SID).toBe('su-abc');
    // Regression: the autonomous resume turn MUST carry the bee's workspace so
    // omp's user-level MCP (x-papercusp-workspace from `${PAPERCUSP_WORKSPACE:-}`)
    // resolves a concrete workspace. Without it the clamp rejects the session
    // and EVERY coord:* tool 404s ("Tool coord:orient not found").
    expect(o.env.PAPERCUSP_WORKSPACE).toBe('ws');
  });

  it('exited omp rematerializes an archived thread before resuming when its transcript is missing', async () => {
    const spawnDetached = vi.fn(() => 2468);
    const calls: string[] = [];
    let collectCount = 0;
    const collectSessionFiles = vi.fn(async () => {
      calls.push('collect');
      return collectCount++ === 0 ? [] : [{}];
    });
    const rematerializeSession = vi.fn(async () => {
      calls.push('rematerialize');
      return { ok: true, written: 1 };
    });
    const threadId = 'th-archived';
    const out = await executeWake(
      work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: threadId }) }),
      deps({
        getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: threadId })) as never,
        alive: vi.fn(() => false),
        collectSessionFiles: collectSessionFiles as never,
        rematerializeSession: rematerializeSession as never,
        spawnDetached: vi.fn(() => {
          calls.push('spawn');
          return spawnDetached();
        }),
      }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(collectSessionFiles).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: 'omp', sessionId: threadId }),
    );
    expect(rematerializeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: 'omp', sessionId: threadId }),
    );
    expect(calls).toEqual(['collect', 'rematerialize', 'collect', 'spawn']);
  });

  it('R4 (P-004): claude headless resume prompt carries the crash-resume advisory AFTER the wake text', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ alive: vi.fn(() => false), spawnDetached }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    const [, args] = spawnDetached.mock.calls[0] as unknown as [string, string[]];
    const prompt = args[args.length - 1];
    expect(prompt).toContain(CRASH_RESUME_ADVISORY_MARKER);
    // Appended AFTER the original wake text — the base text stays a byte-identical prefix.
    expect(prompt.indexOf('lock:grant:t-1')).toBeGreaterThan(-1);
    expect(prompt.indexOf(CRASH_RESUME_ADVISORY_MARKER)).toBeGreaterThan(prompt.indexOf('lock:grant:t-1'));
  });

  it('R4 (P-004): omp headless resume `-p` text carries the crash-resume advisory too', async () => {
    const spawnDetached = vi.fn(() => 2468);
    const out = await executeWake(
      work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' }) }),
      deps({
        getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' })) as never,
        alive: vi.fn(() => false),
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    const [, args] = spawnDetached.mock.calls[0] as unknown as [string, string[]];
    expect(args[args.length - 1]).toContain(CRASH_RESUME_ADVISORY_MARKER);
  });

  it('R4 (P-004): in-place pty inject stays byte-identical — NO advisory (the process did not die)', async () => {
    const write = vi.fn(() => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ findPty: vi.fn(() => ({ id: 'pty-7' })) as never, write: write as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    const [, buf] = write.mock.calls[0] as unknown as [string, Buffer];
    expect(buf.toString()).toContain('lock:grant:t-1');
    expect(buf.toString()).not.toContain(CRASH_RESUME_ADVISORY_MARKER);
  });

  it('R4 (P-004): in-place psu-host socket inject stays byte-identical — NO advisory', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'delivered' });
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { data: string }];
    expect(msg.data).toContain('lock:grant:t-1');
    expect(msg.data).not.toContain(CRASH_RESUME_ADVISORY_MARKER);
  });

  it('exited omp with no transcript after archive recovery → inbox fallback, never a doomed resume', async () => {
    const spawnDetached = vi.fn(() => 2468);
    const collectSessionFiles = vi.fn(async () => []);
    const rematerializeSession = vi.fn(async () => ({ ok: false, reason: 'not_archived' as const, written: 0, skippedExisting: 0, conflicts: [] }));
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const threadId = 'th-missing';
    const out = await executeWake(
      work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: threadId }) }),
      deps({
        getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: threadId })) as never,
        alive: vi.fn(() => false),
        presence: vi.fn(async () => stalePresence) as never,
        collectSessionFiles: collectSessionFiles as never,
        rematerializeSession: rematerializeSession as never,
        sendCoordMessage: sendCoordMessage as never,
        spawnDetached,
      }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(collectSessionFiles).toHaveBeenCalledTimes(2);
    expect(rematerializeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: 'omp', sessionId: threadId, targetRoot: expect.any(String) }),
    );
    expect(sendCoordMessage).toHaveBeenCalled();
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('exited omp PTY fallback → readiness-gated prompt injection into the new pty', async () => {
    const prev = process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
    process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = '1';
    const write = vi.fn(() => true);
    const pty = fakeOmpPty();
    const spawnManagedPty = vi.fn(() => pty);
    try {
      const pending = executeWake(
        work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' }) }),
        deps({
          getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' })) as never,
          alive: vi.fn(() => false),
          spawnManagedPty: spawnManagedPty as never,
          write: write as never,
        }),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(write).not.toHaveBeenCalled();
      for (const cb of pty.onData) cb(Buffer.from('OMP ready\n> '));
      // Audit P-034: the prompt must land as TWO writes — text, then the submit
      // CR as a separate keystroke after a settle. The old single text+CR buffer
      // tripped the TUI paste detector (CR → literal newline, turn never submits).
      await vi.advanceTimersByTimeAsync(1);
      expect(write).toHaveBeenCalledTimes(1);
      const [ptyId, textBuf] = write.mock.calls[0] as unknown as [string, Buffer];
      expect(ptyId).toBe('pty-omp');
      expect(textBuf.toString()).not.toMatch(/\r$/);
      await vi.advanceTimersByTimeAsync(400);
      expect(write).toHaveBeenCalledTimes(2);
      expect((write.mock.calls[1] as unknown as [string, Buffer])[1].toString()).toBe('\r');
      await expect(pending).resolves.toEqual({ kind: 'delivered', channel: 'resume' });
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
      else process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = prev;
    }
  });

  it('exited omp PTY fallback readiness timeout → error with transcript tail and pty cleanup', async () => {
    const prev = process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
    process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = '1';
    const write = vi.fn(() => true);
    const pty = fakeOmpPty();
    const kill = vi.fn(() => true);
    try {
      const pending = executeWake(
        work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' }) }),
        deps({
          getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' })) as never,
          alive: vi.fn(() => false),
          spawnManagedPty: vi.fn(() => pty) as never,
          write: write as never,
          kill: kill as never,
        }),
      );
      for (const cb of pty.onData) cb(Buffer.from('loading account router'));
      await vi.advanceTimersByTimeAsync(16_000);
      await expect(pending).resolves.toMatchObject({
        kind: 'error',
        error: expect.stringContaining('did not become ready'),
      });
      expect(write).not.toHaveBeenCalled();
      expect(kill).toHaveBeenCalledWith('pty-omp', testPtyAccessScope);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
      else process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = prev;
    }
  });

  it('omp prompt helper accepts a quiet settled screen and captures transcript tail', async () => {
    const write = vi.fn(() => true);
    const pty = fakeOmpPty('pty-helper');
    const pending = injectOmpWakeTurnWhenReady({
      pty,
      wakeText: 'WAKE',
      write: write as never,
      readyTimeoutMs: 1_000,
      quietReadyMs: 100,
      submitCrDelayMs: 25,
    });
    for (const cb of pty.onData) cb(Buffer.from('restored thread th-1\n'));
    await vi.advanceTimersByTimeAsync(100);
    expect(write).toHaveBeenCalledWith('pty-helper', Buffer.from('WAKE', 'utf8'), testPtyAccessScope);
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toEqual({ ok: true, transcriptTail: 'restored thread th-1\n' });
    expect(write).toHaveBeenLastCalledWith('pty-helper', Buffer.from('\r', 'utf8'), testPtyAccessScope);
  });

  it('NO recorded pid + fresh presence → park (never concurrent-resume a live session)', async () => {
    const spawnManagedPty = vi.fn(() => ({ id: 'x' }));
    const resolveMemberLiveness = vi.fn();
    const out = await executeWake(
      work({ wakeHandle: advHandle({ pid: null }) }),
      deps({
        getSession: vi.fn(async () => session({ pid: null })) as never,
        spawnManagedPty: spawnManagedPty as never,
        resolveMemberLiveness: resolveMemberLiveness as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect(spawnManagedPty).not.toHaveBeenCalled();
    expect(resolveMemberLiveness).not.toHaveBeenCalled();
  });

  it('NO recorded pid + fresh presence + armed loop + parked verdict → resume', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const resolveMemberLiveness = parkedMemberLiveness();
    const isLoopArmed = vi.fn(async () => true);
    const out = await executeWake(
      work({
        wakeHandle: advHandle({ pid: null }),
        payload: { carry: 'warm', wakeCount: 1, harness: 'papercusp' },
      }),
      deps({
        getSession: vi.fn(async () => session({ pid: null })) as never,
        spawnDetached,
        isLoopArmed,
        resolveMemberLiveness: resolveMemberLiveness as never,
      }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(spawnDetached).toHaveBeenCalled();
    expect(isLoopArmed).toHaveBeenCalledWith('su-abc');
    expect(resolveMemberLiveness).toHaveBeenCalledWith(
      [{ ownerId: 'su-abc' }],
      { hydratePerId: true },
    );
  });

  it('NO recorded pid + fresh presence + inactive loop → park without resolving liveness', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const resolveMemberLiveness = vi.fn();
    const isLoopArmed = vi.fn(async () => false);
    const out = await executeWake(
      work({
        wakeHandle: advHandle({ pid: null }),
        payload: { carry: 'warm', wakeCount: 1, harness: 'papercusp' },
      }),
      deps({
        getSession: vi.fn(async () => session({ pid: null })) as never,
        spawnDetached,
        isLoopArmed,
        resolveMemberLiveness: resolveMemberLiveness as never,
      }),
    );

    expect(out).toMatchObject({ kind: 'park' });
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(resolveMemberLiveness).not.toHaveBeenCalled();
  });

  it.each(['live', 'suspect', 'draining', 'ended', 'unknown', null])(
    'NO recorded pid + fresh presence + armed loop + %s verdict → park',
    async (sessionState) => {
      const spawnDetached = vi.fn(() => 4321);
      const resolveMemberLiveness = vi.fn(async () => new Map([
        ['su-abc', {
          ownerId: 'su-abc',
          sessionState,
          wakeable: false,
          liveTurn: false,
          confirmLiveness: null,
          heartbeatFresh: true,
        } as never],
      ]));
      const out = await executeWake(
        work({
          wakeHandle: advHandle({ pid: null }),
          payload: { carry: 'warm', wakeCount: 1, harness: 'papercusp' },
        }),
        deps({
          getSession: vi.fn(async () => session({ pid: null })) as never,
          spawnDetached,
          isLoopArmed: vi.fn(async () => true),
          resolveMemberLiveness: resolveMemberLiveness as never,
        }),
      );

      expect(out).toMatchObject({ kind: 'park' });
      expect(spawnDetached).not.toHaveBeenCalled();
      expect(resolveMemberLiveness).toHaveBeenCalledTimes(1);
    },
  );

  it('NO recorded pid + fresh presence + liveness resolver error → park', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spawnDetached = vi.fn(() => 4321);
    try {
      const out = await executeWake(
        work({
          wakeHandle: advHandle({ pid: null }),
          payload: { carry: 'warm', wakeCount: 1, harness: 'papercusp' },
        }),
        deps({
          getSession: vi.fn(async () => session({ pid: null })) as never,
          spawnDetached,
          isLoopArmed: vi.fn(async () => true),
          resolveMemberLiveness: vi.fn(async () => { throw new Error('resolver unavailable'); }) as never,
        }),
      );

      expect(out).toMatchObject({ kind: 'park' });
      expect(spawnDetached).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('session liveness/su-abc failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('loop wake with ended liveness stays parked at the Channel 2 boundary', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const resolveMemberLiveness = vi.fn(async () => new Map([
      ['su-abc', {
        ownerId: 'su-abc',
        sessionState: 'ended',
        wakeable: false,
        liveTurn: false,
        confirmLiveness: null,
        heartbeatFresh: false,
      } as never],
    ]));
    const out = await executeWake(
      work({
        wakeHandle: advHandle(),
        payload: { carry: 'warm', wakeCount: 1, harness: 'papercusp' },
      }),
      deps({
        alive: vi.fn(() => false),
        spawnDetached,
        isLoopArmed: vi.fn(async () => true),
        resolveMemberLiveness: resolveMemberLiveness as never,
      }),
    );

    expect(out).toMatchObject({ kind: 'park' });
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(resolveMemberLiveness).toHaveBeenCalledTimes(1);
  });

  it('NO recorded pid + fresh presence + liveness resolver timeout → park', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spawnDetached = vi.fn(() => 4321);
    try {
      const pending = executeWake(
        work({
          wakeHandle: advHandle({ pid: null }),
          payload: { carry: 'warm', wakeCount: 1, harness: 'papercusp' },
        }),
        deps({
          getSession: vi.fn(async () => session({ pid: null })) as never,
          spawnDetached,
          isLoopArmed: vi.fn(async () => true),
          resolveMemberLiveness: vi.fn(() => new Promise(() => undefined)) as never,
        }),
      );
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toMatchObject({ kind: 'park' });
      expect(spawnDetached).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('session liveness/su-abc timed out'));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('NO recorded pid + stale presence → resume (the session is gone)', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle({ pid: null }) }),
      deps({
        getSession: vi.fn(async () => session({ pid: null })) as never,
        presence: vi.fn(async () => stalePresence) as never,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
  });

  it('rebinds a dead captured wake handle to the latest owner session instead of resuming its predecessor', async () => {
    const predecessor = session({
      id: 42,
      endedAt: '2026-10-08T21:09:00.000Z',
      pid: 9999,
      startedAt: '2026-10-08T20:00:00.000Z',
    });
    const successor = session({
      id: 43,
      pid: 8888,
      sessionId: 'successor-native-session',
      startedAt: '2026-10-08T21:10:00.000Z',
    });
    const getSession = vi.fn(async (id: number) => (id === 42 ? predecessor : successor));
    const getLatestSessionForOwner = vi.fn(async () => successor);
    const getSessionInWorkspace = vi.fn(async (id: number, workspaceId: string) =>
      id === successor.id && workspaceId === successor.workspaceId ? successor : null,
    );
    const claimResume = vi.fn(async () => true);
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle({ advSessionId: predecessor.id }) }),
      deps({
        getSession: getSession as never,
        getLatestSessionForOwner: getLatestSessionForOwner as never,
        getSessionInWorkspace: getSessionInWorkspace as never,
        alive: vi.fn((pid: number | null) => pid === successor.pid),
        findPsuHost: vi.fn(() => null) as never,
        findPty: vi.fn(() => null) as never,
        claimResume,
        spawnDetached,
      }),
    );

    expect(getLatestSessionForOwner).toHaveBeenCalledWith('su-abc');
    expect(getSession).toHaveBeenNthCalledWith(1, predecessor.id);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSessionInWorkspace).toHaveBeenCalledWith(successor.id, successor.workspaceId);
    expect(out).toMatchObject({ kind: 'park' });
    expect(claimResume).not.toHaveBeenCalled();
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('re-reads the same elected owner session in its tenant when the pump ambient workspace misses it', async () => {
    const current = session({ workspaceId: 'tenant-ws', pid: 8888 });
    const getSession = vi.fn(async () => null);
    const getLatestSessionForOwner = vi.fn(async () => current);
    const getSessionInWorkspace = vi.fn(async (id: number, workspaceId: string) =>
      id === current.id && workspaceId === current.workspaceId ? current : null,
    );
    const injectPsuHost = vi.fn(async () => true);

    const out = await executeWake(
      work({ workspaceId: DEFAULT_COORD_WORKSPACE, wakeHandle: advHandle({ pid: 9999 }) }),
      deps({
        getSession: getSession as never,
        getLatestSessionForOwner: getLatestSessionForOwner as never,
        getSessionInWorkspace: getSessionInWorkspace as never,
        alive: vi.fn((pid: number | null) => pid === current.pid),
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/su-abc.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
      }),
    );

    expect(getSession).toHaveBeenCalledWith(current.id);
    expect(getLatestSessionForOwner).toHaveBeenCalledWith('su-abc');
    expect(getSessionInWorkspace).toHaveBeenCalledWith(current.id, 'tenant-ws');
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(injectPsuHost).toHaveBeenCalledTimes(1);
  });

  it('lets the bounded owner-session fallback finish after the primary acquisition deadline', async () => {
    vi.useFakeTimers();
    try {
      const current = session({ workspaceId: 'tenant-ws', pid: 8888 });
      const getSession = vi.fn(async () => null);
      const getLatestSessionForOwner = vi.fn(
        () => new Promise((resolve) => setTimeout(() => resolve(current), 15_000)),
      );
      const getSessionInWorkspace = vi.fn(async (id: number, workspaceId: string) =>
        id === current.id && workspaceId === current.workspaceId ? current : null,
      );
      const injectPsuHost = vi.fn(async () => true);
      const pending = executeWake(
        work({ workspaceId: DEFAULT_COORD_WORKSPACE, wakeHandle: advHandle({ pid: 9999 }) }),
        deps({
          getSession: getSession as never,
          getLatestSessionForOwner: getLatestSessionForOwner as never,
          getSessionInWorkspace: getSessionInWorkspace as never,
          alive: vi.fn((pid: number | null) => pid === current.pid),
          findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/su-abc.sock' })) as never,
          injectPsuHost: injectPsuHost as never,
        }),
      );

      await vi.advanceTimersByTimeAsync(15_000);

      await expect(pending).resolves.toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
      expect(getLatestSessionForOwner).toHaveBeenCalledWith('su-abc');
      expect(getSessionInWorkspace).toHaveBeenCalledWith(current.id, 'tenant-ws');
      expect(injectPsuHost).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('parks a captured adv-session whose owner differs from the wake subscriber before any side effect', async () => {
    const foreignOwner = 'su-foreign-session';
    const getSession = vi.fn(async () => session({ coordOwnerId: foreignOwner }));
    const findPsuHost = vi.fn(async () => ({ sock: '/tmp/foreign.sock', ownerId: foreignOwner }));
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ subscriberId: 'su-abc', wakeHandle: advHandle() }),
      deps({
        getSession: getSession as never,
        findPsuHost: findPsuHost as never,
        spawnDetached,
      }),
    );

    expect(out).toEqual({
      kind: 'park',
      reason:
        'captured adv-session #42 belongs to su-foreign-session, not wake subscriber su-abc; ' +
        'parked before wake injection or resume (EI-26532418294401270)',
    });
    expect(findPsuHost).not.toHaveBeenCalled();
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('claude resume spawn failure (detached returns no pid) → error outcome (the pump retries with backoff)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        alive: vi.fn(() => false),
        spawnDetached: vi.fn(() => null) as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'error' });
  });
});

describe('GAP 3: wake resume env-assembly matrix (wake-executor.ts:441-474)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('claude resume with a coord owner + on-disk config dir → CLAUDE_CONFIG_DIR + MCP_TIMEOUT + PAPERCUSP_AGENT_SESSION + fleet token', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    const claudeRoot = mkdtempSync(pjoin(tmpdir(), 'wake-claude-cfg-'));
    const tokenDir = mkdtempSync(pjoin(tmpdir(), 'wake-claude-token-'));
    const prevCfg = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
    const prevTok = process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
    process.env.PAPERCUSP_SESSION_CLAUDE_DIR = claudeRoot;
    process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = pjoin(tokenDir, 'claude-token');
    try {
      // The persistent per-session config dir the resume leg remounts (D-010).
      mkdirSync(pjoin(claudeRoot, 'su-owner-9'), { recursive: true });
      // A minted fleet setup-token so CLAUDE_CODE_OAUTH_TOKEN is exported (P-003).
      writeFileSync(pjoin(tokenDir, 'claude-token'), 'sk-ant-oat01-test-token\n');

      const spawnDetached = vi.fn(() => 4321);
      const out = await executeWake(
        work({ subscriberId: 'su-owner-9', wakeHandle: advHandle() }),
        deps({
          alive: vi.fn(() => false), // exited → resume
          getSession: vi.fn(async () => session({ agent: 'claude', coordOwnerId: 'su-owner-9' })) as never,
          spawnDetached,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      const [, , o] = spawnDetached.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
      // Base wake env (always present on a resume).
      expect(o.env.PAPERCUSP_SID).toBe('su-owner-9');
      expect(o.env.PAPERCUSP_AGENT_SESSION).toBe('1');
      expect(o.env.MCP_TIMEOUT).toBeTruthy();
      expect(o.env.PAPERCUSP_WAKE_DELIVERY_ID).toBe('7');
      // claude-specific: config-dir remount + fleet token.
      expect(o.env.CLAUDE_CONFIG_DIR).toBe(pjoin(claudeRoot, 'su-owner-9'));
      expect(o.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test-token');
      // No codex home leaks onto a claude resume.
      expect(o.env.CODEX_HOME).toBeUndefined();
    } finally {
      if (prevCfg === undefined) delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
      else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = prevCfg;
      if (prevTok === undefined) delete process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
      else process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = prevTok;
      rmSync(claudeRoot, { recursive: true, force: true });
      rmSync(tokenDir, { recursive: true, force: true });
    }
  });

  it('EI-24890753013901545 removes missing native references before replay and restores Papercusp refs in the resume seed', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    const claudeRoot = mkdtempSync(pjoin(tmpdir(), 'wake-claude-native-reference-'));
    const ownerId = 'su-native-reference';
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const transcriptPath = pjoin(claudeRoot, ownerId, 'projects', '-repo', `${sessionId}.jsonl`);
    const prevCfg = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
    const prevTools = process.env.PAPERCUSP_TOOLS;
    const prevToken = process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
    process.env.PAPERCUSP_SESSION_CLAUDE_DIR = claudeRoot;
    process.env.PAPERCUSP_TOOLS = 'tools:find,coord:orient';
    process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = pjoin(claudeRoot, 'missing-token');
    mkdirSync(pjoin(claudeRoot, ownerId, 'projects', '-repo'), { recursive: true });
    writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_search_tool_result',
          tool_use_id: 'search-1',
          content: {
            type: 'tool_search_tool_search_result',
            tool_references: [
              { type: 'tool_reference', tool_name: 'ExitPlanMode' },
              { type: 'tool_reference', tool_name: 'mcp__papercusp-su__plans_audit' },
            ],
          },
        }],
      },
    }));
    let transcriptAtSpawn = '';
    const spawnDetached = vi.fn(() => {
      transcriptAtSpawn = readFileSync(transcriptPath, 'utf8');
      return 4321;
    });
    try {
      const out = await executeWake(
        work({ subscriberId: ownerId, wakeHandle: advHandle({ sessionId }) }),
        deps({
          alive: vi.fn(() => false),
          getSession: vi.fn(async () => session({ agent: 'claude', coordOwnerId: ownerId, sessionId })) as never,
          collectSessionFiles: vi.fn(async () => [{
            rel: `projects/-repo/${sessionId}.jsonl`,
            abs: transcriptPath,
            bytes: 1,
            mtimeMs: 1,
          }]) as never,
          spawnDetached,
        }),
      );

      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      expect(spawnDetached).toHaveBeenCalledTimes(1);
      expect(transcriptAtSpawn).not.toContain('ExitPlanMode');
      expect(transcriptAtSpawn).toContain('mcp__papercusp-su__plans_audit');
      expect(transcriptAtSpawn).toContain('"tool_reference"');
      const [, , opts] = spawnDetached.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
      expect(opts.env.PAPERCUSP_TOOLS).toContain('mcp__papercusp-su__plans_audit');
    } finally {
      if (prevCfg === undefined) delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
      else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = prevCfg;
      if (prevTools === undefined) delete process.env.PAPERCUSP_TOOLS;
      else process.env.PAPERCUSP_TOOLS = prevTools;
      if (prevToken === undefined) delete process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
      else process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = prevToken;
      rmSync(claudeRoot, { recursive: true, force: true });
    }
  });

  it('WI-10005900: claude resume clamps the effort inherited from the isolated settings.json the CHILD will read', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    const claudeRoot = mkdtempSync(pjoin(tmpdir(), 'wake-claude-effort-'));
    const prevCfg = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
    const prevModel = process.env.ANTHROPIC_MODEL;
    process.env.PAPERCUSP_SESSION_CLAUDE_DIR = claudeRoot;
    // The child would honour ANTHROPIC_MODEL over settings.model; keep the
    // runner's own value out of this fixture.
    delete process.env.ANTHROPIC_MODEL;
    try {
      // The per-session settings Claude Code wrote while Opus 5 offered xhigh.
      const cfgDir = pjoin(claudeRoot, 'su-owner-9');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(pjoin(cfgDir, 'settings.json'), JSON.stringify({ model: 'opus[1m]', effortLevel: 'xhigh' }));

      const read = vi.fn((env: Record<string, string | undefined>) => realReadClaudeLaunchSettings(env));
      const spawnDetached = vi.fn(() => 4321);
      const out = await executeWake(
        work({ subscriberId: 'su-owner-9', wakeHandle: advHandle() }),
        deps({
          alive: vi.fn(() => false), // exited → resume
          getSession: vi.fn(async () => session({ agent: 'claude', coordOwnerId: 'su-owner-9' })) as never,
          readClaudeLaunchSettings: read,
          spawnDetached,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      // Read with the child's env (its isolated config dir), not the operator's.
      expect(read).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0][0].CLAUDE_CONFIG_DIR).toBe(cfgDir);
      const [bin, args] = spawnDetached.mock.calls[0] as unknown as [string, string[]];
      expect(bin).toBe('claude');
      const at = args.indexOf('--effort');
      expect(at).toBeGreaterThan(-1);
      expect(args[at + 1]).toBe('max');
      expect(at).toBeLessThan(args.indexOf('--resume'));
      // The wake text stays the positional last arg.
      expect(args[args.length - 1]).not.toBe('max');
      expect(args.filter((a) => a === '--effort')).toHaveLength(1);
    } finally {
      if (prevCfg === undefined) delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
      else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = prevCfg;
      if (prevModel !== undefined) process.env.ANTHROPIC_MODEL = prevModel;
      rmSync(claudeRoot, { recursive: true, force: true });
    }
  });

  it('WI-10005900: claude resume argv is unchanged when the inherited effort is supported or absent', async () => {
    for (const settings of [null, { model: 'opus[1m]', effortLevel: 'high' }, { model: 'opus', effortLevel: 'max' }]) {
      const spawnDetached = vi.fn(() => 4321);
      const out = await executeWake(
        work({ wakeHandle: advHandle() }),
        deps({
          alive: vi.fn(() => false),
          getSession: vi.fn(async () => session({ agent: 'claude' })) as never,
          readClaudeLaunchSettings: vi.fn(() => settings),
          spawnDetached,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      const [, args] = spawnDetached.mock.calls[0] as unknown as [string, string[]];
      expect(args.some((a) => a === '--effort' || a.startsWith('--effort='))).toBe(false);
    }
  });

  it('codex resume → CODEX_HOME present, but CLAUDE_CONFIG_DIR + CLAUDE_CODE_OAUTH_TOKEN ABSENT (no claude env leaks)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    // Point the claude config root + token at tmp roots WITHOUT provisioning this
    // owner's subdir/token — so even though coordOwnerId is set, neither claude
    // env is applied (the fleet token is claude-only; CLAUDE_CONFIG_DIR needs the
    // dir on disk). Hermetic: never reads the real ~/.papercusp.
    const claudeRoot = mkdtempSync(pjoin(tmpdir(), 'wake-codex-noclaude-'));
    const tokenDir = mkdtempSync(pjoin(tmpdir(), 'wake-codex-notoken-'));
    const prevCfg = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
    const prevTok = process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
    process.env.PAPERCUSP_SESSION_CLAUDE_DIR = claudeRoot;
    process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = pjoin(tokenDir, 'absent-token');
    // A claude token exists on disk — proving codex STILL doesn't pick it up.
    writeFileSync(pjoin(tokenDir, 'absent-token'), 'sk-ant-oat01-should-not-be-used\n');
    try {
      const spawnDetached = vi.fn(() => 5555);
      const out = await executeWake(
        // adv-session 42 has a codex home on disk (the suite fixture) → uuid recovered.
        work({ subscriberId: 'su-owner-9', wakeHandle: advHandle({ agent: 'codex', sessionId: null }) }),
        deps({
          alive: vi.fn(() => false),
          // coordOwnerId set to prove it does NOT pull a claude config dir for codex.
          getSession: vi.fn(async () =>
            session({ agent: 'codex', sessionId: null, coordOwnerId: 'su-owner-9' }),
          ) as never,
          spawnDetached,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      const [bin, , o] = spawnDetached.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
      expect(bin).toBe('codex');
      // codex-specific: its per-session home is exported.
      expect(o.env.CODEX_HOME).toBe(join(CODEX_HOMES_DIR, 'session-42'));
      // The claude-only env is NOT applied to a codex resume (the fleet token is a
      // claude-OAuth concept, keyed off `resumeAgent==='claude'`; CLAUDE_CONFIG_DIR
      // needs the owner's dir on disk, which we deliberately did NOT create).
      expect(o.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(o.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      // Base wake env still present.
      expect(o.env.PAPERCUSP_AGENT_SESSION).toBe('1');
      expect(o.env.MCP_TIMEOUT).toBeTruthy();
    } finally {
      if (prevCfg === undefined) delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
      else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = prevCfg;
      if (prevTok === undefined) delete process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
      else process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = prevTok;
      rmSync(claudeRoot, { recursive: true, force: true });
      rmSync(tokenDir, { recursive: true, force: true });
    }
  });

  it('parks before claiming or spawning when Codex reports an active native thread writer', async () => {
    const observeFallback = vi.fn();
    const codexThreadWriterHolder = vi.fn(() => ({
      held: true,
      pid: 12345,
      lockPath: join(CODEX_HOMES_DIR, 'session-42', 'thread-writer-locks', `${ROLLOUT_UUID}.lock`),
      sessionId: ROLLOUT_UUID,
      reason: 'held',
    }));
    const claimResume = vi.fn(async () => true);
    const spawnDetached = vi.fn(() => 5555);
    const out = await executeWake(
      work({ subscriberId: 'su-owner-9', wakeHandle: advHandle({ agent: 'codex', sessionId: null }) }),
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ agent: 'codex', sessionId: null, coordOwnerId: 'su-owner-9' })) as never,
        codexThreadWriterHolder,
        observeFallback,
        claimResume,
        spawnDetached,
      }),
    );

    expect(out).toMatchObject({
      kind: 'park',
      reason: `Codex thread ${ROLLOUT_UUID} already has an active writer (pid 12345); parked before resume claim/spawn`,
    });
    expect(codexThreadWriterHolder).toHaveBeenCalledWith(join(CODEX_HOMES_DIR, 'session-42'), ROLLOUT_UUID);
    expect(claimResume).not.toHaveBeenCalled();
    expect(observeFallback).toHaveBeenCalledWith('routine-capability-read', {
      eligible: 1, applied: 1, reason: 'applied', scope: 'wake-codex-writer-lock',
    }, { workspaceId: expect.any(String) });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('fails open and resumes when the Codex writer-lock probe cannot read the lock state', async () => {
    const observeFallback = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const codexThreadWriterHolder = vi.fn(() => {
      throw new Error('ENOENT: /proc/locks');
    });
    const spawnDetached = vi.fn(() => 5555);
    const out = await executeWake(
      work({ subscriberId: 'su-owner-9', wakeHandle: advHandle({ agent: 'codex', sessionId: null }) }),
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ agent: 'codex', sessionId: null, coordOwnerId: 'su-owner-9' })) as never,
        codexThreadWriterHolder,
        observeFallback,
        spawnDetached,
      }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(codexThreadWriterHolder).toHaveBeenCalledTimes(1);
    expect(observeFallback).toHaveBeenCalledWith('routine-capability-read', {
      eligible: 1, applied: 0, reason: 'writer-lock-probe-failed', scope: 'wake-codex-writer-lock',
    }, { workspaceId: expect.any(String) });
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('writer-lock probe failed open'));
  });
});

describe('hive Queen fresh-per-wake cutover (queen-brief-cache-assembly B-01 / P-012)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hiveSession = (over: Record<string, unknown> = {}) => session({ label: 'pot · papercup/queen', ...over });

  it('exited hive operator → FRESH hive launch (never claude --resume), carrying the wake text as kickoff', async () => {
    const fireHiveWake = vi.fn(async () => true);
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () => hiveSession()) as never,
        alive: vi.fn(() => false), // turn ended → would otherwise resume
        fireHiveWake,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'hive-fresh-wake' });
    // The Queen is fresh-launched, NEVER resumed.
    expect(spawnDetached).not.toHaveBeenCalled();
    const arg = (fireHiveWake.mock.calls[0] as unknown as [{ installSlug: string; kickoff: string }])[0];
    expect(arg.installSlug).toBe('papercup');
    expect(arg.kickoff).toContain('lock:grant:t-1'); // the wake turn text
  });

  it('hive operator + fresh-wake fire FAILS → park, NEVER a --resume fallback (the no-resume invariant is absolute)', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () => hiveSession()) as never,
        alive: vi.fn(() => false),
        fireHiveWake: vi.fn(async () => false) as never, // fire failed
        spawnDetached,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect((out as { reason: string }).reason).toContain('never resumed');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('LIVE hive operator (mid-turn, not an injectable pty) → park, no concurrent fresh launch', async () => {
    // Reached BEFORE the resume/fresh-wake branch (the isAlive guard), so a live
    // Queen is never double-launched.
    const fireHiveWake = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ getSession: vi.fn(async () => hiveSession()) as never, alive: vi.fn(() => true), fireHiveWake }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect(fireHiveWake).not.toHaveBeenCalled();
  });

  it('a NON-hive ended session (no hive label) still resumes — the cutover is scoped to hive operators only', async () => {
    const fireHiveWake = vi.fn(async () => true);
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ alive: vi.fn(() => false), fireHiveWake, spawnDetached }), // session() label is null
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(fireHiveWake).not.toHaveBeenCalled();
    expect(spawnDetached).toHaveBeenCalled();
  });
});

describe('hiveInstallSlugFromLabel', () => {
  it('parses the install slug from a pot-operator adv_sessions label', () => {
    expect(hiveInstallSlugFromLabel('pot · papercup/queen')).toBe('papercup');
    expect(hiveInstallSlugFromLabel('pot · my-hive/operator')).toBe('my-hive');
  });
  it('returns null for a non-pot label (so non-pot sessions resume as before)', () => {
    expect(hiveInstallSlugFromLabel(null)).toBeNull();
    expect(hiveInstallSlugFromLabel('')).toBeNull();
    expect(hiveInstallSlugFromLabel('bee · papercup/worker')).toBeNull();
    expect(hiveInstallSlugFromLabel('hive · papercup/queen')).toBeNull(); // WI-3967: stale prefix, no longer matches
    expect(hiveInstallSlugFromLabel('pot · ')).toBeNull(); // no slug
  });
});

describe('codex home + rollout recovery (P-009/P-010)', () => {
  it('codexHomeForAdvSession keys the home by the adv-session id', () => {
    expect(codexHomeForAdvSession(42)).toBe(join(CODEX_HOMES_DIR, 'session-42'));
  });

  it('findCodexRolloutSessionId returns the NEWEST rollout uuid; null when absent', () => {
    expect(findCodexRolloutSessionId(join(CODEX_HOMES_DIR, 'session-42'))).toBe(ROLLOUT_UUID);
    expect(findCodexRolloutSessionId(join(CODEX_HOMES_DIR, 'session-nope'))).toBeNull();
  });

  it('falls back to history.jsonl when Codex 0.144+ removed the rollout file', () => {
    const home = join(CODEX_HOMES_DIR, 'session-43');
    mkdirSync(home, { recursive: true });
    const historyId = '019f4fa9-4a09-78c0-8a35-d7e3382d1f8f';
    writeFileSync(
      join(home, 'history.jsonl'),
      [
        JSON.stringify({ session_id: '00000000-0000-0000-0000-000000000000', text: 'old' }),
        '{bounded-tail-can-start-mid-line',
        JSON.stringify({ session_id: historyId, text: 'current' }),
        '',
      ].join('\n'),
    );

    expect(findCodexRolloutSessionId(home)).toBe(historyId);
  });
});

describe('executeWake — turn-provenance tagging (turn-provenance-owner-vs-agent-2026-07-11 P-002)', () => {
  // A spy tagger with the REAL TaggedTurn shape — marks the text so each
  // delivery channel's assertion can see exactly what was tagged, and captures
  // {sid, origin, nowMs} so the origin and ledger timestamp are verifiable.
  function spyTagger() {
    const calls: { sid: string; origin: string; text: string; nowMs?: number; ttlMs?: number }[] = [];
    const tag = ((args: { sid: string; origin: string; text: string; nowMs?: number; ttlMs?: number }) => {
      calls.push(args);
      return {
        taggedText: `⟦tagged:${args.origin}⟧\n${args.text}`,
        envelope: `⟦tagged:${args.origin}⟧`,
        nonce: 'spy',
        origin: args.origin,
        ledgerWritten: true,
      };
    }) as never;
    return { calls, tag };
  }

  it('warm psu-socket inject delivers TAGGED text (origin wake-pump, sid = subscriber)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const { calls, tag } = spyTagger();
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        tagTurn: tag,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [
      string,
      { data: string; provenanceIssuedAtMs: number },
    ];
    expect(msg.data).toMatch(/^⟦tagged:wake-pump⟧\n\[await-event\]/);
    expect(calls).toEqual([expect.objectContaining({ sid: 'su-abc', origin: 'wake-pump' })]);
    expect(msg.provenanceIssuedAtMs).toBe(calls[0]?.nowMs);
  });

  it('a loop wake (cold-loop marker on the payload) tags origin loop-fire — even on the warm path', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const { calls, tag } = spyTagger();
    await executeWake(
      work({
        wakeHandle: advHandle(),
        payload: { carry: 'warm', wakeCount: 3, harness: 'papercusp', routineId: 'routine-3' },
      }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        tagTurn: tag,
      }),
    );
    expect(calls[0]).toMatchObject({ origin: 'loop-fire' });
    expect(calls[0]).toMatchObject({ loopFire: { routineId: 'routine-3', wakeCount: 3 } });
    expect(calls[0]).toMatchObject({ ttlMs: LOOP_FIRE_PROVENANCE_TTL_MS });
  });

  it('an owner-Inbox-reply wake (inboxOwnerReply marker on the payload) tags origin coord-inject:owner (owner-inbox-single-pane-2026-07-17 D-006)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const { calls, tag } = spyTagger();
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: { inboxOwnerReply: true } }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        tagTurn: tag,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(calls[0]).toMatchObject({ origin: 'coord-inject:owner' });
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { data: string }];
    expect(msg.data).toMatch(/^⟦tagged:coord-inject:owner⟧\n/);
  });

  /**
   * EI-20130618357432548 — SECURITY RAIL, not a cosmetic assertion.
   *
   * An owner CHAT-PANE turn is the same authority as an owner INBOX reply, so it
   * mints the same existing origin. What matters is that it is still ENROLLED at
   * all: delivering it unenveloped would classify it OWNER (interactive), and the
   * UserPromptSubmit provenance hook auto-registers an AUTO/DRAIN mode grant on
   * that branch and only that branch. `/api/admin/coord/send` admits a no-Origin
   * loopback POST, so an unenrolled delivery would let any agent with a shell curl
   * an owner-stamped directive — and a mode grant — into a peer's session. If this
   * test is ever changed to expect no tag, that hole is what is being opened.
   */
  it('an owner CHAT-PANE wake is still ENROLLED, tagged coord-inject:owner — never delivered unenveloped', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const { calls, tag } = spyTagger();
    const out = await executeWake(
      work({
        wakeHandle: advHandle(),
        payload: { msg_id: 'm1', ownerChatTurn: true, ownerChatText: 'hi' },
      }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        tagTurn: tag,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(calls[0]).toMatchObject({ origin: 'coord-inject:owner' });
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { data: string }];
    expect(msg.data).toMatch(/^⟦tagged:coord-inject:owner⟧\n/);
    // The owner's own words are what follows the tag — not a wake wrapper.
    expect(msg.data).toContain('\nhi\n\n⟦owner-chat⟧');
  });

  it('the COLD injection is tagged too (origin loop-fire wraps renderColdWakeInjection)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const { calls, tag } = spyTagger();
    await executeWake(
      work({ wakeHandle: advHandle(), payload: { carry: 'cold', wakeCount: 1, harness: 'papercusp' } }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        coldAutoEnabled: vi.fn(async () => true),
        getLoopCarryNoteFn: vi.fn(async () => '## Next action\nresume'),
        tagTurn: tag,
      }),
    );
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [
      string,
      { mode: string; data: string; provenanceIssuedAtMs: number },
    ];
    expect(msg.mode).toBe('reset');
    expect(msg.data).toMatch(/^⟦tagged:loop-fire⟧\n/);
    expect(msg.data).toContain('## Next action\nresume');
    const coldTagCall = calls.find((call) => call.text.includes('## Next action\nresume'));
    expect(coldTagCall).toBeDefined();
    expect(coldTagCall).toMatchObject({ ttlMs: LOOP_FIRE_PROVENANCE_TTL_MS });
    expect(msg.provenanceIssuedAtMs).toBe(coldTagCall?.nowMs);
  });

  /**
   * P-023 / D-008 — a cold wake is a CONTEXT BOUNDARY and must say so.
   *
   * The coord owner id survives a cold wake but the context does not, so every
   * owner-keyed dedup (the turn-start orientation cursor, the memory
   * surfaced-ledger) would otherwise carry across a context that no longer
   * exists — going quiet for a successor that has seen nothing. The compaction
   * boundary already advanced this counter; the cold wake never did.
   */
  it('a COLD wake advances the CONTEXT GENERATION (P-023 / D-008)', async () => {
    const bumpSessionEpochFn = vi.fn(async () => {});
    await executeWake(
      work({ wakeHandle: advHandle(), payload: { carry: 'cold', wakeCount: 1, harness: 'papercusp' } }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: vi.fn(async () => true) as never,
        coldAutoEnabled: vi.fn(async () => true),
        getLoopCarryNoteFn: vi.fn(async () => '## Next action\nresume'),
        bumpSessionEpochFn,
      }),
    );
    expect(bumpSessionEpochFn).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: a WARM wake does NOT advance it — the context survives, so the dedup must too', async () => {
    // The load-bearing complement. If the bump fired on every wake it would reset
    // the dedup constantly and turn a per-boundary fold into a per-wake cost —
    // passing the test above for entirely the wrong reason.
    const bumpSessionEpochFn = vi.fn(async () => {});
    await executeWake(
      work({ wakeHandle: advHandle(), payload: { wakeCount: 1, harness: 'papercusp' } }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: vi.fn(async () => true) as never,
        coldAutoEnabled: vi.fn(async () => false),
        bumpSessionEpochFn,
      }),
    );
    expect(bumpSessionEpochFn).not.toHaveBeenCalled();
  });

  it('a FAILING generation bump never costs the wake — memory hygiene is not delivery', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: { carry: 'cold', wakeCount: 1, harness: 'papercusp' } }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        coldAutoEnabled: vi.fn(async () => true),
        getLoopCarryNoteFn: vi.fn(async () => '## Next action\nresume'),
        bumpSessionEpochFn: vi.fn(async () => {
          throw new Error('ledger unavailable');
        }),
      }),
    );
    // `psu-socket-reset`, not `-inject`: a cold wake RESETS the context, and the
    // point of this case is that a failed bump leaves that path completely
    // untouched — same channel, same carry-note, as if the ledger were healthy.
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { data: string }];
    expect(msg.data).toContain('## Next action\nresume');
  });

  /**
   * WI-6554700010029492 — the cold decision is RECORDED where loop:status can show it.
   * Before this a cold-armed fire that stayed warm (here: D-005, a human typing) was
   * delivered as a plain inject with its reason thrown away, indistinguishable from a
   * reset that was attempted and failed.
   */
  it('WI-6554700010029492: a cold-armed fire that stays WARM records WHY on its routine', async () => {
    const recordColdDecisionFn = vi.fn(async () => {});
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({
        wakeHandle: advHandle(),
        payload: { carry: 'cold', wakeCount: 3, harness: 'papercusp', routineId: 'routine-cold-1' },
      }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        coldAutoEnabled: vi.fn(async () => true),
        activeInteractiveExchange: vi.fn(() => true),
        getLoopCarryNoteFn: vi.fn(async () => '## Next action\nresume'),
        recordColdDecisionFn,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(recordColdDecisionFn).toHaveBeenCalledTimes(1);
    expect(recordColdDecisionFn).toHaveBeenCalledWith({
      routineId: 'routine-cold-1',
      record: expect.objectContaining({
        cold: false,
        mode: null,
        wakeCount: 3,
        reason: expect.stringContaining('D-005'),
      }),
    });
  });

  it('WI-6554700010029492: a fire that DOES go cold records the mode it took', async () => {
    const recordColdDecisionFn = vi.fn(async () => {});
    await executeWake(
      work({
        wakeHandle: advHandle(),
        payload: { carry: 'cold', wakeCount: 1, harness: 'papercusp', routineId: 'routine-cold-2' },
      }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: vi.fn(async () => true) as never,
        coldAutoEnabled: vi.fn(async () => true),
        getLoopCarryNoteFn: vi.fn(async () => '## Next action\nresume'),
        recordColdDecisionFn,
      }),
    );
    expect(recordColdDecisionFn).toHaveBeenCalledWith({
      routineId: 'routine-cold-2',
      record: expect.objectContaining({ cold: true, mode: 'reset', wakeCount: 1 }),
    });
  });

  it('WI-6554700010029492 CONTROL: a plain WARM loop fire never pays the write', async () => {
    const recordColdDecisionFn = vi.fn(async () => {});
    await executeWake(
      work({ wakeHandle: advHandle(), payload: { wakeCount: 2, harness: 'papercusp', routineId: 'routine-warm' } }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: vi.fn(async () => true) as never,
        coldAutoEnabled: vi.fn(async () => false),
        recordColdDecisionFn,
      }),
    );
    expect(recordColdDecisionFn).not.toHaveBeenCalled();
  });

  it('WI-6554700010029492: a FAILING decision write never costs the wake', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({
        wakeHandle: advHandle(),
        payload: { carry: 'cold', wakeCount: 1, harness: 'papercusp', routineId: 'routine-cold-3' },
      }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        coldAutoEnabled: vi.fn(async () => true),
        getLoopCarryNoteFn: vi.fn(async () => '## Next action\nresume'),
        recordColdDecisionFn: vi.fn(async () => {
          throw new Error('pg unavailable');
        }),
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
  });

  it('the degrade-to-inbox body is NEVER tagged (coord messages carry native provenance)', async () => {
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const { tag } = spyTagger();
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({
        findPsuHost: vi.fn(() => null) as never,
        presence: vi.fn(async () => ({ ...livePresence, stale: true })) as never,
        sendCoordMessage: sendCoordMessage as never,
        tagTurn: tag,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    const [, msg] = sendCoordMessage.mock.calls[0] as unknown as [unknown, { body: string }];
    expect(msg.body).not.toContain('⟦tagged:');
    expect(msg.body).toContain('[await-event]');
  });

  it('a tagger that throws never breaks the wake — an unverified envelope still delivers', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        tagTurn: (() => {
          throw new Error('ledger disk full');
        }) as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { data: string }];
    expect(msg.data).toMatch(/^⟦turn-origin:wake-pump nonce:[a-f0-9]{16}⟧\n\[await-event\]/);
  });

  // WI-10005327: the real tagger is async (its ledger write runs off the event
  // loop). The ledger row must land BEFORE the turn is typed, because the hook
  // classifies at prompt-submit. A tagger that resolves on a later tick proves
  // the executor waits for it rather than racing ahead.
  it('awaits an ASYNC tagger: the inject happens only after its ledger write resolves', async () => {
    const order: string[] = [];
    const injectPsuHost = vi.fn(async () => {
      order.push('inject');
      return true;
    });
    const tagTurn = (async (args: { origin: string; text: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('ledger-written');
      return {
        taggedText: `⟦tagged:${args.origin}⟧\n${args.text}`,
        envelope: `⟦tagged:${args.origin}⟧`,
        nonce: 'later-tick',
        origin: args.origin,
        ledgerWritten: true,
      };
    }) as never;
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        tagTurn,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { data: string }];
    expect(msg.data).toMatch(/^⟦tagged:wake-pump⟧\n\[await-event\]/);
    expect(order).toEqual(['ledger-written', 'inject']);
  });

  it('an async tagger that REJECTS still delivers an unverified envelope', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        tagTurn: (async () => {
          throw new Error('EIO on the ledger dir');
        }) as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { data: string }];
    expect(msg.data).toMatch(/^⟦turn-origin:wake-pump nonce:[a-f0-9]{16}⟧\n\[await-event\]/);
  });
});

describe('executeWake — psu-host cold-auto fork (su-cold-auto-mode-2026-07-03 Phase 2)', () => {
  // A cold loop-wake payload marker (loop-fire stamps carry/wakeCount/harness).
  const coldPayload = (over: Record<string, unknown> = {}) => ({
    carry: 'cold',
    wakeCount: 1,
    harness: 'papercusp',
    ...over,
  });

  // deps with a LIVE psu-host socket + the cold fork wired ON (master gate true,
  // a carry-note present). Individual cases override to exercise each gate.
  const coldDeps = (over: Partial<ExecuteWakeDeps> = {}): ExecuteWakeDeps =>
    deps({
      findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/cold.sock' })) as never,
      injectPsuHost: vi.fn(async () => true) as never,
      coldAutoEnabled: vi.fn(async () => true),
      getLoopCarryNoteFn: vi.fn(async () => '## Next action\nresume the wiring'),
      ...over,
    });

  it('eligible cold wake with an exited session and no psu host parks instead of rehydrating the predecessor transcript', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const getLoopCarryNoteFn = vi.fn(async () => '## Next action\nresume the wiring');
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload() }),
      coldDeps({
        findPsuHost: vi.fn(() => null) as never,
        alive: vi.fn(() => false),
        spawnDetached,
        getLoopCarryNoteFn,
      }),
    );

    expect(out).toEqual({
      kind: 'park',
      reason:
        'eligible cold loop wake has no injectable psu host — parked without resume to preserve the fresh-context boundary',
    });
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(getLoopCarryNoteFn).toHaveBeenCalledWith({
      harness: 'papercusp',
      ownerId: 'su-abc',
      workspaceId: 'ws',
    });
  });

  it('EI-21431587306904888: the no-host park feeds the limbo guard with the marker identity', async () => {
    const recordColdNoHostPark = vi.fn(async () => ({ action: 'tracked' as const, streak: 1 }));
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ routineId: 'loop-su-abc', wakeCount: 7 }) }),
      coldDeps({
        findPsuHost: vi.fn(() => null) as never,
        alive: vi.fn(() => false),
        recordColdNoHostPark,
      }),
    );
    // Below the threshold the observable outcome is byte-identical to the pre-guard park.
    expect(out).toEqual({
      kind: 'park',
      reason:
        'eligible cold loop wake has no injectable psu host — parked without resume to preserve the fresh-context boundary',
    });
    expect(recordColdNoHostPark).toHaveBeenCalledWith({
      routineId: 'loop-su-abc',
      wakeCount: 7,
      subscriberId: 'su-abc',
    });
  });

  it('EI-21431587306904888: at the streak threshold the park reports the auto-pause + escalation', async () => {
    const recordColdNoHostPark = vi.fn(async () => ({ action: 'escalated' as const, streak: 3 }));
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ routineId: 'loop-su-abc', wakeCount: 9 }) }),
      coldDeps({
        findPsuHost: vi.fn(() => null) as never,
        alive: vi.fn(() => false),
        recordColdNoHostPark,
      }),
    );
    expect(out).toEqual({
      kind: 'park',
      reason:
        'eligible cold loop wake has no injectable psu host — 3 distinct consecutive undeliverable cold fires: ' +
        'loop AUTO-PAUSED + escalated instead of parking indefinitely (cold no-host limbo guard, EI-21431587306904888)',
    });
  });

  it('EI-21431587306904888: an already-paused loop parks with the guard reason and never re-escalates', async () => {
    const recordColdNoHostPark = vi.fn(async () => ({ action: 'already-paused' as const, streak: 3 }));
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ routineId: 'loop-su-abc', wakeCount: 10 }) }),
      coldDeps({
        findPsuHost: vi.fn(() => null) as never,
        alive: vi.fn(() => false),
        recordColdNoHostPark,
      }),
    );
    expect(out).toEqual({
      kind: 'park',
      reason:
        'eligible cold loop wake has no injectable psu host — loop already auto-paused (cold no-host limbo guard); parked',
    });
  });

  describe('cold no-host fresh successor', () => {
    it('re-tags the prompt at launch when earlier delivery gates outlive the provenance TTL', async () => {
      const launchColdFreshSuccessor = vi.fn(async () => true);
      const recordColdNoHostPark = vi.fn(async () => ({ action: 'tracked' as const, streak: 1 }));
      const spawnDetached = vi.fn(() => 4321);
      const nowMs = 1_700_000_000_000;
      const staleDelayMs = 10 * 60_000 + 1;
      let clockMs = nowMs;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
      const tagCalls: Array<{ sid: string; origin: string; text: string; nowMs?: number }> = [];
      const tagTurn = ((args: { sid: string; origin: string; text: string; nowMs?: number }) => {
        tagCalls.push(args);
        if (tagCalls.length === 1) clockMs += staleDelayMs;
        return {
          taggedText: `⟦tagged:${args.origin}:${tagCalls.length}⟧\n${args.text}`,
          envelope: `⟦tagged:${args.origin}:${tagCalls.length}⟧`,
          nonce: `nonce-${tagCalls.length}`,
          origin: args.origin,
          ledgerWritten: true,
        };
      }) as never;

      try {
        const out = await executeWake(
          work({ wakeHandle: advHandle(), payload: coldPayload({ routineId: 'loop-su-abc', wakeCount: 7 }) }),
          coldDeps({
            findPsuHost: vi.fn(() => null) as never,
            alive: vi.fn(() => false),
            launchColdFreshSuccessor,
            recordColdNoHostPark,
            spawnDetached,
            tagTurn,
          }),
        );

        expect(out).toEqual({ kind: 'delivered', channel: 'cold-fresh-successor' });
        expect(launchColdFreshSuccessor).toHaveBeenCalledWith(expect.objectContaining({
          subscriberId: 'su-abc', workspaceId: 'ws', harness: 'papercusp', deliveryId: expect.any(Number),
          wakeText: `⟦tagged:loop-fire:2⟧\n${tagCalls[1]?.text}`,
          turnOrigin: 'loop-fire',
          loopFire: { routineId: 'loop-su-abc', wakeCount: 7 },
        }));
        expect(tagCalls).toHaveLength(2);
        expect(tagCalls[1]?.nowMs).toBe(nowMs + staleDelayMs);
        expect(tagCalls[1]?.text).toBe(tagCalls[0]?.text);
        expect(tagCalls[1]?.text).not.toContain('⟦tagged:loop-fire:1⟧');
        expect(recordColdNoHostPark).not.toHaveBeenCalled();
        expect(spawnDetached).not.toHaveBeenCalled();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('failed successor parks and streaks without falling through to transcript resume', async () => {
      const recordColdNoHostPark = vi.fn(async () => ({ action: 'tracked' as const, streak: 1 }));
      const spawnDetached = vi.fn(() => 4321);
      const out = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ routineId: 'loop-su-abc', wakeCount: 8 }) }),
        coldDeps({
          findPsuHost: vi.fn(() => null) as never,
          alive: vi.fn(() => false),
          launchColdFreshSuccessor: vi.fn(async () => false),
          recordColdNoHostPark,
          spawnDetached,
        }),
      );
      expect(out).toMatchObject({ kind: 'park' });
      expect(recordColdNoHostPark).toHaveBeenCalledTimes(1);
      expect(spawnDetached).not.toHaveBeenCalled();
    });

    it('a throwing successor never resumes the old transcript', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const out = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ routineId: 'loop-su-abc', wakeCount: 9 }) }),
        coldDeps({
          findPsuHost: vi.fn(() => null) as never,
          alive: vi.fn(() => false),
          launchColdFreshSuccessor: vi.fn(async () => {
            throw new Error('launch unavailable');
          }),
        }),
      );
      expect(out).toMatchObject({ kind: 'park' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cold fresh successor failed for su-abc'));
      warn.mockRestore();
    });
  });

  it('EI-21431587306904888: a THROWING limbo guard never changes park behavior (fail-soft)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ routineId: 'loop-su-abc', wakeCount: 2 }) }),
      coldDeps({
        findPsuHost: vi.fn(() => null) as never,
        alive: vi.fn(() => false),
        recordColdNoHostPark: vi.fn(async () => {
          throw new Error('pg unavailable');
        }),
      }),
    );
    expect(out).toEqual({
      kind: 'park',
      reason:
        'eligible cold loop wake has no injectable psu host — parked without resume to preserve the fresh-context boundary',
    });
  });

  it('no-host exited wake keeps the legacy resume fallback when cold auto is disabled', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload() }),
      coldDeps({
        findPsuHost: vi.fn(() => null) as never,
        coldAutoEnabled: vi.fn(async () => false),
        alive: vi.fn(() => false),
        isLoopArmed: vi.fn(async () => true),
        resolveMemberLiveness: parkedMemberLiveness() as never,
        spawnDetached,
      }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });

  it('cold-armed + enabled + carry-note → RESET-CONTEXT inject (channel psu-socket-reset, data = the carry-note WRAPPED with the re-checkpoint mandate, not the warm turn)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
      coldDeps({ injectPsuHost: injectPsuHost as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    const [sock, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { mode: string; data: string }];
    expect(sock).toBe('/tmp/psu-pty/cold.sock');
    expect(msg.mode).toBe('reset');
    // P-002 producer: the injected text is the carry-note wrapped by renderColdWakeInjection —
    // it carries the note verbatim AND the standing "refresh via loop:checkpoint" mandate so the
    // cold anchor stays fresh across wakes. EI-15799: the payload's fire-time wakeCount (1 here)
    // is threaded through as the staleness marker, so the expectation must carry it too.
    expect(msg.data).toBe(renderColdWakeInjection('## Next action\nresume the wiring', undefined, 1));
    expect(msg.data).toContain('## Next action\nresume the wiring');
    expect(msg.data).toContain('loop:checkpoint');
  });

  it('Codex cold reset uses carry-respawn and forwards the cold text as the system addendum', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({
        wakeHandle: advHandle({ agent: 'codex' }),
        payload: coldPayload({ wakeCount: 1 }),
      }),
      coldDeps({ injectPsuHost: injectPsuHost as never }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle' });
    const msg = (injectPsuHost.mock.calls[0] as unknown as [string, {
      mode: string;
      data: string;
      systemPromptAddendum?: string;
    }])[1];
    expect(msg.mode).toBe('carry-respawn');
    expect(msg.systemPromptAddendum).toBe(msg.data);
    expect(msg.systemPromptAddendum).toBe(renderColdWakeInjection('## Next action\nresume the wiring', undefined, 1));
  });

  it('Codex cold recycle also forwards the system addendum through carry-respawn', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({
        wakeHandle: advHandle({ agent: 'codex' }),
        payload: coldPayload({ wakeCount: 8 }),
      }),
      coldDeps({ injectPsuHost: injectPsuHost as never }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle' });
    const msg = (injectPsuHost.mock.calls[0] as unknown as [string, {
      mode: string;
      data: string;
      systemPromptAddendum?: string;
    }])[1];
    expect(msg.mode).toBe('carry-respawn');
    expect(msg.systemPromptAddendum).toBe(msg.data);
    expect(msg.systemPromptAddendum).toContain('(fire #8)');
  });

  it.each([
    ['claude', 1, 'reset'],
    ['claude', 8, 'recycle'],
    ['codex', 1, 'carry-respawn'],
    ['codex', 8, 'carry-respawn'],
  ] as const)('cold transport preserves delivery-time changes for %s fire %s (%s)', async (agent, wakeCount, mode) => {
    const { renderCarryNote } = await import('../../carry-note');
    const note = renderCarryNote({
      did: 'Await the controlled wake.',
      checks: [
        {
          id: 'cold-probe',
          claim: 'control is green',
          probe: {
            kind: 'state-cell',
            cell: 'gate.greenCheckpoint.verdict',
            schemaRevision: 'test-revision',
            expect: { path: '$.value', op: 'eq', value: 'green' },
          },
        },
      ],
    });
    for (const result of ['changed', 'could-not-run', 'unchanged'] as const) {
      const probeLine =
        result === 'changed'
          ? 'CHANGED [#cold-probe]: observed "red"'
          : result === 'could-not-run'
            ? 'COULD NOT RUN [#cold-probe]: unavailable'
            : null;
      const refLine = result === 'changed' ? 'CHANGED work-item:WI-control: open → done' : null;
      const carriedProbeBlockFn = vi.fn(async () => probeLine);
      const carryRefBlockFn = vi.fn(async () => refLine);
      const injectPsuHost = vi.fn(async () => true);
      const updatedAtMs = Date.now() - 1_000;
      await executeWake(
        work({ wakeHandle: advHandle({ agent }), payload: coldPayload({ wakeCount }) }),
        coldDeps({
          getLoopCarryNoteFn: undefined,
          getLoopCarryNoteWithMetaFn: vi.fn(async () => ({ note, updatedAtMs })) as never,
          carriedProbeBlockFn,
          carryRefBlockFn,
          injectPsuHost: injectPsuHost as never,
        }),
      );
      expect(carriedProbeBlockFn).toHaveBeenCalledTimes(1);
      expect(carryRefBlockFn).toHaveBeenCalledTimes(1);
      expect(injectPsuHost).toHaveBeenCalledTimes(1);
      const msg = (
        injectPsuHost.mock.calls[0] as unknown as [
          string,
          {
            mode: string;
            data: string;
            systemPromptAddendum?: string;
          },
        ]
      )[1];
      expect(msg.mode).toBe(mode);
      if (agent === 'codex') expect(msg.systemPromptAddendum).toBe(msg.data);
      if (probeLine) {
        expect(msg.data).toContain(probeLine);
        expect(msg.data.indexOf(probeLine)).toBeLessThan(msg.data.indexOf('COLD LOOP WAKE'));
        expect(msg.data.split(probeLine)).toHaveLength(2);
      } else {
        expect(msg.data).not.toContain('## Carried probe changes');
      }
      if (refLine) expect(msg.data).toContain(refLine);
      else expect(msg.data).not.toContain('## Carried reference changes');
    }
  });

  it('EI-18224278118395857: the production read (meta variant, no getLoopCarryNoteFn seam) threads the note write-time into the injection so a late-flushed stale note is self-evident', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const updatedAtMs = Date.parse('2026-07-21T03:10:00.000Z');
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({
      note: '## Next action\nresume the wiring',
      updatedAtMs,
    }));
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 96 }) }),
      coldDeps({
        injectPsuHost: injectPsuHost as never,
        // Drop the note-only seam so the production META read runs (carries updatedAtMs).
        getLoopCarryNoteFn: undefined,
        getLoopCarryNoteWithMetaFn: getLoopCarryNoteWithMetaFn as never,
      }),
    );
    // fire #96 is 96 % 8 === 0 ⇒ a RECYCLE (faithful to the reported incident); the injected
    // data is composed by renderColdWakeInjection for both reset and recycle.
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle' });
    expect(getLoopCarryNoteWithMetaFn).toHaveBeenCalledWith({
      harness: 'papercusp',
      ownerId: 'su-abc',
      workspaceId: 'ws',
    });
    const data = (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
    // the fresh-read note is still the core, now with the write-time stamp + reconcile guidance.
    expect(data).toContain('## Next action\nresume the wiring');
    expect(data).toContain('[07-21T03:10:00Z]');
    expect(data.toLowerCase()).toContain('stale');
    expect(data.toLowerCase()).toContain('reconcile');
    expect(data).toContain('(fire #96)');
  });

  it('EI-20460364238376772: one delivery-time meta snapshot wins over a stale second read in a delayed cold wake', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const fireSnapshot = '## Next action\nfire-time checkpoint A';
    const deliveryCheckpoint = '## Next action\ndelivery checkpoint B';
    const staleSecondRead = '## Next action\nstale second read A';
    const getLoopCarryNoteWithMetaFn = vi
      .fn()
      .mockResolvedValueOnce({
        note: deliveryCheckpoint,
        updatedAtMs: Date.parse('2026-08-23T04:20:00.000Z'),
      })
      // Model the replica/pinned-row regression that can occur between the
      // delivery rehydration and the cold reset composition. The delivery must
      // not replace B with this older value.
      .mockResolvedValueOnce({
        note: staleSecondRead,
        updatedAtMs: Date.parse('2026-08-23T04:19:00.000Z'),
      })
      // The cold injector performs its own boundary read. A stale observation
      // must not displace the newer delivery snapshot already retained above.
      .mockResolvedValue({
        note: staleSecondRead,
        updatedAtMs: Date.parse('2026-08-23T04:19:00.000Z'),
      });
    const out = await executeWake(
      work({
        wakeHandle: advHandle(),
        payload: coldPayload({ wakeCount: 1 }),
        summary: fireSnapshot,
      }),
      coldDeps({
        injectPsuHost: injectPsuHost as never,
        // Force both the delivery rehydration and cold injection through the
        // memoized meta reader instead of the note-only cold seam.
        getLoopCarryNoteFn: undefined,
        getLoopCarryNoteWithMetaFn: getLoopCarryNoteWithMetaFn as never,
      }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    // The delivery resolver refreshes once at the boundary, then keeps the
    // timestamp-newer B snapshot even when that second read is stale.
    expect(getLoopCarryNoteWithMetaFn).toHaveBeenCalledTimes(3);
    const data = (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
    expect(data).toContain(deliveryCheckpoint);
    expect(data).not.toContain(staleSecondRead);
  });

  it('EI-21637048865481637: a newer checkpoint written after the first delivery read is what the wake injects', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const olderCheckpoint = '## Next action\nP-002/P-003/P-005 are not started';
    const newerCheckpoint = '## Next action\nP-002/P-003/P-005 are complete; continue with validation';
    const olderAt = Date.parse('2026-08-27T19:13:38.348Z');
    const newerAt = Date.parse('2026-08-27T19:49:40.000Z');
    const getLoopCarryNoteWithMetaFn = vi
      .fn()
      .mockResolvedValueOnce({ note: olderCheckpoint, updatedAtMs: olderAt })
      .mockResolvedValueOnce({ note: newerCheckpoint, updatedAtMs: newerAt })
      .mockResolvedValue({ note: newerCheckpoint, updatedAtMs: newerAt });

    const out = await executeWake(
      work({
        wakeHandle: advHandle(),
        payload: coldPayload({ wakeCount: 6 }),
      }),
      coldDeps({
        injectPsuHost: injectPsuHost as never,
        getLoopCarryNoteFn: undefined,
        getLoopCarryNoteWithMetaFn: getLoopCarryNoteWithMetaFn as never,
      }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    expect(getLoopCarryNoteWithMetaFn).toHaveBeenCalledTimes(3);
    const data = (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
    expect(data).toContain(newerCheckpoint);
    expect(data).not.toContain(olderCheckpoint);
    expect(data).toContain('[08-27T19:49:40Z]');
  });

  it('EI-21972787374193956: a mixed rehydration/cold snapshot is marked UNTRUSTED while cold delivery is preserved', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const renderedNote = '## Next action\nrendered delivery snapshot';
    const cachedNote = '## Next action\ncached cold-injection snapshot';
    const renderedAtMs = Date.parse('2026-08-31T17:00:00.000Z');
    const cachedAtMs = Date.parse('2026-08-31T17:01:00.000Z');
    const getLoopCarryNoteWithMetaFn = vi
      .fn()
      // The refresh read used to render the delivery-time block.
      .mockResolvedValueOnce({ note: renderedNote, updatedAtMs: renderedAtMs })
      // The refresh's second observation agrees, so the rendered snapshot remains exact.
      .mockResolvedValueOnce({ note: renderedNote, updatedAtMs: renderedAtMs })
      // The cold injector independently observes a different snapshot.
      .mockResolvedValueOnce({ note: cachedNote, updatedAtMs: cachedAtMs });

    const out = await executeWake(
      work({
        wakeHandle: advHandle(),
        payload: coldPayload({ wakeCount: 1 }),
      }),
      coldDeps({
        injectPsuHost: injectPsuHost as never,
        getLoopCarryNoteFn: undefined,
        getLoopCarryNoteWithMetaFn: getLoopCarryNoteWithMetaFn as never,
      }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    expect(getLoopCarryNoteWithMetaFn).toHaveBeenCalledTimes(3);
    const data = (injectPsuHost.mock.calls[0] as unknown as [string, { mode: string; data: string }])[1];
    expect(data.mode).toBe('reset');
    expect(data.data).toContain('UNTRUSTED');
    expect(data.data).toContain('bodyHash');
    expect(data.data).toContain('updatedAtMs');
    expect(data.data).toContain(renderedNote);
    expect(data.data).toContain(cachedNote);
  });

  // WI-6951: the un-checkpointed-work banner must read the STRICT turn signal
  // (lastRealTurnAt = session_turn_journal) and never the lastTurnAt union, which folds
  // in the '■ session ended' lifecycle marker. A cold reset KILLS its predecessor, so that
  // marker always postdates the final loop:checkpoint — feeding it to this check reported a
  // session death as "you completed a turn at …". These three cases are the live incident
  // (su-7854d874 fire #12), its true-positive twin, and the no-fallback rule.
  describe('WI-6951 — un-checkpointed-work banner sources the strict turn signal', () => {
    const noteAtMs = Date.parse('2026-08-02T05:29:48.175Z');
    const realTurnIso = '2026-08-02T05:30:24.495Z'; // 36s after the note — INSIDE the 5-min floor
    const sessionEndIso = '2026-08-02T06:00:23.817Z'; // predecessor killed, ~31m after the note
    const BANNER = 'UN-CHECKPOINTED WORK EXISTS';

    const coldDataWithStatus = async (status: Record<string, unknown> | null) => {
      const injectPsuHost = vi.fn(async () => true);
      await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 12 }) }),
        coldDeps({
          injectPsuHost: injectPsuHost as never,
          getLoopCarryNoteFn: undefined,
          getLoopCarryNoteWithMetaFn: vi.fn(async () => ({
            note: '## Next action\nresume the wiring',
            updatedAtMs: noteAtMs,
          })) as never,
          getLoopStatusFn: vi.fn(async () => status) as never,
        }),
      );
      return (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
    };

    it('does NOT fire when only the session-END marker postdates the note (the live false alarm)', async () => {
      const data = await coldDataWithStatus({
        lastTurnAt: sessionEndIso, // the union — a session DEATH, ~31m after the note
        lastRealTurnAt: realTurnIso, // the truth — a turn 36s after the note
      });
      expect(data).not.toContain(BANNER);
      // and specifically never quotes the kill instant back as a completed turn
      expect(data).not.toContain('06:00:23');
      expect(data).toContain('## Next action\nresume the wiring');
    });

    it('STILL fires when a real turn genuinely postdates the note (the true positive is preserved)', async () => {
      const data = await coldDataWithStatus({
        lastTurnAt: sessionEndIso,
        lastRealTurnAt: sessionEndIso, // a genuine journal turn that late
      });
      expect(data).toContain(BANNER);
      expect(data).toContain('06:00:23');
    });

    it('does NOT fall back to lastTurnAt when the strict signal is absent — silence beats a false alarm', async () => {
      const data = await coldDataWithStatus({ lastTurnAt: sessionEndIso, lastRealTurnAt: null });
      expect(data).not.toContain(BANNER);
    });
  });

  // EI-19984789589075138: `lastRealTurnAt` is a well-formed turn even when it is a usage-wall /
  // withheld-fire bounce that made zero tool calls — so the WI-6951 strict signal alone still
  // fires the banner on that shape. This is the follow-up evidence check.
  describe('EI-19984789589075138 — evidence check downgrades a bounced-fire false alarm', () => {
    const noteAtMs = Date.parse('2026-08-09T13:51:00.000Z');
    const realTurnIso = '2026-08-09T14:06:00.000Z'; // ~15m after the note — clears the floor
    const BANNER = 'UN-CHECKPOINTED WORK EXISTS';

    const coldRun = async (status: Record<string, unknown> | null, countAgentToolCallsFn?: unknown) => {
      const injectPsuHost = vi.fn(async () => true);
      await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 6 }) }),
        coldDeps({
          injectPsuHost: injectPsuHost as never,
          getLoopCarryNoteFn: undefined,
          getLoopCarryNoteWithMetaFn: vi.fn(async () => ({
            note: '## Next action\nresume the wiring',
            updatedAtMs: noteAtMs,
          })) as never,
          getLoopStatusFn: vi.fn(async () => status) as never,
          ...(countAgentToolCallsFn ? { countAgentToolCallsFn: countAgentToolCallsFn as never } : {}),
        }),
      );
      return (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
    };

    it('downgrades to the bounced-fire notice when the evidence check confirms zero agent tool calls', async () => {
      const countAgentToolCallsFn = vi.fn(async () => 0);
      const data = await coldRun({ lastTurnAt: realTurnIso, lastRealTurnAt: realTurnIso }, countAgentToolCallsFn);
      expect(countAgentToolCallsFn).toHaveBeenCalledWith('su-abc', noteAtMs, Date.parse(realTurnIso));
      expect(data).not.toContain(BANNER);
      expect(data).toContain('bounced fire');
    });

    it('keeps the strong banner when the evidence check finds real tool calls', async () => {
      const countAgentToolCallsFn = vi.fn(async () => 5);
      const data = await coldRun({ lastTurnAt: realTurnIso, lastRealTurnAt: realTurnIso }, countAgentToolCallsFn);
      expect(data).toContain(BANNER);
      expect(data).not.toContain('bounced fire');
    });

    it('keeps the strong (existing) banner unchanged when the evidence check is never wired (defaults preserved)', async () => {
      const data = await coldRun({ lastTurnAt: realTurnIso, lastRealTurnAt: realTurnIso });
      expect(data).toContain(BANNER);
    });

    it('never calls the evidence check at all when the banner would not fire anyway (inside the floor)', async () => {
      const countAgentToolCallsFn = vi.fn(async () => 0);
      const closeIso = '2026-08-09T13:51:30.000Z'; // 30s after the note — inside the 5min floor
      const data = await coldRun({ lastTurnAt: closeIso, lastRealTurnAt: closeIso }, countAgentToolCallsFn);
      expect(countAgentToolCallsFn).not.toHaveBeenCalled();
      expect(data).not.toContain(BANNER);
    });
  });

  // WI-6862: the booked channel must say WHICH signal produced the `true`. injectIntoHost's
  // bare boolean resolves true on a BARE SOCKET CLOSE, which is exactly what a host killed
  // mid-delivery (a provider usage_limit wall hitting the respawn) looks like — so a cold
  // reset that never re-execed was booked as an unqualified success and read back that way
  // by whoever was diagnosing it (observed on WI-6852: booked delivered 02:58:02.883Z, the
  // respawn hit the wall at 02:58:07.310Z).
  describe('WI-6862 — the cold channel distinguishes an ACKED re-exec from an ASSUMED one', () => {
    const confirming = (r: { ok: boolean; confirmation: string }) =>
      ({ injectPsuHostWithConfirmation: vi.fn(async () => r) }) as unknown as Partial<ExecuteWakeDeps>;

    it("books 'psu-socket-reset' when the HOST acked — the only value that means it confirmed", async () => {
      const out = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
        coldDeps(confirming({ ok: true, confirmation: 'acked' })),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    });

    it("books 'psu-socket-reset-unconfirmed' on a bare close — the wall-killed respawn that used to read as a clean success", async () => {
      const out = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
        coldDeps(confirming({ ok: true, confirmation: 'assumed-close' })),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset-unconfirmed' });
    });

    it('the RECYCLE cadence (wakeCount % 8 === 0) carries the same distinction, both ways', async () => {
      const acked = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 8 }) }),
        coldDeps(confirming({ ok: true, confirmation: 'acked' })),
      );
      expect(acked).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle' });
      const assumed = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 8 }) }),
        coldDeps(confirming({ ok: true, confirmation: 'assumed-close' })),
      );
      expect(assumed).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle-unconfirmed' });
    });

    it('a NOT-ok confirmation is not a channel at all — it still falls through to the warm inject', async () => {
      const out = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
        coldDeps(confirming({ ok: false, confirmation: 'timeout' })),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    });

    // THE CONTROL. Without it the three assertions above would also pass if the fixture
    // never reached the confirmation seam at all: `coldDeps` supplies an `injectPsuHost`
    // stub, and a stub has no confirmation channel, so resolution deliberately falls back
    // to today's exact boolean behavior. This case pins that fallback — proving the
    // channels above are produced by the confirmation value and not by the fixture shape.
    it('CONTROL: an injectPsuHost stub with no confirmation seam keeps TODAY’s channel unchanged', async () => {
      const out = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
        coldDeps(),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    });
  });

  it('P-003 (compaction-continuity-hardening): the cold injection appends the carry-brief EXTRAS (held items + walls/facts + awaits + fleet) after the note; the note stays the core', async () => {
    const injectPsuHost = vi.fn(async () => true);
    // The return is TYPED as CarryBrief on purpose: this fixture has now been
    // bitten TWICE by contract drift (EI-8593: missing `walls`; then EI-11484:
    // missing `directives`) — each time the renderer threw on the absent field,
    // the note-only catch swallowed it, and the extras were silently dropped.
    // With the explicit type, the NEXT CarryBrief field addition fails tsc HERE
    // instead of failing this assertion at runtime.
    const buildCarryBriefFn = vi.fn(
      async (ownerId: string): Promise<CarryBrief> => ({
        ownerId,
        workspaceId: 'ws',
        loop: null,
        heldItems: [
          {
            id: 'WI-3319',
            title: 'Shared carry-brief builder',
            body: null,
            harness: 'papercusp',
            checkpoint: 'watchdog wired; cold anchor next',
            holderProof: { ownerId, workspaceId: 'ws' },
          },
        ],
        directives: [],
        directivesTotalOpen: 0,
        walls: [],
        facts: [{ key: 'zombie-pids-wall', body: '3 PIDs await owner OK' }],
        awaits: [{ eventKey: 'deploy:done:release-77', note: null }],
        fleet: { slug: 'bug-drain', role: 'leader' },
      }),
    );
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
      coldDeps({ injectPsuHost: injectPsuHost as never, buildCarryBriefFn: buildCarryBriefFn as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    expect(buildCarryBriefFn).toHaveBeenCalledWith('su-abc', { workspaceId: 'ws' });
    const data = (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
    // The note leads, the extras follow, the re-checkpoint mandate closes.
    expect(data).toContain('## Next action\nresume the wiring');
    expect(data).toContain('WI-3319 — Shared carry-brief builder');
    expect(data).toContain('checkpoint: watchdog wired; cold anchor next');
    expect(data).toContain('zombie-pids-wall: 3 PIDs await owner OK');
    expect(data).toContain('deploy:done:release-77');
    expect(data).toContain('Fleet: you are in "bug-drain" as leader');
    expect(data.indexOf('resume the wiring')).toBeLessThan(data.indexOf('WI-3319'));
    expect(data.indexOf('WI-3319')).toBeLessThan(data.indexOf('Before you END this turn'));
  });

  // WI-6554700010018677: a real delivery row carries DEFAULT_COORD_WORKSPACE. The adv-session path
  // re-scopes it to the session's workspace first; the HANDLE-LESS socket path does not, and a
  // brief built under the coordination namespace read every tenant-keyed leg empty.
  it('builds a handle-less cold-wake carry brief under the subscriber tenant, not the coordination namespace', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const workspaceForCoordOwnerFn = vi.fn(async () => 'tenant-ws');
    const buildCarryBriefFn = vi.fn(
      async (ownerId: string): Promise<CarryBrief> => ({
        ownerId,
        workspaceId: 'tenant-ws',
        loop: null,
        heldItems: [],
        directives: [],
        directivesTotalOpen: 0,
        walls: [],
        facts: [],
        awaits: [],
        fleet: null,
      }),
    );
    await executeWake(
      work({ workspaceId: DEFAULT_COORD_WORKSPACE, wakeHandle: undefined, payload: coldPayload({ wakeCount: 1 }) }),
      coldDeps({
        injectPsuHost: injectPsuHost as never,
        buildCarryBriefFn: buildCarryBriefFn as never,
        workspaceForCoordOwnerFn: workspaceForCoordOwnerFn as never,
      }),
    );
    expect(buildCarryBriefFn).toHaveBeenCalledWith('su-abc', { workspaceId: 'tenant-ws' });
    expect(workspaceForCoordOwnerFn).toHaveBeenCalledWith('su-abc');
  });

  it('EI-19362981097884026: annotates a terminal cited item on the carried Next action itself', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const note = '## Next action\ncomplete WI-6054, then continue the drain';
    const buildCarryBriefFn = vi.fn(
      async (ownerId: string): Promise<CarryBrief> => ({
        ownerId,
        loop: null,
        heldItems: [],
        directives: [],
        directivesTotalOpen: 0,
        walls: [],
        facts: [],
        awaits: [],
        fleet: null,
        citedRefs: ['WI-6054 [bug/done @su-397]: "already fixed + closed…"'],
      }),
    );

    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
      coldDeps({
        injectPsuHost: injectPsuHost as never,
        getLoopCarryNoteFn: vi.fn(async () => note),
        buildCarryBriefFn: buildCarryBriefFn as never,
      }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    const data = (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
    const annotated = 'complete WI-6054, then continue the drain   ⚠ LIVE: WI-6054 status=done';
    expect(data).toContain(annotated);
    expect(data).toContain('STALE-NOTE CONTRADICTION');
    expect(data).toContain('⚠ TERMINAL ↪ WI-6054 [bug/done');
    expect(data.indexOf(annotated)).toBeLessThan(data.indexOf('STALE-NOTE CONTRADICTION'));
  });

  it('P-003 fail-soft: a THROWING carry-brief reader injects the note alone (byte-identical to the extras-less injection) AND warns — the swallow must never be silent', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
        coldDeps({
          injectPsuHost: injectPsuHost as never,
          buildCarryBriefFn: vi.fn(async () => {
            throw new Error('pg down');
          }) as never,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
      const data = (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
      // EI-15799: byte-identical to the extras-less injection AT THE SAME fire number (1).
      expect(data).toBe(renderColdWakeInjection('## Next action\nresume the wiring', undefined, 1));
      // Detector guard (EI-8593 / EI-11484 class): a dropped extras leg means a cold
      // wake silently loses held-items/walls/facts continuity — it must at least log.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cold carry-brief extras failed'), expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('the HYBRID cadence recycles every Nth wake (wakeCount 8 → RECYCLE, channel psu-socket-recycle)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 8 }) }),
      coldDeps({ injectPsuHost: injectPsuHost as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle' });
    expect((injectPsuHost.mock.calls[0] as unknown as [string, { mode: string }])[1].mode).toBe('recycle');
  });

  it('the handle-less always-armed branch forks cold too (both inject sites wired, not just the main one)', async () => {
    const out = await executeWake(work({ wakeHandle: null, payload: coldPayload() }), coldDeps());
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
  });

  it('DORMANT by default: a cold-armed wake with cold-auto DISABLED (no gate dep) stays WARM (mode turn) and never reads the carry-note', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const getLoopCarryNoteFn = vi.fn(async () => 'note');
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload() }),
      // NO coldAutoEnabled → defaults to ()=>false ⇒ the whole fork is inert.
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/cold.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        getLoopCarryNoteFn,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect((injectPsuHost.mock.calls[0] as unknown as [string, { mode: string }])[1].mode).toBe('turn');
    expect(getLoopCarryNoteFn).not.toHaveBeenCalled();
  });

  it('P-006 guard: cold + enabled but NO carry-note anchor → stays WARM (never cold-start with nothing to rebuild from)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload() }),
      coldDeps({ getLoopCarryNoteFn: vi.fn(async () => null) as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
  });

  it('a cold marker with NO harness scope → WARM, short-circuited before the flag read', async () => {
    const coldAutoEnabled = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: { carry: 'cold', wakeCount: 1 } }),
      coldDeps({ coldAutoEnabled }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(coldAutoEnabled).not.toHaveBeenCalled();
  });

  it('a WARM loop wake (carry!=="cold") never touches the cold path — gate + note untouched', async () => {
    const coldAutoEnabled = vi.fn(async () => true);
    const getLoopCarryNoteFn = vi.fn(async () => 'note');
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: { carry: 'warm', wakeCount: 3, harness: 'papercusp' } }),
      coldDeps({ coldAutoEnabled, getLoopCarryNoteFn }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(coldAutoEnabled).not.toHaveBeenCalled();
    expect(getLoopCarryNoteFn).not.toHaveBeenCalled();
  });

  it('FAIL-SOFT: a COLD inject that misses falls back to a WARM inject in place (never drops the wake)', async () => {
    let call = 0;
    const injectPsuHost = vi.fn(async () => call++ !== 0); // 1st (cold reset) misses, 2nd (warm) lands
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload() }),
      coldDeps({ injectPsuHost: injectPsuHost as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(injectPsuHost).toHaveBeenCalledTimes(2);
    expect((injectPsuHost.mock.calls[0] as unknown as [string, { mode: string }])[1].mode).toBe('reset');
    expect((injectPsuHost.mock.calls[1] as unknown as [string, { mode: string }])[1].mode).toBe('turn');
  });

  it('FAIL-SOFT: a carry-note read that THROWS falls back to WARM (a cold-path fault never drops a wake)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload() }),
      coldDeps({
        getLoopCarryNoteFn: vi.fn(async () => {
          throw new Error('pg down');
        }) as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
  });
});

describe('executeWake — P-021 verdict-gated cold-by-default (deterministic-context-carry, WI-5000)', () => {
  // The NO-carry loop marker a WARM loop's fire now stamps ({wakeCount, harness}).
  const warmLoopPayload = (over: Record<string, unknown> = {}) => ({
    wakeCount: 1,
    harness: 'papercusp',
    ...over,
  });
  const hostView = { sock: '/tmp/psu-pty/p021.sock', bridgeTty: false, lastInputAt: null };
  const p021Deps = (over: Partial<ExecuteWakeDeps> = {}): ExecuteWakeDeps =>
    deps({
      findPsuHost: vi.fn(() => ({ ...hostView })) as never,
      injectPsuHost: vi.fn(async () => true) as never,
      coldAutoEnabled: vi.fn(async () => true),
      classDefaultCold: vi.fn(async () => true),
      getLoopCarryNoteFn: vi.fn(async () => '## Next action\ncontinue the drain'),
      ...over,
    });

  it('a no-carry loop wake on a drill-proven class colds (RESET) WITHOUT the per-loop opt-in — and the resolver receives the HOST view (bridgeTty/lastInputAt)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const classDefaultCold = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload() }),
      p021Deps({ injectPsuHost: injectPsuHost as never, classDefaultCold }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    expect((injectPsuHost.mock.calls[0] as unknown as [string, { mode: string; data: string }])[1].mode).toBe('reset');
    expect((injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data).toContain(
      '## Next action\ncontinue the drain',
    );
    expect(classDefaultCold).toHaveBeenCalledWith(expect.objectContaining({ bridgeTty: false, lastInputAt: null }));
  });

  it('the HYBRID recycle cadence applies on the verdict route too (wakeCount 8 → RECYCLE)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload({ wakeCount: 8 }) }),
      p021Deps(),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle' });
  });

  it('DORMANT by default: with NO classDefaultCold dep wired, a no-carry loop wake stays WARM and never reads the carry-note (today’s behavior, byte-identical)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const getLoopCarryNoteFn = vi.fn(async () => 'note');
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload() }),
      deps({
        findPsuHost: vi.fn(() => ({ ...hostView })) as never,
        injectPsuHost: injectPsuHost as never,
        coldAutoEnabled: vi.fn(async () => true),
        getLoopCarryNoteFn,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect((injectPsuHost.mock.calls[0] as unknown as [string, { mode: string }])[1].mode).toBe('turn');
    expect(getLoopCarryNoteFn).not.toHaveBeenCalled();
  });

  it('a FALSE verdict (class unproven / active exchange / flag off) stays WARM without a note read', async () => {
    const getLoopCarryNoteFn = vi.fn(async () => 'note');
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload() }),
      p021Deps({ classDefaultCold: vi.fn(async () => false), getLoopCarryNoteFn }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(getLoopCarryNoteFn).not.toHaveBeenCalled();
  });

  it('the MASTER gate (SU_COLD_AUTO) outranks the verdict: gate off ⇒ the resolver is never consulted', async () => {
    const classDefaultCold = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload() }),
      p021Deps({ coldAutoEnabled: vi.fn(async () => false), classDefaultCold }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(classDefaultCold).not.toHaveBeenCalled();
  });

  it('an explicitly COLD-armed loop never consults the verdict (the opt-in route needs none)', async () => {
    const classDefaultCold = vi.fn(async () => false);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: { carry: 'cold', wakeCount: 1, harness: 'papercusp' } }),
      p021Deps({ classDefaultCold }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    expect(classDefaultCold).not.toHaveBeenCalled();
  });

  it('a NON-loop wake (no payload marker) never consults the verdict', async () => {
    const classDefaultCold = vi.fn(async () => true);
    const out = await executeWake(work({ wakeHandle: advHandle() }), p021Deps({ classDefaultCold }));
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(classDefaultCold).not.toHaveBeenCalled();
  });

  it('FAIL-SOFT: a THROWING verdict resolver stays WARM — never a dropped wake', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload() }),
      p021Deps({
        classDefaultCold: vi.fn(async () => {
          throw new Error('ledger unreadable');
        }),
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
  });

  it('P-006 unchanged on the verdict route: no carry-note anchor ⇒ WARM', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload() }),
      p021Deps({ getLoopCarryNoteFn: vi.fn(async () => null) as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
  });
});

describe('applyInjectionDoor (deterministic-context-carry P-006 leg (b))', () => {
  it('a wake within the door passes through byte-identical (the common case pays nothing)', () => {
    const text = 'a normal-sized wake';
    expect(applyInjectionDoor(work(), text)).toBe(text);
  });

  it('an over-door wake is packed to the budget from whole sections; each left-out section is named and the FULL text is spilled', () => {
    const d = work({ id: 990_001, subscriberId: 'su-door-test' });
    // P-024 clause D: 400 paragraphs, headline first and a `## Next action` section last.
    const text = [
      'HEADLINE loop wake #7',
      ...Array.from({ length: 400 }, (_, i) => `carry-note paragraph ${i} with enough words to overflow the injection budget`),
      '## Next action\nRun the typecheck.',
    ].join('\n\n');
    const out = applyInjectionDoor(d, text);
    const budget = computeTurnDoors(0, getDoorConstantsSync(d.subscriberId)).injections * CHARS_PER_TOKEN_ESTIMATE;
    expect(out.length).toBeLessThanOrEqual(budget);
    expect(out.startsWith('HEADLINE loop wake #7')).toBe(true);
    expect(out).toContain('## Next action\nRun the typecheck.');
    expect(out).not.toMatch(/was truncated/);
    const m = out.match(/in full at (\S+) \(see its section index\)/);
    expect(m).not.toBeNull();
    const spillPath = m![1];
    expect(spillPath).toContain(join('.papercusp', 'wake-spills', 'su-door-test', 'delivery-990001-'));
    const spilled = readFileSync(spillPath, 'utf8');
    expect(spilled).toContain(text); // the WHOLE original, not just the overflow
    expect(spilled).toContain('## Section index');
    expect(spilled).toMatch(/LEFT OUT — "carry-note paragraph \d+/);
    rmSync(spillPath, { force: true });
  });

  it('preserves each retry snapshot when delivery-time evidence changes', () => {
    const d = work({ id: 990_003, subscriberId: 'su-door-retry-test' });
    const narrative = Array.from({ length: 400 }, (_, i) => `Historical paragraph ${i}: ${'detail '.repeat(30)}`).join('\n\n');
    const first = `HEADLINE first delivery read\n\n${narrative}`;
    const second = `HEADLINE later delivery read\n\n${narrative}`;
    const pointer = (out: string) => out.match(/in full at (\S+) \(see its section index\)/)?.[1];
    const firstPath = pointer(applyInjectionDoor(d, first));
    const secondPath = pointer(applyInjectionDoor(d, second));
    try {
      expect(firstPath).toBeTruthy();
      expect(secondPath).toBeTruthy();
      expect(secondPath).not.toBe(firstPath);
      expect(readFileSync(firstPath!, 'utf8')).toContain(first);
      expect(readFileSync(firstPath!, 'utf8')).not.toContain('HEADLINE later delivery read');
      expect(readFileSync(secondPath!, 'utf8')).toContain(second);
      const original = readFileSync(secondPath!, 'utf8');
      expect(pointer(applyInjectionDoor(d, second))).toBe(secondPath);
      expect(readFileSync(secondPath!, 'utf8')).toBe(original);
    } finally {
      if (firstPath) rmSync(firstPath, { force: true });
      if (secondPath) rmSync(secondPath, { force: true });
    }
  });

  it('repairs an incomplete spill left at the immutable path before reusing its pointer', () => {
    const d = work({ id: 990_004, subscriberId: 'su-door-partial-retry-test' });
    const text = [
      'HEADLINE interrupted spill retry',
      ...Array.from({ length: 400 }, (_, i) => `delivery paragraph ${i}: ${'evidence '.repeat(12)}`),
      '## Next action\nRead the full spill.',
    ].join('\n\n');
    const pointer = (out: string) => out.match(/in full at (\S+) \(see its section index\)/)?.[1];
    const firstPath = pointer(applyInjectionDoor(d, text));
    expect(firstPath).toBeTruthy();
    try {
      writeFileSync(firstPath!, '# interrupted before the full spill was written\n', { mode: 0o600 });

      const retry = applyInjectionDoor(d, text);

      expect(pointer(retry)).toBe(firstPath);
      expect(readFileSync(firstPath!, 'utf8')).toContain('## Section index');
      expect(readFileSync(firstPath!, 'utf8')).toContain(text);
    } finally {
      if (firstPath) rmSync(firstPath, { force: true });
    }
  });

  it('kill-switch PAPERCUSP_INJECTION_DOOR_OFF=1 bypasses the door entirely', () => {
    const prev = process.env.PAPERCUSP_INJECTION_DOOR_OFF;
    process.env.PAPERCUSP_INJECTION_DOOR_OFF = '1';
    try {
      const text = 'y'.repeat(50_000);
      expect(applyInjectionDoor(work(), text)).toBe(text);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_INJECTION_DOOR_OFF;
      else process.env.PAPERCUSP_INJECTION_DOOR_OFF = prev;
    }
  });
});
