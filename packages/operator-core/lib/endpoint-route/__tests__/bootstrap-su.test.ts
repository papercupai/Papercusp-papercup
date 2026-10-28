/**
 * Unit tests for POST /api/agent-mcp/console/bootstrap-su.
 *
 * Drives the route handler directly with a hand-built RouteContext and
 * mocks the heavy leaves (auth, envelope, session writer, buildLaunchSpec,
 * writeSuCodexHome). Asserts the P-020 raw-CLI result shape: a promptFile
 * (claude/omp) or codexHome (codex) + a per-session PAPERCUSP_SID (P-022),
 * NOT a `*-su` wrapper.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFleetRecord } from '../../agent-fleets-store';
import type { RouteContext } from '../define-route';
import { renderSessionPortSeed } from '../../session-port/render';
import { SESSION_PORT_PROTOCOL_VERSION, SESSION_PORT_TRANSFORM_VERSION } from '../../session-port/types';

// This suite invokes route handlers directly; keep route-shaped definitions but
// skip @papercusp/agent-mcp's package-entry bootstrap of the full tool catalog.
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (definition: any) => definition,
}));

const nativeFork = vi.hoisted(() => ({ complete: vi.fn(), resolveSource: vi.fn() }));
vi.mock('../../su-session-tracked-codex-fork', () => ({
  completeTrackedCodexFork: nativeFork.complete,
  resolveTrackedCodexForkSource: nativeFork.resolveSource,
}));

// Redirect the launch-context file writes to a throwaway temp dir so the
// route's best-effort persistence doesn't touch the real ~/.papercusp.
const LC_DIR = mkdtempSync(join(tmpdir(), 'bootstrap-su-lc-'));
process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = LC_DIR;
const TEST_CODEX_AUTH_HOME = mkdtempSync(join(tmpdir(), 'bootstrap-su-home-'));
mkdirSync(join(TEST_CODEX_AUTH_HOME, '.codex'), { recursive: true });
writeFileSync(join(TEST_CODEX_AUTH_HOME, '.codex', 'auth.json'), JSON.stringify({
  tokens: { access_token: 'test-access-token', refresh_token: 'test-refresh-token' },
}));
afterAll(() => rmSync(TEST_CODEX_AUTH_HOME, { recursive: true, force: true }));
// A real coord-extension file so coordExtPath resolves deterministically.
const COORD_EXT = join(LC_DIR, 'papercusp-coord.ts');
writeFileSync(COORD_EXT, '// coord ext');
const SESSION_PORT_ARTIFACT = renderSessionPortSeed({
  portId: '22222222-2222-4222-8222-222222222222',
  sourceBackend: 'claude',
  targetBackend: 'codex',
  fidelity: 'full',
  transcript: 'ported history',
});
const SESSION_PORT_ID = '22222222-2222-4222-8222-222222222222';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const sessionPortRow = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_PORT_ID,
  workspaceId: 'default',
  idempotencyKey: 'logical-request-hash',
  retryOfPortId: null,
  protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
  status: 'prepared',
  sourceAdvSessionId: 9,
  targetAdvSessionId: null,
  sourceBackend: 'claude',
  targetBackend: 'codex',
  targetModel: 'gpt-5.5',
  tokenHash: 'token-hash',
  artifactPath: '/managed/222.seed.md',
  expiresAt: '2099-01-01T00:00:00.000Z',
  sourceHash: 'source-hash',
  normalizedHash: 'normalized-hash',
  renderedHash: SESSION_PORT_ARTIFACT.hash,
  preparedAt: '2026-07-14T00:00:00.000Z',
  pendingAt: null,
  deliveredAt: null,
  failedAt: null,
  error: null,
  metadata: {
    sourceCoordOwnerId: 'su-source-owner',
    estimatedTokens: 10,
    summary: {
      protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
      source: {
        backend: 'claude',
        workspaceId: 'default',
        advSessionId: 9,
        nativeSessionId: 'source-native',
        cwd: '/workspace',
        harnessSlug: null,
        planSlug: null,
        snapshot: {
          kind: 'live-jsonl',
          highWaterBytes: 1,
          completeBytes: 1,
          sha256: 'source-hash',
          archiveRelpath: null,
        },
      },
      target: {
        backend: 'codex',
        provider: 'openai',
        model: 'gpt-5.5',
        account: 'default',
        contextWindow: 200_000,
        availableInputTokens: 100_000,
        contextSize: 'trimmed',
        launchContextHash: EMPTY_SHA256,
      },
      fidelity: 'full',
      versions: { transform: SESSION_PORT_TRANSFORM_VERSION, summaryPrompt: null },
      stats: { omittedAttachments: 0, unsupportedBlocks: 0, redactions: 0 },
      summary: null,
    },
  },
  ...overrides,
});

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
const sessionAllowsAmbientContextMock = vi.fn(async (_input: unknown) => true);
vi.mock('../../capability-envelope/session-confinement-port', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capability-envelope/session-confinement-port')>()),
  sessionAllowsAmbientContext: (input: unknown) => sessionAllowsAmbientContextMock(input),
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
const provisionLaunchIdentityResourcesMock = vi.fn(async (_input: unknown) => {});
const resolveLaunchIdentityModelDefaultMock = vi.fn(async (_input: unknown): Promise<string | null> => null);
const writeSuCodexHomeMock = vi.fn((opts: any) => ({
  codexHome: `/fake/.papercusp/su-codex-homes/session-${opts.sessionKey}`,
  sqliteHome: `/fake/codex-sqlite-homes/session-${opts.sessionKey}`,
  agentsPath: `/fake/.papercusp/su-codex-homes/session-${opts.sessionKey}/AGENTS.md`,
  configPath: `/fake/.papercusp/su-codex-homes/session-${opts.sessionKey}/config.toml`,
}));
const assertSuCodexHomeNotOwnedByLiveSessionMock = vi.fn(
  async (_sessionKey: string | number, _sid: string, _isOwnerLive: (sid: string) => Promise<boolean>) => {},
);
const rekeyCodexHomeMock = vi.fn((_source: string | number, target: string | number) =>
  `/fake/.papercusp/su-codex-homes/session-${target}`,
);
// EI-155: the interactive-claude config-dir materializer. Mocked so the unit
// test never touches the dev box's real ~/.claude (the materializer's own
// symlink-farm behavior is covered by interactive-claude-config.test.ts).
const writeInteractiveClaudeConfigMock = vi.fn((opts: { sid: string }) => ({
  configDir: `/fake/.papercusp/session-claude/${opts.sid}`,
}));
const claimAgentLaunchMock = vi.fn(
  async (_opts: unknown): Promise<{
    won: boolean;
    priorSummary: Record<string, unknown> | null;
    priorLaunchedAt: number | null;
    priorLaunchedBy: string | null;
  }> => ({
    won: true,
    priorSummary: null,
    priorLaunchedAt: null,
    priorLaunchedBy: null,
  }),
);
const recordAgentLaunchResultMock = vi.fn(async (_opts: unknown) => undefined);
const releaseAgentLaunchClaimMock = vi.fn(async (_opts: unknown) => true);
const getSessionPortMock = vi.fn(async (_id: string, _workspaceId: string) => null as any);
const reserveSessionPortTargetMock = vi.fn(async (input: any) => ({
  status: 'reserved' as const,
  targetAdvSessionId: 42,
  port: sessionPortRow({
    id: input.portId,
    workspaceId: input.workspaceId,
    status: 'pending',
    targetAdvSessionId: 42,
  }),
}));
/** The fields this handler path actually reads off a bootstrap disposition. Declared
 * explicitly so a fixture below is checked against it instead of being cast past the
 * type system — the real `SessionPortBootstrapDisposition` additionally carries `port`,
 * which this route never reads, so the double deliberately narrows rather than inventing
 * a fake row. */
type BootstrapDispositionDouble =
  | { status: 'in_progress'; targetAdvSessionId: number }
  | { status: 'replay'; targetAdvSessionId: number; receipt: Record<string, unknown> };
const readSessionPortBootstrapDispositionMock = vi.fn(
  async (_input: unknown): Promise<BootstrapDispositionDouble> => ({
    status: 'in_progress',
    targetAdvSessionId: 42,
  }),
);
const recordSessionPortBootstrapReceiptMock = vi.fn(async (_input: unknown) => undefined);
const failSessionPortTargetReservationMock = vi.fn(async (_input: unknown) => true);
const readSessionPortArtifactMock = vi.fn(async (_port: unknown) => SESSION_PORT_ARTIFACT.seed);
const recordSessionPortTelemetryMock = vi.fn(async (_event: unknown) => true);
const bindAgentTasksMock = vi.hoisted(() => vi.fn(async (_input: unknown) => [] as string[]));

vi.mock('../../task-manager/store', () => ({
  bindLiveAgentSessionTasksToNativeSession: (...args: unknown[]) => bindAgentTasksMock(...args),
}));

vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'default',
  readRegistry: () => ({
    current: 'default',
    workspaces: [
      { id: 'default', name: 'Default' },
      { id: 'ws2', name: 'Second' },
    ],
  }),
  // Sparse-registry reality (fresh packaged install): the literal 'default' fallback is
  // NOT listed as a concrete entry, so workspaceById('default') is undefined — but
  // isKnownWorkspace treats 'default' as always-valid (its sentinel branch). The
  // bootstrap routes MUST validate with isKnownWorkspace, not workspaceById, or they
  // 400 `unknown workspace: default` on the exact value activeWorkspaceId() produces
  // (WI-3234).
  workspaceById: (id: string) => (id === 'ws2' ? { id, name: id } : undefined),
  isKnownWorkspace: (id: string) => !!id?.trim() && (id === 'default' || id === 'ws2'),
}));
vi.mock('../../console-launcher', () => ({
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
// EI-21365235532676472: named handle so the reclaim assertions below can inspect
// exactly how stranded bindings were stamped.
const markAdvSessionEndedMock = vi.fn(
  async (
    _id: number,
    _exitCode: number | null,
    _endedBy: string,
    _opts?: { signal?: string | null; throwOnError?: boolean },
  ) => {},
);
vi.mock('../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../adv-sessions')>()), endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  recordAdvSession: recordAdvSessionMock,
  markAdvSessionEnded: (...a: unknown[]) =>
    markAdvSessionEndedMock(
      ...(a as [number, number | null, string, { signal?: string | null; throwOnError?: boolean }?]),
    ),
  claimAdvSessionResume: vi.fn(async () => false),
  reanchorAdvSessionNativeId: vi.fn(async () => ({ reanchored: true, owner: null })),
  reanchorAdvSessionNativeIdByOwner: vi.fn(async () => ({ reanchored: true, owner: null })),
  recordSuLaunchSpec: vi.fn(async () => true),
}));
vi.mock('../../agent-tools/coordination/control-anchor', () => ({
  requestSessionIdentityActivation: vi.fn(async () => ({ generation: 1 })),
  refreshControlAnchorAfterMutation: vi.fn(async () => ({ generation: 2 })),
}));
vi.mock('../../session-port/store', () => ({
  assertSessionPortStorageReady: vi.fn(async () => undefined),
  getSessionPort: (...a: unknown[]) => getSessionPortMock(...(a as [any, any])),
  sessionPortBootstrapLedgerKey: (portId: string) => `bootstrap-su:session-port:${portId}`,
  reserveSessionPortTarget: (...a: unknown[]) => reserveSessionPortTargetMock(...(a as [any])),
  readSessionPortBootstrapDisposition: (...a: unknown[]) => readSessionPortBootstrapDispositionMock(...(a as [any])),
  recordSessionPortBootstrapReceipt: (...a: unknown[]) => recordSessionPortBootstrapReceiptMock(...(a as [any])),
  failSessionPortTargetReservation: (...a: unknown[]) => failSessionPortTargetReservationMock(...(a as [any])),
}));
vi.mock('../../session-port/telemetry', () => ({
  recordSessionPortTelemetry: (...a: unknown[]) => recordSessionPortTelemetryMock(...(a as [any])),
}));
vi.mock('../../session-port/artifact', () => ({
  parsePortToken: (token: string) =>
    token.startsWith('22222222-2222-4222-8222-222222222222.')
      ? { portId: '22222222-2222-4222-8222-222222222222', secret: token.split('.')[1] }
      : null,
  readSessionPortArtifact: (...a: unknown[]) => readSessionPortArtifactMock(...(a as [any])),
  verifyPortToken: () => true,
}));
// launch-wakeability: the route arms the standing inbox-wake at launch (right after
// recordAdvSession) so the session is parked/wakeable before its first turn. Mock it
// to keep the unit test hermetic (the real one pulls the await engine + PG) and to
// assert it's armed for the minted sid.
const armInboxWakeMock = vi.fn(async (_opts: unknown) => ({ awaitId: 1, eventKey: 'coord:inbox-wake:x', handleNote: 'n' }));
vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: (...a: unknown[]) => armInboxWakeMock(...(a as [any])),
}));
// WI-20241317226471456: bootstrap-su's launch-time implication repair is a
// best-effort integration side effect. Keep this unit suite hermetic by
// replacing the PG-backed reconciler with a deterministic no-op.
const reconcileImpliedModesMock = vi.fn(async () => [] as Array<{ status: string }>);
const getModesMock = vi.fn(async () => [] as Array<{ mode: string; subject: string | null; impliedBy: { mode: string; subject: string | null } | null }>);
const setModeMock = vi.fn(async (_opts: unknown) => ({ ok: true, noop: false }));
vi.mock('../../modes/store', () => ({
  reconcileImpliedModes: (...a: unknown[]) => reconcileImpliedModesMock(...(a as [])),
  getModes: (...a: unknown[]) => getModesMock(...(a as [])),
  setMode: (...a: unknown[]) => setModeMock(...(a as [unknown])),
}));
vi.mock('../../role-launch-spec', () => ({
  buildLaunchSpec: (...args: unknown[]) => buildLaunchSpecMock(...(args as [any])),
  compileLaunchSpecificationArtifact: (...args: unknown[]) =>
    compileLaunchSpecificationArtifactMock(...(args as [any])),
  provisionLaunchIdentityResources: (...args: unknown[]) =>
    provisionLaunchIdentityResourcesMock(...(args as [any])),
  resolveLaunchIdentityModelDefault: (...args: unknown[]) =>
    resolveLaunchIdentityModelDefaultMock(...(args as [any])),
}));
vi.mock('../../agent-launch-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-launch-core')>()),
  claimAgentLaunch: (...args: unknown[]) => claimAgentLaunchMock(...(args as [any])),
  recordAgentLaunchResult: (...args: unknown[]) =>
    recordAgentLaunchResultMock(...(args as [any])),
  releaseAgentLaunchClaim: (...args: unknown[]) =>
    releaseAgentLaunchClaimMock(...(args as [any])),
}));
// bootstrap-su only needs these mocked boundaries; importing the real module
// also loads its CODEX_HOME filesystem and worker graph during routesOf().
vi.mock('../../role-codex-home', () => ({
  assertSuCodexHomeNotOwnedByLiveSession: (...args: unknown[]) =>
    assertSuCodexHomeNotOwnedByLiveSessionMock(...(args as Parameters<typeof assertSuCodexHomeNotOwnedByLiveSessionMock>)),
  writeSuCodexHome: (...args: unknown[]) => writeSuCodexHomeMock(...(args as [any])),
  writeSuCodexHomeAsync: async (...args: unknown[]) => writeSuCodexHomeMock(...(args as [any])),
  rekeyCodexHome: (...args: unknown[]) => rekeyCodexHomeMock(...(args as [any, any])),
}));
vi.mock('../../interactive-claude-config', () => ({
  writeInteractiveClaudeConfig: (...args: unknown[]) => writeInteractiveClaudeConfigMock(...(args as [any])),
}));
// The bootstrap handler fires a best-effort saved-prompts materialize side
// effect; this unit test isn't exercising it (the materialize integration test
// is), and running it for real would query the DB + write/prune the dev box's
// ~/.claude/commands. No-op it here.
vi.mock('../../saved-prompts-materialize', () => ({
  materializeWorkspacePrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeHarnessPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeCodexPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
}));
vi.mock('../../slash-tool-prompts-codex', () => ({
  emitCodexSlashToolPrompts: vi.fn(async () => ({ written: 0, skipped: 0, pruned: 0, ms: 0 })),
}));
vi.mock('../../desktop-install/papercusp-files', () => ({
  resolveInstallPaths: () => ({ extensionPath: COORD_EXT }),
}));
vi.mock('../../superuser-token', () => ({
  readSuperuserToken: () => 'TESTBEARER',
}));
// D-013 brain pin: mock the old PG-backed pointer so retired paths can assert
// they do not touch it.
// EI-908: setBrainSession is workspace-scoped — (workspaceId, nativeSessionId).
const setBrainSessionMock = vi.fn(async (_ws: string, _id: string) => {});
const getBrainSessionMock = vi.fn(async (): Promise<string | null> => null);
vi.mock('../../brain-pin', () => ({
  setBrainSession: (...a: unknown[]) => setBrainSessionMock(...(a as [string, string])),
  getBrainSession: () => getBrainSessionMock(),
}));
// Account routing tests also use feature flags. importActual keeps the rest of
// flags/server real.
const getFlagMock = vi.fn(async (_key: string, _scope: string): Promise<boolean> => false);
vi.mock('@papercusp/flags/server', async (importActual) => ({
  ...(await importActual<typeof import('@papercusp/flags/server')>()),
  getFlag: (...a: unknown[]) => getFlagMock(...(a as [string, string])),
}));
// Old brain-brief dependencies remain mocked so tombstone tests can prove the
// retired launch path exits before computing a brief.
const listStartedHivesMock = vi.fn(async () => [{ workspaceId: 'default', installSlug: 'papercup' }]);
vi.mock('../../pot/started', () => ({ listStartedHives: (...a: unknown[]) => listStartedHivesMock(...(a as [])) }));
// P-059: the sibling `pot/mug-brief-launch` stub is gone with the module. It was
// already inert — it mocked `computeQueenWakeBrief`, which the module stopped
// exporting at the queen→mug rename, so the mock backed no real import.
vi.mock('../../device-harnesses', () => ({
  listHarnessesFor: vi.fn(async () => [
    {
      slug: 'papercup',
      path: '/repo',
      harness_kind: null,
      has_state: true,
      status: 'active',
      iteration: 1,
      last_active_ts: null,
    },
  ]),
}));
vi.mock('../../agent-tools/plans/source', () => ({
  resolveHarnessPlansDir: vi.fn(async () => ({
    harnessSlug: 'papercup',
    plans: '/repo/plans',
    archive: '/repo/plans/archive',
  })),
  listPlanFiles: vi.fn(async () => [
    { slug: 'plan-a', filePath: '/repo/plans/plan-a.md', archived: false },
    { slug: 'plan-archived', filePath: '/repo/plans/archive/plan-archived.md', archived: true },
  ]),
  readPlanBySlug: vi.fn(async () => ({
    parsed: { now: { state: 'do X', next: 'then Y' }, frontmatter: { title: 'My Plan' } },
    archived: false,
  })),
}));
// psu-account-chooser P-002: resolveAccountPin reads the pool + the session-override,
// but ONLY when the gateway flag is on. Mock both so the gateway-ON branches are
// DB-free + deterministic (the gateway-OFF + no-account branches return before them).
type MockPoolAccount = {
  id: string;
  credentialFailure?: { observedAt: number; ownerId: string };
  provider?: 'claude' | 'codex';
  rate?: {
    utilization?: number;
    utilization7d?: number;
    utilizationAt?: number;
    windowResetAt7d?: number;
    pausedUntil?: number;
    lastProbeFailedAt?: number;
  };
};
const loadAccountPoolMock = vi.fn(
  async (_ws?: string): Promise<{ accounts: MockPoolAccount[] }> => ({
    accounts: [{ id: 'aviynw6' }, { id: 'aviynw2' }],
  }),
);
// default-deploy-account-2026-08-08: resolveAccountPin reads the owner's default from THIS
// module (a dynamic import inside its try/catch). Omitting the export here does not merely
// leave it unstubbed — the import itself throws, the catch reads that as "the default is
// unreadable", and every implied-default claude call fail-closes with `env: {}`. Default to
// `undefined` = "no default set", which is the pre-feature behaviour the older tests assert.
const readDefaultAccountIdMock = vi.fn(async (_ws?: string): Promise<string | undefined> => undefined);
vi.mock('../../deployment/account-pool-store', () => ({
  loadAccountPool: (...a: unknown[]) => loadAccountPoolMock(...(a as [string])),
  readDefaultAccountId: (...a: unknown[]) => readDefaultAccountIdMock(...(a as [string])),
}));
const getAccountOverrideMock = vi.fn(async (_ws: string) => ({
  forcedAccounts: [] as string[],
  excludeAccounts: [] as string[],
}));

