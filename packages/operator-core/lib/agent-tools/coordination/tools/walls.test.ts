/**
 * coord:walls handler regression for WI-4557.
 *
 * getOrgPg() returns a wrapper object; only wrapper.sql is callable as a
 * postgres tagged template. Exercising the real handler with that shape makes
 * `const sql = await getOrgPg()` fail loudly instead of shipping again.
 *
 * Also WI-2141328 (below): the owner's "what's blocked on me" view ranked purely
 * by age and computed its counts AFTER the `limit` slice, so a backlog of
 * ancient dead rows crowded out every live ask and the summary reported
 * `waiting: 0` as though it were a fact about the world.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sql: vi.fn(), resolveSessionStates: vi.fn() }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: h.sql })),
}));

vi.mock('../liveness-oracle', async (orig) => ({
  ...(await orig<typeof import('../liveness-oracle')>()),
  resolveSessionStates: h.resolveSessionStates,
}));

const tool = (await import('./walls')).default;

type Out = {
  data: {
    ok: boolean;
    count: number;
    returned: number;
    truncatedByLimit: boolean;
    waiting: number;
    stranded: number;
    walls: Array<{
      ownerId: string | null;
      status: string;
      waitingHours: number | null;
      source?: string;
      claim?: string;
      origin?: string;
      requiresRevalidation?: boolean;
    }>;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveSessionStates.mockResolvedValue(new Map());
  h.sql
    .mockResolvedValueOnce([]) // coord_presence
    .mockResolvedValueOnce([]) // carry_notes
    .mockResolvedValueOnce([]) // needs-human work_items
    .mockResolvedValueOnce([]); // wall: standing facts
});

describe('coord:walls handler', () => {
  it('calls getOrgPg().sql as the tagged-template function and returns an empty wall set', async () => {
    const out = (await tool.handler({}, { workspaceId: 'ws-test' } as never)) as Out;

    expect(h.sql).toHaveBeenCalledTimes(4);
    expect(out.data).toMatchObject({
      ok: true,
      count: 0,
      waiting: 0,
      stranded: 0,
      walls: [],
    });
  });

  it('does not report a legacy unscoped carry wall as an actionable owner wait', async () => {
    h.sql.mockReset();
    h.sql
      .mockResolvedValueOnce([]) // coord_presence
      .mockResolvedValueOnce([{
        scope: 'loop:papercusp:su-legacy',
        note: '## Walls\n- Do not rerun the gate',
        updated_ts: new Date(),
      }])
      .mockResolvedValueOnce([]) // needs-human work_items
      .mockResolvedValueOnce([]); // wall: standing facts

    const out = (await tool.handler({}, { workspaceId: 'ws-test' } as never)) as Out;

    expect(out.data.waiting).toBe(0);
    expect(out.data.walls).toMatchObject([{
      source: 'loop-carry-note',
      claim: 'Do not rerun the gate',
      requiresRevalidation: true,
      status: 'unknown',
    }]);
    expect(h.resolveSessionStates).not.toHaveBeenCalled();
  });

  it('retains explicit system authority on a carry wall', async () => {
    h.sql.mockReset();
    h.sql
      .mockResolvedValueOnce([]) // coord_presence
      .mockResolvedValueOnce([{
        scope: 'loop:papercusp:su-system',
        note: '## Walls\n- [origin:system] Release gate lock',
        updated_ts: new Date(),
      }])
      .mockResolvedValueOnce([]) // needs-human work_items
      .mockResolvedValueOnce([]); // wall: standing facts

    const out = (await tool.handler({}, { workspaceId: 'ws-test' } as never)) as Out;

    expect(out.data.walls).toMatchObject([{
      source: 'loop-carry-note',
      claim: 'Release gate lock',
      origin: 'system',
      requiresRevalidation: false,
    }]);
  });
});

/**
 * WI-2141328. Reproduces the shape that made the live wall invisible: a pile of
 * much older rows whose sessions are dead, plus ONE recent wall whose agent is
 * alive, read back through a window smaller than the population.
 */
