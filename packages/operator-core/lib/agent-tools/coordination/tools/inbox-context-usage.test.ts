import { describe, expect, it } from 'vitest';
import {
  COMPACTION_HINT_PCT,
  CONTEXT_GAUGE_CRITICAL_PCT,
  CONTEXT_GAUGE_LOUD_PCT,
  CONTEXT_GAUGE_QUIET_PCT,
  contextGaugeReadingSource,
  contextGaugeBand,
  renderBandedContextGauge,
  renderContextUsageLine,
  usableRunwayFromObservedPromptFloor,
} from './inbox-context-usage';

describe('usableRunwayFromObservedPromptFloor', () => {
  it('derives a conservative runway without changing the total-prompt limit', () => {
    expect(usableRunwayFromObservedPromptFloor(250_000, { tokens: 167_686, observations: 3 })).toBe(82_314);
  });
  it('never reports negative room and rejects malformed evidence', () => {
    expect(usableRunwayFromObservedPromptFloor(250_000, { tokens: 260_000, observations: 1 })).toBe(0);
    expect(usableRunwayFromObservedPromptFloor(250_000, { tokens: Number.NaN, observations: 1 })).toBeNull();
    expect(usableRunwayFromObservedPromptFloor(250_000, { tokens: 100, observations: 0 })).toBeNull();
  });
});

describe('renderContextUsageLine (WI-1795 compaction affordance)', () => {
  it('returns null when usage cannot be computed', () => {
    expect(renderContextUsageLine(null, 158000)).toBeNull();
    expect(renderContextUsageLine(undefined, 158000)).toBeNull();
    expect(renderContextUsageLine(1000, null)).toBeNull();
    expect(renderContextUsageLine(1000, undefined)).toBeNull();
    expect(renderContextUsageLine(1000, 0)).toBeNull(); // 0 limit is falsy → no divide-by-zero
  });

  it('selects the live transcript source and falls back to the watchdog cache only when absent', () => {
    expect(contextGaugeReadingSource(152_825)).toBe('live-transcript-bytes/4');
    expect(contextGaugeReadingSource(null)).toBe('watchdog-cache');
    expect(contextGaugeReadingSource(undefined)).toBe('watchdog-cache');
  });

  it('renders a bare fact BELOW the threshold (no affordance)', () => {
    const line = renderContextUsageLine(50_000, 158_000); // ~32%
    expect(line).toBe('context: 50000/158000 (32%)');
    expect(line).not.toMatch(/request-compaction/);
  });

  it('reports the observed prompt floor and conservative usable runway when measured', () => {
    const line = renderContextUsageLine(199_236, 250_000, null, null, {
      tokens: 167_686,
      observations: 3,
    });
    expect(line).toBe(
      'context: 199236/250000 (80%); observed-input floor 167686 (3 samples), conservative usable runway 82314',
    );
  });

  it('labels the live transcript-size estimate used by the inbox gauge', () => {
    const line = renderContextUsageLine(152_825, 250_000, null, null, null, 'live-transcript-bytes/4');
    expect(line).toContain('count source: live transcript-size estimate (bytes/4)');
  });

  it('labels the watchdog cache fallback used when the live transcript is unavailable', () => {
    const line = renderBandedContextGauge(249_043, 250_000, null, null, null, 'watchdog-cache');
    expect(line).toContain('count source: watchdog-cached estimate');
  });

  it('stays a bare fact JUST below the threshold', () => {
    // 84% < 85% → no hint
    const line = renderContextUsageLine(84, 100);
    expect(line).toBe('context: 84/100 (84%)');
    expect(line).not.toMatch(/request-compaction/);
  });

  it('NAMES the action AT the threshold', () => {
    const line = renderContextUsageLine(85, 100); // exactly 85%
    expect(line).toContain('context: 85/100 (85%)');
    expect(line).toContain('session:request-compaction');
    // WI-4998 (owner 2026-07-14 "remove the compact call entirely"): the affordance
    // names session:request-compaction ONLY — the native /compact call is retired. Guard
    // that it does not creep back into this line.
    expect(line).not.toContain('/compact');
  });

  it('NAMES the action ABOVE the threshold, including over 100%', () => {
    const line = renderContextUsageLine(217_577, 158_000); // 138%
    expect(line).toContain('context: 217577/158000 (138%)');
    expect(line).toContain('CALL session:request-compaction');
    // guards the behavioral trap the owner flagged: narrating turn-end instead of calling
    expect(line).toMatch(/do not merely describe ending the turn/i);
  });

  it('does not prescribe self-compaction when no supported PTY host exists', () => {
    const line = renderContextUsageLine(127, 100, false);
    expect(line).toContain('self-compaction is unavailable');
    expect(line).toContain('next wake');
    expect(line).not.toContain('request-compaction');
  });

  it('gates precisely on the rounded percentage at COMPACTION_HINT_PCT', () => {
    // pct rounds: 0.845 → 85 (hint), 0.844 → 84 (no hint)
    const withHint = renderContextUsageLine(845, 1000);
    const without = renderContextUsageLine(844, 1000);
    expect(withHint).toContain('request-compaction');
    expect(without).not.toContain('request-compaction');
    expect(COMPACTION_HINT_PCT).toBe(85);
  });
});

