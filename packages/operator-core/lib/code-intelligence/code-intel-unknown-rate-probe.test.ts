import { describe, expect, it, vi } from 'vitest';
import { decideUnknownRateAlarm } from './code-intel-result-status.ts';
import {
  CODE_INTEL_CANARY_OWNER,
  aboveThresholdFixtureRows,
  decideUnknownRateProbe,
  reconcileCodeIntelWindow,
  runCodeIntelUnknownRateProbe,
  unknownRateConditionKey,
  type ProbeInvocationRow,
  type UnknownRateProbeDeps,
} from './code-intel-unknown-rate-probe.ts';
import { CANARY_UNFORCED, type CanaryJudgement } from './code-intel-canary.ts';

const BUILD = 'abc1234567';
const OWNERS = ['su-a', 'su-b', 'su-c'];

/** `total` calls from 3 owners on the running build, the first `unknown` of them unknown/timeout. */
function window(total: number, unknown: number, extra: Partial<ProbeInvocationRow> = {}): ProbeInvocationRow[] {
  return Array.from({ length: total }, (_, i) => ({
    rowId: `r${i}`,
    toolName: ['graph:query', 'lsp:query', 'code:pack'][i % 3]!,
    ownerId: OWNERS[i % 3]!,
    servingBuildSha: BUILD,
    status: i < unknown ? { status: 'unknown', reason: 'timeout', invocationId: `c${i}` } : { status: 'measured', invocationId: `c${i}` },
    ...extra,
  }));
}

function decide(rows: ProbeInvocationRow[]) {
  const recon = reconcileCodeIntelWindow(rows, { runningBuildSha: BUILD });
  return { recon, decision: decideUnknownRateProbe(recon) };
}

