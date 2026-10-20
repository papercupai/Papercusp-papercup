/**
 * R-9 (bug-inflow-one-problem-one-row-2026-10-18, D-009): same-input inflow replay.
 *
 * The frozen fixture is D-009's population: every work-lane repeated-tool-error row filed in
 * the 7 pre-change UTC days [2026-10-11, 2026-10-18) in papercusp-workspace (2017 rows,
 * 288.1/day), with the invocation-ledger error code and the watchdog's own promotion verdict
 * recorded per row. Generator: .papercusp/scratch/su-fa17-r9-fixture-gen.mts (read-only SQL).
 * The replay runs those rows through the current build's production deriver, repeat counting
 * and volume gate; R-9 holds when it would file fewer than half as many rows.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replayToolErrorInflow, type InflowReplayRow } from './tool-error-inflow-replay';

interface Fixture {
  population: { workspace: string; fromUtc: string; toUtcExclusive: string; decision: string };
  rows: InflowReplayRow[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./tool-error-inflow-replay.fixture.json', import.meta.url), 'utf8'),
) as Fixture;

const T0 = Date.parse('2026-10-11T00:00:00Z');
const row = (id: string, minutes: number, watchdogKey: string, extra: Partial<InflowReplayRow> = {}): InflowReplayRow => ({
  id,
  createdTs: T0 + minutes * 60_000,
  watchdogKey,
  ...extra,
});

describe('replayToolErrorInflow — the current build files one row per problem', () => {
  it('caller errors on one tool file once, whatever field or legacy fingerprint the old key carried', () => {
    const res = replayToolErrorInflow([
      row('EI-1', 0, 'repeated-tool-error:plans:new:caller:invalid_args:note'),
      row('EI-2', 1, 'repeated-tool-error:plans:new:caller:invalid_args:status'),
      row('EI-3', 2, 'repeated-tool-error:plans:new:caller:0123456789abcdef0123456789abcdef'),
    ]);
    expect(res).toMatchObject({ before: 3, after: 1, distinctKeys: 1, afterByClass: { caller: 1 } });
  });

  it('a transient error files nothing unless the watchdog promoted it, and then exactly once', () => {
    const quiet = replayToolErrorInflow([
      row('EI-1', 0, 'repeated-tool-error:plans:list:transient'),
      row('EI-2', 5, 'repeated-tool-error:plans:list:transient:feedface'),
      row('EI-3', 9, 'repeated-tool-error:plans:list:rate-limit'),
    ]);
    expect(quiet.after).toBe(0);

    const sustained = replayToolErrorInflow([
      row('EI-1', 0, 'repeated-tool-error:plans:list:transient'),
      row('EI-2', 5, 'repeated-tool-error:plans:list:transient:feedface', { watchdogPromoted: true }),
    ]);
    expect(sustained).toMatchObject({ after: 1, afterByClass: { transient: 1 } });
  });

  it('a repeated structural key is a counted repeat; a distinct one is a new row', () => {
    const res = replayToolErrorInflow([
      row('EI-1', 0, 'repeated-tool-error:plans:list:structural:handler_error:items'),
      row('EI-2', 1, 'repeated-tool-error:plans:list:structural:handler_error:items'),
      row('EI-3', 2, 'repeated-tool-error:plans:list:structural:read_failed:field-unknown'),
    ]);
    expect(res).toMatchObject({ before: 3, after: 2, afterByClass: { structural: 2 } });
    expect(res.perDay['2026-10-11']).toEqual({ before: 3, after: 2 });
  });

  it('an empty input reports a null ratio, not zero', () => {
    expect(replayToolErrorInflow([]).ratio).toBeNull();
  });
});

describe('R-9 same-input replay over the frozen D-009 population', () => {
  it('is the pinned population: 2017 rows over 7 UTC days', () => {
    expect(fixture.population).toMatchObject({
      workspace: 'papercusp-workspace',
      fromUtc: '2026-10-11T00:00:00Z',
      toUtcExclusive: '2026-10-18T00:00:00Z',
      decision: 'bug-inflow-one-problem-one-row-2026-10-18#D-009',
    });
    expect(fixture.rows).toHaveLength(2017);
    const res = replayToolErrorInflow(fixture.rows);
    expect(Object.keys(res.perDay).sort()).toEqual([
      '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17',
    ]);
  });

  it('the current build would file fewer than half the rows actually filed before the change', () => {
    const res = replayToolErrorInflow(fixture.rows);
    const beforeMean = res.before / 7;
    const afterMean = res.after / 7;
    expect(beforeMean).toBeCloseTo(288.1, 1);
    expect(afterMean).toBeLessThan(beforeMean / 2);
  });
});
