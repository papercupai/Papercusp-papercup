import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rebuild: vi.fn(),
  pinnedPrompt: vi.fn(),
  buildLaunchSpec: vi.fn(),
  ensureHome: vi.fn(),
  recordLaunchSpec: vi.fn(),
  requestActivation: vi.fn(),
  sessionRow: vi.fn(),
  readRecord: vi.fn(),
  roleBinding: vi.fn(),
  buildRole: vi.fn(),
  roleHome: vi.fn(),
  funding: vi.fn(),
  allowsAmbient: vi.fn(),
  presence: vi.fn(),
  presenceRows: vi.fn(),
  fleetMemberships: vi.fn(),
  resumableSessions: vi.fn(),
  archiveStamp: vi.fn(),
  resumeTarget: vi.fn(),
}));

const OWNER = 'su-p006-pinned-codex';
const ADV_SESSION_ID = 900_000_000 + process.pid;
const REVISION = 'a'.repeat(64);
const savedRecord = {
  v: 1, agent: 'codex', workspaceId: 'papercusp-workspace',
  codexSqliteHome: '/original-state/session-123',
  harnessSlug: null, profile: 'generic', contextSize: 'trimmed',
  personaTier: 'full', model: 'gpt-6-sol', planSlug: null,
  launchedBy: null, autoMode: false, drainMode: false,
  loopArmed: false, headless: true, fleet: null, stack: ['domain:research'],
  selectedIdentity: { ref: 'domain:research', sourceRevision: REVISION },
  specificationRevision: REVISION,
  specificationArtifact: { specificationRevision: REVISION },
};

vi.mock('../../../adv-sessions', async (original) => ({
  ...(await original<typeof import('../../../adv-sessions')>()),
  readSuLaunchSpecByOwner: mocks.readRecord,
  getAdvSession: mocks.sessionRow,
  recordSuLaunchSpec: mocks.recordLaunchSpec,
  listResumableSessions: mocks.resumableSessions,
}));
vi.mock('../../../session-archive', () => ({
  pgSessionArchiveStore: () => ({ readStamp: mocks.archiveStamp }),
}));
vi.mock('../../../agent-launch-core', async (original) => ({
  ...(await original<typeof import('../../../agent-launch-core')>()),
  resolveResumeTarget: mocks.resumeTarget,
}));
vi.mock('../../../agent-tools/coordination/presence', async (original) => ({
  ...(await original<typeof import('../../../agent-tools/coordination/presence')>()),
  getPresence: mocks.presence,
  listPresence: mocks.presenceRows,
}));
vi.mock('../../../agent-tools/coordination/presence-fleet', async (original) => ({
  ...(await original<typeof import('../../../agent-tools/coordination/presence-fleet')>()),
  fetchPresenceFleet: mocks.fleetMemberships,
}));
vi.mock('../../../su-persona-render', async (original) => ({
  ...(await original<typeof import('../../../su-persona-render')>()),
  rebuildSuLaunchArtifact: mocks.rebuild,
  pinnedSuRecoveryPrompt: mocks.pinnedPrompt,
}));
vi.mock('../../../role-launch-spec', async (original) => ({
  ...(await original<typeof import('../../../role-launch-spec')>()),
  buildLaunchSpec: mocks.buildLaunchSpec,
  buildRoleLaunchSpec: mocks.buildRole,
}));
vi.mock('../../../role-codex-home', async (original) => ({
  ...(await original<typeof import('../../../role-codex-home')>()),
  ensureSuCodexHomeConfig: mocks.ensureHome,
  ensureSuCodexHomeConfigAsync: mocks.ensureHome,
  writeRoleCodexHomeAsync: mocks.roleHome,
}));
vi.mock('../../../blueprint/operation-worker-binding', async (original) => ({
  ...(await original<typeof import('../../../blueprint/operation-worker-binding')>()),
  resolveAcceptedOperationWorkerBinding: mocks.roleBinding,
}));
vi.mock('../../../spawn-config', async (original) => ({
  ...(await original<typeof import('../../../spawn-config')>()),
  resolveProjectDir: vi.fn(async () => '/fixture/research'),
}));
vi.mock('../../../cupboard/identity-activation-gate-io', () => ({ admitIdentityActivation: mocks.funding }));
vi.mock('../../../agent-tools/coordination/control-anchor', async (original) => ({
  ...(await original<typeof import('../../../agent-tools/coordination/control-anchor')>()),
  requestSessionIdentityActivation: mocks.requestActivation,
}));
vi.mock('../../../superuser-token', async (original) => ({
  ...(await original<typeof import('../../../superuser-token')>()),
  readSuperuserToken: vi.fn(() => 'fixture-token'),
}));
vi.mock('../../../cupboard/identity-activation-restart', () => ({
  rebuildSuLaunchArtifactFunded: async (input: unknown) => ({ rebuilt: await mocks.rebuild(input) }),
}));
vi.mock('../../../capability-envelope/session-confinement-port', async (original) => ({
  ...(await original<typeof import('../../../capability-envelope/session-confinement-port')>()),
  sessionAllowsAmbientContext: mocks.allowsAmbient,
}));

