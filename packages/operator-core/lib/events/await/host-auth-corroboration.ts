/**
 * Corroborate a psu host's provider-auth condition when the host does not report it
 * (WI-6554700010008461, parked-agent-census-resumption-and-root-cause-2026-10-09 P-011).
 *
 * The one judge (turn-proof.ts `hostRecoverableCondition`) reads `authBlocked` from the host's
 * discovery record. Hosts started before P-004 never write that field, so every consumer read a
 * codex child whose login cannot refresh as healthy. Measured 2026-10-11: 99 of 281 live hosts
 * had no `authBlocked` field; for 6 old-code codex hosts the latest turn ended `unauthorized`,
 * and the census called those sessions stranded, never wedged.
 *
 * A missing field is an UNKNOWN self-report, not `false`. For those hosts only, this reads a
 * signal the host code cannot omit: the codex rollout's latest terminal since the host started.
 * A later successful terminal clears it (`latestCodexProviderErrorAfter`). A host that does
 * write the field is trusted as is: its screen detector is the live signal.
 *
 * Quota is deliberately NOT corroborated. A quota wall lifts at the provider reset, and D-014
 * measured the shared account recovering days early, so an old `usage_limit_exceeded` is not
 * proof the child cannot think now; old-code hosts also already write `quotaBlocked`. An auth
 * failure lasts for the child's life (P-004: it holds a spent single-use refresh token).
 *
 * Callers: the liveness oracle (honest `suspect` + `wedged`) and the stalled-loops host read
 * (which silent-halt also uses, so the census says `needs-relaunch`). The wake pickup sweep does
 * not use it: its only action on an auth condition is one re-queue, and the executor cannot turn
 * that into a recycle for a host that predates `auth-recovery`, so the re-queue would only buy
 * another failing turn.
 */

import type { CodexProviderError } from '../../system-health/codex-rollout-persistence-watchdog';

/** The discovery-record fields the corroboration reads (a structural slice of `PsuPtyHost`). */
export interface AuthCorroborationHost {
  advSessionId?: string | null;
  startedAt?: number | null;
  authBlocked?: boolean | null;
}

/** Where a host view's `authBlocked: true` came from, when it was not the host's own record. */
export type AuthBlockedSource = 'codex-rollout';

export type ReadProviderErrorAfter = (
  sessionKey: string,
  afterMs: number,
  maxBytes?: number,
) => Promise<Pick<CodexProviderError, 'code' | 'rawCode' | 'message'> | null>;

/**
 * Tail bytes read per host. A failed turn's terminal record is the rollout's last line, so this
 * only needs to cover one turn's trailing records; the oracle may read dozens of hosts per call.
 */
export const AUTH_CORROBORATION_TAIL_BYTES = 64 * 1024;

/**
 * Lazy so the oracle's and the guard's static import graphs do not gain the watchdog module
 * (and its scheduler + orchestrator imports) just for this one read.
 */
const readCodexProviderErrorAfterLazy: ReadProviderErrorAfter = async (sessionKey, afterMs, maxBytes) => {
  const { readCodexProviderErrorAfter } = await import('../../system-health/codex-rollout-persistence-watchdog');
  return readCodexProviderErrorAfter(sessionKey, afterMs, maxBytes);
};

/** The session key becomes a path segment under the codex homes root. */
const SAFE_SESSION_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * codex's own auth-failure copy, as psu-pty-host matches it on screen
 * (CODEX_AUTH_FAILURE_PATTERNS). The structured `codex_error_info: unauthorized` is checked first.
 */
const CODEX_AUTH_COPY = [
  /your\s*access\s*token\s*could\s*not\s*be\s*refreshed/i,
  /please\s*log\s*out\s*and\s*sign\s*in\s*again/i,
];

/** True when the host's own record states its auth condition, either way. */
export function hostReportsAuth(host: AuthCorroborationHost): boolean {
  return typeof host.authBlocked === 'boolean';
}

/** True when a codex terminal error is a provider-auth failure (P-004), not quota or transport. */
export function isProviderAuthFailure(error: Pick<CodexProviderError, 'code' | 'rawCode' | 'message'>): boolean {
  if (/unauthori[sz]ed/i.test(error.code) || /unauthori[sz]ed/i.test(error.rawCode)) return true;
  const message = error.message ?? '';
  return CODEX_AUTH_COPY.some((re) => re.test(message));
}

/**
 * Return the host with `authBlocked: true` (and `authBlockedSource`) when its record omits the
 * field and the codex rollout's latest terminal since the host started is an auth failure.
 * Otherwise return it unchanged. Never throws: an unreadable rollout is no reading.
 */
export async function corroborateHostAuth<T extends AuthCorroborationHost>(
  host: T,
  readError: ReadProviderErrorAfter = readCodexProviderErrorAfterLazy,
): Promise<T & { authBlocked?: boolean | null; authBlockedSource?: AuthBlockedSource }> {
  if (hostReportsAuth(host)) return host;
  const key = typeof host.advSessionId === 'string' ? host.advSessionId.trim() : '';
  if (!SAFE_SESSION_KEY.test(key)) return host;
  // Only this host's child counts: the codex home outlives a host process.
  const startedAt =
    typeof host.startedAt === 'number' && Number.isFinite(host.startedAt) && host.startedAt > 0 ? host.startedAt : 0;
  let error: Awaited<ReturnType<ReadProviderErrorAfter>>;
  try {
    error = await readError(key, startedAt, AUTH_CORROBORATION_TAIL_BYTES);
  } catch {
    return host;
  }
  if (!error || !isProviderAuthFailure(error)) return host;
  return { ...host, authBlocked: true, authBlockedSource: 'codex-rollout' };
}