describe('contextGaugeBand (P-013/P-015 banding)', () => {
  it('is silent (null) below the QUIET threshold', () => {
    expect(contextGaugeBand(null)).toBeNull();
    expect(contextGaugeBand(undefined)).toBeNull();
    expect(contextGaugeBand(0)).toBeNull();
    expect(contextGaugeBand(CONTEXT_GAUGE_QUIET_PCT - 1)).toBeNull();
  });
  it('bands quiet / loud / critical at the boundaries', () => {
    expect(contextGaugeBand(CONTEXT_GAUGE_QUIET_PCT)).toBe('quiet'); // 65
    expect(contextGaugeBand(CONTEXT_GAUGE_LOUD_PCT - 1)).toBe('quiet'); // 79
    expect(contextGaugeBand(CONTEXT_GAUGE_LOUD_PCT)).toBe('loud'); // 80
    expect(contextGaugeBand(CONTEXT_GAUGE_CRITICAL_PCT - 1)).toBe('loud'); // 89
    expect(contextGaugeBand(CONTEXT_GAUGE_CRITICAL_PCT)).toBe('critical'); // 90
    expect(contextGaugeBand(140)).toBe('critical');
  });
  it('exposes the owner-proposed thresholds', () => {
    expect([CONTEXT_GAUGE_QUIET_PCT, CONTEXT_GAUGE_LOUD_PCT, CONTEXT_GAUGE_CRITICAL_PCT]).toEqual([
      65, 80, 90,
    ]);
  });
});

describe('renderBandedContextGauge (P-013/P-015 ambient gauge)', () => {
  it('is silent below the quiet band and when usage is uncomputable', () => {
    expect(renderBandedContextGauge(50_000, 158_000)).toBeNull(); // ~32%
    expect(renderBandedContextGauge(64, 100)).toBeNull(); // 64%
    expect(renderBandedContextGauge(null, 300_000)).toBeNull();
    expect(renderBandedContextGauge(1000, 0)).toBeNull();
  });

  it('renders a bare fact in the quiet band (65–79%), no affordance', () => {
    const line = renderBandedContextGauge(70, 100);
    expect(line).toBe('context: 70/100 (70%)');
    expect(line).not.toMatch(/request-compaction/);
    expect(line).not.toMatch(/⚠/);
  });

  it('keeps runway evidence on the ambient banded gauge', () => {
    const line = renderBandedContextGauge(200_000, 250_000, null, null, {
      tokens: 167_686,
      observations: 2,
    });
    expect(line).toContain('context: 200000/250000 (80%)');
    expect(line).toContain('observed-input floor 167686 (2 samples)');
    expect(line).toContain('conservative usable runway 82314');
  });

  it('renders a LOUD ⚠ action line in 80–89%', () => {
    const line = renderBandedContextGauge(85, 100, true);
    expect(line).toContain('⚠ context: 85/100 (85%)');
    expect(line).toContain('session:request-compaction');
    expect(line).toMatch(/approaching your soft compaction limit/i);
  });

  it('renders a CRITICAL ⚠ urgent line at/above 90%', () => {
    const line = renderBandedContextGauge(95, 100, true);
    expect(line).toContain('⚠ context: 95/100 (95%)');
    expect(line).toContain('CRITICAL');
    expect(line).toContain('session:request-compaction');
    expect(line).toMatch(/do not merely narrate ending the turn/i);
  });

  it('uses a supported next-wake path when self-compaction is unavailable', () => {
    const line = renderBandedContextGauge(127, 100, false);
    expect(line).toContain('CRITICAL');
    expect(line).toContain('self-compaction is unavailable');
    expect(line).toContain('next wake');
    expect(line).not.toContain('request-compaction');
  });

  it('keeps the continuation guidance generic when host availability is unknown', () => {
    const line = renderBandedContextGauge(95, 100, null);
    expect(line).toContain('CRITICAL');
    expect(line).toContain("this session's supported continuation path");
    expect(line).not.toContain('self-compaction is unavailable');
    expect(line).not.toContain('session:request-compaction');
  });

  it('bands exactly on the rounded percent at each boundary', () => {
    expect(renderBandedContextGauge(64, 100)).toBeNull(); // 64 silent
    expect(renderBandedContextGauge(65, 100)).toBe('context: 65/100 (65%)'); // quiet
    expect(renderBandedContextGauge(80, 100)).toMatch(/approaching/); // loud
    expect(renderBandedContextGauge(90, 100)).toMatch(/CRITICAL/); // critical
  });
});

describe('fleet wind-down renderer recurrence (EI-21012758172744411)', () => {
  it('POSITIVE: a critical no-PTY member with verified authorization is told to call loop:end', () => {
    const line = renderContextUsageLine(95, 100, false, true);
    const gauge = renderBandedContextGauge(95, 100, false, true);
    expect(line).toContain('typed fleet wind-down authorizes loop:end');
    expect(line).not.toContain('session:request-compaction');
    expect(gauge).toContain('call loop:end under the typed fleet wind-down authorization');
    expect(gauge).not.toContain('session:request-compaction');
    expect(gauge).toContain('do not call session:end or respawn');
  });

  it('NEGATIVE: an unverified or inapplicable authorization keeps the safe no-PTY guidance', () => {
    const denied = renderContextUsageLine(95, 100, false, false);
    const wrongAvailability = renderBandedContextGauge(95, 100, true, true);
    const belowCritical = renderContextUsageLine(89, 100, false, true);
    expect(denied).toContain('self-compaction is unavailable');
    expect(denied).not.toContain('typed fleet wind-down authorizes loop:end');
    expect(wrongAvailability).not.toContain('typed fleet wind-down authorization');
    expect(belowCritical).not.toContain('typed fleet wind-down authorization');
  });
});
