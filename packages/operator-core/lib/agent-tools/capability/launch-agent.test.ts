/**
 * launch-agent.test.ts — capability:launch-agent's MODE MATRIX
 * (agent-launch-resume-primitives-2026-07-12 P-009).
 *
 * The composition is the whole point of the tool, so the matrix is what's pinned:
 * (ad-hoc | resumed | forked) × (fleet | no-fleet) × (visible | headless) × 1..N —
 * plus the two rules that make a launch actually WORK: the brief becomes the first
 * turn (via the spawn-safe env, never a --kickoff= value), and a LIVE source is
 * FORKED rather than resumed in place (D-007).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/capability/launch-agent.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dispatchProjectedTool, listMcpProjections, type ProjectedTool, type ToolResult, type UnifiedToolContext } from '@papercusp/tooldef';
import type { KickoffProofResult, SpawnChildExit, SpawnConsoleResult } from '../../console-spawn';
import { PSU_LAUNCH_LOG_TAIL_CHARS } from '../../psu-launch-log.mjs';
import { BLIND_GAP_REVIEW_ACTOR, INTERNAL_BLIND_REVIEW_RESUME } from '../../blind-review-session-bindings';
import { AGENT_LAUNCH_HANDLER_TIMEOUT_SEC, EARLY_EXIT_PROBE_MS, HEADLESS_BOOT_RECEIPT_MS, KICKOFF_PROOF_WINDOW_MS, RESUME_VERIFY_TIMEOUT_MS } from '../../agent-kickoff/launch-budgets.mjs';
import { INTERNAL_EXPECTED_SUCCESSOR_BINDING } from '../../agent-launch-core';

const assembleRolePromptMock = vi.hoisted(() => vi.fn());
const resolveNamedIdentityCompositionSelectionMock = vi.hoisted(() => vi.fn());
vi.mock('../../agent-identities/source', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveNamedIdentityCompositionSelection: (...args: unknown[]) =>
    resolveNamedIdentityCompositionSelectionMock(...args),
}));
vi.mock('@papercusp/orchestrator/role-prompt', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  assembleRolePrompt: (...args: unknown[]) => assembleRolePromptMock(...args),
}));

// Typed as a tagged-template sql (strings, ...values) so a test can install a
// query-aware implementation without a cast (the reviewer-relaunch guard test).
const goalContextSqlMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []));
const goalLaunchResolveMock = vi.hoisted(() => vi.fn());
const declareCouplingMock = vi.hoisted(() => vi.fn());
vi.mock('../../coord/couplings', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  declareCoupling: (...args: unknown[]) => declareCouplingMock(...args),
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // resolveGoalLaunch now reads the holder-authority fence before resolving
  // inherited context. This suite has no goal rows, so return an empty result
  // rather than allowing the PG-backed default to leak into the test.
  getOrgPg: () => ({ sql: goalContextSqlMock }),
}));
vi.mock('../../goal-launch-settings', async (orig) => {
  const actual = await orig<typeof import('../../goal-launch-settings')>();
  return {
    ...actual,
    resolveGoalLaunch: (args: Parameters<typeof actual.resolveGoalLaunch>[0]) =>
      goalLaunchResolveMock.getMockImplementation()
        ? goalLaunchResolveMock(args)
        : actual.resolveGoalLaunch(args),
  };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../papercusp-root', () => ({ papercuspPathForWorkspace: () => '/tmp/papercusp-ws' }));

const readPsuLaunchLogTailMock = vi.hoisted(() => vi.fn());
vi.mock('../../psu-launch-log.mjs', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readPsuLaunchLogTail: (...args: unknown[]) => readPsuLaunchLogTailMock(...args),
}));

type CodexThreadWriterHolder = {
  held: boolean;
  pid: number | null;
  lockPath: string | null;
  sessionId: string | null;
  reason: string;
};
const codexThreadWriterHolderMock = vi.hoisted(() =>
  vi.fn((_codexHome: string, _sessionId: string | null): CodexThreadWriterHolder => ({
    held: false,
    pid: null,
    lockPath: null,
    sessionId: null,
    reason: 'no-lock-file',
  })),
);
const originalRoutingGuardMock = vi.hoisted(() => vi.fn());
const inspectBlindReviewResumeTargetMock = vi.hoisted(() => vi.fn());
const verifyBlindReviewSessionResumeBindingMock = vi.hoisted(() => vi.fn());
vi.mock('../../blind-review-session-bindings', async (orig) => ({
  ...(await orig<typeof import('../../blind-review-session-bindings')>()),
  inspectBlindReviewResumeTarget: (...args: unknown[]) => inspectBlindReviewResumeTargetMock(...args),
  verifyBlindReviewSessionResumeBinding: (...args: unknown[]) => verifyBlindReviewSessionResumeBindingMock(...args),
}));
vi.mock('../../../../../apps/operator/scripts/psu-launcher.mjs', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ORIGINAL_CODEX_ROUTING_ENV: 'PAPERCUSP_ORIGINAL_CODEX_ROUTING',
  assertOriginalCodexRouting: (...args: unknown[]) => originalRoutingGuardMock(...args),
  codexThreadWriterHolder: (...args: [string, string | null]) => codexThreadWriterHolderMock(...args),
}));

const shutdownViaPtyMock = vi.hoisted(() => vi.fn(async (_ownerId: string, _opts?: unknown) => 'sent'));
const findLiveHostMock = vi.hoisted(() => vi.fn((_ownerId: string): unknown => null));
const markAdvSessionEndedMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
const acquireAdvSessionResumeMock = vi.hoisted(() => vi.fn());
const releaseAdvSessionResumeMock = vi.hoisted(() => vi.fn());
const readAdvSessionLaunchRecordByOwnerMock = vi.hoisted(() => vi.fn());
vi.mock('../../adv-sessions', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  markAdvSessionEnded: (...args: unknown[]) => markAdvSessionEndedMock(...args),
  acquireAdvSessionResume: (...args: unknown[]) => acquireAdvSessionResumeMock(...args),
  releaseAdvSessionResume: (...args: unknown[]) => releaseAdvSessionResumeMock(...args),
  readAdvSessionLaunchRecordByOwner: (...args: unknown[]) => readAdvSessionLaunchRecordByOwnerMock(...args),
}));
const resolveSessionStatesMock = vi.hoisted(() => vi.fn());
const listSuccessorTasksMock = vi.hoisted(() => vi.fn());
vi.mock('../../task-manager/store', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listTasks: (...args: unknown[]) => listSuccessorTasksMock(...args),
}));
vi.mock('../coordination/liveness-oracle', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveSessionStates: (...args: unknown[]) => resolveSessionStatesMock(...args),
}));
vi.mock('../../events/await/psu-pty-discovery', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findLiveHost: (ownerId: string) => findLiveHostMock(ownerId),
  findLiveHostAsync: async (ownerId: string) => findLiveHostMock(ownerId),
  shutdownViaPty: (ownerId: string, opts?: unknown) => shutdownViaPtyMock(ownerId, opts),
}));

const windowScopeVerdictMock = vi.hoisted(() => vi.fn((_pid: number, _fs: unknown) => 'dead'));
vi.mock('../../task-manager/terminal-residue-census', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isPidInLiveWindowScope: (pid: number, fs: unknown) => windowScopeVerdictMock(pid, fs),
}));

const getModesMock = vi.hoisted(() => vi.fn());
vi.mock('../../modes/store', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getModes: (...args: unknown[]) => getModesMock(...args),
}));

const gateWorkScopeMock = vi.hoisted(() => vi.fn());
vi.mock('../../work-scope-policy', () => ({
  gateWorkScope: (...args: unknown[]) => gateWorkScopeMock(...args),
}));
const resolveAcceptedOperationWorkerBindingMock = vi.hoisted(() => vi.fn());
vi.mock('../../blueprint/operation-worker-binding', () => ({
  resolveAcceptedOperationWorkerBinding: (...args: unknown[]) =>
    resolveAcceptedOperationWorkerBindingMock(...args),
}));

const listFactsMock = vi.hoisted(() => vi.fn());
vi.mock('../../agent-facts/store', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listFacts: (...args: unknown[]) => listFactsMock(...args),
}));

const getLoopStatusMock = vi.hoisted(() => vi.fn());
vi.mock('../../harness/routines/loop', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getLoopStatus: (ownerId: string) => getLoopStatusMock(ownerId),
}));

const buildConsoleEnvelopeMock = vi.hoisted(() => vi.fn(async (_opts: unknown) => ({
    cwd: '/repo',
    env: { PAPERCUSP_SID: 'su-caller' },
    greetingCmd: '',
    mcpJsonContents: '',
  })));
vi.mock('../../console-launcher', () => ({
  buildConsoleEnvelope: (opts: unknown) => buildConsoleEnvelopeMock(opts),
}));

const armInboxWakeMock = vi.hoisted(() => vi.fn());
vi.mock('../../events/await/inbox-wake-arm', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  armInboxWake: (...args: unknown[]) => armInboxWakeMock(...args),
}));

// launch-agent's mode matrix is about command composition and spawn routing. The
// backend PATH preflight and startup probes have their own focused suites
// (backend-bin-resolve.test.ts and agent-launch-verification.test.ts); keep those
// infrastructure probes deterministic here so this test does not depend on the
// host's installed backend or spend 30s polling a real PG-backed session ledger.
vi.mock('../../backend-bin-resolve.mjs', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  preflightBackendLaunch: vi.fn(() => ({ ok: true })),
}));

const codexPreflightHomeMock = vi.hoisted(() =>
  vi.fn(async (_account: string | undefined, _workspaceId: string) => null as string | null),
);
const codexPreflightModelMock = vi.hoisted(() => vi.fn());
vi.mock('../../inference-gateway/codex-oauth-proxy', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveCodexPreflightHome: (account: string | undefined, workspaceId: string) =>
    codexPreflightHomeMock(account, workspaceId),
  preflightCodexModel: (...args: unknown[]) => codexPreflightModelMock(...args),
}));

// Typed against the REAL SpawnConsoleResult (type-only import — not mocked away)
// so the mocks cannot silently drift from the spawn contract again (WI-4488: the
// EI-8289 display/desktopEnvResolvedVia refactor left inferred-shape mocks stale).
const spawnConsoleMock = vi.fn(
  async (_opts: unknown): Promise<SpawnConsoleResult> => ({
    status: 'ok',
    pid: 4242,
    terminalPid: 4343,
    terminal: 'xterm',
    child: {} as never,
    display: ':1',
    desktopEnvResolvedVia: 'active-seat',
  }),
);
const headlessSpawnResult = (
  childExit?: Promise<SpawnChildExit>,
  kickoffProof: KickoffProofResult | null = {
    persisted: true,
    nativeRef: '/native/launch.jsonl',
    reason: null,
  },
): SpawnConsoleResult => ({
    status: 'ok',
    pid: 777,
    terminal: 'headless',
    taskId: 'task777',
    logPath: '/tmp/papercusp-ws/fleet-logs/judge.log',
    normalizedLogPath: '/tmp/papercusp-ws/fleet-logs/judge.normalized.log',
    child: {} as never,
    display: null,
    desktopEnvResolvedVia: null,
    ...(childExit ? { childExit } : {}),
    ...(kickoffProof ? { kickoffProof } : {}),
});
const HEADLESS_RESUME_LOG_PATH = '/tmp/papercusp-ws/fleet-logs/judge.log';
const spawnHeadlessMock = vi.fn(
  async (_opts: unknown): Promise<SpawnConsoleResult> => headlessSpawnResult(),
);
const spawnGovernedAgentProcessMock = vi.fn(
  (_input: unknown, spawnProcess: (context: Record<string, unknown>) => Promise<SpawnConsoleResult>) =>
    spawnProcess({ receiptId: 'WI-governed-test', leaseId: 'lease-governed-test' }),
);
const getFleetHeadcountTargetMock = vi.hoisted(() => vi.fn());
const createFleetIfAbsentMock = vi.hoisted(() => vi.fn());
const getFleetSchemeMock = vi.hoisted(() => vi.fn());
vi.mock('../../console-spawn', () => ({
  spawnConsole: (o: unknown) => spawnConsoleMock(o),
  spawnHeadless: (o: unknown) => spawnHeadlessMock(o),
}));
vi.mock('../../resource-governor/spawn-execution', () => ({
  spawnGovernedAgentProcess: (input: unknown, spawnProcess: (context: Record<string, unknown>) => Promise<SpawnConsoleResult>) =>
    spawnGovernedAgentProcessMock(input, spawnProcess),
}));

const latestFleetMembershipMock = vi.hoisted(() => vi.fn());
vi.mock('../../fleet-membership-store', () => ({
  latestFleetMembership: (workspaceId: string, ownerId: string) => latestFleetMembershipMock(workspaceId, ownerId),
}));

vi.mock('../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  fleetSlugFromName: (name: string) => name.toLowerCase().replace(/\s+/g, '-'),
  createFleetIfAbsent: (...args: unknown[]) => createFleetIfAbsentMock(...args),
  getFleetHeadcountTarget: (...args: unknown[]) => getFleetHeadcountTargetMock(...args),
  getFleetScheme: (...args: unknown[]) => getFleetSchemeMock(...args),
}));

const fetchPresenceFleetMock = vi.fn(
  async (_ids: string[]) => new Map<string, { fleetSlug: string | null; fleetRole: string | null }>(),
);
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: (ids: string[]) => fetchPresenceFleetMock(ids),
}));

const fetchContextPressureMock = vi.fn(async (_ids: string[]) => new Map<string, 'ok' | 'high' | 'critical'>());
vi.mock('../coordination/context-pressure', () => ({
  fetchContextPressure: (ids: string[]) => fetchContextPressureMock(ids),
}));

const neutralSuccessorGuardMock = vi.hoisted(() => vi.fn());
vi.mock('../../lineage-neutral-successor-guard', () => ({
  findLineageNeutralSuccessorRefusal: (...args: unknown[]) => neutralSuccessorGuardMock(...args),
  renderLineageNeutralSuccessorRefusal: (refusal: { message: string }) =>
    `lineage_neutral_successor_refused: ${refusal.message}`,
}));

const clearContextEstimateMock = vi.hoisted(() => vi.fn(async (_ownerId: string) => {}));
vi.mock('../coordination/presence', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  clearContextEstimate: (ownerId: string) => clearContextEstimateMock(ownerId),
}));

const buildCarryBriefMock = vi.hoisted(() => vi.fn());
const renderCarryBriefTextMock = vi.hoisted(() => vi.fn());
vi.mock('../../carry-brief', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildCarryBrief: (...args: unknown[]) => buildCarryBriefMock(...args),
  renderCarryBriefText: (...args: unknown[]) => renderCarryBriefTextMock(...args),
}));

// Mutable so a test can model an UNATTRIBUTED caller (no owner id), which is what
// gates the fresh/fork launch verifier — see the EI-21725123573114023 case below.
const callerIdentity = vi.hoisted(() => ({
  current: {
    ownerId: 'su-caller' as string | null,
    ownerLabel: 'su',
    source: 'psu',
    workspaceId: 'ws-test',
    userId: null,
  },
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => callerIdentity.current,
}));

// The shared core: the resolver + idempotency ledger hit PG, so they are stubbed;
// the pure command builders/injectors run FOR REAL (they are what we're pinning).
const resolveResumeTargetMock = vi.fn();
// Both mocks are CALLED with one argument below, so they must DECLARE one —
// a zero-arg vi.fn() is a TS2554 the vitest run cannot see (esbuild strips types,
// so the suite stays green while the file is type-broken). Same shape as the
// claimAgentLaunchMock/recordAgentLaunchResultMock pair further down.
const verifyFreshLaunchStartedMock = vi.fn(async (_args: unknown) => ({
  // agentStarted is deliberately THREE-state (true | false | null) per D-004 —
  // null means "not yet determinable", which is the stub's honest answer.
  agentStarted: null as boolean | null,
  waitedMs: 0,
  sessions: [] as Array<{ ownerId: string; advSessionId?: number; sessionId?: string | null; successfulCalls: number }>,
  note: 'test launch verification stub',
}));
const verifyResumeStartedMock = vi.fn(async (_ownerId: unknown, opts?: { expectedSessionId?: string | null }) => ({
  started: true as boolean | null,
  waitedMs: 0,
  expectedSessionId: opts?.expectedSessionId ?? null,
  actualSessionId: opts?.expectedSessionId ?? null,
  mismatch: false,
}));
const claimAgentLaunchMock = vi.fn(
  async (
    _opts: unknown,
  ): Promise<{
    won: boolean;
    priorSummary: Record<string, unknown> | null;
    priorLaunchedAt: number | null;
    priorLaunchedBy: string | null;
  }> => ({ won: true, priorSummary: null, priorLaunchedAt: null, priorLaunchedBy: null }),
);
const recordAgentLaunchResultMock = vi.fn(async (_opts: unknown): Promise<boolean> => false);
const releaseAgentLaunchClaimMock = vi.fn(async (_opts: unknown) => true);
const waitForPtyHostGoneMock = vi.fn(async (_ownerId: unknown) => true);
vi.mock('../../agent-launch-core', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveResumeTarget: (ref: unknown) => resolveResumeTargetMock(ref as never),
  verifyFreshLaunchStarted: (args: unknown) => verifyFreshLaunchStartedMock(args as never),
  verifyResumeStarted: (ownerId: unknown, opts: unknown) => verifyResumeStartedMock(ownerId as never, opts as never),
  waitForPtyHostGone: (ownerId: unknown) => waitForPtyHostGoneMock(ownerId),
  claimAgentLaunch: (o: unknown) => claimAgentLaunchMock(o),
  recordAgentLaunchResult: (o: unknown) => recordAgentLaunchResultMock(o),
  releaseAgentLaunchClaim: (o: unknown) => releaseAgentLaunchClaimMock(o),
}));

const launchAgentModule = await import('./launch-agent');
const launchAgent = launchAgentModule.default;
const { goalHolderPlanFleetBypass, INTERNAL_LOOP_FIRE_ORIGIN, INTERNAL_SCOPED_INFERENCE_GATEWAY, INTERNAL_SCOPED_SESSION_CONFINEMENT,
  INTERNAL_BACKEND_BIN_OVERRIDE, INTERNAL_INTERRUPTION_RECOVERY } = launchAgentModule;

const ctx = { workspaceId: 'ws-test', harnessSlug: 'papercusp', role: 'su' } as never;
const textOf = (res: unknown): string => (res as { content: Array<{ text: string }> }).content[0].text;
const dataOf = (res: unknown) => (res as { data?: { deduped?: boolean; launch?: Record<string, unknown>; launchFailure?: { stage: string; processesOpened: number } } }).data;
const isError = (res: unknown): boolean => !!(res as { isError?: boolean }).isError;
/** The command the tool actually handed to the spawner. */
const spawnedCommand = (mock = spawnConsoleMock): string =>
  (mock.mock.calls[0][0] as unknown as { envelope: { greetingCmd: string } }).envelope.greetingCmd;
const spawnedEnv = (mock = spawnConsoleMock): Record<string, string> =>
  (mock.mock.calls[0][0] as unknown as { envelope: { env: Record<string, string> } }).envelope.env;