const readOmpModelCatalogMock = vi.fn(async (_opts?: unknown) => ({
  models: [{
    provider: 'openai-codex',
    id: 'gpt-5.6-terra',
    selector: 'openai-codex/gpt-5.6-terra',
    name: 'GPT-5.6-Terra',
    contextWindow: 200_000,
    maxTokens: 128_000,
    reasoning: true,
    thinking: ['low', 'medium', 'high'],
    input: ['text'],
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  }],
}));
vi.mock('../../omp-config', () => ({
  readOmpModelCatalog: (opts?: unknown) => readOmpModelCatalogMock(opts),
}));
vi.mock('../../deployment/account-session-override', () => ({
  getAccountOverride: (...a: unknown[]) => getAccountOverrideMock(...(a as [string])),
}));

// fleet-recolor-and-color-hardening P-002: mock ONLY the agent-fleets-store IO
// (createFleetIfAbsent / getFleetScheme / listFleets) so resolveFleet's color-env
// wiring is testable without PG. importActual keeps the REAL pure helpers
// (fleetSlugFromName, resolveFleetScheme) so the test exercises genuine slug +
// scheme resolution — i.e. it asserts the actual catalog hex reaches the env.
const createFleetIfAbsentMock = vi.fn();
const getFleetSchemeMock = vi.fn();
const listFleetsMock = vi.fn(async () => [] as unknown[]);
// WI-1408 (fleet-join-startup-assertion): resolveFleet's join branch now checks the
// slug is a REAL fleet via getFleet before handing back membership env. Default to a
// truthy record so every PRE-EXISTING "join an existing fleet" test (which never set
// this up) keeps its current, already-asserted behavior; the new existence-check
// tests below override it to null per-case.
const getFleetMock = vi.fn(async (_ws: string, slug: string): Promise<AgentFleetRecord | null> => ({
  workspaceId: 'default',
  fleetSlug: slug,
  title: slug,
  description: null,
  owner: 'su-1',
  leaderOwnerId: 'su-1',
  leaderMissingSinceMs: null,
  fleetType: 'single',
  colorScheme: null,
  controlState: 'active',
  controlResumeGate: null,
  controlExpiresAt: null,
  controlNoResumePath: false,
  controlReason: null,
  controlBy: null,
  controlAt: null,
  lastLaunchTransaction: null,
  createdAt: 0,
  updatedAt: 0,
}));
vi.mock('../../agent-fleets-store', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    createFleetIfAbsent: createFleetIfAbsentMock,
    getFleetScheme: getFleetSchemeMock,
    listFleets: listFleetsMock,
    getFleet: getFleetMock,
  };
});

// WI-1893's boot-time membership stamp (stampFleetMembershipAtBoot) is the OTHER
// PG write on the fleet-join path, and it was the one IO edge this otherwise-hermetic
// file never stubbed — it only became reachable when the stamp was added. It is a
// no-ghost CORRECTNESS gate: a failure there is turned into a hard 409, and
// stampFleetMembershipAtBoot swallows the exception into a message string, so an
// unstubbed real-PG reach surfaced as a bare `expected 'error' to be 'ok'` with the
// cause nowhere in the failure. Mock the store's write; importActual keeps the pure
// helper (deriveFleetMembershipEvent) real.
const appendFleetMembershipIfAbsentMock = vi.fn(async (_input: unknown) => {});
vi.mock('../../fleet-membership-store', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  appendFleetMembershipIfAbsent: appendFleetMembershipIfAbsentMock,
}));

// EI-21005277510954647: bootstrap now writes the initial presence row through
// the canonical presence seam so its resolved harness becomes pot_slug before
// the launched agent's first coord:orient call.
const writePresenceMock = vi.fn(
  async (_identity: unknown, _input: unknown, _harness: unknown) => {},
);
// WI-10006674: a harness-less boot stamp reads the row first (create-if-absent).
// Default null = no row yet, i.e. a fresh launch.
const getPresenceMock = vi.fn(async (_ownerId: string): Promise<unknown> => null);
vi.mock('../../agent-tools/coordination/presence', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  writePresence: (...args: unknown[]) =>
    writePresenceMock(...(args as [unknown, unknown, unknown])),
  getPresence: (...args: unknown[]) => getPresenceMock(...(args as [string])),
}));
type PendingCarryRespawnTestSlot = {
  nonce: string;
  createdAtMs: number;
  expiresAtMs: number;
  firstPrompt: string;
  systemPromptAddendum: string;
};
const consumePendingCarryRespawnMock = vi.fn(
  async (_ownerId: string): Promise<PendingCarryRespawnTestSlot | null> => null,
);
const restorePendingCarryRespawnMock = vi.fn(
  async (_ownerId: string, _workspaceId: string, _slot: PendingCarryRespawnTestSlot) => true,
);
vi.mock('../../session-brief', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  consumePendingCarryRespawn: (...args: unknown[]) =>
    consumePendingCarryRespawnMock(...(args as [string])),
  restorePendingCarryRespawn: (...args: unknown[]) =>
    restorePendingCarryRespawnMock(...(args as [string, string, PendingCarryRespawnTestSlot])),
}));
const resolveWakeModeMock = vi.hoisted(() => vi.fn(async (_ownerId: string): Promise<'auto' | 'manual'> => 'auto'));
const ensureLaunchedWakeAutoMock = vi.hoisted(() => vi.fn(async (_ownerId: string, _options: unknown) => null));
vi.mock('../../agent-tools/coordination/wake-mode', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  resolveWakeMode: (...args: unknown[]) => resolveWakeModeMock(...(args as [string])),
  ensureLaunchedWakeAuto: (...args: unknown[]) => ensureLaunchedWakeAutoMock(...(args as [string, unknown])),
}));
// EI-21442511412659661: bootstrap must consult the shared liveness oracle and
// treat an absent/rejected read as unknown (therefore blocking). Keep the route
// suite PG-free while asserting the exact hydrated call shape.
const resolveSessionStatesMock = vi.hoisted(() =>
  vi.fn(async (_subjects: readonly { ownerId: string }[], _opts?: unknown) => new Map()),
);
vi.mock('../../agent-tools/coordination/liveness-oracle', () => ({
  resolveSessionStates: (...args: unknown[]) => resolveSessionStatesMock(...(args as [any, any])),
}));
type FakeOrgSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
// EI-21365235532676472: pin pty discovery hermetically — no fake owner has a real
// host on this machine, and the live-evidence leg must be deterministic.
// bootstrap-su only needs the async lookup, and agent-launch-core's launch
// functions are mocked below. Avoid importing the production discovery graph
// while routesOf() is still loading the route module.
vi.mock('../../events/await/psu-pty-discovery', () => ({
  findLiveHost: vi.fn(() => null),
  findLiveHostAsync: vi.fn(async () => null),
  injectIntoHost: vi.fn(async () => false),
}));
// EI-21365235532676472: hermetic PG for the pre-pinned guard's two reads. Only
// queries the guard itself issues are answered; everything else stays empty.
const dbState = vi.hoisted(() => ({
  advRows: [] as Array<{ id: string; display: string | null; has_session: boolean }>,
  beatRows: [] as Array<{ pid: number | null; host: string | null }>,
}));
// Shared answerer so BOTH surfaces of the fake client agree: the tagged-template
// calls the guard issues AND any `sql.unsafe(...)` issued elsewhere on this path
// (federation-scope <- remote-seat-inventory <- bootstrap-su) resolve through the
// same matcher; everything unknown stays an empty set, never a fabricated row.
const answerOrgQuery = (q: string): Promise<unknown[]> => {
  if (q.includes('FROM harness_shared.coord_presence')) return Promise.resolve(dbState.beatRows);
  if (q.includes('FROM harness_shared.adv_sessions')) return Promise.resolve(dbState.advRows);
  return Promise.resolve([]);
};
const dbSqlMock = vi.fn((strings: TemplateStringsArray): Promise<unknown[]> =>
  answerOrgQuery(strings.join('?')),
) as unknown as FakeOrgSql & {
  unsafe: (query: string) => Promise<unknown[]>;
  begin: <T>(fn: (sql: FakeOrgSql) => Promise<T>) => Promise<T>;
};
dbSqlMock.unsafe = (query: string) => answerOrgQuery(query);
dbSqlMock.begin = async <T>(fn: (sql: FakeOrgSql) => Promise<T>): Promise<T> => fn(dbSqlMock);
vi.mock('@papercusp/db-org', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getOrgPg: () => ({ sql: dbSqlMock }),
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

type Route = { method: string; timeoutSec?: number | null; handler: (req: Request, ctx: RouteContext) => Promise<Response> };

async function routesOf(): Promise<Route[]> {
  const mod = await import('../routes/agent-mcp/bootstrap-su');
  return mod.default as Route[];
}

async function callPost(
  body: unknown,
  onStage?: (stage: 'loading-routes' | 'running-handler') => void,
): Promise<Response> {
  onStage?.('loading-routes');
  const post = (await routesOf()).find((r) => r.method === 'POST')!;
  onStage?.('running-handler');
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return post.handler(req, CTX);
}

describe('bootstrap headless task/session binding', () => {
  it('forwards the exact enrolled task id to the owner-scoped binder', async () => {
    const taskId = '0123456789abcdefghj';
    let routeStage = 'not-started';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const request = callPost({
      agent: 'claude', harness_slug: 'papercup', headless: true,
      owner_id: 'su-headless-owner', agent_task_id: taskId,
    }, (stage) => { routeStage = stage; }).then(
      (response) => ({ kind: 'response' as const, response }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    const outcome = await Promise.race([
      request,
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), 10_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (outcome.kind === 'timeout') {
      throw new Error(`bootstrap did not settle; observed route calls: ${JSON.stringify({
        routeStage,
        prePinnedQueries: dbSqlMock.mock.calls.length,
        livenessChecks: resolveSessionStatesMock.mock.calls.length,
        launchSpecs: buildLaunchSpecMock.mock.calls.length,
        sessionWrites: recordAdvSessionMock.mock.calls.length,
        taskBinds: bindAgentTasksMock.mock.calls.length,
        modeWrites: setModeMock.mock.calls.length,
      })}`);
    }
    if (outcome.kind === 'error') throw outcome.error;
    const response = outcome.response;
    expect(response.status).toBe(200);
    expect(bindAgentTasksMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'default', coordOwnerId: 'su-headless-owner', initialTaskId: taskId,
    }));
    expect(writeInteractiveClaudeConfigMock).toHaveBeenCalledWith(expect.objectContaining({
      sid: 'su-headless-owner', agentTaskId: taskId,
    }));
    const launch = await response.json();
    expect(launch.envelopeEnv).not.toHaveProperty('PAPERCUSP_AGENT_TASK_ID');
  });

  it('rejects malformed or non-headless task ids before recording a session', async () => {
    const response = await callPost({
      agent: 'claude', harness_slug: 'papercup', headless: true,
      agent_task_id: 'bad/id',
    });
    expect(response.status).toBe(400);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });
});

async function callGet(query = ''): Promise<Response> {
  const get = (await routesOf()).find((r) => r.method === 'GET' && (r as any).path?.endsWith('/options'))!;
  const req = new Request(`http://localhost:3070/api/agent-mcp/console/bootstrap-su/options${query}`, {
    method: 'GET',
  });
  return get.handler(req, CTX);
}

async function callBrainGet(): Promise<Response> {
  const get = (await routesOf()).find((r) => r.method === 'GET' && (r as any).path?.endsWith('/brain'))!;
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su/brain', {
    method: 'GET',
  });
  return get.handler(req, CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  nativeFork.complete.mockReset();
  nativeFork.resolveSource.mockReset();
  vi.stubEnv('HOME', TEST_CODEX_AUTH_HOME);
  vi.stubEnv('OPENAI_API_KEY', '');
  sessionAllowsAmbientContextMock.mockReset().mockResolvedValue(true);
  consumePendingCarryRespawnMock.mockReset().mockResolvedValue(null);
  restorePendingCarryRespawnMock.mockReset().mockResolvedValue(true);
  resolveWakeModeMock.mockReset().mockResolvedValue('auto');
  ensureLaunchedWakeAutoMock.mockReset().mockResolvedValue(null);
  resolveLaunchIdentityModelDefaultMock.mockReset().mockResolvedValue(null);
  resolveSessionStatesMock.mockReset().mockResolvedValue(new Map());
  claimAgentLaunchMock.mockReset().mockResolvedValue({
    won: true,
    priorSummary: null,
    priorLaunchedAt: null,
    priorLaunchedBy: null,
  });
  recordAgentLaunchResultMock.mockReset().mockResolvedValue(undefined);
  releaseAgentLaunchClaimMock.mockReset().mockResolvedValue(true);
  recordAdvSessionMock.mockResolvedValue(42);
  setModeMock.mockReset().mockResolvedValue({ ok: true, noop: false });
  getSessionPortMock.mockResolvedValue(null);
  reserveSessionPortTargetMock.mockClear();
  readSessionPortBootstrapDispositionMock.mockClear();
  recordSessionPortBootstrapReceiptMock.mockClear();
  failSessionPortTargetReservationMock.mockClear();
  // P-002 brain-brief defaults: one started hive + a brief string. Tests that
  // exercise the no-brief / no-hive branches override per-call.
  listStartedHivesMock.mockResolvedValue([{ workspaceId: 'default', installSlug: 'papercup' }]);
});
afterEach(() => vi.unstubAllEnvs());

describe('bootstrap frozen native prompt binding', () => {
  it.each([false, true])('saved prompt isolation follows host ambient policy: allowed=%s', async (allowed) => {
    sessionAllowsAmbientContextMock.mockResolvedValue(allowed);
    const saved = await import('../../saved-prompts-materialize');
    const slash = await import('../../slash-tool-prompts-codex');
    const response = await callPost({ agent: 'codex', harness_slug: 'papercup',
      owner_id: 'su-frozen-prompts-123', model: 'gpt-6-sol', account: 'default' });
    expect(response.status).toBe(200);
    // These writes expose workspace content and the full operator catalog in
    // the readable native home, after the persona builder has already run.
    const homeInput = writeSuCodexHomeMock.mock.calls.at(-1)![0];
    expect(homeInput.denyAmbientContext).toBe(allowed ? undefined : true);
    expect(saved.materializeCodexPrompts).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(slash.emitCodexSlashToolPrompts).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(saved.materializeWorkspacePrompts).not.toHaveBeenCalled();
    expect(saved.materializeHarnessPrompts).not.toHaveBeenCalled();
  });

  it('threads the pre-pinned host identity into the renderer and suppresses live plan context', async () => {
    sessionAllowsAmbientContextMock.mockResolvedValue(false);
    const response = await callPost({ agent: 'codex', harness_slug: 'papercup', plan_slug: 'private-plan',
      owner_id: 'su-frozen-native-123', model: 'gpt-6-sol', account: 'default' });
    expect(response.status).toBe(200);
    expect(sessionAllowsAmbientContextMock).toHaveBeenCalledWith({ ownerId: 'su-frozen-native-123', workspaceId: 'default' });
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'su-frozen-native-123', planTitle: null, planNow: null,
    }));
  });
});

