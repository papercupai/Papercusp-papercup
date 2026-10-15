/**
 * Shared MCP proxy path classification for cheap, repeating beats.
 *
 * These requests are high-frequency and have an already-scheduled replacement
 * (the next heartbeat, turn, or tool batch). A missed request is therefore a
 * soft degradation, not the same class as a failed MCP tool/control-plane call.
 * Keep this predicate in operator-core so the proxy retry policy and health
 * reader cannot drift into classifying different path sets.
 */
export const CHEAP_REPEATING_BEAT_PATHS: readonly string[] = [
  '/api/agent-mcp/console/bootstrap-su/heartbeat',
  '/api/admin/owner-presence/touch',
  // WI-35737 — per-tool-batch memory-injection search; soft failure, next batch re-fires.
  '/api/agent-mcp/mid-turn-context',
  // WI-35737 — per-turn sibling of the above, same soft-degradation contract.
  '/api/agent-mcp/turn-start-memory',
];

/**
 * Synchronous native-tool security checks fail closed when unavailable. They may be retried
 * on the next tool invocation, but must not spend the restart-sized MCP retry window first.
 */
export const FAST_FAIL_PRECHECK_PATHS: readonly string[] = [
  '/api/agent-mcp/restricted-egress-check',
];

function pathWithoutQuery(url: string): string {
  return (url.split('?')[0] ?? '').replace(/\/+$/, '');
}

/** True when `url` names a high-frequency beat whose replacement is scheduled. */
export function isCheapRepeatingBeat(url: string): boolean {
  return CHEAP_REPEATING_BEAT_PATHS.includes(pathWithoutQuery(url));
}

/** True when a fail-closed preflight should be surfaced promptly after a brief retry. */
export function isFastFailPrecheck(url: string): boolean {
  return FAST_FAIL_PRECHECK_PATHS.includes(pathWithoutQuery(url));
}
