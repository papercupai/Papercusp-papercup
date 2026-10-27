import { describe, expect, it, vi } from 'vitest';
import {
  ASSUME_TOKEN_TTL_MS, assumePreparationFingerprint, assumeTransitionKey, commitAssume,
  prepareAssume, reserveAssumeTarget, validateAssume,
  qualifiesAssumeExecution, reconcileAssumeTransition, verifyAssumeExecution,
  type AssumeActor, type AssumeCaller, type AssumePreparationDeps, type AssumeTarget,
  type AssumeRequest, type AssumeTransitionDeps, type AssumeTransitionReceipt, type AssumeExecutionObservation,
} from '../../session-assume';

const actor: AssumeActor = { ownerId: 'su-caller', workspaceId: 'workspace-a' };
const request = { requestId: 'request-a', targetOwnerId: 'su-target', contextMode: 'native-resume' as const };
const hash = 'a'.repeat(64);

function fixture() {
  let now = 1_000;
  const caller: AssumeCaller = { ...actor, nativeSessionId: 'caller-native', incarnation: 'caller-start',
    hostId: 'host-a', attachmentId: 'pty-a', backend: 'codex', nativePid: 101 };
  const target: AssumeTarget = { ownerId: 'su-target', workspaceId: actor.workspaceId, harnessSlug: 'harness-a',
    advSessionId: 42, nativeSessionId: 'target-native', executionNativeSessionId: 'target-native', backend: 'codex', role: 'su',
    binding: { coordOwnerId: 'su-target', sessionId: 'target-native', startedAt: '2026-10-23 20:00:00.123456-04' },
    writerGeneration: 'writer-7', writer: 'free', ended: true, liveHost: false,
    context: { mode: 'native-resume', ref: 'target-native', sha256: hash, revision: 'transcript-7' } };
  const deps: AssumePreparationDeps = {
    now: () => now, secret: Buffer.alloc(32, 7),
    authorize: vi.fn(async () => 'launch-envelope:admin-1'),
    caller: vi.fn(async () => structuredClone(caller)),
    target: vi.fn(async () => structuredClone(target)),
  };
  return { deps, caller, target, advance: (ms: number) => { now += ms; } };
}

async function prepared(f: ReturnType<typeof fixture>, override: AssumeRequest = request) {
  const result = await prepareAssume(actor, override, f.deps);
  if (!result.ok) throw new Error(result.code);
  return result;
}

