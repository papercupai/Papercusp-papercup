import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assumePreparationFingerprint, assumeTransitionKey, type AssumePreparation } from './session-assume';

const ports = vi.hoisted(() => ({
  sql: vi.fn(), load: vi.fn(), pause: vi.fn(), ownsPause: vi.fn(), host: vi.fn(),
  confinement: vi.fn(), checkpoint: vi.fn(), custody: vi.fn(), resolve: vi.fn(), targetBody: vi.fn(),
  save: vi.fn(), processIdentity: vi.fn(), custodyFactory: vi.fn(),
}));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: ports.sql }) }));
vi.mock('./agent-launch-core', () => ({ resolveResumeTarget: ports.resolve }));
vi.mock('./session-assume-store', () => ({ createAssumeReceiptStore: () => ({ load: ports.load, save: ports.save }) }));
vi.mock('./process-identity', () => ({ readProcessIdentity: ports.processIdentity }));
vi.mock('./session-assume-pause', () => ({ readAssumeCallerPause: ports.pause, ownsAssumeCallerPause: ports.ownsPause }));
vi.mock('./events/await/psu-pty-discovery', () => ({ findLiveHostAsync: ports.host, injectIntoHostWithConfirmation: vi.fn() }));
vi.mock('./capability-envelope/session-confinement-store', () => ({ readSessionConfinement: ports.confinement }));
vi.mock('./session-assume-caller', () => ({ readAssumeCallerCheckpoint: ports.checkpoint, createAssumeCallerAdapters: vi.fn() }));
vi.mock('./session-assume-custody', () => ({ createAssumeCustodyAdapters: (...args: unknown[]) => {
  ports.custodyFactory(...args); return { checkCustody: ports.custody };
} }));
vi.mock('./session-assume-preparation', () => ({ readAssumeCaller: vi.fn(), readAssumeTarget: vi.fn(),
  readAssumeCheckpointBody: ports.targetBody }));
import { inspectManagedAssumeRequest } from './session-assume-runtime';

function fixture() {
  const now = Date.now();
  const caller = { ownerId: 'su-caller', workspaceId: 'fixture', backend: 'codex' as const,
    nativeSessionId: 'caller-native', nativePid: 123, incarnation: '2026-10-24 00:00:00.123456+00',
    hostId: 'host', attachmentId: 'surface' };
  const plan: AssumePreparation = { version: 1, requestId: 'fixture', authorizationRef: 'fixture-admin',
    preparedAt: now, expiresAt: now + 120_000, caller,
    target: { ownerId: 'su-target', workspaceId: caller.workspaceId, harnessSlug: 'fixture', advSessionId: 42,
      role: 'su', nativeSessionId: 'target-native', executionNativeSessionId: 'target-native', backend: 'codex',
      binding: { coordOwnerId: 'su-target', sessionId: 'target-native', startedAt: 'fixture-start' },
      writerGeneration: 'free', writer: 'free', ended: true, liveHost: false,
      context: { mode: 'native-resume', ref: 'target-native', sha256: 'a'.repeat(64), revision: 'fixture' } } };
  const request = { transitionKey: assumeTransitionKey(plan), preparationHash: assumePreparationFingerprint(plan),
    recoveryRef: 'carry-note:caller', recoveryHash: 'b'.repeat(64), expiresAt: plan.expiresAt,
    caller: { ownerId: caller.ownerId, workspaceId: caller.workspaceId, nativeSessionId: caller.nativeSessionId,
      nativePid: caller.nativePid, hostId: caller.hostId, attachmentId: caller.attachmentId, childGeneration: 1 } };
  const receipt = { transitionKey: request.transitionKey, preparationFingerprint: request.preparationHash,
    durable: true, state: 'handoff-accepted', recovery: { checkpointRef: request.recoveryRef, checkpointSha256: request.recoveryHash } };
  const registration = { ok: true, ownerId: caller.ownerId, workspaceId: caller.workspaceId, agent: caller.backend,
    sessionId: caller.nativeSessionId, binding: { coordOwnerId: caller.ownerId, startedAt: caller.incarnation } };
  ports.sql.mockResolvedValue([{ summary: { sessionAssume: { preparation: plan } } }]);
  ports.load.mockResolvedValue(receipt);
  ports.pause.mockResolvedValue({}); ports.ownsPause.mockReturnValue(true);
  ports.host.mockResolvedValue({ ptyPid: caller.nativePid, childGeneration: 1,
    identityAssume: { hostId: caller.hostId, attachmentId: caller.attachmentId } });
  ports.confinement.mockResolvedValue(null); ports.checkpoint.mockResolvedValue({});
  ports.custody.mockResolvedValue(true); ports.resolve.mockResolvedValue(registration);
  return { plan, request, receipt, registration };
}

