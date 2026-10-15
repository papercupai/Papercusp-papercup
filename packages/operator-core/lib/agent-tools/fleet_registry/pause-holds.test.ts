/**
 * pause-holds tests (EI-20199397615670608) — the claim-hold leg of fleet:pause / resume.
 *
 * `setWorkItemClaimHold` and the pg accessor are mocked WHOLESALE: this asserts the
 * three properties the bug turns on — (1) the park is DURABLE (`parkedBy`) and not a
 * liveness-bound LEASE (`by`), (2) resume clears ONLY this fleet's own marker, and
 * (3) both legs fail soft — plus the SQL PREDICATES that decide which rows are selected,
 * which are the part a reader cannot check by eye.
 *
 * The SQL is asserted by capturing the tagged-template the module builds. That is
 * deliberate: the membership predicate is the exact place the bug would silently
 * reappear (see the durable-membership note in pause-holds.ts), and a mock that only
 * checked the write calls would pass just as happily against a query that selects the
 * wrong rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlCalls: { text: string; values: unknown[] }[] = [];
let nextRows: { feature_id: string; harness_slug: string | null }[] = [];
let sqlThrows = false;

/** Minimal tagged-template stand-in for postgres.js: records the SQL, returns nextRows. */
const sqlTag = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join('?'), values });
    if (sqlThrows) throw new Error('pg down');
    return Promise.resolve(nextRows);
  },
  { begin: vi.fn() },
);

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: sqlTag }) }));
vi.mock('../../work-items', () => ({ setWorkItemClaimHold: vi.fn() }));
vi.mock('../../external-condition-reachability', () => ({ readEventConditionReachability: vi.fn() }));
vi.mock('../../work-item-dispatch-states', () => ({
  ANY_FAMILY_TERMINAL_STATES: ['done', 'dropped', 'resolved'],
}));

import { applyFleetPauseHolds as applyPauseHolds, clearFleetPauseHolds, fleetPauseHoldMarker } from './pause-holds';
import { setWorkItemClaimHold } from '../../work-items';
import { readEventConditionReachability } from '../../external-condition-reachability';

const resumeGate = 'fleet:my-fleet:announced:resume-generation-2';
const applyFleetPauseHolds = (args: Parameters<typeof applyPauseHolds>[0]) => applyPauseHolds({ resumeGate, ...args });

const holdM = vi.mocked(setWorkItemClaimHold);
const ok = (id: string) => ({ id, harness: null, hold: true, applicable: true });

beforeEach(() => {
  sqlCalls.length = 0;
  nextRows = [];
  sqlThrows = false;
  holdM.mockReset();
  holdM.mockImplementation(async (id: string) => ok(id));
  vi.mocked(readEventConditionReachability).mockReset();
  vi.mocked(readEventConditionReachability).mockResolvedValue({
    verdict: 'reachable', basis: 'live-resolver', authoritative: true,
    evidence: 'current resume announcement is active', checkedAt: '2026-10-08T00:00:00Z',
  });
});

