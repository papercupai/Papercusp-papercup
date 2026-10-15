/**
 * Governance delegation authority (P-006, plan papercusp-enterprise-readiness-roadmap-2026-10-09, D-015).
 *
 * WHO may change governance policy, and WHERE. Authority is an expiring, revoke-only DELEGATION on
 * a policy-layer subtree (harness_shared.governance_delegations, migration 1498). A delegation on a
 * layer covers that layer and every layer beneath it, so a department administrator holds authority
 * over its own department and the workspaces under it, and nothing above or beside it.
 *
 * Capabilities:
 *   - prepare:  write a workspace layer directly, or prepare a sensitive change for approval;
 *   - approve:  approve a sensitive change someone ELSE prepared;
 *   - delegate: grant a subset of one's own authority, never outliving it.
 *
 * Principal kind comes from the authenticated door, never from input: `admin:*` (the loopback admin
 * pane) and `user:*` are human administrators. Every other principal (an agent session id, `role:*`,
 * `service:*`) is a SERVICE identity and may hold only `prepare`, so an agent can never approve or
 * delegate. The database enforces the same rule (governance_delegations_service_prepare_only_ck).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { MAX_CHAIN_DEPTH, upsertLayerInTx, type StoredPolicyLayer, type UpsertLayerInput } from './store';

export const GOVERNANCE_CAPABILITIES = ['prepare', 'approve', 'delegate'] as const;
export type GovernanceCapability = (typeof GOVERNANCE_CAPABILITIES)[number];
export type PrincipalKind = 'human' | 'service';

/** Longest any delegation may live: authority is always short-lived and re-granted. */
export const MAX_DELEGATION_MS = 90 * 24 * 60 * 60_000;
/** The grantor recorded on the root delegation of a newly created organization layer. */
export const BOOTSTRAP_GRANTOR = 'bootstrap';

const HUMAN_PRINCIPAL = /^(admin|user):\S/;

export function principalKindOf(principal: string): PrincipalKind {
  return HUMAN_PRINCIPAL.test(principal) ? 'human' : 'service';
}

/** The capabilities a principal of this kind may ever hold. */
export function capabilitiesAllowedFor(kind: PrincipalKind): readonly GovernanceCapability[] {
  return kind === 'human' ? GOVERNANCE_CAPABILITIES : ['prepare'];
}

export function isGovernanceCapability(value: unknown): value is GovernanceCapability {
  return typeof value === 'string' && (GOVERNANCE_CAPABILITIES as readonly string[]).includes(value);
}

export interface GovernanceDelegation {
  delegationId: string;
  principal: string;
  principalKind: PrincipalKind;
  layerId: string;
  capabilities: GovernanceCapability[];
  grantedBy: string;
  reason: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revocationReason: string | null;
}

export type GovernanceAuthorityErrorCode = 'invalid' | 'forbidden' | 'not-found';

export class GovernanceAuthorityError extends Error {
  constructor(
    readonly code: GovernanceAuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GovernanceAuthorityError';
  }
}

