/**
 * Hosted customer-governance core (BYOC P-088).
 *
 * This is a direct-import leaf while the hosted control plane is assembled in
 * parallel. It intentionally does not join the local auth/profile barrels.
 * Postgres owns durability and immutability; these helpers own input validation,
 * secret exclusion, and the small amount of derived support-access state.
 */
import { getOrgPg, withHostedServiceContext } from '@papercusp/db-org';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { isHostedPrincipal, type HostedPrincipal } from '../hosted-principal';
import { hostedPermissionsForMembership } from '../hosted-role-permissions';
import { workosDirectoryIdentitySubject } from './workos-lifecycle-worker';
import type { HostedServiceContextRunner } from './workos-lifecycle-postgres';

export type GovernanceJson =
  | null
  | boolean
  | number
  | string
  | GovernanceJson[]
  | { readonly [key: string]: GovernanceJson };

export type LegalDocumentKind = 'terms' | 'privacy';
export type SupportAccessState = 'pending' | 'active' | 'expired' | 'revoked';

const FORBIDDEN_GOVERNANCE_KEY =
  /(?:password|passcode|secret|token|credential|authorization|cookie|mfa|private[_-]?key|refresh[_-]?token)/i;
const FORBIDDEN_GOVERNANCE_VALUE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|gh[opusr])[_-][A-Za-z0-9_-]{16,})/i;

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`hosted-governance: ${label} must be non-empty`);
  return normalized;
}

/** Reject secret-bearing metadata instead of silently storing a partial record. */
export function assertGovernancePayloadSafe(
  value: GovernanceJson,
  path = 'payload',
): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`hosted-governance: ${path} contains a non-finite number`);
    }
    return;
  }
  if (typeof value === 'string') {
    if (FORBIDDEN_GOVERNANCE_VALUE.test(value)) {
      throw new Error(`hosted-governance: ${path} contains credential-like material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertGovernancePayloadSafe(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_GOVERNANCE_KEY.test(key)) {
      throw new Error(`hosted-governance: ${path}.${key} is a forbidden governance field`);
    }
    assertGovernancePayloadSafe(entry, `${path}.${key}`);
  }
}

export function normalizeHostedLocale(locale: string): string {
  const normalized = nonEmpty(locale, 'locale').replaceAll('_', '-');
  try {
    return new Intl.Locale(normalized).toString();
  } catch {
    throw new Error(`hosted-governance: invalid locale ${JSON.stringify(locale)}`);
  }
}

export function normalizeHostedTimeZone(timeZone: string): string {
  const normalized = nonEmpty(timeZone, 'timeZone');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: normalized }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`hosted-governance: invalid timeZone ${JSON.stringify(timeZone)}`);
  }
}

export interface SupportAccessWindow {
  startsAt: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  bannerMessage: string;
}

export function supportAccessState(
  grant: SupportAccessWindow,
  now = new Date(),
): SupportAccessState {
  if (grant.revokedAt) return 'revoked';
  if (now < grant.startsAt) return 'pending';
  if (now >= grant.expiresAt) return 'expired';
  return 'active';
}

export function activeSupportAccessBanner(
  grant: SupportAccessWindow,
  now = new Date(),
): string | null {
  return supportAccessState(grant, now) === 'active'
    ? nonEmpty(grant.bannerMessage, 'bannerMessage')
    : null;
}

export interface CreateSupportAccessGrantInput {
  organizationId: string;
  workspaceId?: string | null;
  staffPrincipalId: string;
  grantedByUserId: string;
  purpose: string;
  scopes: readonly string[];
  bannerMessage: string;
  startsAt?: Date;
  expiresAt: Date;
}

export function validateSupportAccessGrant(
  input: CreateSupportAccessGrantInput,
): Omit<CreateSupportAccessGrantInput, 'workspaceId' | 'startsAt' | 'scopes'> & {
  workspaceId: string | null;
  startsAt: Date;
  scopes: string[];
} {
  const startsAt = input.startsAt ?? new Date();
  if (!(startsAt instanceof Date) || Number.isNaN(startsAt.valueOf())) {
    throw new Error('hosted-governance: startsAt must be a valid date');
  }
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.valueOf())) {
    throw new Error('hosted-governance: expiresAt must be a valid date');
  }
  if (input.expiresAt <= startsAt) {
    throw new Error('hosted-governance: support access must expire after it starts');
  }

  const scopes = [...new Set(input.scopes.map((scope) => nonEmpty(scope, 'scope')))];
  if (!scopes.length) throw new Error('hosted-governance: at least one scope is required');
  if (scopes.some((scope) => scope === '*' || scope.includes('*'))) {
    throw new Error('hosted-governance: wildcard support access is forbidden');
  }

  return {
    ...input,
    organizationId: nonEmpty(input.organizationId, 'organizationId'),
    workspaceId: input.workspaceId ? nonEmpty(input.workspaceId, 'workspaceId') : null,
    staffPrincipalId: nonEmpty(input.staffPrincipalId, 'staffPrincipalId'),
    grantedByUserId: nonEmpty(input.grantedByUserId, 'grantedByUserId'),
    purpose: nonEmpty(input.purpose, 'purpose'),
    bannerMessage: nonEmpty(input.bannerMessage, 'bannerMessage'),
    startsAt,
    scopes,
  };
}

export interface LegalAcceptanceInput {
  organizationId: string;
  userId: string;
  documentKind: LegalDocumentKind;
  documentVersion: string;
  acceptanceSource: 'hosted_ui' | 'api' | 'administrative';
  evidence?: Record<string, GovernanceJson>;
  acceptedAt?: Date;
}

export async function recordLegalAcceptance(input: LegalAcceptanceInput): Promise<{
  id: string;
  acceptedAt: Date;
  inserted: boolean;
}> {
  const organizationId = nonEmpty(input.organizationId, 'organizationId');
  const userId = nonEmpty(input.userId, 'userId');
  const documentVersion = nonEmpty(input.documentVersion, 'documentVersion');
  const evidence = input.evidence ?? {};
  assertGovernancePayloadSafe(evidence);
  const acceptedAt = input.acceptedAt ?? new Date();
  const { sql } = getOrgPg();

  const inserted = await sql<{ id: string; accepted_at: Date }[]>`
    INSERT INTO papercusp_auth.legal_acceptances (
      organization_id, user_id, document_kind, document_version,
      acceptance_source, evidence, accepted_at
    ) VALUES (
      ${organizationId}::uuid, ${userId}::uuid, ${input.documentKind},
      ${documentVersion}, ${input.acceptanceSource},
      ${JSON.stringify(evidence)}::text::jsonb, ${acceptedAt}
    )
    ON CONFLICT (organization_id, user_id, document_kind, document_version)
      DO NOTHING
    RETURNING id, accepted_at`;
  if (inserted[0]) return { id: inserted[0].id, acceptedAt: inserted[0].accepted_at, inserted: true };

  const existing = await sql<{ id: string; accepted_at: Date }[]>`
    SELECT id, accepted_at
      FROM papercusp_auth.legal_acceptances
     WHERE organization_id = ${organizationId}::uuid
       AND user_id = ${userId}::uuid
       AND document_kind = ${input.documentKind}
       AND document_version = ${documentVersion}`;
  if (!existing[0]) throw new Error('hosted-governance: legal acceptance dedupe row disappeared');
  return { id: existing[0].id, acceptedAt: existing[0].accepted_at, inserted: false };
}

export interface OrganizationAuditEventInput {
  organizationId: string;
  workspaceId?: string | null;
  actorKind: 'customer_user' | 'staff_admin' | 'system';
  actorId?: string | null;
  action: string;
  purpose: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, GovernanceJson>;
  occurredAt?: Date;
}

export async function appendOrganizationAuditEvent(
  input: OrganizationAuditEventInput,
  transaction?: Sql,
): Promise<string> {
  const metadata = input.metadata ?? {};
  assertGovernancePayloadSafe(metadata);
  const sql = transaction ?? getOrgPg().sql;
  const id = randomUUID();
  // Generate the key before INSERT so an append-only writer needs no SELECT
  // privilege (PostgreSQL RETURNING would require it even for just the id).
  await sql`
    INSERT INTO papercusp_auth.organization_audit_events (
      id, organization_id, workspace_id, actor_kind, actor_id, action, purpose,
      target_type, target_id, metadata, occurred_at
    ) VALUES (
      ${id}::uuid,
      ${nonEmpty(input.organizationId, 'organizationId')}::uuid,
      ${input.workspaceId ?? null}::uuid,
      ${input.actorKind}, ${input.actorId ?? null},
      ${nonEmpty(input.action, 'action')}, ${nonEmpty(input.purpose, 'purpose')},
      ${input.targetType ?? null}, ${input.targetId ?? null},
      ${JSON.stringify(metadata)}::text::jsonb, COALESCE(${input.occurredAt ?? null}::timestamptz, now())
    )`;
  return id;
}

export async function createSupportAccessGrant(
  rawInput: CreateSupportAccessGrantInput,
): Promise<string> {
  const input = validateSupportAccessGrant(rawInput);
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO papercusp_auth.support_access_grants (
      organization_id, workspace_id, staff_principal_id, granted_by_user_id,
      purpose, scopes, banner_message, starts_at, expires_at
    ) VALUES (
      ${input.organizationId}::uuid, ${input.workspaceId}::uuid,
      ${input.staffPrincipalId}, ${input.grantedByUserId}::uuid,
      ${input.purpose}, ${input.scopes}, ${input.bannerMessage},
      ${input.startsAt}, ${input.expiresAt}
    )
    RETURNING id`;
  return rows[0].id;
}

export async function revokeSupportAccessGrant(input: {
  organizationId: string;
  grantId: string;
  revokedByUserId: string;
  reason: string;
  revokedAt?: Date;
}): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string }[]>`
    UPDATE papercusp_auth.support_access_grants
       SET revoked_at = ${input.revokedAt ?? new Date()},
           revoked_by_user_id = ${nonEmpty(input.revokedByUserId, 'revokedByUserId')}::uuid,
           revocation_reason = ${nonEmpty(input.reason, 'reason')},
           updated_at = now()
     WHERE id = ${nonEmpty(input.grantId, 'grantId')}::uuid
       AND organization_id = ${nonEmpty(input.organizationId, 'organizationId')}::uuid
       AND revoked_at IS NULL
    RETURNING id`;
  return rows.length === 1;
}

