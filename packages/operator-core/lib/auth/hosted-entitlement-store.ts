/** Persistence for the existing hosted entitlement schema and signup ledger.
 * Resource admission and authority changes use the same organization lock.
 * Subscription labels alone never grant a resource allowance.
 */
import { withHostedServiceContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import {
  parseHostedEntitlementAssignment, parseHostedEntitlementBundle, parseHostedEntitlementOverride,
  type HostedTrialEntitlementPolicy,
} from './hosted-entitlement-schema';
export type { HostedTrialEntitlementPolicy } from './hosted-entitlement-schema';
import { resolveHostedEntitlements, type HostedEntitlementResolution } from './hosted-entitlements';

export interface HostedEntitlementAuthorityRecords {
  schemaVersion: 1;
  bundles: readonly unknown[];
  assignments: readonly unknown[];
  overrides: readonly unknown[];
}

/** Server configuration, separate from signup input. The bundle supplies every
 * allowance explicitly; neither a free label nor a machine-size guess grants one.
 */
export function parseHostedTrialEntitlementPolicy(value: unknown): HostedTrialEntitlementPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('hosted_trial_policy_invalid');
  // Detach configuration before any asynchronous admission can observe it.
  const row = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const bundle = parseHostedEntitlementBundle(row.bundle);
  if (Object.keys(row).some(key => !['bundle', 'assignmentDurationMs'].includes(key)) || !bundle.ok ||
      !Number.isSafeInteger(row.assignmentDurationMs) || (row.assignmentDurationMs as number) <= 0) {
    throw new Error('hosted_trial_policy_invalid');
  }
  const entitlements = bundle.value.entitlements;
  const quotas = entitlements.quotas;
  if (bundle.value.record.source !== 'trial' || !entitlements.allowedProviders.length ||
      entitlements.limits.workspaces < 1 || entitlements.limits.members < 1 ||
      ['pool.agents', 'pool.hosts', 'pool.cpu-millicores', 'pool.memory-mib', 'pool.db-gib', 'pool.workspace-gib']
        .some(key => !Number.isSafeInteger(quotas[key]) || quotas[key]! < 0) ||
      // D-062: the fresh trial DB allowance is 256 GiB, excluding workspace data.
      quotas['pool.db-gib'] !== 256 || (quotas['pool.reserved-hosts'] ?? 0) !== 0 ||
      !Object.entries(entitlements.budgets).some(([key, amount]) =>
        /^pool\.cost\.[a-z]{3}\.minor$/.test(key) && Number.isSafeInteger(amount) && amount >= 0)) {
    throw new Error('hosted_trial_allowances_invalid');
  }
  return { bundle: bundle.value, assignmentDurationMs: row.assignmentDurationMs as number };
}

/** Called only for a NEW signup, in its existing hosted_service transaction.
 * Replay returns before this producer, so it cannot renew an expired trial.
 * A failure rolls back identity, grant, authority and session together.
 */
export async function initializeHostedTrialEntitlementAuthority(tx: Sql, input: {
  organizationId: string; userId: string; policy: HostedTrialEntitlementPolicy;
}): Promise<void> {
  const organizationId = organization(input.organizationId);
  const userId = organization(input.userId);
  const policy = parseHostedTrialEntitlementPolicy(input.policy);
  await lockHostedEntitlementAuthority(tx, organizationId);
  const now = new Date();
  const record = policy.bundle.record;
  const until = Math.min(now.getTime() + policy.assignmentDurationMs, record.effectiveUntil?.getTime() ?? Infinity);
  if (!Number.isSafeInteger(until) || !Number.isFinite(new Date(until).getTime()) ||
      record.effectiveFrom.getTime() > now.getTime() || until <= now.getTime()) {
    throw new Error('hosted_trial_policy_inactive');
  }
  await writeHostedEntitlementAuthority({ organizationId, userId,
    kind: 'hosted-free', expectedRevision: 0,
    authority: { schemaVersion: 1, bundles: [policy.bundle], overrides: [], assignments: [{
      schemaVersion: 1, assignmentId: `trial:${organizationId}`, organizationId,
      bundleId: policy.bundle.bundleId, bundleVersion: policy.bundle.bundleVersion,
      record: { source: 'trial', actor: record.actor, auditReceiptId: `trial-signup:${organizationId}`,
        effectiveFrom: now, effectiveUntil: new Date(until) },
    }] },
  }, async fn => fn(tx));
}