let ensureCodexHome: (req: Request) => Promise<Response>;
let resumableSessions: (req: Request) => Promise<Response>;
beforeAll(async () => {
  const routes = (await import('./sessions')).default;
  const db = await import('@papercusp/db-org');
  vi.spyOn(db, 'getOrgPg').mockReturnValue({ sql: {} } as ReturnType<typeof db.getOrgPg>);
  const route = routes.find((entry) => entry.path === '/adv/sessions/ensure-codex-home');
  if (!route) throw new Error('ensure-codex-home route is absent');
  ensureCodexHome = route.handler as typeof ensureCodexHome;
  resumableSessions = routes.find((entry) => entry.path === '/adv/sessions/resumable')!.handler as typeof resumableSessions;
}, 45_000);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex' });
  mocks.readRecord.mockResolvedValue(savedRecord);
  mocks.funding.mockResolvedValue({ ok: true });
  mocks.recordLaunchSpec.mockResolvedValue(true);
  mocks.roleHome.mockReturnValue({ sqliteHome: '/original-state/session-123' });
  mocks.pinnedPrompt.mockReturnValue({ promptText: 'PINNED V1 INSTRUCTIONS', specificationRevision: REVISION });
  mocks.buildLaunchSpec.mockResolvedValue({ mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' });
  mocks.ensureHome.mockReturnValue({ repaired: true, promptRepaired: true,
    codexHome: '/tmp/p006-home', sqliteHome: savedRecord.codexSqliteHome });
  mocks.allowsAmbient.mockResolvedValue(true);
  mocks.presence.mockResolvedValue(null);
  mocks.presenceRows.mockResolvedValue([]);
  mocks.fleetMemberships.mockResolvedValue(new Map());
  mocks.resumableSessions.mockResolvedValue([]);
  mocks.archiveStamp.mockResolvedValue(null);
  mocks.resumeTarget.mockResolvedValue({ ok: false, error: 'not_found' });
});

async function call(model?: string, extra: { requireGatewayProvider?: boolean } = {}) {
  return ensureCodexHome(new Request('http://localhost:3170/api/adv/sessions/ensure-codex-home', {
    method: 'POST', body: JSON.stringify({ owner: OWNER, advSessionId: ADV_SESSION_ID, model, ...extra }),
  }));
}