export interface HostedUserPreferencesInput {
  organizationId: string;
  userId: string;
  locale: string;
  timeZone: string;
  profile?: Record<string, GovernanceJson>;
  notifications?: Record<string, GovernanceJson>;
}

export async function saveHostedUserPreferences(
  input: HostedUserPreferencesInput,
  transaction?: Sql,
): Promise<void> {
  const profile = input.profile ?? {};
  const notifications = input.notifications ?? {};
  assertGovernancePayloadSafe(profile, 'profile');
  assertGovernancePayloadSafe(notifications, 'notifications');
  const sql = transaction ?? getOrgPg().sql;
  await sql`
    INSERT INTO papercusp_auth.hosted_user_preferences (
      organization_id, user_id, locale, time_zone, profile,
      notification_preferences, updated_at
    ) VALUES (
      ${nonEmpty(input.organizationId, 'organizationId')}::uuid,
      ${nonEmpty(input.userId, 'userId')}::uuid,
      ${normalizeHostedLocale(input.locale)}, ${normalizeHostedTimeZone(input.timeZone)},
      ${JSON.stringify(profile)}::text::jsonb, ${JSON.stringify(notifications)}::text::jsonb, now()
    )
    ON CONFLICT (organization_id, user_id) DO UPDATE
      SET locale = EXCLUDED.locale,
          time_zone = EXCLUDED.time_zone,
          profile = papercusp_auth.hosted_user_preferences.profile || EXCLUDED.profile,
          notification_preferences = EXCLUDED.notification_preferences,
          updated_at = now()`;
}

export interface DirectoryBindingInput {
  organizationId: string;
  userId: string;
  externalOrganizationId: string;
  directoryId: string;
  directoryUserId: string;
  authorizedGroupIds: readonly string[];
  purpose: string;
}

