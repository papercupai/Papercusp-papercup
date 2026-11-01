/**
 * tool-failure-rate tests (EI-18798264517111160).
 *
 * The load-bearing cases are the REGRESSION ones near the bottom: they replay the
 * real 2026-07-27 facts:assert outage out of live `tool_invocations` data, because a
 * detector for that incident that does not actually fire on that incident is worthless.
 */
import { describe, it, expect } from 'vitest';
import {
  rollupToolFailures,
  gradeToolFailures,
  readToolFailureRate,
  TOOL_FAILURE_RATE_SQL,
  TOOL_FAILURE_MIN_CALLS,
  TOOL_FAILURE_CRIT_PCT,
  TOOL_FAILURE_WARN_PCT,
  type ToolFailureRow,
} from './tool-failure-rate';

const row = (over: Partial<ToolFailureRow> & { toolName: string }): ToolFailureRow => ({
  calls: 10,
  fails: 0,
  lastErrorCode: null,
  lastErrorMessage: null,
  ...over,
});

describe('rollupToolFailures', () => {
  it('ignores a tool below the minimum call count — a 1-of-1 failure is noise, not an outage', () => {
    const roll = rollupToolFailures([
      row({ toolName: 'a:b', calls: TOOL_FAILURE_MIN_CALLS - 1, fails: TOOL_FAILURE_MIN_CALLS - 1 }),
    ]);
    expect(roll.failing).toEqual([]);
    // ...but the calls still count toward the window total, so the window is not 'unknown'.
    expect(roll.totalCalls).toBe(TOOL_FAILURE_MIN_CALLS - 1);
  });

  it('ignores a tool failing below the warn threshold', () => {
    const roll = rollupToolFailures([row({ toolName: 'a:b', calls: 100, fails: 5 })]);
    expect(roll.failing).toEqual([]);
  });

  it('includes a tool at exactly the warn threshold (boundary is inclusive)', () => {
    const roll = rollupToolFailures([row({ toolName: 'a:b', calls: 10, fails: 3 })]);
    expect(roll.failing).toHaveLength(1);
    expect(roll.failing[0]!.failPct).toBe(TOOL_FAILURE_WARN_PCT);
  });

  it('sorts worst-rate-first and breaks ties deterministically, so the summary cannot flap', () => {
    const roll = rollupToolFailures([
      row({ toolName: 'z:z', calls: 10, fails: 5 }),
      row({ toolName: 'a:a', calls: 10, fails: 5 }),
      row({ toolName: 'm:m', calls: 10, fails: 9 }),
    ]);
    expect(roll.failing.map((f) => f.toolName)).toEqual(['m:m', 'a:a', 'z:z']);
  });
});

describe('gradeToolFailures', () => {
  it('reports unknown ONLY for a genuinely silent window', () => {
    expect(gradeToolFailures(rollupToolFailures([])).rating).toBe('unknown');
  });

  it('reports healthy when there is real traffic and nothing is failing', () => {
    const g = gradeToolFailures(rollupToolFailures([row({ toolName: 'a:b', calls: 500 })]));
    expect(g.rating).toBe('healthy');
    expect(g.brokenTools).toEqual([]);
  });

  it('reports degraded below the crit cutoff and does NOT name a broken tool', () => {
    const g = gradeToolFailures(rollupToolFailures([row({ toolName: 'a:b', calls: 10, fails: 4 })]));
    expect(g.rating).toBe('degraded');
    // brokenTools drives the page; a degraded tool must never populate it.
    expect(g.brokenTools).toEqual([]);
  });

  it('reports broken at the crit cutoff and names every broken tool', () => {
    const g = gradeToolFailures(
      rollupToolFailures([
        row({ toolName: 'a:b', calls: 10, fails: 6 }),
        row({ toolName: 'c:d', calls: 10, fails: 10 }),
      ]),
    );
    expect(g.rating).toBe('broken');
    expect(g.brokenTools).toEqual(['c:d', 'a:b']);
    expect(g.evidence).toContain('+1 other tool(s) also failing');
  });

  it('surfaces the error code and message so the escalation is actionable without a query', () => {
    const g = gradeToolFailures(
      rollupToolFailures([
        row({
          toolName: 'facts:assert',
          calls: 8,
          fails: 8,
          lastErrorCode: 'handler_error',
          lastErrorMessage: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
        }),
      ]),
    );
    expect(g.evidence).toContain('handler_error');
    expect(g.evidence).toContain('ON CONFLICT');
  });
});

