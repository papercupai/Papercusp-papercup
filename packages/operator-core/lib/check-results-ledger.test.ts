/**
 * Unit tests for the probe-check UNIT on results-ledger rows (test-rubric-unification-2026-10-12
 * P-010, AUTO-BAR-R-10). A rubric probe check may declare the unit of the scalar its probes read;
 * every ledger row the check writes carries it, so the ledger value can be compared with a
 * baseline. Before this, probe rows were always written with unit null, which left a
 * baseline-vs-ledger comparison without a unit for every SQL-probe criterion.
 */
import { describe, expect, it } from 'vitest';
import { probeCheckResults, probeCheckUnit, runInstrumentChecks } from './check-results-ledger';

const AT = '2026-10-13T04:00:00.000Z';
const adoption = { key: 'r-31', check: { kind: 'instrument', instrumentKey: 'code-intel:native-adoption-good-use' } };

describe('scheduled platform instrument results', () => {
  it('runs work-overhead checks in the canonical rubric harness and completed daily window', async () => {
    const criterion = { key: 'R-15', check: { kind: 'instrument', instrumentKey: 'agents:acceptance-machinery-share' } };
    const windows: unknown[] = [];
    const resolvePlatform = async (window: unknown) => {
      windows.push(window); return { verdict: 'fail' as const, detail: 'share above target' };
    };
    const [missingScope] = await runInstrumentChecks({ rubricRef: 'paperwork', criteria: [criterion],
      workspaceId: 'ws', now: () => Date.parse(AT), resolvePlatform });
    expect(missingScope).toMatchObject({ verdict: 'error', check: { value: null } });
    expect(windows).toEqual([]);
    const [result] = await runInstrumentChecks({ rubricRef: 'paperwork', criteria: [criterion],
      workspaceId: 'ws', harnessSlug: 'papercusp', now: () => Date.parse(AT), resolvePlatform });
    expect(windows).toEqual([{ workspaceId: 'ws', harnessSlug: 'papercusp',
      windowStart: '2026-10-12T04:00:00.000Z', windowEnd: AT }]);
    expect(result).toMatchObject({ verdict: 'fail', measuredAt: AT, check: { id: 'R-15:instrument', value: 0 } });
  });

  it('measures the exact completed trailing window in the rubric workspace and records failure', async () => {
    const windows: unknown[] = [];
    const [result] = await runInstrumentChecks({ rubricRef: 'native', criteria: [adoption],
      workspaceId: 'ws-native', now: () => Date.parse(AT),
      resolvePlatform: async window => { windows.push(window); return { verdict: 'fail', detail: 'below frozen target' }; },
    });
    expect(windows).toEqual([{ workspaceId: 'ws-native', windowStart: '2026-10-10T04:00:00.000Z', windowEnd: AT }]);
    expect(result).toMatchObject({ verdict: 'fail', measuredAt: AT, detail: 'below frozen target',
      check: { id: 'r-31:instrument', value: 0, unit: 'count' } });
  });

  it('records no population and resolver errors as unmeasured, and never queries without workspace scope', async () => {
    for (const resolvePlatform of [
      async () => ({ verdict: 'unknown' as const, detail: 'insufficient sample' }),
      async (): Promise<never> => { throw new Error('ledger unavailable'); },
    ]) {
      const [result] = await runInstrumentChecks({ rubricRef: 'native', criteria: [adoption],
        workspaceId: 'ws-native', now: () => Date.parse(AT), resolvePlatform });
      expect(result).toMatchObject({ verdict: 'error', check: { value: null } });
    }
    let called = false;
    const [missingScope] = await runInstrumentChecks({ rubricRef: 'native', criteria: [adoption],
      now: () => Date.parse(AT), resolvePlatform: async () => { called = true; return { verdict: 'pass', detail: 'unsafe' }; } });
    expect(called).toBe(false);
    expect(missingScope).toMatchObject({ verdict: 'error', check: { value: null } });
    expect(await runInstrumentChecks({ rubricRef: 'native', criteria: [
      { key: 'subject-only', check: { kind: 'instrument', instrumentKey: 'woe.goal-mode-base-scorecard' } },
    ] })).toEqual([]);
  });
});
const single = (observed: number, verdict: 'pass' | 'fail' = 'pass') => ({
  kind: 'probe',
  probe: { kind: 'sql' },
  verdict,
  status: verdict === 'pass' ? 'fresh' : 'stale',
  executed: true,
  observed,
  measuredAt: AT,
});

