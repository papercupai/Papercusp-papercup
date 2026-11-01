import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeLegs, setLegHealthObserver, type LegHealthWindow, type SearchLegs } from '@papercusp/search';

import {
  RETRIEVAL_DEGRADATION_FLOOR,
  RETRIEVAL_DEGRADATION_MIN_SAMPLES,
  judgeRetrievalHealth,
  runRetrievalDegradationSweepOnce,
  type RetrievalVerdict,
  startRetrievalDegradationWatchdog,
  retrievalSampleDecision,
} from './retrieval-degradation-watchdog';

function health(over: Partial<LegHealthWindow> = {}): LegHealthWindow {
  return {
    windowMs: 60 * 60_000,
    searches: 100,
    degraded: 10,
    degradedRate: 0.1,
    semanticBlocked: 0,
    lexicalBlocked: 0,
    semanticSourceFailed: 0,
    lexicalSourceFailed: 0,
    semanticEmpty: 0,
    lexicalEmpty: 0,
    oldestSampleMs: 1,
    newestSampleMs: 2,
    truncatedByCapacity: false,
    ...over,
  };
}

describe('judgeRetrievalHealth', () => {
  it('calls a low degradation rate healthy', () => {
    expect(judgeRetrievalHealth(health({ degraded: 5, degradedRate: 0.05 })).kind).toBe('healthy');
  });

  it('flags a sustained degradation above the floor', () => {
    const v = judgeRetrievalHealth(
      health({ degraded: 80, degradedRate: 0.8, semanticBlocked: 80 }),
    );
    expect(v.kind).toBe('degraded');
    expect((v as Extract<RetrievalVerdict, { kind: 'degraded' }>).dominant).toBe(
      'semantic leg blocked',
    );
  });

  it('names the DOMINANT leg rather than restating that something is wrong', () => {
    const v = judgeRetrievalHealth(
      health({ degraded: 60, degradedRate: 0.6, semanticBlocked: 10, lexicalEmpty: 50 }),
    );
    expect((v as Extract<RetrievalVerdict, { kind: 'degraded' }>).dominant).toBe(
      'lexical leg returned nothing',
    );
  });

  it('names a dominant partial source failure when leg calls otherwise ran', () => {
    const v = judgeRetrievalHealth(
      health({ degraded: 60, degradedRate: 0.6, semanticSourceFailed: 50, lexicalEmpty: 10 }),
    );
    expect((v as Extract<RetrievalVerdict, { kind: 'degraded' }>).dominant).toBe(
      'semantic source call failed',
    );
  });

  it('refuses a verdict on too few samples — a rate over a tiny denominator is not a measurement', () => {
    // 1 of 1 degraded is a 100% rate and means nothing.
    const v = judgeRetrievalHealth(health({ searches: 1, degraded: 1, degradedRate: 1 }));
    expect(v.kind).toBe('insufficient-samples');
  });

  it('treats a NO-DATA window as insufficient, never as healthy', () => {
    // degradedRate null (not 0) is what makes this distinguishable. A silent
    // instrument must never be able to issue a clean bill of health.
    const v = judgeRetrievalHealth(health({ searches: 0, degraded: 0, degradedRate: null }));
    expect(v.kind).toBe('insufficient-samples');
  });

  it('is exactly at-or-above the floor, not strictly above', () => {
    const atFloor = judgeRetrievalHealth(
      health({ degraded: 50, degradedRate: RETRIEVAL_DEGRADATION_FLOOR, semanticBlocked: 50 }),
    );
    expect(atFloor.kind).toBe('degraded');
  });

  it('honours injected thresholds', () => {
    const v = judgeRetrievalHealth(health({ searches: 30, degraded: 6, degradedRate: 0.2 }), {
      floor: 0.15,
      minSamples: 10,
    });
    expect(v.kind).toBe('degraded');
  });

  it('the shipped minimum-sample bar is not vacuous', () => {
    expect(RETRIEVAL_DEGRADATION_MIN_SAMPLES).toBeGreaterThan(1);
  });
});