describe('coord:walls — a live ask is never crowded out by older dead rows', () => {
  const LIVE_OWNER = 'su-live-0001';
  const DEAD_OWNER = 'su-dead-0001';
  const now = Date.now();
  const hoursAgo = (n: number) => new Date(now - n * 3_600_000);

  /** 5 ancient dead walls (≈1300h) + 1 live wall raised 12h ago. */
  function seed() {
    const ancient = Array.from({ length: 5 }, (_, i) => ({
      feature_id: `WI-dead-${i}`,
      title: `ancient dead wall ${i}`,
      harness_slug: 'papercusp',
      taken_by: DEAD_OWNER,
      last_progress_at: hoursAgo(1300 + i),
    }));
    const live = {
      feature_id: 'WI-live-1',
      title: 'live owner-gated ask',
      harness_slug: 'papercusp',
      taken_by: LIVE_OWNER,
      last_progress_at: hoursAgo(12),
    };

    h.sql.mockReset();
    h.sql
      .mockResolvedValueOnce([
        {
          owner_id: LIVE_OWNER,
          workspace_id: 'ws-test',
          heartbeat_at: new Date(now).toISOString(),
          host: 'h',
          pid: 1,
          source: 's',
          agent_role: 'su',
        },
        {
          owner_id: DEAD_OWNER,
          workspace_id: 'ws-test',
          heartbeat_at: hoursAgo(1300).toISOString(),
          host: 'h',
          pid: 2,
          source: 's',
          agent_role: 'su',
        },
      ])
      .mockResolvedValueOnce([]) // carry_notes
      .mockResolvedValueOnce([...ancient, live])
      .mockResolvedValueOnce([]); // wall: standing facts

    h.resolveSessionStates.mockResolvedValue(
      new Map([
        [LIVE_OWNER, { ownerId: LIVE_OWNER, sessionState: 'live' }],
        [DEAD_OWNER, { ownerId: DEAD_OWNER, sessionState: 'ended' }],
      ]),
    );
  }

  it('returns the live wall even when the window is smaller than the dead backlog', async () => {
    seed();
    const out = (await tool.handler({ limit: 3 }, { workspaceId: 'ws-test' } as never)) as Out;

    // The whole point: ranking by age alone put all 5 ancient rows ahead of the
    // 12h live one, so a limit of 3 never reached it.
    expect(out.data.walls).toHaveLength(3);
    expect(out.data.walls.map((w) => w.ownerId)).toContain(LIVE_OWNER);
    expect(out.data.walls[0]).toMatchObject({ ownerId: LIVE_OWNER, status: 'waiting' });
  });

  it('counts the whole population, not the truncated window, and flags the truncation', async () => {
    seed();
    const out = (await tool.handler({ limit: 3 }, { workspaceId: 'ws-test' } as never)) as Out;

    // Previously `waiting` was computed after .slice(0, limit) — with the live
    // row cut off it read 0, i.e. "nothing is waiting on you".
    expect(out.data.waiting).toBe(1);
    expect(out.data.stranded).toBe(5);
    expect(out.data.count).toBe(6);
    expect(out.data.returned).toBe(3);
    expect(out.data.truncatedByLimit).toBe(true);
  });

  it('reports an untruncated read honestly', async () => {
    seed();
    const out = (await tool.handler({ limit: 50 }, { workspaceId: 'ws-test' } as never)) as Out;

    expect(out.data.count).toBe(6);
    expect(out.data.returned).toBe(6);
    expect(out.data.truncatedByLimit).toBe(false);
    expect(out.data.waiting).toBe(1);
  });

  /**
   * FALSIFIABILITY CONTROL — kept permanently, per CLAUDE.md § "Proving a guard
   * is falsifiable" (the tier for imported module logic: keep a deliberately
   * wrong implementation as a control rather than mutating the shared tree).
   *
   * This is the PRE-FIX algorithm: rank by age alone, slice, then count the
   * window. It must produce the broken result on the very fixture the tests
   * above use — otherwise those tests pass for free and guard nothing.
   */
  it('control: the pre-fix age-only ordering DOES drop the live wall from the same fixture', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({ ownerId: DEAD_OWNER, status: 'stranded', waitingHours: 1300 + i })),
      { ownerId: LIVE_OWNER, status: 'waiting', waitingHours: 12 },
    ];

    const preFix = [...rows].sort((a, b) => (b.waitingHours ?? -1) - (a.waitingHours ?? -1)).slice(0, 3);

    // The exact defect: the live ask is not in the window, and counting the
    // window instead of the population reports zero live asks.
    expect(preFix.map((w) => w.ownerId)).not.toContain(LIVE_OWNER);
    expect(preFix.filter((w) => w.status === 'waiting')).toHaveLength(0);

    // ...while the real handler, on the same shape, does surface it (asserted
    // in the two tests above). The fixture therefore discriminates.
  });

  it('surfaces the oldest ACTIONABLE wall in oldestWaitHours, not the oldest corpse', async () => {
    seed();
    const out = (await tool.handler({ limit: 3 }, { workspaceId: 'ws-test' } as never)) as unknown as {
      data: { oldestWaitHours: number | null };
    };

    // ~12, not ~1304: the number an owner acts on is the live ask's age.
    expect(out.data.oldestWaitHours).toBeGreaterThanOrEqual(11);
    expect(out.data.oldestWaitHours).toBeLessThan(20);
  });
});

describe('coord:walls — standing wall facts', () => {
  it('projects exact retract coordinates and the stored recheck probe', async () => {
    h.sql.mockReset();
    h.sql
      .mockResolvedValueOnce([
        {
          owner_id: 'su-fact-author',
          workspace_id: 'ws-test',
          heartbeat_at: new Date().toISOString(),
          host: 'h',
          pid: 3,
          source: 'codex',
          agent_role: 'su',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          scope: 'harness',
          scope_ref: 'papercusp',
          key: 'wall:voice-credential',
          body: 'Provide a voice credential.',
          created_by: 'su-fact-author',
          updated_at: new Date(),
          harness_slug: 'papercusp',
          recheck: { probe: 'accounts:status', falsifier: 'credential installed' },
        },
      ]);
    h.resolveSessionStates.mockResolvedValue(
      new Map([['su-fact-author', { ownerId: 'su-fact-author', sessionState: 'live' }]]),
    );

    const out = (await tool.handler({ harness: 'papercusp' }, { workspaceId: 'ws-test' } as never)) as unknown as {
      data: { walls: Array<Record<string, unknown>> };
    };

    expect(out.data.walls).toHaveLength(1);
    expect(out.data.walls[0]).toMatchObject({
      source: 'standing-fact',
      ownerId: 'su-fact-author',
      harness: 'papercusp',
      ref: 'wall:voice-credential',
      factScope: 'harness',
      factScopeRef: 'papercusp',
      factKey: 'wall:voice-credential',
      recheck: 'accounts:status',
      status: 'waiting',
    });
  });
});