beforeEach(() => {
  originalRoutingGuardMock.mockReset();
  vi.clearAllMocks();
  resolveNamedIdentityCompositionSelectionMock.mockReset().mockImplementation(async (id: string) => ({
    id, stack: ['domain:review-domain', 'practice:careful-review'],
    sourcePath: '/repo/blueprint.yaml', sourceRevision: 'pinned-composition-revision', layers: [],
  }));
  inspectBlindReviewResumeTargetMock.mockReset().mockResolvedValue({ binding: null, recruiterLaunch: false });
  verifyBlindReviewSessionResumeBindingMock.mockReset().mockResolvedValue({ ok: true });
  goalLaunchResolveMock.mockReset();
  declareCouplingMock.mockReset().mockResolvedValue({ agentA: 'su-caller', agentB: 'su-verifier' });
  rmSync(HEADLESS_RESUME_LOG_PATH, { force: true });
  assembleRolePromptMock.mockReturnValue({ text: 'role prompt', meta: { projectDir: '/repo' } });
  readPsuLaunchLogTailMock.mockReturnValue(null);
  codexThreadWriterHolderMock.mockReset().mockReturnValue({
    held: false,
    pid: null,
    lockPath: null,
    sessionId: null,
    reason: 'no-lock-file',
  });
  codexPreflightHomeMock.mockResolvedValue(null);
  codexPreflightModelMock.mockReset();
  claimAgentLaunchMock.mockResolvedValue({
    won: true,
    priorSummary: null,
    priorLaunchedAt: null,
    priorLaunchedBy: null,
  });
  recordAgentLaunchResultMock.mockReset().mockImplementation(async (opts: unknown) => {
    const summary = (opts as { summary?: { launchState?: string } }).summary;
    // Progress must be durable before a spawn; leave the final completion write
    // unconfirmed unless a test explicitly opts into a durable receipt.
    return summary?.launchState === 'spawning';
  });
  callerIdentity.current.ownerId = 'su-caller';
  releaseAgentLaunchClaimMock.mockResolvedValue(true);
  markAdvSessionEndedMock.mockReset();
  markAdvSessionEndedMock.mockResolvedValue(true);
  acquireAdvSessionResumeMock.mockReset().mockResolvedValue({
    acquired: true, status: 'acquired', replayed: false,
    leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  releaseAdvSessionResumeMock.mockReset().mockResolvedValue(true);
  readAdvSessionLaunchRecordByOwnerMock.mockReset().mockResolvedValue(null);
  resolveSessionStatesMock.mockReset();
  listSuccessorTasksMock.mockReset().mockResolvedValue([]);
  resolveSessionStatesMock.mockResolvedValue(new Map([['su-a1a71', { sessionState: 'ended' }]]));
  fetchPresenceFleetMock.mockResolvedValue(new Map());
  latestFleetMembershipMock.mockResolvedValue(null);
  fetchContextPressureMock.mockResolvedValue(new Map());
  neutralSuccessorGuardMock.mockReset().mockResolvedValue(null);
  clearContextEstimateMock.mockReset().mockResolvedValue(undefined);
  buildCarryBriefMock.mockResolvedValue({ ownerId: 'su-a1a71' });
  renderCarryBriefTextMock.mockReturnValue('');
  verifyFreshLaunchStartedMock.mockResolvedValue({
    agentStarted: null,
    waitedMs: 0,
    sessions: [] as Array<{ ownerId: string; advSessionId?: number; sessionId?: string | null; successfulCalls: number }>,
    note: 'test launch verification stub',
  });
  armInboxWakeMock.mockReset().mockResolvedValue({
    awaitId: 123,
    eventKey: 'coord:inbox-wake:su-headless',
    handleNote: 'test handle',
    minSleepSec: 60,
  });
  verifyResumeStartedMock.mockResolvedValue({
    started: true,
    waitedMs: 0,
    expectedSessionId: 'sid-dead',
    actualSessionId: 'sid-dead',
    mismatch: false,
  });
  shutdownViaPtyMock.mockResolvedValue('sent');
  findLiveHostMock.mockReturnValue({ ownerId: 'su-a1a71', pid: 42, sock: '/run/host.sock' });
  windowScopeVerdictMock.mockReturnValue('dead');
  waitForPtyHostGoneMock.mockResolvedValue(true);
  getModesMock.mockResolvedValue([]);
  gateWorkScopeMock.mockResolvedValue({ allowed: true, reason: 'no-policy' });
  resolveAcceptedOperationWorkerBindingMock.mockResolvedValue(null);
  listFactsMock.mockResolvedValue([]);
  getLoopStatusMock.mockResolvedValue(null);
  getFleetHeadcountTargetMock.mockResolvedValue(null);
  createFleetIfAbsentMock.mockResolvedValue({ record: null, created: false });
  getFleetSchemeMock.mockImplementation(async (_ws: string, slug: string) =>
    slug === 'alpha-fleet' ? { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' } : null,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('launch-tool routing guidance', () => {
  it('does not hold a workspace transaction across external launch and first-turn proof', () => {
    expect((launchAgent as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('identifies capability:launch-agent as the ad-hoc/recovery door, not the existing-plan fleet door', () => {
    expect(launchAgent.guidance?.when).toContain('AD-HOC/RECOVERY AGENT-LAUNCH DOOR');
    expect(launchAgent.guidance?.when).toContain('visible or headless');
    expect(launchAgent.guidance?.when).toContain('fleet or unfleeted');
    expect(launchAgent.guidance?.when).toContain('fleet:launch-on-plan');
    expect(launchAgent.guidance?.when).toContain('Duplicate screening never delays process launch');
    expect(launchAgent.description).toMatch(/spawn is not proof of registration, a first turn, or a work claim/i);
    expect(launchAgent.description).toContain('read launch verification');
    expect(launchAgent.description).not.toContain('starts working immediately');
    expect(launchAgent.guidance?.notWhen).toContain('capability:terminal');
  });

  // WI-4753: the canonical routing doc must stay linked from every door's
  // guidance, not just fleet:launch-on-plan's — a recurrence guard so the
  // cross-link can't silently drop on a future guidance edit.
  it('cross-links the canonical four-door routing table', () => {
    expect(launchAgent.guidance?.notWhen).toContain('launching-agents-which-tool-for-which-door');
  });

  it('routes returned process task handles to the process tools', () => {
    const seeAlso = launchAgent.guidance?.seeAlso;
    expect(Array.isArray(seeAlso) ? seeAlso.join('\n') : '').toContain(
      'processes:list / processes:kill (returned tasks[].taskId handles; not tasks:get)',
    );
  });

  it('declares enough server budget for bounded headless launch verification (EI-22780156976598155)', () => {
    expect((launchAgent as { timeoutSec?: number }).timeoutSec).toBe(AGENT_LAUNCH_HANDLER_TIMEOUT_SEC);
    expect((launchAgent as { timeoutSec?: number }).timeoutSec).toBeGreaterThan(55);
  });
});

describe('shared model alias preflight', () => {
  it('echoes the same resolved tuple used for the actual launch', async () => {
    const result = await launchAgent.handler({ model: 'sol 6.1', effort: 'xhigh', brief: 'Verify a lane' }, ctx);
    expect(result).toMatchObject({ data: { modelResolution: {
      requested: 'sol 6.1', agent: 'codex', model: 'gpt-6.1-sol:xhigh', effort: 'xhigh',
    } } });
    expect(spawnedCommand()).toContain('--agent=codex');
    expect(spawnedCommand()).toContain('--model=gpt-6.1-sol:xhigh');
  });

  it('echoes the normalized Claude effort that reaches the command', async () => {
    const result = await launchAgent.handler({ model: 'claude opus', effort: 'xhigh', brief: 'Verify a lane' }, ctx);
    expect(result).toMatchObject({ data: { modelResolution: {
      agent: 'claude', model: 'opus:max', effort: 'max',
    } } });
    expect(spawnedCommand()).toContain('--model=opus:max');
  });

  it('normalizes a member override before composing its command', async () => {
    const result = await launchAgent.handler({ brief: 'Verify a lane', members: [{ model: 'claude opus', effort: 'xhigh' }] }, ctx);
    expect(result).toMatchObject({ data: { modelResolution: {
      requested: 'claude opus', agent: 'claude', model: 'opus:max', effort: 'max',
    } } });
    expect(spawnedCommand()).toContain('--model=opus:max');
  });

  it('preserves the requested default effort for a different member backend', async () => {
    const result = await launchAgent.handler({ model: 'claude opus', effort: 'xhigh', brief: 'Verify a lane', members: [{ model: 'sol 6.1' }] }, ctx);
    expect(result).toMatchObject({ data: { modelResolution: {
      requested: 'sol 6.1', agent: 'codex', model: 'gpt-6.1-sol:xhigh', effort: 'xhigh',
    } } });
    expect(spawnedCommand()).toContain('--model=gpt-6.1-sol:xhigh');
  });

  it('echoes each effective member model for a heterogeneous batch', async () => {
    const result = await launchAgent.handler({ model: 'claude opus', effort: 'xhigh', brief: 'Verify a lane',
      members: [{ model: 'sol 6.1' }, { model: 'claude sonnet', effort: 'low' }] }, ctx);
    expect(result).toMatchObject({ data: { modelResolution: null, memberModelResolutions: [
      { requested: 'sol 6.1', agent: 'codex', model: 'gpt-6.1-sol:xhigh', effort: 'xhigh' },
      { requested: 'claude sonnet', agent: 'claude', model: 'sonnet:low', effort: 'low' },
    ] } });
    const commands = spawnConsoleMock.mock.calls.map(
      ([opts]) => (opts as { envelope: { greetingCmd: string } }).envelope.greetingCmd,
    ).join('\n');
    expect(commands).toContain('--model=gpt-6.1-sol:xhigh');
    expect(commands).toContain('--model=sonnet:low');
  });

  it('accepts the same top-level model and effort shape as the fleet door', () => {
    const parsed = launchAgent.args.safeParse({ brief: 'Verify a lane', model: 'sol 6.1', effort: 'xhigh' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.effort).toBe('xhigh');
  });

  it('returns candidates before placement for unknown and ambiguous aliases', async () => {
    for (const [model, error] of [['mystery', 'unknown_model_alias'], ['6', 'ambiguous_model_alias']]) {
      const result = await launchAgent.handler({ brief: 'Verify a lane', model }, ctx);
      expect(result).toMatchObject({
        isError: true,
        data: { error, candidates: expect.arrayContaining([expect.objectContaining({ model: 'gpt-6-sol' })]) },
      });
    }
    expect(goalLaunchResolveMock).not.toHaveBeenCalled();
  });
});

describe('GOAL alternate plan-placement entry guard (P-006 / A-04)', () => {
  it('classifies only a fresh plan+fleet launch by the current GOAL holder', () => {
    const modes = [{ mode: 'goal', subject: 'goal-1' }];
    expect(
      goalHolderPlanFleetBypass({ sourceAction: false, plan: 'plan-a', fleet: 'fleet-a', modeRows: modes }),
    ).toEqual({ goalId: 'goal-1' });
    expect(
      goalHolderPlanFleetBypass({ sourceAction: true, plan: 'plan-a', fleet: 'fleet-a', modeRows: modes }),
    ).toBeNull();
    expect(goalHolderPlanFleetBypass({ sourceAction: false, plan: 'plan-a', fleet: null, modeRows: modes })).toBeNull();
    expect(
      goalHolderPlanFleetBypass({ sourceAction: false, plan: null, fleet: 'fleet-a', modeRows: modes }),
    ).toBeNull();
    expect(
      goalHolderPlanFleetBypass({ sourceAction: false, plan: 'plan-a', fleet: 'fleet-a', modeRows: [] }),
    ).toBeNull();
  });

  it('refuses the alternate fresh plan+fleet path before fleet creation or spawn', async () => {
    getModesMock.mockResolvedValue([{ mode: 'goal', subject: 'goal-1', ownerDirected: true }]);
    const res = await launchAgent.handler(
      { brief: 'work plan-a', plan: 'plan-a', fleet: 'plan-a-fleet', harness: 'papercusp' },
      ctx,
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('goal_plan_placement_bypass_refused');
    expect(textOf(res)).toContain('fleet:launch-on-plan');
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('fails closed on unreadable authority only for the bypass-capable shape', async () => {
    getModesMock.mockRejectedValue(new Error('mode store unavailable'));
    const res = await launchAgent.handler(
      { brief: 'work plan-a', plan: 'plan-a', fleet: 'plan-a-fleet', harness: 'papercusp' },
      ctx,
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('goal_plan_placement_authority_unreadable');
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
  });

  it('keeps a plan-bound independent grader outside a fleet available', async () => {
    getModesMock.mockResolvedValue([{ mode: 'goal', subject: 'goal-1', ownerDirected: true }]);
    const res = await launchAgent.handler(
      {
        brief: 'independently grade plan-a',
        plan: 'plan-a',
        independent: true,
        harness: 'papercusp',
        headless: false,
      },
      ctx,
    );
    expect(isError(res)).toBe(false);
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(dataOf(res)?.launch).toMatchObject({ fleet: null, independent: true, mode: 'fresh' });
  });

  it.each([['grade', 'grading'], ['test', 'test']] as const)('launches a GOAL %s verifier with its profile, first-turn mode and holder coupling', async (goalVerifier, goalRole) => {
    getModesMock.mockResolvedValue([{ mode: 'goal', subject: 'goal-1', ownerDirected: true }]);
    goalLaunchResolveMock.mockResolvedValueOnce({
      goalId: 'goal-1', settings: null,
      effective: { account: 'default', model: 'sonnet', carry: 'cold' }, refusal: null, budget: null, goalBrief: null,
      ceilings: { maxAgents: 12, maxPerFleet: 5 },
      headcount: { total: 1, fleet: null }, degraded: false, degradedReasons: [],
    });
    const res = await launchAgent.handler({ brief: 'Verify the goal independently', goalVerifier, harness: 'papercusp', mcpTarget: 'spawn-host' }, ctx);
    expect(isError(res)).toBe(false);
    const envelopeInput = buildConsoleEnvelopeMock.mock.calls[0]?.[0] as { operatorBaseUrl: string; agentMcpBaseUrl?: string };
    expect(envelopeInput.agentMcpBaseUrl).toBe(envelopeInput.operatorBaseUrl);
    expect(goalLaunchResolveMock).toHaveBeenCalledWith(expect.objectContaining({ goalRole }));
    expect(spawnedCommand()).toContain(`--mode=${goalVerifier}`);
    expect(spawnedCommand()).toContain('--model=sonnet');
    expect(spawnedCommand()).toContain('--carry=cold');
    expect(dataOf(res)?.launch).toMatchObject({ fleet: null, goalVerifier, verifierCoupling: { status: 'coupled', holderId: 'su-caller' } });
    expect(declareCouplingMock).toHaveBeenCalledWith(expect.objectContaining({ agentA: 'su-caller', declaredBy: 'su-caller', workspaceId: 'ws-test' }));
  });

  it('refuses a GOAL verifier without holder authority before opening a process', async () => {
    const res = await launchAgent.handler({ brief: 'Grade my goal', goalVerifier: 'grade' }, ctx);
    expect(isError(res)).toBe(true);
    expect(dataOf(res)?.launchFailure).toEqual({ stage: 'pre-spawn', processesOpened: 0 });
    expect(textOf(res)).toContain('active, attributed GOAL holder');
    expect(JSON.parse(JSON.stringify(dataOf(res)))).toMatchObject({
      ok: false,
      error: expect.stringContaining('active, attributed GOAL holder'),
    });
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('keeps the stable MCP target for an ordinary launch by default', async () => {
    const res = await launchAgent.handler({ brief: 'Ordinary agent work', harness: 'papercusp' }, ctx);
    expect(isError(res)).toBe(false);
    expect(buildConsoleEnvelopeMock.mock.calls[0]?.[0]).not.toHaveProperty('agentMcpBaseUrl');
  });

  it('refuses plan-bound and raw-flag verifier launches before opening a process', async () => {
    getModesMock.mockResolvedValue([{ mode: 'goal', subject: 'goal-1', ownerDirected: true }]);
    for (const args of [
      { plan: 'plan-a' },
      { extraArgs: ['--mode=drain'] },
    ]) {
      const res = await launchAgent.handler({ brief: 'Verify independently', goalVerifier: 'test', ...args }, ctx);
      expect(isError(res)).toBe(true);
    }
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });
});

const declareConfinementMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('../../capability-envelope/session-confinement-store', async original => ({
  ...await original<typeof import('../../capability-envelope/session-confinement-store')>(),
  declareSessionConfinement: declareConfinementMock,
}));
const scopedCeiling = { denyTools: [], denyOutside: ['coord:whoami', 'work_items:get', 'work_items:checkpoint'],
  imposedBy: 'benchmark-host', reason: 'one metered gateway' };
describe('internal launch context provenance', () => {
  it('carries a typed Docker boundary only from the private metered controller context', async () => {
    const binding = { kind: 'docker-exec', command: '/tmp/private-current-container/codex', sha256: 'a'.repeat(64) };
    const privateCtx = { workspaceId: 'ws-test', role: 'su',
      [INTERNAL_SCOPED_INFERENCE_GATEWAY]: { baseURL: 'http://127.0.0.1:32101', token: 'b'.repeat(64) },
      [INTERNAL_SCOPED_SESSION_CONFINEMENT]: scopedCeiling,
      [INTERNAL_BACKEND_BIN_OVERRIDE]: { codex: binding } } as never;
    const result = await launchAgent.handler({ brief: 'Container task', harness: 'papercusp', agent: 'codex', headless: true }, privateCtx);
    expect(isError(result)).toBe(false);
    const env = spawnedEnv(spawnHeadlessMock);
    expect(env.PAPERCUSP_BACKEND_BIN_CODEX).toBe(binding.command);
    expect(JSON.parse(env.PAPERCUSP_NATIVE_CONTAINER_EXEC)).toEqual(binding);
  });
  it('refuses container authority without a private metered controller before opening a process', async () => {
    const result = await launchAgent.handler({ brief: 'Container task', harness: 'papercusp', agent: 'codex', headless: true },
      { workspaceId: 'ws-test', role: 'su', [INTERNAL_BACKEND_BIN_OVERRIDE]: {
        codex: { kind: 'docker-exec', command: '/tmp/codex', sha256: 'a'.repeat(64) } } } as never);
    expect(isError(result)).toBe(true);
    expect(JSON.stringify(result)).toMatch(/private metered Codex/);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });
  it('threads the private controller route only through a fresh supported host context', async () => {
    const gateway = { baseURL: 'http://127.0.0.1:32101', token: 'a'.repeat(64) };
    const privateCtx = { workspaceId: 'ws-test', role: 'su', [INTERNAL_SCOPED_INFERENCE_GATEWAY]: gateway,
      [INTERNAL_SCOPED_SESSION_CONFINEMENT]: scopedCeiling,
      [INTERNAL_BACKEND_BIN_OVERRIDE]: { codex: '/tmp/private-current-container/codex' } } as never;
    const res = await launchAgent.handler({ brief: 'Private native task', harness: 'papercusp', agent: 'codex', headless: true }, privateCtx);
    expect(isError(res)).toBe(false);
    expect(JSON.parse(spawnedEnv(spawnHeadlessMock).PAPERCUSP_SCOPED_INFERENCE_GATEWAY)).toEqual(gateway);
    expect(spawnedEnv(spawnHeadlessMock).PAPERCUSP_BACKEND_BIN_CODEX).toBe('/tmp/private-current-container/codex');
    expect(spawnedCommand(spawnHeadlessMock)).not.toContain(gateway.token);
    expect(declareConfinementMock).toHaveBeenCalledWith({ ownerId: expect.stringMatching(/^su-/),
      workspaceId: 'ws-test', confinement: scopedCeiling });
    expect(declareConfinementMock.mock.invocationCallOrder.at(-1)).toBeLessThan(spawnHeadlessMock.mock.invocationCallOrder[0]);
  });
  // benchmark-coverage-frontierswe-v2-2026-10-10 D-026: the bench runner pins the CLI to a
  // container-exec wrapper through a context symbol that no MCP argument can carry.
  it('delivers a backend binary override to the headless child as PAPERCUSP_BACKEND_BIN_<AGENT>', async () => {
    const res = await launchAgent.handler(
      { brief: 'Container task', harness: 'papercusp', agent: 'codex', headless: true },
      { workspaceId: 'ws-test', role: 'su', [INTERNAL_BACKEND_BIN_OVERRIDE]: { codex: '/tmp/papercusp-cexec-t/codex' } } as never,
    );
    expect(isError(res)).toBe(false);
    expect(spawnedEnv(spawnHeadlessMock).PAPERCUSP_BACKEND_BIN_CODEX).toBe('/tmp/papercusp-cexec-t/codex');
  });
  it.each([
    ['a visible launch', { headless: false }, { codex: '/tmp/papercusp-cexec-t/codex' }, /fresh headless launch/],
    ['an unknown agent', { headless: true }, { gemini: '/tmp/x/gemini' }, /unknown agent: gemini/],
    ['a relative path', { headless: true }, { codex: 'cexec/codex' }, /absolute path/],
  ])('refuses a backend binary override on %s before opening a process', async (_label, patch, override, message) => {
    const res = await launchAgent.handler(
      { brief: 'Container task', harness: 'papercusp', agent: 'codex', ...patch },
      { workspaceId: 'ws-test', role: 'su', [INTERNAL_BACKEND_BIN_OVERRIDE]: override } as never,
    );
    expect(isError(res)).toBe(true);
    expect(JSON.stringify(res)).toMatch(message);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });
  it('a plain launch carries no backend override env', async () => {
    const res = await launchAgent.handler(
      { brief: 'Plain task', harness: 'papercusp', agent: 'codex', headless: true },
      { workspaceId: 'ws-test', role: 'su' } as never,
    );
    expect(isError(res)).toBe(false);
    expect(Object.keys(spawnedEnv(spawnHeadlessMock)).filter((k) => k.startsWith('PAPERCUSP_BACKEND_BIN_'))).toEqual([]);
    expect(spawnedEnv(spawnHeadlessMock).PAPERCUSP_NATIVE_CONTAINER_EXEC).toBeUndefined();
  });
  it('refuses missing or failed durable server tool confinement before opening a process', async () => {
    const privateCtx = { workspaceId: 'ws-test', role: 'su', [INTERNAL_SCOPED_INFERENCE_GATEWAY]:
      { baseURL: 'http://127.0.0.1:32101', token: 'a'.repeat(64) } };
    const args = { brief: 'Private task', harness: 'papercusp', agent: 'codex' as const, headless: true };
    expect(isError(await launchAgent.handler(args, privateCtx as never))).toBe(true);
    declareConfinementMock.mockRejectedValueOnce(new Error('store down'));
    expect(isError(await launchAgent.handler(args, { ...privateCtx,
      [INTERNAL_SCOPED_SESSION_CONFINEMENT]: scopedCeiling } as never))).toBe(true);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });
  // WI-6554700010008492: before this, a confinement passed WITHOUT a scoped gateway was
  // silently dropped, so a blind reviewer launched "confined" ran with every tool.
  it('installs a gateway-less session confinement before opening a process', async () => {
    const denyOnly = { denyTools: ['plans:get'], imposedBy: 'blind-reviewer-mint', reason: 'blind review' };
    const res = await launchAgent.handler({ brief: 'Blind review', harness: 'papercusp', headless: true },
      { workspaceId: 'ws-test', role: 'su', [INTERNAL_SCOPED_SESSION_CONFINEMENT]: denyOnly } as never);
    expect(isError(res)).toBe(false);
    expect(declareConfinementMock).toHaveBeenCalledWith({ ownerId: expect.stringMatching(/^su-/),
      workspaceId: 'ws-test', confinement: denyOnly });
    expect(declareConfinementMock.mock.invocationCallOrder.at(-1)).toBeLessThan(spawnHeadlessMock.mock.invocationCallOrder[0]);
  });
  it('refuses a gateway-less confinement on a resumed identity before opening a process', async () => {
    const denyOnly = { denyTools: ['plans:get'], imposedBy: 'blind-reviewer-mint', reason: 'blind review' };
    const res = await launchAgent.handler({ brief: 'Blind review', harness: 'papercusp', resume: { agentId: 'su-a1a71' } } as never,
      { workspaceId: 'ws-test', role: 'su', [INTERNAL_SCOPED_SESSION_CONFINEMENT]: denyOnly } as never);
    expect(isError(res)).toBe(true);
    expect(declareConfinementMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });
  it('refuses private unsupported or multi-process launches before opening a process', async () => {
    const privateCtx = { workspaceId: 'ws-test', role: 'su', [INTERNAL_SCOPED_INFERENCE_GATEWAY]:
      { baseURL: 'http://127.0.0.1:32101', token: 'a'.repeat(64) } } as never;
    for (const args of [{ agent: 'claude' as const }, { agent: 'codex' as const, count: 2 },
      { members: [{ agent: 'codex' as const }, { agent: 'codex' as const }] }]) {
      const res = await launchAgent.handler({ brief: 'Refused', harness: 'papercusp', ...args }, privateCtx);
      expect(isError(res)).toBe(true);
    }
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });
  it('does not set the private kickoff origin for ordinary callers', async () => {
    const res = await launchAgent.handler({ brief: 'Ordinary agent work', harness: 'papercusp' }, ctx);
    expect(isError(res)).toBe(false);
    expect(spawnedEnv()).not.toHaveProperty('PAPERCUSP_INTERNAL_KICKOFF_ORIGIN');
  });

  it('threads loop-fire provenance only through the internal handler context', async () => {
    const internalCtx = {
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      role: 'su',
      [INTERNAL_LOOP_FIRE_ORIGIN]: 'loop-fire',
    } as never;
    const res = await launchAgent.handler(
      { brief: 'Continue the loop from its checkpoint', harness: 'papercusp', headless: true },
      internalCtx,
    );
    expect(isError(res)).toBe(false);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnedEnv(spawnHeadlessMock).PAPERCUSP_INTERNAL_KICKOFF_ORIGIN).toBe('loop-fire');
  });

  it('threads typed loop-fire identity only through the internal handler context', async () => {
    const loopFire = { routineId: 'loop-internal', wakeCount: 7 };
    const res = await launchAgent.handler(
      { brief: 'Continue the loop', harness: 'papercusp', headless: true },
      { workspaceId: 'ws-test', harnessSlug: 'papercusp', role: 'su',
        [INTERNAL_LOOP_FIRE_ORIGIN]: { origin: 'loop-fire', loopFire } } as never,
    );
    expect(isError(res)).toBe(false);
    expect(JSON.parse(spawnedEnv(spawnHeadlessMock).PAPERCUSP_INTERNAL_KICKOFF_ORIGIN)).toEqual({ origin: 'loop-fire', loopFire });
  });

  it('does not forward malformed private loop identity', async () => {
    const res = await launchAgent.handler(
      { brief: 'Continue the loop', harness: 'papercusp', headless: true },
      { workspaceId: 'ws-test', role: 'su',
        [INTERNAL_LOOP_FIRE_ORIGIN]: { origin: 'loop-fire', loopFire: { routineId: 'loop', wakeCount: 0 } } } as never,
    );
    expect(isError(res)).toBe(false);
    expect(spawnedEnv(spawnHeadlessMock).PAPERCUSP_INTERNAL_KICKOFF_ORIGIN).toBe('loop-fire');
  });
});

describe('GOAL admission receipt (EI-25166050736574344)', () => {
  it('keeps the batch check separate from each final decision and persists a later member refusal', async () => {
    goalLaunchResolveMock.mockResolvedValueOnce({
      goalId: 'goal-1', settings: null, goalBrief: null, effective: {},
      ceilings: { maxAgents: 6, maxPerFleet: 3 }, headcount: { total: 0, fleet: null },
      headcountMeasurement: { measuredAt: 'preflight', populationComplete: true,
        candidate: { total: 0, fleet: null }, counted: [], oracleEndedOwnerIds: [], excludedOwnerIds: [] },
      budget: null, refusal: null, degraded: false, degradedReasons: [],
    });
    const final = { stage: 'final', goalId: 'goal-1', decision: 'admitted', headcount: { total: 5, fleet: null },
      measurement: { measuredAt: 'final-first', populationComplete: false, counted: [], excludedOwnerIds: ['retained'] } };
    const refused = { ...final, decision: 'refused', headcount: { total: 6, fleet: null },
      measurement: { ...final.measurement, measuredAt: 'final-second' } };
    spawnGovernedAgentProcessMock.mockImplementationOnce(async (_input, spawnProcess) => ({
      ...await spawnProcess({ receiptId: 'WI-final-first', leaseId: 'lease-final-first' }),
      admissionContext: { receiptId: 'WI-final-first' }, goalAdmission: final,
    }));
    spawnGovernedAgentProcessMock.mockImplementationOnce(async () => ({ status: 'error' as const, code: 409,
      error: 'final seat already reserved', goalAdmission: refused }));
    const result = await launchAgent.handler({ brief: 'Hermetic final receipt test', count: 2,
      idempotencyKey: 'final-member-receipt' }, ctx);
    const launch = dataOf(result)?.launch;
    expect(launch).toMatchObject({
      goalAdmission: { stage: 'batch-preflight', headcount: { total: 0, fleet: null } },
      finalGoalAdmissions: [
        { memberIndex: 0, receiptId: 'WI-final-first', admission: final, outcome: 'opened' },
        { memberIndex: 1, receiptId: null, admission: refused, outcome: 'failed' },
      ],
    });
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.objectContaining({ finalGoalAdmissions: launch?.finalGoalAdmissions }),
    }));
  });

  it.each([false, true])('persists the resolver measurement and unknown capacity on count failure=%s', async (countFailed) => {
    const measurement = {
      measuredAt: '2026-10-05 18:40:16+00', populationComplete: true,
      candidate: { total: 5, fleet: null },
      counted: Array.from({ length: 5 }, (_, index) => ({
        ownerId: `original-counted-owner-${index}`, inFleet: false, basis: 'boot-grace',
        heartbeatAt: null, briefUpdatedAt: '2026-10-05 18:40:16+00',
      })),
      oracleEndedOwnerIds: ['ended-owner'], excludedOwnerIds: ['replaced-owner'],
    };
    const resolution = {
      goalId: 'goal-1', settings: null, goalBrief: null, effective: {},
      ceilings: { maxAgents: 6, maxPerFleet: 3 },
      headcount: { total: countFailed ? 0 : 5, fleet: null },
      headcountMeasurement: countFailed ? null : measurement,
      budget: null, refusal: null, degraded: countFailed,
      degradedReasons: countFailed ? ['ceiling not enforced — headcount failed: fixture failure'] : [],
    };
    goalLaunchResolveMock.mockResolvedValueOnce(resolution);
    const idempotencyKey = `admission-receipt-${countFailed}`;
    const result = await launchAgent.handler({ brief: 'Hermetic receipt test', idempotencyKey }, ctx);
    expect(isError(result)).toBe(false);
    expect(goalLaunchResolveMock).toHaveBeenCalledTimes(1);
    const expected = {
      goalId: 'goal-1', requested: 1, ceilings: resolution.ceilings,
      headcount: countFailed ? null : resolution.headcount,
      measurement: resolution.headcountMeasurement,
      capacityStatus: countFailed ? 'unenforced' : 'enforced',
      degraded: countFailed, degradedReasons: resolution.degradedReasons,
    };
    expect(dataOf(result)?.launch).toMatchObject({ goalAdmission: expected });
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey, summary: expect.objectContaining({ goalAdmission: expect.objectContaining(expected) }),
    }));
  });
});

describe('published launch args schema', () => {
  it('publishes the conditional non-empty brief requirement at the tool level', () => {
    expect(launchAgent.description).toContain('`resume`/`fork` require a non-empty top-level `brief`');
    expect(launchAgent.description).toContain('system:lineage-neutral-successor');
  });

  it('publishes successor/restoreVisible mutual exclusion and the visible successor default', () => {
    const published = listMcpProjections().find((tool) => /launch[-_:]?agent/i.test(tool.name));
    expect(published).toBeDefined();
    if (!published) throw new Error('capability:launch-agent was not registered in the MCP projection');

    const schema = published.inputSchema as unknown as {
      type?: string;
      properties?: Record<string, { description?: string }>;
      dependentSchemas?: Record<string, unknown>;
    };
    expect(schema.type).toBe('object');
    expect(schema.dependentSchemas).toMatchObject({
      successor: { not: { required: ['restoreVisible'] } },
      restoreVisible: { not: { required: ['successor'] } },
    });
    expect(schema.properties?.successor?.description).toMatch(
      /visible by default when `headless` is omitted or `false`/i,
    );

    expect(
      launchAgent.args.safeParse({ successor: { agentId: 'su-a1a71' }, restoreVisible: true }).success,
    ).toBe(false);
    expect(
      launchAgent.args.safeParse({ successor: { agentId: 'su-a1a71' }, restoreVisible: false }).success,
    ).toBe(false);
  });

  it('rejects plan with resume or successor before handler dispatch', () => {
    expect(launchAgent.args.safeParse({ plan: 'p', resume: { agentId: 'su-a1a71' } }).success).toBe(false);
    expect(launchAgent.args.safeParse({ plan: 'p', successor: { agentId: 'su-a1a71' } }).success).toBe(false);
  });

  it('requires an actionable brief for source launches', () => {
    expect(launchAgent.args.safeParse({ plan: 'p' }).success).toBe(true);
    expect(launchAgent.args.safeParse({ resume: { agentId: 'su-a1a71' } }).success).toBe(false);
    expect(
      launchAgent.args.safeParse({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }).success,
    ).toBe(true);
    expect(launchAgent.args.safeParse({ successor: { agentId: 'su-a1a71' } }).success).toBe(true);
  });

  it('permits the brief-free neutral mode only on a resume and rejects prompt overrides', () => {
    const request = {
      resume: { agentId: 'su-a1a71' },
      successorLineageMode: 'system:lineage-neutral-successor',
    };
    expect(launchAgent.args.safeParse(request).success).toBe(true);
    expect(launchAgent.args.safeParse({ ...request, brief: 'caller prompt' }).success).toBe(false);
    expect(launchAgent.args.safeParse({ ...request, extraArgs: [] }).success).toBe(false);
    expect(launchAgent.args.safeParse({ ...request, carry: 'cold' }).success).toBe(false);
    expect(launchAgent.args.safeParse({
      successor: { agentId: 'su-a1a71' },
      successorLineageMode: 'system:lineage-neutral-successor',
    }).success).toBe(false);
    expect(launchAgent.args.safeParse({ ...request, fork: true }).success).toBe(false);
  });

  it('accepts the explicit independent fresh-launch mode', () => {
    expect(launchAgent.args.safeParse({ brief: 'independent work', independent: true }).success).toBe(true);
  });

  it('accepts a flat top-level persona role for fresh launches', () => {
    const parsed = launchAgent.args.safeParse({ brief: 'persona-specific work', role: 'reviewer' });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.role).toBe('reviewer');
    }
  });

  it('accepts top-level carry for an existing-fleet plan launch only', () => {
    const fresh = launchAgent.args.safeParse({
      fleet: 'existing-fleet',
      plan: 'existing-plan',
      carry: 'cold',
    });
    expect(fresh.success).toBe(true);
    if (fresh.success) {
      expect(fresh.data).toMatchObject({
        fleet: 'existing-fleet',
        plan: 'existing-plan',
        carry: 'cold',
      });
    }

    expect(
      launchAgent.args.safeParse({
        resume: { agentId: 'su-a1a71' },
        brief: 'continue the recovery',
        carry: 'cold',
      }).success,
    ).toBe(false);
  });

  it('accepts successor placement and runtime overrides while pointing resume carry errors at carry', () => {
    const successor = launchAgent.args.safeParse({
      successor: { agentId: 'su-a1a71' },
      brief: 'recover on an alternate runtime',
      agent: 'claude',
      headless: true,
      account: 'default',
      model: 'sonnet',
      carry: 'warm',
      label: 'alternate successor',
    });
    expect(successor.success).toBe(true);

    const resumeWithCarry = launchAgent.args.safeParse({
      resume: { agentId: 'su-a1a71' },
      brief: 'continue the recovery',
      carry: 'cold',
    });
    expect(resumeWithCarry.success).toBe(false);
    if (!resumeWithCarry.success) {
      expect(resumeWithCarry.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['carry'] })]),
      );
    }
  });

  it('keeps the declared launch deadline outside sequential child proof windows', () => {
    expect(launchAgent.timeoutSec).toBe(AGENT_LAUNCH_HANDLER_TIMEOUT_SEC);
    expect(launchAgent.timeoutSec! * 1000).toBeGreaterThan(
      EARLY_EXIT_PROBE_MS + HEADLESS_BOOT_RECEIPT_MS + KICKOFF_PROOF_WINDOW_MS + RESUME_VERIFY_TIMEOUT_MS,
    );
  });

  it('documents ordinary resume defaults separately from successor runtime overrides', () => {
    const descriptions = (launchAgent.args as unknown as {
      shape: Record<string, { description?: string }>;
    }).shape;

    expect(descriptions.resume.description).toContain('For ordinary in-place continuation, send `{ resume, brief }`');
    expect(descriptions.resume.description).toContain('Leave `carry` out because it is rejected for resume/fork');
    expect(descriptions.resume.description).toContain('Normally omit `account` and `model` too');
    expect(descriptions.account.description).toContain('For ordinary in-place resume, omit it');
    expect(descriptions.model.description).toContain('For ordinary in-place resume, omit it');
    expect(descriptions.carry.description).toContain('Do not set it with in-place `resume`/`fork`');
    expect(descriptions.successor.description).toContain('explicit fresh-context `account`, `model`, or `carry` settings');
    expect(descriptions.agent.description).toContain('an explicit different backend requests a session port that retains the source identity');
    expect(descriptions.agent.description).toContain('Live-source resumes automatically fork, so they cannot cross backends');
    expect(descriptions.agent.description).toContain('A fork keeps the recorded backend');
  });

  it('does not impose a local agent-count ceiling before governed admission', () => {
    expect(launchAgent.args.safeParse({ brief: 'wide governed fan-out', count: 64 }).success).toBe(true);
    expect(
      launchAgent.args.safeParse({
        brief: 'member-specific governed fan-out',
        members: Array.from({ length: 64 }, (_, i) => ({ brief: `member-${i}` })),
      }).success,
    ).toBe(true);
  });

  it('documents role fields as discoverable harness persona ids, not lane labels', () => {
    // The published args use one object schema with conditional source-launch
    // validation, so the shared member schema is directly on the object shape.
    const argsOut = (launchAgent.args as unknown as {
      shape: {
        role: { description?: string };
        members: { unwrap: () => { element: { shape: Record<string, { description?: string }> } } };
      };
    });
    const topRole = argsOut.shape.role;
    expect(topRole.description).toMatch(/roles:list/);
    expect(topRole.description).toMatch(/roles\[\]\.id/);
    expect(topRole.description).toMatch(/harnessSlug/);

    const members = argsOut.shape.members.unwrap();
    const role = members.element.shape.role;

    expect(role.description).toMatch(/registered persona id/i);
    expect(role.description).toMatch(/target harness/i);
    expect(role.description).toMatch(/not a lane\/job label/i);
    expect(role.description).toMatch(/roles:list/);
    expect(role.description).toMatch(/roles\[\]\.id/);
    // The valid persona set is resolved against the selected harness at launch
    // time, so the shared wire schema must remain string-shaped rather than
    // freezing one harness's registry into a static enum.
    expect(
      launchAgent.args.safeParse({
        brief: 'member-specific launch',
        members: [{ role: 'independent-rubric-grader' }],
      }).success,
    ).toBe(true);
  });
});

describe('ad-hoc launch (a brief, no plan, no fleet — D-002/D-003)', () => {
  it('passes the live GOAL width to an ad-hoc child in its first-turn brief', async () => {
    goalLaunchResolveMock.mockResolvedValueOnce({
      goalId: 'goal-1', settings: { intendedParallelPlanFleets: 2 },
      effective: {}, refusal: null, budget: null, goalBrief: null,
      ceilings: { maxAgents: 12, maxPerFleet: 5 },
      headcount: { total: 1, fleet: null }, degraded: false, degradedReasons: [],
    });
    const res = await launchAgent.handler({ brief: 'Grade the evidence' }, ctx);
    expect(isError(res)).toBe(false);
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('Grade the evidence');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('intended concurrent plan fleets = 2');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).not.toContain('fleet member target');
  });
  it('forwards an explicit work-item subject to the work-scope gate', async () => {
    await launchAgent.handler({ brief: 'audit the release script', harness: 'portal', workItem: 'EI-audit-1' }, ctx);

    expect(gateWorkScopeMock).toHaveBeenCalledWith('capability:launch-agent', {
      harness: 'portal',
      plan: null,
      workItem: 'EI-audit-1',
    });
  });

  it('forwards the exact work-item into headless task enrollment', async () => {
    const workItem = 'EI-audit-1';
    const res = await launchAgent.handler({
      brief: 'audit the retained scorecard task',
      harness: 'papercusp',
      workItem,
      headless: true,
    }, ctx);

    expect(isError(res), textOf(res)).toBe(false);
    expect(spawnHeadlessMock).toHaveBeenCalledOnce();
    expect(spawnHeadlessMock.mock.calls[0]?.[0]).toMatchObject({ workItemId: workItem });
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  describe('accepted operation worker feature binding', () => {
    const workItem = 'WI-10007113';
    const matchingBinding = { workItemId: workItem };

    it.each([undefined, 'WI-another-item'])(
      'refuses a matching accepted-operation worker role when feature is %s before spawning',
      async (feature) => {
        resolveAcceptedOperationWorkerBindingMock.mockResolvedValue(matchingBinding);
        const res = await launchAgent.handler({
          brief: 'complete the accepted operation',
          harness: 'papercusp',
          role: 'su',
          workItem,
          ...(feature ? { feature } : {}),
        }, ctx);

        expect(isError(res)).toBe(true);
        expect(textOf(res)).toContain('requires feature to exactly match workItem');
        expect(spawnConsoleMock).not.toHaveBeenCalled();
        expect(spawnHeadlessMock).not.toHaveBeenCalled();
        expect(resolveAcceptedOperationWorkerBindingMock).toHaveBeenCalledWith(expect.objectContaining({
          workspaceId: 'ws-test',
          harnessSlug: 'papercusp',
          workItemId: workItem,
          role: 'su',
          roleMismatch: 'ignore',
          repoDir: '/tmp/papercusp-ws',
        }));
      },
    );

    it('forwards the accepted operation work item as an explicit feature binding', async () => {
      resolveAcceptedOperationWorkerBindingMock.mockResolvedValue(matchingBinding);
      const res = await launchAgent.handler({
        brief: 'complete the accepted operation',
        harness: 'papercusp',
        role: 'su',
        workItem,
        feature: workItem,
      }, ctx);

      expect(isError(res), textOf(res)).toBe(false);
      expect(spawnConsoleMock).toHaveBeenCalledOnce();
      expect(spawnedCommand()).toContain('--feature=' + workItem);
    });

    it('keeps an unrelated work-item audit launch on the generic path', async () => {
      resolveAcceptedOperationWorkerBindingMock.mockResolvedValue(null);
      const res = await launchAgent.handler({
        brief: 'audit the accepted operation independently',
        harness: 'papercusp',
        role: 'su',
        workItem: 'EI-audit-1',
      }, ctx);

      expect(isError(res), textOf(res)).toBe(false);
      expect(spawnConsoleMock).toHaveBeenCalledOnce();
      expect(spawnedCommand()).not.toContain('--feature=');
    });
  });

  it('launches a visible agent whose FIRST TURN is the brief', async () => {
    const res = await launchAgent.handler({ brief: 'audit the release script' }, ctx);

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock.mock.calls[0][0]).toMatchObject({
      captureTerminalPid: true,
      writeMcpJson: true,
    });
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    // Scripted launch: no picker, account pinned (P-012), launcher provenance.
    expect(spawnedCommand()).toContain('psu --launched-by=su-caller --no-picker --account=default');
    // The brief rides the SPAWN-SAFE env, never a --kickoff= value in the command
    // (a free-form text there gets double-quoted by the greeting one-liner and
    // breaks the shell).
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toBe('audit the release script');
    expect(spawnedCommand()).not.toContain('--kickoff');
    expect(textOf(res)).toContain('(no fleet)');
    expect(textOf(res)).toContain('first turn');
    expect(textOf(res)).toContain('launcher pid 4242; terminal pid 4343');
    expect(dataOf(res)?.launch).toMatchObject({
      partial: false,
      tasks: [{ pid: 4242, terminalPid: 4343, headless: false }],
    });
  });

  it('reports a plan-bound launch as self-pulling rather than idle', async () => {
    const res = await launchAgent.handler({ plan: 'plan-a' }, ctx);

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(textOf(res)).toContain('bound to plan "plan-a"');
    expect(textOf(res)).toContain('pulls its own work; no brief needed');
    expect(textOf(res)).not.toContain('opens IDLE');
    expect(spawnedEnv()).not.toHaveProperty('PAPERCUSP_KICKOFF_PROMPT');
  });

  it('reports an unavailable terminal PID without falling back to the launcher PID', async () => {
    spawnConsoleMock.mockResolvedValueOnce({
      status: 'ok',
      pid: 4242,
      terminalPid: null,
      terminal: 'xterm',
      child: {} as never,
      display: ':1',
      desktopEnvResolvedVia: 'active-seat',
    });

    const res = await launchAgent.handler({ brief: 'audit the release script' }, ctx);

    expect(textOf(res)).toContain('launcher pid 4242; terminal pid unavailable');
    expect(textOf(res)).not.toContain('terminal pid 4242');
    expect(dataOf(res)?.launch).toMatchObject({
      tasks: [{ pid: 4242, terminalPid: null, headless: false }],
    });
  });

  it('honors the internal fresh owner pin used to correlate concurrent respawns', async () => {
    await launchAgent.handler(
      {
        brief: 'replace one fleet member',
        __respawnOwnerId: 'su-respawn-test-owner',
        __respawnReplacesOwnerId: 'su-replaced-owner',
      } as never,
      ctx,
    );

    expect(spawnedCommand()).toContain('--owner-id=su-respawn-test-owner');
    expect(spawnGovernedAgentProcessMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ replacesOwnerId: 'su-replaced-owner' }),
    }), expect.any(Function));
  });

  it('reports degraded final goal registration through the launch notes', async () => {
    spawnGovernedAgentProcessMock.mockImplementationOnce(async (_input, spawnProcess) => ({
      ...await spawnProcess({ receiptId: 'WI-governed-test', leaseId: 'lease-governed-test' }),
      goalAdmissionDegraded: ['fixture final goal registration unavailable'],
    }));
    const result = await launchAgent.handler({ brief: 'verify goal admission receipt' }, ctx);
    expect(textOf(result)).toContain('fixture final goal registration unavailable');
  });

  it('refuses a launch with nothing to do (it would just sit idle)', async () => {
    const res = await launchAgent.handler({}, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/a `brief`.*or a `plan`/s);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('refuses a no-brief resume before resolving the target or opening a terminal', async () => {
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' } }, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('requires a non-empty `brief`');
    expect(textOf(res)).toContain('actionable next turn');
    expect(resolveResumeTargetMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('launches N agents on one brief', async () => {
    await launchAgent.handler({ brief: 'triage the backlog', count: 3 }, ctx);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(3);
  });

  it('pre-pins and returns a distinct coord owner for every fresh member', async () => {
    const res = await launchAgent.handler({ brief: 'triage each lane', count: 3 }, ctx);

    const ownerIds = spawnConsoleMock.mock.calls.map(
      ([opts]) =>
        (opts as { envelope: { greetingCmd: string } }).envelope.greetingCmd.match(/--owner-id=([^ ]+)/)?.[1],
    );
    expect(ownerIds).toHaveLength(3);
    expect(ownerIds.every((ownerId): ownerId is string => /^su-[0-9a-f-]{36}$/.test(ownerId ?? ''))).toBe(true);
    expect(new Set(ownerIds).size).toBe(3);
    expect(dataOf(res)?.launch).toMatchObject({
      ownerIds,
      tasks: ownerIds.map((ownerId) => expect.objectContaining({ ownerId })),
    });
    expect(verifyFreshLaunchStartedMock).toHaveBeenCalledWith(
      expect.objectContaining({ expected: 3, expectedOwnerIds: ownerIds }),
    );
  });

  it('projects the verifier native session handle onto the matching task receipt', async () => {
    const ownerId = 'su-judge-owner';
    verifyFreshLaunchStartedMock.mockResolvedValueOnce({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId, advSessionId: 73, sessionId: 'native-judge', successfulCalls: 1 }],
      note: 'judge verified',
    });

    const res = await launchAgent.handler(
      { brief: 'grade the frozen acceptance evidence', __respawnOwnerId: ownerId } as never,
      ctx,
    );

    const task = (dataOf(res)?.launch as { tasks: Array<Record<string, unknown>> }).tasks[0];
    expect(task).toMatchObject({
      ownerId,
      nativeSession: {
        backend: 'claude',
        source: 'adv_sessions',
        ownerId,
        sessionId: 'native-judge',
        exactResumeSupported: true,
        missingReason: null,
      },
    });
    expect(task.nativeSession).not.toBe(ownerId);
  });

  it('projects an owner-bound Codex rollout onto its task receipt', async () => {
    const ownerId = 'su-codex-judge';
    verifyFreshLaunchStartedMock.mockResolvedValueOnce({
      agentStarted: true, waitedMs: 5,
      sessions: [{ ownerId, advSessionId: 73, sessionId: 'codex-rollout', successfulCalls: 0 }],
      note: 'native turn observed',
    });
    const res = await launchAgent.handler({ agent: 'codex', brief: 'grade evidence',
      __respawnOwnerId: ownerId } as never, ctx);
    const task = (dataOf(res)?.launch as { tasks: Array<Record<string, unknown>> }).tasks[0];
    expect(task).toMatchObject({ ownerId, nativeSession: {
      backend: 'codex', ownerId, rolloutId: 'codex-rollout', exactResumeSupported: true,
    } });
  });

  it('keeps an unresolved verifier handle explicitly null', async () => {
    const ownerId = 'su-judge-without-native-id';
    verifyFreshLaunchStartedMock.mockResolvedValueOnce({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId, advSessionId: 74, sessionId: null, successfulCalls: 1 }],
      note: 'judge verified without native id',
    });

    const res = await launchAgent.handler(
      { brief: 'grade the evidence', __respawnOwnerId: ownerId } as never,
      ctx,
    );

    const task = (dataOf(res)?.launch as { tasks: Array<Record<string, unknown>> }).tasks[0];
    expect(task).toHaveProperty('nativeSession', null);
  });

  it('leaves nativeSession absent when verifier instrumentation fails', async () => {
    verifyFreshLaunchStartedMock.mockRejectedValueOnce(new Error('verifier unavailable'));

    const res = await launchAgent.handler({ brief: 'grade the evidence' }, ctx);

    const task = (dataOf(res)?.launch as { tasks: Array<Record<string, unknown>> }).tasks[0];
    expect(task).not.toHaveProperty('nativeSession');
  });

  it('wires the flat persona role into a fresh launch command', async () => {
    await launchAgent.handler({ brief: 'run as reviewer', role: 'reviewer' }, ctx);

    expect(spawnedCommand()).toContain('--role=reviewer');
  });

  it('threads flat and per-member stack bindings into each fresh psu command', async () => {
    await launchAgent.handler(
      {
        brief: 'run the identity-specific work',
        stack: ['domain:papercusp-engineer'],
        count: 2,
        members: [{ stack: ['domain:review-domain', 'practice:careful-review'] }],
      },
      ctx,
    );

    const commands = spawnConsoleMock.mock.calls.map(
      ([opts]) => (opts as { envelope: { greetingCmd: string } }).envelope.greetingCmd,
    );
    expect(commands[0]).toContain('--stack=domain:review-domain');
    expect(commands[0]).toContain('--stack=practice:careful-review');
    expect(commands[0]).not.toContain('--stack=domain:papercusp-engineer');
    expect(commands[1]).toContain('--stack=domain:papercusp-engineer');
  });

  it.each([
    { stack: ['papercusp-engineer'] },
    { members: [{ stack: ['papercusp-engineer'] }] },
  ])('refuses malformed stack bindings before claiming admission: %j', async (bad) => {
    const result = await launchAgent.handler({ brief: 'should not launch', ...bad } as never, ctx);

    // handler() is typed ToolResponse | ToolResult; this refusal path returns the
    // MCP content envelope, so narrow to that shape (same cast as textOf above).
    expect((result as { content: unknown[] }).content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('expected "<slot>:<id>"'),
    });
    expect(claimAgentLaunchMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('validates named compositions for flat and member selections without expanding their root marker', async () => {
    const result = await launchAgent.handler({
      brief: 'use the selected compositions', cwd: '/repo-compositions', count: 2,
      stack: ['composition:named-base'], members: [{ stack: ['composition:named-review'] }],
    }, ctx);

    expect(isError(result)).toBe(false);
    expect(resolveNamedIdentityCompositionSelectionMock.mock.calls).toEqual([
      ['named-review', '/repo-compositions'], ['named-base', '/repo-compositions'],
    ]);
    const commands = spawnConsoleMock.mock.calls.map(
      ([opts]) => (opts as { envelope: { greetingCmd: string } }).envelope.greetingCmd,
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('--stack=composition:named-review');
    expect(commands[1]).toContain('--stack=composition:named-base');
    expect(commands.join('\n')).not.toContain('--stack=domain:review-domain');
  });

  it.each([
    { stack: ['composition:missing'] },
    { members: [{ stack: ['composition:missing'] }] },
  ])('refuses unavailable named compositions before admission: %j', async (selection) => {
    resolveNamedIdentityCompositionSelectionMock.mockRejectedValueOnce(new Error('named identity missing is unavailable'));
    const result = await launchAgent.handler({ brief: 'do not launch', ...selection }, ctx);

    expect(textOf(result)).toContain('named identity missing is unavailable');
    expect(claimAgentLaunchMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('refuses a named composition whose shared resolver rejects its closure', async () => {
    resolveNamedIdentityCompositionSelectionMock.mockRejectedValueOnce(new Error('named identity broken has an unselected component'));
    const result = await launchAgent.handler({ brief: 'do not launch', stack: ['composition:broken'] }, ctx);

    expect(textOf(result)).toContain('has an unselected component');
    expect(claimAgentLaunchMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it.each([
    ['composition:'],
    ['composition:named-review', 'practice:careful-review'],
    ['composition:named-review', 'composition:named-base'],
  ])('refuses empty or mixed composition selectors before resolving: %j', async (...stack) => {
    const result = await launchAgent.handler({ brief: 'do not launch', stack }, ctx);

    expect(isError(result)).toBe(true);
    expect(resolveNamedIdentityCompositionSelectionMock).not.toHaveBeenCalled();
    expect(claimAgentLaunchMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('propagates flat carry to an existing-fleet plan launch with per-member precedence', async () => {
    const res = await launchAgent.handler(
      {
        fleet: 'existing-fleet',
        plan: 'existing-plan',
        carry: 'cold',
        count: 2,
        members: [{ carry: 'warm' }],
      },
      ctx,
    );

    expect(isError(res)).toBe(false);
    const commands = spawnConsoleMock.mock.calls.map(
      ([opts]) => (opts as { envelope: { greetingCmd: string } }).envelope.greetingCmd,
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('--fleet=existing-fleet');
    expect(commands[0]).toContain('--plan=existing-plan');
    expect(commands[0]).toContain('--carry=warm');
    expect(commands[1]).toContain('--fleet=existing-fleet');
    expect(commands[1]).toContain('--plan=existing-plan');
    expect(commands[1]).toContain('--carry=cold');
  });

  it('lets a per-member role override the flat persona role', async () => {
    await launchAgent.handler(
      {
        brief: 'run the role-specific work',
        role: 'reviewer',
        count: 2,
        members: [{ role: 'architect' }],
      },
      ctx,
    );

    const commands = spawnConsoleMock.mock.calls.map(
      ([opts]) => (opts as { envelope: { greetingCmd: string } }).envelope.greetingCmd,
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('--role=architect');
    expect(commands[1]).toContain('--role=reviewer');
  });

  it('rejects an unknown per-member persona before claiming or opening any terminal', async () => {
    assembleRolePromptMock.mockImplementationOnce(() => {
      throw new Error(
        'assembleRolePrompt: no prompt file found for role "closure-auditor" (phase=staging, dept=none, blueprintId=none)',
      );
    });

    const res = await launchAgent.handler(
      {
        brief: 'finish the certification lane',
        count: 2,
        members: [{ role: 'closure-auditor' }, { role: 'su' }],
        idempotencyKey: 'invalid-role-batch',
      },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Invalid persona role `closure-auditor`');
    expect(textOf(res)).toContain('Put lane/job names in `brief` or `label`');
    expect(textOf(res)).toContain('NO agents were spawned and NO terminals were opened');
    expect(claimAgentLaunchMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('binds a plan (and its harness) when asked', async () => {
    await launchAgent.handler({ plan: 'my-plan' }, ctx);
    expect(spawnedCommand()).toContain('--harness=papercusp --plan=my-plan');
  });

  it('propagates the caller DRAIN overlay to a fresh launch', async () => {
    getModesMock.mockResolvedValue([{ mode: 'drain', subject: 'bug-drain', ownerDirected: true }]);
    listFactsMock.mockResolvedValue([{ key: 'mode-instructions:drain', body: 'Do not file incidental defects.' }]);

    await launchAgent.handler({ brief: 'drain the admitted bugs' }, ctx);

    expect(spawnedCommand()).toContain('--mode=drain');
    expect(spawnedCommand()).toContain('--mode-subject=bug-drain');
    expect(spawnedCommand()).toContain("--mode-instructions='Do not file incidental defects.'");
    expect(spawnedCommand()).toContain('--mode-owner-directed');
  });

  it('withholds caller DRAIN mission and owner-directed provenance from a fresh fleet member', async () => {
    getModesMock.mockResolvedValue([{ mode: 'drain', subject: 'leader-only', ownerDirected: true }]);
    listFactsMock.mockResolvedValue([{ key: 'mode-instructions:drain', body: 'Lead the fleet as su-caller.' }]);
    const result = await launchAgent.handler({ fleet: 'test-fleet', brief: 'Pull admitted member source work.' }, ctx);
    expect(isError(result)).toBe(false);
    expect(spawnedCommand()).toContain('--fleet=test-fleet');
    expect(spawnedCommand()).toContain('--mode=drain');
    expect(spawnedCommand()).not.toContain('--mode-subject');
    expect(spawnedCommand()).not.toContain('--mode-instructions');
    expect(spawnedCommand()).not.toContain('--mode-owner-directed');
  });

  it('allows an operator-scope caller to bind an explicit harness (WI-3329)', async () => {
    const operatorCtx = { workspaceId: 'ws-test', harnessSlug: '*', role: 'su' } as never;
    await launchAgent.handler({ brief: 'run the disposable harness check', harness: 'papercusp' }, operatorCtx);
    expect(spawnedCommand()).toContain('--harness=papercusp');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toBe('run the disposable harness check');
  });

  it('refuses a fresh Codex launch before opening terminals when the backend rejects its model', async () => {
    codexPreflightHomeMock.mockResolvedValue('/tmp/codex');
    codexPreflightModelMock.mockResolvedValue({
      verdict: 'refused',
      status: 400,
      detail: `{"detail":"The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account."}`,
    });

    const res = await launchAgent.handler({ agent: 'codex', model: 'gpt-5.6:xhigh', brief: 'run the check' }, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('NO terminals were opened');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(codexPreflightModelMock).toHaveBeenCalledWith('/tmp/codex', 'gpt-5.6');
  });

  it('does not consume an idempotency key on model refusal, so a corrected retry can launch', async () => {
    codexPreflightHomeMock.mockResolvedValue('/tmp/codex');
    codexPreflightModelMock
      .mockResolvedValueOnce({
        verdict: 'refused',
        status: 400,
        detail: `{"detail":"The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account."}`,
      })
      .mockResolvedValueOnce({ verdict: 'ok', status: 200, detail: 'supported' });

    const first = await launchAgent.handler(
      {
        agent: 'codex',
        model: 'gpt-5.6:xhigh',
        brief: 'run the check',
        idempotencyKey: 'wi-42381-independent-grade-v1',
      },
      ctx,
    );

    expect(isError(first)).toBe(true);
    expect(claimAgentLaunchMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();

    const corrected = await launchAgent.handler(
      {
        agent: 'codex',
        model: 'gpt-5.6-sol:high',
        brief: 'run the check',
        idempotencyKey: 'wi-42381-independent-grade-v1',
      },
      ctx,
    );

    expect(isError(corrected)).toBe(false);
    expect(claimAgentLaunchMock).toHaveBeenCalledTimes(1);
    expect(claimAgentLaunchMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'wi-42381-independent-grade-v1' }),
    );
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
  });

  it('proceeds with a warning when Codex model preflight is inconclusive', async () => {
    codexPreflightHomeMock.mockResolvedValue('/tmp/codex');
    codexPreflightModelMock.mockResolvedValue({ verdict: 'unknown', status: 429, detail: 'rate limited' });

    const res = await launchAgent.handler({ agent: 'codex', model: 'gpt-5.6:xhigh', brief: 'run the check' }, ctx);

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(textOf(res)).toContain('proceeding fail-open');
  });

  it('uses a ChatGPT-compatible family-suffixed model when a fresh Codex launch omits one', async () => {
    codexPreflightHomeMock.mockResolvedValue('/tmp/codex');
    codexPreflightModelMock.mockResolvedValue({ verdict: 'ok', status: 200, detail: 'supported' });

    const res = await launchAgent.handler({ agent: 'codex', brief: 'run the check' }, ctx);

    expect(isError(res)).toBe(false);
    expect(spawnedCommand()).toContain('--agent=codex');
    const selectedModel = spawnedCommand().match(/--model=(\S+)/)?.[1];
    const modelId = selectedModel?.split(':')[0];
    expect(modelId).toMatch(/^gpt-\d+(?:\.\d+)*-[a-z]+$/);
    expect(codexPreflightModelMock).toHaveBeenCalledWith('/tmp/codex', modelId);
  });
});

describe('fleet composition (D-003: fleet is an ARG, not a separate tool)', () => {
  it('creates a fresh explicit fleet before reading its scheme or launch profile', async () => {
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: { fleetSlug: 'fresh-fleet', leaderOwnerId: 'su-caller' },
      created: true,
    });

    await launchAgent.handler({ brief: 'start the fresh fleet', fleet: 'fresh fleet' }, ctx);

    expect(createFleetIfAbsentMock).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'fresh-fleet',
      title: 'fresh fleet',
      owner: 'su-caller',
      leaderOwnerId: 'su-caller',
    });
    const createOrder = createFleetIfAbsentMock.mock.invocationCallOrder[0]!;
    expect(createOrder).toBeLessThan(getFleetSchemeMock.mock.invocationCallOrder[0]!);
    expect(createOrder).toBeLessThan(getFleetHeadcountTargetMock.mock.invocationCallOrder[0]!);
    expect(spawnedCommand()).toContain('--fleet=fresh-fleet');
  });

  it('joins an explicit fleet — membership AND colour, from one slug', async () => {
    const res = await launchAgent.handler({ brief: 'work the release', fleet: 'alpha fleet' }, ctx);
    expect(spawnedCommand()).toContain('--fleet=alpha-fleet');
    expect(spawnConsoleMock.mock.calls[0][0]).toMatchObject({ scheme: { name: 'royal-purple' } });
    expect(textOf(res)).toContain('in fleet alpha-fleet');
  });

  it("falls back to the CALLER's presence fleet when none is named (WI-4234)", async () => {
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['su-caller', { fleetSlug: 'alpha-fleet', fleetRole: 'leader' }]]),
    );
    await launchAgent.handler({ brief: 'help out' }, ctx);
    expect(spawnedCommand()).toContain('--fleet=alpha-fleet');
  });

  it('clamps and discloses a requested compaction limit above the fleet-member ceiling', async () => {
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['su-caller', { fleetSlug: 'alpha-fleet', fleetRole: 'leader' }]]),
    );

    const res = await launchAgent.handler({
      brief: 'help out',
      members: [{ compactionLimit: 500_000 }],
    }, ctx);

    expect(spawnedCommand()).toContain('--fleet=alpha-fleet');
    expect(spawnedCommand()).toContain('--compaction-limit=400000');
    expect(spawnedCommand()).not.toContain('--compaction-limit=500000');
    expect(textOf(res)).toContain('500000');
    expect(textOf(res)).toContain('400000');
    expect(textOf(res)).toContain('independent: true');
    expect(dataOf(res)?.launch).toMatchObject({
      fleet: 'alpha-fleet',
      independent: false,
      compactionLimitWarnings: [{ memberIndex: 0, requested: 500_000, effective: 400_000 }],
    });
  });

  it('keeps an independent fresh launch out of the caller presence fleet', async () => {
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['su-caller', { fleetSlug: 'alpha-fleet', fleetRole: 'leader' }]]),
    );

    const res = await launchAgent.handler({ brief: 'grade independently', independent: true }, ctx);

    expect(fetchPresenceFleetMock).not.toHaveBeenCalled();
    expect(spawnedCommand()).not.toContain('--fleet=alpha-fleet');
    expect(dataOf(res)?.launch).toMatchObject({ fleet: null, independent: true });
    expect(textOf(res)).toContain('(no fleet)');
  });

  it('lets an explicit fleet win over independent fresh-launch mode', async () => {
    const res = await launchAgent.handler(
      { brief: 'independent work in the named fleet', independent: true, fleet: 'alpha fleet' },
      ctx,
    );

    expect(spawnedCommand()).toContain('--fleet=alpha-fleet');
    expect(dataOf(res)?.launch).toMatchObject({ fleet: 'alpha-fleet', independent: true });
  });

  it('launches unfleeted when the caller has no fleet (a non-leader can still launch)', async () => {
    await launchAgent.handler({ brief: 'solo task' }, ctx);
    expect(spawnedCommand()).not.toContain('--fleet=');
  });

  it('respawns with the fleet headcount profile instead of reconstructing launch knobs (D-008)', async () => {
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-test',
      fleetSlug: 'alpha-fleet',
      target: 30,
      config: {
        plan: 'drain',
        harness: 'papercusp',
        agent: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'max',
        account: 'default',
        headless: true,
        carry: 'warm',
        contextSize: 'trimmed',
        compactionLimit: 825_000,
        role: 'su',
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });

    const res = await launchAgent.handler({ brief: 'replace the dead lane', fleet: 'alpha fleet' }, ctx);

    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    const command = spawnedCommand(spawnHeadlessMock);
    expect(command).toContain('--fleet=alpha-fleet');
    expect(command).toContain('--agent=codex');
    expect(command).toContain('--model=gpt-5.6-luna:max');
    expect(command).toContain('--account=default');
    expect(command).toContain('--context-size=trimmed');
    expect(command).toContain('--compaction-limit=400000');
    expect(command).toContain('--headless');
    expect(dataOf(res)?.launch).toMatchObject({
      fleet: 'alpha-fleet',
      headcountProfile: { applied: true, target: 30 },
      compactionLimitWarnings: [{ memberIndex: 0, requested: 825_000, effective: 400_000 }],
    });
  });
});

describe('headless composition (D-003: an ARG, not a separate tool)', () => {
  it('routes to the headless spawner with --headless (so the pty — and wakes — survive)', async () => {
    const res = await launchAgent.handler({ brief: 'long soak', headless: true }, ctx);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnedCommand(spawnHeadlessMock)).toContain('--headless');
    expect(spawnHeadlessMock.mock.calls[0][0]).toMatchObject({
      writeMcpJson: true,
      logDir: '/tmp/papercusp-ws/fleet-logs',
      launchedBy: 'su-caller',
      fleetSlug: null,
      kickoffProof: true,
    });
    const ownerId = (spawnHeadlessMock.mock.calls[0][0] as { coordOwnerId?: string }).coordOwnerId;
    expect(ownerId).toMatch(/^su-[0-9a-f-]{36}$/);
    expect(armInboxWakeMock).toHaveBeenCalledWith({
      ownerId,
      note: 'headless launch-agent inbox-wake',
    });
    expect(dataOf(res)?.launch).toMatchObject({ ownerIds: [ownerId], tasks: [{ ownerId }] });
    expect(dataOf(res)?.launch).toMatchObject({
      deduped: false,
      opened: 1,
      failed: 0,
      launchEvidence: {
        version: 1,
        processOpened: 1,
        sessionRegistered: null,
        firstTurn: null,
        taskDisposition: { claimed: 0, noClaim: 0, unknown: 1 },
      },
      tasks: [{
        taskId: 'task777',
        logPath: '/tmp/papercusp-ws/fleet-logs/judge.log',
        normalizedLogPath: '/tmp/papercusp-ws/fleet-logs/judge.normalized.log',
        pid: 777,
        headless: true,
      }],
    });
    expect(textOf(res)).toContain('grep-safe log: /tmp/papercusp-ws/fleet-logs/judge.normalized.log');
    expect(textOf(res)).toContain('Process open alone is not proof that an agent is working.');
    expect(textOf(res)).toContain('EI-9748');
  });

  it.each([
    ['missing', null, 'kickoff-proof-missing'],
    [
      'negative',
      { persisted: false, nativeRef: null, reason: 'native-turn-marker-timeout' },
      'native-turn-marker-timeout',
    ],
  ])('keeps a started process recoverable when its %s native kickoff proof is not persisted', async (_label, proof, reason) => {
    spawnHeadlessMock.mockResolvedValueOnce(headlessSpawnResult(undefined, proof));

    const idempotencyKey = `kickoff-proof-${_label}`;
    const res = await launchAgent.handler(
      { brief: 'grade the item independently', headless: true, idempotencyKey },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(textOf(res)).toContain(reason);
    expect(textOf(res)).toContain('RECOVERABLE PARTIAL LAUNCH');
    expect(textOf(res)).toContain('task777');
    expect(verifyFreshLaunchStartedMock).toHaveBeenCalled();
    expect(releaseAgentLaunchClaimMock).not.toHaveBeenCalled();
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey,
        summary: expect.objectContaining({ opened: 1, failed: 0, partial: true }),
      }),
    );
    expect(dataOf(res)?.launch).toMatchObject({
      opened: 1,
      failed: 0,
      partial: true,
      kickoffProof: {
        required: true,
        persisted: false,
        failures: [{ reason, taskId: 'task777' }],
      },
      tasks: [{ taskId: 'task777', logPath: '/tmp/papercusp-ws/fleet-logs/judge.log' }],
    });
  });

  it('binds an exact grading auditor to its private retained endpoint and records the ownership', async () => {
    const launchAgentModule = await import('./launch-agent');
    const runtime = { taskId: 'runtime-owned', baseUrl: 'http://127.0.0.1:45187',
      evaluatorBuild: { sha: 'exact123', version: '1.2.3' }, bundleSha256: 'a'.repeat(64),
      expiresAtSec: Math.floor(Date.now() / 1000) + 300 };
    const internalCtx = { ...(ctx as object), [launchAgentModule.INTERNAL_GRADING_AUDIT_RUNTIME]: runtime } as never;
    const res = await launchAgent.handler({ brief: 'exact audit', headless: true, mcpTarget: 'spawn-host' }, internalCtx);
    expect(isError(res)).toBe(false);
    expect(buildConsoleEnvelopeMock.mock.calls[0]?.[0]).toMatchObject({ agentMcpBaseUrl: runtime.baseUrl });
    expect(spawnHeadlessMock.mock.calls[0]?.[0]).toMatchObject({ ledgerDetail: { gradingAuditRuntimeBinding: runtime } });
  });

  it.each(['http://example.com:45187', 'http://127.0.0.1:45187/unrelated', 'http://127.0.0.1:45187?x=1'])(
    'refuses an invalid internal audit runtime endpoint %s before spawning', async baseUrl => {
      const launchAgentModule = await import('./launch-agent');
      const runtime = { taskId: 'runtime-owned', baseUrl, evaluatorBuild: { sha: 'exact123', version: '1.2.3' },
        bundleSha256: 'a'.repeat(64), expiresAtSec: Math.floor(Date.now() / 1000) + 300 };
      const res = await launchAgent.handler({ brief: 'exact audit', headless: true, mcpTarget: 'spawn-host' },
        { ...(ctx as object), [launchAgentModule.INTERNAL_GRADING_AUDIT_RUNTIME]: runtime } as never);
      expect(isError(res)).toBe(true);
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
    },
  );

  it('records an internal grading-audit target on the launched headless task row', async () => {
    const gradingAudit = {
      issueId: 'EI-grade-task',
      evidenceFingerprint: 'evidence-fingerprint-v1',
      reservation: {
        key: 'grading-audit:EI-grade-task',
        reservedAt: '2026-10-15T18:00:00.000Z',
      },
    };
    const internalCtx = {
      ...(ctx as object),
      [launchAgentModule.INTERNAL_GRADING_AUDIT_TASK_DETAIL]: gradingAudit,
    } as never;

    const res = await launchAgent.handler({ brief: 'grade this exact scorecard', headless: true }, internalCtx);

    expect(isError(res)).toBe(false);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessMock.mock.calls[0]?.[0]).toMatchObject({
      ledgerDetail: { gradingAudit },
    });
  });
});

