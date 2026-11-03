/**
 * scorecard-ledger-fill.test.ts — plan test-rubric-unification-2026-10-12 P-007 (R-7) rating rules.
 * The emit seam and the real ledger read are pinned by
 * agent-tools/scorecards/emit-from-ledger.integration.test.ts; this file pins the pure rules.
 */
import { describe, expect, it } from 'vitest';
import {
  LEDGER_EVIDENCE_DETAIL_CHARS,
  fillRatingsFromLedger,
  judgeLedgerRow,
  ledgerCheckBindings,
  ledgerRatingLevel,
  ledgerRowMatchesBinding,
} from './scorecard-ledger-fill';
import type { LatestRubricCheckResult } from './check-results-ledger';
import type { RecordedRubricCheck } from '@papercusp/test-config/execution-details';
import { retainMeasurementProvenance } from './measurement-provenance';
import { rubricCriterionCheckSchema } from './agent-tools/plans/rubric-template';

const RUBRIC = 'acceptance-ledger-fill-fixture';
const SCALE = ['meets', 'near', 'misses'];

function row(id: string, value: RecordedRubricCheck['value'], status: LatestRubricCheckResult['status'], extra: Partial<RecordedRubricCheck> = {}, testRunId = 7): LatestRubricCheckResult {
  const criterionKey = id.split(':')[0]!;
  return {
    testRunId,
    status,
    finishedAt: '2026-10-13T02:00:00.000Z',
    check: { id, rubricRef: RUBRIC, criterionKey, kind: id.endsWith(':instrument') ? 'instrument' : 'probe', value, unit: null, ...extra },
  };
}

const probe = (value: number) => ({ kind: 'sql', sql: 'SELECT 1', schemaRevision: 'r', expect: { path: '$.rowCount', op: 'eq', value } });
const criteria = [
  { key: 'disk', check: { kind: 'instrument', instrumentKey: 'host:df-root-used-pct', expect: { op: 'lt', value: 80 } } },
  { key: 'rows', check: { kind: 'probe', all: [probe(1), probe(2)] } },
  { key: 'never-run', check: { kind: 'instrument', instrumentKey: 'host:cgroup-cpu-delta-cores' } },
  { key: 'judgement', check: { kind: 'instrument', instrumentKey: 'none' } },
  { key: 'computed', check: { kind: 'instrument', instrumentKey: 'woe.goal-mode-base-scorecard' } },
  { key: 'suite', check: { kind: 'tests', files: ['x.test.ts'] } },
];
const manual = { rating: 'meets', evidence: 'read by hand' };

describe('current measurement freshness', () => {
  const criterion = { key: 'rows', check: { kind: 'probe', probe: probe(1), maxAgeMs: 60_000 } };
  const measured = row('rows:0', 1, 'pass');
  const grade = (nowMs: number, result = measured) => fillRatingsFromLedger({ criteria: [criterion],
    callerRatings: {}, rubricRatingScale: [...SCALE, 'unknown'], latest: new Map([['rows:0', result]]), nowMs });

  it('round-trips positive freshness limits through both executable check schemas', () => {
    expect(rubricCriterionCheckSchema.parse(criterion.check)).toMatchObject({ maxAgeMs: 60_000 });
    expect(rubricCriterionCheckSchema.parse({ kind: 'instrument', instrumentKey: 'host:df-root-used-pct', maxAgeMs: 1000 }))
      .toMatchObject({ maxAgeMs: 1000 });
    expect(rubricCriterionCheckSchema.safeParse({ ...criterion.check, maxAgeMs: 0 }).success).toBe(false);
  });

  it('accepts the exact age boundary and expires the same stored pass afterward', () => {
    const boundary = Date.parse(measured.finishedAt) + 60_000;
    const fresh = grade(boundary), expired = grade(boundary + 1);
    expect(fresh.ok && fresh.ratings.rows?.rating).toBe('meets');
    expect(expired.ok && expired.ratings.rows).toMatchObject({ rating: 'unknown', ledgerResult: { value: 1 } });
    expect(expired.ok && expired.ratings.rows?.evidence).toContain('maxAgeMs=60000');
  });

  it.each(['invalid', '2026-10-13T03:00:00Z'])('refuses timestamp %s without erasing historical evidence', finishedAt => {
    const out = grade(Date.parse(measured.finishedAt), { ...measured, finishedAt });
    expect(out.ok && out.ratings.rows).toMatchObject({ rating: 'unknown', ledgerResult: { testRunId: 7, value: 1 } });
  });

  it('rates a recent failed attempt unknown rather than treating the retained old value as current', () => {
    const out = grade(Date.parse(measured.finishedAt), { ...measured, status: 'error', check: { ...measured.check, value: null } });
    expect(out.ok && out.ratings.rows?.rating).toBe('unknown');
  });
});

