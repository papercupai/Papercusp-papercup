import { describe, expect, it } from 'vitest';
import {
  TOOL_LATENCY_BUDGET_RATIO,
  TOOL_LATENCY_DEFAULT_BUDGET_SEC,
  TOOL_LATENCY_MIN_SAMPLES,
  effectiveToolBudgetSec,
  toolLatencyBudgetSignalsFromRows,
  toolLatencyBudgetsFromProjected,
  writeToolNames,
  toolRequestLatencySignalsFromRows,
  type ToolLatencyBudget,
  type ToolLatencyRow,
} from './tool-latency-budget';

const WRITE_60: ToolLatencyBudget = { timeoutSec: null, effect: 'write' };
const budgets = (entries: Record<string, ToolLatencyBudget>) => new Map(Object.entries(entries));
const row = (tool_name: string, p95_ms: number | string | null, n: number | string = 50): ToolLatencyRow => ({
  tool_name,
  n,
  p95_ms,
  latest_at: '2026-10-02T23:00:00.000Z',
  earliest_at: '2026-10-02T01:00:00.000Z',
});

describe('interactive request latency, independent of mutation safety', () => {
  const request = (peak_ms: number | string | null, p95_ms: number | null = 1_000, n = 25) => ({
    ...row('work_items:complete', p95_ms, n), peak_ms, peak_invocation_id: '47039661',
  });

  it('catches the 55.8s successful request even when fast calls keep p95 low', () => {
    const [signal] = toolRequestLatencySignalsFromRows([request(55_833)]);
    expect(signal).toMatchObject({ key: 'tool-request-latency:work_items:complete', severity: 'major' });
    expect(signal!.body).toContain('invocation 47039661');
    expect(signal!.body).toContain('55833ms');
  });

  it('catches a severe first request without waiting for twenty samples', () => {
    expect(toolRequestLatencySignalsFromRows([request('50000', null, 1)])).toHaveLength(1);
    expect(toolRequestLatencySignalsFromRows([request(49_999, null, 1)])).toEqual([]);
  });

  it('detects chronic latency at twenty samples, including below the outlier threshold', () => {
    expect(toolRequestLatencySignalsFromRows([request(25_000, 20_000, 20)])[0]?.severity).toBe('minor');
    expect(toolRequestLatencySignalsFromRows([request(25_000, 20_000, 19)])).toEqual([]);
    expect(toolRequestLatencySignalsFromRows([request(25_000, 19_999, 20)])).toEqual([]);
  });

  it('does not impose the completion SLO on intentionally long-running tools', () => {
    expect(toolRequestLatencySignalsFromRows([{ ...request(120_000), tool_name: 'testing:run' }])).toEqual([]);
  });

  it('keeps missing or malformed measurements unknown', () => {
    for (const peak of [null, 'NaN', -1]) {
      expect(toolRequestLatencySignalsFromRows([request(peak, 60_000)])).toEqual([]);
    }
  });
});

describe('threshold calibration (budget = dispatcher default 60s → 48s line)', () => {
  const b = budgets({ 'x:write': WRITE_60 });

  it('does NOT flag a write tool at 79% of budget', () => {
    expect(toolLatencyBudgetSignalsFromRows([row('x:write', 47_400)], b)).toEqual([]);
  });

  it('flags a write tool at 81% of budget', () => {
    const [signal] = toolLatencyBudgetSignalsFromRows([row('x:write', 48_600)], b);
    expect(signal).toBeDefined();
    expect(signal!.key).toBe('tool-latency-budget:x:write');
    expect(signal!.findingClass).toBe('tool-latency-budget');
    expect(signal!.source).toBe('repeated-tool-error');
    expect(signal!.severity).toBe('minor'); // approaching, not yet being aborted
  });

  it('is STRICT: exactly 80% is quiet, one ms above flags', () => {
    expect(toolLatencyBudgetSignalsFromRows([row('x:write', 48_000)], b)).toEqual([]);
    expect(toolLatencyBudgetSignalsFromRows([row('x:write', 48_001)], b)).toHaveLength(1);
  });

  it('escalates to major once p95 reaches the budget itself (the tail is being aborted now)', () => {
    const [signal] = toolLatencyBudgetSignalsFromRows([row('x:write', 60_000)], b);
    expect(signal!.severity).toBe('major');
  });

  it('does NOT flag a read-only tool even at 90% of budget', () => {
    const reads = budgets({ 'x:read': { timeoutSec: null, effect: 'read' } });
    expect(toolLatencyBudgetSignalsFromRows([row('x:read', 54_000)], reads)).toEqual([]);
  });
});

