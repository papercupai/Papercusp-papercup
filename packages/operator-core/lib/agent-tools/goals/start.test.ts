/**
 * goals:start — the durable-before-spawn contract (goals-tab-improvement-2026-08-09 P-015).
 *
 * What is pinned here is not "does it insert a row" but the three properties a
 * three-call client-side version cannot have, each of which has a real failure
 * behind it:
 *
 *   1. The mode stamp is written BEFORE the spawn. It is what the agent reads on
 *      its first orient, so writing it after is a race against the agent's own
 *      boot — and losing that race is EI-20015592992797890 exactly: goals and
 *      goal-mode sessions coexisting with nothing joining them.
 *   2. The spawned command carries the SAME pre-pinned owner id the stamp names.
 *      A stamp on some other id is indistinguishable from no stamp at all.
 *   3. A reported launch failure runs compensating cleanup. The dispatcher
 *      transaction must not span an awaited spawn, where caller cancellation
 *      could otherwise roll back the row behind a live holder.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/goals/start.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnConsoleResult } from '../../console-spawn';
import type { GoalPortfolioBrief } from '../../goal-launch-settings';
import type { GoalHistoryContext } from '../../prior-attempt-context';

const orgSql = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: orgSql as never }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../papercusp-root', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  papercuspPathForWorkspace: () => '/tmp/papercusp-ws',
}));
vi.mock('../../mcp-base-url', () => ({ resolveSpawnHostOperatorBaseUrl: () => 'http://127.0.0.1:3070' }));
const buildConsoleEnvelopeMock = vi.hoisted(() => vi.fn(async (_opts: unknown) => ({
    cwd: '/repo',
    env: { PAPERCUSP_SID: 'su-caller' },
    greetingCmd: '',
    mcpJsonContents: '',
  })));
vi.mock('../../console-launcher', () => ({
  buildConsoleEnvelope: (opts: unknown) => buildConsoleEnvelopeMock(opts),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({
    ownerId: 'su-caller',
    ownerLabel: 'su',
    source: 'psu',
    workspaceId: 'ws-test',
    userId: null,
  }),
}));

const identityReceipt = { marker: 'goal-component-bound' };
const bindIdentityMock = vi.fn(async (_input: unknown) => identityReceipt);
vi.mock('../../agent-identities/source', () => ({
  bindSelectedIdentityOutputs: (input: unknown) => bindIdentityMock(input),
}));

/** Every side effect, in the order it happened — property (1) is an ORDER claim. */
const order: string[] = [];

// Typed against the REAL SpawnConsoleResult so these mocks cannot drift from the
// spawn contract (the WI-4488 lesson: inferred-shape mocks went stale silently).
// Pinned to the `ok` VARIANT, not the whole union: spreading a union-typed value
// distributes over BOTH members, so `{ ...okSpawn(), … }` also produced a
// status:'error' branch carrying ok-only fields, which is assignable to neither.
type OkSpawn = Extract<SpawnConsoleResult, { status: 'ok' }>;
const okSpawn = (): OkSpawn => ({
  status: 'ok',
  pid: 4242,
  terminal: 'xterm',
  child: {} as never,
  display: ':1',
  desktopEnvResolvedVia: 'active-seat',
});
const spawnConsoleMock = vi.fn(async (_opts: unknown): Promise<SpawnConsoleResult> => {
  order.push('spawn');
  return okSpawn();
});
const spawnHeadlessMock = vi.fn(async (_opts: unknown): Promise<SpawnConsoleResult> => {
  order.push('spawn');
  return { ...okSpawn(), terminal: 'headless', pid: 777, display: null, desktopEnvResolvedVia: null };
});
vi.mock('../../console-spawn', () => ({
  spawnConsole: (o: unknown) => spawnConsoleMock(o),
  spawnHeadless: (o: unknown) => spawnHeadlessMock(o),
}));

type SetModeCall = { ownerId: string; modeId: string; enabled: boolean; subject?: string | null };
const setModeCalls: SetModeCall[] = [];
const setModeMock = vi.fn(async (opts: SetModeCall) => {
  setModeCalls.push(opts);
  order.push(opts.enabled ? 'mode-set' : 'mode-clear');
  return { ok: true };
});
vi.mock('../../modes/store', () => ({ setMode: (o: SetModeCall) => setModeMock(o) }));

const sourceWorkItemStamp = vi.hoisted(() => ({
  stamp: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('../../work-items', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  stampWorkItemGoalAtStart: (...args: unknown[]) => sourceWorkItemStamp.stamp(...args),
  clearWorkItemGoalAtStart: (...args: unknown[]) => sourceWorkItemStamp.clear(...args),
}));

// P-001 (goal-mode-design-intent-hardening-2026-08-16): the drain-fleet mint is
// mocked as a seam — its OWN row-level behavior is pinned in
// lib/goals/drain-fleet-mint.test.ts; what THIS file pins is the wiring: when it
// runs, what happens to it on rollback, and that a mint failure never fails the
// goal start.
let automintEnabled = true;
const mintMock = vi.fn(async (_a: unknown) => {
  order.push('drain-mint');
  return { fleetSlug: 'goal-drain-test', created: true, specRevision: 1 };
});
const teardownMock = vi.fn(async (_a: unknown) => {
  order.push('drain-teardown');
});
const registerLeaderMock = vi.fn(async (_a: unknown): Promise<{
  registered: boolean; coupled: boolean; warning: string | null;
}> => ({ registered: true, coupled: true, warning: null }));
vi.mock('../../goals/drain-fleet-mint', () => ({
  drainFleetAutoMintEnabled: async () => automintEnabled,
  mintDrainFleetForGoal: (a: unknown) => mintMock(a),
  registerGoalDrainFleetLeader: (a: unknown) => registerLeaderMock(a),
  teardownDrainFleetMint: (a: unknown) => teardownMock(a),
}));

// P-004 (goal-dag-shared-substrate-2026-08-18): the dependency substrate is
// mocked as a seam — its OWN row-level semantics (resolve-validated writes, the
// cycle guard, the verdict fold) are pinned in
// packages/agent-mcp/src/tools/goals/goal-deps.test.ts; what THIS file pins is
// the wiring: when the activation gate reads readiness, what a refusal rolls
// back, and how the override is recorded.
type Readiness = {
  actionable: boolean;
  premiseInvalidated: boolean;
  blockers: Array<{ kind: string; ref: string; status: string | null; verdict: string }>;
};
const ACTIONABLE: Readiness = { actionable: true, premiseInvalidated: false, blockers: [] };
const applyBlockedByMock = vi.fn(
  async (_sql: unknown, _o: unknown): Promise<{ ok: true; blockers: unknown[] } | { ok: false; problem: string }> => ({
    ok: true,
    blockers: [],
  }),
);
const readinessMock = vi.fn(async (_sql: unknown, _ws: unknown, _id: unknown): Promise<Readiness> => ACTIONABLE);
const replaceBlockedByMock = vi.fn(async (_sql: unknown, _o: unknown) => {
  order.push('deps-clear');
});
vi.mock('@papercusp/agent-mcp/goal-deps', async (orig) => ({
  // Keep every other export real: the same module file is reached by relative
  // path from goals:create / goals:update inside the agent-mcp tool index.
  ...(await orig<Record<string, unknown>>()),
  applyGoalBlockedBy: (s: unknown, o: unknown) => applyBlockedByMock(s, o),
  readGoalReadiness: (s: unknown, w: unknown, g: unknown) => readinessMock(s, w, g),
  replaceGoalBlockedBy: (s: unknown, o: unknown) => replaceBlockedByMock(s, o),
}));

const goalsStart = (await import('./start')).default;
const { bindGoalLaunchIdentity, buildGoalKickoffBrief } = await import('./start');
const { buildAgentLaunchCommand } = await import('../../agent-launch-core');

/** SQL the handler actually issued, as (text, values) pairs. */
const sql: Array<{ text: string; values: unknown[] }> = [];
const idempotencyRows = new Map<string, {
  summary: Record<string, unknown>;
  launchedAt: number;
  launchedBy: string | null;
}>();
let currentGoalArgs: Record<string, unknown> = {};
// Happy paths exercise launch ordering with a fresh, authoritative measurement.
// Null deliberately retains the all-empty ledger refusal for the negative control.
let measuredSpendCents: number | null = 100;
const runSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join(' ? ');
  sql.push({ text, values });
  order.push(/INSERT/i.test(text) ? 'insert' : /DELETE/i.test(text) ? 'delete' : 'sql');
  if (text.includes('harness_shared.agent_launch_idempotency')) {
    if (/INSERT INTO/i.test(text)) {
      const [workspaceId, key, launchedAt, launchedBy, summaryJson] = values as [
        string, string, number, string | null, string,
      ];
      const storageKey = `${workspaceId}:${key}`;
      if (idempotencyRows.has(storageKey)) return Promise.resolve([]);
      idempotencyRows.set(storageKey, {
        summary: JSON.parse(summaryJson) as Record<string, unknown>,
        launchedAt,
        launchedBy,
      });
      return Promise.resolve([{ idempotency_key: key }]);
    }
    if (/UPDATE/i.test(text)) {
      const [summaryJson, workspaceId, key] = values as [string, string, string];
      const row = idempotencyRows.get(`${workspaceId}:${key}`);
      if (!row) return Promise.resolve([]);
      row.summary = JSON.parse(summaryJson) as Record<string, unknown>;
      return Promise.resolve([{ idempotency_key: key }]);
    }
    if (/SELECT summary, launched_at, launched_by/i.test(text)) {
      const [workspaceId, key] = values as [string, string];
      const row = idempotencyRows.get(`${workspaceId}:${key}`);
      return Promise.resolve(
        row ? [{ summary: row.summary, launched_at: row.launchedAt, launched_by: row.launchedBy }] : [],
      );
    }
    if (/DELETE/i.test(text) && text.includes('idempotency_key =')) {
      const [workspaceId, key] = values as [string, string];
      const removed = idempotencyRows.delete(`${workspaceId}:${key}`);
      return Promise.resolve(removed ? [{ idempotency_key: key }] : []);
    }
    return Promise.resolve([]);
  }
  if (text.includes('SELECT title, body, kill_criterion, standing,')) {
    return Promise.resolve([{
      title: currentGoalArgs.title,
      body: currentGoalArgs.body ?? null,
      kill_criterion: currentGoalArgs.killCriterion ?? null,
      standing: currentGoalArgs.standing === true,
      launch_settings: null,
      budget_cents: currentGoalArgs.budgetCents ?? null,
      budget_window_sec: currentGoalArgs.budgetWindowSec ?? null,
      spent_cents: measuredSpendCents,
      spent_cents_breakdown: null,
      spent_cents_at: new Date().toISOString(),
      spent_cents_source: 'goal-lineage-rollup',
      interactive_usage_freshness_status: 'fresh',
      interactive_usage_last_ingested_at_ms: Date.now(),
      drain_fleet: null,
    }]);
  }
  if (text.includes('WITH goal_row AS')) {
    return Promise.resolve([{
      status: 'active', tripwires: currentGoalArgs.tripwires ?? [],
      pots: [], plans: [], queue: {}, drain_fleet: null,
    }]);
  }
  return Promise.resolve([]);
};
orgSql.mockImplementation(runSql);
const forbiddenWorkspaceTx = vi.fn(() => {
  throw new Error('goals:start must use the autocommit org SQL handle, not ctx.tx');
});
const ctx = {
  workspaceId: 'ws-test',
  harnessSlug: 'papercusp',
  role: 'su',
  tx: forbiddenWorkspaceTx,
} as never;

