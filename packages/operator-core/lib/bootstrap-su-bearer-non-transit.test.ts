/**
 * D-006 regression: the superuser bearer must NOT transit the bootstrap-su
 * HTTP response.
 *
 * bootstrap-su reads `readSuperuserToken()` server-side and bakes the bearer
 * into the per-session CODEX_HOME's `config.toml` http_headers (codex 0.135's
 * bearer_token_env_var doesn't deliver for HTTP MCP). The token is read on the
 * SERVER and handed to `writeSuCodexHome` — it must never appear in the JSON
 * response body NOR in the `envelopeEnv` the launcher exports into the child.
 *
 * The sibling `endpoint-route/__tests__/bootstrap-su.test.ts` asserts only that
 * the token is PASSED to writeSuCodexHome (`token: 'TESTBEARER'`). It does NOT
 * assert the token is ABSENT from the response — so a regression that leaked
 * the bearer into the body or env would pass there. This file closes that gap
 * by scanning the entire serialized response + envelopeEnv for the secret.
 *
 * Hermetic: auth / envelope / session-writer / buildLaunchSpec / writeSuCodexHome
 * / token-read are all mocked; the launch-context write is redirected to a temp
 * dir so the real ~/.papercusp is untouched.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from './endpoint-route/define-route';
import type { Principal } from '@papercusp/agent-mcp';

const nativeMocks = vi.hoisted(() => ({
  principal: undefined as Principal | undefined,
  issue: vi.fn(),
}));
vi.mock('@papercusp/agent-mcp/provisioning', async (orig) => ({
  ...(await orig<typeof import('@papercusp/agent-mcp/provisioning')>()),
  provisionNativeRuntimeBearer: nativeMocks.issue,
}));

// A recognizable, sufficiently-long secret so a substring scan is meaningful.
const SECRET_BEARER = 'SUPERUSER-BEARER-SECRET-do-not-leak-0123456789abcdef';

// Redirect launch-context file writes away from the real ~/.papercusp.
const LC_DIR = mkdtempSync(join(tmpdir(), 'bootstrap-su-bearer-lc-'));
process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = LC_DIR;
const COORD_EXT = join(LC_DIR, 'papercusp-coord.ts');
writeFileSync(COORD_EXT, '// coord ext');

const recordAdvSessionMock = vi.fn(async (_opts: unknown) => 42 as number | null);
const buildLaunchSpecMock = vi.fn(async (_input: any) => ({
  kind: 'su',
  role: 'su',
  runId: 'run-1',
  spawnId: 'spawn-1',
  harnessSlug: _input.harnessSlug ?? null,
  featureId: null,
  cwd: '/ignored-by-bootstrap',
  promptText: 'PLAYBOOK + CTX BODY',
  promptFile: '/prompts/papercusp-su-engineer.tools.md',
  mcpUrl: 'http://localhost:3070/api/mcp?superuser=1&workspace=default',
  mcpJsonContents: '{}',
  stack: _input.stack ?? [],
}));
const compileLaunchSpecificationArtifactMock = vi.fn(async (input: any) => ({
  promptText: input.promptText,
  stack: input.stack ?? [],
  specificationArtifact: {},
  specificationRevision: 'a'.repeat(64),
  stateRevision: input.stateRevision ?? 'b'.repeat(64),
  compositionSource: 'compatibility' as const,
  resourceArtifacts: [],
}));
// writeSuCodexHome RECEIVES the bearer (that's the legitimate server-side
// sink). It returns only file paths — never echoes the token back out.
const writeSuCodexHomeMock = vi.fn((opts: any) => {
  // Sanity within the test: the route really does hand us the secret server-side.
  expect(opts.token).toBe(SECRET_BEARER);
  return {
    codexHome: `/fake/.papercusp/su-codex-homes/session-${opts.sessionKey}`,
    agentsPath: `/fake/.papercusp/su-codex-homes/session-${opts.sessionKey}/AGENTS.md`,
    configPath: `/fake/.papercusp/su-codex-homes/session-${opts.sessionKey}/config.toml`,
  };
});

// Short-circuit auth (the route gates on requirePrincipal first). Mocking it
// here also keeps the real auth chain from importing superuser-token for
// principal resolution — we only want the route's own bearer read exercised.
vi.mock('./auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => nativeMocks.principal),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('./workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace-registry')>()),
  activeWorkspaceId: () => 'default',
  readRegistry: () => ({
    current: 'default',
    workspaces: [{ id: 'default', name: 'Default' }],
  }),
  workspaceById: (id: string) => (['default'].includes(id) ? { id, name: id } : undefined),
}));
vi.mock('./console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async (o: { slug: string | null }) => ({
    cwd: o.slug ? `/proj/${o.slug}` : '/workspace',
    env: { PAPERCUSP_OPERATOR_URL: 'http://localhost:3070', ...(o.slug ? { PAPERCUSP_HARNESS_SLUG: o.slug } : {}) },
    mcpJsonContents: '',
    greetingCmd: '',
    needsSuperuserBootstrap: false,
    mode: 'shell',
  })),
}));
// Must enumerate EVERY export bootstrap-su.ts imports from adv-sessions: a factory
// mock replaces the whole module, so an export the subject imports but this omits
// throws "No <name> export is defined on the mock" the moment that code path runs —
// silently at author time, loudly in the gate hours later (WI-7185).
vi.mock('./adv-sessions', async (orig) => ({ ...(await orig<typeof import('./adv-sessions')>()), endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  recordAdvSession: recordAdvSessionMock,
  // bootstrap-su's inbox-wake arm resolves the caller's freshest adv session via
  // this; missing it made the arm's non-fatal error log trip fail-on-console.
  latestAdvSessionByCoordOwner: vi.fn(async () => null),
  markAdvSessionEnded: vi.fn(async () => {}),
  claimAdvSessionResume: vi.fn(async () => false),
  reanchorAdvSessionNativeId: vi.fn(async () => ({ reanchored: true, owner: null })),
  reanchorAdvSessionNativeIdByOwner: vi.fn(async () => ({ reanchored: true, owner: null })),
  recordSuLaunchSpec: vi.fn(async () => true),
}));
vi.mock('./role-launch-spec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./role-launch-spec')>()),
  buildLaunchSpec: (...args: unknown[]) => buildLaunchSpecMock(...(args as [any])),
  compileLaunchSpecificationArtifact: (...args: unknown[]) =>
    compileLaunchSpecificationArtifactMock(...(args as [any])),
}));
vi.mock('./modes/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./modes/store')>()),
  reconcileImpliedModes: vi.fn(async () => []),
  getModes: vi.fn(async () => []),
}));
// Match the main bootstrap-su suite: context-budget reads and boot stamps are
// registry leaves, independent of the bearer transport contract tested here.
vi.mock('./agent-tools/coordination/presence', () => ({
  getPresence: vi.fn(async () => null),
  writePresence: vi.fn(async () => null),
  touchHeartbeat: vi.fn(async () => {}),
}));
vi.mock('./task-manager/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./task-manager/store')>()),
  bindLiveAgentSessionTasksToNativeSession: vi.fn(async () => []),
}));
// The route consumes only the private writer here. Loading the real home
// module also boots unrelated identity/presence imports before this fixture
// can assert non-transit, and can escape its mocked database boundary.
vi.mock('./role-codex-home', () => ({
  writeSuCodexHome: (...args: unknown[]) => writeSuCodexHomeMock(...(args as [any])),
  writeSuCodexHomeAsync: async (...args: unknown[]) => writeSuCodexHomeMock(...(args as [any])),
}));
// bootstrap-su fails CLOSED on the identity-activation receipt (returns 500 when it
// cannot persist). The real module opens the org-admin pool, which the unit-test PG
// guard refuses — so without this seam double every case here 500s before its own
// assertion. Same double the sibling endpoint-route/__tests__/bootstrap-su.test.ts uses.
vi.mock('./agent-tools/coordination/control-anchor', () => ({
  requestSessionIdentityActivation: vi.fn(async () => ({ generation: 1 })),
}));
vi.mock('./saved-prompts-materialize', () => ({
  materializeWorkspacePrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeHarnessPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeCodexPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
}));
vi.mock('./desktop-install/papercusp-files', () => ({
  resolveInstallPaths: () => ({ extensionPath: COORD_EXT }),
}));
// The crux: the route reads the bearer from HERE, server-side. Keep the
// rest of the module real (isLoopbackRequest etc. are imported elsewhere in
// the auth chain) — only override the token reader.
vi.mock('./superuser-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./superuser-token')>();
  return { ...actual, readSuperuserToken: () => SECRET_BEARER };
});
vi.mock('./device-harnesses', () => ({
  listHarnessesFor: vi.fn(async () => []),
}));
// default-deploy-account-2026-08-08 P-004: resolveAccountPin now reads the owner's default
// account for an unspecified `account`. Unmocked that reaches Postgres, and this route FAILS
// CLOSED on an unreadable default — so the POST would return an error envelope (no codexHome)
// instead of a launch, which reads as a route bug rather than a missing stub.
// `undefined` = "no default set", the pre-feature behaviour these tests assert.
// Partial mock on purpose: an object factory here would strand again the next time this module
// gains an export (EI-19462958615807409).
vi.mock('./deployment/account-pool-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deployment/account-pool-store')>()),
  readDefaultAccountId: vi.fn(async () => undefined),
}));
vi.mock('./agent-tools/plans/source', () => ({
  resolveHarnessPlansDir: vi.fn(async () => ({ harnessSlug: 'papercup', plans: '/repo/plans', archive: '/repo/plans/archive' })),
  listPlanFiles: vi.fn(async () => []),
  readPlanBySlug: vi.fn(async () => null),
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

type Route = { method: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };

async function callPost(body: unknown): Promise<Response> {
  const mod = await import('./endpoint-route/routes/agent-mcp/bootstrap-su');
  const post = (mod.default as Route[]).find((r) => r.method === 'POST')!;
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await post.handler(req, CTX);
  if (res.status !== 200) throw new Error(`bootstrap-su returned ${res.status}: ${await res.clone().text()}`);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  nativeMocks.principal = undefined;
  nativeMocks.issue.mockReset();
  recordAdvSessionMock.mockResolvedValue(42);
});

describe('bootstrap-su bearer non-transit (D-006)', () => {
  it('delivers only the canonical runtime credential from the actual verified launch principal to the private writer', async () => {
    const principal: Principal = { workspaceId: 'default', slug: 'launch-user', kind: 'user', trust: 'verified',
      authMethod: 'cookie-session', capabilities: new Set(['*']) };
    nativeMocks.principal = principal;
    nativeMocks.issue.mockImplementation(async () => ({ bearer: 'n'.repeat(43), binding: {
      workspaceId: 'default', advSessionId: 42,
      ownerId: (recordAdvSessionMock.mock.calls.at(-1)![0] as { coordOwnerId: string }).coordOwnerId, provider: 'codex',
    } }));
    const res = await callPost({ agent: 'codex', harness_slug: null, plan_slug: null,
      nativeRuntimeBearer: 'forged', authenticatedPrincipal: { slug: 'forged' } });
    expect(nativeMocks.issue).toHaveBeenCalledWith({ workspaceId: 'default', advSessionId: 42, issuer: principal });
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(expect.objectContaining({ nativeRuntimeBearer: 'n'.repeat(43) }));
    const serialized = await res.text();
    expect(serialized).not.toContain('n'.repeat(43));
    expect(serialized).not.toContain(SECRET_BEARER);
  });

  it.each(['unverified', 'limited', 'foreign', 'unavailable', 'retargeted', 'runtime', 'workspace'])('keeps %s launches unenrolled without borrowing shared authority', async (control) => {
    nativeMocks.principal = { workspaceId: control === 'foreign' ? 'other' : 'default', slug: 'launch-user', kind: 'user',
      trust: control === 'unverified' ? 'unverified-loopback' : 'verified', authMethod: 'cookie-session',
      capabilities: new Set(control === 'limited' ? ['harness:read'] : ['*']) };
    if (control === 'unavailable') nativeMocks.issue.mockRejectedValue(new Error('issuer unavailable'));
    else nativeMocks.issue.mockImplementation(async () => ({ bearer: 'n'.repeat(43), binding: {
      workspaceId: control === 'workspace' ? 'other' : 'default', advSessionId: control === 'runtime' ? 99 : 42,
      ownerId: control === 'retargeted' ? 'su-sibling'
        : (recordAdvSessionMock.mock.calls.at(-1)![0] as { coordOwnerId: string }).coordOwnerId, provider: 'codex',
    } }));
    const res = await callPost({ agent: 'codex', harness_slug: null, plan_slug: null });
    if (['unverified', 'limited', 'foreign'].includes(control)) expect(nativeMocks.issue).not.toHaveBeenCalled();
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(expect.objectContaining({ nativeRuntimeBearer: undefined }));
    expect(await res.text()).not.toContain('n'.repeat(43));
  });

  it('codex: the bearer is read server-side but is ABSENT from the response body', async () => {
    const res = await callPost({ agent: 'codex', harness_slug: null, plan_slug: null });
    expect(res.status).toBe(200);
    const rawBody = await res.text();
    const json = JSON.parse(rawBody);

    // It genuinely went to the codex-home writer (the legitimate sink).
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: SECRET_BEARER, isOwnerLive: expect.any(Function) }),
    );
    expect(json.codexHome).toMatch(/su-codex-homes\/session-42$/);

    // ...but it must NOT be anywhere in the serialized HTTP response.
    expect(rawBody).not.toContain(SECRET_BEARER);
  });

  it('codex: the bearer is ABSENT from envelopeEnv (no child-process leak)', async () => {
    const res = await callPost({ agent: 'codex', harness_slug: null, plan_slug: null });
    const json = await res.json();

    expect(json.envelopeEnv).toBeTruthy();
    // CODEX_HOME is surfaced (the launcher needs it); the bearer never is.
    expect(json.envelopeEnv.CODEX_HOME).toBe(json.codexHome);
    const serializedEnv = JSON.stringify(json.envelopeEnv);
    expect(serializedEnv).not.toContain(SECRET_BEARER);
    // Belt-and-suspenders: no env VALUE equals the secret.
    for (const v of Object.values(json.envelopeEnv as Record<string, string>)) {
      expect(v).not.toBe(SECRET_BEARER);
    }
  });

  it('claude: never reads the bearer at all (no codex home → no token sink)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: null, plan_slug: null });
    const rawBody = await res.text();
    const json = JSON.parse(rawBody);

    // claude/omp relies on user-level MCP; no per-session codex home is written.
    expect(writeSuCodexHomeMock).not.toHaveBeenCalled();
    expect(json.codexHome).toBeNull();
    // And of course the secret is nowhere in the response or env.
    expect(rawBody).not.toContain(SECRET_BEARER);
    expect(JSON.stringify(json.envelopeEnv)).not.toContain(SECRET_BEARER);
  });

  it('omp: never reads the bearer either (user-level MCP, no codex home)', async () => {
    const res = await callPost({ agent: 'omp', harness_slug: null, plan_slug: null });
    const rawBody = await res.text();
    const json = JSON.parse(rawBody);

    expect(writeSuCodexHomeMock).not.toHaveBeenCalled();
    expect(json.codexHome).toBeNull();
    expect(rawBody).not.toContain(SECRET_BEARER);
    expect(JSON.stringify(json.envelopeEnv)).not.toContain(SECRET_BEARER);
  });
});