describe('session:assume preparation and exact custody', () => {
  it('R-12 preview preserves caller and target runtime and durable snapshots', async () => {
    const f = fixture();
    const before = JSON.stringify({ caller: f.caller, target: f.target });
    const result = await prepared(f);
    expect(result.state).toBe('prepared');
    expect(JSON.stringify({ caller: f.caller, target: f.target })).toBe(before);
    expect(result.token).not.toContain(f.target.nativeSessionId);
    expect(Buffer.from(result.token, 'base64url').includes(Buffer.from('su-target'))).toBe(false);
    expect(await validateAssume(actor, result.token, f.deps)).toMatchObject({ ok: true });
  });

  it('R-9 unauthorized takeover refuses without disclosure or mutation', async () => {
    const f = fixture();
    vi.mocked(f.deps.authorize).mockResolvedValue(null);
    expect(await prepareAssume(actor, request, f.deps)).toEqual({ ok: false, code: 'unauthorized' });
    expect(await validateAssume(actor, 'untrusted-token', f.deps)).toEqual({ ok: false, code: 'unauthorized' });
    expect(f.deps.target).not.toHaveBeenCalled();
    expect(f.deps.caller).not.toHaveBeenCalled();
  });

  it('R-9 exact caller target incarnation context and expiry bind admission', async () => {
    const f = fixture();
    const result = await prepared(f);
    expect(await validateAssume({ ...actor, ownerId: 'su-other' }, result.token, f.deps))
      .toEqual({ ok: false, code: 'caller-changed' });
    expect(await validateAssume({ ...actor, workspaceId: 'workspace-b' }, result.token, f.deps))
      .toEqual({ ok: false, code: 'caller-changed' });
    const bytes = Buffer.from(result.token, 'base64url');
    bytes[bytes.length - 1] ^= 1;
    expect(await validateAssume(actor, bytes.toString('base64url'), f.deps))
      .toEqual({ ok: false, code: 'invalid-token' });
    expect(await validateAssume(actor, result.token, { ...f.deps, secret: Buffer.alloc(32, 8) }))
      .toEqual({ ok: false, code: 'invalid-token' });
    f.advance(ASSUME_TOKEN_TTL_MS);
    expect(await validateAssume(actor, result.token, f.deps)).toEqual({ ok: false, code: 'expired-token' });
  });

  it('R-9 commit rechecks administrative authority and reviewer restrictions', async () => {
    const f = fixture();
    const result = await prepared(f);
    vi.mocked(f.deps.authorize).mockImplementation(async (_actor, role) => role ? null : 'launch-envelope:admin-1');
    expect(await validateAssume(actor, result.token, f.deps)).toEqual({ ok: false, code: 'unauthorized' });
    expect(f.deps.target).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['identity', (t: AssumeTarget) => { t.ownerId = 'su-ambiguous'; }],
    ['incarnation', (t: AssumeTarget) => { t.binding.startedAt += 'changed'; }],
    ['registration', (t: AssumeTarget) => { t.advSessionId += 1; }],
    ['native session', (t: AssumeTarget) => { t.nativeSessionId = 'replacement'; }],
    ['writer generation', (t: AssumeTarget) => { t.writerGeneration = 'writer-8'; }],
    ['context hash', (t: AssumeTarget) => { t.context.sha256 = 'b'.repeat(64); }],
    ['context revision', (t: AssumeTarget) => { t.context.revision = 'transcript-8'; }],
    ['backend', (t: AssumeTarget) => { t.backend = 'claude'; }],
  ] as const)('R-4 stale target incarnation and writer generation refuses unchanged: %s', async (_name, mutate) => {
    const f = fixture();
    const result = await prepared(f);
    mutate(f.target);
    const current = JSON.stringify(f.target);
    expect(await validateAssume(actor, result.token, f.deps)).toMatchObject({ ok: false });
    expect(JSON.stringify(f.target)).toBe(current);
  });

  it('R-4 same textual target in foreign workspace refuses', async () => {
    const f = fixture();
    f.target.workspaceId = 'workspace-b';
    expect(await prepareAssume(actor, request, f.deps)).toEqual({ ok: false, code: 'foreign-workspace' });
  });

  it.each([
    ['live host', (t: AssumeTarget) => { t.liveHost = true; }, 'target-live'],
    ['live registration', (t: AssumeTarget) => { t.ended = false; }, 'target-live'],
    ['active writer', (t: AssumeTarget) => { t.writer = 'held'; }, 'target-live'],
    ['unknown writer', (t: AssumeTarget) => { t.writer = 'unknown'; }, 'writer-unknown'],
    ['self', (t: AssumeTarget) => { t.ownerId = actor.ownerId; }, 'self-target'],
  ] as const)('refuses %s before custody', async (_name, mutate, code) => {
    const f = fixture();
    mutate(f.target);
    expect(await prepareAssume(actor, request, f.deps)).toEqual({ ok: false, code });
  });

  it.each(['hostId', 'attachmentId', 'incarnation', 'nativeSessionId'] as const)(
    'refuses changed caller %s before displacement', async field => {
      const f = fixture();
      const result = await prepared(f);
      f.caller[field] += '-changed';
      expect(await validateAssume(actor, result.token, f.deps)).toEqual({ ok: false, code: 'caller-changed' });
    },
  );

  it('R-3 checkpoint selection pins revision hash and fresh context', async () => {
    const f = fixture();
    f.target.context = { mode: 'checkpoint', ref: 'checkpoint:target:4', sha256: hash, revision: '4' };
    f.target.executionNativeSessionId = null;
    const result = await prepared(f, { ...request, contextMode: 'checkpoint' });
    expect(result.preparation.target.context).toEqual(f.target.context);
    expect(await validateAssume(actor, result.token, f.deps)).toMatchObject({ ok: true });
    f.target.context.revision = '5';
    expect(await validateAssume(actor, result.token, f.deps)).toEqual({ ok: false, code: 'target-changed' });
  });

  it('R-3 native resume preserves exact conversation and backend', async () => {
    const f = fixture();
    const result = await prepared(f);
    expect(result.preparation.target).toMatchObject({
      ownerId: f.target.ownerId, nativeSessionId: 'target-native',
      executionNativeSessionId: 'target-native', backend: 'codex',
      context: { mode: 'native-resume', ref: 'target-native', sha256: hash, revision: 'transcript-7' },
    });
    // A different native conversation must require a new preparation even when
    // the public identity and checkpoint bytes happen to be identical.
    f.target.nativeSessionId = 'other-conversation';
    f.target.executionNativeSessionId = 'other-conversation';
    f.target.binding.sessionId = 'other-conversation';
    f.target.context.ref = 'other-conversation';
    expect(await validateAssume(actor, result.token, f.deps))
      .toEqual({ ok: false, code: 'target-changed' });
  });

  it('R-10 tampered mismatched or non-target checkpoint refuses before custody', async () => {
    const mutations: Array<(target: AssumeTarget) => void> = [
      target => { target.context.sha256 = 'b'.repeat(64); },
      target => { target.context.revision = 'checkpoint-8'; },
      target => { target.context.ref = 'carry-note:caller-private-history'; },
      target => { target.ownerId = 'su-another-target'; },
      target => { target.workspaceId = 'foreign-workspace'; },
      target => { target.binding.startedAt += '-replacement'; },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      f.target.context = { mode: 'checkpoint', ref: 'carry-note:target', sha256: hash, revision: 'checkpoint-7' };
      f.target.executionNativeSessionId = null;
      const result = await prepared(f, { ...request, contextMode: 'checkpoint' });
      mutate(f.target);
      const before = structuredClone({ caller: f.caller, target: f.target });
      const refused = await validateAssume(actor, result.token, f.deps);
      expect(refused).toMatchObject({ ok: false });
      expect(JSON.stringify(refused)).not.toContain('caller-private-history');
      expect({ caller: f.caller, target: f.target }).toEqual(before);
    }
    const f = fixture();
    f.target.context = { mode: 'checkpoint', ref: 'carry-note:target', sha256: hash, revision: 'checkpoint-7' };
    f.target.executionNativeSessionId = null;
    const result = await prepared(f, { ...request, contextMode: 'checkpoint' });
    const bytes = Buffer.from(result.token, 'base64url');
    bytes[bytes.length - 1] ^= 1;
    expect(await validateAssume(actor, bytes.toString('base64url'), f.deps))
      .toEqual({ ok: false, code: 'invalid-token' });
  });

  it('R-10 caller history credentials and unapproved environment do not cross context boundary', async () => {
    for (const key of ['transcript', 'toolHistory', 'credentials', 'environment']) {
      const f = fixture();
      Object.assign(f.caller, { [key]: 'private caller material' });
      const before = structuredClone(f.caller);
      const result = await prepareAssume(actor, request, f.deps);
      expect(result).toEqual({ ok: false, code: 'caller-changed' });
      expect(f.deps.target).not.toHaveBeenCalled();
      expect(f.caller).toEqual(before);
      expect(JSON.stringify(result)).not.toContain('private caller material');
    }
    for (const part of ['target', 'context'] as const) {
      const f = fixture();
      Object.assign(part === 'target' ? f.target : f.target.context,
        { callerToolHistory: 'unapproved caller history', OPENAI_API_KEY: 'unapproved caller credential' });
      expect(await prepareAssume(actor, request, f.deps)).toEqual({ ok: false, code: 'invalid-target' });
    }
  });

  it('R-3 unavailable corrupt stale and incompatible context refuses without fallback', async () => {
    const f = fixture();
    f.target.context.mode = 'checkpoint';
    expect(await prepareAssume(actor, request, f.deps)).toEqual({ ok: false, code: 'context-unavailable' });
    f.target.context.mode = 'native-resume';
    f.target.context.sha256 = 'corrupt';
    expect(await prepareAssume(actor, request, f.deps)).toEqual({ ok: false, code: 'invalid-target' });
    vi.mocked(f.deps.target).mockResolvedValue(null);
    expect(await prepareAssume(actor, request, f.deps)).toEqual({ ok: false, code: 'context-unavailable' });
  });

  it('reuses the durable resume lease with the exact workspace and full-precision incarnation pin', async () => {
    const result = await prepared(fixture());
    const acquire = vi.fn(async () => ({ status: 'acquired' as const, acquired: true as const,
      replayed: false, leaseExpiresAt: new Date(121_000).toISOString() }));
    await reserveAssumeTarget(result.preparation, acquire);
    expect(acquire).toHaveBeenCalledWith(42, assumeTransitionKey(result.preparation), {
      workspaceId: actor.workspaceId, binding: result.preparation.target.binding, requireTerminal: true,
    });
    const retry = await prepared(fixture());
    expect(assumeTransitionKey(retry.preparation)).toBe(assumeTransitionKey(result.preparation));
  });

  it('preserves preparation identity after jsonb reorders nested object keys', async () => {
    const { preparation } = await prepared(fixture());
    const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)])) : value;
    expect(assumePreparationFingerprint(reorder(preparation) as typeof preparation))
      .toBe(assumePreparationFingerprint(preparation));
  });

  it('pins OMP native identity without inventing a registration session_id', async () => {
    const f = fixture();
    f.target.backend = 'omp';
    f.target.binding.sessionId = null;
    f.target.binding.ompThreadId = f.target.nativeSessionId;
    const { preparation } = await prepared(f);
    expect(preparation.target.binding.sessionId).toBeNull();
    expect(await validateAssume(actor, (await prepared(f)).token, f.deps)).toMatchObject({ ok: true });
  });
});