describe('headless in-place resume verification', () => {
  const dead = {
    ok: true as const,
    sessionId: 'sid-dead',
    ownerId: 'su-a1a71',
    agent: 'claude',
    cwd: '/repo',
    endedAt: '2026-07-11T10:00:00.000Z',
    live: false,
    advSessionId: 11,
    account: null,
  };

  const resumeHeadless = (childExit: Promise<SpawnChildExit>) => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    spawnHeadlessMock.mockResolvedValueOnce(headlessSpawnResult(childExit));
    return launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, headless: true, brief: 'continue the recovery' },
      ctx,
    );
  };

  it('classifies a nonzero persistent child exit as an observed resume failure', async () => {
    const res = await resumeHeadless(Promise.resolve({ code: 1, signal: null }));

    expect(verifyResumeStartedMock).toHaveBeenCalledWith(
      'su-a1a71',
      expect.objectContaining({ expectedSessionId: 'sid-dead' }),
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('HEADLESS RESUME TURN FAILED');
    expect(textOf(res)).toContain('agent_crash');
    expect(dataOf(res)?.launch).toMatchObject({
      resumeVerified: false,
      resumeVerification: {
        expectedSessionId: 'sid-dead',
        actualSessionId: null,
        mismatch: false,
        bootLogTail: null,
      },
    });
  });

  it('classifies an HTTP 400 in the bounded headless log and preserves its evidence', async () => {
    mkdirSync('/tmp/papercusp-ws/fleet-logs', { recursive: true });
    writeFileSync(HEADLESS_RESUME_LOG_PATH, 'resume failed: HTTP 400 Bad Request from provider\n');

    const res = await resumeHeadless(Promise.resolve({ code: 1, signal: null }));

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('HEADLESS RESUME TURN FAILED');
    expect(textOf(res)).toContain('HTTP 400 Bad Request');
    expect(dataOf(res)?.launch).toMatchObject({
      resumeVerified: false,
      resumeVerification: {
        bootLogTail: 'resume failed: HTTP 400 Bad Request from provider\n',
      },
    });
  });

  it('keeps a clean child exit unconfirmed instead of reporting a false failure', async () => {
    const res = await resumeHeadless(Promise.resolve({ code: 0, signal: null }));

    expect(isError(res)).toBe(false);
    expect(textOf(res)).toContain('HEADLESS RESUME UNCONFIRMED');
    expect(dataOf(res)?.launch).toMatchObject({
      resumeVerified: null,
      resumeVerification: { expectedSessionId: 'sid-dead', bootLogTail: null },
    });
  });

  it('keeps a verifier deadline unconfirmed when the headless child has not exited', async () => {
    verifyResumeStartedMock.mockResolvedValueOnce({
      started: null,
      waitedMs: 30_000,
      expectedSessionId: 'sid-dead',
      actualSessionId: null,
      mismatch: false,
    });

    const res = await resumeHeadless(new Promise<SpawnChildExit>(() => {}));

    expect(isError(res)).toBe(false);
    expect(textOf(res)).toContain('RESUME UNCONFIRMED');
    expect(dataOf(res)?.launch).toMatchObject({ resumeVerified: null });
  });
});

