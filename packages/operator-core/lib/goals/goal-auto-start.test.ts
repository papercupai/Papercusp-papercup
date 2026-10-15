/**
 * goal-auto-start — blocked-by edges + the activation gate on the MACHINE
 * caller (goal-dag-shared-substrate-2026-08-18 P-004).
 *
 * The tool-door twin of these properties is pinned in
 * ../agent-tools/goals/start.test.ts, and the substrate's own row-level
 * semantics (resolve-validated writes, the cycle guard, the verdict fold) in
 * packages/agent-mcp/src/tools/goals/goal-deps.test.ts. What THIS file pins is
 * the wiring this rail adds:
 *
 *   1. Edges are applied with the rail's provenance (createdBy = launchedBy)
 *      and a refused set unwinds the goal row — nothing spawned.
 *   2. The activation gate reads readiness AFTER the edges land and BEFORE the
 *      mode stamp: a refusal costs no stamp, no spawn, no dangling edges.
 *   3. `startBlocked` overrides the gate and the override reason is recorded
 *      on the result (`startBlockedOverride`) — the audit trail.
 *   4. EVERY unwind path (gate refusal, mode-stamp failure, spawn failure)
 *      clears the edges before deleting the row.
 *
 * Run: cd packages/operator-core && npx vitest run lib/goals/goal-auto-start.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnConsoleResult } from '../console-spawn';
import { buildConsoleEnvelope } from '../console-launcher';
import { drainFleetAutoMintEnabled, mintDrainFleetForGoal } from './drain-fleet-mint';
import { loadHarnessRegistry } from '../harness-registry';
import { resolveHomePotSlug } from '../agent-tools/pot/_resolve';

/** Every side effect, in the order it happened — the gate's placement is an ORDER claim. */
const order: string[] = [];
/** SQL the rail actually issued through the mocked org tag, as (text, values) pairs. */
const sqlLog: Array<{ text: string; values: unknown[] }> = [];
type ExistingRoutedGoal = { id: string; status: string; metadata: Record<string, unknown> | null };
const routedGoalRows: ExistingRoutedGoal[] = [];
const reservedReleaseMock = vi.fn(() => order.push('connection-release'));
const executeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join(' ? ');
  sqlLog.push({ text, values });
  const action = text.includes('pg_advisory_lock')
    ? 'proposal-lock'
    : text.includes('pg_advisory_unlock')
      ? 'proposal-unlock'
      : text.includes("metadata->>'routedProposalId'")
        ? 'proposal-lookup'
        : /INSERT/i.test(text)
          ? 'insert'
          : /DELETE/i.test(text)
            ? 'delete'
            : 'sql';
  order.push(action);
  if (text.includes("metadata->>'routedProposalId'")) {
    const proposalId = values[1];
    return Promise.resolve(routedGoalRows.filter((row) => row.metadata?.routedProposalId === proposalId));
  }
  return Promise.resolve([]);
};
const sqlTag = Object.assign(executeSql, {
  begin: vi.fn(),
  reserve: vi.fn(async () => Object.assign(executeSql, { release: reservedReleaseMock })),
});

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlTag }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({
    projects: [{ slug: 'home-pot', harness_kind: 'hive' }],
  })),
}));
vi.mock('../agent-tools/pot/_resolve', () => ({
  resolveHomePotSlug: vi.fn(async () => 'home-pot'),
}));
vi.mock('../work-scope-policy', async (orig) => {
  const actual = await orig<typeof import('../work-scope-policy')>();
  return {
    ...actual,
    isHarnessInScope: (slug: string | null | undefined) =>
      actual.isHarnessInScope(
        slug,
        workScopePolicyMock.policy as Parameters<typeof actual.isHarnessInScope>[1],
      ),
  };
});
vi.mock('../papercusp-root', () => ({ papercuspPathForWorkspace: () => '/tmp/papercusp-ws' }));
vi.mock('../mcp-base-url', () => ({ resolveSpawnHostOperatorBaseUrl: () => 'http://127.0.0.1:3070' }));
vi.mock('../console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async () => ({
    cwd: '/repo',
    env: {},
    greetingCmd: '',
    mcpJsonContents: '',
  })),
}));
type GoalLaunchMockResult = {
  effective: Record<string, unknown>;
  refusal: null;
  goalBrief: { portfolio?: unknown } | null;
  holderReadiness?: { canExecute: boolean; issues: Array<{ code: string; required: boolean; action: string }> };
};
const goalLaunchMocks = vi.hoisted(() => ({
  buildBrief: vi.fn((o: { goalId: string; portfolio?: unknown }) => `kickoff for ${o.goalId}`),
  resolve: vi.fn(
    async (_input?: unknown): Promise<GoalLaunchMockResult> => ({
      effective: {},
      refusal: null,
      goalBrief: null,
    }),
  ),
}));
const goalHistoryMocks = vi.hoisted(() => ({ read: vi.fn() }));
const workScopePolicyMock = vi.hoisted(() => ({
  policy: null as { mode: 'enforce' | 'off'; allowHarnesses: string[] } | null,
}));