export interface DirectoryBindingResult {
  identityId: string;
  subject: string;
  authorizedGroupIds: string[];
  status: 'active' | 'deactivated';
  auditId: string;
}

export interface DirectoryAccessReviewInput {
  organizationId: string;
  purpose: string;
}

export interface DirectoryAccessReview {
  organizationId: string;
  generatedAt: string;
  scope: 'local-memberships-and-directory-bindings';
  memberLimit: number;
  directoryIdentityLimitPerMember: number;
  members: Array<{
    membershipId: string;
    userId: string;
    role: string;
    membershipStatus: string;
    userStatus: string;
    effectivePermissions: string[];
    directoryBindings: Array<{
      identityId: string;
      directoryId: string;
      directoryUserId: string;
      status: string;
      authorizedGroupIds: string[];
    }>;
  }>;
  auditId: string;
}

const ACCESS_REVIEW_MEMBER_LIMIT = 1000;
const ACCESS_REVIEW_IDENTITY_LIMIT = 100;

export interface MembershipReductionInput {
  organizationId: string;
  userId: string;
  status: 'suspended' | 'revoked';
  purpose: string;
}

export interface MembershipReduction {
  membershipId: string;
  status: 'suspended' | 'revoked';
  changed: boolean;
  auditId: string;
}

export function validateDirectoryBinding(input: DirectoryBindingInput): DirectoryBindingInput & { authorizedGroupIds: string[] } {
  const identifier = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new TypeError(`directory_binding_invalid:${field}`);
    return value.trim();
  };
  if (!Array.isArray(input.authorizedGroupIds) || input.authorizedGroupIds.length > 100) throw new TypeError('directory_binding_invalid:authorizedGroupIds');
  const normalized = {
    organizationId: identifier(input.organizationId, 'organizationId'), userId: identifier(input.userId, 'userId'),
    externalOrganizationId: identifier(input.externalOrganizationId, 'externalOrganizationId'),
    directoryId: identifier(input.directoryId, 'directoryId'), directoryUserId: identifier(input.directoryUserId, 'directoryUserId'),
    authorizedGroupIds: [...new Set(input.authorizedGroupIds.map((id) => identifier(id, 'groupId')))].sort(),
    purpose: identifier(input.purpose, 'purpose'),
  };
  assertGovernancePayloadSafe(normalized);
  return normalized;
}

export type DirectoryMappedRole = 'admin' | 'member' | 'billing';

export interface DirectoryGroupMappingInput {
  organizationId: string;
  directoryId: string;
  groupId: string;
  role: DirectoryMappedRole;
  purpose: string;
}

export interface DirectoryGroupMappingResult {
  mappingId: string;
  directoryId: string;
  groupId: string;
  role: DirectoryMappedRole;
  status: 'active' | 'removed';
  revokedMembershipIds: string[];
  auditId: string;
}

export interface DirectoryProvisionInput {
  organizationId: string;
  userId: string;
  directoryId: string;
  directoryUserId: string;
  purpose: string;
}

export interface DirectoryProvisionResult {
  membershipId: string;
  role: DirectoryMappedRole;
  identityId: string;
  mappedGroupIds: string[];
  auditId: string;
}

/** Deterministic resolution when a user sits in several mapped groups. */
export const DIRECTORY_ROLE_PRECEDENCE: readonly DirectoryMappedRole[] = ['admin', 'member', 'billing'];
const DIRECTORY_CONVERGENCE_LIMIT = 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveDirectoryRole(roles: readonly DirectoryMappedRole[]): DirectoryMappedRole {
  const resolved = DIRECTORY_ROLE_PRECEDENCE.find((role) => roles.includes(role));
  if (!resolved) throw new Error('directory_provision_no_mapped_group');
  return resolved;
}

function directoryText(value: unknown, field: string, prefix: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new TypeError(`${prefix}_invalid:${field}`);
  return value.trim();
}

function directoryUuid(value: unknown, field: string, prefix: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError(`${prefix}_invalid:${field}`);
  return value.toLowerCase();
}

export function validateDirectoryGroupMapping(
  raw: Partial<DirectoryGroupMappingInput>,
  requireRole: boolean,
): Omit<DirectoryGroupMappingInput, 'role'> & { role?: DirectoryMappedRole } {
  const prefix = 'directory_group_mapping';
  if (requireRole && !DIRECTORY_ROLE_PRECEDENCE.includes(raw.role as DirectoryMappedRole)) {
    // 'owner' lands here too: no directory group can ever confer ownership.
    throw new TypeError(`${prefix}_invalid:role`);
  }
  const normalized = {
    organizationId: directoryUuid(raw.organizationId, 'organizationId', prefix),
    directoryId: directoryText(raw.directoryId, 'directoryId', prefix),
    groupId: directoryText(raw.groupId, 'groupId', prefix),
    purpose: directoryText(raw.purpose, 'purpose', prefix),
    ...(requireRole ? { role: raw.role as DirectoryMappedRole } : {}),
  };
  assertGovernancePayloadSafe(normalized);
  return normalized;
}

export function validateDirectoryProvision(raw: Partial<DirectoryProvisionInput>): DirectoryProvisionInput {
  const prefix = 'directory_provision';
  const normalized = {
    organizationId: directoryUuid(raw.organizationId, 'organizationId', prefix),
    userId: directoryUuid(raw.userId, 'userId', prefix),
    directoryId: directoryText(raw.directoryId, 'directoryId', prefix),
    directoryUserId: directoryText(raw.directoryUserId, 'directoryUserId', prefix),
    purpose: directoryText(raw.purpose, 'purpose', prefix),
  };
  assertGovernancePayloadSafe(normalized);
  return normalized;
}

/** Re-resolve administrator authority inside the write transaction; a
 * previously resolved cookie is not durable authority. */
