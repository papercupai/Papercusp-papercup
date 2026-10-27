/**
 * EI-27053660657887116: can a nonce-bound pending carry (EI-267764,
 * `pending-carry-fence-v1`) actually BIND to this psu host?
 *
 * Advertising the cap is not enough. The host admits a bound carry-respawn only when
 * every identity field checked by `carryFenceIdentityMatches`
 * (apps/operator/scripts/psu-carry-fence.mjs) is non-empty on BOTH sides. The host's
 * native session id comes from `resolveRespawnNativeId`, which psu-launcher.mjs wires
 * for codex only, so every Claude host advertised the cap with a permanently-null
 * native id and refused EVERY bound carry as `stale-carry-target`:
 * `session:request-compaction` failed on every Claude psu session, reported as a
 * generic "Failed to reach the session TUI host socket".
 *
 * An unbindable host still admits an UNBOUND carry (no `carryNonce`) until a fence
 * has been acknowledged, which on such a host never happens. Callers therefore send
 * the bound form only when this predicate is true. The `text` rule mirrors the host's
 * own fence check, so a value the host would reject is never offered as identity.
 *
 * Kept dependency-free (no import of psu-pty-discovery) so callers whose tests mock
 * the discovery module still exercise the real predicate.
 */
export interface CarryFenceHostView {
  caps?: string[] | null;
  nativeSessionId?: string | null;
  hostCodeVersion?: string | null;
  advSessionId?: string | number | null;
  startedAt?: number | null;
  childGeneration?: number | null;
}

export const PENDING_CARRY_FENCE_CAP = 'pending-carry-fence-v1';

const fenceText = (value: unknown): boolean =>
  typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;

const positiveInt = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0;

export function hostCarryFenceBindable(host: CarryFenceHostView | null | undefined): boolean {
  if (!host || !Array.isArray(host.caps) || !host.caps.includes(PENDING_CARRY_FENCE_CAP)) return false;
  return (
    fenceText(host.nativeSessionId) &&
    fenceText(host.hostCodeVersion) &&
    fenceText(host.advSessionId == null ? '' : String(host.advSessionId)) &&
    positiveInt(host.startedAt) &&
    positiveInt(host.childGeneration)
  );
}
