/** Shared cloud policy; deliberately excludes local diagnostic storage. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { isHostedPrincipal, type HostedPrincipal } from './auth/hosted-principal';
import { cloudErrorFingerprintInput, cloudTelemetryConsentSchema, cloudTelemetryConsentUpdateSchema, cloudTelemetryEventSchema, DEFAULT_CLOUD_TELEMETRY_CONSENT, type CloudErrorCode, type CloudTelemetryConsent, type CloudTelemetryEvent } from './telemetry-kinds';
import type { AccountTutorialProgressRecord } from './onboarding/cloud-tutorial-progress';

/** Existing hosted preference storage supplies the consent. Require the
 * verified tenant transaction so no ambient/admin read can choose its scope. */
export async function readCloudTelemetryConsent(tx: Sql, principal: HostedPrincipal): Promise<CloudTelemetryConsent> {
  await assertCloudTelemetryScope(tx, principal);
  const [row] = await tx<{ consent: unknown }[]>`
    SELECT profile->'cloudMonitoring' AS consent FROM papercusp_auth.hosted_user_preferences
     WHERE organization_id = ${principal.activeOrganizationId}::uuid AND user_id = ${principal.userId}::uuid`;
  if (row?.consent == null) return structuredClone(DEFAULT_CLOUD_TELEMETRY_CONSENT);
  return cloudTelemetryConsentSchema.parse(row.consent);
}

async function assertCloudTelemetryScope(tx: Sql, principal: HostedPrincipal): Promise<void> {
  if (!isHostedPrincipal(principal)) throw new Error('cloud_telemetry_principal_required');
  const [scope] = await tx<{ organization: string; user: string }[]>`
    SELECT current_setting('app.organization_id', true) AS organization,
           current_setting('app.user_id', true) AS "user"`;
  if (!scope || scope.organization !== principal.activeOrganizationId || scope.user !== principal.userId) {
    throw new Error('cloud_telemetry_scope_mismatch');
  }
}

/** Same scoped preference row as the reader. Serialize changes so a concurrent
 * category update cannot overwrite revocation, and preserve other preferences. */
