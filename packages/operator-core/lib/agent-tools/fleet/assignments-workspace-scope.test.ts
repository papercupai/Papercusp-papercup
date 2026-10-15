/**
 * assignments-workspace-scope.test.ts — regression for EI-13820.
 *
 * coord:orient's "me" self-scoped fleet:assignments read (and fleet:leader-brief,
 * coord:roster, fleet:bench, scheduler:running — the identical pattern) resolved
 * the query workspace as `args.workspace ?? actorWorkspace ?? activeWorkspaceId()`.
 * `actorWorkspace` comes straight from `resolveAgentIdentity(ctx).workspaceId`,
 * which is the literal '*' sentinel for an unscoped su session (EI-9013 — already
 * fixed once for coord:orient's compaction-recovery leg, WI-892/EI-3409 for
 * resolveConcreteWorkspaceId itself). Because '*' is a truthy string, the old
 * `??` chain never fell through to `activeWorkspaceId()` and instead passed the
 * literal '*' straight into `listFleetAssignments`' `workspace_id = $1` equality
 * filter — which no real row ever matches — silently zeroing the caller's OWN
 * presence/claims (the observed `me.summary = {agents:0, alive:0, claims:0}`
 * while fleet:leader-brief, in the SAME orient call, showed the fleet alive).
 *
 * This pins the fix: an unscoped ('*') actor workspace must fall through to the
 * concrete active workspace, not leak into the query.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  readJsonResult: () => undefined,
}));
vi.mock('../coordination/roles', () => ({
  COORD_ROLES: ['operator'],
  COORD_READ_ROLES: ['operator', 'judge'],
}));
vi.mock('../coordination/identity', () => ({
  // The EI-9013 shape: an unscoped su session's identity echoes ctx.workspaceId
  // verbatim, and that is the literal '*' sentinel — never a real workspace.
  resolveAgentIdentity: () => ({
    ownerId: 'su-leader',
    ownerLabel: 'l',
    source: 'static-client',
    workspaceId: '*',
    userId: null,
  }),
}));
// vi.fn (not arrow literals) so WI-6762's selfScoped TRUE-path can re-point
// resolveSelfRef for a single test — the false-path here needs it to stay null.
vi.mock('../coordination/self-marker', () => ({
  resolveSelfRef: vi.fn(() => null),
  markSelfRows: vi.fn((rows: unknown[]) => rows),
}));
// Real resolveConcreteWorkspaceId (already unit-tested for '*' at WI-892/EI-3409) —
// not mocked at all. Its internal fallback to activeWorkspaceId() is a same-module
// local reference vi.mock's partial-override can't intercept (an ESM/vi.mock
// gotcha, not a bug), so this test asserts the FIX (never leaking '*' into the
// query) rather than pinning the concrete fallback value, which is whatever this
// process's real activeWorkspaceId() resolves to.
vi.mock('../coordination/presence-wakeability', () => ({ fetchWakeability: vi.fn(async () => new Map()) }));
vi.mock('../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../adv-sessions')>()), recordedLiveOwnerIds: vi.fn(async () => new Set()) }));
vi.mock('../coordination/wake-mode', () => ({
  getWakeModeOverridesFor: vi.fn(async () => new Map()),
  getDefaultWakeMode: vi.fn(async () => 'auto'),
  resolveWakeModeFrom: vi.fn(() => 'auto'),
}));
vi.mock('../../plan-item-coverage', () => ({
  getAllPlanItemCoverage: vi.fn(async () => new Map()),
  compactCoverage: vi.fn((c: unknown) => c),
  coverageCollisions: vi.fn(() => []),
}));
vi.mock('../../events/await/store', () => ({ listParkedAwaitsForSubscribers: vi.fn(async () => []) }));
vi.mock('../coordination/context-pressure', () => ({
  fetchContextPressure: vi.fn(async () => new Map()),
  fetchContextPressureReadings: vi.fn(async () => new Map()),
}));
vi.mock('../coordination/unanswered-directed', () => ({ fetchUnansweredDirected: vi.fn(async () => new Map()) }));
vi.mock('../coordination/inbox-read-freshness', () => ({
  classifyCoordDeafness: vi.fn(() => null),
  coordDeafBudgetMs: vi.fn(() => 900_000),
  lastInboxReadAtBatch: vi.fn(async () => new Map()),
}));
vi.mock('../../harness/routines/loop', () => ({ getLoopStatuses: vi.fn(async () => new Map()) }));

let capturedWorkspaceId: unknown;
let capturedAgent: unknown;
// PARTIAL mock (importOriginal) — see WI-6035. A closed factory silently reds
// this file whenever fleet/assignments.ts gains an export it does not list; the
// spread makes any un-stubbed export fall through to the real implementation.
vi.mock('../../fleet/assignments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet/assignments')>()),
  listFleetAssignments: vi.fn(async (opts: { workspaceId?: unknown; agent?: unknown }) => {
    capturedWorkspaceId = opts.workspaceId;
    capturedAgent = opts.agent;
    // One live claim row for the caller itself — mirrors the incident: the
    // leader's OWN work-item claim (WI-5150-shaped), which the SAME orient
    // call's leaderBrief proved was really there.
    return [
      {
        source: 'work_item_claim',
        workspaceId: 'ws-real',
        agentId: 'su-leader',
        agentLabel: null,
        agentName: null,
        harnessSlug: 'papercusp',
        planSlug: null,
        itemId: null,
        workItemId: 'WI-5150',
        itemKind: 'bug',
        detail: '',
        status: 'wip',
        claimAcquiredTs: new Date().toISOString(),
        claimExpiresTs: null,
        claimActive: true,
        livenessMode: null,
        lastActivityTs: new Date().toISOString(),
        holderPresent: true,
        holderAlive: true,
        holderHeartbeatAt: new Date().toISOString(),
        holderIntent: null,
        holderPlanSlug: null,
        orphaned: false,
        declaredPlanMatches: null,
        assigneeRank: null,
        rankWriter: null,
        fleetSlug: 'bug-drain-200k',
        fleetRole: 'leader',
        stalled: false,
      },
    ];
  }),
  groupByAgent: vi.fn((rows: Array<{ agentId: string; alive: boolean }>) => [
    {
      agentId: 'su-leader',
      label: null,
      name: null,
      present: true,
      alive: true,
      heartbeatAt: new Date().toISOString(),
      intent: '',
      declaredPlanSlug: null,
      fleetSlug: 'bug-drain-200k',
      fleetRole: 'leader',
      claims: rows,
      orphaned: false,
      stalled: false,
      declaredUnclaimed: false,
      doing: null,
      queued: [],
      load: 1,
    },
  ]),
  lastToolCallAtByOwner: vi.fn(async () => new Map()),
  orphanedClaims: vi.fn(() => []),
  stalledClaims: vi.fn(() => []),
  summarizeOrphan: vi.fn((r: unknown) => r),
  isReclaimCandidate: vi.fn(() => false),
}));

import fleetAssignmentsTool from './assignments';
import { resolveSelfRef } from '../coordination/self-marker';

const ctx = { workspaceId: '*' } as unknown as Parameters<typeof fleetAssignmentsTool.handler>[1];

beforeEach(() => {
  vi.clearAllMocks();
  capturedWorkspaceId = undefined;
  capturedAgent = undefined;
});

describe('fleet:assignments — EI-13820 workspace-scope regression', () => {
  it('never passes the unscoped "*" sentinel into listFleetAssignments', async () => {
    await fleetAssignmentsTool.handler({} as never, ctx);
    expect(capturedWorkspaceId).not.toBe('*');
    expect(typeof capturedWorkspaceId).toBe('string');
    expect((capturedWorkspaceId as string).length).toBeGreaterThan(0);
  });

  it('the caller\'s own claim is NOT silently zeroed by the "*" leak (the exact reported symptom)', async () => {
    const res = (await fleetAssignmentsTool.handler({} as never, ctx)) as {
      data: { summary: { agents: number; alive: number; claims: number } };
    };
    // Before the fix this was {agents:0, alive:0, claims:0} — indistinguishable
    // from total fleet death — even though the caller genuinely held a live claim.
    expect(res.data.summary.agents).toBe(1);
    expect(res.data.summary.alive).toBe(1);
    expect(res.data.summary.claims).toBe(1);
  });

  it('an explicit { workspace } still wins over the sentinel', async () => {
    await fleetAssignmentsTool.handler({ workspace: 'ws-explicit' } as never, ctx);
    expect(capturedWorkspaceId).toBe('ws-explicit');
  });
});

describe('fleet:assignments — judge self-only recovery scope', () => {
  const judgeCtx = { ...ctx, role: 'judge' } as typeof ctx;

  it('allows an explicit judge self read to target the resolved caller row', async () => {
    vi.mocked(resolveSelfRef).mockReturnValueOnce({
      ownerId: 'su-leader',
      ownerLabel: 'l',
    } as unknown as ReturnType<typeof resolveSelfRef>);

    await fleetAssignmentsTool.handler({ agent: 'self' } as never, judgeCtx);

    expect(capturedAgent).toBe('su-leader');
  });

  it('does not let a judge select another agent row', async () => {
    const result = await fleetAssignmentsTool.handler({ agent: 'su-someone-else' } as never, judgeCtx);

    expect(capturedAgent).toBeUndefined();
    expect(result).toMatchObject({
      data: { ok: false, error: 'judge_assignment_scope_only' },
    });
  });

  it('does not let a judge read the unfiltered assignment population', async () => {
    const result = await fleetAssignmentsTool.handler({} as never, judgeCtx);

    expect(capturedAgent).toBeUndefined();
    expect(result).toMatchObject({
      data: { ok: false, error: 'judge_assignment_scope_only' },
    });
  });
});

/**
 * WI-6762 — a scoped read must SHIP ITS SCOPE.
 *
 * The suites above assert the COUNTS are right, and they always were: `agents: 1` is
 * the correct answer to "how many agents match { agent: me }". The defect was that
 * nothing in the payload said the question had been narrowed, while three things
 * implied it had not — fleet-shaped field names, an `agents_hint` claiming
 * "summary.agents has the true total", and `agentsElided: 0`. coord:orient always
 * calls this tool with { agent: ownerId }, so EVERY orient `me` block is a one-agent
 * read; on 2026-08-01 two agents concluded from one that the fleet was dead
 * (EI-19282566865609166; and WI-6740, where it nearly caused a 22-session outage).
 *
 * A count-based test can never catch this — which is why it reached production twice.
 * Assert the SELF-DESCRIPTION instead.
 */