function transitionFixture() {
  let stored: AssumeTransitionReceipt | null = null;
  const effects: string[] = [];
  const writes: AssumeTransitionReceipt[] = [];
  const deps: AssumeTransitionDeps = {
    now: () => 2_000,
    claim: vi.fn(async initial => {
      if (stored) return { won: false, prior: structuredClone(stored) };
      stored = structuredClone(initial);
      return { won: true, prior: null };
    }),
    save: vi.fn(async receipt => {
      effects.push(`save:${receipt.state}`);
      stored = structuredClone(receipt);
      writes.push(structuredClone(receipt));
    }),
    reserve: vi.fn<AssumeTransitionDeps['reserve']>(async () => ({ status: 'acquired', acquired: true, replayed: false, leaseExpiresAt: 'later' })),
    checkpointCaller: vi.fn(async plan => {
      effects.push('checkpoint');
      return { checkpointRef: 'carry:caller:7', checkpointSha256: hash,
        returnRef: { ownerId: plan.caller.ownerId, workspaceId: plan.caller.workspaceId,
          nativeSessionId: plan.caller.nativeSessionId, incarnation: plan.caller.incarnation } };
    }),
    quiesceCaller: vi.fn<AssumeTransitionDeps['quiesceCaller']>(async () => {
      effects.push('quiesce');
      return { releasedWorkClaims: [{ id: 'WI-caller-work', checkpointRef: 'carry:work:3' }],
        releasedPlanClaims: [{ plan: 'caller-plan', item: 'P-001', checkpointRef: 'carry:plan:3' }],
        pausedLoopRef: 'loop:caller', pausedAwaitIds: [11], inbox: 'retained', directives: 'retained' };
    }),
    checkCustody: vi.fn(async () => true),
    restoreCaller: vi.fn(async () => { effects.push('restore'); return true; }),
    releaseTarget: vi.fn(async () => { effects.push('release'); return true; }),
    handoff: vi.fn<AssumeTransitionDeps['handoff']>(async () => { effects.push('handoff'); return 'accepted'; }),
  };
  return { deps, effects, writes, stored: () => stored };
}