function sqlOf(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

interface RawDelegationRow {
  delegation_id: string;
  principal: string;
  principal_kind: string;
  layer_id: string;
  capabilities: string[];
  granted_by: string;
  reason: string;
  granted_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  revoked_by: string | null;
  revocation_reason: string | null;
}

const DELEGATION_COLUMNS =
  'delegation_id, principal, principal_kind, layer_id, capabilities, granted_by, reason, granted_at, expires_at, revoked_at, revoked_by, revocation_reason';

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function delegationOf(row: RawDelegationRow): GovernanceDelegation {
  return {
    delegationId: row.delegation_id,
    principal: row.principal,
    principalKind: row.principal_kind === 'human' ? 'human' : 'service',
    layerId: row.layer_id,
    capabilities: row.capabilities.filter(isGovernanceCapability),
    grantedBy: row.granted_by,
    reason: row.reason,
    grantedAt: iso(row.granted_at),
    expiresAt: iso(row.expires_at),
    revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
    revokedBy: row.revoked_by,
    revocationReason: row.revocation_reason,
  };
}

/** The layer and its ancestors, nearest first ([] when the layer does not exist). */
export async function layerAncestry(layerId: string, sql?: Sql): Promise<string[]> {
  const rows = await sqlOf(sql)<Array<{ layer_id: string }>>`
    WITH RECURSIVE up AS (
      SELECT layer_id, parent_layer_id, 1 AS depth
        FROM harness_shared.governance_policy_layers WHERE layer_id = ${layerId}
      UNION ALL
      SELECT p.layer_id, p.parent_layer_id, u.depth + 1
        FROM up u JOIN harness_shared.governance_policy_layers p ON p.layer_id = u.parent_layer_id
       WHERE u.depth < ${MAX_CHAIN_DEPTH}
    )
    SELECT layer_id FROM up ORDER BY depth
  `;
  return rows.map((r) => r.layer_id);
}

/**
 * Live (unrevoked, unexpired) delegations `principal` holds on `layerId` or any ancestor, with each
 * capability list cut to what the principal's kind may hold (a belt to the database's braces).
 */
export async function coveringDelegations(
  principal: string,
  layerId: string,
  opts: { now?: Date; sql?: Sql } = {},
): Promise<GovernanceDelegation[]> {
  const now = opts.now ?? new Date();
  const ancestry = await layerAncestry(layerId, opts.sql);
  if (ancestry.length === 0) return [];
  const db = sqlOf(opts.sql);
  const rows = await db<RawDelegationRow[]>`
    SELECT ${db.unsafe(DELEGATION_COLUMNS)} FROM harness_shared.governance_delegations
     WHERE principal = ${principal}
       AND layer_id = ANY(${ancestry}::text[])
       AND revoked_at IS NULL
       AND expires_at > ${now}
     ORDER BY expires_at DESC
  `;
  const allowed = capabilitiesAllowedFor(principalKindOf(principal));
  return rows
    .map(delegationOf)
    .map((d) => ({ ...d, capabilities: d.capabilities.filter((c) => allowed.includes(c)) }))
    .filter((d) => d.capabilities.length > 0);
}

/** Does `principal` hold `capability` over `layerId` right now? */
export async function authorize(
  principal: string,
  layerId: string,
  capability: GovernanceCapability,
  opts: { now?: Date; sql?: Sql } = {},
): Promise<boolean> {
  if (typeof principal !== 'string' || !principal.trim()) return false;
  const delegations = await coveringDelegations(principal, layerId, opts);
  return delegations.some((d) => d.capabilities.includes(capability));
}

/** Latest expiry among delegations granting `capability` (null when none does). */
function latestExpiry(delegations: readonly GovernanceDelegation[], capability: GovernanceCapability): number | null {
  let best: number | null = null;
  for (const d of delegations) {
    if (!d.capabilities.includes(capability)) continue;
    const at = Date.parse(d.expiresAt);
    if (best === null || at > best) best = at;
  }
  return best;
}

export interface GrantDelegationInput {
  grantor: string;
  principal: string;
  layerId: string;
  capabilities: readonly string[];
  reason: string;
  expiresAt: string | Date;
  now?: Date;
}

/**
 * Grant `principal` authority over `layerId`'s subtree. The grantor must hold `delegate` there and
 * every granted capability; the grant can never outlive the grantor's own authority, never exceed
 * MAX_DELEGATION_MS, never go to the grantor itself, and never give a service identity more than
 * `prepare`.
 */
export async function grantDelegation(input: GrantDelegationInput, sql?: Sql): Promise<GovernanceDelegation> {
  const now = input.now ?? new Date();
  const principal = typeof input.principal === 'string' ? input.principal.trim() : '';
  const grantor = typeof input.grantor === 'string' ? input.grantor.trim() : '';
  if (!principal) throw new GovernanceAuthorityError('invalid', 'principal is required');
  if (!grantor) throw new GovernanceAuthorityError('invalid', 'grantor is required');
  if (typeof input.reason !== 'string' || !input.reason.trim()) {
    throw new GovernanceAuthorityError('invalid', 'reason is required (it is the delegation evidence)');
  }
  if (principal === grantor) throw new GovernanceAuthorityError('forbidden', 'a principal cannot grant authority to itself');
  const requested = [...new Set(input.capabilities)];
  if (requested.length === 0 || !requested.every(isGovernanceCapability)) {
    throw new GovernanceAuthorityError('invalid', `capabilities must be a non-empty subset of ${GOVERNANCE_CAPABILITIES.join(', ')}`);
  }
  const capabilities = requested as GovernanceCapability[];
  const kind = principalKindOf(principal);
  const beyondKind = capabilities.filter((c) => !capabilitiesAllowedFor(kind).includes(c));
  if (beyondKind.length > 0) {
    throw new GovernanceAuthorityError(
      'invalid',
      `${principal} is a service identity and may hold only prepare (refused: ${beyondKind.join(', ')})`,
    );
  }
  const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    throw new GovernanceAuthorityError('invalid', 'expiresAt must be an absolute time in the future; delegations always expire');
  }
  if (expiresAt.getTime() - now.getTime() > MAX_DELEGATION_MS) {
    throw new GovernanceAuthorityError('invalid', 'a delegation may last at most 90 days');
  }
  const db = sqlOf(sql);
  const held = await coveringDelegations(grantor, input.layerId, { now, sql: db });
  if (!held.some((d) => d.capabilities.includes('delegate'))) {
    throw new GovernanceAuthorityError('forbidden', `${grantor} holds no delegate authority over ${input.layerId}`);
  }
  let ceiling = latestExpiry(held, 'delegate') as number;
  for (const capability of capabilities) {
    const until = latestExpiry(held, capability);
    if (until === null) {
      throw new GovernanceAuthorityError('forbidden', `${grantor} cannot grant ${capability}: it does not hold it over ${input.layerId}`);
    }
    ceiling = Math.min(ceiling, until);
  }
  if (expiresAt.getTime() > ceiling) {
    throw new GovernanceAuthorityError(
      'invalid',
      `a delegation cannot outlive the grantor's authority (ends ${new Date(ceiling).toISOString()})`,
    );
  }
  const rows = await db<RawDelegationRow[]>`
    INSERT INTO harness_shared.governance_delegations
      (principal, principal_kind, layer_id, capabilities, granted_by, reason, granted_at, expires_at)
    VALUES (${principal}, ${kind}, ${input.layerId}, ${capabilities}::text[], ${grantor}, ${input.reason.trim()}, ${now}, ${expiresAt})
    RETURNING ${db.unsafe(DELEGATION_COLUMNS)}
  `;
  return delegationOf(rows[0]);
}