describe('resumable agent ID lookup', () => {
  it.each(['claude', 'codex', 'omp'])('loads the canonical latest %s row outside the recent window', async (agent) => {
    const latest = { id: ADV_SESSION_ID, agent, coordOwnerId: OWNER, sessionId: 'native-latest' };
    mocks.resumeTarget.mockResolvedValue({ ok: true, advSessionId: ADV_SESSION_ID, ownerId: OWNER });
    mocks.resumableSessions.mockResolvedValue([latest]);

    const response = await resumableSessions(new Request(`http://localhost:3170/api/adv/sessions/resumable?agentId=${OWNER}`));
    expect(response.status).toBe(200);
    expect(mocks.resumeTarget).toHaveBeenCalledExactlyOnceWith({ agentId: OWNER });
    expect(mocks.resumableSessions).toHaveBeenCalledExactlyOnceWith(30, { exactId: ADV_SESSION_ID });
    expect(await response.json()).toMatchObject({
      sessions: [latest], exact: { id: ADV_SESSION_ID, ownerId: OWNER, requestedAgentId: OWNER },
    });
  });

  it('does not return recent unrelated agents when the requested agent is absent', async () => {
    mocks.resumableSessions.mockResolvedValue([{ id: 1, coordOwnerId: 'su-other' }]);
    const response = await resumableSessions(new Request(`http://localhost:3170/api/adv/sessions/resumable?agentId=${OWNER}`));
    expect(await response.json()).toEqual({ sessions: [] });
    expect(mocks.resumableSessions).not.toHaveBeenCalled();
  });

  it('rejects malformed agent IDs before consulting the resolver', async () => {
    const response = await resumableSessions(new Request('http://localhost:3170/api/adv/sessions/resumable?agentId=not-an-su'));
    expect(response.status).toBe(400);
    expect(mocks.resumeTarget).not.toHaveBeenCalled();
  });
});

describe('resumable archived backend identity', () => {
  const nativeId = '01a133bc-e525-75a1-885d-ea1cd5d4a1e5';

  it('finds an archived OMP thread when the tracked row has no session_id', async () => {
    mocks.resumableSessions.mockResolvedValue([
      { id: ADV_SESSION_ID, agent: 'omp', sessionId: null, ompThreadId: nativeId, workspaceId: 'papercusp-workspace' },
    ]);
    mocks.archiveStamp.mockResolvedValue({ sourceKind: 'omp', sessionId: nativeId });

    const response = await resumableSessions(new Request('http://localhost:3170/api/adv/sessions/resumable'));
    expect(response.status).toBe(200);
    expect((await response.json()).sessions).toEqual([
      expect.objectContaining({ agent: 'omp', sessionId: null, ompThreadId: nativeId, hasArchive: true }),
    ]);
    expect(mocks.archiveStamp).toHaveBeenCalledExactlyOnceWith('omp', nativeId);
  });

  it('does not lend one backend archive to another backend with the same native id', async () => {
    mocks.resumableSessions.mockResolvedValue([
      { id: ADV_SESSION_ID, agent: 'omp', sessionId: null, ompThreadId: nativeId },
      { id: ADV_SESSION_ID + 1, agent: 'claude', sessionId: nativeId, ompThreadId: null },
    ]);
    mocks.archiveStamp.mockImplementation(async (agent: string) => agent === 'omp' ? { sourceKind: 'omp', sessionId: nativeId } : null);

    const response = await resumableSessions(new Request('http://localhost:3170/api/adv/sessions/resumable'));
    expect((await response.json()).sessions).toEqual([
      expect.objectContaining({ agent: 'omp', hasArchive: true }),
      expect.objectContaining({ agent: 'claude', hasArchive: false }),
    ]);
    expect(mocks.archiveStamp).toHaveBeenCalledWith('omp', nativeId);
    expect(mocks.archiveStamp).toHaveBeenCalledWith('claude', nativeId);
    expect(mocks.archiveStamp).toHaveBeenCalledTimes(2);
  });
});

