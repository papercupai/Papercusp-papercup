import { describe, expect, it } from 'vitest';
import { evaluateSignal, evaluateLiveness, livenessWindowStart, sustainedRecovery,
  LIVENESS_WINDOW_MS as WEEK, type SignalMeasurement, type ScheduledSignalRun } from './liveness';

const end = Date.parse('2026-10-26T00:00:00Z');
const base: SignalMeasurement = {
  signal: 'interface', kind: 'push', enabled: true, windowStart: end - WEEK, windowEnd: end,
  eligible: 100, outputs: 5, eligibleLineages: 3, outsideLineageOutputs: 1,
  eligibleMutations: 100, allTrackedMutations: 200,
};
describe('P-003 independent liveness decisions', () => {
  it('alarms on independent eligible traffic with zero delivery and reports both counts', () => {
    expect(evaluateSignal({ ...base, outputs: 0 })).toMatchObject({
      status: 'alarm', eligible: 100, outputs: 0, ratio: 0, mutationShare: 0.5,
    });
  });
  it('alarms below 5 percent even with nonzero output, accepting exactly the floor', () => {
    expect(evaluateSignal({ ...base, outputs: 4 }).status).toBe('alarm');
    expect(evaluateSignal(base).status).toBe('healthy');
  });
  it('separates no traffic, OFF, and unmeasurable data', () => {
    expect(evaluateSignal({ ...base, eligible: 0, outputs: 0 }).status).toBe('insufficient-data');
    expect(evaluateSignal({ ...base, enabled: false, outputs: 0 }).status).toBe('off');
    for (const bad of [{ eligible: null }, { outputs: null }, { eligible: -1 }, { outputs: NaN }])
      expect(evaluateSignal({ ...base, ...bad }).status).toBe('cannot-observe');
  });
  it('requires outside-lineage output for health without hiding zero-output alarms', () => {
    expect(evaluateSignal({ ...base, outsideLineageOutputs: 0 }).status).toBe('insufficient-data');
    expect(evaluateSignal({ ...base, outsideLineageOutputs: null }).status).toBe('cannot-observe');
    expect(evaluateSignal({ ...base, outputs: 0, outsideLineageOutputs: null }).status).toBe('alarm');
  });
  it('uses calls and measured results for graph, lsp and pack without a push-ratio floor', () => {
    for (const signal of ['graph:query', 'lsp:query', 'code:pack']) {
      const op = { ...base, signal, kind: 'op' as const };
      expect(evaluateSignal({ ...op, outputs: 0 }).status).toBe('alarm');
      expect(evaluateSignal({ ...op, outputs: 1 }).status).toBe('healthy');
      expect(evaluateSignal({ ...op, eligible: 0, outputs: 0 }).status).toBe('insufficient-data');
      expect(evaluateSignal({ ...op, outputs: null }).status).toBe('cannot-observe');
    }
  });
  it('keeps clone separate from first-touch despite the shared flag', () => {
    expect(evaluateLiveness([{ ...base, signal: 'first-touch' }, { ...base, signal: 'clone', outputs: 0 }])
      .map(v => [v.signal, v.status])).toEqual([['first-touch', 'healthy'], ['clone', 'alarm']]);
    expect(() => evaluateLiveness([base, base])).toThrow('Duplicate liveness signal');
  });
  it('raises a population alarm for a full silent week but never invents eligibility', () => {
    const silent = { ...base, eligible: 0, outputs: 0 };
    expect(evaluateLiveness([silent, { ...base, signal: 'grep', enabled: false }]).at(-1))
      .toMatchObject({ signal: 'push-population', status: 'alarm', eligible: 0 });
    expect(evaluateLiveness([{ ...silent, windowStart: end - 1000 }])).toHaveLength(1);
    expect(evaluateLiveness([silent, { ...base, signal: 'grep', eligible: null }])).toHaveLength(2);
    expect(evaluateLiveness([{ ...silent, enabled: false }])).toHaveLength(1);
  });
  it('bounds both ledgers by flag-on time and rejects invalid windows', () => {
    expect(livenessWindowStart(end, end - WEEK * 2)).toBe(end - WEEK);
    expect(livenessWindowStart(end, end - 1000)).toBe(end - 1000);
    expect(() => livenessWindowStart(end, end + 1)).toThrow();
    expect(evaluateSignal({ ...base, windowStart: end }).status).toBe('cannot-observe');
  });
  it('discloses mutation coverage without changing the delivery floor', () => {
    expect(evaluateSignal({ ...base, allTrackedMutations: 10000 }))
      .toMatchObject({ status: 'healthy', mutationShare: 0.01 });
    expect(evaluateSignal({ ...base, allTrackedMutations: null }).mutationShare).toBeNull();
  });
  it('requires 500 symbol edits from 3 lineages and an 80 percent capture share', () => {
    const m = { ...base, signal: 'edit-symbols', kind: 'symbol-capture' as const, eligible: 500, outputs: 400 };
    expect(evaluateSignal(m).status).toBe('healthy');
    expect(evaluateSignal({ ...m, outputs: 399 }).status).toBe('alarm');
    expect(evaluateSignal({ ...m, eligible: 499 }).status).toBe('insufficient-data');
    expect(evaluateSignal({ ...m, eligibleLineages: 2 }).status).toBe('insufficient-data');
    expect(evaluateSignal({ ...m, eligibleLineages: null }).status).toBe('cannot-observe');
    expect(evaluateSignal({ ...m, outputs: 501 }).status).toBe('cannot-observe');
  });
});
describe('P-003 sustained scheduled recovery', () => {
  const fixedAt = end - WEEK;
  const run = (sequence: number, scheduledAt: number): ScheduledSignalRun => ({
    sequence, scheduledAt, succeeded: true,
    verdict: evaluateSignal({ ...base, windowStart: fixedAt, windowEnd: scheduledAt }),
  });
  const first = run(0, fixedAt + 86_400_000), second = run(1, fixedAt + 3 * 86_400_000);
  it('requires consecutive successful scheduled observations at least 48 hours apart', () => {
    expect(sustainedRecovery([first, second], fixedAt)).toBe(true);
    expect(sustainedRecovery([first], fixedAt)).toBe(false);
    expect(sustainedRecovery([first, { ...second, sequence: 2 }], fixedAt)).toBe(false);
    expect(sustainedRecovery([first, { ...second, succeeded: false }], fixedAt)).toBe(false);
    expect(sustainedRecovery([first, run(1, fixedAt + 2 * 86_400_000)], fixedAt)).toBe(false);
  });
  it('rejects pre-fix traffic, absent eligibility, below-floor and cross-signal recovery', () => {
    for (const verdict of [
      { ...second.verdict, windowStart: fixedAt - 1 }, { ...second.verdict, eligible: 0 },
      { ...second.verdict, ratio: 0.04 }, { ...second.verdict, signal: 'clone' },
    ]) expect(sustainedRecovery([first, { ...second, verdict }], fixedAt)).toBe(false);
  });
});
