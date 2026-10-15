import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chat: vi.fn(), read: vi.fn(), bind: vi.fn(), bootstrap: vi.fn(), engine: vi.fn(), host: vi.fn(),
  ended: vi.fn(), pid: vi.fn(), persist: vi.fn(), reconcile: vi.fn(), rpc: vi.fn(),
  resume: vi.fn(), rehydrate: vi.fn(), registry: vi.fn(), owner: vi.fn(), recordOwner: vi.fn(),
  callOwner: vi.fn(), forwardable: vi.fn(),
}));
// WI-10003879: the cross-worker relay is proven for real in
// su-session-owner-routing.integration.test.ts; here only the launch's
// decision (forward vs attach locally) is under test.
vi.mock('./cluster-owner-rpc', async (orig) => ({
  ...(await orig<typeof import('./cluster-owner-rpc')>()),
  callOwnerProcess: (...args: unknown[]) => mocks.callOwner(...args),
}));
vi.mock('./su-session-owner-routing', async (orig) => ({
  ...(await orig<typeof import('./su-session-owner-routing')>()),
  isForwardableOwner: (...args: unknown[]) => mocks.forwardable(...args),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'workspace' }));
vi.mock('./agent-chats-data', () => ({ getChat: mocks.chat }));
vi.mock('./adv-sessions', async (orig) => ({
  ...(await orig<typeof import('./adv-sessions')>()),
  getAdvSession: vi.fn(),
  markAdvSessionEnded: mocks.ended,
  setAdvSessionPid: mocks.pid,
}));
vi.mock('./native-session-handles', () => ({ nativeSessionHandleForAdvSession: vi.fn() }));
vi.mock('./su-session-host', () => ({ getRegisteredSuSessionHost: mocks.host, rehydrateRegisteredSuSessionHost: mocks.rehydrate }));
vi.mock('./su-session-resume', () => ({ prepareStructuredSuResume: mocks.resume }));
vi.mock('./su-session-persistence', () => ({ readDurableSuSession: mocks.read, bindSuSessionToAdvSession: mocks.bind, persistSuSessionDescriptor: mocks.persist,
  readSuSessionHostOwner: mocks.owner, recordSuSessionHostOwner: mocks.recordOwner }));
vi.mock('./su-session-claude-engine', () => ({ startClaudeSuEngine: mocks.engine }));
vi.mock('./su-session-rpc-engine', () => ({ startSuRpcEngine: mocks.rpc }));
vi.mock('./endpoint-route/routes/agent-mcp/bootstrap-su', () => ({ bootstrapSu: { handler: mocks.bootstrap } }));
vi.mock('./harness-registry', () => ({ loadHarnessRegistry: mocks.registry }));
// P-009's durable client lease is covered by su-session-client-lease.test.ts
// and the real-PTY journey; here it must not write adv_sessions rows.
vi.mock('./su-session-client-lease', () => ({
  grantSuClientLease: vi.fn(async () => undefined),
  suClientLeaseConfig: () => ({ ttlMs: 30_000, renewMs: 10_000, sweepMs: 5_000, initialMs: 60_000 }),
  superviseSuClientLease: vi.fn(() => () => undefined),
}));
import { LATE_STALL_REPORT_MS, LAUNCH_STALL_REPORT_MS, SLOW_LAUNCH_STAGE_MS, claudeEngineIdentityForCwd, launchAttachedSuSession,
  launchStageTracer, logLaunchTrace, type LaunchTraceLevel } from './su-session-attached-launch';
import { CODEX_SAFE_DEFAULT_MODEL } from './model-context-budget.mjs';

const input = { agent: 'claude', agent_chat_id: 'chat', harness_slug: 'project', account: 'default', carry: 'warm' as const };
const request = () => new Request('http://localhost/api/adv/sessions/launch-su', { headers: { authorization: 'Bearer fixture-principal' } });
const boot = { status: 'ok', sessionId: 18, nativeSessionId: 'native-id', agent: 'claude', workspaceId: 'workspace', harnessSlug: 'project', planSlug: null,
  envelopeEnv: { PAPERCUSP_SID: 'su-engine', CLAUDE_CONFIG_DIR: '/configured/claude' } };