it('preserves legacy scalar grades with explicit legacy-missing provenance', () => {
  const criterion = { key: 'disk', check: { kind: 'instrument', instrumentKey: 'host:df-root-used-pct', expect: { op: 'lt', value: 80 } } };
  const legacy = row('disk:instrument', 42, 'pass', { unit: '%' });
  const provenance = retainMeasurementProvenance({ procedure: { kind: 'command', key: 'host:df-root-used-pct' },
    result: { n: 1 }, startedAt: legacy.finishedAt, finishedAt: legacy.finishedAt });
  const grade = (r: LatestRubricCheckResult) => fillRatingsFromLedger({ criteria: [criterion], callerRatings: undefined,
    latest: new Map([['disk:instrument', r]]), rubricRatingScale: SCALE });
  const old = grade(legacy);
  const current = grade({ ...legacy, check: { ...legacy.check, provenance } });
  expect(old.ok && current.ok).toBe(true);
  if (!old.ok || !current.ok) return;
  expect(old.ratings.disk?.rating).toBe(current.ratings.disk?.rating);
  expect(old.ratings.disk?.ledgerResult).toMatchObject({ value: 42, unit: '%', provenanceStatus: 'legacy-missing' });
  expect(old.ratings.disk?.evidence).toContain('provenance legacy-missing');
  expect(current.ratings.disk?.ledgerResult?.provenance).toEqual(provenance);
});

describe('ledger evidence retains the measurement procedure', () => {
  const criterion = { key: 'rows', check: { kind: 'probe', probe: probe(1) } };
  const grade = (provenance?: RecordedRubricCheck['provenance']) => fillRatingsFromLedger({
    criteria: [criterion], rubricRatingScale: SCALE, callerRatings: {},
    latest: new Map([['rows:0', row('rows:0', 1, 'pass', { provenance })]]),
  });

  it.each([
    { kind: 'sql', sql: 'SELECT 1 AS n', schemaRevision: 'sql-r1', expect: { path: '$.rowCount', op: 'eq', value: 1 } },
    { kind: 'command', argv: ['node', 'measure.mjs', '--window', '60'], cwd: '/repo' },
  ])('exposes the retained descriptor for $kind without changing its measurement or original window', (procedure) => {
    const provenance = retainMeasurementProvenance({ procedure, result: { rowCount: 1 },
      startedAt: '2026-10-13T01:59:59.000Z', finishedAt: '2026-10-13T02:00:00.000Z' });
    const out = grade(provenance);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ratings.rows).toMatchObject({ rating: 'meets', ledgerResult: { value: 1, provenance } });
    expect(out.ratings.rows!.evidence).toContain(`retained procedure ${provenance.procedure.snapshot}`);
    expect(out.ratings.rows!.evidence).toContain('original window 2026-10-13T01:59:59.000Z..2026-10-13T02:00:00.000Z');
  });

  it('keeps redaction and truncation gaps explicit and never reconstructs a legacy procedure', () => {
    const NEVER_EMIT_MARKER = 'never-emit-me';
    const provenance = retainMeasurementProvenance({
      procedure: { kind: 'tool', args: { apiKey: NEVER_EMIT_MARKER, sql: 'x'.repeat(10_000) } },
      result: {}, startedAt: '2026-10-13T01:59:59.000Z', finishedAt: '2026-10-13T02:00:00.000Z',
    });
    const partial = grade(provenance);
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.ratings.rows!.evidence).toContain('provenance partial');
    expect(partial.ratings.rows!.evidence).toContain('provenance gaps procedure-truncated, redacted');
    expect(partial.ratings.rows!.evidence).not.toContain('fixture-private-value');
    const legacy = grade();
    expect(legacy.ok && legacy.ratings.rows!.evidence).toContain('provenance legacy-missing');
    expect(legacy.ok && legacy.ratings.rows!.evidence).not.toContain('retained procedure');
  });
});

