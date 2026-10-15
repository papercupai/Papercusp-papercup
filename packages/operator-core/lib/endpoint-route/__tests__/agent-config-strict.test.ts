/**
 * POST /api/agent-config strict-save guard: a body whose entries the parsers
 * would silently drop (invalid tier row, dangling ceiling, unknown surface
 * key) is REJECTED with 422 instead of persisting a gutted config — silent
 * normalization is how /settings/agent edits got wiped on reload
 * (owner bug 2026-06-11). Valid bodies persist verbatim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_TIERS, MODEL_EFFORT_LEVELS } from '../../agent-config-constants';
import { launchableModes } from '../../modes/registry';
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

// writeAgentConfig hits PG + process.env — mock the write, keep the real
// parsers (they ARE the subject under test via the route's drop detection).
const { writeMock, readMock, listResumableSessionsMock, readCodexHomeDiagnosticsMock } = vi.hoisted(() => ({
  writeMock: vi.fn(async (cfg: unknown) => cfg),
  readMock: vi.fn<() => Promise<Record<string, unknown>>>(async () => ({
    backend: 'claude-code',
    cmd: '',
    models: {},
    backends: {},
    surfaceModels: {},
    tiers: [],
    tierCeilings: {},
    resolverProfiles: {
      'inbox-resolve': {
        model: null as string | null,
        effort: null as string | null,
        account: 'default',
        carry: 'warm',
      },
      'plan-cleanup': { model: 'opus', effort: 'high', account: 'auto', carry: 'cold' },
    },
  })),
  listResumableSessionsMock: vi.fn<(_limit?: number) => Promise<unknown[]>>(async () => []),
  readCodexHomeDiagnosticsMock: vi.fn((sessionKey: unknown) => ({
    codexHome: `/codex/session-${sessionKey}`,
    exists: true,
    agentsPath: `/codex/session-${sessionKey}/AGENTS.md`,
    agentsExists: true,
    configPath: `/codex/session-${sessionKey}/config.toml`,
    configExists: true,
    hooksPath: `/codex/session-${sessionKey}/hooks.json`,
    hooksExists: true,
    promptsPath: `/codex/session-${sessionKey}/prompts`,
    promptsExists: true,
    authPath: `/codex/session-${sessionKey}/auth.json`,
    authExists: true,
    diagnosticsPath: `/codex/session-${sessionKey}/papercusp-diagnostics.json`,
    diagnosticsExists: true,
    diagnostics: { lockEnforcement: 'hooks-configured', requiresExplicitPapercuspLocks: false },
    latestRolloutId: 'rollout-1',
    latestRolloutPath: `/codex/session-${sessionKey}/sessions/rollout-1.jsonl`,
    resumeStrategy: 'codex-resume-last-in-code-home',
    resumeCommand: `CODEX_HOME='/codex/session-${sessionKey}' codex resume --last`,
    error: null,
  })),
}));
vi.mock('../../agent-config', async () => {
  const actual = await vi.importActual<typeof import('../../agent-config')>('../../agent-config');
  return { ...actual, readAgentConfig: readMock, writeAgentConfig: writeMock };
});
// The sync detector THROWS here: the route must never run blocking
// spawnSync('which') on the operator main thread (WI-10003266).
vi.mock('../../agent-bin-detect', () => {
  const bins = { claude: '/usr/bin/claude', codex: '/usr/bin/codex', omp: null, pi: null };
  return {
    detectBinaries: () => {
      throw new Error('agent-config route must not call the synchronous detectBinaries()');
    },
    detectBinariesAsync: async () => bins,
    detectBinariesCached: async () => bins,
  };
});
vi.mock('../../adv-sessions', async (orig) => ({
  ...(await orig<typeof import('../../adv-sessions')>()),
  endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  listResumableSessions: (limit?: number) => listResumableSessionsMock(limit),
}));
import { resetLatestAgentSessionMemo } from '../../latest-agent-session-memo';

vi.mock('../../codex-home-diagnostics', () => ({
  readCodexHomeDiagnostics: (sessionKey: string | number) => readCodexHomeDiagnosticsMock(sessionKey),
}));

async function callGet(): Promise<Response> {
  const mod = await import('../routes/agent-config');
  const route = (
    mod.default as unknown as Array<{ method: string; handler: (req: Request) => Promise<Response> }>
  ).find((r) => r.method === 'GET')!;
  return route.handler(new Request('http://localhost:3070/api/agent-config', { method: 'GET' }));
}

async function callPost(body: unknown): Promise<Response> {
  const mod = await import('../routes/agent-config');
  const route = (
    mod.default as unknown as Array<{ method: string; handler: (req: Request) => Promise<Response> }>
  ).find((r) => r.method === 'POST')!;
  const req = new Request('http://localhost:3070/api/agent-config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return route.handler(req);
}

async function callPatch(body: unknown): Promise<Response> {
  const mod = await import('../routes/agent-config');
  const route = (
    mod.default as unknown as Array<{ method: string; handler: (req: Request) => Promise<Response> }>
  ).find((r) => r.method === 'PATCH')!;
  const req = new Request('http://localhost:3070/api/agent-config', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return route.handler(req);
}

const VALID_BODY = {
  backend: 'claude-code',
  cmd: 'claude -p',
  models: { worker: 'haiku' },
  backends: { oracle: 'claude-code' },
  surfaceModels: { oracle: 'opus' },
  tiers: [
    { name: 'fast', spec: 'haiku' },
    { name: 'smart', spec: 'opus:high', when: 'hard work' },
  ],
  tierCeilings: { bee: 'fast' },
  resolverProfiles: {
    'inbox-resolve': { model: 'sonnet', effort: 'high', account: 'default', carry: 'warm' },
    'plan-cleanup': { model: 'sol', effort: 'xhigh', account: 'auto', carry: 'cold' },
  },
};

describe('R-3 role routing configuration persistence', () => {
  const roleAccounts = { 'release-fixer': 'auto', worker: null };
  const roleBackups = { 'release-fixer': [{ backend: 'claude-code', model: 'sonnet', effort: 'high', account: 'pin:fixture-account' }] };

  it('saves valid role routes/backups unchanged and exposes them on GET', async () => {
    const result = await callPost({ ...VALID_BODY, roleAccounts, roleBackups });
    expect(result.status).toBe(200);
    expect(writeMock).toHaveBeenCalledWith(expect.objectContaining({ roleAccounts, roleBackups }));
    readMock.mockResolvedValue({ ...VALID_BODY, roleAccounts, roleBackups });
    expect(await (await callGet()).json()).toMatchObject({ config: { roleAccounts, roleBackups } });
  });

  it('preserves saved routing when older clients omit the new fields', async () => {
    readMock.mockResolvedValue({ ...VALID_BODY, roleAccounts, roleBackups });
    expect((await callPost(VALID_BODY)).status).toBe(200);
    expect(writeMock).toHaveBeenCalledWith(expect.objectContaining({ roleAccounts, roleBackups }));
  });

  it.each([
    { roleAccounts: { worker: 'has spaces' } },
    { roleAccounts: [] },
    { roleAccounts: null },
    { roleBackups: null },
    { roleAccounts: { worker: 'auto', ' worker ': 'default' } },
    { roleBackups: { worker: [], ' worker ': [] } },
    { roleBackups: { worker: [{ backend: 'unknown', model: 'sonnet' }] } },
    { roleBackups: { worker: [{ backend: 'claude-code', model: 'sol' }] } },
    { roleBackups: { worker: [{ backend: 'claude-code', model: 'sonnet', effort: 'impossible' }] } },
    { roleBackups: { worker: [{ backend: 'claude-code', model: 'sonnet' }, { backend: 'claude-code', model: 'sonnet' }] } },
  ])('refuses invalid role routing before persistence: %j', async (routing) => {
    expect((await callPost({ ...VALID_BODY, ...routing })).status).toBe(422);
    expect(writeMock).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  readMock.mockResolvedValue({
    backend: 'claude-code',
    cmd: '',
    models: {},
    backends: {},
    surfaceModels: {},
    tiers: [],
    tierCeilings: {},
    resolverProfiles: {
      'inbox-resolve': { model: null, effort: null, account: 'default', carry: 'warm' },
      'plan-cleanup': { model: 'opus', effort: 'high', account: 'auto', carry: 'cold' },
    },
  });
  listResumableSessionsMock.mockResolvedValue([] as unknown[]);
  // The route memoizes the latest-codex lookup for 30s (WI-2147549); every case here
  // asserts on what the listing returns THIS time, so start each from an empty memo.
  resetLatestAgentSessionMemo();
});

describe('GET /agent-config diagnostics', () => {
  it('projects the effective default tier menu without a second agent-tool request', async () => {
    const json = await (await callGet()).json();
    expect(json.effectiveTiers.map(({ name, spec }: { name: string; spec: string }) => ({ name, spec }))).toEqual(
      DEFAULT_MODEL_TIERS.map(({ name, spec }) => ({ name, spec })),
    );
    expect(json.effectiveTiers.every((tier: { loopCapability?: unknown }) => tier.loopCapability != null)).toBe(true);
  });

  it('projects a stored tier menu wholesale and classifies unsupported Agent Chat rows', async () => {
    readMock.mockResolvedValue({
      backend: 'omp',
      cmd: '',
      models: {},
      backends: {},
      surfaceModels: {},
      tiers: [
        {
          name: 'workspace-only',
          spec: 'unsupported-provider/stealth/ox-alpha:max',
          backend: 'omp',
          when: 'special OMP work',
        },
      ],
      tierCeilings: {},
      resolverProfiles: {},
    });

    const json = await (await callGet()).json();
    expect(json.effectiveTiers).toEqual([
      expect.objectContaining({
        name: 'workspace-only',
        spec: 'unsupported-provider/stealth/ox-alpha:max',
        loopCapability: expect.objectContaining({
          executable: false,
          reason: expect.stringContaining('unsupported loop provider'),
        }),
      }),
    ]);
  });

  it('projects the canonical PSU effort and launch-mode registries for clients', async () => {
    const json = await (await callGet()).json();
    expect(json.effortLevels).toEqual([...MODEL_EFFORT_LEVELS]);
    expect(json.launchableModes).toEqual(launchableModes().map(({ id, title, oneLiner }) => ({ id, title, oneLiner })));
  });

  it('returns codex binary detection and the latest tracked Codex CODEX_HOME diagnostics', async () => {
    listResumableSessionsMock.mockResolvedValue([
      { id: 40, agent: 'claude', coordOwnerId: 'su-c', startedAt: '2026-06-21T00:00:00.000Z', endedAt: null },
      { id: 77, agent: 'codex', coordOwnerId: 'su-x', startedAt: '2026-06-21T01:00:00.000Z', endedAt: null },
    ] as unknown[]);
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(listResumableSessionsMock).toHaveBeenCalledWith(50);
    expect(readCodexHomeDiagnosticsMock).toHaveBeenCalledWith(77);
    const json = await res.json();
    expect(json.binaries.codex).toBe('/usr/bin/codex');
    expect(json.codexDiagnostics.sessionId).toBe(77);
    expect(json.codexDiagnostics.ownerId).toBe('su-x');
    expect(json.codexDiagnostics.home.codexHome).toBe('/codex/session-77');
    expect(json.codexDiagnostics.home.resumeCommand).toContain('codex resume --last');
  });

  it('returns null codexDiagnostics when no tracked Codex session exists yet', async () => {
    listResumableSessionsMock.mockResolvedValue([
      { id: 40, agent: 'claude', coordOwnerId: 'su-c', startedAt: '2026-06-21T00:00:00.000Z', endedAt: null },
    ] as unknown[]);
    const json = await (await callGet()).json();
    expect(json.codexDiagnostics).toBeNull();
    expect(readCodexHomeDiagnosticsMock).not.toHaveBeenCalled();
  });
});

describe('POST /agent-config strict save', () => {
  it('does not persist the retired interactiveClient field from stale clients', async () => {
    const res = await callPost({ ...VALID_BODY, interactiveClient: 'pui' });
    expect(res.status).toBe(200);
    expect(writeMock.mock.calls[0][0]).not.toHaveProperty('interactiveClient');
  });

  it('persists a fully valid body verbatim', async () => {
    const res = await callPost(VALID_BODY);
    expect(res.status).toBe(200);
    expect(writeMock).toHaveBeenCalledTimes(1);
    const written = writeMock.mock.calls[0][0] as typeof VALID_BODY;
    expect(written.tiers).toHaveLength(2);
    expect(written.tierCeilings).toEqual({ bee: 'fast' });
    expect(written.resolverProfiles).toEqual(VALID_BODY.resolverProfiles);
  });

  // WI-10003430: a host with no terminal preference (every fresh hosted
  // workspace) projects terminal:'' on GET; saving that same document back
  // was refused 422 "would silently drop: terminal".
  it('accepts its own GET document back on a host with no terminal preference', async () => {
    readMock.mockResolvedValue({ ...(await readMock()), terminal: '' });
    const got = (await (await callGet()).json()) as { config: Record<string, unknown> };
    expect(got.config.terminal).toBe('');
    const res = await callPost(got.config);
    expect(res.status).toBe(200);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect((writeMock.mock.calls[0][0] as { terminal: string }).terminal).toBe('');
  });

  it('treats a blank terminal like an absent one: keeps the stored preference', async () => {
    readMock.mockResolvedValue({ ...(await readMock()), terminal: 'kitty' });
    for (const blank of ['', '   ', null]) {
      writeMock.mockClear();
      const res = await callPost({ ...VALID_BODY, terminal: blank });
      expect(res.status).toBe(200);
      expect((writeMock.mock.calls[0][0] as { terminal: string }).terminal).toBe('kitty');
    }
  });

  it('still rejects a non-blank terminal the parser would drop', async () => {
    const res = await callPost({ ...VALID_BODY, terminal: '/usr/bin/kitty --hold' });
    expect(res.status).toBe(422);
    expect(writeMock).not.toHaveBeenCalled();
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/terminal/);
  });

  it('rejects (422, no write) a tier row the parser would drop', async () => {
    const res = await callPost({ ...VALID_BODY, tiers: [{ name: 'fast', spec: 'has space' }] });
    expect(res.status).toBe(422);
    expect(writeMock).not.toHaveBeenCalled();
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/tiers/);
  });

  it('rejects a ceiling naming a tier absent from a non-empty menu', async () => {
    const res = await callPost({ ...VALID_BODY, tierCeilings: { bee: 'nonexistent' } });
    expect(res.status).toBe(422);
    expect(writeMock).not.toHaveBeenCalled();
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/tierCeilings/);
  });

  it('rejects an unknown surface key instead of dropping it', async () => {
    const res = await callPost({ ...VALID_BODY, surfaceModels: { nope: 'opus' } });
    expect(res.status).toBe(422);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('rejects an empty per-role model value instead of dropping it', async () => {
    const res = await callPost({ ...VALID_BODY, models: { worker: '' } });
    expect(res.status).toBe(422);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('accepts ceilings naming default tiers while the menu is default ([])', async () => {
    const res = await callPost({ ...VALID_BODY, tiers: [], tierCeilings: { bee: 'deep' } });
    expect(res.status).toBe(200);
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it('preserves resolver defaults when an older full-body client omits the additive field', async () => {
    const { resolverProfiles: _omitted, ...legacyBody } = VALID_BODY;
    const res = await callPost(legacyBody);
    expect(res.status).toBe(200);
    expect((writeMock.mock.calls[0][0] as { resolverProfiles: unknown }).resolverProfiles).toEqual({
      'inbox-resolve': { model: null, effort: null, account: 'default', carry: 'warm' },
      'plan-cleanup': { model: 'opus', effort: 'high', account: 'auto', carry: 'cold' },
    });
  });

  it('rejects invalid resolver settings instead of normalizing them away', async () => {
    const res = await callPost({
      ...VALID_BODY,
      resolverProfiles: { 'inbox-resolve': { model: null, effort: 'high', account: 'default', carry: 'warm' } },
    });
    expect(res.status).toBe(422);
    expect(writeMock).not.toHaveBeenCalled();
    expect((await res.json()).error).toMatch(/resolverProfiles.*effort requires an explicit model/);
  });
});

describe('PATCH /agent-config resolver profiles', () => {
  it('merges one pane profile without replacing unrelated configuration or the other pane', async () => {
    readMock.mockResolvedValueOnce({
      ...VALID_BODY,
      terminal: 'alacritty',
      resolverProfiles: {
        'inbox-resolve': { model: null, effort: null, account: 'default', carry: 'warm' },
        'plan-cleanup': { model: 'opus', effort: 'high', account: 'auto', carry: 'cold' },
      },
    });

    const res = await callPatch({
      resolverProfiles: {
        'inbox-resolve': { model: 'sol', effort: 'xhigh', account: 'pool-a', carry: 'cold' },
      },
    });

    expect(res.status).toBe(200);
    const written = writeMock.mock.calls[0][0] as typeof VALID_BODY & { terminal: string };
    expect(written.models).toEqual(VALID_BODY.models);
    expect(written.terminal).toBe('alacritty');
    expect(written.resolverProfiles).toEqual({
      'inbox-resolve': { model: 'sol', effort: 'xhigh', account: 'pool-a', carry: 'cold' },
      'plan-cleanup': { model: 'opus', effort: 'high', account: 'auto', carry: 'cold' },
    });
  });

  it('rejects an invalid profile and refuses unrelated patch fields', async () => {
    const invalid = await callPatch({
      resolverProfiles: {
        'inbox-resolve': { model: null, effort: 'high', account: 'default', carry: 'warm' },
      },
    });
    expect(invalid.status).toBe(422);
    expect(writeMock).not.toHaveBeenCalled();

    const broad = await callPatch({ resolverProfiles: VALID_BODY.resolverProfiles, backend: 'omp' });
    expect(broad.status).toBe(400);
    expect(writeMock).not.toHaveBeenCalled();
  });
});

/**
 * portal-universal-bar-and-agent-roster-2026-08-31 P-015 — the `portal` surface
 * key (which agent/model answers "Ask Papercup") across all three legs.
 *
 * The point of the item: because POST is strict, an unknown surface key is a
 * 422, so the portal settings surface (P-016) cannot persist this preference
 * through a passthrough — the key has to be a genuine SURFACE_KEYS member. The
 * POST case below is therefore a REGRESSION test in the exact shape of the
 * failure it prevents: it is a 422 if `portal` is ever removed from the
 * registry, not a silently-dropped field.
 */
