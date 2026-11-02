import { describe, expect, it, vi } from 'vitest';
import { classifySessionInterruption, recoverInterruptedSessions, sessionRecoveryKey,
  type SessionRecoveryEvidence } from './session-interruption-recovery';

const now = 20_000;
function candidate(over: Partial<SessionRecoveryEvidence> = {}): SessionRecoveryEvidence {
  return { ownerId: 'solo', nativeSessionId: 'native', liveness: 'dead', retired: false,
    recoveryEnabled: true, deliberatelyPaused: false, launchRecipeAvailable: true, headless: false,
    meaningfulWaits: 0, humanDecisionPending: false, actionableHeldWork: 0, loop: null,
    interruption: { v: 1, ownerId: 'solo', nativeSessionId: 'native', hostPid: 123,
      hostStartedAt: 1000, capturedAt: 10_000, attempts: 0, nextAttemptAt: 0, state: 'pending',
      execution: { phase: 'running', turnStartedAt: 2000, lastProgressAt: 3000, pendingTools: 0,
        observedAt: 9000, ownerId: 'solo', hostPid: 123 } }, ...over };
}

describe('session interruption eligibility', () => {
  it('recovers an interactive request without any loop, fleet or held work', () => {
    expect(classifySessionInterruption(candidate(), now)).toEqual({
      action: 'resume-work', reason: 'interrupted-native-turn', headless: false,
    });
  });
  it.each(['solo-loop', 'fleet-held-work'])('recovers authorized unfinished %s after a settled turn', kind => {
    const c = candidate(kind === 'solo-loop'
      ? { loop: { active: true, goal: 'finish the existing task', nextFireAt: now - 1 } }
      : { actionableHeldWork: 1 });
    c.interruption!.execution.phase = 'settled';
    expect(classifySessionInterruption(c, now)).toMatchObject({ action: 'resume-work',
      reason: kind === 'solo-loop' ? 'due-loop' : 'actionable-held-work' });
  });
  it('rejects a stale incarnation even when the owner still holds work', () => {
    const c = candidate({ actionableHeldWork: 1 });
    c.interruption!.nativeSessionId = 'superseded-native';
    expect(classifySessionInterruption(c, now)).toEqual({ action: 'hold', reason: 'identity-mismatch' });
  });
  it('does not infer an unfinished request from an unknown native phase', () => {
    const c = candidate(); c.interruption!.execution.phase = 'unknown';
    expect(classifySessionInterruption(c, now)).toEqual({ action: 'hold', reason: 'no-authorized-work-evidence' });
  });
  it.each([true, false])('preserves saved headless=%s', headless => {
    expect(classifySessionInterruption(candidate({ headless }), now)).toMatchObject({ action: 'resume-work', headless });
  });
  it.each([
    [{ retired: true }, 'retired'], [{ deliberatelyPaused: true }, 'deliberate-pause'],
    [{ recoveryEnabled: false }, 'recovery-disabled'], [{ liveness: 'live' }, 'already-running'],
    [{ liveness: 'unknown' }, 'liveness-unknown'], [{ meaningfulWaits: null }, 'waiting-state-unknown'],
    [{ humanDecisionPending: true }, 'human-decision-pending'], [{ headless: null }, 'launch-recipe-unknown'],
    [{ nativeSessionId: 'other' }, 'identity-mismatch'],
  ] as const)('holds unsafe recovery: %s', (over, reason) => {
    expect(classifySessionInterruption(candidate(over), now)).toEqual({ action: 'hold', reason });
  });
  it('restores deliberate event waiting without requesting work', () => {
    expect(classifySessionInterruption(candidate({ meaningfulWaits: 1 }), now)).toMatchObject({ action: 'restore-wait' });
  });
  it('preserves the future loop boundary instead of immediately waking it', () => {
    expect(classifySessionInterruption(candidate({ loop: { active: true, goal: 'finish work', nextFireAt: now + 1 } }), now))
      .toMatchObject({ action: 'restore-wait', reason: 'scheduled-loop' });
  });
  it('does not revive completed work just because an old loop row remains', () => {
    const c = candidate({ loop: { active: false, goal: 'old work', nextFireAt: null } });
    c.interruption!.execution.phase = 'settled';
    expect(classifySessionInterruption(c, now)).toEqual({ action: 'hold', reason: 'completed-or-idle' });
  });
  it.each(['ownerInputPending', 'ownerStopRequested'] as const)('honors native %s', field => {
    const c = candidate(); c.interruption!.execution[field] = true;
    expect(classifySessionInterruption(c, now).action).toBe('hold');
  });
  it.each(['attempts', 'nextAttemptAt'] as const)('bounds repeated failures using %s', field => {
    const c = candidate(); c.interruption![field] = field === 'attempts' ? 3 : now + 1;
    expect(classifySessionInterruption(c, now).action).toBe('hold');
  });
  it('rejects an observation from a different host incarnation', () => {
    const c = candidate(); c.interruption!.execution.hostPid = 456;
    expect(classifySessionInterruption(c, now)).toEqual({ action: 'hold', reason: 'execution-witness-invalid' });
  });
});