const ARGS = {
  title: 'Ship a paid app',
  killCriterion: 'no paying user by day 30',
  budgetCents: 50_000,
  /*
   * DECLARED because the door now requires it (goal-live-holder-guarantee
   * 2026-08-18 P-003): this tool spawns the session that holds the goal, so a
   * goal created here without stating whether it needs a live holder is exactly
   * what that item refuses. In the shared fixture rather than per test, so the
   * tests below keep testing what they are named for; the refusal is exercised
   * by overriding it to undefined.
   */
  holder: { requireLive: true },
};

const call = (extra: Record<string, unknown> = {}) => {
  currentGoalArgs = { ...ARGS, ...extra };
  return (goalsStart as unknown as { handler: (a: unknown, c: unknown) => Promise<unknown> }).handler(
    currentGoalArgs, ctx,
  );
};
const dataOf = (res: unknown) => (res as { data: Record<string, unknown> }).data;
const textOf = (res: unknown) => (res as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '';
const isError = (res: unknown) => !!(res as { isError?: boolean }).isError;

beforeEach(() => {
  vi.clearAllMocks();
  currentGoalArgs = { ...ARGS };
  measuredSpendCents = 100;
  order.length = 0;
  sql.length = 0;
  idempotencyRows.clear();
  setModeCalls.length = 0;
  automintEnabled = true;
  mintMock.mockImplementation(async () => {
    order.push('drain-mint');
    return { fleetSlug: 'goal-drain-test', created: true, specRevision: 1 };
  });
  registerLeaderMock.mockImplementation(async () => ({ registered: true, coupled: true, warning: null }));
  spawnConsoleMock.mockImplementation(async () => {
    order.push('spawn');
    return okSpawn();
  });
  spawnHeadlessMock.mockImplementation(async () => {
    order.push('spawn');
    return { ...okSpawn(), terminal: 'headless', pid: 777, display: null, desktopEnvResolvedVia: null };
  });
  setModeMock.mockImplementation(async (opts: SetModeCall) => {
    setModeCalls.push(opts);
    order.push(opts.enabled ? 'mode-set' : 'mode-clear');
    return { ok: true };
  });
  sourceWorkItemStamp.stamp.mockImplementation(async () => {
    order.push('source-stamp');
    return { ok: true, changed: true };
  });
  sourceWorkItemStamp.clear.mockImplementation(async () => {
    order.push('source-clear');
    return true;
  });
  applyBlockedByMock.mockImplementation(async () => ({ ok: true, blockers: [] }));
  readinessMock.mockImplementation(async () => ACTIONABLE);
  replaceBlockedByMock.mockImplementation(async () => {
    order.push('deps-clear');
  });
});

/**
 * The ordering predicate, extracted so it can be shown to DISCRIMINATE.
 *
 * An assertion of the form "the recorded order contains these steps" passes for
 * the broken implementation too, so the check itself is tested against a wrong
 * order below — otherwise a guard that can never fail reads exactly like a
 * guard that is being satisfied.
 */
export function stampPrecedesSpawn(recorded: string[]): boolean {
  const stamp = recorded.indexOf('mode-set');
  const spawn = recorded.indexOf('spawn');
  return stamp !== -1 && spawn !== -1 && stamp < spawn;
}

describe('goals:start measured budget prerequisite', () => {
  it('refuses an empty spend ledger before opening any holder', async () => {
    measuredSpendCents = null;
    const result = await call();
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('spend CANNOT BE MEASURED');
    expect(textOf(result)).toContain('no goal-attributed, pot, or session usage samples');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('refuses a fresh authoritative measurement at the declared ceiling', async () => {
    measuredSpendCents = ARGS.budgetCents;
    const result = await call();
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('budget');
    expect(textOf(result)).not.toContain('CANNOT BE MEASURED');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });
});

describe('the ordering predicate itself', () => {
  it('accepts stamp-then-spawn and REJECTS spawn-then-stamp', () => {
    expect(stampPrecedesSpawn(['insert', 'mode-set', 'spawn'])).toBe(true);
    // The naive three-call implementation this tool replaces: spawn, then stamp.
    expect(stampPrecedesSpawn(['insert', 'spawn', 'mode-set'])).toBe(false);
    // Never-stamped is the EI-20015592992797890 shape, and must not pass either.
    expect(stampPrecedesSpawn(['insert', 'spawn'])).toBe(false);
  });
});

describe('goals:start — the happy path', () => {
  it('replays the same start result for an identical request key without spawning twice', async () => {
    const first = await call({ requestKey: 'composer-request-1' });
    const replay = await call({ requestKey: 'composer-request-1' });

    expect(isError(first)).toBe(false);
    expect(isError(replay)).toBe(false);
    expect(dataOf(replay)).toMatchObject({
      id: dataOf(first).id,
      agent_owner_id: dataOf(first).agent_owner_id,
    });
    expect(sql.filter((entry) => /INSERT INTO harness_shared\.goals/i.test(entry.text))).toHaveLength(1);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
  });

  it('refuses reuse of a request key when normalized arguments change before any new side effect', async () => {
    await call({ requestKey: 'composer-request-2' });
    const changed = await call({ requestKey: 'composer-request-2', title: 'Ship another app' });

    expect(isError(changed)).toBe(true);
    expect(textOf(changed)).toContain('different goal arguments or scope');
    expect(sql.filter((entry) => /INSERT INTO harness_shared\.goals/i.test(entry.text))).toHaveLength(1);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
  });

  it('returns in-progress for a duplicate while the first request is still spawning', async () => {
    const finishSpawn: { resolve?: (result: SpawnConsoleResult) => void } = {};
    spawnConsoleMock.mockImplementationOnce(() =>
      new Promise((resolve) => {
        finishSpawn.resolve = resolve;
      }),
    );
    const firstPromise = call({ requestKey: 'composer-request-3' });
    await vi.waitFor(() => expect(spawnConsoleMock).toHaveBeenCalledTimes(1));

    const duplicate = await call({ requestKey: 'composer-request-3' });
    expect(isError(duplicate)).toBe(true);
    expect(textOf(duplicate)).toContain('already in progress');
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);

    if (!finishSpawn.resolve) throw new Error('spawn resolver was not installed before the duplicate check');
    finishSpawn.resolve(okSpawn());
    expect(isError(await firstPromise)).toBe(false);
  });

  it('releases the request claim after a spawn rollback so a safe retry can start', async () => {
    spawnConsoleMock.mockImplementationOnce(async () => ({ status: 'error', error: 'no display' }) as SpawnConsoleResult);
    const failed = await call({ requestKey: 'composer-request-4' });
    const retry = await call({ requestKey: 'composer-request-4' });

    expect(isError(failed)).toBe(true);
    expect(isError(retry)).toBe(false);
    expect(sql.filter((entry) => /DELETE FROM harness_shared\.agent_launch_idempotency/i.test(entry.text) && entry.text.includes('idempotency_key ='))).toHaveLength(1);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(2);
  });

  it('pins a bounded current-build holder to its spawn host and leaves the default stable', async () => {
    expect(isError(await call({ mcpTarget: 'spawn-host' }))).toBe(false);
    const abInput = buildConsoleEnvelopeMock.mock.calls[0]?.[0] as { operatorBaseUrl: string; agentMcpBaseUrl?: string };
    expect(abInput.agentMcpBaseUrl).toBe(abInput.operatorBaseUrl);
    buildConsoleEnvelopeMock.mockClear();
    expect(isError(await call())).toBe(false);
    expect(buildConsoleEnvelopeMock.mock.calls[0]?.[0]).not.toHaveProperty('agentMcpBaseUrl');
  });

  it('writes the goal, stamps the mode, THEN spawns', async () => {
    const res = await call();
    expect(isError(res)).toBe(false);
    expect(stampPrecedesSpawn(order)).toBe(true);
    expect(orgSql).toHaveBeenCalled();
    expect(forbiddenWorkspaceTx).not.toHaveBeenCalled();
    expect(order.filter((o) => o === 'insert')).toHaveLength(1);
    expect(order).not.toContain('delete');
  });

  it('stamps GOAL mode with the goal id as its SUBJECT', async () => {
    const res = await call();
    const goalId = dataOf(res).id as string;
    expect(setModeCalls).toHaveLength(2);
    expect(setModeCalls[0].modeId).toBe('goal');
    expect(setModeCalls[0].enabled).toBe(true);
    expect(setModeCalls[0].subject).toBe(goalId);
    expect(setModeCalls[1].modeId).toBe('auto');
    expect(setModeCalls[1].ownerId).toBe(dataOf(res).drain_leader_owner_id);
  });

  it('spawns the SAME owner id it stamped, pre-pinned via --owner-id', async () => {
    const res = await call();
    const ownerId = dataOf(res).agent_owner_id as string;
    const goalId = dataOf(res).id as string;
    expect(ownerId).toMatch(/^su-[0-9a-f-]{36}$/);
    // The stamp names the agent that is about to exist...
    expect(setModeCalls[0].ownerId).toBe(ownerId);
    // ...and the launch pins that exact identity, which is the only thing that
    // makes writing-before-spawning meaningful.
    const cmd = (spawnConsoleMock.mock.calls[0][0] as { envelope: { greetingCmd: string } }).envelope.greetingCmd;
    expect(cmd).toContain(`--owner-id=${ownerId}`);
    expect(cmd).toContain(`--goal-bootstrap-subject=${goalId}`);
  });

  it("delivers the goal as the agent's first turn via the env, not the command line", async () => {
    const res = await call();
    const env = (spawnConsoleMock.mock.calls[0][0] as { envelope: { env: Record<string, string> } }).envelope.env;
    const brief = env.PAPERCUSP_KICKOFF_PROMPT;
    expect(brief).toContain(dataOf(res).id as string);
    expect(brief).toContain('Ship a paid app');
    expect(brief).toContain('no paying user by day 30');
    // Free-form prose must never ride the greeting one-liner.
    const cmd = (spawnConsoleMock.mock.calls[0][0] as { envelope: { greetingCmd: string } }).envelope.greetingCmd;
    expect(cmd).not.toContain('Ship a paid app');
  });

  it('pins the exact successful kickoff through the selected GOAL component without changing delivery', async () => {
    const metadata = vi.fn();
    const res = await (goalsStart as unknown as {
      handler: (a: unknown, c: unknown) => Promise<unknown>;
    }).handler(ARGS, { ...(ctx as object), metadata });
    expect(isError(res)).toBe(false);
    const env = (spawnConsoleMock.mock.calls[0][0] as {
      envelope: { env: Record<string, string> };
    }).envelope.env;
    expect(metadata).toHaveBeenCalledTimes(1);
    const receipt = metadata.mock.calls[0]![0].identityContributions;
    expect(receipt).toBe(identityReceipt);
    expect(bindIdentityMock).toHaveBeenCalledTimes(1);
    const binding = bindIdentityMock.mock.calls[0]![0] as {
      identityId: string;
      outputs: Array<{ contributionId: string; value?: unknown; omission?: { reason: string } }>;
    };
    expect(binding.identityId).toBe('su.mode-goal');
    expect(binding.outputs[0]).toMatchObject({ contributionId: 'current-mode-state', value: { ok: true } });
    expect(binding.outputs[1]).toEqual({
      contributionId: 'goal-kickoff', value: env.PAPERCUSP_KICKOFF_PROMPT,
    });
    expect(binding.outputs[2]).toEqual({
      contributionId: 'goal-portfolio', value: expect.stringContaining('Operating inputs: incomplete'),
    });
    expect(env.PAPERCUSP_KICKOFF_PROMPT).toContain(dataOf(res).id as string);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
  });

  it('records an explicit mode-state omission when a recovery kickoff precedes GOAL attachment', async () => {
    const receipt = await bindGoalLaunchIdentity({
      goalId: 'goal-1', ownerId: 'su-recovery', workspaceId: 'ws-test',
      kickoff: 'recovery GOAL kickoff', portfolio: null,
    }, bindIdentityMock as never);
    expect(receipt).toBe(identityReceipt);
    expect(bindIdentityMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      scope: expect.objectContaining({ sink: 'launch' }),
      outputs: expect.arrayContaining([
        { contributionId: 'current-mode-state', omission: { reason: 'not-requested' } },
        { contributionId: 'goal-portfolio', omission: { reason: 'ineligible' } },
      ]),
    }));
  });

  it('R-4 / D-032: a baseline arm stamps kickoff and portfolio as experiment-arm; brief-only and full keep the bytes', async () => {
    const outputsFor = async (behaviorArm: 'baseline' | 'brief-only' | 'full' | undefined) => {
      bindIdentityMock.mockClear();
      await bindGoalLaunchIdentity({
        goalId: 'goal-arm', ownerId: 'su-arm', workspaceId: 'ws-test',
        kickoff: 'GOAL kickoff', portfolio: 'GOAL PORTFOLIO SNAPSHOT', modeState: [], behaviorArm,
      }, bindIdentityMock as never);
      return (bindIdentityMock.mock.calls[0] as unknown as [{ outputs: unknown[] }])[0].outputs;
    };
    expect(await outputsFor('baseline')).toEqual(expect.arrayContaining([
      { contributionId: 'goal-kickoff', omission: { reason: 'experiment-arm' } },
      { contributionId: 'goal-portfolio', omission: { reason: 'experiment-arm' } },
    ]));
    for (const arm of ['brief-only', 'full', undefined] as const) {
      expect(await outputsFor(arm)).toEqual(expect.arrayContaining([
        { contributionId: 'goal-kickoff', value: 'GOAL kickoff' },
        { contributionId: 'goal-portfolio', value: 'GOAL PORTFOLIO SNAPSHOT' },
      ]));
    }
  });

  it('reads goal history in the production handler and injects it into the kickoff env', async () => {
    const priorAttempts = await import('../../prior-attempt-context');
    const history: GoalHistoryContext = {
      status: 'available',
      brief: {
        schemaVersion: 'prior-attempt-brief-v1',
        status: 'available',
        target: { kind: 'goal', ref: 'resolved-at-runtime' },
        fanOut: { admitted: 0, total: 0, cap: 24, truncated: false },
        degradedSources: [],
        omittedDescendants: [],
        omittedDescendantsTruncated: false,
        fingerprint: 'goal-start-handler-history-fingerprint',
        authority: [],
        residue: [],
        attempts: [
          {
            authority: 'checkpoint',
            scope: 'goal-wide',
            rawRef: 'goal-history#production-handler-proof',
            text: 'PRODUCTION HANDLER HISTORY MARKER',
          },
        ],
        rawRefs: ['goal-history#production-handler-proof'],
        protectedRefs: { authority: [], residue: [] },
        omission: {
          omittedRecords: 0,
          omittedByAuthority: {},
          omittedRefs: [],
          omittedRefsTruncated: false,
          sourceCount: 1,
          deduplicatedCount: 1,
          truncated: false,
        },
        estimatedTokens: 40,
        serializedChars: 160,
      },
      recovery: { tool: 'goals:get', args: { id: 'resolved-at-runtime', detail: 'full' } },
    };
    const readHistory = vi.spyOn(priorAttempts, 'readGoalHistoryContext').mockResolvedValueOnce(history);

    try {
      const res = await call();
      const goalId = dataOf(res).id as string;
      const env = (spawnConsoleMock.mock.calls[0][0] as { envelope: { env: Record<string, string> } }).envelope.env;

      expect(readHistory).toHaveBeenCalledTimes(1);
      expect(readHistory).toHaveBeenCalledWith(goalId);
      expect(env.PAPERCUSP_KICKOFF_PROMPT).toContain('GOAL HISTORY — own and bounded descendant evidence');
      expect(env.PAPERCUSP_KICKOFF_PROMPT).toContain('goal-start-handler-history-fingerprint');
      expect(env.PAPERCUSP_KICKOFF_PROMPT).toContain('PRODUCTION HANDLER HISTORY MARKER');
    } finally {
      readHistory.mockRestore();
    }
  });

  it('persists the kill criterion and ceiling as columns, not prose', async () => {
    const res = await call();
    const insert = sql.find((s) => /INSERT INTO harness_shared\.goals/i.test(s.text));
    expect(insert).toBeTruthy();
    expect(insert!.text).toContain('kill_criterion');
    expect(insert!.values).toContain('no paying user by day 30');
    expect(insert!.values).toContain(50_000);
    expect(dataOf(res).kill_criterion).toBe('no paying user by day 30');
    expect(dataOf(res).budget_cents).toBe(50_000);
  });

  it('persists and reuses the requested launch profile and ceilings', async () => {
    await call({
      agent: 'claude',
      model: 'sonnet',
      effort: 'xhigh',
      account: 'default',
      carry: 'cold',
      contextSize: 'trimmed',
      compactionLimit: 200_000,
      maxAgents: 3,
      maxPerFleet: 2,
      headless: true,
    });

    const insert = sql.find((s) => /INSERT INTO harness_shared\.goals/i.test(s.text));
    const settings = JSON.parse(String(insert!.values[13]));
    expect(settings).toMatchObject({
      holder: { requireLive: true },
      maxAgents: 3,
      maxPerFleet: 2,
      defaults: {
        agent: 'claude',
        model: 'sonnet',
        effort: 'xhigh',
        account: 'default',
        carry: 'cold',
        contextSize: 'trimmed',
        compactionLimit: 200_000,
        headless: true,
      },
    });

    const goalCommand = (spawnHeadlessMock.mock.calls[0][0] as { envelope: { greetingCmd: string } }).envelope
      .greetingCmd;
    const drainCommand = (spawnHeadlessMock.mock.calls[1][0] as { envelope: { greetingCmd: string } }).envelope
      .greetingCmd;
    const workerCommand = (spawnHeadlessMock.mock.calls[2][0] as { envelope: { greetingCmd: string } }).envelope
      .greetingCmd;
    for (const command of [goalCommand, drainCommand, workerCommand]) {
      expect(command).toContain('--model=sonnet:xhigh');
      expect(command).toContain('--account=default');
      expect(command).toContain('--carry=cold');
      expect(command).toContain('--context-size=trimmed');
      expect(command).toContain('--compaction-limit=200000');
    }
  });

  it('routes a headless launch through spawnHeadless', async () => {
    await call({ headless: true });
    // The goal agent, delegated leader, and drain worker all open headless.
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(3);
    const agentCmd = (spawnHeadlessMock.mock.calls[0][0] as { envelope: { greetingCmd: string } }).envelope.greetingCmd;
    expect(agentCmd).toContain('--owner-id=');
  });
});