describe('bootstrap-su', () => {
  it('lets a committed slow bootstrap return its result past the generic route watchdog', async () => {
    const post = (await routesOf()).find((route) => route.method === 'POST')!;
    expect(post.timeoutSec).toBeNull();
  });

  it.each(['grade', 'test'])('binds %s and AUTO into the first render and registry before returning a session', async (mode) => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', mode });
    expect(res.status).toBe(200);
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ modes: ['auto', mode] }));
    expect(setModeMock.mock.calls.map((call) => (call[0] as { modeId: string }).modeId)).toEqual(['auto', mode]);
  });

  it('passes the rendered mode identity refs into the immutable launch artifact', async () => {
    const originalBuild = buildLaunchSpecMock.getMockImplementation()!;
    const impliedStack = ['autonomy:su.mode-auto', 'objective:su.mode-drain'];
    buildLaunchSpecMock.mockImplementationOnce(async (input) => ({
      ...await originalBuild(input),
      impliedStack,
    }));

    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', mode: 'drain' });

    expect(res.status).toBe(200);
    expect(compileLaunchSpecificationArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({ impliedStack }),
    );
  });

  it('refuses a verifier launch when its durable mode cannot be activated', async () => {
    setModeMock.mockRejectedValueOnce(new Error('mode store unavailable'));
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', mode: 'test' });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('verifier_mode_activation_failed');
  });

  it('waits for the attached GOAL cascade and refuses wrong provenance before returning a runnable session', async () => {
    const goal = { mode: 'goal', subject: 'goal-1', impliedBy: null };
    const auto = { mode: 'auto', subject: null, impliedBy: { mode: 'goal', subject: 'goal-1' } };
    const ideate = { mode: 'ideate', subject: null, impliedBy: { mode: 'goal', subject: 'goal-1' } };
    getModesMock.mockResolvedValueOnce([]).mockResolvedValueOnce([goal, auto, ideate]);
    const ready = await callPost({ agent: 'claude', harness_slug: 'papercup', owner_id: 'su-goalboot', goal_bootstrap_subject: 'goal-1' });
    expect(ready.status).toBe(200);
    expect(getModesMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(getModesMock).toHaveBeenCalledWith('default', 'su-goalboot');
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ modes: ['goal', 'auto', 'ideate'] }));

    getModesMock.mockReset().mockResolvedValue([goal, { ...auto, impliedBy: null }, ideate]);
    const invalid = await callPost({ agent: 'claude', harness_slug: 'papercup', owner_id: 'su-goalbad', goal_bootstrap_subject: 'goal-1' });
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toMatchObject({ code: 'goal_bootstrap_attestation_failed', error: expect.stringContaining('auto lacks GOAL cascade provenance') });
  });

  it('attests exact GOAL subject and AUTO/IDEATE cascade provenance before turn one', async () => {
    const { attestGoalBootstrapModes } = await import('../routes/agent-mcp/bootstrap-su');
    const goal = { mode: 'goal', subject: 'goal-1', impliedBy: null };
    const auto = { mode: 'auto', subject: null, impliedBy: { mode: 'goal', subject: 'goal-1' } };
    const ideate = { mode: 'ideate', subject: null, impliedBy: { mode: 'goal', subject: 'goal-1' } };
    expect(attestGoalBootstrapModes('goal-1', [])).toEqual({ status: 'pending' });
    expect(attestGoalBootstrapModes('goal-1', [goal, auto, ideate])).toEqual({ status: 'ready' });
    expect(attestGoalBootstrapModes('goal-2', [goal, auto, ideate])).toMatchObject({ status: 'invalid', reason: expect.stringContaining('does not match') });
    expect(attestGoalBootstrapModes('goal-1', [goal, { ...auto, impliedBy: null }, ideate])).toMatchObject({ status: 'invalid', reason: expect.stringContaining('auto lacks GOAL cascade provenance') });
    expect(attestGoalBootstrapModes('goal-1', [goal, auto])).toMatchObject({ status: 'invalid', reason: expect.stringContaining('ideate lacks GOAL cascade provenance') });
  });

  it('stampPresenceAtBoot accepts a role override while preserving the SU default', async () => {
    const { stampPresenceAtBoot } = await import('../routes/agent-mcp/bootstrap-su');

    await expect(stampPresenceAtBoot({
      workspaceId: 'default',
      ownerId: 'role-judge',
      ownerLabel: 'judge',
      harnessSlug: 'papercup',
      agentRole: 'judge',
    })).resolves.toBeNull();
    expect(writePresenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'role-judge', ownerLabel: 'judge' }),
      { agentRole: 'judge' },
      'papercup',
    );

    writePresenceMock.mockClear();
    await expect(stampPresenceAtBoot({
      workspaceId: 'default',
      ownerId: 'su-default',
      harnessSlug: 'papercup',
    })).resolves.toBeNull();
    expect(writePresenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-default' }),
      { agentRole: 'su' },
      'papercup',
    );
  });

  it('claude: builds the su spec, writes the playbook prompt file, mints PAPERCUSP_SID', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.sessionId).toBe(42);
    expect(json.cwd).toBe('/proj/papercup');
    expect(json.codexHome).toBeNull();

    // buildLaunchSpec drives the prompt; called with the su kind + plan context.
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'su',
        agent: 'claude',
        harnessSlug: 'papercup',
        profile: 'engineer', // P-023 default
        planSlug: 'my-plan',
        planTitle: 'My Plan',
        planNow: { state: 'do X', next: 'then Y' },
      }),
    );
    // The playbook+ctx prompt is written to a launch-context file.
    expect(json.promptFile).toMatch(/session-42\.md$/);
    const prompt = readFileSync(json.promptFile, 'utf8');
    expect(prompt).toContain('PLAYBOOK + CTX BODY');
    expect(prompt).toContain('⟦INSTRUCTION-PRECEDENCE⟧');
    expect(json.instructionLint.precedenceTrace).toMatchObject({
      effectiveMission: { constraint: 'execute-bound-plan', source: 'plan:my-plan' },
      resync: { verb: 'coord:orient', rule: 'replace-full-never-merge-behind' },
    });

    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: 'my-plan', agent: 'claude', mode: 'console' }),
    );
    expect(json.envelopeEnv.PAPERCUSP_AGENT).toBe('claude');
    expect(json.envelopeEnv.PAPERCUSP_SID).toMatch(/^su-/);
    expect(json.envelopeEnv.PAPERCUSP_ADV_SESSION_ID).toBe('42');
    expect(json.specificationRevision).toBe('a'.repeat(64));
    expect(json.envelopeEnv.PAPERCUSP_SPECIFICATION_REVISION).toBe(json.specificationRevision);
    expect(json.envelopeEnv.PAPERCUSP_STATE_REVISION).toBe(json.stateRevision);
    expect(compileLaunchSpecificationArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        promptText: expect.stringContaining('⟦INSTRUCTION-PRECEDENCE⟧'),
        role: 'su',
        // WI-10004747: the persona composes the su static layers, so the artifact (and the
        // model preflight that must agree with it) records them as slotted inputs.
        impliedStack: 'su-static',
      }),
    );
    expect(resolveLaunchIdentityModelDefaultMock).toHaveBeenCalledWith(
      expect.objectContaining({ impliedStack: 'su-static' }),
    );
    expect(json.envelopeEnv.CODEX_HOME).toBeUndefined();
    // coord extension resolved for omp's -e (present in this test env).
    expect(json.coordExtPath).toBe(COORD_EXT);
  });

  it('replays a completed key from the shared launch ledger without minting another session', async () => {
    const request = {
      agent: 'claude',
      harness_slug: 'papercup',
      plan_slug: 'my-plan',
      bootstrap_idempotency_key: 'bootstrap-key-1',
    };
    const first = await callPost(request);
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith({
      workspaceId: 'default',
      idempotencyKey: 'bootstrap-su:bootstrap-key-1',
      summary: firstJson,
    });
    expect(recordAdvSessionMock).toHaveBeenCalledTimes(1);

    claimAgentLaunchMock.mockResolvedValue({
      won: false,
      priorSummary: firstJson,
      priorLaunchedAt: Date.now(),
      priorLaunchedBy: null,
    });
    const replay = await callPost(request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      status: 'ok',
      sessionId: firstJson.sessionId,
      bootstrapDeduped: true,
    });
    expect(recordAdvSessionMock).toHaveBeenCalledTimes(1);
  });

  it('returns a typed retryable conflict while the winning bootstrap is still in flight', async () => {
    claimAgentLaunchMock.mockResolvedValue({
      won: false,
      priorSummary: {},
      priorLaunchedAt: Date.now(),
      priorLaunchedBy: null,
    });
    const response = await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      bootstrap_idempotency_key: 'bootstrap-key-in-flight',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: 'error',
      error: 'bootstrap_in_progress',
      retryAfterSec: 1,
    });
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('releases a won bootstrap claim when a later session write fails', async () => {
    recordAdvSessionMock.mockRejectedValueOnce(new Error('session write failed'));
    await expect(
      callPost({
        agent: 'claude',
        harness_slug: 'papercup',
        bootstrap_idempotency_key: 'bootstrap-key-failed',
      }),
    ).rejects.toThrow('session write failed');
    expect(releaseAgentLaunchClaimMock).toHaveBeenCalledWith({
      workspaceId: 'default',
      idempotencyKey: 'bootstrap-su:bootstrap-key-failed',
    });
  });

  it('terminalizes a row written by an incomplete bootstrap before releasing its replay claim', async () => {
    const request = {
      agent: 'codex',
      harness_slug: 'papercup',
      owner_id: 'su-replay01',
      bootstrap_idempotency_key: 'bootstrap-key-post-record-failed',
    };
    recordAdvSessionMock
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(43);
    recordAgentLaunchResultMock.mockRejectedValueOnce(new Error('post-record result failure'));

    await expect(callPost(request)).rejects.toThrow('post-record result failure');
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, null, 'reconciler', {
      throwOnError: true,
    });
    expect(markAdvSessionEndedMock.mock.invocationCallOrder[0]).toBeLessThan(
      releaseAgentLaunchClaimMock.mock.invocationCallOrder[0],
    );

    // The same-key replay now sees no live ghost row and creates exactly one
    // successor session instead of failing the pre-pinned-owner freshness guard.
    const replay = await callPost(request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: 'ok', sessionId: 43 });
    expect(recordAdvSessionMock).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('retains the replay claim when strict partial-row cleanup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordAdvSessionMock.mockResolvedValueOnce(42);
    recordAgentLaunchResultMock.mockRejectedValueOnce(new Error('post-record result failure'));
    markAdvSessionEndedMock.mockRejectedValueOnce(new Error('terminal write unavailable'));

    try {
      await expect(
        callPost({
          agent: 'codex',
          harness_slug: 'papercup',
          owner_id: 'su-replay02',
          bootstrap_idempotency_key: 'bootstrap-key-cleanup-failed',
        }),
      ).rejects.toThrow('post-record result failure');
      expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, null, 'reconciler', {
        throwOnError: true,
      });
      expect(releaseAgentLaunchClaimMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'incomplete session 42 could not be terminalized; retaining bootstrap idempotency claim',
        ),
      );
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it.each([false, true])('native fork failure keeps retry safe when child cleanup fails=%s', async cleanupFails => {
    const source = { advSessionId: 9, nativeSessionId: '11111111-1111-4111-8111-111111111111' };
    const childNativeId = '22222222-2222-4222-8222-222222222222';
    const lineage = { ...source, ownerId: 'su-fork-parent' };
    nativeFork.resolveSource.mockResolvedValue({ ownerId: lineage.ownerId });
    nativeFork.complete
      .mockRejectedValueOnce(new Error('native fork preparation failed'))
      .mockResolvedValueOnce({ nativeSessionId: childNativeId, nativeFork: lineage });
    recordAdvSessionMock.mockResolvedValueOnce(42).mockResolvedValueOnce(43);
    if (cleanupFails) markAdvSessionEndedMock.mockRejectedValueOnce(new Error('terminalization unavailable'));
    const request = { agent: 'codex', harness_slug: 'papercup', owner_id: 'su-fork-child',
      native_fork_source: source, bootstrap_idempotency_key: `fork-cleanup-${cleanupFails}` };

    const warn = cleanupFails ? vi.spyOn(console, 'warn').mockImplementation(() => {}) : null;
    try {
      await expect(callPost(request)).rejects.toThrow('native fork preparation failed');
      if (warn) expect(warn).toHaveBeenCalledWith(expect.stringContaining(
        'incomplete session 42 could not be terminalized; retaining bootstrap idempotency claim'));
    } finally { warn?.mockRestore(); }
    expect(nativeFork.complete).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 42 }), source);
    expect(recordAgentLaunchResultMock).not.toHaveBeenCalled();
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, null, 'reconciler', { throwOnError: true });
    if (cleanupFails) {
      expect(releaseAgentLaunchClaimMock).not.toHaveBeenCalled();
      expect(recordAdvSessionMock).toHaveBeenCalledTimes(1);
      return;
    }
    expect(markAdvSessionEndedMock.mock.invocationCallOrder[0]).toBeLessThan(
      releaseAgentLaunchClaimMock.mock.invocationCallOrder[0]);

    const replay = await callPost(request);
    expect(replay.status).toBe(200);
    const receipt = await replay.json();
    expect(receipt).toMatchObject({ sessionId: 43, nativeSessionId: childNativeId, nativeFork: lineage });
    expect(recordAdvSessionMock).toHaveBeenCalledTimes(2);
    expect(recordAgentLaunchResultMock).toHaveBeenCalledTimes(1);
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(expect.objectContaining({ summary: receipt }));
    expect(nativeFork.complete.mock.invocationCallOrder[1]).toBeLessThan(
      recordAgentLaunchResultMock.mock.invocationCallOrder[0]);
  }, 30_000);

  it('stamps the resolved harness onto presence before the launched agent takes turn 1', async () => {
    const json = await (
      await callPost({
        agent: 'claude',
        harness_slug: 'papercup',
        plan_slug: 'my-plan',
        label: 'canary member',
      })
    ).json();
    const sid = json.envelopeEnv.PAPERCUSP_SID;

    expect(writePresenceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: sid,
        ownerLabel: 'canary member',
        workspaceId: 'default',
        source: 'omp-hook-session',
      }),
      expect.objectContaining({ agentRole: 'su' }),
      'papercup',
    );
    expect(recordAdvSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
      writePresenceMock.mock.invocationCallOrder[0],
    );
  });

  it('EI-5503: returns the canonical kickoffPrompt for a plan-bound launch, null without a plan', async () => {
    const withPlan = await (await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' })).json();
    // AUTO OFF (this launch passes no auto/fleet) → a lead agent gets the ROUTING-GATE
    // kickoff (deriveLaunchPromptText(null, false)): read the plan via plans:get, then
    // present the execution options (do-it-yourself / Queen / fleet) and confirm before
    // working — instead of the "just work it" order. AUTO-ON's work-order kickoff (the
    // old default) is covered by launch.test.ts's deriveLaunchPromptText default case.
    expect(withPlan.kickoffPrompt).toContain('plans:get');
    expect(withPlan.kickoffPrompt).toContain('routing gate');
    expect(withPlan.kickoffPrompt).toContain('launch a fleet');
    expect(withPlan.kickoffPrompt).not.toContain('pick up the next actionable item');
    const noPlan = await (await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null })).json();
    expect(noPlan.kickoffPrompt).toBeNull();
  });

  it('consumes a validated owner carry slot into the next launch prompt and system prompt', async () => {
    const now = Date.now();
    const slot: PendingCarryRespawnTestSlot = {
      nonce: 'carry-bootstrap-nonce',
      createdAtMs: now,
      expiresAtMs: now + 60_000,
      firstPrompt: 'Test-only saved first turn prompt.',
      systemPromptAddendum: 'Test-only persisted system carry addendum.',
    };
    consumePendingCarryRespawnMock.mockResolvedValueOnce(slot);

    const response = await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      owner_id: 'su-carry-bootstrap',
    });

    expect(response.status).toBe(200);
    expect(consumePendingCarryRespawnMock).toHaveBeenCalledWith('su-carry-bootstrap');
    const body = await response.json();
    expect(body.kickoffPrompt).toBe(slot.firstPrompt);
    const compiledPrompt = (compileLaunchSpecificationArtifactMock.mock.calls[0]?.[0] as { promptText: string })
      .promptText;
    expect(compiledPrompt).toContain(slot.systemPromptAddendum);
    expect(compiledPrompt.indexOf('PLAYBOOK + CTX BODY')).toBeLessThan(
      compiledPrompt.indexOf(slot.systemPromptAddendum),
    );
    expect(restorePendingCarryRespawnMock).not.toHaveBeenCalled();
  });

  it('preserves a pending carry when the effective wake mode is manual', async () => {
    resolveWakeModeMock.mockResolvedValue('manual');

    const response = await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      owner_id: 'su-carry-paused',
    });

    expect(response.status).toBe(200);
    expect(resolveWakeModeMock).toHaveBeenCalledWith('su-carry-paused');
    expect(consumePendingCarryRespawnMock).not.toHaveBeenCalled();
    expect(restorePendingCarryRespawnMock).not.toHaveBeenCalled();
  });

  it('restores a consumed carry slot when fresh bootstrap fails before completion', async () => {
    const now = Date.now();
    const slot: PendingCarryRespawnTestSlot = {
      nonce: 'carry-restore-nonce',
      createdAtMs: now,
      expiresAtMs: now + 60_000,
      firstPrompt: 'Test-only saved first turn prompt.',
      systemPromptAddendum: 'Test-only persisted system carry addendum.',
    };
    consumePendingCarryRespawnMock.mockResolvedValueOnce(slot);
    compileLaunchSpecificationArtifactMock.mockRejectedValueOnce(new Error('artifact compile failed'));

    const response = await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      owner_id: 'su-carry-restore',
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('artifact compile failed') });

    expect(restorePendingCarryRespawnMock).toHaveBeenCalledWith('su-carry-restore', 'default', slot);
    expect(restorePendingCarryRespawnMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      consumePendingCarryRespawnMock.mock.invocationCallOrder[0]!,
    );
  });

  it('leaves an unconsumed carry pending when session creation fails first', async () => {
    recordAdvSessionMock.mockRejectedValueOnce(new Error('session write failed'));
    await expect(callPost({ agent: 'claude', harness_slug: 'papercup', owner_id: 'su-carry-early-fail' }))
      .rejects.toThrow('session write failed');
    expect(consumePendingCarryRespawnMock).not.toHaveBeenCalled();
    expect(restorePendingCarryRespawnMock).not.toHaveBeenCalled();
  });

  it('EI-155: claude gets a per-session CLAUDE_CONFIG_DIR keyed by the minted sid', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    const sid = json.envelopeEnv.PAPERCUSP_SID;
    // The materializer is keyed by the SAME sid recorded as coord_owner_id, so
    // the wake-executor resume leg (sessionClaudeConfigDir(coordOwnerId)) lands
    // on the identical dir the launch wrote to.
    expect(writeInteractiveClaudeConfigMock).toHaveBeenCalledWith(expect.objectContaining({ sid }));
    expect(json.envelopeEnv.CLAUDE_CONFIG_DIR).toBe(`/fake/.papercusp/session-claude/${sid}`);
  });

  it('refuses a session-port protocol skew before creating a target row', async () => {
    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.5',
      session_port_protocol: 2,
      session_port_transform_version: 2,
      session_port_token: `22222222-2222-4222-8222-222222222222.${'a'.repeat(64)}`,
    });
    expect(res.status).toBe(426);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('claims a prepared port as a fresh pending target and returns only the managed kickoff file', async () => {
    getSessionPortMock.mockResolvedValueOnce(sessionPortRow());
    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.5',
      owner_id: 'su-source-owner',
      bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
      session_port_protocol: 2,
      session_port_transform_version: SESSION_PORT_TRANSFORM_VERSION,
      session_port_token: `22222222-2222-4222-8222-222222222222.${'a'.repeat(64)}`,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kickoffPrompt).toBeNull();
    expect(body.sessionPortKickoffFile).toBe('/managed/222.seed.md');
    expect(body).not.toHaveProperty('sessionPortSeed');
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 42,
      }),
    );
    expect(body.codexHome).toMatch(/su-codex-homes\/session-42$/);
    expect(body.promptFile).toBe(`${body.codexHome}/AGENTS.md`);
    expect(body.envelopeEnv.CODEX_HOME).toBe(body.codexHome);
    expect(reserveSessionPortTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        portId: SESSION_PORT_ID,
        workspaceId: 'default',
        target: expect.objectContaining({ agent: 'codex', coordOwnerId: 'su-source-owner' }),
      }),
    );
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(consumePendingCarryRespawnMock).not.toHaveBeenCalled();
    expect(recordSessionPortBootstrapReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        portId: SESSION_PORT_ID,
        targetAdvSessionId: 42,
      }),
    );
    expect(recordSessionPortTelemetryMock).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'pending',
      portId: '22222222-2222-4222-8222-222222222222',
      targetAdvSessionId: 42,
    }));
  });

  // consult-backed-parking-2026-10-12#P-010 (R-10): 16 measured cross-backend port
  // failures (~2026-10-05) ended with "prepared target account auto did not resolve
  // exactly at bootstrap (got default)". The launcher sent the prepared 'auto', but the
  // codex auto route resolved without the gatewayAuto marker, so bootstrap read it as
  // 'default'. The first case is the regression guard for that class: an auto-routed
  // codex target must resolve to exactly 'auto' and be accepted. The second pins the
  // earlier contract guard: a launch whose account drifted from the prepared request is
  // refused before any target is reserved, so no route ever changes silently.
  const sessionPortRowForAccount = (account: string) => {
    const row = sessionPortRow();
    const summary = (row.metadata as { summary: { target: Record<string, unknown> } }).summary;
    return {
      ...row,
      metadata: { ...row.metadata, summary: { ...summary, target: { ...summary.target, account } } },
    };
  };
  const sessionPortLaunch = (account: string) => ({
    agent: 'codex',
    model: 'gpt-5.5',
    account,
    owner_id: 'su-source-owner',
    bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
    session_port_protocol: 2,
    session_port_transform_version: SESSION_PORT_TRANSFORM_VERSION,
    session_port_token: `${SESSION_PORT_ID}.${'a'.repeat(64)}`,
  });

  it('accepts a prepared auto account when the codex target resolves to unpinned gateway routing', async () => {
    getSessionPortMock.mockResolvedValueOnce(sessionPortRowForAccount('auto'));
    getFlagMock.mockImplementation(async (key: string) => key === 'papercusp-inference-gateway');
    loadAccountPoolMock.mockResolvedValueOnce({ accounts: [{ id: 'codex-main', provider: 'codex' }] });
    try {
      const res = await callPost(sessionPortLaunch('auto'));
      expect(res.status).toBe(200);
      expect(reserveSessionPortTargetMock).toHaveBeenCalledWith(
        expect.objectContaining({ portId: SESSION_PORT_ID }),
      );
      expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
        expect.objectContaining({ codexGatewayAuto: true, codexGatewayAccountId: null }),
      );
    } finally {
      getFlagMock.mockImplementation(async () => false);
    }
  });

  it('refuses a launch whose account drifted from the prepared auto request, before reserving a target', async () => {
    getSessionPortMock.mockResolvedValueOnce(sessionPortRowForAccount('auto'));
    const res = await callPost(sessionPortLaunch('default'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe(
      'session-port bootstrap inputs differ from the immutable prepared request; inspect and prepare again',
    );
    expect(reserveSessionPortTargetMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('replays the committed bootstrap receipt before rejecting an already-pending attempt', async () => {
    getSessionPortMock.mockResolvedValueOnce(sessionPortRow({ status: 'pending', targetAdvSessionId: 42 }));
    readSessionPortBootstrapDispositionMock.mockResolvedValueOnce({
      status: 'replay',
      targetAdvSessionId: 42,
      receipt: {
        status: 'ok',
        sessionId: 42,
        agent: 'codex',
        workspaceId: 'default',
        cwd: '/workspace',
      },
    });

    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.5',
      account: 'default',
      context_size: 'trimmed',
      owner_id: 'su-source-owner',
      bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
      session_port_protocol: 2,
      session_port_transform_version: SESSION_PORT_TRANSFORM_VERSION,
      session_port_token: `${SESSION_PORT_ID}.${'a'.repeat(64)}`,
      cwd: '/workspace',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', sessionId: 42, bootstrapDeduped: true });
    expect(reserveSessionPortTargetMock).not.toHaveBeenCalled();
    expect(writeSuCodexHomeMock).not.toHaveBeenCalled();
  });

  it('rejects an artifact whose semantic payload changed while its receipt stayed the same', async () => {
    getSessionPortMock.mockResolvedValueOnce(sessionPortRow());
    readSessionPortArtifactMock.mockResolvedValueOnce(
      SESSION_PORT_ARTIFACT.seed.replace('ported history', 'tampered history'),
    );
    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.5',
      owner_id: 'su-source-owner',
      bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
      session_port_protocol: 2,
      session_port_transform_version: SESSION_PORT_TRANSFORM_VERSION,
      session_port_token: `22222222-2222-4222-8222-222222222222.${'a'.repeat(64)}`,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/marker\/hash mismatch/) });
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('refuses a session-port target that does not continue the source coordination identity', async () => {
    getSessionPortMock.mockResolvedValueOnce(sessionPortRow());
    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.5',
      owner_id: 'su-different-owner',
      bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
      session_port_protocol: 2,
      session_port_transform_version: SESSION_PORT_TRANSFORM_VERSION,
      session_port_token: `22222222-2222-4222-8222-222222222222.${'a'.repeat(64)}`,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/must continue source coordination identity/) });
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it.each((['codex', 'omp'] as const).flatMap((sourceBackend) =>
    [true, false].map((continueSourceOwner) => ({ sourceBackend, continueSourceOwner }))))(
    'continues $sourceBackend source identity without a prepared target owner: matching owner $continueSourceOwner',
    async ({ sourceBackend, continueSourceOwner }) => {
      const seed = renderSessionPortSeed({
        portId: SESSION_PORT_ID, sourceBackend, targetBackend: 'claude',
        fidelity: 'full', transcript: 'exact native source history',
      });
      const port = sessionPortRow({ sourceBackend, targetBackend: 'claude', targetModel: 'sonnet', renderedHash: seed.hash });
      port.metadata.summary.source = {
        ...port.metadata.summary.source, backend: sourceBackend, nativeSessionId: `${sourceBackend}-native-source`,
      };
      port.metadata.summary.target = {
        ...port.metadata.summary.target, backend: 'claude', provider: 'anthropic', model: 'sonnet',
      };
      expect(port.metadata.summary.target).not.toHaveProperty('ownerId');
      const sourceIdentity = { ...port.metadata.summary.source };
      getSessionPortMock.mockResolvedValueOnce(port);
      readSessionPortArtifactMock.mockResolvedValueOnce(seed.seed);
      try {
        const response = await callPost({
          agent: 'claude', model: 'sonnet', account: 'default',
          owner_id: continueSourceOwner ? 'su-source-owner' : 'su-unprepared-answer',
          bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
          session_port_protocol: SESSION_PORT_PROTOCOL_VERSION,
          session_port_transform_version: SESSION_PORT_TRANSFORM_VERSION,
          session_port_token: `${SESSION_PORT_ID}.${'a'.repeat(64)}`,
        });
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(continueSourceOwner ? 200 : 409);
        if (continueSourceOwner) {
          expect(body.envelopeEnv.PAPERCUSP_SID).toBe('su-source-owner');
          expect(body.sessionPortKickoffFile).toBe('/managed/222.seed.md');
          expect(reserveSessionPortTargetMock).toHaveBeenCalledWith(expect.objectContaining({
            portId: SESSION_PORT_ID,
            target: expect.objectContaining({ agent: 'claude', coordOwnerId: 'su-source-owner' }),
          }));
          expect(recordSessionPortBootstrapReceiptMock).toHaveBeenCalledWith(expect.objectContaining({
            portId: SESSION_PORT_ID, targetAdvSessionId: 42,
          }));
        } else {
          expect(body.error).toMatch(/must continue source coordination identity/);
          expect(reserveSessionPortTargetMock).not.toHaveBeenCalled();
          expect(recordSessionPortBootstrapReceiptMock).not.toHaveBeenCalled();
        }
        expect(port.metadata.summary.source).toEqual(sourceIdentity);
        expect(port.metadata.sourceCoordOwnerId).toBe('su-source-owner');
        expect(recordAdvSessionMock).not.toHaveBeenCalled();
        expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
        expect(consumePendingCarryRespawnMock).not.toHaveBeenCalled();
      } finally {
        readSessionPortArtifactMock.mockReset().mockResolvedValue(SESSION_PORT_ARTIFACT.seed);
      }
    },
  );

  it('bootstraps a prepared isolated answer under its bound owner without touching source identity or authority', async () => {
    const port = sessionPortRow();
    port.metadata.summary.target = { ...port.metadata.summary.target, ownerId: 'su-answer-owner' } as typeof port.metadata.summary.target;
    getSessionPortMock.mockResolvedValueOnce(port);
    const res = await callPost({
      agent: 'codex', model: 'gpt-5.5', owner_id: 'su-answer-owner',
      bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
      session_port_protocol: SESSION_PORT_PROTOCOL_VERSION,
      session_port_transform_version: SESSION_PORT_TRANSFORM_VERSION,
      session_port_token: `${SESSION_PORT_ID}.${'a'.repeat(64)}`,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).envelopeEnv.PAPERCUSP_SID).toBe('su-answer-owner');
    expect(reserveSessionPortTargetMock).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ coordOwnerId: 'su-answer-owner' }),
    }));
    expect(resolveSessionStatesMock).toHaveBeenCalledWith([{ ownerId: 'su-answer-owner' }], { hydratePerId: true });
    expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
    expect(consumePendingCarryRespawnMock).not.toHaveBeenCalled();
    expect(setModeMock).not.toHaveBeenCalled();
    expect(port.metadata.sourceCoordOwnerId).toBe('su-source-owner');
  });

  it.each([
    { preparedAccount: 'auto', requestedAccount: 'auto', gatewayOn: true, status: 200 },
    { preparedAccount: 'default', requestedAccount: 'default', gatewayOn: true, status: 200 },
    { preparedAccount: 'aviynw6', requestedAccount: 'aviynw6', gatewayOn: true, status: 200 },
    { preparedAccount: 'auto', requestedAccount: 'default', gatewayOn: true, status: 409 },
    { preparedAccount: 'auto', requestedAccount: 'auto', gatewayOn: false, status: 409 },
    { preparedAccount: 'aviynw6', requestedAccount: 'auto', gatewayOn: true, status: 409 },
  ])('honors prepared Claude account $preparedAccount with requested $requestedAccount and gateway $gatewayOn', async ({
    preparedAccount, requestedAccount, gatewayOn, status,
  }) => {
    getFlagMock.mockResolvedValue(gatewayOn);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }] });
    const seed = renderSessionPortSeed({
      portId: SESSION_PORT_ID, sourceBackend: 'claude', targetBackend: 'claude',
      fidelity: 'full', transcript: 'ported history',
    });
    const port = sessionPortRow({ targetBackend: 'claude', targetModel: 'sonnet', renderedHash: seed.hash });
    port.metadata.summary.target = {
      ...port.metadata.summary.target, backend: 'claude', provider: 'anthropic', model: 'sonnet',
      account: preparedAccount, ownerId: 'su-answer-owner',
    } as typeof port.metadata.summary.target;
    getSessionPortMock.mockResolvedValueOnce(port);
    readSessionPortArtifactMock.mockResolvedValueOnce(seed.seed);
    try {
      const response = await callPost({
        agent: 'claude', model: 'sonnet', account: requestedAccount, owner_id: 'su-answer-owner',
        bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
        session_port_protocol: SESSION_PORT_PROTOCOL_VERSION,
        session_port_transform_version: SESSION_PORT_TRANSFORM_VERSION,
        session_port_token: `${SESSION_PORT_ID}.${'a'.repeat(64)}`,
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(status);
      expect(recordAdvSessionMock).not.toHaveBeenCalled();
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(setModeMock).not.toHaveBeenCalled();
      if (status === 200) {
        expect(body.envelopeEnv.PAPERCUSP_SID).toBe('su-answer-owner');
        expect(body.envelopeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe(
          preparedAccount === 'aviynw6' ? 'pin' : preparedAccount,
        );
        if (preparedAccount === 'auto') {
          expect(body.envelopeEnv.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
          expect(body.envelopeEnv.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
          expect(body.envelopeEnv.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('account');
        } else if (preparedAccount === 'aviynw6') {
          expect(body.envelopeEnv.PAPERCUSP_ACCOUNT_ID).toBe('aviynw6');
        }
        expect(reserveSessionPortTargetMock).toHaveBeenCalledWith(expect.objectContaining({
          target: expect.objectContaining({ agent: 'claude', coordOwnerId: 'su-answer-owner' }),
        }));
        expect(recordSessionPortBootstrapReceiptMock).toHaveBeenCalled();
      } else {
        expect(body.error).toMatch(gatewayOn ? /immutable prepared request/ : /gateway is off.*refusing to fall back/i);
        expect(reserveSessionPortTargetMock).not.toHaveBeenCalled();
        expect(recordSessionPortBootstrapReceiptMock).not.toHaveBeenCalled();
      }
    } finally {
      readSessionPortArtifactMock.mockReset().mockResolvedValue(SESSION_PORT_ARTIFACT.seed);
      getFlagMock.mockResolvedValue(false);
    }
  });

  it.each(['su-source-owner', 'su-unprepared-answer'])('refuses isolated bootstrap owner substitution %s before reservation', async (ownerId) => {
    const port = sessionPortRow();
    port.metadata.summary.target = { ...port.metadata.summary.target, ownerId: 'su-answer-owner' } as typeof port.metadata.summary.target;
    getSessionPortMock.mockResolvedValueOnce(port);
    const res = await callPost({
      agent: 'codex', model: 'gpt-5.5', owner_id: ownerId,
      bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
      session_port_protocol: SESSION_PORT_PROTOCOL_VERSION,
      session_port_transform_version: SESSION_PORT_TRANSFORM_VERSION,
      session_port_token: `${SESSION_PORT_ID}.${'a'.repeat(64)}`,
    });
    expect(res.status).toBe(409);
    expect(reserveSessionPortTargetMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('keeps an already-live isolated answer owner blocking without reclaiming it', async () => {
    const port = sessionPortRow();
    port.metadata.summary.target = { ...port.metadata.summary.target, ownerId: 'su-answer-owner' } as typeof port.metadata.summary.target;
    getSessionPortMock.mockResolvedValueOnce(port);
    dbState.advRows = [{ id: '777', display: 'terminal', has_session: true }];
    resolveSessionStatesMock.mockResolvedValueOnce(new Map([['su-answer-owner', { sessionState: 'live' }]]));
    try {
      const res = await callPost({
        agent: 'codex', model: 'gpt-5.5', owner_id: 'su-answer-owner',
        bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
        session_port_protocol: SESSION_PORT_PROTOCOL_VERSION,
        session_port_transform_version: SESSION_PORT_TRANSFORM_VERSION,
        session_port_token: `${SESSION_PORT_ID}.${'a'.repeat(64)}`,
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('already bound to live adv session 777') });
      expect(reserveSessionPortTargetMock).not.toHaveBeenCalled();
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
    } finally {
      dbState.advRows = [];
    }
  });

  it('refuses an old launcher missing the transform handshake before creating a target row', async () => {
    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.5',
      session_port_protocol: 1,
      session_port_token: `22222222-2222-4222-8222-222222222222.${'a'.repeat(64)}`,
    });
    expect(res.status).toBe(426);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('launch-wakeability: arms the standing inbox-wake at launch for the minted sid (parked before first turn)', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' })).json();
    const sid = json.envelopeEnv.PAPERCUSP_SID;
    expect(sid).toMatch(/^su-/);
    // The arm is the SAME owner id recorded as coord_owner_id, so the recorded-session
    // roster row (visible at launch) flips recorded → parked/wakeable immediately —
    // no dependence on the detached, lossy SessionStart lifecycle hook.
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ coordOwnerId: sid }));
    expect(armInboxWakeMock).toHaveBeenCalledWith(expect.objectContaining({ ownerId: sid, workspaceId: 'default' }));
  });

  it('launch-wakeability: an arm failure is best-effort and never fails the launch', async () => {
    armInboxWakeMock.mockRejectedValueOnce(new Error('pg down'));
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.envelopeEnv.PAPERCUSP_SID).toMatch(/^su-/);
  });

  it('EI-155: omp/codex get NO CLAUDE_CONFIG_DIR (codex isolates via CODEX_HOME; omp by its own store)', async () => {
    const omp = await (await callPost({ agent: 'omp', harness_slug: 'papercup', plan_slug: null })).json();
    expect(omp.envelopeEnv.CLAUDE_CONFIG_DIR).toBeUndefined();

    vi.clearAllMocks();
    recordAdvSessionMock.mockResolvedValue(42);
    const codex = await (await callPost({ agent: 'codex', harness_slug: null, plan_slug: null })).json();
    expect(codex.envelopeEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(writeInteractiveClaudeConfigMock).not.toHaveBeenCalled();
  });

  it('EI-155: a materialize failure is non-fatal — the launch still succeeds without CLAUDE_CONFIG_DIR', async () => {
    writeInteractiveClaudeConfigMock.mockImplementationOnce(() => {
      throw new Error('symlink EACCES');
    });
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.envelopeEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
    // The session still has its identity + native id — only transcript isolation degraded.
    expect(json.envelopeEnv.PAPERCUSP_SID).toMatch(/^su-/);
    expect(json.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  // WI-10006674: the supervisor beat never mints a presence row (D-003), so a harness-less
  // session (a workspace-level su; every consult/headless --fork) that never completes a
  // first turn used to park with a live host and NO row — coord:presence reported it
  // absent. Bootstrap now mints the row for it too, before turn 1.
  it('WI-10006674: a harness-less launch still gets a presence row before turn 1', async () => {
    getPresenceMock.mockResolvedValueOnce(null);
    const json = await (
      await callPost({ agent: 'claude', harness_slug: null, plan_slug: null, label: 'consult fork' })
    ).json();
    const sid = json.envelopeEnv.PAPERCUSP_SID;
    expect(writePresenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: sid, ownerLabel: 'consult fork', source: 'omp-hook-session' }),
      { agentRole: 'su' },
      null,
    );
    expect(recordAdvSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
      writePresenceMock.mock.invocationCallOrder[0],
    );
  });

  it('WI-10006674: a harness-less stamp never overwrites an existing row (create-if-absent)', async () => {
    const { stampPresenceAtBoot } = await import('../routes/agent-mcp/bootstrap-su');
    // A carry-respawn re-POSTs bootstrap with the same ownerId: the live row holds the
    // session's declared intent/plan, which store.write() would overwrite.
    getPresenceMock.mockResolvedValueOnce({ ownerId: 'su-respawned', intent: 'WI-1: live lane' });
    await expect(stampPresenceAtBoot({ workspaceId: 'default', ownerId: 'su-respawned', harnessSlug: null }))
      .resolves.toBeNull();
    expect(getPresenceMock).toHaveBeenCalledWith('su-respawned');
    expect(writePresenceMock).not.toHaveBeenCalled();

    // No row yet → the stamp mints it, with a null harness.
    getPresenceMock.mockResolvedValueOnce(null);
    await expect(stampPresenceAtBoot({ workspaceId: 'default', ownerId: 'su-fresh', harnessSlug: null }))
      .resolves.toBeNull();
    expect(writePresenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-fresh' }),
      { agentRole: 'su' },
      null,
    );
  });

  it('WI-10006674: a harnessed stamp still writes unconditionally (pot_slug refresh)', async () => {
    const { stampPresenceAtBoot } = await import('../routes/agent-mcp/bootstrap-su');
    getPresenceMock.mockResolvedValue({ ownerId: 'su-harnessed' });
    try {
      await stampPresenceAtBoot({ workspaceId: 'default', ownerId: 'su-harnessed', harnessSlug: 'papercup' });
      expect(writePresenceMock).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'su-harnessed' }),
        { agentRole: 'su' },
        'papercup',
      );
    } finally {
      getPresenceMock.mockReset().mockResolvedValue(null);
    }
  });

  it('no harness + no plan → playbook prompt still written; spec gets nulls', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: null, plan_slug: null, cwd: '/home/me' });
    const json = await res.json();
    expect(json.promptFile).toMatch(/session-42\.md$/);
    expect(json.instructionLint).toMatchObject({ markerCount: 0, clean: true });
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: null, planSlug: null }));
  });

  it('refuses a compiled prompt with contradictory file-lock modes', async () => {
    const base = await buildLaunchSpecMock({ harnessSlug: null });
    buildLaunchSpecMock.mockResolvedValueOnce({
      ...base,
      promptText: [
        'File-lock enforcement is **NOT automatic on Codex**.',
        '<!-- papercusp-rule:file-locking=automatic-hooks -->',
        'managed hooks claim/release file locks automatically',
      ].join('\n'),
    });
    const res = await callPost({ agent: 'codex', harness_slug: null, plan_slug: null });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      status: 'error',
      error: expect.stringMatching(/contradictory file-lock modes/i),
      instructionLint: { conflicts: [expect.objectContaining({ key: 'file-locking' })] },
    });
    expect(writeSuCodexHomeMock).not.toHaveBeenCalled();
  });

  it('refuses a compiled prompt that resurrects unconditional post-compaction recovery-orient', async () => {
    const base = await buildLaunchSpecMock({ harnessSlug: null });
    buildLaunchSpecMock.mockResolvedValueOnce({
      ...base,
      promptText: 'Fresh context. First re-run coord:orient { afterCompaction: true }, then continue.',
    });
    const res = await callPost({ agent: 'claude', harness_slug: null, plan_slug: null });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      status: 'error',
      error: expect.stringMatching(/blocking instruction-contract violation/i),
      instructionLint: {
        unconditionalPostCompactionRecovery: [expect.objectContaining({ pattern: 'first-orient' })],
      },
    });
  });

  it('omp: raw-CLI result (no wrapperBin), No-plan row + mode omp', async () => {
    const res = await callPost({ agent: 'omp', harness_slug: 'papercup', plan_slug: null });
    const json = await res.json();
    expect(json.planSlug).toBeNull();
    expect(json.wrapperBin).toBeUndefined();
    expect(json.codexHome).toBeNull();
    expect(json.coordExtPath).toBe(COORD_EXT);
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: null, agent: 'omp', mode: 'omp' }),
    );
  });

  it('refuses direct/default Codex before session creation when native auth is absent', async () => {
    const homeWithoutAuth = mkdtempSync(join(tmpdir(), 'bootstrap-su-no-auth-'));
    vi.stubEnv('HOME', homeWithoutAuth);
    vi.stubEnv('OPENAI_API_KEY', '');
    try {
      const res = await callPost({ agent: 'codex', account: 'default', harness_slug: null, plan_slug: null });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        status: 'error',
        code: 'codex_native_auth_missing',
        error: expect.stringContaining('~/.codex/auth.json'),
      });
      expect(recordAdvSessionMock).not.toHaveBeenCalled();
      expect(reserveSessionPortTargetMock).not.toHaveBeenCalled();
      expect(armInboxWakeMock).not.toHaveBeenCalled();
      expect(writeSuCodexHomeMock).not.toHaveBeenCalled();
    } finally {
      rmSync(homeWithoutAuth, { recursive: true, force: true });
    }
  });

  it('keeps Codex gateway auto working without a local native credential', async () => {
    const homeWithoutAuth = mkdtempSync(join(tmpdir(), 'bootstrap-su-no-auth-'));
    const originalFlag = getFlagMock.getMockImplementation()!;
    const originalPool = loadAccountPoolMock.getMockImplementation()!;
    vi.stubEnv('HOME', homeWithoutAuth);
    vi.stubEnv('OPENAI_API_KEY', '');
    getFlagMock.mockImplementation(async (key: string) => key === 'papercusp-inference-gateway');
    loadAccountPoolMock.mockResolvedValueOnce({ accounts: [{ id: 'codex-main', provider: 'codex' }] });
    try {
      const res = await callPost({ agent: 'codex', account: 'auto', harness_slug: null, plan_slug: null });
      expect(res.status).toBe(200);
      expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex' }));
      expect(writeSuCodexHomeMock).toHaveBeenCalledWith(expect.objectContaining({
        codexGatewayAuto: true,
        codexGatewayAccountId: null,
      }));
    } finally {
      getFlagMock.mockImplementation(originalFlag);
      loadAccountPoolMock.mockImplementation(originalPool);
      rmSync(homeWithoutAuth, { recursive: true, force: true });
    }
  });

  it('codex → per-session CODEX_HOME (writeSuCodexHome) + CODEX_HOME env; workspace cwd', async () => {
    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.6-terra:xhigh',
      harness_slug: null,
      plan_slug: null,
    });
    const json = await res.json();
    expect(json.cwd).toBe('/workspace');
    expect(json.codexHome).toMatch(/su-codex-homes\/session-42$/);
    expect(json.envelopeEnv.CODEX_HOME).toBe(json.codexHome);
    expect(json.promptFile).toMatch(/AGENTS\.md$/);
    // The async writer now owns the guard and receives the live-host probe.
    // Its real guard behavior is verified in role-codex-home's own suite.
    // writeSuCodexHome gets the spec's prompt + url + the minted sid.
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        promptText: expect.stringContaining('⟦INSTRUCTION-PRECEDENCE⟧'),
        sessionKey: 42,
        isOwnerLive: expect.any(Function),
        mcpUrl: 'http://localhost:3070/api/mcp?superuser=1&workspace=default',
        sid: expect.stringMatching(/^su-/),
        model: 'gpt-5.6-terra:xhigh',
        token: 'TESTBEARER',
        instructionRuntime: expect.objectContaining({
          source: 'bootstrap-su',
          route: { kind: 'self' },
        }),
      }),
    );
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', mode: 'console' }));
  });

  it('uses the validated Codex MCP base for buildLaunchSpec while the envelope keeps request origin', async () => {
    const selectedMcpBase = 'http://127.0.0.1:9071';
    const { buildConsoleEnvelope } = await import('../../console-launcher');
    vi.mocked(buildConsoleEnvelope).mockClear();
    buildLaunchSpecMock.mockClear();

    const res = await callPost({
      agent: 'codex',
      harness_slug: null,
      plan_slug: null,
      mcp_base_url: selectedMcpBase,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({ operatorBaseUrl: selectedMcpBase }),
    );
    expect(buildConsoleEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ operatorBaseUrl: 'http://localhost:3070' }),
    );
    expect(json.envelopeEnv.PAPERCUSP_OPERATOR_URL).toBe('http://localhost:3070');
  });

  it('rejects an untrusted Codex MCP base before it can create a session', async () => {
    buildLaunchSpecMock.mockClear();
    recordAdvSessionMock.mockClear();
    writeSuCodexHomeMock.mockClear();

    const res = await callPost({
      agent: 'codex',
      harness_slug: null,
      plan_slug: null,
      mcp_base_url: 'https://outside.example',
    });
    expect(res.status).toBe(400);
    expect(buildLaunchSpecMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(writeSuCodexHomeMock).not.toHaveBeenCalled();
  });

  it('uses the configured Sol xhigh default only for a visible Codex bootstrap', async () => {
    const res = await callPost({ agent: 'codex', harness_slug: null, plan_slug: null });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.envelopeEnv.PAPERCUSP_MODEL_SOURCE).toBe('configured-default');
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-6.1-sol:xhigh' }),
    );
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        launchArgv: expect.arrayContaining([
          '--model=gpt-6.1-sol:xhigh',
          '--model-source=configured-default',
        ]),
      }),
    );
  });

  it.each([
    { supplied: {}, model: 'gpt-5.6-terra:xhigh', source: 'inherited' },
    { supplied: { model: 'gpt-5.6-sol:xhigh', model_source: 'configured-default' }, model: 'gpt-5.6-terra:xhigh', source: 'inherited' },
    { supplied: { model: 'gpt-5.6-sol:xhigh', model_source: 'explicit' }, model: 'gpt-5.6-sol:xhigh', source: 'explicit' },
  ])('uses the selected identity model default before native configuration: $source $supplied', async ({ supplied, model, source }) => {
    resolveLaunchIdentityModelDefaultMock.mockResolvedValueOnce('gpt-5.6-terra:xhigh');
    const res = await callPost({ agent: 'codex', headless: true,
      stack: ['domain:research-steward'], ...supplied });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model, modelSource: source });
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(expect.objectContaining({ model }));
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ model }));
    expect(compileLaunchSpecificationArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedModelDefault: 'gpt-5.6-terra:xhigh' }));
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      launchArgv: expect.arrayContaining([`--model=${model}`, `--model-source=${source}`]),
    }));
  });

  it('refuses unavailable identity model defaults before native session effects', async () => {
    resolveLaunchIdentityModelDefaultMock.mockRejectedValueOnce(new Error('selected source unavailable'));
    const res = await callPost({ agent: 'codex', stack: ['domain:missing'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'identity_model_default_denied' });
    expect(writeSuCodexHomeMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('carries a RefusalContract on identity_model_default_denied naming the harness, role and stack', async () => {
    resolveLaunchIdentityModelDefaultMock.mockRejectedValueOnce(new Error('unknown stack ref domain:nope'));
    const res = await callPost({ agent: 'codex', harness_slug: 'papercup', su_role: 'planner',
      stack: ['domain:nope', 'client:x'] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'identity_model_default_denied', error: 'unknown stack ref domain:nope' });
    expect(body.refusal.observed).toEqual({ harness: 'papercup', role: 'planner', stack: 'domain:nope,client:x' });
    expect(body.refusal.liftsWhen).toMatch(/stack ref/);
    expect(body.refusal.whoCanMakeItTrue).toEqual(['self', 'owner']);
    expect(writeSuCodexHomeMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('names a null harness, the default su role and a null stack when the launch supplied none', async () => {
    resolveLaunchIdentityModelDefaultMock.mockRejectedValueOnce(new Error('selected source unavailable'));
    const res = await callPost({ agent: 'codex' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.refusal.observed).toEqual({ harness: null, role: 'su', stack: null });
  });

  it('fails closed before session/home creation when an unattended Codex bootstrap has no model authority', async () => {
    for (const body of [
      { agent: 'codex', headless: true },
      { agent: 'codex', launch_argv: ['psu', '--no-picker', '--agent=codex'] },
      { agent: 'codex', launch_argv: ['psu', '--no-picker', '--agent=codex', '--headless'] },
    ]) {
      vi.clearAllMocks();
      recordAdvSessionMock.mockResolvedValue(42);
      const res = await callPost(body);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: 'missing_model' });
      expect(writeSuCodexHomeMock).not.toHaveBeenCalled();
      expect(recordAdvSessionMock).not.toHaveBeenCalled();
    }
  });

  it('honors explicit configured-default authority for a no-picker Codex bootstrap', async () => {
    const res = await callPost({
      agent: 'codex',
      model_source: 'configured-default',
      launch_argv: ['psu', '--no-picker', '--agent=codex', '--model-source=configured-default'],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.envelopeEnv.PAPERCUSP_MODEL_SOURCE).toBe('configured-default');
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-6.1-sol:xhigh' }),
    );
  });

  it('codex folds launch_context into AGENTS.md prompt text before writing CODEX_HOME', async () => {
    const kickoff = join(LC_DIR, 'kickoff.md');
    writeFileSync(kickoff, 'KICKOFF CONTEXT\n- continue the rollout\n');
    const res = await callPost({
      agent: 'codex',
      harness_slug: 'papercup',
      plan_slug: 'my-plan',
      launch_context: kickoff,
    });
    expect(res.status).toBe(200);
    // The composer may place the cache-split boundary (PSU_CACHE_BOUNDARY, role-launch-spec)
    // between the stable playbook and the per-launch context; the folded order is the contract.
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        promptText: expect.stringMatching(
          /PLAYBOOK \+ CTX BODY\n\n(?:<!--PSU_CACHE_BOUNDARY-->\n\n)?---\n## Launch Context\n\nKICKOFF CONTEXT\n- continue the rollout/,
        ),
      }),
    );
  });

  it('claude prompt-file delivery and codex AGENTS.md delivery start from the same assembled launch spec', async () => {
    const claude = await (await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' })).json();
    const claudePrompt = readFileSync(claude.promptFile, 'utf8');
    expect(claudePrompt).toContain('PLAYBOOK + CTX BODY');
    expect(claudePrompt).toContain('⟦INSTRUCTION-PRECEDENCE⟧');

    vi.clearAllMocks();
    recordAdvSessionMock.mockResolvedValue(43);
    const codex = await callPost({ agent: 'codex', harness_slug: 'papercup', plan_slug: 'my-plan' });
    expect(codex.status).toBe(200);
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ promptText: expect.stringContaining('⟦INSTRUCTION-PRECEDENCE⟧') }),
    );
  });

  it('claude: mints + records + returns a native session id (the launcher forces it via --session-id)', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    expect(json.nativeSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // Recorded on the adv row so `psu --resume <native-uuid>` can correlate it.
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', sessionId: json.nativeSessionId }),
    );
  });

  it('omp/codex: no forced native session id (resume via thread id / CODEX_HOME)', async () => {
    const omp = await (await callPost({ agent: 'omp', harness_slug: 'papercup', plan_slug: null })).json();
    expect(omp.nativeSessionId).toBeNull();
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'omp', sessionId: null }));

    vi.clearAllMocks();
    recordAdvSessionMock.mockResolvedValue(42);
    const codex = await (await callPost({ agent: 'codex', harness_slug: null, plan_slug: null })).json();
    expect(codex.nativeSessionId).toBeNull();
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', sessionId: null }));
  });

  it('retired brain launches are rejected before recording a session', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: null, plan_slug: null, brain: true });
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/deprecated/);
    expect(setBrainSessionMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('D-013: non-brain launches never touch the pin', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null });
    expect(res.status).toBe(200);
    expect(setBrainSessionMock).not.toHaveBeenCalled();
  });

  it('retired GET /brain returns a 410 tombstone', async () => {
    const res = await callBrainGet();
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/deprecated/);
    expect(getBrainSessionMock).not.toHaveBeenCalled();
  });

  it('P-002: a non-brain launch succeeds with the flag ON (and computes no brief)', async () => {
    getFlagMock.mockResolvedValue(true);
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null });
    expect(res.status).toBe(200);
    // The "computes no brief" half is STRUCTURAL since P-059 retired the brief
    // builder — there is no longer a function this path could call. The former
    // `not.toHaveBeenCalled()` guard is dropped rather than rewritten: it named
    // a symbol the module had already stopped exporting, so it passed whether or
    // not the route behaved.
  });

  it('rejects an unknown agent kind', async () => {
    const res = await callPost({ agent: 'gemini', harness_slug: 'papercup' });
    expect(res.status).toBe(400);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(buildLaunchSpecMock).not.toHaveBeenCalled();
  });

  it('P-023: threads --profile=power through to buildLaunchSpec', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', profile: 'power' });
    expect(res.status).toBe(200);
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ profile: 'power' }));
  });

  it('P-023: rejects an invalid profile (no silent fallback)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', profile: 'wizard' });
    expect(res.status).toBe(400);
    expect(buildLaunchSpecMock).not.toHaveBeenCalled();
  });

  it('P-025: accepts the generic profile (non-coding work hive) and threads it through', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', profile: 'generic' });
    expect(res.status).toBe(200);
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ profile: 'generic' }));
  });

  it('refuses a selected identity source that changed after the picker choice', async () => {
    const revision = 'a'.repeat(64);
    const selection = { agent: 'claude', stack: ['domain:research-steward'],
      selected_identity_revision: revision };
    const missing = await callPost({ ...selection, selected_identity_revision: 'not-a-hash' });
    expect(missing.status).toBe(400);
    compileLaunchSpecificationArtifactMock.mockImplementationOnce(async (input: any) => ({
      promptText: input.promptText, stack: input.stack ?? [],
      specificationArtifact: { inputs: [] },
      specificationRevision: 'b'.repeat(64), stateRevision: input.stateRevision ?? 'c'.repeat(64),
      compositionSource: 'compatibility', resourceArtifacts: [],
    }));
    const stale = await callPost(selection);
    expect(stale.status).toBe(500);
    expect((await stale.json()).error).toContain('source revision changed after picker selection');
    compileLaunchSpecificationArtifactMock.mockImplementationOnce(async (input: any) => ({
      promptText: input.promptText, stack: input.stack ?? [],
      specificationArtifact: { inputs: [{ kind: 'blueprint-layer', ref: 'research-steward',
        contentHash: revision }] },
      specificationRevision: 'b'.repeat(64), stateRevision: input.stateRevision ?? 'c'.repeat(64),
      compositionSource: 'compatibility', resourceArtifacts: [],
    }));
    const exact = await callPost(selection);
    expect(exact.status).toBe(200);
    const { recordSuLaunchSpec } = await import('../../adv-sessions');
    expect(recordSuLaunchSpec).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ selectedIdentity: {
        ref: 'domain:research-steward', sourceRevision: revision,
      } }));
  });

  it('persists the exact launch-envelope provenance directory for indexed ingestion', async () => {
    const { buildConsoleEnvelope } = await import('../../console-launcher');
    const envelopeMock = vi.mocked(buildConsoleEnvelope);
    const original = envelopeMock.getMockImplementation()!;
    const dir = '/scoped/selected-workspace/turn-provenance';
    envelopeMock.mockImplementationOnce(async opts => {
      const result = await original(opts);
      return { ...result, env: { ...result.env, PAPERCUSP_TURN_PROVENANCE_DIR: dir } };
    });
    const response = await callPost({ agent: 'codex' });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.envelopeEnv.PAPERCUSP_TURN_PROVENANCE_DIR).toBe(dir);
    const { recordSuLaunchSpec } = await import('../../adv-sessions');
    expect(recordSuLaunchSpec).toHaveBeenCalledWith(expect.anything(), result.envelopeEnv.PAPERCUSP_SID,
      expect.objectContaining({ turnProvenanceDir: dir, workspaceId: result.workspaceId }));
  });

  it('pins the default provenance directory when the launch envelope omits it', async () => {
    const { buildConsoleEnvelope } = await import('../../console-launcher');
    const envelopeMock = vi.mocked(buildConsoleEnvelope);
    const original = envelopeMock.getMockImplementation()!;
    envelopeMock.mockImplementationOnce(async opts => {
      const result = await original(opts);
      const env = { ...result.env };
      delete env.PAPERCUSP_TURN_PROVENANCE_DIR;
      return { ...result, env };
    });

    const response = await callPost({ agent: 'codex' });
    expect(response.status).toBe(200);
    const result = await response.json();
    const { recordSuLaunchSpec } = await import('../../adv-sessions');
    const { turnProvenanceDir } = await import('../../turn-provenance/turn-provenance');
    expect(recordSuLaunchSpec).toHaveBeenCalledWith(
      expect.anything(), result.envelopeEnv.PAPERCUSP_SID,
      expect.objectContaining({ turnProvenanceDir: turnProvenanceDir(result.envelopeEnv), workspaceId: result.workspaceId }),
    );
  });

  it('pins every component of a selected named composition at bootstrap', async () => {
    const { resolveNamedIdentityCompositionSelection } = await import('../../agent-identities/source');
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-named-composition-'));
    try {
      const componentDir = join(dir, '.papercusp', 'blueprints', 'named-route-domain');
      const rootDir = join(dir, '.papercusp', 'blueprints', 'named-route-root');
      mkdirSync(componentDir, { recursive: true });
      mkdirSync(rootDir, { recursive: true });
      mkdirSync(join(componentDir, 'prompts'), { recursive: true });
      writeFileSync(join(componentDir, 'prompts', 'domain.md'), 'Named route domain fixture.');
      const componentPath = join(componentDir, 'blueprint.yaml');
      writeFileSync(componentPath,
        'id: named-route-domain\nextends: base\nversion: 1.0.0\nslots:\n  - slot: domain\n');
      writeFileSync(join(rootDir, 'blueprint.yaml'),
        'id: named-route-root\nextends: named-route-domain\nslots: []\nroles:\n  - id: su\n    stack:\n      - domain:named-route-domain\n');
      const selected = await resolveNamedIdentityCompositionSelection('named-route-root', dir);
      const originalBuild = buildLaunchSpecMock.getMockImplementation()!;
      const selection = { agent: 'claude', cwd: dir, stack: ['composition:named-route-root'],
        selected_identity_revision: selected.sourceRevision };
      const run = async () => {
        buildLaunchSpecMock.mockImplementationOnce(async (input: any) => ({
          ...await originalBuild(input), cwd: dir, stack: selected.stack,
        }));
        compileLaunchSpecificationArtifactMock.mockImplementationOnce(async (input: any) => ({
          promptText: input.promptText, stack: input.stack,
          specificationArtifact: { inputs: selected.layers.map((layer) => ({
            kind: 'blueprint-layer', ref: layer.id, contentHash: layer.contentHash,
          })) },
          specificationRevision: 'b'.repeat(64),
          stateRevision: input.stateRevision ?? 'c'.repeat(64),
          compositionSource: 'compatibility', resourceArtifacts: [],
        }));
        return callPost(selection);
      };
      const exact = await run();
      expect(exact.status, JSON.stringify(await exact.clone().json())).toBe(200);
      expect(compileLaunchSpecificationArtifactMock).toHaveBeenCalledWith(
        expect.objectContaining({ compositionRootId: 'named-route-root', stack: selected.stack }));
      writeFileSync(componentPath,
        'id: named-route-domain\nextends: base\nversion: 1.0.1\nslots:\n  - slot: domain\n');
      const changed = await run();
      expect(changed.status).toBe(500);
      expect((await changed.json()).error).toContain('source revision changed after picker selection');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('options (no harness) lists the active-workspace harnesses', async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.workspace).toBe('default');
    expect(json.harnesses).toEqual([{ slug: 'papercup', path: '/repo', status: 'active' }]);
    expect(json.ompCatalog).toMatchObject({
      status: 'available',
      source: 'omp models --json',
      availability: 'enabled-configured',
      credentials: 'unchecked',
      upstream: 'unchecked',
    });
    expect(json.ompCatalog.models[0].selector).toBe('openai-codex/gpt-5.6-terra');
  });

  it('options keeps the launcher usable while reporting an unavailable OMP catalog', async () => {
    readOmpModelCatalogMock.mockRejectedValueOnce(new Error('omp registry unavailable'));
    const res = await callGet();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.harnesses).toHaveLength(1);
    expect(json.ompCatalog).toEqual({
      status: 'unavailable',
      source: 'omp models --json',
      availability: 'unknown',
      credentials: 'unchecked',
      upstream: 'unchecked',
      models: [],
      error: 'omp registry unavailable',
    });
  });

  it('options sections keep harness menus independent of stalled account/model reads', async () => {
    const originalFlag = getFlagMock.getMockImplementation()!;
    const originalCatalog = readOmpModelCatalogMock.getMockImplementation()!;
    const originalPool = loadAccountPoolMock.getMockImplementation()!;
    getFlagMock.mockResolvedValueOnce(true);
    readOmpModelCatalogMock.mockImplementationOnce(() => new Promise(() => {}));
    loadAccountPoolMock.mockImplementationOnce(() => new Promise(() => {}));
    try {
      const res = await callGet('?include=workspaces,harnesses,fleets');
      expect(res.status).toBe(200);
      const page = await res.json();
      expect(page.harnesses).toEqual([{ slug: 'papercup', path: '/repo', status: 'active' }]);
      expect(page.workspaces).toHaveLength(2);
      expect(page.fleets).toEqual([]);
      expect(page).not.toHaveProperty('accounts');
      expect(page).not.toHaveProperty('ompCatalog');
      expect(page).not.toHaveProperty('roles');
      expect(readOmpModelCatalogMock).not.toHaveBeenCalled();
      expect(loadAccountPoolMock).not.toHaveBeenCalled();
      expect(getFlagMock).not.toHaveBeenCalled();
      expect(listFleetsMock).toHaveBeenCalledTimes(1);
    } finally {
      // These deliberately stalled mocks must not leak to another test.
      getFlagMock.mockReset().mockImplementation(originalFlag);
      readOmpModelCatalogMock.mockReset().mockImplementation(originalCatalog);
      loadAccountPoolMock.mockReset().mockImplementation(originalPool);
    }
  });

  it('options account reads retain provider filtering and skip unrelated menu stores', async () => {
    getFlagMock.mockResolvedValueOnce(true);
    loadAccountPoolMock.mockResolvedValueOnce({ accounts: [
      { id: 'claude-account', provider: 'claude' }, { id: 'codex-account', provider: 'codex' },
    ] });
    const res = await callGet('?include=accounts&workspace=ws2&agent=codex');
    expect(res.status).toBe(200);
    const page = await res.json();
    expect(page.accounts).toMatchObject({ provider: 'codex', pool: ['codex-account'] });
    expect(loadAccountPoolMock).toHaveBeenCalledWith('ws2');
    expect(page).not.toHaveProperty('harnesses');
    expect(page).not.toHaveProperty('fleets');
    expect(readOmpModelCatalogMock).not.toHaveBeenCalled();
    expect(listFleetsMock).not.toHaveBeenCalled();
  });

  it('options rejects unknown sections before loading picker data', async () => {
    const res = await callGet('?include=unknown');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unknown launch-options section');
    expect(readOmpModelCatalogMock).not.toHaveBeenCalled();
    expect(loadAccountPoolMock).not.toHaveBeenCalled();
    expect(listFleetsMock).not.toHaveBeenCalled();
  });

  it('options?harness lists non-archived plan slugs', async () => {
    const res = await callGet('?harness=papercup');
    const json = await res.json();
    expect(json.harness).toBe('papercup');
    expect(json.plans).toEqual([{ slug: 'plan-a' }]);
  });

  it('options?identities pages the source catalog and retains invalid-entry reasons', async () => {
    const first = await (await callGet('?identities=1&limit=1')).json();
    expect(first.status, JSON.stringify(first)).toBe('ok');
    expect(first.scanned).toBe(1);
    expect(first.nextAfter).toEqual(expect.any(String));
    expect(first.identities).toEqual(expect.any(Array));
    expect(first.unreadable).toEqual(expect.any(Array));
    const second = await (await callGet(`?identities=1&limit=1&after=${encodeURIComponent(first.nextAfter)}`)).json();
    expect(second.status).toBe('ok');
    expect(second.scanned).toBe(1);
    expect(second.nextAfter).not.toBe(first.nextAfter);
  });

  it('options lists workspaces + the active one', async () => {
    const json = await (await callGet()).json();
    expect(json.activeWorkspace).toBe('default');
    expect(json.workspaces).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'ws2', name: 'Second' },
    ]);
  });

  it('threads an explicit workspace to the session + result', async () => {
    const res = await callPost({ agent: 'claude', workspace: 'ws2', harness_slug: 'papercup' });
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.workspaceId).toBe('ws2');
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws2' }));
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws2' }));
  });

  it('rejects an unknown workspace (no session)', async () => {
    const res = await callPost({ agent: 'claude', workspace: 'nope', harness_slug: 'papercup' });
    expect(res.status).toBe(400);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it("WI-3234: accepts the literal 'default' fallback workspace even when the registry hasn't listed it", async () => {
    // Fresh packaged install: activeWorkspaceId() → 'default' (the sentinel), and the
    // /options endpoint hands the launcher `activeWorkspace: 'default'`, which it forwards
    // explicitly. workspaceById('default') is undefined on a sparse registry, so the old
    // raw-workspaceById validation 400'd `unknown workspace: default` — the "psu: unknown
    // workspace: default" the owner hit — even though nothing was wrong. isKnownWorkspace
    // treats 'default' as always-valid, so the launch proceeds.
    const res = await callPost({ agent: 'claude', workspace: 'default', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.workspaceId).toBe('default');
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'default' }));
  });

  it('no-harness launch uses the caller cwd (resume-friendly), not the internal dir', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: null, cwd: '/home/me/work' });
    const json = await res.json();
    expect(json.cwd).toBe('/home/me/work');
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/home/me/work' }));
  });

  it('harness launch ignores the caller cwd (uses the harness repo)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', cwd: '/home/me/work' });
    const json = await res.json();
    expect(json.cwd).toBe('/proj/papercup');
  });

  it('EI-202: a no-harness launch whose caller cwd is $HOME is relocated off $HOME (prompt-isolation leak)', async () => {
    // At $HOME the cwd-level CLAUDE.md / .claude/CLAUDE.md ARE the owner's personal
    // config, which Claude auto-loads as PROJECT memory — bypassing the per-session
    // CLAUDE_CONFIG_DIR skip-link (P-002). The launch must NOT run in $HOME; it
    // relocates to the internal workspace root (the mocked envelope cwd, '/workspace').
    const res = await callPost({ agent: 'claude', harness_slug: null, cwd: homedir() });
    const json = await res.json();
    expect(json.cwd).not.toBe(homedir());
    expect(json.cwd).toBe('/workspace');
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace' }));
  });
});