describe('fleet:assignments — WI-6762: scoped counts carry their scope', () => {
  it('echoes the narrowing filters and flags the read as filtered', async () => {
    const res = (await fleetAssignmentsTool.handler({ agent: 'su-leader' } as never, ctx)) as {
      data: { summary: { agents: number }; scope: Record<string, unknown> };
    };
    // The number that reads as "the fleet has one agent"…
    expect(res.data.summary.agents).toBe(1);
    // …must arrive next to the reason it is 1.
    expect(res.data.scope).toBeDefined();
    expect(res.data.scope.agent).toBe('su-leader');
    expect(res.data.scope.filtered).toBe(true);
  });

  it('an UNFILTERED read says so — `filtered:false` is what licenses a fleet-wide reading', async () => {
    const res = (await fleetAssignmentsTool.handler({} as never, ctx)) as {
      data: { scope: Record<string, unknown> };
    };
    expect(res.data.scope.filtered).toBe(false);
    expect(res.data.scope.agent).toBeNull();
    expect(res.data.scope.plan).toBeNull();
    expect(res.data.scope.fleet).toBeNull();
  });

  it('`selfScoped` requires a RESOLVABLE self — false, not true, when identity is unknown', async () => {
    // Fail-safe direction: an unattributable caller must never be TOLD the read was
    // self-scoped when we cannot show that it was. A flag defaulting TRUE would
    // recreate the very over-claim this fixes.
    const res = (await fleetAssignmentsTool.handler({ agent: 'su-leader' } as never, ctx)) as {
      data: { scope: { selfScoped: boolean } };
    };
    expect(res.data.scope.selfScoped).toBe(false);
  });

  it('`selfScoped` is TRUE when a RESOLVED self matches { agent } — the coord:orient `me` shape', async () => {
    // The true-path, and the only assertion that catches how this flag first shipped:
    // resolveSelfRef returns { ownerId, ownerLabel }, NOT a bare id, so the original
    // `args.agent === self` compared a string to an OBJECT and was ALWAYS false. That
    // version passed every false-path test above (they expect false anyway) while
    // never firing in production — a flag that looks fixed and defends nothing.
    vi.mocked(resolveSelfRef).mockReturnValueOnce({
      ownerId: 'su-leader',
      ownerLabel: 'l',
    } as unknown as ReturnType<typeof resolveSelfRef>);
    const res = (await fleetAssignmentsTool.handler({ agent: 'su-leader' } as never, ctx)) as {
      data: { scope: { selfScoped: boolean; filtered: boolean } };
    };
    expect(res.data.scope.selfScoped).toBe(true);
    expect(res.data.scope.filtered).toBe(true);
  });

  it('`selfScoped` is FALSE when scoped to a DIFFERENT agent — narrowed, but not to me', async () => {
    vi.mocked(resolveSelfRef).mockReturnValueOnce({
      ownerId: 'su-leader',
      ownerLabel: 'l',
    } as unknown as ReturnType<typeof resolveSelfRef>);
    const res = (await fleetAssignmentsTool.handler({ agent: 'su-someone-else' } as never, ctx)) as {
      data: { scope: { selfScoped: boolean; filtered: boolean } };
    };
    expect(res.data.scope.selfScoped).toBe(false);
    // Still filtered — the counts stay scope-relative and must not read as fleet-wide.
    expect(res.data.scope.filtered).toBe(true);
  });
});

describe('fleet:assignments — caller-relative agent filter', () => {
  it('resolves agent:"self" to the caller ownerId before querying the view', async () => {
    vi.mocked(resolveSelfRef).mockReturnValueOnce({
      ownerId: 'su-leader',
      ownerLabel: 'l',
    } as unknown as ReturnType<typeof resolveSelfRef>);

    const res = (await fleetAssignmentsTool.handler({ agent: 'self' } as never, ctx)) as {
      data: { scope: { agent: string; selfScoped: boolean; filtered: boolean } };
    };

    expect(capturedAgent).toBe('su-leader');
    expect(res.data.scope).toMatchObject({ agent: 'self', selfScoped: true, filtered: true });
  });

  it('keeps an unresolved agent:"self" filter narrow instead of returning the whole roster', async () => {
    vi.mocked(resolveSelfRef).mockReturnValueOnce(undefined);

    await fleetAssignmentsTool.handler({ agent: 'self' } as never, ctx);

    expect(capturedAgent).toBe('__unresolvable_self__');
  });
});
