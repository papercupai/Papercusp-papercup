/**
 * goals:get — single goal by id, with full-mode children lineage (Gap 11).
 *
 * Drizzle-mock with a FIFO fixture queue (harness/get.test.ts convention):
 * each `.select()` call shifts the next fixture, so the goal-row query and
 * the children query draw separate fixtures and we can count how many ran.
 * The logic under test:
 *   - empty rows → `{ data:null, degraded:true,
 *     degradedReasons:['goal <id> not found'] }`
 *   - detail:'summary' (default) → {id,title} and fires NO second query
 *   - detail:'full' → spreads the whole goal + a `children` array assembled
 *     by a SECOND query whose predicate binds parentId === id
 *   - arg schema: id required non-empty, detail defaults to summary
 *
 * Folds Gap 15 (registration: goals:get defined + goals:read cap).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupByMcpName } from '@papercusp/tooldef';

let fixtureQueue: unknown[][] = [];
let queriesBuilt = 0;
const wherePredicates: unknown[] = [];
let historyRows: unknown[] = [];
let historyQueries = 0;
const continuity = vi.hoisted(() => ({
  read: vi.fn(),
  resolve: vi.fn(),
}));
const portfolio = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('@papercusp/operator-core/lib/goal-launch-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/operator-core/lib/goal-launch-settings')>()),
  readGoalPortfolioBrief: portfolio.read,
}));

vi.mock('@papercusp/operator-core/lib/prior-attempt-context', () => ({
  readGoalHistoryContext: (...args: unknown[]) => continuity.read(...args),
  resolvePriorAttemptRefs: (...args: unknown[]) => continuity.resolve(...args),
}));

/**
 * The holder liveness `goals:get` sees (P-004). Mutable + reset per test, the
 * same convention as `fixtureQueue`.
 *
 * Mocked rather than driven through the tagged-template `ctx.tx`, because the
 * REAL resolver would then have to reach the presence oracle to turn a holder
 * row into a verdict — infra this unit test has no business touching.
 *
 * Defaults to `unheld` so the existing fixtures keep exercising the
 * deactivation path; the `held` case below is what proves this wiring actually
 * CONSULTS liveness rather than always deactivating.
 */
let holderLivenessFixture: 'held' | 'unheld' | 'lost' | 'unknown' = 'unheld';

/**
 * WHO the holders are, independent of the liveness VERDICT above
 * (EI-22084485266424071). Defaults to none so every pre-existing fixture keeps
 * its old shape; the identity cases below set it, which is what lets a test
 * distinguish "held by nobody we can name" from "held by su-X".
 */
let holdersFixture: Array<{ ownerId: string; live: boolean; sessionState: string }> = [];

vi.mock('@papercusp/operator-core/lib/goals/holder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/operator-core/lib/goals/holder')>()),
  resolveGoalHolders: async (_sql: unknown, opts: { workspaceId: string; goalId: string }) => ({
    goalId: opts.goalId,
    workspaceId: opts.workspaceId,
    holders: holdersFixture,
    live: holdersFixture.filter((h) => h.live),
    liveness: holderLivenessFixture,
  }),
}));

function makeBuilder() {
  const rows = fixtureQueue.shift() ?? [];
  queriesBuilt += 1;
  const builder: Record<string, unknown> = {};
  const chain = (key: string) =>
    (...args: unknown[]) => {
      if (key === 'where') wherePredicates.push(args[0]);
      return builder;
    };
  for (const k of ['from', 'where', 'limit']) builder[k] = chain(k);
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve);
  return builder;
}

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({
    select: (..._args: unknown[]) => makeBuilder(),
  })),
}));

// Partially mock `eq` to a plain object — the real SQL chunk is circular
// (PgTable ↔ PgColumn) and can't be JSON.stringify'd. The rest of drizzle-orm
// is kept (the generated schema module imports `sql` at load).
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: (col: { name?: string }, value: unknown) => ({ kind: 'eq', col: col?.name, value }),
}));

import tool from './get';