describe('resolveAccountPin (psu-account-chooser P-002)', () => {
  it('refuses a credential with a confirmed native auth failure for both pin and auto routing', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'bad', credentialFailure: { observedAt: 1, ownerId: 'su-failed' } }] });
    const requested = await pin('bad');
    expect(requested.error).toContain('confirmed provider authentication failure');
    expect(requested.env).toEqual({});
    const automatic = await pin('auto');
    expect(automatic.error).toContain('no allowed claude account');
  });

  beforeEach(() => {
    getFlagMock.mockResolvedValue(false);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }, { id: 'aviynw2' }] });
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [] });
    readDefaultAccountIdMock.mockResolvedValue(undefined);
  });
  const pin = async (
    requested: string | null,
    agent: 'claude' | 'omp' | 'codex' = 'claude',
    model?: string,
  ) => (await import('../routes/agent-mcp/bootstrap-su')).resolveAccountPin(
    'default', requested, agent, undefined, false, model,
  );

  it('no account → explicit Claude default-route marker, no notice', async () => {
    const expected = { PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' };
    expect(await pin(null)).toMatchObject({ env: expected, notice: null, accountId: null, provider: null });
    expect(await pin('   ')).toMatchObject({ env: expected, notice: null, accountId: null, provider: null });
  });

  it('gateway off → explicit pin fails closed instead of using the default login', async () => {
    getFlagMock.mockResolvedValue(false);
    const r = await pin('aviynw6');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/gateway is off/i);
    expect(r.error).toMatch(/refusing to fall back to the default system login/i);
  });

  it('OMP account pinning routes through the gateway (D-006): the account-id signal, not the claude ANTHROPIC_BASE_URL env', async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('aviynw6', 'omp');
    // omp consumes PAPERCUSP_ACCOUNT_ID via its per-session models.yml — it must NOT
    // get the claude-CLI gatewaySpawnEnv (ANTHROPIC_BASE_URL/ANTHROPIC_CUSTOM_HEADERS).
    expect(r.env).toMatchObject({
      PAPERCUSP_ACCOUNT_ID: 'aviynw6',
      PAPERCUSP_OMP_MODEL_SELECTOR: 'papercusp-gateway/claude-sonnet-4-6',
    });
    expect(r.env.PAPERCUSP_OMP_MODELS_YML).toContain('"x-papercusp-account": "aviynw6"');
    expect(r.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(r.accountId).toBe('aviynw6');
    expect(r.provider).toBe('claude');
    expect(r.notice).toMatch(/OMP routed through the inference gateway/i);
    expect(loadAccountPoolMock).toHaveBeenCalled();
  });

  it('unknown account (not in pool) → fails closed', async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('not-a-real-acct');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/not in the account pool/i);
  });

  it('account excluded by session-override → fails closed', async () => {
    getFlagMock.mockResolvedValue(true);
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: [], excludeAccounts: ['aviynw6'] });
    const r = await pin('aviynw6');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/exclude list/i);
  });

  it('account outside forcedAccounts allow-list → fails closed', async () => {
    getFlagMock.mockResolvedValue(true);
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: ['aviynw2'], excludeAccounts: [] });
    const r = await pin('aviynw6');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/allow-list/i);
  });

  it('valid + allowed + gateway on → gateway env pin + PAPERCUSP_ACCOUNT_ID + confirm notice', async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('aviynw6');
    expect(r.env.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
    expect(r.env.ANTHROPIC_CUSTOM_HEADERS).toContain('aviynw6');
    expect(r.env.PAPERCUSP_ACCOUNT_ID).toBe('aviynw6');
    expect(r.notice).toMatch(/pinned to account aviynw6/i);
  });

  // account-routing-3-options (owner, 2026-06-30): the ONE `account` value carries 3 explicit modes.
  it("explicit 'default'/'none'/'system' → skip the gateway entirely, even when it is ON", async () => {
    getFlagMock.mockResolvedValue(true); // gateway ON — `default` must STILL skip it (the system-account escape hatch)
    for (const kw of ['default', 'none', 'system', 'DEFAULT', ' System ']) {
      const r = await pin(kw);
      expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' });
      expect(r.accountId).toBeNull();
      expect(r.notice).toMatch(/default system account.*inference gateway skipped/i);
    }
    // The pool is never consulted for a `default` route.
    expect(loadAccountPoolMock).not.toHaveBeenCalled();
  });

  it("'auto' (claude, gateway on) → gateway-routed with NO account pin (it auto-selects + fails over)", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('auto');
    expect(r.env.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
    // CRUCIALLY no account pin → the gateway active()/drain-selects + fails over (vs a hard pin).
    expect(r.env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('account');
    expect(r.env.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
    expect(r.accountId).toBeNull();
    expect(r.provider).toBe('claude');
    expect(r.gatewayAuto).toBe(true);
    expect(r.notice).toMatch(/auto.*selects an available pool account and fails over/i);
    // Auto remains unpinned, but the pool is validated so a missing provider
    // cannot silently degrade to the default system login.
    expect(loadAccountPoolMock).toHaveBeenCalledWith('default');
  });

  it("'gateway' is an alias for 'auto'", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('gateway');
    expect(r.accountId).toBeNull();
    expect(r.gatewayAuto).toBe(true);
    expect(r.env.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
    expect(r.notice).toMatch(/auto/i);
  });

  // ── the owner's default account (default-deploy-account-2026-08-08 P-004) ──
  // The two tests directly above are the CONTROL for this block: with no default set,
  // an unspecified account skips the gateway entirely. Everything below is what changes once the
  // owner nominates one — and, just as importantly, what must NOT change.

  describe('with a default account set', () => {
    beforeEach(() => {
      getFlagMock.mockResolvedValue(true);
      readDefaultAccountIdMock.mockResolvedValue('aviynw2');
    });

    it.each([null, '', '   '])(
      'unspecified account %p routes through the gateway on the AUTO path, never as a pin (D-003)',
      async (requested) => {
        // Reusing the `auto` path IS the mechanism: the gateway's resolveAccountPool already
        // returns the default first with the rest behind it, so this gets default-first
        // ordering AND failover for free. A pin would strand the session with no fallback the
        // moment that one account hit its rate window — which is why the assertions below are
        // about the ABSENCE of a pin, not the presence of the account id.
        const r = await pin(requested);
        expect(r.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('auto');
        expect(r.env.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
        expect(r.env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('account');
        expect(r.env.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
        expect(r.accountId).toBeNull();
        expect(r.provider).toBe('claude');
        expect(r.error).toBeUndefined();
      },
    );

    it.each(['default', 'DEFAULT', ' Default '])(
      'explicit account %p selects the system route, even when a default account is configured',
      async (requested) => {
        const r = await pin(requested);
        expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' });
        expect(r.accountId).toBeNull();
        expect(r.provider).toBeNull();
        expect(r.notice).toMatch(/default system account.*inference gateway skipped/i);
        expect(readDefaultAccountIdMock).not.toHaveBeenCalled();
      },
    );

    it('says WHICH account it starts on, and that it still fails over', async () => {
      // The notice is the only place the owner learns the default took effect — the env
      // deliberately looks identical to plain `auto`, so without this they cannot tell.
      const r = await pin(null);
      expect(r.notice).toMatch(/default account 'aviynw2'/i);
      expect(r.notice).toMatch(/fails over/i);
    });

    it.each(['none', 'system', 'NONE', ' System '])(
      "'%s' still reaches the machine's own login — the D-002 escape hatch is never overridden",
      async (kw) => {
        // Without this there is no way back to ~/.claude once a default exists, and no
        // recovery path at all if the default account's credential goes bad.
        const r = await pin(kw);
        expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' });
        expect(r.accountId).toBeNull();
        expect(r.notice).toMatch(/default system account.*inference gateway skipped/i);
      },
    );

    it('an explicit account pin still outranks the default (unchanged hard-pin behaviour)', async () => {
      const r = await pin('aviynw6');
      expect(r.env.PAPERCUSP_ACCOUNT_ID).toBe('aviynw6');
      expect(r.accountId).toBe('aviynw6');
      expect(r.notice).toMatch(/pinned to account aviynw6/i);
    });

    it('an explicit auto is unchanged — it does NOT start advertising the default', async () => {
      const r = await pin('auto');
      expect(r.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('auto');
      expect(r.notice).toMatch(/selects an available pool account/i);
      expect(r.notice).not.toMatch(/default account/i);
    });

    it('a CODEX agent never consults the default (it stands in for the CLAUDE login)', async () => {
      loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex' }] });
      const r = await pin(null, 'codex');
      expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' });
      expect(readDefaultAccountIdMock).not.toHaveBeenCalled();
    });

    it('OMP does not consult it — default preserves the selected OMP provider directly', async () => {
      const r = await pin(null, 'omp', 'ollama-cc/ornith:fast');
      expect(readDefaultAccountIdMock).not.toHaveBeenCalled();
      expect(r.env).toEqual({});
      expect(r.provider).toBeNull();
      expect(r.error).toBeUndefined();
    });

    it('gateway OFF → fails closed rather than quietly serving the system login', async () => {
      // Without a default, gateway-off + no account is a legitimate system-login launch. WITH
      // one, the owner has asked for a specific account, so degrading silently would egress on
      // a credential they did not choose while looking like a perfectly normal launch.
      getFlagMock.mockResolvedValue(false);
      const r = await pin(null);
      expect(r.env).toEqual({});
      expect(r.error).toMatch(/gateway is off/i);
      expect(r.error).toMatch(/refusing to fall back/i);
    });
  });

  it('a FAILED default read fails CLOSED — never a silent system-login launch', async () => {
    // The unreadable-row case is distinct from "no default set" (undefined), and conflating
    // them is the exact silent-misroute this feature exists to prevent: the session would
    // launch happily on the box's own credential with the owner's choice dropped on the floor.
    getFlagMock.mockResolvedValue(true);
    readDefaultAccountIdMock.mockRejectedValue(new Error('pg down'));
    const r = await pin(null);
    expect(r.env).toEqual({});
    expect(r.accountId).toBeNull();
    expect(r.error).toMatch(/could not read the default account/i);
    expect(r.error).toMatch(/pg down/);
    expect(r.error).toMatch(/refusing to fall back/i);
  });

  it("a failed default read does NOT block the 'system' escape hatch", async () => {
    // The recovery path must survive the failure mode it exists to recover from — otherwise a
    // bad override row locks the owner out of their own machine's login entirely.
    getFlagMock.mockResolvedValue(true);
    readDefaultAccountIdMock.mockRejectedValue(new Error('pg down'));
    const r = await pin('system');
    expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' });
    expect(r.error).toBeUndefined();
  });

  it("'auto' + gateway OFF → fails closed instead of using the default credential", async () => {
    getFlagMock.mockResolvedValue(false);
    const r = await pin('auto');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/--account auto could not be honored.*gateway is off/i);
    expect(r.error).toMatch(/refusing to fall back/i);
  });

  it("'auto' + codex → UNPINNED gateway routing carried by gatewayAuto (WI-3645), not a fail-soft", async () => {
    // The old behavior ("auto gateway routing isn't wired for codex yet") silently bypassed the
    // gateway: the session egressed direct-to-ChatGPT on the local credential, unmetered. Now
    // auto returns provider:'codex' + gatewayAuto:true — the CODEX_HOME writers translate that
    // into the UNPINNED gateway provider block (x-papercusp-account header omitted; the gateway
    // auto-selects via its bearer-pool → codex-CLI fallback). The env carries only the route
    // marker needed by PTY carry/recycle repair; transport routing still rides in config.toml.
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex' }] });
    const r = await pin('auto', 'codex');
    expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto' });
    expect(r.provider).toBe('codex');
    expect(r.accountId).toBeNull();
    expect(r.gatewayAuto).toBe(true);
    expect(r.notice).toMatch(/routing through the inference gateway \(auto/i);
  });

  it("'default' + codex stamps the system route for carry restoration", async () => {
    const r = await pin(null, 'codex');
    expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' });
    expect(r.accountId).toBeNull();
    expect(r.provider).toBeNull();
  });

  it("'auto' + omp emits an unpinned gateway models.yml", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('auto', 'omp');
    expect(r.env.PAPERCUSP_OMP_MODEL_SELECTOR).toBe('papercusp-gateway/claude-sonnet-4-6');
    expect(r.env.PAPERCUSP_OMP_MODELS_YML).toContain('papercusp-gateway:');
    expect(r.env.PAPERCUSP_OMP_MODELS_YML).not.toContain('x-papercusp-account');
    expect(r.gatewayAuto).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("'auto' + OMP preserves a compatible Claude selector exactly", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('auto', 'omp', 'claude-bridge/claude-opus-4-8:high');
    expect(r.env.PAPERCUSP_OMP_MODEL_SELECTOR).toBe('papercusp-gateway/claude-opus-4-8');
    expect(r.env.PAPERCUSP_OMP_MODELS_YML).toContain('- id: "claude-opus-4-8"');
    expect(r.provider).toBe('claude');
  });

  it("'auto' + OMP rejects an incompatible provider without substituting a Claude default", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('auto', 'omp', 'amazon-bedrock/anthropic.claude-opus-4-8');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/not compatible.*refusing model substitution/i);
  });

  it("'auto' + OMP OpenAI Codex selector resolves against the Codex pool + wire", async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({
      accounts: [{ id: 'aviynw6', provider: 'claude' }, { id: 'codex-main', provider: 'codex' }],
    });
    const r = await pin('auto', 'omp', 'openai-codex/gpt-5.6-terra:xhigh');
    expect(r.provider).toBe('codex');
    expect(r.env.PAPERCUSP_OMP_MODEL_SELECTOR).toBe('papercusp-gateway/gpt-5.6-terra');
    expect(r.env.PAPERCUSP_OMP_MODELS_YML).toContain('baseUrl: "http://127.0.0.1:8788/v1"');
    expect(r.env.PAPERCUSP_OMP_MODELS_YML).toContain('api: openai-responses');
  });

  it('OMP pin rejects a Claude account for an OpenAI Codex selector', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6', provider: 'claude' }] });
    const r = await pin('aviynw6', 'omp', 'openai-codex/gpt-5.6-terra');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/claude account.*omp sessions require codex/i);
  });

  it('Codex account + codex agent → no Anthropic env, but carries account id for CODEX_HOME config', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }, { id: 'codex-main', provider: 'codex' }] });
    const r = await pin('codex-main', 'codex');
    expect(r.provider).toBe('codex');
    expect(r.accountId).toBe('codex-main');
    expect(r.env).toEqual({
      PAPERCUSP_ACCOUNT_ID: 'codex-main',
      PAPERCUSP_ACCOUNT_ROUTING_MODE: 'pin',
    });
    expect(r.notice).toMatch(/pinned to Codex account codex-main/i);
  });

  it('Codex account + claude agent → fails closed on provider mismatch', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex' }] });
    const r = await pin('codex-main', 'claude');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/codex account.*claude sessions require claude/i);
  });

  it('refuses a freshly measured used-up pinned account but does not infer a wall from stale usage', async () => {
    getFlagMock.mockResolvedValue(true);
    const now = Date.now();
    loadAccountPoolMock.mockResolvedValue({ accounts: [
      { id: 'used', provider: 'codex', rate: { utilization: 0, utilization7d: 1, utilizationAt: now, windowResetAt7d: now + 3600_000, pausedUntil: 0 } },
      { id: 'stale', provider: 'codex', rate: { utilization: 0, utilization7d: 1, utilizationAt: now - 24 * 3600_000, windowResetAt7d: now + 3600_000, pausedUntil: 0 } },
    ] });
    const used = await pin('used', 'codex');
    expect(used.error).toMatch(/measured used up/i);
    expect(used.env).toEqual({});
    const stale = await pin('stale', 'codex');
    expect(stale.error).toBeUndefined();
    expect(stale.accountId).toBe('stale');
  });

  // P-006 (end-to-end through the POST handler): the launcher's `account` body field
  // flows → resolveAccountPin → the response's envelopeEnv + accountNotice.
  it('POST { account } → 409 before session bookkeeping when the explicit route is unavailable', async () => {
    getFlagMock.mockResolvedValue(false);
    const response = await callPost({ agent: 'claude', harness_slug: 'papercup', account: 'aviynw6' });
    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toMatch(/gateway is off/i);
    expect(json.error).toMatch(/refusing to fall back/i);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('POST { account } → response pins the account + sets the gateway env when on + valid', async () => {
    getFlagMock.mockResolvedValue(true);
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup', account: 'aviynw6' })).json();
    expect(json.accountNotice).toMatch(/pinned to account aviynw6/i);
    expect(json.envelopeEnv.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
    expect(json.envelopeEnv.PAPERCUSP_ACCOUNT_ID).toBe('aviynw6');
  });

  it('POST Codex pin threads SU owner/priority metadata into the CODEX_HOME writer', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex' }] });
    const response = await callPost({ agent: 'codex', harness_slug: 'papercup', account: 'codex-main' });
    expect(response.status, await response.clone().text()).toBe(200);
    const json = await response.json();
    expect(json.envelopeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('pin');
    expect(json.envelopeEnv.PAPERCUSP_ACCOUNT_ID).toBe('codex-main');
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        codexGatewayAccountId: 'codex-main',
        codexGatewayPriority: 'su',
        sid: expect.stringMatching(/^su-/),
      }),
    );
  });

  it('POST Codex auto carries its route mode into the fresh envelope', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex' }] });
    const json = await (await callPost({ agent: 'codex', harness_slug: 'papercup', account: 'auto' })).json();
    expect(json.envelopeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('auto');
    expect(json.envelopeEnv.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ codexGatewayAuto: true }),
    );
  });

  it('POST without account → no accountNotice, explicit default marker, no gateway env', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    expect(json.accountNotice).toBeNull();
    expect(json.envelopeEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(json.envelopeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('default');
    const codex = await (await callPost({ agent: 'codex', harness_slug: 'papercup' })).json();
    expect(codex.envelopeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('default');
    expect(codex.envelopeEnv.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
  });

  it('POST with explicit account=default stays on the system route when a default account is configured', async () => {
    getFlagMock.mockResolvedValue(true);
    readDefaultAccountIdMock.mockResolvedValue('aviynw2');
    try {
      const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup', account: 'default' })).json();
      expect(json.accountNotice).toMatch(/default system account.*inference gateway skipped/i);
      expect(json.envelopeEnv).toEqual(expect.objectContaining({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' }));
      expect(json.envelopeEnv.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(readDefaultAccountIdMock).not.toHaveBeenCalled();
    } finally {
      // This file's later POST tests intentionally exercise the no-default path.
      readDefaultAccountIdMock.mockResolvedValue(undefined);
    }
  });
});

describe('resolveAccountChoices (psu-account-chooser P-005)', () => {
  beforeEach(() => {
    getFlagMock.mockResolvedValue(false);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }, { id: 'aviynw2' }] });
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [] });
  });
  const choices = async (agent: 'claude' | 'omp' | 'codex' = 'claude') =>
    (await import('../routes/agent-mcp/bootstrap-su')).resolveAccountChoices('default', agent);

  it('gateway off → hidden (empty pool) — the current default', async () => {
    getFlagMock.mockResolvedValue(false);
    expect(await choices()).toEqual({
      gatewayOn: false,
      pool: [],
      forcedAccounts: [],
      excludeAccounts: [],
      provider: 'claude',
    });
  });

  it('gateway on → pool ids + the active session-override', async () => {
    getFlagMock.mockResolvedValue(true);
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: ['aviynw6'], excludeAccounts: ['aviynw2'] });
    const r = await choices();
    expect(r.gatewayOn).toBe(true);
    expect(r.pool).toEqual(['aviynw6', 'aviynw2']);
    expect(r.forcedAccounts).toEqual(['aviynw6']);
    expect(r.excludeAccounts).toEqual(['aviynw2']);
  });

  it('Codex choices include only codex provider accounts', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }, { id: 'codex-main', provider: 'codex' }] });
    const r = await choices('codex');
    expect(r.provider).toBe('codex');
    expect(r.pool).toEqual(['codex-main']);
  });

  it('marks freshly usage-walled accounts unavailable, while stale and failed probes stay unknown', async () => {
    getFlagMock.mockResolvedValue(true);
    const now = Date.now();
    loadAccountPoolMock.mockResolvedValue({ accounts: [
      { id: 'used', provider: 'codex', rate: { utilization: 0, utilization7d: 1, utilizationAt: now, windowResetAt7d: now + 3600_000, pausedUntil: 0 } },
      { id: 'fresh', provider: 'codex', rate: { utilization: 0, utilization7d: 0.2, utilizationAt: now, windowResetAt7d: now + 3600_000, pausedUntil: 0 } },
      { id: 'stale', provider: 'codex', rate: { utilization: 0, utilization7d: 1, utilizationAt: now - 24 * 3600_000, windowResetAt7d: now + 3600_000, pausedUntil: 0 } },
      { id: 'probe-failed', provider: 'codex', rate: { utilization: 0, utilization7d: 1, utilizationAt: now, windowResetAt7d: now + 3600_000, pausedUntil: 0, lastProbeFailedAt: now } },
    ] });
    const r = await choices('codex');
    expect(r.pool).toEqual(['used', 'fresh', 'stale', 'probe-failed']);
    expect(r.accountStates).toEqual({
      used: 'unavailable', fresh: 'available', stale: 'unknown', 'probe-failed': 'unknown',
    });
  });

  it('OMP choices resolve to the claude account pool (omp pins claude accounts, D-006)', async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await choices('omp');
    expect(r.gatewayOn).toBe(true);
    expect(r.provider).toBe('claude');
    expect(r.unsupportedReason).toBeUndefined();
    expect(loadAccountPoolMock).toHaveBeenCalled();
  });

  it('GET /options surfaces the accounts field (empty when gateway off)', async () => {
    getFlagMock.mockResolvedValue(false);
    const json = await (await callGet()).json();
    expect(json.accounts).toEqual({
      gatewayOn: false,
      pool: [],
      forcedAccounts: [],
      excludeAccounts: [],
      provider: 'claude',
    });
  });
});