// The brief's own content is pinned in ../agent-tools/goals/start.test.ts;
// mocking it here keeps this file off the whole tool-module graph.
vi.mock('../agent-tools/goals/start', () => ({
  buildGoalKickoffBrief: (o: { goalId: string }) => goalLaunchMocks.buildBrief(o),
}));
vi.mock('../prior-attempt-context', () => ({
  readGoalHistoryContext: (goalId: string) => goalHistoryMocks.read(goalId),
}));
vi.mock('../goal-launch-settings', async () => {
  // The shared bootstrap imports the complete goal write surface (create +
  // update), so a partial hand-shaped mock silently loses whichever export the
  // next tool adds. Preserve every real binding and replace only the resolver
  // this ordering test controls; the DB module is already mocked above.
  const actual = await vi.importActual<typeof import('../goal-launch-settings')>('../goal-launch-settings');
  return {
    ...actual,
    resolveGoalLaunchForGoal: (input: unknown) => goalLaunchMocks.resolve(input),
  };
});

type OkSpawn = Extract<SpawnConsoleResult, { status: 'ok' }>;
const okHeadless = (): SpawnConsoleResult =>
  ({
    status: 'ok',
    pid: 777,
    terminal: 'headless',
    child: {} as never,
    display: null,
    desktopEnvResolvedVia: null,
  }) as OkSpawn;
const spawnHeadlessMock = vi.fn(async (_o: unknown): Promise<SpawnConsoleResult> => {
  order.push('spawn');
  return okHeadless();
});
vi.mock('../console-spawn', () => ({ spawnHeadless: (o: unknown) => spawnHeadlessMock(o) }));

type SetModeCall = { ownerId: string; modeId: string; enabled: boolean; subject?: string | null };
const setModeCalls: SetModeCall[] = [];
const setModeMock = vi.fn(async (opts: SetModeCall) => {
  setModeCalls.push(opts);
  order.push(opts.enabled ? 'mode-set' : 'mode-clear');
  return { ok: true };
});
vi.mock('../modes/store', () => ({ setMode: (o: SetModeCall) => setModeMock(o) }));

// Drain-fleet wiring is pinned in the tool door's suite + drain-fleet-mint.test.ts;
// OFF here so the order log carries only what this file is about.
vi.mock('./drain-fleet-mint', () => ({
  drainFleetAutoMintEnabled: vi.fn(async () => false),
  mintDrainFleetForGoal: vi.fn(),
  teardownDrainFleetMint: vi.fn(),
}));

