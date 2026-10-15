import { describe, expect, it } from 'vitest';
import { classifyTransportFailure, createUpstreamReachabilityTracker } from './upstream-reachability';

/** Shape of the undici rejection seen live on 2026-10-07 (WI-10007199). */
function fetchFailed(code: string, message = `${code} chatgpt.com`): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });
}

describe('classifyTransportFailure', () => {
  it('reads the undici cause code: DNS, connect and timeout are told apart', () => {
    expect(classifyTransportFailure(fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND chatgpt.com'))).toBe('dns');
    expect(classifyTransportFailure(fetchFailed('EAI_AGAIN'))).toBe('dns');
    expect(classifyTransportFailure(fetchFailed('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'))).toBe('connect');
    expect(classifyTransportFailure(fetchFailed('ECONNREFUSED'))).toBe('connect');
    expect(classifyTransportFailure(Object.assign(new Error('gateway upstream TTFB exceeded 30000ms'), { code: 'ttfb-timeout' }))).toBe('timeout');
    expect(classifyTransportFailure(new Error('something else'))).toBe('other');
  });

  it('finds the code inside a happy-eyeballs AggregateError', () => {
    const aggregate = Object.assign(new AggregateError([Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' })], ''), {});
    expect(classifyTransportFailure(Object.assign(new TypeError('fetch failed'), { cause: aggregate }))).toBe('connect');
  });
});

describe('upstream reachability tracker', () => {
  it('reports unreachable only after fresh failures across accounts with no HTTP response since', () => {
    const tracker = createUpstreamReachabilityTracker({ minFailures: 3, minAccounts: 2, freshMs: 120_000 });
    expect(tracker.noteResponse('b', 500)).toBeNull();
    expect(tracker.noteResponse('a', 1_000)).toBeNull();
    expect(tracker.noteTransportFailure('a', 'fetch failed (ENOTFOUND)', 'dns', 2_000)).toBeNull();
    expect(tracker.noteTransportFailure('a', 'fetch failed (ENOTFOUND)', 'dns', 3_000)).toBeNull();
    // Three failures, but all on ONE account while two accounts are known: could be that account's egress.
    expect(tracker.noteTransportFailure('a', 'fetch failed (ENOTFOUND)', 'dns', 4_000)).toBeNull();
    expect(tracker.snapshot(4_000).unreachable).toBe(false);

    expect(tracker.noteTransportFailure('b', 'fetch failed (UND_ERR_CONNECT_TIMEOUT)', 'connect', 5_000)).toBe('became-unreachable');
    const down = tracker.snapshot(5_000);
    expect(down).toMatchObject({
      unreachable: true,
      lastResponseAt: 1_000,
      lastTransportFailureAt: 5_000,
      lastTransportFailure: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)',
      lastTransportFailureKind: 'connect',
      transportFailuresSinceResponse: 4,
      accountsFailingSinceResponse: 2,
      failingSince: 2_000,
    });
    // The edge is reported once, not on every further failure.
    expect(tracker.noteTransportFailure('b', 'x', 'connect', 6_000)).toBeNull();
  });

  it('any HTTP response proves the path works and clears the outage', () => {
    const tracker = createUpstreamReachabilityTracker({ minFailures: 2, minAccounts: 1 });
    tracker.noteTransportFailure('a', 'x', 'dns', 1_000);
    expect(tracker.noteTransportFailure('a', 'x', 'dns', 2_000)).toBe('became-unreachable');
    // A 429 is still a response: that is a usage question, not a network one.
    expect(tracker.noteResponse('a', 3_000)).toBe('became-reachable');
    expect(tracker.snapshot(3_000)).toMatchObject({ unreachable: false, transportFailuresSinceResponse: 0, failingSince: null });
  });

  it('stale failures stop counting as a live outage', () => {
    const tracker = createUpstreamReachabilityTracker({ minFailures: 1, minAccounts: 1, freshMs: 60_000 });
    tracker.noteTransportFailure('a', 'x', 'connect', 10_000);
    expect(tracker.snapshot(10_000).unreachable).toBe(true);
    expect(tracker.snapshot(70_001).unreachable).toBe(false);
  });

  it('a single known account only needs to fail on its own', () => {
    const tracker = createUpstreamReachabilityTracker({ minFailures: 3, minAccounts: 2 });
    for (const at of [1, 2, 3]) tracker.noteTransportFailure('only', 'x', 'dns', at);
    expect(tracker.snapshot(3).unreachable).toBe(true);
  });
});
