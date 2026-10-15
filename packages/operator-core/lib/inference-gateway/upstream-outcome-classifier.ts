/**
 * ONE classifier for every upstream outcome on every provider lane
 * (gateway-admission-congestion-only-2026-10-13, P-001; WI-6554700010011426).
 *
 * WHY THIS EXISTS. The admission window is a congestion controller. It may only
 * shrink on evidence that the UPSTREAM PATH is congested — not on evidence that
 * one ACCOUNT is out of budget, and not on evidence the gateway already routed
 * around. Before this module each gateway call site decided for itself, and the
 * lanes had drifted apart:
 *
 *  - the Codex lane counted EVERY 429 as throttle pressure, including a weekly-wall
 *    / out-of-usage 429 and a 429 the gateway then failed over to a healthy account;
 *  - the Claude lane already ignored a routed-around 429, but still counted a
 *    usage-cap 429 as congestion when no other account could take the request.
 *
 * Owner rule (2026-10-14, directives #1830/#1831): only congestion errors may shrink the
 * cap; an out-of-usage error blocks the ACCOUNT and must not affect the cap; Claude
 * follows the same rule. So both lanes map their raw signals into one
 * {@link UpstreamOutcome}, and {@link classifyUpstreamOutcome} is the only place
 * that decides what the window hears.
 *
 * Pure and dependency-free on purpose: the gateway imports it, and so do tests
 * that pin each provider signal to its class without booting a gateway.
 */

/** Whose limit a 429 reports. */
export type RateLimitScope =
  /** The ACCOUNT is out of budget (usage cap, weekly wall, exhausted window). Park the account. */
  | 'account'
  /** A transient pacing/burst throttle — capacity exists, the path is busy. */
  | 'transient';

/** A provider-neutral description of one upstream outcome. */
export type UpstreamOutcome =
  | { readonly kind: 'success' }
  /**
   * The upstream answered 429. `routedAround` is true when the gateway took the
   * request to another account or egress after it — a routing event, not lane-wide
   * over-drive.
   */
  | { readonly kind: 'rate-limited'; readonly scope: RateLimitScope; readonly routedAround: boolean }
  /** An admitted attempt that died on the wire: TTFB deadline, connect/DNS/reset, or a mid-relay death. */
  | { readonly kind: 'transport-failure' }
  /** The credential was rejected (401, revoked/blocked token). */
  | { readonly kind: 'auth-failure' }
  /** A 4xx other than 429 — the request, not the path, was at fault. */
  | { readonly kind: 'client-error' }
  /** The downstream client went away. */
  | { readonly kind: 'cancelled' };

export type UpstreamOutcomeClass =
  /** A clean upstream answer. */
  | 'success'
  /** About one account (out-of-usage, weekly wall, auth). The account is parked elsewhere; the window is untouched. */
  | 'account-scoped'
  /** Evidence the upstream path is congested. The ONLY class that may shrink the window. */
  | 'congestion'
  /** Carries no capacity signal (a routed-around 429, a client error, a cancel). */
  | 'neutral';

export function classifyUpstreamOutcome(outcome: UpstreamOutcome): UpstreamOutcomeClass {
  switch (outcome.kind) {
    case 'success':
      return 'success';
    case 'rate-limited':
      // An out-of-usage / weekly-wall 429 is about the account even when nothing
      // could route around it: shrinking the window would not give that account
      // budget back, it would only starve every healthy account behind it.
      if (outcome.scope === 'account') return 'account-scoped';
      return outcome.routedAround ? 'neutral' : 'congestion';
    case 'transport-failure':
      return 'congestion';
    case 'auth-failure':
      return 'account-scoped';
    case 'client-error':
    case 'cancelled':
      return 'neutral';
  }
}

/**
 * Claude 429 shapes (`classify429Shape` in gateway.ts) that report an ACCOUNT wall.
 * `usage-cap` is the body-named usage/session limit; `unified-5h-rejected` is the
 * account's own unified window latched rejected. `bare-burst` (a per-IP edge
 * throttle), `rate-window` (a per-minute rate limit with a short reset) and
 * `unclassified` are transient.
 */
const CLAUDE_ACCOUNT_SCOPED_429_SHAPES: ReadonlySet<string> = new Set(['usage-cap', 'unified-5h-rejected']);

export function claudeRateLimitScope(shape: string): RateLimitScope {
  return CLAUDE_ACCOUNT_SCOPED_429_SHAPES.has(shape) ? 'account' : 'transient';
}

/**
 * Codex 429 scope from `parseCodexRateReset(headers).transient`: a 429 with an
 * EXHAUSTED window (5h, weekly, or a zero-remaining OpenAI meter) is an account
 * wall; one without is a pacing/burst throttle.
 */
export function codexRateLimitScope(parsed: { readonly transient: boolean }): RateLimitScope {
  return parsed.transient ? 'transient' : 'account';
}

/**
 * Codex CLI-bridge failures carry only stderr text. A named usage/session limit
 * or quota is an account wall; any other rate-limit wording (`rate limit`,
 * `too many requests`, a bare 429, the CLI's own `exceeded retry limit`) is transient.
 */
export function codexCliRateLimitScope(detail: string): RateLimitScope {
  return /usage limit|session limit|quota/i.test(detail) ? 'account' : 'transient';
}