describe('ledgerCheckBindings — which criteria the ledger owns', () => {
  it('owns opt-in scheduled native adoption checks and fills their actual ledger verdicts', () => {
    const native = { key: 'r-31', check: { kind: 'instrument', instrumentKey: 'code-intel:native-adoption-good-use' } };
    const binding = ledgerCheckBindings(native)![0]!;
    expect(binding).toEqual({ id: 'r-31:instrument', kind: 'instrument', unit: 'count', verdictRows: true });
    expect(judgeLedgerRow(binding, row('r-31:instrument', 0, 'fail', { unit: 'count' }))).toBe('fail');
    expect(judgeLedgerRow(binding, row('r-31:instrument', null, 'error', { unit: 'count' }))).toBe('error');
  });
  it('owns probes (one id per child) and command instruments; never manual, platform-computed or tests checks', () => {
    expect(ledgerCheckBindings(criteria[0]!)?.map((b) => [b.id, b.unit, b.expect])).toEqual([['disk:instrument', '%', { op: 'lt', value: 80 }]]);
    expect(ledgerCheckBindings(criteria[1]!)?.map((b) => b.id)).toEqual(['rows:0', 'rows:1']);
    for (const c of criteria.slice(3)) expect(ledgerCheckBindings(c)).toBeNull();
    expect(ledgerCheckBindings({ key: 'none' })).toBeNull();
  });
});

