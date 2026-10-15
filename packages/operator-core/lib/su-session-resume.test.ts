import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableSuSessionRecord } from './su-session-persistence';

const m = vi.hoisted(() => ({
  row: vi.fn(), spec: vi.fn(), acquire: vi.fn(), finalize: vi.fn(), release: vi.fn(), pid: vi.fn(), ended: vi.fn(),
  live: vi.fn(), holder: vi.fn(), witness: vi.fn(), transcript: vi.fn(), ompPath: vi.fn(), account: vi.fn(),
  codexRoute: vi.fn(), ompRoute: vi.fn(), envelope: vi.fn(), archive: vi.fn(),
  ensureCodex: vi.fn(),
  codexReadiness: vi.fn(), exists: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), existsSync: m.exists }));
vi.mock('../../../apps/operator/scripts/psu-launcher.mjs', async (original) => ({
  resolveOmpSessionModel: (await original<typeof import('../../../apps/operator/scripts/psu-launcher.mjs')>()).resolveOmpSessionModel,
  normalizeModelSpecForAgent: (await original<typeof import('../../../apps/operator/scripts/psu-launcher.mjs')>()).normalizeModelSpecForAgent,
  buildResumeEnv: (row: any, opts: any) => ({ PAPERCUSP_SID: row.coordOwnerId,
    PAPERCUSP_ADV_SESSION_ID: String(row.id), ...opts.accountEnv.env }),
  codexThreadWriterHolder: () => ({ held: false, reason: 'no-lock-file' }),
  sessionProcessHolder: m.holder,
  normalizeArgvProbeResumeLocalLivenessEvidence: m.witness,
  normalizeCodexResumeLocalLivenessEvidence: m.witness,
  ensureResumeTranscriptPresent: m.transcript,
  tryRematerializeFromArchive: m.archive,
  ensureCodexHomeViaOperator: m.ensureCodex, ensureInteractiveConfigViaOperator: vi.fn(),
  isClaudeConfigDirLaunchReady: () => true, isCodexHomeLaunchReady: () => true, codexHomeLaunchReadiness: m.codexReadiness,
  rehealResumeCredentials: vi.fn(), rehealResumeCodexAuth: vi.fn(),
  applyCodexGatewayRoute: m.codexRoute, applyOmpResumeAccountRoute: m.ompRoute,
  ompTrackedResumeEnv: () => ({ PI_CODING_AGENT_DIR: '/saved/omp', PI_CONFIG_DIR: '.saved/omp' }),
}));
vi.mock('./adv-sessions', async (orig) => ({
  ...(await orig<typeof import('./adv-sessions')>()),
  getAdvSession: m.row,
  readSuLaunchSpecByOwner: m.spec,
  acquireAdvSessionResume: m.acquire,
  finalizeAdvSessionResume: m.finalize,
  releaseAdvSessionResume: m.release,
  setAdvSessionPid: m.pid,
  markAdvSessionEnded: m.ended,
}));
vi.mock('./su-persona-render', () => ({ parseSuLaunchSpecRecord: (value: unknown) => value }));
vi.mock('./console-launcher', () => ({ buildConsoleEnvelope: m.envelope }));
vi.mock('./interactive-safety-floor', () => ({ checkInteractiveSafetyFloor: async () => ({ ok: true }) }));
vi.mock('./events/await/psu-pty-discovery', () => ({
  findLiveHost: m.live,
  findLiveHostAsync: async (ownerId: string) => m.live(ownerId),
}));
vi.mock('./mcp-base-url', () => ({
  resolveSpawnHostOperatorBaseUrl: () => 'http://localhost:3170',
  resolveChildSessionOperatorBaseUrl: () => 'http://localhost:3170',
}));
vi.mock('./session-transcript-resolvers', () => ({ findOmpSessionPath: m.ompPath }));
vi.mock('./endpoint-route/routes/agent-mcp/bootstrap-su', () => ({ resolveAccountPin: m.account }));
import { prepareStructuredSuResume } from './su-session-resume';

