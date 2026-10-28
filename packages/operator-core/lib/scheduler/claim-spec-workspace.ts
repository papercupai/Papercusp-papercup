/** Dependency-free claim-spec workspace partition resolver (WI-1564). */
export function resolveClaimSpecWorkspace(
  identWorkspaceId: string | null | undefined,
): string | undefined {
  const ws = identWorkspaceId?.trim();
  return ws && ws !== '*' ? ws : undefined;
}

/**
 * Resolve the concrete hive/harness scope for claim-spec tools.
 *
 * The HTTP projection uses `'*'` for an operator-scoped context. It is not a
 * real harness slug and must never reach a claimability query as one. An
 * explicit concrete argument wins; otherwise a concrete ambient scope is
 * inherited. A wildcard means "no concrete scope", so callers can reject or
 * deliberately choose their workspace-wide behavior instead of silently
 * measuring an empty literal-harness lane.
 */
export function resolveClaimSpecPotSlug(
  explicitHarness: string | undefined,
  ambientHarness: unknown,
): string | undefined {
  const explicit = explicitHarness?.trim();
  if (explicit && explicit !== '*') return explicit;
  if (typeof ambientHarness !== 'string') return undefined;
  const ambient = ambientHarness.trim();
  return ambient && ambient !== '*' ? ambient : undefined;
}

/**
 * EI-27202502401633951: the pot scope a claim-spec WRITE stamps on its row.
 *
 * A stored spec's `harness_slug` is not only its federation scope. The MCP
 * host's harness inheritance (`readFleetHarnessBinding` in
 * agent-tools/_harness-scope.ts) reads it as the SESSION harness binding of
 * every member that inherits the row: a fleet sentinel binds the whole fleet,
 * and a cup row binds that cup. So the scope must name a harness the target is
 * already bound to, never a workspace-level guess:
 *
 *   1. the explicit/ambient harness the caller resolved (`resolveClaimSpecPotSlug`);
 *   2. else the incumbent EFFECTIVE binding (the target's own row, or for a cup
 *      the fleet row it inherits), so a harness-less re-steer preserves it;
 *   3. else null. The caller decides whether a binding-less row is acceptable
 *      (a cup row: yes, it contributes no binding; a fleet sentinel: no, it
 *      would fail every member's harness resolution closed).
 *
 * The retired fallback was the workspace's lone shared hive
 * (`resolveWorkspaceHiveScope`). On 2026-10-28 an operator-scope write took
 * that path and rebound six frozen-burndown members to a stale June test
 * joined view, `shared-hive-test-hive-2`.
 */
export function resolveClaimSpecWritePotSlug(args: {
  resolvedHarness: string | undefined;
  incumbentHarness: string | null | undefined;
}): string | null {
  const resolved = args.resolvedHarness?.trim();
  if (resolved && resolved !== '*') return resolved;
  const incumbent = args.incumbentHarness?.trim();
  return incumbent && incumbent !== '*' ? incumbent : null;
}
