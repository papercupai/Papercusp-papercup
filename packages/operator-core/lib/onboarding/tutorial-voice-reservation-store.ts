import { randomUUID } from 'node:crypto';
import { deriveTenantContext, withHostedServiceContext, type VerifiedTenantServerContext } from '@papercusp/db-org';
import type { Sql, TransactionSql } from 'postgres';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import type { TutorialVoiceAdmission, TutorialVoiceTokenProvider } from '../endpoint-route/routes/hosted-tutorial-progress';
import { HostedSessionStore } from '../auth/hosted-session';
import { PostgresHostedIdentityDirectory } from '../auth/hosted-identity-binding';
import { PostgresHostedMembershipAuthority } from '../auth/hosted-membership-authority';
import type { HostedIdentityProvider } from '../auth/hosted/provider';
import { readAccountTutorialProgress, readTutorialProgress } from './cloud-tutorial-progress';
import { authorizeTutorialVoice } from './cloud-tutorial-help';
import type { FlagKey } from '@papercusp/flags';
import { readTutorialVoiceGlobalFlagsForUpdate } from '../flag-override-store';
import { readAdmittedElevenLabsIntegrationCredential } from '../integration-credentials';

/** Read a verified tenant's lesson inside the reservation transaction. Unlike
 * withTenantContext, this must not open a second transaction: successful row
 * locks protect admission until the outer commit. The savepoint restores role
 * and GUCs even when a SQL error aborts the scoped read. */