function fixture(backend: 'claude' | 'codex' | 'omp'): DurableSuSessionRecord {
  m.row.mockResolvedValue({ id: 42, workspaceId: 'workspace', harnessSlug: 'project', planSlug: 'saved-plan',
    agent: backend, coordOwnerId: 'saved-owner', cwd: '/project', pid: null, sessionId: 'saved-native' });
  m.spec.mockResolvedValue({ agent: backend, workspaceId: 'workspace', harnessSlug: 'project',
    profile: 'engineer', model: 'saved-model:high', planSlug: 'saved-plan',
    headless: true,
    specificationRevision: 'spec-1', stateRevision: 'state-2' });
  return { advSessionId: 42, workspaceId: 'workspace', agentChatId: 'saved-chat', backend,
    nativeSessionId: 'saved-native', ownerId: 'saved-owner', harnessSlug: 'project',
    runtimeGeneration: 3, pid: null, endedAt: 'yesterday', lifecycle: 'ended', cwd: '/project',
    descriptor: { identity: { agentChatId: 'saved-chat', advSessionId: 42, workspaceId: 'workspace',
      harnessSlug: 'project', backend, nativeSessionId: 'saved-native', ownerId: 'saved-owner' },
    lifecycle: 'ended', role: 'su', runtimeGeneration: 3, model: 'saved-model', accountServed: null, accountRoute: 'named-account',
    carry: 'cold', modes: ['auto', 'ideate'], capabilities: {} as never,
    backendExtension: backend === 'claude' ? { backend, configDir: '/saved/claude', configDirSource: 'observed' }
      : backend === 'codex' ? { backend, codexHome: '/saved/codex' } : { backend, agentHome: '/saved/omp' } } } as DurableSuSessionRecord;
}

beforeEach(() => {
  vi.resetAllMocks();
  m.exists.mockReturnValue(true);
  m.live.mockReturnValue(null);
  m.holder.mockReturnValue({ held: false, reason: 'clean-scan' });
  m.witness.mockReturnValue({ version: 1, kind: 'no-live-claude-process' });
  m.acquire.mockResolvedValue({ acquired: true, status: 'acquired' });
  m.finalize.mockResolvedValue(true);
  m.transcript.mockResolvedValue(true);
  m.ompPath.mockResolvedValue('/saved/omp/sessions/thread.jsonl');
  m.account.mockResolvedValue({ env: { RESTORED_ROUTE: 'named-account' }, accountId: 'named-account', provider: 'anthropic' });
  m.envelope.mockResolvedValue({ cwd: '/project', env: { PAPERCUSP_WORKSPACE: 'workspace' } });
  m.ompRoute.mockReturnValue('saved-model:high');
});