describe('unknown-rate probe decision (P-004, R-9)', () => {
  it('49 calls never alarm, even when every one is unknown', () => {
    const { decision } = decide(window(49, 49));
    expect(decision.alarm).toBe(false);
    expect(decision.rate.reason).toBe('insufficient-calls');
    expect(decision.gradable).toBe(false);
  });

  it('50 calls with 11 unknown (22%) alarm above-threshold', () => {
    const { decision } = decide(window(50, 11));
    expect(decision.alarm).toBe(true);
    expect(decision.reasons).toEqual(['above-threshold']);
    expect(decision.gradable).toBe(true);
  });

  it('exactly 20% (10 of 50) does not alarm and counts as a recovered window', () => {
    const { decision } = decide(window(50, 10));
    expect(decision.alarm).toBe(false);
    expect(decision.rate.reason).toBe('within-threshold');
    expect(decision.recovered).toBe(true);
  });

  it('a missing denominator is a malformed window, never an alarm or a clean window', () => {
    expect(decideUnknownRateAlarm({ total: undefined, unknown: 3 })).toMatchObject({ alarm: false, reason: 'malformed-window' });
    expect(decideUnknownRateAlarm({ total: null, unknown: null })).toMatchObject({ alarm: false, reason: 'malformed-window' });
  });

  it('a retried call (new call id) counts as a second call', () => {
    const rows = window(50, 10);
    rows.push({ rowId: 'retry', toolName: 'graph:query', ownerId: 'su-a', servingBuildSha: BUILD,
      status: { status: 'unknown', reason: 'timeout', invocationId: 'c0-retry' } });
    const { recon, decision } = decide(rows);
    expect(recon.total).toBe(51);
    expect(recon.unknown).toBe(11);
    expect(decision.reasons).toEqual(['above-threshold']);
  });

  it('a duplicate status for one call id is a reconciliation gap, counted once in the share', () => {
    const rows = window(50, 0);
    rows.push({ ...rows[0]!, rowId: 'dup' });
    const { recon, decision } = decide(rows);
    expect(recon.total).toBe(50);
    expect(recon.gaps).toEqual([{ invocation: 'call:graph:query:c0', toolName: 'graph:query', statusRows: 2 }]);
    expect(decision.reasons).toEqual(['reconciliation-gap']);
    expect(decision.recovered).toBe(false);
  });

  it('an invocation on the running build with no status row alarms, per tool', () => {
    const rows = window(50, 0);
    rows.push({ rowId: 'nostatus', toolName: 'lsp:query', ownerId: 'su-b', servingBuildSha: BUILD, status: null });
    const { recon, decision } = decide(rows);
    expect(recon.gaps).toEqual([{ invocation: 'row:nostatus', toolName: 'lsp:query', statusRows: 0 }]);
    expect(recon.byTool['lsp:query']!.gaps).toBe(1);
    expect(decision.alarm).toBe(true);
  });

  it('an unparseable status (reason outside the fixed set) is a missing status row', () => {
    const rows = window(50, 0);
    rows.push({ rowId: 'bad', toolName: 'code:pack', ownerId: 'su-c', servingBuildSha: BUILD, status: { status: 'unknown', reason: 'vibes' } });
    expect(decide(rows).recon.gaps).toHaveLength(1);
  });

  it('rows from another build are not reconciliation gaps and stay out of the share when they carry no status', () => {
    const rows = window(50, 0);
    rows.push({ rowId: 'old', toolName: 'graph:query', ownerId: 'su-a', servingBuildSha: 'older00000', status: null });
    const { recon, decision } = decide(rows);
    expect(recon.gaps).toEqual([]);
    expect(recon.total).toBe(50);
    expect(decision.alarm).toBe(false);
  });

  it('canary calls are excluded from both numerator and denominator but still reconciled', () => {
    const rows = window(50, 10);
    for (let i = 0; i < 30; i += 1) {
      rows.push({ rowId: `can${i}`, toolName: 'graph:query', ownerId: CODE_INTEL_CANARY_OWNER, servingBuildSha: BUILD,
        status: { status: 'unknown', reason: 'scope-refused', invocationId: `can${i}` } });
    }
    rows.push({ rowId: 'can-missing', toolName: 'lsp:query', ownerId: CODE_INTEL_CANARY_OWNER, servingBuildSha: BUILD, status: null });
    const { recon, decision } = decide(rows);
    expect(recon.total).toBe(50);
    expect(recon.unknown).toBe(10);
    expect(recon.canaryCalls).toBe(31);
    expect(recon.owners).toBe(3);
    expect(decision.reasons).toEqual(['reconciliation-gap']);
  });

  it('fewer than 3 owners keeps the live half ungradable even at 50 calls', () => {
    const rows = window(50, 0).map(r => ({ ...r, ownerId: 'su-a' }));
    expect(decide(rows).decision.gradable).toBe(false);
  });

  it('the injected fixture window alarms above-threshold with no gaps, its canary excluded', () => {
    const { recon, decision } = decide(aboveThresholdFixtureRows(BUILD));
    expect(recon).toMatchObject({ total: 50, unknown: 11, owners: 3, canaryCalls: 1, gaps: [] });
    expect(recon.unknownByReason.timeout).toBeGreaterThan(0);
    expect(recon.unknownByReason['scope-refused']).toBeGreaterThan(0);
    expect(decision.reasons).toEqual(['above-threshold']);
  });
});

function deps(rows: ProbeInvocationRow[], over: Partial<UnknownRateProbeDeps> = {}) {
  const d = {
    readRows: vi.fn(async () => rows),
    raise: vi.fn(async () => true),
    resolve: vi.fn(async () => true),
    raiseFixture: vi.fn(async () => true),
    record: vi.fn(async () => undefined),
    runningBuildSha: BUILD,
    now: () => Date.parse('2026-10-27T06:00:00Z'),
    ...over,
  };
  return d;
}
const SCOPE = { workspaceId: 'ws', windowStart: '2026-10-26T06:00:00Z', windowEnd: '2026-10-27T06:00:00Z' };

