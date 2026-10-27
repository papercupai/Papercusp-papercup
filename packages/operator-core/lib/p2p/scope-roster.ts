/**
 * lib/p2p/scope-roster.ts — the P-006 §5.2/§5.3 ROSTER SEAM (FS-D2/FS-D6): who
 * is a member of a fleet scope, resolved cache-bypassingly + keyed by NUMERIC
 * GitHub user id (X9), with the scope's current epoch (X6).
 *
 * WHY THIS IS DELIBERATELY THIN (and NOT grant-store-derived per-user):
 *   The P-001 grant primitive is keyed `(grantor-uid → grantee {fleet-slug |
 *   pool-id}, capability)` (D-010). It answers "is FLEET F authorized by
 *   grantor G for capability C" — it does NOT encode, and cannot answer,
 *   "is USER U a member of fleet F": the grantee is a fleet/pool string, never
 *   a user id, and resolving a grantee-fleet-slug back to its member users needs
 *   the P-101 fleet directory's `owner` + `publisher set` fields (design §9:
 *   "roster derivation depends on P-101's directory schema"). Guessing a
 *   per-user mapping out of the grant rows would bake a SECURITY-relevant
 *   membership bug (membership = who may read foreign work). So we don't guess.
 *
 * Membership requires a current, unrevoked attested hive device. The directory
 * narrows that population to the scope's owner and publishers; directory membership
 * alone cannot revive a revoked device. With no directory, only the owner qualifies.
 *
 * P-101 SLOT-IN: when the directory lands, implement {@link FleetDirectory} over
 * it and pass it to {@link GrantBackedScopeRoster}; the membership answer widens
 * to `{owner} ∪ publisher-set` with ZERO change to every §5.1/§5.3 caller (they
 * only ever see the {@link IsScopeMember} predicate). Until then the directory
 * is absent and membership is owner-only.
 *
 * C6/FS-D6: `isMember` / `currentEpoch` are DIRECT PG reads on every call — no
 * memoization, no TTL — so a revocation (epoch bump) that federated one
 * statement ago is enforced on the very next disclose/serve check.
 */

// LAZY on purpose — the membership and epoch readers below load on demand
// (harden-shared-hive-to-256-peers-2026-06-29 / D-024).
// This module is reached from the substrate boot path via pot-git/serve-wiring;
// a static edge here charges every peer process ~125MB of drizzle it never uses.
import type { OrgSql } from '../work-items';
import { resolveP2pGrantWorkspace } from './grant-store';
import type { ScopeId } from '../sync/pot-git/scope-repo';
import type { IsScopeMember } from '../sync/hyperbee/scope-disclosure';

/**
 * P-101 directory seam (absent until P-101 ships). An implementation resolves a
 * fleet scope to the NUMERIC github user ids of its members — the owner plus the
 * ratified publisher set — cache-bypassingly. Kept intentionally minimal so
 * P-101 owns the schema; this module only consumes numeric ids (X9).
 */
export interface FleetDirectory {
  /** Numeric github user ids that are members of `scope` right now, or null when
   *  the directory has no record of the scope (⇒ owner-only fallback). */
  scopeMembers(scope: ScopeId): Promise<number[] | null>;
}

export interface ScopeRoster {
  /** FS-D6: is `githubUserId` in `scope`'s roster right now? Cache-bypassing. */
  isMember(scope: ScopeId, githubUserId: number): Promise<boolean>;
  /** The full member id set (disclosure/redisclosure inputs). */
  members(scope: ScopeId): Promise<number[]>;
  /** The hive membership/re-key epoch, shared by disclosure and key distribution.
   * Grant replay high-water is a separate authorization counter. */
  currentEpoch(scope: ScopeId): Promise<number>;
  /** The {@link IsScopeMember} predicate the §5.1/§5.3 layer consumes. */
  readonly predicate: IsScopeMember;
}

export interface ScopeRosterDeps {
  /** The caller's resolved identity workspace (C3 — run through resolveP2pGrantWorkspace). */
  workspaceId: string | null | undefined;
  /** The hive HOME slug the fleet's grants/epochs federate under. */
  potSlug: string;
  /** P-101 directory, when it exists. Absent ⇒ owner-only (tier-1). */
  directory?: FleetDirectory;
  sqlOverride?: OrgSql;
}

/**
 * The grant-store-backed roster. Membership = `{owner}` (tier-1) widened by the
 * injected {@link FleetDirectory} publisher set (tier-2/P-101), intersected with
 * the current hive roster. Revocations and the hive epoch are read live.
 */
export class GrantBackedScopeRoster implements ScopeRoster {
  private readonly deps: ScopeRosterDeps;
  readonly predicate: IsScopeMember;

  constructor(deps: ScopeRosterDeps) {
    this.deps = deps;
    // Bind the predicate the disclosure/serve layer consumes.
    this.predicate = (scope: ScopeId, uid: number) => this.isMember(scope, uid);
  }

  async isMember(scope: ScopeId, githubUserId: number): Promise<boolean> {
    try {
      return (await this.members(scope)).includes(githubUserId);
    } catch {
      return false;
    }
  }

  async members(scope: ScopeId): Promise<number[]> {
    const ws = this.workspaceId();
    const { listHiveMembersForLocalPot } = await import('../federated-pot-scope');
    const roster = await listHiveMembersForLocalPot(ws, this.deps.potSlug, this.deps.sqlOverride);
    const revoked = new Set(roster.flatMap(member => member.revokedPubkeys));
    const active = new Set(roster.filter(member => member.deviceAttestations.some(
      device => device.device_pubkey && !revoked.has(device.device_pubkey),
    )).map(member => member.githubUserId));
    const dir = this.deps.directory;
    const members = await dir?.scopeMembers(scope) ?? [];
    return [...new Set([scope.ownerGithubUserId, ...members])].filter(uid => active.has(uid));
  }

  private workspaceId(): string {
    const ws = resolveP2pGrantWorkspace(this.deps.workspaceId);
    if (!ws) throw new Error('Scope roster authority unavailable: unresolved workspace');
    return ws;
  }

  /**
   * Use the same live epoch as hive key distribution. An unavailable partition
   * is an authority failure, not a synthetic baseline epoch.
   */
  async currentEpoch(_scope: ScopeId): Promise<number> {
    const ws = this.workspaceId();
    const { getHiveEpoch } = await import('../sync/hyperbee/hive-epoch-state');
    return getHiveEpoch(ws, this.deps.potSlug, this.deps.sqlOverride);
  }
}

/** Convenience: the roster for the current tier-1 rollout (no directory). */
export function getScopeRoster(deps: ScopeRosterDeps): ScopeRoster {
  return new GrantBackedScopeRoster(deps);
}
