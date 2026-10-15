/**
 * The shared upstream-outcome classifier (WI-6554700010011426, plan
 * gateway-admission-congestion-only-2026-10-13 P-001). One table for both lanes:
 * only congestion may shrink an admission window.
 */
import { describe, expect, it } from 'vitest';

import { parseCodexRateReset } from './codex-oauth-proxy';
import {
  classifyUpstreamOutcome,
  claudeRateLimitScope,
  codexCliRateLimitScope,
  codexRateLimitScope,
  type UpstreamOutcome,
  type UpstreamOutcomeClass,
} from './upstream-outcome-classifier';

describe('classifyUpstreamOutcome', () => {
  const table: ReadonlyArray<[string, UpstreamOutcome, UpstreamOutcomeClass]> = [
    ['clean answer', { kind: 'success' }, 'success'],
    ['out-of-usage 429, nothing to route to', { kind: 'rate-limited', scope: 'account', routedAround: false }, 'account-scoped'],
    ['out-of-usage 429, failed over', { kind: 'rate-limited', scope: 'account', routedAround: true }, 'account-scoped'],
    ['transient 429 nothing could route around', { kind: 'rate-limited', scope: 'transient', routedAround: false }, 'congestion'],
    ['transient 429 failed over to another account', { kind: 'rate-limited', scope: 'transient', routedAround: true }, 'neutral'],
    ['TTFB / transport failure', { kind: 'transport-failure' }, 'congestion'],
    ['credential rejected', { kind: 'auth-failure' }, 'account-scoped'],
    ['client 4xx', { kind: 'client-error' }, 'neutral'],
    ['downstream cancel', { kind: 'cancelled' }, 'neutral'],
  ];
  it.each(table)('%s → %s', (_label, outcome, expected) => {
    expect(classifyUpstreamOutcome(outcome)).toBe(expected);
  });

  it('only congestion can ever reach the window', () => {
    const congested = table.filter(([, , cls]) => cls === 'congestion').map(([label]) => label);
    expect(congested).toEqual(['transient 429 nothing could route around', 'TTFB / transport failure']);
  });
});

describe('provider signal → 429 scope', () => {
  it('maps the Claude 429 shapes: usage walls are the account, bursts and rate windows are transient', () => {
    expect(claudeRateLimitScope('usage-cap')).toBe('account');
    expect(claudeRateLimitScope('unified-5h-rejected')).toBe('account');
    expect(claudeRateLimitScope('bare-burst')).toBe('transient');
    expect(claudeRateLimitScope('rate-window')).toBe('transient');
    expect(claudeRateLimitScope('unclassified')).toBe('transient');
  });

  it('maps a Codex weekly-wall 429 to the account and a header-less throttle to transient', () => {
    const now = Date.UTC(2026, 9, 14, 1, 0, 0);
    const walled = parseCodexRateReset(
      {
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-after-seconds': String(3 * 24 * 3600),
      },
      now,
    );
    expect(codexRateLimitScope(walled)).toBe('account');
    expect(codexRateLimitScope(parseCodexRateReset({}, now))).toBe('transient');
  });

  it('maps Codex CLI stderr: a named usage/session limit is the account, other rate wording is transient', () => {
    expect(codexCliRateLimitScope("You've hit your usage limit. Try again in 3 days.")).toBe('account');
    expect(codexCliRateLimitScope('stream error: quota exceeded')).toBe('account');
    expect(codexCliRateLimitScope('exceeded retry limit, last status: 429 Too Many Requests')).toBe('transient');
    expect(codexCliRateLimitScope('rate limit reached, slow down')).toBe('transient');
  });
});