beforeEach(() => vi.resetAllMocks());

describe('managed assume receipt inspection', () => {
  it('records startup attempts before spawn and requires exact prior process exit for a new generation', async () => {
    const { plan, request } = fixture();
    ports.host.mockResolvedValue(null);
    ports.processIdentity.mockImplementation(pid => pid === 501 ? 'launcher-start' : pid === 502 ? 'pty-start' : null);
    ports.save.mockImplementation(async value => { ports.load.mockResolvedValue(value); });
    const attemptId = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    await inspectManagedAssumeRequest(request, true, 'begin-startup', { attemptId, launcherPid: 501 });
    expect(ports.save.mock.calls[0][0].startup).toMatchObject({ attemptId, generation: 1, launcherPid: 501 });
    expect(ports.save.mock.calls[0][0].preparationFingerprint).toBe(assumePreparationFingerprint(plan));
    await inspectManagedAssumeRequest(request, true, 'startup-started', { attemptId, ptyPid: 502 });
    await expect(inspectManagedAssumeRequest(request, true, 'begin-startup', { attemptId: second, launcherPid: 501 }))
      .rejects.toThrow('assume-startup-not-exited');
    // A reused PID belongs to another process: the recorded incarnation exited.
    ports.processIdentity.mockImplementation(pid => pid === 501 ? 'launcher-start' : pid === 502 ? 'reused-pid' : null);
    await inspectManagedAssumeRequest(request, true, 'begin-startup', { attemptId: second, launcherPid: 501 });
    expect(ports.save.mock.calls.at(-1)![0].startup).toMatchObject({ attemptId: second, generation: 2 });
    expect(ports.custodyFactory.mock.calls.at(-1)![1]).toEqual({ authorizedStartup: true });
    expect(ports.save.mock.calls.at(-1)![0].preparationFingerprint).toBe(assumePreparationFingerprint(plan));
  });

  it('refuses unrecorded, unavailable and wrong-attempt startup witnesses before saving', async () => {
    const { request } = fixture(); ports.host.mockResolvedValue(null);
    await expect(inspectManagedAssumeRequest(request, false, 'begin-startup',
      { attemptId: '11111111-1111-4111-8111-111111111111', launcherPid: 501 })).rejects.toThrow('invalid-action');
    await expect(inspectManagedAssumeRequest(request, true, 'begin-startup',
      { attemptId: '11111111-1111-4111-8111-111111111111', launcherPid: 501 })).rejects.toThrow('not-exited');
    await expect(inspectManagedAssumeRequest(request, true, 'startup-started',
      { attemptId: '11111111-1111-4111-8111-111111111111', ptyPid: 502 })).rejects.toThrow('startup-changed');
    expect(ports.save).not.toHaveBeenCalled();
  });

  it('does not authorize appended context from a write-ahead record without a recorded child', async () => {
    const { request, receipt } = fixture();
    ports.host.mockResolvedValue(null);
    Object.assign(receipt, { startup: { attemptId: '11111111-1111-4111-8111-111111111111',
      generation: 1, authorizedAt: Date.now(), launcherPid: 501, launcherProcessStart: 'launcher-start' } });
    ports.processIdentity.mockReturnValue('launcher-start');
    // The real custody adapter rejects changed context unless prefix recovery
    // was explicitly authorized. A launcher-only record must not grant it.
    ports.custody.mockImplementation(async () => ports.custodyFactory.mock.calls.at(-1)?.[1]?.authorizedStartup === true);
    await expect(inspectManagedAssumeRequest(request, true)).rejects.toThrow('assume-target-custody-changed');
    expect(ports.custodyFactory.mock.calls.at(-1)![1]).toEqual({ authorizedStartup: false });
    expect(ports.save).not.toHaveBeenCalled();
  });

  it.each(['ESRCH', 'EPERM'])('retries unacknowledged startup only on exact launcher exit (%s)', async code => {
    const { request, receipt } = fixture();
    ports.host.mockResolvedValue(null);
    Object.assign(receipt, { startup: { attemptId: '11111111-1111-4111-8111-111111111111',
      generation: 1, authorizedAt: Date.now(), launcherPid: 501, launcherProcessStart: 'old-launcher' } });
    ports.processIdentity.mockImplementation(pid => pid === 503 ? 'new-launcher' : null);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
    try {
      const attempt = inspectManagedAssumeRequest(request, true, 'begin-startup', {
        attemptId: '22222222-2222-4222-8222-222222222222', launcherPid: 503 });
      if (code === 'ESRCH') {
        await expect(attempt).resolves.toMatchObject({ ok: true });
        expect(ports.save.mock.calls.at(-1)![0].startup).toMatchObject({ generation: 2, launcherPid: 503 });
      } else {
        await expect(attempt).rejects.toThrow('assume-startup-not-exited');
        expect(ports.save).not.toHaveBeenCalled();
      }
      expect(ports.custodyFactory.mock.calls.at(-1)![1]).toEqual({ authorizedStartup: false });
    } finally { kill.mockRestore(); }
  });

  it('checks the exact caller before and after checkpoint and target custody reads', async () => {
    const { request } = fixture();
    expect(await inspectManagedAssumeRequest(request)).toMatchObject({ ok: true, state: 'handoff-accepted' });
    expect(ports.resolve).toHaveBeenCalledTimes(2);
    expect(ports.custody).toHaveBeenCalledOnce();
  });

  it.each(['ownerId', 'workspaceId', 'agent', 'sessionId', 'incarnation', 'bindingOwner', 'unavailable'])(
    'refuses changed caller %s before target effects', async field => {
      const { request, registration } = fixture();
      if (field === 'incarnation') registration.binding.startedAt = 'new-start';
      else if (field === 'bindingOwner') registration.binding.coordOwnerId = 'su-successor';
      else if (field === 'unavailable') registration.ok = false;
      else Object.assign(registration, { [field]: 'changed' });
      await expect(inspectManagedAssumeRequest(request)).rejects.toThrow('assume-host-caller-changed');
      expect(ports.checkpoint).not.toHaveBeenCalled();
      expect(ports.custody).not.toHaveBeenCalled();
    });

  it('refuses a caller incarnation that changes during target writer inspection', async () => {
    const { request, registration } = fixture();
    ports.custody.mockImplementation(async () => { registration.binding.startedAt = 'replacement'; return true; });
    await expect(inspectManagedAssumeRequest(request)).rejects.toThrow('assume-host-caller-changed');
  });

  it('permits exact thaw after expiry without granting target custody', async () => {
    const { plan, request } = fixture();
    plan.expiresAt = request.expiresAt = Date.now() - 1;
    ports.custody.mockResolvedValue(false);
    expect(await inspectManagedAssumeRequest(request, false, 'thaw')).toMatchObject({ ok: true });
    expect(ports.custody).not.toHaveBeenCalled();
    await expect(inspectManagedAssumeRequest(request)).rejects.toThrow('assume-host-receipt-mismatch');
  });

  it('requires caller host absence after exit and retains receipt, confinement and target fences', async () => {
    const { request, receipt } = fixture();
    await expect(inspectManagedAssumeRequest(request, true)).rejects.toThrow('assume-host-custody-changed');
    ports.host.mockResolvedValue(null);
    expect(await inspectManagedAssumeRequest(request, true)).toMatchObject({ ok: true });
    receipt.state = 'handoff-requested';
    await expect(inspectManagedAssumeRequest(request, true)).rejects.toThrow('assume-host-receipt-mismatch');
    receipt.state = 'handoff-accepted';
    ports.confinement.mockResolvedValue({ reason: 'review confinement' });
    await expect(inspectManagedAssumeRequest(request, true)).rejects.toThrow('assume-host-custody-changed');
    ports.confinement.mockResolvedValue(null); ports.custody.mockResolvedValue(false);
    await expect(inspectManagedAssumeRequest(request, true)).rejects.toThrow('assume-target-custody-changed');
  });

  it('reads the pinned target body only after exit and custody, then rechecks caller incarnation', async () => {
    const { plan, request, registration } = fixture();
    plan.target.context = { ...plan.target.context, mode: 'checkpoint', ref: 'carry-note:target' };
    plan.target.executionNativeSessionId = null;
    request.preparationHash = assumePreparationFingerprint(plan);
    ports.load.mockResolvedValue({ transitionKey: request.transitionKey,
      preparationFingerprint: request.preparationHash, durable: true, state: 'handoff-accepted',
      recovery: { checkpointRef: request.recoveryRef, checkpointSha256: request.recoveryHash } });
    await inspectManagedAssumeRequest(request);
    expect(ports.targetBody).not.toHaveBeenCalled();
    ports.host.mockResolvedValue(null);
    ports.custody.mockResolvedValue(false);
    await expect(inspectManagedAssumeRequest(request, true)).rejects.toThrow('assume-target-custody-changed');
    expect(ports.targetBody).not.toHaveBeenCalled();
    ports.custody.mockResolvedValue(true);
    ports.targetBody.mockResolvedValue('target checkpoint only');
    expect(await inspectManagedAssumeRequest(request, true)).toMatchObject({ checkpointBody: 'target checkpoint only' });
    ports.targetBody.mockImplementation(async () => { registration.binding.startedAt = 'replacement'; return 'target checkpoint only'; });
    await expect(inspectManagedAssumeRequest(request, true)).rejects.toThrow('assume-host-caller-changed');
  });
});
