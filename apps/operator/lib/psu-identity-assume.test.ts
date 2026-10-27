// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityAssumeBaseEnv, makeIdentityAssumeHostPort, launchIdentityAssumeHandoff,
  prepareIdentityAssumeCheckpoint, completeIdentityAssumeDeparture } from '../scripts/psu-identity-assume.mjs';
import { mintCarryRespawnArgs } from '../scripts/psu-launcher.mjs';

function fixture() {
  const now = Date.now();
  const caller = { ownerId: 'su-disposable-caller', workspaceId: 'fixture-workspace', nativeSessionId: 'caller-native',
    nativePid: 101, hostId: 'host-1', attachmentId: 'surface-1', childGeneration: 1 };
  const request = { caller, transitionKey: `session-assume:${'a'.repeat(64)}`, preparationHash: 'b'.repeat(64),
    recoveryRef: 'carry-note:caller', recoveryHash: 'c'.repeat(64), expiresAt: now + 60_000 };
  const target = { ownerId: 'su-disposable-target', workspaceId: caller.workspaceId, advSessionId: 23,
    backend: 'codex', role: 'su', nativeSessionId: 'target-native', context: { mode: 'native-resume' } };
  const result = { ok: true, state: 'handoff-accepted', transitionKey: request.transitionKey,
    preparationHash: request.preparationHash, preparation: { caller, target, expiresAt: request.expiresAt },
    recovery: { checkpointRef: request.recoveryRef, checkpointSha256: request.recoveryHash,
      returnRef: { ownerId: caller.ownerId } } };
  const handoff = { ownerId: caller.ownerId, fromPid: 100, mode: 'identity-assume',
    assume: { version: 1, request }, args: ['identity-assume'] };
  const session = { id: target.advSessionId, coordOwnerId: target.ownerId, workspaceId: target.workspaceId,
    agent: target.backend, role: target.role, sessionId: target.nativeSessionId };
  const ports = { inspect: vi.fn(async () => structuredClone(result)), resolveSession: vi.fn(async () => session),
    accountFor: vi.fn(async () => ({ mode: 'default' })), resume: vi.fn(async (_session: unknown, _options: unknown) => {}),
    isAlive: vi.fn((_pid: number) => false as boolean | null), baseEnv: { HOME: '/home/test', PATH: '/bin',
      PAPERCUSP_SID: caller.ownerId, CODEX_HOME: '/caller', ANTHROPIC_AUTH_TOKEN: 'caller-secret',
      PAPERCUSP_PLAN: 'caller-plan', PRIVATE_CONTEXT: 'caller-text' }, now: () => now };
  return { caller, request, result, handoff, session, ports };
}

