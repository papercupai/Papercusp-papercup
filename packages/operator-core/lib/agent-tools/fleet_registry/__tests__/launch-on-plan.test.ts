/**
 * Unit tests for fleet:launch-on-plan (EI-5504). The handler spawns desktop
 * terminals (no pure unit surface), so we cover the pure command builder — the
 * load-bearing bit: every member command must carry `--no-picker` + `--plan`, the
 * exact pair that triggers the EI-5503 auto-kickoff so the member starts on boot.
 * Importing the module also validates its whole import chain compiles + loads (the
 * tool self-registers via defineTool on import).
 */
import { afterAll, describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';

afterAll(() => {
  const rail = readRealPgRailBlocks();
  expect(rail.blocked, `real-PG attempts blocked: ${rail.callers.join(' | ')}`).toBe(0);
});

// WI-1074216/P-006: permanent wrong store adapters prove the literal launch
// oracles fail without mutating production code. The lost-slot suppression
// test bypasses both adapters and calibrates each focused control run.
const idempotenceControls = ['initial-cas-loss', 'partial-exact-retry'] as const;
const idempotenceControl = process.env.PAPERCUSP_FLEET_IDEMPOTENCE_CONTROL;
if (idempotenceControl && !idempotenceControls.some((value) => value === idempotenceControl)) {
  throw new Error(`Unknown permanent fleet idempotence control: ${idempotenceControl}`);
}
import type { SpecPoolEffect, CollapseGuardVerdict } from '../../../scheduler/spec-pool-preview';
import { admissionPendingExplanation } from '../../../work-items-admission';

const admissionMocks = vi.hoisted(() => ({ preflight: vi.fn() }));

const spawnConsoleMock = vi.fn();
const spawnHeadlessMock = vi.fn();
const spawnGovernedAgentProcessMock = vi.hoisted(() => vi.fn());
const fetchGatewayHeadroomMock = vi.fn();
const createFleetIfAbsentMock = vi.fn();
const getFleetMock = vi.fn();
const getFleetHeadcountTargetMock = vi.fn();
const setFleetHeadcountTargetMock = vi.fn();
const setFleetLeaderMock = vi.fn();
const declareCouplingMock = vi.fn();
const getPresenceMock = vi.fn();
const heartbeatPresenceMock = vi.fn();
const setPresenceFleetMock = vi.fn();
const ensureFleetLeaderControlMock = vi.fn();
const assembleRolePromptMock = vi.fn();
const resolveProjectDirMock = vi.fn();
const listLiveTasksMock = vi.fn(
  async (..._args: unknown[]) =>
    [] as Array<{ class: string; memoryMaxBytes: number | null; peakMemoryBytes?: number | null }>,
);
const totalmemMock = vi.fn((..._args: unknown[]) => 256 * 1024 ** 3);
const agentSpawnScopeMemoryMaxGMock = vi.fn((..._args: unknown[]) => 6);
const launchTransaction = vi.hoisted(() => ({
  verify: vi.fn(async (..._args: unknown[]): Promise<any> => ({
    agentStarted: true as boolean | null,
    workerReady: false,
    waitedMs: 1,
    sessions: [],
    note: 'verified',
  })),
  persist: vi.fn(async (..._args: unknown[]): Promise<boolean | null> => null),
}));
const goalLaunchReadMock = vi.hoisted(() => vi.fn());
const goalPotPlacementAuthorityMock = vi.hoisted(() => vi.fn());
const goalModeSubjectMock = vi.hoisted(() => vi.fn());
const getModesMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => [] as unknown[]));
const goalLaunchResolveMock = vi.hoisted(() => vi.fn());
const fetchPresenceFleetMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => new Map()));
const readOperatorStateMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => null));
const reseedLeaderCompactionLimitMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => null));
// WI-10004545: the plan-goal attribution write is isolated from the live database; the
// real helper's identity-derived resolution + `WHERE goal_id IS NULL` is pinned in
// modes/goal-context.test.ts, so this file only pins WHEN launch-on-plan calls it.
const stampPlanGoalProvenanceMock = vi.hoisted(() => vi.fn());
const obligationAgendaReadMock = vi.hoisted(() => vi.fn());
// WI-10004401: fleetSlugFromName is stubbed below WITHOUT the real 60-char clamp, which is
// fine for every test that only needs a kebab-cased name — but the placement-boundary
// recurrence test MUST run the real derivation, or it passes with or without the fix.
// A test swaps `impl` for the real function and restores it in a `finally`.
const fleetSlugImpl = vi.hoisted(() => ({
  impl: ((name: string) => name.toLowerCase().replace(/\s+/g, '-')) as (name: string) => string,
  stub: ((name: string) => name.toLowerCase().replace(/\s+/g, '-')) as (name: string) => string,
}));

vi.mock('../../../modes/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../modes/store')>()),
  getModes: (...args: unknown[]) => getModesMock(...args),
  getModeSubject: (...args: unknown[]) => goalModeSubjectMock(...args),
}));

vi.mock('../../coordination/presence-fleet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../coordination/presence-fleet')>()),
  fetchPresenceFleet: (...args: unknown[]) => fetchPresenceFleetMock(...args),
}));

// Placement policy defaults to an empty row in this unit suite. Keep the real
// policy/cache logic available while preventing its read from opening Postgres.
vi.mock('../../../operator-state-pg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../operator-state-pg')>()),
  readOperatorState: (...args: unknown[]) => readOperatorStateMock(...args),
}));

// Compaction reseeding is covered through its own store tests; it is an unrelated
// best-effort launch side effect that resolves model configuration from Postgres.
vi.mock('../take-leadership-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../take-leadership-core')>()),
  reseedLeaderCompactionLimit: (...args: unknown[]) => reseedLeaderCompactionLimitMock(...args),
}));

vi.mock('../../../modes/goal-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../modes/goal-context')>()),
  stampPlanGoalProvenance: (...args: unknown[]) => stampPlanGoalProvenanceMock(...args),
}));

vi.mock('../../../console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async () => ({ cwd: '/tmp/fleet', env: {} })),
}));

vi.mock('../../../console-spawn', () => ({
  spawnConsole: (...args: unknown[]) => spawnConsoleMock(...args),
  spawnHeadless: (...args: unknown[]) => spawnHeadlessMock(...args),
}));
vi.mock('../../../resource-governor/spawn-execution', () => ({
  spawnGovernedAgentProcess: (...args: unknown[]) => spawnGovernedAgentProcessMock(...args),
}));

vi.mock('@papercusp/orchestrator/role-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/orchestrator/role-prompt')>()),
  assembleRolePrompt: (...args: unknown[]) => assembleRolePromptMock(...args),
}));

vi.mock('../../../spawn-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../spawn-config')>()),
  resolveProjectDir: (...args: unknown[]) => resolveProjectDirMock(...args),
}));

// Headless launch admission must never read the host's REAL task pressure in this
// handler suite. A loaded developer box otherwise makes unrelated launch tests
// clamp to zero before their spawn seam (WI-40655).
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  totalmem: (...args: unknown[]) => totalmemMock(...args),
}));

vi.mock('../../../task-manager/store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listLiveTasks: (...args: unknown[]) => listLiveTasksMock(...args),
}));

vi.mock('../../../systemd-scope', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  agentSpawnScopeMemoryMaxG: (...args: unknown[]) => agentSpawnScopeMemoryMaxGMock(...args),
}));

vi.mock('../../../goal-launch-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../goal-launch-settings')>()),
  readGoalLaunchSettingsForLauncher: (...args: unknown[]) => goalLaunchReadMock(...args),
  resolveGoalLaunch: (...args: unknown[]) => goalLaunchResolveMock(...args),
  resolveGoalPotPlacementAuthority: (...args: unknown[]) => goalPotPlacementAuthorityMock(...args),
}));
vi.mock('../../../agent-obligation-reader', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readAgentObligationAgenda: (...args: unknown[]) => obligationAgendaReadMock(...args),
}));

vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-1',
}));

vi.mock('../../../inference-gateway/local-model-ids-cache', () => ({
  localModelIdsAsync: vi.fn(async () => ['ornith-valid']),
}));

// Keep the handler's launch-context compose-write out of the real ~/.papercusp
// during tests — point the workspace home at a throwaway tmp dir.
vi.mock('../../../papercusp-root', () => ({
  papercuspPathForWorkspace: () => '/tmp/fleet-launch-ctx-test',
}));

vi.mock('../../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agent-fleets-store')>()),
  // The fleet-shape vocabulary, as a REAL value: `goal-launch-settings` builds
  // `goalLaunchSettingsSchema.fleetType` from it with `z.enum(FLEET_TYPES)` at
  // module scope, and this handler imports that module — so an omitted export
  // here does not fail one assertion, it fails COLLECTION of the whole file.
  // (It did: from the P-004 landing until this line was added.) Spelled with the
  // same values the store exports rather than mocked away, because a schema
  // enum built from a stub would accept a vocabulary the real one refuses.
  FLEET_TYPES: ['single', 'paired'] as const,
  createFleetIfAbsent: (...args: unknown[]) => createFleetIfAbsentMock(...args),
  fleetSlugFromName: (name: string) => fleetSlugImpl.impl(name),
  getFleet: (...args: unknown[]) => getFleetMock(...args),
  getFleetHeadcountTarget: (...args: unknown[]) => getFleetHeadcountTargetMock(...args),
  setFleetHeadcountTarget: (...args: unknown[]) => setFleetHeadcountTargetMock(...args),
  getFleetScheme: vi.fn(async () => ({ name: 'Ocean' })),
  // The P-005 idempotency guard (PG-backed, migration 484): default every handler test
  // to a WON slot; suppression semantics live in agent-fleets-store.integration.test.ts.
  claimFleetLaunchSlot: vi.fn(async () => ({ won: true, at: 1 })),
  releaseFleetLaunchSlot: vi.fn(async () => {}),
  setFleetLeader: (...args: unknown[]) => setFleetLeaderMock(...args),
  setFleetLaunchTransaction: (...args: unknown[]) => launchTransaction.persist(...args),
}));

vi.mock('../../../coord/couplings', () => ({
  declareCoupling: (...args: unknown[]) => declareCouplingMock(...args),
}));

vi.mock('../../../agent-launch-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agent-launch-core')>()),
  verifyFreshLaunchStarted: (...args: unknown[]) => launchTransaction.verify(...args),
}));

vi.mock('../../../fleet/fleet-roster', () => ({
  // Live-member deficit guard seam: default to an empty fleet (every legacy handler test
  // launches into a fresh fleet); the deficit tests below override per-case.
  liveFleetMemberIds: vi.fn(async () => [] as string[]),
}));

vi.mock('../../coordination/presence', async (importOriginal) => ({
  // Spread the real module so PRESENCE_STALE_MS (consumed transitively via
  // presence-wakeability.ts) survives; override only the fns we stub.
  ...(await importOriginal<typeof import('../../coordination/presence')>()),
  heartbeatPresence: (...args: unknown[]) => heartbeatPresenceMock(...args),
  setPresenceFleet: (...args: unknown[]) => setPresenceFleetMock(...args),
  getPresence: (...args: unknown[]) => getPresenceMock(...args),
}));

vi.mock('../leader-control', () => ({
  ensureFleetLeaderControl: (...args: unknown[]) => ensureFleetLeaderControlMock(...args),
}));

// Contract-shaped on purpose. The real readPlanBySlug resolves
// `{ parsed, archived, row: PlanRow } | null` — `row` is NOT optional. The P-006
// start gate reads row.templateData / row.template / row.inputSchema, so a stub
// without `row` throws a TypeError; this stub predated the gate and did exactly
// that, failing 40 tests at once (EI-19310192267009629).
// template/inputSchema null => planSchemaSource 'none' => the start gate passes.
// Individual tests override with mockResolvedValueOnce.
const readPlanBySlugMock = vi.fn(
  async (..._args: unknown[]): Promise<any> => ({
    slug: 'my-plan',
    parsed: { items: [] },
    archived: false,
    row: { planSlug: 'my-plan', template: null, inputSchema: null, templateData: null },
  }),
);

vi.mock('../../plans/source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../plans/source')>()),
  resolveHarnessPlansDir: vi.fn(async (slug: string) => ({ harnessSlug: slug, workspaceId: 'ws-1' })),
  readPlanBySlug: (...args: unknown[]) => readPlanBySlugMock(...args),
  // The start gate now reloads the same row. Preserve each fixture's real
  // input validation while isolating that reload from the live database.
  getPlanRow: async () => (await readPlanBySlugMock.mock.results.at(-1)?.value)?.row ?? null,
}));

// Keep this handler unit suite hermetic: withPinnedPlanTypes loads the registry and
// plan pins through withWorkspace. Real pin resolution is covered by the plan-types
// revision-pinning integration suite; here the start-gate callback still runs.
vi.mock('../../../plan-types/pins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../plan-types/pins')>()),
  withPinnedPlanTypes: <T>(_scope: unknown, fn: () => Promise<T>) => fn(),
}));

const acceptanceBarLifecycleMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ satisfied: true })));

vi.mock('../../../acceptance-bar-lifecycle-evaluator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../acceptance-bar-lifecycle-evaluator')>()),
  readAndEvaluateAcceptanceBarLifecycle: (...args: unknown[]) => acceptanceBarLifecycleMock(...args),
}));

vi.mock('../../plans/plan-admission-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../plans/plan-admission-gate')>()),
  checkPlanAdmission: vi.fn(async () => ({ admitted: true })),
}));

vi.mock('../../plans/plan-admission-preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  preflightExactPlanAdmission: (...args: unknown[]) => admissionMocks.preflight(...args),
}));

vi.mock('../_shared', () => ({
  fleetRoleFor: () => 'leader',
  json: (payload: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError,
  }),
  recolorCallerTerminal: async () => {},
  resolveFleetCaller: () => ({
    identity: { ownerId: 'owner-1' },
    ownerId: 'owner-1',
    workspaceId: 'ws-1',
  }),
}));

vi.mock('../../../inference-gateway/observability', () => ({
  fetchGatewayHeadroom: (...args: unknown[]) => fetchGatewayHeadroomMock(...args),
}));

const setClaimSpecMock = vi.fn();
const getClaimSpecMock = vi.fn();
vi.mock('../../../scheduler/claim-spec-store', () => ({
  setClaimSpec: (...args: unknown[]) => setClaimSpecMock(...args),
  getClaimSpec: (...args: unknown[]) => getClaimSpecMock(...args),
  fleetSpecBeeKey: (slug: string) => `fleet:${slug}`,
  resolveClaimSpecWorkspace: (ws: string | null | undefined) => (ws && ws !== '*' ? ws : undefined),
}));

// P-010: the WI-5212 pool-collapse guard the claimKinds launch path routes through. The
// COUNT (previewSpecPoolEffect) hits PG, so it is stubbed; the WIRING is what we test here
// (the real evaluateCollapseGuard thresholds have their own unit suite). Default: a healthy
// lane (matches part of a nonempty pool) that does NOT refuse.
const previewSpecPoolEffectMock = vi.fn(
  async (..._args: unknown[]): Promise<SpecPoolEffect> => ({
    matched: 5,
    pool: 10,
    states: ['open'],
    harness: 'papercusp',
  }),
);
const evaluateCollapseGuardMock = vi.fn((..._args: unknown[]): CollapseGuardVerdict => ({ refuse: false, errors: [] }));
vi.mock('../../../scheduler/spec-pool-preview', () => ({
  previewSpecPoolEffect: (...args: unknown[]) => previewSpecPoolEffectMock(...args),
  evaluateCollapseGuard: (...args: unknown[]) => evaluateCollapseGuardMock(...args),
}));

// WI-6673: the DUAL of the collapse guard above — the lane's admitted COMPOSITION, which
// decides the degenerate-lane warning. Only this one export is overridden (the rest of
// get-next is spread through) because several live modules in this import graph pull other
// symbols from it. Default: a healthy lane, so the warning is silent unless a test opts in.
const HEALTHY_COMPOSITION = {
  total: 5,
  byKind: { bug: 5 },
  bySeverity: { major: 4, critical: 1 },
  lowSeverityShare: 0,
  degenerate: false,
  peakDay: null,
};
const aggregateAdmittedCompositionMock = vi.fn(async (..._args: unknown[]) => HEALTHY_COMPOSITION as unknown);
vi.mock('../../../scheduler/get-next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aggregateAdmittedComposition: (...args: unknown[]) => aggregateAdmittedCompositionMock(...args),
}));

// #3 promotion FAILSAFE seam (fleet-launch-promote-workitems-failsafe): the handler idempotently
// promotes the plan's items → claimable work-items before opening any terminal. Default: the healthy
// case (items already promoted upstream by plans:start → skipped>0, promoted:0 → no warning line).
// Individual tests override with mockResolvedValueOnce.
type PromotionMockResult = {
  promoted: number;
  skipped: number;
  specTriadBlocked?: true;
  specTriadMissing?: string[];
  specTriadWorkItem?: string | null;
};
const promotePlanItemsMock = vi.fn(
  async (..._args: unknown[]): Promise<PromotionMockResult> => ({ promoted: 0, skipped: 3 }),
);
vi.mock('../../../plan-workitem-promotion-run', () => ({
  promotePlanItems: (...args: unknown[]) => promotePlanItemsMock(...args),
}));

import tool, {
  memberLaunchCommand,
  defaultMemberAccountRouting,
  gatewayCapacityProviderForFleetAgent,
  resolveFleetAgent,
  composeMemberLaunchContext,
  renderMemberBaseline,
  IMMUTABLE_MEMBER_LAUNCH_LINEAGE_GUARD,
  clampFleetTopUpToCapacity,
  memberSpecIndexForLaunch,
  buildFleetPlanClaimSpec,
  buildFleetKindClaimSpec,
  mergeKindIntoClaimSpec,
  claimableStatesForKinds,
  remotePlacementUnsupportedArgs,
  MEMBER_BASELINE_RULES,
  LEADER_STANDING_JOB,
  LEADER_AUTO_MODE_DIRECTIVE,
  LAUNCH_RESPONSE_DEADLINE_MS,
  raceLaunchResponseWithinBudget,
  sanitizePersistedGoalLaunchRole,
  clampHeadlessLaunchToHostMemory,
  summarizeProtectedAgentMemory,
} from '../launch-on-plan';
// The REAL claim-spec validator (NOT the mocked claim-spec-STORE) — #4 specs must pass it.
import { DEFAULT_CLAIM_SPEC, validateClaimSpec } from '../../../scheduler/claim-spec';
import { standardValidate } from '@papercusp/tooldef';

// Unprofiled local launches must choose terminal visibility explicitly. Existing
// handler fixtures predate that fail-closed guard and intentionally exercise the
// visible-terminal path, so make that choice at the test boundary while keeping
// the guard itself covered by a direct handler test below.
const invokeLaunchHandler = (
  args: Record<string, unknown>,
  context: unknown = {},
  defaultHeadless: boolean | null = false,
) =>
  tool.handler(
    (defaultHeadless !== null && args.headless === undefined
      ? { ...args, headless: defaultHeadless }
      : args) as never,
    context as never,
  );

/**
 * Read a handler result's payload as JSON — and, when it is NOT JSON, fail with
 * the message the handler actually returned.
 *
 * This handler returns successes as JSON via `json()` but refusals as PLAIN TEXT
 * via `err()`. Parsing blind therefore turns every unexpected refusal into
 * `SyntaxError: Unexpected token 'C', "Could not "... is not valid JSON` — a decoy
 * thrown by the very line that was supposed to read the error, destroying the one
 * thing you need. In the 2026-08-02 gate red (candidate 56b264231f11) all 40
 * launch-on-plan failures showed that SyntaxError; the real cause,
 * `Could not resolve plan ...`, was invisible until someone read the handler by
 * hand (EI-19315529747727303).
 *
 * Tests that ASSERT a refusal should keep reading `.content[0].text` directly —
 * this helper is for the success paths, so that an unexpected refusal reports
 * itself instead of a parser artifact.
 */
