/**
 * P-005 (goal-holder-plans-ideation-truthful-reports-2026-10-03): the DB half of
 * the goal owner-report truth checks. The pure judgement is covered in
 * goal-owner-report.test.ts; this file covers the row mapping of each read, the
 * ref union the correction check needs, and the fail-open contract (an
 * unreadable measurement skips its own check and never refuses a report).
 */
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOrgPgMock } = vi.hoisted(() => ({
  getOrgPgMock: vi.fn((): { sql: unknown } => {
    throw new Error('no database in this unit suite');
  }),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: getOrgPgMock,
}));

import {
  evaluateGoalOwnerReportTruth,
  makeGoalOwnerReportTruthReads,
  readGoalOwnerReportTruth,
  type GoalOwnerReportTruthReads,
} from './goal-owner-report-truth';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';

type Rows = Record<string, unknown>[];
type Route = (text: string, values: unknown[]) => Rows;

/**
 * A stand-in for the postgres.js tag. Fragment builders (ownerWallActionSql,
 * openOwnerWallPredicateSql) are returned as inspectable objects; every other
 * call is a query answered by `route` from its SQL text.
 */
function fakeSql(route: Route) {
  const queries: { text: string; values: unknown[] }[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    const head = text.trimStart();
    if (head.startsWith('COALESCE(') || head.startsWith('wall.status')) return { fragment: text, values };
    queries.push({ text, values });
    try {
      return Promise.resolve(route(text, values));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return { sql: sql as unknown as Sql, queries };
}

const GOAL = 'work-on-everything-60d3a8';
const WS = 'papercusp-workspace';

const fields = {
  moved: 'P-006 shipped (WI-10005778 done, WI-10005834 done)',
  cost: 'goal lineage $3,131.80 (goal-lineage-rollup)',
  ownerWalled: 'WI-10004856: choose the hud P-003 route (solo/fleet/drop)',
  killed: 'none',
  nextWake: 'loop fire in ~15 min',
};

beforeEach(() => {
  getOrgPgMock.mockClear();
});

describe('makeGoalOwnerReportTruthReads', () => {
  it('counts spend as measured only for a lineage rollup with no unmeasured remainder', async () => {
    const row = { spent: 313180, source: 'goal-lineage-rollup', at: '2026-10-03T02:00:00.000Z', unmeasured: null as string | null };
    const { sql, queries } = fakeSql(() => [row]);
    const reads = makeGoalOwnerReportTruthReads(sql, WS, GOAL);

    await expect(reads.readSpend()).resolves.toEqual({
      spentCents: 313180,
      measured: true,
      source: 'goal-lineage-rollup',
      measuredAt: '2026-10-03T02:00:00.000Z',
    });
    expect(queries[0]!.text).toContain('FROM harness_shared.goals');
    expect(queries[0]!.values).toEqual([WS, GOAL]);

    row.unmeasured = 'priced spend outside the lineage';
    await expect(reads.readSpend()).resolves.toMatchObject({ spentCents: 313180, measured: false });
    row.unmeasured = null;
    row.source = 'goal-pots';
    await expect(reads.readSpend()).resolves.toMatchObject({ measured: false, source: 'goal-pots' });
  });

  it('reads no spend for a missing goal row or a non-numeric amount', async () => {
    await expect(makeGoalOwnerReportTruthReads(fakeSql(() => []).sql, WS, GOAL).readSpend()).resolves.toBeNull();
    const text = fakeSql(() => [{ spent: '313180', source: 'goal-lineage-rollup', at: null, unmeasured: null }]);
    await expect(makeGoalOwnerReportTruthReads(text.sql, WS, GOAL).readSpend()).resolves.toMatchObject({
      spentCents: null,
      measured: false,
    });
  });

  it('reads open walls through the shared owner-action and open-wall SQL', async () => {
    const { sql, queries } = fakeSql(() => [
      { ref: 'WI-10004856', action: 'choose the hud P-003 route' },
      { ref: 'WI-10004875', action: null },
    ]);
    await expect(makeGoalOwnerReportTruthReads(sql, WS, GOAL).readOwnerWalls()).resolves.toEqual([
      { ref: 'WI-10004856', action: 'choose the hud P-003 route' },
      { ref: 'WI-10004875', action: null },
    ]);
    const fragments = queries[0]!.values.filter((value): value is { fragment: string; values: unknown[] } => typeof value === 'object' && value !== null && 'fragment' in value);
    // The action falls back to the active human blocker set_blocker writes; before
    // P-005 only ownerAction/ownerAsk were read and no live wall carried them.
    expect(fragments.some((f) => f.fragment.includes("'externalBlockers'") && f.fragment.includes("'human'"))).toBe(true);
    const predicate = fragments.find((f) => f.fragment.startsWith('wall.status'))!;
    // Cross-family reads must bind the canonical union so future lifecycle
    // changes cannot leave settled rows showing up as owner walls.
    expect(predicate.fragment).toContain('wall.status <> ALL(?::text[])');
    expect(predicate.values).toEqual([[...ANY_FAMILY_TERMINAL_STATES]]);
    expect(predicate.fragment).toContain("wall.status IN ('needs-human', 'needs_human') OR wall.needs_human_review");
    expect(predicate.fragment).toContain("COALESCE((wall.payload->>'needsOwnerAction')::boolean, false)");
    expect(predicate.fragment).toContain("COALESCE((wall.payload->>'needsHuman')::boolean, false)");
  });

  it("reads any holder's latest stamped report and keeps only well-formed cited refs", async () => {
    const { sql, queries } = fakeSql(() => [
      {
        ts: new Date('2026-10-03T01:00:00.000Z'),
        stamp: { goalId: GOAL, citedRefStates: [{ ref: 'WI-10005610', state: 'done' }, { ref: 5 }, 'junk'] },
      },
    ]);
    await expect(makeGoalOwnerReportTruthReads(sql, WS, GOAL).readPreviousReport()).resolves.toEqual({
      at: '2026-10-03T01:00:00.000Z',
      citedRefStates: [{ ref: 'WI-10005610', state: 'done' }],
    });
    expect(queries[0]!.text).toContain('harness_shared.coord_event_log');
    // Not scoped to the sender: a predecessor's report is the successor's baseline (WI-10005610).
    expect(queries[0]!.text).not.toMatch(/from_owner|sender/);

    const legacy = fakeSql(() => [{ ts: '2026-10-03T01:00:00.000Z', stamp: { goalId: GOAL } }]);
    await expect(makeGoalOwnerReportTruthReads(legacy.sql, WS, GOAL).readPreviousReport()).resolves.toEqual({
      at: '2026-10-03T01:00:00.000Z',
      citedRefStates: null,
    });
  });

  it('reads ref states in one query and skips the query when there are no refs', async () => {
    const { sql, queries } = fakeSql(() => [
      { ref: 'WI-1', status: 'done' },
      { ref: 'WI-2', status: 'open' },
    ]);
    const reads = makeGoalOwnerReportTruthReads(sql, WS, GOAL);
    await expect(reads.readRefStates([])).resolves.toEqual({});
    expect(queries).toHaveLength(0);
    await expect(reads.readRefStates(['WI-1', 'WI-2'])).resolves.toEqual({ 'WI-1': 'done', 'WI-2': 'open' });
    expect(queries).toHaveLength(1);
  });
});

describe('evaluateGoalOwnerReportTruth', () => {
  const reads = (over: Partial<GoalOwnerReportTruthReads> = {}): GoalOwnerReportTruthReads => ({
    readSpend: vi.fn(async () => ({ spentCents: 313180, measured: true, source: 'goal-lineage-rollup', measuredAt: null })),
    readOwnerWalls: vi.fn(async () => [{ ref: 'WI-10004856', action: 'choose the hud P-003 route' }]),
    readPreviousReport: vi.fn(async () => ({
      at: '2026-10-03T01:00:00.000Z',
      citedRefStates: [{ ref: 'WI-10005610', state: 'done' }],
    })),
    readRefStates: vi.fn(async () => ({ 'WI-10005778': 'done', 'WI-10005834': 'done', 'WI-10005610': 'open' })),
    ...over,
  });

  it("reads the states of this report's refs and the previous report's refs together, and owes the correction", async () => {
    const r = reads();
    const verdict = await evaluateGoalOwnerReportTruth(fields, r);

    expect(r.readRefStates).toHaveBeenCalledWith(['WI-10005778', 'WI-10005834', 'WI-10005610']);
    expect(verdict.violations).toEqual([
      expect.objectContaining({ check: 'correction', ref: 'WI-10005610', reportedState: 'done', currentState: 'open' }),
    ]);
    // The stamp baseline for the NEXT report is this report's MOVED refs only.
    expect(verdict.citedRefStates).toEqual([
      { ref: 'WI-10005778', state: 'done' },
      { ref: 'WI-10005834', state: 'done' },
    ]);
    expect(verdict.summary).toMatchObject({ cost: 'cited-measured', ownerWalls: 'all-listed-with-action' });
  });

  it('fails open per read: every unreadable measurement skips its own check and nothing is refused', async () => {
    const boom = async () => {
      throw new Error('connection closed');
    };
    const verdict = await evaluateGoalOwnerReportTruth(
      { ...fields, cost: 'not measured per goal; pot-wide $4266/24h', ownerWalled: 'WI-10004856' },
      reads({ readSpend: boom, readOwnerWalls: boom, readPreviousReport: boom, readRefStates: boom }),
    );
    expect(verdict).toEqual({
      violations: [],
      summary: { cost: 'unread', ownerWalls: 'unread', corrections: 'no-baseline' },
      citedRefStates: null,
    });
  });

  it('still judges the readable checks when only one read fails', async () => {
    const verdict = await evaluateGoalOwnerReportTruth(
      { ...fields, cost: 'not measured per goal; pot-wide $4266/24h' },
      reads({
        readOwnerWalls: async () => {
          throw new Error('timeout');
        },
      }),
    );
    expect(verdict.violations.map((v) => v.check)).toEqual(['cost', 'correction']);
    expect(verdict.summary.ownerWalls).toBe('unread');
  });
});

describe('readGoalOwnerReportTruth', () => {
  it('returns null instead of throwing when the database handle is unavailable', async () => {
    await expect(readGoalOwnerReportTruth(WS, GOAL, fields)).resolves.toBeNull();
    expect(getOrgPgMock).toHaveBeenCalledTimes(1);
  });

  it('judges the report against the org database when it is reachable', async () => {
    const { sql } = fakeSql((text) => {
      if (text.includes('FROM harness_shared.goals')) {
        return [{ spent: 313180, source: 'goal-lineage-rollup', at: '2026-10-03T02:00:00.000Z', unmeasured: null }];
      }
      if (text.includes('coord_event_log')) return [];
      if (text.includes('wall.feature_id AS ref')) return [{ ref: 'WI-10004856', action: 'choose the hud P-003 route' }];
      return [
        { ref: 'WI-10005778', status: 'done' },
        { ref: 'WI-10005834', status: 'done' },
      ];
    });
    getOrgPgMock.mockReturnValueOnce({ sql });
    const verdict = await readGoalOwnerReportTruth(WS, GOAL, { ...fields, cost: 'pot-wide $4266/24h' });

    expect(verdict?.violations).toEqual([expect.objectContaining({ check: 'cost', kind: 'measured-spend-not-cited' })]);
    expect(verdict?.summary).toEqual({ cost: 'unread', ownerWalls: 'all-listed-with-action', corrections: 'no-baseline' });
    expect(verdict?.citedRefStates).toEqual([
      { ref: 'WI-10005778', state: 'done' },
      { ref: 'WI-10005834', state: 'done' },
    ]);
  });
});