describe('session:assume durable transition boundaries', () => {
  it('R-5 nonempty caller work and return reference survive handoff failure', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    vi.mocked(f.deps.handoff).mockResolvedValue('refused');
    const result = await commitAssume(plan, f.deps);
    expect(result.state).toBe('rolled-back');
    expect(result.recovery?.returnRef.nativeSessionId).toBe('caller-native');
    expect(result.disposition).toMatchObject({ inbox: 'retained', directives: 'retained',
      releasedWorkClaims: [{ id: 'WI-caller-work', checkpointRef: 'carry:work:3' }],
      pausedLoopRef: 'loop:caller', pausedAwaitIds: [11] });
    expect(f.deps.restoreCaller).toHaveBeenCalledOnce();
    expect(f.deps.releaseTarget).toHaveBeenCalledOnce();
    expect(f.stored()?.state).toBe('rolled-back');
  });

  it('R-6 accepted requires later process and routed probe verification', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    const result = await commitAssume(plan, f.deps);
    expect(result.state).toBe('handoff-accepted');
    expect(f.effects.indexOf('save:handoff-requested')).toBeLessThan(f.effects.indexOf('handoff'));
    expect(f.effects.indexOf('save:caller-checkpointed')).toBeLessThan(f.effects.indexOf('quiesce'));
    expect(f.effects.at(-1)).toBe('save:handoff-accepted');
    expect(result.state).not.toBe('target-verified');
  });

  it('R-6 timeout and host death remain recoverable indeterminate', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    vi.mocked(f.deps.handoff).mockRejectedValue(new Error('private credential or transcript must not leak'));
    const result = await commitAssume(plan, f.deps);
    expect(result).toMatchObject({ state: 'indeterminate', durable: true, reason: 'transition-failed' });
    expect(JSON.stringify(result)).not.toContain('private credential');
    expect(f.deps.restoreCaller).not.toHaveBeenCalled();
    expect(f.deps.releaseTarget).not.toHaveBeenCalled();
    expect(await commitAssume(plan, f.deps)).toMatchObject({ state: 'indeterminate', replayed: true });
    expect(f.deps.handoff).toHaveBeenCalledOnce();
    expect(f.deps.quiesceCaller).toHaveBeenCalledOnce();
  });

  it.each(['caller-checkpointed', 'caller-quiesced', 'target-custody-acquired', 'handoff-requested'] as const)(
    'R-8 fault injection at every transition boundary preserves custody and recovery: %s', async state => {
      const { preparation: plan } = await prepared(fixture());
      const f = transitionFixture();
      const save = vi.mocked(f.deps.save).getMockImplementation()!;
      // Fail at the selected durable boundary, while leaving rollback writes available.
      vi.mocked(f.deps.save).mockImplementation(async receipt => {
        if (receipt.state === state) throw new Error('write-failure');
        await save(receipt);
      });
      const result = await commitAssume(plan, f.deps);
      expect(result.state).toBe('rolled-back');
      expect(f.deps.handoff).not.toHaveBeenCalled();
      expect(f.deps.releaseTarget).toHaveBeenCalledOnce();
      expect(!!result.recovery).toBe(true);
    },
  );

  it('R-4 two callers race one target with one unchanged loser', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    vi.mocked(f.deps.reserve).mockResolvedValue({ status: 'reserved', acquired: false,
      leaseExpiresAt: 'later', retryAfterMs: 100 });
    expect(await commitAssume(plan, f.deps)).toMatchObject({ state: 'refused', reason: 'custody-reserved' });
    expect(f.deps.checkpointCaller).not.toHaveBeenCalled();
    expect(f.deps.quiesceCaller).not.toHaveBeenCalled();
    expect(f.deps.restoreCaller).not.toHaveBeenCalled();
    expect(f.deps.releaseTarget).not.toHaveBeenCalled();
  });

  it('one request id cannot admit changed context or a different target', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    await commitAssume(plan, f.deps);
    const changed = structuredClone(plan);
    changed.target.context.sha256 = 'b'.repeat(64);
    expect(assumeTransitionKey(changed)).toBe(assumeTransitionKey(plan));
    expect(assumePreparationFingerprint(changed)).not.toBe(assumePreparationFingerprint(plan));
    expect(await commitAssume(changed, f.deps)).toMatchObject({ state: 'refused', reason: 'request-conflict' });
    expect(f.deps.handoff).toHaveBeenCalledOnce();
  });

  it('an unknown reservation write stays indeterminate without touching the caller', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    vi.mocked(f.deps.reserve).mockRejectedValue(new Error('connection lost after COMMIT'));
    expect(await commitAssume(plan, f.deps)).toMatchObject({ state: 'indeterminate', durable: true });
    expect(f.deps.checkpointCaller).not.toHaveBeenCalled();
    expect(f.deps.quiesceCaller).not.toHaveBeenCalled();
    expect(f.deps.releaseTarget).not.toHaveBeenCalled();
  });

  it('does not claim durability when the accepted acknowledgement and recovery write both fail', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    const save = vi.mocked(f.deps.save).getMockImplementation()!;
    vi.mocked(f.deps.save).mockImplementation(async receipt => {
      if (receipt.state === 'handoff-accepted' || receipt.state === 'indeterminate') throw new Error('write-failed');
      await save(receipt);
    });
    expect(await commitAssume(plan, f.deps)).toMatchObject({ state: 'indeterminate', durable: false });
    expect(f.stored()?.state).toBe('handoff-requested');
    expect(await commitAssume(plan, f.deps)).toMatchObject({ state: 'handoff-requested', replayed: true });
    expect(f.deps.handoff).toHaveBeenCalledOnce();
    expect(f.deps.releaseTarget).not.toHaveBeenCalled();
  });

  const witness = (receipt: AssumeTransitionReceipt): AssumeExecutionObservation => ({
    transitionKey: receipt.transitionKey, observedAt: 3_000, hostId: 'host-a', attachmentId: 'pty-a',
    callerNativePid: 101, callerExited: true, targetOwnerId: 'su-target',
    targetNativeSessionId: 'target-native', backend: 'codex', contextSha256: hash,
    nativePid: 202, nativeProcessStart: 'proc:202:7', nativeWriterPids: [202],
    directedMessage: { id: 'message-after-handoff', recipient: 'su-target', consumedBy: 'su-target', consumptions: 1 },
    assignment: { id: 'WI-after-handoff', assignee: 'su-target', observedBy: 'su-target' },
  });

  it('R-1 same managed attachment replaces caller execution', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture(), receipt = await commitAssume(plan, f.deps);
    const observed = witness(receipt);
    expect(qualifiesAssumeExecution(receipt, observed)).toBe(true);
    expect(observed.nativePid).not.toBe(plan.caller.nativePid);
    expect(observed.callerExited).toBe(true);
    expect(observed.hostId).toBe(plan.caller.hostId);
    expect(observed.attachmentId).toBe(plan.caller.attachmentId);
    expect((await verifyAssumeExecution(receipt, observed, f.deps.save)).state).toBe('target-verified');
  });

  it('R-1 reject unrelated-window and env-only fake takeover', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture(), receipt = await commitAssume(plan, f.deps);
    for (const wrong of [
      { hostId: 'other-window-host' }, { attachmentId: 'other-pane' },
      { callerExited: false }, { nativePid: plan.caller.nativePid },
      { nativeWriterPids: [] }, { nativeWriterPids: [101, 202] },
    ]) {
      const observation = { ...witness(receipt), ...wrong };
      expect(qualifiesAssumeExecution(receipt, observation)).toBe(false);
      expect((await verifyAssumeExecution(receipt, observation, f.deps.save)).state).toBe('handoff-accepted');
      expect(f.stored()?.state).toBe('handoff-accepted');
    }
  });

  it('R-2 target inbox and task routing spans before during and after cutover', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture(), accepted = await commitAssume(plan, f.deps);
    expect(accepted.state).toBe('handoff-accepted');
    for (const badProbe of [
      { directedMessage: { ...witness(accepted).directedMessage, recipient: plan.caller.ownerId } },
      { directedMessage: { ...witness(accepted).directedMessage, consumedBy: plan.caller.ownerId } },
      { directedMessage: { ...witness(accepted).directedMessage, consumptions: 2 } },
      { assignment: { ...witness(accepted).assignment, assignee: plan.caller.ownerId } },
      { assignment: { ...witness(accepted).assignment, observedBy: plan.caller.ownerId } },
    ]) {
      expect((await verifyAssumeExecution(accepted, { ...witness(accepted), ...badProbe }, f.deps.save)).state)
        .toBe('handoff-accepted');
    }
    const verified = await verifyAssumeExecution(accepted, witness(accepted), f.deps.save);
    expect(verified.state).toBe('target-verified');
    expect(verified.observation?.directedMessage).toMatchObject({ recipient: plan.target.ownerId,
      consumedBy: plan.target.ownerId, consumptions: 1 });
    expect(verified.disposition).toEqual(accepted.disposition);
    expect(verified.recovery).toEqual(accepted.recovery);
    expect(verified.recovery?.returnRef.ownerId).toBe(plan.caller.ownerId);
  });

  it('R-2 preserve target fleet subscriptions and historical authorship', async () => {
    const { preparation: plan } = await prepared(fixture());
    const source = structuredClone(plan), f = transitionFixture();
    const accepted = await commitAssume(plan, f.deps);
    const historical = structuredClone(f.writes);
    await verifyAssumeExecution(accepted, witness(accepted), f.deps.save);
    expect(plan).toEqual(source);
    expect(f.writes.slice(0, historical.length)).toEqual(historical);
    for (const row of f.writes) {
      expect(row.preparation.caller.ownerId).toBe(source.caller.ownerId);
      expect(row.preparation.target.ownerId).toBe(source.target.ownerId);
      expect(row.preparation.target.binding.coordOwnerId).toBe(source.target.ownerId);
    }
    // The protocol keeps owner-keyed fleet/subscription state in place. The
    // production PG cases probe those stores; this unit leg guards attribution.
    expect(f.deps.reserve).toHaveBeenCalledWith(plan);
    expect(f.deps.handoff).toHaveBeenCalledWith(plan, expect.anything());
  });

  it('accepts verification only after matching native process, attachment, inbox and assignment observations', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    const receipt = await commitAssume(plan, f.deps);
    const result = await verifyAssumeExecution(receipt, witness(receipt), f.deps.save);
    expect(result.state).toBe('target-verified');
    expect(f.stored()?.observation?.directedMessage.id).toBe('message-after-handoff');
  });

  it('R-11 takeover audit retains caller target authorization and terminal provenance', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    const accepted = await commitAssume(plan, f.deps);
    const beforeVerification = JSON.stringify(f.writes);
    const observation = witness(accepted);
    await verifyAssumeExecution(accepted, observation, f.deps.save);
    expect(f.writes.at(-1)).toMatchObject({ state: 'target-verified',
      transitionKey: assumeTransitionKey(plan), preparationFingerprint: assumePreparationFingerprint(plan),
      preparation: { caller: plan.caller, target: plan.target, authorizationRef: plan.authorizationRef },
      observation,
    });
    for (const receipt of f.writes) {
      expect(receipt.preparation).toEqual(plan);
      expect(receipt.transitionKey).toBe(assumeTransitionKey(plan));
    }
    expect(JSON.stringify(f.writes.slice(0, -1))).toBe(beforeVerification);
    expect(f.writes.map(row => row.state)).toEqual([
      'caller-checkpointed', 'caller-quiesced', 'target-custody-acquired',
      'handoff-requested', 'handoff-accepted', 'target-verified',
    ]);
  });

  it.each(['refused', 'verified', 'rolled-back'] as const)(
    'R-11 refused verified and rolled-back outcomes remain append-only: %s', async outcome => {
      const { preparation: plan } = await prepared(fixture());
      const f = transitionFixture();
      if (outcome === 'refused') vi.mocked(f.deps.reserve).mockResolvedValue({
        status: 'reserved', acquired: false, leaseExpiresAt: 'later', retryAfterMs: 100,
      });
      if (outcome === 'rolled-back') vi.mocked(f.deps.handoff).mockResolvedValue('refused');
      const receipt = await commitAssume(plan, f.deps);
      if (outcome === 'verified') await verifyAssumeExecution(receipt, witness(receipt), f.deps.save);
      const terminal = outcome === 'verified' ? 'target-verified' : outcome;
      expect(f.writes.at(-1)?.state).toBe(terminal);
      const immutableHistory = JSON.stringify(f.writes);
      expect(await commitAssume(plan, f.deps)).toMatchObject({ state: terminal, replayed: true });
      expect(JSON.stringify(f.writes)).toBe(immutableHistory);
    },
  );

  it('requires the observed target reanchor for a backend-minted checkpoint id', async () => {
    const value = fixture();
    value.target.context = { mode: 'checkpoint', ref: 'carry-note:target', sha256: hash, revision: '7' };
    value.target.executionNativeSessionId = null;
    const { preparation: plan } = await prepared(value, { ...request, contextMode: 'checkpoint' });
    const f = transitionFixture();
    const receipt = await commitAssume(plan, f.deps);
    const observed = witness(receipt);
    observed.targetNativeSessionId = 'fresh-native';
    expect(qualifiesAssumeExecution(receipt, observed)).toBe(false);
    observed.nativeBinding = { advSessionId: plan.target.advSessionId, ownerId: plan.target.ownerId,
      sourceNativeSessionId: plan.target.nativeSessionId, nativeSessionId: observed.targetNativeSessionId,
      transitionKey: receipt.transitionKey };
    expect(qualifiesAssumeExecution(receipt, observed)).toBe(true);
    for (const field of ['ownerId', 'sourceNativeSessionId', 'nativeSessionId', 'transitionKey'] as const) {
      const changed = structuredClone(observed);
      changed.nativeBinding![field] = 'foreign';
      expect(qualifiesAssumeExecution(receipt, changed)).toBe(false);
    }
    observed.targetNativeSessionId = plan.target.nativeSessionId;
    observed.nativeBinding.nativeSessionId = plan.target.nativeSessionId;
    expect(qualifiesAssumeExecution(receipt, observed)).toBe(false);
  });

  it('keeps the managed PTY root distinct from its sole native backend writer', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    const receipt = await commitAssume(plan, f.deps);
    const observed = { ...witness(receipt), ptyPid: 201, ptyProcessStart: 'proc:201:6' };
    expect((await verifyAssumeExecution(receipt, observed, f.deps.save)).state).toBe('target-verified');
    expect(f.stored()?.observation).toMatchObject({ ptyPid: 201, nativePid: 202, nativeWriterPids: [202] });
    for (const changed of [
      { ...observed, ptyProcessStart: undefined },
      { ...observed, ptyPid: plan.caller.nativePid },
      { ...observed, ptyPid: 0 },
      { ...observed, nativeWriterPids: [201] },
    ]) expect(qualifiesAssumeExecution(receipt, changed)).toBe(false);
  });

  it.each([
    ['extra pane', (w: AssumeExecutionObservation) => { w.attachmentId = 'other-pane'; }],
    ['other host', (w: AssumeExecutionObservation) => { w.hostId = 'other-host'; }],
    ['env-only substitution', (w: AssumeExecutionObservation) => { w.nativePid = 101; w.nativeWriterPids = [101]; }],
    ['old caller usable', (w: AssumeExecutionObservation) => { w.callerExited = false; }],
    ['duplicate writer', (w: AssumeExecutionObservation) => { w.nativeWriterPids = [202, 303]; }],
    ['stale observation', (w: AssumeExecutionObservation) => { w.observedAt = 1; }],
    ['wrong target', (w: AssumeExecutionObservation) => { w.targetOwnerId = 'su-other'; }],
    ['wrong native context', (w: AssumeExecutionObservation) => { w.targetNativeSessionId = 'other-native'; }],
    ['wrong context bytes', (w: AssumeExecutionObservation) => { w.contextSha256 = 'b'.repeat(64); }],
    ['message missing', (w: AssumeExecutionObservation) => { w.directedMessage.id = ''; }],
    ['message duplicated', (w: AssumeExecutionObservation) => { w.directedMessage.consumptions = 2; }],
    ['message routed to caller', (w: AssumeExecutionObservation) => { w.directedMessage.consumedBy = 'su-caller'; }],
    ['assignment missing', (w: AssumeExecutionObservation) => { w.assignment.id = ''; }],
    ['assignment routed to caller', (w: AssumeExecutionObservation) => { w.assignment.assignee = 'su-caller'; }],
  ] as const)('rejects a false verification witness: %s', async (_label, mutate) => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    const receipt = await commitAssume(plan, f.deps);
    const proof = witness(receipt);
    mutate(proof);
    expect(qualifiesAssumeExecution(receipt, proof)).toBe(false);
    vi.mocked(f.deps.save).mockClear();
    expect(await verifyAssumeExecution(receipt, proof, f.deps.save)).toBe(receipt);
    expect(f.deps.save).not.toHaveBeenCalled();
  });

  it('R-8 crash after target custody before exec or verification converges on retry', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    vi.mocked(f.deps.handoff).mockRejectedValue(new Error('host crashed with unknown outcome'));
    const interrupted = await commitAssume(plan, f.deps);
    expect(interrupted.state).toBe('indeterminate');
    expect(await reconcileAssumeTransition(interrupted, { kind: 'unknown' }, f.deps)).toBe(interrupted);
    expect(f.deps.releaseTarget).not.toHaveBeenCalled();
    expect(await reconcileAssumeTransition(interrupted, {
      kind: 'cancelled', transitionKey: interrupted.transitionKey,
      preparationFingerprint: interrupted.preparationFingerprint,
      queuedHandoffCancelled: true, nativeWriter: 'free',
    }, f.deps)).toMatchObject({ state: 'rolled-back', durable: true });
    expect(f.deps.restoreCaller).toHaveBeenCalledOnce();
    expect(f.deps.releaseTarget).toHaveBeenCalledOnce();
    expect(await commitAssume(plan, f.deps)).toMatchObject({ state: 'rolled-back', replayed: true });
    expect(f.deps.handoff).toHaveBeenCalledOnce();
  });

  it('cannot release another transition custody using a stale cancellation receipt', async () => {
    const { preparation: plan } = await prepared(fixture());
    const f = transitionFixture();
    const receipt = await commitAssume(plan, f.deps);
    expect(await reconcileAssumeTransition(receipt, { kind: 'cancelled',
      transitionKey: 'another-transition', preparationFingerprint: receipt.preparationFingerprint,
      queuedHandoffCancelled: true, nativeWriter: 'free' }, f.deps)).toBe(receipt);
    expect(f.deps.restoreCaller).not.toHaveBeenCalled();
    expect(f.deps.releaseTarget).not.toHaveBeenCalled();
  });
});