// ctx.tx must be BOTH the drizzle handle (mocked above) AND a callable
// tagged-template tag: the readiness read (goal-dag-shared-substrate-2026-08-18
// P-003) queries blocked-by edges through it directly. Returning [] = no edges
// ⇒ actionable, premise intact. Tagged-template calls do NOT count toward
// queriesBuilt (that counter pins the drizzle-query shape only).
const CTX = () => ({
  principal: { slug: 'op', workspaceId: 'default' } as never,
  tx: ((strings: TemplateStringsArray, ..._args: unknown[]) => {
    const sql = strings.join('?');
    if (/FROM harness_shared\.audit_log/.test(sql)) {
      historyQueries += 1;
      return Promise.resolve(historyRows);
    }
    return Promise.resolve([]);
  }) as never,
  log: vi.fn(),
});

const GOAL_ROW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'g-1',
  title: 'Ship v1',
  body: 'rationale + acceptance criteria',
  parentId: null,
  budgetCents: 9999,
  workspaceId: 'default',
  status: 'active',
  metadata: null,
  ...over,
});

/** A goal paused deliberately, with the P-005/D-009 record `goals:update` writes. */
const PAUSED_ROW = () =>
  GOAL_ROW({
    status: 'paused',
    metadata: {
      pause: { reason: 'owner holding the spend', pausedBy: 'su-abc', pausedAtMs: 1_755_000_000_000 },
      spentCents: 4200,
    },
  });

beforeEach(() => {
  fixtureQueue = [];
  queriesBuilt = 0;
  wherePredicates.length = 0;
  holderLivenessFixture = 'unheld';
  holdersFixture = [];
  historyRows = [];
  historyQueries = 0;
  portfolio.read.mockReset().mockResolvedValue(null);
  continuity.read.mockReset().mockResolvedValue({
    status: 'available',
    brief: { fingerprint: 'goal-history-fingerprint' },
    recovery: { tool: 'goals:get', args: { id: 'g-1', detail: 'full' } },
  });
  continuity.resolve.mockReset().mockResolvedValue({
    schemaVersion: 'prior-attempt-refs-v1',
    records: [],
    unresolved: [],
    fingerprint: 'goal-history-fingerprint',
  });
});

describe('goals:get — post-action reporting contract', () => {
  it('the registered full read refreshes the canonical draft and assembly timestamp', async () => {
    const reporting = {
      cadence: null,
      draft: { fields: { moved: 'none', cost: 'unknown', ownerWalled: 'none', killed: 'none', nextWake: 'unknown' }, unreadArtifacts: [], text: 'fresh report' },
      movementTruncated: false,
      killedTruncated: false,
    };
    portfolio.read.mockResolvedValue({ assembledAt: '2026-10-07T04:00:00.000Z', reporting, degradedReasons: [] });
    fixtureQueue = [[GOAL_ROW()], []];
    const registered = lookupByMcpName('goals:get')!;
    const args = tool.args.parse({ id: 'g-1', detail: 'full' });
    const read = async () => {
      const result = await registered.fn(args, {
        ...CTX(), workspaceId: 'default', transport: 'http', runId: 'report-contract',
        signal: new AbortController().signal, emit: vi.fn(), progress: vi.fn(),
      } as never) as { content: Array<{ text: string }> };
      return JSON.parse(result.content[0].text);
    };
    const result = await read();
    expect(result).toMatchObject({ assembledAt: '2026-10-07T04:00:00.000Z', reporting });
    expect(portfolio.read).toHaveBeenCalledWith({ workspaceId: 'default', goalId: 'g-1', sql: expect.any(Function), claimability: 'skip' });

    // A second post-action read must not reuse the launch-time snapshot.
    portfolio.read.mockResolvedValue({ assembledAt: '2026-10-07T04:01:00.000Z', reporting: { ...reporting, draft: { ...reporting.draft, text: 'post-action report' } }, degradedReasons: [] });
    fixtureQueue = [[GOAL_ROW()], []];
    const refreshed = await read();
    expect(refreshed).toMatchObject({ assembledAt: '2026-10-07T04:01:00.000Z', reporting: { draft: { text: 'post-action report' } } });
    expect(portfolio.read).toHaveBeenCalledTimes(2);
  });

  it('makes a missing canonical reporting read explicit without inventing a timestamp', async () => {
    fixtureQueue = [[GOAL_ROW()], []];
    const result = await tool.handler({ id: 'g-1', detail: 'full' } as never, CTX() as never);
    expect(result).toMatchObject({ degraded: true, degradedReasons: ['goal g-1 reporting unavailable'], data: { assembledAt: null, reporting: null } });
  });

  it('keeps the summary read free of the full reporting projection', async () => {
    fixtureQueue = [[GOAL_ROW()]];
    await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never);
    expect(portfolio.read).not.toHaveBeenCalled();
  });
});

