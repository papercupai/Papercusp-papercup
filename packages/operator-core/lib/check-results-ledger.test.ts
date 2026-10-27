/**
 * Unit tests for the probe-check UNIT on results-ledger rows (test-rubric-unification-2026-10-12
 * P-010, AUTO-BAR-R-10). A rubric probe check may declare the unit of the scalar its probes read;
 * every ledger row the check writes carries it, so the ledger value can be compared with a
 * baseline. Before this, probe rows were always written with unit null, which left a
 * baseline-vs-ledger comparison without a unit for every SQL-probe criterion.
 */
import { describe, expect, it, vi } from 'vitest';
import * as instruments from './rubric-instrument-registry';
import {
  buildRubricCheckLedgerRow, probeCheckResults, probeCheckUnit, runInstrumentChecks, recordRubricCheckResults,
  readLatestRubricCheckResults, rubricCheckLedgerPath,
} from './check-results-ledger';
import { retainMeasurementProvenance } from './measurement-provenance';
import { fillRatingsFromLedger } from './scorecard-ledger-fill';
import { asStructuredObservation } from './harness/improvements/observation-types';
import { measurementJsonBytes } from '@papercusp/test-config/execution-details';

const AT = '2026-10-13T04:00:00.000Z';
const adoption = { key: 'r-31', check: { kind: 'instrument', instrumentKey: 'code-intel:native-adoption-good-use' } };