describe('structured exact resume preparation', () => {
  it('identifies the pending resume operation before it settles or refuses', async () => {
    const saved = fixture('codex');
    let refuse!: (error: Error) => void;
    m.account.mockReturnValue(new Promise((_, reject) => { refuse = reject; }));
    const stage = vi.fn();
    const pending = prepareStructuredSuResume(saved, { stage });
    const rejected = expect(pending).rejects.toThrow('route unavailable');
    await vi.waitFor(() => expect(stage).toHaveBeenLastCalledWith('resume-account-route'));
    expect(stage).not.toHaveBeenCalledWith('resume-console-envelope');
    expect(m.envelope).not.toHaveBeenCalled();
    refuse(new Error('route unavailable'));
    await rejected;
    expect(m.release).toHaveBeenCalled();
  });

  it('resumes a coding-assistant Codex home without restoring or requiring the SU playbook', async () => {
    const saved = fixture('codex');
    m.codexReadiness.mockReturnValue('AGENTS.md is missing');
    m.exists.mockImplementation((path: string) => !path.endsWith('AGENTS.md'));
    const resume = await prepareStructuredSuResume(saved, { identity: 'coding-assistant' });
    expect(resume.boot.envelopeEnv.CODEX_HOME).toBe('/saved/codex');
    expect(m.ensureCodex).not.toHaveBeenCalled();
    expect(m.codexReadiness).not.toHaveBeenCalled();
    await resume.release();
  });

  it('still refuses a registered-project Codex home without its SU playbook', async () => {
    const saved = fixture('codex');
    m.codexReadiness.mockReturnValue('AGENTS.md is missing');
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow('AGENTS.md is missing');
    expect(m.ensureCodex).toHaveBeenCalled();
  });

  it('refuses an SU instruction artifact missing after home readiness succeeds', async () => {
    const saved = fixture('codex');
    m.exists.mockImplementation((path: string) => !path.endsWith('AGENTS.md'));
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow('full SU instruction artifact');
    expect(m.release).toHaveBeenCalled();
  });

  it.each(['claude', 'codex', 'omp'] as const)('preserves %s identity, scope and settings and finalizes only after a child exists', async (backend) => {
    const saved = fixture(backend);
    const resume = await prepareStructuredSuResume(saved);
    expect(resume.binding).toMatchObject({ operation: 'attached', advSessionId: 42, ownerId: 'saved-owner',
      workspaceId: 'workspace', harnessSlug: 'project', planSlug: 'saved-plan', backend });
    expect(resume.options).toEqual({ agentChatId: 'saved-chat', model: 'saved-model:high',
      accountRoute: 'named-account', carry: 'cold', modes: ['auto', 'ideate'], runtimeGeneration: 4 });
    expect(resume.boot.envelopeEnv).toMatchObject({ PAPERCUSP_SID: 'saved-owner', PAPERCUSP_ADV_SESSION_ID: '42',
      PAPERCUSP_WORKSPACE: 'workspace', RESTORED_ROUTE: 'named-account' });
    if (backend === 'codex') {
      expect(m.ensureCodex).toHaveBeenCalledWith(
        'saved-owner', '/saved/codex', 42,
        expect.objectContaining({ headless: true }),
      );
    }
    expect(m.finalize).not.toHaveBeenCalled();
    await expect(resume.beforeReady(null)).rejects.toThrow('no native process');
    await resume.beforeReady(12345);
    expect(m.pid).toHaveBeenCalledWith(42, 12345, `pui-structured-${backend}`);
    expect(m.finalize).toHaveBeenCalledWith(42, m.acquire.mock.calls[0][1]);
    await resume.release();
    expect(m.release).not.toHaveBeenCalled();
    await resume.onExit();
    expect(m.ended).toHaveBeenCalledWith(42, null, 'cleanup', { throwOnError: true });
  });

  it('restores Claude default-1M window semantics when only the resolved native model was persisted', async () => {
    const saved = fixture('claude');
    saved.descriptor!.model = 'claude-fable-5-1';
    m.spec.mockResolvedValue({ agent: 'claude', workspaceId: 'workspace', harnessSlug: 'project',
      profile: 'engineer', model: null, planSlug: 'saved-plan',
      specificationRevision: 'spec-1', stateRevision: 'state-2' });

    const resume = await prepareStructuredSuResume(saved);

    expect(resume.options.model).toBe('claude-fable-5-1[1m]');
    expect(m.account).toHaveBeenCalledWith(
      'workspace', 'named-account', 'claude', 'saved-owner', true, 'claude-fable-5-1[1m]',
    );
  });

  it('resumes with the latest owner-selected model when the launch spec is stale', async () => {
    const saved = fixture('claude');
    saved.descriptor!.model = 'claude-sonnet-4-5'; // native resolved id may omit effort
    saved.descriptor!.ownerSelectedModel = 'claude-haiku-4-5:high';
    m.spec.mockResolvedValue({ agent: 'claude', workspaceId: 'workspace', harnessSlug: 'project',
      profile: 'engineer', model: 'claude-opus-4-1:low', planSlug: 'saved-plan',
      specificationRevision: 'spec-1', stateRevision: 'state-2' });

    const resume = await prepareStructuredSuResume(saved);

    expect(resume.options.model).toBe('claude-haiku-4-5:high');
    expect(m.account).toHaveBeenCalledWith(
      'workspace', 'named-account', 'claude', 'saved-owner', true, 'claude-haiku-4-5:high',
    );
    await resume.release();
  });

  it('refuses scope mismatch and a competing host before reserving or touching credentials', async () => {
    const saved = fixture('codex');
    saved.descriptor!.identity.workspaceId = 'another-workspace';
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow('identity');
    const valid = fixture('codex');
    m.live.mockReturnValue({ pid: 123 });
    await expect(prepareStructuredSuResume(valid)).rejects.toThrow('live host');
    expect(m.acquire).not.toHaveBeenCalled();
    expect(m.account).not.toHaveBeenCalled();
  });

  it('refuses a saved OMP default/gateway mismatch without switching provider or touching credentials', async () => {
    const saved = fixture('omp');
    saved.descriptor!.model = 'papercusp-gateway/claude-sonnet-4-6';
    saved.descriptor!.accountRoute = 'default';
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow(/default.*gateway/i);
    expect(m.acquire).not.toHaveBeenCalled();
    expect(m.account).not.toHaveBeenCalled();
    expect(m.ompRoute).not.toHaveBeenCalled();
  });

  it('refuses an unknown liveness witness or a competing lease', async () => {
    const saved = fixture('codex');
    m.witness.mockReturnValue(null);
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow('exclusive ownership');
    expect(m.acquire).not.toHaveBeenCalled();
    m.witness.mockReturnValue({ version: 1, kind: 'no-live-codex-writer' });
    m.acquire.mockResolvedValue({ acquired: false, status: 'reserved' });
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow('reserved');
    expect(m.account).not.toHaveBeenCalled();
  });

  it('reports bounded refusal-time process evidence without exposing argv or native identity', async () => {
    const saved = fixture('claude');
    m.holder.mockReturnValue({ held: false, reason: 'no-proc', pid: null,
      cmdline: 'secret --resume saved-native' });
    m.witness.mockReturnValue(null);
    const error = await prepareStructuredSuResume(saved).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('probe=no-proc, held=false, pid=none, force=false');
    expect((error as Error).message).not.toContain('secret');
    expect((error as Error).message).not.toContain('saved-native');
    expect(m.acquire).not.toHaveBeenCalled();
  });

  it('names the errno behind a failed /proc listing, and only an errno token', async () => {
    const saved = fixture('claude');
    m.witness.mockReturnValue(null);
    m.holder.mockReturnValue({ held: false, reason: 'no-proc', pid: null, cmdline: null, error: 'EMFILE' });
    const named = await prepareStructuredSuResume(saved).catch((value: unknown) => value);
    expect((named as Error).message).toContain('probe=no-proc, error=EMFILE, held=false');
    // Anything that is not errno-shaped (a message, a path) is dropped, not echoed.
    m.holder.mockReturnValue({ held: false, reason: 'no-proc', pid: null, cmdline: null,
      error: "ENOENT: no such file or directory, lstat '/proc/42'" });
    const dropped = await prepareStructuredSuResume(saved).catch((value: unknown) => value);
    expect((dropped as Error).message).toContain('probe=no-proc, held=false');
    expect((dropped as Error).message).not.toContain('/proc/42');
    expect(m.acquire).not.toHaveBeenCalled();
  });

  it('waits for the old Claude process to exit before reserving an exact resume', async () => {
    m.holder.mockReturnValueOnce({ held: true, reason: 'argv-match', pid: 1234 })
      .mockReturnValue({ held: false, reason: 'clean-scan', pid: null });
    m.witness.mockImplementation(({ processHolder }) => processHolder?.reason === 'clean-scan'
      ? { version: 1, kind: 'no-live-claude-process' } : null);

    await expect(prepareStructuredSuResume(fixture('claude'))).resolves.toMatchObject({ exact: true });
    expect(m.holder).toHaveBeenCalledTimes(2);
    expect(m.acquire).toHaveBeenCalledTimes(1);
    expect(m.witness).toHaveBeenCalledWith(expect.objectContaining({
      processHolder: { held: false, reason: 'clean-scan', pid: null },
    }));
    expect(m.live).toHaveBeenCalledTimes(2);
  });

  it('refuses if a competing host appears while waiting for the old process', async () => {
    m.holder.mockReturnValueOnce({ held: true, reason: 'argv-match', pid: 1234 })
      .mockReturnValue({ held: false, reason: 'clean-scan', pid: null });
    m.live.mockReturnValueOnce(null).mockReturnValue({ pid: 4321 });
    await expect(prepareStructuredSuResume(fixture('claude'))).rejects.toThrow('gained a live host');
    expect(m.acquire).not.toHaveBeenCalled();
  });

  it('releases the reservation when the transcript or selected account cannot be restored', async () => {
    const saved = fixture('claude');
    m.transcript.mockResolvedValue({ pending: true });
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow('transcript');
    expect(m.release).toHaveBeenCalledWith(42, m.acquire.mock.calls[0][1]);
    m.transcript.mockResolvedValue(true);
    m.account.mockResolvedValue({ error: 'selected account unavailable' });
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow('selected account');
    expect(m.release).toHaveBeenCalledTimes(2);
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.ended).not.toHaveBeenCalled();
  });

  it('starts a Claude session that never wrote a native transcript fresh; Codex still refuses', async () => {
    m.transcript.mockResolvedValue(false);
    await expect(prepareStructuredSuResume(fixture('claude'))).resolves.toMatchObject({ exact: false });
    expect(m.release).not.toHaveBeenCalled();
    await expect(prepareStructuredSuResume(fixture('codex'))).rejects.toThrow('transcript');
    m.transcript.mockResolvedValue(true);
    await expect(prepareStructuredSuResume(fixture('claude'))).resolves.toMatchObject({ exact: true });
  });

  it('rejects a lost lease before announcing readiness', async () => {
    const resume = await prepareStructuredSuResume(fixture('omp'));
    m.finalize.mockResolvedValue(false);
    await expect(resume.beforeReady(123)).rejects.toThrow('reservation was lost');
    await resume.onExit();
    expect(m.release).toHaveBeenCalled();
    expect(m.ended).not.toHaveBeenCalled();
  });

  it('restores archived OMP files through the selected operator before exact resume', async () => {
    const saved = fixture('omp');
    m.ompPath.mockResolvedValueOnce(null);
    const resume = await prepareStructuredSuResume(saved);
    expect(m.archive).toHaveBeenCalledWith('saved-native', 'omp', { operatorUrl: 'http://localhost:3170' });
    expect(resume.nativeSession).toMatchObject({ backend: 'omp', ompThreadId: 'saved-native', agentHome: '/saved/omp' });
    await resume.release();
  });

  it('passes the saved OMP home into transcript preflight before preparing the native executor', async () => {
    const saved = fixture('omp');
    m.transcript.mockImplementation(async (source) => source.agentHome === '/saved/omp');
    const resume = await prepareStructuredSuResume(saved);
    expect(m.transcript).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'omp', ompThreadId: 'saved-native', agentHome: '/saved/omp',
    }), expect.any(Object));
    expect(resume.boot.envelopeEnv.PI_CODING_AGENT_DIR).toBe('/saved/omp');
    await resume.release();
  });
});