// fleet-recolor-and-color-hardening P-002: regression guard for the psu-picker
// fleet-color path. The reported bug — "create a new fleet in the psu menu and
// the terminal isn't recolored" — is exactly resolveFleet failing to emit
// PAPERCUSP_FLEET_BG/FG/CURSOR for a freshly-created fleet. Nothing guarded it.
// These tests assert BOTH branches (create-new + join-existing) carry the color
// env, and that the catalog's real hex reaches the env (real resolveFleetScheme).
describe('resolveFleet — terminal color env (fleet-color-schemes)', () => {
  let forest: { name: string; bg: string; fg: string; cursor: string };
  beforeEach(async () => {
    const { schemeByName } = await import('../../console-color-schemes');
    forest = schemeByName('forest')!;
  });

  async function resolveFleet(
    workspaceId: string,
    opts: {
      fleet?: string | null;
      fleetRole?: string | null;
      fleetName?: string | null;
      fleetScheme?: string | null;
      ownerId?: string;
    },
  ) {
    const mod = await import('../routes/agent-mcp/bootstrap-su');
    return mod.resolveFleet(workspaceId, opts);
  }

  it('a NEW fleet (fleetName) carries the fleet color env — the regressed case', async () => {
    createFleetIfAbsentMock.mockResolvedValue({
      record: {
        workspaceId: 'default',
        fleetSlug: 'my-fleet',
        title: 'My Fleet',
        description: null,
        owner: 'su-1',
        leaderOwnerId: 'su-1',
        colorScheme: 'forest',
        createdAt: 0,
        updatedAt: 0,
      },
      created: true,
    });
    const { env, fleetRole, fleetSlug } = await resolveFleet('default', { fleetName: 'My Fleet', ownerId: 'su-1' });
    expect(fleetRole).toBe('leader');
    expect(fleetSlug).toBe('my-fleet');
    expect(env.PAPERCUSP_FLEET_SLUG).toBe('my-fleet');
    expect(env.PAPERCUSP_FLEET_ROLE).toBe('leader');
    // The actual catalog hex — not just "some value" — must reach the env.
    expect(env.PAPERCUSP_FLEET_BG).toBe(forest.bg);
    expect(env.PAPERCUSP_FLEET_FG).toBe(forest.fg);
    expect(env.PAPERCUSP_FLEET_CURSOR).toBe(forest.cursor);
  });

  it('a chosen catalog scheme (fleetScheme) is FORCED at create; unknown/absent → auto-allocate (null)', async () => {
    createFleetIfAbsentMock.mockResolvedValue({
      record: {
        workspaceId: 'default',
        fleetSlug: 'my-fleet',
        title: 'My Fleet',
        description: null,
        owner: 'su-1',
        leaderOwnerId: 'su-1',
        colorScheme: 'forest',
        createdAt: 0,
        updatedAt: 0,
      },
      created: true,
    });
    // A valid catalog name is passed straight through as the forced colorScheme.
    await resolveFleet('default', { fleetName: 'My Fleet', fleetScheme: 'royal-purple', ownerId: 'su-1' });
    expect(createFleetIfAbsentMock).toHaveBeenCalledWith(expect.objectContaining({ colorScheme: 'royal-purple' }));
    // An unknown name is rejected → null → the store auto-allocates the next unused.
    createFleetIfAbsentMock.mockClear();
    await resolveFleet('default', { fleetName: 'My Fleet', fleetScheme: 'not-a-real-scheme', ownerId: 'su-1' });
    expect(createFleetIfAbsentMock).toHaveBeenCalledWith(expect.objectContaining({ colorScheme: null }));
    // No scheme chosen → null (auto-allocate) — unchanged legacy behaviour.
    createFleetIfAbsentMock.mockClear();
    await resolveFleet('default', { fleetName: 'My Fleet', ownerId: 'su-1' });
    expect(createFleetIfAbsentMock).toHaveBeenCalledWith(expect.objectContaining({ colorScheme: null }));
  });

  it('an EXISTING fleet (fleet slug) carries the fleet color env', async () => {
    getFleetSchemeMock.mockResolvedValue({ name: 'forest', bg: forest.bg, fg: forest.fg, cursor: forest.cursor });
    // EI-18278623507151337: joins as `su-2`, NOT the shared getFleetMock record's
    // `leaderOwnerId: 'su-1'`. This case is about the COLOR env on an ordinary member
    // join; an owner that matches the record's leader is now (correctly) kept a LEADER
    // by the composer-side role check, which would make the `member` assertion below
    // assert the wrong thing about a different scenario.
    const { env, fleetRole } = await resolveFleet('default', { fleet: 'team', ownerId: 'su-2' });
    expect(fleetRole).toBe('member');
    expect(env.PAPERCUSP_FLEET_SLUG).toBe('team');
    expect(env.PAPERCUSP_FLEET_BG).toBe(forest.bg);
    expect(env.PAPERCUSP_FLEET_FG).toBe(forest.fg);
    expect(env.PAPERCUSP_FLEET_CURSOR).toBe(forest.cursor);
  });

  it('no fleet ⇒ empty env (no color vars, byte-identical to today)', async () => {
    const { env, fleetSlug, fleetRole } = await resolveFleet('default', {});
    expect(env).toEqual({});
    expect(fleetSlug).toBeNull();
    expect(fleetRole).toBeNull();
  });

  it('an existing fleet with no resolvable scheme keeps slug/role but omits color vars', async () => {
    getFleetSchemeMock.mockResolvedValue(null);
    const { env } = await resolveFleet('default', { fleet: 'ghost' });
    expect(env.PAPERCUSP_FLEET_SLUG).toBe('ghost');
    expect(env.PAPERCUSP_FLEET_BG).toBeUndefined();
  });
});

