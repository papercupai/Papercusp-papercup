import { describe, expect, it } from 'vitest';
import { RESOLVER_READ_TIMEOUT_MS } from '../../packages/operator-core/lib/sync-resolver/read-deadline';
import {
  R19_ASSERTIONS,
  R19_BAR_DEADLINE_MS,
  R19_MIN_RUNS,
  expectedDbFromDsn,
  judgeR19,
  type R19Run,
} from './dependency-graph-wait-latency-live-oracle.mjs';

// AUTO-BAR-R-19-P-009@3 (event-wait-settlement-2026-10-20): the oracle behind the live dependency-graph timing
// receipt (docs/evidence/ews-p009-r19-latency-live/run.mjs), and the pin that keeps the bar's "10 s deadline"
// equal to the sync layer's per-query resolver timeout.

const run = (over: Partial<R19Run> = {}): R19Run => ({
  edgesMs: 184.4,
  edgesPlusWaitsMs: 434.3,
  waitsAloneMs: 309.1,
  edges: 2665,
  waits: 1451,
  ...over,
});
const measurement = (over: Record<string, unknown> = {}) => ({
  db: 'papercusp@5432',
  expectedDb: 'papercusp@5432',
  deadlineMs: R19_BAR_DEADLINE_MS,
  runs: Array.from({ length: R19_MIN_RUNS }, () => run()),
  ...over,
});
const withRun = (i: number, over: Partial<R19Run>) =>
  measurement({ runs: Array.from({ length: R19_MIN_RUNS }, (_, j) => (j === i ? run(over) : run())) });

describe('AUTO-BAR-R-19-P-009 live latency oracle', () => {
  it('R-19: passes a live measurement whose every run is inside the deadline, and reports the before/after maxima', () => {
    const v = judgeR19(withRun(2, { edgesMs: 224.2, edgesPlusWaitsMs: 1061.8, waitsAloneMs: 335.8 }));
    expect(v).toEqual({
      ok: true,
      failedIds: [],
      maxEdgesMs: 224.2,
      maxEdgesPlusWaitsMs: 1061.8,
      maxWaitsAloneMs: 335.8,
    });
  });

  it('R-19: fails within-deadline when one run reaches the deadline, on any of the three timings', () => {
    for (const k of ['edgesMs', 'edgesPlusWaitsMs', 'waitsAloneMs'] as const) {
      expect(judgeR19(withRun(4, { [k]: R19_BAR_DEADLINE_MS })).failedIds).toEqual(['within-deadline']);
    }
    expect(judgeR19(measurement({ deadlineMs: 0 })).failedIds).toEqual(['within-deadline']);
    expect(judgeR19(measurement({ deadlineMs: undefined })).failedIds).toEqual(['within-deadline']);
  });

  it('R-19: fails operator-db when the probe read a different database than the operator one', () => {
    expect(judgeR19(measurement({ db: 'papercusp@18058' })).failedIds).toEqual(['operator-db']);
    expect(judgeR19(measurement({ expectedDb: '' })).failedIds).toEqual(['operator-db']);
  });

  it('R-19: fails min-runs below the minimum run count', () => {
    const runs = Array.from({ length: R19_MIN_RUNS - 1 }, () => run());
    expect(judgeR19(measurement({ runs })).failedIds).toEqual(['min-runs']);
  });

  it('R-19: fails graph-non-empty when a run read an empty graph', () => {
    expect(judgeR19(withRun(0, { edges: 0 })).failedIds).toEqual(['graph-non-empty']);
  });

  it('R-19: fails wait-leg-ran when the wait leg was not timed or returned nothing', () => {
    expect(judgeR19(withRun(1, { waitsAloneMs: undefined })).failedIds).toEqual(['wait-leg-ran']);
    expect(judgeR19(withRun(1, { edgesPlusWaitsMs: undefined })).failedIds).toEqual(['wait-leg-ran']);
    expect(judgeR19(withRun(1, { waits: 0 })).failedIds).toEqual(['wait-leg-ran']);
  });

  it('R-19: fails before-recorded when depEdges alone was not timed', () => {
    expect(judgeR19(withRun(3, { edgesMs: undefined })).failedIds).toEqual(['before-recorded']);
  });

  it('R-19: a missing timing does not hide an over-deadline one beside it', () => {
    expect(judgeR19(withRun(3, { edgesMs: undefined, waitsAloneMs: R19_BAR_DEADLINE_MS + 1 })).failedIds).toEqual([
      'before-recorded',
      'within-deadline',
    ]);
  });

  it('R-19: fails every assertion on an empty measurement, in declared order', () => {
    expect(judgeR19({ db: null, expectedDb: null, deadlineMs: null, runs: [] }).failedIds).toEqual([...R19_ASSERTIONS]);
  });

  it('R-19: derives the expected database from the operator connection string', () => {
    expect(expectedDbFromDsn('postgresql://u:p@localhost:5432/papercusp')).toBe('papercusp@5432');
    expect(expectedDbFromDsn('postgresql://u:p@localhost/papercusp')).toBe('papercusp@5432');
    expect(() => expectedDbFromDsn('postgresql://u:p@localhost:5432/')).toThrow();
  });

  it("R-19: pins the bar's 10 s deadline to the sync layer's resolver timeout", () => {
    expect(R19_BAR_DEADLINE_MS).toBe(RESOLVER_READ_TIMEOUT_MS);
  });
});