describe('resume + fork (D-004/D-007)', () => {
  const dead = {
    ok: true as const,
    sessionId: 'sid-dead',
    ownerId: 'su-a1a71',
    agent: 'claude',
    cwd: '/repo',
    endedAt: '2026-07-11T10:00:00.000Z',
    endedBy: 'self' as const,
    live: false,
    advSessionId: 11,
    binding: {
      coordOwnerId: 'su-a1a71',
      sessionId: 'sid-dead',
      startedAt: '2026-07-11 09:00:00.123456+00',
    },
  };

  describe('explicit resume inherited goal context', () => {
    let inheritedGoal: string | null;
    let callerGoal: string | null;
    let readFailure: boolean;
    let writeFailure: boolean;
    let writtenGoals: Array<string | null>;

    beforeEach(() => {
      findLiveHostMock.mockReturnValue(null);
      resolveResumeTargetMock.mockResolvedValue(dead);
      // Policy admission is separate; use the real context resolver and writer
      // to check the governed process-start boundary.
      goalLaunchResolveMock.mockResolvedValue({ goalId: null, effective: {} });
      inheritedGoal = 'goal-paused';
      callerGoal = null;
      readFailure = false;
      writeFailure = false;
      writtenGoals = [];
      goalContextSqlMock.mockImplementation(async (...args: unknown[]) => {
        const [strings, ...values] = args;
        const query = Array.isArray(strings) ? strings.join(' ') : '';
        if (query.includes('SELECT goal_id FROM harness_shared.session_briefs')) {
          if (values[0] === 'su-caller' && readFailure) throw new Error('launcher context unavailable');
          return [{ goal_id: values[0] === 'su-caller' ? callerGoal : inheritedGoal }];
        }
        if (query.includes('INSERT INTO harness_shared.session_briefs')) {
          if (writeFailure) throw new Error('inherited context write unavailable');
          if (values[0] === dead.ownerId) {
            inheritedGoal = values[2] as string | null;
            writtenGoals.push(inheritedGoal);
          }
        }
        return [];
      });
    });

    afterEach(() => {
      goalContextSqlMock.mockImplementation(async () => []);
    });

    it.each([null, 'goal-new', 'goal-paused'])('reconciles an admitted different launcher goal %s before spawning', async (goal) => {
      callerGoal = goal;
      const spawn = spawnConsoleMock.getMockImplementation()!;
      spawnConsoleMock.mockImplementationOnce(async (opts) => {
        expect(inheritedGoal).toBe(goal);
        return spawn(opts);
      });
      const result = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false,
        brief: 'continue the explicitly assigned work' }, ctx);
      expect(isError(result), textOf(result)).toBe(false);
      expect(writtenGoals).toEqual([goal]);
      expect(spawnGovernedAgentProcessMock).toHaveBeenCalledWith(expect.objectContaining({ owner: dead.ownerId }), expect.any(Function));
      expect(spawnedCommand()).toContain('--resume=sid-dead');
      expect(spawnedCommand()).not.toContain('--fork');
    });

    it('does not reparent before governor admission succeeds', async () => {
      spawnGovernedAgentProcessMock.mockResolvedValueOnce({ status: 'error', code: 409, error: 'admission refused' });
      const result = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false, brief: 'continue' }, ctx);
      expect(isError(result)).toBe(true);
      expect(writtenGoals).toEqual([]);
      expect(inheritedGoal).toBe('goal-paused');
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('refuses process start when the launcher context cannot be read', async () => {
      readFailure = true;
      const result = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false, brief: 'continue' }, ctx);
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('launcher context unavailable');
      expect(writtenGoals).toEqual([]);
      expect(inheritedGoal).toBe('goal-paused');
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
    });

    it('refuses process start when the inherited-only write fails', async () => {
      writeFailure = true;
      const result = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false, brief: 'continue' }, ctx);
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('goal context');
      expect(inheritedGoal).toBe('goal-paused');
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
    });

    it('preserves inherited context during internal wait recovery', async () => {
      const result = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false,
        [INTERNAL_INTERRUPTION_RECOVERY]: { ownerId: dead.ownerId, nativeSessionId: dead.sessionId, wait: true },
      } as never, ctx);
      expect(isError(result), textOf(result)).toBe(false);
      expect(writtenGoals).toEqual([]);
      expect(inheritedGoal).toBe('goal-paused');
    });

    it('preserves inherited context on a self resume', async () => {
      callerIdentity.current.ownerId = dead.ownerId;
      const result = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false, brief: 'continue own work' }, ctx);
      expect(isError(result), textOf(result)).toBe(false);
      expect(writtenGoals).toEqual([]);
      expect(inheritedGoal).toBe('goal-paused');
    });

    it('preserves the source inherited context when forking', async () => {
      const result = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: true, brief: 'independent fork' }, ctx);
      expect(isError(result), textOf(result)).toBe(false);
      expect(writtenGoals).toEqual([]);
      expect(inheritedGoal).toBe('goal-paused');
    });

    it('does not clear context on an unattributed resume', async () => {
      callerIdentity.current.ownerId = null;
      const result = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false, brief: 'continue' }, ctx);
      expect(isError(result)).toBe(true);
      expect(writtenGoals).toEqual([]);
      expect(inheritedGoal).toBe('goal-paused');
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });
  });

  it.each([true, false])('reserves a dormant source before governed admission and passes the same key to its exact child (terminal stamp %s)', async (terminalStamp) => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(terminalStamp ? dead : { ...dead, endedAt: null, endedBy: null });
    const result = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false, brief: 'continue exact work' }, ctx);
    expect(isError(result), textOf(result)).toBe(false);
    expect(acquireAdvSessionResumeMock).toHaveBeenCalledWith(11, expect.any(String), 300, undefined, undefined, true);
    expect(acquireAdvSessionResumeMock.mock.invocationCallOrder[0])
      .toBeLessThan(spawnGovernedAgentProcessMock.mock.invocationCallOrder[0]);
    const reservation = JSON.parse(spawnedEnv().PAPERCUSP_GOVERNED_RESUME_RESERVATION);
    expect(reservation).toMatchObject({ advSessionId: 11, ownerId: dead.ownerId,
      claimKey: acquireAdvSessionResumeMock.mock.calls[0][1] });
    expect(spawnGovernedAgentProcessMock).toHaveBeenCalledWith(expect.objectContaining({
      owner: dead.ownerId,
      metadata: expect.objectContaining({ launchedBy: 'su-caller', targetOwnerId: dead.ownerId,
        resumeAdvSessionId: 11, resumeClaimKey: reservation.claimKey,
        resumeStartupExpiresAtMs: reservation.expiresAtMs }),
    }), expect.any(Function));
    expect(releaseAdvSessionResumeMock).not.toHaveBeenCalled();
    expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
  });

  it('releases the exact startup reservation after a pre-child governor refusal', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(dead);
    spawnGovernedAgentProcessMock.mockRejectedValueOnce(new Error('governor refused'));
    const result = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false, brief: 'continue exact work' }, ctx);
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('governor refused');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(acquireAdvSessionResumeMock).toHaveBeenCalledTimes(1);
    expect(releaseAdvSessionResumeMock).toHaveBeenCalledWith(11, acquireAdvSessionResumeMock.mock.calls[0][1]);
  });

  it('refuses admission and process start when a competing resume reservation wins', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(dead);
    acquireAdvSessionResumeMock.mockResolvedValueOnce({ acquired: false, status: 'reserved' });
    const result = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false, brief: 'continue exact work' }, ctx);
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('reservation refused: reserved');
    expect(spawnGovernedAgentProcessMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(releaseAdvSessionResumeMock).not.toHaveBeenCalled();
  });

  describe('D019 original member restoration', () => {
    const uuid = '0123abcd-1234-5678-9abc-def012345678';
    const source = { ...dead, workspaceId: 'ws-test', harnessSlug: 'papercusp', agent: 'codex', sessionId: uuid, account: 'auto',
      model: 'gpt-6:high', headless: true, binding: { ...dead.binding, sessionId: uuid } };
    const pin = { ownerId: source.ownerId, advSessionId: source.advSessionId, sessionId: uuid };
    const original = { v: 1, ...pin, workspaceId: 'ws-test', agent: 'codex',
      launchSpec: { v: 1, agent: 'codex', workspaceId: 'ws-test', harnessSlug: 'papercusp',
        model: 'gpt-6:high', fleet: { slug: 'target-fleet', role: 'member' } },
      launchArgv: ['psu', '--agent=codex', '--harness=papercusp', '--fleet=target-fleet',
        '--account=default', '--model=gpt-6:high', '--carry=warm', '--profile=engineer'] };
    const record = { workspaceId: 'ws-test', agent: 'codex', launchArgv: ['psu', '--account=auto'],
      launchSpec: { originalMemberLaunch: original } };
    const request = { resume: { sessionId: uuid }, restoreOriginalMember: pin, brief: 'continue original work' };
    beforeEach(() => {
      resolveResumeTargetMock.mockResolvedValue(source);
      findLiveHostMock.mockReturnValue(null);
      latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
      readAdvSessionLaunchRecordByOwnerMock.mockResolvedValue(record);
      getFleetHeadcountTargetMock.mockResolvedValue({ workspaceId: 'ws-test', fleetSlug: 'target-fleet',
        target: 10, config: { harness: 'papercusp', agent: 'codex', account: 'auto', model: 'gpt-6',
          effort: 'xhigh', headless: true, carry: 'cold' } });
    });

    it('restores original default/model/effort/placement/carry instead of fleet auto without invoking gateway-only repair', async () => {
      const result = await launchAgent.handler(request as never, ctx);
      expect(isError(result), textOf(result)).toBe(false);
      const command = spawnedCommand();
      expect(command).toContain(`--resume=${uuid}`);
      expect(command).toContain('--account=default');
      expect(command).toContain('--model=gpt-6:high');
      expect(command).toContain('--carry=warm');
      expect(command).toContain('--profile=engineer');
      expect(command).not.toContain('--headless');
      expect(command).not.toContain('--fork');
      expect(originalRoutingGuardMock).not.toHaveBeenCalled();
      expect(spawnedEnv()).not.toHaveProperty('PAPERCUSP_ORIGINAL_CODEX_ROUTING');
      expect(readAdvSessionLaunchRecordByOwnerMock).toHaveBeenCalledWith(source.ownerId, 'ws-test',
        { advSessionId: source.advSessionId, sessionId: uuid });
    });

    it('refuses missing original provenance rather than substituting the current auto record', async () => {
      readAdvSessionLaunchRecordByOwnerMock.mockResolvedValue({ ...record, launchSpec: {} });
      const result = await launchAgent.handler(request as never, ctx);
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('Original member routing provenance is missing');
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
    });

    it.each(['live', 'unterminated', 'writer', 'changed-binding', 'changed-profile'])('refuses %s custody', async (failure) => {
      if (failure === 'live') resolveResumeTargetMock.mockResolvedValue({ ...source, live: true });
      if (failure === 'unterminated') resolveResumeTargetMock.mockResolvedValue({ ...source, endedAt: null, endedBy: null });
      if (failure === 'writer') codexThreadWriterHolderMock.mockReturnValue({
        held: true, pid: null, lockPath: null, sessionId: null, reason: 'held',
      });
      if (failure === 'changed-binding') resolveResumeTargetMock.mockResolvedValueOnce(source).mockResolvedValue({
        ...source, binding: { ...source.binding, startedAt: 'changed' } });
      if (failure === 'changed-profile') readAdvSessionLaunchRecordByOwnerMock.mockResolvedValueOnce(record)
        .mockResolvedValue({ ...record, launchArgv: ['changed'] });
      const result = await launchAgent.handler(request as never, ctx);
      expect(isError(result), textOf(result)).toBe(true);
      expect(textOf(result)).toMatch(failure === 'changed-profile' ? /routing settings changed/ :
        failure === 'changed-binding' ? /source custody changed/ : failure === 'writer' ? /LIVE|writer/ :
          /exact original binding must be terminal/);
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
    });

    it('keeps the real originalRouting guard gateway-only for a default account', async () => {
      const actual = await vi.importActual<typeof import('../../../../../apps/operator/scripts/psu-launcher.mjs')>(
        '../../../../../apps/operator/scripts/psu-launcher.mjs');
      expect(() => actual.assertOriginalCodexRouting({ id: pin.advSessionId, agent: 'codex',
        coordOwnerId: pin.ownerId, sessionId: uuid, endedAt: source.endedAt, account: 'default' },
      { ...pin, codexHome: '/unused', profileFingerprint: 'a'.repeat(64) })).toThrow('saved gateway account is missing');
    });

    it('rechecks receipt settings after governed admission before opening a process', async () => {
      readAdvSessionLaunchRecordByOwnerMock.mockResolvedValueOnce(record).mockResolvedValueOnce(record)
        .mockResolvedValue({ ...record, launchArgv: ['changed-after-admission'] });
      const result = await launchAgent.handler(request as never, ctx);
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('routing settings changed');
      expect(spawnGovernedAgentProcessMock).toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
      expect(releaseAdvSessionResumeMock).toHaveBeenCalled();
    });

    it('refuses inherited goal placement that conflicts with the original visible member', async () => {
      goalLaunchResolveMock.mockResolvedValueOnce({ goalId: 'goal-1', settings: null,
        effective: { account: 'default', model: 'gpt-6:high', headless: true }, refusal: null, budget: null,
        goalBrief: null, ceilings: { maxAgents: 12, maxPerFleet: 5 }, headcount: { total: 1, fleet: null },
        degraded: false, degradedReasons: [] });
      const result = await launchAgent.handler(request as never, ctx);
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('inherited goal profile conflicts');
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
    });

    it.each([{ account: 'auto' }, { model: 'gpt-6:xhigh' }, { fork: true }, { carry: 'cold' },
      { originalRouting: { ...pin, codexHome: '/unused', profileFingerprint: 'a'.repeat(64) } }])(
      'refuses caller settings overrides %j', async (override) => {
        const result = await launchAgent.handler({ ...request, ...override } as never, ctx);
        expect(isError(result)).toBe(true);
        expect(textOf(result)).toContain('without fork, successor or profile overrides');
        expect(spawnConsoleMock).not.toHaveBeenCalled();
        expect(spawnHeadlessMock).not.toHaveBeenCalled();
      });
  });

  describe('originalRouting custody contract', () => {
    const uuid = '0123abcd-1234-5678-9abc-def012345678';
    const source = { ...dead, agent: 'codex', sessionId: uuid, account: 'auto',
      model: null, headless: false, binding: { ...dead.binding, sessionId: uuid } };
    const pin = { ownerId: source.ownerId, advSessionId: source.advSessionId, sessionId: uuid,
      codexHome: '/isolated/session-11', profileFingerprint: 'a'.repeat(64) };
    const request = { resume: { sessionId: uuid }, originalRouting: pin, brief: 'continue original work' };

    it('passes the custody pin through the governed exact resume without forking or changing account', async () => {
      resolveResumeTargetMock.mockResolvedValue(source);
      const result = await launchAgent.handler(request, ctx);
      expect(isError(result)).toBe(false);
      expect(spawnedCommand()).toContain(`--resume=${uuid}`);
      expect(spawnedCommand()).toContain('--account=auto');
      expect(spawnedCommand()).not.toContain('--fork');
      expect(spawnedCommand()).not.toContain('--model=');
      expect(dataOf(result)?.launch).toMatchObject({ mode: 'resume', resumedOwnerId: source.ownerId });
      expect(spawnConsoleMock.mock.calls[0]?.[0]).toMatchObject({
        envelope: { env: { PAPERCUSP_ORIGINAL_CODEX_ROUTING: JSON.stringify(pin) } },
      });
      expect(originalRoutingGuardMock).toHaveBeenCalledTimes(3);
      expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    });

    it('reconciles an exact dead unended binding with terminal evidence before original routing', async () => {
      const stale = { ...source, endedAt: null, endedBy: null };
      const reconciled = { ...stale, endedAt: '2026-10-11T07:00:00.000Z', endedBy: 'reconciler' };
      findLiveHostMock.mockReturnValue(null);
      resolveResumeTargetMock.mockResolvedValueOnce(stale).mockResolvedValueOnce(stale).mockResolvedValue(reconciled);
      resolveSessionStatesMock.mockResolvedValueOnce(new Map([[source.ownerId, { sessionState: 'ended' }]]));

      const result = await launchAgent.handler(request, ctx);

      expect(isError(result)).toBe(false);
      expect(resolveSessionStatesMock).toHaveBeenCalledWith([{ ownerId: source.ownerId }], { hydratePerId: true });
      expect(markAdvSessionEndedMock).toHaveBeenCalledWith(source.advSessionId, null, 'reconciler', {
        expectedBinding: source.binding,
        throwOnError: true,
      });
      expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
      expect(spawnedCommand()).toContain(`--resume=${uuid}`);
      expect(spawnedCommand()).not.toContain('--fork');
    });

    it('refuses to reconcile an unended original when terminal evidence is not positive', async () => {
      const stale = { ...source, endedAt: null, endedBy: null };
      findLiveHostMock.mockReturnValue(null);
      resolveResumeTargetMock.mockResolvedValue(stale);
      resolveSessionStatesMock.mockResolvedValueOnce(new Map([[source.ownerId, { sessionState: 'unknown' }]]));

      const result = await launchAgent.handler(request, ctx);

      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('positive terminal evidence is required');
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('refuses a changed original binding before terminal reconciliation', async () => {
      const stale = { ...source, endedAt: null, endedBy: null };
      resolveResumeTargetMock.mockResolvedValueOnce(stale).mockResolvedValue({
        ...stale,
        binding: { ...stale.binding, startedAt: '2026-07-11 10:00:00.123456+00' },
      });

      const result = await launchAgent.handler(request, ctx);

      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('original custody or saved settings changed');
      expect(resolveSessionStatesMock).not.toHaveBeenCalled();
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('retains the recorded restricted role in every original profile validation', async () => {
      resolveResumeTargetMock.mockResolvedValue({ ...source, role: 'judge' });
      const result = await launchAgent.handler(request, ctx);
      expect(isError(result)).toBe(false);
      expect(originalRoutingGuardMock).toHaveBeenCalledTimes(3);
      for (const [record] of originalRoutingGuardMock.mock.calls) expect(record).toMatchObject({ role: 'judge' });
    });

    it.each([true, false])('inherits original placement without a request override (%s)', async (headless) => {
      resolveResumeTargetMock.mockResolvedValue({ ...source, headless });
      const result = await launchAgent.handler({ ...request }, ctx);
      expect(isError(result)).toBe(false);
      const chosen = headless ? spawnHeadlessMock : spawnConsoleMock;
      expect(chosen).toHaveBeenCalledTimes(1);
      expect(headless ? spawnConsoleMock : spawnHeadlessMock).not.toHaveBeenCalled();
      expect(spawnedCommand(chosen).includes('--headless')).toBe(headless);
      expect(request).not.toHaveProperty('headless');
    });

    it('refuses unknown original placement before opening a process', async () => {
      resolveResumeTargetMock.mockResolvedValue({ ...source, headless: undefined });
      const result = await launchAgent.handler({ ...request }, ctx);
      expect(isError(result)).toBe(true);
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it.each([{ fork: true }, { successor: { agentId: 'su-other' } }, { agent: 'claude' },
      { model: 'gpt-6' }, { account: 'default' }, { extraArgs: ['--force'] }])(
      'refuses request overrides before opening a process: %j', async (override) => {
        const result = await launchAgent.handler({ ...request, ...override } as Parameters<typeof launchAgent.handler>[0], ctx);
        expect(isError(result)).toBe(true);
        expect(spawnConsoleMock).not.toHaveBeenCalled();
      });

    it('refuses a live original instead of automatically forking it', async () => {
      resolveResumeTargetMock.mockResolvedValue({ ...source, live: true });
      const result = await launchAgent.handler(request, ctx);
      expect(isError(result)).toBe(true);
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    });

    it('rechecks original custody before governed admission', async () => {
      resolveResumeTargetMock.mockResolvedValueOnce(source).mockResolvedValue({ ...source, ownerId: 'su-other' });
      const result = await launchAgent.handler(request, ctx);
      expect(isError(result)).toBe(true);
      expect(spawnGovernedAgentProcessMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('rechecks the local profile after governed admission and before spawn', async () => {
      resolveResumeTargetMock.mockResolvedValue(source);
      originalRoutingGuardMock.mockImplementationOnce(() => {}).mockImplementationOnce(() => {})
        .mockImplementationOnce(() => { throw new Error('profile changed'); });
      const result = await launchAgent.handler(request, ctx);
      expect(isError(result)).toBe(true);
      expect(spawnGovernedAgentProcessMock).toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });
  });

  it('uses distinct governed admission keys for concurrent exact resumes', async () => {
    const secondDead = {
      ...dead,
      sessionId: 'sid-dead-2',
      ownerId: 'su-a2a72',
      advSessionId: 12,
      binding: {
        ...dead.binding,
        coordOwnerId: 'su-a2a72',
        sessionId: 'sid-dead-2',
      },
    };
    resolveResumeTargetMock.mockImplementation(async (ref: { agentId?: string }) =>
      ref.agentId === 'su-a2a72' ? secondDead : dead,
    );
    findLiveHostMock.mockReturnValue(null);
    // Reproduce the production collision: separate calls can share one clock
    // tick, so a timestamp-only internal admission key is not unique.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_789_390_201_920);
    try {
      const results = await Promise.all([
        launchAgent.handler(
          { resume: { agentId: 'su-a1a71' }, brief: 'restore the first session', idempotencyKey: 'resume-one' },
          ctx,
        ),
        launchAgent.handler(
          { resume: { agentId: 'su-a2a72' }, brief: 'restore the second session', idempotencyKey: 'resume-two' },
          ctx,
        ),
      ]);

      expect(results.every((result) => !isError(result))).toBe(true);
      const admissionKeys = spawnGovernedAgentProcessMock.mock.calls.map(
        ([input]) => (input as { idempotencyKey: string }).idempotencyKey,
      );
      expect(admissionKeys).toHaveLength(2);
      expect(new Set(admissionKeys).size).toBe(2);
      expect(admissionKeys.every((key) => key.startsWith('agent-spawn:su-caller:1789390201920:'))).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it.each([false, true])('pins each fork reservation to its bootstrap identity (headless=%s)', async (headless) => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    goalLaunchResolveMock.mockResolvedValueOnce({
      goalId: null, settings: null, effective: {}, refusal: null, budget: null, goalBrief: null,
      ceilings: { maxAgents: 6, maxPerFleet: 3 }, headcount: { total: 5, fleet: null },
      degraded: false, degradedReasons: [],
    });
    const result = await launchAgent.handler({
      resume: { agentId: dead.ownerId }, fork: true, headless,
      brief: 'branch the recovery', count: 2,
    }, ctx);
    expect(isError(result)).toBe(false);
    const owners = spawnGovernedAgentProcessMock.mock.calls.map(([input]) =>
      (input as { metadata: { targetOwnerId: string } }).metadata.targetOwnerId);
    expect(owners).toHaveLength(2);
    expect(new Set(owners).size).toBe(2);
    const spawns = headless ? spawnHeadlessMock : spawnConsoleMock;
    for (const [i, owner] of owners.entries()) {
      expect(owner).toMatch(/^su-[0-9a-f-]{36}$/);
      expect(owner).not.toBe(dead.ownerId);
      expect(spawnGovernedAgentProcessMock.mock.calls[i][0]).toMatchObject({ owner });
      const options = spawns.mock.calls[i][0] as { envelope: { greetingCmd: string }; coordOwnerId?: string };
      expect(options.envelope.greetingCmd).toContain(`--owner-id=${owner}`);
      if (headless) expect(options).toMatchObject({ coordOwnerId: owner });
    }
    expect(dataOf(result)?.launch).toMatchObject({ ownerIds: owners });
    expect(goalLaunchResolveMock.mock.calls[0][0]).not.toHaveProperty('excludeOwnerIds');
  });

  it('excludes only the retained owner from the batch preflight for an in-place resume', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    goalLaunchResolveMock.mockResolvedValueOnce({
      goalId: null, settings: null, effective: {}, refusal: null, budget: null, goalBrief: null,
      ceilings: { maxAgents: 6, maxPerFleet: 3 }, headcount: { total: 5, fleet: null },
      degraded: false, degradedReasons: [],
    });
    await launchAgent.handler({ resume: { agentId: dead.ownerId }, brief: 'resume at the ceiling' }, ctx);
    expect(goalLaunchResolveMock).toHaveBeenCalledWith(expect.objectContaining({
      count: 1, excludeOwnerIds: [dead.ownerId],
    }));
    expect(spawnGovernedAgentProcessMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ targetOwnerId: dead.ownerId }),
    }), expect.any(Function));
    expect(spawnedCommand()).not.toContain('--owner-id=');
  });

  it('preserves a started member and its claim when another member loses final goal admission', async () => {
    spawnGovernedAgentProcessMock.mockImplementationOnce(async (_input, spawnProcess) =>
      spawnProcess({ receiptId: 'WI-governed-test', leaseId: 'lease-governed-test' }));
    spawnGovernedAgentProcessMock.mockResolvedValueOnce({
      status: 'error', error: 'goal seat already reserved', code: 409,
    });
    const result = await launchAgent.handler({ brief: 'bounded batch', count: 2, idempotencyKey: 'partial-seat' }, ctx);
    expect(spawnConsoleMock).toHaveBeenCalledOnce();
    expect(dataOf(result)?.launch).toMatchObject({ opened: 1, failed: 1, partial: true });
    expect(textOf(result)).toContain('goal seat already reserved');
    expect(releaseAgentLaunchClaimMock).not.toHaveBeenCalled();
    expect(recordAgentLaunchResultMock).toHaveBeenCalled();
  });

  it('starts an identity-preserving fresh successor for an ended critical source', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(dead);
    fetchContextPressureMock.mockResolvedValue(new Map([['su-a1a71', 'critical']]));
    buildCarryBriefMock.mockResolvedValue({ ownerId: 'su-a1a71' });
    renderCarryBriefTextMock.mockReturnValue('checkpoint: finish the successor wiring');
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-successor-1', successfulCalls: 1 }],
      note: 'successor verified',
    });

    const res = await launchAgent.handler(
      {
        successor: { agentId: 'su-a1a71' },
        brief: 'continue the recovery',
      },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(spawnedCommand()).toContain('--agent=claude --owner-id=su-a1a71 --harness=papercusp');
    expect(spawnedCommand()).not.toContain('--resume=');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('continue the recovery');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('checkpoint: finish the successor wiring');
    expect(buildCarryBriefMock).toHaveBeenCalledWith('su-a1a71', { workspaceId: 'ws-test' });
    expect(verifyFreshLaunchStartedMock).toHaveBeenCalledWith(
      expect.objectContaining({ expected: 1, expectedOwnerIds: ['su-a1a71'] }),
    );
    expect(dataOf(res)?.launch).toMatchObject({
      mode: 'successor',
      resumedOwnerId: 'su-a1a71',
      agentStarted: true,
      freshVerdict: {
        agentStarted: true,
        sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-successor-1' }],
      },
    });
    expect(textOf(res)).toContain("agent's first turn");
  });

  // EI-27199337851073256: an operator-scope caller (harness '*') relaunching a predecessor
  // recorded in a real harness opened the successor with NO --harness and no harness in its
  // MCP envelope; the fresh psu then bound to an unrelated hive and every claim it retained
  // was refused harness_forbidden. The successor must inherit the predecessor's harness.
  it.each([
    ['an operator-scope caller', { workspaceId: 'ws-test', harnessSlug: '*', role: 'su' }],
    ['a caller scoped to a different harness', { workspaceId: 'ws-test', harnessSlug: 'other-hive', role: 'su' }],
  ])('launches a successor in the predecessor\'s recorded harness for %s', async (_label, callerCtx) => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue({ ...dead, workspaceId: 'ws-test', harnessSlug: 'papercusp' });
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-harness-successor', successfulCalls: 1 }],
      note: 'successor verified',
    });

    const res = await launchAgent.handler(
      { successor: { agentId: 'su-a1a71' }, brief: 'continue the recovery' },
      callerCtx as never,
    );

    expect(isError(res), textOf(res)).toBe(false);
    expect(spawnedCommand()).toContain('--owner-id=su-a1a71 --harness=papercusp');
    expect(buildConsoleEnvelopeMock.mock.calls[0]?.[0]).toMatchObject({ slug: 'papercusp' });
    expect(gateWorkScopeMock).toHaveBeenCalledWith('capability:launch-agent', expect.objectContaining({ harness: 'papercusp' }));
    expect(textOf(res)).toContain("predecessor's recorded harness 'papercusp'");
  });

  it('lets an explicit harness override the predecessor harness for a successor', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue({ ...dead, workspaceId: 'ws-test', harnessSlug: 'other-hive' });
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-explicit-harness', successfulCalls: 1 }],
      note: 'successor verified',
    });

    const res = await launchAgent.handler(
      { successor: { agentId: 'su-a1a71' }, harness: 'papercusp', brief: 'continue the recovery' },
      { workspaceId: 'ws-test', harnessSlug: '*', role: 'su' } as never,
    );

    expect(isError(res), textOf(res)).toBe(false);
    expect(spawnedCommand()).toContain('--harness=papercusp');
    expect(spawnedCommand()).not.toContain('--harness=other-hive');
  });

  it('preserves a specialized source role and accepted-operation feature when starting a successor', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue({
      ...dead,
      role: 'crm-agent',
      feature: 'WI-10007049',
    });
    renderCarryBriefTextMock.mockReturnValue('checkpoint: continue the accepted operation');
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-specialized-successor', successfulCalls: 1 }],
      note: 'specialized successor verified',
    });

    const res = await launchAgent.handler(
      {
        successor: { agentId: 'su-a1a71' },
        agent: 'claude',
        model: 'sonnet',
        headless: true,
        brief: 'continue the accepted operation',
      },
      ctx,
    );

    expect(isError(res), textOf(res)).toBe(false);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnedCommand(spawnHeadlessMock)).toContain('--role=crm-agent');
    expect(spawnedCommand(spawnHeadlessMock)).toContain('--feature=WI-10007049');
    expect(assembleRolePromptMock).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'papercusp',
      role: 'crm-agent',
    }));
  });

  it('starts an ended Codex cold-loop successor without resuming its critical transcript', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue({ ...dead, agent: 'codex' });
    const pressure = new Map<string, 'critical'>([['su-a1a71', 'critical']]);
    fetchContextPressureMock.mockImplementation(async () => pressure);
    clearContextEstimateMock.mockImplementation(async (ownerId) => { pressure.delete(ownerId); });
    renderCarryBriefTextMock.mockReturnValue('checkpoint: continue the held claim');
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-cold-successor', successfulCalls: 1 }],
      note: 'cold successor verified',
    });

    const res = await launchAgent.handler(
      {
        successor: { agentId: 'su-a1a71' },
        brief: 'continue the cold loop wake',
        headless: true,
        carry: 'cold',
        idempotencyKey: 'cold-wake:123',
      },
      ctx,
    );

    expect(isError(res), textOf(res)).toBe(false);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    const command = spawnedCommand(spawnHeadlessMock);
    expect(command).toContain('--agent=codex');
    expect(command).toContain('--owner-id=su-a1a71');
    expect(command).toContain('--carry=cold');
    expect(command).not.toContain('--resume=');
    expect(spawnedEnv(spawnHeadlessMock).PAPERCUSP_KICKOFF_PROMPT).toContain('checkpoint: continue the held claim');
    expect(clearContextEstimateMock).toHaveBeenCalledWith('su-a1a71');
    expect(clearContextEstimateMock.mock.invocationCallOrder[0]).toBeLessThan(spawnHeadlessMock.mock.invocationCallOrder[0]);
    expect((await fetchContextPressureMock(['su-a1a71'])).get('su-a1a71')).toBeUndefined();
    expect(dataOf(res)?.launch).toMatchObject({
      mode: 'successor',
      resumedOwnerId: 'su-a1a71',
      agentStarted: true,
      tasks: [{ ownerId: 'su-a1a71', headless: true }],
    });
  });

  it('does not open a successor when predecessor context pressure cannot be invalidated', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue({ ...dead, agent: 'codex' });
    clearContextEstimateMock.mockRejectedValueOnce(new Error('presence unavailable'));

    const res = await launchAgent.handler(
      { successor: { agentId: 'su-a1a71' }, headless: true, idempotencyKey: 'cold-wake:failed-clear' },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('failed to invalidate predecessor context pressure');
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(releaseAgentLaunchClaimMock).toHaveBeenCalledWith({
      workspaceId: 'ws-test', idempotencyKey: 'cold-wake:failed-clear',
    });
  });

  it('lets native Codex exact resume inherit the last turn model and effort, not stale launch argv', async () => {
    resolveResumeTargetMock.mockResolvedValue({
      ...dead,
      agent: 'codex',
      model: 'gpt-5.6-sol:xhigh',
      modelSource: 'inherited',
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, brief: 'continue the Codex recovery' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(spawnedCommand()).toContain('--resume=sid-dead');
    expect(spawnedCommand()).not.toContain('--model=');
    expect(spawnedCommand()).not.toContain('--model-source=');
  });

  it('lets native Codex resume choose its recorded fallback when a transcript has no model', async () => {
    resolveResumeTargetMock.mockResolvedValue({
      ...dead,
      agent: 'codex',
      model: null,
      modelSource: null,
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, brief: 'continue the legacy Codex recovery' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(spawnedCommand()).not.toContain('--model=');
    expect(spawnedCommand()).not.toContain('--model-source=');
  });

  it('preserves an explicit Codex resume override over the last turn selection', async () => {
    resolveResumeTargetMock.mockResolvedValue({
      ...dead,
      agent: 'codex',
      model: 'gpt-5.6-sol:xhigh',
      modelSource: 'inherited',
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, brief: 'continue the Codex recovery', model: 'gpt-6-astra:xhigh' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(spawnedCommand()).toContain('--model=gpt-6-astra:xhigh --model-source=explicit');
  });

  it('allows a successor to override the predecessor runtime and launch placement', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue({ ...dead, agent: 'codex' });
    renderCarryBriefTextMock.mockReturnValue('checkpoint: recover on the alternate runtime');
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-successor-override', successfulCalls: 1 }],
      note: 'successor override verified',
    });

    const res = await launchAgent.handler(
      {
        successor: { agentId: 'su-a1a71' },
        brief: 'recover on the alternate runtime',
        agent: 'claude',
        account: 'auto',
        model: 'sonnet',
        headless: true,
        carry: 'warm',
        label: 'alternate successor',
      },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    const command = spawnedCommand(spawnHeadlessMock);
    expect(command).toContain('--agent=claude');
    expect(command).toContain('--account=auto');
    expect(command).toContain('--model=sonnet');
    expect(command).toContain('--headless');
    expect(command).toContain('--carry=warm');
    expect(command).toContain('--owner-id=su-a1a71');
    expect(textOf(res)).toContain('Successor backend override');
  });

  it('promotes a dormant critical resume to an identity-preserving fresh successor', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(dead);
    fetchContextPressureMock.mockResolvedValue(new Map([['su-a1a71', 'critical']]));
    renderCarryBriefTextMock.mockReturnValue('checkpoint: recover the held claim');
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-auto-successor-1', successfulCalls: 1 }],
      note: 'automatic successor verified',
    });

    const res = await launchAgent.handler(
      {
        resume: { agentId: 'su-a1a71' },
        brief: 'continue the recovery',
      },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(spawnedCommand()).toContain('--agent=claude --owner-id=su-a1a71 --harness=papercusp');
    expect(spawnedCommand()).not.toContain('--resume=');
    expect(spawnedCommand()).not.toContain('--fork');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('continue the recovery');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('checkpoint: recover the held claim');
    expect(buildCarryBriefMock).toHaveBeenCalledWith('su-a1a71', { workspaceId: 'ws-test' });
    expect(verifyFreshLaunchStartedMock).toHaveBeenCalledWith(
      expect.objectContaining({ expected: 1, expectedOwnerIds: ['su-a1a71'] }),
    );
    expect(dataOf(res)?.launch).toMatchObject({
      mode: 'successor',
      resumedOwnerId: 'su-a1a71',
      agentStarted: true,
      freshVerdict: {
        agentStarted: true,
        sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-auto-successor-1' }],
      },
    });
    expect(textOf(res)).toContain('DORMANT at CRITICAL context pressure');
  });

  it('keeps an exact dormant transcript pin at critical pressure instead of creating a successor', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(dead);
    fetchContextPressureMock.mockResolvedValue(new Map([['su-a1a71', 'critical']]));

    const res = await launchAgent.handler(
      { resume: { sessionId: 'sid-dead' }, brief: 'restore this exact conversation' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(spawnedCommand()).toContain('--resume=sid-dead');
    expect(spawnedCommand()).not.toContain('--fork');
    expect(buildCarryBriefMock).not.toHaveBeenCalled();
    expect(verifyResumeStartedMock).toHaveBeenCalled();
    expect(verifyFreshLaunchStartedMock).not.toHaveBeenCalled();
  });

  describe('successor predecessor reconciliation (EI-22446987530949437)', () => {
    const stale = { ...dead, endedAt: null, endedBy: null };
    const request = { successor: { agentId: dead.ownerId }, idempotencyKey: 'successor-cas' };

    beforeEach(() => {
      resolveResumeTargetMock.mockReset();
      resolveResumeTargetMock.mockResolvedValue(stale);
      findLiveHostMock.mockReset();
      findLiveHostMock.mockReturnValue(null);
    });

    describe('exact terminal headless task custody (EI-26731140517030664)', () => {
      const source = { ...stale, agent: 'codex', workspaceId: 'ws-test', harnessSlug: 'papercusp', pid: 4102 };
      const task = {
        taskId: 'task-exact-ended', workspaceId: 'ws-test', sessionId: source.sessionId,
        class: 'agent-session', pid: source.pid, state: 'exited', exitCode: 0,
        startedAt: '2026-07-11T09:01:00.000Z', endedAt: '2026-07-11T10:00:00.000Z',
        detail: { coordOwnerId: source.ownerId, advSessionId: source.advSessionId, launchSurface: 'wake-resume-headless' },
      };
      beforeEach(() => {
        resolveResumeTargetMock.mockResolvedValue(source);
        resolveSessionStatesMock.mockResolvedValue(new Map([[source.ownerId, { sessionState: 'live', pid: null, host: null }]]));
        listSuccessorTasksMock.mockResolvedValue([task]);
        acquireAdvSessionResumeMock.mockImplementation(async (...args: unknown[]) => {
          // This branch reserves before its terminal CAS. Match the writer's
          // ended-only refusal so accidentally requiring terminal row evidence
          // cannot make the successful task-custody tests pass through a stub.
          if ((args[6] as { requireTerminal?: boolean } | undefined)?.requireTerminal) {
            return { acquired: false, status: 'live' };
          }
          return {
            acquired: true, replayed: acquireAdvSessionResumeMock.mock.calls.length > 1,
            leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          };
        });
      });

      it('uses the exact scoped native-task reader despite unavailable presence process details', async () => {
        const res = await launchAgent.handler(request, ctx);
        expect(isError(res), textOf(res)).toBe(false);
        expect(listSuccessorTasksMock).toHaveBeenCalledWith({
          workspaceId: 'ws-test', coordOwnerId: source.ownerId, sessionId: source.sessionId,
          includeEnded: true, limit: 2,
        });
        expect(resolveSessionStatesMock).not.toHaveBeenCalled();
        expect(markAdvSessionEndedMock).toHaveBeenCalledWith(11, null, 'reconciler', {
          expectedBinding: source.binding, throwOnError: true,
        });
        expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
        expect(claimAgentLaunchMock.mock.invocationCallOrder[0]).toBeLessThan(acquireAdvSessionResumeMock.mock.invocationCallOrder[0]);
        expect(acquireAdvSessionResumeMock.mock.invocationCallOrder[0]).toBeLessThan(markAdvSessionEndedMock.mock.invocationCallOrder[0]);
        expect(markAdvSessionEndedMock.mock.invocationCallOrder[0]).toBeLessThan(spawnConsoleMock.mock.invocationCallOrder[0]);
        expect(releaseAdvSessionResumeMock).toHaveBeenCalledWith(11, acquireAdvSessionResumeMock.mock.calls[0][1]);
      });

      const noSpawn = () => {
        expect(spawnConsoleMock).not.toHaveBeenCalled();
        expect(spawnHeadlessMock).not.toHaveBeenCalled();
        expect(releaseAgentLaunchClaimMock).toHaveBeenCalledWith({ workspaceId: 'ws-test', idempotencyKey: 'successor-cas' });
      };

      it('qualifies only the newest exact row when older terminal history exists', async () => {
        listSuccessorTasksMock.mockResolvedValue([task, { ...task, taskId: 'older', pid: 123, startedAt: '2026-07-11T09:00:30.000Z' }]);
        expect(isError(await launchAgent.handler(request, ctx))).toBe(false);
        expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
        expect(releaseAdvSessionResumeMock).toHaveBeenCalledTimes(1);
      });

      it.each([
        { workspaceId: 'other-workspace' }, { sessionId: 'other-native' }, { pid: 4103 },
        { class: 'command' }, { detail: { ...task.detail, coordOwnerId: 'su-other' } },
        { detail: { ...task.detail, advSessionId: 12 } },
        { detail: { ...task.detail, launchSurface: 'other' } },
        { startedAt: '2026-07-11T08:59:00.000Z' }, { startedAt: 'unknown' },
        { startedAt: '2026-07-11T09:00:00.123Z' },
        { state: 'unknown' }, { state: 'exited', endedAt: null },
        { state: 'running' }, { state: 'running', endedAt: null },
        { endedAt: 'unknown' }, { endedAt: '2026-07-11T09:00:00.000Z' },
      ])('refuses incomplete or mismatched newest task %j even if legacy liveness says ended', async change => {
        listSuccessorTasksMock.mockResolvedValue([{ ...task, ...change }]);
        resolveSessionStatesMock.mockResolvedValue(new Map([[source.ownerId, { sessionState: 'ended' }]]));
        const res = await launchAgent.handler(request, ctx);
        expect(isError(res), textOf(res)).toBe(true);
        expect(resolveSessionStatesMock).not.toHaveBeenCalled();
        expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
        noSpawn();
      });

      it.each([
        { qualification: 'terminality', change: { state: 'running', endedAt: null } },
        { qualification: 'headless surface', change: { detail: { ...task.detail, launchSurface: 'other' } } },
        { qualification: 'ADV', change: { detail: { ...task.detail, advSessionId: 12 } } },
        { qualification: 'PID', change: { pid: 4103 } },
      ])('does not filter a newer task failing $qualification behind an older exact terminal task', async ({ change }) => {
        listSuccessorTasksMock.mockResolvedValue([{ ...task, taskId: 'newer', startedAt: '2026-07-11T09:02:00.000Z', ...change }, task]);
        const res = await launchAgent.handler(request, ctx);
        expect(isError(res), textOf(res)).toBe(true);
        expect(textOf(res)).toContain('newest predecessor task lacks exact terminal ADV/PID/incarnation custody');
        expect(resolveSessionStatesMock).not.toHaveBeenCalled();
        expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
        expect(acquireAdvSessionResumeMock).not.toHaveBeenCalled();
        expect(releaseAdvSessionResumeMock).not.toHaveBeenCalled();
        noSpawn();
      });

      it('does not filter a newer task from a later binding incarnation behind an older exact terminal task', async () => {
        // Same owner/native session/PID, but ADV 12 denotes a later persisted
        // binding. Its terminal task cannot authorize reconciling source ADV 11.
        const laterIncarnation = {
          ...source, advSessionId: 12,
          binding: { ...source.binding, startedAt: '2026-07-11 09:01:30.000000+00' },
        };
        listSuccessorTasksMock.mockResolvedValue([{
          ...task, taskId: 'newer-incarnation', startedAt: '2026-07-11T09:02:00.000Z',
          detail: { ...task.detail, advSessionId: laterIncarnation.advSessionId },
        }, task]);
        expect(Date.parse(laterIncarnation.binding.startedAt)).toBeGreaterThan(Date.parse(task.startedAt));
        const res = await launchAgent.handler(request, ctx);
        expect(isError(res), textOf(res)).toBe(true);
        expect(textOf(res)).toContain('newest predecessor task lacks exact terminal ADV/PID/incarnation custody');
        expect(resolveSessionStatesMock).not.toHaveBeenCalled();
        expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
        expect(acquireAdvSessionResumeMock).not.toHaveBeenCalled();
        expect(releaseAdvSessionResumeMock).not.toHaveBeenCalled();
        noSpawn();
      });

      it.each([task.startedAt, 'unknown', '1970-01-01T00:00:00.000Z', '2026-07-11T09:02:00.000Z'])('refuses tied or unknown/contradictory candidate ordering %s', async startedAt => {
        listSuccessorTasksMock.mockResolvedValue([task, { ...task, taskId: 'second', startedAt }]);
        expect(isError(await launchAgent.handler(request, ctx))).toBe(true);
        expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
        noSpawn();
      });

      it.each([
        { ownerId: 'su-other' }, { workspaceId: 'other' }, { sessionId: 'other' }, { advSessionId: 12 },
        { pid: 4103 }, { binding: { ...source.binding, startedAt: '2026-07-11 09:00:00.123457+00' } },
      ])('refuses binding movement after task observation %j', async change => {
        resolveResumeTargetMock.mockResolvedValueOnce(source).mockResolvedValueOnce(source).mockResolvedValue({ ...source, ...change });
        expect(isError(await launchAgent.handler(request, ctx))).toBe(true);
        expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
        noSpawn();
        expect(releaseAdvSessionResumeMock).toHaveBeenCalledTimes(1);
      });

      it.each(['host', 'writer'])('refuses a %s appearing after the task read without reconciling', async kind => {
        listSuccessorTasksMock.mockImplementation(async () => {
          if (kind === 'host') findLiveHostMock.mockReturnValue({ pid: 99 });
          else codexThreadWriterHolderMock.mockReturnValue({ held: true, pid: 99, reason: 'held', lockPath: 'lock', sessionId: source.sessionId });
          return [task];
        });
        expect(isError(await launchAgent.handler(request, ctx))).toBe(true);
        expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
        noSpawn();
        expect(releaseAdvSessionResumeMock).toHaveBeenCalledTimes(1);
      });

      it.each(['host', 'writer', 'binding', 'task'])('refuses changed %s after successful CAS with only that lifecycle mutation', async kind => {
        markAdvSessionEndedMock.mockImplementationOnce(async () => {
          if (kind === 'host') findLiveHostMock.mockReturnValue({ pid: 99 });
          if (kind === 'writer') codexThreadWriterHolderMock.mockReturnValue({ held: true, pid: 99, reason: 'held', lockPath: 'lock', sessionId: source.sessionId });
          if (kind === 'binding') resolveResumeTargetMock.mockResolvedValue({ ...source, pid: 4103 });
          if (kind === 'task') listSuccessorTasksMock.mockResolvedValue([{ ...task, state: 'running' }]);
          return true;
        });
        expect(isError(await launchAgent.handler(request, ctx))).toBe(true);
        expect(markAdvSessionEndedMock).toHaveBeenCalledTimes(1);
        expect(clearContextEstimateMock).not.toHaveBeenCalled();
        noSpawn();
        expect(releaseAdvSessionResumeMock).toHaveBeenCalledTimes(1);
      });

      it.each(['host', 'writer', 'binding', 'task', 'lease'])('rechecks %s inside governed admission immediately before spawn', async kind => {
        spawnGovernedAgentProcessMock.mockImplementationOnce(async (_input, spawnProcess) => {
          if (kind === 'host') findLiveHostMock.mockReturnValue({ pid: 99 });
          if (kind === 'writer') codexThreadWriterHolderMock.mockReturnValue({ held: true, pid: 99, reason: 'held', lockPath: 'lock', sessionId: source.sessionId });
          if (kind === 'binding') resolveResumeTargetMock.mockResolvedValue({ ...source, binding: { ...source.binding, startedAt: '2026-07-11 09:00:00.123457+00' } });
          if (kind === 'task') listSuccessorTasksMock.mockResolvedValue([{ ...task, taskId: 'replacement' }]);
          if (kind === 'lease') acquireAdvSessionResumeMock.mockResolvedValue({ acquired: false, status: 'reserved' });
          return spawnProcess({ receiptId: 'WI-governed-test', leaseId: 'lease-governed-test' });
        });
        await launchAgent.handler(request, ctx);
        expect(markAdvSessionEndedMock).toHaveBeenCalledTimes(1);
        noSpawn();
        expect(releaseAdvSessionResumeMock).toHaveBeenCalledTimes(1);
      });

      it('refuses an unknown native writer observation without CAS or spawn', async () => {
        codexThreadWriterHolderMock.mockReturnValue({ held: false, pid: null, reason: 'unreadable', lockPath: null, sessionId: source.sessionId });
        expect(isError(await launchAgent.handler(request, ctx))).toBe(true);
        expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
        noSpawn();
        expect(releaseAdvSessionResumeMock).toHaveBeenCalledTimes(1);
      });

      it('releases task custody when governed admission refuses before invoking its callback', async () => {
        spawnGovernedAgentProcessMock.mockImplementationOnce(async () => ({ status: 'error', code: 409, error: 'admission refused' }));
        await launchAgent.handler(request, ctx);
        noSpawn();
        expect(releaseAdvSessionResumeMock).toHaveBeenCalledTimes(1);
      });

      it('does not read tasks or acquire a lease when the launch claim is held', async () => {
        claimAgentLaunchMock.mockResolvedValueOnce({ won: false, priorSummary: null, priorLaunchedAt: null, priorLaunchedBy: null });
        await launchAgent.handler(request, ctx);
        expect(listSuccessorTasksMock).not.toHaveBeenCalled();
        expect(acquireAdvSessionResumeMock).not.toHaveBeenCalled();
        expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
        expect(spawnConsoleMock).not.toHaveBeenCalled();
      });

      it('refuses a held task custody reservation before CAS', async () => {
        acquireAdvSessionResumeMock.mockResolvedValueOnce({ acquired: false, status: 'reserved' });
        expect(isError(await launchAgent.handler(request, ctx))).toBe(true);
        expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
        expect(releaseAdvSessionResumeMock).not.toHaveBeenCalled();
        noSpawn();
      });

      it.each(['lost', 'expired', 'CAS', 'reader'])('releases acquired task custody on %s refusal', async kind => {
        if (kind === 'lost') acquireAdvSessionResumeMock.mockResolvedValueOnce({ acquired: true, leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() })
          .mockResolvedValueOnce({ acquired: false, status: 'reserved' });
        if (kind === 'expired') acquireAdvSessionResumeMock.mockResolvedValueOnce({ acquired: true, leaseExpiresAt: new Date(0).toISOString() });
        if (kind === 'CAS') markAdvSessionEndedMock.mockResolvedValueOnce(false);
        if (kind === 'reader') listSuccessorTasksMock.mockResolvedValueOnce([task]).mockRejectedValueOnce(new Error('ledger unavailable'));
        expect(isError(await launchAgent.handler(request, ctx))).toBe(true);
        expect(markAdvSessionEndedMock).toHaveBeenCalledTimes(kind === 'CAS' ? 1 : 0);
        expect(releaseAdvSessionResumeMock).toHaveBeenCalledTimes(1);
        noSpawn();
      });
    });

    it.each(['ended', 'suspect'])('reconciles a stale open binding with %s evidence before spawn', async (sessionState) => {
      resolveSessionStatesMock.mockResolvedValue(new Map([[dead.ownerId, { sessionState }]]));
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(false);
      expect(resolveSessionStatesMock).toHaveBeenCalledWith([{ ownerId: dead.ownerId }], { hydratePerId: true });
      expect(markAdvSessionEndedMock).toHaveBeenCalledWith(11, null, 'reconciler', {
        expectedBinding: dead.binding,
        throwOnError: true,
      });
      expect(claimAgentLaunchMock.mock.invocationCallOrder[0]).toBeLessThan(markAdvSessionEndedMock.mock.invocationCallOrder[0]);
      expect(markAdvSessionEndedMock.mock.invocationCallOrder[0]).toBeLessThan(spawnConsoleMock.mock.invocationCallOrder[0]);
      expect(spawnedCommand()).toContain('--owner-id=su-a1a71');
      expect(textOf(res)).toContain('actual exit time remains unknown');
    });

    it.each(['live', 'parked', 'recorded', 'draining', 'unknown', null, undefined])('refuses %s evidence without ending or spawning', async (sessionState) => {
      resolveSessionStatesMock.mockResolvedValue(new Map([[dead.ownerId, { sessionState }]]));
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('positive terminal evidence is required');
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(releaseAgentLaunchClaimMock).toHaveBeenCalledWith({ workspaceId: 'ws-test', idempotencyKey: 'successor-cas' });
    });

    it.each([null, dead.endedAt])('an active native Codex writer blocks a successor with endedAt=%s before terminal reconciliation', async (endedAt) => {
      resolveResumeTargetMock.mockResolvedValue({ ...stale, agent: 'codex', endedAt });
      codexThreadWriterHolderMock.mockReturnValue({
        held: true, pid: 12345, lockPath: '/tmp/codex/thread-writer-locks/native.lock',
        sessionId: stale.sessionId, reason: 'held',
      });
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('source session is still LIVE');
      expect(resolveSessionStatesMock).not.toHaveBeenCalled();
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it.each([1, 2])('refuses a native Codex writer appearing after %s clear checks during preparation', async (clearChecks) => {
      resolveResumeTargetMock.mockResolvedValue({ ...stale, agent: 'codex' });
      codexThreadWriterHolderMock.mockReturnValue({
        held: true, pid: 12345, lockPath: '/tmp/codex/thread-writer-locks/native.lock',
        sessionId: stale.sessionId, reason: 'held',
      });
      for (let i = 0; i < clearChecks; i++) {
        codexThreadWriterHolderMock.mockReturnValueOnce({
          held: false, pid: null, lockPath: null, sessionId: stale.sessionId, reason: 'no-lock-file',
        });
      }
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('active native Codex writer appeared');
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(releaseAgentLaunchClaimMock).toHaveBeenCalledWith({ workspaceId: 'ws-test', idempotencyKey: 'successor-cas' });
    });

    it.each([
      { advSessionId: 12 },
      { binding: { ...dead.binding, coordOwnerId: 'su-other' } },
      { binding: { ...dead.binding, sessionId: 'sid-successor' } },
      { binding: { ...dead.binding, startedAt: '2026-07-11 09:00:00.123457+00' } },
    ])('refuses a changed persisted incarnation (%j)', async (change) => {
      resolveResumeTargetMock.mockResolvedValueOnce(stale).mockResolvedValueOnce({ ...stale, ...change });
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('predecessor binding changed');
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('refuses a live host appearing after the terminal verdict', async () => {
      findLiveHostMock.mockReturnValueOnce(null).mockReturnValue({ pid: 42 });
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('LIVE source host appeared');
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('refuses a concurrent binding update that wins the lifecycle CAS', async () => {
      markAdvSessionEndedMock.mockResolvedValue(false);
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('lost its compare-and-swap');
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('refuses missing incarnation evidence without changing any row', async () => {
      resolveResumeTargetMock.mockResolvedValue({ ...stale, binding: null });
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('exact predecessor binding is unavailable');
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('finishes a half-written terminal marker before bootstrap can see an open binding', async () => {
      resolveResumeTargetMock.mockResolvedValue({ ...stale, endedBy: 'reconciler' });
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(false);
      expect(resolveSessionStatesMock).not.toHaveBeenCalled();
      expect(markAdvSessionEndedMock).toHaveBeenCalledWith(11, null, 'reconciler', {
        expectedBinding: dead.binding,
        throwOnError: true,
      });
      expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    });

    it.each(['oracle', 'writer'])('keeps a failed %s read/write fail-closed', async (seam) => {
      (seam === 'oracle' ? resolveSessionStatesMock : markAdvSessionEndedMock).mockRejectedValueOnce(new Error('database unavailable'));
      const res = await launchAgent.handler(request, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('reconciliation failed');
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(releaseAgentLaunchClaimMock).toHaveBeenCalled();
    });

    it('does not reconcile an idempotency replay', async () => {
      claimAgentLaunchMock.mockResolvedValueOnce({ won: false, priorSummary: { opened: 1 }, priorLaunchedAt: 1, priorLaunchedBy: 'su-caller' });
      const res = await launchAgent.handler(request, ctx);
      expect(dataOf(res)?.deduped).toBe(true);
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(resolveSessionStatesMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    });

    it('requires exact workspace, harness, and positive terminal evidence for watchdog successors', async () => {
      const scoped = { ...stale, workspaceId: 'ws-test', harnessSlug: 'papercusp' };
      resolveResumeTargetMock.mockResolvedValue(scoped);
      resolveSessionStatesMock.mockResolvedValue(new Map([[dead.ownerId, { sessionState: 'suspect' }]]));
      const expected = {
        ownerId: dead.ownerId,
        advSessionId: dead.advSessionId,
        workspaceId: 'ws-test',
        harnessSlug: 'papercusp',
        binding: dead.binding,
        requirePositiveTerminalEvidence: true,
      };
      const internalCtx = {
        workspaceId: 'ws-test',
        harnessSlug: 'papercusp',
        role: 'su',
        [INTERNAL_EXPECTED_SUCCESSOR_BINDING]: expected,
      } as never;
      const res = await launchAgent.handler(
        { successor: { agentId: dead.ownerId }, idempotencyKey: 'watchdog-positive-terminal' },
        internalCtx,
      );
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('predecessor liveness is suspect');
      expect(textOf(res)).toContain('positive terminal evidence is required');
      expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
    });

    it('refuses a watchdog source that moved to another workspace before dispatch', async () => {
      resolveResumeTargetMock.mockResolvedValue({ ...stale, workspaceId: 'other-workspace', harnessSlug: 'papercusp' });
      const internalCtx = {
        workspaceId: 'ws-test',
        harnessSlug: 'papercusp',
        role: 'su',
        [INTERNAL_EXPECTED_SUCCESSOR_BINDING]: {
          ownerId: dead.ownerId,
          advSessionId: dead.advSessionId,
          workspaceId: 'ws-test',
          harnessSlug: 'papercusp',
          binding: dead.binding,
          requirePositiveTerminalEvidence: true,
        },
      } as never;
      const res = await launchAgent.handler(
        { successor: { agentId: dead.ownerId }, idempotencyKey: 'watchdog-workspace-binding' },
        internalCtx,
      );
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('expected workspace, harness, and incarnation binding');
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
    });
  });

  it('refuses an identity-preserving successor when the source is still live', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });

    const res = await launchAgent.handler({ successor: { agentId: 'su-a1a71' } }, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('source session is still LIVE');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(buildCarryBriefMock).not.toHaveBeenCalled();
  });

  it('uses the standard desktop terminal on resume when TERMINAL is unset', async () => {
    vi.stubEnv('TERMINAL', '');
    resolveResumeTargetMock.mockResolvedValue(dead);
    await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);
    expect(spawnConsoleMock.mock.calls[0][0]).toMatchObject({ preferProcessPerWindow: false });
  });

  it('preserves GNOME Terminal on resume when explicitly configured', async () => {
    vi.stubEnv('TERMINAL', 'gnome-terminal');
    resolveResumeTargetMock.mockResolvedValue(dead);
    await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);
    expect(spawnConsoleMock.mock.calls[0][0]).toMatchObject({ preferProcessPerWindow: false });
  });

  it('preserves an explicit terminal preference for fresh launches', async () => {
    vi.stubEnv('TERMINAL', 'gnome-terminal');
    await launchAgent.handler({ brief: 'fresh work' }, ctx);
    expect(spawnConsoleMock.mock.calls[0][0]).toMatchObject({ preferProcessPerWindow: false });
  });

  it('EI-21010422711013687: a fresh launch keeps the process-per-window fallback when no terminal preference is set', async () => {
    vi.stubEnv('TERMINAL', '');
    await launchAgent.handler({ brief: 'fresh work' }, ctx);
    expect(spawnConsoleMock.mock.calls[0][0]).toMatchObject({
      preferProcessPerWindow: true,
      verifyBootReceipt: true,
    });
  });

  it('preserves the source account on resume and accepts an explicit account override', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, account: 'auto' });

    const inherited = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, brief: 'continue the gateway-routed session' },
      ctx,
    );
    expect(isError(inherited)).toBe(false);
    expect(spawnedCommand()).toContain('--account=auto');

    spawnConsoleMock.mockClear();
    const overridden = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, account: 'default', brief: 'continue on the system account' },
      ctx,
    );
    expect(isError(overridden)).toBe(false);
    expect(spawnedCommand()).toContain('--account=default');
    expect(spawnedCommand()).not.toContain('--account=auto');
  });

  it('resumes a dead agent BY AGENT ID — no uuid hunting', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);

    expect(resolveResumeTargetMock).toHaveBeenCalledWith({ agentId: 'su-a1a71', sessionId: null });
    expect(spawnedCommand()).toContain('--resume=sid-dead');
    expect(spawnedCommand()).not.toContain('--fork');
    expect(textOf(res)).toContain('re-attaches its ORIGINAL identity su-a1a71');
  });

  it.each([
    { label: 'retained resume', sourceLive: false, fork: false },
    { label: 'explicit fork', sourceLive: false, fork: true },
    { label: 'live-source auto-fork', sourceLive: true, fork: undefined },
  ])('refuses a recruited acceptance reviewer $label before opening a process', async ({ sourceLive, fork }) => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: sourceLive, endedAt: sourceLive ? null : dead.endedAt });
    // The REAL guard runs against the mocked org PG: no review-target reservation
    // names the reviewer's plan, and its first launch was by the grading sweep,
    // so independence cannot be proved and the launch must refuse.
    goalContextSqlMock.mockImplementation(async (...args: unknown[]) => {
      const strings = args[0];
      const text = Array.isArray(strings) ? strings.join('?') : '';
      return text.includes('FROM harness_shared.adv_sessions') && text.includes('launch_parent_owner')
        ? [{ launch_parent_owner: 'system:acceptance-grading-sweep' }]
        : [];
    });
    try {
      const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, ...(fork ? { fork: true } : {}),
        independent: true, brief: 'continue grading' }, ctx);
      expect(isError(res)).toBe(true);
      expect(textOf(res)).toContain('reviewer_relaunch_breaks_independence');
      expect(textOf(res)).toContain('recruited by system:acceptance-grading-sweep');
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
    } finally {
      goalContextSqlMock.mockImplementation(async () => []);
    }
  });

  it.each(['codex', 'omp'])('forwards an explicit %s→Claude conversion and its exact prepared-port verification source', async (sourceBackend) => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, agent: sourceBackend });
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, agent: 'claude',
      model: 'sonnet:high', brief: 'continue under the same source owner' }, ctx);
    expect(isError(res)).toBe(false);
    expect(spawnedCommand()).toContain('--agent=claude');
    expect(spawnedCommand()).toContain('--resume=sid-dead');
    expect(verifyResumeStartedMock).toHaveBeenCalledWith('su-a1a71', expect.objectContaining({
      expectedSessionId: 'sid-dead', expectedPort: { sourceAdvSessionId: 11, targetBackend: 'claude' },
    }));
  });

  it('keeps an explicit same-backend resume on the ordinary UUID verifier', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, agent: 'claude', brief: 'resume the same transcript' }, ctx);
    const options = verifyResumeStartedMock.mock.calls.at(-1)?.[1];
    expect(options).toMatchObject({ expectedSessionId: 'sid-dead' });
    expect(options).not.toHaveProperty('expectedPort');
  });

  it('resumes a tracked Codex row without native session_id by adv-session selector', async () => {
    const trackedCodex = {
      ...dead,
      agent: 'codex',
      sessionId: null,
      resumeId: '22661',
      advSessionId: 22661,
    };
    resolveResumeTargetMock.mockResolvedValue(trackedCodex);
    verifyResumeStartedMock.mockResolvedValue({
      started: true,
      waitedMs: 5,
      expectedSessionId: null,
      actualSessionId: null,
      mismatch: false,
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, brief: 'continue the Codex recovery' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(spawnedCommand()).toContain('--resume=22661');
    expect(verifyResumeStartedMock).toHaveBeenCalledWith(
      'su-a1a71',
      expect.objectContaining({ expectedSessionId: null }),
    );
    expect(textOf(res)).toContain('re-attaches its ORIGINAL identity su-a1a71');
  });

  it('EI-21725123573114023: refuses an in-place resume whose target records no coord owner id, instead of reporting an unverifiable "Launched"', async () => {
    // Both downstream rails are keyed on the owner id, so without it the verifier
    // is skipped AND `live` is forced false — the tool used to spawn and report
    // success having checked nothing.
    resolveResumeTargetMock.mockResolvedValue({ ...dead, ownerId: null });

    const res = await launchAgent.handler({ resume: { sessionId: 'sid-dead' }, brief: 'continue the recovery' }, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('records no coord owner id');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(verifyResumeStartedMock).not.toHaveBeenCalled();
  });

  it('EI-21725123573114023: a FRESH launch whose verifier could not run for want of a caller id says so, instead of reporting a bare "Launched"', async () => {
    callerIdentity.current.ownerId = null;

    const res = await launchAgent.handler({ brief: 'fresh work' }, ctx);

    expect(spawnConsoleMock).toHaveBeenCalled();
    expect(verifyFreshLaunchStartedMock).not.toHaveBeenCalled();
    expect(textOf(res)).toContain('launch verification DID NOT RUN');
  });

  it('EI-21725123573114023: an attributed fresh launch still runs the verifier and reports its verdict — the skip note is not blanket', async () => {
    const res = await launchAgent.handler({ brief: 'fresh work' }, ctx);

    expect(verifyFreshLaunchStartedMock).toHaveBeenCalled();
    expect(textOf(res)).toContain('test launch verification stub');
    expect(textOf(res)).not.toContain('launch verification DID NOT RUN');
  });

  it('refuses a managed fork without the source coord identity required by tracked bootstrap', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, ownerId: null });

    const res = await launchAgent.handler(
      { resume: { sessionId: 'sid-dead' }, fork: true, brief: 'branch off the recovery' },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('tracked fork is unavailable');
    expect(spawnGovernedAgentProcessMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it("preserves the resumed target's durable fleet instead of inheriting the caller's fleet", async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['su-caller', { fleetSlug: 'caller-fleet', fleetRole: 'leader' }]]),
    );

    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);

    expect(latestFleetMembershipMock).toHaveBeenCalledWith('ws-test', 'su-a1a71');
    expect(fetchPresenceFleetMock).not.toHaveBeenCalled();
    expect(spawnedCommand()).toContain('--fleet=target-fleet');
    expect(spawnedCommand()).not.toContain('--fleet=caller-fleet');
    expect(dataOf(res)?.launch).toMatchObject({ fleet: 'target-fleet', resumedOwnerId: 'su-a1a71' });
  });

  it('authorizes retirement clearing only on explicit exact resumes', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    const result = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'explicitly relaunch this identity' }, ctx);
    expect(isError(result)).toBe(false);
    expect(spawnedEnv().PSU_ALLOW_RETIRED_RESUME).toBe('1');
  });

  it.each([false, true])('does not authorize retirement clearing on a fresh launch or fork (fork=%s)', async (fork) => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    const result = await launchAgent.handler(fork
      ? { resume: { agentId: 'su-a1a71' }, fork: true, brief: 'branch to a new identity' }
      : { brief: 'start a new identity' }, ctx);
    expect(isError(result)).toBe(false);
    expect(spawnedEnv()).not.toHaveProperty('PSU_ALLOW_RETIRED_RESUME');
  });

  it('preserves resumed target membership when independent is supplied', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['su-caller', { fleetSlug: 'caller-fleet', fleetRole: 'leader' }]]),
    );

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, independent: true, brief: 'continue independently' },
      ctx,
    );

    expect(latestFleetMembershipMock).toHaveBeenCalledWith('ws-test', 'su-a1a71');
    expect(fetchPresenceFleetMock).not.toHaveBeenCalled();
    expect(spawnedCommand()).toContain('--fleet=target-fleet');
    expect(spawnedCommand()).not.toContain('--fleet=caller-fleet');
    expect(dataOf(res)?.launch).toMatchObject({ fleet: 'target-fleet', independent: true, mode: 'resume' });
  });

  it('reuses the canonical fleet profile on resume and corrects an ended visible member back to saved headless placement', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-test',
      fleetSlug: 'target-fleet',
      target: 12,
      config: {
        plan: 'recovery-plan',
        harness: 'papercusp',
        agent: 'claude',
        model: 'sonnet',
        effort: 'high',
        account: 'default',
        headless: true,
        carry: 'warm',
        extraArgs: ['--context-size=trimmed'],
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });

    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);

    expect(isError(res)).toBe(false);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    const command = spawnedCommand(spawnHeadlessMock);
    expect(command).toContain('--resume=sid-dead');
    expect(command).toContain('--fleet=target-fleet');
    expect(command).toContain('--model=sonnet:high');
    expect(command).toContain('--account=default');
    expect(command).toContain('--context-size=trimmed');
    expect(command).toContain('--carry=warm');
    expect(command).toContain('--headless');
    expect(dataOf(res)?.launch).toMatchObject({
      mode: 'resume',
      fleet: 'target-fleet',
      headcountProfile: {
        applied: true,
        target: 12,
        provenance: { source: 'fleet:headcount-target', fleetSlug: 'target-fleet' },
        reusePath: 'capability:launch-agent resume/successor -> agent-launch-core.buildAgentLaunchCommand',
      },
    });
  });

  it('internal wait recovery opens the exact host without kickoff or retirement override', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(dead);
    const res = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false,
      [INTERNAL_INTERRUPTION_RECOVERY]: { ownerId: dead.ownerId, nativeSessionId: dead.sessionId, wait: true },
    } as never, ctx);
    expect(isError(res), textOf(res)).toBe(false);
    const spawn = spawnConsoleMock.mock.calls[0]?.[0] ?? spawnHeadlessMock.mock.calls[0]?.[0];
    expect(spawn).toBeDefined();
    const env = (spawn as { envelope: { env: Record<string, string> } }).envelope.env;
    expect(env).not.toHaveProperty('PAPERCUSP_KICKOFF_PROMPT');
    expect(env).not.toHaveProperty('PSU_ALLOW_RETIRED_RESUME');
  });

  it.each(['live', 'identity'])('internal recovery refuses a changed %s source without launching', async kind => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, ...(kind === 'live' ? { live: true } : { sessionId: 'changed' }) });
    const res = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false,
      [INTERNAL_INTERRUPTION_RECOVERY]: { ownerId: dead.ownerId, nativeSessionId: dead.sessionId, wait: true },
    } as never, ctx);
    expect(isError(res)).toBe(true);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it.each([1, 2])('internal recovery revalidates at native creation boundary %s', async boundary => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(dead);
    let calls = 0;
    const beforeNativeCreate = vi.fn(async () => {
      if (++calls === boundary) throw new Error('interruption-revalidation:owner-stop');
    });
    const res = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false,
      [INTERNAL_INTERRUPTION_RECOVERY]: { ownerId: dead.ownerId, nativeSessionId: dead.sessionId,
        wait: true, beforeNativeCreate },
    } as never, ctx);
    expect(isError(res)).toBe(true);
    expect(beforeNativeCreate).toHaveBeenCalledTimes(boundary);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('interruption recovery preserves a member role and uses that member launch record', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    readAdvSessionLaunchRecordByOwnerMock.mockResolvedValue({
      workspaceId: 'ws-test', agent: 'claude',
      launchSpec: { v: 1, agent: 'claude', workspaceId: 'ws-test', harnessSlug: 'papercusp',
        fleet: { slug: 'target-fleet', role: 'member' }, model: 'sonnet:high' },
      launchArgv: ['psu', '--no-picker', '--fleet=target-fleet', '--agent=claude',
        '--harness=papercusp', '--headless', '--carry=warm', '--account=default',
        '--model=sonnet:high', '--role=su'],
    });
    const res = await launchAgent.handler({ resume: { agentId: dead.ownerId }, fork: false,
      [INTERNAL_INTERRUPTION_RECOVERY]: { ownerId: dead.ownerId, nativeSessionId: dead.sessionId, wait: true },
    } as never, ctx);
    expect(isError(res), textOf(res)).toBe(false);
    const command = spawnedCommand(spawnHeadlessMock);
    expect(command).toContain('--fleet=target-fleet');
    expect(command).not.toContain('--fleet-role=leader');
    expect(readAdvSessionLaunchRecordByOwnerMock).toHaveBeenCalledWith(dead.ownerId, 'ws-test');
  });

  it('leader recovery uses the ended owner launch record and restores the leader role', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    readAdvSessionLaunchRecordByOwnerMock.mockResolvedValue({
      workspaceId: 'ws-test',
      agent: 'claude',
      launchSpec: {
        v: 1,
        agent: 'claude',
        workspaceId: 'ws-test',
        harnessSlug: 'papercusp',
        fleet: { slug: 'target-fleet', role: 'leader' },
        model: 'sonnet:high',
      },
      launchArgv: [
        'psu', '--no-picker', '--fleet=target-fleet', '--agent=claude',
        '--harness=papercusp', '--headless', '--carry=warm', '--account=default',
        '--model=sonnet:high', '--role=su',
      ],
    });

    const res = await launchAgent.handler({
      resume: { agentId: 'su-a1a71' },
      fork: false,
      brief: 'resume the retained fleet leadership seat',
      idempotencyKey: 'fleet-leader-resume:target-fleet:su-a1a71:1000',
      __leaderRecoveryOwnerId: 'su-a1a71',
    } as never, ctx);

    expect(isError(res), textOf(res)).toBe(false);
    const command = spawnedCommand(spawnHeadlessMock);
    expect(command).toContain('--model=sonnet:high');
    expect(command).toContain('--fleet=target-fleet');
    expect(command).toContain('--fleet-role=leader');
    expect(dataOf(res)?.launch).toMatchObject({
      mode: 'resume',
      fleet: 'target-fleet',
      headcountProfile: {
        provenance: { source: 'adv_sessions.launch_spec' },
        reusePath: 'fleet leader recovery -> capability:launch-agent resume -> agent-launch-core.buildAgentLaunchCommand',
      },
    });
    expect(readAdvSessionLaunchRecordByOwnerMock).toHaveBeenCalledWith('su-a1a71', 'ws-test');
  });

  it('treats mode-only extraArgs as launch posture while preserving the canonical profile on resume', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-test',
      fleetSlug: 'target-fleet',
      target: 12,
      config: {
        plan: 'recovery-plan',
        harness: 'papercusp',
        agent: 'claude',
        model: 'sonnet',
        effort: 'high',
        account: 'default',
        headless: true,
        carry: 'warm',
        extraArgs: ['--context-size=trimmed'],
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, extraArgs: ['--auto'], brief: 'continue the recovery' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    const command = spawnedCommand(spawnHeadlessMock);
    expect(command).toContain('--context-size=trimmed');
    expect(command).toContain('--auto');
    expect(textOf(res)).toContain('Applied canonical saved fleet launch spec');
  });

  it.each([
    { active: true, expectedCarry: 'cold' },
    { active: false, expectedCarry: 'warm' },
  ])("uses active loop carry without applying an inactive loop's stale carry ($active)", async ({ active, expectedCarry }) => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    getLoopStatusMock.mockResolvedValue({ ownerId: 'su-a1a71', active, carry: 'cold' });
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-test',
      fleetSlug: 'target-fleet',
      target: 12,
      config: {
        plan: 'recovery-plan',
        harness: 'papercusp',
        agent: 'claude',
        model: 'sonnet',
        effort: 'high',
        account: 'default',
        headless: true,
        carry: 'warm',
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });

    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);

    expect(isError(res)).toBe(false);
    expect(getLoopStatusMock).toHaveBeenCalledWith('su-a1a71');
    expect(spawnedCommand(spawnHeadlessMock)).toContain(`--carry=${expectedCarry}`);
    expect(spawnedCommand(spawnHeadlessMock)).toContain('--headless');
    expect(textOf(res).includes("Applied target loop carry 'cold'")).toBe(active);
  });

  it('fails closed before resume when a caller conflicts with the canonical saved placement', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-test',
      fleetSlug: 'target-fleet',
      target: 12,
      config: {
        plan: 'recovery-plan',
        harness: 'papercusp',
        agent: 'claude',
        account: 'default',
        headless: true,
        carry: 'warm',
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, headless: false, brief: 'continue with the saved placement' },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Saved launch spec conflict');
    expect(textOf(res)).toContain('"field":"headless"');
    expect(textOf(res)).toContain('capability:launch-agent resume/successor');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('restores an exact desktop session with explicit placement and model while retaining its fleet', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue(dead);
    latestFleetMembershipMock.mockResolvedValue({ fleetSlug: 'target-fleet', fleetRole: 'member' });
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-test', fleetSlug: 'target-fleet', target: 12,
      config: { plan: 'recovery-plan', harness: 'papercusp', agent: 'claude',
        model: 'haiku', account: 'default', headless: true, carry: 'warm' },
      nextAttemptAt: null, backoffMs: 0, lastError: null,
    });

    const res = await launchAgent.handler({
      resume: { sessionId: 'sid-dead' }, restoreVisible: true,
      headless: false, model: 'sonnet', brief: 'restore the original desktop session',
    }, ctx);

    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(spawnedCommand()).toContain('--resume=sid-dead');
    expect(spawnedCommand()).toContain('--model=sonnet');
    expect(spawnedCommand()).toContain('--fleet=target-fleet');
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
  });

  it('propagates the caller DRAIN overlay to a resume/fork command', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    getModesMock.mockResolvedValue([{ mode: 'drain', subject: 'bug-drain', ownerDirected: true }]);
    listFactsMock.mockResolvedValue([{ key: 'mode-instructions:drain', body: 'Checkpoint incidental defects.' }]);

    await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, fork: true, brief: 'continue the recovery' }, ctx);

    expect(spawnedCommand()).toContain('--mode=drain');
    expect(spawnedCommand()).toContain('--mode-subject=bug-drain');
    expect(spawnedCommand()).toContain("--mode-instructions='Checkpoint incidental defects.'");
    expect(spawnedCommand()).toContain('--mode-owner-directed');
  });

  it("delivers a brief with a resume as the session's NEXT turn (via the pty inject)", async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'the plan changed' }, ctx);
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toBe('the plan changed');
    expect(textOf(res)).toContain('managed pty');
  });

  it('recovers a stale agent-launched headless host before exact-resume instead of forking it', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    findLiveHostMock.mockReturnValue({
      ownerId: 'su-a1a71',
      pid: 42,
      sock: '/run/host.sock',
      bridgeTty: false,
      launchedBy: 'su-caller',
      lastActivityAt: Date.now() - 31 * 60_000,
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, headless: true, brief: 'continue the recovery' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(shutdownViaPtyMock).toHaveBeenCalledWith(
      'su-a1a71',
      expect.objectContaining({ force: true, reason: expect.stringContaining('stale-headless') }),
    );
    expect(waitForPtyHostGoneMock).toHaveBeenCalledWith('su-a1a71');
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnedCommand(spawnHeadlessMock)).toContain('--resume=sid-dead');
    expect(spawnedCommand(spawnHeadlessMock)).not.toContain('--fork');
    expect(textOf(res)).toContain('Guarded stale-headless recovery');
  });

  it('FORKS a still-LIVE source instead of colliding on its transcript (D-007)', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    findLiveHostMock.mockReturnValue({
      ownerId: 'su-a1a71',
      pid: 42,
      sock: '/run/host.sock',
      bridgeTty: false,
      launchedBy: 'su-caller',
      lastActivityAt: Date.now() - 5 * 60_000,
    });
    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' }, ctx);

    expect(spawnedCommand()).toContain('--resume=sid-dead --fork');
    expect(textOf(res)).toContain('still LIVE');
    expect(textOf(res)).toContain('FRESH identity');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('LIVE SOURCE SAFETY');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('inherits no work-item claims');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('confirm this fork holds the claim');
  });

  it.each([5, 31])('fails closed for an explicit in-place resume when the source is LIVE (idle %s minutes)', async (idleMinutes) => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    findLiveHostMock.mockReturnValue({
      ownerId: 'su-a1a71',
      pid: 42,
      sock: '/run/host.sock',
      bridgeTty: false,
      launchedBy: 'su-caller',
      lastActivityAt: Date.now() - idleMinutes * 60_000,
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, fork: false, brief: 'continue in place' },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Explicit `fork:false` is fail-closed');
    expect(JSON.parse(JSON.stringify(dataOf(res)))).toMatchObject({
      ok: false,
      error: expect.stringContaining('the source session is still LIVE'),
      launchFailure: { stage: 'pre-spawn', processesOpened: 0 },
    });
    expect(spawnGovernedAgentProcessMock).not.toHaveBeenCalled();
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it.each([true, false])('resumes a dormant source in place with explicit fork:false (headless=%s)', async (headless) => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    findLiveHostMock.mockReturnValue(null);
    const res = await launchAgent.handler(
      { resume: { sessionId: 'sid-dead' }, fork: false, headless, brief: 'continue in place' }, ctx,
    );
    expect(isError(res)).toBe(false);
    const chosen = headless ? spawnHeadlessMock : spawnConsoleMock;
    expect(spawnedCommand(chosen)).toContain('--resume=sid-dead');
    expect(spawnedCommand(chosen)).not.toContain('--fork');
    expect(dataOf(res)?.launch).toMatchObject({ mode: 'resume', resumedOwnerId: dead.ownerId });
  });

  it.each(['held', 'unknown'])('refuses strict in-place recovery with a %s Codex writer before admission', async (reason) => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, agent: 'codex' });
    findLiveHostMock.mockReturnValue(null);
    codexThreadWriterHolderMock.mockReturnValue({
      held: reason === 'held', pid: reason === 'held' ? 9876 : null,
      lockPath: '/tmp/writer.lock', sessionId: 'sid-dead', reason,
    });
    const res = await launchAgent.handler(
      { resume: { sessionId: 'sid-dead' }, fork: false, brief: 'continue in place' }, ctx,
    );
    expect(isError(res)).toBe(true);
    expect(spawnGovernedAgentProcessMock).not.toHaveBeenCalled();
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it.each([2, 3])('refuses strict recovery when the source becomes LIVE at resolve %s', async (atResolve) => {
    let reads = 0;
    resolveResumeTargetMock.mockImplementation(async () =>
      ++reads >= atResolve ? { ...dead, live: true, endedAt: null } : dead,
    );
    findLiveHostMock.mockReturnValue(null);
    const res = await launchAgent.handler(
      { resume: { sessionId: 'sid-dead' }, fork: false, brief: 'continue in place' }, ctx,
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('became LIVE during preparation');
    expect(spawnGovernedAgentProcessMock).not.toHaveBeenCalled();
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('refuses strict recovery when a host appears after governed admission', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    findLiveHostMock.mockReturnValueOnce(null).mockReturnValueOnce(null)
      .mockReturnValue({ ownerId: dead.ownerId, pid: 42 });
    const res = await launchAgent.handler(
      { resume: { sessionId: 'sid-dead' }, fork: false, brief: 'continue in place' }, ctx,
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('became LIVE during preparation');
    expect(spawnGovernedAgentProcessMock).toHaveBeenCalledTimes(1);
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('refuses strict recovery when source custody changes before admission', async () => {
    resolveResumeTargetMock.mockResolvedValueOnce(dead).mockResolvedValueOnce(dead)
      .mockResolvedValue({ ...dead, advSessionId: 12 });
    findLiveHostMock.mockReturnValue(null);
    const res = await launchAgent.handler(
      { resume: { sessionId: 'sid-dead' }, fork: false, brief: 'continue in place' }, ctx,
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('source custody changed');
    expect(spawnGovernedAgentProcessMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('keeps strict agent-id recovery on the original transcript at critical pressure', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    findLiveHostMock.mockReturnValue(null);
    fetchContextPressureMock.mockResolvedValue(new Map([[dead.ownerId, 'critical']]));
    const res = await launchAgent.handler(
      { resume: { agentId: dead.ownerId }, fork: false, brief: 'continue in place' }, ctx,
    );
    expect(isError(res)).toBe(false);
    expect(spawnedCommand()).toContain('--resume=sid-dead');
    expect(dataOf(res)?.launch).toMatchObject({ mode: 'resume', resumedOwnerId: dead.ownerId });
    expect(clearContextEstimateMock).not.toHaveBeenCalled();
  });

  it('uses a tracked Codex fork when a writer is active without a registered pty host', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, agent: 'codex', live: false });
    findLiveHostMock.mockReturnValue(null);
    codexThreadWriterHolderMock.mockReturnValue({
      held: true,
      pid: 9876,
      lockPath: '/tmp/codex/thread-writer-locks/sid-dead.lock',
      sessionId: 'sid-dead',
      reason: 'held',
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery' },
      ctx,
    );

    expect(isError(res), textOf(res)).toBe(false);
    expect(codexThreadWriterHolderMock).toHaveBeenCalledWith(expect.any(String), 'sid-dead');
    expect(spawnedCommand()).toContain('--fork');
    expect(acquireAdvSessionResumeMock).not.toHaveBeenCalled();
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
  });

  it.each(['omp'])('refuses explicit and protective managed %s forks before admission in either placement', async (agent) => {
    for (const fork of [true, undefined]) {
      for (const headless of [true, false]) {
        resolveResumeTargetMock.mockResolvedValue({ ...dead, agent, live: fork === undefined, endedAt: null });
        findLiveHostMock.mockReturnValue({ ownerId: dead.ownerId, pid: 42 });
        const res = await launchAgent.handler(
          { resume: { sessionId: dead.sessionId }, fork, headless, brief: 'branch the recovery' }, ctx,
        );
        expect(isError(res)).toBe(true);
        expect(textOf(res)).toContain('tracked fork is unavailable');
        expect(spawnGovernedAgentProcessMock).not.toHaveBeenCalled();
        expect(spawnConsoleMock).not.toHaveBeenCalled();
        expect(spawnHeadlessMock).not.toHaveBeenCalled();
        expect(shutdownViaPtyMock).not.toHaveBeenCalled();
      }
    }
  });

  it.each([true, false])('admits a tracked Codex fork without taking parent custody (headless=%s)', async headless => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, agent: 'codex' });
    findLiveHostMock.mockReturnValue(null);
    const res = await launchAgent.handler(
      { resume: { sessionId: dead.sessionId }, fork: true, headless, brief: 'branch the recovery' }, ctx,
    );
    expect(isError(res), textOf(res)).toBe(false);
    expect(spawnedCommand(headless ? spawnHeadlessMock : spawnConsoleMock)).toContain('--fork');
    expect(acquireAdvSessionResumeMock).not.toHaveBeenCalled();
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
  });

  it('refuses a managed Claude fork without a tracked source row before admission', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, advSessionId: null });
    const res = await launchAgent.handler(
      { resume: { sessionId: dead.sessionId }, fork: true, brief: 'branch the recovery' }, ctx,
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('tracked fork is unavailable');
    expect(spawnGovernedAgentProcessMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it.each([true, false])('retains a dormant Codex source with explicit fork:false (headless=%s)', async (headless) => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, agent: 'codex' });
    findLiveHostMock.mockReturnValue(null);
    const res = await launchAgent.handler(
      { resume: { sessionId: dead.sessionId }, fork: false, headless, brief: 'continue in place' }, ctx,
    );
    expect(isError(res)).toBe(false);
    const command = spawnedCommand(headless ? spawnHeadlessMock : spawnConsoleMock);
    expect(command).toContain('--resume=sid-dead');
    expect(command).not.toContain('--fork');
    expect(dataOf(res)?.launch).toMatchObject({ mode: 'resume', resumedOwnerId: dead.ownerId });
  });

  it('refuses visible restore when a Codex writer is active without a managed host', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, agent: 'codex', live: false });
    findLiveHostMock.mockReturnValue(null);
    codexThreadWriterHolderMock.mockReturnValue({
      held: true,
      pid: 9876,
      lockPath: '/tmp/codex/thread-writer-locks/sid-dead.lock',
      sessionId: 'sid-dead',
      reason: 'held',
    });

    const res = await launchAgent.handler(
      { resume: { sessionId: 'sid-dead' }, restoreVisible: true, brief: 'restore the session visibly' },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('active writer but no managed host is registered');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('forks explicitly when asked, even from a dead source', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    await launchAgent.handler(
      { resume: { sessionId: 'sid-dead' }, fork: true, brief: 'branch the recovery' },
      ctx,
    );
    expect(spawnedCommand()).toContain('--fork');
  });

  it('falls through to an ordinary exact resume when restoreVisible is requested after the host already ended', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);

    const res = await launchAgent.handler(
      {
        resume: { sessionId: 'sid-dead' },
        brief: 'restore the session',
        restoreVisible: true,
      },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    expect(waitForPtyHostGoneMock).not.toHaveBeenCalled();
    expect(spawnedCommand()).toContain('--resume=sid-dead');
    expect(spawnedCommand()).not.toContain('--fork');
    expect(textOf(res)).toContain('ordinary exact resume');
  });

  it('refuses guarded restoration when the exact live session still has a desktop window', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    windowScopeVerdictMock.mockReturnValue('alive');

    const res = await launchAgent.handler(
      {
        resume: { sessionId: 'sid-dead' },
        brief: 'restore the session',
        restoreVisible: true,
      },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('verdict for su-a1a71 is alive');
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'not-a-window'] as const)('fails closed on a %s desktop-window verdict', async (verdict) => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    windowScopeVerdictMock.mockReturnValue(verdict);

    const res = await launchAgent.handler(
      {
        resume: { sessionId: 'sid-dead' },
        brief: 'restore the session',
        restoreVisible: true,
      },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain(`is ${verdict}`);
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    if (verdict === 'not-a-window') {
      expect(textOf(res)).toContain('omit `restoreVisible`');
      expect(textOf(res)).toContain('ordinary exact resume');
    }
  });

  it('does not promise guarded stale-headless recovery without agent provenance', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    findLiveHostMock.mockReturnValue({
      ownerId: 'su-a1a71',
      pid: 42,
      sock: '/run/host.sock',
      bridgeTty: false,
      lastActivityAt: Date.now() - 31 * 60_000,
    });
    windowScopeVerdictMock.mockReturnValue('not-a-window');

    const visibleRestore = await launchAgent.handler(
      {
        resume: { sessionId: 'sid-dead' },
        brief: 'restore the session',
        restoreVisible: true,
      },
      ctx,
    );

    expect(isError(visibleRestore)).toBe(true);
    expect(textOf(visibleRestore)).toContain('explicitly agent-launched headless host with measured pty activity idle for at least 30 minutes');
    expect(textOf(visibleRestore)).toContain('otherwise a still-live source is forked');
    expect(shutdownViaPtyMock).not.toHaveBeenCalled();

    const exactResume = await launchAgent.handler(
      { resume: { sessionId: 'sid-dead' }, brief: 'continue the recovery' },
      ctx,
    );

    expect(isError(exactResume)).toBe(false);
    expect(spawnedCommand()).toContain('--resume=sid-dead --fork');
    expect(dataOf(exactResume)?.launch).toMatchObject({ mode: 'fork' });
  });

  it('gracefully closes only a proven-windowless host, waits for it, then exact-resumes visibly', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });

    const res = await launchAgent.handler(
      {
        resume: { sessionId: 'sid-dead' },
        brief: 'restore the session',
        restoreVisible: true,
      },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(shutdownViaPtyMock).toHaveBeenCalledWith(
      'su-a1a71',
      expect.objectContaining({ force: true, reason: expect.stringContaining('sid-dead') }),
    );
    expect(waitForPtyHostGoneMock).toHaveBeenCalledWith('su-a1a71');
    expect(spawnedCommand()).toContain('--resume=sid-dead');
    expect(spawnedCommand()).not.toContain('--fork');
    expect(textOf(res)).toContain('Guarded restore');
    expect(verifyResumeStartedMock).toHaveBeenCalledWith(
      'su-a1a71',
      expect.objectContaining({ expectedSessionId: 'sid-dead' }),
    );
  });

  it('does not launch a replacement when the proven-windowless host refuses shutdown', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    shutdownViaPtyMock.mockResolvedValue('refused-human-attended');

    const res = await launchAgent.handler(
      {
        resume: { sessionId: 'sid-dead' },
        brief: 'restore the session',
        restoreVisible: true,
      },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('refused-human-attended');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('refuses a resume/fork whose source is at critical context pressure', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, live: true, endedAt: null });
    fetchContextPressureMock.mockResolvedValue(new Map([['su-a1a71', 'critical']]));

    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'take the routed consult' }, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('current context is CRITICAL');
    expect(textOf(res)).toContain('launch a FRESH agent with a context-seeded brief');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('uses a neutral system lineage only for an eligible dormant critical frozen-tests author', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue({
      ...dead,
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      feature: 'WI-6554700010017145',
    });
    fetchContextPressureMock.mockResolvedValue(new Map([['su-a1a71', 'critical']]));
    buildCarryBriefMock.mockResolvedValue({ ownerId: 'su-a1a71' });
    renderCarryBriefTextMock.mockReturnValue('source checkpoint: rebind the frozen tests');
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-neutral-successor', successfulCalls: 1 }],
      note: 'neutral successor verified',
    });

    const res = await launchAgent.handler({
      resume: { agentId: 'su-a1a71' },
      successorLineageMode: 'system:lineage-neutral-successor',
    }, ctx);

    expect(isError(res), textOf(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledOnce();
    expect(spawnedCommand()).toContain('system:lineage-neutral-successor');
    expect(spawnedCommand()).not.toContain('--launched-by=su-caller');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).toContain('source checkpoint: rebind the frozen tests');
    expect(spawnedEnv().PAPERCUSP_KICKOFF_PROMPT).not.toContain('caller prompt');
    expect(neutralSuccessorGuardMock).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      workItemId: 'WI-6554700010017145',
      sourceOwnerId: 'su-a1a71',
    });
    expect(claimAgentLaunchMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-test',
      launchedBy: 'su-caller',
    }));
    expect(spawnGovernedAgentProcessMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ launchedBy: 'su-caller' }),
    }), expect.any(Function));
    expect(dataOf(res)?.launch).toMatchObject({ mode: 'successor', resumedOwnerId: 'su-a1a71' });
  });

  it('uses system process provenance for headless neutral successors but keeps caller task attribution', async () => {
    findLiveHostMock.mockReturnValue(null);
    resolveResumeTargetMock.mockResolvedValue({
      ...dead,
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      feature: 'WI-6554700010017145',
    });
    fetchContextPressureMock.mockResolvedValue(new Map([['su-a1a71', 'critical']]));
    buildCarryBriefMock.mockResolvedValue({ ownerId: 'su-a1a71' });
    renderCarryBriefTextMock.mockReturnValue('source checkpoint: rebind the frozen tests');
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: true,
      waitedMs: 5,
      sessions: [{ ownerId: 'su-a1a71', sessionId: 'session-neutral-headless', successfulCalls: 1 }],
      note: 'neutral headless successor verified',
    });

    const res = await launchAgent.handler({
      resume: { agentId: 'su-a1a71' },
      successorLineageMode: 'system:lineage-neutral-successor',
      headless: true,
    }, ctx);

    expect(isError(res), textOf(res)).toBe(false);
    expect(spawnHeadlessMock).toHaveBeenCalledOnce();
    expect(spawnedCommand(spawnHeadlessMock)).toContain('system:lineage-neutral-successor');
    expect(spawnedEnv(spawnHeadlessMock).PAPERCUSP_KICKOFF_PROMPT).toContain('source checkpoint: rebind the frozen tests');
    expect(spawnHeadlessMock.mock.calls[0]?.[0]).toMatchObject({ launchedBy: 'system:lineage-neutral-successor' });
    expect(spawnGovernedAgentProcessMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ launchedBy: 'su-caller' }),
    }), expect.any(Function));
    expect(claimAgentLaunchMock).toHaveBeenCalledWith(expect.objectContaining({ launchedBy: 'su-caller' }));
  });

  it.each([
    ['brief', { brief: 'caller prompt' }],
    ['extraArgs', { extraArgs: ['--append-system-prompt=caller text'] }],
    ['carry', { carry: 'cold' }],
    ['launchContext', { launchContext: '/tmp/caller-context.md' }],
  ])('refuses a caller-authored %s override in neutral lineage mode', async (_label, override) => {
    const res = await launchAgent.handler({
      resume: { agentId: 'su-a1a71' },
      successorLineageMode: 'system:lineage-neutral-successor',
      ...override,
    } as never, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Caller-authored prompt/profile overrides are refused');
    expect(resolveResumeTargetMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('refuses neutral lineage when the source does not need a critical-context successor', async () => {
    resolveResumeTargetMock.mockResolvedValue({
      ...dead,
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      feature: 'WI-6554700010017145',
    });

    const res = await launchAgent.handler({
      resume: { agentId: 'su-a1a71' },
      successorLineageMode: 'system:lineage-neutral-successor',
    }, ctx);

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('requires the source to be dormant at critical context pressure');
    expect(neutralSuccessorGuardMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('verifies a fork by real first-turn activity and fails an observed silent fork', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    verifyFreshLaunchStartedMock.mockResolvedValue({
      agentStarted: false,
      waitedMs: 25_000,
      sessions: [],
      note: '✗ AGENT DID NOT START — fork registered but never took a real turn.',
    });

    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, fork: true, brief: 'take the routed consult' },
      ctx,
    );

    expect(verifyFreshLaunchStartedMock).toHaveBeenCalledWith(
      expect.objectContaining({ launcherOwnerId: 'su-caller', expected: 1 }),
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('AGENT DID NOT START');
    expect(textOf(res)).toContain('Delivery alone is not proof the turn began');
  });

  it('surfaces an unresolvable target instead of launching something wrong', async () => {
    resolveResumeTargetMock.mockResolvedValue({
      ok: false,
      error: 'not_found',
      detail: 'no adv_sessions row for agent su-nope',
    });
    const res = await launchAgent.handler({ resume: { agentId: 'su-nope' }, brief: 'continue the missing session' }, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('no adv_sessions row');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('records an unconfirmed verdict without inventing failure when the resume host is delayed', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    verifyResumeStartedMock.mockResolvedValue({
      started: null,
      waitedMs: 30_000,
      expectedSessionId: 'sid-dead',
      actualSessionId: null,
      mismatch: false,
    });

    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the delayed recovery' }, ctx);

    expect(isError(res)).toBe(false);
    expect(textOf(res)).toContain('RESUME UNCONFIRMED');
    expect(textOf(res)).toContain('absence of evidence, not an observed no-op');
    expect(textOf(res)).toContain('Do NOT launch a fallback on this note alone');
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({ mode: 'resume', resumeVerified: null }),
      }),
    );
  });

  it('includes the bounded per-owner psu boot-log tail when a resume is unconfirmed', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    verifyResumeStartedMock.mockResolvedValue({
      started: null,
      waitedMs: 30_000,
      expectedSessionId: 'sid-dead',
      actualSessionId: null,
      mismatch: false,
    });
    readPsuLaunchLogTailMock.mockReturnValue('psu: resume transcript was not found');

    const res = await launchAgent.handler({ resume: { agentId: 'su-a1a71' }, brief: 'continue the logged recovery' }, ctx);

    expect(readPsuLaunchLogTailMock).toHaveBeenCalledWith('su-a1a71', { chars: PSU_LAUNCH_LOG_TAIL_CHARS });
    expect(textOf(res)).toContain('Per-owner psu boot log tail');
    expect(textOf(res)).toContain('psu: resume transcript was not found');
    expect(dataOf(res)?.launch).toMatchObject({
      resumeVerification: {
        bootLogTail: 'psu: resume transcript was not found',
      },
    });
  });

  it('rolls back a newly launched resume whose backend UUID differs from the exact request', async () => {
    resolveResumeTargetMock.mockResolvedValue({ ...dead, sessionId: 'later-rollout-uuid' });
    verifyResumeStartedMock.mockResolvedValue({
      started: false,
      waitedMs: 10,
      expectedSessionId: 'later-rollout-uuid',
      actualSessionId: 'older-root-uuid',
      mismatch: true,
    });

    const res = await launchAgent.handler(
      { resume: { sessionId: 'later-rollout-uuid' }, brief: 'continue the exact recovery' },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('RESUME UUID MISMATCH');
    expect(textOf(res)).toContain('requested later-rollout-uuid');
    expect(textOf(res)).toContain('actually resumed older-root-uuid');
    expect(shutdownViaPtyMock).toHaveBeenCalledWith('su-a1a71', expect.objectContaining({ force: true }));
    expect(dataOf(res)?.launch).toMatchObject({
      resumeVerified: false,
      resumeVerification: {
        expectedSessionId: 'later-rollout-uuid',
        actualSessionId: 'older-root-uuid',
        mismatch: true,
        rollback: 'sent',
      },
    });
  });

  it('refuses to resume one session N times (fork is the run-alongside path)', async () => {
    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, brief: 'continue the recovery', count: 3 },
      ctx,
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/cannot be resumed more than once/);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('allows fork × count (branch N agents off one context)', async () => {
    resolveResumeTargetMock.mockResolvedValue(dead);
    await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, fork: true, brief: 'branch the recovery', count: 2 },
      ctx,
    );
    expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
  });

  it('rejects fork with no source to fork FROM', async () => {
    const res = await launchAgent.handler({ brief: 'x', fork: true }, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('needs a source session');
  });

  it('rejects plan + resume (a resumed session keeps its own context)', async () => {
    const res = await launchAgent.handler(
      { resume: { agentId: 'su-a1a71' }, brief: 'new direction', plan: 'p' } as never,
      ctx,
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('`plan` is for a FRESH launch');
  });
});

describe('idempotency (P-014: a replay must not open a second set of windows)', () => {
  it('spawns nothing and reports the ORIGINAL launch when the key was already claimed', async () => {
    claimAgentLaunchMock.mockResolvedValue({
      won: false,
      priorSummary: { opened: 2, failed: 0, mode: 'fresh', tasks: [{ taskId: 'task-original', logPath: '/tmp/original.log' }] },
      priorLaunchedAt: 1_760_000_000_000,
      priorLaunchedBy: 'su-caller',
    });
    const res = await launchAgent.handler({ brief: 'do it', count: 2, idempotencyKey: 'retry-1' }, ctx);

    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(textOf(res)).toContain('Already launched (deduped)');
    expect(textOf(res)).toContain('"opened":2');
    expect(dataOf(res)).toMatchObject({
      deduped: true,
      launch: { deduped: true, opened: 2, tasks: [{ taskId: 'task-original', logPath: '/tmp/original.log' }] },
    });
  });

  it('returns an explicit unknown outcome for an unfinalized claim instead of fabricated zero counts', async () => {
    claimAgentLaunchMock.mockResolvedValue({
      won: false,
      priorSummary: {
        requestKind: 'capability:launch-agent',
        launchState: 'spawning',
        startedAt: 1_760_000_000_000,
        expectedCount: 1,
        ownerIds: ['su-original'],
        processHandles: { '0': { ownerId: 'su-original', pid: 4242, terminalPid: 4343 } },
        memberResults: { '0': { status: 'starting', outcome: 'unknown' } },
      },
      priorLaunchedAt: 1_760_000_000_000,
      priorLaunchedBy: 'su-original-launcher',
    });

    const res = await launchAgent.handler({ brief: 'do it', idempotencyKey: 'retry-unknown' }, ctx);

    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(textOf(res)).toContain('not a zero-open result');
    expect(dataOf(res)).toMatchObject({
      deduped: true,
      launch: {
        launchState: 'spawning',
        outcome: 'unknown',
        status: 'reconciliation-required',
        opened: null,
        failed: null,
        processHandles: { '0': { ownerId: 'su-original', pid: 4242, terminalPid: 4343 } },
      },
    });
    expect(dataOf(res)?.completionReceipt).toBeUndefined();
  });

  it('records claim phase and exact targets before opening a process', async () => {
    await launchAgent.handler({ brief: 'do it', idempotencyKey: 'retry-phase' }, ctx);

    expect(claimAgentLaunchMock).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'retry-phase',
      initialSummary: expect.objectContaining({
        requestKind: 'capability:launch-agent',
        launchState: 'claimed',
        expectedCount: 1,
        ownerIds: [expect.any(String)],
        targetMembers: [{ ownerId: expect.any(String), label: expect.any(String), headless: false }],
        agentStarted: null,
        tasks: [],
      }),
    }));
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'retry-phase',
      summary: expect.objectContaining({
        launchState: 'spawning',
        spawnAttempted: false,
        targetMembers: [{ ownerId: expect.any(String), label: expect.any(String), headless: false }],
      }),
    }));
  });

  it('persists process handles before a final launch summary can be lost', async () => {
    recordAgentLaunchResultMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const res = await launchAgent.handler({ brief: 'do it', idempotencyKey: 'retry-interrupted' }, ctx);
    const progress = recordAgentLaunchResultMock.mock.calls
      .map(([call]) => call.summary)
      .find((summary) => summary.memberResults?.['0']?.pid === 4242);

    expect(progress).toMatchObject({
      launchState: 'spawning',
      spawnAttempted: true,
      processHandles: { '0': { pid: 4242, terminalPid: 4343 } },
      memberResults: { '0': { outcome: 'opened', pid: 4242 } },
    });
    expect(dataOf(res)?.completionReceipt).toBeUndefined();
  });

  it('records what the winning launch did, so a later replay can report it', async () => {
    await launchAgent.handler({ brief: 'do it', idempotencyKey: 'retry-1' }, ctx);
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'retry-1',
        summary: expect.objectContaining({
          deduped: false,
          opened: 1,
          failed: 0,
          mode: 'fresh',
          tasks: [expect.objectContaining({ pid: 4242, headless: false })],
        }),
      }),
    );
  });
});

