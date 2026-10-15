/**
 * Unit tests for tool-rejection-rate (P-017).
 *
 * Falsifiability discipline (repo rule: a guard test that has never failed is a guard
 * you have not tested). Rather than mutate the module, this file keeps DELIBERATELY
 * WRONG rollups as permanent controls — `rollupWithoutSustainedBar` reproduces the
 * naive implementation this module exists to replace — plus a calibration case that the
 * REAL implementation must pass. If the sustained bar ever silently stops applying, the
 * control and the real subject converge and the control test fails.
 */
import { describe, it, expect } from 'vitest';
import {
  rollupToolRejections,
  gradeToolRejections,
  describeToolRejection,
  readToolRejectionRate,
  TOOL_REJECTION_RATE_DAILY_SQL,
  TOOL_REJECTION_MIN_BREACH_DAYS,
  type ToolRejectionDayRow,
} from './tool-rejection-rate';

/** Build a day row with sane defaults. */
function day(
  toolName: string,
  d: string,
  calls: number,
  rejects: number,
  distinctOwners = 3,
  lastErrorMessage: string | null = 'field: Required',
): ToolRejectionDayRow {
  return { toolName, day: d, calls, rejects, distinctOwners, lastErrorMessage };
}

/**
 * CONTROL — the naive detector: window rate only, no sustained bar. This is what the
 * codebase would have if P-017 were implemented the obvious way. It is kept here
 * permanently so the sustained requirement is demonstrably load-bearing rather than
 * decorative.
 */
function rollupWithoutSustainedBar(rows: readonly ToolRejectionDayRow[]): string[] {
  const byTool = new Map<string, { calls: number; rejects: number }>();
  for (const r of rows) {
    const a = byTool.get(r.toolName) ?? { calls: 0, rejects: 0 };
    a.calls += r.calls;
    a.rejects += r.rejects;
    byTool.set(r.toolName, a);
  }
  return [...byTool.entries()]
    .filter(([, a]) => a.calls >= 100 && (100 * a.rejects) / a.calls >= 10)
    .map(([t]) => t);
}

