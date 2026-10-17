/**
 * Cross-CLI resume-correlation ROUND-TRIP: the claude `--session-id` contract
 * spans three stages that are each unit-tested in isolation but never JOINED:
 *
 *   1. bootstrap-su  — mints `nativeSessionId` (a UUID for claude), records it
 *                       on the adv_sessions row, and returns it.
 *   2. suLaunchArgs   — forces `claude --session-id <that uuid>` on fresh launch
 *                       so the OS process IS that session.
 *   3. resumeArgsFor  — later resumes `claude --resume <that uuid>` so
 *                       `psu --resume <uuid>` correlates back to the same row.
 *
 * The identity that matters is `minted === recorded === forced === resumed`
 * (claude), and that omp/codex stay `null` at every stage (they don't take a
 * forced id). Each half has a unit test; this file proves the WHOLE chain with
 * ONE minted uuid threaded through the REAL helpers (no re-implementation).
 *
 * Hermetic: bootstrap-su's heavy leaves are mocked exactly as the sibling
 * bootstrap-su test mocks them; suLaunchArgs/resumeArgsFor are imported live
 * from the actual psu-launcher.mjs.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from './endpoint-route/define-route';
// The REAL launcher helpers (the forcing + resuming halves of the contract).
import { suLaunchArgs, resumeArgsFor, resolveTrackedResumeSession } from '../../../apps/operator/scripts/psu-launcher.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LC_DIR = mkdtempSync(join(tmpdir(), 'native-sid-rt-lc-'));
process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = LC_DIR;
const COORD_EXT = join(LC_DIR, 'papercusp-coord.ts');
writeFileSync(COORD_EXT, '// coord ext');

// Capture what bootstrap-su RECORDS on the adv row (the `sessionId` field =
// the native session id) so we can assert recorded === minted === forced.
let recordedSessionId: string | null | undefined;
const recordAdvSessionMock = vi.fn(async (opts: any) => {
  recordedSessionId = opts.sessionId;
  return 42 as number | null;
});
const buildLaunchSpecMock = vi.fn(async (_input: any) => ({
  kind: 'su',
  role: 'su',
  runId: 'run-1',
  spawnId: 'spawn-1',
  harnessSlug: _input.harnessSlug ?? null,
  featureId: null,
  cwd: '/ignored',
  promptText: 'PLAYBOOK + CTX BODY',
  promptFile: '/prompts/papercusp-su-engineer.tools.md',
  mcpUrl: 'http://localhost:3070/api/mcp?superuser=1',
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
const writeSuCodexHomeMock = vi.fn((opts: any) => ({
  codexHome: `/fake/su-codex-homes/session-${opts.sessionKey}`,
  agentsPath: `/fake/su-codex-homes/session-${opts.sessionKey}/AGENTS.md`,
  configPath: `/fake/su-codex-homes/session-${opts.sessionKey}/config.toml`,
}));

vi.mock('./auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('./workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace-registry')>()),
  activeWorkspaceId: () => 'default',
  readRegistry: () => ({ current: 'default', workspaces: [{ id: 'default', name: 'Default' }] }),
  workspaceById: (id: string) => (id === 'default' ? { id, name: id } : undefined),
}));
vi.mock('./console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async (o: { slug: string | null }) => ({
    cwd: o.slug ? `/proj/${o.slug}` : '/workspace',
    env: { PAPERCUSP_OPERATOR_URL: 'http://localhost:3070' },
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
// Codex bootstrap reads the current context budget before materializing its home.
// Keep that registry read hermetic, as in the main bootstrap-su route suite.
vi.mock('./agent-tools/coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/coordination/presence')>()),
  getPresence: vi.fn(async () => null),
  writePresence: vi.fn(async () => null),
}));
vi.mock('./task-manager/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./task-manager/store')>()),
  bindLiveAgentSessionTasksToNativeSession: vi.fn(async () => []),
}));
vi.mock('./role-codex-home', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./role-codex-home')>()),
  writeSuCodexHome: (...args: unknown[]) => writeSuCodexHomeMock(...(args as [any])),
  writeSuCodexHomeAsync: async (...args: unknown[]) => writeSuCodexHomeMock(...(args as [any])),
}));
vi.mock('./saved-prompts-materialize', () => ({
  materializeWorkspacePrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeHarnessPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeCodexPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
}));
vi.mock('./desktop-install/papercusp-files', () => ({
  resolveInstallPaths: () => ({ extensionPath: COORD_EXT }),
}));
vi.mock('./superuser-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./superuser-token')>();
  return { ...actual, readSuperuserToken: () => 'TESTBEARER' };
});
vi.mock('./device-harnesses', () => ({ listHarnessesFor: vi.fn(async () => []) }));
// bootstrap-su fails CLOSED on the identity-activation receipt (returns 500 when it
// cannot persist). The real module opens the org-admin pool, which the unit-test PG
// guard refuses — so without this seam double the route 500s and every id assertion
// here reads `undefined`. Same double the sibling endpoint-route/__tests__/bootstrap-su.test.ts uses.
vi.mock('./agent-tools/coordination/control-anchor', () => ({
  requestSessionIdentityActivation: vi.fn(async () => ({ generation: 1 })),
}));
// default-deploy-account-2026-08-08 P-004: resolveAccountPin now reads the owner's default
// account for an unspecified `account`. Unmocked that reaches Postgres, and this route FAILS
// CLOSED on an unreadable default — so the POST would return an error envelope (no codexHome,
// no sessionId) instead of a launch, which reads as a route bug rather than a missing stub.
// `undefined` = "no default set", the pre-feature behaviour these tests assert.
// Partial mock on purpose: an object factory here would strand again the next time this module
// gains an export (EI-19462958615807409).
vi.mock('./deployment/account-pool-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deployment/account-pool-store')>()),
  readDefaultAccountId: vi.fn(async () => undefined),
}));
vi.mock('./agent-tools/plans/source', () => ({
  resolveHarnessPlansDir: vi.fn(async () => ({ harnessSlug: 'papercup', plans: '/p', archive: '/p/a' })),
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

async function bootstrap(agent: string): Promise<any> {
  const mod = await import('./endpoint-route/routes/agent-mcp/bootstrap-su');
  const post = (mod.default as Route[]).find((r) => r.method === 'POST')!;
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent, harness_slug: null, plan_slug: null, cwd: '/home/me/work' }),
  });
  const res = await post.handler(req, CTX);
  if (res.status !== 200) throw new Error(`bootstrap-su returned ${res.status}: ${await res.clone().text()}`);
  return res.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  recordedSessionId = undefined;
  recordAdvSessionMock.mockImplementation(async (opts: any) => {
    recordedSessionId = opts.sessionId;
    return 42;
  });
});

describe('native session id round-trip (bootstrap-su → suLaunchArgs → resumeArgsFor)', () => {
  it('claude: one minted uuid is recorded, forced on launch, and resumed by id — all equal', async () => {
    const json = await bootstrap('claude');

    // Stage 1: minted + returned + recorded on the adv row (all the same uuid).
    const minted: string = json.nativeSessionId;
    expect(minted).toMatch(UUID_RE);
    expect(recordedSessionId).toBe(minted);

    // Stage 2: the launcher forces EXACTLY that uuid on the fresh claude launch.
    const launch = suLaunchArgs('claude', { promptFile: json.promptFile, nativeSessionId: minted });
    expect(launch.bin).toBe('claude');
    const sidIdx = launch.args.indexOf('--session-id');
    expect(sidIdx).toBeGreaterThanOrEqual(0);
    expect(launch.args[sidIdx + 1]).toBe(minted);

    // Stage 3: a later resume targets the SAME uuid (the correlation handle).
    const resume = resumeArgsFor({ agent: 'claude', sessionId: minted, cwd: json.cwd });
    expect(resume.bin).toBe('claude');
    const rIdx = resume.args.indexOf('--resume');
    expect(rIdx).toBeGreaterThanOrEqual(0);
    expect(resume.args[rIdx + 1]).toBe(minted);

    // The whole identity holds: minted === recorded === forced === resumed.
    expect(launch.args[sidIdx + 1]).toBe(resume.args[rIdx + 1]);
    expect(resume.args[rIdx + 1]).toBe(minted);
  });

  it('omp: native id is null end-to-end — never minted, never forced, resume falls back to -c', async () => {
    const json = await bootstrap('omp');

    expect(json.nativeSessionId).toBeNull();
    expect(recordedSessionId).toBeNull();

    // No --session-id is forced on the omp launch (it has no such flag).
    const launch = suLaunchArgs('omp', { promptFile: json.promptFile });
    expect(launch.args).not.toContain('--session-id');

    // Resume with a null native id → omp continues most-recent-in-cwd (-c), not by id.
    const resume = resumeArgsFor({ agent: 'omp', ompThreadId: null, cwd: json.cwd });
    expect(resume.args).toContain('-c');
    expect(resume.args).not.toContain('--session-id');
  });

  it('omp: a post-launch linked thread id resolves a tracked direct resume', () => {
    const tracked = {
      id: 42,
      agent: 'omp',
      cwd: '/home/me/work',
      sessionId: null,
      ompThreadId: '019ee911-f1d4-7031-859b-27c3527acbc0',
    };

    const resolved = resolveTrackedResumeSession([tracked], tracked.ompThreadId);
    expect(resolved).toBe(tracked);

    const resume = resumeArgsFor(resolved);
    expect(resume.bin).toBe('omp');
    expect(resume.args).toContain('-r');
    expect(resume.args[resume.args.indexOf('-r') + 1]).toBe(tracked.ompThreadId);
  });

  it('codex: native id is null end-to-end — never minted, never forced (resume via CODEX_HOME)', async () => {
    const json = await bootstrap('codex');

    expect(json.nativeSessionId).toBeNull();
    expect(recordedSessionId).toBeNull();
    expect(json.codexHome).toBe('/fake/su-codex-homes/session-42');
    expect(json.envelopeEnv.CODEX_HOME).toBe(json.codexHome);
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ isOwnerLive: expect.any(Function) }),
    );

    expect(json.envelopeEnv.PAPERCUSP_MODEL_SOURCE).toBe('configured-default');
    const launch = suLaunchArgs('codex', {
      promptFile: json.promptFile,
      model: 'gpt-5.6-sol:xhigh',
    });
    expect(launch.args).not.toContain('--session-id');

    // codex resume with no native id → `resume --last` from its per-session home.
    const resume = resumeArgsFor(
      { agent: 'codex', cwd: json.cwd },
      { model: 'gpt-5.6-sol:xhigh' } as unknown as Parameters<typeof resumeArgsFor>[1],
    );
    expect(resume.args).toContain('resume');
    expect(resume.args).toContain('--last');
  });

  it('codex: a rollout uuid under the tracked CODEX_HOME resolves a tracked direct resume', () => {
    const home = mkdtempSync(join(tmpdir(), 'native-sid-rt-codex-home-'));
    const rolloutId = '019ee911-f1d4-7031-859b-27c3527acbc0';
    const sessionsDir = join(home, '.papercusp', 'su-codex-homes', 'session-42', 'sessions', '2026', '06', '21');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `rollout-2026-06-21T00-00-00-${rolloutId}.jsonl`), '{"cwd":"/home/me/work"}\n');

    const tracked = { id: 42, agent: 'codex', cwd: '/home/me/work', sessionId: null };
    const resolved = resolveTrackedResumeSession([tracked], rolloutId, { home });
    expect(resolved).toMatchObject({ ...tracked, sessionId: rolloutId });

    const resume = resumeArgsFor(
      resolved,
      { model: 'gpt-5.6-sol:xhigh' } as unknown as Parameters<typeof resumeArgsFor>[1],
    );
    expect(resume.bin).toBe('codex');
    expect(resume.args).toContain('resume');
    expect(resume.args[resume.args.indexOf('resume') + 1]).toBe(rolloutId);
    expect(resume.args).not.toContain('--last');
  });

  it('claude: forcing the bootstrapped uuid is what makes resume-by-uuid match (would-be false-negative guard)', async () => {
    // Two independent claude bootstraps mint DISTINCT uuids — proving the id is
    // per-session, so resuming one never collides with the other.
    const a = await bootstrap('claude');
    const b = await bootstrap('claude');
    expect(a.nativeSessionId).not.toBe(b.nativeSessionId);

    const launchA = suLaunchArgs('claude', { promptFile: a.promptFile, nativeSessionId: a.nativeSessionId });
    const resumeA = resumeArgsFor({ agent: 'claude', sessionId: a.nativeSessionId });
    // A's forced id resumes A, and is NOT B's id.
    expect(launchA.args[launchA.args.indexOf('--session-id') + 1]).toBe(
      resumeA.args[resumeA.args.indexOf('--resume') + 1],
    );
    expect(resumeA.args).not.toContain(b.nativeSessionId);
  });
});
