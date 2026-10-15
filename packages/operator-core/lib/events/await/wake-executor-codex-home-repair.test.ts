import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readSuLaunchSpecByOwner: vi.fn(),
  getAdvSession: vi.fn(),
  getPresence: vi.fn(),
  buildLaunchSpec: vi.fn(),
  ensureHome: vi.fn(),
  readSuperuserToken: vi.fn(),
  allowsAmbient: vi.fn(),
}));

vi.mock('../../adv-sessions', async (original) => ({
  ...(await original<typeof import('../../adv-sessions')>()),
  readSuLaunchSpecByOwner: mocks.readSuLaunchSpecByOwner,
  getAdvSession: mocks.getAdvSession,
}));
vi.mock('../../role-launch-spec', async (original) => ({
  ...(await original<typeof import('../../role-launch-spec')>()),
  buildLaunchSpec: mocks.buildLaunchSpec,
}));
vi.mock('../../role-codex-home', async (original) => ({
  ...(await original<typeof import('../../role-codex-home')>()),
  ensureSuCodexHomeConfigAsync: mocks.ensureHome,
}));
vi.mock('../../superuser-token', async (original) => ({
  ...(await original<typeof import('../../superuser-token')>()),
  readSuperuserToken: mocks.readSuperuserToken,
}));
vi.mock('../../capability-envelope/session-confinement-port', async (original) => ({
  ...(await original<typeof import('../../capability-envelope/session-confinement-port')>()),
  sessionAllowsAmbientContext: mocks.allowsAmbient,
}));

vi.mock('../../agent-tools/coordination/presence', async (original) => ({
  ...(await original<typeof import('../../agent-tools/coordination/presence')>()),
  getPresence: mocks.getPresence,
}));

import { defaultEnsureCodexHomeForWake } from './wake-executor';

const OWNER = 'su-codex-wake-repair';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSuLaunchSpecByOwner.mockResolvedValue({
    v: 1,
    agent: 'codex',
    workspaceId: 'papercusp-workspace',
    harnessSlug: null,
    profile: 'engineer',
    contextSize: 'trimmed',
    personaTier: null,
    model: 'gpt-6.1-sol',
    planSlug: null,
    launchedBy: null,
    autoMode: false,
    drainMode: false,
    loopArmed: false,
    headless: true,
    fleet: null,
  });
  mocks.getAdvSession.mockResolvedValue(null);
  mocks.getPresence.mockResolvedValue(null);
  mocks.buildLaunchSpec.mockResolvedValue({ mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' });
  mocks.ensureHome.mockReturnValue({ repaired: true });
  mocks.readSuperuserToken.mockReturnValue('test-token');
  mocks.allowsAmbient.mockResolvedValue(true);
});