async function lockDirectoryAdministrator(
  sql: Sql,
  principal: HostedPrincipal,
  organizationId: string,
  prefix: string,
): Promise<{ role: string; externalOrganizationId: string }> {
  if (!isHostedPrincipal(principal) || principal.activeOrganizationId !== organizationId || !principal.permissions.has('members:manage')) {
    throw new Error(`${prefix}_forbidden`);
  }
  const organizations = await sql<{ external_organization_id: string }[]>`
    SELECT external_organization_id FROM papercusp_auth.organizations
     WHERE id = ${organizationId}::uuid AND identity_provider = 'workos' AND status = 'active' FOR SHARE`;
  if (!organizations[0]) throw new Error(`${prefix}_organization_not_found`);
  const actors = await sql<{ role: string; status: string }[]>`
    SELECT membership.role, membership.status FROM papercusp_auth.organization_memberships AS membership
    JOIN papercusp_auth.hosted_users AS actor ON actor.id = membership.user_id
     WHERE membership.organization_id = ${organizationId}::uuid AND membership.user_id = ${principal.userId}::uuid
       AND actor.status = 'active' FOR SHARE OF membership, actor`;
  if (!actors[0] || !hostedPermissionsForMembership(actors[0]).has('members:manage')) throw new Error(`${prefix}_forbidden`);
  return { role: actors[0].role, externalOrganizationId: organizations[0].external_organization_id };
}

/** Revocation convergence for directory-provisioned grants touching one group.
 * A grant keeps only groups that still have an active mapping; it is revoked
 * (with this organization's sessions closed) when none remain or when its role
 * now exceeds what those groups justify. Never elevates. Bounded and atomic:
 * an overflow refuses the whole change instead of half-converging. */
async function convergeDirectoryProvisioning(sql: Sql, organizationId: string, directoryId: string, groupId: string): Promise<string[]> {
  const rows = await sql<Array<{ id: string; user_id: string; profile: Record<string, GovernanceJson>;
    membership_id: string; role: string; status: string }>>`
    SELECT identity.id::text, identity.hosted_user_id::text AS user_id, identity.profile,
      membership.id::text AS membership_id, membership.role, membership.status
    FROM papercusp_auth.external_identities AS identity
    JOIN papercusp_auth.organization_memberships AS membership
      ON membership.id::text = identity.profile -> 'directory_provisioning' ->> 'membershipId'
     AND membership.organization_id = ${organizationId}::uuid AND membership.user_id = identity.hosted_user_id
    WHERE identity.provider = 'workos-dsync'
      AND identity.profile -> 'directory_provisioning' ->> 'organizationId' = ${organizationId}
      AND identity.profile -> 'directory_provisioning' ->> 'directoryId' = ${directoryId}
      AND jsonb_typeof(identity.profile -> 'directory_provisioning' -> 'mappedGroups') = 'array'
      AND (identity.profile -> 'directory_provisioning' -> 'mappedGroups') ? ${groupId}
    ORDER BY identity.id LIMIT ${DIRECTORY_CONVERGENCE_LIMIT + 1}
    FOR UPDATE OF identity, membership`;
  if (rows.length > DIRECTORY_CONVERGENCE_LIMIT) throw new Error('directory_group_mapping_convergence_limit');
  if (!rows.length) return [];
  const active = new Map((await sql<{ group_id: string; role: DirectoryMappedRole }[]>`
    SELECT group_id, role FROM papercusp_auth.directory_group_role_mappings
     WHERE organization_id = ${organizationId}::uuid AND directory_id = ${directoryId} AND status = 'active'`)
    .map((row) => [row.group_id, row.role] as const));
  const revoked: string[] = [];
  for (const row of rows) {
    const provisioning = row.profile.directory_provisioning as Record<string, GovernanceJson>;
    const mapped = (provisioning.mappedGroups as GovernanceJson[]).filter((value): value is string => typeof value === 'string');
    const remaining = mapped.filter((group) => active.has(group));
    const dropped = new Set(mapped.filter((group) => !active.has(group)));
    const resolvedRank = remaining.length
      ? DIRECTORY_ROLE_PRECEDENCE.indexOf(resolveDirectoryRole(remaining.map((group) => active.get(group)!))) : -1;
    const heldRank = DIRECTORY_ROLE_PRECEDENCE.indexOf(row.role as DirectoryMappedRole);
    const revoke = !remaining.length || heldRank < 0 || heldRank < resolvedRank;
    const authorized = Array.isArray(row.profile.authorized_directory_groups)
      ? row.profile.authorized_directory_groups.filter((value): value is string => typeof value === 'string') : [];
    const profile = { ...row.profile, authorized_directory_groups: authorized.filter((group) => !dropped.has(group)),
      directory_provisioning: { ...provisioning, mappedGroups: remaining } };
    await sql`UPDATE papercusp_auth.external_identities SET profile = ${JSON.stringify(profile)}::text::jsonb, updated_at = now()
      WHERE id = ${row.id}::uuid`;
    if (!revoke || row.status === 'revoked') continue;
    await sql`UPDATE papercusp_auth.organization_memberships
      SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), updated_at = now()
      WHERE id = ${row.membership_id}::uuid AND organization_id = ${organizationId}::uuid`;
    await sql`UPDATE papercusp_auth.hosted_sessions
      SET revoked_at = now(), revocation_reason = 'directory_group_mapping_changed', updated_at = now()
      WHERE user_id = ${row.user_id} AND organization_id = ${organizationId} AND revoked_at IS NULL`;
    revoked.push(row.membership_id);
  }
  return revoked;
}

/** References describe revocation authority only. They never grant a role,
 * link an email, or reactivate a removed identity or membership. */
export class HostedDirectoryBindingManager {
  constructor(private readonly run: HostedServiceContextRunner = withHostedServiceContext) {}