function organization(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('hosted_entitlement_organization_invalid');
  }
  return value.toLowerCase();
}

/** Lazy rollout for an authenticated organization's pre-policy signup grant.
 * Use its original creation time, never the sign-in time. Any prior authority
 * revision (including revocation), paid grant or ambiguity prevents a backfill.
 * The shared organization lock serializes this with billing and admission.
 */
export async function backfillHostedTrialEntitlementAuthority(tx: Sql, input: {
  organizationId: string; policy: HostedTrialEntitlementPolicy;
}): Promise<'initialized' | 'ineligible'> {
  const organizationId = organization(input.organizationId);
  const policy = parseHostedTrialEntitlementPolicy(input.policy);
  await lockHostedEntitlementAuthority(tx, organizationId);
  return serviceRole(tx, async () => {
    const grants = await tx<Array<{ user_id: string; kind: string; source: string;
      created_at: Date | string; authority: unknown; authority_revision: string | number }>>`
      SELECT user_id::text, kind, source, created_at, authority, authority_revision
        FROM papercusp_auth.hosted_entitlements
       WHERE organization_id = ${organizationId}::uuid
       ORDER BY user_id, kind LIMIT 2 FOR UPDATE`;
    const grant = grants[0];
    if (grants.length !== 1 || !grant || grant.kind !== 'hosted-free' || grant.source !== 'self_signup' ||
        grant.authority !== null || Number(grant.authority_revision) !== 0) return 'ineligible';
    const createdAt = new Date(grant.created_at);
    const record = policy.bundle.record;
    const until = Math.min(createdAt.getTime() + policy.assignmentDurationMs, record.effectiveUntil?.getTime() ?? Infinity);
    // An expired original trial is still recorded with its original interval;
    // later sign-ins or configuration changes can never give it a fresh clock.
    if (!Number.isSafeInteger(until) || !Number.isFinite(new Date(until).getTime()) ||
        !Number.isFinite(createdAt.getTime()) || createdAt.getTime() > Date.now() || until <= createdAt.getTime()) {
      return 'ineligible';
    }
    await writeHostedEntitlementAuthority({ organizationId, userId: grant.user_id,
      kind: grant.kind, expectedRevision: 0,
      authority: { schemaVersion: 1, bundles: [policy.bundle], overrides: [], assignments: [{
        schemaVersion: 1, assignmentId: `trial:${organizationId}`, organizationId,
        bundleId: policy.bundle.bundleId, bundleVersion: policy.bundle.bundleVersion,
        record: { source: 'trial', actor: record.actor, auditReceiptId: `trial-backfill:${organizationId}`,
          effectiveFrom: createdAt, effectiveUntil: new Date(until) },
      }] },
    }, async fn => fn(tx));
    return 'initialized';
  });
}

/** Validate historical rows too: foreign history is not inert authority. */
function records(value: unknown, organizationId: string): HostedEntitlementAuthorityRecords {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('hosted_entitlement_authority_invalid');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || Object.keys(row).some(key => !['schemaVersion', 'bundles', 'assignments', 'overrides'].includes(key)) ||
      !Array.isArray(row.bundles) || !Array.isArray(row.assignments) || !Array.isArray(row.overrides)) {
    throw new Error('hosted_entitlement_authority_invalid');
  }
  for (const bundle of row.bundles) {
    if (!parseHostedEntitlementBundle(bundle).ok) throw new Error('hosted_entitlement_bundle_invalid');
  }
  for (const assignment of row.assignments) {
    const parsed = parseHostedEntitlementAssignment(assignment);
    if (!parsed.ok || parsed.value.organizationId !== organizationId) throw new Error('hosted_entitlement_assignment_invalid');
  }
  for (const override of row.overrides) {
    const parsed = parseHostedEntitlementOverride(override);
    if (!parsed.ok || parsed.value.organizationId !== organizationId) throw new Error('hosted_entitlement_override_invalid');
  }
  return row as unknown as HostedEntitlementAuthorityRecords;
}

export async function lockHostedEntitlementAuthority(tx: Sql, organizationId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-entitlement:organization:${organization(organizationId)}`}, 0))`;
}