export async function writeCloudTelemetryConsent(tx: Sql, principal: HostedPrincipal, input: unknown): Promise<CloudTelemetryConsent> {
  const update = cloudTelemetryConsentUpdateSchema.parse(input);
  await assertCloudTelemetryScope(tx, principal);
  // Existing hosted authority maps members:manage only to owner/admin.
  // Personal analytics and revocation remain available to other members.
  if (update.diagnostics === true && !principal.permissions.has('members:manage')) {
    throw new Error('diagnostic_export_admin_required');
  }
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['cloud-monitoring', principal.activeOrganizationId, principal.userId])}, 0))`;
  const current = await readCloudTelemetryConsent(tx, principal);
  const now = new Date().toISOString();
  const choice = (key: 'analytics' | 'diagnostics') => update[key] === undefined ? current[key] :
    update[key] === false ? { enabled: false, since: null } :
    current[key].enabled && current[key].since ? current[key] : { enabled: true, since: now };
  const consent = cloudTelemetryConsentSchema.parse({ disclosure_version: update.disclosure_version,
    analytics: choice('analytics'), diagnostics: choice('diagnostics') });
  await tx`
    INSERT INTO papercusp_auth.hosted_user_preferences (organization_id, user_id, profile)
    VALUES (${principal.activeOrganizationId}::uuid, ${principal.userId}::uuid, ${JSON.stringify({ cloudMonitoring: consent })}::jsonb)
    ON CONFLICT (organization_id, user_id) DO UPDATE
    SET profile = hosted_user_preferences.profile || EXCLUDED.profile`;
  return consent;
}

export interface CloudTelemetryContext {
  /** Supplied by the authenticated server route, never request JSON. */
  principal: HostedPrincipal;
  environment: 'development' | 'staging' | 'production';
  release: string;
  origin: 'portal' | 'control-plane' | 'customer-runtime';
  hostingMode: 'managed' | 'byoc';
  observedAt?: string;
  /** Only controlled server probes may set this; excluded from business views. */
  synthetic?: boolean;
}
export interface CloudTelemetryEnvelope {
  event: CloudTelemetryEvent['event'];
  distinct_id: string;
  timestamp: string;
  properties: CloudTelemetryEvent['properties'] & {
    organization_id: string; workspace_id?: string; operation_id: string;
    environment: CloudTelemetryContext['environment']; release: string;
    source: CloudTelemetryContext['origin']; synthetic: boolean;
  };
}

/** Called only with tenant-scoped control-plane rows. A running VM alone is
 * not a ready workspace: the persisted bring-up must also be active. No host
 * name, provider id, request, error or log is copied into the event. */
export function cloudProvisioningObservation(input: unknown, workspaceState: string | null):
  { event: CloudTelemetryEvent; observedAt: string } | null {
  if (!input || typeof input !== 'object') return null;
  const row = input as Record<string, unknown>;
  if (row.kind !== 'workspace' || !row.operation || typeof row.operation !== 'object') return null;
  const operation = row.operation as Record<string, unknown>;
  if (operation.action !== 'provision') return null;
  const phase = operation.status === 'succeeded' && row.observedState === 'running' && workspaceState === 'active'
    ? 'ready' : operation.status === 'failed' ? 'failed'
      : ['queued', 'running'].includes(String(operation.status)) ? 'requested' : null;
  if (!phase) return null;
  const observedAt = phase === 'requested' ? operation.startedAt : operation.finishedAt;
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) return null;
  const start = typeof operation.startedAt === 'string' ? Date.parse(operation.startedAt) : NaN;
  const duration = Date.parse(observedAt) - start;
  const properties = { phase, provider: row.target,
    // The existing control projection does not attest the billing owner. Do
    // not infer managed hosting from a provider name or default it to BYOC.
    hosting_mode: 'unknown',
    ...(phase !== 'requested' && Number.isSafeInteger(duration) && duration >= 0 && duration <= 7 * 24 * 60 * 60 * 1000
      ? { duration_ms: duration } : {}),
  };
  const parsed = cloudTelemetryEventSchema.safeParse({ event: 'cloud_workspace_provisioning',
    operation_id: operation.id, properties });
  return parsed.success ? { event: parsed.data, observedAt } : null;
}
export type CloudTelemetryPreparation = { ok: true; envelope: CloudTelemetryEnvelope } |
  { ok: false; code: 'invalid_cloud_event' | 'unverified_principal' | 'invalid_runtime' | 'customer_data_local' | 'unwitnessed_outcome' | 'consent_unavailable' | 'consent_disabled' | 'outside_consent_epoch' };

/** Only a committed account-preference transition witnesses explanation review.
 * Replays and reads do not backfill earlier reviews. Private work receipts and
 * tutorial scope never enter the event; a review is not task success. */
export function cloudProductTutorialReviewEvents(previous: AccountTutorialProgressRecord | null, next: AccountTutorialProgressRecord): CloudTelemetryEvent[] {
  if (!previous || !next.mutationId || next.revision <= previous.revision ||
      next.scope.tenantId !== previous.scope.tenantId || next.scope.userId !== previous.scope.userId) return [];
  const digest = createHash('sha256').update(JSON.stringify(['product-guide-review', next.scope,
    next.version, next.revision, next.mutationId])).digest('hex');
  const operation_id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return next.reviewedLessonIds.filter(lesson => !previous.reviewedLessonIds.includes(lesson)).flatMap(lesson => {
    const parsed = cloudTelemetryEventSchema.safeParse({ event: 'product_tutorial', operation_id,
      properties: { lesson_id: 'product-guide', lesson_version: 3, action: 'explanation_reviewed', lesson } });
    return parsed.success ? [parsed.data] : [];
  });
}

function opaqueCloudIdentity(kind: string, environment: string, organization: string, identifier: string): string {
  return createHash('sha256').update(JSON.stringify(['papercusp-cloud-v1', kind, environment, organization, identifier])).digest('hex');
}

/** Capture and read-side selectors share this derivation. Request JSON must
 * never supply a replacement distinct_id or organization identity. */
export function cloudTelemetryIdentity(context: Pick<CloudTelemetryContext, 'principal' | 'environment'>):
  { distinctId: string; organizationId: string } {
  if (!isHostedPrincipal(context.principal) || !['development', 'staging', 'production'].includes(context.environment)) {
    throw new Error('cloud_telemetry_identity_unavailable');
  }
  const principal = context.principal;
  return {
    distinctId: opaqueCloudIdentity('person', context.environment, principal.activeOrganizationId, principal.userId),
    organizationId: opaqueCloudIdentity('organization', context.environment, principal.activeOrganizationId, principal.activeOrganizationId),
  };
}

/** Revalidate at the FINAL delivery boundary, including batches queued earlier.
 * A missing/changed consent epoch fails closed instead of backfilling history. */
export function prepareCloudTelemetryDelivery(input: unknown, context: CloudTelemetryContext, consent: unknown): CloudTelemetryPreparation {
  const parsed = cloudTelemetryEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid_cloud_event' };
  if (!context.principal || !isHostedPrincipal(context.principal)) return { ok: false, code: 'unverified_principal' };
  const observedAt = context.observedAt ?? new Date().toISOString();
  if (!['development', 'staging', 'production'].includes(context.environment) ||
      !/^[a-f0-9]{7,64}$/.test(context.release) || !Number.isFinite(Date.parse(observedAt)) ||
      !['portal', 'control-plane', 'customer-runtime'].includes(context.origin) ||
      !['managed', 'byoc'].includes(context.hostingMode)) return { ok: false, code: 'invalid_runtime' };
  const event = parsed.data;
  const aggregate = event.event === 'cloud_diagnostic_aggregate';
  if (context.origin === 'customer-runtime' && !aggregate) return { ok: false, code: 'customer_data_local' };
  if (aggregate && (!context.principal.selectedWorkspaceId ||
    !context.principal.permissions.has('members:manage'))) return { ok: false, code: 'unverified_principal' };
  // Browser assertions cannot establish confirmed provisioning or private task outcomes.
  if (event.event === 'cloud_workspace_provisioning' && context.origin !== 'control-plane') return { ok: false, code: 'unwitnessed_outcome' };
  if (event.event === 'product_tutorial' && event.properties.action === 'explanation_reviewed' &&
      context.origin !== 'control-plane') return { ok: false, code: 'unwitnessed_outcome' };
  if (event.event === 'cloud_tutorial' && (event.properties.action === 'complete' ||
      (event.properties.step && ['agent', 'task', 'result', 'revision', 'practice'].includes(event.properties.step)))) {
    if (context.hostingMode === 'byoc' || context.origin !== 'control-plane') return { ok: false, code: 'customer_data_local' };
  }
  const authorization = cloudTelemetryConsentSchema.safeParse(consent);
  if (!authorization.success) return { ok: false, code: 'consent_unavailable' };
  const choice = aggregate ? authorization.data.diagnostics : authorization.data.analytics;
  if (!choice.enabled || !choice.since) return { ok: false, code: 'consent_disabled' };
  if (Date.parse(observedAt) < Date.parse(choice.since) ||
      (aggregate && Date.parse(event.properties.period_start) < Date.parse(choice.since))) return { ok: false, code: 'outside_consent_epoch' };
  const principal = context.principal;
  const identity = cloudTelemetryIdentity(context);
  return { ok: true, envelope: {
    event: event.event,
    distinct_id: identity.distinctId,
    timestamp: new Date(observedAt).toISOString(),
    properties: {
      ...event.properties,
      organization_id: identity.organizationId,
      ...(aggregate ? { workspace_id: opaqueCloudIdentity('workspace', context.environment, principal.activeOrganizationId, principal.selectedWorkspaceId!) } : {}),
      operation_id: opaqueCloudIdentity('operation', context.environment, principal.activeOrganizationId, event.operation_id),
      environment: context.environment, release: context.release,
      source: context.origin, synthetic: context.synthetic === true,
    },
  } };
}

/** Optional analytics never changes the primary product outcome. Consent is
 * read afresh per delivery; this function holds no queue or consent cache. */
export async function deliverCloudTelemetry(input: unknown, context: CloudTelemetryContext, dependencies: {
  readConsent: () => Promise<unknown>; send: (envelope: CloudTelemetryEnvelope) => Promise<void>;
}): Promise<{ delivered: boolean; code?: string }> {
  try {
    const prepared = prepareCloudTelemetryDelivery(input, context, await dependencies.readConsent());
    if (!prepared.ok) return { delivered: false, code: prepared.code };
    await dependencies.send(prepared.envelope);
    return { delivered: true };
  } catch { return { delivered: false, code: 'delivery_unavailable' }; }
}

/** No free-form message, stack, URL, component name or customer value crosses
 * the error boundary. The fingerprint groups only reviewed code/type pairs. */
export function safeCloudError(code: CloudErrorCode, error: unknown) {
  return { code, fingerprint: createHash('sha256').update(cloudErrorFingerprintInput(code, error)).digest('hex') };
}