function parseHandlerPayload(res: unknown): any {
  const text = (res as { content?: { text?: string }[] } | null | undefined)?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(
      `Expected a JSON payload, but the handler returned no text content. Received: ${JSON.stringify(res)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    const refused = (res as { isError?: boolean } | null | undefined)?.isError === true;
    throw new Error(
      `Expected a JSON payload, but the handler ${refused ? 'REFUSED' : 'returned non-JSON text'}:\n${text}`,
    );
  }
}

describe('parseHandlerPayload — refusals must not surface as a decoy SyntaxError (EI-19315529747727303)', () => {
  it('surfaces the handler REFUSAL TEXT, not a JSON parser artifact', () => {
    // Exactly the shape err() produces, and exactly the string from the
    // 2026-08-02 gate red where 40 failures all reported the SyntaxError.
    const refusal = {
      content: [{ type: 'text' as const, text: 'Could not resolve plan `my-plan`: no such plan' }],
      isError: true,
    };

    // The old blind parse produced this — the control that proves the guard bites.
    expect(() => JSON.parse(refusal.content[0].text)).toThrow(SyntaxError);

    let caught: Error | undefined;
    try {
      parseHandlerPayload(refusal);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect(caught!.message).toContain('Could not resolve plan `my-plan`');
    expect(caught!.message).toContain('REFUSED');
    // The decoy must be gone, not merely accompanied by the real message.
    expect(caught!.message).not.toContain('is not valid JSON');
  });

  it('still returns the parsed payload on the success path', () => {
    const ok = {
      content: [{ type: 'text' as const, text: JSON.stringify({ fleet: 'f1', opened: 3 }) }],
      isError: false,
    };
    expect(parseHandlerPayload(ok)).toEqual({ fleet: 'f1', opened: 3 });
  });

  it('reports a missing/!string text content instead of throwing on a property read', () => {
    expect(() => parseHandlerPayload({ content: [] })).toThrow(/no text content/);
    expect(() => parseHandlerPayload(undefined)).toThrow(/no text content/);
  });
});

describe('fleet:launch-on-plan bounded response race (EI-21200981774877112)', () => {
  it('returns a pending response at the deadline without cancelling detached completion', async () => {
    let finish!: () => void;
    let completed = false;
    const operation = new Promise<string>((resolve) => {
      finish = () => {
        completed = true;
        resolve('verified');
      };
    });

    const response = await raceLaunchResponseWithinBudget(operation, 5);

    expect(response).toEqual({ timedOut: true });
    expect(completed).toBe(false);
    finish();
    await expect(operation).resolves.toBe('verified');
  });

  it('keeps a fast completion on the caller response path', async () => {
    const response = await raceLaunchResponseWithinBudget(Promise.resolve('verified'), LAUNCH_RESPONSE_DEADLINE_MS);

    expect(response).toEqual({ timedOut: false, value: 'verified' });
  });
});

describe('memberSpecIndexForLaunch', () => {
  it('keeps first-launch specs zero-based', () => {
    expect(memberSpecIndexForLaunch(0, 0)).toBe(0);
    expect(memberSpecIndexForLaunch(0, 1)).toBe(1);
  });

  it('appends a deficit wave after the live members', () => {
    expect(memberSpecIndexForLaunch(1, 0)).toBe(1);
    expect(memberSpecIndexForLaunch(1, 1)).toBe(2);
  });
});

describe('sanitizePersistedGoalLaunchRole', () => {
  it('omits an inherited GOAL launch slot and reports why it was ignored', () => {
    expect(sanitizePersistedGoalLaunchRole({ persistedRole: ' drain-fleet-leader ' })).toEqual({
      role: undefined,
      ignoredRoles: [
        {
          role: 'drain-fleet-leader',
          source: 'fleet:headcount-target',
          reason: 'goal-launch-slot-is-not-a-psu-persona',
        },
      ],
    });
  });

  it('preserves explicit roles and ordinary persisted personas', () => {
    expect(
      sanitizePersistedGoalLaunchRole({ persistedRole: 'drain-fleet-leader', explicitRole: 'builder' }),
    ).toEqual({ role: 'builder', ignoredRoles: [] });
    expect(sanitizePersistedGoalLaunchRole({ persistedRole: 'su' })).toEqual({ role: 'su', ignoredRoles: [] });
  });
});

describe('headless host-memory admission', () => {
  const GiB = 1024 ** 3;

  it('uses observed peak memory for existing scopes while reserving the full cap for unknown scopes', () => {
    const usage = summarizeProtectedAgentMemory([
      { class: 'agent-session', memoryMaxBytes: 6 * GiB, peakMemoryBytes: 1 * GiB },
      { class: 'agent-session', memoryMaxBytes: 6 * GiB, peakMemoryBytes: null },
      { class: 'sidecar', memoryMaxBytes: 6 * GiB, peakMemoryBytes: 20 * GiB },
    ]);

    expect(usage).toEqual({
      activeProtectedAgentScopes: 2,
      observedProtectedMemoryBytes: 1 * GiB,
      unmeasuredProtectedAgentScopes: 1,
    });

    const clamp = clampHeadlessLaunchToHostMemory(1, {
      hostTotalMemoryBytes: 32 * GiB,
      activeProtectedAgentScopes: usage.activeProtectedAgentScopes,
      perScopeMemoryBytes: 6 * GiB,
      observedProtectedMemoryBytes: usage.observedProtectedMemoryBytes,
      unmeasuredProtectedAgentScopes: usage.unmeasuredProtectedAgentScopes,
    });

    expect(clamp).toMatchObject({
      clamped: false,
      openCount: 1,
      observedProtectedMemoryBytes: 1 * GiB,
      unmeasuredProtectedAgentScopes: 1,
      reservedProtectedMemoryBytes: 7 * GiB,
    });
  });

  it('retains fail-closed full-cap admission when peak metrics are unavailable', () => {
    const clamp = clampHeadlessLaunchToHostMemory(1, {
      hostTotalMemoryBytes: 32 * GiB,
      activeProtectedAgentScopes: 4,
      perScopeMemoryBytes: 6 * GiB,
    });

    expect(clamp).toMatchObject({
      clamped: true,
      openCount: 0,
      unmeasuredProtectedAgentScopes: 4,
      reservedProtectedMemoryBytes: 24 * GiB,
      availableProtectedAgentScopes: 0,
    });
  });
});

beforeEach(() => {
  admissionMocks.preflight.mockReset();
  admissionMocks.preflight.mockResolvedValue({
    ready: true,
    status: 'ready',
    reason: 'ready',
    message: 'exact-plan admission ready',
  });
  acceptanceBarLifecycleMock.mockReset();
  acceptanceBarLifecycleMock.mockResolvedValue({ satisfied: true });
  assembleRolePromptMock.mockReset();
  assembleRolePromptMock.mockReturnValue({ text: 'role prompt', meta: { projectDir: '/tmp/fleet' } });
  resolveProjectDirMock.mockReset();
  resolveProjectDirMock.mockResolvedValue('/tmp/fleet');
  launchTransaction.verify.mockReset();
  launchTransaction.verify.mockResolvedValue({ agentStarted: true, waitedMs: 1, sessions: [], note: 'verified' });
  launchTransaction.persist.mockReset();
  launchTransaction.persist.mockResolvedValue(null);
  spawnGovernedAgentProcessMock.mockReset();
  spawnGovernedAgentProcessMock.mockImplementation(
    (
      input: { idempotencyKey: string },
      spawnProcess: (context: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      const admissionContext = {
        receiptId: `receipt:${input.idempotencyKey}`,
        leaseId: `lease:${input.idempotencyKey}`,
      };
      const result = spawnProcess(admissionContext);
      return result.status === 'ok' ? { ...result, admissionContext } : result;
    },
  );
  getFleetHeadcountTargetMock.mockReset();
  getFleetHeadcountTargetMock.mockResolvedValue(null);
  setFleetHeadcountTargetMock.mockReset();
  setFleetHeadcountTargetMock.mockResolvedValue(undefined);
  getFleetMock.mockReset();
  getFleetMock.mockResolvedValue(null);
  getClaimSpecMock.mockReset();
  // Keep the handler's best-effort claim-spec reads on the pre-existing fail-open
  // seam. A resolved default would let the final kickoff/spec reconciliation reach
  // lookupWorkItem, which is intentionally not backed by Postgres in this unit file.
  getClaimSpecMock.mockRejectedValue(new Error('claim spec test seam unavailable'));
  promotePlanItemsMock.mockClear();
  promotePlanItemsMock.mockResolvedValue({ promoted: 0, skipped: 3 });
  createFleetIfAbsentMock.mockReset();
  createFleetIfAbsentMock.mockResolvedValue({
    record: { leaderOwnerId: 'owner-1', colorScheme: { name: 'Ocean' } },
    created: true,
  });
  setFleetLeaderMock.mockReset();
  setFleetLeaderMock.mockResolvedValue({ leaderOwnerId: 'leader-1' });
  declareCouplingMock.mockReset();
  declareCouplingMock.mockResolvedValue({ state: 'coupled' });
  getPresenceMock.mockReset();
  getPresenceMock.mockResolvedValue({ ownerId: 'live-leader' });
  heartbeatPresenceMock.mockReset();
  heartbeatPresenceMock.mockResolvedValue(undefined);
  setPresenceFleetMock.mockReset();
  setPresenceFleetMock.mockResolvedValue(undefined);
  ensureFleetLeaderControlMock.mockReset();
  ensureFleetLeaderControlMock.mockResolvedValue({
    healthy: true,
    mode: { healthy: true, changed: true },
  });
  goalLaunchReadMock.mockReset();
  goalModeSubjectMock.mockReset();
  goalModeSubjectMock.mockResolvedValue(null);
  getModesMock.mockReset();
  getModesMock.mockResolvedValue([]);
  fetchPresenceFleetMock.mockReset();
  fetchPresenceFleetMock.mockResolvedValue(new Map());
  readOperatorStateMock.mockReset();
  readOperatorStateMock.mockResolvedValue(null);
  reseedLeaderCompactionLimitMock.mockReset();
  reseedLeaderCompactionLimitMock.mockResolvedValue(null);
  stampPlanGoalProvenanceMock.mockReset();
  stampPlanGoalProvenanceMock.mockResolvedValue(null);
  goalLaunchResolveMock.mockReset();
  goalLaunchResolveMock.mockResolvedValue({
    goalId: null, effective: {}, refusal: null, settings: null,
    budget: null, goalBrief: null, ceilings: { maxAgents: null, maxPerFleet: null },
    headcount: { total: 0, fleet: 0 }, degraded: false, degradedReasons: [],
  });
  goalLaunchReadMock.mockResolvedValue({
    goalId: null,
    settings: null,
    drainFleetSlug: null,
    degraded: false,
    degradedReasons: [],
  });
  obligationAgendaReadMock.mockReset();
  obligationAgendaReadMock.mockImplementation(async (input: any) => {
    const plan = input.planSlugs?.[0] ?? 'my-plan';
    const fleet = input.fleetSlug ?? `${plan}-fleet`;
    return {
      goalId: input.goalId,
      observedAt: new Date().toISOString(),
      agenda: {
        sourceGeneration: 'agenda-current',
        evaluations: [
          {
            id: 'obl:goal-plan-placement:test',
            ruleId: 'goal-plan-placement',
            ruleRevision: 'goal-plan-placement-v2',
            family: 'plan-placement',
            title: `Place ${plan}`,
            scope: {
              workspaceId: input.workspaceId,
              ownerId: input.ownerId,
              goalId: input.goalId,
              planSlug: plan,
            },
            responsibleOwnerId: input.ownerId,
            episode: `launch:${plan}`,
            status: 'due',
            authority: { kind: 'policy', sourceRef: 'test', revision: 'v2' },
            reason: `${plan} is the provider-selected eligible placement`,
            priority: 'high',
            causalRank: 1,
            applicableDemand: 1,
            sourceGeneration: 'placement-current',
            evidence: [
              {
                ref: `goal-plan-placement:${plan}`,
                observedAt: new Date().toISOString(),
                freshness: 'current',
              },
            ],
            action: {
              kind: 'delegate',
              summary: `launch ${plan}`,
              tool: 'fleet:launch-on-plan',
              args: {
                name: fleet,
                plan,
                harness: 'papercusp',
                leader: 'spawn',
                headless: true,
              },
            },
            clearsWhen: {
              id: 'placement',
              summary: 'independent placement is live',
              evidenceKind: 'state',
              sourceRef: 'test',
            },
            boundary: {
              boundary: 'fleet:launch-on-plan',
              refusalCode: 'goal-plan-placement-prerequisite',
              enforcement: 'required',
              unknown: 'allow-with-warning',
            },
          },
        ],
      },
    };
  });
  goalPotPlacementAuthorityMock.mockReset();
  goalPotPlacementAuthorityMock.mockResolvedValue({
    allowed: true,
    reason: 'no-active-owner',
    ownerGoalId: null,
    ownerGoalTitle: null,
  });
});

// A timed-out fake-clock case can skip its local `finally` while Vitest moves
// on to the next test in this 180-case file. Always restore the worker clock at
// the file boundary so one regression cannot turn every later launch into a
// misleading timeout cascade.
afterEach(() => {
  vi.useRealTimers();
});

describe('fleet:launch-on-plan GOAL pot sovereignty fence (EI-22180799091614070)', () => {
  it('refuses a different active goal owner before promotion, fleet writes, or terminal spawn', async () => {
    goalLaunchReadMock.mockResolvedValueOnce({
      goalId: 'goal-work-on-everything',
      settings: null,
      drainFleetSlug: null,
      degraded: false,
      degradedReasons: [],
    });
    goalPotPlacementAuthorityMock.mockResolvedValueOnce({
      allowed: false,
      reason: 'different-active-goal-owns-pot',
      ownerGoalId: 'goal-sidestage-owner',
      ownerGoalTitle: 'SideStage release',
    });

    const res = await invokeLaunchHandler({
      name: 'Cross Goal Fleet',
      plan: 'my-plan',
      harness: 'sidestage',
      count: 1,
    });
    const text = (res as { content: { text: string }[] }).content[0].text;

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain('goal_placement_sovereignty_refusal');
    expect(text).toContain('goal-work-on-everything');
    expect(text).toContain('goal-sidestage-owner');
    expect(text).toContain('NO fleet was created and NO terminals were opened');
    expect(goalPotPlacementAuthorityMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      launcherGoalId: 'goal-work-on-everything',
      harnessSlug: 'sidestage',
    });
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it("names the owner goal's measured state so a steward can tell a live owner from a stale edge (WI-10004524)", async () => {
    goalLaunchReadMock.mockResolvedValueOnce({
      goalId: 'goal-work-on-everything',
      settings: null,
      drainFleetSlug: null,
      degraded: false,
      degradedReasons: [],
    });
    goalPotPlacementAuthorityMock.mockResolvedValueOnce({
      allowed: false,
      reason: 'different-active-goal-owns-pot',
      ownerGoalId: 'goal-sidestage-owner',
      ownerGoalTitle: 'SideStage release',
      ownerState: { disposition: null, standing: false, liveWorklistPlans: 3, holderLiveness: 'not-checked' },
    });

    const res = await invokeLaunchHandler({
      name: 'Cross Goal Fleet',
      plan: 'my-plan',
      harness: 'sidestage',
      count: 1,
    });
    const text = (res as { content: { text: string }[] }).content[0].text;

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain('goal_placement_sovereignty_refusal');
    expect(text).toContain('non-terminal worklist plans=3');
    expect(text).toContain('holder liveness=not-checked');
    expect(text).toContain('disposition=none');
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('fails closed before launch side effects when active-owner authority is unreadable', async () => {
    goalLaunchReadMock.mockResolvedValueOnce({
      goalId: 'goal-work-on-everything',
      settings: null,
      drainFleetSlug: null,
      degraded: false,
      degradedReasons: [],
    });
    goalPotPlacementAuthorityMock.mockRejectedValueOnce(new Error('goal store unavailable'));

    const res = await invokeLaunchHandler({
      name: 'Unreadable Goal Ownership Fleet',
      plan: 'my-plan',
      harness: 'sidestage',
      count: 1,
    });
    const text = (res as { content: { text: string }[] }).content[0].text;

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain('goal_placement_sovereignty_unreadable');
    expect(text).toContain('goal store unavailable');
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('does not apply the GOAL-only fence to an ordinary launcher', async () => {
    await invokeLaunchHandler({
      name: 'Ordinary Plan Fleet',
      plan: 'my-plan',
      harness: 'papercusp',
      count: 1,
    });

    expect(goalPotPlacementAuthorityMock).not.toHaveBeenCalled();
    expect(createFleetIfAbsentMock).toHaveBeenCalled();
  });
});

describe('fleet:launch-on-plan GOAL provider placement boundary (P-006 / A-04)', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset().mockImplementation(() => ({
      status: 'ok',
      terminal: 'term-goal-boundary',
      pid: 901,
    }));
    spawnHeadlessMock.mockReset().mockImplementation(() => ({
      status: 'ok',
      terminal: 'headless-goal-boundary',
      pid: 902,
      taskId: 'task-goal-boundary',
      logPath: '/tmp/goal-boundary.log',
    }));
    fetchGatewayHeadroomMock.mockReset().mockResolvedValue({ reachable: false });
    goalLaunchReadMock.mockResolvedValue({
      goalId: 'goal-1',
      settings: null,
      drainFleetSlug: null,
      degraded: false,
      degradedReasons: [],
    });
    goalModeSubjectMock.mockResolvedValue('goal-1');
  });

  it('admits the normalized provider-selected action after defaulting spawned leadership', async () => {
    const res = await invokeLaunchHandler(
      {
        name: 'my-plan',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        headless: true,
      } as never,
      {} as never,
      null,
    );
    expect(parseHandlerPayload(res).ok).toBe(true);
    expect(obligationAgendaReadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        ownerId: 'owner-1',
        goalId: 'goal-1',
        planSlugs: [],
        fleetSlug: 'my-plan',
        launchCount: 1,
      }),
    );
    expect(createFleetIfAbsentMock).toHaveBeenCalled();
  });

  // WI-10004545: plans:new and plans:launch attribute a plan to the goal its LAUNCHER works
  // under; this door did not, so a goal's own plan fleet left `harness_plans.goal_id` NULL and
  // the goal portfolio never saw the plan (rem-dream-recombination + session-transcript-exact-
  // fuzzy-search, measured 2026-10-01). These tests pin WHEN the attribution is attempted; the
  // helper's identity-derived resolution and `WHERE goal_id IS NULL` live in goal-context.test.ts.
  describe('plan goal attribution (WI-10004545)', () => {
    const stampablePlan = () => ({
      slug: 'my-plan',
      parsed: { items: [] },
      archived: false,
      row: {
        planSlug: 'my-plan',
        workspaceId: 'ws-1',
        harnessSlug: 'papercusp',
        template: null,
        inputSchema: null,
        templateData: null,
      },
    });
    const launchGoalPlan = () =>
      invokeLaunchHandler(
        { name: 'my-plan', plan: 'my-plan', harness: 'papercusp', count: 1, headless: true } as never,
        {} as never,
        null,
      );

    it("attributes the launched plan to the launcher's goal from the plan row's own scope", async () => {
      readPlanBySlugMock.mockResolvedValueOnce(stampablePlan());
      stampPlanGoalProvenanceMock.mockResolvedValueOnce('goal-1');

      const payload = parseHandlerPayload(await launchGoalPlan());

      expect(payload.ok).toBe(true);
      // The row's OWN workspace/harness pair — the identity harness_plans was written with —
      // and the LAUNCHER as the owner the goal is resolved from. No goal id is ever passed in.
      expect(stampPlanGoalProvenanceMock).toHaveBeenCalledTimes(1);
      expect(stampPlanGoalProvenanceMock).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        harnessSlug: 'papercusp',
        planSlug: 'my-plan',
        ownerId: 'owner-1',
      });
      expect(payload.planGoalAttribution).toEqual({ goalId: 'goal-1', error: null });
    });

    it('records a failed attribution on the result and still returns the launched fleet', async () => {
      readPlanBySlugMock.mockResolvedValueOnce(stampablePlan());
      stampPlanGoalProvenanceMock.mockRejectedValueOnce(new Error('goal authority fenced'));

      const payload = parseHandlerPayload(await launchGoalPlan());

      expect(payload.ok).toBe(true);
      expect(payload.planGoalAttribution).toEqual({ goalId: null, error: 'goal authority fenced' });
    });

    it('does not attribute anything for a launcher that works under no goal', async () => {
      goalLaunchReadMock.mockResolvedValue({
        goalId: null,
        settings: null,
        drainFleetSlug: null,
        degraded: false,
        degradedReasons: [],
      });
      goalModeSubjectMock.mockResolvedValue(null);
      readPlanBySlugMock.mockResolvedValueOnce(stampablePlan());

      const payload = parseHandlerPayload(await launchGoalPlan());

      expect(payload.ok).toBe(true);
      expect(stampPlanGoalProvenanceMock).not.toHaveBeenCalled();
      expect(payload.planGoalAttribution).toBeNull();
    });

    it('does not attribute a plan whose launch was refused before any fleet write', async () => {
      goalPotPlacementAuthorityMock.mockResolvedValueOnce({
        allowed: false,
        reason: 'different-active-goal-owns-pot',
        ownerGoalId: 'goal-other-owner',
        ownerGoalTitle: 'Other goal',
      });
      readPlanBySlugMock.mockResolvedValueOnce(stampablePlan());

      const res = await launchGoalPlan();

      expect((res as { isError?: boolean }).isError).toBe(true);
      expect((res as { content: { text: string }[] }).content[0].text).toContain('goal_placement_sovereignty_refusal');
      expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
      expect(stampPlanGoalProvenanceMock).not.toHaveBeenCalled();
    });
  });

  // WI-10004401: the provider authors its recovery `name` from the RAW
  // `<harness>-<plan>-plan-fleet` string, while the tool derives the fleet slug with the
  // REAL 60-char clamp. Before the fix the boundary compared the clamped slug with the raw
  // name, so for any plan whose derived name exceeded 60 chars NO caller — not even one
  // sending the provider's recovery args verbatim — could satisfy the required boundary.
  it('admits the provider recovery args verbatim when the raw fleet name exceeds the 60-char slug clamp', async () => {
    const realStore = await vi.importActual<typeof import('../../../agent-fleets-store')>('../../../agent-fleets-store');
    const planSlug = 'session-transcript-exact-fuzzy-search-2026-09-14';
    const agendaFor = (recoveryArgs: Record<string, unknown>) => ({
      goalId: 'goal-1',
      observedAt: new Date().toISOString(),
      agenda: {
        evaluations: [
          {
            id: 'obl:long-name',
            ruleId: 'goal-plan-placement',
            ruleRevision: 'v2',
            family: 'plan-placement',
            title: `Place ${planSlug}`,
            scope: { workspaceId: 'ws-1', ownerId: 'owner-1', goalId: 'goal-1', planSlug },
            responsibleOwnerId: 'owner-1',
            episode: planSlug,
            status: 'due',
            authority: { kind: 'policy', sourceRef: 'test', revision: 'v2' },
            reason: `${planSlug} is the provider-selected eligible placement`,
            priority: 'high',
            causalRank: 1,
            applicableDemand: 1,
            sourceGeneration: 'current-long-name',
            evidence: [{ ref: `placement:${planSlug}`, observedAt: new Date().toISOString(), freshness: 'current' }],
            action: {
              kind: 'delegate',
              summary: `launch ${planSlug}`,
              tool: 'fleet:launch-on-plan',
              args: recoveryArgs,
            },
            clearsWhen: { id: 'placement', summary: 'live', evidenceKind: 'state', sourceRef: 'test' },
            boundary: {
              boundary: 'fleet:launch-on-plan',
              refusalCode: 'goal-plan-placement-prerequisite',
              enforcement: 'required',
              unknown: 'allow-with-warning',
            },
          },
        ],
      },
    });
    const recoveryArgs = {
      name: `papercusp-${planSlug}-plan-fleet`,
      plan: planSlug,
      harness: 'papercusp',
      leader: 'spawn',
      headless: true,
    };
    // Calibration: the fixture really is the failing shape (raw name longer than the clamp).
    expect(recoveryArgs.name.length).toBeGreaterThan(60);
    expect(realStore.fleetSlugFromName(recoveryArgs.name).length).toBe(60);

    fleetSlugImpl.impl = realStore.fleetSlugFromName;
    try {
      createFleetIfAbsentMock.mockClear();
      obligationAgendaReadMock.mockResolvedValueOnce(agendaFor(recoveryArgs));
      const admitted = parseHandlerPayload(
        await invokeLaunchHandler({ ...recoveryArgs, count: 1 } as never, {} as never, null),
      );
      expect(admitted.error).toBeUndefined();
      expect(admitted.ok).toBe(true);
      expect(createFleetIfAbsentMock).toHaveBeenCalled();

      // Control: a DIFFERENT fleet (differs inside the first 60 chars) still refuses — the
      // fix normalizes both sides, it does not loosen the required boundary.
      createFleetIfAbsentMock.mockClear();
      obligationAgendaReadMock.mockResolvedValueOnce(agendaFor(recoveryArgs));
      const refused = parseHandlerPayload(
        await invokeLaunchHandler(
          { ...recoveryArgs, name: `other-${planSlug}-plan-fleet`, count: 1 } as never,
          {} as never,
          null,
        ),
      );
      expect(refused).toMatchObject({ ok: false, error: 'goal-plan-placement-prerequisite' });
      expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    } finally {
      fleetSlugImpl.impl = fleetSlugImpl.stub;
    }
  });

  it('reports a GOAL launch refusal in failed[] and releases the slot for a retry', async () => {
    const { claimFleetLaunchSlot, releaseFleetLaunchSlot } = await import('../../../agent-fleets-store');
    let claimedAt: number | null = null;
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockClear();
    (releaseFleetLaunchSlot as ReturnType<typeof vi.fn>).mockClear();
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (claimedAt !== null) return { won: false, priorAt: claimedAt };
      claimedAt = Date.now();
      return { won: true, at: claimedAt };
    });
    (releaseFleetLaunchSlot as ReturnType<typeof vi.fn>).mockImplementation(async ({ at }: { at: number }) => {
      if (claimedAt === at) claimedAt = null;
    });
    goalLaunchResolveMock.mockResolvedValueOnce({
      goalId: 'goal-1',
      effective: {},
      refusal: {
        reason: 'goal_budget_unmeasurable',
        message: 'goal goal-1 budget cannot be measured; member launch refused',
      },
      settings: null,
    });

    const args = { name: 'Budget Gate Retry', plan: 'my-plan', harness: 'papercusp', count: 1, headless: true };
    try {
      const refused = await invokeLaunchHandler(args as never, {} as never, null);
      expect(parseHandlerPayload(refused)).toMatchObject({
        ok: false,
        fleet: 'budget-gate-retry',
        opened: [],
        failed: [{ code: 403, error: expect.stringContaining('budget cannot be measured') }],
        launchGuardReleased: true,
      });
      expect(claimedAt).toBeNull();
      expect(spawnHeadlessMock).not.toHaveBeenCalled();

      const retried = await invokeLaunchHandler(args as never, {} as never, null);
      const retryPayload = parseHandlerPayload(retried);
      expect(retryPayload.relaunchSuppressed).toBeUndefined();
      expect(retryPayload.opened).toHaveLength(1);
      expect(claimFleetLaunchSlot).toHaveBeenCalledTimes(2);
    } finally {
      (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({ won: true, at: 1 });
      (releaseFleetLaunchSlot as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
    }
  });

  it('refuses a wrong-plan/fleet operation before promotion or fleet writes', async () => {
    obligationAgendaReadMock.mockResolvedValueOnce({
      goalId: 'goal-1',
      observedAt: new Date().toISOString(),
      agenda: {
        evaluations: [
          {
            id: 'obl:wrong-plan',
            ruleId: 'goal-plan-placement',
            ruleRevision: 'v2',
            family: 'plan-placement',
            title: 'Place plan-b',
            scope: { workspaceId: 'ws-1', ownerId: 'owner-1', goalId: 'goal-1', planSlug: 'plan-b' },
            responsibleOwnerId: 'owner-1',
            episode: 'plan-b',
            status: 'due',
            authority: { kind: 'policy', sourceRef: 'test', revision: 'v2' },
            reason: 'plan-b is the highest-priority eligible plan',
            priority: 'high',
            causalRank: 1,
            applicableDemand: 1,
            sourceGeneration: 'current-b',
            evidence: [{ ref: 'placement:plan-b', observedAt: new Date().toISOString(), freshness: 'current' }],
            action: {
              kind: 'delegate',
              summary: 'launch plan-b',
              tool: 'fleet:launch-on-plan',
              args: {
                name: 'plan-b-fleet',
                plan: 'plan-b',
                harness: 'papercusp',
                leader: 'spawn',
                headless: true,
              },
            },
            clearsWhen: { id: 'placement', summary: 'live', evidenceKind: 'state', sourceRef: 'test' },
            boundary: {
              boundary: 'fleet:launch-on-plan',
              refusalCode: 'goal-plan-placement-prerequisite',
              enforcement: 'required',
              unknown: 'allow-with-warning',
            },
          },
        ],
      },
    });

    const res = await invokeLaunchHandler(
      {
        name: 'plan-a-fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        headless: true,
      } as never,
      {} as never,
      null,
    );
    const payload = parseHandlerPayload(res);
    expect(payload).toMatchObject({ ok: false, error: 'goal-plan-placement-prerequisite' });
    expect(payload.recovery.args).toMatchObject({ plan: 'plan-b', name: 'plan-b-fleet' });
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('refuses no-eligible-work and wrong-subject/stale evidence as non-authority', async () => {
    const baseInput = {
      goalId: 'goal-1',
      observedAt: new Date().toISOString(),
      agenda: { evaluations: [] as any[] },
    };
    obligationAgendaReadMock.mockResolvedValueOnce({
      ...baseInput,
      agenda: {
        evaluations: [
          {
            id: 'obl:none',
            family: 'plan-placement',
            status: 'not-applicable',
            scope: { workspaceId: 'ws-1', ownerId: 'owner-1', goalId: 'goal-1' },
            responsibleOwnerId: 'owner-1',
            sourceGeneration: 'current-none',
            evidence: [],
            reason: 'no non-terminal goal plan needs placement',
            boundary: {
              boundary: 'fleet:launch-on-plan',
              refusalCode: 'goal-plan-placement-prerequisite',
              enforcement: 'required',
              unknown: 'allow-with-warning',
            },
          },
        ],
      },
    });
    const noWork = await invokeLaunchHandler(
      {
        name: 'extra-fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        headless: true,
      } as never,
      {} as never,
      null,
    );
    expect(parseHandlerPayload(noWork)).toMatchObject({ ok: false, error: 'goal-plan-placement-prerequisite' });

    obligationAgendaReadMock.mockResolvedValueOnce({
      goalId: 'wrong-goal',
      observedAt: '2020-01-01T00:00:00.000Z',
      agenda: { evaluations: [] },
    });
    const stale = await invokeLaunchHandler(
      {
        name: 'stale-fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        headless: true,
      } as never,
      {} as never,
      null,
    );
    expect(parseHandlerPayload(stale)).toMatchObject({ ok: false, error: 'goal-plan-placement-prerequisite' });
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
  });
});

describe('launch-tool routing guidance', () => {
  it('identifies fleet:launch-on-plan as the ergonomic N-agents-on-a-plan door', () => {
    expect(tool.guidance?.when).toContain('ERGONOMIC N-AGENTS-ON-AN-EXISTING-PLAN DOOR');
    expect(tool.guidance?.when).toContain('capability:launch-agent');
    expect(tool.guidance?.when).toContain('capability:terminal');
    expect(tool.guidance?.when).toContain('not a reason to delay opening the fleet');
    expect(tool.description).toContain('Process open is not proof of registration');
    expect(tool.description).toContain('verified first turn');
    expect(tool.description).toContain('claimed task');
    expect(tool.description).not.toContain('auto-starts work');
    expect(tool.guidance?.notWhen).toContain('capability:launch-agent');
    expect(tool.guidance?.notWhen).toContain('launching-agents-which-tool-for-which-door');
  });
});

describe('launch-on-plan model argument validation', () => {
  it('rejects a local-model typo through the async Standard Schema path', async () => {
    const parsed = await standardValidate(tool.args, {
      name: 'fleet-test',
      plan: 'my-plan',
      model: 'ollama-cc/ornith-typo',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.some((issue) => issue.message.includes('ornith-valid'))).toBe(true);
  });

  it('accepts a flat effort and composes it onto the model spec', async () => {
    const parsed = await standardValidate(tool.args, {
      name: 'Flat Effort Fleet',
      plan: 'my-plan',
      model: 'sonnet',
      effort: 'high',
    });

    expect(parsed.ok).toBe(true);
  });
});

describe('gatewayCapacityProviderForFleetAgent', () => {
  it('uses the resolved native backend and maps OMP cloud models to their provider', () => {
    expect(gatewayCapacityProviderForFleetAgent('codex', undefined)).toBe('codex');
    expect(gatewayCapacityProviderForFleetAgent('claude', undefined)).toBe('claude');
    expect(gatewayCapacityProviderForFleetAgent('omp', 'gpt-5.6-luna:high')).toBe('codex');
    expect(gatewayCapacityProviderForFleetAgent('omp', 'opus:high')).toBe('claude');
  });

  it('falls back to the Claude projection for local or unknown OMP model ids', () => {
    expect(gatewayCapacityProviderForFleetAgent('omp', 'ollama-cc/ornith-valid')).toBe('claude');
    expect(gatewayCapacityProviderForFleetAgent('omp', 'future-provider/model-1')).toBe('claude');
  });
});

describe('resolveFleetAgent — Codex model authority', () => {
  it('refuses a Codex backend without an explicit or inherited Codex model', () => {
    expect(
      resolveFleetAgent({
        argAgent: 'codex',
        callerAgent: 'claude',
        callerModel: 'opus:xhigh',
      }),
    ).toMatchObject({
      error: expect.stringContaining('Codex model is required'),
    });
  });

  it('normalizes an explicit Codex alias while preserving its effort suffix', () => {
    expect(resolveFleetAgent({ argAgent: 'codex', argModel: 'sol:high' })).toEqual({
      agent: 'codex',
      model: 'gpt-5.6-sol:high',
      modelSource: 'explicit',
    });
  });
});

describe('fleet:launch-on-plan handler — atomic leader control (WI-38804)', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    spawnConsoleMock.mockImplementation(() => ({
      status: 'ok',
      terminal: `term-${spawnConsoleMock.mock.calls.length}`,
      pid: 100 + spawnConsoleMock.mock.calls.length,
    }));
    spawnHeadlessMock.mockReset();
    spawnHeadlessMock.mockImplementation(() => ({
      status: 'ok',
      terminal: `headless-${spawnHeadlessMock.mock.calls.length}`,
      pid: 200 + spawnHeadlessMock.mock.calls.length,
      taskId: `task-${spawnHeadlessMock.mock.calls.length}`,
      logPath: `/tmp/fleet-${spawnHeadlessMock.mock.calls.length}.log`,
    }));
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
  });

  it('lets a delegated leader with inherited goal provenance launch its assigned fleet', async () => {
    goalLaunchReadMock.mockResolvedValue({
      goalId: 'parent-goal', settings: null, drainFleetSlug: null,
      degraded: false, degradedReasons: [],
    });
    goalModeSubjectMock.mockResolvedValue(null);
    const res = await invokeLaunchHandler({
      name: 'Delegated Child Fleet', plan: 'my-plan', harness: 'papercusp',
      count: 1, leader: 'caller', headless: true,
    } as never, {} as never, null);
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(createFleetIfAbsentMock).toHaveBeenCalledWith(expect.objectContaining({ leaderOwnerId: 'owner-1' }));
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
  });

  it('spawns a separate leader when the actual GOAL holder omits leader', async () => {
    goalLaunchReadMock.mockResolvedValue({
      goalId: 'parent-goal', settings: { intendedParallelPlanFleets: 2 }, drainFleetSlug: null,
      degraded: false, degradedReasons: [],
    });
    goalModeSubjectMock.mockResolvedValue('parent-goal');
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: { leaderOwnerId: null, colorScheme: { name: 'Ocean' } }, created: true,
    });
    const res = await invokeLaunchHandler({
      name: 'Steward Delegates', plan: 'my-plan', harness: 'papercusp', count: 1, headless: true,
    } as never, {} as never, null);
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.spawnedLeader).toMatchObject({ registered: true });
    expect(payload.spawnedLeader.ownerId).not.toBe('owner-1');
    expect(payload.goalLeaderCoupling).toEqual({
      status: 'coupled', peerOwnerId: payload.spawnedLeader.ownerId, error: null,
    });
    expect(declareCouplingMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1', agentA: 'owner-1', agentB: payload.spawnedLeader.ownerId,
      declaredBy: 'owner-1', reason: 'GOAL parent-goal delegated fleet steward-delegates leadership',
    });
    expect(setPresenceFleetMock).not.toHaveBeenCalledWith('ws-1', 'owner-1', expect.anything(), 'leader');
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(2);
    const fs = require('node:fs');
    const allocation = 'intended concurrent plan fleets = 2; this fleet member target = 1';
    expect(fs.readFileSync(payload.memberLaunchContextPath, 'utf8')).toContain(allocation);
    expect(fs.readFileSync('/tmp/fleet-launch-ctx-test/launch-context/fleet-steward-delegates-leader-context.md', 'utf8'))
      .toContain(allocation);
  });

  it('refuses actual GOAL self-leadership before fleet writes or spawning', async () => {
    goalLaunchReadMock.mockResolvedValue({
      goalId: 'parent-goal', settings: null, drainFleetSlug: null,
      degraded: false, degradedReasons: [],
    });
    goalModeSubjectMock.mockResolvedValue('parent-goal');
    const res = await invokeLaunchHandler({
      name: 'Steward Self Lead', plan: 'my-plan', harness: 'papercusp',
      count: 1, leader: 'caller', headless: true,
    } as never, {} as never, null);
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(declareCouplingMock).not.toHaveBeenCalled();
  });

  it('reports a coupling failure without denying a leader that already launched', async () => {
    goalLaunchReadMock.mockResolvedValue({
      goalId: 'parent-goal', settings: null, drainFleetSlug: null,
      degraded: false, degradedReasons: [],
    });
    goalModeSubjectMock.mockResolvedValue('parent-goal');
    declareCouplingMock.mockRejectedValueOnce(new Error('coupling store unavailable'));
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: { leaderOwnerId: null, colorScheme: { name: 'Ocean' } }, created: true,
    });

    const res = await invokeLaunchHandler({
      name: 'Coupling Failure', plan: 'my-plan', harness: 'papercusp', count: 1, headless: true,
    } as never, {} as never, null);
    const payload = parseHandlerPayload(res);

    expect(payload.spawnedLeader).toMatchObject({ registered: true });
    expect(payload.goalLeaderCoupling).toMatchObject({
      status: 'failed', peerOwnerId: payload.spawnedLeader.ownerId,
      error: 'Error: coupling store unavailable',
    });
    expect(payload.message).toContain('repair with `coord:couple');
  });

  it('refuses an unprofiled local launch when visibility is omitted', async () => {
    const res = await tool.handler(
      { name: 'Unprofiled Visibility', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const text = (res as { content: { text: string }[] }).content[0].text;

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain('unprofiled_visibility_required');
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('persists the target and canonical boot recipe for a fresh homogeneous plan fleet', async () => {
    const res = await invokeLaunchHandler(
      {
        name: 'Fresh Profile Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        agent: 'claude',
        model: 'sonnet:high',
        account: 'default',
        headless: true,
        carry: 'cold',
        role: 'su',
        brief: 'drain the plan lane',
        contextSize: 'trimmed',
        compactionLimit: 200_000,
        extraArgs: ['--safe-flag'],
      } as never,
      {} as never,
      null,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.ok).toBe(true);
    expect(setFleetHeadcountTargetMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      fleetSlug: 'fresh-profile-fleet',
      target: 2,
      config: {
        plan: 'my-plan',
        harness: 'papercusp',
        agent: 'claude',
        model: 'sonnet',
        effort: 'high',
        account: 'default',
        headless: true,
        role: 'su',
        brief: 'drain the plan lane',
        contextSize: 'trimmed',
        compactionLimit: 200_000,
        carry: 'cold',
        extraArgs: ['--safe-flag'],
        supervise: true,
      },
    });
    expect(payload.headcountProfile).toMatchObject({
      applied: true,
      target: 2,
      config: {
        plan: 'my-plan',
        harness: 'papercusp',
        agent: 'claude',
        model: 'sonnet',
        effort: 'high',
      },
    });
  });

  it.each([true, false])('persists an explicit supervise:%s on a new fleet', async (supervise) => {
    const payload = parseHandlerPayload(await invokeLaunchHandler(
      { name: 'Supervision Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, headless: true, supervise } as never,
      {} as never,
      null,
    ));

    expect(payload.ok).toBe(true);
    expect(setFleetHeadcountTargetMock).toHaveBeenCalledTimes(1);
    expect(setFleetHeadcountTargetMock).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ supervise }),
    }));
    expect(payload.superviseGrant).toMatchObject({ requested: supervise, persisted: true });
  });

  it.each([false, true])('preserves an existing fleet supervise:%s when supervise is omitted', async (supervise) => {
    createFleetIfAbsentMock.mockResolvedValue({
      record: { leaderOwnerId: 'owner-1', colorScheme: { name: 'Ocean' } },
      created: false,
    });
    getFleetHeadcountTargetMock.mockResolvedValue({
      workspaceId: 'ws-1', fleetSlug: 'existing-fleet', enabled: true, target: 1,
      config: { plan: 'my-plan', harness: 'papercusp', supervise },
    });
    const payload = parseHandlerPayload(await invokeLaunchHandler(
      { name: 'Existing Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
      null,
    ));

    expect(payload.ok).toBe(true);
    expect(setFleetHeadcountTargetMock).not.toHaveBeenCalled();
    expect(payload.superviseGrant).toBeNull();
  });

  it('composes flat effort onto the model and persists it in a fresh homogeneous profile', async () => {
    const res = await invokeLaunchHandler(
      {
        name: 'Flat Effort Profile Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        agent: 'claude',
        model: 'sonnet',
        effort: 'high',
        account: 'default',
        headless: true,
      } as never,
      {} as never,
      null,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.ok).toBe(true);
    expect(spawnHeadlessMock.mock.calls[0][0].envelope.greetingCmd).toContain('--model=sonnet:high');
    expect(setFleetHeadcountTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ model: 'sonnet', effort: 'high' }),
      }),
    );
  });

  it('reuses the persisted headcount launch profile for an existing-fleet top-up/takeover with an omitted recipe (D-008)', async () => {
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      fleetSlug: 'profiled-fleet',
      target: 30,
      config: {
        plan: 'my-plan',
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
        brief: 'drain the bug lane',
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });

    const res = await invokeLaunchHandler({ name: 'Profiled Fleet' } as never, {} as never, null);
    const payload = parseHandlerPayload(res);

    expect(spawnHeadlessMock).toHaveBeenCalled();
    const command = (spawnHeadlessMock.mock.calls[0][0] as any).envelope.greetingCmd as string;
    expect(command).toContain('--agent=codex');
    expect(command).toContain('--model=gpt-5.6-luna:max');
    expect(command).toContain('--account=default');
    expect(command).toContain('--context-size=trimmed');
    expect(command).toContain('--compaction-limit=825000');
    expect(command).toContain('--carry=warm');
    expect(command).toContain('--headless');
    expect(payload.requested).toBe(30);
    expect(payload.headcountProfile).toMatchObject({
      applied: true,
      target: 30,
      provenance: {
        source: 'fleet:headcount-target',
        workspaceId: 'ws-1',
        fleetSlug: 'profiled-fleet',
      },
      reusePath: 'fleet:launch-on-plan -> agent-launch-core.memberLaunchCommand',
    });
  });

  it('omits a persisted GOAL launch slot from persona validation and psu commands, with a diagnostic', async () => {
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      fleetSlug: 'goal-slot-fleet',
      target: 1,
      config: {
        plan: 'my-plan',
        harness: 'papercusp',
        agent: 'claude',
        model: 'sonnet',
        headless: true,
        role: 'drain-fleet-leader',
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });
    spawnHeadlessMock.mockReset();
    spawnHeadlessMock.mockReturnValue({ status: 'ok', terminal: 'headless-1', pid: 201, taskId: 'task-1' });

    const res = await invokeLaunchHandler({ name: 'Goal Slot Fleet' } as never, {} as never, null);
    const payload = parseHandlerPayload(res);
    const command = (spawnHeadlessMock.mock.calls[0][0] as any).envelope.greetingCmd as string;

    expect(payload.ignoredRoleDiagnostics).toEqual([
      {
        role: 'drain-fleet-leader',
        source: 'fleet:headcount-target',
        reason: 'goal-launch-slot-is-not-a-psu-persona',
      },
    ]);
    expect(command).not.toContain('--role=drain-fleet-leader');
    expect(assembleRolePromptMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: 'drain-fleet-leader' }),
    );
    expect(payload.message).toContain('ignored persisted GOAL launch slot role(s)');
  });

  it('omits a persisted fleet membership label from persona validation and psu commands', async () => {
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      fleetSlug: 'legacy-member-role-fleet',
      target: 1,
      config: {
        plan: 'my-plan',
        harness: 'papercusp',
        agent: 'claude',
        model: 'sonnet',
        headless: true,
        role: 'member',
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });
    spawnHeadlessMock.mockReset();
    spawnHeadlessMock.mockReturnValue({ status: 'ok', terminal: 'headless-1', pid: 201, taskId: 'task-1' });

    const res = await invokeLaunchHandler({ name: 'Legacy Member Role Fleet' } as never, {} as never, null);
    const payload = parseHandlerPayload(res);
    const command = (spawnHeadlessMock.mock.calls[0][0] as any).envelope.greetingCmd as string;

    expect(payload.ok).toBe(true);
    expect(command).not.toContain('--role=member');
    expect(assembleRolePromptMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: 'member' }),
    );
    expect(payload.headcountProfile.config).not.toHaveProperty('role');
  });

  it('uses the existing fleet live claim lane before stale saved-plan admission on an omitted top-up (EI-21577352340987493)', async () => {
    const callOrder: string[] = [];
    const liveSpec = {
      ...DEFAULT_CLAIM_SPEC,
      specId: 'fleet-launch-stale-profile-fleet-kinds',
      revision: 38,
      view: { filter: { field: 'kind', op: 'in', value: ['bug'] } },
    };
    getFleetMock.mockImplementation(async () => {
      callOrder.push('getFleet');
      return {
        workspaceId: 'ws-1',
        fleetSlug: 'stale-profile-fleet',
        owner: 'owner-1',
        leaderOwnerId: 'owner-1',
        fleetType: 'single',
      };
    });
    getClaimSpecMock.mockImplementation(async () => {
      callOrder.push('getClaimSpec');
      return liveSpec;
    });
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      fleetSlug: 'stale-profile-fleet',
      target: 2,
      config: {
        plan: 'stale-plan',
        harness: 'papercusp',
        agent: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'max',
        account: 'default',
        headless: true,
        carry: 'warm',
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });
    createFleetIfAbsentMock.mockImplementation(async () => {
      callOrder.push('createFleet');
      return {
        record: { leaderOwnerId: 'owner-1', colorScheme: { name: 'Ocean' }, fleetType: 'single' },
        created: false,
      };
    });
    setClaimSpecMock.mockReset();
    readPlanBySlugMock.mockClear();

    const res = await invokeLaunchHandler({ name: 'Stale Profile Fleet' } as never, {} as never, null);
    const payload = parseHandlerPayload(res);

    expect(payload.ok).toBe(true);
    expect(payload.plan).toBeNull();
    expect(payload.claimSpecApplied).toMatchObject({ ok: true, revision: 38 });
    expect(setClaimSpecMock).not.toHaveBeenCalled();
    expect(admissionMocks.preflight).not.toHaveBeenCalled();
    expect(readPlanBySlugMock).not.toHaveBeenCalled();
    expect(callOrder.slice(0, 3)).toEqual(['getFleet', 'getClaimSpec', 'createFleet']);
    expect(callOrder.lastIndexOf('getClaimSpec')).toBeGreaterThan(callOrder.indexOf('createFleet'));
    expect(spawnHeadlessMock).toHaveBeenCalled();
  });

  it('does not re-enter the plan BAR start gate for an existing-fleet top-up with an explicit plan (EI-22682096290512373)', async () => {
    const liveSpec = {
      ...DEFAULT_CLAIM_SPEC,
      specId: 'fleet-launch-bar-top-up-fleet-kinds',
      revision: 39,
      view: { filter: { field: 'kind', op: 'in', value: ['bug'] } },
    };
    getFleetMock.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      fleetSlug: 'bar-top-up-fleet',
      owner: 'owner-1',
      leaderOwnerId: 'owner-1',
      fleetType: 'single',
    });
    getClaimSpecMock.mockResolvedValue(liveSpec);
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      fleetSlug: 'bar-top-up-fleet',
      target: 1,
      config: {
        plan: 'my-plan',
        harness: 'papercusp',
        agent: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'max',
        account: 'default',
        headless: true,
        carry: 'warm',
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: { leaderOwnerId: 'owner-1', colorScheme: { name: 'Ocean' }, fleetType: 'single' },
      created: false,
    });
    acceptanceBarLifecycleMock.mockResolvedValueOnce({ satisfied: false });
    readPlanBySlugMock.mockClear();

    const res = await invokeLaunchHandler(
      { name: 'BAR Top-up Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, headless: true } as never,
      {} as never,
      null,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.ok).toBe(true);
    expect(payload.plan).toBe('my-plan');
    expect(readPlanBySlugMock).toHaveBeenCalledWith('my-plan', {
      harnessSlug: 'papercusp',
      workspaceId: 'ws-1',
    });
    expect(acceptanceBarLifecycleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).toHaveBeenCalled();
  });

  it('fails closed before an existing-fleet top-up when launch knobs conflict with the saved profile', async () => {
    getFleetHeadcountTargetMock.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      fleetSlug: 'profiled-fleet',
      target: 30,
      config: {
        plan: 'my-plan',
        harness: 'papercusp',
        agent: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'max',
        account: 'default',
        headless: true,
        carry: 'warm',
      },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });

    const res = await invokeLaunchHandler(
      { name: 'Profiled Fleet', account: 'auto', headless: false } as never,
      {} as never,
    );
    const text = (res as { content: { text: string }[] }).content[0].text;

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain('Saved launch spec conflict');
    expect(text).toContain('"field":"account"');
    expect(text).toContain('"field":"headless"');
    expect(text).toContain('fleet:respawn-member');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  // WI-41206 / remove-memory-derived-work-refusals-2026-08-24: this case USED to assert the
  // wave was suppressed. It now asserts the opposite, deliberately: an exhausted RAM-only
  // budget is ADVISORY and must not withhold a member. The old behaviour returned 0 for every
  // headless launch once the live population crossed floor(usable/perScope), because it
  // reserved each scope's full cap rather than its real usage. A worker over budget pages.
  it('launches a headless wave anyway when the RAM-only budget is exhausted, reporting it as advisory', async () => {
    totalmemMock.mockReturnValueOnce(32 * 1024 ** 3);
    listLiveTasksMock.mockResolvedValueOnce(
      Array.from({ length: 4 }, () => ({ class: 'agent-session', memoryMaxBytes: 6 * 1024 ** 3 })),
    );

    const res = await invokeLaunchHandler(
      { name: 'Memory Full Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, headless: true } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(listLiveTasksMock).toHaveBeenCalledWith('ws-1');
    // The member is opened even though the budget says there is no slot for it.
    expect(spawnHeadlessMock).toHaveBeenCalled();
    expect(payload.hostMemorySuppressed).toBe(false);
    // The measurement is still reported — losing the observability was never the goal.
    expect(payload.hostMemoryClamp).toMatchObject({
      requestedOpenCount: 1,
      activeProtectedAgentScopes: 4,
      availableProtectedAgentScopes: 0,
    });
    // ...and it must not be phrased as a limit that was applied.
    expect(payload.hostMemoryClamp.reason).toContain('host-memory-advisory');
    expect(payload.hostMemoryClamp.reason).toContain('does not gate the launch');
    expect(payload.message ?? '').not.toContain('host-memory admission allows 0 new headless members');
  });

  it('admits a measured fleet whose aggregate peaks fit the host budget', async () => {
    const GiB = 1024 ** 3;
    totalmemMock.mockReturnValueOnce(256 * GiB);
    listLiveTasksMock.mockResolvedValueOnce(
      Array.from({ length: 53 }, () => ({
        class: 'agent-session',
        memoryMaxBytes: 6 * GiB,
        peakMemoryBytes: 1.4 * GiB,
      })),
    );

    const res = await invokeLaunchHandler(
      { name: 'Measured Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, headless: true } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(spawnHeadlessMock).toHaveBeenCalled();
    expect(payload.hostMemoryClamp).toMatchObject({
      activeProtectedAgentScopes: 53,
      unmeasuredProtectedAgentScopes: 0,
      requestedOpenCount: 1,
      openCount: 1,
      clamped: false,
    });
  });

  it('rejects an unresolved member role before promotion, fleet creation, or terminal spawn', async () => {
    assembleRolePromptMock.mockImplementationOnce(() => {
      throw new Error(
        'assembleRolePrompt: no prompt file found for role "builder" (phase=staging, dept=none, blueprintId=none)',
      );
    });

    const res = await invokeLaunchHandler(
      {
        name: 'Bad Role',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        role: 'builder',
        members: [{ role: 'builder' }],
      } as never,
      {} as never,
    );

    expect((res as any).isError).toBe(true);
    expect((res as any).content[0].text).toContain('Invalid fleet member role `builder`');
    expect((res as any).content[0].text).toContain('NO fleet was created and NO terminals were opened');
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('cleans up a pre-spawn command-composition failure instead of leaving a false launch count', async () => {
    const { releaseFleetLaunchSlot } = await import('../../../agent-fleets-store');
    const releaseSlot = releaseFleetLaunchSlot as ReturnType<typeof vi.fn>;
    releaseSlot.mockClear();
    releaseSlot.mockResolvedValue(undefined);

    const res = await invokeLaunchHandler(
      {
        name: 'Invalid Effort Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        headless: true,
        // The effective launch config has an effort but no model. The shared
        // command composer must reject this before any member can spawn.
        //
        // Pinned to `omp` as of the 2026-09-15 owner directive (WI-10001535): the
        // CLAUDE backend now fills an omitted model with the opus 5 xhigh configured
        // default, so effort-without-model is no longer REACHABLE there — the hazard
        // is eliminated rather than hidden. `omp` has no such default, so it remains
        // the backend on which this guard can genuinely fire, which is why the case is
        // re-pointed here instead of deleted.
        agent: 'omp',
        effort: 'xhigh',
      } as never,
      {} as never,
    );
    const text = (res as { content: { text: string }[] }).content[0].text;

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain('Could not compose fleet member launch command');
    expect(text).toContain('effort "xhigh" needs a model');
    expect(setFleetHeadcountTargetMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(releaseSlot).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      fleetSlug: 'invalid-effort-fleet',
      at: 1,
    });
  });

  it('exposes only trimmed context at both fleet-wide and per-member public schema boundaries', async () => {
    const fleetWide = await standardValidate(tool.args, {
      name: 'Retired Context Fleet',
      plan: 'my-plan',
      contextSize: 'full',
    });
    const perMember = await standardValidate(tool.args, {
      name: 'Retired Member Context Fleet',
      plan: 'my-plan',
      members: [{ contextSize: 'full' }],
    });

    expect(fleetWide.ok).toBe(false);
    expect(perMember.ok).toBe(false);
    if (!fleetWide.ok) expect(fleetWide.issues.some((issue) => issue.path?.includes('contextSize'))).toBe(true);
    if (!perMember.ok) expect(perMember.issues.some((issue) => issue.path?.includes('contextSize'))).toBe(true);
  });

  it('installs caller-led control immediately after the presence role and reports its health', async () => {
    const res = await invokeLaunchHandler(
      { name: 'Caller Led', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(ensureFleetLeaderControlMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      ownerId: 'owner-1',
      fleetSlug: 'caller-led',
      harnessSlug: 'papercusp',
      planSlug: 'my-plan',
      carry: 'warm',
    });
    expect(setPresenceFleetMock.mock.invocationCallOrder[0]).toBeLessThan(
      ensureFleetLeaderControlMock.mock.invocationCallOrder[0],
    );
    expect(payload.autoModeEntered).toBe(true);
    expect(payload.leaderControl).toMatchObject({ healthy: true, mode: { healthy: true } });
  });

  it('installs control for a spawned leader only after the registry names that launched owner', async () => {
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: { leaderOwnerId: null, colorScheme: { name: 'Ocean' } },
      created: true,
    });

    const res = await invokeLaunchHandler(
      {
        name: 'Spawn Led',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        leader: 'spawn',
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.spawnedLeader).toMatchObject({ registered: true });
    expect(setFleetLeaderMock).toHaveBeenCalledWith('ws-1', 'spawn-led', payload.spawnedLeader.ownerId);
    expect(ensureFleetLeaderControlMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      ownerId: payload.spawnedLeader.ownerId,
      fleetSlug: 'spawn-led',
      harnessSlug: 'papercusp',
      planSlug: 'my-plan',
      carry: 'warm',
    });
    expect(setFleetLeaderMock.mock.invocationCallOrder[0]).toBeLessThan(
      setPresenceFleetMock.mock.invocationCallOrder[0],
    );
    expect(setPresenceFleetMock).toHaveBeenCalledWith(
      'ws-1',
      payload.spawnedLeader.ownerId,
      'spawn-led',
      'leader',
    );
    expect(setPresenceFleetMock.mock.invocationCallOrder[0]).toBeLessThan(
      ensureFleetLeaderControlMock.mock.invocationCallOrder[0],
    );
    expect(payload.autoModeEntered).toBe(true);
    expect(payload.leaderControl).toMatchObject({ healthy: true, mode: { healthy: true } });
  });

  it('stamps launcher and fleet provenance onto headless spawned leaders and members', async () => {
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: { leaderOwnerId: null, colorScheme: { name: 'Ocean' } },
      created: true,
    });

    const res = await invokeLaunchHandler(
      {
        name: 'Headless Spawn Led',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        leader: 'spawn',
        headless: true,
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.ok).toBe(true);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(2);
    expect(spawnHeadlessMock.mock.calls[0][0]).toMatchObject({
      launchedBy: 'owner-1',
      fleetSlug: 'headless-spawn-led',
      coordOwnerId: payload.spawnedLeader.ownerId,
    });
    expect(spawnHeadlessMock.mock.calls[1][0]).toMatchObject({
      launchedBy: 'owner-1',
      fleetSlug: 'headless-spawn-led',
      coordOwnerId: payload.opened[0].ownerId,
    });
  });

  it('protects a confirmed-live leader when leader:\'spawn\' is requested on an existing fleet', async () => {
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: {
        owner: 'other-caller',
        leaderOwnerId: 'live-leader',
        colorScheme: { name: 'Ocean' },
      },
      created: false,
    });
    getPresenceMock.mockResolvedValueOnce({ ownerId: 'live-leader' });

    const res = await invokeLaunchHandler(
      { name: 'Live Leader Protected', plan: 'my-plan', harness: 'papercusp', count: 1, leader: 'spawn' } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(getPresenceMock).toHaveBeenCalledWith('live-leader');
    expect(payload.leaderSpawnIgnored).toContain('already exists and is led by');
    expect(payload.spawnedLeader).toBeNull();
    expect(setFleetLeaderMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1); // ordinary member top-up only
    expect(payload.callerMembership.enrolled).toBe(true);
  });

  it('fails closed when existing-leader liveness cannot be read', async () => {
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: { owner: 'other-caller', leaderOwnerId: 'unknown-leader', colorScheme: { name: 'Ocean' } },
      created: false,
    });
    getPresenceMock.mockRejectedValueOnce(new Error('presence unavailable'));

    const res = await invokeLaunchHandler(
      { name: 'Unknown Leader', plan: 'my-plan', harness: 'papercusp', count: 1, leader: 'spawn' } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.leaderSpawnIgnored).toContain('liveness could not be confirmed');
    expect(payload.spawnedLeader).toBeNull();
    expect(setFleetLeaderMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
  });

  it('replaces an absent existing leader with a fresh delegated leader, keeping the caller outside', async () => {
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: {
        owner: 'other-caller',
        leaderOwnerId: 'dead-leader',
        colorScheme: { name: 'Ocean' },
      },
      created: false,
    });
    getPresenceMock.mockResolvedValueOnce(null);

    const res = await invokeLaunchHandler(
      { name: 'Absent Leader Recovery', plan: 'my-plan', harness: 'papercusp', count: 1, leader: 'spawn' } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(getPresenceMock).toHaveBeenCalledWith('dead-leader');
    expect(payload.callerMembership).toEqual({
      enrolled: false,
      role: 'delegator',
      reason: 'leader-spawn-caller-excluded',
    });
    expect(payload.spawnedLeader).toMatchObject({ registered: true });
    expect(setFleetLeaderMock).toHaveBeenCalledWith(
      'ws-1',
      'absent-leader-recovery',
      payload.spawnedLeader.ownerId,
      undefined,
      'dead-leader',
    );
    expect(spawnConsoleMock).toHaveBeenCalledTimes(2); // leader first, then the member
    expect(setPresenceFleetMock).toHaveBeenCalledWith(
      'ws-1',
      payload.spawnedLeader.ownerId,
      'absent-leader-recovery',
      'leader',
    );
    expect(payload.leaderSpawnIgnored).toBeNull();
  });

  it('recovers a leaderless existing fleet with a fresh delegated leader', async () => {
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: { owner: 'other-caller', leaderOwnerId: null, colorScheme: { name: 'Ocean' } },
      created: false,
    });

    const res = await invokeLaunchHandler(
      { name: 'Leaderless Recovery', plan: 'my-plan', harness: 'papercusp', count: 1, leader: 'spawn' } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(getPresenceMock).not.toHaveBeenCalled();
    expect(payload.spawnedLeader).toMatchObject({ registered: true });
    expect(setFleetLeaderMock).toHaveBeenCalledWith(
      'ws-1',
      'leaderless-recovery',
      payload.spawnedLeader.ownerId,
      undefined,
      null,
    );
    expect(payload.callerMembership.enrolled).toBe(false);
  });

  it('recovers the absent leader even when the existing member target is already full', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue(['member-1']);
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: { owner: 'other-caller', leaderOwnerId: 'dead-leader', colorScheme: { name: 'Ocean' } },
      created: false,
    });
    getPresenceMock.mockResolvedValueOnce(null);

    const res = await invokeLaunchHandler(
      { name: 'Full Fleet Recovery', plan: 'my-plan', harness: 'papercusp', count: 1, leader: 'spawn' } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.ok).toBe(true);
    expect(payload.spawnedLeader).toMatchObject({ registered: true });
    expect(payload.opened).toEqual([]);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1); // leader only; target member already exists
    expect(setFleetLeaderMock).toHaveBeenCalledWith(
      'ws-1',
      'full-fleet-recovery',
      payload.spawnedLeader.ownerId,
      undefined,
      'dead-leader',
    );
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('leaves the recorded dead leader untouched when delegated leader spawn fails', async () => {
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: { owner: 'other-caller', leaderOwnerId: 'dead-leader', colorScheme: { name: 'Ocean' } },
      created: false,
    });
    getPresenceMock.mockResolvedValueOnce(null);
    spawnConsoleMock.mockImplementationOnce(() => ({ status: 'error', terminal: '', pid: null, error: 'boot failed', code: 500 }));

    const res = await invokeLaunchHandler(
      { name: 'Failed Recovery', plan: 'my-plan', harness: 'papercusp', count: 1, leader: 'spawn' } as never,
      {} as never,
    );
    const text = (res as any).content[0].text as string;

    expect((res as any).isError).toBe(true);
    expect(text).toContain('still records its prior absent leader `dead-leader`');
    expect(setFleetLeaderMock).not.toHaveBeenCalled();
    expect(setPresenceFleetMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a concurrent takeover when the delegated leader CAS loses', async () => {
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: { owner: 'other-caller', leaderOwnerId: 'dead-leader', colorScheme: { name: 'Ocean' } },
      created: false,
    });
    getPresenceMock.mockResolvedValueOnce(null);
    setFleetLeaderMock.mockResolvedValueOnce(null);

    const res = await invokeLaunchHandler(
      { name: 'CAS Race Recovery', plan: 'my-plan', harness: 'papercusp', count: 1, leader: 'spawn' } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(setFleetLeaderMock).toHaveBeenCalledWith(
      'ws-1',
      'cas-race-recovery',
      payload.spawnedLeader.ownerId,
      undefined,
      'dead-leader',
    );
    expect(payload.spawnedLeader).toMatchObject({ registered: false });
    expect(payload.leaderSpawnRecoveryWarning).toContain('leadership changed concurrently');
    expect(setPresenceFleetMock).not.toHaveBeenCalled();
    expect(ensureFleetLeaderControlMock).not.toHaveBeenCalled();
    expect(payload.callerMembership.enrolled).toBe(false);
  });

  it('keeps the caller outside on a same-owner spawned-leader retry', async () => {
    goalLaunchReadMock.mockResolvedValue({
      goalId: 'parent-goal', settings: null, drainFleetSlug: null,
      degraded: false, degradedReasons: [],
    });
    goalModeSubjectMock.mockResolvedValue('parent-goal');
    setClaimSpecMock.mockReset();
    setClaimSpecMock.mockResolvedValue({ ok: true, revision: 2 });
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: {
        owner: 'owner-1',
        leaderOwnerId: 'spawned-leader',
        colorScheme: { name: 'Ocean' },
      },
      created: false,
    });

    const res = await invokeLaunchHandler(
      {
        name: 'Spawn Retry',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        leader: 'spawn',
        headless: true,
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.callerMembership).toEqual({
      enrolled: false,
      role: 'delegator',
      reason: 'leader-spawn-caller-excluded',
    });
    expect(payload.leaderRole).toBe('delegator');
    expect(payload.leaderSpawnIgnored).toContain('caller remains outside the fleet');
    expect(payload.goalLeaderCoupling).toEqual({
      status: 'coupled', peerOwnerId: 'spawned-leader', error: null,
    });
    expect(declareCouplingMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1', agentA: 'owner-1', agentB: 'spawned-leader',
      declaredBy: 'owner-1', reason: 'GOAL parent-goal delegated fleet spawn-retry leadership',
    });
    expect(setPresenceFleetMock).not.toHaveBeenCalled();
    expect(setFleetLeaderMock).not.toHaveBeenCalled();
    expect(ensureFleetLeaderControlMock).not.toHaveBeenCalled();
    expect(setClaimSpecMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(payload.message).toContain('kept you outside the fleet');
  });

  it('keeps ordinary top-up enrollment for an unrelated existing fleet', async () => {
    setClaimSpecMock.mockReset();
    setClaimSpecMock.mockResolvedValue({ ok: true, revision: 2 });
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: {
        owner: 'other-caller',
        leaderOwnerId: 'other-leader',
        colorScheme: { name: 'Ocean' },
      },
      created: false,
    });

    const res = await invokeLaunchHandler(
      {
        name: 'Unrelated Top Up',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        leader: 'spawn',
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.callerMembership.enrolled).toBe(true);
    expect(setPresenceFleetMock).toHaveBeenCalledWith('ws-1', 'owner-1', 'unrelated-top-up', 'leader');
    expect(setClaimSpecMock).toHaveBeenCalledTimes(1);
    expect(payload.leaderSpawnIgnored).toContain('only tops up members');
  });
});