// WI-6554700010018719: platform rows used to carry a 0/1 pass bit under a quantity unit, and the
// fromLedger evidence quoted it, so a fail for 224 stranded agents read "instrument=0 count -> fail".
describe('platform verdict rows — a verdict is never shown as a measured quantity', () => {
  const stranded = { key: 'silent', check: { kind: 'instrument', instrumentKey: 'agents:silent-halt-stranded' } };
  const native = { key: 'r-31', check: { kind: 'instrument', instrumentKey: 'code-intel:native-adoption-good-use', expect: { op: 'eq', value: 1 } } };

  it('matches a verdict row only to a platform binding, and judges it by its recorded verdict', () => {
    const [platform] = ledgerCheckBindings(native)!;
    const verdictRow = row('r-31:instrument', false, 'fail', { unit: null });
    expect(ledgerRowMatchesBinding(platform!, verdictRow)).toBe(true);
    // The criterion's numeric expect is never applied to a verdict (false would not "eq 1" either way).
    expect(judgeLedgerRow(platform!, verdictRow)).toBe('fail');
    expect(judgeLedgerRow(platform!, row('r-31:instrument', true, 'pass', { unit: null }))).toBe('pass');
    // A command instrument has no verdict rows: a unit-less row is a different binding.
    const [command] = ledgerCheckBindings(criteria[0]!)!;
    expect(ledgerRowMatchesBinding(command!, row('disk:instrument', true, 'pass', { unit: null }))).toBe(false);
    expect(ledgerRowMatchesBinding(platform!, row('r-31:instrument', 3, 'pass', { unit: null }))).toBe(false);
  });

  it('quotes the measured quantity and detail as evidence, never a pass bit as a count', () => {
    const detail = '{"stranded":224,"wakeOnly":40,"checked":440,"threshold":5,"bar":"stranded < 5"}';
    const out = fillRatingsFromLedger({
      criteria: [stranded, native], rubricRatingScale: SCALE, callerRatings: {},
      latest: new Map([
        ['silent:instrument', { ...row('silent:instrument', 224, 'fail', { unit: 'count' }, 31), detail }],
        ['r-31:instrument', { ...row('r-31:instrument', false, 'fail', { unit: null }, 32), detail: 'below frozen target' }],
      ]),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ratings.silent).toMatchObject({ rating: 'misses', ledgerResult: { testRunId: 31, value: 224, unit: 'count' } });
    expect(out.ratings.silent!.evidence).toContain('silent:instrument=224 count → fail');
    expect(out.ratings.silent!.evidence).toContain(`measured: ${detail}`);
    expect(out.ratings['r-31']).toMatchObject({ rating: 'misses', ledgerResult: { testRunId: 32, value: false, unit: null } });
    expect(out.ratings['r-31']!.evidence).toContain('r-31:instrument=verdict fail → fail');
    expect(out.ratings['r-31']!.evidence).toContain('measured: below frozen target');
    for (const key of ['silent', 'r-31']) expect(out.ratings[key]!.evidence).not.toMatch(/=0 count/);
  });

  it('bounds the quoted detail and omits it on a passing row', () => {
    const long = 'x'.repeat(LEDGER_EVIDENCE_DETAIL_CHARS + 50);
    const failing = fillRatingsFromLedger({ criteria: [native], rubricRatingScale: SCALE, callerRatings: {},
      latest: new Map([['r-31:instrument', { ...row('r-31:instrument', false, 'fail', { unit: null }), detail: long }]]) });
    expect(failing.ok && failing.ratings['r-31']!.evidence).toContain(`measured: ${'x'.repeat(LEDGER_EVIDENCE_DETAIL_CHARS)}…`);
    expect(failing.ok && failing.ratings['r-31']!.evidence).not.toContain('x'.repeat(LEDGER_EVIDENCE_DETAIL_CHARS + 1));
    const passing = fillRatingsFromLedger({ criteria: [native], rubricRatingScale: SCALE, callerRatings: {},
      latest: new Map([['r-31:instrument', { ...row('r-31:instrument', true, 'pass', { unit: null }), detail: 'stale' }]]) });
    expect(passing.ok && passing.ratings['r-31']!.evidence).not.toContain('measured:');
  });
});

describe('judgeLedgerRow — the CURRENT threshold is applied to the stored value', () => {
  it('re-judges an instrument value against today\'s expect, not the recorded status', () => {
    const [binding] = ledgerCheckBindings(criteria[0]!)!;
    expect(judgeLedgerRow(binding!, row('disk:instrument', 91, 'pass', { unit: '%' }))).toBe('fail');
    expect(judgeLedgerRow(binding!, row('disk:instrument', 40, 'fail', { unit: '%' }))).toBe('pass');
    expect(judgeLedgerRow(binding!, row('disk:instrument', null, 'error', { unit: '%' }))).toBe('error');
  });
  it('re-applies a probe child\'s predicate at the root of the stored scalar; a null value keeps the recorded verdict', () => {
    const [first, second] = ledgerCheckBindings(criteria[1]!)!;
    expect(judgeLedgerRow(first!, row('rows:0', 1, 'fail'))).toBe('pass');
    expect(judgeLedgerRow(second!, row('rows:1', 1, 'pass'))).toBe('fail');
    expect(judgeLedgerRow(second!, row('rows:1', null, 'pass'))).toBe('pass');
  });
});

describe('ledgerRatingLevel', () => {
  it('maps pass to the best level and fail to the worst non-unknown level', () => {
    expect([ledgerRatingLevel('pass', SCALE), ledgerRatingLevel('fail', SCALE)]).toEqual(['meets', 'misses']);
    expect(ledgerRatingLevel('fail', ['healthy', 'degraded', 'broken', 'unknown'])).toBe('broken');
  });
});

describe('fillRatingsFromLedger', () => {
  const latest = new Map([
    ['disk:instrument', row('disk:instrument', 91, 'fail', { unit: '%' }, 11)],
    ['rows:0', row('rows:0', 1, 'pass', {}, 12)],
    ['rows:1', row('rows:1', 2, 'pass', {}, 13)],
  ]);
  const manualRatings = { judgement: manual, computed: manual, suite: manual };

  it('fills every executable criterion from the ledger, stamps provenance, and keeps manual ratings verbatim', () => {
    const out = fillRatingsFromLedger({ criteria, rubricRatingScale: SCALE, callerRatings: manualRatings, latest });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ledgerFilled).toEqual(['disk', 'rows']);
    expect(out.unrecorded).toEqual(['never-run']);
    expect(out.ratings.disk).toMatchObject({
      rating: 'misses', ratedFrom: 'ledger', ledgerResult: { testRunId: 11, value: 91, unit: '%' },
      evidenceRef: 'test_runs:11', evidenceKind: 'test-run',
    });
    expect(out.ratings.rows).toMatchObject({ rating: 'meets', ratedFrom: 'ledger', ledgerResult: { testRunId: 12, value: 1 } });
    expect(out.ratings['never-run']).toMatchObject({ rating: 'unknown', unknownReason: 'not-exercised' });
    expect(out.ratings['never-run']!.ratedFrom).toBeUndefined();
    expect(out.ratings.judgement).toEqual(manual);
  });

  it('asks only for the manual criteria that are missing — never for executable ones, recorded or not', () => {
    const out = fillRatingsFromLedger({ criteria, rubricRatingScale: SCALE, callerRatings: { suite: manual }, latest });
    expect(out).toMatchObject({ ok: false, error: 'manual_rating_missing', criterionKeys: ['judgement', 'computed'] });
  });

  it('refuses a hand rating that disagrees with the ledger, and merges grader annotations onto one that agrees', () => {
    const disagree = fillRatingsFromLedger({ criteria, rubricRatingScale: SCALE, callerRatings: { ...manualRatings, disk: manual }, latest });
    expect(disagree).toMatchObject({ ok: false, error: 'ledger_rating_contradicted', criterionKeys: ['disk'] });
    const agree = fillRatingsFromLedger({
      criteria, rubricRatingScale: SCALE, latest,
      callerRatings: { ...manualRatings, disk: { rating: 'misses', evidence: 'mine', remediation: 'WI-1' } },
    });
    expect(agree.ok && agree.ratings.disk).toMatchObject({ rating: 'misses', remediation: 'WI-1', ratedFrom: 'ledger' });
    expect(agree.ok && agree.ratings.disk!.evidence).toMatch(/^fromLedger: disk:instrument=91 %/);
  });

  it('routes a poor ledger result with a rating-free disposition, and refuses one aimed at a non-ledger criterion', () => {
    const routed = fillRatingsFromLedger({
      criteria, rubricRatingScale: SCALE, callerRatings: manualRatings, latest,
      dispositions: { disk: { remediation: 'WI-2 disk follow-up' } },
    });
    expect(routed.ok && routed.ratings.disk).toMatchObject({
      rating: 'misses', ratedFrom: 'ledger', remediation: 'WI-2 disk follow-up', ledgerResult: { testRunId: 11 },
    });
    const unowned = fillRatingsFromLedger({
      criteria, rubricRatingScale: SCALE, callerRatings: manualRatings, latest,
      dispositions: { judgement: { disregard: 'not a ledger-rated criterion' }, ghost: { remediation: 'WI-3' } },
    });
    expect(unowned).toMatchObject({ ok: false, error: 'ledger_disposition_unowned', criterionKeys: ['judgement', 'ghost'] });
  });

  it('appends grader calibration context while preserving ledger evidence and rating authority', () => {
    const context = 'Comparable-run control test_runs:19 measured 42 % against the same <80 % bar.';
    const out = fillRatingsFromLedger({
      criteria, rubricRatingScale: SCALE, callerRatings: manualRatings, latest,
      dispositions: { disk: { evidence: context, remediation: 'WI-2' } },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ratings.disk).toMatchObject({ rating: 'misses', ratedFrom: 'ledger',
      evidenceRef: 'test_runs:11', ledgerResult: { testRunId: 11, value: 91, unit: '%' } });
    expect(out.ratings.disk!.evidence).toMatch(/^fromLedger: disk:instrument=91 %/);
    expect(out.ratings.disk!.evidence).toContain(`Grader context: ${context}`);
  });

  it('treats an errored latest row as unknown instrument-unavailable, and a row in another unit as unrecorded', () => {
    const out = fillRatingsFromLedger({
      criteria: [criteria[0]!, criteria[2]!], rubricRatingScale: SCALE, callerRatings: {},
      latest: new Map([
        ['disk:instrument', row('disk:instrument', null, 'error', { unit: '%' }, 21)],
        ['never-run:instrument', row('never-run:instrument', 0.5, 'pass', { unit: '%' }, 22)],
      ]),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ratings.disk).toMatchObject({ rating: 'unknown', unknownReason: 'instrument-unavailable', ledgerResult: { testRunId: 21 } });
    expect(out.ratings['never-run']).toMatchObject({ rating: 'unknown', unknownReason: 'not-exercised' });
    expect(out.unrecorded).toEqual(['never-run']);
  });

  it('rates a failed numeric measurement in its explicit intermediate band before falling back to the worst level', () => {
    const withBand = {
      key: 'disk',
      ratingScale: SCALE,
      check: {
        kind: 'instrument',
        instrumentKey: 'host:df-root-used-pct',
        expect: { op: 'lte', value: 50 },
        ratingBands: [{ rating: 'near', expect: { op: 'lte', value: 85 } }],
      },
    };
    const fill = (value: number) => fillRatingsFromLedger({
      criteria: [withBand],
      rubricRatingScale: SCALE,
      callerRatings: {},
      latest: new Map([['disk:instrument', row('disk:instrument', value, 'fail', { unit: '%' }, 41)]]),
    });

    const near = fill(62.38);
    expect(near.ok && near.ratings.disk).toMatchObject({
      rating: 'near', ratedFrom: 'ledger', ledgerResult: { testRunId: 41, value: 62.38, unit: '%' },
    });
    expect(near.ok && near.ratings.disk!.evidence).toContain('→ fail; scorecard rating near');

    const outside = fill(85.01);
    expect(outside.ok && outside.ratings.disk).toMatchObject({ rating: 'misses' });
  });

  it('refuses rating bands that name unknown or non-intermediate scale levels', () => {
    const invalid = {
      key: 'disk',
      ratingScale: SCALE,
      check: {
        kind: 'instrument',
        instrumentKey: 'host:df-root-used-pct',
        expect: { op: 'lte', value: 50 },
        ratingBands: [{ rating: 'unknown', expect: { op: 'lte', value: 85 } }],
      },
    };
    const out = fillRatingsFromLedger({
      criteria: [invalid],
      rubricRatingScale: SCALE,
      callerRatings: {},
      latest: new Map([['disk:instrument', row('disk:instrument', 62.38, 'fail', { unit: '%' }, 42)]]),
    });
    expect(out).toMatchObject({ ok: false, error: 'ledger_rating_bands_invalid', criterionKeys: ['disk'] });
  });
});

describe('probe check unit — a row describes the check only in the declared unit (P-010)', () => {
  const lat = { key: 'lat', check: { kind: 'probe', probe: probe(1), unit: 'pct' } };

  it('carries a declared probe unit on every binding and leaves an undeclared one absent', () => {
    expect(ledgerCheckBindings(lat)?.map((b) => [b.id, b.unit])).toEqual([['lat:0', 'pct']]);
    expect(ledgerCheckBindings(criteria[1]!)?.some((b) => 'unit' in b)).toBe(false);
  });

  it('fills from a row in the declared unit, and treats a row in another unit or none as unrecorded', () => {
    const fill = (unit: string | null) =>
      fillRatingsFromLedger({
        criteria: [lat], rubricRatingScale: SCALE, callerRatings: {},
        latest: new Map([['lat:0', row('lat:0', 1, 'pass', { unit }, 31)]]),
      });
    const ok = fill('pct');
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.ratings.lat).toMatchObject({ rating: 'meets', ratedFrom: 'ledger', ledgerResult: { testRunId: 31, value: 1, unit: 'pct' } });
    for (const other of ['ms', null]) {
      const out = fill(other);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.unrecorded).toEqual(['lat']);
      expect(out.ratings.lat).toMatchObject({ rating: 'unknown', unknownReason: 'not-exercised' });
    }
  });
});