describe('default Codex wake home repair', () => {
  it.each(['error', 'string'])('redacts credentials in %s config-parser failures without dropping the wake', async (kind) => {
    const bearer = 'opaque-test-bearer-value-for-wake-repair';
    const diagnostic = `Invalid character, expected "=" at row 102\n103: http_headers = { Authorization = "Bearer ${bearer}" }`;
    mocks.ensureHome.mockRejectedValueOnce(kind === 'error' ? new Error(diagnostic) : diagnostic);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await defaultEnsureCodexHomeForWake({ advSessionId: 123, owner: OWNER,
        codexHome: '/tmp/codex-home', headless: true })).toEqual({
        ok: false, repaired: false, reason: 'repair-failed',
      });
      expect(warning).toHaveBeenCalledOnce();
      const message = warning.mock.calls[0][0];
      expect(message).toContain('Invalid character, expected "=" at row 102');
      expect(message).toContain('Authorization = "Bearer [redacted]"');
      expect(message).not.toContain(bearer);
    } finally {
      warning.mockRestore();
    }
  });

  it.each([true, false])('preserves the authoritative ambient-context policy (%s) during wake repair', async (allowed) => {
    mocks.allowsAmbient.mockResolvedValue(allowed);
    mocks.getAdvSession.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex',
      workspaceId: 'papercusp-workspace', cwd: '/frozen-assignment' });
    expect(await defaultEnsureCodexHomeForWake({ advSessionId: 123, owner: OWNER,
      codexHome: '/tmp/codex-home', headless: true })).toMatchObject({ ok: true, repaired: true });
    expect(mocks.allowsAmbient).toHaveBeenCalledWith({ ownerId: OWNER, workspaceId: 'papercusp-workspace' });
    const input = mocks.ensureHome.mock.calls[0][0];
    expect(input.denyAmbientContext === true).toBe(!allowed);
    expect(input.projectDir).toBe('/frozen-assignment');
  });

  it.each([
    { name: 'equals form', launchArgv: ['psu', '--compaction-limit=250000'] },
    { name: 'space form', launchArgv: ['psu', '--compaction-limit', '250000'] },
  ])('preserves the $name soft compaction ceiling from the ADV row', async ({ launchArgv }) => {
    const sessionRow = {
      coordOwnerId: OWNER,
      agent: 'codex',
      workspaceId: 'papercusp-workspace',
      launchArgv,
      cwd: '/workspace/papercusp',
    } as never;

    const result = await defaultEnsureCodexHomeForWake({
      advSessionId: 123,
      owner: OWNER,
      codexHome: '/tmp/codex-home',
      headless: true,
      sessionRow,
    });

    expect(result).toMatchObject({ ok: true, repaired: true });
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({ compactionLimit: 250_000 }));
    expect(mocks.getAdvSession).not.toHaveBeenCalled();
  });

  it('loads the ADV row when the wake did not include it', async () => {
    mocks.getAdvSession.mockResolvedValue({
      coordOwnerId: OWNER,
      agent: 'codex',
      workspaceId: 'papercusp-workspace',
      launchArgv: ['psu', '--compaction-limit=250000'],
      cwd: '/workspace/papercusp',
    });

    const result = await defaultEnsureCodexHomeForWake({
      advSessionId: 123,
      owner: OWNER,
      codexHome: '/tmp/codex-home',
      headless: true,
    });

    expect(result).toMatchObject({ ok: true, repaired: true });
    expect(mocks.getAdvSession).toHaveBeenCalledWith(123);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({ compactionLimit: 250_000 }));
  });

  it.each([
    { name: 'stale launch ceiling', launchArgv: ['psu', '--compaction-limit=250000'] },
    { name: 'missing launch ceiling', launchArgv: ['psu'] },
  ])('preserves the current owner budget over a $name', async ({ launchArgv }) => {
    mocks.getPresence.mockResolvedValue({ ownerId: OWNER, compactionLimit: 225_000 });
    const result = await defaultEnsureCodexHomeForWake({
      advSessionId: 123,
      owner: OWNER,
      codexHome: '/tmp/codex-home',
      headless: true,
      sessionRow: { coordOwnerId: OWNER, agent: 'codex', launchArgv } as never,
    });

    expect(result).toMatchObject({ ok: true, repaired: true });
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({ compactionLimit: 225_000 }));
    expect(mocks.getPresence).toHaveBeenCalledWith(OWNER);
  });

  it('repairs the native config threshold from the current owner budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wake-owner-budget-'));
    const homes = join(root, 'homes');
    const home = join(homes, 'session-123');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.toml'),
      'model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\nmodel = "gpt-6.1-sol"\n');
    vi.stubEnv('PAPERCUSP_SU_CODEX_HOMES_DIR', homes);
    vi.stubEnv('PAPERCUSP_CODEX_SQLITE_HOMES_DIR', join(root, 'sqlite'));
    try {
      const { ensureSuCodexHomeConfig } = await vi.importActual<typeof import('../../role-codex-home')>('../../role-codex-home');
      mocks.ensureHome.mockImplementationOnce(ensureSuCodexHomeConfig);
      mocks.getPresence.mockResolvedValue({ ownerId: OWNER, compactionLimit: 225_000 });

      expect(await defaultEnsureCodexHomeForWake({
        advSessionId: 123,
        owner: OWNER,
        codexHome: home,
        headless: true,
        requireGatewayProvider: true,
        sessionRow: { coordOwnerId: OWNER, agent: 'codex', launchArgv: ['psu', '--compaction-limit=250000'] } as never,
      })).toMatchObject({ ok: true, repaired: true });

      const config = readFileSync(join(home, 'config.toml'), 'utf8');
      expect(config).toContain('model_auto_compact_token_limit = 180000\n');
      expect(config).not.toContain('model_auto_compact_token_limit = 900000');
      expect(config).toContain('model_provider = "papercusp-codex-gateway"');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the existing home unchanged when the current budget cannot be read', async () => {
    mocks.getPresence.mockRejectedValueOnce(new Error('owner budget unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await defaultEnsureCodexHomeForWake({
        advSessionId: 123,
        owner: OWNER,
        codexHome: '/tmp/codex-home',
        headless: true,
        sessionRow: { coordOwnerId: OWNER, agent: 'codex', launchArgv: ['psu', '--compaction-limit=250000'] } as never,
      })).toMatchObject({ ok: false, repaired: false, reason: 'repair-failed' });
      expect(mocks.ensureHome).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});