describe('portal surface key end-to-end through /agent-config', () => {
  it('POST persists a portal backend + model instead of rejecting them 422', async () => {
    const res = await callPost({
      ...VALID_BODY,
      backends: { ...VALID_BODY.backends, portal: 'claude-code' },
      surfaceModels: { ...VALID_BODY.surfaceModels, portal: 'opus:high' },
    });

    expect(res.status).toBe(200);
    expect(writeMock).toHaveBeenCalledTimes(1);
    const written = writeMock.mock.calls[0][0] as {
      backends: Record<string, string>;
      surfaceModels: Record<string, string>;
    };
    // Persisted verbatim — the strict guard counts entries, so a dropped
    // `portal` would have surfaced as a 422 above rather than as a hole here.
    expect(written.backends.portal).toBe('claude-code');
    expect(written.surfaceModels.portal).toBe('opus:high');
    // The pre-existing surfaces are untouched by the widening.
    expect(written.backends.oracle).toBe('claude-code');
    expect(written.surfaceModels.oracle).toBe('opus');
  });

  it('GET returns a stored portal override to the client', async () => {
    readMock.mockResolvedValueOnce({
      ...VALID_BODY,
      backends: { portal: 'codex' },
      surfaceModels: { portal: 'sonnet' },
    });

    const json = (await (await callGet()).json()) as {
      config: { backends: Record<string, string>; surfaceModels: Record<string, string> };
    };
    expect(json.config.backends.portal).toBe('codex');
    expect(json.config.surfaceModels.portal).toBe('sonnet');
  });

  it('PATCH still refuses surface keys — it is the resolverProfiles-only leg', async () => {
    // Widening SURFACE_KEYS must not widen PATCH: its whole reason for existing
    // is that a stale tab holding a full document cannot overwrite unrelated
    // edits, so the portal settings surface saves through POST like every other
    // /settings/agent client.
    const res = await callPatch({
      resolverProfiles: VALID_BODY.resolverProfiles,
      backends: { portal: 'claude-code' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only resolverProfiles.*backends/);
    expect(writeMock).not.toHaveBeenCalled();
  });
});