describe('retrieval samples on the durable degradation primitive (P-005)', () => {
  afterEach(() => setLegHealthObserver(null));

  it('records every authoritative search once, including healthy decisions needed for recovery', () => {
    const observe = vi.fn((_mechanism: string, _decision: unknown, _opts?: unknown) => true);
    startRetrievalDegradationWatchdog({ observe });
    startRetrievalDegradationWatchdog({ observe });
    const leg = {
      status: 'ran', candidates: 5, floored: 0, stage2Added: 0, callsRun: 0, callsFailed: 0,
      blocked: null, failures: [],
    };
    const legs = {
      lexical: leg, semantic: { ...leg, status: 'errored', candidates: 0, blocked: 'timeout' },
      degraded: true, warning: 'semantic leg blocked',
    } as SearchLegs;
    const correlationId = '64eab084-4e87-4e2b-99bd-3be2eb7c191f';
    observeLegs(legs, 1000, correlationId, 'docs:search');
    observeLegs({ ...legs, semantic: leg, degraded: false } as SearchLegs, 1001, undefined, 'docs:search');
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['retrieval', { eligible: 1, applied: 0, reason: 'semantic-blocked', scope: 'docs:search' }],
      ['retrieval', { eligible: 1, applied: 1, reason: 'applied', scope: 'docs:search' }],
    ]);
    expect(observe.mock.calls[0]?.[2]).toMatchObject({ correlationId });
  });

  it('does not double count a search when several legs degraded', () => {
    expect(retrievalSampleDecision({ atMs: 1, degraded: true, semanticBlocked: true, lexicalBlocked: true,
      semanticSourceFailed: false, lexicalSourceFailed: false, semanticEmpty: false, lexicalEmpty: false }))
      .toEqual({ eligible: 1, applied: 0, reason: 'mixed', scope: 'unattributed' });
  });

  it('classifies partial source failures instead of collapsing them into mixed', () => {
    expect(retrievalSampleDecision({ atMs: 1, degraded: true, semanticBlocked: false, lexicalBlocked: false,
      semanticSourceFailed: true, lexicalSourceFailed: false, semanticEmpty: false, lexicalEmpty: false })).toEqual({
      eligible: 1, applied: 0, reason: 'semantic-source-failed', scope: 'unattributed',
    });
  });

  it('routes the retained one-shot sweep through the same observation primitive', async () => {
    const observe = vi.fn(() => true);
    const result = await runRetrievalDegradationSweepOnce({ flagEnabled: async () => true,
      readHealth: () => health({ degraded: 90, degradedRate: 0.9, semanticBlocked: 90 }), observe });
    expect(result).toEqual({ verdict: 'degraded', escalated: 1 });
    expect(observe).toHaveBeenCalledWith('retrieval', { eligible: 100, applied: 10, reason: 'semantic-leg-blocked' });
  });
});

describe('runRetrievalDegradationSweepOnce', () => {
  it('escalates a degraded window', async () => {
    const seen: Extract<RetrievalVerdict, { kind: 'degraded' }>[] = [];
    const r = await runRetrievalDegradationSweepOnce({
      flagEnabled: async () => true,
      readHealth: () => health({ degraded: 90, degradedRate: 0.9, semanticBlocked: 90 }),
      escalate: async (v) => {
        seen.push(v);
      },
    });
    expect(r).toEqual({ verdict: 'degraded', escalated: 1 });
    expect(seen[0]?.dominant).toBe('semantic leg blocked');
  });

  it('stays silent on a healthy window', async () => {
    let escalated = 0;
    const r = await runRetrievalDegradationSweepOnce({
      flagEnabled: async () => true,
      readHealth: () => health(),
      escalate: async () => {
        escalated += 1;
      },
    });
    expect(r.verdict).toBe('healthy');
    expect(escalated).toBe(0);
  });

  it('no-ops before reading the counter when the flag is off', async () => {
    let read = false;
    const r = await runRetrievalDegradationSweepOnce({
      flagEnabled: async () => false,
      readHealth: () => {
        read = true;
        return health();
      },
      escalate: async () => {},
    });
    expect(r).toEqual({ verdict: 'skipped', escalated: 0 });
    expect(read).toBe(false);
  });

  // FALSIFIABILITY CONTROL kept permanently in the file. This is the naive rule
  // the thresholds exist to prevent: alarm on any degradation at all. It fires
  // on a single degraded search in a quiet window — which is why the real
  // classifier requires a minimum denominator before issuing any verdict.
  it('control: an unguarded "any degradation" rule fires on a 1-sample window', () => {
    const naive = (h: LegHealthWindow) => (h.degraded ?? 0) > 0;
    const oneSample = health({ searches: 1, degraded: 1, degradedRate: 1 });
    expect(naive(oneSample)).toBe(true);
    expect(judgeRetrievalHealth(oneSample).kind).toBe('insufficient-samples');
  });
});