describe('budget resolution', () => {
  it('mirrors the dispatcher: null/absent/non-positive timeoutSec ⇒ the 60s default', () => {
    expect(TOOL_LATENCY_DEFAULT_BUDGET_SEC).toBe(60);
    expect(effectiveToolBudgetSec(undefined)).toBe(60);
    expect(effectiveToolBudgetSec({ timeoutSec: null })).toBe(60);
    expect(effectiveToolBudgetSec({ timeoutSec: 0 })).toBe(60);
    expect(effectiveToolBudgetSec({ timeoutSec: -5 })).toBe(60);
    expect(effectiveToolBudgetSec({ timeoutSec: Number.NaN })).toBe(60);
    expect(effectiveToolBudgetSec({ timeoutSec: 600 })).toBe(600);
  });

  it('judges a tool against ITS OWN declared budget, not the default', () => {
    // 100s p95 would be far over a 60s default, but it is 17% of a 600s declared budget.
    const long = budgets({ 'x:long': { timeoutSec: 600, effect: 'write' } });
    expect(toolLatencyBudgetSignalsFromRows([row('x:long', 100_000)], long)).toEqual([]);
    // …and a short declared budget tightens the line: 30s budget ⇒ 24s threshold.
    const short = budgets({ 'x:short': { timeoutSec: 30, effect: 'write' } });
    expect(toolLatencyBudgetSignalsFromRows([row('x:short', 25_000)], short)).toHaveLength(1);
    expect(toolLatencyBudgetSignalsFromRows([row('x:short', 23_000)], short)).toEqual([]);
  });

  it('names the budget source in the body (declared vs dispatcher default)', () => {
    const b = budgets({ 'x:declared': { timeoutSec: 30, effect: 'write' }, 'x:default': WRITE_60 });
    const signals = toolLatencyBudgetSignalsFromRows([row('x:declared', 29_000), row('x:default', 59_000)], b);
    const byKey = Object.fromEntries(signals.map((s) => [s.key, s.body]));
    expect(byKey['tool-latency-budget:x:declared']).toContain('declared timeoutSec');
    expect(byKey['tool-latency-budget:x:default']).toContain('dispatcher default');
  });
});

describe('what is never judged', () => {
  const b = budgets({ 'x:write': WRITE_60 });

  it('ignores a tool absent from the registry map (unknown budget ⇒ cannot judge)', () => {
    expect(toolLatencyBudgetSignalsFromRows([row('x:ghost', 59_000)], b)).toEqual([]);
  });

  it('ignores a write tool that already declares an abortCompletionReceipt — the hazard is closed', () => {
    const b = budgets({
      'x:receipted': { timeoutSec: null, effect: 'write', hasAbortCompletionReceipt: true },
      'x:bare': { timeoutSec: null, effect: 'write', hasAbortCompletionReceipt: false },
      'x:idempotent': { timeoutSec: null, effect: 'write', idempotent: true },
    });
    const keys = toolLatencyBudgetSignalsFromRows([
      row('x:receipted', 59_000),
      row('x:bare', 59_000),
      row('x:idempotent', 59_000),
    ], b).map((s) => s.key);
    expect(keys).toEqual(['tool-latency-budget:x:bare']);
  });

  it('does not flag plans:set-plan-status at the measured p95 because idempotent completion is safe', () => {
    const b = budgets({
      'plans:set-plan-status': { timeoutSec: 90, effect: 'write', idempotent: true },
    });
    expect(toolLatencyBudgetSignalsFromRows([row('plans:set-plan-status', 76_202, 78)], b)).toEqual([]);
  });

  it('ignores thin samples — a p95 of a handful of calls is just the max', () => {
    expect(TOOL_LATENCY_MIN_SAMPLES).toBe(20);
    expect(toolLatencyBudgetSignalsFromRows([row('x:write', 59_000, 19)], b)).toEqual([]);
    expect(toolLatencyBudgetSignalsFromRows([row('x:write', 59_000, 20)], b)).toHaveLength(1);
  });

  it('tolerates SQL-shaped values: numeric strings parse, null p95 and garbage are skipped', () => {
    expect(toolLatencyBudgetSignalsFromRows([row('x:write', '59000.4', '40')], b)).toHaveLength(1);
    expect(toolLatencyBudgetSignalsFromRows([row('x:write', null)], b)).toEqual([]);
    expect(toolLatencyBudgetSignalsFromRows([row('x:write', 'nope')], b)).toEqual([]);
  });

  it('honours ratio / minSamples overrides', () => {
    expect(TOOL_LATENCY_BUDGET_RATIO).toBe(0.8);
    expect(toolLatencyBudgetSignalsFromRows([row('x:write', 31_000)], b, { toolLatencyRatio: 0.5 })).toHaveLength(1);
    expect(toolLatencyBudgetSignalsFromRows([row('x:write', 59_000, 5)], b, { toolLatencyMinSamples: 5 })).toHaveLength(1);
  });
});