describe('launch result after the dispatch deadline', () => {
  const projectLaunchForDispatch = (): ProjectedTool => ({
    pluginName: 'operator-core',
    description: 'launch-agent deadline regression fixture',
    inputSchema: { type: 'object' },
    capabilities: [],
    expose: { mcp: { name: 'capability:launch-agent' } },
    timeoutSec: 0.05,
    // WI-10005222: the resolver is typed for launch-agent's concrete args; the
    // projected fixture erases args to `unknown`, and a function parameter is
    // contravariant, so the bare assignment is TS2322. Same erasure as the
    // handler cast below.
    abortCompletionReceipt: launchAgent.abortCompletionReceipt as ProjectedTool['abortCompletionReceipt'],
    fn: async (input, dispatchContext) => {
      const response = await (launchAgent.handler as unknown as (
        args: unknown,
        context: UnifiedToolContext,
      ) => Promise<{ content: ToolResult['content']; data?: unknown; isError?: boolean }>)(input, dispatchContext);
      return {
        content: response.content,
        structuredContent: response.data,
        ...(response.isError ? { isError: true } : {}),
      };
    },
  });

  const dispatchLaunch = (idempotencyKey: string) => {
    const dispatchContext = {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      emit: vi.fn(),
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      role: 'su',
    } as unknown as UnifiedToolContext;
    return dispatchProjectedTool(
      projectLaunchForDispatch(),
      'capability:launch-agent',
      { brief: 'controlled deadline fixture', count: 2, idempotencyKey },
      dispatchContext,
      {},
    );
  };

  it('surfaces the cached multi-launch summary when the handler returns after timeout', async () => {
    const idempotencyKey = 'deadline-crossing-launch-test';
    recordAgentLaunchResultMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      return true;
    });

    const result = await dispatchLaunch(idempotencyKey);

    expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey,
        summary: expect.objectContaining({ opened: 2, failed: 0 }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.result?.structuredContent).toMatchObject({
      deduped: false,
      launch: { opened: 2, failed: 0 },
      completionReceipt: { status: 'recorded', effectRef: `agent-launch:${idempotencyKey}` },
    });
    expect(result.result?._meta?.abortCompletionReceipt).toMatchObject({
      status: 'recorded',
      effectRef: `agent-launch:${idempotencyKey}`,
      attemptId: expect.any(String),
    });
  }, 10_000);

  it('keeps the timeout when process openings have no confirmed durable summary', async () => {
    recordAgentLaunchResultMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      return false;
    });

    const result = await dispatchLaunch('uncached-deadline-crossing-launch-test');

    expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'timeout',
      meta: {
        abortCompletionReceipt: {
          status: 'recovery-incomplete',
          failures: ['missing-completion-receipt'],
          attemptId: expect.any(String),
        },
      },
    });
  }, 10_000);
});

