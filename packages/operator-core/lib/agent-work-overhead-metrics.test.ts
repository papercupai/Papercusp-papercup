import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  classifyAcceptanceTime, measureWorkOverheadWindow, rateWorkOverhead, summarizeWorkOverhead,
  WORK_OVERHEAD_MAX_ROWS, WORK_OVERHEAD_SQL, type WorkOverheadEvent, type WorkOverheadWindow,
} from './agent-work-overhead-metrics';

const window: WorkOverheadWindow = { workspaceId: 'ws', harnessSlug: 'papercusp',
  windowStart: '2026-10-15T10:00:00Z', windowEnd: '2026-10-15T14:00:00Z' };
const stamp = (seconds: number) => new Date(Date.parse(window.windowStart) + seconds * 1000).toISOString();
const event = (over: Partial<WorkOverheadEvent> = {}): WorkOverheadEvent => ({
  source_kind: 'codex', session_id: 'native-one', owner: 'stable-owner', part_idx: 0,
  ts: stamp(0), tool_name: 'capability:read', payload: '{}', payload_truncated: false,
  first_at: stamp(0), last_at: stamp(100), missing_timestamps: 0, closed: true, ...over,
});
const session = (id: string, minutes: number, closed = true, source = 'codex') => [event({
  session_id: id, last_at: stamp(minutes * 60), closed, source_kind: source,
})];

describe('acceptance-time attribution in native transcript parts', () => {
  it.each([
    ['rubrics:get', '{}', 'acceptance'], ['scorecards:evaluate', '{}', 'acceptance'],
    ['plans:audit', '{}', 'acceptance'], ['work_items:complete', '{}', 'acceptance'],
    ['mcp__papercusp_su__plans_bind_spec_evidence', '{}', 'acceptance'],
    ['tools:invoke', '{"name":"plans:audit"}', 'acceptance'],
    ['code:run', 'await tools.plans.audit({slug:"a"})', 'acceptance'],
    ['functions.exec', 'await tools.mcp__papercusp_su__scorecards_emit({})', 'acceptance'],
    ['capability:bash', 'ptool plans:bind-spec-evidence --json -', 'acceptance'],
    ['functions.exec', 'await tools.exec_command({cmd:"npm run test:file"})', 'other'],
    ['functions.exec', 'await tools.apply_patch("patch")', 'other'],
    ['functions.exec', 'await tools.plans.audit({}); await tools.testing.run({})', 'unknown'],
    ['functions.exec', 'await tools.write_stdin({session_id:1})', 'unknown'],
    ['functions.exec', 'await tools.testing.run({}); await tools.write_stdin({session_id:1})', 'unknown'],
    ['functions.wait', '{"cell_id":"one"}', 'unknown'],
    ['functions.exec', 'opaque()', 'unknown'],
    ['capability:read', '{"path":"acceptance-gate.ts"}', 'other'],
  ])('%s / %s => %s', (tool, payload, expected) => {
    expect(classifyAcceptanceTime(tool, payload)).toBe(expected);
  });
  it('does not infer an operation from absent identity or a truncated wrapper', () => {
    expect(classifyAcceptanceTime(null)).toBe('unknown');
    expect(classifyAcceptanceTime('code:run', 'tools.plans.audit({})', true)).toBe('unknown');
  });
});