describe('probeCheckUnit — the unit a probe check declares', () => {
  it('reads a trimmed probe-check unit and nothing else', () => {
    expect(probeCheckUnit({ kind: 'probe', probe: {}, unit: ' ms ' })).toBe('ms');
    expect(probeCheckUnit({ kind: 'probe', probe: {} })).toBeUndefined();
    expect(probeCheckUnit({ kind: 'probe', probe: {}, unit: '   ' })).toBeUndefined();
    expect(probeCheckUnit({ kind: 'instrument', instrumentKey: 'host:df-max-used-pct', unit: 'pct' })).toBeUndefined();
    expect(probeCheckUnit(null)).toBeUndefined();
    expect(probeCheckUnit([{ kind: 'probe', unit: 'ms' }])).toBeUndefined();
  });
});

describe('probeCheckResults — the declared unit rides on every ledger row', () => {
  it('stamps each child row with its criterion unit, and null where the check declares none', () => {
    const results = probeCheckResults(
      'perf-fixture',
      {
        lat: single(42),
        grp: { kind: 'probe', all: [single(1), single(2, 'fail')], verdict: 'fail', status: 'stale', executed: true, measuredAt: AT },
        bare: single(7),
        disk: { kind: 'instrument' },
      } as Record<string, { kind: string }>,
      [
        { key: 'lat', check: { kind: 'probe', probe: {}, unit: 'pct' } },
        { key: 'grp', check: { kind: 'probe', all: [{}, {}], unit: 'ms' } },
        { key: 'bare', check: { kind: 'probe', probe: {} } },
      ],
    );
    expect(results.map((r) => [r.check.id, r.check.value, r.check.unit, r.verdict])).toEqual([
      ['lat:0', 42, 'pct', 'pass'],
      ['grp:0', 1, 'ms', 'pass'],
      ['grp:1', 2, 'ms', 'fail'],
      ['bare:0', 7, null, 'pass'],
    ]);
  });

  it('writes a null unit when the caller supplies no criteria (the pre-unit contract)', () => {
    const [row] = probeCheckResults('perf-fixture', { lat: single(42) } as Record<string, { kind: string }>);
    expect(row?.check.unit).toBeNull();
  });
});

// EI-25846520420095595: a scout-cost probe `lte 5` read NULL in a window where the accumulator never
// ran; the ledger stored verdict 'fail', so the criterion graded at its WORST level. A comparison that
// had nothing to compare measured nothing, exactly like an instrument reading of null: 'error'.
describe('probeCheckResults — a probe that measured nothing is error, not fail', () => {
  const probed = (op: string, observed: unknown, verdict: 'pass' | 'fail' = 'fail') => ({
    kind: 'probe',
    probe: { kind: 'sql', expect: { path: '$.v', op, ...(op === 'exists' ? {} : { value: 5 }) } },
    verdict,
    status: verdict === 'pass' ? 'fresh' : 'stale',
    executed: true,
    ...(observed === undefined ? {} : { observed }),
    measuredAt: AT,
  });
  const run = (child: object) =>
    probeCheckResults('perf-fixture', { c: child } as Record<string, { kind: string }>)[0]!;

  it.each(['gt', 'gte', 'lt', 'lte'])('%s against a NULL or absent reading records error with a measured-nothing detail', (op) => {
    for (const observed of [null, undefined]) {
      const row = run(probed(op, observed));
      expect(row.verdict).toBe('error');
      expect(row.check.value).toBeNull();
      expect(row.detail?.startsWith(`probe measured nothing: '${op}' needs a number or string`)).toBe(true);
    }
  });

  it('keeps a real reading that misses the threshold as fail', () => {
    const row = run(probed('lte', 7.3));
    expect(row.verdict).toBe('fail');
    expect(row.check.value).toBe(7.3);
    expect(row.detail).toBe('probe predicate did not match (observed 7.3)');
  });

  it('keeps exists/eq/ne failures as fail: absence is what those predicates measure', () => {
    expect(run(probed('exists', undefined)).verdict).toBe('fail');
    expect(run(probed('eq', null)).verdict).toBe('fail');
    expect(run(probed('ne', null)).verdict).toBe('fail');
  });

  it('never turns a pass into error, and leaves a probe with no predicate unchanged', () => {
    expect(run(probed('lte', null, 'pass')).verdict).toBe('pass');
    expect(run({ ...probed('lte', null), probe: { kind: 'sql' } }).verdict).toBe('fail');
  });

  it('records error per child inside a grouped all-check, leaving its real-reading siblings alone', () => {
    const rows = probeCheckResults('perf-fixture', {
      grp: { kind: 'probe', all: [probed('lte', 2, 'pass'), probed('lte', null)], verdict: 'fail', status: 'stale', executed: true, measuredAt: AT },
    } as Record<string, { kind: string }>);
    expect(rows.map((r) => [r.check.id, r.verdict])).toEqual([['grp:0', 'pass'], ['grp:1', 'error']]);
  });
});