/**
 * P-004 / D-011 — the wiring CONSULTS liveness; it does not assume it.
 *
 * Every other fixture in this file has no holder, so all of them deactivate.
 * That means a `goals:get` which simply hardcoded `deactivated: true` would
 * pass the entire suite — the classic guard that has never been shown to fail.
 * These two cases are the discriminator: same row, same policy, liveness the
 * only variable.
 */
describe('goals:get — deactivation is DERIVED from holder liveness (P-004)', () => {
  // `handler`'s declared result is a union without `data`, so every `res.data`
  // in this file is a TS2339 (a pre-existing class, 12 of them at the time of
  // writing). This narrows it locally so the P-004 cases add none.
  const dataOf = (res: unknown) => (res as { data: Record<string, unknown> }).data;

  it('a HELD goal stays active — liveness is what moves the verdict', async () => {
    holderLivenessFixture = 'held';
    fixtureQueue = [[GOAL_ROW()]];
    const res = await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never);
    expect(dataOf(res)).toMatchObject({
      status: 'active',
      rawStatus: 'active',
      deactivated: false,
      holderLiveness: 'held',
    });
  });

  it('`unknown` liveness NEVER deactivates — a degraded oracle read is not abandonment', async () => {
    // The load-bearing conservative case: one flaky presence fetch must not
    // silently empty the board of every goal it could not resolve.
    holderLivenessFixture = 'unknown';
    fixtureQueue = [[GOAL_ROW()]];
    const res = await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never);
    expect(dataOf(res)).toMatchObject({
      status: 'active',
      deactivated: false,
      holderLiveness: 'unknown',
    });
  });

  it('a LOST holder deactivates — the case the plan exists for', async () => {
    holderLivenessFixture = 'lost';
    fixtureQueue = [[GOAL_ROW()]];
    const res = await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never);
    expect(dataOf(res)).toMatchObject({
      status: 'dormant',
      rawStatus: 'active',
      deactivated: true,
      holderLiveness: 'lost',
    });
  });
});

describe('goals:get — not-found degrade (Gap 11)', () => {
  it('empty rows → degraded envelope with the goal-<id> reason', async () => {
    fixtureQueue = [[]];
    const res = await tool.handler({ id: 'g-404', detail: 'summary' } as never, CTX() as never);
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toEqual(['goal g-404 not found']);
    expect(queriesBuilt).toBe(1); // never reaches the children query
  });
});

describe('goals:get — summary skips the children query (Gap 11)', () => {
  it('summary (default) projects {id,title} and fires exactly ONE query', async () => {
    fixtureQueue = [[GOAL_ROW()]];
    const res = await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never);
    // P-004 / D-011 — DETERMINISTIC DEACTIVATION, and this fixture is the
    // motivating case: the column says `active`, no holder row exists, and the
    // goal declares no policy (⇒ requireLive defaults TRUE, D-008). So the goal
    // is administratively active and actually dormant.
    //
    // `status` therefore carries the DERIVED value and `rawStatus` the
    // administrative one. Asserting `status: 'active'` here is what this test
    // used to do, and it is precisely the falsehood an agent then acts on —
    // which makes this assertion the falsifier: delete the fold in get.ts and
    // it fails.
    expect(res.data).toEqual({
      id: 'g-1',
      title: 'Ship v1',
      status: 'dormant',
      rawStatus: 'active',
      deactivated: true,
      holderLiveness: 'unheld',
      // EI-22084485266424071: holder IDENTITY rides with the liveness verdict on
      // BOTH branches. Empty here because this fixture has no holder — stated,
      // not omitted, so a caller can tell "nobody holds it" from "this build
      // does not report holders".
      holders: [],
      pause: null,
      actionable: true,
      premiseInvalidated: false,
      // P-018 (WI-41129): get.ts folds the package-update OFFER into BOTH detail
      // levels. Null here because this fixture declares no goalPackageRef —
      // goalPackageUpdateInfo() returns null before it ever looks a package up.
      packageUpdate: null,
      portfolioThroughput: expect.objectContaining({ assessment: 'not-held', reason: 'not-held' }),
    });
    const json = JSON.stringify(res.data);
    expect(json).not.toContain('rationale'); // body dropped
    expect(json).not.toContain('9999'); // budget dropped
    expect(queriesBuilt).toBe(1); // NO second children query in summary mode
    expect(historyQueries).toBe(0); // history is a full-detail cost only
    expect(res.data).not.toHaveProperty('children');
  });
});

