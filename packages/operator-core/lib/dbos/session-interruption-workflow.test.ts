import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInterruptionRuntime } from '../harness/routines/session-interruption-runtime';
import type { SessionRecoveryEvidence } from '../harness/routines/session-interruption-recovery';
vi.mock('./bootstrap', () => ({ withDbosIdleTxGrace: (dsn: string) => dsn }));
vi.mock('../harness/routines/session-interruption-runtime', () => ({ createSessionInterruptionRuntime: vi.fn() }));
import { configureSessionInterruptionRuntime, enqueueSessionInterruption, runSessionInterruption,
  sessionInterruptionWorkflowId, type SessionRecoveryStepHost } from './session-interruption-workflow';

const input = { workspaceId: 'ws', installSlug: 'papercusp', ownerId: 'su-test', key: 'interruption:su-test:native:12:100' };
let current: SessionRecoveryEvidence;
let runtime: SessionInterruptionRuntime;
let live: boolean;
const names: string[] = [];
const host: SessionRecoveryStepHost = {
  step: async (name, fn) => { names.push(name); return fn(); },
  sleepUntil: async deadline => { vi.setSystemTime(Math.max(Date.now(), deadline)); },
};
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1000); live = false; names.length = 0;
  current = { ownerId: input.ownerId, nativeSessionId: 'native', liveness: 'dead', retired: false,
    recoveryEnabled: true, deliberatelyPaused: false, launchRecipeAvailable: true, headless: true,
    meaningfulWaits: 0, humanDecisionPending: false, actionableHeldWork: 0, loop: null,
    interruption: { v: 1, ownerId: input.ownerId, nativeSessionId: 'native', hostPid: 12, hostStartedAt: 100,
      capturedAt: 900, attempts: 0, nextAttemptAt: 0, state: 'pending',
      execution: { ownerId: input.ownerId, hostPid: 12, observedAt: 800, phase: 'running',
        turnStartedAt: 200, lastProgressAt: 800, pendingTools: 0 } } };
  runtime = {
    list: vi.fn(async () => [structuredClone(current)]),
    read: vi.fn(async () => structuredClone(current)),
    claim: vi.fn(async candidate => {
      current = structuredClone(candidate);
      Object.assign(current.interruption!, { attempts: current.interruption!.attempts + 1,
        actionId: sessionInterruptionWorkflowId(input),
        leaseKey: 'lease-' + (current.interruption!.attempts + 1), state: 'recovering', nextAttemptAt: Date.now() + 500 });
      return structuredClone(current);
    }),
    verify: vi.fn(async () => ({ verified: live, reason: live ? 'exact-native-host-verified' : 'absent' })),
    markDispatch: vi.fn(async () => { current.interruption!.dispatchStartedAt = Date.now(); return true; }),
    restore: vi.fn(async () => { live = true; return { verified: true, reason: 'launched' }; }),
    finish: vi.fn(async (_candidate, _key, outcome) => {
      Object.assign(current.interruption!, { state: outcome.verified ? 'restored' : outcome.terminal ? 'blocked' : 'pending',
        leaseKey: null, nextAttemptAt: Date.now() + 100 });
      return true;
    }),
    protectedOwnerIds: new Set(),
  };
  configureSessionInterruptionRuntime(async () => runtime);
});
afterEach(() => { configureSessionInterruptionRuntime(null); vi.useRealTimers(); });