describe('bounded interruption reconciliation', () => {
  it('finishes a reserved lease even when the fresh evidence refuses recovery', async () => {
    const finish = vi.fn();
    const c = candidate();
    await recoverInterruptedSessions({ list: async () => [c], claim: async () => ({ ...c, retired: true }),
      restore: vi.fn(), finish }, now);
    expect(finish).toHaveBeenCalledWith(expect.anything(), sessionRecoveryKey(c.interruption!),
      { verified: false, reason: 'retired' });
  });
  it('permits its own last reserved attempt without allowing another reconciler past the lease', async () => {
    const c = candidate(); c.interruption!.attempts = 2;
    const key = sessionRecoveryKey(c.interruption!);
    const reserved = { ...c, interruption: { ...c.interruption!, attempts: 3, state: 'recovering' as const,
      nextAttemptAt: now + 300_000, leaseKey: key } };
    expect(classifySessionInterruption(reserved, now).action).toBe('hold');
    const restore = vi.fn(async () => ({ verified: true, reason: 'exact-native-host' }));
    const r = await recoverInterruptedSessions({ list: async () => [c], claim: async () => reserved,
      restore, finish: vi.fn() }, now);
    expect(r.restored).toEqual(['solo']);
    expect(restore).toHaveBeenCalledTimes(1);
  });
  it('rechecks retirement after acquiring ownership', async () => {
    const c = candidate(); const restore = vi.fn();
    const result = await recoverInterruptedSessions({ list: async () => [c],
      claim: async () => ({ ...c, retired: true }), restore, finish: vi.fn() }, now);
    expect(restore).not.toHaveBeenCalled();
    expect(result.held.solo).toBe('retired');
  });
  it('never launches after losing the atomic recovery claim', async () => {
    const restore = vi.fn();
    await recoverInterruptedSessions({ list: async () => [candidate()], claim: async () => null,
      restore, finish: vi.fn() }, now);
    expect(restore).not.toHaveBeenCalled();
  });
  it('records launch failures and forwards the exact replay key and wait disposition', async () => {
    const c = candidate({ meaningfulWaits: 1 }); const finish = vi.fn();
    const restore = vi.fn(async () => { throw new Error('provider unavailable'); });
    const result = await recoverInterruptedSessions({ list: async () => [c], claim: async () => c,
      restore, finish }, now);
    expect(restore).toHaveBeenCalledWith(c, { action: 'restore-wait', reason: 'meaningful-event-wait', headless: false },
      sessionRecoveryKey(c.interruption!));
    expect(finish).toHaveBeenCalledWith(c, sessionRecoveryKey(c.interruption!),
      { verified: false, reason: 'provider unavailable' });
    expect(result.restored).toEqual([]);
  });
});