/**
 * P-005 / D-009 — the READ side of the deliberate-pause record.
 *
 * These exist because the routines layer shipped this exact record and then
 * failed anyway, three times, for the opposite reason: `routines:set` WROTE
 * { reason, pausedBy, pausedAtMs } while `routines:list` selected `active` and
 * not `metadata`, so the responder still saw a bare stopped flag and filed a
 * deliberate hold as a suspected stall (EI-19336000265007219). A durable record
 * nobody can read is not a fix. Both detail levels are asserted for that reason
 * — a summary that cannot say "paused, by whom, why" reproduces it exactly.
 */
describe('goals:get — the deliberate-pause record is READ BACK (P-005)', () => {
  it('summary surfaces status + the parsed pause record', async () => {
    fixtureQueue = [[PAUSED_ROW()]];
    const res = await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never);
    // ALSO the load-bearing P-004 case, and the reason P-005 had to ship first
    // (D-008): this goal has no live holder EITHER — the pause fan-out disarmed
    // exactly those sessions — so a fold that consulted liveness before status
    // would render a deliberate hold as a dead goal. `deactivated` stays FALSE
    // and `status` stays `paused`, never `dormant`.
    expect(res.data).toEqual({
      id: 'g-1',
      title: 'Ship v1',
      status: 'paused',
      rawStatus: 'paused',
      deactivated: false,
      holderLiveness: 'unheld',
      // EI-22084485266424071 — see the note on the Gap 11 summary assertion.
      holders: [],
      pause: {
        reason: 'owner holding the spend',
        by: 'su-abc',
        at: new Date(1_755_000_000_000).toISOString(),
      },
      // EI-23738380307533850: `actionable` answers "is this doable RIGHT NOW",
      // so it is folded through `goalActionable` and a deliberate hold makes it
      // FALSE. It used to read `true` here — the same defect as a killed goal
      // reading actionable, and for the same reason: `actionable` was derived
      // from the blocker fold alone, which knows nothing about the goal's own
      // status. A payload that says "paused, by whom, why" in one field and
      // "go" in the next is exactly what this P-005 block exists to prevent.
      actionable: false,
      premiseInvalidated: false,
      // P-018 (WI-41129) — see the note on the summary assertion above.
      packageUpdate: null,
      portfolioThroughput: expect.objectContaining({ assessment: 'not-held', reason: 'not-held' }),
    });
  });

  it('an ACTIVE goal reports pause:null — not a missing key a caller has to interpret', async () => {
    fixtureQueue = [[GOAL_ROW()]];
    const res = await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never);
    expect(res.data).toHaveProperty('pause', null);
  });

  it('full mode carries pause AND the archived lastPause', async () => {
    fixtureQueue = [
      [
        GOAL_ROW({
          status: 'active',
          metadata: {
            lastPause: {
              reason: 'held over the weekend',
              pausedBy: 'su-xyz',
              pausedAtMs: 1_754_000_000_000,
              resumedAtMs: 1_754_500_000_000,
            },
          },
        }),
      ],
      [],
    ];
    const res = await tool.handler({ id: 'g-1', detail: 'full' } as never, CTX() as never);
    const data = res.data as Record<string, unknown>;
    expect(data.pause).toBeNull();
    expect(data.lastPause).toEqual({
      reason: 'held over the weekend',
      by: 'su-xyz',
      at: new Date(1_754_000_000_000).toISOString(),
    });
  });

  it('a MALFORMED record degrades to null legs rather than throwing', async () => {
    // A reader that crashes on bad jsonb is worse than one that reports what it
    // found — the same tolerance `routines/list.ts`'s `pauseOf` carries.
    fixtureQueue = [[GOAL_ROW({ status: 'paused', metadata: { pause: { reason: 42 } } })]];
    const res = await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never);
    expect((res.data as Record<string, unknown>).pause).toEqual({
      reason: null,
      by: null,
      at: null,
    });
  });
});