// The dependency substrate as a seam — same pattern as the tool door's suite.
type Readiness = {
  actionable: boolean;
  premiseInvalidated: boolean;
  blockers: Array<{ kind: string; ref: string; status: string | null; verdict: string }>;
};
const ACTIONABLE: Readiness = { actionable: true, premiseInvalidated: false, blockers: [] };
const applyBlockedByMock = vi.fn(
  async (_sql: unknown, _o: unknown): Promise<{ ok: true; blockers: unknown[] } | { ok: false; problem: string }> => {
    order.push('deps-apply');
    return { ok: true, blockers: [] };
  },
);
const readinessMock = vi.fn(async (_sql: unknown, _ws: unknown, _id: unknown): Promise<Readiness> => {
  order.push('readiness');
  return ACTIONABLE;
});
const replaceBlockedByMock = vi.fn(async (_sql: unknown, _o: unknown) => {
  order.push('deps-clear');
});
vi.mock('@papercusp/agent-mcp/goal-deps', async (orig) => ({
  // Keep every other export real — the same module file is reachable by
  // relative path elsewhere in the import graph.
  ...(await orig<Record<string, unknown>>()),
  applyGoalBlockedBy: (s: unknown, o: unknown) => applyBlockedByMock(s, o),
  readGoalReadiness: (s: unknown, w: unknown, g: unknown) => readinessMock(s, w, g),
  replaceGoalBlockedBy: (s: unknown, o: unknown) => replaceBlockedByMock(s, o),
}));

const { autoStartGoal } = await import('./goal-auto-start');

const INPUT = {
  harnessSlug: 'papercusp',
  title: 'Ship a paid app',
  killCriterion: 'no paying user by day 30',
  budgetCents: 50_000,
  proposalId: 'scout-cycle-1:proposal-1',
};
const call = (extra: Record<string, unknown> = {}) => autoStartGoal({ ...INPUT, ...extra });