describe('rollupToolRejections', () => {
  it('files a verb that sustains the rate across separate days', () => {
    const rows = [
      day('operator:converse', '2026-09-01', 60, 60),
      day('operator:converse', '2026-09-02', 60, 60),
      day('operator:converse', '2026-09-03', 60, 60),
    ];
    const roll = rollupToolRejections(rows, 7);
    expect(roll.breaching.map((b) => b.toolName)).toEqual(['operator:converse']);
    expect(roll.breaching[0]!.schemaRejectPct).toBe(100);
    expect(roll.breaching[0]!.breachDays).toBe(3);
  });

  it('does NOT file a one-day spike, even at a high window rate', () => {
    // A schema tightening on a single day: legitimate, self-correcting, must not file.
    const rows = [
      day('plans:new', '2026-09-01', 100, 0),
      day('plans:new', '2026-09-02', 100, 60), // the tightening
      day('plans:new', '2026-09-03', 100, 0),
    ];
    const roll = rollupToolRejections(rows, 7);
    // Window rate is 20% — above the bar — but it breached on only ONE day.
    expect(roll.totalRejects / roll.totalCalls).toBeCloseTo(0.2, 5);
    expect(roll.breaching).toEqual([]);

    // CONTROL: the naive detector fires on exactly this case. If this expectation ever
    // fails, the two implementations have converged and the sustained bar is inert.
    expect(rollupWithoutSustainedBar(rows)).toEqual(['plans:new']);
  });

  it('CALIBRATION: the real subject still fires when the spike becomes chronic', () => {
    // Same shape as the test above but breaching on the required number of days, so a
    // control that passes only because the subject files NOTHING would be caught here.
    const rows = Array.from({ length: TOOL_REJECTION_MIN_BREACH_DAYS }, (_, i) =>
      day('plans:new', `2026-09-0${i + 1}`, 100, 60),
    );
    expect(rollupToolRejections(rows, 7).breaching.map((b) => b.toolName)).toEqual(['plans:new']);
    expect(rollupWithoutSustainedBar(rows)).toEqual(['plans:new']);
  });

  it('ignores days too quiet for a rate to mean anything', () => {
    // 2/2 = 100% on three days is not a design defect; it is six calls.
    const rows = [
      day('rare:verb', '2026-09-01', 2, 2),
      day('rare:verb', '2026-09-02', 2, 2),
      day('rare:verb', '2026-09-03', 2, 2),
    ];
    const roll = rollupToolRejections(rows, 7);
    expect(roll.breaching).toEqual([]);
    expect(roll.toolsSeen).toBe(1);
  });

  it('does not file a verb below the window-total floor', () => {
    const rows = [
      day('quiet:verb', '2026-09-01', 25, 25),
      day('quiet:verb', '2026-09-02', 25, 25),
      day('quiet:verb', '2026-09-03', 25, 25),
    ];
    // 75 calls < the 100-call window floor, despite 3 breach days at 100%.
    expect(rollupToolRejections(rows, 7).breaching).toEqual([]);
  });

  it('reproduces the P-017 regression: a healthy aggregate hiding a broken verb', () => {
    // The measured 2026-09-02 shape — one verb at 100%, drowned by fleet volume.
    const rows = [
      day('operator:converse', '2026-09-01', 56, 56, 4),
      day('operator:converse', '2026-09-02', 56, 56, 4),
      day('operator:converse', '2026-09-03', 56, 56, 4),
      day('work_items:get', '2026-09-01', 40000, 60, 20, null),
      day('work_items:get', '2026-09-02', 40000, 60, 20, null),
      day('work_items:get', '2026-09-03', 40000, 60, 20, null),
    ];
    const roll = rollupToolRejections(rows, 7);
    expect(roll.aggregatePct).toBeLessThan(1); // the number that hides it
    expect(roll.breaching.map((b) => b.toolName)).toEqual(['operator:converse']);

    // The grade must state BOTH, or it re-creates the blindness it was built to fix.
    const grade = gradeToolRejections(roll);
    expect(grade.rating).toBe('degraded');
    expect(grade.evidence).toContain('operator:converse');
    expect(grade.evidence).toContain(String(roll.aggregatePct));
  });

  it('sorts worst-rate-first and is deterministic across ties', () => {
    const mk = (t: string, rejects: number) =>
      ['2026-09-01', '2026-09-02', '2026-09-03'].map((d) => day(t, d, 100, rejects));
    const roll = rollupToolRejections([...mk('b:verb', 20), ...mk('a:verb', 20), ...mk('c:verb', 50)], 7);
    expect(roll.breaching.map((b) => b.toolName)).toEqual(['c:verb', 'a:verb', 'b:verb']);
  });

  it('keeps the most recent rejection message as evidence', () => {
    const rows = [
      day('x:verb', '2026-09-01', 100, 30, 3, 'old: message'),
      day('x:verb', '2026-09-03', 100, 30, 3, 'newest: message'),
      day('x:verb', '2026-09-02', 100, 30, 3, 'middle: message'),
    ];
    expect(rollupToolRejections(rows, 7).breaching[0]!.lastErrorMessage).toBe('newest: message');
  });
});

describe('gradeToolRejections', () => {
  it('reports unknown for a silent window, not healthy', () => {
    const grade = gradeToolRejections(rollupToolRejections([], 7));
    expect(grade.rating).toBe('unknown');
    expect(grade.breachingTools).toEqual([]);
  });

  it('reports healthy when traffic exists and nothing sustains a breach', () => {
    const rows = ['2026-09-01', '2026-09-02', '2026-09-03'].map((d) => day('ok:verb', d, 500, 1));
    const grade = gradeToolRejections(rollupToolRejections(rows, 7));
    expect(grade.rating).toBe('healthy');
  });

  it('never escalates to a paging rating — this is a design defect, not an outage', () => {
    const rows = ['2026-09-01', '2026-09-02', '2026-09-03'].map((d) => day('bad:verb', d, 200, 200));
    const grade = gradeToolRejections(rollupToolRejections(rows, 7));
    expect(grade.rating).toBe('degraded');
    expect(grade.rating).not.toBe('broken');
  });
});