const close = vi.fn(async () => undefined);
const priorApproval = process.env.PUI_REAL_APPROVAL;
const priorFixtureWorkspace = process.env.PUI_OPERATOR_FIXTURE_WORKSPACE;
beforeEach(() => {
  delete process.env.PUI_REAL_APPROVAL;
  delete process.env.PUI_OPERATOR_FIXTURE_WORKSPACE;
  vi.resetAllMocks();
  mocks.chat.mockResolvedValue({ ok: true, data: { archived_at: null, su_runtime_class: 'su-session' } });
  mocks.read.mockResolvedValue(null);
  mocks.owner.mockResolvedValue(null);
  mocks.recordOwner.mockResolvedValue(true);
  mocks.resume.mockRejectedValue(new Error('Reconnect requires a saved native session'));
  mocks.bind.mockResolvedValue({ status: 'bound' });
  mocks.bootstrap.mockImplementation(async () => Response.json(boot));
  mocks.engine.mockReturnValue({ ready: Promise.resolve(), done: new Promise(() => {}), close, pid: () => 4321,
    adapter: { reconcileRuntimeExit: mocks.reconcile, host: {
      descriptor: () => ({ lifecycle: 'starting' }), snapshot: () => ({ terminal: false }),
    } } });
  mocks.rpc.mockImplementation(() => ({ ...mocks.engine(), nativeSession: () => null }));
});
afterEach(() => {
  if (priorApproval === undefined) delete process.env.PUI_REAL_APPROVAL;
  else process.env.PUI_REAL_APPROVAL = priorApproval;
  if (priorFixtureWorkspace === undefined) delete process.env.PUI_OPERATOR_FIXTURE_WORKSPACE;
  else process.env.PUI_OPERATOR_FIXTURE_WORKSPACE = priorFixtureWorkspace;
});