describe('applyFleetPauseHolds — the pause leg', () => {
  it('parks each held item as a DURABLE park, never a liveness-bound lease', async () => {
    nextRows = [
      { feature_id: 'WI-1', harness_slug: 'sidestage' },
      { feature_id: 'WI-2', harness_slug: null },
    ];

    const res = await applyFleetPauseHolds({
      fleetSlug: 'my-fleet',
      workspaceId: 'ws-1',
      byOwnerId: 'su-owner',
      reason: 'owner paused',
    });

    expect(res.items).toEqual(['WI-1', 'WI-2']);
    expect(res.failed).toEqual([]);
    expect(holdM).toHaveBeenCalledTimes(2);

    const [, hold, opts] = holdM.mock.calls[0]!;
    expect(hold).toBe(true);
    // THE LOAD-BEARING ASSERTION. `by` would stamp a held_open_* LEASE, which the
    // WI-4531 reaper lifts ~2h after the (by-definition parked) members die — silently
    // re-exposing exactly the work the pause protected. Only `parkedBy` outlives them.
    expect(opts).toMatchObject({ parkedBy: 'su-owner' });
    expect(opts?.releaseContract).toEqual({
      condition: 'fleet my-fleet resumes', owner: 'su-owner', trigger: resumeGate,
      reachability: 'reachable', evidence: 'current resume announcement is active',
    });
    expect(readEventConditionReachability).toHaveBeenCalledWith(resumeGate, { requireSpecificCondition: true });
    expect(opts).not.toHaveProperty('by');
    expect(opts!.parkedReason).toBe(`${fleetPauseHoldMarker('my-fleet')} owner paused`);
    // The row's own harness is threaded through; a null one is omitted, not passed as null.
    expect(opts).toMatchObject({ harness: 'sidestage' });
    expect(holdM.mock.calls[1]![2]).not.toHaveProperty('harness');
  });

  it('reports every affected item when the resume gate is missing and writes no untracked park', async () => {
    nextRows = [{ feature_id: 'WI-1', harness_slug: 'sidestage' }];
    const result = await applyFleetPauseHolds({ fleetSlug: 'my-fleet', workspaceId: 'ws-1', byOwnerId: 'su-owner', resumeGate: null });
    expect(result).toEqual({ items: [], failed: ['WI-1'], degraded: 'fleet pause has no declared resume gate' });
    expect(holdM).not.toHaveBeenCalled();
  });

  it('uses latest durable membership, excludes a cross-fleet leader, and skips already-parked rows', async () => {
    await applyFleetPauseHolds({
      fleetSlug: 'my-fleet',
      workspaceId: 'ws-1',
      byOwnerId: 'su-owner',
      leaderOwnerId: 'su-leader',
    });

    const { text, values } = sqlCalls[0]!;
    // Membership must come from the append-only current fact, not the ephemeral presence
    // projection. A latest-fact join keeps a reaped member's held claim protected while
    // excluding an owner whose current membership moved to another fleet.
    expect(text).toContain('harness_shared.fleet_membership_events');
    expect(text).toContain('DISTINCT ON (e.owner_id)');
    expect(text).toContain('ORDER BY e.owner_id, e.id DESC');
    expect(text).toContain('m.fleet_slug');
    expect(text).not.toContain('harness_shared.coord_presence');
    // A member that has ALREADY parked in response to the pause is the very case this
    // protects, so membership must not be gated on heartbeat freshness.
    expect(text).not.toMatch(/heartbeat|stale|interval/i);
    // Only non-terminal, currently-held, not-already-parked rows.
    expect(text).toContain('_claimHold');
    expect(text).toContain('NOT (w.status = ANY(');
    // THE CLAIM-HOLDER COLUMN IS `taken_by`. `assignee` is a TOOL-LAYER projection name
    // with no column behind it: the first draft used it and Postgres raised 42703, which
    // the fail-soft catch swallowed whole — a pause that reports success and parks
    // NOTHING, i.e. the original bug wearing a "fixed" label. Pin both directions.
    expect(text).toContain('w.taken_by');
    expect(text).not.toContain('assignee');
    // The registry leader is deliberately NOT interpolated as an unconditional bypass:
    // a leader may hold claims for another fleet. The current durable membership fact is
    // the only predicate that includes a target-fleet leader's claims.
    expect(values).not.toContain('su-leader');
    expect(text).not.toMatch(/OR\s*\([^)]*leaderOwnerId|w\.taken_by\s*=\s*\?/i);
  });

  it('keeps target-fleet leaders in the same current-membership predicate as members', async () => {
    await applyFleetPauseHolds({
      fleetSlug: 'target-fleet',
      workspaceId: 'ws-1',
      byOwnerId: 'su-owner',
      leaderOwnerId: 'su-target-leader',
    });

    const { text } = sqlCalls[0]!;
    // There is no special leader branch: when su-target-leader's latest durable event is
    // target-fleet, the same m.fleet_slug filter includes that leader's claim; when the
    // latest event names another fleet, it excludes it. This is the regression's key
    // positive and negative distinction.
    expect(text).toContain('FROM current_membership m');
    expect(text).toContain('WHERE m.fleet_slug = ?');
    expect(text).not.toContain('leaderOwnerId');
  });

  it('reports a per-item write failure without aborting the rest', async () => {
    nextRows = [
      { feature_id: 'WI-1', harness_slug: null },
      { feature_id: 'WI-2', harness_slug: null },
      { feature_id: 'WI-3', harness_slug: null },
    ];
    holdM.mockImplementation(async (id: string) => {
      if (id === 'WI-2') throw new Error('pg hiccup');
      return ok(id);
    });

    const res = await applyFleetPauseHolds({
      fleetSlug: 'f',
      workspaceId: 'ws-1',
      byOwnerId: 'su-owner',
    });

    expect(res.items).toEqual(['WI-1', 'WI-3']);
    expect(res.failed).toEqual(['WI-2']);
  });

  it('fails soft when the QUERY throws — a hold failure never wedges the pause', async () => {
    sqlThrows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A throw from the write path is caught per-item (test above); a throw from the
    // query is caught by the outer guard. Neither may propagate: the control flip —
    // and above all the ability to RESUME — must survive a broken hold leg.
    const res = await applyFleetPauseHolds({
      fleetSlug: 'f',
      workspaceId: 'ws-1',
      byOwnerId: 'su-owner',
    });
    expect(res.items).toEqual([]);
    expect(holdM).not.toHaveBeenCalled();
    // ...but NOT silently. A wholesale failure must be distinguishable from "nothing
    // matched", or a pause that protects nothing looks exactly like a pause with nothing
    // to protect — which is how the original bug would return wearing a "fixed" label.
    expect(res.degraded).toContain('pg down');
    // The operator-visible half of that signal.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('lane NOT protected');
    warn.mockRestore();
  });

  it('a healthy empty result is NOT marked degraded', async () => {
    nextRows = [];
    const res = await applyFleetPauseHolds({
      fleetSlug: 'f',
      workspaceId: 'ws-1',
      byOwnerId: 'su-owner',
    });
    expect(res).toEqual({ items: [], failed: [] });
    expect(res.degraded).toBeUndefined();
  });
});