export interface RevokeDelegationInput {
  delegationId: string;
  revoker: string;
  reason: string;
  now?: Date;
}

/** Revoke a delegation (once). The holder itself, or anyone with delegate over its layer, may revoke. */
export async function revokeDelegation(input: RevokeDelegationInput, sql?: Sql): Promise<GovernanceDelegation> {
  const now = input.now ?? new Date();
  if (typeof input.reason !== 'string' || !input.reason.trim()) {
    throw new GovernanceAuthorityError('invalid', 'reason is required to revoke a delegation');
  }
  const db = sqlOf(sql);
  const found = await db<RawDelegationRow[]>`
    SELECT ${db.unsafe(DELEGATION_COLUMNS)} FROM harness_shared.governance_delegations
     WHERE delegation_id = ${input.delegationId}
  `;
  if (!found[0]) throw new GovernanceAuthorityError('not-found', `no delegation '${input.delegationId}'`);
  const delegation = delegationOf(found[0]);
  if (delegation.revokedAt) throw new GovernanceAuthorityError('invalid', `delegation ${input.delegationId} is already revoked`);
  const self = input.revoker === delegation.principal;
  if (!self && !(await authorize(input.revoker, delegation.layerId, 'delegate', { now, sql: db }))) {
    throw new GovernanceAuthorityError('forbidden', `${input.revoker} holds no delegate authority over ${delegation.layerId}`);
  }
  const rows = await db<RawDelegationRow[]>`
    UPDATE harness_shared.governance_delegations
       SET revoked_at = ${now}, revoked_by = ${input.revoker}, revocation_reason = ${input.reason.trim()}
     WHERE delegation_id = ${input.delegationId}
    RETURNING ${db.unsafe(DELEGATION_COLUMNS)}
  `;
  return delegationOf(rows[0]);
}