  /** Delegated administration reuses the service role's reduction-only grant.
   * No actor may remove an owner or itself; admins may only manage lower roles.
   * Locks keep permission checks, reduction, session closure and audit atomic. */
  async reduceMembership(principal: HostedPrincipal, raw: MembershipReductionInput): Promise<MembershipReduction> {
    const identifier = (value: unknown, field: string) => {
      if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        throw new TypeError(`membership_reduction_invalid:${field}`);
      }
      return value.toLowerCase();
    };
    if (raw.status !== 'suspended' && raw.status !== 'revoked') throw new TypeError('membership_reduction_invalid:status');
    if (typeof raw.purpose !== 'string' || !raw.purpose.trim() || raw.purpose.length > 512) throw new TypeError('membership_reduction_invalid:purpose');
    const input = { organizationId: identifier(raw.organizationId, 'organizationId'), userId: identifier(raw.userId, 'userId'),
      status: raw.status, purpose: raw.purpose.trim() };
    assertGovernancePayloadSafe(input);
    if (!isHostedPrincipal(principal) || principal.activeOrganizationId !== input.organizationId ||
        !principal.permissions.has('members:manage') || principal.userId === input.userId) throw new Error('membership_reduction_forbidden');
    return this.run<MembershipReduction>(async (sql) => {
      const organizations = await sql`SELECT id FROM papercusp_auth.organizations
        WHERE id = ${input.organizationId}::uuid AND status = 'active' FOR SHARE`;
      if (!organizations[0]) throw new Error('membership_reduction_organization_not_found');
      const members = await sql<Array<{ id: string; user_id: string; role: string; status: string; user_status: string }>>`
        SELECT membership.id::text, membership.user_id::text, membership.role, membership.status, member.status AS user_status
        FROM papercusp_auth.organization_memberships AS membership
        JOIN papercusp_auth.hosted_users AS member ON member.id = membership.user_id
        WHERE membership.organization_id = ${input.organizationId}::uuid
          AND membership.user_id IN (${principal.userId}::uuid, ${input.userId}::uuid)
        ORDER BY membership.user_id FOR UPDATE OF membership FOR SHARE OF member`;
      const actor = members.find((row) => row.user_id === principal.userId);
      if (!actor || actor.user_status !== 'active' || !hostedPermissionsForMembership(actor).has('members:manage')) {
        throw new Error('membership_reduction_forbidden');
      }
      const target = members.find((row) => row.user_id === input.userId);
      if (!target || target.user_status === 'deleted') throw new Error('membership_reduction_member_not_found');
      if (target.role === 'owner' || (actor.role === 'admin' && !['member', 'billing'].includes(target.role))) {
        throw new Error('membership_reduction_forbidden');
      }
      if (target.status === 'revoked' && input.status === 'suspended') throw new Error('membership_reduction_restore_forbidden');
      const changed = target.status !== input.status;
      if (changed) await sql`UPDATE papercusp_auth.organization_memberships
        SET status = ${input.status},
            suspended_at = CASE WHEN ${input.status} = 'suspended' THEN COALESCE(suspended_at, now()) ELSE suspended_at END,
            revoked_at = CASE WHEN ${input.status} = 'revoked' THEN COALESCE(revoked_at, now()) ELSE revoked_at END,
            updated_at = now()
        WHERE id = ${target.id}::uuid AND organization_id = ${input.organizationId}::uuid`;
      // The same user may belong to other organizations. Close only this grant's sessions.
      await sql`UPDATE papercusp_auth.hosted_sessions
        SET revoked_at = now(), revocation_reason = ${`membership_${input.status}`}, updated_at = now()
        WHERE user_id = ${input.userId} AND organization_id = ${input.organizationId} AND revoked_at IS NULL`;
      const auditId = await appendOrganizationAuditEvent({ organizationId: input.organizationId,
        actorKind: 'customer_user', actorId: principal.userId, action: 'membership.reduce', purpose: input.purpose,
        targetType: 'organization_membership', targetId: target.id,
        metadata: { previousStatus: target.status, status: input.status, role: target.role, changed } }, sql);
      return { membershipId: target.id, status: input.status, changed, auditId };
    });
  }

  /** Local authority and approved directory references, not an IdP attestation
   * or a census of every workspace/tool grant. Never return identity profiles. */
  async review(principal: HostedPrincipal, raw: DirectoryAccessReviewInput): Promise<DirectoryAccessReview> {
    const identifier = (value: string, field: string) => {
      if (typeof value !== 'string' || !value.trim() || value.length > 512) {
        throw new TypeError(`directory_access_review_invalid:${field}`);
      }
      return value.trim();
    };
    const input = { organizationId: identifier(raw.organizationId, 'organizationId'), purpose: identifier(raw.purpose, 'purpose') };
    assertGovernancePayloadSafe(input);
    if (!isHostedPrincipal(principal) || principal.activeOrganizationId !== input.organizationId || !principal.permissions.has('members:manage')) {
      throw new Error('directory_access_review_forbidden');
    }
    return this.run<DirectoryAccessReview>(async (sql) => {
      const organizations = await sql<{ external_organization_id: string }[]>`
        SELECT external_organization_id FROM papercusp_auth.organizations
         WHERE id = ${input.organizationId}::uuid AND identity_provider = 'workos' AND status = 'active' FOR SHARE`;
      if (!organizations[0]) throw new Error('directory_access_review_organization_not_found');
      const actors = await sql<{ role: string; status: string }[]>`
        SELECT membership.role, membership.status FROM papercusp_auth.organization_memberships AS membership
        JOIN papercusp_auth.hosted_users AS actor ON actor.id = membership.user_id
         WHERE membership.organization_id = ${input.organizationId}::uuid AND membership.user_id = ${principal.userId}::uuid
           AND actor.status = 'active' FOR SHARE OF membership, actor`;
      if (!actors[0] || !hostedPermissionsForMembership(actors[0]).has('members:manage')) throw new Error('directory_access_review_forbidden');
      // One statement gives the exported population a single MVCC snapshot.
      // Read one extra row/reference to detect overflow, never silently clip it.
      const rows = await sql<Array<{
        membership_id: string; user_id: string; role: string; membership_status: string; user_status: string;
        generated_at: string;
        bindings: Array<{ id: string; subject: string; status: string; groups: unknown }>;
      }>>`
        SELECT membership.id::text AS membership_id, member.id::text AS user_id,
          membership.role, membership.status AS membership_status, member.status AS user_status,
          statement_timestamp()::text AS generated_at, COALESCE(directory.bindings, '[]'::jsonb) AS bindings
        FROM papercusp_auth.organization_memberships AS membership
        JOIN papercusp_auth.hosted_users AS member ON member.id = membership.user_id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('id', identity.id, 'subject', identity.subject,
            'status', identity.status, 'groups', identity.profile -> 'authorized_directory_groups') ORDER BY identity.id) AS bindings
          FROM (SELECT id, subject, status, profile FROM papercusp_auth.external_identities
            WHERE hosted_user_id = member.id AND provider = 'workos-dsync'
            ORDER BY id LIMIT ${ACCESS_REVIEW_IDENTITY_LIMIT + 1}) AS identity
        ) AS directory ON true
        WHERE membership.organization_id = ${input.organizationId}::uuid
        ORDER BY membership.id LIMIT ${ACCESS_REVIEW_MEMBER_LIMIT + 1}`;
      if (rows.length > ACCESS_REVIEW_MEMBER_LIMIT) throw new Error('directory_access_review_member_limit');
      const externalOrganizationId = organizations[0].external_organization_id;
      const members: DirectoryAccessReview['members'] = rows.map((row) => {
        if (row.bindings.length > ACCESS_REVIEW_IDENTITY_LIMIT) throw new Error('directory_access_review_identity_limit');
        const directoryBindings = row.bindings.flatMap((binding) => {
          let coordinates: unknown;
          try { coordinates = JSON.parse(binding.subject); } catch { throw new Error('directory_access_review_invalid_binding'); }
          if (!Array.isArray(coordinates) || coordinates.length !== 3 || coordinates.some(value => typeof value !== 'string' || !value.trim() || value.length > 512)
            || workosDirectoryIdentitySubject(coordinates[0], coordinates[1], coordinates[2]) !== binding.subject) {
            throw new Error('directory_access_review_invalid_binding');
          }
          // A person may belong to several organizations; their foreign
          // directory references must not cross this export's tenant boundary.
          if (coordinates[0] !== externalOrganizationId) return [];
          const groups = binding.groups ?? [];
          if (!Array.isArray(groups) || groups.length > 100 || groups.some(value => typeof value !== 'string' || !value.trim() || value.length > 512)) {
            throw new Error('directory_access_review_invalid_binding');
          }
          return [{ identityId: binding.id, directoryId: coordinates[1], directoryUserId: coordinates[2],
            status: binding.status, authorizedGroupIds: [...new Set(groups.map(value => value.trim()))].sort() }];
        });
        return { membershipId: row.membership_id, userId: row.user_id, role: row.role,
          membershipStatus: row.membership_status, userStatus: row.user_status,
          effectivePermissions: row.user_status === 'active'
            ? [...hostedPermissionsForMembership({ role: row.role, status: row.membership_status })].sort() : [], directoryBindings };
      });
      assertGovernancePayloadSafe(members as unknown as GovernanceJson);
      const generatedAt = new Date(rows[0].generated_at).toISOString();
      const auditId = await appendOrganizationAuditEvent({ organizationId: input.organizationId,
        actorKind: 'customer_user', actorId: principal.userId, action: 'directory_access_review.exported', purpose: input.purpose,
        targetType: 'organization', targetId: input.organizationId,
        metadata: { memberCount: members.length, memberLimit: ACCESS_REVIEW_MEMBER_LIMIT,
          directoryIdentityLimitPerMember: ACCESS_REVIEW_IDENTITY_LIMIT, generatedAt, scope: 'local-memberships-and-directory-bindings' },
      }, sql);
      return { organizationId: input.organizationId, generatedAt, scope: 'local-memberships-and-directory-bindings',
        memberLimit: ACCESS_REVIEW_MEMBER_LIMIT, directoryIdentityLimitPerMember: ACCESS_REVIEW_IDENTITY_LIMIT, members, auditId };
    });
  }

  /** Owner/admin approval that one directory group may be provisioned with one
   * non-owner role. Owners may approve admin; admins only member|billing. A
   * role change converges existing directory-provisioned grants downward only:
   * a member now holding more authority than its mapped groups justify is
   * revoked (never silently elevated). */
  async setGroupMapping(principal: HostedPrincipal, raw: DirectoryGroupMappingInput): Promise<DirectoryGroupMappingResult> {
    const input = validateDirectoryGroupMapping(raw, true) as DirectoryGroupMappingInput;
    return this.run<DirectoryGroupMappingResult>(async (sql) => {
      const { role: actorRole } = await lockDirectoryAdministrator(sql, principal, input.organizationId, 'directory_group_mapping');
      if (input.role === 'admin' && actorRole !== 'owner') throw new Error('directory_group_mapping_forbidden_role');
      const existing = await sql<{ id: string; role: DirectoryMappedRole; status: string }[]>`
        SELECT id::text, role, status FROM papercusp_auth.directory_group_role_mappings
         WHERE organization_id = ${input.organizationId}::uuid AND directory_id = ${input.directoryId}
           AND group_id = ${input.groupId} FOR UPDATE`;
      if (existing[0]?.status === 'active' && existing[0].role === 'admin' && actorRole !== 'owner') {
        throw new Error('directory_group_mapping_forbidden_role');
      }
      const rows = await sql<{ id: string }[]>`
        INSERT INTO papercusp_auth.directory_group_role_mappings
          (organization_id, directory_id, group_id, role, approved_by_user_id)
        VALUES (${input.organizationId}::uuid, ${input.directoryId}, ${input.groupId}, ${input.role}, ${principal.userId}::uuid)
        ON CONFLICT (organization_id, directory_id, group_id) DO UPDATE
          SET role = EXCLUDED.role, status = 'active', approved_by_user_id = EXCLUDED.approved_by_user_id,
              approved_at = now(), removed_by_user_id = NULL, removed_at = NULL, updated_at = now()
        RETURNING id::text`;
      const revokedMembershipIds = await convergeDirectoryProvisioning(sql, input.organizationId, input.directoryId, input.groupId);
      const auditId = await appendOrganizationAuditEvent({ organizationId: input.organizationId,
        actorKind: 'customer_user', actorId: principal.userId, action: 'directory_group_mapping.set', purpose: input.purpose,
        targetType: 'directory_group_role_mapping', targetId: rows[0].id,
        metadata: { directoryId: input.directoryId, groupId: input.groupId, role: input.role,
          previousRole: existing[0]?.role ?? null, previousStatus: existing[0]?.status ?? null, revokedMembershipIds } }, sql);
      return { mappingId: rows[0].id, directoryId: input.directoryId, groupId: input.groupId, role: input.role,
        status: 'active', revokedMembershipIds, auditId };
    });
  }

  /** Withdraw an approval. Every directory-provisioned membership that no longer
   * has an active mapped group is revoked and its organization sessions closed
   * in the same transaction, so closure does not wait on a webhook. */
  async removeGroupMapping(principal: HostedPrincipal, raw: Omit<DirectoryGroupMappingInput, 'role'>): Promise<DirectoryGroupMappingResult> {
    const input = validateDirectoryGroupMapping(raw, false);
    return this.run<DirectoryGroupMappingResult>(async (sql) => {
      const { role: actorRole } = await lockDirectoryAdministrator(sql, principal, input.organizationId, 'directory_group_mapping');
      const existing = await sql<{ id: string; role: DirectoryMappedRole; status: string }[]>`
        SELECT id::text, role, status FROM papercusp_auth.directory_group_role_mappings
         WHERE organization_id = ${input.organizationId}::uuid AND directory_id = ${input.directoryId}
           AND group_id = ${input.groupId} FOR UPDATE`;
      const mapping = existing[0];
      if (!mapping || mapping.status !== 'active') throw new Error('directory_group_mapping_not_found');
      if (mapping.role === 'admin' && actorRole !== 'owner') throw new Error('directory_group_mapping_forbidden_role');
      await sql`UPDATE papercusp_auth.directory_group_role_mappings
        SET status = 'removed', removed_by_user_id = ${principal.userId}::uuid, removed_at = now(), updated_at = now()
        WHERE id = ${mapping.id}::uuid`;
      const revokedMembershipIds = await convergeDirectoryProvisioning(sql, input.organizationId, input.directoryId, input.groupId);
      const auditId = await appendOrganizationAuditEvent({ organizationId: input.organizationId,
        actorKind: 'customer_user', actorId: principal.userId, action: 'directory_group_mapping.removed', purpose: input.purpose,
        targetType: 'directory_group_role_mapping', targetId: mapping.id,
        metadata: { directoryId: input.directoryId, groupId: input.groupId, role: mapping.role, revokedMembershipIds } }, sql);
      return { mappingId: mapping.id, directoryId: input.directoryId, groupId: input.groupId, role: mapping.role,
        status: 'removed', revokedMembershipIds, auditId };
    });
  }

  /** Explicit administrator action: link one hosted user to one OBSERVED,
   * active directory user and create their membership from approved group
   * mappings. Directory payload (email, role, raw attributes) never selects
   * the user; an existing membership of any status is refused, so this path
   * cannot elevate or reactivate. */
  async provisionFromDirectory(principal: HostedPrincipal, raw: DirectoryProvisionInput): Promise<DirectoryProvisionResult> {
    const input = validateDirectoryProvision(raw);
    if (principal.userId === input.userId) throw new Error('directory_provision_forbidden');
    return this.run<DirectoryProvisionResult>(async (sql) => {
      const { role: actorRole, externalOrganizationId } =
        await lockDirectoryAdministrator(sql, principal, input.organizationId, 'directory_provision');
      const users = await sql<{ status: string }[]>`SELECT status FROM papercusp_auth.hosted_users
        WHERE id = ${input.userId}::uuid FOR SHARE`;
      if (users[0]?.status !== 'active') throw new Error('directory_provision_user_not_found');
      const memberships = await sql`SELECT 1 FROM papercusp_auth.organization_memberships
        WHERE organization_id = ${input.organizationId}::uuid AND user_id = ${input.userId}::uuid`;
      if (memberships[0]) throw new Error('directory_provision_membership_exists');
      const observations = await sql<{ state: string; groups: string[] }[]>`
        SELECT state, groups FROM papercusp_auth.directory_user_observations
         WHERE external_organization_id = ${externalOrganizationId} AND directory_id = ${input.directoryId}
           AND directory_user_id = ${input.directoryUserId} FOR SHARE`;
      if (observations[0]?.state !== 'active') throw new Error('directory_provision_not_observed');
      const mappings = await sql<{ group_id: string; role: DirectoryMappedRole }[]>`
        SELECT group_id, role FROM papercusp_auth.directory_group_role_mappings
         WHERE organization_id = ${input.organizationId}::uuid AND directory_id = ${input.directoryId}
           AND status = 'active' AND group_id = ANY(${observations[0].groups}::text[])
         ORDER BY group_id FOR SHARE`;
      if (!mappings.length) throw new Error('directory_provision_no_mapped_group');
      const role = resolveDirectoryRole(mappings.map((row) => row.role));
      if (role === 'admin' && actorRole !== 'owner') throw new Error('directory_provision_forbidden_role');
      const mappedGroups = mappings.map((row) => row.group_id);
      const subject = workosDirectoryIdentitySubject(externalOrganizationId, input.directoryId, input.directoryUserId);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`directory-binding:${subject}`}, 0))`;
      const links = await sql<{ id: string; hosted_user_id: string; status: string; profile: Record<string, GovernanceJson> }[]>`
        SELECT id, hosted_user_id, status, profile FROM papercusp_auth.external_identities
         WHERE provider = 'workos-dsync' AND subject = ${subject} FOR UPDATE`;
      const existing = links[0];
      if (existing && existing.hosted_user_id !== input.userId) throw new Error('directory_binding_subject_conflict');
      if (existing && existing.status !== 'active') throw new Error('directory_binding_inactive');
      const created = await sql<{ id: string }[]>`SELECT papercusp_auth.provision_directory_membership(
        ${input.organizationId}::uuid, ${input.userId}::uuid, ${role}, ${principal.userId}::uuid)::text AS id`;
      const membershipId = created[0].id;
      const previous = Array.isArray(existing?.profile.authorized_directory_groups)
        ? existing.profile.authorized_directory_groups.filter((value): value is string => typeof value === 'string') : [];
      const profile = { ...(existing?.profile ?? {}),
        authorized_directory_groups: [...new Set([...previous, ...mappedGroups])].sort(),
        directory_provisioning: { organizationId: input.organizationId, directoryId: input.directoryId, membershipId, mappedGroups } };
      assertGovernancePayloadSafe(profile);
      const rows = existing
        ? await sql<{ id: string }[]>`UPDATE papercusp_auth.external_identities
            SET profile = ${JSON.stringify(profile)}::text::jsonb, updated_at = now() WHERE id = ${existing.id}::uuid RETURNING id`
        : await sql<{ id: string }[]>`INSERT INTO papercusp_auth.external_identities (hosted_user_id, provider, subject, profile)
            VALUES (${input.userId}::uuid, 'workos-dsync', ${subject}, ${JSON.stringify(profile)}::text::jsonb) RETURNING id`;
      const auditId = await appendOrganizationAuditEvent({ organizationId: input.organizationId,
        actorKind: 'customer_user', actorId: principal.userId, action: 'directory_membership.provisioned', purpose: input.purpose,
        targetType: 'organization_membership', targetId: membershipId,
        metadata: { userId: input.userId, subject, role, mappedGroups } }, sql);
      return { membershipId, role, identityId: rows[0].id, mappedGroupIds: mappedGroups, auditId };
    });
  }

  async set(principal: HostedPrincipal, raw: DirectoryBindingInput): Promise<DirectoryBindingResult> {
    return this.change(principal, validateDirectoryBinding(raw), false);
  }

  async remove(principal: HostedPrincipal, raw: Omit<DirectoryBindingInput, 'authorizedGroupIds'>): Promise<DirectoryBindingResult> {
    return this.change(principal, validateDirectoryBinding({ ...raw, authorizedGroupIds: [] }), true);
  }

  private async change(principal: HostedPrincipal, input: DirectoryBindingInput, remove: boolean): Promise<DirectoryBindingResult> {
    if (!isHostedPrincipal(principal) || principal.activeOrganizationId !== input.organizationId || !principal.permissions.has('members:manage')) {
      throw new Error('directory_binding_forbidden');
    }
    const subject = workosDirectoryIdentitySubject(input.externalOrganizationId, input.directoryId, input.directoryUserId);
    return this.run<DirectoryBindingResult>(async (sql) => {
      // Lock current authority in the write transaction; a previously resolved
      // cookie is not durable administrator authority.
      const organizations = await sql<{ id: string }[]>`
        SELECT id FROM papercusp_auth.organizations
         WHERE id = ${input.organizationId}::uuid AND identity_provider = 'workos'
           AND external_organization_id = ${input.externalOrganizationId} AND status = 'active' FOR SHARE`;
      if (!organizations[0]) throw new Error('directory_binding_organization_mismatch');
      const actors = await sql<{ role: string; status: string }[]>`
        SELECT membership.role, membership.status FROM papercusp_auth.organization_memberships AS membership
        JOIN papercusp_auth.hosted_users AS actor ON actor.id = membership.user_id
         WHERE membership.organization_id = ${input.organizationId}::uuid AND membership.user_id = ${principal.userId}::uuid
           AND actor.status = 'active' FOR SHARE OF membership, actor`;
      if (!actors[0] || !hostedPermissionsForMembership(actors[0]).has('members:manage')) throw new Error('directory_binding_forbidden');
      const targets = await sql<{ id: string }[]>`
        SELECT membership.id FROM papercusp_auth.organization_memberships AS membership
        JOIN papercusp_auth.hosted_users AS target ON target.id = membership.user_id
         WHERE membership.organization_id = ${input.organizationId}::uuid AND membership.user_id = ${input.userId}::uuid
           AND target.status <> 'deleted' FOR SHARE OF membership, target`;
      if (!targets[0]) throw new Error('directory_binding_member_not_found');
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`directory-binding:${subject}`}, 0))`;
      const links = await sql<{ id: string; hosted_user_id: string; status: string; profile: Record<string, GovernanceJson> }[]>`
        SELECT id, hosted_user_id, status, profile FROM papercusp_auth.external_identities
         WHERE provider = 'workos-dsync' AND subject = ${subject} FOR UPDATE`;
      const existing = links[0];
      if (existing && existing.hosted_user_id !== input.userId) throw new Error('directory_binding_subject_conflict');
      if (existing && existing.status !== 'active') throw new Error('directory_binding_inactive');
      if (remove && !existing) throw new Error('directory_binding_not_found');
      const profile = { ...(existing?.profile ?? {}), authorized_directory_groups: [...input.authorizedGroupIds] };
      assertGovernancePayloadSafe(profile);
      const rows = existing
        ? await sql<{ id: string }[]>`
            UPDATE papercusp_auth.external_identities SET profile = ${JSON.stringify(profile)}::text::jsonb,
              status = ${remove ? 'deactivated' : 'active'},
              deactivated_at = CASE WHEN ${remove} THEN now() ELSE NULL END, updated_at = now()
             WHERE id = ${existing.id}::uuid RETURNING id`
        : await sql<{ id: string }[]>`
            INSERT INTO papercusp_auth.external_identities (hosted_user_id, provider, subject, profile)
            VALUES (${input.userId}::uuid, 'workos-dsync', ${subject}, ${JSON.stringify(profile)}::text::jsonb) RETURNING id`;
      const identityId = rows[0].id;
      const auditId = await appendOrganizationAuditEvent({
        organizationId: input.organizationId, actorKind: 'customer_user', actorId: principal.userId,
        action: remove ? 'directory_binding.removed' : 'directory_binding.set', purpose: input.purpose,
        targetType: 'external_identity', targetId: identityId,
        metadata: { userId: input.userId, subject, previousGroups: existing?.profile.authorized_directory_groups ?? [],
          authorizedGroups: [...input.authorizedGroupIds] },
      }, sql);
      return { identityId, subject, authorizedGroupIds: [...input.authorizedGroupIds], status: remove ? 'deactivated' : 'active', auditId };
    });
  }
}