// WI-1408 (fleet-join-startup-assertion): a --fleet=<slug> join must validate the slug
// is a REAL agent_fleets row before handing back membership env — otherwise a
// typo'd/stale slug "succeeds" silently: PAPERCUSP_FLEET_SLUG gets set to a fleet that
// never existed, a phantom membership invisible to fleet:assignments' roster of real
// rows even though the env var itself is non-null.
describe('resolveFleet — nonexistent-slug rejection (WI-1408)', () => {
  // Same dynamic-import helper as the sibling describe block above (each `describe`
  // is its own closure — the other block's local `resolveFleet` isn't in scope here).
  async function resolveFleet(
    workspaceId: string,
    opts: {
      fleet?: string | null;
      fleetRole?: string | null;
      fleetName?: string | null;
      fleetScheme?: string | null;
      ownerId?: string;
    },
  ) {
    const mod = await import('../routes/agent-mcp/bootstrap-su');
    return mod.resolveFleet(workspaceId, opts);
  }

  it('joining an unknown slug ⇒ empty env, null slug/role, an explanatory notice', async () => {
    getFleetMock.mockResolvedValueOnce(null);
    const { env, fleetSlug, fleetRole, notice } = await resolveFleet('default', { fleet: 'ghost-fleet' });
    expect(env).toEqual({});
    expect(fleetSlug).toBeNull();
    expect(fleetRole).toBeNull();
    expect(notice).toMatch(/ghost-fleet.*does not exist/i);
  });

  it('POST { fleet } for an unknown slug is a hard 409 — never a silent unfleeted launch', async () => {
    getFleetMock.mockResolvedValueOnce(null);
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', fleet: 'ghost-fleet' });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.status).toBe('error');
    expect(json.error).toMatch(/fleet join failed/i);
    expect(json.error).toMatch(/ghost-fleet/i);
    // The launch must never have been recorded — the hard-fail is BEFORE session bookkeeping.
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('POST { fleet } for a real slug still returns 200 with fleetSlug/fleetRole in the result', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup', fleet: 'real-fleet' })).json();
    expect(json.status).toBe('ok');
    expect(json.fleetSlug).toBe('real-fleet');
    expect(json.fleetRole).toBe('member');
  });

  it('no fleet requested at all ⇒ still 200, fleetSlug/fleetRole both null (no assertion fires)', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    expect(json.status).toBe('ok');
    expect(json.fleetSlug).toBeNull();
    expect(json.fleetRole).toBeNull();
  });
});