describe('ensure-codex-home pinned-source recovery', () => {
  it('repairs from the SQLite receipt pinned to the requested ADV session', async () => {
    mocks.readRecord.mockResolvedValue({ ...savedRecord, codexSqliteHome: '/original-state/session-123' });
    mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });
    expect((await call()).status).toBe(200);
    expect(mocks.readRecord).toHaveBeenCalledExactlyOnceWith(OWNER, ADV_SESSION_ID);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({
      recordedSqliteHome: '/original-state/session-123',
    }));
  });

  it('records the recovered SQLite binding for a legacy launch receipt', async () => {
    const { codexSqliteHome, ...legacy } = savedRecord;
    mocks.readRecord.mockResolvedValue(legacy);
    mocks.ensureHome.mockReturnValue({ repaired: false, promptRepaired: false, sqliteHome: codexSqliteHome });
    mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });
    expect((await call()).status).toBe(200);
    expect(mocks.recordLaunchSpec).toHaveBeenCalledExactlyOnceWith(ADV_SESSION_ID, OWNER,
      expect.objectContaining({ codexSqliteHome }));
  });

  it.each([true, false])('reseeds the managed clone directory trust during home repair (ambient=%s)', async (ambient) => {
    const cwd = '/fixture/managed-clone-outside-ambient-trust';
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', cwd });
    mocks.allowsAmbient.mockResolvedValue(ambient);
    mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });

    expect((await call()).status).toBe(200);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({
      trustDir: cwd,
      projectDir: cwd,
    }));
  });

  it('retains a later owner budget when repairing a home with an older launch flag', async () => {
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', launchArgv: ['psu', '--compaction-limit=250000'] });
    mocks.presence.mockResolvedValue({ compactionLimit: 200_000, fleetRole: 'member' });
    mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });
    expect((await call()).status).toBe(200);
    expect(mocks.presence).toHaveBeenCalledWith(OWNER);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({ compactionLimit: 200_000 }));
  });

  it.each([200_000, null])('exports the current or derived member budget to the resume client (%s)', async (compactionLimit) => {
    mocks.presenceRows.mockResolvedValue([{ ownerId: OWNER, compactionLimit }]);
    mocks.fleetMemberships.mockResolvedValue(new Map([[OWNER, { fleetSlug: 'fixture-fleet', fleetRole: 'member' }]]));
    mocks.resumableSessions.mockResolvedValue([{ id: ADV_SESSION_ID, coordOwnerId: OWNER, agent: 'codex', launchArgv: ['psu', '--model=gpt-6.1-sol:xhigh'] }]);
    const response = await resumableSessions(new Request('http://localhost:3170/api/adv/sessions/resumable'));
    expect(response.status).toBe(200);
    expect((await response.json()).sessions[0].compactionLimit).toBe(compactionLimit ?? 250_000);
    expect(mocks.presenceRows).toHaveBeenCalledExactlyOnceWith({ ownerIds: [OWNER] });
    expect(mocks.presence).not.toHaveBeenCalled();
    expect(mocks.fleetMemberships).toHaveBeenCalledExactlyOnceWith([OWNER]);
  });

  it.each([
    { fleetRole: 'member', launchArgv: ['psu', '--model=gpt-6.1-sol:xhigh', '--compaction-limit=900000'], expected: 250_000 },
    { fleetRole: 'leader', launchArgv: ['psu', '--model=gpt-6.1-sol:xhigh', '--fleet=fixture'], expected: 450_000 },
    { fleetRole: null, launchArgv: ['psu', '--model=gpt-6.1-sol:xhigh', '--fleet=former-fleet'], expected: 450_000 },
  ])('resolves legacy defaults and limits against current membership ($fleetRole)', async ({ fleetRole, launchArgv, expected }) => {
    mocks.fleetMemberships.mockResolvedValue(fleetRole ? new Map([[OWNER, { fleetSlug: 'fixture-fleet', fleetRole }]]) : new Map());
    mocks.resumableSessions.mockResolvedValue([{ id: ADV_SESSION_ID, coordOwnerId: OWNER, agent: 'codex', launchArgv }]);
    const response = await resumableSessions(new Request('http://localhost:3170/api/adv/sessions/resumable'));
    expect((await response.json()).sessions[0].compactionLimit).toBe(expected);
  });

  it.each([
    { allowed: true, pinnedRecovery: false },
    { allowed: false, pinnedRecovery: false },
    { allowed: false, pinnedRecovery: true },
  ])('retains context confinement while recovering a missing home ($allowed/$pinnedRecovery)', async ({ allowed, pinnedRecovery }) => {
    mocks.allowsAmbient.mockResolvedValue(allowed);
    if (pinnedRecovery) mocks.rebuild.mockRejectedValue(new Error('selected identity inherited source revision changed before SU artifact rebuild'));
    else mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });
    expect((await call()).status).toBe(200);
    expect(mocks.allowsAmbient).toHaveBeenCalledWith({ ownerId: OWNER, workspaceId: 'papercusp-workspace' });
    const input = mocks.ensureHome.mock.calls[0][0];
    expect(input.recoverMissingHome).toBe(true);
    expect(input.denyAmbientContext === true).toBe(!allowed);
    expect(input.promptText).toBe('PINNED V1 INSTRUCTIONS');
  });

  it('rebuilds an accepted role through its pinned operation instead of replacing it with SU grants', async () => {
    const accepted = {
      workItemId: 'WI-50', harnessSlug: 'research', operationId: 'daily-brief',
      specificationRevision: REVISION, stack: ['domain:blueprint-operation-worker'],
      pin: { kind: 'blueprint-operation' }, identity: { ref: 'blueprint-operation-worker' },
      requiredTools: ['reports:publish'],
      modelPolicy: { mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium', onUnavailable: 'fail' },
    };
    mocks.readRecord.mockResolvedValue({ ...savedRecord, harnessSlug: 'research', role: 'researcher' });
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', role: 'researcher',
      feature: 'WI-50', workspaceId: 'papercusp-workspace', sessionId: 'original-native',
      launchArgv: ['psu', '--account=auto'] });
    mocks.roleBinding.mockResolvedValue(accepted);
    mocks.buildRole.mockResolvedValue({ sid: OWNER, nativeSessionId: 'original-native',
      stack: accepted.stack, mcpUrl: 'http://localhost:3170/api/mcp?role=researcher&sig=valid',
      promptText: 'RESTRICTED RESEARCH', cwd: '/fixture/research',
      specificationRevision: REVISION, stateRevision: 'role-state',
      specificationArtifact: { configuration: { grants: { tools: ['reports:publish'] } } } });
    expect((await call('gpt-6.1-sol:medium')).status).toBe(200);
    expect(mocks.rebuild).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
    expect(mocks.buildRole).toHaveBeenCalledWith(expect.objectContaining({
      role: 'researcher', featureId: 'WI-50',
      launchIdentity: { sid: OWNER, nativeSessionId: 'original-native' },
      acceptedOperation: expect.objectContaining({ modelSelection: expect.objectContaining({ model: 'gpt-6.1-sol:medium' }) }),
    }));
    expect(mocks.roleHome).toHaveBeenCalledWith(expect.objectContaining({ preserveExisting: true,
      sid: OWNER, sessionKey: ADV_SESSION_ID, codexGatewayAuto: true,
      mcpUrl: 'http://localhost:3170/api/mcp?role=researcher&sig=valid' }));
    expect(mocks.recordLaunchSpec).toHaveBeenCalledWith(ADV_SESSION_ID, OWNER, expect.objectContaining({
      role: 'researcher', acceptedOperation: expect.objectContaining({ workItemId: 'WI-50' }),
    }));
    expect(mocks.requestActivation).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: OWNER, revision: { specificationRevision: REVISION, stateRevision: 'role-state' },
    }));
  });

  it('preserves an ordinary role home instead of compiling an SU fallback', async () => {
    mocks.readRecord.mockResolvedValue(null);
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', role: 'researcher' });
    const response = await call();
    expect(await response.json()).toMatchObject({ ok: true, repaired: false, reason: 'role-home-preserved' });
    expect(mocks.rebuild).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
    expect(mocks.recordLaunchSpec).not.toHaveBeenCalled();
  });

  it('restores an archived featureless judge with its recorded identity, state, model and auto route', async () => {
    mocks.readRecord.mockResolvedValue({ model: 'gpt-5.6-sol', effort: 'high',
      codexSqliteHome: '/original-state/session-123', mcpTarget: 'spawn-host' });
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', role: 'judge',
      feature: null, workspaceId: 'papercusp-workspace', sessionId: 'original-native',
      launchArgv: ['psu', '--role=judge', '--harness=papercusp', '--model=gpt-5.6-sol:high',
        '--account=auto', '--headless'] });
    mocks.buildRole.mockResolvedValue({ stack: ['domain:judge'], cwd: '/fixture/papercusp',
      mcpUrl: 'http://localhost:3170/api/mcp?role=judge&sig=valid', promptText: 'RESTRICTED JUDGE',
      specificationRevision: REVISION, stateRevision: 'judge-state', specificationArtifact: {} });
    expect(await (await call()).json()).toMatchObject({ repaired: true, role: 'judge', acceptedOperation: false });
    expect(mocks.buildRole).toHaveBeenCalledWith(expect.objectContaining({ role: 'judge',
      harnessSlug: 'papercusp', acceptedOperation: null, mcpTarget: 'spawn-host',
      launchIdentity: { sid: OWNER, nativeSessionId: 'original-native' } }));
    expect(mocks.roleHome).toHaveBeenCalledWith(expect.objectContaining({ preserveExisting: true,
      recordedSqliteHome: '/original-state/session-123', sid: OWNER,
      model: 'gpt-5.6-sol:high', codexGatewayAuto: true, headless: true,
      mcpUrl: 'http://localhost:3170/api/mcp?role=judge&sig=valid' }));
    expect(mocks.recordLaunchSpec).toHaveBeenCalledWith(ADV_SESSION_ID, OWNER, expect.objectContaining({
      role: 'judge', codexSqliteHome: '/original-state/session-123', acceptedOperation: null, mcpTarget: 'spawn-host' }));
    expect(mocks.rebuild).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
  });

  it.each([
    { record: { model: 'gpt-5.6-sol' }, error: 'role_state_binding_unavailable' },
    { record: { codexSqliteHome: '' }, error: 'role_state_binding_unavailable' },
    { record: { codexSqliteHome: 'relative-state' }, error: 'role_state_binding_unavailable' },
    { record: { role: 'su', codexSqliteHome: '/original-state' }, error: 'role_launch_provenance_unavailable' },
  ])('refuses missing or conflicting role recovery provenance: $error', async ({ record, error }) => {
    mocks.readRecord.mockResolvedValue(record);
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', role: 'judge',
      feature: null, workspaceId: 'papercusp-workspace', sessionId: 'original-native',
      launchArgv: ['psu', '--role=judge', '--harness=papercusp', '--model=gpt-5.6-sol:high'] });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error });
    expect(mocks.buildRole).not.toHaveBeenCalled();
    expect(mocks.roleHome).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
    expect(mocks.recordLaunchSpec).not.toHaveBeenCalled();
  });

  it('refuses an incompatible accepted model before changing the role home or receipt', async () => {
    mocks.readRecord.mockResolvedValue({ ...savedRecord, harnessSlug: 'research', role: 'researcher' });
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', role: 'researcher',
      feature: 'WI-50', workspaceId: 'papercusp-workspace', sessionId: 'original-native' });
    mocks.roleBinding.mockResolvedValue({ modelPolicy: {
      mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium', onUnavailable: 'fail',
    } });
    await expect(call('gpt-6-astra:medium')).rejects.toThrow('outside the accepted exact model policy');
    expect(mocks.roleHome).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
    expect(mocks.recordLaunchSpec).not.toHaveBeenCalled();
  });

  it('does not drop an unfunded accepted identity or rewrite its home as SU', async () => {
    mocks.readRecord.mockResolvedValue({ ...savedRecord, harnessSlug: 'research', role: 'researcher' });
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', role: 'researcher',
      feature: 'WI-50', workspaceId: 'papercusp-workspace', sessionId: 'original-native' });
    mocks.roleBinding.mockResolvedValue({ modelPolicy: {
      mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium', onUnavailable: 'fail',
    } });
    mocks.buildRole.mockResolvedValue({ stack: ['domain:blueprint-operation-worker'], cwd: '/fixture/research' });
    mocks.funding.mockResolvedValue({ ok: false, refused: [{ layerRef: 'domain:blueprint-operation-worker' }] });
    const response = await call('gpt-6.1-sol:medium');
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ ok: false, error: 'identity_activation_refused' });
    expect(mocks.roleHome).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
    expect(mocks.recordLaunchSpec).not.toHaveBeenCalled();
    expect(mocks.requestActivation).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'auto', launchArgv: ['psu', '--account=auto'], auto: true, accountId: null },
    { name: 'pin', launchArgv: ['psu', '--account', 'pool-a'], auto: false, accountId: 'pool-a' },
    { name: 'default', launchArgv: ['psu', '--account=default'], auto: false, accountId: null },
    { name: 'legacy', launchArgv: undefined, auto: false, accountId: null },
  ])('preserves the $name launch route when a carry refresh has no provider hint', async ({ launchArgv, auto, accountId }) => {
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', launchArgv });
    mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });
    const response = await call(undefined, { requireGatewayProvider: false });
    expect(response.status).toBe(200);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({
      codexGatewayAuto: auto,
      codexGatewayAccountId: accountId,
      codexGatewayPriority: auto || accountId ? 'su' : null,
    }));
  });

  it.each([
    { name: 'equals form', launchArgv: ['psu', '--compaction-limit=250000'] },
    { name: 'space form', launchArgv: ['psu', '--compaction-limit', '250000'] },
  ])('restores the $name soft compaction ceiling from the ADV launch argv', async ({ launchArgv }) => {
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', launchArgv });
    mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });

    const response = await call();

    expect(response.status).toBe(200);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({ compactionLimit: 250_000 }));
  });

  it('restores the legacy bound gateway provider when the launch argv is unavailable', async () => {
    mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });
    const response = await call(undefined, { requireGatewayProvider: true });
    expect(response.status).toBe(200);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({
      codexGatewayAuto: true, codexGatewayAccountId: null,
    }));
  });

  it('preserves auto routing through pinned instruction recovery', async () => {
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', launchArgv: ['psu', '--account=auto'] });
    mocks.rebuild.mockRejectedValue(new Error('selected identity inherited source revision changed before SU artifact rebuild'));
    const response = await call(undefined, { requireGatewayProvider: false });
    expect(response.status).toBe(200);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({ codexGatewayAuto: true }));
  });

  it('persists the actual model when the prompt and home are already current', async () => {
    mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });
    mocks.ensureHome.mockReturnValue({ repaired: false, promptRepaired: false });
    mocks.recordLaunchSpec.mockResolvedValue(true);
    const response = await call('gpt-6.1-sol:xhigh');
    expect(response.status).toBe(200);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6.1-sol:xhigh' }));
    expect(mocks.recordLaunchSpec).toHaveBeenCalledWith(ADV_SESSION_ID, OWNER, expect.objectContaining({
      model: 'gpt-6.1-sol:xhigh', modelSource: 'inherited',
      selectedIdentity: savedRecord.selectedIdentity,
    }));
    expect(mocks.requestActivation).not.toHaveBeenCalled();
  });

  it('persists the model through pinned-source recovery without activating another identity', async () => {
    mocks.rebuild.mockRejectedValue(new Error('selected identity inherited source revision changed before SU artifact rebuild'));
    mocks.recordLaunchSpec.mockResolvedValue(true);
    const response = await call('gpt-6.1-sol:xhigh');
    expect(response.status).toBe(200);
    expect(mocks.recordLaunchSpec).toHaveBeenCalledWith(ADV_SESSION_ID, OWNER, expect.objectContaining({
      model: 'gpt-6.1-sol:xhigh', selectedIdentity: savedRecord.selectedIdentity,
      specificationRevision: REVISION,
    }));
    expect(mocks.requestActivation).not.toHaveBeenCalled();
  });

  it('restores v1 instructions when v2 blocks rebuild, without claiming a new activation', async () => {
    mocks.rebuild.mockRejectedValue(new Error('selected identity inherited source revision changed before SU artifact rebuild'));
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, repaired: true, reason: 'pinned-source-stale',
      preservedSpecificationRevision: REVISION,
    });
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({
      sid: OWNER, promptText: 'PINNED V1 INSTRUCTIONS',
      mcpUrl: 'http://localhost:3170/api/mcp?superuser=1',
      headless: true,
    }));
    expect(mocks.buildLaunchSpec).toHaveBeenCalledWith(expect.objectContaining({ stack: [], modes: [] }));
    expect(mocks.recordLaunchSpec).not.toHaveBeenCalled();
    expect(mocks.requestActivation).not.toHaveBeenCalled();
  });

  it('does not mask an unrelated rebuild error as pinned-source recovery', async () => {
    mocks.rebuild.mockRejectedValue(new Error('plan context unavailable'));
    await expect(call()).rejects.toThrow('plan context unavailable');
    expect(mocks.pinnedPrompt).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
  });
});