describe('describeToolRejection', () => {
  it('attributes the finding to the tool and carries the hiding aggregate', () => {
    const rows = [
      ...['2026-09-01', '2026-09-02', '2026-09-03'].map((d) => day('coord:send', d, 1500, 320, 69)),
      day('busy:verb', '2026-09-01', 100000, 10, 2, null),
    ];
    const roll = rollupToolRejections(rows, 7);
    const row = roll.breaching.find((b) => b.toolName === 'coord:send')!;
    const finding = describeToolRejection(row, roll);

    expect(finding.watchdogKey).toBe('tool-rejection-rate:coord:send');
    expect(finding.title).toContain('coord:send');
    expect(finding.body).toContain('filed against the TOOL');
    expect(finding.body).toContain(`${roll.aggregatePct}%`);
    // The FLOOR caveat must survive into the filed item, or a reader quotes the rate
    // as a total — the exact misreading the module docblock exists to prevent.
    expect(finding.body).toContain('FLOOR');
  });
});

describe('readToolRejectionRate (two-pass)', () => {
  const counts = ['2026-09-01', '2026-09-02', '2026-09-03'].map((d) => ({
    tool_name: 'coord:send',
    day: d,
    calls: 1000,
    rejects: 300,
  }));

  it('skips the expensive evidence pass entirely when nothing breaches', async () => {
    const seen: string[] = [];
    const runQuery = (async (sql: string) => {
      seen.push(sql);
      return [{ tool_name: 'fine:verb', day: '2026-09-01', calls: 1000, rejects: 1 }];
    }) as Parameters<typeof readToolRejectionRate>[0];

    const roll = await readToolRejectionRate(runQuery, { workspaceId: 'w' });
    expect(roll.breaching).toEqual([]);
    // The whole point of the split: a healthy fleet never pays for the second scan.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(TOOL_REJECTION_RATE_DAILY_SQL);
  });

  it('joins evidence back onto the breaching verb by (tool, day)', async () => {
    const runQuery = (async (sql: string, params: unknown[]) => {
      if (sql === TOOL_REJECTION_RATE_DAILY_SQL) return counts;
      // Second pass must be narrowed to the breaching names, not the whole window.
      expect(params[2]).toEqual(['coord:send']);
      return [
        {
          tool_name: 'coord:send',
          day: '2026-09-03',
          distinct_owners: 69,
          last_error_message: 'couldNotDetermine: Expected object, received string',
        },
      ];
    }) as Parameters<typeof readToolRejectionRate>[0];

    const roll = await readToolRejectionRate(runQuery, { workspaceId: 'w' });
    expect(roll.breaching).toHaveLength(1);
    expect(roll.breaching[0]!.peakDistinctOwners).toBe(69);
    expect(roll.breaching[0]!.lastErrorMessage).toContain('couldNotDetermine');
    // Counts must survive the re-fold unchanged — the second pass adds evidence only.
    expect(roll.breaching[0]!.calls).toBe(3000);
    expect(roll.breaching[0]!.schemaRejectPct).toBe(30);
  });
});