export async function withTutorialVoiceTenantContext<T>(sql: Sql, context: VerifiedTenantServerContext,
  read: (tx: Sql) => Promise<T>): Promise<T> {
  const tenant = deriveTenantContext(context);
  const transaction = sql as unknown as TransactionSql;
  if (typeof sql.begin === 'function' || typeof transaction.savepoint !== 'function') {
    throw new Error('tutorial_lock_requires_transaction');
  }
  const [before] = await sql<{ role: string; organization: string | null; user: string | null; workspace: string | null }[]>`
    SELECT current_user AS role, current_setting('app.organization_id', true) AS organization,
      current_setting('app.user_id', true) AS "user", current_setting('app.workspace_id', true) AS workspace`;
  if (before?.role !== 'hosted_service') throw new Error('tutorial_service_context_required');
  // The read's result is carried out of the savepoint by closure: savepoint()'s
  // return type is UnwrapPromiseArray<T>, which a generic T cannot resolve to T.
  let result!: T;
  await transaction.savepoint(async scoped => {
    const tx = scoped as unknown as Sql;
    await tx`SELECT set_config('app.organization_id', ${tenant.organizationId}, true),
      set_config('app.user_id', ${tenant.userId}, true), set_config('app.workspace_id', ${tenant.workspaceId ?? ''}, true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_app');
    result = await read(tx);
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    await tx`SELECT set_config('app.organization_id', ${before.organization ?? ''}, true),
      set_config('app.user_id', ${before.user ?? ''}, true), set_config('app.workspace_id', ${before.workspace ?? ''}, true)`;
  });
  return result;
}

/** Server composition supplies the provider, never an identity from a request.
 * Keep local revocation locks until the surrounding reservation commits. This
 * is one part of admission; tutorial, policy and provider limits still apply. */
export async function validateTutorialVoiceIdentityForUpdate(sql: Sql, admission: TutorialVoiceAdmission,
  provider: Pick<HostedIdentityProvider, 'providerId' | 'validateSession'>): Promise<boolean> {
  const session = await new HostedSessionStore(sql).resolveForUpdate(admission.sessionId,
    { expectedPermissionVersion: admission.sessionVersion });
  if (!session || session.userId !== admission.userId || session.organizationId !== admission.organizationId
    || session.upstreamProvider !== provider.providerId
    || (admission.customerWorkspaceId !== null && session.workspaceId !== admission.customerWorkspaceId)) return false;
  const upstream = await provider.validateSession({ externalSessionId: session.upstreamSessionId });
  if (!upstream.ok || upstream.value.externalSessionId !== session.upstreamSessionId
    || upstream.value.identity.emailVerified !== true || !upstream.value.identity.externalUserId
    || !Number.isFinite(upstream.value.expiresAtMs) || upstream.value.expiresAtMs <= Date.now()) return false;
  const linked = await new PostgresHostedIdentityDirectory(sql).resolveLinkedUserForUpdate({
    providerId: provider.providerId, subject: upstream.value.identity.externalUserId });
  if (linked?.userId !== admission.userId) return false;
  const membership = new PostgresHostedMembershipAuthority(sql);
  const active = await membership.resolveActiveForUpdate({ userId: admission.userId, organizationId: admission.organizationId });
  if (!active || active.permissionVersion !== admission.sessionVersion) return false;
  if (admission.customerWorkspaceId !== null) {
    if (!active.permissions.has('workspace:view')) return false;
    const workspaceId = admission.customerWorkspaceId;
    // The service role owns identity checks, but workspace directory authority
    // belongs to the verified tenant role. Preserve its lock in this transaction.
    const owned = await withTutorialVoiceTenantContext(sql, { principal: {
      kind: 'user', profile: 'hosted', authMethod: 'cookie-session', trust: 'verified', slug: admission.userId,
      workspaceId: admission.controlWorkspaceId, userId: admission.userId,
      activeOrganizationId: admission.organizationId, selectedWorkspaceId: workspaceId,
      sessionId: admission.sessionId, sessionVersion: admission.sessionVersion,
    }, selectedWorkspace: { id: workspaceId, organizationId: admission.organizationId } },
    tx => new PostgresHostedMembershipAuthority(tx).workspaceBelongsToOrganizationForUpdate({
      userId: admission.userId, sessionId: admission.sessionId, sessionVersion: admission.sessionVersion,
      organizationId: admission.organizationId, customerWorkspaceId: workspaceId,
      controlPlaneWorkspaceId: admission.controlWorkspaceId }));
    if (!owned) return false;
  }
  // Upstream verification can take time; expiry must still hold after all reads.
  return session.expiresAt.getTime() > Date.now() && upstream.value.expiresAtMs > Date.now();
}

/** Identity must be revalidated before constructing tenant authority. Both
 * identity and persisted lesson locks remain in the reservation transaction;
 * policy and provider duration evidence are still separate required checks. */
export async function validateTutorialVoiceLessonForUpdate(sql: Sql, admission: TutorialVoiceAdmission,
  provider: Pick<HostedIdentityProvider, 'providerId' | 'validateSession'>): Promise<boolean> {
  if (!await validateTutorialVoiceIdentityForUpdate(sql, admission, provider)) return false;
  const account = admission.lesson.version === 3;
  if (!account && admission.customerWorkspaceId === null) return false;
  const workspaceId = account ? undefined : admission.customerWorkspaceId!;
  const context: VerifiedTenantServerContext = { principal: {
    kind: 'user', profile: 'hosted', authMethod: 'cookie-session', trust: 'verified', slug: admission.userId,
    workspaceId: admission.controlWorkspaceId, userId: admission.userId,
    activeOrganizationId: admission.organizationId, sessionId: admission.sessionId,
    sessionVersion: admission.sessionVersion, ...(workspaceId ? { selectedWorkspaceId: workspaceId } : {}),
  }, ...(workspaceId ? { selectedWorkspace: { id: workspaceId, organizationId: admission.organizationId } } : {}) };
  const lessonValid = await withTutorialVoiceTenantContext(sql, context, async tx => {
    const scope = { tenantId: admission.organizationId, userId: admission.userId,
      ...(workspaceId ? { workspaceId } : {}) };
    const record = account ? await readAccountTutorialProgress(tx, scope, { lock: true })
      : await readTutorialProgress(tx, { ...scope, workspaceId: workspaceId! },
        admission.lesson.version === 2 ? 2 : 1, { lock: true, requirePersisted: true });
    try {
      authorizeTutorialVoice(scope, { expectedScope: scope, context: admission.lesson }, record);
      return true;
    } catch { return false; }
  });
  // Waiting on a lesson writer can cross local/upstream expiry. Revalidate
  // after that wait rather than authorizing from the earlier time snapshot.
  return lessonValid && await validateTutorialVoiceIdentityForUpdate(sql, admission, provider);
}

export interface TutorialVoiceQuotaAuthority {
  maximumSeconds: number;
  dailySeconds: { global: number; user: number; organization: number; workspace: number };
  /** Verified restricted credential/provider duration evidence, never a key. */
  providerLimitRef: string;
}
/** Server-only. Lock and revalidate persisted active lesson, identity, policy
 * and kill switch in this SAME transaction. Missing evidence refuses. Provider
 * issuance follows commit. No browser authority is accepted. */
export type TutorialVoiceAuthorityReader = (sql: Sql, admission: TutorialVoiceAdmission) =>
  Promise<TutorialVoiceQuotaAuthority | null>;
/** Host-owned provider verification for the existing reservation authority.
 * The encrypted secret is consumed only by fresh admission and never returned
 * as quota evidence. This does not mint a token or enable the policy flag. */
export function createElevenLabsTutorialVoiceLimitVerifier(options: {
  credential: Parameters<typeof readAdmittedElevenLabsIntegrationCredential>[0];
  dailySeconds: TutorialVoiceQuotaAuthority['dailySeconds'];
}): TutorialVoiceAuthorityReader {
  const credential = { ...options.credential,
    allowedPermissions: [...options.credential.allowedPermissions],
    definition: structuredClone(options.credential.definition), toolIds: [...options.credential.toolIds] };
  const dailySeconds = { ...options.dailySeconds };
  return async () => {
    if (credential.signal.aborted || !(['global', 'user', 'organization', 'workspace'] as const)
      .every(key => positive(dailySeconds[key]))) return null;
    const admitted = await readAdmittedElevenLabsIntegrationCredential(credential);
    if (!admitted || credential.signal.aborted || !positive(admitted.maximumSeconds)
      || admitted.maximumSeconds > 7200) return null;
    const providerLimitRef = `elevenlabs:${admitted.keyId}:${admitted.agentId}`;
    if (!identifier(providerLimitRef)) return null;
    return { maximumSeconds: admitted.maximumSeconds, providerLimitRef, dailySeconds: { ...dailySeconds } };
  };
}
/** Compose admission from server-owned dependencies. A cached/default flag
 * cannot authorize spending: the registered policy needs explicit persisted
 * approval. Provider verification must attest restricted credential and agent
 * limits; returning configuration alone does not satisfy that contract. */
export function createTutorialVoiceAuthorityReader(options: {
  identityProvider: Pick<HostedIdentityProvider, 'providerId' | 'validateSession'>;
  policyFlag: FlagKey;
  verifyProviderLimits: TutorialVoiceAuthorityReader;
}): TutorialVoiceAuthorityReader {
  return async (sql, admission) => {
    if (!await validateTutorialVoiceLessonForUpdate(sql, admission, options.identityProvider)) return null;
    const flags = await readTutorialVoiceGlobalFlagsForUpdate(sql);
    if (flags?.[options.policyFlag] !== true) return null;
    const limits = await options.verifyProviderLimits(sql, admission);
    // Both the policy lock and provider verification can wait. Do not mint
    // from identity authority that expired during either operation.
    if (!limits || !await validateTutorialVoiceIdentityForUpdate(sql, admission, options.identityProvider)) return null;
    return limits;
  };
}
export type TutorialVoiceReservationResult =
  | { ok: true; reservationId: string; maximumSeconds: number; providerLimitRef: string }
  | { ok: false; reason: 'quota_exhausted' | 'session_active' | 'unavailable' };
/** Re-admit after reservation commit, immediately before remote issuance.
 * Rotation or duration growth must not spend against the old reservation.
 * Server-only result; never serialize this credential to a browser or ledger.
 * A refusal retains the reservation until verified provider finality. */
export async function readReservedElevenLabsTutorialCredential(
  reservation: Extract<TutorialVoiceReservationResult, { ok: true }>,
  credential: Parameters<typeof readAdmittedElevenLabsIntegrationCredential>[0],
): ReturnType<typeof readAdmittedElevenLabsIntegrationCredential> {
  const reserved = { ...reservation };
  if (credential.signal.aborted || !/^[0-9a-f-]{36}$/i.test(reserved.reservationId)
    || !positive(reserved.maximumSeconds) || reserved.maximumSeconds > 7200
    || !identifier(reserved.providerLimitRef)) return null;
  const admitted = await readAdmittedElevenLabsIntegrationCredential(credential);
  if (!admitted || credential.signal.aborted || !positive(admitted.maximumSeconds)
    || admitted.maximumSeconds > reserved.maximumSeconds
    || `elevenlabs:${admitted.keyId}:${admitted.agentId}` !== reserved.providerLimitRef) return null;
  return admitted;
}
const identifier = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256;
/** Server-only issuer composition. No retry after remote I/O: ambiguous outcomes
 * retain their reservation for reconciliation. This factory does not install or
 * enable issuance. Live acceptance must verify the provider identity contract. */
export function createElevenLabsTutorialVoiceTokenProvider(options: {
  disabled: TutorialVoiceTokenProvider['disabled'];
  store: Pick<PostgresTutorialVoiceReservationStore, 'reserve' | 'beginIssuance' | 'recordProviderConversation'>;
  credential: Parameters<typeof readAdmittedElevenLabsIntegrationCredential>[0];
}): TutorialVoiceTokenProvider {
  const credential = { ...options.credential,
    allowedPermissions: [...options.credential.allowedPermissions],
    definition: structuredClone(options.credential.definition), toolIds: [...options.credential.toolIds] };
  const unavailable = { ok: false as const, reason: 'unavailable' as const };
  return { disabled: options.disabled, async issue(admission, signal) {
    try {
      const combined = AbortSignal.any([signal, credential.signal]);
      if (combined.aborted) return unavailable;
      if (await options.disabled(combined)) return { ok: false, reason: 'disabled' };
      const reservation = await options.store.reserve(admission);
      if (!reservation.ok) return reservation;
      const admitted = await readReservedElevenLabsTutorialCredential(reservation, { ...credential, signal: combined });
      if (!admitted || combined.aborted) return unavailable;
      if (await options.disabled(combined)) return { ok: false, reason: 'disabled' };
      const attempt = await options.store.beginIssuance(reservation.reservationId);
      if (!attempt || combined.aborted) return unavailable;
      // The documented 15-minute initiation window is conservatively measured
      // from BEFORE the request, never from a delayed response or delivery.
      const expiresAt = Date.now() + 15 * 60 * 1000;
      const endpoint = new URL('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url');
      endpoint.searchParams.set('agent_id', admitted.agentId);
      endpoint.searchParams.set('include_conversation_id', 'true');
      const response = await credential.fetch(endpoint, { headers: { 'xi-api-key': admitted.apiKey },
        signal: combined, redirect: 'error' });
      if (!response.ok) return unavailable;
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('signed_url' in body) || typeof body.signed_url !== 'string') return unavailable;
      const url = new URL(body.signed_url);
      const ids = url.searchParams.getAll('conversation_id');
      const signatures = url.searchParams.getAll('conversation_signature');
      if (url.protocol !== 'wss:' || url.host !== 'api.elevenlabs.io'
        || url.pathname !== '/v1/convai/conversation' || url.username || url.password || url.hash
        || ids.length !== 1 || !identifier(ids[0]) || signatures.length !== 1 || !signatures[0]
        || url.searchParams.getAll('agent_id').length !== 1 || url.searchParams.get('agent_id') !== admitted.agentId) return unavailable;
      // Persist a valid trusted receipt even if the browser disconnected while
      // the response was arriving. Cancellation cannot erase provider exposure.
      if (!await options.store.recordProviderConversation(reservation.reservationId, attempt, ids[0])) return unavailable;
      if (combined.aborted || Date.now() >= expiresAt) return unavailable;
      if (await options.disabled(combined) || combined.aborted) return { ok: false, reason: 'disabled' };
      if (Date.now() >= expiresAt) return unavailable;
      return { ok: true, connectionType: 'websocket', signedUrl: body.signed_url,
        sessionId: reservation.reservationId, expiresAt, maximumSeconds: admitted.maximumSeconds };
    } catch { return unavailable; }
  } };
}
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
async function fence(sql: Sql) {
  const [row] = await sql<{ transaction_isolation: string }[]>`SHOW transaction_isolation`;
  if (row?.transaction_isolation !== 'read committed') throw new Error('tutorial voice requires read committed');
  // Global cap needs one population across replicas and organizations.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('tutorial-voice-global-admission', 0))`;
}

/** Uses hosted service transactions. Money reservations cannot meter free
 * tutorial seconds. No key, token or question is persisted here. */
export class PostgresTutorialVoiceReservationStore {
  constructor(private readonly options: { readAuthority: TutorialVoiceAuthorityReader; run?: HostedServiceContextRunner }) {}

  async reserve(admission: TutorialVoiceAdmission): Promise<TutorialVoiceReservationResult> {
    if (![admission.controlWorkspaceId, admission.organizationId, admission.userId, admission.sessionId].every(identifier)
      || !Number.isSafeInteger(admission.sessionVersion) || admission.sessionVersion < 0
      || (admission.customerWorkspaceId !== null && !identifier(admission.customerWorkspaceId))) {
      throw new Error('invalid tutorial voice identity');
    }
    return (this.options.run ?? withHostedServiceContext)(async sql => {
      await fence(sql);
      const authority = await this.options.readAuthority(sql, admission);
      if (!authority || !positive(authority.maximumSeconds) || authority.maximumSeconds > 7200
        || !identifier(authority.providerLimitRef)
        || !['global', 'user', 'organization', 'workspace'].every(k =>
          positive(authority.dailySeconds?.[k as keyof TutorialVoiceQuotaAuthority['dailySeconds']]))) {
        return { ok: false, reason: 'unavailable' };
      }
      const [active] = await sql`SELECT id FROM papercusp_auth.tutorial_voice_reservations
        WHERE user_id = ${admission.userId} AND provider_final_ref IS NULL LIMIT 1`;
      if (active) return { ok: false, reason: 'session_active' };
      // Read database time once AFTER the lock: a waiter crossing midnight
      // charges its admission day, with one stable value throughout the query.
      const [clock] = await sql<{ day: string }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day`;
      const [totals] = await sql<{ global: string; user: string; organization: string; workspace: string }[]>`
        SELECT COALESCE(sum(maximum_seconds), 0)::text AS global,
          COALESCE(sum(maximum_seconds) FILTER (WHERE user_id = ${admission.userId}), 0)::text AS user,
          COALESCE(sum(maximum_seconds) FILTER (WHERE organization_id = ${admission.organizationId}), 0)::text AS organization,
          COALESCE(sum(maximum_seconds) FILTER (WHERE organization_id = ${admission.organizationId}
            AND control_workspace_id = ${admission.controlWorkspaceId}
            AND customer_workspace_id = ${admission.customerWorkspaceId}), 0)::text AS workspace
        FROM papercusp_auth.tutorial_voice_reservations WHERE day = ${clock.day}::date`;
      const buckets: (keyof TutorialVoiceQuotaAuthority['dailySeconds'])[] = ['global', 'user', 'organization'];
      if (admission.customerWorkspaceId !== null) buckets.push('workspace');
      for (const key of buckets) {
        if (BigInt(totals[key]) + BigInt(authority.maximumSeconds) > BigInt(authority.dailySeconds[key])) {
          return { ok: false, reason: 'quota_exhausted' };
        }
      }
      const reservationId = randomUUID();
      await sql`INSERT INTO papercusp_auth.tutorial_voice_reservations
        (id, control_workspace_id, organization_id, user_id, customer_workspace_id, day, maximum_seconds, provider_limit_ref)
        VALUES (${reservationId}::uuid, ${admission.controlWorkspaceId}, ${admission.organizationId},
          ${admission.userId}, ${admission.customerWorkspaceId}, ${clock.day}::date,
          ${authority.maximumSeconds}, ${authority.providerLimitRef})`;
      return { ok: true, reservationId, maximumSeconds: authority.maximumSeconds, providerLimitRef: authority.providerLimitRef };
    });
  }

  /** Commit before mint I/O. A lost response retains exposure and forbids a
   * second attempt; reconciliation must establish provider finality first. */
  async beginIssuance(reservationId: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/i.test(reservationId)) throw new Error('invalid issuance reservation');
    return (this.options.run ?? withHostedServiceContext)(async sql => {
      await fence(sql);
      const attemptId = randomUUID();
      const rows = await sql`UPDATE papercusp_auth.tutorial_voice_reservations
        SET issuance_attempt_id = ${attemptId}::uuid
        WHERE id = ${reservationId}::uuid AND issuance_attempt_id IS NULL
          AND provider_final_ref IS NULL RETURNING id`;
      return rows.length === 1 ? attemptId : null;
    });
  }

  /** Bind a trusted provider receipt to its attempt. No URL/token is stored.
   * Identical receipt retries are safe; conflicting identities cannot replace it. */
  async recordProviderConversation(reservationId: string, attemptId: string, conversationId: string): Promise<boolean> {
    if (![reservationId, attemptId].every(id => /^[0-9a-f-]{36}$/i.test(id))
      || !identifier(conversationId)) throw new Error('invalid provider conversation');
    return (this.options.run ?? withHostedServiceContext)(async sql => {
      await fence(sql);
      const rows = await sql`UPDATE papercusp_auth.tutorial_voice_reservations
        SET provider_conversation_id = ${conversationId}
        WHERE id = ${reservationId}::uuid AND issuance_attempt_id = ${attemptId}::uuid
          AND provider_final_ref IS NULL
          AND (provider_conversation_id IS NULL OR provider_conversation_id = ${conversationId}) RETURNING id`;
      return rows.length === 1;
    });
  }

  /** Only a server verifier may establish finality, including token expiry/replay
   * liability. Browser cancellation cannot release this. No seconds are refunded. */
  async recordProviderFinal(reservationId: string, evidenceRef: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(reservationId) || !identifier(evidenceRef)) throw new Error('invalid provider finality');
    return (this.options.run ?? withHostedServiceContext)(async sql => {
      await fence(sql);
      const rows = await sql`UPDATE papercusp_auth.tutorial_voice_reservations
        SET provider_final_ref = ${evidenceRef}
        WHERE id = ${reservationId}::uuid AND provider_final_ref IS NULL RETURNING id`;
      return rows.length === 1;
    });
  }
}