describe('deriveKickoffPrompt (EI-5503 + WI-1962 + WI-1356 — the turn-1 kickoff matrix)', () => {
  it('a bare interactive launch seeds nothing', async () => {
    const { deriveKickoffPrompt } = await import('../routes/agent-mcp/bootstrap-su');
    expect(deriveKickoffPrompt({ planSlug: null, autoMode: false, launchContextPath: null })).toBeNull();
  });

  it('WI-1962: a mission-brief (--launch-context) launch gets the brief kickoff — it must not park', async () => {
    const { deriveKickoffPrompt, LAUNCH_CONTEXT_KICKOFF } = await import('../routes/agent-mcp/bootstrap-su');
    const k = deriveKickoffPrompt({ planSlug: null, autoMode: false, launchContextPath: '/tmp/brief.md' });
    expect(k).toBe(LAUNCH_CONTEXT_KICKOFF);
  });

  it('a plan-bound launch keeps the canonical plan kickoff (plan wins over a brief)', async () => {
    const { deriveKickoffPrompt } = await import('../routes/agent-mcp/bootstrap-su');
    const k = deriveKickoffPrompt({ planSlug: 'p1', autoMode: false, launchContextPath: '/tmp/brief.md' });
    expect(k).toContain('plans:get');
  });

  it('bakes the literal slug + harness into the plan kickoff (ornith 10115: no slug ⇒ parked on ask)', async () => {
    const { deriveKickoffPrompt } = await import('../routes/agent-mcp/bootstrap-su');
    const k = deriveKickoffPrompt({
      planSlug: 'p1',
      harnessSlug: 'papercusp',
      autoMode: false,
      launchContextPath: null,
    });
    expect(k).toContain('handed the plan `p1`');
    expect(k).toContain('{ slug: "p1", harness: "papercusp" }');
    // slug-only launches still name the slug
    const bare = deriveKickoffPrompt({ planSlug: 'p1', autoMode: true, launchContextPath: null });
    expect(bare).toContain('{ slug: "p1" }');
  });

  it('WI-10004449: an AUTO fleet LEADER gets the leader kickoff, never the member one', async () => {
    const { deriveKickoffPrompt, LEADER_AUTO_MODE_KICKOFF_DIRECTIVE } = await import('../routes/agent-mcp/bootstrap-su');
    const base = { planSlug: 'p1', harnessSlug: 'papercusp', autoMode: true, launchContextPath: '/tmp/leader.md', fleetSlug: 'f1' };
    const leader = deriveKickoffPrompt({ ...base, fleetRole: 'leader', loopAutoArmed: true });
    expect(leader).toContain(LEADER_AUTO_MODE_KICKOFF_DIRECTIVE);
    expect(leader).toContain("fleet's LEADER, not a member");
    expect(leader).toContain('lead fleet `f1` on plan `p1`');
    expect(leader).not.toContain('You are a fleet member');
    expect(leader).not.toContain('claim your lane and work that item');
    // A member launch is unchanged: it still gets the member activation.
    const member = deriveKickoffPrompt({ ...base, fleetRole: 'member', loopAutoArmed: true });
    expect(member).toContain('You are a fleet member');
    expect(member).not.toContain(LEADER_AUTO_MODE_KICKOFF_DIRECTIVE);
    // DRAIN keeps its own directive; an interactive (non-AUTO) leader keeps the plan kickoff.
    expect(deriveKickoffPrompt({ ...base, fleetRole: 'leader', drainMode: true })).not.toContain(LEADER_AUTO_MODE_KICKOFF_DIRECTIVE);
    expect(deriveKickoffPrompt({ ...base, autoMode: false, fleetRole: 'leader' })).toContain('handed the plan `p1`');
  });

  it('AUTO prepends the activation to whichever base applies (brief / bare)', async () => {
    const { deriveKickoffPrompt, AUTO_MODE_DIRECTIVE, LAUNCH_CONTEXT_KICKOFF } =
      await import('../routes/agent-mcp/bootstrap-su');
    const withBrief = deriveKickoffPrompt({ planSlug: null, autoMode: true, launchContextPath: '/b.md' });
    expect(withBrief).toContain(AUTO_MODE_DIRECTIVE);
    expect(withBrief).toContain(LAUNCH_CONTEXT_KICKOFF);
    const bare = deriveKickoffPrompt({ planSlug: null, autoMode: true, launchContextPath: null });
    expect(bare).toContain(AUTO_MODE_DIRECTIVE);
    expect(bare).not.toContain(LAUNCH_CONTEXT_KICKOFF);
  });

  it('drain-mode P-003: DRAIN prepends the DRAIN activation and REPLACES the plain AUTO one', async () => {
    const { deriveKickoffPrompt, DRAIN_MODE_DIRECTIVE, AUTO_MODE_DIRECTIVE, CONTEXT_DISCIPLINE_DIRECTIVE } =
      await import('../routes/agent-mcp/bootstrap-su');
    // A drain launch is autoMode too (DRAIN implies AUTO server-side) — the DRAIN
    // directive must still win, never both activations.
    const bare = deriveKickoffPrompt({ planSlug: null, autoMode: true, launchContextPath: null, drainMode: true });
    expect(bare).toContain(DRAIN_MODE_DIRECTIVE);
    expect(bare).toContain(CONTEXT_DISCIPLINE_DIRECTIVE);
    expect(bare).not.toContain(AUTO_MODE_DIRECTIVE);
  });

  it('drain-mode P-003: a plan-bound DRAIN launch keeps the canonical plan kickoff under the activation', async () => {
    const { deriveKickoffPrompt, DRAIN_MODE_DIRECTIVE } = await import('../routes/agent-mcp/bootstrap-su');
    const k = deriveKickoffPrompt({ planSlug: 'p1', autoMode: true, launchContextPath: null, drainMode: true });
    expect(k).toContain(DRAIN_MODE_DIRECTIVE);
    expect(k).toContain('plans:get');
  });

  it('drain-mode P-003: omitting drainMode is byte-identical to the pre-drain behavior', async () => {
    const { deriveKickoffPrompt, AUTO_MODE_DIRECTIVE } = await import('../routes/agent-mcp/bootstrap-su');
    const auto = deriveKickoffPrompt({ planSlug: null, autoMode: true, launchContextPath: null });
    expect(auto).toContain(AUTO_MODE_DIRECTIVE);
    expect(deriveKickoffPrompt({ planSlug: null, autoMode: false, launchContextPath: null })).toBeNull();
  });
});