describe('memberLaunchCommand', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
  });

  it('builds the scripted psu launch that triggers the auto-kickoff', () => {
    expect(memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'my-plan' })).toBe(
      'psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan',
    );
  });

  it('always carries --no-picker + --plan (the kickoff gate) for every backend', () => {
    for (const agent of ['claude', 'omp', 'codex']) {
      const cmd = memberLaunchCommand({
        fleetSlug: 'f',
        agent,
        harness: 'h',
        plan: 'p',
        model: agent === 'codex' ? 'gpt-5.6-sol:xhigh' : undefined,
      });
      expect(cmd).toContain('--no-picker');
      expect(cmd).toContain('--plan=p');
      expect(cmd).toContain(`--agent=${agent}`);
      expect(cmd).toContain('--fleet=f');
    }
  });

  it('threads the account pin + scalar psu flags as --flag=value (EI-5765)', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'ops',
      agent: 'claude',
      harness: 'papercusp',
      plan: 'my-plan',
      account: 'aviynw6',
      workspace: 'ws1',
      role: 'su',
      model: 'opus:high',
      feature: 'F-3',
      profile: 'p',
    });
    expect(cmd).toContain('--account=aviynw6');
    expect(cmd).toContain('--workspace=ws1');
    expect(cmd).toContain('--role=su');
    expect(cmd).toContain('--model=opus:high'); // ':' is shell-safe → bare
    expect(cmd).toContain('--feature=F-3');
    expect(cmd).toContain('--profile=p');
    // the base tokens stay first + unchanged
    expect(cmd.startsWith('psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan')).toBe(true);
  });

  it('emits --brain as a bare flag and --add-dir repeated', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      brain: true,
      addDir: ['/a', '/b'],
    });
    expect(cmd).toContain(' --brain');
    expect(cmd).toContain('--add-dir=/a');
    expect(cmd).toContain('--add-dir=/b');
  });

  it('emits --allow-subagents as a bare flag when opted in (owner mandate 2026-07-02); omitted by default (deny)', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      allowSubagents: true,
    });
    expect(cmd).toContain(' --allow-subagents');
    expect(memberLaunchCommand({ fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p' })).not.toContain(
      '--allow-subagents',
    );
  });

  it('threads the sole effective --context-size=trimmed value', () => {
    expect(
      memberLaunchCommand({ fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', contextSize: 'trimmed' }),
    ).toContain('--context-size=trimmed');
  });

  it('threads --seat=<ref> for a launch-from-seats member (P-005); omitted otherwise', () => {
    expect(
      memberLaunchCommand({ fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', seat: 'opus:xhigh:AUTO' }),
    ).toContain('--seat=opus:xhigh:AUTO'); // ':' is shell-safe → bare
    expect(memberLaunchCommand({ fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p' })).not.toContain('--seat');
  });

  it('shell-quotes a launch-context path with spaces (injection-safe)', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      launchContext: '/home/x/brief one.md',
    });
    expect(cmd).toContain(`--launch-context='/home/x/brief one.md'`);
  });

  it('appends extraArgs verbatim, quoting only what needs it', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      extraArgs: ['--yes', '--add-dir=/x y'],
    });
    expect(cmd).toContain(' --yes');
    expect(cmd).toContain(`'--add-dir=/x y'`);
  });

  it('omits every optional flag when none are passed (base command unchanged)', () => {
    expect(memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'my-plan' })).toBe(
      'psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan',
    );
  });

  it('loads + self-registers the tool module without error', () => {
    expect(tool).toBeTruthy();
  });

  it('registers outside the ambient workspace transaction for long-running launches', () => {
    const metadata = tool as { requirePrincipal?: boolean; skipWorkspaceTx?: boolean };
    expect(metadata.requirePrincipal).toBe(false);
    expect(metadata.skipWorkspaceTx).toBe(true);
  });

  // Owner directive 2026-09-15 (WI-10001535): "set the canary agents to opus 5 xhigh
  // agents pinned to auto mode of the inference gateway". The omission default moved
  // from 'default' (gateway SKIPPED, no failover) to 'auto' (gateway auto-routes and
  // fails over). These cases are kept — not deleted — because they are what makes a
  // future silent flip back to a gateway-bypassing default detectable.
  describe('defaultMemberAccountRouting — omission is gateway AUTO routing everywhere', () => {
    it('defaults an un-pinned member to "auto" on macOS', () => {
      expect(defaultMemberAccountRouting(undefined, 'darwin')).toBe('auto');
      expect(defaultMemberAccountRouting('', 'darwin')).toBe('auto');
    });

    it('uses the same gateway-auto value on Linux/Windows', () => {
      expect(defaultMemberAccountRouting(undefined, 'linux')).toBe('auto');
      expect(defaultMemberAccountRouting(undefined, 'win32')).toBe('auto');
    });

    it('never overrides an explicit account pin — incl. the "default" escape hatch — on any platform', () => {
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        expect(defaultMemberAccountRouting('aviynw6', platform)).toBe('aviynw6');
        expect(defaultMemberAccountRouting('auto', platform)).toBe('auto');
        // A Mac operator that explicitly wants direct egress passes 'default' — it must survive.
        expect(defaultMemberAccountRouting('default', platform)).toBe('default');
      }
    });

    it('the resolved routing flows into --account: a Mac member launch carries --account=auto', () => {
      const account = defaultMemberAccountRouting(undefined, 'darwin');
      const cmd = memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'p', account });
      expect(cmd).toContain('--account=auto');
    });
  });

  it('surfaces a sizing advisory only when requested members exceed healthy account headroom', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    fetchGatewayHeadroomMock.mockResolvedValue({
      reachable: true,
      utilization: 0.1,
      utilizationPct: 10,
      paused: false,
      rejected: false,
      inFlight: 0,
      queueDepth: 0,
      priorityTiers: {
        healthyAccounts: 1,
        tier1Reserve: 0,
        tiers: [{ tier: 3, minShare: 4, inFlight: 0, queued: 0 }],
      },
    });

    const warned = await invokeLaunchHandler(
      { name: 'Alpha Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const warnedPayload = parseHandlerPayload(warned);
    expect(warnedPayload.ok).toBe(true);
    expect(warnedPayload.sizingAdvisory).toMatchObject({
      requestedMembers: 2,
      healthyHeadroom: 1,
      extraMembers: 1,
    });
    expect(warnedPayload.message).toMatch(/Sizing advisory:/);

    fetchGatewayHeadroomMock.mockResolvedValue({
      reachable: true,
      utilization: 0.1,
      utilizationPct: 10,
      paused: false,
      rejected: false,
      inFlight: 0,
      queueDepth: 0,
      priorityTiers: {
        healthyAccounts: 2,
        tier1Reserve: 0,
        tiers: [{ tier: 3, minShare: 4, inFlight: 0, queued: 0 }],
      },
    });

    const notWarned = await invokeLaunchHandler(
      { name: 'Alpha Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const notWarnedPayload = parseHandlerPayload(notWarned);
    expect(notWarnedPayload.ok).toBe(true);
    expect(notWarnedPayload.sizingAdvisory).toBeNull();
    expect(notWarnedPayload.message).not.toMatch(/Sizing advisory:/);
  });
});

describe('clampFleetTopUpToCapacity', () => {
  it('clamps to dispatchBudget (concurrency) — NOT account count, NOT weekly-budget utilization', () => {
    // healthyAccounts=2 must NOT be the binding cap, and neither must recommendedHeadroom
    // (weekly-token-budget utilization). dispatchBudget=3 (spare admission slots) is the ONLY hard
    // cap: min(4, 3) = 3. recommendedHeadroom=4 ≥ openCount → not even a utilization advisory.
    expect(
      clampFleetTopUpToCapacity(4, {
        reachable: true,
        healthyAccounts: 2,
        dispatchBudget: 3,
        recommendedHeadroom: 4,
      }),
    ).toMatchObject({
      requestedOpenCount: 4,
      openCount: 3,
      clamped: true,
      healthyAccounts: 2,
      dispatchBudget: 3,
      recommendedHeadroom: 4,
      utilizationTight: false,
    });
  });

  it('does NOT clamp an explicit fleet on weekly-budget utilization when concurrency slots are free (the 5→2 incident)', () => {
    // THE reported bug (research-desk, 2026-07-08): an owner asked for 5 members; the pool had ~24
    // free admission slots but ONE bound account at ~0.94 of its 7-DAY token window drove
    // recommendedHeadroom down to the minHeadroom floor (2). recommendedHeadroom is budget-WINDOW
    // utilization, NOT concurrency — a near-weekly-cap account still runs many simultaneous sessions
    // right now — so it must NOT clamp. All 5 open; the tightness is surfaced as an ADVISORY only.
    const clamp = clampFleetTopUpToCapacity(5, {
      reachable: true,
      healthyAccounts: 1,
      dispatchBudget: 24,
      recommendedHeadroom: 2,
    });
    expect(clamp).toMatchObject({
      requestedOpenCount: 5,
      openCount: 5,
      clamped: false,
      utilizationTight: true,
    });
    expect(clamp?.reason).toMatch(/weekly-token-budget is tight/);
  });

  it('does NOT clamp a multi-member launch to a single healthy account (the 1-account=1-session bug)', () => {
    // The reported incident: 3 members requested, pool had ONE healthy account, launch
    // collapsed to 1. One account paces many concurrent sessions (gateway concurrency=24),
    // so with ample dispatchBudget the full request opens — account count is not a cap.
    const clamp = clampFleetTopUpToCapacity(3, {
      reachable: true,
      healthyAccounts: 1,
      dispatchBudget: 24,
      recommendedHeadroom: 3,
    });
    expect(clamp).toMatchObject({ requestedOpenCount: 3, openCount: 3, clamped: false, healthyAccounts: 1 });
    expect(clamp?.reason).toMatch(/accounts do NOT cap sessions/);
  });

  it('still clamps when the bee-tier dispatchBudget is the genuine limit', () => {
    // A REAL capacity limit (only 1 free admission slot) still clamps — this is legitimate,
    // unlike the account-count clamp above.
    expect(
      clampFleetTopUpToCapacity(3, {
        reachable: true,
        healthyAccounts: 5,
        dispatchBudget: 1,
        recommendedHeadroom: 3,
      }),
    ).toMatchObject({ requestedOpenCount: 3, openCount: 1, clamped: true });
  });

  it('suppresses a GATEWAY-routed top-up entirely when ZERO pool accounts are routable (no credential to authenticate)', () => {
    // healthyAccounts=0 is the one account signal that IS a gate — but only for gateway-routed
    // members (the conservative default when opts are omitted): no routable pool account means
    // no valid gateway credential, so nothing could authenticate — open 0 even if slots look free.
    expect(
      clampFleetTopUpToCapacity(3, {
        reachable: true,
        healthyAccounts: 0,
        dispatchBudget: 24,
        recommendedHeadroom: 3,
      }),
    ).toMatchObject({ requestedOpenCount: 3, openCount: 0, clamped: true });
    expect(
      clampFleetTopUpToCapacity(
        3,
        { reachable: true, healthyAccounts: 0, dispatchBudget: 24, recommendedHeadroom: 3 },
        { gatewayRouted: true },
      ),
    ).toMatchObject({ openCount: 0, clamped: true });
  });

  it('does NOT zero-gate a DIRECT-credential launch on an exhausted pool (the walled-pool canary incident, 2026-07-09)', () => {
    // The live incident: a 1-member canary on the DEFAULT system account (gateway skipped) was
    // clamped 1→0 because every POOL account was usage-walled — but a default-routed member
    // never asks the gateway to authenticate, so pool health must not gate it; dispatchBudget
    // remains the only hard cap.
    const clamp = clampFleetTopUpToCapacity(
      1,
      { reachable: true, healthyAccounts: 0, dispatchBudget: 13, recommendedHeadroom: 1 },
      { gatewayRouted: false },
    );
    expect(clamp).toMatchObject({ requestedOpenCount: 1, openCount: 1, clamped: false, healthyAccounts: 0 });
    expect(clamp?.reason).toMatch(/direct system credential/);
  });

  // ── ADVISORY CLAMP + OVERRIDE (owner directive 2026-07-09) ───────────────────────────────────
  // "when the inference gateway clamps it should just be a recommendation, agents should be able to
  // override". `override` is OPT-IN, so every default-path test above is byte-identical (that is the
  // point: the EI-8797 gatewayRouted semantics survive untouched).

  it('override launches ALL requested members through a zero-healthyAccounts gate, and SAYS it overrode', () => {
    // The exact live 2026-07-09 condition: healthyAccounts:0 from a STALE in-memory exhaustion while
    // dispatchBudget shows free slots. Without override this suppresses to 0 (test above).
    const clamp = clampFleetTopUpToCapacity(
      3,
      { reachable: true, healthyAccounts: 0, dispatchBudget: 24, recommendedHeadroom: 3 },
      { gatewayRouted: true, override: true },
    );
    expect(clamp).toMatchObject({
      requestedOpenCount: 3,
      openCount: 3,
      clamped: false,
      overridden: true,
      recommendedOpenCount: 0,
    });
    // The recommendation must remain legible — an override is never silent.
    expect(clamp?.reason).toMatch(/OVERRIDDEN/);
    expect(clamp?.reason).toMatch(/accounts:probe-capacity/);
  });

  it('override lifts a dispatchBudget concurrency clamp too', () => {
    const clamp = clampFleetTopUpToCapacity(
      6,
      { reachable: true, healthyAccounts: 4, dispatchBudget: 2, recommendedHeadroom: 6 },
      { override: true },
    );
    expect(clamp).toMatchObject({ openCount: 6, clamped: false, overridden: true, recommendedOpenCount: 2 });
  });

  it('override on an UNCONSTRAINED pool reports overridden:false — nothing was actually overridden', () => {
    const clamp = clampFleetTopUpToCapacity(
      2,
      { reachable: true, healthyAccounts: 4, dispatchBudget: 24, recommendedHeadroom: 2 },
      { override: true },
    );
    expect(clamp).toMatchObject({ openCount: 2, clamped: false, overridden: false, recommendedOpenCount: 2 });
    expect(clamp?.reason).not.toMatch(/OVERRIDDEN/);
  });

  it('WITHOUT override the clamp still binds, and the reason advertises the escape hatch', () => {
    const clamp = clampFleetTopUpToCapacity(3, {
      reachable: true,
      healthyAccounts: 0,
      dispatchBudget: 24,
      recommendedHeadroom: 3,
    });
    expect(clamp).toMatchObject({ openCount: 0, clamped: true, overridden: false, recommendedOpenCount: 0 });
    expect(clamp?.reason).toMatch(/pass override/);
  });

  it('recommendedOpenCount is reported on the happy path too (always legible)', () => {
    const clamp = clampFleetTopUpToCapacity(2, {
      reachable: true,
      healthyAccounts: 4,
      dispatchBudget: 24,
      recommendedHeadroom: 2,
    });
    expect(clamp).toMatchObject({ openCount: 2, recommendedOpenCount: 2, overridden: false });
  });

  it('fails open when the gateway headroom report is unreachable', () => {
    expect(
      clampFleetTopUpToCapacity(4, {
        reachable: false,
        healthyAccounts: null,
        dispatchBudget: null,
        recommendedHeadroom: null,
      }),
    ).toBeNull();
  });
});

// #4 (fleet-launch-plan-scoped-claim-spec, 2026-07-08): the pure builder that keeps every member's
// get_next self-pull on THIS plan (`plan = <slug>`, optionally AND kind ∈ kinds). The shape must
// satisfy the REAL validateClaimSpec, so it's exercised through it below.
describe('buildFleetPlanClaimSpec (#4 — plan-scoped fleet claim spec)', () => {
  it('bare plan leaf when no kinds are given', () => {
    const spec = buildFleetPlanClaimSpec('atlas-fleet', 'build-x');
    expect(spec).toMatchObject({
      specVersion: '1.0',
      revision: 1,
      view: { filter: { field: 'plan', op: '=', value: 'build-x' } },
    });
    expect(spec.specId).toBe('fleet-launch-atlas-fleet-plan');
  });

  it('combines plan AND kind into an `all` node when kinds are given', () => {
    const spec = buildFleetPlanClaimSpec('atlas-fleet', 'build-x', ['bug', 'change']);
    expect((spec.view as { filter: unknown }).filter).toEqual({
      all: [
        { field: 'plan', op: '=', value: 'build-x' },
        { field: 'kind', op: 'in', value: ['bug', 'change'] },
      ],
    });
  });

  it('names the fleet in specId so specs for different fleets never collide', () => {
    expect(buildFleetPlanClaimSpec('a', 'p').specId).not.toBe(buildFleetPlanClaimSpec('b', 'p').specId);
  });

  it('produces a spec that PASSES the real validateClaimSpec (both bare + combined)', () => {
    // Load-bearing: a malformed filter shape would validate here but silently filter out ALL
    // items at runtime (members get nothing) — so exercise the actual validator, not just the shape.
    expect(validateClaimSpec(buildFleetPlanClaimSpec('f', 'my-plan')).ok).toBe(true);
    expect(validateClaimSpec(buildFleetPlanClaimSpec('f', 'my-plan', ['bug', 'task'])).ok).toBe(true);
  });
});

// P-010: the states-for-kinds derivation that stops an issue-family drain starving on the
// default ['todo'] floor (the bug-drain-200k trap, EI-11300).
describe('claimableStatesForKinds + builder states threading (P-010)', () => {
  it('issue-family kinds → open; feature-family → undefined (unified open floor fits); mixed → [open]', () => {
    expect(claimableStatesForKinds(['bug'])).toEqual(['open']);
    expect(claimableStatesForKinds(['change', 'task'])).toEqual(['open']);
    expect(claimableStatesForKinds(['feature'])).toBeUndefined();
    expect(claimableStatesForKinds(['feature', 'chunk'])).toBeUndefined();
    // work-item-status-full-unify P-004/P-005: 'open' is the single claimable token for BOTH
    // families now, so a mixed lane pins ['open'] (was the transitional ['todo','open']).
    expect(claimableStatesForKinds(['feature', 'bug'])).toEqual(['open']);
  });

  it('buildFleetKindClaimSpec pins states:["open"] for a bugs-only drain (the trap), omits it for features', () => {
    expect((buildFleetKindClaimSpec('f', ['bug', 'change']) as { states?: string[] }).states).toEqual(['open']);
    expect((buildFleetKindClaimSpec('f', ['feature']) as { states?: string[] }).states).toBeUndefined();
    // Still a valid spec with states present.
    expect(validateClaimSpec(buildFleetKindClaimSpec('f', ['bug'])).ok).toBe(true);
  });

  it('buildFleetPlanClaimSpec pins states only for a kind-scoped plan lane, never for a bare plan lane', () => {
    expect((buildFleetPlanClaimSpec('f', 'p') as { states?: string[] }).states).toBeUndefined();
    expect((buildFleetPlanClaimSpec('f', 'p', ['bug']) as { states?: string[] }).states).toEqual(['open']);
  });

  it('mergeKindIntoClaimSpec derives states when the leader spec had none, and PRESERVES a leader-set states', () => {
    const noStates = {
      specVersion: '1.0',
      specId: 'leader-x',
      revision: 3,
      view: { filter: { field: 'priority', op: '<=', value: 2 } },
      rank: { mode: 'lexicographic' as const, terms: [{ expr: 'priority', dir: 'asc' as const }] },
    };
    expect((mergeKindIntoClaimSpec(noStates as never, ['bug']) as { states?: string[] }).states).toEqual(['open']);
    const withStates = { ...noStates, states: ['failing'] };
    expect((mergeKindIntoClaimSpec(withStates as never, ['bug']) as { states?: string[] }).states).toEqual(['failing']);
  });
});

describe('composeMemberLaunchContext / renderMemberBaseline', () => {
  it('renders the universal baseline with every rule headline + the fleet/plan context', () => {
    const md = renderMemberBaseline({ fleetSlug: 'ops', plan: 'my-plan', count: 4 });
    expect(md).toContain('one of 4 parallel worker agents in fleet `ops`');
    expect(md).toContain('working plan `my-plan`');
    for (const r of MEMBER_BASELINE_RULES) expect(md).toContain(r.head);
    // the load-bearing rules the whole feature exists for
    expect(md).toContain('Already-fixed check FIRST');
    expect(md).toContain('Flag to your LEADER');
    expect(md).toContain('Do not re-claim a ping-ponging item');
    expect(md).toContain('assumptions: "none"');
    // queen-fleet-authority-boundary P-006: a hive pause ≠ a self-drain order
    expect(md).toContain('A hive pause is a Mug-loop signal, not a self-drain order');
    expect(md).toContain('fleet-leader(<other>)→fleet-members');
    // su-loop-capability-parity P-011: turn-end reflection + reporting integrity
    expect(md).toContain('Turn-end reflection + reporting integrity');
    expect(md).toContain('a routine turn records NOTHING');
    expect(md).toContain('a truthful `blocked` beats a fabricated all-clear');
    // su-loop-capability-parity P-012: member carry-note checkpoint
    expect(md).toContain('Carry-note checkpoint at every boundary');
    expect(md).toContain('work_items:checkpoint');
  });

  it('P-001: members PULL via scheduler:get_next (spec-driven), not claim_next, and do not self-prioritize', () => {
    const md = renderMemberBaseline({ fleetSlug: 'ops', plan: 'my-plan', count: 4 });
    // The pull tool is scheduler:get_next (the bee spec-driven self-select), and the member is
    // explicitly told NOT to use work_items:claim_next as its pull loop.
    expect(md).toContain('scheduler:get_next');
    expect(md).toContain('NOT `work_items:claim_next`');
    expect(md).toContain("scheduler:get_next { harness: '<your-harness>' }");
    expect(md).toContain('omit `specId`/`revision`');
    expect(md).toContain('`claimedUnder`');
    // The bee pull-discipline: leader steers WHICH item via the claim-spec; pickup is the member's;
    // no self-prioritizing by scanning the raw frontier.
    expect(md).toContain('scheduler:set_claim_spec');
    expect(md).toMatch(/PICKUP is yours|blackboard/);
    expect(md).toMatch(/Do NOT self-prioritize by scanning `work_items:list`/);
    // The member's pull LOOP line must not still tell it to claim via claim_next (the swap is real,
    // not additive) — the only claim_next mention left is the "do NOT use it" contrast.
    expect(md).not.toMatch(/\*\*claim\*\* the highest-priority[^\n]*work_items:claim_next/);
  });

  it('singularizes the worker count for a 1-member fleet', () => {
    const md = renderMemberBaseline({ fleetSlug: 'f', plan: 'p', count: 1 });
    expect(md).toContain('one of 1 parallel worker agent in fleet');
    expect(md).not.toContain('worker agents');
  });

  it('returns the baseline alone when no custom brief is given', () => {
    const md = composeMemberLaunchContext({ fleetSlug: 'f', plan: 'p', count: 2 });
    expect(md).toContain('# Fleet member — operating baseline');
    expect(md).not.toContain('Fleet-specific brief');
  });

  it('layers the leader brief BELOW the baseline (brief wins on specifics)', () => {
    const md = composeMemberLaunchContext({
      fleetSlug: 'f',
      plan: 'p',
      count: 2,
      customBriefText: 'CUSTOM DRAIN RULES for this fleet',
    });
    const baselineIdx = md.indexOf('# Fleet member — operating baseline');
    const sepIdx = md.indexOf('Fleet-specific brief');
    const briefIdx = md.indexOf('CUSTOM DRAIN RULES for this fleet');
    expect(baselineIdx).toBeGreaterThanOrEqual(0);
    expect(sepIdx).toBeGreaterThan(baselineIdx); // the brief section comes after the baseline
    expect(briefIdx).toBeGreaterThan(sepIdx);
  });

  it('appends the immutable lineage guard after a misleading reviewer brief', () => {
    const md = composeMemberLaunchContext({
      fleetSlug: 'f',
      plan: 'p',
      count: 1,
      customBriefText: 'You are the non-lineage independent reviewer for this rubric.',
    });
    const briefIdx = md.indexOf('You are the non-lineage independent reviewer');
    const guardIdx = md.indexOf(IMMUTABLE_MEMBER_LAUNCH_LINEAGE_GUARD);
    expect(briefIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeGreaterThan(briefIdx);
    expect(md.slice(guardIdx)).toContain('does NOT make this session lineage-independent');
    expect(md.slice(guardIdx)).toContain('scorecards:evaluate');
    expect(md.slice(guardIdx)).toContain('grader_in_implementer_lineage');
    expect(md.slice(guardIdx)).toContain('explicit `assign_to`');
  });

  it('ignores an empty / whitespace custom brief (baseline only)', () => {
    const md = composeMemberLaunchContext({ fleetSlug: 'f', plan: 'p', count: 1, customBriefText: '   \n' });
    expect(md).not.toContain('Fleet-specific brief');
  });
});

// su-loop-capability-parity-2026-07-03 P-002: the leader STEERS members by claim-spec
// (property filters, not id-pins) and OWNS driving the plan to done through the fleet.
describe("LEADER_STANDING_JOB — steer-don't-dispatch + completion mandate (P-002)", () => {
  const steer = LEADER_STANDING_JOB.find((p) => p.includes('scheduler:set_claim_spec'));

  it('has a steer-via-claim-spec point that names set_claim_spec + a PROPERTY filter, not id-pins', () => {
    expect(steer, 'a LEADER_STANDING_JOB point must steer via scheduler:set_claim_spec').toBeTruthy();
    expect(steer).toContain('scheduler:set_claim_spec');
    expect(steer).toMatch(/PROPERTY FILTER/i);
    // Explicitly warns off id-pins for standing lanes (the observed micro-dispatch anti-pattern).
    expect(steer).toMatch(/NEVER id-pins|id-pins for a standing lane/);
    // Re-steer by bumping the spec, not by hand-assigning each item.
    expect(steer).toMatch(/bumping its spec|next pull/);
  });

  it('carries the completion mandate — the leader owns driving the plan to done THROUGH the fleet', () => {
    const mandate = LEADER_STANDING_JOB.find((p) => /drive|driving the plan to done|OWN/i.test(p));
    expect(mandate, 'a LEADER_STANDING_JOB point must assert the leader owns completion').toBeTruthy();
    expect(steer).toMatch(/OWN driving the plan to done THROUGH the fleet/);
    // Guards the observed failure: silently falling back to solo work when members die/close.
    expect(steer).toMatch(/do NOT quietly fall back to doing the work solo/i);
  });

  it('members pull the item the leader steered — the two halves reference the SAME scheduler pair', () => {
    // P-001 member side pulls via scheduler:get_next; P-002 leader side steers via
    // scheduler:set_claim_spec. The pair must be internally consistent (the plan's control boundary).
    const memberMd = renderMemberBaseline({ fleetSlug: 'ops', plan: 'my-plan', count: 4 });
    expect(memberMd).toContain('scheduler:get_next');
    expect(memberMd).toContain('scheduler:set_claim_spec');
    expect(LEADER_STANDING_JOB.some((p) => p.includes('scheduler:set_claim_spec'))).toBe(true);
  });
});

// Leadership auto-enters AUTO mode (owner directive 2026-07-03): the launch RESULT is the
// moment the caller becomes a leader, so the directive rides the result — an AUTO-off leader
// parks at its ask-first posture while its fleet runs unsupervised (the ornith 9980 run).
describe('LEADER_AUTO_MODE_DIRECTIVE — leading a fleet auto-enters AUTO mode', () => {
  it("declares AUTO mode ON now, for the rest of the session — act-don't-ask", () => {
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/AUTO MODE/);
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/effective NOW/i);
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/rest of your session/i);
    // The concrete behavioural bind: never park waiting while the fleet is live.
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/NEVER end a turn waiting/i);
    // Disclosure, not a permission ask.
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/notice, not a question/i);
  });

  it("leads INTO the standing-job list (it renders as that list's header line)", () => {
    expect(LEADER_AUTO_MODE_DIRECTIVE).toMatch(/standing job each cycle:$/);
  });
});