describe('failure reporting', () => {
  it('releases a claimed key after governed admission fails before any process opens, allowing the same-key retry', async () => {
    claimAgentLaunchMock
      .mockResolvedValueOnce({
        won: true,
        priorSummary: null,
        priorLaunchedAt: null,
        priorLaunchedBy: null,
      })
      .mockResolvedValueOnce({
        won: true,
        priorSummary: null,
        priorLaunchedAt: null,
        priorLaunchedBy: null,
      });
    spawnConsoleMock
      .mockResolvedValueOnce({
        status: 'error',
        code: 503,
        error: 'durable admission record could not be persisted',
      })
      .mockResolvedValueOnce({
        status: 'ok',
        pid: 4242,
        terminal: 'xterm',
        child: {} as never,
        display: ':1',
        desktopEnvResolvedVia: 'active-seat',
      });

    const first = await launchAgent.handler(
      { brief: 'retryable launch', idempotencyKey: 'retry-after-admission-failure' },
      ctx,
    );
    expect(isError(first)).toBe(true);
    expect(textOf(first)).toContain('released idempotencyKey');
    expect(releaseAgentLaunchClaimMock).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      idempotencyKey: 'retry-after-admission-failure',
    });
    expect(recordAgentLaunchResultMock).not.toHaveBeenCalled();

    const retry = await launchAgent.handler(
      { brief: 'retryable launch', idempotencyKey: 'retry-after-admission-failure' },
      ctx,
    );
    expect(isError(retry)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
    expect(recordAgentLaunchResultMock).toHaveBeenCalledTimes(1);
  });

  it('releases a claimed key when governed admission rejects before the spawner is invoked', async () => {
    spawnGovernedAgentProcessMock.mockRejectedValueOnce(
      new Error('durable admission record could not be persisted'),
    );

    const res = await launchAgent.handler(
      { brief: 'retry after governed rejection', idempotencyKey: 'retry-after-governed-rejection' },
      ctx,
    );

    expect(isError(res)).toBe(true);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(releaseAgentLaunchClaimMock).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      idempotencyKey: 'retry-after-governed-rejection',
    });
    expect(textOf(res)).toContain('governed spawn failed: durable admission record could not be persisted');
  });

  it('keeps the idempotency claim when a batch opens at least one process despite another failure', async () => {
    spawnConsoleMock
      .mockResolvedValueOnce({ status: 'error', code: 503, error: 'admission unavailable' })
      .mockResolvedValueOnce({
        status: 'ok',
        pid: 4242,
        terminal: 'xterm',
        child: {} as never,
        display: ':1',
        desktopEnvResolvedVia: 'active-seat',
      });

    const res = await launchAgent.handler(
      { brief: 'partial governed batch', count: 2, idempotencyKey: 'partial-governed-batch' },
      ctx,
    );

    expect(isError(res)).toBe(false);
    expect(releaseAgentLaunchClaimMock).not.toHaveBeenCalled();
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'partial-governed-batch',
        summary: expect.objectContaining({ opened: 1, failed: 1 }),
      }),
    );
  });

  it('preserves a retired headless kickoff receipt without reporting an opened task', async () => {
    const kickoffProof = {
      persisted: false, nativeRef: null, reason: 'kickoff-not-submitted:role-mcp-unavailable',
    };
    spawnHeadlessMock.mockResolvedValue({
      status: 'error', code: 502, error: 'headless kickoff was not submitted',
      taskId: 'task-retired', logPath: '/tmp/retired-judge.log', kickoffProof,
    });
    const result = await launchAgent.handler({ brief: 'grade', headless: true }, ctx);
    expect(isError(result)).toBe(true);
    expect(dataOf(result)?.launch).toMatchObject({
      opened: 0, failed: 1, tasks: [],
      failures: [{ taskId: 'task-retired', logPath: '/tmp/retired-judge.log', kickoffProof }],
    });
  });

  it('returns machine-readable per-member failure details when a spawn fails', async () => {
    spawnConsoleMock.mockResolvedValue({
      status: 'error',
      code: 501,
      error: 'no desktop session',
    });
    const res = await launchAgent.handler({ brief: 'x' }, ctx);
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('launch failed (501): no desktop session');
    expect(dataOf(res)?.launch).toMatchObject({
      opened: 0,
      failed: 1,
      failures: [
        {
          memberIndex: 0,
          code: 501,
          reason: 'no desktop session',
        },
      ],
    });
  });
});