describe('action-scoped interruption recovery', () => {
  it('checkpoints admission, reservation, guarded launch, actual identity and settlement separately', async () => {
    expect(await runSessionInterruption(input, host)).toMatchObject({ verified: true });
    expect(names).toEqual(['recovery:0:admission', 'recovery:0:reservation', 'recovery:0:guarded-launch',
      'recovery:0:native-identity', 'recovery:0:settlement']);
    expect(runtime.restore).toHaveBeenCalledTimes(1);
    expect(runtime.verify).toHaveBeenCalledTimes(2);
  });
  it.each(['stop', 'retirement', 'authority', 'human-wait', 'surviving-writer'])('re-reads %s after checkpointed reservation', async kind => {
    const step: SessionRecoveryStepHost = { ...host, step: async (name, fn) => {
      const value = await fn();
      if (name.endsWith(':reservation')) {
        if (kind === 'stop') current.interruption!.execution.ownerStopRequested = true;
        if (kind === 'retirement') current.retired = true;
        if (kind === 'authority') current.recoveryEnabled = false;
        if (kind === 'human-wait') current.humanDecisionPending = true;
        if (kind === 'surviving-writer') current.liveness = 'live';
      }
      return value;
    } };
    expect(await runSessionInterruption(input, step)).toMatchObject({ verified: false, terminal: true });
    expect(runtime.restore).not.toHaveBeenCalled();
    expect(runtime.markDispatch).not.toHaveBeenCalled();
  });
  it('holds an unacknowledged dispatch even when its lease expired; it never refunds the uncertain creation', async () => {
    const step: SessionRecoveryStepHost = { ...host, step: async (name, fn) => {
      const value = await fn();
      if (name.endsWith(':reservation')) {
        current.interruption!.dispatchStartedAt = 1000;
        vi.setSystemTime(2000);
      }
      return value;
    } };
    expect(await runSessionInterruption(input, step)).toEqual({ verified: false, terminal: true, reason: 'uncertain-native-creation' });
    expect(runtime.restore).not.toHaveBeenCalled();
    expect(current.interruption!.attempts).toBe(1);
    expect(current.interruption!.state).toBe('blocked');
  });
  it('reconciles the surviving exact host when launch ran but its step outcome was lost', async () => {
    const saved = new Map<string, unknown>();
    let crash = true;
    const replay: SessionRecoveryStepHost = { ...host, step: async (name, fn) => {
      if (saved.has(name)) return structuredClone(saved.get(name)) as never;
      const value = await fn();
      if (name.endsWith(':guarded-launch') && crash) { crash = false; throw new Error('controller-death'); }
      saved.set(name, structuredClone(value));
      return value;
    } };
    await expect(runSessionInterruption(input, replay)).rejects.toThrow('controller-death');
    expect(await runSessionInterruption(input, replay)).toMatchObject({ verified: true });
    expect(runtime.restore).toHaveBeenCalledTimes(1);
    expect(runtime.claim).toHaveBeenCalledTimes(1);
  });
  it('adopts its own SQL reservation when its DBOS checkpoint was lost', async () => {
    const saved = new Map<string, unknown>();
    let crash = true;
    const replay: SessionRecoveryStepHost = { ...host, step: async (name, fn) => {
      if (saved.has(name)) return structuredClone(saved.get(name)) as never;
      const value = await fn();
      if (name.endsWith(':reservation') && crash) { crash = false; throw new Error('lost-reservation-result'); }
      saved.set(name, structuredClone(value)); return value;
    } };
    await expect(runSessionInterruption(input, replay)).rejects.toThrow('lost-reservation-result');
    expect(await runSessionInterruption(input, replay)).toMatchObject({ verified: true });
    expect(runtime.claim).toHaveBeenCalledTimes(1);
    expect(current.interruption!.attempts).toBe(1);
  });
  it('retries an expired undispatched reservation against persisted absolute deadlines', async () => {
    let expired = false;
    const step: SessionRecoveryStepHost = { ...host, step: async (name, fn) => {
      const value = await fn();
      if (name.endsWith(':reservation') && !expired) { expired = true; vi.setSystemTime(1600); }
      return value;
    } };
    expect(await runSessionInterruption(input, step)).toMatchObject({ verified: true });
    expect(runtime.claim).toHaveBeenCalledTimes(2);
    expect(runtime.restore).toHaveBeenCalledTimes(1);
    expect(current.interruption!.attempts).toBe(2);
  });
  it('requires actual native identity even when the launcher claimed success', async () => {
    vi.mocked(runtime.restore).mockResolvedValue({ verified: true, reason: 'reported-success' });
    expect(await runSessionInterruption(input, host)).toMatchObject({ verified: false, terminal: true, reason: 'native-identity-unconfirmed' });
  });
  it('deduplicates repeated enqueue, separates workspaces and changes identity with host incarnation', async () => {
    const enqueue = vi.fn(async () => ({}));
    const client = async () => ({ enqueue }) as never;
    await enqueueSessionInterruption(input, client); await enqueueSessionInterruption(input, client);
    expect(enqueue.mock.calls[0]).toEqual(enqueue.mock.calls[1]);
    expect(sessionInterruptionWorkflowId({ ...input, workspaceId: 'other' })).not.toBe(sessionInterruptionWorkflowId(input));
    expect(sessionInterruptionWorkflowId({ ...input, key: input.key + ':next-host' })).not.toBe(sessionInterruptionWorkflowId(input));
  });
});