// su-loop-capability-parity-2026-07-03 P-013: prompt-bloat budget. The Ph1/2/4 ports stacked
// onto the member baseline + leader standing-job, and context-blow is the plan's own named #1
// leader failure. D-002 guards DRIFT; these guard BLOAT — a char ceiling so neither block can
// silently balloon in future. Budgets are current size + modest headroom (~1 more rule/point);
// exceeding one is the signal to prune or move detail behind a referenced doc, not to bump it.
describe('prompt-bloat budget (P-013)', () => {
  it('MEMBER_BASELINE_RULES stays within the char budget', () => {
    const chars = MEMBER_BASELINE_RULES.reduce((a, r) => a + r.head.length + r.body.length, 0);
    expect(chars, `member baseline rule chars = ${chars}`).toBeLessThan(3800);
  });

  it('the rendered member baseline stays within the char budget', () => {
    const md = renderMemberBaseline({ fleetSlug: 'ops', plan: 'my-plan', count: 4 });
    expect(md.length, `renderMemberBaseline chars = ${md.length}`).toBeLessThan(4400);
  });

  it('LEADER_STANDING_JOB stays within the char budget', () => {
    const chars = LEADER_STANDING_JOB.reduce((a, p) => a + p.length, 0);
    expect(chars, `leader standing-job chars = ${chars}`).toBeLessThan(3800);
  });

  it('each leader standing-job entry carries NO leading number (numbering is render-applied)', () => {
    for (const p of LEADER_STANDING_JOB) expect(p).not.toMatch(/^\s*\d+\./);
  });
});