describe('signal shape (dedup + resolve-after-evidence contract)', () => {
  it('title is STABLE — no counts/percentages — so search-first dedup matches across ticks', () => {
    const b = budgets({ 'x:write': WRITE_60 });
    const [a] = toolLatencyBudgetSignalsFromRows([row('x:write', 49_000, 30)], b);
    const [c] = toolLatencyBudgetSignalsFromRows([row('x:write', 58_000, 400)], b);
    expect(a!.title).toBe(c!.title);
    expect(a!.title).not.toMatch(/\d/);
    expect(a!.body).not.toBe(c!.body);
  });

  it('carries the evidence span as ISO timestamps and files as a bug', () => {
    const b = budgets({ 'x:write': WRITE_60 });
    const [s] = toolLatencyBudgetSignalsFromRows([{ ...row('x:write', 50_000), latest_at: new Date('2026-10-02T23:00:00Z') }], b);
    expect(s!.latestAt).toBe('2026-10-02T23:00:00.000Z');
    expect(s!.earliestAt).toBe('2026-10-02T01:00:00.000Z');
    expect(s!.kind).toBe('bug');
  });

  it('orders output deterministically by key regardless of row order', () => {
    const b = budgets({ 'b:w': WRITE_60, 'a:w': WRITE_60 });
    const keys = toolLatencyBudgetSignalsFromRows([row('b:w', 55_000), row('a:w', 55_000)], b).map((s) => s.key);
    expect(keys).toEqual(['tool-latency-budget:a:w', 'tool-latency-budget:b:w']);
  });
});

describe('registry mapping', () => {
  it('keys by MCP name (what tool_invocations records), skips tools without one', () => {
    const map = toolLatencyBudgetsFromProjected([
      { expose: { mcp: { name: 'scorecards:emit' } }, timeoutSec: 90, effect: 'write' },
      { expose: { mcp: { name: 'plans:list' } }, effect: 'read' },
      { expose: { mcp: null }, timeoutSec: 5, effect: 'write' },
      { expose: null, effect: 'write' },
      { expose: { mcp: { name: '' } }, effect: 'write' },
    ]);
    expect([...map.keys()].sort()).toEqual(['plans:list', 'scorecards:emit']);
    expect(map.get('scorecards:emit')).toEqual({ timeoutSec: 90, effect: 'write', hasAbortCompletionReceipt: false });
    expect(map.get('plans:list')).toEqual({ timeoutSec: null, effect: 'read', hasAbortCompletionReceipt: false });
  });

  it('records whether a tool declares an abortCompletionReceipt (a function, not merely a truthy value)', () => {
    const map = toolLatencyBudgetsFromProjected([
      { expose: { mcp: { name: 'has:receipt' } }, effect: 'write', abortCompletionReceipt: () => ({ status: 'recorded' }) },
      { expose: { mcp: { name: 'no:receipt' } }, effect: 'write' },
      { expose: { mcp: { name: 'bogus:receipt' } }, effect: 'write', abortCompletionReceipt: true },
    ]);
    expect(map.get('has:receipt')!.hasAbortCompletionReceipt).toBe(true);
    expect(map.get('no:receipt')!.hasAbortCompletionReceipt).toBe(false);
    expect(map.get('bogus:receipt')!.hasAbortCompletionReceipt).toBe(false);
  });

  it('records idempotent completion so the watchdog matches the dispatch late-return contract', () => {
    const map = toolLatencyBudgetsFromProjected([
      { expose: { mcp: { name: 'plans:set-plan-status' } }, timeoutSec: 90, effect: 'write', idempotent: true },
      { expose: { mcp: { name: 'x:unsafe' } }, timeoutSec: 90, effect: 'write', idempotent: false },
    ]);
    expect(map.get('plans:set-plan-status')).toEqual({
      timeoutSec: 90,
      effect: 'write',
      idempotent: true,
      hasAbortCompletionReceipt: false,
    });
    expect(map.get('x:unsafe')!.idempotent).toBeUndefined();
  });

  it('writeToolNames returns only writes without safe late-completion recovery, sorted', () => {
    const map = toolLatencyBudgetsFromProjected([
      { expose: { mcp: { name: 'z:write' } }, effect: 'write' },
      { expose: { mcp: { name: 'a:write' } }, effect: 'write' },
      { expose: { mcp: { name: 'r:receipted' } }, effect: 'write', abortCompletionReceipt: () => ({}) },
      { expose: { mcp: { name: 'i:idempotent' } }, effect: 'write', idempotent: true },
      { expose: { mcp: { name: 'm:read' } }, effect: 'read' },
      { expose: { mcp: { name: 'u:unset' } } },
    ]);
    expect(writeToolNames(map)).toEqual(['a:write', 'z:write']);
  });
});