describe('attached launch authority', () => {
  it.each([
    { agent: 'codex', selected: 'gpt-5.6-terra:xhigh', expected: 'gpt-5.6-terra:xhigh' },
    { agent: 'claude', selected: 'sonnet:high', expected: 'sonnet[1m]:high' },
    { agent: 'omp', selected: 'openai/gpt-5.6-terra', expected: 'openai/gpt-5.6-terra' },
  ])('passes the bootstrap identity model to the native $agent engine', async ({ agent, selected, expected }) => {
    mocks.bootstrap.mockImplementationOnce(async () => Response.json({ ...boot, agent, model: selected }));
    const response = await launchAttachedSuSession(request(), { ...input, agent, agent_chat_id: `selected-${agent}` });
    expect(response.status).toBe(200);
    const call = (agent === 'claude' ? mocks.engine : mocks.rpc).mock.calls[0];
    expect(call[agent === 'claude' ? 3 : 2]).toMatchObject({ model: expected });
  });

  it('returns the durable identity before engine readiness and supervises initialization on the host', async () => {
    let ready!: () => void;
    mocks.engine.mockReturnValue({ ...mocks.engine(), ready: new Promise<void>((resolve) => { ready = resolve; }) });
    mocks.engine.mockClear();
    const pending = launchAttachedSuSession(request(), input);
    await vi.waitFor(() => expect(mocks.engine).toHaveBeenCalledOnce());
    // An unresolved native readiness promise must not hold the HTTP request.
    expect(await (await pending).json()).toMatchObject({ status: 'ok', transport: 'structured', ready: false, advSessionId: 18, ownerId: 'su-engine' });
    expect(mocks.pid).not.toHaveBeenCalled();
    expect(mocks.persist).toHaveBeenCalledWith(18, { lifecycle: 'starting' });
    const forwarded = mocks.bootstrap.mock.calls[0][0] as Request;
    expect(forwarded.headers.get('authorization')).toBe('Bearer fixture-principal');
    expect(await forwarded.json()).toMatchObject({ ...input, workspace: 'workspace', headless: true, bootstrap_idempotency_key: 'pui:workspace:chat' });
    expect(mocks.bind.mock.invocationCallOrder[0]).toBeLessThan(mocks.engine.mock.invocationCallOrder[0]);
    ready();
    await vi.waitFor(() => expect(mocks.pid).toHaveBeenCalledWith(18, 4321, 'pui-structured-claude'));
  });

  it('keeps native approval prompts on ordinary PUI launches as well as fixture launches', async () => {
    process.env.PUI_REAL_APPROVAL = '1';
    process.env.PUI_OPERATOR_FIXTURE_WORKSPACE = 'workspace';
    await launchAttachedSuSession(request(), { ...input, agent_chat_id: 'approval-fixture' });
    expect(mocks.engine.mock.calls[0][3]).toMatchObject({ toolApproval: 'prompt' });

    process.env.PUI_OPERATOR_FIXTURE_WORKSPACE = 'other-workspace';
    await launchAttachedSuSession(request(), { ...input, agent_chat_id: 'ordinary-session' });
    expect(mocks.engine.mock.calls[1][3]).toMatchObject({ toolApproval: 'prompt' });
  });

  it('coalesces simultaneous retries before any engine is started', async () => {
    const [one, two] = await Promise.all([launchAttachedSuSession(request(), input), launchAttachedSuSession(request(), input)]);
    expect(await one.json()).toEqual(await two.json());
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(mocks.engine).toHaveBeenCalledOnce();
  });

  it('refuses legacy and archived chats before allocating an SU identity', async () => {
    for (const data of [{ archived_at: 'now', su_runtime_class: 'su-session' }, { archived_at: null, su_runtime_class: 'legacy-owned-loop' }]) {
      mocks.chat.mockResolvedValue({ ok: true, data });
      expect((await launchAttachedSuSession(request(), input)).status).toBe(503);
    }
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it('does not conceal a lost executor by creating another session', async () => {
    mocks.read.mockResolvedValue({ backend: 'claude', harnessSlug: 'project', advSessionId: 18 });
    mocks.host.mockReturnValue({ snapshot: () => ({ executorAttached: false, streamReady: true, terminal: false, descriptor: { lifecycle: 'ready' } }) });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await launchAttachedSuSession(request(), input);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/Reconnect|reconnect/);
    // The bounded wait for the previous engine's exit is slow on purpose; the
    // launch tracer names it rather than leaving the delay unexplained. It is a
    // finished step, so the note is info-level (WI-10004247).
    expect(info.mock.calls.flat().join('\n')).toMatch(/\[su-launch\] .* stage=read-durable-session took \d+ms/);
    info.mockRestore();
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.engine).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex', 'omp'])('reattaches saved %s without bootstrap or a new identity', async (agent) => {
    const chatId = `restored-${agent}`;
    const restored = { snapshot: () => ({ executorAttached: false, streamReady: false, terminal: true }) };
    const binding = { operation: 'attached', backend: agent, advSessionId: 18, ownerId: 'su-engine',
      workspaceId: 'workspace', harnessSlug: 'project', planSlug: 'saved-plan' };
    const native = { backend: agent, sessionId: 'saved-native', rolloutId: 'saved-native', ompThreadId: 'saved-native' };
    const options = { agentChatId: chatId, model: 'saved-model', accountRoute: 'saved-account',
      carry: 'cold', modes: ['auto'], runtimeGeneration: 4 };
    const beforeReady = vi.fn(), onExit = vi.fn(), release = vi.fn();
    mocks.read.mockResolvedValue({ backend: agent, harnessSlug: 'project', advSessionId: 18, ownerId: 'su-engine' });
    mocks.rehydrate.mockResolvedValue(restored);
    mocks.resume.mockResolvedValue({ boot: { ...boot, agent }, binding, nativeSession: native,
      options, beforeReady, onExit, release, exact: true });
    const response = await launchAttachedSuSession(request(), { ...input, agent, agent_chat_id: chatId });
    expect(await response.json()).toMatchObject({ resumed: true, ready: false, advSessionId: 18,
      ownerId: 'su-engine', planSlug: 'saved-plan', nativeSession: native });
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
    const call = (agent === 'claude' ? mocks.engine : mocks.rpc).mock.calls[0];
    expect(call[agent === 'claude' ? 3 : 2]).toMatchObject({ ...options, host: restored, beforeReady, onExit, toolApproval: 'prompt',
      ...(agent === 'claude' ? { resume: true } : { nativeSession: native }) });
  });

  describe('engine identity scope rule (pui-chat-first-ux-2026-09-28 D-004/D-005)', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'pui-identity-')));
    const checkout = join(base, 'checkout');
    const fresh = join(base, 'fresh');
    mkdirSync(join(checkout, 'packages', 'app'), { recursive: true });
    mkdirSync(join(base, 'checkout-sibling'), { recursive: true });
    mkdirSync(fresh, { recursive: true });
    symlinkSync(join(checkout, 'packages'), join(base, 'linked-packages'));
    afterAll(() => rmSync(base, { recursive: true, force: true }));
    const identityOf = (call: unknown[] | undefined) => (call?.[3] as { identity?: string } | undefined)?.identity;

    it.each([
      { dir: () => checkout, expected: 'su', why: 'the checkout root' },
      { dir: () => join(checkout, 'packages', 'app'), expected: 'su', why: 'a directory inside it' },
      { dir: () => join(base, 'linked-packages'), expected: 'su', why: 'a symlink into it' },
      { dir: () => join(base, 'checkout-sibling'), expected: 'coding-assistant', why: 'a sibling sharing its name prefix' },
      { dir: () => base, expected: 'coding-assistant', why: 'its parent' },
      { dir: () => fresh, expected: 'coding-assistant', why: 'an unregistered directory' },
    ])('treats $why as $expected', ({ dir, expected }) => {
      expect(claudeEngineIdentityForCwd(dir(), [checkout])).toBe(expected);
    });

    it('launches a fresh directory as a coding assistant and a registered checkout as SU', async () => {
      mocks.registry.mockResolvedValue({ projects: [{ slug: 'project', path: checkout }, { slug: 'repo-less' }] });
      mocks.bootstrap.mockImplementationOnce(async () => Response.json({ ...boot, cwd: fresh }));
      await launchAttachedSuSession(request(), { ...input, agent_chat_id: 'identity-fresh' });
      mocks.bootstrap.mockImplementationOnce(async () => Response.json({ ...boot, cwd: join(checkout, 'packages') }));
      await launchAttachedSuSession(request(), { ...input, agent_chat_id: 'identity-checkout' });
      expect(mocks.registry).toHaveBeenCalledWith('workspace');
      expect(identityOf(mocks.engine.mock.calls[0])).toBe('coding-assistant');
      expect(identityOf(mocks.engine.mock.calls[1])).toBe('su');
    });

    it('keeps the SU identity when the registry cannot be read', async () => {
      mocks.registry.mockRejectedValue(new Error('registry unavailable'));
      mocks.bootstrap.mockImplementationOnce(async () => Response.json({ ...boot, cwd: fresh }));
      await launchAttachedSuSession(request(), { ...input, agent_chat_id: 'identity-unreadable' });
      expect(identityOf(mocks.engine.mock.calls[0])).toBe('su');
    });

    it('recomputes the identity from the saved directory on resume', async () => {
      mocks.registry.mockResolvedValue({ projects: [{ slug: 'project', path: checkout }] });
      mocks.read.mockResolvedValue({ backend: 'claude', harnessSlug: 'project', advSessionId: 18, ownerId: 'su-engine', cwd: fresh });
      mocks.rehydrate.mockResolvedValue({ snapshot: () => ({ executorAttached: false, streamReady: false, terminal: true }) });
      mocks.resume.mockResolvedValue({ boot: { ...boot, cwd: fresh }, nativeSession: { backend: 'claude', sessionId: 'saved-native' },
        binding: { operation: 'attached', backend: 'claude', advSessionId: 18, ownerId: 'su-engine', workspaceId: 'workspace', harnessSlug: 'project', planSlug: null },
        options: { agentChatId: 'identity-resume' }, beforeReady: vi.fn(), onExit: vi.fn(), release: vi.fn(), exact: true });
      await launchAttachedSuSession(request(), { ...input, agent_chat_id: 'identity-resume' });
      expect(mocks.bootstrap).not.toHaveBeenCalled();
      expect(mocks.engine.mock.calls[0][3]).toMatchObject({ resume: true, identity: 'coding-assistant' });
      expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ cwd: fresh }),
        expect.objectContaining({ identity: 'coding-assistant', stage: expect.any(Function) }));
    });
  });

  describe('P-028 exact-resume startup timeout is recoverable and bounded', () => {
    const timeout = (stage: string) => Object.assign(new Error(`Claude startup timed out during ${stage}`), {
      code: 'su_session_startup_timeout', stage });
    const restoredHost = () => {
      const emitted: Array<Record<string, unknown>> = [];
      let generation = 5;
      return { emitted, host: {
        emit: (event: Record<string, unknown>) => { emitted.push(event); return event; },
        snapshot: () => ({ executorAttached: false, streamReady: false, terminal: true,
          descriptor: { lifecycle: 'failed', runtimeGeneration: generation, identity: { advSessionId: 18 } } }),
        advance: () => { generation += 1; },
      } };
    };
    const engineWith = (ready: Promise<void>, host: ReturnType<typeof restoredHost>['host']) => {
      const engineClose = vi.fn(async () => undefined);
      return { engine: { ready, done: new Promise<void>(() => {}), close: engineClose, pid: () => 4321,
        adapter: { reconcileRuntimeExit: mocks.reconcile, host: { ...host, descriptor: () => host.snapshot().descriptor } } },
      close: engineClose };
    };
    const prepareResume = () => {
      const release = vi.fn(async () => undefined);
      mocks.resume.mockImplementation(async (record: { descriptor?: { runtimeGeneration?: number } }) => ({
        boot, binding: { backend: 'claude', advSessionId: 18, planSlug: null }, nativeSession: { backend: 'claude', sessionId: 'saved-native' },
        options: { runtimeGeneration: (record.descriptor?.runtimeGeneration ?? 4) + 1 },
        beforeReady: vi.fn(), onExit: vi.fn(), release, exact: true }));
      return release;
    };
    const resumeInput = (chatId: string) => ({ ...input, agent_chat_id: chatId });
    const savedRecord = { backend: 'claude', harnessSlug: 'project', advSessionId: 18, ownerId: 'su-engine',
      descriptor: { runtimeGeneration: 4 } };

    it('retries once after a startup timeout and attaches a replacement at the next generation', async () => {
      const { host, emitted } = restoredHost();
      mocks.read.mockResolvedValue(savedRecord);
      mocks.rehydrate.mockResolvedValue(host);
      const release = prepareResume();
      const failed = engineWith(Promise.reject(timeout('transcript restore')), host);
      const recovered = engineWith(Promise.resolve(), host);
      mocks.engine.mockReset().mockReturnValueOnce(failed.engine).mockReturnValueOnce(recovered.engine);
      const response = await launchAttachedSuSession(request(), resumeInput('resume-timeout-once'));
      expect(await response.json()).toMatchObject({ resumed: true, ready: false });
      await vi.waitFor(() => expect(mocks.engine).toHaveBeenCalledTimes(2));
      expect(failed.close).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(recovered.close).not.toHaveBeenCalled();
      // The retry resumes from the host's current generation, not the stale durable copy.
      expect(mocks.resume.mock.calls[1][0]).toMatchObject({ descriptor: { runtimeGeneration: 5 } });
      expect(emitted).toEqual([expect.objectContaining({ type: 'error', code: 'resume_startup_retry', recoverable: true,
        message: expect.stringContaining('stalled in transcript restore') })]);
    });

    it('reports a second startup timeout instead of retrying without bound', async () => {
      const { host, emitted } = restoredHost();
      mocks.read.mockResolvedValue(savedRecord);
      mocks.rehydrate.mockResolvedValue(host);
      const release = prepareResume();
      const first = engineWith(Promise.reject(timeout('resume finalization')), host);
      const second = engineWith(Promise.reject(timeout('resume finalization')), host);
      mocks.engine.mockReset().mockReturnValueOnce(first.engine).mockReturnValueOnce(second.engine);
      await launchAttachedSuSession(request(), resumeInput('resume-timeout-twice'));
      await vi.waitFor(() => expect(second.close).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
      expect(mocks.engine).toHaveBeenCalledTimes(2);
      expect(emitted.filter((event) => event.code === 'resume_startup_retry')).toHaveLength(1);
    });

    it('does not retry a startup refusal that is not a timeout', async () => {
      const { host, emitted } = restoredHost();
      mocks.read.mockResolvedValue(savedRecord);
      mocks.rehydrate.mockResolvedValue(host);
      const release = prepareResume();
      const refused = engineWith(Promise.reject(new Error('Claude SU tool connection is failed')), host);
      mocks.engine.mockReset().mockReturnValueOnce(refused.engine);
      await launchAttachedSuSession(request(), resumeInput('resume-refused'));
      await vi.waitFor(() => expect(refused.close).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      expect(mocks.engine).toHaveBeenCalledOnce();
      expect(emitted).toEqual([]);
    });
  });

  it('closes the allocated runtime and row on readiness failure', async () => {
    const runtime = mocks.engine();
    mocks.engine.mockImplementation(() => ({ ...runtime, ready: Promise.reject(new Error('startup failure')) }));
    const response = await launchAttachedSuSession(request(), input);
    expect(response.status).toBe(200);
    expect((await response.json()).ready).toBe(false);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(mocks.reconcile).toHaveBeenCalledWith({ expected: false, reason: 'Error: startup failure' });
    expect(mocks.ended).toHaveBeenCalledWith(18, null, 'cleanup', { throwOnError: true });
    expect(mocks.pid).not.toHaveBeenCalled();
  });

  it('reuses a still-initializing host on a later retry without another bootstrap', async () => {
    let ready!: () => void;
    const runtime = mocks.engine();
    mocks.engine.mockReturnValue({ ...runtime, ready: new Promise<void>((resolve) => { ready = resolve; }) });
    mocks.engine.mockClear();
    await launchAttachedSuSession(request(), input);
    mocks.read.mockResolvedValue({ backend: 'claude', harnessSlug: 'project', advSessionId: 18 });
    mocks.host.mockReturnValue({ snapshot: () => ({ terminal: false, executorAttached: false, streamReady: false, descriptor: { lifecycle: 'starting' } }) });
    const retry = await launchAttachedSuSession(request(), input);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ duplicate: true, ready: false, advSessionId: 18 });
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(mocks.engine).toHaveBeenCalledOnce();
    ready();
    await vi.waitFor(() => expect(mocks.pid).toHaveBeenCalled());
  });

  it('does not downgrade an unsupported engine to a hidden native client', async () => {
    const response = await launchAttachedSuSession(request(), { ...input, agent: 'unsupported' });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('attached_engine_unavailable');
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.engine).not.toHaveBeenCalled();
  });

  it.each(['codex', 'omp'])('starts %s with a runtime-assigned native id through the same bootstrap', async (agent) => {
    mocks.bootstrap.mockImplementation(async () => Response.json({ ...boot, agent, nativeSessionId: null,
      envelopeEnv: { PAPERCUSP_SID: 'su-engine', CODEX_HOME: '/configured/codex' } }));
    const response = await launchAttachedSuSession(request(), { ...input, agent });
    expect(await response.json()).toMatchObject({ status: 'ok', agent, nativeSession: null, ready: false });
    expect(mocks.rpc).toHaveBeenCalledWith(expect.objectContaining({ agent }),
      expect.objectContaining({ backend: agent, ownerId: 'su-engine', advSessionId: 18 }),
      expect.objectContaining({ accountRoute: 'default', carry: 'warm' }));
    await vi.waitFor(() => expect(mocks.pid).toHaveBeenCalledWith(18, 4321, `pui-structured-${agent}`));
  });

  it.each([
    { model: undefined, expected: CODEX_SAFE_DEFAULT_MODEL, source: 'configured-default' },
    { model: 'gpt-5.6-sol:high', expected: 'gpt-5.6-sol:high', source: 'explicit' },
  ])('carries the visible Codex $source choice through headless bootstrap and execution', async ({ model, expected, source }) => {
    mocks.bootstrap.mockImplementation(async () => Response.json({ ...boot, agent: 'codex', nativeSessionId: null,
      envelopeEnv: { PAPERCUSP_SID: 'su-engine', CODEX_HOME: '/configured/codex' } }));
    const response = await launchAttachedSuSession(request(), { ...input, agent: 'codex', model });
    expect(response.status).toBe(200);
    expect(await (mocks.bootstrap.mock.calls[0][0] as Request).json())
      .toMatchObject({ model: expected, model_source: source, headless: true });
    expect(mocks.rpc.mock.calls[0][2].model).toBe(expected);
  });

  it.each([
    { requested: 'sonnet', expected: 'sonnet[1m]' },
    { requested: 'opus:high', expected: 'opus[1m]:high' },
  ])('normalizes a fresh Claude $requested model before bootstrap and SDK startup', async ({ requested, expected }) => {
    const response = await launchAttachedSuSession(request(), {
      ...input, agent_chat_id: `claude-window-${requested}`, model: requested,
    });
    expect(response.status).toBe(200);
    expect(await (mocks.bootstrap.mock.calls[0][0] as Request).json()).toMatchObject({ model: expected });
    expect(mocks.engine.mock.calls[0][3].model).toBe(expected);
  });
});