describe('goals:get — full mode fires the children query (Gap 11)', () => {
  it('full spreads the goal and attaches children from a SECOND query', async () => {
    const goal = GOAL_ROW();
    fixtureQueue = [
      [goal],
      [
        { id: 'g-2', title: 'Child A' },
        { id: 'g-3', title: 'Child B' },
      ],
    ];
    const res = await tool.handler({ id: 'g-1', detail: 'full' } as never, CTX() as never);
    expect(queriesBuilt).toBe(2); // goal row + children
    expect(res.data).toEqual({
      ...goal,
      // P-004: these OVERRIDE the `...goal` spread — a full read must not hand
      // back the raw `active` for a goal nothing is holding either.
      status: 'dormant',
      rawStatus: 'active',
      deactivated: true,
      holderLiveness: 'unheld',
      holderPolicy: { requireLive: true, onLoss: 'deactivate', isDefault: true },
      holders: [],
      children: [
        { id: 'g-2', title: 'Child A' },
        { id: 'g-3', title: 'Child B' },
      ],
      assembledAt: null,
      reporting: null,
      history: {
        entries: [],
        truncated: false,
        limit: 100,
        omittedEntryIds: [],
        omittedEntryIdsTruncated: false,
      },
      historyContext: {
        status: 'available',
        brief: { fingerprint: 'goal-history-fingerprint' },
        recovery: { tool: 'goals:get', args: { id: 'g-1', detail: 'full' } },
      },
      pause: null,
      lastPause: null,
      actionable: true,
      premiseInvalidated: false,
      blockedBy: [],
      // P-018 (WI-41129) — see the note on the summary assertion above.
      packageUpdate: null,
      portfolioThroughput: expect.objectContaining({ assessment: 'not-held', reason: 'not-held' }),
    });
  });

  it('resolves omitted goal-history refs through the same canonical compiler', async () => {
    fixtureQueue = [[GOAL_ROW()], []];
    continuity.resolve.mockResolvedValue({
      schemaVersion: 'prior-attempt-refs-v1',
      records: [{ rawRef: 'WI-1#checkpoint', text: 'full descendant evidence' }],
      unresolved: [],
      fingerprint: 'goal-history-fingerprint',
    });

    const res = await tool.handler(
      { id: 'g-1', detail: 'full', priorAttemptRefs: ['WI-1#checkpoint'] } as never,
      CTX() as never,
    );
    expect(((res as { data: Record<string, unknown> }).data).priorAttemptRecords).toMatchObject({
      records: [{ rawRef: 'WI-1#checkpoint', text: 'full descendant evidence' }],
      unresolved: [],
    });
    expect(continuity.resolve).toHaveBeenCalledWith({
      target: { kind: 'goal', ref: 'g-1' },
      rawRefs: ['WI-1#checkpoint'],
    });
  });

  it('full mode with no children → empty children array (second query still fires)', async () => {
    fixtureQueue = [[GOAL_ROW()], []];
    const res = await tool.handler({ id: 'g-1', detail: 'full' } as never, CTX() as never);
    expect(queriesBuilt).toBe(2);
    expect((res.data as Record<string, unknown>).children).toEqual([]);
  });

  it('full mode reads append-only evidence and amendments from the goal', async () => {
    fixtureQueue = [[GOAL_ROW()], []];
    historyRows = [
      {
        id: 'history-2',
        ts: 2000,
        actor: 'blender',
        action: 'goal:evidence',
        details: { kind: 'finding', summary: 'retention fell', refs: ['WI-39969'] },
      },
      {
        id: 'history-1',
        ts: 1000,
        actor: 'su-goal-executor',
        action: 'goal:amendment',
        details: {
          kind: 'amendment',
          reason: 'measurement changed the plan',
          reasonSource: 'caller',
          changes: [{ field: 'budgetCents', before: 50000, after: 75000 }],
        },
      },
    ];

    const res = await tool.handler({ id: 'g-1', detail: 'full' } as never, CTX() as never);
    const history = (res.data as { history: { entries: unknown[] } }).history;
    expect(historyQueries).toBe(1);
    expect(history.entries).toEqual([
      {
        id: 'history-2',
        kind: 'finding',
        author: 'blender',
        at: new Date(2000).toISOString(),
        summary: 'retention fell',
        refs: ['WI-39969'],
      },
      {
        id: 'history-1',
        kind: 'amendment',
        author: 'su-goal-executor',
        at: new Date(1000).toISOString(),
        reason: 'measurement changed the plan',
        reasonSource: 'caller',
        changes: [{ field: 'budgetCents', before: 50000, after: 75000 }],
      },
    ]);
  });

  it('the children query binds parentId === id (lineage edge)', async () => {
    fixtureQueue = [[GOAL_ROW({ id: 'parent-7' })], []];
    await tool.handler({ id: 'parent-7', detail: 'full' } as never, CTX() as never);
    // wherePredicates[0] = goal lookup (eq id), [1] = children (eq parent_id id)
    expect(wherePredicates).toHaveLength(2);
    expect(wherePredicates[0]).toEqual({ kind: 'eq', col: 'id', value: 'parent-7' });
    expect(wherePredicates[1]).toEqual({ kind: 'eq', col: 'parent_id', value: 'parent-7' });
  });
});