/** Reuse hosted_service inside the admission transaction, then restore its role.
 * No second connection/snapshot: the organization lock survives this switch.
 */
async function serviceRole<T>(tx: Sql, run: () => Promise<T>): Promise<T> {
  const [row] = await tx<Array<{ role: string }>>`SELECT current_user AS role`;
  if (!row?.role) throw new Error('hosted_entitlement_role_unknown');
  await tx`SELECT set_config('role', 'hosted_service', true)`;
  try {
    const result = await run();
    await tx`SELECT set_config('role', ${row.role}, true)`;
    return result;
  } catch (error) {
    // SQL failure may have aborted the transaction. Preserve that cause;
    // rollback still restores SET LOCAL ROLE if an explicit restore fails.
    await tx`SELECT set_config('role', ${row.role}, true)`.catch(() => {});
    throw error;
  }
}

export type PersistedHostedEntitlementResolution =
  | { ok: true; resolution: Extract<HostedEntitlementResolution, { ok: true }>['value'];
      authorityRevision: number; grantUserId: string; grantKind: string }
  | { ok: false; reason: string };

/** Pass the canonical directory's organization, never a browser org claim. */
export async function readHostedEntitlementAuthority(
  tx: Sql, rawOrganizationId: string, at?: Date,
): Promise<PersistedHostedEntitlementResolution> {
  const organizationId = organization(rawOrganizationId);
  await lockHostedEntitlementAuthority(tx, organizationId);
  // Default live reads must not retain a pre-lock timestamp while a writer or
  // another admission holds the organization. Explicit historical reads keep at.
  const evaluationAt = at ?? new Date();
  return serviceRole(tx, async () => {
    const rows = await tx<Array<{ user_id: string; kind: string; authority: unknown; authority_revision: string | number }>>`
      SELECT user_id::text, kind, authority, authority_revision
        FROM papercusp_auth.hosted_entitlements
       WHERE organization_id = ${organizationId}::uuid AND authority IS NOT NULL
       ORDER BY user_id, kind LIMIT 2`;
    if (rows.length !== 1) return { ok: false, reason: rows.length ? 'ambiguous_authority' : 'authority_missing' };
    const row = rows[0]!;
    const revision = Number(row.authority_revision);
    if (!Number.isSafeInteger(revision) || revision < 1) return { ok: false, reason: 'invalid_authority_revision' };
    let authority: HostedEntitlementAuthorityRecords;
    try { authority = records(row.authority, organizationId); }
    catch { return { ok: false, reason: 'invalid_authority_records' }; }
    const result = resolveHostedEntitlements({ organizationId, at: evaluationAt, ...authority });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, resolution: result.value, authorityRevision: revision,
      grantUserId: row.user_id, grantKind: row.kind };
  });
}

/** Server-only CAS on an existing grant; creates neither subscription nor grant.
 * Records carry author/audit receipts. Expired records and NULL revoke new spend
 * without deleting retained data. A missing grant or revision mismatch refuses.
 */
export async function writeHostedEntitlementAuthority(input: {
  organizationId: string; userId: string; kind: string; expectedRevision: number;
  authority: HostedEntitlementAuthorityRecords | null;
}, run: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T> = withHostedServiceContext): Promise<number> {
  const organizationId = organization(input.organizationId);
  const userId = organization(input.userId);
  if (!input.kind.trim() || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      !Number.isSafeInteger(input.expectedRevision + 1)) throw new Error('hosted_entitlement_revision_invalid');
  // Detach before awaiting, then validate the exact bytes saved (including Dates).
  const payload = input.authority === null ? null : JSON.stringify(input.authority);
  if (payload !== null) records(JSON.parse(payload), organizationId);
  const expectedRevision = input.expectedRevision;
  const kind = input.kind;
  return run(async tx => {
    await lockHostedEntitlementAuthority(tx, organizationId);
    const rows = await tx<Array<{ authority_revision: string | number }>>`
      UPDATE papercusp_auth.hosted_entitlements
         SET authority = ${payload}::jsonb, authority_revision = authority_revision + 1
       WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid
         AND kind = ${kind} AND authority_revision = ${expectedRevision}
      RETURNING authority_revision`;
    if (rows.length !== 1) throw new Error('hosted_entitlement_revision_conflict');
    return Number(rows[0]!.authority_revision);
  });
}