describe('deriveKickoffPrompt — kickoff-prompt-absorption P-004 (guard profile + auto-arm notice)', () => {
  it("loopAutoArmed swaps the AUTO activation's MUST-ARM clause for the already-armed notice", async () => {
    const { deriveKickoffPrompt, AUTO_MODE_DIRECTIVE, AUTO_MODE_DIRECTIVE_LOOP_ARMED } =
      await import('../routes/agent-mcp/bootstrap-su');
    const armed = deriveKickoffPrompt({
      planSlug: 'p1',
      autoMode: true,
      launchContextPath: null,
      loopAutoArmed: true,
    });
    expect(armed).toContain(AUTO_MODE_DIRECTIVE_LOOP_ARMED);
    expect(armed).not.toContain('MUST ARM');
    expect(armed).toContain('ALREADY ARMED');
    // Omitted / false ⇒ the full self-arm instruction (the fallback path).
    const fallback = deriveKickoffPrompt({ planSlug: 'p1', autoMode: true, launchContextPath: null });
    expect(fallback).toContain(AUTO_MODE_DIRECTIVE);
    expect(fallback).toContain('MUST ARM');
  });

  it('autoModeDirective picks by arm outcome (never assume armed)', async () => {
    const { autoModeDirective, AUTO_MODE_DIRECTIVE, AUTO_MODE_DIRECTIVE_LOOP_ARMED } =
      await import('../routes/agent-mcp/bootstrap-su');
    expect(autoModeDirective(true)).toBe(AUTO_MODE_DIRECTIVE_LOOP_ARMED);
    expect(autoModeDirective(false)).toBe(AUTO_MODE_DIRECTIVE);
  });

  it("agent:'claude' gets the lean plan kickoff (orient pointer, absorbed guards dropped)", async () => {
    const { deriveKickoffPrompt } = await import('../routes/agent-mcp/bootstrap-su');
    const k = deriveKickoffPrompt({
      planSlug: 'p1',
      harnessSlug: 'papercusp',
      autoMode: true,
      launchContextPath: null,
      agent: 'claude',
    });
    expect(k).toContain('advance the plan `p1`');
    expect(k).toContain('coord:orient');
    expect(k).toContain('planSlug: "p1"');
    expect(k).not.toContain('NOT hunt for a plan file'); // → P-003b plans-read hook (WI-5229)
    expect(k).not.toContain('NameError'); // → P-003a unknown-tool referral (EI-9011)
  });

  it('omp (ornith/local) and codex keep the full weak-model guard text', async () => {
    const { deriveKickoffPrompt } = await import('../routes/agent-mcp/bootstrap-su');
    for (const agent of ['omp', 'codex', undefined]) {
      const k = deriveKickoffPrompt({
        planSlug: 'p1',
        autoMode: true,
        launchContextPath: null,
        agent,
      });
      expect(k).toContain('plans:get');
      expect(k).toContain('NOT hunt for a plan file');
    }
  });

  it('DRAIN is unaffected by loopAutoArmed (leaders are never auto-armed; DRAIN sequences its own bring-up)', async () => {
    const { deriveKickoffPrompt, DRAIN_MODE_DIRECTIVE } = await import('../routes/agent-mcp/bootstrap-su');
    const k = deriveKickoffPrompt({
      planSlug: null,
      autoMode: true,
      launchContextPath: null,
      drainMode: true,
      loopAutoArmed: true,
    });
    expect(k).toContain(DRAIN_MODE_DIRECTIVE);
    expect(k).not.toContain('ALREADY ARMED');
  });
});

describe('buildLaunchProvenanceFactBody — fleet-safe reporting fallback', () => {
  it('preserves original launcher attribution and teaches the live fleet leader selector', async () => {
    const { buildLaunchProvenanceFactBody } = await import('../routes/agent-mcp/bootstrap-su');
    const body = buildLaunchProvenanceFactBody({
      launchedBy: 'su-ended-launcher',
      planSlug: 'drain-plan',
      launchContextPath: '/tmp/fleet-brief.md',
      fleetSlug: 'nonp2p-bug-drain-headless-0812',
    });

    expect(body).toContain('You were launched by su-ended-launcher on plan drain-plan with brief fleet-brief.md.');
    expect(body).toContain(
      'For live fleet coordination, report milestones + anomalies with coord:send to ["@fleet-leader:nonp2p-bug-drain-headless-0812"]',
    );
    expect(body).toContain('launcher ID above as attribution only, not as the live fleet recipient');
    expect(body).not.toContain('report milestones + anomalies to them while live');
    expect(body).toContain('to: ["@fleet-leader:nonp2p-bug-drain-headless-0812"]');
    expect(body).toContain('survives session retirement and leadership rotation');
  });

  it('keeps fleetless launcher attribution and teaches the durable human fallback', async () => {
    const { buildLaunchProvenanceFactBody } = await import('../routes/agent-mcp/bootstrap-su');
    const body = buildLaunchProvenanceFactBody({ launchedBy: 'su-direct-launcher' });

    expect(body).toContain(
      'You were launched by su-direct-launcher. They are your launcher/supervisor; report milestones + anomalies to them while live.',
    );
    expect(body).toContain('to: ["human"]');
    expect(body).toContain('owner surface survives session retirement');
    expect(body).not.toContain('@fleet-leader:');
  });
});

/**
 * P-021 (D-013) — the PRODUCER half, exercised through the real route handler.
 *
 * The pure gate is unit-tested in omp-native-lsp-gate.test.ts and the argv half
 * in psu-launcher.test.ts, but neither proves the route actually EMITS the env
 * — and "the server resolves it and threads it via envelopeEnv" is the whole
 * mechanism. Without this, the feature could be inert end-to-end while every
 * other test in the change stayed green.
 */
describe('bootstrap-su: PAPERCUSP_OMP_NATIVE_LSP (P-021)', () => {
  const ENV = 'PAPERCUSP_OMP_NATIVE_LSP';
  const envOf = async (body: Record<string, unknown>) =>
    (await (await callPost({ harness_slug: 'papercup', plan_slug: null, ...body })).json())
      .envelopeEnv?.[ENV];

  it('SETS the env for an omp launch on a cloud model', async () => {
    getFlagMock.mockResolvedValue(true);
    expect(await envOf({ agent: 'omp', model: 'claude-bridge/claude-opus-4-8:high' })).toBe('1');
  });

  it('does NOT set it for a LOCAL model — the tier gate holds even with the flag ON', async () => {
    getFlagMock.mockResolvedValue(true);
    expect(await envOf({ agent: 'omp', model: 'ollama-cc/ornith:fast' })).toBeUndefined();
  });

  it('does NOT set it when no model is given — omp falls back to its own local default', async () => {
    getFlagMock.mockResolvedValue(true);
    expect(await envOf({ agent: 'omp' })).toBeUndefined();
  });

  it('does NOT set it on a non-omp backend — the builtin is an omp concept', async () => {
    getFlagMock.mockResolvedValue(true);
    expect(await envOf({ agent: 'claude' })).toBeUndefined();
  });

  it('the flag is a real kill-switch at the route: OFF withholds the env', async () => {
    getFlagMock.mockResolvedValue(false);
    expect(await envOf({ agent: 'omp', model: 'claude-bridge/claude-opus-4-8:high' })).toBeUndefined();
  });
});

describe('EI-21365235532676472: failed-resume binding reclaim', () => {
  beforeEach(() => {
    dbState.advRows = [];
    dbState.beatRows = [];
    resolveSessionStatesMock.mockReset().mockResolvedValue(new Map());
    markAdvSessionEndedMock.mockClear();
  });

  it('uses the hydrated shared oracle and reclaims an ended stranded binding', async () => {
    dbState.advRows = [{ id: '900', display: 'terminal', has_session: true }];
    resolveSessionStatesMock.mockResolvedValueOnce(
      new Map([['su-dead01', { sessionState: 'ended' }]]),
    );
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', owner_id: 'su-dead01' });
    expect(res.status).toBe(200);
    expect(resolveSessionStatesMock).toHaveBeenCalledWith(
      [{ ownerId: 'su-dead01' }],
      { hydratePerId: true },
    );
    expect(markAdvSessionEndedMock).toHaveBeenCalledTimes(1);
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(900, null, 'reconciler');
    const json = await res.json();
    expect(json.error ?? '').not.toContain('already bound');
  });

  it('also reclaims a suspect stranded binding (claims-held terminal verdict)', async () => {
    dbState.advRows = [{ id: '901', display: 'terminal', has_session: true }];
    resolveSessionStatesMock.mockResolvedValueOnce(
      new Map([['su-suspect', { sessionState: 'suspect' }]]),
    );
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', owner_id: 'su-suspect' });
    expect(res.status).toBe(200);
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(901, null, 'reconciler');
  });

  it.each([
    ['recorded', 'su-recorded'],
    ['live', 'su-live01'],
    [null, 'su-unkn01'],
  ] as const)('keeps a %s oracle verdict blocking the pre-pinned owner', async (state, ownerId) => {
    dbState.advRows = [{ id: '902', display: 'terminal', has_session: true }];
    resolveSessionStatesMock.mockResolvedValueOnce(
      new Map([[ownerId, { sessionState: state }]]),
    );
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', owner_id: ownerId });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(String(json.error)).toContain('already bound to live adv session 902');
    expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
  });

  it('fails closed when the shared oracle read rejects', async () => {
    dbState.advRows = [{ id: '903', display: 'terminal', has_session: true }];
    resolveSessionStatesMock.mockRejectedValueOnce(new Error('oracle unavailable'));
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', owner_id: 'su-oracle-fail' });
    expect(res.status).toBe(409);
    expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
  });
});