describe('goals:get — arg schema (Gap 11)', () => {
  it('requires a non-empty id', () => {
    expect(tool.args.safeParse({ id: '' }).success).toBe(false);
    expect(tool.args.safeParse({ id: 'g-1' }).success).toBe(true);
  });

  it('detail defaults to summary and rejects unknown values', () => {
    expect(tool.args.parse({ id: 'g-1' }).detail).toBe('summary');
    expect(() => tool.args.parse({ id: 'g-1', detail: 'lineage' })).toThrow();
  });
});

describe('goals:get — registration smoke (Gap 15)', () => {
  it('is registered under goals:get with the goals:read capability', () => {
    const t = lookupByMcpName('goals:get')!;
    expect(t).toBeDefined();
    expect(t.capabilities).toContain('goals:read');
  });
});

describe('goals:get — workspace-global call-scope contract', () => {
  it('advertises the transport-scoped workspace and tells callers to omit harness', () => {
    const registered = lookupByMcpName('goals:get');
    expect(registered).toBeDefined();
    expect(registered!.description).toMatch(/workspace-global/i);
    expect(registered!.description).toMatch(/do not pass [`"]?harness/i);
    expect(registered!.guidance?.when).toMatch(/workspace-global/i);
    expect(registered!.guidance?.when).toMatch(/do not pass [`"]?harness/i);
    expect(registered!.guidance?.chaining).toMatch(/only the id and optional detail/i);
  });
});

/**
 * EI-22084485266424071 — "who holds this goal RIGHT NOW" must be answerable
 * from the DEFAULT read.
 *
 * `holderLiveness` shipped on the summary branch while `holders` was gated
 * behind detail='full', so `goals:get { id }` answered 'held' and could not say
 * by whom. That is not a smaller answer, it is an unusable one — and the only
 * remaining identity source, `metadata.agentOwnerId`, is a stale hand-written
 * field, which is precisely how the filing read a live goal as abandoned.
 *
 * Summary is the load-bearing branch: `state:subscribe` dispatches with only
 * `{ id }`, so `detail` always takes its default there.
 */
describe('goals:get — holder IDENTITY is on the summary branch (EI-22084485266424071)', () => {
  const dataOf = (res: unknown) => (res as { data: Record<string, unknown> }).data;
  const HOLDER = { ownerId: 'su-live-1', live: true, sessionState: 'live' };

  it('a HELD goal names its holder on the DEFAULT (summary) read', async () => {
    holderLivenessFixture = 'held';
    holdersFixture = [HOLDER];
    fixtureQueue = [[GOAL_ROW()]];
    // No `detail` at all — the exact shape state:subscribe dispatches.
    const res = await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never);
    expect(dataOf(res)).toMatchObject({ holderLiveness: 'held', holders: [HOLDER] });
  });

  it('summary and full return the IDENTICAL holders value — the two branches cannot drift', async () => {
    // The defect was two independently maintained response literals. Pinning
    // them to each other is what makes a future divergence fail here rather
    // than in a caller months later.
    holderLivenessFixture = 'held';
    holdersFixture = [HOLDER, { ownerId: 'su-dead-2', live: false, sessionState: 'ended' }];

    fixtureQueue = [[GOAL_ROW()]];
    const summary = dataOf(await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never));
    // `full` also reads children; give it a row queue that satisfies both.
    fixtureQueue = [[GOAL_ROW()], []];
    const full = dataOf(await tool.handler({ id: 'g-1', detail: 'full' } as never, CTX() as never));

    expect(summary.holders).toEqual(full.holders);
    expect(summary.holderLiveness).toEqual(full.holderLiveness);
    // and it is the real projection, not two matching empties
    expect(summary.holders).toEqual([
      { ownerId: 'su-live-1', live: true, sessionState: 'live' },
      { ownerId: 'su-dead-2', live: false, sessionState: 'ended' },
    ]);
  });

  /**
   * WI-10002038 — `launchSettings` has REPLACE semantics on goals:update, so a correct
   * read-modify-write REQUIRES the reader to hand back the WHOLE document, and this is that
   * reader. The property was previously unguarded, and it has already cost real data: the
   * WI-10002016 filer DID read first, still lost keys, and the values had to be recovered from
   * harness_shared.audit_log.
   *
   * WI-10002038 was filed as "goals:get returns launchSettings PROJECTION-TRUNCATED". It does
   * not: it omits the key ENTIRELY at detail:'summary' (the full branch spreads the goal row,
   * the summary branch does not) and returns it COMPLETE at detail:'full'. Both halves are
   * pinned here, because each has its own failure mode — a future change that clips the
   * full-branch document, or one that starts half-populating the summary branch and invites a
   * caller to round-trip THAT, must fail here rather than in a caller's silently lost keys.
   */
  it('returns the WHOLE launchSettings document at detail:full (RMW round-trip), and none at summary', async () => {
    const LAUNCH_SETTINGS = {
      holder: { onLoss: 'respawn', requireLive: true },
      defaults: { agent: 'claude', carry: 'warm', model: 'claude-opus-5', effort: 'xhigh', account: 'auto' },
      maxAgents: 6,
      maxPerFleet: 2,
    };

    fixtureQueue = [[GOAL_ROW({ launchSettings: LAUNCH_SETTINGS })]];
    const summary = dataOf(await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never));
    // `full` also reads children; give it a row queue that satisfies both.
    fixtureQueue = [[GOAL_ROW({ launchSettings: LAUNCH_SETTINGS })], []];
    const full = dataOf(await tool.handler({ id: 'g-1', detail: 'full' } as never, CTX() as never));

    // DEEP-EQUAL on purpose: the guarded bug is a MISSING key, and a key-by-key spot check only
    // catches the keys whoever wrote the check happened to think of.
    expect(full.launchSettings).toEqual(LAUNCH_SETTINGS);
    // the two keys the filed report named — one of them NESTED under `defaults`, which is why a
    // flat scan for a top-level `account` reports it missing when it is present.
    expect((full.launchSettings as typeof LAUNCH_SETTINGS).maxPerFleet).toBe(2);
    expect((full.launchSettings as typeof LAUNCH_SETTINGS).defaults.account).toBe('auto');
    // the documented split, so nobody "fixes" the wrong branch
    expect(summary.launchSettings).toBeUndefined();
    // CALIBRATION — without this, the line above passes vacuously on an empty/broken projection,
    // since a missing body yields `undefined` just as a correctly-omitted key does. Prove the
    // summary read really happened (the neighbouring holders test guards itself the same way).
    expect(summary.id).toBe('g-1');
    expect(summary.title).toBe('Ship v1');
  });

  it('an UNHELD goal reports holders:[] — absence is stated, never omitted', async () => {
    // The null-vs-missing rule the portfolioThroughput block states: a caller
    // must be able to tell "nobody holds it" from "this build does not report
    // holders", and an omitted key cannot express the difference.
    holderLivenessFixture = 'unheld';
    fixtureQueue = [[GOAL_ROW()]];
    const res = await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never);
    expect(dataOf(res)).toMatchObject({ holderLiveness: 'unheld', holders: [] });
    expect(Object.keys(dataOf(res))).toContain('holders');
  });
});