/** Delegations on the given layers (every layer when omitted), newest first. Revoked/expired kept unless activeOnly. */
export async function listDelegations(
  opts: { layerIds?: readonly string[]; activeOnly?: boolean; now?: Date; limit?: number; sql?: Sql } = {},
): Promise<GovernanceDelegation[]> {
  const db = sqlOf(opts.sql);
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const layerIds = opts.layerIds ? [...opts.layerIds] : null;
  const rows = await db<RawDelegationRow[]>`
    SELECT ${db.unsafe(DELEGATION_COLUMNS)} FROM harness_shared.governance_delegations
     WHERE (${layerIds === null} OR layer_id = ANY(${layerIds ?? []}::text[]))
       AND (${!opts.activeOnly} OR (revoked_at IS NULL AND expires_at > ${now}))
     ORDER BY granted_at DESC
     LIMIT ${limit}
  `;
  return rows.map(delegationOf);
}

/**
 * Bootstrap: record the root delegation (all capabilities, 90 days) for the HUMAN who creates a
 * brand-new organization layer, inside the caller's transaction. Refused for a service identity and
 * for an organization layer that already has any delegation, so it can never re-root an
 * administered organization.
 */
export async function recordBootstrapDelegation(
  tx: Sql,
  input: { principal: string; layerId: string; now?: Date },
): Promise<GovernanceDelegation> {
  const now = input.now ?? new Date();
  if (principalKindOf(input.principal) !== 'human') {
    throw new GovernanceAuthorityError('forbidden', `${input.principal} is a service identity and cannot create an organization`);
  }
  const existing = await tx<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM harness_shared.governance_delegations WHERE layer_id = ${input.layerId}
  `;
  if (Number(existing[0]?.n ?? 0) > 0) {
    throw new GovernanceAuthorityError('forbidden', `organization ${input.layerId} is already administered`);
  }
  const expiresAt = new Date(now.getTime() + MAX_DELEGATION_MS);
  const rows = await tx<RawDelegationRow[]>`
    INSERT INTO harness_shared.governance_delegations
      (principal, principal_kind, layer_id, capabilities, granted_by, reason, granted_at, expires_at)
    VALUES (${input.principal}, 'human', ${input.layerId}, ${[...GOVERNANCE_CAPABILITIES]}::text[], ${BOOTSTRAP_GRANTOR},
            ${'bootstrap: creator of a new organization policy layer'}, ${now}, ${expiresAt})
    RETURNING ${tx.unsafe(DELEGATION_COLUMNS)}
  `;
  return delegationOf(rows[0]);
}

/**
 * Create a brand-new organization layer and its creator's bootstrap delegation in ONE transaction.
 * Refused when the layer already exists: changing an existing organization is a sensitive action.
 */
export async function createOrganizationLayer(
  input: UpsertLayerInput,
  sql?: Sql,
): Promise<{ layer: StoredPolicyLayer; delegation: GovernanceDelegation }> {
  if (input.level !== 'organization') {
    throw new GovernanceAuthorityError('invalid', 'only an organization layer is created by bootstrap');
  }
  return (await sqlOf(sql).begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql;
    const existing = await tx<Array<{ layer_id: string }>>`
      SELECT layer_id FROM harness_shared.governance_policy_layers WHERE layer_id = ${input.layerId} FOR UPDATE
    `;
    if (existing.length > 0) {
      throw new GovernanceAuthorityError('forbidden', `organization ${input.layerId} already exists; changing it is a sensitive action`);
    }
    return recordBootstrapDelegationAfterLayer(tx, input);
  })) as { layer: StoredPolicyLayer; delegation: GovernanceDelegation };
}

async function recordBootstrapDelegationAfterLayer(
  tx: Sql,
  input: UpsertLayerInput,
): Promise<{ layer: StoredPolicyLayer; delegation: GovernanceDelegation }> {
  if (principalKindOf(input.actor) !== 'human') {
    throw new GovernanceAuthorityError('forbidden', `${input.actor} is a service identity and cannot create an organization`);
  }
  const layer = await upsertLayerInTx(tx, { ...input, expectedVersion: 0 });
  const delegation = await recordBootstrapDelegation(tx, { principal: input.actor, layerId: input.layerId });
  return { layer, delegation };
}