describe('repeatable overhead and native-session outcomes', () => {
  it('strictly requires share below 10%, including the unknown upper bound', () => {
    const measure = (seconds: number) => summarizeWorkOverhead(window, [
      event({ tool_name: 'plans:audit' }), event({ part_idx: 1, ts: stamp(seconds) }),
    ]);
    expect(rateWorkOverhead(measure(9)).acceptanceShare.verdict).toBe('pass');
    expect(rateWorkOverhead(measure(10)).acceptanceShare.verdict).toBe('fail');
    const ambiguous = summarizeWorkOverhead(window, [
      event({ tool_name: 'plans:audit' }),
      event({ part_idx: 1, ts: stamp(9), tool_name: 'functions.exec', payload: 'opaque()' }),
      event({ part_idx: 2, ts: stamp(10) }),
    ]);
    expect(ambiguous.time).toMatchObject({ activeMs: 100_000, acceptanceMs: 9000, unknownMs: 1000 });
    expect(rateWorkOverhead(ambiguous).acceptanceShare.verdict).toBe('unknown');
  });
  it('counts pre-first-call work as unknown and excludes long idle gaps explicitly', () => {
    const boot = summarizeWorkOverhead(window, [event({ ts: stamp(10) })]);
    expect(boot.time.unknownMs).toBe(10_000);
    expect(rateWorkOverhead(boot).acceptanceShare.verdict).toBe('unknown');
    const idle = summarizeWorkOverhead(window, [
      event({ tool_name: 'plans:audit', last_at: stamp(610) }),
      event({ part_idx: 1, ts: stamp(600), last_at: stamp(610) }),
    ]);
    expect(idle.time).toMatchObject({ excludedIdleMs: 600_000, activeMs: 10_000, acceptanceMs: 0 });
  });
  it('keeps native contexts separate across a stable owner and preserves client mix', () => {
    const metrics = summarizeWorkOverhead(window, [...session('native-a', 40), ...session('native-b', 50, true, 'claude')]);
    expect(metrics.population).toMatchObject({ sessions: 2, clients: { codex: 1, claude: 1 } });
    expect(metrics.medianObservedSessionMinutes).toBe(45);
    expect(rateWorkOverhead(metrics).sessionMinutes.verdict).toBe('fail');
  });
  it('uses a strict >45min bound and never drops or fails short ongoing contexts', () => {
    expect(rateWorkOverhead(summarizeWorkOverhead(window, session('long', 45.01, false))).sessionMinutes.verdict).toBe('pass');
    expect(rateWorkOverhead(summarizeWorkOverhead(window, session('open', 45, false))).sessionMinutes.verdict).toBe('unknown');
    const mixed = summarizeWorkOverhead(window, [...session('open', 10, false), ...session('ended', 50)]);
    expect(mixed.medianObservedSessionMinutes).toBe(30);
    expect(rateWorkOverhead(mixed).sessionMinutes.verdict).toBe('unknown');
  });
  it('does not turn boundary, empty, malformed, missing or truncated populations into passes', () => {
    const boundary = summarizeWorkOverhead(window, [event({ first_at: stamp(-1) })]);
    expect(boundary.population).toMatchObject({ sessions: 0, boundarySessions: 1 });
    for (const metrics of [boundary, summarizeWorkOverhead(window, []),
      summarizeWorkOverhead(window, [event({ ts: 'invalid' })]),
      summarizeWorkOverhead(window, [event({ missing_timestamps: 1 })]),
      summarizeWorkOverhead(window, Array(WORK_OVERHEAD_MAX_ROWS + 1).fill(event())),
      summarizeWorkOverhead({ ...window, workspaceId: 'default' }, [event()]),
      summarizeWorkOverhead({ ...window, windowEnd: window.windowStart }, [event()])]) {
      expect(rateWorkOverhead(metrics)).toMatchObject({ acceptanceShare: { verdict: 'unknown' }, sessionMinutes: { verdict: 'unknown' } });
    }
  });
  it('executes the recorded, bound-scope query without using interpolated SQL or launcher duration', async () => {
    const unsafe = vi.fn(async () => [event()]);
    await measureWorkOverheadWindow(window, { unsafe } as unknown as Sql);
    expect(unsafe).toHaveBeenCalledWith(WORK_OVERHEAD_SQL,
      ['ws', 'papercusp', window.windowStart, window.windowEnd, WORK_OVERHEAD_MAX_ROWS + 1]);
    expect(WORK_OVERHEAD_SQL).toContain("p.workspace_id IN ('default', $1)");
    expect(WORK_OVERHEAD_SQL).toContain('s.workspace_id = $1 AND h.harness_slug = $2');
    expect(WORK_OVERHEAD_SQL).toContain('h.plan_slug = s.plan_slug');
    expect(WORK_OVERHEAD_SQL).toContain('p.ts >= m.started_at');
    expect(WORK_OVERHEAD_SQL).toContain('p.session_id = c.session_id');
    expect(WORK_OVERHEAD_SQL).not.toContain('ended_at - started_at');
  });
});
