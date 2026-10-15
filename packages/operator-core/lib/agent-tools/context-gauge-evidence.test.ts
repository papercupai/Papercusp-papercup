import { describe, expect, it } from 'vitest';
import {
  CONTEXT_GAUGE_ESTIMATE_METHOD,
  buildTranscriptEstimateGaugeEvidence,
  renderBandedContextGaugeWithEvidence,
  renderGaugeEstimateQualifier,
} from './context-gauge-evidence';
import { renderBandedContextGauge } from './coordination/tools/inbox-context-usage';

const LIMIT = 100_000;
const NOW = 1_000_000_000;

function evidence(over: Partial<Parameters<typeof buildTranscriptEstimateGaugeEvidence>[0]> = {}) {
  return buildTranscriptEstimateGaugeEvidence({ limit: LIMIT, now: NOW, ...over });
}

describe('buildTranscriptEstimateGaugeEvidence', () => {
  it('declares the gauge an estimate with its method and writer — never "exact"', () => {
    const e = evidence({ limitRecordedAt: NOW - 30_000 });
    expect(e.exactness).toBe('estimate');
    expect(e.method).toBe(CONTEXT_GAUGE_ESTIMATE_METHOD);
    expect(e.numeratorWriter).toBe('compaction-usage.anchorTokens');
    expect(e.unit).toBe('tokens');
  });

  it('exposes the denominator value, provenance and calibration age', () => {
    const e = evidence({ limitRecordedAt: NOW - 120_000 });
    expect(e.denominator).toEqual({
      value: LIMIT,
      source: 'watchdog-cache(coord_presence.compaction_limit)',
      recordedAt: NOW - 120_000,
      ageMs: 120_000,
    });
  });

  it('reports an unknown calibration time as null, never as age 0', () => {
    for (const unknown of [null, undefined, Number.NaN]) {
      const e = evidence({ limitRecordedAt: unknown as number | null | undefined });
      expect(e.denominator.recordedAt).toBeNull();
      expect(e.denominator.ageMs).toBeNull();
    }
  });

  it('clamps a future recordedAt (clock skew) to age 0 rather than a negative age', () => {
    expect(evidence({ limitRecordedAt: NOW + 5_000 }).denominator.ageMs).toBe(0);
  });

  it('flags corroboration only when a provider-observed floor is present', () => {
    expect(evidence().corroboratedByObservedFloor).toBe(false);
    expect(
      evidence({ observedPromptFloor: { tokens: 40_000, observations: 3 } })
        .corroboratedByObservedFloor,
    ).toBe(true);
  });

  it('states a comparison rule that forbids deriving per-tool cost from a gauge delta', () => {
    expect(evidence().comparisonRule).toMatch(/per-tool token costs/);
  });
});

describe('renderBandedContextGaugeWithEvidence', () => {
  const e = evidence({ limitRecordedAt: NOW - 60_000 });
  const render = (tokens: number, ev = e) =>
    renderBandedContextGaugeWithEvidence(tokens, LIMIT, null, null, null, ev);

  it('leaves the quiet band byte-identical to the bare renderer (no per-turn cost added)', () => {
    const bare = renderBandedContextGauge(70_000, LIMIT, null, null, null);
    expect(bare).not.toBeNull();
    expect(render(70_000)).toBe(bare);
  });

  it('stays silent below the quiet band, exactly like the bare renderer', () => {
    expect(renderBandedContextGauge(10_000, LIMIT, null, null, null)).toBeNull();
    expect(render(10_000)).toBeNull();
  });

  it.each([
    ['loud', 85_000],
    ['critical', 95_000],
  ])('appends the estimate qualifier on the %s band, after the unchanged bare line', (_band, tokens) => {
    const bare = renderBandedContextGauge(tokens, LIMIT, null, null, null) as string;
    const line = render(tokens) as string;
    expect(line.startsWith(bare)).toBe(true);
    expect(line.slice(bare.length)).toBe(renderGaugeEstimateQualifier(e));
    expect(line).toContain('estimate: transcript-bytes/4, not provider usage');
    expect(line).toContain('limit recorded 60s ago');
  });

  it('passes the bare line through when no evidence is supplied', () => {
    const bare = renderBandedContextGauge(95_000, LIMIT, null, null, null);
    expect(renderBandedContextGaugeWithEvidence(95_000, LIMIT, null, null, null, null)).toBe(bare);
  });
});

describe('renderGaugeEstimateQualifier', () => {
  it('says so plainly when the denominator age is unknown', () => {
    expect(renderGaugeEstimateQualifier(evidence())).toContain('limit age unknown');
  });

  it('names the corroborating floor when one exists, and its absence when not', () => {
    expect(renderGaugeEstimateQualifier(evidence())).toContain('no provider-measured corroboration');
    expect(
      renderGaugeEstimateQualifier(
        evidence({ observedPromptFloor: { tokens: 1, observations: 1 } }),
      ),
    ).toContain('a provider-observed input floor is shown');
  });

  it('renders sub-90s ages in seconds and longer ages in minutes', () => {
    expect(renderGaugeEstimateQualifier(evidence({ limitRecordedAt: NOW - 45_000 }))).toContain('45s ago');
    expect(renderGaugeEstimateQualifier(evidence({ limitRecordedAt: NOW - 300_000 }))).toContain('5m ago');
  });
});