// P-006 start gate (EI-19310192267009629). The gate shipped with NO test exercising
// its refusal path, which is exactly why a defect in it went unnoticed until it red
// the release gate. These two pin the behaviour that was missing:
//   1. an under-specified plan is REFUSED before any terminal opens, and
//   2. that refusal is reported AS a start-gate refusal — not relabelled
//      "Could not resolve plan", which is what happened while the gate ran inside
//      the resolution try/catch and is what sent readers after the database.
describe('fleet:launch-on-plan handler — P-006 start gate', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
  });

  it('refuses an under-specified plan, names the missing input, and opens NO member terminal', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    readPlanBySlugMock.mockResolvedValueOnce({
      slug: 'my-plan',
      parsed: { items: [] },
      archived: false,
      row: {
        planSlug: 'my-plan',
        template: null,
        inputSchema: { type: 'object', required: ['target'], properties: { target: { type: 'string' } } },
        templateData: null,
      },
    });

    const res = await invokeLaunchHandler(
      { name: 'Alpha Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    // Refusals from this handler are plain text via err(), not JSON via json().
    expect((res as any).isError).toBe(true);
    const text = (res as any).content[0].text as string;
    expect(text).toMatch(/cannot start/);
    expect(text).toMatch(/target/);
    // The whole point of gating HERE is that no member is launched onto a plan
    // that has no target — N dead sessions for one missing argument.
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('blames the START GATE when the gate itself throws — never "Could not resolve plan"', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    // A row shape the gate cannot process: template must be a string, so
    // planSchemaSource's `template?.trim()` throws a TypeError. This is the
    // exact shape of the original defect — a row field the gate assumed.
    readPlanBySlugMock.mockResolvedValueOnce({
      slug: 'my-plan',
      parsed: { items: [] },
      archived: false,
      row: { planSlug: 'my-plan', template: 42, inputSchema: null, templateData: null },
    });

    const res = await invokeLaunchHandler(
      { name: 'Alpha Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const text = (res as any).content[0].text as string;
    expect((res as any).isError).toBe(true);
    // The regression: while the gate ran inside the resolution try/catch, this
    // TypeError was relabelled "Could not resolve plan ..." — a false claim
    // about the plan store that sends every reader after the database.
    expect(text).not.toMatch(/Could not resolve/);
    expect(text).toMatch(/start gate/i);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });
});

describe('fleet:launch-on-plan handler — member baseline wiring', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
  });

  it('composes the member baseline and threads its path into every member command', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const res = await invokeLaunchHandler(
      { name: 'Alpha Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    // The leader always learns, structurally, what members were told.
    expect(payload.memberBaselineHeadlines).toHaveLength(MEMBER_BASELINE_RULES.length);
    expect(payload.memberBaselineHeadlines).toContain('Already-fixed check FIRST');
    expect(typeof payload.memberBaselineApplied).toBe('boolean');
    // su-loop-capability-parity P-010: leader reads the curated fleet feed + nudge hygiene.
    expect(payload.message).toContain('curation:feed');
    expect(payload.message).toMatch(/nudge that fails to land twice is an ESCALATION/);
    // su-loop-capability-parity P-012 (leader side): park with carry-notes, not prose.
    expect(payload.message).toContain('work_items:checkpoint');
    expect(payload.message).toMatch(/plans:set-now/);
    // su-loop-capability-parity P-006: wave-close fleet-execution-health scorecard.
    expect(payload.message).toContain('fleet-execution-health');
    expect(payload.message).toContain('observation:{ rubricRef:"fleet-execution-health", ratings }');
    expect(payload.message).toMatch(/per-WAVE, never per-turn/);
    // On a writable tmp the compose lands and its path threads into psu's --launch-context.
    if (payload.memberBaselineApplied) {
      expect(payload.memberLaunchContextPath).toContain('fleet-alpha-fleet-launch-context.md');
      const fs = require('node:fs');
      const composed = fs.readFileSync(payload.memberLaunchContextPath, 'utf8');
      // Fleet carry defaults warm independently of headless; make it explicit so
      // loop:arm's headless omitted-carry default cannot silently override it.
      expect(composed).toContain("`loop:arm { intervalSec, goal, carry: 'warm' }`");
      const firstGreeting = spawnConsoleMock.mock.calls[0][0].envelope.greetingCmd as string;
      expect(firstGreeting).toContain('--launch-context=');
      expect(firstGreeting).toContain('fleet-alpha-fleet-launch-context.md');
      // EI-20222088167233986: no explicit `workspace` arg was supplied above,
      // but the handler resolved ws-1 from its caller scope. The command must
      // carry that resolved value rather than inheriting the operator's
      // process-level workspace (often `default`) across warm wakes.
      expect(firstGreeting).toContain('--workspace=ws-1');
    }
  });

  // EI-19276371920501216: passing actual brief TEXT (not a path) as `launchContext`
  // used to die inside readFileSync with ENAMETOOLONG, silently dropping the brief
  // for every member while the launch still reported ok:true. It must now compose
  // straight into the generated baseline file instead.
  it('EI-19276371920501216: composes MULTI-LINE launchContext TEXT into the baseline file — no ENAMETOOLONG, no briefReadError', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const briefText = 'MISSION: full drain of the non-P2P backlog.\nDo NOT touch WI-1234 — a peer owns it.';
    const res = await invokeLaunchHandler(
      { name: 'Text Brief Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, launchContext: briefText } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.briefReadError).toBeNull();
    expect(payload.opened).toHaveLength(1);
    expect(payload.memberBaselineApplied).toBe(true);
    expect(payload.memberLaunchContextPath).toContain('fleet-text-brief-fleet-launch-context.md');
    const fs = require('node:fs');
    const composed = fs.readFileSync(payload.memberLaunchContextPath, 'utf8');
    expect(composed).toContain('MISSION: full drain of the non-P2P backlog.');
    expect(composed).toContain('Do NOT touch WI-1234 — a peer owns it.');
    // The durable fresh-fleet recipe must carry the same canonical file path
    // handed to psu, never the inline prose that would kill a later refill.
    const persisted = setFleetHeadcountTargetMock.mock.calls.at(-1)?.[0] as {
      config?: { launchContext?: string };
    };
    expect(persisted.config?.launchContext).toBe(payload.memberLaunchContextPath);
    expect(persisted.config?.launchContext).not.toBe(briefText);
    expect(fs.readFileSync(persisted.config!.launchContext!, 'utf8')).toContain('MISSION: full drain');
    // The path actually handed to psu is the WRITTEN file, never the raw brief text.
    const firstGreeting = spawnConsoleMock.mock.calls[0][0].envelope.greetingCmd as string;
    expect(firstGreeting).toContain('--launch-context=');
    expect(firstGreeting).not.toContain('MISSION:');
  });

  // Regression safety: a genuine (short, single-line) path that just happens not to
  // exist must still be treated as a path and must refuse before any irreversible
  // terminal spawn — the fix must not swallow real path-read failures.
  it('a short single-line nonexistent PATH refuses before opening any terminal', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const res = await invokeLaunchHandler(
      {
        name: 'Missing Brief Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        launchContext: '/tmp/fleet-launch-ctx-test/does-not-exist-brief.md',
      } as never,
      {} as never,
    );
    expect((res as any).isError).toBe(true);
    expect((res as any).content[0].text).toMatch(/Could not read launchContext/);
    expect((res as any).content[0].text).toMatch(/No members were opened/);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });
});

describe('fleet:launch-on-plan handler — EI-8985 per-member launch-context briefs', () => {
  const tmpDir = '/tmp/fleet-launch-ctx-test-per-member';

  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    const fs = require('node:fs');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(`${tmpDir}/member-1.md`, 'You specifically own the auth migration.');
    fs.writeFileSync(`${tmpDir}/member-2.md`, 'You specifically own the UI polish pass.');
  });

  it('gives each listed member its OWN composed context, index-aligned', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await invokeLaunchHandler(
      {
        name: 'Per-Member Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        perMemberLaunchContext: [`${tmpDir}/member-1.md`, `${tmpDir}/member-2.md`],
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.perMemberLaunchContextPaths).toHaveLength(2);
    expect(payload.perMemberLaunchContextPaths[0]).toContain('launch-context-member-1.md');
    expect(payload.perMemberLaunchContextPaths[1]).toContain('launch-context-member-2.md');
    // Two DISTINCT --launch-context flags were threaded, one per member.
    const cmd1 = spawnConsoleMock.mock.calls[0][0].envelope.greetingCmd as string;
    const cmd2 = spawnConsoleMock.mock.calls[1][0].envelope.greetingCmd as string;
    expect(cmd1).not.toEqual(cmd2);
    expect(cmd1).toContain('launch-context-member-1.md');
    expect(cmd2).toContain('launch-context-member-2.md');
    // Each composed file actually carries ITS OWN member's brief text.
    const fs = require('node:fs');
    const composed1 = fs.readFileSync(payload.perMemberLaunchContextPaths[0], 'utf8');
    const composed2 = fs.readFileSync(payload.perMemberLaunchContextPaths[1], 'utf8');
    expect(composed1).toContain('You specifically own the auth migration.');
    expect(composed1).not.toContain('UI polish pass');
    expect(composed2).toContain('You specifically own the UI polish pass.');
    expect(composed2).not.toContain('auth migration');
  });

  // per-member-declarative-launch-specs P-002: `members[]` generalizes the
  // brief-only per-member path above to EVERY setting.
  it('gives each members[i] its own model/account, falling back to the fleet arg when unset', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await invokeLaunchHandler(
      {
        name: 'Per-Member Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 3,
        model: 'sonnet',
        members: [
          { model: 'opus[1m]', effort: 'high' },
          { account: 'auto' },
          // member 3 omitted entirely -> pure fleet-wide fallthrough
        ],
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    const cmd = (i: number) => spawnConsoleMock.mock.calls[i][0].envelope.greetingCmd as string;
    expect(payload.modelResolution).toBeNull();
    expect(payload.memberModelResolutions).toMatchObject([
      { requested: 'opus[1m]', agent: 'claude', model: 'opus[1m]:high', effort: 'high' },
      { requested: 'sonnet', agent: 'claude', model: 'sonnet', effort: null },
      { requested: 'sonnet', agent: 'claude', model: 'sonnet', effort: null },
    ]);
    // Member 1: its own model, with effort folded ONTO the spec (psu has no --effort).
    expect(cmd(0)).toContain("--model='opus[1m]:high'");
    expect(cmd(0)).not.toContain('--effort');
    // Member 2: inherits the fleet model, overrides only the account.
    expect(cmd(1)).toContain('--model=sonnet');
    expect(cmd(1)).toContain('--account=auto');
    // Member 3: no spec at all -> the flat fleet-wide args, unchanged.
    expect(cmd(2)).toContain('--model=sonnet');
  });

  it('composes members[i].brief inline text into that member OWN context file', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await invokeLaunchHandler(
      {
        name: 'Per-Member Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        members: [{ brief: 'You own the flaky-test triage lane.' }, {}],
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    const fs = require('node:fs');
    const composed = fs.readFileSync(payload.perMemberLaunchContextPaths[0], 'utf8');
    expect(composed).toContain('You own the flaky-test triage lane.');
  });

  it('falls back to the shared baseline for members BEYOND the perMemberLaunchContext array — never errors', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await invokeLaunchHandler(
      {
        name: 'Partial Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 3,
        perMemberLaunchContext: [`${tmpDir}/member-1.md`],
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.perMemberLaunchContextPaths).toHaveLength(3);
    expect(payload.perMemberLaunchContextPaths[0]).toContain('launch-context-member-1.md');
    // members 2 and 3 wrote their OWN composed file too (baseline-only, no custom brief).
    expect(payload.perMemberLaunchContextPaths[1]).toContain('launch-context-member-2.md');
    expect(payload.perMemberLaunchContextPaths[2]).toContain('launch-context-member-3.md');
    const fs = require('node:fs');
    const composed2 = fs.readFileSync(payload.perMemberLaunchContextPaths[1], 'utf8');
    expect(composed2).not.toContain('auth migration');
    expect(composed2).not.toContain('UI polish pass');
  });

  it('a per-member unreadable file refuses before opening any terminal', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await invokeLaunchHandler(
      {
        name: 'Resilient Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        perMemberLaunchContext: [`${tmpDir}/does-not-exist.md`, `${tmpDir}/member-2.md`],
      } as never,
      {} as never,
    );
    expect((res as any).isError).toBe(true);
    expect((res as any).content[0].text).toMatch(/member 1:.*could not read/);
    expect((res as any).content[0].text).toMatch(/No members were opened/);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('a members[i].launchContext path is preflighted and refuses before opening any terminal', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 101 });
    const res = await invokeLaunchHandler(
      {
        name: 'Declarative Brief Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        members: [{ launchContext: `${tmpDir}/does-not-exist.md` }],
      } as never,
      {} as never,
    );
    expect((res as any).isError).toBe(true);
    expect((res as any).content[0].text).toMatch(/members\[0\]\.launchContext/);
    expect((res as any).content[0].text).toMatch(/No members were opened/);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });
});

// per-member-declarative-launch-specs P-004: reject an incoherent MemberSpec, and
// echo the resolved per-member config so the leader confirms what each member got.
describe('fleet:launch-on-plan handler — P-004 validation + per-member disclosure', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
  });

  it('rejects launch-from-seats + a per-member model/effort/account (contradicts the delegated slot)', async () => {
    for (const bad of [{ model: 'opus' }, { effort: 'high' }, { account: 'auto' }]) {
      const res = await invokeLaunchHandler(
        {
          name: 'Seat Fleet',
          plan: 'my-plan',
          harness: 'papercusp',
          count: 1,
          fromSeats: true,
          members: [bad],
        } as never,
        {} as never,
      );
      // A rejection is the plain-text `err()` shape (isError:true), not a JSON payload.
      expect((res as any).isError).toBe(true);
      const text = (res as any).content[0].text as string;
      expect(text).toMatch(/launch-from-seats derives model\+effort\+account/);
      expect(text).toContain('members[0]');
      // No terminals were opened — the launch failed clean, before any spawn.
      expect(spawnConsoleMock).not.toHaveBeenCalled();
    }
  });

  it("REMOTE_PLACEMENT_UNSUPPORTED_ARGS refuses `members` (the host owns each member's model/account/window)", () => {
    expect(remotePlacementUnsupportedArgs({ members: [{}] })).toContain('members');
    // A launch with no per-member spec is unaffected.
    expect(remotePlacementUnsupportedArgs({ plan: 'p', count: 2 })).not.toContain('members');
  });

  it('HONORS a per-member carry override — member 1 gets a COLD baseline, member 2 the fleet-wide WARM', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await invokeLaunchHandler(
      {
        name: 'Carry Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        carry: 'warm',
        members: [{ carry: 'cold' }, {}],
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    // Each member wrote its OWN composed context (the carry override forces the per-member path).
    expect(payload.perMemberLaunchContextPaths).toHaveLength(2);
    const fs = require('node:fs');
    const composed1 = fs.readFileSync(payload.perMemberLaunchContextPaths[0], 'utf8');
    const composed2 = fs.readFileSync(payload.perMemberLaunchContextPaths[1], 'utf8');
    // Member 1's baseline arms a COLD loop; member 2 falls through to the fleet-wide WARM.
    expect(composed1).toContain("carry: 'cold'");
    expect(composed2).not.toContain("carry: 'cold'");
  });

  it('echoes resolvedMembers (model/account/carry/compactionLimit/claimKinds) so the leader confirms each member', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await invokeLaunchHandler(
      {
        name: 'Echo Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        model: 'sonnet',
        carry: 'warm',
        members: [{ model: 'opus[1m]', effort: 'high', carry: 'cold', compactionLimit: 300000 }, {}],
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.resolvedMembers).toHaveLength(2);
    // Member 1: its own model (effort folded), carry, and limit.
    expect(payload.resolvedMembers[0]).toMatchObject({
      member: 1,
      model: 'opus[1m]:high',
      carry: 'cold',
      compactionLimit: 300000,
    });
    // Member 2: pure fleet-wide fallthrough.
    expect(payload.resolvedMembers[1]).toMatchObject({ member: 2, model: 'sonnet', carry: 'warm' });
    // The human-facing message carries the per-member table too.
    expect(payload.message).toContain('per-member resolved config');
    expect(payload.message).toMatch(/carry=cold/);
  });

  it('resolvedMembers is null for a homogeneous (no-`members`) launch — no needless breakdown', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const res = await invokeLaunchHandler(
      { name: 'Plain Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.resolvedMembers).toBeNull();
  });

  it('WARNS that a per-member claimKinds is not applied at launch (only the fleet claim spec is)', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => ({ status: 'ok', terminal: `term-${++call}`, pid: 100 + call }));
    const res = await invokeLaunchHandler(
      {
        name: 'Lane Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 2,
        members: [{ claimKinds: ['bug'] }, {}],
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.message).toMatch(/per-member `claimKinds` is NOT applied at launch/);
    expect(payload.message).toContain('scheduler:set_claim_spec');
  });
});