describe('clearFleetPauseHolds — the resume leg', () => {
  it('matches ONLY this fleet\'s own marker, so an unrelated deliberate park survives', async () => {
    await clearFleetPauseHolds({ fleetSlug: 'my-fleet', workspaceId: 'ws-1' });

    const { text, values } = sqlCalls[0]!;
    expect(text).toContain('claim_hold_reason');
    // Blanket-clearing every _claimHold would silently undo a WI-2797 hand-park set for
    // an unrelated reason. The marker is fleet-scoped, so one fleet's resume cannot lift
    // another fleet's pause either.
    expect(values).toContain(`${fleetPauseHoldMarker('my-fleet')}%`);
    expect(values).not.toContain('%');
  });

  it('clears the matched rows', async () => {
    nextRows = [{ feature_id: 'WI-9', harness_slug: 'papercusp' }];
    const res = await clearFleetPauseHolds({ fleetSlug: 'my-fleet', workspaceId: 'ws-1' });

    expect(res.items).toEqual(['WI-9']);
    const [id, hold, opts] = holdM.mock.calls[0]!;
    expect([id, hold]).toEqual(['WI-9', false]);
    expect(opts).toMatchObject({ harness: 'papercusp' });
  });
});

describe('fleetPauseHoldMarker', () => {
  it('is fleet-scoped and distinct per slug', () => {
    expect(fleetPauseHoldMarker('a')).not.toBe(fleetPauseHoldMarker('b'));
    expect(fleetPauseHoldMarker('a')).toContain('a');
  });

  // CALIBRATION CONTROL (repo guard discipline): a deliberately-wrong marker builder must
  // FAIL the property the real one satisfies. Without this, the assertions above would
  // pass just as happily against a constant marker shared by every fleet — which is the
  // exact defect that would make one fleet's resume lift another's pause.
  it('control: a fleet-INDEPENDENT marker is caught by the same property', () => {
    const wrong = (_slug: string) => '[fleet-pause]';
    expect(wrong('a')).toBe(wrong('b'));
  });
});

describe('control: the holder-column assertion is falsifiable', () => {
  // Proves the `taken_by` guard above DISCRIMINATES rather than merely passing. The
  // regression it exists to catch is not hypothetical — it is the bug this module
  // actually shipped in its first draft, where `assignee` (a tool-layer projection name
  // with no column behind it) raised 42703 and the fail-soft catch hid it entirely.
  // Mutating the real module to re-prove this would dirty a swept shared tree, so the
  // wrong implementation lives here permanently instead (repo mutation-probe tier 1).
  const wrongSql = `SELECT w.feature_id FROM harness_shared.work_items w WHERE w.assignee IS NOT NULL`;
  const rightSql = `SELECT w.feature_id FROM harness_shared.work_items w WHERE w.taken_by IS NOT NULL`;

  it('the wrong column FAILS both assertions the real query passes', () => {
    expect(wrongSql).not.toContain('w.taken_by');
    expect(wrongSql).toContain('assignee');
    expect(rightSql).toContain('w.taken_by');
    expect(rightSql).not.toContain('assignee');
  });
});