describe('TOOL_REJECTION_RATE_DAILY_SQL', () => {
  it('excludes role-not-allowed from the denominator', () => {
    // The denominator enumerates the statuses that reached the schema boundary; a
    // permissions refusal is not one, and leaving it in would dilute any restricted verb.
    expect(TOOL_REJECTION_RATE_DAILY_SQL).toContain(
      "status IN ('ok','error','timeout','invalid-input')",
    );
    expect(TOOL_REJECTION_RATE_DAILY_SQL).not.toContain('role-not-allowed');
  });

  it('scopes by workspace and groups to the daily grain the sustained bar needs', () => {
    expect(TOOL_REJECTION_RATE_DAILY_SQL).toContain('workspace_id = $1');
    expect(TOOL_REJECTION_RATE_DAILY_SQL).toContain('GROUP BY tool_name');
  });

  it('EI-24917731383616292: never drops dispatch-wrapper rows in WHERE — it counts them as wrapper_calls', () => {
    // The wrapper mark is stamped inside the handler, so only calls that PASSED the
    // schema boundary carry it. A row-level exclusion therefore removes successes from
    // the denominator while every rejection stays in the numerator.
    const where = TOOL_REJECTION_RATE_DAILY_SQL.slice(
      TOOL_REJECTION_RATE_DAILY_SQL.indexOf('WHERE workspace_id'),
      TOOL_REJECTION_RATE_DAILY_SQL.indexOf('GROUP BY'),
    );
    expect(where).toContain('workspace_id = $1');
    expect(where).not.toContain('dispatchWrapper');
    expect(TOOL_REJECTION_RATE_DAILY_SQL).toContain('AS wrapper_calls');
    expect(TOOL_REJECTION_RATE_DAILY_SQL).toContain('dispatchWrapper');
  });
});

/**
 * EI-24917731383616292 — the measured shape that produced a false 78.8% filing: on
 * 2026-09-26..10-03 the ledger held 203,163 marked `ok` tools:invoke rows and 335
 * unmarked `invalid-input` rows. Daily figures below are that population scaled to days.
 */
describe('dispatch-wrapper rows (EI-24917731383616292)', () => {
  const days = ['2026-09-30', '2026-10-01', '2026-10-02'];
  const wrapperDays: ToolRejectionDayRow[] = days.map((d) => ({
    ...day('tools:invoke', d, 30_100, 100),
    wrapperCalls: 30_000,
  }));

  /**
   * CONTROL — the pre-fix semantics: marked rows filtered out of the population before
   * counting, so only the unmarked (failed) rows remain as `calls`.
   */
  function rollupWithWrapperRowsDropped(rows: readonly ToolRejectionDayRow[]) {
    return rollupToolRejections(
      rows.map((r) => ({ ...r, calls: r.calls - (r.wrapperCalls ?? 0), wrapperCalls: 0 })),
    );
  }

  it('CONTROL: dropping marked rows reproduces the false breach', () => {
    const roll = rollupWithWrapperRowsDropped(wrapperDays);
    expect(roll.breaching.map((b) => b.toolName)).toEqual(['tools:invoke']);
    expect(roll.breaching[0]!.schemaRejectPct).toBe(100);
  });

  it('rates a wrapper over its whole population, so a ~0.3% verb is not filed', () => {
    const roll = rollupToolRejections(wrapperDays);
    expect(roll.breaching).toEqual([]);
  });

  it('CALIBRATION: a wrapper that really rejects most calls still breaches', () => {
    const bad = days.map((d) => ({ ...day('tools:invoke', d, 1_000, 800), wrapperCalls: 200 }));
    const roll = rollupToolRejections(bad);
    expect(roll.breaching.map((b) => b.toolName)).toEqual(['tools:invoke']);
    expect(roll.breaching[0]!.schemaRejectPct).toBe(80);
  });

  it('keeps the fleet aggregate a de-duplicated census: marked rows leave totalCalls only', () => {
    const roll = rollupToolRejections([
      ...wrapperDays,
      ...days.map((d) => day('coord:send', d, 30_000, 30)),
    ]);
    expect(roll.totalCalls).toBe(3 * 100 + 3 * 30_000);
    expect(roll.totalRejects).toBe(3 * 100 + 3 * 30);
  });

  it('reads wrapper_calls from the daily SQL row', async () => {
    const runQuery = (async () =>
      days.map((d) => ({ tool_name: 'tools:invoke', day: d, calls: '30100', rejects: '100', wrapper_calls: '30000' }))
    ) as Parameters<typeof readToolRejectionRate>[0];
    const roll = await readToolRejectionRate(runQuery, { workspaceId: 'w' });
    expect(roll.breaching).toEqual([]);
    expect(roll.totalCalls).toBe(300);
  });
});
