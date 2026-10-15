/**
 * Upstream REACHABILITY, kept separate from account capacity (WI-10007199).
 *
 * The account pool has one way to take an account out of rotation: `onExhausted`. A
 * transport failure (DNS, connect timeout, refused connection) goes through it exactly
 * like a usage wall does, so when THIS MACHINE loses its network every account reads
 * unserviceable at once. Measured 2026-10-07 17:05-17:12Z: the box's WiFi lost internet
 * for 7 minutes; every Codex request failed with `ENOTFOUND` / `UND_ERR_CONNECT_TIMEOUT`;
 * `/stats` showed `codexHealthyAccounts: 0` with `upstream429: 0`, and psu refused a launch
 * as "fully walled … would fail fast with 429". The owner reasonably concluded that paid
 * Codex credits were being ignored. Nothing about the accounts was wrong.
 *
 * Capacity and reachability need different remedies: a usage wall is fixed by another
 * account, credits or waiting for a reset; an unreachable upstream is fixed by the network.
 * So the gateway tracks reachability on its own. The discriminator is simple and robust:
 * any HTTP response from the upstream, whatever its status, proves the network path works.
 * Transport failures with NO HTTP response since them, spread across accounts and still
 * fresh, mean the upstream cannot be reached at all.
 */

/** What kind of transport failure this was, from the fetch error's cause code. */
export type TransportFailureKind = 'dns' | 'connect' | 'timeout' | 'other';

export interface UpstreamReachabilitySnapshot {
  /** True when fresh transport failures across accounts have had no HTTP response since. */
  unreachable: boolean;
  /** Epoch ms of the newest HTTP response of any status, or null if none seen yet. */
  lastResponseAt: number | null;
  /** Epoch ms of the newest transport failure, or null if none seen yet. */
  lastTransportFailureAt: number | null;
  /** The newest transport failure, rendered (e.g. `fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND chatgpt.com)`). */
  lastTransportFailure: string | null;
  lastTransportFailureKind: TransportFailureKind | null;
  /** Transport failures recorded after the newest HTTP response. */
  transportFailuresSinceResponse: number;
  /** Distinct accounts with a transport failure after the newest HTTP response. */
  accountsFailingSinceResponse: number;
  /** Epoch ms of the first transport failure after the newest HTTP response (when the outage began). */
  failingSince: number | null;
}

export interface UpstreamReachabilityOptions {
  /** Minimum transport failures since the last response before reporting unreachable. Default 3. */
  minFailures?: number;
  /** Minimum distinct failing accounts (capped at the accounts seen). Default 2. */
  minAccounts?: number;
  /** A failure older than this no longer counts as a live outage. Default 120 s. */
  freshMs?: number;
}

export type ReachabilityTransition = 'became-unreachable' | 'became-reachable' | null;

export interface UpstreamReachabilityTracker {
  /** Record an HTTP response (any status) from the upstream. Returns a transition, if any. */
  noteResponse(accountId: string, at: number): ReachabilityTransition;
  /** Record a transport failure (no HTTP response). Returns a transition, if any. */
  noteTransportFailure(accountId: string, description: string, kind: TransportFailureKind, at: number): ReachabilityTransition;
  snapshot(now: number): UpstreamReachabilitySnapshot;
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME']);
const CONNECT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'EPIPE',
  'ETIMEDOUT',
]);
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ttfb-timeout']);

/**
 * Classify a fetch rejection by its cause code. Undici nests the useful code under
 * `cause` (and, for happy-eyeballs, under `cause.errors[]`), so look there first.
 */
export function classifyTransportFailure(error: unknown): TransportFailureKind {
  const codes: string[] = [];
  const collect = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 3) return;
    const record = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === 'string') codes.push(record.code);
    collect(record.cause, depth + 1);
    if (Array.isArray(record.errors)) for (const inner of record.errors) collect(inner, depth + 1);
  };
  collect(error, 0);
  if (codes.some((code) => DNS_CODES.has(code))) return 'dns';
  if (codes.some((code) => CONNECT_CODES.has(code))) return 'connect';
  if (codes.some((code) => TIMEOUT_CODES.has(code))) return 'timeout';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN/.test(message)) return 'dns';
  if (/TTFB|timed? ?out/i.test(message)) return 'timeout';
  return 'other';
}

export function createUpstreamReachabilityTracker(opts: UpstreamReachabilityOptions = {}): UpstreamReachabilityTracker {
  const minFailures = opts.minFailures ?? 3;
  const minAccounts = opts.minAccounts ?? 2;
  const freshMs = opts.freshMs ?? 120_000;

  let lastResponseAt: number | null = null;
  let lastFailureAt: number | null = null;
  let lastFailure: string | null = null;
  let lastFailureKind: TransportFailureKind | null = null;
  let failuresSinceResponse = 0;
  let failingSince: number | null = null;
  const failingAccounts = new Set<string>();
  const accountsSeen = new Set<string>();
  // The last state REPORTED through a transition, so each edge is logged once.
  let reportedUnreachable = false;

  function isUnreachable(now: number): boolean {
    if (lastFailureAt === null || now - lastFailureAt > freshMs) return false;
    if (failuresSinceResponse < minFailures) return false;
    return failingAccounts.size >= Math.max(1, Math.min(minAccounts, accountsSeen.size));
  }

  function transition(now: number): ReachabilityTransition {
    const unreachable = isUnreachable(now);
    if (unreachable === reportedUnreachable) return null;
    reportedUnreachable = unreachable;
    return unreachable ? 'became-unreachable' : 'became-reachable';
  }

  return {
    noteResponse(accountId, at) {
      accountsSeen.add(accountId);
      if (lastResponseAt === null || at >= lastResponseAt) lastResponseAt = at;
      failuresSinceResponse = 0;
      failingSince = null;
      failingAccounts.clear();
      return transition(at);
    },
    noteTransportFailure(accountId, description, kind, at) {
      accountsSeen.add(accountId);
      lastFailureAt = at;
      lastFailure = description;
      lastFailureKind = kind;
      failuresSinceResponse += 1;
      failingSince ??= at;
      failingAccounts.add(accountId);
      return transition(at);
    },
    snapshot(now) {
      return {
        unreachable: isUnreachable(now),
        lastResponseAt,
        lastTransportFailureAt: lastFailureAt,
        lastTransportFailure: lastFailure,
        lastTransportFailureKind: lastFailureKind,
        transportFailuresSinceResponse: failuresSinceResponse,
        accountsFailingSinceResponse: failingAccounts.size,
        failingSince,
      };
    },
  };
}