describe('runCodeIntelUnknownRateProbe (P-004, R-9)', () => {
  it('an above-threshold live window raises the live alarm and passes when delivered', async () => {
    const d = deps(window(50, 11));
    const r = await runCodeIntelUnknownRateProbe(SCOPE, d);
    expect(d.raise).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.raise).mock.calls[0]![0].conditionKey).toBe(unknownRateConditionKey('ws'));
    expect(d.resolve).not.toHaveBeenCalled();
    expect(r.verdict).toBe('pass');
    expect(r.value).toBeCloseTo(22);
  });

  it('a recovered live window clears the alarm; an ungradable one leaves it alone', async () => {
    const healthy = deps(window(50, 10));
    await runCodeIntelUnknownRateProbe(SCOPE, healthy);
    expect(healthy.resolve).toHaveBeenCalledWith(unknownRateConditionKey('ws'));
    expect(healthy.raise).not.toHaveBeenCalled();

    const sparse = deps(window(7, 0));
    const r = await runCodeIntelUnknownRateProbe(SCOPE, sparse);
    expect(sparse.resolve).not.toHaveBeenCalled();
    expect(r.verdict).toBe('unknown');
  });

  it('every run replays the injected window through the fixture recorder, never the live broadcast', async () => {
    const d = deps(window(50, 0));
    await runCodeIntelUnknownRateProbe(SCOPE, d);
    expect(d.raiseFixture).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.raiseFixture).mock.calls[0]![0].conditionKey).toBe(unknownRateConditionKey('ws', true));
    expect(d.raise).not.toHaveBeenCalled();
  });

  it('fails when the injected window does not produce an alarm, or the live alarm is not delivered', async () => {
    expect((await runCodeIntelUnknownRateProbe(SCOPE, deps(window(50, 0), { raiseFixture: vi.fn(async () => false) }))).verdict).toBe('fail');
    expect((await runCodeIntelUnknownRateProbe(SCOPE, deps(window(50, 11), { raise: vi.fn(async () => false) }))).verdict).toBe('fail');
  });

  it('records one observation per run carrying the running build sha and both halves', async () => {
    const d = deps(window(50, 11));
    await runCodeIntelUnknownRateProbe(SCOPE, d);
    expect(d.record).toHaveBeenCalledTimes(1);
    const obs = vi.mocked(d.record).mock.calls[0]![0];
    expect(obs).toMatchObject({ workspaceId: 'ws', buildSha: BUILD, windowStart: SCOPE.windowStart, windowEnd: SCOPE.windowEnd,
      observedAt: '2026-10-27T06:00:00.000Z' });
    expect(obs.live.alarmRaised).toBe(true);
    expect(obs.fixture.alarmRaised).toBe(true);
  });

  it('without a running build identity the verdict is unknown, not pass', async () => {
    const r = await runCodeIntelUnknownRateProbe(SCOPE, deps(window(50, 0), { runningBuildSha: null }));
    expect(r.verdict).toBe('unknown');
  });
});

describe('runCodeIntelUnknownRateProbe canary half (P-004, R-9)', () => {
  const passing = (): CanaryJudgement => ({ ok: true, cases: [], failed: 0, unforced: CANARY_UNFORCED });
  const failing: CanaryJudgement = {
    ok: false, failed: 1, unforced: CANARY_UNFORCED,
    cases: [{ toolName: 'graph:query', forced: 'timeout', callId: 'c1', statusRows: 1, recorded: { status: 'measured', invocationId: 'c1' }, ok: false, why: 'expected unknown/timeout, recorded measured' }],
  };

  it('runs the canary before reading the live window and records it on the observation', async () => {
    const order: string[] = [];
    const d = deps(window(50, 0), {
      runCanary: vi.fn(async () => { order.push('canary'); return passing(); }),
      readRows: vi.fn(async () => { order.push('read'); return window(50, 0); }),
    });
    const r = await runCodeIntelUnknownRateProbe(SCOPE, d);
    expect(order).toEqual(['canary', 'read']);
    expect(r.verdict).toBe('pass');
    expect(vi.mocked(d.record).mock.calls[0]![0]).toMatchObject({ canary: { ok: true }, canaryError: null });
  });

  it('a canary forced exit not recorded as forced fails the run, naming the case', async () => {
    const r = await runCodeIntelUnknownRateProbe(SCOPE, deps(window(50, 0), { runCanary: async () => failing }));
    expect(r.verdict).toBe('fail');
    expect(r.detail).toContain('graph:query/timeout: expected unknown/timeout, recorded measured');
  });

  it('a canary that throws fails the run and is recorded', async () => {
    const d = deps(window(50, 0), { runCanary: async () => { throw new Error('dispatcher unavailable'); } });
    const r = await runCodeIntelUnknownRateProbe(SCOPE, d);
    expect(r.verdict).toBe('fail');
    expect(r.detail).toContain('dispatcher unavailable');
    expect(vi.mocked(d.record).mock.calls[0]![0]).toMatchObject({ canary: null, canaryError: 'dispatcher unavailable' });
  });

  it('with no canary dep the observation says so and the verdict is unchanged', async () => {
    const d = deps(window(50, 0));
    const r = await runCodeIntelUnknownRateProbe(SCOPE, d);
    expect(r.verdict).toBe('pass');
    expect(vi.mocked(d.record).mock.calls[0]![0]).toMatchObject({ canary: null, canaryError: null });
  });
});