describe('blind-review resume is recruiter-only', () => {
  const binding = {
    id: 17, workspaceId: 'ws-test', harnessSlug: 'papercusp', planSlug: 'blind-plan', activationAuditSeq: 4,
    reviewerOwnerId: 'su-reviewer', advSessionId: 79, nativeSessionId: 'blind-native-1',
    launchParentOwner: BLIND_GAP_REVIEW_ACTOR, accountRoute: 'auto', modelSpec: null,
    confinementSnapshot: { denyTools: [], denyOutside: ['plans:blind-review'], denyAmbientContext: true,
      imposedBy: BLIND_GAP_REVIEW_ACTOR, reason: 'blind review' },
    status: 'resuming', resumeLeaseId: 'lease-1', resumeLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), reviewId: null,
  };
  const source = {
    ok: true as const, sessionId: 'blind-native-1', ownerId: 'su-reviewer', agent: 'codex',
    cwd: '/repo', endedAt: '2026-10-22T20:00:00.000Z', endedBy: 'self' as const, live: false,
    advSessionId: 79, account: 'auto', model: null, headless: true,
    binding: { coordOwnerId: 'su-reviewer', sessionId: 'blind-native-1', startedAt: '2026-10-22 19:00:00+00' },
  };

  it('rejects generic exact resume even when the reviewer has ended', async () => {
    resolveResumeTargetMock.mockResolvedValue(source);
    inspectBlindReviewResumeTargetMock.mockResolvedValue({ binding, recruiterLaunch: true });
    const result = await launchAgent.handler({
      resume: { sessionId: 'blind-native-1' }, fork: false, headless: true, brief: 'continue',
    }, ctx);
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('blind_review_recovery_recruiter_only');
    expect(verifyBlindReviewSessionResumeBindingMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it.each(['codex', 'claude'])('allows only the exact leased recruiter resume, preserving the saved %s backend, account and placement', async (agent) => {
    callerIdentity.current.ownerId = BLIND_GAP_REVIEW_ACTOR;
    spawnHeadlessMock.mockResolvedValueOnce(headlessSpawnResult());
    resolveResumeTargetMock.mockResolvedValue({ ...source, agent });
    findLiveHostMock.mockReturnValue(null);
    inspectBlindReviewResumeTargetMock.mockResolvedValue({ binding, recruiterLaunch: true });
    verifyBlindReviewSessionResumeBindingMock.mockResolvedValue({ ok: true });
    const permit = {
      bindingId: binding.id, leaseId: 'lease-1', workspaceId: binding.workspaceId, planSlug: binding.planSlug,
      activationAuditSeq: binding.activationAuditSeq, reviewerOwnerId: binding.reviewerOwnerId,
      advSessionId: binding.advSessionId, nativeSessionId: binding.nativeSessionId,
    };
    const recruiterCtx = {
      ...(ctx as unknown as Record<string, unknown>), ownerId: BLIND_GAP_REVIEW_ACTOR,
      principal: { kind: 'system', slug: BLIND_GAP_REVIEW_ACTOR, workspaceId: 'ws-test' },
      [INTERNAL_BLIND_REVIEW_RESUME]: permit,
      [INTERNAL_SCOPED_SESSION_CONFINEMENT]: binding.confinementSnapshot,
    } as never;
    const result = await launchAgent.handler({
      resume: { sessionId: 'blind-native-1' }, fork: false, headless: true, brief: 'continue the review',
    }, recruiterCtx);
    expect(isError(result), textOf(result)).toBe(false);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessMock.mock.calls[0]?.[0]).toMatchObject({ launchedBy: BLIND_GAP_REVIEW_ACTOR });
    expect(spawnedCommand(spawnHeadlessMock)).toContain('--resume=blind-native-1');
    // Exact resume lets psu recover the saved backend; a caller override would change it.
    expect(spawnedCommand(spawnHeadlessMock)).not.toContain('--agent=');
    expect(spawnedCommand(spawnHeadlessMock)).toContain('--account=auto');
    expect(spawnedCommand(spawnHeadlessMock)).not.toContain('--fork');
    expect(spawnedCommand(spawnHeadlessMock)).not.toContain('--model=');
    expect(dataOf(result)?.launch).toMatchObject({ mode: 'resume', resumedOwnerId: 'su-reviewer' });
    expect(declareConfinementMock).toHaveBeenCalledWith({ ownerId: 'su-reviewer', workspaceId: 'ws-test',
      confinement: binding.confinementSnapshot });
    expect(verifyBlindReviewSessionResumeBindingMock.mock.invocationCallOrder[0]).toBeLessThan(declareConfinementMock.mock.invocationCallOrder[0]!);
    expect(declareConfinementMock.mock.invocationCallOrder[0]).toBeLessThan(spawnHeadlessMock.mock.invocationCallOrder[0]!);
  });
  it.each(['wrong-principal', 'wrong-lease', 'expired-lease', 'unbound-target', 'unknown-backend', 'missing-ceiling', 'changed-ceiling', 'changed-declaration', 'renewal-failure'])
    ('refuses recruiter recovery for %s before spawn', async (failure) => {
      callerIdentity.current.ownerId = BLIND_GAP_REVIEW_ACTOR;
      resolveResumeTargetMock.mockResolvedValue(source);
      findLiveHostMock.mockReturnValue(null);
      inspectBlindReviewResumeTargetMock.mockResolvedValue({ binding, recruiterLaunch: true });
      if (failure === 'unbound-target') resolveResumeTargetMock.mockResolvedValue({ ...source, advSessionId: null });
      if (failure === 'unknown-backend') resolveResumeTargetMock.mockResolvedValue({ ...source, agent: 'other' });
      if (failure === 'expired-lease') inspectBlindReviewResumeTargetMock.mockResolvedValue({
        binding: { ...binding, resumeLeaseExpiresAt: new Date(Date.now() - 1).toISOString() }, recruiterLaunch: true });
      const permit = { bindingId: binding.id, leaseId: failure === 'wrong-lease' ? 'other' : 'lease-1',
        workspaceId: binding.workspaceId, planSlug: binding.planSlug, activationAuditSeq: binding.activationAuditSeq,
        reviewerOwnerId: binding.reviewerOwnerId, advSessionId: binding.advSessionId, nativeSessionId: binding.nativeSessionId };
      if (failure === 'changed-declaration') verifyBlindReviewSessionResumeBindingMock.mockResolvedValue({
        ok: false, code: 'confinement_mismatch', message: 'changed' });
      if (failure === 'renewal-failure') declareConfinementMock.mockRejectedValueOnce(new Error('store down'));
      const result = await launchAgent.handler({ resume: { sessionId: 'blind-native-1' }, fork: false,
        headless: true, brief: 'continue' }, {
        ...(ctx as unknown as Record<string, unknown>), ownerId: BLIND_GAP_REVIEW_ACTOR,
        principal: { kind: 'system', slug: failure === 'wrong-principal' ? 'other' : BLIND_GAP_REVIEW_ACTOR, workspaceId: 'ws-test' },
        [INTERNAL_BLIND_REVIEW_RESUME]: permit,
        ...(failure === 'missing-ceiling' ? {} : { [INTERNAL_SCOPED_SESSION_CONFINEMENT]: failure === 'changed-ceiling'
          ? { ...binding.confinementSnapshot, denyOutside: ['plans:blind-review', 'capability:bash'] } : binding.confinementSnapshot }),
      } as never);
      expect(isError(result), textOf(result)).toBe(true);
      expect(spawnConsoleMock).not.toHaveBeenCalled();
      expect(spawnHeadlessMock).not.toHaveBeenCalled();
      if (failure !== 'renewal-failure') expect(declareConfinementMock).not.toHaveBeenCalled();
    });
});