describe('historical measurement writer-reader-scorecard roundtrip', () => {
  it('replays original descriptor, window and diagnostics after live source changes', async () => {
    const live = { value: 42, sample_count: 7 };
    const provenance = retainMeasurementProvenance({ procedure: { kind: 'tool', tool: 'status:read', args: { id: 'x' },
      schemaRevision: 'frozen', expect: { path: '$.value', op: 'gte', value: 10 } }, result: live,
      startedAt: AT, finishedAt: AT });
    const results = probeCheckResults('roundtrip', { c: { kind: 'probe', verdict: 'pass', status: 'fresh',
      executed: true, observed: live.value, measuredAt: AT, provenance } } as Record<string, { kind: string }>);
    let persisted: unknown;
    await recordRubricCheckResults(results, { workspaceId: 'ws', harnessSlug: 'papercusp' }, async (_text, ...values) => {
      persisted = JSON.parse(JSON.stringify(values.at(-1)));
      return [{ id: 31 }];
    });
    live.value = 999;
    live.sample_count = 999;
    const latest = await readLatestRubricCheckResults({ rubricRef: 'roundtrip', workspaceId: 'ws' }, async () => [{
      id: 31, status: 'pass', file_path: 'rubric-check/roundtrip/c:0', finished_at: AT,
      execution_details: persisted, output_tail: null,
    }]);
    const out = fillRatingsFromLedger({ criteria: [{ key: 'c', check: { kind: 'probe',
      probe: { expect: { path: '$.value', op: 'gte', value: 10 } } } }],
      callerRatings: undefined, latest, rubricRatingScale: ['meets', 'misses'] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const saved = asStructuredObservation({ ratings: out.ratings })!.ratings!.c!;
    expect(saved.rating).toBe('meets');
    expect(saved.ledgerResult).toMatchObject({ value: 42, provenanceStatus: 'retained', provenance: {
      startedAt: AT, finishedAt: AT, diagnostics: expect.arrayContaining([{ path: '$["sample_count"]', value: 7 }]),
    } });
    expect(saved.evidence).toContain('procedure sha256');
    expect(saved.ledgerResult?.provenance?.procedure.snapshot).toContain('frozen');
  });

  it('bounds and redacts provenance without changing scalar grades', async () => {
    const result: Record<string, unknown> = {
      value: 42, sample_count: 7, password: 'tiny', authorization: { bearer: 'opaque-secret' },
      nested: { token: 'short' }, huge: '界'.repeat(20_000),
      values: Array.from({ length: 1000 }, (_, i) => i),
    };
    result.cycle = result;
    const provenance = retainMeasurementProvenance({ startedAt: AT, finishedAt: AT,
      procedure: { kind: 'command', argv: ['run', '--token', 'short', '--password=hidden'] }, result });
    const results = probeCheckResults('safe-roundtrip', { c: { kind: 'probe', verdict: 'pass',
      status: 'fresh', executed: true, observed: result.value, measuredAt: AT, provenance } } as Record<string, { kind: string }>);
    let persisted: unknown;
    await recordRubricCheckResults(results, { workspaceId: 'ws', harnessSlug: 'papercusp' }, async (_text, ...values) => {
      persisted = JSON.parse(JSON.stringify(values.at(-1)));
      return [{ id: 32 }];
    });
    const latest = await readLatestRubricCheckResults({ rubricRef: 'safe-roundtrip', workspaceId: 'ws' }, async () => [{
      id: 32, status: 'pass', file_path: 'rubric-check/safe-roundtrip/c:0', finished_at: AT,
      execution_details: persisted, output_tail: null,
    }]);
    const out = fillRatingsFromLedger({ criteria: [{ key: 'c', check: { kind: 'probe',
      probe: { expect: { path: '$.value', op: 'gte', value: 10 } } } }],
      callerRatings: undefined, latest, rubricRatingScale: ['meets', 'misses'] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const saved = asStructuredObservation({ ratings: out.ratings })!.ratings!.c!;
    expect(saved.rating).toBe('meets');
    expect(saved.ledgerResult).toMatchObject({ value: 42, provenance: { redacted: true, truncated: true } });
    expect(saved.ledgerResult?.provenance?.diagnostics).toContainEqual({ path: '$["sample_count"]', value: 7 });
    expect(saved.ledgerResult?.provenance?.diagnostics.length).toBeLessThanOrEqual(64);
    expect(measurementJsonBytes(saved.ledgerResult!.provenance!)).toBeLessThanOrEqual(16_384);
    for (const secret of ['tiny', 'opaque-secret', 'short', 'hidden']) {
      expect(JSON.stringify({ persisted, saved })).not.toContain(secret);
    }
  });
});

describe('per-subject check rows (crm plan D-049)', () => {
  const lead = (ref: string) => ({ kind: 'person', ref });
  const row = (id: number, checkId: string, value: number, subject?: { kind?: string; ref: string }) => {
    const check = { id: checkId, rubricRef: 'leads', criterionKey: checkId.split(':')[0]!, kind: 'instrument' as const,
      value, unit: 'score', ...(subject ? { subject } : {}) };
    const built = buildRubricCheckLedgerRow({ check, verdict: 'pass', measuredAt: AT, durationMs: 1 },
      { workspaceId: 'ws', harnessSlug: 'crm', root: '/tmp' });
    return { id, status: 'pass', file_path: built.filePath, finished_at: AT, output_tail: null,
      execution_details: JSON.parse(JSON.stringify(built.executionDetails)) };
  };
  const rows = [
    row(1, 'usage:instrument', 80, lead('PER-a')),
    row(2, 'usage:instrument', 10, lead('PER-b')),
    row(3, 'usage:instrument', 55), // legacy rubric-wide row of a now per-subject check
    row(4, 'fit:instrument', 70, lead('PER-a')),
    row(5, 'freshness:instrument', 99), // a rubric-wide check never recorded per subject
  ];
  const read = (subject?: { kind?: string; ref: string }) =>
    readLatestRubricCheckResults({ rubricRef: 'leads', workspaceId: 'ws', ...(subject ? { subject } : {}) }, async () => rows);

  it('writes a subject row to its own file under the rubric prefix', () => {
    expect(rows[0]!.file_path).toBe('rubric-check/leads/usage:instrument@subject/person/PER-a');
    expect(rubricCheckLedgerPath('leads', 'c:0', { ref: 'a/b c' })).toBe('rubric-check/leads/c:0@subject/-/a%2Fb%20c');
    expect(rubricCheckLedgerPath('leads', 'c:0')).toBe('rubric-check/leads/c:0');
  });

  it('a rubric-wide read never sees a subject measurement', async () => {
    const latest = await read();
    expect([...latest.keys()].sort()).toEqual(['freshness:instrument', 'usage:instrument']);
    expect(latest.get('usage:instrument')!.testRunId).toBe(3);
  });

  it("a subject read returns only that subject's rows, plus checks never recorded per subject", async () => {
    const a = await read(lead('PER-a'));
    expect(Object.fromEntries([...a].map(([id, r]) => [id, r.testRunId])))
      .toEqual({ 'usage:instrument': 1, 'fit:instrument': 4, 'freshness:instrument': 5 });
  });

  it("never borrows another subject's or the rubric-wide row for a per-subject check", async () => {
    const b = await read(lead('PER-b'));
    expect(b.get('usage:instrument')!.testRunId).toBe(2);
    expect(b.has('fit:instrument')).toBe(false);
    const unknown = await read(lead('PER-unmeasured'));
    expect(unknown.has('usage:instrument')).toBe(false);
    expect(unknown.has('fit:instrument')).toBe(false);
    expect(unknown.get('freshness:instrument')!.testRunId).toBe(5);
    // kind is part of the identity: the same ref under another kind is another subject.
    expect((await read({ ref: 'PER-a' })).has('usage:instrument')).toBe(false);
  });

  it('a per-subject check left unmeasured fills as unknown, not as the borrowed value', async () => {
    const out = fillRatingsFromLedger({ criteria: [{ key: 'fit', check: { kind: 'instrument',
      instrumentKey: 'code-intel:native-adoption-good-use' } }], callerRatings: undefined,
      latest: await read(lead('PER-b')) });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.unrecorded).toEqual(['fit']);
  });
});

describe('scheduled platform instrument results', () => {
  it('passes a validated subject only to an explicitly subject-scoped resolver and retains its original measurement', async () => {
    const registered = instruments.getRegisteredInstrument(adoption.check.instrumentKey);
    if (registered?.evaluator !== 'platform' || !registered.rescore) throw new Error('fixture instrument unavailable');
    const lookup = vi.spyOn(instruments, 'getRegisteredInstrument').mockReturnValue({ ...registered,
      rescore: { ...registered.rescore, scope: 'subject' } });
    try {
      const windows: unknown[] = [];
      const results = [];
      for (const ref of ['PER-a', 'PER-b']) {
        results.push(...await runInstrumentChecks({ rubricRef: 'leads', criteria: [adoption],
          workspaceId: 'ws', subject: { kind: 'person', ref }, now: () => Date.parse(AT),
          resolvePlatform: async window => {
            windows.push(window);
            return { verdict: 'pass', value: ref === 'PER-a' ? 80 : 20, detail: `source:${ref}` };
          } }));
      }
      expect(windows).toEqual(['PER-a', 'PER-b'].map(ref => ({ workspaceId: 'ws', subject: { kind: 'person', ref },
        windowStart: '2026-10-10T04:00:00.000Z', windowEnd: AT })));
      expect(results.map(row => [row.check.subject?.ref, row.check.value])).toEqual([['PER-a', 80], ['PER-b', 20]]);
      expect(JSON.parse(results[0]!.check.provenance!.procedure.snapshot).window.subject.ref).toBe('PER-a');
      expect(results[0]!.check.provenance!.diagnostics).toContainEqual({ path: '$["value"]', value: 80 });
      expect(buildRubricCheckLedgerRow(results[0]!, { workspaceId: 'ws', harnessSlug: 'crm' }).filePath)
        .toBe('rubric-check/leads/r-31:instrument@subject/person/PER-a');
      const resolvePlatform = vi.fn(async () => ({ verdict: 'pass' as const, value: 99, detail: 'unsafe' }));
      const [missing] = await runInstrumentChecks({ rubricRef: 'leads', criteria: [adoption], workspaceId: 'ws', resolvePlatform });
      expect(resolvePlatform).not.toHaveBeenCalled();
      expect(missing).toMatchObject({ verdict: 'error', check: { value: null } });
      await expect(runInstrumentChecks({ rubricRef: 'leads', criteria: [adoption], workspaceId: 'ws',
        subject: { ref: '' }, resolvePlatform })).rejects.toThrow('invalid_rubric_check_subject');
      expect(resolvePlatform).not.toHaveBeenCalled();
    } finally { lookup.mockRestore(); }
  });

  it('does not relabel a rubric-wide measurement as a subject measurement', async () => {
    const resolvePlatform = vi.fn(async (_window: Parameters<NonNullable<Parameters<typeof runInstrumentChecks>[0]['resolvePlatform']>>[0]) =>
      ({ verdict: 'pass' as const, value: 12, detail: 'workspace total' }));
    const [result] = await runInstrumentChecks({ rubricRef: 'native', criteria: [adoption], workspaceId: 'ws',
      subject: { kind: 'person', ref: 'PER-a' }, resolvePlatform });
    expect(resolvePlatform.mock.calls[0]![0]).not.toHaveProperty('subject');
    expect(result!.check).not.toHaveProperty('subject');
    expect(buildRubricCheckLedgerRow(result!, { workspaceId: 'ws', harnessSlug: 'crm' }).filePath)
      .toBe('rubric-check/native/r-31:instrument');
  });

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
    expect(result).toMatchObject({ verdict: 'fail', measuredAt: AT, check: { id: 'R-15:instrument', value: false, unit: null } });
  });

  it('measures the exact completed trailing window in the rubric workspace and records failure', async () => {
    const windows: unknown[] = [];
    const [result] = await runInstrumentChecks({ rubricRef: 'native', criteria: [adoption],
      workspaceId: 'ws-native', now: () => Date.parse(AT),
      resolvePlatform: async window => { windows.push(window); return { verdict: 'fail', detail: 'below frozen target' }; },
    });
    expect(windows).toEqual([{ workspaceId: 'ws-native', windowStart: '2026-10-10T04:00:00.000Z', windowEnd: AT }]);
    expect(result).toMatchObject({ verdict: 'fail', measuredAt: AT, detail: 'below frozen target',
      check: { id: 'r-31:instrument', value: false, unit: null } });
  });

  // WI-6554700010018719: a verdict-only platform row used to store its pass bit as 0/1 under the
  // instrument's quantity unit, so a fail for 224 stranded agents read back as "0 count".
  it('never records a verdict-only result as a quantity in the instrument unit', async () => {
    for (const verdict of ['pass', 'fail'] as const) {
      const [result] = await runInstrumentChecks({ rubricRef: 'native', criteria: [adoption],
        workspaceId: 'ws-native', now: () => Date.parse(AT),
        resolvePlatform: async () => ({ verdict, detail: `${verdict} detail` }) });
      expect(result!.verdict).toBe(verdict);
      expect(result!.check.value).toBe(verdict === 'pass');
      expect(typeof result!.check.value).not.toBe('number');
      expect(result!.check.unit).toBeNull();
    }
  });

  it('records the quantity a platform resolver measured, in the instrument unit', async () => {
    const stranded = { key: 'silent-halts-below-threshold', check: { kind: 'instrument', instrumentKey: 'agents:silent-halt-stranded' } };
    const [result] = await runInstrumentChecks({ rubricRef: 'auto-silent-halt-stranded', criteria: [stranded],
      workspaceId: 'ws', now: () => Date.parse(AT),
      resolvePlatform: async () => ({ verdict: 'fail', detail: '{"stranded":224}', value: 224 }) });
    expect(result).toMatchObject({ verdict: 'fail', detail: '{"stranded":224}',
      check: { id: 'silent-halts-below-threshold:instrument', value: 224, unit: 'count' } });
    // A measured value on an unmeasured (unknown) verdict is still recorded as nothing.
    const [unknown] = await runInstrumentChecks({ rubricRef: 'auto-silent-halt-stranded', criteria: [stranded],
      workspaceId: 'ws', now: () => Date.parse(AT),
      resolvePlatform: async () => ({ verdict: 'unknown', detail: 'sweep failed', value: 3 }) });
    expect(unknown).toMatchObject({ verdict: 'error', check: { value: null, unit: 'count' } });
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