describe('fleet:launch-on-plan handler — EI-8289 display disclosure', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
  });

  it('reports the resolved DISPLAY inline per opened member terminal', async () => {
    spawnConsoleMock.mockReturnValue({
      status: 'ok',
      terminal: 'term-1',
      pid: 123,
      display: ':1',
      desktopEnvResolvedVia: 'active-seat',
    });
    const res = await invokeLaunchHandler(
      { name: 'Display Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.message).toContain('[DISPLAY=:1]');
    expect(payload.message).not.toMatch(/⚠.*socket scan/);
  });

  it('warns loudly when a member landed via a raw socket scan (possible virtual/sandbox placement, EI-8289)', async () => {
    spawnConsoleMock.mockReturnValue({
      status: 'ok',
      terminal: 'term-1',
      pid: 123,
      display: ':93',
      desktopEnvResolvedVia: 'socket-scan',
    });
    const res = await invokeLaunchHandler(
      { name: 'Xvfb Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.message).toContain('[DISPLAY=:93]');
    expect(payload.message).toMatch(/⚠ no active login seat was detected.*socket scan.*EI-8289/);
  });
});

// WI-4752: repro'd live 2026-07-13 — a canary-first visible fleet launch reported
// opened:[{terminal:'gnome-terminal', pid:...}] + ok:true while BOTH launch PIDs had
// already exited (a stale DBUS_SESSION_BUS_ADDRESS ⇒ ServiceUnknown ⇒ StartServiceByName
// timeout). The underlying primitive fix (session-bus resolution + the early-exit probe,
// console-spawn.ts/console-spawn-desktop-env.test.ts) already covers spawnConsole itself;
// this pins the FLEET-TOOL-LEVEL contract the bug report actually named — every
// non-'ok' spawnConsole result must land in `failed[]`, never be counted as `opened`.
describe('fleet:launch-on-plan handler — spawn failures surface failed[], never a false opened receipt (WI-4752)', () => {
  beforeEach(async () => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    const { releaseFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (releaseFleetLaunchSlot as ReturnType<typeof vi.fn>).mockReset();
    (releaseFleetLaunchSlot as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('a canary spawn failure opens no cohort and reports the one attempted failure', async () => {
    spawnConsoleMock.mockReturnValue({
      status: 'error',
      error:
        'gnome-terminal died killed by SIGSEGV within 1200ms — no window opened: stale specified server ' +
        'org.freedesktop.DBus ServiceUnknown (:1.113), fallback StartServiceByName org.gnome.Terminal timed out',
      code: 502,
    });
    const res = await invokeLaunchHandler(
      { name: 'DBus Fail Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    // NOT true: `ok` mirrors `opened.length > 0` on this actual-spawn-attempted path
    // (launch-on-plan.ts's final `return json({ ok: opened.length > 0, ... })`) — that's
    // distinct from the early-return "suppressed" paths (relaunchSuppressed/capacitySuppressed)
    // which hardcode ok:true because THOSE are benign no-ops (nothing was attempted). Here every
    // spawn WAS attempted and genuinely failed, so ok:false is the correct, honest signal — the
    // WI-4752 contract is about opened[]/failed[] never lying, not about `ok` staying true.
    expect(payload.ok).toBe(false);
    expect(payload.opened).toEqual([]);
    expect(payload.failed).toHaveLength(1);
    expect(payload.failed[0].error).toMatch(/ServiceUnknown/);
    expect(payload.failed[0].code).toBe(502);
  });

  it('records a governed admission rejection as a member failure and finalizes the partial wave', async () => {
    // Admission can fail before spawnConsole returns any SpawnConsoleResult. The
    // rejection must still occupy the attempted member's slot so the transaction
    // is durable and the remaining cohort is eligible for a later retry.
    spawnGovernedAgentProcessMock.mockRejectedValueOnce(
      new Error('durable admission record could not be persisted'),
    );

    const res = await invokeLaunchHandler(
      { name: 'Admission Fail Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.ok).toBe(false);
    expect(payload.opened).toEqual([]);
    expect(payload.finalGoalAdmissions).toEqual([{
      ownerId: payload.launchTransaction.requestedMemberIds[0], receiptId: null, admission: null, outcome: 'failed',
    }]);
    expect(payload.failed).toEqual([
      {
        ownerId: payload.launchTransaction.requestedMemberIds[0],
        code: 500,
        error: 'governed spawn failed: durable admission record could not be persisted',
      },
    ]);
    expect(payload.launchTransaction).toMatchObject({
      state: 'partial',
      failed: [{
        ownerId: payload.launchTransaction.requestedMemberIds[0],
        phase: 'spawn',
        reason: 'governed spawn failed: durable admission record could not be persisted',
      }],
      recovery: { retryOwnerIds: payload.launchTransaction.requestedMemberIds },
    });
    expect(payload.launchTransaction.waves).toHaveLength(1);
    expect(payload.launchTransaction.waves[0]).toMatchObject({
      state: 'partial',
      openedOwnerIds: [],
    });
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('releases the fleet-launch idempotency slot when EVERY spawn failed, so an immediate legitimate retry is not suppressed', async () => {
    spawnConsoleMock.mockReturnValue({ status: 'error', error: 'no window opened', code: 502 });
    const { releaseFleetLaunchSlot } = await import('../../../agent-fleets-store');
    await invokeLaunchHandler(
      { name: 'DBus Fail Fleet 2', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    expect(releaseFleetLaunchSlot as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('a later wave partial failure preserves verified/opened identities and exposes recovery state', async () => {
    let call = 0;
    spawnConsoleMock.mockImplementation(() => {
      call += 1;
      if (call < 3) return { status: 'ok', terminal: `term-${call}`, pid: 220 + call };
      return { status: 'error', error: 'spawn 3 failed: no window opened', code: 502 };
    });
    const res = await invokeLaunchHandler(
      { name: 'Partial DBus Fleet', plan: 'my-plan', harness: 'papercusp', count: 3 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.opened).toHaveLength(2);
    expect(payload.failed).toHaveLength(1);
    expect(payload.launchTransaction.state).toBe('partial');
    expect(payload.launchTransaction.recovery.retryOwnerIds).toHaveLength(1);
  });
});

describe('fleet:launch-on-plan handler — verified canary-first transaction (P-003 / D-001)', () => {
  beforeEach(async () => {
    spawnConsoleMock.mockReset();
    spawnHeadlessMock.mockReset();
    spawnHeadlessMock.mockImplementation(() => ({
      status: 'ok',
      terminal: `headless-${spawnHeadlessMock.mock.calls.length}`,
      pid: 200 + spawnHeadlessMock.mock.calls.length,
      taskId: `task-${spawnHeadlessMock.mock.calls.length}`,
      logPath: `/tmp/fleet-${spawnHeadlessMock.mock.calls.length}.log`,
    }));
    spawnConsoleMock.mockImplementation((_opts) => ({
      status: 'ok',
      terminal: `term-${spawnConsoleMock.mock.calls.length}`,
      pid: 100 + spawnConsoleMock.mock.calls.length,
    }));
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('opens an immediate headless plan fleet while duplicate screening is pending, without calling spawn-only evidence "work"', async () => {
    // This is the combined workflow that regressed: the owner asked for an
    // immediate headless EXISTING-PLAN fleet while its work item was still at
    // the duplicate-screening claim floor. Screening is a claim predicate, not
    // a process-launch prerequisite; the launcher must still open the member.
    const screeningNotice = admissionPendingExplanation();
    expect(screeningNotice).toContain('duplicate screening is pending for this WORK-ITEM CLAIM');
    expect(screeningNotice).toContain('does not block opening an agent or fleet process');
    expect(tool.guidance?.when).toContain('not a reason to delay opening the fleet');

    promotePlanItemsMock.mockResolvedValueOnce({ promoted: 0, skipped: 1 });
    launchTransaction.verify.mockResolvedValue({
      agentStarted: null,
      workerReady: false,
      waitedMs: 30_000,
      sessions: [],
      note: 'first turn not yet observed',
    });

    const res = await invokeLaunchHandler(
      {
        name: 'Immediate Pending Screening Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        headless: true,
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    // `ok` is the verified-readiness axis, not the process-open axis. With no
    // observed turn it must remain false even though opened[] proves the process
    // launch succeeded — asserting true here would recreate the reporting bug.
    expect(payload.ok).toBe(false);
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(payload.opened).toHaveLength(1);
    expect(payload.failed).toEqual([]);
    expect(payload.unverifiedMembers).toHaveLength(1);
    expect(payload.launchTransaction.state).toBe('partial');
    expect(payload.promotionFailsafe).toMatchObject({ ran: true, promoted: 0, skipped: 1 });
    expect(payload.launchEvidence).toEqual({
      version: 1,
      processOpened: 1,
      sessionRegistered: null,
      firstTurn: null,
      taskDisposition: { claimed: 0, noClaim: 0, unknown: 1 },
    });
    expect(payload.message).toContain('Process open alone is not proof that an agent is working.');
    expect(payload.message).not.toContain('starts working immediately');
    expect(payload.message).not.toContain('agents are working');
  });

  it('stamps the durable transaction identity into dispatch metadata', async () => {
    const metadata = vi.fn();
    const res = await invokeLaunchHandler(
      { name: 'Metadata Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      { metadata } as never,
    );
    const payload = parseHandlerPayload(res);

    expect(metadata).toHaveBeenCalledWith({
      launchOutcome: {
        fleet: 'metadata-fleet',
        transactionId: payload.launchTransaction.transactionId,
      },
    });
  });

  it('persists and launches with the exact provenance join key used by the real verifier', async () => {
    const res = await invokeLaunchHandler(
      { name: 'Provenance Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    const command = (spawnConsoleMock.mock.calls[0]?.[0] as {
      envelope?: { greetingCmd?: string };
    })?.envelope?.greetingCmd;

    expect(payload.launchTransaction.launcherOwnerId).toBe('owner-1');
    expect(command).toContain('--launched-by=owner-1');
    expect(command).toContain(`--owner-id=${payload.launchTransaction.requestedMemberIds[0]}`);
  });

  it.each(['repaired', 'outer control'])('opens no member and releases its slot when a concurrent transaction wins the initial CAS: %s', async (mode) => {
    const { releaseFleetLaunchSlot } = await import('../../../agent-fleets-store');
    const releaseSlot = releaseFleetLaunchSlot as ReturnType<typeof vi.fn>;
    releaseSlot.mockClear();
    // Wrong adapter loses the store's CAS rejection; the expected rejection
    // and zero-spawn oracle below remain literal and unchanged.
    launchTransaction.persist.mockResolvedValueOnce(mode === 'outer control' || idempotenceControl === 'initial-cas-loss');

    const res = await invokeLaunchHandler(
      { name: 'CAS Loss Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const responseText = (res as any).content[0].text as string;

    const assertRejected = () => expect((res as any).isError, 'idempotence-contract:initial-cas-loss').toBe(true);
    if (mode === 'outer control') {
      expect(() => assertRejected()).toThrowError();
      expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
      return;
    }
    assertRejected();
    expect(responseText).toContain('changed concurrently');
    expect(launchTransaction.persist).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: null,
    }));
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(releaseSlot).toHaveBeenCalledWith({ workspaceId: 'ws-1', fleetSlug: 'cas-loss-fleet', at: 1 });
  });

  it('merges typed worker attestations across verifier waves into the durable transaction', async () => {
    let verificationCall = 0;
    launchTransaction.verify.mockImplementation(async (rawArgs: unknown) => {
      const args = rawArgs as { expectedOwnerIds: string[] };
      const ownerId = args.expectedOwnerIds[0];
      const ready = verificationCall++ === 0;
      return {
        agentStarted: true,
        workerReady: ready,
        waitedMs: 1,
        sessions: [{
          advSessionId: verificationCall,
          ownerId,
          successfulCalls: 1,
          msSinceLastSignal: 1,
          hasPresence: true,
          attestationDiffs: [],
          workerAttestation: {
            version: 1 as const,
            ownerId,
            ready,
            stages: {
              agentCall: { status: 'satisfied' as const, successfulCalls: 1 },
              durableWake: ready
                ? { status: 'satisfied' as const, wakeSource: 'loop' }
                : { status: 'missing' as const, wakeSource: null },
              schedulerPull: { status: 'satisfied' as const, calls: 1, successfulCalls: 1 },
              disposition: { status: 'satisfied' as const, kind: 'no-claim' as const, reason: 'lane_drained' },
            },
            failures: ready
              ? []
              : [{
                  stage: 'durableWake' as const,
                  code: 'durable-wake-missing' as const,
                  detail: 'No durable wake.',
                }],
          },
        }],
        note: 'verified',
      };
    });

    const res = await invokeLaunchHandler(
      { name: 'Worker Attestation Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    const tx = payload.launchTransaction;

    expect(tx.workerAttestations).toHaveLength(2);
    expect(tx.workerAttestations.map((attestation: { ownerId: string }) => attestation.ownerId)).toEqual(
      tx.requestedMemberIds,
    );
    expect(tx.workerReadyMemberIds).toEqual([tx.requestedMemberIds[0]]);
    // A real agent turn is not enough for the transaction-level verified label:
    // the second member has a typed durable-wake failure, so the launch must
    // remain partial even though the legacy verifier marked both turns observed.
    expect(tx.state).toBe('partial');
    expect(tx.workerAttestations[1]).toMatchObject({
      ownerId: tx.requestedMemberIds[1],
      ready: false,
      failures: [{ code: 'durable-wake-missing' }],
    });
    expect(payload.launchEvidence).toEqual({
      version: 1,
      processOpened: 2,
      sessionRegistered: 2,
      firstTurn: true,
      taskDisposition: { claimed: 0, noClaim: 2, unknown: 0 },
    });
    expect((res as any).content[0].text).toContain(
      'Process open alone is not proof that an agent is working.',
    );
  });

  it('holds the remaining cohort until the canary takes a verified first turn', async () => {
    // EI-20437060078324174: an UNCONFIRMED first probe now earns ONE bounded
    // re-probe before the gate decision (a slow boot verifies there instead of
    // being stamped a false 502) — so the mock must stay unconfirmed TWICE for
    // the canary gate to hold.
    launchTransaction.verify
      .mockResolvedValueOnce({ agentStarted: null, waitedMs: 10_000, sessions: [], note: 'UNVERIFIED' })
      .mockResolvedValueOnce({ agentStarted: null, waitedMs: 30_000, sessions: [], note: 'UNVERIFIED' });
    const res = await invokeLaunchHandler(
      { name: 'Canary Stop Fleet', plan: 'my-plan', harness: 'papercusp', count: 5 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    // An unconfirmed canary is neither success nor a provider failure, but it must not
    // authorize opening the rest of the cohort before the first-turn signal arrives.
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(payload.ok).toBe(false);
    expect(payload.launchTransaction.state).toBe('partial');
    expect(payload.launchTransaction.verifiedMemberIds).toHaveLength(0);
    // Both bounded probes target the canary; no later wave opens on an unknown verdict.
    expect(launchTransaction.verify).toHaveBeenCalledTimes(2);
    expect(launchTransaction.verify.mock.calls.map(
      (call) => (call[0] as { expectedOwnerIds: string[] }).expectedOwnerIds.length,
    )).toEqual([1, 1]);
    // The unconfirmed canary is the THIRD state — reported as unverified, never
    // absorbed into failed[] as a 502 (that false refusal is the measured bug).
    expect(payload.launchTransaction.failed).toEqual([]);
    expect(payload.unverifiedMembers).toHaveLength(1);
    expect(payload.unverifiedMembers[0].ownerId).toBe(payload.launchTransaction.openedMemberIds[0]);
    expect(payload.launchTransaction.unconfirmedMemberIds).toEqual([payload.launchTransaction.openedMemberIds[0]]);
    expect(payload.launchTransaction.openedMemberIds).toHaveLength(1);
    expect(payload.launchTransaction.recovery.retryOwnerIds).toEqual(payload.launchTransaction.requestedMemberIds);
  });

  it('does not open later waves when the canary is quota-blocked before its first call', async () => {
    launchTransaction.verify.mockResolvedValueOnce({
      agentStarted: false,
      waitedMs: 1,
      sessions: [],
      note: '✗ QUOTA BLOCKED — first member is deferring every turn.',
    });
    const res = await invokeLaunchHandler(
      { name: 'Quota-Blocked Canary Fleet', plan: 'my-plan', harness: 'papercusp', count: 5 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    const canaryId = payload.launchTransaction.requestedMemberIds[0];

    expect(launchTransaction.verify).toHaveBeenCalledTimes(1);
    expect(launchTransaction.verify.mock.calls[0][0]).toMatchObject({ expectedOwnerIds: [canaryId] });
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(payload.launchTransaction.openedMemberIds).toEqual([canaryId]);
    expect(payload.launchTransaction.failed).toEqual([
      expect.objectContaining({ ownerId: canaryId, phase: 'verification', reason: expect.stringContaining('QUOTA BLOCKED') }),
    ]);
    expect(payload.launchTransaction.state).toBe('partial');
    expect(payload.launchTransaction.recovery.retryOwnerIds).toEqual(payload.launchTransaction.requestedMemberIds);
  });

  it('returns a durable pending handle before a slow verifier settles, then persists the detached result', async () => {
    vi.useFakeTimers();
    try {
      let resolveVerification!: (value: {
        agentStarted: boolean;
        waitedMs: number;
        sessions: never[];
        note: string;
      }) => void;
      const verification = new Promise<{
        agentStarted: boolean;
        waitedMs: number;
        sessions: never[];
        note: string;
      }>((resolve) => {
        resolveVerification = resolve;
      });
      launchTransaction.verify.mockImplementation((..._args: unknown[]) => {
        return verification;
      });

      getFleetHeadcountTargetMock.mockResolvedValueOnce({
        workspaceId: 'ws-1',
        fleetSlug: 'bounded-response-fleet',
        target: 1,
        config: {
          plan: 'my-plan',
          harness: 'papercusp',
          agent: 'claude',
          model: 'sonnet',
          headless: true,
          role: 'drain-fleet-leader',
        },
        nextAttemptAt: null,
        backoffMs: 0,
        lastError: null,
      });

      const responsePromise = invokeLaunchHandler(
        { name: 'Bounded Response Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
        {} as never,
        null,
      );
      // The handler performs several asynchronous and potentially timer-backed
      // preflight steps before it calls the verifier. Waiting on a raw promise
      // while fake time is frozen can therefore strand the very transition the
      // promise represents. vi.waitFor both yields microtasks and advances the
      // fake clock; the observable mock call proves the response race is live
      // before we advance its deadline.
      await vi.waitFor(() => expect(launchTransaction.verify).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
        interval: 10,
      });
      await vi.advanceTimersByTimeAsync(LAUNCH_RESPONSE_DEADLINE_MS);

      const response = await responsePromise;
      const payload = parseHandlerPayload(response);
      expect(payload.completionPending).toBe(true);
      expect(payload.completionHandle).toMatchObject({
        transactionId: payload.launchTransaction.transactionId,
        fleet: 'bounded-response-fleet',
        status: 'pending',
      });
      expect(payload.launchTransaction.state).toBe('launching');
      expect(payload.message).toContain('continues in the background');
      expect(payload.ignoredRoleDiagnostics).toEqual([
        {
          role: 'drain-fleet-leader',
          source: 'fleet:headcount-target',
          reason: 'goal-launch-slot-is-not-a-psu-persona',
        },
      ]);

      resolveVerification({ agentStarted: true, waitedMs: 1, sessions: [], note: 'verified' });
      await vi.waitFor(
        () => {
          const persisted = launchTransaction.persist.mock.calls.at(-1)?.[0] as
            | {
                transaction: { transactionId: string; state: string };
              }
            | undefined;
          expect(persisted?.transaction).toMatchObject({
            transactionId: payload.launchTransaction.transactionId,
            state: 'verified',
          });
        },
        {
          timeout: 5_000,
          interval: 10,
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a SLOW canary that verifies on the bounded re-probe opens the cohort (the measured EI-20437060078324174 shape)', async () => {
    // The incident: the canary registered 5.5s past the 25s window and went on to
    // claim work, while the launch reported ok:false + 502 "psu died" and never
    // opened member 2. The fix: the unconfirmed first probe earns one bounded
    // re-probe, the slow boot verifies there, and the launch proceeds normally.
    launchTransaction.verify.mockResolvedValueOnce({
      agentStarted: null,
      waitedMs: 25_000,
      sessions: [],
      note: 'UNVERIFIED',
    });
    const res = await invokeLaunchHandler(
      { name: 'Slow Canary Fleet', plan: 'my-plan', harness: 'papercusp', count: 5 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.launchTransaction.state).toBe('verified');
    expect(payload.launchTransaction.failed).toEqual([]);
    expect(payload.unverifiedMembers).toBeNull();
    expect(payload.launchTransaction.verifiedMemberIds).toHaveLength(5);
    expect(spawnConsoleMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('continues after a later fully-opened wave is only unconfirmed once the canary is verified', async () => {
    // A slow member in a later wave must not abort the pre-pinned remainder. The
    // canary gate still holds: the first wave is positively verified, the second
    // wave is unconfirmed on both bounded probes, and the final member opens.
    launchTransaction.verify
      .mockResolvedValueOnce({ agentStarted: true, waitedMs: 1, sessions: [], note: 'verified canary' })
      .mockResolvedValueOnce({ agentStarted: null, waitedMs: 25_000, sessions: [], note: 'UNVERIFIED wave' })
      .mockResolvedValueOnce({ agentStarted: null, waitedMs: 30_000, sessions: [], note: 'UNVERIFIED wave' })
      .mockResolvedValueOnce({ agentStarted: true, waitedMs: 1, sessions: [], note: 'verified final wave' });

    const res = await invokeLaunchHandler(
      { name: 'Slow Later Wave Fleet', plan: 'my-plan', harness: 'papercusp', count: 5 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    const waveSizes = launchTransaction.verify.mock.calls.map(
      (call) => (call[0] as { expectedOwnerIds: string[] }).expectedOwnerIds.length,
    );

    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(5);
    expect(waveSizes).toEqual([1, 3, 3, 1]);
    expect(payload.launchTransaction.state).toBe('partial');
    expect(payload.launchTransaction.verifiedMemberIds).toHaveLength(2);
    expect(payload.unverifiedMembers).toHaveLength(3);
    expect(payload.launchTransaction.recovery.retryOwnerIds).toHaveLength(3);
    expect(payload.failed).toEqual([]);
  });

  it('rolls out one canary then bounded waves, with exact pre-pinned identities', async () => {
    const res = await invokeLaunchHandler(
      { name: 'Bounded Wave Fleet', plan: 'my-plan', harness: 'papercusp', count: 8 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    const waveSizes = launchTransaction.verify.mock.calls.map(
      (call) => (call[0] as { expectedOwnerIds: string[] }).expectedOwnerIds.length,
    );
    expect(waveSizes).toEqual([1, 3, 3, 1]);
    expect(payload.launchTransaction.state).toBe('verified');
    expect(payload.launchTransaction.requestedMemberIds).toHaveLength(8);
    expect(new Set(payload.launchTransaction.requestedMemberIds).size).toBe(8);
    const firstVerification = launchTransaction.verify.mock.calls[0][0] as {
      expectedAttestations: Array<Record<string, unknown>>;
    };
    // Owner directive 2026-09-15 (WI-10001535): the canary — attestation[0] IS the
    // canary-first member — launches as opus 5 xhigh on the inference gateway's `auto`
    // routing, replacing the gateway-BYPASSING `default` credential and the previously
    // unset model.
    //
    // `model` carries the `[1m]` marker deliberately — modelWindowForSpec reads it to
    // launch the 1M auto-compact window, and a bare `opus` spec silently runs 200k.
    // `effort` is DERIVED from that spec by modelEffortFromSpec, so it is a second,
    // independent witness that the composed spec really carries the xhigh suffix
    // rather than the suffix being stripped somewhere in the fold.
    expect(firstVerification.expectedAttestations[0]).toMatchObject({
      model: 'opus[1m]:xhigh',
      modelSource: null,
      effort: 'xhigh',
      account: 'auto',
      carry: 'warm',
      visibility: 'visible',
    });
    for (const call of spawnConsoleMock.mock.calls) {
      expect(call[0].envelope.greetingCmd).toMatch(/--owner-id=su-[0-9a-f-]+/);
      expect(call[0].envelope.greetingCmd).toContain('--carry=warm');
    }
  });

  it('P-008: a capless full-deficit launch preserves its exact batch/retry boundary inside a 50-member target', async () => {
    // The target is deliberately larger than the retired 12-terminal local ceiling.
    // P-013 makes the launch path capless upward: the transaction owns the full
    // requested cohort, while governed dispatch admission remains the only
    // legitimate capacity clamp. A spawn failure still stops later batches and
    // leaves an exact retry set.
    let spawn = 0;
    spawnConsoleMock.mockImplementation(() => {
      spawn += 1;
      if (spawn === 9) {
        return { status: 'error', error: 'member 9 failed: no window opened', code: 502 };
      }
      return { status: 'ok', terminal: `term-${spawn}`, pid: 500 + spawn };
    });

    const res = await invokeLaunchHandler(
      { name: 'Partial Fifty Fleet', plan: 'my-plan', harness: 'papercusp', count: 50 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    const tx = payload.launchTransaction;
    const requestedIds = tx.requestedMemberIds as string[];
    const verifiedIds = tx.verifiedMemberIds as string[];
    const retryIds = tx.recovery.retryOwnerIds as string[];

    expect(requestedIds).toHaveLength(50);
    expect(new Set(requestedIds).size).toBe(50);
    // Canary + two verified 3-member waves + one partial 3-member wave.
    expect(spawnConsoleMock).toHaveBeenCalledTimes(10);
    expect(tx.waves.map((wave: { ownerIds: string[] }) => wave.ownerIds.length)).toEqual([1, 3, 3, 3]);
    // The failed member is excluded from the verification probe for its wave.
    expect(
      launchTransaction.verify.mock.calls.map(
        (call) => (call[0] as { expectedOwnerIds: string[] }).expectedOwnerIds.length,
      ),
    ).toEqual([1, 3, 3, 2]);

    expect(payload.ok).toBe(true);
    expect(payload.opened).toHaveLength(9);
    expect(payload.failed).toHaveLength(1);
    expect(tx.state).toBe('partial');
    expect(tx.waves.at(-1)?.state).toBe('partial');
    expect(verifiedIds).toHaveLength(9);
    // The failed terminal plus the 40 members in later, unattempted batches
    // remain in the full 50-id cohort's exact retry set.
    expect(retryIds).toHaveLength(41);
    expect(new Set([...verifiedIds, ...retryIds])).toEqual(new Set(requestedIds));
    expect(retryIds).toContain(payload.failed[0].ownerId);
    expect(payload.fleetComplete).toBe(false);
    expect(payload.shortfall).toBe(41);
  });

  it('opens every wave before a later attestation failure is observed and returns the exact retry set', async () => {
    launchTransaction.verify
      .mockResolvedValueOnce({ agentStarted: true, waitedMs: 1, sessions: [], note: 'verified' })
      .mockResolvedValueOnce({ agentStarted: false, waitedMs: 1, sessions: [], note: 'ATTESTATION MISMATCH' });
    const res = await invokeLaunchHandler(
      { name: 'Mismatch Fleet', plan: 'my-plan', harness: 'papercusp', count: 5 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    // Spawning and verification are separate phases (WI-39368): the final
    // pre-pinned member is already open before the second wave's verifier can
    // report its attestation mismatch.
    expect(spawnConsoleMock).toHaveBeenCalledTimes(5);
    expect(
      launchTransaction.verify.mock.calls.map(
        (call) => (call[0] as { expectedOwnerIds: string[] }).expectedOwnerIds.length,
      ),
    ).toEqual([1, 3, 1]);
    expect(payload.launchTransaction.state).toBe('partial');
    expect(payload.launchTransaction.verifiedMemberIds).toHaveLength(2);
    expect(payload.launchTransaction.failed).toHaveLength(3);
    expect(payload.launchTransaction.recovery.retryOwnerIds).toHaveLength(3);
  });
});

describe('fleet:launch-on-plan handler — live-member deficit guard (2026-07-03 leader doom-loop)', () => {
  beforeEach(async () => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    setClaimSpecMock.mockReset();
    setClaimSpecMock.mockResolvedValue({ ok: true, revision: 1 });
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockReset();
  });

  it('refuses a relaunch when the fleet already has >= count LIVE members — no spawn at all', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    getFleetMock.mockResolvedValueOnce({ leaderOwnerId: 'owner-1', colorScheme: { name: 'Ocean' } });
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue(['m-1', 'm-2']);
    admissionMocks.preflight.mockResolvedValueOnce({
      ready: false,
      status: 'refused',
      reason: 'family-disagreement',
      message: 'a drained no-op must never reach exact-plan admission',
    });
    const res = await invokeLaunchHandler(
      { name: 'Alpha Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.relaunchSuppressed).toBe(true);
    expect(payload.liveMembers).toBe(2);
    expect(payload.opened).toEqual([]);
    expect(payload.message).toMatch(/already has 2 LIVE members/);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(admissionMocks.preflight).not.toHaveBeenCalled();
    // EI-20386584937642609: a suppressed no-op must leave an authored fleet claim
    // spec untouched; there is no launch wave that needs a new spec.
    expect(setClaimSpecMock).not.toHaveBeenCalled();
    expect(payload.claimSpecApplied).toBeNull();
  });

  it('opens only the DEFICIT when some members are live (2 requested, 1 alive → 1 opened)', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    getFleetMock.mockResolvedValueOnce({ leaderOwnerId: 'owner-1', colorScheme: { name: 'Ocean' } });
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue(['m-1']);
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const res = await invokeLaunchHandler(
      { name: 'Beta Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(admissionMocks.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ requestedSeats: 1 }),
    );
    expect(claimFleetLaunchSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 2,
        allowCountIncreaseWithinWindow: true,
      }),
    );
    expect(payload.message).toContain('deficit top-up: 1 already live of the 2 requested');
  });

  it('capacity-clamps the DEFICIT before opening terminals (3 requested, 0 alive, 1 safe slot → 1 opened)', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    fetchGatewayHeadroomMock.mockResolvedValue({
      reachable: true,
      utilization: 0.1,
      utilizationPct: 10,
      paused: false,
      rejected: false,
      inFlight: 0,
      queueDepth: 0,
      priorityTiers: {
        healthyAccounts: 1,
        tier1Reserve: 0,
        tiers: [{ tier: 3, minShare: 1, inFlight: 0, queued: 0 }],
      },
    });
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const res = await invokeLaunchHandler(
      { name: 'Capacity Fleet', plan: 'my-plan', harness: 'papercusp', count: 3 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.requestedOpenCount).toBe(3);
    expect(payload.capacityClamp).toMatchObject({ requestedOpenCount: 3, openCount: 1, clamped: true });
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(payload.message).toContain('capacity-clamped top-up 3→1');
  });

  it('reads capacity for the resolved member provider, including OMP model-aware routing', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });

    await invokeLaunchHandler(
      {
        name: 'Codex Capacity Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        agent: 'codex',
        model: 'gpt-5.6-sol:xhigh',
      } as never,
      {} as never,
    );
    expect(fetchGatewayHeadroomMock).toHaveBeenLastCalledWith({ timeoutMs: 1200, provider: 'codex' });

    fetchGatewayHeadroomMock.mockClear();
    await invokeLaunchHandler(
      {
        name: 'OMP Codex Capacity Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        agent: 'omp',
        model: 'gpt-5.6-luna:high',
      } as never,
      {} as never,
    );
    expect(fetchGatewayHeadroomMock).toHaveBeenLastCalledWith({ timeoutMs: 1200, provider: 'codex' });

    fetchGatewayHeadroomMock.mockClear();
    await invokeLaunchHandler(
      {
        name: 'OMP Local Capacity Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        agent: 'omp',
        model: 'ollama-cc/ornith-valid',
      } as never,
      {} as never,
    );
    expect(fetchGatewayHeadroomMock).toHaveBeenLastCalledWith({ timeoutMs: 1200, provider: 'claude' });
  });

  it('suppresses a top-up without burning a launch wave when reachable capacity is zero', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockClear();
    fetchGatewayHeadroomMock.mockResolvedValue({
      reachable: true,
      utilization: 1,
      utilizationPct: 100,
      paused: true,
      rejected: true,
      inFlight: 1,
      queueDepth: 4,
      priorityTiers: {
        healthyAccounts: 0,
        tier1Reserve: 0,
        tiers: [{ tier: 3, minShare: 0, inFlight: 0, queued: 0 }],
      },
    });
    const res = await invokeLaunchHandler(
      { name: 'Full Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.capacitySuppressed).toBe(true);
    expect(payload.opened).toEqual([]);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(claimFleetLaunchSlot).not.toHaveBeenCalled();
  });

  it('does not count the CALLER (the leader) as a live member', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    // resolveFleetCaller's mocked ownerId below must be excluded from the live count.
    const { resolveFleetCaller } = await import('../_shared');
    const ownerId = vi.mocked(resolveFleetCaller)({} as never).ownerId as string;
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([ownerId]);
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    const res = await invokeLaunchHandler(
      { name: 'Gamma Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
  });

  // WI-10005698: a suppressed no-op must not enroll the CALLER either. Two independent
  // faults composed to break this, and each half gets its own case below because each
  // was individually survivable:
  //   WHO  — the caller-exclusion branch excluded a GOAL holder only when a leader was
  //          ACTUALLY spawned, so a portfolio steward topping up an existing fleet that
  //          still had a live leader fell through the ignored-spawn path into the normal
  //          join and was enrolled as a member (flipping its mission to execute-plan-only).
  //   WHEN — that whole enrollment block ran BEFORE this deficit guard, so even an
  //          ordinary caller had its fleet label, leader control, compaction seed and
  //          window colour written by a call that opened nothing.
  // This is handler-level by construction: no type changed and each side was locally
  // correct, so only the ORDERING of two correct things was wrong — nothing a unit test
  // on either side alone could see.
  it('WHO: a GOAL-holder portfolio steward stays out of a fleet it only tops up', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    // BOTH mocks are load-bearing: the getModeSubject call that marks the caller a
    // portfolio steward is itself gated behind `if (goalSettings.goalId)`, so mocking the
    // mode subject alone leaves goalHolderSubject null and the caller is enrolled as an
    // ordinary member — i.e. the test would silently stop exercising the fix.
    goalLaunchReadMock.mockResolvedValue({
      goalId: 'parent-goal',
      settings: null,
      drainFleetSlug: null,
      degraded: false,
      degradedReasons: [],
    });
    goalModeSubjectMock.mockResolvedValue('parent-goal');
    // Arming goalId above also arms the goal plan-placement fence, which returns an early
    // ok:false 'goal-plan-placement-prerequisite' BEFORE the enrollment path. Satisfy it
    // explicitly here rather than leaning on the file-level default, so this case cannot
    // start silently refusing (and passing vacuously) if that default drifts.
    obligationAgendaReadMock.mockImplementation(async (input: any) => ({
      goalId: input.goalId,
      observedAt: new Date().toISOString(),
      agenda: {
        sourceGeneration: 'agenda-current',
        evaluations: [
          {
            id: 'obl:goal-plan-placement:steward',
            ruleId: 'goal-plan-placement',
            family: 'plan-placement',
            title: 'Place my-plan',
            scope: {
              workspaceId: input.workspaceId,
              ownerId: input.ownerId,
              goalId: input.goalId,
              planSlug: 'my-plan',
            },
            responsibleOwnerId: input.ownerId,
            status: 'due',
            sourceGeneration: 'placement-current',
            evidence: [
              {
                ref: 'goal-plan-placement:my-plan',
                observedAt: new Date().toISOString(),
                freshness: 'current',
              },
            ],
          },
        ],
      },
    }));
    // An EXISTING fleet owned by someone else, still led: leader:'spawn' is IGNORED (a
    // second leader is a coup), and that ignored-spawn path is precisely the one that used
    // to fall through to the normal join and enroll the steward as an ordinary member.
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: {
        owner: 'other-caller',
        leaderOwnerId: 'other-leader',
        colorScheme: { name: 'Ocean' },
      },
      created: false,
    });
    // Deliberately a REAL wave (0 alive, 1 requested) so the deficit guard ADMITS. That
    // isolates the WHO half from the WHEN half: the steward must stay out on its own
    // merits, not merely because nothing was opened. Members really do spawn here.
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });

    const res = await invokeLaunchHandler(
      {
        name: 'Steward Top Up',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        leader: 'spawn',
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    // Guard the path itself: several early returns above (the goal plan-placement fence,
    // the admission refusals) answer ok:false and carry NO callerMembership, so without
    // this every "not called" assertion below would pass vacuously on a refusal.
    expect(payload.error ?? null).toBeNull();
    expect(payload.ok).toBe(true);
    expect(payload.relaunchSuppressed).toBeUndefined();
    expect(payload.leaderSpawnIgnored).toContain('only tops up members');
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    // The steward reason, not the spawned-leader one: being a portfolio holder is its own
    // ground for staying out, which is why callerExcludedFromFleet was NOT widened.
    expect(payload.callerMembership.enrolled).toBe(false);
    expect(payload.callerMembership.role).toBe('delegator');
    expect(payload.callerMembership.reason).toBe('goal-holder-portfolio-steward');
    expect(setPresenceFleetMock).not.toHaveBeenCalled();
    expect(ensureFleetLeaderControlMock).not.toHaveBeenCalled();
  });

  it('WHEN: an ordinary caller is not enrolled by a call the deficit guard suppresses', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    // No goal mocks: callerIsPortfolioSteward is false, so this caller DOES take the
    // enrollment branch. Only the deferral past this guard keeps the writes from running.
    getFleetMock.mockResolvedValueOnce({
      leaderOwnerId: 'owner-1',
      colorScheme: { name: 'Ocean' },
    });
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue(['m-1', 'm-2']);

    const res = await invokeLaunchHandler(
      { name: 'Ordinary Top Up', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.relaunchSuppressed).toBe(true);
    expect(payload.liveMembers).toBe(2);
    expect(payload.opened).toEqual([]);
    // Distinct reason from the WHO case: this caller was eligible to join and simply
    // never reached the writes, which is what the reported shape has to say honestly.
    expect(payload.callerMembership).toEqual({
      enrolled: false,
      role: 'leader',
      reason: 'launch-suppressed-before-enrollment',
    });
    expect(setPresenceFleetMock).not.toHaveBeenCalled();
    expect(ensureFleetLeaderControlMock).not.toHaveBeenCalled();
    expect(setClaimSpecMock).not.toHaveBeenCalled();
  });

  it('CALIBRATION: a real wave still enrolls the caller (the two cases above are not vacuous)', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    getFleetMock.mockResolvedValueOnce({
      leaderOwnerId: 'owner-1',
      colorScheme: { name: 'Ocean' },
    });
    // 1 requested, 0 alive => the deficit guard ADMITS, so the deferred writes must run.
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });

    const res = await invokeLaunchHandler(
      { name: 'Real Wave', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.relaunchSuppressed).toBeUndefined();
    expect(payload.callerMembership.enrolled).toBe(true);
    expect(setPresenceFleetMock).toHaveBeenCalledTimes(1);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
  });
});

// WI-1811 (fleet-launch-agent-inheritance-2026-07-03#P-007): the P-005 idempotency guard's
// TOOL-LEVEL behavior — a second in-window fleet:launch-on-plan call must open ZERO members
// (no-op, not a second wave) and hand the leader the exact standing-job notice, not a bare
// error. Store-level claim semantics (won/lost, window, concurrency) are covered in
// agent-fleets-store.integration.test.ts; this pins what the HANDLER does with a lost claim.
describe('fleet:launch-on-plan handler — P-005 idempotency guard (a re-fire inside the window opens 0 members)', () => {
  beforeEach(async () => {
    spawnConsoleMock.mockReset();
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockReset();
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(async () => {
    // Restore the module-level default (won:true) so later describe blocks that don't touch
    // this mock themselves aren't left seeing this block's last (won:false) resolution.
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockReset();
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockResolvedValue({ won: true, at: 1 });
  });

  it('a lost claim opens 0 members — spawnConsole is never called', async () => {
    // Calibration: real suppression path, independent of either wrong adapter.
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockResolvedValue({
      won: false,
      priorAt: Date.now() - 5_000,
      priorCount: 2,
    });
    const res = await invokeLaunchHandler(
      { name: 'Refire Fleet', plan: 'my-plan', harness: 'papercusp', count: 2 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.opened).toEqual([]);
    expect(payload.failed).toEqual([]);
    expect(payload.relaunchSuppressed).toBe(true);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('does not read or rewrite the claim spec when a duplicate top-up is suppressed', async () => {
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockResolvedValue({
      won: false,
      priorAt: Date.now() - 190_000,
      priorCount: 30,
    });
    setClaimSpecMock.mockClear();

    const res = await invokeLaunchHandler(
      {
        name: 'Suppressed Claim Spec Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 30,
        claimKinds: ['bug'],
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.relaunchSuppressed).toBe(true);
    expect(payload.opened).toEqual([]);
    expect(payload.claimSpecApplied).toBeNull();
    expect(setClaimSpecMock).not.toHaveBeenCalled();
  });

  it.each(['repaired', 'outer control'])('resumes exact unopened pre-pinned identities when a partial canary becomes live inside the window: %s', async (mode) => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue(['su-late-canary']);
    const { claimFleetLaunchSlot, releaseFleetLaunchSlot } = await import('../../../agent-fleets-store');
    const claimSlot = claimFleetLaunchSlot as ReturnType<typeof vi.fn>;
    const releaseSlot = releaseFleetLaunchSlot as ReturnType<typeof vi.fn>;
    claimSlot.mockReset();
    claimSlot
      .mockResolvedValueOnce({ won: false, priorAt: 1_000, priorCount: 3 })
      .mockResolvedValueOnce({ won: true, at: 2_000 });
    releaseSlot.mockClear();
    // Wrong adapter corrupts one durable pre-pinned identity. Assertions keep
    // the original identities, so a consistent but wrong retry still fails.
    const firstRetryOwnerId = mode === 'outer control' || idempotenceControl === 'partial-exact-retry' ? 'su-wrong-retry-1' : 'su-retry-1';
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: {
        leaderOwnerId: 'owner-1',
        colorScheme: { name: 'Ocean' },
        lastLaunchTransaction: {
          version: 1,
          transactionId: 'partial-tx',
          state: 'partial',
          requestedAt: 500,
          updatedAt: 900,
          requestedMemberIds: ['su-late-canary', firstRetryOwnerId, 'su-retry-2'],
          openedMemberIds: ['su-late-canary'],
          verifiedMemberIds: [],
          failed: [{ ownerId: 'su-late-canary', phase: 'verification', reason: 'bounded timeout' }],
          waves: [
            {
              index: 0,
              ownerIds: ['su-late-canary'],
              state: 'partial',
              openedOwnerIds: ['su-late-canary'],
            },
          ],
          recovery: {
            retryOwnerIds: ['su-late-canary', firstRetryOwnerId, 'su-retry-2'],
            nextAction: 'resume unresolved pre-pinned identities',
          },
        },
      },
      created: false,
    });
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term', pid: 123 });

    const res = await invokeLaunchHandler(
      { name: 'Resume Fleet', plan: 'my-plan', harness: 'papercusp', count: 3 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    const commands = spawnConsoleMock.mock.calls.map(
      (call) => (call[0].envelope as { greetingCmd: string }).greetingCmd,
    );
    const persisted = launchTransaction.persist.mock.calls.at(-1)?.[0] as {
      transaction: { transactionId: string; requestedMemberIds: string[]; openedMemberIds: string[] };
    };

    const assertExactIdentities = () => expect(payload.opened.map((member: { ownerId: string }) => member.ownerId),
      'idempotence-contract:partial-exact-retry').toEqual(['su-retry-1', 'su-retry-2']);
    if (mode === 'outer control') {
      expect(() => assertExactIdentities()).toThrowError();
      expect(payload.opened.map((member: { ownerId: string }) => member.ownerId)).toEqual(['su-wrong-retry-1', 'su-retry-2']);
      expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
      return;
    }
    assertExactIdentities();
    expect(payload.launchTransaction.transactionId).toBe('partial-tx');
    expect(persisted.transaction.transactionId).toBe('partial-tx');
    expect(persisted.transaction.requestedMemberIds).toEqual(['su-late-canary', 'su-retry-1', 'su-retry-2']);
    expect(persisted.transaction.openedMemberIds).toEqual(['su-late-canary', 'su-retry-1', 'su-retry-2']);
    expect(releaseSlot).toHaveBeenCalledWith(expect.objectContaining({ at: 1_000 }));
    expect(claimSlot).toHaveBeenCalledTimes(2);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
    expect(commands).toEqual([
      expect.stringContaining('--owner-id=su-retry-1'),
      expect.stringContaining('--owner-id=su-retry-2'),
    ]);
    expect(payload.opened.map((member: { ownerId: string }) => member.ownerId)).toEqual(['su-retry-1', 'su-retry-2']);
    expect(payload.relaunchSuppressed).toBeUndefined();
  });

  it('resumes the same transaction and exact identities after the suppression window expires', async () => {
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue(['su-late-canary']);
    const { claimFleetLaunchSlot, releaseFleetLaunchSlot } = await import('../../../agent-fleets-store');
    const claimSlot = claimFleetLaunchSlot as ReturnType<typeof vi.fn>;
    const releaseSlot = releaseFleetLaunchSlot as ReturnType<typeof vi.fn>;
    claimSlot.mockReset();
    // The prior 300-second claim has expired, so the replay wins directly.
    claimSlot.mockResolvedValue({ won: true, at: 302_000 });
    releaseSlot.mockClear();
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: {
        leaderOwnerId: 'owner-1',
        colorScheme: { name: 'Ocean' },
        lastLaunchTransaction: {
          version: 1,
          transactionId: 'partial-tx',
          state: 'partial',
          requestedAt: 500,
          updatedAt: 900,
          requestedMemberIds: ['su-late-canary', 'su-retry-1', 'su-retry-2'],
          openedMemberIds: ['su-late-canary'],
          verifiedMemberIds: [],
          failed: [{ ownerId: 'su-late-canary', phase: 'verification', reason: 'bounded timeout' }],
          waves: [
            {
              index: 0,
              ownerIds: ['su-late-canary'],
              state: 'partial',
              openedOwnerIds: ['su-late-canary'],
            },
          ],
          recovery: {
            retryOwnerIds: ['su-late-canary', 'su-retry-1', 'su-retry-2'],
            nextAction: 'resume unresolved pre-pinned identities',
          },
        },
      },
      created: false,
    });
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term', pid: 123 });

    const res = await invokeLaunchHandler(
      { name: 'Resume Expired Fleet', plan: 'my-plan', harness: 'papercusp', count: 3 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    const commands = spawnConsoleMock.mock.calls.map(
      (call) => (call[0].envelope as { greetingCmd: string }).greetingCmd,
    );
    const persisted = launchTransaction.persist.mock.calls.at(-1)?.[0] as {
      transaction: { transactionId: string; requestedMemberIds: string[]; openedMemberIds: string[]; waves: unknown[] };
    };

    expect(claimSlot).toHaveBeenCalledTimes(1);
    expect(releaseSlot).not.toHaveBeenCalled();
    expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
    expect(commands).toEqual([
      expect.stringContaining('--owner-id=su-retry-1'),
      expect.stringContaining('--owner-id=su-retry-2'),
    ]);
    expect(payload.opened.map((member: { ownerId: string }) => member.ownerId)).toEqual(['su-retry-1', 'su-retry-2']);
    expect(payload.launchTransaction.transactionId).toBe('partial-tx');
    expect(persisted.transaction.transactionId).toBe('partial-tx');
    expect(persisted.transaction.requestedMemberIds).toEqual(['su-late-canary', 'su-retry-1', 'su-retry-2']);
    expect(persisted.transaction.openedMemberIds).toEqual(['su-late-canary', 'su-retry-1', 'su-retry-2']);
    expect(persisted.transaction.waves).toHaveLength(3);
  });

  it('the notice names the fleet, the prior member count/age, and tells the leader not to re-call', async () => {
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockResolvedValue({
      won: false,
      priorAt: Date.now() - 12_000,
      priorCount: 3,
    });
    const res = await invokeLaunchHandler(
      { name: 'Refire Fleet', plan: 'drain-me', harness: 'papercusp', count: 3 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.message).toMatch(
      /Fleet `refire-fleet` was already launched — 3 members opened \d+s ago \(possibly by this very session\)\./,
    );
    expect(payload.message).toContain(
      'You ARE the leader; do NOT call fleet:launch-on-plan again or fleet:take-leadership for this fleet — re-call only to add another wave once the current members have drained.',
    );
    expect(payload.message).toContain('Until the plan `drain-me` is drained, your standing job each cycle:');
    expect(payload.message).toContain(
      'Those members were launched with this MEMBER OPERATING BASELINE (do NOT re-issue or contradict it; a later custom brief still layers below it):',
    );
    // Every LEADER_STANDING_JOB point + MEMBER_BASELINE_RULES headline is enumerated, not just referenced.
    for (const point of LEADER_STANDING_JOB) expect(payload.message).toContain(point);
    for (const rule of MEMBER_BASELINE_RULES) expect(payload.message).toContain(rule.head);
  });

  it('reports persisted openedMemberIds, not the requested slot count, for a partial prior wave', async () => {
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockResolvedValue({
      won: false,
      priorAt: Date.now() - 12_000,
      priorCount: 5,
    });
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: {
        leaderOwnerId: 'owner-1',
        colorScheme: { name: 'Ocean' },
        lastLaunchTransaction: {
          state: 'partial',
          openedMemberIds: ['su-opened-only'],
          recovery: { retryOwnerIds: ['su-opened-only'], nextAction: 'reconcile late member' },
        },
      },
      created: false,
    });
    const res = await invokeLaunchHandler(
      { name: 'Partial Notice Fleet', plan: 'drain-me', harness: 'papercusp', count: 5 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.message).toMatch(
      /Fleet `partial-notice-fleet` was already launched — 1 member opened \d+s ago \(possibly by this very session\)\./,
    );
    expect(payload.message).not.toMatch(/5 members opened/);
  });

  it('singularizes "member" (not "members") when exactly one prior member was opened', async () => {
    const { claimFleetLaunchSlot } = await import('../../../agent-fleets-store');
    (claimFleetLaunchSlot as ReturnType<typeof vi.fn>).mockResolvedValue({
      won: false,
      priorAt: Date.now() - 1_000,
      priorCount: 1,
    });
    const res = await invokeLaunchHandler(
      { name: 'Solo Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.message).toMatch(/1 member opened \d+s ago/);
    expect(payload.message).not.toMatch(/1 members opened/);
  });
});

// EI-7671: the handler must apply the fleet-level kind-filter claim spec BEFORE opening
// any member terminal (closing the boot-race where members self-pull under the
// unrestricted DEFAULT_CLAIM_SPEC before the leader manually steers them).
describe('fleet:launch-on-plan handler — claim-spec wiring (plan-scoped #4 + claimKinds EI-7671)', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    setClaimSpecMock.mockReset();
    setClaimSpecMock.mockResolvedValue({ ok: true, revision: 1 });
    // P-010: restore the healthy-lane guard default (order-independent).
    previewSpecPoolEffectMock.mockReset();
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 5, pool: 10, states: ['open'], harness: 'papercusp' });
    evaluateCollapseGuardMock.mockReset();
    evaluateCollapseGuardMock.mockReturnValue({ refuse: false, errors: [] });
  });

  it('EI-21148090110387275: COMPOSES claimKinds with the plan predicate (never replaces it) when a plan is given, BEFORE any member terminal opens', async () => {
    const callOrder: string[] = [];
    setClaimSpecMock.mockImplementation(async () => {
      callOrder.push('setClaimSpec');
      return { ok: true, revision: 1 };
    });
    spawnConsoleMock.mockImplementation(() => {
      callOrder.push('spawnConsole');
      return { status: 'ok', terminal: 'term-1', pid: 123 };
    });
    const res = await invokeLaunchHandler(
      { name: 'Drain Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, claimKinds: ['bug', 'change'] } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(setClaimSpecMock).toHaveBeenCalledTimes(1);
    const call = setClaimSpecMock.mock.calls[0][0] as {
      cupId: string;
      spec: { specId: string; view: { filter: unknown } };
    };
    expect(call.cupId).toBe('fleet:drain-fleet');
    // EI-21148090110387275: a plan was ALSO supplied, so claimKinds must be ANDed onto the
    // plan predicate (buildFleetPlanClaimSpec), never swap it out for a global,
    // plan-blind kind-only filter (buildFleetKindClaimSpec) — that used to silently
    // broaden every member past the owner-approved plan (specId flipping from
    // `...-plan` to `...-kinds`). A caller who wants a harness-wide kind drain
    // instead simply omits `plan` (P-003's pure claim-spec fleet).
    expect(call.spec.specId).toBe('fleet-launch-drain-fleet-plan');
    expect(call.spec.view.filter).toEqual({
      all: [
        { field: 'plan', op: '=', value: 'my-plan' },
        { field: 'kind', op: 'in', value: ['bug', 'change'] },
      ],
    });
    // P-010: an issue-family drain auto-pins states:['open'] so it doesn't starve on ['todo'].
    expect((call.spec as { states?: string[] }).states).toEqual(['open']);
    // claimSpecApplied now also carries the pool-effect (matched of pool) on the claimKinds path.
    expect(payload.claimSpecApplied).toMatchObject({ ok: true, revision: 1, poolEffect: { matched: 5, pool: 10 } });
    // Order matters: the spec must land before members can race a get_next pull.
    expect(callOrder.indexOf('setClaimSpec')).toBeLessThan(callOrder.indexOf('spawnConsole'));
  });

  it('EI-21148090110387275: claimKinds alone (no plan) still gets the global kind-only filter — P-003 pure claim-spec fleet', async () => {
    const res = await invokeLaunchHandler(
      { name: 'Pure Drain Fleet', harness: 'papercusp', count: 1, claimKinds: ['bug', 'change'] } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(setClaimSpecMock).toHaveBeenCalledTimes(1);
    const call = setClaimSpecMock.mock.calls[0][0] as { spec: { specId: string; view: { filter: unknown } } };
    expect(call.spec.specId).toBe('fleet-launch-pure-drain-fleet-kinds');
    expect(call.spec.view.filter).toEqual({ field: 'kind', op: 'in', value: ['bug', 'change'] });
  });

  // R-8 (feature-drain-delivery-readiness-and-outcome-accounting-2026-10-01, AUTO-BAR-R-8-P-007):
  // the fresh-recipe write used to require a plan, so every plan-less drain fleet was left with
  // a NULL headcount target. A drain launched without an explicit headcount must still record one.
  it('R-8: a fresh plan-less claimKinds drain fleet receives a supervised headcount target by default', async () => {
    const res = await invokeLaunchHandler(
      { name: 'Target Drain Fleet', harness: 'papercusp', count: 3, claimKinds: ['bug', 'change'] } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(setFleetHeadcountTargetMock).toHaveBeenCalledTimes(1);
    const persisted = setFleetHeadcountTargetMock.mock.calls[0][0] as {
      fleetSlug: string;
      target: number;
      config: Record<string, unknown>;
    };
    expect(persisted.fleetSlug).toBe('target-drain-fleet');
    expect(persisted.target).toBe(3);
    // The recipe mirrors the launch: `headless` was omitted, so it records the visible default.
    expect(persisted.config).toMatchObject({ harness: 'papercusp', headless: false, carry: 'warm' });
    // Claim scope lives in the claim-spec store (top-ups launch plan-less and read it there),
    // so the recipe carries no plan and no duplicated claimKinds.
    expect(persisted.config).not.toHaveProperty('plan');
    expect(persisted.config).not.toHaveProperty('claimKinds');
    expect(persisted.config.supervise).toBe(true);
    expect(payload.headcountProfile).toMatchObject({ applied: true, target: 3 });
  });

  it('#4: ALWAYS sets a PLAN-scoped claim spec even when claimKinds is omitted', async () => {
    const res = await invokeLaunchHandler(
      { name: 'No Kinds Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(setClaimSpecMock).toHaveBeenCalledTimes(1);
    const call = setClaimSpecMock.mock.calls[0][0] as { spec: { view: { filter: unknown } } };
    // Bare plan leaf (no kind narrowing) — keeps members on THIS plan's work-items.
    expect(call.spec.view.filter).toEqual({ field: 'plan', op: '=', value: 'my-plan' });
    // EI-19276371141300541: a fresh plan-only lane now ALSO gets the write-time pool-effect
    // preview (it used to be skipped entirely for this path — the exact gap that let a
    // 10-member fleet launch onto a plan-scoped lane matching a single row with no signal
    // anywhere in the response).
    expect(payload.claimSpecApplied).toMatchObject({ ok: true, revision: 1, poolEffect: { matched: 5, pool: 10 } });
  });

  it('best-effort: a claim-spec write failure never blocks the launch', async () => {
    setClaimSpecMock.mockRejectedValue(new Error('db unavailable'));
    const res = await invokeLaunchHandler(
      { name: 'Resilient Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, claimKinds: ['task'] } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(payload.claimSpecApplied).toMatchObject({ ok: false, errors: ['db unavailable'] });
  });

  // EI-21177728511242093: a relaunch (top-up) of an EXISTING fleet was rewriting the claim
  // spec with a HARDCODED potSlug:null, which lands as harness_slug=NULL on the stored row —
  // clobbering a correctly-scoped prior spec (harness_slug='papercusp') even though nothing
  // about the launch's own harness scope changed. That stranded a live canary member whose
  // scheduler:get_next filters by harness_slug: the spec existed, but scoped to nothing.
  it('EI-21177728511242093: threads the launch\'s resolved harness through as the claim-spec potSlug — never a hardcoded null', async () => {
    const res = await invokeLaunchHandler(
      { name: 'Drain Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, claimKinds: ['bug'] } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(setClaimSpecMock).toHaveBeenCalledTimes(1);
    const call = setClaimSpecMock.mock.calls[0][0] as { potSlug: string | null };
    // Must be the launch's harness scope, not the hardcoded null that dropped it.
    expect(call.potSlug).toBe('papercusp');
  });

  it('EI-21177728511242093: a top-up wave on an ALREADY-EXISTING fleet still threads the harness as potSlug (not null)', async () => {
    // Simulate the fleet already existing with one live member so this call is a
    // top-up/relaunch, not a fresh create — the exact shape of the reported bug.
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['su-existing-member']);
    const res = await invokeLaunchHandler(
      { name: 'Drain Fleet', plan: 'my-plan', harness: 'papercusp', count: 2, claimKinds: ['bug'] } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(liveFleetMemberIds).toHaveBeenCalledWith('drain-fleet', 'ws-1', 'launch');
    expect(setClaimSpecMock).toHaveBeenCalledTimes(1);
    const call = setClaimSpecMock.mock.calls[0][0] as { potSlug: string | null };
    expect(call.potSlug).toBe('papercusp');
  });
});

// P-010: the claimKinds launch path is routed through scheduler:set_claim_spec's WI-5212
// pool-collapse guard — a starving kind scope is REFUSED before any terminal opens (the
// bug-drain-200k trap). The guard's own thresholds are unit-tested in spec-pool-preview; here
// we test the WIRING: refuse aborts the launch, confirm overrides, and matched is surfaced.
describe('fleet:launch-on-plan handler — P-010 claimKinds pool-collapse guard', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    setClaimSpecMock.mockReset();
    setClaimSpecMock.mockResolvedValue({ ok: true, revision: 1 });
    previewSpecPoolEffectMock.mockReset();
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 5, pool: 10, states: ['open'], harness: 'papercusp' });
    evaluateCollapseGuardMock.mockReset();
    evaluateCollapseGuardMock.mockReturnValue({ refuse: false, errors: [] });
  });

  it('REFUSES a starving claimKinds fleet BEFORE any terminal opens — no members, no spec write', async () => {
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 0, pool: 12, states: ['open'], harness: 'papercusp' });
    evaluateCollapseGuardMock.mockReturnValue({
      refuse: true,
      errors: ['spec matches 0 of 12 claimable row(s) — the starved-fleet shape'],
    });
    const res = await invokeLaunchHandler(
      { name: 'Starved Fleet', plan: 'my-plan', harness: 'papercusp', count: 3, claimKinds: ['bug'] } as never,
      {} as never,
    );
    // A refusal is the plain-text err() shape, not a JSON payload.
    expect((res as any).isError).toBe(true);
    const text = (res as any).content[0].text as string;
    expect(text).toMatch(/matches 0 of 12 claimable row/);
    expect(text).toContain('NO members were opened');
    expect(text).toContain('confirmClaimCollapse:true');
    // The guard fired BEFORE terminals AND before the spec write — nothing was opened or stored.
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(setClaimSpecMock).not.toHaveBeenCalled();
  });

  it('confirmClaimCollapse:true forwards confirm to the guard and launches the pre-staged lane anyway', async () => {
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 0, pool: 12, states: ['open'], harness: 'papercusp' });
    // With confirm the guard does not refuse (verified by its own suite); assert the handler forwards it.
    evaluateCollapseGuardMock.mockReturnValue({
      refuse: false,
      errors: [],
      warning: 'pool-collapse confirmed by caller',
    });
    const res = await invokeLaunchHandler(
      {
        name: 'Prestaged Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        claimKinds: ['bug'],
        confirmClaimCollapse: true,
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(evaluateCollapseGuardMock.mock.calls[0][0]).toMatchObject({ confirm: true });
  });

  it('a fed lane launches and SURFACES poolEffect.matched (the counter-signal to starvation)', async () => {
    const res = await invokeLaunchHandler(
      { name: 'Fed Fleet', plan: 'my-plan', harness: 'papercusp', count: 1, claimKinds: ['bug'] } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.claimSpecApplied.poolEffect).toMatchObject({ matched: 5, pool: 10 });
    expect(payload.message).toContain('claim-lane pool-effect');
    expect(payload.message).toMatch(/matches 5 of 10 claimable row/);
    // No confirm passed → the guard was consulted with confirm:false.
    expect(evaluateCollapseGuardMock.mock.calls[0][0]).toMatchObject({ confirm: false });
  });

  // EI-19276371141300541: the guard used to run ONLY on the claimKinds path — a fresh
  // plan-only lane (buildFleetPlanClaimSpec, no claimKinds) got neither the zero-match
  // refuse nor a surfaced poolEffect. Live incident: `fleet:launch-on-plan { name, plan:
  // '<drain-tracking-plan>', count: 10 }` (no claimKinds) reported `claimSpecApplied:
  // {ok:true}` while the plan-scoped lane matched exactly ONE claimable row for a
  // 10-member fleet.
  it('REFUSES a starving PLAN-ONLY fleet (no claimKinds) BEFORE any terminal opens — same guard as claimKinds', async () => {
    // EI-21016597300738770 live shape: promotion knew the exact spec-triad
    // blocker + repair WI, then the zero-lane EARLY return discarded that
    // diagnosis and exposed only the generic collapse refusal.
    promotePlanItemsMock.mockResolvedValue({
      promoted: 0,
      skipped: 5,
      specTriadBlocked: true,
      specTriadMissing: ['requirements', 'design'],
      specTriadWorkItem: 'WI-TRIAD-1',
    });
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 0, pool: 12, states: ['open'], harness: 'papercusp' });
    evaluateCollapseGuardMock.mockReturnValue({
      refuse: true,
      errors: ['spec matches 0 of 12 claimable row(s) — the starved-fleet shape'],
    });
    const res = await invokeLaunchHandler(
      { name: 'Starved Plan Fleet', plan: 'my-plan', harness: 'papercusp', count: 10 } as never,
      {} as never,
    );
    expect((res as any).isError).toBe(true);
    const text = (res as any).content[0].text as string;
    expect(text).toMatch(/matches 0 of 12 claimable row/);
    expect(text).toContain('plan=`my-plan`');
    expect(text).toContain('NO members were opened');
    expect(text).toContain('confirmClaimCollapse:true');
    expect(text).toMatch(/0 of 5 open plan items.*spec triad.*Nothing is claimable yet/i);
    expect(text).toContain('requirements, design');
    expect(text).toContain('WI-TRIAD-1');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(setClaimSpecMock).not.toHaveBeenCalled();
  });

  it('WARNS (never refuses) a PLAN-ONLY fleet whose lane matches fewer rows than requested members — the exact live-incident shape (matched:1, count:10)', async () => {
    previewSpecPoolEffectMock.mockResolvedValue({ matched: 1, pool: 1719, states: ['open'], harness: 'papercusp' });
    const res = await invokeLaunchHandler(
      { name: 'Nonp2p Bug Drain', plan: 'bug-drain-tracking-plan', harness: 'papercusp', count: 10 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalled();
    const warning = payload.claimSpecApplied.warning as string;
    expect(warning).toContain('matches only 1 of 1719');
    expect(warning).toContain('10-member fleet');
    expect(payload.message).toMatch(/may NOT cover all 10 member/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WI-6673 degenerate-lane guard — the DUAL of the collapse guard above.
//
// The collapse guard catches a lane matching TOO FEW rows (starvation). This catches the
// opposite and equally real failure: a lane matching PLENTY of rows that are not work. On
// 2026-08-01 a bug-drain fleet was launched at 1,252 "claimable" items that were 98.7%
// nit-severity auto-filed observations; the real bug backlog was ~285. Nothing objected,
// because every count was correct — a big number simply looks like a healthy backlog.
//
// The guard shipped with no tests at all, which is how its thresholds and its wording could
// rot silently. These pin the three properties that make it worth having: it fires on the
// degenerate shape, it stays SILENT on a healthy lane (a warning that cries wolf gets
// ignored precisely when it matters), and it never blocks a launch.
// ────────────────────────────────────────────────────────────────────────────
describe('fleet:launch-on-plan handler — WI-6673 degenerate-lane (observation-firehose) guard', () => {
  const DEGENERATE = {
    total: 1_252,
    byKind: { change: 1_200, bug: 52 },
    bySeverity: { nit: 1_180, minor: 56, major: 16 },
    lowSeverityShare: 0.987,
    degenerate: true,
    peakDay: { day: '2026-07-31', count: 940 },
  };

  beforeEach(() => {
    spawnConsoleMock.mockReset();
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    setClaimSpecMock.mockReset();
    setClaimSpecMock.mockResolvedValue({ ok: true, revision: 1 });
    previewSpecPoolEffectMock.mockReset();
    previewSpecPoolEffectMock.mockResolvedValue({
      matched: 1_252,
      pool: 1_400,
      states: ['open'],
      harness: 'papercusp',
    });
    evaluateCollapseGuardMock.mockReset();
    evaluateCollapseGuardMock.mockReturnValue({ refuse: false, errors: [] });
    aggregateAdmittedCompositionMock.mockReset();
    aggregateAdmittedCompositionMock.mockResolvedValue(HEALTHY_COMPOSITION);
  });

  const launch = async (args: Record<string, unknown> = {}) =>
    invokeLaunchHandler(
      {
        name: 'Drain Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 1,
        claimKinds: ['bug', 'change'],
        ...args,
      } as never,
      {} as never,
    );

  it('WARNS on a degenerate lane — naming the share, the burst day, and the composition', async () => {
    aggregateAdmittedCompositionMock.mockResolvedValue(DEGENERATE);
    const res = await launch();
    const payload = parseHandlerPayload(res);
    const warning = payload.claimSpecApplied.warning as string;

    expect(warning).toContain('⚠ DEGENERATE LANE');
    // formatLowSeverityShare FLOORS to one decimal rather than rounding, deliberately
    // (EI-22184028605968917: rounding could print "100%" while a major-severity row is
    // still in the lane) — so 0.987 renders as "98.7%", never "99%".
    expect(warning).toContain('98.7%');
    expect(warning).toContain('OBSERVATION FIREHOSE');
    expect(warning).toContain('a large count is not a workload');
    expect(warning).toContain('2026-07-31'); // the burst day
    expect(warning).toContain('940');
    expect(warning).toContain('WI-6673');
    // The composition is quoted, so the reader can act without a second call.
    expect(warning).toContain('"nit":1180');
  });

  it('quotes the share against the ADMITTED total, not the pre-floor matched count', async () => {
    // The share is computed over rows passing ALL claim floors; `matched` is the filter
    // match before them (strictly larger). Reporting one against the other is a true
    // percentage on the wrong base — the very defect class this guard exists to catch,
    // and it shipped inside the guard's own message once.
    previewSpecPoolEffectMock.mockResolvedValue({
      matched: 3_000,
      pool: 4_000,
      states: ['open'],
      harness: 'papercusp',
    });
    aggregateAdmittedCompositionMock.mockResolvedValue(DEGENERATE);
    const res = await launch();
    const warning = parseHandlerPayload(res).claimSpecApplied.warning as string;

    expect(warning).toContain('1236 of 1252 claimable row(s) (98.7%)');
    // The pre-floor number is still shown, but explicitly labelled as the other population.
    expect(warning).toContain('of 3000 matched before claim floors');
    expect(warning).not.toContain('of 3000 claimable row(s)');
  });

  it('omits the pre-floor aside when nothing was filtered out — no confusing "(of N matched)" when N is the same number', async () => {
    previewSpecPoolEffectMock.mockResolvedValue({
      matched: 1_252,
      pool: 1_400,
      states: ['open'],
      harness: 'papercusp',
    });
    aggregateAdmittedCompositionMock.mockResolvedValue(DEGENERATE);
    const res = await launch();
    const warning = parseHandlerPayload(res).claimSpecApplied.warning as string;
    expect(warning).toContain('1236 of 1252 claimable row(s) (98.7%)');
    expect(warning).not.toContain('matched before claim floors');
  });

  it('is SILENT on a healthy lane — a warning that fires on normal backlogs would be tuned out', async () => {
    const res = await launch();
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.claimSpecApplied.warning ?? '').not.toContain('DEGENERATE LANE');
  });

  it('WARNS but never REFUSES — a nit-sweep fleet is a legitimate thing to want', async () => {
    aggregateAdmittedCompositionMock.mockResolvedValue(DEGENERATE);
    const res = await launch({ count: 2 });
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    // Members really opened — the launch proceeded despite the warning.
    expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
    expect(setClaimSpecMock).toHaveBeenCalledTimes(1);
  });

  it('FAILS OPEN — a composition read that throws never blocks the launch', async () => {
    aggregateAdmittedCompositionMock.mockRejectedValue(new Error('pg exploded'));
    const res = await launch();
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    // A diagnostic that becomes a new single point of failure is worse than no diagnostic.
    expect(payload.claimSpecApplied.warning ?? '').not.toContain('DEGENERATE LANE');
  });

  it('reads the composition through the SAME spec filter + states the members will pull with', async () => {
    aggregateAdmittedCompositionMock.mockResolvedValue(DEGENERATE);
    await launch();
    // Composition describing a different population than the one the fleet drains would be
    // a confidently-wrong reassurance — the failure mode, not a milder version of it.
    expect(aggregateAdmittedCompositionMock).toHaveBeenCalledTimes(1);
    const [, opts] = aggregateAdmittedCompositionMock.mock.calls[0] as [
      unknown,
      { harness: string; states?: readonly string[] },
    ];
    expect(opts.harness).toBe('papercusp');
    expect(opts.states).toEqual(expect.arrayContaining(['open']));
  });

  // EI-19276371141300541: this used to assert the OPPOSITE — that a pure plan fleet (no
  // claimKinds) got NO composition read at all, on the theory that only a claimKinds lane is
  // "a claim-spec lane to characterize". That was the same blind spot the pool-collapse guard
  // had: a fresh plan-only lane is a freshly-generated spec just like a kind-only one, and
  // skipping both its zero-match refuse AND this degenerate-lane check is exactly how a
  // starved/degenerate plan lane shipped with zero signal anywhere in the response. Both
  // checks now run uniformly for every freshly-built spec (plan-only included).
  it('DOES run the composition read for a pure plan fleet too (no claimKinds) — a fresh plan-only lane is just as characterizable', async () => {
    aggregateAdmittedCompositionMock.mockResolvedValue(HEALTHY_COMPOSITION);
    const res = await invokeLaunchHandler(
      { name: 'Plan Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(aggregateAdmittedCompositionMock).toHaveBeenCalledTimes(1);
    // A healthy composition stays silent — no false alarm on the common case.
    expect(payload.claimSpecApplied.warning ?? '').not.toContain('DEGENERATE LANE');
  });
});

// #3 promotion FAILSAFE (fleet-launch-promote-workitems-failsafe, 2026-07-08): the handler must
// idempotently promote the plan's items → claimable work-items BEFORE opening any terminal, so a
// forgotten plans:start can't strand the fleet on an empty backlog (the research-desk 2026-07-08 miss).
describe('fleet:launch-on-plan handler — plan→work-item promotion failsafe (#3)', () => {
  beforeEach(() => {
    spawnConsoleMock.mockReset();
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue({ reachable: false });
    setClaimSpecMock.mockReset();
    setClaimSpecMock.mockResolvedValue({ ok: true, revision: 1 });
    promotePlanItemsMock.mockReset();
    promotePlanItemsMock.mockResolvedValue({ promoted: 0, skipped: 3 });
  });

  it('promotes the plan BEFORE opening any member terminal', async () => {
    const callOrder: string[] = [];
    promotePlanItemsMock.mockImplementation(async () => {
      callOrder.push('promote');
      return { promoted: 4, skipped: 0 };
    });
    spawnConsoleMock.mockImplementation(() => {
      callOrder.push('spawnConsole');
      return { status: 'ok', terminal: 'term-1', pid: 123 };
    });
    const res = await invokeLaunchHandler(
      { name: 'Fresh Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(promotePlanItemsMock).toHaveBeenCalledTimes(1);
    expect(promotePlanItemsMock.mock.calls[0][0]).toMatchObject({ planSlug: 'my-plan', harnessSlug: 'papercusp' });
    expect(callOrder.indexOf('promote')).toBeLessThan(callOrder.indexOf('spawnConsole'));
    expect(payload.promotionFailsafe).toMatchObject({ ran: true, promoted: 4 });
  });

  /**
 * EI-21574373783224719: the reservation contract as a single predicate, so the assertion and
 * its falsifiability controls are provably the SAME check. A promoted lane is reserved for the
 * launching fleet only when the promotion call carries a non-blank `fleetSlug` naming the same
 * fleet the handler admitted against — that value becomes `payload.fleet_slug`, which is leg 1
 * of `reservedPlanLaneExclusionSql` and the only thing that keeps a non-fleet agent's
 * self-select off the lane.
 */
function reservesLaneForLaunchingFleet(
  promoteArgs: { fleetSlug?: unknown },
  preflightArgs: { fleetSlug?: unknown },
): boolean {
  const slug = promoteArgs.fleetSlug;
  return typeof slug === 'string' && slug.length > 0 && slug === preflightArgs.fleetSlug;
}

// EI-21574373783224719: promoting is only HALF the failsafe's job — what it mints must also be
  // RESERVED for the fleet it was minted for. The failsafe deliberately does not flip
  // op_status='started' (that would hand a fleet-driven plan a second dispatcher via the DBOS
  // orchestrator frontier), so without a fleet stamp the minted rows carry NO reservation signal
  // at all: `reservedPlanLaneExclusionSql`'s two execution legs read op_status/lifecycle (never
  // set on this path) and its fleet leg reads `payload.fleet_slug` — which, before this fix, had
  // ZERO producers (0 of 123,735 rows). Net effect: every lane this failsafe minted was
  // simultaneously claimable by the fleet AND by every unrelated agent's self-select. Measured
  // live: WI-41517 (anti-babysitting-monitor-enforcement-2026-08-25 P-005) was served to two
  // different non-fleet agents 57 minutes apart while the fleet was demonstrably working the
  // sibling lane, with 37 such lanes exposed across 6 live-fleet plans.
  //
  // Guard the ARGUMENT rather than the resulting payload: the stamping itself is
  // promotePlanItems' own contract (covered there), while the defect here was that this caller
  // never told it which fleet to reserve for.
  it('reserves what it promotes for the LAUNCHING fleet — passes fleetSlug (EI-21574373783224719)', async () => {
    const res = await invokeLaunchHandler(
      { name: 'Fresh Fleet', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(promotePlanItemsMock).toHaveBeenCalledTimes(1);

    const promoteArgs = promotePlanItemsMock.mock.calls[0][0] as { fleetSlug?: unknown };
    // Compared against the slug the handler independently hands the admission preflight rather
    // than a hardcoded derivation, so the guard keeps holding if fleetSlugFromName's
    // slugification ever changes — while still catching a wrong-fleet stamp, which would
    // reserve the lane away from the very fleet that is about to work it.
    const preflightArgs = admissionMocks.preflight.mock.calls[0]?.[0] as { fleetSlug?: unknown };
    expect(reservesLaneForLaunchingFleet(promoteArgs, preflightArgs)).toBe(true);

    // FALSIFIABILITY CONTROLS, kept PERMANENTLY in the test rather than proven once by
    // mutating the shared tree (the repo's mutation-probe guidance for a subject you
    // `import`: keep the deliberately-wrong shape as a control; never hold a production file
    // mutated while git-sync may sweep it). These are the three real regression shapes, and
    // each must FAIL the same predicate the assertion above passes — so a future refactor that
    // weakens the predicate cannot leave this test passing vacuously.
    expect(reservesLaneForLaunchingFleet({}, preflightArgs)).toBe(false); // pre-fix: arg omitted
    expect(reservesLaneForLaunchingFleet({ fleetSlug: '' }, preflightArgs)).toBe(false); // blank
    expect(reservesLaneForLaunchingFleet({ fleetSlug: 'a-different-fleet' }, preflightArgs)).toBe(
      false,
    ); // wrong fleet — reserves the lane AWAY from the fleet about to work it
  });

  it('warns in the message when it had to backstop a missing plans:start (promoted > 0)', async () => {
    promotePlanItemsMock.mockResolvedValue({ promoted: 2, skipped: 0 });
    const res = await invokeLaunchHandler(
      { name: 'Forgot Start', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.message).toMatch(/FAILSAFE auto-promoted 2 plan items/);
  });

  it('stays silent (no warning) when the plan was already promoted upstream (idempotent no-op)', async () => {
    promotePlanItemsMock.mockResolvedValue({ promoted: 0, skipped: 5 });
    const res = await invokeLaunchHandler(
      { name: 'Already Started', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.message).not.toMatch(/FAILSAFE auto-promoted/);
    expect(payload.promotionFailsafe).toMatchObject({ ran: true, promoted: 0, skipped: 5 });
  });

  it('explains a zero-promotion spec-triad refusal instead of implying the lane is fed', async () => {
    promotePlanItemsMock.mockResolvedValue({
      promoted: 0,
      skipped: 5,
      specTriadBlocked: true,
      specTriadMissing: ['requirements', 'design'],
      specTriadWorkItem: 'EI-TRIAD-1',
    });
    const res = await invokeLaunchHandler(
      { name: 'Missing Triad', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.message).toMatch(/0 of 5 open plan items.*spec triad.*Nothing is claimable yet/i);
    expect(payload.message).toContain('requirements, design');
    expect(payload.message).toContain('EI-TRIAD-1');
    expect(payload.promotionFailsafe).toMatchObject({
      ran: true,
      promoted: 0,
      skipped: 5,
      specTriadBlocked: true,
    });
  });

  it('never blocks the launch when promotion throws (best-effort)', async () => {
    promotePlanItemsMock.mockRejectedValue(new Error('promotion boom'));
    const res = await invokeLaunchHandler(
      { name: 'Resilient Promote', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(payload.promotionFailsafe).toBeNull();
  });

  it('refuses exact-plan admission after promotion but before fleet creation or terminal spawn', async () => {
    promotePlanItemsMock.mockResolvedValue({ promoted: 0, skipped: 3 });
    admissionMocks.preflight.mockResolvedValueOnce({
      ready: false,
      status: 'refused',
      reason: 'family-disagreement',
      message: 'Actionable promoted families disagree with the exact-plan lane reachability/counts.',
    });

    const res = await invokeLaunchHandler(
      { name: 'Refused Admission', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect((res as any).isError).toBe(true);
    expect(payload).toMatchObject({
      ok: false,
      error: 'admission_refused',
      reason: 'family-disagreement',
      message: expect.stringContaining('Actionable promoted families disagree'),
      repairCall: { tool: 'plans:get', args: { slug: 'my-plan', harness: 'papercusp' } },
      fleet: 'refused-admission',
      plan: 'my-plan',
      promotionFailsafe: { ran: true, promoted: 0, skipped: 3 },
      admission: { ready: false, reason: 'family-disagreement' },
    });
    expect(admissionMocks.preflight).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'my-plan',
      actor: 'owner-1',
      specId: 'fleet-launch-refused-admission-plan',
      fleetSlug: 'refused-admission',
    }));
    expect(admissionMocks.preflight.mock.calls[0][0]).not.toHaveProperty('claimant');
    expect(promotePlanItemsMock).toHaveBeenCalledTimes(1);
    expect(createFleetIfAbsentMock).not.toHaveBeenCalled();
    expect(setClaimSpecMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('uses caller-neutral exact-plan admission after the leader releases the ready row', async () => {
    admissionMocks.preflight.mockImplementationOnce(async (args: { actor: string; claimant?: string }) =>
      args.claimant
        ? {
            ready: false,
            status: 'refused',
            reason: 'floor-gated',
            message: `leader cooldown excluded the released row for ${args.claimant}`,
          }
        : {
            ready: true,
            status: 'ready',
            reason: 'ready',
            message: 'released row is available to the fleet population',
          },
    );

    const res = await invokeLaunchHandler(
      { name: 'Released Ready Handoff', plan: 'my-plan', harness: 'papercusp', count: 1 } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.ok).toBe(true);
    expect(admissionMocks.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'owner-1',
        planSlug: 'my-plan',
        fleetSlug: 'released-ready-handoff',
      }),
    );
    expect(admissionMocks.preflight.mock.calls[0][0]).not.toHaveProperty('claimant');
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
  });
});

// EI-8807: the overrideCapacityClamp ARG must thread through the HANDLER to
// clampFleetTopUpToCapacity({ override }) so an owner-ordered launch is NOT zeroed by a
// stale/wrong gateway health read (the live incident: count:4, healthyAccounts:0 while
// accounts:status showed an available account, dispatchBudget:13 free slots → opened:[] with
// no override arg, forcing a hand-rolled capability:terminal fallback). This pins the
// end-to-end arg-threading the pure-function tests above (clampFleetTopUpToCapacity/override)
// do not cover.
describe('fleet:launch-on-plan handler — overrideCapacityClamp arg threads through (EI-8807)', () => {
  // The exact repro headroom: gateway reachable, ZERO healthy accounts, but a full bee-tier
  // dispatchBudget of free slots (beeTier=3). With account:'auto' the members are gateway-routed,
  // so healthyAccounts:0 zero-gates the top-up — the clamp the owner needed to override.
  const zeroHealthyFullSlots = {
    reachable: true,
    utilization: 0.61,
    utilizationPct: 61,
    paused: false,
    rejected: false,
    inFlight: 0,
    queueDepth: 0,
    priorityTiers: {
      healthyAccounts: 0,
      tier1Reserve: 0,
      tiers: [{ tier: 3, minShare: 13, inFlight: 0, queued: 0 }],
    },
  };

  beforeEach(async () => {
    spawnConsoleMock.mockReset();
    spawnConsoleMock.mockReturnValue({ status: 'ok', terminal: 'term-1', pid: 123 });
    fetchGatewayHeadroomMock.mockReset();
    fetchGatewayHeadroomMock.mockResolvedValue(zeroHealthyFullSlots);
    const { liveFleetMemberIds } = await import('../../../fleet/fleet-roster');
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockReset();
    (liveFleetMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('WITHOUT override: a gateway-routed launch is zeroed by healthyAccounts:0 (the repro — opened:[])', async () => {
    const res = await invokeLaunchHandler(
      { name: 'Override Fleet', plan: 'my-plan', harness: 'papercusp', count: 4, account: 'auto' } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    expect(payload.opened).toEqual([]);
    expect(payload.capacitySuppressed).toBe(true);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    // The clamp recommended 0 and was NOT overridden.
    expect(payload.capacityClamp).toMatchObject({
      openCount: 0,
      clamped: true,
      overridden: false,
      recommendedOpenCount: 0,
    });
  });

  it('uses a fresh successful same-profile canary to ignore stale healthyAccounts:0 without overriding dispatchBudget', async () => {
    const now = Date.now();
    createFleetIfAbsentMock.mockResolvedValueOnce({
      record: {
        leaderOwnerId: 'owner-1',
        colorScheme: { name: 'Ocean' },
        lastLaunchTransaction: {
          version: 1,
          transactionId: 'prior-canary-tx',
          state: 'verified',
          requestedAt: now - 1_000,
          updatedAt: now - 1_000,
          requestedMemberIds: ['su-prior-canary'],
          openedMemberIds: ['su-prior-canary'],
          verifiedMemberIds: ['su-prior-canary'],
          failed: [],
          waves: [],
          recovery: { retryOwnerIds: [], nextAction: 'none' },
          requestedMembers: [{
            index: 0,
            ownerId: 'su-prior-canary',
            agent: 'claude',
            model: 'sonnet',
            account: 'auto',
            carry: 'warm',
            headless: false,
          }],
        },
      },
      created: false,
    });

    const res = await invokeLaunchHandler(
      {
        name: 'Fresh Canary Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 4,
        agent: 'claude',
        model: 'sonnet',
        account: 'auto',
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);

    expect(payload.ok).toBe(true);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(4);
    expect(payload.opened).toHaveLength(4);
    expect(payload.capacitySuppressed).toBeUndefined();
    expect(payload.capacityClamp).toMatchObject({
      openCount: 4,
      clamped: false,
      recommendedOpenCount: 4,
      healthyAccounts: 0,
    });
    expect(payload.capacityClamp.reason).toMatch(/same-profile canary|healthyAccounts=0/);
  });

  it('WITH overrideCapacityClamp:true: all 4 members launch despite healthyAccounts:0, and the override is legible', async () => {
    const res = await invokeLaunchHandler(
      {
        name: 'Override Fleet',
        plan: 'my-plan',
        harness: 'papercusp',
        count: 4,
        account: 'auto',
        overrideCapacityClamp: true,
      } as never,
      {} as never,
    );
    const payload = parseHandlerPayload(res);
    expect(payload.ok).toBe(true);
    // The owner-ordered launch actually opens — the exact consequence the bug reported (a
    // 4→0 clamp with no override arg) no longer strands it.
    expect(spawnConsoleMock).toHaveBeenCalledTimes(4);
    expect(payload.opened).toHaveLength(4);
    expect(payload.capacitySuppressed).toBeUndefined();
    // The recommendation stays REPORTED — an override is never invisible (audit trail).
    expect(payload.capacityClamp).toMatchObject({
      openCount: 4,
      overridden: true,
      recommendedOpenCount: 0,
      healthyAccounts: 0,
    });
    expect(payload.capacityClamp.reason).toMatch(/OVERRIDDEN/);
  });
});