describe('clean parent-bound identity launcher', () => {
  it('requires durable attempt acknowledgements before spawn and for its exact PTY startup', async () => {
    const { handoff, ports, result } = fixture();
    let acknowledge = false;
    const inspect = vi.fn(async (_request: unknown, _afterExit: boolean, _action?: string,
      startup?: { attemptId: string; launcherPid?: number; ptyPid?: number }) =>
      ({ ...structuredClone(result), ...(acknowledge ? { attemptId: startup?.attemptId } : {}) }));
    await launchIdentityAssumeHandoff(handoff, { ...ports, inspect });
    const { managedAssume } = ports.resume.mock.calls[0][1] as { managedAssume: {
      beginStartup(): Promise<void>; started(value: { ptyPid: number }): Promise<void>;
    } };
    await expect(managedAssume.beginStartup()).rejects.toThrow('startup-unacknowledged');
    acknowledge = true;
    await managedAssume.beginStartup();
    await managedAssume.started({ ptyPid: 202 });
    const begin = inspect.mock.calls.at(-2)!;
    const started = inspect.mock.calls.at(-1)!;
    expect(begin.slice(1, 3)).toEqual([true, 'begin-startup']);
    expect(begin[3]?.launcherPid).toBe(process.pid);
    expect(started.slice(1, 3)).toEqual([true, 'startup-started']);
    expect(started[3]).toEqual({ attemptId: begin[3]?.attemptId, ptyPid: 202 });
  });

  it('restores a pinned caller return through the same request only after the launcher finalizes', async () => {
    const { handoff, result, ports, request } = fixture();
    Object.assign(result.preparation.target, { returnFrom: { transitionKey: 'source-key' } });
    await launchIdentityAssumeHandoff(handoff, ports);
    const options = ports.resume.mock.calls[0][1] as { managedAssume: { restoreReturn(): Promise<void> } };
    expect(ports.inspect).not.toHaveBeenCalledWith(request, true, 'complete-return');
    await options.managedAssume.restoreReturn();
    expect(ports.inspect).toHaveBeenLastCalledWith(request, true, 'complete-return');
    ports.inspect.mockResolvedValueOnce({ ok: false } as typeof result);
    await expect(options.managedAssume.restoreReturn()).rejects.toThrow('assume-return-unacknowledged');
  });
  it('ends the departed caller before reexec while ordinary code adoption retains its registration', async () => {
    const effects: string[] = [];
    const reportEnd = vi.fn(async () => { effects.push('end-ack'); return { reported: true }; });
    const exit = vi.fn(() => { effects.push('reexec'); });
    await completeIdentityAssumeDeparture({ mode: 'identity-assume', code: 75 }, { advSessionId: '23', reportEnd, exit });
    expect(effects).toEqual(['end-ack', 'reexec']);
    expect(reportEnd).toHaveBeenCalledWith('23', 0, { killedBySignal: 'SIGKILL' });
    reportEnd.mockClear(); effects.length = 0;
    await completeIdentityAssumeDeparture({ mode: 'carry-respawn', code: 75 }, { advSessionId: '23', reportEnd, exit });
    expect(reportEnd).not.toHaveBeenCalled(); expect(effects).toEqual(['reexec']);
  });

  it.each(['unacknowledged', 'unavailable', 'transport'])('stops replacement when caller end is %s', async fault => {
    const reportEnd = vi.fn(async () => {
      if (fault === 'transport') throw new Error('transport');
      return { reported: false };
    });
    const exit = vi.fn();
    await expect(completeIdentityAssumeDeparture({ mode: 'identity-assume', code: 75 },
      { advSessionId: fault === 'unavailable' ? null : '23', reportEnd, exit })).rejects.toThrow();
    expect(exit).not.toHaveBeenCalled();
    if (fault === 'unavailable') expect(reportEnd).not.toHaveBeenCalled();
  });

  it('rebuilds only the exact target with its account and an opaque caller return reference', async () => {
    const { handoff, session, request, ports } = fixture();
    await launchIdentityAssumeHandoff(handoff, ports);
    expect(ports.inspect).toHaveBeenCalledTimes(2);
    expect(ports.resolveSession).toHaveBeenCalledWith(session.id);
    expect(ports.accountFor).toHaveBeenCalledWith(session);
    expect(ports.resume).toHaveBeenCalledOnce();
    const [actual, options] = ports.resume.mock.calls[0] as unknown as [typeof session, Record<string, any>];
    expect(actual).toBe(session);
    expect(options.accountEnv).toEqual({ mode: 'default' });
    expect(options.managedAssume.inheritedEnv).toEqual({ HOME: '/home/test', PATH: '/bin' });
    expect(options.managedAssume.attachmentId).toBe(request.caller.attachmentId);
    expect(options.managedAssume.reservation.claimKey).toBe(request.transitionKey);
    expect(options.kickoff).toContain(request.recoveryRef);
    expect(JSON.stringify(options)).not.toContain('caller-secret');
    expect(JSON.stringify(options)).not.toContain('caller-text');
    ports.isAlive.mockReturnValue(true);
    await expect(options.managedAssume.verify()).rejects.toThrow('assume-caller-not-exited');
  });

  it.each([true, null])('refuses live or unknown caller exit (%s)', async state => {
    const { handoff, ports } = fixture();
    ports.isAlive.mockReturnValue(state);
    await expect(launchIdentityAssumeHandoff(handoff, ports)).rejects.toThrow('assume-caller-not-exited');
    expect(ports.resume).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'context', 'recovery', 'attachment', 'target', 'lease', 'second-read', 'orders'])('refuses changed %s before spawn', async fault => {
    const { handoff, result, session, ports } = fixture();
    if (fault === 'receipt') result.state = 'handoff-requested';
    if (fault === 'context') result.preparation.target.context.mode = 'unsupported';
    if (fault === 'recovery') result.recovery.checkpointSha256 = 'd'.repeat(64);
    if (fault === 'attachment') handoff.assume.request.caller = { ...handoff.assume.request.caller, attachmentId: 'foreign' };
    if (fault === 'target') session.coordOwnerId = 'su-foreign';
    if (fault === 'lease') ports.now = () => handoff.assume.request.expiresAt;
    if (fault === 'second-read') ports.accountFor.mockImplementation(async () => { result.ok = false; return { mode: 'default' }; });
    if (fault === 'orders') Object.assign(handoff, { childEnv: {} });
    await expect(launchIdentityAssumeHandoff(handoff, ports)).rejects.toThrow();
    expect(ports.resume).not.toHaveBeenCalled();
  });

  it('R-10 caller history credentials and unapproved environment do not cross context boundary', async () => {
    expect(identityAssumeBaseEnv({ HOME: '/home/test', TERM: 'xterm', PAPERCUSP_PSU_REEXEC: '75',
      PAPERCUSP_SID: 'caller', PAPERCUSP_HOSTED_NATIVE_SLOT: 'caller-slot', NODE_OPTIONS: '--import=caller',
      OPENAI_API_KEY: 'secret', CLAUDE_CONFIG_DIR: '/caller', PI_CODING_AGENT_DIR: '/caller',
      CODEX_HOME: '/caller', PAPERCUSP_NATIVE_SESSION_ID: 'caller-native' })).toEqual({
        HOME: '/home/test', TERM: 'xterm', PAPERCUSP_PSU_REEXEC: '75' });
    const f = fixture();
    Object.assign(f.ports.baseEnv, { CALLER_TRANSCRIPT: 'private caller transcript',
      CALLER_TOOL_HISTORY: 'private caller tool history', NODE_OPTIONS: '--import=caller-private-loader',
      OPENAI_API_KEY: 'caller-private-key', PAPERCUSP_NATIVE_SESSION_ID: 'caller-private-native' });
    const body = 'Only the selected target checkpoint crosses this boundary.';
    Object.assign(f.result.preparation.target, { executionNativeSessionId: null,
      context: { mode: 'checkpoint', ref: 'carry-note:target', revision: '7',
        sha256: createHash('sha256').update(body).digest('hex') } });
    Object.assign(f.result, { checkpointBody: body });
    await launchIdentityAssumeHandoff(f.handoff, f.ports);
    const options = f.ports.resume.mock.calls[0][1] as {
      kickoff: string;
      managedAssume: { inheritedEnv: Record<string, string>; checkpoint: { body: string } };
    };
    expect(options.managedAssume.inheritedEnv).toEqual({ HOME: '/home/test', PATH: '/bin' });
    expect(options.managedAssume.checkpoint.body).toBe(body);
    expect(options.kickoff).toContain(f.request.recoveryRef);
    for (const secret of ['private caller transcript', 'private caller tool history',
      'caller-private-loader', 'caller-private-key', 'caller-private-native', 'caller-secret', 'caller-text']) {
      expect(JSON.stringify(options)).not.toContain(secret);
    }
  });

  it.each(['codex', 'claude'])('boots %s checkpoint context with the existing fresh carry path', backend => {
    const root = mkdtempSync(join(tmpdir(), 'assume-checkpoint-'));
    try {
      const codexHome = join(root, 'target-codex'); mkdirSync(codexHome);
      writeFileSync(join(codexHome, 'AGENTS.md'), 'Target-owned base persona.');
      const body = 'Pinned target work checkpoint. No caller conversation.';
      const context = { mode: 'checkpoint', ref: 'carry-note:target', revision: '7',
        sha256: createHash('sha256').update(body).digest('hex') };
      const session = { agent: backend, coordOwnerId: 'su-target', sessionId: 'old-target' };
      const checkpoint = { context, body, executionNativeSessionId: backend === 'codex' ? null : 'fresh-target' };
      const args = backend === 'codex' ? ['-m', 'model', 'resume', 'old-target'] : ['--resume', 'old-target'];
      const carry = prepareIdentityAssumeCheckpoint(session, checkpoint, args,
        { mint: mintCarryRespawnArgs, codexHome, personaFile: null, home: root });
      expect(carry.args).not.toContain('resume');
      expect(carry.args).not.toContain('--resume');
      expect(carry.args).not.toContain('old-target');
      expect(readFileSync(carry.launchContextPath, 'utf8')).toContain(body);
      expect(carry.nativeId).toBe(checkpoint.executionNativeSessionId);
      if (backend === 'codex') expect(readFileSync(join(codexHome, 'AGENTS.md'), 'utf8')).toContain(carry.launchContextPath);
      const mint = vi.fn();
      expect(() => prepareIdentityAssumeCheckpoint(session, { ...checkpoint, body: 'tampered' }, args,
        { mint, codexHome, personaFile: null, home: root })).toThrow('assume-checkpoint-changed');
      expect(mint).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('passes checkpoint input only from the authorized target inspection to the guarded launcher', async () => {
    const f = fixture();
    Object.assign(f.result.preparation.target, { executionNativeSessionId: null,
      context: { mode: 'checkpoint', ref: 'carry-note:target', revision: '7', sha256: 'e'.repeat(64) } });
    Object.assign(f.result, { checkpointBody: 'target checkpoint only' });
    await launchIdentityAssumeHandoff(f.handoff, f.ports);
    expect(f.ports.resume.mock.calls[0][1]).toMatchObject({ managedAssume: { checkpoint: {
      body: 'target checkpoint only', executionNativeSessionId: null,
      context: { mode: 'checkpoint', ref: 'carry-note:target', revision: '7' },
    } } });
  });

  it('writes no caller command or environment into target orders, and refuses unaccepted preparation', async () => {
    const { request, result, ports } = fixture();
    const writeHandoff = vi.fn(() => '/private/orders');
    const host = makeIdentityAssumeHostPort({ ownerId: request.caller.ownerId,
      inspect: ports.inspect, writeHandoff, reexecCode: 75 });
    expect(await host!.verify(request, 'thaw')).toBe(true);
    expect(ports.inspect).toHaveBeenLastCalledWith(request, false, 'thaw');
    expect(await host!.prepare(request)).toEqual({ code: 75, handoffPath: '/private/orders' });
    expect(writeHandoff.mock.calls[0]).toEqual([request.caller.ownerId, { mode: 'identity-assume',
      args: ['identity-assume'], headless: false, assume: { version: 1, request } }]);
    result.state = 'handoff-requested';
    expect(await host!.prepare(request)).toBeNull();
    expect(writeHandoff).toHaveBeenCalledOnce();
  });

  it('retains a headless surface and its logical host without importing the caller environment', async () => {
    const { request, ports, handoff } = fixture();
    const writeHandoff = vi.fn((_owner: string, _record: unknown) => '/orders');
    const host = makeIdentityAssumeHostPort({ ownerId: request.caller.ownerId, inspect: ports.inspect,
      writeHandoff, reexecCode: 75, headless: true,
      hostId: request.caller.hostId, attachmentId: request.caller.attachmentId });
    expect(host).toMatchObject({ hostId: request.caller.hostId, attachmentId: request.caller.attachmentId });
    await host!.prepare(request);
    const record = writeHandoff.mock.calls[0][1] as Record<string, unknown>;
    await launchIdentityAssumeHandoff({ ...handoff, ...record }, ports);
    expect(ports.resume.mock.calls[0][1]).toMatchObject({ headless: true,
      managedAssume: { hostId: request.caller.hostId, attachmentId: request.caller.attachmentId } });
  });
});