// WI-10003879: the :3070 operator runs several cluster workers. The engine
// lives in the worker that attached it, so the launch must say which worker
// that is, and a re-attach landing elsewhere must run on that worker.
describe('engine ownership across cluster workers', () => {
  const remoteOwner = { pid: 99_999, hostId: 'host-a', nonce: 'nonce-a', recordedAt: '2026-10-05T00:00:00.000Z' };

  it('records this worker as the owner before a fresh launch returns', async () => {
    const response = await launchAttachedSuSession(request(), { ...input, agent_chat_id: 'owner-recorded' });
    expect(response.status).toBe(200);
    expect(mocks.recordOwner).toHaveBeenCalledWith(18, expect.objectContaining({
      pid: process.pid, hostId: expect.any(String), nonce: expect.any(String), recordedAt: expect.any(String),
    }), 'workspace');
    // Recorded once the engine exists, so a sibling's first snapshot already finds the owner.
    expect(mocks.engine.mock.invocationCallOrder[0]).toBeLessThan(mocks.recordOwner.mock.invocationCallOrder[0]);
    expect(mocks.callOwner).not.toHaveBeenCalled();
  });

  // agent-chat-pty P-003, 2026-10-05: recording the owner is real I/O, so an
  // engine that fails at once rejects `ready` while the launch is still
  // writing. The launch's exit bookkeeping handles that failure; it must not
  // escape as an unhandled rejection in the meantime (observeReadiness).
  it('an engine that fails at once is handled, not left unhandled, while its owner is written', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      mocks.recordOwner.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(true), 25)));
      const base = mocks.engine();
      // Rejected when the engine starts, not when the mock is set up.
      mocks.engine.mockImplementation(() => ({ ...base, ready: Promise.reject(new Error('engine exited during initialization')) }));
      const response = await launchAttachedSuSession(request(), { ...input, agent_chat_id: 'fails-at-once' });
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith(expect.objectContaining({ expected: false })));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('runs a re-attach on the worker that holds the engine instead of starting a second one', async () => {
    mocks.owner.mockResolvedValue(remoteOwner);
    mocks.forwardable.mockReturnValue(true);
    mocks.callOwner.mockResolvedValue({ ok: true, result: { status: 'ok', httpStatus: 200, body: { status: 'ok', advSessionId: 18, ready: true } } });
    const attach = { ...input, agent_chat_id: 'owned-elsewhere' };
    const response = await launchAttachedSuSession(request(), attach);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Papercusp-Su-Session-Served-By')).toBe('forwarded:99999');
    expect(await response.json()).toEqual({ status: 'ok', advSessionId: 18, ready: true });
    expect(mocks.callOwner).toHaveBeenCalledWith(expect.objectContaining({
      targetPid: 99_999, kind: 'su-session-attach', payload: { input: attach, hostId: 'host-a', nonce: 'nonce-a' },
    }));
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.engine).not.toHaveBeenCalled();
    expect(mocks.recordOwner).not.toHaveBeenCalled();
  });

  it.each(['owner_gone', 'no_handler', 'not_clustered'])('attaches locally when the owner is unreachable for good (%s)', async (code) => {
    mocks.owner.mockResolvedValue(remoteOwner);
    mocks.forwardable.mockReturnValue(true);
    mocks.callOwner.mockResolvedValue({ ok: false, code, message: 'gone' });
    const response = await launchAttachedSuSession(request(), { ...input, agent_chat_id: `owner-${code}` });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Papercusp-Su-Session-Served-By')).toBeNull();
    expect(mocks.engine).toHaveBeenCalledOnce();
    expect(mocks.recordOwner).toHaveBeenCalledWith(18, expect.objectContaining({ pid: process.pid }), 'workspace');
  });

  it('starts nothing and says retry when a live owner does not answer', async () => {
    mocks.owner.mockResolvedValue(remoteOwner);
    mocks.forwardable.mockReturnValue(true);
    mocks.callOwner.mockResolvedValue({ ok: false, code: 'timeout', message: 'no reply in 60000ms' });
    const response = await launchAttachedSuSession(request(), { ...input, agent_chat_id: 'owner-slow' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'su_session_owner_unreachable', retryable: true });
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.engine).not.toHaveBeenCalled();
  });

  it('attaches locally when the recorded owner is this worker or another service', async () => {
    mocks.owner.mockResolvedValue(remoteOwner);
    mocks.forwardable.mockReturnValue(false);
    const response = await launchAttachedSuSession(request(), { ...input, agent_chat_id: 'owner-not-forwardable' });
    expect(response.status).toBe(200);
    expect(mocks.callOwner).not.toHaveBeenCalled();
    expect(mocks.engine).toHaveBeenCalledOnce();
  });
});