const pendingReadiness = (): Readiness => ({
  actionable: false,
  premiseInvalidated: false,
  blockers: [
    { kind: 'goal', ref: 'other-goal-ab12cd', status: 'active', verdict: 'pending' },
    { kind: 'issue', ref: 'WI-100', status: 'resolved', verdict: 'satisfied' },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(drainFleetAutoMintEnabled).mockResolvedValue(false);
  vi.mocked(loadHarnessRegistry).mockResolvedValue({
    projects: [{ slug: 'home-pot', harness_kind: 'hive' }],
  } as Awaited<ReturnType<typeof loadHarnessRegistry>>);
  vi.mocked(resolveHomePotSlug).mockResolvedValue('home-pot');
  workScopePolicyMock.policy = null;
  goalLaunchMocks.buildBrief.mockImplementation(
    (o: { goalId: string; portfolio?: unknown }) => `kickoff for ${o.goalId}`,
  );
  goalLaunchMocks.resolve.mockResolvedValue({ effective: {}, refusal: null, goalBrief: null });
  goalHistoryMocks.read.mockResolvedValue({
    status: 'empty',
    brief: null,
    recovery: { tool: 'goals:get', args: { id: 'generated', detail: 'full' } },
  });
  order.length = 0;
  sqlLog.length = 0;
  routedGoalRows.length = 0;
  reservedReleaseMock.mockClear();
  setModeCalls.length = 0;
  spawnHeadlessMock.mockImplementation(async () => {
    order.push('spawn');
    return okHeadless();
  });
  setModeMock.mockImplementation(async (opts: SetModeCall) => {
    setModeCalls.push(opts);
    order.push(opts.enabled ? 'mode-set' : 'mode-clear');
    return { ok: true };
  });
  applyBlockedByMock.mockImplementation(async () => {
    order.push('deps-apply');
    return { ok: true, blockers: [] };
  });
  readinessMock.mockImplementation(async () => {
    order.push('readiness');
    return ACTIONABLE;
  });
  replaceBlockedByMock.mockImplementation(async () => {
    order.push('deps-clear');
  });
});

describe('goal-auto-start — routed proposal idempotency (WI-10004496)', () => {
  it('holds the proposal mutex through creation and holder spawn', async () => {
    const result = await call();

    expect(result.reusedExistingGoal).toBe(false);
    expect(order.indexOf('proposal-lock')).toBeLessThan(order.indexOf('proposal-lookup'));
    expect(order.indexOf('proposal-lookup')).toBeLessThan(order.indexOf('insert'));
    expect(order.indexOf('insert')).toBeLessThan(order.indexOf('spawn'));
    expect(order.indexOf('spawn')).toBeLessThan(order.indexOf('proposal-unlock'));
    expect(reservedReleaseMock).toHaveBeenCalledTimes(1);
  });

  it('reuses the existing non-terminal goal and does not mint another holder for a routed proposal', async () => {
    routedGoalRows.push({
      id: 'goal-existing-123abc',
      status: 'active',
      metadata: { agentOwnerId: 'su-existing-holder', routedProposalId: INPUT.proposalId },
    });

    const result = await call();

    expect(result).toMatchObject({
      goalId: 'goal-existing-123abc',
      agentOwnerId: 'su-existing-holder',
      reusedExistingGoal: true,
    });
    expect(order).not.toContain('insert');
    expect(setModeMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(reservedReleaseMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing routed proposal id before any database or spawn side effect', async () => {
    await expect(call({ proposalId: '  ' })).rejects.toThrow(/proposalId for idempotency/);

    expect(sqlLog).toHaveLength(0);
    expect(sqlTag.reserve).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });
});

describe('goal-auto-start — Scout workspace sentinel (EI-22762141222831537)', () => {
  it('resolves the sentinel to the same real Pot for storage and launch', async () => {
    const result = await call({ workspaceId: 'ws-test', harnessSlug: 'ws-test' });

    const values = sqlLog.find((entry) => /INSERT/i.test(entry.text))!.values;
    expect(values[1]).toBe('home-pot'); // install_slug, not workspace_id
    expect(values[2]).toBe('ws-test');
    expect(values.some((value) => typeof value === 'string' && value.includes('"scoutSourceScope":"ws-test"'))).toBe(true);
    expect(loadHarnessRegistry).toHaveBeenCalledWith('ws-test');
    expect(resolveHomePotSlug).toHaveBeenCalledWith('ws-test');
    expect(buildConsoleEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-test', slug: 'home-pot' }),
    );
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    const spawn = spawnHeadlessMock.mock.calls[0][0] as { envelope: { greetingCmd: string } };
    expect(spawn.envelope.greetingCmd).toContain('--harness=home-pot');
    expect(spawn.envelope.greetingCmd).toContain(`--goal-bootstrap-subject=${result.goalId}`);
    expect(spawn.envelope.greetingCmd).not.toContain('--harness=ws-test');
  });

  it('re-homes a registered source hive outside work-scope to the executable home Pot', async () => {
    workScopePolicyMock.policy = {
      mode: 'enforce',
      allowHarnesses: ['home-pot', 'papercusp', 'portal'],
    };
    vi.mocked(loadHarnessRegistry).mockResolvedValue({
      projects: [
        { slug: 'home-pot', harness_kind: 'hive' },
        { slug: 'sb-devboard-hive', harness_kind: 'hive' },
      ],
    } as Awaited<ReturnType<typeof loadHarnessRegistry>>);

    const result = await call({ workspaceId: 'ws-test', harnessSlug: 'sb-devboard-hive' });

    const values = sqlLog.find((entry) => /INSERT/i.test(entry.text))!.values;
    expect(values[1]).toBe('home-pot');
    expect(values.some((value) => typeof value === 'string' && value.includes('"scoutSourceScope":"sb-devboard-hive"'))).toBe(true);
    expect(resolveHomePotSlug).toHaveBeenCalledWith('ws-test');
    expect(buildConsoleEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-test', slug: 'home-pot' }),
    );
    const spawn = spawnHeadlessMock.mock.calls[0][0] as { envelope: { greetingCmd: string } };
    expect(spawn.envelope.greetingCmd).toContain('--harness=home-pot');
    expect(spawn.envelope.greetingCmd).not.toContain('--harness=sb-devboard-hive');
    expect(result.reusedExistingGoal).toBe(false);
  });

  it('refuses an out-of-scope source before writes when its home Pot is not allowed', async () => {
    workScopePolicyMock.policy = { mode: 'enforce', allowHarnesses: ['portal'] };
    vi.mocked(loadHarnessRegistry).mockResolvedValue({
      projects: [
        { slug: 'home-pot', harness_kind: 'hive' },
        { slug: 'sb-devboard-hive', harness_kind: 'hive' },
      ],
    } as Awaited<ReturnType<typeof loadHarnessRegistry>>);

    await expect(call({ workspaceId: 'ws-test', harnessSlug: 'sb-devboard-hive' })).rejects.toThrow(
      /no registered home Pot in work-scope/,
    );
    expect(order).toEqual([]);
    expect(sqlTag.reserve).not.toHaveBeenCalled();
    expect(buildConsoleEnvelope).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('preserves a concrete per-harness launch instead of broadening every Scout goal', async () => {
    await call({ workspaceId: 'ws-test', harnessSlug: 'papercusp' });

    expect(buildConsoleEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-test', slug: 'papercusp' }),
    );
    const spawn = spawnHeadlessMock.mock.calls[0][0] as { envelope: { greetingCmd: string } };
    expect(spawn.envelope.greetingCmd).toContain('--harness=papercusp');
    expect(loadHarnessRegistry).not.toHaveBeenCalled();
    expect(resolveHomePotSlug).not.toHaveBeenCalled();
  });

  it('also launches the optional drain member in the resolved home Pot', async () => {
    vi.mocked(drainFleetAutoMintEnabled).mockResolvedValue(true);
    vi.mocked(mintDrainFleetForGoal).mockResolvedValue({
      fleetSlug: 'drain-test',
    } as Awaited<ReturnType<typeof mintDrainFleetForGoal>>);

    const result = await call({ workspaceId: 'ws-test', harnessSlug: 'ws-test' });

    expect(result.warnings).toEqual([]);
    expect(result.drainFleet).toBe('drain-test');
    expect(mintDrainFleetForGoal).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'home-pot' }));
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(2);
    for (const [args] of spawnHeadlessMock.mock.calls) {
      const spawn = args as { envelope: { greetingCmd: string } };
      expect(spawn.envelope.greetingCmd).toContain('--harness=home-pot');
      expect(spawn.envelope.greetingCmd).not.toContain('--harness=ws-test');
    }
  });

  it('still rolls back a workspace goal when its launch fails', async () => {
    spawnHeadlessMock.mockResolvedValue({
      status: 'error',
      error: 'simulated launch refusal',
    } as unknown as SpawnConsoleResult);

    await expect(call({ workspaceId: 'ws-test', harnessSlug: 'ws-test' })).rejects.toThrow(/goal rolled back/);
    expect(buildConsoleEnvelope).toHaveBeenCalledWith(expect.objectContaining({ slug: 'home-pot' }));
    expect(replaceBlockedByMock).toHaveBeenCalled();
    expect(setModeCalls.some((entry) => entry.enabled === false)).toBe(true);
    expect(order).toContain('delete');
  });

  it.each([null, 'unregistered-other-workspace-pot'])('refuses invalid home %s before any side effects', async (home) => {
    vi.mocked(resolveHomePotSlug).mockResolvedValue(home);

    await expect(call({ workspaceId: 'ws-test', harnessSlug: 'ws-test' })).rejects.toThrow(/no registered home Pot/);
    expect(order).toEqual([]);
    expect(buildConsoleEnvelope).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('does not misclassify a registered harness sharing the workspace name', async () => {
    vi.mocked(loadHarnessRegistry).mockResolvedValue({
      projects: [{ slug: 'ws-test', harness_kind: 'hive' }],
    } as Awaited<ReturnType<typeof loadHarnessRegistry>>);

    await call({ workspaceId: 'ws-test', harnessSlug: 'ws-test' });

    expect(resolveHomePotSlug).not.toHaveBeenCalled();
    expect(sqlLog.find((entry) => /INSERT/i.test(entry.text))!.values[1]).toBe('ws-test');
    expect(buildConsoleEnvelope).toHaveBeenCalledWith(expect.objectContaining({ slug: 'ws-test' }));
  });

  it('fails closed if the workspace registry cannot be read', async () => {
    vi.mocked(loadHarnessRegistry).mockRejectedValueOnce(new Error('registry unavailable'));

    await expect(call({ workspaceId: 'ws-test', harnessSlug: 'ws-test' })).rejects.toThrow('registry unavailable');
    expect(order).toEqual([]);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });
});

describe('goal-auto-start — blocked-by edge wiring (P-004)', () => {
  it('rolls back rather than spawning a non-standing holder with missing operating inputs', async () => {
    goalLaunchMocks.resolve.mockResolvedValue({
      effective: {}, refusal: null, goalBrief: null,
      holderReadiness: {
        canExecute: false,
        issues: [{ code: 'missing-kill-criterion', required: true, action: 'Set a checkable kill criterion.' }],
      },
    });
    await expect(call()).rejects.toThrow('goal_operating_inputs_missing');
    expect(order).toContain('delete');
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });
  it('threads the resolver portfolio into the canonical first-turn brief', async () => {
    const portfolio = { schemaVersion: 1, goal: { id: 'goal-portfolio' } };
    goalLaunchMocks.resolve.mockResolvedValue({
      effective: {},
      refusal: null,
      goalBrief: { portfolio },
    });

    await call();

    expect(goalLaunchMocks.buildBrief).toHaveBeenCalledWith(expect.objectContaining({ portfolio }));
  });

  it('threads the canonical goal-history projection into the automated first-turn brief', async () => {
    const history = {
      status: 'available',
      brief: { fingerprint: 'automated-goal-history' },
      recovery: { tool: 'goals:get', args: { id: 'generated', detail: 'full' } },
    };
    goalHistoryMocks.read.mockResolvedValue(history);

    await call();

    expect(goalHistoryMocks.read).toHaveBeenCalledTimes(1);
    expect(goalLaunchMocks.buildBrief).toHaveBeenCalledWith(expect.objectContaining({ history }));
  });

  it('no blockedBy ⇒ no edge write and no readiness read — the pre-P-004 path unchanged', async () => {
    const res = await call();
    expect(res.goalId).toBeTruthy();
    expect(res.startBlockedOverride).toBeNull();
    expect(applyBlockedByMock).not.toHaveBeenCalled();
    expect(readinessMock).not.toHaveBeenCalled();
  });

  it("applies the edges with the rail's provenance (createdBy = launchedBy default)", async () => {
    await call({ blockedBy: ['WI-100'] });
    expect(applyBlockedByMock).toHaveBeenCalledTimes(1);
    const opts = applyBlockedByMock.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.refs).toEqual(['WI-100']);
    expect(opts.createdBy).toBe('scout-goal-rail');
  });

  it('a refused edge set unwinds the goal row — no gate read, no stamp, no spawn', async () => {
    applyBlockedByMock.mockImplementation(async () => {
      order.push('deps-apply');
      return { ok: false, problem: 'refs do not resolve: nope' };
    });
    await expect(call({ blockedBy: ['nope'] })).rejects.toThrow(/refs do not resolve/);
    expect(order).toContain('delete');
    expect(readinessMock).not.toHaveBeenCalled();
    expect(setModeCalls).toHaveLength(0);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });
});

describe('goal-auto-start — the activation gate (P-004)', () => {
  it('refuses ONCE on unsatisfied blockers, BEFORE the mode stamp: edges cleared, row deleted, nothing spawned', async () => {
    readinessMock.mockImplementation(async () => {
      order.push('readiness');
      return pendingReadiness();
    });
    await expect(call({ blockedBy: ['other-goal-ab12cd', 'WI-100'] })).rejects.toThrow(
      /other-goal-ab12cd.*startBlocked/s,
    );
    // The gate sits between the edge write and the (never-reached) stamp.
    expect(order.indexOf('readiness')).toBeGreaterThan(order.indexOf('deps-apply'));
    expect(setModeCalls).toHaveLength(0);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    // Rollback: edges cleared and the row deleted.
    expect(replaceBlockedByMock).toHaveBeenCalled();
    expect(order).toContain('delete');
  });

  it('the refusal names the stub-then-arm alternative (D-004)', async () => {
    readinessMock.mockImplementation(async () => {
      order.push('readiness');
      return pendingReadiness();
    });
    await expect(call({ blockedBy: ['other-goal-ab12cd'] })).rejects.toThrow(/goals:create/);
  });

  it('startBlocked: true overrides — starts, and records the reason verbatim on the result', async () => {
    readinessMock.mockImplementation(async () => {
      order.push('readiness');
      return pendingReadiness();
    });
    const res = await call({
      blockedBy: ['other-goal-ab12cd'],
      startBlocked: true,
      startBlockedReason: 'prerequisite lands tomorrow; scaffolding can start today',
    });
    expect(res.startBlockedOverride).toBe('prerequisite lands tomorrow; scaffolding can start today');
    expect(spawnHeadlessMock).toHaveBeenCalled();
    // The override changes the verdict, never the order: stamp still precedes spawn.
    expect(order.indexOf('mode-set')).toBeGreaterThan(-1);
    expect(order.indexOf('mode-set')).toBeLessThan(order.indexOf('spawn'));
  });

  it('startBlocked with NO reason records the unsatisfied blockers as the override note', async () => {
    readinessMock.mockImplementation(async () => {
      order.push('readiness');
      return pendingReadiness();
    });
    const res = await call({ blockedBy: ['other-goal-ab12cd'], startBlocked: true });
    expect(String(res.startBlockedOverride)).toContain('other-goal-ab12cd');
  });

  it('an ACTIONABLE blockedBy set passes with NO override recorded — startBlocked is not sticky', async () => {
    const res = await call({ blockedBy: ['WI-100'], startBlocked: true });
    expect(res.startBlockedOverride).toBeNull();
  });
});

describe('goal-auto-start — edge cleanup on every unwind path (P-004)', () => {
  it('a mode-stamp failure with blockedBy clears the edges before deleting the row', async () => {
    setModeMock.mockImplementation(async (opts: SetModeCall) => {
      setModeCalls.push(opts);
      order.push('mode-set');
      return { ok: false, error: 'sticky conflict' };
    });
    await expect(call({ blockedBy: ['WI-100'] })).rejects.toThrow(/GOAL mode/);
    expect(replaceBlockedByMock).toHaveBeenCalled();
    expect(order.indexOf('deps-clear')).toBeLessThan(order.lastIndexOf('delete'));
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('a spawn failure with blockedBy rolls back edges, mode and row', async () => {
    spawnHeadlessMock.mockImplementation(async () => {
      order.push('spawn');
      return { status: 'error', error: 'no slots' } as unknown as SpawnConsoleResult;
    });
    await expect(call({ blockedBy: ['WI-100'] })).rejects.toThrow(/failed to launch/);
    expect(replaceBlockedByMock).toHaveBeenCalled();
    expect(setModeCalls.some((c) => c.enabled === false)).toBe(true);
    expect(order).toContain('delete');
  });
});

describe('goal-auto-start — the D-005 both-rails requirement (pre-existing rule, pinned UNCHANGED by P-004)', () => {
  // D-004's closing invariant: adding blocked-by edges + the activation gate
  // must not loosen the autonomous-creation rails. Both rails refuse BEFORE any
  // row is written — no insert, no edges, no spawn to unwind.
  it('refuses an empty kill criterion before any side effect', async () => {
    await expect(call({ killCriterion: '   ' })).rejects.toThrow(/kill criterion \(D-005\)/);
    expect(sqlLog).toHaveLength(0);
    expect(applyBlockedByMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('refuses a negative or non-finite budgetCents ceiling before any side effect', async () => {
    await expect(call({ budgetCents: -1 })).rejects.toThrow(/budgetCents ceiling \(D-005\)/);
    await expect(call({ budgetCents: Number.NaN })).rejects.toThrow(/budgetCents ceiling \(D-005\)/);
    expect(sqlLog).toHaveLength(0);
    expect(applyBlockedByMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });
});