describe('readToolFailureRate', () => {
  it('scopes the query to a workspace and coerces PG string counts to numbers', async () => {
    const seen: unknown[][] = [];
    const roll = await readToolFailureRate(
      async (_q, params) => {
        seen.push(params);
        // node-postgres returns bigint aggregates as STRINGS — the coercion is the point.
        return [{ tool_name: 'a:b', calls: '10', fails: '8', last_error_code: 'handler_error', last_error_message: null }] as never;
      },
      { workspaceId: 'ws-1', windowMin: 15 },
    );
    expect(seen[0]).toEqual(['ws-1', 15]);
    expect(roll.failing[0]!.failPct).toBe(80);
    expect(roll.failing[0]!.calls).toBe(10);
  });

  it('excludes caller errors and stale MCP contracts from handler-health counts', () => {
    // Enforced in SQL, so assert the contract at the source: a strict validator
    // rejecting bad args must never read as a broken tool.
    expect(TOOL_FAILURE_RATE_SQL).toContain("status IN ('error','timeout')");
    expect(TOOL_FAILURE_RATE_SQL).not.toContain('invalid-input');
    expect(TOOL_FAILURE_RATE_SQL).not.toContain('role-not-allowed');
    // And the denominator is the same restricted set, not count(*).
    expect(TOOL_FAILURE_RATE_SQL).toContain("count(*) FILTER (WHERE status IN ('ok','error','timeout')) AS calls");
    // stale_tool_contract can be logged as handler_error before the wrapper marks
    // its telemetry row, so exclude by both the normalized code and message prefix.
    expect(TOOL_FAILURE_RATE_SQL).toContain("error_code IS DISTINCT FROM 'stale_tool_contract'");
    expect(TOOL_FAILURE_RATE_SQL).toContain("COALESCE(error_message, '') NOT ILIKE 'stale_tool_contract:%'");
  });

  it('P-012: excludes dispatch-wrapper rows — a tools:invoke wrapper failure duplicates its inner row', () => {
    expect(TOOL_FAILURE_RATE_SQL).toContain(
      "NOT coalesce((metadata_json->>'dispatchWrapper')::boolean, false)",
    );
  });

  it('is workspace-scoped — an unscoped read would mix tenants', () => {
    expect(TOOL_FAILURE_RATE_SQL).toContain('workspace_id = $1');
  });
});

/**
 * REGRESSION — the 2026-07-27 facts:assert outage.
 *
 * Counts below are the real per-bucket readings from `harness_shared.tool_invocations`
 * (15-min buckets, local time). Migration 689 landed 08:37:31Z; the outage was not
 * recognised as fleet-wide until 11:37Z.
 */
describe('regression: the 2026-07-27 facts:assert outage', () => {
  const outage = (calls: number, fails: number) =>
    gradeToolFailures(
      rollupToolFailures([
        row({
          toolName: 'facts:assert',
          calls,
          fails,
          lastErrorCode: 'handler_error',
          lastErrorMessage: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
        }),
      ]),
    );

  it('fires on the FIRST window of the outage — the detection-latency claim', () => {
    // 04:30 bucket: 5 system-attributable calls, all 5 failed.
    const g = outage(5, 5);
    expect(g.rating).toBe('broken');
    expect(g.brokenTools).toEqual(['facts:assert']);
  });

  it('fires on the 04:45 window (8/8)', () => {
    expect(outage(8, 8).rating).toBe('broken');
  });

  it('STILL fires when staging traffic interleaves successes — the case a naive rule misses', () => {
    // The outage was NOT 100%: agents on :3170 ran different code and kept succeeding,
    // so `ok` rows sit between the errors for the whole incident. A "every call is
    // failing" rule would have missed this entirely. Whole-window reading: ~40 fails
    // against ~5 successes.
    const g = outage(45, 40);
    expect(g.rating).toBe('broken');
    expect(g.evidence).toContain('89%');
  });

  it('a 100%-only rule would NOT have caught the interleaved window — proving the cutoff must be proportional', () => {
    const roll = rollupToolFailures([row({ toolName: 'facts:assert', calls: 45, fails: 40 })]);
    const pct = roll.failing[0]!.failPct;
    expect(pct).toBeLessThan(100);
    expect(pct).toBeGreaterThanOrEqual(TOOL_FAILURE_CRIT_PCT);
  });

  it('a mid-outage lull reads degraded, not healthy — it never reports the outage as resolved', () => {
    // Some mid-incident buckets dip (e.g. 2 fails against 3 staging successes). The
    // detector must not call that HEALTHY: the escalation stays visible as degraded and
    // re-fires when the rate climbs again (liveness-alarm's flap suppression owns the
    // repeat-page budget, EI-9939). This is the honest limit of a windowed rate — the
    // signal degrades, it does not invert.
    const g = outage(5, 2);
    expect(g.rating).toBe('degraded');
    expect(g.rating).not.toBe('healthy');
  });

  it('grades the recovery window healthy once the fix deploys', () => {
    // 07:50 bucket: 10 ok, 0 fails.
    expect(outage(10, 0).rating).toBe('healthy');
  });

  it('does not fire on the caller-error rows in the same window', () => {
    // The same window carried `invalid-input` rows for over-cap bodies, unrelated to the
    // outage. They are excluded in SQL, so they never reach the rollup — a window of
    // PURE caller errors presents as zero system-attributable calls.
    expect(gradeToolFailures(rollupToolFailures([])).rating).toBe('unknown');
  });
});