describe('launch stage tracer (a stalled launch names its step)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reports the step a launch is stuck in once the stall deadline passes', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const trace = launchStageTracer('ws:h:chat', (line) => lines.push(line), () => Date.now());
    trace.stage('read-durable-session');
    trace.stage('bootstrap');
    vi.advanceTimersByTime(LAUNCH_STALL_REPORT_MS - 1);
    expect(lines).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[su-launch\] ws:h:chat not finished after \d+ms; stalled in stage=bootstrap for \d+ms$/);
    trace.end();
  });

  it('says when the stall report itself ran late, and only then', () => {
    vi.useFakeTimers();
    // The injected clock runs ahead of the timer queue: the report is due at
    // the deadline but the process could not run it for 9s, as observed in
    // WI-10006559. A report just under the lateness threshold keeps the plain line.
    let clock = 1_000_000;
    const lines: string[] = [];
    const late = launchStageTracer('ws:h:late', (line) => lines.push(line), () => clock);
    late.stage('bootstrap');
    clock += LAUNCH_STALL_REPORT_MS + 9_186;
    vi.advanceTimersByTime(LAUNCH_STALL_REPORT_MS);
    expect(lines).toEqual([`[su-launch] ws:h:late not finished after ${LAUNCH_STALL_REPORT_MS + 9_186}ms; `
      + `stalled in stage=bootstrap for ${LAUNCH_STALL_REPORT_MS + 9_186}ms; this report ran 9186ms late (event loop delayed)`]);
    late.end();

    clock = 2_000_000;
    lines.length = 0;
    const prompt = launchStageTracer('ws:h:prompt', (line) => lines.push(line), () => clock);
    clock += LAUNCH_STALL_REPORT_MS + LATE_STALL_REPORT_MS - 1;
    vi.advanceTimersByTime(LAUNCH_STALL_REPORT_MS);
    expect(lines).toEqual([`[su-launch] ws:h:prompt not finished after ${LAUNCH_STALL_REPORT_MS + LATE_STALL_REPORT_MS - 1}ms; `
      + `stalled in stage=read-chat for ${LAUNCH_STALL_REPORT_MS + LATE_STALL_REPORT_MS - 1}ms`]);
    prompt.end();
  });

  it('does not label a wall-clock jump as event-loop delay', () => {
    vi.useFakeTimers();
    let wallClock = 1_000_000;
    let monotonicClock = 10_000.25;
    const wallNow = vi.spyOn(Date, 'now').mockImplementation(() => wallClock);
    const monotonicNow = vi.spyOn(performance, 'now').mockImplementation(() => monotonicClock);
    const lines: string[] = [];
    try {
      const trace = launchStageTracer('ws:h:wall-clock', (line) => lines.push(line));
      trace.stage('bootstrap');
      wallClock += LAUNCH_STALL_REPORT_MS + 9_186;
      monotonicClock += LAUNCH_STALL_REPORT_MS + 0.6;
      vi.advanceTimersByTime(LAUNCH_STALL_REPORT_MS);
      expect(lines).toEqual([`[su-launch] ws:h:wall-clock not finished after ${LAUNCH_STALL_REPORT_MS + 1}ms; `
        + `stalled in stage=bootstrap for ${LAUNCH_STALL_REPORT_MS + 1}ms`]);
      trace.end();
    } finally {
      monotonicNow.mockRestore();
      wallNow.mockRestore();
    }
  });

  it('reports slow finished steps with their duration and stays quiet for fast ones', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const trace = launchStageTracer('ws:h:chat', (line) => lines.push(line), () => Date.now());
    vi.advanceTimersByTime(10);
    trace.stage('bootstrap');
    vi.advanceTimersByTime(SLOW_LAUNCH_STAGE_MS);
    trace.stage('engine-start');
    trace.end();
    // The stall report never fires after end(), however long the process lives.
    vi.advanceTimersByTime(LAUNCH_STALL_REPORT_MS * 2);
    expect(lines).toEqual([`[su-launch] ws:h:chat stage=bootstrap took ${SLOW_LAUNCH_STAGE_MS}ms`]);
  });

  it('marks a stall as warn and a slow finished step as info', () => {
    vi.useFakeTimers();
    const seen: Array<[string, LaunchTraceLevel]> = [];
    const trace = launchStageTracer('ws:h:chat', (line, level) => seen.push([line, level]), () => Date.now());
    trace.stage('bootstrap');
    vi.advanceTimersByTime(LAUNCH_STALL_REPORT_MS);
    trace.stage('engine-start');
    trace.end();
    expect(seen.map(([line, level]) => [line.includes('not finished') ? 'stall' : 'slow-step', level]))
      .toEqual([['stall', 'warn'], ['slow-step', 'info']]);
  });

  // WI-10004247 (rehearsal run 15): the slow-step line went to console.warn, so
  // a launch that WORKED failed the in-process PTY suite under fail-on-console
  // whenever load stretched bootstrap past SLOW_LAUNCH_STAGE_MS.
  it('default sink never sends a completed slow step to console.warn', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const trace = launchStageTracer('ws:h:chat', undefined, () => Date.now());
      trace.stage('bootstrap');
      vi.advanceTimersByTime(SLOW_LAUNCH_STAGE_MS + 450);
      trace.stage('engine-start');
      trace.end();
      expect(warn).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(`[su-launch] ws:h:chat stage=bootstrap took ${SLOW_LAUNCH_STAGE_MS + 450}ms`);
      logLaunchTrace('stuck', 'warn');
      expect(warn).toHaveBeenCalledWith('stuck');
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});
