import { describe, expect, it } from 'vitest';
import { measurementJsonBytes, parseRecordedMeasurementProvenance } from '@papercusp/test-config/execution-details';
import { fitMeasurementProvenance, retainMeasurementProvenance } from './measurement-provenance';

const times = { startedAt: '2026-10-23T00:00:00Z', finishedAt: '2026-10-23T00:00:01Z' };
describe('bounded original measurement retention', () => {
  it('validates and preserves scoped scalar inputs without upgrading surrounding diagnostics', () => {
    const p = retainMeasurementProvenance({ ...times, procedure: {},
      predicateInput: { path: '$["n"]', value: 7 }, result: { advisory: 'x'.repeat(1000) } });
    expect(p.predicateInput).toEqual({ path: '$["n"]', value: 7 });
    expect(p.gaps).toContain('diagnostics-truncated');
    expect(fitMeasurementProvenance(p, 512).predicateInput).toEqual(p.predicateInput);
    for (const predicateInput of [{ path: '$', value: {} }, { path: '$', value: Infinity },
      { path: '$', value: 'x'.repeat(257) }, { path: '$', value: 7, extra: true },
      { path: '', value: 7 }]) {
      expect(parseRecordedMeasurementProvenance({ ...p, predicateInput })).toBeUndefined();
    }
    for (const value of ['Authorization: Bearer tiny', 'x'.repeat(257), undefined, {}]) {
      expect(retainMeasurementProvenance({ ...times, procedure: {}, result: {},
        predicateInput: { path: '$', value } }).predicateInput).toBeUndefined();
    }
  });

  it('retains internal SQL reader results with absent optional object fields without false gaps', () => {
    const p = retainMeasurementProvenance({ ...times, procedure: { kind: 'sql' }, result: {
      rows: [{ n: '9007199254740993' }], fields: ['n'], rowCount: 1,
      truncated: false, elapsedMs: 1, positiveControl: undefined,
    } });
    expect(p.gaps).toEqual([]);
    expect(p.diagnostics).toContainEqual({ path: '$["rows"]["0"]["n"]', value: '9007199254740993' });
    expect(p.diagnostics.some(d => d.path.includes('positiveControl'))).toBe(false);
    expect(retainMeasurementProvenance({ ...times, procedure: {}, result: [undefined] }).gaps)
      .toEqual(['diagnostics-truncated']);
  });

  it('pins canonical descriptor hashing independently of object insertion order', () => {
    const a = retainMeasurementProvenance({ ...times, procedure: { kind: 'sql', args: { z: 1, a: 'x' } }, result: { count: 7 } });
    const b = retainMeasurementProvenance({ ...times, procedure: { args: { a: 'x', z: 1 }, kind: 'sql' }, result: { count: 7 } });
    expect(a.procedure).toEqual(b.procedure);
    expect(a.diagnostics).toEqual([{ path: '$["count"]', value: 7 }]);
  });
  it('bounds and redacts provenance without changing scalar grades', () => {
    const result: Record<string, unknown> = { password: 'tiny', authorization: { bearer: 'opaque-secret' },
      value: 42, count: 7, nested: { token: 'short' }, huge: '界'.repeat(20_000),
      values: Array.from({ length: 1000 }, (_, i) => i) };
    result.cycle = result;
    const p = retainMeasurementProvenance({ ...times, procedure: { argv: ['run', '--token', 'short', '--password=hidden', '-H', 'Authorization: Bearer tiny'] }, result });
    const text = JSON.stringify(p);
    for (const secret of ['tiny', 'opaque-secret', 'short', 'hidden']) expect(text).not.toContain(secret);
    expect(p.redacted).toBe(true);
    expect(p.truncated).toBe(true);
    expect(p.diagnostics.length).toBeLessThanOrEqual(64);
    expect(measurementJsonBytes(p)).toBeLessThanOrEqual(16_384);
    expect(parseRecordedMeasurementProvenance(p)).toEqual(p);
    expect(result.value).toBe(42);
  });
  it('marks a missing original transaction clock and oversized procedure explicitly', () => {
    const p = retainMeasurementProvenance({ ...times, procedure: { sql: '界'.repeat(9000) }, result: null, needsTransactionClock: true });
    expect(p.procedure.snapshot).toBe('{}');
    expect(p.gaps).toEqual(['procedure-truncated', 'transaction-clock-unavailable']);
  });
  it('redacts indented assignments after multiline headers without changing line endings', () => {
    const stdout = 'Use%\r\n42%\r\n  Authorization: Bearer tiny\r\n\tpassword=short\r\n';
    const p = retainMeasurementProvenance({ ...times, procedure: { argv: ['probe', stdout] }, result: { stdout } });
    expect(p.diagnostics).toEqual([{
      path: '$["stdout"]',
      value: 'Use%\r\n42%\r\n  Authorization=[redacted]\r\n\tpassword=[redacted]\r\n',
    }]);
    expect(p.gaps).toEqual(['redacted']);
    expect(p.truncated).toBe(false);
    for (const secret of ['tiny', 'short']) expect(JSON.stringify(p)).not.toContain(secret);
    expect(parseRecordedMeasurementProvenance(p)).toEqual(p);
  });
  it('shrinks only context for a bounded multi-probe envelope', () => {
    const p = retainMeasurementProvenance({ ...times, procedure: { sql: 'SELECT ' + 'x'.repeat(5000) },
      result: { values: Array.from({ length: 60 }, () => 'x'.repeat(200)) } });
    const small = fitMeasurementProvenance(p, 600);
    expect(measurementJsonBytes(small)).toBeLessThanOrEqual(600);
    expect(small.procedure.sha256).toBe(p.procedure.sha256);
    expect(small.startedAt).toBe(p.startedAt);
    expect(small.gaps).toContain('procedure-truncated');
    expect(parseRecordedMeasurementProvenance(small)).toEqual(small);
  });
});