describe('goals:start — the standing drain fleet (P-001)', () => {
  it('does not mint or spawn a second actor for an explicit allowedMembers=1 contract', async () => {
    const res = await call({
      inputSchema: {
        type: 'object',
        required: ['allowedMembers'],
        properties: { allowedMembers: { type: 'integer', const: 1 } },
        additionalProperties: false,
      },
      inputs: { allowedMembers: 1 },
    });

    expect(isError(res)).toBe(false);
    expect(mintMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(dataOf(res).drain_fleet).toBeNull();
    const insert = sql.find((s) => /INSERT INTO harness_shared\.goals/i.test(s.text));
    expect(JSON.parse(String(insert!.values[13]))).toMatchObject({ maxAgents: 1, maxPerFleet: 1 });
  });

  it('keeps the drain member when allowedMembers=1 is only an incidental input', async () => {
    const res = await call({ inputs: { allowedMembers: 1 } });

    expect(isError(res)).toBe(false);
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(2);
    expect(dataOf(res).drain_fleet).toBe('goal-drain-test');
  });

  it('mints AFTER the mode stamp and BEFORE the spawn, and reports the fleet', async () => {
    const res = await call();
    const mint = order.indexOf('drain-mint');
    expect(mint).toBeGreaterThan(order.indexOf('mode-set'));
    expect(mint).toBeLessThan(order.indexOf('spawn'));
    expect(dataOf(res).drain_fleet).toBe('goal-drain-test');
    // The mint is FOR the goal and OWNED by the agent being spawned.
    const args = mintMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args.goalId).toBe(dataOf(res).id);
    expect(args.harnessSlug).toBe('papercusp');
    expect(args.agentOwnerId).toBe(dataOf(res).agent_owner_id);
  });

  it('stamps an explicit source work item before minting the goal-fenced drain lane', async () => {
    const sourceWorkItemId = 'EI-source';
    const res = await call({ sourceWorkItemId });

    expect(isError(res)).toBe(false);
    const goalId = dataOf(res).id;
    expect(sourceWorkItemStamp.stamp).toHaveBeenCalledWith(orgSql, {
      id: sourceWorkItemId,
      workspaceId: 'ws-test',
      harness: 'papercusp',
      goalId,
    });
    expect(order.indexOf('source-stamp')).toBeGreaterThan(order.indexOf('insert'));
    expect(order.indexOf('source-stamp')).toBeLessThan(order.indexOf('mode-set'));
    expect(order.indexOf('source-stamp')).toBeLessThan(order.indexOf('drain-mint'));
  });

  it('refuses an un-attributable source item before mode, drain-fleet, or spawn side effects', async () => {
    sourceWorkItemStamp.stamp.mockResolvedValueOnce({ ok: false, reason: 'already_attributed' });

    const res = await call({ sourceWorkItemId: 'EI-owned-elsewhere' });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('already_attributed');
    expect(setModeMock).not.toHaveBeenCalled();
    expect(mintMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(order).toContain('delete');
  });

  it('opens and registers a delegated leader before the worker, without giving the worker the goal brief', async () => {
    await call(); // goal agent itself is NOT headless here
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(2);
    const leader = spawnHeadlessMock.mock.calls[0][0] as {
      envelope: { greetingCmd: string; env: Record<string, string> };
    };
    const member = spawnHeadlessMock.mock.calls[1][0] as {
      envelope: { greetingCmd: string; env: Record<string, string> };
    };
    expect(leader.envelope.greetingCmd).toContain('--owner-id=su-');
    expect(leader.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toContain('delegated leader');
    expect(registerLeaderMock).toHaveBeenCalledWith(expect.objectContaining({
      fleetSlug: 'goal-drain-test', expectedLeaderOwnerId: null,
    }));
    // --fleet is the membership fact: it makes bootstrap-su stamp what
    // getClaimSpec's fleet-inheritance resolves through, so the member pulls
    // the goal-scoped lane instead of the pot-wide default.
    expect(member.envelope.greetingCmd).toContain('--fleet=goal-drain-test');
    expect(member.envelope.greetingCmd).toContain('--headless');
    // The kickoff brief names ONE owner of the goal — a drain bee must not get it.
    expect(member.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toBeUndefined();
  });

  it('tears the mint down when the agent spawn fails', async () => {
    spawnConsoleMock.mockImplementation(async () => {
      order.push('spawn');
      return { status: 'error', error: 'no display' } as unknown as SpawnConsoleResult;
    });
    const res = await call({ sourceWorkItemId: 'EI-source' });
    expect(isError(res)).toBe(true);
    expect(teardownMock).toHaveBeenCalledWith({ workspaceId: 'ws-test', fleetSlug: 'goal-drain-test' });
    const goalId = (sourceWorkItemStamp.stamp.mock.calls[0]?.[1] as { goalId: string } | undefined)?.goalId;
    expect(sourceWorkItemStamp.clear).toHaveBeenCalledWith(orgSql, {
      id: 'EI-source',
      workspaceId: 'ws-test',
      harness: 'papercusp',
      goalId,
    });
    expect(order.indexOf('source-clear')).toBeGreaterThan(order.indexOf('source-stamp'));
    // ...and no drain member is left behind either: the member spawns only
    // after the goal has definitely kept its agent.
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('a mint FAILURE never fails the goal start — fail-soft with a warning', async () => {
    mintMock.mockImplementation(async () => {
      order.push('drain-mint');
      throw new Error('fleet registry down');
    });
    const res = await call();
    expect(isError(res)).toBe(false);
    expect(dataOf(res).drain_fleet).toBeNull();
    expect(String(dataOf(res).warning)).toContain('auto-mint failed');
    // No fleet ⇒ no member spawn, and nothing to tear down on the happy path.
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(teardownMock).not.toHaveBeenCalled();
  });

  it('a member-spawn failure keeps the goal AND the fleet, with a warning', async () => {
    let opens = 0;
    spawnHeadlessMock.mockImplementation(async () => {
      order.push('spawn');
      return ++opens === 2
        ? { status: 'error', error: 'no slots' } as unknown as SpawnConsoleResult
        : { ...okSpawn(), terminal: 'headless', pid: 777, display: null, desktopEnvResolvedVia: null };
    });
    const res = await call(); // agent via spawnConsole (ok); member via spawnHeadless (fails)
    expect(isError(res)).toBe(false);
    expect(dataOf(res).drain_fleet).toBe('goal-drain-test');
    expect(dataOf(res).drain_member_pid).toBeNull();
    expect(String(dataOf(res).warning)).toContain('member failed to launch');
    expect(teardownMock).not.toHaveBeenCalled();
  });

  it('preserves the goal but does not open workers if delegated leadership cannot register', async () => {
    registerLeaderMock.mockResolvedValueOnce({ registered: false, coupled: false, warning: 'CAS lost' });
    const res = await call();
    expect(isError(res)).toBe(false);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(dataOf(res).drain_leader_owner_id).toBeNull();
    expect(dataOf(res).drain_member_pid).toBeNull();
    expect(String(dataOf(res).warning)).toContain('could not be registered');
  });

  it('the flag OFF skips the mint entirely — the watchdog remains the only guard', async () => {
    automintEnabled = false;
    const res = await call();
    expect(isError(res)).toBe(false);
    expect(mintMock).not.toHaveBeenCalled();
    expect(dataOf(res).drain_fleet).toBeNull();
    expect(dataOf(res).warning).toBeUndefined();
  });

  // EI-24556293106348130: the measured shape. Every goal started with
  // maxAgents 2 / maxPerFleet 1 ran a leader-only drain fleet, because the
  // worker launches LAST and the holder + leader had already filled the ceiling.
  it('refuses ceilings that cannot hold the drain worker, before anything is created', async () => {
    const res = await call({ maxAgents: 2, maxPerFleet: 1 });

    expect(isError(res)).toBe(true);
    const text = String((res as { content: Array<{ text: string }> }).content[0].text);
    expect(text).toContain('maxAgents=2');
    expect(text).toContain('maxPerFleet=1');
    expect(text).toContain('allowedMembers'); // this door names its sole-member way out
    expect(mintMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(sql.some((s) => /INSERT INTO harness_shared\.goals/i.test(s.text))).toBe(false);
  });

  it('admits ceilings exactly at the drain floor and still launches the worker', async () => {
    const res = await call({ maxAgents: 3, maxPerFleet: 2 });

    expect(isError(res)).toBe(false);
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(2); // leader + worker
  });

  it('does not apply the drain floor when no drain fleet will be minted', async () => {
    automintEnabled = false;
    const res = await call({ maxAgents: 2, maxPerFleet: 1 });

    expect(isError(res)).toBe(false);
    expect(mintMock).not.toHaveBeenCalled();
  });
});

describe('goals:start — rollback', () => {
  it('deletes the goal and clears the mode when the spawn fails', async () => {
    spawnConsoleMock.mockImplementation(async () => {
      order.push('spawn');
      return { status: 'error', error: 'no display' } as unknown as SpawnConsoleResult;
    });
    const res = await call();
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('ROLLED BACK');
    // Both compensations, and the delete is scoped to the row just written.
    expect(setModeCalls.some((c) => c.enabled === false)).toBe(true);
    const del = sql.find((s) => /DELETE FROM harness_shared\.goals/i.test(s.text));
    expect(del).toBeTruthy();
    expect(del!.values).toContain('ws-test');
  });

  it('deletes the goal and spawns NOTHING when the mode stamp fails', async () => {
    setModeMock.mockImplementation(async (opts: SetModeCall) => {
      setModeCalls.push(opts);
      order.push('mode-set');
      return { ok: false, error: 'sticky conflict' };
    });
    const res = await call();
    expect(isError(res)).toBe(true);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(order).toContain('delete');
  });
});

describe('the pre-pin this tool depends on', () => {
  it('pins fresh and cross-backend conversion identities but rejects same-backend resume', () => {
    const fresh = buildAgentLaunchCommand({
      mode: 'fresh',
      agent: 'claude',
      harness: 'papercusp',
      ownerId: 'su-abc',
    });
    expect(fresh).toContain('--owner-id=su-abc');

    // A same-backend resume already HAS an identity. Supplying ownerId is a
    // caller bug; silently dropping the pin would leave pre-written state orphaned.
    expect(() => buildAgentLaunchCommand({
      mode: 'resume',
      sessionId: 'sess-1',
      agent: 'claude',
      ownerId: 'su-abc',
    })).toThrow(/same-backend resume/);

    const resumedWithoutPin = buildAgentLaunchCommand({
      mode: 'resume',
      sessionId: 'sess-1',
      agent: 'claude',
    });
    expect(resumedWithoutPin).not.toContain('--owner-id');

    const converted = buildAgentLaunchCommand({
      mode: 'resume',
      sessionId: 'sess-1',
      agent: 'claude',
      targetAgent: 'omp',
      ownerId: 'su-abc',
    });
    expect(converted).toContain('--owner-id=su-abc');
    expect(converted).toContain('--agent=omp');
  });
});

describe('the kickoff brief', () => {
  const portfolio: GoalPortfolioBrief = {
    schemaVersion: 1,
    assembledAt: '2026-08-28T02:30:00.000Z',
    goal: {
      id: 'g-1',
      title: 't',
      status: 'active',
      body: null,
      killCriterion: null,
      standing: true,
      parentId: null,
    },
    worklist: [],
    pots: [],
    drainFleet: {
      slug: null,
      exists: null,
      controlState: null,
      leaderOwnerId: null,
      live: null,
      working: null,
    },
    queue: {
      total: 3,
      terminal: 1,
      inFlight: 1,
      blocked: 0,
      needsHuman: 0,
      claimable: 1,
      claimabilityScope: 'issue-family',
    },
    launch: {
      settings: null,
      ceilings: { maxAgents: 12, maxPerFleet: 5 },
      headcount: { total: 2, fleet: null },
    },
    budget: {
      budgetCents: null,
      spentCents: null,
      unmeasuredPricedSpend: false,
      spentCentsAt: null,
      spentCentsSource: null,
      interactiveUsageFreshnessStatus: null,
      interactiveUsageLastIngestedAtMs: null,
      budgetWindowSec: null,
    },
    tripwires: [],
    pending: { blenderIdeas: 0, acceptanceRubric: null },
    continuity: { checkpoint: null, lastOwnerReportAt: null },
    priorities: ['Delegate the next worklist item.'],
    degradedReasons: [],
  };

  it('embeds the server-composed portfolio snapshot in the first-turn brief', () => {
    const brief = buildGoalKickoffBrief({ goalId: 'g-1', title: 't', portfolio });

    expect(brief).toContain('GOAL PORTFOLIO SNAPSHOT — assembled 2026-08-28T02:30:00.000Z');
    expect(brief).toContain('Queue: total=3; terminal=1; in-flight=1');
    expect(brief).toContain('1. Delegate the next worklist item.');
  });

  it('reuses portfolio text already produced by the launch resolver', () => {
    const rendered = 'GOAL PORTFOLIO SNAPSHOT — exactly one producer output';
    const brief = buildGoalKickoffBrief({
      goalId: 'g-1', title: 't',
      portfolio: {} as GoalPortfolioBrief,
      renderedPortfolio: rendered,
    });
    expect(brief).toContain(rendered);
  });

  it('puts current goal authority before the bounded own/descendant history', () => {
    const history = {
      status: 'available',
      brief: {
        fingerprint: 'goal-history-fingerprint',
        fanOut: { admitted: 2, total: 2, cap: 24, truncated: false },
        attempts: [
          {
            authority: 'checkpoint',
            scope: 'goal-wide',
            rawRef: 'goal-history#stale-carry',
            text: 'STALE CARRY: use the obsolete stop condition.',
          },
        ],
      },
      recovery: { tool: 'goals:get', args: { id: 'g-1', detail: 'full' } },
    } as never;
    const brief = buildGoalKickoffBrief({
      goalId: 'g-1',
      title: 'Ship safely',
      killCriterion: 'the current stop condition',
      history,
    });

    expect(brief).toContain('GOAL HISTORY — own and bounded descendant evidence');
    expect(brief).toContain('goal-history-fingerprint');
    expect(brief.indexOf('KILL THIS IF — the current stop condition')).toBeLessThan(
      brief.indexOf('GOAL HISTORY — own and bounded descendant evidence'),
    );
    expect(brief.indexOf('KILL THIS IF — the current stop condition')).toBeLessThan(
      brief.indexOf('STALE CARRY: use the obsolete stop condition.'),
    );
  });

  it('states the outcome, the kill criterion, the ceiling and spend visibility boundary', () => {
    const brief = buildGoalKickoffBrief({
      goalId: 'ship-paid-app-3f9a1c',
      title: 'Ship a paid app',
      killCriterion: 'no paying user by day 30',
      budgetCents: 50_000,
    });
    expect(brief).toContain('ship-paid-app-3f9a1c');
    expect(brief).toContain('OUTCOME — Ship a paid app');
    expect(brief).toContain('KILL THIS IF — no paying user by day 30');
    expect(brief).toContain('$500.00');
    expect(brief).toContain('SPEND VISIBILITY');
    expect(brief).toContain('goals:pots { goalId }');
    expect(brief).toContain('measured child-fleet spend');
    expect(brief).toContain('do not invent per-session actuals');
    expect(brief).not.toContain('Report actuals against it');
  });

  it('does not demand unavailable actuals when no ceiling is declared', () => {
    const brief = buildGoalKickoffBrief({ goalId: 'g-1', title: 't' });
    expect(brief).toContain('CEILING — none declared. Flag before any large spend.');
    expect(brief).toContain('goals:pots { goalId }');
    expect(brief).not.toContain('Report actuals anyway');
  });

  /**
   * A STANDING goal's absent criterion means something DIFFERENT
   * (work-on-everything-goal-2026-08-23 P-001).
   *
   * ⚠ Not to be confused with the "standing drain fleet" P-001 above — a
   * different plan's item that happens to share the word.
   *
   * Both briefs are generated from the same NULL column, so the only thing
   * separating them is the flag. The ordinary wording invites the agent to
   * "propose a stopping condition", which for a stewardship goal is an
   * instruction to invent the checkable outcome the goal is DEFINED as not
   * having — and an agent that adopts one will eventually report the standing
   * duty complete and stop. That is the failure this pins.
   */
  describe('a STANDING goal states its polarity instead (work-on-everything P-001)', () => {
    it('replaces the propose-a-stopping-condition invitation with the standing polarity', () => {
      const brief = buildGoalKickoffBrief({ goalId: 'g-1', title: 't', standing: true });
      expect(brief).toContain('KILL THIS IF — ');
      expect(brief).toContain('STANDING');
      expect(brief).toContain('owner stops it or a tripwire fires');
      expect(brief).toContain('Do not invent a completion condition');
      // The exact wording that would send it looking for an outcome.
      expect(brief).not.toContain('Propose a stopping condition');
    });

    it('is the ONLY difference — a standing goal still gets the ceiling and spend rails', () => {
      const standing = buildGoalKickoffBrief({ goalId: 'g-1', title: 't', standing: true });
      expect(standing).toContain('CEILING — none declared. Flag before any large spend.');
      expect(standing).toContain('SPEND VISIBILITY');
      expect(standing).toContain('OUTCOME — t');
    });

    it('a WRITTEN criterion still wins — standing does not suppress one the owner actually gave', () => {
      const brief = buildGoalKickoffBrief({
        goalId: 'g-1',
        title: 't',
        standing: true,
        killCriterion: 'the pot is archived',
      });
      expect(brief).toContain('KILL THIS IF — the pot is archived');
      expect(brief).not.toContain('Do not invent a completion condition');
    });

    it('the ordinary absent-criterion wording is unchanged when NOT standing — the control', () => {
      const ordinary = buildGoalKickoffBrief({ goalId: 'g-1', title: 't' });
      expect(ordinary).toContain('Propose a stopping condition in your kickoff question.');
      expect(ordinary).not.toContain('STANDING');
      // standing:false must behave exactly like omitting it.
      expect(buildGoalKickoffBrief({ goalId: 'g-1', title: 't', standing: false })).toBe(ordinary);
    });
  });

  /**
   * The ceiling's DENOMINATOR is part of the number
   * (work-on-everything-goal-2026-08-23 P-004).
   *
   * `$25.00 declared` means two different budgets depending on whether a
   * window is set, and the agent cannot tell which from the figure. On a
   * STANDING goal the unqualified reading is the dangerous one: it presents as
   * a total that will inevitably be reached, when the real rule is per-window.
   */
  describe('a windowed ceiling states its window (P-004)', () => {
    it('renders the window beside the amount', () => {
      const brief = buildGoalKickoffBrief({
        goalId: 'g-1',
        title: 't',
        budgetCents: 2_500,
        budgetWindowSec: 604_800,
      });
      expect(brief).toContain('CEILING — $25.00 per week declared.');
    });

    it('an un-windowed ceiling is unchanged — the control', () => {
      const brief = buildGoalKickoffBrief({ goalId: 'g-1', title: 't', budgetCents: 2_500 });
      expect(brief).toContain('CEILING — $25.00 declared.');
      // Anchored to the CEILING line: the brief says "per-session actuals"
      // elsewhere, so a bare not-toContain('per') would fail on unrelated prose.
      const ceilingLine = brief.split('\n').find((l) => l.startsWith('CEILING —'));
      expect(ceilingLine).not.toMatch(/ per /);
    });

    it('names exact multiples, and refuses to round an inexact one into a lie', () => {
      const at = (sec: number) =>
        buildGoalKickoffBrief({ goalId: 'g', title: 't', budgetCents: 100, budgetWindowSec: sec });
      expect(at(604_800)).toContain('$1.00 per week');
      expect(at(1_209_600)).toContain('$1.00 per 2 weeks');
      expect(at(86_400)).toContain('$1.00 per day');
      expect(at(3_600)).toContain('$1.00 per hour');
      // 500000s is ~5.8 days. Rounding it to "6 days" would misstate the
      // denominator of a spend rule, so it stays raw.
      expect(at(500_000)).toContain('$1.00 per 500000s');
    });

    it('a window with no ceiling changes nothing — there is no number to qualify', () => {
      const brief = buildGoalKickoffBrief({ goalId: 'g-1', title: 't', budgetWindowSec: 604_800 });
      expect(brief).toContain('CEILING — none declared. Flag before any large spend.');
    });
  });

  it('does not restate the mode contract (which arrives with the mode)', () => {
    const brief = buildGoalKickoffBrief({
      goalId: 'g-1',
      title: 't',
      killCriterion: 'k',
      budgetCents: 0,
    });
    // A second copy of the contract is a second copy to drift; the brief points
    // at the delivered one instead.
    expect(brief).not.toContain('portfolio management');
    expect(brief).toContain('mode contract');
  });

  // ── EI-20185528589678586 ────────────────────────────────────────────────
  // This brief was once delivered ~26h after it was written, to a session that
  // was not the goal's agent and held no `overlay:goal` row. Its two standing
  // claims — that the goal was JUST started, and that the contract HAD been
  // delivered — were both false on arrival, and neither was checkable from the
  // text. These two tests pin the fix: the brief now reports what it knows
  // (when it was written) and makes the rest falsifiable.
  it('stamps when it was written instead of claiming the goal was just started', () => {
    const brief = buildGoalKickoffBrief({
      goalId: 'g-1',
      title: 't',
      writtenAt: new Date('2026-08-10T17:06:00Z'),
    });
    expect(brief).toContain('2026-08-10T17:06:00Z');
    // The failing phrasing: a brief cannot know how long it will sit before it
    // is read, so it must not assert freshness on the reader's behalf.
    expect(brief).not.toContain('just started');
  });

  it('tells a reader holding no contract to STOP, rather than asserting one was delivered', () => {
    const brief = buildGoalKickoffBrief({ goalId: 'g-1', title: 't' });
    // Where to look — an agent can check this in one call and catch the absence.
    expect(brief).toContain('modes[].contract');
    expect(brief).toContain('mode:get');
    expect(brief).toMatch(/STOP/);
    // The unfalsifiable form: a bare statement that it already arrived reads as
    // fact, so an agent that never received one has no cue anything is wrong.
    expect(brief).not.toContain('(delivered with your orient)');
  });

  // R-4 / D-032 (goal-agent-behavior-feedback-2026-09-06): the experiment arm
  // withholds TEXT only. 'full' and 'brief-only' carry the complete launch brief;
  // 'baseline' drops the portfolio and history blocks and keeps every other line.
  describe('R-4 behaviour-experiment arm', () => {
    const writtenAt = new Date('2026-09-29T01:00:00Z');
    const history = {
      status: 'available',
      brief: { fingerprint: 'arm-history-fp', fanOut: { admitted: 0, total: 0, cap: 24, truncated: false }, attempts: [] },
      recovery: { tool: 'goals:get', args: { id: 'g-arm' } },
    } as never;
    const base = {
      goalId: 'g-arm', title: 'Arm outcome', killCriterion: 'arm stop', budgetCents: 1_000,
      renderedPortfolio: 'GOAL PORTFOLIO SNAPSHOT — arm fixture', history, writtenAt,
    };

    it("'full' is byte-identical to an arm-less brief", () => {
      expect(buildGoalKickoffBrief({ ...base, behaviorArm: 'full' })).toBe(buildGoalKickoffBrief(base));
      expect(buildGoalKickoffBrief({ ...base, behaviorArm: null })).toBe(buildGoalKickoffBrief(base));
    });

    it("'brief-only' keeps the full launch brief (it withholds only per-turn reminders)", () => {
      expect(buildGoalKickoffBrief({ ...base, behaviorArm: 'brief-only' })).toBe(buildGoalKickoffBrief(base));
    });

    it("'baseline' withholds the portfolio and history but keeps outcome, kill, ceiling and contract lines", () => {
      const full = buildGoalKickoffBrief(base);
      const baseline = buildGoalKickoffBrief({ ...base, behaviorArm: 'baseline' });
      expect(full).toContain('GOAL PORTFOLIO SNAPSHOT — arm fixture');
      expect(full).toContain('arm-history-fp');
      expect(baseline).not.toContain('GOAL PORTFOLIO SNAPSHOT');
      expect(baseline).not.toContain('arm-history-fp');
      for (const line of ['OUTCOME — Arm outcome', 'KILL THIS IF — arm stop', 'CEILING — $10.00 declared', 'modes[].contract']) {
        expect(baseline).toContain(line);
      }
      // Withholding removes lines; it never rewrites the ones that remain.
      for (const line of baseline.split('\n')) expect(full.split('\n')).toContain(line);
    });
  });
});

// ── EI-20049757392342975 ──────────────────────────────────────────────────
describe('goals:start — the shared kill-criterion rule applies at THIS door too', () => {
  /**
   * This is the door the owner's own HUD composer posts to
   * (GoalComposer → postGoalStart → goals:start), and until now nothing on that
   * whole path enforced the rule — GoalComposer.tsx even renders an
   * `errors.killCriterion` slot that `validateGoalDraft` can never populate.
   * `goals:propose` and `goals:update` both refused a stub; this door and
   * `goals:create` did not, so a criterion could be INSTALLED that could never
   * afterwards be UPDATED to.
   */
  it('refuses a stub criterion, and spawns NOTHING', async () => {
    const res = await call({ killCriterion: 'gut feel' });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/states no abandonment condition/);
    // The load-bearing assertions: refusing must cost no goal row and no agent.
    // A refusal that still spawned would leave an orphan process behind, which
    // is worse than the permissive behaviour it replaced.
    expect(sql.find((s) => /INSERT INTO harness_shared\.goals/i.test(s.text))).toBeFalsy();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('refuses a placeholder opener that clears the length bar', async () => {
    const res = await call({ killCriterion: 'TBD once we see some real numbers' });
    expect(isError(res)).toBe(true);
    // Assert the REASON: this string is long enough, so a bare isError could be
    // some unrelated rejection and this test would never exercise the rule.
    expect(textOf(res)).toMatch(/states no abandonment condition/);
  });

  // WI-37604 still permits a draft with no criterion. P-015 now refuses
  // non-standing HOLDER execution until that draft has an operating stop rule.
  it('refuses a non-standing holder with no criterion', async () => {
    const res = await call({ killCriterion: undefined });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('missing-kill-criterion');
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('refuses a non-standing holder with a blank criterion', async () => {
    const res = await call({ killCriterion: '   ' });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('missing-kill-criterion');
  });

  it('allows a standing holder with missing inputs and exposes incompleteness', async () => {
    const res = await call({ killCriterion: undefined, standing: true });
    expect(isError(res)).toBe(false);
    expect(spawnConsoleMock).toHaveBeenCalledTimes(1);
    expect((spawnConsoleMock.mock.calls[0][0] as { envelope: { env: Record<string, string> } }).envelope.env.PAPERCUSP_KICKOFF_PROMPT)
      .toContain('Operating inputs: incomplete');
  });
});

/* ── the holder-policy write boundary applies at THIS door too
   (goal-live-holder-guarantee-2026-08-18 P-003, D-008) ───────────────────────
   This door reaches the shared `insertGoalRow` DIRECTLY, so a rule enforced only
   at `goals:create` would leave it as the way to install what that door refuses
   — the second-copy drift kill-criterion.ts's header describes, one layer up.
   It also has the strongest claim to the question: it SPAWNS the session that
   holds the goal. ── */
describe('goals:start — a goal must declare its holder policy', () => {
  it('REFUSES an undeclared goal, and writes + spawns NOTHING', async () => {
    const res = await call({ holder: undefined });
    expect(isError(res)).toBe(true);
    // Assert the REASON, not just isError: a bare failure could be any unrelated
    // rejection and this test would never exercise the rule.
    expect(textOf(res)).toMatch(/holder policy/i);
    // Refusing must cost no goal row and no agent — a refusal that still spawned
    // leaves an orphan process, which is worse than the permissive behaviour.
    expect(sql.find((s) => /INSERT INTO harness_shared\.goals/i.test(s.text))).toBeFalsy();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('ACCEPTS an explicit opt-OUT — the escape hatch must be sayable at this door', async () => {
    const res = await call({ holder: { requireLive: false } });
    expect(isError(res)).toBe(false);
    expect(sql.find((s) => /INSERT INTO harness_shared\.goals/i.test(s.text))).toBeTruthy();
  });

  /* CONTROL. Without it, both assertions above still pass if the door refused
     EVERY start — strict-looking and broken. ARGS declares a policy, so this
     also pins that declaring is genuinely sufficient. */
  it('CONTROL: the default fixture declares a policy and starts normally', async () => {
    const res = await call();
    expect(isError(res)).toBe(false);
    expect(sql.find((s) => /INSERT INTO harness_shared\.goals/i.test(s.text))).toBeTruthy();
  });
});

// ── goal-dag-shared-substrate-2026-08-18 P-004 ────────────────────────────
describe('goals:start — the activation gate (P-004)', () => {
  /** One pending goal blocker + one satisfied issue blocker: not actionable. */
  const pendingReadiness = (): Readiness => ({
    actionable: false,
    premiseInvalidated: false,
    blockers: [
      { kind: 'goal', ref: 'other-goal-ab12cd', status: 'active', verdict: 'pending' },
      { kind: 'issue', ref: 'WI-100', status: 'resolved', verdict: 'satisfied' },
    ],
  });

  it('warn-refuses ONCE on unsatisfied blockers: full rollback, nothing spawned, override + stub-then-arm named', async () => {
    readinessMock.mockImplementation(async () => pendingReadiness());
    const res = await call({ blockedBy: ['other-goal-ab12cd', 'WI-100'] });
    expect(isError(res)).toBe(true);
    const text = textOf(res);
    // The refusal names the UNSATISFIED blocker — and only that one; a listing
    // that included satisfied blockers would read as a broken gate.
    expect(text).toContain('other-goal-ab12cd');
    expect(text).not.toContain('WI-100 (');
    // ...and both exits: the override and the stub-then-arm alternative (D-004).
    expect(text).toContain('startBlocked');
    expect(text).toContain('goals:create');
    // Rollback: edges cleared AND the row deleted; no mode stamp, no spawn.
    expect(replaceBlockedByMock).toHaveBeenCalled();
    expect(order).toContain('delete');
    expect(setModeCalls).toHaveLength(0);
    expect(spawnConsoleMock).not.toHaveBeenCalled();
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
  });

  it('startBlocked: true overrides — proceeds and records start_blocked_override verbatim', async () => {
    readinessMock.mockImplementation(async () => pendingReadiness());
    const res = await call({
      blockedBy: ['other-goal-ab12cd'],
      startBlocked: true,
      startBlockedReason: 'prerequisite lands tomorrow; scaffolding can start today',
    });
    expect(isError(res)).toBe(false);
    expect(dataOf(res).start_blocked_override).toBe('prerequisite lands tomorrow; scaffolding can start today');
    // The override changes the verdict, never the order contract.
    expect(stampPrecedesSpawn(order)).toBe(true);
  });

  it('startBlocked with NO reason still proceeds, recording the blockers as the override note', async () => {
    readinessMock.mockImplementation(async () => pendingReadiness());
    const res = await call({ blockedBy: ['other-goal-ab12cd'], startBlocked: true });
    expect(isError(res)).toBe(false);
    expect(String(dataOf(res).start_blocked_override)).toContain('other-goal-ab12cd');
  });

  it('an ACTIONABLE blockedBy set passes with NO override recorded — startBlocked is not sticky', async () => {
    const res = await call({ blockedBy: ['WI-100'], startBlocked: true });
    expect(isError(res)).toBe(false);
    expect(dataOf(res).start_blocked_override).toBeUndefined();
  });

  it('no blockedBy ⇒ the gate never reads readiness (a fresh goal has no other edges)', async () => {
    const res = await call();
    expect(isError(res)).toBe(false);
    expect(readinessMock).not.toHaveBeenCalled();
  });

  it('a refused blockedBy set rolls the goal back BEFORE the gate ever runs (P-002 wiring, via the seam)', async () => {
    applyBlockedByMock.mockImplementation(async () => ({ ok: false, problem: 'refs do not resolve: nope' }));
    const res = await call({ blockedBy: ['nope'] });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('refs do not resolve');
    expect(order).toContain('delete');
    expect(readinessMock).not.toHaveBeenCalled();
    expect(spawnConsoleMock).not.toHaveBeenCalled();
  });

  it('a killed blocker (premise invalidated) also refuses, naming the invalidating verdict', async () => {
    readinessMock.mockImplementation(async () => ({
      actionable: false,
      premiseInvalidated: true,
      blockers: [{ kind: 'goal', ref: 'dead-goal-ff00aa', status: 'killed', verdict: 'invalidating' }],
    }));
    const res = await call({ blockedBy: ['dead-goal-ff00aa'] });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('invalidating');
  });

  it('a mode-stamp failure with blockedBy clears the edges too — no dangling edge rows (the P-002 gap)', async () => {
    setModeMock.mockImplementation(async (opts: SetModeCall) => {
      setModeCalls.push(opts);
      order.push('mode-set');
      return { ok: false, error: 'sticky conflict' };
    });
    const res = await call({ blockedBy: ['WI-100'] });
    expect(isError(res)).toBe(true);
    expect(replaceBlockedByMock).toHaveBeenCalled();
    expect(order).toContain('delete');
  });
});
